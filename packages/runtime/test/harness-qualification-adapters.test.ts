// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

import {
  attestUnsupportedCodex,
  type BoundedProcessObservation,
  type BoundedProcessRunner,
  type ExecutableObservation,
  type ExternalHarnessQualificationPlanV1,
  parseHarnessAttestationV1,
  runBoundedProcess,
  runClaudeCodeQualification,
} from "../src/harness-qualification/index.js";
import { canonicalDigest } from "../src/contract-kit/index.js";
import { configureCredentialsForEachTest } from "./helpers/configured-credential.js";

// Configured for every test: only a configured credential is refused (#1807).
configureCredentialsForEachTest(
  `glpat-${"e".repeat(24)}`,
  `glpat-${"r".repeat(24)}`,
  `glpat-${"s".repeat(24)}`,
  `glpat-${"w".repeat(24)}`,
  `glpat-${"x".repeat(24)}`,
);

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const SHA_D = "d".repeat(64);
const SHA_E = "e".repeat(64);
const SHA_F = "f".repeat(64);
const MODEL = "claude-opus-4-7-20260801";
const PROMPT = "Review only the supplied candidate and specification.";
const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["decision"],
  properties: { decision: { type: "string", enum: ["pass"] } },
};

function plan(
  harnessId: "claude-code" | "codex" = "claude-code",
): ExternalHarnessQualificationPlanV1 {
  return {
    schemaVersion: 1,
    kind: "docsfab-harness-qualification-plan",
    adapterVersion: "1.0.0",
    harnessId,
    role: "technical-review",
    mode: "read-only",
    platform: { os: "darwin", arch: "arm64" },
    expectedExecutable: {
      basename: harnessId === "claude-code" ? "claude" : "codex",
      sha256: SHA_A,
      reportedVersion: harnessId === "claude-code" ? "2.1.226" : "0.147.0",
      identitySha256: SHA_B,
    },
    requestedModel: harnessId === "claude-code" ? MODEL : "gpt-5.6-sol",
    routeClass: "opaque-cli-managed",
    authMechanismClass: "enterprise-oauth",
    effort: "high",
    maxTurns: 1,
    maxBudgetUsd: 1,
    inputDigests: {
      corpusManifestSha256: SHA_A,
      caseSha256: SHA_B,
      workflowSha256: SHA_C,
      skillSha256: SHA_D,
      qualitySha256: SHA_E,
      outputSchemaSha256: canonicalDigest(OUTPUT_SCHEMA),
      thresholdsSha256: SHA_A,
      scorerSha256: SHA_B,
      promptSha256: createHash("sha256").update(PROMPT, "utf8").digest("hex"),
      stagingManifestSha256: SHA_C,
    },
    limits: { timeoutMs: 30_000, maxStdoutBytes: 65_536, maxStderrBytes: 16_384 },
    expectedWorkspaceSha256: SHA_F,
  };
}

const EXECUTABLE: ExecutableObservation = {
  basename: "claude",
  sha256: SHA_A,
  reportedVersion: "2.1.226",
  identitySha256: SHA_B,
  trusted: true,
};

function stdout(overrides: Record<string, unknown> = {}): Buffer {
  const sessionId = "123e4567-e89b-42d3-a456-426614174000";
  return Buffer.from(
    `${JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: sessionId,
      model: MODEL,
      tools: [],
      mcp_servers: [],
    })}\n${JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: sessionId,
      modelUsage: { [MODEL]: { inputTokens: 12 } },
      structured_output: { decision: "pass" },
      ...overrides,
    })}\n`,
  );
}

function observation(
  overrides: Partial<BoundedProcessObservation> = {},
): BoundedProcessObservation {
  const output = overrides.stdout ?? stdout();
  const error = overrides.stderr ?? Buffer.alloc(0);
  return {
    status: "settled",
    exitCode: 0,
    signal: null,
    durationMs: 25,
    stdout: output,
    stderr: error,
    stdoutBytes: output.byteLength,
    stderrBytes: error.byteLength,
    stdoutOverflow: false,
    stderrOverflow: false,
    stdinBytes: Buffer.byteLength(PROMPT, "utf8"),
    stdinDelivered: true,
    descendantContainment: "verified",
    ...overrides,
  };
}

