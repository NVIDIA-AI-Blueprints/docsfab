// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { canonicalDigest } from "../content-ir/canonical.js";
import type { RepositoryTarget } from "../repository/contracts.js";
import type { WorkflowName } from "../workflow-contracts/contracts.js";
import { compareText } from "../shared/primitives.js";

export const IMPACT_ANALYSIS_MODES = ["incremental", "full"] as const;
export type ImpactAnalysisMode = (typeof IMPACT_ANALYSIS_MODES)[number];

export const IMPACT_CHANGE_REGIONS = [
  "body",
  "headings",
  "metadata",
  "navigation",
  "graph",
  "semantic-context",
] as const;
export type ImpactChangeRegion = (typeof IMPACT_CHANGE_REGIONS)[number];

export const IMPACT_REASONS = [
  "direct-change",
  "parent",
  "sibling",
  "inbound-link",
  "outbound-link",
  "ontology-entity",
  "canonical-home",
  "navigation-scenario",
  "sibling-pressure",
  "new-job",
  "new-concept",
  "new-content-type",
  "duplicate-knowledge",
  "word-growth-signal",
] as const;
export type ImpactReason = (typeof IMPACT_REASONS)[number];

export const HEALING_LEVELS = [
  "observe",
  "bounded-repair",
  "structural-proposal",
  "ontology-review",
] as const;
export type HealingLevel = (typeof HEALING_LEVELS)[number];

export const APPROVAL_REQUIREMENTS = ["none", "maintainer", "product-owner"] as const;
export type ApprovalRequirement = (typeof APPROVAL_REQUIREMENTS)[number];

export const REPAIR_ACTIONS = [
  "observe",
  "link-repair",
  "navigation-repair",
  "structural-proposal",
  "move-proposal",
  "ontology-review",
] as const;
export type RepairAction = (typeof REPAIR_ACTIONS)[number];

export interface ImpactRepositoryBinding {
  revision: string;
  contentDigest: string;
  indexDigest: string;
}

export interface ImpactPolicyBinding {
  id: string;
  version: string;
  digest: string;
}

export interface HealingPolicyContract extends ImpactPolicyBinding {
  wordGrowthSignal: number;
  minimumMaterialEvidence: number;
  cooldownMs: number;
  stableUrl: {
    pressurePenalty: number;
    minimumExpectedBenefit: number;
  };
  thresholds: Record<
    Exclude<HealingLevel, "observe">,
    {
      trigger: number;
      recovery: number;
    }
  >;
  approvals: Record<HealingLevel, ApprovalRequirement>;
  delivery: {
    mode: "reviewable-proposal-only";
    mayMerge: false;
    mayPublish: false;
  };
}

export interface ImpactNeighborhoodEntry {
  nodeId: string;
  regions: ImpactChangeRegion[];
  reasons: ImpactReason[];
}

export interface ImpactAnalysis {
  schemaVersion: 1;
  mode: ImpactAnalysisMode;
  beforeRepository: ImpactRepositoryBinding;
  afterRepository: ImpactRepositoryBinding;
  changedPaths: string[];
  changedRegions: ImpactChangeRegion[];
  neighborhood: ImpactNeighborhoodEntry[];
  policy: ImpactPolicyBinding;
  digest: string;
}

export interface DecisionRecord {
  schemaVersion: 1;
  repository: ImpactRepositoryBinding;
  proposalFingerprint: string;
  disposition: "approved" | "rejected";
  decidedBy: string;
  decidedAt: string;
  evidenceDigest: string;
  materialEvidenceDigest: string;
  cooldownUntil: string;
  digest: string;
}

export interface PatchEvidence {
  sha256: string;
  byteLength: number;
}

export interface RepairTask {
  id: string;
  proposalFingerprint: string;
  materialEvidenceDigest: string;
  level: HealingLevel;
  requiredApproval: ApprovalRequirement;
  action: RepairAction;
  targetNodeIds: string[];
  outputPaths: string[];
  evidenceDigests: string[];
  patch?: PatchEvidence;
}

export interface RepairTaskGroup {
  owner: string;
  source: string;
  section: string;
  affectedOutput: string;
  tasks: RepairTask[];
}

