// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ArtifactReference } from "../../artifacts/contracts.js";
import type { RepositoryIdentity } from "../../content-ir/contracts.js";
import {
  ROADMAP_LEDGER_SCHEMA_VERSION,
  internalRoadmapIdentity,
  type RoadmapLedger,
  type RoadmapProjectIdentity,
  type RoadmapTrackerObservation,
} from "./ledger.js";
import {
  internalRoadmapDecode,
  roadmapCanonicalJson,
  roadmapDigest,
  type RoadmapContractErrorCode,
} from "./decode.js";

const {
  closed,
  array,
  identifier,
  timestamp,
  dateOnly,
  digest,
  revision,
  positiveInteger,
  enumeration,
  idArray,
  identifierArray,
  enumerationArray,
  requireUnique,
  requireReferences,
  assertAcyclic,
  compareRoadmap,
  compareText,
  freeze,
} = internalRoadmapDecode;

const requireValue: (
  condition: unknown,
  code: RoadmapContractErrorCode,
  path: string,
) => asserts condition = internalRoadmapDecode.requireValue;

const { repository, project, sameRepository, sameProject } = internalRoadmapIdentity;

export const ROADMAP_OPERATION_KINDS = [
  "saga",
  "issue",
  "update",
  "comment",
  "link",
  "milestone",
  "label",
  "closure",
] as const;
export type RoadmapOperationKind = (typeof ROADMAP_OPERATION_KINDS)[number];

export interface RoadmapMutationPrecondition {
  targetKey: string;
  observedAt: string;
  identityDigest: string;
}

interface RoadmapMutationProposalBase {
  kind: RoadmapOperationKind;
}

export interface RoadmapSagaProposal extends RoadmapMutationProposalBase {
  kind: "saga";
  projectId: number;
  titleDigest: string;
  descriptionDigest: string;
  milestoneIid?: number;
  labelNames: string[];
}

export interface RoadmapIssueProposal extends RoadmapMutationProposalBase {
  kind: "issue";
  projectId: number;
  titleDigest: string;
  descriptionDigest: string;
  parentSagaIid?: number;
  milestoneIid?: number;
  labelNames: string[];
}

export interface RoadmapUpdateProposal extends RoadmapMutationProposalBase {
  kind: "update";
  issueIid: number;
  changedFields: Array<"title" | "description" | "milestone" | "weight" | "due-date">;
  updateDigest: string;
}

export interface RoadmapCommentProposal extends RoadmapMutationProposalBase {
  kind: "comment";
  issueIid: number;
  commentDigest: string;
}

export interface RoadmapLinkProposal extends RoadmapMutationProposalBase {
  kind: "link";
  sourceIssueIid: number;
  targetIssueIid: number;
  relationship: "blocks" | "is-blocked-by" | "relates-to" | "duplicates" | "is-duplicated-by";
  targetPrecondition: RoadmapMutationPrecondition;
}

export interface RoadmapMilestoneProposal extends RoadmapMutationProposalBase {
  kind: "milestone";
  projectId: number;
  titleDigest: string;
  descriptionDigest?: string;
  dueDate?: string;
}

export interface RoadmapLabelProposal extends RoadmapMutationProposalBase {
  kind: "label";
  issueIid: number;
  add: string[];
  remove: string[];
}

export interface RoadmapClosureProposal extends RoadmapMutationProposalBase {
  kind: "closure";
  issueIid: number;
  action: "close" | "reopen";
  closeoutDecisionId: string;
  evidenceDigest: string;
}

export type RoadmapMutationProposal =
  | RoadmapSagaProposal
  | RoadmapIssueProposal
  | RoadmapUpdateProposal
  | RoadmapCommentProposal
  | RoadmapLinkProposal
  | RoadmapMilestoneProposal
  | RoadmapLabelProposal
  | RoadmapClosureProposal;

export interface RoadmapMutationOperation {
  key: string;
  kind: RoadmapOperationKind;
  targetKey: string;
  findingIds: string[];
  dependsOnOperationKeys: string[];
  payloadDigest: string;
  payloadBytes: number;
  proposal: RoadmapMutationProposal;
  precondition?: RoadmapMutationPrecondition;
}

/** Content-free artifact references carried directly by RunRecord.artifacts. */
export type RoadmapLedgerReference = ArtifactReference<"roadmap-ledger">;
export type RoadmapMutationPlanReference = ArtifactReference<"roadmap-mutation-plan">;

