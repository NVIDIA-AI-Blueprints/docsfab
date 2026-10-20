// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { deepFreeze } from "../contract-kit/freeze.js";
import type {
  ContextQueryKind,
  SearchMode,
  StepMode,
  WorkflowContextPolicy,
  WorkflowAuthoringBranchV3,
  WorkflowAuthoringSelectionV3,
  WorkflowBranchV2,
  WorkflowDefinition,
  WorkflowSearchPlanV1,
  WorkflowStep,
  WorkflowStepKind,
} from "../workflow-contracts/contracts.js";

/**
 * Manifest-backed jobs an operator may start with `docsfab run`.
 *
 * Every entry here is also a declarative manifest; the reverse is not true.
 */
export const PUBLIC_WORKFLOW_NAMES = [
  "bootstrap",
  "review-documentation",
  "create-documentation",
  "update-documentation",
  "restructure-documentation",
  "readiness",
  "release-documentation-readiness",
  "audit-documentation",
] as const;

/**
 * Manifest-backed jobs the host spine may dispatch but an operator may not
 * start locally.
 *
 * `live-agent-turn` answers one governed question about an approved page set.
 * It is a catalogued workflow because a job IS a catalogued workflow -- there
 * is no separate job-kind axis -- but it has no local entry point: its input
 * arrives on the frozen review-event slot, and running it without that input
 * fails closed.
 */
export const HOSTED_WORKFLOW_NAMES = [
  "live-agent-turn",
  "reconcile-product-behavior",
  "foundation",
  "foundation-to-patch",
  "ia-analysis",
  "ia-plan",
  "site-bootstrap",
] as const;

/**
 * Every manifest under `workflows/`.
 *
 * Written as literals, not `[...PUBLIC, ...HOSTED]`:
 * `bin/source-checkout-refresh.mjs` reads this array's string literals from
 * the compiled launcher (`readCompiledWorkflowNames`) to detect a stale build,
 * and a spread would read as an empty list and rebuild the launcher on every
 * CLI invocation. A test pins the three lists against each other.
 */
export const DECLARATIVE_WORKFLOW_NAMES = [
  "bootstrap",
  "review-documentation",
  "create-documentation",
  "update-documentation",
  "restructure-documentation",
  "live-agent-turn",
  "readiness",
  "release-documentation-readiness",
  "audit-documentation",
  "reconcile-product-behavior",
  "foundation",
  "foundation-to-patch",
  "ia-analysis",
  "ia-plan",
  "site-bootstrap",
] as const;

export type PublicWorkflowName = (typeof PUBLIC_WORKFLOW_NAMES)[number];
export type HostedWorkflowName = (typeof HOSTED_WORKFLOW_NAMES)[number];
export type DeclarativeWorkflowName = (typeof DECLARATIVE_WORKFLOW_NAMES)[number];
export type WorkflowSearchPlanId =
  | "documentation-audit"
  | "documentation-observation"
  | "source-readiness"
  | "release-documentation-readiness"
  | "information-architecture-discovery";

export interface LoadWorkflowManifestOptions {
  root?: string;
  searchPlans: Readonly<Partial<Record<WorkflowSearchPlanId, WorkflowSearchPlanV1>>>;
}

const defaultManifestRoot = fileURLToPath(new URL("../../workflows/", import.meta.url));
/** Pin-A schema beside the closed job-json set. Not a public job manifest. */
const WORKFLOW_SCHEMA_FILENAME = "workflow.schema.json";
const workflowNameSet = new Set<string>(DECLARATIVE_WORKFLOW_NAMES);
const stepKinds = new Set<WorkflowStepKind>(["inference", "host-operation", "evaluate"]);
const stepModes = new Set<StepMode>(["read-only", "write"]);
const searchModes = new Set<SearchMode>(["observe", "revalidate", "reuse"]);
const contextLevels = new Set(["local", "change-scoped", "corpus"] as const);
const contextQueries = new Set<ContextQueryKind>([
  "locate",
  "get-neighborhood",
  "find-home",
  "test-placement",
  "expand",
]);

