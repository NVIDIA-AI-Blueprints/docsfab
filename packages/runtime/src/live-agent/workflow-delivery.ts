// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { currentTaskActivity } from "../activity/observer.js";
import { canonicalJson } from "../content-ir/canonical.js";
import { contextPath } from "../cli/options.js";
import { assertWorkflowActive, WORKFLOW_CANCELLED } from "../execution/cancellation.js";
import { resolve } from "node:path";
import {
  loadSavedRunEditorialDecodeOptions,
  loadSavedRunPublicationDecodeOptions,
} from "../cli/run/editorial-replay.js";
import { loadFirstPassChoiceContinuation } from "../cli/run/first-pass-choice-continuation.js";
import { FileRunStore } from "../records/file-store.js";
import { decodeSavedRunRecord } from "../records/saved-run-record.js";
import {
  decodeCheckoutPersistenceOutcome,
  type CheckoutPersistenceErrorCode,
  type CheckoutPersistenceOutcomeV1,
} from "../records/checkout-persistence.js";
import { runRecordMaxBytes } from "../records/run-record-limit.js";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  loadVerifiedCheckoutRun,
  loadVerifiedPublicationRun,
  type VerifiedPublicationRun,
} from "../delivery/preflight.js";
import { ExecFileGitPublisherCommandRunner, GitPublisherError } from "../delivery/git-publisher.js";
import {
  DeliveryWorktreeError,
  LocalUserPublicationPreflightError,
} from "../delivery/contracts.js";
import { gitEnvironment } from "../init/shared.js";
import {
  canonicalRepositoryPath,
  editorialInputAskSlots,
  listOpenEditorialRuns,
  planOperatorInputResume,
  type OperatorInputResumePlanV1,
} from "../inputs/operator-input-fill.js";
import { shipSucceededWrite } from "../operator/delivery-orchestrator.js";
import { LocalUserGitLabPublisherError } from "../delivery/publisher.js";
import { SCM_DELIVERY_FAILURE_CODES } from "../delivery/receipt.js";
import { isExportExcluded } from "../repository/workspace/export-exclusion.js";
import { configuredCredentialSpans } from "../security/configured-credentials.js";
import type { RunRecord } from "../records/contracts.js";
import { TASK_BRANCH_FAILURES } from "./branch-preparation.js";
import { DocumentationScope, DOCUMENTATION_SCOPE_FAILURE } from "./documentation-scope.js";

export const LIVE_DELIVERY_FAILURES = {
  documentationScope: DOCUMENTATION_SCOPE_FAILURE,
  write: "Workflow writes are not enabled. Restart with --allow-write to authorize them.",
  repository:
    "The saved workflow belongs to another repository or revision. The patch was retained but not applied.",
  conflict:
    "The saved patch conflicts with current checkout files. No patch was applied; existing changes and the saved patch were retained.",
  patch:
    "The saved patch could not be verified for safe checkout application. It was retained without changing checkout files.",
  apply:
    "Checkout application could not be verified. Inspect git diff and the saved run before retrying; no rollback or publication was attempted.",
  retention:
    "The checkout outcome could not be saved on the run. Inspect the saved run and checkout before retrying.",
  publish:
    "Draft MR publication failed. The local files and saved patch remain available; inspect docsfab ship for the delivery diagnostic.",
} as const;

export interface LiveWorkflowPersistence {
  status: "applied" | "already-applied" | "not-needed" | "failed";
  error?: string;
}
export type LiveWorkflowRun = RunRecord & { livePersistence?: LiveWorkflowPersistence };

