// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Deterministic, read-only documentation change-impact observation.
 *
 * This layer nominates relevant documentation. It never decides that an empty
 * result proves no change and it never grants authoring or publication.
 */

import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { createContractKit, type ContractFail } from "../contract-kit/index.js";
import { canonicalDigest, sha256 } from "../content-ir/canonical.js";
import { buildContentIndexV2 } from "../content-ir/indexer.js";
import type {
  ReaderContextComparisonV1,
  ReaderContextProvenanceSourceV1,
  ReaderContextSourceRoleV1,
} from "../context/reader-context.js";
import {
  READER_CONTEXT_CHANGED_SOURCE_INAPPLICABLE_LIMITATION,
  validateReaderContextComparisonV1,
} from "../context/reader-context.js";
import {
  type RepositoryDiscoveryInventoryV1,
  validateRepositoryDiscoveryInventoryAuthority,
} from "../repository/inventory.js";
import {
  RepositoryWorkspaceReadError,
  type RepositoryWorkspace,
} from "../repository/workspace/contracts.js";
import {
  readTrackedRepositoryFile,
  verifyTrackedRepositoryEntries,
} from "../repository/workspace/tracked-read.js";
import {
  createDocChangeDelta,
  type DocChangeDeltaEntryV1,
  type DocChangeDeltaV1,
} from "./doc-change-delta.js";
import { fetchDocumentationSection, type SectionFetchResultV1 } from "./section-fetch.js";
import { projectTalkTree, type TalkTreePageV1 } from "./talk-tree.js";

export const CHANGE_IMPACT_KIND = "docsfab-change-impact" as const;
export const CHANGE_IMPACT_DISPOSITIONS = [
  "candidates",
  "candidate-absence",
  "insufficient-evidence",
] as const;
export type ChangeImpactDisposition = (typeof CHANGE_IMPACT_DISPOSITIONS)[number];
export type ChangeImpactSearchMode = "observe" | "revalidate" | "reuse";

/** Operator comparison intent before the host resolves the current workspace snapshot. */
export type ReaderComparisonRequestV1 =
  | { readonly kind: "base-head"; readonly baseRevision: string; readonly headRevision: string }
  | { readonly kind: "workspace" };

export type ChangeImpactErrorCode =
  | "invalid-shape"
  | "invalid-value"
  | "digest-mismatch"
  | "credential-material"
  | "migration-required"
  | "schema-mismatch"
  | "index-unavailable"
  | "denied-path"
  | "snapshot-changed"
  | "evidence-contradiction";

export class ChangeImpactError extends Error {
  public constructor(public readonly code: ChangeImpactErrorCode) {
    super(`Change impact rejected: ${code}.`);
    this.name = "ChangeImpactError";
  }
}

function fail(code: ChangeImpactErrorCode): never {
  throw new ChangeImpactError(code);
}

const {
  assertInert,
  rejectCredentials,
  object,
  exact,
  array,
  string,
  hash,
  revision,
  enumeration,
} = createContractKit({
  fail: fail as ContractFail<ChangeImpactErrorCode>,
  inertMode: "strict",
  codes: {
    invalidShape: "invalid-shape",
    invalidValue: "invalid-value",
    digestMismatch: "digest-mismatch",
    credentialMaterial: "credential-material",
    schemaMismatch: "migration-required",
  },
});

const DOCUMENTATION_PATH =
  /(?:^|\/)(?:[^/]+\.(?:md|mdx|rst)|README|CONTRIBUTING)(?:\.(?:md|mdx|rst))?$/iu;
const SAFE_STABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/u;
const SAFE_TOKEN = /--[a-z][a-z0-9-]{2,127}|[A-Za-z_][A-Za-z0-9_.-]{3,127}/gu;
const BORING_TOKENS = new Set([
  "const",
  "default",
  "export",
  "false",
  "function",
  "import",
  "return",
  "string",
  "true",
]);
const MAX_SOURCES = 128;
const MAX_SOURCE_BYTES = 1024 * 1024;
const MAX_RELATIONSHIP_BYTES = 8 * 1024 * 1024;
const MAX_CANDIDATES = 128;
const execFileAsync = promisify(execFile);
const MAX_CHANGED_PATH_BYTES = 8 * 1024 * 1024;
const changeImpactAuthorities = new WeakMap<object, ChangeImpactAuthorityState>();

export interface ChangeImpactCandidateV1 {
  path: string;
  headingId: string | null;
  reason: "direct-documentation" | "filename-nomination" | "source-document-relationship";
  /** Shared lexical terms are nomination evidence only, never semantic proof. */
  relatedTerms: string[];
}

export interface ChangeImpactBindingsV1 {
  repositoryIdentitySha256: string;
  repositoryRevision: string;
  repositoryContentDigestSha256: string;
  sourceRunRecordSha256: string;
}

export interface ChangeImpactObservationEvidenceV1 {
  workspaceSnapshotSha256: string;
  inventoryEvidenceSha256: string;
  navigationEvidenceSha256: string;
  inventoryComplete: boolean;
  navigationComplete: boolean;
}

export interface ChangeImpactCoverageV1 {
  comparison: boolean;
  changedSource: boolean;
  currentDocumentation: boolean;
  publicContract: boolean;
  inventory: boolean;
  navigation: boolean;
}

