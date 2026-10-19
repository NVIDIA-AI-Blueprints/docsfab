// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  createArtifact,
  validateArtifact,
  type ArtifactPayloadByKind,
  type ArtifactReference,
  type IaPlanArtifact,
} from "../src/artifacts/index.js";
import {
  canonicalDigest,
  type ContentIndexV1,
  type DocumentNode,
} from "../src/content-ir/index.js";
import {
  assertIaPlanReviewApproved,
  iaPlanReviewerPolicyDigest,
  prepareIaPlanReviewerAuthorization,
  reviewIaPlan,
  validateIaPlanReviewArtifact,
  type IaPlanReviewerPolicy,
  type IaPlanReviewerPolicyValue,
} from "../src/ia/plan-review.js";
import { createIaPlanningOutcome } from "../src/ia/planning.js";
import { passedIaEvaluationFixture } from "./ia-evaluation-fixture.js";

const REVISION = "a".repeat(40);
const CONTENT_DIGEST = "b".repeat(64);
const NOW = new Date("2026-08-03T16:00:00.000Z");
const EXPIRES = "2026-08-04T16:00:00.000Z";

describe("IA plan review transitions", () => {
  it("issues a signed immutable approval only to the policy-authorized reviewer", () => {
    const fixture = reviewerFixture();
    const plan = planningOutcomePlan();
    const transition = reviewIaPlan({
      index: index(),
      plan,
      authorization: fixture.maintainer,
      decision: "approved",
    });

    expect(transition).toMatchObject({
      review: {
        decision: "approved",
        reviewer: { id: "maintainer:docs", role: "maintainer" },
        predecessorPlan: { digest: plan.digest },
        plan: { digest: transition.plan.digest },
        policy: { digest: fixture.policy.digest },
        decidedAt: NOW.toISOString(),
        expiresAt: EXPIRES,
      },
      plan: {
        payload: {
          approval: {
            status: "approved",
            approvedBy: "maintainer:docs",
            approvedAt: NOW.toISOString(),
          },
          supersedes: { digest: plan.digest },
        },
      },
    });
    expect(Object.isFrozen(transition)).toBe(true);
    expect(validateIaPlanReviewArtifact(transition.review, fixture.policy)).toEqual(
      transition.review,
    );
    expect(
      reviewIaPlan({
        index: index(),
        plan,
        authorization: fixture.maintainer,
        decision: "approved",
      }),
    ).toEqual(transition);
    expect(
      assertIaPlanReviewApproved({
        index: index(),
        plan: transition.plan,
        review: transition.review,
        policy: fixture.policy,
        now: NOW,
      }),
    ).toEqual(transition.review);
    expect(validateArtifact(transition.plan, { index: index(), now: NOW })).toEqual(
      transition.plan,
    );

    expect(() =>
      reviewIaPlan({
        index: index(),
        plan,
        authorization: structuredClone(fixture.maintainer),
        decision: "approved",
      }),
    ).toThrow("invalid-authority");
  });

  it("rejects reviewer forgery even when the attacker recomputes the artifact digest", () => {
    const fixture = reviewerFixture();
    const transition = reviewIaPlan({
      index: index(),
      plan: planFixture(index()),
      authorization: fixture.maintainer,
      decision: "approved",
    });
    const forged = structuredClone(transition.review);
    forged.reviewer = { id: "owner:docs", role: "product-owner" };
    const { digest: _digest, ...digestible } = forged;
    forged.digest = canonicalDigest(digestible);

    expect(() => validateIaPlanReviewArtifact(forged, fixture.policy)).toThrow(
      "signature-mismatch",
    );
  });

  it("models request-changes and reject explicitly and enforces review roles", () => {
    const fixture = reviewerFixture();
    const productOwnerPlan = planFixture(index(), {
      approval: {
        requirement: "product-owner",
        status: "pending",
      },
    });

    expect(() =>
      reviewIaPlan({
        index: index(),
        plan: productOwnerPlan,
        authorization: fixture.maintainer,
        decision: "approved",
      }),
    ).toThrow("insufficient-role");
    expect(() =>
      reviewIaPlan({
        index: index(),
        plan: productOwnerPlan,
        authorization: fixture.owner,
        decision: "changes-requested",
      }),
    ).toThrow("invalid-review");

    const changes = reviewIaPlan({
      index: index(),
      plan: productOwnerPlan,
      authorization: fixture.owner,
      decision: "changes-requested",
      reason: "Clarify the canonical landing page.",
    });
    const rejected = reviewIaPlan({
      index: index(),
      plan: productOwnerPlan,
      authorization: fixture.owner,
      decision: "rejected",
      reason: "The proposed grouping conflicts with policy.",
    });

    expect(changes.review.decision).toBe("changes-requested");
    expect(changes.plan.payload.approval.status).toBe("changes-requested");
    expect(rejected.review.decision).toBe("rejected");
    expect(rejected.plan.payload.approval.status).toBe("rejected");
    expect(
      validateArtifact(changes.plan, {
        index: index(),
        now: NOW,
        planAcceptance: "any",
      }),
    ).toEqual(changes.plan);
    expect(
      validateArtifact(rejected.plan, {
        index: index(),
        now: NOW,
        planAcceptance: "any",
      }),
    ).toEqual(rejected.plan);
    expect(() => validateArtifact(changes.plan, { index: index(), now: NOW })).toThrow(
      "plan-unapproved",
    );
    expect(() => validateArtifact(rejected.plan, { index: index(), now: NOW })).toThrow(
      "plan-unapproved",
    );
    expect(() =>
      assertIaPlanReviewApproved({
        index: index(),
        plan: rejected.plan,
        review: rejected.review,
        policy: fixture.policy,
        now: NOW,
      }),
    ).toThrow("invalid-plan");
  });

  it("approves only a materially revised pending successor to requested changes", () => {
    const fixture = reviewerFixture();
    const first = planningOutcomePlan();
    const changes = reviewIaPlan({
      index: index(),
      plan: first,
      authorization: fixture.maintainer,
      decision: "changes-requested",
      reason: "Use a clearer group label.",
    });
    const unchangedRevision = planningOutcomePlan({
      supersedes: reference(changes.plan),
    });
    const revised = planningOutcomePlan({
      supersedes: reference(changes.plan),
      title: "Start using DocsFab",
    });

    expect(() =>
      reviewIaPlan({
        index: index(),
        plan: changes.plan,
        authorization: fixture.maintainer,
        decision: "approved",
        predecessor: changes.review,
        reviewedPlan: changes.plan,
      }),
    ).toThrow("invalid-transition");
    expect(() =>
      reviewIaPlan({
        index: index(),
        plan: unchangedRevision,
        authorization: fixture.maintainer,
        decision: "approved",
        predecessor: changes.review,
        reviewedPlan: changes.plan,
      }),
    ).toThrow("invalid-transition");
    expect(() =>
      reviewIaPlan({
        index: index(),
        plan: revised,
        authorization: fixture.maintainer,
        decision: "approved",
        predecessor: changes.review,
      }),
    ).toThrow("invalid-transition");

    const approved = reviewIaPlan({
      index: index(),
      plan: revised,
      authorization: fixture.maintainer,
      decision: "approved",
      predecessor: changes.review,
      reviewedPlan: changes.plan,
    });

    expect(approved.review.predecessor).toMatchObject({ digest: changes.review.digest });
    expect(approved.review.predecessorPlan.digest).toBe(revised.digest);
    expect(revised.payload.supersedes).toEqual(reference(changes.plan));
    expect(revised.payload.approval.status).toBe("pending");
    expect(approved.plan.payload.approval.status).toBe("approved");
    expect(approved.plan.payload.supersedes).toEqual(reference(revised));
    expect(() =>
      reviewIaPlan({
        index: index(),
        plan: first,
        authorization: fixture.maintainer,
        decision: "approved",
        predecessor: changes.review,
        reviewedPlan: changes.plan,
      }),
    ).toThrow("invalid-transition");
    expect(() =>
      reviewIaPlan({
        index: index(),
        plan: approved.plan,
        authorization: fixture.maintainer,
        decision: "rejected",
        reason: "Too late.",
        predecessor: approved.review,
        reviewedPlan: approved.plan,
      }),
    ).toThrow("invalid-transition");
  });

  it("fails closed for stale revisions, superseded plans, and expired plans", () => {
    const fixture = reviewerFixture();
    const currentIndex = index();
    const first = planFixture(currentIndex);
    const replacement = reviewIaPlan({
      index: currentIndex,
      plan: first,
      authorization: fixture.maintainer,
      decision: "approved",
    }).plan;
    const newerIndex = index("c".repeat(40), "d".repeat(64));

    expect(() =>
      reviewIaPlan({
        index: newerIndex,
        plan: first,
        authorization: fixture.maintainer,
        decision: "approved",
      }),
    ).toThrow("stale-plan");
    expect(() =>
      reviewIaPlan({
        index: currentIndex,
        plan: first,
        activePlan: replacement,
        authorization: fixture.maintainer,
        decision: "approved",
      }),
    ).toThrow("stale-plan");

    const expiredAuthority = reviewerFixture(() => new Date("2026-08-04T16:00:00.000Z")).maintainer;
    expect(() =>
      reviewIaPlan({
        index: currentIndex,
        plan: first,
        authorization: expiredAuthority,
        decision: "approved",
      }),
    ).toThrow("expired-plan");
  });
});

