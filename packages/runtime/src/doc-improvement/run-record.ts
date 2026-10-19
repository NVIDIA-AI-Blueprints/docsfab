// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  ModelEvidence,
  RunRecord,
  SkillEvidence,
  ToolActivitySummary,
} from "../records/contracts.js";
import { workflowSelectedPath } from "../workflow-contracts/contracts.js";
import { canonicalDigest } from "../content-ir/canonical.js";
import { parseJsonEvidence } from "../json-evidence.js";
import { evaluateStructure } from "../quality-evaluation/structural.js";
import { validModelEvidenceProjection } from "../model/profile-evidence.js";
import { authorizeSecurityScan } from "../security/scan-override.js";
import { resolveSecurityScanEffectiveDisposition } from "../security/scan-disposition.js";
import { decodeQualityPackEvidence, parseScorecardRunRecord } from "../scorecard-record.js";
import { decodeRetainedEvidenceBindings } from "../records/retained-evidence-bindings.js";
import { decodeCheckoutPersistenceOutcome } from "../records/checkout-persistence.js";
import {
  RunRecordCompositionError,
  verifyRunRecordComposition,
} from "../records/composition-execution.js";
import { decodeRunRecordReaderEvidenceRequest } from "../records/reader-evidence-request.js";
import { decodeRunChangeSources } from "../records/change-sources.js";
import { decodeReviewDeliverySnapshotReference } from "../records/review-delivery-snapshot-reference.js";
import { decodeRunChangeSourceRelease } from "../records/change-source-release.js";
import { defineRunRecordReader } from "../records/run-record-readers.js";
import {
  decodeDocumentationGapLedger,
  decodeDocumentationSearchFinding,
  documentationGapLedgerFromStepFindings,
  validateDocumentationGapRecordProjection,
} from "../search/gap-ledger.js";
import { getWorkflow } from "../workflow-registry/catalog.js";
import {
  decodeWorkflowOutcome,
  type WorkflowOutcomeDecodeOptionsV1,
} from "../workflow-contracts/outcome.js";
import { decodeWorkflowSearchEvidence } from "../workflow-contracts/search.js";
import { validateDocumentationPlanBinding } from "../workflow-execution/plan-binding.js";
import { decodeAdmittedVerificationSummary } from "../workflow-execution/review-response.js";
import {
  assertSourceObligationPhaseContract,
  hasInventoryBeforeWrite,
  validateSourceObligationLedger,
  validateTechnicalCorrectionEvidence,
  CANONICAL_TECHNICAL_STEP_ID,
  PROVISIONAL_TECHNICAL_STEP_ID,
} from "../workflow-execution/source-obligation.js";
import { isVerifierDisagreement } from "../records/verifier-disagreement.js";
import { isPlainRecord, compareText } from "../shared/primitives.js";
import { decodeTemplateAuditReport } from "../templates/audit.js";
import { decodeRunRecordRequestIntent } from "../request-intent/interpret-record.js";
import { fail } from "./evidence-error.js";
import { SAFE_ID, SHA256, identifier, sameStrings, timestamp } from "./primitives.js";
import type { RunEvidenceSummary } from "./run-record-types.js";

export function runSummary(
  value: unknown,
  recordSha256: string,
  workflow: "review-documentation" | "update-documentation",
  testedCommit: string,
  editorialDecodeOptions: WorkflowOutcomeDecodeOptionsV1 = {},
): RunEvidenceSummary {
  if (!isPlainRecord(value)) fail("invalid-run-record");
  const record = value as unknown as RunRecord;
  // Evaluator qualification requires a fresh complete run. Inherited prefix
  // provenance is suitable for continuation reporting, never for a fresh
  // qualification sample, even when the child reaches terminal success.
  if (record.answerRecordContinuation !== undefined) fail("invalid-run-record");
  validateAuthenticRunRecord(record, workflow, editorialDecodeOptions);
  if (
    record.schemaVersion !== 2 ||
    record.workflow !== workflow ||
    record.status !== "succeeded" ||
    record.repository?.revision !== testedCommit ||
    record.workspace?.strategy !== "tracked-export" ||
    record.workspace.disposable !== true ||
    !Array.isArray(record.steps) ||
    record.steps.length === 0 ||
    !record.steps.every((step) => step.status === "succeeded") ||
    !Array.isArray(record.skills) ||
    record.skills.length === 0 ||
    !Array.isArray(record.models) ||
    record.models.length === 0
  ) {
    fail("invalid-run-record");
  }
  if (
    workflow === "review-documentation" &&
    (record.steps.some((step) => step.mode !== "read-only") ||
      (record.changes?.files.length ?? 0) !== 0 ||
      record.changes?.patch !== undefined)
  ) {
    fail("analysis-not-read-only");
  }
  if (
    workflow === "update-documentation" &&
    (!record.steps.some((step) => step.mode === "write") || !record.changes?.patch)
  ) {
    fail("application-not-write");
  }
  const createdAt = timestamp(record.createdAt);
  const startedAt = timestamp(record.startedAt);
  const completedAt = timestamp(record.completedAt);
  if (createdAt > startedAt || startedAt > completedAt) fail("invalid-run-record");
  return {
    id: identifier(record.id),
    recordSha256,
    workflow,
    status: "succeeded",
    createdAt,
    startedAt,
    completedAt,
    skills: record.skills.map(skillSummary),
    models: record.models.map(modelSummary),
  };
}

