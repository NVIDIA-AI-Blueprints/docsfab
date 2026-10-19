// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Tool-confine seam for the Pi adapter: skill-lock grant sets, bounded
 * beforeToolCall chaining, and failure-category attribution.
 */
import { createAgentSession } from "@earendil-works/pi-coding-agent";

import { isQualityCandidateValidationStep } from "../execution/contracts.js";
import type { ToolFailureCategoryEntry } from "../records/contracts.js";
import type {
  WorkflowDefinition,
  WorkflowSearchPlanV1,
  WorkflowStep,
} from "../workflow-contracts/contracts.js";
import { isObservationSearchPlan } from "../search/observation-search-plan.js";
import { CANON_TOOL_NAMES } from "./canon-tools.js";
import { OBSERVATION_TOOL_NAMES } from "./observation-tools.js";
import {
  SOURCE_CITE_TOOL_NAMES,
  PRESERVATION_SOURCE_READ_TOOL_NAMES,
  SOURCE_READ_TOOL_NAMES,
  SOURCE_SEARCH_TOOL_NAMES,
} from "./source-tools.js";
import { TOOL_RESULT_RECALL_TOOL_NAME } from "./tool-output-cap.js";
import { HISTORY_TOOL_NAMES } from "./history-tools.js";
import {
  answerSubmissionApplies,
  QUALITY_SUBMISSION_TOOL_NAME,
  QUALITY_ANSWER_RECORD_TOOL_NAME,
  type ResolvedAnswerPath,
} from "./answer-submission.js";

export const QUALITY_CANDIDATE_VALIDATION_TOOL_NAME = "validate_quality_candidate" as const;

/** Skill-lock policy surface (filesystem only). Host may grant additional kernel tools. */
export const FILESYSTEM_READ_ONLY_TOOLS = ["read", "grep", "find", "ls"] as const;
export const FILESYSTEM_WRITE_TOOLS = [...FILESYSTEM_READ_ONLY_TOOLS, "edit", "write"] as const;
/** Model-facing grants for lease accounting and session tool activation. */
export const READ_ONLY_TOOLS = [...FILESYSTEM_READ_ONLY_TOOLS, ...CANON_TOOL_NAMES] as const;
export const WRITE_TOOLS = [...READ_ONLY_TOOLS, "edit", "write"] as const;

export type PiBeforeToolCall = NonNullable<
  Awaited<ReturnType<typeof createAgentSession>>["session"]["agent"]["beforeToolCall"]
>;

export type BoundedBeforeToolCall = PiBeforeToolCall & {
  governanceStops(): number;
};

/** Chain Pi's hook while enforcing a deterministic cap inside multi-call turns. */
export function createBoundedBeforeToolCall(
  existing: PiBeforeToolCall | undefined,
  maxToolCalls: number,
): BoundedBeforeToolCall {
  if (!Number.isSafeInteger(maxToolCalls) || maxToolCalls <= 0) {
    throw new Error("maxToolCalls must be a positive safe integer.");
  }
  let preparedToolCalls = 0;
  let governanceStops = 0;
  const guard: PiBeforeToolCall = async (context, signal) => {
    const result = await existing?.(context, signal);
    if (result?.block) return result;
    preparedToolCalls += 1;
    if (preparedToolCalls > maxToolCalls) {
      governanceStops += 1;
      return {
        block: true,
        reason: "DocsFab stopped this tool call at the local bounded tool-call limit.",
      };
    }
    return result;
  };
  return Object.assign(guard, {
    governanceStops: () => governanceStops,
  });
}

/** Count executed failure categories; `governance-stop` is never-executed. */
function executedFailureCount(counts: ReadonlyMap<string, number>): number {
  return [...counts.entries()].reduce(
    (total, [category, count]) => (category === "governance-stop" ? total : total + count),
    0,
  );
}

/**
 * Attribute known local policy blocks before labeling residual tool defects.
 * `failedCalls` is the executed `byTool` failure budget. `governance-stop`
 * counts that never executed are a supplemental partition and must not consume
 * that budget.
 */
