// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Promote a deterministic qualification-candidate to qualified.
 *
 * Only an opaque freeze admission plus an independent-review authority can emit
 * `qualified`. Self-consistent oracle/manifest rewrites fail the authorized
 * freeze. Fabricated report, session, or digest values cannot mint review.
 * This module is not selected from `docsfab run`.
 */

import { canonicalDigest, createContractKit, type ContractFail } from "../contract-kit/index.js";
import {
  decodeQualificationCorpusBindings,
  decodeReviewBinding,
  requireQualificationFreeze,
  requireQualificationReview,
  type QualificationCorpusBindingsV1,
  type QualificationFreezeAdmissionV1,
  type QualificationFreezeAuthority,
  type QualificationReviewAuthority,
  type QualificationReviewBindingV1,
} from "./freeze-authorization.js";

export const QUALIFICATION_CANDIDATE_KIND = "docsfab-model-role-qualification-record" as const;
export const QUALIFICATION_FINAL_KIND = "docsfab-harness-qualification-final" as const;

export const QUALIFICATION_HARD_GATE_IDS = [
  "schema-conformance",
  "harness-attestation-controls",
  "exact-model-identity",
  "zero-unsupported-findings",
  "clean-negative-control",
  "independent-review",
] as const;

export const QUALIFICATION_REQUALIFICATION_TRIGGERS = [
  "model-identity-change",
  "route-change",
  "harness-change",
  "adapter-change",
  "executable-change",
  "corpus-change",
  "skill-change",
  "quality-policy-change",
  "output-schema-change",
  "threshold-change",
  "scorer-change",
] as const;

export type QualificationFinalizerErrorCode =
  | "invalid-shape"
  | "invalid-value"
  | "digest-mismatch"
  | "credential-material"
  | "migration-required"
  | "schema-mismatch"
  | "not-a-candidate";

export class QualificationFinalizerError extends Error {
  public constructor(public readonly code: QualificationFinalizerErrorCode) {
    super(`Harness qualification finalizer rejected (${code}).`);
    this.name = "QualificationFinalizerError";
  }
}

function fail(code: QualificationFinalizerErrorCode): never {
  throw new QualificationFinalizerError(code);
}

const kit = createContractKit({
  fail: fail as ContractFail<QualificationFinalizerErrorCode>,
  inertMode: "strict",
  codes: {
    invalidShape: "invalid-shape",
    invalidValue: "invalid-value",
    digestMismatch: "digest-mismatch",
    credentialMaterial: "credential-material",
    schemaMismatch: "migration-required",
  },
});

const QUALIFICATION_ID = /^mrq-[a-z0-9][a-z0-9-]{7,127}$/u;
const SESSION_ID =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/u;
const SUBJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._:/+@-]{0,255}$/u;
const RUN_ID = /^run-[1-5]$/u;
const DEFECT_IDS = [
  "SOURCE-DRIFT-001",
  "SOURCE-DRIFT-002",
  "SOURCE-DRIFT-003",
  "SOURCE-DRIFT-004",
  "SOURCE-DRIFT-005",
] as const;

