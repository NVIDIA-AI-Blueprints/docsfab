// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  qualityExecutionResource,
  QualityResourceRoleError,
} from "../quality-pack/resource-roles.js";
import { qualityExecutionPath } from "../quality-pack/resource-access.js";

import type { DurableArtifactStore } from "../artifacts/index.js";
import { OUTPUT_RECORD_CONTRACTS, rejectOutput } from "../contracts/model-output.generated.js";
import {
  createQualityAnswerRecordAdmission,
  type QualityAnswerRecordBindingsV1,
  type QualityAnswerRecordValidationCandidateV1,
  type QualityAnswerRecordValidationOutcomeV1,
} from "../harness/quality-answer-record-admission.js";
import { planDocumentationQualityAnswerRecords } from "../harness/answer-record-plan.js";
import type { HostMintedValues } from "../harness/answer-record-fill.js";
import type {
  QualityAnswerRecordSessionV1,
  QualityAnswerRecordOutputCode,
} from "../execution/contracts.js";
import type {
  AnswerRecordContinuationCheckpointEnvelopeV1,
  EvaluateStepEvidenceV1,
  AnswerRecordLedgerIndexV1,
} from "../records/contracts.js";
import type { JsonEvidenceValue } from "../json-evidence.js";
import { limit, limitDefinition } from "../config/limits.js";
import { canonicalDigest, canonicalJson, sha256 } from "../content-ir/canonical.js";
import { runBoundedChild } from "./quality-validator-host/bounded-child.js";
import {
  deriveQuality,
  derivationFailure,
  QualityDerivationError,
  type QualityDerivationInputV1,
  type QualityDerivationV1,
} from "./quality-validator-host/derivation.js";
import {
  ensurePrivateDirectory,
  verifyRegularDigest,
  writePrivate,
} from "./quality-validator-host/private-files.js";
import {
  prepareFullArtifactDerivation,
  projectFullArtifactDerivation,
} from "./quality-validator-host/projection.js";
import { parseJsonEvidence } from "../json-evidence.js";
import type { QualityArtifactCandidateV1 } from "../execution/contracts.js";
import type {
  QualityArtifactValidationBindingV1,
  QualityHostDerivationCountsV1,
  QualityValidatorInvocationReceiptV1,
} from "../records/contracts.js";
import type { SelectedDocumentationQualityProfile } from "./quality-profile-selection.js";
import { describeEvaluationTarget, fillEvaluationTarget } from "./evaluation-target.js";
import {
  projectEvaluationValidatorRejection,
  type QualityValidationRejectionV1,
} from "./quality-validation-rejection.js";
import {
  hostCheckCodeOf,
  hostCheckRejection,
  isLockedValidator,
  projectLockedValidatorRejection,
  QUALITY_CHECK_INTEGRITY_CODES,
  QUALITY_VALIDATOR_UNAVAILABLE_CODES,
  QUALITY_CHECK_REJECTION_CODES,
  TECHNICAL_TRACE_REJECTION_CODES,
  hostCheckError,
  QualityHostCheckError,
  type QualityCheckRejectionCode,
  qualityCandidateAdmissionError,
  type QualityHostPhase,
  QualityStepRejectionError,
  technicalTraceRejection,
} from "./quality-check-rejections.js";
import {
  EVALUATION_DIAGNOSTIC_CODES,
  type EvaluationDiagnosticCode,
  type EvaluationSchemaRejectionCode,
} from "./quality-validation-rejection.js";
import { STAGED_QUALITY_SCHEMA_MISMATCH_KEYWORDS } from "./quality-schema-validation.js";
import type { VerificationResult } from "../workflow-execution/review-response.js";
import {
  assertTechnicalFactTrace,
  carryAdmittedTechnicalLocators,
  inspectTechnicalFactTrace,
  type QualityArtifactBindings,
  QualityArtifactStagingError,
  type QualityArtifactValidationFailureCode,
  type StagedQualityArtifact,
  type StagedQualityCandidate,
  type TechnicalFactTraceMode,
  loadStagedQualityArtifact,
  preflightQualityArtifactCandidateContent,
  sealQualityValidationBinding,
  sealQualityValidatorReceipt,
  stageFinalQualityReport,
  stageQualityArtifactCandidate,
} from "./quality-artifact-staging.js";

export { QualityDerivationError } from "./quality-validator-host/derivation.js";
export type {
  QualityDerivationFailureReason,
  QualityDerivationInputV1,
  QualityDerivationOutcomeV1,
  QualityDerivationReceiptV1,
  QualityDerivationV1,
} from "./quality-validator-host/derivation.js";

export type LockedQualityCompletionRefusalCode =
  | EvaluationDiagnosticCode
  | EvaluationSchemaRejectionCode
  | (typeof TECHNICAL_TRACE_REJECTION_CODES)[number]
  | Extract<
      QualityCheckRejectionCode,
      `score-${string}` | "quality-score-semantics" | "quality-score-validator-refused"
    >;

const EVALUATION_VALIDATOR = qualityExecutionResource("evaluation").path;
const SCORE_VALIDATOR = qualityExecutionResource("quality-score").path;
const EVALUATION_SCHEMA = "schemas/documentation-quality-evaluation.schema.json";
const REPORT_VALIDATOR = qualityExecutionResource("report-binding").path;
const PROFILE_PATH = "profiles/docsfab-documentation-quality/profile.json";
/** The rule module every spawn above imports; its digest is verified with each one's inputs (§1.2). */
const RULE_MODULE = qualityExecutionResource("decision-policy").path;
const RULE_IMPORT = qualityExecutionResource("decision-policy").moduleName!;
export const PROFILE_CEILING_LIMITATION =
  "The selected quality profile caps decisions at insufficient-evidence while it remains experimental.";
export const AUDIENCE_PREREQUISITES_LIMITATION =
  "The selected quality profile has pending human and agent outcome baselines.";
/** Contract version written by the host for quality-evaluation v2 responses. */
export const QUALITY_EVALUATION_VERSION = "1.0" as const;
const QUALITY_RECORD_POLICY_METADATA = `import json, ${RULE_IMPORT} as p
print(json.dumps({"constraintKeys": list(p.CONSTRAINT_KEYS), "d3ResidualDecisions": p.D3_RESIDUAL_DECISIONS}, separators=(",", ":")))`;
const QUALITY_RECORD_POLICY_CHECK = `import json, sys, ${RULE_IMPORT} as p
data=json.load(sys.stdin)
result=[]
for item in data["records"]:
    errors=p.check_record(item["type"], item["key"], item["record"], data["profile"])
    result.append({"toolCallId": item["toolCallId"], "status": "valid" if not errors else "refused"})
print(json.dumps(result, separators=(",", ":")))`;

export interface QualityAnswerRecordSessionInputV1 {
  readonly runId: string;
  readonly logicalRunId?: string;
  readonly sourceRunId?: string;
  readonly restoreSourceRunId?: string;
  readonly stepId: string;
  readonly attempt: number;
  readonly repositoryRevision: string;
  readonly evaluatorIdentitySha256: string;
  readonly compositionSha256: string;
  readonly answerPathCapabilitySha256: string;
  readonly evaluatorEvidence: EvaluateStepEvidenceV1;
  /** Admitted technical verification bound by the workflow runner. */
  readonly technicalVerification?: VerificationResult;
  readonly evaluatorProviderId: () => string | undefined;
  readonly references: Readonly<Record<string, unknown>>;
  readonly referenceIds: Readonly<Record<string, readonly string[]>>;
  readonly referenceSourceSha256s: Readonly<Record<string, string>>;
  readonly renderReference: (namespace: string, ids: readonly string[]) => readonly unknown[];
  readonly restoreCheckpoint?: {
    readonly record: AnswerRecordContinuationCheckpointEnvelopeV1;
    readonly sha256: string;
  };
  readonly onCheckpoint?: (
    checkpoint: AnswerRecordContinuationCheckpointEnvelopeV1,
    sha256: string,
    index: AnswerRecordLedgerIndexV1,
  ) => Promise<void>;
}

