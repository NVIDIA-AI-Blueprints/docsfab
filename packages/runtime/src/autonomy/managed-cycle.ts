// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Select, assign, execute, and link one managed issue to a draft MR.
 *
 * Mints no write authorization of its own: every gate of `runAutoCycleOnce` is
 * reused through the injected host. Selection picks at most one ready
 * `docsfab-roadmap::managed` issue per cycle and rejects blocked, duplicate, superseded, stale,
 * investigation-only, and human-input issues before any write. The link never
 * advances the issue past in-review.
 */

import { createContractKit, deepFreeze, type ContractFail } from "../contract-kit/index.js";
import {
  MANAGED_ISSUE_GATES,
  MANAGED_ISSUE_PRIORITIES,
  MANAGED_ISSUE_WORKFLOWS,
  MANAGED_ISSUE_LIFECYCLES,
  type ManagedIssueGate,
  type ManagedIssuePriority,
  type ManagedIssueWorkflow,
  type ManagedIssueLifecycle,
} from "../roadmap/managed-issue.js";
import {
  decodeLocalUserGitLabPublicationResult,
  type LocalUserGitLabPublicationResultV1,
} from "../delivery/publication-result.js";
import {
  runAutoCycleOnce,
  type AutoCycleOnceDisposition,
  type AutoCycleOnceHost,
  type AutoCycleOnceOutcomeV1,
  type AutoCycleOnceRecordV1,
} from "./once.js";
import type {
  AutoAssessmentV1,
  AutoCycleDeliveryMode,
  AutoCycleRequestV1,
  WorkflowDecisionV1,
} from "./contracts.js";
import type { TaskLineageRepositoryBindingV1 } from "../lineage/index.js";

export const MANAGED_ISSUE_CONFIDENCES = Object.freeze([
  "confirmed",
  "bounded",
  "inconclusive",
] as const);
export type ManagedIssueConfidence = (typeof MANAGED_ISSUE_CONFIDENCES)[number];

export const MANAGED_ISSUE_DEPENDENCY_READINESS = Object.freeze([
  "ready",
  "waiting",
  "blocked",
] as const);
export type ManagedIssueDependencyReadiness = (typeof MANAGED_ISSUE_DEPENDENCY_READINESS)[number];

export const MANAGED_ISSUE_PATH_COLLISION = Object.freeze(["none", "collision"] as const);
export type ManagedIssuePathCollision = (typeof MANAGED_ISSUE_PATH_COLLISION)[number];

export const MANAGED_CYCLE_LIFECYCLE_TARGETS = Object.freeze([
  "selected",
  "in-progress",
  "in-review",
] as const);
export type ManagedCycleLifecycleTarget = (typeof MANAGED_CYCLE_LIFECYCLE_TARGETS)[number];

export const MANAGED_CYCLE_DISPOSITIONS = Object.freeze([
  "executed-succeeded",
  "executed-failed",
  "executed-needs-input",
  "executed-needs-human-decision",
  "no-action",
  "needs-input",
  "blocked",
  "superseded",
] as const);

export const MANAGED_CYCLE_DELIVERY_MODES = Object.freeze([
  "none",
  "local-patch",
  "local-user-gitlab",
] as const);

const MAX_SELECTION_CANDIDATES = 10_000;
const MAX_VALIDATION_COST = 64;

export type ManagedCycleErrorCode =
  | "invalid-shape"
  | "invalid-value"
  | "digest-mismatch"
  | "cycle-binding-mismatch"
  | "assignment-requires-selection"
  | "link-unavailable"
  | "publication-drift"
  | "migration-required";

export class ManagedCycleError extends Error {
  public constructor(public readonly code: ManagedCycleErrorCode) {
    super(`Managed issue cycle contract rejected the operation for the stated reason: ${code}.`);
    this.name = "ManagedCycleError";
  }
}

const fail: ContractFail<ManagedCycleErrorCode> = (code) => {
  throw new ManagedCycleError(code);
};

