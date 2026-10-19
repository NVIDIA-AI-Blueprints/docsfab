// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { limit } from "../../config/limits.js";
import { parseAnswerSubmissionOption } from "../../config/answer-submission.js";
import { describeDocsFabConfigurationSource } from "../../config/host-paths.js";
import { parseDotenvAssignments } from "../../config/dotenv.js";
import { resolveDocsFabRuntimeAssetPaths } from "../../config/runtime-loader.js";
import { planDocumentationQualityAnswerRecords } from "../../harness/answer-record-plan.js";
import {
  loadInstalledModelCompositionAuthority,
  listInstalledModelCompositions,
  resolveInstalledComposition,
} from "../../model-composition/index.js";
import {
  answerSubmissionRecordsFitForEffectiveLimits,
  OPERATOR_COMPOSITION_BIND_WORKFLOW_ID,
} from "../../model/operator-execution-binding.js";

class AnswerRecordFitDoctorOperatorError extends Error {
  readonly code = "answer-record-fit-invalid-input";

  constructor(message: string) {
    super(message);
    this.name = "AnswerRecordFitDoctorOperatorError";
  }
}

export interface DoctorAnswerSubmissionRecordsFit {
  readonly compositionId: string;
  readonly qualification: "qualified" | "unqualified";
  readonly fitStatus: "fits" | "does-not-fit" | "unqualified";
  readonly reason?: string;
  readonly predictedTimerMs: number | null;
  readonly timerReviewLimitMs: number | null;
  readonly effectiveMaxOutputTokens: number;
  readonly effectiveTimeoutMs: number;
  readonly requiredReadingTurns: number | null;
  readonly effectiveMaxProviderTurns: number;
  readonly effectiveMessageBudgetBytes: number | null;
  readonly largestRecordEnvelopeBytes: number | null;
  readonly recordCallCeiling: number;
  readonly recordCallCeilingProvenance: string;
  readonly evidenceProvenance: string;
}

/**
 * Inspect every active installed composition that carries records evidence.
 * This reads installed metadata and the packaged quality profile only; it
 * does not resolve a provider credential or make a provider request.
 */
export async function inspectAnswerSubmissionRecordsFits(input: {
  readonly environment: NodeJS.ProcessEnv;
}): Promise<readonly DoctorAnswerSubmissionRecordsFit[]> {
  const environment = await loadContentFreeFitSettings(input.environment);
  if (parseAnswerSubmissionOption(environment) === "text-final") return [];
  const { authority } = await loadInstalledModelCompositionAuthority();
  const { qualityDirectory } = resolveDocsFabRuntimeAssetPaths(input.environment);
  const summaries = listInstalledModelCompositions(authority).filter(
    (entry) => entry.status === "active" && entry.executionClass === "pi-provider",
  );
  const projections: DoctorAnswerSubmissionRecordsFit[] = [];
  for (const summary of summaries) {
    const bound = resolveInstalledComposition({
      authority,
      compositionId: summary.compositionId,
      workflowId: OPERATOR_COMPOSITION_BIND_WORKFLOW_ID,
    });
    const record = bound.composition.answerSubmissionRecords;
    if (!record) continue;
    const profilePath = resolve(
      qualityDirectory,
      "profiles",
      `${bound.composition.harness.id}`,
      "profile.json",
    );
    const profile = parseProfile(await readFile(profilePath, "utf8"));
    const plan = planDocumentationQualityAnswerRecords({
      requiredDimensionsByLayer: profile.requiredDimensionsByLayer,
      requiredConstraints: profile.requiredConstraints,
      conditionalConstraints: profile.conditionalConstraints,
      limitValue: (name) => limit(name, { environment: input.environment }).value,
    });
    const configuredOutputLimit = positiveConfiguredOutputLimit(
      environment.MODEL_MAX_OUTPUT_TOKENS,
    );
    const providerTurnLimit = limit("compositionExecution.maxProviderTurns", {
      environment: input.environment,
    });
    const timeoutLimit = limit("compositionExecution.timeoutMs", {
      environment: input.environment,
    });
    const effectiveLimits = {
      maxOutputTokens: Math.min(
        ...(configuredOutputLimit === undefined ? [] : [configuredOutputLimit]),
        bound.candidate.proposedLimits.maxOutputTokens,
        bound.composition.compositionLimits.maxOutputTokens,
        bound.compositionCeiling.maxOutputTokens,
      ),
      maxProviderTurns: Math.min(
        providerTurnLimit.value,
        bound.candidate.proposedLimits.maxProviderTurns,
        bound.composition.compositionLimits.maxProviderTurns,
        bound.compositionCeiling.maxProviderTurns,
      ),
      timeoutMs: Math.min(
        timeoutLimit.value,
        bound.candidate.proposedLimits.timeoutMs,
        bound.composition.compositionLimits.timeoutMs,
        bound.compositionCeiling.timeoutMs,
      ),
    };
    const fit = answerSubmissionRecordsFitForEffectiveLimits({
      bound,
      effectiveLimits,
      environment,
    });
    const fitStatus = !fit
      ? "unqualified"
      : fit.fitsRecordBoundary &&
          fit.fitsQualifiedMessageFloor &&
          fit.fitsReadingTurns &&
          fit.fitsEffectiveTimer &&
          fit.withinReviewThreshold
        ? "fits"
        : "does-not-fit";
    const fitFailureReasons = fit
      ? [
          ...(!fit.fitsRecordBoundary
            ? ["effective message cannot contain the largest indivisible record"]
            : []),
          ...(!fit.fitsReadingTurns
            ? ["required reading turns exceed the effective provider-turn ceiling"]
            : []),
          ...(!fit.fitsEffectiveTimer ? ["predicted T* exceeds the effective timeout"] : []),
          ...(!fit.withinReviewThreshold
            ? ["predicted T* exceeds the qualified review threshold"]
            : []),
        ]
      : [];
    const reason = !fit
      ? "retained step-8 run fit metrics are unavailable"
      : !fit.fitsQualifiedMessageFloor
        ? `effective message budget is below the smallest qualified rung (${fit.minimumQualifiedMessageBytes} bytes)`
        : fitFailureReasons.length > 0
          ? fitFailureReasons.join("; ")
          : undefined;
    const outputClampProvenance =
      configuredOutputLimit === undefined
        ? "installed candidate/composition/package minima"
        : "host MODEL_MAX_OUTPUT_TOKENS plus installed minima";
    projections.push({
      compositionId: summary.compositionId,
      qualification: fit ? "qualified" : "unqualified",
      fitStatus,
      ...(reason ? { reason } : {}),
      predictedTimerMs: fit?.predictedTimerMs ?? null,
      timerReviewLimitMs: fit?.timerReviewLimitMs ?? null,
      effectiveMaxOutputTokens: effectiveLimits.maxOutputTokens,
      effectiveTimeoutMs: effectiveLimits.timeoutMs,
      requiredReadingTurns: fit?.requiredReadingTurns ?? null,
      effectiveMaxProviderTurns: effectiveLimits.maxProviderTurns,
      effectiveMessageBudgetBytes: fit?.effectiveMaxMessageBytes ?? null,
      largestRecordEnvelopeBytes:
        fit?.largestRecordEnvelopeBytes ?? record.largestRecordEnvelopeBytes,
      recordCallCeiling: plan.recordCallCeiling,
      recordCallCeilingProvenance:
        `planAnswerRecords(${bound.composition.harness.id}); ` +
        `${plan.requiredKeys} required, ${plan.optionalKeys} optional keys, ` +
        `${plan.maxOpenRecordsPerSet} open records per set, ` +
        `${plan.maxRefusalsPerKey} refusals per key`,
      evidenceProvenance:
        `composition ${summary.compositionId}; output clamp=${outputClampProvenance}; ` +
        `provider-turn clamp=${providerTurnLimit.source} plus installed minima; ` +
        `timeout clamp=${timeoutLimit.source} plus installed minima; ` +
        `answerSubmissionRecords.evidenceSha256=${record.evidenceSha256}; ` +
        `step8TurnEvidence.evidenceSha256=${record.step8TurnEvidence.evidenceSha256}`,
    });
  }
  return projections;
}

