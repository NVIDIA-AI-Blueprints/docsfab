// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  QUALIFICATION_REQUALIFICATION_TRIGGERS,
  QualificationFinalizerError,
  decodeQualificationCandidateRecord,
  finalizeQualificationCampaign,
  type QualificationCandidateRecordV1,
} from "./campaign-finalizer.js";
import {
  QUALIFICATION_FREEZE_AUTHORITY_KIND,
  QUALIFICATION_GITLAB_PROTOCOL,
  QUALIFICATION_REVIEW_AUTHORITY_KIND,
  QualificationFreezeError,
  createQualificationCorpusFreeze,
  createQualificationFreezeFromEd25519,
  createQualificationFreezeFromGitlabCommit,
  createQualificationFreezeHostAuthority,
  createQualificationReviewHostAuthority,
  signQualificationCorpusFreeze,
  type QualificationCorpusBindingsV1,
  type QualificationFreezeChallengeV1,
  type QualificationReviewBindingV1,
} from "./freeze-authorization.js";

const NOW = "2026-08-24T20:00:00.000Z";
const EXPIRES = "2026-08-25T20:00:00.000Z";
const STALE = "2026-08-26T20:00:00.000Z";
const COMMIT = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function digest(label: string): string {
  return createHash("sha256").update(label).digest("hex");
}

function session(number: number): string {
  return `00000000-0000-4000-8000-${number.toString().padStart(12, "0")}`;
}

function bindings(salt: string): QualificationCorpusBindingsV1 {
  const field = (name: string): string => digest(`${salt}:${name}`);
  return {
    corpus_id: "docsfab-harness-role-qualification-v1",
    corpus_manifest_sha256: field("corpus"),
    private_manifest_sha256: field("private"),
    case_id: "seeded-comprehensive-evaluation-v1",
    case_sha256: field("case"),
    clean_case_id: "clean-comparison-v1",
    clean_case_sha256: field("clean-case"),
    workflow_sha256: field("workflow"),
    skill_sha256: field("skill"),
    quality_sha256: field("quality"),
    output_schema_sha256: field("schema"),
    thresholds_sha256: field("thresholds"),
    scorer_sha256: field("scorer"),
    mutation_sha256: field("mutation"),
    baseline_sha256: field("baseline"),
    oracle_sha256: field("oracle"),
    governed_inputs_sha256: field("governed"),
    seeded_prompt_sha256: field("seeded-prompt"),
    seeded_staging_manifest_sha256: field("seeded-staging"),
    clean_prompt_sha256: field("clean-prompt"),
    clean_staging_manifest_sha256: field("clean-staging"),
  };
}

function candidate(options?: {
  salt?: string;
  reportSalt?: string;
  sessionId?: string;
}): QualificationCandidateRecordV1 {
  const salt = options?.salt ?? "authorized";
  const reportSalt = options?.reportSalt ?? "review";
  return {
    schema_version: 1,
    kind: "docsfab-model-role-qualification-record",
    qualification_id: "mrq-campaign-01",
    subject: {
      candidate_id: "claude-sonnet-4-candidate",
      model_id: "claude-sonnet-4-5",
      observed_model_id: "claude-sonnet-4-5",
      route_class: "opaque-cli-managed",
      harness_id: "claude-code",
      adapter_version: "1.0.0",
      auth_mechanism_class: "enterprise-oauth",
      executable_sha256: digest("executable"),
    },
    bindings: bindings(salt),
    role: "technical-review",
    role_score: {
      rubric_id: "technical-review-source-drift-v1",
      score: 5,
      threshold: 5,
      decision: "pass",
    },
    hard_gates: [
      { check_id: "schema-conformance", status: "pass" },
      { check_id: "harness-attestation-controls", status: "pass" },
      { check_id: "exact-model-identity", status: "pass" },
      { check_id: "zero-unsupported-findings", status: "pass" },
      { check_id: "clean-negative-control", status: "pass" },
      { check_id: "independent-review", status: "pass" },
    ],
    campaign: {
      required_runs: 5,
      passing_runs: 5,
      all_runs_passed: true,
      runs: [1, 2, 3, 4, 5].map((index) => ({
        run_id: `run-${index}` as `run-${typeof index}`,
        session_id: session(index),
        attestation_sha256: digest(`attestation-${index}`),
        result_sha256: digest(`result-${index}`),
        observed_model_id: "claude-sonnet-4-5",
        role: "technical-review" as const,
        detected_defect_ids: [
          "SOURCE-DRIFT-001",
          "SOURCE-DRIFT-002",
          "SOURCE-DRIFT-003",
          "SOURCE-DRIFT-004",
          "SOURCE-DRIFT-005",
        ],
        unsupported_findings: 0,
        decision: "pass" as const,
      })),
      negative_control: {
        case_id: "clean-comparison-v1",
        session_id: session(6),
        attestation_sha256: digest("negative-attestation"),
        result_sha256: digest("negative-result"),
        finding_count: 0,
        decision: "pass",
      },
    },
    independent_evaluation: {
      evaluator_id: "independent-reviewer",
      session_id: options?.sessionId ?? session(7),
      prior_context_policy: "none",
      subject_sha256: digest(`${reportSalt}:subject`),
      report_sha256: digest(`${reportSalt}:report`),
      attestation_sha256: digest(`${reportSalt}:attestation`),
      decision: "accepted",
      unresolved_finding_count: 0,
    },
    sanitization: {
      credential_scan: "passed",
      raw_capture_retained: false,
      record_contains_content: false,
    },
    technical_profile_approval: "not-established",
    decision: "qualification-candidate",
    role_generalization: "none",
    requalification_triggers: QUALIFICATION_REQUALIFICATION_TRIGGERS,
    evaluated_at: NOW,
  };
}

