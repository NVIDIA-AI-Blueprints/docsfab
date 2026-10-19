// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { canonicalJson } from "../../content-ir/canonical.js";
import type { AnswerRecordLedger, AnswerRecordPlan } from "../answer-records.js";
import { validateGeneratedQualitySubshape } from "../../evaluation-report/quality-schema-validation.js";
import type { EvaluationSchemaRejectionCode } from "../../evaluation-report/quality-validation-rejection.js";
import type {
  QualityAnswerRecordAdmissionInputV1,
  QualityAnswerRecordOutputCode,
  QualityAnswerRecordReceiptV1,
  QualityAnswerRecordValidationCandidateV1,
  QualityAnswerRecordValidationOutcomeV1,
} from "../quality-answer-record-admission.js";
import type { canonicalAdmissionHostFailureReason } from "../quality-answer-record-admission.js";

interface RecordNarrowingViolation {
  readonly location: string;
  readonly guidance: string;
  readonly kind?: "target-path";
}

type FailClosed = (
  code: QualityAnswerRecordOutputCode,
  location: string,
  type: string | null,
  key: string | null,
  feedbackOverride?: string,
) => QualityAnswerRecordReceiptV1;

type FailKit = (code: ReturnType<typeof canonicalAdmissionHostFailureReason>) => never;

