// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  APPROVAL_REQUIREMENTS,
  HEALING_LEVELS,
  REPAIR_ACTIONS,
  createHealingPlan,
  validateDecisionRecord,
  validateImpactAnalysis,
  type DecisionRecord,
  type HealingPlan,
  type ImpactAnalysis,
  type MoveEvidence,
  type PatchEvidence,
  type RepairAction,
  type RepairTask,
  type RepairTaskGroup,
} from "./contracts.js";
import { canonicalDigest } from "../content-ir/index.js";
import {
  evaluateHealingPolicy,
  type HealingPolicy,
  type HealingPolicyInput,
  type HealingPolicyDecision,
  type HealingSuppression,
} from "./policy.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const SUPPRESSIONS: readonly HealingSuppression[] = [
  "insufficient-material-evidence",
  "stable-url-bias",
  "below-threshold",
  "rejected-repeat",
  "cooldown",
];

export interface HealingRepairInput {
  id: string;
  proposalFingerprint: string;
  owner: string;
  source: string;
  section: string;
  affectedOutput: string;
  action: RepairAction;
  targetNodeIds: readonly string[];
  outputPaths: readonly string[];
  evidenceDigests: readonly string[];
  patch?: PatchEvidence;
}

export interface HealingMoveInput {
  taskId: string;
  evidence: MoveEvidence;
}

declare const decisionApprovalGrantBrand: unique symbol;

/**
 * An in-process authorization capability. Its authenticity is held outside the
 * object in a WeakMap, so serialization, cloning, or structural fabrication
 * cannot create a usable grant.
 */
export interface DecisionApprovalGrant {
  readonly [decisionApprovalGrantBrand]: true;
}

export interface DecisionApproverAllowlists {
  maintainer?: readonly string[];
  "product-owner"?: readonly string[];
}

interface DecisionApprovalGrantBinding {
  readonly decisionDigest: string;
  readonly approvalRequirements: ReadonlySet<"maintainer" | "product-owner">;
}

const decisionApprovalGrants = new WeakMap<DecisionApprovalGrant, DecisionApprovalGrantBinding>();

/**
 * Issues an opaque grant only when the recorded approver intersects at least
 * one caller-provided approval allowlist. Rejected decisions cannot be
 * granted. The resulting object is meaningful only in this process.
 */
export function createDecisionApprovalGrant(
  value: DecisionRecord,
  allowlists: DecisionApproverAllowlists,
): DecisionApprovalGrant {
  let decision: DecisionRecord;
  try {
    decision = validateDecisionRecord(value);
  } catch {
    fail("invalid-approval-grant", "$.decision");
  }
  if (decision.disposition !== "approved") {
    fail("invalid-approval-grant", "$.decision.disposition");
  }
  if (
    !allowlists ||
    typeof allowlists !== "object" ||
    Array.isArray(allowlists) ||
    Object.getPrototypeOf(allowlists) !== Object.prototype ||
    Object.keys(allowlists).some((key) => key !== "maintainer" && key !== "product-owner")
  ) {
    fail("invalid-approval-grant", "$.allowlists");
  }
  const approvalRequirements = new Set<"maintainer" | "product-owner">();
  for (const requirement of ["maintainer", "product-owner"] as const) {
    const approvers = allowlists[requirement] ?? [];
    if (
      !Array.isArray(approvers) ||
      approvers.some(
        (approver) =>
          typeof approver !== "string" || approver.length === 0 || approver.trim() !== approver,
      )
    ) {
      fail("invalid-approval-grant", `$.allowlists.${requirement}`);
    }
    if (approvers.includes(decision.decidedBy)) approvalRequirements.add(requirement);
  }
  if (approvalRequirements.size === 0) {
    fail("invalid-approval-grant", "$.allowlists");
  }
  const grant = Object.freeze({}) as DecisionApprovalGrant;
  decisionApprovalGrants.set(grant, {
    decisionDigest: decision.digest,
    approvalRequirements,
  });
  return grant;
}

