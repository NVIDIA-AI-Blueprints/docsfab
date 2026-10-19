// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { DurableArtifactStore } from "../artifacts/index.js";
import { createContractKit, type ContractFail, deepFreeze } from "../contract-kit/index.js";
import type { QualityArtifactCandidateV1 } from "../execution/contracts.js";
import { matchesEvaluationTarget } from "./evaluation-target.js";
import type {
  QualityArtifactDigestBindingV1,
  QualityEvaluatedCandidateV1,
  QualityProfileSelectionReceiptV1,
  RunRecord,
  QualityArtifactValidationBindingV1,
  QualityValidatorInvocationReceiptV1,
} from "../records/contracts.js";
import {
  decodeAuthoringExecutionEvidenceV1,
  decodeRetainedAuthoringWorkflowV1,
} from "../records/authoring-execution.js";
import {
  documentationPlanPagePaths,
  validateAdmittedDocumentationPlanBinding,
} from "../workflow-execution/plan-binding.js";
import type { SelectedDocumentationQualityProfile } from "./quality-profile-selection.js";
import {
  evidenceCitesRepositoryLocator,
  type TechnicalSourceFact,
  type VerificationResult,
} from "../workflow-execution/review-response.js";
import { canonicalJson, sha256 } from "../content-ir/canonical.js";
import type { QualityHostCheckCode } from "./quality-check-rejections.js";

export type QualityArtifactValidationFailureCode = Exclude<
  QualityArtifactValidationBindingV1["failureCode"],
  null
>;
type QualityArtifactStagingKitCode = QualityArtifactValidationFailureCode | "migration-required";

export class QualityArtifactStagingError extends Error {
  public constructor(
    public readonly code: QualityArtifactValidationFailureCode,
    /** The staging rule that refused, when the raising site knows it. */
    public readonly reason?: QualityHostCheckCode,
  ) {
    super(`Quality artifact staging rejected: ${code}.`);
    this.name = "QualityArtifactStagingError";
  }
}

class QualityArtifactSchemaMismatchError extends Error {
  public readonly code = "migration-required" as const;

  public constructor() {
    super("Quality artifact staging requires a record migration.");
    this.name = "QualityArtifactSchemaMismatchError";
  }
}

function fail(code: QualityArtifactStagingKitCode, reason?: QualityHostCheckCode): never {
  if (code === "migration-required") throw new QualityArtifactSchemaMismatchError();
  throw new QualityArtifactStagingError(code, reason);
}

/**
 * Run one staging rule and attach its host code to a refusal that does not
 * name itself, keeping the outer code and error type.
 */
function reasoned<T>(reason: QualityHostCheckCode, rule: () => T): T {
  try {
    return rule();
  } catch (error) {
    throw withReason(error, reason);
  }
}

async function reasonedAsync<T>(reason: QualityHostCheckCode, rule: () => Promise<T>): Promise<T> {
  try {
    return await rule();
  } catch (error) {
    throw withReason(error, reason);
  }
}

function withReason(error: unknown, reason: QualityHostCheckCode): unknown {
  return error instanceof QualityArtifactStagingError && error.reason === undefined
    ? new QualityArtifactStagingError(error.code, reason)
    : error;
}

const kit = createContractKit({
  fail: fail as ContractFail<QualityArtifactStagingKitCode>,
  inertMode: "strict",
  codes: {
    invalidShape: "candidate-invalid",
    invalidValue: "candidate-invalid",
    digestMismatch: "artifact-integrity-invalid",
    credentialMaterial: "candidate-invalid",
    schemaMismatch: "migration-required",
  },
});

type QualityPayloadKind = "evaluation" | "quality-score" | "candidate-report" | "final-report";

export interface StoredQualityArtifactV1 {
  schemaVersion: 1;
  kind: "docsfab-quality-artifact-record";
  artifactKind: QualityPayloadKind;
  runId: string;
  repositoryRevision: string;
  selectionSha256: string;
  evaluatorIdentitySha256: string;
  qualityPackBindingSha256: string;
  payloadSha256: string;
  payload: unknown;
  recordSha256: string;
}

export interface StagedQualityArtifact {
  binding: QualityArtifactDigestBindingV1;
  record: StoredQualityArtifactV1;
}

export interface StagedQualityCandidate {
  evaluation: StagedQualityArtifact;
  qualityScore: StagedQualityArtifact | null;
  candidateReport: StagedQualityArtifact;
}

export interface QualityArtifactBindings {
  runId: string;
  repositoryRevision: string;
  selectionSha256: string;
  evaluatorIdentitySha256: string;
  qualityPackBindingSha256: string;
}

export const TECHNICAL_FACT_TRACE_MAX_VIOLATIONS = 12;

export type TechnicalFactTraceViolationCode =
  | "malformed-candidate"
  | "missing-fact-id"
  | "missing-issue-id"
  | "missing-uncertainty"
  | "missing-source-locator"
  | "missing-inventory-limitation"
  | "missing-unverified-dimension-limitation";

export interface TechnicalFactTraceViolation {
  code: TechnicalFactTraceViolationCode;
  /** The admitted technical fact identity; no candidate content is returned. */
  factId?: string;
}

export type TechnicalFactTraceInspection =
  | { status: "passed"; violations: []; truncated: false }
  | { status: "invalid"; violations: TechnicalFactTraceViolation[]; truncated: boolean };