/** Content-free links that a roadmap workflow run record can embed. */
export interface RoadmapRunArtifactReferences {
  schemaVersion: typeof ROADMAP_LEDGER_SCHEMA_VERSION;
  ledger: RoadmapLedgerReference;
  plan?: RoadmapMutationPlanReference;
}

export interface RoadmapMutationPlan {
  kind: "roadmap-mutation-plan";
  schemaVersion: typeof ROADMAP_LEDGER_SCHEMA_VERSION;
  id: string;
  ledger: RoadmapLedgerReference;
  repository: RepositoryIdentity;
  project: RoadmapProjectIdentity;
  trackerObservedAt: string;
  operations: RoadmapMutationOperation[];
  generatedAt: string;
  expiresAt: string;
  digest: string;
}

/** @internal Target parser shared with receipt validation. */
export function issueIidFromTarget(targetKey: string): number | undefined {
  const match = /^issue:(\d+)$/u.exec(targetKey);
  return match ? Number(match[1]) : undefined;
}
export function createRoadmapMutationPlan(
  input: Omit<RoadmapMutationPlan, "kind" | "schemaVersion" | "digest">,
  ledger: RoadmapLedger,
): RoadmapMutationPlan {
  const candidate = {
    kind: "roadmap-mutation-plan" as const,
    schemaVersion: ROADMAP_LEDGER_SCHEMA_VERSION,
    ...input,
    operations: [...input.operations].sort((left, right) => compareText(left.key, right.key)),
    digest: "0".repeat(64),
  };
  candidate.digest = roadmapDigest(candidate);
  return validateRoadmapMutationPlan(candidate, { ledger });
}

export function createRoadmapRunArtifactReferences(
  ledger: RoadmapLedger,
  plan?: RoadmapMutationPlan,
): RoadmapRunArtifactReferences {
  if (plan) {
    requireValue(plan.ledger.digest === ledger.digest, "digest-mismatch", "$.plan.ledger");
    requireValue(
      sameRepository(plan.repository, ledger.repository),
      "repository-mismatch",
      "$.plan.repository",
    );
  }
  return freeze({
    schemaVersion: ROADMAP_LEDGER_SCHEMA_VERSION,
    ledger: {
      kind: "roadmap-ledger",
      schemaVersion: ROADMAP_LEDGER_SCHEMA_VERSION,
      digest: ledger.digest,
      repositoryRevision: ledger.repository.revision,
      repositoryContentDigest: ledger.repository.contentDigest,
    },
    ...(plan === undefined
      ? {}
      : {
          plan: {
            kind: "roadmap-mutation-plan" as const,
            schemaVersion: ROADMAP_LEDGER_SCHEMA_VERSION,
            digest: plan.digest,
            repositoryRevision: plan.repository.revision,
            repositoryContentDigest: plan.repository.contentDigest,
          },
        }),
  });
}

export function validateRoadmapRunArtifactReferences(
  value: unknown,
  ledger: RoadmapLedger,
  plan?: RoadmapMutationPlan,
): RoadmapRunArtifactReferences {
  const root = closed(value, "$", ["schemaVersion", "ledger", "plan"], ["schemaVersion", "ledger"]);
  requireValue(
    root.schemaVersion === ROADMAP_LEDGER_SCHEMA_VERSION,
    "invalid-value",
    "$.schemaVersion",
  );
  const references: RoadmapRunArtifactReferences = {
    schemaVersion: ROADMAP_LEDGER_SCHEMA_VERSION,
    ledger: ledgerReference(root.ledger, "$.ledger"),
    ...(root.plan === undefined ? {} : { plan: planReference(root.plan, "$.plan") }),
  };
  requireValue(references.ledger.digest === ledger.digest, "digest-mismatch", "$.ledger.digest");
  requireValue(
    references.ledger.repositoryRevision === ledger.repository.revision &&
      references.ledger.repositoryContentDigest === ledger.repository.contentDigest,
    "repository-mismatch",
    "$.ledger",
  );
  requireValue((references.plan === undefined) === (plan === undefined), "missing-field", "$.plan");
  if (references.plan && plan) {
    requireValue(references.plan.digest === plan.digest, "digest-mismatch", "$.plan.digest");
    requireValue(
      references.plan.repositoryRevision === plan.repository.revision &&
        references.plan.repositoryContentDigest === plan.repository.contentDigest,
      "repository-mismatch",
      "$.plan",
    );
  }
  return freeze(references);
}