export interface MoveEvidence {
  proposalFingerprint: string;
  oldPath: string;
  newPath: string;
  inboundLinks: Array<{ sourcePath: string; sourceNodeId: string }>;
  redirects: Array<{ from: string; to: string }>;
  validation: {
    status: "pending" | "passed" | "failed";
    policyDigest: string;
    reportDigest: string;
  };
  rollback: {
    restorePath: string;
    removePaths: string[];
    reversePatchSha256: string;
  };
}

export interface HealingPlan {
  schemaVersion: 1;
  repository: ImpactRepositoryBinding;
  impactDigest: string;
  policy: HealingPolicyContract;
  approvalRequirements: Record<HealingLevel, ApprovalRequirement>;
  decisions: DecisionRecord[];
  taskGroups: RepairTaskGroup[];
  moves: MoveEvidence[];
  delivery: "patch-only";
  digest: string;
}

const SHA256 = /^[a-f0-9]{64}$/u;
const GIT_OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const ID = /^\S{1,256}$/u;

export function createImpactAnalysis(value: unknown): ImpactAnalysis {
  const parsed = parseImpact(value, false);
  return { ...parsed, digest: canonicalDigest(parsed) };
}

export function validateImpactAnalysis(value: unknown): ImpactAnalysis {
  const root = closed(value, [...IMPACT_FIELDS, "digest"], "impact analysis");
  const parsed = parseImpact(root, true);
  const digest = hash(root.digest, "impact analysis digest");
  if (canonicalDigest(parsed) !== digest)
    fail("impact analysis digest does not match its content.");
  return { ...parsed, digest };
}

export function createDecisionRecord(value: unknown): DecisionRecord {
  const parsed = parseDecision(value, false);
  return { ...parsed, digest: canonicalDigest(parsed) };
}

export function validateDecisionRecord(value: unknown): DecisionRecord {
  const root = closed(value, [...DECISION_FIELDS, "digest"], "decision record");
  const parsed = parseDecision(root, true);
  const digest = hash(root.digest, "decision record digest");
  if (canonicalDigest(parsed) !== digest)
    fail("decision record digest does not match its content.");
  return { ...parsed, digest };
}

export function createHealingPlan(value: unknown): HealingPlan {
  const parsed = parseHealing(value, false);
  return { ...parsed, digest: canonicalDigest(parsed) };
}

export function validateHealingPlan(value: unknown): HealingPlan {
  const root = closed(value, [...HEALING_FIELDS, "digest"], "healing plan");
  const parsed = parseHealing(root, true);
  const digest = hash(root.digest, "healing plan digest");
  if (canonicalDigest(parsed) !== digest) fail("healing plan digest does not match its content.");
  return { ...parsed, digest };
}

const IMPACT_FIELDS = [
  "schemaVersion",
  "mode",
  "beforeRepository",
  "afterRepository",
  "changedPaths",
  "changedRegions",
  "neighborhood",
  "policy",
] as const;

function parseImpact(value: unknown, allowDigest: boolean): Omit<ImpactAnalysis, "digest"> {
  const root = closed(
    value,
    allowDigest ? [...IMPACT_FIELDS, "digest"] : IMPACT_FIELDS,
    "impact analysis",
  );
  schema(root.schemaVersion, "impact analysis");
  const mode = enumeration(root.mode, IMPACT_ANALYSIS_MODES, "impact analysis mode");
  const beforeRepository = repository(root.beforeRepository, "impact analysis beforeRepository");
  const afterRepository = repository(root.afterRepository, "impact analysis afterRepository");
  if (mode === "incremental" && beforeRepository.indexDigest === afterRepository.indexDigest) {
    fail("impact analysis must bind distinct before and after states.");
  }
  const changedPaths = stringArray(root.changedPaths, safePath, "impact analysis changedPaths");
  const changedRegions = enumArray(
    root.changedRegions,
    IMPACT_CHANGE_REGIONS,
    "impact analysis changedRegions",
  );
  const entries = array(root.neighborhood, "impact analysis neighborhood")
    .map((entry, index) => {
      const item = closed(
        entry,
        ["nodeId", "regions", "reasons"],
        `impact analysis neighborhood[${index}]`,
      );
      return {
        nodeId: identifier(item.nodeId, `impact analysis neighborhood[${index}].nodeId`),
        regions: enumArray(
          item.regions,
          IMPACT_CHANGE_REGIONS,
          `impact analysis neighborhood[${index}].regions`,
        ),
        reasons: enumArray(
          item.reasons,
          IMPACT_REASONS,
          `impact analysis neighborhood[${index}].reasons`,
        ),
      };
    })
    .sort((left, right) => compareText(left.nodeId, right.nodeId));
  unique(
    entries.map((entry) => entry.nodeId),
    "impact analysis neighborhood node IDs",
  );
  return {
    schemaVersion: 1,
    mode,
    beforeRepository,
    afterRepository,
    changedPaths,
    changedRegions,
    neighborhood: entries,
    policy: policy(root.policy, "impact analysis policy"),
  };
}

