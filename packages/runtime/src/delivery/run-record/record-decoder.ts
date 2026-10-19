// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import type { ChangedFileEvidence } from "../../impact/contracts.js";
import type {
  AnswerRecordContinuationReceiptV1,
  RunRecord,
  StepRunRecord,
} from "../../records/contracts.js";
import { decodeCheckoutPersistenceOutcome } from "../../records/checkout-persistence.js";
import { decodeSavedRunRecord } from "../../records/saved-run-record.js";
import { isCliRunRetryContextV1 } from "../../records/retry-context.js";
import { type ArtifactUse } from "../../artifacts/index.js";
import { parseJsonEvidence, type JsonEvidenceValue } from "../../json-evidence.js";
import {
  decodeModelEvidence,
  decodeQualityPackEvidence,
  decodeSecurityAuthorization,
  decodeSecurityDisposition,
  decodeSecurityScan,
  decodeSkillEvidence,
  decodeTools,
  decodeUsage,
} from "../../scorecard-record.js";
import {
  CREDENTIAL_LIKE_CONTENT,
  credentialFindingLocationReadBound,
  credentialFindingPresentationLocationReadBound,
  sortCredentialFindings,
} from "../../security/credential-findings.js";
import { authorizeSecurityScan } from "../../security/scan-override.js";
import { decodeKnowledgeResumeReceipt } from "../../canon/from-knowledge-snapshot.js";
import {
  decodeKnowledgeContinuationReceipt,
  knowledgeContinuationAcceptanceSha256,
  matchesKnowledgeContinuationTargetConflictScope,
} from "../../records/knowledge-continuation.js";
import { resolveSecurityScanEffectiveDisposition } from "../../security/scan-disposition.js";
import {
  decodeDocumentationGapLedger,
  decodeDocumentationSearchFinding,
  documentationGapLedgerFromStepFindings,
} from "../../search/gap-ledger.js";
import { getWorkflow, isWorkflowName } from "../../workflow-registry/catalog.js";
import {
  isWorkflowManifestV3,
  isWorkflowManifestV2,
  workflowSelectedPath,
  type WorkflowDefinition,
  type WorkflowTaskInput,
} from "../../workflow-contracts/contracts.js";
import { authoringSelectedPath } from "../../workflow-contracts/authoring-schedule.js";
import {
  normalizeWorkflowTaskInput,
  WorkflowTaskValidationError,
} from "../../workflow-contracts/task.js";
import {
  assertTaskLineageProjection,
  decodeTaskLineageRecoveryAuthorization,
} from "../../lineage/contracts.js";
import {
  documentationPlanPagePaths,
  documentationPlanModeForWorkflow,
  validateAdmittedDocumentationPlanBinding,
} from "../../workflow-execution/plan-binding.js";
import { decodeAdmittedVerificationSummary } from "../../workflow-execution/review-response.js";
import {
  assertSourceObligationPhaseContract,
  assertSourceObligationSourceAuthority,
  hasInventoryBeforeWrite,
  sourceObligationScopeSha256,
  validateSourceObligationLedger,
  validateTechnicalCorrectionEvidence,
  validateProvisionalRichCandidateEvidence,
  validateTechnicalRichCandidateBinding,
  type SourceObligationLedger,
} from "../../workflow-execution/source-obligation.js";
import { validateOriginalSourceAuthorityEvidence } from "../../workflow-execution/source-obligation-authority.js";
import {
  decodeAuthoringExecutionEvidenceV1,
  validateAuthoringRunRecordV1,
} from "../../records/authoring-execution.js";
import { decodeWorkflowOutcome } from "../../workflow-contracts/outcome.js";
import {
  createCompositionExecutionAggregate,
  isSelfConsistentAnswerRecordContinuation,
  parseCompositionExecutionAggregate,
  parseCompositionExecutionEvidence,
  reconstructCompositionExecutionAggregateSnapshot,
  verifyRunRecordComposition,
  type CompositionExecutionWorkflowIdentity,
} from "../../records/composition-execution.js";
import { decodeSourceRunCitations } from "../../records/source-citations.js";
import { decodeRetainedEvidenceBindings } from "../../records/retained-evidence-bindings.js";
import { decodeOperatorTargetPaths } from "../../records/operator-target-paths.js";
import { decodeRunRecordInstructionContext } from "../../records/instruction-context.js";
import { decodeRunRecordReaderEvidenceRequest } from "../../records/reader-evidence-request.js";
import { decodeRunChangeSources } from "../../records/change-sources.js";
import { decodeReviewDeliverySnapshotReference } from "../../records/review-delivery-snapshot-reference.js";
import { decodeRunChangeSourceRelease } from "../../records/change-source-release.js";
import {
  decodeRunRecordRequestIntent,
  REQUEST_INTENT_CONTINUING_OUTCOMES,
} from "../../request-intent/interpret-record.js";
import { assertAnswerRecordDiscoveryRunBindingV1 } from "../../records/answer-record-discovery.js";
import { decodeQualityProfileSelectionReceipt } from "../../evaluation-report/quality-profile-selection.js";
import { projectQualityReportFromRun } from "../../evaluation-report/contracts.js";
import {
  SHA256,
  REVISION,
  INVALID_SHAPE,
  NO_DOCUMENT_CHANGE,
  PublicationRunRecordDecodeError,
  allowed,
  array,
  canonical,
  digest,
  exact,
  expect,
  identifier,
  integer,
  object,
  repositoryPath,
  required,
  safeText,
  timestamp,
} from "./contract.js";
import { canonicalTools, sumTools, sumUsage, unique, uniqueValues } from "./evidence-aggregate.js";
import { decodeArtifacts, decodeStep } from "./step-decoder.js";
import {
  assertRunRecordEditorialDeliveryEligible,
  type PublicationRunRecordDecodeOptionsV1,
} from "./eligibility.js";

