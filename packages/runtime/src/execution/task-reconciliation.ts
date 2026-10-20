// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Internal read-only task reconciliation projection.
 *
 * Composes existing producer facts at recovery and result-change boundaries.
 * This module is not a store, ledger, scheduler, or public SDK. Model prose
 * cannot mint a grant, completed effect, inventory count, or check result.
 */
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { DelegatedTaskFulfillmentInputV1 } from "../delegated-task/fulfillment.js";
import { projectDelegatedTaskFulfillment } from "../delegated-task/fulfillment.js";
import type { DelegatedTaskResultV1 } from "../delegated-task/result-contract.js";
import {
  classifyLatest,
  type KnowledgeContinuationAttemptV1,
  type KnowledgeContinuationProcessInspector,
} from "../records/knowledge-continuation-store.js";
import {
  buildRepositoryDiscoveryInventory,
  type RepositoryDiscoveryInventoryV1,
  type RepositoryInventoryCoverageV1,
  type RepositoryInventoryFailureV1,
} from "../repository/inventory.js";
import { withRepositoryWorkspace } from "../repository/workspace/materialize.js";

const EXECUTION_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const RECORDS_DIRECTORY = resolve(EXECUTION_DIRECTORY, "../records");

export const TASK_RECONCILIATION_KIND = "docsfab-task-reconciliation-projection" as const;

export const TASK_RECONCILIATION_UNKNOWN_REASONS = [
  "task-budget-api-absent",
  "task-scope-api-absent",
  "interactive-operation-api-absent",
  "task-budget-api-unconsumed",
  "task-scope-api-unconsumed",
  "interactive-operation-api-unconsumed",
] as const;
export type TaskReconciliationUnknownReason = (typeof TASK_RECONCILIATION_UNKNOWN_REASONS)[number];

export const TASK_RECONCILIATION_ADMISSION_CODES = [
  "admitted",
  "refused-model-prose-fact",
  "refused-human-ask-when-inspect-available",
  "refused-complete-unmet-checks",
  "refused-replay-unknown-write",
  "refused-incompatible-dispatch",
  "refused-obligation-removal",
  "refused-secret-disclosure",
  "refused-unchanged-input-repetition",
  "expose-inspect-repair",
] as const;
export type TaskReconciliationAdmissionCode = (typeof TASK_RECONCILIATION_ADMISSION_CODES)[number];

