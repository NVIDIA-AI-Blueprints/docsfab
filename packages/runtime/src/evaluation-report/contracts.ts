// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { RunRecord } from "../records/contracts.js";
import { validateStagedQualityArtifact } from "./quality-schema-validation.js";
import {
  assertAuthoringQualityValidationBinding,
  decodeQualityValidationBinding,
} from "./quality-artifact-staging.js";
import { decodeQualityProfileSelectionReceipt } from "./quality-profile-selection.js";
import { sha256 } from "../content-ir/canonical.js";
import { QUALITY_REPORT_DECLINE_STEM } from "../workflow-execution/quality-correction-round.js";
import { readQualityValidationRejection } from "./quality-validation-rejection.js";

export const QUALITY_REPORT_PROJECTION_KIND = "docsfab-quality-report-projection" as const;
export const QUALITY_REPORT_DECISIONS = [
  "pass",
  "conditional-pass",
  "fail",
  "human-review",
  "insufficient-evidence",
] as const;
export type QualityReportDecision = (typeof QUALITY_REPORT_DECISIONS)[number];

export interface AvailableQualityRubricV1 {
  status: "available";
  id: string;
  total: number;
  threshold: number;
  interpretationBand: "Green" | "Yellow" | "Red";
  decision: Exclude<QualityReportDecision, "insufficient-evidence">;
  confidence: number;
}

export interface UnavailableQualityRubricV1 {
  status: "unavailable";
  reason: string;
}

export interface QualityReportProjectionV1 {
  schemaVersion: 1;
  kind: typeof QUALITY_REPORT_PROJECTION_KIND;
  decision: QualityReportDecision;
  confidence: number;
  hardGateFailures: readonly string[];
  limitations: readonly string[];
  rubric: AvailableQualityRubricV1 | UnavailableQualityRubricV1;
  reportLocator: { kind: "artifact-digest"; digestSha256: string };
  repositoryRevision: string;
  patchSha256: string | null;
}

export const QUALITY_RETAINED_GAP_REASONS = [
  "experimental-profile-ceiling",
  "audience-prerequisites-missing",
] as const;
export type QualityRetainedGapReason = (typeof QUALITY_RETAINED_GAP_REASONS)[number];

export interface QualityProfileDecisionPolicyEvidenceV2 {
  kind: "profile-decision-policy";
  artifactLocator: string;
  artifactSha256: string;
  profileId: string;
  profileVersion: string;
  profileStatus: "experimental";
  releaseGateEligible: false;
  decisionPolicyField: "experimental_profile_maximum_decision";
  decisionPolicyValue: "insufficient-evidence";
}

export interface QualityAudiencePrerequisiteEvidenceV2 {
  kind: "audience-prerequisite-policy";
  artifactLocator: string;
  artifactSha256: string;
  profileId: string;
  profileVersion: string;
  prerequisites: readonly [
    { field: "calibration.human_outcome_baseline"; value: "pending" },
    { field: "calibration.agent_outcome_baseline"; value: "pending" },
  ];
}

export interface QualityRetainedGapEvidenceV2 {
  limitation: string;
  reason: QualityRetainedGapReason;
  evidence: QualityProfileDecisionPolicyEvidenceV2 | QualityAudiencePrerequisiteEvidenceV2;
}

export interface QualityReportProjectionV2
  extends Omit<QualityReportProjectionV1, "schemaVersion"> {
  schemaVersion: 2;
  retainedGapEvidence: readonly QualityRetainedGapEvidenceV2[];
  unclassifiedLimitations: readonly string[];
}

export type QualityReportProjection = QualityReportProjectionV1 | QualityReportProjectionV2;

const PROJECTION_TEXT_MAX = 512;
const PROJECTION_TEXT_VISIBLE_MAX = 509;

export class QualityReportProjectionError extends Error {
  readonly code: "missing-report" | "invalid-report";

  constructor(code: "missing-report" | "invalid-report") {
    super(`Quality report projection rejected: ${code}.`);
    this.code = code;
    this.name = "QualityReportProjectionError";
  }
}

export function rejectQualityReportProjection(code: QualityReportProjectionError["code"]): never {
  throw new QualityReportProjectionError(code);
}

export const QUALITY_REPORT_FAILURES = {
  "missing-report":
    "Review report processing failed (missing-report): no unique structured report summary was found. Completed step outputs remain in the saved run; this is not a passed review.",
  "invalid-report":
    "Review report processing failed (invalid-report): the structured report failed validation. Completed step outputs remain in the saved run; this is not a passed review.",
} as const;