export interface RoadmapMutationPlanValidationOptions {
  ledger: RoadmapLedger;
  now?: Date;
  currentTracker?: RoadmapTrackerObservation[];
}

export function validateRoadmapMutationPlan(
  value: unknown,
  options: RoadmapMutationPlanValidationOptions,
): RoadmapMutationPlan {
  const root = closed(value, "$", [
    "kind",
    "schemaVersion",
    "id",
    "ledger",
    "repository",
    "project",
    "trackerObservedAt",
    "operations",
    "generatedAt",
    "expiresAt",
    "digest",
  ]);
  requireValue(
    root.kind === "roadmap-mutation-plan" && root.schemaVersion === ROADMAP_LEDGER_SCHEMA_VERSION,
    "invalid-value",
    "$",
  );
  const plan: RoadmapMutationPlan = {
    kind: "roadmap-mutation-plan",
    schemaVersion: ROADMAP_LEDGER_SCHEMA_VERSION,
    id: identifier(root.id, "$.id"),
    ledger: ledgerReference(root.ledger, "$.ledger"),
    repository: repository(root.repository, "$.repository"),
    project: project(root.project, "$.project"),
    trackerObservedAt: timestamp(root.trackerObservedAt, "$.trackerObservedAt"),
    operations: array(root.operations, "$.operations")
      .map((item, index) => operation(item, `$.operations[${index}]`))
      .sort(compareRoadmap),
    generatedAt: timestamp(root.generatedAt, "$.generatedAt"),
    expiresAt: timestamp(root.expiresAt, "$.expiresAt"),
    digest: digest(root.digest, "$.digest"),
  };
  requireUnique(
    plan.operations.map((item) => item.key),
    "$.operations",
  );
  requireValue(plan.operations.length > 0, "invalid-value", "$.operations");
  requireValue(
    sameRepository(plan.repository, options.ledger.repository),
    "repository-mismatch",
    "$.repository",
  );
  requireValue(sameProject(plan.project, options.ledger.project), "project-mismatch", "$.project");
  requireValue(
    plan.ledger.digest === options.ledger.digest && plan.ledger.kind === "roadmap-ledger",
    "digest-mismatch",
    "$.ledger",
  );
  requireValue(
    plan.trackerObservedAt === options.ledger.trackerObservedAt,
    "tracker-drift",
    "$.trackerObservedAt",
  );
  requireValue(
    plan.ledger.repositoryRevision === options.ledger.repository.revision &&
      plan.ledger.repositoryContentDigest === options.ledger.repository.contentDigest,
    "repository-mismatch",
    "$.ledger",
  );
  requireValue(
    Date.parse(plan.trackerObservedAt) <= Date.parse(plan.generatedAt) &&
      Date.parse(options.ledger.updatedAt) <= Date.parse(plan.generatedAt),
    "invalid-time",
    "$.generatedAt",
  );
  requireValue(
    Date.parse(plan.generatedAt) <= Date.parse(plan.expiresAt),
    "invalid-time",
    "$.expiresAt",
  );
  validateOperationGraph(plan.operations, options.ledger);
  if (options.now)
    requireValue(
      Date.parse(plan.generatedAt) <= options.now.valueOf() &&
        options.now.valueOf() <= Date.parse(plan.expiresAt),
      "expired",
      "$.expiresAt",
    );
  if (options.currentTracker)
    validateCurrentTracker(options.ledger.tracker, options.currentTracker);
  requireValue(roadmapDigest(plan) === plan.digest, "digest-mismatch", "$.digest");
  return freeze(plan);
}