export interface QualificationCandidateRecordV1 {
  readonly schema_version: 1;
  readonly kind: typeof QUALIFICATION_CANDIDATE_KIND;
  readonly qualification_id: string;
  readonly subject: {
    readonly candidate_id: string;
    readonly model_id: string;
    readonly observed_model_id: string;
    readonly route_class: "opaque-cli-managed";
    readonly harness_id: "claude-code";
    readonly adapter_version: string;
    readonly auth_mechanism_class: "enterprise-oauth" | "api-key" | "unknown";
    readonly executable_sha256: string;
  };
  readonly bindings: QualificationCorpusBindingsV1;
  readonly role: "technical-review";
  readonly role_score: {
    readonly rubric_id: "technical-review-source-drift-v1";
    readonly score: number;
    readonly threshold: 5;
    readonly decision: "pass";
  };
  readonly hard_gates: readonly {
    readonly check_id: (typeof QUALIFICATION_HARD_GATE_IDS)[number];
    readonly status: "pass";
  }[];
  readonly campaign: {
    readonly required_runs: 5;
    readonly passing_runs: 5;
    readonly all_runs_passed: true;
    readonly runs: readonly QualificationCandidateRunV1[];
    readonly negative_control: QualificationNegativeControlV1;
  };
  readonly independent_evaluation: {
    readonly evaluator_id: string;
    readonly session_id: string;
    readonly prior_context_policy: "none";
    readonly subject_sha256: string;
    readonly report_sha256: string;
    readonly attestation_sha256: string;
    readonly decision: "accepted";
    readonly unresolved_finding_count: 0;
  };
  readonly sanitization: {
    readonly credential_scan: "passed";
    readonly raw_capture_retained: false;
    readonly record_contains_content: false;
  };
  readonly technical_profile_approval: "not-established";
  readonly decision: "qualification-candidate";
  readonly role_generalization: "none";
  readonly requalification_triggers: readonly (typeof QUALIFICATION_REQUALIFICATION_TRIGGERS)[number][];
  readonly evaluated_at: string;
}

export interface QualificationCandidateRunV1 {
  readonly run_id: string;
  readonly session_id: string;
  readonly attestation_sha256: string;
  readonly result_sha256: string;
  readonly observed_model_id: string;
  readonly role: "technical-review";
  readonly detected_defect_ids: readonly (typeof DEFECT_IDS)[number][];
  readonly unsupported_findings: 0;
  readonly decision: "pass";
}

export interface QualificationNegativeControlV1 {
  readonly case_id: "clean-comparison-v1";
  readonly session_id: string;
  readonly attestation_sha256: string;
  readonly result_sha256: string;
  readonly finding_count: 0;
  readonly decision: "pass";
}

export interface QualificationFinalRecordV1 {
  readonly schemaVersion: 1;
  readonly kind: typeof QUALIFICATION_FINAL_KIND;
  readonly qualificationId: string;
  readonly candidateKind: typeof QUALIFICATION_CANDIDATE_KIND;
  readonly candidateDecision: "qualification-candidate";
  readonly decision: "qualified";
  readonly role: "technical-review";
  readonly roleGeneralization: "none";
  readonly technicalProfileApproval: "not-established";
  readonly freezeSha256: string;
  readonly freezeAuthorization: QualificationFreezeAdmissionV1["method"];
  readonly candidateSha256: string;
  readonly reviewReportSha256: string;
  readonly reviewSessionId: string;
  readonly finalizedAt: string;
  readonly finalSha256: string;
}

export function decodeQualificationCandidateRecord(value: unknown): QualificationCandidateRecordV1 {
  kit.assertInert(value);
  kit.rejectCredentials(value);
  const root = kit.object(value);
  kit.exact(root, [
    "schema_version",
    "kind",
    "qualification_id",
    "subject",
    "bindings",
    "role",
    "role_score",
    "hard_gates",
    "campaign",
    "independent_evaluation",
    "sanitization",
    "technical_profile_approval",
    "decision",
    "role_generalization",
    "requalification_triggers",
    "evaluated_at",
  ]);
  if (root.schema_version !== 1 || root.kind !== QUALIFICATION_CANDIDATE_KIND) {
    fail("schema-mismatch");
  }
  const decision = kit.enumeration(root.decision, [
    "qualification-candidate",
    "not-qualified",
  ] as const);
  if (decision !== "qualification-candidate") fail("not-a-candidate");
  const qualificationId = qualificationIdValue(root.qualification_id);
  const subject = decodeSubject(root.subject);
  const bindings = decodeQualificationCorpusBindings(root.bindings);
  const independent = decodeIndependentEvaluation(
    root.independent_evaluation,
    subject.candidate_id,
  );
  const campaign = decodeCampaign(root.campaign, subject.observed_model_id, independent.session_id);
  return {
    schema_version: 1,
    kind: QUALIFICATION_CANDIDATE_KIND,
    qualification_id: qualificationId,
    subject,
    bindings,
    role: kit.enumeration(root.role, ["technical-review"] as const),
    role_score: decodeRoleScore(root.role_score),
    hard_gates: decodeHardGates(root.hard_gates),
    campaign,
    independent_evaluation: independent,
    sanitization: decodeSanitization(root.sanitization),
    technical_profile_approval: kit.enumeration(root.technical_profile_approval, [
      "not-established",
    ] as const),
    decision: "qualification-candidate",
    role_generalization: kit.enumeration(root.role_generalization, ["none"] as const),
    requalification_triggers: decodeTriggers(root.requalification_triggers),
    evaluated_at: kit.timestamp(root.evaluated_at),
  };
}

