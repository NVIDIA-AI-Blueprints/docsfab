// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createContractKit } from "../contract-kit/index.js";
import { canonicalDigest } from "../content-ir/canonical.js";
import { RUN_STATUS_KEYS } from "../records/contracts.js";
import { assertConfinedToolResultCredentialFree } from "../security/credential-isolation.js";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  verbatimOperatorMessageCount,
  type LiveWorkflowFailureContinuationV1,
  type LiveWorkflowFailureContinuationDeltaV2,
  type LiveWorkflowFailureV1,
} from "./workflow-failure-gate.js";
import { repositoryVirtualCwd } from "../harness/pi-session.js";

export const LIVE_AGENT_CONTINUATION_ENTRY = "docsfab.live-agent-continuation.v1";
export const LIVE_AGENT_CONTINUATION_DELTA_ENTRY = "docsfab.live-agent-continuation.v2";
const ENTRY_PREFIX = "docsfab.live-agent-continuation";
const CLEARED_ENTRY = `${ENTRY_PREFIX}.cleared`;
export const LIVE_AGENT_CONTINUATION_NOTICE =
  "DocsFab could not safely continue the saved workflow state. Start a new session with --new, then restate the request and reselect its sources.";

export interface LocalContinuationV1 {
  readonly schema_version: 1;
  readonly session_id: string;
  readonly repository_binding: string;
  readonly continuation: LiveWorkflowFailureContinuationV1;
  readonly sources: unknown;
  /** Candidate locator only; the saved stop and private claim still govern admission. */
  readonly pending_first_pass_run_id?: string;
}

export interface LocalContinuationDeltaV2 {
  readonly schema_version: 2;
  readonly session_id: string;
  readonly repository_binding: string;
  readonly continuation: LiveWorkflowFailureContinuationDeltaV2;
  readonly sources: unknown;
  readonly pending_first_pass_run_id?: string;
}

type ContinuationError =
  | "invalid-shape"
  | "invalid-value"
  | "digest-mismatch"
  | "credential-material"
  | "schema-mismatch";
const kit = createContractKit<ContinuationError>({
  fail: (code) => {
    throw new Error(
      `Local continuation rejected: ${code}. Start a new session and restate the request.`,
    );
  },
  inertMode: "strict",
  codes: {
    invalidShape: "invalid-shape",
    invalidValue: "invalid-value",
    digestMismatch: "digest-mismatch",
    credentialMaterial: "credential-material",
    schemaMismatch: "schema-mismatch",
  },
});

// Operator text must remain verbatim, including Unicode normalization form.
function operatorText(value: unknown): string {
  if (typeof value !== "string") return kit.fail("invalid-value");
  return value;
}

function firstPassChoiceRetryBlocked(value: unknown): true | undefined {
  if (value === undefined) return undefined;
  if (value !== true) return kit.fail("invalid-value");
  return true;
}

function decodeRetry(
  value: unknown,
  messages: readonly string[],
  messageCount: number,
  verifyInstruction: boolean,
): LiveWorkflowFailureContinuationV1["pendingRetry"] {
  if (value === undefined) return undefined;
  const retry = kit.object(value);
  kit.exact(retry, ["failure", "instruction", "anchor"]);
  const failure = kit.object(retry.failure);
  const instruction = operatorText(retry.instruction);
  const anchor = retry.anchor;
  if (
    !Number.isSafeInteger(anchor) ||
    (anchor as number) < 0 ||
    (anchor as number) >= messageCount ||
    (verifyInstruction &&
      !verbatimOperatorMessageCount(instruction, messages.slice(0, (anchor as number) + 1)))
  ) {
    throw new Error(LIVE_AGENT_CONTINUATION_NOTICE);
  }
  let validatedFailure: LiveWorkflowFailureV1;
  if (failure.kind === "run") {
    kit.exact(failure, ["kind", "workflow", "runId", "status", "code"], ["code"]);
    if (
      [failure.workflow, failure.runId, failure.status].some((item) => typeof item !== "string") ||
      (failure.code !== undefined && typeof failure.code !== "string") ||
      !Object.hasOwn(RUN_STATUS_KEYS, failure.status as string)
    )
      throw new Error(LIVE_AGENT_CONTINUATION_NOTICE);
    validatedFailure = failure as unknown as LiveWorkflowFailureV1;
  } else if (failure.kind === "no-run-record") {
    kit.exact(failure, ["kind", "workflow", "code"], ["code"]);
    if (
      typeof failure.workflow !== "string" ||
      (failure.code !== undefined && typeof failure.code !== "string")
    )
      throw new Error(LIVE_AGENT_CONTINUATION_NOTICE);
    validatedFailure = failure as unknown as LiveWorkflowFailureV1;
  } else {
    throw new Error(LIVE_AGENT_CONTINUATION_NOTICE);
  }
  return { failure: validatedFailure, instruction, anchor: anchor as number };
}