export interface CandidateAssessment {
  readonly receipt: QualityAnswerRecordReceiptV1;
  readonly persistable: boolean;
  readonly requiresValidation: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateGeneratedShape(
  value: NonNullable<QualityAnswerRecordValidationCandidateV1["record"]>,
  schema: Readonly<Record<string, unknown>>,
  failKit: FailKit,
):
  | { readonly status: "valid" }
  | {
      readonly status: "invalid";
      readonly code: EvaluationSchemaRejectionCode;
      readonly location: string;
    } {
  const result = validateGeneratedQualitySubshape(value, schema);
  if (result.status === "unsupported-schema") return failKit("unsupported-generated-schema");
  if (result.status === "invalid") {
    const suffix = result.mismatch.location === "$" ? "" : result.mismatch.location.slice(1);
    return {
      status: "invalid",
      code: `evaluation-schema-${result.mismatch.keyword}` as EvaluationSchemaRejectionCode,
      location: `$.record${suffix}`,
    };
  }
  return { status: "valid" };
}

function generatedAllowedPropertiesAtLocation(
  schema: Readonly<Record<string, unknown>>,
  location: string,
): readonly string[] | undefined {
  if (!location.startsWith("$.record")) return undefined;
  let remainder = location.slice("$.record".length);
  let node: unknown = schema;
  while (remainder.length > 0) {
    if (remainder.startsWith("[]")) {
      if (!isRecord(node) || !isRecord(node.items)) return undefined;
      node = node.items;
      remainder = remainder.slice(2);
      continue;
    }
    const member = /^\.([^.[\]]+)/u.exec(remainder);
    if (!member || !isRecord(node) || !isRecord(node.properties)) return undefined;
    if (!Object.hasOwn(node.properties, member[1]!)) return undefined;
    node = node.properties[member[1]!];
    remainder = remainder.slice(member[0].length);
  }
  if (!isRecord(node) || node.additionalProperties !== false || !isRecord(node.properties))
    return undefined;
  return Object.keys(node.properties);
}

function hasOutOfTargetDocumentationPath(
  value: Readonly<Record<string, unknown>>,
  allowedPaths: readonly string[],
): boolean {
  const evidence = value.documentation_family_evidence;
  return (
    Array.isArray(evidence) &&
    evidence.some(
      (entry) =>
        isRecord(entry) &&
        Array.isArray(entry.paths) &&
        entry.paths.some((path) => !allowedPaths.includes(String(path))),
    )
  );
}

function inspectRecordNarrowing(
  input: QualityAnswerRecordAdmissionInputV1,
  candidate: QualityAnswerRecordValidationCandidateV1,
): RecordNarrowingViolation | undefined {
  const value = candidate.record;
  if (!isRecord(value)) {
    const declaration = input.plan.types.get(candidate.type)?.declaration;
    return value === null &&
      ((declaration?.nullable === true && !declaration.open) ||
        (declaration?.open === true && candidate.key !== null))
      ? undefined
      : {
          location: "$.record",
          guidance:
            "Send a complete JSON object for this record, or null only when the plan permits it.",
        };
  }
  const narrowing = input.recordNarrowing;
  if (candidate.type === "dimension") {
    if (
      value.assessment === "not-applicable" &&
      narrowing.requiredDimensionIds.includes(candidate.key ?? "")
    ) {
      return {
        location: "$.record.assessment",
        guidance:
          'Required dimensions cannot use assessment "not-applicable". If evidence is insufficient, use "not-assessed", describe the evidence gap in the existing rationale, and include only real evidence references in evidence (use an empty array when there are none).',
      };
    }
    if (
      typeof value.confidence === "number" &&
      (!narrowing.confidenceAnchors.includes(value.confidence) || value.confidence >= 1)
    ) {
      return {
        location: "$.record.confidence",
        guidance: `Use one of the host-provided confidence anchors below 1: ${canonicalJson(narrowing.confidenceAnchors.filter((anchor) => anchor < 1))}.`,
      };
    }
    if (
      Array.isArray(value.hard_gate_failures) &&
      value.hard_gate_failures.some(
        (gate) => typeof gate !== "string" || !narrowing.hardGateIds.includes(gate),
      )
    ) {
      return {
        location: "$.record.hard_gate_failures",
        guidance:
          narrowing.hardGateIds.length > 0
            ? `Use only host-provided hard-gate IDs: ${canonicalJson(narrowing.hardGateIds)}.`
            : "No hard-gate IDs are allowed for this selection; omit unsupported IDs or provide an empty array.",
      };
    }
  }
  if (
    candidate.type === "layer-note" &&
    value.layer_shortfall_decision !== undefined &&
    !narrowing.d3ResidualDecisions.includes(String(value.layer_shortfall_decision))
  ) {
    return {
      location: "$.record.layer_shortfall_decision",
      guidance: `Use only host-provided D3 residual decisions: ${canonicalJson(narrowing.d3ResidualDecisions)}.`,
    };
  }
  if (
    candidate.type === "target-judgment" &&
    hasOutOfTargetDocumentationPath(value, narrowing.qualityEvaluationTargetPaths)
  ) {
    return {
      location: "$.record.documentation_family_evidence",
      kind: "target-path",
      guidance: "Use only host-provided target paths in documentation-family evidence.",
    };
  }
  if (candidate.type === "finding") {
    const dimensionKeys = input.plan.types.get("dimension")?.keys.map((entry) => entry.key) ?? [];
    const constraintKeys = input.plan.types.get("constraint")?.keys.map((entry) => entry.key) ?? [];
    const allowedDimensionIds = [...dimensionKeys, ...constraintKeys];
    if (
      typeof value.dimension_id === "string" &&
      !allowedDimensionIds.includes(value.dimension_id)
    ) {
      return {
        location: "$.record.dimension_id",
        guidance: `Use a dimension or constraint ID from the host-resolved answer-record plan: ${canonicalJson(allowedDimensionIds)}.`,
      };
    }
    const allowedIds = new Set(
      ["technical-fact", "technical-issue", "review-issue"].flatMap(
        (namespace) => input.referenceIds[namespace] ?? [],
      ),
    );
    if (
      Array.isArray(value.originating_ids) &&
      value.originating_ids.some((id) => typeof id !== "string" || !allowedIds.has(id))
    ) {
      const allowedOriginIds = [...allowedIds].sort();
      return {
        location: "$.record.originating_ids",
        guidance:
          allowedOriginIds.length > 0
            ? `Use only host-provided source IDs for originating_ids: ${canonicalJson(allowedOriginIds)}.`
            : "No source IDs are available for this finding; omit originating_ids rather than inventing a value.",
      };
    }
  }
  return undefined;
}

export function shapeFor(
  plan: AnswerRecordPlan,
  candidate: QualityAnswerRecordValidationCandidateV1,
): Readonly<Record<string, unknown>> | undefined {
  const type = plan.types.get(candidate.type);
  if (!type) return undefined;
  const plannedKey = type.keys.find((entry) => entry.key === candidate.key);
  const shape = type.keys.length === 0 ? 0 : plannedKey?.shape;
  if (shape === undefined) return undefined;
  const declaration = type.declaration.shapes[shape];
  if (!declaration) return undefined;
  const ownedMembers = declaration.conditional
    .filter(({ when }) => {
      if ("selector" in when) {
        return plan.selectors[when.selector]?.includes(plannedKey?.slot ?? "") ?? false;
      }
      return when.key === candidate.key;
    })
    .map(({ member }) => member);
  if (ownedMembers.length === 0) return declaration.shape;
  const properties = { ...(declaration.shape.properties as Record<string, unknown> | undefined) };
  const required = Array.isArray(declaration.shape.required)
    ? declaration.shape.required.filter(
        (member) => typeof member !== "string" || !ownedMembers.includes(member),
      )
    : declaration.shape.required;
  for (const member of ownedMembers) delete properties[member];
  return { ...declaration.shape, properties, required };
}

function isKnownWireKey(
  plan: AnswerRecordPlan,
  ledger: AnswerRecordLedger,
  typeName: string,
  key: string | null,
): boolean {
  const planned = plan.types.get(typeName);
  if (!planned) return false;
  if (key === null) return planned.declaration.key === "singleton" || planned.declaration.open;
  if (planned.keys.some((entry) => entry.key === key)) return true;
  if (!planned.declaration.open || planned.serialPrefix === null) return false;
  const serial = new RegExp(`^${planned.serialPrefix}-([1-9][0-9]*)$`, "u").exec(key);
  if (!serial) return false;
  const value = Number(serial[1]);
  return Number.isSafeInteger(value) && value <= (ledger.issued.get(typeName) ?? 0);
}

function completeReplacementFeedback(
  plan: AnswerRecordPlan,
  ledger: AnswerRecordLedger,
  candidate: QualityAnswerRecordValidationCandidateV1,
  shape: Readonly<Record<string, unknown>>,
  additionalPropertiesLocation?: string,
): string {
  const planned = plan.types.get(candidate.type);
  const required = Array.isArray(shape.required)
    ? shape.required.filter((member): member is string => typeof member === "string")
    : [];
  const keyGuidance =
    planned?.declaration.key === "singleton"
      ? "For this singleton, omit key or use key null."
      : isKnownWireKey(plan, ledger, candidate.type, candidate.key)
        ? `Use wire key ${canonicalJson(candidate.key)}.`
        : planned?.declaration.open
          ? "For a new open-set record, use key null; for an existing record, use a key previously returned by DocsFab."
          : "Use a key declared in the answer-record plan.";
  const additionalProperties = additionalPropertiesLocation
    ? generatedAllowedPropertiesAtLocation(shape, additionalPropertiesLocation)
    : undefined;
  return [
    "Submit a complete replacement record, not a partial field patch.",
    ...(additionalPropertiesLocation
      ? [
          `Remove undeclared properties from record at ${canonicalJson(additionalPropertiesLocation)}.`,
          ...(additionalProperties
            ? [`Allowed properties at this location: ${canonicalJson(additionalProperties)}.`]
            : []),
        ]
      : []),
    `Required top-level fields in record: ${canonicalJson(required)}.`,
    `For the wire envelope, use type ${canonicalJson(candidate.type)}; ${keyGuidance} Put the complete object in record.`,
  ].join(" ");
}

function targetPathReplacementFeedback(
  input: QualityAnswerRecordAdmissionInputV1,
  ledger: AnswerRecordLedger,
  candidate: QualityAnswerRecordValidationCandidateV1,
  shape: Readonly<Record<string, unknown>>,
): string {
  return `${completeReplacementFeedback(input.plan, ledger, candidate, shape)} Use only allowed evaluation target paths in documentation-family evidence: ${canonicalJson(input.recordNarrowing.qualityEvaluationTargetPaths)}.`;
}

function claimsReservedHostEvidence(candidate: QualityAnswerRecordValidationCandidateV1): boolean {
  if (candidate.type !== "finding" || !isRecord(candidate.record)) return false;
  const evidence = candidate.record.evidence;
  if (!Array.isArray(evidence)) return false;
  return evidence.some(
    (entry) =>
      isRecord(entry) &&
      (entry.provider_id === "docsfab-host-fact-render" ||
        entry.provider_id === "docsfab-host-issue-render" ||
        entry.provider_id === "docsfab-host-locator-carry"),
  );
}

export function assessCandidate(
  input: QualityAnswerRecordAdmissionInputV1,
  ledger: AnswerRecordLedger,
  candidate: QualityAnswerRecordValidationCandidateV1,
  failClosed: FailClosed,
  failKit: FailKit,
): CandidateAssessment {
  const shape = shapeFor(input.plan, candidate);
  const plannedType = input.plan.types.get(candidate.type)?.declaration;
  const generatedShape =
    candidate.record === null || !shape
      ? undefined
      : validateGeneratedShape(candidate.record, shape, failKit);
  const structurallyValid =
    shape !== undefined &&
    (candidate.record === null
      ? (plannedType?.nullable === true && !plannedType.open) ||
        (plannedType?.open === true && candidate.key !== null)
      : generatedShape?.status === "valid");
  const narrowingViolation = inspectRecordNarrowing(input, candidate);
  if (!structurallyValid || narrowingViolation !== undefined) {
    const feedback =
      generatedShape?.status === "invalid"
        ? completeReplacementFeedback(
            input.plan,
            ledger,
            candidate,
            shape!,
            generatedShape.code === "evaluation-schema-additional-properties"
              ? generatedShape.location
              : undefined,
          )
        : narrowingViolation?.kind === "target-path" &&
            candidate.type === "target-judgment" &&
            isRecord(candidate.record) &&
            hasOutOfTargetDocumentationPath(
              candidate.record,
              input.recordNarrowing.qualityEvaluationTargetPaths,
            )
          ? targetPathReplacementFeedback(input, ledger, candidate, shape!)
          : narrowingViolation && shape
            ? `${completeReplacementFeedback(input.plan, ledger, candidate, shape)} ${narrowingViolation.guidance}`
            : undefined;
    const receipt =
      generatedShape?.status === "valid" &&
      narrowingViolation?.kind === "target-path" &&
      candidate.type === "target-judgment" &&
      isRecord(candidate.record) &&
      hasOutOfTargetDocumentationPath(
        candidate.record,
        input.recordNarrowing.qualityEvaluationTargetPaths,
      )
        ? failClosed(
            "answer-record-target-path",
            "$.record",
            candidate.type,
            candidate.key,
            feedback,
          )
        : generatedShape?.status === "invalid"
          ? failClosed(
              generatedShape.code,
              generatedShape.location,
              candidate.type,
              candidate.key,
              feedback,
            )
          : narrowingViolation && shape
            ? failClosed(
                "answer-record-shape",
                narrowingViolation.location,
                candidate.type,
                candidate.key,
                feedback,
              )
            : failClosed(
                "answer-record-shape",
                "$.record",
                candidate.type,
                candidate.key,
                feedback,
              );
    return { receipt, persistable: false, requiresValidation: false };
  }
  if (claimsReservedHostEvidence(candidate)) {
    return {
      receipt: failClosed(
        "evaluation-profile-semantics",
        "$.record.evidence",
        candidate.type,
        candidate.key,
      ),
      persistable: false,
      requiresValidation: false,
    };
  }
  return {
    receipt: failClosed("answer-record-shape", "$.record", candidate.type, candidate.key),
    persistable: true,
    requiresValidation: !(candidate.record === null && plannedType?.open === true),
  };
}

export function validateStoredCandidate(
  input: QualityAnswerRecordAdmissionInputV1,
  candidate: QualityAnswerRecordValidationCandidateV1,
  failKit: FailKit,
): void {
  const shape = shapeFor(input.plan, candidate);
  const rowType = input.plan.types.get(candidate.type)?.declaration;
  const generatedShape =
    candidate.record === null || !shape
      ? undefined
      : validateGeneratedShape(candidate.record, shape, failKit);
  if (
    !shape ||
    (candidate.record === null
      ? !(
          (rowType?.nullable === true && !rowType.open) ||
          (rowType?.open === true && candidate.key !== null)
        )
      : generatedShape?.status !== "valid") ||
    inspectRecordNarrowing(input, candidate) !== undefined
  )
    failKit("stored-row-shape");
}

export function validatePreparedOutcomes(
  outcomes: readonly QualityAnswerRecordValidationOutcomeV1[],
  candidates: readonly QualityAnswerRecordValidationCandidateV1[],
  failKit: FailKit,
): ReadonlyMap<string, QualityAnswerRecordValidationOutcomeV1> {
  const outcomeById = new Map<string, QualityAnswerRecordValidationOutcomeV1>();
  for (const outcome of outcomes) {
    if (!outcome || (outcome.status !== "valid" && outcome.status !== "refused")) {
      failKit("validator-outcome-shape");
    }
    if (
      outcomeById.has(outcome.toolCallId) ||
      !candidates.some((candidate) => candidate.toolCallId === outcome.toolCallId)
    )
      failKit("validator-outcome-set");
    outcomeById.set(outcome.toolCallId, outcome);
  }
  if (outcomeById.size !== candidates.length) failKit("validator-outcome-incomplete");
  return outcomeById;
}