export function summarizeToolFailureCategories(
  failedCalls: number,
  recorded: readonly ToolFailureCategoryEntry[],
  governanceStops: number,
  unknownToolFailures = 0,
): ToolFailureCategoryEntry[] {
  const counts = new Map(recorded.map((item) => [item.category, item.count]));
  const attributableUnknownFailures = Math.min(
    unknownToolFailures,
    Math.max(0, failedCalls - executedFailureCount(counts)),
  );
  if (attributableUnknownFailures > 0) {
    counts.set("unknown-tool", (counts.get("unknown-tool") ?? 0) + attributableUnknownFailures);
  }
  const unclassified = Math.max(0, failedCalls - executedFailureCount(counts));
  if (unclassified > 0) {
    counts.set("tool-defect", (counts.get("tool-defect") ?? 0) + unclassified);
  }
  if (governanceStops > 0) {
    counts.set("governance-stop", (counts.get("governance-stop") ?? 0) + governanceStops);
  }
  return [...counts.entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((left, right) => left.category.localeCompare(right.category));
}

/** Admit only the host-selected closed tool set into durable evidence. */
export function normalizeObservedToolName(
  value: unknown,
  grantedTools: ReadonlySet<string>,
): string {
  return typeof value === "string" && grantedTools.has(value) ? value : "unknown-tool";
}

export function skillPolicyTools(
  mode: "read-only" | "write",
  kind?: "inference" | "host-operation" | "evaluate",
): string[] {
  // A host-operation step runs in a host-side executor whose filesystem
  // authority comes from the operation's host grant, not the model's tools.
  if (kind === "host-operation" || kind === "evaluate" || mode !== "write") {
    return [...FILESYSTEM_READ_ONLY_TOOLS];
  }
  return [...FILESYSTEM_WRITE_TOOLS];
}

export function grantedTools(
  mode: "read-only" | "write",
  kind?: "inference" | "host-operation" | "evaluate",
  search?: WorkflowSearchPlanV1,
  /**
   * True only when the host handed this step a live source reader; registry or
   * artifact presence is not that grant.
   */
  sourceRead = false,
  /** Separate from `sourceRead` so a reader without a searcher declares no search grant. */
  sourceSearch = false,
  /** True only when the host also handed this step a live source citer. */
  sourceCite = false,
  /**
   * True only when the confined tool set registers `docsfab_recall_tool_result`.
   * Off by default: a hosted composition seals its `declaredTools`, so adding a
   * name there is a re-activation.
   */
  toolResultRecall = false,
  /**
   * True only when the host built a git history reader for this step
   * (`historyReaderForStep`). Last, so no earlier positional flag moves.
   */
  historyRead = false,
): string[] {
  const scheduled = isObservationSearchPlan(search) ? [...OBSERVATION_TOOL_NAMES] : [];
  const source = [
    ...(sourceRead ? SOURCE_READ_TOOL_NAMES : []),
    ...(sourceSearch ? SOURCE_SEARCH_TOOL_NAMES : []),
    ...(sourceCite ? SOURCE_CITE_TOOL_NAMES : []),
    ...(historyRead ? HISTORY_TOOL_NAMES : []),
  ];
  const recall = toolResultRecall ? [TOOL_RESULT_RECALL_TOOL_NAME] : [];
  // Same rule as `skillPolicyTools`.
  if (kind === "host-operation" || kind === "evaluate" || mode !== "write") {
    return [...READ_ONLY_TOOLS, ...recall, ...scheduled, ...source];
  }
  return [...WRITE_TOOLS, ...recall, ...scheduled, ...source];
}

/** One policy projection for Pi, hosted composition checks, leases and records. */
export function grantedToolsForStep(
  workflow: Pick<WorkflowDefinition, "name">,
  step: Pick<WorkflowStep, "id" | "skill" | "kind" | "mode" | "search">,
  qualityArtifactBound = false,
  sourceRead = false,
  sourceSearch = false,
  sourceCite = false,
  toolResultRecall = false,
  toolCeiling?: readonly string[],
  /**
   * The step's resolved answer path; the tool-call path grants the submission
   * tool. The runner resolves it once, so every grant site agrees.
   */
  answerSubmission?: ResolvedAnswerPath,
  /** See `grantedTools`; appended last so every existing caller keeps its meaning. */
  historyRead = false,
  /** Process-local test injection only; the records route is absent by default. */
  qualityAnswerRecords = false,
  /** Host-qualified source-obligation adapter; absent by default. */
  sourceObligationAnswerRecords = false,
  preservationSourceRead = false,
): string[] {
  const reviewQualityAnswerRecords =
    qualityAnswerRecords &&
    workflow.name === "review-documentation" &&
    isQualityCandidateValidationStep({ workflow, step, qualityArtifactBound });
  const baseTools = grantedTools(
    step.mode,
    step.kind,
    step.search,
    sourceRead,
    sourceSearch,
    sourceCite,
    toolResultRecall,
    historyRead,
  );
  // The answer-record evaluator cannot submit a FoundationCanon artifact. Keep
  // the canon read/proposal tools available, but avoid advertising this
  // unrelated submit tool on its model-facing surface.
  const base = reviewQualityAnswerRecords
    ? baseTools.filter((name) => name !== "canon_submit_artifact")
    : baseTools;
  const validated =
    workflow.name === "review-documentation" &&
    !qualityAnswerRecords &&
    isQualityCandidateValidationStep({
      workflow,
      step,
      qualityArtifactBound,
    })
      ? [...base, QUALITY_CANDIDATE_VALIDATION_TOOL_NAME]
      : base;
  const submitted =
    !qualityAnswerRecords &&
    answerSubmission?.path === "tool-call" &&
    answerSubmissionApplies({ workflow, step, qualityBound: qualityArtifactBound })
      ? [...validated, QUALITY_SUBMISSION_TOOL_NAME]
      : validated;
  const derived =
    reviewQualityAnswerRecords ||
    (sourceObligationAnswerRecords &&
      ["create-documentation", "review-documentation", "update-documentation"].includes(
        workflow.name,
      ) &&
      step.id === "derive-source-obligations" &&
      step.skill === "verify-technical-accuracy" &&
      (step.kind ?? "inference") === "evaluate" &&
      step.mode === "read-only")
      ? [...submitted, QUALITY_ANSWER_RECORD_TOOL_NAME]
      : submitted;
  const withPreservationSource = preservationSourceRead
    ? [...derived, ...PRESERVATION_SOURCE_READ_TOOL_NAMES]
    : derived;
  return toolCeiling === undefined
    ? withPreservationSource
    : withPreservationSource.filter((tool) => toolCeiling.includes(tool));
}
