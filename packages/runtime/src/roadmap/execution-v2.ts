// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { RoadmapOperationKind } from "./contracts/mutation.js";
import { RoadmapContractError, roadmapDigest } from "./contracts/decode.js";
import {
  validateRoadmapLedger,
  type RoadmapLedger,
  type RoadmapTrackerObservation,
} from "./contracts/ledger.js";
import { compareText } from "../shared/primitives.js";
import {
  array,
  closed,
  digest,
  enumeration,
  idArray,
  identifier,
  positiveInteger,
  requireValue,
  sameArray,
  timestamp,
  unique,
  type JsonObject,
} from "./execution-v2/primitives.js";
import {
  attempt,
  effectIdentity,
  issueIid,
  operation,
  operationInput,
  preconditionKey,
} from "./execution-v2/wire-codec.js";
import {
  ledgerReference,
  project,
  repository,
  sameProject,
  sameRepository,
} from "./execution-v2/value-codec.js";

import { ROADMAP_EFFECT_KINDS, ROADMAP_EXECUTION_SCHEMA_VERSION } from "./execution-v2/schema.js";
import type {
  RoadmapEffectIdentity,
  RoadmapEffectKind,
  RoadmapIssueEffectIdentity,
  RoadmapLinkEffectIdentity,
  RoadmapMilestoneEffectIdentity,
  RoadmapMutationAttemptDispositionV2,
  RoadmapMutationAttemptV2,
  RoadmapMutationAuthorizationV2,
  RoadmapMutationIntentV2,
  RoadmapMutationMaterialEvidenceV2,
  RoadmapMutationOperationV2,
  RoadmapMutationOperationV2Input,
  RoadmapMutationPlanV2,
  RoadmapMutationPreconditionV2,
  RoadmapMutationProposalV2,
  RoadmapMutationReceiptV2,
  RoadmapMutationTargetV2,
  RoadmapNoteEffectIdentity,
  RoadmapOperationIdempotencyScopeV2,
} from "./execution-v2/schema.js";
export { ROADMAP_EFFECT_KINDS, ROADMAP_EXECUTION_SCHEMA_VERSION };
export type {
  RoadmapEffectIdentity,
  RoadmapEffectKind,
  RoadmapIssueEffectIdentity,
  RoadmapLinkEffectIdentity,
  RoadmapMilestoneEffectIdentity,
  RoadmapMutationAttemptDispositionV2,
  RoadmapMutationAttemptV2,
  RoadmapMutationAuthorizationV2,
  RoadmapMutationIntentV2,
  RoadmapMutationMaterialEvidenceV2,
  RoadmapMutationOperationV2,
  RoadmapMutationOperationV2Input,
  RoadmapMutationPlanV2,
  RoadmapMutationPreconditionV2,
  RoadmapMutationProposalV2,
  RoadmapMutationReceiptV2,
  RoadmapMutationTargetV2,
  RoadmapNoteEffectIdentity,
  RoadmapOperationIdempotencyScopeV2,
};

export function roadmapOperationIdempotencyKeyV2(
  operation: Omit<RoadmapMutationOperationV2, "idempotencyKey">,
  scope: RoadmapOperationIdempotencyScopeV2,
): string {
  return roadmapDigest({
    contract: "roadmap-operation-idempotency-v2",
    ledgerDigest: scope.ledgerDigest,
    repository: scope.repository,
    project: scope.project,
    key: operation.key,
    kind: operation.kind,
    target: operation.target,
    ...(operation.relatedTarget === undefined ? {} : { relatedTarget: operation.relatedTarget }),
    proposalDigest: operation.proposalDigest,
    materialDigest: operation.materialDigest,
    materialBytes: operation.materialBytes,
  });
}

/** Provider-neutral marker that the host must observe on a project-created effect. */
export function roadmapProjectEffectProofDigestV2(operation: RoadmapMutationOperationV2): string {
  return roadmapDigest({
    contract: "roadmap-project-effect-proof-v2",
    operationKey: operation.key,
    idempotencyKey: operation.idempotencyKey,
    target: operation.target,
    proposalDigest: operation.proposalDigest,
    materialDigest: operation.materialDigest,
    materialBytes: operation.materialBytes,
    expectedEffectKind: operation.expectedEffectKind,
  });
}

export function createRoadmapMutationPlanV2(
  input: Omit<RoadmapMutationPlanV2, "kind" | "schemaVersion" | "operations" | "digest"> & {
    operations: RoadmapMutationOperationV2Input[];
  },
  ledger: RoadmapLedger,
): RoadmapMutationPlanV2 {
  const scope: RoadmapOperationIdempotencyScopeV2 = {
    ledgerDigest: input.ledger.digest,
    repository: input.repository,
    project: input.project,
  };
  const operations = array(input.operations, "$.operations")
    .map((value, index) => operationInput(value, `$.operations[${index}]`))
    .map((operation) => {
      const normalized = {
        ...operation,
        findingIds: [...operation.findingIds].sort(compareText),
        dependsOnOperationKeys: [...operation.dependsOnOperationKeys].sort(compareText),
        preconditions: [...operation.preconditions].sort((left, right) =>
          compareText(preconditionKey(left), preconditionKey(right)),
        ),
      };
      const withProposal = {
        ...normalized,
        proposalDigest: roadmapDigest(normalized.proposal),
      };
      return {
        ...withProposal,
        idempotencyKey: roadmapOperationIdempotencyKeyV2(withProposal, scope),
      };
    })
    .sort((left, right) => compareText(left.key, right.key));
  const candidate: RoadmapMutationPlanV2 = {
    kind: "roadmap-mutation-plan",
    schemaVersion: ROADMAP_EXECUTION_SCHEMA_VERSION,
    ...input,
    operations,
    digest: "0".repeat(64),
  };
  candidate.digest = roadmapDigest(candidate);
  return validateRoadmapMutationPlanV2(candidate, ledger);
}