export const TASK_RECONCILIATION_FIELD_AUTHORITIES = Object.freeze([
  {
    field: "originalRequest",
    producer: "packages/runtime/src/delegated-task/driver.ts",
    producerIssue: "#876",
    consumer: "packages/runtime/src/execution/task-reconciliation.ts",
    status: "released",
  },
  {
    field: "driverIdentity",
    producer: "packages/runtime/src/delegated-task/driver.ts",
    producerIssue: "#876",
    consumer: "packages/runtime/src/execution/task-reconciliation.ts",
    status: "released",
  },
  {
    field: "mandatoryObligations",
    producer: "packages/runtime/src/delegated-task/fulfillment.ts",
    producerIssue: "#879",
    consumer: "packages/runtime/src/execution/task-reconciliation.ts",
    status: "released",
  },
  {
    field: "unmetChecks",
    producer: "packages/runtime/src/delegated-task/fulfillment.ts",
    producerIssue: "#879",
    consumer: "packages/runtime/src/execution/task-reconciliation.ts",
    status: "released",
  },
  {
    field: "establishedOperations",
    producer: "packages/runtime/src/delegated-task/driver.ts",
    producerIssue: "#876",
    consumer: "packages/runtime/src/execution/task-reconciliation.ts",
    status: "released",
  },
  {
    field: "fulfillmentReferences",
    producer: "packages/runtime/src/delegated-task/fulfillment.ts",
    producerIssue: "#879",
    consumer: "packages/runtime/src/execution/task-reconciliation.ts",
    status: "released",
  },
  {
    field: "freshInventoryEvidence",
    producer: "packages/runtime/src/repository/inventory.ts",
    producerIssue: "admitted-inventory-tool",
    consumer: "packages/runtime/src/execution/task-reconciliation.ts",
    status: "released",
  },
  {
    field: "cancellation",
    producer: "packages/runtime/src/execution/cancellation.ts",
    producerIssue: "#780",
    consumer: "packages/runtime/src/execution/task-reconciliation.ts",
    status: "released",
  },
  {
    field: "authority",
    producer: "packages/runtime/src/delegated-task/authority-adapter.ts",
    producerIssue: "#877",
    consumer: "packages/runtime/src/execution/task-reconciliation.ts",
    status: "released",
  },
  {
    field: "effectState",
    producer: "packages/runtime/src/records/knowledge-continuation-store.ts",
    producerIssue: "#761",
    consumer: "packages/runtime/src/execution/task-reconciliation.ts",
    status: "released",
  },
  {
    field: "workspaceIdentity",
    producer: "packages/runtime/src/repository/workspace/materialize.ts",
    producerIssue: "#933",
    consumer: "packages/runtime/src/execution/task-reconciliation.ts",
    status: "released",
  },
  {
    field: "taskBudget",
    producer: "packages/runtime/src/execution/task-budget.ts",
    producerIssue: "#779",
    consumer: "packages/runtime/src/execution/task-reconciliation.ts",
    status: "released",
  },
  {
    field: "taskScope",
    producer: "packages/runtime/src/execution/task-scope.ts",
    producerIssue: "#779",
    consumer: "packages/runtime/src/execution/task-reconciliation.ts",
    status: "released",
  },
  {
    field: "interactiveOperation",
    producer: "packages/runtime/src/records/interactive-operation.ts",
    producerIssue: "#779",
    consumer: "packages/runtime/src/execution/task-reconciliation.ts",
    status: "released",
  },
] as const);

export type TaskReconciliationFieldAuthority =
  (typeof TASK_RECONCILIATION_FIELD_AUTHORITIES)[number];

export interface TaskReconciliationUnknownFactV1 {
  readonly availability: "unknown";
  readonly reason: TaskReconciliationUnknownReason;
}

export type TaskInventoryClaimSource = "model-prose" | "admitted-inventory";

export interface TaskInventoryClaimV1 {
  readonly source: TaskInventoryClaimSource;
  readonly pageCount: number;
  readonly pagePaths: readonly string[];
}

export interface AdmittedInventoryEvidenceV1 {
  readonly pagePaths: readonly string[];
  readonly repositoryRevision: string;
  readonly inventorySha256: string;
  readonly status: RepositoryDiscoveryInventoryV1["status"];
  readonly coverage: Readonly<
    Record<"structure" | "text" | "navigation" | "metadata", RepositoryInventoryCoverageV1>
  >;
  readonly failures: readonly RepositoryInventoryFailureV1[];
}

export type TaskWorkspaceObservationMode = "workflow-export" | "selected-checkout" | "unknown";

export type TaskEffectCertaintyV1 =
  | "did-not-start"
  | "read-completed"
  | "mutation-completed"
  | "mutation-unknown"
  | "another-active-owner"
  | "cancelled"
  | "access-denied"
  | "budget-exhausted";

export type TaskRecoveryActionKind =
  | "inspect-inventory"
  | "declare-inventory-from-prose"
  | "ask-human"
  | "dispatch-child-workflow"
  | "claim-complete"
  | "replay-write"
  | "remove-obligation"
  | "continue-incompatible";

export interface TaskRecoveryActionV1 {
  readonly kind: TaskRecoveryActionKind;
  readonly pageCount?: number;
  readonly obligationId?: string;
  readonly inputFingerprint?: string;
  readonly secretPayload?: string;
}

export interface TaskResultChangeFactsV1 {
  readonly cancelled?: boolean;
  readonly accessRevoked?: boolean;
  readonly anotherActiveOwner?: boolean;
  readonly budgetExhausted?: boolean;
  readonly effectState?: TaskEffectCertaintyV1;
  readonly inspectAvailable?: boolean;
  readonly unmetCheckIds?: readonly string[];
  readonly previousRecoveryFingerprint?: string;
  readonly signal?: AbortSignal;
}

