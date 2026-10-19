// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { deepFreeze } from "../contract-kit/freeze.js";
import {
  validateRoadmapMutationPlanV2,
  type RoadmapMutationOperationV2,
  type RoadmapMutationPlanV2,
} from "./execution-v2.js";
import { roadmapCanonicalJson, roadmapDigest } from "./contracts/decode.js";
import {
  assertPassiveDataGraph,
  closed,
  denseArray,
  ManagedIssueContractError,
  requireValue,
} from "./managed-issue/inert-data.js";
import { validateRoadmapLedger, type RoadmapLedger } from "./contracts/ledger.js";
import {
  assertMaterialForOperation,
  mutationMaterialBytes,
  mutationMaterialDigest,
  validateMutationMaterial,
  type IssueLifecycleMutationMaterial,
} from "./issue-adapter.js";

import {
  MANAGED_ISSUE_CONVENTION_VERSION,
  MANAGED_ISSUE_MARKER_NAME,
  SAFE_REFERENCE,
  carriesConfiguredCredential,
  descriptionText,
  digest,
  identifier,
  revision,
  text,
} from "./managed-issue/value-primitives.js";
import {
  assertManagedIssueMarkerMatchesIdentity,
  createManagedIssueStateBinding,
  extractManagedIssueMarker,
  renderManagedIssueMarker,
  validateIdentity,
  validateManagedIssueMarker,
  validateManagedIssueStateBinding,
} from "./managed-issue/identity-codecs.js";
export {
  MANAGED_ISSUE_CONVENTION_VERSION,
  MANAGED_ISSUE_MARKER_NAME,
} from "./managed-issue/value-primitives.js";
export {
  assertManagedIssueMarkerMatchesIdentity,
  createManagedIssueStateBinding,
  extractManagedIssueMarker,
  renderManagedIssueMarker,
  validateManagedIssueMarker,
  validateManagedIssueStateBinding,
} from "./managed-issue/identity-codecs.js";

export { ManagedIssueContractError } from "./managed-issue/inert-data.js";
export type { ManagedIssueContractErrorCode } from "./managed-issue/inert-data.js";

export const MANAGED_ISSUE_KINDS = Object.freeze([
  "saga",
  "epic",
  "task",
  "investigation",
] as const);
export type ManagedIssueKind = (typeof MANAGED_ISSUE_KINDS)[number];

/** Closed projection of the G0-G5 documentation-maturity cascade. */
export const MANAGED_ISSUE_GATES = Object.freeze(["g0", "g1", "g2", "g3", "g4", "g5"] as const);
export type ManagedIssueGate = (typeof MANAGED_ISSUE_GATES)[number];

export const MANAGED_ISSUE_WORKFLOWS = Object.freeze([
  "release-documentation",
  "documentation-health",
  "content-repair",
  "information-architecture",
  "investigation",
] as const);
export type ManagedIssueWorkflow = (typeof MANAGED_ISSUE_WORKFLOWS)[number];

export const MANAGED_ISSUE_PRIORITIES = Object.freeze(["p0", "p1", "p2"] as const);
export type ManagedIssuePriority = (typeof MANAGED_ISSUE_PRIORITIES)[number];

export const MANAGED_ISSUE_LIFECYCLES = Object.freeze([
  "filed",
  "ready",
  "selected",
  "in-progress",
  "in-review",
  "verified",
  "closed",
  "blocked",
  "duplicate",
  "superseded",
  "manually-detached",
] as const);
export type ManagedIssueLifecycle = (typeof MANAGED_ISSUE_LIFECYCLES)[number];

export const MANAGED_ISSUE_DISPOSITIONS = Object.freeze([
  "create",
  "reuse",
  "migration",
  "duplicate",
  "superseded",
  "manually-detached",
  "conflict",
] as const);
export type ManagedIssueDisposition = (typeof MANAGED_ISSUE_DISPOSITIONS)[number];

export const MANAGED_ISSUE_HUMAN_OWNED_FIELDS = Object.freeze([
  "title",
  "descriptive-prose",
  "assignees",
  "milestone",
  "due-date",
  "weight",
  "confidentiality",
  "human-labels",
] as const);

const SEMANTIC_EVIDENCE_KEY = /^evidence:[a-f0-9]{64}$/u;
const CONTROL = /[\u0000-\u001f\u007f]/u;
const CONTROLLED_LABEL_PREFIXES = Object.freeze([
  "gate::",
  "workflow::",
  "priority::",
  "lifecycle::",
] as const);
const TERMINAL_LIFECYCLES = Object.freeze([
  "closed",
  "blocked",
  "duplicate",
  "superseded",
  "manually-detached",
] as const satisfies readonly ManagedIssueLifecycle[]);
const ROADMAP_FINDING_DISPOSITIONS = Object.freeze([
  "documented",
  "no-doc-impact",
  "needs-update",
  "needs-new-doc",
  "healthy",
  "repair",
  "restructure",
  "investigate",
  "excluded",
  "blocked",
  "duplicate",
] as const);
const ROADMAP_FINDING_LIFECYCLES = Object.freeze([
  "observed",
  "proposed",
  "filed",
  "selected",
  "in-progress",
  "fixed",
  "verified",
  "closed",
  "blocked",
  "duplicate",
  "superseded",
] as const);
/** Matches GitLabRoadmapReader's authoritative 100-page × 100-issue scan. */
const MAX_OBSERVATIONS = 10_000;
const MAX_OBSERVATION_LABELS = 128;
const MAX_ASSIGNEES = 64;
const MAX_TEMPLATE_EVIDENCE = 64;
const MAX_TEMPLATE_PATHS = 256;
const MAX_TEMPLATE_ACCEPTANCE = 128;
const MAX_TEMPLATE_VERIFICATION = 128;
const MAX_TEMPLATE_DEPENDENCIES = 128;
const MAX_TEMPLATE_HUMAN_INPUT = 64;
const MAX_FINDING_PATHS = 256;
const MAX_FINDING_EVIDENCE = 256;
const MAX_FINDING_DEPENDENCIES = 256;

/**
 * The marker deliberately contains opaque identity only: no repository path,
 * issue prose, prompt, evidence text, credential, or model output.
 */
export interface ManagedIssueMarkerV1 {
  schemaVersion: typeof MANAGED_ISSUE_CONVENTION_VERSION;
  repositoryKeyDigest: string;
  findingFingerprint: string;
  identityDigest: string;
}