export function validateRoadmapMutationPlanV2(
  value: unknown,
  ledgerValue: RoadmapLedger,
): RoadmapMutationPlanV2 {
  const ledger = validateRoadmapLedger(ledgerValue);
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
    root.kind === "roadmap-mutation-plan" &&
      root.schemaVersion === ROADMAP_EXECUTION_SCHEMA_VERSION,
    "invalid-value",
    "$",
  );
  const plan: RoadmapMutationPlanV2 = {
    kind: "roadmap-mutation-plan",
    schemaVersion: ROADMAP_EXECUTION_SCHEMA_VERSION,
    id: identifier(root.id, "$.id"),
    ledger: ledgerReference(root.ledger, "$.ledger"),
    repository: repository(root.repository, "$.repository"),
    project: project(root.project, "$.project"),
    trackerObservedAt: timestamp(root.trackerObservedAt, "$.trackerObservedAt"),
    operations: array(root.operations, "$.operations")
      .map((item, index) => operation(item, `$.operations[${index}]`))
      .sort((left, right) => compareText(left.key, right.key)),
    generatedAt: timestamp(root.generatedAt, "$.generatedAt"),
    expiresAt: timestamp(root.expiresAt, "$.expiresAt"),
    digest: digest(root.digest, "$.digest"),
  };
  requireValue(plan.operations.length > 0, "invalid-value", "$.operations");
  unique(
    plan.operations.map((item) => item.key),
    "$.operations",
  );
  requireValue(
    sameRepository(plan.repository, ledger.repository),
    "repository-mismatch",
    "$.repository",
  );
  requireValue(sameProject(plan.project, ledger.project), "project-mismatch", "$.project");
  requireValue(plan.ledger.digest === ledger.digest, "digest-mismatch", "$.ledger.digest");
  requireValue(
    plan.ledger.repositoryRevision === ledger.repository.revision &&
      plan.ledger.repositoryContentDigest === ledger.repository.contentDigest,
    "repository-mismatch",
    "$.ledger",
  );
  requireValue(
    plan.trackerObservedAt === ledger.trackerObservedAt,
    "tracker-drift",
    "$.trackerObservedAt",
  );
  requireValue(
    Date.parse(ledger.updatedAt) <= Date.parse(plan.generatedAt) &&
      Date.parse(plan.generatedAt) <= Date.parse(plan.expiresAt),
    "invalid-time",
    "$.expiresAt",
  );
  validateGraph(plan.operations, ledger);
  requireValue(roadmapDigest(plan) === plan.digest, "digest-mismatch", "$.digest");
  return freeze(plan);
}

export function createRoadmapMutationAuthorizationV2(
  input: Omit<
    RoadmapMutationAuthorizationV2,
    "kind" | "schemaVersion" | "planDigest" | "repository" | "project" | "decision" | "digest"
  >,
  plan: RoadmapMutationPlanV2,
  ledger: RoadmapLedger,
): RoadmapMutationAuthorizationV2 {
  validateRoadmapMutationPlanV2(plan, ledger);
  const authorizedOperationKeys = idArray(
    input.authorizedOperationKeys,
    "$.authorizedOperationKeys",
  );
  const candidate: RoadmapMutationAuthorizationV2 = {
    kind: "roadmap-mutation-authorization",
    schemaVersion: ROADMAP_EXECUTION_SCHEMA_VERSION,
    ...input,
    planDigest: plan.digest,
    repository: plan.repository,
    project: plan.project,
    authorizedOperationKeys,
    decision: "approved",
    digest: "0".repeat(64),
  };
  candidate.digest = roadmapDigest(candidate);
  return validateRoadmapMutationAuthorizationV2(candidate, plan, ledger);
}

export function validateRoadmapMutationAuthorizationV2(
  value: unknown,
  planValue: RoadmapMutationPlanV2,
  ledger: RoadmapLedger,
): RoadmapMutationAuthorizationV2 {
  const plan = validateRoadmapMutationPlanV2(planValue, ledger);
  const root = closed(value, "$", [
    "kind",
    "schemaVersion",
    "id",
    "planDigest",
    "repository",
    "project",
    "authorizedOperationKeys",
    "authority",
    "decision",
    "issuedAt",
    "expiresAt",
    "digest",
  ]);
  requireValue(
    root.kind === "roadmap-mutation-authorization" &&
      root.schemaVersion === ROADMAP_EXECUTION_SCHEMA_VERSION &&
      root.decision === "approved",
    "invalid-value",
    "$",
  );
  const authority = closed(root.authority, "$.authority", ["kind", "id"]);
  const authorization: RoadmapMutationAuthorizationV2 = {
    kind: "roadmap-mutation-authorization",
    schemaVersion: ROADMAP_EXECUTION_SCHEMA_VERSION,
    id: identifier(root.id, "$.id"),
    planDigest: digest(root.planDigest, "$.planDigest"),
    repository: repository(root.repository, "$.repository"),
    project: project(root.project, "$.project"),
    authorizedOperationKeys: idArray(root.authorizedOperationKeys, "$.authorizedOperationKeys"),
    authority: {
      kind: enumeration(authority.kind, ["local-user", "host-policy"] as const, "$.authority.kind"),
      id: identifier(authority.id, "$.authority.id"),
    },
    decision: "approved",
    issuedAt: timestamp(root.issuedAt, "$.issuedAt"),
    expiresAt: timestamp(root.expiresAt, "$.expiresAt"),
    digest: digest(root.digest, "$.digest"),
  };
  unique(authorization.authorizedOperationKeys, "$.authorizedOperationKeys");
  requireValue(
    authorization.authorizedOperationKeys.length > 0,
    "invalid-value",
    "$.authorizedOperationKeys",
  );
  requireValue(authorization.planDigest === plan.digest, "digest-mismatch", "$.planDigest");
  requireValue(
    sameRepository(authorization.repository, plan.repository),
    "repository-mismatch",
    "$.repository",
  );
  requireValue(sameProject(authorization.project, plan.project), "project-mismatch", "$.project");
  const authorized = new Set(authorization.authorizedOperationKeys);
  for (const key of authorization.authorizedOperationKeys) {
    const operation = plan.operations.find((item) => item.key === key);
    requireValue(operation !== undefined, "operation-expansion", "$.authorizedOperationKeys");
    requireValue(
      operation.dependsOnOperationKeys.every((dependency) => authorized.has(dependency)),
      "unresolved-dependency",
      "$.authorizedOperationKeys",
    );
  }
  requireValue(
    Date.parse(plan.generatedAt) <= Date.parse(authorization.issuedAt) &&
      Date.parse(authorization.issuedAt) <= Date.parse(authorization.expiresAt),
    "invalid-time",
    "$.expiresAt",
  );
  requireValue(
    Date.parse(authorization.expiresAt) <= Date.parse(plan.expiresAt),
    "invalid-time",
    "$.expiresAt",
  );
  requireValue(
    roadmapDigest(authorization) === authorization.digest,
    "digest-mismatch",
    "$.digest",
  );
  return freeze(authorization);
}

