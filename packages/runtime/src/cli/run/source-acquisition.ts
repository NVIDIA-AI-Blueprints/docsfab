// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CLI host for the tracked-file and GitLab merged-MR source producers.
 *
 * This module decides what neither producer may decide for itself: which bytes
 * are trusted, the host-granted read scope, and which installed skills may read
 * a source. It then issues the process-local source-evidence service the runner
 * requires before any source body or model call. Both branches share one grant
 * set, request projection, and host authority, so there is one way to record a
 * read.
 */
import { createHash } from "node:crypto";
import {
  assertGithubPrReviewBasis,
  type GithubPrReviewBasis,
} from "../../inputs/adapters/github-pr-provider.js";
import {
  createGithubPrCustody,
  type GithubPrCustody,
} from "../../inputs/local/github-pr-custody.js";
import { acquireCliPrHSourceObservations, failCliPrCustody } from "./pr-h-source.js";
import { currentTaskActivity } from "../../activity/observer.js";

import { openExternalInputAccessCapture, recordExternalInputAccess } from "../../inputs/access.js";
import { citeExternalInput } from "../../inputs/citation.js";
import {
  assertGitLabAcquisitionScope,
  createGitLabProjectIdentityPort,
  gitlabMrSourceReaderFactory,
  resolveGitLabAcquisitionScope,
  type GitLabAcquisitionScopeV1,
  type GitLabMrSourceReaderFactoryV1,
  type GitLabMrSourceReaderV1,
} from "../../inputs/gitlab-source-provider.js";
import {
  changeRequestSelectorUsesCheckout,
  type ChangeRequestSelectorV1,
} from "../../inputs/change-request-selector.js";
import type { CommandRunner } from "../../init/types.js";
import {
  acquireTrackedSourceBinding,
  SourceAcquisitionError,
  TrackedSourceOversizeError,
  type AcquiredSourceBindingV1,
  type TrackedSourceReaderV1,
} from "../../inputs/source-acquisition.js";
import {
  acquireGitLabMrSourceBinding,
  type AcquiredGitLabMrSourceBindingV1,
} from "../../inputs/source-acquisition-gitlab.js";
import {
  createSourceArtifactReference,
  sourceRepositoryContentDigest,
  type SourceArtifactReferenceV2,
} from "../../inputs/source-evidence-artifacts.js";
import {
  createSourceBinding,
  digestSourceProducerScopes,
  projectSourceRequestContext,
  type SourceBindingV1,
  type SourceRepositoryBindingV1,
} from "../../inputs/source-evidence.js";
import {
  createSourceEvidenceHostAuthority,
  createSourceEvidenceService,
} from "../../inputs/source-resolver.js";
import {
  createSourceStepPolicy,
  resolveSourceReadBudget,
  type SourceReadBudgetV1,
} from "../../inputs/source-step-policy.js";
import {
  admittedInputWindowTokens,
  type AdmittedInputWindowSource,
} from "../../model/admitted-input-window.js";
import type { BoundModelExecutionProfile } from "../../model/configuration.js";
import { CHARS_PER_TOKEN } from "../../model/context-budget.js";
import {
  sourceExtractionLimits,
  type SourceExtractionLimitsV1,
} from "../../inputs/source-extraction.js";
import type { RepositoryWorkspace } from "../../repository/workspace/contracts.js";
import {
  listTrackedRepositoryEntries,
  listTrackedRepositoryFiles,
  readTrackedRepositoryFile,
} from "../../repository/workspace/tracked-read.js";
import { canonicalDigest } from "../../content-ir/canonical.js";
import {
  EXPORT_EXCLUSION_DESCRIPTION,
  isExportExcluded,
} from "../../repository/workspace/export-exclusion.js";
import type { SourceEvidenceRunnerBinding } from "../../execution/contracts.js";
import type { ResolveLimitsOptions } from "../../config/limits.js";
import {
  failChangeSource,
  type ChangeSourceMemberV1,
  type ChangeSourceSelectorMemberV1,
  type GitLabMergeRequestSelectorV1,
  type LocalRangeSelectorV1,
  type ResolvedChangeSourceV1,
} from "../../inputs/change-source.js";
import { resolveLocalChangeSource } from "../../inputs/change-source/local.js";
import { resolveGithubChangeSource } from "../../inputs/change-source/github.js";
import type { GithubChangeSourceSelectorV1 } from "../../inputs/change-source/github-url.js";
import {
  assertMergeRequestTextMatchesPin,
  gitlabMergeRequestSourceOf,
  resolveGitLabMergeRequestChangeSource,
} from "../../inputs/change-source/gitlab.js";
import {
  acquireChangeSourceObservations,
  type AcquiredChangeSourceV1,
} from "../../inputs/change-source/acquisition.js";
import {
  acquireReleaseRangeObservations,
  isResolvedReleaseRange,
  releaseRangeStatusLines,
  resolveReleaseRangeChangeSource,
  type AcquiredReleaseRangeV1,
  type ResolvedReleaseRangeV1,
} from "../../inputs/change-source/release.js";
import type { ReleaseRangeSelectorV1 } from "../../inputs/change-source/release-member.js";

/** What a kind's resolver returns: one sealed record, or a release's units and index. */
export type ResolvedCliChangeSourceV1 =
  | ResolvedChangeSourceV1<ChangeSourceMemberV1>
  | ResolvedReleaseRangeV1;

/**
 * Installed skills that may receive `docsfab_read_source`: the locked skills
 * whose `references/documentation-sources.md` documents the tool. A skill
 * outside this list gets no reader even on a source-aware run.
 */
export const CLI_SOURCE_READ_SKILLS: readonly string[] = Object.freeze([
  "audit-documentation",
  "plan-documentation",
  "review-documentation",
  "verify-technical-accuracy",
  "write-documentation",
]);

/**
 * Read scope granted to a CLI run: the whole immutable tracked export of the
 * selected revision, the one scope the CLI can authenticate. The producer
 * already enforces any narrower grant.
 */
export const CLI_SOURCE_READ_SCOPE: readonly string[] = Object.freeze(["."]);

/**
 * Installed skills that may receive `docsfab_cite_source`. Citation coverage
 * judges only a write step's claims, so granting the read-only skills the tool
 * would put an unenforced instruction in front of the model. The writer may
 * also cite spans that `plan-documentation` read.
 */
