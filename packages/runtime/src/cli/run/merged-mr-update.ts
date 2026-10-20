// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CLI assembly for instruction-only date-scoped merged-MR diff evidence.
 *
 * Discovers merged MRs before plan sealing (through the discovery service when
 * a numeric project id is available), fetches per-MR diffs, and mints a
 * `sourceBinding` from them so planner, writer, and verifier get bound
 * `docsfab_read_source` access. UPDATE also receives the identities and clipped
 * diffs as reader `required_content`; REVIEW and CREATE use the binding
 * directly. `restructure-documentation` is not eligible: a reordering request
 * has no changed-path set to derive scope from.
 *
 * This module never writes the tracker, opens an MR, publishes, or applies a
 * patch to the original checkout.
 */

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { GITLAB_READ_FAILURES } from "../../live-agent/gitlab-read.js";
import { conservativeReaderContextInput } from "../../execution/task-context.js";
import type { ReaderContextInputV1 } from "../../context/reader-context.js";
import type { ReaderSourceHintV1 } from "../../execution/reader-task-admission.js";
import { openExternalInputAccessCapture, recordExternalInputAccess } from "../../inputs/access.js";
import {
  discoverMergedMrs,
  type MergedMrDiscoveryDispositionV1,
  type MergedMrDiscoveryResultV1,
  type MergedMrFailureCodeV1,
  type MergedMrPagePortV1,
} from "../../inputs/merged-mr-discovery.js";
import {
  acquireMergedMrDiffBinding,
  documentationAndChangedPaths,
  renderMergedMrDiffOriginal,
} from "../../inputs/merged-mr-evidence.js";
import {
  GitLabSourceProviderError,
  resolveGitLabSourceScope,
} from "../../inputs/gitlab-source-provider.js";
import {
  createGitLabMergedMrDiffFetcher,
  createGitLabMergedMrPagePort,
  GitLabMergedMrReadError,
  isMergedMrFailureCode,
  resolveGitLabMergedMrProject,
  type GitLabMergedMrDiffBundleV1,
  type GitLabMergedMrPortOptionsV1,
  type MergedMrDiffFetcherV1,
} from "../../inputs/merged-mr-gitlab.js";
import {
  assertMergedMrSelectorCompatibility,
  parseMergedMrUpdateInstruction,
} from "../../inputs/merged-mr-instruction.js";
import {
  assessMergedMrApplicability,
  type MergedMrApplicabilityV1,
  type MergedMrProjectScopeV1,
  type MergedMrSelectedV1,
  type MergedMrSelectionRequestV1,
} from "../../inputs/merged-mr-selection.js";
import {
  discoverSourceDescriptors,
  SourceDiscoveryError,
  type SourceDescriptorV1,
  type SourceDiscoveryResultV1,
} from "../../inputs/source-discovery.js";
import {
  createSourceArtifactReference,
  sourceRepositoryContentDigest,
} from "../../inputs/source-evidence-artifacts.js";
import {
  projectSourceRequestContext,
  type SourceRepositoryBindingV1,
} from "../../inputs/source-evidence.js";
import {
  createSourceEvidenceHostAuthority,
  createSourceEvidenceService,
  SourceEvidenceServiceError,
  type SourceRunAdmissionContextV1,
  type SourceRunCapabilityV1,
} from "../../inputs/source-resolver.js";
import {
  createSourceStepPolicy,
  type SourceReadBudgetV1,
} from "../../inputs/source-step-policy.js";
import { canonicalDigest } from "../../content-ir/canonical.js";
import type { RepositoryWorkspace } from "../../repository/workspace/contracts.js";
import { isExportExcluded } from "../../repository/workspace/export-exclusion.js";
import { containsConfiguredCredential } from "../../security/configured-credentials.js";
import type { CommandRunner } from "../../init/types.js";
import { ExecInitCommandRunner } from "../../init/shared.js";
import {
  CLI_SOURCE_CITE_SKILLS,
  CLI_SOURCE_READ_SKILLS,
  workspaceIdentityDigest,
  workspaceTreeDigest,
  type CliSourceEvidence,
} from "./source-acquisition.js";
import type { CliRunOptions, RunRequestWithPublishProjection } from "./request.js";

