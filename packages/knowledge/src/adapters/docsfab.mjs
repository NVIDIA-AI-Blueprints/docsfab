// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { spawn } from "node:child_process";
import { resolve } from "node:path";

import {
  RUNTIME_ADAPTER_VERSION,
  renderWorkPacketPrompt,
} from "../runtime-adapter.mjs";
export {
  adjudicateReconciliationDecision,
  registerReconciliationDecisionSource,
} from "../reconciliation-adjudication.mjs";

const TERMINAL_STATUSES = new Set(["completed", "failed", "stopped"]);
const SUPPORTED_PLATFORMS = new Set(["darwin", "linux"]);
const DEFAULT_ENVIRONMENT_ALLOWLIST = Object.freeze([
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "PATH",
  "TEMP",
  "TMP",
  "TMPDIR",
]);
const CREDENTIAL_PATTERN =
  /(?:\bBearer\s+[A-Za-z0-9._~+/=-]{16,}|\bglpat-[A-Za-z0-9_-]{16,}|\bnvapi-[A-Za-z0-9_-]{16,}|\bsk-[A-Za-z0-9_-]{20,})/iu;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function requirePositiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function snapshot(record) {
  const result = {
    run_id: record.id,
    status: record.status,
  };
  if (record.exitCode !== undefined) result.exit_code = record.exitCode;
  if (record.signal !== undefined) result.signal = record.signal;
  if (record.output !== undefined) result.output = structuredClone(record.output);
  if (record.error !== undefined) result.error = record.error;
  return result;
}

function parseRunResult(stdout) {
  const text = stdout.trim();
  if (text === "") throw new Error("DocsFab CLI returned an empty JSON result");
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error("DocsFab CLI returned malformed JSON", { cause: error });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("DocsFab CLI run result must be a JSON object");
  }
  if (value.kind !== "docsfab-run-result" || value.schemaVersion !== 1) {
    throw new Error("DocsFab CLI run result has an unsupported kind or schema version");
  }
  if (
    !value.execution ||
    typeof value.execution !== "object" ||
    Array.isArray(value.execution) ||
    typeof value.execution.runId !== "string" ||
    value.execution.runId.trim() === "" ||
    typeof value.execution.status !== "string" ||
    !SHA256_PATTERN.test(value.resultSha256)
  ) {
    throw new Error("DocsFab CLI run result is missing required execution fields");
  }
  return value;
}

function parseWorkflowCatalog(stdout) {
  const workflows = [];
  for (const line of stdout.split(/\r?\n/u)) {
    if (line.trim() === "") continue;
    const match = /^([a-z][a-z0-9-]*)\s+(\S.*)$/u.exec(line);
    if (!match) {
      throw new Error("DocsFab CLI workflow catalog does not match grammar version 1");
    }
    workflows.push(match[1]);
  }
  if (workflows.length === 0) {
    throw new Error("DocsFab CLI workflow catalog is empty");
  }
  return workflows;
}

function boundedEnvironment(environment, allowlist) {
  if (!Array.isArray(allowlist) || allowlist.length === 0) {
    throw new Error("DocsFab adapter environment allowlist is required");
  }
  const result = {};
  for (const rawName of allowlist) {
    const name = requireNonEmptyString(rawName, "DocsFab environment variable name");
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
      throw new Error(`DocsFab environment variable name is invalid: ${name}`);
    }
    const value = environment[name];
    if (typeof value === "string") result[name] = value;
  }
  return result;
}

function requireInstructionDisclosure(canonicalContext, instruction) {
  const disclosure = canonicalContext.runtimeDisclosure;
  if (
    !disclosure ||
    typeof disclosure !== "object" ||
    Array.isArray(disclosure) ||
    !new Set(["public", "nvidia-internal"]).has(disclosure.classification) ||
    disclosure.processArgvApproved !== true
  ) {
    throw new Error(
      "DocsFab process-visible instruction requires public or NVIDIA-internal classification and explicit approval",
    );
  }
  if (CREDENTIAL_PATTERN.test(instruction)) {
    throw new Error("DocsFab process-visible instruction contains credential-like material");
  }
}