/** The trusted composition path that determines how technical facts are traced. */
export type TechnicalFactTraceMode = "text" | "records";

class TechnicalFactTraceViolationCollector {
  public readonly violations: TechnicalFactTraceViolation[] = [];
  private total = 0;

  public add(code: TechnicalFactTraceViolationCode, factId?: string): void {
    this.total += 1;
    if (this.violations.length >= TECHNICAL_FACT_TRACE_MAX_VIOLATIONS) return;
    this.violations.push({ code, ...(factId ? { factId } : {}) });
  }

  public result(): TechnicalFactTraceInspection {
    return this.total === 0
      ? { status: "passed", violations: [], truncated: false }
      : {
          status: "invalid",
          violations: this.violations,
          truncated: this.total > this.violations.length,
        };
  }
}

function traceObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Inspect only the technical trace carried by an evaluator draft. The result
 * is content-free except for admitted fact IDs and performs no persistence,
 * validation receipt, filesystem, or provider operation.
 */
export function inspectTechnicalFactTrace(
  evaluation: unknown,
  verification: VerificationResult | undefined,
  mode: TechnicalFactTraceMode = "text",
): TechnicalFactTraceInspection {
  if (!verification) return { status: "passed", violations: [], truncated: false };
  const root = traceObject(evaluation);
  if (!root || !Array.isArray(root.findings) || !Array.isArray(root.limitations)) {
    return {
      status: "invalid",
      violations: [{ code: "malformed-candidate" }],
      truncated: false,
    };
  }
  const findings: Record<string, unknown>[] = [];
  for (const value of root.findings) {
    const finding = traceObject(value);
    if (!finding) {
      return {
        status: "invalid",
        violations: [{ code: "malformed-candidate" }],
        truncated: false,
      };
    }
    findings.push(finding);
  }
  const limitations = root.limitations.filter(
    (limitation): limitation is string => typeof limitation === "string",
  );
  const collector = new TechnicalFactTraceViolationCollector();
  for (const limitation of verification.factInventory.limitations) {
    if (!limitations.includes(limitation)) {
      collector.add("missing-inventory-limitation");
    }
  }
  for (const assessment of verification.factInventory.dimensions) {
    if (
      assessment.status === "unverified" &&
      !limitations.some(
        (limitation) =>
          containsIdentifier(limitation, assessment.dimension) &&
          limitation.includes(assessment.reason),
      )
    ) {
      collector.add("missing-unverified-dimension-limitation");
    }
  }
  if (mode === "records") {
    inspectRenderedFactTrace(findings, verification, collector);
  } else {
    const tracedFindings = findings.map(tracedFinding);
    for (const assessment of verification.factInventory.dimensions) {
      for (const fact of assessment.facts) {
        if (fact.documentationDisposition === "documented") continue;
        const { withFactId, withIssueIds, withUncertainty } = traceChain(fact, tracedFindings);
        if (withFactId.length === 0) {
          collector.add("missing-fact-id", fact.id);
          continue;
        }
        if (withIssueIds.length === 0) {
          collector.add("missing-issue-id", fact.id);
          continue;
        }
        if (withUncertainty.length === 0) {
          collector.add("missing-uncertainty", fact.id);
          continue;
        }
        if (!withUncertainty.some((finding) => citesEvery(finding, fact.sourceLocators))) {
          collector.add("missing-source-locator", fact.id);
        }
      }
    }
  }
  return collector.result();
}

type TracedFact = VerificationResult["factInventory"]["dimensions"][number]["facts"][number];

/**
 * The records composition writes one host evidence item per admitted fact.
 * Its canonical locator string encodes the complete locator array, so a
 * semicolon inside one locator cannot be mistaken for a separator.
 */
export function renderAdmittedTechnicalFactEvidence(
  fact: TechnicalSourceFact,
): HostRenderedTechnicalFactEvidence {
  const description = canonicalJson({
    factId: fact.id,
    statement: fact.statement,
    uncertainty: fact.uncertainty,
    issueIds: fact.issueIds,
  });
  return {
    ...HOST_RENDERED_TECHNICAL_FACT_EVIDENCE,
    locator: canonicalJson(fact.sourceLocators),
    description,
  };
}

export interface HostRenderedTechnicalFactEvidence {
  evidence_class: "grounded-judgment";
  strength: "derived";
  provider_id: "docsfab-host-fact-render";
  locator: string;
  description: string;
}

export const HOST_RENDERED_TECHNICAL_FACT_EVIDENCE = Object.freeze({
  evidence_class: "grounded-judgment",
  strength: "derived",
  provider_id: "docsfab-host-fact-render",
} as const);