/** Read only non-secret fit selectors; provider credentials never enter this path. */
export async function loadContentFreeFitSettings(
  environment: NodeJS.ProcessEnv,
): Promise<NodeJS.ProcessEnv> {
  const selected = { ...environment };
  const needed = ["MODEL_MAX_OUTPUT_TOKENS", "DOCSFAB_ANSWER_SUBMISSION"].filter(
    (name) => selected[name] === undefined,
  );
  if (needed.length === 0) return selected;
  const { secretsFile } = describeDocsFabConfigurationSource(environment);
  if (secretsFile === null) return selected;
  let contents: string;
  try {
    contents = await readFile(secretsFile, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return selected;
    throw error;
  }
  const assignments = parseDotenvAssignments(contents);
  for (const name of needed) {
    const value = assignments.get(name);
    if (value !== undefined) selected[name] = value;
  }
  return selected;
}

function isMissingFile(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT",
  );
}

function positiveConfiguredOutputLimit(value: string | undefined): number | undefined {
  if (value === undefined || !value.trim()) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new AnswerRecordFitDoctorOperatorError(
      "MODEL_MAX_OUTPUT_TOKENS must be a positive integer for records fit inspection.",
    );
  }
  return parsed;
}

function parseProfile(json: string): {
  readonly requiredDimensionsByLayer: Readonly<Record<string, readonly string[]>>;
  readonly requiredConstraints: readonly string[];
  readonly conditionalConstraints: readonly string[];
} {
  const value: unknown = JSON.parse(json);
  if (!isRecord(value)) throw invalidQualityProfile();
  const applicability = value.applicability;
  if (!isRecord(applicability) || !isRecord(applicability.documentation_set)) {
    throw invalidQualityProfile();
  }
  const dimensions = applicability.documentation_set.required_dimensions_by_layer;
  const constraints = value.constraints;
  if (!isRecord(dimensions) || !isRecord(constraints)) throw invalidQualityProfile();
  for (const entries of Object.values(dimensions)) {
    if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== "string")) {
      throw invalidQualityProfile();
    }
  }
  const requiredConstraints = constraints.required;
  const conditionalConstraints = constraints.conditional;
  if (
    !Array.isArray(requiredConstraints) ||
    requiredConstraints.some((entry) => typeof entry !== "string") ||
    !Array.isArray(conditionalConstraints) ||
    conditionalConstraints.some((entry) => typeof entry !== "string")
  ) {
    throw invalidQualityProfile();
  }
  return {
    requiredDimensionsByLayer: dimensions as Record<string, string[]>,
    requiredConstraints: requiredConstraints as string[],
    conditionalConstraints: conditionalConstraints as string[],
  };
}

function invalidQualityProfile(): AnswerRecordFitDoctorOperatorError {
  return new AnswerRecordFitDoctorOperatorError(
    "The installed quality profile is invalid for answer-record fit inspection.",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
