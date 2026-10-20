// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import {
  authorizeNativePilotProcessRequest,
  consumeNativePilotProcessObservationAuthority,
  createNativePilotSimulationProcessRunner,
  NativePilotProcessError,
  runNativePilotProcess,
  validateNativePilotProcessRequest,
  type NativePilotProcessRequest,
} from "../src/native-compositions/pilot-process.js";

const PLAN_SHA256 = "a".repeat(64);

describe("native pilot bounded process", () => {
  let root: string;
  let scratch: string;
  let home: string;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "docsfab-native-process-")));
    scratch = join(root, "scratch");
    home = join(root, "home");
    await mkdir(scratch, { mode: 0o700 });
    await mkdir(home, { mode: 0o700 });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function request(
    script: string,
    overrides: Partial<NativePilotProcessRequest> = {},
  ): NativePilotProcessRequest {
    return {
      harnessId: "codex",
      executablePath: process.execPath,
      arguments: ["-e", script],
      workingDirectory: scratch,
      environment: {
        HOME: home,
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        TMPDIR: root,
        USER: "tester",
      },
      stdin: Buffer.from("bounded input", "utf8"),
      timeoutMs: 2_000,
      maxStdoutBytes: 4_096,
      maxStderrBytes: 4_096,
      streamPolicy: { kind: "terminal-capture-v1" },
      ...overrides,
    };
  }

  async function run(requestValue: NativePilotProcessRequest) {
    authorizeNativePilotProcessRequest(requestValue, PLAN_SHA256);
    return await runNativePilotProcess(requestValue);
  }

  function claudeRequest(
    script: string,
    overrides: Partial<NativePilotProcessRequest> = {},
  ): NativePilotProcessRequest {
    const candidate = request(script, {
      harnessId: "claude-code",
      streamPolicy: {
        kind: "claude-2.1.226-guard-v1",
        requestedModel: "claude-opus-4-7",
        stepId: "plan-documentation",
        workingDirectory: scratch,
      },
      ...overrides,
    });
    return candidate;
  }

  function claudeInit(sessionId = "claude-session-1") {
    return {
      type: "system",
      subtype: "init",
      agents: ["claude", "Explore", "general-purpose", "Plan"],
      analytics_disabled: false,
      apiKeySource: "none",
      capabilities: ["interrupt_receipt_v1", "interrupt_cancel_queued_v1", "msg_lifecycle_v1"],
      claude_code_version: "2.1.226",
      cwd: scratch,
      messaging_socket_path: join(root, "claude-message.sock"),
      mcp_servers: [],
      model: "claude-opus-4-7",
      output_style: "default",
      permissionMode: "dontAsk",
      plugins: [],
      product_feedback_disabled: false,
      session_id: sessionId,
      skills: [],
      slash_commands: [],
      tools: ["StructuredOutput"],
      uuid: "init-1",
    };
  }

  function claudeRate(sessionId = "claude-session-1") {
    return {
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed",
        resetsAt: 1_800_000_000_000,
        rateLimitType: "overage",
        overageStatus: "allowed",
        overageResetsAt: 1_800_000_100_000,
        isUsingOverage: false,
        overageInUse: false,
      },
      uuid: "rate-1",
      session_id: sessionId,
    };
  }

  function claudeSuccessEvents(sessionId = "claude-session-1") {
    const output = {
      schemaVersion: 1,
      kind: "docsfab-native-pilot-step-output",
      stepId: "plan-documentation",
      outcome: "succeeded",
      summary: "done",
      payload: { kind: "plan", content: "done" },
      document: null,
    };
    const assistantUsage = {
      cache_creation: {
        ephemeral_5m_input_tokens: 0,
        ephemeral_1h_input_tokens: 19_695,
      },
      cache_creation_input_tokens: 19_695,
      cache_read_input_tokens: 0,
      inference_geo: "global",
      input_tokens: 6,
      output_tokens: 1,
      service_tier: "standard",
    };
    const resultUsage = {
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 19_695 },
      cache_creation_input_tokens: 19_695,
      cache_read_input_tokens: 0,
      inference_geo: "global",
      input_tokens: 6,
      iterations: [
        {
          input_tokens: 6,
          output_tokens: 3_794,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 19_695,
          cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 19_695 },
          type: "message",
        },
      ],
      output_tokens: 3_794,
      server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
      service_tier: "standard",
      speed: "standard",
    };
    return [
      claudeInit(sessionId),
      claudeRate(sessionId),
      {
        type: "assistant",
        session_id: sessionId,
        parent_tool_use_id: null,
        uuid: "assistant-1",
        request_id: "request-1",
        timestamp: "2026-08-24T07:23:52.538Z",
        message: {
          content: [
            {
              type: "tool_use",
              id: "toolu_1",
              name: "StructuredOutput",
              input: output,
              caller: { type: "direct" },
            },
          ],
          id: "message-1",
          model: "claude-opus-4-7",
          role: "assistant",
          stop_reason: null,
          stop_sequence: null,
          stop_details: null,
          diagnostics: null,
          context_management: null,
          type: "message",
          usage: assistantUsage,
        },
      },
      {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              tool_use_id: "toolu_1",
              type: "tool_result",
              content: "Structured output provided successfully",
            },
          ],
        },
        parent_tool_use_id: null,
        session_id: sessionId,
        uuid: "acknowledgement-1",
        timestamp: "2026-08-24T08:22:53.365Z",
        tool_use_result: "Structured output provided successfully",
      },
      {
        duration_api_ms: 1,
        duration_ms: 2,
        is_error: false,
        modelUsage: {
          "claude-opus-4-7": {
            cacheCreationInputTokens: 19_695,
            cacheReadInputTokens: 0,
            canonicalModel: "claude-opus-4-7",
            contextWindow: 1_000_000,
            costUSD: 0.29183,
            inputTokens: 6,
            maxOutputTokens: 64_000,
            outputTokens: 3_794,
            provider: "firstParty",
            webSearchRequests: 0,
          },
        },
        num_turns: 2,
        permission_denials: [],
        result: JSON.stringify(output),
        session_id: sessionId,
        stop_reason: "end_turn",
        structured_output: structuredClone(output),
        subtype: "success",
        // Observed in a Claude Code 2.1.226 terminal result.
        time_to_request_ms: 159,
        total_cost_usd: 0,
        type: "result",
        usage: resultUsage,
        uuid: "result-1",
      },
    ];
  }

  function jsonl(events: readonly unknown[]): Buffer {
    return Buffer.from(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
  }

  function outputScript(chunks: readonly Buffer[], hold = false): string {
    const encoded = chunks.map((chunk) => chunk.toString("base64"));
    return [
      "process.stdin.resume();",
      ...encoded.map(
        (chunk, index) =>
          `setTimeout(() => process.stdout.write(Buffer.from(${JSON.stringify(chunk)}, "base64")), ${index * 10});`,
      ),
      hold
        ? "setInterval(() => {}, 1000);"
        : `setTimeout(() => process.exit(0), ${encoded.length * 10 + 10});`,
    ].join("\n");
  }

  it("runs without a shell, delivers stdin, and settles both streams", async () => {
    const result = await run(
      request("process.stdin.pipe(process.stdout); process.stderr.write('safe stderr')"),
    );

    expect(result).toMatchObject({
      status: "settled",
      exitCode: 0,
      stdinDelivered: true,
      stdoutEof: true,
      stderrEof: true,
      processGroupSettled: true,
      lateBytesObserved: false,
      descendantContainment: "unsupported",
    });
    expect(result.stdout.toString("utf8")).toBe("bounded input");
    expect(result.stderr.toString("utf8")).toBe("safe stderr");
  });

  it("retains a nonzero exit as a settled process observation", async () => {
    const result = await run(request("process.exit(7)"));
    expect(result.status).toBe("settled");
    expect(result.exitCode).toBe(7);
    expect(result.processGroupSettled).toBe(true);
  });

  it("kills and reaps the process group on timeout", async () => {
    const result = await run(request("setInterval(() => {}, 1000)", { timeoutMs: 30 }));
    expect(result.status).toBe("timeout");
    expect(result.processGroupSettled).toBe(true);
    expect(result.stdoutEof).toBe(true);
    expect(result.stderrEof).toBe(true);
  });

  it("kills and reaps the process group on cancellation", async () => {
    const controller = new AbortController();
    const requestValue = request("setInterval(() => {}, 1000)", { signal: controller.signal });
    authorizeNativePilotProcessRequest(requestValue, PLAN_SHA256);
    const pending = runNativePilotProcess(requestValue);
    setTimeout(() => controller.abort(), 20);
    const result = await pending;
    expect(result.status).toBe("cancelled");
    expect(result.processGroupSettled).toBe(true);
  });

  it("bounds stdout and kills the process on overflow", async () => {
    const result = await run(
      request("process.stdout.write('x'.repeat(10000))", { maxStdoutBytes: 64 }),
    );
    expect(result.status).toBe("output-limit");
    expect(result.stdoutOverflow).toBe(true);
    expect(result.stdout.byteLength).toBe(64);
    expect(result.stdoutBytes).toBeGreaterThan(64);
  });

  it("returns a content-free spawn failure", async () => {
    const result = await run(
      request("process.exit(0)", { executablePath: "/private/docsfab-no-such-executable" }),
    );
    expect(result.status).toBe("spawn-failed");
    expect(result.stdout.byteLength).toBe(0);
    expect(result.stderr.byteLength).toBe(0);
  });

  it("detects, kills, and reports residual same-group descendants", async () => {
    const script = [
      'const { spawn } = require("node:child_process");',
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      "child.unref();",
      "process.stdout.write(String(child.pid));",
    ].join("\n");
    const result = await run(request(script));
    expect(result.status).toBe("process-failed");
    expect(result.processGroupSettled).toBe(true);
    const childPid = Number(result.stdout.toString("utf8"));
    expect(Number.isSafeInteger(childPid)).toBe(true);
    expect(() => process.kill(childPid, 0)).toThrow();
  });

  it("rejects an unauthorized or mutated request before spawn", async () => {
    const unauthorized = request("process.exit(0)");
    await expect(runNativePilotProcess(unauthorized)).rejects.toMatchObject({
      code: "invocation-policy",
    });

    const mutated = request("process.stdin.resume()");
    authorizeNativePilotProcessRequest(mutated, PLAN_SHA256);
    mutated.stdin[0] = mutated.stdin[0]! ^ 1;
    await expect(runNativePilotProcess(mutated)).rejects.toMatchObject({
      code: "invocation-policy",
    });
  });

  it("rejects capture mutation after authorizing the observation", async () => {
    const requestValue = request("process.stdin.pipe(process.stdout)");
    const expected = authorizeNativePilotProcessRequest(requestValue, PLAN_SHA256);
    const result = await runNativePilotProcess(requestValue);
    result.stdout[0] = result.stdout[0]! ^ 1;
    expect(() =>
      consumeNativePilotProcessObservationAuthority(result, expected, PLAN_SHA256),
    ).toThrowError(expect.objectContaining({ code: "invocation-policy" }));
  });

  it("binds an observation authority to the exact plan digest", async () => {
    const requestValue = request("process.stdin.pipe(process.stdout)");
    const expectedRequestSha256 = authorizeNativePilotProcessRequest(requestValue, PLAN_SHA256);
    const result = await runNativePilotProcess(requestValue);
    expect(() =>
      consumeNativePilotProcessObservationAuthority(result, expectedRequestSha256, "b".repeat(64)),
    ).toThrowError(expect.objectContaining({ code: "invocation-policy" }));
    expect(() =>
      consumeNativePilotProcessObservationAuthority(result, expectedRequestSha256, PLAN_SHA256),
    ).not.toThrow();
  });

  it("turns a stdout pipe error into a bounded non-EOF process failure", async () => {
    const requestValue = request("process.exit(0)");
    authorizeNativePilotProcessRequest(requestValue, PLAN_SHA256);
    const fakeChild = new EventEmitter() as EventEmitter & {
      pid: undefined;
      stdin: PassThrough;
      stdout: PassThrough;
      stderr: PassThrough;
      kill: () => boolean;
    };
    fakeChild.pid = undefined;
    fakeChild.stdin = new PassThrough();
    fakeChild.stdout = new PassThrough();
    fakeChild.stderr = new PassThrough();
    fakeChild.kill = () => true;
    const runner = createNativePilotSimulationProcessRunner((() => {
      setImmediate(() => {
        fakeChild.stdout.emit("error", new Error("injected stream fault"));
        fakeChild.stderr.end();
        fakeChild.emit("close", 1, null);
      });
      return fakeChild;
    }) as never);
    const result = await runner(requestValue);
    expect(result.status).toBe("process-failed");
    expect(result.stdoutEof).toBe(false);
    expect(result.stderrEof).toBe(true);
    expect(result.processGroupSettled).toBe(true);
    expect(() =>
      consumeNativePilotProcessObservationAuthority(result, result.requestSha256, PLAN_SHA256),
    ).toThrowError(expect.objectContaining({ code: "invocation-policy" }));
  });

  it("counts a final no-newline Codex turn before a stdout pipe error", async () => {
    const requestValue = request("process.exit(0)");
    authorizeNativePilotProcessRequest(requestValue, PLAN_SHA256);
    const fakeChild = new EventEmitter() as EventEmitter & {
      pid: undefined;
      stdin: PassThrough;
      stdout: PassThrough;
      stderr: PassThrough;
      kill: () => boolean;
    };
    fakeChild.pid = undefined;
    fakeChild.stdin = new PassThrough();
    fakeChild.stdout = new PassThrough();
    fakeChild.stderr = new PassThrough();
    fakeChild.kill = () => true;
    const runner = createNativePilotSimulationProcessRunner((() => {
      setImmediate(() => {
        fakeChild.stdout.write(Buffer.from(JSON.stringify({ type: "turn.started" }), "utf8"));
        fakeChild.stdout.emit("error", new Error("injected stream fault"));
        fakeChild.stderr.end();
        fakeChild.emit("close", 1, null);
      });
      return fakeChild;
    }) as never);
    const result = await runner(requestValue);
    expect(result).toMatchObject({
      status: "process-failed",
      providerRequests: 1,
      providerRequestLowerBound: 1,
    });
  });

  it("withholds Claude observation authority when either stream lacks EOF proof", async () => {
    const requestValue = claudeRequest("process.exit(0)");
    authorizeNativePilotProcessRequest(requestValue, PLAN_SHA256);
    const fakeChild = new EventEmitter() as EventEmitter & {
      pid: undefined;
      stdin: PassThrough;
      stdout: PassThrough;
      stderr: PassThrough;
      kill: () => boolean;
    };
    fakeChild.pid = undefined;
    fakeChild.stdin = new PassThrough();
    fakeChild.stdout = new PassThrough();
    fakeChild.stderr = new PassThrough();
    fakeChild.kill = () => true;
    const runner = createNativePilotSimulationProcessRunner((() => {
      setImmediate(() => {
        fakeChild.stdout.emit("error", new Error("injected Claude stream fault"));
        fakeChild.stderr.end();
        fakeChild.emit("close", 1, null);
      });
      return fakeChild;
    }) as never);
    await expect(runner(requestValue)).rejects.toMatchObject({ code: "process-not-settled" });
  });

  it("kills Claude immediately when stdin delivery fails before provider output", async () => {
    const requestValue = claudeRequest("process.exit(0)");
    authorizeNativePilotProcessRequest(requestValue, PLAN_SHA256);
    const fakeChild = new EventEmitter() as EventEmitter & {
      pid: undefined;
      stdin: PassThrough;
      stdout: PassThrough;
      stderr: PassThrough;
      kill: () => boolean;
    };
    fakeChild.pid = undefined;
    fakeChild.stdin = new PassThrough();
    fakeChild.stdout = new PassThrough();
    fakeChild.stderr = new PassThrough();
    fakeChild.kill = () => true;
    fakeChild.stdin.end = ((..._arguments: unknown[]) => {
      setImmediate(() => {
        fakeChild.stdin.emit("error", new Error("injected stdin refusal"));
        fakeChild.stdout.write(jsonl(claudeSuccessEvents()));
        fakeChild.stdout.end();
        fakeChild.stderr.end();
        fakeChild.emit("close", 0, null);
      });
      return fakeChild.stdin;
    }) as never;
    const runner = createNativePilotSimulationProcessRunner((() => fakeChild) as never);
    const result = await runner(requestValue);
    expect(result).toMatchObject({
      status: "process-failed",
      streamDisposition: "stopped",
      streamFailureCode: "process-failed",
      stdinDelivered: false,
      killIssued: true,
      processGroupSettled: true,
    });
  });

  it("settles one exact Claude success only through the mandatory stream guard", async () => {
    const result = await run(claudeRequest(outputScript([jsonl(claudeSuccessEvents())])));
    expect(result).toMatchObject({
      status: "settled",
      streamDisposition: "success",
      streamFailureCode: null,
      providerRequests: 1,
      providerRequestLowerBound: 1,
      killIssued: false,
      stopSettlementRequired: false,
      fallbackAttempted: false,
      processGroupSettled: true,
    });
  });

  it("settles a bounded first-party auxiliary model as two composition requests", async () => {
    const events = structuredClone(claudeSuccessEvents()) as Array<Record<string, unknown>>;
    const result = events.at(-1)!;
    const modelUsage = result.modelUsage as Record<string, unknown>;
    result.modelUsage = {
      "claude-haiku-4-5-20251001": {
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        canonicalModel: "claude-haiku-4-5",
        contextWindow: 200_000,
        costUSD: 0.014062,
        inputTokens: 13_997,
        maxOutputTokens: 32_000,
        outputTokens: 13,
        provider: "firstParty",
        webSearchRequests: 0,
      },
      "claude-opus-4-7": modelUsage["claude-opus-4-7"],
    };
    const observation = await run(claudeRequest(outputScript([jsonl(events)])));
    expect(observation).toMatchObject({
      status: "settled",
      streamDisposition: "success",
      streamFailureCode: null,
      providerRequests: 2,
      providerRequestLowerBound: 2,
      killIssued: false,
      stopSettlementRequired: false,
      fallbackAttempted: false,
      processGroupSettled: true,
    });
  });

  it("stops a valid campaign-4 Claude acknowledgement at EOF without a terminal result", async () => {
    const events = claudeSuccessEvents().slice(0, 4);
    const result = await run(claudeRequest(outputScript([jsonl(events)])));
    expect(result).toMatchObject({
      status: "process-failed",
      streamDisposition: "stopped",
      streamFailureCode: "claude-stream-success-invalid",
      providerRequests: 1,
      providerRequestLowerBound: 1,
      killIssued: true,
      killIssuedBeforeRetryDeadline: true,
      stopSettlementRequired: true,
      processGroupSettled: true,
    });
  });

  it("kills when a Claude result carries an incomplete structured output", async () => {
    const events = claudeSuccessEvents();
    const resultEvent = events.at(-1) as Record<string, unknown>;
    resultEvent.structured_output = {
      schemaVersion: 1,
      kind: "docsfab-native-pilot-step-output",
      stepId: "plan-documentation",
    };
    const result = await run(claudeRequest(outputScript([jsonl(events)], true)));
    expect(result).toMatchObject({
      streamDisposition: "stopped",
      streamFailureCode: "digest-mismatch",
      providerRequests: 1,
      providerRequestLowerBound: 1,
      killIssued: true,
      processGroupSettled: true,
    });
  });

  it.each([
    {
      name: "text block",
      code: "unexpected-tool-activity",
      requests: 0,
      mutate: (events: Array<Record<string, unknown>>) => {
        (events[2]!.message as Record<string, unknown>).content = [
          { type: "text", text: "substitute" },
        ];
      },
    },
    {
      name: "multiple blocks",
      code: "unexpected-tool-activity",
      requests: 0,
      mutate: (events: Array<Record<string, unknown>>) => {
        const content = (events[2]!.message as Record<string, unknown>).content as Array<unknown>;
        content.push(structuredClone(content[0]));
      },
    },
    {
      name: "caller drift",
      code: "unexpected-tool-activity",
      requests: 0,
      mutate: (events: Array<Record<string, unknown>>) => {
        const content = (events[2]!.message as Record<string, unknown>).content as Array<
          Record<string, unknown>
        >;
        (content[0]!.caller as Record<string, unknown>).type = "tool";
      },
    },
    {
      name: "assistant substitution",
      code: "digest-mismatch",
      requests: 1,
      mutate: (events: Array<Record<string, unknown>>) => {
        const content = (events[2]!.message as Record<string, unknown>).content as Array<
          Record<string, unknown>
        >;
        (content[0]!.input as Record<string, unknown>).summary = "assistant substitution";
      },
    },
    {
      name: "result substitution",
      code: "digest-mismatch",
      requests: 1,
      mutate: (events: Array<Record<string, unknown>>) => {
        (events.at(-1)!.structured_output as Record<string, unknown>).summary =
          "result substitution";
      },
    },
    {
      name: "missing acknowledgement",
      code: "unexpected-tool-activity",
      requests: 1,
      mutate: (events: Array<Record<string, unknown>>) => {
        events.splice(
          events.findIndex((event) => event.type === "user"),
          1,
        );
      },
    },
    {
      name: "duplicate acknowledgement",
      code: "unexpected-tool-activity",
      requests: 1,
      mutate: (events: Array<Record<string, unknown>>) => {
        const index = events.findIndex((event) => event.type === "user");
        events.splice(index + 1, 0, structuredClone(events[index]!));
      },
    },
    {
      name: "acknowledgement ID substitution",
      code: "digest-mismatch",
      requests: 1,
      mutate: (events: Array<Record<string, unknown>>) => {
        const ack = events.find((event) => event.type === "user")!;
        (
          (ack.message as Record<string, unknown>).content as Array<Record<string, unknown>>
        )[0]!.tool_use_id = "toolu_substituted";
      },
    },
    {
      name: "acknowledgement session substitution",
      code: "session-mismatch",
      requests: 1,
      mutate: (events: Array<Record<string, unknown>>) => {
        events.find((event) => event.type === "user")!.session_id = "different-session";
      },
    },
    {
      name: "acknowledgement content substitution",
      code: "unexpected-tool-activity",
      requests: 1,
      mutate: (events: Array<Record<string, unknown>>) => {
        const ack = events.find((event) => event.type === "user")!;
        (
          (ack.message as Record<string, unknown>).content as Array<Record<string, unknown>>
        )[0]!.content = "substitute";
      },
    },
    {
      name: "acknowledgement extra block",
      code: "unexpected-tool-activity",
      requests: 1,
      mutate: (events: Array<Record<string, unknown>>) => {
        const ack = events.find((event) => event.type === "user")!;
        const content = (ack.message as Record<string, unknown>).content as Array<unknown>;
        content.push(structuredClone(content[0]));
      },
    },
    {
      name: "acknowledgement external tool",
      code: "unexpected-tool-activity",
      requests: 1,
      mutate: (events: Array<Record<string, unknown>>) => {
        const ack = events.find((event) => event.type === "user")!;
        const block = (
          (ack.message as Record<string, unknown>).content as Array<Record<string, unknown>>
        )[0]!;
        block.type = "tool_use";
        block.name = "Read";
      },
    },
    {
      name: "acknowledgement noncanonical timestamp",
      code: "malformed-stream",
      requests: 1,
      mutate: (events: Array<Record<string, unknown>>) => {
        events.find((event) => event.type === "user")!.timestamp = "2026-08-24";
      },
    },
    {
      name: "acknowledgement after terminal",
      code: "unexpected-tool-activity",
      requests: 1,
      mutate: (events: Array<Record<string, unknown>>) => {
        const index = events.findIndex((event) => event.type === "user");
        [events[index], events[index + 1]] = [events[index + 1]!, events[index]!];
      },
    },
  ])("stops Claude $name before output authority", async ({ code, mutate, requests }) => {
    const events = structuredClone(claudeSuccessEvents()) as Array<Record<string, unknown>>;
    mutate(events);
    // A duplicated event pushes this fixture past the default 4 KiB stdout bound,
    // which would mask the drift being attacked with an output-limit failure.
    const result = await run(
      claudeRequest(outputScript([jsonl(events)], true), { maxStdoutBytes: 8_192 }),
    );
    expect(result).toMatchObject({
      status: "process-failed",
      streamDisposition: "stopped",
      streamFailureCode: code,
      providerRequests: requests,
      providerRequestLowerBound: requests,
      killIssued: true,
      processGroupSettled: true,
    });
  });

  it.each(["assistant usage", "result usage", "model usage"])(
    "kills when Claude success has invalid %s",
    async (target) => {
      const events = structuredClone(claudeSuccessEvents()) as Array<Record<string, unknown>>;
      if (target === "assistant usage") {
        const message = events[2]!.message as Record<string, unknown>;
        message.usage = {};
      } else if (target === "result usage") {
        events.at(-1)!.usage = {};
      } else {
        events.at(-1)!.modelUsage = { "claude-opus-4-7": {} };
      }
      const result = await run(claudeRequest(outputScript([jsonl(events)], true)));
      const expectedRequests = target === "assistant usage" ? 0 : 1;
      expect(result).toMatchObject({
        streamDisposition: "stopped",
        providerRequests: expectedRequests,
        providerRequestLowerBound: expectedRequests,
        killIssued: true,
        processGroupSettled: true,
      });
    },
  );

  it.each([
    {
      name: "terminal turn drift",
      code: "session-mismatch",
      mutate: (result: Record<string, unknown>) => (result.num_turns = 1),
    },
    {
      name: "negative time-to-request latency",
      code: "malformed-stream",
      mutate: (result: Record<string, unknown>) => (result.time_to_request_ms = -1),
    },
    {
      name: "non-numeric time-to-request latency",
      code: "malformed-stream",
      mutate: (result: Record<string, unknown>) => (result.time_to_request_ms = "159"),
    },
    {
      name: "unknown additive terminal field",
      code: "malformed-stream",
      mutate: (result: Record<string, unknown>) => (result.time_to_first_byte_ms = 1),
    },
    {
      name: "auxiliary appended after the governed root model",
      code: "model-identity-mismatch",
      requests: 2,
      mutate: (result: Record<string, unknown>) => {
        (result.modelUsage as Record<string, unknown>)["claude-haiku-4-5-20251001"] = {};
      },
    },
    {
      name: "Haiku-only model",
      code: "model-identity-mismatch",
      mutate: (result: Record<string, unknown>) => {
        const usage = result.modelUsage as Record<string, unknown>;
        delete usage["claude-opus-4-7"];
        usage["claude-haiku-4-5-20251001"] = {};
      },
    },
    {
      name: "server tool usage",
      code: "unexpected-tool-activity",
      mutate: (result: Record<string, unknown>) => {
        const usage = result.usage as Record<string, Record<string, unknown>>;
        usage.server_tool_use!.web_search_requests = 1;
      },
    },
    {
      name: "null server tool projection",
      code: "malformed-stream",
      mutate: (result: Record<string, unknown>) => {
        (result.usage as Record<string, unknown>).server_tool_use = null;
      },
    },
    {
      name: "missing result iteration",
      code: "malformed-stream",
      mutate: (result: Record<string, unknown>) => {
        (result.usage as Record<string, unknown>).iterations = [];
      },
    },
    {
      name: "duplicate result iteration",
      code: "malformed-stream",
      mutate: (result: Record<string, unknown>) => {
        const usage = result.usage as Record<string, unknown>;
        const iterations = usage.iterations as Array<unknown>;
        iterations.push(structuredClone(iterations[0]));
      },
    },
    {
      name: "result iteration drift",
      code: "budget-mismatch",
      mutate: (result: Record<string, unknown>) => {
        const usage = result.usage as Record<string, unknown>;
        const iteration = (usage.iterations as Array<Record<string, number>>)[0]!;
        iteration.output_tokens = iteration.output_tokens! + 1;
      },
    },
    ...["inputTokens", "outputTokens", "cacheReadInputTokens", "cacheCreationInputTokens"].map(
      (field) => ({
        name: `Opus ${field} drift`,
        code: "budget-mismatch",
        mutate: (result: Record<string, unknown>) => {
          const modelUsage = (result.modelUsage as Record<string, Record<string, number>>)[
            "claude-opus-4-7"
          ]!;
          modelUsage[field] = modelUsage[field]! + 1;
        },
      }),
    ),
  ])("stops Claude $name before success", async ({ code, mutate, requests }) => {
    const events = structuredClone(claudeSuccessEvents()) as Array<Record<string, unknown>>;
    mutate(events.at(-1)!);
    const result = await run(claudeRequest(outputScript([jsonl(events)], true)));
    // The raw model-key count is projected before strict decoding, so a rejected
    // multi-model result still retains the larger request lower bound.
    const expectedRequests = requests ?? 1;
    expect(result).toMatchObject({
      status: "process-failed",
      streamDisposition: "stopped",
      streamFailureCode: code,
      providerRequests: expectedRequests,
      providerRequestLowerBound: expectedRequests,
      killIssued: true,
      processGroupSettled: true,
    });
  });

  it("rejects an oversized Claude init betas list before success", async () => {
    const events = structuredClone(claudeSuccessEvents()) as Array<Record<string, unknown>>;
    events[0]!.betas = Array.from({ length: 1_025 }, () => "safe-beta");
    const result = await run(claudeRequest(outputScript([jsonl(events)], true)));
    expect(result).toMatchObject({
      streamDisposition: "stopped",
      killIssued: true,
      processGroupSettled: true,
    });
  });

  it.each(["assistant", "result"])(
    "kills immediately on credential material in Claude %s event",
    async (target) => {
      const events = structuredClone(claudeSuccessEvents()) as Array<Record<string, unknown>>;
      const secret = `sk-${"x".repeat(32)}`;
      if (target === "assistant") {
        const message = events[2]!.message as Record<string, unknown>;
        message.content = [{ type: "text", text: secret }];
      } else {
        events.at(-1)!.result = secret;
      }
      const result = await run(claudeRequest(outputScript([jsonl(events)], true)));
      const expectedRequests = target === "assistant" ? 0 : 1;
      expect(result).toMatchObject({
        streamDisposition: "stopped",
        streamFailureCode: "credential-material",
        providerRequests: expectedRequests,
        providerRequestLowerBound: expectedRequests,
        killIssued: true,
        processGroupSettled: true,
      });
    },
  );

  it("retains one Claude provider request after an assistant and malformed result", async () => {
    const success = claudeSuccessEvents();
    const hostile = [...success.slice(0, 4), { type: "result" }];
    const result = await run(claudeRequest(outputScript([jsonl(hostile)], true)));
    expect(result).toMatchObject({
      streamDisposition: "stopped",
      providerRequests: 1,
      providerRequestLowerBound: 1,
      killIssued: true,
      processGroupSettled: true,
    });
  });

  it.each([
    {
      name: "malformed assistant",
      event: () => {
        const assistant = structuredClone(claudeSuccessEvents()[2]) as Record<string, unknown>;
        (assistant.message as Record<string, unknown>).model = "wrong-model";
        return assistant;
      },
    },
    { name: "malformed result", event: () => ({ type: "result" }) },
  ])("does not count an unvalidated provider request for a $name signature", async ({ event }) => {
    const result = await run(
      claudeRequest(outputScript([jsonl([claudeInit(), claudeRate(), event()])], true)),
    );
    expect(result).toMatchObject({
      streamDisposition: "stopped",
      providerRequests: 0,
      providerRequestLowerBound: 0,
      killIssued: true,
      processGroupSettled: true,
    });
  });

  it("classifies a malformed complete line after Claude success as late", async () => {
    const hostile = Buffer.concat([jsonl(claudeSuccessEvents()), Buffer.from("{\n", "utf8")]);
    const result = await run(claudeRequest(outputScript([hostile], true)));
    expect(result).toMatchObject({
      streamDisposition: "stopped",
      streamFailureCode: "late-stream-event",
      providerRequests: 1,
      lateBytesObserved: true,
      killIssued: true,
      processGroupSettled: true,
    });
  });

  it("counts a second Claude request even when api_retry arrives after success", async () => {
    const retry = {
      type: "system",
      subtype: "api_retry",
      attempt: 2,
      max_retries: 10,
      retry_delay_ms: 511,
      error_status: 529,
      error: "overloaded",
      session_id: "claude-session-1",
      uuid: "retry-after-success",
    };
    const hostile = Buffer.concat([jsonl(claudeSuccessEvents()), jsonl([retry])]);
    const result = await run(claudeRequest(outputScript([hostile], true)));
    expect(result).toMatchObject({
      streamDisposition: "stopped",
      streamFailureCode: "late-stream-event",
      providerRequests: 2,
      providerRequestLowerBound: 2,
      retryAttempt: 2,
      lateBytesObserved: true,
      killIssued: true,
      processGroupSettled: true,
    });
  });

  it("detects a split first api_retry, kills before its delay, and records one request", async () => {
    const retry = {
      type: "system",
      subtype: "api_retry",
      attempt: 1,
      max_retries: 10,
      retry_delay_ms: 511,
      error_status: 529,
      error: "overloaded",
      session_id: "claude-session-1",
      uuid: "retry-1",
    };
    const retryLine = jsonl([retry]);
    const split = Math.floor(retryLine.byteLength / 2);
    const result = await run(
      claudeRequest(
        outputScript(
          [jsonl([claudeInit()]), retryLine.subarray(0, split), retryLine.subarray(split)],
          true,
        ),
      ),
    );
    expect(result).toMatchObject({
      status: "process-failed",
      streamDisposition: "stopped",
      streamFailureCode: "provider-retry-blocked",
      providerRequests: 1,
      providerRequestLowerBound: 1,
      retryAttempt: 1,
      retryMaximum: 10,
      killIssued: true,
      killIssuedBeforeRetryDeadline: true,
      stopSettlementRequired: true,
      processGroupSettled: true,
      fallbackAttempted: false,
    });
  });

  it("counts and stops an api_retry signature even before Claude init", async () => {
    const retry = {
      type: "system",
      subtype: "api_retry",
      attempt: 1,
      max_retries: 10,
      retry_delay_ms: 511,
      error_status: 529,
      error: "overloaded",
      session_id: "claude-session-1",
      uuid: "retry-before-init",
    };
    const result = await run(claudeRequest(outputScript([jsonl([retry])], true)));
    expect(result).toMatchObject({
      streamDisposition: "stopped",
      streamFailureCode: "retry-event-mismatch",
      providerRequests: 1,
      providerRequestLowerBound: 1,
      retryAttempt: 1,
      killIssued: true,
      killIssuedBeforeRetryDeadline: true,
      processGroupSettled: true,
    });
  });

  it("marks same-chunk partial bytes after a blocked Claude retry as late", async () => {
    const retry = {
      type: "system",
      subtype: "api_retry",
      attempt: 1,
      max_retries: 10,
      retry_delay_ms: 511,
      error_status: 529,
      error: "overloaded",
      session_id: "claude-session-1",
      uuid: "retry-partial-same-chunk",
    };
    const hostile = Buffer.concat([jsonl([claudeInit(), retry]), Buffer.from("{", "utf8")]);
    const result = await run(claudeRequest(outputScript([hostile], true)));
    expect(result).toMatchObject({
      streamDisposition: "stopped",
      streamFailureCode: "provider-retry-blocked",
      providerRequests: 1,
      lateBytesObserved: true,
      killIssued: true,
      processGroupSettled: true,
    });
  });

  it("marks a later partial chunk after a blocked Claude retry as late", async () => {
    const retry = {
      type: "system",
      subtype: "api_retry",
      attempt: 1,
      max_retries: 10,
      retry_delay_ms: 511,
      error_status: 529,
      error: "overloaded",
      session_id: "claude-session-1",
      uuid: "retry-partial-next-chunk",
    };
    const requestValue = claudeRequest("process.exit(0)");
    authorizeNativePilotProcessRequest(requestValue, PLAN_SHA256);
    const fakeChild = new EventEmitter() as EventEmitter & {
      pid: undefined;
      stdin: PassThrough;
      stdout: PassThrough;
      stderr: PassThrough;
      kill: () => boolean;
    };
    fakeChild.pid = undefined;
    fakeChild.stdin = new PassThrough();
    fakeChild.stdout = new PassThrough();
    fakeChild.stderr = new PassThrough();
    fakeChild.kill = () => true;
    const runner = createNativePilotSimulationProcessRunner((() => {
      setImmediate(() => {
        fakeChild.stdout.write(jsonl([claudeInit(), retry]));
        fakeChild.stdout.write(Buffer.from("{", "utf8"));
        fakeChild.stdout.end();
        fakeChild.stderr.end();
        fakeChild.emit("close", null, "SIGKILL");
      });
      return fakeChild;
    }) as never);
    const result = await runner(requestValue);
    expect(result).toMatchObject({
      streamDisposition: "stopped",
      streamFailureCode: "provider-retry-blocked",
      providerRequests: 1,
      lateBytesObserved: true,
      killIssued: true,
      processGroupSettled: true,
    });
  });

  it("keeps a Codex provider-request lower bound after a malformed trailing line", async () => {
    const hostile = Buffer.from(
      `${JSON.stringify({ type: "thread.started", thread_id: "thread-1" })}\n${JSON.stringify({ type: "turn.started" })}\n{`,
      "utf8",
    );
    const result = await run(request(outputScript([hostile])));
    expect(result).toMatchObject({
      providerRequests: 1,
      providerRequestLowerBound: 1,
    });
  });

  it("finds a Codex provider request after a malformed middle line", async () => {
    const hostile = Buffer.from(
      `${JSON.stringify({ type: "thread.started", thread_id: "thread-1" })}\n{\n${JSON.stringify({ type: "turn.started" })}\n`,
      "utf8",
    );
    const result = await run(request(outputScript([hostile])));
    expect(result).toMatchObject({
      providerRequests: 1,
      providerRequestLowerBound: 1,
    });
  });

  it("counts every complete Codex turn start in failed evidence", async () => {
    const hostile = Buffer.from(
      `${JSON.stringify({ type: "thread.started", thread_id: "thread-1" })}\n${JSON.stringify({ type: "turn.started" })}\n${JSON.stringify({ type: "turn.started" })}\n`,
      "utf8",
    );
    const result = await run(request(outputScript([hostile])));
    expect(result).toMatchObject({
      status: "process-failed",
      streamFailureCode: "retry-policy-mismatch",
      providerRequests: 2,
      providerRequestLowerBound: 2,
    });
  });

  it("counts a Codex turn start observed after the retained stdout cap", async () => {
    const hostile = Buffer.from(
      `${"x".repeat(100)}\n${JSON.stringify({ type: "turn.started" })}\n`,
      "utf8",
    );
    const result = await run(request(outputScript([hostile]), { maxStdoutBytes: 64 }));
    expect(result).toMatchObject({
      status: "output-limit",
      stdoutOverflow: true,
      providerRequests: 1,
      providerRequestLowerBound: 1,
    });
    expect(result.stdout.byteLength).toBe(64);
  });

  it.each([
    {
      name: "retry schema drift",
      retry: { attempt: 1, max_retries: 9 },
      code: "retry-event-mismatch",
      requests: 1,
    },
    {
      name: "attempt two",
      retry: { attempt: 2, max_retries: 10 },
      code: "retry-policy-mismatch",
      requests: 2,
    },
  ])("kills and retains $name without fallback", async ({ retry, code, requests }) => {
    const event = {
      type: "system",
      subtype: "api_retry",
      retry_delay_ms: 511,
      error_status: 529,
      error: "overloaded",
      session_id: "claude-session-1",
      uuid: "retry-hostile",
      ...retry,
    };
    const result = await run(claudeRequest(outputScript([jsonl([claudeInit(), event])], true)));
    expect(result).toMatchObject({
      streamDisposition: "stopped",
      streamFailureCode: code,
      providerRequests: requests,
      providerRequestLowerBound: requests,
      killIssued: true,
      processGroupSettled: true,
      fallbackAttempted: false,
    });
  });

  it("kills on same-chunk post-success partial bytes and cannot label them success", async () => {
    const hostile = Buffer.concat([jsonl(claudeSuccessEvents()), Buffer.from("{", "utf8")]);
    const result = await run(claudeRequest(outputScript([hostile], true)));
    expect(result).toMatchObject({
      streamDisposition: "stopped",
      streamFailureCode: "late-stream-event",
      providerRequests: 1,
      lateBytesObserved: true,
      killIssued: true,
      processGroupSettled: true,
    });
  });

  it("kills and reaps an incomplete Claude envelope at stdout EOF", async () => {
    const incomplete = Buffer.from(`${JSON.stringify(claudeInit())}\n{"type":"assistant"`, "utf8");
    const result = await run(claudeRequest(outputScript([incomplete])));
    expect(result).toMatchObject({
      streamDisposition: "stopped",
      streamFailureCode: "claude-stream-success-invalid",
      killIssued: true,
      processGroupSettled: true,
    });
  });

  it("rejects a Claude process request that tries to bypass the stream guard", () => {
    expect(() =>
      validateNativePilotProcessRequest(
        request("process.exit(0)", {
          harnessId: "claude-code",
          streamPolicy: { kind: "terminal-capture-v1" },
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: "invocation-policy" }));
  });

  it("requires the same exact five-name environment for both harnesses", () => {
    const valid = claudeRequest("process.exit(0)");
    expect(() => validateNativePilotProcessRequest(valid)).not.toThrow();
    const codexEnvironment = request("process.exit(0)").environment;
    const names = ["HOME", "LANG", "LC_ALL", "TMPDIR", "USER"];
    expect(Object.keys(valid.environment).sort()).toEqual(names);
    expect(Object.keys(codexEnvironment).sort()).toEqual(names);
    for (const environment of [
      { ...valid.environment, CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "1" },
      { ...valid.environment, EXTRA: "1" },
    ]) {
      expect(() => validateNativePilotProcessRequest({ ...valid, environment })).toThrowError(
        expect.objectContaining({ code: "environment-policy" }),
      );
    }
  });

  it("rejects a symlinked cwd that escapes the trusted temporary root", async () => {
    const outside = await realpath(await mkdtemp(join(tmpdir(), "docsfab-native-outside-")));
    const escapePath = join(root, "escape");
    await symlink(outside, escapePath);
    try {
      expect(() =>
        validateNativePilotProcessRequest(
          request("process.exit(0)", { workingDirectory: escapePath }),
        ),
      ).toThrowError(expect.objectContaining({ code: "environment-policy" }));
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("rejects path, environment, argument, and credential expansion before spawn", () => {
    expect(() =>
      validateNativePilotProcessRequest(request("process.exit(0)", { workingDirectory: "." })),
    ).toThrowError(expect.objectContaining({ code: "invalid-value" }));
    expect(() =>
      validateNativePilotProcessRequest(
        request("process.exit(0)", {
          environment: {
            ...request("process.exit(0)").environment,
            OPENAI_API_KEY: "not-allowed",
          },
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: "environment-policy" }));
    const { USER: _user, ...missingUser } = request("process.exit(0)").environment;
    expect(() =>
      validateNativePilotProcessRequest(request("process.exit(0)", { environment: missingUser })),
    ).toThrowError(expect.objectContaining({ code: "environment-policy" }));
    expect(() =>
      validateNativePilotProcessRequest(
        request("process.exit(0)", {
          environment: { ...request("process.exit(0)").environment, LOGNAME: "tester" },
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: "environment-policy" }));
    expect(() =>
      validateNativePilotProcessRequest(
        request("process.exit(0)", { arguments: ["-e", "bad\0argument"] }),
      ),
    ).toThrowError(expect.objectContaining({ code: "invalid-value" }));
    const secret = `sk-${"x".repeat(32)}`;
    let caught: unknown;
    try {
      validateNativePilotProcessRequest(
        request("process.exit(0)", { stdin: Buffer.from(secret, "utf8") }),
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(NativePilotProcessError);
    expect(caught).toMatchObject({ code: "credential-material" });
    expect(String(caught)).not.toContain(secret);
  });
});