/** Fixed user-facing diagnostics; never include candidate content or host paths. */
export const QUALITY_ARTIFACT_FAILURES = {
  "candidate-invalid":
    "Quality validation rejected the evaluator's artifact format or metadata. Inspect the retained run before retrying; this result is not validated.",
  "target-scope-mismatch":
    "Quality validation failed because the staged evaluation target differs from the target the host bound and wrote for this run, which is a DocsFab defect. Report it with the retained run; this result is not validated.",
  "evaluation-invalid":
    "The quality evaluation did not satisfy the selected profile. Inspect the retained report and validation evidence; this result is not validated.",
  "quality-score-invalid":
    "The quality score failed validation. Inspect the retained report and score evidence; the score is not validated.",
  "report-binding-invalid":
    "The quality report does not match its evaluation or score artifacts. Inspect the retained run before retrying; this result is not validated.",
  "validator-unavailable":
    "A required quality validator could not run. Check the host's validator runtime and retry; quality validation is incomplete.",
  "validator-integrity-invalid":
    "The quality validator or its locked inputs failed integrity checks. Verify the installed quality pack before retrying; validation did not complete.",
  "artifact-integrity-invalid":
    "Quality artifacts could not be stored or verified safely. Inspect the private run and artifact storage before retrying; this result is not validated.",
  "technical-trace-incomplete":
    "The final quality evaluation dropped or changed admitted technical evidence. Inspect the retained verification result and evaluator artifact before retrying; this result is not validated.",
} as const satisfies Record<QualityArtifactValidationFailureCode, string>;

export class QualityArtifactValidationError extends Error {
  public constructor(
    public readonly code: QualityArtifactValidationFailureCode,
    public readonly binding: QualityArtifactValidationBindingV1,
    public readonly reportMarkdown: string,
    /** The check's inner reason as a closed code and location; never validator or model text. */
    public readonly rejection: QualityValidationRejectionV1,
  ) {
    super(`Quality artifact validation failed: ${code}.`);
    this.name = "QualityArtifactValidationError";
  }
}

/**
 * Validator stderr, held only in memory to classify a refusal. Keyed on the
 * sealed receipt so no receipt field changes.
 */
const validatorStderr = new WeakMap<QualityValidatorInvocationReceiptV1, string>();

export interface QualityValidationSuccess {
  binding: QualityArtifactValidationBindingV1;
  reportMarkdown: string;
}

export interface QualityValidationInput {
  runId: string;
  repositoryRevision: string;
  evaluatorIdentitySha256: string;
  evaluatorStepId: string;
  evaluatorAttempt: number;
  evaluatedAt: string;
  evaluatorProviderId?: string;
  candidate: QualityArtifactCandidateV1;
  technicalVerification?: VerificationResult;
  /** Host-owned records route selection; never derived from model candidate fields. */
  technicalFactTraceMode?: TechnicalFactTraceMode;
  /** Host-authored notes for any mechanical repair already applied to `candidate`. */
  confidenceAdjustments?: string[];
}

export interface QualityValidatorHostOptions {
  store: DurableArtifactStore;
  selection: SelectedDocumentationQualityProfile;
  evaluatedCandidate?: import("../records/contracts.js").QualityEvaluatedCandidateV1;
  temporaryRoot: string;
  /** Root whose saved run owns every staged quality object and receipt. */
  stateDirectory: string;
  /** Trusted host injection for deterministic missing-runtime coverage. */
  executable?: string;
  timeoutMs?: number;
  /** Explicit test-only records-route injection; production constructors omit it. */
  answerRecordsTestInjection?: boolean;
  /** Explicit CLI-selected unqualified discovery run; admission binds its provenance. */
  answerRecordsExperimentalDiscovery?: boolean;
}

export class QualityValidatorHost {
  private readonly executable: string;
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;

  public constructor(private readonly options: QualityValidatorHostOptions) {
    this.executable = options.executable ?? "python3";
    if (!this.executable || /[\0\r\n]/u.test(this.executable)) {
      throw new Error("The configured quality validator executable path is invalid.");
    }
    this.timeoutMs = options.timeoutMs ?? limit("qualityValidator.timeoutMs").value;
    if (
      !Number.isSafeInteger(this.timeoutMs) ||
      this.timeoutMs < 1 ||
      this.timeoutMs > limitDefinition("qualityValidator.timeoutMs").max
    ) {
      throw new Error("The configured quality validator timeout value is invalid.");
    }
    this.maxOutputBytes = limit("qualityValidator.maxOutputBytes").value;
  }

  /**
   * Derive the host-owned members of a quality evaluation with the locked
   * deriver (closed-schema-answer-records-decision.md §1.2, N14), through the
   * same locked python3 spawn the validators use. The derivation input holds
   * the assembled evaluation, the gate attribution from the records, and any
   * layer residuals; the caller writes it only after admission screened every
   * record (admission step 2), and it is screened again here.
   *
   * The deriver writes a private output file under the temporary root, never
   * stdout. It is read only when `lstat` shows a regular file of at most
   * `qualityValidator.maxDerivedArtifactBytes`, then strictly decoded; its
   * digest is in the receipt. Every failure is `quality-derivation-failed`, a
   * DocsFab defect that is never retried as model content.
   */
  /** Defaults off; this only permits explicit in-process test injection. */
  public get answerRecordsTestInjectionEnabled(): boolean {
    return this.options.answerRecordsTestInjection === true;
  }

  /** Enabled only by the explicit review-documentation discovery request. */
  public get answerRecordsExperimentalDiscoveryEnabled(): boolean {
    return this.options.answerRecordsExperimentalDiscovery === true;
  }

