// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  decodeReviewLocatorObservationReference,
  isPreservationSourceObservationSeedV1,
  type RunRecord,
  type StepRunRecord,
} from "../../records/contracts.js";
import { validateArtifactUse, type ArtifactUse } from "../../artifacts/index.js";
import { sha256 } from "../../content-ir/canonical.js";
import {
  decodeContextPreflight,
  decodeInference,
  decodeModelEvidence,
  decodeSkillEvidence,
  decodeTools,
  decodeUsage,
} from "../../scorecard-record.js";
import { admittedInferenceReplays } from "../../records/inference-replay.js";
import { decodeInferenceProgressObservation } from "../../records/inference-progress.js";
import {
  decodeDocumentationGapLedger,
  validateDocumentationGapRecordProjection,
} from "../../search/gap-ledger.js";
import { getWorkflow } from "../../workflow-registry/catalog.js";
import { decodeSavedWorkflowSearchEvidence } from "../../search/historical-audit-search.js";
import { validateAdmittedDocumentationPlanBinding } from "../../workflow-execution/plan-binding.js";
import { isNavigationLabelList } from "../../workflow-execution/plan-companions.js";
import {
  CANONICAL_TECHNICAL_STEP_ID,
  PROVISIONAL_TECHNICAL_STEP_ID,
  REVISED_CANONICAL_TECHNICAL_STEP_ID,
  REVISED_PROVISIONAL_TECHNICAL_STEP_ID,
} from "../../workflow-execution/source-obligation.js";
import { validateSourceAuthorityProposalAdmissionV1 } from "../../workflow-execution/source-obligation-authority.js";
import { isVerifierDisagreement } from "../../records/verifier-disagreement.js";
import { isTransportRetryCategory } from "../../records/inference-retry-disposition.js";
import {
  TOOL_REFUSAL_RECORD_MAX_ROWS_LIMIT,
  mergeToolArgumentFiller,
  mergeToolRefusals,
} from "../../records/tool-refusals.js";
import { limitDefinition } from "../../config/limits.js";
import {
  EVALUATION_DIAGNOSTIC_CODES,
  readQualityValidationRejection,
} from "../../evaluation-report/quality-validation-rejection.js";
import { QUALITY_CHECK_REJECTION_CODES } from "../../evaluation-report/quality-check-rejections.js";
import { STAGED_QUALITY_SCHEMA_MISMATCH_KEYWORDS } from "../../evaluation-report/quality-schema-validation.js";
import { UNRETAINABLE_INFERENCE_REJECTIONS } from "../../config/inference-rejection-limits.js";
import { OUTPUT_RULES } from "../../contracts/model-output.generated.js";
import {
  SHA256,
  SAFE_ID,
  allowed,
  array,
  canonical,
  digest,
  exact,
  expect,
  integer,
  object,
  required,
  safeText,
  timestamp,
} from "./contract.js";
import {
  canonicalTools,
  sumAttemptUsage,
  sumToolValues,
  unique,
  zeroTools,
} from "./evidence-aggregate.js";

const STEP_KEYS = [
  "id",
  "inheritedFrom",
  "title",
  "kind",
  "operation",
  "skill",
  "mode",
  "status",
  "startedAt",
  "completedAt",
  "durationMs",
  "model",
  "skillEvidence",
  "usage",
  "tools",
  "inference",
  "preservationSourceObservationSeed",
  "inferenceProgress",
  "evaluateEvidence",
  "qualityValidationRejection",
  "contextPreflight",
  "searchEvidence",
  "searchParticipation",
  "answerRecordLedger",
  "answerRecordCheckpoint",
  "searchFindings",
  "negativeEvidence",
  "gapLedger",
  "artifacts",
  "planBinding",
  "technicalCorrectionEvidence",
  "provisionalRichCandidateEvidence",
  "verifierDisagreement",
  "reviewLocatorObservation",
  "originalSourceAuthority",
  "sourceProposalAdmissions",
  "authoringPhase",
  "authoringRevisionAccounting",
  "planDiagnostic",
  "navigationLabels",
  "summary",
  "error",
] as const;

const QUALITY_REJECTION_CODES = new Set<string>([
  ...EVALUATION_DIAGNOSTIC_CODES,
  ...QUALITY_CHECK_REJECTION_CODES,
  ...STAGED_QUALITY_SCHEMA_MISMATCH_KEYWORDS.map((keyword) => `evaluation-schema-${keyword}`),
  ...Object.values(UNRETAINABLE_INFERENCE_REJECTIONS).map((reason) => reason.code),
]);
const QUALITY_SYNTAX_DECLINE = OUTPUT_RULES["quality-envelope-json"];