export class MergedMrUpdateError extends Error {
  public constructor(
    message: string,
    public readonly disposition:
      | MergedMrDiscoveryDispositionV1
      | "selector-conflict"
      | "incomplete-request",
    public readonly failureCode: MergedMrFailureCodeV1 | null = null,
  ) {
    super(message);
    this.name = "MergedMrUpdateError";
  }
}

export interface MergedMrUpdateAssemblyV1 {
  readonly request: MergedMrSelectionRequestV1 & { readonly kind: "date-window" };
  readonly discovery: MergedMrDiscoveryResultV1;
  /** Present when a numeric GitLab project id let discovery use the discovery service. */
  readonly sourceDiscovery: SourceDiscoveryResultV1 | null;
  readonly applicability: MergedMrApplicabilityV1;
  readonly diffs: readonly GitLabMergedMrDiffBundleV1[];
  readonly readerContextInput: ReaderContextInputV1;
  readonly readerSources: readonly ReaderSourceHintV1[];
}

function selectedFromDescriptor(descriptor: SourceDescriptorV1): MergedMrSelectedV1 {
  const commitSha = descriptor.commitSha;
  const provenance = descriptor.commitProvenance;
  return Object.freeze({
    iid: descriptor.mergeRequestIid,
    locator: descriptor.locator,
    projectPath: descriptor.projectPath,
    mergedAt: descriptor.mergedAt,
    mergedAtMs: descriptor.mergedAtMs,
    targetBranch: descriptor.targetBranch,
    commitSha,
    commitProvenance: provenance,
    mergeCommitSha: provenance === "merge" ? commitSha : null,
    squashCommitSha: provenance === "squash" ? commitSha : null,
    evidenceGaps: descriptor.evidenceGaps,
  });
}

function discoveryFromSource(result: SourceDiscoveryResultV1): MergedMrDiscoveryResultV1 {
  return Object.freeze({
    schemaVersion: 1 as const,
    kind: "docsfab-merged-mr-discovery" as const,
    window: result.window,
    targetBranch: result.targetBranch,
    disposition: result.coverage.disposition,
    windowCovered: result.coverage.windowCovered,
    selected: Object.freeze(result.descriptors.map(selectedFromDescriptor)),
    excluded: result.coverage.excluded,
    pagesRead: result.coverage.pagesRead,
    lastGoodPage: result.cursor.lastGoodPage,
    rowsRead: result.coverage.rowsRead,
    itemsRead: result.coverage.itemsRead,
    duplicateRows: result.coverage.duplicateRows,
    failureCode: result.coverage.failureCode,
    truncatedPages: result.coverage.truncatedPages,
  });
}

async function resolveUpdateProject(
  options: CliRunOptions,
  portOptions: GitLabMergedMrPortOptionsV1,
  injectedPort: MergedMrPagePortV1 | undefined,
): Promise<MergedMrProjectScopeV1 | undefined> {
  if (options.mergedMrProject) return options.mergedMrProject;
  if (injectedPort) return undefined;
  try {
    return await resolveGitLabMergedMrProject(portOptions);
  } catch (error: unknown) {
    throw new MergedMrUpdateError(
      error instanceof Error ? error.message : GITLAB_READ_FAILURES.repository,
      "page-failed",
      failureCodeOf(error),
    );
  }
}

async function discoverUpdateWindow(input: {
  readonly port: MergedMrPagePortV1;
  readonly window: MergedMrSelectionRequestV1 & { readonly kind: "date-window" };
  readonly project: MergedMrProjectScopeV1 | undefined;
  readonly signal?: AbortSignal;
}): Promise<{
  discovery: MergedMrDiscoveryResultV1;
  sourceDiscovery: SourceDiscoveryResultV1 | null;
}> {
  const { port, window, project, signal } = input;
  if (project !== undefined && typeof project.projectId === "number") {
    const scope = await resolveGitLabSourceScope({
      reference: {
        host: project.host,
        projectId: project.projectId,
        ...(typeof project.projectPath === "string" ? { projectPath: project.projectPath } : {}),
      },
    });
    const sourceDiscovery = await discoverSourceDescriptors({
      scope,
      port,
      window: window.window,
      targetBranch: window.targetBranch,
      ...(signal ? { signal } : {}),
    });
    return { discovery: discoveryFromSource(sourceDiscovery), sourceDiscovery };
  }
  return {
    discovery: await discoverMergedMrs({
      port,
      window: window.window,
      targetBranch: window.targetBranch,
      ...(project ? { project } : {}),
      ...(signal ? { signal } : {}),
    }),
    sourceDiscovery: null,
  };
}