  /**
   * Create an attempt-scoped records authority. It is deliberately available
   * only to explicit in-process test injection until the records transport is
   * qualified; the harness receives the returned opaque capability, never
   * this host or its store.
   */
  public async createAnswerRecordSession(
    input: QualityAnswerRecordSessionInputV1,
  ): Promise<QualityAnswerRecordSessionV1> {
    if (
      !this.answerRecordsTestInjectionEnabled &&
      !this.answerRecordsExperimentalDiscoveryEnabled
    ) {
      throw hostCheckError("candidate-staging-integrity-failed");
    }
    if (input.evaluatorEvidence.evaluatorIdentitySha256 !== input.evaluatorIdentitySha256) {
      throw hostCheckError("candidate-host-binding-mismatch");
    }
    const qualityRoot = this.options.selection.pack.qualityRoot;
    const ruleSha256 = this.lockedQualityFile(RULE_MODULE);
    const profileSha256 = this.lockedQualityFile(PROFILE_PATH);
    const rulePath = qualityExecutionPath("decision-policy", "module", { qualityRoot });
    const profilePath = resolve(qualityRoot, PROFILE_PATH);
    await verifyRegularDigest(rulePath, ruleSha256);
    await verifyRegularDigest(profilePath, profileSha256);
    const policyResult = await runBoundedChild({
      executable: this.executable,
      args: ["-c", QUALITY_RECORD_POLICY_METADATA],
      cwd: resolve(qualityRoot, "checks"),
      timeoutMs: this.timeoutMs,
      maxOutputBytes: this.maxOutputBytes,
    });
    if (policyResult.outcome !== "passed" || policyResult.timedOut) {
      throw hostCheckError("candidate-staging-integrity-failed");
    }
    const policyMetadata = parseJsonEvidence(policyResult.stdout);
    if (
      !isRecord(policyMetadata) ||
      !Array.isArray(policyMetadata.constraintKeys) ||
      !Array.isArray(policyMetadata.d3ResidualDecisions) ||
      policyMetadata.constraintKeys.some((value) => typeof value !== "string") ||
      policyMetadata.d3ResidualDecisions.some((value) => typeof value !== "string")
    ) {
      throw hostCheckError("candidate-staging-integrity-failed");
    }
    const profile = this.options.selection.profile;
    const applicability = object(profile.applicability);
    const documentationSet = object(applicability.documentation_set);
    const dimensionsByLayer = object(documentationSet.required_dimensions_by_layer);
    const dimensionKeys = Object.entries(dimensionsByLayer).flatMap(([layer, dimensions]) => {
      if (!Array.isArray(dimensions) || dimensions.some((value) => typeof value !== "string")) {
        throw hostCheckError("candidate-staging-integrity-failed");
      }
      return (dimensions as string[]).map((key) => ({ key, slot: layer }));
    });
    const constraints = object(profile.constraints);
    const requiredConstraints = Array.isArray(constraints.required) ? constraints.required : [];
    const conditionalConstraints = Array.isArray(constraints.conditional)
      ? constraints.conditional
      : [];
    const constraintKeys = [...requiredConstraints, ...conditionalConstraints];
    if (
      constraintKeys.some((value) => typeof value !== "string") ||
      canonicalJson([...constraintKeys].sort()) !==
        canonicalJson([...(policyMetadata.constraintKeys as string[])].sort())
    ) {
      throw hostCheckError("validator-input-digest-changed");
    }
    const plannedRecords = planDocumentationQualityAnswerRecords({
      requiredDimensionsByLayer: dimensionsByLayer as Record<string, string[]>,
      requiredConstraints: requiredConstraints as string[],
      conditionalConstraints: conditionalConstraints as string[],
      // A completed set may still be corrected in a later discovery turn.
      enforceClosedSetAdmission: false,
    });
    // Discovery renews its execution lease without an aggregate call ceiling.
    // Keep the plan-derived refusal-diagnostic capacity: it describes the
    // bounded answer-record contract, not a shared reading-plus-record budget.
    const plan = plannedRecords;
    const confidenceAnchors = object(profile.confidence_anchors);
    const hardGateIds = profile.hard_gates;
    if (!Array.isArray(hardGateIds) || hardGateIds.some((value) => typeof value !== "string")) {
      throw hostCheckError("candidate-staging-integrity-failed");
    }
    const targetPaths = this.options.selection.evaluationTarget.map((entry) => entry.path);
    const referenceSourceSha256s = { ...input.referenceSourceSha256s };
    const canonicalSchemaEntries = Object.entries(
      OUTPUT_RECORD_CONTRACTS["quality-evaluation"].canonical.members,
    ).map(([memberName, declaredPath]) => {
      const qualityPrefix = "packages/quality/";
      if (!declaredPath.startsWith(qualityPrefix)) {
        throw hostCheckError("validator-lock-entry-missing");
      }
      const path = declaredPath.slice(qualityPrefix.length);
      return { memberName, path, sha256: this.lockedQualityFile(path) };
    });
    const canonicalSchemaSha256s = Object.fromEntries(
      canonicalSchemaEntries.map(({ memberName, sha256 }) => [memberName, sha256]),
    );
    for (const { path, sha256 } of canonicalSchemaEntries) {
      await verifyRegularDigest(resolve(qualityRoot, path), sha256);
    }
    const bindings: QualityAnswerRecordBindingsV1 = {
      runId: input.logicalRunId ?? input.runId,
      stepId: input.stepId,
      attempt: input.attempt,
      declarationSha256: canonicalDigest(OUTPUT_RECORD_CONTRACTS["quality-evaluation"]),
      schemaSha256s: { ...canonicalSchemaSha256s, qualityPolicy: ruleSha256 },
      profilePayloadSha256: profileSha256,
      selectionSha256: this.options.selection.receipt.selectionSha256,
      referenceSourceSha256s,
      evaluatorIdentitySha256: input.evaluatorIdentitySha256,
      compositionSha256: input.compositionSha256,
      answerPathCapabilitySha256: input.answerPathCapabilitySha256,
    };
    const hostMinted: HostMintedValues = {
      "run.step-attempt-id": `${input.logicalRunId ?? input.runId}:${input.stepId}:${input.attempt}`,
      "contract.evaluation-version": QUALITY_EVALUATION_VERSION,
      "host.clock-at-assembly": () => new Date().toISOString(),
      "selection-receipt.profileModel": this.options.selection.receipt.profileModel,
      "selection-receipt.profile": {
        id: this.options.selection.receipt.profileId,
        version: this.options.selection.receipt.profileVersion,
      },
      "evaluate-step-evidence": () => {
        const providerId = input.evaluatorProviderId();
        if (!providerId) throw hostCheckError("candidate-host-binding-mismatch");
        return {
          provider_id: providerId,
          provider_type: "agent",
          independent_of_authors: false,
          independence_evidence:
            "The host bound the configured evaluator identity, but no author-independence evidence was admitted.",
        };
      },
      "selection-receipt.scopeType": this.options.selection.receipt.targetScope,
      "quality-evaluation-target": (field: string) =>
        field.endsWith("delivery_surface_locator")
          ? describeEvaluationTarget(this.options.selection.evaluationTarget)
          : targetPaths,
      "selection-receipt.repositoryRevision": this.options.selection.receipt.repositoryRevision,
      "workflow.finding-owner": "documentation-owner",
      "workflow.finding-status": "open",
    };
    const qualityPolicySha256 = ruleSha256;
    const session = createQualityAnswerRecordAdmission({
      store: this.options.store,
      declaration: OUTPUT_RECORD_CONTRACTS["quality-evaluation"],
      bindings,
      plan,
      nonExhaustingRefusals: this.answerRecordsExperimentalDiscoveryEnabled,
      ...(input.sourceRunId ? { sourceRunId: input.sourceRunId } : {}),
      ...(input.restoreSourceRunId ? { restoreSourceRunId: input.restoreSourceRunId } : {}),
      ...(input.restoreCheckpoint ? { restoreCheckpoint: input.restoreCheckpoint.record } : {}),
      hostMinted,
      references: input.references,
      referenceIds: input.referenceIds,
      renderReference: input.renderReference,
      ...(input.onCheckpoint ? { onCheckpoint: input.onCheckpoint } : {}),
      recordNarrowing: {
        profilePayloadSha256: profileSha256,
        selectionSha256: this.options.selection.receipt.selectionSha256,
        qualityPolicySha256,
        requiredDimensionIds: dimensionKeys.map((entry) => entry.key),
        hardGateIds: hardGateIds as string[],
        confidenceAnchors: Object.keys(confidenceAnchors)
          .map(Number)
          .filter((value) => Number.isFinite(value) && value >= 0 && value < 1),
        d3ResidualDecisions: policyMetadata.d3ResidualDecisions as string[],
        qualityEvaluationTargetPaths: targetPaths,
      },
      validateRecords: async (records) => {
        await verifyRegularDigest(rulePath, ruleSha256);
        await verifyRegularDigest(profilePath, profileSha256);
        const data = Buffer.from(canonicalJson({ records, profile }), "utf8");
        const checked = await runBoundedChild({
          executable: this.executable,
          args: ["-c", QUALITY_RECORD_POLICY_CHECK],
          cwd: resolve(qualityRoot, "checks"),
          timeoutMs: this.timeoutMs,
          maxOutputBytes: this.maxOutputBytes,
          stdin: data,
        });
        if (checked.outcome === "unavailable" || checked.timedOut || checked.outcome !== "passed") {
          throw hostCheckError("candidate-staging-integrity-failed");
        }
        const output = parseJsonEvidence(checked.stdout);
        if (!Array.isArray(output) || output.length !== records.length) {
          throw hostCheckError("candidate-staging-integrity-failed");
        }
        return output.map((item, index) => {
          if (
            !isRecord(item) ||
            item.toolCallId !== records[index]!.toolCallId ||
            (item.status !== "valid" && item.status !== "refused")
          ) {
            throw hostCheckError("candidate-staging-integrity-failed");
          }
          return item.status === "valid"
            ? { toolCallId: String(item.toolCallId), status: "valid" as const }
            : {
                toolCallId: String(item.toolCallId),
                status: "refused" as const,
                code: "evaluation-profile-semantics" as QualityAnswerRecordOutputCode,
                location: "$",
              };
        });
      },
      derive: async (draft) => {
        const gateAttribution: Record<string, readonly string[]> = {};
        const layerShortfallDecisions: Record<string, string> = {};
        for (const record of draft.records) {
          if (!isRecord(record.payload)) continue;
          if (record.type === "dimension" && Array.isArray(record.payload.hard_gate_failures)) {
            gateAttribution[record.key] = record.payload.hard_gate_failures as string[];
          }
          if (
            record.type === "layer-note" &&
            typeof record.payload.layer_shortfall_decision === "string"
          ) {
            layerShortfallDecisions[record.key] = record.payload.layer_shortfall_decision;
          }
        }
        const derived = await this.derive({
          schemaVersion: 1,
          kind: "docsfab-quality-derivation-input",
          evaluation: draft.artifact.evaluation as Record<string, unknown>,
          qualityScore: draft.artifact.qualityScore as Record<string, unknown> | null,
          gateAttribution,
          layerShortfallDecisions,
        });
        if (derived.status === "open") return { status: "open", open: derived.openLayers };
        const technicalHostLimitations = technicalInventoryHostLimitations(
          input.technicalVerification,
        );
        return {
          status: "derived",
          artifact: {
            ...draft.artifact,
            evaluation: derived.evaluation,
            qualityScore: derived.qualityScore,
          },
          hostParts: {
            "quality:host-limitations": [
              ...new Set([...derived.hostLimitations, ...technicalHostLimitations]),
            ],
            "quality:coherence-labels": derived.coherenceLabels,
          },
        };
      },
      validateCompletion: async ({ evaluation, qualityScore, closingToolCallId, records }) => {
        const result = await this.validateAnswerRecordCompletion({ evaluation, qualityScore });
        if (result.status === "valid" && input.technicalVerification) {
          const trace = inspectTechnicalFactTrace(
            evaluation,
            input.technicalVerification,
            "records",
          );
          if (trace.status === "invalid") {
            const rejection = technicalTraceRejection(trace);
            const missingFactIds = [
              ...new Set(
                trace.violations
                  .filter((violation) => violation.code === "missing-fact-id" && violation.factId)
                  .map((violation) => violation.factId!),
              ),
            ];
            const feedback =
              rejection.code === "technical-trace-missing-fact-id"
                ? `Host validation refused completion because these admitted not-documented technical fact IDs have no record-mode finding link: ${missingFactIds.join(", ")}. Submit or replace finding records whose record.originating_ids include these missing admitted FACT IDs. The host adds the corresponding admitted technical-fact evidence; mentioning an ID in finding prose alone does not establish the required link.`
                : `Host technical-trace validation failed (${rejection.code}); the completion was not accepted because the admitted host verification could not be represented safely.`;
            return {
              status: "refused",
              code: rejection.code as LockedQualityCompletionRefusalCode,
              location: rejection.location,
              feedback,
              owner:
                rejection.code === "technical-trace-missing-fact-id"
                  ? closingToolCallId
                    ? { kind: "tool-call", toolCallId: closingToolCallId }
                    : { kind: "record", type: "evaluation-note", key: "singleton" }
                  : answerRecordValidationOwner(
                      rejection.location,
                      records,
                      dimensionKeys,
                      closingToolCallId,
                    ),
            };
          }
        }
        return result.status === "valid"
          ? result
          : {
              ...result,
              owner: answerRecordValidationOwner(
                result.location,
                records,
                dimensionKeys,
                closingToolCallId,
              ),
            };
      },
    });
    if (input.restoreCheckpoint) await session.restoreCheckpoint(input.restoreCheckpoint);
    return this.answerRecordsExperimentalDiscoveryEnabled
      ? {
          ...session,
          sharedToolCallCapacity: true,
          experimentalAnswerRecordDiscoveryRenewal: true,
        }
      : session;
  }