/** Presentation can retain completed work without treating an invalid report as valid. */
export function inspectQualityReportFromRun(
  record: Parameters<typeof projectQualityReportFromRun>[0] & Pick<RunRecord, "status">,
  options: { qualityNotApplicable?: boolean } = {},
): {
  quality: QualityReportProjection | null;
  error?: string;
  limitation?:
    | "quality-validation-unavailable"
    | "quality-evaluator-not-run"
    | "quality-envelope-json";
} {
  try {
    const quality = projectQualityReportFromRun(record);
    // Retained advisory assessments and declined artifacts have no validated
    // quality projection. Their absence never changes successful execution.
    if (
      quality === null &&
      (record.workflow === "create-documentation" || record.workflow === "update-documentation") &&
      record.status === "succeeded" &&
      !options.qualityNotApplicable
    ) {
      const evaluator = [...record.steps]
        .reverse()
        .find((step) => step.skill === "evaluate-document-quality" && step.status === "succeeded");
      const rejection = readQualityValidationRejection(evaluator?.qualityValidationRejection);
      if (
        rejection?.code === "quality-envelope-json" &&
        rejection.validator === "candidate-admission" &&
        evaluator?.summary?.startsWith(QUALITY_REPORT_DECLINE_STEM)
      ) {
        return { quality, limitation: rejection.code };
      }
      return {
        quality,
        limitation: evaluator ? "quality-validation-unavailable" : "quality-evaluator-not-run",
      };
    }
    return { quality };
  } catch (error) {
    if (!(error instanceof QualityReportProjectionError)) throw error;
    const message = QUALITY_REPORT_FAILURES[error.code];
    return {
      quality: null,
      error:
        record.workflow === "review-documentation"
          ? message
          : message
              .replace("Review report", "Quality report")
              .replace("passed review", "passed quality assessment"),
    };
  }
}

export function projectQualityReportFromRun(
  record: Pick<
    RunRecord,
    | "workflow"
    | "id"
    | "repository"
    | "changes"
    | "steps"
    | "qualityPack"
    | "qualityProfileSelection"
    | "qualityArtifactValidation"
    | "authoringExecution"
  >,
): QualityReportProjection | null {
  const authoring =
    record.workflow === "create-documentation" || record.workflow === "update-documentation";
  if (record.workflow !== "review-documentation" && !authoring) return null;
  // A selected profile alone is not validated quality. Legacy summaries and
  // host-declined artifacts stay advisory until the producer attaches a
  // validation binding; narrative text cannot activate or suppress that binding.
  if (authoring && record.qualityArtifactValidation === undefined) return null;
  const evaluator = [...record.steps]
    .reverse()
    .find((step) => step.skill === "evaluate-document-quality" && step.status === "succeeded");
  if (!evaluator) return null;
  // A step the correction round declined (quality-correction-round.ts) is a
  // known-absent report, not a malformed one: the step's own summary already
  // names why, so the review result just carries no quality section instead
  // of refusing the whole review over a gap this step already disclosed.
  if (
    record.workflow === "review-documentation" &&
    evaluator.summary?.includes(QUALITY_REPORT_DECLINE_STEM)
  )
    return null;
  if (!evaluator.summary) rejectQualityReportProjection("missing-report");
  const summary = findValidatedSummary(evaluator.summary);
  if (authoring && summary.report_contract !== "docsfab-quality-report-v0.2") {
    rejectQualityReportProjection("invalid-report");
  }
  let profile:
    | { artifactLocator: string; artifactSha256: string; id: string; version: string }
    | undefined;
  if (summary.report_contract === "docsfab-quality-report-v0.2") {
    try {
      const selection = decodeQualityProfileSelectionReceipt(record.qualityProfileSelection);
      profile = {
        artifactLocator: selection.profileAssetPath,
        artifactSha256: selection.profilePayloadSha256,
        id: selection.profileId,
        version: selection.profileVersion,
      };
    } catch {
      rejectQualityReportProjection("invalid-report");
    }
  }
  const projection = parseQualityReportProjection(evaluator.summary, {
    repositoryRevision: record.repository.revision,
    patchSha256: record.changes?.patch?.sha256 ?? null,
    ...(profile ? { profile } : {}),
  });
  assertRuntimeQualityValidationBinding(record, evaluator);
  return projection;
}