export interface ManagedIssueIdentityV1 {
  marker: ManagedIssueMarkerV1;
  findingId: string;
  ledgerDigest: string;
  repositoryStateDigest: string;
  testedRevision: string;
}

/** Revision/ledger evidence is intentionally separate from the stable issue marker. */
export interface ManagedIssueStateBindingV1 {
  schemaVersion: typeof MANAGED_ISSUE_CONVENTION_VERSION;
  markerIdentityDigest: string;
  findingId: string;
  ledgerDigest: string;
  repositoryStateDigest: string;
  testedRevision: string;
  digest: string;
}

export interface ManagedIssueLabels {
  gate: ManagedIssueGate;
  workflow: ManagedIssueWorkflow;
  priority: ManagedIssuePriority;
  lifecycle: ManagedIssueLifecycle;
}

export interface ManagedIssueTemplateInput {
  kind: ManagedIssueKind;
  summary: string;
  identity: ManagedIssueIdentityV1;
  labels: ManagedIssueLabels;
  evidence: string[];
  rationale: string;
  audienceImpact: string;
  pathScope: string[];
  acceptance: string[];
  verification: string[];
  dependencies: string[];
  requiredHumanInput: string[];
  parentIssueIid?: number;
}

export interface ManagedIssueDraft {
  title: string;
  description: string;
  labels: string[];
  parentIssueIid?: number;
}

export interface ManagedIssueObservation {
  iid: number;
  state: "opened" | "closed";
  title: string;
  description: string;
  labels: string[];
  assigneeIds?: number[];
  milestoneIid?: number;
  dueDate?: string;
  weight?: number;
  confidential?: boolean;
  /** Host-held content-free evidence; never parsed from human-editable issue prose. */
  stateBinding?: ManagedIssueStateBindingV1;
}

export interface ManagedIssuePatch {
  issueIid: number;
  /** Contains desired controlled labels plus all pre-existing human labels. */
  labels?: string[];
}

export interface ManagedIssueReconciliationInput {
  identity: ManagedIssueIdentityV1;
  observations: ManagedIssueObservation[];
  desiredLabels: ManagedIssueLabels;
}

export interface ManagedIssueReconciliation {
  disposition: ManagedIssueDisposition;
  issueIid?: number;
  ignoredUnmarkedIssueIids: number[];
  conflictingIssueIids: number[];
  patch?: ManagedIssuePatch;
  nextStateBinding?: ManagedIssueStateBindingV1;
  reasonCode: string;
}

export interface ManagedIssueMutationIdentityV2 {
  schemaVersion: 2;
  operationKey: string;
  idempotencyKey: string;
  proposalDigest: string;
  materialDigest: string;
  materialBytes: number;
  markerIdentityDigest: string;
  stateBindingDigest: string;
  digest: string;
}

export type ManagedIssueMutationMaterialInputV1 =
  | { kind: "create"; operationKey: string; template: ManagedIssueTemplateInput }
  | {
      kind: "update";
      operationKey: string;
      action: "add-labels" | "remove-labels";
      reconciliation: ManagedIssueReconciliationInput;
    };

export interface ManagedIssueMutationMaterialEvidenceV1 {
  kind: "managed-issue-mutation-material";
  schemaVersion: 1;
  intent: "create" | "update";
  materialDigest: string;
  materialBytes: number;
}

export interface ManagedIssueHierarchyLink {
  parentIssueIid: number;
  parentKind: "saga" | "epic";
  childIssueIid: number;
  childKind: "epic" | "task" | "investigation";
}

export function createManagedIssueMutationMaterialEvidenceV1(
  materialInput: ManagedIssueMutationMaterialInputV1,
  ledgerValue: RoadmapLedger,
  identityValue: ManagedIssueIdentityV1,
): ManagedIssueMutationMaterialEvidenceV1 {
  const material = managedMutationMaterial(materialInput, ledgerValue, identityValue);
  return deepFreeze({
    kind: "managed-issue-mutation-material",
    schemaVersion: 1,
    intent: material.intent,
    materialDigest: mutationMaterialDigest(material.value),
    materialBytes: mutationMaterialBytes(material.value),
  });
}

/**
 * Stable semantic identity v1. Production planning derives evidenceIds from
 * domain-separated canonical candidate-ID records, so this excludes
 * revision-bound boundary/evidence digests while retaining source, defect
 * category, path scope, and candidate identity.
 */
export function managedIssueFindingFingerprintV1(
  finding: RoadmapLedger["findings"][number],
): string {
  assertPassiveDataGraph(finding, "$.finding");
  const root = closed(finding, "$.finding", [
    "id",
    "boundaryId",
    "category",
    "severity",
    "affectedPaths",
    "evidenceIds",
    "materialEvidenceDigest",
    "fingerprint",
    "source",
    "disposition",
    "lifecycle",
    "dependsOnFindingIds",
  ]);
  const affectedPaths = stringArray(
    root.affectedPaths,
    "$.finding.affectedPaths",
    false,
    MAX_FINDING_PATHS,
    1,
  ).map((item, index) => safePath(item, `$.finding.affectedPaths[${index}]`));
  const evidenceIds = stringArray(
    root.evidenceIds,
    "$.finding.evidenceIds",
    false,
    MAX_FINDING_EVIDENCE,
    1,
  );
  const dependsOnFindingIds = stringArray(
    root.dependsOnFindingIds,
    "$.finding.dependsOnFindingIds",
    false,
    MAX_FINDING_DEPENDENCIES,
  ).map((item, index) => identifier(item, `$.finding.dependsOnFindingIds[${index}]`));
  requireValue(
    evidenceIds.every((item) => SEMANTIC_EVIDENCE_KEY.test(item)),
    "finding-mismatch",
    "$.finding.evidenceIds",
  );
  const validatedFinding = {
    id: identifier(root.id, "$.finding.id"),
    fingerprint: digest(root.fingerprint, "$.finding.fingerprint"),
    boundaryId: identifier(root.boundaryId, "$.finding.boundaryId"),
    category: identifier(root.category, "$.finding.category"),
    severity: enumeration(root.severity, MANAGED_ISSUE_PRIORITIES, "$.finding.severity"),
    affectedPaths,
    evidenceIds,
    materialEvidenceDigest: digest(root.materialEvidenceDigest, "$.finding.materialEvidenceDigest"),
    source: enumeration(
      root.source,
      ["release", "documentation-health"] as const,
      "$.finding.source",
    ),
    disposition: enumeration(
      root.disposition,
      ROADMAP_FINDING_DISPOSITIONS,
      "$.finding.disposition",
    ),
    lifecycle: enumeration(root.lifecycle, ROADMAP_FINDING_LIFECYCLES, "$.finding.lifecycle"),
    dependsOnFindingIds,
  };
  return roadmapDigest({
    contract: "docsfab-managed-finding-identity-v1",
    source: validatedFinding.source,
    category: validatedFinding.category,
    affectedPaths: validatedFinding.affectedPaths.sort(compare),
    semanticEvidenceKeys: validatedFinding.evidenceIds.sort(compare),
  });
}