  /** Run the unchanged locked evaluation/schema/score checks before a record
   * completion receipt authorizes the closing call. Nothing is staged in the
   * durable artifact store here; the runner later performs its ordinary final
   * validation and evidence binding after the complete report is available. */
  public async validateAnswerRecordCompletion(input: {
    readonly evaluation: Record<string, unknown>;
    readonly qualityScore: Record<string, unknown> | null;
  }): Promise<
    | { readonly status: "valid" }
    | {
        readonly status: "refused";
        readonly code: LockedQualityCompletionRefusalCode;
        readonly location: string;
      }
  > {
    const directory = resolve(
      this.options.temporaryRoot,
      `quality-record-completion-${randomUUID()}`,
    );
    let primaryError: unknown;
    try {
      await ensurePrivateDirectory(this.options.temporaryRoot);
      await mkdir(directory, { recursive: false, mode: 0o700 });
      const evaluationPath = resolve(directory, "evaluation.json");
      await writePrivate(evaluationPath, Buffer.from(canonicalJson(input.evaluation), "utf8"));
      const evaluation = await this.runValidator({
        validator: "evaluation",
        scriptPath: resolve(this.options.selection.pack.qualityRoot, EVALUATION_VALIDATOR),
        expectedScriptSha256: this.lockedQualityFile(EVALUATION_VALIDATOR),
        args: [
          evaluationPath,
          "--schema",
          resolve(this.options.selection.pack.qualityRoot, EVALUATION_SCHEMA),
          "--profile",
          resolve(this.options.selection.pack.qualityRoot, PROFILE_PATH),
        ],
        inputs: [
          [evaluationPath, sha256(Buffer.from(canonicalJson(input.evaluation), "utf8"))],
          [
            resolve(this.options.selection.pack.qualityRoot, EVALUATION_SCHEMA),
            this.lockedQualityFile(EVALUATION_SCHEMA),
          ],
          [
            resolve(this.options.selection.pack.qualityRoot, PROFILE_PATH),
            this.lockedQualityFile(PROFILE_PATH),
          ],
        ],
        modules: [this.ruleModule()],
        cwd: directory,
      });
      if (evaluation.outcome === "unavailable") {
        throw hostCheckError("evaluation-validator-unavailable");
      }
      if (evaluation.outcome !== "passed") {
        const rejection = projectEvaluationValidatorRejection({
          stderr: validatorStderr.get(evaluation) ?? "",
          payload: input.evaluation,
        });
        if (!isLockedQualityCompletionRefusalCode(rejection.code)) {
          throw hostCheckError("candidate-staging-integrity-failed");
        }
        return {
          status: "refused",
          code: rejection.code,
          location: rejection.location,
        };
      }
      if (input.qualityScore !== null) {
        const scorePath = resolve(directory, "quality-score.json");
        const scoreBytes = Buffer.from(canonicalJson(input.qualityScore), "utf8");
        await writePrivate(scorePath, scoreBytes);
        const score = await this.runValidator({
          validator: "quality-score",
          scriptPath: resolve(this.options.selection.pack.qualityRoot, SCORE_VALIDATOR),
          expectedScriptSha256: this.lockedQualityFile(SCORE_VALIDATOR),
          args: [scorePath],
          inputs: [[scorePath, sha256(scoreBytes)]],
          modules: [this.ruleModule()],
          cwd: directory,
        });
        if (score.outcome === "unavailable") {
          throw hostCheckError("quality-score-validator-unavailable");
        }
        if (score.outcome !== "passed") {
          const rejection = projectLockedValidatorRejection({
            validator: "quality-score",
            stderr: validatorStderr.get(score) ?? "",
          });
          if (!isLockedQualityCompletionRefusalCode(rejection.code)) {
            throw hostCheckError("candidate-staging-integrity-failed");
          }
          return {
            status: "refused",
            code: rejection.code,
            location: rejection.location,
          };
        }
      }
      return { status: "valid" };
    } catch (error) {
      primaryError = error;
      throw error instanceof QualityHostCheckError
        ? error
        : hostCheckError("candidate-staging-integrity-failed");
    } finally {
      try {
        await rm(directory, { recursive: true, force: true });
      } catch {
        if (primaryError === undefined) {
          throw hostCheckError("candidate-staging-integrity-failed");
        }
      }
    }
  }

  public async derive(derivationInput: QualityDerivationInputV1): Promise<QualityDerivationV1> {
    return await deriveQuality(derivationInput, {
      qualityRoot: this.options.selection.pack.qualityRoot,
      temporaryRoot: this.options.temporaryRoot,
      qualityFiles: this.options.selection.pack.qualityLock.files,
      executable: this.executable,
      timeoutMs: this.timeoutMs,
      maxOutputBytes: this.maxOutputBytes,
    });
  }

  public async validate(input: QualityValidationInput): Promise<QualityValidationSuccess> {
    const { ensurePrivateRunDirectory } = await import("../records/file-store.js");
    await ensurePrivateRunDirectory(this.options.stateDirectory);
    const { assertRunNotTombstoned, withActiveRunGate } = await import(
      "../records/run-maintenance-gate.js"
    );
    return withActiveRunGate(this.options.stateDirectory, input.runId, async () => {
      await assertRunNotTombstoned(this.options.stateDirectory, input.runId);
      return this.validateUnderGate(input);
    });
  }