export const CLI_SOURCE_CITE_SKILLS: readonly string[] = Object.freeze(["write-documentation"]);

/** A distinct host policy for the two installed read-only review finding steps. */
export const PR_REVIEW_SOURCE_CITE_SKILLS: readonly string[] = Object.freeze([
  "review-documentation",
  "verify-technical-accuracy",
]);

/** One callback-scoped PR source binding; the caller disposes it before basis settlement. */
export async function resolveCliPrReviewSourceEvidence(input: {
  readonly basis: GithubPrReviewBasis;
  readonly workspace: RepositoryWorkspace;
  readonly sourcePaths: readonly string[];
  readonly targetPaths: readonly string[];
  readonly admittedRequest: Record<string, unknown>;
  readonly runId: string;
  readonly readBudget?: SourceReadBudgetV1;
  readonly now?: () => Date;
}): Promise<GithubPrCustody> {
  assertGithubPrReviewBasis(input.basis);
  if (input.workspace !== input.basis.headWorkspace) {
    failCliPrCustody("github-pr-source-head-substituted");
  }
  const repository: SourceRepositoryBindingV1 = {
    identitySha256: createHash("sha256").update(input.workspace.sourcePath).digest("hex"),
    revision: input.workspace.revision,
  };
  const workspaceIdentitySha256 = workspaceIdentityDigest(input.workspace);
  const requestSha256 = projectSourceRequestContext(input.admittedRequest, {
    runId: input.runId,
    workspaceIdentitySha256,
    repository,
  });
  const policy = createSourceStepPolicy({
    sourceReadSkills: CLI_SOURCE_READ_SKILLS,
    sourceCiteSkills: PR_REVIEW_SOURCE_CITE_SKILLS,
    ...(input.readBudget ? { perStepBudgetBytes: input.readBudget.budgetBytes } : {}),
  });
  const selection = [...new Set([...input.targetPaths, ...input.sourcePaths])].sort();
  return createGithubPrCustody(
    input.basis.acquisition,
    {
      runId: input.runId,
      requestSha256,
      repository,
      workspaceIdentitySha256,
      repositoryContentDigest: await workspaceTreeDigest(input.workspace),
      policy,
      observedAt: (input.now ?? (() => new Date()))().toISOString(),
    },
    selection.length > 0
      ? {
          basis: input.basis,
          acquireHSourceObservations: (host) =>
            acquireCliPrHSourceObservations({
              host,
              selection,
              reader: createWorkspaceTrackedSourceReader(host.headWorkspace),
              readScope: CLI_SOURCE_READ_SCOPE,
            }),
        }
      : undefined,
  );
}

/** Trusted reader over the exact Git revision export, never a working tree. */
export function createWorkspaceTrackedSourceReader(
  workspace: RepositoryWorkspace,
): TrackedSourceReaderV1 {
  let tracked: Promise<ReadonlyMap<string, number>> | undefined;
  // Each tracked regular file's byte length, so a size refusal names it.
  const trackedSizes = (): Promise<ReadonlyMap<string, number>> => {
    tracked ??= listTrackedRepositoryFiles(workspace).then(
      (files) => new Map(files.map((file) => [file.path, file.byteLength])),
    );
    return tracked;
  };
  return {
    async isTrackedRegularFile(repositoryPath: string): Promise<boolean> {
      return (await trackedSizes()).has(repositoryPath);
    },
    async listTrackedRegularFiles(): Promise<readonly string[]> {
      return [...(await trackedSizes()).keys()];
    },
    async readTrackedBytes(repositoryPath: string, maxBytes: number): Promise<Uint8Array> {
      const activity = currentTaskActivity();
      const settleRead = activity?.observer.startResource({
        childScopeId: activity.childScopeId,
        resourceKind: "repository-source",
        operation: "read",
        resourceId: workspace.revision,
        path: repositoryPath,
        fromByte: 0,
        maxBytes,
      });
      try {
        const bytes = new Uint8Array(
          await readTrackedRepositoryFile(workspace, repositoryPath, maxBytes),
        );
        settleRead?.({ status: "ok", bytes });
        return bytes;
      } catch (error) {
        settleRead?.({ status: "failed", bytes: null });
        if (
          error instanceof Error &&
          "code" in error &&
          (error as { code?: unknown }).code === "oversize"
        ) {
          throw new TrackedSourceOversizeError(
            repositoryPath,
            (await trackedSizes()).get(repositoryPath),
          );
        }
        throw error;
      }
    },
  };
}

/**
 * Host-authenticated workspace identity. The raw workspace path never enters
 * the request projection; this digest stands in for it.
 */
export function workspaceIdentityDigest(workspace: RepositoryWorkspace): string {
  return canonicalDigest({
    schemaVersion: 1 as const,
    kind: "docsfab-source-workspace-identity" as const,
    workspacePathSha256: createHash("sha256").update(workspace.path).digest("hex"),
    repositoryIdentitySha256: createHash("sha256").update(workspace.sourcePath).digest("hex"),
    revision: workspace.revision,
  });
}

export async function workspaceTreeDigest(workspace: RepositoryWorkspace): Promise<string> {
  const entries = await listTrackedRepositoryEntries(workspace);
  return canonicalDigest({
    schemaVersion: 1 as const,
    kind: "docsfab-source-repository-tree" as const,
    entries: entries.map((entry) => ({
      kind: entry.kind,
      path: entry.path ?? null,
      byteLength: entry.byteLength ?? null,
    })),
  });
}

/**
 * The extraction budget a CLI run acquires under: the catalog, with its host
 * overrides, resolved when the run acquires. A module-load snapshot would miss
 * an override the configuration root's `.env` sets, which the CLI loads after
 * this module. There is deliberately no operator flag; an embedding host can
 * tighten it through `ResolveCliSourceEvidenceInput.limits`.
 */
export function cliSourceExtractionLimits(): Readonly<SourceExtractionLimitsV1> {
  return sourceExtractionLimits();
}

/**
 * A source refusal re-described for the operator. Each message keeps the
 * producer's remediation contract: it names the failing condition, states that
 * nothing was bound, and ends with the change that clears it.
 */
export class CliSourceAcquisitionError extends Error {
  public constructor(
    message: string,
    public readonly refusal: SourceAcquisitionError,
  ) {
    super(message, { cause: refusal });
    this.name = "CliSourceAcquisitionError";
  }

  public get code(): SourceAcquisitionError["code"] {
    return this.refusal.code;
  }
}