export function createManagedIssueIdentity(
  ledgerValue: RoadmapLedger,
  findingId: string,
): ManagedIssueIdentityV1 {
  const ledger = validatedRoadmapLedger(ledgerValue);
  const finding = ledger.findings.find((candidate) => candidate.id === findingId);
  requireValue(finding !== undefined, "finding-mismatch", "$.findingId");
  const repositoryKeyDigest = roadmapDigest({
    contract: "docsfab-managed-repository-key-v1",
    provider: ledger.project.provider,
    host: ledger.project.host,
    projectId: ledger.project.projectId,
  });
  const repositoryStateDigest = roadmapDigest({
    contract: "docsfab-managed-repository-state-v1",
    repositoryKeyDigest,
    repository: ledger.repository,
  });
  const findingFingerprint = managedIssueFindingFingerprintV1(finding!);
  const collisions = ledger.findings.filter(
    (candidate) =>
      candidate.evidenceIds.every((item) => SEMANTIC_EVIDENCE_KEY.test(item)) &&
      managedIssueFindingFingerprintV1(candidate) === findingFingerprint,
  );
  requireValue(
    collisions.length === 1 && collisions[0]!.id === finding!.id,
    "ambiguous-match",
    "$.findingId",
  );
  const material = {
    schemaVersion: MANAGED_ISSUE_CONVENTION_VERSION,
    repositoryKeyDigest,
    findingFingerprint,
  };
  const marker = validateManagedIssueMarker({
    ...material,
    identityDigest: roadmapDigest(material),
  });
  return deepFreeze({
    marker,
    findingId: finding!.id,
    ledgerDigest: ledger.digest,
    repositoryStateDigest,
    testedRevision: ledger.repository.revision,
  });
}

export function managedIssueTitle(kind: ManagedIssueKind, summary: string): string {
  requireEnumeration(kind, MANAGED_ISSUE_KINDS, "$.kind");
  const safeSummary = safeSummaryText(summary);
  requireValue(!safeSummary.startsWith("[DocsFab]"), "invalid-value", "$.summary");
  return `[DocsFab][${titleCase(kind)}] ${safeSummary}`;
}

function safeSummaryText(value: unknown): string {
  return safeSummary(value, "$.summary");
}

export function managedIssueLabelNames(value: ManagedIssueLabels): string[] {
  const labels = validateLabelSelection(value);
  return [
    "docsfab-roadmap::managed",
    `gate::${labels.gate}`,
    `workflow::${labels.workflow}`,
    `priority::${labels.priority}`,
    `lifecycle::${labels.lifecycle}`,
  ];
}

export function validateManagedIssueLabels(value: unknown): ManagedIssueLabels {
  return validateLabelSelection(value);
}

export function renderManagedIssueDraft(inputValue: ManagedIssueTemplateInput): ManagedIssueDraft {
  const input = validateTemplateInput(inputValue);
  const title = managedIssueTitle(input.kind, input.summary);
  const sections = [
    renderList("Evidence", input.evidence),
    `## Tested revision\n\n\`${input.identity.testedRevision}\``,
    `## Rationale\n\n${input.rationale}`,
    `## Audience impact\n\n${input.audienceImpact}`,
    renderList(
      "Path scope",
      input.pathScope.map((path) => `\`${path}\``),
    ),
    `## Workflow\n\n\`${input.labels.workflow}\``,
    renderChecklist("Acceptance", input.acceptance),
    renderChecklist("Verification", input.verification),
    renderList("Dependencies", input.dependencies.length === 0 ? ["None."] : input.dependencies),
    renderChecklist(
      "Required human input",
      input.requiredHumanInput.length === 0 ? ["None."] : input.requiredHumanInput,
    ),
    renderManagedIssueMarker(input.identity.marker),
  ];
  return deepFreeze({
    title,
    description: sections.join("\n\n"),
    labels: managedIssueLabelNames(input.labels),
    ...(input.parentIssueIid === undefined ? {} : { parentIssueIid: input.parentIssueIid }),
  });
}

/**
 * Pure read-only reconciliation. It never uses title or descriptive prose as
 * identity, and its patch shape cannot mutate any human-owned field.
 */