const DOC_IMPROVEMENT_UNVERIFIED = "unverified" as const;

/** Field policy of the doc-improvement run-record reader. */
export const DOC_IMPROVEMENT_RUN_READER = defineRunRecordReader({
  reader: "doc-improvement",
  workflows: ["review-documentation", "update-documentation"],
  statuses: ["succeeded"],
  fields: {
    schemaVersion: "admitted",
    id: "admitted",
    workflow: "admitted",
    repository: "admitted",
    workspace: "admitted",
    instruction: "admitted",
    retryContext: DOC_IMPROVEMENT_UNVERIFIED,
    operatorTargetPaths: "admitted",
    instructionContext: DOC_IMPROVEMENT_UNVERIFIED,
    // Written by `update-documentation` runs that bound --source or --pr.
    retainedEvidenceBindings: "decoded",
    // Written by `update-documentation` runs given a comparison or sources.
    readerEvidenceRequest: "decoded",
    // Written by `update-documentation` runs that bound a change.
    changeSources: "decoded",
    reviewDeliverySnapshot: "decoded",
    changeSourceRelease: "decoded",
    task: "admitted",
    taskLineage: DOC_IMPROVEMENT_UNVERIFIED,
    compositionExecution: "decoded",
    answerRecordDiscovery: DOC_IMPROVEMENT_UNVERIFIED,
    compositionExecutionAggregate: "decoded",
    modelSettings: "admitted",
    knowledgeResumeReceipt: DOC_IMPROVEMENT_UNVERIFIED,
    knowledgeContinuationReceipt: DOC_IMPROVEMENT_UNVERIFIED,
    knowledgeContinuationRecoveryAuthorization: DOC_IMPROVEMENT_UNVERIFIED,
    knowledgeContinuationSnapshotSha256: DOC_IMPROVEMENT_UNVERIFIED,
    knowledgeContinuationAcceptanceSha256: DOC_IMPROVEMENT_UNVERIFIED,
    answerRecordContinuation: DOC_IMPROVEMENT_UNVERIFIED,
    status: "admitted",
    checkoutPersistence: "decoded",
    workflowOutcome: "decoded",
    workflowBranchCoverage: "admitted",
    authoringExecution: DOC_IMPROVEMENT_UNVERIFIED,
    releaseDocumentationReadiness: "producer-not-admitted",
    workUnitMachineContracts: "producer-not-admitted",
    error: "admitted",
    failure: "failed-run-only",
    workflowOutcomeRejection: "failed-run-only",
    authoringCandidateRejection: "failed-run-only",
    editorialFinalizationRejection: "failed-run-only",
    createdAt: "admitted",
    startedAt: "admitted",
    completedAt: "admitted",
    durationMs: "admitted",
    models: "admitted",
    skills: "admitted",
    qualityPack: "decoded",
    qualityProfileSelection: DOC_IMPROVEMENT_UNVERIFIED,
    qualityArtifactValidation: DOC_IMPROVEMENT_UNVERIFIED,
    usage: "admitted",
    tools: "admitted",
    artifacts: "admitted",
    searchFindings: "admitted",
    negativeEvidence: "admitted",
    gapLedger: "admitted",
    securityScan: "admitted",
    securityScanEffectiveDisposition: "admitted",
    securityScanAuthorization: "admitted",
    changes: "admitted",
    impactPostflight: "admitted",
    reviewScope: DOC_IMPROVEMENT_UNVERIFIED,
    requestIntent: "decoded",
    // Written only on a needs-input run, which this reader never admits.
    firstPassContradiction: DOC_IMPROVEMENT_UNVERIFIED,
    firstPassContradictionAdmission: DOC_IMPROVEMENT_UNVERIFIED,
    firstPassReplay: DOC_IMPROVEMENT_UNVERIFIED,
    firstPassChoices: DOC_IMPROVEMENT_UNVERIFIED,
    liveAgentTurn: "producer-not-admitted",
    liveAgentTurnFailure: "producer-not-admitted",
    // Optional per-run citation evidence (absent until a writer exists).
    sourceCitations: "admitted",
    // Content-free findings (#1807): locations and rule ids only.
    credentialFindings: "admitted",
    evidenceWarnings: "admitted",
    steps: "decoded",
  },
});

