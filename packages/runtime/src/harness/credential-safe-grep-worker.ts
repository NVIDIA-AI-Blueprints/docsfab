// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFile, realpath, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { untrustedChildEnvironment } from "../security/child-process-environment.js";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";

import { createContractKit } from "../contract-kit/index.js";
import { classifyGrepFailure, type GrepFailureKind } from "./grep-failure.js";
import {
  assertReadableQualityResource,
  assertReadableSourceResource,
  hasHistoricalQualityProgramSource,
  withQualityGrepPolicy,
} from "../quality-pack/resource-access.js";

interface Request {
  readonly schemaVersion: 1;
  readonly type: "request";
  readonly id: string;
  readonly cwd: string;
  readonly grants: {
    readonly workspaceRoot: string;
    readonly governedSkill?: { readonly id: string; readonly root: string };
    readonly governedQualityRoot?: string;
  };
  readonly params: Record<string, unknown>;
}

type WorkerFailure =
  | { readonly kind: "grep"; readonly grepFailureKind: GrepFailureKind }
  | { readonly kind: "recoverable-miss" }
  | { readonly kind: "tool-defect" };

/** Classify a vanished target without turning unrelated filesystem failures into a miss. */
export function classifyCredentialSafeGrepWorkerError(error: unknown): WorkerFailure {
  const grepFailureKind = classifyGrepFailure(error);
  if (grepFailureKind) return { kind: "grep", grepFailureKind };
  if (
    (error instanceof Error && /^Path not found:/u.test(error.message)) ||
    (typeof error === "object" &&
      error !== null &&
      (error as NodeJS.ErrnoException).code === "ENOENT")
  )
    return { kind: "recoverable-miss" };
  return { kind: "tool-defect" };
}

const kit = createContractKit({
  fail(_code: "invalid-shape" | "invalid-value"): never {
    throw new Error("Worker received a malformed credential-safe grep transport frame.");
  },
  codes: {
    invalidShape: "invalid-shape",
    invalidValue: "invalid-value",
    digestMismatch: "invalid-shape",
    credentialMaterial: "invalid-shape",
    schemaMismatch: "invalid-shape",
  },
  inertMode: "strict",
});

export function parseCredentialSafeGrepRequest(value: unknown): Request {
  kit.assertInert(value);
  const root = kit.object(value);
  kit.exact(root, ["schemaVersion", "type", "id", "cwd", "grants", "params"]);
  if (
    root.schemaVersion !== 1 ||
    root.type !== "request" ||
    typeof root.id !== "string" ||
    root.id.length === 0 ||
    typeof root.cwd !== "string" ||
    !isAbsolute(root.cwd)
  ) {
    throw new Error("Worker received a malformed credential-safe grep request from parent.");
  }
  const grants = kit.object(root.grants);
  kit.exact(
    grants,
    ["workspaceRoot", "governedSkill", "governedQualityRoot"],
    ["governedSkill", "governedQualityRoot"],
  );
  if (grants.workspaceRoot !== root.cwd)
    throw new Error("Worker received credential-safe grep roots that do not match the request.");
  if (grants.governedSkill !== undefined) {
    const skill = kit.object(grants.governedSkill);
    kit.exact(skill, ["id", "root"]);
    if (typeof skill.id !== "string" || typeof skill.root !== "string" || !isAbsolute(skill.root)) {
      throw new Error(
        "Worker rejected the governed skill read grant because its identity was invalid.",
      );
    }
  }
  if (
    grants.governedQualityRoot !== undefined &&
    (typeof grants.governedQualityRoot !== "string" || !isAbsolute(grants.governedQualityRoot))
  ) {
    throw new Error(
      "Worker rejected the governed quality root grant because its identity was invalid.",
    );
  }
  const params = kit.object(root.params);
  kit.exact(
    params,
    ["pattern", "path", "glob", "ignoreCase", "literal", "context", "limit"],
    ["path", "glob", "ignoreCase", "literal", "context", "limit"],
  );
  if (typeof params.pattern !== "string")
    throw new Error(
      "Worker rejected credential-safe grep parameters because their shape was invalid.",
    );
  for (const key of ["path", "glob"] as const) {
    const field = params[key];
    if (field !== undefined && typeof field !== "string")
      throw new Error(
        "Worker rejected credential-safe grep parameters because their shape was invalid.",
      );
  }
  for (const key of ["ignoreCase", "literal"] as const) {
    const field = params[key];
    if (field !== undefined && typeof field !== "boolean")
      throw new Error(
        "Worker rejected credential-safe grep parameters because their shape was invalid.",
      );
  }
  if (params.context !== undefined && typeof params.context !== "number")
    throw new Error(
      "Worker rejected credential-safe grep parameters because their shape was invalid.",
    );
  if (params.limit !== undefined && typeof params.limit !== "number")
    throw new Error(
      "Worker rejected credential-safe grep parameters because their shape was invalid.",
    );
  return root as unknown as Request;
}

