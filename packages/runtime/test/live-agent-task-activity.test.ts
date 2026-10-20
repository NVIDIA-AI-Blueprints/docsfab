// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { canonicalJson, sha256 } from "../src/content-ir/canonical.js";
import { limit } from "../src/config/limits.js";
import { TaskActivityCaptureError, TaskActivityRecorder } from "../src/live-agent/task-activity.js";
import type { LiveAgentTaskRequestV1 } from "../src/live-agent/task-contract.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const request: LiveAgentTaskRequestV1 = {
  schemaVersion: 1,
  kind: "docsfab-live-agent-task-request",
  taskId: "task-a",
  sessionId: "session-a",
  prompt: { encoding: "utf-8", text: "Check docs", sha256: sha256(Buffer.from("Check docs")) },
  baseline: { repositoryRevision: "a".repeat(40), contentSha256: "b".repeat(64) },
  sources: [],
  scope: { documentationRoots: ["docs"], requestedPaths: ["docs/guide.md"], writeClass: "none" },
  requiredEvidence: [],
  effectiveConfig: {
    profileId: null,
    modelId: null,
    configurationSha256: "c".repeat(64),
    values: {},
  },
};
const pi = (value: Record<string, unknown>) => value as unknown as AgentSessionEvent;
const lines = (bytes: Buffer) =>
  bytes
    .toString("utf8")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));