export interface ConstructHealingPlanInput {
  impact: ImpactAnalysis;
  policy: HealingPolicy;
  policyInputs: readonly HealingPolicyInput[];
  policyDecisions: readonly HealingPolicyDecision[];
  decisionMemory: readonly DecisionRecord[];
  approvalGrants: readonly DecisionApprovalGrant[];
  repairs: readonly HealingRepairInput[];
  moves: readonly HealingMoveInput[];
}

export type HealingConstructionErrorCode =
  | "invalid-impact"
  | "invalid-policy-decision"
  | "invalid-decision-memory"
  | "invalid-approval-grant"
  | "invalid-repair"
  | "invalid-move"
  | "incomplete-decision-memory";

export class HealingConstructionError extends Error {
  public constructor(
    public readonly code: HealingConstructionErrorCode,
    public readonly path: string,
  ) {
    super(`Healing plan construction rejected ${path}: ${code}.`);
    this.name = "HealingConstructionError";
  }
}

/**
 * Converts evaluated policy decisions into one content-addressed, patch-only
 * healing plan. This function is pure: it groups metadata and never applies a
 * repair, move, patch, merge, or publication operation.
 */
export function constructHealingPlan(input: ConstructHealingPlanInput): HealingPlan {
  assertPlainObject(
    input,
    [
      "impact",
      "policy",
      "policyInputs",
      "policyDecisions",
      "decisionMemory",
      "approvalGrants",
      "repairs",
      "moves",
    ],
    "$",
    "invalid-repair",
  );

  let impact: ImpactAnalysis;
  try {
    impact = validateImpactAnalysis(input.impact);
  } catch {
    fail("invalid-impact", "$.impact");
  }

  const policyDecisions = parsePolicyDecisions(
    input.policyDecisions,
    input.policyInputs,
    input.policy,
    impact,
  );
  const decisions = parseDecisionMemory(input.decisionMemory, impact);
  assertDecisionMemory(policyDecisions, decisions);
  const grantedDecisionDigests = parseApprovalGrants(
    input.approvalGrants,
    decisions,
    policyDecisions,
  );
  const repairs = parseRepairs(input.repairs, policyDecisions);
  const moves = parseMoves(input.moves, repairs, decisions, grantedDecisionDigests);

  try {
    return createHealingPlan({
      schemaVersion: 1,
      repository: impact.afterRepository,
      impactDigest: impact.digest,
      policy: input.policy,
      approvalRequirements: input.policy.approvals,
      decisions,
      taskGroups: groupRepairs(repairs),
      moves,
      delivery: "patch-only",
    });
  } catch {
    fail("invalid-repair", "$.plan");
  }
}

interface ParsedRepair {
  readonly proposalFingerprint: string;
  readonly materialEvidenceDigest: string;
  readonly group: Omit<RepairTaskGroup, "tasks">;
  readonly task: RepairTask;
}

interface EvaluatedPolicy {
  decision: HealingPolicyDecision;
  input: HealingPolicyInput;
}