export function createRoadmapMutationReceiptV2(
  input: Omit<
    RoadmapMutationReceiptV2,
    | "kind"
    | "schemaVersion"
    | "planDigest"
    | "authorizationDigest"
    | "lastConfirmedOperationKey"
    | "remainingOperationKeys"
    | "terminal"
    | "digest"
  >,
  ledger: RoadmapLedger,
  plan: RoadmapMutationPlanV2,
  authorization: RoadmapMutationAuthorizationV2,
): RoadmapMutationReceiptV2 {
  const attempts = array(input.attempts, "$.attempts").map((value, index) =>
    attempt(value, `$.attempts[${index}]`),
  );
  const progress = receiptProgress(attempts, authorization.authorizedOperationKeys);
  const candidate: RoadmapMutationReceiptV2 = {
    kind: "roadmap-mutation-receipt",
    schemaVersion: ROADMAP_EXECUTION_SCHEMA_VERSION,
    ...input,
    attempts,
    planDigest: plan.digest,
    authorizationDigest: authorization.digest,
    ...(progress.lastConfirmedOperationKey === undefined
      ? {}
      : { lastConfirmedOperationKey: progress.lastConfirmedOperationKey }),
    remainingOperationKeys: progress.remainingOperationKeys,
    terminal: progress.terminal,
    digest: "0".repeat(64),
  };
  candidate.digest = roadmapDigest(candidate);
  return validateRoadmapMutationReceiptV2(candidate, ledger, plan, authorization);
}

export function validateRoadmapMutationReceiptV2(
  value: unknown,
  ledger: RoadmapLedger,
  planValue: RoadmapMutationPlanV2,
  authorizationValue: RoadmapMutationAuthorizationV2,
): RoadmapMutationReceiptV2 {
  const plan = validateRoadmapMutationPlanV2(planValue, ledger);
  const authorization = validateRoadmapMutationAuthorizationV2(authorizationValue, plan, ledger);
  const root = closed(
    value,
    "$",
    [
      "kind",
      "schemaVersion",
      "id",
      "planDigest",
      "authorizationDigest",
      "attempts",
      "lastConfirmedOperationKey",
      "remainingOperationKeys",
      "terminal",
      "createdAt",
      "updatedAt",
      "digest",
    ],
    [
      "kind",
      "schemaVersion",
      "id",
      "planDigest",
      "authorizationDigest",
      "attempts",
      "remainingOperationKeys",
      "terminal",
      "createdAt",
      "updatedAt",
      "digest",
    ],
  );
  requireValue(
    root.kind === "roadmap-mutation-receipt" &&
      root.schemaVersion === ROADMAP_EXECUTION_SCHEMA_VERSION,
    "invalid-value",
    "$",
  );
  const receipt: RoadmapMutationReceiptV2 = {
    kind: "roadmap-mutation-receipt",
    schemaVersion: ROADMAP_EXECUTION_SCHEMA_VERSION,
    id: identifier(root.id, "$.id"),
    planDigest: digest(root.planDigest, "$.planDigest"),
    authorizationDigest: digest(root.authorizationDigest, "$.authorizationDigest"),
    attempts: array(root.attempts, "$.attempts").map((item, index) =>
      attempt(item, `$.attempts[${index}]`),
    ),
    ...(root.lastConfirmedOperationKey === undefined
      ? {}
      : {
          lastConfirmedOperationKey: identifier(
            root.lastConfirmedOperationKey,
            "$.lastConfirmedOperationKey",
          ),
        }),
    remainingOperationKeys: idArray(root.remainingOperationKeys, "$.remainingOperationKeys"),
    terminal: enumeration(
      root.terminal,
      ["complete", "partial", "failed", "ambiguous"] as const,
      "$.terminal",
    ),
    createdAt: timestamp(root.createdAt, "$.createdAt"),
    updatedAt: timestamp(root.updatedAt, "$.updatedAt"),
    digest: digest(root.digest, "$.digest"),
  };
  requireValue(receipt.planDigest === plan.digest, "digest-mismatch", "$.planDigest");
  requireValue(
    receipt.authorizationDigest === authorization.digest,
    "digest-mismatch",
    "$.authorizationDigest",
  );
  requireValue(receipt.attempts.length > 0, "invalid-value", "$.attempts");
  requireValue(
    Date.parse(authorization.issuedAt) <= Date.parse(receipt.createdAt) &&
      Date.parse(receipt.createdAt) <= Date.parse(receipt.updatedAt),
    "invalid-time",
    "$.updatedAt",
  );
  validateAttempts(
    receipt.attempts,
    ledger,
    plan,
    authorization,
    receipt.createdAt,
    receipt.updatedAt,
  );
  const progress = receiptProgress(receipt.attempts, authorization.authorizedOperationKeys);
  requireValue(
    receipt.lastConfirmedOperationKey === progress.lastConfirmedOperationKey,
    "unresolved-dependency",
    "$.lastConfirmedOperationKey",
  );
  requireValue(
    sameArray(receipt.remainingOperationKeys, progress.remainingOperationKeys),
    "unresolved-dependency",
    "$.remainingOperationKeys",
  );
  requireValue(receipt.terminal === progress.terminal, "invalid-value", "$.terminal");
  requireValue(roadmapDigest(receipt) === receipt.digest, "digest-mismatch", "$.digest");
  return freeze(receipt);
}

