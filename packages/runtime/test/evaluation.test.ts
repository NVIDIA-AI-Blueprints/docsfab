// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { RunRecord } from "../src/records/contracts.js";
import {
  evaluateRuns,
  loadEvaluationFixture,
  loadRunRecord,
  parseEvaluationFixture,
} from "../src/quality-evaluation/structural.js";
import { governProviderTurn } from "../src/model/turn-governor.js";
import { listCatalogWorkflows } from "../src/workflow-registry/catalog.js";

function record(id: string, status: RunRecord["status"] = "succeeded"): RunRecord {
  return {
    schemaVersion: 2,
    id,
    workflow: "readiness",
    repository: {
      sourcePath: "/fixture",
      requestedRevision: "HEAD",
      revision: "abc123",
    },
    workspace: { strategy: "tracked-export", disposable: true },
    status,
    createdAt: "2026-08-01T00:00:00.000Z",
    models: [],
    skills: [],
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
      turns: 0,
    },
    tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
    steps: [
      {
        id: "readiness",
        title: "Readiness",
        skill: "doc-context-analyzer",
        mode: "read-only",
        status: status === "succeeded" ? "succeeded" : "failed",
        summary: status === "succeeded" ? "Evidence-backed result" : undefined,
      },
    ],
  };
}

function withTools(value: RunRecord, tools: string[]): RunRecord {
  const byTool = tools.map((name, index) => ({
    name,
    calls: index + 1,
    failures: 0,
  }));
  return {
    ...value,
    tools: {
      totalCalls: byTool.reduce((total, tool) => total + tool.calls, 0),
      failedCalls: 0,
      byTool,
    },
    steps: value.steps.map((step) => ({
      ...step,
      tools: {
        totalCalls: byTool.reduce((total, tool) => total + tool.calls, 0),
        failedCalls: 0,
        byTool,
      },
    })),
  };
}

function withGovernedSkill(value: RunRecord): RunRecord {
  const evidence = {
    id: "doc-context-analyzer",
    contentSha256: "a".repeat(64),
    bundleSha256: "b".repeat(64),
    version: "1.0.0",
    license: "Apache-2.0",
    source: {
      repository: "https://example.test/skills.git",
      revision: "abc123",
      path: "skills/doc-context-analyzer/SKILL.md",
    },
    inputs: [{ name: "repository", description: "Selected repository" }],
    outputs: [{ name: "summary", description: "Readiness summary" }],
    toolPolicy: {
      declared: ["read", "grep"],
      granted: ["read", "grep"],
      withheld: [],
    },
  };
  return {
    ...value,
    skills: [evidence],
    steps: value.steps.map((step) => ({ ...step, skillEvidence: evidence })),
  };
}

function withTurnGovernance(value: RunRecord): RunRecord {
  const packetDigest = "d".repeat(64);
  const identity = {
    repositoryRevision: value.repository.revision,
    contextPacketDigest: packetDigest,
    consultedNodeIds: ["node-a"],
  };
  const evidenceDigest = createHash("sha256")
    .update(JSON.stringify(identity, Object.keys(identity).sort()))
    .digest("hex");
  return {
    ...value,
    usage: { ...value.usage, turns: 1 },
    steps: value.steps.map((step) => {
      const tools = step.tools
        ? structuredClone(step.tools)
        : { totalCalls: 0, failedCalls: 0, byTool: [] };
      return {
        ...step,
        ...(step.tools ? {} : { tools }),
        contextPreflight: {
          status: "ready" as const,
          packetDigest,
          consultedNodeIds: ["node-a"],
        },
        inference: {
          configuredMaxRetries: 0,
          effectiveMaxRetries: 0,
          baseDelayMs: 1_000,
          maxDelayMs: 2_000,
          retryableCategories: ["timeout" as const],
          replay: "read-only" as const,
          attempts: [
            {
              attempt: 1,
              outcome: "succeeded" as const,
              retryable: false,
              retryScheduled: false,
              durationMs: 10,
              tools,
              identity,
              turns: [
                {
                  turn: 1,
                  toolCalls: tools.totalCalls,
                  toolResults: tools.totalCalls,
                  maxProviderTurns: 12,
                  maxToolCalls: 12,
                  compactions: 0,
                  maxCompactions: 8,
                  configuredContextWindow: 128_000,
                  effectiveContextWindow: 8_192,
                  configuredMaxOutputTokens: 16_384,
                  effectiveMaxOutputTokens: 4_096,
                  reservedTokens: 128,
                  estimatedInputTokens: 1_000,
                  availableOutputTokens: 7_064,
                  requiredMinimumOutputTokens: 16,
                  outputTokens: 4_096,
                  decision: "proceed" as const,
                  requestDigest: "e".repeat(64),
                  evidenceDigest,
                },
              ],
            },
          ],
        },
      };
    }),
  };
}

function governedCampaignRecords(): RunRecord[] {
  return Array.from({ length: 5 }, (_, index) =>
    withTurnGovernance(withGovernedSkill(withTools(record(`governed-${index + 1}`), ["read"]))),
  );
}

function onlyAttempt(value: RunRecord) {
  return value.steps[0]!.inference!.attempts[0]!;
}

function onlyTurn(value: RunRecord) {
  return onlyAttempt(value).turns![0]!;
}

const fixture = parseEvaluationFixture({
  version: 1,
  name: "repeatability",
  assertions: [
    { type: "run-count", minimum: 2 },
    { type: "status", equals: "succeeded" },
    { type: "all-steps-succeeded" },
    { type: "summaries-present" },
    { type: "step-skills", equals: ["doc-context-analyzer"] },
  ],
});

