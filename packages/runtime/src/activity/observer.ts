// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Host-only context for observations of one public task execution. */
import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { ProviderResponseObservationV1 } from "../records/contracts.js";

export interface PhysicalProviderObserver {
  failed(): void;
  started(requestSequence: number, turn: number | null, body: BodyInit | null | undefined): void;
  settled(observation: ProviderResponseObservationV1): void;
  streamError(requestSequence: number, errorClass: string): void;
}

export interface PiActivitySession {
  (event: AgentSessionEvent): void;
  readonly producerSessionId: string;
  observe(event: AgentSessionEvent): void;
  dispose(): void;
}

export interface TaskActivityObserver {
  reserveSession(): string;
  attachPiSession(
    toolNames: readonly string[],
    identity?: {
      readonly producerSessionId?: string;
      readonly childScopeId?: string | null;
      readonly runId?: string | null;
      readonly stepId?: string | null;
      readonly attempt?: number | null;
    },
  ): PiActivitySession;
  attachProviderConnection(
    routeId: string,
    transport: string,
    modelId: string,
    identity?: {
      readonly childScopeId?: string | null;
      readonly producerSessionId?: string | null;
    },
  ): PhysicalProviderObserver;
  openChildScope(input: {
    readonly parentChildScopeId: string | null;
    readonly parentProducerSessionId: string;
    readonly parentNativeToolCallId: string;
    readonly workflow: string;
  }): string;
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
  }): void;
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
  }): void;
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
  }) => void;
  mark(
    category: "provider" | "tools" | "source" | "web" | "workspace" | "child",
    reason: string,
  ): void;
}

export interface TaskActivityContext {
  readonly observer: TaskActivityObserver;
  readonly childScopeId: string | null;
  readonly producerSessionId: string | null;
}

const storage = new AsyncLocalStorage<TaskActivityContext>();

export function currentTaskActivity(): TaskActivityContext | undefined {
  return storage.getStore();
}

export function withTaskActivity<T>(context: TaskActivityContext, run: () => T): T {
  return storage.run(context, run);
}

/** The native tool identity is captured before reader handoff and model work. */
export async function withChildTaskActivity<T>(
  workflow: string,
  nativeToolCallId: string,
  run: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const parent = currentTaskActivity();
  if (!parent) return run();
  if (!parent.producerSessionId) {
    parent.observer.mark("child", "parent-session-unavailable");
    return run();
  }
  const childScopeId = parent.observer.openChildScope({
    parentChildScopeId: parent.childScopeId,
    parentProducerSessionId: parent.producerSessionId,
    parentNativeToolCallId: nativeToolCallId,
    workflow,
  });
  return withTaskActivity(
    { observer: parent.observer, childScopeId, producerSessionId: null },
    async () => {
      try {
        return await run();
      } finally {
        // The bounded runner settles a real saved record. Refusals before it
        // reaches that point must remain partial evidence.
        parent.observer.settleChildScope({
          childScopeId,
          status: signal?.aborted ? "cancelled" : "refused",
          persistence: "unavailable",
          recordId: null,
          recordSha256: null,
        });
      }
    },
  );
}