/** A cached reply reports the recorded checkout; it performs no new application. */
export function savedLiveWorkflowPersistence(
  record: Pick<RunRecord, "status" | "changes" | "checkoutPersistence">,
): LiveWorkflowPersistence {
  if (record.checkoutPersistence === undefined) {
    if (
      record.status === "succeeded" &&
      record.changes !== undefined &&
      (record.changes === null ||
        !Array.isArray(record.changes.files) ||
        record.changes.files.length > 0)
    ) {
      return {
        status: "failed",
        error:
          "The saved successor's checkout outcome is unverified because its result is unavailable. Inspect the saved patch and current checkout before starting a new request.",
      };
    }
    return { status: "not-needed" };
  }
  const saved = decodeCheckoutPersistenceOutcome(record.checkoutPersistence);
  if (saved.outcome !== "failed") return { status: saved.outcome };
  const messages: Record<CheckoutPersistenceErrorCode, string> = {
    "run-record-contract-gap":
      "The saved checkout result could not be verified (run-record-contract-gap). Inspect the saved run and retained patch before starting a new request.",
    "write-disabled": LIVE_DELIVERY_FAILURES.write,
    "repository-mismatch": LIVE_DELIVERY_FAILURES.repository,
    "patch-conflict": LIVE_DELIVERY_FAILURES.conflict,
    "patch-invalid": LIVE_DELIVERY_FAILURES.patch,
    "apply-unverified": LIVE_DELIVERY_FAILURES.apply,
    cancelled: WORKFLOW_CANCELLED,
    "retention-failed": LIVE_DELIVERY_FAILURES.retention,
    "branch-preparation-failed":
      "The task branch could not be prepared (branch-preparation-failed). Inspect the saved run and checkout before starting a new request.",
  };
  return { status: "failed", error: messages[saved.errorCode] };
}

export type LiveAgentEditorialInputAskTurn =
  | {
      readonly kind: "routing-turn";
      /**
       * A stopped run's named input is still open, but this reply cannot fill
       * it. The host keeps direct changes closed for this ordinary turn.
       */
      readonly openInputAsk?: true;
    }
  | { readonly kind: "input-ask-resume"; readonly plan: OperatorInputResumePlanV1 };

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function retainedPublicationGuidance(line: string, runId: string): string | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    record.kind !== "docsfab-local-user-gitlab-publication-result" ||
    record.status !== "failed" ||
    record.schemaVersion !== 1 ||
    record.runId !== runId ||
    typeof record.planSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(record.planSha256)
  )
    return undefined;
  const safePath = (candidate: unknown): candidate is string =>
    typeof candidate === "string" &&
    candidate.length > 0 &&
    !/[\x00-\x1f\x7f]/u.test(candidate) &&
    configuredCredentialSpans(candidate).length === 0;
  const worktrees = [
    ...new Set([
      ...(safePath(record.preservedWorktree) ? [record.preservedWorktree] : []),
      ...(Array.isArray(record.preservedWorktrees)
        ? record.preservedWorktrees.filter(safePath)
        : []),
    ]),
  ];
  const branch =
    typeof record.preservedBranch === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(record.preservedBranch) &&
    !record.preservedBranch.includes("..") &&
    configuredCredentialSpans(record.preservedBranch).length === 0
      ? record.preservedBranch
      : undefined;
  const command = record.cleanupPreviewCommand;
  const commandPrefix = `docsfab runs delete ${runId} --state-dir `;
  const shellWord = String.raw`(?:[A-Za-z0-9_./:@+-]+|'(?:[^']|'"'"')*')`;
  const previewTail =
    typeof command === "string" && command.startsWith(commandPrefix)
      ? command.slice(commandPrefix.length)
      : undefined;
  const preview =
    typeof command === "string" &&
    typeof previewTail === "string" &&
    new RegExp(`^${shellWord} --delivery-root ${shellWord} --receipt-root ${shellWord}$`, "u").test(
      previewTail,
    ) &&
    configuredCredentialSpans(command).length === 0
      ? command
      : undefined;
  if (worktrees.length === 0 && !branch && !preview) return undefined;
  return [
    "Preserved publication resources are available for inspection.",
    ...worktrees.map((path) => `Preserved worktree: ${path}`),
    ...(branch ? [`Preserved branch: ${branch}`] : []),
    ...(preview
      ? [`To preview deletion of this run and its preserved delivery state, run: ${preview}`]
      : []),
  ].join(" ");
}

/**
 * A reply becomes a fill only when it can fill a slot of the one open
 * `needs-input` run; any other reply is an ordinary turn, so the conversation
 * never sticks on an unfillable slot.
 */
