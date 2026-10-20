#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ACCEPTANCE_NETWORKED_PHASE_FAILURE_FILE,
  ACCEPTANCE_PHASE_OUTPUT_FILE,
  bindAcceptanceJudgeEvidence,
  createAcceptancePlan,
  executeAcceptancePlan,
  offlineAcceptanceEnvironment,
  sanitizeAcceptancePhaseOutput,
  summarizeAcceptanceRunRecord,
  summarizeNetworkedPhaseFailure,
  type AcceptanceCommand,
  type AcceptanceCommandDiagnostic,
  type AcceptanceCommandResult,
  type AcceptanceNetworkedPhaseFailure,
  type AcceptancePhase,
  type AcceptancePhaseOutput,
  type AcceptancePhaseResult,
  type AcceptanceRunRecordSummary,
  validateAcceptanceGates,
} from "./acceptance.js";
import type {
  AcceptanceCheckLimitationRecord,
  HostRootOwnership,
} from "./acceptance-check-limitations.js";
import {
  readAcceptanceJsonLeaf,
  readAcceptanceJsonLeaves,
  type AcceptanceEvidenceDirectory,
  type AcceptanceJsonLeaf,
  writeAcceptanceJsonExclusive,
} from "./acceptance-evidence.js";
import { loadPrivateDocsFabEnvironment } from "./config/private-environment.js";
import { loadConfig, type DocsFabConfig } from "./config/runtime-loader.js";
import { ACCEPTANCE_LOCAL_NAMES } from "./config/env-admission.generated.js";
import { runCliEntrypoint } from "./operator/cli-entrypoint.js";
import {
  assertPrivateOperatorEvidenceDirectory,
  canonicalizeCollectableOperatorDestination,
  canonicalizePrivateOperatorRoot,
  ensurePinnedPrivateOperatorRoot,
  publishCollectableOperatorEvidence,
} from "./operator/private-state.js";
import { isRecord } from "./shared/primitives.js";

export interface CliOptions {
  stateRoot: string;
  evidenceRoot: string;
  live: boolean;
  judge: boolean;
  approvedJudgeUrl?: string;
  approvedModelUrl?: string;
  /** Caller-named collectable destination for minimized terminal evidence. */
  collectRoot?: string;
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}

export function parseOptions(args: string[]): CliOptions {
  const stateRoot = option(args, "--state-dir");
  const evidenceRoot = option(args, "--evidence-dir");
  if (!stateRoot || !evidenceRoot) {
    throw new Error("acceptance requires --state-dir and --evidence-dir.");
  }
  const known = new Set([
    "--state-dir",
    "--evidence-dir",
    "--live",
    "--judge",
    "--approve-judge-url",
    "--approve-model-url",
    "--collect-dir",
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (!known.has(value)) throw new Error(`Unknown acceptance option "${value}".`);
    if (
      [
        "--state-dir",
        "--evidence-dir",
        "--approve-judge-url",
        "--approve-model-url",
        "--collect-dir",
      ].includes(value)
    ) {
      index += 1;
    }
  }
  const collectRoot = option(args, "--collect-dir");
  return {
    stateRoot: resolve(stateRoot),
    evidenceRoot: resolve(evidenceRoot),
    ...(collectRoot ? { collectRoot: resolve(collectRoot) } : {}),
    live: args.includes("--live"),
    judge: args.includes("--judge"),
    ...(option(args, "--approve-judge-url")
      ? { approvedJudgeUrl: option(args, "--approve-judge-url") }
      : {}),
    ...(option(args, "--approve-model-url")
      ? { approvedModelUrl: option(args, "--approve-model-url") }
      : {}),
  };
}

export interface AcceptanceCommandOutput extends AcceptanceCommandResult {
  stdout: string;
  /** Standard error alone, where a networked command prints its failure envelope. */
  stderr?: string;
  /** Combined stdout and stderr in arrival order, kept for a failed offline phase. */
  output?: string;
}

export type AcceptanceCommandExecutor = (
  command: AcceptanceCommand,
  stream?: boolean,
) => Promise<AcceptanceCommandOutput>;

function isCanonicalCheckCommand(command: AcceptanceCommand): boolean {
  return command.diagnosticProfile === "runtime-check";
}

interface AcceptanceCheckDiagnosticMetadata {
  packageName: string;
  packageVersion: string;
  testFiles: Set<string>;
  maximumRelevantLineLength: number;
}

const ACCEPTANCE_CHECK_DIAGNOSTIC_SCRIPTS = new Set(["check:pins", "check:static", "test"]);

async function acceptanceCheckDiagnosticMetadata(
  directory: string,
): Promise<AcceptanceCheckDiagnosticMetadata | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      "name" in parsed &&
      typeof parsed.name === "string" &&
      /^[A-Za-z0-9@._/-]+$/u.test(parsed.name) &&
      "version" in parsed &&
      typeof parsed.version === "string" &&
      /^[A-Za-z0-9.+-]+$/u.test(parsed.version)
    ) {
      const testRoot = join(directory, "test");
      const testFiles = new Set<string>();
      const visit = async (current: string, prefix: string): Promise<void> => {
        for (const entry of await readdir(current, { withFileTypes: true })) {
          const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.isDirectory()) {
            await visit(join(current, entry.name), relativePath);
          } else if (
            entry.isFile() &&
            /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(entry.name) &&
            relativePath
              .split("/")
              .every(
                (part) =>
                  part !== "" && part !== "." && part !== ".." && /^[A-Za-z0-9_.-]+$/u.test(part),
              )
          ) {
            testFiles.add(`test/${relativePath}`);
          }
        }
      };
      try {
        await visit(testRoot, "");
      } catch {
        // A missing test tree only removes path diagnostics; it never changes execution.
      }
      const lifecycleLengths = [...ACCEPTANCE_CHECK_DIAGNOSTIC_SCRIPTS].map(
        (script) => `> ${parsed.name}@${parsed.version} ${script}`.length,
      );
      const testPathLengths = [...testFiles].map((path) => path.length + 8);
      return {
        packageName: parsed.name,
        packageVersion: parsed.version,
        testFiles,
        maximumRelevantLineLength: Math.max(0, ...lifecycleLengths, ...testPathLengths),
      };
    }
  } catch {
    // Diagnostics are optional; a missing package identity never changes execution.
  }
  return undefined;
}

class AcceptanceCheckDiagnosticCollector {
  private readonly partialLines = new Map<"stdout" | "stderr", string>([
    ["stdout", ""],
    ["stderr", ""],
  ]);
  private readonly ignoredUntilNewline = new Set<"stdout" | "stderr">();
  private script: string | undefined;
  private testFile: string | undefined;

  constructor(
    private readonly cwd: string,
    private readonly metadata: AcceptanceCheckDiagnosticMetadata | undefined,
  ) {}