function inspectRenderedFactTrace(
  findings: readonly Record<string, unknown>[],
  verification: VerificationResult,
  collector: TechnicalFactTraceViolationCollector,
): void {
  const facts = verification.factInventory.dimensions.flatMap(({ facts }) => facts);
  const expected = facts.map((fact) => renderAdmittedTechnicalFactEvidence(fact));
  const expectedJson = new Set(expected.map((item) => canonicalJson(item)));
  const renderedByFinding = findings.map((finding) => hostRenderedEvidence(finding.evidence));

  // A marker alone is not provenance. Every marked row must exactly equal a
  // renderer output for this admitted verification result.
  for (const rows of renderedByFinding) {
    for (const row of rows) {
      if (!expectedJson.has(canonicalJson(row))) collector.add("malformed-candidate");
    }
  }

  for (const fact of facts) {
    if (fact.documentationDisposition === "documented") continue;
    const factRow = renderAdmittedTechnicalFactEvidence(fact);
    if (fact.issueIds.length === 0) collector.add("missing-issue-id", fact.id);
    if (fact.sourceLocators.length === 0) {
      collector.add("missing-source-locator", fact.id);
      continue;
    }
    const expectedRow = canonicalJson(factRow);
    const renderedFindings = renderedByFinding.map((rows) =>
      rows.filter((row) => row.description === factRow.description),
    );
    if (renderedFindings.every((rows) => rows.length === 0)) {
      collector.add("missing-fact-id", fact.id);
      continue;
    }
    const completeOnOneFinding = renderedFindings.some(
      (rows) => rows.length === 1 && canonicalJson(rows[0]) === expectedRow,
    );
    if (!completeOnOneFinding) {
      const matchingDescriptionExists = renderedFindings.some((rows) => rows.length > 0);
      collector.add(
        matchingDescriptionExists ? "malformed-candidate" : "missing-source-locator",
        fact.id,
      );
    }
  }
}

function hostRenderedEvidence(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const evidence = entry as Record<string, unknown>;
    return isHostRenderedTechnicalFactEvidence(evidence) ? [evidence] : [];
  });
}

function isHostRenderedTechnicalFactEvidence(evidence: Record<string, unknown>): boolean {
  return evidence.provider_id === HOST_RENDERED_TECHNICAL_FACT_EVIDENCE.provider_id;
}

interface TracedFinding {
  /** Model-authored text only; host-carried evidence never links a fact. */
  readonly fields: readonly string[];
  /** Every evidence `locator` field, unsplit, including host-carried ones. */
  readonly locators: string[];
}

function tracedFinding(finding: Record<string, unknown>): TracedFinding {
  return { fields: sanctionedFindingText(finding), locators: sanctionedFindingLocators(finding) };
}

/** The locator grammar, not a `;` split, decides what an evidence field cites. */
function citesEvery(finding: TracedFinding, required: readonly string[]): boolean {
  return required.every((locator) => citesLocator(finding, locator));
}

function citesLocator(finding: TracedFinding, locator: string): boolean {
  return finding.locators.some((field) => evidenceCitesRepositoryLocator(field, locator));
}

/**
 * One fact's trace chain: findings naming its ID, then also every issue ID it
 * lists, then also its exact uncertainty. The trace check and the host locator
 * carry share it so they cannot disagree about which finding traces a fact.
 */
function traceChain(
  fact: TracedFact,
  tracedFindings: readonly TracedFinding[],
): {
  withFactId: TracedFinding[];
  withIssueIds: TracedFinding[];
  withUncertainty: TracedFinding[];
} {
  const withFactId = tracedFindings.filter(({ fields }) =>
    fields.some((field) => containsIdentifier(field, fact.id)),
  );
  const withIssueIds = withFactId.filter(({ fields }) =>
    fact.issueIds.every((issueId) => fields.some((field) => containsIdentifier(field, issueId))),
  );
  const withUncertainty = withIssueIds.filter(({ fields }) =>
    fields.some((field) => field.includes(fact.uncertainty)),
  );
  return { withFactId, withIssueIds, withUncertainty };
}

/**
 * Marks a host-carried locator entry as host-added, so the trace check never
 * reads its text as a model-authored fact, issue, or uncertainty link.
 */
export const HOST_CARRIED_LOCATOR_EVIDENCE = Object.freeze({
  evidence_class: "grounded-judgment",
  strength: "derived",
  provider_id: "docsfab-host-locator-carry",
} as const);

function isHostCarriedEvidence(evidence: Record<string, unknown>): boolean {
  return evidence.provider_id === HOST_CARRIED_LOCATOR_EVIDENCE.provider_id;
}

/** Fixed text whose only variable part is the admitted fact ID. */
export function hostCarriedLocatorDescription(factId: string): string {
  return `Source locator of admitted technical fact ${factId}, carried by the host from the admitted technical verification result.`;
}

/**
 * Carry each non-documented fact's admitted source locators onto the finding
 * that already traces it, so the model need not copy host data byte for byte.
 *
 * The evaluator still owns the trace link (fact ID, issue IDs, exact
 * uncertainty). When no linked finding cites all of a fact's locators, the host
 * appends to the first linked finding one host-marked entry per missing
 * locator; one per entry keeps a locator containing `;` whole. A fact with no
 * linked finding gets nothing, so a missing link still fails the trace check,
 * and `inspectTechnicalFactTrace` still checks every staged artifact in full.
 * A non-array `evidence` is left for the schema validator. Returns `candidate`
 * itself when nothing is carried, and never mutates it.
 */