  private async validateUnderGate(
    input: QualityValidationInput,
  ): Promise<QualityValidationSuccess> {
    if (input.candidate.answerPath && !input.evaluatorProviderId) {
      throw qualityCandidateAdmissionError(
        "quality-evaluator-identity-unbound",
        "The host cannot bind the configured evaluator provider for this full-artifact answer.",
      );
    }
    const bindings: QualityArtifactBindings = {
      runId: input.runId,
      repositoryRevision: input.repositoryRevision,
      selectionSha256: this.options.selection.receipt.selectionSha256,
      evaluatorIdentitySha256: input.evaluatorIdentitySha256,
      qualityPackBindingSha256: this.options.selection.receipt.qualityPackBindingSha256,
    };
    let reportMarkdown = "";
    let validatorAssets: QualityArtifactValidationBindingV1["validatorAssets"];
    try {
      validatorAssets = this.validatorAssets();
    } catch (error) {
      // No binding can be sealed without the locked validator digests, so this
      // refusal carries its coded reason on a step error instead.
      throw new QualityStepRejectionError(
        hostCheckRejection(
          "candidate-staging",
          error instanceof QualityHostCheckError
            ? error.code
            : QUALITY_CHECK_INTEGRITY_CODES["candidate-staging"],
        ),
        "The quality validators are absent from the verified quality pack lock.",
      );
    }
    const hostAdjustments = [...(input.confidenceAdjustments ?? [])];
    let hostDerivationCounts: QualityHostDerivationCountsV1 | undefined;
    let staged: StagedQualityCandidate;
    try {
      reportMarkdown = preflightQualityArtifactCandidateContent(input.candidate);
      // The host owns the target: once the candidate is proven inert, it writes
      // the bound scope, and staging checks exactly that value.
      const target = fillEvaluationTarget(
        input.candidate,
        this.options.selection.evaluationTarget,
        this.options.selection.documentationPaths,
      );
      if (target.limitation) hostAdjustments.push(target.limitation);
      const derivation = await this.deriveFullArtifactCandidate(target.candidate, hostAdjustments, {
        runId: input.runId,
        repositoryRevision: input.repositoryRevision,
        evaluatorStepId: input.evaluatorStepId,
        evaluatorAttempt: input.evaluatorAttempt,
        evaluatedAt: input.evaluatedAt,
        ...(input.evaluatorProviderId ? { evaluatorProviderId: input.evaluatorProviderId } : {}),
      });
      hostDerivationCounts = derivation.hostDerivationCounts;
      staged = await stageQualityArtifactCandidate({
        store: this.options.store,
        // Admitted fact locators are carried before the artifact is staged and bound.
        candidate: carryAdmittedTechnicalLocators(
          derivation.candidate,
          input.technicalVerification,
          input.technicalFactTraceMode ?? "text",
        ),
        selection: this.options.selection,
        bindings,
      });
    } catch (error) {
      // Derivation failures are a distinct terminal DocsFab fault with their
      // own closed reason. They have no validation binding schema slot and
      // must not be folded into a generic artifact-integrity refusal.
      if (error instanceof QualityDerivationError) throw error;
      const correctableRejection =
        error instanceof QualityStepRejectionError ? error.rejection : undefined;
      const code =
        error instanceof QualityArtifactStagingError
          ? error.code
          : correctableRejection
            ? ("evaluation-invalid" as const)
            : ("artifact-integrity-invalid" as const);
      let rejection =
        correctableRejection ??
        hostCheckRejection("candidate-staging", hostCheckCodeOf(error, "candidate-staging"));
      let binding = sealQualityValidationBinding({
        ...(this.options.evaluatedCandidate
          ? { evaluatedCandidate: this.options.evaluatedCandidate }
          : {}),
        ...bindings,
        status: "failed",
        failureCode: code,
        artifacts: {
          evaluation: null,
          qualityScore: null,
          candidateReport: null,
          finalReport: null,
        },
        validatorAssets,
        validators: {
          evaluation: null,
          qualityScore: null,
          reportBinding: null,
        },
        ...(hostDerivationCounts ? { hostDerivationCounts } : {}),
      });
      try {
        await this.options.store.putRecord(binding.bindingSha256, binding);
        await this.options.store.getRecord(binding.bindingSha256);
      } catch {
        binding = sealQualityValidationBinding({
          ...(this.options.evaluatedCandidate
            ? { evaluatedCandidate: this.options.evaluatedCandidate }
            : {}),
          ...bindings,
          status: "failed",
          failureCode: "artifact-integrity-invalid",
          artifacts: {
            evaluation: null,
            qualityScore: null,
            candidateReport: null,
            finalReport: null,
          },
          validatorAssets,
          validators: {
            evaluation: null,
            qualityScore: null,
            reportBinding: null,
          },
          ...(hostDerivationCounts ? { hostDerivationCounts } : {}),
        });
        rejection = hostCheckRejection("binding-storage", "validation-binding-unstored");
      }
      throw new QualityArtifactValidationError(
        binding.failureCode!,
        binding,
        reportMarkdown,
        rejection,
      );
    }
    const receipts: {
      evaluation?: QualityValidatorInvocationReceiptV1;
      score?: QualityValidatorInvocationReceiptV1;
      report?: QualityValidatorInvocationReceiptV1;
    } = {};
    let finalReport: StagedQualityArtifact | null = null;
    // The check running now, so an unexpected fault is coded by where it happened.
    let phase: QualityHostPhase = "evaluation";
    const privateDirectory = resolve(this.options.temporaryRoot, `quality-${randomUUID()}`);
    try {
      await ensurePrivateDirectory(this.options.temporaryRoot);
      await mkdir(privateDirectory, { recursive: false, mode: 0o700 });
      const paths = await this.materialize(privateDirectory, staged);
      receipts.evaluation = await this.runValidator({
        validator: "evaluation",
        scriptPath: resolve(this.options.selection.pack.qualityRoot, EVALUATION_VALIDATOR),
        expectedScriptSha256: this.lockedQualityFile(EVALUATION_VALIDATOR),
        args: [
          paths.evaluation,
          "--schema",
          resolve(this.options.selection.pack.qualityRoot, EVALUATION_SCHEMA),
          "--profile",
          resolve(this.options.selection.pack.qualityRoot, PROFILE_PATH),
        ],
        inputs: [
          [paths.evaluation, staged.evaluation.binding.payloadSha256],
          [
            resolve(this.options.selection.pack.qualityRoot, EVALUATION_SCHEMA),
            this.lockedQualityFile(EVALUATION_SCHEMA),
          ],
          [
            resolve(this.options.selection.pack.qualityRoot, PROFILE_PATH),
            this.lockedQualityFile(PROFILE_PATH),
          ],
        ],
        modules: [this.ruleModule()],
        cwd: privateDirectory,
      });
      await this.persistReceipt(receipts.evaluation);
      if (receipts.evaluation.outcome !== "passed") {
        await this.reject(
          receipts.evaluation.outcome,
          "evaluation-invalid",
          staged,
          receipts,
          null,
          reportMarkdown,
          bindings,
          projectEvaluationValidatorRejection({
            stderr: validatorStderr.get(receipts.evaluation) ?? "",
            payload: staged.evaluation.record.payload,
          }),
          hostDerivationCounts,
        );
      }
      phase = "technical-trace";
      try {
        assertTechnicalFactTrace(
          staged.evaluation.record.payload,
          input.technicalVerification,
          input.technicalFactTraceMode ?? "text",
        );
      } catch (error) {
        await this.reject(
          "failed",
          error instanceof QualityArtifactStagingError ? error.code : "artifact-integrity-invalid",
          staged,
          receipts,
          null,
          reportMarkdown,
          bindings,
          technicalTraceRejection(
            inspectTechnicalFactTrace(
              staged.evaluation.record.payload,
              input.technicalVerification,
              input.technicalFactTraceMode ?? "text",
            ),
          ),
          hostDerivationCounts,
        );
      }

      if (staged.qualityScore) {
        phase = "quality-score";
        receipts.score = await this.runValidator({
          validator: "quality-score",
          scriptPath: resolve(this.options.selection.pack.qualityRoot, SCORE_VALIDATOR),
          expectedScriptSha256: this.lockedQualityFile(SCORE_VALIDATOR),
          args: [paths.qualityScore!],
          inputs: [[paths.qualityScore!, staged.qualityScore.binding.payloadSha256]],
          modules: [this.ruleModule()],
          cwd: privateDirectory,
        });
        await this.persistReceipt(receipts.score);
        if (receipts.score.outcome !== "passed") {
          await this.reject(
            receipts.score.outcome,
            "quality-score-invalid",
            staged,
            receipts,
            null,
            reportMarkdown,
            bindings,
            projectLockedValidatorRejection({
              validator: "quality-score",
              stderr: validatorStderr.get(receipts.score) ?? "",
            }),
            hostDerivationCounts,
          );
        }
      }

      phase = "report-finalization";
      let finalizedMarkdown = "";
      try {
        finalizedMarkdown = await this.finalizeReport(
          staged,
          bindings,
          hostAdjustments,
          input.technicalFactTraceMode === "records"
            ? technicalInventoryHostLimitations(input.technicalVerification)
            : [],
        );
      } catch (error) {
        await this.reject(
          "failed",
          "report-binding-invalid",
          staged,
          receipts,
          null,
          reportMarkdown,
          bindings,
          hostCheckRejection("report-finalization", hostCheckCodeOf(error, phase)),
          hostDerivationCounts,
        );
      }
      phase = "report-binding";
      const finalizedPath = resolve(privateDirectory, "quality-report.final.md");
      await writePrivate(finalizedPath, Buffer.from(finalizedMarkdown, "utf8"));
      receipts.report = await this.runValidator({
        validator: "report-binding",
        scriptPath: resolve(
          this.options.selection.pack.skillCrateRoot,
          "evaluate-document-quality",
          REPORT_VALIDATOR,
        ),
        expectedScriptSha256: this.lockedSkillFile("evaluate-document-quality", REPORT_VALIDATOR),
        args: [
          paths.evaluation,
          finalizedPath,
          "--profile",
          resolve(this.options.selection.pack.qualityRoot, PROFILE_PATH),
          ...(paths.qualityScore ? ["--quality-score", paths.qualityScore] : []),
        ],
        inputs: [
          [paths.evaluation, staged.evaluation.binding.payloadSha256],
          [finalizedPath, sha256(Buffer.from(finalizedMarkdown, "utf8"))],
          [
            resolve(this.options.selection.pack.qualityRoot, PROFILE_PATH),
            this.lockedQualityFile(PROFILE_PATH),
          ],
          ...(paths.qualityScore && staged.qualityScore
            ? ([[paths.qualityScore, staged.qualityScore.binding.payloadSha256]] as Array<
                [string, string]
              >)
            : []),
        ],
        // The skill's report validator loads the quality check that imports it.
        modules: [this.ruleModule()],
        cwd: privateDirectory,
      });
      await this.persistReceipt(receipts.report);
      if (receipts.report.outcome !== "passed") {
        await this.reject(
          receipts.report.outcome,
          "report-binding-invalid",
          staged,
          receipts,
          null,
          reportMarkdown,
          bindings,
          projectLockedValidatorRejection({
            validator: "report-binding",
            stderr: validatorStderr.get(receipts.report) ?? "",
          }),
          hostDerivationCounts,
        );
      }
      phase = "final-report-staging";
      finalReport = await stageFinalQualityReport({
        store: this.options.store,
        reportMarkdown: finalizedMarkdown,
        bindings,
      });
      phase = "binding-storage";
      const binding = sealQualityValidationBinding({
        ...(this.options.evaluatedCandidate
          ? { evaluatedCandidate: this.options.evaluatedCandidate }
          : {}),
        ...bindings,
        status: "passed",
        failureCode: null,
        artifacts: artifactBindings(staged, finalReport),
        validatorAssets,
        validators: receiptBindings(receipts),
        ...(hostDerivationCounts ? { hostDerivationCounts } : {}),
      });
      await this.options.store.putRecord(binding.bindingSha256, binding);
      return { binding, reportMarkdown: finalizedMarkdown };
    } catch (error) {
      if (error instanceof QualityArtifactValidationError) throw error;
      return await this.reject(
        "failed",
        error instanceof QualityArtifactStagingError
          ? "artifact-integrity-invalid"
          : "validator-integrity-invalid",
        staged,
        receipts,
        finalReport,
        reportMarkdown,
        bindings,
        hostCheckRejection(phase, hostCheckCodeOf(error, phase)),
        hostDerivationCounts,
      );
    } finally {
      await rm(privateDirectory, { recursive: true, force: true });
    }
  }