function uncoveredMessage(discovery: MergedMrDiscoveryResultV1): string {
  const detail =
    discovery.failureCode !== null
      ? GITLAB_READ_FAILURES[discovery.failureCode]
      : `Discovery ended ${discovery.disposition}.`;
  return (
    `Merged-MR discovery did not cover the requested window (${discovery.disposition}). ` +
    "It cannot report complete coverage, a verified no-change result, or unsupported successful documentation. " +
    detail
  );
}

function readerJobFor(request: MergedMrSelectionRequestV1 & { kind: "date-window" }): string {
  const { window } = request;
  const range =
    window.startDate === window.endDate
      ? window.startDate
      : `${window.startDate} through ${window.endDate}`;
  return `Assess documentation impact of merge requests merged into ${request.targetBranch} on ${range} in ${window.timeZone}.`;
}

const READER_DIFF_BUDGET_BYTES = 24 * 1024;
const READER_DIFF_CLIP = 1_024;

function clip(text: string, maximumCodePoints: number): string {
  const chars = [...text];
  return chars.length <= maximumCodePoints ? text : chars.slice(0, maximumCodePoints).join("");
}

function requiredContent(
  discovery: MergedMrDiscoveryResultV1,
  diffs: readonly GitLabMergedMrDiffBundleV1[],
): { rows: string[]; omittedDiffs: boolean } {
  if (discovery.disposition === "exhausted-empty") {
    return {
      rows: [
        "The requested merged-MR window was fully walked and contained no matching merge requests.",
      ],
      omittedDiffs: false,
    };
  }
  const rows: string[] = discovery.selected.slice(0, 32).map((entry) => {
    const identity = entry.commitSha ?? "missing-commit-identity";
    return `MR !${entry.iid} merged ${entry.mergedAt} (${entry.commitProvenance} ${identity})`;
  });
  if (discovery.selected.length > 32) {
    rows.push(
      `Additional selected merge requests were omitted from this bounded list: ${discovery.selected.length - 32}.`,
    );
  }
  let used = Buffer.byteLength(JSON.stringify(rows), "utf8");
  let omittedDiffs = false;
  for (const [index, entry] of discovery.selected.entries()) {
    if (rows.length >= 64) {
      omittedDiffs = true;
      break;
    }
    const bundle = diffs[index];
    if (!bundle) continue;
    const row = clip(
      `MR !${entry.iid} diff evidence:\n${new TextDecoder().decode(renderMergedMrDiffOriginal(entry, bundle).bytes)}`,
      READER_DIFF_CLIP,
    );
    const next = Buffer.byteLength(row, "utf8");
    if (used + next > READER_DIFF_BUDGET_BYTES) {
      omittedDiffs = true;
      break;
    }
    rows.push(row);
    used += next;
  }
  return {
    rows:
      rows.length > 0
        ? rows.slice(0, 64)
        : ["Selected merge requests were recorded with per-MR identities."],
    omittedDiffs,
  };
}

function knownLimitations(
  discovery: MergedMrDiscoveryResultV1,
  applicability: MergedMrApplicabilityV1,
  diffs: readonly GitLabMergedMrDiffBundleV1[],
  omittedDiffs: boolean,
  omittedReaderSources: boolean,
): string[] | undefined {
  const rows = new Set<string>();
  if (discovery.disposition === "exhausted-empty") {
    rows.add("merged-mr-window-exhausted-empty");
  }
  if (discovery.truncatedPages.length > 0) {
    rows.add("merged-mr-list-page-truncated");
  }
  if (omittedDiffs) {
    rows.add("merged-mr-reader-diff-list-bounded");
  }
  if (omittedReaderSources) {
    rows.add("merged-mr-reader-sources-bounded");
  }
  for (const entry of applicability.inapplicable) {
    rows.add(`MR !${entry.iid} ${entry.reason}`);
  }
  for (const bundle of diffs) {
    if (bundle.truncated) rows.add(`MR !${bundle.iid} truncated-or-collapsed-diff`);
  }
  for (const entry of discovery.selected) {
    for (const gap of entry.evidenceGaps) {
      rows.add(`MR !${entry.iid} ${gap}`);
    }
  }
  return rows.size > 0 ? [...rows].slice(0, 64) : undefined;
}