export function carryAdmittedTechnicalLocators(
  candidate: QualityArtifactCandidateV1,
  verification: VerificationResult | undefined,
  mode: TechnicalFactTraceMode = "text",
): QualityArtifactCandidateV1 {
  if (mode === "records") return candidate;
  const root = traceObject(candidate.evaluation);
  if (!verification || !root || !Array.isArray(root.findings)) return candidate;
  const findings: Record<string, unknown>[] = [];
  for (const value of root.findings) {
    const finding = traceObject(value);
    if (!finding) return candidate;
    findings.push(finding);
  }
  const tracedFindings = findings.map(tracedFinding);
  const carried = new Map<number, Record<string, unknown>[]>();
  for (const assessment of verification.factInventory.dimensions) {
    for (const fact of assessment.facts) {
      if (fact.documentationDisposition === "documented") continue;
      const { withUncertainty } = traceChain(fact, tracedFindings);
      const target = withUncertainty[0];
      if (!target || withUncertainty.some((finding) => citesEvery(finding, fact.sourceLocators))) {
        continue;
      }
      const index = tracedFindings.indexOf(target);
      if (!Array.isArray(findings[index]!.evidence)) continue;
      const missing = [
        ...new Set(fact.sourceLocators.filter((required) => !citesLocator(target, required))),
      ];
      target.locators.push(...missing);
      carried.set(index, [
        ...(carried.get(index) ?? []),
        ...missing.map((locator) => ({
          ...HOST_CARRIED_LOCATOR_EVIDENCE,
          locator,
          description: hostCarriedLocatorDescription(fact.id),
        })),
      ]);
    }
  }
  if (carried.size === 0) return candidate;
  return {
    ...candidate,
    evaluation: {
      ...root,
      findings: findings.map((finding, index) => {
        const added = carried.get(index);
        return added
          ? { ...finding, evidence: [...(finding.evidence as unknown[]), ...added] }
          : finding;
      }),
    },
  };
}

/**
 * Require a schema-valid final evaluation to retain every material obligation
 * from the admitted current technical inventory. This reads only structured
 * evaluation fields; report prose and historical summaries never mint trace.
 */
export function assertTechnicalFactTrace(
  evaluation: unknown,
  verification: VerificationResult | undefined,
  mode: TechnicalFactTraceMode = "text",
): void {
  if (!verification) return;
  // Preserve the existing malformed-object contract for final admission.
  const root = qualityObject(evaluation);
  if (Array.isArray(root.findings)) {
    for (const finding of root.findings) qualityObject(finding);
  }
  if (inspectTechnicalFactTrace(evaluation, verification, mode).status === "invalid") {
    fail("technical-trace-incomplete");
  }
}

function sanctionedFindingText(finding: Record<string, unknown>): string[] {
  return [
    finding.id,
    finding.description,
    finding.acceptance_condition,
    finding.resolution,
    finding.dismissal_rationale,
    ...sanctionedEvidenceText(finding.evidence),
    ...sanctionedEvidenceText(finding.verification_evidence),
  ].filter((value): value is string => typeof value === "string");
}

function sanctionedEvidenceText(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const evidence = entry as Record<string, unknown>;
    if (isHostCarriedEvidence(evidence) || isHostRenderedTechnicalFactEvidence(evidence)) return [];
    return [evidence.locator, evidence.description].filter(
      (field): field is string => typeof field === "string",
    );
  });
}

function sanctionedFindingLocators(finding: Record<string, unknown>): string[] {
  return [finding.evidence, finding.verification_evidence].flatMap((value) => {
    if (!Array.isArray(value)) return [];
    return value.flatMap((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
      const evidence = entry as Record<string, unknown>;
      if (isHostRenderedTechnicalFactEvidence(evidence)) return [];
      const locator = evidence.locator;
      return typeof locator === "string" ? [locator] : [];
    });
  });
}

function containsIdentifier(value: string, identifier: string): boolean {
  return value.split(/[^A-Za-z0-9_-]+/u).some((candidate) => candidate === identifier);
}