const DECISION_FIELDS = [
  "schemaVersion",
  "repository",
  "proposalFingerprint",
  "disposition",
  "decidedBy",
  "decidedAt",
  "evidenceDigest",
  "materialEvidenceDigest",
  "cooldownUntil",
] as const;

function parseDecision(value: unknown, allowDigest: boolean): Omit<DecisionRecord, "digest"> {
  const root = closed(
    value,
    allowDigest ? [...DECISION_FIELDS, "digest"] : DECISION_FIELDS,
    "decision record",
  );
  schema(root.schemaVersion, "decision record");
  const decidedAt = timestamp(root.decidedAt, "decision record decidedAt");
  const cooldownUntil = timestamp(root.cooldownUntil, "decision record cooldownUntil");
  if (cooldownUntil < decidedAt) fail("decision record cooldownUntil must not precede decidedAt.");
  return {
    schemaVersion: 1,
    repository: repository(root.repository, "decision record repository"),
    proposalFingerprint: hash(root.proposalFingerprint, "decision record proposalFingerprint"),
    disposition: enumeration(
      root.disposition,
      ["approved", "rejected"] as const,
      "decision record disposition",
    ),
    decidedBy: identifier(root.decidedBy, "decision record decidedBy"),
    decidedAt,
    evidenceDigest: hash(root.evidenceDigest, "decision record evidenceDigest"),
    materialEvidenceDigest: hash(
      root.materialEvidenceDigest,
      "decision record materialEvidenceDigest",
    ),
    cooldownUntil,
  };
}

const HEALING_FIELDS = [
  "schemaVersion",
  "repository",
  "impactDigest",
  "policy",
  "approvalRequirements",
  "decisions",
  "taskGroups",
  "moves",
  "delivery",
] as const;

function parseHealing(value: unknown, allowDigest: boolean): Omit<HealingPlan, "digest"> {
  const root = closed(
    value,
    allowDigest ? [...HEALING_FIELDS, "digest"] : HEALING_FIELDS,
    "healing plan",
  );
  schema(root.schemaVersion, "healing plan");
  if (root.delivery !== "patch-only") fail("healing plan delivery must be patch-only.");
  const repositoryBinding = repository(root.repository, "healing plan repository");
  const approvalRequirements = approvalPolicy(
    root.approvalRequirements,
    "healing plan approvalRequirements",
  );
  const policyBinding = healingPolicy(root.policy, "healing plan policy");
  if (canonicalDigest(approvalRequirements) !== canonicalDigest(policyBinding.approvals)) {
    fail("healing plan approvalRequirements do not match the bound policy.");
  }
  const decisions = array(root.decisions, "healing plan decisions")
    .map((entry) => validateDecisionRecord(entry))
    .sort((left, right) => compareText(left.proposalFingerprint, right.proposalFingerprint));
  unique(
    decisions.map((entry) => entry.proposalFingerprint),
    "healing plan decision fingerprints",
  );
  for (const decision of decisions) {
    if (!sameRepository(decision.repository, repositoryBinding))
      fail("healing plan decision repository mismatch.");
  }
  const taskGroups = array(root.taskGroups, "healing plan taskGroups")
    .map(parseTaskGroup)
    .sort((left, right) => compareText(groupKey(left), groupKey(right)));
  unique(taskGroups.map(groupKey), "healing plan task groups");
  const tasks = taskGroups.flatMap((group) => group.tasks);
  for (const task of tasks) {
    if (task.requiredApproval !== approvalRequirements[task.level]) {
      fail(`healing plan task ${task.id} does not match the bound approval policy.`);
    }
    if (
      task.level === "bounded-repair" &&
      !decisions.some(
        (decision) =>
          decision.disposition === "approved" &&
          decision.proposalFingerprint === task.proposalFingerprint &&
          decision.materialEvidenceDigest === task.materialEvidenceDigest,
      )
    ) {
      fail(`healing plan bounded repair ${task.id} lacks matching approved proposal evidence.`);
    }
  }
  const moves = array(root.moves, "healing plan moves")
    .map(parseMove)
    .sort((left, right) => compareText(left.oldPath, right.oldPath));
  unique(
    moves.map((move) => move.oldPath),
    "healing plan move old paths",
  );
  for (const move of moves) {
    const task = tasks.find(
      (candidate) =>
        candidate.action === "move-proposal" &&
        candidate.proposalFingerprint === move.proposalFingerprint,
    );
    if (
      !task ||
      !task.outputPaths.includes(move.oldPath) ||
      !task.outputPaths.includes(move.newPath) ||
      !decisions.some(
        (decision) =>
          decision.disposition === "approved" &&
          decision.proposalFingerprint === task.proposalFingerprint &&
          decision.materialEvidenceDigest === task.materialEvidenceDigest,
      )
    ) {
      fail("healing plan move lacks matching approved proposal evidence.");
    }
  }
  return {
    schemaVersion: 1,
    repository: repositoryBinding,
    impactDigest: hash(root.impactDigest, "healing plan impactDigest"),
    policy: policyBinding,
    approvalRequirements,
    decisions,
    taskGroups,
    moves,
    delivery: "patch-only",
  };
}

