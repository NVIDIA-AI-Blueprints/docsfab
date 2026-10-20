// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** One fresh, host-scoped live-agent task and its truthful retained export. */
import { createHash } from "node:crypto";
import { withTaskActivity } from "../activity/observer.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { constants, type Dirent } from "node:fs";
import { access, lstat, mkdir, mkdtemp, open, readFile, readdir, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { realpath } from "node:fs/promises";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import { loadPrivateDocsFabEnvironment } from "../config/private-environment.js";
import { loadConfig, type DocsFabConfig } from "../config/runtime-loader.js";
import { runSetupBootstrap } from "../setup/bootstrap.js";
import { resolveOperatorExecutionBinding } from "../model/operator-execution-binding.js";
import { createProviderConnectionFactory } from "../model/provider.js";
import { repositoryVirtualCwd } from "../harness/pi-session.js";
import { trackedHeadRegularFiles } from "../project-config-preflight.js";
import { canonicalJson } from "../content-ir/canonical.js";
import { formatLimitObservation, limit } from "../config/limits.js";
import {
  createRootTaskBudget,
  TaskBudgetError,
  type TaskBudgetEnvelope,
} from "../execution/task-budget.js";
import { loadLiveAgentCapabilities } from "./capabilities.js";
import { createPreparedLocalSourcePorts } from "./prepared-source-ports.js";
import {
  assembleLiveAgentHost,
  createLiveAgentPiSession,
  createLiveAgentResourceLoader,
} from "./host.js";
import {
  decodeLiveAgentTaskRequestV1,
  liveAgentTaskRequestSha256,
  type LiveAgentTaskRequestV1,
  type PreparedLocalSourceRefV1,
} from "./task-contract.js";
import {
  bindLiveAgentTaskCompletionV1,
  finalizeLiveAgentTaskCompletionV1,
  LIVE_AGENT_TASK_DECLARATION_KIND,
  type LiveAgentTaskAgentDeclarationV1,
} from "./task-finalization.js";
import {
  writeLiveAgentTaskExport,
  writeLiveAgentTaskActivity,
  LiveAgentTaskExportError,
  type LiveAgentTaskArtifactV1,
  type LiveAgentTaskEvidenceV1,
  type LiveAgentTaskExecutionStatusV1,
  type LiveAgentTaskResultV1,
} from "./task-export.js";
import {
  TaskActivityCaptureError,
  TaskActivityRecorder,
  type TaskActivitySealed,
} from "./task-activity.js";

const exec = promisify(execFile);

export interface LiveAgentTaskRunOptions {
  readonly repositoryPath: string;
  readonly taskFile: string;
  readonly resultDirectory: string;
  readonly allowWrite: boolean;
  /** Independently host-selected documentation grants; the task file cannot set these. */
  readonly documentationDirectories?: readonly string[];
  readonly taskGrantedFiles?: readonly string[];
  readonly environment?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
}

export interface LiveAgentTaskRunSummary {
  readonly schemaVersion: 1;
  readonly kind: "docsfab-live-agent-task-cli-result";
  readonly exportPath: string;
  readonly exportSha256: string;
  readonly executionStatus: LiveAgentTaskExecutionStatusV1;
  readonly agentDecision: LiveAgentTaskResultV1["agentDecision"];
}

export class LiveAgentTaskPrerequisiteError extends Error {
  constructor(
    readonly code: string,
    readonly nextAction: string,
  ) {
    super(`Live-agent task needs input (${code}). ${nextAction}`);
    this.name = "LiveAgentTaskPrerequisiteError";
  }
}

/** The v1 nonsecret task configuration is reconstructed from loaded host state. */
export function liveAgentTaskEffectiveConfiguration(
  config: DocsFabConfig,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const profileId = config.model.compositionId ?? null;
  const modelId = config.model.modelId;
  const values = { taskProviderTurns: limit("liveAgent.taskProviderTurns", { environment }).value };
  const configurationSha256 = sha(
    canonicalJson({
      schemaVersion: 1,
      kind: "docsfab-live-agent-effective-configuration",
      profileId,
      modelId,
      values,
    }),
  );
  return { profileId, modelId, configurationSha256, values };
}

function need(code: string, nextAction: string): never {
  throw new LiveAgentTaskPrerequisiteError(code, nextAction);
}

function sha(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function actualDestination(path: string): Promise<string> {
  const existing = await lstat(path).catch(() => null);
  if (existing) return realpath(path);
  const parent = dirname(path);
  if (parent === path) return path;
  return resolve(await actualDestination(parent), path.slice(parent.length + 1));
}

/** Keep disposable Pi state private and fresh; the result directory holds only the export. */
export async function createLiveAgentTaskPrivateDirectories(input: {
  readonly stateDirectory: string;
  readonly resultDirectory: string;
  readonly repositoryPath: string;
}): Promise<{ readonly sessionDirectory: string; readonly agentDirectory: string }> {
  const stateRoot = await actualDestination(resolve(input.stateDirectory));
  const resultRoot = await actualDestination(resolve(input.resultDirectory));
  const workspace = await realpath(input.repositoryPath);
  if (insideWorkspace(workspace, stateRoot))
    need(
      "task-state-inside-workspace",
      "Select a host-owned DOCSFAB_STATE_DIR outside the repository workspace.",
    );
  if (insideWorkspace(resultRoot, stateRoot) || insideWorkspace(stateRoot, resultRoot))
    need(
      "task-state-overlaps-result",
      "Keep DOCSFAB_STATE_DIR separate from the public task result directory.",
    );
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  const privateRoot = await mkdtemp(join(stateRoot, "live-agent-task-"));
  const sessionDirectory = join(privateRoot, "session");
  const agentDirectory = join(privateRoot, "agent");
  await mkdir(sessionDirectory, { mode: 0o700 });
  await mkdir(agentDirectory, { mode: 0o700 });
  return { sessionDirectory, agentDirectory };
}

function insideWorkspace(workspace: string, path: string): boolean {
  const suffix = relative(workspace, path);
  return (
    suffix === "" || (!suffix.startsWith(`..${sep}`) && suffix !== ".." && !isAbsolute(suffix))
  );
}

async function git(repositoryPath: string, args: readonly string[]): Promise<string> {
  const result = await exec("git", ["-C", repositoryPath, ...args], {
    encoding: "utf8",
    maxBuffer: limit("hostInvoker.gitOutputMaxBytes").value,
  });
  return result.stdout.trim();
}

interface RepositoryFileEntry {
  readonly path: string;
  readonly byteLength: number;
  readonly sha256: string;
}

export interface RepositoryFileSnapshot {
  readonly contentSha256: string;
  readonly files: readonly RepositoryFileEntry[];
}

async function readSnapshotRegularFile(path: string, parent: string): Promise<Buffer> {
  if ((await realpath(parent)) !== parent)
    throw new Error("The workspace parent directory changed during file inventory.");
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink())
    throw new Error("The workspace entry is not a supported regular file.");
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size ||
      (await realpath(parent)) !== parent
    )
      throw new Error("The workspace entry changed before its contents could be read.");
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const pathAfter = await lstat(path, { bigint: true });
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeNs !== opened.mtimeNs ||
      after.ctimeNs !== opened.ctimeNs ||
      pathAfter.isSymbolicLink() ||
      pathAfter.dev !== opened.dev ||
      pathAfter.ino !== opened.ino ||
      (await realpath(parent)) !== parent
    )
      throw new Error("The workspace entry changed while its contents were being read.");
    return bytes;
  } finally {
    await handle.close();
  }
}

