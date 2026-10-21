// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { lstat } from "node:fs/promises";
import { resolve } from "node:path";

import type { DurableArtifactStore } from "../artifacts/index.js";
import { InferenceStepError } from "../execution/contracts.js";
import {
  decodeQualityProfileSelectionReceipt,
  decodeQualityValidationBinding,
  loadStagedQualityArtifact,
  projectQualityReportFromRun,
  assertTechnicalFactTrace,
  QualityArtifactStagingError,
} from "../evaluation-report/index.js";
import type { RunRecord, StepRunRecord } from "../records/contracts.js";
import {
  decodeRetainedAuthoringWorkflowV1,
  validateAuthoringRunRecordV1,
} from "../records/authoring-execution.js";
import { authoringSelectedPath } from "../workflow-contracts/authoring-schedule.js";
import {
  canonicalizeJsonEvidence,
  parseJsonEvidence,
  type JsonEvidenceValue,
} from "../operator/json-evidence.js";
import { validateStagedQualityArtifact } from "../evaluation-report/quality-schema-validation.js";
import {
  decodeTemplateAuditReport,
  retainedTemplateAuditReport,
  TEMPLATE_AUDIT_WORKFLOW,
  templateAuditReviewFindings,
  type TemplateAuditReportV1,
} from "../templates/audit.js";
import {
  assertReviewFindingDisclosure,
  normalizeReviewFinding,
  type ReviewFindingV1,
  type ReviewIssueV3,
  type ReviewSourceContextV3,
} from "./contracts.js";
import {
  projectQualityFindings,
  projectReviewResultFindings,
} from "./findings/result-projection.js";
import {
  mapSeverity,
  object,
  parseCanonicalJson,
  parseLocation,
  truncate,
} from "./findings/projection-primitives.js";
import {
  normalizeRepositoryLocator,
  validateLegacyVerificationResult,
  validateVerificationResult,
  type LegacyVerificationResult,
  type VerificationResult,
} from "../workflow-execution/review-response.js";
import {
  documentationPlanVerificationPaths,
  validateAdmittedDocumentationPlanBinding,
} from "../workflow-execution/plan-binding.js";
import {
  isNavigationLabelList,
  navigationLabelSummary,
} from "../workflow-execution/plan-companions.js";
import { isPlainRecord } from "../shared/primitives.js";

const FINDING_SKILLS = new Set([
  "lint-documentation",
  "verify-technical-accuracy",
  "review-documentation",
  "evaluate-document-quality",
]);
const SAFE_RELATIVE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._][A-Za-z0-9._/-]{0,511}$/u;
const MAX_REVIEW_INPUT_BYTES = 1_048_576;
const MAX_REVIEW_FINDINGS = 256;
const MAX_REVIEW_FINDINGS_BYTES = 131_072;
const ARTIFACT_UNAVAILABLE = "unavailable" as const;
const ARTIFACT_INVALID = "invalid" as const;

export interface ProjectedReviewFindingsV1 {
  readonly findings: readonly ReviewFindingV1[];
  readonly limitations: readonly string[];
  readonly availability: ReviewFindingsAvailability;
  readonly artifactLocator: string | null;
  readonly projector: typeof REVIEW_FINDINGS_PROJECTOR;
}

export interface ProjectedReviewIssueGraphV1 extends ProjectedReviewFindingsV1 {
  readonly issues: readonly ReviewIssueV3[];
  readonly sourceContexts: readonly ReviewSourceContextV3[];
  readonly canonicalTechnicalInvalid: boolean;
}

export const REVIEW_FINDINGS_PROJECTOR = "docsfab-review-findings-v2" as const;
export type ReviewFindingsAvailability = "complete" | "partial" | "unavailable" | "invalid";

export interface VerifiedReviewEvaluationArtifactV1 {
  readonly artifactLocator: string;
  readonly runId: string;
  readonly repositoryRevision: string;
  readonly profile: {
    readonly id: "docsfab-documentation-quality";
    readonly version: "v0.1";
  };
  readonly payload: Readonly<Record<string, JsonEvidenceValue>>;
}

export class ReviewFindingsArtifactError extends Error {
  public constructor(
    public readonly availability: "unavailable" | "invalid",
    public readonly reason: string,
    public readonly artifactLocator: string | null,
  ) {
    super(`Review findings artifact is ${availability}: ${reason}.`);
    this.name = "ReviewFindingsArtifactError";
  }
}

type ReviewFindingsRun = Pick<RunRecord, "steps" | "reviewScope"> &
  Partial<
    Pick<RunRecord, "id" | "workflow" | "repository" | "status" | "changes" | "authoringExecution">
  >;

/**
 * Lift only canonical JSON returned by review skills. Human summaries and
 * fenced JSON are deliberately ignored so they cannot become an API by
 * accident.
 */
export function projectReviewFindingsFromRun(record: ReviewFindingsRun): ProjectedReviewFindingsV1 {
  return projectReviewFindings(record, false);
}

/** The delivery projection shares terminal admission and selected-candidate filtering. */
export function projectReviewIssueGraphFromRun(
  record: ReviewFindingsRun,
): ProjectedReviewIssueGraphV1 {
  return projectReviewFindings(record, true) as ProjectedReviewIssueGraphV1;
}

