// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Runtime acceptance and corpus evaluation of run records, not Pin C document-quality evaluation. */
import type { RunRecord } from "../records/contracts.js";
import type { SecurityScanEffectiveStatus, SecurityScanStatus } from "../security/contracts.js";
import type { WorkflowName } from "../workflow-contracts/contracts.js";

export type StructuralAssertion =
  | { type: "run-count"; minimum: number }
  | { type: "status"; equals: "succeeded" | "failed" }
  | { type: "workflow"; equals: WorkflowName }
  | { type: "all-steps-succeeded" }
  | { type: "summaries-present" }
  | { type: "step-skills"; equals: string[] }
  | { type: "governed-skill-evidence" }
  | { type: "allowed-tools"; tools: string[] }
  | { type: "required-tools"; tools: string[] }
  | { type: "forbidden-tools"; tools: string[] }
  | { type: "turn-governance-evidence" }
  | { type: "evidence-identity-consistent" }
  | { type: "governed-terminal-status" }
  | { type: "record-shape-consistent" };

export interface EvaluationFixture {
  version: 1;
  name: string;
  assertions: StructuralAssertion[];
}

export interface AssertionResult {
  assertion: StructuralAssertion;
  passed: boolean;
  message: string;
  recordId?: string;
}

export interface StructuralEvaluation {
  fixture: string;
  recordCount: number;
  passed: boolean;
  results: AssertionResult[];
}

export interface EvaluationRubric {
  id: string;
  version: number;
  criteria: readonly string[];
}

export interface JudgeModelIdentity {
  provider: string;
  model: string;
}

/**
 * Content-minimized semantic evidence. Repository locations, instructions,
 * patches, tool arguments/results, and raw model transcripts are excluded.
 */
export interface SemanticEvidence {
  fixture: { name: string; version: number };
  records: Array<{
    workflow: WorkflowName;
    status: RunRecord["status"];
    revision: string;
    steps: Array<{
      id: string;
      skill: string;
      status: RunRecord["steps"][number]["status"];
      summary?: string;
    }>;
    tools: string[];
    governedSkills: Array<{
      id: string;
      contentSha256: string;
      bundleSha256?: string;
    }>;
    security?: {
      ruleSet: string;
      status: SecurityScanStatus;
      effectiveStatus?: SecurityScanEffectiveStatus;
      ruleIds: string[];
    };
    changes?: { statuses: string[]; patchPreserved: boolean };
  }>;
}

export interface SemanticJudgeRequest {
  rubric: EvaluationRubric;
  evidence: SemanticEvidence;
}

export interface JudgeDecision {
  passed: boolean;
  score: number;
  rationale: string;
}

export interface EvaluationJudge {
  identity: JudgeModelIdentity;
  grade(input: SemanticJudgeRequest): Promise<JudgeDecision>;
}

export type JudgeResult =
  | {
      status: "passed" | "disagreed";
      rubric: { id: string; version: number };
      model: JudgeModelIdentity;
      score: number;
      rationale: string;
    }
  | {
      status: "skipped" | "error";
      rubric: { id: string; version: number };
      model?: JudgeModelIdentity;
      reason: string;
    };

export interface EvaluationResult {
  structural: StructuralEvaluation;
  /** Semantic grading is advisory and can never replace structural evidence. */
  judge?: JudgeResult;
  /** Determined exclusively by the reproducible structural assertions. */
  passed: boolean;
}