export async function stageQualityArtifactCandidate(input: {
  store: DurableArtifactStore;
  candidate: QualityArtifactCandidateV1;
  selection: SelectedDocumentationQualityProfile;
  bindings: QualityArtifactBindings;
}): Promise<StagedQualityCandidate> {
  const { candidate, selection, bindings } = input;
  preflightQualityArtifactCandidateContent(candidate);
  reasoned("candidate-envelope-shape", () =>
    kit.exact(kit.object(candidate), [
      "evaluation",
      "qualityScore",
      "reportMarkdown",
      "selectionSha256",
    ]),
  );
  if (candidate.selectionSha256 !== selection.receipt.selectionSha256) {
    fail("candidate-invalid", "candidate-selection-mismatch");
  }
  validateBindings(bindings, selection);
  const { evaluation, profile, target } = reasoned("candidate-evaluation-shape", () => {
    const evaluation = qualityObject(candidate.evaluation);
    return {
      evaluation,
      profile: qualityObject(evaluation.profile),
      target: qualityObject(evaluation.target),
    };
  });
  const targetPaths = Array.isArray(target.paths)
    ? target.paths.map((path) => (typeof path === "string" ? path.replace(/\/$/u, "") : ""))
    : [];
  reasoned("candidate-target-paths-invalid", () => kit.unique(targetPaths));
  if (
    profile.id !== selection.receipt.profileId ||
    profile.version !== selection.receipt.profileVersion
  ) {
    fail("candidate-invalid", "candidate-profile-mismatch");
  }
  if (evaluation.model_version !== selection.receipt.profileModel) {
    fail("candidate-invalid", "candidate-model-version-mismatch");
  }
  if (target.scope_type !== "documentation-set") {
    fail("candidate-invalid", "candidate-scope-type-invalid");
  }
  if (target.repository_revision !== bindings.repositoryRevision) {
    fail("candidate-invalid", "candidate-revision-mismatch");
  }
  if (targetPaths.length === 0) fail("candidate-invalid", "candidate-target-paths-invalid");
  if (!Array.isArray(selection.evaluationTarget)) {
    fail("candidate-invalid", "candidate-host-binding-mismatch");
  }
  // The host writes the bound target before staging, so a mismatch here is a host defect.
  if (
    !matchesEvaluationTarget(
      (target.paths as unknown[]).map((path) => (typeof path === "string" ? path : "")),
      selection.evaluationTarget.map((entry) => entry.path),
    )
  ) {
    fail("target-scope-mismatch", "candidate-target-outside-scope");
  }
  const qualityScore = reasoned("candidate-quality-score-shape", () =>
    candidate.qualityScore === null ? null : qualityObject(candidate.qualityScore),
  );
  if (
    typeof candidate.reportMarkdown !== "string" ||
    !candidate.reportMarkdown.trim() ||
    Buffer.byteLength(candidate.reportMarkdown, "utf8") > 2 * 1024 * 1024
  ) {
    fail("candidate-invalid", "candidate-report-invalid");
  }
  const reportMarkdown = candidate.reportMarkdown;
  const [stagedEvaluation, stagedScore, stagedReport] = await reasonedAsync(
    "candidate-artifact-unstored",
    () =>
      Promise.all([
        persistQualityPayload(input.store, "evaluation", evaluation, bindings),
        qualityScore
          ? persistQualityPayload(input.store, "quality-score", qualityScore, bindings)
          : Promise.resolve(null),
        persistQualityPayload(input.store, "candidate-report", reportMarkdown, bindings),
      ]),
  );
  return deepFreeze({
    evaluation: stagedEvaluation,
    qualityScore: stagedScore,
    candidateReport: stagedReport,
  });
}

/** Proves that fallback report retention cannot persist model or SCM credentials. */
export function preflightQualityArtifactCandidateContent(
  candidate: QualityArtifactCandidateV1,
): string {
  reasoned("candidate-not-inert", () => kit.assertInert(candidate));
  reasoned("candidate-credential-material", () => kit.rejectCredentials(candidate));
  const root = reasoned("candidate-envelope-shape", () => kit.object(candidate));
  if (
    typeof root.reportMarkdown !== "string" ||
    !root.reportMarkdown.trim() ||
    Buffer.byteLength(root.reportMarkdown, "utf8") > 2 * 1024 * 1024
  ) {
    fail("candidate-invalid", "candidate-report-invalid");
  }
  return root.reportMarkdown;
}

export async function stageFinalQualityReport(input: {
  store: DurableArtifactStore;
  reportMarkdown: string;
  bindings: QualityArtifactBindings;
}): Promise<StagedQualityArtifact> {
  if (
    typeof input.reportMarkdown !== "string" ||
    !input.reportMarkdown.trim() ||
    Buffer.byteLength(input.reportMarkdown, "utf8") > 2 * 1024 * 1024
  ) {
    fail("candidate-invalid", "final-report-invalid");
  }
  return reasonedAsync("final-report-unstored", () =>
    persistQualityPayload(input.store, "final-report", input.reportMarkdown, input.bindings),
  );
}

export async function loadStagedQualityArtifact(
  store: DurableArtifactStore,
  digest: string,
): Promise<StoredQualityArtifactV1> {
  return reasonedAsync("staged-artifact-unreadable", async () => {
    try {
      return decodeStoredQualityArtifact(await store.getRecord(kit.hash(digest)));
    } catch (error) {
      if (
        error instanceof QualityArtifactStagingError ||
        error instanceof QualityArtifactSchemaMismatchError
      ) {
        throw error;
      }
      fail("artifact-integrity-invalid", "staged-artifact-unreadable");
    }
  });
}

export function sealQualityValidatorReceipt(
  body: Omit<QualityValidatorInvocationReceiptV1, "schemaVersion" | "kind" | "receiptSha256">,
): QualityValidatorInvocationReceiptV1 {
  return kit.seal(
    "docsfab-quality-validator-invocation-receipt",
    "receiptSha256",
    body,
  ) as QualityValidatorInvocationReceiptV1;
}