function waitForEvent(child, eventName, { timeoutMs, timeoutLabel, onTimeout }) {
  return new Promise((resolveEvent, rejectEvent) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off(eventName, onEvent);
      child.off("error", onError);
      callback(value);
    };
    const onEvent = (...values) => finish(resolveEvent, values);
    const onError = (error) => finish(rejectEvent, error);
    const timer = setTimeout(() => {
      if (settled) return;
      onTimeout?.();
      finish(rejectEvent, new Error(timeoutLabel));
    }, timeoutMs);
    child.once(eventName, onEvent);
    child.once("error", onError);
  });
}

export class DocsFabRuntimeAdapter {
  #capabilities = null;
  #executable;
  #environment;
  #initialized = false;
  #kill;
  #maxOutputBytes;
  #nextRun = 1;
  #platform;
  #repositoryPath;
  #revision;
  #runs = new Map();
  #spawn;
  #workflow;

  constructor({
    executable = "docsfab",
    repositoryPath,
    revision = "HEAD",
    workflow = "audit",
    environment = process.env,
    environmentAllowlist = DEFAULT_ENVIRONMENT_ALLOWLIST,
    killImplementation = process.kill,
    maxOutputBytes = 1024 * 1024,
    platform = process.platform,
    spawnImplementation = spawn,
  }) {
    if (typeof spawnImplementation !== "function") {
      throw new Error("DocsFab adapter requires a spawn implementation");
    }
    if (!environment || typeof environment !== "object" || Array.isArray(environment)) {
      throw new Error("DocsFab adapter environment must be an object");
    }
    if (typeof killImplementation !== "function") {
      throw new Error("DocsFab adapter requires a process-group signal implementation");
    }
    if (!SUPPORTED_PLATFORMS.has(platform)) {
      throw new Error(`DocsFab adapter does not support process groups on ${String(platform)}`);
    }
    this.#executable = requireNonEmptyString(executable, "DocsFab executable");
    this.#repositoryPath = resolve(
      requireNonEmptyString(repositoryPath, "DocsFab repository path"),
    );
    this.#revision = requireNonEmptyString(revision, "DocsFab repository revision");
    this.#workflow = requireNonEmptyString(workflow, "DocsFab workflow");
    Object.defineProperties(this, {
      contractVersion: { value: RUNTIME_ADAPTER_VERSION, enumerable: true },
      name: { value: "docsfab", enumerable: true },
    });
    this.#environment = boundedEnvironment(environment, environmentAllowlist);
    this.#kill = killImplementation;
    this.#maxOutputBytes = requirePositiveInteger(
      maxOutputBytes,
      "DocsFab maximum output bytes",
    );
    this.#platform = platform;
    this.#spawn = spawnImplementation;
    Object.preventExtensions(this);
  }

  async initialize({ timeoutMs = 5000 } = {}) {
    requirePositiveInteger(timeoutMs, "DocsFab initialization timeout");
    const result = await this.#executeProbe(["list"], timeoutMs);
    const workflows = parseWorkflowCatalog(result.stdout);
    if (!workflows.includes(this.#workflow)) {
      throw new Error(`DocsFab CLI does not list the configured workflow: ${this.#workflow}`);
    }
    this.#capabilities = {
      platform: "docsfab-cli",
      executable: this.#executable,
      repositoryPath: this.#repositoryPath,
      revision: this.#revision,
      workflow: this.#workflow,
      catalogGrammarVersion: 1,
      features: {
        run_submission: true,
        run_status: true,
        run_stop: true,
      },
      statusAuthority: "adapter-process-group",
      processGroupPlatform: this.#platform,
      environmentKeys: Object.keys(this.#environment).sort(),
    };
    this.#initialized = true;
    return { capabilities: structuredClone(this.#capabilities) };
  }

  async startRun({ task, canonicalContext, instructions, timeoutMs = 10000 }) {
    this.#assertInitialized();
    requirePositiveInteger(timeoutMs, "DocsFab startup timeout");
    const input = renderWorkPacketPrompt(task, canonicalContext);
    const instruction = `${
      instructions ??
      "Execute only the bounded DocsFab knowledge-gathering work packet. Preserve provenance and surface uncertainty."
    }\n\n${input}`;
    requireInstructionDisclosure(canonicalContext, instruction);
    const runId = `docsfab-knowledge-${task.id}-${this.#nextRun}`;
    this.#nextRun += 1;
    const child = this.#spawn(
      this.#executable,
      [
        "run",
        this.#workflow,
        "--repo",
        this.#repositoryPath,
        "--revision",
        this.#revision,
        "--instruction",
        instruction,
        "--json",
      ],
      {
        cwd: this.#repositoryPath,
        detached: true,
        env: this.#environment,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const record = {
      id: runId,
      child,
      status: "starting",
      stdoutChunks: [],
      stderrChunks: [],
      outputBytes: 0,
      stopRequested: false,
    };
    this.#runs.set(runId, record);
    this.#bindOutput(record);
    try {
      await waitForEvent(child, "spawn", {
        timeoutMs,
        timeoutLabel: "DocsFab CLI did not start before the startup timeout",
        onTimeout: () => this.#signal(record, "SIGKILL"),
      });
      if (!Number.isInteger(child.pid) || child.pid <= 0) {
        throw new Error("DocsFab CLI did not expose a process-group id");
      }
    } catch (error) {
      this.#runs.delete(runId);
      throw new Error("DocsFab CLI run could not be started", { cause: error });
    }
    if (record.status === "starting") record.status = "running";
    return TERMINAL_STATUSES.has(record.status)
      ? snapshot(record)
      : { run_id: runId, status: "started" };
  }

  async getRun(runId) {
    this.#assertInitialized();
    return snapshot(this.#requireRun(runId));
  }

  async stopRun(runId, { timeoutMs = 5000 } = {}) {
    this.#assertInitialized();
    requirePositiveInteger(timeoutMs, "DocsFab stop timeout");
    const record = this.#requireRun(runId);
    if (TERMINAL_STATUSES.has(record.status)) return snapshot(record);
    if (record.stopPromise) return record.stopPromise;
    record.stopPromise = this.#stopRecord(record, timeoutMs);
    return record.stopPromise;
  }

  async #stopRecord(record, timeoutMs) {
    record.stopRequested = true;
    record.status = "stopping";
    this.#signal(record, "SIGTERM");
    await this.#waitForClose(record, timeoutMs);
    if (!(await this.#waitForGroupExit(record, timeoutMs))) {
      this.#signal(record, "SIGKILL");
      if (!(await this.#waitForGroupExit(record, timeoutMs))) {
        record.status = "failed";
        record.error = "DocsFab executor process-group termination is unconfirmed";
        return snapshot(record);
      }
    }
    record.status = "stopped";
    return snapshot(record);
  }

  capabilities() {
    this.#assertInitialized();
    return structuredClone(this.#capabilities);
  }

  #assertInitialized() {
    if (!this.#initialized) {
      throw new Error("DocsFab adapter is not initialized");
    }
  }

  #requireRun(runId) {
    const id = requireNonEmptyString(runId, "DocsFab run id");
    const record = this.#runs.get(id);
    if (!record) throw new Error(`Unknown DocsFab run: ${id}`);
    return record;
  }

  #bindOutput(record) {
    const append = (field, chunk) => {
      const bytes = Buffer.from(chunk);
      if (record.outputBytes + bytes.length > this.#maxOutputBytes) {
        if (record.error) return;
        record.status = "failed";
        record.error = "DocsFab CLI output exceeded the configured byte limit";
        this.#signal(record, "SIGKILL");
        return;
      }
      record.outputBytes += bytes.length;
      record[field].push(bytes);
    };
    record.child.stdout?.on("data", (chunk) => append("stdoutChunks", chunk));
    record.child.stderr?.on("data", (chunk) => append("stderrChunks", chunk));
    record.child.once("error", (error) => {
      if (TERMINAL_STATUSES.has(record.status)) return;
      record.status = "failed";
      record.error = error instanceof Error ? error.message : "DocsFab CLI process failed";
    });
    record.child.once("close", (code, signal) => {
      const stdout = Buffer.concat(record.stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(record.stderrChunks).toString("utf8");
      record.exitCode = code;
      record.signal = signal;
      if (record.stopRequested) {
        if (!TERMINAL_STATUSES.has(record.status)) record.status = "stopping";
        return;
      }
      if (record.error) {
        record.status = "failed";
        return;
      }
      if (code === 0) {
        try {
          record.output = parseRunResult(stdout);
          record.status = "completed";
        } catch (error) {
          record.status = "failed";
          record.error =
            error instanceof Error ? error.message : "DocsFab CLI run result is invalid";
        }
        return;
      }
      record.status = "failed";
      record.error = stderr.trim() || `DocsFab CLI exited with status ${String(code)}`;
    });
  }

  async #executeProbe(args, timeoutMs) {
    const child = this.#spawn(this.#executable, args, {
      cwd: this.#repositoryPath,
      detached: true,
      env: this.#environment,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    let outputBytes = 0;
    let outputExceeded = false;
    const append = (chunks, chunk) => {
      const bytes = Buffer.from(chunk);
      if (outputBytes + bytes.length > this.#maxOutputBytes) {
        outputExceeded = true;
        if (Number.isInteger(child.pid) && child.pid > 0) {
          this.#kill(-child.pid, "SIGKILL");
        } else {
          child.kill("SIGKILL");
        }
        return;
      }
      outputBytes += bytes.length;
      chunks.push(bytes);
    };
    child.stdout?.on("data", (chunk) => {
      append(stdoutChunks, chunk);
    });
    child.stderr?.on("data", (chunk) => {
      append(stderrChunks, chunk);
    });
    const [code] = await waitForEvent(child, "close", {
      timeoutMs,
      timeoutLabel: "DocsFab CLI capability probe timed out",
      onTimeout: () => {
        if (Number.isInteger(child.pid) && child.pid > 0) {
          this.#kill(-child.pid, "SIGKILL");
        } else {
          child.kill("SIGKILL");
        }
      },
    });
    if (outputExceeded) {
      throw new Error("DocsFab CLI capability output exceeded the configured byte limit");
    }
    const stdout = Buffer.concat(stdoutChunks).toString("utf8");
    const stderr = Buffer.concat(stderrChunks).toString("utf8");
    if (code !== 0) {
      throw new Error(
        `DocsFab CLI capability probe failed: ${stderr.trim() || `exit ${String(code)}`}`,
      );
    }
    return { stdout, stderr };
  }

  #signal(record, signal) {
    if (record.lastSignal === signal) return;
    record.lastSignal = signal;
    if (Number.isInteger(record.child.pid) && record.child.pid > 0) {
      try {
        this.#kill(-record.child.pid, signal);
        return;
      } catch (error) {
        if (error && typeof error === "object" && error.code === "ESRCH") return;
        throw error;
      }
    }
    record.child.kill(signal);
  }

  async #waitForClose(record, timeoutMs) {
    if (TERMINAL_STATUSES.has(record.status)) return true;
    try {
      await waitForEvent(record.child, "close", {
        timeoutMs,
        timeoutLabel: "DocsFab CLI close confirmation timed out",
      });
      return true;
    } catch (error) {
      if (error instanceof Error && error.message === "DocsFab CLI close confirmation timed out") {
        return false;
      }
      throw new Error("DocsFab CLI close confirmation failed", { cause: error });
    }
  }

  #groupExists(record) {
    try {
      this.#kill(-record.child.pid, 0);
      return true;
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ESRCH") return false;
      if (error && typeof error === "object" && error.code === "EPERM") return true;
      throw error;
    }
  }

  async #waitForGroupExit(record, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (this.#groupExists(record)) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, Math.min(25, remaining)));
    }
    return true;
  }
}