export const TOP_KEYS = [
  "schemaVersion",
  "id",
  "workflow",
  "repository",
  "workspace",
  "instruction",
  "retryContext",
  "operatorTargetPaths",
  // Live-agent context beside the verbatim instruction; validated below against
  // the writer's own contract.
  "instructionContext",
  // A create or update run's --source and --pr pins; validated below.
  "retainedEvidenceBindings",
  // An update's operator-supplied comparison and nominations; validated below.
  "readerEvidenceRequest",
  // The sealed change-source records a create or update run bound; validated below.
  "changeSources",
  // A release run's units index citation, decoded with changeSources below.
  "changeSourceRelease",
  "task",
  "status",
  "checkoutPersistence",
  "error",
  "createdAt",
  "startedAt",
  "completedAt",
  "durationMs",
  "models",
  "skills",
  "qualityPack",
  "qualityProfileSelection",
  "qualityArtifactValidation",
  "usage",
  "tools",
  "artifacts",
  "securityScan",
  "securityScanEffectiveDisposition",
  "securityScanAuthorization",
  "changes",
  "impactPostflight",
  // Optional per-run citation evidence, validated below because this decoder is
  // the publication gate.
  "sourceCitations",
  // Content-free credential-like content findings (#1807), validated below.
  "credentialFindings",
  "evidenceWarnings",
  "workflowOutcome",
  "workflowBranchCoverage",
  "searchFindings",
  "negativeEvidence",
  "gapLedger",
  "taskLineage",
  "answerRecordContinuation",
  "compositionExecution",
  "answerRecordDiscovery",
  "compositionExecutionAggregate",
  // Private model settings and their sources; publication never copies them.
  "modelSettings",
  "authoringExecution",
  "knowledgeResumeReceipt",
  "knowledgeContinuationReceipt",
  "knowledgeContinuationRecoveryAuthorization",
  "knowledgeContinuationSnapshotSha256",
  "knowledgeContinuationAcceptanceSha256",
  // How the request was interpreted; verified against the instruction below.
  "requestIntent",
  // Refused below: only a needs-input run that never wrote carries it.
  "firstPassContradiction",
  "firstPassContradictionAdmission",
  "firstPassReplay",
  "firstPassChoices",
  "steps",
] as const satisfies readonly (keyof RunRecord)[];