/** The closed key list `DOC_IMPROVEMENT_RUN_READER` derives. */
export const DOC_IMPROVEMENT_RUN_KEYS: ReadonlySet<string> = new Set(
  DOC_IMPROVEMENT_RUN_READER.admittedKeys,
);

function validateAuthenticRunRecord(
  record: RunRecord,
  workflow: "review-documentation" | "update-documentation",
  editorialDecodeOptions: WorkflowOutcomeDecodeOptionsV1,
): void {
  const runKeys = DOC_IMPROVEMENT_RUN_KEYS;
  const requiredRunKeys = [
    "schemaVersion",
    "id",
    "workflow",
    "repository",
    "workspace",
    "status",
    "createdAt",
    "startedAt",
    "completedAt",
    "durationMs",
    "models",
    "skills",
    "usage",
    "tools",
    "steps",
  ];
  if (
    !isPlainRecord(record) ||
    Object.keys(record).some((key) => !runKeys.has(key)) ||
    requiredRunKeys.some((key) => !(key in record))
  )
    fail("invalid-run-record");
  const definition = getWorkflow(workflow);
  try {
    if (record.checkoutPersistence !== undefined)
      decodeCheckoutPersistenceOutcome(record.checkoutPersistence);
    if (record.qualityPack !== undefined) decodeQualityPackEvidence(record.qualityPack);
    if (record.retainedEvidenceBindings !== undefined) {
      decodeRetainedEvidenceBindings(record.retainedEvidenceBindings, record.workflow);
    }
    if (record.readerEvidenceRequest !== undefined) {
      decodeRunRecordReaderEvidenceRequest(record.readerEvidenceRequest, record.workflow);
    }
    if (record.changeSources !== undefined) {
      decodeRunChangeSources(record.changeSources, record.workflow);
    }
    if (record.reviewDeliverySnapshot !== undefined) {
      decodeReviewDeliverySnapshotReference(record.reviewDeliverySnapshot, {
        runId: record.id,
        workflow: record.workflow,
        status: record.status,
        changeSources: record.changeSources,
      });
    }
    decodeRunChangeSourceRelease(record.changeSourceRelease, record.workflow, record.changeSources);
    if (record.requestIntent !== undefined) {
      decodeRunRecordRequestIntent(record.requestIntent, record.instruction);
    }
    verifyRunRecordComposition(record, definition);
  } catch (error) {
    // A composition binding refuses by its own name; anything else is the generic code.
    fail(error instanceof RunRecordCompositionError ? error.code : "invalid-run-record");
  }
  if (record.workflowOutcome !== undefined) {
    try {
      decodeWorkflowOutcome(record.workflowOutcome, record, editorialDecodeOptions);
    } catch {
      fail("invalid-run-record");
    }
  }
  const expectedSteps =
    definition.branching && record.workflowBranchCoverage?.selection
      ? workflowSelectedPath(definition, record.workflowBranchCoverage.selection.branchId).steps
      : definition.steps;
  if (!Array.isArray(record.steps) || record.steps.length !== expectedSteps.length) {
    fail("invalid-run-record");
  }
  const stepKeys = new Set([
    "id",
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
    "evaluateEvidence",
    "contextPreflight",
    "searchEvidence",
    "searchParticipation",
    "searchFindings",
    "negativeEvidence",
    "gapLedger",
    "artifacts",
    "planBinding",
    "technicalCorrectionEvidence",
    "verifierDisagreement",
    "originalSourceAuthority",
    "planDiagnostic",
    "summary",
    "error",
  ]);
  let priorGapLedger: ReturnType<typeof decodeDocumentationGapLedger> | undefined;
  for (const [index, step] of record.steps.entries()) {
    const expected = expectedSteps[index]!;
    const hostStep = expected.kind === "host-operation";
    if (
      Object.keys(step).some((key) => !stepKeys.has(key)) ||
      step.id !== expected.id ||
      step.title !== expected.title ||
      step.kind !== expected.kind ||
      step.skill !== expected.skill ||
      step.mode !== expected.mode ||
      step.status !== "succeeded" ||
      typeof step.summary !== "string" ||
      !step.summary.trim() ||
      !step.skillEvidence ||
      !step.usage ||
      (!hostStep && (!step.model || !step.tools || !step.inference)) ||
      (hostStep && (step.model !== undefined || !step.tools || step.inference !== undefined)) ||
      step.startedAt === undefined ||
      step.completedAt === undefined ||
      step.durationMs === undefined ||
      Date.parse(step.completedAt) - Date.parse(step.startedAt) !== step.durationMs
    ) {
      fail("invalid-run-record");
    }
    // #1439: the verifier-disagreement field sits only beside the correction
    // evidence of the canonical technical step, in a record that holds the
    // provisional pass it names, and has the closed shape naming that pass.
    // Anywhere else (another step, a canonical step without correction
    // evidence, a workflow without the provisional pass), or malformed, it is
    // refused. The correction evidence itself is validated with the
    // source-obligation contract below.
    if (
      step.verifierDisagreement !== undefined &&
      (step.id !== CANONICAL_TECHNICAL_STEP_ID ||
        step.technicalCorrectionEvidence === undefined ||
        !record.steps.some((candidate) => candidate.id === PROVISIONAL_TECHNICAL_STEP_ID) ||
        !isVerifierDisagreement(step.verifierDisagreement, PROVISIONAL_TECHNICAL_STEP_ID))
    ) {
      fail("invalid-run-record");
    }
    if (expected.kind === "evaluate") {
      if (
        !isPlainRecord(step.evaluateEvidence) ||
        step.evaluateEvidence.schemaVersion !== 1 ||
        step.evaluateEvidence.kind !== "docsfab-evaluate-step-evidence" ||
        !SHA256.test(step.evaluateEvidence.evaluatorIdentitySha256) ||
        !SHA256.test(step.evaluateEvidence.toolPolicySha256) ||
        !SHA256.test(step.evaluateEvidence.acceptancePolicySha256) ||
        expected.mode !== "read-only"
      ) {
        fail("invalid-run-record");
      }
    } else if (step.evaluateEvidence !== undefined) {
      fail("invalid-run-record");
    }
    if (step.contextPreflight?.status !== "ready") fail("invalid-run-record");
    if (
      !hostStep &&
      step.inference!.replay !== (step.mode === "write" ? "disabled-write-step" : "read-only")
    ) {
      fail("invalid-run-record");
    }
    if (hostStep) {
      if (
        step.tools!.totalCalls !== 0 ||
        step.tools!.failedCalls !== 0 ||
        step.tools!.byTool.length !== 0
      )
        fail("invalid-run-record");
      validateHostOperationSummary(step.summary);
    }
    if (step.searchEvidence === undefined) {
      if (
        step.searchFindings !== undefined ||
        step.negativeEvidence !== undefined ||
        step.gapLedger !== undefined
      ) {
        fail("invalid-run-record");
      }
    } else {
      if (
        !expected.search ||
        !Array.isArray(step.searchFindings) ||
        !Array.isArray(step.negativeEvidence) ||
        !step.gapLedger
      ) {
        fail("invalid-run-record");
      }
      try {
        const searchEvidence = decodeWorkflowSearchEvidence(
          step.searchEvidence,
          expected.search,
          record.repository,
        );
        validateDocumentationGapRecordProjection({
          workflow,
          stepId: expected.id,
          currentRevision: record.repository.revision,
          searchEvidence,
          searchFindings: step.searchFindings,
          negativeEvidence: step.negativeEvidence,
          gapLedger: step.gapLedger,
          ...(priorGapLedger ? { priorLedgers: [priorGapLedger] } : {}),
        });
        priorGapLedger = decodeDocumentationGapLedger(step.gapLedger);
      } catch {
        fail("invalid-run-record");
      }
    }
    if (!hostStep) {
      try {
        parseScorecardRunRecord(strictStepProjection(record, step, index));
      } catch {
        fail("invalid-run-record");
      }
    }
  }
  const authoritySteps = record.steps.filter((step) => step.originalSourceAuthority !== undefined);
  const correctionSteps = record.steps.filter(
    (step) => step.technicalCorrectionEvidence !== undefined,
  );
  const inventoryOnly = workflow === "update-documentation" && hasInventoryBeforeWrite(definition);
  if (inventoryOnly || authoritySteps.length > 0 || correctionSteps.length > 0) {
    try {
      if (!assertSourceObligationPhaseContract(definition) && !inventoryOnly) {
        fail("invalid-run-record");
      }
      const derive = record.steps.find((step) => step.id === "derive-source-obligations");
      if (inventoryOnly) {
        const planner = record.steps.find((step) => step.id === "plan-documentation");
        const derivePlan = derive?.planBinding;
        if (
          !derive?.summary ||
          !derive.searchEvidence ||
          !derivePlan ||
          authoritySteps.length !== 1 ||
          authoritySteps[0]?.id !== "derive-source-obligations" ||
          correctionSteps.length !== 0 ||
          !planner?.planBinding
        ) {
          fail("invalid-run-record");
        }
        const planBinding = validateDocumentationPlanBinding(derivePlan, {
          expectedMode: "update",
        });
        const plannerBinding = validateDocumentationPlanBinding(planner.planBinding, {
          expectedMode: "update",
        });
        if (planBinding.digest !== plannerBinding.digest) fail("invalid-run-record");
        const ledger = validateSourceObligationLedger(
          parseJsonEvidence(derive.summary),
          {
            workflow: definition,
            evidenceIdentity: { repositoryRevision: record.repository.revision },
            searchEvidence: derive.searchEvidence,
            planBinding,
          },
          derive.originalSourceAuthority,
        );
        if (ledger.schemaVersion !== 2) fail("invalid-run-record");
      } else {
        const canonicalTechnical = record.steps.find(
          (step) => step.id === "verify-technical-accuracy",
        );
        if (
          !derive?.summary ||
          !derive.searchEvidence ||
          !canonicalTechnical?.summary ||
          canonicalTechnical.technicalCorrectionEvidence === undefined ||
          authoritySteps.length > 1 ||
          (authoritySteps.length === 1 && authoritySteps[0]?.id !== "derive-source-obligations") ||
          correctionSteps.length !== 1 ||
          correctionSteps[0]?.id !== "verify-technical-accuracy"
        ) {
          fail("invalid-run-record");
        }
        const ledger = validateSourceObligationLedger(
          parseJsonEvidence(derive.summary),
          {
            workflow: definition,
            evidenceIdentity: { repositoryRevision: record.repository.revision },
            searchEvidence: derive.searchEvidence,
          },
          derive.originalSourceAuthority,
        );
        if ((ledger.schemaVersion === 2) !== (authoritySteps.length === 1)) {
          fail("invalid-run-record");
        }
        const verification = decodeAdmittedVerificationSummary(canonicalTechnical.summary);
        if (!verification) fail("invalid-run-record");
        validateTechnicalCorrectionEvidence(
          canonicalTechnical.technicalCorrectionEvidence,
          ledger,
          verification,
          derive.originalSourceAuthority,
        );
      }
    } catch {
      fail("invalid-run-record");
    }
  }
  if (workflow === "update-documentation") {
    const planner = record.steps.find(
      (step) => step.skill === "plan-documentation" && step.status === "succeeded",
    );
    const writer = record.steps.find(
      (step) => step.skill === "write-documentation" && step.status === "succeeded",
    );
    try {
      if (!planner?.planBinding || !writer?.planBinding) fail("invalid-run-record");
      const plannerBinding = validateDocumentationPlanBinding(planner.planBinding, {
        expectedMode: "update",
      });
      const writerBinding = validateDocumentationPlanBinding(writer.planBinding, {
        expectedMode: "update",
      });
      if (
        plannerBinding.digest !== writerBinding.digest ||
        plannerBinding.mode !== writerBinding.mode
      ) {
        fail("invalid-run-record");
      }
    } catch {
      fail("invalid-run-record");
    }
  }
  const rebuilt = documentationGapLedgerFromStepFindings({
    currentRevision: record.repository.revision,
    steps: record.steps,
  });
  if (!rebuilt) {
    if (
      record.searchFindings !== undefined ||
      record.negativeEvidence !== undefined ||
      record.gapLedger !== undefined
    ) {
      fail("invalid-run-record");
    }
  } else {
    if (
      !Array.isArray(record.searchFindings) ||
      !Array.isArray(record.negativeEvidence) ||
      !record.gapLedger
    ) {
      fail("invalid-run-record");
    }
    try {
      const searchFindings = record.searchFindings.map(decodeDocumentationSearchFinding);
      const negativeEvidence = record.negativeEvidence.map(decodeDocumentationSearchFinding);
      const gapLedger = decodeDocumentationGapLedger(record.gapLedger);
      if (
        canonicalDigest(searchFindings) !== canonicalDigest(rebuilt.searchFindings) ||
        canonicalDigest(negativeEvidence) !== canonicalDigest(rebuilt.negativeEvidence) ||
        canonicalDigest(gapLedger) !== canonicalDigest(rebuilt.gapLedger)
      ) {
        fail("invalid-run-record");
      }
    } catch {
      fail("invalid-run-record");
    }
  }
  if (
    !record.startedAt ||
    !record.completedAt ||
    record.durationMs === undefined ||
    Date.parse(record.completedAt) - Date.parse(record.startedAt) !== record.durationMs ||
    record.usage.total !==
      record.usage.input + record.usage.output + record.usage.cacheRead + record.usage.cacheWrite ||
    !validUsage(record.usage) ||
    !usageMatchesSteps(record) ||
    canonicalDigest(record.tools) !== canonicalDigest(sumStepTools(record)) ||
    !sameEvidenceSet(
      record.models,
      record.steps.flatMap((step) => (step.model ? [step.model] : [])),
    ) ||
    !sameEvidenceSet(
      record.skills,
      record.steps.flatMap((step) => (step.skillEvidence ? [step.skillEvidence] : [])),
    ) ||
    !hasAuthenticSecurityDisposition(record) ||
    record.error !== undefined ||
    (record.instruction !== undefined && typeof record.instruction !== "string") ||
    (workflow === "update-documentation" && record.instruction !== undefined) ||
    (workflow === "review-documentation" && record.task !== undefined)
  ) {
    fail("invalid-run-record");
  }
  validateRunChangeShape(record, workflow);
  const startedAt = Date.parse(record.startedAt);
  const completedAt = Date.parse(record.completedAt);
  for (const [index, step] of record.steps.entries()) {
    if (
      Date.parse(step.startedAt!) < startedAt ||
      Date.parse(step.completedAt!) > completedAt ||
      (index > 0 && Date.parse(step.startedAt!) < Date.parse(record.steps[index - 1]!.completedAt!))
    ) {
      fail("invalid-run-record");
    }
  }
  const structural = evaluateStructure(
    {
      version: 1,
      name: `doc-improvement-${workflow}`,
      assertions: [
        { type: "status", equals: "succeeded" },
        { type: "workflow", equals: workflow },
        { type: "all-steps-succeeded" },
        { type: "summaries-present" },
        { type: "governed-skill-evidence" },
        { type: "turn-governance-evidence" },
        { type: "governed-terminal-status" },
        { type: "step-skills", equals: expectedSteps.map((step) => step.skill) },
      ],
    },
    [record],
    () => editorialDecodeOptions,
  );
  if (!structural.passed) fail("invalid-run-record");
}