export interface AssertRoadmapOperationStartableV2Options {
  ledger: RoadmapLedger;
  plan: RoadmapMutationPlanV2;
  authorization: RoadmapMutationAuthorizationV2;
  operationKey: string;
  now: Date;
  currentTracker: RoadmapTrackerObservation[];
  currentDependencyEffects?: RoadmapEffectIdentity[];
  material: RoadmapMutationMaterialEvidenceV2;
  receipt?: RoadmapMutationReceiptV2;
}

export function assertRoadmapOperationStartableV2(
  options: AssertRoadmapOperationStartableV2Options,
): RoadmapMutationOperationV2 {
  const plan = validateRoadmapMutationPlanV2(options.plan, options.ledger);
  const authorization = validateRoadmapMutationAuthorizationV2(
    options.authorization,
    plan,
    options.ledger,
  );
  requireValue(
    Date.parse(plan.generatedAt) <= options.now.valueOf() &&
      options.now.valueOf() <= Date.parse(plan.expiresAt),
    "expired",
    "$.plan.expiresAt",
  );
  requireValue(
    Date.parse(authorization.issuedAt) <= options.now.valueOf() &&
      options.now.valueOf() <= Date.parse(authorization.expiresAt),
    "expired",
    "$.authorization.expiresAt",
  );
  const operation = plan.operations.find((item) => item.key === options.operationKey);
  requireValue(
    operation !== undefined && authorization.authorizedOperationKeys.includes(operation.key),
    "operation-expansion",
    "$.operationKey",
  );
  validateMaterial(options.material, operation);
  const receipt =
    options.receipt === undefined
      ? undefined
      : validateRoadmapMutationReceiptV2(options.receipt, options.ledger, plan, authorization);
  const completed = completedEffects(receipt?.attempts ?? []);
  requireValue(!completed.has(operation.key), "invalid-value", "$.operationKey");
  for (const dependency of operation.dependsOnOperationKeys) {
    requireValue(
      completed.has(dependency),
      "unresolved-dependency",
      `$.operations.${operation.key}.dependsOnOperationKeys`,
    );
  }
  const previous = receipt?.attempts.filter((item) => item.operationKey === operation.key).at(-1);
  requireValue(
    previous?.disposition !== "ambiguous",
    "ambiguous-effect",
    `$.attempts.${operation.key}`,
  );
  requireValue(previous?.disposition !== "skipped", "invalid-value", `$.attempts.${operation.key}`);
  const currentDependencyEffects = array(
    options.currentDependencyEffects ?? [],
    "$.currentDependencyEffects",
  ).map((item, index) => effectIdentity(item, `$.currentDependencyEffects[${index}]`));
  unique(currentDependencyEffects.map(effectIdentityKey), "$.currentDependencyEffects");
  if (receipt === undefined || receipt.attempts.length === 0) {
    validateTrackerObservations(options.ledger.tracker, options.currentTracker, "$.tracker");
  } else {
    const materialObservations = operation.preconditions
      .filter(
        (item): item is Extract<RoadmapMutationPreconditionV2, { source: "ledger-observation" }> =>
          item.source === "ledger-observation",
      )
      .map((item) => {
        const iid = issueIid(item.targetKey);
        requireValue(
          iid !== undefined,
          "invalid-value",
          `$.operations.${operation.key}.preconditions`,
        );
        return {
          issueIid: iid,
          state: trackerState(options.ledger, iid),
          updatedAt: item.observedAt,
          identityDigest: item.identityDigest,
        };
      });
    validateTrackerObservations(materialObservations, options.currentTracker, "$.tracker");
  }
  for (const precondition of operation.preconditions) {
    if (precondition.source === "dependency-result") {
      const effect = completed.get(precondition.operationKey);
      requireValue(
        effect?.kind === precondition.effectKind,
        "unresolved-dependency",
        `$.operations.${operation.key}.preconditions`,
      );
      const current = currentDependencyEffects.find(
        (item) => effectIdentityKey(item) === effectIdentityKey(effect),
      );
      requireValue(
        current !== undefined && sameEffectIdentity(current, effect),
        "tracker-drift",
        `$.operations.${operation.key}.preconditions`,
      );
    }
  }
  if (operation.target.source === "dependency-result") {
    const effect = completed.get(operation.target.operationKey);
    requireValue(
      effect?.kind === operation.target.effectKind,
      "unresolved-dependency",
      `$.operations.${operation.key}.target`,
    );
  }
  if (operation.relatedTarget?.source === "dependency-result") {
    const effect = completed.get(operation.relatedTarget.operationKey);
    requireValue(
      effect?.kind === operation.relatedTarget.effectKind,
      "unresolved-dependency",
      `$.operations.${operation.key}.relatedTarget`,
    );
  }
  return operation;
}