export function finalizeQualificationCampaign(input: {
  candidate: unknown;
  freezeAuthority: QualificationFreezeAuthority;
  reviewAuthority: QualificationReviewAuthority;
  now: string;
}): QualificationFinalRecordV1 {
  kit.assertInert(input);
  kit.rejectCredentials(input);
  const root = kit.object(input);
  kit.exact(root, ["candidate", "freezeAuthority", "reviewAuthority", "now"]);
  const candidate = decodeQualificationCandidateRecord(root.candidate);
  const now = kit.timestamp(root.now);
  const review = requireQualificationReview({
    authority: root.reviewAuthority as QualificationReviewAuthority,
    evaluation: reviewBindingFromCandidate(candidate),
  });
  const admission = requireQualificationFreeze({
    authority: root.freezeAuthority as QualificationFreezeAuthority,
    bindings: candidate.bindings,
    qualificationId: candidate.qualification_id,
    now,
  });
  return kit.seal(QUALIFICATION_FINAL_KIND, "finalSha256", {
    qualificationId: candidate.qualification_id,
    candidateKind: QUALIFICATION_CANDIDATE_KIND,
    candidateDecision: "qualification-candidate" as const,
    decision: "qualified" as const,
    role: "technical-review" as const,
    roleGeneralization: "none" as const,
    technicalProfileApproval: "not-established" as const,
    freezeSha256: admission.freeze.freezeSha256,
    freezeAuthorization: admission.method,
    candidateSha256: canonicalDigest(candidate),
    reviewReportSha256: review.reportSha256,
    reviewSessionId: review.sessionId,
    finalizedAt: now,
  }) as QualificationFinalRecordV1;
}

function reviewBindingFromCandidate(
  candidate: QualificationCandidateRecordV1,
): QualificationReviewBindingV1 {
  const evaluation = candidate.independent_evaluation;
  return decodeReviewBinding({
    evaluatorId: evaluation.evaluator_id,
    sessionId: evaluation.session_id,
    priorContextPolicy: evaluation.prior_context_policy,
    subjectSha256: evaluation.subject_sha256,
    reportSha256: evaluation.report_sha256,
    attestationSha256: evaluation.attestation_sha256,
    decision: evaluation.decision,
    unresolvedFindingCount: evaluation.unresolved_finding_count,
  });
}

function decodeSubject(value: unknown): QualificationCandidateRecordV1["subject"] {
  const root = kit.object(value);
  kit.exact(root, [
    "candidate_id",
    "model_id",
    "observed_model_id",
    "route_class",
    "harness_id",
    "adapter_version",
    "auth_mechanism_class",
    "executable_sha256",
  ]);
  return {
    candidate_id: subjectId(root.candidate_id),
    model_id: subjectId(root.model_id),
    observed_model_id: subjectId(root.observed_model_id),
    route_class: kit.enumeration(root.route_class, ["opaque-cli-managed"] as const),
    harness_id: kit.enumeration(root.harness_id, ["claude-code"] as const),
    adapter_version: subjectId(root.adapter_version),
    auth_mechanism_class: kit.enumeration(root.auth_mechanism_class, [
      "enterprise-oauth",
      "api-key",
      "unknown",
    ] as const),
    executable_sha256: kit.hash(root.executable_sha256),
  };
}

