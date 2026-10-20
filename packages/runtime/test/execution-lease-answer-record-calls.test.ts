// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { limit } from "../src/config/limits.js";
import {
  createExecutionChargeableAttemptPolicy,
  createExecutionLeaseCoordinatorPolicy,
  createExecutionProgressObservation,
  createExecutionLeaseRecord,
  parseExecutionLeaseRecord,
  prepareExecutionLeaseCoordinator,
  reduceExecutionLeaseCoordinator,
  serializeExecutionLeaseRecord,
  type ExecutionLeaseCoordinatorV1,
  type ExecutionToolBatchCallV1,
} from "../src/execution/index.js";
import { executionLeaseChargeableAttemptCeiling } from "../src/execution/lease-contracts.js";
import { OUTPUT_RECORD_CONTRACTS } from "../src/contracts/model-output.js";
import { planAnswerRecords } from "../src/harness/answer-records.js";
import { QUALITY_ANSWER_RECORD_TOOL_NAME } from "../src/harness/answer-submission.js";
import { createPiExecutionLeaseController } from "../src/harness/pi-offline.js";
import type { PiExecutionLeaseController } from "../src/harness/pi-lease.js";
import {
  fixtureCompositionExecutionProfile,
  namedLimitDefinition,
  stepInput,
} from "./support/pi-harness-session-fixtures.js";

const digest = (character: string) => character.repeat(64);
const context = {
  status: "ready" as const,
  availableInputTokens: 100_000,
  requiredInputTokens: 1,
  authoritySha256: digest("c"),
};
const pricing = {
  status: "known" as const,
  inputMicrousdPerMillionTokens: 100,
  outputMicrousdPerMillionTokens: 200,
  authoritySha256: digest("d"),
};

function finitePolicy(controller: PiExecutionLeaseController) {
  const policy = controller.coordinator.policy;
  if (policy.schemaVersion !== 1) {
    throw new Error("finite answer-record fixture requires a V1 policy");
  }
  return policy;
}

function policy(readingCeiling: number, answerRecordCallCeiling: number, maxProviderTurns = 16) {
  return createExecutionLeaseCoordinatorPolicy({
    maxCompactions: 4,
    providerLimits: { maxProviderTurns, maxCompactions: 4 },
    answerRecordCallCeiling,
    workflowOverrides: {
      callsPerLease: 80,
      hardToolCallCeiling: readingCeiling,
    },
    cumulative: {
      maxInputTokens: 1_000_000,
      maxOutputTokens: 1_000_000,
      maxElapsedMs: 1_000_000,
    },
  });
}

function prepared(readingCeiling: number, recordCeiling: number, maxProviderTurns = 16) {
  const leasePolicy = policy(readingCeiling, recordCeiling, maxProviderTurns);
  return prepareExecutionLeaseCoordinator({
    policy: leasePolicy,
    chargeableAttemptPolicy: createExecutionChargeableAttemptPolicy({
      maxChargeableAttempts: executionLeaseChargeableAttemptCeiling(leasePolicy),
    }),
    identity: {
      inferenceAttempt: 1,
      retriesConsumed: 0,
      authorizationSha256: digest("a"),
      repositoryRevision: "b".repeat(40),
      contextPacketSha256: digest("e"),
      evidenceSha256: digest("f"),
      toolPolicySha256: digest("1"),
      contextAuthoritySha256: context.authoritySha256,
    },
    pricing,
    context,
  }).coordinator;
}

function qualityProfileRecordCallCeiling(): number {
  const profile = JSON.parse(
    readFileSync(
      resolve(
        import.meta.dirname,
        "../../../packages/quality/profiles/docsfab-documentation-quality/profile.json",
      ),
      "utf8",
    ),
  ) as {
    applicability: {
      documentation_set: { required_dimensions_by_layer: Record<string, string[]> };
    };
    constraints: { required: string[]; conditional: string[] };
  };
  const dimensionsByLayer = profile.applicability.documentation_set.required_dimensions_by_layer;
  const constraintKeys = [...profile.constraints.required, ...profile.constraints.conditional];
  const member = (key: string) => key.replaceAll("-", "_");
  return planAnswerRecords({
    declaration: OUTPUT_RECORD_CONTRACTS["quality-evaluation"],
    skeletons: {
      dimensions: Object.entries(dimensionsByLayer).flatMap(([layer, keys]) =>
        keys.map((key) => ({ key, slot: layer })),
      ),
      constraints: constraintKeys.map((key) => ({ key, slot: member(key) })),
      layers: Object.keys(dimensionsByLayer).map((key) => ({ key, slot: key })),
    },
    selectors: { required: profile.constraints.required.map(member) },
  }).recordCallCeiling;
}