const kit = createContractKit<ManagedCycleErrorCode>({
  fail,
  inertMode: "strict",
  codes: {
    invalidShape: "invalid-shape",
    invalidValue: "invalid-value",
    digestMismatch: "digest-mismatch",
    credentialMaterial: "invalid-value",
    schemaMismatch: "migration-required",
  },
});

const {
  assertInert,
  object,
  exact,
  array,
  hash,
  identifier,
  revision,
  enumeration,
  canonicalDigest,
  compare,
  seal,
  decodeSealed,
} = kit;

/**
 * Content-free ranking evidence for one managed issue, derived from a
 * host-authenticated tracker observation. Never carries issue title or prose.
 */
export interface ManagedIssueSelectionCandidateInputV1 {
  issueIid: number;
  markerIdentityDigest: string;
  gate: ManagedIssueGate;
  workflow: ManagedIssueWorkflow;
  priority: ManagedIssuePriority;
  lifecycle: ManagedIssueLifecycle;
  confidence: ManagedIssueConfidence;
  dependencyReadiness: ManagedIssueDependencyReadiness;
  pathCollision: ManagedIssuePathCollision;
  validationCost: number;
  requiredHumanInputOpen: boolean;
  testedRevision: string;
}

export interface ManagedIssueSelectionInputV1 {
  cycleId: string;
  repository: TaskLineageRepositoryBindingV1;
  trackerObservationSha256: string;
  candidates: ManagedIssueSelectionCandidateInputV1[];
}

export interface ManagedIssueSelectionReferenceV1 {
  issueIid: number;
  markerIdentityDigest: string;
  gate: ManagedIssueGate;
  workflow: ManagedIssueWorkflow;
  priority: ManagedIssuePriority;
  testedRevision: string;
}

export interface ManagedIssueSelectionDeferralV1 {
  issueIid: number;
  markerIdentityDigest: string;
  reasonCode: string;
}

export interface ManagedIssueSelectionV1 {
  schemaVersion: 1;
  kind: "docsfab-managed-issue-selection";
  cycleId: string;
  repositoryIdentitySha256: string;
  repositoryRevision: string;
  trackerObservationSha256: string;
  selected: ManagedIssueSelectionReferenceV1 | null;
  deferred: ManagedIssueSelectionDeferralV1[];
  rejected: ManagedIssueSelectionDeferralV1[];
  selectionSha256: string;
}

export interface ManagedIssueAssignmentIntentV1 {
  schemaVersion: 1;
  kind: "docsfab-managed-issue-assignment-intent";
  cycleId: string;
  issueIid: number;
  markerIdentityDigest: string;
  assigneeIdentitySha256: string;
  selectionSha256: string;
  operationKey: string;
  fromLifecycle: "ready";
  toLifecycle: "selected";
  assignmentIntentSha256: string;
}

export interface ManagedCycleDraftMrLinkV1 {
  deliveryMode: AutoCycleDeliveryMode;
  targetBranchSha256: string;
  relatedIssueIid: number;
  closesIssueOnMerge: true;
  draft: true;
}

export interface ManagedCycleLinkV1 {
  schemaVersion: 1;
  kind: "docsfab-managed-cycle-link";
  cycleId: string;
  selectionSha256: string;
  assignmentIntentSha256: string;
  issueIid: number;
  markerIdentityDigest: string;
  testedRevision: string;
  requestSha256: string;
  disposition: AutoCycleOnceDisposition;
  runRecordId: string | null;
  terminalResultSha256: string;
  publicationEligible: boolean;
  draftMrLink: ManagedCycleDraftMrLinkV1 | null;
  lifecycleTarget: ManagedCycleLifecycleTarget;
  patchEvidencePreserved: boolean;
  linkSha256: string;
}

export interface ManagedCycleDeliveryLinkV1 {
  schemaVersion: 1;
  kind: "docsfab-managed-cycle-delivery-link";
  cycleId: string;
  issueIid: number;
  markerIdentityDigest: string;
  linkSha256: string;
  mergeRequestIid: number;
  sourceBranch: string;
  targetBranch: string;
  commitRevision: string;
  draft: true;
  closesIssueOnMerge: true;
  lifecycleTarget: "in-review";
  deliveryLinkSha256: string;
}

function positiveInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    fail("invalid-value");
  }
  return value as number;
}

function boundedCost(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_VALIDATION_COST
  ) {
    fail("invalid-value");
  }
  return value as number;
}

function booleanValue(value: unknown): boolean {
  if (typeof value !== "boolean") fail("invalid-value");
  return value;
}

function selectionCandidate(value: unknown): ManagedIssueSelectionCandidateInputV1 {
  const root = object(value);
  exact(root, [
    "issueIid",
    "markerIdentityDigest",
    "gate",
    "workflow",
    "priority",
    "lifecycle",
    "confidence",
    "dependencyReadiness",
    "pathCollision",
    "validationCost",
    "requiredHumanInputOpen",
    "testedRevision",
  ]);
  return {
    issueIid: positiveInteger(root.issueIid),
    markerIdentityDigest: hash(root.markerIdentityDigest),
    gate: enumeration(root.gate, MANAGED_ISSUE_GATES),
    workflow: enumeration(root.workflow, MANAGED_ISSUE_WORKFLOWS),
    priority: enumeration(root.priority, MANAGED_ISSUE_PRIORITIES),
    lifecycle: enumeration(root.lifecycle, MANAGED_ISSUE_LIFECYCLES),
    confidence: enumeration(root.confidence, MANAGED_ISSUE_CONFIDENCES),
    dependencyReadiness: enumeration(root.dependencyReadiness, MANAGED_ISSUE_DEPENDENCY_READINESS),
    pathCollision: enumeration(root.pathCollision, MANAGED_ISSUE_PATH_COLLISION),
    validationCost: boundedCost(root.validationCost),
    requiredHumanInputOpen: booleanValue(root.requiredHumanInputOpen),
    testedRevision: revision(root.testedRevision),
  };
}

function rejectionReason(
  candidate: ManagedIssueSelectionCandidateInputV1,
  currentRevision: string,
): string | null {
  if (candidate.lifecycle !== "ready") {
    switch (candidate.lifecycle) {
      case "blocked":
        return "blocked-lifecycle";
      case "duplicate":
        return "duplicate-lifecycle";
      case "superseded":
        return "superseded-lifecycle";
      case "manually-detached":
        return "detached-lifecycle";
      default:
        return "lifecycle-not-ready";
    }
  }
  if (candidate.testedRevision !== currentRevision) return "stale-evidence";
  if (candidate.workflow === "investigation") return "investigation-only";
  if (candidate.requiredHumanInputOpen) return "human-input-required";
  if (candidate.dependencyReadiness === "blocked") return "dependency-blocked";
  if (candidate.dependencyReadiness === "waiting") return "dependency-waiting";
  if (candidate.pathCollision === "collision") return "path-collision";
  if (candidate.confidence === "inconclusive") return "low-confidence";
  return null;
}

function rankKey(candidate: ManagedIssueSelectionCandidateInputV1): string {
  const gate = String(MANAGED_ISSUE_GATES.indexOf(candidate.gate)).padStart(2, "0");
  const priority = String(MANAGED_ISSUE_PRIORITIES.indexOf(candidate.priority)).padStart(2, "0");
  const confidence = String(MANAGED_ISSUE_CONFIDENCES.indexOf(candidate.confidence)).padStart(
    2,
    "0",
  );
  const cost = String(candidate.validationCost).padStart(4, "0");
  const iid = String(candidate.issueIid).padStart(12, "0");
  // Lower maturity gate first, since it is a prerequisite; iid breaks ties.
  return `${gate}:${priority}:${confidence}:${cost}:${iid}`;
}

/**
 * Pick at most one ready managed issue. Ranking is deterministic and
 * content-free, so a resumed cycle re-selects the same issue.
 */
