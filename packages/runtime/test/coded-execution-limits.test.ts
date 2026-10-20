// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * An exceeded execution ceiling stops a step with the limit's catalogued code,
 * whichever way the step reached it, and the recorded message names the code,
 * the observed value, the ceiling, the scope, and the remediation.
 *
 * The fixtures follow recorded shapes: a step that completed at exactly its
 * 126-call ceiling, and one the governor refused at 127 of 126, both under a
 * sealed 128-turn budget.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { limit, OperationalLimitError, refuseLimit } from "../src/config/limits.js";
import {
  InferenceStepError,
  type AgentHarness,
  type HarnessStepInput,
  type RunRequest,
} from "../src/execution/contracts.js";
import { governedTurnLimitStop } from "../src/config/execution-limit-stops.js";
import { LIMIT_DEFINITIONS } from "../src/config/limits.generated.js";
import { toOperatorErrorEnvelope } from "../src/operator/error-envelope.js";
import { normalizeModelFinishReason } from "../src/model/attempt-telemetry.js";
import { isFailureCode } from "../src/operator/failure-class.js";
import {
  classifyInferenceAttempt,
  classifyThrownFailure,
  LIMIT_REFUSAL_CODES,
  OUTPUT_LIMIT_FINISH_REASONS,
  operatorCodeFailureClass,
} from "../src/operator/failure-classification.js";
import { RAW_MODEL_FINISH_REASONS } from "../src/records/model-telemetry.js";
import type {
  InferenceAttemptEvidence,
  InferenceTurnEvidence,
  InferenceTurnReason,
  RunRecord,
  RunStore,
} from "../src/records/contracts.js";
import type { RepositorySecurityScanner } from "../src/security/contracts.js";
import { WorkflowRunner } from "../src/workflow-execution/runner.js";
import { readyContextPreflight } from "./helpers.js";

const TOOL_CALL_CODE = "composition-execution-max-tool-calls-per-step-bound";
const PROVIDER_TURN_CODE = "composition-execution-max-provider-turns-bound";
const SEALED_PROVIDER_TURN_CODE = "sealed-composition-execution-max-provider-turns-bound";
const LOCAL_STOP =
  "Model request failed [context-exhausted; retryable=false]: Provider turn stopped locally: " +
  "reason=tool-call-limit turn=120 provider-turn-limit=128 tool-calls=127 tool-call-limit=126";

let workspacePath = "";

beforeEach(async () => {
  workspacePath = await mkdtemp(join(tmpdir(), "docsfab-coded-limits-"));
});

afterEach(async () => {
  if (workspacePath) await rm(workspacePath, { recursive: true, force: true });
  workspacePath = "";
});

function governedTurn(overrides: Partial<InferenceTurnEvidence>): InferenceTurnEvidence {
  return {
    turn: 120,
    toolCalls: 120,
    toolResults: 120,
    maxProviderTurns: 128,
    maxToolCalls: 126,
    compactions: 0,
    maxCompactions: 128,
    configuredContextWindow: 131_072,
    effectiveContextWindow: 131_072,
    configuredMaxOutputTokens: 16_384,
    effectiveMaxOutputTokens: 16_384,
    reservedTokens: 1_024,
    estimatedInputTokens: 34_962,
    availableOutputTokens: 95_086,
    requiredMinimumOutputTokens: 16,
    decision: "proceed",
    requestDigest: "c".repeat(64),
    evidenceDigest: "e".repeat(64),
    ...overrides,
  };
}

function governorStop(reason: InferenceTurnReason, overrides: Partial<InferenceTurnEvidence> = {}) {
  return governedTurn({ decision: "stop", reason, toolCalls: 127, toolResults: 127, ...overrides });
}

class MemoryStore implements RunStore {
  public records: RunRecord[] = [];
  public async save(record: RunRecord): Promise<void> {
    this.records.push(structuredClone(record));
  }
}

const scanner: RepositorySecurityScanner = {
  scan: async () => ({
    ruleSet: "test-v1",
    status: "passed",
    scannedFiles: 1,
    binaryFiles: 0,
    findings: [],
  }),
};

function readinessRequest(): RunRequest {
  return {
    workflow: "readiness",
    workspacePath,
    repository: { sourcePath: "/tmp/repo", requestedRevision: "HEAD", revision: "abc123" },
    allowWrite: false,
  };
}