export interface ChangeImpactVerifiedSourceV1 extends ReaderContextProvenanceSourceV1 {
  byteLength: number;
}

export type ChangeImpactSectionEvidenceV1 = Pick<
  SectionFetchResultV1,
  | "repositoryRevision"
  | "workspaceSnapshotSha256"
  | "path"
  | "headingId"
  | "sectionId"
  | "startLine"
  | "endLine"
  | "byteLength"
  | "digest"
  | "evidenceSha256"
>;

export interface ChangeImpactAssessmentV1 {
  schemaVersion: 1;
  kind: typeof CHANGE_IMPACT_KIND;
  disposition: ChangeImpactDisposition;
  comparison: ReaderContextComparisonV1;
  repositoryRevision: string;
  workspaceSnapshotSha256: string;
  changedPaths: string[];
  candidates: ChangeImpactCandidateV1[];
  verifiedSources: ChangeImpactVerifiedSourceV1[];
  sectionEvidence: ChangeImpactSectionEvidenceV1[];
  coverage: ChangeImpactCoverageV1;
  limitations: string[];
  consultedNodeIds: string[];
  treeSha256: string;
  observationEvidenceSha256: string | null;
  invalidatedEvidenceSha256s: string[];
  inputSha256: string;
  assessmentSha256: string;
}

export interface AssessChangeImpactInput {
  repositoryPath: string;
  changedPaths: readonly string[];
  comparison: ReaderContextComparisonV1;
  workspaceSnapshotSha256: string;
  sources: readonly ReaderContextProvenanceSourceV1[];
  bindings: ChangeImpactBindingsV1;
  observationEvidence?: ChangeImpactObservationEvidenceV1;
  includePaths?: readonly string[];
  mode?: ChangeImpactSearchMode;
  previousAssessment?: ChangeImpactAssessmentV1;
}

export interface ChangeImpactPreflightV1 {
  assessment: ChangeImpactAssessmentV1;
  delta: DocChangeDeltaV1;
}

export interface ChangeImpactReadAuthorityV1 {
  readonly kind: "docsfab-change-impact-read-authority";
}

export type VerifyChangeImpactSourceRunRecord = (input: {
  readonly sourceRunRecordSha256: string;
  readonly repository: {
    readonly sourcePath: string;
    readonly requestedRevision: string;
    readonly revision: string;
    readonly identitySha256: string;
    readonly contentDigestSha256: string;
    readonly workspaceSnapshotSha256: string;
  };
}) => Promise<string>;

interface ChangeImpactAuthorityState {
  workspace: RepositoryWorkspace;
  inventory: RepositoryDiscoveryInventoryV1;
  contentIndex: Awaited<ReturnType<typeof buildContentIndexV2>>;
  inputSha256: string;
}

/**
 * Host-only admission for complete change-impact evidence. The active workspace
 * and inventory are opaque capabilities; the run-record verifier must resolve
 * the retained record outside model-controlled input.
 */
export async function admitChangeImpactReadAuthority(input: {
  request: AssessChangeImpactInput;
  workspace: RepositoryWorkspace;
  inventory: RepositoryDiscoveryInventoryV1;
  verifySourceRunRecord: VerifyChangeImpactSourceRunRecord;
}): Promise<ChangeImpactReadAuthorityV1> {
  const normalized = normalizeInput(input.request);
  const inventory = validateRepositoryDiscoveryInventoryAuthority(input.inventory, {
    sourcePath: input.workspace.sourcePath,
    requestedRevision: input.workspace.requestedRevision,
    revision: input.workspace.revision,
  });
  const workspaceRoot = await realpath(input.workspace.path).catch(() => fail("denied-path"));
  const requestedRoot = await realpath(normalized.repositoryPath).catch(() => fail("denied-path"));
  if (
    workspaceRoot !== requestedRoot ||
    normalized.workspaceSnapshotSha256 !== inventory.inventorySha256 ||
    normalized.bindings.repositoryRevision !== input.workspace.revision
  ) {
    fail("evidence-contradiction");
  }
  const contentIndex = await buildContentIndexV2({ workspace: input.workspace }).catch(() =>
    fail("index-unavailable"),
  );
  const repositoryIdentitySha256 = sha256(new TextEncoder().encode(input.workspace.sourcePath));
  let sourceRunRecordSha256: string;
  try {
    sourceRunRecordSha256 = await input.verifySourceRunRecord({
      sourceRunRecordSha256: normalized.bindings.sourceRunRecordSha256,
      repository: {
        sourcePath: input.workspace.sourcePath,
        requestedRevision: input.workspace.requestedRevision,
        revision: input.workspace.revision,
        identitySha256: repositoryIdentitySha256,
        contentDigestSha256: contentIndex.repository.contentDigest,
        workspaceSnapshotSha256: inventory.inventorySha256,
      },
    });
  } catch {
    fail("evidence-contradiction");
  }
  const expectedBindings: ChangeImpactBindingsV1 = {
    repositoryIdentitySha256,
    repositoryRevision: input.workspace.revision,
    repositoryContentDigestSha256: contentIndex.repository.contentDigest,
    sourceRunRecordSha256,
  };
  if (canonicalDigest(expectedBindings) !== canonicalDigest(normalized.bindings)) {
    fail("evidence-contradiction");
  }
  await assertObservedComparisonAndPaths(normalized, input.workspace);
  assertObservationMatchesInventory(normalized.observationEvidence, inventory);
  if (normalized.includePaths !== undefined) fail("evidence-contradiction");
  const authority = Object.freeze({
    kind: "docsfab-change-impact-read-authority" as const,
  });
  changeImpactAuthorities.set(authority, {
    workspace: input.workspace,
    inventory,
    contentIndex,
    inputSha256: normalized.inputSha256,
  });
  return authority;
}