/**
 * A terminal campaign may use the exact, credential-rule-only override path,
 * but it must not trust a loose `status: "authorized"` assertion from an
 * imported run record. Reconstruct the original request from its content-free
 * evidence at the run's creation instant (the scan occurs after creation and
 * before `startedAt`) and require byte-for-byte-equivalent policy output.
 */
function hasAuthenticSecurityDisposition(record: RunRecord): boolean {
  const report = record.securityScan;
  const effective = record.securityScanEffectiveDisposition;
  if (!report || !effective) return false;
  // New runs record an advisory disposition; the whole-repository scan carries
  // no campaign authority and never records override authorization. Legacy
  // authority-bearing dispositions keep their exact reconstruction contract
  // below.
  if (effective.status === "advisory") {
    return record.securityScanAuthorization === undefined;
  }
  if (record.securityScanAuthorization === undefined) {
    return (
      canonicalDigest(resolveSecurityScanEffectiveDisposition(report)) ===
      canonicalDigest(effective)
    );
  }
  const authorization = record.securityScanAuthorization;
  if (report.status !== "blocked" || !authorization || effective.status !== "authorized")
    return false;
  try {
    const reconstructed = authorizeSecurityScan(
      report,
      authorization.overrides.map((override) => ({
        ruleId: override.ruleId,
        revision: override.revision,
        reason: override.reason,
        expiresAt: override.expiresAt,
      })),
      record.repository.revision,
      new Date(record.createdAt),
    );
    return (
      canonicalDigest(reconstructed) === canonicalDigest(authorization) &&
      canonicalDigest(resolveSecurityScanEffectiveDisposition(report, reconstructed)) ===
        canonicalDigest(effective)
    );
  } catch {
    return false;
  }
}