/** Rejects historical execution authority without attempting a semantic migration. */
export function requireRoadmapExecutionV2(value: unknown): void {
  const root = closed(value, "$", ["kind", "schemaVersion"], ["kind", "schemaVersion"], true);
  requireValue(
    [
      "roadmap-mutation-plan",
      "roadmap-mutation-authorization",
      "roadmap-mutation-receipt",
    ].includes(String(root.kind)),
    "invalid-value",
    "$.kind",
  );
  if (root.schemaVersion === 1)
    throw new RoadmapContractError("replan-required", "$.schemaVersion");
  requireValue(
    root.schemaVersion === ROADMAP_EXECUTION_SCHEMA_VERSION,
    "invalid-value",
    "$.schemaVersion",
  );
}

function validateGraph(operations: RoadmapMutationOperationV2[], ledger: RoadmapLedger): void {
  const byKey = new Map(operations.map((item) => [item.key, item]));
  const findings = new Set(ledger.findings.map((item) => item.id));
  const idempotencyScope: RoadmapOperationIdempotencyScopeV2 = {
    ledgerDigest: ledger.digest,
    repository: ledger.repository,
    project: ledger.project,
  };
  for (const item of operations) {
    requireValue(
      item.findingIds.length > 0 && item.findingIds.every((id) => findings.has(id)),
      "unresolved-reference",
      `$.operations.${item.key}.findingIds`,
    );
    unique(item.findingIds, `$.operations.${item.key}.findingIds`);
    unique(item.dependsOnOperationKeys, `$.operations.${item.key}.dependsOnOperationKeys`);
    unique(item.preconditions.map(preconditionKey), `$.operations.${item.key}.preconditions`);
    requireValue(
      item.dependsOnOperationKeys.every((key) => byKey.has(key) && key !== item.key),
      "unresolved-dependency",
      `$.operations.${item.key}.dependsOnOperationKeys`,
    );
    requireValue(
      item.proposal.kind === item.kind && item.proposal.effectKind === item.expectedEffectKind,
      "invalid-value",
      `$.operations.${item.key}.proposal`,
    );
    requireValue(
      expectedEffect(item.kind) === item.expectedEffectKind,
      "invalid-value",
      `$.operations.${item.key}.expectedEffectKind`,
    );
    requireValue(
      expectedIntent(item.kind, item.proposal.intent),
      "invalid-value",
      `$.operations.${item.key}.proposal.intent`,
    );
    requireValue(
      roadmapDigest(item.proposal) === item.proposalDigest,
      "digest-mismatch",
      `$.operations.${item.key}.proposalDigest`,
    );
    const { idempotencyKey: _idempotencyKey, ...idempotencyMaterial } = item;
    requireValue(
      roadmapOperationIdempotencyKeyV2(idempotencyMaterial, idempotencyScope) ===
        item.idempotencyKey,
      "digest-mismatch",
      `$.operations.${item.key}.idempotencyKey`,
    );
    validateOperationTarget(item.target, item, ledger, `$.operations.${item.key}.target`);
    if (item.relatedTarget !== undefined)
      validateOperationTarget(
        item.relatedTarget,
        item,
        ledger,
        `$.operations.${item.key}.relatedTarget`,
      );
    const allowsRelatedTarget =
      item.kind === "link" ||
      (item.kind === "update" && item.proposal.intent === "assign-milestone");
    requireValue(
      (item.relatedTarget !== undefined) === allowsRelatedTarget,
      item.relatedTarget === undefined ? "missing-field" : "invalid-value",
      `$.operations.${item.key}.relatedTarget`,
    );
    for (const precondition of item.preconditions) {
      if (precondition.source === "ledger-observation") {
        const iid = requireLedgerTarget(
          precondition.targetKey,
          ledger,
          `$.operations.${item.key}.preconditions`,
        );
        const observed = ledger.tracker.find((entry) => entry.issueIid === iid)!;
        requireValue(
          precondition.observedAt === observed.updatedAt &&
            precondition.identityDigest === observed.identityDigest,
          "tracker-drift",
          `$.operations.${item.key}.preconditions`,
        );
      } else {
        requireValue(
          item.dependsOnOperationKeys.includes(precondition.operationKey),
          "unresolved-dependency",
          `$.operations.${item.key}.preconditions`,
        );
      }
    }
    requireTargetPrecondition(
      item.target,
      item.preconditions,
      `$.operations.${item.key}.preconditions`,
    );
    if (item.relatedTarget !== undefined)
      requireTargetPrecondition(
        item.relatedTarget,
        item.preconditions,
        `$.operations.${item.key}.preconditions`,
      );
  }
  assertAcyclic(operations);
}

function validateOperationTarget(
  targetValue: RoadmapMutationTargetV2,
  operationValue: RoadmapMutationOperationV2,
  ledger: RoadmapLedger,
  path: string,
): void {
  const isRelated = path.endsWith(".relatedTarget");
  const createsProjectChild =
    operationValue.kind === "saga" ||
    operationValue.kind === "issue" ||
    operationValue.kind === "milestone";
  if (!isRelated && createsProjectChild) {
    requireValue(
      targetValue.source === "project" &&
        targetValue.targetKey === `project:${ledger.project.projectId}`,
      "project-mismatch",
      path,
    );
    return;
  }
  requireValue(targetValue.source !== "project", "invalid-value", path);
  if (targetValue.source === "ledger-observation") {
    requireValue(
      !(isRelated && operationValue.proposal.intent === "assign-milestone"),
      "invalid-value",
      path,
    );
    requireLedgerTarget(targetValue.targetKey, ledger, path);
    return;
  }
  requireValue(
    operationValue.dependsOnOperationKeys.includes(targetValue.operationKey),
    "unresolved-dependency",
    path,
  );
  const expectedKind: RoadmapEffectKind =
    isRelated && operationValue.proposal.intent === "assign-milestone" ? "milestone" : "issue";
  requireValue(targetValue.effectKind === expectedKind, "invalid-value", `${path}.effectKind`);
}