function projectReviewFindings(
  record: ReviewFindingsRun,
  issueGraph: boolean,
): ProjectedReviewFindingsV1 | ProjectedReviewIssueGraphV1 {
  if (record.workflow === TEMPLATE_AUDIT_WORKFLOW) {
    return withIssueGraph(projectTemplateAuditFindings(record), issueGraph, [], [], false);
  }
  const findings: ReviewFindingV1[] = [];
  const issues: ReviewIssueV3[] = [];
  const sourceContexts: ReviewSourceContextV3[] = [];
  let canonicalTechnicalInvalid = false;
  const limitations = new Set<string>();
  const findingIds = new Set<string>();
  const targetResolution = retainedVerificationTargets(record);
  let selectedSteps = record.steps;
  let technicalStepId = "verify-technical-accuracy";
  let retainedAuthoringProducerFilterActive = false;
  if (record.authoringExecution !== undefined) {
    try {
      const workflow = decodeRetainedAuthoringWorkflowV1(record.authoringExecution);
      const admitted = validateAuthoringRunRecordV1(record as RunRecord, workflow, {
        requireTerminalSuccess: record.status === "succeeded",
      });
      const selected = admitted.selectedCandidate;
      if (!selected) {
        return withIssueGraph(
          freezeProjection(
            [],
            new Set(["review-findings-authoring-candidate-unavailable"]),
            null,
            "unavailable",
          ),
          issueGraph,
          [],
          [],
          true,
        );
      }
      const path = authoringSelectedPath(workflow, selected.ordinal === 0 ? "retain" : "revise");
      technicalStepId = path.technicalProducerStepId;
      retainedAuthoringProducerFilterActive = true;
      const selectedIds = new Set([
        selected.ordinal === 0 ? "lint-documentation" : "lint-revised-documentation",
        path.technicalProducerStepId,
        path.editorialProducerStepId,
        "evaluate-document-quality",
      ]);
      selectedSteps = record.steps.filter((step) => selectedIds.has(step.id));
      if (
        [path.technicalProducerStepId, path.editorialProducerStepId].some(
          (id) => !selectedSteps.some((step) => step.id === id && step.status === "succeeded"),
        )
      ) {
        limitations.add("review-findings-selected-candidate-assessment-incomplete");
        if (issueGraph) canonicalTechnicalInvalid = true;
      }
    } catch {
      return withIssueGraph(
        freezeProjection(
          [],
          new Set(["review-findings-invalid:authoring-candidate"]),
          null,
          "invalid",
        ),
        issueGraph,
        [],
        [],
        true,
      );
    }
  } else if (
    record.steps.some(
      (step) =>
        step.authoringPhase !== undefined ||
        ("authoringRevisionAccounting" in step &&
          (step as { authoringRevisionAccounting?: unknown }).authoringRevisionAccounting !==
            undefined) ||
        [
          "revise-documentation",
          "lint-revised-documentation",
          "provisional-revised-technical-verification",
          "verify-revised-technical-accuracy",
          "review-revised-documentation",
        ].includes(step.id),
    )
  ) {
    return withIssueGraph(
      freezeProjection(
        [],
        new Set(["review-findings-invalid:authoring-candidate"]),
        null,
        "invalid",
      ),
      issueGraph,
      [],
      [],
      true,
    );
  }
  let admittedSourceCount = 0;
  for (const step of selectedSteps) {
    if (step.status !== "succeeded" || !FINDING_SKILLS.has(step.skill)) continue;
    if (step.id === "derive-source-obligations") continue;
    if (
      retainedAuthoringProducerFilterActive &&
      step.skill === "verify-technical-accuracy" &&
      step.id !== technicalStepId
    ) {
      continue;
    }
    if (
      step.summary !== undefined &&
      Buffer.byteLength(step.summary, "utf8") > MAX_REVIEW_INPUT_BYTES
    ) {
      limitations.add(`review-findings-input-too-large:${step.skill}`);
      if (
        issueGraph &&
        step.skill === "verify-technical-accuracy" &&
        step.summary.includes('"factInventory"')
      )
        canonicalTechnicalInvalid = true;
      continue;
    }
    // The host check summary is not canonical JSON, so its advisory template
    // report is read on its own before the canonical review-result gate.
    if (step.skill === "lint-documentation") {
      projectTemplateConformanceFindings(step.summary, findings, findingIds, limitations);
    }
    const root = parseCanonicalJson(step.summary);
    if (!root) {
      limitations.add(`review-findings-unparsed:${step.skill}`);
      if (
        issueGraph &&
        step.skill === "verify-technical-accuracy" &&
        step.summary?.includes('"factInventory"')
      )
        canonicalTechnicalInvalid = true;
      continue;
    }
    if (step.skill === "lint-documentation") {
      limitations.add("review-findings-schema-unavailable:lint-documentation");
      continue;
    }
    let admittedRoot = root;
    let verification: VerificationResult | undefined;
    let verificationForLimits: VerificationResult | LegacyVerificationResult | undefined;
    if (step.skill === "verify-technical-accuracy") {
      if (targetResolution.invalid) {
        limitations.add("review-findings-invalid:verify-technical-accuracy:plan-binding");
        if (issueGraph && Object.hasOwn(root, "factInventory")) canonicalTechnicalInvalid = true;
        continue;
      }
      const wrapperLike = ["review", "coverage", "factInventory"].some((key) =>
        Object.hasOwn(root, key),
      );
      if (wrapperLike) {
        try {
          if (Object.hasOwn(root, "factInventory")) {
            if (targetResolution.missingAuthoringPlan) {
              limitations.add("review-findings-invalid:verify-technical-accuracy:plan-binding");
              if (issueGraph) canonicalTechnicalInvalid = true;
              continue;
            }
            verification = validateVerificationResult(root, targetResolution.paths);
            verificationForLimits = verification;
            admittedRoot = verification.review as unknown as Record<string, JsonEvidenceValue>;
          } else {
            const legacy = validateLegacyVerificationResult(root, targetResolution.paths);
            verificationForLimits = legacy;
            admittedRoot = legacy.review as unknown as Record<string, JsonEvidenceValue>;
            limitations.add(
              "review-findings-fact-inventory-unavailable:verify-technical-accuracy:legacy-wrapper",
            );
          }
        } catch (error) {
          if (issueGraph && Object.hasOwn(root, "factInventory")) canonicalTechnicalInvalid = true;
          limitations.add(
            error instanceof InferenceStepError && !error.retryable
              ? `review-findings-schema-unavailable:${step.skill}`
              : `review-findings-invalid:${step.skill}:schema`,
          );
          continue;
        }
      } else {
        const validation = validateStagedQualityArtifact("review-result.schema.json", root);
        if (validation !== "valid") {
          limitations.add(
            validation === "schema-unavailable"
              ? `review-findings-schema-unavailable:${step.skill}`
              : `review-findings-invalid:${step.skill}:schema`,
          );
          continue;
        }
        limitations.add(
          "review-findings-fact-inventory-unavailable:verify-technical-accuracy:legacy-review-result",
        );
      }
    } else {
      const validation = validateStagedQualityArtifact(
        step.skill === "evaluate-document-quality"
          ? "documentation-quality-evaluation.schema.json"
          : "review-result.schema.json",
        root,
      );
      if (validation !== "valid") {
        limitations.add(
          validation === "schema-unavailable"
            ? `review-findings-schema-unavailable:${step.skill}`
            : `review-findings-invalid:${step.skill}:schema`,
        );
        continue;
      }
    }
    admittedSourceCount += 1;
    if (issueGraph && verification) {
      const graph = projectCanonicalTechnicalIssueGraph(verification, step);
      if (
        sourceContexts.some((context) => context.id === graph.sourceContext.id) ||
        graph.issues.some((issue) => issues.some((existing) => existing.id === issue.id))
      ) {
        throw new Error(`Review result canonical technical producer duplicated: ${step.id}.`);
      }
      sourceContexts.push(graph.sourceContext);
      issues.push(...graph.issues);
    }
    recordAdmittedReviewLimitations(
      step.skill,
      step.id,
      admittedRoot,
      verificationForLimits,
      limitations,
    );
    const projected =
      step.skill === "evaluate-document-quality"
        ? projectQualityFindings(admittedRoot)
        : issueGraph && verification
          ? { findings: [], limitations: [] }
          : projectReviewResultFindings(admittedRoot, step, verification);
    for (const limitation of projected.limitations) limitations.add(limitation);
    let invalidCount = Math.max(
      0,
      (issueGraph && verification
        ? 0
        : Array.isArray(admittedRoot.issues)
          ? admittedRoot.issues.length
          : 0) +
        (Array.isArray(admittedRoot.findings) ? admittedRoot.findings.length : 0) -
        projected.findings.length,
    );
    for (const [index, finding] of projected.findings.entries()) {
      const normalized = normalizeFinding(finding);
      if (normalized === null) {
        invalidCount += 1;
        recordFactProjectionOmission(finding, step.id, 1, "invalid", limitations);
        continue;
      }
      if (step.skill === "evaluate-document-quality") {
        const folded = foldEvaluatorRestatement(findings, normalized);
        if (folded !== null) {
          findings.splice(0, findings.length, ...folded);
          continue;
        }
      }
      if (findingIds.has(normalized.id)) {
        limitations.add(`review-findings-duplicate:${normalized.id}`);
        continue;
      }
      if (findings.length >= MAX_REVIEW_FINDINGS) {
        limitations.add(`review-findings-omitted:${projected.findings.length - index}`);
        recordFactProjectionOmission(
          finding,
          step.id,
          projected.findings.length - index,
          "finding-limit",
          limitations,
        );
        break;
      }
      const candidateBytes = Buffer.byteLength(JSON.stringify([...findings, normalized]), "utf8");
      if (candidateBytes > MAX_REVIEW_FINDINGS_BYTES) {
        limitations.add(`review-findings-omitted-bytes:${projected.findings.length - index}`);
        recordFactProjectionOmission(
          finding,
          step.id,
          projected.findings.length - index,
          "byte-limit",
          limitations,
        );
        break;
      }
      findingIds.add(normalized.id);
      findings.push(normalized);
    }
    if (invalidCount > 0) limitations.add(`review-findings-invalid:${step.skill}:${invalidCount}`);
  }
  projectNavigationLabelFindings(record.steps, findings, findingIds, limitations);
  findings.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  return withIssueGraph(
    Object.freeze({
      findings: Object.freeze(findings),
      limitations: Object.freeze([...limitations].sort()),
      availability: findingsAvailability(
        findings,
        [...limitations],
        admittedSourceCount === 0 ? "unavailable" : undefined,
      ),
      artifactLocator: null,
      projector: REVIEW_FINDINGS_PROJECTOR,
    }),
    issueGraph,
    issues,
    sourceContexts,
    canonicalTechnicalInvalid,
  );
}

