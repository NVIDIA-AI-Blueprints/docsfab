// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Step aggregation and inference retry defaults shared across host and model steps. */
import { ArtifactValidationError, type ArtifactUse } from "../artifacts/contracts.js";
import { validateArtifactUse } from "../artifacts/validate.js";
import type { InferenceRetryPolicy } from "../execution/contracts.js";
import {
  attemptExecutionLimitStop,
  exhaustedAllowanceStop,
  formatStepExecutionLimitStop,
  type StepExecutionLimitStop,
} from "../config/execution-limit-stops.js";
import type { InferenceTurnEvidence, RunRecord } from "../records/contracts.js";

export const noRetryPolicy: InferenceRetryPolicy = {
  maxRetries: 0,
  baseDelayMs: 0,
  maxDelayMs: 0,
  retryableCategories: [],
};

export function emptyUsage(): RunRecord["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
    turns: 0,
  };
}

export function emptyTools(): RunRecord["tools"] {
  return {
    totalCalls: 0,
    failedCalls: 0,
    byTool: [],
    failureCategories: [],
  };
}

/** Loose structural subset so this guard does not couple to the full evidence type. */
interface StepWithLeaseEvidence {
  readonly inference?: {
    readonly attempts?: readonly {
      readonly executionLease?: {
        readonly terminalReason?: string;
        readonly providerTurns?: number;
        readonly toolCalls?: { readonly executed?: number; readonly governanceBlocked?: number };
      };
      readonly turns?: readonly Partial<InferenceTurnEvidence>[];
    }[];
  };
}

/**
 * The execution ceiling DocsFab cut this step off at before the model was
 * done, otherwise `undefined`. Signals: executed tool calls reached the hard
 * ceiling, or provider turns reached the policy maximum. Either means the
 * envelope was too small for the work, not a model failure; reporting
 * `succeeded` would hide it.
 *
 * `governanceBlocked > 0` is not a signal: blocked calls are charged to the
 * per-lease allowance, not the hard ceiling, so a parallel batch straddling a
 * lease renewal is blocked and the step still finishes normally. A terminal
 * block reaches the ceiling and shows up in the first signal.
 */
export function stepTruncationStop(
  step: StepWithLeaseEvidence,
): StepExecutionLimitStop | undefined {
  // Only the last attempt: earlier entries are failed attempts a retry
  // superseded, and scanning them would flag a step whose retry succeeded.
  // `runner-step-loop.ts` likewise takes the step's model from the last attempt.
  const attempts = step.inference?.attempts ?? [];
  const attempt = attempts[attempts.length - 1];
  const lease = attempt?.executionLease;
  if (!lease) return undefined;
  // Every turn in an attempt carries the same policy maxima; read the last so
  // a zero-turn attempt cannot be mistaken for an exhausted one.
  const turns = attempt.turns ?? [];
  const last = turns[turns.length - 1];
  return exhaustedAllowanceStop({
    ...(typeof lease.toolCalls?.executed === "number"
      ? { executedToolCalls: lease.toolCalls.executed }
      : {}),
    ...(typeof last?.maxToolCalls === "number" ? { maxToolCalls: last.maxToolCalls } : {}),
    ...(typeof lease.providerTurns === "number" ? { providerTurns: lease.providerTurns } : {}),
    ...(typeof last?.maxProviderTurns === "number"
      ? { maxProviderTurns: last.maxProviderTurns }
      : {}),
  });
}

/**
 * The execution ceiling the step's last attempt stopped at: the governor
 * refused its next turn for one, or its lease ended at one.
 */
export function stepAttemptLimitStop(
  step: StepWithLeaseEvidence,
): StepExecutionLimitStop | undefined {
  const attempt = step.inference?.attempts?.at(-1);
  return attempt ? attemptExecutionLimitStop(attempt) : undefined;
}

/** A step stopped at an execution ceiling, carrying the limit's catalog code. */
export class StepExecutionLimitError extends Error {
  public readonly code: string;

  public constructor(
    public readonly stepId: string,
    public readonly limitStop: StepExecutionLimitStop,
  ) {
    super(formatStepExecutionLimitStop(stepId, limitStop));
    this.code = limitStop.code;
    this.name = "StepExecutionLimitError";
  }
}

/**
 * The message a failed step records. When the step's last attempt stopped at
 * an execution ceiling and its classification names that ceiling's code, the
 * original message keeps its head, which renderers anchor on, and the coded
 * limit line follows once. Any other failure keeps its own message.
 */