function freezeFor(salt = "authorized") {
  return createQualificationCorpusFreeze({
    bindings: bindings(salt),
    authorizedCommit: COMMIT,
    expiresAt: EXPIRES,
  });
}

function hostFreeze(salt = "authorized", receipt = "host-receipt") {
  const freeze = freezeFor(salt);
  return {
    freeze,
    authority: createQualificationFreezeHostAuthority({
      freeze,
      method: "host-authority",
      verifyCurrent(challenge: QualificationFreezeChallengeV1) {
        return {
          status: "current",
          challengeSha256: challenge.challengeSha256,
          observedAt: NOW,
          authorityReceiptSha256: digest(receipt),
          authorityIdentitySha256: digest("host-identity"),
        };
      },
    }),
  };
}

function reviewFor(record: QualificationCandidateRecordV1) {
  const evaluation = record.independent_evaluation;
  const binding: QualificationReviewBindingV1 = {
    evaluatorId: evaluation.evaluator_id,
    sessionId: evaluation.session_id,
    priorContextPolicy: evaluation.prior_context_policy,
    subjectSha256: evaluation.subject_sha256,
    reportSha256: evaluation.report_sha256,
    attestationSha256: evaluation.attestation_sha256,
    decision: evaluation.decision,
    unresolvedFindingCount: evaluation.unresolved_finding_count,
  };
  return createQualificationReviewHostAuthority({
    binding,
    verifyCurrent() {
      return { status: "current" };
    },
  });
}

function expectFreeze(action: () => unknown, code: string): void {
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(QualificationFreezeError);
  expect((thrown as QualificationFreezeError).code).toBe(code);
}

function expectFinal(action: () => unknown, code: string): void {
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(QualificationFinalizerError);
  expect((thrown as QualificationFinalizerError).code).toBe(code);
}