function call(index: number, scope: "reading" | "answer-record"): ExecutionToolBatchCallV1 {
  return {
    callSha256: index.toString(16).padStart(64, "0"),
    authorization: "execute",
    scope,
  };
}

function envelope(toolCalls: number) {
  return {
    toolCalls,
    providerTurns: 1,
    compactions: 0,
    inputTokens: 1,
    outputTokens: 1,
    elapsedMs: 1,
    contextInputTokens: 1,
  };
}

function emptyEnvelope() {
  return {
    toolCalls: 0,
    providerTurns: 0,
    compactions: 0,
    inputTokens: 0,
    outputTokens: 0,
    elapsedMs: 0,
    contextInputTokens: 0,
  };
}

function reduce(
  coordinator: ExecutionLeaseCoordinatorV1,
  command: Parameters<typeof reduceExecutionLeaseCoordinator>[0]["command"],
) {
  try {
    return reduceExecutionLeaseCoordinator({
      coordinator,
      expectedCoordinatorSha256: coordinator.coordinatorSha256,
      command,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `transition ${command.kind} from ${coordinator.phase} (lease ${coordinator.state.leaseNumber}, provider turns ${coordinator.state.providerTurns}) failed: ${detail}`,
    );
  }
}

function settle(
  coordinator: ExecutionLeaseCoordinatorV1,
  calls: ExecutionToolBatchCallV1[],
): ExecutionLeaseCoordinatorV1 {
  const requested = reduce(coordinator, {
    kind: "request-tool-batch",
    calls,
    envelope: envelope(calls.length),
  });
  const authorized = calls.slice(0, requested.decision.authorizedToolCalls);
  if (authorized.length === 0) return requested.coordinator;
  const observation = createExecutionProgressObservation({
    sequence: (coordinator.lastObservation?.sequence ?? 0) + 1,
    providerTurns: coordinator.state.providerTurns + 1,
    compactions: coordinator.state.compactions,
    cumulativeInputTokens: coordinator.state.cumulativeInputTokens + 1,
    cumulativeOutputTokens: coordinator.state.cumulativeOutputTokens + 1,
    elapsedMs: coordinator.state.elapsedMs + 1,
    context,
  });
  return reduce(requested.coordinator, {
    kind: "settle-tool-batch",
    results: authorized.map(({ callSha256 }) => ({ callSha256, outcome: "succeeded" })),
    observation,
  }).coordinator;
}

function observeTurn(coordinator: ExecutionLeaseCoordinatorV1): ExecutionLeaseCoordinatorV1 {
  const observation = createExecutionProgressObservation({
    sequence: (coordinator.lastObservation?.sequence ?? 0) + 1,
    providerTurns: coordinator.state.providerTurns + 1,
    compactions: coordinator.state.compactions,
    cumulativeInputTokens: coordinator.state.cumulativeInputTokens + 1,
    cumulativeOutputTokens: coordinator.state.cumulativeOutputTokens + 1,
    elapsedMs: coordinator.state.elapsedMs + 1,
    context,
  });
  return reduce(coordinator, { kind: "observe-provider-turn", observation }).coordinator;
}

describe("independent answer-record and reading lease counters", () => {
  it("derives default record-mode lease shapes at 16 and 128 provider turns", () => {
    for (const [maxProviderTurns, answerRecordCallCeiling] of [
      [16, 240],
      [128, 240],
    ] as const) {
      const resolved = createExecutionLeaseCoordinatorPolicy({
        maxCompactions: 4,
        providerLimits: { maxProviderTurns, maxCompactions: 4 },
        answerRecordCallCeiling,
        cumulative: {
          maxInputTokens: 1_000_000,
          maxOutputTokens: 1_000_000,
          maxElapsedMs: 1_000_000,
        },
      });
      expect(resolved.maxProviderTurns).toBe(maxProviderTurns);
      expect(resolved.answerRecordCallCeiling).toBe(answerRecordCallCeiling);
      if (maxProviderTurns === 16) {
        expect(resolved).toMatchObject({ hardToolCallCeiling: 13, maxLeases: 3 });
      } else {
        expect(resolved).toMatchObject({ hardToolCallCeiling: 124, maxLeases: 4 });
      }
      expect(resolved.hardToolCallCeiling + resolved.maxLeases).toBeLessThanOrEqual(
        resolved.maxProviderTurns,
      );
      expect(resolved.hardToolCallCeiling + resolved.answerRecordCallCeiling!).toBeLessThanOrEqual(
        resolved.callsPerLease * resolved.maxLeases,
      );
    }
  });

  it("rejects explicit scopes that cannot fit the full record and reading budgets", () => {
    const base = {
      maxCompactions: 4,
      providerLimits: { maxProviderTurns: 16, maxCompactions: 4 },
      answerRecordCallCeiling: 240,
      cumulative: {
        maxInputTokens: 1_000_000,
        maxOutputTokens: 1_000_000,
        maxElapsedMs: 1_000_000,
      },
    } as const;

    // Three lease turns leave at most thirteen ordinary reading turns. An
    // explicit larger read ceiling must refuse instead of being silently fit.
    expect(() =>
      createExecutionLeaseCoordinatorPolicy({
        ...base,
        workflowOverrides: { hardToolCallCeiling: 14 },
      }),
    ).toThrow();
    // Two leases cannot carry all 240 plan-derived record calls at 100 calls
    // per lease, even before reserving a reading capacity.
    expect(() =>
      createExecutionLeaseCoordinatorPolicy({
        ...base,
        workflowOverrides: { maxLeases: 2 },
      }),
    ).toThrow();
  });

  it("fits a lower calls-per-lease override without clipping the record ceiling", () => {
    const resolved = createExecutionLeaseCoordinatorPolicy({
      maxCompactions: 4,
      providerLimits: { maxProviderTurns: 16, maxCompactions: 4 },
      answerRecordCallCeiling: 240,
      workflowOverrides: { callsPerLease: 80 },
      cumulative: {
        maxInputTokens: 1_000_000,
        maxOutputTokens: 1_000_000,
        maxElapsedMs: 1_000_000,
      },
    });

    expect(resolved).toMatchObject({
      answerRecordCallCeiling: 240,
      callsPerLease: 80,
      hardToolCallCeiling: 12,
      maxLeases: 4,
    });
    expect(resolved.hardToolCallCeiling + resolved.maxLeases).toBeLessThanOrEqual(16);
    expect(resolved.hardToolCallCeiling + resolved.answerRecordCallCeiling!).toBeLessThanOrEqual(
      resolved.callsPerLease * resolved.maxLeases,
    );
  });

  it("keeps serialized lease shape unchanged when answer-record mode is absent", () => {
    const regularPolicy = createExecutionLeaseCoordinatorPolicy({
      maxCompactions: 4,
      providerLimits: { maxProviderTurns: 16, maxCompactions: 4 },
      cumulative: {
        maxInputTokens: 1_000_000,
        maxOutputTokens: 1_000_000,
        maxElapsedMs: 1_000_000,
      },
    });
    const ordinary = prepareExecutionLeaseCoordinator({
      policy: regularPolicy,
      chargeableAttemptPolicy: createExecutionChargeableAttemptPolicy({
        maxChargeableAttempts: executionLeaseChargeableAttemptCeiling(regularPolicy),
      }),
      identity: {
        inferenceAttempt: 1,
        retriesConsumed: 0,
        authorizationSha256: digest("a"),
        repositoryRevision: "b".repeat(40),
        contextPacketSha256: digest("e"),
        evidenceSha256: digest("f"),
        toolPolicySha256: digest("1"),
        contextAuthoritySha256: context.authoritySha256,
      },
      pricing,
      context,
    }).coordinator;
    const record = createExecutionLeaseRecord({
      policy: ordinary.policy,
      identity: ordinary.identity,
      initialState: ordinary.initialState,
      checkpoints: [],
      decisions: [],
      finalState: ordinary.state,
    });
    const serialized = serializeExecutionLeaseRecord(record);
    const roundtrip = parseExecutionLeaseRecord(serialized);

    expect(roundtrip).toEqual(record);
    expect(JSON.parse(serialized).policy).not.toHaveProperty("answerRecordCallCeiling");
    expect(JSON.parse(serialized).finalState).not.toHaveProperty("toolCallsByScope");
    expect(JSON.parse(serialized).finalState).not.toHaveProperty("answerRecordCallsAdmitted");
  });

  it("authorizes a mixed ordered prefix under each scope cap and leaves the other scope usable", () => {
    let coordinator = prepared(8, 2);
    coordinator = settle(coordinator, [
      call(1, "reading"),
      call(2, "answer-record"),
      call(3, "answer-record"),
      call(4, "answer-record"),
    ]);
    expect(coordinator.state.toolCallsByScope).toEqual({ reading: 1, answerRecord: 2 });
    expect(coordinator.state.answerRecordCallsAdmitted).toBe(2);
    expect(coordinator.state.toolCalls.governanceBlocked).toBe(1);

    // The answer-record scope is exhausted, but the read scope still admits work.
    coordinator = settle(coordinator, [call(5, "reading")]);
    expect(coordinator.state.toolCallsByScope).toEqual({ reading: 2, answerRecord: 2 });
    expect(coordinator.state.answerRecordCallsAdmitted).toBe(2);

    // Exhausting reads does not charge grouped record calls to the read ceiling.
    coordinator = settle(
      coordinator,
      Array.from({ length: 6 }, (_, index) => call(index + 6, "reading")),
    );
    expect(coordinator.state.toolCallsByScope).toEqual({ reading: 8, answerRecord: 2 });
    expect(coordinator.phase).toBe("checkpoint-required");
  });

  it("shares the configured aggregate tool pool across reading and discovery record calls", () => {
    const sharedPolicy = createExecutionLeaseCoordinatorPolicy({
      maxCompactions: 4,
      providerLimits: { maxProviderTurns: 8, maxCompactions: 4 },
      answerRecordCallCeiling: 400,
      sharedToolCallCapacity: true,
      compositionOverrides: { callsPerLease: 400 },
      cumulative: {
        maxInputTokens: 1_000_000,
        maxOutputTokens: 1_000_000,
        maxElapsedMs: 1_000_000,
      },
    });
    let coordinator = prepareExecutionLeaseCoordinator({
      policy: sharedPolicy,
      chargeableAttemptPolicy: createExecutionChargeableAttemptPolicy({
        maxChargeableAttempts: executionLeaseChargeableAttemptCeiling(sharedPolicy),
      }),
      identity: {
        inferenceAttempt: 1,
        retriesConsumed: 0,
        authorizationSha256: digest("a"),
        repositoryRevision: "b".repeat(40),
        contextPacketSha256: digest("e"),
        evidenceSha256: digest("f"),
        toolPolicySha256: digest("1"),
        contextAuthoritySha256: context.authoritySha256,
      },
      pricing,
      context,
    }).coordinator;

    expect(executionLeaseChargeableAttemptCeiling(sharedPolicy)).toBe(400);
    const mixedCalls = [
      ...Array.from({ length: 300 }, (_, index) => call(index + 1, "answer-record")),
      ...Array.from({ length: 100 }, (_, index) => call(index + 301, "reading")),
    ];
    coordinator = settle(coordinator, mixedCalls);
    expect(coordinator.state.toolCallsByScope).toEqual({ reading: 100, answerRecord: 300 });
    expect(coordinator.state.answerRecordCallsAdmitted).toBe(300);
    expect(coordinator.state.providerTurns).toBeLessThan(
      coordinator.state.toolCallsByScope!.reading +
        coordinator.state.toolCallsByScope!.answerRecord,
    );
    expect(coordinator.policy.sharedToolCallCapacity).toBe(true);

    const denied = reduce(coordinator, {
      kind: "renew",
      nextTranche: envelope(1),
    });
    expect(denied.decision.decision).toBe("denied");
    expect(denied.decision.reason).toBe("hard-tool-call-ceiling");
  });

  it("derives the shared pool from lowered calls-per-lease and lease-count bounds", () => {
    const lowered = createExecutionLeaseCoordinatorPolicy({
      maxCompactions: 4,
      providerLimits: { maxProviderTurns: 16, maxCompactions: 4 },
      answerRecordCallCeiling: 400,
      sharedToolCallCapacity: true,
      workflowOverrides: { callsPerLease: 50, maxLeases: 2 },
      cumulative: {
        maxInputTokens: 1_000_000,
        maxOutputTokens: 1_000_000,
        maxElapsedMs: 1_000_000,
      },
    });

    expect(lowered).toMatchObject({
      callsPerLease: 50,
      maxLeases: 2,
      hardToolCallCeiling: 100,
      answerRecordCallCeiling: 400,
      sharedToolCallCapacity: true,
    });
    expect(executionLeaseChargeableAttemptCeiling(lowered)).toBe(100);
  });

  it("keeps record allowance usable after the reading scope is exhausted", () => {
    let coordinator = prepared(1, 2);
    coordinator = settle(coordinator, [call(101, "reading")]);
    coordinator = settle(coordinator, [call(102, "reading")]);
    expect(coordinator.state.toolCallsByScope).toEqual({ reading: 1, answerRecord: 0 });
    expect(coordinator.state.answerRecordCallsAdmitted).toBe(0);
    expect(coordinator.phase).toBe("active");

    coordinator = settle(coordinator, [call(103, "answer-record"), call(104, "answer-record")]);
    expect(coordinator.state.toolCallsByScope).toEqual({ reading: 1, answerRecord: 2 });
    expect(coordinator.state.answerRecordCallsAdmitted).toBe(2);
  });

  it("charges a denied call and drained authorized suffix to the admitted record ceiling", () => {
    const coordinator = prepared(8, 4);
    const calls = [
      call(151, "answer-record"),
      call(152, "answer-record"),
      call(153, "answer-record"),
    ];
    const requested = reduce(coordinator, {
      kind: "request-tool-batch",
      calls,
      envelope: envelope(calls.length),
    });
    expect(requested.decision.authorizedToolCalls).toBe(3);
    const observation = createExecutionProgressObservation({
      sequence: 1,
      providerTurns: 1,
      compactions: 0,
      cumulativeInputTokens: 1,
      cumulativeOutputTokens: 1,
      elapsedMs: 1,
      context,
    });
    const failed = reduce(requested.coordinator, {
      kind: "fail-tool-batch",
      reason: "provider-terminal",
      results: [{ callSha256: calls[0]!.callSha256, outcome: "failed" }],
      lateDeniedCallSha256: calls[1]!.callSha256,
      observation,
    }).coordinator;

    expect(failed.state.toolCallsByScope).toEqual({ reading: 0, answerRecord: 1 });
    expect(failed.state.answerRecordCallsAdmitted).toBe(3);
    expect(failed.state.toolCalls).toMatchObject({
      executed: 1,
      failed: 1,
      denied: 1,
      governanceBlocked: 1,
    });
    expect(failed.phase).toBe("terminal");
    expect(failed.terminalReason).toBe("provider-terminal");
  });

  it("replays denied-call ceiling and exact renewed lease grant", () => {
    const smallAttemptLimit = 2;
    // Use the raw identity input shape accepted by prepare; the sealed identity
    // also contains digest fields and must not be passed back as construction input.
    const leasePolicy = policy(8, 36);
    let denied = prepareExecutionLeaseCoordinator({
      policy: leasePolicy,
      chargeableAttemptPolicy: createExecutionChargeableAttemptPolicy({
        maxChargeableAttempts: smallAttemptLimit,
      }),
      identity: {
        inferenceAttempt: 1,
        retriesConsumed: 0,
        authorizationSha256: digest("a"),
        repositoryRevision: "b".repeat(40),
        contextPacketSha256: digest("e"),
        evidenceSha256: digest("f"),
        toolPolicySha256: digest("1"),
        contextAuthoritySha256: context.authoritySha256,
      },
      pricing,
      context,
    }).coordinator;
    for (const index of [201, 202]) {
      const result = reduce(denied, {
        kind: "request-tool-batch",
        calls: [{ ...call(index, "reading"), authorization: "denied" }],
        envelope: emptyEnvelope(),
      });
      denied = result.coordinator;
    }
    expect(denied).toMatchObject({
      phase: "checkpoint-required",
      state: { toolCalls: { executed: 0, denied: 2 } },
      checkpointRequest: { stopReasons: ["hard-tool-call-ceiling"] },
    });
    const denial = reduce(denied, { kind: "renew", nextTranche: envelope(1) });
    expect(denial.decision).toMatchObject({
      decision: "denied",
      reason: "hard-tool-call-ceiling",
    });
    denied = denial.coordinator;
    expect(denied).toMatchObject({
      phase: "terminal",
      terminalReason: "hard-tool-call-ceiling",
    });
    const denialRecord = createExecutionLeaseRecord({
      policy: denied.policy,
      identity: denied.identity,
      initialState: denied.initialState,
      checkpoints: denied.checkpoints,
      decisions: denied.decisions,
      finalState: denied.state,
      chargeableAttemptCeiling: smallAttemptLimit,
      terminalReason: denied.terminalReason!,
    });
    expect(
      parseExecutionLeaseRecord(serializeExecutionLeaseRecord(denialRecord)).terminalReason,
    ).toBe("hard-tool-call-ceiling");

    // On a later lease, the turn-fit may grant fewer calls than the maximum
    // implied by scope headroom. The sealed per-lease grant is the renewal
    // criterion; it must survive state validation and settlement.
    let renewed = prepared(8, 100, 20);
    for (let turn = 0; turn < 15; turn += 1) renewed = observeTurn(renewed);
    renewed = settle(
      renewed,
      Array.from({ length: 80 }, (_, index) => call(index + 300, "answer-record")),
    );
    expect(renewed.phase).toBe("checkpoint-required");
    const checkpointObservation = createExecutionProgressObservation({
      sequence: (renewed.lastObservation?.sequence ?? 0) + 1,
      providerTurns: renewed.state.providerTurns + 1,
      compactions: renewed.state.compactions,
      cumulativeInputTokens: renewed.state.cumulativeInputTokens + 1,
      cumulativeOutputTokens: renewed.state.cumulativeOutputTokens + 1,
      elapsedMs: renewed.state.elapsedMs + 1,
      context,
    });
    renewed = reduce(renewed, {
      kind: "observe-checkpoint-turn",
      observation: checkpointObservation,
    }).coordinator;
    const decision = reduce(renewed, {
      kind: "renew",
      nextTranche: envelope(22),
    });
    expect(decision.decision).toMatchObject({ decision: "renewed", remainingLeaseToolCalls: 22 });
    expect(decision.coordinator.decisions.at(-1)).toMatchObject({
      decision: "granted",
      grantedToolCalls: 22,
    });
    renewed = decision.coordinator;
    expect(renewed.state.leaseToolCallAllowance).toBe(22);
    renewed = settle(renewed, [
      ...Array.from({ length: 20 }, (_, index) => call(index + 400, "answer-record")),
      call(500, "reading"),
      call(501, "reading"),
    ]);
    expect(renewed.state.leaseExecutedToolCalls).toBe(22);
    expect(renewed.state.leaseToolCallAllowance).toBe(22);
  });

  it("tracks 36 grouped record calls separately from the 8-call reading counter", () => {
    let coordinator = prepared(8, 36);
    let nextId = 1;
    // Fifteen grouped tool turns leave the sixteenth provider turn for the
    // ordinary final answer; this fixture asserts only separated counters.
    for (let turn = 0; turn < 15; turn += 1) {
      const count = turn < 13 ? 2 : 5;
      coordinator = settle(
        coordinator,
        Array.from({ length: count }, () => call(nextId++, "answer-record")),
      );
    }
    expect(coordinator.state.providerTurns).toBe(15);
    expect(coordinator.state.toolCallsByScope).toEqual({ reading: 0, answerRecord: 36 });
    expect(coordinator.state.answerRecordCallsAdmitted).toBe(36);
    expect(coordinator.state.toolCalls.executed).toBe(36);
  });

  it.each([16, 128])(
    "passes the actual profile plan cap through Pi at %i composition turns",
    (maxProviderTurns) => {
      const answerRecordCallCeiling = qualityProfileRecordCallCeiling();
      const executionProfile = fixtureCompositionExecutionProfile({
        maxProviderTurns,
        timeoutMs: 60_000,
        maxResponseBytes: 65_536,
      });
      const controller = createPiExecutionLeaseController(
        {
          ...stepInput("/private/tmp"),
          qualityAnswerRecordCallCeiling: answerRecordCallCeiling,
        },
        executionProfile,
        ["read", QUALITY_ANSWER_RECORD_TOOL_NAME],
      );
      const leasePolicy = finitePolicy(controller);

      expect(leasePolicy.answerRecordCallCeiling).toBe(answerRecordCallCeiling);
      expect(leasePolicy.maxProviderTurns).toBe(maxProviderTurns);
      expect(leasePolicy.hardToolCallCeiling).toBe(maxProviderTurns === 16 ? 13 : 124);
      expect(leasePolicy.maxLeases).toBe(maxProviderTurns === 16 ? 3 : 4);
    },
  );

  it("retains a reduced host reading cap while fitting the same profile plan", () => {
    const answerRecordCallCeiling = qualityProfileRecordCallCeiling();
    const readingLimit = namedLimitDefinition("compositionExecution.maxToolCallsPerStep");
    const maxLeasesLimit = namedLimitDefinition("compositionExecution.maxLeases");
    const executionProfile = fixtureCompositionExecutionProfile({
      maxProviderTurns: 16,
      timeoutMs: 60_000,
      maxResponseBytes: 65_536,
    });
    const controller = createPiExecutionLeaseController(
      {
        ...stepInput("/private/tmp"),
        qualityAnswerRecordCallCeiling: answerRecordCallCeiling,
      },
      executionProfile,
      ["read", QUALITY_ANSWER_RECORD_TOOL_NAME],
      { environment: { [readingLimit.override!]: "10" } },
    );
    const leasePolicy = finitePolicy(controller);

    expect(
      limit(readingLimit.name, { environment: { [readingLimit.override!]: "10" } }),
    ).toMatchObject({
      value: 10,
      source: "host",
    });
    expect(leasePolicy.hardToolCallCeiling).toBe(10);
    expect(leasePolicy.answerRecordCallCeiling).toBe(answerRecordCallCeiling);
    expect(leasePolicy.maxLeases).toBe(3);

    expect(() =>
      createPiExecutionLeaseController(
        {
          ...stepInput("/private/tmp"),
          qualityAnswerRecordCallCeiling: answerRecordCallCeiling,
        },
        executionProfile,
        ["read", QUALITY_ANSWER_RECORD_TOOL_NAME],
        { environment: { [maxLeasesLimit.override!]: "2" } },
      ),
    ).toThrow();
  });

  it("fits the host calls-per-lease override without reducing the profile cap", () => {
    const answerRecordCallCeiling = qualityProfileRecordCallCeiling();
    const callsLimit = namedLimitDefinition("compositionExecution.callsPerLease");
    const executionProfile = fixtureCompositionExecutionProfile({
      maxProviderTurns: 16,
      timeoutMs: 60_000,
      maxResponseBytes: 65_536,
    });
    const environment = { [callsLimit.override!]: "80" };
    const controller = createPiExecutionLeaseController(
      {
        ...stepInput("/private/tmp"),
        qualityAnswerRecordCallCeiling: answerRecordCallCeiling,
      },
      executionProfile,
      ["read", QUALITY_ANSWER_RECORD_TOOL_NAME],
      { environment },
    );
    const leasePolicy = finitePolicy(controller);

    expect(limit(callsLimit.name, { environment })).toMatchObject({
      value: 80,
      source: "host",
    });
    expect(leasePolicy.callsPerLease).toBe(80);
    expect(leasePolicy.answerRecordCallCeiling).toBe(answerRecordCallCeiling);
    expect(leasePolicy.hardToolCallCeiling).toBe(12);
    expect(leasePolicy.maxLeases).toBe(4);
  });

  it("refuses a host aggregate override even when its value equals the catalog default", () => {
    const definition = namedLimitDefinition("compositionExecution.maxToolCallsPerStep");
    const environment = { [definition.override!]: String(definition.value) };
    const limits = { environment, hostFile: null, projectFile: null };
    expect(limit(definition.name, limits)).toMatchObject({
      value: definition.value,
      source: "host",
    });

    expect(() =>
      createPiExecutionLeaseController(
        {
          ...stepInput("/private/tmp"),
          experimentalAnswerRecordDiscoveryRenewal: true,
        },
        fixtureCompositionExecutionProfile({
          maxProviderTurns: 16,
          timeoutMs: 60_000,
          maxResponseBytes: 65_536,
        }),
        ["read"],
        limits,
      ),
    ).toThrow("compositionExecution.maxToolCallsPerStep (host)");
  });

  it("refuses composition-only aggregate overrides on the composition path", () => {
    const definition = namedLimitDefinition("compositionExecution.maxProviderTurns");
    const environment = { [definition.override!]: String(definition.value) };
    const limits = { environment, hostFile: null, projectFile: null };
    expect(() =>
      createPiExecutionLeaseController(
        {
          ...stepInput("/private/tmp"),
          experimentalAnswerRecordDiscoveryRenewal: true,
        },
        fixtureCompositionExecutionProfile({
          maxProviderTurns: 16,
          timeoutMs: 60_000,
          maxResponseBytes: 65_536,
        }),
        ["read"],
        limits,
      ),
    ).toThrow("compositionExecution.maxProviderTurns (host)");
  });

  it("keeps project policy from overriding a per-run aggregate dimension", () => {
    const definition = namedLimitDefinition("compositionExecution.maxCumulativeOutputTokens");
    const directory = mkdtempSync(join(tmpdir(), "docsfab-discovery-override-"));
    try {
      const projectFile = join(directory, "limits.yaml");
      writeFileSync(projectFile, `${definition.name}: ${definition.value - 1}\n`, "utf8");
      const limits = { environment: {}, hostFile: null, projectFile };
      expect(() => limit(definition.name, limits)).toThrow(/project.*per-project/i);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps absent defaults when only per-request, lease-cadence, or other-lane limits are explicit", () => {
    const unrelated = [
      namedLimitDefinition("compositionExecution.callsPerLease"),
      namedLimitDefinition("compositionExecution.maxResponseBytes"),
    ];
    const environment = Object.fromEntries(
      unrelated.map((definition) => [definition.override!, String(definition.value)]),
    );
    const limits = { environment, hostFile: null, projectFile: null };
    for (const definition of unrelated) {
      expect(limit(definition.name, limits).source).toBe("host");
    }

    const controller = createPiExecutionLeaseController(
      {
        ...stepInput("/private/tmp"),
        experimentalAnswerRecordDiscoveryRenewal: true,
      },
      fixtureCompositionExecutionProfile({
        maxProviderTurns: 16,
        timeoutMs: 60_000,
        maxResponseBytes: 65_536,
      }),
      ["read"],
      limits,
    );
    expect(controller.coordinator.policy).toMatchObject({
      schemaVersion: 2,
      aggregatePolicy: { kind: "absent" },
    });
  });

  it("ignores a composition-only override on the uncomposed discovery path", () => {
    const definition = namedLimitDefinition("compositionExecution.maxProviderTurns");
    const environment = { [definition.override!]: String(definition.value) };
    const limits = { environment, hostFile: null, projectFile: null };
    const { compositionPolicy: _compositionPolicy, ...uncomposedProfile } =
      fixtureCompositionExecutionProfile({
        maxProviderTurns: 16,
        timeoutMs: 60_000,
        maxResponseBytes: 65_536,
      });

    expect(() =>
      createPiExecutionLeaseController(
        {
          ...stepInput("/private/tmp"),
          experimentalAnswerRecordDiscoveryRenewal: true,
        },
        uncomposedProfile,
        ["read"],
        limits,
      ),
    ).not.toThrow();
  });
});