function assertRuntimeQualityValidationBinding(
  record: Pick<
    RunRecord,
    | "workflow"
    | "id"
    | "repository"
    | "changes"
    | "steps"
    | "authoringExecution"
    | "qualityPack"
    | "qualityProfileSelection"
    | "qualityArtifactValidation"
  >,
  evaluator: RunRecord["steps"][number],
): void {
  try {
    const selection = decodeQualityProfileSelectionReceipt(record.qualityProfileSelection);
    const binding = decodeQualityValidationBinding(record.qualityArtifactValidation);
    if (
      binding.status !== "passed" ||
      selection.workflow !== record.workflow ||
      binding.failureCode !== null ||
      binding.runId !== record.id ||
      binding.repositoryRevision !== record.repository.revision ||
      selection.repositoryIdentitySha256 !== sha256(record.repository.sourcePath) ||
      binding.selectionSha256 !== selection.selectionSha256 ||
      selection.qualityPackManifestSha256 !== record.qualityPack?.manifestSha256 ||
      binding.qualityPackBindingSha256 !== record.qualityPack?.bindingSha256 ||
      binding.evaluatorIdentitySha256 !== evaluator.evaluateEvidence?.evaluatorIdentitySha256 ||
      selection.repositoryRevision !== record.repository.revision ||
      selection.qualityPackBindingSha256 !== record.qualityPack?.bindingSha256 ||
      selection.skillLockSha256 !== record.qualityPack?.skillLockSha256 ||
      selection.qualityLockSha256 !== record.qualityPack?.qualityLockSha256 ||
      selection.qualityBundleSha256 !== record.qualityPack?.qualityBundleSha256 ||
      record.qualityPack?.barIds.includes(selection.profileBarId) !== true ||
      binding.artifacts.evaluation === null ||
      binding.artifacts.candidateReport === null ||
      binding.artifacts.finalReport === null ||
      binding.artifacts.finalReport.payloadSha256 !== sha256(evaluator.summary ?? "") ||
      binding.validators.evaluation === null ||
      binding.validators.reportBinding === null ||
      (binding.artifacts.qualityScore === null) !== (binding.validators.qualityScore === null)
    ) {
      rejectQualityReportProjection("invalid-report");
    }
    if (record.workflow === "create-documentation" || record.workflow === "update-documentation") {
      assertAuthoringQualityValidationBinding(record, binding, selection);
    }
    const summary = findValidatedSummary(evaluator.summary!);
    const profile = object(summary.profile);
    const locators = object(summary.artifact_locators);
    if (
      profile.id !== selection.profileId ||
      profile.version !== selection.profileVersion ||
      locators.evaluation !== `record:sha256:${binding.artifacts.evaluation.recordSha256}` ||
      locators.quality_score !==
        (binding.artifacts.qualityScore
          ? `record:sha256:${binding.artifacts.qualityScore.recordSha256}`
          : null) ||
      locators.quality_report !== `run:${binding.runId}:evaluate-document-quality:quality-report`
    ) {
      rejectQualityReportProjection("invalid-report");
    }
    assertValidatorReceipts(binding, selection.profilePayloadSha256);
  } catch (error) {
    if (error instanceof QualityReportProjectionError) throw error;
    rejectQualityReportProjection("invalid-report");
  }
}

function assertValidatorReceipts(
  binding: NonNullable<RunRecord["qualityArtifactValidation"]>,
  profilePayloadSha256: string,
): void {
  const evaluation = binding.validators.evaluation;
  const report = binding.validators.reportBinding;
  const evaluationArtifact = binding.artifacts.evaluation;
  const finalReport = binding.artifacts.finalReport;
  if (!evaluation || !report || !evaluationArtifact || !finalReport) {
    rejectQualityReportProjection("invalid-report");
  }
  if (
    evaluation.validator !== "evaluation" ||
    evaluation.program !== "python3" ||
    evaluation.scriptSha256 !== binding.validatorAssets.evaluationScriptSha256 ||
    evaluation.outcome !== "passed" ||
    evaluation.exitCode !== 0 ||
    evaluation.inputPayloadSha256s.length !== 3 ||
    evaluation.inputPayloadSha256s[0] !== evaluationArtifact.payloadSha256 ||
    evaluation.inputPayloadSha256s[1] !== binding.validatorAssets.evaluationSchemaSha256 ||
    evaluation.inputPayloadSha256s[2] !== profilePayloadSha256
  ) {
    rejectQualityReportProjection("invalid-report");
  }
  const score = binding.validators.qualityScore;
  const scoreArtifact = binding.artifacts.qualityScore;
  if (
    scoreArtifact === null
      ? score !== null
      : !score ||
        score.validator !== "quality-score" ||
        score.program !== "python3" ||
        score.scriptSha256 !== binding.validatorAssets.qualityScoreScriptSha256 ||
        score.outcome !== "passed" ||
        score.exitCode !== 0 ||
        score.inputPayloadSha256s.length !== 1 ||
        score.inputPayloadSha256s[0] !== scoreArtifact.payloadSha256
  ) {
    rejectQualityReportProjection("invalid-report");
  }
  const expectedReportInputs = [
    evaluationArtifact.payloadSha256,
    finalReport.payloadSha256,
    profilePayloadSha256,
    ...(scoreArtifact ? [scoreArtifact.payloadSha256] : []),
  ];
  if (
    report.validator !== "report-binding" ||
    report.program !== "python3" ||
    report.scriptSha256 !== binding.validatorAssets.reportScriptSha256 ||
    report.outcome !== "passed" ||
    report.exitCode !== 0 ||
    report.inputPayloadSha256s.length !== expectedReportInputs.length ||
    report.inputPayloadSha256s.some((digest, index) => digest !== expectedReportInputs[index])
  ) {
    rejectQualityReportProjection("invalid-report");
  }
}

function assertQualityReportProjectionSchema(root: Record<string, unknown>): void {
  if (
    root.kind !== QUALITY_REPORT_PROJECTION_KIND ||
    validateStagedQualityArtifact("quality-report-projection.schema.json", root) !== "valid"
  ) {
    rejectQualityReportProjection("invalid-report");
  }
}

export function decodeQualityReportProjection(value: unknown): QualityReportProjection {
  const root = object(value);
  if (root.schemaVersion === 2) return decodeQualityReportProjectionV2(root);
  return decodeQualityReportProjectionV1(root);
}