/** Strict shape/seal decoder for retained or reused observation evidence. */
export function decodeChangeImpactAssessment(value: unknown): ChangeImpactAssessmentV1 {
  assertInert(value);
  rejectCredentials(value);
  const root = object(value);
  exact(root, [
    "schemaVersion",
    "kind",
    "disposition",
    "comparison",
    "repositoryRevision",
    "workspaceSnapshotSha256",
    "changedPaths",
    "candidates",
    "verifiedSources",
    "sectionEvidence",
    "coverage",
    "limitations",
    "consultedNodeIds",
    "treeSha256",
    "observationEvidenceSha256",
    "invalidatedEvidenceSha256s",
    "inputSha256",
    "assessmentSha256",
  ]);
  if (root.schemaVersion !== 1 || root.kind !== CHANGE_IMPACT_KIND) fail("schema-mismatch");
  const comparison = validateReaderContextComparisonV1(root.comparison);
  const repositoryRevision = revision(root.repositoryRevision);
  const workspaceSnapshotSha256 = hash(root.workspaceSnapshotSha256);
  const changedPaths = array(root.changedPaths).map(normalizeChangedPath);
  if (!strictlySortedUnique(changedPaths)) fail("invalid-value");
  const candidates = array(root.candidates).map(decodeCandidate);
  if (candidates.length > MAX_CANDIDATES || !uniqueCanonical(candidates)) fail("invalid-value");
  const verifiedSources = array(root.verifiedSources).map(decodeVerifiedSource);
  if (verifiedSources.length > MAX_SOURCES || !uniqueCanonical(verifiedSources))
    fail("invalid-value");
  const sectionEvidence = array(root.sectionEvidence).map((item) =>
    decodeSectionEvidence(item, repositoryRevision, workspaceSnapshotSha256),
  );
  if (sectionEvidence.length > MAX_CANDIDATES || !uniqueCanonical(sectionEvidence)) {
    fail("invalid-value");
  }
  const coverage = decodeCoverage(root.coverage);
  const limitations = array(root.limitations).map((item) => boundedCode(item));
  if (!strictlySortedUnique(limitations)) fail("invalid-value");
  const consultedNodeIds = array(root.consultedNodeIds).map((item) => boundedId(item));
  const invalidatedEvidenceSha256s = array(root.invalidatedEvidenceSha256s).map((item) =>
    hash(item),
  );
  if (!uniqueCanonical(consultedNodeIds) || !uniqueCanonical(invalidatedEvidenceSha256s)) {
    fail("invalid-value");
  }
  const disposition = enumeration(root.disposition, CHANGE_IMPACT_DISPOSITIONS);
  const complete = Object.values(coverage).every(Boolean);
  if (
    (complete && candidates.length > 0 && disposition !== "candidates") ||
    (complete && candidates.length === 0 && disposition !== "candidate-absence") ||
    (!complete && disposition !== "insufficient-evidence")
  ) {
    fail("invalid-value");
  }
  const body = {
    schemaVersion: 1 as const,
    kind: CHANGE_IMPACT_KIND,
    disposition,
    comparison,
    repositoryRevision,
    workspaceSnapshotSha256,
    changedPaths,
    candidates,
    verifiedSources,
    sectionEvidence,
    coverage,
    limitations,
    consultedNodeIds,
    treeSha256: hash(root.treeSha256),
    observationEvidenceSha256:
      root.observationEvidenceSha256 === null ? null : hash(root.observationEvidenceSha256),
    invalidatedEvidenceSha256s,
    inputSha256: hash(root.inputSha256),
  };
  if (hash(root.assessmentSha256) !== canonicalDigest(body)) fail("digest-mismatch");
  return { ...body, assessmentSha256: root.assessmentSha256 as string };
}

interface ReadSource extends ChangeImpactVerifiedSourceV1 {
  contents: string;
}

function isRepositoryRelativePath(value: string): boolean {
  return (
    value === value.normalize("NFC") &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    !value.startsWith("/") &&
    value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..")
  );
}

function normalizeChangedPath(value: unknown): string {
  const path = string(value);
  if (!isRepositoryRelativePath(path)) fail("invalid-value");
  return path;
}

function fileStem(path: string): string {
  const base = path.split("/").at(-1) ?? path;
  return base.replace(/\.[^.]+$/u, "").toLowerCase();
}

function contentTerms(contents: string): Set<string> {
  const terms = new Set<string>();
  for (const match of contents.matchAll(SAFE_TOKEN)) {
    const term = match[0]!.toLowerCase();
    if (!BORING_TOKENS.has(term)) terms.add(term);
    if (terms.size >= 512) break;
  }
  return terms;
}

function sharedTerms(left: string, right: string): string[] {
  const rightTerms = contentTerms(right);
  return [...contentTerms(left)]
    .filter((term) => rightTerms.has(term))
    .sort()
    .slice(0, 32);
}

