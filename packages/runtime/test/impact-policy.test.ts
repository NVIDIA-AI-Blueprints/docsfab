// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { canonicalDigest } from "../src/content-ir/canonical.js";
import {
  DEFAULT_HEALING_POLICY,
  HealingPolicyError,
  createHealingDecisionMemory,
  evaluateHealingPolicy,
  healingProposalFingerprint,
  type HealingPolicyInput,
  type MaterialEvidence,
} from "../src/impact/policy.js";

const NOW = "2026-08-03T16:00:00.000Z";
const AFTER_COOLDOWN = "2026-08-11T16:00:00.000Z";

describe("deterministic healing policy", () => {
  it("records 400-word growth as a signal without diagnosing a repair", () => {
    const decision = evaluateHealingPolicy(
      input({
        wordGrowth: 400,
        pressure: 1,
        materialEvidence: [],
      }),
    );

    expect(decision).toMatchObject({
      level: "observe",
      requiredApproval: "none",
      wordGrowthSignal: true,
      suppressedBy: "insufficient-material-evidence",
    });
  });

  it.each([
    ["bounded-repair", 0.35, "maintainer"],
    ["structural-proposal", 0.7, "maintainer"],
    ["ontology-review", 0.9, "product-owner"],
  ] as const)(
    "selects %s at its trigger with the mapped approval",
    (requestedLevel, pressure, requiredApproval) => {
      const decision = evaluateHealingPolicy(
        input({
          pressure,
          proposal: { ...proposal(), requestedLevel },
        }),
      );

      expect(decision.level).toBe(requestedLevel);
      expect(decision.requiredApproval).toBe(requiredApproval);
    },
  );

  it("uses lower recovery thresholds to prevent oscillation", () => {
    const retained = evaluateHealingPolicy(
      input({
        pressure: 0.5,
        previousLevel: "structural-proposal",
        proposal: { ...proposal(), requestedLevel: "structural-proposal" },
      }),
    );
    const recovered = evaluateHealingPolicy(
      input({
        pressure: 0.49,
        previousLevel: "structural-proposal",
        proposal: { ...proposal(), requestedLevel: "structural-proposal" },
      }),
    );

    expect(retained.level).toBe("structural-proposal");
    expect(recovered.level).toBe("observe");
    expect(recovered.suppressedBy).toBe("below-threshold");
    expect(DEFAULT_HEALING_POLICY.thresholds["structural-proposal"]).toEqual({
      trigger: 0.7,
      recovery: 0.5,
    });
  });

  it("never downgrades structural or ontology work into a lower-authority action", () => {
    const structural = evaluateHealingPolicy(
      input({
        pressure: 0.69,
        proposal: { ...proposal(), requestedLevel: "structural-proposal" },
      }),
    );
    const ontology = evaluateHealingPolicy(
      input({
        pressure: 0.89,
        proposal: { ...proposal(), requestedLevel: "ontology-review" },
      }),
    );

    expect(structural).toMatchObject({ level: "observe", suppressedBy: "below-threshold" });
    expect(ontology).toMatchObject({ level: "observe", suppressedBy: "below-threshold" });
  });

  it("biases against stable URL changes without sufficient expected benefit", () => {
    const decision = evaluateHealingPolicy(
      input({
        pressure: 1,
        expectedBenefit: 0.69,
        proposal: { ...proposal(), changesStableUrl: true },
      }),
    );

    expect(decision).toMatchObject({
      level: "observe",
      suppressedBy: "stable-url-bias",
      effectivePressure: 0.85,
    });
  });

  it("uses a stable proposal fingerprint independent of collection order", () => {
    const left = proposal();
    const right = {
      ...left,
      targetNodeIds: [...left.targetNodeIds].reverse(),
      outputPaths: [...left.outputPaths].reverse(),
    };

    expect(healingProposalFingerprint(left)).toBe(healingProposalFingerprint(right));
  });

  it("suppresses a rejected proposal until material evidence changes", () => {
    const original = input({ observedAt: AFTER_COOLDOWN });
    const rejected = createHealingDecisionMemory(
      original.proposal,
      original.materialEvidence,
      "rejected",
      NOW,
    );
    const repeated = evaluateHealingPolicy({ ...original, memory: [rejected] });
    const changed = evaluateHealingPolicy({
      ...original,
      materialEvidence: original.materialEvidence.map((item, index) =>
        index === 0 ? { ...item, digest: "f".repeat(64) } : item,
      ),
      memory: [rejected],
    });

    expect(repeated.suppressedBy).toBe("rejected-repeat");
    expect(changed.suppressedBy).toBeUndefined();
    expect(changed.level).toBe("structural-proposal");
  });

  it("applies cooldown even when recent evidence has changed", () => {
    const original = input();
    const approved = createHealingDecisionMemory(
      original.proposal,
      original.materialEvidence,
      "approved",
      "2026-08-02T16:00:00.000Z",
    );
    const changedEvidence = original.materialEvidence.map((item, index) =>
      index === 0 ? { ...item, digest: "f".repeat(64) } : item,
    );

    expect(
      evaluateHealingPolicy({
        ...original,
        materialEvidence: changedEvidence,
        memory: [approved],
      }).suppressedBy,
    ).toBe("cooldown");
  });

  it("can produce only reviewable proposals and never merge or publish", () => {
    const decision = evaluateHealingPolicy(input());

    expect(decision.delivery).toEqual({
      mode: "reviewable-proposal-only",
      mayMerge: false,
      mayPublish: false,
    });
  });

  it("fails closed when a versioned policy is modified without resigning it", () => {
    const policy = {
      ...DEFAULT_HEALING_POLICY,
      minimumMaterialEvidence: 1,
    };

    expect(() => evaluateHealingPolicy(input(), policy)).toThrowError(HealingPolicyError);
    expect(() => evaluateHealingPolicy(input(), policy)).toThrow("invalid-policy");
    expect(DEFAULT_HEALING_POLICY.digest).toBe(
      canonicalDigest((({ digest: _digest, ...value }) => value)(DEFAULT_HEALING_POLICY)),
    );
  });
});

function proposal() {
  return {
    action: "split-page",
    requestedLevel: "structural-proposal" as const,
    targetNodeIds: ["document:guide.md", "section:guide.md#configure"],
    outputPaths: ["docs/guide.md", "docs/configure.md"],
    changesStableUrl: false,
  };
}

function evidence(): MaterialEvidence[] {
  return [
    {
      id: "diagnostic:mixed-purpose",
      kind: "structural-diagnostic",
      digest: "a".repeat(64),
    },
    {
      id: "navigation:configure",
      kind: "navigation-regression",
      digest: "b".repeat(64),
    },
  ];
}

function input(overrides: Partial<HealingPolicyInput> = {}): HealingPolicyInput {
  return {
    proposal: proposal(),
    pressure: 0.8,
    expectedBenefit: 0.8,
    wordGrowth: 0,
    materialEvidence: evidence(),
    observedAt: NOW,
    ...overrides,
  };
}