function parseTaskGroup(value: unknown, index: number): RepairTaskGroup {
  const path = `healing plan taskGroups[${index}]`;
  const root = closed(value, ["owner", "source", "section", "affectedOutput", "tasks"], path);
  const tasks = array(root.tasks, `${path}.tasks`)
    .map((task, taskIndex) => {
      const taskPath = `${path}.tasks[${taskIndex}]`;
      const item = closed(
        task,
        [
          "id",
          "proposalFingerprint",
          "materialEvidenceDigest",
          "level",
          "requiredApproval",
          "action",
          "targetNodeIds",
          "outputPaths",
          "evidenceDigests",
          "patch",
        ],
        taskPath,
        ["patch"],
      );
      const level = enumeration(item.level, HEALING_LEVELS, `${taskPath}.level`);
      const action = enumeration(item.action, REPAIR_ACTIONS, `${taskPath}.action`);
      if (!actionMatchesLevel(action, level))
        fail(`${taskPath}.action does not match its healing level.`);
      const patch =
        item.patch === undefined ? undefined : parsePatch(item.patch, `${taskPath}.patch`);
      if ((level === "bounded-repair") !== Boolean(patch)) {
        fail(`${taskPath}.patch is required only for bounded repairs.`);
      }
      return {
        id: identifier(item.id, `${taskPath}.id`),
        proposalFingerprint: hash(item.proposalFingerprint, `${taskPath}.proposalFingerprint`),
        materialEvidenceDigest: hash(
          item.materialEvidenceDigest,
          `${taskPath}.materialEvidenceDigest`,
        ),
        level,
        requiredApproval: enumeration(
          item.requiredApproval,
          APPROVAL_REQUIREMENTS,
          `${taskPath}.requiredApproval`,
        ),
        action,
        targetNodeIds: stringArray(item.targetNodeIds, identifier, `${taskPath}.targetNodeIds`),
        outputPaths: stringArray(item.outputPaths, safePath, `${taskPath}.outputPaths`),
        evidenceDigests: stringArray(item.evidenceDigests, hash, `${taskPath}.evidenceDigests`),
        ...(patch ? { patch } : {}),
      };
    })
    .sort((left, right) => compareText(left.id, right.id));
  if (tasks.length === 0) fail(`${path}.tasks must be non-empty.`);
  unique(
    tasks.map((task) => task.id),
    `${path}.task IDs`,
  );
  return {
    owner: identifier(root.owner, `${path}.owner`),
    source: safePath(root.source, `${path}.source`),
    section: identifier(root.section, `${path}.section`),
    affectedOutput: safePath(root.affectedOutput, `${path}.affectedOutput`),
    tasks,
  };
}

