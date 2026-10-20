// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  createModelEvidence,
  modelEvidenceProjectionDefect,
  modelProfileEvidenceSha256,
  validModelEvidenceProjection,
} from "../src/model/profile-evidence.js";
import { parseModelEndpoint, type BoundModelExecutionProfile } from "../src/model/configuration.js";
import type { ModelEvidence } from "../src/records/contracts.js";
import { decodeModelEvidence } from "../src/scorecard-record.js";
import { validModelConfig, validModelEnvironment } from "./helpers.js";

const EVIDENCE_NOW = new Date("2026-09-25T12:00:00.000Z");

/** Parse through the real configuration loader, as `profile inspect` does. */
function evidenceFor(overrides: Record<string, string>) {
  return createModelEvidence(
    parseModelEndpoint({ ...validModelEnvironment, ...overrides }, "MODEL", EVIDENCE_NOW),
  );
}

const LAPSED = {
  MODEL_PROFILE_EFFECTIVE_DATE: "2020-01-01",
  MODEL_PROFILE_REVIEW_AFTER: "2020-02-01",
};
const UNATTESTED = {
  MODEL_PROFILE_APPROVED_SOURCE: "unknown",
  MODEL_PROFILE_EFFECTIVE_DATE: "unknown",
  MODEL_PROFILE_REVIEW_AFTER: "unknown",
};

/** Mutate a projection and re-seal its digest, so only the edited rule can reject it. */
function resealed(
  evidence: ModelEvidence,
  edit: (profile: NonNullable<ModelEvidence["profile"]>) => void,
): ModelEvidence {
  const copy = structuredClone(evidence);
  edit(copy.profile!);
  const { sha256: _digest, ...profile } = copy.profile!;
  copy.profile!.sha256 = modelProfileEvidenceSha256({
    provider: copy.provider,
    model: copy.model,
    profile,
  });
  return copy;
}

/**
 * A legacy `stale` projection with every unattested claim stripped. The loader
 * never produces it; saved records carry it and must keep decoding.
 */
function historicalStaleEvidence(): ModelEvidence {
  return resealed(evidenceFor(LAPSED), (profile) => {
    profile.status = "stale";
    profile.effectiveLimitReason = "metadata-stale";
    profile.reasoning = false;
    profile.input = ["text"];
    profile.compatibility.supportsDeveloperRole = false;
    profile.compatibility.supportsReasoningEffort = false;
    profile.costPerMillionTokens = { input: null, output: null, cacheRead: null, cacheWrite: null };
    profile.pricing = "unknown";
  });
}

