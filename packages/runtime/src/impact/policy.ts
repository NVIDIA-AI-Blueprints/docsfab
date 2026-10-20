// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { canonicalDigest } from "../content-ir/canonical.js";
import { compareText } from "../shared/primitives.js";

export const HEALING_LEVELS = [
  "observe",
  "bounded-repair",
  "structural-proposal",
  "ontology-review",
] as const;
export type HealingLevel = (typeof HEALING_LEVELS)[number];

export const HEALING_APPROVALS = ["none", "maintainer", "product-owner"] as const;
export type HealingApproval = (typeof HEALING_APPROVALS)[number];

export const MATERIAL_EVIDENCE_KINDS = [
  "structural-diagnostic",
  "navigation-regression",
  "semantic-change",
  "ontology-change",
  "link-failure",
  "source-of-truth-change",
] as const;
export type MaterialEvidenceKind = (typeof MATERIAL_EVIDENCE_KINDS)[number];

export interface HealingThreshold {
  /** Pressure required to enter this level from a lower level. */
  trigger: number;
  /** Lower pressure at which an existing level is allowed to recover. */
  recovery: number;
}

export interface HealingPolicy {
  id: string;
  version: string;
  digest: string;
  /** Growth is observable evidence, but is never material evidence by itself. */
  wordGrowthSignal: number;
  minimumMaterialEvidence: number;
  cooldownMs: number;
  stableUrl: {
    pressurePenalty: number;
    minimumExpectedBenefit: number;
  };
  thresholds: Record<Exclude<HealingLevel, "observe">, HealingThreshold>;
  approvals: Record<HealingLevel, HealingApproval>;
  delivery: {
    mode: "reviewable-proposal-only";
    mayMerge: false;
    mayPublish: false;
  };
}

export interface MaterialEvidence {
  id: string;
  kind: MaterialEvidenceKind;
  /** Digest of the revision-bound evidence, not its raw contents. */
  digest: string;
}

export interface HealingProposal {
  action: string;
  requestedLevel: HealingLevel;
  targetNodeIds: readonly string[];
  outputPaths: readonly string[];
  changesStableUrl: boolean;
}

export interface HealingDecisionMemory {
  proposalFingerprint: string;
  materialEvidenceDigest: string;
  decision: "approved" | "rejected";
  decidedAt: string;
}

export interface HealingPolicyInput {
  proposal: HealingProposal;
  /** Normalized deterministic pressure in the inclusive range 0..1. */
  pressure: number;
  /** Normalized deterministic benefit in the inclusive range 0..1. */
  expectedBenefit: number;
  wordGrowth: number;
  materialEvidence: readonly MaterialEvidence[];
  previousLevel?: HealingLevel;
  observedAt: string;
  memory?: readonly HealingDecisionMemory[];
}

export type HealingSuppression =
  | "insufficient-material-evidence"
  | "stable-url-bias"
  | "below-threshold"
  | "rejected-repeat"
  | "cooldown";

export interface HealingPolicyDecision {
  policy: { id: string; version: string; digest: string };
  level: HealingLevel;
  requiredApproval: HealingApproval;
  proposalFingerprint: string;
  materialEvidenceDigest: string;
  wordGrowthSignal: boolean;
  effectivePressure: number;
  suppressedBy?: HealingSuppression;
  delivery: HealingPolicy["delivery"];
}

export type HealingPolicyErrorCode =
  | "invalid-policy"
  | "invalid-input"
  | "invalid-proposal"
  | "invalid-evidence"
  | "invalid-memory";

export class HealingPolicyError extends Error {
  public constructor(
    public readonly code: HealingPolicyErrorCode,
    path: string,
  ) {
    super(`Healing policy rejected ${path}: ${code}.`);
    this.name = "HealingPolicyError";
  }
}

const DEFAULT_HEALING_POLICY_VALUE = {
  id: "docsfab:healing-policy",
  version: "1",
  wordGrowthSignal: 400,
  minimumMaterialEvidence: 2,
  cooldownMs: 7 * 24 * 60 * 60 * 1_000,
  stableUrl: {
    pressurePenalty: 0.15,
    minimumExpectedBenefit: 0.7,
  },
  thresholds: {
    "bounded-repair": { trigger: 0.35, recovery: 0.2 },
    "structural-proposal": { trigger: 0.7, recovery: 0.5 },
    "ontology-review": { trigger: 0.9, recovery: 0.75 },
  },
  approvals: {
    observe: "none",
    "bounded-repair": "maintainer",
    "structural-proposal": "maintainer",
    "ontology-review": "product-owner",
  },
  delivery: {
    mode: "reviewable-proposal-only",
    mayMerge: false,
    mayPublish: false,
  },
} as const;

export const DEFAULT_HEALING_POLICY: HealingPolicy = Object.freeze({
  ...DEFAULT_HEALING_POLICY_VALUE,
  digest: canonicalDigest(DEFAULT_HEALING_POLICY_VALUE),
});