export function reconcileManagedIssue(
  input: ManagedIssueReconciliationInput,
): ManagedIssueReconciliation {
  input = reconciliationEnvelope(input);
  const identity = validateIdentity(input.identity);
  const currentStateBinding = createManagedIssueStateBinding(identity);
  const desiredLabels = validateLabelSelection(input.desiredLabels);
  const observations = input.observations.map((item, index) =>
    observation(item, `$.observations[${index}]`),
  );
  unique(
    observations.map((item) => item.iid),
    "$.observations",
  );

  const unmarked: number[] = [];
  const exact: Array<{ issue: ManagedIssueObservation; marker: ManagedIssueMarkerV1 }> = [];
  const migrations: Array<{ issue: ManagedIssueObservation; marker: ManagedIssueMarkerV1 }> = [];
  const untrustedRevision: number[] = [];
  const malformed: number[] = [];

  for (const issue of observations) {
    let marker: ManagedIssueMarkerV1 | undefined;
    try {
      marker = extractManagedIssueMarker(issue.description);
    } catch {
      malformed.push(issue.iid);
      continue;
    }
    if (!marker) {
      unmarked.push(issue.iid);
      continue;
    }
    if (
      marker.repositoryKeyDigest !== identity.marker.repositoryKeyDigest ||
      marker.findingFingerprint !== identity.marker.findingFingerprint
    )
      continue;
    if (!issue.stateBinding) {
      untrustedRevision.push(issue.iid);
      continue;
    }
    let stateBinding: ManagedIssueStateBindingV1;
    try {
      stateBinding = validateManagedIssueStateBinding(issue.stateBinding);
      requireValue(
        stateBinding.markerIdentityDigest === marker.identityDigest,
        "finding-mismatch",
        "$.stateBinding",
      );
    } catch {
      untrustedRevision.push(issue.iid);
      continue;
    }
    if (stateBinding.digest === currentStateBinding.digest) {
      exact.push({ issue, marker });
    } else {
      migrations.push({ issue, marker });
    }
  }

  const conflicts = [...malformed, ...untrustedRevision].sort(numberCompare);
  if (conflicts.length > 0)
    return result("conflict", unmarked, conflicts, "untrusted-or-malformed-marker");

  const detached = exact.filter(({ issue }) => isDetached(issue));
  const managed = exact.filter(({ issue }) => !isDetached(issue));
  const active = managed.filter(
    ({ issue }) => issue.state === "opened" && !isTerminalLifecycle(lifecycleOf(issue.labels)),
  );
  const migrationDetached = migrations.filter(({ issue }) => isDetached(issue));
  const migrationTerminal = migrations.filter(
    ({ issue }) => !isDetached(issue) && isTerminalLifecycle(lifecycleOf(issue.labels)),
  );
  const migrationActive = migrations.filter(
    ({ issue }) =>
      !isDetached(issue) &&
      issue.state === "opened" &&
      !isTerminalLifecycle(lifecycleOf(issue.labels)),
  );
  const allActive = [...active, ...migrationActive];
  const allDetached = [...detached, ...migrationDetached];
  if (allActive.length > 1 || (allActive.length > 0 && allDetached.length > 0)) {
    return result(
      "conflict",
      unmarked,
      [...allActive, ...allDetached].map(({ issue }) => issue.iid),
      "multiple-active-matches",
    );
  }
  if (active.length === 1) {
    const selected = active[0]!.issue;
    return withIssue(
      "reuse",
      selected,
      unmarked,
      [],
      "active-match",
      buildPatch(selected, desiredLabels),
      currentStateBinding,
    );
  }
  if (migrationActive.length === 1) {
    const selected = migrationActive[0]!.issue;
    return withIssue("migration", selected, unmarked, [], "migration-required-host-authentication");
  }
  if (allDetached.length > 0) {
    if (allDetached.length > 1)
      return result(
        "conflict",
        unmarked,
        allDetached.map(({ issue }) => issue.iid),
        "multiple-detached-matches",
      );
    const selected = allDetached[0]!.issue;
    const exactBinding = detached.some(({ issue }) => issue.iid === selected.iid)
      ? currentStateBinding
      : undefined;
    return withIssue(
      "manually-detached",
      selected,
      unmarked,
      [],
      "human-detached",
      undefined,
      exactBinding,
    );
  }
  if (migrationTerminal.length > 0) {
    if (migrationTerminal.length > 1)
      return result(
        "conflict",
        unmarked,
        migrationTerminal.map(({ issue }) => issue.iid),
        "multiple-terminal-matches",
      );
    const selected = migrationTerminal[0]!.issue;
    const lifecycle = lifecycleOf(selected.labels);
    const disposition: ManagedIssueDisposition =
      lifecycle === "duplicate" ? "duplicate" : lifecycle === "superseded" ? "superseded" : "reuse";
    return withIssue(disposition, selected, unmarked, [], `terminal-${lifecycle}`, undefined);
  }
  const terminal = managed.sort((left, right) => numberCompare(left.issue.iid, right.issue.iid));
  if (terminal.length > 0) {
    const selected = terminal[0]!.issue;
    const lifecycle = lifecycleOf(selected.labels);
    if (lifecycle === "duplicate")
      return withIssue(
        "duplicate",
        selected,
        unmarked,
        [],
        "terminal-duplicate",
        undefined,
        currentStateBinding,
      );
    if (lifecycle === "superseded")
      return withIssue(
        "superseded",
        selected,
        unmarked,
        [],
        "terminal-superseded",
        undefined,
        currentStateBinding,
      );
    return withIssue(
      "reuse",
      selected,
      unmarked,
      [],
      "closed-or-terminal-match",
      undefined,
      currentStateBinding,
    );
  }
  if (migrations.length > 1) {
    return result(
      "conflict",
      unmarked,
      migrations.map(({ issue }) => issue.iid),
      "multiple-migration-matches",
    );
  }
  if (migrations.length === 1) {
    const selected = migrations[0]!.issue;
    return withIssue("migration", selected, unmarked, [], "migration-required-host-authentication");
  }
  return result("create", unmarked, [], "no-marked-match", currentStateBinding);
}

function reconciliationEnvelope(value: unknown): ManagedIssueReconciliationInput {
  const root = closed(value, "$", ["identity", "observations", "desiredLabels"]);
  return {
    identity: root.identity as ManagedIssueIdentityV1,
    observations: denseArray(
      root.observations,
      "$.observations",
      MAX_OBSERVATIONS,
    ) as ManagedIssueObservation[],
    desiredLabels: root.desiredLabels as ManagedIssueLabels,
  };
}

export function createManagedIssueMutationIdentityV2(
  planValue: RoadmapMutationPlanV2,
  ledgerValue: RoadmapLedger,
  operationKey: string,
  identityValue: ManagedIssueIdentityV1,
  materialInput: ManagedIssueMutationMaterialInputV1,
): ManagedIssueMutationIdentityV2 {
  const ledger = validatedRoadmapLedger(ledgerValue);
  const plan = validatedRoadmapMutationPlan(planValue, ledger);
  const identity = validateIdentity(identityValue);
  const operation = findOperation(plan, operationKey);
  const managedMaterial = managedMutationMaterial(materialInput, ledger, identity);
  validateManagedMutationOperation(operation, identity.findingId, managedMaterial);
  assertIdentityMatchesLedger(identity, ledger);
  const stateBinding = createManagedIssueStateBinding(identity);
  const material = {
    schemaVersion: 2 as const,
    operationKey: operation.key,
    idempotencyKey: operation.idempotencyKey,
    proposalDigest: operation.proposalDigest,
    materialDigest: operation.materialDigest,
    materialBytes: operation.materialBytes,
    markerIdentityDigest: identity.marker.identityDigest,
    stateBindingDigest: stateBinding.digest,
  };
  return deepFreeze({ ...material, digest: roadmapDigest(material) });
}