function decodeRoleScore(value: unknown): QualificationCandidateRecordV1["role_score"] {
  const root = kit.object(value);
  kit.exact(root, ["rubric_id", "score", "threshold", "decision"]);
  if (root.score !== 5 || root.threshold !== 5) fail("invalid-value");
  return {
    rubric_id: kit.enumeration(root.rubric_id, ["technical-review-source-drift-v1"] as const),
    score: 5,
    threshold: 5,
    decision: kit.enumeration(root.decision, ["pass"] as const),
  };
}

function decodeHardGates(value: unknown): QualificationCandidateRecordV1["hard_gates"] {
  const gates = kit.array(value).map((entry) => {
    const root = kit.object(entry);
    kit.exact(root, ["check_id", "status"]);
    return {
      check_id: kit.enumeration(root.check_id, QUALIFICATION_HARD_GATE_IDS),
      status: kit.enumeration(root.status, ["pass"] as const),
    };
  });
  if (gates.length !== QUALIFICATION_HARD_GATE_IDS.length) fail("invalid-value");
  const ids = gates.map((gate) => gate.check_id);
  if (new Set(ids).size !== ids.length) fail("invalid-value");
  for (const expected of QUALIFICATION_HARD_GATE_IDS) {
    if (!ids.includes(expected)) fail("invalid-value");
  }
  return gates;
}

function decodeCampaign(
  value: unknown,
  observedModelId: string,
  reviewSessionId: string,
): QualificationCandidateRecordV1["campaign"] {
  const root = kit.object(value);
  kit.exact(root, ["required_runs", "passing_runs", "all_runs_passed", "runs", "negative_control"]);
  if (root.required_runs !== 5 || root.passing_runs !== 5 || root.all_runs_passed !== true) {
    fail("invalid-value");
  }
  const runs = kit.array(root.runs).map((entry) => decodeRun(entry, observedModelId));
  if (runs.length !== 5) fail("invalid-value");
  const runIds = new Set(runs.map((run) => run.run_id));
  if (runIds.size !== 5) fail("invalid-value");
  for (const expected of ["run-1", "run-2", "run-3", "run-4", "run-5"]) {
    if (!runIds.has(expected)) fail("invalid-value");
  }
  const negative = decodeNegativeControl(root.negative_control);
  const sessions = [...runs.map((run) => run.session_id), negative.session_id, reviewSessionId];
  if (new Set(sessions).size !== sessions.length) fail("invalid-value");
  return {
    required_runs: 5,
    passing_runs: 5,
    all_runs_passed: true,
    runs,
    negative_control: negative,
  };
}

function decodeRun(value: unknown, observedModelId: string): QualificationCandidateRunV1 {
  const root = kit.object(value);
  kit.exact(root, [
    "run_id",
    "session_id",
    "attestation_sha256",
    "result_sha256",
    "observed_model_id",
    "role",
    "detected_defect_ids",
    "unsupported_findings",
    "decision",
  ]);
  const runId = kit.string(root.run_id);
  if (!RUN_ID.test(runId)) fail("invalid-value");
  if (root.unsupported_findings !== 0) fail("invalid-value");
  const defects = kit
    .array(root.detected_defect_ids)
    .map((entry) => kit.enumeration(entry, DEFECT_IDS));
  if (defects.length !== DEFECT_IDS.length || new Set(defects).size !== defects.length) {
    fail("invalid-value");
  }
  const observed = subjectId(root.observed_model_id);
  if (observed !== observedModelId) fail("invalid-value");
  return {
    run_id: runId,
    session_id: sessionId(root.session_id),
    attestation_sha256: kit.hash(root.attestation_sha256),
    result_sha256: kit.hash(root.result_sha256),
    observed_model_id: observed,
    role: kit.enumeration(root.role, ["technical-review"] as const),
    detected_defect_ids: DEFECT_IDS,
    unsupported_findings: 0,
    decision: kit.enumeration(root.decision, ["pass"] as const),
  };
}

