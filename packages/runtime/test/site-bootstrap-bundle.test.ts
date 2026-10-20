// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ArtifactValidationError, canonicalArtifactDigest } from "../src/artifacts/index.js";
import { canonicalDigest } from "../src/content-ir/index.js";
import { IaPlanReviewError, iaPlanReviewerPolicyDigest } from "../src/ia/index.js";
import {
  loadSiteBootstrapApplicationBundle,
  prepareSiteBootstrapApprovalGrant,
  SiteBootstrapBundleError,
  validateSiteBootstrapApplicationBundle,
} from "../src/site-bootstrap/index.js";
import { fixtureRepository } from "./site-bootstrap-test-repository.js";
import {
  SITE_BOOTSTRAP_REVIEWER_POLICY,
  siteBootstrapBundle,
  siteBootstrapIndex,
} from "./site-bootstrap-fixtures.js";

const roots: string[] = [];
const NOW = new Date("2026-08-03T20:00:00.000Z");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("site bootstrap application bundle", () => {
  it("seals the exact application inputs and loads stable regular-file bytes", async () => {
    const repository = await fixtureRepository(roots);
    const index = siteBootstrapIndex(repository.revision);
    const bundle = siteBootstrapBundle(index, NOW);
    const root = await mkdtemp(join(tmpdir(), "docsfab-site-bundle-"));
    roots.push(root);
    const path = join(root, "plan.json");
    await writeFile(path, `${JSON.stringify(bundle)}\n`, "utf8");

    const options = { now: NOW, reviewerPolicy: SITE_BOOTSTRAP_REVIEWER_POLICY };
    await expect(loadSiteBootstrapApplicationBundle(path, options)).resolves.toEqual(bundle);
    expect(validateSiteBootstrapApplicationBundle(bundle, options)).toEqual(bundle);
  });

  it("rejects policy/approval tampering and symlinked bundle paths", async () => {
    const repository = await fixtureRepository(roots);
    const index = siteBootstrapIndex(repository.revision);
    const bundle = siteBootstrapBundle(index, NOW);
    const tampered = structuredClone(bundle);
    tampered.review.signature = "A".repeat(tampered.review.signature.length);
    tampered.review.digest = digestWithout(tampered.review);
    tampered.digest = digestWithout(tampered);
    expect(() =>
      validateSiteBootstrapApplicationBundle(tampered, {
        now: NOW,
        reviewerPolicy: SITE_BOOTSTRAP_REVIEWER_POLICY,
      }),
    ).toThrow(IaPlanReviewError);
    try {
      validateSiteBootstrapApplicationBundle(tampered, {
        now: NOW,
        reviewerPolicy: SITE_BOOTSTRAP_REVIEWER_POLICY,
      });
    } catch (error) {
      expect((error as IaPlanReviewError).code).toBe("signature-mismatch");
    }

    const selfAttested = structuredClone(bundle);
    selfAttested.plan.payload.planId = "plan:self-attested-allowlisted-reviewer";
    selfAttested.plan.digest = canonicalArtifactDigest(selfAttested.plan);
    selfAttested.digest = digestWithout(selfAttested);
    expect(selfAttested.plan.payload.approval.approvedBy).toBe("maintainer:docs");
    expect(() =>
      validateSiteBootstrapApplicationBundle(selfAttested, {
        now: NOW,
        reviewerPolicy: SITE_BOOTSTRAP_REVIEWER_POLICY,
      }),
    ).toThrow(IaPlanReviewError);
    try {
      validateSiteBootstrapApplicationBundle(selfAttested, {
        now: NOW,
        reviewerPolicy: SITE_BOOTSTRAP_REVIEWER_POLICY,
      });
    } catch (error) {
      expect((error as IaPlanReviewError).code).toBe("stale-plan");
    }

    const evaluationMismatch = structuredClone(bundle);
    evaluationMismatch.plan.payload.iaEvaluation!.digest = "f".repeat(64);
    evaluationMismatch.plan.digest = canonicalArtifactDigest(evaluationMismatch.plan);
    evaluationMismatch.digest = digestWithout(evaluationMismatch);
    expect(() =>
      validateSiteBootstrapApplicationBundle(evaluationMismatch, {
        now: NOW,
        reviewerPolicy: SITE_BOOTSTRAP_REVIEWER_POLICY,
      }),
    ).toThrow("invalid-bundle");

    const root = await mkdtemp(join(tmpdir(), "docsfab-site-bundle-link-"));
    roots.push(root);
    const target = join(root, "target.json");
    const link = join(root, "plan.json");
    await writeFile(target, JSON.stringify(bundle), "utf8");
    await symlink(target, link);
    await expect(
      loadSiteBootstrapApplicationBundle(link, {
        now: NOW,
        reviewerPolicy: SITE_BOOTSTRAP_REVIEWER_POLICY,
      }),
    ).rejects.toThrow("invalid-bundle");
  });

  it("rejects self-consistent attacker and wrong host-trusted reviewer policies", async () => {
    const repository = await fixtureRepository(roots);
    const index = siteBootstrapIndex(repository.revision);
    const attackerKeys = generateKeyPairSync("ed25519");
    const attackerValue = {
      id: "attacker:reviewers",
      version: "1",
      reviewers: [
        {
          id: "maintainer:docs",
          role: "maintainer" as const,
          publicKey: attackerKeys.publicKey.export({ type: "spki", format: "pem" }).toString(),
        },
      ],
    };
    const attackerPolicy = {
      ...attackerValue,
      digest: iaPlanReviewerPolicyDigest(attackerValue),
    };
    const attackerBundle = siteBootstrapBundle(index, NOW, {
      policy: attackerPolicy,
      reviewerId: "maintainer:docs",
      privateKey: attackerKeys.privateKey,
    });
    expect(() =>
      validateSiteBootstrapApplicationBundle(attackerBundle, {
        now: NOW,
        reviewerPolicy: SITE_BOOTSTRAP_REVIEWER_POLICY,
      }),
    ).toThrow("invalid-bundle");
    expect(() =>
      prepareSiteBootstrapApprovalGrant({
        bundle: attackerBundle,
        reviewerPolicy: SITE_BOOTSTRAP_REVIEWER_POLICY,
        evaluationTime: NOW,
      }),
    ).toThrow("invalid-bundle");

    const wrongKeys = generateKeyPairSync("ed25519");
    const wrongValue = {
      id: SITE_BOOTSTRAP_REVIEWER_POLICY.id,
      version: SITE_BOOTSTRAP_REVIEWER_POLICY.version,
      reviewers: [
        {
          id: "maintainer:docs",
          role: "maintainer" as const,
          publicKey: wrongKeys.publicKey.export({ type: "spki", format: "pem" }).toString(),
        },
      ],
    };
    const wrongPolicy = { ...wrongValue, digest: iaPlanReviewerPolicyDigest(wrongValue) };
    const validBundle = siteBootstrapBundle(index, NOW);
    expect(() =>
      validateSiteBootstrapApplicationBundle(validBundle, {
        now: NOW,
        reviewerPolicy: wrongPolicy,
      }),
    ).toThrow("invalid-bundle");
  });

  it("rethrows nested contract codes and wraps other failures with cause", async () => {
    const repository = await fixtureRepository(roots);
    const index = siteBootstrapIndex(repository.revision);
    const bundle = siteBootstrapBundle(index, NOW);
    const options = { now: NOW, reviewerPolicy: SITE_BOOTSTRAP_REVIEWER_POLICY };
    const broken = structuredClone(bundle);
    broken.plan = { kind: "not-an-artifact" } as unknown as typeof broken.plan;

    try {
      validateSiteBootstrapApplicationBundle(broken, options);
      throw new Error("expected nested contract error");
    } catch (error) {
      expect(error).toBeInstanceOf(ArtifactValidationError);
      expect((error as ArtifactValidationError).code).toBe("missing-field");
      expect(error).not.toBeInstanceOf(SiteBootstrapBundleError);
    }

    const root = await mkdtemp(join(tmpdir(), "docsfab-site-bundle-json-"));
    roots.push(root);
    const path = join(root, "plan.json");
    await writeFile(path, "{", "utf8");
    try {
      await loadSiteBootstrapApplicationBundle(path, options);
      throw new Error("expected wrapped JSON failure");
    } catch (error) {
      expect(error).toBeInstanceOf(SiteBootstrapBundleError);
      expect((error as SiteBootstrapBundleError).code).toBe("invalid-bundle");
      expect((error as SiteBootstrapBundleError).cause).toBeInstanceOf(SyntaxError);
    }
  });
});

function digestWithout<T extends { digest: string }>(value: T): string {
  const { digest: _digest, ...unsigned } = value;
  return canonicalDigest(unsigned);
}