function withIssueGraph(
  projection: ProjectedReviewFindingsV1,
  enabled: boolean,
  issues: readonly ReviewIssueV3[],
  sourceContexts: readonly ReviewSourceContextV3[],
  canonicalTechnicalInvalid: boolean,
): ProjectedReviewFindingsV1 | ProjectedReviewIssueGraphV1 {
  return enabled
    ? Object.freeze({
        ...projection,
        issues: Object.freeze(issues),
        sourceContexts: Object.freeze(sourceContexts),
        canonicalTechnicalInvalid,
      })
    : projection;
}

function projectCanonicalTechnicalIssueGraph(
  verification: VerificationResult,
  step: StepRunRecord,
): { issues: ReviewIssueV3[]; sourceContext: ReviewSourceContextV3 } {
  const sourceContextId = `context:${step.id}`;
  const inventory = verification.factInventory;
  const sourceContext: ReviewSourceContextV3 = {
    id: sourceContextId,
    completeness: inventory.completeness,
    limitations: [...inventory.limitations],
    dimensions: inventory.dimensions.map((dimension) => ({
      dimension: dimension.dimension,
      status: dimension.status,
      reason: dimension.reason,
      sourceLocators: [...dimension.sourceLocators],
      facts: dimension.facts.map((fact) => ({
        id: fact.id,
        dimension: fact.dimension,
        sourceLocators: [...fact.sourceLocators],
        statement: fact.statement,
        documentationDisposition: fact.documentationDisposition,
        uncertainty: fact.uncertainty,
        issueIds: [...fact.issueIds],
      })),
    })),
  };
  const issues = verification.review.issues.map((raw): ReviewIssueV3 => {
    const issue = raw as {
      id: string;
      severity: "critical" | "major" | "minor";
      category: string;
      finding: string;
      location: string;
      evidence: { source_id: string; locator: string };
      required_change: string;
    };
    const location = parseLocation(issue.location);
    if (location.malformed)
      throw new Error(`Review result canonical issue location invalid: ${issue.id}.`);
    const factRefs = inventory.dimensions.flatMap((dimension, dimensionIndex) =>
      dimension.facts.flatMap((fact, factIndex) =>
        fact.issueIds.includes(issue.id) ? [{ dimensionIndex, factIndex }] : [],
      ),
    );
    return {
      id: `issue:${step.id}:${issue.id}`,
      producerStepId: step.id,
      producerSkill: step.skill,
      originalId: issue.id,
      severity: mapSeverity(issue.severity),
      originalSeverity: issue.severity,
      category: issue.category,
      finding: issue.finding,
      location: issue.location,
      path: location.path,
      line: location.line ?? null,
      locationFidelity:
        location.fidelity === "partial"
          ? "normalized"
          : location.fidelity === "unavailable"
            ? "unresolved"
            : "exact",
      evidence: { sourceId: issue.evidence.source_id, locator: issue.evidence.locator },
      requiredChange: issue.required_change,
      limitations:
        location.fidelity === "exact"
          ? []
          : [`review-finding-location-${location.fidelity}:${issue.id}`],
      sourceContextId,
      factRefs,
    };
  });
  return { issues, sourceContext };
}