function parsePolicyDecisions(
  values: readonly HealingPolicyDecision[],
  inputs: readonly HealingPolicyInput[],
  policy: HealingPolicy,
  impact: ImpactAnalysis,
): Map<string, EvaluatedPolicy> {
  if (!Array.isArray(values) || !Array.isArray(inputs) || values.length !== inputs.length) {
    fail("invalid-policy-decision", "$.policyDecisions");
  }
  const evaluatedByFingerprint = new Map<string, EvaluatedPolicy>();
  for (const [index, policyInput] of inputs.entries()) {
    let evaluated: HealingPolicyDecision;
    try {
      evaluated = evaluateHealingPolicy(policyInput, policy);
    } catch {
      fail("invalid-policy-decision", `$.policyInputs[${index}]`);
    }
    if (
      evaluated.policy.id !== impact.policy.id ||
      evaluated.policy.version !== impact.policy.version ||
      evaluated.policy.digest !== impact.policy.digest ||
      evaluatedByFingerprint.has(evaluated.proposalFingerprint)
    ) {
      fail("invalid-policy-decision", `$.policyInputs[${index}]`);
    }
    evaluatedByFingerprint.set(evaluated.proposalFingerprint, {
      decision: evaluated,
      input: structuredClone(policyInput),
    });
  }
  const result = new Map<string, EvaluatedPolicy>();
  for (const [index, value] of values.entries()) {
    const path = `$.policyDecisions[${index}]`;
    assertPlainObject(
      value,
      [
        "policy",
        "level",
        "requiredApproval",
        "proposalFingerprint",
        "materialEvidenceDigest",
        "wordGrowthSignal",
        "effectivePressure",
        "suppressedBy",
        "delivery",
      ],
      path,
      "invalid-policy-decision",
      ["suppressedBy"],
    );
    assertPlainObject(
      value.policy,
      ["id", "version", "digest"],
      `${path}.policy`,
      "invalid-policy-decision",
    );
    assertPlainObject(
      value.delivery,
      ["mode", "mayMerge", "mayPublish"],
      `${path}.delivery`,
      "invalid-policy-decision",
    );
    if (
      value.policy.id !== impact.policy.id ||
      value.policy.version !== impact.policy.version ||
      value.policy.digest !== impact.policy.digest ||
      !HEALING_LEVELS.includes(value.level) ||
      !APPROVAL_REQUIREMENTS.includes(value.requiredApproval) ||
      !digest(value.proposalFingerprint) ||
      !digest(value.materialEvidenceDigest) ||
      typeof value.wordGrowthSignal !== "boolean" ||
      !unit(value.effectivePressure) ||
      (value.suppressedBy !== undefined && !SUPPRESSIONS.includes(value.suppressedBy)) ||
      value.delivery.mode !== "reviewable-proposal-only" ||
      value.delivery.mayMerge !== false ||
      value.delivery.mayPublish !== false ||
      (value.level === "observe") !== (value.requiredApproval === "none") ||
      (value.suppressedBy !== undefined && value.level !== "observe")
    ) {
      fail("invalid-policy-decision", path);
    }
    const evaluated = evaluatedByFingerprint.get(value.proposalFingerprint);
    if (
      !evaluated ||
      canonicalDigest(value) !== canonicalDigest(evaluated.decision) ||
      result.has(value.proposalFingerprint)
    ) {
      fail("invalid-policy-decision", `${path}.proposalFingerprint`);
    }
    result.set(value.proposalFingerprint, evaluated);
  }
  if (result.size !== evaluatedByFingerprint.size) {
    fail("invalid-policy-decision", "$.policyInputs");
  }
  return result;
}

function parseDecisionMemory(
  values: readonly DecisionRecord[],
  impact: ImpactAnalysis,
): DecisionRecord[] {
  if (!Array.isArray(values)) fail("invalid-decision-memory", "$.decisionMemory");
  const fingerprints = new Set<string>();
  return values.map((value, index) => {
    try {
      const decision = validateDecisionRecord(value);
      if (
        !sameRepository(decision.repository, impact.afterRepository) ||
        fingerprints.has(decision.proposalFingerprint)
      ) {
        throw new Error("identity");
      }
      fingerprints.add(decision.proposalFingerprint);
      return decision;
    } catch {
      fail("invalid-decision-memory", `$.decisionMemory[${index}]`);
    }
  });
}