function validateOperationGraph(
  operations: RoadmapMutationOperation[],
  ledger: RoadmapLedger,
): void {
  const byKey = new Map(operations.map((item) => [item.key, item]));
  const findingIds = new Set(ledger.findings.map((item) => item.id));
  for (const item of operations) {
    requireValue(
      item.findingIds.length > 0,
      "missing-field",
      `$.operations.${item.key}.findingIds`,
    );
    requireReferences(item.findingIds, findingIds, `$.operations.${item.key}.findingIds`);
    requireReferences(
      item.dependsOnOperationKeys,
      new Set(byKey.keys()),
      `$.operations.${item.key}.dependsOnOperationKeys`,
    );
    requireValue(
      !item.dependsOnOperationKeys.includes(item.key),
      "unresolved-dependency",
      `$.operations.${item.key}.dependsOnOperationKeys`,
    );
    requireValue(
      item.proposal.kind === item.kind,
      "invalid-value",
      `$.operations.${item.key}.proposal.kind`,
    );
    requireValue(
      roadmapDigest(item.proposal) === item.payloadDigest,
      "digest-mismatch",
      `$.operations.${item.key}.payloadDigest`,
    );
    if (
      item.proposal.kind === "saga" ||
      item.proposal.kind === "issue" ||
      item.proposal.kind === "milestone"
    ) {
      requireValue(
        item.proposal.projectId === ledger.project.projectId &&
          item.targetKey === `project:${ledger.project.projectId}`,
        "project-mismatch",
        `$.operations.${item.key}.targetKey`,
      );
    } else {
      const issueIid =
        item.proposal.kind === "link" ? item.proposal.sourceIssueIid : item.proposal.issueIid;
      requireValue(
        item.targetKey === `issue:${issueIid}`,
        "tracker-drift",
        `$.operations.${item.key}.targetKey`,
      );
    }
    if (item.proposal.kind === "link") {
      const linkProposal = item.proposal;
      requireValue(
        linkProposal.sourceIssueIid !== linkProposal.targetIssueIid,
        "invalid-value",
        `$.operations.${item.key}.proposal.targetIssueIid`,
      );
      requireValue(
        linkProposal.targetPrecondition.targetKey === `issue:${linkProposal.targetIssueIid}`,
        "tracker-drift",
        `$.operations.${item.key}.proposal.targetPrecondition.targetKey`,
      );
      const targetObserved = ledger.tracker.find(
        (entry) => entry.issueIid === linkProposal.targetIssueIid,
      );
      requireValue(
        targetObserved?.updatedAt === linkProposal.targetPrecondition.observedAt &&
          targetObserved.identityDigest === linkProposal.targetPrecondition.identityDigest,
        "tracker-drift",
        `$.operations.${item.key}.proposal.targetPrecondition`,
      );
    }
    if (item.proposal.kind === "closure") {
      const closureProposal = item.proposal;
      const decision = ledger.closeouts.find(
        (entry) => entry.id === closureProposal.closeoutDecisionId,
      );
      requireValue(
        decision !== undefined &&
          decision.targetKey === item.targetKey &&
          decision.decision === closureProposal.action,
        "unresolved-reference",
        `$.operations.${item.key}.proposal.closeoutDecisionId`,
      );
      requireValue(
        closureProposal.evidenceDigest === roadmapDigest({ evidenceIds: decision.evidenceIds }),
        "digest-mismatch",
        `$.operations.${item.key}.proposal.evidenceDigest`,
      );
    }
    if (["update", "comment", "link", "label", "closure"].includes(item.kind)) {
      requireValue(
        item.precondition !== undefined,
        "missing-field",
        `$.operations.${item.key}.precondition`,
      );
    } else {
      requireValue(
        item.precondition === undefined,
        "invalid-value",
        `$.operations.${item.key}.precondition`,
      );
    }
    if (item.precondition) {
      requireValue(
        item.precondition.targetKey === item.targetKey,
        "tracker-drift",
        `$.operations.${item.key}.precondition.targetKey`,
      );
      const iid = issueIidFromTarget(item.precondition.targetKey);
      if (iid !== undefined) {
        const observed = ledger.tracker.find((entry) => entry.issueIid === iid);
        requireValue(
          observed?.updatedAt === item.precondition.observedAt &&
            observed.identityDigest === item.precondition.identityDigest,
          "tracker-drift",
          `$.operations.${item.key}.precondition`,
        );
      }
    }
  }
  assertAcyclic([...byKey.keys()], (id) => byKey.get(id)!.dependsOnOperationKeys, "$.operations");
}

function validateCurrentTracker(
  expected: RoadmapTrackerObservation[],
  current: RoadmapTrackerObservation[],
): void {
  const currentByIid = new Map(current.map((item) => [item.issueIid, item]));
  for (const item of expected) {
    const found = currentByIid.get(item.issueIid);
    requireValue(
      found?.updatedAt === item.updatedAt &&
        found.identityDigest === item.identityDigest &&
        found.state === item.state,
      "tracker-drift",
      `$.tracker.${item.issueIid}`,
    );
  }
}