export async function planLiveAgentEditorialInputAskTurn(input: {
  readonly stateDirectory: string;
  readonly repositoryPath: string;
  readonly revision: string;
  readonly replyText: string;
  readonly attachPaths?: readonly string[];
  readonly currentWorkspaceSnapshotSha256?: string;
  readonly now?: () => Date;
}): Promise<LiveAgentEditorialInputAskTurn> {
  const open = (await listOpenEditorialRuns(input.stateDirectory)).filter(
    (item) =>
      canonicalRepositoryPath(item.repositoryPath) ===
      canonicalRepositoryPath(input.repositoryPath),
  );
  if (open.length === 0) return { kind: "routing-turn" };
  const attachPaths = input.attachPaths ?? [];
  // A conversation reply cannot name which of several open runs it fills.
  if (open.length > 1 && attachPaths.length === 0) {
    return { kind: "routing-turn", openInputAsk: true };
  }
  const slots = open[0]!.slots;
  // A conversation has no --attach, so a reply that is exactly the
  // repository-relative path of a regular file fills an open file slot.
  const fileReply =
    open.length === 1 && slots.some((slot) => slot.fillKind === "path")
      ? await repositoryFileReply(input.replyText, input.repositoryPath)
      : undefined;
  const textFill =
    !fileReply &&
    input.replyText.trim() !== "" &&
    slots.some((slot) => slot.fillKind === "text" || slot.fillKind === "request");
  if (!fileReply && !textFill && attachPaths.length === 0) {
    return { kind: "routing-turn", openInputAsk: true };
  }
  const plan = await planOperatorInputResume({
    stateDirectory: input.stateDirectory,
    repositoryPath: input.repositoryPath,
    revision: input.revision,
    attachPaths: [...attachPaths, ...(fileReply ? [fileReply] : [])],
    ...(textFill ? { replyText: input.replyText } : {}),
    ...(input.currentWorkspaceSnapshotSha256
      ? { currentWorkspaceSnapshotSha256: input.currentWorkspaceSnapshotSha256 }
      : {}),
    ...(input.now ? { now: input.now } : {}),
  });
  return { kind: "input-ask-resume", plan };
}

/** The reply as a repository-relative regular-file path, or `undefined`. Never throws. */
async function repositoryFileReply(
  replyText: string,
  repositoryPath: string,
): Promise<string | undefined> {
  const candidate = replyText.trim();
  if (!candidate || /\s/u.test(candidate)) return undefined;
  try {
    contextPath(candidate, "InputAsk file reply");
    const info = await lstat(resolve(repositoryPath, candidate));
    return info.isFile() && !info.isSymbolicLink() ? candidate : undefined;
  } catch {
    return undefined;
  }
}

/** Reconstruct only content-free host diagnostics; never forward command output. */
export function livePublicationFailure(error: unknown): string | undefined {
  if (
    error instanceof LocalUserGitLabPublisherError &&
    [
      ...SCM_DELIVERY_FAILURE_CODES,
      "authorization-expired",
      "invalid-input",
      "receipt-conflict",
    ].includes(error.code)
  )
    return new LocalUserGitLabPublisherError(error.code).message;
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  for (const Constructor of [
    LocalUserPublicationPreflightError,
    DeliveryWorktreeError,
    GitPublisherError,
  ]) {
    const code = /failed \(([a-z-]+)\)/u.exec(message)?.[1];
    if (!code) continue;
    const safe = new Constructor(code as never);
    if (safe.message.includes("undefined")) continue;
    if (
      Constructor === GitPublisherError &&
      ![
        "missing-identity",
        "identity-drift",
        "unsafe-configuration",
        "refused-configuration",
        "local-branch-conflict",
        "remote-branch-conflict",
        "commit-failed",
        "commit-drift",
        "push-failed",
      ].includes(code)
    )
      continue;
    if (
      message === safe.message ||
      (error instanceof Constructor && message.startsWith(safe.message))
    )
      return safe.message;
  }
  return undefined;
}