export function validateCredentialSafeGrepAbort(value: unknown, id: string): void {
  kit.assertInert(value);
  const control = kit.object(value);
  kit.exact(control, ["schemaVersion", "type", "id"]);
  if (control.schemaVersion !== 1 || control.type !== "abort" || control.id !== id)
    throw new Error("Worker received an invalid credential-safe grep cancellation control frame.");
}

function within(root: string, target: string): boolean {
  const part = relative(root, target);
  return part === "" || (part !== ".." && !part.startsWith(".." + sep) && !isAbsolute(part));
}

function writeResult(id: string, outcome: unknown): void {
  process.stdout.write(JSON.stringify({ schemaVersion: 1, type: "result", id, outcome }) + "\n");
}

/**
 * Resolve only below the scrubbed worker boundary. A separate short-lived
 * process keeps its SDK tool cache apart from the search worker's later
 * adapter cache. It inherits the worker's owned process group and cancellation.
 */
async function resolveWorkerRipgrep(signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const managerUrl = new URL(
    "./utils/tools-manager.js",
    import.meta.resolve("@earendil-works/pi-coding-agent"),
  );
  const source = `
import { constants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
try {
  const manager = await import(process.argv[1]);
  const tool = await manager.ensureTool("rg");
  const candidates = tool ? isAbsolute(tool) ? [tool] :
    (process.env.PATH ?? "").split(delimiter).filter(Boolean).map((directory) => join(directory, tool)) : [];
  let executable = null;
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); executable = await realpath(candidate); break; }
    catch { /* Only consider the existing SDK selection or its PATH entry. */ }
  }
  process.send({ schemaVersion: 1, type: "rg-resolution", executable });
  process.disconnect();
} catch { process.exitCode = 1; }
`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source, managerUrl.href], {
    env: untrustedChildEnvironment(process.env),
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    signal,
  });
  let received = false;
  let invalid = false;
  let executable: string | null = null;
  let processError: Error | undefined;
  child.on("error", (error) => {
    processError = error;
  });
  child.on("message", (value) => {
    if (received) {
      invalid = true;
      return;
    }
    received = true;
    try {
      kit.assertInert(value);
      const record = kit.object(value);
      kit.exact(record, ["schemaVersion", "type", "executable"]);
      if (
        record.schemaVersion !== 1 ||
        record.type !== "rg-resolution" ||
        !(
          record.executable === null ||
          (typeof record.executable === "string" && isAbsolute(record.executable))
        )
      ) {
        invalid = true;
      } else executable = record.executable as string | null;
    } catch {
      invalid = true;
    }
  });
  const code = await new Promise<number | null>((done) =>
    child.once("close", (status) => done(status)),
  );
  signal.throwIfAborted();
  if (processError || code !== 0 || !received || invalid) {
    throw new Error(
      "Credential-safe grep could not authenticate the scrubbed SDK resolver result.",
    );
  }
  if (executable === null) {
    // hygiene: envelope — preserve the SDK message matched by the actionable grep-failure classifier.
    throw new Error("ripgrep (rg) is not available and could not be downloaded");
  }
  return executable;
}