export function selectManagedIssue(input: ManagedIssueSelectionInputV1): ManagedIssueSelectionV1 {
  assertInert(input);
  const root = object(input);
  exact(root, ["cycleId", "repository", "trackerObservationSha256", "candidates"]);
  const cycleId = identifier(root.cycleId);
  const repository = object(root.repository);
  exact(repository, ["identitySha256", "revision"]);
  const repositoryIdentitySha256 = hash(repository.identitySha256);
  const repositoryRevision = revision(repository.revision);
  const trackerObservationSha256 = hash(root.trackerObservationSha256);
  const candidates = array(root.candidates).map(selectionCandidate);
  if (candidates.length > MAX_SELECTION_CANDIDATES) fail("invalid-value");
  const iids = candidates.map((candidate) => candidate.issueIid);
  if (new Set(iids).size !== iids.length) fail("invalid-value");
  const markers = candidates.map((candidate) => candidate.markerIdentityDigest);
  if (new Set(markers).size !== markers.length) fail("invalid-value");

  const eligible: ManagedIssueSelectionCandidateInputV1[] = [];
  const rejected: ManagedIssueSelectionDeferralV1[] = [];
  for (const candidate of candidates) {
    const reason = rejectionReason(candidate, repositoryRevision);
    if (reason === null) {
      eligible.push(candidate);
    } else {
      rejected.push({
        issueIid: candidate.issueIid,
        markerIdentityDigest: candidate.markerIdentityDigest,
        reasonCode: reason,
      });
    }
  }
  eligible.sort((left, right) => compare(rankKey(left), rankKey(right)));
  const chosen = eligible[0];
  const selected: ManagedIssueSelectionReferenceV1 | null = chosen
    ? {
        issueIid: chosen.issueIid,
        markerIdentityDigest: chosen.markerIdentityDigest,
        gate: chosen.gate,
        workflow: chosen.workflow,
        priority: chosen.priority,
        testedRevision: chosen.testedRevision,
      }
    : null;
  const deferred: ManagedIssueSelectionDeferralV1[] = eligible.slice(1).map((candidate) => ({
    issueIid: candidate.issueIid,
    markerIdentityDigest: candidate.markerIdentityDigest,
    reasonCode: "lower-ranked",
  }));
  const body = {
    cycleId,
    repositoryIdentitySha256,
    repositoryRevision,
    trackerObservationSha256,
    selected,
    deferred: sortDeferrals(deferred),
    rejected: sortDeferrals(rejected),
  };
  return seal(
    "docsfab-managed-issue-selection",
    "selectionSha256",
    body,
  ) as ManagedIssueSelectionV1;
}

/**
 * Record the intent to assign the selected issue and relabel it ready to
 * selected. The relabel itself executes through the lifecycle mutation path.
 */
export function createManagedIssueAssignmentIntent(
  selectionValue: ManagedIssueSelectionV1,
  assigneeIdentitySha256: string,
): ManagedIssueAssignmentIntentV1 {
  const selection = decodeManagedIssueSelection(selectionValue);
  if (selection.selected === null) fail("assignment-requires-selection");
  const assignee = hash(assigneeIdentitySha256);
  const operationKey = `operation:assign:${selection.selected.markerIdentityDigest.slice(0, 32)}`;
  const body = {
    cycleId: selection.cycleId,
    issueIid: selection.selected.issueIid,
    markerIdentityDigest: selection.selected.markerIdentityDigest,
    assigneeIdentitySha256: assignee,
    selectionSha256: selection.selectionSha256,
    operationKey,
    fromLifecycle: "ready" as const,
    toLifecycle: "selected" as const,
  };
  return seal(
    "docsfab-managed-issue-assignment-intent",
    "assignmentIntentSha256",
    body,
  ) as ManagedIssueAssignmentIntentV1;
}

export interface CreateManagedCycleLinkInputV1 {
  selection: ManagedIssueSelectionV1;
  assignment: ManagedIssueAssignmentIntentV1;
  record: AutoCycleOnceRecordV1;
}