/** Inventory the real checkout, including ignored files; never follow unsupported entries. */
async function snapshotWorkspaceFiles(
  repositoryPath: string,
  strict: boolean,
): Promise<RepositoryFileSnapshot & { readonly unsupported: readonly string[] }> {
  const files: RepositoryFileEntry[] = [];
  const unsupported: string[] = [];
  async function walk(directory: string, prefix: string): Promise<void> {
    let entries: Dirent<string>[];
    try {
      const metadata = await lstat(directory, { bigint: true });
      if (!metadata.isDirectory() || metadata.isSymbolicLink())
        throw new Error("The workspace directory is not a supported regular directory.");
      if ((await realpath(directory)) !== directory)
        throw new Error("The workspace directory changed while preparing its file inventory.");
      entries = await readdir(directory, { withFileTypes: true });
      const after = await lstat(directory, { bigint: true });
      if (
        !after.isDirectory() ||
        after.isSymbolicLink() ||
        after.dev !== metadata.dev ||
        after.ino !== metadata.ino ||
        (await realpath(directory)) !== directory
      )
        throw new Error("The workspace directory changed while its entries were inventoried.");
    } catch {
      if (strict)
        need(
          "baseline-entry-unreadable",
          "Restore a readable regular-file workspace before running this task.",
        );
      unsupported.push(prefix);
      return;
    }
    for (const entry of entries) {
      if (prefix === "" && entry.name === ".git") continue;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute, path);
      else if (entry.isFile()) {
        try {
          const bytes = await readSnapshotRegularFile(absolute, directory);
          files.push({ path, byteLength: bytes.byteLength, sha256: sha(bytes) });
        } catch {
          if (strict)
            need(
              "baseline-entry-unreadable",
              "Restore a readable regular-file workspace before running this task.",
            );
          unsupported.push(path);
        }
      } else if (strict)
        need(
          "baseline-entry-unsupported",
          "Remove symlinks and special files from the prepared workspace.",
        );
      else unsupported.push(path);
    }
  }
  await walk(await realpath(repositoryPath), "");
  files.sort((a, b) => Buffer.compare(Buffer.from(a.path, "utf8"), Buffer.from(b.path, "utf8")));
  return {
    contentSha256: sha(
      canonicalJson({ schemaVersion: 1, kind: "docsfab-repository-baseline", files }),
    ),
    files,
    unsupported,
  };
}