export async function runCredentialSafeGrepWorker(): Promise<void> {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const frames = input[Symbol.asyncIterator]();
  const first = await frames.next();
  if (first.done) {
    process.kill(-process.pid, "SIGKILL");
    return;
  }
  let request: Request;
  try {
    request = parseCredentialSafeGrepRequest(JSON.parse(first.value));
  } catch {
    writeResult("invalid", { kind: "failure", failure: { kind: "tool-defect" } });
    return;
  }
  const controller = new AbortController();
  let deniedPath = false;
  let controlFailure = false;
  let completed = false;
  const monitor = (async (): Promise<"abort" | "eof" | undefined> => {
    while (true) {
      const next = await frames.next();
      if (next.done) {
        if (!completed) {
          controller.abort();
          try {
            process.kill(-process.pid, "SIGKILL");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
          }
        }
        return "eof";
      }
      try {
        const frame: unknown = JSON.parse(next.value);
        validateCredentialSafeGrepAbort(frame, request.id);
      } catch {
        controlFailure = true;
        controller.abort();
        return "abort";
      }
      controller.abort();
      return "abort";
    }
  })();
  const roots = [
    request.grants.workspaceRoot,
    request.grants.governedSkill?.root,
    request.grants.governedQualityRoot,
  ]
    .filter((root): root is string => root !== undefined)
    .map((root) => resolve(root));
  const qualityRoot = request.grants.governedQualityRoot
    ? await realpath(request.grants.governedQualityRoot)
    : undefined;
  const historicalSource = await hasHistoricalQualityProgramSource(request.cwd);
  const admitted = async (path: string): Promise<string> => {
    if (typeof path !== "string" || !isAbsolute(path)) {
      deniedPath = true;
      throw new Error("Worker denied this path because it falls outside approved read roots.");
    }
    let canonical: string;
    try {
      canonical = await realpath(path);
    } catch (error) {
      throw error;
    }
    if (!roots.some((root) => within(root, canonical))) {
      deniedPath = true;
      throw new Error("Worker denied this path because it falls outside approved read roots.");
    }
    if (qualityRoot) {
      try {
        await assertReadableQualityResource(qualityRoot, canonical);
      } catch (error) {
        deniedPath = true;
        throw error;
      }
    }
    try {
      await assertReadableSourceResource(request.cwd, canonical, historicalSource);
    } catch (error) {
      deniedPath = true;
      throw error;
    }
    return canonical;
  };
  const execution = (async (): Promise<unknown> => {
    try {
      const target = await admitted(
        resolve(request.cwd, typeof request.params.path === "string" ? request.params.path : "."),
      );
      const executable =
        qualityRoot || historicalSource ? await resolveWorkerRipgrep(controller.signal) : undefined;
      const result = await withQualityGrepPolicy(
        request.cwd,
        qualityRoot,
        target,
        executable,
        controller.signal,
        async () => {
          // Import only after the single-request worker's owned tool adapter is
          // ready. The parent process and all user tool/config directories stay unchanged.
          const sdk = await import("@earendil-works/pi-coding-agent");
          const definition = sdk.createGrepToolDefinition(request.cwd, {
            operations: {
              isDirectory: async (path) => (await stat(await admitted(path))).isDirectory(),
              readFile: async (path) => readFile(await admitted(path), "utf8"),
            },
          });
          return definition.execute(
            "docsfab-isolated-grep",
            { ...request.params, path: target } as {
              pattern: string;
              path?: string;
              glob?: string;
              ignoreCase?: boolean;
              literal?: boolean;
              context?: number;
              limit?: number;
            },
            controller.signal,
            undefined,
            undefined as unknown as Parameters<typeof definition.execute>[4],
          );
        },
        typeof request.params.glob === "string" ? request.params.glob : undefined,
      );
      if (deniedPath) return { kind: "failure", failure: { kind: "denied-path" } };
      return { kind: "success", result };
    } catch (error) {
      if (deniedPath) return { kind: "failure", failure: { kind: "denied-path" } };
      if (controlFailure || controller.signal.aborted)
        return { kind: "failure", failure: { kind: "tool-defect" } };
      return { kind: "failure", failure: classifyCredentialSafeGrepWorkerError(error) };
    }
  })();
  const outcome = await Promise.race([
    execution,
    monitor.then((control) => ({
      kind: "failure",
      failure: { kind: controlFailure ? "tool-defect" : "tool-defect" },
    })),
  ]);
  completed = true;
  writeResult(request.id, outcome);
  await monitor;
}