function decodeNegativeControl(value: unknown): QualificationNegativeControlV1 {
  const root = kit.object(value);
  kit.exact(root, [
    "case_id",
    "session_id",
    "attestation_sha256",
    "result_sha256",
    "finding_count",
    "decision",
  ]);
  if (root.finding_count !== 0) fail("invalid-value");
  return {
    case_id: kit.enumeration(root.case_id, ["clean-comparison-v1"] as const),
    session_id: sessionId(root.session_id),
    attestation_sha256: kit.hash(root.attestation_sha256),
    result_sha256: kit.hash(root.result_sha256),
    finding_count: 0,
    decision: kit.enumeration(root.decision, ["pass"] as const),
  };
}

function decodeIndependentEvaluation(
  value: unknown,
  candidateId: string,
): QualificationCandidateRecordV1["independent_evaluation"] {
  const root = kit.object(value);
  kit.exact(root, [
    "evaluator_id",
    "session_id",
    "prior_context_policy",
    "subject_sha256",
    "report_sha256",
    "attestation_sha256",
    "decision",
    "unresolved_finding_count",
  ]);
  if (root.unresolved_finding_count !== 0) fail("invalid-value");
  const evaluatorId = subjectId(root.evaluator_id);
  if (evaluatorId === candidateId) fail("invalid-value");
  return {
    evaluator_id: evaluatorId,
    session_id: sessionId(root.session_id),
    prior_context_policy: kit.enumeration(root.prior_context_policy, ["none"] as const),
    subject_sha256: kit.hash(root.subject_sha256),
    report_sha256: kit.hash(root.report_sha256),
    attestation_sha256: kit.hash(root.attestation_sha256),
    decision: kit.enumeration(root.decision, ["accepted"] as const),
    unresolved_finding_count: 0,
  };
}

function decodeSanitization(value: unknown): QualificationCandidateRecordV1["sanitization"] {
  const root = kit.object(value);
  kit.exact(root, ["credential_scan", "raw_capture_retained", "record_contains_content"]);
  if (root.raw_capture_retained !== false || root.record_contains_content !== false) {
    fail("invalid-value");
  }
  return {
    credential_scan: kit.enumeration(root.credential_scan, ["passed"] as const),
    raw_capture_retained: false,
    record_contains_content: false,
  };
}

function decodeTriggers(
  value: unknown,
): QualificationCandidateRecordV1["requalification_triggers"] {
  const triggers = kit
    .array(value)
    .map((entry) => kit.enumeration(entry, QUALIFICATION_REQUALIFICATION_TRIGGERS));
  if (
    triggers.length !== QUALIFICATION_REQUALIFICATION_TRIGGERS.length ||
    new Set(triggers).size !== triggers.length
  ) {
    fail("invalid-value");
  }
  for (const expected of QUALIFICATION_REQUALIFICATION_TRIGGERS) {
    if (!triggers.includes(expected)) fail("invalid-value");
  }
  return QUALIFICATION_REQUALIFICATION_TRIGGERS;
}

function qualificationIdValue(value: unknown): string {
  const result = kit.string(value);
  if (!QUALIFICATION_ID.test(result)) fail("invalid-value");
  return result;
}

function subjectId(value: unknown): string {
  const result = kit.string(value);
  if (!SUBJECT_ID.test(result)) fail("invalid-value");
  return result;
}

function sessionId(value: unknown): string {
  const result = kit.string(value);
  if (!SESSION_ID.test(result)) fail("invalid-value");
  return result;
}