function decodeQualityReportProjectionV1(root: Record<string, unknown>): QualityReportProjectionV1 {
  exactKeys(root, [
    "schemaVersion",
    "kind",
    "decision",
    "confidence",
    "hardGateFailures",
    "limitations",
    "rubric",
    "reportLocator",
    "repositoryRevision",
    "patchSha256",
  ]);
  assertQualityReportProjectionSchema(root);
  const locator = object(root.reportLocator);
  const rubricRoot = object(root.rubric);
  const rubric =
    rubricRoot.status === "available"
      ? parseProjectedAvailableRubric(rubricRoot)
      : parseRubric(rubricRoot);
  return Object.freeze({
    schemaVersion: 1 as const,
    kind: QUALITY_REPORT_PROJECTION_KIND,
    decision: enumeration(root.decision, QUALITY_REPORT_DECISIONS),
    confidence: probability(root.confidence),
    hardGateFailures: Object.freeze(uniqueStrings(root.hardGateFailures)),
    limitations: Object.freeze(uniqueStrings(root.limitations)),
    rubric: Object.freeze(rubric),
    reportLocator: Object.freeze({
      kind: "artifact-digest" as const,
      digestSha256: hash(locator.digestSha256 as string),
    }),
    repositoryRevision: revision(root.repositoryRevision as string),
    patchSha256: root.patchSha256 === null ? null : hash(root.patchSha256 as string),
  });
}

function decodeQualityReportProjectionV2(root: Record<string, unknown>): QualityReportProjectionV2 {
  exactKeys(root, [
    "schemaVersion",
    "kind",
    "decision",
    "confidence",
    "hardGateFailures",
    "limitations",
    "retainedGapEvidence",
    "unclassifiedLimitations",
    "rubric",
    "reportLocator",
    "repositoryRevision",
    "patchSha256",
  ]);
  assertQualityReportProjectionSchema(root);
  const limitations = uniqueLimitationStrings(root.limitations);
  const retainedGapEvidence = parseProjectedRetainedGapEvidence(root.retainedGapEvidence);
  const unclassifiedLimitations = uniqueLimitationStrings(root.unclassifiedLimitations);
  const retained = new Set(retainedGapEvidence.map((entry) => entry.limitation));
  if (
    retainedGapEvidence.some((entry) => !limitations.includes(entry.limitation)) ||
    unclassifiedLimitations.some((item) => !limitations.includes(item)) ||
    limitations.some((item) => retained.has(item) === unclassifiedLimitations.includes(item))
  )
    rejectQualityReportProjection("invalid-report");
  const locator = object(root.reportLocator);
  exactKeys(locator, ["kind", "digestSha256"]);
  if (locator.kind !== "artifact-digest") rejectQualityReportProjection("invalid-report");
  const rubricRoot = object(root.rubric);
  const rubric =
    rubricRoot.status === "available"
      ? parseProjectedAvailableRubric(rubricRoot)
      : parseRubric(rubricRoot);
  const decision = enumeration(root.decision, QUALITY_REPORT_DECISIONS);
  const hardGateFailures = uniqueStrings(root.hardGateFailures);
  if (hardGateFailures.length > 0 && decision !== "fail")
    rejectQualityReportProjection("invalid-report");
  if (
    rubric.status === "unavailable" &&
    hardGateFailures.length === 0 &&
    decision !== "insufficient-evidence"
  )
    rejectQualityReportProjection("invalid-report");
  return Object.freeze({
    schemaVersion: 2,
    kind: QUALITY_REPORT_PROJECTION_KIND,
    decision,
    confidence: probability(root.confidence),
    hardGateFailures: Object.freeze(hardGateFailures),
    limitations: Object.freeze(limitations),
    retainedGapEvidence: Object.freeze(retainedGapEvidence),
    unclassifiedLimitations: Object.freeze(unclassifiedLimitations),
    rubric: Object.freeze(rubric),
    reportLocator: Object.freeze({
      kind: "artifact-digest",
      digestSha256: hash(locator.digestSha256 as string),
    }),
    repositoryRevision: revision(root.repositoryRevision as string),
    patchSha256: root.patchSha256 === null ? null : hash(root.patchSha256 as string),
  });
}

