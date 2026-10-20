// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Project live attempt state into retained evidence after a prompt settles or fails. */
import type { HarnessStepInput, InferenceStepError } from "../../execution/contracts.js";
import type {
  InferenceAttemptEvidence,
  InferenceAnswerSubmissionEvidenceV1,
  InferenceConcludeNowEvidenceV1,
  InferenceDeadlineTurn,
} from "../../records/contracts.js";
import type { ModelConnection } from "../../model/provider.js";
import { ProviderResponseLimitError } from "../../model/provider.js";
import {
  buildAttemptModelTelemetry,
  type LandedProviderTurnTelemetry,
} from "../../model/attempt-telemetry.js";
import type { createModelEvidence } from "../../model/profile-evidence.js";
import {
  bindProducedTurnOutputTokens,
  bindProviderFinishReasons,
} from "../turn-output-evidence.js";
import { summarizeToolFailureCategories, normalizeObservedToolName } from "../pi-tool-confine.js";
import { inferAttemptWriteSettlement } from "../write-settlement.js";
import { attemptArtifactSha256 } from "../pi-offline.js";
import type { createPiExecutionLeaseController } from "../pi-offline.js";
import type { createConfinedToolSet } from "../confined-tools.js";
import type { ReadEvidenceLedger } from "../read-evidence.js";
import type { createPiAgentSession } from "../pi-session.js";

type PiEvidenceBatch = {
  readonly calls: readonly { readonly name: string; readonly sha256: string }[];
  readonly authorized: readonly string[];
  readonly hostDenied: ReadonlySet<string>;
  readonly observedResults: ReadonlyMap<string, "succeeded" | "failed">;
};

/** All scalar fields are sampled by the caller at each invocation, never cached across turns. */
export interface PiAttemptEvidenceSources {
  readonly input: Pick<
    HarnessStepInput,
    | "step"
    | "inferenceAttempt"
    | "retriesConsumed"
    | "evidenceIdentity"
    | "answerSubmission"
    | "qualityAnswerRecords"
  >;
  readonly readSessionStats: () => ReturnType<
    Awaited<ReturnType<typeof createPiAgentSession>>["getSessionStats"]
  >;
  readonly readProviderTurns: () => ReturnType<
    NonNullable<ModelConnection["turnGovernance"]>["evidence"]
  >;
  readonly reportUsageCost: ModelConnection["reportUsageCost"];
  readonly readProviderResponses: () =>
    | ReturnType<NonNullable<ModelConnection["providerResponses"]>>
    | undefined;
  readonly readProviderRequests: () =>
    | ReturnType<NonNullable<ModelConnection["providerRequests"]>>
    | undefined;
  readonly readSourceReuse: () => NonNullable<
    InferenceAttemptEvidence["efficiency"]
  >["sourceReuse"];
  readonly readModelEvidence: () => ReturnType<typeof createModelEvidence>;
  readonly readLeasePhase: () => ReturnType<
    typeof createPiExecutionLeaseController
  >["coordinator"]["phase"];
  readonly readLeaseCounters: () => ReturnType<
    typeof createPiExecutionLeaseController
  >["coordinator"]["state"]["toolCalls"];
  readonly bindLeaseEvidence: ReturnType<typeof createPiExecutionLeaseController>["evidence"];
  readonly readToolFailureCategories: () => ReturnType<
    Awaited<ReturnType<typeof createConfinedToolSet>>["getFailureCategories"]
  >;
  readonly readToolResultArchive: () => ReturnType<
    Awaited<ReturnType<typeof createConfinedToolSet>>["getToolResultArchive"]
  >;
  readonly readHistoryReads: () => ReturnType<
    Awaited<ReturnType<typeof createConfinedToolSet>>["getHistoryReads"]
  >;
  readonly readToolRefusals: () => ReturnType<
    Awaited<ReturnType<typeof createConfinedToolSet>>["getToolRefusals"]
  >;
  readonly readToolArgumentFiller: () => ReturnType<
    Awaited<ReturnType<typeof createConfinedToolSet>>["getToolArgumentFiller"]
  >;
  readonly readReadEvidenceSnapshot: () => ReturnType<ReadEvidenceLedger["snapshot"]>;
  readonly confinedToolDefinitions: readonly { readonly name: string }[];
  readonly batches: ReadonlyMap<string, PiEvidenceBatch>;
  readonly grantedToolNames: ReadonlySet<string>;
  readonly toolActivity: ReadonlyMap<string, { readonly calls: number; readonly failures: number }>;
  readonly governanceStops: number;
  readonly unknownToolFailures: number;
  readonly preExecutionRejections: number;
  readonly terminalPreExecutionRejection?: {
    readonly turnKey: string;
    readonly turn: number;
    readonly count: number;
  };
  readonly preExecutionRejectionTurns: ReadonlySet<string>;
  readonly producedOutputTokens: readonly (number | undefined)[];
  readonly producedFinishReasons: readonly unknown[];
  readonly lastLandedTurnTelemetry?: LandedProviderTurnTelemetry;
  readonly providerLatencyMs: number;
  readonly concludeNowEvidence?: InferenceConcludeNowEvidenceV1;
  readonly deadlineTurn?: InferenceDeadlineTurn;
  readonly answerSubmissionEvidence: () => InferenceAnswerSubmissionEvidenceV1 | undefined;
}