function validateRunChangeShape(
  record: RunRecord,
  workflow: "review-documentation" | "update-documentation",
): void {
  if (workflow === "review-documentation") {
    if (record.changes !== undefined || record.impactPostflight !== undefined) {
      fail("invalid-run-record");
    }
    return;
  }
  if (
    !isPlainRecord(record.changes) ||
    Object.keys(record.changes).sort(compareText).join(",") !== "files,patch" ||
    !Array.isArray(record.changes.files) ||
    record.changes.files.length === 0 ||
    !isPlainRecord(record.changes.patch) ||
    Object.keys(record.changes.patch).sort(compareText).join(",") !==
      "artifactPath,byteLength,format,lineCount,sha256"
  ) {
    fail("invalid-run-record");
  }
  for (const entry of record.changes.files) {
    if (
      !isPlainRecord(entry) ||
      Object.keys(entry).some((key) => !["path", "status", "previousPath"].includes(key)) ||
      !["added", "modified", "deleted", "renamed", "copied", "untracked", "unknown"].includes(
        entry.status,
      ) ||
      typeof entry.path !== "string" ||
      (entry.previousPath !== undefined && typeof entry.previousPath !== "string")
    ) {
      fail("invalid-run-record");
    }
  }
  if (
    !isPlainRecord(record.impactPostflight) ||
    record.impactPostflight.status !== "completed" ||
    Object.keys(record.impactPostflight).sort(compareText).join(",") !==
      "analysisDigest,changedPaths,schemaVersion,status" ||
    record.impactPostflight.schemaVersion !== 1 ||
    !SHA256.test(record.impactPostflight.analysisDigest) ||
    !Array.isArray(record.impactPostflight.changedPaths)
  ) {
    fail("invalid-run-record");
  }
}

