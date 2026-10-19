// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Public, content-free activity from one noninteractive task. */
import { createHash } from "node:crypto";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { ProviderResponseObservationV1 } from "../records/contracts.js";
import { canonicalJson } from "../content-ir/canonical.js";
import { limit } from "../config/limits.js";
import { redactCredentialMaterial } from "../security/credential-material.js";
import { containsTextCredentialShape } from "../security/text-credential-shapes.js";
import type { PiActivitySession, TaskActivityObserver } from "../activity/observer.js";
import { liveAgentTaskRequestSha256, type LiveAgentTaskRequestV1 } from "./task-contract.js";

export type TaskActivityCoverage =
  | "complete"
  | "incomplete"
  | "unavailable"
  | "redacted"
  | "clipped";
export type TaskActivityCategory = "provider" | "tools" | "source" | "web" | "workspace" | "child";

export interface TaskActivitySealed {
  readonly bytes: Buffer;
  readonly status: TaskActivityCoverage;
  readonly missing: readonly string[];
}

/** Safe, stable refusal when an exact public task binding cannot be exported. */
export class TaskActivityCaptureError extends Error {
  readonly code = "activity-identity-unsafe";

  constructor() {
    super("Task activity identity cannot be exported without a safe binding.");
  }
}

type JsonRecord = Record<string, unknown>;
const CATEGORIES: readonly TaskActivityCategory[] = [
  "provider",
  "tools",
  "source",
  "web",
  "workspace",
  "child",
];
/** An unchanged confined roster can include tools this capture does not yet project. */
const KNOWN_TOOLS = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "edit",
  "write",
  "docsfab_use_skill",
  "docsfab_run_workflow",
  "docsfab_read_gitlab",
  "docsfab_read_run",
  "docsfab_read_source",
  "docsfab_list_sources",
  "docsfab_recall_tool_result",
  "canon_query",
  "canon_conflict_gap",
  "canon_affected_docs",
  "canon_validate_citations",
  "canon_propose_claim",
  "canon_submit_artifact",
  "get_section",
  "docsfab_read_preservation_source",
  "docsfab_search_sources",
  "docsfab_cite_source",
  "docsfab_history_blame",
  "docsfab_history_show",
  "docsfab_history_diff",
  "docsfab_history_log",
  "docsfab_history_search",
  "validate_quality_candidate",
  "submit_quality_evaluation",
  "submit_answer_record",
]);
const WORKSPACE_TOOLS = new Set(["edit", "write"]);
const ARGUMENT_KEYS: Readonly<Record<string, readonly string[]>> = {
  read: ["path", "offset", "limit"],
  grep: ["pattern", "path", "glob", "ignoreCase", "literal", "context", "limit"],
  find: ["pattern", "path", "limit"],
  ls: ["path", "limit"],
  edit: ["path", "edits"],
  write: ["path", "content"],
  docsfab_use_skill: ["skill", "reference", "readerContext", "readerComparison", "readerSources"],
  docsfab_run_workflow: ["workflow", "instruction", "context"],
  docsfab_read_gitlab: ["operation", "iid", "page", "limit"],
  docsfab_read_run: ["runId", "stepId"],
  docsfab_read_source: [
    "source",
    "observationId",
    "representationId",
    "spanIds",
    "fromByte",
    "maxBytes",
    "diffFile",
    "diffHunk",
  ],
  docsfab_list_sources: [],
};
/** Only these invoked actions have reviewed, content-free argument projections. */
const FULLY_PROJECTED_TOOLS = new Set(Object.keys(ARGUMENT_KEYS));

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function digest(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Capture only fields that identify an action; no prompt, source text, or result body. */
export class TaskActivityRecorder implements TaskActivityObserver {
  readonly #request: LiveAgentTaskRequestV1;
  readonly #requestSha256: string;
  readonly #maxBytes: number;
  readonly #maxFieldBytes: number;
  readonly #configuredCredentialValues: readonly string[];
  readonly #events: JsonRecord[] = [];
  readonly #missing = new Set<string>();
  readonly #coverage = new Map<TaskActivityCategory, TaskActivityCoverage>();
  readonly #openTools = new Map<string, string>();
  readonly #openProviders = new Set<string>();
  readonly #openResources = new Set<string>();
  readonly #seenToolIds = new Set<string>();
  readonly #seenProviderIds = new Set<string>();
  readonly #toolNames = new Set<string>();
  readonly #sessions: JsonRecord[] = [];
  readonly #providerRoutes: JsonRecord[] = [];
  readonly #childScopes: JsonRecord[] = [];
  readonly #settledScopes = new Set<string>();
  readonly #scopeRecords = new Set<string>();
  readonly #sessionStates = new Map<
    string,
    { readonly childScopeId: string | null; disposed: boolean }
  >();
  #sessionStarted = false;
  #connectionStarted = false;
  #closed = false;
  #sealing = false;
  #eventClipped = false;
  #bytes = 0;
  #seq = 0;
  #toolSession = 0;
  #providerConnection = 0;
  #childScope = 0;
  #operation = 0;

  constructor(request: LiveAgentTaskRequestV1, environment: NodeJS.ProcessEnv = process.env) {
    this.#request = request;
    this.#requestSha256 = liveAgentTaskRequestSha256(request);
    this.#maxBytes = limit("liveAgent.taskActivityMaxBytes", { environment }).value;
    this.#maxFieldBytes = limit("liveAgent.taskActivityFieldMaxBytes", { environment }).value;
    this.#configuredCredentialValues = Object.entries(environment)
      .filter(
        ([name, value]) =>
          /(?:KEY|TOKEN|SECRET|PASSWORD|AUTHORIZATION)/iu.test(name) &&
          typeof value === "string" &&
          value !== "",
      )
      .map(([, value]) => value as string);
    if (!this.#safeIdentity(request.taskId) || !this.#safeIdentity(request.sessionId))
      throw new TaskActivityCaptureError();
    for (const category of CATEGORIES) this.#coverage.set(category, "complete");
  }

  get requestSha256(): string {
    return this.#requestSha256;
  }

  /** Reserve identity before a connection opens; creation waits for the actual Pi session. */
  reserveSession(): string {
    return `session-${++this.#toolSession}`;
  }

  /** The actual Pi session and installed tool roster, after host assembly. */
  attachPiSession(
    toolNames: readonly string[],
    identity: {
      readonly producerSessionId?: string;
      readonly childScopeId?: string | null;
      readonly runId?: string | null;
      readonly stepId?: string | null;
      readonly attempt?: number | null;
    } = {},
  ): PiActivitySession {
    const producerSessionId = identity.producerSessionId ?? this.reserveSession();
    this.#assertSafeIdentity(producerSessionId);
    this.#assertSafeOptionalIdentity(identity.childScopeId);
    this.#assertSafeOptionalIdentity(identity.runId);
    this.#assertSafeOptionalIdentity(identity.stepId);
    this.#sessionStarted = true;
    const session = Number(/^session-(\d+)$/u.exec(producerSessionId)?.[1]);
    if (!Number.isSafeInteger(session) || this.#sessionStates.has(producerSessionId)) {
      this.mark("tools", "invalid-session-identity");
    }
    const childScopeId = identity.childScopeId ?? null;
    this.#sessionStates.set(producerSessionId, { childScopeId, disposed: false });
    const names: string[] = [];
    for (const name of toolNames) {
      const publicName = this.#publicId(name, "tool-name", "tools");
      this.#toolNames.add(publicName);
      names.push(publicName);
      if (!KNOWN_TOOLS.has(name)) this.mark("tools", "uninstrumented-tool");
    }
    this.#sessions.push({
      producerSessionId,
      childScopeId,
      runId: identity.runId ?? null,
      stepId: identity.stepId ?? null,
      attempt: identity.attempt ?? null,
      toolNames: [...new Set(names)],
    });
    this.append({
      producer: "pi-session",
      eventType: "session-lifecycle",
      phase: "started",
      status: "created",
      eventId: `session:${producerSessionId}:start`,
      nativeId: null,
      producerSessionId,
      childScopeId,
    });
    const observe = (event: AgentSessionEvent) => {
      if (this.#sessionStates.get(producerSessionId)?.disposed) {
        this.mark("tools", "tool-event-after-session-disposal");
        return;
      }
      this.observePi(event, session, childScopeId);
    };
    return Object.assign(observe, {
      producerSessionId,
      observe,
      dispose: () => {
        const state = this.#sessionStates.get(producerSessionId);
        if (!state || state.disposed) {
          this.mark("tools", "duplicate-session-disposal");
          return;
        }
        state.disposed = true;
        if ([...this.#openTools.keys()].some((key) => key.startsWith(`${session}:`)))
          this.mark("tools", "session-disposed-with-open-tools");
        const connections = this.#providerRoutes
          .filter((route) => route.producerSessionId === producerSessionId)
          .map((route) => route.connectionId);
        if (
          [...this.#openProviders].some((key) =>
            connections.some((connectionId) =>
              key.startsWith(`${String(connectionId).replace(/^connection-/u, "")}:`),
            ),
          )
        )
          this.mark("provider", "session-disposed-with-open-provider-request");
        this.append({
          producer: "pi-session",
          eventType: "session-lifecycle",
          phase: "settled",
          status: "disposed",
          eventId: `session:${producerSessionId}:end`,
          nativeId: null,
          producerSessionId,
          childScopeId,
        });
      },
    });
  }

  /** A connection-local observer; physical sequences are only unique within this scope. */
  attachProviderConnection(
    routeId: string,
    transport: string,
    modelId: string,
    identity: {
      readonly childScopeId?: string | null;
      readonly producerSessionId?: string | null;
    } = {},
  ) {
    this.#assertSafeOptionalIdentity(identity.childScopeId);
    this.#assertSafeOptionalIdentity(identity.producerSessionId);
    this.#connectionStarted = true;
    const connection = ++this.#providerConnection;
    const base = {
      routeId: this.#publicId(routeId, "route-id", "provider"),
      transport: this.#publicId(transport, "transport", "provider"),
      modelId: this.#publicId(modelId, "model-id", "provider"),
    };
    const childScopeId = identity.childScopeId ?? null;
    const producerSessionId = identity.producerSessionId ?? null;
    if (!producerSessionId) this.mark("provider", "provider-session-unavailable");
    const afterDispose = () =>
      producerSessionId !== null && this.#sessionStates.get(producerSessionId)?.disposed === true;
    this.#providerRoutes.push({
      connectionId: `connection-${connection}`,
      ...base,
      childScopeId,
      producerSessionId,
    });
    return {
      failed: () => {
        this.mark("provider", "provider-observer-failed", "unavailable");
      },
      started: (
        requestSequence: number,
        turn: number | null,
        body: BodyInit | null | undefined,
      ) => {
        if (afterDispose()) {
          this.mark("provider", "provider-request-after-session-disposal");
          return;
        }
        const nativeId = String(requestSequence);
        const key = `${connection}:${nativeId}`;
        if (this.#seenProviderIds.has(key)) this.mark("provider", "duplicate-provider-request-id");
        this.#seenProviderIds.add(key);
        this.#openProviders.add(key);
        const bytes = typeof body === "string" ? Buffer.from(body, "utf8") : null;
        if (bytes === null) this.mark("provider", "provider-request-body-unavailable");
        this.append({
          producer: "provider-transport",
          eventType: "provider-request",
          phase: "started",
          status: "sent",
          eventId: `provider:${connection}:${nativeId}:start`,
          nativeId,
          connectionId: `connection-${connection}`,
          childScopeId,
          ...base,
          turn,
          bodyBytes: bytes?.byteLength ?? null,
          bodySha256: bytes ? digest(bytes) : null,
        });
      },
      settled: (observation: ProviderResponseObservationV1) => {
        if (afterDispose()) {
          this.mark("provider", "provider-response-after-session-disposal");
          return;
        }
        const nativeId = String(observation.requestSequence);
        const key = `${connection}:${nativeId}`;
        if (!this.#openProviders.delete(key)) this.mark("provider", "orphan-provider-result");
        this.append({
          producer: "provider-transport",
          eventType: "provider-request",
          phase: "settled",
          status: observation.disposition,
          eventId: `provider:${connection}:${nativeId}:end`,
          nativeId,
          connectionId: `connection-${connection}`,
          childScopeId,
          ...base,
          observedBytes: observation.observedBytes,
          bodySha256: observation.bodySha256 ?? null,
          httpStatus: observation.httpStatus ?? null,
        });
      },
      streamError: (requestSequence: number, errorClass: string) => {
        if (afterDispose()) {
          this.mark("provider", "provider-stream-after-session-disposal");
          return;
        }
        const nativeId = String(requestSequence);
        this.append({
          producer: "provider-transport",
          eventType: "provider-stream-error",
          phase: "settled",
          status: errorClass,
          eventId: `provider:${connection}:${nativeId}:stream-error`,
          nativeId,
          connectionId: `connection-${connection}`,
          childScopeId,
          ...base,
        });
      },
    };
  }

  openChildScope(input: {
    readonly parentChildScopeId: string | null;
    readonly parentProducerSessionId: string;
    readonly parentNativeToolCallId: string;
    readonly workflow: string;
  }): string {
    this.#assertSafeOptionalIdentity(input.parentChildScopeId);
    const childScopeId = `child-scope-${++this.#childScope}`;
    const scope = {
      childScopeId,
      parentChildScopeId: input.parentChildScopeId,
      parentProducerSessionId: this.#publicId(
        input.parentProducerSessionId,
        "parent-session-id",
        "child",
      ),
      parentNativeToolCallId: this.#publicId(
        input.parentNativeToolCallId,
        "parent-tool-call-id",
        "child",
      ),
      workflow: this.#publicId(input.workflow, "workflow", "child"),
    };
    this.#childScopes.push(scope);
    this.append({
      producer: "child-workflow",
      eventType: "child-lifecycle",
      phase: "started",
      status: "invoked",
      eventId: `${childScopeId}:start`,
      nativeId: null,
      childScopeId,
    });
    return childScopeId;
  }

  settleChildScope(input: {
    readonly childScopeId: string;
    readonly status: "completed" | "failed" | "cancelled" | "refused";
    readonly persistence:
      | "applied"
      | "already-applied"
      | "not-needed"
      | "not-applied"
      | "failed"
      | "unavailable";
    readonly recordId: string | null;
    readonly recordSha256: string | null;
  }): void {
    if (this.#settledScopes.has(input.childScopeId)) return;
    this.#assertSafeIdentity(input.childScopeId);
    this.#settledScopes.add(input.childScopeId);
    const declaredRecordId = input.recordId
      ? this.#publicId(input.recordId, "child-record-id", "child")
      : null;
    if (declaredRecordId) {
      if (this.#scopeRecords.has(declaredRecordId)) this.mark("child", "duplicate-child-record");
      this.#scopeRecords.add(declaredRecordId);
    }
    const validDigest =
      input.recordSha256 && /^[a-f0-9]{64}$/u.test(input.recordSha256) ? input.recordSha256 : null;
    if (input.recordSha256 && !validDigest) this.mark("child", "invalid-child-record-digest");
    // The final lifecycle has one atomic saved-record identity. A record known
    // from the native inventory but lacking its saved digest is not a snapshot.
    const recordId = declaredRecordId && validDigest ? declaredRecordId : null;
    const recordSha256 = recordId ? validDigest : null;
    if (!recordId || input.status !== "completed") this.mark("child", "child-workflow-incomplete");
    const childSessions = this.#sessions.filter(
      (session) => session.childScopeId === input.childScopeId,
    );
    if (!childSessions.length) this.mark("child", "child-session-unobserved");
    if (declaredRecordId && childSessions.some((session) => session.runId !== declaredRecordId))
      this.mark("child", "child-session-run-mismatch");
    if (!this.#providerRoutes.some((route) => route.childScopeId === input.childScopeId))
      this.mark("provider", "child-provider-unobserved");
    if (
      !this.#events.some(
        (event) =>
          event.childScopeId === input.childScopeId &&
          event.eventType === "tool-call" &&
          event.phase === "started",
      )
    )
      this.mark("tools", "child-tool-unobserved");
    if (
      input.persistence === "failed" ||
      input.persistence === "unavailable" ||
      input.persistence === "not-applied"
    )
      this.mark("workspace", "child-persistence-unavailable");
    if (input.status === "completed") {
      const patches = this.#events.filter(
        (event) =>
          event.childScopeId === input.childScopeId &&
          event.eventType === "host-patch" &&
          event.phase === "settled",
      );
      if (patches.length !== 1 || patches[0]?.status !== input.persistence)
        this.mark("workspace", "child-persistence-patch-mismatch");
    }
    this.append({
      producer: "child-workflow",
      eventType: "child-lifecycle",
      phase: "settled",
      status: input.status,
      eventId: `${input.childScopeId}:end`,
      nativeId: null,
      childScopeId: input.childScopeId,
      persistence: input.persistence,
      recordId,
      recordSha256,
    });
  }

  /** The export inventory must be exactly the saved records observed at settlement. */
  reconcileNativeChildRecords(
    records: readonly { readonly recordId: string; readonly recordSha256: string | null }[],
  ): void {
    const settled = this.#events.filter(
      (event) => event.eventType === "child-lifecycle" && event.phase === "settled",
    );
    if (settled.length !== records.length) this.mark("child", "child-inventory-count-mismatch");
    const expected = new Map<string, string | null>();
    for (const record of records) {
      if (expected.has(record.recordId)) this.mark("child", "duplicate-exported-child-record");
      expected.set(record.recordId, record.recordSha256);
    }
    for (const event of settled) {
      if (
        typeof event.recordId !== "string" ||
        !expected.has(event.recordId) ||
        expected.get(event.recordId) !== event.recordSha256
      )
        this.mark("child", "child-inventory-digest-mismatch");
    }
  }

  observeHostPatch(input: {
    readonly childScopeId: string;
    readonly status:
      | "applied"
      | "already-applied"
      | "not-needed"
      | "not-applied"
      | "failed"
      | "unavailable";
    readonly patchSha256: string | null;
    readonly changeSummarySha256: string | null;
  }): void {
    const operationId = `host-patch-${++this.#operation}`;
    const patchSha256 =
      input.patchSha256 && /^[a-f0-9]{64}$/u.test(input.patchSha256) ? input.patchSha256 : null;
    const changeSummarySha256 =
      input.changeSummarySha256 && /^[a-f0-9]{64}$/u.test(input.changeSummarySha256)
        ? input.changeSummarySha256
        : null;
    if ((input.patchSha256 && !patchSha256) || (input.changeSummarySha256 && !changeSummarySha256))
      this.mark("workspace", "invalid-host-patch-digest");
    if (
      (input.status === "applied" || input.status === "already-applied") &&
      (!patchSha256 || !changeSummarySha256)
    )
      this.mark("workspace", "host-patch-digest-unavailable");
    if (input.status === "not-needed" && (patchSha256 || changeSummarySha256))
      this.mark("workspace", "unexpected-host-patch-digest");
    if (
      input.status === "failed" ||
      input.status === "unavailable" ||
      input.status === "not-applied"
    )
      this.mark("workspace", "host-patch-unavailable");
    this.append({
      producer: "host-workspace",
      eventType: "host-patch",
      phase: "started",
      status: "invoked",
      eventId: `${operationId}:start`,
      nativeId: null,
      childScopeId: input.childScopeId,
      operationId,
      patchSha256,
    });
    this.append({
      producer: "host-workspace",
      eventType: "host-patch",
      phase: "settled",
      status: input.status,
      eventId: `${operationId}:end`,
      nativeId: null,
      childScopeId: input.childScopeId,
      operationId,
      patchSha256,
      changeSummarySha256,
    });
  }

  startResource(input: {
    readonly childScopeId: string | null;
    readonly resourceKind:
      | "prepared-source"
      | "repository-source"
      | "skill-instruction"
      | "change-request";
    readonly operation: "bind" | "read" | "load";
    readonly resourceId: string | null;
    readonly path: string | null;
    readonly fromByte: number | null;
    readonly maxBytes: number | null;
  }): (result: {
    readonly status: "ok" | "failed" | "cancelled" | "unavailable";
    readonly bytes: Uint8Array | null;
  }) => void {
    const operationId = `resource-${++this.#operation}`;
    this.#openResources.add(operationId);
    const category = input.resourceKind === "change-request" ? "web" : "source";
    let resourceId: string | null = null;
    if (input.resourceId) {
      if (/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(input.resourceId))
        resourceId = this.#publicId(input.resourceId, "resource-id", category);
      else this.mark(category, "unsafe-resource-id");
    }
    const path = input.path ? this.#safeRelativePath(input.path, category) : null;
    const fields = {
      operationId,
      resourceKind: input.resourceKind,
      operation: input.operation,
      resourceId,
      path,
      fromByte: input.fromByte,
      maxBytes: input.maxBytes,
    };
    this.append({
      producer: "host-source",
      eventType: "resource-operation",
      phase: "started",
      status: "invoked",
      eventId: `${operationId}:start`,
      nativeId: null,
      childScopeId: input.childScopeId,
      ...fields,
    });
    let settled = false;
    return (result) => {
      if (settled) {
        this.mark(category, "duplicate-resource-settlement");
        return;
      }
      settled = true;
      this.#openResources.delete(operationId);
      if (result.status !== "ok" || (input.operation !== "bind" && !result.bytes))
        this.mark(category, "resource-observation-incomplete");
      this.append({
        producer: "host-source",
        eventType: "resource-operation",
        phase: "settled",
        status: result.status,
        eventId: `${operationId}:end`,
        nativeId: null,
        childScopeId: input.childScopeId,
        ...fields,
        observedBytes: result.bytes?.byteLength ?? null,
        bodySha256: result.bytes ? digest(result.bytes) : null,
      });
    };
  }

  #safeRelativePath(value: string, category: TaskActivityCategory): string | null {
    const safe = this.#safeField(value, "resource-path", category);
    if (
      safe === null ||
      safe.startsWith("/") ||
      /^[A-Za-z]:/u.test(safe) ||
      safe.includes("\\") ||
      safe.split("/").some((part) => !part || part === "." || part === "..")
    ) {
      this.mark(category, "invalid-resource-path");
      return null;
    }
    return safe;
  }

  mark(
    category: TaskActivityCategory,
    reason: string,
    status: TaskActivityCoverage = "incomplete",
  ): void {
    if (this.#closed && !this.#sealing) return;
    this.#missing.add(reason);
    const current = this.#coverage.get(category) ?? "complete";
    const rank: Record<TaskActivityCoverage, number> = {
      complete: 0,
      incomplete: 1,
      unavailable: 2,
      redacted: 3,
      clipped: 4,
    };
    if (rank[status] > rank[current]) this.#coverage.set(category, status);
  }

  observePi(event: AgentSessionEvent, session: number, childScopeId: string | null = null): void {
    if (this.#closed) return;
    try {
      if (event.type === "tool_execution_start") {
        const nativeId = this.#publicId(event.toolCallId, "tool-call-id", "tools");
        const key = `${session}:${nativeId}`;
        if (this.#seenToolIds.has(key)) this.mark("tools", "duplicate-tool-call-id");
        this.#seenToolIds.add(key);
        const toolName = this.#publicId(event.toolName, "tool-name", "tools");
        this.#openTools.set(key, toolName);
        if (!KNOWN_TOOLS.has(event.toolName)) this.mark("tools", "unknown-tool");
        const args = this.projectArguments(event.toolName, event.args);
        this.append({
          producer: "pi-session",
          eventType: "tool-call",
          phase: "started",
          status: "invoked",
          eventId: `pi:${session}:${encodeURIComponent(nativeId)}:start`,
          nativeId,
          producerSessionId: `session-${session}`,
          childScopeId,
          toolName,
          arguments: args,
        });
      } else if (event.type === "tool_execution_end") {
        const nativeId = this.#publicId(event.toolCallId, "tool-call-id", "tools");
        const key = `${session}:${nativeId}`;
        const startedName = this.#openTools.get(key);
        if (startedName === undefined) this.mark("tools", "orphan-tool-result");
        const toolName = this.#publicId(event.toolName, "tool-name", "tools");
        if (startedName !== undefined && startedName !== toolName)
          this.mark("tools", "mismatched-tool-result");
        this.#openTools.delete(key);
        let resultBytes: Buffer | null = null;
        try {
          const serialized = JSON.stringify(event.result);
          if (serialized !== undefined) resultBytes = Buffer.from(serialized, "utf8");
        } catch {
          /* a result the recorder cannot serialize is explicit below */
        }
        if (!resultBytes) this.mark("tools", "tool-result-digest-unavailable");
        this.append({
          producer: "pi-session",
          eventType: "tool-call",
          phase: "settled",
          status: event.isError ? "error" : "ok",
          eventId: `pi:${session}:${encodeURIComponent(nativeId)}:end`,
          nativeId,
          producerSessionId: `session-${session}`,
          childScopeId,
          toolName,
          resultBytes: resultBytes?.byteLength ?? null,
          resultSha256: resultBytes ? digest(resultBytes) : null,
        });
      }
    } catch {
      this.mark("tools", "tool-observer-failed", "unavailable");
    }
  }

  #safeField(value: unknown, field: string, category: TaskActivityCategory): string | null {
    if (typeof value !== "string") {
      this.mark(category, `missing-${field}`);
      return null;
    }
    if (Buffer.byteLength(value, "utf8") > this.#maxFieldBytes) {
      this.mark(category, `clipped-${field}`, "clipped");
      return null;
    }
    if (
      this.#hasCredential(value) ||
      /[\p{Cc}\p{Cf}]/u.test(value) ||
      value !== value.normalize("NFC")
    ) {
      this.mark(category, `redacted-${field}`, "redacted");
      return null;
    }
    return value;
  }

  #hasCredential(value: string): boolean {
    return (
      redactCredentialMaterial(value) !== value ||
      containsTextCredentialShape(value) ||
      this.#configuredCredentialValues.some((credential) => value.includes(credential))
    );
  }

  #publicId(value: unknown, field: string, category: TaskActivityCategory): string {
    const safe = this.#safeField(value, field, category);
    if (safe !== null && safe.length > 0) return safe;
    this.mark(category, `unsafe-${field}`, "redacted");
    return `redacted-${digest(typeof value === "string" ? value : "invalid-id")}`;
  }

  projectArguments(toolName: string, raw: unknown): JsonRecord {
    if (!FULLY_PROJECTED_TOOLS.has(toolName)) {
      this.mark("tools", "tool-action-unprojected");
      return { missing: "argument-projection" };
    }
    const args = record(raw);
    if (!args) {
      this.mark("tools", "tool-arguments-unavailable");
      return { missing: "arguments" };
    }
    const projected: JsonRecord = {};
    const allowed = ARGUMENT_KEYS[toolName];
    if (!allowed || Object.keys(args).some((key) => !allowed.includes(key)))
      this.mark("tools", "tool-arguments-uninstrumented");
    const path = args.path;
    if (path !== undefined) {
      projected.path = this.#safeField(
        path,
        "path",
        WORKSPACE_TOOLS.has(toolName) ? "workspace" : "source",
      ) ?? { redacted: true };
    }
    const query = args.pattern ?? args.query;
    if (query !== undefined)
      projected.query = this.#safeField(query, "query", "source") ?? { redacted: true };
    if (args.glob !== undefined)
      projected.glob = this.#safeField(args.glob, "glob", "source") ?? { redacted: true };
    for (const field of ["offset", "limit", "context"]) {
      if (args[field] !== undefined) {
        if (
          typeof args[field] !== "number" ||
          !Number.isSafeInteger(args[field]) ||
          args[field] < 0
        )
          this.mark("tools", `invalid-${field}`);
        else projected[field] = args[field];
      }
    }
    for (const field of ["ignoreCase", "literal"]) {
      if (args[field] !== undefined) {
        if (typeof args[field] !== "boolean") this.mark("tools", `invalid-${field}`);
        else projected[field] = args[field];
      }
    }
    if (toolName === "ls" && args.path === undefined) projected.scope = "workspace-root";
    if (args.url !== undefined) {
      const url = this.#safeField(args.url, "url", "web");
      if (url === null) projected.url = { redacted: true };
      else {
        try {
          const parsed = new URL(url);
          if (parsed.username || parsed.password || parsed.search || parsed.hash) {
            projected.url = { redacted: true };
            this.mark("web", "redacted-url", "redacted");
          } else projected.url = url;
        } catch {
          projected.url = { redacted: true };
          this.mark("web", "invalid-url");
        }
      }
    }
    if (args.command !== undefined)
      projected.command = this.#safeField(args.command, "command", "web") ?? { redacted: true };
    if (toolName === "docsfab_read_gitlab") {
      projected.operation = this.#safeField(args.operation, "operation", "web") ?? {
        redacted: true,
      };
      for (const field of ["iid", "page"])
        if (args[field] !== undefined) {
          if (
            typeof args[field] !== "number" ||
            !Number.isSafeInteger(args[field]) ||
            args[field] < 1
          )
            this.mark("web", `invalid-${field}`);
          else projected[field] = args[field];
        }
    }
    if (toolName === "docsfab_run_workflow") {
      projected.workflow = this.#safeField(args.workflow, "workflow", "child") ?? {
        redacted: true,
      };
    }
    if (toolName === "docsfab_use_skill") {
      projected.skillId = this.#safeField(args.skill, "skillId", "source") ?? { redacted: true };
      if (args.reference !== undefined)
        projected.reference = this.#safeField(args.reference, "reference", "source") ?? {
          redacted: true,
        };
    }
    if (toolName === "docsfab_read_run") {
      projected.runId = this.#safeField(args.runId, "runId", "source") ?? { redacted: true };
      if (args.stepId !== undefined)
        projected.stepId = this.#safeField(args.stepId, "stepId", "source") ?? { redacted: true };
    }
    if (toolName === "docsfab_read_source") {
      for (const field of ["source", "observationId", "representationId"]) {
        if (args[field] !== undefined && args[field] !== null)
          projected[field] = this.#safeField(args[field], field, "source") ?? { redacted: true };
      }
      for (const field of ["fromByte", "maxBytes", "diffFile", "diffHunk"]) {
        if (args[field] !== undefined && args[field] !== null) {
          if (
            typeof args[field] !== "number" ||
            !Number.isSafeInteger(args[field]) ||
            args[field] < 0
          )
            this.mark("source", `invalid-${field}`);
          else projected[field] = args[field];
        }
      }
      if (args.spanIds !== undefined && args.spanIds !== null) {
        if (!Array.isArray(args.spanIds)) this.mark("source", "invalid-spanIds");
        else
          projected.spanIds = args.spanIds.map(
            (id) => this.#safeField(id, "spanId", "source") ?? { redacted: true },
          );
      }
    }
    if (
      (toolName === "read" && !Object.hasOwn(projected, "path")) ||
      (toolName === "docsfab_read_source" &&
        !Object.hasOwn(projected, "source") &&
        !Object.hasOwn(projected, "observationId"))
    ) {
      this.mark("source", "source-location-unavailable");
    }
    if (WORKSPACE_TOOLS.has(toolName) && !Object.hasOwn(projected, "path"))
      this.mark("workspace", "workspace-path-unavailable");
    if ((toolName === "grep" || toolName === "find") && !Object.hasOwn(projected, "query"))
      this.mark("source", "source-query-unavailable");
    return projected;
  }

  append(event: JsonRecord): void {
    if (this.#closed) return;
    const categories = this.#eventCategories(event);
    if (this.#eventClipped) {
      for (const category of categories) this.mark(category, "activity-byte-bound", "clipped");
      return;
    }
    try {
      const full = {
        schemaVersion: 2,
        kind: "docsfab-task-activity-event",
        seq: this.#seq + 1,
        requestSha256: this.#requestSha256,
        sessionId: this.#request.sessionId,
        childScopeId: null,
        ...event,
      };
      const bytes = Buffer.byteLength(canonicalJson(full), "utf8") + 1;
      if (this.#bytes + bytes > this.#maxBytes) {
        this.#eventClipped = true;
        for (const category of categories) this.mark(category, "activity-byte-bound", "clipped");
        return;
      }
      this.#events.push(full);
      this.#seq += 1;
      this.#bytes += bytes;
    } catch {
      this.#eventClipped = true;
      for (const category of categories)
        this.mark(category, "activity-event-serialization-failed", "unavailable");
    }
  }

  #eventCategories(event: JsonRecord): readonly TaskActivityCategory[] {
    const category: TaskActivityCategory =
      event.eventType === "provider-request" || event.eventType === "provider-stream-error"
        ? "provider"
        : event.eventType === "child-lifecycle"
          ? "child"
          : event.eventType === "host-patch"
            ? "workspace"
            : event.eventType === "resource-operation"
              ? event.resourceKind === "change-request"
                ? "web"
                : "source"
              : "tools";
    return event.childScopeId !== null && event.childScopeId !== undefined && category !== "child"
      ? [category, "child"]
      : [category];
  }

  seal(): TaskActivitySealed {
    if (this.#closed) throw new Error("Task activity cannot be sealed again after finalization.");
    this.#closed = true;
    if (!this.#safeIdentity(this.#request.taskId) || !this.#safeIdentity(this.#request.sessionId))
      throw new TaskActivityCaptureError();
    this.#sealing = true;
    if (!this.#sessionStarted) {
      this.mark("tools", "session-not-started", "unavailable");
      this.mark("source", "session-not-started", "unavailable");
      this.mark("web", "session-not-started", "unavailable");
      this.mark("workspace", "session-not-started", "unavailable");
    }
    if (!this.#connectionStarted) this.mark("provider", "provider-not-started", "unavailable");
    else if (this.#seenProviderIds.size === 0) this.mark("provider", "provider-request-unobserved");
    if (this.#openTools.size) this.mark("tools", "unsettled-tool-call");
    if (this.#openProviders.size) this.mark("provider", "unsettled-provider-request");
    if (this.#openResources.size) this.mark("source", "unsettled-resource-operation");
    if ([...this.#sessionStates.values()].some((state) => !state.disposed))
      this.mark("tools", "unsettled-session");
    if (this.#childScopes.length !== this.#settledScopes.size)
      this.mark("child", "unsettled-child-scope");
    for (const start of this.#events.filter(
      (event) =>
        event.eventType === "tool-call" &&
        event.phase === "started" &&
        event.toolName === "docsfab_run_workflow",
    )) {
      const matches = this.#childScopes.filter(
        (scope) =>
          scope.parentProducerSessionId === start.producerSessionId &&
          scope.parentNativeToolCallId === start.nativeId,
      );
      if (matches.length !== 1) this.mark("child", "workflow-invocation-scope-mismatch");
    }
    for (const scope of this.#childScopes) {
      const matches = this.#events.filter(
        (event) =>
          event.eventType === "tool-call" &&
          event.phase === "started" &&
          event.toolName === "docsfab_run_workflow" &&
          event.producerSessionId === scope.parentProducerSessionId &&
          event.nativeId === scope.parentNativeToolCallId,
      );
      if (matches.length !== 1) this.mark("child", "orphan-child-scope");
    }
    const coverage = Object.fromEntries(
      CATEGORIES.map((category) => [category, this.#coverage.get(category)]),
    );
    const missing = [...this.#missing].sort();
    const header = {
      schemaVersion: 2,
      kind: "docsfab-task-activity-header",
      taskId: this.#request.taskId,
      sessionId: this.#request.sessionId,
      requestSha256: this.#requestSha256,
      promptSha256: this.#request.prompt.sha256,
      instrumentation: {
        sessions: this.#sessions,
        providerRoutes: this.#providerRoutes,
        childScopes: this.#childScopes,
      },
    };
    const footer = {
      schemaVersion: 2,
      kind: "docsfab-task-activity-footer",
      eventCount: this.#events.length,
      lastSeq: this.#events.length,
      coverage,
      missing,
    };
    const headerLine = canonicalJson(header);
    const eventLines = this.#events.map((event) => canonicalJson(event));
    const bytes = Buffer.from(
      [headerLine, ...eventLines, canonicalJson(footer)].join("\n") + "\n",
      "utf8",
    );
    if (bytes.byteLength > this.#maxBytes) {
      this.mark("tools", "activity-byte-bound", "clipped");
      let retained = eventLines.length;
      let retainedEventBytes = eventLines.reduce(
        (sum, line) => sum + Buffer.byteLength(line, "utf8") + 1,
        0,
      );
      let clippedFooterLine: string;
      while (true) {
        for (const event of this.#events.slice(retained))
          for (const category of this.#eventCategories(event))
            this.mark(category, "activity-byte-bound", "clipped");
        // Inventories in the header name scopes independently of the event
        // prefix. A missing settlement cannot leave child coverage complete.
        if (
          this.#childScopes.some(
            (scope) =>
              !this.#events
                .slice(0, retained)
                .some(
                  (event) =>
                    event.eventType === "child-lifecycle" &&
                    event.phase === "settled" &&
                    event.childScopeId === scope.childScopeId,
                ),
          )
        )
          this.mark("child", "activity-byte-bound", "clipped");
        const clippedFooter = {
          ...footer,
          eventCount: retained,
          lastSeq: retained,
          coverage: Object.fromEntries(
            CATEGORIES.map((category) => [category, this.#coverage.get(category)]),
          ),
          missing: [...this.#missing].sort(),
        };
        clippedFooterLine = canonicalJson(clippedFooter);
        if (
          Buffer.byteLength(headerLine, "utf8") +
            1 +
            retainedEventBytes +
            Buffer.byteLength(clippedFooterLine, "utf8") +
            1 <=
          this.#maxBytes
        )
          break;
        if (retained === 0)
          throw new Error("Task activity metadata exceeded the configured capture bound.");
        retained -= 1;
        retainedEventBytes -= Buffer.byteLength(eventLines[retained]!, "utf8") + 1;
      }
      const clippedBytes = Buffer.from(
        [headerLine, ...eventLines.slice(0, retained), clippedFooterLine].join("\n") + "\n",
        "utf8",
      );
      this.#sealing = false;
      return { bytes: clippedBytes, status: "clipped", missing: [...this.#missing].sort() };
    }
    const statuses = [...this.#coverage.values()];
    const status: TaskActivityCoverage = statuses.includes("clipped")
      ? "clipped"
      : statuses.includes("redacted")
        ? "redacted"
        : statuses.includes("unavailable") && !this.#sessionStarted
          ? "unavailable"
          : missing.length
            ? "incomplete"
            : "complete";
    this.#sealing = false;
    return { bytes, status, missing };
  }

  #safeIdentity(value: string): boolean {
    return (
      typeof value === "string" &&
      value.length > 0 &&
      Buffer.byteLength(value, "utf8") <= this.#maxFieldBytes &&
      value === value.normalize("NFC") &&
      !/[\p{Cc}\p{Cf}]/u.test(value) &&
      !this.#hasCredential(value)
    );
  }

  #assertSafeIdentity(value: string): void {
    if (!this.#safeIdentity(value)) throw new TaskActivityCaptureError();
  }

  #assertSafeOptionalIdentity(value: string | null | undefined): void {
    if (value !== null && value !== undefined) this.#assertSafeIdentity(value);
  }
}