/**
 * Re-describe an extraction timeout or cancellation for the operator; a timeout
 * is about the host's budget, not the document. Every other refusal passes
 * through untouched. Only fixed text, the selected path, and the numeric budget
 * enter the message, so no document byte can reach it.
 */
export function describeCliSourceRefusal(error: unknown, budgetMs: number): unknown {
  if (!(error instanceof SourceAcquisitionError)) return error;
  if (
    error.code === "path-not-tracked" &&
    error.repositoryPath !== undefined &&
    isExportExcluded(error.repositoryPath)
  ) {
    return new CliSourceAcquisitionError(exportExcludedSourceMessage(error.repositoryPath), error);
  }
  const source = error.repositoryPath ?? "a selected source";
  if (error.code === "extraction-timed-out") {
    return new CliSourceAcquisitionError(
      `Source extraction exceeded the ${budgetMs} ms extraction budget for ${source}. ` +
        "Nothing was bound and no workflow model call was made. Select a smaller or " +
        "simpler document, or raise the host extraction budget.",
      error,
    );
  }
  if (error.code === "extraction-cancelled") {
    return new CliSourceAcquisitionError(
      `Source extraction was cancelled while reading ${source}. Nothing was bound and no ` +
        "workflow model call was made. Run the same command again and let acquisition finish.",
      error,
    );
  }
  return error;
}

/**
 * The refusal for a selected path the workspace export never materializes,
 * which reads as untracked: its name marks credentials or generated output.
 */
function exportExcludedSourceMessage(repositoryPath: string): string {
  return (
    `Source excluded: ${repositoryPath} is excluded from the source export, which never ` +
    `materializes ${EXPORT_EXCLUSION_DESCRIPTION}. Nothing was read and no model call was made. ` +
    "Bind a different file that carries the evidence, then run again."
  );
}

/**
 * Refuse a `--source` selection the revision does not track, before the
 * knowledge evidence gate reads it and presents it to the assessment model.
 * Uses the producer's own tracked-set check and refusal code.
 */
export async function assertBoundSourcesTracked(input: {
  readonly reader: TrackedSourceReaderV1;
  readonly sourcePaths: readonly string[];
}): Promise<void> {
  for (const repositoryPath of input.sourcePaths) {
    if (await input.reader.isTrackedRegularFile(repositoryPath)) continue;
    if (isExportExcluded(repositoryPath)) {
      throw new CliSourceAcquisitionError(
        exportExcludedSourceMessage(repositoryPath),
        new SourceAcquisitionError("path-not-tracked", repositoryPath),
      );
    }
    throw new CliSourceAcquisitionError(
      `No such source: ${repositoryPath} is not a tracked regular file at the selected revision. ` +
        "Nothing was read and no model call was made. Check the path, or commit the file, then run again.",
      new SourceAcquisitionError("path-not-tracked", repositoryPath),
    );
  }
}

export interface CliSourceEvidence {
  readonly reference: SourceArtifactReferenceV2<"source-binding">;
  readonly runnerBinding: SourceEvidenceRunnerBinding;
  readonly acquired: AcquiredSourceBindingV1;
}

/**
 * The per-step source-read budget for the model a run is bound to: the declared
 * ceiling, or `sources.readInputWindowShare` of the model's input window after
 * its context reserve when that is smaller. Only a window DocsFab admits
 * against counts (`admittedInputWindowTokens`): an installed composition's,
 * whatever its profile metadata says, or a profile's with current metadata. A
 * model whose context admission belongs to the provider, a profile that matches
 * no installed composition and whose metadata is unknown or stale, such as the
 * placeholder `docsfab setup` writes for an unmatched endpoint, and a run with
 * no bound model (an injected harness) have no attested window, so they keep
 * the ceiling. Pass the bound execution profile, never `config.model`.
 */
export function sourceReadBudgetForModel(
  profile:
    | (AdmittedInputWindowSource & Pick<BoundModelExecutionProfile, "requestPolicy">)
    | undefined,
): SourceReadBudgetV1 {
  const window = admittedInputWindowTokens(profile);
  return resolveSourceReadBudget({
    inputWindowTokens:
      profile === undefined || window === undefined
        ? null
        : Math.max(0, window - profile.requestPolicy.reservedContextTokens),
    bytesPerToken: CHARS_PER_TOKEN,
  });
}

export interface ResolveCliSourceEvidenceInput {
  readonly workspace: RepositoryWorkspace;
  readonly hostTrackedSourceReader?: TrackedSourceReaderV1;
  /** Repository-relative paths from `--source`, in operator order. */
  readonly sourcePaths: readonly string[];
  /** The exact admitted request the runner will receive, without `sourceBinding`. */
  readonly admittedRequest: Record<string, unknown>;
  readonly runId: string;
  readonly now?: () => Date;
  /**
   * Host-side extraction budgets over `cliSourceExtractionLimits()`. An
   * embedding seam; no `docsfab run` argument reaches it.
   */
  readonly limits?: Partial<SourceExtractionLimitsV1>;
  /**
   * The per-step source-read budget for the bound model, from
   * `resolveSourceReadBudget`; the declared ceiling when absent.
   */
  readonly readBudget?: SourceReadBudgetV1;
}

/**
 * Acquire the selected sources and issue this run's source-evidence service.
 * The request digest comes from the admitted request the runner will see, so
 * the binding cannot be minted against a different request shape.
 */