function operation(value: unknown, path: string): RoadmapMutationOperation {
  const item = closed(
    value,
    path,
    [
      "key",
      "kind",
      "targetKey",
      "findingIds",
      "dependsOnOperationKeys",
      "payloadDigest",
      "payloadBytes",
      "proposal",
      "precondition",
    ],
    [
      "key",
      "kind",
      "targetKey",
      "findingIds",
      "dependsOnOperationKeys",
      "payloadDigest",
      "payloadBytes",
      "proposal",
    ],
  );
  return {
    key: identifier(item.key, `${path}.key`),
    kind: enumeration(item.kind, ROADMAP_OPERATION_KINDS, `${path}.kind`),
    targetKey: identifier(item.targetKey, `${path}.targetKey`),
    findingIds: idArray(item.findingIds, `${path}.findingIds`).sort(),
    dependsOnOperationKeys: idArray(
      item.dependsOnOperationKeys,
      `${path}.dependsOnOperationKeys`,
    ).sort(),
    payloadDigest: digest(item.payloadDigest, `${path}.payloadDigest`),
    payloadBytes: positiveInteger(item.payloadBytes, `${path}.payloadBytes`),
    proposal: proposal(item.proposal, `${path}.proposal`),
    ...(item.precondition === undefined
      ? {}
      : { precondition: precondition(item.precondition, `${path}.precondition`) }),
  };
}

function proposal(value: unknown, path: string): RoadmapMutationProposal {
  const base = closed(
    value,
    path,
    [
      "kind",
      "projectId",
      "titleDigest",
      "descriptionDigest",
      "milestoneIid",
      "labelNames",
      "parentSagaIid",
      "issueIid",
      "changedFields",
      "updateDigest",
      "commentDigest",
      "sourceIssueIid",
      "targetIssueIid",
      "relationship",
      "targetPrecondition",
      "dueDate",
      "add",
      "remove",
      "action",
      "closeoutDecisionId",
      "evidenceDigest",
    ],
    ["kind"],
  );
  const kind = enumeration(base.kind, ROADMAP_OPERATION_KINDS, `${path}.kind`);
  if (kind === "saga") {
    const item = closed(
      value,
      path,
      ["kind", "projectId", "titleDigest", "descriptionDigest", "milestoneIid", "labelNames"],
      ["kind", "projectId", "titleDigest", "descriptionDigest", "labelNames"],
    );
    return {
      kind,
      projectId: positiveInteger(item.projectId, `${path}.projectId`),
      titleDigest: digest(item.titleDigest, `${path}.titleDigest`),
      descriptionDigest: digest(item.descriptionDigest, `${path}.descriptionDigest`),
      ...(item.milestoneIid === undefined
        ? {}
        : { milestoneIid: positiveInteger(item.milestoneIid, `${path}.milestoneIid`) }),
      labelNames: identifierArray(item.labelNames, `${path}.labelNames`),
    };
  }
  if (kind === "issue") {
    const item = closed(
      value,
      path,
      [
        "kind",
        "projectId",
        "titleDigest",
        "descriptionDigest",
        "parentSagaIid",
        "milestoneIid",
        "labelNames",
      ],
      ["kind", "projectId", "titleDigest", "descriptionDigest", "labelNames"],
    );
    return {
      kind,
      projectId: positiveInteger(item.projectId, `${path}.projectId`),
      titleDigest: digest(item.titleDigest, `${path}.titleDigest`),
      descriptionDigest: digest(item.descriptionDigest, `${path}.descriptionDigest`),
      ...(item.parentSagaIid === undefined
        ? {}
        : { parentSagaIid: positiveInteger(item.parentSagaIid, `${path}.parentSagaIid`) }),
      ...(item.milestoneIid === undefined
        ? {}
        : { milestoneIid: positiveInteger(item.milestoneIid, `${path}.milestoneIid`) }),
      labelNames: identifierArray(item.labelNames, `${path}.labelNames`),
    };
  }
  if (kind === "update") {
    const item = closed(value, path, ["kind", "issueIid", "changedFields", "updateDigest"]);
    const changedFields = enumerationArray(
      item.changedFields,
      ["title", "description", "milestone", "weight", "due-date"] as const,
      `${path}.changedFields`,
    );
    requireValue(changedFields.length > 0, "invalid-value", `${path}.changedFields`);
    return {
      kind,
      issueIid: positiveInteger(item.issueIid, `${path}.issueIid`),
      changedFields,
      updateDigest: digest(item.updateDigest, `${path}.updateDigest`),
    };
  }
  if (kind === "comment") {
    const item = closed(value, path, ["kind", "issueIid", "commentDigest"]);
    return {
      kind,
      issueIid: positiveInteger(item.issueIid, `${path}.issueIid`),
      commentDigest: digest(item.commentDigest, `${path}.commentDigest`),
    };
  }
  if (kind === "link") {
    const item = closed(value, path, [
      "kind",
      "sourceIssueIid",
      "targetIssueIid",
      "relationship",
      "targetPrecondition",
    ]);
    return {
      kind,
      sourceIssueIid: positiveInteger(item.sourceIssueIid, `${path}.sourceIssueIid`),
      targetIssueIid: positiveInteger(item.targetIssueIid, `${path}.targetIssueIid`),
      relationship: enumeration(
        item.relationship,
        ["blocks", "is-blocked-by", "relates-to", "duplicates", "is-duplicated-by"] as const,
        `${path}.relationship`,
      ),
      targetPrecondition: precondition(item.targetPrecondition, `${path}.targetPrecondition`),
    };
  }
  if (kind === "milestone") {
    const item = closed(
      value,
      path,
      ["kind", "projectId", "titleDigest", "descriptionDigest", "dueDate"],
      ["kind", "projectId", "titleDigest"],
    );
    return {
      kind,
      projectId: positiveInteger(item.projectId, `${path}.projectId`),
      titleDigest: digest(item.titleDigest, `${path}.titleDigest`),
      ...(item.descriptionDigest === undefined
        ? {}
        : { descriptionDigest: digest(item.descriptionDigest, `${path}.descriptionDigest`) }),
      ...(item.dueDate === undefined ? {} : { dueDate: dateOnly(item.dueDate, `${path}.dueDate`) }),
    };
  }
  if (kind === "label") {
    const item = closed(value, path, ["kind", "issueIid", "add", "remove"]);
    const add = identifierArray(item.add, `${path}.add`);
    const remove = identifierArray(item.remove, `${path}.remove`);
    requireValue(
      add.length + remove.length > 0 && !add.some((label) => remove.includes(label)),
      "invalid-value",
      path,
    );
    return { kind, issueIid: positiveInteger(item.issueIid, `${path}.issueIid`), add, remove };
  }
  const item = closed(value, path, [
    "kind",
    "issueIid",
    "action",
    "closeoutDecisionId",
    "evidenceDigest",
  ]);
  return {
    kind: "closure",
    issueIid: positiveInteger(item.issueIid, `${path}.issueIid`),
    action: enumeration(item.action, ["close", "reopen"] as const, `${path}.action`),
    closeoutDecisionId: identifier(item.closeoutDecisionId, `${path}.closeoutDecisionId`),
    evidenceDigest: digest(item.evidenceDigest, `${path}.evidenceDigest`),
  };
}