describe("structural evaluation", () => {
  it("passes deterministic assertions across repeated records", async () => {
    const result = await evaluateRuns({
      fixture,
      records: [record("one"), record("two")],
    });

    expect(result.passed).toBe(true);
    expect(result.structural.results.every((item) => item.passed)).toBe(true);
  });

  it("reports the failing record", async () => {
    const result = await evaluateRuns({
      fixture,
      records: [record("one"), record("two", "failed")],
    });

    expect(result.passed).toBe(false);
    expect(result.structural.results.some((item) => item.recordId === "two" && !item.passed)).toBe(
      true,
    );
  });

  it("provides a judge seam after structural grading", async () => {
    let sawStructuralPass = false;
    const result = await evaluateRuns({
      fixture,
      records: [record("one"), record("two")],
      judge: {
        identity: { provider: "fake", model: "deterministic" },
        grade: async ({ evidence }) => {
          sawStructuralPass = evidence.records.length === 2;
          return { passed: true, score: 0.9, rationale: "fixture judge" };
        },
      },
    });

    expect(sawStructuralPass).toBe(true);
    expect(result.judge?.status).toBe("passed");
    expect(result.judge?.status === "passed" && result.judge.score).toBe(0.9);
  });

  it("grades the intentionally heterogeneous MVP live record pair", async () => {
    const acceptanceFixture = await loadEvaluationFixture(
      new URL("./fixtures/runtime-evaluation/fixtures/mvp-live-readiness.json", import.meta.url)
        .pathname,
    );
    const small = withTurnGovernance(withGovernedSkill(record("small")));
    small.securityScan = {
      ruleSet: "docsfab-local-v2",
      status: "passed",
      scannedFiles: 3,
      binaryFiles: 0,
      findings: [],
    };
    small.securityScanEffectiveDisposition = { status: "passed" };
    const self = withTurnGovernance(withGovernedSkill(record("self")));
    self.securityScan = {
      ruleSet: "docsfab-local-v2",
      status: "blocked",
      scannedFiles: 100,
      binaryFiles: 0,
      findings: [{ path: "fixture", ruleId: "credential.assigned-secret" }],
    };
    self.securityScanEffectiveDisposition = { status: "authorized" };
    self.securityScanAuthorization = {
      status: "authorized",
      overrides: [
        {
          ruleId: "credential.assigned-secret",
          revision: "abc123",
          reason: "Reviewed fixture",
          expiresAt: "2099-01-01T00:00:00.000Z",
          decision: "authorized",
          findingCount: 1,
        },
      ],
    };
    let calls = 0;

    const result = await evaluateRuns({
      fixture: acceptanceFixture,
      records: [small, self],
      judge: {
        identity: { provider: "fake", model: "deterministic" },
        grade: async () => {
          calls += 1;
          return { passed: true, score: 1, rationale: "accepted" };
        },
      },
    });

    expect(result.structural.passed).toBe(true);
    expect(result.judge?.status).toBe("passed");
    expect(calls).toBe(1);
  });

  it("ignores dynamic concrete tool choices when comparing record shapes", async () => {
    const shapeFixture = parseEvaluationFixture({
      version: 1,
      name: "dynamic-tools",
      assertions: [{ type: "record-shape-consistent" }],
    });

    const result = await evaluateRuns({
      fixture: shapeFixture,
      records: [
        withTools(record("with-grep"), ["read", "grep"]),
        withTools(record("without-grep"), ["read"]),
      ],
    });

    expect(result.passed).toBe(true);
  });

  it("retains field/type and stable step structure checks", async () => {
    const shapeFixture = parseEvaluationFixture({
      version: 1,
      name: "stable-shape",
      assertions: [{ type: "record-shape-consistent" }],
    });
    const changedStep = record("changed-step");
    changedStep.steps[0] = { ...changedStep.steps[0]!, id: "different-step" };

    const stepResult = await evaluateRuns({
      fixture: shapeFixture,
      records: [record("baseline"), changedStep],
    });
    expect(stepResult.passed).toBe(false);

    const changedFields = record("changed-fields");
    changedFields.usage = { ...changedFields.usage, cost: 0 };
    const fieldResult = await evaluateRuns({
      fixture: shapeFixture,
      records: [record("baseline"), changedFields],
    });
    expect(fieldResult.passed).toBe(false);
  });

  it("rejects structurally identical but invalid workflow outcomes", async () => {
    const shapeFixture = parseEvaluationFixture({
      version: 1,
      name: "workflow-outcome-shape",
      assertions: [{ type: "record-shape-consistent" }],
    });
    const records = [record("outcome-one"), record("outcome-two")];
    for (const candidate of records) {
      candidate.workflowOutcome = {
        schemaVersion: 1,
        kind: "docsfab-workflow-outcome",
        disposition: "ready",
        findings: [
          {
            id: "finding:blocking",
            kind: "product-gap",
            severity: "blocking",
            code: "blocking",
            evidenceIds: [],
          },
        ],
        evidence: [],
        limitations: [],
        openDecisions: [],
        producedArtifacts: [],
        outcomeSha256: "0".repeat(64),
      };
    }

    const result = await evaluateRuns({ fixture: shapeFixture, records });
    expect(result.passed).toBe(false);
    expect(result.structural.results[0]).toMatchObject({
      passed: false,
      message: "run evidence contains an invalid workflow outcome",
    });

    const root = await mkdtemp(join(tmpdir(), "docsfab-invalid-outcome-"));
    const path = join(root, "run.json");
    try {
      await writeFile(path, JSON.stringify(records[0]), { mode: 0o600 });
      await expect(loadRunRecord(path)).rejects.toThrow("has an invalid DocsFab workflow outcome");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("evaluates allowed, required, and forbidden tool policies separately", async () => {
    const toolFixture = parseEvaluationFixture({
      version: 1,
      name: "tool-policy",
      assertions: [
        { type: "allowed-tools", tools: ["read", "grep"] },
        { type: "required-tools", tools: ["read"] },
        { type: "forbidden-tools", tools: ["write"] },
      ],
    });

    const passing = await evaluateRuns({
      fixture: toolFixture,
      records: [withTools(record("one"), ["read", "grep"]), withTools(record("two"), ["read"])],
    });
    expect(passing.passed).toBe(true);

    const failing = await evaluateRuns({
      fixture: toolFixture,
      records: [withTools(record("three"), ["read", "write"])],
    });
    expect(failing.passed).toBe(false);
    expect(failing.structural.results.map((result) => result.passed)).toEqual([false, true, false]);
  });

  it("passes the five-run evidence pattern with independent status and provenance gates", async () => {
    const liveFixture = parseEvaluationFixture({
      version: 1,
      name: "live-readiness-pattern",
      assertions: [
        { type: "run-count", minimum: 5 },
        { type: "status", equals: "succeeded" },
        { type: "governed-skill-evidence" },
        { type: "record-shape-consistent" },
        { type: "allowed-tools", tools: ["read", "grep"] },
        { type: "required-tools", tools: ["read"] },
        { type: "forbidden-tools", tools: ["write"] },
        { type: "turn-governance-evidence" },
        { type: "evidence-identity-consistent" },
      ],
    });
    const records = Array.from({ length: 5 }, (_, index) =>
      withTurnGovernance(
        withGovernedSkill(
          withTools(record(`run-${index + 1}`), index === 0 ? ["read", "grep"] : ["read"]),
        ),
      ),
    );

    const result = await evaluateRuns({ fixture: liveFixture, records });

    expect(result.passed).toBe(true);
    expect(result.structural.results).toHaveLength(33);
  });

  it("loads the five-run turn-governance fixture and rejects missing ledgers", async () => {
    const liveFixture = await loadEvaluationFixture(
      new URL(
        "./fixtures/runtime-evaluation/fixtures/turn-governance-live-readiness.json",
        import.meta.url,
      ).pathname,
    );
    const records = governedCampaignRecords();

    const passing = await evaluateRuns({ fixture: liveFixture, records });
    expect(passing.passed).toBe(true);

    const mixed = governedCampaignRecords();
    const stopped = mixed[4]!;
    stopped.status = "failed";
    stopped.steps[0]!.status = "failed";
    delete stopped.steps[0]!.summary;
    const stoppedAttempt = onlyAttempt(stopped);
    const stop = governProviderTurn({
      context: { messages: [{ role: "user", content: "x".repeat(40_000) }] },
      policy: {
        budget: {
          configuredContextWindow: 128_000,
          effectiveContextWindow: 8_192,
          configuredMaxInputTokens: 128_000,
          effectiveMaxInputTokens: 8_192,
          configuredMaxOutputTokens: 16_384,
          effectiveMaxOutputTokens: 4_096,
          reservedTokens: 128,
          requiredMinimumOutputTokens: 16,
        },
        maxProviderTurns: 12,
        maxToolCalls: 12,
        maxCompactions: 8,
        minRecentToolTurns: 1,
      },
      state: { providerTurns: 0, toolCalls: 1, toolResults: 1, compactions: 0 },
      evidenceIdentity: stoppedAttempt.identity!,
      pinnedMessageCount: 1,
    });
    stoppedAttempt.outcome = "context-exhausted";
    stoppedAttempt.retryable = false;
    stoppedAttempt.retryScheduled = false;
    stoppedAttempt.turns = [stop.evidence];
    expect((await evaluateRuns({ fixture: liveFixture, records: mixed })).passed).toBe(true);

    const missing = structuredClone(records);
    delete missing[2]!.steps[0]!.inference;
    const failing = await evaluateRuns({ fixture: liveFixture, records: missing });
    expect(failing.passed).toBe(false);
    expect(failing.structural.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          recordId: "governed-3",
          passed: false,
          message: expect.stringContaining("turn governance"),
        }),
      ]),
    );
  });

  it("requires five distinct run IDs for a campaign", async () => {
    const liveFixture = await loadEvaluationFixture(
      new URL(
        "./fixtures/runtime-evaluation/fixtures/turn-governance-live-readiness.json",
        import.meta.url,
      ).pathname,
    );
    const records = governedCampaignRecords();
    records[4] = structuredClone(records[0]!);

    const result = await evaluateRuns({ fixture: liveFixture, records });

    expect(result.passed).toBe(false);
    expect(result.structural.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          assertion: { type: "run-count", minimum: 5 },
          passed: false,
          message: "campaign records must have unique run IDs",
        }),
        expect.objectContaining({
          assertion: { type: "evidence-identity-consistent" },
          passed: false,
        }),
      ]),
    );
  });

  it("rejects tampered revision, packet, node, and evidence-digest identity", async () => {
    const liveFixture = await loadEvaluationFixture(
      new URL(
        "./fixtures/runtime-evaluation/fixtures/turn-governance-live-readiness.json",
        import.meta.url,
      ).pathname,
    );
    const mutations: Array<(records: RunRecord[]) => void> = [
      (records) => {
        records[1]!.repository.revision = "tampered-revision";
      },
      (records) => {
        records[1]!.steps[0]!.contextPreflight!.packetDigest = "c".repeat(64);
      },
      (records) => {
        records[1]!.steps[0]!.contextPreflight!.consultedNodeIds = ["node-b"];
      },
      (records) => {
        onlyTurn(records[1]!).evidenceDigest = "f".repeat(64);
      },
    ];

    for (const mutate of mutations) {
      const records = governedCampaignRecords();
      mutate(records);
      const result = await evaluateRuns({ fixture: liveFixture, records });
      expect(result.passed).toBe(false);
      expect(
        result.structural.results.some(
          (item) =>
            !item.passed &&
            (item.assertion.type === "turn-governance-evidence" ||
              item.assertion.type === "evidence-identity-consistent"),
        ),
      ).toBe(true);
    }
  });

  it("rejects unknown decisions, unknown reasons, and stripped readiness identity", async () => {
    const turnFixture = parseEvaluationFixture({
      version: 1,
      name: "turn-evidence",
      assertions: [{ type: "turn-governance-evidence" }],
    });
    const mutations: Array<(value: RunRecord) => void> = [
      (value) => {
        (onlyTurn(value) as { decision: string }).decision = "teleport";
      },
      (value) => {
        const turn = onlyTurn(value);
        turn.decision = "stop";
        delete turn.outputTokens;
        (turn as { reason?: string }).reason = "unknown-stop";
        onlyAttempt(value).outcome = "context-exhausted";
      },
      (value) => {
        delete value.steps[0]!.contextPreflight!.packetDigest;
        delete onlyAttempt(value).identity!.contextPacketDigest;
      },
    ];

    for (const mutate of mutations) {
      const value = withTurnGovernance(record("tampered"));
      mutate(value);
      const result = await evaluateRuns({ fixture: turnFixture, records: [value] });
      expect(result.passed).toBe(false);
    }
  });

  it("admits the host-reset replay only on the CREATE revision writer (#1266)", async () => {
    const turnFixture = parseEvaluationFixture({
      version: 1,
      name: "turn-replay",
      assertions: [{ type: "turn-governance-evidence" }],
    });
    const writeStep = (id: string, replay: "disabled-write-step" | "reset-write-step") => {
      const value = withTurnGovernance(record(`${replay}-${id}`));
      value.steps[0] = { ...value.steps[0]!, id, mode: "write" };
      value.steps[0].inference!.replay = replay;
      return value;
    };
    const passed = async (value: RunRecord) =>
      (await evaluateRuns({ fixture: turnFixture, records: [value] })).passed;

    expect(await passed(writeStep("revise-documentation", "reset-write-step"))).toBe(true);
    expect(await passed(writeStep("revise-documentation", "disabled-write-step"))).toBe(true);
    expect(await passed(writeStep("write-documentation", "disabled-write-step"))).toBe(true);
    expect(await passed(writeStep("write-documentation", "reset-write-step"))).toBe(false);
  });

  it("rejects invalid optional budgets, output clamps, policy drift, and counters", async () => {
    const turnFixture = parseEvaluationFixture({
      version: 1,
      name: "turn-policy",
      assertions: [{ type: "turn-governance-evidence" }],
    });
    const mutations: Array<(value: RunRecord) => void> = [
      (value) => {
        onlyTurn(value).requestedOutputTokens = -1;
      },
      (value) => {
        onlyTurn(value).effectiveContextWindow = 128_001;
      },
      (value) => {
        onlyTurn(value).outputTokens = 4_097;
      },
      (value) => {
        const first = onlyTurn(value);
        first.toolCalls = 1;
        first.toolResults = 1;
        onlyAttempt(value).turns!.push({
          ...first,
          turn: 2,
          toolCalls: 0,
          toolResults: 0,
          requestDigest: "f".repeat(64),
        });
      },
      (value) => {
        const first = onlyTurn(value);
        if (first.maxToolCalls === undefined) {
          throw new Error("finite turn fixture requires a max tool-call value");
        }
        onlyAttempt(value).turns!.push({
          ...first,
          turn: 2,
          maxToolCalls: first.maxToolCalls + 1,
          requestDigest: "f".repeat(64),
        });
      },
      (value) => {
        const turn = onlyTurn(value);
        turn.decision = "stop";
        turn.reason = "context-exhausted";
        onlyAttempt(value).outcome = "context-exhausted";
      },
    ];

    for (const mutate of mutations) {
      const value = withTurnGovernance(record("invalid-policy"));
      mutate(value);
      const result = await evaluateRuns({ fixture: turnFixture, records: [value] });
      expect(result.passed).toBe(false);
    }
  });

  it("admits an empty-turn count only within providerRetries + 1 and names the counter failure", async () => {
    // Pins both directions of the `<= providerRetries + 1` guard; rejections name
    // the exact failure so an unrelated turn-governance miss cannot satisfy them.
    const turnFixture = parseEvaluationFixture({
      version: 1,
      name: "turn-attempt-counters",
      assertions: [{ type: "turn-governance-evidence" }],
    });
    const finalized = (mutate: (turn: Record<string, unknown>) => void = () => {}) => {
      const value = withTurnGovernance(record("blank-turns"));
      const turn = onlyTurn(value) as unknown as Record<string, unknown>;
      turn.providerPayloadSchemaVersion = 1;
      turn.finalPayloadSha256 = "a".repeat(64);
      mutate(turn);
      return value;
    };
    const evaluate = async (value: RunRecord) =>
      evaluateRuns({ fixture: turnFixture, records: [value] });

    // Accepting controls: the finalized turn itself, a single terminal blank,
    // and a streak whose every blank but the last was replaced by a replay.
    expect((await evaluate(finalized())).passed).toBe(true);
    expect((await evaluate(finalized((turn) => (turn.providerBlankTurns = 1)))).passed).toBe(true);
    expect(
      (
        await evaluate(
          finalized((turn) => {
            turn.providerRetries = 2;
            turn.providerBlankTurns = 3;
          }),
        )
      ).passed,
    ).toBe(true);
    // A blank turn cut at the output limit and its one nudged replay cut the same
    // way: two blanks, one retry, at the bound exactly.
    expect(
      (
        await evaluate(
          finalized((turn) => {
            turn.providerRetries = 1;
            turn.providerBlankTurns = 2;
          }),
        )
      ).passed,
    ).toBe(true);

    const rejected: Array<[string, RunRecord]> = [
      // Every empty turn except the last was replaced by a replay, so the
      // count cannot outrun the retries.
      [
        "blank streak outruns retries",
        finalized((turn) => {
          turn.providerRetries = 1;
          turn.providerBlankTurns = 3;
        }),
      ],
      ["second blank without a replay", finalized((turn) => (turn.providerBlankTurns = 2))],
      // A recorded blank is a count of empty turns.
      ["zero", finalized((turn) => (turn.providerBlankTurns = 0))],
      ["negative", finalized((turn) => (turn.providerBlankTurns = -1))],
      ["fractional", finalized((turn) => (turn.providerBlankTurns = 1.5))],
    ];
    // An empty turn answers a payload that was finalized and sent.
    const unfinalized = withTurnGovernance(record("blank-unfinalized"));
    (onlyTurn(unfinalized) as unknown as Record<string, unknown>).providerBlankTurns = 1;
    rejected.push(["blank on an unfinalized turn", unfinalized]);

    for (const [label, value] of rejected) {
      const result = await evaluate(value);
      expect(result.passed, label).toBe(false);
      expect(result.structural.results, label).toEqual([
        expect.objectContaining({
          assertion: { type: "turn-governance-evidence" },
          passed: false,
          message: expect.stringContaining(":turn-1: invalid provider attempt counters"),
        }),
      ]);
    }
  });

  it("rejects malformed attempt outcomes, numbering, retry transitions, and success claims", async () => {
    const attemptFixture = parseEvaluationFixture({
      version: 1,
      name: "attempt-state-machine",
      assertions: [{ type: "turn-governance-evidence" }, { type: "governed-terminal-status" }],
    });
    const mutations: Array<(value: RunRecord) => void> = [
      (value) => {
        (onlyAttempt(value) as { outcome: string }).outcome = "mystery";
      },
      (value) => {
        onlyAttempt(value).attempt = 2;
      },
      (value) => {
        (onlyAttempt(value) as unknown as { retryable: string }).retryable = "false";
      },
      (value) => {
        onlyAttempt(value).retryScheduled = true;
      },
      (value) => {
        const inference = value.steps[0]!.inference!;
        inference.configuredMaxRetries = 1;
        inference.effectiveMaxRetries = 1;
        const first = onlyAttempt(value);
        first.outcome = "timeout";
        first.retryable = false;
        first.retryScheduled = true;
        first.backoffMs = 1_000;
        inference.attempts.push({
          ...structuredClone(first),
          attempt: 2,
          outcome: "succeeded",
          retryable: false,
          retryScheduled: false,
          backoffMs: undefined,
        });
      },
      (value) => {
        const inference = value.steps[0]!.inference!;
        inference.configuredMaxRetries = 1;
        inference.effectiveMaxRetries = 1;
        const first = onlyAttempt(value);
        first.outcome = "timeout";
        first.retryable = true;
        first.retryScheduled = true;
        delete first.backoffMs;
        inference.attempts.push({
          ...structuredClone(first),
          attempt: 2,
          outcome: "succeeded",
          retryable: false,
          retryScheduled: false,
        });
      },
      (value) => {
        const first = onlyAttempt(value);
        first.outcome = "timeout";
        first.retryable = true;
        first.retryScheduled = true;
        first.backoffMs = 1_000;
        value.steps[0]!.inference!.attempts.push({
          ...structuredClone(first),
          attempt: 2,
          outcome: "succeeded",
          retryable: false,
          retryScheduled: false,
          backoffMs: undefined,
        });
      },
      (value) => {
        const first = onlyAttempt(value);
        first.outcome = "timeout";
        first.retryable = true;
        first.retryScheduled = false;
        value.steps[0]!.inference!.attempts.push({
          ...structuredClone(first),
          attempt: 2,
          outcome: "succeeded",
          retryable: false,
          retryScheduled: false,
        });
      },
      (value) => {
        onlyAttempt(value).outcome = "timeout";
      },
    ];

    for (const mutate of mutations) {
      const value = withTurnGovernance(record("invalid-attempt"));
      mutate(value);
      expect((await evaluateRuns({ fixture: attemptFixture, records: [value] })).passed).toBe(
        false,
      );
    }
  });

  it("admits a scheduled retry that honoured the attempt's recorded Retry-After (#1247)", async () => {
    const attemptFixture = parseEvaluationFixture({
      version: 1,
      name: "attempt-retry-after",
      assertions: [{ type: "turn-governance-evidence" }, { type: "governed-terminal-status" }],
    });
    const retried = (backoffMs: number): RunRecord => {
      const value = withTurnGovernance(record("honoured-retry-after"));
      const inference = value.steps[0]!.inference!;
      inference.configuredMaxRetries = 1;
      inference.effectiveMaxRetries = 1;
      const first = onlyAttempt(value);
      const succeeded = structuredClone(first);
      first.outcome = "timeout";
      first.retryable = true;
      first.retryScheduled = true;
      first.backoffMs = backoffMs;
      first.modelTelemetry = {
        schemaVersion: 1,
        finishReason: "error",
        providerLatencyMs: 1,
        providerError: { class: "timeout", httpStatus: 504, retryAfterMs: 1_500 },
      };
      inference.attempts.push({ ...succeeded, attempt: 2 });
      return value;
    };
    const evaluate = async (value: RunRecord) =>
      (await evaluateRuns({ fixture: attemptFixture, records: [value] })).passed;

    // Retry-After asked for 1,500 ms, above the 1,000 ms exponential wait and
    // inside the 2,000 ms maxDelayMs; the plain exponential wait still reads.
    expect(await evaluate(retried(1_500))).toBe(true);
    expect(await evaluate(retried(1_000))).toBe(true);
    expect(await evaluate(retried(1_250))).toBe(false);
    expect(await evaluate(retried(2_000))).toBe(false);

    // Without the observed status the Retry-After came with, only the plain
    // exponential wait reads.
    const statusless = (backoffMs: number): RunRecord => {
      const value = retried(backoffMs);
      onlyAttempt(value).modelTelemetry = {
        schemaVersion: 1,
        finishReason: "error",
        providerLatencyMs: 1,
        providerError: { class: "timeout", retryAfterMs: 1_500 },
      };
      return value;
    };
    expect(await evaluate(statusless(1_500))).toBe(false);
    expect(await evaluate(statusless(1_000))).toBe(true);
  });

  it("requires reconciled authoritative tool summaries for tool policy assertions", async () => {
    const policyFixture = parseEvaluationFixture({
      version: 1,
      name: "tool-evidence-authority",
      assertions: [
        { type: "allowed-tools", tools: ["read"] },
        { type: "forbidden-tools", tools: ["write"] },
      ],
    });
    const stripped = withTurnGovernance(withTools(record("stripped-tools"), ["read"]));
    stripped.tools = { totalCalls: 0, failedCalls: 0, byTool: [] };
    delete stripped.steps[0]!.tools;
    delete onlyAttempt(stripped).tools;

    const strippedResult = await evaluateRuns({
      fixture: policyFixture,
      records: [stripped],
    });
    expect(strippedResult.passed).toBe(false);
    expect(strippedResult.structural.results.every((result) => !result.passed)).toBe(true);

    const turnFixture = parseEvaluationFixture({
      version: 1,
      name: "tool-summary-reconciliation",
      assertions: [{ type: "turn-governance-evidence" }],
    });
    const mutations: Array<(value: RunRecord) => void> = [
      (value) => {
        value.tools.totalCalls += 1;
      },
      (value) => {
        value.steps[0]!.tools!.failedCalls = 1;
      },
      (value) => {
        onlyTurn(value).toolCalls += 1;
      },
      (value) => {
        delete onlyAttempt(value).tools;
      },
    ];
    for (const mutate of mutations) {
      const value = withTurnGovernance(withTools(record("tampered-tools"), ["read"]));
      mutate(value);
      expect((await evaluateRuns({ fixture: turnFixture, records: [value] })).passed).toBe(false);
    }
  });

  it("enforces observable stop-reason budgets and precedence", async () => {
    const stopFixture = parseEvaluationFixture({
      version: 1,
      name: "stop-reason-policy",
      assertions: [{ type: "turn-governance-evidence" }, { type: "governed-terminal-status" }],
    });
    const stopped = (reason: NonNullable<ReturnType<typeof onlyTurn>["reason"]>) => {
      const value = withTurnGovernance(record(`stop-${reason}`, "failed"));
      const attempt = onlyAttempt(value);
      const turn = onlyTurn(value);
      attempt.outcome = "context-exhausted";
      attempt.retryable = false;
      attempt.retryScheduled = false;
      turn.decision = "stop";
      turn.reason = reason;
      delete turn.outputTokens;
      return value;
    };

    for (const reason of [
      "context-exhausted",
      "compaction-limit",
      "provider-turn-limit",
      "tool-call-limit",
    ] as const) {
      expect(
        (await evaluateRuns({ fixture: stopFixture, records: [stopped(reason)] })).passed,
      ).toBe(false);
    }

    const fittingEvidenceStop = stopped("evidence-preservation-required");
    expect(
      (
        await evaluateRuns({
          fixture: stopFixture,
          records: [fittingEvidenceStop],
        })
      ).passed,
    ).toBe(true);

    const exhausted = stopped("context-exhausted");
    onlyTurn(exhausted).estimatedInputTokens = 8_050;
    onlyTurn(exhausted).availableOutputTokens = 14;
    expect((await evaluateRuns({ fixture: stopFixture, records: [exhausted] })).passed).toBe(true);

    const exhaustedAtCompactionLimit = stopped("compaction-limit");
    onlyTurn(exhaustedAtCompactionLimit).estimatedInputTokens = 8_050;
    onlyTurn(exhaustedAtCompactionLimit).availableOutputTokens = 14;
    onlyTurn(exhaustedAtCompactionLimit).compactions = 8;
    expect(
      (
        await evaluateRuns({
          fixture: stopFixture,
          records: [exhaustedAtCompactionLimit],
        })
      ).passed,
    ).toBe(true);

    const wrongPrecedence = stopped("context-exhausted");
    onlyTurn(wrongPrecedence).estimatedInputTokens = 8_050;
    onlyTurn(wrongPrecedence).availableOutputTokens = 14;
    onlyTurn(wrongPrecedence).compactions = 8;
    expect((await evaluateRuns({ fixture: stopFixture, records: [wrongPrecedence] })).passed).toBe(
      false,
    );

    // A compaction the governor refused to authorize stops before the budget is
    // spent, so the structural validator admits it with compactions remaining
    // and rejects it once the budget is gone (that is `compaction-limit`).
    const ineffective = stopped("compaction-ineffective");
    onlyTurn(ineffective).estimatedInputTokens = 8_050;
    onlyTurn(ineffective).availableOutputTokens = 14;
    onlyTurn(ineffective).compactions = 3;
    expect((await evaluateRuns({ fixture: stopFixture, records: [ineffective] })).passed).toBe(
      true,
    );

    const ineffectiveAtLimit = stopped("compaction-ineffective");
    onlyTurn(ineffectiveAtLimit).estimatedInputTokens = 8_050;
    onlyTurn(ineffectiveAtLimit).availableOutputTokens = 14;
    onlyTurn(ineffectiveAtLimit).compactions = 8;
    expect(
      (await evaluateRuns({ fixture: stopFixture, records: [ineffectiveAtLimit] })).passed,
    ).toBe(false);
  });

  it("checks the output authority arithmetic on clamped and exhausted turns", async () => {
    // `outputAuthority` is recorded only where the lease's cumulative output
    // authority bound the turn; the validator redoes the sums and keeps the
    // governor's precedence.
    const stopFixture = parseEvaluationFixture({
      version: 1,
      name: "output-authority-stop",
      assertions: [{ type: "turn-governance-evidence" }, { type: "governed-terminal-status" }],
    });
    const turnFixture = parseEvaluationFixture({
      version: 1,
      name: "output-authority-turn",
      assertions: [{ type: "turn-governance-evidence" }],
    });
    const authority = (cumulativeOutputTokens: number) => ({
      maxOutputTokens: 10_000,
      cumulativeOutputTokens,
      floorOutputTokens: 1_040,
    });
    const authorityStop = (
      reason: NonNullable<ReturnType<typeof onlyTurn>["reason"]>,
      cumulativeOutputTokens?: number,
    ) => {
      const value = withTurnGovernance(
        record(`authority-${reason}-${cumulativeOutputTokens ?? "none"}`, "failed"),
      );
      const attempt = onlyAttempt(value);
      const turn = onlyTurn(value);
      attempt.outcome = "context-exhausted";
      attempt.retryable = false;
      attempt.retryScheduled = false;
      turn.decision = "stop";
      turn.reason = reason;
      delete turn.outputTokens;
      if (cumulativeOutputTokens !== undefined)
        turn.outputAuthority = authority(cumulativeOutputTokens);
      return value;
    };
    const passes = async (fixture: typeof stopFixture, value: RunRecord) =>
      (await evaluateRuns({ fixture, records: [value] })).passed;

    // Accepting control: 500 remaining is under the 1,040 floor.
    expect(await passes(stopFixture, authorityStop("output-authority-exhausted", 9_500))).toBe(
      true,
    );
    // 2,000 remaining still carried a turn; an exhaustion without its
    // authority is unexplained.
    expect(await passes(stopFixture, authorityStop("output-authority-exhausted", 8_000))).toBe(
      false,
    );
    expect(await passes(stopFixture, authorityStop("output-authority-exhausted"))).toBe(false);
    // An exhausted authority rules out the budget reasons the governor checks
    // after it, even when the context budget was also gone.
    const budgetStop = authorityStop("context-exhausted", 9_500);
    onlyTurn(budgetStop).estimatedInputTokens = 8_050;
    onlyTurn(budgetStop).availableOutputTokens = 14;
    expect(await passes(stopFixture, budgetStop)).toBe(false);

    // A clamp requested exactly the 2,000 remaining of the 4,096 per-turn
    // limit and was granted it.
    const clamped = withTurnGovernance(record("authority-clamped"));
    onlyTurn(clamped).requestedOutputTokens = 2_000;
    onlyTurn(clamped).outputTokens = 2_000;
    onlyTurn(clamped).outputAuthority = authority(8_000);
    expect(await passes(turnFixture, clamped)).toBe(true);
    // Exactly the 1,040 floor remaining is still a clamp the governor sends;
    // one token less is an exhaustion, so a clamp claimed there fails.
    const atFloor = withTurnGovernance(record("authority-at-floor"));
    onlyTurn(atFloor).requestedOutputTokens = 1_040;
    onlyTurn(atFloor).outputTokens = 1_040;
    onlyTurn(atFloor).outputAuthority = authority(10_000 - 1_040);
    expect(await passes(turnFixture, atFloor)).toBe(true);
    const producedBelowGrant = withTurnGovernance(record("produced-below-grant"));
    onlyTurn(producedBelowGrant).outputTokens = 50;
    expect(await passes(turnFixture, producedBelowGrant)).toBe(true);
    const unknownProduction = withTurnGovernance(record("unknown-production"));
    delete onlyTurn(unknownProduction).outputTokens;
    expect(await passes(turnFixture, unknownProduction)).toBe(true);
    const replayAggregate = withTurnGovernance(record("replay-aggregate"));
    const replayTurn = onlyTurn(replayAggregate) as unknown as Record<string, unknown>;
    replayTurn.providerPayloadSchemaVersion = 1;
    replayTurn.finalPayloadSha256 = "a".repeat(64);
    replayTurn.providerRetries = 1;
    replayTurn.outputTokens = 7_000;
    expect(await passes(turnFixture, replayAggregate)).toBe(true);
    const replayOverCeiling = structuredClone(replayAggregate);
    onlyTurn(replayOverCeiling).outputTokens = 8_193;
    expect(await passes(turnFixture, replayOverCeiling)).toBe(false);
    const aggregateWithoutRetry = withTurnGovernance(record("aggregate-without-retry"));
    onlyTurn(aggregateWithoutRetry).outputTokens = 7_000;
    expect(await passes(turnFixture, aggregateWithoutRetry)).toBe(false);
    const underFloor = withTurnGovernance(record("authority-under-floor"));
    onlyTurn(underFloor).requestedOutputTokens = 1_039;
    onlyTurn(underFloor).outputTokens = 1_039;
    onlyTurn(underFloor).outputAuthority = authority(10_000 - 1_039);
    expect(await passes(turnFixture, underFloor)).toBe(false);
    const misclamped = withTurnGovernance(record("authority-misclamped"));
    onlyTurn(misclamped).requestedOutputTokens = 1_999;
    onlyTurn(misclamped).outputTokens = 1_999;
    onlyTurn(misclamped).outputAuthority = authority(8_000);
    expect(await passes(turnFixture, misclamped)).toBe(false);
    // 8,000 remaining covers the 4,096 limit, so nothing bound this turn.
    const unbound = withTurnGovernance(record("authority-unbound"));
    onlyTurn(unbound).outputAuthority = authority(2_000);
    expect(await passes(turnFixture, unbound)).toBe(false);
  });

  it("accepts actual governor proceed and explained local-stop evidence", async () => {
    const turnFixture = parseEvaluationFixture({
      version: 1,
      name: "actual-governor",
      assertions: [{ type: "turn-governance-evidence" }, { type: "governed-terminal-status" }],
    });
    const policy = {
      budget: {
        configuredContextWindow: 128_000,
        effectiveContextWindow: 8_192,
        configuredMaxInputTokens: 128_000,
        effectiveMaxInputTokens: 8_192,
        configuredMaxOutputTokens: 16_384,
        effectiveMaxOutputTokens: 4_096,
        reservedTokens: 128,
        requiredMinimumOutputTokens: 16,
      },
      maxProviderTurns: 12,
      maxToolCalls: 12,
      maxCompactions: 8,
      minRecentToolTurns: 1,
    };
    const state = {
      providerTurns: 0,
      toolCalls: 0,
      toolResults: 0,
      compactions: 0,
    };
    const proceeded = withTurnGovernance(record("actual-proceed"));
    const proceedAttempt = onlyAttempt(proceeded);
    const proceed = governProviderTurn({
      context: { messages: [{ role: "user", content: "bounded" }] },
      policy,
      state,
      evidenceIdentity: proceedAttempt.identity!,
      pinnedMessageCount: 1,
    });
    proceedAttempt.turns = [proceed.evidence];

    const stopped = withTurnGovernance(record("actual-stop", "failed"));
    const stopAttempt = onlyAttempt(stopped);
    const stop = governProviderTurn({
      context: { messages: [{ role: "user", content: "x".repeat(40_000) }] },
      policy,
      state,
      evidenceIdentity: stopAttempt.identity!,
      pinnedMessageCount: 1,
    });
    stopAttempt.outcome = "context-exhausted";
    stopAttempt.retryable = false;
    stopAttempt.retryScheduled = false;
    stopAttempt.turns = [stop.evidence];

    expect((await evaluateRuns({ fixture: turnFixture, records: [proceeded] })).passed).toBe(true);
    expect(stop.evidence).toMatchObject({
      decision: "stop",
      reason: "context-exhausted",
    });
    expect((await evaluateRuns({ fixture: turnFixture, records: [stopped] })).passed).toBe(true);

    const inputStopped = withTurnGovernance(record("actual-input-stop", "failed"));
    const inputStoppedAttempt = onlyAttempt(inputStopped);
    const inputStop = governProviderTurn({
      // Past the independent input cap under the calibrated estimator: the
      // request is charged at roughly four characters per token plus the
      // unbilled-content margin, not at one token per transcript byte.
      context: { messages: [{ role: "user", content: "x".repeat(4_000) }] },
      policy: {
        ...policy,
        budget: { ...policy.budget, effectiveMaxInputTokens: 500 },
      },
      state,
      evidenceIdentity: inputStoppedAttempt.identity!,
      pinnedMessageCount: 1,
    });
    inputStoppedAttempt.outcome = "context-exhausted";
    inputStoppedAttempt.retryable = false;
    inputStoppedAttempt.retryScheduled = false;
    inputStoppedAttempt.turns = [inputStop.evidence];
    expect(inputStop.evidence).toMatchObject({
      decision: "stop",
      reason: "context-exhausted",
      availableOutputTokens: expect.any(Number),
    });
    expect(
      (
        await evaluateRuns({
          fixture: turnFixture,
          records: [inputStopped],
        })
      ).passed,
    ).toBe(true);

    const missingDiscriminator = structuredClone(proceeded);
    delete onlyTurn(missingDiscriminator).contextBudgetSchemaVersion;
    expect(
      (
        await evaluateRuns({
          fixture: turnFixture,
          records: [missingDiscriminator],
        })
      ).passed,
    ).toBe(false);

    const mismatchedDiscriminator = structuredClone(proceeded);
    (
      onlyTurn(mismatchedDiscriminator) as unknown as Record<string, unknown>
    ).contextBudgetSchemaVersion = 1;
    expect(
      (
        await evaluateRuns({
          fixture: turnFixture,
          records: [mismatchedDiscriminator],
        })
      ).passed,
    ).toBe(false);

    const forgedAboveInputCap = structuredClone(proceeded);
    const forgedTurn = onlyTurn(forgedAboveInputCap);
    forgedTurn.effectiveMaxInputTokens = 1_000;
    forgedTurn.availableInputTokens = 872;
    forgedTurn.estimatedInputTokens = 873;
    forgedTurn.availableOutputTokens = 7_191;
    expect(
      (
        await evaluateRuns({
          fixture: turnFixture,
          records: [forgedAboveInputCap],
        })
      ).passed,
    ).toBe(false);
  });

  it("rejects succeeded runs with failed steps and unexplained failed runs", async () => {
    const terminalFixture = parseEvaluationFixture({
      version: 1,
      name: "governed-terminal-status",
      assertions: [{ type: "governed-terminal-status" }],
    });
    const inconsistentSuccess = withTurnGovernance(record("inconsistent-success"));
    inconsistentSuccess.steps[0]!.status = "failed";

    const unexplainedFailure = withTurnGovernance(record("unexplained-failure", "failed"));

    expect(
      (
        await evaluateRuns({
          fixture: terminalFixture,
          records: [inconsistentSuccess],
        })
      ).passed,
    ).toBe(false);
    expect(
      (
        await evaluateRuns({
          fixture: terminalFixture,
          records: [unexplainedFailure],
        })
      ).passed,
    ).toBe(false);
  });

  it("rejects malformed tool-policy assertions", () => {
    expect(() =>
      parseEvaluationFixture({
        version: 1,
        name: "bad-tool-policy",
        assertions: [{ type: "required-tools", tools: [""] }],
      }),
    ).toThrow("assertions[0].tools must be an array of non-empty tool names");
  });

  it("loads a successful create-documentation run record", async () => {
    const root = await mkdtemp(join(tmpdir(), "docsfab-create-documentation-"));
    const path = join(root, "run.json");
    try {
      await writeFile(
        path,
        JSON.stringify({ ...record("create-one"), workflow: "create-documentation" }),
        { mode: 0o600 },
      );
      await expect(loadRunRecord(path)).resolves.toMatchObject({
        id: "create-one",
        workflow: "create-documentation",
        status: "succeeded",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("parses a create-documentation workflow fixture assertion", () => {
    expect(
      parseEvaluationFixture({
        version: 1,
        name: "create-documentation-workflow",
        assertions: [{ type: "workflow", equals: "create-documentation" }],
      }).assertions,
    ).toEqual([{ type: "workflow", equals: "create-documentation" }]);
  });

  it("accepts a workflow assertion for every registered catalog workflow", () => {
    const names = listCatalogWorkflows().map((workflow) => workflow.name);
    expect(names).toContain("create-documentation");
    for (const name of names) {
      expect(
        parseEvaluationFixture({
          version: 1,
          name: `${name}-workflow`,
          assertions: [{ type: "workflow", equals: name }],
        }).assertions,
      ).toEqual([{ type: "workflow", equals: name }]);
    }
  });
});