export async function resolveCliSourceEvidence(
  input: ResolveCliSourceEvidenceInput,
): Promise<CliSourceEvidence> {
  const { workspace } = input;
  const repository: SourceRepositoryBindingV1 = {
    identitySha256: createHash("sha256").update(workspace.sourcePath).digest("hex"),
    revision: workspace.revision,
  };
  const workspaceIdentitySha256 = workspaceIdentityDigest(workspace);
  const requestSha256 = projectSourceRequestContext(input.admittedRequest, {
    runId: input.runId,
    workspaceIdentitySha256,
    repository,
  });
  const policy = createSourceStepPolicy({
    sourceReadSkills: CLI_SOURCE_READ_SKILLS,
    sourceCiteSkills: CLI_SOURCE_CITE_SKILLS,
    ...(input.readBudget ? { perStepBudgetBytes: input.readBudget.budgetBytes } : {}),
  });
  const runIdSha256 = createHash("sha256").update(input.runId, "utf8").digest("hex");
  const now = input.now ?? (() => new Date());
  const externalInputs = openExternalInputAccessCapture({
    runIdSha256,
    repository,
  });

  const limits: SourceExtractionLimitsV1 = {
    ...cliSourceExtractionLimits(),
    ...(input.limits ?? {}),
  };

  let acquired: AcquiredSourceBindingV1;
  try {
    acquired = await acquireTrackedSourceBinding({
      reader: input.hostTrackedSourceReader ?? createWorkspaceTrackedSourceReader(workspace),
      externalInputs,
      selection: input.sourcePaths,
      readScope: CLI_SOURCE_READ_SCOPE,
      runIdSha256,
      repository,
      requestSha256,
      hostPolicySha256: policy.policySha256,
      observedAt: now().toISOString(),
      limits,
    });
  } catch (error) {
    // Changes only what the operator is told; nothing was bound either way.
    throw describeCliSourceRefusal(error, limits.maxExtractionMs);
  }

  return {
    ...(await issueCliSourceEvidenceService({
      workspace,
      repository,
      workspaceIdentitySha256,
      policy,
      externalInputs,
      binding: acquired.binding,
      entries: acquired.acquired,
      producerScopes: acquired.producerScopes,
      now,
      ...(input.readBudget ? { readBudget: input.readBudget } : {}),
    })),
    acquired,
  };
}

interface AcquiredSourceEntry {
  readonly observation: { observationId: string; inputId: string };
  readonly representation: { representationId: string };
  readonly derivative: Uint8Array;
}

/**
 * Issue this run's source-evidence service over an already-minted binding.
 * Shared by both producers so they cannot drift into recording the same read
 * differently.
 */
async function issueCliSourceEvidenceService(input: {
  readonly workspace: RepositoryWorkspace;
  readonly repository: SourceRepositoryBindingV1;
  readonly workspaceIdentitySha256: string;
  readonly policy: ReturnType<typeof createSourceStepPolicy>;
  readonly externalInputs: ReturnType<typeof openExternalInputAccessCapture>;
  readonly binding: SourceBindingV1;
  readonly entries: readonly AcquiredSourceEntry[];
  readonly producerScopes: ReadonlyArray<{
    producerId: string;
    scopeSha256: string;
  }>;
  readonly now: () => Date;
  readonly readBudget?: SourceReadBudgetV1;
}): Promise<Omit<CliSourceEvidence, "acquired">> {
  const { binding, externalInputs, policy, repository } = input;
  const observations = new Map(
    input.entries.map((entry) => [entry.observation.observationId, entry]),
  );
  const derivatives = new Map(
    input.entries.map((entry) => [
      `${entry.observation.observationId}|${entry.representation.representationId}`,
      entry.derivative,
    ]),
  );
  /** Memoized external-input citation joins; see `recordCitation` below. */
  const citationJoins = new Map<string, string>();
  /**
   * Each observation's derivative digest, hashed on its first access only. A
   * write step reads a required source one span per access, so hashing the
   * whole derivative on every access would cost spans times bytes.
   */
  const derivativeDigests = new Map<string, string>();
  const service = createSourceEvidenceService(
    createSourceEvidenceHostAuthority({
      verifyCurrent: () => undefined,
      hostPolicySha256: policy.policySha256,
      producerScopes: input.producerScopes,
      resolveBinding: (digest) => (digest === binding.bindingSha256 ? binding : undefined),
      resolveObservation: (observationId) => observations.get(observationId)?.observation,
      resolveDerivative: ({ observationId, representationId }) =>
        derivatives.get(`${observationId}|${representationId}`),
      recordAccess: ({ observationId, representationId, stepId, spanIds }) => {
        const entry = observations.get(observationId);
        if (!entry) throw new Error("Source access named an observation this run did not acquire.");
        let observedContentDigestSha256 = derivativeDigests.get(observationId);
        if (observedContentDigestSha256 === undefined) {
          observedContentDigestSha256 = createHash("sha256").update(entry.derivative).digest("hex");
          derivativeDigests.set(observationId, observedContentDigestSha256);
        }
        return recordExternalInputAccess(externalInputs, {
          inputId: entry.observation.inputId,
          stepId,
          outcome: "opened",
          observedContentDigestSha256,
          accessorId: "docsfab-read-source",
          evidenceSha256s: [
            canonicalDigest({
              schemaVersion: 1 as const,
              kind: "docsfab-source-span-selection" as const,
              representationId,
              spanIds: [...spanIds].sort(),
            }),
          ],
        }).observationSha256;
      },
      // Joins a verified span citation into the run's external-input citation
      // ledger, advancing the input from accessed to cited. Fail-closed: a
      // ledger diagnostic is raised so the `docsfab_cite_source` call fails
      // instead of sealing a citation the ledger never accepted.
      recordCitation: ({
        observationId,
        stepId,
        accessObservationSha256s,
        supportedClaimSha256,
      }) => {
        const entry = observations.get(observationId);
        if (!entry) {
          throw new Error("Source citation named an observation this run did not acquire.");
        }
        // Memoized per supporting receipt so a retrying step's duplicate
        // citation does not make the ledger reject itself.
        let first: string | undefined;
        for (const accessObservationSha256 of [...accessObservationSha256s].sort()) {
          const key = `${entry.observation.inputId}|${stepId}|${supportedClaimSha256}|${accessObservationSha256}`;
          let citationSha256 = citationJoins.get(key);
          if (citationSha256 === undefined) {
            const cited = citeExternalInput(externalInputs, {
              inputId: entry.observation.inputId,
              stepId,
              role: "evidence",
              supportedClaimSha256,
              accessObservationSha256,
            });
            if (cited.kind !== "docsfab-external-input-citation") {
              throw new Error(
                `The external-input citation ledger refused this source citation (${cited.code}). ` +
                  "Re-read the span with docsfab_read_source in this run, then cite it again.",
              );
            }
            citationSha256 = cited.citationSha256;
            citationJoins.set(key, citationSha256);
          }
          first ??= citationSha256;
        }
        if (first === undefined) {
          throw new Error(
            "Source citation named no supporting access observation, so nothing was joined to the citation ledger.",
          );
        }
        return first;
      },
      now: input.now,
    }),
  );
  const repositoryContentDigest = sourceRepositoryContentDigest({
    identitySha256: repository.identitySha256,
    revision: repository.revision,
    treeSha256: await workspaceTreeDigest(input.workspace),
  });
  return {
    reference: createSourceArtifactReference({
      kind: "source-binding",
      digest: binding.bindingSha256,
      repositoryRevision: repository.revision,
      repositoryContentDigest,
    }),
    runnerBinding: {
      service,
      workspaceIdentitySha256: input.workspaceIdentitySha256,
      repositoryContentDigest,
      policy,
      ...(input.readBudget ? { readBudgetBasis: input.readBudget.basis } : {}),
    },
  };
}