  observe(stream: "stdout" | "stderr", chunk: Buffer): void {
    if (!this.metadata) return;
    const text = this.partialLines.get(stream)! + chunk.toString("utf8");
    const lines = text.split(/\r?\n/u);
    let partial = lines.pop() ?? "";
    if (this.ignoredUntilNewline.has(stream)) {
      const newline = text.search(/\r?\n/u);
      if (newline < 0) return;
      this.ignoredUntilNewline.delete(stream);
      const remaining = text.slice(newline).replace(/^\r?\n/u, "");
      const resumed = remaining.split(/\r?\n/u);
      partial = resumed.pop() ?? "";
      for (const line of resumed) this.observeLine(stream, line);
    } else {
      for (const line of lines) this.observeLine(stream, line);
    }
    if (partial.length > this.metadata.maximumRelevantLineLength) {
      this.observeLine(stream, partial.slice(0, this.metadata.maximumRelevantLineLength));
      this.partialLines.set(stream, "");
      this.ignoredUntilNewline.add(stream);
      return;
    }
    this.partialLines.set(stream, partial);
  }

  finish(): void {
    for (const [stream, line] of this.partialLines) this.observeLine(stream, line);
    this.partialLines.clear();
    this.ignoredUntilNewline.clear();
  }

  result(
    termination: "exit" | "signal" | "spawn-error",
    signal?: NodeJS.Signals,
  ): AcceptanceCommandDiagnostic {
    return {
      termination,
      ...(signal ? { signal } : {}),
      ...(this.script ? { script: this.script } : {}),
      ...(this.testFile ? { testFile: this.testFile } : {}),
    };
  }

  private observeLine(stream: "stdout" | "stderr", rawLine: string): void {
    if (!this.metadata || stream !== "stdout") return;
    const line = rawLine.replace(/\u001b\[[0-9;]*m/gu, "").trim();
    {
      const escapedName = this.metadata.packageName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      const escapedVersion = this.metadata.packageVersion.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      const lifecycle = line.match(
        new RegExp(`^>\\s+${escapedName}@${escapedVersion}\\s+([A-Za-z0-9][A-Za-z0-9:_-]*)$`, "u"),
      );
      if (lifecycle && ACCEPTANCE_CHECK_DIAGNOSTIC_SCRIPTS.has(lifecycle[1]!)) {
        this.script = lifecycle[1];
      }
    }
    if (this.script !== "test" || this.testFile) return;
    const failure = line.match(/^(?:FAIL|❯)\s+([^\s]+)/u);
    const candidate = failure?.[1];
    if (!candidate) return;
    const absolute = resolve(this.cwd, candidate);
    const relativePath = relative(this.cwd, absolute).split(sep).join("/");
    const parts = relativePath.split("/");
    if (
      this.metadata.testFiles.has(relativePath) &&
      parts[0] === "test" &&
      parts.length > 1 &&
      parts.every(
        (part) => part !== "" && part !== "." && part !== ".." && /^[A-Za-z0-9_.-]+$/u.test(part),
      ) &&
      /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(parts.at(-1) ?? "")
    ) {
      this.testFile = relativePath;
    }
  }
}

function prefixedCommand(
  prefix: readonly string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
  file: string,
  ...args: string[]
): AcceptanceCommand {
  return prefix.length > 0
    ? {
        file: prefix[0]!,
        args: [...prefix.slice(1), file, ...args],
        cwd,
        environment,
      }
    : { file, args, cwd, environment };
}

/** Turns off background gc and maintenance for every acceptance export git command. */
export const ACCEPTANCE_EXPORT_GIT_CONFIG = [
  "-c",
  "gc.auto=0",
  "-c",
  "maintenance.auto=false",
] as const;

export async function authenticateAcceptanceExport(input: {
  workspaceRoot: string;
  expectedTree: string;
  objectFormat: "sha1" | "sha256";
  commandPrefix: readonly string[];
  environment: NodeJS.ProcessEnv;
  execute?: AcceptanceCommandExecutor;
}): Promise<void> {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(input.expectedTree)) {
    throw new Error("Cannot authenticate an invalid source tree identity.");
  }
  if (
    (input.objectFormat === "sha1" && input.expectedTree.length !== 40) ||
    (input.objectFormat === "sha256" && input.expectedTree.length !== 64)
  ) {
    throw new Error("Acceptance export tree identity does not match its object format.");
  }
  const executor = input.execute ?? executeCommand;
  // The export's commit must not leave a detached `git gc` or `git maintenance`
  // writing into the repository while the caller removes it.
  const run = async (args: string[]): Promise<AcceptanceCommandOutput> =>
    executor(
      prefixedCommand(
        input.commandPrefix,
        input.workspaceRoot,
        input.environment,
        "git",
        ...ACCEPTANCE_EXPORT_GIT_CONFIG,
        ...args,
      ),
      false,
    );
  for (const args of [
    ["init", "--initial-branch=acceptance-export", `--object-format=${input.objectFormat}`],
    ["config", "user.email", "docsfab-acceptance@example.invalid"],
    ["config", "user.name", "DocsFab Acceptance Export"],
    ["config", "commit.gpgsign", "false"],
    ["add", "--force", "--all"],
  ]) {
    if ((await run(args)).exitCode !== 0) {
      throw new Error("Cannot initialize the authenticated acceptance export.");
    }
  }
  const preparedTree = await run(["write-tree"]);
  if (preparedTree.exitCode !== 0 || preparedTree.stdout.trim() !== input.expectedTree) {
    throw new Error("Acceptance export tree does not match the tested commit.");
  }
  if ((await run(["commit", "--quiet", "-m", "authenticated acceptance export"])).exitCode !== 0) {
    throw new Error("Cannot seal the authenticated acceptance export.");
  }
  const [committedTree, status] = await Promise.all([
    run(["rev-parse", "HEAD^{tree}"]),
    run(["status", "--porcelain=v1", "--untracked-files=all"]),
  ]);
  if (
    committedTree.exitCode !== 0 ||
    committedTree.stdout.trim() !== input.expectedTree ||
    status.exitCode !== 0 ||
    status.stdout !== ""
  ) {
    throw new Error("Authenticated acceptance export is not exact and clean.");
  }
}

export interface AcceptanceCliDependencies {
  /** Runtime package directory; its enclosing Git checkout is resolved separately. */
  repositoryRoot?: string;
  environment?: NodeJS.ProcessEnv;
  execute?: AcceptanceCommandExecutor;
  isolateOffline?: () => Promise<OfflineIsolation>;
  loadConfiguration?: (environment: NodeJS.ProcessEnv) => DocsFabConfig;
  now?: () => Date;
  randomId?: () => string;
  remove?: typeof rm;
  readRecordLeaves?: (directory: AcceptanceEvidenceDirectory) => Promise<AcceptanceJsonLeaf[]>;
  readEvidenceLeaf?: (
    directory: AcceptanceEvidenceDirectory,
    file: string,
  ) => Promise<AcceptanceJsonLeaf>;
  writeEvidence?: (
    directory: AcceptanceEvidenceDirectory,
    file: string,
    value: unknown,
  ) => Promise<void>;
  log?: (message: string) => void;
}