export function decodeQualityValidatorReceipt(value: unknown): QualityValidatorInvocationReceiptV1 {
  return kit.decodeSealed(
    value,
    "docsfab-quality-validator-invocation-receipt",
    "receiptSha256",
    [
      "validator",
      "program",
      "scriptSha256",
      "inputPayloadSha256s",
      "outcome",
      "exitCode",
      "stdoutSha256",
      "stderrSha256",
    ],
    (root) => {
      const outcome = kit.enumeration(root.outcome, ["passed", "failed", "unavailable"] as const);
      const exitCode =
        root.exitCode === null
          ? null
          : typeof root.exitCode === "number" && Number.isSafeInteger(root.exitCode)
            ? root.exitCode
            : fail("artifact-integrity-invalid");
      if (
        (outcome === "passed" && exitCode !== 0) ||
        (outcome === "unavailable" && exitCode !== null)
      ) {
        fail("artifact-integrity-invalid");
      }
      if (
        !Array.isArray(root.inputPayloadSha256s) ||
        root.inputPayloadSha256s.length < 1 ||
        root.inputPayloadSha256s.length > 4
      ) {
        fail("artifact-integrity-invalid");
      }
      return {
        validator: kit.enumeration(root.validator, [
          "evaluation",
          "quality-score",
          "report-binding",
        ] as const),
        program: root.program === "python3" ? "python3" : fail("artifact-integrity-invalid"),
        scriptSha256: kit.hash(root.scriptSha256),
        inputPayloadSha256s: root.inputPayloadSha256s.map((digest) => kit.hash(digest)),
        outcome,
        exitCode,
        stdoutSha256: kit.hash(root.stdoutSha256),
        stderrSha256: kit.hash(root.stderrSha256),
      };
    },
  ) as QualityValidatorInvocationReceiptV1;
}

export function sealQualityValidationBinding(
  body: Omit<QualityArtifactValidationBindingV1, "schemaVersion" | "kind" | "bindingSha256">,
): QualityArtifactValidationBindingV1 {
  return kit.seal(
    "docsfab-quality-artifact-validation-binding",
    "bindingSha256",
    body,
  ) as QualityArtifactValidationBindingV1;
}

export function decodeQualityValidationBinding(value: unknown): QualityArtifactValidationBindingV1 {
  kit.assertInert(value);
  const root = kit.object(value);
  const hasHostDerivationCounts = Object.hasOwn(root, "hostDerivationCounts");
  const bodyKeys = [
    "runId",
    "repositoryRevision",
    "selectionSha256",
    "qualityPackBindingSha256",
    "evaluatorIdentitySha256",
    "status",
    "failureCode",
    "artifacts",
    "validatorAssets",
    "validators",
    ...(hasHostDerivationCounts ? ["hostDerivationCounts"] : []),
    ...(Object.hasOwn(root, "evaluatedCandidate") ? ["evaluatedCandidate"] : []),
  ];
  return kit.decodeSealed(
    value,
    "docsfab-quality-artifact-validation-binding",
    "bindingSha256",
    bodyKeys,
    (root) => {
      const status = kit.enumeration(root.status, ["passed", "failed", "incomplete"] as const);
      const failureCode =
        root.failureCode === null
          ? null
          : kit.enumeration(root.failureCode, [
              "candidate-invalid",
              "target-scope-mismatch",
              "evaluation-invalid",
              "quality-score-invalid",
              "report-binding-invalid",
              "validator-unavailable",
              "validator-integrity-invalid",
              "artifact-integrity-invalid",
              "technical-trace-incomplete",
            ] as const);
      if ((status === "passed") !== (failureCode === null)) fail("artifact-integrity-invalid");
      const artifacts = kit.object(root.artifacts);
      kit.exact(artifacts, ["evaluation", "qualityScore", "candidateReport", "finalReport"]);
      const validators = kit.object(root.validators);
      kit.exact(validators, ["evaluation", "qualityScore", "reportBinding"]);
      const validatorAssets = kit.object(root.validatorAssets);
      const hasQualityRuleModuleSha256 = Object.hasOwn(validatorAssets, "qualityRuleModuleSha256");
      kit.exact(validatorAssets, [
        "evaluationScriptSha256",
        "evaluationSchemaSha256",
        "qualityScoreScriptSha256",
        "reportScriptSha256",
        ...(hasQualityRuleModuleSha256 ? ["qualityRuleModuleSha256"] : []),
      ]);
      const hostDerivationCounts =
        root.hostDerivationCounts === undefined
          ? undefined
          : decodeQualityHostDerivationCounts(root.hostDerivationCounts);
      return {
        ...(root.evaluatedCandidate === undefined
          ? {}
          : { evaluatedCandidate: decodeQualityEvaluatedCandidate(root.evaluatedCandidate) }),
        runId: kit.identifier(root.runId),
        repositoryRevision: kit.revision(root.repositoryRevision),
        selectionSha256: kit.hash(root.selectionSha256),
        qualityPackBindingSha256: kit.hash(root.qualityPackBindingSha256),
        evaluatorIdentitySha256: kit.hash(root.evaluatorIdentitySha256),
        status,
        failureCode,
        artifacts: {
          evaluation:
            artifacts.evaluation === null ? null : decodeDigestBinding(artifacts.evaluation),
          qualityScore:
            artifacts.qualityScore === null ? null : decodeDigestBinding(artifacts.qualityScore),
          candidateReport:
            artifacts.candidateReport === null
              ? null
              : decodeDigestBinding(artifacts.candidateReport),
          finalReport:
            artifacts.finalReport === null ? null : decodeDigestBinding(artifacts.finalReport),
        },
        validatorAssets: {
          ...(hasQualityRuleModuleSha256
            ? { qualityRuleModuleSha256: kit.hash(validatorAssets.qualityRuleModuleSha256) }
            : {}),
          evaluationScriptSha256: kit.hash(validatorAssets.evaluationScriptSha256),
          evaluationSchemaSha256: kit.hash(validatorAssets.evaluationSchemaSha256),
          qualityScoreScriptSha256: kit.hash(validatorAssets.qualityScoreScriptSha256),
          reportScriptSha256: kit.hash(validatorAssets.reportScriptSha256),
        },
        validators: {
          evaluation:
            validators.evaluation === null
              ? null
              : decodeQualityValidatorReceipt(validators.evaluation),
          qualityScore:
            validators.qualityScore === null
              ? null
              : decodeQualityValidatorReceipt(validators.qualityScore),
          reportBinding:
            validators.reportBinding === null
              ? null
              : decodeQualityValidatorReceipt(validators.reportBinding),
        },
        ...(hostDerivationCounts ? { hostDerivationCounts } : {}),
      };
    },
  ) as QualityArtifactValidationBindingV1;
}