export interface CliGitLabMrSourceEvidence extends Omit<CliSourceEvidence, "acquired"> {
  readonly acquired: AcquiredGitLabMrSourceBindingV1;
}

/** Merge request text evidence, plus the pinned change acquired beside it when one was resolved. */
export interface CliChangeRequestSourceEvidence extends CliGitLabMrSourceEvidence {
  /** Present exactly when `changeSource` was passed, so the run record can cite it. */
  readonly change?: AcquiredChangeSourceV1;
}

export interface ResolveCliGitLabMrSourceEvidenceInput {
  /**
   * The per-step source-read budget for the bound model, from
   * `resolveSourceReadBudget`; the declared ceiling when absent.
   */
  readonly readBudget?: SourceReadBudgetV1;
  readonly workspace: RepositoryWorkspace;
  readonly hostTrackedSourceReader?: TrackedSourceReaderV1;
  /**
   * A factory rather than a reader, so the reader is built from the same proved
   * scope the locator is keyed on and cannot name a different project.
   */
  readonly readerFor: GitLabMrSourceReaderFactoryV1;
  /**
   * Scope proved by `resolveGitLabAcquisitionScope`. The numeric id keys every
   * locator; the path is what the read dereferences.
   */
  readonly scope: GitLabAcquisitionScopeV1;
  /** Order is not significant: the producer sorts the selection and refuses duplicates. */
  readonly mergeRequestIids: readonly number[];
  /** The exact admitted request the runner will receive, without `sourceBinding`. */
  readonly admittedRequest: Record<string, unknown>;
  readonly runId: string;
  readonly now?: () => Date;
}

export interface ResolveCliChangeRequestSourceEvidenceInput
  extends ResolveCliGitLabMrSourceEvidenceInput {
  /**
   * Tracked files from `--source`, bound alongside the merged change. A run
   * carries one source binding, so both producers' observations and scopes go
   * into that one binding.
   */
  readonly sourcePaths?: readonly string[];
  readonly limits?: Partial<SourceExtractionLimitsV1>;
  /** The merge request's pinned diff, resolved before any model call; it joins the same binding. */
  readonly changeSource?: ResolvedChangeSourceV1<ChangeSourceMemberV1>;
}

/**
 * Acquire the merged change, and any tracked files, into one source binding
 * whose `producerScopes` carries a row per producer. The source-evidence
 * service checks producer membership per observation, so this uses the
 * contract rather than widening it. Tracked files go first: that refusal costs
 * no network and should not wait behind a forge read.
 */
export async function resolveCliChangeRequestSourceEvidence(
  input: ResolveCliChangeRequestSourceEvidenceInput,
): Promise<CliChangeRequestSourceEvidence> {
  const { workspace } = input;
  const repository: SourceRepositoryBindingV1 = {
    identitySha256: createHash("sha256").update(workspace.sourcePath).digest("hex"),
    revision: workspace.revision,
  };
  const workspaceIdentitySha256 = workspaceIdentityDigest(workspace);
  const requestSha256 = projectSourceRequestContext(input.admittedRequest, {
    runId: input.runId,
    workspaceIdentitySha256,
    repository,
  });
  const policy = createSourceStepPolicy({
    sourceReadSkills: CLI_SOURCE_READ_SKILLS,
    sourceCiteSkills: CLI_SOURCE_CITE_SKILLS,
    ...(input.readBudget ? { perStepBudgetBytes: input.readBudget.budgetBytes } : {}),
  });
  const runIdSha256 = createHash("sha256").update(input.runId, "utf8").digest("hex");
  const now = input.now ?? (() => new Date());
  const externalInputs = openExternalInputAccessCapture({
    runIdSha256,
    repository,
  });
  const scope = assertGitLabAcquisitionScope(input.scope);
  const sourcePaths = input.sourcePaths ?? [];
  const limits: SourceExtractionLimitsV1 = {
    ...cliSourceExtractionLimits(),
    ...(input.limits ?? {}),
  };

  let tracked: AcquiredSourceBindingV1 | undefined;
  if (sourcePaths.length > 0) {
    try {
      tracked = await acquireTrackedSourceBinding({
        reader: input.hostTrackedSourceReader ?? createWorkspaceTrackedSourceReader(workspace),
        externalInputs,
        selection: sourcePaths,
        readScope: CLI_SOURCE_READ_SCOPE,
        runIdSha256,
        repository,
        requestSha256,
        hostPolicySha256: policy.policySha256,
        observedAt: now().toISOString(),
        limits,
      });
    } catch (error) {
      throw describeCliSourceRefusal(error, limits.maxExtractionMs);
    }
  }

  const acquired = await acquireGitLabMrSourceBinding({
    reader: pinnedTextReader(input.readerFor(scope), input.changeSource),
    externalInputs,
    scope,
    selection: input.mergeRequestIids,
    readScope: CLI_SOURCE_READ_SCOPE,
    runIdSha256,
    repository,
    requestSha256,
    hostPolicySha256: policy.policySha256,
    observedAt: now().toISOString(),
  });
  const change = input.changeSource
    ? await acquireChangeSourceObservations({
        resolved: input.changeSource,
        externalInputs,
        readScope: CLI_SOURCE_READ_SCOPE,
        runIdSha256,
        repository,
        requestSha256,
        observedAt: now().toISOString(),
        limits,
      })
    : undefined;

  const entries = [...(tracked?.acquired ?? []), ...acquired.acquired, ...(change?.acquired ?? [])];
  const producerScopes = Object.freeze([
    ...(tracked?.producerScopes ?? []),
    ...acquired.producerScopes,
    ...(change?.producerScopes ?? []),
  ]);
  // Each producer seals a binding over its own observations only, so the run's
  // one binding is re-minted over all of them. The observations stay as sealed.
  const binding =
    tracked === undefined && change === undefined
      ? acquired.binding
      : createSourceBinding({
          runIdSha256,
          repository,
          requestSha256,
          hostPolicySha256: policy.policySha256,
          producerScopeSha256: digestSourceProducerScopes(producerScopes),
          parentBindingSha256: null,
          observations: entries.map((entry) => ({
            observationId: entry.observation.observationId,
            observationSha256: entry.observation.observationSha256,
          })),
          // Everything the operator named is required, so a run that never
          // read it must not be allowed to write.
          requiredObservationIds: entries.map((entry) => entry.observation.observationId),
        });

  return {
    ...(await issueCliSourceEvidenceService({
      workspace,
      repository,
      workspaceIdentitySha256,
      policy,
      externalInputs,
      binding,
      entries,
      producerScopes,
      now,
      ...(input.readBudget ? { readBudget: input.readBudget } : {}),
    })),
    acquired: { ...acquired, binding },
    ...(change ? { change } : {}),
  };
}