describe("model profile evidence", () => {
  it("projects complete credential-free profile provenance", () => {
    const evidence = createModelEvidence(validModelConfig);
    const serialized = JSON.stringify(evidence);

    expect(evidence.provider).toBe(validModelConfig.providerId);
    expect(evidence.model).toBe(validModelConfig.modelId);
    expect(evidence.profile).toMatchObject({
      schemaVersion: 2,
      status: "current",
      configuredContextWindow: 128_000,
      effectiveContextWindow: 128_000,
      configuredMaxInputTokens: 128_000,
      effectiveMaxInputTokens: 128_000,
      configuredMaxOutputTokens: 16_384,
      effectiveMaxOutputTokens: 16_384,
      apiFormat: "chat_completions",
      pricing: "unknown",
      requestPolicy: {
        minimumOutputTokens: 16,
        reservedContextTokens: 4_096,
      },
    });
    expect(serialized).not.toContain(validModelConfig.apiKey);
    expect(serialized).not.toContain(validModelConfig.baseUrl);
    expect(serialized).not.toContain(validModelConfig.profile.metadata.approvedSource!);
    expect(evidence.profile?.approvedSourceSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("is stable and recomputable from the published safe projection", () => {
    const first = createModelEvidence(validModelConfig);
    const second = createModelEvidence(structuredClone(validModelConfig));
    expect(second).toEqual(first);

    const { sha256, ...profile } = first.profile!;
    expect(
      modelProfileEvidenceSha256({
        provider: first.provider,
        model: first.model,
        profile,
      }),
    ).toBe(sha256);
  });

  it("changes when an approved economic or request-policy fact changes", () => {
    const first = createModelEvidence(validModelConfig);
    const changedCost = structuredClone(validModelConfig);
    changedCost.profile.costPerMillionTokens.input = 2;
    const changedReserve = structuredClone(validModelConfig);
    changedReserve.requestPolicy.reservedContextTokens = 8_192;

    expect(createModelEvidence(changedCost).profile?.sha256).not.toBe(first.profile?.sha256);
    expect(createModelEvidence(changedReserve).profile?.sha256).not.toBe(first.profile?.sha256);
  });

  it("projects a provider-neutral messages profile with candidate ceilings", () => {
    const bound: BoundModelExecutionProfile = {
      routeId: "direct-anthropic",
      providerId: "anthropic-api",
      baseUrl: "https://api.anthropic.example.test/v1",
      modelId: "claude-opus-4-7",
      transport: "anthropic-messages",
      apiFormat: "messages",
      profile: {
        ...structuredClone(validModelConfig.profile),
        contextWindow: 32_768,
        maxInputTokens: 30_000,
        maxOutputTokens: 8_192,
        effectiveLimitReason: "composition-candidate",
        compatibility: {
          ...structuredClone(validModelConfig.profile.compatibility),
          apiFormats: ["messages"],
        },
        costPerMillionTokens: {
          input: null,
          output: null,
          cacheRead: null,
          cacheWrite: null,
        },
        metadata: {
          approvedSource: null,
          effectiveDate: null,
          reviewAfter: null,
          status: "unknown",
        },
      },
      requestPolicy: { ...validModelConfig.requestPolicy },
      compositionPolicy: {
        maxProviderTurns: 8,
        timeoutMs: 60_000,
        maxResponseBytes: 1_000_000,
      },
    };

    const evidence = createModelEvidence(bound);
    expect(evidence).toMatchObject({
      provider: "anthropic-api",
      model: "claude-opus-4-7",
      profile: {
        status: "unknown",
        effectiveContextWindow: 32_768,
        effectiveMaxInputTokens: 30_000,
        effectiveMaxOutputTokens: 8_192,
        effectiveLimitReason: "composition-candidate",
        apiFormat: "messages",
        pricing: "unknown",
      },
    });
    expect(validModelEvidenceProjection(evidence)).toBe(true);
    expect(decodeModelEvidence(JSON.parse(JSON.stringify(evidence)))).toEqual(evidence);
    expect(JSON.stringify(evidence)).not.toContain(bound.baseUrl);

    const fallbackClaim = structuredClone(evidence);
    fallbackClaim.profile!.effectiveLimitReason = "metadata-unknown";
    const { sha256: _fallbackDigest, ...fallbackProfile } = fallbackClaim.profile!;
    fallbackClaim.profile!.sha256 = modelProfileEvidenceSha256({
      provider: fallbackClaim.provider,
      model: fallbackClaim.model,
      profile: fallbackProfile,
    });
    // Unknown metadata carries no invented 8k lid, so a reduced window under
    // `metadata-unknown` is admitted like any other effective limit at or below
    // the configured one. Candidate-only claims (known prices, below) and a
    // label that contradicts the status still fail.
    expect(modelEvidenceProjectionDefect(fallbackClaim)).toBeUndefined();
    const staleLabel = structuredClone(fallbackClaim);
    staleLabel.profile!.effectiveLimitReason = "metadata-stale";
    const { sha256: _staleDigest, ...staleLabelProfile } = staleLabel.profile!;
    staleLabel.profile!.sha256 = modelProfileEvidenceSha256({
      provider: staleLabel.provider,
      model: staleLabel.model,
      profile: staleLabelProfile,
    });
    expect(modelEvidenceProjectionDefect(staleLabel)).toBe("limit-reason");
    expect(validModelEvidenceProjection(staleLabel)).toBe(false);

    const pricedCandidate = structuredClone(evidence);
    pricedCandidate.profile!.costPerMillionTokens = {
      input: 1,
      output: 1,
      cacheRead: 1,
      cacheWrite: 1,
    };
    pricedCandidate.profile!.pricing = "known";
    const { sha256: _pricedDigest, ...pricedProfile } = pricedCandidate.profile!;
    pricedCandidate.profile!.sha256 = modelProfileEvidenceSha256({
      provider: pricedCandidate.provider,
      model: pricedCandidate.model,
      profile: pricedProfile,
    });
    expect(validModelEvidenceProjection(pricedCandidate)).toBe(false);
  });

  it("requires a bound execution profile for candidate-limit evidence", () => {
    const legacyCandidate = structuredClone(validModelConfig);
    legacyCandidate.profile.effectiveLimitReason = "composition-candidate";
    expect(() => createModelEvidence(legacyCandidate)).toThrow(
      "Composition candidate limits require a bound model execution profile.",
    );
  });

  it("strictly rejects forged, incomplete, and semantically contradictory projections", () => {
    const valid = createModelEvidence(validModelConfig);
    expect(validModelEvidenceProjection(valid)).toBe(true);

    const forged = structuredClone(valid);
    forged.profile!.requestPolicy.reservedContextTokens += 1;
    expect(validModelEvidenceProjection(forged)).toBe(false);

    const extra = structuredClone(valid) as typeof valid & {
      profile: NonNullable<typeof valid.profile> & { endpoint: string };
    };
    extra.profile.endpoint = "private";
    const { sha256: _sha256, ...profile } = extra.profile;
    extra.profile.sha256 = modelProfileEvidenceSha256({
      provider: extra.provider,
      model: extra.model,
      profile,
    });
    expect(validModelEvidenceProjection(extra)).toBe(false);

    const contradictory = structuredClone(valid);
    contradictory.profile!.effectiveContextWindow -= 1;
    const { sha256: _digest, ...contradictoryProfile } = contradictory.profile!;
    contradictory.profile!.sha256 = modelProfileEvidenceSha256({
      provider: contradictory.provider,
      model: contradictory.model,
      profile: contradictoryProfile,
    });
    expect(validModelEvidenceProjection(contradictory)).toBe(false);

    const strippedV2 = structuredClone(valid);
    delete strippedV2.profile!.configuredMaxInputTokens;
    delete strippedV2.profile!.effectiveMaxInputTokens;
    const { sha256: _strippedDigest, ...strippedProfile } = strippedV2.profile!;
    strippedV2.profile!.sha256 = modelProfileEvidenceSha256({
      provider: strippedV2.provider,
      model: strippedV2.model,
      profile: strippedProfile,
    });
    expect(validModelEvidenceProjection(strippedV2)).toBe(false);

    const legacy = structuredClone(strippedV2);
    legacy.profile!.schemaVersion = 1;
    const { sha256: _legacyDigest, ...legacyProfile } = legacy.profile!;
    legacy.profile!.sha256 = modelProfileEvidenceSha256({
      provider: legacy.provider,
      model: legacy.model,
      profile: legacyProfile,
    });
    expect(validModelEvidenceProjection(legacy)).toBe(true);

    legacy.profile!.configuredMaxInputTokens = 128_000;
    legacy.profile!.effectiveMaxInputTokens = 128_000;
    const { sha256: _v1Digest, ...v1WithInput } = legacy.profile!;
    legacy.profile!.sha256 = modelProfileEvidenceSha256({
      provider: legacy.provider,
      model: legacy.model,
      profile: v1WithInput,
    });
    expect(validModelEvidenceProjection(legacy)).toBe(false);
  });

  describe("lapsed and unattested windows (#1094)", () => {
    it.each([
      ["stale", () => historicalStaleEvidence(), "metadata-stale"],
      ["unknown", () => evidenceFor(UNATTESTED), "metadata-unknown"],
    ] as const)(
      "accepts a real-sized %s profile without an invented 8k lid",
      (status, build, reason) => {
        const evidence = build();
        expect(evidence.profile).toMatchObject({
          status,
          effectiveLimitReason: reason,
          effectiveContextWindow: 128_000,
          effectiveMaxInputTokens: 128_000,
          effectiveMaxOutputTokens: 16_384,
          pricing: "unknown",
        });
        expect(modelEvidenceProjectionDefect(evidence)).toBeUndefined();
        expect(validModelEvidenceProjection(evidence)).toBe(true);
      },
    );

    it("keeps every other lapsed-profile invariant and names the broken field", () => {
      const lapsed = historicalStaleEvidence();
      const priced = resealed(lapsed, (profile) => {
        profile.costPerMillionTokens = {
          input: 1,
          output: 1,
          cacheRead: 1,
          cacheWrite: 1,
        };
        profile.pricing = "known";
      });
      expect(modelEvidenceProjectionDefect(priced)).toBe("pricing");
      const undated = resealed(lapsed, (profile) => {
        delete profile.reviewAfter;
      });
      expect(modelEvidenceProjectionDefect(undated)).toBe("review-after");
      const unsourced = resealed(lapsed, (profile) => {
        delete profile.approvedSourceSha256;
      });
      expect(modelEvidenceProjectionDefect(unsourced)).toBe("approved-source");
      const wrongReason = resealed(lapsed, (profile) => {
        profile.effectiveLimitReason = "none";
      });
      expect(modelEvidenceProjectionDefect(wrongReason)).toBe("limit-reason");
      const undatedEffective = resealed(lapsed, (profile) => {
        delete profile.effectiveDate;
      });
      expect(modelEvidenceProjectionDefect(undatedEffective)).toBe("effective-date");
      for (const rejected of [priced, undated, unsourced, wrongReason, undatedEffective]) {
        expect(validModelEvidenceProjection(rejected)).toBe(false);
      }
    });

    it("keeps every other unattested-profile invariant and names the broken field", () => {
      const unattested = evidenceFor(UNATTESTED);
      const sourced = resealed(unattested, (profile) => {
        profile.approvedSourceSha256 = "a".repeat(64);
      });
      expect(modelEvidenceProjectionDefect(sourced)).toBe("approved-source");
      const dated = resealed(unattested, (profile) => {
        profile.reviewAfter = "2099-12-31";
      });
      expect(modelEvidenceProjectionDefect(dated)).toBe("review-after");
      const effective = resealed(unattested, (profile) => {
        profile.effectiveDate = "2020-01-01";
      });
      expect(modelEvidenceProjectionDefect(effective)).toBe("effective-date");
      for (const rejected of [sourced, dated, effective]) {
        expect(validModelEvidenceProjection(rejected)).toBe(false);
      }
    });

    it("still refuses a current projection whose effective window differs from configuration", () => {
      // Adjacent condition: admitting a reduced window is scoped to stale/unknown
      // status.
      const current = createModelEvidence(validModelConfig);
      const narrowed = resealed(current, (profile) => {
        profile.effectiveContextWindow = 8_192;
        profile.effectiveMaxInputTokens = 8_192;
        profile.effectiveMaxOutputTokens = 4_096;
      });
      expect(modelEvidenceProjectionDefect(narrowed)).toBe("context-window");
      expect(validModelEvidenceProjection(narrowed)).toBe(false);
    });

    it.each([
      ["model", { MODEL_ID: "llama3:8b" }],
      ["model", { MODEL_ID: "example/../model" }],
      ["provider", { MODEL_PROVIDER: "Test Provider" }],
    ] as const)("names the %s identifier that cannot form evidence", (defect, overrides) => {
      const evidence = evidenceFor(overrides);
      expect(modelEvidenceProjectionDefect(evidence)).toBe(defect);
      expect(validModelEvidenceProjection(evidence)).toBe(false);
    });

    it("reports a forged digest as a digest defect, not a configuration field", () => {
      const forged = structuredClone(historicalStaleEvidence());
      forged.profile!.requestPolicy.reservedContextTokens += 1;
      expect(modelEvidenceProjectionDefect(forged)).toBe("digest");
    });
  });
});

describe("a passed review date leaves model evidence unchanged", () => {
  const REVIEW_AFTER = "2026-09-29";
  const environment = {
    ...validModelEnvironment,
    MODEL_CACHE_WRITE_COST_PER_MILLION: "0.75",
    MODEL_PROFILE_REVIEW_AFTER: REVIEW_AFTER,
  };
  const evidenceAt = (instant: string) =>
    createModelEvidence(parseModelEndpoint(environment, "MODEL", new Date(instant)));

  it("keeps the evidence digest byte-identical a day either side of the review date", () => {
    const before = evidenceAt("2026-09-28T12:00:00.000Z");
    const after = evidenceAt("2026-09-30T12:00:00.000Z");
    expect(REVIEW_AFTER < "2026-09-30").toBe(true);

    expect(after.profile!.sha256).toBe(before.profile!.sha256);
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    expect(after.profile).toMatchObject({
      status: "current",
      effectiveLimitReason: "none",
      reasoning: true,
      pricing: "known",
      reviewAfter: REVIEW_AFTER,
    });
    expect(validModelEvidenceProjection(after)).toBe(true);
    expect(decodeModelEvidence(JSON.parse(JSON.stringify(after)))).toEqual(after);
  });

  it("still decodes a saved legacy stale projection unchanged", () => {
    const stale = historicalStaleEvidence();
    expect(decodeModelEvidence(JSON.parse(JSON.stringify(stale)))).toEqual(stale);
  });
});