/**
 * A proposal identity intentionally excludes pressure and evidence so a
 * rejected structural idea remains recognizable as observations accumulate.
 */
export function healingProposalFingerprint(proposal: HealingProposal): string {
  validateProposal(proposal);
  return canonicalDigest({
    action: proposal.action,
    requestedLevel: proposal.requestedLevel,
    targetNodeIds: sortedUnique(proposal.targetNodeIds),
    outputPaths: sortedUnique(proposal.outputPaths),
    changesStableUrl: proposal.changesStableUrl,
  });
}

/** Digest of evidence identity only; raw evidence is never copied to memory. */
export function healingMaterialEvidenceDigest(evidence: readonly MaterialEvidence[]): string {
  validateEvidence(evidence);
  return canonicalDigest(
    [...evidence]
      .map((item) => ({ id: item.id, kind: item.kind, digest: item.digest }))
      .sort((left, right) =>
        compareText(
          `${left.kind}\u0000${left.id}\u0000${left.digest}`,
          `${right.kind}\u0000${right.id}\u0000${right.digest}`,
        ),
      ),
  );
}

export function createHealingDecisionMemory(
  proposal: HealingProposal,
  materialEvidence: readonly MaterialEvidence[],
  decision: HealingDecisionMemory["decision"],
  decidedAt: string,
): HealingDecisionMemory {
  if (decision !== "approved" && decision !== "rejected") {
    fail("invalid-memory", "$.decision");
  }
  requireTimestamp(decidedAt, "$.decidedAt", "invalid-memory");
  return {
    proposalFingerprint: healingProposalFingerprint(proposal),
    materialEvidenceDigest: healingMaterialEvidenceDigest(materialEvidence),
    decision,
    decidedAt,
  };
}

/**
 * Applies deterministic healing gates. The result can authorize recording or
 * a reviewable proposal only; merge and publication are never policy outputs.
 */
export function evaluateHealingPolicy(
  input: HealingPolicyInput,
  policy: HealingPolicy = DEFAULT_HEALING_POLICY,
): HealingPolicyDecision {
  validatePolicy(policy);
  validateInput(input);

  const proposalFingerprint = healingProposalFingerprint(input.proposal);
  const materialEvidenceDigest = healingMaterialEvidenceDigest(input.materialEvidence);
  const wordGrowthSignal = input.wordGrowth >= policy.wordGrowthSignal;
  const stableUrlPenalty = input.proposal.changesStableUrl ? policy.stableUrl.pressurePenalty : 0;
  const effectivePressure = roundPressure(Math.max(0, input.pressure - stableUrlPenalty));
  const base = {
    policy: { id: policy.id, version: policy.version, digest: policy.digest },
    proposalFingerprint,
    materialEvidenceDigest,
    wordGrowthSignal,
    effectivePressure,
    delivery: policy.delivery,
  };

  if (input.proposal.requestedLevel === "observe") {
    return { ...base, level: "observe", requiredApproval: policy.approvals.observe };
  }
  if (input.materialEvidence.length < policy.minimumMaterialEvidence) {
    return suppressed(base, policy, "insufficient-material-evidence");
  }
  if (
    input.proposal.changesStableUrl &&
    input.expectedBenefit < policy.stableUrl.minimumExpectedBenefit
  ) {
    return suppressed(base, policy, "stable-url-bias");
  }

  const level = selectLevel(
    input.proposal.requestedLevel,
    input.previousLevel ?? "observe",
    effectivePressure,
    policy,
  );
  if (level === "observe") return suppressed(base, policy, "below-threshold");

  const memory = input.memory ?? [];
  const unchangedRejection = memory.some(
    (entry) =>
      entry.decision === "rejected" &&
      entry.proposalFingerprint === proposalFingerprint &&
      entry.materialEvidenceDigest === materialEvidenceDigest,
  );
  if (unchangedRejection) return suppressed(base, policy, "rejected-repeat");

  const observedAt = Date.parse(input.observedAt);
  const coolingDown = memory.some(
    (entry) =>
      entry.proposalFingerprint === proposalFingerprint &&
      observedAt >= Date.parse(entry.decidedAt) &&
      observedAt - Date.parse(entry.decidedAt) < policy.cooldownMs,
  );
  if (coolingDown) return suppressed(base, policy, "cooldown");

  return {
    ...base,
    level,
    requiredApproval: policy.approvals[level],
  };
}

function selectLevel(
  requestedLevel: HealingLevel,
  previousLevel: HealingLevel,
  pressure: number,
  policy: HealingPolicy,
): HealingLevel {
  if (requestedLevel === "observe") return "observe";
  const threshold =
    levelIndex(previousLevel) >= levelIndex(requestedLevel)
      ? policy.thresholds[requestedLevel].recovery
      : policy.thresholds[requestedLevel].trigger;
  return pressure >= threshold ? requestedLevel : "observe";
}