  /**
   * Apply the same locked derivation to both full-artifact transports. The
   * answer-path marker is admission-only metadata and is stripped before the
   * canonical candidate reaches staging.
   */
  private async deriveFullArtifactCandidate(
    candidate: QualityArtifactCandidateV1,
    hostAdjustments: string[],
    trusted: {
      readonly runId: string;
      readonly repositoryRevision: string;
      readonly evaluatorStepId: string;
      readonly evaluatorAttempt: number;
      readonly evaluatedAt: string;
      readonly evaluatorProviderId?: string;
    },
  ): Promise<{
    candidate: QualityArtifactCandidateV1;
    hostDerivationCounts?: QualityHostDerivationCountsV1;
  }> {
    if (!candidate.answerPath) return { candidate };
    const prepared = prepareFullArtifactDerivation(
      candidate,
      trusted,
      {
        targetScope: this.options.selection.receipt.targetScope,
        evaluationTarget: this.options.selection.evaluationTarget,
        profileModel: this.options.selection.receipt.profileModel,
        profileId: this.options.selection.receipt.profileId,
        profileVersion: this.options.selection.receipt.profileVersion,
        profileConstraints: this.options.selection.profile.constraints,
        profileApplicability: this.options.selection.profile.applicability,
      },
      QUALITY_EVALUATION_VERSION,
    );
    if (prepared.kind === "staging") return { candidate: prepared.candidate };

    const derived = await this.derive(prepared.derivationInput);
    if (derived.status === "open") {
      const layerId = derived.openLayers.find((openLayer) => {
        const layer = prepared.modelLayers[openLayer];
        const decision = layer && typeof layer === "object" ? object(layer).decision : undefined;
        return decision !== "fail" && decision !== "human-review";
      });
      if (layerId) {
        const outputRejection = rejectOutput(
          "evaluation-layer-residual-invalid",
          "$.evaluation.layers",
        );
        throw new QualityStepRejectionError(
          {
            validator: "candidate-staging",
            code: outputRejection.code,
            location: outputRejection.location,
            issueCount: 1,
          },
          "The evaluator's layer decision is not an allowed residual for an open layer.",
        );
      }
      throw derivationFailure("output-contract");
    }

    const projected = projectFullArtifactDerivation(prepared, derived);
    hostAdjustments.push(...projected.adjustments);
    return {
      candidate: projected.candidate,
      hostDerivationCounts: projected.hostDerivationCounts,
    };
  }

  private async materialize(
    directory: string,
    staged: StagedQualityCandidate,
  ): Promise<{ evaluation: string; qualityScore: string | null }> {
    const evaluation = await loadStagedQualityArtifact(
      this.options.store,
      staged.evaluation.binding.recordSha256,
    );
    const evaluationPath = resolve(directory, "evaluation.json");
    await writePrivate(evaluationPath, Buffer.from(canonicalJson(evaluation.payload), "utf8"));
    let qualityScorePath: string | null = null;
    if (staged.qualityScore) {
      const score = await loadStagedQualityArtifact(
        this.options.store,
        staged.qualityScore.binding.recordSha256,
      );
      qualityScorePath = resolve(directory, "quality-score.json");
      await writePrivate(qualityScorePath, Buffer.from(canonicalJson(score.payload), "utf8"));
    }
    return { evaluation: evaluationPath, qualityScore: qualityScorePath };
  }

  private async finalizeReport(
    staged: StagedQualityCandidate,
    bindings: QualityArtifactBindings,
    confidenceAdjustments: string[],
    technicalHostLimitations: readonly string[],
  ): Promise<string> {
    const evaluationRecord = await loadStagedQualityArtifact(
      this.options.store,
      staged.evaluation.binding.recordSha256,
    );
    const evaluation = object(evaluationRecord.payload);
    const target = object(evaluation.target);
    const profile = object(evaluation.profile);
    const scoreRecord = staged.qualityScore
      ? await loadStagedQualityArtifact(
          this.options.store,
          staged.qualityScore.binding.recordSha256,
        )
      : null;
    const score = scoreRecord ? object(scoreRecord.payload) : null;
    const rubric = score
      ? await this.projectRubric(score)
      : {
          status: "unavailable" as const,
          reason: "No unambiguous content-type rubric was selected from the retained evidence.",
        };
    const profilePath = resolve(this.options.selection.pack.qualityRoot, PROFILE_PATH);
    const profileBytes = await readFile(profilePath);
    const profileArtifactSha256 = this.lockedQualityFile(PROFILE_PATH);
    if (sha256(profileBytes) !== profileArtifactSha256) {
      throw hostCheckError("report-profile-bytes-changed");
    }
    const profileArtifact = object(JSON.parse(profileBytes.toString("utf8")) as unknown);
    if (profileArtifact.id !== profile.id || profileArtifact.version !== profile.version) {
      throw hostCheckError("report-profile-identity-mismatch");
    }
    const retainedGapEvidence: Record<string, unknown>[] = [];
    const deterministicLimitations: string[] = [...confidenceAdjustments];
    const decisionPolicy = object(profileArtifact.decision_policy);
    if (
      evaluation.overall_decision === "insufficient-evidence" &&
      profileArtifact.status === "experimental" &&
      profileArtifact.release_gate_eligible === false &&
      decisionPolicy.experimental_profile_maximum_decision === "insufficient-evidence"
    ) {
      deterministicLimitations.push(PROFILE_CEILING_LIMITATION);
      retainedGapEvidence.push({
        limitation: PROFILE_CEILING_LIMITATION,
        reason: "experimental-profile-ceiling",
        evidence: {
          kind: "profile-decision-policy",
          artifact_locator: PROFILE_PATH,
          artifact_sha256: profileArtifactSha256,
          profile_id: profile.id,
          profile_version: profile.version,
          profile_status: "experimental",
          release_gate_eligible: false,
          decision_policy_field: "experimental_profile_maximum_decision",
          decision_policy_value: "insufficient-evidence",
        },
      });
    }
    const calibration = object(profileArtifact.calibration);
    if (
      calibration.human_outcome_baseline === "pending" &&
      calibration.agent_outcome_baseline === "pending"
    ) {
      deterministicLimitations.push(AUDIENCE_PREREQUISITES_LIMITATION);
      retainedGapEvidence.push({
        limitation: AUDIENCE_PREREQUISITES_LIMITATION,
        reason: "audience-prerequisites-missing",
        evidence: {
          kind: "audience-prerequisite-policy",
          artifact_locator: PROFILE_PATH,
          artifact_sha256: profileArtifactSha256,
          profile_id: profile.id,
          profile_version: profile.version,
          prerequisites: [
            { field: "calibration.human_outcome_baseline", value: "pending" },
            { field: "calibration.agent_outcome_baseline", value: "pending" },
          ],
        },
      });
    }
    const summaryBase = {
      report_contract: "docsfab-quality-report-v0.2",
      target: {
        paths: target.paths,
        repository_revision: target.repository_revision,
        documentation_revision: target.documentation_revision,
      },
      profile: { id: profile.id, version: profile.version },
      evaluation: {
        decision: evaluation.overall_decision,
        confidence: evaluation.confidence,
        hard_gate_failures: evaluation.hard_gate_failures,
      },
      rubric,
      validation: {
        evaluation: "passed",
        quality_score: score ? "passed" : "unavailable",
        report_binding: "passed",
      },
      artifact_locators: {
        evaluation: `record:sha256:${staged.evaluation.binding.recordSha256}`,
        quality_score: staged.qualityScore
          ? `record:sha256:${staged.qualityScore.binding.recordSha256}`
          : null,
        quality_report: `run:${bindings.runId}:evaluate-document-quality:quality-report`,
      },
    };
    const reportPayload = staged.candidateReport.record.payload;
    if (typeof reportPayload !== "string") {
      throw hostCheckError("report-candidate-not-text");
    }
    const candidate = appendHostLimitations(reportPayload, [
      ...new Set([
        ...(this.options.selection.discoveryLimitations ?? []),
        ...deterministicLimitations,
        ...technicalHostLimitations,
      ]),
    ]);
    const summary = {
      ...summaryBase,
      limitations: extractExactLimitations(candidate),
      retained_gap_evidence: retainedGapEvidence,
    };
    const block = [
      "## Validated result summary",
      "",
      "```json",
      JSON.stringify(summary),
      "```",
    ].join("\n");
    const pattern = /^## Validated result summary\s+.*?^```json\s*$\n\{.*?\}\n^```\s*$/gimsu;
    const matches = [...candidate.matchAll(pattern)];
    if (matches.length > 1) {
      throw hostCheckError("report-summary-repeated");
    }
    return matches.length === 1
      ? `${candidate.slice(0, matches[0]!.index)}${block}${candidate.slice(matches[0]!.index! + matches[0]![0].length)}`
      : `${candidate.trimEnd()}\n\n${block}\n`;
  }