function matchCandidates(
  changedPaths: readonly string[],
  pages: readonly TalkTreePageV1[],
  sources: readonly ReadSource[],
): { candidates: ChangeImpactCandidateV1[]; truncated: boolean } {
  const candidates: ChangeImpactCandidateV1[] = [];
  const seen = new Set<string>();
  let truncated = false;
  const add = (candidate: ChangeImpactCandidateV1) => {
    const key = `${candidate.path}#${candidate.headingId ?? ""}`;
    if (seen.has(key)) return;
    if (candidates.length >= MAX_CANDIDATES) {
      truncated = true;
      return;
    }
    seen.add(key);
    candidates.push(candidate);
  };
  const pageSources = new Map(
    sources
      .filter((source) => source.role === "current-documentation")
      .map((source) => [source.uri, source]),
  );
  const changedSources = sources.filter(
    (source) => source.role === "changed-source" && changedPaths.includes(source.uri),
  );

  for (const changed of changedPaths) {
    if (DOCUMENTATION_PATH.test(changed)) {
      const page = pages.find((item) => item.path === changed);
      if (page) addPage(page, "direct-documentation", [], add);
      continue;
    }
    const stem = fileStem(changed);
    if (stem.length >= 3) {
      for (const page of pages) {
        const pageStem = fileStem(page.path);
        if (
          page.path.toLowerCase().includes(stem) ||
          pageStem.includes(stem) ||
          stem.includes(pageStem)
        ) {
          addPage(page, "filename-nomination", [], add);
        }
      }
    }
  }

  for (const source of changedSources) {
    for (const page of pages) {
      const document = pageSources.get(page.path);
      if (!document) continue;
      const terms = sharedTerms(source.contents, document.contents);
      if (terms.length > 0) addPage(page, "source-document-relationship", terms, add);
    }
  }

  return {
    candidates: candidates.sort((left, right) =>
      `${left.path}\0${left.headingId ?? ""}`.localeCompare(
        `${right.path}\0${right.headingId ?? ""}`,
      ),
    ),
    truncated,
  };
}

function addPage(
  page: TalkTreePageV1,
  reason: ChangeImpactCandidateV1["reason"],
  relatedTerms: string[],
  add: (candidate: ChangeImpactCandidateV1) => void,
): void {
  if (page.headings.length === 0) {
    add({ path: page.path, headingId: null, reason, relatedTerms });
    return;
  }
  for (const heading of page.headings) {
    add({ path: page.path, headingId: heading.headingId, reason, relatedTerms });
  }
}

function stableId(path: string, headingId: string | null): string {
  const raw = headingId ? `impact:${path}#${headingId}` : `impact:${path}`;
  const id = raw.replace(/[^A-Za-z0-9._:/-]/gu, "-");
  return SAFE_STABLE_ID.test(id) ? id : `impact:${sha256(raw).slice(0, 32)}`;
}

function deltaEntries(candidates: readonly ChangeImpactCandidateV1[]): DocChangeDeltaEntryV1[] {
  return candidates.map((candidate) => ({
    section: "modified" as const,
    stableId: stableId(candidate.path, candidate.headingId),
    codes: ["documentation-impact-candidate"],
    labels: [candidate.reason],
    evidence: {
      observationSha256: canonicalDigest(candidate),
      findingSha256: null,
      artifactRefSha256: null,
    },
    displayLifecycle: "open" as const,
  }));
}

export function projectChangeImpactDelta(input: {
  assessment: ChangeImpactAssessmentV1;
  bindings: ChangeImpactBindingsV1;
}): DocChangeDeltaV1 {
  assertInert(input);
  rejectCredentials(input);
  return createDocChangeDelta({
    repositoryIdentitySha256: input.bindings.repositoryIdentitySha256,
    repositoryRevision: input.bindings.repositoryRevision,
    repositoryContentDigestSha256: input.bindings.repositoryContentDigestSha256,
    sourceRunRecordSha256: input.bindings.sourceRunRecordSha256,
    sourceLedgerSha256: null,
    entries: deltaEntries(input.assessment.candidates),
    trackerMutation: "not-authorized",
  });
}