describe("public task activity", () => {
  it("binds a completed delegated session and physical requests to its saved child scope", () => {
    const recorder = new TaskActivityRecorder(request, {});
    const rootId = recorder.reserveSession();
    const root = recorder.attachPiSession(["docsfab_run_workflow"], {
      producerSessionId: rootId,
    });
    const rootProvider = recorder.attachProviderConnection(
      "route",
      "openai-chat-completions",
      "model",
      { producerSessionId: rootId },
    );
    rootProvider.started(1, 0, "parent-request");
    rootProvider.settled({
      requestSequence: 1,
      disposition: "complete",
      observedBytes: 1,
      bodySha256: hash("p"),
    });
    root(
      pi({
        type: "tool_execution_start",
        toolCallId: "same-call",
        toolName: "docsfab_run_workflow",
        args: { workflow: "readiness", instruction: "private" },
      }),
    );
    const childScopeId = recorder.openChildScope({
      parentChildScopeId: null,
      parentProducerSessionId: rootId,
      parentNativeToolCallId: "same-call",
      workflow: "readiness",
    });
    const childId = recorder.reserveSession();
    const childProvider = recorder.attachProviderConnection(
      "route",
      "openai-chat-completions",
      "model",
      { childScopeId, producerSessionId: childId },
    );
    const child = recorder.attachPiSession(["read", "canon_query"], {
      producerSessionId: childId,
      childScopeId,
      runId: "run-1",
      stepId: "analyze",
      attempt: 1,
    });
    childProvider.started(1, 0, "child-request");
    childProvider.settled({
      requestSequence: 1,
      disposition: "complete",
      observedBytes: 1,
      bodySha256: hash("c"),
    });
    child(
      pi({
        type: "tool_execution_start",
        toolCallId: "same-call",
        toolName: "read",
        args: { path: "docs/guide.md" },
      }),
    );
    child(
      pi({
        type: "tool_execution_end",
        toolCallId: "same-call",
        toolName: "read",
        result: { content: "private" },
        isError: false,
      }),
    );
    child.dispose();
    recorder.observeHostPatch({
      childScopeId,
      status: "not-needed",
      patchSha256: null,
      changeSummarySha256: null,
    });
    recorder.settleChildScope({
      childScopeId,
      status: "completed",
      persistence: "not-needed",
      recordId: "run-1",
      recordSha256: hash("saved-run"),
    });
    root(
      pi({
        type: "tool_execution_end",
        toolCallId: "same-call",
        toolName: "docsfab_run_workflow",
        result: {},
        isError: false,
      }),
    );
    root.dispose();
    const sealed = recorder.seal();
    const rows = lines(sealed.bytes);
    expect(sealed.status).toBe("complete");
    expect(rows[0].schemaVersion).toBe(2);
    expect(rows[0].instrumentation.sessions).toHaveLength(2);
    expect(rows[0].instrumentation.childScopes).toEqual([
      expect.objectContaining({
        childScopeId,
        parentProducerSessionId: rootId,
        parentNativeToolCallId: "same-call",
      }),
    ]);
    expect(rows[0].instrumentation.providerRoutes).toHaveLength(2);
    expect(rows.filter((row) => row.eventType === "host-patch")).toHaveLength(2);
    expect(sealed.bytes.toString()).not.toContain("private");
  });

  it("refuses unsafe linked session identities before they reach the public header", () => {
    const secret = "fixture-configured-private-step";
    const recorder = new TaskActivityRecorder(request, { API_KEY: secret });
    const rootId = recorder.reserveSession();
    expect(() =>
      recorder.attachPiSession(["read"], { producerSessionId: rootId, stepId: secret }),
    ).toThrowError(TaskActivityCaptureError);
    expect(() =>
      recorder.attachProviderConnection("route", "openai-responses", "model", {
        producerSessionId: secret,
      }),
    ).toThrowError(TaskActivityCaptureError);
    expect(() =>
      recorder.openChildScope({
        parentChildScopeId: secret,
        parentProducerSessionId: rootId,
        parentNativeToolCallId: "delegate",
        workflow: "readiness",
      }),
    ).toThrowError(TaskActivityCaptureError);
  });

  it("emits a paired null final child identity when the saved digest is unavailable", () => {
    const recorder = new TaskActivityRecorder(request, {});
    const root = recorder.attachPiSession(["docsfab_run_workflow"]);
    root(
      pi({
        type: "tool_execution_start",
        toolCallId: "delegate",
        toolName: "docsfab_run_workflow",
        args: { workflow: "readiness" },
      }),
    );
    const childScopeId = recorder.openChildScope({
      parentChildScopeId: null,
      parentProducerSessionId: root.producerSessionId,
      parentNativeToolCallId: "delegate",
      workflow: "readiness",
    });
    recorder.settleChildScope({
      childScopeId,
      status: "completed",
      persistence: "not-needed",
      recordId: "run-1",
      recordSha256: null,
    });
    const sealed = recorder.seal();
    const settlement = lines(sealed.bytes).find(
      (row) => row.eventType === "child-lifecycle" && row.phase === "settled",
    );
    expect(settlement).toMatchObject({ recordId: null, recordSha256: null });
    expect(lines(sealed.bytes).at(-1).coverage.child).toBe("incomplete");
  });

  it("seals native physical and Pi pairs with typed metadata and no raw content", () => {
    const recorder = new TaskActivityRecorder(request, {});
    const observe = recorder.attachPiSession(["read", "write"]);
    const provider = recorder.attachProviderConnection(
      "route",
      "openai-chat-completions",
      "model",
      {
        producerSessionId: observe.producerSessionId,
      },
    );
    provider.started(1, 0, '{"model":"model","secret":"private-prompt"}');
    provider.settled({
      requestSequence: 1,
      disposition: "complete",
      observedBytes: 2,
      httpStatus: 200,
      bodySha256: hash("ok"),
    });
    observe(
      pi({
        type: "tool_execution_start",
        toolCallId: "native-1",
        toolName: "read",
        args: { path: "docs/guide.md" },
      }),
    );
    observe(
      pi({
        type: "tool_execution_end",
        toolCallId: "native-1",
        toolName: "read",
        result: { content: "private-source" },
        isError: false,
      }),
    );
    observe.dispose();
    const sealed = recorder.seal();
    const records = lines(sealed.bytes);
    expect(sealed.status).toBe("complete");
    expect(records[0].kind).toBe("docsfab-task-activity-header");
    expect(records.at(-1).coverage).toEqual({
      provider: "complete",
      tools: "complete",
      source: "complete",
      web: "complete",
      workspace: "complete",
      child: "complete",
    });
    expect(records.slice(1, -1).map((row) => row.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(records[3]).toMatchObject({
      eventType: "provider-request",
      phase: "settled",
      bodySha256: hash("ok"),
    });
    expect(records[5]).toMatchObject({
      eventType: "tool-call",
      phase: "settled",
      resultSha256: hash(JSON.stringify({ content: "private-source" })),
    });
    expect(sealed.bytes.toString()).not.toContain("private-source");
    expect(sealed.bytes.toString()).not.toContain("private-prompt");
  });

  it("retains the actual known roster while a mapped read remains complete", () => {
    const recorder = new TaskActivityRecorder(request, {});
    const observe = recorder.attachPiSession(["read", "canon_query", "submit_quality_evaluation"]);
    const provider = recorder.attachProviderConnection(
      "route",
      "openai-chat-completions",
      "model",
      {
        producerSessionId: observe.producerSessionId,
      },
    );
    provider.started(1, 0, "request");
    provider.settled({
      requestSequence: 1,
      disposition: "complete",
      observedBytes: 2,
      bodySha256: hash("ok"),
    });
    observe(
      pi({
        type: "tool_execution_start",
        toolCallId: "mapped-read",
        toolName: "read",
        args: { path: "docs/guide.md" },
      }),
    );
    observe(
      pi({
        type: "tool_execution_end",
        toolCallId: "mapped-read",
        toolName: "read",
        result: {},
        isError: false,
      }),
    );
    observe.dispose();
    const sealed = recorder.seal();
    expect(sealed.status).toBe("complete");
    expect(lines(sealed.bytes)[0].instrumentation.sessions[0].toolNames).toEqual([
      "read",
      "canon_query",
      "submit_quality_evaluation",
    ]);
    expect(sealed.missing).toEqual([]);
  });

  it("marks an unknown unused roster name incomplete without narrowing it", () => {
    const recorder = new TaskActivityRecorder(request, {});
    const observe = recorder.attachPiSession(["read", "unknown_future_tool"]);
    const provider = recorder.attachProviderConnection(
      "route",
      "openai-chat-completions",
      "model",
      {
        producerSessionId: observe.producerSessionId,
      },
    );
    provider.started(1, 0, "request");
    provider.settled({
      requestSequence: 1,
      disposition: "complete",
      observedBytes: 2,
      bodySha256: hash("ok"),
    });
    observe.dispose();
    const sealed = recorder.seal();
    expect(lines(sealed.bytes)[0].instrumentation.sessions[0].toolNames).toEqual([
      "read",
      "unknown_future_tool",
    ]);
    expect(lines(sealed.bytes).at(-1).coverage.tools).toBe("incomplete");
    expect(sealed.missing).toContain("uninstrumented-tool");
  });

  it.each([
    ["canon_query", { canonJson: '{"private":true}' }],
    ["docsfab_recall_tool_result", { handle: "private-handle", byteOffset: 0 }],
  ])("keeps an invoked unprojected %s action explicitly incomplete", (toolName, args) => {
    const recorder = new TaskActivityRecorder(request, {});
    const observe = recorder.attachPiSession([toolName]);
    const provider = recorder.attachProviderConnection(
      "route",
      "openai-chat-completions",
      "model",
      {
        producerSessionId: observe.producerSessionId,
      },
    );
    provider.started(1, 0, "request");
    provider.settled({
      requestSequence: 1,
      disposition: "complete",
      observedBytes: 2,
      bodySha256: hash("ok"),
    });
    observe(
      pi({
        type: "tool_execution_start",
        toolCallId: "unsupported-call",
        toolName,
        args,
      }),
    );
    observe(
      pi({
        type: "tool_execution_end",
        toolCallId: "unsupported-call",
        toolName,
        result: {},
        isError: false,
      }),
    );
    observe.dispose();
    const sealed = recorder.seal();
    const rows = lines(sealed.bytes);
    expect(rows[0].instrumentation.sessions[0].toolNames).toEqual([toolName]);
    expect(
      rows.find((row) => row.eventType === "tool-call" && row.phase === "started").arguments,
    ).toEqual({ missing: "argument-projection" });
    expect(rows.at(-1).coverage.tools).toBe("incomplete");
    expect(sealed.missing).toContain("tool-action-unprojected");
    expect(sealed.bytes.toString()).not.toContain("private");
  });

  it("keeps child work and missing tool results explicitly incomplete", () => {
    const recorder = new TaskActivityRecorder(request, {});
    const observe = recorder.attachPiSession(["docsfab_run_workflow"]);
    const provider = recorder.attachProviderConnection(
      "route",
      "openai-chat-completions",
      "model",
      {
        producerSessionId: observe.producerSessionId,
      },
    );
    provider.started(1, 0, "body");
    provider.settled({
      requestSequence: 1,
      disposition: "complete",
      observedBytes: 2,
      bodySha256: hash("ok"),
    });
    observe(
      pi({
        type: "tool_execution_start",
        toolCallId: "workflow-1",
        toolName: "docsfab_run_workflow",
        args: { workflow: "review", instruction: "private instruction" },
      }),
    );
    const childScopeId = recorder.openChildScope({
      parentChildScopeId: null,
      parentProducerSessionId: observe.producerSessionId,
      parentNativeToolCallId: "workflow-1",
      workflow: "review",
    });
    recorder.settleChildScope({
      childScopeId,
      status: "refused",
      persistence: "unavailable",
      recordId: null,
      recordSha256: null,
    });
    observe.dispose();
    const sealed = recorder.seal();
    expect(sealed.status).toBe("incomplete");
    expect(sealed.missing).toContain("unsettled-tool-call");
    expect(sealed.missing).toContain("child-workflow-incomplete");
    expect(sealed.bytes.toString()).not.toContain("private instruction");
  });

  it("marks delegated work incomplete at invocation even when no child record is retained", () => {
    const recorder = new TaskActivityRecorder(request, {});
    const observe = recorder.attachPiSession(["docsfab_run_workflow"]);
    const provider = recorder.attachProviderConnection(
      "route",
      "openai-chat-completions",
      "model",
      {
        producerSessionId: observe.producerSessionId,
      },
    );
    provider.started(1, 0, "body");
    provider.settled({
      requestSequence: 1,
      disposition: "complete",
      observedBytes: 2,
      bodySha256: hash("ok"),
    });
    observe(
      pi({
        type: "tool_execution_start",
        toolCallId: "failed-child",
        toolName: "docsfab_run_workflow",
        args: { workflow: "create-documentation", instruction: "private instruction" },
      }),
    );
    observe(
      pi({
        type: "tool_execution_end",
        toolCallId: "failed-child",
        toolName: "docsfab_run_workflow",
        result: { error: "private child failure" },
        isError: true,
      }),
    );
    const childScopeId = recorder.openChildScope({
      parentChildScopeId: null,
      parentProducerSessionId: observe.producerSessionId,
      parentNativeToolCallId: "failed-child",
      workflow: "create-documentation",
    });
    recorder.settleChildScope({
      childScopeId,
      status: "refused",
      persistence: "unavailable",
      recordId: null,
      recordSha256: null,
    });
    observe.dispose();
    const sealed = recorder.seal();
    expect(sealed.status).toBe("incomplete");
    expect(sealed.missing).toContain("child-workflow-incomplete");
    expect(sealed.bytes.toString()).not.toContain("private child failure");
  });

  it.each(["taskId", "sessionId"])(
    "refuses an unsafe %s before exporting a bound artifact",
    (field) => {
      const unsafe = {
        ...request,
        [field]: "sk-abcdefghijklmnopqrstuvwxyz0123456789",
      };
      expect(() => new TaskActivityRecorder(unsafe, {})).toThrow(TaskActivityCaptureError);
      try {
        new TaskActivityRecorder(unsafe, {});
      } catch (error) {
        expect((error as Error).message).not.toContain(unsafe[field as keyof typeof unsafe]);
      }
    },
  );

  it("refuses a task identity containing an exact configured credential", () => {
    expect(
      () =>
        new TaskActivityRecorder(
          { ...request, taskId: "task-syntheticCredentialValue" },
          { DOCSFAB_MODEL_API_KEY: "syntheticCredentialValue" },
        ),
    ).toThrow(TaskActivityCaptureError);
  });

  it("redacts credential-shaped critical metadata instead of exporting it", () => {
    const recorder = new TaskActivityRecorder(request, {});
    const observe = recorder.attachPiSession(["read"]);
    recorder.attachProviderConnection("route", "openai-chat-completions", "model", {
      producerSessionId: observe.producerSessionId,
    });
    observe(
      pi({
        type: "tool_execution_start",
        toolCallId: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789",
        toolName: "read",
        args: { path: "docs/Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789" },
      }),
    );
    const sealed = recorder.seal();
    expect(sealed.status).toBe("redacted");
    expect(sealed.bytes.toString()).not.toContain("Authorization: Bearer");
    const toolStart = lines(sealed.bytes).find((row) => row.eventType === "tool-call");
    expect(toolStart.arguments.path).toEqual({ redacted: true });
    expect(toolStart.nativeId).toMatch(/^redacted-[a-f0-9]{64}$/u);
  });

  it("isolates overlapping tasks and treats late callbacks as sealed", () => {
    const first = new TaskActivityRecorder(request, {});
    const second = new TaskActivityRecorder(
      { ...request, taskId: "task-b", sessionId: "session-b" },
      {},
    );
    const firstPi = first.attachPiSession(["read"]);
    const secondPi = second.attachPiSession(["read"]);
    const firstProvider = first.attachProviderConnection(
      "route",
      "openai-chat-completions",
      "model",
      { producerSessionId: firstPi.producerSessionId },
    );
    const secondProvider = second.attachProviderConnection(
      "route",
      "openai-chat-completions",
      "model",
      { producerSessionId: secondPi.producerSessionId },
    );
    firstProvider.started(1, 0, "one");
    secondProvider.started(1, 0, "two");
    firstProvider.settled({
      requestSequence: 1,
      disposition: "complete",
      observedBytes: 3,
      bodySha256: hash("one"),
    });
    secondProvider.settled({
      requestSequence: 1,
      disposition: "complete",
      observedBytes: 3,
      bodySha256: hash("two"),
    });
    firstPi(
      pi({
        type: "tool_execution_start",
        toolCallId: "same",
        toolName: "read",
        args: { path: "docs/a.md" },
      }),
    );
    secondPi(
      pi({
        type: "tool_execution_start",
        toolCallId: "same",
        toolName: "read",
        args: { path: "docs/b.md" },
      }),
    );
    firstPi(
      pi({
        type: "tool_execution_end",
        toolCallId: "same",
        toolName: "read",
        result: {},
        isError: false,
      }),
    );
    secondPi(
      pi({
        type: "tool_execution_end",
        toolCallId: "same",
        toolName: "read",
        result: {},
        isError: false,
      }),
    );
    firstPi.dispose();
    secondPi.dispose();
    const sealedFirst = first.seal();
    const sealedSecond = second.seal();
    firstProvider.started(2, 1, "late");
    firstPi(
      pi({
        type: "tool_execution_start",
        toolCallId: "late",
        toolName: "read",
        args: { path: "docs/late.md" },
      }),
    );
    expect(sealedFirst.status).toBe("complete");
    expect(sealedSecond.status).toBe("complete");
    expect(sealedFirst.bytes.toString()).toContain("docs/a.md");
    expect(sealedFirst.bytes.toString()).not.toContain("docs/b.md");
    expect(sealedFirst.bytes.toString()).not.toContain("late");
    expect(sealedSecond.bytes.toString()).toContain("docs/b.md");
  });

  it("keeps the public field boundary exact and marks one byte beyond it clipped", () => {
    const boundary = limit("liveAgent.taskActivityFieldMaxBytes", { environment: {} }).value;
    const exact = new TaskActivityRecorder(request, {});
    const overflow = new TaskActivityRecorder(request, {});
    exact.attachPiSession(["read"])(
      pi({
        type: "tool_execution_start",
        toolCallId: "exact",
        toolName: "read",
        args: { path: "a".repeat(boundary) },
      }),
    );
    overflow.attachPiSession(["read"])(
      pi({
        type: "tool_execution_start",
        toolCallId: "over",
        toolName: "read",
        args: { path: "a".repeat(boundary + 1) },
      }),
    );
    const exactSeal = exact.seal();
    const overflowSeal = overflow.seal();
    expect(
      lines(exactSeal.bytes).find((row) => row.eventType === "tool-call").arguments.path,
    ).toHaveLength(boundary);
    expect(exactSeal.missing).not.toContain("clipped-path");
    expect(overflowSeal.status).toBe("clipped");
    expect(overflowSeal.missing).toContain("clipped-path");
    expect(
      lines(overflowSeal.bytes).find((row) => row.eventType === "tool-call").arguments.path,
    ).toEqual({ redacted: true });
  });

  it("keeps a contiguous prefix when an oversized tool start precedes a smaller result", () => {
    const recorder = new TaskActivityRecorder(request, {});
    const observe = recorder.attachPiSession(["docsfab_read_source"]);
    const provider = recorder.attachProviderConnection(
      "route",
      "openai-chat-completions",
      "model",
      {
        producerSessionId: observe.producerSessionId,
      },
    );
    provider.started(1, 0, "body");
    provider.settled({
      requestSequence: 1,
      disposition: "complete",
      observedBytes: 2,
      bodySha256: hash("ok"),
    });
    observe(
      pi({
        type: "tool_execution_start",
        toolCallId: "large-read",
        toolName: "docsfab_read_source",
        args: {
          source: "source-a",
          spanIds: Array.from({ length: 2_100 }, () => "x".repeat(8_192)),
        },
      }),
    );
    observe(
      pi({
        type: "tool_execution_end",
        toolCallId: "large-read",
        toolName: "docsfab_read_source",
        result: {},
        isError: false,
      }),
    );
    const sealed = recorder.seal();
    const records = lines(sealed.bytes);
    expect(sealed.status).toBe("clipped");
    expect(sealed.missing).toContain("activity-byte-bound");
    expect(records.slice(1, -1).map((row) => [row.eventType, row.phase])).toEqual([
      ["session-lifecycle", "started"],
      ["provider-request", "started"],
      ["provider-request", "settled"],
    ]);
    expect(records.at(-1).eventCount).toBe(3);
    expect(records.at(-1).lastSeq).toBe(3);
  });

  it("retains the largest ordered prefix at the capture bound and one byte beyond", () => {
    const captureBound = limit("liveAgent.taskActivityMaxBytes", { environment: {} }).value;
    const fieldBound = limit("liveAgent.taskActivityFieldMaxBytes", { environment: {} }).value;
    const probe = new TaskActivityRecorder(request, {});
    probe.attachPiSession(["docsfab_read_source"]);
    const firstLine = canonicalJson(lines(probe.seal().bytes)[1]);
    const firstEventBytes = Buffer.byteLength(firstLine, "utf8") + 1;
    const row = (ids: string[]) =>
      canonicalJson({
        schemaVersion: 2,
        kind: "docsfab-task-activity-event",
        seq: 2,
        requestSha256: probe.requestSha256,
        sessionId: request.sessionId,
        childScopeId: null,
        producer: "pi-session",
        eventType: "tool-call",
        phase: "started",
        status: "invoked",
        eventId: "pi:1:native-1:start",
        nativeId: "native-1",
        producerSessionId: "session-1",
        toolName: "docsfab_read_source",
        arguments: { source: "source-a", spanIds: ids },
      });
    const targetRowBytes = captureBound - firstEventBytes - 1;
    const emptyRowBytes = Buffer.byteLength(row([""]), "utf8");
    const fullIds = Math.ceil((targetRowBytes - emptyRowBytes - fieldBound) / (fieldBound + 3));
    const ids = Array.from({ length: fullIds }, () => "x".repeat(fieldBound));
    const remaining = targetRowBytes - Buffer.byteLength(row([...ids, ""]), "utf8");
    expect(remaining).toBeGreaterThanOrEqual(0);
    expect(remaining).toBeLessThanOrEqual(fieldBound);
    ids.push("y".repeat(remaining));
    expect(Buffer.byteLength(row(ids), "utf8") + 1 + firstEventBytes).toBe(captureBound);
    for (const tail of ["", "z"]) {
      const recorder = new TaskActivityRecorder(request, {});
      const observe = recorder.attachPiSession(["docsfab_read_source"]);
      observe(
        pi({
          type: "tool_execution_start",
          toolCallId: "native-1",
          toolName: "docsfab_read_source",
          args: { source: "source-a", spanIds: [...ids.slice(0, -1), `${ids.at(-1)}${tail}`] },
        }),
      );
      const sealed = recorder.seal();
      const rows = lines(sealed.bytes);
      expect(sealed.status).toBe("clipped");
      expect(sealed.bytes.byteLength).toBeLessThanOrEqual(captureBound);
      expect(rows.slice(1, -1).map((event) => event.seq)).toEqual([1]);
      expect(rows.at(-1)).toMatchObject({ eventCount: 1, lastSeq: 1 });
    }
  });

  it("marks child coverage clipped when envelope bytes remove a final settlement", () => {
    const capture = (ids: string[]) => {
      const recorder = new TaskActivityRecorder(request, {});
      const root = recorder.attachPiSession(["docsfab_run_workflow"]);
      const rootProvider = recorder.attachProviderConnection("route", "openai-responses", "model", {
        producerSessionId: root.producerSessionId,
      });
      rootProvider.started(1, 0, "root");
      rootProvider.settled({
        requestSequence: 1,
        disposition: "complete",
        observedBytes: 2,
        bodySha256: hash("ok"),
      });
      root(
        pi({
          type: "tool_execution_start",
          toolCallId: "delegate",
          toolName: "docsfab_run_workflow",
          args: { workflow: "readiness" },
        }),
      );
      const childScopeId = recorder.openChildScope({
        parentChildScopeId: null,
        parentProducerSessionId: root.producerSessionId,
        parentNativeToolCallId: "delegate",
        workflow: "readiness",
      });
      const child = recorder.attachPiSession(["docsfab_read_source"], {
        childScopeId,
        runId: "run-1",
        stepId: "analyze",
        attempt: 1,
      });
      const childProvider = recorder.attachProviderConnection(
        "route",
        "openai-responses",
        "model",
        { producerSessionId: child.producerSessionId, childScopeId },
      );
      childProvider.started(1, 0, "child");
      childProvider.settled({
        requestSequence: 1,
        disposition: "complete",
        observedBytes: 2,
        bodySha256: hash("ok"),
      });
      child(
        pi({
          type: "tool_execution_start",
          toolCallId: "read",
          toolName: "docsfab_read_source",
          args: { source: "source-a", spanIds: ids },
        }),
      );
      child(
        pi({
          type: "tool_execution_end",
          toolCallId: "read",
          toolName: "docsfab_read_source",
          result: {},
          isError: false,
        }),
      );
      child.dispose();
      recorder.observeHostPatch({
        childScopeId,
        status: "not-needed",
        patchSha256: null,
        changeSummarySha256: null,
      });
      recorder.settleChildScope({
        childScopeId,
        status: "completed",
        persistence: "not-needed",
        recordId: "run-1",
        recordSha256: hash("saved"),
      });
      root(
        pi({
          type: "tool_execution_end",
          toolCallId: "delegate",
          toolName: "docsfab_run_workflow",
          result: {},
          isError: false,
        }),
      );
      root.dispose();
      return recorder.seal();
    };
    const baseline = lines(capture([]).bytes);
    const eventBytes = baseline
      .slice(1, -1)
      .reduce((total, row) => total + Buffer.byteLength(canonicalJson(row), "utf8") + 1, 0);
    const bound = limit("liveAgent.taskActivityMaxBytes", { environment: {} }).value;
    const fieldBound = limit("liveAgent.taskActivityFieldMaxBytes", { environment: {} }).value;
    const extra = bound - 100 - eventBytes;
    const ids = Array.from({ length: Math.floor(extra / (fieldBound + 3)) }, () =>
      "x".repeat(fieldBound),
    );
    const used = ids.length * (fieldBound + 3) - 1;
    if (extra - used >= 3) ids.push("y".repeat(extra - used - 3));
    const sealed = capture(ids);
    const rows = lines(sealed.bytes);
    const events = rows.slice(1, -1);
    expect(sealed.bytes.byteLength).toBeLessThanOrEqual(bound);
    expect(sealed.status).toBe("clipped");
    expect(rows.at(-1).coverage.child).toBe("clipped");
    expect(
      events.some((event) => event.eventType === "child-lifecycle" && event.phase === "settled"),
    ).toBe(false);
    expect(events.map((event) => event.seq)).toEqual(
      Array.from({ length: events.length }, (_, index) => index + 1),
    );
  });
});