function parseProjectedRetainedGapEvidence(value: unknown): QualityRetainedGapEvidenceV2[] {
  if (!Array.isArray(value) || value.length > 2) rejectQualityReportProjection("invalid-report");
  const entries = value.map((item) => {
    const root = object(item);
    exactKeys(root, ["limitation", "reason", "evidence"]);
    const reason = enumeration(root.reason, QUALITY_RETAINED_GAP_REASONS);
    const evidence = object(root.evidence);
    if (reason === "experimental-profile-ceiling") {
      exactKeys(evidence, [
        "kind",
        "artifactLocator",
        "artifactSha256",
        "profileId",
        "profileVersion",
        "profileStatus",
        "releaseGateEligible",
        "decisionPolicyField",
        "decisionPolicyValue",
      ]);
      if (
        evidence.kind !== "profile-decision-policy" ||
        evidence.profileStatus !== "experimental" ||
        evidence.releaseGateEligible !== false ||
        evidence.decisionPolicyField !== "experimental_profile_maximum_decision" ||
        evidence.decisionPolicyValue !== "insufficient-evidence"
      )
        rejectQualityReportProjection("invalid-report");
      return {
        limitation: bounded(root.limitation),
        reason,
        evidence: {
          kind: "profile-decision-policy" as const,
          artifactLocator: bounded(evidence.artifactLocator),
          artifactSha256: hash(evidence.artifactSha256 as string),
          profileId: identifier(evidence.profileId),
          profileVersion: bounded(evidence.profileVersion),
          profileStatus: "experimental" as const,
          releaseGateEligible: false as const,
          decisionPolicyField: "experimental_profile_maximum_decision" as const,
          decisionPolicyValue: "insufficient-evidence" as const,
        },
      };
    }
    exactKeys(evidence, [
      "kind",
      "artifactLocator",
      "artifactSha256",
      "profileId",
      "profileVersion",
      "prerequisites",
    ]);
    if (evidence.kind !== "audience-prerequisite-policy")
      rejectQualityReportProjection("invalid-report");
    return {
      limitation: bounded(root.limitation),
      reason,
      evidence: {
        kind: "audience-prerequisite-policy" as const,
        artifactLocator: bounded(evidence.artifactLocator),
        artifactSha256: hash(evidence.artifactSha256 as string),
        profileId: identifier(evidence.profileId),
        profileVersion: bounded(evidence.profileVersion),
        prerequisites: parseAudiencePrerequisites(evidence.prerequisites),
      },
    };
  });
  if (
    new Set(entries.map((entry) => entry.limitation)).size !== entries.length ||
    new Set(entries.map((entry) => entry.reason)).size !== entries.length
  )
    rejectQualityReportProjection("invalid-report");
  return entries;
}

export function parseQualityReportProjection(
  markdown: string,
  binding: {
    repositoryRevision: string;
    patchSha256: string | null;
    profile?: { artifactLocator: string; artifactSha256: string; id: string; version: string };
  },
): QualityReportProjection {
  if (typeof markdown !== "string" || markdown.trim() === "") {
    rejectQualityReportProjection("missing-report");
  }
  const root = findValidatedSummary(markdown);
  if (validateStagedQualityArtifact("quality-report.schema.json", root) !== "valid") {
    rejectQualityReportProjection("invalid-report");
  }
  const v2 = root.report_contract === "docsfab-quality-report-v0.2";
  exactKeys(root, [
    "report_contract",
    "target",
    "profile",
    "evaluation",
    "rubric",
    "validation",
    "artifact_locators",
    ...(v2 ? ["limitations", "retained_gap_evidence"] : []),
  ]);
  const target = object(root.target);
  exactKeys(target, ["paths", "repository_revision", "documentation_revision"]);
  const targetPaths = uniqueStrings(target.paths);
  if (targetPaths.length === 0) rejectQualityReportProjection("invalid-report");
  const repositoryRevision = revision(target.repository_revision as string);
  // The report contract and its validator admit any bounded string here: the
  // evaluator names the documentation it read, which is not always a commit.
  bounded(target.documentation_revision);
  if (repositoryRevision !== binding.repositoryRevision) {
    rejectQualityReportProjection("invalid-report");
  }
  const profile = object(root.profile);
  exactKeys(profile, ["id", "version"]);
  identifier(profile.id);
  bounded(profile.version);
  const evaluation = object(root.evaluation);
  exactKeys(evaluation, ["decision", "confidence", "hard_gate_failures"]);
  const decision = enumeration(evaluation.decision, QUALITY_REPORT_DECISIONS);
  const hardGateFailures = projectedStrings(evaluation.hard_gate_failures);
  const rubricRoot = object(root.rubric);
  const parsedRubric = parseReportRubric(rubricRoot);
  const rubric = parsedRubric.rubric;
  validateReportClaims(root.validation, root.artifact_locators, rubric.status);
  const extractedLimitations = extractLimitations(markdown);
  if (v2) {
    const closedLimitations = extractClosedLimitations(markdown);
    if (hardGateFailures.truncatedCount !== 0 || parsedRubric.truncatedCount !== 0) {
      rejectQualityReportProjection("invalid-report");
    }
    const declaredLimitations = orderedUniqueLimitationStrings(root.limitations);
    if (
      declaredLimitations.length !== closedLimitations.length ||
      declaredLimitations.some((value, index) => value !== closedLimitations[index])
    ) {
      rejectQualityReportProjection("invalid-report");
    }
    const retainedGapEvidence = parseRawRetainedGapEvidence(root.retained_gap_evidence);
    if (!binding.profile) rejectQualityReportProjection("invalid-report");
    if (
      retainedGapEvidence.some(
        (entry) =>
          entry.evidence.artifactLocator !== binding.profile!.artifactLocator ||
          entry.evidence.artifactSha256 !== binding.profile!.artifactSha256 ||
          entry.evidence.profileId !== binding.profile!.id ||
          entry.evidence.profileVersion !== binding.profile!.version,
      )
    )
      rejectQualityReportProjection("invalid-report");
    const retained = new Set(retainedGapEvidence.map((entry) => entry.limitation));
    if (retainedGapEvidence.some((entry) => !declaredLimitations.includes(entry.limitation))) {
      rejectQualityReportProjection("invalid-report");
    }
    const unclassifiedLimitations = declaredLimitations.filter((item) => !retained.has(item));
    return Object.freeze({
      schemaVersion: 2 as const,
      kind: QUALITY_REPORT_PROJECTION_KIND,
      decision,
      confidence: probability(evaluation.confidence),
      hardGateFailures: Object.freeze(hardGateFailures.values),
      limitations: Object.freeze(declaredLimitations),
      retainedGapEvidence: Object.freeze(retainedGapEvidence),
      unclassifiedLimitations: Object.freeze(unclassifiedLimitations),
      rubric: Object.freeze(rubric),
      reportLocator: Object.freeze({
        kind: "artifact-digest" as const,
        digestSha256: sha256(markdown),
      }),
      repositoryRevision: revision(binding.repositoryRevision),
      patchSha256: binding.patchSha256 === null ? null : hash(binding.patchSha256),
    });
  }
  const truncatedCount =
    hardGateFailures.truncatedCount +
    parsedRubric.truncatedCount +
    extractedLimitations.truncatedCount;
  const limitations = extractedLimitations.values;
  if (truncatedCount > 0) {
    limitations.push(
      truncatedCount === 1
        ? "truncated-projection-field"
        : `truncated-projection-field:${truncatedCount}`,
    );
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    kind: QUALITY_REPORT_PROJECTION_KIND,
    decision,
    confidence: probability(evaluation.confidence),
    hardGateFailures: Object.freeze(hardGateFailures.values),
    limitations: Object.freeze([...new Set(limitations)].sort()),
    rubric: Object.freeze(rubric),
    reportLocator: Object.freeze({
      kind: "artifact-digest" as const,
      digestSha256: sha256(markdown),
    }),
    repositoryRevision: revision(binding.repositoryRevision),
    patchSha256: binding.patchSha256 === null ? null : hash(binding.patchSha256),
  });
}