export function collectPiAttemptEvidence(
  {
    input,
    readSessionStats,
    readProviderTurns,
    reportUsageCost,
    readProviderResponses,
    readProviderRequests,
    readSourceReuse,
    readModelEvidence,
    readLeasePhase,
    readLeaseCounters,
    bindLeaseEvidence,
    readToolFailureCategories,
    readToolResultArchive,
    readHistoryReads,
    readToolRefusals,
    readToolArgumentFiller,
    readReadEvidenceSnapshot,
    confinedToolDefinitions,
    batches,
    grantedToolNames,
    toolActivity,
    governanceStops,
    unknownToolFailures,
    preExecutionRejections,
    terminalPreExecutionRejection,
    preExecutionRejectionTurns,
    producedOutputTokens,
    producedFinishReasons,
    lastLandedTurnTelemetry,
    providerLatencyMs,
    concludeNowEvidence,
    deadlineTurn,
    answerSubmissionEvidence,
  }: PiAttemptEvidenceSources,
  selectedResponseLimit?: ProviderResponseLimitError,
): NonNullable<InferenceStepError["evidence"]> {
  const stats = readSessionStats();
  const turns = bindProviderFinishReasons(
    bindProducedTurnOutputTokens(readProviderTurns(), producedOutputTokens),
    producedFinishReasons,
  );
  const finalTurn = turns.at(-1);
  if (
    terminalPreExecutionRejection &&
    finalTurn?.turn === terminalPreExecutionRejection.turn &&
    finalTurn.decision !== "stop" &&
    preExecutionRejectionTurns.has(terminalPreExecutionRejection.turnKey)
  ) {
    turns[turns.length - 1] = {
      ...finalTurn,
      terminalPreExecutionRejections: terminalPreExecutionRejection.count,
    };
  }
  const providerTurns = turns.filter((turn) => turn.decision !== "stop").length;
  const byTool = [...toolActivity.entries()]
    .map(([name, activity]) => ({ name, ...activity }))
    .sort((left, right) => left.name.localeCompare(right.name));
  // Executed byTool failures only. Never-executed governance stops are a
  // supplemental category partition, not part of the failedCalls budget.
  const failedCalls = byTool.reduce((total, item) => total + item.failures, 0);
  const failureCategories = summarizeToolFailureCategories(
    failedCalls,
    readToolFailureCategories(),
    governanceStops,
    unknownToolFailures,
  );
  const usage = {
    input: stats.tokens.input,
    output: stats.tokens.output,
    cacheRead: stats.tokens.cacheRead,
    cacheWrite: stats.tokens.cacheWrite,
    total: stats.tokens.total,
    turns: providerTurns,
    ...(reportUsageCost ? { cost: stats.cost } : {}),
  };
  const archive = readToolResultArchive();
  const readEvidenceSnapshot = readReadEvidenceSnapshot();
  const historyReads = readHistoryReads();
  const toolRefusals = readToolRefusals();
  const toolArgumentFiller = readToolArgumentFiller();
  const tools = {
    totalCalls: byTool.reduce((total, item) => total + item.calls, 0),
    failedCalls,
    byTool,
    failureCategories,
    ...(preExecutionRejections > 0
      ? {
          preExecutionRejections: {
            schemaVersion: 1 as const,
            kind: "tool-pre-execution-rejections" as const,
            count: preExecutionRejections,
          },
        }
      : {}),
    // Read from the registered definitions, not the policy, so the record
    // distinguishes "the model declined a tool" from "it was never offered".
    presented: [...confinedToolDefinitions.map((definition) => definition.name)].sort(),
    // Content-free handle/digest/refusal state. Raw archive bytes stay
    // in the tool set and die with it.
    ...(archive ? { toolResultArchive: archive } : {}),
    ...(readEvidenceSnapshot ? { readEvidence: readEvidenceSnapshot } : {}),
    ...(historyReads ? { historyReads } : {}),
    ...(toolRefusals ? { toolRefusals } : {}),
    ...(toolArgumentFiller ? { toolArgumentFiller } : {}),
  };
  const writeSettlement =
    input.step.mode === "write"
      ? inferAttemptWriteSettlement({
          leaseTerminal: readLeasePhase() === "terminal",
          presented: tools.presented,
          calls: [...batches.values()].flatMap((batch) =>
            batch.calls.map((call) => ({
              name: normalizeObservedToolName(call.name, grantedToolNames),
              authorized: batch.authorized.includes(call.sha256),
              hostDenied: batch.hostDenied.has(call.sha256),
              ...(batch.observedResults.get(call.sha256) === undefined
                ? {}
                : { outcome: batch.observedResults.get(call.sha256)! }),
            })),
          ),
          counters: readLeaseCounters(),
          toolActivity: tools,
        })
      : undefined;
  // Landed turns zip with sent turns in order, as the bindings above do;
  // a turn sent after the last landing (the one Pi was aborted in) has
  // no finish reason, so the output figures come from the landed one.
  const landedTurn =
    producedFinishReasons.length > 0
      ? turns.filter((turn) => turn.decision !== "stop")[producedFinishReasons.length - 1]
      : undefined;
  // Pi flattens a host response-byte refusal into “Connection error.”
  // Keep the landed turn's finish/usage/latency, but do not classify the
  // exact local refusal selected by its caller as a provider network
  // error in retry telemetry. Other failure paths keep their telemetry.
  const telemetryLandedTurn =
    selectedResponseLimit && lastLandedTurnTelemetry
      ? { finishReason: lastLandedTurnTelemetry.finishReason }
      : lastLandedTurnTelemetry;
  const modelTelemetry = buildAttemptModelTelemetry({
    ...(telemetryLandedTurn ? { lastLanded: telemetryLandedTurn } : {}),
    ...(landedTurn ? { landedTurn } : {}),
    providerLatencyMs,
  });
  const providerResponses = readProviderResponses();
  return {
    model: readModelEvidence(),
    usage,
    tools,
    ...(writeSettlement === undefined ? {} : { writeSettlement }),
    turns,
    modelTelemetry,
    ...(providerResponses === undefined ? {} : { providerResponses }),
    efficiency: {
      schemaVersion: 1,
      requests: readProviderRequests() ?? null,
      sourceReuse: readSourceReuse(),
    },
    ...(concludeNowEvidence ? { concludeNow: { ...concludeNowEvidence } } : {}),
    ...(deadlineTurn ? { deadlineTurn } : {}),
    ...(input.answerSubmission || input.qualityAnswerRecords
      ? { answerSubmission: answerSubmissionEvidence()! }
      : {}),
    executionLease: bindLeaseEvidence({
      inferenceAttempt: input.inferenceAttempt ?? 1,
      retriesConsumed: input.retriesConsumed ?? 0,
      repositoryRevision: input.evidenceIdentity!.repositoryRevision,
      providerTurnLedgerSha256: attemptArtifactSha256(turns),
      usageSha256: attemptArtifactSha256(usage),
      toolsSha256: attemptArtifactSha256(tools),
    }),
  };
}