export function loadWorkflowManifestCatalog(
  options: LoadWorkflowManifestOptions,
): Readonly<Record<DeclarativeWorkflowName, WorkflowDefinition>> {
  const root = options.root ?? defaultManifestRoot;
  const expectedFiles = DECLARATIVE_WORKFLOW_NAMES.map((name) => `${name}.json`).sort();
  const actualFiles = readdirSync(root)
    .filter((name) => name.endsWith(".json") && name !== WORKFLOW_SCHEMA_FILENAME)
    .sort();

  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    const hint = options.root === undefined ? sourceCheckoutRebuildHint() : "";
    throw new Error(
      `Runtime workflow manifest set mismatch: expected ${expectedFiles.join(", ")}; found ${actualFiles.join(", ")}${hint}.`,
    );
  }

  const entries = DECLARATIVE_WORKFLOW_NAMES.map((expectedName) => {
    const file = `${expectedName}.json`;
    const path = join(root, file);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Runtime workflow manifest ${file} could not be parsed because it is invalid: ${detail}.`,
      );
    }
    return [
      expectedName,
      parseWorkflowManifestSnapshot(parsed, expectedName, options.searchPlans),
    ] as const;
  });

  return deepFreeze(
    Object.fromEntries(entries) as Record<DeclarativeWorkflowName, WorkflowDefinition>,
  );
}

function sourceCheckoutRebuildHint(): string {
  const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
  if (!existsSync(join(packageRoot, "src", "launcher.ts"))) return "";
  return "; rebuild the compiled launcher from this checkout (`npm --prefix packages/runtime run build`) and retry";
}

export function parseWorkflowManifestSnapshot(
  value: unknown,
  expectedName: DeclarativeWorkflowName,
  searchPlans: Readonly<Partial<Record<WorkflowSearchPlanId, WorkflowSearchPlanV1>>>,
): WorkflowDefinition {
  const path = `workflows/${expectedName}.json`;
  const record = requireRecord(value, path);
  if (record.schemaVersion === 3) {
    return parseCreateWorkflowManifestV3(record, expectedName, searchPlans, path);
  }
  if (record.schemaVersion === 2) {
    return parseUpdateWorkflowManifestV2(record, expectedName, searchPlans, path);
  }
  requireExactKeys(
    record,
    ["schemaVersion", "name", "title", "outcome", "contextPolicy", "steps"],
    path,
  );
  if (record.schemaVersion !== 1) {
    throw new Error(`${path}.schemaVersion must equal 1 for this runtime workflow manifest.`);
  }

  const name = requireString(record.name, `${path}.name`);
  if (name !== expectedName || !workflowNameSet.has(name)) {
    throw new Error(`${path}.name must exactly match the declared workflow name ${expectedName}.`);
  }

  const contextPolicy = parseContextPolicy(record.contextPolicy, `${path}.contextPolicy`);
  const rawSteps = requireArray(record.steps, `${path}.steps`);
  if (rawSteps.length === 0) {
    throw new Error(`${path}.steps must contain at least one declared workflow step.`);
  }
  const steps = rawSteps.map((step, index) =>
    parseStep(step, `${path}.steps[${index}]`, searchPlans),
  );

  const stepIds = steps.map((step) => step.id);
  if (new Set(stepIds).size !== stepIds.length) {
    throw new Error(`${path}.steps must not contain duplicate workflow step identifiers.`);
  }
  for (const [index, step] of steps.entries()) {
    for (const consumed of step.consumes ?? []) {
      if (!stepIds.slice(0, index).includes(consumed)) {
        throw new Error(`${path}.steps[${index}].consumes must name an earlier workflow step.`);
      }
    }
    for (const consumed of step.consumesEvidence ?? []) {
      if (!stepIds.slice(0, index).includes(consumed)) {
        throw new Error(
          `${path}.steps[${index}].consumesEvidence must name an earlier workflow step.`,
        );
      }
    }
  }
  assertSearchParticipation(steps, path);
  const policyStepIds = contextPolicy.steps.map((step) => step.stepId);
  if (JSON.stringify(policyStepIds) !== JSON.stringify(stepIds)) {
    throw new Error(`${path}.contextPolicy.steps must match workflow step ids in order.`);
  }

  return {
    name: expectedName,
    title: requireString(record.title, `${path}.title`),
    outcome: requireString(record.outcome, `${path}.outcome`),
    contextPolicy,
    steps,
  };
}

interface ClosedStepContractV3 {
  id: string;
  kind: WorkflowStepKind;
  skill: string;
  mode: StepMode;
  consumes?: readonly string[];
  consumesEvidence?: readonly string[];
  searchPlan?: WorkflowSearchPlanId;
  searchMode?: SearchMode;
  allowReadOnlyDegraded: boolean;
}

const legacyCreatePrefixV3: readonly ClosedStepContractV3[] = [
  {
    id: "plan-documentation",
    kind: "evaluate",
    skill: "plan-documentation",
    mode: "read-only",
    searchPlan: "documentation-observation",
    searchMode: "observe",
    allowReadOnlyDegraded: true,
  },
  {
    id: "derive-source-obligations",
    kind: "evaluate",
    skill: "verify-technical-accuracy",
    mode: "read-only",
    searchPlan: "documentation-observation",
    searchMode: "revalidate",
    allowReadOnlyDegraded: true,
  },
  {
    id: "write-documentation",
    kind: "inference",
    skill: "write-documentation",
    mode: "write",
    consumes: ["derive-source-obligations"],
    searchPlan: "documentation-observation",
    searchMode: "revalidate",
    allowReadOnlyDegraded: false,
  },
  {
    id: "lint-documentation",
    kind: "host-operation",
    skill: "lint-documentation",
    mode: "read-only",
    allowReadOnlyDegraded: true,
  },
  {
    id: "provisional-technical-verification",
    kind: "evaluate",
    skill: "verify-technical-accuracy",
    mode: "read-only",
    consumes: ["derive-source-obligations"],
    searchPlan: "documentation-observation",
    searchMode: "revalidate",
    allowReadOnlyDegraded: true,
  },
  {
    id: "verify-technical-accuracy",
    kind: "evaluate",
    skill: "verify-technical-accuracy",
    mode: "read-only",
    consumes: ["derive-source-obligations", "provisional-technical-verification"],
    consumesEvidence: ["derive-source-obligations", "provisional-technical-verification"],
    searchPlan: "documentation-observation",
    searchMode: "revalidate",
    allowReadOnlyDegraded: true,
  },
  {
    id: "review-documentation",
    kind: "evaluate",
    skill: "review-documentation",
    mode: "read-only",
    allowReadOnlyDegraded: true,
  },
];

const correctedCreatePrefixV3: readonly ClosedStepContractV3[] = [
  ...legacyCreatePrefixV3.slice(0, 5),
  {
    id: "review-documentation",
    kind: "evaluate",
    skill: "review-documentation",
    mode: "read-only",
    allowReadOnlyDegraded: true,
  },
  {
    id: "verify-technical-accuracy",
    kind: "evaluate",
    skill: "verify-technical-accuracy",
    mode: "read-only",
    consumes: [
      "derive-source-obligations",
      "provisional-technical-verification",
      "review-documentation",
    ],
    consumesEvidence: [
      "derive-source-obligations",
      "provisional-technical-verification",
      "review-documentation",
    ],
    searchPlan: "documentation-observation",
    searchMode: "revalidate",
    allowReadOnlyDegraded: true,
  },
];

const retainBranchV3: readonly ClosedStepContractV3[] = [
  {
    id: "test-audience-understanding",
    kind: "evaluate",
    skill: "test-audience-understanding",
    mode: "read-only",
    consumes: ["lint-documentation", "verify-technical-accuracy", "review-documentation"],
    allowReadOnlyDegraded: true,
  },
  {
    id: "evaluate-document-quality",
    kind: "evaluate",
    skill: "evaluate-document-quality",
    mode: "read-only",
    consumes: [
      "lint-documentation",
      "verify-technical-accuracy",
      "review-documentation",
      "test-audience-understanding",
    ],
    consumesEvidence: ["verify-technical-accuracy"],
    searchPlan: "documentation-observation",
    searchMode: "reuse",
    allowReadOnlyDegraded: true,
  },
];

const reviseBranchV3: readonly ClosedStepContractV3[] = [
  {
    id: "revise-documentation",
    kind: "inference",
    skill: "write-documentation",
    mode: "write",
    consumes: ["derive-source-obligations", "verify-technical-accuracy", "review-documentation"],
    consumesEvidence: [
      "derive-source-obligations",
      "verify-technical-accuracy",
      "review-documentation",
    ],
    searchPlan: "documentation-observation",
    searchMode: "revalidate",
    allowReadOnlyDegraded: false,
  },
  {
    id: "lint-revised-documentation",
    kind: "host-operation",
    skill: "lint-documentation",
    mode: "read-only",
    allowReadOnlyDegraded: true,
  },
  {
    id: "provisional-revised-technical-verification",
    kind: "evaluate",
    skill: "verify-technical-accuracy",
    mode: "read-only",
    consumes: ["derive-source-obligations"],
    searchPlan: "documentation-observation",
    searchMode: "revalidate",
    allowReadOnlyDegraded: true,
  },
  {
    id: "verify-revised-technical-accuracy",
    kind: "evaluate",
    skill: "verify-technical-accuracy",
    mode: "read-only",
    consumes: ["derive-source-obligations", "provisional-revised-technical-verification"],
    consumesEvidence: ["derive-source-obligations", "provisional-revised-technical-verification"],
    searchPlan: "documentation-observation",
    searchMode: "revalidate",
    allowReadOnlyDegraded: true,
  },
  {
    id: "review-revised-documentation",
    kind: "evaluate",
    skill: "review-documentation",
    mode: "read-only",
    consumes: ["lint-revised-documentation", "verify-revised-technical-accuracy"],
    allowReadOnlyDegraded: true,
  },
  {
    id: "test-audience-understanding",
    kind: "evaluate",
    skill: "test-audience-understanding",
    mode: "read-only",
    consumes: [
      "lint-revised-documentation",
      "verify-revised-technical-accuracy",
      "review-revised-documentation",
    ],
    allowReadOnlyDegraded: true,
  },
  {
    id: "evaluate-document-quality",
    kind: "evaluate",
    skill: "evaluate-document-quality",
    mode: "read-only",
    consumes: [
      "lint-revised-documentation",
      "verify-revised-technical-accuracy",
      "review-revised-documentation",
      "test-audience-understanding",
    ],
    consumesEvidence: ["verify-revised-technical-accuracy"],
    searchPlan: "documentation-observation",
    searchMode: "reuse",
    allowReadOnlyDegraded: true,
  },
];

function parseCreateWorkflowManifestV3(
  record: Record<string, unknown>,
  expectedName: DeclarativeWorkflowName,
  searchPlans: Readonly<Partial<Record<WorkflowSearchPlanId, WorkflowSearchPlanV1>>>,
  path: string,
): WorkflowDefinition {
  requireExactKeys(
    record,
    ["schemaVersion", "name", "title", "outcome", "prefix", "selection", "branches"],
    path,
  );
  if (expectedName !== "create-documentation" || record.name !== expectedName) {
    throw new Error(`${path}.schemaVersion 3 is supported only for create-documentation.`);
  }

  const selectionRecord = requireRecord(record.selection, `${path}.selection`);
  requireExactKeys(selectionRecord, ["afterStepId", "kind"], `${path}.selection`);
  if (selectionRecord.kind !== "authoring-revision-v1") {
    throw new Error(`${path}.selection must use the closed authoring-revision-v1 selector.`);
  }
  const prefixContract =
    selectionRecord.afterStepId === "review-documentation"
      ? legacyCreatePrefixV3
      : selectionRecord.afterStepId === "verify-technical-accuracy"
        ? correctedCreatePrefixV3
        : undefined;
  if (!prefixContract) {
    throw new Error(
      `${path}.selection must run after review-documentation or verify-technical-accuracy.`,
    );
  }

  const prefixRecord = requireRecord(record.prefix, `${path}.prefix`);
  requireExactKeys(prefixRecord, ["steps", "contextPolicy"], `${path}.prefix`);
  const prefix = parseManifestSegment(prefixRecord, `${path}.prefix`, searchPlans, []);
  assertClosedSegmentV3(prefix, prefixContract, `${path}.prefix`, searchPlans);

  const rawBranches = requireArray(record.branches, `${path}.branches`);
  if (rawBranches.length !== 2) {
    throw new Error(`${path}.branches must contain exactly retain then revise.`);
  }
  const contracts = [retainBranchV3, reviseBranchV3] as const;
  const branches = rawBranches.map((value, index) => {
    const branchPath = `${path}.branches[${index}]`;
    const branchRecord = requireRecord(value, branchPath);
    requireExactKeys(branchRecord, ["id", "steps", "contextPolicy"], branchPath);
    const expectedId = index === 0 ? "retain" : "revise";
    if (branchRecord.id !== expectedId) {
      throw new Error(`${branchPath}.id must equal the closed branch id ${expectedId}.`);
    }
    const segment = parseManifestSegment(branchRecord, branchPath, searchPlans, prefix.steps);
    assertClosedSegmentV3(segment, contracts[index]!, branchPath, searchPlans);
    return { id: expectedId, ...segment } as WorkflowAuthoringBranchV3;
  }) as [WorkflowAuthoringBranchV3, WorkflowAuthoringBranchV3];

  const selection = {
    afterStepId: selectionRecord.afterStepId,
    kind: "authoring-revision-v1",
  } as WorkflowAuthoringSelectionV3;
  const revise = branches[1];
  return {
    schemaVersion: 3,
    name: expectedName,
    title: requireString(record.title, `${path}.title`),
    outcome: requireString(record.outcome, `${path}.outcome`),
    // The flat view declares the complete step superset for catalog consumers.
    // V3-aware execution must use authoringSchedule and select one fixed branch.
    contextPolicy: {
      schemaVersion: 1,
      steps: [...prefix.contextPolicy.steps, ...revise.contextPolicy.steps],
    },
    steps: [...prefix.steps, ...revise.steps],
    authoringSchedule: {
      manifest: structuredClone(
        record,
      ) as unknown as import("../workflow-contracts/contracts.js").WorkflowManifestV3,
      prefix,
      selection,
      branches,
    },
  };
}

function assertClosedSegmentV3(
  segment: { steps: readonly WorkflowStep[]; contextPolicy: WorkflowContextPolicy },
  contracts: readonly ClosedStepContractV3[],
  path: string,
  searchPlans: Readonly<Partial<Record<WorkflowSearchPlanId, WorkflowSearchPlanV1>>>,
): void {
  if (segment.steps.length !== contracts.length) {
    throw new Error(`${path}.steps must declare the fixed CREATE Manifest V3 schedule.`);
  }
  for (const [index, expected] of contracts.entries()) {
    const step = segment.steps[index]!;
    const context = segment.contextPolicy.steps[index]!;
    if (
      step.id !== expected.id ||
      step.kind !== expected.kind ||
      step.skill !== expected.skill ||
      step.mode !== expected.mode ||
      !sameOptionalStrings(step.consumes, expected.consumes) ||
      !sameOptionalStrings(step.consumesEvidence, expected.consumesEvidence) ||
      step.searchMode !== expected.searchMode ||
      step.search !==
        (expected.searchPlan === undefined ? undefined : searchPlans[expected.searchPlan]) ||
      context.stepId !== expected.id ||
      context.required !== true ||
      context.level !== "corpus" ||
      context.query !== "expand" ||
      context.allowReadOnlyDegraded !== expected.allowReadOnlyDegraded
    ) {
      throw new Error(
        `${path}.steps[${index}] must match the closed CREATE Manifest V3 ${expected.id} contract.`,
      );
    }
  }
}

function sameOptionalStrings(
  actual: readonly string[] | undefined,
  expected: readonly string[] | undefined,
): boolean {
  if (actual === undefined || expected === undefined) return actual === expected;
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function parseUpdateWorkflowManifestV2(
  record: Record<string, unknown>,
  expectedName: DeclarativeWorkflowName,
  searchPlans: Readonly<Partial<Record<WorkflowSearchPlanId, WorkflowSearchPlanV1>>>,
  path: string,
): WorkflowDefinition {
  requireExactKeys(
    record,
    ["schemaVersion", "name", "title", "outcome", "prefix", "selection", "branches"],
    path,
  );
  if (expectedName !== "update-documentation" || record.name !== expectedName) {
    throw new Error(`${path}.schemaVersion 2 is supported only for update-documentation.`);
  }

  const prefixRecord = requireRecord(record.prefix, `${path}.prefix`);
  requireExactKeys(prefixRecord, ["steps", "contextPolicy"], `${path}.prefix`);
  const prefix = parseManifestSegment(prefixRecord, `${path}.prefix`, searchPlans, []);
  if (
    prefix.steps.length !== 1 ||
    prefix.steps[0]?.id !== "plan-documentation" ||
    prefix.steps[0].mode !== "read-only" ||
    prefix.steps[0].kind !== "evaluate" ||
    prefix.steps[0].searchMode !== "observe"
  ) {
    throw new Error(
      `${path}.prefix must contain only the read-only observing plan-documentation evaluate step.`,
    );
  }

  const selectionRecord = requireRecord(record.selection, `${path}.selection`);
  requireExactKeys(selectionRecord, ["afterStepId", "kind"], `${path}.selection`);
  if (
    selectionRecord.afterStepId !== "plan-documentation" ||
    selectionRecord.kind !== "editorial-candidate-v1"
  ) {
    throw new Error(`${path}.selection must use editorial-candidate-v1 after plan-documentation.`); // hygiene: ok
  }

  const rawBranches = requireArray(record.branches, `${path}.branches`);
  if (rawBranches.length !== 2)
    throw new Error(`${path}.branches must contain exactly author then assess-no-change.`);
  const branches = rawBranches.map((value, index) => {
    const branchPath = `${path}.branches[${index}]`;
    const branchRecord = requireRecord(value, branchPath);
    requireExactKeys(branchRecord, ["id", "steps", "contextPolicy"], branchPath);
    const expectedId = index === 0 ? "author" : "assess-no-change";
    if (branchRecord.id !== expectedId)
      throw new Error(`${branchPath}.id must equal ${expectedId}.`); // hygiene: ok
    const segment = parseManifestSegment(branchRecord, branchPath, searchPlans, prefix.steps);
    return { id: expectedId, ...segment } as WorkflowBranchV2;
  }) as [WorkflowBranchV2, WorkflowBranchV2];

  const authorIds = branches[0].steps.map((step) => step.id);
  const noChangeIds = branches[1].steps.map((step) => step.id);
  const expectedAuthor = [
    "derive-source-obligations",
    "write-documentation",
    "lint-documentation",
    "verify-technical-accuracy",
    "review-documentation",
    "test-audience-understanding",
    "evaluate-document-quality",
  ];
  const expectedNoChange = [
    "verify-technical-accuracy",
    "review-documentation",
    "test-audience-understanding",
    "evaluate-document-quality",
  ];
  if (
    JSON.stringify(authorIds) !== JSON.stringify(expectedAuthor) ||
    JSON.stringify(noChangeIds) !== JSON.stringify(expectedNoChange)
  ) {
    throw new Error(
      `${path}.branches must declare the fixed author and assess-no-change suffixes.`,
    );
  }
  if (
    branches[0].steps
      .filter((step) => step.mode === "write")
      .map((step) => step.id)
      .join() !== "write-documentation" ||
    branches[1].steps.some((step) => step.mode !== "read-only")
  ) {
    throw new Error(`${path}.branches declare an invalid write boundary.`); // hygiene: ok
  }

  return {
    schemaVersion: 2,
    name: expectedName,
    title: requireString(record.title, `${path}.title`),
    outcome: requireString(record.outcome, `${path}.outcome`),
    // The conventional flat view is the author path for legacy catalog consumers.
    // Execution and evidence code must use `branching` for V2 selection.
    contextPolicy: {
      schemaVersion: 1,
      steps: [...prefix.contextPolicy.steps, ...branches[0].contextPolicy.steps],
    },
    steps: [...prefix.steps, ...branches[0].steps],
    branching: {
      manifest: structuredClone(
        record,
      ) as unknown as import("../workflow-contracts/contracts.js").WorkflowManifestV2,
      prefix,
      selection: { afterStepId: "plan-documentation", kind: "editorial-candidate-v1" },
      branches,
    },
  };
}

function parseManifestSegment(
  record: Record<string, unknown>,
  path: string,
  searchPlans: Readonly<Partial<Record<WorkflowSearchPlanId, WorkflowSearchPlanV1>>>,
  earlierSteps: readonly WorkflowStep[],
): { steps: readonly WorkflowStep[]; contextPolicy: WorkflowContextPolicy } {
  const contextPolicy = parseContextPolicy(record.contextPolicy, `${path}.contextPolicy`);
  const steps = requireArray(record.steps, `${path}.steps`).map((step, index) =>
    parseStep(step, `${path}.steps[${index}]`, searchPlans),
  );
  if (steps.length === 0)
    throw new Error(`${path}.steps must contain at least one declared workflow step.`);
  const allIds = [...earlierSteps.map((step) => step.id), ...steps.map((step) => step.id)];
  if (new Set(allIds).size !== allIds.length)
    throw new Error(`${path}.steps must not duplicate prefix or suffix step identifiers.`);
  for (const [index, step] of steps.entries()) {
    const preceding = allIds.slice(0, earlierSteps.length + index);
    for (const consumed of [...(step.consumes ?? []), ...(step.consumesEvidence ?? [])]) {
      if (!preceding.includes(consumed))
        throw new Error(
          `${path}.steps[${index}] may consume only an earlier step in its selected path.`,
        );
    }
  }
  assertSearchParticipation([...earlierSteps, ...steps], path);
  if (
    JSON.stringify(contextPolicy.steps.map((step) => step.stepId)) !==
    JSON.stringify(steps.map((step) => step.id))
  ) {
    throw new Error(`${path}.contextPolicy.steps must match workflow step ids in order.`);
  }
  return { steps, contextPolicy };
}

function parseContextPolicy(value: unknown, path: string): WorkflowContextPolicy {
  const record = requireRecord(value, path);
  requireExactKeys(record, ["schemaVersion", "steps"], path);
  if (record.schemaVersion !== 1) {
    throw new Error(`${path}.schemaVersion must equal 1 for this workflow context policy.`);
  }
  const rawSteps = requireArray(record.steps, `${path}.steps`);

  return {
    schemaVersion: 1,
    steps: rawSteps.map((value, index) => {
      const stepPath = `${path}.steps[${index}]`;
      const step = requireRecord(value, stepPath);
      requireExactKeys(
        step,
        ["stepId", "required", "level", "query", "allowReadOnlyDegraded"],
        stepPath,
      );
      const level = requireString(step.level, `${stepPath}.level`);
      const query = requireString(step.query, `${stepPath}.query`);
      if (!contextLevels.has(level as "local" | "change-scoped" | "corpus")) {
        throw new Error(`${stepPath}.level must name a supported workflow context level.`);
      }
      if (!contextQueries.has(query as ContextQueryKind)) {
        throw new Error(`${stepPath}.query must name a supported workflow context query.`);
      }
      return {
        stepId: requireString(step.stepId, `${stepPath}.stepId`),
        required: requireBoolean(step.required, `${stepPath}.required`),
        level: level as "local" | "change-scoped" | "corpus",
        query: query as ContextQueryKind,
        allowReadOnlyDegraded: requireBoolean(
          step.allowReadOnlyDegraded,
          `${stepPath}.allowReadOnlyDegraded`,
        ),
      };
    }),
  };
}

function parseStep(
  value: unknown,
  path: string,
  searchPlans: Readonly<Partial<Record<WorkflowSearchPlanId, WorkflowSearchPlanV1>>>,
): WorkflowStep {
  const record = requireRecord(value, path);
  requireExactKeys(
    record,
    [
      "id",
      "title",
      "kind",
      "operation",
      "invokes",
      "skill",
      "mode",
      "prompt",
      "consumes",
      "consumesEvidence",
      "searchPlan",
      "searchMode",
    ],
    path,
  );

  const kind = requireString(record.kind, `${path}.kind`);
  const mode = requireString(record.mode, `${path}.mode`);
  if (!stepKinds.has(kind as WorkflowStepKind)) {
    throw new Error(`${path}.kind must name a supported runtime workflow step kind.`);
  }
  if (!stepModes.has(mode as StepMode)) {
    throw new Error(`${path}.mode must name a supported runtime workflow step mode.`);
  }
  const operation =
    record.operation === undefined
      ? undefined
      : requireString(record.operation, `${path}.operation`);
  // Condition: a declared native `operation` names an installed host executor
  // AND sits on a `host-operation` step. An inference or evaluate step must NOT
  // carry one -- that would let a model-selected step name an executor.
  if (
    operation !== undefined &&
    (kind !== "host-operation" ||
      !["ia-plan", "site-bootstrap", "foundation", "foundation-to-patch"].includes(operation))
  ) {
    throw new Error(
      `${path}.operation must name a supported native host operation on a host-operation step.`,
    );
  }

  // Condition: a declared `invokes` names the ONE installed child pipeline the
  // native Foundation-to-patch composition runs in process, and only on that
  // composition's own `host-operation` step. Any other kind, any other
  // `operation`, and any other child name must NOT be admitted here -- a
  // manifest that could name an arbitrary child would let the catalog widen the
  // tool ceiling of a step the model already selects.
  const invokes =
    record.invokes === undefined ? undefined : requireString(record.invokes, `${path}.invokes`);
  if (
    invokes !== undefined &&
    (kind !== "host-operation" ||
      operation !== "foundation-to-patch" ||
      invokes !== "create-documentation")
  ) {
    throw new Error(`${path}.invokes does not name the implemented native composition dependency.`);
  }

  const searchPlanId =
    record.searchPlan === undefined
      ? undefined
      : requireString(record.searchPlan, `${path}.searchPlan`);
  const searchModeRaw =
    record.searchMode === undefined
      ? undefined
      : requireString(record.searchMode, `${path}.searchMode`);
  if ((searchPlanId === undefined) !== (searchModeRaw === undefined)) {
    throw new Error(`${path} must declare searchPlan and searchMode together in the same step.`);
  }
  if (searchModeRaw !== undefined && !searchModes.has(searchModeRaw as SearchMode)) {
    throw new Error(`${path}.searchMode must be observe, revalidate, or reuse.`);
  }
  const consumes =
    record.consumes === undefined
      ? undefined
      : requireArray(record.consumes, `${path}.consumes`).map((value, index) =>
          requireString(value, `${path}.consumes[${index}]`),
        );
  if (consumes && new Set(consumes).size !== consumes.length) {
    throw new Error(`${path}.consumes must not contain duplicate step identifiers.`);
  }
  const consumesEvidence =
    record.consumesEvidence === undefined
      ? undefined
      : requireArray(record.consumesEvidence, `${path}.consumesEvidence`).map((value, index) =>
          requireString(value, `${path}.consumesEvidence[${index}]`),
        );
  if (consumesEvidence && new Set(consumesEvidence).size !== consumesEvidence.length) {
    throw new Error(`${path}.consumesEvidence must not contain duplicate step identifiers.`);
  }
  if (
    searchPlanId !== undefined &&
    (!Object.hasOwn(searchPlans, searchPlanId) ||
      searchPlans[searchPlanId as WorkflowSearchPlanId] === undefined)
  ) {
    throw new Error(`${path}.searchPlan must name a registered runtime workflow search plan.`);
  }

  return {
    id: requireString(record.id, `${path}.id`),
    title: requireString(record.title, `${path}.title`),
    kind: kind as WorkflowStepKind,
    ...(operation === undefined
      ? {}
      : { operation: operation as NonNullable<WorkflowStep["operation"]> }),
    ...(invokes === undefined ? {} : { invokes: invokes as "create-documentation" }),
    skill: requireString(record.skill, `${path}.skill`),
    mode: mode as StepMode,
    prompt: requireString(record.prompt, `${path}.prompt`),
    ...(consumes === undefined ? {} : { consumes }),
    ...(consumesEvidence === undefined ? {} : { consumesEvidence }),
    ...(searchPlanId === undefined
      ? {}
      : {
          search: searchPlans[searchPlanId as WorkflowSearchPlanId]!,
          searchMode: searchModeRaw as SearchMode,
        }),
  };
}

function assertSearchParticipation(steps: readonly WorkflowStep[], path: string): void {
  const observedPlans = new Set<string>();
  for (const [index, step] of steps.entries()) {
    if (!step.search) continue;
    const planId = step.search.id;
    const mode = step.searchMode;
    if (mode === "observe") {
      if (observedPlans.has(planId)) {
        throw new Error(
          `${path}.steps[${index}] cannot observe search plan ${planId} because an earlier step already observed it.`,
        );
      }
      observedPlans.add(planId);
      continue;
    }
    if (!observedPlans.has(planId)) {
      throw new Error(
        `${path}.steps[${index}] cannot ${mode} search plan ${planId} without an earlier observe.`,
      );
    }
  }
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object in the runtime workflow manifest.`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array in the runtime workflow manifest.`);
  }
  return value;
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${path} must be a non-empty string in the runtime workflow manifest.`);
  }
  return value;
}

function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${path} must be a boolean in the runtime workflow manifest.`);
  }
  return value;
}

function requireExactKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
) {
  const extras = Object.keys(record).filter((key) => !allowed.includes(key));
  if (extras.length > 0) {
    throw new Error(
      `${path} contains keys unsupported by the runtime workflow manifest schema: ${extras.join(", ")}.`,
    );
  }
  const missing = allowed.filter(
    (key) =>
      key !== "searchPlan" &&
      key !== "searchMode" &&
      key !== "consumes" &&
      key !== "consumesEvidence" &&
      key !== "operation" &&
      key !== "invokes" &&
      !Object.prototype.hasOwnProperty.call(record, key),
  );
  if (missing.length > 0) {
    throw new Error(
      `${path} is missing keys required by the runtime workflow manifest schema: ${missing.join(", ")}.`,
    );
  }
}
