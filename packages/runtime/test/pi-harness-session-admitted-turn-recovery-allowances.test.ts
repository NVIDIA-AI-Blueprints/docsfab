// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EXECUTION_LEASE_DEFAULTS,
  PiHarness,
  bindModelExecutionProfile,
  captureInferenceFailure,
  createAuditHarness,
  createPiExecutionLeaseController,
  createProviderConnectionFactory,
  createRepository,
  nestedDeadlineMs,
  fixtureCompositionExecutionProfile,
  resetSharedTestState,
  scriptedProvider,
  skillCrateDirectory,
  stepInput,
  testTimeoutMs,
  textTurn,
  toolTurn,
  validModelConfig,
} from "./support/pi-harness-session-fixtures.js";

afterEach(resetSharedTestState);

describe("PiHarness admitted turn recovery allowances", () => {
  afterEach(() => vi.unstubAllEnvs());

  const cut = (turn: number) =>
    toolTurn(
      [{ id: `recovery-${turn}`, name: "read", arguments: { path: "README.md" } }],
      turn,
      "length",
    );

  it("recovers after more than two consecutive length-stopped tool turns", async () => {
    const repositoryPath = await createRepository();
    const provider = vi.fn(scriptedProvider([cut(1), cut(2), cut(3), textTurn("Recovered.")]));
    vi.stubGlobal("fetch", provider);
    const result = await (await createAuditHarness()).runStep(stepInput(repositoryPath));
    expect(result.summary).toBe("Recovered.");
    expect(provider).toHaveBeenCalledTimes(4);
    expect(result.executionLease).toMatchObject({
      providerTurns: 4,
      cumulativeOutputTokens: 20,
      toolCalls: { requested: 0, executed: 0, succeeded: 0, failed: 0 },
    });
    expect(result.turns?.every((turn) => turn.maxCompactions === turn.maxProviderTurns)).toBe(true);
  });

  it("honors a lower retry allowance and resets it after an ordinary tool turn", async () => {
    vi.stubEnv("DOCSFAB_GOVERNANCE_MAX_LENGTH_STOPPED_TOOL_TURNS", "3");
    const repositoryPath = await createRepository();
    const provider = vi.fn(
      scriptedProvider([
        cut(1),
        cut(2),
        toolTurn([{ id: "ordinary", name: "read", arguments: { path: "README.md" } }], 3),
        cut(4),
        cut(5),
        textTurn("Recovered after reset."),
      ]),
    );
    vi.stubGlobal("fetch", provider);
    const result = await (await createAuditHarness()).runStep(stepInput(repositoryPath));
    expect(result.summary).toBe("Recovered after reset.");
    expect(provider).toHaveBeenCalledTimes(6);
    expect(result.executionLease).toMatchObject({
      providerTurns: 6,
      toolCalls: { requested: 1, executed: 1, succeeded: 1, failed: 0 },
    });
  });

  it.each([true, false])(
    "preserves the reserved turn after ordinary recovery (truncated=%s)",
    async (truncated) => {
      const repositoryPath = await createRepository();
      const executionProfile = fixtureCompositionExecutionProfile({
        maxProviderTurns: 4,
        timeoutMs: 30_000,
        maxResponseBytes: 65_536,
      });
      const provider = vi.fn(
        scriptedProvider([
          cut(1),
          cut(2),
          truncated ? cut(3) : textTurn("Complete at boundary."),
          cut(4),
          textTurn("Outside admitted turns."),
        ]),
      );
      vi.stubGlobal("fetch", provider);
      const harness = new PiHarness({
        skillCrateDirectory,
        executionProfile,
        credential: { family: "nvidia-inference-api", apiKey: validModelConfig.apiKey },
        providerConnectionFactory: createProviderConnectionFactory({
          routeId: executionProfile.routeId,
          transport: executionProfile.transport,
        }),
      });
      if (truncated) {
        const error = await captureInferenceFailure(harness, stepInput(repositoryPath));
        expect(error.message).toContain("tool-arguments-truncated: 3 consecutive provider turns");
        expect(error.evidence?.executionLease?.providerTurns).toBe(3);
      } else {
        const result = await harness.runStep(stepInput(repositoryPath));
        expect(result.summary).toBe("Complete at boundary.");
        expect(result.executionLease?.providerTurns).toBe(3);
      }
      expect(provider).toHaveBeenCalledTimes(3);
    },
  );

  it("counts every rejected call and permits equality with the requested-tool ceiling", async () => {
    const repositoryPath = await createRepository();
    const executionProfile = fixtureCompositionExecutionProfile({
      maxProviderTurns: 9,
      timeoutMs: 30_000,
      maxResponseBytes: 65_536,
    });
    const provider = vi.fn(
      scriptedProvider([
        ...Array.from({ length: 5 }, (_, turn) =>
          toolTurn(
            [
              { id: `batch-${turn}-a`, name: "read", arguments: { path: "README.md" } },
              { id: `batch-${turn}-b`, name: "read", arguments: { path: "README.md" } },
            ],
            turn + 1,
            "length",
          ),
        ),
        textTurn("Not admitted."),
      ]),
    );
    vi.stubGlobal("fetch", provider);
    const harness = new PiHarness({
      skillCrateDirectory,
      executionProfile,
      credential: { family: "nvidia-inference-api", apiKey: validModelConfig.apiKey },
      providerConnectionFactory: createProviderConnectionFactory({
        routeId: executionProfile.routeId,
        transport: executionProfile.transport,
      }),
    });
    const error = await captureInferenceFailure(harness, stepInput(repositoryPath));
    expect(provider).toHaveBeenCalledTimes(5);
    expect(error.message).toContain("tool-arguments-truncated: 5 consecutive provider turns");
    expect(error.evidence?.turns?.filter((turn) => turn.decision !== "stop").at(-1)).toMatchObject({
      toolCalls: 8,
      maxToolCalls: 8,
    });
    expect(error.evidence?.executionLease?.toolCalls).toEqual({
      denied: 0,
      governanceBlocked: 0,
      requested: 0,
      executed: 0,
      succeeded: 0,
      failed: 0,
    });
  });

  it(
    "spends exactly the admitted maximum on truncated batches and refuses the next request",
    async () => {
      // The governor admits a request with exactly the tool ceiling already in
      // its transcript. That request can return one more rejected call; a next
      // request is refused. This is smaller than the independent turn envelope.
      const maximum = Math.min(
        EXECUTION_LEASE_DEFAULTS.maxProviderTurns,
        EXECUTION_LEASE_DEFAULTS.hardToolCallCeiling + 1,
      );
      const repositoryPath = await createRepository();
      const provider = vi.fn(
        scriptedProvider([
          ...Array.from({ length: maximum }, (_, index) => cut(index + 1)),
          textTurn("Outside admitted turns."),
        ]),
      );
      vi.stubGlobal("fetch", provider);
      const executionProfile = {
        ...fixtureCompositionExecutionProfile({
          maxProviderTurns: EXECUTION_LEASE_DEFAULTS.maxProviderTurns,
          // Keep the attempt beneath the enclosing test, including in CI.
          // The extra five seconds below are fixture setup/cleanup headroom.
          timeoutMs: nestedDeadlineMs(30_000, 35_000),
          maxResponseBytes: 65_536,
        }),
        contextAdmission: "provider" as const,
      };
      const harness = new PiHarness({
        skillCrateDirectory,
        executionProfile,
        credential: { family: "nvidia-inference-api", apiKey: validModelConfig.apiKey },
        providerConnectionFactory: createProviderConnectionFactory({
          routeId: executionProfile.routeId,
          transport: executionProfile.transport,
        }),
      });
      const error = await captureInferenceFailure(harness, stepInput(repositoryPath));
      // If another budget stops this test first, show only closed
      // classifications and counters, not provider or error content.
      const stopEvidence = {
        timeout: error.category === "timeout",
        cumulativeTimeLimit:
          error.evidence?.executionLease?.terminalReason === "cumulative-time-limit",
        truncation: error.message.includes("tool-arguments-truncated:"),
        providerTurns: error.evidence?.executionLease?.providerTurns,
        elapsedMs: error.evidence?.executionLease?.elapsedMs,
      };
      expect(provider.mock.calls.length, JSON.stringify(stopEvidence)).toBe(maximum);
      expect(error.message).toContain(
        `tool-arguments-truncated: ${maximum} consecutive provider turns`,
      );
      expect(error.evidence?.executionLease).toMatchObject({
        providerTurns: maximum,
        cumulativeOutputTokens: maximum * 5,
        toolCalls: { requested: 0, executed: 0, succeeded: 0, failed: 0 },
      });
    },
    testTimeoutMs(35_000),
  );

  it.each([undefined, 1])(
    "compacts through the real adapter with allowance %s",
    async (allowance) => {
      const repositoryPath = await createRepository();
      await writeFile(
        resolve(repositoryPath, "large.md"),
        "review evidence line for repeated context recovery\n".repeat(430),
      );
      const readTurns = 60;
      // Distinct ranges, so no read in an epoch re-reads an unchanged result
      // and only the context, not the read-loop supervision, bounds the step.
      const ranges = 20;
      const provider = vi.fn(
        scriptedProvider([
          ...Array.from({ length: readTurns }, (_, index) =>
            toolTurn(
              [
                {
                  id: `compaction-${index}`,
                  name: "read",
                  arguments: { path: "large.md", offset: (index % ranges) + 1 },
                },
              ],
              index + 1,
            ),
          ),
          textTurn("Compaction recovery complete."),
        ]),
      );
      vi.stubGlobal("fetch", provider);
      const harness = await createAuditHarness({
        toolOutputCapBytes: 16_384,
        limits: {
          hostFile: null,
          projectFile: null,
          environment:
            allowance === undefined
              ? {}
              : { DOCSFAB_GOVERNANCE_MAX_COMPACTIONS: String(allowance) },
        },
        model: {
          ...validModelConfig,
          profile: {
            ...validModelConfig.profile,
            contextWindow: 30_096,
            maxInputTokens: 30_096,
            maxOutputTokens: 2_048,
          },
        },
      });
      if (allowance === undefined) {
        const result = await harness.runStep(stepInput(repositoryPath));
        expect(result.summary).toBe("Compaction recovery complete.");
        expect(result.turns?.filter((turn) => turn.decision === "compact").length).toBeGreaterThan(
          8,
        );
        expect(result.executionLease?.providerTurns).toBe(readTurns + 1);
        expect(provider).toHaveBeenCalledTimes(readTurns + 1);
      } else {
        const error = await captureInferenceFailure(harness, stepInput(repositoryPath));
        expect(error.evidence?.turns?.at(-1)).toMatchObject({
          decision: "stop",
          reason: "compaction-limit",
          compactions: allowance,
          maxCompactions: allowance,
        });
        expect(provider.mock.calls.length).toBeLessThan(readTurns + 1);
      }
    },
    testTimeoutMs(20_000),
  );

  it(
    "stops a one-file loop that forces a compaction each epoch by the cross-result code",
    async () => {
      const repositoryPath = await createRepository();
      await writeFile(
        resolve(repositoryPath, "large.md"),
        "review evidence line for repeated context recovery\n".repeat(430),
      );
      const readTurns = 60;
      const provider = vi.fn(
        scriptedProvider([
          ...Array.from({ length: readTurns }, (_, index) =>
            toolTurn(
              [{ id: `loop-${index}`, name: "read", arguments: { path: "large.md" } }],
              index + 1,
            ),
          ),
          textTurn("Not reached."),
        ]),
      );
      vi.stubGlobal("fetch", provider);
      const harness = await createAuditHarness({
        toolOutputCapBytes: 16_384,
        limits: { hostFile: null, projectFile: null, environment: {} },
        model: {
          ...validModelConfig,
          profile: {
            ...validModelConfig.profile,
            contextWindow: 30_096,
            maxInputTokens: 30_096,
            maxOutputTokens: 2_048,
          },
        },
      });
      const error = await captureInferenceFailure(harness, stepInput(repositoryPath));
      // Each compaction clears what one result counts, so the per-result bound
      // never fires; the cross-result count survives the compactions.
      expect(error).toMatchObject({ category: "no-progress" });
      expect(error.rejection?.code).toBe("execution-read-loop-unchanged-re-reads-bound");
      expect(error.evidence?.turns?.some((turn) => turn.decision === "compact")).toBe(true);
      const counters = error.evidence?.tools?.readEvidence;
      expect(counters?.maxUnchangedReReadsAcrossResults).toBeGreaterThan(
        counters?.maxRepeatsOfOneResult ?? Number.POSITIVE_INFINITY,
      );
      expect(provider.mock.calls.length).toBeLessThan(readTurns + 1);
    },
    testTimeoutMs(20_000),
  );

  it("binds a lower compaction allowance identically into the lease and provider", async () => {
    const repositoryPath = await createRepository();
    vi.stubGlobal("fetch", scriptedProvider([textTurn("No compaction needed.")]));
    const result = await (
      await createAuditHarness({
        limits: {
          environment: { DOCSFAB_GOVERNANCE_MAX_COMPACTIONS: "0" },
          hostFile: null,
          projectFile: null,
        },
      })
    ).runStep(stepInput(repositoryPath));
    expect(result.summary).toBe("No compaction needed.");
    expect(result.turns?.[0]?.maxCompactions).toBe(0);
    const lease = createPiExecutionLeaseController(
      stepInput(repositoryPath),
      bindModelExecutionProfile(validModelConfig).profile,
      [],
      {
        environment: { DOCSFAB_GOVERNANCE_MAX_COMPACTIONS: "0" },
        hostFile: null,
        projectFile: null,
      },
    );
    const leasePolicy = lease.coordinator.policy;
    if (leasePolicy.schemaVersion !== 1) throw new Error("expected finite lease policy");
    expect(leasePolicy.maxCompactions).toBe(0);
  });

  it("names truncation at the lowered allowance without paying for the next turn", async () => {
    vi.stubEnv("DOCSFAB_GOVERNANCE_MAX_LENGTH_STOPPED_TOOL_TURNS", "3");
    const repositoryPath = await createRepository();
    const provider = vi.fn(scriptedProvider([cut(1), cut(2), cut(3), textTurn("Not admitted.")]));
    vi.stubGlobal("fetch", provider);
    const error = await captureInferenceFailure(
      await createAuditHarness(),
      stepInput(repositoryPath),
    );
    expect(provider).toHaveBeenCalledTimes(3);
    expect(error.message).toContain("tool-arguments-truncated: 3 consecutive provider turns");
    expect(error).toMatchObject({ category: "malformed-response", retryable: false });
    expect(error.evidence?.executionLease).toMatchObject({
      providerTurns: 3,
      cumulativeOutputTokens: 15,
    });
  });
});