function decodeQualityHostDerivationCounts(value: unknown): {
  schemaVersion: 1;
  kind: "docsfab-quality-host-derivation-counts";
  hostMetadataFieldsChanged: number;
  ruleDerivedFieldsChanged: number;
  duplicateLimitationsRemoved: number;
  coherenceLabelsCount: number;
} {
  const root = kit.object(value);
  kit.exact(root, [
    "schemaVersion",
    "kind",
    "hostMetadataFieldsChanged",
    "ruleDerivedFieldsChanged",
    "duplicateLimitationsRemoved",
    "coherenceLabelsCount",
  ]);
  const count = (candidate: unknown): number => {
    if (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate < 0) {
      fail("artifact-integrity-invalid");
    }
    return candidate;
  };
  if (root.schemaVersion !== 1 || root.kind !== "docsfab-quality-host-derivation-counts") {
    fail("artifact-integrity-invalid");
  }
  return {
    schemaVersion: 1,
    kind: "docsfab-quality-host-derivation-counts",
    hostMetadataFieldsChanged: count(root.hostMetadataFieldsChanged),
    ruleDerivedFieldsChanged: count(root.ruleDerivedFieldsChanged),
    duplicateLimitationsRemoved: count(root.duplicateLimitationsRemoved),
    coherenceLabelsCount: count(root.coherenceLabelsCount),
  };
}

function validateBindings(
  bindings: QualityArtifactBindings,
  selection: SelectedDocumentationQualityProfile,
): void {
  reasoned("candidate-host-binding-mismatch", () => {
    if (
      kit.revision(bindings.repositoryRevision) !== selection.receipt.repositoryRevision ||
      kit.hash(bindings.selectionSha256) !== selection.receipt.selectionSha256 ||
      kit.hash(bindings.qualityPackBindingSha256) !== selection.receipt.qualityPackBindingSha256
    ) {
      fail("candidate-invalid", "candidate-host-binding-mismatch");
    }
    kit.identifier(bindings.runId);
    kit.hash(bindings.evaluatorIdentitySha256);
  });
}

async function persistQualityPayload(
  store: DurableArtifactStore,
  artifactKind: QualityPayloadKind,
  payload: unknown,
  bindings: QualityArtifactBindings,
): Promise<StagedQualityArtifact> {
  kit.assertInert(payload);
  const payloadSha256 =
    typeof payload === "string"
      ? sha256(Buffer.from(payload, "utf8"))
      : sha256(Buffer.from(kit.canonicalJson(payload), "utf8"));
  const record = kit.seal("docsfab-quality-artifact-record", "recordSha256", {
    artifactKind,
    runId: kit.identifier(bindings.runId),
    repositoryRevision: kit.revision(bindings.repositoryRevision),
    selectionSha256: kit.hash(bindings.selectionSha256),
    evaluatorIdentitySha256: kit.hash(bindings.evaluatorIdentitySha256),
    qualityPackBindingSha256: kit.hash(bindings.qualityPackBindingSha256),
    payloadSha256,
    payload: structuredClone(payload),
  }) as StoredQualityArtifactV1;
  try {
    await store.putRecord(record.recordSha256, record);
    const loaded = await loadStagedQualityArtifact(store, record.recordSha256);
    if (loaded.payloadSha256 !== payloadSha256) fail("artifact-integrity-invalid");
  } catch (error) {
    if (
      error instanceof QualityArtifactStagingError ||
      error instanceof QualityArtifactSchemaMismatchError
    ) {
      throw error;
    }
    fail("artifact-integrity-invalid");
  }
  return deepFreeze({
    binding: { recordSha256: record.recordSha256, payloadSha256 },
    record,
  });
}

export function decodeStoredQualityArtifact(value: unknown): StoredQualityArtifactV1 {
  return kit.decodeSealed(
    value,
    "docsfab-quality-artifact-record",
    "recordSha256",
    [
      "artifactKind",
      "runId",
      "repositoryRevision",
      "selectionSha256",
      "evaluatorIdentitySha256",
      "qualityPackBindingSha256",
      "payloadSha256",
      "payload",
    ],
    (root) => {
      const artifactKind = kit.enumeration(root.artifactKind, [
        "evaluation",
        "quality-score",
        "candidate-report",
        "final-report",
      ] as const);
      kit.assertInert(root.payload);
      const expectedPayloadSha256 =
        typeof root.payload === "string"
          ? sha256(Buffer.from(root.payload, "utf8"))
          : sha256(Buffer.from(kit.canonicalJson(root.payload), "utf8"));
      if (kit.hash(root.payloadSha256) !== expectedPayloadSha256) {
        fail("artifact-integrity-invalid");
      }
      return {
        artifactKind,
        runId: kit.identifier(root.runId),
        repositoryRevision: kit.revision(root.repositoryRevision),
        selectionSha256: kit.hash(root.selectionSha256),
        evaluatorIdentitySha256: kit.hash(root.evaluatorIdentitySha256),
        qualityPackBindingSha256: kit.hash(root.qualityPackBindingSha256),
        payloadSha256: expectedPayloadSha256,
        payload: structuredClone(root.payload),
      };
    },
  ) as StoredQualityArtifactV1;
}