export function validateManagedIssueMutationIdentityV2(
  value: unknown,
  planValue: RoadmapMutationPlanV2,
  ledgerValue: RoadmapLedger,
  operationKey: string,
  identityValue: ManagedIssueIdentityV1,
  materialInput: ManagedIssueMutationMaterialInputV1,
): ManagedIssueMutationIdentityV2 {
  const ledger = validatedRoadmapLedger(ledgerValue);
  const plan = validatedRoadmapMutationPlan(planValue, ledger);
  const identity = validateIdentity(identityValue);
  const operation = findOperation(plan, operationKey);
  const managedMaterial = managedMutationMaterial(materialInput, ledger, identity);
  validateManagedMutationOperation(operation, identity.findingId, managedMaterial);
  assertIdentityMatchesLedger(identity, ledger);
  const stateBinding = createManagedIssueStateBinding(identity);
  const root = closed(value, "$", [
    "schemaVersion",
    "operationKey",
    "idempotencyKey",
    "proposalDigest",
    "materialDigest",
    "materialBytes",
    "markerIdentityDigest",
    "digest",
    "stateBindingDigest",
  ]);
  requireValue(root.schemaVersion === 2, "invalid-value", "$.schemaVersion");
  const decoded: ManagedIssueMutationIdentityV2 = {
    schemaVersion: 2,
    operationKey: identifier(root.operationKey, "$.operationKey"),
    idempotencyKey: digest(root.idempotencyKey, "$.idempotencyKey"),
    proposalDigest: digest(root.proposalDigest, "$.proposalDigest"),
    materialDigest: digest(root.materialDigest, "$.materialDigest"),
    materialBytes: positiveInteger(root.materialBytes, "$.materialBytes"),
    markerIdentityDigest: digest(root.markerIdentityDigest, "$.markerIdentityDigest"),
    stateBindingDigest: digest(root.stateBindingDigest, "$.stateBindingDigest"),
    digest: digest(root.digest, "$.digest"),
  };
  requireValue(
    decoded.operationKey === operation.key &&
      decoded.idempotencyKey === operation.idempotencyKey &&
      decoded.proposalDigest === operation.proposalDigest &&
      decoded.materialDigest === operation.materialDigest &&
      decoded.materialBytes === operation.materialBytes &&
      decoded.markerIdentityDigest === identity.marker.identityDigest &&
      decoded.stateBindingDigest === stateBinding.digest,
    "mutation-mismatch",
    "$",
  );
  const { digest: _digest, ...body } = decoded;
  requireValue(roadmapDigest(body) === decoded.digest, "digest-mismatch", "$.digest");
  return deepFreeze(decoded);
}

/** Issue-IID hierarchy works without any native-epic capability. */
export function validateManagedIssueHierarchyLink(value: unknown): ManagedIssueHierarchyLink {
  const root = closed(value, "$", ["parentIssueIid", "parentKind", "childIssueIid", "childKind"]);
  const link: ManagedIssueHierarchyLink = {
    parentIssueIid: positiveInteger(root.parentIssueIid, "$.parentIssueIid"),
    parentKind: enumeration(root.parentKind, ["saga", "epic"] as const, "$.parentKind"),
    childIssueIid: positiveInteger(root.childIssueIid, "$.childIssueIid"),
    childKind: enumeration(
      root.childKind,
      ["epic", "task", "investigation"] as const,
      "$.childKind",
    ),
  };
  requireValue(link.parentIssueIid !== link.childIssueIid, "invalid-value", "$.childIssueIid");
  requireValue(
    link.parentKind === "saga" || link.childKind !== "epic",
    "invalid-value",
    "$.childKind",
  );
  return deepFreeze(link);
}

function validateTemplateInput(value: ManagedIssueTemplateInput): ManagedIssueTemplateInput {
  const root = closed(
    value,
    "$",
    [
      "kind",
      "summary",
      "identity",
      "labels",
      "evidence",
      "rationale",
      "audienceImpact",
      "pathScope",
      "acceptance",
      "verification",
      "dependencies",
      "requiredHumanInput",
      "parentIssueIid",
    ],
    [
      "kind",
      "summary",
      "identity",
      "labels",
      "evidence",
      "rationale",
      "audienceImpact",
      "pathScope",
      "acceptance",
      "verification",
      "dependencies",
      "requiredHumanInput",
    ],
  );
  const identity = validateIdentity(root.identity);
  const evidence = stringArray(root.evidence, "$.evidence", true, MAX_TEMPLATE_EVIDENCE, 1).map(
    (item, index) => safeReference(item, `$.evidence[${index}]`),
  );
  const pathScope = stringArray(root.pathScope, "$.pathScope", true, MAX_TEMPLATE_PATHS, 1).map(
    (item, index) => safePath(item, `$.pathScope[${index}]`),
  );
  const acceptance = stringArray(
    root.acceptance,
    "$.acceptance",
    true,
    MAX_TEMPLATE_ACCEPTANCE,
    1,
  ).map((item, index) => safeTemplateProse(item, `$.acceptance[${index}]`));
  const verification = stringArray(
    root.verification,
    "$.verification",
    true,
    MAX_TEMPLATE_VERIFICATION,
    1,
  ).map((item, index) => safeTemplateProse(item, `$.verification[${index}]`));
  const dependencies = stringArray(
    root.dependencies,
    "$.dependencies",
    true,
    MAX_TEMPLATE_DEPENDENCIES,
  ).map((item, index) => safeReference(item, `$.dependencies[${index}]`));
  return deepFreeze({
    kind: enumeration(root.kind, MANAGED_ISSUE_KINDS, "$.kind"),
    summary: safeSummary(root.summary, "$.summary"),
    identity,
    labels: validateLabelSelection(root.labels),
    evidence,
    rationale: safeTemplateProse(text(root.rationale, "$.rationale"), "$.rationale"),
    audienceImpact: safeTemplateProse(
      text(root.audienceImpact, "$.audienceImpact"),
      "$.audienceImpact",
    ),
    pathScope,
    acceptance,
    verification,
    dependencies,
    requiredHumanInput: stringArray(
      root.requiredHumanInput,
      "$.requiredHumanInput",
      true,
      MAX_TEMPLATE_HUMAN_INPUT,
    ).map((item, index) => safeTemplateProse(item, `$.requiredHumanInput[${index}]`)),
    ...(root.parentIssueIid === undefined
      ? {}
      : { parentIssueIid: positiveInteger(root.parentIssueIid, "$.parentIssueIid") }),
  });
}