function reviewerFixture(now: () => Date = () => NOW) {
  const maintainerKeys = generateKeyPairSync("ed25519");
  const ownerKeys = generateKeyPairSync("ed25519");
  const value: IaPlanReviewerPolicyValue = {
    id: "docsfab:ia-reviewers",
    version: "1",
    reviewers: [
      {
        id: "maintainer:docs",
        role: "maintainer",
        publicKey: maintainerKeys.publicKey.export({ type: "spki", format: "pem" }).toString(),
      },
      {
        id: "owner:docs",
        role: "product-owner",
        publicKey: ownerKeys.publicKey.export({ type: "spki", format: "pem" }).toString(),
      },
    ],
  };
  const policy: IaPlanReviewerPolicy = {
    ...value,
    digest: iaPlanReviewerPolicyDigest(value),
  };
  return {
    policy,
    maintainer: prepareIaPlanReviewerAuthorization({
      policy,
      reviewerId: "maintainer:docs",
      privateKey: maintainerKeys.privateKey,
      now,
    }),
    owner: prepareIaPlanReviewerAuthorization({
      policy,
      reviewerId: "owner:docs",
      privateKey: ownerKeys.privateKey,
      now,
    }),
  };
}

function planningOutcomePlan(
  input: { supersedes?: ArtifactReference<"ia-plan">; title?: string } = {},
): IaPlanArtifact {
  const value = index();
  const evidence = [{ path: "README.md", nodeId: "document:README.md" }];
  const evaluated = passedIaEvaluationFixture(value);
  const outcome = createIaPlanningOutcome({
    index: value,
    scope: "site",
    mode: "create",
    planId: "plan:site",
    ontology: evaluated.ontology,
    candidates: evaluated.candidates,
    evaluation: evaluated.evaluation,
    evaluationInput: evaluated.evaluationInput,
    navigationEvaluation: evaluated.navigationEvaluation,
    useCases: [],
    redirects: [],
    inboundLinkConsequences: [],
    policyBindings: [{ id: "policy:site", version: "1", digest: "d".repeat(64) }],
    requiredApproval: "maintainer",
    expiresAt: EXPIRES,
    ...(input.supersedes ? { supersedes: input.supersedes } : {}),
    plannedPages: [
      {
        topicId: "topic:get-started",
        title: input.title ?? "Get started",
        slug: "get-started",
        templateId: "get-started-overview-gfm",
        format: "gfm",
        outputPath: "docs/get-started.md",
        evidence,
      },
    ],
    migrationDispositions: [],
  });
  if (!("plan" in outcome)) throw new Error("Expected a pending planning outcome.");
  return outcome.plan;
}