export function decode(
  value: unknown,
  snapshot: {
    readonly workflow: WorkflowDefinition;
    readonly workflowIdentity: CompositionExecutionWorkflowIdentity;
  } | null,
  options: PublicationRunRecordDecodeOptionsV1,
  purpose: "publication" | "checkout" | "review" = "publication",
): RunRecord {
  const root = object(value);
  allowed(
    root,
    purpose === "review" ? [...TOP_KEYS, "reviewScope", "reviewDeliverySnapshot"] : TOP_KEYS,
  );
  if (root.reviewScope !== undefined) decodeReviewScope(root.reviewScope);
  if (root.checkoutPersistence !== undefined) {
    try {
      decodeCheckoutPersistenceOutcome(root.checkoutPersistence);
    } catch {
      throw new PublicationRunRecordDecodeError(INVALID_SHAPE);
    }
  }
  // Shape only. Whether the coverage this evidence describes was achieved is
  // decided where it is produced, against the sealed binding and the run's own
  // access ledger; a record cannot prove itself.
  if (root.sourceCitations !== undefined) {
    try {
      decodeSourceRunCitations(root.sourceCitations);
    } catch {
      throw new PublicationRunRecordDecodeError("invalid-shape"); // hygiene: ok
    }
  }
  required(root, [
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
    "securityScan",
    "securityScanEffectiveDisposition",
    "changes",
    "steps",
  ]);
  expect(root.schemaVersion === 2 && root.status === "succeeded" && root.error === undefined);
  if (purpose === "review") expect(root.workflow === "review-documentation");
  identifier(root.id);
  expect(typeof root.workflow === "string" && isWorkflowName(root.workflow));
  const manifestWorkflow = snapshot?.workflow ?? getWorkflow(root.workflow);
  if (snapshot !== null) {
    expect(
      root.workflow === manifestWorkflow.name &&
        snapshot.workflowIdentity.id === manifestWorkflow.name &&
        SHA256.test(snapshot.workflowIdentity.sourceSha256),
    );
  }
  let workflow = manifestWorkflow;
  if (isWorkflowManifestV2(manifestWorkflow)) {
    const historicalV1 =
      root.workflowBranchCoverage === undefined && !hasEditorialDecisionOutput(root.artifacts);
    if (historicalV1) {
      workflow = { ...manifestWorkflow, ...workflowSelectedPath(manifestWorkflow, "author") };
    } else {
      if (!options.decodeWorkflowBranchCoverage) {
        throw new PublicationRunRecordDecodeError("coverage-unverified"); // hygiene: ok
      }
      const coverage = options.decodeWorkflowBranchCoverage(
        root.workflowBranchCoverage,
        value as RunRecord,
      );
      if (coverage.selection?.branchId === "assess-no-change") {
        throw new PublicationRunRecordDecodeError(NO_DOCUMENT_CHANGE);
      }
      expect(coverage.selection?.branchId === "author");
      workflow = { ...manifestWorkflow, ...workflowSelectedPath(manifestWorkflow, "author") };
    }
  }
  const retainedAuthoringExecution = root.authoringExecution;
  if (retainedAuthoringExecution !== undefined) {
    expect(root.workflow === "create-documentation" && isWorkflowManifestV3(manifestWorkflow));
    const authoringEvidence = decodeAuthoringExecutionEvidenceV1(
      retainedAuthoringExecution,
      manifestWorkflow,
    );
    expect(authoringEvidence.selection !== null);
    const branchId = authoringEvidence.selection!.branchId;
    workflow = { ...manifestWorkflow, ...authoringSelectedPath(manifestWorkflow, branchId) };
  } else {
    expect(!rawAuthoringPhasePresent(root.steps));
  }
  if (purpose === "review") expect(workflow.steps.every((step) => step.mode === "read-only"));
  else expect(workflow.steps.some((step) => step.mode === "write"));
  const knowledgeResumeReceipt =
    root.knowledgeResumeReceipt === undefined
      ? undefined
      : decodeKnowledgeResumeReceipt(root.knowledgeResumeReceipt);
  if (knowledgeResumeReceipt) {
    expect(workflow.name === "create-documentation" || workflow.name === "update-documentation");
    expect(canonical(root.knowledgeResumeReceipt) === canonical(knowledgeResumeReceipt));
  }
  const knowledgeContinuationReceipt =
    root.knowledgeContinuationReceipt === undefined
      ? undefined
      : decodeKnowledgeContinuationReceipt(root.knowledgeContinuationReceipt);
  if (knowledgeContinuationReceipt) {
    expect(workflow.name === knowledgeContinuationReceipt.workflow);
    expect(
      canonical(root.knowledgeContinuationReceipt) === canonical(knowledgeContinuationReceipt),
    );
  }
  const recoveryAuthorization =
    root.knowledgeContinuationRecoveryAuthorization === undefined
      ? undefined
      : decodeTaskLineageRecoveryAuthorization(root.knowledgeContinuationRecoveryAuthorization);
  expect((knowledgeContinuationReceipt === undefined) === (recoveryAuthorization === undefined));
  if (knowledgeContinuationReceipt) {
    expect(typeof root.knowledgeContinuationSnapshotSha256 === "string");
    expect(SHA256.test(root.knowledgeContinuationSnapshotSha256 as string));
    expect(typeof root.knowledgeContinuationAcceptanceSha256 === "string");
    expect(SHA256.test(root.knowledgeContinuationAcceptanceSha256 as string));
  } else {
    expect(root.knowledgeContinuationSnapshotSha256 === undefined);
    expect(root.knowledgeContinuationAcceptanceSha256 === undefined);
  }
  const repository = decodeRepository(root.repository);
  const workspace = object(root.workspace);
  exact(workspace, ["strategy", "disposable"]);
  expect(workspace.strategy === "tracked-export" && workspace.disposable === true);
  if (root.instruction !== undefined) safeText(root.instruction, 1_000_000);
  if (root.retryContext !== undefined) expect(isCliRunRetryContextV1(root.retryContext));
  if (root.operatorTargetPaths !== undefined) {
    try {
      decodeOperatorTargetPaths(root.operatorTargetPaths);
    } catch {
      throw new PublicationRunRecordDecodeError(INVALID_SHAPE); // hygiene: ok
    }
  }
  if (root.instructionContext !== undefined) {
    try {
      decodeRunRecordInstructionContext(root.instructionContext);
    } catch {
      throw new PublicationRunRecordDecodeError(INVALID_SHAPE); // hygiene: ok
    }
  }
  if (root.retainedEvidenceBindings !== undefined) {
    try {
      decodeRetainedEvidenceBindings(root.retainedEvidenceBindings, root.workflow);
    } catch {
      throw new PublicationRunRecordDecodeError(INVALID_SHAPE); // hygiene: ok
    }
  }
  if (root.readerEvidenceRequest !== undefined) {
    try {
      decodeRunRecordReaderEvidenceRequest(root.readerEvidenceRequest, root.workflow);
    } catch {
      throw new PublicationRunRecordDecodeError(INVALID_SHAPE); // hygiene: ok
    }
  }
  if (root.changeSources !== undefined) {
    try {
      decodeRunChangeSources(root.changeSources, root.workflow);
    } catch {
      throw new PublicationRunRecordDecodeError(INVALID_SHAPE); // hygiene: ok
    }
  }
  if (root.reviewDeliverySnapshot !== undefined) {
    try {
      decodeReviewDeliverySnapshotReference(root.reviewDeliverySnapshot, {
        runId: root.id as string,
        workflow: root.workflow as string,
        status: root.status as string,
        changeSources: root.changeSources as RunRecord["changeSources"],
      });
    } catch {
      throw new PublicationRunRecordDecodeError(INVALID_SHAPE); // hygiene: ok
    }
  }
  try {
    decodeRunChangeSourceRelease(root.changeSourceRelease, root.workflow, root.changeSources);
  } catch {
    throw new PublicationRunRecordDecodeError(INVALID_SHAPE); // hygiene: ok
  }
  if (root.requestIntent !== undefined) {
    let requestIntent: ReturnType<typeof decodeRunRecordRequestIntent>;
    try {
      requestIntent = decodeRunRecordRequestIntent(root.requestIntent, root.instruction);
    } catch {
      throw new PublicationRunRecordDecodeError(INVALID_SHAPE); // hygiene: ok
    }
    // A run that stopped at its interpretation never reaches a succeeded write.
    expect(
      (REQUEST_INTENT_CONTINUING_OUTCOMES as readonly string[]).includes(
        requestIntent.admission.outcome,
      ),
    );
  }
  // A run first pass stopped on disagreeing sources never reaches a succeeded write.
  expect(root.firstPassContradiction === undefined);
  expect(root.firstPassContradictionAdmission === undefined);
  expect(root.firstPassReplay === undefined);
  // Local checkout keeps the closed attribution. Publication still refuses an
  // unverified choice; its reader has no option that weakens that boundary.
  if (root.firstPassChoices !== undefined) {
    expect(purpose === "checkout");
    decodeSavedRunRecord(value as JsonEvidenceValue, root.id as string);
  }
  const boundedIntendedPaths = decodeTask(
    root.task,
    root.workflow,
    repository.revision,
    repository.sourcePath,
    root.instruction,
  );
  if (boundedIntendedPaths) expect(root.instruction === undefined);

  const createdAt = timestamp(root.createdAt);
  const startedAt = timestamp(root.startedAt);
  const completedAt = timestamp(root.completedAt);
  const durationMs = integer(root.durationMs);
  if (root.answerRecordContinuation !== undefined) {
    decodeAnswerRecordContinuationReceipt(root.answerRecordContinuation);
  }
  expect(Date.parse(createdAt) <= Date.parse(startedAt));
  expect(Date.parse(startedAt) <= Date.parse(completedAt));
  expect(Date.parse(completedAt) - Date.parse(startedAt) === durationMs);

  const rawSteps = array(root.steps);
  expect(rawSteps.length === workflow.steps.length);
  let priorGapLedger: ReturnType<typeof decodeDocumentationGapLedger> | undefined;
  const steps = rawSteps.map((entry, index) => {
    const definition = workflow.steps[index]!;
    const contextPolicy = workflow.contextPolicy.steps[index];
    expect(contextPolicy !== undefined && contextPolicy.stepId === definition.id);
    const decoded = decodeStep(
      entry,
      workflow.name,
      definition,
      contextPolicy,
      repository.revision,
      startedAt,
      completedAt,
      priorGapLedger,
      retainedAuthoringExecution !== undefined &&
        isWorkflowManifestV3(manifestWorkflow) &&
        workflow.steps.some((step) => step.id === "verify-revised-technical-accuracy"),
    );
    if (decoded.reviewLocatorObservation !== undefined) {
      expect(decoded.reviewLocatorObservation.runId === root.id);
    }
    if (decoded.gapLedger) priorGapLedger = decoded.gapLedger;
    return decoded;
  });
  const inventoryOnly =
    !isWorkflowManifestV3(manifestWorkflow) && hasInventoryBeforeWrite(workflow);
  if (
    inventoryOnly ||
    (!isWorkflowManifestV3(manifestWorkflow) && assertSourceObligationPhaseContract(workflow))
  ) {
    const derive = steps.find(
      (step) =>
        step.id === "derive-source-obligations" && step.skill === "verify-technical-accuracy",
    );
    const final = steps.find(
      (step) => step.id === "verify-technical-accuracy" && step.skill === step.id,
    );
    expect(derive?.summary !== undefined && derive.searchEvidence !== undefined);
    const plan = steps.find(
      (step) => step.id === "plan-documentation" && step.planBinding !== undefined,
    )?.planBinding;
    const authoritySteps = steps.filter((step) => step.originalSourceAuthority !== undefined);
    if (inventoryOnly) {
      const planner = steps.find(
        (step) => step.id === "plan-documentation" && step.status === "succeeded",
      );
      const mode = documentationPlanModeForWorkflow(workflow.name);
      expect(
        mode !== undefined &&
          authoritySteps.length === 1 &&
          authoritySteps[0]?.id === "derive-source-obligations" &&
          steps.every((step) => step.technicalCorrectionEvidence === undefined) &&
          planner?.planBinding !== undefined &&
          derive?.planBinding !== undefined,
      );
      const derivePlan = validateAdmittedDocumentationPlanBinding(derive!.planBinding, {
        expectedMode: mode,
      });
      const plannerPlan = validateAdmittedDocumentationPlanBinding(planner!.planBinding, {
        expectedMode: mode,
      });
      expect(derivePlan.digest === plannerPlan.digest);
      const ledger = validateSourceObligationLedger(
        parseJsonEvidence(derive!.summary!),
        {
          workflow,
          evidenceIdentity: { repositoryRevision: repository.revision },
          searchEvidence: derive!.searchEvidence!,
          planBinding: derivePlan,
        },
        derive!.originalSourceAuthority,
      );
      expect(ledger.schemaVersion === 2);
    }
    if (!inventoryOnly) {
      const parsedLedger = parseJsonEvidence(derive!.summary!);
      const isV2Ledger =
        typeof parsedLedger === "object" &&
        parsedLedger !== null &&
        !Array.isArray(parsedLedger) &&
        parsedLedger.schemaVersion === 2;
      expect(
        isV2Ledger
          ? authoritySteps.length === 1 && authoritySteps[0]?.id === "derive-source-obligations"
          : authoritySteps.length === 0,
      );
      const authority = isV2Ledger
        ? validateOriginalSourceAuthorityEvidence(derive!.originalSourceAuthority, {
            scope:
              workflow.name === "create-documentation"
                ? "create-plan-sources"
                : "review-tracked-workspace",
            repositoryRevision: repository.revision,
            scopeSha256: sourceObligationScopeSha256({
              workflow,
              ...(plan ? { planBinding: plan } : {}),
              ...(root.reviewScope
                ? { reviewScope: root.reviewScope as RunRecord["reviewScope"] }
                : {}),
            }),
            workspaceSnapshotSha256: derive!.searchEvidence!.workspaceSnapshotSha256,
          })
        : undefined;
      if (workflow.name === "create-documentation" && authority) {
        const planPaths = assertSourceObligationSourceAuthority({
          workflow,
          planBinding: plan,
          evidenceIdentity: { repositoryRevision: repository.revision },
        });
        const admittedProposalPaths = (derive!.sourceProposalAdmissions ?? [])
          .filter((entry) => entry.status === "admitted")
          .map((entry) => entry.path);
        const authorityPaths = [...new Set([...planPaths, ...admittedProposalPaths])].sort();
        expect(
          JSON.stringify(authority.members.map((member) => member.path)) ===
            JSON.stringify(authorityPaths),
        );
      }
      const ledger = validateSourceObligationLedger(parsedLedger, undefined, authority);
      expect(
        ledger.identity.repositoryRevision === repository.revision &&
          ledger.identity.sourceEvidenceSha256 === derive!.searchEvidence!.evidenceSha256 &&
          ledger.identity.workspaceSnapshotSha256 ===
            derive!.searchEvidence!.workspaceSnapshotSha256 &&
          ledger.identity.scopeSha256 ===
            sourceObligationScopeSha256({
              workflow,
              ...(plan ? { planBinding: plan } : {}),
              ...(root.reviewScope
                ? { reviewScope: root.reviewScope as RunRecord["reviewScope"] }
                : {}),
            }),
      );
      expect(final?.summary !== undefined && final.technicalCorrectionEvidence !== undefined);
      const verificationTargets = root.reviewScope
        ? (root.reviewScope as NonNullable<RunRecord["reviewScope"]>).targetPaths
        : plan
          ? documentationPlanPagePaths(plan)
          : undefined;
      const verification = decodeAdmittedVerificationSummary(final!.summary, verificationTargets);
      expect(verification !== undefined);
      validateTechnicalCorrectionEvidence(
        final!.technicalCorrectionEvidence,
        ledger,
        verification!,
        authority,
      );
      validateRetainedProvisionalCandidates(
        steps,
        ledger,
        verificationTargets ?? verification!.coverage.map((entry) => entry.path),
      );
    }
  }
  if (retainedAuthoringExecution !== undefined) {
    const derive = steps.find((step) => step.id === "derive-source-obligations");
    const plan = steps.find((step) => step.id === "plan-documentation")?.planBinding;
    expect(derive?.summary !== undefined && plan !== undefined);
    const ledger = validateSourceObligationLedger(
      parseJsonEvidence(derive!.summary!),
      undefined,
      derive!.originalSourceAuthority,
    );
    validateRetainedProvisionalCandidates(steps, ledger, documentationPlanPagePaths(plan!));
  }
  if (
    ["create-documentation", "update-documentation", "restructure-documentation"].includes(
      workflow.name,
    )
  ) {
    const planner = steps.find(
      (step) => step.skill === "plan-documentation" && step.status === "succeeded",
    );
    const writer = steps.find(
      (step) => step.skill === "write-documentation" && step.status === "succeeded",
    );
    if (planner || writer) {
      expect(planner !== undefined && writer !== undefined);
      expect(planner.planBinding !== undefined && writer.planBinding !== undefined);
      expect(planner.planBinding.digest === writer.planBinding.digest);
      expect(planner.planBinding.mode === writer.planBinding.mode);
      if (knowledgeResumeReceipt) {
        expect(
          documentationPlanPagePaths(planner.planBinding).every(
            (path) => path === knowledgeResumeReceipt.selectedTargetPath,
          ),
        );
      }
    }
  }
  for (let index = 1; index < steps.length; index += 1) {
    expect(Date.parse(steps[index - 1]!.completedAt!) <= Date.parse(steps[index]!.startedAt!));
  }
  const physicallyExecutedSteps = steps.filter((step) => step.inheritedFrom === undefined);
  expect(physicallyExecutedSteps.reduce((sum, step) => sum + step.durationMs!, 0) <= durationMs);
  const rebuilt = documentationGapLedgerFromStepFindings({
    currentRevision: repository.revision,
    steps,
  });
  if (!rebuilt) {
    expect(
      root.searchFindings === undefined &&
        root.negativeEvidence === undefined &&
        root.gapLedger === undefined,
    );
  } else {
    const searchFindings = array(root.searchFindings).map(decodeDocumentationSearchFinding);
    const negativeEvidence = array(root.negativeEvidence).map(decodeDocumentationSearchFinding);
    const gapLedger = decodeDocumentationGapLedger(root.gapLedger);
    expect(canonical(searchFindings) === canonical(rebuilt.searchFindings));
    expect(canonical(negativeEvidence) === canonical(rebuilt.negativeEvidence));
    expect(canonical(gapLedger) === canonical(rebuilt.gapLedger));
  }
  const models = array(root.models).map(decodeModelEvidence);
  const skills = array(root.skills).map(decodeSkillEvidence);
  if (root.qualityPack !== undefined) decodeQualityPackEvidence(root.qualityPack);
  expect(unique(models) && unique(skills));
  expect(
    canonical(models) ===
      canonical(uniqueValues(physicallyExecutedSteps.map((step) => step.model))),
  );
  expect(
    canonical(skills) ===
      canonical(uniqueValues(physicallyExecutedSteps.map((step) => step.skillEvidence))),
  );
  const usage = decodeUsage(root.usage);
  const tools = decodeTools(root.tools);
  expect(canonical(usage) === canonical(sumUsage(physicallyExecutedSteps)));
  expect(canonicalTools(tools) === canonicalTools(sumTools(physicallyExecutedSteps)));

  const artifacts = decodeArtifacts(root.artifacts, undefined, repository.revision);
  const stepArtifacts = steps.flatMap((step) => step.artifacts ?? []);
  expect(canonical(artifacts) === canonical(uniqueValues(stepArtifacts)));
  validateTaskArtifactBinding(root.task, root.workflow, stepArtifacts);
  decodeScanner(root, repository.revision, startedAt);
  const changedFiles = decodeChanges(root.changes, purpose === "review");
  if (boundedIntendedPaths) {
    expect(
      canonical([...new Set(changedFiles.map((file) => file.path))].sort()) ===
        canonical([...boundedIntendedPaths].sort()),
    );
  }
  decodeImpact(root.impactPostflight, changedFiles);
  if (root.evidenceWarnings !== undefined) {
    const warnings = array(root.evidenceWarnings).map((item) => safeText(item, 1_024));
    expect(new Set(warnings).size === warnings.length);
  }
  if (root.credentialFindings !== undefined) decodeCredentialFindings(root.credentialFindings);
  let taskLineage: ReturnType<typeof assertTaskLineageProjection> | undefined;
  if (root.taskLineage !== undefined) {
    // Optional sealed projection; a malformed one fails closed. Never invent
    // lineage when absent: preflight consumes this after decode.
    taskLineage = assertTaskLineageProjection(root.taskLineage);
  }
  if (knowledgeContinuationReceipt) {
    expect(taskLineage !== undefined && recoveryAuthorization !== undefined);
    const targetConflictReceiptSha256 = knowledgeContinuationReceipt.targetConflictReceiptSha256;
    expect(
      createHash("sha256").update(repository.sourcePath).digest("hex") ===
        knowledgeContinuationReceipt.repositoryIdentitySha256 &&
        repository.revision === knowledgeContinuationReceipt.repositoryRevision &&
        taskLineage!.projectionSha256 ===
          knowledgeContinuationReceipt.taskLineageProjectionSha256 &&
        taskLineage!.originSha256 === recoveryAuthorization!.originalOriginSha256 &&
        taskLineage!.lineageSha256 === recoveryAuthorization!.originalLineageSha256 &&
        createHash("sha256")
          .update((typeof root.instruction === "string" ? root.instruction : "").normalize("NFC"))
          .digest("hex") === knowledgeContinuationReceipt.instructionSha256 &&
        matchesKnowledgeContinuationTargetConflictScope(
          knowledgeContinuationReceipt.targetConflictReceipt,
          knowledgeResumeReceipt,
          root.knowledgeContinuationSnapshotSha256 as string,
        ) &&
        root.knowledgeContinuationAcceptanceSha256 ===
          knowledgeContinuationAcceptanceSha256({
            receiptSha256: knowledgeContinuationReceipt.receiptSha256,
            recoveryAuthorizationSha256: recoveryAuthorization!.authorizationSha256,
            snapshotSha256: root.knowledgeContinuationSnapshotSha256 as string,
            targetConflictReceiptSha256,
          }),
    );
  }
  const record = value as RunRecord;
  if (root.qualityProfileSelection !== undefined) {
    const selection = decodeQualityProfileSelectionReceipt(root.qualityProfileSelection);
    expect(
      (record.workflow === "create-documentation" ||
        record.workflow === "update-documentation" ||
        (purpose === "review" && record.workflow === "review-documentation")) &&
        selection.workflow === record.workflow &&
        selection.repositoryRevision === repository.revision &&
        selection.repositoryIdentitySha256 ===
          createHash("sha256").update(repository.sourcePath).digest("hex") &&
        selection.qualityPackManifestSha256 === record.qualityPack?.manifestSha256 &&
        selection.qualityPackBindingSha256 === record.qualityPack?.bindingSha256 &&
        selection.skillLockSha256 === record.qualityPack?.skillLockSha256 &&
        selection.qualityLockSha256 === record.qualityPack?.qualityLockSha256 &&
        selection.qualityBundleSha256 === record.qualityPack?.qualityBundleSha256 &&
        record.qualityPack?.barIds.includes(selection.profileBarId) === true,
    );
  }
  if (steps.some((step) => step.qualityValidationRejection !== undefined)) {
    expect(
      root.qualityProfileSelection !== undefined && root.qualityArtifactValidation === undefined,
    );
  }
  if (root.qualityArtifactValidation !== undefined) {
    // A retained receipt must bind the evaluated report to this run's final
    // authored patch. A selected profile alone remains advisory when the host
    // declined the report, so it does not block applying that saved patch.
    expect(root.qualityProfileSelection !== undefined);
    expect(projectQualityReportFromRun(record) !== null);
  }

  if (root.answerRecordContinuation !== undefined) {
    expect(isSelfConsistentAnswerRecordContinuation(record, manifestWorkflow));
  } else {
    expect(steps.every((step) => step.inheritedFrom === undefined));
  }
  if (retainedAuthoringExecution !== undefined) {
    expect(isWorkflowManifestV3(manifestWorkflow));
    validateAuthoringRunRecordV1(record, manifestWorkflow, { requireTerminalSuccess: true });
  }
  if (root.workflowOutcome !== undefined) {
    decodeWorkflowOutcome(root.workflowOutcome, record, options);
  }
  if (purpose !== "review") assertRunRecordEditorialDeliveryEligible(record, options);
  decodeCompositionPublication(root, record, manifestWorkflow, snapshot?.workflowIdentity ?? null);
  return record;
}