/**
 * Bind the selection, assignment, and cycle record into one resumable link. A
 * draft-MR link exists only for a succeeded, publication-eligible GitLab write.
 */
export function createManagedCycleLink(input: CreateManagedCycleLinkInputV1): ManagedCycleLinkV1 {
  const selection = decodeManagedIssueSelection(input.selection);
  const assignment = decodeManagedIssueAssignmentIntent(input.assignment);
  if (selection.selected === null) fail("assignment-requires-selection");
  if (
    assignment.selectionSha256 !== selection.selectionSha256 ||
    assignment.cycleId !== selection.cycleId ||
    assignment.issueIid !== selection.selected.issueIid ||
    assignment.markerIdentityDigest !== selection.selected.markerIdentityDigest
  ) {
    fail("cycle-binding-mismatch");
  }
  const record = input.record;
  assertInert(record);
  if (record.cycleId !== selection.cycleId) fail("cycle-binding-mismatch");

  const disposition = record.disposition;
  const publicationEligible = record.publicationEligibility?.eligible === true;
  const executed = disposition.startsWith("executed-");
  const deliveryMode = record.authorizationProjection?.deliveryMode ?? null;
  const draftMrLink: ManagedCycleDraftMrLinkV1 | null =
    disposition === "executed-succeeded" &&
    publicationEligible &&
    deliveryMode === "local-user-gitlab" &&
    record.authorizationProjection !== null
      ? {
          deliveryMode,
          targetBranchSha256: hash(record.authorizationProjection.targetBranchSha256),
          relatedIssueIid: selection.selected.issueIid,
          closesIssueOnMerge: true,
          draft: true,
        }
      : null;
  const lifecycleTarget: ManagedCycleLifecycleTarget =
    draftMrLink !== null ? "in-review" : executed ? "in-progress" : "selected";
  const body = {
    cycleId: selection.cycleId,
    selectionSha256: selection.selectionSha256,
    assignmentIntentSha256: assignment.assignmentIntentSha256,
    issueIid: selection.selected.issueIid,
    markerIdentityDigest: selection.selected.markerIdentityDigest,
    testedRevision: selection.selected.testedRevision,
    requestSha256: hash(record.requestSha256),
    disposition,
    runRecordId: record.runRecordId,
    terminalResultSha256: hash(record.terminalResult.terminalResultSha256),
    publicationEligible,
    draftMrLink,
    lifecycleTarget,
    patchEvidencePreserved: executed,
  };
  return seal("docsfab-managed-cycle-link", "linkSha256", body) as ManagedCycleLinkV1;
}

/**
 * Reconcile a draft-MR publication result against the managed-cycle link. The
 * result must target the exact authorized branch; its own decoder enforces
 * draft. The returned link never advances the lifecycle past in-review.
 */
export function reconcileManagedCycleDraftMrLink(
  linkValue: ManagedCycleLinkV1,
  publicationResultValue: LocalUserGitLabPublicationResultV1,
): ManagedCycleDeliveryLinkV1 {
  const link = decodeManagedCycleLink(linkValue);
  if (link.draftMrLink === null) fail("link-unavailable");
  const result = decodeLocalUserGitLabPublicationResult(publicationResultValue);
  if (canonicalDigest(result.targetBranch) !== link.draftMrLink.targetBranchSha256) {
    fail("publication-drift");
  }
  const body = {
    cycleId: link.cycleId,
    issueIid: link.issueIid,
    markerIdentityDigest: link.markerIdentityDigest,
    linkSha256: link.linkSha256,
    mergeRequestIid: positiveInteger(result.mergeRequest.iid),
    sourceBranch: result.sourceBranch,
    targetBranch: result.targetBranch,
    commitRevision: revision(result.commitRevision),
    draft: true as const,
    closesIssueOnMerge: true as const,
    lifecycleTarget: "in-review" as const,
  };
  return seal(
    "docsfab-managed-cycle-delivery-link",
    "deliveryLinkSha256",
    body,
  ) as ManagedCycleDeliveryLinkV1;
}