const MAX_MERGED_MR_READER_FILE_BYTES = 64 * 1024;
const MAX_MERGED_MR_READER_RETAINED_BYTES = 3 * 1024 * 1024;
const MAX_MERGED_MR_READER_PATHS = 16;
const MAX_MERGED_MR_READER_TOTAL_PATHS = 16;

/** Bytes of a current checkout file the reader may retain, or undefined to omit. */
function admissibleReaderFileBytes(root: string, path: string): number | undefined {
  if (
    !path ||
    path.includes("\0") ||
    path.startsWith("/") ||
    path.includes("..") ||
    isExportExcluded(path)
  ) {
    return undefined;
  }
  try {
    const metadata = statSync(join(root, path));
    if (!metadata.isFile() || metadata.size > MAX_MERGED_MR_READER_FILE_BYTES) {
      return undefined;
    }
    const bytes = readFileSync(join(root, path));
    // A file holding a configured credential is never offered to the reader;
    // credential-like content is (#1807).
    if (containsConfiguredCredential(bytes.toString("utf8"))) {
      return undefined;
    }
    return metadata.size;
  } catch {
    return undefined;
  }
}

function takeAdmissibleReaderPaths(
  root: string,
  paths: readonly string[],
  budget: { remaining: number; remainingPaths: number },
): string[] {
  const selected: string[] = [];
  for (const path of paths) {
    if (selected.length >= MAX_MERGED_MR_READER_PATHS || budget.remainingPaths <= 0) break;
    const size = admissibleReaderFileBytes(root, path);
    if (size === undefined || size > budget.remaining) continue;
    selected.push(path);
    budget.remaining -= size;
    budget.remainingPaths -= 1;
  }
  return selected;
}

function buildReaderContext(
  request: MergedMrSelectionRequestV1 & { kind: "date-window" },
  discovery: MergedMrDiscoveryResultV1,
  applicability: MergedMrApplicabilityV1,
  diffs: readonly GitLabMergedMrDiffBundleV1[],
  repositoryPath: string,
): { readerContextInput: ReaderContextInputV1; readerSources: ReaderSourceHintV1[] } {
  const paths = documentationAndChangedPaths(diffs);
  const budget = {
    remaining: MAX_MERGED_MR_READER_RETAINED_BYTES,
    remainingPaths: MAX_MERGED_MR_READER_TOTAL_PATHS,
  };
  const documentationPaths = takeAdmissibleReaderPaths(
    repositoryPath,
    paths.documentationPaths,
    budget,
  );
  const changedSourcePaths = takeAdmissibleReaderPaths(
    repositoryPath,
    paths.changedSourcePaths,
    budget,
  );
  const omittedReaderSources =
    documentationPaths.length <
      Math.min(MAX_MERGED_MR_READER_PATHS, paths.documentationPaths.length) ||
    changedSourcePaths.length <
      Math.min(MAX_MERGED_MR_READER_PATHS, paths.changedSourcePaths.length);
  const changeScope =
    documentationPaths.length > 0
      ? documentationPaths
      : ["documentation scope selected by the validated plan"];
  const content = requiredContent(discovery, diffs);
  const limitations = knownLimitations(
    discovery,
    applicability,
    diffs,
    content.omittedDiffs,
    omittedReaderSources,
  );
  const base = conservativeReaderContextInput({
    instruction: readerJobFor(request),
    changeScope,
  });
  const readerContextInput = {
    ...base,
    required_content: content.rows,
    unresolved_questions:
      discovery.disposition === "exhausted-empty"
        ? [
            "The window was empty. Confirm that documentation still matches the current product if this emptiness is unexpected.",
          ]
        : [
            "Independently establish which selected merge requests change user-facing documentation.",
          ],
    ...(limitations ? { known_limitations: limitations } : { known_limitations: [] }),
  };
  const publicContractPath = changedSourcePaths[0] ?? documentationPaths[0];
  const readerSources: ReaderSourceHintV1[] = [
    ...(publicContractPath ? [{ role: "public-contract" as const, path: publicContractPath }] : []),
    ...changedSourcePaths.map((path) => ({
      role: "changed-source" as const,
      path,
    })),
    ...documentationPaths.map((path) => ({
      role: "current-documentation" as const,
      path,
    })),
  ];
  return { readerContextInput, readerSources };
}