function parseMove(value: unknown, index: number): MoveEvidence {
  const path = `healing plan moves[${index}]`;
  const root = closed(
    value,
    [
      "proposalFingerprint",
      "oldPath",
      "newPath",
      "inboundLinks",
      "redirects",
      "validation",
      "rollback",
    ],
    path,
  );
  const proposalFingerprint = hash(root.proposalFingerprint, `${path}.proposalFingerprint`);
  const oldPath = safePath(root.oldPath, `${path}.oldPath`);
  const newPath = safePath(root.newPath, `${path}.newPath`);
  if (oldPath === newPath) fail(`${path} must change paths.`);
  const inboundLinks = array(root.inboundLinks, `${path}.inboundLinks`)
    .map((entry, linkIndex) => {
      const item = closed(
        entry,
        ["sourcePath", "sourceNodeId"],
        `${path}.inboundLinks[${linkIndex}]`,
      );
      return {
        sourcePath: safePath(item.sourcePath, `${path}.inboundLinks[${linkIndex}].sourcePath`),
        sourceNodeId: identifier(
          item.sourceNodeId,
          `${path}.inboundLinks[${linkIndex}].sourceNodeId`,
        ),
      };
    })
    .sort((left, right) =>
      compareText(
        `${left.sourcePath}\0${left.sourceNodeId}`,
        `${right.sourcePath}\0${right.sourceNodeId}`,
      ),
    );
  unique(
    inboundLinks.map((entry) => `${entry.sourcePath}\0${entry.sourceNodeId}`),
    `${path}.inboundLinks`,
  );
  const redirects = array(root.redirects, `${path}.redirects`)
    .map((entry, redirectIndex) => {
      const item = closed(entry, ["from", "to"], `${path}.redirects[${redirectIndex}]`);
      return {
        from: safePath(item.from, `${path}.redirects[${redirectIndex}].from`),
        to: safePath(item.to, `${path}.redirects[${redirectIndex}].to`),
      };
    })
    .sort((left, right) => compareText(`${left.from}\0${left.to}`, `${right.from}\0${right.to}`));
  if (!redirects.some((entry) => entry.from === oldPath && entry.to === newPath)) {
    fail(`${path}.redirects must include the old-to-new path.`);
  }
  const validationRoot = closed(
    root.validation,
    ["status", "policyDigest", "reportDigest"],
    `${path}.validation`,
  );
  const rollbackRoot = closed(
    root.rollback,
    ["restorePath", "removePaths", "reversePatchSha256"],
    `${path}.rollback`,
  );
  const restorePath = safePath(rollbackRoot.restorePath, `${path}.rollback.restorePath`);
  const removePaths = stringArray(
    rollbackRoot.removePaths,
    safePath,
    `${path}.rollback.removePaths`,
  );
  if (restorePath !== oldPath || !removePaths.includes(newPath))
    fail(`${path}.rollback does not reverse the move.`);
  return {
    proposalFingerprint,
    oldPath,
    newPath,
    inboundLinks,
    redirects,
    validation: {
      status: enumeration(
        validationRoot.status,
        ["pending", "passed", "failed"] as const,
        `${path}.validation.status`,
      ),
      policyDigest: hash(validationRoot.policyDigest, `${path}.validation.policyDigest`),
      reportDigest: hash(validationRoot.reportDigest, `${path}.validation.reportDigest`),
    },
    rollback: {
      restorePath,
      removePaths,
      reversePatchSha256: hash(
        rollbackRoot.reversePatchSha256,
        `${path}.rollback.reversePatchSha256`,
      ),
    },
  };
}

function parsePatch(value: unknown, path: string): PatchEvidence {
  const root = closed(value, ["sha256", "byteLength"], path);
  return {
    sha256: hash(root.sha256, `${path}.sha256`),
    byteLength: nonnegativeInteger(root.byteLength, `${path}.byteLength`),
  };
}

function repository(value: unknown, path: string): ImpactRepositoryBinding {
  const root = closed(value, ["revision", "contentDigest", "indexDigest"], path);
  const revision = text(root.revision, `${path}.revision`);
  if (!GIT_OBJECT_ID.test(revision))
    fail(`${path}.revision must be a full lowercase Git object ID.`);
  return {
    revision,
    contentDigest: hash(root.contentDigest, `${path}.contentDigest`),
    indexDigest: hash(root.indexDigest, `${path}.indexDigest`),
  };
}

function policy(value: unknown, path: string): ImpactPolicyBinding {
  const root = closed(value, ["id", "version", "digest"], path);
  return {
    id: identifier(root.id, `${path}.id`),
    version: text(root.version, `${path}.version`),
    digest: hash(root.digest, `${path}.digest`),
  };
}