function validateRetainedProvisionalCandidates(
  steps: readonly StepRunRecord[],
  ledger: SourceObligationLedger,
  targetPaths: readonly string[],
): void {
  for (const [provisionalId, finalId] of [
    ["provisional-technical-verification", "verify-technical-accuracy"],
    ["provisional-revised-technical-verification", "verify-revised-technical-accuracy"],
  ] as const) {
    const provisional = steps.find((step) => step.id === provisionalId);
    const final = steps.find((step) => step.id === finalId);
    const raw = provisional?.provisionalRichCandidateEvidence;
    const attempts = final?.inference?.attempts ?? [];
    if (raw === undefined) {
      expect(final?.technicalCorrectionEvidence?.schemaVersion !== 4);
      expect(
        attempts.every((attempt) => attempt.identity?.provisionalRichCandidateSha256 === undefined),
      );
      continue;
    }
    expect(
      ledger.schemaVersion === 2 &&
        provisional?.status === "succeeded" &&
        final?.status === "succeeded",
    );
    const result = decodeAdmittedVerificationSummary(provisional!.summary, targetPaths);
    expect(result !== undefined);
    const evidence = validateProvisionalRichCandidateEvidence(
      raw,
      ledger as Extract<SourceObligationLedger, { schemaVersion: 2 }>,
      result!,
      targetPaths,
    );
    if (final?.technicalCorrectionEvidence?.schemaVersion === 4) {
      validateTechnicalRichCandidateBinding(
        final.technicalCorrectionEvidence,
        evidence,
        ledger as Extract<SourceObligationLedger, { schemaVersion: 2 }>,
      );
    }
    expect(
      attempts.length > 0 &&
        attempts.every(
          (attempt) => attempt.identity?.provisionalRichCandidateSha256 === evidence.digest,
        ),
    );
  }
}