export async function assessChangeImpact(
  input: AssessChangeImpactInput,
  authority: ChangeImpactReadAuthorityV1,
): Promise<ChangeImpactPreflightV1> {
  const normalized = normalizeInput(input);
  const admitted = changeImpactAuthorities.get(authority);
  if (!admitted || admitted.inputSha256 !== normalized.inputSha256) {
    fail("evidence-contradiction");
  }
  if (normalized.mode === "reuse") return reuseAssessment(normalized);

  validateRepositoryDiscoveryInventoryAuthority(admitted.inventory, {
    sourcePath: admitted.workspace.sourcePath,
    requestedRevision: admitted.workspace.requestedRevision,
    revision: admitted.workspace.revision,
  });
  if (
    (await verifyTrackedRepositoryEntries(admitted.workspace)).some(
      (entry) => entry.status === "changed",
    )
  ) {
    fail("snapshot-changed");
  }
  const tree = projectTalkTree(admitted.contentIndex, admitted.inventory.inventorySha256);
  const { verified, limitations: sourceLimitations } = await verifySources(
    admitted.workspace,
    normalized.sources,
  );
  const matched = matchCandidates(normalized.changedPaths, tree.pages, verified);
  const limitations = new Set<string>(sourceLimitations);
  const coverage = coverageFor(normalized, verified, limitations);
  if (matched.truncated) limitations.add("candidate-limit-exceeded");
  if (normalized.changedPaths.length === 0) limitations.add("changed-paths-empty");
  const sectionEvidence = await fetchCandidateSections(normalized, matched.candidates, admitted);
  if (
    (await verifyTrackedRepositoryEntries(admitted.workspace)).some(
      (entry) => entry.status === "changed",
    )
  ) {
    fail("snapshot-changed");
  }
  const complete = Object.values(coverage).every(Boolean) && !matched.truncated;
  const disposition: ChangeImpactDisposition = !complete
    ? "insufficient-evidence"
    : matched.candidates.length > 0
      ? "candidates"
      : "candidate-absence";
  const observationEvidenceSha256 = normalized.observationEvidence
    ? canonicalDigest(normalized.observationEvidence)
    : null;
  const invalidatedEvidenceSha256s =
    normalized.mode === "revalidate" &&
    normalized.previousAssessment &&
    normalized.previousAssessment.workspaceSnapshotSha256 !== normalized.workspaceSnapshotSha256
      ? [normalized.previousAssessment.assessmentSha256]
      : [];
  const body = {
    schemaVersion: 1 as const,
    kind: CHANGE_IMPACT_KIND,
    disposition,
    comparison: normalized.comparison,
    repositoryRevision: normalized.bindings.repositoryRevision,
    workspaceSnapshotSha256: normalized.workspaceSnapshotSha256,
    changedPaths: [...normalized.changedPaths],
    candidates: matched.candidates,
    verifiedSources: verified.map(({ contents: _contents, ...source }) => source),
    sectionEvidence,
    coverage,
    limitations: [...limitations].sort(),
    consultedNodeIds: tree.pages.flatMap((page) => [
      page.documentId,
      ...page.headings.map((heading) => heading.sectionId),
    ]),
    treeSha256: tree.treeSha256,
    observationEvidenceSha256,
    invalidatedEvidenceSha256s,
    inputSha256: normalized.inputSha256,
  };
  const assessment = decodeChangeImpactAssessment({
    ...body,
    assessmentSha256: canonicalDigest(body),
  });
  assertRevalidation(normalized, assessment);
  return {
    assessment,
    delta: projectChangeImpactDelta({ assessment, bindings: normalized.bindings }),
  };
}

function normalizeInput(input: AssessChangeImpactInput): Required<
  Pick<
    AssessChangeImpactInput,
    | "repositoryPath"
    | "changedPaths"
    | "comparison"
    | "workspaceSnapshotSha256"
    | "sources"
    | "bindings"
    | "mode"
  >
> &
  Pick<AssessChangeImpactInput, "observationEvidence" | "includePaths" | "previousAssessment"> & {
    inputSha256: string;
  } {
  assertInert(input);
  rejectCredentials(input);
  const root = object(input as unknown);
  exact(
    root,
    [
      "repositoryPath",
      "changedPaths",
      "comparison",
      "workspaceSnapshotSha256",
      "sources",
      "bindings",
      "observationEvidence",
      "includePaths",
      "mode",
      "previousAssessment",
    ],
    ["observationEvidence", "includePaths", "mode", "previousAssessment"],
  );
  const repositoryPath = string(root.repositoryPath);
  const changedPaths = [...new Set(array(root.changedPaths).map(normalizeChangedPath))].sort();
  const comparison = validateReaderContextComparisonV1(root.comparison);
  const workspaceSnapshotSha256 = hash(root.workspaceSnapshotSha256);
  const sources = array(root.sources).map(decodeSource);
  if (sources.length < 1 || sources.length > MAX_SOURCES) fail("invalid-value");
  const sourceKeys = sources.map((source) => canonicalDigest(source));
  if (new Set(sourceKeys).size !== sourceKeys.length) fail("invalid-value");
  const bindingsRoot = object(root.bindings);
  exact(bindingsRoot, [
    "repositoryIdentitySha256",
    "repositoryRevision",
    "repositoryContentDigestSha256",
    "sourceRunRecordSha256",
  ]);
  const bindings = {
    repositoryIdentitySha256: hash(bindingsRoot.repositoryIdentitySha256),
    repositoryRevision: revision(bindingsRoot.repositoryRevision),
    repositoryContentDigestSha256: hash(bindingsRoot.repositoryContentDigestSha256),
    sourceRunRecordSha256: hash(bindingsRoot.sourceRunRecordSha256),
  };
  const observationEvidence = decodeObservationEvidence(root.observationEvidence);
  const includePaths =
    root.includePaths === undefined
      ? undefined
      : [...new Set(array(root.includePaths).map(normalizeChangedPath))].sort();
  const mode =
    root.mode === undefined
      ? ("observe" as const)
      : enumeration(root.mode, ["observe", "revalidate", "reuse"] as const);
  const previousAssessment =
    root.previousAssessment === undefined
      ? undefined
      : decodeChangeImpactAssessment(root.previousAssessment);
  if ((mode === "observe") === Boolean(previousAssessment)) fail("invalid-value");
  const identity = {
    comparison,
    repositoryRevision: bindings.repositoryRevision,
    workspaceSnapshotSha256,
    changedPaths,
    sources,
    observationEvidence: observationEvidence ?? null,
    includePaths: includePaths ?? null,
    bindings,
  };
  return {
    repositoryPath,
    changedPaths,
    comparison,
    workspaceSnapshotSha256,
    sources,
    bindings,
    mode,
    ...(observationEvidence ? { observationEvidence } : {}),
    ...(includePaths ? { includePaths } : {}),
    ...(previousAssessment ? { previousAssessment } : {}),
    inputSha256: canonicalDigest(identity),
  };
}