function validateLabelSelection(value: unknown): ManagedIssueLabels {
  const root = closed(value, "$.labels", ["gate", "workflow", "priority", "lifecycle"]);
  return deepFreeze({
    gate: enumeration(root.gate, MANAGED_ISSUE_GATES, "$.labels.gate"),
    workflow: enumeration(root.workflow, MANAGED_ISSUE_WORKFLOWS, "$.labels.workflow"),
    priority: enumeration(root.priority, MANAGED_ISSUE_PRIORITIES, "$.labels.priority"),
    lifecycle: enumeration(root.lifecycle, MANAGED_ISSUE_LIFECYCLES, "$.labels.lifecycle"),
  });
}

function observation(value: unknown, path: string): ManagedIssueObservation {
  const root = closed(
    value,
    path,
    [
      "iid",
      "state",
      "title",
      "description",
      "labels",
      "assigneeIds",
      "milestoneIid",
      "dueDate",
      "weight",
      "confidential",
      "stateBinding",
    ],
    ["iid", "state", "title", "description", "labels"],
  );
  const labels = stringArray(root.labels, `${path}.labels`, false, MAX_OBSERVATION_LABELS).map(
    (item, index) => {
      return validateObservedLabel(item, `${path}.labels[${index}]`);
    },
  );
  unique(labels, `${path}.labels`);
  validateControlledLabelCardinality(labels, path);
  return deepFreeze({
    iid: positiveInteger(root.iid, `${path}.iid`),
    state: enumeration(root.state, ["opened", "closed"] as const, `${path}.state`),
    title: text(root.title, `${path}.title`, true),
    description: descriptionText(root.description, `${path}.description`),
    labels,
    ...(root.assigneeIds === undefined
      ? {}
      : {
          assigneeIds: denseArray(root.assigneeIds, `${path}.assigneeIds`, MAX_ASSIGNEES).map(
            (item, index) => positiveInteger(item, `${path}.assigneeIds[${index}]`),
          ),
        }),
    ...(root.milestoneIid === undefined
      ? {}
      : { milestoneIid: positiveInteger(root.milestoneIid, `${path}.milestoneIid`) }),
    ...(root.dueDate === undefined ? {} : { dueDate: text(root.dueDate, `${path}.dueDate`) }),
    ...(root.weight === undefined
      ? {}
      : { weight: nonnegativeInteger(root.weight, `${path}.weight`) }),
    ...(root.confidential === undefined
      ? {}
      : { confidential: boolean(root.confidential, `${path}.confidential`) }),
    ...(root.stateBinding === undefined
      ? {}
      : {
          stateBinding: validateManagedIssueStateBinding(root.stateBinding),
        }),
  });
}

function validateObservedLabel(value: string, path: string): string {
  requireValue(
    value.length > 0 &&
      value === value.trim() &&
      Buffer.byteLength(value, "utf8") <= 255 &&
      !CONTROL.test(value) &&
      !carriesConfiguredCredential(value, path),
    "invalid-value",
    path,
  );
  const controlled = new Set([
    "docsfab-roadmap::managed",
    ...MANAGED_ISSUE_GATES.map((item) => `gate::${item}`),
    ...MANAGED_ISSUE_WORKFLOWS.map((item) => `workflow::${item}`),
    ...MANAGED_ISSUE_PRIORITIES.map((item) => `priority::${item}`),
    ...MANAGED_ISSUE_LIFECYCLES.map((item) => `lifecycle::${item}`),
  ]);
  const lower = value.toLocaleLowerCase("en-US");
  const reserved =
    lower.startsWith("docsfab-roadmap::") ||
    CONTROLLED_LABEL_PREFIXES.some((prefix) => lower.startsWith(prefix));
  requireValue(!reserved || controlled.has(value), "invalid-value", path);
  return value;
}

function validateControlledLabelCardinality(labels: string[], path: string): void {
  for (const prefix of CONTROLLED_LABEL_PREFIXES) {
    const matching = labels.filter((label) => label.startsWith(prefix));
    requireValue(matching.length <= 1, "ambiguous-match", `${path}.labels`);
  }
}

function lifecycleOf(labels: string[]): ManagedIssueLifecycle {
  const label = labels.find((candidate) => candidate.startsWith("lifecycle::"));
  if (!label) return "filed";
  const lifecycle = label.slice("lifecycle::".length);
  return MANAGED_ISSUE_LIFECYCLES.includes(lifecycle as ManagedIssueLifecycle)
    ? (lifecycle as ManagedIssueLifecycle)
    : "filed";
}

function isTerminalLifecycle(value: ManagedIssueLifecycle): boolean {
  return TERMINAL_LIFECYCLES.includes(value as (typeof TERMINAL_LIFECYCLES)[number]);
}

function isDetached(issue: ManagedIssueObservation): boolean {
  return (
    !issue.labels.includes("docsfab-roadmap::managed") ||
    lifecycleOf(issue.labels) === "manually-detached"
  );
}

function buildPatch(
  issue: ManagedIssueObservation,
  desired: ManagedIssueLabels,
): ManagedIssuePatch | undefined {
  const desiredControlled = managedIssueLabelNames(desired);
  const humanLabels = issue.labels.filter(
    (label) =>
      label !== "docsfab-roadmap::managed" &&
      !CONTROLLED_LABEL_PREFIXES.some((prefix) => label.startsWith(prefix)),
  );
  const labels = [...new Set([...humanLabels, ...desiredControlled])].sort(compare);
  const currentLabels = [...issue.labels].sort(compare);
  if (arraysEqual(labels, currentLabels)) return undefined;
  return deepFreeze({
    issueIid: issue.iid,
    labels,
  });
}

interface ValidatedManagedMutationMaterial {
  intent: "create" | "update";
  value: IssueLifecycleMutationMaterial;
  patchIssueIid?: number;
  templateKind?: ManagedIssueKind;
}