export interface TaskReconciliationAdmissionV1 {
  readonly admitted: boolean;
  readonly code: TaskReconciliationAdmissionCode;
  readonly humanAskRequired: boolean;
  readonly nextSupportedAction?: "inspect-inventory" | "observe-recovery-required" | "stop";
}

export interface TaskReconciliationProjectionV1 {
  readonly kind: typeof TASK_RECONCILIATION_KIND;
  readonly originalRequest: {
    readonly outcome: string;
    readonly requestSha256?: string;
  };
  readonly mandatoryObligationIds: readonly string[];
  readonly establishedOperations: readonly {
    readonly id: string;
    readonly kind: string;
    readonly status: string;
  }[];
  readonly fulfillment: DelegatedTaskResultV1 | undefined;
  readonly unmetCheckIds: readonly string[];
  readonly inventory: {
    readonly staleClaim: TaskInventoryClaimV1 | undefined;
    readonly admitted: AdmittedInventoryEvidenceV1 | undefined;
    readonly invalidatedModelProseCounts: readonly number[];
    readonly retainedPagePaths: readonly string[];
    readonly pageCount: number | undefined;
    readonly recountStatus: RepositoryDiscoveryInventoryV1["status"] | undefined;
    readonly recountCoverage: AdmittedInventoryEvidenceV1["coverage"] | undefined;
    readonly recountFailures: readonly RepositoryInventoryFailureV1[];
  };
  readonly workspaceIdentity: {
    readonly revision: string;
    readonly observationMode: TaskWorkspaceObservationMode;
  };
  readonly dirtyOnlyPaths: readonly string[];
  readonly committedEvidencePaths: readonly string[];
  readonly selectedCheckoutBlocked: boolean;
  readonly humanAskRequired: boolean;
  readonly completion: "incomplete" | "complete" | "blocked";
  readonly appliedEvidenceIds: readonly string[];
  readonly budget: TaskReconciliationUnknownFactV1;
  readonly taskScope: TaskReconciliationUnknownFactV1;
  readonly interactiveOperation: TaskReconciliationUnknownFactV1;
}

export interface ProjectTaskReconciliationInputV1 {
  readonly originalRequest: {
    readonly outcome: string;
    readonly requestSha256?: string;
  };
  readonly fulfillment?: DelegatedTaskResultV1;
  readonly fulfillmentInput?: DelegatedTaskFulfillmentInputV1;
  readonly staleInventoryClaim?: TaskInventoryClaimV1;
  readonly admittedInventory?: AdmittedInventoryEvidenceV1;
  readonly establishedOperations?: readonly {
    readonly id: string;
    readonly kind: string;
    readonly status: string;
  }[];
  readonly workspaceIdentity: {
    readonly revision: string;
    readonly observationMode: TaskWorkspaceObservationMode;
  };
  readonly dirtyOnlyPaths?: readonly string[];
  readonly claimedCommittedPaths?: readonly string[];
  readonly appliedEvidenceIds?: readonly string[];
}

export class TaskReconciliationError extends Error {
  public constructor(public readonly code: TaskReconciliationAdmissionCode) {
    super(`Task reconciliation refused the proposed recovery (${code}).`);
    this.name = "TaskReconciliationError";
  }
}

export function releasedSupplierPresence(): {
  readonly taskBudget: boolean;
  readonly taskScope: boolean;
  readonly interactiveOperation: boolean;
} {
  return Object.freeze({
    taskBudget: existsSync(resolve(EXECUTION_DIRECTORY, "task-budget.ts")),
    taskScope: existsSync(resolve(EXECUTION_DIRECTORY, "task-scope.ts")),
    interactiveOperation: existsSync(resolve(RECORDS_DIRECTORY, "interactive-operation.ts")),
  });
}