function decodeSource(value: unknown): ReaderContextProvenanceSourceV1 {
  const root = object(value);
  exact(root, ["uri", "sha256", "role"]);
  const uri = string(root.uri);
  if (!uri || uri.length > 4_096 || uri !== uri.normalize("NFC") || uri.includes("\0")) {
    fail("invalid-value");
  }
  return {
    uri,
    sha256: hash(root.sha256),
    role: enumeration(root.role, [
      "public-contract",
      "changed-source",
      "current-documentation",
      "repository-instruction",
      "accepted-knowledge",
      "request",
    ] as const) as ReaderContextSourceRoleV1,
  };
}

function decodeVerifiedSource(value: unknown): ChangeImpactVerifiedSourceV1 {
  const root = object(value);
  exact(root, ["uri", "sha256", "role", "byteLength"]);
  const source = decodeSource({ uri: root.uri, sha256: root.sha256, role: root.role });
  if (
    typeof root.byteLength !== "number" ||
    !Number.isSafeInteger(root.byteLength) ||
    root.byteLength < 0 ||
    root.byteLength > MAX_SOURCE_BYTES
  ) {
    fail("invalid-value");
  }
  return { ...source, byteLength: root.byteLength };
}

function decodeCandidate(value: unknown): ChangeImpactCandidateV1 {
  const root = object(value);
  exact(root, ["path", "headingId", "reason", "relatedTerms"]);
  const path = normalizeChangedPath(root.path);
  const headingId = root.headingId === null ? null : boundedId(root.headingId);
  const reason = enumeration(root.reason, [
    "direct-documentation",
    "filename-nomination",
    "source-document-relationship",
  ] as const);
  const relatedTerms = array(root.relatedTerms).map((item) => boundedCode(item));
  if (relatedTerms.length > 32 || !strictlySortedUnique(relatedTerms)) fail("invalid-value");
  if ((reason === "source-document-relationship") !== relatedTerms.length > 0) {
    fail("invalid-value");
  }
  return { path, headingId, reason, relatedTerms };
}

function decodeSectionEvidence(
  value: unknown,
  repositoryRevision: string,
  workspaceSnapshotSha256: string,
): ChangeImpactSectionEvidenceV1 {
  const root = object(value);
  exact(root, [
    "repositoryRevision",
    "workspaceSnapshotSha256",
    "path",
    "headingId",
    "sectionId",
    "startLine",
    "endLine",
    "byteLength",
    "digest",
    "evidenceSha256",
  ]);
  if (
    revision(root.repositoryRevision) !== repositoryRevision ||
    hash(root.workspaceSnapshotSha256) !== workspaceSnapshotSha256
  ) {
    fail("snapshot-changed");
  }
  const result = {
    repositoryRevision,
    workspaceSnapshotSha256,
    path: normalizeChangedPath(root.path),
    headingId: boundedId(root.headingId),
    sectionId: boundedId(root.sectionId),
    startLine: positiveInteger(root.startLine),
    endLine: positiveInteger(root.endLine),
    byteLength: positiveInteger(root.byteLength),
    digest: hash(root.digest),
    evidenceSha256: hash(root.evidenceSha256),
  };
  if (result.endLine < result.startLine) fail("invalid-value");
  return result;
}

function decodeCoverage(value: unknown): ChangeImpactCoverageV1 {
  const root = object(value);
  exact(root, [
    "comparison",
    "changedSource",
    "currentDocumentation",
    "publicContract",
    "inventory",
    "navigation",
  ]);
  for (const value of Object.values(root)) {
    if (typeof value !== "boolean") fail("invalid-value");
  }
  return root as unknown as ChangeImpactCoverageV1;
}

function boundedId(value: unknown): string {
  const result = string(value);
  if (
    !result ||
    result.length > 512 ||
    result !== result.normalize("NFC") ||
    /[\s\0]/u.test(result)
  ) {
    fail("invalid-value");
  }
  return result;
}

function boundedCode(value: unknown): string {
  const result = string(value);
  if (
    !result ||
    result.length > 128 ||
    result !== result.normalize("NFC") ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(result)
  ) {
    fail("invalid-value");
  }
  return result;
}

function positiveInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    fail("invalid-value");
  }
  return value;
}

function uniqueCanonical(values: readonly unknown[]): boolean {
  return new Set(values.map((value) => canonicalDigest(value))).size === values.length;
}

function strictlySortedUnique(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || values[index - 1]! < value);
}

function decodeObservationEvidence(value: unknown): ChangeImpactObservationEvidenceV1 | undefined {
  if (value === undefined) return undefined;
  const root = object(value);
  exact(root, [
    "workspaceSnapshotSha256",
    "inventoryEvidenceSha256",
    "navigationEvidenceSha256",
    "inventoryComplete",
    "navigationComplete",
  ]);
  if (typeof root.inventoryComplete !== "boolean" || typeof root.navigationComplete !== "boolean") {
    fail("invalid-value");
  }
  return {
    workspaceSnapshotSha256: hash(root.workspaceSnapshotSha256),
    inventoryEvidenceSha256: hash(root.inventoryEvidenceSha256),
    navigationEvidenceSha256: hash(root.navigationEvidenceSha256),
    inventoryComplete: root.inventoryComplete,
    navigationComplete: root.navigationComplete,
  };
}