function precondition(value: unknown, path: string): RoadmapMutationPrecondition {
  const item = closed(value, path, ["targetKey", "observedAt", "identityDigest"]);
  return {
    targetKey: identifier(item.targetKey, `${path}.targetKey`),
    observedAt: timestamp(item.observedAt, `${path}.observedAt`),
    identityDigest: digest(item.identityDigest, `${path}.identityDigest`),
  };
}

function ledgerReference(value: unknown, path: string): RoadmapLedgerReference {
  const item = closed(value, path, [
    "kind",
    "schemaVersion",
    "digest",
    "repositoryRevision",
    "repositoryContentDigest",
  ]);
  requireValue(item.kind === "roadmap-ledger" && item.schemaVersion === 1, "invalid-value", path);
  return {
    kind: "roadmap-ledger",
    schemaVersion: 1,
    digest: digest(item.digest, `${path}.digest`),
    repositoryRevision: revision(item.repositoryRevision, `${path}.repositoryRevision`),
    repositoryContentDigest: digest(
      item.repositoryContentDigest,
      `${path}.repositoryContentDigest`,
    ),
  };
}

function planReference(value: unknown, path: string): RoadmapMutationPlanReference {
  const item = closed(value, path, [
    "kind",
    "schemaVersion",
    "digest",
    "repositoryRevision",
    "repositoryContentDigest",
  ]);
  requireValue(
    item.kind === "roadmap-mutation-plan" && item.schemaVersion === 1,
    "invalid-value",
    path,
  );
  return {
    kind: "roadmap-mutation-plan",
    schemaVersion: 1,
    digest: digest(item.digest, `${path}.digest`),
    repositoryRevision: revision(item.repositoryRevision, `${path}.repositoryRevision`),
    repositoryContentDigest: digest(
      item.repositoryContentDigest,
      `${path}.repositoryContentDigest`,
    ),
  };
}