function requireTargetPrecondition(
  targetValue: RoadmapMutationTargetV2,
  preconditions: RoadmapMutationPreconditionV2[],
  path: string,
): void {
  if (targetValue.source === "project") return;
  const found =
    targetValue.source === "ledger-observation"
      ? preconditions.some(
          (item) =>
            item.source === "ledger-observation" && item.targetKey === targetValue.targetKey,
        )
      : preconditions.some(
          (item) =>
            item.source === "dependency-result" &&
            item.operationKey === targetValue.operationKey &&
            item.effectKind === targetValue.effectKind,
        );
  requireValue(found, "missing-field", path);
}

function validateAttempts(
  attempts: RoadmapMutationAttemptV2[],
  ledger: RoadmapLedger,
  plan: RoadmapMutationPlanV2,
  authorization: RoadmapMutationAuthorizationV2,
  createdAt: string,
  updatedAt: string,
): void {
  const operations = new Map(plan.operations.map((item) => [item.key, item]));
  const authorized = new Set(authorization.authorizedOperationKeys);
  const byOperation = new Map<string, RoadmapMutationAttemptV2[]>();
  const effects = new Map<string, RoadmapEffectIdentity>();
  let precedingCompletedAt = createdAt;
  for (const item of attempts) {
    const operation = operations.get(item.operationKey);
    requireValue(
      operation !== undefined && authorized.has(item.operationKey),
      "operation-expansion",
      `$.attempts.${item.operationKey}`,
    );
    requireValue(
      item.idempotencyKey === operation.idempotencyKey,
      "digest-mismatch",
      `$.attempts.${item.operationKey}.idempotencyKey`,
    );
    const prior = byOperation.get(item.operationKey) ?? [];
    requireValue(
      item.attempt === prior.length + 1,
      "invalid-value",
      `$.attempts.${item.operationKey}.attempt`,
    );
    requireValue(
      Date.parse(precedingCompletedAt) <= Date.parse(item.startedAt) &&
        Date.parse(item.startedAt) <= Date.parse(item.completedAt),
      "invalid-time",
      `$.attempts.${item.operationKey}`,
    );
    if (item.phase === "mutation") {
      requireValue(
        Date.parse(plan.generatedAt) <= Date.parse(item.startedAt) &&
          Date.parse(item.startedAt) <= Date.parse(plan.expiresAt),
        "expired",
        `$.attempts.${item.operationKey}.startedAt`,
      );
      requireValue(
        Date.parse(authorization.issuedAt) <= Date.parse(item.startedAt) &&
          Date.parse(item.startedAt) <= Date.parse(authorization.expiresAt),
        "expired",
        `$.attempts.${item.operationKey}.startedAt`,
      );
    }
    requireValue(
      Date.parse(item.completedAt) <= Date.parse(updatedAt),
      "invalid-time",
      `$.attempts.${item.operationKey}.completedAt`,
    );
    requireValue(
      item.before === undefined ||
        Date.parse(item.before.updatedAt) <= Date.parse(item.completedAt),
      "invalid-time",
      `$.attempts.${item.operationKey}.before`,
    );
    requireValue(
      item.effect === undefined ||
        Date.parse(item.effect.updatedAt) <= Date.parse(item.completedAt),
      "invalid-time",
      `$.attempts.${item.operationKey}.effect`,
    );
    for (const dependency of operation.dependsOnOperationKeys)
      requireValue(
        effects.has(dependency),
        "unresolved-dependency",
        `$.attempts.${item.operationKey}`,
      );
    validateAttemptDisposition(item, operation, prior.at(-1));
    if (item.effect) validateEffectForOperation(item, operation, effects);
    validateAttemptBefore(item, operation, effects, ledger);
    if (item.disposition === "succeeded" || item.disposition === "reused")
      effects.set(item.operationKey, item.effect!);
    prior.push(item);
    byOperation.set(item.operationKey, prior);
    precedingCompletedAt = item.completedAt;
  }
}

function validateAttemptDisposition(
  item: RoadmapMutationAttemptV2,
  operation: RoadmapMutationOperationV2,
  previous: RoadmapMutationAttemptV2 | undefined,
): void {
  const path = `$.attempts.${item.operationKey}`;
  if (previous === undefined) {
    requireValue(
      item.attempt === 1 && item.phase === "mutation" && item.reconcilesAttempt === undefined,
      "invalid-value",
      path,
    );
  } else if (previous.disposition === "failed") {
    requireValue(
      item.phase === "mutation" && item.reconcilesAttempt === undefined,
      "invalid-value",
      path,
    );
  } else if (previous.disposition === "ambiguous") {
    requireValue(item.phase === "reconciliation", "ambiguous-effect", `${path}.phase`);
    requireValue(
      item.reconcilesAttempt === previous.attempt,
      "ambiguous-effect",
      `${path}.reconcilesAttempt`,
    );
    requireValue(
      item.disposition === "reused" ||
        (item.disposition === "failed" && item.failureCode === "effect-confirmed-absent"),
      "ambiguous-effect",
      path,
    );
  } else {
    requireValue(false, "invalid-value", path);
  }
  if (item.disposition === "succeeded" || item.disposition === "reused") {
    requireValue(
      item.effect !== undefined && item.failureCode === undefined,
      "missing-field",
      `${path}.effect`,
    );
  } else {
    requireValue(
      item.effect === undefined && item.failureCode !== undefined,
      "invalid-value",
      path,
    );
  }
  if (item.disposition === "reused")
    requireValue(
      item.effect?.kind === operation.expectedEffectKind,
      "invalid-value",
      `${path}.effect`,
    );
  if (item.disposition === "ambiguous")
    requireValue(
      item.reconcilesAttempt === undefined,
      "invalid-value",
      `${path}.reconcilesAttempt`,
    );
  if (item.phase === "reconciliation")
    requireValue(
      item.disposition === "reused" || item.disposition === "failed",
      "ambiguous-effect",
      path,
    );
}