function strictStepProjection(
  record: RunRecord,
  step: RunRecord["steps"][number],
  index: number,
): RunRecord {
  const projectedStep = structuredClone(step);
  delete projectedStep.searchEvidence;
  delete projectedStep.searchParticipation;
  delete projectedStep.searchFindings;
  delete projectedStep.negativeEvidence;
  delete projectedStep.gapLedger;
  delete projectedStep.evaluateEvidence;
  delete projectedStep.planBinding;
  delete projectedStep.artifacts;
  delete projectedStep.technicalCorrectionEvidence;
  delete projectedStep.verifierDisagreement;
  delete projectedStep.originalSourceAuthority;
  return {
    schemaVersion: 2,
    id: `doc-improvement-strict-${index + 1}`,
    workflow: "readiness",
    repository: { ...record.repository },
    workspace: { ...record.workspace },
    status: "succeeded",
    createdAt: step.startedAt!,
    startedAt: step.startedAt!,
    completedAt: step.completedAt!,
    durationMs: step.durationMs!,
    models: [structuredClone(step.model!)],
    skills: [structuredClone(step.skillEvidence!)],
    usage: { ...step.usage! },
    tools: structuredClone(step.tools!),
    ...(record.securityScan ? { securityScan: structuredClone(record.securityScan) } : {}),
    ...(record.securityScanEffectiveDisposition
      ? { securityScanEffectiveDisposition: { ...record.securityScanEffectiveDisposition } }
      : {}),
    ...(record.securityScanAuthorization
      ? { securityScanAuthorization: structuredClone(record.securityScanAuthorization) }
      : {}),
    ...(record.evidenceWarnings ? { evidenceWarnings: [...record.evidenceWarnings] } : {}),
    steps: [
      {
        ...projectedStep,
        id: "assess-readiness",
        title: "Assess repository readiness",
        kind: "inference",
        skill: "doc-context-analyzer",
        mode: "read-only",
        inference: { ...structuredClone(step.inference!), replay: "read-only" },
      },
    ],
  };
}