/**
 * Template audit findings come from the host report, not from a skill's
 * review result. Coverage gaps become limitations, so a page the audit did not
 * check is never read as a passing page.
 */
function projectTemplateAuditFindings(record: ReviewFindingsRun): ProjectedReviewFindingsV1 {
  const report = retainedTemplateAuditReport({
    workflow: TEMPLATE_AUDIT_WORKFLOW,
    steps: record.steps,
  });
  if (!report) {
    return freezeProjection(
      [],
      new Set(["review-findings-unavailable:template-audit"]),
      null,
      "unavailable",
    );
  }
  const limitations = new Set<string>();
  const { coverage, scope } = report;
  if (coverage.unmapped > 0) limitations.add(`template-audit-unmapped:${coverage.unmapped}`);
  if (coverage.refused > 0) limitations.add(`template-audit-refused:${coverage.refused}`);
  if (scope.enumeration === "incomplete") {
    limitations.add(`template-audit-enumeration-incomplete:${scope.omittedEntries}`);
  }
  const findings: ReviewFindingV1[] = [];
  appendTemplateReportFindings(report, "template-audit", findings, new Set(), limitations);
  findings.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  return Object.freeze({
    findings: Object.freeze(findings),
    limitations: Object.freeze([...limitations].sort()),
    availability: limitations.size === 0 ? "complete" : "partial",
    artifactLocator: null,
    projector: REVIEW_FINDINGS_PROJECTOR,
  });
}

/**
 * The advisory template report a documentation check step retained beside
 * its check results. Its findings join the run's review findings; a page it
 * could not map or read becomes a limitation, never a passing page.
 */
function projectTemplateConformanceFindings(
  summary: string | undefined,
  findings: ReviewFindingV1[],
  findingIds: Set<string>,
  limitations: Set<string>,
): void {
  let value: unknown;
  try {
    value = summary === undefined ? undefined : parseJsonEvidence(summary.trim());
  } catch {
    // hygiene: refusal — the canonical gate below records the unparsed summary.
    return;
  }
  if (!isPlainRecord(value) || value.templateConformance === undefined) return;
  let report: TemplateAuditReportV1;
  try {
    report = decodeTemplateAuditReport(value.templateConformance);
  } catch {
    limitations.add("review-findings-invalid:lint-documentation:template-conformance");
    return;
  }
  for (const [index, page] of report.pages.entries()) {
    const path = SAFE_RELATIVE_PATH.test(page.path) ? page.path : `page-${index + 1}`;
    if (page.status === "unmapped") {
      limitations.add(`template-conformance-unmapped:${page.reason}:${path}`);
    } else if (page.status === "refused") {
      limitations.add(`template-conformance-refused:${page.code}:${path}`);
    }
  }
  appendTemplateReportFindings(report, "template-conformance", findings, findingIds, limitations);
}