function decodeDigestBinding(value: unknown): QualityArtifactDigestBindingV1 {
  const root = kit.object(value);
  kit.exact(root, ["recordSha256", "payloadSha256"]);
  return { recordSha256: kit.hash(root.recordSha256), payloadSha256: kit.hash(root.payloadSha256) };
}

function qualityObject(value: unknown): Record<string, unknown> {
  kit.assertInert(value);
  return kit.object(value);
}

export function decodeQualityEvaluatedCandidate(value: unknown): QualityEvaluatedCandidateV1 {
  kit.assertInert(value);
  const root = kit.object(value);
  kit.exact(root, [
    "workflow",
    "targetPaths",
    "patchSha256",
    "workspaceSnapshotSha256",
    "candidateOrdinal",
    "candidateDigest",
  ]);
  const workflow = kit.enumeration(root.workflow, [
    "create-documentation",
    "update-documentation",
  ] as const);
  if (!Array.isArray(root.targetPaths) || root.targetPaths.length === 0)
    fail("target-scope-mismatch");
  const targetPaths = root.targetPaths.map((path) => kit.string(path));
  kit.unique(targetPaths);
  if (root.candidateOrdinal !== null && root.candidateOrdinal !== 0 && root.candidateOrdinal !== 1)
    fail("candidate-invalid");
  const candidateOrdinal = root.candidateOrdinal as 0 | 1 | null;
  const candidateDigest = root.candidateDigest === null ? null : kit.hash(root.candidateDigest);
  if (
    (workflow === "create-documentation" &&
      (candidateOrdinal === null || candidateDigest === null)) ||
    (workflow === "update-documentation" && (candidateOrdinal !== null || candidateDigest !== null))
  )
    fail("candidate-invalid");
  return {
    workflow,
    targetPaths,
    candidateOrdinal,
    candidateDigest,
    patchSha256: kit.hash(root.patchSha256),
    workspaceSnapshotSha256: kit.hash(root.workspaceSnapshotSha256),
  };
}

/** Match authored quality to the retained final bytes; a valid report alone is insufficient. */
export function assertAuthoringQualityValidationBinding(
  record: Pick<
    RunRecord,
    "id" | "workflow" | "repository" | "changes" | "steps" | "authoringExecution"
  >,
  binding: QualityArtifactValidationBindingV1,
  selection: QualityProfileSelectionReceiptV1,
): void {
  if (
    selection.workflow !== record.workflow ||
    binding.runId !== record.id ||
    binding.repositoryRevision !== record.repository.revision
  )
    fail("artifact-integrity-invalid");
  if (record.workflow !== "create-documentation" && record.workflow !== "update-documentation")
    return;
  const candidate = decodeQualityEvaluatedCandidate(binding.evaluatedCandidate);
  if (
    candidate.workflow !== record.workflow ||
    candidate.patchSha256 !== record.changes?.patch?.sha256
  )
    fail("artifact-integrity-invalid");
  const targetDigest = kit.canonicalDigest({
    repositoryIdentitySha256: selection.repositoryIdentitySha256,
    repositoryRevision: selection.repositoryRevision,
    scope: "documentation-set",
    paths: [...candidate.targetPaths],
  });
  if (targetDigest !== selection.targetPathSetSha256) fail("target-scope-mismatch");
  if (record.workflow === "create-documentation") {
    const workflow = decodeRetainedAuthoringWorkflowV1(record.authoringExecution);
    const execution = decodeAuthoringExecutionEvidenceV1(record.authoringExecution, workflow);
    const selected = execution.selectedCandidate;
    const retained =
      selected === null ? undefined : execution.candidates[selected.ordinal]?.candidate;
    if (
      execution.runId !== record.id ||
      execution.repositoryRevision !== record.repository.revision ||
      !selected ||
      !retained ||
      candidate.candidateOrdinal !== selected.ordinal ||
      candidate.candidateDigest !== selected.digest ||
      candidate.workspaceSnapshotSha256 !== retained.workspaceSnapshotDigest ||
      candidate.patchSha256 !== retained.patchDigestSha256 ||
      candidate.patchSha256 !== execution.finalPatch?.sha256 ||
      kit.canonicalDigest([...candidate.targetPaths]) !==
        kit.canonicalDigest([...execution.writePaths].sort())
    )
      fail("artifact-integrity-invalid");
  } else {
    const plan = record.steps.find((step) => step.id === "plan-documentation")?.planBinding;
    if (!plan) fail("target-scope-mismatch");
    const admitted = validateAdmittedDocumentationPlanBinding(plan);
    if (
      kit.canonicalDigest([...candidate.targetPaths]) !==
      kit.canonicalDigest([...documentationPlanPagePaths(admitted)].sort())
    )
      fail("target-scope-mismatch");
  }
}