function findValidatedSummary(markdown: string): Record<string, unknown> {
  const blocks = [
    ...markdown.matchAll(
      /^## Validated result summary\s+.*?^```json\s*$\n(?<json>\{.*?\})\n^```\s*$/gimsu,
    ),
  ];
  if (blocks.length !== 1) rejectQualityReportProjection("missing-report");
  try {
    const root = object(JSON.parse(blocks[0]!.groups!.json!) as unknown);
    if (
      root.report_contract !== "docsfab-quality-report-v0.1" &&
      root.report_contract !== "docsfab-quality-report-v0.2"
    ) {
      rejectQualityReportProjection("invalid-report");
    }
    return root;
  } catch (error) {
    if (error instanceof QualityReportProjectionError) throw error;
    rejectQualityReportProjection("invalid-report");
  }
}

function parseRawRetainedGapEvidence(value: unknown): QualityRetainedGapEvidenceV2[] {
  if (!Array.isArray(value) || value.length > 2) rejectQualityReportProjection("invalid-report");
  const parsed = value.map((item) => {
    const root = object(item);
    exactKeys(root, ["limitation", "reason", "evidence"]);
    const reason = enumeration(root.reason, QUALITY_RETAINED_GAP_REASONS);
    return {
      limitation: bounded(root.limitation),
      reason,
      evidence: parseRawGapArtifact(root.evidence, reason),
    } satisfies QualityRetainedGapEvidenceV2;
  });
  if (
    new Set(parsed.map((item) => item.limitation)).size !== parsed.length ||
    new Set(parsed.map((item) => item.reason)).size !== parsed.length
  ) {
    rejectQualityReportProjection("invalid-report");
  }
  return parsed;
}

function parseRawGapArtifact(
  value: unknown,
  reason: QualityRetainedGapReason,
): QualityRetainedGapEvidenceV2["evidence"] {
  const root = object(value);
  if (reason === "experimental-profile-ceiling") {
    exactKeys(root, [
      "kind",
      "artifact_locator",
      "artifact_sha256",
      "profile_id",
      "profile_version",
      "profile_status",
      "release_gate_eligible",
      "decision_policy_field",
      "decision_policy_value",
    ]);
    if (
      root.kind !== "profile-decision-policy" ||
      root.profile_status !== "experimental" ||
      root.release_gate_eligible !== false ||
      root.decision_policy_field !== "experimental_profile_maximum_decision" ||
      root.decision_policy_value !== "insufficient-evidence"
    )
      rejectQualityReportProjection("invalid-report");
    return {
      kind: "profile-decision-policy",
      artifactLocator: bounded(root.artifact_locator),
      artifactSha256: hash(root.artifact_sha256 as string),
      profileId: identifier(root.profile_id),
      profileVersion: bounded(root.profile_version),
      profileStatus: "experimental",
      releaseGateEligible: false,
      decisionPolicyField: "experimental_profile_maximum_decision",
      decisionPolicyValue: "insufficient-evidence",
    };
  }
  exactKeys(root, [
    "kind",
    "artifact_locator",
    "artifact_sha256",
    "profile_id",
    "profile_version",
    "prerequisites",
  ]);
  if (root.kind !== "audience-prerequisite-policy") rejectQualityReportProjection("invalid-report");
  const prerequisites = parseAudiencePrerequisites(root.prerequisites);
  return {
    kind: "audience-prerequisite-policy",
    artifactLocator: bounded(root.artifact_locator),
    artifactSha256: hash(root.artifact_sha256 as string),
    profileId: identifier(root.profile_id),
    profileVersion: bounded(root.profile_version),
    prerequisites,
  };
}