function common(input: HarnessStepInput) {
  return {
    summary: `ran ${input.step.skill}`,
    model: { provider: "hosted", model: "test-model" },
    skill: { id: input.step.skill, contentSha256: "a".repeat(64) },
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15, turns: 1 },
    tools: { totalCalls: 0, failedCalls: 0, byTool: [], failureCategories: [] },
  };
}

/** The step completes with the lease reporting `executed` tool calls against a 126 ceiling. */
function completingHarness(executed: number): AgentHarness {
  return {
    runStep: async (input) => ({
      ...common(input),
      turns: [governedTurn({ turn: 127, toolCalls: executed, toolResults: executed })],
      executionLease: {
        providerTurns: 127,
        toolCalls: { executed, governanceBlocked: 0 },
      } as never,
    }),
  };
}

/** The governor refuses the step's next turn and the attempt fails with its local stop. */
function governorHarness(turn: InferenceTurnEvidence, message = LOCAL_STOP): AgentHarness {
  return {
    runStep: async () => {
      throw new InferenceStepError(message, "context-exhausted", false, { turns: [turn] });
    },
  };
}

async function run(harness: AgentHarness): Promise<RunRecord> {
  return new WorkflowRunner({
    harness,
    store: new MemoryStore(),
    repositoryScanner: scanner,
    contextPreflight: readyContextPreflight,
    id: () => "coded-limits-run",
  }).run(readinessRequest());
}

const NARROW_SCOPE =
  "Narrow the request, for example to fewer pages or sources, so the step finishes inside its ceiling.";
const FITTED_TOOL_CALL_REMEDIATION =
  "The ceiling is compositionExecution.maxToolCallsPerStep = 400 fitted to this step's " +
  "provider-turn budget of 128; the composition's sealed turn budget sets it, and raising a " +
  `sealed budget means re-qualifying the composition. ${NARROW_SCOPE}`;

describe("coded execution ceilings through the workflow runner", () => {
  it("records the tool-call ceiling code when the step completes at the ceiling", async () => {
    const record = await run(completingHarness(126));
    const step = record.steps[0]!;

    expect(record.status).toBe("failed");
    expect(step.failure).toEqual({ class: "bound", layer: "workflow", code: TOOL_CALL_CODE });
    expect(record.failure).toEqual(step.failure);
    expect(step.error).toBe(
      `${TOOL_CALL_CODE}: workflow step "${step.id}" used all of its tool-call ceiling of ` +
        "126 calls (observed 126 calls). Scope: one attempt of this step. " +
        FITTED_TOOL_CALL_REMEDIATION,
    );
    // The fitted ceiling is not the catalog value, so raising the catalog value is no remedy.
    expect(step.error).not.toContain("Lower DOCSFAB_COMPOSITION_EXECUTION_MAX_TOOL_CALLS_PER_STEP");
  });

  it("completes a step one call below the ceiling (adjacent condition)", async () => {
    const record = await run(completingHarness(125));
    expect(record.status).toBe("succeeded");
    expect(record.failure).toBeUndefined();
  });

  it("records the same code when the governor refuses the next turn at the ceiling", async () => {
    const record = await run(governorHarness(governorStop("tool-call-limit")));
    const step = record.steps[0]!;

    expect(record.status).toBe("failed");
    expect(step.failure).toEqual({ class: "bound", layer: "inference", code: TOOL_CALL_CODE });
    expect(record.failure?.code).toBe(TOOL_CALL_CODE);
    // The original message keeps its head; the coded limit line follows it.
    expect(step.error).toBe(
      `${LOCAL_STOP} ${TOOL_CALL_CODE}: workflow step "${step.id}" exceeded its tool-call ` +
        "ceiling of 126 calls (observed 127 calls). Scope: one attempt of this step. " +
        FITTED_TOOL_CALL_REMEDIATION,
    );
    expect(record.error).toBe(step.error);
  });

  it("keeps a context-window stop as context-exhausted, with its own message (adjacent condition)", async () => {
    const message =
      "Model request failed [context-exhausted; retryable=false]: Provider turn stopped locally: reason=context-exhausted";
    const record = await run(
      governorHarness(governorStop("context-exhausted", { toolCalls: 12 }), message),
    );
    const step = record.steps[0]!;

    expect(step.failure).toEqual({
      class: "bound",
      layer: "inference",
      code: "context-exhausted",
    });
    expect(step.error).toBe(message);
  });
});

