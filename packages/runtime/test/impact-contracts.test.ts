// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  DEFAULT_HEALING_POLICY,
  createDecisionRecord,
  createHealingPlan,
  createImpactAnalysis,
  validateDecisionRecord,
  validateHealingPlan,
  validateImpactAnalysis,
  type HealingPlan,
  type ImpactAnalysis,
} from "../src/impact/index.js";

const BEFORE = {
  revision: "a".repeat(40),
  contentDigest: "b".repeat(64),
  indexDigest: "c".repeat(64),
};
const AFTER = {
  revision: "d".repeat(40),
  contentDigest: "e".repeat(64),
  indexDigest: "f".repeat(64),
};
const POLICY = { id: "policy:impact", version: "1", digest: "1".repeat(64) };
const APPROVAL_REQUIREMENTS = DEFAULT_HEALING_POLICY.approvals;

describe("impact and healing contracts", () => {
  it("canonicalizes and content-addresses a revision-bound impact neighborhood", () => {
    const input = impactInput();
    const first = createImpactAnalysis(input);
    const reordered = structuredClone(input);
    reordered.changedPaths.reverse();
    reordered.changedRegions.reverse();
    reordered.neighborhood.reverse();
    reordered.neighborhood[0]!.regions = [...reordered.neighborhood[0]!.regions].reverse();
    reordered.neighborhood[0]!.reasons = [...reordered.neighborhood[0]!.reasons].reverse();

    expect(createImpactAnalysis(reordered)).toEqual(first);
    expect(validateImpactAnalysis(first)).toEqual(first);
    expect(first).toMatchObject({
      mode: "incremental",
      beforeRepository: BEFORE,
      afterRepository: AFTER,
      changedRegions: ["body", "semantic-context"],
    });
    expect(first.digest).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("accepts distinct disposable-workspace states on one Git revision", () => {
    const input = impactInput();
    input.afterRepository.revision = input.beforeRepository.revision;
    const analysis = createImpactAnalysis(input);

    expect(analysis.beforeRepository.revision).toBe(analysis.afterRepository.revision);
    expect(analysis.beforeRepository.indexDigest).not.toBe(analysis.afterRepository.indexDigest);

    const unchanged = impactInput();
    unchanged.afterRepository = { ...unchanged.beforeRepository };
    expect(() => createImpactAnalysis(unchanged)).toThrow("distinct before and after states");
  });

  it("content-addresses decision memory and binds it to the analyzed repository", () => {
    const decision = createDecisionRecord(decisionInput());
    expect(validateDecisionRecord(decision)).toEqual(decision);
    expect(decision).toMatchObject({
      repository: AFTER,
      disposition: "rejected",
      decidedBy: "maintainer:docs",
    });
  });

  it("canonicalizes grouped patch tasks and complete move rollback evidence", () => {
    const decision = createDecisionRecord(decisionInput());
    const impact = createImpactAnalysis(impactInput());
    const input = healingInput(impact.digest, decision);
    const first = createHealingPlan(input);
    const reordered = structuredClone(input);
    reordered.taskGroups.reverse();
    reordered.taskGroups[0]!.tasks[0]!.targetNodeIds.reverse();
    reordered.moves[0]!.inboundLinks.reverse();

    expect(createHealingPlan(reordered)).toEqual(first);
    expect(validateHealingPlan(first)).toEqual(first);
    expect(first.delivery).toBe("patch-only");
    expect(first.taskGroups[0]!.tasks[0]!.patch).toEqual({
      sha256: "7".repeat(64),
      byteLength: 321,
    });
    expect(first.moves[0]).toMatchObject({
      oldPath: "docs/old.md",
      newPath: "docs/new.md",
      redirects: [{ from: "docs/old.md", to: "docs/new.md" }],
      rollback: { restorePath: "docs/old.md", removePaths: ["docs/new.md"] },
    });
  });

  it("rejects unknown fields, unsafe paths, unsupported values, and digest drift", () => {
    const unknown = { ...impactInput(), surprise: true };
    expect(() => createImpactAnalysis(unknown)).toThrow("unknown field surprise");

    const unsafe = impactInput();
    unsafe.changedPaths = ["../escape.md"];
    expect(() => createImpactAnalysis(unsafe)).toThrow("safe repository-relative path");

    const unsupported = impactInput() as unknown as { mode: string };
    unsupported.mode = "partial";
    expect(() => createImpactAnalysis(unsupported)).toThrow("unsupported");

    const impact = createImpactAnalysis(impactInput());
    impact.digest = "9".repeat(64);
    expect(() => validateImpactAnalysis(impact)).toThrow("digest does not match");
  });

  it("rejects unsafe healing actions, forged decisions, and incomplete move evidence", () => {
    const impact = createImpactAnalysis(impactInput());
    const decision = createDecisionRecord(decisionInput());
    const directDelivery = healingInput(impact.digest, decision) as unknown as { delivery: string };
    directDelivery.delivery = "merge";
    expect(() => createHealingPlan(directDelivery)).toThrow("patch-only");

    const mismatchedAction = healingInput(impact.digest, decision);
    mismatchedAction.taskGroups[0]!.tasks[0]!.action = "move-proposal";
    expect(() => createHealingPlan(mismatchedAction)).toThrow("does not match");

    const forgedDecision = structuredClone(decision);
    forgedDecision.evidenceDigest = "8".repeat(64);
    expect(() => createHealingPlan(healingInput(impact.digest, forgedDecision))).toThrow(
      "decision record digest",
    );

    const incompleteMove = healingInput(impact.digest, decision);
    incompleteMove.moves[0]!.redirects = [];
    expect(() => createHealingPlan(incompleteMove)).toThrow("old-to-new");
  });

  it("rejects task approvals that differ from the bound approval requirements", () => {
    const impact = createImpactAnalysis(impactInput());
    const decision = createDecisionRecord(decisionInput());
    const input = healingInput(impact.digest, decision);
    input.taskGroups[0]!.tasks[0]!.requiredApproval = "product-owner";

    expect(() => createHealingPlan(input)).toThrow("bound approval policy");
  });

  it("rejects a forged approval map even when every task matches it", () => {
    const impact = createImpactAnalysis(impactInput());
    const decision = createDecisionRecord(decisionInput());
    const input = healingInput(impact.digest, decision);
    input.approvalRequirements["structural-proposal"] = "none";
    input.approvalRequirements["ontology-review"] = "none";
    input.taskGroups[1]!.tasks[0]!.requiredApproval = "none";

    expect(() => createHealingPlan(input)).toThrow(
      "approvalRequirements do not match the bound policy",
    );
  });

  it("rejects a bounded repair without its matching approved decision", () => {
    const impact = createImpactAnalysis(impactInput());
    const decision = createDecisionRecord(decisionInput());
    const input = healingInput(impact.digest, decision);
    input.decisions = input.decisions.filter(
      (entry) => entry.proposalFingerprint !== "c".repeat(64),
    );

    expect(() => createHealingPlan(input)).toThrow(
      "bounded repair repair:broken-link lacks matching approved proposal evidence",
    );
  });

  it("rejects a move without its matching approved decision", () => {
    const impact = createImpactAnalysis(impactInput());
    const decision = createDecisionRecord(decisionInput());
    const input = healingInput(impact.digest, decision);
    input.decisions = input.decisions.filter(
      (entry) => entry.proposalFingerprint !== "b".repeat(64),
    );

    expect(() => createHealingPlan(input)).toThrow(
      "move lacks matching approved proposal evidence",
    );
  });
});

function impactInput(): Omit<ImpactAnalysis, "digest"> {
  return {
    schemaVersion: 1 as const,
    mode: "incremental" as const,
    beforeRepository: BEFORE,
    afterRepository: AFTER,
    changedPaths: ["docs/guide.md", "docs/index.md"],
    changedRegions: ["semantic-context", "body"] as Array<"semantic-context" | "body">,
    neighborhood: [
      {
        nodeId: "document:docs/index.md",
        regions: ["navigation"] as const,
        reasons: ["parent"] as const,
      },
      {
        nodeId: "document:docs/guide.md",
        regions: ["semantic-context", "body"] as const,
        reasons: ["ontology-entity", "direct-change"] as const,
      },
    ],
    policy: POLICY,
  };
}

function decisionInput() {
  return {
    schemaVersion: 1 as const,
    repository: AFTER,
    proposalFingerprint: "2".repeat(64),
    disposition: "rejected" as const,
    decidedBy: "maintainer:docs",
    decidedAt: "2026-08-03T12:00:00.000Z",
    evidenceDigest: "3".repeat(64),
    materialEvidenceDigest: "4".repeat(64),
    cooldownUntil: "2026-08-10T12:00:00.000Z",
  };
}

function healingInput(
  impactDigest: string,
  decision: ReturnType<typeof createDecisionRecord>,
): Omit<HealingPlan, "digest"> {
  const boundedDecision = createDecisionRecord({
    ...decisionInput(),
    proposalFingerprint: "c".repeat(64),
    materialEvidenceDigest: "6".repeat(64),
    disposition: "approved",
  });
  const moveDecision = createDecisionRecord({
    ...decisionInput(),
    proposalFingerprint: "b".repeat(64),
    disposition: "approved",
  });
  return {
    schemaVersion: 1 as const,
    repository: AFTER,
    impactDigest,
    policy: DEFAULT_HEALING_POLICY,
    approvalRequirements: { ...APPROVAL_REQUIREMENTS },
    decisions: [decision, boundedDecision, moveDecision],
    taskGroups: [
      {
        owner: "team:docs",
        source: "docs/guide.md",
        section: "section:docs/guide.md#links",
        affectedOutput: "docs/guide.md",
        tasks: [
          {
            id: "repair:broken-link",
            proposalFingerprint: "c".repeat(64),
            materialEvidenceDigest: "6".repeat(64),
            level: "bounded-repair" as const,
            requiredApproval: "maintainer" as const,
            action: "link-repair" as const,
            targetNodeIds: ["section:docs/guide.md#links", "document:docs/target.md"],
            outputPaths: ["docs/guide.md"],
            evidenceDigests: ["6".repeat(64)],
            patch: { sha256: "7".repeat(64), byteLength: 321 },
          },
        ],
      },
      {
        owner: "team:docs",
        source: "docs/old.md",
        section: "document:docs/old.md",
        affectedOutput: "docs/new.md",
        tasks: [
          {
            id: "repair:move",
            proposalFingerprint: moveDecision.proposalFingerprint,
            materialEvidenceDigest: moveDecision.materialEvidenceDigest,
            level: "structural-proposal" as const,
            requiredApproval: "maintainer" as const,
            action: "move-proposal" as const,
            targetNodeIds: ["document:docs/old.md"],
            outputPaths: ["docs/old.md", "docs/new.md"],
            evidenceDigests: [moveDecision.materialEvidenceDigest],
          },
        ],
      },
    ],
    moves: [
      {
        proposalFingerprint: moveDecision.proposalFingerprint,
        oldPath: "docs/old.md",
        newPath: "docs/new.md",
        inboundLinks: [
          { sourcePath: "docs/a.md", sourceNodeId: "document:docs/a.md" },
          { sourcePath: "docs/b.md", sourceNodeId: "document:docs/b.md" },
        ],
        redirects: [{ from: "docs/old.md", to: "docs/new.md" }],
        validation: {
          status: "passed" as const,
          policyDigest: "8".repeat(64),
          reportDigest: "9".repeat(64),
        },
        rollback: {
          restorePath: "docs/old.md",
          removePaths: ["docs/new.md"],
          reversePatchSha256: "a".repeat(64),
        },
      },
    ],
    delivery: "patch-only" as const,
  };
}