export function projectUnknownTaskBudget(): TaskReconciliationUnknownFactV1 {
  return unknownFact("task-budget-api-absent", releasedSupplierPresence().taskBudget);
}

export function projectUnknownTaskScope(): TaskReconciliationUnknownFactV1 {
  return unknownFact("task-scope-api-absent", releasedSupplierPresence().taskScope);
}

export function projectUnknownInteractiveOperation(): TaskReconciliationUnknownFactV1 {
  return unknownFact(
    "interactive-operation-api-absent",
    releasedSupplierPresence().interactiveOperation,
  );
}

export function projectEffectCertainty(input: {
  readonly latest?: KnowledgeContinuationAttemptV1;
  readonly processes?: KnowledgeContinuationProcessInspector;
  readonly cancelled?: boolean;
  readonly accessRevoked?: boolean;
  readonly budgetExhausted?: boolean;
}): TaskEffectCertaintyV1 {
  if (input.cancelled) return "cancelled";
  if (input.accessRevoked) return "access-denied";
  if (input.budgetExhausted) return "budget-exhausted";
  if (input.latest && input.processes) {
    const classified = classifyLatest(input.latest, input.processes);
    if (classified === "busy") return "another-active-owner";
    if (classified === "already-completed") return "mutation-completed";
    if (classified === "recovery-required") return "mutation-unknown";
    if (classified === "retry" || classified === "abandon-pre-execution") return "did-not-start";
  }
  if (input.latest) return "mutation-unknown";
  return "did-not-start";
}

export function admitTaskRecoveryAction(
  facts: TaskResultChangeFactsV1,
  action: TaskRecoveryActionV1,
): TaskReconciliationAdmissionV1 {
  if (typeof action.secretPayload === "string" && action.secretPayload.length > 0) {
    return refusal("refused-secret-disclosure", "stop");
  }
  const cancelled = Boolean(facts.cancelled || facts.signal?.aborted);
  const incompatible =
    cancelled ||
    Boolean(facts.accessRevoked) ||
    Boolean(facts.anotherActiveOwner) ||
    Boolean(facts.budgetExhausted) ||
    facts.effectState === "cancelled" ||
    facts.effectState === "access-denied" ||
    facts.effectState === "another-active-owner" ||
    facts.effectState === "budget-exhausted" ||
    facts.effectState === "mutation-unknown";
  const observationBlocked =
    cancelled ||
    Boolean(facts.accessRevoked) ||
    Boolean(facts.anotherActiveOwner) ||
    Boolean(facts.budgetExhausted) ||
    facts.effectState === "cancelled" ||
    facts.effectState === "access-denied" ||
    facts.effectState === "another-active-owner" ||
    facts.effectState === "budget-exhausted";
  const inspectAvailable = facts.inspectAvailable !== false;
  if (
    facts.previousRecoveryFingerprint !== undefined &&
    action.inputFingerprint !== undefined &&
    facts.previousRecoveryFingerprint === action.inputFingerprint &&
    action.kind !== "inspect-inventory"
  ) {
    return refusal("refused-unchanged-input-repetition", "stop");
  }
  switch (action.kind) {
    case "inspect-inventory":
      if (observationBlocked) return refusal("refused-incompatible-dispatch", "stop");
      return admitted();
    case "declare-inventory-from-prose":
      return refusal("refused-model-prose-fact", inspectAvailable ? "inspect-inventory" : "stop");
    case "ask-human":
      if (inspectAvailable) {
        return refusal("refused-human-ask-when-inspect-available", "inspect-inventory");
      }
      return refusal("refused-incompatible-dispatch", "stop");
    case "dispatch-child-workflow":
    case "continue-incompatible":
      if (incompatible) return refusal("refused-incompatible-dispatch", "stop");
      return admitted();
    case "claim-complete":
      if ((facts.unmetCheckIds ?? []).length > 0) {
        return refusal("refused-complete-unmet-checks", "stop");
      }
      return refusal("refused-complete-unmet-checks", "stop");
    case "replay-write":
      if (facts.effectState === "mutation-unknown") {
        return refusal("refused-replay-unknown-write", "observe-recovery-required");
      }
      if (facts.effectState === "did-not-start" && !incompatible) {
        return Object.freeze({
          admitted: false,
          code: "expose-inspect-repair",
          humanAskRequired: false,
          nextSupportedAction: "inspect-inventory",
        });
      }
      return refusal("refused-incompatible-dispatch", "stop");
    case "remove-obligation":
      return refusal("refused-obligation-removal", "stop");
  }
}