export interface AcceptanceCliResult {
  exitCode: number;
  acceptanceId: string;
  manifestPath: string;
  stateDirectory: string;
  evidenceDirectory: string;
  passed: boolean;
  /** Collectable copy of the minimized manifest when --collect-dir was named. */
  collectedManifestPath?: string;
}

export async function executeCommand(
  command: AcceptanceCommand,
  stream = false,
): Promise<AcceptanceCommandOutput> {
  const isCheck = isCanonicalCheckCommand(command);
  const diagnosticCollector = isCheck
    ? new AcceptanceCheckDiagnosticCollector(
        command.cwd,
        await acceptanceCheckDiagnosticMetadata(command.cwd),
      )
    : undefined;
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command.file, command.args, {
      cwd: command.cwd,
      env: command.environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let output = "";
    let settled = false;
    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stdout += text;
      output += text;
      diagnosticCollector?.observe("stdout", chunk);
      if (stream) process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderr += text;
      output += text;
      diagnosticCollector?.observe("stderr", chunk);
      if (stream) process.stderr.write(chunk);
    });
    child.on("error", (error) => {
      if (!diagnosticCollector) {
        reject(error);
        return;
      }
      settled = true;
      diagnosticCollector.finish();
      resolvePromise({
        exitCode: 1,
        stdout,
        stderr,
        output,
        diagnostic: diagnosticCollector.result("spawn-error"),
      });
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      const failed = code !== 0 || signal !== null;
      diagnosticCollector?.finish();
      settled = true;
      resolvePromise({
        exitCode: code ?? 1,
        stdout,
        stderr,
        output,
        ...(failed && diagnosticCollector
          ? {
              diagnostic: diagnosticCollector.result(
                signal ? "signal" : "exit",
                signal ?? undefined,
              ),
            }
          : {}),
      });
    });
  });
}

async function probeIsolationPrefix(
  prefix: string[],
  executor: AcceptanceCommandExecutor = executeCommand,
): Promise<string[] | undefined> {
  try {
    const probe = await executor(
      {
        file: prefix[0]!,
        args: [...prefix.slice(1), "/usr/bin/true"],
        cwd: process.cwd(),
        environment: { PATH: process.env.PATH },
      },
      false,
    );
    return probe.exitCode === 0 ? prefix : undefined;
  } catch {
    return undefined;
  }
}

export interface OfflineIsolation {
  commandPrefix: string[];
  /** Owner of `/` outside the sandbox and as the sandbox shows it. */
  hostRootOwner?: HostRootOwnership;
}

export async function offlineIsolation(
  executor: AcceptanceCommandExecutor = executeCommand,
): Promise<OfflineIsolation> {
  if (process.platform === "darwin") {
    const prefix = await probeIsolationPrefix(
      ["/usr/bin/sandbox-exec", "-p", "(version 1) (allow default) (deny network*)"],
      executor,
    );
    if (prefix) {
      return { commandPrefix: prefix, hostRootOwner: await probeHostRootOwner(prefix, executor) };
    }
  }
  if (process.platform === "linux") {
    for (const prefix of [
      ["/usr/bin/bwrap", "--unshare-net", "--dev-bind", "/", "/", "--"],
      ["/usr/bin/unshare", "--net", "--"],
    ]) {
      const available = await probeIsolationPrefix(prefix, executor);
      if (available) {
        return {
          commandPrefix: available,
          hostRootOwner: await probeHostRootOwner(available, executor),
        };
      }
    }
  }
  throw new Error("Offline acceptance requires an active deny-network OS sandbox.");
}

const HOST_ROOT_OWNER_PROBE = 'process.stdout.write(String(require("node:fs").statSync("/").uid))';

/**
 * Measure the owner of `/` inside the offline sandbox. An unprivileged user
 * namespace, such as bwrap's, shows root-owned host paths as an unmapped uid;
 * the check phase uses this to decide which ownership-bound files can run.
 * Any probe failure reports `inside: null`, which keeps those files running.
 */
export async function probeHostRootOwner(
  prefix: readonly string[],
  executor: AcceptanceCommandExecutor = executeCommand,
): Promise<HostRootOwnership> {
  const outside = (await stat("/")).uid;
  try {
    const probe = await executor(
      {
        file: prefix[0]!,
        args: [...prefix.slice(1), process.execPath, "-e", HOST_ROOT_OWNER_PROBE],
        cwd: process.cwd(),
        environment: { PATH: process.env.PATH },
      },
      false,
    );
    const observed = probe.stdout.trim();
    if (probe.exitCode === 0 && /^\d+$/u.test(observed)) {
      return { outside, inside: Number(observed) };
    }
  } catch {
    // The probe process could not start. Like a failed or unreadable probe,
    // that leaves the owner unmeasured, which keeps the ownership-bound files.
  }
  return { outside, inside: null };
}

/** Operator-visible account of the measured sandbox and each file the check phase leaves out. */
export function checkLimitationLines(record: AcceptanceCheckLimitationRecord): string[] {
  const owner = record.hostRootOwner;
  const ownership =
    owner === undefined
      ? "Acceptance check: the offline sandbox was not probed for the owner of /."
      : owner.inside === null
        ? `Acceptance check: the owner of / inside the offline sandbox could not be measured (uid ${owner.outside} outside), so ownership-bound files run.`
        : `Acceptance check: / is owned by uid ${owner.inside} inside the offline sandbox and uid ${owner.outside} outside.`;
  return [
    ownership,
    ...record.excluded.map(
      (limitation) =>
        `Acceptance check limitation: ${limitation.file} not run (${limitation.reason})`,
    ),
  ];
}

/**
 * Build an offline sandbox that also confines writes to explicit, canonical
 * disposable roots. Repository validation commands are repository-controlled,
 * so network isolation alone is not a sufficient boundary.
 */
export async function confinedOfflineIsolation(
  writableRoots: readonly string[],
  executor: AcceptanceCommandExecutor = executeCommand,
): Promise<{ commandPrefix: string[] }> {
  if (writableRoots.length === 0 || writableRoots.some((root) => !isAbsolute(root))) {
    throw new Error("Confined offline validation requires absolute writable roots.");
  }
  const roots = [...new Set(writableRoots.map((root) => resolve(root)))];
  for (const candidate of confinedOfflineIsolationCandidates(process.platform, roots)) {
    const prefix = await probeIsolationPrefix(candidate, executor);
    if (prefix) return { commandPrefix: prefix };
  }
  throw new Error("Offline validation requires an active deny-network, write-confined OS sandbox.");
}

