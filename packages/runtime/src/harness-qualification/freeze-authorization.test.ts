// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";

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
  decodeQualificationCorpusFreeze,
  requireQualificationFreeze,
  requireQualificationReview,
  signQualificationCorpusFreeze,
  type QualificationCorpusBindingsV1,
  type QualificationFreezeChallengeV1,
  type QualificationReviewBindingV1,
} from "./freeze-authorization.js";

const NOW = "2026-08-24T20:00:00.000Z";
const LATER = "2026-08-24T21:00:00.000Z";
const EXPIRES = "2026-08-25T20:00:00.000Z";
const STALE = "2026-08-26T20:00:00.000Z";
const COMMIT = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const MOVED = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const QUALIFICATION_ID = "mrq-campaign-01";
const GITLAB_HOST = "gitlab.example.com";
const LONGEST_HOST = `${"a".repeat(63)}.`.repeat(3) + "b".repeat(61);
const OVERLONG_HOST = `${"a".repeat(63)}.`.repeat(3) + "b".repeat(62);

function digest(label: string): string {
  return createHash("sha256").update(label).digest("hex");
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

function freezeFor(salt = "authorized") {
  return createQualificationCorpusFreeze({
    bindings: bindings(salt),
    authorizedCommit: COMMIT,
    expiresAt: EXPIRES,
  });
}

function hostAuthority(freeze = freezeFor(), receipt = "host-receipt") {
  return createQualificationFreezeHostAuthority({
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
  });
}

function reviewBinding(salt = "review"): QualificationReviewBindingV1 {
  return {
    evaluatorId: "independent-reviewer",
    sessionId: "00000000-0000-4000-8000-000000000007",
    priorContextPolicy: "none",
    subjectSha256: digest(`${salt}:subject`),
    reportSha256: digest(`${salt}:report`),
    attestationSha256: digest(`${salt}:attestation`),
    decision: "accepted",
    unresolvedFindingCount: 0,
  };
}

function reviewAuthority(binding = reviewBinding()) {
  return createQualificationReviewHostAuthority({
    binding,
    verifyCurrent() {
      return { status: "current" };
    },
  });
}

function expectCode(action: () => unknown, code: string): void {
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(QualificationFreezeError);
  expect((thrown as QualificationFreezeError).code).toBe(code);
}

describe("qualification freeze authorization", () => {
  it("mints opaque host authority and rejects lookalikes", () => {
    const freeze = freezeFor();
    const authority = hostAuthority(freeze);
    expect(authority.kind).toBe(QUALIFICATION_FREEZE_AUTHORITY_KIND);
    const admitted = requireQualificationFreeze({
      authority,
      bindings: freeze.bindings,
      qualificationId: QUALIFICATION_ID,
      now: NOW,
    });
    expect(admitted.method).toBe("host-authority");
    expect(admitted.freeze.freezeSha256).toBe(freeze.freezeSha256);
    expectCode(
      () =>
        requireQualificationFreeze({
          authority: { kind: QUALIFICATION_FREEZE_AUTHORITY_KIND },
          bindings: freeze.bindings,
          qualificationId: QUALIFICATION_ID,
          now: NOW,
        }),
      "unauthorized",
    );
    expect(() =>
      createQualificationFreezeHostAuthority({
        freeze,
        method: "host-authority",
      } as never),
    ).toThrowError(QualificationFreezeError);
  });

  it("fails a self-consistent oracle and manifest rewrite against the authorized freeze", () => {
    const authority = hostAuthority(freezeFor("authorized"));
    expectCode(
      () =>
        requireQualificationFreeze({
          authority,
          bindings: bindings("rewritten"),
          qualificationId: QUALIFICATION_ID,
          now: NOW,
        }),
      "stale-binding",
    );
  });

  it("admits owner-private Ed25519 authorization and rejects a lookalike key", () => {
    const freeze = freezeFor();
    const keys = generateKeyPairSync("ed25519");
    const other = generateKeyPairSync("ed25519");
    const signature = signQualificationCorpusFreeze(freeze, keys.privateKey);
    const authority = createQualificationFreezeFromEd25519({
      freeze,
      trust: {
        authorityId: "owner-freeze",
        publicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
      },
      signature,
      now: NOW,
    });
    const admitted = requireQualificationFreeze({
      authority,
      bindings: freeze.bindings,
      qualificationId: QUALIFICATION_ID,
      now: LATER,
    });
    expect(admitted.method).toBe("ed25519");
    expectCode(
      () =>
        createQualificationFreezeFromEd25519({
          freeze,
          trust: {
            authorityId: "owner-freeze",
            publicKeyPem: other.publicKey.export({ type: "spki", format: "pem" }).toString(),
          },
          signature,
          now: NOW,
        }),
      "unauthorized",
    );
  });

  it("admits exact-commit GitLab approval and rejects a moved head", () => {
    const freeze = freezeFor();
    const authority = createQualificationFreezeFromGitlabCommit({
      freeze,
      observation: {
        gitlabHost: GITLAB_HOST,
        protocol: QUALIFICATION_GITLAB_PROTOCOL,
        projectPath: "tech-docs/agents/docsfab",
        mergeRequestIid: 327,
        authorizedCommit: COMMIT,
        observedHeadSha: COMMIT,
        approved: true,
        freezeSha256: freeze.freezeSha256,
        observedAt: NOW,
      },
      trustedGitlabHost: GITLAB_HOST,
      now: NOW,
    });
    expect(
      requireQualificationFreeze({
        authority,
        bindings: freeze.bindings,
        qualificationId: QUALIFICATION_ID,
        now: NOW,
      }).method,
    ).toBe("gitlab-exact-commit");
    expectCode(
      () =>
        createQualificationFreezeFromGitlabCommit({
          freeze,
          observation: {
            gitlabHost: GITLAB_HOST,
            protocol: QUALIFICATION_GITLAB_PROTOCOL,
            projectPath: "tech-docs/agents/docsfab",
            mergeRequestIid: 327,
            authorizedCommit: COMMIT,
            observedHeadSha: MOVED,
            approved: true,
            freezeSha256: freeze.freezeSha256,
            observedAt: NOW,
          },
          trustedGitlabHost: GITLAB_HOST,
          now: NOW,
        }),
      "gitlab-commit-mismatch",
    );
  });

  it("requires a configured trusted GitLab host and refuses observations from any other", () => {
    const freeze = freezeFor();
    const observation = (gitlabHost: string) => ({
      gitlabHost,
      protocol: QUALIFICATION_GITLAB_PROTOCOL,
      projectPath: "docs/product",
      mergeRequestIid: 327,
      authorizedCommit: COMMIT,
      observedHeadSha: COMMIT,
      approved: true as const,
      freezeSha256: freeze.freezeSha256,
      observedAt: NOW,
    });
    for (const trustedGitlabHost of [
      undefined,
      "",
      "GitLab.Example.com",
      "gitlab.example.com:8443",
      "user@gitlab.example.com",
      "-gitlab.example.com",
      "gitlab.example.com/group",
      "localhost",
      OVERLONG_HOST,
      `${"a".repeat(64)}.example.com`,
      `gitlab.${"b".repeat(64)}`,
    ]) {
      const input = {
        freeze,
        observation: observation(GITLAB_HOST),
        now: NOW,
        ...(trustedGitlabHost === undefined ? {} : { trustedGitlabHost }),
      };
      expectCode(
        () =>
          createQualificationFreezeFromGitlabCommit(
            input as Parameters<typeof createQualificationFreezeFromGitlabCommit>[0],
          ),
        "gitlab-host-required",
      );
    }
    expectCode(
      () =>
        createQualificationFreezeFromGitlabCommit({
          freeze,
          observation: observation("gitlab.other.example"),
          trustedGitlabHost: GITLAB_HOST,
          now: NOW,
        }),
      "invalid-value",
    );
    const admitted = requireQualificationFreeze({
      authority: createQualificationFreezeFromGitlabCommit({
        freeze,
        observation: observation("gitlab.other.example"),
        trustedGitlabHost: "gitlab.other.example",
        now: NOW,
      }),
      bindings: freeze.bindings,
      qualificationId: QUALIFICATION_ID,
      now: NOW,
    });
    expect(admitted.method).toBe("gitlab-exact-commit");
    expect([LONGEST_HOST.length, OVERLONG_HOST.length]).toEqual([253, 254]);
    expect(
      createQualificationFreezeFromGitlabCommit({
        freeze,
        observation: observation(LONGEST_HOST),
        trustedGitlabHost: LONGEST_HOST,
        now: NOW,
      }).kind,
    ).toBe(QUALIFICATION_FREEZE_AUTHORITY_KIND);
    const other = requireQualificationFreeze({
      authority: createQualificationFreezeFromGitlabCommit({
        freeze,
        observation: observation(GITLAB_HOST),
        trustedGitlabHost: GITLAB_HOST,
        now: NOW,
      }),
      bindings: freeze.bindings,
      qualificationId: "mrq-campaign-host-02",
      now: NOW,
    });
    expect(other.authorityIdentitySha256).not.toBe(admitted.authorityIdentitySha256);
  });

  it("rejects stale and replayed freeze receipts", () => {
    const freeze = freezeFor();
    expectCode(
      () =>
        requireQualificationFreeze({
          authority: hostAuthority(freeze),
          bindings: freeze.bindings,
          qualificationId: QUALIFICATION_ID,
          now: STALE,
        }),
      "authority-expired",
    );
    const authority = hostAuthority(freeze, "once");
    requireQualificationFreeze({
      authority,
      bindings: freeze.bindings,
      qualificationId: QUALIFICATION_ID,
      now: NOW,
    });
    expectCode(
      () =>
        requireQualificationFreeze({
          authority,
          bindings: freeze.bindings,
          qualificationId: QUALIFICATION_ID,
          now: LATER,
        }),
      "authority-replayed",
    );
  });

  it("does not let a fabricated report, session, or digest mint review authority", () => {
    const genuine = reviewBinding("genuine");
    const fabricated = reviewBinding("fabricated");
    const authority = reviewAuthority(genuine);
    expect(authority.kind).toBe(QUALIFICATION_REVIEW_AUTHORITY_KIND);
    expect(requireQualificationReview({ authority, evaluation: genuine }).reportSha256).toBe(
      genuine.reportSha256,
    );
    expectCode(
      () => requireQualificationReview({ authority, evaluation: fabricated }),
      "invalid-review",
    );
    expectCode(
      () =>
        requireQualificationReview({
          authority: {
            kind: QUALIFICATION_REVIEW_AUTHORITY_KIND,
            ...fabricated,
          } as never,
          evaluation: fabricated,
        }),
      "unauthorized",
    );
    expectCode(
      () =>
        createQualificationReviewHostAuthority({
          binding: genuine,
        } as never),
      "authority-required",
    );
  });

  it("round-trips a sealed corpus freeze", () => {
    const freeze = freezeFor();
    expect(decodeQualificationCorpusFreeze({ ...freeze })).toEqual(freeze);
  });
});
