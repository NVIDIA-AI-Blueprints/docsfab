// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * A passed model-profile review date is advisory.
 * These cases pin the consumers of a date-derived `stale` that need no code
 * change: the hosted composition packet, Pi lease pricing, and the saved-record
 * projection. Each proves identity and behaviour are the same a day either side
 * of the review date, and keeps one adjacent case (a saved record or packet
 * carrying legacy `stale`, or unknown metadata) on its existing path.
 */
import { afterEach, describe, expect, it } from "vitest";

import { reviewOverdueModelEvidence } from "../src/execution/inference-evidence.js";
import {
  parseHostRuntimeComposition,
  sealHostRuntimeComposition,
} from "../src/host-invoker/composition.js";
import {
  bindModelExecutionProfile,
  parseModelEndpoint,
  type BoundModelExecutionProfile,
  type ModelProfile,
} from "../src/model/configuration.js";
import { createModelEvidence } from "../src/model/profile-evidence.js";
import type { ModelEvidence } from "../src/records/contracts.js";
import {
  createPiExecutionLeaseController,
  createRepository,
  resetSharedTestState,
  stepInput,
} from "./support/pi-harness-session-fixtures.js";
import { validModelEnvironment } from "./helpers.js";

afterEach(resetSharedTestState);

// Past on the wall clock too, so code that reads the wall clock instead of the
// injected clock also sees an overdue date.
const REVIEW_AFTER = "2026-09-01";
const BEFORE = new Date("2026-08-31T12:00:00.000Z");
const AFTER = new Date("2026-09-02T12:00:00.000Z");
// Non-default claims, so a stripped profile cannot pass as "unchanged".
const ENVIRONMENT = {
  ...validModelEnvironment,
  MODEL_CACHE_WRITE_COST_PER_MILLION: "0.75",
  MODEL_PROFILE_REVIEW_AFTER: REVIEW_AFTER,
};

function profileAt(now: Date): ModelProfile {
  return parseModelEndpoint(ENVIRONMENT, "MODEL", now).profile;
}

/** The legacy stripped `stale` shape; only saved packets carry it. */
function historicalStaleProfile(): ModelProfile {
  const current = profileAt(BEFORE);
  return {
    ...current,
    effectiveLimitReason: "metadata-stale",
    reasoning: false,
    input: ["text"],
    compatibility: {
      ...current.compatibility,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
    },
    costPerMillionTokens: { input: null, output: null, cacheRead: null, cacheWrite: null },
    metadata: { ...current.metadata, status: "stale" },
  };
}

function sealedPacket(profile: ModelProfile) {
  return sealHostRuntimeComposition({
    compositionId: "review-date-advisory-v1",
    route: "nvidia-inference-api",
    credentialFamily: "nvidia-inference-api",
    executionProfile: {
      routeId: "nvidia-inference-api",
      providerId: "nvidia-inference-api",
      baseUrl: "https://example.invalid/v1",
      modelId: "model-fixture",
      transport: "openai-chat-completions",
      apiFormat: "chat_completions",
      profile,
      requestPolicy: { minimumOutputTokens: 16, reservedContextTokens: 512 },
    },
    declaredTools: ["read"],
  });
}

describe("hosted composition packet across the review date", () => {
  it("seals the same composition digest on both sides of the date", () => {
    expect(REVIEW_AFTER < AFTER.toISOString().slice(0, 10)).toBe(true);
    const before = sealedPacket(profileAt(BEFORE));
    const after = sealedPacket(profileAt(AFTER));

    expect(after.compositionSha256).toBe(before.compositionSha256);
    expect(after.executionProfile!.profile).toMatchObject({
      effectiveLimitReason: "none",
      reasoning: true,
      metadata: { status: "current", reviewAfter: REVIEW_AFTER },
    });
    // The exact-key decoder accepts the packet: no advisory key was added.
    expect(parseHostRuntimeComposition(JSON.parse(JSON.stringify(after)))).toEqual(after);
  });

  it("still decodes a legacy packet with its stale profile unchanged", () => {
    const packet = sealedPacket(historicalStaleProfile());
    const decoded = parseHostRuntimeComposition(JSON.parse(JSON.stringify(packet)));
    expect(decoded.executionProfile!.profile).toMatchObject({
      effectiveLimitReason: "metadata-stale",
      metadata: { status: "stale" },
    });
  });
});

describe("Pi lease pricing across the review date", () => {
  async function pricingFor(profile: ModelProfile) {
    const bound: BoundModelExecutionProfile = bindModelExecutionProfile(
      parseModelEndpoint(ENVIRONMENT, "MODEL", BEFORE),
    ).profile;
    const repositoryPath = await createRepository();
    return createPiExecutionLeaseController(stepInput(repositoryPath), { ...bound, profile }, [
      "read",
    ]).coordinator.pricing;
  }

  it("keeps known pricing and a byte-identical pricing authority after the date", async () => {
    const before = await pricingFor(profileAt(BEFORE));
    const after = await pricingFor(profileAt(AFTER));

    expect(after).toEqual(before);
    expect(after).toMatchObject({ status: "known" });
  });

  it("keeps a legacy stale profile on pricing-stale, and unknown metadata on pricing-unknown", async () => {
    // Adjacent conditions: status-derived reasons are unchanged for saved
    // stale packets and for absent provenance.
    expect(await pricingFor(historicalStaleProfile())).toMatchObject({
      status: "unavailable",
      reason: "pricing-stale",
    });
    const unknown = parseModelEndpoint(
      {
        ...ENVIRONMENT,
        MODEL_PROFILE_APPROVED_SOURCE: "unknown",
        MODEL_PROFILE_EFFECTIVE_DATE: "unknown",
        MODEL_PROFILE_REVIEW_AFTER: "unknown",
      },
      "MODEL",
      AFTER,
    ).profile;
    expect(await pricingFor(unknown)).toMatchObject({
      status: "unavailable",
      reason: "pricing-unknown",
    });
  });
});

describe("saved-record review-overdue projection", () => {
  const overdueModel = createModelEvidence(parseModelEndpoint(ENVIRONMENT, "MODEL", AFTER));
  const unknownModel = createModelEvidence(
    parseModelEndpoint(
      {
        ...ENVIRONMENT,
        MODEL_PROFILE_APPROVED_SOURCE: "unknown",
        MODEL_PROFILE_EFFECTIVE_DATE: "unknown",
        MODEL_PROFILE_REVIEW_AFTER: "unknown",
      },
      "MODEL",
      AFTER,
    ),
  );
  const bareModel: ModelEvidence = { provider: "fixture", model: "fixture-model" };

  it("names each model whose review date had passed when the run started", () => {
    expect(
      reviewOverdueModelEvidence([overdueModel, unknownModel, bareModel], AFTER.toISOString()),
    ).toEqual([
      { provider: overdueModel.provider, model: overdueModel.model, reviewAfter: REVIEW_AFTER },
    ]);
  });

  it("names nothing for a run that started on or before the review date", () => {
    // Adjacent condition: the same evidence read as of the review day.
    expect(reviewOverdueModelEvidence([overdueModel], `${REVIEW_AFTER}T23:59:59.000Z`)).toEqual([]);
    expect(reviewOverdueModelEvidence([overdueModel], BEFORE.toISOString())).toEqual([]);
  });

  it("names nothing when the run time is not a timestamp", () => {
    // Adjacent condition: an unreadable run time is the decoders' concern; the
    // advisory reader must not throw or guess.
    expect(reviewOverdueModelEvidence([overdueModel], "not-a-time")).toEqual([]);
  });
});