function suppressed(
  base: Omit<HealingPolicyDecision, "level" | "requiredApproval">,
  policy: HealingPolicy,
  suppressedBy: HealingSuppression,
): HealingPolicyDecision {
  return {
    ...base,
    level: "observe",
    requiredApproval: policy.approvals.observe,
    suppressedBy,
  };
}

function validatePolicy(policy: HealingPolicy): void {
  if (
    !validToken(policy.id) ||
    !validToken(policy.version) ||
    !isDigest(policy.digest) ||
    !Number.isSafeInteger(policy.wordGrowthSignal) ||
    policy.wordGrowthSignal <= 0 ||
    !Number.isSafeInteger(policy.minimumMaterialEvidence) ||
    policy.minimumMaterialEvidence <= 0 ||
    !Number.isSafeInteger(policy.cooldownMs) ||
    policy.cooldownMs < 0 ||
    !unit(policy.stableUrl.pressurePenalty) ||
    !unit(policy.stableUrl.minimumExpectedBenefit) ||
    policy.delivery.mode !== "reviewable-proposal-only" ||
    policy.delivery.mayMerge !== false ||
    policy.delivery.mayPublish !== false
  ) {
    fail("invalid-policy", "$.policy");
  }
  for (const level of HEALING_LEVELS.slice(1) as Exclude<HealingLevel, "observe">[]) {
    const threshold = policy.thresholds[level];
    if (
      !threshold ||
      !unit(threshold.trigger) ||
      !unit(threshold.recovery) ||
      threshold.recovery >= threshold.trigger ||
      !HEALING_APPROVALS.includes(policy.approvals[level])
    ) {
      fail("invalid-policy", `$.policy.thresholds.${level}`);
    }
  }
  if (policy.approvals.observe !== "none") fail("invalid-policy", "$.policy.approvals.observe");
  const { digest: _digest, ...digestible } = policy;
  if (canonicalDigest(digestible) !== policy.digest) {
    fail("invalid-policy", "$.policy.digest");
  }
}

function validateInput(input: HealingPolicyInput): void {
  validateProposal(input.proposal);
  if (
    !unit(input.pressure) ||
    !unit(input.expectedBenefit) ||
    !Number.isSafeInteger(input.wordGrowth) ||
    input.wordGrowth < 0 ||
    (input.previousLevel !== undefined && !HEALING_LEVELS.includes(input.previousLevel))
  ) {
    fail("invalid-input", "$.input");
  }
  requireTimestamp(input.observedAt, "$.observedAt", "invalid-input");
  validateEvidence(input.materialEvidence);
  const memory = input.memory ?? [];
  for (const [index, entry] of memory.entries()) {
    if (
      !isDigest(entry.proposalFingerprint) ||
      !isDigest(entry.materialEvidenceDigest) ||
      (entry.decision !== "approved" && entry.decision !== "rejected")
    ) {
      fail("invalid-memory", `$.memory[${index}]`);
    }
    requireTimestamp(entry.decidedAt, `$.memory[${index}].decidedAt`, "invalid-memory");
  }
}

function validateProposal(proposal: HealingProposal): void {
  if (
    !validToken(proposal.action) ||
    !HEALING_LEVELS.includes(proposal.requestedLevel) ||
    typeof proposal.changesStableUrl !== "boolean" ||
    proposal.targetNodeIds.length === 0 ||
    proposal.outputPaths.length === 0 ||
    proposal.targetNodeIds.some((value) => !validToken(value)) ||
    proposal.outputPaths.some((value) => !safeRelativePath(value)) ||
    new Set(proposal.targetNodeIds).size !== proposal.targetNodeIds.length ||
    new Set(proposal.outputPaths).size !== proposal.outputPaths.length
  ) {
    fail("invalid-proposal", "$.proposal");
  }
}

function validateEvidence(evidence: readonly MaterialEvidence[]): void {
  const identities = new Set<string>();
  for (const [index, item] of evidence.entries()) {
    if (
      !validToken(item.id) ||
      !MATERIAL_EVIDENCE_KINDS.includes(item.kind) ||
      !isDigest(item.digest) ||
      identities.has(`${item.kind}:${item.id}`)
    ) {
      fail("invalid-evidence", `$.materialEvidence[${index}]`);
    }
    identities.add(`${item.kind}:${item.id}`);
  }
}

function levelIndex(level: HealingLevel): number {
  return HEALING_LEVELS.indexOf(level);
}

function sortedUnique(values: readonly string[]): string[] {
  return [...values].sort(compareText);
}

function roundPressure(value: number): number {
  return Number(value.toFixed(12));
}

function unit(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function validToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 240 &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function safeRelativePath(value: unknown): value is string {
  if (!validToken(value) || value.startsWith("/") || value.includes("\\")) return false;
  const segments = value.split("/");
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function requireTimestamp(
  value: string,
  path: string,
  code: "invalid-input" | "invalid-memory",
): void {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) fail(code, path);
}

function fail(code: HealingPolicyErrorCode, path: string): never {
  throw new HealingPolicyError(code, path);
}