function checkoutFailureCode(error?: string): CheckoutPersistenceErrorCode {
  if (error === WORKFLOW_CANCELLED) return "cancelled";
  if (error === LIVE_DELIVERY_FAILURES.write) return "write-disabled";
  if (error === LIVE_DELIVERY_FAILURES.repository) return "repository-mismatch";
  if (error === LIVE_DELIVERY_FAILURES.conflict) return "patch-conflict";
  if (error === LIVE_DELIVERY_FAILURES.apply) return "apply-unverified";
  if (error === LIVE_DELIVERY_FAILURES.retention) return "retention-failed";
  if (Object.values(TASK_BRANCH_FAILURES).some((message) => message === error))
    return "branch-preparation-failed";
  if (error?.includes("(run-record-contract-gap)")) return "run-record-contract-gap";
  return "patch-invalid";
}
const SAFE_GIT = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "diff.external=",
  "-c",
  "core.attributesFile=/dev/null",
];

export class LiveWorkflowDelivery {
  private readonly editorialInputAskByRunId = new Map<string, readonly string[]>();

  constructor(
    private readonly options: {
      repositoryPath: string;
      stateDirectory: string;
      allowWrite: boolean;
      documentationScope?: DocumentationScope;
      confirmPublication: (message: string) => Promise<boolean>;
      loadRun?: typeof loadVerifiedPublicationRun;
      ship?: typeof shipSucceededWrite;
      /** Exact run store; injection permits a real failing private-file write in tests. */
      runStore?: FileRunStore;
      /** Host-held gate invoked before a saved patch is applied to the checkout. */
      beforeMutation?: () => Promise<void>;
    },
  ) {}

  rememberEditorialInputAsk(record: unknown): void {
    if (!record || typeof record !== "object" || Array.isArray(record)) return;
    const runId = (record as { id?: unknown }).id;
    if (typeof runId !== "string" || !ID.test(runId)) return;
    const inputIds = editorialInputAskSlots(record).map((slot) => slot.inputId);
    if (inputIds.length === 0) {
      this.editorialInputAskByRunId.delete(runId);
      return;
    }
    this.editorialInputAskByRunId.set(runId, Object.freeze(inputIds));
  }

  inputAskInputIdsForRun(runId: string): readonly string[] | undefined {
    return this.editorialInputAskByRunId.get(runId);
  }

  private async load(
    runId: string,
    purpose: "publication" | "checkout" = "publication",
  ): Promise<VerifiedPublicationRun> {
    if (!ID.test(runId) || runId.includes("..")) throw new Error(LIVE_DELIVERY_FAILURES.patch);
    // Reconstruct the saved workflow's host evidence before the strict delivery
    // decoder checks its branch coverage and editorial outcome.
    const editorialOptions = this.options.loadRun
      ? undefined
      : await loadSavedRunEditorialDecodeOptions(
          (await new FileRunStore(this.options.stateDirectory).get(runId)) as RunRecord,
          this.options.stateDirectory,
        );
    const loadRun =
      this.options.loadRun ??
      (purpose === "checkout" ? loadVerifiedCheckoutRun : loadVerifiedPublicationRun);
    const run = await loadRun(
      resolve(this.options.stateDirectory, `${runId}.json`),
      runId,
      editorialOptions,
    );
    if ((await realpath(run.sourcePath)) !== (await realpath(this.options.repositoryPath)))
      throw new Error(LIVE_DELIVERY_FAILURES.repository);
    for (const file of run.changedFiles) {
      this.options.documentationScope?.assert(file.path);
      if (file.previousPath) this.options.documentationScope?.assert(file.previousPath);
    }
    return run;
  }

  private async git(args: string[], stdin?: Uint8Array) {
    return new ExecFileGitPublisherCommandRunner().run(
      "git",
      [...SAFE_GIT, ...args],
      this.options.repositoryPath,
      {
        env: gitEnvironment(),
        ...(stdin ? { stdin } : {}),
        timeoutMs: 30_000,
        maxOutputBytes: 2 * 1024 * 1024,
      },
    );
  }