function validateHostOperationSummary(summary: string): void {
  let value: unknown;
  try {
    value = JSON.parse(summary);
  } catch {
    fail("invalid-run-record");
  }
  if (!isPlainRecord(value)) fail("invalid-run-record");
  const root = value as Record<string, unknown>;
  if (
    Object.keys(root).some(
      (key) =>
        ![
          "status",
          "coverage",
          "checks",
          "snapshotSha256",
          "requiredChecks",
          "templateConformance",
        ].includes(key),
    ) ||
    !["passed", "failed", "unavailable"].includes(root.status as string) ||
    typeof root.coverage !== "string" ||
    !Array.isArray(root.checks)
  )
    fail("invalid-run-record");
  const hasSnapshot = root.snapshotSha256 !== undefined;
  const hasRequiredChecks = root.requiredChecks !== undefined;
  if (hasSnapshot !== hasRequiredChecks) fail("invalid-run-record");
  // Optional: older records carry no advisory template report.
  if (root.templateConformance !== undefined) {
    try {
      decodeTemplateAuditReport(root.templateConformance);
    } catch {
      fail("invalid-run-record");
    }
  }
  if (hasSnapshot) {
    if (typeof root.snapshotSha256 !== "string" || !SHA256.test(root.snapshotSha256)) {
      fail("invalid-run-record");
    }
    if (!Array.isArray(root.requiredChecks)) fail("invalid-run-record");
    for (const check of root.requiredChecks) {
      if (!isPlainRecord(check)) fail("invalid-run-record");
      const declared = check as Record<string, unknown>;
      if (
        Object.keys(declared).some(
          (key) => !["command", "directory", "instruction"].includes(key),
        ) ||
        typeof declared.command !== "string" ||
        typeof declared.directory !== "string" ||
        typeof declared.instruction !== "string"
      ) {
        fail("invalid-run-record");
      }
    }
  }
  for (const check of root.checks) {
    if (!isPlainRecord(check)) fail("invalid-run-record");
    const entry = check as Record<string, unknown>;
    if (
      Object.keys(entry).some(
        (key) =>
          ![
            "command",
            "directory",
            "status",
            "reason",
            "exitCode",
            "output",
            "durationMs",
            "required",
            "instruction",
          ].includes(key),
      ) ||
      typeof entry.status !== "string" ||
      !["passed", "failed", "unavailable"].includes(entry.status) ||
      ((entry.status === "passed" || entry.status === "failed") &&
        (typeof entry.command !== "string" || typeof entry.directory !== "string")) ||
      (entry.command !== undefined && typeof entry.command !== "string") ||
      (entry.directory !== undefined && typeof entry.directory !== "string") ||
      (entry.required !== undefined && typeof entry.required !== "boolean") ||
      (entry.instruction !== undefined && typeof entry.instruction !== "string")
    )
      fail("invalid-run-record");
  }
}

