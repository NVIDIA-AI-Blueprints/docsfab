// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Production host helpers for publishing a succeeded write run.
 *
 * A host job envelope is minted process-locally and bound to one run id; the
 * WeakSet is mint identity, not a durable delivery-key ledger. Dispatchers
 * forward a minted envelope and cannot widen it. `submitAfterSucceededRun` is
 * the only host function that opens a draft MR.
 */

import { constants as fsConstants } from "node:fs";
import { open, mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { RunRecord } from "../records/contracts.js";
import type { WorkflowOutcomeDecodeOptionsV1 } from "../workflow-contracts/outcome.js";
import {
  canonicalizeJsonEvidence,
  parseJsonEvidence,
  type JsonEvidenceValue,
} from "../json-evidence.js";
import { canonicalDigest } from "../content-ir/canonical.js";
import { resolveDocsFabConfigurationRoot } from "../config/host-paths.js";
import { ensurePrivateRunDirectory } from "../records/file-store.js";
import type { AutoValidationResultV1 } from "./contracts.js";
import type { AutoCycleOnceRecordV1 } from "./once.js";
import type { ManagedCycleLinkV1, ManagedIssueSelectionCandidateInputV1 } from "./managed-cycle.js";
import type {
  ManagedCyclePublishAttemptV1,
  ManagedCyclePublishHost,
  ManagedCyclePublishOutcomeV1,
  ManagedCyclePublishRecordV1,
} from "./managed-publish.js";
import { preflightLocalUserGitLabPublication } from "../delivery/preflight.js";
import {
  runLocalUserPublishExecuteCli,
  localUserPublishExecuteArgv,
} from "../delivery/publish-execute.js";
import { decodeLocalUserGitLabPublicationResult } from "../delivery/publication-result.js";
import { isProjectConfigPath } from "../delivery/run-record.js";
import {
  HOST_JOB_ENVELOPE_KIND,
  HOST_JOB_ENVELOPE_SCHEMA_VERSION,
  projectV1HostJobEnvelopeRecord,
  type HostJobEnvelopeProjectionV1,
  type HostJobPublishCapability,
  type V1HostJobEnvelopeRecord,
} from "./host-job-envelope-projection.js";

export { HOST_JOB_ENVELOPE_KIND, HOST_JOB_ENVELOPE_SCHEMA_VERSION, projectV1HostJobEnvelopeRecord };
export type { HostJobEnvelopeProjectionV1, HostJobPublishCapability };

/** Host authorization for one work packet. */
export type HostJobEnvelopeV1 = V1HostJobEnvelopeRecord;

export type HostJobEnvelopeProjection =
  | {
      readonly source: "cli-argv";
      readonly allowWrite: boolean;
      readonly draftMr: boolean;
    }
  | { readonly source: "confirm-cycle"; readonly confirmed: true };

const mintedHostJobEnvelopes = new WeakSet<object>();

/**
 * Mint a host job envelope from an operator projection. CLI flags and
 * `--confirm-cycle` are projections; inner-step JSON is not a projection.
 */
export function mintHostJobEnvelope(
  runId: string,
  projection: HostJobEnvelopeProjection,
): HostJobEnvelopeV1 {
  if (typeof runId !== "string" || runId.length === 0) {
    throw new Error("A host job envelope must be bound to a non-empty run id.");
  }
  let write: boolean;
  let publish: HostJobPublishCapability;
  if (projection.source === "cli-argv") {
    if (projection.draftMr && !projection.allowWrite) {
      throw new Error(
        "The --draft-mr publish projection requires --allow-write; the two capabilities stay distinct.",
      );
    }
    write = projection.allowWrite;
    publish = projection.draftMr ? "draft-mr" : "none";
  } else {
    if (projection.confirmed !== true) {
      throw new Error(
        "The --confirm-cycle publish projection requires an affirmed cycle confirmation.",
      );
    }
    write = true;
    publish = "draft-mr";
  }
  const envelope: HostJobEnvelopeV1 = Object.freeze({
    schemaVersion: HOST_JOB_ENVELOPE_SCHEMA_VERSION,
    kind: HOST_JOB_ENVELOPE_KIND,
    write,
    publish,
    runId,
  });
  mintedHostJobEnvelopes.add(envelope);
  return envelope;
}

/**
 * Reject envelopes that were not minted by this host, including objects built
 * from model output, sentence text, mentions, or inner-step JSON.
 */
export function requireHostMintedEnvelope(value: unknown): HostJobEnvelopeV1 {
  if (typeof value !== "object" || value === null || !mintedHostJobEnvelopes.has(value)) {
    throw new Error(
      "Host job envelopes cannot be minted from model, sentence, mention, or inner-step JSON.",
    );
  }
  const envelope = value as HostJobEnvelopeV1;
  if (
    envelope.schemaVersion !== HOST_JOB_ENVELOPE_SCHEMA_VERSION ||
    envelope.kind !== HOST_JOB_ENVELOPE_KIND ||
    typeof envelope.write !== "boolean" ||
    (envelope.publish !== "none" && envelope.publish !== "draft-mr") ||
    typeof envelope.runId !== "string" ||
    envelope.runId.length === 0
  ) {
    throw new Error("Host job envelope is not a host-minted authorization object.");
  }
  return envelope;
}

/**
 * Project a host-minted v1 envelope onto versioned delivery axes. JSON copies
 * remain readable via `projectV1HostJobEnvelopeRecord` but cannot satisfy this
 * mint gate or widen authority.
 */
export function projectHostMintedEnvelope(value: unknown): HostJobEnvelopeProjectionV1 {
  return projectV1HostJobEnvelopeRecord(requireHostMintedEnvelope(value));
}

export interface SubmitAfterSucceededRunContext {
  cwd: string;
  repositoryPath: string;
  stateDirectory: string;
  remoteName?: string;
  targetBranch?: string;
  proposedSourceBranch?: string;
  validationCommand?: string;
  deliveryRoot?: string;
  receiptRoot?: string;
  log?: (message: string) => void;
  preflight?: typeof preflightLocalUserGitLabPublication;
  execute?: typeof runLocalUserPublishExecuteCli;
  commands?: Parameters<typeof preflightLocalUserGitLabPublication>[1];
  executeDependencies?: Parameters<typeof runLocalUserPublishExecuteCli>[1];
  editorialDecodeOptions?: WorkflowOutcomeDecodeOptionsV1;
}

const EMPTY_WRITE_MESSAGE =
  "Draft-MR publication requires a succeeded write that changed documentation files. Re-run the write with a more specific --instruction so the patch changes documentation files; an empty patch is not published.";

/** Typed so the CLI footer does not mislabel other pre-log throws. */
export class EmptyPublishableWriteError extends Error {
  public readonly failureCode = "publication-not-attempted";

  public constructor() {
    super(EMPTY_WRITE_MESSAGE);
    this.name = "EmptyPublishableWriteError";
  }
}

/** Refuses a write that did not succeed or changed no documentation files. */
export function requirePublishableWritePatch(run: Pick<RunRecord, "status" | "changes">): void {
  if (run.status !== "succeeded") {
    throw new Error(
      "Draft-MR publication requires a succeeded write run before applying the envelope.",
    );
  }
  const files = run.changes?.files ?? [];
  const byteLength = run.changes?.patch?.byteLength ?? 0;
  const documentationFiles = files.filter((file) => !isProjectConfigPath(file.path));
  if (documentationFiles.length === 0 || byteLength === 0) {
    throw new EmptyPublishableWriteError();
  }
}

/**
 * Publish a succeeded write run whose host envelope has `publish: draft-mr`.
 * The plan digest is bound from a fresh preflight, not a second operator prompt.
 */
export async function submitAfterSucceededRun(
  run: Pick<RunRecord, "id" | "status" | "changes">,
  envelope: unknown,
  context: SubmitAfterSucceededRunContext,
): Promise<Awaited<ReturnType<typeof runLocalUserPublishExecuteCli>>> {
  const minted = requireHostMintedEnvelope(envelope);
  if (minted.runId !== run.id) {
    throw new Error("Host job envelope is bound to one run id and cannot be reused.");
  }
  if (!minted.write || minted.publish !== "draft-mr") {
    throw new Error(
      "Draft-MR publication requires a host envelope with write and publish: draft-mr.",
    );
  }
  requirePublishableWritePatch(run);
  const runId = run.id;
  const runRecordPath = resolve(context.stateDirectory, `${runId}.json`);
  const preflight = context.preflight ?? preflightLocalUserGitLabPublication;
  const execute = context.execute ?? runLocalUserPublishExecuteCli;
  // The environment the execute step's publisher will run Git with, so the plan
  // binds the identity and checks the configuration it will meet (#2393).
  const environment = context.executeDependencies?.environment;
  const planOptions: [
    Parameters<typeof preflightLocalUserGitLabPublication>[2]?,
    Parameters<typeof preflightLocalUserGitLabPublication>[3]?,
  ] = environment
    ? [context.editorialDecodeOptions ?? {}, { environment }]
    : context.editorialDecodeOptions
      ? [context.editorialDecodeOptions]
      : [];
  const plan = await preflight(
    {
      runId,
      runRecordPath,
      repositoryPath: context.repositoryPath,
      remoteName: context.remoteName ?? "origin",
      ...(context.targetBranch ? { targetBranch: context.targetBranch } : {}),
      ...(context.proposedSourceBranch
        ? { proposedSourceBranch: context.proposedSourceBranch }
        : {}),
      ...(context.validationCommand ? { validationCommand: context.validationCommand } : {}),
      draftMergeRequest: true,
    },
    context.commands,
    ...planOptions,
  );
  const args = localUserPublishExecuteArgv({
    runId,
    repositoryPath: context.repositoryPath,
    stateDirectory: context.stateDirectory,
    confirmedPlanSha256: plan.sha256,
    validationCommand: context.validationCommand ?? plan.validationCommand,
    remoteName: context.remoteName ?? "origin",
    ...(context.targetBranch ? { targetBranch: context.targetBranch } : {}),
    ...(context.proposedSourceBranch ? { proposedSourceBranch: context.proposedSourceBranch } : {}),
    ...(context.deliveryRoot ? { deliveryRoot: context.deliveryRoot } : {}),
    ...(context.receiptRoot ? { receiptRoot: context.receiptRoot } : {}),
  });
  return await execute(args, {
    ...(context.executeDependencies ?? {}),
    ...(context.editorialDecodeOptions
      ? { editorialDecodeOptions: context.editorialDecodeOptions }
      : {}),
    cwd: context.cwd,
    stateDirectory: context.stateDirectory,
    log: context.log ?? ((message) => console.log(message)),
  });
}

/** Content-free managed selection evidence from the live tracker observer. */
export interface ManagedCandidateManifestV1 {
  trackerObservationSha256: string;
  candidates: ManagedIssueSelectionCandidateInputV1[];
}

export async function defaultReadCandidates(path: string): Promise<ManagedCandidateManifestV1> {
  const bytes = await readFile(path);
  if (bytes.byteLength > 4 * 1024 * 1024) {
    throw new Error("The managed selection candidate manifest exceeds the maximum allowed size.");
  }
  const value = parseJsonEvidence(bytes.toString("utf8")) as unknown as ManagedCandidateManifestV1;
  if (
    typeof value !== "object" ||
    value === null ||
    !Array.isArray(value.candidates) ||
    typeof value.trackerObservationSha256 !== "string"
  ) {
    throw new Error(
      "The managed selection candidate manifest did not contain the expected observation evidence.",
    );
  }
  return value;
}

async function privateManagedRoot(cycleId: string, leaf: string): Promise<string> {
  const safe = cycleId.replace(/[^A-Za-z0-9._-]/gu, "_").slice(0, 200) || "cycle";
  const directory = resolve(
    resolveDocsFabConfigurationRoot(),
    ".docsfab",
    "managed-deliveries",
    safe,
    leaf,
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return directory;
}

async function writePrivateJson(destination: string, value: unknown): Promise<void> {
  const bytes = Buffer.from(`${canonicalizeJsonEvidence(value as JsonEvidenceValue)}\n`, "utf8");
  const handle = await open(
    destination,
    fsConstants.O_WRONLY |
      fsConstants.O_CREAT |
      fsConstants.O_TRUNC |
      (typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0),
    0o600,
  );
  try {
    await handle.chmod(0o600);
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function defaultSaveOnceRecord(record: AutoCycleOnceRecordV1): Promise<void> {
  const directory = resolve(resolveDocsFabConfigurationRoot(), ".docsfab", "auto-cycles");
  await ensurePrivateRunDirectory(directory);
  const safeName = record.cycleId.replace(/[^A-Za-z0-9._-]/gu, "_").slice(0, 200);
  await writePrivateJson(resolve(directory, `${safeName || "cycle"}.json`), record);
}

export async function defaultSaveLink(link: ManagedCycleLinkV1): Promise<void> {
  const directory = await privateManagedRoot(link.cycleId, "links");
  await writePrivateJson(resolve(directory, "link.json"), link);
}

export async function defaultSavePublishRecord(record: ManagedCyclePublishRecordV1): Promise<void> {
  const directory = await privateManagedRoot(record.cycleId, "publications");
  await writePrivateJson(resolve(directory, "publication.json"), record);
}

export async function defaultLoadPublishRecord(
  cycleId: string,
): Promise<ManagedCyclePublishRecordV1 | null> {
  const directory = await privateManagedRoot(cycleId, "publications");
  try {
    const bytes = await readFile(resolve(directory, "publication.json"));
    return parseJsonEvidence(bytes.toString("utf8")) as unknown as ManagedCyclePublishRecordV1;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function validateRun(record: RunRecord, ids: readonly string[]): AutoValidationResultV1[] {
  return ids.map((id) =>
    record.status === "succeeded"
      ? {
          id,
          status: "passed" as const,
          evidenceSha256: canonicalDigest({
            kind: "docsfab-auto-publish-validation",
            id,
            runId: record.id,
            workflow: record.workflow,
          }),
        }
      : { id, status: "not-run" as const, evidenceSha256: null },
  );
}

export function renderManagedPublishOutcome(outcome: ManagedCyclePublishOutcomeV1): string[] {
  const lines: string[] = [];
  const selected = outcome.cycle.selection.selected;
  lines.push(`Managed cycle: ${outcome.cycle.selection.cycleId}`);
  lines.push(`Selected issue: ${selected ? `!${selected.issueIid}` : "none"}`);
  if (outcome.cycle.link) {
    lines.push(`Disposition: ${outcome.cycle.link.disposition}`);
    lines.push(`Lifecycle target: ${outcome.cycle.link.lifecycleTarget}`);
  }
  const publish = outcome.publish;
  if (!publish) {
    lines.push("Publication: none (no ready issue or non-execute cycle).");
    return lines;
  }
  lines.push(`Publication status: ${publish.status}`);
  if (publish.status === "opened" && publish.mergeRequest) {
    lines.push(`Draft MR: !${publish.mergeRequest.iid} ${publish.mergeRequest.url}`);
  }
  if (publish.status === "deferred") {
    lines.push(`Interruption: ${publish.failureCode}; next action ${publish.nextAction}.`);
    if (publish.recoveryCommand) lines.push(`Recovery: ${publish.recoveryCommand}`);
  }
  return lines;
}

export function createProductionManagedPublish(context: {
  cwd: string;
  repositoryPath: string;
  stateDirectory: string;
  targetBranch?: string;
  validationCommand?: string;
  submit?: typeof submitAfterSucceededRun;
}): ManagedCyclePublishHost["publish"] {
  return async ({ record }) => {
    const runId = record.runRecordId;
    if (typeof runId !== "string" || runId.length === 0) {
      throw new Error(
        "The managed publication boundary requires a durable run record identifier to publish.",
      );
    }
    const envelope = mintHostJobEnvelope(runId, {
      source: "confirm-cycle",
      confirmed: true,
    });
    const logs: string[] = [];
    const submit = context.submit ?? submitAfterSucceededRun;
    const cycleRoots =
      context.submit === undefined
        ? {
            deliveryRoot: await privateManagedRoot(record.cycleId, "delivery"),
            receiptRoot: await privateManagedRoot(record.cycleId, "receipts"),
          }
        : {};
    try {
      await submit({ id: runId, status: "succeeded" }, envelope, {
        cwd: context.cwd,
        repositoryPath: context.repositoryPath,
        stateDirectory: context.stateDirectory,
        ...(context.targetBranch ? { targetBranch: context.targetBranch } : {}),
        ...(context.validationCommand ? { validationCommand: context.validationCommand } : {}),
        ...cycleRoots,
        log: (message) => logs.push(message),
      });
    } catch {
      // The delivery CLI logs its fail-closed result as the last line before
      // throwing; it is decoded into a deferred attempt below.
    }
    return decodePublishAttempt(logs.at(-1) ?? "{}");
  };
}

export function decodePublishAttempt(serialized: string): ManagedCyclePublishAttemptV1 {
  const value = parseJsonEvidence(serialized) as Record<string, unknown>;
  if (value.status === "opened") {
    return {
      status: "opened",
      result: decodeLocalUserGitLabPublicationResult(value),
    };
  }
  return {
    status: "deferred",
    failureCode: typeof value.failureCode === "string" ? value.failureCode : "receipt-drift",
    lastConfirmedState: typeof value.state === "string" ? value.state : "planned",
    nextAction: typeof value.nextAction === "string" ? value.nextAction : "review-preserved-patch",
    recoveryCommand:
      typeof value.recoveryCommand === "string"
        ? value.recoveryCommand
        : "re-run docsfab auto --publish --confirm-cycle to resume",
    patchPreserved: true,
  };
}