  async persist(record: RunRecord, signal?: AbortSignal): Promise<LiveWorkflowPersistence> {
    this.rememberEditorialInputAsk(record);
    const activity = currentTaskActivity();
    let patchSha256: string | null = null;
    let changeSummarySha256: string | null = null;
    const observed = (result: LiveWorkflowPersistence): LiveWorkflowPersistence => {
      if (activity?.childScopeId)
        activity.observer.observeHostPatch({
          childScopeId: activity.childScopeId,
          status: result.status,
          patchSha256,
          changeSummarySha256,
        });
      return result;
    };
    if (signal?.aborted) return observed({ status: "failed", error: WORKFLOW_CANCELLED });
    if (record.status !== "succeeded" || !record.changes?.files.length)
      return observed({ status: "not-needed" });
    const store = this.options.runStore ?? new FileRunStore(this.options.stateDirectory);
    let saved: Awaited<ReturnType<FileRunStore["getWithDigest"]>>;
    try {
      saved = await store.getWithDigest(record.id, { maxBytes: runRecordMaxBytes().value });
      const current = decodeSavedRunRecord(saved.record as never, record.id);
      // The caller must be the workflow result that this exact saved leaf holds.
      // A prior checkout result is the only permitted difference on a retry.
      const { checkoutPersistence: _prior, ...workflowRecord } = current;
      const { checkoutPersistence: _suppliedPrior, ...suppliedWorkflowRecord } = record;
      if (canonicalJson(workflowRecord) !== canonicalJson(suppliedWorkflowRecord))
        return observed({ status: "failed", error: LIVE_DELIVERY_FAILURES.retention });
      if (current.firstPassChoices !== undefined) {
        try {
          // The saved attribution is not authority. Reuse the original source,
          // revision and private current-owner admission before any mutation.
          await loadFirstPassChoiceContinuation({
            request: {
              workflow: current.workflow,
              repositoryPath: this.options.repositoryPath,
              revision: current.repository.revision,
              instruction: current.instruction,
              runId: current.id,
              firstPassChoices: current.firstPassChoices,
              allowWrite: this.options.allowWrite,
              releaseGate: false,
              patchOnly: true,
              verbose: false,
              json: false,
              showScan: false,
            },
            config: { stateDirectory: this.options.stateDirectory },
          });
        } catch {
          return observed({ status: "failed", error: LIVE_DELIVERY_FAILURES.patch });
        }
      }
    } catch {
      return observed({ status: "failed", error: LIVE_DELIVERY_FAILURES.retention });
    }
    const result = await this.applyToCheckout(
      record,
      saved.sha256,
      signal,
      activity?.childScopeId
        ? async (patch, files) => {
            patchSha256 = createHash("sha256").update(patch).digest("hex");
            changeSummarySha256 = await this.observedChangeSummary(files);
          }
        : undefined,
    );
    const outcome: CheckoutPersistenceOutcomeV1 =
      result.status === "failed"
        ? {
            schemaVersion: 1,
            kind: "checkout-persistence",
            outcome: "failed",
            errorCode: checkoutFailureCode(result.error),
          }
        : { schemaVersion: 1, kind: "checkout-persistence", outcome: result.status };
    try {
      await store.replaceIfDigest(
        record.id,
        saved.sha256,
        { ...record, checkoutPersistence: outcome },
        runRecordMaxBytes().value,
      );
      return observed(result);
    } catch {
      return observed({ status: "failed", error: LIVE_DELIVERY_FAILURES.retention });
    }
  }

