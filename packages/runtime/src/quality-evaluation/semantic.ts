// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { jsonEnvelopeBody } from "../execution/json-envelope.js";
import type { ModelEndpointConfig } from "../model/configuration.js";
import type { RunRecord } from "../records/contracts.js";
import { createModelConnection } from "../model/provider.js";
import { detectStrictCredentialRuleIds } from "../security/repository-scanner.js";
import type {
  EvaluationJudge,
  EvaluationRubric,
  JudgeDecision,
  SemanticEvidence,
  SemanticJudgeRequest,
} from "./contracts.js";
import {
  DOCSFAB_SEMANTIC_EVIDENCE_QUALITY_ID_V1,
  DOCSFAB_SEMANTIC_EVIDENCE_QUALITY_VERSION,
} from "./rubric-identifiers.js";

export const SEMANTIC_RUBRIC_V1: EvaluationRubric = {
  id: DOCSFAB_SEMANTIC_EVIDENCE_QUALITY_ID_V1,
  version: DOCSFAB_SEMANTIC_EVIDENCE_QUALITY_VERSION,
  criteria: [
    "Findings are specific and actionable.",
    "Claims are supported by the supplied governed run evidence.",
    "The result is useful for the fixture's documentation workflow.",
    "The result does not claim evidence that is absent from the input.",
  ],
};

const MAX_SUMMARY_LENGTH = 2_000;
const MAX_RATIONALE_LENGTH = 1_000;
const REDACTED_SECRET = "[REDACTED: credential-like content]";

/**
 * Summaries are the only free text needed for semantic grading. Fail closed on
 * credential-like content, remove control characters, and cap size before the
 * text can cross the judge boundary.
 */
export function minimizeSemanticText(value: string): string {
  // Redaction: references and placeholders still count here.
  if (detectStrictCredentialRuleIds(value).length > 0) return REDACTED_SECRET;
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim()
    .slice(0, MAX_SUMMARY_LENGTH);
}

export function buildSemanticEvidence(
  fixture: { name: string; version: number },
  records: RunRecord[],
): SemanticEvidence {
  return {
    fixture,
    records: records.map((record) => ({
      workflow: record.workflow,
      status: record.status,
      revision: record.repository.revision,
      steps: record.steps.map((step) => ({
        id: step.id,
        skill: step.skill,
        status: step.status,
        ...(step.summary ? { summary: minimizeSemanticText(step.summary) } : {}),
      })),
      tools: [
        ...new Set([
          ...record.tools.byTool.map((tool) => tool.name),
          ...record.steps.flatMap((step) => step.tools?.byTool.map((tool) => tool.name) ?? []),
        ]),
      ].sort(),
      governedSkills: record.skills.map((skill) => ({
        id: skill.id,
        contentSha256: skill.contentSha256,
        ...(skill.bundleSha256 ? { bundleSha256: skill.bundleSha256 } : {}),
      })),
      ...(record.securityScan
        ? {
            security: {
              ruleSet: record.securityScan.ruleSet,
              status: record.securityScan.status,
              ...(record.securityScanEffectiveDisposition
                ? {
                    effectiveStatus: record.securityScanEffectiveDisposition.status,
                  }
                : {}),
              ruleIds: [
                ...new Set(record.securityScan.findings.map((finding) => finding.ruleId)),
              ].sort(),
            },
          }
        : {}),
      ...(record.changes
        ? {
            changes: {
              statuses: record.changes.files.map((file) => file.status).sort(),
              patchPreserved: record.changes.patch !== undefined,
            },
          }
        : {}),
    })),
  };
}

export type JudgeCompletion = (input: SemanticJudgeRequest) => Promise<string>;

export class ConfiguredEvaluationJudge implements EvaluationJudge {
  public readonly identity;

  public constructor(
    config: ModelEndpointConfig,
    private readonly complete: JudgeCompletion = createJudgeCompletion(config),
  ) {
    this.identity = { provider: config.providerId, model: config.modelId };
  }

  public async grade(input: SemanticJudgeRequest): Promise<JudgeDecision> {
    const raw = await this.complete(input);
    const parsed = parseJudgeDecision(raw);
    return {
      ...parsed,
      rationale: minimizeSemanticText(parsed.rationale).slice(0, MAX_RATIONALE_LENGTH),
    };
  }
}

function createJudgeCompletion(config: ModelEndpointConfig): JudgeCompletion {
  return async (input) => {
    const connection = await createModelConnection(config);
    const response = await connection.runtime.completeSimple(
      connection.model,
      {
        systemPrompt: [
          "You are DocsFab's semantic evaluation judge.",
          "Use only the supplied minimized evidence and rubric.",
          "Return one JSON object with passed (boolean), score (0..1), and rationale (string).",
          "Do not include markdown, repository paths, credentials, or input excerpts.",
        ].join("\n"),
        messages: [
          {
            role: "user",
            content: JSON.stringify(input),
            timestamp: Date.now(),
          },
        ],
      },
      {
        maxTokens: Math.min(config.profile.maxOutputTokens, 1_024),
        maxRetries: 0,
      },
    );
    if (response.stopReason === "error" || response.stopReason === "aborted") {
      throw new Error("Judge inference failed.");
    }
    return response.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("");
  };
}

function parseJudgeDecision(value: string): JudgeDecision {
  let parsed: unknown;
  try {
    // The shared model-reply extraction policy.
    parsed = JSON.parse(jsonEnvelopeBody(value));
  } catch {
    throw new Error("Judge returned invalid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Judge returned an invalid decision.");
  }
  const decision = parsed as Record<string, unknown>;
  if (
    typeof decision.passed !== "boolean" ||
    typeof decision.score !== "number" ||
    !Number.isFinite(decision.score) ||
    decision.score < 0 ||
    decision.score > 1 ||
    typeof decision.rationale !== "string" ||
    !decision.rationale.trim()
  ) {
    throw new Error("Judge returned an invalid decision.");
  }
  return {
    passed: decision.passed,
    score: decision.score,
    rationale: decision.rationale,
  };
}