export function decodeManagedIssueSelection(value: unknown): ManagedIssueSelectionV1 {
  return decodeSealed(
    value,
    "docsfab-managed-issue-selection",
    "selectionSha256",
    [
      "cycleId",
      "repositoryIdentitySha256",
      "repositoryRevision",
      "trackerObservationSha256",
      "selected",
      "deferred",
      "rejected",
    ],
    (root) => ({
      cycleId: identifier(root.cycleId),
      repositoryIdentitySha256: hash(root.repositoryIdentitySha256),
      repositoryRevision: revision(root.repositoryRevision),
      trackerObservationSha256: hash(root.trackerObservationSha256),
      selected: selectionReference(root.selected),
      deferred: sortDeferrals(array(root.deferred).map(deferral)),
      rejected: sortDeferrals(array(root.rejected).map(deferral)),
    }),
  ) as ManagedIssueSelectionV1;
}

export function decodeManagedIssueAssignmentIntent(value: unknown): ManagedIssueAssignmentIntentV1 {
  return decodeSealed(
    value,
    "docsfab-managed-issue-assignment-intent",
    "assignmentIntentSha256",
    [
      "cycleId",
      "issueIid",
      "markerIdentityDigest",
      "assigneeIdentitySha256",
      "selectionSha256",
      "operationKey",
      "fromLifecycle",
      "toLifecycle",
    ],
    (root) => ({
      cycleId: identifier(root.cycleId),
      issueIid: positiveInteger(root.issueIid),
      markerIdentityDigest: hash(root.markerIdentityDigest),
      assigneeIdentitySha256: hash(root.assigneeIdentitySha256),
      selectionSha256: hash(root.selectionSha256),
      operationKey: identifier(root.operationKey),
      fromLifecycle: enumeration(root.fromLifecycle, ["ready"] as const),
      toLifecycle: enumeration(root.toLifecycle, ["selected"] as const),
    }),
  ) as ManagedIssueAssignmentIntentV1;
}

export function decodeManagedCycleLink(value: unknown): ManagedCycleLinkV1 {
  return decodeSealed(
    value,
    "docsfab-managed-cycle-link",
    "linkSha256",
    [
      "cycleId",
      "selectionSha256",
      "assignmentIntentSha256",
      "issueIid",
      "markerIdentityDigest",
      "testedRevision",
      "requestSha256",
      "disposition",
      "runRecordId",
      "terminalResultSha256",
      "publicationEligible",
      "draftMrLink",
      "lifecycleTarget",
      "patchEvidencePreserved",
    ],
    (root) => ({
      cycleId: identifier(root.cycleId),
      selectionSha256: hash(root.selectionSha256),
      assignmentIntentSha256: hash(root.assignmentIntentSha256),
      issueIid: positiveInteger(root.issueIid),
      markerIdentityDigest: hash(root.markerIdentityDigest),
      testedRevision: revision(root.testedRevision),
      requestSha256: hash(root.requestSha256),
      disposition: enumeration(root.disposition, MANAGED_CYCLE_DISPOSITIONS),
      runRecordId: root.runRecordId === null ? null : identifier(root.runRecordId),
      terminalResultSha256: hash(root.terminalResultSha256),
      publicationEligible: booleanValue(root.publicationEligible),
      draftMrLink: draftMrLink(root.draftMrLink),
      lifecycleTarget: enumeration(root.lifecycleTarget, MANAGED_CYCLE_LIFECYCLE_TARGETS),
      patchEvidencePreserved: booleanValue(root.patchEvidencePreserved),
    }),
  ) as ManagedCycleLinkV1;
}