function sameEvidenceSet(left: unknown[], right: unknown[]): boolean {
  const normalized = (values: unknown[]) =>
    [...new Set(values.map(canonicalDigest))].sort(compareText);
  const actual = normalized(left);
  const expected = normalized(right);
  return sameStrings(actual, expected);
}

function sumStepTools(record: RunRecord): ToolActivitySummary {
  const byName = new Map<string, { name: string; calls: number; failures: number }>();
  let totalCalls = 0;
  let failedCalls = 0;
  let preExecutionRejections = 0;
  const failureCategories = new Map<string, number>();
  let failureCategoriesPresent = false;
  for (const step of record.steps) {
    const tools = step.tools!;
    totalCalls += tools.totalCalls;
    failedCalls += tools.failedCalls;
    preExecutionRejections += tools.preExecutionRejections?.count ?? 0;
    for (const entry of tools.byTool) {
      const current = byName.get(entry.name) ?? { name: entry.name, calls: 0, failures: 0 };
      current.calls += entry.calls;
      current.failures += entry.failures;
      byName.set(entry.name, current);
    }
    if (tools.failureCategories !== undefined) failureCategoriesPresent = true;
    for (const entry of tools.failureCategories ?? []) {
      failureCategories.set(
        entry.category,
        (failureCategories.get(entry.category) ?? 0) + entry.count,
      );
    }
  }
  return {
    totalCalls,
    failedCalls,
    ...(preExecutionRejections > 0
      ? {
          preExecutionRejections: {
            schemaVersion: 1,
            kind: "tool-pre-execution-rejections",
            count: preExecutionRejections,
          } as const,
        }
      : {}),
    byTool: [...byName.values()].sort((left, right) => compareText(left.name, right.name)),
    ...(failureCategoriesPresent
      ? {
          failureCategories: [...failureCategories.entries()]
            .sort(([left], [right]) => compareText(left, right))
            .map(([category, count]) => ({
              category: category as NonNullable<
                ToolActivitySummary["failureCategories"]
              >[number]["category"],
              count,
            })),
        }
      : {}),
  };
}

function validUsage(value: RunRecord["usage"]): boolean {
  return (["input", "output", "cacheRead", "cacheWrite", "total", "turns"] as const).every(
    (key) => Number.isSafeInteger(value[key]) && value[key] >= 0,
  );
}

function usageMatchesSteps(record: RunRecord): boolean {
  const totals = record.steps.reduce(
    (sum, step) => ({
      input: sum.input + (step.usage?.input ?? 0),
      output: sum.output + (step.usage?.output ?? 0),
      cacheRead: sum.cacheRead + (step.usage?.cacheRead ?? 0),
      cacheWrite: sum.cacheWrite + (step.usage?.cacheWrite ?? 0),
      total: sum.total + (step.usage?.total ?? 0),
      turns: sum.turns + (step.usage?.turns ?? 0),
    }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0 },
  );
  return (["input", "output", "cacheRead", "cacheWrite", "total", "turns"] as const).every(
    (key) => record.usage[key] === totals[key],
  );
}

function skillSummary(value: SkillEvidence): RunEvidenceSummary["skills"][number] {
  if (
    !isPlainRecord(value) ||
    !SAFE_ID.test(value.id) ||
    !SHA256.test(value.contentSha256) ||
    (value.bundleSha256 !== undefined && !SHA256.test(value.bundleSha256))
  ) {
    fail("invalid-skill-evidence");
  }
  return {
    id: value.id,
    contentSha256: value.contentSha256,
    ...(value.bundleSha256 ? { bundleSha256: value.bundleSha256 } : {}),
  };
}

function modelSummary(value: ModelEvidence): RunEvidenceSummary["models"][number] {
  if (!validModelEvidenceProjection(value) || !value.profile) fail("invalid-model-evidence");
  return {
    provider: value.provider,
    model: value.model,
    profileStatus: value.profile.status,
    profileSha256: value.profile.sha256,
  };
}