export function decodeStep(
  value: unknown,
  workflowName: RunRecord["workflow"],
  definition: ReturnType<typeof getWorkflow>["steps"][number],
  contextPolicy: ReturnType<typeof getWorkflow>["contextPolicy"]["steps"][number],
  revision: string,
  runStart: string,
  runEnd: string,
  priorGapLedger: ReturnType<typeof decodeDocumentationGapLedger> | undefined,
  allowRevisedCanonicalCorrection: boolean,
): StepRunRecord {
  const item = object(value);
  allowed(item, STEP_KEYS);
  required(item, [
    "id",
    "title",
    "kind",
    "skill",
    "mode",
    "status",
    "startedAt",
    "completedAt",
    "durationMs",
    "contextPreflight",
    "summary",
  ]);
  const kind = definition.kind ?? "inference";
  expect(
    item.id === definition.id &&
      item.title === definition.title &&
      item.kind === kind &&
      item.operation === definition.operation &&
      item.skill === definition.skill &&
      item.mode === definition.mode &&
      item.status === "succeeded" &&
      item.error === undefined,
  );
  const startedAt = timestamp(item.startedAt);
  const completedAt = timestamp(item.completedAt);
  const durationMs = integer(item.durationMs);
  expect(
    Date.parse(startedAt) <= Date.parse(completedAt) &&
      (item.inheritedFrom !== undefined || Date.parse(runStart) <= Date.parse(startedAt)),
  );
  if (item.inheritedFrom === undefined) expect(Date.parse(completedAt) <= Date.parse(runEnd));
  expect(Date.parse(completedAt) - Date.parse(startedAt) === durationMs);
  const preservationSeed = item.preservationSourceObservationSeed;
  if (preservationSeed !== undefined) {
    expect(
      definition.id === "test-audience-understanding" &&
        isPreservationSourceObservationSeedV1(preservationSeed) &&
        preservationSeed.outcome === "succeeded",
    );
  }
  if (item.inferenceProgress !== undefined) {
    decodeInferenceProgressObservation(item.inferenceProgress);
  }
  if (item.inheritedFrom !== undefined) {
    const provenance = object(item.inheritedFrom);
    exact(provenance, ["sourceRunId", "sourceRunRecordSha256", "sourceStepId"]);
    expect(
      typeof provenance.sourceRunId === "string" &&
        SAFE_ID.test(provenance.sourceRunId) &&
        provenance.sourceStepId === definition.id &&
        typeof provenance.sourceRunRecordSha256 === "string" &&
        SHA256.test(provenance.sourceRunRecordSha256),
    );
    expect(item.answerRecordCheckpoint === undefined && item.answerRecordLedger === undefined);
  }
  if (item.qualityValidationRejection !== undefined) {
    const rejection = readQualityValidationRejection(item.qualityValidationRejection);
    expect(
      (workflowName === "create-documentation" ||
        workflowName === "update-documentation" ||
        workflowName === "review-documentation") &&
        definition.id === "evaluate-document-quality" &&
        definition.skill === "evaluate-document-quality" &&
        rejection !== null &&
        (QUALITY_REJECTION_CODES.has(rejection.code) ||
          // The runner can decline only the quality artifact after its final typed syntax refusal.
          (rejection.validator === "candidate-admission" &&
            rejection.code === QUALITY_SYNTAX_DECLINE.code &&
            (QUALITY_SYNTAX_DECLINE.locations as readonly string[]).includes(rejection.location))),
    );
  }
  if (item.answerRecordCheckpoint !== undefined) {
    expect(definition.id === "evaluate-document-quality");
    decodeAnswerRecordCheckpointPointer(item.answerRecordCheckpoint);
  }
  if (item.answerRecordLedger !== undefined) {
    expect(definition.id === "evaluate-document-quality");
    decodeAnswerRecordLedgerIndex(item.answerRecordLedger);
  }
  safeText(item.summary, 1_000_000);
  const context = decodeContextPreflight(item.contextPreflight);
  expect(
    context.status === "ready" ||
      context.status === "unnecessary" ||
      (context.status === "degraded" &&
        ((definition.mode === "read-only" && contextPolicy.allowReadOnlyDegraded) ||
          (definition.mode === "write" && context.packetDigest !== undefined))),
  );
  if (context.status === "ready" || context.status === "degraded") {
    expect(
      context.packetDigest !== undefined
        ? context.consultedNodeIds !== undefined && context.consultedNodeIds.length > 0
        : // A read-only step ran without a packet only when it names why:
          // the budget that no packet fit, or the cause that left it none.
          context.status === "degraded" &&
            definition.mode === "read-only" &&
            (context.limit !== undefined || context.cause !== undefined) &&
            context.consultedNodeIds === undefined,
    );
  }
  decodeArtifacts(item.artifacts, definition.id, revision);
  if (item.planBinding !== undefined) {
    validateAdmittedDocumentationPlanBinding(item.planBinding);
  }
  // Navigation labels sit only on the planner or a plan writer, closed-shape.
  if (item.navigationLabels !== undefined) {
    expect(
      (definition.skill === "plan-documentation" || definition.skill === "write-documentation") &&
        isNavigationLabelList(item.navigationLabels),
    );
  }
  if (item.planDiagnostic !== undefined) {
    const diagnostic = object(item.planDiagnostic);
    allowed(diagnostic, ["schemaVersion", "kind", "code", "responseSha256", "responseShape"]);
    expect(
      diagnostic.schemaVersion === 1 &&
        diagnostic.kind === "docsfab-documentation-plan-diagnostic" &&
        typeof diagnostic.code === "string" &&
        diagnostic.code.length > 0 &&
        diagnostic.code.length <= 120 &&
        /^[a-f0-9]{64}$/u.test(String(diagnostic.responseSha256)) &&
        ["json-object", "invalid-json", "json-value"].includes(String(diagnostic.responseShape)),
    );
  }
  if (item.technicalCorrectionEvidence !== undefined) {
    expect(
      (definition.id === "verify-technical-accuracy" &&
        definition.skill === "verify-technical-accuracy") ||
        (allowRevisedCanonicalCorrection &&
          definition.id === "verify-revised-technical-accuracy" &&
          definition.skill === "verify-technical-accuracy"),
    );
  }
  if (item.provisionalRichCandidateEvidence !== undefined) {
    expect(
      (definition.id === PROVISIONAL_TECHNICAL_STEP_ID ||
        (allowRevisedCanonicalCorrection &&
          definition.id === REVISED_PROVISIONAL_TECHNICAL_STEP_ID)) &&
        definition.skill === "verify-technical-accuracy" &&
        definition.mode === "read-only",
    );
  }
  // #1439: the verifier-disagreement field sits only beside the correction
  // evidence of a canonical technical step, and names that step's own
  // provisional pass. Present anywhere else, or malformed, it is refused.
  if (item.verifierDisagreement !== undefined) {
    const provisionalStepId =
      definition.id === CANONICAL_TECHNICAL_STEP_ID
        ? PROVISIONAL_TECHNICAL_STEP_ID
        : definition.id === REVISED_CANONICAL_TECHNICAL_STEP_ID
          ? REVISED_PROVISIONAL_TECHNICAL_STEP_ID
          : undefined;
    expect(
      provisionalStepId !== undefined &&
        item.technicalCorrectionEvidence !== undefined &&
        isVerifierDisagreement(item.verifierDisagreement, provisionalStepId),
    );
  }
  if (item.originalSourceAuthority !== undefined) {
    expect(
      definition.id === "derive-source-obligations" &&
        definition.skill === "verify-technical-accuracy",
    );
  }
  if (item.sourceProposalAdmissions !== undefined) {
    expect(
      workflowName === "create-documentation" &&
        definition.id === "derive-source-obligations" &&
        item.originalSourceAuthority !== undefined,
    );
    item.sourceProposalAdmissions = array(item.sourceProposalAdmissions).map(
      validateSourceAuthorityProposalAdmissionV1,
    );
  }
  let searchEvidence: StepRunRecord["searchEvidence"];
  if (item.searchEvidence !== undefined) {
    expect(definition.search !== undefined);
    searchEvidence = decodeSavedWorkflowSearchEvidence(item.searchEvidence, definition.search!, {
      sourcePath: ".",
      requestedRevision: revision,
      revision,
    });
  }
  if (searchEvidence === undefined) {
    expect(
      item.searchFindings === undefined &&
        item.negativeEvidence === undefined &&
        item.gapLedger === undefined,
    );
  } else {
    validateDocumentationGapRecordProjection({
      workflow: workflowName,
      stepId: definition.id,
      currentRevision: revision,
      searchEvidence,
      searchFindings: array(item.searchFindings) as unknown as NonNullable<
        StepRunRecord["searchFindings"]
      >,
      negativeEvidence: array(item.negativeEvidence) as unknown as NonNullable<
        StepRunRecord["negativeEvidence"]
      >,
      gapLedger: item.gapLedger as NonNullable<StepRunRecord["gapLedger"]>,
      ...(priorGapLedger ? { priorLedgers: [priorGapLedger] } : {}),
    });
  }

  if (kind === "host-operation") {
    expect(item.model === undefined && item.inference === undefined);
    expect(item.evaluateEvidence === undefined);
    if (item.skillEvidence !== undefined) {
      expect(decodeSkillEvidence(item.skillEvidence).id === definition.skill);
    }
    if (item.usage !== undefined) {
      const usage = decodeUsage(item.usage);
      expect(
        usage.input === 0 &&
          usage.output === 0 &&
          usage.cacheRead === 0 &&
          usage.cacheWrite === 0 &&
          usage.total === 0 &&
          usage.turns === 0 &&
          (usage.cost === undefined || usage.cost === 0),
      );
    }
    if (item.tools !== undefined) {
      const tools = decodeTools(item.tools);
      expect(tools.presented === undefined || tools.presented.length === 0);
      expect(canonicalTools(tools) === canonicalTools(zeroTools()));
    }
    return item as unknown as StepRunRecord;
  }

  required(item, ["model", "skillEvidence", "usage", "tools", "inference"]);
  const model = decodeModelEvidence(item.model);
  const skill = decodeSkillEvidence(item.skillEvidence);
  expect(skill.id === definition.skill);
  const usage = decodeUsage(item.usage);
  const tools = decodeTools(item.tools);
  // The create revision writer may also record its host-reset replay.
  const admittedReplays = admittedInferenceReplays(definition);
  const recordedReplay = (item.inference as { replay?: unknown } | null)?.replay;
  const inference = decodeInference(
    item.inference,
    admittedReplays.find((replay) => replay === recordedReplay) ?? admittedReplays[0]!,
  );
  expect(
    (
      (item.sourceProposalAdmissions ?? []) as NonNullable<
        StepRunRecord["sourceProposalAdmissions"]
      >
    ).every((receipt) => {
      const attempt = inference.attempts.find((row) => row.attempt === receipt.attempt);
      return (
        attempt !== undefined &&
        !isTransportRetryCategory(attempt.outcome) &&
        (attempt.outcome === "succeeded" || attempt.outcome === "malformed-response")
      );
    }),
  );
  expect(inference.attempts.at(-1)?.outcome === "succeeded");
  if (item.reviewLocatorObservation !== undefined) {
    const reference = decodeReviewLocatorObservationReference(item.reviewLocatorObservation);
    expect(
      workflowName === "review-documentation" &&
        definition.id === "verify-technical-accuracy" &&
        definition.skill === "verify-technical-accuracy" &&
        definition.mode === "read-only" &&
        reference.attempt === inference.attempts.at(-1)?.attempt &&
        reference.summarySha256 === sha256(item.summary as string),
    );
  }
  expect(inference.attempts.every((attempt) => canonical(attempt.model) === canonical(model)));
  expect(canonical(usage) === canonical(sumAttemptUsage(inference.attempts)));
  expect(inference.attempts.every((attempt) => attempt.tools !== undefined));
  expect(
    canonicalTools(tools) ===
      canonicalTools(sumToolValues(inference.attempts.map((attempt) => attempt.tools!))),
  );
  // A step's history citations are its attempts' entries, in attempt order.
  expect(
    canonical(tools.historyReads ?? []) ===
      canonical(inference.attempts.flatMap((attempt) => attempt.tools!.historyReads ?? [])),
  );
  // A step's refusal rows are its attempts' rows, merged under the same bound.
  expect(
    canonical(tools.toolRefusals ?? null) ===
      canonical(
        mergeToolRefusals(
          inference.attempts.flatMap((attempt) =>
            attempt.tools!.toolRefusals ? [attempt.tools!.toolRefusals] : [],
          ),
          limitDefinition(TOOL_REFUSAL_RECORD_MAX_ROWS_LIMIT).max,
        ) ?? null,
      ),
  );
  // And its filler rows are its attempts' rows, summed.
  expect(
    canonical(tools.toolArgumentFiller ?? null) ===
      canonical(
        mergeToolArgumentFiller(
          inference.attempts.map((attempt) => attempt.tools!.toolArgumentFiller ?? []),
        ) ?? null,
      ),
  );
  expect(
    inference.attempts.every(
      (attempt) =>
        attempt.identity?.repositoryRevision === revision &&
        attempt.identity.contextPacketDigest === context.packetDigest &&
        canonical(attempt.identity.consultedNodeIds) === canonical(context.consultedNodeIds),
    ),
  );
  expect(
    inference.attempts.reduce(
      (sum, attempt) => sum + attempt.durationMs + (attempt.backoffMs ?? 0),
      0,
    ) <= durationMs,
  );
  if (kind === "evaluate") {
    expect(definition.mode === "read-only");
    decodeEvaluateEvidence(item.evaluateEvidence);
  } else {
    expect(item.evaluateEvidence === undefined);
  }
  return item as unknown as StepRunRecord;
}