function decode(
  value: unknown,
  session: SessionManager,
  repositoryPath: string,
): LocalContinuationV1 {
  kit.assertInert(value);
  const root = kit.object(value);
  kit.exact(
    root,
    [
      "schema_version",
      "session_id",
      "repository_binding",
      "continuation",
      "sources",
      "pending_first_pass_run_id",
    ],
    ["pending_first_pass_run_id"],
  );
  if (
    root.schema_version !== 1 ||
    root.session_id !== session.getSessionId() ||
    root.repository_binding !== canonicalDigest(repositoryVirtualCwd(repositoryPath))
  ) {
    throw new Error(LIVE_AGENT_CONTINUATION_NOTICE);
  }
  const continuation = kit.object(root.continuation);
  kit.exact(
    continuation,
    ["operatorMessages", "pendingRetry", "firstPassChoiceRetryBlocked"],
    ["pendingRetry", "firstPassChoiceRetryBlocked"],
  );
  const messages = kit.array(continuation.operatorMessages).map(operatorText);
  const pendingRetry = decodeRetry(continuation.pendingRetry, messages, messages.length, true);
  const retryBlocked = firstPassChoiceRetryBlocked(continuation.firstPassChoiceRetryBlocked);
  if (retryBlocked && pendingRetry) return kit.fail("invalid-value");
  const record: LocalContinuationV1 = {
    schema_version: 1,
    session_id: root.session_id as string,
    repository_binding: root.repository_binding as string,
    continuation: {
      operatorMessages: messages,
      ...(pendingRetry ? { pendingRetry } : {}),
      ...(retryBlocked ? { firstPassChoiceRetryBlocked: retryBlocked } : {}),
    },
    sources: kit.object(root.sources),
    ...(root.pending_first_pass_run_id === undefined
      ? {}
      : { pending_first_pass_run_id: kit.identifier(root.pending_first_pass_run_id) }),
  };
  assertConfinedToolResultCredentialFree(record);
  return record;
}

function decodeDelta(
  value: unknown,
  session: SessionManager,
  repositoryPath: string,
): LocalContinuationDeltaV2 {
  kit.assertInert(value);
  const root = kit.object(value);
  kit.exact(
    root,
    [
      "schema_version",
      "session_id",
      "repository_binding",
      "continuation",
      "sources",
      "pending_first_pass_run_id",
    ],
    ["pending_first_pass_run_id"],
  );
  if (
    root.schema_version !== 2 ||
    root.session_id !== session.getSessionId() ||
    root.repository_binding !== canonicalDigest(repositoryVirtualCwd(repositoryPath))
  ) {
    throw new Error(LIVE_AGENT_CONTINUATION_NOTICE);
  }
  const continuation = kit.object(root.continuation);
  kit.exact(
    continuation,
    [
      "baseCount",
      "operatorMessagesAdded",
      "messageCount",
      "pendingRetry",
      "firstPassChoiceRetryBlocked",
    ],
    ["pendingRetry", "firstPassChoiceRetryBlocked"],
  );
  const baseCount = continuation.baseCount;
  const messageCount = continuation.messageCount;
  const operatorMessagesAdded = kit.array(continuation.operatorMessagesAdded).map(operatorText);
  if (
    !Number.isSafeInteger(baseCount) ||
    (baseCount as number) < 0 ||
    !Number.isSafeInteger(messageCount) ||
    (messageCount as number) !== (baseCount as number) + operatorMessagesAdded.length
  ) {
    throw new Error(LIVE_AGENT_CONTINUATION_NOTICE);
  }
  const pendingRetry = decodeRetry(continuation.pendingRetry, [], messageCount as number, false);
  const retryBlocked = firstPassChoiceRetryBlocked(continuation.firstPassChoiceRetryBlocked);
  if (retryBlocked && pendingRetry) return kit.fail("invalid-value");
  const record: LocalContinuationDeltaV2 = {
    schema_version: 2,
    session_id: root.session_id as string,
    repository_binding: root.repository_binding as string,
    continuation: {
      baseCount: baseCount as number,
      operatorMessagesAdded,
      messageCount: messageCount as number,
      ...(pendingRetry ? { pendingRetry } : {}),
      ...(retryBlocked ? { firstPassChoiceRetryBlocked: retryBlocked } : {}),
    },
    sources: kit.object(root.sources),
    ...(root.pending_first_pass_run_id === undefined
      ? {}
      : { pending_first_pass_run_id: kit.identifier(root.pending_first_pass_run_id) }),
  };
  assertConfinedToolResultCredentialFree(record);
  return record;
}