function decodeReviewScope(value: unknown): void {
  const scope = object(value);
  required(scope, [
    "scope",
    "reason",
    "targetPaths",
    "deferredPaths",
    "scopeSha256",
    "corpusFileCount",
  ]);
  allowed(scope, [
    "scope",
    "reason",
    "targetPaths",
    "deferredPaths",
    "anchorPaths",
    "scopeSha256",
    "corpusFileCount",
    "continuationIdentity",
    "accounting",
  ]);
  expect(scope.scope === "focused-set");
  expect(
    [
      "operator-named",
      "documentation-index",
      "within-budget",
      "navigation-changed",
      "model-changed",
      "config-changed",
      "scan-unavailable",
    ].includes(scope.reason as string),
  );
  const targets = array(scope.targetPaths).map(repositoryPath);
  const deferred = array(scope.deferredPaths).map(repositoryPath);
  expect(targets.length > 0 && new Set(targets).size === targets.length);
  expect(
    new Set(deferred).size === deferred.length && deferred.every((path) => !targets.includes(path)),
  );
  if (scope.anchorPaths !== undefined) {
    const anchors = array(scope.anchorPaths).map(repositoryPath);
    expect(new Set(anchors).size === anchors.length);
  }
  digest(scope.scopeSha256);
  if (scope.corpusFileCount !== null) integer(scope.corpusFileCount);
  if (scope.continuationIdentity !== undefined) {
    const continuation = object(scope.continuationIdentity);
    exact(continuation, ["canonSha256", "reviewRevision"]);
    digest(continuation.canonSha256);
    expect(
      typeof continuation.reviewRevision === "string" && REVISION.test(continuation.reviewRevision),
    );
  }
  if (scope.accounting !== undefined) {
    const accounting = object(scope.accounting);
    exact(accounting, [
      "radiusSha256",
      "radiusPageCount",
      "listedPageCount",
      "unlistedPageCount",
      "unreviewableNeighbourCount",
      "changedPathCount",
      "continuationCharacterLimit",
    ]);
    digest(accounting.radiusSha256);
    for (const key of [
      "radiusPageCount",
      "listedPageCount",
      "unlistedPageCount",
      "unreviewableNeighbourCount",
      "continuationCharacterLimit",
    ])
      integer(accounting[key]);
    if (accounting.changedPathCount !== null) integer(accounting.changedPathCount);
  }
}

