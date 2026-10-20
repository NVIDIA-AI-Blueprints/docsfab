// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Evidence for adaptive live or delegated direct work. It is not a workflow
 * RunRecord and must not be decoded or persisted as one. A parent references a
 * child workflow result by identity rather than fabricating a second success.
 */
import { createContractKit, deepFreeze } from "../contract-kit/index.js";

export const INTERACTIVE_OPERATION_KIND = "docsfab-interactive-operation" as const;

export const INTERACTIVE_EFFECT_CERTAINTIES = [
  "did-not-start",
  "read-completed",
  "mutation-completed",
  "mutation-unknown",
  "cancelled",
  "failed-persistence",
] as const;
export type InteractiveEffectCertainty = (typeof INTERACTIVE_EFFECT_CERTAINTIES)[number];

export type InteractiveOperationErrorCode =
  | "invalid-shape"
  | "invalid-value"
  | "digest-mismatch"
  | "schema-mismatch"
  | "workflow-run-record-forbidden"
  | "failed-persistence";

export class InteractiveOperationError extends Error {
  public readonly code: InteractiveOperationErrorCode;

  public constructor(code: InteractiveOperationErrorCode) {
    super(`Interactive operation rejected (${code}).`);
    this.name = "InteractiveOperationError";
    this.code = code;
  }
}

function fail(code: InteractiveOperationErrorCode): never {
  throw new InteractiveOperationError(code);
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;

function scopedId(value: unknown): string {
  const result = kit.string(value);
  if (!SAFE_ID.test(result)) fail("invalid-value");
  return result;
}

const kit = createContractKit<InteractiveOperationErrorCode>({
  fail,
  inertMode: "strict",
  codes: {
    invalidShape: "invalid-shape",
    invalidValue: "invalid-value",
    digestMismatch: "digest-mismatch",
    credentialMaterial: "invalid-value",
    schemaMismatch: "schema-mismatch",
  },
});

export interface InteractiveChildWorkflowRefV1 {
  readonly runId: string;
  readonly workflow: string;
  readonly recordSha256: string;
}

export interface InteractiveOperationV1 {
  readonly schemaVersion: 1;
  readonly kind: typeof INTERACTIVE_OPERATION_KIND;
  readonly operationId: string;
  readonly taskId: string;
  readonly grantFingerprintSha256: string;
  readonly scopeFingerprintSha256: string;
  readonly observationMode: "workflow-export" | "selected-checkout";
  readonly effectCertainty: InteractiveEffectCertainty;
  readonly childWorkflow: InteractiveChildWorkflowRefV1 | null;
  readonly budgetSettlementSha256: string | null;
  readonly operationSha256: string;
}

const BODY_KEYS = [
  "operationId",
  "taskId",
  "grantFingerprintSha256",
  "scopeFingerprintSha256",
  "observationMode",
  "effectCertainty",
  "childWorkflow",
  "budgetSettlementSha256",
] as const;

function decodeChildWorkflow(value: unknown): InteractiveChildWorkflowRefV1 | null {
  if (value === null) return null;
  const record = kit.object(value);
  kit.exact(record, ["runId", "workflow", "recordSha256"]);
  return deepFreeze({
    runId: scopedId(record.runId),
    workflow: scopedId(record.workflow),
    recordSha256: kit.hash(record.recordSha256),
  });
}

function refuseWorkflowRunRecord(value: unknown): void {
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion === 2 &&
    typeof record.workflow === "string" &&
    Array.isArray(record.steps)
  ) {
    fail("workflow-run-record-forbidden");
  }
}

function sealOperation(body: {
  operationId: string;
  taskId: string;
  grantFingerprintSha256: string;
  scopeFingerprintSha256: string;
  observationMode: InteractiveOperationV1["observationMode"];
  effectCertainty: InteractiveEffectCertainty;
  childWorkflow: InteractiveChildWorkflowRefV1 | null;
  budgetSettlementSha256: string | null;
}): InteractiveOperationV1 {
  return kit.seal(INTERACTIVE_OPERATION_KIND, "operationSha256", body);
}