function assertDecisionMemory(
  policyDecisions: ReadonlyMap<string, EvaluatedPolicy>,
  decisions: readonly DecisionRecord[],
): void {
  const known = new Set(policyDecisions.keys());
  for (const [index, decision] of decisions.entries()) {
    if (!known.has(decision.proposalFingerprint)) {
      fail("invalid-decision-memory", `$.decisionMemory[${index}].proposalFingerprint`);
    }
  }
  for (const [fingerprint, evaluated] of policyDecisions) {
    const decision = evaluated.decision;
    const matching = decisions.filter((entry) => entry.proposalFingerprint === fingerprint);
    if (
      decision.suppressedBy === "rejected-repeat" &&
      !matching.some(
        (entry) =>
          entry.disposition === "rejected" &&
          entry.materialEvidenceDigest === decision.materialEvidenceDigest,
      )
    ) {
      fail("incomplete-decision-memory", `$.policyDecisions.${fingerprint}`);
    }
    if (decision.suppressedBy === "cooldown" && matching.length === 0) {
      fail("incomplete-decision-memory", `$.policyDecisions.${fingerprint}`);
    }
    for (const memory of evaluated.input.memory ?? []) {
      if (
        !matching.some(
          (entry) =>
            entry.disposition === memory.decision &&
            entry.materialEvidenceDigest === memory.materialEvidenceDigest &&
            entry.decidedAt === memory.decidedAt,
        )
      ) {
        fail("incomplete-decision-memory", `$.policyInputs.${fingerprint}.memory`);
      }
    }
  }
}

function parseApprovalGrants(
  values: readonly DecisionApprovalGrant[],
  decisions: readonly DecisionRecord[],
  policyDecisions: ReadonlyMap<string, EvaluatedPolicy>,
): ReadonlySet<string> {
  if (!Array.isArray(values)) fail("invalid-approval-grant", "$.approvalGrants");
  const approved = new Map(
    decisions
      .filter((decision) => decision.disposition === "approved")
      .map((decision) => [decision.digest, decision]),
  );
  const granted = new Set<string>();
  for (const [index, value] of values.entries()) {
    const binding =
      value && typeof value === "object" ? decisionApprovalGrants.get(value) : undefined;
    const decision = binding ? approved.get(binding.decisionDigest) : undefined;
    const evaluated = decision
      ? policyDecisions.get(decision.proposalFingerprint)?.decision
      : undefined;
    const requiredApproval = evaluated?.requiredApproval;
    if (
      !binding ||
      !decision ||
      !evaluated ||
      evaluated.materialEvidenceDigest !== decision.materialEvidenceDigest ||
      (requiredApproval !== undefined &&
        requiredApproval !== "none" &&
        !binding.approvalRequirements.has(requiredApproval)) ||
      granted.has(binding.decisionDigest)
    ) {
      fail("invalid-approval-grant", `$.approvalGrants[${index}]`);
    }
    granted.add(binding.decisionDigest);
  }
  if (granted.size !== approved.size) {
    fail("invalid-approval-grant", "$.approvalGrants");
  }
  return granted;
}

function parseRepairs(
  values: readonly HealingRepairInput[],
  decisions: ReadonlyMap<string, EvaluatedPolicy>,
): ParsedRepair[] {
  if (!Array.isArray(values)) fail("invalid-repair", "$.repairs");
  const taskIds = new Set<string>();
  const usedDecisions = new Set<string>();
  const repairs = values.map((value, index): ParsedRepair => {
    const path = `$.repairs[${index}]`;
    assertPlainObject(
      value,
      [
        "id",
        "proposalFingerprint",
        "owner",
        "source",
        "section",
        "affectedOutput",
        "action",
        "targetNodeIds",
        "outputPaths",
        "evidenceDigests",
        "patch",
      ],
      path,
      "invalid-repair",
      ["patch"],
    );
    const evaluated = decisions.get(value.proposalFingerprint);
    const decision = evaluated?.decision;
    const proposal = evaluated?.input.proposal;
    if (
      !decision ||
      !proposal ||
      !REPAIR_ACTIONS.includes(value.action) ||
      (decision.level === "observe"
        ? value.action !== "observe"
        : proposal.action !== value.action) ||
      !Array.isArray(value.targetNodeIds) ||
      !Array.isArray(value.outputPaths) ||
      !Array.isArray(value.evidenceDigests) ||
      !sameSet(value.targetNodeIds, proposal.targetNodeIds) ||
      !sameSet(value.outputPaths, proposal.outputPaths) ||
      !value.evidenceDigests.includes(decision.materialEvidenceDigest) ||
      taskIds.has(value.id)
    ) {
      fail("invalid-repair", path);
    }
    taskIds.add(value.id);
    usedDecisions.add(value.proposalFingerprint);
    return {
      proposalFingerprint: value.proposalFingerprint,
      materialEvidenceDigest: decision.materialEvidenceDigest,
      group: {
        owner: value.owner,
        source: value.source,
        section: value.section,
        affectedOutput: value.affectedOutput,
      },
      task: {
        id: value.id,
        proposalFingerprint: value.proposalFingerprint,
        materialEvidenceDigest: decision.materialEvidenceDigest,
        level: decision.level,
        requiredApproval: decision.requiredApproval,
        action: value.action,
        targetNodeIds: [...value.targetNodeIds],
        outputPaths: [...value.outputPaths],
        evidenceDigests: [...value.evidenceDigests],
        ...(value.patch ? { patch: { ...value.patch } } : {}),
      },
    };
  });
  if (usedDecisions.size !== decisions.size) {
    fail("invalid-repair", "$.repairs.proposalFingerprint");
  }
  return repairs;
}