/** The admitted before-inventory and its canonical public content digest. */
export async function repositoryBaselineSnapshot(
  repositoryPath: string,
): Promise<RepositoryFileSnapshot> {
  const snapshot = await snapshotWorkspaceFiles(repositoryPath, true);
  return { contentSha256: snapshot.contentSha256, files: snapshot.files };
}

/** Hash the whole prepared checkout as bytes, including ignored and untracked files. */
export async function repositoryBaselineContentSha256(repositoryPath: string): Promise<string> {
  return (await repositoryBaselineSnapshot(repositoryPath)).contentSha256;
}

async function checkCheckout(
  request: LiveAgentTaskRequestV1,
  repositoryPath: string,
  write: boolean,
) {
  let head: string;
  try {
    head = await git(repositoryPath, ["rev-parse", "--verify", "HEAD"]);
  } catch {
    return need("repository-unavailable", "Select an isolated Git checkout with a readable HEAD.");
  }
  if (head !== request.baseline.repositoryRevision)
    need("baseline-mismatch", "Restore the task's exact baseline checkout before running it.");
  const baselineSnapshot = await repositoryBaselineSnapshot(repositoryPath);
  if (baselineSnapshot.contentSha256 !== request.baseline.contentSha256)
    need(
      "baseline-content-mismatch",
      "Restore the exact prepared workspace bytes before running this task.",
    );
  if (await git(repositoryPath, ["status", "--porcelain"]))
    need("baseline-not-clean", "Start from a clean isolated checkout before running this task.");
  if (write) {
    const metadata = resolve(repositoryPath, ".git");
    if (!(await lstat(metadata).catch(() => null))?.isDirectory())
      need("git-metadata-not-isolated", "Use a checkout with its own writable .git directory.");
    await access(metadata, constants.W_OK).catch(() =>
      need(
        "git-metadata-not-writable",
        "Grant write access to this checkout's private .git directory.",
      ),
    );
    const branch = await git(repositoryPath, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(
      () => "",
    );
    if (!branch || branch === "main" || branch === "master")
      need("task-branch-required", "Check out a writable task branch before running this task.");
  }
  return baselineSnapshot;
}

export async function taskDiff(
  repositoryPath: string,
  baselineSnapshot: RepositoryFileSnapshot,
  requestedPaths: readonly string[],
  requestedDirectoryRoots: readonly string[],
) {
  const after = await snapshotWorkspaceFiles(repositoryPath, false);
  const beforeFiles = new Map(baselineSnapshot.files.map((file) => [file.path, file]));
  const afterFiles = new Map(after.files.map((file) => [file.path, file]));
  const obscured = (path: string) =>
    after.unsupported.some(
      (unsupported) =>
        unsupported === "" || path === unsupported || path.startsWith(`${unsupported}/`),
    );
  const allChanged = new Set([
    ...baselineSnapshot.files
      .filter((file) => !obscured(file.path) && afterFiles.get(file.path)?.sha256 !== file.sha256)
      .map((file) => file.path),
    ...after.files.filter((file) => !beforeFiles.has(file.path)).map((file) => file.path),
  ]);
  const requested = new Set(requestedPaths);
  const inTaskScope = (path: string) =>
    requested.has(path) ||
    requestedDirectoryRoots.some((directory) => path.startsWith(`${directory}/`));
  const outside = [...allChanged, ...after.unsupported].filter((path) => !inTaskScope(path));
  const changed: LiveAgentTaskArtifactV1[] = [];
  for (const path of [...allChanged]
    .filter(inTaskScope)
    .sort((a, b) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")))) {
    const full = resolve(repositoryPath, path);
    if (!full.startsWith(`${repositoryPath}${sep}`))
      need("task-path-invalid", "Select repository-relative documentation paths.");
    const current = afterFiles.get(path);
    changed.push({
      artifactId: `artifact-${changed.length + 1}`,
      kind: current ? "document" : "patch",
      path,
      sha256: current?.sha256 ?? sha(Buffer.from(`deleted:${path}`, "utf8")),
      disposition: "partial",
    });
  }
  const serialized = JSON.stringify(changed.map(({ path, sha256 }) => ({ path, sha256 })));
  return {
    artifacts: changed,
    outside,
    unsupported: after.unsupported,
    diff: {
      status:
        outside.length || after.unsupported.length
          ? ("unavailable" as const)
          : changed.length
            ? ("non-empty" as const)
            : ("empty" as const),
      sha256: outside.length || after.unsupported.length ? null : sha(serialized),
    },
  };
}

function declarationFromText(
  text: string,
  allowedEvidenceIds: readonly string[],
  diffEvidenceId: string,
): LiveAgentTaskAgentDeclarationV1 | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const value = parsed as Record<string, unknown>;
    if (value.schemaVersion !== 1 || value.kind !== LIVE_AGENT_TASK_DECLARATION_KIND) return null;
    if (
      !Array.isArray(value.evidenceIds) ||
      !["change", "no-change", "needs-input", "refuse"].includes(String(value.decision))
    )
      return null;
    if (value.evidenceIds.some((id) => typeof id !== "string" || !allowedEvidenceIds.includes(id)))
      return null;
    if (value.decision === "no-change" && value.evidenceIds.every((id) => id === diffEvidenceId))
      return null;
    return value as unknown as LiveAgentTaskAgentDeclarationV1;
  } catch {
    return null;
  }
}