function host(
  result: BoundedProcessObservation,
  runner?: BoundedProcessRunner,
  stagingOverrides: Partial<{
    canonicalPath: string;
    prompt: Buffer;
    outputSchemaJson: Buffer;
    inputDigests: ExternalHarnessQualificationPlanV1["inputDigests"];
    trusted: boolean;
  }> = {},
) {
  const planValue = plan();
  return {
    runProcess: runner ?? vi.fn(async () => result),
    platform: () => ({ os: "darwin" as const, arch: "arm64" }),
    descendantContainment: vi.fn(async () => "verified" as const),
    inspectExecutable: vi.fn(async () => EXECUTABLE),
    workspaceManifest: vi.fn(async () => ({
      canonicalPath: "/private/tmp/docsfab-harness-empty",
      sha256: SHA_F,
      empty: true,
      ownerOnly: true,
    })),
    openVerifiedStaging: vi.fn(async () => ({
      canonicalPath: "/private/tmp/docsfab-harness-staging",
      prompt: Buffer.from(PROMPT, "utf8"),
      outputSchemaJson: Buffer.from(JSON.stringify(OUTPUT_SCHEMA), "utf8"),
      inputDigests: planValue.inputDigests,
      trusted: true,
      ...stagingOverrides,
    })),
    toolDenialProbe: vi.fn(
      async (request: {
        bindingSha256: string;
      }): Promise<{ status: "passed" | "failed"; bindingSha256: string }> => ({
        status: "passed",
        bindingSha256: request.bindingSha256,
      }),
    ),
    now: () => new Date("2026-08-22T12:00:00.000Z"),
  };
}

function input(planValue: unknown = plan()) {
  return {
    plan: planValue,
    executablePath: "/usr/local/bin/claude",
    workingDirectory: "/private/tmp/docsfab-harness-empty",
    stagingDirectory: "/private/tmp/docsfab-harness-staging",
    environment: { HOME: "/Users/test", LANG: "C", TMPDIR: "/private/tmp" },
    parseResult(value: unknown): { decision: "pass" } {
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).length !== 1 ||
        (value as Record<string, unknown>).decision !== "pass"
      ) {
        throw new Error("invalid role result");
      }
      return { decision: "pass" };
    },
  };
}