async function verifySources(
  workspace: RepositoryWorkspace,
  sources: readonly ReaderContextProvenanceSourceV1[],
): Promise<{ verified: ReadSource[]; limitations: string[] }> {
  const verified: ReadSource[] = [];
  const limitations = new Set<string>();
  let totalBytes = 0;
  for (const source of sources) {
    if (!isRepositoryRelativePath(source.uri)) {
      limitations.add("source-locator-not-readable");
      continue;
    }
    try {
      const bytes = await readTrackedRepositoryFile(workspace, source.uri, MAX_SOURCE_BYTES);
      if (bytes.byteLength > MAX_SOURCE_BYTES) {
        limitations.add("source-size-limit-exceeded");
        continue;
      }
      totalBytes += bytes.byteLength;
      if (totalBytes > MAX_RELATIONSHIP_BYTES) {
        limitations.add("relationship-scan-limit-exceeded");
        break;
      }
      if (sha256(bytes) !== source.sha256) fail("evidence-contradiction");
      let contents: string;
      try {
        contents = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        limitations.add("source-encoding-unsupported");
        continue;
      }
      if (contents.includes("\0")) {
        limitations.add("source-encoding-unsupported");
        continue;
      }
      verified.push({ ...source, byteLength: bytes.byteLength, contents });
    } catch (error) {
      if (error instanceof ChangeImpactError) throw error;
      if (error instanceof RepositoryWorkspaceReadError && error.code === "changed") {
        fail("snapshot-changed");
      }
      if (error instanceof RepositoryWorkspaceReadError && error.code === "oversize") {
        limitations.add("source-size-limit-exceeded");
        continue;
      }
      limitations.add("source-unavailable");
    }
  }
  return {
    verified: verified.sort((left, right) =>
      `${left.role}\0${left.uri}`.localeCompare(`${right.role}\0${right.uri}`),
    ),
    limitations: [...limitations],
  };
}

function coverageFor(
  input: ReturnType<typeof normalizeInput>,
  sources: readonly ReadSource[],
  limitations: Set<string>,
): ChangeImpactCoverageV1 {
  const comparison =
    input.comparison.kind === "base-head"
      ? input.comparison.head_revision === input.bindings.repositoryRevision
      : input.comparison.kind === "workspace"
        ? input.comparison.snapshot_sha256 === input.workspaceSnapshotSha256
        : false;
  if (!comparison) limitations.add("comparison-unknown-or-mismatched");
  const currentDocumentation = sources.some(
    (source) => source.role === "current-documentation" && DOCUMENTATION_PATH.test(source.uri),
  );
  const publicContract = sources.some((source) => source.role === "public-contract");
  const identicalRevisions =
    input.comparison.kind === "base-head" &&
    input.comparison.base_revision === input.comparison.head_revision &&
    input.changedPaths.length === 0;
  const workspaceChangedSource =
    input.comparison.kind === "workspace" &&
    input.comparison.snapshot_sha256 === input.workspaceSnapshotSha256 &&
    sources.some((source) => source.role === "changed-source");
  const changedSource =
    identicalRevisions ||
    workspaceChangedSource ||
    (input.changedPaths.length > 0 &&
      input.changedPaths.every((path) =>
        sources.some(
          (source) =>
            source.uri === path &&
            (source.role === "changed-source" ||
              (DOCUMENTATION_PATH.test(path) && source.role === "current-documentation")),
        ),
      ));
  if (!currentDocumentation) limitations.add("current-documentation-evidence-missing");
  if (!publicContract) limitations.add("public-contract-evidence-missing");
  if (identicalRevisions) {
    limitations.add(READER_CONTEXT_CHANGED_SOURCE_INAPPLICABLE_LIMITATION);
  } else if (!changedSource) {
    limitations.add("changed-source-evidence-missing");
  }
  const observation = input.observationEvidence;
  const observationMatches = observation?.workspaceSnapshotSha256 === input.workspaceSnapshotSha256;
  const inventory = Boolean(observationMatches && observation?.inventoryComplete);
  const navigation = Boolean(observationMatches && observation?.navigationComplete);
  if (!inventory) limitations.add("inventory-evidence-incomplete");
  if (!navigation) limitations.add("navigation-evidence-incomplete");
  return { comparison, changedSource, currentDocumentation, publicContract, inventory, navigation };
}

async function fetchCandidateSections(
  input: ReturnType<typeof normalizeInput>,
  candidates: readonly ChangeImpactCandidateV1[],
  authority: ChangeImpactAuthorityState,
): Promise<ChangeImpactSectionEvidenceV1[]> {
  const evidence: ChangeImpactSectionEvidenceV1[] = [];
  for (const candidate of candidates) {
    if (!candidate.headingId) continue;
    const result = await fetchDocumentationSection(
      {
        repositoryPath: input.repositoryPath,
        repositoryRevision: input.bindings.repositoryRevision,
        workspaceSnapshotSha256: input.workspaceSnapshotSha256,
        path: candidate.path,
        headingId: candidate.headingId,
        resolvedPath: resolve(input.repositoryPath, candidate.path),
      },
      { workspace: authority.workspace, inventory: authority.inventory },
    );
    const { bytes: _bytes, kind: _kind, depth: _depth, ...retained } = result;
    evidence.push(retained);
  }
  return evidence;
}