async function presentRevisionsOf(
  workspace: RepositoryWorkspace,
  selectedShas: readonly string[],
  options: CliRunOptions,
): Promise<Set<string>> {
  if (options.presentMergedMrRevisions) return new Set(options.presentMergedMrRevisions);
  const present = new Set<string>();
  if (selectedShas.length === 0) return present;
  const commands = options.mergedMrCommands ?? new ExecInitCommandRunner();
  for (const sha of selectedShas) {
    const result = await commands.run(
      "git",
      ["cat-file", "-e", `${sha}^{commit}`],
      workspace.sourcePath,
    );
    if (result.exitCode === 0) present.add(sha);
  }
  return present;
}

function failureCodeOf(error: unknown): MergedMrFailureCodeV1 {
  if (error instanceof GitLabMergedMrReadError) return error.code;
  const tagged = (error as { code?: unknown } | null)?.code;
  return isMergedMrFailureCode(tagged) ? tagged : "request";
}

/** `restructure-documentation` is excluded: a reordering request has no changed-path set. */
export const MERGED_MR_DIFF_BINDING_WORKFLOWS = Object.freeze([
  "update-documentation",
  "review-documentation",
  "create-documentation",
] as const);

export type MergedMrDiffBindingWorkflow = (typeof MERGED_MR_DIFF_BINDING_WORKFLOWS)[number];

export function isMergedMrDiffBindingWorkflow(
  workflow: string,
): workflow is MergedMrDiffBindingWorkflow {
  return (MERGED_MR_DIFF_BINDING_WORKFLOWS as readonly string[]).includes(workflow);
}

function dateWindowOf(
  request: RunRequestWithPublishProjection,
): (MergedMrSelectionRequestV1 & { kind: "date-window" }) | undefined {
  if (!isMergedMrDiffBindingWorkflow(request.workflow)) return undefined;
  if (request.readerTaskContext) return undefined;
  const attached = request.mergedMrSelection;
  if (attached?.kind === "date-window") {
    assertMergedMrSelectorCompatibility({
      parsed: { kind: "date-window", request: attached },
      readerSources: request.readerSources,
      comparisonRequest: request.comparisonRequest,
    });
    return attached;
  }
  const parsed = parseMergedMrUpdateInstruction(request.instruction ?? "");
  assertMergedMrSelectorCompatibility({
    parsed,
    readerSources: request.readerSources,
    comparisonRequest: request.comparisonRequest,
  });
  if (parsed.kind !== "date-window") return undefined;
  return parsed.request;
}