function validateAttemptBefore(
  item: RoadmapMutationAttemptV2,
  operation: RoadmapMutationOperationV2,
  completed: Map<string, RoadmapEffectIdentity>,
  ledger: RoadmapLedger,
): void {
  const path = `$.attempts.${item.operationKey}.before`;
  if (operation.target.source === "project") {
    requireValue(item.before === undefined, "invalid-value", path);
    return;
  }
  requireValue(item.before !== undefined, "missing-field", path);
  const before = effectIdentity(item.before, path);
  requireValue(before.kind === "issue", "tracker-drift", `${path}.kind`);
  if (operation.target.source === "ledger-observation") {
    const iid = issueIid(operation.target.targetKey);
    const observed =
      iid === undefined ? undefined : ledger.tracker.find((entry) => entry.issueIid === iid);
    requireValue(
      observed !== undefined &&
        before.targetKey === operation.target.targetKey &&
        before.externalId === String(iid) &&
        before.state === observed.state &&
        before.updatedAt === observed.updatedAt &&
        before.identityDigest === observed.identityDigest,
      "tracker-drift",
      path,
    );
    requireValue(
      before.operationProofDigest === undefined,
      "tracker-drift",
      `${path}.operationProofDigest`,
    );
    return;
  }
  const dependency = completed.get(operation.target.operationKey);
  requireValue(
    dependency !== undefined && sameEffectIdentity(before, dependency),
    "tracker-drift",
    path,
  );
}

function validateEffectForOperation(
  item: RoadmapMutationAttemptV2,
  operation: RoadmapMutationOperationV2,
  completed: Map<string, RoadmapEffectIdentity>,
): void {
  const effect = item.effect!;
  validateEffectIdentity(effect, `$.attempts.${operation.key}.effect`);
  requireValue(
    effect.kind === operation.expectedEffectKind,
    "invalid-value",
    `$.attempts.${operation.key}.effect.kind`,
  );
  if (operation.target.source === "project") {
    requireValue(
      effect.operationProofDigest === roadmapProjectEffectProofDigestV2(operation),
      "tracker-drift",
      `$.attempts.${operation.key}.effect.operationProofDigest`,
    );
  } else {
    requireValue(
      effect.operationProofDigest === undefined,
      "invalid-value",
      `$.attempts.${operation.key}.effect.operationProofDigest`,
    );
  }
  const subject = resolvedTargetKey(operation.target, completed);
  if (subject !== undefined) {
    if (effect.kind === "note" || effect.kind === "link")
      requireValue(
        effect.subjectTargetKey === subject,
        "tracker-drift",
        `$.attempts.${operation.key}.effect.subjectTargetKey`,
      );
    else
      requireValue(
        effect.targetKey === subject,
        "tracker-drift",
        `$.attempts.${operation.key}.effect.targetKey`,
      );
  }
  if (effect.kind === "link") {
    const related =
      operation.relatedTarget === undefined
        ? undefined
        : resolvedTargetKey(operation.relatedTarget, completed);
    requireValue(
      related !== undefined && effect.relatedTargetKey === related,
      "tracker-drift",
      `$.attempts.${operation.key}.effect.relatedTargetKey`,
    );
  }
  if (operation.kind === "saga" || operation.kind === "issue")
    requireValue(
      effect.kind === "issue" && effect.state === "opened",
      "tracker-drift",
      `$.attempts.${operation.key}.effect.state`,
    );
  if (operation.kind === "milestone")
    requireValue(
      effect.kind === "milestone" && effect.state === "active",
      "tracker-drift",
      `$.attempts.${operation.key}.effect.state`,
    );
  if (operation.kind === "closure") {
    const state = operation.proposal.intent === "close" ? "closed" : "opened";
    requireValue(
      effect.kind === "issue" && effect.state === state,
      "tracker-drift",
      `$.attempts.${operation.key}.effect.state`,
    );
  }
  if (item.phase === "mutation" && item.disposition === "succeeded") {
    requireValue(
      Date.parse(item.startedAt) <= Date.parse(effect.updatedAt),
      "invalid-time",
      `$.attempts.${operation.key}.effect.updatedAt`,
    );
  }
  if (item.before !== undefined && effect.kind === "issue") {
    requireValue(
      Date.parse(item.before.updatedAt) <= Date.parse(effect.updatedAt),
      "tracker-drift",
      `$.attempts.${operation.key}.effect.updatedAt`,
    );
    if (item.phase === "mutation" && item.disposition === "succeeded") {
      requireValue(
        !sameTrackerEffectIdentity(item.before, effect),
        "tracker-drift",
        `$.attempts.${operation.key}.effect`,
      );
    }
  }
}

function resolvedTargetKey(
  targetValue: RoadmapMutationTargetV2,
  completed: Map<string, RoadmapEffectIdentity>,
): string | undefined {
  if (targetValue.source === "project") return undefined;
  return targetValue.source === "ledger-observation"
    ? targetValue.targetKey
    : completed.get(targetValue.operationKey)?.targetKey;
}

function validateEffectIdentity(value: RoadmapEffectIdentity, path: string): void {
  effectIdentity(value, path);
}

function completedEffects(
  attempts: RoadmapMutationAttemptV2[],
): Map<string, RoadmapEffectIdentity> {
  const result = new Map<string, RoadmapEffectIdentity>();
  for (const item of attempts)
    if (item.disposition === "succeeded" || item.disposition === "reused")
      result.set(item.operationKey, item.effect!);
  return result;
}

