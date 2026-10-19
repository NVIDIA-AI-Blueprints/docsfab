// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Host-side study observation for confined-tool settlement.
 * One event per executed tool, never per model token.
 */
import { OBSERVATION_TOOL_NAMES } from "./observation-tools.js";
import { isObservationSearchPlan } from "../search/observation-search-plan.js";
import type { WorkflowSearchPlanV1 } from "../workflow-contracts/contracts.js";
import {
  studyTargetFromToolCall,
  type StudyObservationMode,
  type StudyPathClass,
} from "../records/study-event.js";
import type { StudySession } from "../records/study-store.js";

export interface StudyCallScratch {
  readonly tool: string;
  readonly scheduled: boolean;
  readonly startedAt: number;
  readonly targetNodeId?: string;
  readonly pathClass?: StudyPathClass;
  readonly probeId?: string;
}

export function observationModeForStep(
  search: WorkflowSearchPlanV1 | undefined,
  grantedTools: readonly string[],
): StudyObservationMode {
  if (isObservationSearchPlan(search)) return "talk-tree+required-probes";
  if (grantedTools.some((tool) => (OBSERVATION_TOOL_NAMES as readonly string[]).includes(tool))) {
    return "talk-tree";
  }
  return "corpus";
}

export function isScheduledStudyTool(tool: string): boolean {
  return (OBSERVATION_TOOL_NAMES as readonly string[]).includes(tool);
}

export function scratchFromToolCall(
  tool: string,
  toolCall: unknown,
  startedAt: number,
): StudyCallScratch {
  const target = studyTargetFromToolCall(toolCall);
  return {
    tool,
    scheduled: isScheduledStudyTool(tool),
    startedAt,
    ...target,
  };
}

export async function emitStudySettlements(
  session: StudySession | undefined,
  input: {
    readonly runId: string;
    readonly workflow: string;
    readonly stepId: string;
    readonly nowMs: number;
    readonly results: readonly { callSha256: string; outcome: "succeeded" | "failed" }[];
    readonly scratch: ReadonlyMap<string, StudyCallScratch>;
    readonly fallbackTool: (callSha256: string) => string;
  },
): Promise<void> {
  if (!session) return;
  for (const result of input.results) {
    const scratch = input.scratch.get(result.callSha256);
    const tool = scratch?.tool ?? input.fallbackTool(result.callSha256);
    const durationMs = scratch ? Math.max(0, input.nowMs - scratch.startedAt) : 0;
    await session.recordSettlement({
      runId: input.runId,
      workflow: input.workflow,
      stepId: input.stepId,
      tool,
      disposition: result.outcome,
      durationMs,
      scheduled: scratch?.scheduled ?? isScheduledStudyTool(tool),
      ...(scratch?.probeId !== undefined ? { probeId: scratch.probeId } : {}),
      ...(scratch?.targetNodeId !== undefined
        ? { targetNodeId: scratch.targetNodeId }
        : { pathClass: scratch?.pathClass ?? "other" }),
    });
  }
}