function parseMoves(
  values: readonly HealingMoveInput[],
  repairs: readonly ParsedRepair[],
  decisions: readonly DecisionRecord[],
  grantedDecisionDigests: ReadonlySet<string>,
): MoveEvidence[] {
  if (!Array.isArray(values)) fail("invalid-move", "$.moves");
  const moveTasks = new Map(
    repairs
      .filter((repair) => repair.task.action === "move-proposal")
      .map((repair) => [repair.task.id, repair]),
  );
  const seen = new Set<string>();
  const moves = values.map((value, index) => {
    const path = `$.moves[${index}]`;
    assertPlainObject(value, ["taskId", "evidence"], path, "invalid-move");
    const evidence = structuredClone(value.evidence);
    const repair = moveTasks.get(value.taskId);
    const approved =
      repair &&
      decisions.some(
        (decision) =>
          decision.proposalFingerprint === repair.proposalFingerprint &&
          decision.materialEvidenceDigest === repair.materialEvidenceDigest &&
          decision.disposition === "approved" &&
          grantedDecisionDigests.has(decision.digest),
      );
    if (
      !repair ||
      seen.has(value.taskId) ||
      evidence.proposalFingerprint !== repair.proposalFingerprint ||
      !approved ||
      !repair.task.outputPaths.includes(evidence.oldPath) ||
      !repair.task.outputPaths.includes(evidence.newPath)
    ) {
      fail("invalid-move", path);
    }
    seen.add(value.taskId);
    return evidence;
  });
  if (seen.size !== moveTasks.size) fail("invalid-move", "$.moves");
  return moves;
}

function groupRepairs(repairs: readonly ParsedRepair[]): RepairTaskGroup[] {
  const groups = new Map<string, RepairTaskGroup>();
  for (const repair of repairs) {
    const key = [
      repair.group.owner,
      repair.group.source,
      repair.group.section,
      repair.group.affectedOutput,
    ].join("\0");
    const group = groups.get(key) ?? { ...repair.group, tasks: [] };
    group.tasks.push(repair.task);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function assertPlainObject(
  value: unknown,
  allowed: readonly string[],
  path: string,
  code: HealingConstructionErrorCode,
  optional: readonly string[] = [],
): void {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    fail(code, path);
  const keys = Object.keys(value);
  if (
    keys.some((key) => !allowed.includes(key)) ||
    allowed.some((key) => !optional.includes(key) && !keys.includes(key))
  ) {
    fail(code, path);
  }
}

function sameRepository(
  left: DecisionRecord["repository"],
  right: ImpactAnalysis["afterRepository"],
): boolean {
  return (
    left.revision === right.revision &&
    left.contentDigest === right.contentDigest &&
    left.indexDigest === right.indexDigest
  );
}

function digest(value: unknown): value is string {
  return typeof value === "string" && SHA256.test(value);
}

function unit(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const expected = [...right].sort();
  return [...left].sort().every((value, index) => value === expected[index]);
}

function fail(code: HealingConstructionErrorCode, path: string): never {
  throw new HealingConstructionError(code, path);
}