/**
 * Wrap a merge request reader so text whose merge and squash commits differ
 * from the pinned diff's refuses before it is rendered.
 */
function pinnedTextReader(
  reader: GitLabMrSourceReaderV1,
  changeSource: ResolvedChangeSourceV1<ChangeSourceMemberV1> | undefined,
): GitLabMrSourceReaderV1 {
  const pinned = changeSource ? gitlabMergeRequestSourceOf(changeSource.changeSource) : undefined;
  if (pinned === undefined) return reader;
  return {
    async readMergeRequest(mergeRequestIid) {
      const projection = await reader.readMergeRequest(mergeRequestIid);
      if (projection !== undefined) assertMergeRequestTextMatchesPin(pinned, projection);
      return projection;
    },
  };
}

/**
 * Acquire the named merged merge requests and issue this run's source-evidence
 * service. It reuses the CLI read skills and read scope; the project scope and
 * named merge requests fold into the producer scope digest, so widening either
 * changes the binding the service accepts.
 */
export async function resolveCliGitLabMrSourceEvidence(
  input: ResolveCliGitLabMrSourceEvidenceInput,
): Promise<CliGitLabMrSourceEvidence> {
  const { workspace } = input;
  const repository: SourceRepositoryBindingV1 = {
    identitySha256: createHash("sha256").update(workspace.sourcePath).digest("hex"),
    revision: workspace.revision,
  };
  const workspaceIdentitySha256 = workspaceIdentityDigest(workspace);
  const requestSha256 = projectSourceRequestContext(input.admittedRequest, {
    runId: input.runId,
    workspaceIdentitySha256,
    repository,
  });
  const policy = createSourceStepPolicy({
    sourceReadSkills: CLI_SOURCE_READ_SKILLS,
    sourceCiteSkills: CLI_SOURCE_CITE_SKILLS,
    ...(input.readBudget ? { perStepBudgetBytes: input.readBudget.budgetBytes } : {}),
  });
  const runIdSha256 = createHash("sha256").update(input.runId, "utf8").digest("hex");
  const now = input.now ?? (() => new Date());
  const externalInputs = openExternalInputAccessCapture({
    runIdSha256,
    repository,
  });

  // Re-checked rather than trusted from the type: the proof is membership of a
  // module-private set, so a serialized, cloned, or rebuilt scope is refused
  // here. Mint it in-process with `resolveGitLabAcquisitionScope` and pass it on.
  const scope = assertGitLabAcquisitionScope(input.scope);
  const acquired = await acquireGitLabMrSourceBinding({
    reader: input.readerFor(scope),
    externalInputs,
    scope,
    selection: input.mergeRequestIids,
    readScope: CLI_SOURCE_READ_SCOPE,
    runIdSha256,
    repository,
    requestSha256,
    hostPolicySha256: policy.policySha256,
    observedAt: now().toISOString(),
  });

  return {
    ...(await issueCliSourceEvidenceService({
      workspace,
      repository,
      workspaceIdentitySha256,
      policy,
      externalInputs,
      binding: acquired.binding,
      entries: acquired.acquired,
      producerScopes: acquired.producerScopes,
      now,
      ...(input.readBudget ? { readBudget: input.readBudget } : {}),
    })),
    acquired,
  };
}

/**
 * Turn an operator's `--pr` selector into a proved acquisition scope and a
 * reader, then bind it.
 *
 * The numeric project id keys every `gitlab-mr:v1:` locator, but an operator
 * types a path, so the path resolves to its id before the scope is minted. A
 * bare number takes host and project from the checkout's canonical remote; a
 * typed host and project are used exactly as typed.
 */
export async function resolveCliChangeRequestEvidenceFromSelector(input: {
  readonly workspace: RepositoryWorkspace;
  readonly selector: ChangeRequestSelectorV1;
  readonly admittedRequest: Record<string, unknown>;
  readonly runId: string;
  readonly sourcePaths?: readonly string[];
  readonly hostTrackedSourceReader?: TrackedSourceReaderV1;
  /** Checkout host and project, for the bare-number form. */
  readonly checkout: () => Promise<{
    readonly host: string;
    readonly projectPath: string;
  }>;
  readonly commands: CommandRunner;
  readonly environment: NodeJS.ProcessEnv;
  readonly now?: () => Date;
  readonly readBudget?: SourceReadBudgetV1;
  /** A merged merge request's pinned diff; its observations join the text's binding. */
  readonly changeSource?: ResolvedChangeSourceV1<ChangeSourceMemberV1>;
}): Promise<CliChangeRequestSourceEvidence> {
  const named = changeRequestSelectorUsesCheckout(input.selector)
    ? await input.checkout()
    : {
        host: input.selector.host as string,
        projectPath: input.selector.projectPath as string,
      };
  const transport = {
    repositoryPath: input.workspace.path,
    commands: input.commands,
    environment: input.environment,
  };
  // Resolved through the identity port so evidence from one project cannot be
  // sealed under another's identity. The scope is minted from the canonical
  // path the forge returned, so two spellings do not become two producer
  // scopes; the echo port avoids a second read.
  const identity = await createGitLabProjectIdentityPort(transport).resolveProjectIdentity({
    host: named.host,
    projectPath: named.projectPath,
  });
  const scope = await resolveGitLabAcquisitionScope({
    reference: { host: identity.host, projectPath: identity.projectPath },
    identityPort: {
      async resolveProjectIdentity() {
        return identity;
      },
    },
  });
  return resolveCliChangeRequestSourceEvidence({
    workspace: input.workspace,
    scope,
    readerFor: gitlabMrSourceReaderFactory(transport),
    mergeRequestIids: [input.selector.number],
    admittedRequest: input.admittedRequest,
    runId: input.runId,
    ...(input.sourcePaths ? { sourcePaths: input.sourcePaths } : {}),
    ...(input.now ? { now: input.now } : {}),
    ...(input.readBudget ? { readBudget: input.readBudget } : {}),
    ...(input.hostTrackedSourceReader
      ? { hostTrackedSourceReader: input.hostTrackedSourceReader }
      : {}),
    ...(input.changeSource ? { changeSource: input.changeSource } : {}),
  });
}