export function createInteractiveOperation(input: {
  readonly operationId: string;
  readonly taskId: string;
  readonly grantFingerprintSha256: string;
  readonly scopeFingerprintSha256: string;
  readonly observationMode: InteractiveOperationV1["observationMode"];
  readonly effectCertainty?: InteractiveEffectCertainty;
  readonly childWorkflow?: InteractiveChildWorkflowRefV1 | null;
  readonly budgetSettlementSha256?: string | null;
}): InteractiveOperationV1 {
  refuseWorkflowRunRecord(input);
  return sealOperation({
    operationId: scopedId(input.operationId),
    taskId: scopedId(input.taskId),
    grantFingerprintSha256: kit.hash(input.grantFingerprintSha256),
    scopeFingerprintSha256: kit.hash(input.scopeFingerprintSha256),
    observationMode: kit.enumeration(input.observationMode, [
      "workflow-export",
      "selected-checkout",
    ] as const),
    effectCertainty: kit.enumeration(
      input.effectCertainty ?? "did-not-start",
      INTERACTIVE_EFFECT_CERTAINTIES,
    ),
    childWorkflow: decodeChildWorkflow(input.childWorkflow ?? null),
    budgetSettlementSha256: kit.nullableHash(input.budgetSettlementSha256 ?? null),
  });
}

export function decodeInteractiveOperation(value: unknown): InteractiveOperationV1 {
  refuseWorkflowRunRecord(value);
  return kit.decodeSealed(
    value,
    INTERACTIVE_OPERATION_KIND,
    "operationSha256",
    [...BODY_KEYS],
    (root) => ({
      operationId: scopedId(root.operationId),
      taskId: scopedId(root.taskId),
      grantFingerprintSha256: kit.hash(root.grantFingerprintSha256),
      scopeFingerprintSha256: kit.hash(root.scopeFingerprintSha256),
      observationMode: kit.enumeration(root.observationMode, [
        "workflow-export",
        "selected-checkout",
      ] as const),
      effectCertainty: kit.enumeration(root.effectCertainty, INTERACTIVE_EFFECT_CERTAINTIES),
      childWorkflow: decodeChildWorkflow(root.childWorkflow),
      budgetSettlementSha256: kit.nullableHash(root.budgetSettlementSha256),
    }),
  );
}

export function referenceChildWorkflowResult(
  operation: InteractiveOperationV1,
  child: InteractiveChildWorkflowRefV1,
): InteractiveOperationV1 {
  const current = decodeInteractiveOperation(operation);
  return sealOperation({
    operationId: current.operationId,
    taskId: current.taskId,
    grantFingerprintSha256: current.grantFingerprintSha256,
    scopeFingerprintSha256: current.scopeFingerprintSha256,
    observationMode: current.observationMode,
    effectCertainty: current.effectCertainty,
    childWorkflow: decodeChildWorkflow(child),
    budgetSettlementSha256: current.budgetSettlementSha256,
  });
}

export async function persistInteractiveOperation(
  operation: InteractiveOperationV1,
  input: {
    readonly save: (value: InteractiveOperationV1) => Promise<void>;
    readonly nextCertainty: InteractiveEffectCertainty;
  },
): Promise<InteractiveOperationV1> {
  const current = decodeInteractiveOperation(operation);
  const nextCertainty = kit.enumeration(input.nextCertainty, INTERACTIVE_EFFECT_CERTAINTIES);
  const allowed =
    input.nextCertainty === current.effectCertainty ||
    current.effectCertainty === "did-not-start" ||
    (current.effectCertainty === "read-completed" &&
      ["mutation-completed", "mutation-unknown", "cancelled", "failed-persistence"].includes(
        input.nextCertainty,
      )) ||
    (input.nextCertainty === "failed-persistence" &&
      current.effectCertainty !== "mutation-completed" &&
      current.effectCertainty !== "mutation-unknown");
  if (!allowed) fail("invalid-value");
  const next = sealOperation({
    operationId: current.operationId,
    taskId: current.taskId,
    grantFingerprintSha256: current.grantFingerprintSha256,
    scopeFingerprintSha256: current.scopeFingerprintSha256,
    observationMode: current.observationMode,
    effectCertainty: nextCertainty,
    childWorkflow: current.childWorkflow,
    budgetSettlementSha256: current.budgetSettlementSha256,
  });
  try {
    await input.save(next);
  } catch {
    fail("failed-persistence");
  }
  return next;
}

export function interactiveOperationFabricatesWorkflowRunRecord(
  value: InteractiveOperationV1,
): false {
  decodeInteractiveOperation(value);
  return false;
}

export function projectInteractiveOperation(operation: InteractiveOperationV1): {
  readonly availability: "available";
  readonly operation: InteractiveOperationV1;
} {
  return deepFreeze({
    availability: "available" as const,
    operation: decodeInteractiveOperation(operation),
  });
}