export function confinedOfflineIsolationCandidates(
  platform: NodeJS.Platform,
  writableRoots: readonly string[],
): string[][] {
  const roots = [...new Set(writableRoots.map((root) => resolve(root)))];
  if (roots.length === 0 || roots.some((root) => !isAbsolute(root))) return [];
  if (platform === "darwin") {
    const permissions = roots
      .map((root) => `(allow file-write* (subpath ${sandboxLiteral(root)}))`)
      .join(" ");
    return [
      [
        "/usr/bin/sandbox-exec",
        "-p",
        `(version 1) (allow default) (deny network*) (deny file-write*) ${permissions}`,
      ],
    ];
  }
  if (platform === "linux") {
    const bindRoots = roots.flatMap((root) => ["--bind", root, root]);
    return [
      [
        "/usr/bin/bwrap",
        "--unshare-net",
        "--ro-bind",
        "/",
        "/",
        ...bindRoots,
        "--dev",
        "/dev",
        "--proc",
        "/proc",
        "--",
      ],
    ];
  }
  return [];
}

function sandboxLiteral(value: string): string {
  return JSON.stringify(value);
}

interface AcceptanceRecordSet {
  summaries: AcceptanceRunRecordSummary[];
  rawById: Map<string, Record<string, unknown>>;
}

async function safeRunRecords(
  stateDirectory: AcceptanceEvidenceDirectory,
  readLeaves: (
    directory: AcceptanceEvidenceDirectory,
  ) => Promise<AcceptanceJsonLeaf[]> = readAcceptanceJsonLeaves,
): Promise<AcceptanceRecordSet> {
  const summaries: AcceptanceRunRecordSummary[] = [];
  const rawById = new Map<string, Record<string, unknown>>();
  for (const leaf of await readLeaves(stateDirectory)) {
    const record = leaf.value;
    const summary = summarizeAcceptanceRunRecord(
      record,
      leaf.file,
      createHash("sha256").update(leaf.bytes).digest("hex"),
    );
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      throw new Error("Acceptance run record must be an object.");
    }
    summaries.push(summary);
    rawById.set(summary.id, record as Record<string, unknown>);
  }
  return { summaries, rawById };
}

async function safeJudgeEvidence(
  evidenceDirectory: AcceptanceEvidenceDirectory,
  acceptanceId: string,
  revision: string,
  judgeProfileStatus: string,
  records: AcceptanceRunRecordSummary[],
  readLeaf: (
    directory: AcceptanceEvidenceDirectory,
    file: string,
  ) => Promise<AcceptanceJsonLeaf> = readAcceptanceJsonLeaf,
): Promise<unknown | undefined> {
  try {
    const leaf = await readLeaf(evidenceDirectory, "judge-result.json");
    return bindAcceptanceJudgeEvidence(leaf.value, {
      sha256: createHash("sha256").update(leaf.bytes).digest("hex"),
      acceptanceId,
      revision,
      judgeProfileStatus: judgeProfileStatus as "current" | "stale" | "unknown",
      records,
    });
  } catch {
    return undefined;
  }
}

/** The first command that failed in an offline phase, with its raw output. */
interface FailedOfflineCommand {
  phase: AcceptancePhase["id"];
  command: AcceptanceCommand;
  exitCode: number;
  output: string;
}

/**
 * Keep a failed offline phase command's sanitized output beside the manifest,
 * in the private evidence directory and, when named, the collectable one. Each
 * write that fails is logged by name; neither changes the acceptance result.
 */
async function keepFailedPhaseOutput(input: {
  failure: FailedOfflineCommand;
  acceptanceId: string;
  revision: string;
  environment: NodeJS.ProcessEnv;
  privateRoots: readonly string[];
  evidenceIdentity: AcceptanceEvidenceDirectory;
  evidenceDirectory: string;
  collectRoot: string | undefined;
  writeEvidence: (
    directory: AcceptanceEvidenceDirectory,
    file: string,
    value: unknown,
  ) => Promise<void>;
  log: (message: string) => void;
}): Promise<void> {
  const sanitize = (text: string) =>
    sanitizeAcceptancePhaseOutput(text, {
      environment: input.environment,
      privateRoots: input.privateRoots,
    });
  const { command } = input.failure;
  const evidence: AcceptancePhaseOutput = {
    schemaVersion: 1,
    acceptanceId: input.acceptanceId,
    testedCommit: input.revision,
    phase: input.failure.phase,
    command: sanitize([command.file, ...command.args].join(" ")),
    exitCode: input.failure.exitCode,
    output: sanitize(input.failure.output),
  };
  try {
    await input.writeEvidence(input.evidenceIdentity, ACCEPTANCE_PHASE_OUTPUT_FILE, evidence);
    input.log(
      `Failed phase output: ${join(input.evidenceDirectory, ACCEPTANCE_PHASE_OUTPUT_FILE)}`,
    );
  } catch (error) {
    input.log(`Failed phase output was not kept: ${errorMessage(error)}`);
  }
  if (!input.collectRoot) return;
  try {
    const collected = await publishCollectableOperatorEvidence({
      requestedPath: input.collectRoot,
      privateRoots: input.privateRoots,
      label: "--collect-dir",
      invocationId: input.acceptanceId,
      file: ACCEPTANCE_PHASE_OUTPUT_FILE,
      value: evidence,
      environment: input.environment,
    });
    input.log(`Collectable failed phase output: ${collected}`);
  } catch (error) {
    input.log(`Failed phase output was not collected: ${errorMessage(error)}`);
  }
}

/**
 * Keep a failed networked phase's summary beside the manifest, in the private
 * evidence directory and, when named, the collectable one, as a failed
 * offline phase's output is kept. Each write that fails is logged by name;
 * neither changes the acceptance result.
 */
async function keepNetworkedPhaseFailure(input: {
  summary: AcceptanceNetworkedPhaseFailure;
  acceptanceId: string;
  environment: NodeJS.ProcessEnv;
  privateRoots: readonly string[];
  evidenceIdentity: AcceptanceEvidenceDirectory;
  evidenceDirectory: string;
  collectRoot: string | undefined;
  writeEvidence: (
    directory: AcceptanceEvidenceDirectory,
    file: string,
    value: unknown,
  ) => Promise<void>;
  log: (message: string) => void;
}): Promise<void> {
  try {
    await input.writeEvidence(
      input.evidenceIdentity,
      ACCEPTANCE_NETWORKED_PHASE_FAILURE_FILE,
      input.summary,
    );
    input.log(
      `Networked phase failure summary: ${join(input.evidenceDirectory, ACCEPTANCE_NETWORKED_PHASE_FAILURE_FILE)}`,
    );
  } catch (error) {
    input.log(`Networked phase failure summary was not kept: ${errorMessage(error)}`);
  }
  if (!input.collectRoot) return;
  try {
    const collected = await publishCollectableOperatorEvidence({
      requestedPath: input.collectRoot,
      privateRoots: input.privateRoots,
      label: "--collect-dir",
      invocationId: input.acceptanceId,
      file: ACCEPTANCE_NETWORKED_PHASE_FAILURE_FILE,
      value: input.summary,
      environment: input.environment,
    });
    input.log(`Collectable networked phase failure summary: ${collected}`);
  } catch (error) {
    input.log(`Networked phase failure summary was not collected: ${errorMessage(error)}`);
  }
}