describe("qualification campaign finalizer", () => {
  it("emits qualified only through opaque freeze and review authority", () => {
    const record = candidate();
    const { freeze, authority } = hostFreeze();
    const final = finalizeQualificationCampaign({
      candidate: record,
      freezeAuthority: authority,
      reviewAuthority: reviewFor(record),
      now: NOW,
    });
    expect(final.kind).toBe("docsfab-harness-qualification-final");
    expect(final.decision).toBe("qualified");
    expect(final.candidateDecision).toBe("qualification-candidate");
    expect(final.technicalProfileApproval).toBe("not-established");
    expect(final.roleGeneralization).toBe("none");
    expect(final.freezeSha256).toBe(freeze.freezeSha256);
    expect(final.freezeAuthorization).toBe("host-authority");
    expect(final.reviewSessionId).toBe(record.independent_evaluation.session_id);
    expect(record.decision).toBe("qualification-candidate");
  });

  it("promotes after Ed25519 or exact-commit GitLab freeze admission", () => {
    const record = candidate();
    const freeze = freezeFor();
    const keys = generateKeyPairSync("ed25519");
    const ed25519 = finalizeQualificationCampaign({
      candidate: record,
      freezeAuthority: createQualificationFreezeFromEd25519({
        freeze,
        trust: {
          authorityId: "owner-freeze",
          publicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
        },
        signature: signQualificationCorpusFreeze(freeze, keys.privateKey),
        now: NOW,
      }),
      reviewAuthority: reviewFor(record),
      now: NOW,
    });
    expect(ed25519.freezeAuthorization).toBe("ed25519");
    const gitlabRecord = {
      ...candidate(),
      qualification_id: "mrq-campaign-02",
    };
    const gitlab = finalizeQualificationCampaign({
      candidate: gitlabRecord,
      freezeAuthority: createQualificationFreezeFromGitlabCommit({
        freeze,
        observation: {
          gitlabHost: "gitlab.example.com",
          protocol: QUALIFICATION_GITLAB_PROTOCOL,
          projectPath: "tech-docs/agents/docsfab",
          mergeRequestIid: 327,
          authorizedCommit: COMMIT,
          observedHeadSha: COMMIT,
          approved: true,
          freezeSha256: freeze.freezeSha256,
          observedAt: NOW,
        },
        trustedGitlabHost: "gitlab.example.com",
        now: NOW,
      }),
      reviewAuthority: reviewFor(gitlabRecord),
      now: NOW,
    });
    expect(gitlab.freezeAuthorization).toBe("gitlab-exact-commit");
  });

  it("fails a self-consistent oracle/manifest rewrite against authorized freeze", () => {
    const rewritten = candidate({ salt: "rewritten" });
    const { authority } = hostFreeze("authorized");
    expectFreeze(
      () =>
        finalizeQualificationCampaign({
          candidate: rewritten,
          freezeAuthority: authority,
          reviewAuthority: reviewFor(rewritten),
          now: NOW,
        }),
      "stale-binding",
    );
  });

  it("rejects fabricated report, session, or digest review evidence", () => {
    const record = candidate({ reportSalt: "forged" });
    const { authority } = hostFreeze();
    const genuineReview = reviewFor(candidate({ reportSalt: "review" }));
    expectFreeze(
      () =>
        finalizeQualificationCampaign({
          candidate: record,
          freezeAuthority: authority,
          reviewAuthority: genuineReview,
          now: NOW,
        }),
      "invalid-review",
    );
    expectFreeze(
      () =>
        finalizeQualificationCampaign({
          candidate: candidate(),
          freezeAuthority: authority,
          reviewAuthority: { kind: QUALIFICATION_REVIEW_AUTHORITY_KIND } as never,
          now: NOW,
        }),
      "unauthorized",
    );
  });

  it("rejects lookalike freeze, replay, and stale authorities", () => {
    const record = candidate();
    const { authority } = hostFreeze("authorized", "once");
    expectFreeze(
      () =>
        finalizeQualificationCampaign({
          candidate: record,
          freezeAuthority: { kind: QUALIFICATION_FREEZE_AUTHORITY_KIND } as never,
          reviewAuthority: reviewFor(record),
          now: NOW,
        }),
      "unauthorized",
    );
    finalizeQualificationCampaign({
      candidate: record,
      freezeAuthority: authority,
      reviewAuthority: reviewFor(record),
      now: NOW,
    });
    expectFreeze(
      () =>
        finalizeQualificationCampaign({
          candidate: record,
          freezeAuthority: authority,
          reviewAuthority: reviewFor(record),
          now: NOW,
        }),
      "authority-replayed",
    );
    expectFreeze(
      () =>
        finalizeQualificationCampaign({
          candidate: candidate(),
          freezeAuthority: hostFreeze("authorized", "stale").authority,
          reviewAuthority: reviewFor(candidate()),
          now: STALE,
        }),
      "authority-expired",
    );
  });

  it("does not promote not-qualified or a self-declared qualified decision", () => {
    expectFinal(
      () =>
        decodeQualificationCandidateRecord({
          ...candidate(),
          decision: "not-qualified",
        }),
      "not-a-candidate",
    );
    expectFinal(
      () =>
        decodeQualificationCandidateRecord({
          ...candidate(),
          decision: "qualified",
        }),
      "invalid-value",
    );
  });
});