function hasEditorialDecisionOutput(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.some((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
      const use = entry as Record<string, unknown>;
      if (use.role !== "output" || !use.reference || typeof use.reference !== "object") {
        return false;
      }
      return (use.reference as Record<string, unknown>).kind === "editorial-decision";
    })
  );
}

function rawAuthoringPhasePresent(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.some(
      (entry) =>
        entry !== null &&
        typeof entry === "object" &&
        !Array.isArray(entry) &&
        (Object.hasOwn(entry, "authoringPhase") ||
          Object.hasOwn(entry, "authoringRevisionAccounting")),
    )
  );
}

function decodeCompositionPublication(
  root: Record<string, unknown>,
  record: RunRecord,
  workflow: WorkflowDefinition,
  workflowIdentity: CompositionExecutionWorkflowIdentity | null,
): void {
  if (record.answerRecordDiscovery !== undefined) {
    expect(
      workflow.name === "review-documentation" &&
        root.compositionExecution === undefined &&
        root.compositionExecutionAggregate === undefined,
    );
    try {
      const evidence = assertAnswerRecordDiscoveryRunBindingV1(record.answerRecordDiscovery, {
        runId: record.id,
        workflow: record.workflow,
        repositoryRevision: record.repository.revision,
        repositorySourcePath: record.repository.sourcePath,
      });
      expect(
        workflowIdentity === null ||
          (evidence.composition.workflow.id === workflowIdentity.id &&
            evidence.composition.workflow.sourceSha256 === workflowIdentity.sourceSha256),
      );
    } catch {
      expect(false);
    }
    if (record.answerRecordContinuation !== undefined) {
      expect(isSelfConsistentAnswerRecordContinuation(record, workflow));
    }
    return;
  }
  if (record.answerRecordContinuation !== undefined) {
    expect(isSelfConsistentAnswerRecordContinuation(record, workflow));
    if (
      root.compositionExecution !== undefined ||
      root.compositionExecutionAggregate !== undefined
    ) {
      expect(
        root.compositionExecution !== undefined && root.compositionExecutionAggregate === undefined,
      );
      verifyRunRecordComposition(record, workflow);
    }
    return;
  }
  if (root.compositionExecution === undefined && root.compositionExecutionAggregate === undefined) {
    return;
  }
  expect(
    root.compositionExecution !== undefined && root.compositionExecutionAggregate !== undefined,
  );
  const compositionExecution = parseCompositionExecutionEvidence(root.compositionExecution);
  const aggregate = parseCompositionExecutionAggregate(root.compositionExecutionAggregate);
  expect(
    compositionExecution.technicalApproval === "not-established" &&
      compositionExecution.roleQualification === "not-established" &&
      compositionExecution.releaseEligible === false &&
      aggregate.technicalApproval === "not-established" &&
      aggregate.roleQualification === "not-established" &&
      aggregate.releaseEligible === false,
  );
  const normalizedRecord: RunRecord = {
    ...record,
    compositionExecution,
    compositionExecutionAggregate: aggregate,
  };
  const expected =
    workflowIdentity === null
      ? createCompositionExecutionAggregate({
          compositionExecution,
          run: normalizedRecord,
          workflow,
        })
      : reconstructCompositionExecutionAggregateSnapshot({
          compositionExecution,
          run: normalizedRecord,
          workflow,
          workflowIdentity,
        });
  expect(canonical(aggregate) === canonical(expected));
}