/** Sources keep their public IDs; generated evidence receives a distinct ID on collision. */
export function liveAgentTaskEvidenceIdentities(
  request: Pick<LiveAgentTaskRequestV1, "sources" | "requiredEvidence">,
  childRecordIds: readonly string[] = [],
): { readonly diffId: string; readonly childIds: ReadonlyMap<string, string> } {
  const occupied = new Set(request.sources.map((source) => source.sourceId));
  const requested = new Set(request.requiredEvidence);
  const allocate = (preferred: string): string => {
    if (!occupied.has(preferred)) {
      occupied.add(preferred);
      return preferred;
    }
    let suffix = 1;
    while (occupied.has(`${preferred}-${suffix}`) || requested.has(`${preferred}-${suffix}`))
      suffix += 1;
    const selected = `${preferred}-${suffix}`;
    occupied.add(selected);
    return selected;
  };
  const diffId = allocate("host-diff");
  const childIds = new Map<string, string>();
  for (const recordId of new Set(childRecordIds))
    childIds.set(recordId, allocate(`child-${recordId}`));
  return { diffId, childIds };
}

async function finish(input: {
  request: LiveAgentTaskRequestV1;
  resultDirectory: string;
  repositoryPath: string;
  executionStatus: LiveAgentTaskExecutionStatusV1;
  declaration?: LiveAgentTaskAgentDeclarationV1 | null;
  limitations: readonly string[];
  providerStarted?: boolean;
  childRecords?: readonly { readonly recordId: string; readonly recordSha256: string | null }[];
  requestedDirectoryRoots?: readonly string[];
  verifiedSources?: readonly PreparedLocalSourceRefV1[];
  baselineSnapshot?: RepositoryFileSnapshot;
  activity?: TaskActivitySealed;
}): Promise<LiveAgentTaskRunSummary> {
  let activitySha256: string | null = null;
  let activityStatus = input.activity?.status ?? "unavailable";
  const activityMissing = [...(input.activity?.missing ?? ["activity"])];
  if (input.activity) {
    try {
      activitySha256 = (
        await writeLiveAgentTaskActivity(
          input.resultDirectory,
          liveAgentTaskRequestSha256(input.request),
          input.activity.bytes,
        )
      ).activitySha256;
    } catch {
      activityStatus = "unavailable";
      activityMissing.push("activity-write-failed");
    }
  }
  const observed =
    input.providerStarted && input.baselineSnapshot
      ? await taskDiff(
          input.repositoryPath,
          input.baselineSnapshot,
          input.request.scope.requestedPaths,
          input.requestedDirectoryRoots ?? [],
        )
      : {
          artifacts: [],
          outside: [],
          unsupported: [],
          diff: { status: "unavailable" as const, sha256: null },
        };
  const declaration = input.declaration ?? {
    schemaVersion: 1 as const,
    kind: LIVE_AGENT_TASK_DECLARATION_KIND,
    decision:
      input.executionStatus === "needs-input" ? ("needs-input" as const) : ("unknown" as const),
    evidenceIds: [],
  };
  const nativeChildRecords = [...(input.childRecords ?? [])];
  const identities = liveAgentTaskEvidenceIdentities(
    input.request,
    nativeChildRecords.map((child) => child.recordId),
  );
  const availableEvidence = new Map<string, LiveAgentTaskEvidenceV1>();
  for (const source of input.verifiedSources ?? [])
    availableEvidence.set(source.sourceId, {
      evidenceId: source.sourceId,
      kind: "host-record",
      availability: "available",
      sha256: source.contentSha256,
    });
  for (const child of nativeChildRecords) {
    const evidenceId = identities.childIds.get(child.recordId)!;
    availableEvidence.set(evidenceId, {
      evidenceId,
      kind: "workflow-result",
      availability: child.recordSha256 ? "available" : "missing",
      sha256: child.recordSha256,
    });
  }
  if (input.providerStarted)
    availableEvidence.set(identities.diffId, {
      evidenceId: identities.diffId,
      kind: "diff",
      availability: observed.diff.sha256 ? "available" : "missing",
      sha256: observed.diff.sha256,
    });
  const evidence: LiveAgentTaskEvidenceV1[] = input.request.requiredEvidence.map(
    (id) =>
      availableEvidence.get(id) ?? {
        evidenceId: id,
        kind: "host-record",
        availability: "missing",
        sha256: null,
      },
  );
  for (const [id, entry] of availableEvidence)
    if (!input.request.requiredEvidence.includes(id)) evidence.push(entry);
  const outsideLimitations = observed.outside.length
    ? [
        "Workspace changes outside the requested task paths were detected; inspect the checkout before retrying.",
      ]
    : [];
  const unsupportedLimitations = observed.unsupported.length
    ? [
        "Workspace entries could not be read as regular files; the task diff is incomplete. Inspect the checkout before retrying.",
      ]
    : [];
  const completion = finalizeLiveAgentTaskCompletionV1({
    executionStatus:
      observed.outside.length || observed.unsupported.length ? "refused" : input.executionStatus,
    declaration,
    artifacts: observed.artifacts.map((artifact) => ({
      ...artifact,
      disposition:
        input.executionStatus === "completed" &&
        observed.outside.length === 0 &&
        observed.unsupported.length === 0
          ? ("complete" as const)
          : ("partial" as const),
    })),
    evidence,
    checks: [],
    diff: observed.diff,
    nativeChildRecords,
    usage: { status: "unavailable", inputTokens: null, outputTokens: null, totalTokens: null },
    trace: {
      status: activityStatus,
      activitySha256,
      childRecordIds: nativeChildRecords.map((child) => child.recordId),
      missing: [
        ...new Set([
          ...activityMissing,
          ...(nativeChildRecords.some((child) => child.recordSha256 === null)
            ? ["child-records"]
            : []),
        ]),
      ].sort(),
    },
    limitations: [
      ...input.limitations,
      ...outsideLimitations,
      ...unsupportedLimitations,
      ...(input.providerStarted && !input.baselineSnapshot
        ? ["The admitted workspace baseline was unavailable; the task diff is incomplete."]
        : []),
    ],
  });
  const result = bindLiveAgentTaskCompletionV1(input.request, completion);
  const retained = await writeLiveAgentTaskExport(input.resultDirectory, input.request, result);
  return {
    schemaVersion: 1,
    kind: "docsfab-live-agent-task-cli-result",
    exportPath: retained.path,
    exportSha256: retained.exportSha256,
    executionStatus: result.executionStatus,
    agentDecision: result.agentDecision,
  };
}