export function assertTaskResultChangeAdmitted(
  facts: TaskResultChangeFactsV1,
  action: TaskRecoveryActionV1 = { kind: "dispatch-child-workflow" },
): void {
  const admission = admitTaskRecoveryAction(facts, action);
  if (!admission.admitted) throw new TaskReconciliationError(admission.code);
}

export function projectTaskReconciliation(
  input: ProjectTaskReconciliationInputV1,
): TaskReconciliationProjectionV1 {
  const fulfillment =
    input.fulfillment ??
    (input.fulfillmentInput ? projectDelegatedTaskFulfillment(input.fulfillmentInput) : undefined);
  const mandatoryObligationIds = Object.freeze(
    fulfillment?.requirements.map((requirement) => requirement.id) ?? [],
  );
  const unmetCheckIds = Object.freeze(
    fulfillment
      ? fulfillment.requirements
          .filter((requirement) => requirement.kind === "check" && requirement.status !== "met")
          .map((requirement) => requirement.id)
      : [],
  );
  const establishedOperations = Object.freeze(
    (input.establishedOperations ??
      fulfillment?.children.map((child) => ({
        id: child.childId,
        kind: "child-workflow",
        status: child.status,
      })) ??
      []) as TaskReconciliationProjectionV1["establishedOperations"],
  );
  const staleClaim =
    input.staleInventoryClaim?.source === "model-prose" ? input.staleInventoryClaim : undefined;
  const admitted = matchingInventory(input.admittedInventory, input.workspaceIdentity.revision);
  const recountStatus = input.admittedInventory?.status;
  const recountCoverage = input.admittedInventory?.coverage;
  const recountFailures = Object.freeze([...(input.admittedInventory?.failures ?? [])]);
  const recountIncomplete = input.admittedInventory !== undefined && admitted === undefined;
  const retainedPagePaths = Object.freeze(
    admitted
      ? admitted.pagePaths.filter((path) => !(staleClaim?.pagePaths.includes(path) ?? false))
      : [],
  );
  const invalidatedModelProseCounts = Object.freeze(
    staleClaim && admitted && staleClaim.pageCount !== admitted.pagePaths.length
      ? [staleClaim.pageCount]
      : [],
  );
  const dirtyOnlyPaths = Object.freeze([...(input.dirtyOnlyPaths ?? [])]);
  const claimed = input.claimedCommittedPaths ?? [];
  const committedEvidencePaths = Object.freeze(
    claimed.filter((path) => !dirtyOnlyPaths.includes(path)),
  );
  const selectedCheckoutBlocked =
    input.workspaceIdentity.observationMode === "selected-checkout" && dirtyOnlyPaths.length > 0;
  const humanAskRequired = fulfillment?.stopReason === "needs-input";
  const appliedEvidenceIds = Object.freeze(
    uniqueIds([
      ...(input.appliedEvidenceIds ?? []),
      ...(admitted ? [admitted.inventorySha256] : []),
    ]),
  );
  return Object.freeze({
    kind: TASK_RECONCILIATION_KIND,
    originalRequest: Object.freeze({ ...input.originalRequest }),
    mandatoryObligationIds,
    establishedOperations,
    fulfillment,
    unmetCheckIds,
    inventory: Object.freeze({
      staleClaim,
      admitted,
      invalidatedModelProseCounts,
      retainedPagePaths,
      pageCount: admitted?.pagePaths.length,
      recountStatus,
      recountCoverage,
      recountFailures,
    }),
    workspaceIdentity: Object.freeze({ ...input.workspaceIdentity }),
    dirtyOnlyPaths,
    committedEvidencePaths,
    selectedCheckoutBlocked,
    humanAskRequired,
    completion:
      fulfillment?.fulfillment === "complete" && unmetCheckIds.length === 0 && !recountIncomplete
        ? "complete"
        : selectedCheckoutBlocked
          ? "blocked"
          : "incomplete",
    appliedEvidenceIds,
    budget: projectUnknownTaskBudget(),
    taskScope: projectUnknownTaskScope(),
    interactiveOperation: projectUnknownInteractiveOperation(),
  });
}