function planFixture(
  value: ContentIndexV1,
  overrides: Partial<ArtifactPayloadByKind["ia-plan"]> = {},
): IaPlanArtifact {
  return createArtifact(
    "ia-plan",
    {
      planId: "plan:site",
      candidateId: "candidate:site",
      candidateArtifact: artifactReference("ia-candidates", value, "1"),
      scope: "site",
      primaryAxis: "reader-job",
      secondaryAxes: [],
      groups: [],
      useCases: [],
      rejectedCandidates: [],
      openDecisions: [],
      redirects: [],
      inboundLinkConsequences: [],
      navigationEvaluation: artifactReference("navigation-evaluation", value, "2"),
      policyBindings: [],
      approval: {
        requirement: "maintainer",
        status: "pending",
      },
      expiresAt: EXPIRES,
      outputScope: [],
      ...overrides,
    },
    { index: value, now: NOW, planAcceptance: "any" },
  );
}

function artifactReference<K extends "ia-candidates" | "navigation-evaluation">(
  kind: K,
  value: ContentIndexV1,
  digestCharacter: string,
) {
  return {
    kind,
    schemaVersion: 1 as const,
    digest: digestCharacter.repeat(64),
    repositoryRevision: value.repository.revision,
    repositoryContentDigest: value.repository.contentDigest,
  };
}

function reference(plan: IaPlanArtifact): ArtifactReference<"ia-plan"> {
  return {
    kind: "ia-plan",
    schemaVersion: 1,
    digest: plan.digest,
    repositoryRevision: plan.repository.revision,
    repositoryContentDigest: plan.repository.contentDigest,
  };
}

function index(revision = REVISION, contentDigest = CONTENT_DIGEST): ContentIndexV1 {
  const nodes = [document(), document("GUIDE.md")];
  const value: ContentIndexV1 = {
    schemaVersion: 1,
    repository: { revision, contentDigest },
    indexDigest: "f".repeat(64),
    nodes,
    edges: [],
    evidence: {
      repositoryRevision: revision,
      contentDigest,
      indexDigest: "f".repeat(64),
      documentCount: 2,
      sectionCount: 0,
      edgeCount: 0,
    },
  };
  const indexDigest = canonicalDigest({
    schemaVersion: 1,
    repository: value.repository,
    nodes,
    edges: [],
  });
  return { ...value, indexDigest, evidence: { ...value.evidence, indexDigest } };
}

function document(sourcePath = "README.md"): DocumentNode {
  return {
    id: `document:${sourcePath}`,
    kind: "document",
    sourcePath,
    format: "gfm",
    byteLength: 64,
    anchors: [],
    frontmatter: [],
    directives: [],
    codeBlocks: [],
    regions: {
      body: "1".repeat(64),
      headings: "2".repeat(64),
      metadata: "3".repeat(64),
      navigation: "4".repeat(64),
      graph: "5".repeat(64),
    },
  };
}