function appendTemplateReportFindings(
  report: TemplateAuditReportV1,
  source: "template-audit" | "template-conformance",
  findings: ReviewFindingV1[],
  findingIds: Set<string>,
  limitations: Set<string>,
): void {
  const projected = templateAuditReviewFindings(report);
  for (const [index, candidate] of projected.entries()) {
    const normalized = normalizeFinding(candidate);
    if (normalized === null) {
      limitations.add(`review-findings-invalid:${source}:${candidate.id}`);
      continue;
    }
    if (findingIds.has(normalized.id)) continue;
    if (
      findings.length >= MAX_REVIEW_FINDINGS ||
      Buffer.byteLength(JSON.stringify([...findings, normalized]), "utf8") >
        MAX_REVIEW_FINDINGS_BYTES
    ) {
      limitations.add(`review-findings-omitted:${projected.length - index}`);
      break;
    }
    findingIds.add(normalized.id);
    findings.push(normalized);
  }
}

function recordFactProjectionOmission(
  finding: ReviewFindingV1,
  stepId: string,
  count: number,
  reason: "invalid" | "finding-limit" | "byte-limit",
  limitations: Set<string>,
): void {
  if (!finding.id.includes(":fact:")) return;
  limitations.add(
    `review-finding-fact-projection-omitted:${reason}:${count}:starting=${finding.code}:retained=run-step:${stepId}:summary`,
  );
}

function recordAdmittedReviewLimitations(
  skill: string,
  stepId: string,
  review: Record<string, JsonEvidenceValue>,
  verification: VerificationResult | LegacyVerificationResult | undefined,
  limitations: Set<string>,
): void {
  if (review.verdict === "human-review") {
    limitations.add(`review-findings-human-review:${skill}`);
  }
  for (const [index, coverage] of (verification?.coverage ?? []).entries()) {
    if (coverage.status !== "unverified") continue;
    const path = SAFE_RELATIVE_PATH.test(coverage.path) ? coverage.path : `target-${index + 1}`;
    limitations.add(`review-findings-coverage-unverified:${skill}:${path}`);
  }
  const factInventory =
    verification && "factInventory" in verification ? verification.factInventory : undefined;
  for (const [index, limitation] of (factInventory?.limitations ?? []).entries()) {
    limitations.add(
      `review-findings-fact-inventory-limitation:${index + 1}:${limitation}:retained=run-step:${stepId}:summary`,
    );
  }
  for (const assessment of factInventory?.dimensions ?? []) {
    if (assessment.status !== "unverified") continue;
    limitations.add(
      `review-findings-fact-inventory-unverified:${assessment.dimension}:${assessment.reason}:retained=run-step:${stepId}:summary`,
    );
  }
  if (factInventory?.completeness === "bounded-not-proven") {
    limitations.add("review-findings-fact-inventory-bounded-not-proven");
  }
}

/**
 * Recover the final evaluator findings only from its retained, already
 * validated artifact. The human Markdown report remains presentation and is
 * never reparsed as finding authority.
 */
export async function projectReviewFindingsFromRetainedRun(
  record: RunRecord,
  store: DurableArtifactStore,
): Promise<ProjectedReviewFindingsV1> {
  const summaryProjection = projectReviewFindingsFromRun(record);
  const evaluator = [...record.steps]
    .reverse()
    .find(
      (step) =>
        step.id === "evaluate-document-quality" && step.skill === "evaluate-document-quality",
    );
  if (
    record.workflow !== "review-documentation" ||
    evaluator === undefined ||
    (evaluator.status !== "succeeded" && record.qualityArtifactValidation === undefined)
  ) {
    return summaryProjection;
  }

  const retainedLimitations = new Set(
    summaryProjection.limitations.filter(
      (limitation) => !limitation.includes(":evaluate-document-quality"),
    ),
  );
  const summaryFindings = summaryProjection.findings.filter(
    (finding) =>
      !finding.id.startsWith("finding:evaluate-document-quality:") && !/^DQ-/u.test(finding.id),
  );
  try {
    const verified = await loadVerifiedReviewEvaluationArtifact(record, store);
    const retainedTechnical = inspectRetainedTechnicalVerification(
      record,
      retainedVerificationTargets(record).paths,
    );
    if (retainedTechnical.kind !== "current") {
      retainedLimitations.add(
        `review-findings-fact-inventory-unavailable:verify-technical-accuracy:${retainedTechnical.kind}`,
      );
    }
    const recovered = projectQualityFindings(verified.payload);
    for (const limitation of recovered.limitations) retainedLimitations.add(limitation);
    let invalidCount = Math.max(
      0,
      (Array.isArray(verified.payload.findings) ? verified.payload.findings.length : 0) -
        recovered.findings.length,
    );
    const normalizedRecovered: ReviewFindingV1[] = [];
    for (const finding of recovered.findings) {
      const normalized = normalizeFinding(finding);
      if (normalized === null) invalidCount += 1;
      else normalizedRecovered.push(normalized);
    }
    if (invalidCount > 0) {
      retainedLimitations.add(`review-findings-invalid:evaluate-document-quality:${invalidCount}`);
    }
    let upstreamFindings: readonly ReviewFindingV1[] = summaryFindings;
    const evaluatorFindings: ReviewFindingV1[] = [];
    for (const finding of normalizedRecovered) {
      const folded = foldEvaluatorRestatement(upstreamFindings, finding);
      if (folded === null) evaluatorFindings.push(finding);
      else upstreamFindings = folded;
    }
    const merged = mergeFindings(upstreamFindings, evaluatorFindings, retainedLimitations);
    return freezeProjection(
      merged,
      retainedLimitations,
      verified.artifactLocator,
      merged.length === 0 && invalidCount > 0 ? "invalid" : undefined,
    );
  } catch (error) {
    const artifactError =
      error instanceof ReviewFindingsArtifactError
        ? error
        : new ReviewFindingsArtifactError(ARTIFACT_INVALID, "binding", null);
    retainedLimitations.add(
      `review-findings-artifact-${artifactError.availability}:evaluate-document-quality:${artifactError.reason}`,
    );
    return freezeProjection(
      summaryFindings,
      retainedLimitations,
      artifactError.artifactLocator,
      artifactError.availability,
    );
  }
}