  private async observedChangeSummary(
    files: readonly { readonly path: string }[],
  ): Promise<string | null> {
    try {
      const repositoryRoot = await realpath(this.options.repositoryPath);
      const entries: { path: string; sha256: string | null }[] = [];
      for (const { path } of files) {
        const target = resolve(this.options.repositoryPath, path);
        const current = await lstat(target).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        if (current === null) {
          entries.push({ path, sha256: null });
          continue;
        }
        if (!current.isFile() || current.isSymbolicLink())
          throw new Error("The observed patch output is not a regular file.");
        const actual = await realpath(target);
        if (actual !== repositoryRoot && !actual.startsWith(`${repositoryRoot}/`))
          throw new Error("The observed patch output resolved outside the repository workspace.");
        const handle = await open(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
        try {
          const opened = await handle.stat();
          if (!opened.isFile() || opened.dev !== current.dev || opened.ino !== current.ino)
            throw new Error("The patch output changed while its content was being observed.");
          const hash = createHash("sha256");
          for await (const chunk of handle.createReadStream({ autoClose: false }))
            hash.update(chunk);
          const after = await handle.stat();
          if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs)
            throw new Error("The patch output changed while its content was being observed.");
          entries.push({ path, sha256: hash.digest("hex") });
        } finally {
          await handle.close();
        }
      }
      return createHash("sha256")
        .update(canonicalJson(entries.sort((left, right) => left.path.localeCompare(right.path))))
        .digest("hex");
    } catch {
      return null;
    }
  }

  private async applyToCheckout(
    record: RunRecord,
    savedRecordSha256: string,
    signal?: AbortSignal,
    observeApplied?: (
      patch: Uint8Array,
      files: readonly { readonly path: string }[],
    ) => Promise<void>,
  ): Promise<LiveWorkflowPersistence> {
    if (signal?.aborted) return { status: "failed", error: WORKFLOW_CANCELLED };
    if (record.status !== "succeeded" || !record.changes?.files.length)
      return { status: "not-needed" };
    if (!this.options.allowWrite) return { status: "failed", error: LIVE_DELIVERY_FAILURES.write };
    try {
      await this.options.beforeMutation?.();
      const run = await this.load(record.id, "checkout");
      // The approval window can outlive the exact saved leaf checked above.
      // Use only a strictly verified patch from those same bytes.
      if (run.recordSha256 !== savedRecordSha256) throw new Error(LIVE_DELIVERY_FAILURES.retention);
      const head = await this.git(["rev-parse", "HEAD"]);
      if (head.exitCode !== 0 || head.stdout.toString().trim() !== run.revision)
        throw new Error(LIVE_DELIVERY_FAILURES.repository);
      const paths = run.changedFiles.flatMap((file) => [
        file.path,
        ...(file.previousPath ? [file.previousPath] : []),
      ]);
      if (
        paths.some(
          (path) =>
            path.split("/").some((part) => /^\.git$/iu.test(part)) || isExportExcluded(path),
        ) ||
        /^(?:(?:(?:new|old) mode|(?:new|deleted) file mode)|index [a-f0-9]+\.\.[a-f0-9]+) (?:120000|160000)$/mu.test(
          run.patchBytes.toString(),
        )
      )
        throw new Error(LIVE_DELIVERY_FAILURES.patch);
      // Verify the patch's actual destinations, not just the run's declared file list.
      const names = await this.git(["apply", "--numstat", "-z", "-"], run.patchBytes);
      const actual = names.stdout
        .toString()
        .split("\0")
        .filter(Boolean)
        .map((line) => /^(?:\d+|-)\t(?:\d+|-)\t(.+)$/su.exec(line)?.[1]);
      const expected = run.changedFiles.map((file) => file.path).sort();
      if (
        names.exitCode !== 0 ||
        actual.some((path) => !path) ||
        JSON.stringify(actual.sort()) !== JSON.stringify(expected)
      )
        throw new Error(LIVE_DELIVERY_FAILURES.patch);
      if ((await this.git(["apply", "--reverse", "--check", "-"], run.patchBytes)).exitCode === 0) {
        await observeApplied?.(run.patchBytes, run.changedFiles);
        return { status: "already-applied" };
      }
      if ((await this.git(["apply", "--check", "-"], run.patchBytes)).exitCode !== 0)
        throw new Error(LIVE_DELIVERY_FAILURES.conflict);
      // No index changes, commits, force, three-way merge, rejects, or unsafe paths.
      // Let an already-started apply settle; do not kill Git halfway through a write.
      assertWorkflowActive(signal);
      if (
        (await this.git(["apply", "--whitespace=nowarn", "-"], run.patchBytes)).exitCode !== 0 ||
        (await this.git(["apply", "--reverse", "--check", "-"], run.patchBytes)).exitCode !== 0
      )
        throw new Error(LIVE_DELIVERY_FAILURES.apply);
      await observeApplied?.(run.patchBytes, run.changedFiles);
      return { status: "applied" };
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      return {
        status: "failed",
        error:
          (message === WORKFLOW_CANCELLED ? WORKFLOW_CANCELLED : undefined) ??
          Object.values(LIVE_DELIVERY_FAILURES).find((safe) => safe === message) ??
          Object.values(TASK_BRANCH_FAILURES).find((safe) => safe === message) ??
          // A coded failure is rebuilt from its code alone, so no command output
          // or record text leaks.
          livePublicationFailure(error) ??
          LIVE_DELIVERY_FAILURES.patch,
      };
    }
  }