function receiptProgress(
  attempts: RoadmapMutationAttemptV2[],
  authorizedKeys: string[],
): {
  lastConfirmedOperationKey?: string;
  remainingOperationKeys: string[];
  terminal: RoadmapMutationReceiptV2["terminal"];
} {
  const effects = completedEffects(attempts);
  const confirmed = attempts.filter(
    (item) =>
      item.disposition === "succeeded" ||
      item.disposition === "reused" ||
      item.disposition === "skipped",
  );
  const remainingOperationKeys = [...authorizedKeys]
    .filter(
      (key) =>
        !effects.has(key) &&
        !confirmed.some((item) => item.operationKey === key && item.disposition === "skipped"),
    )
    .sort(compareText);
  const lastConfirmedOperationKey = confirmed.at(-1)?.operationKey;
  const latest = attempts.at(-1)?.disposition;
  const terminal: RoadmapMutationReceiptV2["terminal"] =
    remainingOperationKeys.length === 0
      ? "complete"
      : latest === "ambiguous"
        ? "ambiguous"
        : confirmed.length > 0
          ? "partial"
          : "failed";
  return {
    ...(lastConfirmedOperationKey === undefined ? {} : { lastConfirmedOperationKey }),
    remainingOperationKeys,
    terminal,
  };
}

function validateMaterial(
  value: RoadmapMutationMaterialEvidenceV2,
  operation: RoadmapMutationOperationV2,
): void {
  const item = closed(value, "$.material", [
    "operationKey",
    "proposalDigest",
    "materialDigest",
    "materialBytes",
  ]);
  requireValue(
    identifier(item.operationKey, "$.material.operationKey") === operation.key,
    "operation-expansion",
    "$.material.operationKey",
  );
  requireValue(
    digest(item.proposalDigest, "$.material.proposalDigest") === operation.proposalDigest,
    "digest-mismatch",
    "$.material.proposalDigest",
  );
  requireValue(
    digest(item.materialDigest, "$.material.materialDigest") === operation.materialDigest,
    "digest-mismatch",
    "$.material.materialDigest",
  );
  requireValue(
    positiveInteger(item.materialBytes, "$.material.materialBytes") === operation.materialBytes,
    "digest-mismatch",
    "$.material.materialBytes",
  );
}

function expectedEffect(kind: RoadmapOperationKind): RoadmapEffectKind {
  if (kind === "comment") return "note";
  if (kind === "link") return "link";
  if (kind === "milestone") return "milestone";
  return "issue";
}

function expectedIntent(kind: RoadmapOperationKind, intent: RoadmapMutationIntentV2): boolean {
  if (kind === "saga" || kind === "issue" || kind === "milestone") return intent === "create";
  if (kind === "update") return intent === "update" || intent === "assign-milestone";
  if (kind === "comment") return intent === "comment";
  if (kind === "link") return intent === "link";
  if (kind === "label") return intent === "assign-label";
  return intent === "close" || intent === "reopen";
}

function validateTrackerObservations(
  expected: RoadmapTrackerObservation[],
  current: RoadmapTrackerObservation[],
  path: string,
): void {
  const decoded = array(current, path).map((value, index) =>
    trackerObservation(value, `${path}[${index}]`),
  );
  requireValue(
    new Set(decoded.map((item) => item.issueIid)).size === decoded.length,
    "duplicate-id",
    path,
  );
  const byIid = new Map(decoded.map((item) => [item.issueIid, item]));
  for (const item of expected) {
    const found = byIid.get(item.issueIid);
    requireValue(
      found?.state === item.state &&
        found.updatedAt === item.updatedAt &&
        found.identityDigest === item.identityDigest,
      "tracker-drift",
      `${path}.${item.issueIid}`,
    );
  }
}

function trackerObservation(value: unknown, path: string): RoadmapTrackerObservation {
  const item = closed(value, path, ["issueIid", "state", "updatedAt", "identityDigest"]);
  return {
    issueIid: positiveInteger(item.issueIid, `${path}.issueIid`),
    state: enumeration(item.state, ["opened", "closed"] as const, `${path}.state`),
    updatedAt: timestamp(item.updatedAt, `${path}.updatedAt`),
    identityDigest: digest(item.identityDigest, `${path}.identityDigest`),
  };
}

function trackerState(ledger: RoadmapLedger, iid: number): "opened" | "closed" {
  const observation = ledger.tracker.find((item) => item.issueIid === iid);
  requireValue(observation !== undefined, "unresolved-reference", `$.tracker.${iid}`);
  return observation.state;
}

function requireLedgerTarget(targetKey: string, ledger: RoadmapLedger, path: string): number {
  const iid = issueIid(targetKey);
  requireValue(
    iid !== undefined && ledger.tracker.some((item) => item.issueIid === iid),
    "tracker-drift",
    path,
  );
  return iid;
}

function assertAcyclic(operations: RoadmapMutationOperationV2[]): void {
  const byKey = new Map(operations.map((item) => [item.key, item]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (key: string): void => {
    if (visiting.has(key)) throw new RoadmapContractError("dependency-cycle", "$.operations");
    if (visited.has(key)) return;
    visiting.add(key);
    for (const dependency of byKey.get(key)!.dependsOnOperationKeys) visit(dependency);
    visiting.delete(key);
    visited.add(key);
  };
  for (const key of byKey.keys()) visit(key);
}

function effectIdentityKey(value: RoadmapEffectIdentity): string {
  return `${value.kind}:${value.targetKey}`;
}

function sameEffectIdentity(left: RoadmapEffectIdentity, right: RoadmapEffectIdentity): boolean {
  return roadmapDigest({ effect: left }) === roadmapDigest({ effect: right });
}

function sameTrackerEffectIdentity(
  left: RoadmapEffectIdentity,
  right: RoadmapEffectIdentity,
): boolean {
  const { operationProofDigest: _leftProof, ...leftIdentity } = left;
  const { operationProofDigest: _rightProof, ...rightIdentity } = right;
  return roadmapDigest({ effect: leftIdentity }) === roadmapDigest({ effect: rightIdentity });
}

function freeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as JsonObject)) freeze(child);
  return Object.freeze(value);
}