describe("execution ceiling stops classify by the limit that bound", () => {
  function attempt(
    turn: InferenceTurnEvidence,
    overrides: Partial<InferenceAttemptEvidence> = {},
  ): InferenceAttemptEvidence {
    return {
      attempt: 1,
      outcome: "context-exhausted",
      retryable: false,
      retryScheduled: false,
      turns: [turn],
      ...overrides,
    } as InferenceAttemptEvidence;
  }

  it.each([
    ["tool-call-limit", {}, TOOL_CALL_CODE],
    // The composition's sealed 128-turn budget bound, not the catalog's 512.
    ["provider-turn-limit", { turn: 129 }, SEALED_PROVIDER_TURN_CODE],
    ["provider-turn-limit", { turn: 513, maxProviderTurns: 512 }, PROVIDER_TURN_CODE],
    ["compaction-limit", { compactions: 128 }, "compaction-limit"],
    // Its configured value depends on the execution mode, which the turn does not record.
    [
      "output-authority-exhausted",
      {
        outputAuthority: {
          maxOutputTokens: 4_000,
          cumulativeOutputTokens: 3_990,
          floorOutputTokens: 64,
        },
      },
      "context-exhausted",
    ],
    ["context-exhausted", {}, "context-exhausted"],
    ["compaction-ineffective", {}, "context-exhausted"],
    ["evidence-preservation-required", {}, "context-exhausted"],
  ] as const)("a recorded %s stop with %o classifies as %s", (reason, overrides, code) => {
    const classified = classifyInferenceAttempt(attempt(governorStop(reason, overrides)));
    expect(classified).toEqual({ class: "bound", layer: "inference", code });
  });

  it("refuses a stop whose counters contradict its reason", () => {
    // 126 of 126 is a turn the governor admitted, so it cannot be a tool-call stop.
    const admitted = governorStop("tool-call-limit", { toolCalls: 126 });
    expect(classifyInferenceAttempt(attempt(admitted))?.code).toBe("context-exhausted");
  });

  it("reads the stop reason only from a turn the governor stopped", () => {
    // A proceeding last turn that carries a reason field is not a stop.
    const proceeding = governedTurn({ reason: "tool-call-limit" });
    expect(classifyInferenceAttempt(attempt(proceeding))?.code).toBe("context-exhausted");
  });

  it("codes a governor stop recorded under the older provider-terminal wrap", () => {
    const wrapped = attempt(governorStop("tool-call-limit"), { outcome: "provider-terminal" });
    expect(classifyInferenceAttempt(wrapped)).toEqual({
      class: "bound",
      layer: "inference",
      code: TOOL_CALL_CODE,
    });
  });

  it("codes a lease that stopped with one provider turn left, its reserved final turn", () => {
    const leaseStop = (providerTurns: number) =>
      attempt(governedTurn({ turn: providerTurns }), {
        outcome: "provider-terminal",
        executionLease: {
          terminalReason: "provider-turn-limit",
          providerTurns,
          toolCalls: { executed: 40 },
        } as never,
      });
    // The lease stops when 128 - 127 <= 1, keeping the last turn for the answer.
    expect(classifyInferenceAttempt(leaseStop(127))).toEqual({
      class: "bound",
      layer: "inference",
      code: SEALED_PROVIDER_TURN_CODE,
    });
    // Two turns left is not a stop the lease would make, so nothing is claimed.
    expect(classifyInferenceAttempt(leaseStop(126))?.code).toBe("provider-terminal");
  });

  it("attributes a ceiling to a lowered operator override, not to the sealed budget", () => {
    vi.stubEnv("DOCSFAB_COMPOSITION_EXECUTION_MAX_PROVIDER_TURNS", "128");
    vi.stubEnv("DOCSFAB_COMPOSITION_EXECUTION_MAX_TOOL_CALLS_PER_STEP", "126");
    try {
      // 128 is the effective host value here, so the override bound it.
      expect(
        classifyInferenceAttempt(attempt(governorStop("provider-turn-limit", { turn: 129 }))),
      ).toEqual({ class: "bound", layer: "inference", code: PROVIDER_TURN_CODE });
      const stop = governedTurnLimitStop(governorStop("tool-call-limit"));
      expect(stop?.code).toBe(TOOL_CALL_CODE);
      expect(stop?.remediation).toBe(
        "The ceiling is compositionExecution.maxToolCallsPerStep = 126, lowered by an operator " +
          `override; raise or remove the override, or narrow the request. ${NARROW_SCOPE}`,
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("codes a lease that ended at the hard tool-call ceiling", () => {
    const leaseStop = attempt(governedTurn({ turn: 127, toolCalls: 126 }), {
      outcome: "provider-terminal",
      executionLease: {
        terminalReason: "hard-tool-call-ceiling",
        providerTurns: 127,
        toolCalls: { executed: 126 },
      } as never,
    });
    expect(classifyInferenceAttempt(leaseStop)).toEqual({
      class: "bound",
      layer: "inference",
      code: TOOL_CALL_CODE,
    });
  });

  it("leaves a cumulative lease stop uncoded until its binding limit is recorded (adjacent condition)", () => {
    const leaseStop = attempt(governedTurn({ turn: 40 }), {
      outcome: "provider-terminal",
      executionLease: {
        terminalReason: "cumulative-input-limit",
        providerTurns: 40,
        toolCalls: { executed: 39 },
      } as never,
    });
    expect(classifyInferenceAttempt(leaseStop)).toEqual({
      class: "unknown",
      layer: "inference",
      code: "provider-terminal",
    });
  });

  it("classifies the thrown governor error the same way as its recorded attempt", () => {
    const error = new InferenceStepError(LOCAL_STOP, "context-exhausted", false, {
      turns: [governorStop("tool-call-limit")],
    });
    expect(classifyThrownFailure(error, "workflow")).toEqual({
      class: "bound",
      layer: "inference",
      code: TOOL_CALL_CODE,
    });
  });
});

describe("refuseLimit carries the catalog refusal code", () => {
  it("names the refusal code and a bound class in the operator error envelope", () => {
    const window = limit("autonomy.authorizationWindowMs");
    const refusal = (() => {
      try {
        refuseLimit(window, window.value + 1);
      } catch (error) {
        return error;
      }
      return undefined;
    })();
    const envelope = toOperatorErrorEnvelope(refusal);
    expect(envelope.code).toBe("autonomy-authorization-window-ms-bound");
    expect(envelope.failure).toEqual({
      class: "bound",
      layer: "cli",
      code: "autonomy-authorization-window-ms-bound",
    });
  });

  it("classifies a catalogued limit refusal as a bound with that code", () => {
    const ceiling = limit("compositionExecution.maxToolCallsPerStep");
    const refusal = (() => {
      try {
        refuseLimit(ceiling, 401);
      } catch (error) {
        return error;
      }
      return undefined;
    })();
    expect(refusal).toBeInstanceOf(OperationalLimitError);
    expect(refusal).toMatchObject({
      name: "Error",
      code: TOOL_CALL_CODE,
      limitName: "compositionExecution.maxToolCallsPerStep",
      configured: 400,
      observed: 401,
    });
    expect((refusal as Error).message).toContain(
      `${TOOL_CALL_CODE}: 401 exceeds compositionExecution.maxToolCallsPerStep = 400`,
    );
    expect(classifyThrownFailure(refusal, "workflow")).toEqual({
      class: "bound",
      layer: "workflow",
      code: TOOL_CALL_CODE,
    });
  });

  it("still reads an uncoded error as uncoded (adjacent condition)", () => {
    expect(classifyThrownFailure(new Error(`${TOOL_CALL_CODE}: 401 exceeds`), "workflow")).toEqual({
      class: "unknown",
      layer: "workflow",
      code: "uncoded-error",
    });
  });

  it("classifies limit refusals as bound except terminal host faults and pins unrecordable ones", () => {
    const refusals = [...new Set(LIMIT_DEFINITIONS.map((definition) => definition.refusal))];
    for (const code of refusals.filter(isFailureCode)) {
      expect(LIMIT_REFUSAL_CODES.has(code), code).toBe(true);
      expect(operatorCodeFailureClass(code), code).toBe(
        code === "quality-derivation-failed" ? "infrastructure" : "bound",
      );
    }
    // These break the failure-code grammar (camelCase, or too long), so a stop
    // that names one still records `uncoded-error`. Shrink this list; never grow it.
    expect(refusals.filter((code) => !isFailureCode(code)).sort()).toEqual(
      UNRECORDABLE_LIMIT_REFUSALS,
    );
  });
});

describe("output-limit finish reasons follow the telemetry normalizer", () => {
  it("names every raw token the normalizer maps to length, and no other", () => {
    for (const [token, reason] of RAW_MODEL_FINISH_REASONS) {
      expect(OUTPUT_LIMIT_FINISH_REASONS.has(token), token).toBe(
        normalizeModelFinishReason(undefined, token) === "length" && reason === "length",
      );
    }
    expect([...OUTPUT_LIMIT_FINISH_REASONS].sort()).toEqual([
      "incomplete.max_output_tokens",
      "length",
      "max_output_tokens",
      "max_tokens",
    ]);
  });

  it("classifies a max_output_tokens cut as the output limit", () => {
    expect(
      classifyInferenceAttempt({
        attempt: 1,
        outcome: "malformed-response",
        retryable: true,
        retryScheduled: false,
        turns: [governedTurn({ rawStopReason: "max_output_tokens" })],
      } as InferenceAttemptEvidence),
    ).toEqual({ class: "bound", layer: "inference", code: "output-limit-reached" });
  });
});

const UNRECORDABLE_LIMIT_REFUSALS = [
  "alerting-backup-timerIntervalHours-bound",
  "alerting-hostHealth-catalogFingerprintRefusalWarnCount-bound",
  "alerting-hostHealth-outboxBacklogWarnCount-bound",
  "alerting-journeyCheck-dedupeWindowMinutes-bound",
  "alerting-journeyCheck-digestIntervalMinutes-bound",
  "alerting-journeyCheck-docsfabStatusMaxBufferBytes-bound",
  "alerting-journeyCheck-docsfabStatusTimeoutMs-bound",
  "alerting-journeyCheck-healthzTimeoutMs-bound",
  "alerting-journeyCheck-intervalMinutes-bound",
  "alerting-journeyCheck-serviceLogTailBytes-bound",
  "alerting-journeyCheck-successRateMinAttempts-bound",
  "alerting-journeyCheck-successRateWarnRatio-bound",
  "composition-execution-answer-now-elapsed-share-basis-points-bound",
  "feedback-git-blobBytes-bound",
  "feedback-git-commandOutputBytes-bound",
  "host-dispatcher-attemptEvidenceMaxBytes-bound",
  "host-dispatcher-attemptEvidenceReasonCharacters-bound",
  "host-dispatcher-attemptEvidenceRetainedBytes-bound",
  "host-dispatcher-attemptEvidenceRetentionDays-bound",
  "host-dispatcher-classQuantum-bound",
  "host-dispatcher-interactiveReservation-bound",
  "host-dispatcher-pollIntervalMs-bound",
  "host-dispatcher-postgresConnections-invalid",
  "host-dispatcher-privateGitIndexBytes-bound",
  "host-dispatcher-privateGitLinkBytes-bound",
  "host-dispatcher-shutdownGraceMs-bound",
  "host-dispatcher-statusBytes-bound",
  "host-dispatcher-statusClockSkewMs-bound",
  "host-dispatcher-statusFreshnessMs-bound",
  "host-dispatcher-stderrBytes-bound",
  "host-dispatcher-stderrDrainMs-bound",
  "host-dispatcher-stderrExcerptBytes-bound",
  "host-dispatcher-terminateGraceMs-bound",
  "host-dispatcher-workerCountRepresentation-bound",
  "host-dispatcher-writableTreeEntries-bound",
  "host-ingress-healthFreshnessSeconds-invalid",
  "host-ingress-healthPollMs-invalid",
  "host-ingress-httpBodyBytes-invalid",
  "host-ingress-httpCloseMs-invalid",
  "host-ingress-httpHeadersCount-invalid",
  "host-ingress-httpHeadersMs-invalid",
  "host-ingress-httpKeepAliveMs-invalid",
  "host-ingress-httpRequestMs-invalid",
  "host-ingress-httpStartupCloseMs-invalid",
  "host-ingress-slackCredentialTtlMs-invalid",
  "semantic-jobPollIntervalMs-bound",
];