function managedMutationMaterial(
  input: ManagedIssueMutationMaterialInputV1,
  ledgerValue: RoadmapLedger,
  identityValue: ManagedIssueIdentityV1,
): ValidatedManagedMutationMaterial {
  const ledger = validatedRoadmapLedger(ledgerValue);
  const identity = validateIdentity(identityValue);
  assertIdentityMatchesLedger(identity, ledger);
  const finding = ledger.findings.find((candidate) => candidate.id === identity.findingId)!;
  const root = closed(
    input,
    "$.material",
    ["kind", "operationKey", "action", "template", "reconciliation"],
    ["kind", "operationKey"],
  );
  const operationKey = identifier(root.operationKey, "$.material.operationKey");
  if (root.kind === "create") {
    requireValue(
      root.template !== undefined && root.reconciliation === undefined && root.action === undefined,
      "invalid-value",
      "$.material",
    );
    const template = validateTemplateInput(root.template as ManagedIssueTemplateInput);
    requireValue(
      roadmapCanonicalJson(template.identity) === roadmapCanonicalJson(identity),
      "finding-mismatch",
      "$.material.template.identity",
    );
    requireValue(
      arraysEqual([...template.pathScope].sort(compare), [...finding.affectedPaths].sort(compare)),
      "finding-mismatch",
      "$.material.template.pathScope",
    );
    requireValue(
      arraysEqual([...template.evidence].sort(compare), [...finding.evidenceIds].sort(compare)),
      "finding-mismatch",
      "$.material.template.evidence",
    );
    requireValue(
      template.labels.priority === finding.severity,
      "finding-mismatch",
      "$.material.template.labels.priority",
    );
    requireValue(
      template.parentIssueIid === undefined,
      "mutation-mismatch",
      "$.material.template.parentIssueIid",
    );
    const draft = renderManagedIssueDraft(template);
    assertManagedIssueMarkerMatchesIdentity(extractManagedIssueMarker(draft.description), identity);
    const value = exactIssueLifecycleMaterial({
      operationKey,
      action: template.kind === "saga" ? "create-saga" : "create-issue",
      title: draft.title,
      description: draft.description,
      labels: draft.labels,
    });
    return {
      intent: "create",
      templateKind: template.kind,
      value,
    };
  }
  requireValue(
    root.kind === "update" &&
      root.reconciliation !== undefined &&
      root.template === undefined &&
      (root.action === "add-labels" || root.action === "remove-labels"),
    "invalid-value",
    "$.material",
  );
  const reconciliationInput = reconciliationEnvelope(root.reconciliation);
  const reconciliation = reconcileManagedIssue(reconciliationInput);
  requireValue(
    reconciliation.patch !== undefined &&
      reconciliation.issueIid !== undefined &&
      reconciliation.nextStateBinding?.digest === createManagedIssueStateBinding(identity).digest,
    "mutation-mismatch",
    "$.material.reconciliation",
  );
  const patch = validateManagedIssuePatch(reconciliation.patch);
  const observed = reconciliationInput.observations.find((item) => item.iid === patch.issueIid);
  requireValue(
    observed !== undefined,
    "mutation-mismatch",
    "$.material.reconciliation.observations",
  );
  const currentLabels = new Set(
    observation(observed, "$.material.reconciliation.observation").labels,
  );
  const desiredLabels = new Set(patch.labels!);
  const labels =
    root.action === "add-labels"
      ? patch.labels!.filter((label) => !currentLabels.has(label))
      : [...currentLabels].filter((label) => !desiredLabels.has(label)).sort(compare);
  requireValue(labels.length > 0, "mutation-mismatch", "$.material.action");
  const value = exactIssueLifecycleMaterial({ operationKey, action: root.action, labels });
  return {
    intent: "update",
    patchIssueIid: patch.issueIid,
    value,
  };
}

function validateManagedIssuePatch(value: unknown): ManagedIssuePatch {
  const root = closed(value, "$.patch", ["issueIid", "labels"], ["issueIid"]);
  const patch: ManagedIssuePatch = {
    issueIid: positiveInteger(root.issueIid, "$.patch.issueIid"),
    ...(root.labels === undefined
      ? {}
      : {
          labels: stringArray(root.labels, "$.patch.labels", false, MAX_OBSERVATION_LABELS)
            .map((item, index) => validateObservedLabel(item, `$.patch.labels[${index}]`))
            .sort(compare),
        }),
  };
  requireValue(
    patch.labels !== undefined && patch.labels.length >= 5,
    "invalid-value",
    "$.patch.labels",
  );
  validateControlledLabelCardinality(patch.labels, "$.patch");
  requireValue(
    patch.labels.includes("docsfab-roadmap::managed"),
    "invalid-value",
    "$.patch.labels",
  );
  for (const prefix of CONTROLLED_LABEL_PREFIXES) {
    requireValue(
      patch.labels.filter((label) => label.startsWith(prefix)).length === 1,
      "invalid-value",
      "$.patch.labels",
    );
  }
  return deepFreeze(patch);
}

function exactIssueLifecycleMaterial(value: unknown): IssueLifecycleMutationMaterial {
  try {
    return validateMutationMaterial(value);
  } catch {
    throw new ManagedIssueContractError("mutation-mismatch", "$.material");
  }
}

function validateManagedMutationOperation(
  operation: RoadmapMutationOperationV2,
  findingId: string,
  material: ValidatedManagedMutationMaterial,
): void {
  try {
    assertMaterialForOperation(operation, material.value);
  } catch {
    throw new ManagedIssueContractError("mutation-mismatch", "$.operation.material");
  }
  const creation = material.intent === "create";
  requireValue(
    creation === (operation.target.source === "project"),
    "mutation-mismatch",
    "$.operation.target",
  );
  if (creation) {
    requireValue(
      (operation.kind === "issue" || operation.kind === "saga") &&
        operation.proposal.intent === "create",
      "mutation-mismatch",
      "$.operation.proposal",
    );
    requireValue(
      (material.templateKind === "saga") === (operation.kind === "saga"),
      "mutation-mismatch",
      "$.operation.kind",
    );
  } else {
    requireValue(
      operation.kind === "label" && operation.proposal.intent === "assign-label",
      "mutation-mismatch",
      "$.operation.proposal",
    );
  }
  if (material.patchIssueIid !== undefined) {
    requireValue(
      operation.target.source === "ledger-observation" &&
        operation.target.targetKey === `issue:${material.patchIssueIid}`,
      "mutation-mismatch",
      "$.operation.target",
    );
  }
  requireValue(
    operation.proposal.effectKind === "issue" && operation.expectedEffectKind === "issue",
    "mutation-mismatch",
    "$.operation.proposal",
  );
  requireValue(
    operation.findingIds.length === 1 && operation.findingIds[0] === findingId,
    "finding-mismatch",
    "$.operation.findingIds",
  );
  digest(operation.idempotencyKey, "$.operation.idempotencyKey");
  digest(operation.proposalDigest, "$.operation.proposalDigest");
  digest(operation.materialDigest, "$.operation.materialDigest");
}