/** Discover the instruction's date window and assemble reader/source handoff. */
export async function assembleMergedMrUpdate(input: {
  readonly request: RunRequestWithPublishProjection;
  readonly workspace: RepositoryWorkspace;
  readonly options: CliRunOptions;
}): Promise<MergedMrUpdateAssemblyV1 | undefined> {
  const selection = dateWindowOf(input.request);
  if (!selection) return undefined;

  const portOptions: GitLabMergedMrPortOptionsV1 = {
    repositoryPath: input.workspace.sourcePath,
    ...(input.options.mergedMrCommands ? { commands: input.options.mergedMrCommands } : {}),
    ...(input.options.mergedMrEnvironment
      ? { environment: input.options.mergedMrEnvironment }
      : {}),
  };
  const injectedPort = input.options.mergedMrPagePort;
  const port: MergedMrPagePortV1 = injectedPort ?? createGitLabMergedMrPagePort(portOptions);
  const project = await resolveUpdateProject(input.options, portOptions, injectedPort);
  let discovery: MergedMrDiscoveryResultV1;
  let sourceDiscovery: SourceDiscoveryResultV1 | null;
  try {
    const walked = await discoverUpdateWindow({
      port,
      window: selection,
      project,
      ...(input.options.signal ? { signal: input.options.signal } : {}),
    });
    discovery = walked.discovery;
    sourceDiscovery = walked.sourceDiscovery;
  } catch (error) {
    if (error instanceof MergedMrUpdateError) throw error;
    if (error instanceof SourceDiscoveryError && error.code === "credentials") {
      throw new MergedMrUpdateError(error.message, "page-failed", "credentials");
    }
    if (error instanceof GitLabSourceProviderError) {
      throw new MergedMrUpdateError(error.message, "page-failed", error.code);
    }
    throw new MergedMrUpdateError(
      error instanceof Error ? error.message : GITLAB_READ_FAILURES.request,
      "page-failed",
      failureCodeOf(error),
    );
  }
  if (!discovery.windowCovered) {
    throw new MergedMrUpdateError(
      uncoveredMessage(discovery),
      discovery.disposition,
      discovery.failureCode,
    );
  }

  const shas = discovery.selected
    .map((entry) => entry.commitSha)
    .filter((value): value is string => typeof value === "string");
  const present = await presentRevisionsOf(input.workspace, shas, input.options);
  const applicability = assessMergedMrApplicability(discovery.selected, present);

  const fetchDiffs =
    input.options.fetchMergedMrDiffs ?? createGitLabMergedMrDiffFetcher(portOptions);
  const diffs: GitLabMergedMrDiffBundleV1[] = [];
  for (const entry of discovery.selected) {
    try {
      diffs.push(await fetchDiffs(entry.iid));
    } catch (error) {
      throw new MergedMrUpdateError(
        `Merged-MR diffs for merge request !${entry.iid} were unavailable. ` +
          (error instanceof Error ? error.message : GITLAB_READ_FAILURES.request),
        "page-failed",
        failureCodeOf(error),
      );
    }
  }

  const { readerContextInput, readerSources } = buildReaderContext(
    selection,
    discovery,
    applicability,
    diffs,
    input.workspace.path,
  );
  return {
    request: selection,
    discovery,
    sourceDiscovery,
    applicability,
    diffs: Object.freeze(diffs),
    readerContextInput,
    readerSources,
  };
}

const HOST_OPENED_MERGED_MR_READ_BUDGET_BYTES = 16 * 1024 * 1024;

/** The first read-capable step; REVIEW has no `plan-documentation` step. */
function firstMergedMrReadStepId(workflow: MergedMrDiffBindingWorkflow): string {
  return workflow === "review-documentation" ? "audit-documentation" : "plan-documentation";
}

/** Host-opened GitLab diffs are already collected; mark their spans read before write. */
function seedHostOpenedMergedMrReads(
  capability: SourceRunCapabilityV1,
  workflow: MergedMrDiffBindingWorkflow,
): void {
  const reader = capability.forStep({
    stepId: firstMergedMrReadStepId(workflow),
    workflow,
    readSource: true,
    remainingBudgetBytes: HOST_OPENED_MERGED_MR_READ_BUDGET_BYTES,
  });
  if (!reader) return;
  const grouped = new Map<
    string,
    { observationId: string; representationId: string; spanIds: string[] }
  >();
  for (const entry of reader.listSources()) {
    const key = `${entry.observationId}|${entry.representationId}`;
    const group = grouped.get(key) ?? {
      observationId: entry.observationId,
      representationId: entry.representationId,
      spanIds: [],
    };
    group.spanIds.push(entry.spanId);
    grouped.set(key, group);
  }
  for (const group of grouped.values()) {
    try {
      reader.read(group);
    } catch (error) {
      if (!(error instanceof SourceEvidenceServiceError) || error.code !== "credential-withheld") {
        throw error;
      }
      // Seed span by span, so a span the credential screen withholds stays
      // unread, and reported, instead of failing the bind.
      for (const spanId of group.spanIds) {
        try {
          reader.read({ ...group, spanIds: [spanId] });
        } catch (spanError) {
          if (
            !(spanError instanceof SourceEvidenceServiceError) ||
            spanError.code !== "credential-withheld"
          ) {
            throw spanError;
          }
        }
      }
    }
  }
}