  publicationTool(): ToolDefinition {
    return {
      name: "docsfab_publish_workflow",
      label: "Create draft merge request",
      description:
        "Publish a succeeded write workflow's saved patch through DocsFab's existing GitLab delivery. Use only when the user asks for an MR. Requires a terminal confirmation before committing or pushing. Publish this exact saved run, not unrelated or later checkout changes. Available after session restart using the previous workflow runId. Never rerun authoring just to publish.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["runId"],
        properties: {
          runId: { type: "string" },
          branch: { type: "string", description: "Optional proposed source branch name." },
        },
      },
      executionMode: "sequential",
      execute: async (_id, raw) => {
        const { runId, branch } = (raw ?? {}) as { runId?: unknown; branch?: unknown };
        if (
          typeof runId !== "string" ||
          (branch !== undefined &&
            (typeof branch !== "string" ||
              !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/u.test(branch) ||
              branch.includes("..")))
        )
          throw new Error(LIVE_DELIVERY_FAILURES.patch);
        if (!this.options.allowWrite) throw new Error(LIVE_DELIVERY_FAILURES.write);
        let run: VerifiedPublicationRun;
        let retentionGuidance: string | undefined;
        try {
          run = await this.load(runId);
        } catch (error) {
          throw new Error(
            livePublicationFailure(error) ??
              (error instanceof Error &&
              [LIVE_DELIVERY_FAILURES.repository, LIVE_DELIVERY_FAILURES.documentationScope].some(
                (message) => message === error.message,
              )
                ? error.message
                : LIVE_DELIVERY_FAILURES.patch),
          );
        }
        const approved = await this.options.confirmPublication(
          `Create a draft MR for run ${run.id} (${run.changedFileCount} files)? This commits and pushes its saved patch, not other checkout changes. [y/N] `,
        );
        if (!approved)
          return {
            content: [
              {
                type: "text",
                text: "Publication cancelled. Local changes and the saved patch were retained.",
              },
            ],
            details: { status: "cancelled", runId },
          };
        try {
          // Ship reads the saved record again; it decodes only with the options
          // `runs show` uses (#2366).
          const editorialDecodeOptions = await loadSavedRunPublicationDecodeOptions(
            this.options.stateDirectory,
            runId,
          );
          const published = await (this.options.ship ?? shipSucceededWrite)(
            {
              runId,
              repositoryPath: this.options.repositoryPath,
              stateDirectory: this.options.stateDirectory,
              cwd: this.options.repositoryPath,
              dryRun: false,
              ...(typeof branch === "string" ? { proposedSourceBranch: branch } : {}),
            },
            {
              log: (line) => {
                retentionGuidance = retainedPublicationGuidance(line, runId) ?? retentionGuidance;
              },
              ...(editorialDecodeOptions ? { editorialDecodeOptions } : {}),
            },
          );
          if (!published?.mergeRequest?.url) throw new Error(LIVE_DELIVERY_FAILURES.publish);
          return {
            content: [{ type: "text", text: `Draft merge request: ${published.mergeRequest.url}` }],
            details: { status: "succeeded", runId, url: published.mergeRequest.url },
          };
        } catch (error) {
          const detail = livePublicationFailure(error) ?? LIVE_DELIVERY_FAILURES.publish;
          throw new Error(retentionGuidance ? `${detail} ${retentionGuidance}` : detail);
        }
      },
    };
  }
}