function healingPolicy(value: unknown, path: string): HealingPolicyContract {
  const root = closed(
    value,
    [
      "id",
      "version",
      "digest",
      "wordGrowthSignal",
      "minimumMaterialEvidence",
      "cooldownMs",
      "stableUrl",
      "thresholds",
      "approvals",
      "delivery",
    ],
    path,
  );
  const stableUrl = closed(
    root.stableUrl,
    ["pressurePenalty", "minimumExpectedBenefit"],
    `${path}.stableUrl`,
  );
  const thresholds = closed(
    root.thresholds,
    ["bounded-repair", "structural-proposal", "ontology-review"],
    `${path}.thresholds`,
  );
  const parsedThresholds = Object.fromEntries(
    (["bounded-repair", "structural-proposal", "ontology-review"] as const).map((level) => {
      const threshold = closed(
        thresholds[level],
        ["trigger", "recovery"],
        `${path}.thresholds.${level}`,
      );
      const trigger = unitNumber(threshold.trigger, `${path}.thresholds.${level}.trigger`);
      const recovery = unitNumber(threshold.recovery, `${path}.thresholds.${level}.recovery`);
      if (recovery >= trigger) fail(`${path}.thresholds.${level}.recovery must be below trigger.`);
      return [level, { trigger, recovery }];
    }),
  ) as HealingPolicyContract["thresholds"];
  const approvals = approvalPolicy(root.approvals, `${path}.approvals`);
  if (approvals.observe !== "none") fail(`${path}.approvals.observe must be none.`);
  const delivery = closed(root.delivery, ["mode", "mayMerge", "mayPublish"], `${path}.delivery`);
  if (
    delivery.mode !== "reviewable-proposal-only" ||
    delivery.mayMerge !== false ||
    delivery.mayPublish !== false
  ) {
    fail(`${path}.delivery must be reviewable-proposal-only.`);
  }
  const parsed = {
    id: identifier(root.id, `${path}.id`),
    version: text(root.version, `${path}.version`),
    wordGrowthSignal: positiveInteger(root.wordGrowthSignal, `${path}.wordGrowthSignal`),
    minimumMaterialEvidence: positiveInteger(
      root.minimumMaterialEvidence,
      `${path}.minimumMaterialEvidence`,
    ),
    cooldownMs: nonnegativeInteger(root.cooldownMs, `${path}.cooldownMs`),
    stableUrl: {
      pressurePenalty: unitNumber(stableUrl.pressurePenalty, `${path}.stableUrl.pressurePenalty`),
      minimumExpectedBenefit: unitNumber(
        stableUrl.minimumExpectedBenefit,
        `${path}.stableUrl.minimumExpectedBenefit`,
      ),
    },
    thresholds: parsedThresholds,
    approvals,
    delivery: {
      mode: "reviewable-proposal-only" as const,
      mayMerge: false as const,
      mayPublish: false as const,
    },
  };
  const digest = hash(root.digest, `${path}.digest`);
  if (canonicalDigest(parsed) !== digest) fail(`${path}.digest does not match its content.`);
  return { ...parsed, digest };
}

function actionMatchesLevel(action: RepairAction, level: HealingLevel): boolean {
  return (
    (level === "observe" && action === "observe") ||
    (level === "bounded-repair" && (action === "link-repair" || action === "navigation-repair")) ||
    (level === "structural-proposal" &&
      (action === "structural-proposal" || action === "move-proposal")) ||
    (level === "ontology-review" && action === "ontology-review")
  );
}

function approvalPolicy(value: unknown, path: string): Record<HealingLevel, ApprovalRequirement> {
  const root = closed(value, HEALING_LEVELS, path);
  return Object.fromEntries(
    HEALING_LEVELS.map((level) => [
      level,
      enumeration(root[level], APPROVAL_REQUIREMENTS, `${path}.${level}`),
    ]),
  ) as Record<HealingLevel, ApprovalRequirement>;
}

function sameRepository(left: ImpactRepositoryBinding, right: ImpactRepositoryBinding): boolean {
  return (
    left.revision === right.revision &&
    left.contentDigest === right.contentDigest &&
    left.indexDigest === right.indexDigest
  );
}

function groupKey(group: RepairTaskGroup): string {
  return `${group.owner}\0${group.source}\0${group.section}\0${group.affectedOutput}`;
}

function stringArray<T extends string>(
  value: unknown,
  parser: (value: unknown, path: string) => T,
  path: string,
): T[] {
  const values = array(value, path)
    .map((entry, index) => parser(entry, `${path}[${index}]`))
    .sort(compareText);
  unique(values, path);
  return values;
}