/** Mint process-local source observations for selected merged-MR diffs. */
export async function issueMergedMrCliSourceEvidence(input: {
  readonly workspace: RepositoryWorkspace;
  readonly admittedRequest: Record<string, unknown>;
  readonly runId: string;
  readonly assembly: MergedMrUpdateAssemblyV1;
  readonly now?: () => Date;
  /**
   * The per-step source-read budget for the bound model, from
   * `resolveSourceReadBudget`; the declared ceiling when absent.
   */
  readonly readBudget?: SourceReadBudgetV1;
}): Promise<CliSourceEvidence | undefined> {
  if (input.assembly.discovery.selected.length === 0) return undefined;
  const requestWorkflow = input.admittedRequest.workflow;
  if (typeof requestWorkflow !== "string" || !isMergedMrDiffBindingWorkflow(requestWorkflow)) {
    throw new MergedMrUpdateError(
      "Merged-MR CLI source evidence requires an eligible workflow (update-documentation, review-documentation, or create-documentation).",
      "incomplete-request",
    );
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
    sourceCiteSkills: CLI_SOURCE_CITE_SKILLS,
    ...(input.readBudget ? { perStepBudgetBytes: input.readBudget.budgetBytes } : {}),
  });
  const runIdSha256 = createHash("sha256").update(input.runId, "utf8").digest("hex");
  const now = input.now ?? (() => new Date());
  const observedAt = now().toISOString();
  const externalInputs = openExternalInputAccessCapture({ runIdSha256, repository });
  const originals = input.assembly.discovery.selected.map((selected, index) =>
    renderMergedMrDiffOriginal(selected, input.assembly.diffs[index]!),
  );
  const acquired = await acquireMergedMrDiffBinding({
    originals,
    externalInputs,
    runIdSha256,
    repository,
    requestSha256,
    hostPolicySha256: policy.policySha256,
    observedAt,
  });
  const observations = new Map(
    acquired.acquired.map((entry) => [entry.observation.observationId, entry]),
  );
  const derivatives = new Map(
    acquired.acquired.map((entry) => [
      `${entry.observation.observationId}|${entry.representation.representationId}`,
      entry.derivative,
    ]),
  );
  const innerService = createSourceEvidenceService(
    createSourceEvidenceHostAuthority({
      verifyCurrent: () => undefined,
      hostPolicySha256: policy.policySha256,
      producerScopes: acquired.producerScopes,
      resolveBinding: (digest) =>
        digest === acquired.binding.bindingSha256 ? acquired.binding : undefined,
      resolveObservation: (observationId) => observations.get(observationId)?.observation,
      resolveDerivative: ({ observationId, representationId }) =>
        derivatives.get(`${observationId}|${representationId}`),
      recordAccess: ({ observationId, representationId, stepId, spanIds }) => {
        const entry = observations.get(observationId);
        if (!entry) throw new Error("Source access named an observation this run did not acquire.");
        return recordExternalInputAccess(externalInputs, {
          inputId: entry.observation.inputId,
          stepId,
          outcome: "opened",
          observedContentDigestSha256: createHash("sha256").update(entry.derivative).digest("hex"),
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
      now,
    }),
  );
  const service = {
    bindRun(reference: unknown, context: SourceRunAdmissionContextV1) {
      const capability = innerService.bindRun(reference, context);
      seedHostOpenedMergedMrReads(capability, requestWorkflow);
      return capability;
    },
  };
  const repositoryContentDigest = sourceRepositoryContentDigest({
    identitySha256: repository.identitySha256,
    revision: repository.revision,
    treeSha256: await workspaceTreeDigest(input.workspace),
  });
  return {
    reference: createSourceArtifactReference({
      kind: "source-binding",
      digest: acquired.binding.bindingSha256,
      repositoryRevision: repository.revision,
      repositoryContentDigest,
    }),
    runnerBinding: {
      service,
      workspaceIdentitySha256,
      repositoryContentDigest,
      policy,
      ...(input.readBudget ? { readBudgetBasis: input.readBudget.basis } : {}),
    },
    acquired: {
      binding: acquired.binding,
      acquired: acquired.acquired,
      producerScopes: acquired.producerScopes,
      readScope: ["gitlab-mr"],
    },
  };
}