/** The forge readers a kind that reads a forge receives; a local kind ignores them. */
export interface ChangeSourceForgeAccess {
  readonly commands: CommandRunner;
  readonly environment: NodeJS.ProcessEnv;
}

/**
 * One kind's resolver: it resolves and bounds its selector member before any
 * model call and returns the sealed record with both originals. A forge kind
 * also checks that the record's `protocol.provider` is its own forge.
 */
export type ChangeSourceKindArm = (input: {
  readonly workspace: RepositoryWorkspace;
  readonly selector: ChangeSourceSelectorMemberV1;
  readonly signal?: AbortSignal;
  readonly onStatus?: (message: string) => void;
  readonly limits?: ResolveLimitsOptions;
  readonly forge?: ChangeSourceForgeAccess;
  /** The `--source` files the run binds beside the change. */
  readonly besideObservations?: number;
  /** The step read budget of the model the run binds; the declared ceiling when absent. */
  readonly readBudget?: () => Promise<SourceReadBudgetV1>;
}) => Promise<ResolvedCliChangeSourceV1>;

/** The table key is the member's discriminant, so this arm only sees GitHub members. */
function githubKindArm(input: Parameters<ChangeSourceKindArm>[0]) {
  return resolveGithubChangeSource({
    selector: input.selector as GithubChangeSourceSelectorV1,
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.limits ? { limits: input.limits } : {}),
    ...(input.onStatus ? { onStatus: input.onStatus } : {}),
  });
}

/** The shipped kind arms, keyed by the selector's `source`. */
export const CHANGE_SOURCE_KIND_ARMS: Readonly<Record<string, ChangeSourceKindArm>> = Object.freeze(
  {
    // The table key is the member's discriminant, so this arm only sees local ranges.
    "local-range": (input) =>
      resolveLocalChangeSource({
        sourcePath: input.workspace.sourcePath,
        selector: input.selector as LocalRangeSelectorV1,
        workspaceRevision: input.workspace.revision,
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.limits ? { limits: input.limits } : {}),
      }),
    "gitlab-merge-request": (input) =>
      resolveGitLabMergeRequestChangeSource({
        selector: input.selector as GitLabMergeRequestSelectorV1,
        sourcePath: input.workspace.sourcePath,
        // The checkout, not the exported workspace: `!N` names the project of
        // the checkout's own remote, and an export has no git metadata.
        repositoryPath: input.workspace.sourcePath,
        workspaceRevision: input.workspace.revision,
        // The merge request is read through the operator's own glab login.
        forge: input.forge ?? failChangeSource("change-source-resolution-missing"),
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.limits ? { limits: input.limits } : {}),
        ...(input.onStatus ? { onStatus: input.onStatus } : {}),
      }),
    // The GitHub kinds read the public REST API anonymously; they take no forge readers.
    "github-pull-request": githubKindArm,
    "github-commit": githubKindArm,
    "github-compare": githubKindArm,
    // The table key is the member's discriminant, so this arm only sees release ranges.
    "release-range": async (input) =>
      resolveReleaseRangeChangeSource({
        sourcePath: input.workspace.sourcePath,
        selector: input.selector as ReleaseRangeSelectorV1,
        workspaceRevision: input.workspace.revision,
        // No bound model keeps the ceiling, as at execution.
        readBudget: (await input.readBudget?.()) ?? sourceReadBudgetForModel(undefined),
        ...(input.besideObservations !== undefined
          ? { besideObservations: input.besideObservations }
          : {}),
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.limits ? { limits: input.limits } : {}),
      }),
  },
);

type ChangeSourceMemberFile =
  ResolvedChangeSourceV1<ChangeSourceMemberV1>["changeSource"]["files"][number];

/** One status line per omitted file diff; a forge omission names its reason and no limit. */
function omissionStatus(file: ChangeSourceMemberFile): string | undefined {
  const omitted = file.diffOmitted;
  if (!omitted) return undefined;
  const path = file.newPath ?? file.oldPath;
  if (omitted.basis === "forge-omitted") {
    // Only `text-replaced` names a diff the forge did send: its text held U+FFFD.
    const why =
      omitted.forgeReason === "text-replaced"
        ? "from the forge holds replaced text"
        : "was not sent by the forge";
    return (
      `${omitted.code}: ${path} diff ${why} (${omitted.forgeReason}); ` +
      "it stays listed in the change manifest without its diff"
    );
  }
  return (
    `${omitted.code}: ${path} diff ${omitted.basis === "measured" ? "is" : "is at most"} ` +
    `${omitted.observedBytes} bytes, over ${omitted.limitName} = ${omitted.limitBytes}; ` +
    "it stays listed in the change manifest without its diff"
  );
}

/**
 * Resolve and bound a `--change` selector through its kind's arm, before any
 * model call, and report what the operator must see: every omitted file diff
 * and every label. A selector whose kind has no arm refuses; it never falls
 * back to the local resolver.
 */