function assertObservationMatchesInventory(
  observation: ChangeImpactObservationEvidenceV1 | undefined,
  inventory: RepositoryDiscoveryInventoryV1,
): void {
  if (
    !observation ||
    observation.workspaceSnapshotSha256 !== inventory.inventorySha256 ||
    observation.inventoryEvidenceSha256 !== inventory.inventorySha256 ||
    observation.navigationEvidenceSha256 !== inventory.navigation.evidenceSha256 ||
    observation.inventoryComplete !== (inventory.status === "complete") ||
    observation.navigationComplete !== (inventory.coverage.navigation.status === "complete")
  ) {
    fail("evidence-contradiction");
  }
}

async function assertObservedComparisonAndPaths(
  input: ReturnType<typeof normalizeInput>,
  workspace: RepositoryWorkspace,
): Promise<void> {
  if (input.comparison.kind === "base-head") {
    if (input.comparison.head_revision !== workspace.revision) fail("evidence-contradiction");
    if (
      input.comparison.base_revision === input.comparison.head_revision &&
      input.sources.some((source) => source.role === "changed-source")
    ) {
      fail("evidence-contradiction");
    }
    const base = await hardenedGit(workspace.sourcePath, [
      "rev-parse",
      "--verify",
      `${input.comparison.base_revision}^{commit}`,
    ]);
    if (base.trim() !== input.comparison.base_revision) fail("evidence-contradiction");
    const changed = parseChangedPaths(
      await hardenedGit(workspace.sourcePath, [
        "diff",
        "--name-only",
        "-z",
        "--no-renames",
        "--no-ext-diff",
        "--no-textconv",
        input.comparison.base_revision,
        input.comparison.head_revision,
        "--",
      ]),
    );
    if (canonicalDigest(changed) !== canonicalDigest(input.changedPaths)) {
      fail("evidence-contradiction");
    }
    return;
  }
  if (
    input.comparison.kind === "workspace" &&
    input.comparison.snapshot_sha256 !== input.workspaceSnapshotSha256
  ) {
    fail("evidence-contradiction");
  }
  if (input.changedPaths.length !== 0) fail("evidence-contradiction");
}

async function hardenedGit(repositoryPath: string, args: readonly string[]): Promise<string> {
  try {
    const result = await execFileAsync(
      "git",
      [
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.pager=cat",
        "-c",
        "diff.external=",
        "-C",
        repositoryPath,
        ...args,
      ],
      {
        encoding: "utf8",
        maxBuffer: MAX_CHANGED_PATH_BYTES,
        env: {
          PATH: process.env.PATH,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_OPTIONAL_LOCKS: "0",
          LC_ALL: "C",
        },
      },
    );
    return result.stdout;
  } catch {
    fail("evidence-contradiction");
  }
}

function parseChangedPaths(output: string): string[] {
  const paths = output.split("\0").filter(Boolean).map(normalizeChangedPath).sort();
  if (new Set(paths).size !== paths.length) fail("evidence-contradiction");
  return paths;
}

function reuseAssessment(input: ReturnType<typeof normalizeInput>): ChangeImpactPreflightV1 {
  const previous = input.previousAssessment;
  if (!previous || previous.workspaceSnapshotSha256 !== input.workspaceSnapshotSha256) {
    fail("snapshot-changed");
  }
  if (previous.inputSha256 !== input.inputSha256) fail("evidence-contradiction");
  return {
    assessment: previous,
    delta: projectChangeImpactDelta({ assessment: previous, bindings: input.bindings }),
  };
}

function assertRevalidation(
  input: ReturnType<typeof normalizeInput>,
  assessment: ChangeImpactAssessmentV1,
): void {
  const previous = input.previousAssessment;
  if (!previous || input.mode !== "revalidate") return;
  if (previous.workspaceSnapshotSha256 !== assessment.workspaceSnapshotSha256) return;
  if (previous.inputSha256 !== assessment.inputSha256) fail("evidence-contradiction");
  const { assessmentSha256: _oldDigest, ...previousBody } = previous;
  const { assessmentSha256: _newDigest, ...currentBody } = assessment;
  if (canonicalDigest(previousBody) !== canonicalDigest(currentBody))
    fail("evidence-contradiction");
}

export function formatChangeImpactInstruction(assessment: ChangeImpactAssessmentV1): string {
  if (assessment.disposition !== "candidates") {
    return [
      "Deterministic documentation impact observation found no nominated section.",
      "Candidate absence is not a no-change conclusion.",
      `Evidence disposition: ${assessment.disposition}.`,
      `Limitations: ${assessment.limitations.join(", ") || "none"}.`,
      "Do not invent affected pages or claim no change from this observation alone.",
    ].join(" ");
  }
  const listed = assessment.candidates
    .map((candidate) =>
      candidate.headingId ? `${candidate.path}#${candidate.headingId}` : candidate.path,
    )
    .join(", ");
  return [
    "Deterministic documentation impact observation nominated these candidate sections:",
    listed,
    "Filename and lexical relationships nominate candidates only; inspect the bound section and source evidence.",
    "Do not expand to unrelated pages or edit files without separate authority.",
  ].join(" ");
}