/**
 * Load the trusted evaluation payload for another deterministic projector.
 * "Trusted" means schema-validated and bound to this run; it does not assert
 * that agent-authored content is factually correct. Callers receive no host
 * authority and must keep the payload read-only.
 */
export async function loadVerifiedReviewEvaluationArtifact(
  record: RunRecord,
  store: DurableArtifactStore,
): Promise<VerifiedReviewEvaluationArtifactV1> {
  const evaluator = [...record.steps]
    .reverse()
    .find(
      (step) =>
        step.id === "evaluate-document-quality" && step.skill === "evaluate-document-quality",
    );
  if (record.workflow !== "review-documentation" || evaluator === undefined) {
    throw new ReviewFindingsArtifactError(ARTIFACT_UNAVAILABLE, "no-evaluator", null);
  }
  if (record.qualityArtifactValidation === undefined) {
    throw new ReviewFindingsArtifactError(ARTIFACT_UNAVAILABLE, "no-binding", null);
  }
  let binding;
  try {
    binding = decodeQualityValidationBinding(record.qualityArtifactValidation);
  } catch {
    throw new ReviewFindingsArtifactError(ARTIFACT_INVALID, "binding", null);
  }
  const evaluationBinding = binding.artifacts.evaluation;
  const artifactLocator = evaluationBinding
    ? `record:sha256:${evaluationBinding.recordSha256}`
    : null;
  if (binding.status !== "passed") {
    throw new ReviewFindingsArtifactError(
      ARTIFACT_INVALID,
      binding.failureCode === "technical-trace-incomplete"
        ? "technical-trace-incomplete"
        : "validation",
      artifactLocator,
    );
  }
  if (evaluator.status !== "succeeded") {
    throw new ReviewFindingsArtifactError(ARTIFACT_UNAVAILABLE, "no-evaluator", artifactLocator);
  }
  if (evaluationBinding === null) {
    throw new ReviewFindingsArtifactError(ARTIFACT_UNAVAILABLE, "no-artifact", null);
  }
  try {
    const storeDirectories = await Promise.all([
      lstat(store.root),
      lstat(resolve(store.root, "objects")),
      lstat(resolve(store.root, "objects", "sha256")),
    ]);
    if (
      storeDirectories.some((directory) => !directory.isDirectory() || directory.isSymbolicLink())
    ) {
      throw new ReviewFindingsArtifactError(ARTIFACT_INVALID, "store", artifactLocator);
    }
  } catch (error) {
    if (error instanceof ReviewFindingsArtifactError) throw error;
    throw new ReviewFindingsArtifactError(ARTIFACT_UNAVAILABLE, "artifact-absent", artifactLocator);
  }
  try {
    if (!(await store.has(evaluationBinding.recordSha256))) {
      throw new ReviewFindingsArtifactError(
        ARTIFACT_UNAVAILABLE,
        "artifact-absent",
        artifactLocator,
      );
    }
  } catch (error) {
    if (error instanceof ReviewFindingsArtifactError) throw error;
    throw new ReviewFindingsArtifactError(ARTIFACT_INVALID, "store", artifactLocator);
  }
  try {
    // This authenticates the selected profile, final report, evaluator, run,
    // revision, quality pack, validator receipts, and evaluation locator.
    projectQualityReportFromRun(record);
    const selection = decodeQualityProfileSelectionReceipt(record.qualityProfileSelection);
    const artifact = await loadStagedQualityArtifact(store, evaluationBinding.recordSha256);
    if (
      artifact.artifactKind !== "evaluation" ||
      artifact.recordSha256 !== evaluationBinding.recordSha256 ||
      artifact.payloadSha256 !== evaluationBinding.payloadSha256 ||
      artifact.runId !== record.id ||
      artifact.repositoryRevision !== record.repository.revision ||
      artifact.selectionSha256 !== selection.selectionSha256 ||
      artifact.evaluatorIdentitySha256 !== evaluator.evaluateEvidence?.evaluatorIdentitySha256 ||
      artifact.qualityPackBindingSha256 !== record.qualityPack?.bindingSha256 ||
      selection.repositoryRevision !== record.repository.revision ||
      selection.qualityPackBindingSha256 !== record.qualityPack?.bindingSha256
    ) {
      throw new Error("The retained evaluation artifact does not match its run bindings.");
    }
    const root = object(artifact.payload as JsonEvidenceValue);
    if (root === null) {
      throw new Error("The retained evaluation artifact does not match its recorded schema.");
    }
    const schemaValidation = validateStagedQualityArtifact(
      "documentation-quality-evaluation.schema.json",
      root,
    );
    if (schemaValidation === "schema-unavailable") {
      throw new ReviewFindingsArtifactError(ARTIFACT_UNAVAILABLE, "schema", artifactLocator);
    }
    if (schemaValidation !== "valid") {
      throw new Error("The retained evaluation artifact does not match its recorded schema.");
    }
    const targetResolution = retainedVerificationTargets(record);
    if (targetResolution.invalid) {
      throw new ReviewFindingsArtifactError(ARTIFACT_INVALID, "plan-binding", artifactLocator);
    }
    const retainedTechnical = inspectRetainedTechnicalVerification(record, targetResolution.paths);
    if (retainedTechnical.kind === "invalid") {
      throw new ReviewFindingsArtifactError(
        ARTIFACT_INVALID,
        "technical-trace-incomplete",
        artifactLocator,
      );
    }
    if (retainedTechnical.kind === "schema-unavailable") {
      throw new ReviewFindingsArtifactError(
        ARTIFACT_UNAVAILABLE,
        "schema-unavailable",
        artifactLocator,
      );
    }
    if (targetResolution.missingAuthoringPlan && retainedTechnical.kind === "current") {
      throw new ReviewFindingsArtifactError(ARTIFACT_INVALID, "plan-binding", artifactLocator);
    }
    assertTechnicalFactTrace(
      root,
      retainedTechnical.kind === "current" ? retainedTechnical.verification : undefined,
    );
    return Object.freeze({
      artifactLocator: `record:sha256:${evaluationBinding.recordSha256}`,
      runId: record.id,
      repositoryRevision: record.repository.revision,
      profile: Object.freeze({ id: selection.profileId, version: selection.profileVersion }),
      payload: Object.freeze(structuredClone(root)),
    });
  } catch (error) {
    if (error instanceof ReviewFindingsArtifactError) throw error;
    if (
      error instanceof QualityArtifactStagingError &&
      error.code === "technical-trace-incomplete"
    ) {
      throw new ReviewFindingsArtifactError(
        ARTIFACT_INVALID,
        "technical-trace-incomplete",
        artifactLocator,
      );
    }
    throw new ReviewFindingsArtifactError(ARTIFACT_INVALID, "binding", artifactLocator);
  }
}