function findOperation(
  plan: RoadmapMutationPlanV2,
  operationKeyValue: string,
): RoadmapMutationOperationV2 {
  const operationKey = identifier(operationKeyValue, "$.operationKey");
  const operation = plan.operations.find((candidate) => candidate.key === operationKey);
  requireValue(operation !== undefined, "mutation-mismatch", "$.operationKey");
  return operation!;
}

function assertIdentityMatchesLedger(
  identity: ManagedIssueIdentityV1,
  ledger: RoadmapLedger,
): void {
  const expected = createManagedIssueIdentity(ledger, identity.findingId);
  assertManagedIssueMarkerMatchesIdentity(identity.marker, expected);
  requireValue(
    identity.ledgerDigest === expected.ledgerDigest &&
      identity.repositoryStateDigest === expected.repositoryStateDigest &&
      identity.testedRevision === expected.testedRevision,
    "repository-mismatch",
    "$.testedRevision",
  );
}

function renderList(title: string, items: string[]): string {
  return `## ${title}\n\n${items.map((item) => `- ${item}`).join("\n")}`;
}

function renderChecklist(title: string, items: string[]): string {
  return `## ${title}\n\n${items.map((item) => `- [ ] ${item}`).join("\n")}`;
}

function titleCase(value: ManagedIssueKind): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function result(
  disposition: ManagedIssueDisposition,
  ignored: number[],
  conflicts: number[],
  reasonCode: string,
  nextStateBinding?: ManagedIssueStateBindingV1,
): ManagedIssueReconciliation {
  return deepFreeze({
    disposition,
    ignoredUnmarkedIssueIids: [...ignored].sort(numberCompare),
    conflictingIssueIids: [...conflicts].sort(numberCompare),
    ...(nextStateBinding === undefined ? {} : { nextStateBinding }),
    reasonCode,
  });
}

function withIssue(
  disposition: ManagedIssueDisposition,
  issue: ManagedIssueObservation,
  ignored: number[],
  conflicts: number[],
  reasonCode: string,
  patch?: ManagedIssuePatch,
  nextStateBinding?: ManagedIssueStateBindingV1,
): ManagedIssueReconciliation {
  return deepFreeze({
    disposition,
    issueIid: issue.iid,
    ignoredUnmarkedIssueIids: [...ignored].sort(numberCompare),
    conflictingIssueIids: [...conflicts].sort(numberCompare),
    ...(patch === undefined ? {} : { patch }),
    ...(nextStateBinding === undefined ? {} : { nextStateBinding }),
    reasonCode,
  });
}

function stringArray(
  value: unknown,
  path: string,
  _prose: boolean,
  maxItems: number,
  minItems = 0,
): string[] {
  const values = denseArray(value, path, maxItems, minItems).map((item, index) =>
    text(item, `${path}[${index}]`),
  );
  unique(values, path);
  return values;
}

function validatedRoadmapLedger(value: unknown): RoadmapLedger {
  assertPassiveDataGraph(value, "$.ledger");
  return validateRoadmapLedger(value);
}

function validatedRoadmapMutationPlan(
  value: unknown,
  ledger: RoadmapLedger,
): RoadmapMutationPlanV2 {
  assertPassiveDataGraph(value, "$.plan");
  return validateRoadmapMutationPlanV2(value, ledger);
}

function safeReference(value: string, path: string): string {
  requireValue(
    SAFE_REFERENCE.test(value) && !carriesConfiguredCredential(value, path),
    "invalid-value",
    path,
  );
  return value;
}

function safeSummary(value: unknown, path: string): string {
  const candidate = safeTemplateProse(text(value, path), path).trim();
  requireValue(
    !candidate.includes("\n") &&
      !candidate.includes("\r") &&
      Buffer.byteLength(candidate, "utf8") <= 200,
    "unsafe-content",
    path,
  );
  return candidate;
}

function safeTemplateProse(value: string, path: string): string {
  requireValue(
    !value.includes(MANAGED_ISSUE_MARKER_NAME) &&
      !value.includes("<!--") &&
      !carriesConfiguredCredential(value, path),
    "unsafe-content",
    path,
  );
  return value;
}

function safePath(value: string, path: string): string {
  requireValue(
    !value.startsWith("/") &&
      !value.startsWith("~") &&
      !value.includes("\\") &&
      !value.split("/").includes("..") &&
      value !== "." &&
      !value.includes("<!--"),
    "unsafe-path",
    path,
  );
  return value;
}

function positiveInteger(value: unknown, path: string): number {
  requireValue(Number.isSafeInteger(value) && (value as number) > 0, "invalid-value", path);
  return value as number;
}

function nonnegativeInteger(value: unknown, path: string): number {
  requireValue(Number.isSafeInteger(value) && (value as number) >= 0, "invalid-value", path);
  return value as number;
}

function boolean(value: unknown, path: string): boolean {
  requireValue(typeof value === "boolean", "invalid-type", path);
  return value;
}

function enumeration<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  requireValue(typeof value === "string" && allowed.includes(value as T), "invalid-value", path);
  return value as T;
}

function requireEnumeration<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
): asserts value is T {
  requireValue(typeof value === "string" && allowed.includes(value as T), "invalid-value", path);
}

function unique(values: Array<string | number>, path: string): void {
  requireValue(new Set(values).size === values.length, "ambiguous-match", path);
}

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function compare(left: string, right: string): number {
  return left.localeCompare(right, "en");
}

function numberCompare(left: number, right: number): number {
  return left - right;
}