export function stepFailureMessage(
  message: string,
  step: StepWithLeaseEvidence & { readonly id: string; readonly failure?: { code?: unknown } },
): string {
  const limitStop = stepAttemptLimitStop(step);
  if (!limitStop || step.failure?.code !== limitStop.code) return message;
  const line = formatStepExecutionLimitStop(step.id, limitStop);
  // The host's own ceiling stop already wrote the line into its message.
  return message.includes(line) ? message : `${message} ${line}`;
}

export function addUniqueModel(
  models: RunRecord["models"],
  model: NonNullable<RunRecord["steps"][number]["model"]>,
): void {
  if (!models.some((item) => item.provider === model.provider && item.model === model.model)) {
    models.push(model);
  }
}

export function addUniqueSkill(
  skills: RunRecord["skills"],
  skill: NonNullable<RunRecord["steps"][number]["skillEvidence"]>,
): void {
  const existing = skills.find(
    (item) => item.id === skill.id && item.contentSha256 === skill.contentSha256,
  );
  if (existing) {
    if (
      existing.bundleSha256 !== skill.bundleSha256 ||
      existing.roadmapPack?.contractSha256 !== skill.roadmapPack?.contractSha256
    ) {
      throw new Error(`Governed skill identity changed during run for "${skill.id}".`);
    }
    return;
  }
  skills.push(skill);
}

export function normalizeArtifactUses(
  artifacts: readonly ArtifactUse[],
  stepId: string,
  repositoryRevision: string,
): ArtifactUse[] {
  const normalized: ArtifactUse[] = [];
  for (const artifact of artifacts) {
    const source = artifact as unknown as {
      role?: unknown;
      reference?: Record<string, unknown>;
    };
    const copied = {
      role: source?.role,
      stepId,
      reference: {
        kind: source?.reference?.kind,
        schemaVersion: source?.reference?.schemaVersion,
        digest: source?.reference?.digest,
        repositoryRevision: source?.reference?.repositoryRevision,
        repositoryContentDigest: source?.reference?.repositoryContentDigest,
      },
    };
    const validated = validateArtifactUse(copied);
    if (validated.reference.repositoryRevision !== repositoryRevision) {
      throw new ArtifactValidationError("repository-mismatch", "$.reference.repositoryRevision");
    }
    if (!normalized.some((candidate) => artifactUseKey(candidate) === artifactUseKey(validated))) {
      normalized.push(validated);
    }
  }
  return normalized;
}

export function addUniqueArtifacts(target: ArtifactUse[], artifacts: readonly ArtifactUse[]): void {
  for (const artifact of artifacts) {
    if (!target.some((candidate) => artifactUseKey(candidate) === artifactUseKey(artifact))) {
      target.push(artifact);
    }
  }
}

function artifactUseKey(artifact: ArtifactUse): string {
  return [
    artifact.stepId ?? "",
    artifact.role,
    artifact.reference.kind,
    String(artifact.reference.schemaVersion),
    artifact.reference.digest,
    artifact.reference.repositoryRevision,
    artifact.reference.repositoryContentDigest,
  ].join("\0");
}

export function addUsage(target: RunRecord["usage"], value: RunRecord["usage"]): void {
  target.input += value.input;
  target.output += value.output;
  target.cacheRead += value.cacheRead;
  target.cacheWrite += value.cacheWrite;
  target.total += value.total;
  target.turns += value.turns;
  if (value.cost !== undefined) target.cost = (target.cost ?? 0) + value.cost;
}

export function addTools(target: RunRecord["tools"], value: RunRecord["tools"]): void {
  target.totalCalls += value.totalCalls;
  target.failedCalls += value.failedCalls;
  if (value.preExecutionRejections !== undefined) {
    const count = (target.preExecutionRejections?.count ?? 0) + value.preExecutionRejections.count;
    if (!Number.isSafeInteger(count))
      throw new Error(
        "The aggregated pre-execution rejection count exceeds safe integer precision.",
      );
    target.preExecutionRejections = { ...value.preExecutionRejections, count };
  }
  for (const entry of value.byTool) {
    const existing = target.byTool.find((item) => item.name === entry.name);
    if (existing) {
      existing.calls += entry.calls;
      existing.failures += entry.failures;
    } else {
      target.byTool.push({ ...entry });
    }
  }
  target.byTool.sort((left, right) => left.name.localeCompare(right.name));
  const targetCategories = (target.failureCategories ??= []);
  for (const entry of value.failureCategories ?? []) {
    const existing = targetCategories.find((item) => item.category === entry.category);
    if (existing) existing.count += entry.count;
    else targetCategories.push({ ...entry });
  }
  targetCategories.sort((left, right) => left.category.localeCompare(right.category));
  // `presented` and `toolResultArchive` stay per-step: a run-level union of
  // offered tools would hide which step had write tools, and archive identity
  // is per attempt, not a summable count.
}