export function restoreLocalContinuation(
  session: SessionManager,
  repositoryPath: string,
): LocalContinuationV1 | undefined {
  const entries = session
    .getBranch()
    .filter((entry) => entry.type === "custom" && entry.customType.startsWith(ENTRY_PREFIX));
  let restored: LocalContinuationV1 | undefined;
  let messages: string[] = [];
  let cleared = false;
  // Replay every checkpoint in order: a completed delta may follow its crash
  // marker, but a malformed intermediate entry never becomes invisible.
  for (const entry of entries) {
    if (entry.type !== "custom") continue;
    if (entry.customType === CLEARED_ENTRY) {
      cleared = true;
      continue;
    }
    if (entry.customType === LIVE_AGENT_CONTINUATION_ENTRY) {
      restored = decode(entry.data, session, repositoryPath);
      messages = [...restored.continuation.operatorMessages];
    } else if (entry.customType === LIVE_AGENT_CONTINUATION_DELTA_ENTRY) {
      const delta = decodeDelta(entry.data, session, repositoryPath);
      if (delta.continuation.baseCount !== messages.length)
        throw new Error(LIVE_AGENT_CONTINUATION_NOTICE);
      for (const message of delta.continuation.operatorMessagesAdded) messages.push(message);
      const pendingRetry = decodeRetry(
        delta.continuation.pendingRetry,
        messages,
        messages.length,
        true,
      );
      restored = {
        schema_version: 1,
        session_id: delta.session_id,
        repository_binding: delta.repository_binding,
        continuation: {
          operatorMessages: messages,
          ...(pendingRetry ? { pendingRetry } : {}),
          ...(delta.continuation.firstPassChoiceRetryBlocked
            ? { firstPassChoiceRetryBlocked: true }
            : {}),
        },
        sources: delta.sources,
        ...(delta.pending_first_pass_run_id === undefined
          ? {}
          : { pending_first_pass_run_id: delta.pending_first_pass_run_id }),
      };
    } else {
      throw new Error(LIVE_AGENT_CONTINUATION_NOTICE);
    }
    cleared = false;
  }
  if (cleared) throw new Error(LIVE_AGENT_CONTINUATION_NOTICE);
  return restored;
}

/** Persist turn additions and current retry/source/locator metadata, never choice authority. */
export function persistLocalContinuationDelta(
  session: SessionManager,
  repositoryPath: string,
  continuation: LiveWorkflowFailureContinuationDeltaV2,
  sources: unknown,
  pendingFirstPassRunId?: string,
): number {
  const state: LocalContinuationDeltaV2 = {
    schema_version: 2,
    session_id: session.getSessionId(),
    repository_binding: canonicalDigest(repositoryVirtualCwd(repositoryPath)),
    continuation,
    sources,
    ...(pendingFirstPassRunId === undefined
      ? {}
      : { pending_first_pass_run_id: pendingFirstPassRunId }),
  };
  invalidateLocalContinuation(session);
  const validated = decodeDelta(state, session, repositoryPath);
  session.appendCustomEntry(LIVE_AGENT_CONTINUATION_DELTA_ENTRY, validated);
  return validated.continuation.messageCount;
}

export function persistLocalContinuation(
  session: SessionManager,
  repositoryPath: string,
  continuation: LiveWorkflowFailureContinuationV1,
  sources: unknown,
  pendingFirstPassRunId?: string,
): void {
  const state: LocalContinuationV1 = {
    schema_version: 1,
    session_id: session.getSessionId(),
    repository_binding: canonicalDigest(repositoryVirtualCwd(repositoryPath)),
    continuation,
    sources,
    ...(pendingFirstPassRunId === undefined
      ? {}
      : { pending_first_pass_run_id: pendingFirstPassRunId }),
  };
  invalidateLocalContinuation(session);
  const validated = decode(state, session, repositoryPath);
  session.appendCustomEntry(LIVE_AGENT_CONTINUATION_ENTRY, validated);
}

/** Mark a turn incomplete so interruption cannot revive an older pending retry. */
export function invalidateLocalContinuation(session: SessionManager): void {
  session.appendCustomEntry(CLEARED_ENTRY, { schema_version: 1 });
}