/**
 * The one trace line for a failed networked phase: its id, exit status, and
 * the sanitized code and failure class from its summary. It carries no next
 * action, docs reference, or other text the command printed.
 */
function networkedPhaseFailureLine(summary: AcceptanceNetworkedPhaseFailure): string {
  const exited = `Networked phase failure: ${summary.phase} exited ${summary.exitCode}`;
  if (summary.code === undefined) return `${exited} without a structured failure report.`;
  const failure = summary.failure;
  if (!failure) return `${exited}, code ${summary.code}.`;
  const classifiedCode = failure.code === summary.code ? "" : `, code ${failure.code}`;
  return `${exited}, code ${summary.code}, failure class ${failure.class} (layer ${failure.layer}${classifiedCode}).`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const liveModelProfileSuffixes = [
  "PROVIDER",
  "BASE_URL",
  "API_FORMAT",
  "API_KEY",
  "CONTEXT_WINDOW",
  "MAX_OUTPUT_TOKENS",
  "API_MIN_OUTPUT_TOKENS",
  "CONTEXT_RESERVE_TOKENS",
  "REASONING",
  "INPUT_TYPES",
  "SUPPORTS_DEVELOPER_ROLE",
  "SUPPORTS_REASONING_EFFORT",
  "COMPATIBLE_API_FORMATS",
  "INPUT_COST_PER_MILLION",
  "OUTPUT_COST_PER_MILLION",
  "CACHE_READ_COST_PER_MILLION",
  "CACHE_WRITE_COST_PER_MILLION",
  "PROFILE_APPROVED_SOURCE",
  "PROFILE_EFFECTIVE_DATE",
  "PROFILE_REVIEW_AFTER",
] as const;

const liveRuntimeFields = [
  "DOCSFAB_READ_ONLY_MAX_RETRIES",
  "DOCSFAB_RETRY_BASE_DELAY_MS",
  "DOCSFAB_RETRY_MAX_DELAY_MS",
  "DOCSFAB_RETRYABLE_CATEGORIES",
] as const;

/** Credential-free environment for local Git, tar, and integrity commands. */
export function localAcceptanceEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed: NodeJS.ProcessEnv = {};
  for (const name of ACCEPTANCE_LOCAL_NAMES) {
    if (base[name] !== undefined) allowed[name] = base[name];
  }
  allowed.GIT_CONFIG_NOSYSTEM = "1";
  allowed.GIT_CONFIG_GLOBAL = "/dev/null";
  allowed.GIT_NO_REPLACE_OBJECTS = "1";
  allowed.GIT_TERMINAL_PROMPT = "0";
  return allowed;
}

/** Build the only environment that may cross the live subprocess boundary. */
export function liveAcceptanceEnvironment(
  base: NodeJS.ProcessEnv,
  stateDirectory: string,
  includeJudge = false,
): NodeJS.ProcessEnv {
  const allowed = localAcceptanceEnvironment(base);
  for (const prefix of includeJudge ? (["MODEL", "JUDGE"] as const) : (["MODEL"] as const)) {
    for (const suffix of liveModelProfileSuffixes) {
      const name = `${prefix}_${suffix}`;
      if (base[name] !== undefined) allowed[name] = base[name];
    }
  }
  if (base.MODEL_ID !== undefined) allowed.MODEL_ID = base.MODEL_ID;
  if (includeJudge && base.JUDGE_MODEL_ID !== undefined) {
    allowed.JUDGE_MODEL_ID = base.JUDGE_MODEL_ID;
  }
  for (const name of liveRuntimeFields) {
    if (base[name] !== undefined) allowed[name] = base[name];
  }
  allowed.JUDGE_ENABLED = includeJudge ? "true" : "false";
  if (includeJudge) {
    // loadConfig requires a policy profile, but the judge subprocess never
    // uses it. Do not expose the real policy credential across this boundary.
    allowed.MODEL_API_KEY = "acceptance-unused-policy-key";
  }
  allowed.DOCSFAB_STATE_DIR = stateDirectory;
  return allowed;
}

/**
 * The whole-repository scan is advisory only: a record must carry the
 * `advisory` disposition new runs record and never carry override
 * authorization, regardless of how many credential-shaped fixtures the scanned
 * revision tracks.
 */
function scannerEvidenceIsAdvisory(raw: Record<string, unknown> | undefined): boolean {
  if (!raw || raw.securityScanAuthorization !== undefined) return false;
  if (
    !isRecord(raw.securityScanEffectiveDisposition) ||
    Object.keys(raw.securityScanEffectiveDisposition).some((field) => field !== "status") ||
    raw.securityScanEffectiveDisposition.status !== "advisory"
  ) {
    return false;
  }
  return isRecord(raw.securityScan) && Array.isArray(raw.securityScan.findings);
}

function liveRecordSetIsExact(
  records: readonly AcceptanceRunRecordSummary[],
  rawById: ReadonlyMap<string, Record<string, unknown>>,
  selfRevision: string,
  fixtureRevision: string | undefined,
): boolean {
  if (records.length !== 2 || !fixtureRevision) return false;
  if (
    records.some(
      (record) =>
        record.workflow !== "readiness" ||
        record.status !== "succeeded" ||
        typeof record.revision !== "string" ||
        record.revision.length === 0 ||
        record.models.length !== 1 ||
        record.models[0]!.profileSha256 === undefined,
    )
  ) {
    return false;
  }
  const policyModel = records[0]!.models[0]!;
  if (
    records.some((record) => {
      const candidate = record.models[0]!;
      return (
        candidate.provider !== policyModel.provider ||
        candidate.model !== policyModel.model ||
        candidate.profileSha256 !== policyModel.profileSha256
      );
    })
  ) {
    return false;
  }
  const selfRecords = records.filter((record) => record.revision === selfRevision);
  const fixtureRecords = records.filter((record) => record.revision === fixtureRevision);
  return (
    selfRecords.length === 1 &&
    selfRecords[0]!.scanDisposition === "advisory" &&
    scannerEvidenceIsAdvisory(rawById.get(selfRecords[0]!.id)) &&
    fixtureRecords.length === 1 &&
    fixtureRecords[0]!.scanDisposition === "advisory" &&
    scannerEvidenceIsAdvisory(rawById.get(fixtureRecords[0]!.id)) &&
    selfRevision !== fixtureRevision
  );
}

