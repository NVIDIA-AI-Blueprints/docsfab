// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { canonicalDigest } from "../src/content-ir/index.js";

import {
  createDecisionRecord,
  createImpactAnalysis,
  validateHealingPlan,
  type DecisionRecord,
  type MoveEvidence,
} from "../src/impact/contracts.js";
import {
  constructHealingPlan,
  createDecisionApprovalGrant,
  HealingConstructionError,
  type ConstructHealingPlanInput,
  type DecisionApprovalGrant,
  type HealingMoveInput,
  type HealingRepairInput,
} from "../src/impact/healing.js";
import {
  DEFAULT_HEALING_POLICY,
  createHealingDecisionMemory,
  evaluateHealingPolicy,
  healingProposalFingerprint,
  type HealingPolicyDecision,
  type HealingPolicy,
  type HealingPolicyInput,
  type HealingProposal,
  type MaterialEvidence,
} from "../src/impact/policy.js";

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
const POLICY = {
  id: DEFAULT_HEALING_POLICY.id,
  version: DEFAULT_HEALING_POLICY.version,
  digest: DEFAULT_HEALING_POLICY.digest,
};
const OBSERVED_AT = "2026-08-20T12:00:00.000Z";
const policyInputsByFingerprint = new Map<string, HealingPolicyInput>();

type MutableHealingRepairInput = Omit<
  HealingRepairInput,
  "targetNodeIds" | "outputPaths" | "evidenceDigests"
> & {
  targetNodeIds: string[];
  outputPaths: string[];
  evidenceDigests: string[];
};

type MutableConstructHealingPlanInput = Omit<
  ConstructHealingPlanInput,
  "policyDecisions" | "decisionMemory" | "approvalGrants" | "repairs" | "moves"
> & {
  policyDecisions: HealingPolicyDecision[];
  decisionMemory: DecisionRecord[];
  approvalGrants: DecisionApprovalGrant[];
  repairs: MutableHealingRepairInput[];
  moves: HealingMoveInput[];
};