  private async projectRubric(score: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (typeof score.rubric !== "string") {
      throw hostCheckError("report-rubric-id-invalid");
    }
    const bar = this.options.selection.pack.qualityLock.bars.find(
      (candidate) => candidate.id === `rubric:${score.rubric}` && candidate.kind === "rubric",
    );
    if (!bar) throw hostCheckError("report-rubric-not-locked");
    const expected = this.lockedQualityFile(bar.assetPath);
    const path = resolve(this.options.selection.pack.qualityRoot, bar.assetPath);
    const bytes = await readFile(path);
    if (sha256(bytes) !== expected) {
      throw hostCheckError("report-rubric-bytes-changed");
    }
    const rubric = object(parseYaml(bytes.toString("utf8")));
    if (rubric.id !== score.rubric || typeof rubric.pass_threshold !== "number") {
      throw hostCheckError("report-rubric-metadata-inconsistent");
    }
    if (typeof score.total !== "number") {
      throw hostCheckError("report-score-total-invalid");
    }
    return {
      status: "available",
      id: score.rubric,
      dimension_scores: score.scores,
      total: score.total,
      threshold: rubric.pass_threshold,
      interpretation_band: score.total >= 80 ? "Green" : score.total >= 60 ? "Yellow" : "Red",
      decision: score.decision,
      confidence: score.confidence,
      hard_gates: score.hard_gates,
    };
  }

  private async runValidator(input: {
    validator: QualityValidatorInvocationReceiptV1["validator"];
    scriptPath: string;
    expectedScriptSha256: string;
    args: string[];
    inputs: Array<[string, string]>;
    /**
     * Locked modules the script imports, verified like its inputs before the
     * spawn. The quality pack lock the selection binds records their digests,
     * so the receipt's recorded inputs stay the validator's own.
     */
    modules?: Array<[string, string]>;
    cwd: string;
  }): Promise<QualityValidatorInvocationReceiptV1> {
    const resource = qualityExecutionResource(input.validator);
    const roots = this.options.selection.pack;
    const expectedPath = qualityExecutionPath(input.validator, "script", roots);
    const expectedDigest =
      resource.scope === "quality"
        ? this.lockedQualityFile(resource.path)
        : this.lockedSkillFile(resource.skillId!, resource.path);
    const expectedModule = this.ruleModule();
    if (
      input.scriptPath !== expectedPath ||
      input.expectedScriptSha256 !== expectedDigest ||
      input.modules?.length !== 1 ||
      input.modules[0]![0] !== expectedModule[0] ||
      input.modules[0]![1] !== expectedModule[1]
    ) {
      // hygiene: envelope — QualityResourceRoleError maps the closed code to an actionable message.
      throw new QualityResourceRoleError("unsupported-execution");
    }
    await verifyRegularDigest(input.scriptPath, input.expectedScriptSha256);
    for (const [path, digest] of input.inputs) await verifyRegularDigest(path, digest);
    for (const [path, digest] of input.modules ?? []) await verifyRegularDigest(path, digest);
    const result = await runBoundedChild({
      executable: this.executable,
      args: [input.scriptPath, ...input.args],
      cwd: input.cwd,
      timeoutMs: this.timeoutMs,
      maxOutputBytes: this.maxOutputBytes,
    });
    const receipt = sealQualityValidatorReceipt({
      validator: input.validator,
      program: "python3",
      scriptSha256: input.expectedScriptSha256,
      inputPayloadSha256s: input.inputs.map((item) => item[1]),
      outcome: result.outcome,
      exitCode: result.exitCode,
      stdoutSha256: sha256(result.stdout),
      stderrSha256: sha256(result.stderr),
    });
    validatorStderr.set(receipt, result.stderr.toString("utf8"));
    return receipt;
  }

  private async persistReceipt(receipt: QualityValidatorInvocationReceiptV1): Promise<void> {
    await this.options.store.putRecord(receipt.receiptSha256, receipt);
    await this.options.store.getRecord(receipt.receiptSha256);
  }

  private async reject(
    outcome: QualityValidatorInvocationReceiptV1["outcome"],
    failure: QualityArtifactValidationFailureCode,
    staged: StagedQualityCandidate,
    receipts: {
      evaluation?: QualityValidatorInvocationReceiptV1;
      score?: QualityValidatorInvocationReceiptV1;
      report?: QualityValidatorInvocationReceiptV1;
    },
    finalReport: StagedQualityArtifact | null,
    reportMarkdown: string,
    bindings: QualityArtifactBindings,
    rejection: QualityValidationRejectionV1,
    hostDerivationCounts?: QualityHostDerivationCountsV1,
  ): Promise<never> {
    const code = outcome === "unavailable" ? "validator-unavailable" : failure;
    let inner =
      outcome === "unavailable" && isLockedValidator(rejection.validator)
        ? hostCheckRejection(
            rejection.validator,
            QUALITY_VALIDATOR_UNAVAILABLE_CODES[rejection.validator],
          )
        : rejection;
    let binding = sealQualityValidationBinding({
      ...(this.options.evaluatedCandidate
        ? { evaluatedCandidate: this.options.evaluatedCandidate }
        : {}),
      ...bindings,
      status: outcome === "unavailable" ? "incomplete" : "failed",
      failureCode: code,
      artifacts: artifactBindings(staged, finalReport),
      validatorAssets: this.validatorAssets(),
      validators: receiptBindings(receipts),
      ...(hostDerivationCounts ? { hostDerivationCounts } : {}),
    });
    try {
      await this.options.store.putRecord(binding.bindingSha256, binding);
      await this.options.store.getRecord(binding.bindingSha256);
    } catch {
      binding = sealQualityValidationBinding({
        ...(this.options.evaluatedCandidate
          ? { evaluatedCandidate: this.options.evaluatedCandidate }
          : {}),
        ...bindings,
        status: "failed",
        failureCode: "artifact-integrity-invalid",
        artifacts: {
          evaluation: null,
          qualityScore: null,
          candidateReport: null,
          finalReport: null,
        },
        validatorAssets: this.validatorAssets(),
        validators: {
          evaluation: null,
          qualityScore: null,
          reportBinding: null,
        },
        ...(hostDerivationCounts ? { hostDerivationCounts } : {}),
      });
      inner = hostCheckRejection("binding-storage", "validation-binding-unstored");
    }
    throw new QualityArtifactValidationError(binding.failureCode!, binding, reportMarkdown, inner);
  }

  /** The rule module every quality spawn imports, with its locked digest (§1.2). */
  private ruleModule(): [string, string] {
    return [
      qualityExecutionPath("decision-policy", "module", this.options.selection.pack),
      this.lockedQualityFile(RULE_MODULE),
    ];
  }