function retainedVerificationTargets(
  record: Pick<RunRecord, "steps" | "reviewScope"> & { readonly workflow?: RunRecord["workflow"] },
): {
  readonly paths?: readonly string[];
  readonly invalid: boolean;
  readonly missingAuthoringPlan: boolean;
} {
  if (record.reviewScope) {
    return { paths: record.reviewScope.targetPaths, invalid: false, missingAuthoringPlan: false };
  }
  const plan = [...record.steps]
    .reverse()
    .find(
      (step) =>
        step.id === "plan-documentation" &&
        step.skill === "plan-documentation" &&
        step.status === "succeeded" &&
        step.planBinding !== undefined,
    );
  if (!plan?.planBinding) {
    return {
      invalid: false,
      missingAuthoringPlan:
        record.workflow === "create-documentation" ||
        record.workflow === "update-documentation" ||
        record.workflow === "restructure-documentation",
    };
  }
  try {
    return {
      paths: documentationPlanVerificationPaths(
        validateAdmittedDocumentationPlanBinding(plan.planBinding),
      ),
      invalid: false,
      missingAuthoringPlan: false,
    };
  } catch {
    return { invalid: true, missingAuthoringPlan: false };
  }
}

type RetainedTechnicalVerification =
  | { readonly kind: "current"; readonly verification: VerificationResult }
  | { readonly kind: "legacy-wrapper" | "legacy-review-result" | "missing-transport" }
  | { readonly kind: "invalid" | "schema-unavailable" };

function inspectRetainedTechnicalVerification(
  record: Pick<RunRecord, "steps">,
  targetPaths?: readonly string[],
): RetainedTechnicalVerification {
  const technical = [...record.steps]
    .reverse()
    .find(
      (step) =>
        step.id === "verify-technical-accuracy" &&
        step.skill === "verify-technical-accuracy" &&
        step.status === "succeeded",
    );
  if (typeof technical?.summary !== "string" || technical.summary === "") {
    return { kind: "missing-transport" };
  }
  let value: JsonEvidenceValue;
  try {
    value = parseJsonEvidence(technical.summary);
  } catch {
    return { kind: "legacy-review-result" };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { kind: "legacy-review-result" };
  }
  if (!Object.hasOwn(value, "factInventory")) {
    return Object.hasOwn(value, "coverage")
      ? { kind: "legacy-wrapper" }
      : { kind: "legacy-review-result" };
  }
  if (canonicalizeJsonEvidence(value) !== `${technical.summary}\n`) return { kind: "invalid" };
  try {
    return {
      kind: "current",
      verification: validateVerificationResult(value, targetPaths),
    };
  } catch (error) {
    return error instanceof InferenceStepError && !error.retryable
      ? { kind: "schema-unavailable" }
      : { kind: "invalid" };
  }
}

/**
 * The host's navigation labels, one warning finding each, from the step
 * field the host wrote; never from a model summary. A label that does not
 * normalize, or that the finding bounds cannot hold, is a named limitation.
 */
function projectNavigationLabelFindings(
  steps: ReviewFindingsRun["steps"],
  findings: ReviewFindingV1[],
  findingIds: Set<string>,
  limitations: Set<string>,
): void {
  for (const step of steps) {
    if (step.navigationLabels === undefined) continue;
    if (!isNavigationLabelList(step.navigationLabels)) {
      limitations.add(`review-findings-invalid:${step.id}:navigation-labels`);
      continue;
    }
    for (const label of step.navigationLabels) {
      const finding = normalizeFinding({
        id: `navigation:${label.code}:${label.path ?? "run"}`,
        severity: "warning",
        code: label.code,
        summary: navigationLabelSummary(label),
        path: label.path,
        origin: "deterministic",
      });
      if (finding === null) {
        limitations.add(`review-findings-invalid:${step.id}:navigation-labels`);
        continue;
      }
      if (findingIds.has(finding.id)) continue;
      if (
        findings.length >= MAX_REVIEW_FINDINGS ||
        Buffer.byteLength(JSON.stringify([...findings, finding]), "utf8") >
          MAX_REVIEW_FINDINGS_BYTES
      ) {
        limitations.add(`review-findings-omitted:navigation:${label.code}`);
        continue;
      }
      findingIds.add(finding.id);
      findings.push(finding);
    }
  }
}

function normalizeFinding(value: ReviewFindingV1): ReviewFindingV1 | null {
  try {
    return normalizeReviewFinding(value);
  } catch {
    return null;
  }
}