describe("external harness qualification adapters", () => {
  it("completes a guarded Claude run and requests an empty tool surface", async () => {
    const runner = vi.fn(async (_request: Parameters<BoundedProcessRunner>[0]) => observation());
    const outcome = await runClaudeCodeQualification(input(), host(observation(), runner));

    expect(outcome.result).toEqual({ decision: "pass" });
    expect(outcome.attestation.terminalCode).toBe("completed");
    expect(outcome.attestation.reasonCodes).toEqual([]);
    expect(outcome.attestation.requestedModel).toBe(outcome.attestation.observedModel);
    expect(outcome.attestation.observedSessionId).toBe("123e4567-e89b-42d3-a456-426614174000");
    expect(outcome.attestation.toolEventCount).toBe(0);
    expect(outcome.attestation.workspace.beforeSha256).toBe(
      outcome.attestation.workspace.afterSha256,
    );
    const request = runner.mock.calls[0]?.[0];
    expect(request?.arguments).toContain("--safe-mode");
    expect(request?.arguments).toContain("--system-prompt");
    expect(request?.arguments).toContain("--no-session-persistence");
    expect(
      request?.arguments.slice(
        request.arguments.indexOf("--tools"),
        request.arguments.indexOf("--tools") + 2,
      ),
    ).toEqual(["--tools", ""]);
    expect(request?.environment).toEqual({
      HOME: "/Users/test",
      LANG: "C",
      TMPDIR: "/private/tmp",
    });
    expect(outcome.attestation.environment.variableNames).toEqual(["HOME", "LANG", "TMPDIR"]);
    expect(outcome.attestation.arguments.policySha256).toBe(
      "50f001ec6f46bd7623078001ca51b679a89acadb4c7734833b05b30fd8e5c31b",
    );
    expect(outcome.attestation.controls.probeBindingSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(outcome.attestation.controls.probeBindingSha256).not.toBe(
      outcome.attestation.arguments.policySha256,
    );
    expect(request?.stdin.toString("utf8")).toBe(PROMPT);
  });

  it("refuses Codex before the runner can be invoked", async () => {
    const runner = vi.fn(async () => observation());
    const outcome = await attestUnsupportedCodex({ plan: plan("codex"), runner });
    expect(outcome.attestation.terminalCode).toBe("unsupported-confinement");
    expect(outcome.attestation.reasonCodes).toEqual(["unsupported-confinement"]);
    expect(runner).not.toHaveBeenCalled();
  });

  it("fails the concrete local host before any model egress when containment is unavailable", async () => {
    if (process.platform !== "darwin" && process.platform !== "linux") {
      throw new Error("Harness qualification tests require a supported runtime platform.");
    }
    const localPlan = {
      ...plan(),
      platform: { os: process.platform, arch: process.arch },
    } satisfies ExternalHarnessQualificationPlanV1;
    const outcome = await runClaudeCodeQualification(input(localPlan));
    expect(outcome.attestation.terminalCode).toBe("unsupported-confinement");
    expect(outcome.attestation.process.stdinDelivered).toBe(false);
    expect(outcome.attestation.process.descendantContainment).toBe("unsupported");
  });

  it.each([
    ["malformed", observation({ stdout: Buffer.from("not-json\n") }), "malformed-output"],
    ["timeout", observation({ status: "timeout", exitCode: null }), "timeout"],
    ["cancel", observation({ status: "cancelled", exitCode: null }), "cancelled"],
    ["overflow", observation({ stdoutOverflow: true }), "output-limit"],
    ["nonzero", observation({ exitCode: 2 }), "process-failed"],
    [
      "tool event",
      observation({
        stdout: Buffer.concat([
          Buffer.from(
            `${JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read" }] } })}\n`,
          ),
          stdout(),
        ]),
      }),
      "unexpected-tool-activity",
    ],
    [
      "identity mismatch",
      observation({
        stdout: Buffer.from(
          stdout({ modelUsage: { "claude-other-20260801": {} } })
            .toString("utf8")
            .replace(`"model":"${MODEL}"`, '"model":"claude-other-20260801"'),
        ),
      }),
      "model-identity-mismatch",
    ],
  ] as const)("fails closed for %s", async (_name, processResult, code) => {
    const outcome = await runClaudeCodeQualification(input(), host(processResult));
    expect(outcome.result).toBeUndefined();
    expect(outcome.attestation.terminalCode).toBe(code);
    expect(outcome.attestation.resultSha256).toBeNull();
  });

  it("maps a runner containment refusal without falling through to malformed output", async () => {
    const unsupported = observation({
      status: "unsupported-confinement",
      stdout: Buffer.alloc(0),
      stdinBytes: 0,
      stdinDelivered: false,
      descendantContainment: "unsupported",
    });
    const outcome = await runClaudeCodeQualification(input(), host(unsupported));
    expect(outcome.attestation.terminalCode).toBe("unsupported-confinement");
    expect(outcome.attestation.reasonCodes[0]).toBe("unsupported-confinement");
  });

  it("does not retain a model-invented session id in the role result", async () => {
    const eventSession = "123e4567-e89b-42d3-a456-426614174000";
    const modelSession = "invented-session";
    const output = stdout({
      structured_output: { decision: "pass", session_id: modelSession },
    });
    const candidate = {
      ...input(),
      parseResult(value: unknown): { decision: "pass"; session_id: string } {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          throw new Error("invalid role result");
        }
        const record = value as Record<string, unknown>;
        if (record.decision !== "pass" || record.session_id !== eventSession) {
          throw new Error("unbound role session");
        }
        return { decision: "pass", session_id: eventSession };
      },
    };
    const outcome = await runClaudeCodeQualification(
      candidate,
      host(observation({ stdout: output })),
    );
    expect(outcome.result?.session_id).toBe(eventSession);
    expect(outcome.attestation.observedSessionId).toBe(eventSession);
    expect(JSON.stringify(outcome)).not.toContain(modelSession);
  });

  it("derives staging and tool-denial controls instead of accepting plan assertions", async () => {
    const runner = vi.fn(async () => observation());
    const mismatch = host(observation(), runner, { trusted: false });
    const stagingOutcome = await runClaudeCodeQualification(input(), mismatch);
    expect(stagingOutcome.attestation.terminalCode).toBe("staging-identity-mismatch");
    expect(stagingOutcome.attestation.controls.stagingIdentity).toBe("mismatched");
    expect(runner).not.toHaveBeenCalled();

    const probeHost = host(observation(), runner);
    probeHost.toolDenialProbe.mockImplementation(async (request) => ({
      status: "failed",
      bindingSha256: request.bindingSha256,
    }));
    const probeOutcome = await runClaudeCodeQualification(input(), probeHost);
    expect(probeOutcome.attestation.terminalCode).toBe("unexpected-tool-activity");
    expect(probeOutcome.attestation.controls.toolDenialProbe).toBe("failed");
    expect(runner).not.toHaveBeenCalled();
  });

  it("rejects a tool-denial probe attested for a different execution envelope", async () => {
    const runner = vi.fn(async () => observation());
    const probeHost = host(observation(), runner);
    probeHost.toolDenialProbe.mockResolvedValue({ status: "passed", bindingSha256: SHA_D });
    const outcome = await runClaudeCodeQualification(input(), probeHost);
    expect(outcome.attestation.terminalCode).toBe("harness-identity-mismatch");
    expect(outcome.attestation.controls.toolDenialProbe).toBe("failed");
    expect(runner).not.toHaveBeenCalled();
  });

  it("rejects canonical staging and child roots that overlap", async () => {
    const runner = vi.fn(async () => observation());
    const overlapping = host(observation(), runner, {
      canonicalPath: "/private/tmp/docsfab-harness-empty/staging",
    });
    const outcome = await runClaudeCodeQualification(input(), overlapping);
    expect(outcome.attestation.terminalCode).toBe("staging-identity-mismatch");
    expect(runner).not.toHaveBeenCalled();
  });

  it("copies opened staging bytes before later host operations can mutate the source", async () => {
    const openedPrompt = Buffer.from(PROMPT, "utf8");
    const runner = vi.fn(async (request) => {
      expect(request.stdin.toString("utf8")).toBe(PROMPT);
      return observation();
    });
    const immutableHost = host(observation(), runner, { prompt: openedPrompt });
    immutableHost.inspectExecutable.mockImplementation(async () => {
      openedPrompt.fill(0x78);
      return EXECUTABLE;
    });
    const outcome = await runClaudeCodeQualification(input(), immutableHost);
    expect(outcome.attestation.terminalCode).toBe("completed");
  });

  it("honors cancellation before preflight can reach model egress", async () => {
    const controller = new AbortController();
    controller.abort();
    const runner = vi.fn(async () => observation());
    const outcome = await runClaudeCodeQualification(
      { ...input(), signal: controller.signal },
      host(observation(), runner),
    );
    expect(outcome.attestation.terminalCode).toBe("cancelled");
    expect(runner).not.toHaveBeenCalled();
  });

  it("races a non-cooperative host preflight against the operation deadline", async () => {
    const runner = vi.fn(async () => observation());
    const hangingHost = host(observation(), runner);
    hangingHost.descendantContainment.mockImplementation(
      async () => await new Promise<"verified">(() => undefined),
    );
    const boundedPlan = { ...plan(), limits: { ...plan().limits, timeoutMs: 50 } };
    const started = performance.now();
    const outcome = await runClaudeCodeQualification(input(boundedPlan), hangingHost);
    expect(performance.now() - started).toBeLessThan(500);
    expect(outcome.attestation.terminalCode).toBe("timeout");
    expect(runner).not.toHaveBeenCalled();
  });

  it("maps recognized inbound credential material to one content-free code", async () => {
    const synthetic = `glpat-${"x".repeat(24)}`;
    const outcome = await runClaudeCodeQualification(
      input(),
      host(observation({ stderr: Buffer.from(synthetic) })),
    );
    expect(outcome.attestation.reasonCodes).toContain("inbound-credential-boundary");
    expect(JSON.stringify(outcome.attestation)).not.toContain(synthetic);
  });

  it("normalizes a credential-bearing runner exception without echoing it", async () => {
    const synthetic = `glpat-${"r".repeat(24)}`;
    const runner = vi.fn(async () => {
      throw new Error(`runner failed with ${synthetic}`);
    });
    const outcome = await runClaudeCodeQualification(input(), host(observation(), runner));
    expect(outcome.attestation.terminalCode).toBe("inbound-credential-boundary");
    expect(JSON.stringify(outcome)).not.toContain(synthetic);
  });

  it("blocks credential material projected through the child working directory", async () => {
    const runner = vi.fn(async () => observation());
    const synthetic = `glpat-${"w".repeat(24)}`;
    const outcome = await runClaudeCodeQualification(
      { ...input(), workingDirectory: `/private/tmp/${synthetic}` },
      host(observation(), runner),
    );
    expect(outcome.attestation.terminalCode).toBe("outbound-credential-boundary");
    expect(runner).not.toHaveBeenCalled();
    expect(JSON.stringify(outcome)).not.toContain(synthetic);
  });

  it("rejects a result-only stream and a conflicting init model", async () => {
    const resultOnly = stdout().subarray(stdout().indexOf(0x0a) + 1);
    const missingInit = await runClaudeCodeQualification(
      input(),
      host(observation({ stdout: resultOnly })),
    );
    expect(missingInit.attestation.terminalCode).toBe("malformed-output");

    const conflictingInit = Buffer.from(
      stdout().toString("utf8").replace(`"model":"${MODEL}"`, '"model":"claude-other"'),
    );
    const mismatch = await runClaudeCodeQualification(
      input(),
      host(observation({ stdout: conflictingInit })),
    );
    expect(mismatch.attestation.terminalCode).toBe("malformed-output");

    const missingInitSession = Buffer.from(
      stdout().toString("utf8").replace(`"session_id":"123e4567-e89b-42d3-a456-426614174000",`, ""),
    );
    const unboundInit = await runClaudeCodeQualification(
      input(),
      host(observation({ stdout: missingInitSession })),
    );
    expect(unboundInit.attestation.terminalCode).toBe("malformed-output");
  });

  it.each([
    ["invalid UTF-8", Buffer.from([0xff, 0x0a])],
    ["unknown top-level event", Buffer.from('{"type":"future_event"}\n')],
    [
      "unknown nested content block",
      Buffer.from(
        `${JSON.stringify({
          type: "assistant",
          session_id: "123e4567-e89b-42d3-a456-426614174000",
          message: { content: [{ type: "server_tool_use", name: "search" }] },
        })}\n${stdout().toString("utf8")}`,
      ),
    ],
    [
      "non-empty init tool surface",
      Buffer.from(
        `${JSON.stringify({
          type: "system",
          subtype: "init",
          session_id: "123e4567-e89b-42d3-a456-426614174000",
          tools: ["Read"],
          mcp_servers: [],
        })}\n${stdout().toString("utf8")}`,
      ),
    ],
    [
      "event after terminal",
      Buffer.concat([
        stdout(),
        Buffer.from(
          `${JSON.stringify({
            type: "assistant",
            session_id: "123e4567-e89b-42d3-a456-426614174000",
            message: { content: [{ type: "text", text: "late" }] },
          })}\n`,
        ),
      ]),
    ],
  ] as const)("rejects closed-stream grammar violation: %s", async (_label, stream) => {
    const outcome = await runClaudeCodeQualification(
      input(),
      host(observation({ stdout: stream })),
    );
    expect(outcome.attestation.terminalCode).toBe(
      _label === "unknown nested content block" || _label === "non-empty init tool surface"
        ? "unexpected-tool-activity"
        : "malformed-output",
    );
    expect(outcome.result).toBeUndefined();
  });

  it("blocks recognized outbound credential material before invoking the runner", async () => {
    const runner = vi.fn(async () => observation());
    const credentialPrompt = `review glpat-${"x".repeat(24)}`;
    const boundPlan = {
      ...plan(),
      inputDigests: {
        ...plan().inputDigests,
        promptSha256: createHash("sha256").update(credentialPrompt, "utf8").digest("hex"),
      },
    };
    const outcome = await runClaudeCodeQualification(
      input(boundPlan),
      host(observation(), runner, {
        prompt: Buffer.from(credentialPrompt, "utf8"),
        inputDigests: boundPlan.inputDigests,
      }),
    );
    expect(outcome.attestation.terminalCode).toBe("outbound-credential-boundary");
    expect(runner).not.toHaveBeenCalled();
  });

  it("guards credential material in schema/config argv as part of the exact outbound envelope", async () => {
    const runner = vi.fn(async () => observation());
    const synthetic = `glpat-${"s".repeat(24)}`;
    const schema = {
      ...OUTPUT_SCHEMA,
      description: `Never transmit ${synthetic}`,
    };
    const candidatePlan = {
      ...plan(),
      inputDigests: {
        ...plan().inputDigests,
        outputSchemaSha256: canonicalDigest(schema),
      },
    };
    const outcome = await runClaudeCodeQualification(
      input(candidatePlan),
      host(observation(), runner, {
        outputSchemaJson: Buffer.from(JSON.stringify(schema), "utf8"),
        inputDigests: candidatePlan.inputDigests,
      }),
    );

    expect(outcome.attestation.terminalCode).toBe("outbound-credential-boundary");
    expect(outcome.attestation.controls.outboundGuard).toBe("failed");
    expect(runner).not.toHaveBeenCalled();
    expect(JSON.stringify(outcome.attestation)).not.toContain(synthetic);
  });

  it.each(["LANG", "TMPDIR"] as const)(
    "blocks credential material in the complete allowed %s environment value before probe or spawn",
    async (name) => {
      const runner = vi.fn(async () => observation());
      const guardedHost = host(observation(), runner);
      const synthetic = `glpat-${"e".repeat(24)}`;
      const environment = {
        ...input().environment,
        [name]: name === "TMPDIR" ? `/private/tmp/${synthetic}` : synthetic,
      };

      const outcome = await runClaudeCodeQualification({ ...input(), environment }, guardedHost);

      expect(outcome.attestation.terminalCode).toBe("outbound-credential-boundary");
      expect(outcome.attestation.controls.outboundGuard).toBe("failed");
      expect(outcome.attestation.controls.probeBindingSha256).toBeNull();
      expect(guardedHost.toolDenialProbe).not.toHaveBeenCalled();
      expect(runner).not.toHaveBeenCalled();
      expect(JSON.stringify(outcome)).not.toContain(synthetic);
    },
  );

  it.each([
    ["tool count", { toolEventCount: 9 }],
    ["failed outbound guard", { controls: { outboundGuard: "failed" } }],
    ["workspace mutation", { workspace: { afterSha256: SHA_A } }],
    ["nonzero exit", { process: { exitCode: 42 } }],
    ["missing observed session", { observedSessionId: null }],
  ] as const)(
    "rejects a semantically impossible completed attestation: %s",
    async (_label, patch) => {
      const valid = (await runClaudeCodeQualification(input(), host(observation()))).attestation;
      const hostile = structuredClone(valid) as unknown as Record<string, unknown>;
      for (const [key, value] of Object.entries(patch)) {
        if (value && typeof value === "object" && !Array.isArray(value)) {
          hostile[key] = { ...(hostile[key] as Record<string, unknown>), ...value };
        } else {
          hostile[key] = value;
        }
      }
      expect(() => parseHarnessAttestationV1(hostile)).toThrow("invalid-value");
    },
  );

  it("normalizes an unexpected runner failure to a content-free code", async () => {
    const runner = vi.fn(async () => {
      throw new Error("unexpected-runner-failure");
    });
    const outcome = await runClaudeCodeQualification(input(), host(observation(), runner));
    expect(outcome.attestation.terminalCode).toBe("host-operation-failed");
    expect(JSON.stringify(outcome)).not.toContain("unexpected-runner-failure");
  });

  it("rejects missing and unknown plan fields before spawn", async () => {
    const missing = structuredClone(plan()) as unknown as Record<string, unknown>;
    delete missing.requestedModel;
    const unknown = { ...plan(), prompt: "must not be accepted" };
    const runner = vi.fn(async () => observation());

    await expect(
      runClaudeCodeQualification(input(missing), host(observation(), runner)),
    ).rejects.toThrow("invalid-shape");
    await expect(
      runClaudeCodeQualification(input(unknown), host(observation(), runner)),
    ).rejects.toThrow("invalid-shape");
    expect(runner).not.toHaveBeenCalled();
  });

  it("rejects malformed nested plan fields before spawn", async () => {
    const nested = structuredClone(plan()) as unknown as Record<string, unknown>;
    nested.limits = { timeoutMs: 30_000, maxStdoutBytes: 65_536, unexpected: 1 };
    const runner = vi.fn(async () => observation());

    await expect(
      runClaudeCodeQualification(input(nested), host(observation(), runner)),
    ).rejects.toThrow("invalid-shape");
    expect(runner).not.toHaveBeenCalled();
  });

  it("rejects missing and unknown attestation fields", async () => {
    const value = (await runClaudeCodeQualification(input(), host(observation()))).attestation;
    const missing = structuredClone(value) as unknown as Record<string, unknown>;
    delete missing.terminalCode;
    const unknown = { ...value, rawOutput: "forbidden" };
    expect(() => parseHarnessAttestationV1(missing)).toThrow("invalid-shape");
    expect(() => parseHarnessAttestationV1(unknown)).toThrow("invalid-shape");
  });
});

describe("bounded qualification process", () => {
  it("fails before spawn when descendant containment is not provable", async () => {
    const result = await runBoundedProcess({
      executablePath: process.execPath,
      arguments: ["-e", 'throw new Error("must not spawn")'],
      workingDirectory: tmpdir(),
      environment: {},
      stdin: Buffer.from("private input"),
      timeoutMs: 5_000,
      maxStdoutBytes: 64,
      maxStderrBytes: 64,
    });
    expect(result.status).toBe("unsupported-confinement");
    expect(result.stdinBytes).toBe(0);
    expect(result.stdinDelivered).toBe(false);
    expect(result.descendantContainment).toBe("unsupported");
  });

  it("preserves a pre-spawn caller cancellation over unsupported containment", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runBoundedProcess({
      executablePath: process.execPath,
      arguments: ["-e", 'throw new Error("must not spawn")'],
      workingDirectory: tmpdir(),
      environment: {},
      stdin: Buffer.alloc(0),
      timeoutMs: 50,
      maxStdoutBytes: 64,
      maxStderrBytes: 64,
      signal: controller.signal,
    });
    expect(result.status).toBe("cancelled");
  });
});