describe("deterministic healing-plan construction", () => {
  it("groups repairs by the exact ownership tuple and canonicalizes the complete plan", () => {
    const link = evaluated(proposal("link-repair", "bounded-repair", ["docs/guide.md"]), 0.4);
    const navigation = evaluated(
      proposal("navigation-repair", "bounded-repair", ["docs/guide.md"]),
      0.4,
    );
    const move = evaluated(
      proposal("move-proposal", "structural-proposal", ["docs/old.md", "docs/new.md"], true),
      0.9,
    );
    const memory = decisionRecord(link, "approved");
    const navigationApproval = decisionRecord(navigation, "approved");
    const moveApproval = decisionRecord(move, "approved");
    const input = planInput(
      [move, navigation, link],
      [
        repair(move, {
          id: "repair:move-guide",
          owner: "team:platform",
          source: "docs/old.md",
          section: "document:docs/old.md",
          affectedOutput: "docs/new.md",
          action: "move-proposal",
          outputPaths: ["docs/old.md", "docs/new.md"],
        }),
        repair(navigation, {
          id: "repair:navigation",
          action: "navigation-repair",
        }),
        repair(link, { id: "repair:link", action: "link-repair" }),
      ],
      [{ taskId: "repair:move-guide", evidence: moveEvidence() }],
      [memory, navigationApproval, moveApproval],
    );

    const first = constructHealingPlan(input);
    const reordered = clonePlanInput(input);
    reordered.policyDecisions.reverse();
    reordered.repairs.reverse();
    reordered.decisionMemory.reverse();
    reordered.moves[0]!.evidence.inboundLinks.reverse();
    reordered.moves[0]!.evidence.redirects.reverse();
    reordered.repairs.forEach((item) => {
      item.targetNodeIds.reverse();
      item.outputPaths.reverse();
      item.evidenceDigests.reverse();
    });

    expect(constructHealingPlan(reordered)).toEqual(first);
    const propertyReordered = clonePlanInput(input);
    propertyReordered.policyDecisions[0] = Object.fromEntries(
      Object.entries(propertyReordered.policyDecisions[0]!).reverse(),
    ) as unknown as HealingPolicyDecision;
    expect(constructHealingPlan(propertyReordered)).toEqual(first);
    expect(validateHealingPlan(first)).toEqual(first);
    expect(first.delivery).toBe("patch-only");
    expect(first.repository).toEqual(AFTER);
    expect(first.impactDigest).toBe(input.impact.digest);
    expect(first.policy).toEqual(DEFAULT_HEALING_POLICY);
    expect(first.decisions.map((decision) => decision.digest).sort()).toEqual(
      [memory.digest, navigationApproval.digest, moveApproval.digest].sort(),
    );
    expect(
      first.taskGroups.map((group) => [
        group.owner,
        group.source,
        group.section,
        group.affectedOutput,
      ]),
    ).toEqual([
      ["team:docs", "docs/guide.md", "section:docs/guide.md#links", "docs/guide.md"],
      ["team:platform", "docs/old.md", "document:docs/old.md", "docs/new.md"],
    ]);
    expect(first.taskGroups[0]!.tasks.map((task) => task.id)).toEqual([
      "repair:link",
      "repair:navigation",
    ]);
    expect(
      first.taskGroups[0]!.tasks.every(
        (task) =>
          task.level === "bounded-repair" &&
          task.requiredApproval === "maintainer" &&
          task.patch?.byteLength === 64,
      ),
    ).toBe(true);
    expect(first.moves[0]).toMatchObject({
      oldPath: "docs/old.md",
      newPath: "docs/new.md",
      redirects: expect.arrayContaining([{ from: "docs/old.md", to: "docs/new.md" }]),
      validation: { status: "passed" },
      rollback: {
        restorePath: "docs/old.md",
        removePaths: ["docs/new.md"],
      },
    });
    expect(first.digest).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("derives level and approval from the evaluated decision and rejects inconsistent actions", () => {
    const decision = evaluated(proposal("link-repair", "bounded-repair", ["docs/guide.md"]), 0.4);
    const valid = planInput(
      [decision],
      [repair(decision, { id: "repair:link", action: "link-repair" })],
      [],
      [decisionRecord(decision, "approved")],
    );
    const plan = constructHealingPlan(valid);
    expect(plan.taskGroups[0]!.tasks[0]).toMatchObject({
      level: "bounded-repair",
      requiredApproval: "maintainer",
      action: "link-repair",
    });

    const wrongAction = clonePlanInput(valid);
    wrongAction.repairs[0]!.action = "move-proposal";
    expect(() => constructHealingPlan(wrongAction)).toThrowError(HealingConstructionError);

    const missingPatch = clonePlanInput(valid);
    delete missingPatch.repairs[0]!.patch;
    expect(() => constructHealingPlan(missingPatch)).toThrowError(HealingConstructionError);

    const forgedApproval = clonePlanInput(valid);
    forgedApproval.policyDecisions[0]!.requiredApproval = "none";
    expect(() => constructHealingPlan(forgedApproval)).toThrowError(
      new HealingConstructionError("invalid-policy-decision", "$.policyDecisions[0]"),
    );
  });

  it("requires the rejected decision record that caused a repeated proposal suppression", () => {
    const proposalValue = proposal("structural-proposal", "structural-proposal", [
      "docs/guide.md",
      "docs/configure.md",
    ]);
    const original = policyInput(proposalValue, 0.8);
    const memory = createHealingDecisionMemory(
      original.proposal,
      original.materialEvidence,
      "rejected",
      "2026-08-03T12:00:00.000Z",
    );
    const suppressed = evaluateHealingPolicy({ ...original, memory: [memory] });
    policyInputsByFingerprint.set(suppressed.proposalFingerprint, {
      ...original,
      memory: [memory],
    });
    expect(suppressed).toMatchObject({ level: "observe", suppressedBy: "rejected-repeat" });
    const repairInput = repair(suppressed, {
      id: "observe:split-guide",
      action: "observe",
      outputPaths: ["docs/guide.md", "docs/configure.md"],
    });

    expect(() => constructHealingPlan(planInput([suppressed], [repairInput]))).toThrowError(
      new HealingConstructionError(
        "incomplete-decision-memory",
        `$.policyDecisions.${suppressed.proposalFingerprint}`,
      ),
    );

    const record = decisionRecord(suppressed, "rejected");
    const plan = constructHealingPlan(planInput([suppressed], [repairInput], [], [record]));
    expect(plan.decisions).toEqual([record]);
    expect(plan.taskGroups[0]!.tasks[0]).toMatchObject({
      level: "observe",
      requiredApproval: "none",
      action: "observe",
    });
    expect(plan.taskGroups[0]!.tasks[0]!.patch).toBeUndefined();
  });

  it("requires one complete move record for every move proposal", () => {
    const move = evaluated(
      proposal("move-proposal", "structural-proposal", ["docs/old.md", "docs/new.md"], true),
      0.9,
    );
    const moveRepair = repair(move, {
      id: "repair:move-guide",
      action: "move-proposal",
      outputPaths: ["docs/old.md", "docs/new.md"],
    });
    const approval = decisionRecord(move, "approved");

    expect(() =>
      constructHealingPlan(planInput([move], [moveRepair], [], [approval])),
    ).toThrowError(new HealingConstructionError("invalid-move", "$.moves"));

    const incomplete = moveEvidence();
    incomplete.redirects = [];
    expect(() =>
      constructHealingPlan(
        planInput(
          [move],
          [moveRepair],
          [{ taskId: moveRepair.id, evidence: incomplete }],
          [approval],
        ),
      ),
    ).toThrowError(HealingConstructionError);

    const wrongOutputs = structuredClone(moveRepair);
    wrongOutputs.outputPaths = ["docs/new.md"];
    expect(() =>
      constructHealingPlan(
        planInput(
          [move],
          [wrongOutputs],
          [{ taskId: wrongOutputs.id, evidence: moveEvidence() }],
          [approval],
        ),
      ),
    ).toThrowError(new HealingConstructionError("invalid-repair", "$.repairs[0]"));

    expect(() =>
      constructHealingPlan(
        planInput([move], [moveRepair], [{ taskId: moveRepair.id, evidence: moveEvidence() }]),
      ),
    ).toThrowError(new HealingConstructionError("invalid-move", "$.moves[0]"));
  });

  it("requires authentic allowlist-backed grants for approved decisions", () => {
    const move = evaluated(
      proposal("move-proposal", "structural-proposal", ["docs/old.md", "docs/new.md"], true),
      0.9,
    );
    const moveRepair = repair(move, {
      id: "repair:move-guide",
      action: "move-proposal",
      outputPaths: ["docs/old.md", "docs/new.md"],
    });
    const approval = decisionRecord(move, "approved");
    const valid = planInput(
      [move],
      [moveRepair],
      [{ taskId: moveRepair.id, evidence: moveEvidence() }],
      [approval],
    );

    expect(constructHealingPlan(valid).moves).toHaveLength(1);

    const missing = { ...valid, approvalGrants: [] };
    expect(() => constructHealingPlan(missing)).toThrowError(
      new HealingConstructionError("invalid-approval-grant", "$.approvalGrants"),
    );

    const cloned = structuredClone(valid);
    expect(() => constructHealingPlan(cloned)).toThrowError(
      new HealingConstructionError("invalid-approval-grant", "$.approvalGrants[0]"),
    );

    const forged = {
      ...valid,
      approvalGrants: [{} as DecisionApprovalGrant],
    };
    expect(() => constructHealingPlan(forged)).toThrowError(
      new HealingConstructionError("invalid-approval-grant", "$.approvalGrants[0]"),
    );

    expect(() =>
      createDecisionApprovalGrant(approval, {
        maintainer: ["maintainer:someone-else"],
      }),
    ).toThrowError(new HealingConstructionError("invalid-approval-grant", "$.allowlists"));
    expect(() =>
      createDecisionApprovalGrant(decisionRecord(move, "rejected"), {
        maintainer: ["maintainer:docs"],
      }),
    ).toThrowError(
      new HealingConstructionError("invalid-approval-grant", "$.decision.disposition"),
    );
  });

  it("constructs tasks with a custom policy's exact approval mapping", () => {
    const custom = customPolicy();
    const proposalValue = proposal("link-repair", "bounded-repair", ["docs/guide.md"]);
    const evaluationInput = policyInput(proposalValue, 0.4);
    const decision = evaluateHealingPolicy(evaluationInput, custom);
    policyInputsByFingerprint.set(decision.proposalFingerprint, evaluationInput);
    const approval = decisionRecord(decision, "approved", "product-owner:docs");
    const plan = constructHealingPlan(
      planInput(
        [decision],
        [repair(decision, { id: "repair:custom", action: "link-repair" })],
        [],
        [approval],
        custom,
      ),
    );

    expect(plan.policy).toMatchObject({
      id: custom.id,
      version: custom.version,
      digest: custom.digest,
    });
    expect(plan.taskGroups[0]!.tasks[0]!.requiredApproval).toBe("product-owner");
  });
});

function impact(healingPolicy: HealingPolicy = DEFAULT_HEALING_POLICY) {
  return createImpactAnalysis({
    schemaVersion: 1,
    mode: "incremental",
    beforeRepository: BEFORE,
    afterRepository: AFTER,
    changedPaths: ["docs/guide.md", "docs/old.md", "docs/new.md"],
    changedRegions: ["body", "navigation", "graph", "semantic-context"],
    neighborhood: [
      {
        nodeId: "document:docs/guide.md",
        regions: ["body", "semantic-context"],
        reasons: ["direct-change"],
      },
      {
        nodeId: "document:docs/old.md",
        regions: ["navigation", "graph"],
        reasons: ["direct-change", "inbound-link"],
      },
    ],
    policy: {
      id: healingPolicy.id,
      version: healingPolicy.version,
      digest: healingPolicy.digest,
    },
  });
}

function evidence(): MaterialEvidence[] {
  return [
    {
      id: "diagnostic:structure",
      kind: "structural-diagnostic",
      digest: "1".repeat(64),
    },
    {
      id: "navigation:regression",
      kind: "navigation-regression",
      digest: "2".repeat(64),
    },
  ];
}

function proposal(
  action: string,
  requestedLevel: HealingProposal["requestedLevel"],
  outputPaths: string[],
  changesStableUrl = false,
): HealingProposal {
  return {
    action,
    requestedLevel,
    targetNodeIds: ["document:docs/guide.md", "section:docs/guide.md#links"],
    outputPaths,
    changesStableUrl,
  };
}

function policyInput(proposalValue: HealingProposal, pressure: number): HealingPolicyInput {
  return {
    proposal: proposalValue,
    pressure,
    expectedBenefit: 0.9,
    wordGrowth: 0,
    materialEvidence: evidence(),
    observedAt: OBSERVED_AT,
  };
}

function evaluated(proposalValue: HealingProposal, pressure: number): HealingPolicyDecision {
  const input = policyInput(proposalValue, pressure);
  const decision = evaluateHealingPolicy(input);
  policyInputsByFingerprint.set(decision.proposalFingerprint, input);
  return decision;
}

function repair(
  decision: HealingPolicyDecision,
  overrides: Partial<HealingRepairInput>,
): HealingRepairInput {
  const bounded = decision.level === "bounded-repair";
  return {
    id: "repair:default",
    proposalFingerprint: decision.proposalFingerprint,
    owner: "team:docs",
    source: "docs/guide.md",
    section: "section:docs/guide.md#links",
    affectedOutput: "docs/guide.md",
    action: decision.level === "observe" ? "observe" : "link-repair",
    targetNodeIds: ["document:docs/guide.md", "section:docs/guide.md#links"],
    outputPaths: ["docs/guide.md"],
    evidenceDigests: [decision.materialEvidenceDigest, "3".repeat(64)],
    ...(bounded ? { patch: { sha256: "4".repeat(64), byteLength: 64 } } : {}),
    ...overrides,
  };
}

function decisionRecord(
  decision: HealingPolicyDecision,
  disposition: DecisionRecord["disposition"],
  decidedBy = "maintainer:docs",
): DecisionRecord {
  return createDecisionRecord({
    schemaVersion: 1,
    repository: AFTER,
    proposalFingerprint: decision.proposalFingerprint,
    disposition,
    decidedBy,
    decidedAt: "2026-08-03T12:00:00.000Z",
    evidenceDigest: "5".repeat(64),
    materialEvidenceDigest: decision.materialEvidenceDigest,
    cooldownUntil: "2026-08-10T12:00:00.000Z",
  });
}

function moveEvidence(): MoveEvidence {
  return {
    proposalFingerprint: healingProposalFingerprint(
      proposal("move-proposal", "structural-proposal", ["docs/old.md", "docs/new.md"], true),
    ),
    oldPath: "docs/old.md",
    newPath: "docs/new.md",
    inboundLinks: [
      { sourcePath: "docs/a.md", sourceNodeId: "document:docs/a.md" },
      { sourcePath: "docs/b.md", sourceNodeId: "document:docs/b.md" },
    ],
    redirects: [
      { from: "docs/old.md", to: "docs/new.md" },
      { from: "docs/legacy.md", to: "docs/new.md" },
    ],
    validation: {
      status: "passed",
      policyDigest: "6".repeat(64),
      reportDigest: "7".repeat(64),
    },
    rollback: {
      restorePath: "docs/old.md",
      removePaths: ["docs/new.md"],
      reversePatchSha256: "8".repeat(64),
    },
  };
}

function planInput(
  policyDecisions: HealingPolicyDecision[],
  repairs: HealingRepairInput[],
  moves: ConstructHealingPlanInput["moves"] = [],
  decisionMemory: DecisionRecord[] = [],
  healingPolicy: HealingPolicy = DEFAULT_HEALING_POLICY,
): ConstructHealingPlanInput {
  return {
    impact: impact(healingPolicy),
    policy: healingPolicy,
    policyInputs: policyDecisions.map((decision) => {
      const input = policyInputsByFingerprint.get(decision.proposalFingerprint);
      if (!input) throw new Error("Missing policy input fixture.");
      return input;
    }),
    policyDecisions,
    decisionMemory,
    approvalGrants: decisionMemory
      .filter((decision) => decision.disposition === "approved")
      .map((decision) =>
        createDecisionApprovalGrant(decision, {
          maintainer: ["maintainer:docs"],
          "product-owner": ["product-owner:docs"],
        }),
      ),
    repairs,
    moves,
  };
}

function clonePlanInput(input: ConstructHealingPlanInput): MutableConstructHealingPlanInput {
  return {
    ...structuredClone(input),
    policyDecisions: input.policyDecisions.map((decision) => structuredClone(decision)),
    decisionMemory: input.decisionMemory.map((decision) => structuredClone(decision)),
    approvalGrants: [...input.approvalGrants],
    repairs: input.repairs.map((repair) => ({
      ...structuredClone(repair),
      targetNodeIds: [...repair.targetNodeIds],
      outputPaths: [...repair.outputPaths],
      evidenceDigests: [...repair.evidenceDigests],
    })),
    moves: input.moves.map((move) => structuredClone(move)),
  };
}

function customPolicy(): HealingPolicy {
  const { digest: _digest, ...base } = DEFAULT_HEALING_POLICY;
  const value = {
    ...structuredClone(base),
    version: "custom-approval-1",
    approvals: {
      ...base.approvals,
      "bounded-repair": "product-owner" as const,
    },
  };
  return { ...value, digest: canonicalDigest(value) };
}