function decodeAnswerRecordCheckpointPointer(value: unknown): void {
  const pointer = object(value);
  exact(pointer, ["sha256", "sequence", "attempt"]);
  digest(pointer.sha256);
  expect(Number.isSafeInteger(pointer.sequence) && (pointer.sequence as number) > 0);
  expect(Number.isSafeInteger(pointer.attempt) && (pointer.attempt as number) > 0);
}

function decodeAnswerRecordLedgerIndex(value: unknown): void {
  const ledger = object(value);
  exact(ledger, [
    "schemaVersion",
    "kind",
    "contractId",
    "bindingsSha256",
    "rows",
    "checkpoint",
    "progress",
  ]);
  expect(ledger.schemaVersion === 1 && ledger.kind === "docsfab-answer-record-ledger-index");
  safeText(ledger.contractId, 256);
  digest(ledger.bindingsSha256);
  const rows = array(ledger.rows).map((value) => {
    const row = object(value);
    exact(row, ["type", "key", "recordSha256", "state", "attempt"]);
    safeText(row.type, 128);
    safeText(row.key, 512);
    digest(row.recordSha256);
    expect(row.state === "admitted" || row.state === "released");
    expect(Number.isSafeInteger(row.attempt) && (row.attempt as number) > 0);
    return `${String(row.type)}\0${String(row.key)}`;
  });
  expect(new Set(rows).size === rows.length);
  if (ledger.checkpoint !== undefined) decodeAnswerRecordCheckpointPointer(ledger.checkpoint);
  if (ledger.progress !== undefined) {
    const progress = object(ledger.progress);
    exact(progress, [
      "admittedRowCount",
      "releasedRowCount",
      "remainingKeyCount",
      "refusalEventCount",
      "complete",
      "checkpointSequence",
      "logicalRunId",
      "sourceRunId",
      "sourceAttemptHighWater",
    ]);
    for (const field of [
      "admittedRowCount",
      "releasedRowCount",
      "remainingKeyCount",
      "refusalEventCount",
      "checkpointSequence",
      "sourceAttemptHighWater",
    ]) {
      expect(Number.isSafeInteger(progress[field]) && (progress[field] as number) >= 0);
    }
    expect(typeof progress.complete === "boolean");
    safeText(progress.logicalRunId, 512);
    safeText(progress.sourceRunId, 512);
  }
}

function decodeEvaluateEvidence(value: unknown): void {
  const item = object(value);
  exact(item, [
    "schemaVersion",
    "kind",
    "evaluatorIdentitySha256",
    "toolPolicySha256",
    "acceptancePolicySha256",
  ]);
  expect(item.schemaVersion === 1);
  expect(item.kind === "docsfab-evaluate-step-evidence");
  digest(item.evaluatorIdentitySha256);
  digest(item.toolPolicySha256);
  digest(item.acceptancePolicySha256);
}

export function decodeArtifacts(
  value: unknown,
  stepId: string | undefined,
  revision: string,
): ArtifactUse[] {
  if (value === undefined) return [];
  const result = array(value).map(validateArtifactUse);
  expect(unique(result));
  expect(
    result.every(
      (use) =>
        use.reference.repositoryRevision === revision &&
        (stepId === undefined || use.stepId === stepId),
    ),
  );
  return result;
}