function selectionReference(value: unknown): ManagedIssueSelectionReferenceV1 | null {
  if (value === null) return null;
  const root = object(value);
  exact(root, [
    "issueIid",
    "markerIdentityDigest",
    "gate",
    "workflow",
    "priority",
    "testedRevision",
  ]);
  return {
    issueIid: positiveInteger(root.issueIid),
    markerIdentityDigest: hash(root.markerIdentityDigest),
    gate: enumeration(root.gate, MANAGED_ISSUE_GATES),
    workflow: enumeration(root.workflow, MANAGED_ISSUE_WORKFLOWS),
    priority: enumeration(root.priority, MANAGED_ISSUE_PRIORITIES),
    testedRevision: revision(root.testedRevision),
  };
}

function deferral(value: unknown): ManagedIssueSelectionDeferralV1 {
  const root = object(value);
  exact(root, ["issueIid", "markerIdentityDigest", "reasonCode"]);
  return {
    issueIid: positiveInteger(root.issueIid),
    markerIdentityDigest: hash(root.markerIdentityDigest),
    reasonCode: identifier(root.reasonCode),
  };
}

function draftMrLink(value: unknown): ManagedCycleDraftMrLinkV1 | null {
  if (value === null) return null;
  const root = object(value);
  exact(root, [
    "deliveryMode",
    "targetBranchSha256",
    "relatedIssueIid",
    "closesIssueOnMerge",
    "draft",
  ]);
  const deliveryMode = enumeration(root.deliveryMode, MANAGED_CYCLE_DELIVERY_MODES);
  if (root.closesIssueOnMerge !== true || root.draft !== true) {
    fail("invalid-value");
  }
  return {
    deliveryMode,
    targetBranchSha256: hash(root.targetBranchSha256),
    relatedIssueIid: positiveInteger(root.relatedIssueIid),
    closesIssueOnMerge: true,
    draft: true,
  };
}

function sortDeferrals(
  values: ManagedIssueSelectionDeferralV1[],
): ManagedIssueSelectionDeferralV1[] {
  return [...values].sort((left, right) => left.issueIid - right.issueIid);
}

export interface ManagedIssueCycleOnceInputV1 {
  selection: ManagedIssueSelectionInputV1;
  assigneeIdentitySha256: string;
  chain: {
    request: AutoCycleRequestV1;
    assessment: AutoAssessmentV1;
    decision: WorkflowDecisionV1;
    repository: TaskLineageRepositoryBindingV1;
  };
}

export interface ManagedCycleOnceHost extends AutoCycleOnceHost {
  saveLink(link: ManagedCycleLinkV1): Promise<void>;
}

export interface ManagedCycleOnceOutcomeV1 {
  selection: ManagedIssueSelectionV1;
  assignment: ManagedIssueAssignmentIntentV1 | null;
  once: AutoCycleOnceOutcomeV1 | null;
  link: ManagedCycleLinkV1 | null;
}

/**
 * Select, assign, run the bounded cycle, and persist the link. With no ready
 * issue the cycle performs no write and returns only the selection evidence.
 */
export async function runManagedIssueCycleOnce(
  input: ManagedIssueCycleOnceInputV1,
  host: ManagedCycleOnceHost,
): Promise<ManagedCycleOnceOutcomeV1> {
  const selection = selectManagedIssue(input.selection);
  if (selection.selected === null) {
    return { selection, assignment: null, once: null, link: null };
  }
  if (
    selection.cycleId !== input.chain.request.cycleId ||
    selection.repositoryRevision !== input.chain.repository.revision ||
    selection.repositoryIdentitySha256 !== input.chain.repository.identitySha256
  ) {
    fail("cycle-binding-mismatch");
  }
  const assignment = createManagedIssueAssignmentIntent(selection, input.assigneeIdentitySha256);
  const once = await runAutoCycleOnce(input.chain, host);
  const link = createManagedCycleLink({
    selection,
    assignment,
    record: once.record,
  });
  await host.saveLink(link);
  host.log?.(
    `managed cycle: issue ${selection.selected.issueIid}; ` +
      `${link.disposition}; lifecycle ${link.lifecycleTarget}; ` +
      `draft-mr ${link.draftMrLink === null ? "none" : "linked"}.`,
  );
  return { selection, assignment, once, link };
}

export { deepFreeze };