export async function resolveCliChangeSource(
  input: {
    readonly workspace: RepositoryWorkspace;
    readonly selector: ChangeSourceSelectorMemberV1;
    readonly onStatus?: (message: string) => void;
    readonly signal?: AbortSignal;
    readonly limits?: ResolveLimitsOptions;
    readonly forge?: ChangeSourceForgeAccess;
    readonly besideObservations?: number;
    readonly readBudget?: () => Promise<SourceReadBudgetV1>;
  },
  arms: Readonly<Record<string, ChangeSourceKindArm>> = CHANGE_SOURCE_KIND_ARMS,
): Promise<ResolvedCliChangeSourceV1> {
  // Own keys only, so an inherited name such as `constructor` has no arm.
  if (!Object.hasOwn(arms, input.selector.source)) {
    failChangeSource("change-source-kind-unsupported");
  }
  const resolved = await arms[input.selector.source]!({
    workspace: input.workspace,
    selector: input.selector,
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.onStatus ? { onStatus: input.onStatus } : {}),
    ...(input.limits ? { limits: input.limits } : {}),
    ...(input.forge ? { forge: input.forge } : {}),
    ...(input.besideObservations !== undefined
      ? { besideObservations: input.besideObservations }
      : {}),
    ...(input.readBudget ? { readBudget: input.readBudget } : {}),
  });
  const records = isResolvedReleaseRange(resolved) ? resolved.units : [resolved];
  for (const { changeSource } of records) {
    input.onStatus?.(
      `change source: ${changeSource.rangeSemantics} range to ${changeSource.revision.head}, ` +
        `${changeSource.commits.length} commit(s), ${changeSource.files.length} changed path(s)`,
    );
    for (const file of changeSource.files) {
      const line = omissionStatus(file);
      if (line !== undefined) input.onStatus?.(line);
    }
    for (const label of changeSource.labels) input.onStatus?.(`change source label: ${label}`);
  }
  if (isResolvedReleaseRange(resolved)) {
    for (const line of releaseRangeStatusLines(resolved.index)) input.onStatus?.(line);
  }
  return resolved;
}

export interface CliChangeSourceEvidence extends Omit<CliSourceEvidence, "acquired"> {
  readonly acquired: (AcquiredChangeSourceV1 | AcquiredReleaseRangeV1) & {
    readonly binding: SourceBindingV1;
  };
}

/**
 * Mint the resolved range's observations, and any `--source` files, into one
 * source binding with a producer-scope row per producer. Both observations are
 * required, so a run that never read the change may not write.
 */
export async function resolveCliChangeSourceEvidence(input: {
  readonly workspace: RepositoryWorkspace;
  readonly resolved: ResolvedCliChangeSourceV1;
  /** The exact admitted request the runner will receive, without `sourceBinding`. */
  readonly admittedRequest: Record<string, unknown>;
  readonly runId: string;
  readonly sourcePaths?: readonly string[];
  readonly hostTrackedSourceReader?: TrackedSourceReaderV1;
  readonly now?: () => Date;
  readonly limits?: Partial<SourceExtractionLimitsV1>;
  readonly readBudget?: SourceReadBudgetV1;
  /** Defaults to `CHANGE_SOURCE_PRODUCER_IDS`. */
  readonly producerIds?: Readonly<Record<string, string>>;
}): Promise<CliChangeSourceEvidence> {
  const { workspace } = input;
  const repository: SourceRepositoryBindingV1 = {
    identitySha256: createHash("sha256").update(workspace.sourcePath).digest("hex"),
    revision: workspace.revision,
  };
  const workspaceIdentitySha256 = workspaceIdentityDigest(workspace);
  const requestSha256 = projectSourceRequestContext(input.admittedRequest, {
    runId: input.runId,
    workspaceIdentitySha256,
    repository,
  });
  const policy = createSourceStepPolicy({
    sourceReadSkills: CLI_SOURCE_READ_SKILLS,
    sourceCiteSkills: CLI_SOURCE_CITE_SKILLS,
    ...(input.readBudget ? { perStepBudgetBytes: input.readBudget.budgetBytes } : {}),
  });
  const runIdSha256 = createHash("sha256").update(input.runId, "utf8").digest("hex");
  const now = input.now ?? (() => new Date());
  const externalInputs = openExternalInputAccessCapture({
    runIdSha256,
    repository,
  });
  const limits: SourceExtractionLimitsV1 = {
    ...cliSourceExtractionLimits(),
    ...(input.limits ?? {}),
  };
  const sourcePaths = input.sourcePaths ?? [];

  let tracked: AcquiredSourceBindingV1 | undefined;
  if (sourcePaths.length > 0) {
    try {
      tracked = await acquireTrackedSourceBinding({
        reader: input.hostTrackedSourceReader ?? createWorkspaceTrackedSourceReader(workspace),
        externalInputs,
        selection: sourcePaths,
        readScope: CLI_SOURCE_READ_SCOPE,
        runIdSha256,
        repository,
        requestSha256,
        hostPolicySha256: policy.policySha256,
        observedAt: now().toISOString(),
        limits,
      });
    } catch (error) {
      throw describeCliSourceRefusal(error, limits.maxExtractionMs);
    }
  }
  const context = {
    externalInputs,
    readScope: CLI_SOURCE_READ_SCOPE,
    runIdSha256,
    repository,
    requestSha256,
    observedAt: now().toISOString(),
    limits,
    ...(input.producerIds ? { producerIds: input.producerIds } : {}),
  };
  const change = isResolvedReleaseRange(input.resolved)
    ? await acquireReleaseRangeObservations({
        ...context,
        resolved: input.resolved,
      })
    : await acquireChangeSourceObservations({
        ...context,
        resolved: input.resolved,
      });
  const entries = [...change.acquired, ...(tracked?.acquired ?? [])];
  const producerScopes = Object.freeze([
    ...change.producerScopes,
    ...(tracked?.producerScopes ?? []),
  ]);
  const binding = createSourceBinding({
    runIdSha256,
    repository,
    requestSha256,
    hostPolicySha256: policy.policySha256,
    producerScopeSha256: digestSourceProducerScopes(producerScopes),
    parentBindingSha256: null,
    observations: entries.map((entry) => ({
      observationId: entry.observation.observationId,
      observationSha256: entry.observation.observationSha256,
    })),
    // Everything the operator named is required, so a run that never read
    // the change must not be allowed to write. A release requires only its
    // units index, which lists every unit and was paged to fit one step's
    // read budget; requiring every unit record and diff would split that
    // budget into fragments.
    requiredObservationIds:
      "requiredObservationIds" in change
        ? [
            ...change.requiredObservationIds,
            ...(tracked?.acquired ?? []).map((entry) => entry.observation.observationId),
          ]
        : entries.map((entry) => entry.observation.observationId),
  });
  return {
    ...(await issueCliSourceEvidenceService({
      workspace,
      repository,
      workspaceIdentitySha256,
      policy,
      externalInputs,
      binding,
      entries,
      producerScopes,
      now,
      ...(input.readBudget ? { readBudget: input.readBudget } : {}),
    })),
    acquired: { ...change, producerScopes, binding },
  };
}