function parseAudiencePrerequisites(
  value: unknown,
): QualityAudiencePrerequisiteEvidenceV2["prerequisites"] {
  if (!Array.isArray(value) || value.length !== 2) rejectQualityReportProjection("invalid-report");
  const parsed = value.map((item) => {
    const root = object(item);
    exactKeys(root, ["field", "value"]);
    if (root.value !== "pending") rejectQualityReportProjection("invalid-report");
    return {
      field: enumeration(root.field, [
        "calibration.human_outcome_baseline",
        "calibration.agent_outcome_baseline",
      ] as const),
      value: "pending" as const,
    };
  });
  if (
    parsed[0]?.field !== "calibration.human_outcome_baseline" ||
    parsed[1]?.field !== "calibration.agent_outcome_baseline"
  )
    rejectQualityReportProjection("invalid-report");
  return parsed as unknown as QualityAudiencePrerequisiteEvidenceV2["prerequisites"];
}

function parseReportRubric(root: Record<string, unknown>): {
  rubric: AvailableQualityRubricV1 | UnavailableQualityRubricV1;
  truncatedCount: number;
} {
  if (root.status === "unavailable") {
    exactKeys(root, ["status", "reason"]);
    const reason = projectionString(root.reason);
    return {
      rubric: { status: "unavailable", reason: reason.value },
      truncatedCount: reason.truncated ? 1 : 0,
    };
  }
  exactKeys(root, [
    "status",
    "id",
    "dimension_scores",
    "total",
    "threshold",
    "interpretation_band",
    "decision",
    "confidence",
    "hard_gates",
  ]);
  object(root.dimension_scores);
  object(root.hard_gates);
  return { rubric: parseRubric(root), truncatedCount: 0 };
}

function validateReportClaims(
  validationValue: unknown,
  locatorsValue: unknown,
  rubricStatus: "available" | "unavailable",
): void {
  const validation = object(validationValue);
  exactKeys(validation, ["evaluation", "quality_score", "report_binding"]);
  if (validation.evaluation !== "passed" || validation.report_binding !== "passed") {
    rejectQualityReportProjection("invalid-report");
  }
  const locators = object(locatorsValue);
  exactKeys(locators, ["evaluation", "quality_score", "quality_report"]);
  bounded(locators.evaluation);
  bounded(locators.quality_report);
  if (rubricStatus === "available") {
    if (validation.quality_score !== "passed") {
      rejectQualityReportProjection("invalid-report");
    }
    bounded(locators.quality_score);
  } else if (validation.quality_score !== "unavailable" || locators.quality_score !== null) {
    rejectQualityReportProjection("invalid-report");
  }
}

function parseRubric(
  root: Record<string, unknown>,
): AvailableQualityRubricV1 | UnavailableQualityRubricV1 {
  if (root.status === "unavailable") {
    return { status: "unavailable", reason: bounded(root.reason) };
  }
  if (root.status !== "available") rejectQualityReportProjection("invalid-report");
  return {
    status: "available",
    id: identifier(root.id),
    total: score(root.total),
    threshold: score(root.threshold),
    interpretationBand: enumeration(root.interpretation_band, ["Green", "Yellow", "Red"]),
    decision: enumeration(root.decision, ["pass", "conditional-pass", "fail", "human-review"]),
    confidence: probability(root.confidence),
  };
}

function parseProjectedAvailableRubric(root: Record<string, unknown>): AvailableQualityRubricV1 {
  exactKeys(root, [
    "status",
    "id",
    "total",
    "threshold",
    "interpretationBand",
    "decision",
    "confidence",
  ]);
  return {
    status: "available",
    id: identifier(root.id),
    total: score(root.total),
    threshold: score(root.threshold),
    interpretationBand: enumeration(root.interpretationBand, ["Green", "Yellow", "Red"]),
    decision: enumeration(root.decision, ["pass", "conditional-pass", "fail", "human-review"]),
    confidence: probability(root.confidence),
  };
}