const ORIGINATING_FINDING_ID =
  /^finding:(?<skill>lint-documentation|verify-technical-accuracy|review-documentation):(?<issue>[A-Z]+-[0-9]{3}):[0-9]+(?::fact:[0-9]+)?$/u;
const ORIGINATING_ISSUE_REFERENCE = /\b[A-Z]+-[0-9]{3}\b/gu;
const SEVERITY_RANK: Readonly<Record<ReviewFindingV1["severity"], number>> = {
  info: 0,
  warning: 1,
  error: 2,
};

/**
 * The quality evaluator retains each originating technical or editorial issue
 * as its own finding and names the originating ID. Fold that restatement into
 * the originating finding so one issue is listed once: the originating
 * wording and recommendation stay, the stronger severity wins, and the
 * evaluator ID and evidence are appended so both producers stay traceable.
 * Returns null, leaving the evaluator finding listed on its own, unless every
 * named ID resolves to findings from one producer step on the evaluator's
 * path and each target keeps room for the evaluator ID. Folding the same
 * evaluator finding twice appends its trace once.
 */
function foldEvaluatorRestatement(
  findings: readonly ReviewFindingV1[],
  restatement: ReviewFindingV1,
): ReviewFindingV1[] | null {
  const named = new Set(restatement.summary.match(ORIGINATING_ISSUE_REFERENCE) ?? []);
  if (named.size === 0) return null;
  const targets = findings.flatMap((finding, index) => {
    const groups = ORIGINATING_FINDING_ID.exec(finding.id)?.groups;
    return groups?.issue !== undefined && named.has(groups.issue)
      ? [{ index, skill: groups.skill, issue: groups.issue }]
      : [];
  });
  if (
    [...named].some((issueId) => !targets.some((target) => target.issue === issueId)) ||
    new Set(targets.map((target) => target.skill)).size !== 1 ||
    (restatement.path !== null &&
      targets.some((target) => findings[target.index]!.path !== restatement.path))
  ) {
    return null;
  }
  const traceId = `evaluate-document-quality ${restatement.id}`;
  const traces = [
    `${traceId}: ${restatement.evidence ?? "no evidence"}`,
    `${traceId}: evidence retained in the evaluation artifact`,
  ];
  const targetIndexes = new Set(targets.map((target) => target.index));
  const folded = findings.map((finding, index) => {
    if (!targetIndexes.has(index)) return finding;
    const severity =
      SEVERITY_RANK[restatement.severity] > SEVERITY_RANK[finding.severity]
        ? restatement.severity
        : finding.severity;
    if (finding.evidence?.includes(`${traceId}: `)) return { ...finding, severity };
    const evidence = traces
      .map((trace) => (finding.evidence ? `${finding.evidence}; ${trace}` : trace))
      .find((candidate) => truncate(candidate) === candidate);
    return evidence === undefined ? null : normalizeFinding({ ...finding, severity, evidence });
  });
  if (folded.some((finding) => finding === null)) return null;
  return Buffer.byteLength(JSON.stringify(folded), "utf8") > MAX_REVIEW_FINDINGS_BYTES
    ? null
    : (folded as ReviewFindingV1[]);
}

function mergeFindings(
  first: readonly ReviewFindingV1[],
  second: readonly ReviewFindingV1[],
  limitations: Set<string>,
): readonly ReviewFindingV1[] {
  const merged: ReviewFindingV1[] = [];
  const ids = new Set<string>();
  for (const finding of [...first, ...second]) {
    if (ids.has(finding.id)) {
      limitations.add(`review-findings-duplicate:${finding.id}`);
      continue;
    }
    if (merged.length >= MAX_REVIEW_FINDINGS) {
      limitations.add(`review-findings-omitted:${first.length + second.length - merged.length}`);
      break;
    }
    const candidateBytes = Buffer.byteLength(JSON.stringify([...merged, finding]), "utf8");
    if (candidateBytes > MAX_REVIEW_FINDINGS_BYTES) {
      limitations.add(
        `review-findings-omitted-bytes:${first.length + second.length - merged.length}`,
      );
      break;
    }
    ids.add(finding.id);
    merged.push(finding);
  }
  return merged.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

function findingsAvailability(
  findings: readonly ReviewFindingV1[],
  limitations: readonly string[],
  emptyStatus?: "partial" | "unavailable" | "invalid",
): ReviewFindingsAvailability {
  if (findings.length === 0 && emptyStatus) return emptyStatus;
  if (limitations.length === 0) return "complete";
  if (findings.length > 0) return "partial";
  if (
    limitations.some(
      (limitation) =>
        limitation.includes("-invalid:") ||
        limitation.includes("input-too-large") ||
        limitation.includes("omitted"),
    )
  ) {
    return "invalid";
  }
  return limitations.some(
    (limitation) =>
      limitation.startsWith("review-findings-human-review:") ||
      limitation.startsWith("review-findings-coverage-unverified:") ||
      limitation.startsWith("review-findings-fact-inventory-"),
  )
    ? "partial"
    : "unavailable";
}

function freezeProjection(
  findings: readonly ReviewFindingV1[],
  limitations: Set<string>,
  artifactLocator: string | null,
  emptyStatus?: "partial" | "unavailable" | "invalid",
): ProjectedReviewFindingsV1 {
  const sortedLimitations = [...limitations].sort();
  return Object.freeze({
    findings: Object.freeze([...findings]),
    limitations: Object.freeze(sortedLimitations),
    availability: findingsAvailability(findings, sortedLimitations, emptyStatus),
    artifactLocator,
    projector: REVIEW_FINDINGS_PROJECTOR,
  });
}