/** Run one task with no terminal, inherited Pi session, or setup interaction. */
export async function runLiveAgentTask(
  options: LiveAgentTaskRunOptions,
): Promise<LiveAgentTaskRunSummary> {
  const repositoryPath = resolve(options.repositoryPath);
  const resultDirectory = resolve(options.resultDirectory);
  const taskFile = resolve(options.taskFile);
  if (!isAbsolute(options.resultDirectory))
    need("absolute-path-required", "Use an absolute --result-dir path outside the workspace.");
  const workspace = await realpath(repositoryPath).catch(() =>
    need("repository-unavailable", "Select an isolated Git checkout with a readable directory."),
  );
  const resultRoot = await actualDestination(resultDirectory);
  if (insideWorkspace(workspace, resultRoot))
    need(
      "task-io-inside-workspace",
      "Keep the task result directory outside the repository workspace.",
    );
  const request = decodeLiveAgentTaskRequestV1(JSON.parse(await readFile(taskFile, "utf8")));
  const activityRecorder = new TaskActivityRecorder(request, options.environment);
  const initialEvidenceIds = liveAgentTaskEvidenceIdentities(request);
  const environment = loadPrivateDocsFabEnvironment(options.environment ?? process.env, {
    isolated: true,
  });
  if (environment.DOCSFAB_STATE_DIR) {
    const stateRoot = await actualDestination(resolve(environment.DOCSFAB_STATE_DIR));
    if (insideWorkspace(resultRoot, stateRoot) || insideWorkspace(stateRoot, resultRoot))
      need(
        "task-state-overlaps-result",
        "Keep DOCSFAB_STATE_DIR separate from the public task result directory.",
      );
  }
  const write = options.allowWrite && request.scope.writeClass === "documentation";
  const childRecordIds: string[] = [];
  const childRecords: { recordId: string; recordSha256: string | null }[] = [];
  let requestedDirectoryRoots: readonly string[] = [];
  let verifiedSources: readonly PreparedLocalSourceRefV1[] = [];
  let baselineSnapshot: RepositoryFileSnapshot | undefined;
  let resultAuthorized = true;
  let taskBudgetRefusal: TaskBudgetError | undefined;
  const taskBudgetLimitation = () => {
    if (!taskBudgetRefusal) return undefined;
    if (
      taskBudgetRefusal.code !== "budget-exhausted" ||
      taskBudgetRefusal.dimension !== "provider-turns"
    )
      return `Task budget ${taskBudgetRefusal.code}: ${taskBudgetRefusal.message}`;
    const bound = limit("liveAgent.taskProviderTurns", { environment });
    return formatLimitObservation(
      bound,
      bound.value - (taskBudgetRefusal.remaining ?? 0) + (taskBudgetRefusal.observed ?? 1),
    );
  };
  let finishAttempted = false;
  const finishWith = (
    status: LiveAgentTaskExecutionStatusV1,
    limitations: readonly string[],
    declaration?: LiveAgentTaskAgentDeclarationV1 | null,
    providerStarted = false,
  ) => {
    if (finishAttempted)
      throw new Error("Task result finalization cannot be attempted more than once.");
    finishAttempted = true;
    let activity: TaskActivitySealed | undefined;
    try {
      activityRecorder.reconcileNativeChildRecords(childRecords);
      activity = activityRecorder.seal();
    } catch (error) {
      if (error instanceof TaskActivityCaptureError) throw error;
      /* An unsealable capture is exported as unavailable. */
    }
    return finish({
      request,
      resultDirectory,
      repositoryPath,
      executionStatus: status,
      declaration,
      limitations,
      providerStarted,
      childRecords,
      requestedDirectoryRoots,
      verifiedSources,
      baselineSnapshot,
      activity,
    });
  };
  return withTaskActivity(
    { observer: activityRecorder, childScopeId: null, producerSessionId: null },
    async () => {
      try {
        if (!isAbsolute(options.taskFile) || !isAbsolute(options.resultDirectory))
          need("absolute-path-required", "Use absolute --task-file and --result-dir paths.");
        if (!(await stat(repositoryPath)).isDirectory())
          need("repository-unavailable", "Select an existing isolated repository directory.");
        if (insideWorkspace(workspace, await actualDestination(taskFile)))
          need(
            "task-io-inside-workspace",
            "Keep the task input and result directory outside the repository workspace.",
          );
        if (request.scope.writeClass === "documentation" && !options.allowWrite)
          need(
            "write-grant-required",
            "Pass --allow-write from a host that grants documentation writes.",
          );
        baselineSnapshot = await checkCheckout(request, repositoryPath, write);
        if (options.taskGrantedFiles?.length) {
          const tracked = await trackedHeadRegularFiles(repositoryPath, options.taskGrantedFiles);
          if (
            tracked.length !== options.taskGrantedFiles.length ||
            options.taskGrantedFiles.some((file) => !tracked.includes(file))
          )
            need(
              "documentation-file-grant-invalid",
              "Grant only existing regular documentation files tracked at HEAD.",
            );
        }
        const granted = (path: string) =>
          options.taskGrantedFiles?.includes(path) ||
          options.documentationDirectories?.some(
            (directory) =>
              path === directory || path.startsWith(`${directory.replace(/\/$/u, "")}/`),
          );
        if (request.scope.requestedPaths.some((path) => !granted(path)))
          need(
            "documentation-grant-missing",
            "Pass host-selected --docs-dir or --docs-file grants for every requested path.",
          );
        requestedDirectoryRoots = await Promise.all(
          request.scope.requestedPaths.map(async (path) => {
            const entry = await lstat(resolve(repositoryPath, path)).catch(() => null);
            if (entry?.isSymbolicLink())
              need(
                "documentation-path-symlink",
                "Select a regular documentation file or directory.",
              );
            if (options.documentationDirectories?.includes(path) && entry?.isFile())
              need(
                "documentation-directory-invalid",
                "Grant an actual documentation directory with --docs-dir.",
              );
            return options.documentationDirectories?.includes(path) || entry?.isDirectory()
              ? path
              : null;
          }),
        ).then((paths) => paths.filter((path): path is string => path !== null));
        if (!environment.DOCSFAB_CONFIG_ROOT || !environment.DOCSFAB_STATE_DIR)
          need(
            "explicit-host-configuration-required",
            "Set private DOCSFAB_CONFIG_ROOT and DOCSFAB_STATE_DIR for this task.",
          );
        if (
          insideWorkspace(workspace, await actualDestination(environment.DOCSFAB_CONFIG_ROOT)) ||
          insideWorkspace(workspace, await actualDestination(environment.DOCSFAB_STATE_DIR)) ||
          (environment.DOCSFAB_TASK_INPUT_DIR &&
            insideWorkspace(workspace, await actualDestination(environment.DOCSFAB_TASK_INPUT_DIR)))
        )
          need(
            "host-io-inside-workspace",
            "Keep host configuration, state, and prepared sources outside the repository workspace.",
          );
        const readiness = await runSetupBootstrap({ environment, purpose: "startup-check" });
        if (readiness.status !== "ready")
          need("model-configuration-incomplete", readiness.nextCommand);
        const config = loadConfig(environment);
        const configuredStateRoot = await actualDestination(config.stateDirectory);
        if (insideWorkspace(workspace, configuredStateRoot))
          need(
            "task-state-inside-workspace",
            "Select a host-owned DOCSFAB_STATE_DIR outside the repository workspace.",
          );
        if (
          insideWorkspace(resultRoot, configuredStateRoot) ||
          insideWorkspace(configuredStateRoot, resultRoot)
        ) {
          resultAuthorized = false;
          need(
            "task-state-overlaps-result",
            "Keep DOCSFAB_STATE_DIR separate from the public task result directory.",
          );
        }
        if (
          canonicalJson(request.effectiveConfig) !==
          canonicalJson(liveAgentTaskEffectiveConfiguration(config, environment))
        )
          need(
            "effective-configuration-mismatch",
            "Prepare the task with the host's current effective model profile and settings.",
          );
        const capabilities = await loadLiveAgentCapabilities(config);
        const inputDirectory = environment.DOCSFAB_TASK_INPUT_DIR;
        if (request.sources.length && (!inputDirectory || !isAbsolute(inputDirectory)))
          need(
            "prepared-sources-missing",
            "Mount a private task input directory and set DOCSFAB_TASK_INPUT_DIR.",
          );
        const sourcePorts = request.sources.length
          ? await createPreparedLocalSourcePorts({
              manifest: JSON.parse(
                await readFile(join(inputDirectory!, "prepared-sources.json"), "utf8"),
              ),
              refs: request.sources,
              sourcesRoot: join(inputDirectory!, "prepared-sources"),
            })
          : undefined;
        if (sourcePorts) verifiedSources = request.sources;
        const taskSourceReader = sourcePorts?.withTrackedSourceReader
          ? await sourcePorts.withTrackedSourceReader(async (reader) => reader)
          : undefined;
        const { sessionDirectory, agentDirectory } = await createLiveAgentTaskPrivateDirectories({
          stateDirectory: config.stateDirectory,
          resultDirectory,
          repositoryPath,
        });
        const sessionManager = SessionManager.create(
          repositoryVirtualCwd(repositoryPath),
          sessionDirectory,
        );
        const taskBudgetEnvelope: TaskBudgetEnvelope = {
          "provider-turns": limit("liveAgent.taskProviderTurns", { environment }).value,
          "tool-calls": 0,
          "input-tokens": 0,
          "output-tokens": 0,
          "source-bytes": 0,
          "elapsed-ms": 0,
          "cost-microusd": 0,
        };
        const taskBudget = createRootTaskBudget({
          envelope: taskBudgetEnvelope,
          signal: options.signal,
        });
        const host = await assembleLiveAgentHost({
          repositoryPath,
          allowWrite: write,
          environment,
          config,
          capabilities,
          sessionDirectory,
          sessionManager,
          documentationDirectories: options.documentationDirectories ?? [],
          taskGrantedFiles: options.taskGrantedFiles ?? [],
          taskRequestedPaths: request.scope.requestedPaths,
          taskDirectoryRoots: requestedDirectoryRoots,
          taskBudget,
          onTaskBudgetRefusal: (error) => {
            taskBudgetRefusal ??= error;
          },
          onTaskChildRecord: (record, recordSha256) => {
            childRecordIds.push(record.id);
            childRecords.push({ recordId: record.id, recordSha256 });
          },
          ...(sourcePorts
            ? {
                sourcePorts,
                ...(taskSourceReader ? { taskSourceReader } : {}),
                sourcePaths: request.sources.flatMap((source) =>
                  source.paths.map((path) => `${source.sourceId}/${path}`),
                ),
              }
            : {}),
          onNotice: () => undefined,
          writeError: () => undefined,
        });
        const resourceLoader = await createLiveAgentResourceLoader({
          repositoryPath,
          agentDir: agentDirectory,
          noninteractiveTask: true,
          host: {
            systemPrompt: `${host.systemPrompt}\nThis is one noninteractive task. The user request is the next message. Do not seek terminal approval, use shell commands, publish, or broaden requested paths. End with one JSON object only: {"schemaVersion":1,"kind":"${LIVE_AGENT_TASK_DECLARATION_KIND}","decision":"change|no-change|needs-input|refuse","evidenceIds":[]}. Prepared sources keep their exact source IDs. Use evidence ID "${initialEvidenceIds.diffId}" only for the host-observed workspace diff; an empty diff alone does not prove no change was needed. A question must use needs-input.`,
          },
        });
        const binding = await resolveOperatorExecutionBinding({
          model: config.model,
          workflowId: "live-agent-turn",
          environment,
        });
        const rootProducerSessionId = activityRecorder.reserveSession();
        const providerActivity = activityRecorder.attachProviderConnection(
          binding.profile.routeId,
          binding.profile.transport,
          binding.profile.modelId,
          { producerSessionId: rootProducerSessionId },
        );
        const connection = await createProviderConnectionFactory({
          routeId: binding.profile.routeId,
          transport: binding.profile.transport,
        }).create(
          { profile: binding.profile, credential: binding.credential },
          {
            evidenceIdentity: { repositoryRevision: request.baseline.repositoryRevision },
            aggregatePolicy: { kind: "absent" },
            aggregatePhysicalRequestLimit: { kind: "absent" },
            taskBudget,
            onTaskBudgetRefusal: (error) => {
              taskBudgetRefusal ??= error;
            },
            taskActivityObserver: providerActivity,
          },
        );
        const session = await createLiveAgentPiSession({
          repositoryPath,
          modelRuntime: connection.runtime,
          model: connection.model,
          resourceLoader,
          sessionManager,
          host,
        });
        let lastText = "";
        const observeActivity = activityRecorder.attachPiSession(
          host.tools.filter((name) => !host.excludeTools.includes(name)),
          { producerSessionId: rootProducerSessionId },
        );
        const unsubscribe = session.subscribe((event) => {
          observeActivity(event);
          if (event.type === "message_end" && event.message.role === "assistant") {
            lastText = event.message.content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("");
          }
        });
        let abortPromise: Promise<void> | undefined;
        const abort = () => {
          abortPromise ??= session.abort();
        };
        options.signal?.addEventListener("abort", abort, { once: true });
        let terminal: {
          status: LiveAgentTaskExecutionStatusV1;
          limitations: readonly string[];
          declaration?: LiveAgentTaskAgentDeclarationV1 | null;
          providerStarted: boolean;
        };
        try {
          if (options.signal?.aborted) {
            terminal = {
              status: "cancelled",
              limitations: ["Task cancelled before the provider turn."],
              providerStarted: false,
            };
          } else {
            host.terminalOptions.onUserTurn?.(request.prompt.text);
            await withTaskActivity(
              {
                observer: activityRecorder,
                childScopeId: null,
                producerSessionId: rootProducerSessionId,
              },
              () => session.prompt(request.prompt.text),
            );
            if (options.signal?.aborted) {
              await abortPromise;
              terminal = {
                status: "cancelled",
                limitations: ["Task cancelled; partial workspace artifacts were retained."],
                declaration: null,
                providerStarted: true,
              };
            } else {
              host.terminalOptions.turnNotices?.();
              const budgetLimitation = taskBudgetLimitation();
              if (budgetLimitation) {
                terminal = {
                  status: "partial",
                  limitations: [budgetLimitation],
                  declaration: null,
                  providerStarted: true,
                };
              } else {
                const evidenceIds = liveAgentTaskEvidenceIdentities(request, childRecordIds);
                const declaration = declarationFromText(
                  lastText,
                  [
                    ...request.requiredEvidence,
                    ...request.sources.map((source) => source.sourceId),
                    evidenceIds.diffId,
                    ...evidenceIds.childIds.values(),
                  ],
                  evidenceIds.diffId,
                );
                terminal = {
                  status: declaration
                    ? declaration.decision === "needs-input"
                      ? "needs-input"
                      : declaration.decision === "refuse"
                        ? "refused"
                        : "completed"
                    : "partial",
                  limitations: declaration
                    ? []
                    : ["The agent did not emit a valid typed completion declaration."],
                  declaration,
                  providerStarted: true,
                };
              }
            }
          }
        } catch {
          abort();
          await abortPromise?.catch(() => undefined);
          const budgetLimitation = taskBudgetLimitation();
          terminal = {
            status: options.signal?.aborted ? "cancelled" : "partial",
            limitations: budgetLimitation
              ? [budgetLimitation]
              : [
                  "The provider turn ended before typed completion; partial workspace artifacts were retained.",
                ],
            declaration: null,
            providerStarted: true,
          };
        } finally {
          options.signal?.removeEventListener("abort", abort);
          unsubscribe();
          session.dispose();
          observeActivity.dispose();
        }
        return finishWith(
          terminal.status,
          terminal.limitations,
          terminal.declaration,
          terminal.providerStarted,
        );
      } catch (error) {
        if (finishAttempted) throw error;
        if (!resultAuthorized) throw error;
        if (error instanceof LiveAgentTaskExportError) throw error;
        if (error instanceof LiveAgentTaskPrerequisiteError)
          return finishWith("needs-input", [`${error.code}: ${error.nextAction}`]);
        return finishWith("refused", [
          "A task prerequisite could not be validated before provider execution.",
        ]);
      }
    },
  );
}