  private lockedQualityFile(path: string): string {
    const matches = this.options.selection.pack.qualityLock.files.filter(
      (file) => file.path === path,
    );
    if (matches.length !== 1) {
      throw hostCheckError("validator-lock-entry-missing");
    }
    return matches[0]!.sha256;
  }

  private lockedSkillFile(skillId: string, path: string): string {
    const skill = this.options.selection.pack.skillLock.skills.find((item) => item.id === skillId);
    const matches = skill?.files.filter((file) => file.path === path) ?? [];
    if (matches.length !== 1) {
      throw hostCheckError("validator-lock-entry-missing");
    }
    return matches[0]!.sha256;
  }

  private validatorAssets(): QualityArtifactValidationBindingV1["validatorAssets"] {
    return {
      qualityRuleModuleSha256: this.lockedQualityFile(RULE_MODULE),
      evaluationScriptSha256: this.lockedQualityFile(EVALUATION_VALIDATOR),
      evaluationSchemaSha256: this.lockedQualityFile(EVALUATION_SCHEMA),
      qualityScoreScriptSha256: this.lockedQualityFile(SCORE_VALIDATOR),
      reportScriptSha256: this.lockedSkillFile("evaluate-document-quality", REPORT_VALIDATOR),
    };
  }
}

const LIMITATION_HEADING = /^## Evidence gaps and limitations[ \t]*\r?$/imu;

function technicalInventoryHostLimitations(verification: VerificationResult | undefined): string[] {
  if (!verification) return [];
  return [
    ...verification.factInventory.limitations,
    ...verification.factInventory.dimensions
      .filter((dimension) => dimension.status === "unverified")
      .map((dimension) => `Host records ${dimension.dimension} as unverified: ${dimension.reason}`),
  ];
}

/**
 * Adds each host-owned limitation the report does not already state; the
 * evaluator saw the same limitations in its prompt and may list one. The match
 * is exact on the canonical row value the locked report validator also
 * extracts, whatever row prefix was used. A report that repeats its own
 * limitation is still refused.
 */
function appendHostLimitations(markdown: string, hostLimitations: readonly string[]): string {
  const hasSection = LIMITATION_HEADING.test(markdown);
  const stated = new Set(hasSection ? extractExactLimitations(markdown) : []);
  const missing = hostLimitations.filter((limitation) => !stated.has(limitation));
  if (missing.length === 0) return markdown;
  const rows = missing.map(renderLimitationRow).join("\n");
  return hasSection
    ? markdown.replace(LIMITATION_HEADING, (matched) => `${matched}\n\n${rows}`)
    : `${markdown.trimEnd()}\n\n## Evidence gaps and limitations\n\n${rows}\n`;
}

function renderLimitationRow(limitation: string): string {
  if (!/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(limitation)) {
    return `- Limitation: ${limitation}`;
  }
  const encoded = JSON.stringify(limitation)
    .replace(/\u0085/gu, "\\u0085")
    .replace(/\u2028/gu, "\\u2028")
    .replace(/\u2029/gu, "\\u2029");
  return `- Limitation (JSON): ${encoded}`;
}

function extractExactLimitations(markdown: string): string[] {
  const headings = [...markdown.matchAll(/^## Evidence gaps and limitations[ \t]*\r?$/gimu)];
  if (headings.length !== 1) {
    throw hostCheckError("report-limitation-section-count");
  }
  const heading = headings[0]!;
  const remainder = markdown.slice(heading.index! + heading[0].length);
  const nextHeading = remainder.search(/^## /mu);
  const section = nextHeading < 0 ? remainder : remainder.slice(0, nextHeading);
  const values: string[] = [];
  for (const line of section.split(/[\r\n\v\f\x1c-\x1e\x85\u2028\u2029]+/u)) {
    if (line.trim() === "") continue;
    const encoded = /^- Limitation \(JSON\): (.+)$/u.exec(line);
    if (encoded) {
      let decoded: unknown;
      try {
        decoded = JSON.parse(encoded[1]!);
      } catch {
        throw hostCheckError("report-limitation-row-ambiguous");
      }
      if (typeof decoded !== "string" || !decoded || /^\s|\s$/u.test(decoded)) {
        throw hostCheckError("report-limitation-value-invalid");
      }
      values.push(decoded);
      continue;
    }
    const match =
      /^- (?:(?:Limitation|Evidence gap):|\*\*(?:Limitation|Evidence gap):\*\*)\s*(\S(?:.*\S)?)$/iu.exec(
        line,
      );
    if (!match) {
      throw hostCheckError("report-limitation-row-ambiguous");
    }
    values.push(match[1]!);
  }
  if (values.some((value) => !value || /^\s|\s$/u.test(value))) {
    throw hostCheckError("report-limitation-value-invalid");
  }
  if (new Set(values).size !== values.length) {
    throw hostCheckError("report-limitation-duplicate");
  }
  return values;
}

function artifactBindings(
  staged: StagedQualityCandidate,
  finalReport: StagedQualityArtifact | null,
): QualityArtifactValidationBindingV1["artifacts"] {
  return {
    evaluation: staged.evaluation.binding,
    qualityScore: staged.qualityScore?.binding ?? null,
    candidateReport: staged.candidateReport.binding,
    finalReport: finalReport?.binding ?? null,
  };
}

function receiptBindings(receipts: {
  evaluation?: QualityValidatorInvocationReceiptV1;
  score?: QualityValidatorInvocationReceiptV1;
  report?: QualityValidatorInvocationReceiptV1;
}): QualityArtifactValidationBindingV1["validators"] {
  return {
    evaluation: receipts.evaluation ?? null,
    qualityScore: receipts.score ?? null,
    reportBinding: receipts.report ?? null,
  };
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw hostCheckError("report-artifact-not-object");
  }
  return value as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function answerRecordValidationOwner(
  location: string,
  records: readonly { readonly type: string; readonly key: string; readonly record: unknown }[],
  dimensionKeys: readonly { readonly key: string; readonly slot: string }[],
  closingToolCallId?: string,
):
  | { readonly kind: "record"; readonly type: string; readonly key: string }
  | { readonly kind: "tool-call"; readonly toolCallId: string } {
  const find = (type: string, key?: string) =>
    records.find((row) => row.type === type && (key === undefined || row.key === key));
  const layer = /^\$\.layers\.([^.\[]+)/u.exec(location)?.[1];
  let owner: { readonly type: string; readonly key: string } | undefined;
  if (location.startsWith("$.target")) {
    owner = find("target-judgment", "singleton");
  } else if (location.startsWith("$.qualityScore")) {
    owner = find("quality-score", "singleton");
  } else if (location.startsWith("$.limitations")) {
    owner = find("evaluation-note", "singleton");
  } else if (location.startsWith("$.findings")) {
    owner = [...records].reverse().find((row) => row.type === "finding");
  } else if (location.startsWith("$.constraints.")) {
    const constraint = /^\$\.constraints\.([^.\[]+)/u.exec(location)?.[1];
    if (constraint) owner = find("dimension", constraint.replaceAll("_", "-"));
  } else if (layer && location.includes(".decision")) {
    owner = find("layer-note", layer);
  } else if (layer && location.includes(".dimensions")) {
    const index = /\.dimensions\[(\d+)\]/u.exec(location)?.[1];
    const layerDimensions = dimensionKeys.filter((entry) => entry.slot === layer);
    const dimension = index === undefined ? undefined : layerDimensions[Number(index)];
    if (dimension) owner = find("dimension", dimension.key);
  }
  return owner
    ? { kind: "record", type: owner.type, key: owner.key }
    : closingToolCallId
      ? { kind: "tool-call", toolCallId: closingToolCallId }
      : { kind: "record", type: "evaluation-note", key: "singleton" };
}

function isLockedQualityCompletionRefusalCode(
  value: string,
): value is LockedQualityCompletionRefusalCode {
  return (
    TECHNICAL_TRACE_REJECTION_CODES.includes(
      value as (typeof TECHNICAL_TRACE_REJECTION_CODES)[number],
    ) ||
    EVALUATION_DIAGNOSTIC_CODES.includes(value as (typeof EVALUATION_DIAGNOSTIC_CODES)[number]) ||
    (QUALITY_CHECK_REJECTION_CODES.includes(value as QualityCheckRejectionCode) &&
      (value.startsWith("score-") ||
        value === "quality-score-semantics" ||
        value === "quality-score-validator-refused")) ||
    (value.startsWith("evaluation-schema-") &&
      STAGED_QUALITY_SCHEMA_MISMATCH_KEYWORDS.some(
        (keyword) => value === `evaluation-schema-${keyword}`,
      ))
  );
}