export function applyAdmittedInventoryRecount(
  current: TaskReconciliationProjectionV1,
  inventory: AdmittedInventoryEvidenceV1,
): TaskReconciliationProjectionV1 {
  if (current.appliedEvidenceIds.includes(inventory.inventorySha256)) {
    return current;
  }
  return projectTaskReconciliation({
    originalRequest: current.originalRequest,
    fulfillment: current.fulfillment,
    staleInventoryClaim: current.inventory.staleClaim,
    admittedInventory: inventory,
    establishedOperations: current.establishedOperations,
    workspaceIdentity: current.workspaceIdentity,
    dirtyOnlyPaths: current.dirtyOnlyPaths,
    claimedCommittedPaths: current.committedEvidencePaths,
    appliedEvidenceIds: current.appliedEvidenceIds,
  });
}

export async function recountTaskInventoryThroughAdmittedTool(input: {
  readonly repositoryPath: string;
  readonly revision?: string;
}): Promise<AdmittedInventoryEvidenceV1> {
  const revision = input.revision ?? "HEAD";
  return withRepositoryWorkspace(input.repositoryPath, revision, async (workspace) => {
    const inventory = await buildRepositoryDiscoveryInventory({ workspace });
    return Object.freeze({
      pagePaths: Object.freeze(inventory.documents.map((document) => document.path)),
      repositoryRevision: inventory.repositoryRevision,
      inventorySha256: inventory.inventorySha256,
      status: inventory.status,
      coverage: Object.freeze({ ...inventory.coverage }),
      failures: Object.freeze(
        inventory.failures.map((failure) => ({ ...failure, affects: [...failure.affects] })),
      ),
    });
  });
}

function matchingInventory(
  inventory: AdmittedInventoryEvidenceV1 | undefined,
  revision: string,
): AdmittedInventoryEvidenceV1 | undefined {
  if (!inventory) return undefined;
  if (inventory.repositoryRevision !== revision) return undefined;
  if (inventory.status !== "complete" || inventory.failures.length > 0) return undefined;
  if (Object.values(inventory.coverage).some((coverage) => coverage.status !== "complete")) {
    return undefined;
  }
  return inventory;
}

const ABSENT_TO_UNCONSUMED = {
  "task-budget-api-absent": "task-budget-api-unconsumed",
  "task-scope-api-absent": "task-scope-api-unconsumed",
  "interactive-operation-api-absent": "interactive-operation-api-unconsumed",
} as const;

function unknownFact(
  reason: keyof typeof ABSENT_TO_UNCONSUMED,
  present: boolean,
): TaskReconciliationUnknownFactV1 {
  // A present producer file has no consumed typed API yet; claim absence only
  // when the file is actually missing.
  return Object.freeze({
    availability: "unknown",
    reason: present ? ABSENT_TO_UNCONSUMED[reason] : reason,
  });
}

function admitted(): TaskReconciliationAdmissionV1 {
  return Object.freeze({
    admitted: true,
    code: "admitted",
    humanAskRequired: false,
  });
}

function refusal(
  code: TaskReconciliationAdmissionCode,
  next: NonNullable<TaskReconciliationAdmissionV1["nextSupportedAction"]>,
): TaskReconciliationAdmissionV1 {
  return Object.freeze({
    admitted: false,
    code,
    humanAskRequired: false,
    nextSupportedAction: next,
  });
}

function uniqueIds(values: readonly string[]): string[] {
  return [...new Set(values)];
}