export async function runAcceptanceCli(
  args: string[],
  dependencies: AcceptanceCliDependencies = {},
): Promise<AcceptanceCliResult> {
  const options = parseOptions(args);
  const suppliedEnvironment = dependencies.environment ?? process.env;
  // Live approval gates, configuration loading, and redaction must observe the
  // same private effective environment without exporting file-loaded values.
  const environment = options.live
    ? loadPrivateDocsFabEnvironment(suppliedEnvironment)
    : suppliedEnvironment;
  const localEnvironment = localAcceptanceEnvironment(environment);
  const executor = dependencies.execute ?? executeCommand;
  const now = dependencies.now ?? (() => new Date());
  const randomId = dependencies.randomId ?? randomUUID;
  const remove = dependencies.remove ?? rm;
  const readRecordLeaves = dependencies.readRecordLeaves ?? readAcceptanceJsonLeaves;
  const readEvidenceLeaf = dependencies.readEvidenceLeaf ?? readAcceptanceJsonLeaf;
  const writeEvidence = dependencies.writeEvidence ?? writeAcceptanceJsonExclusive;
  const log = dependencies.log ?? console.log;
  const runtimeRoot = await realpath(
    dependencies.repositoryRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  );
  let liveConfig: DocsFabConfig | undefined;
  if (options.live) {
    liveConfig = (dependencies.loadConfiguration ?? loadConfig)(environment);
  }
  validateAcceptanceGates({
    live: options.live,
    judge: options.judge,
    ...(options.approvedModelUrl ? { approvedModelUrl: options.approvedModelUrl } : {}),
    ...(options.approvedJudgeUrl ? { approvedJudgeUrl: options.approvedJudgeUrl } : {}),
    environment,
  });

  // Prove the deny-network boundary before invoking repository-local Git
  // configuration such as core.fsmonitor.
  const isolation = await (dependencies.isolateOffline ?? (() => offlineIsolation(executor)))();
  const localCommandPrefix = isolation.commandPrefix;

  const repositoryResult = await executor(
    prefixedCommand(
      localCommandPrefix,
      runtimeRoot,
      localEnvironment,
      "git",
      "rev-parse",
      "--show-toplevel",
    ),
    false,
  );
  const repositoryPath = repositoryResult.stdout.trim();
  if (repositoryResult.exitCode !== 0 || !isAbsolute(repositoryPath)) {
    throw new Error("Cannot resolve the complete Git repository containing the runtime package.");
  }
  const repositoryRoot = await realpath(repositoryPath);
  const runtimeRelativePath = relative(repositoryRoot, runtimeRoot);
  if (
    runtimeRelativePath === ".." ||
    runtimeRelativePath.startsWith(`..${sep}`) ||
    isAbsolute(runtimeRelativePath)
  ) {
    throw new Error("Runtime package must be inside the tested repository.");
  }
  // Resolve the complete checkout before allocating private roots: a sibling
  // directory inside a monorepo is still inside the source repository.
  options.stateRoot = await canonicalizePrivateOperatorRoot({
    requestedPath: options.stateRoot,
    repositoryRoot,
    label: "--state-dir",
    create: false,
  });
  options.evidenceRoot = await canonicalizePrivateOperatorRoot({
    requestedPath: options.evidenceRoot,
    repositoryRoot,
    label: "--evidence-dir",
    create: false,
  });
  const stateToEvidence = relative(options.stateRoot, options.evidenceRoot);
  const evidenceToState = relative(options.evidenceRoot, options.stateRoot);
  if (
    stateToEvidence === "" ||
    (!stateToEvidence.startsWith("..") && !isAbsolute(stateToEvidence)) ||
    (!evidenceToState.startsWith("..") && !isAbsolute(evidenceToState))
  ) {
    throw new Error("--state-dir and --evidence-dir must be separate roots.");
  }
  // The collectable destination may sit inside the checkout; only minimized,
  // credential-checked terminal evidence is ever written there. Validate it
  // before exporting or executing source so a bad destination fails fast.
  const privateRoots = [options.stateRoot, options.evidenceRoot];
  const collectRoot = options.collectRoot
    ? await canonicalizeCollectableOperatorDestination({
        requestedPath: options.collectRoot,
        privateRoots,
        label: "--collect-dir",
      })
    : undefined;

  const revisionResult = await executor(
    prefixedCommand(
      localCommandPrefix,
      repositoryRoot,
      localEnvironment,
      "git",
      "rev-parse",
      "HEAD",
    ),
    false,
  );
  if (
    revisionResult.exitCode !== 0 ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(revisionResult.stdout.trim())
  ) {
    throw new Error("Cannot resolve tested commit.");
  }
  const revision = revisionResult.stdout.trim();
  const objectFormatResult = await executor(
    prefixedCommand(
      localCommandPrefix,
      repositoryRoot,
      localEnvironment,
      "git",
      "rev-parse",
      "--show-object-format",
    ),
    false,
  );
  const objectFormat = objectFormatResult.stdout.trim();
  if (objectFormatResult.exitCode !== 0 || (objectFormat !== "sha1" && objectFormat !== "sha256")) {
    throw new Error("Cannot resolve tested repository object format.");
  }
  const sourceTreeResult = await executor(
    prefixedCommand(
      localCommandPrefix,
      repositoryRoot,
      localEnvironment,
      "git",
      "rev-parse",
      "HEAD^{tree}",
    ),
    false,
  );
  const sourceTree = sourceTreeResult.stdout.trim();
  if (sourceTreeResult.exitCode !== 0 || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(sourceTree)) {
    throw new Error("Cannot resolve tested source tree.");
  }
  const statusBefore = await executor(
    prefixedCommand(
      localCommandPrefix,
      repositoryRoot,
      localEnvironment,
      "git",
      "-c",
      "core.fsmonitor=false",
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ),
    false,
  );
  if (statusBefore.exitCode !== 0) throw new Error("Cannot inspect source status.");
  if (statusBefore.stdout !== "") {
    throw new Error("Acceptance requires a clean source checkout so integrity can be proven.");
  }

  const acceptanceId = `acceptance-${now().toISOString().replace(/[:.]/gu, "-")}-${revision.slice(0, 12)}-${randomId().slice(0, 8)}`;
  const stateRootIdentity = await ensurePinnedPrivateOperatorRoot(options.stateRoot);
  const evidenceRootIdentity = await ensurePinnedPrivateOperatorRoot(options.evidenceRoot);
  const stateDirectory = join(options.stateRoot, acceptanceId);
  const evidenceDirectory = join(options.evidenceRoot, acceptanceId);
  await assertPrivateOperatorEvidenceDirectory(stateRootIdentity);
  await assertPrivateOperatorEvidenceDirectory(evidenceRootIdentity);
  const stateIdentity = await ensurePinnedPrivateOperatorRoot(stateDirectory);
  await assertPrivateOperatorEvidenceDirectory(stateRootIdentity);
  await assertPrivateOperatorEvidenceDirectory(evidenceRootIdentity);
  const evidenceIdentity = await ensurePinnedPrivateOperatorRoot(evidenceDirectory);

  let temporaryRoot: string | undefined;
  let manifestPublished = false;
  try {
    let phases: AcceptancePhaseResult[] = [];
    let unexpectedError: unknown;
    let fixtureRevision: string | undefined;
    let failedOfflineCommand: FailedOfflineCommand | undefined;
    let failedNetworkedPhase: AcceptanceNetworkedPhaseFailure | undefined;
    let checkLimitations: AcceptanceCheckLimitationRecord | undefined;
    const policyStatus = liveConfig?.model.profile.metadata.status ?? "unknown";
    const judgeStatus = options.judge ? liveConfig?.judge?.profile.metadata.status : undefined;
    try {
      const allocatedRoot = await mkdtemp(join(tmpdir(), "docsfab-acceptance-"));
      temporaryRoot = allocatedRoot;
      const exportRoot = join(allocatedRoot, "source");
      const workspaceRoot = resolve(exportRoot, runtimeRelativePath);
      const fixtureRoot = join(allocatedRoot, "fixture");
      await mkdir(exportRoot);
      const archivePath = join(allocatedRoot, "source.tar");
      const archive = await executor(
        prefixedCommand(
          localCommandPrefix,
          repositoryRoot,
          localEnvironment,
          "git",
          "archive",
          "--format=tar",
          `--output=${archivePath}`,
          revision,
        ),
        false,
      );
      if (archive.exitCode !== 0) throw new Error("Cannot export tested commit.");
      const extract = await executor(
        prefixedCommand(
          localCommandPrefix,
          repositoryRoot,
          localEnvironment,
          "tar",
          "-xf",
          archivePath,
          "-C",
          exportRoot,
        ),
        false,
      );
      if (extract.exitCode !== 0) throw new Error("Cannot extract tested commit.");
      await authenticateAcceptanceExport({
        workspaceRoot: exportRoot,
        expectedTree: sourceTree,
        objectFormat,
        commandPrefix: localCommandPrefix,
        environment: localEnvironment,
        execute: executor,
      });
      await cp(
        join(workspaceRoot, "test", "fixtures", "runtime-evaluation", "repositories", "ready"),
        fixtureRoot,
        { recursive: true },
      );

      const startedAt = now();
      const offlineNpmConfig = join(allocatedRoot, "offline.npmrc");
      const offlineHome = join(allocatedRoot, "home");
      const offlineTmp = join(allocatedRoot, "tmp");
      const offlineLogs = join(allocatedRoot, "npm-logs");
      await mkdir(offlineHome);
      await mkdir(offlineTmp);
      await mkdir(offlineLogs);
      await writeFile(offlineNpmConfig, "", { encoding: "utf8", mode: 0o600 });
      const offlineEnvironment = {
        ...offlineAcceptanceEnvironment(environment, stateDirectory),
        HOME: offlineHome,
        TMPDIR: offlineTmp,
        PI_OFFLINE: "1",
        NODE_NO_WARNINGS: "1",
        npm_config_userconfig: offlineNpmConfig,
        npm_config_logs_dir: offlineLogs,
        npm_config_cache:
          environment.npm_config_cache ??
          (environment.HOME ? join(environment.HOME, ".npm") : undefined),
      };
      const policyEnvironment = liveAcceptanceEnvironment(environment, stateDirectory, false);
      const judgeEnvironment = liveAcceptanceEnvironment(
        environment,
        stateDirectory,
        options.judge,
      );
      if (options.judge && !judgeStatus) {
        throw new Error("Judge acceptance requires JUDGE_ENABLED=true.");
      }
      const plan = createAcceptancePlan({
        repositoryRoot,
        workspaceRoot,
        fixtureRoot,
        stateDirectory,
        evidenceDirectory,
        acceptanceId,
        revision,
        sourceTree,
        live: options.live,
        judge: options.judge,
        judgeProfileStatus: judgeStatus ?? "unknown",
        now: startedAt,
        offlineEnvironment,
        localEnvironment,
        policyEnvironment,
        judgeEnvironment,
        offlineCommandPrefix: localCommandPrefix,
        localCommandPrefix,
        ...(isolation.hostRootOwner ? { hostRootOwner: isolation.hostRootOwner } : {}),
      });
      checkLimitations = {
        networkDenied: localCommandPrefix.length > 0,
        ...(isolation.hostRootOwner ? { hostRootOwner: isolation.hostRootOwner } : {}),
        excluded: plan.find((phase) => phase.id === "check")?.limitations ?? [],
      };
      for (const line of checkLimitationLines(checkLimitations)) log(line);
      const fixtureCommit = plan
        .find((phase) => phase.id === "live-fixture-readiness")
        ?.commands.at(-2);
      const judgeCommand = plan.find((phase) => phase.id === "judge-smoke")?.commands[0];
      phases = await executeAcceptancePlan(
        plan,
        async (command) => {
          if (command === judgeCommand) {
            try {
              const loaded = await safeRunRecords(stateIdentity, readRecordLeaves);
              if (
                !liveRecordSetIsExact(loaded.summaries, loaded.rawById, revision, fixtureRevision)
              ) {
                return { exitCode: 1, stdout: "" };
              }
            } catch {
              return { exitCode: 1, stdout: "" };
            }
          }
          const result = await executor(command, false);
          if (result.exitCode !== 0 && !failedOfflineCommand && !failedNetworkedPhase) {
            const phase = plan.find((candidate) => candidate.commands.includes(command));
            if (phase && !phase.networked) {
              failedOfflineCommand = {
                phase: phase.id,
                command,
                exitCode: result.exitCode,
                output: result.output ?? result.stdout,
              };
            } else if (phase) {
              // The model credential is in this command's environment, so only
              // its structured failure report is read, and its raw output is
              // dropped here. Summarizing never changes the phase result.
              try {
                failedNetworkedPhase = summarizeNetworkedPhaseFailure({
                  acceptanceId,
                  testedCommit: revision,
                  phase: phase.id,
                  exitCode: result.exitCode,
                  stdout: result.stdout,
                  stderr: result.stderr ?? "",
                  environment,
                  privateRoots,
                });
                log(networkedPhaseFailureLine(failedNetworkedPhase));
              } catch {
                log(`Networked phase failure: ${phase.id} could not be summarized.`);
              }
            }
          }
          if (result.exitCode === 0 && options.live && command === fixtureCommit) {
            const resolved = await executor(
              prefixedCommand(
                localCommandPrefix,
                fixtureRoot,
                localEnvironment,
                "git",
                "rev-parse",
                "HEAD",
              ),
              false,
            );
            const candidate = resolved.stdout.trim();
            if (resolved.exitCode !== 0 || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(candidate)) {
              return { exitCode: 1 };
            }
            fixtureRevision = candidate;
          }
          return result;
        },
        {
          commit: revision,
          modelProfileStatus: policyStatus,
          ...(judgeStatus ? { judgeProfileStatus: judgeStatus } : {}),
        },
      );
    } catch (error) {
      unexpectedError = error;
      phases.push({
        id: "setup",
        status: "failed",
        networked: false,
        commit: revision,
        modelProfileStatus: policyStatus,
        ...(judgeStatus ? { judgeProfileStatus: judgeStatus } : {}),
        durationMs: 0,
        reason: "acceptance setup or execution failed",
      });
    }

    let sourceUnchanged = false;
    try {
      const inspectSource = (...args: string[]) =>
        executor(
          prefixedCommand(localCommandPrefix, repositoryRoot, localEnvironment, "git", ...args),
          false,
        );
      const [headAfter, treeAfter, objectFormatAfter, statusAfter] = await Promise.all([
        inspectSource("rev-parse", "HEAD"),
        inspectSource("rev-parse", "HEAD^{tree}"),
        inspectSource("rev-parse", "--show-object-format"),
        inspectSource(
          "-c",
          "core.fsmonitor=false",
          "status",
          "--porcelain=v1",
          "--untracked-files=all",
        ),
      ]);
      sourceUnchanged =
        headAfter.exitCode === 0 &&
        headAfter.stdout.trim() === revision &&
        treeAfter.exitCode === 0 &&
        treeAfter.stdout.trim() === sourceTree &&
        objectFormatAfter.exitCode === 0 &&
        objectFormatAfter.stdout.trim() === objectFormat &&
        statusAfter.exitCode === 0 &&
        statusAfter.stdout === "";
    } catch {
      sourceUnchanged = false;
    }
    phases.push({
      id: "source-integrity",
      status: sourceUnchanged ? "passed" : "failed",
      networked: false,
      commit: revision,
      modelProfileStatus: policyStatus,
      durationMs: 0,
      ...(sourceUnchanged ? {} : { reason: "source checkout identity or status changed" }),
    });
    let cleanupPassed = true;
    if (temporaryRoot) {
      cleanupPassed = false;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          await remove(temporaryRoot, { recursive: true, force: true });
          cleanupPassed = true;
          break;
        } catch {
          // Retry once before publishing the terminal cleanup result.
        }
      }
    }
    phases.push({
      id: "workspace-cleanup",
      status: cleanupPassed ? "passed" : "failed",
      networked: false,
      commit: revision,
      modelProfileStatus: policyStatus,
      durationMs: 0,
      ...(cleanupPassed ? {} : { reason: "disposable workspace cleanup failed" }),
    });
    let records: AcceptanceRunRecordSummary[] = [];
    let rawRecords = new Map<string, Record<string, unknown>>();
    try {
      const loadedRecords = await safeRunRecords(stateIdentity, readRecordLeaves);
      records = loadedRecords.summaries;
      rawRecords = loadedRecords.rawById;
    } catch {
      unexpectedError = unexpectedError ?? new Error("Acceptance evidence failed.");
      phases.push({
        id: "evidence",
        status: "failed",
        networked: false,
        commit: revision,
        modelProfileStatus: policyStatus,
        ...(judgeStatus ? { judgeProfileStatus: judgeStatus } : {}),
        durationMs: 0,
        reason: "run-record evidence could not be minimized",
      });
    }
    if (
      options.live &&
      !liveRecordSetIsExact(records, rawRecords, revision, fixtureRevision) &&
      !phases.some((phase) => phase.id === "evidence")
    ) {
      unexpectedError = unexpectedError ?? new Error("Acceptance evidence failed.");
      phases.push({
        id: "evidence",
        status: "failed",
        networked: false,
        commit: revision,
        modelProfileStatus: policyStatus,
        ...(judgeStatus ? { judgeProfileStatus: judgeStatus } : {}),
        durationMs: 0,
        reason:
          "live acceptance records are not bound to the exact fixture, self revision, and reviewed scanner authorization",
      });
    }
    const judgeEvidence =
      options.judge && judgeStatus
        ? await safeJudgeEvidence(
            evidenceIdentity,
            acceptanceId,
            revision,
            judgeStatus,
            records,
            readEvidenceLeaf,
          )
        : undefined;
    if (
      options.judge &&
      judgeEvidence === undefined &&
      !phases.some((phase) => phase.id === "evidence")
    ) {
      unexpectedError = unexpectedError ?? new Error("Acceptance evidence failed.");
      phases.push({
        id: "evidence",
        status: "failed",
        networked: false,
        commit: revision,
        modelProfileStatus: policyStatus,
        ...(judgeStatus ? { judgeProfileStatus: judgeStatus } : {}),
        durationMs: 0,
        reason: "judge evidence was absent or not bound to this acceptance run",
      });
    }
    const passed =
      !unexpectedError &&
      phases.every((phase) => phase.status !== "failed") &&
      (!options.live || liveRecordSetIsExact(records, rawRecords, revision, fixtureRevision)) &&
      (!options.judge || judgeEvidence !== undefined);
    const manifest = {
      schemaVersion: 1,
      acceptanceId,
      testedCommit: revision,
      generatedAt: now().toISOString(),
      passed,
      gates: { live: options.live, judge: options.judge },
      modelProfiles: {
        policy: policyStatus,
        ...(judgeStatus ? { judge: judgeStatus } : {}),
      },
      phases,
      ...(checkLimitations ? { checkLimitations } : {}),
      records,
      ...(judgeEvidence ? { judge: judgeEvidence } : {}),
      rawRecordDirectory: "operator-selected acceptance directory",
      ...(unexpectedError ? { error: "acceptance runner failed" } : {}),
    };
    const manifestPath = join(evidenceDirectory, "manifest.json");
    await writeEvidence(evidenceIdentity, "manifest.json", manifest);
    manifestPublished = true;

    log(`Acceptance: ${passed ? "PASS" : "FAIL"}`);
    log(`Commit: ${revision}`);
    log(`Manifest: ${manifestPath}`);
    log(`Raw records: ${stateDirectory}`);
    // Emit the same minimized manifest to the collectable destination. Raw
    // records and private state never leave the private roots.
    const collectedManifestPath = collectRoot
      ? await publishCollectableOperatorEvidence({
          requestedPath: collectRoot,
          privateRoots,
          label: "--collect-dir",
          invocationId: acceptanceId,
          file: "manifest.json",
          value: manifest,
          environment,
        })
      : undefined;
    if (collectedManifestPath) log(`Collectable manifest: ${collectedManifestPath}`);
    if (failedOfflineCommand) {
      await keepFailedPhaseOutput({
        failure: failedOfflineCommand,
        acceptanceId,
        revision,
        environment,
        privateRoots,
        evidenceIdentity,
        evidenceDirectory,
        collectRoot,
        writeEvidence,
        log,
      });
    }
    if (failedNetworkedPhase) {
      await keepNetworkedPhaseFailure({
        summary: failedNetworkedPhase,
        acceptanceId,
        environment,
        privateRoots,
        evidenceIdentity,
        evidenceDirectory,
        collectRoot,
        writeEvidence,
        log,
      });
    }
    return {
      exitCode: passed ? 0 : 1,
      acceptanceId,
      manifestPath,
      stateDirectory,
      evidenceDirectory,
      passed,
      ...(collectedManifestPath ? { collectedManifestPath } : {}),
    };
  } finally {
    if (!manifestPublished && temporaryRoot) {
      await remove(temporaryRoot, { recursive: true, force: true }).catch(() => {});
    }
  }
}

runCliEntrypoint(import.meta.url, () => runAcceptanceCli(process.argv.slice(2)));