function decodeRepository(value: unknown): RunRecord["repository"] {
  const item = object(value);
  required(item, ["sourcePath", "requestedRevision", "revision"]);
  allowed(item, [
    "sourcePath",
    "requestedRevision",
    "revision",
    "gitlabTargetBranch",
    "gitlabTargetRevision",
  ]);
  expect(typeof item.sourcePath === "string" && item.sourcePath.startsWith("/"));
  safeText(item.requestedRevision, 1_024);
  expect(typeof item.revision === "string" && REVISION.test(item.revision));
  if (item.gitlabTargetBranch !== undefined) {
    safeText(item.gitlabTargetBranch, 200);
  }
  if (item.gitlabTargetRevision !== undefined) {
    expect(
      typeof item.gitlabTargetRevision === "string" && REVISION.test(item.gitlabTargetRevision),
    );
  }
  return item as unknown as RunRecord["repository"];
}

function decodeTask(
  value: unknown,
  workflow: RunRecord["workflow"],
  revision: string,
  sourcePath: string,
  instruction: unknown,
): string[] | undefined {
  try {
    const normalized = normalizeWorkflowTaskInput({
      workflow,
      task: value === undefined || value === null ? null : (value as WorkflowTaskInput),
      repository: {
        identitySha256: createHash("sha256").update(sourcePath).digest("hex"),
        revision,
      },
      allowWrite: true,
      ...(typeof instruction === "string" ? { instruction } : {}),
    });
    return normalized?.kind === "bounded-doc-improvement" ? normalized.intendedPaths : undefined;
  } catch (error) {
    if (error instanceof WorkflowTaskValidationError) {
      throw new PublicationRunRecordDecodeError(error.code, { cause: error });
    }
    throw error;
  }
}

