// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createPrivateKey, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createArtifact, type ArtifactReference } from "../src/artifacts/index.js";
import { canonicalDigest } from "../src/content-ir/index.js";
import {
  digest,
  parseHostRuntimeNativePlanReference,
  parseHostRuntimeNativeSource,
} from "../src/host-invoker/contracts.js";
import { verifyNativeSiteImport } from "../src/host-invoker/native-approval.js";
import { approvedPlanFixture, removeHostedSiteFixtures } from "./helpers/hosted-site-bootstrap.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";

/** One real analysis, plan and reviewer signature chain; CI raises this budget. */
const LOCAL_SUITE_TIMEOUT_MS = 180_000;

afterAll(removeHostedSiteFixtures);

function reference(artifact: {
  kind: string;
  schemaVersion: number;
  digest: string;
  repository: { revision: string; contentDigest: string };
}): ArtifactReference<"ia-plan"> {
  return {
    kind: artifact.kind as "ia-plan",
    schemaVersion: artifact.schemaVersion as 1,
    digest: artifact.digest,
    repositoryRevision: artifact.repository.revision,
    repositoryContentDigest: artifact.repository.contentDigest,
  };
}

describe("native site import verification", {
  timeout: testTimeoutMs(LOCAL_SUITE_TIMEOUT_MS),
}, () => {
  it("binds a genuinely signed successor to the producer's exact pending plan", async () => {
    const approved = await approvedPlanFixture();
    const verified = verifyNativeSiteImport({
      pendingPlan: approved.pendingPlan,
      bundle: approved.bundle,
      reviewerPolicy: approved.reviewerPolicy,
      repositoryRevision: approved.revision,
      now: approved.now,
    });
    expect(verified.plan.digest).toBe(approved.bundle.plan.digest);
    expect(verified.pendingPlan).toEqual(approved.bundle.review.predecessorPlan);
    // The same genuine pair at another revision is stale.
    expect(() =>
      verifyNativeSiteImport({
        pendingPlan: approved.pendingPlan,
        bundle: approved.bundle,
        reviewerPolicy: approved.reviewerPolicy,
        repositoryRevision: "f".repeat(40),
        now: approved.now,
      }),
    ).toThrow(expect.objectContaining({ code: "stale-repository" }));
  });

  it("refuses a pending plan the reviewer did not sign", async () => {
    const approved = await approvedPlanFixture();
    // The approved successor is itself a valid `ia-plan`, but not the producer's.
    expect(() =>
      verifyNativeSiteImport({
        pendingPlan: approved.bundle.plan,
        bundle: approved.bundle,
        reviewerPolicy: approved.reviewerPolicy,
        repositoryRevision: approved.revision,
        now: approved.now,
      }),
    ).toThrow("The signed native approval names a different producing plan artifact.");
  });

  it("refuses a pending input that is not an IA plan", async () => {
    const approved = await approvedPlanFixture();
    expect(() =>
      verifyNativeSiteImport({
        pendingPlan: approved.bundle.evaluation,
        bundle: approved.bundle,
        reviewerPolicy: approved.reviewerPolicy,
        repositoryRevision: approved.revision,
        now: approved.now,
      }),
    ).toThrow("Native approval import requires the accepted producer's IA plan artifact.");
  });

  it("refuses a signed successor that changed more than the review transition", async () => {
    const approved = await approvedPlanFixture();
    const { bundle } = approved;
    // A reviewer key can sign any successor. This one keeps every field the
    // bundle validator binds and changes only its expiry, so only the
    // canonical-transition comparison can tell it apart.
    const successor = bundle.plan;
    const expiresAt = new Date(
      (approved.now.valueOf() + Date.parse(successor.payload.expiresAt)) / 2,
    ).toISOString();
    const altered = createArtifact(
      "ia-plan",
      { ...structuredClone(successor.payload), expiresAt },
      { index: bundle.evaluationInput.index, now: approved.now },
    );
    const { signature: _signature, digest: _digest, ...statementBody } = bundle.review;
    const statement = { ...statementBody, plan: reference(altered), expiresAt };
    const privateKey = createPrivateKey(await readFile(join(approved.root, "reviewer-key.pem")));
    const signature = sign(
      null,
      Buffer.from(canonicalDigest(statement), "hex"),
      privateKey,
    ).toString("base64url");
    const review = {
      ...statement,
      signature,
      digest: canonicalDigest({ ...statement, signature }),
    };
    const { digest: _bundleDigest, ...bundleBody } = { ...bundle, plan: altered, review };
    const resigned = { ...bundleBody, digest: canonicalDigest(bundleBody) };
    expect(() =>
      verifyNativeSiteImport({
        pendingPlan: approved.pendingPlan,
        bundle: resigned,
        reviewerPolicy: approved.reviewerPolicy,
        repositoryRevision: approved.revision,
        now: approved.now,
      }),
    ).toThrow("The approved native plan changed the producing plan beyond its review transition.");
  });
});

describe("shared native codecs", () => {
  const binding = {
    deploymentId: "native-test",
    projectId: "project-a",
    deploymentEpoch: "epoch-a",
  };
  const receiptSha256 = "b".repeat(64);
  const source = {
    requestKey: "source-one",
    runId: "source-run",
    principalId: "source-person",
    workflow: "ia-plan",
    revision: "d".repeat(40),
    repositoryIdentitySha256: "a".repeat(64),
    receiptLocator: `cas:${digest(binding).slice(0, 32)}:${receiptSha256}`,
    receiptSha256,
  };
  const expected = {
    receiptPrefix: `cas:${digest(binding).slice(0, 32)}:`,
    repositoryIdentitySha256: source.repositoryIdentitySha256,
  };

  it("parses an accepted producer's provenance with and without custody's own binding", () => {
    expect(parseHostRuntimeNativeSource(source, expected)).toEqual(source);
    expect(parseHostRuntimeNativeSource(source)).toEqual(source);
  });

  it("binds the receipt prefix and repository only when custody supplies them", () => {
    const foreign = { ...source, receiptLocator: `cas:${"e".repeat(32)}:${receiptSha256}` };
    expect(() => parseHostRuntimeNativeSource(foreign, expected)).toThrow(
      "native-custody-receipt-binding",
    );
    // The host receipt codec supplies no prefix and binds the exact locator to
    // its own binding itself.
    expect(parseHostRuntimeNativeSource(foreign).receiptLocator).toBe(foreign.receiptLocator);
    expect(() =>
      parseHostRuntimeNativeSource(
        { ...source, repositoryIdentitySha256: "c".repeat(64) },
        expected,
      ),
    ).toThrow("native-custody-repository-binding");
    // The digest suffix is bound either way.
    expect(() =>
      parseHostRuntimeNativeSource({ ...source, receiptSha256: "c".repeat(64) }),
    ).toThrow("native-custody-receipt-binding");
  });

  it("admits only an IA plan reference", () => {
    const plan = {
      kind: "ia-plan",
      schemaVersion: 1,
      digest: "a".repeat(64),
      repositoryRevision: "d".repeat(40),
      repositoryContentDigest: "b".repeat(64),
    };
    expect(parseHostRuntimeNativePlanReference(plan)).toEqual(plan);
    expect(() => parseHostRuntimeNativePlanReference({ ...plan, kind: "ia-evaluation" })).toThrow(
      /invalid-enum/,
    );
  });
});