function extractLimitations(markdown: string): { values: string[]; truncatedCount: number } {
  const heading = /^## Evidence gaps and limitations[ \t]*\r?$/imu.exec(markdown);
  if (!heading) return { values: [], truncatedCount: 0 };
  const remainder = markdown.slice(heading.index + heading[0].length);
  const nextHeading = remainder.search(/^## /mu);
  const section = nextHeading < 0 ? remainder : remainder.slice(0, nextHeading);
  const projected = [...section.matchAll(/^- (?:Limitation:|\*\*Limitation:\*\*)\s*(.+)$/gimu)].map(
    (match) => projectionString(match[1]!.trim()),
  );
  return {
    values: [...new Set(projected.map((item) => item.value))].sort(),
    truncatedCount: projected.filter((item) => item.truncated).length,
  };
}

function extractClosedLimitations(markdown: string): string[] {
  const headings = [...markdown.matchAll(/^## Evidence gaps and limitations[ \t]*\r?$/gimu)];
  if (headings.length !== 1) rejectQualityReportProjection("invalid-report");
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
        rejectQualityReportProjection("invalid-report");
      }
      values.push(limitationString(decoded));
      continue;
    }
    const match =
      /^- (?:(?:Limitation|Evidence gap):|\*\*(?:Limitation|Evidence gap):\*\*)\s*(\S(?:.*\S)?)$/iu.exec(
        line,
      );
    if (!match) rejectQualityReportProjection("invalid-report");
    values.push(limitationString(match[1]!));
  }
  if (new Set(values).size !== values.length) {
    rejectQualityReportProjection("invalid-report");
  }
  return values;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    rejectQualityReportProjection("invalid-report");
  }
  return value as Record<string, unknown>;
}

function exactKeys(root: Record<string, unknown>, keys: readonly string[]): void {
  if (
    Object.keys(root).length !== keys.length ||
    keys.some((key) => !Object.prototype.hasOwnProperty.call(root, key))
  ) {
    rejectQualityReportProjection("invalid-report");
  }
}

function uniqueStrings(value: unknown): string[] {
  if (!Array.isArray(value)) rejectQualityReportProjection("invalid-report");
  const items = value.map(bounded);
  if (new Set(items).size !== items.length) rejectQualityReportProjection("invalid-report");
  return [...items].sort();
}

function limitationString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || /^\s|\s$/u.test(value)) {
    rejectQualityReportProjection("invalid-report");
  }
  return value;
}

function uniqueLimitationStrings(value: unknown): string[] {
  if (!Array.isArray(value)) rejectQualityReportProjection("invalid-report");
  const items = value.map(limitationString);
  if (new Set(items).size !== items.length) rejectQualityReportProjection("invalid-report");
  return [...items].sort();
}

function orderedUniqueLimitationStrings(value: unknown): string[] {
  if (!Array.isArray(value)) rejectQualityReportProjection("invalid-report");
  const items = value.map(limitationString);
  if (new Set(items).size !== items.length) rejectQualityReportProjection("invalid-report");
  return items;
}

function orderedUniqueStrings(value: unknown): string[] {
  if (!Array.isArray(value)) rejectQualityReportProjection("invalid-report");
  const items = value.map(bounded);
  if (new Set(items).size !== items.length) rejectQualityReportProjection("invalid-report");
  return items;
}

function projectedStrings(value: unknown): { values: string[]; truncatedCount: number } {
  if (!Array.isArray(value)) rejectQualityReportProjection("invalid-report");
  const originals = value.map(projectionInputString);
  if (new Set(originals).size !== originals.length) rejectQualityReportProjection("invalid-report");
  const projected = originals.map(projectionString);
  const values = [...new Set(projected.map((item) => item.value))];
  return {
    values: [...values].sort(),
    truncatedCount: projected.filter((item) => item.truncated).length,
  };
}

function projectionInputString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || /^\s|\s$/u.test(value)) {
    rejectQualityReportProjection("invalid-report");
  }
  return value;
}

function projectionString(value: unknown): { value: string; truncated: boolean } {
  if (typeof value !== "string" || value.length === 0 || /^\s|\s$/u.test(value)) {
    rejectQualityReportProjection("invalid-report");
  }
  return value.length > PROJECTION_TEXT_MAX
    ? { value: `${value.slice(0, PROJECTION_TEXT_VISIBLE_MAX)}...`, truncated: true }
    : { value, truncated: false };
}

function bounded(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    /^\s|\s$/u.test(value)
  ) {
    rejectQualityReportProjection("invalid-report");
  }
  return value;
}

function identifier(value: unknown): string {
  const text = bounded(value);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(text)) {
    rejectQualityReportProjection("invalid-report");
  }
  return text;
}

function probability(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    rejectQualityReportProjection("invalid-report");
  }
  return value;
}

function score(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
    rejectQualityReportProjection("invalid-report");
  }
  return value;
}

function enumeration<const T extends readonly string[]>(value: unknown, allowed: T): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    rejectQualityReportProjection("invalid-report");
  }
  return value as T[number];
}

function hash(value: string): string {
  if (!/^[a-f0-9]{64}$/u.test(value)) rejectQualityReportProjection("invalid-report");
  return value;
}

function revision(value: string): string {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value)) {
    rejectQualityReportProjection("invalid-report");
  }
  return value;
}