function enumArray<T extends string>(value: unknown, allowed: readonly T[], path: string): T[] {
  const values = array(value, path).map((entry, index) =>
    enumeration(entry, allowed, `${path}[${index}]`),
  );
  unique(values, path);
  return allowed.filter((entry) => values.includes(entry));
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(`${path} must be an array.`);
  return value;
}

function closed(
  value: unknown,
  allowed: readonly string[],
  path: string,
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    fail(`${path} must be a plain object.`);
  const root = value as Record<string, unknown>;
  for (const key of Object.keys(root))
    if (!allowed.includes(key)) fail(`${path} contains unknown field ${key}.`);
  for (const key of allowed)
    if (!optional.includes(key) && !(key in root)) fail(`${path} is missing ${key}.`);
  return root;
}

function safePath(value: unknown, path: string): string {
  const result = text(value, path);
  if (
    result.startsWith("/") ||
    result.startsWith("~") ||
    /^[A-Za-z]:\//u.test(result) ||
    result.includes("\\") ||
    result.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    fail(`${path} must be a safe repository-relative path.`);
  }
  return result;
}

function identifier(value: unknown, path: string): string {
  const result = text(value, path);
  if (!ID.test(result)) fail(`${path} must be a stable identifier.`);
  return result;
}

function hash(value: unknown, path: string): string {
  const result = text(value, path);
  if (!SHA256.test(result)) fail(`${path} must be a lowercase SHA-256.`);
  return result;
}

function timestamp(value: unknown, path: string): string {
  const result = text(value, path);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(result) ||
    new Date(result).toISOString() !== result
  )
    fail(`${path} must be a canonical UTC timestamp.`);
  return result;
}

function text(value: unknown, path: string): string {
  if (
    typeof value !== "string" ||
    !value ||
    value !== value.normalize("NFC") ||
    /\p{Cc}/u.test(value)
  )
    fail(`${path} must be normalized non-empty text without controls.`);
  return value;
}

function enumeration<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) fail(`${path} is unsupported.`);
  return value as T;
}

function nonnegativeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    fail(`${path} must be a non-negative integer.`);
  return value as number;
}

function positiveInteger(value: unknown, path: string): number {
  const result = nonnegativeInteger(value, path);
  if (result === 0) fail(`${path} must be positive.`);
  return result;
}

function unitNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    fail(`${path} must be between zero and one.`);
  }
  return value;
}

function schema(value: unknown, path: string): void {
  if (value !== 1) fail(`${path} schemaVersion must be 1.`);
}

function unique(values: readonly string[], path: string): void {
  if (new Set(values).size !== values.length) fail(`${path} contains duplicates.`);
}

function fail(message: string): never {
  throw new Error(message);
}

export type ChangedFileStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "untracked"
  | "unknown";
export interface ChangedFileEvidence {
  path: string;
  status: ChangedFileStatus;
  previousPath?: string;
}
export interface PatchMetadata {
  sha256: string;
  byteLength: number;
  lineCount: number;
  artifactPath: string;
  format: "git-diff";
}
export interface ChangeEvidence {
  files: ChangedFileEvidence[];
  patch?: PatchMetadata;
}
export interface ImpactPostflightContext {
  runId: string;
  workflow: WorkflowName;
  repository: RepositoryTarget;
  workspacePath: string;
  /**
   * Changed files captured from the source-bound patch collector. The
   * disposable workspace intentionally has no .git directory, so postflight
   * must not rediscover this evidence from workspace navigation.
   */
  changedFiles: readonly ChangedFileEvidence[];
  /**
   * Keeps one warning on the run record (`evidenceWarnings`) for something
   * the run wrote that the operator should fix, without failing the run.
   */
  recordWarning?: (warning: string) => void;
}
/** Run-record warning prefix for an anchor problem a run wrote into a page. */
export const WRITTEN_PAGE_ANCHOR_WARNING_CODE = "content-index-written-anchor";
export type ImpactPostflightResult =
  | { schemaVersion: 1; status: "completed"; analysisDigest: string; changedPaths: string[] }
  | { schemaVersion: 1; status: "no-change" };
export type ImpactPostflightEvidence =
  | ImpactPostflightResult
  | { schemaVersion: 1; status: "failed"; reason: "analysis-failed" };
export interface ImpactPostflightService {
  postflight(input: ImpactPostflightContext): Promise<ImpactPostflightResult>;
}