function decodeAnswerRecordContinuationReceipt(value: unknown): AnswerRecordContinuationReceiptV1 {
  const receipt = object(value);
  const required = [
    "schemaVersion",
    "kind",
    "sourceRunId",
    "sourceRunRecordSha256",
    "checkpointSha256",
    "checkpointSequence",
    "checkpointAttempt",
    "logicalRunId",
    "inheritedPrefixSha256",
  ];
  expect(
    Object.keys(receipt).length ===
      required.length + Number(Object.hasOwn(receipt, "recoveryBasis")) &&
      required.every((key) => Object.hasOwn(receipt, key)),
  );
  if (Object.hasOwn(receipt, "recoveryBasis")) {
    expect(receipt.recoveryBasis === "same-host-owner-process-exited");
  }
  expect(receipt.schemaVersion === 1);
  expect(receipt.kind === "docsfab-answer-record-continuation-receipt");
  safeText(receipt.sourceRunId, 512);
  safeText(receipt.logicalRunId, 512);
  digest(receipt.sourceRunRecordSha256);
  digest(receipt.checkpointSha256);
  digest(receipt.inheritedPrefixSha256);
  expect(
    Number.isSafeInteger(receipt.checkpointSequence) && (receipt.checkpointSequence as number) > 0,
  );
  expect(
    Number.isSafeInteger(receipt.checkpointAttempt) && (receipt.checkpointAttempt as number) > 0,
  );
  return receipt as unknown as AnswerRecordContinuationReceiptV1;
}

function validateTaskArtifactBinding(
  task: unknown,
  workflow: RunRecord["workflow"],
  uses: ArtifactUse[],
): void {
  if (workflow !== "site-bootstrap") return;
  const plan = object(task).plan;
  expect(uses.some((use) => use.role === "input" && canonical(use.reference) === canonical(plan)));
}

function decodeScanner(root: Record<string, unknown>, revision: string, startedAt: string): void {
  const report = decodeSecurityScan(root.securityScan);
  const disposition = decodeSecurityDisposition(root.securityScanEffectiveDisposition);
  // The whole-repository scan neither grants nor denies publication authority.
  // New records are `advisory` with no override authorization; legacy records
  // keep the authorization-consistency contract so they stay readable.
  if (disposition.status === "advisory") {
    expect(root.securityScanAuthorization === undefined);
    return;
  }
  const authorization =
    root.securityScanAuthorization === undefined
      ? undefined
      : decodeSecurityAuthorization(root.securityScanAuthorization);
  const overrides =
    authorization?.overrides.map(({ ruleId, reason, expiresAt }) => ({
      ruleId,
      revision,
      reason,
      expiresAt,
    })) ?? [];
  const reconstructed =
    overrides.length === 0
      ? undefined
      : authorizeSecurityScan(report, overrides, revision, new Date(startedAt));
  expect(canonical(authorization) === canonical(reconstructed));
  expect(
    canonical(disposition) ===
      canonical(resolveSecurityScanEffectiveDisposition(report, reconstructed)),
  );
  expect(disposition.status === "passed" || disposition.status === "authorized");
}

function decodeChanges(value: unknown, readOnlyReview = false): ChangedFileEvidence[] {
  const changes = object(value);
  if (readOnlyReview) {
    allowed(changes, ["files", "patch"]);
    required(changes, ["files"]);
  } else {
    exact(changes, ["files", "patch"]);
  }
  const files = array(changes.files).map((entry) => {
    const file = object(entry);
    allowed(file, ["path", "status", "previousPath"]);
    required(file, ["path", "status"]);
    repositoryPath(file.path);
    expect(
      ["added", "modified", "deleted", "renamed", "copied", "untracked", "unknown"].includes(
        String(file.status),
      ),
    );
    if (file.previousPath !== undefined) repositoryPath(file.previousPath);
    expect(
      ["renamed", "copied"].includes(String(file.status)) === (file.previousPath !== undefined),
    );
    return file as unknown as ChangedFileEvidence;
  });
  expect(unique(files));
  if (readOnlyReview && changes.patch === undefined) {
    expect(files.length === 0);
    return files;
  }
  const patch = object(changes.patch);
  exact(patch, ["sha256", "byteLength", "lineCount", "artifactPath", "format"]);
  expect(typeof patch.sha256 === "string" && SHA256.test(patch.sha256));
  integer(patch.byteLength);
  integer(patch.lineCount);
  expect((patch.byteLength === 0) === (patch.lineCount === 0));
  expect(typeof patch.artifactPath === "string" && patch.artifactPath.startsWith("/"));
  expect(patch.format === "git-diff");
  return files;
}

function decodeImpact(value: unknown, files: ChangedFileEvidence[]): void {
  if (value === undefined) return;
  const item = object(value);
  allowed(item, ["schemaVersion", "status", "analysisDigest", "changedPaths", "reason"]);
  expect(item.schemaVersion === 1 && item.reason === undefined);
  const patched = new Set(
    files.flatMap((file) => [file.path, ...(file.previousPath ? [file.previousPath] : [])]),
  );
  if (item.status === "no-change") {
    expect(item.analysisDigest === undefined && item.changedPaths === undefined);
    expect([...patched].every((path) => isProjectConfigPath(path)));
    return;
  }
  expect(item.status === "completed");
  expect(typeof item.analysisDigest === "string" && SHA256.test(item.analysisDigest));
  const paths = array(item.changedPaths).map(repositoryPath);
  const affected = new Set(paths);
  // The affected set may be a superset (structural neighbors) but must cover
  // every patched path. Project config (`.docsfab.json`, `.docsfab/**`) may be omitted.
  expect([...patched].every((path) => affected.has(path) || isProjectConfigPath(path)));
}

export function isProjectConfigPath(path: string): boolean {
  return path === ".docsfab.json" || path.startsWith(".docsfab/");
}

/** Content-free findings: a location and a scanner rule each, unique and sorted. */
export function decodeCredentialFindings(
  value: unknown,
  locationForm: "record" | "presentation" = "record",
): void {
  const findings = array(value).map((item) => {
    const finding = object(item);
    exact(finding, ["code", "location", "rule"]);
    expect(finding.code === CREDENTIAL_LIKE_CONTENT);
    expect(typeof finding.rule === "string" && CREDENTIAL_RULE_ID.test(finding.rule));
    return {
      code: CREDENTIAL_LIKE_CONTENT,
      location: safeText(
        finding.location,
        locationForm === "presentation"
          ? credentialFindingPresentationLocationReadBound()
          : credentialFindingLocationReadBound(),
      ),
      rule: finding.rule,
    } as const;
  });
  expect(canonical(findings) === canonical(sortCredentialFindings(findings)));
}

const CREDENTIAL_RULE_ID = /^credential\.[a-z0-9.-]{1,127}$/u;
