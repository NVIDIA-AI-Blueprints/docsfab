// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import { repositoryVirtualCwd } from "../src/harness/pi-session.js";
import type { RunStatus } from "../src/records/contracts.js";
import { createLiveAgentSourceSelection } from "../src/live-agent/source-commands.js";
import {
  invalidateLocalContinuation,
  LIVE_AGENT_CONTINUATION_ENTRY,
  LIVE_AGENT_CONTINUATION_DELTA_ENTRY,
  LIVE_AGENT_CONTINUATION_NOTICE,
  persistLocalContinuation,
  persistLocalContinuationDelta,
  restoreLocalContinuation,
  type LocalContinuationV1,
  type LocalContinuationDeltaV2,
} from "../src/live-agent/local-continuation.js";
import { createLiveWorkflowFailureGate } from "../src/live-agent/workflow-failure-gate.js";
import { configureCredential } from "./helpers/configured-credential.js";

const REPOSITORY = "/workspace/docsfab";
const SOURCE_STATE = createLiveAgentSourceSelection().snapshotState();

function session(): SessionManager {
  return SessionManager.inMemory(repositoryVirtualCwd(REPOSITORY));
}

function failedRetryGate(status: RunStatus = "needs-input") {
  const gate = createLiveWorkflowFailureGate();
  gate.beginUserTurn("Update docs/guide.md.");
  gate.beginUserTurn("Include the migration note.");
  gate.noteBoundRequest(2);
  gate.recordFailure({
    kind: "run",
    workflow: "update-documentation",
    runId: "run-1",
    status,
  });
  gate.endTurn();
  return gate;
}

function failedRetryState(status: RunStatus = "needs-input") {
  const gate = failedRetryGate(status);
  return gate.continuationState();
}

function persistValid(target: SessionManager, continuation = failedRetryState()): void {
  persistLocalContinuation(target, REPOSITORY, continuation, SOURCE_STATE);
}

function latestData(target: SessionManager): LocalContinuationV1 {
  const entry = target.getBranch().at(-1);
  if (!entry || entry.type !== "custom" || entry.customType !== LIVE_AGENT_CONTINUATION_ENTRY)
    throw new Error("Expected a persisted continuation entry.");
  return entry.data as LocalContinuationV1;
}

function appendState(
  target: SessionManager,
  data: unknown,
  customType = LIVE_AGENT_CONTINUATION_ENTRY,
): void {
  target.appendCustomEntry(customType, data);
}

describe("live-agent local continuation state", () => {
  it("preserves the exact Unicode form of operator text", () => {
    const target = session();
    const gate = createLiveWorkflowFailureGate();
    const request = "Update the Cafe\u0301 guide in docs/guide.md.";
    gate.beginUserTurn(request);
    gate.recordFailure({
      kind: "run",
      workflow: "update-documentation",
      runId: "run-unicode",
      status: "needs-input",
    });
    gate.endTurn();
    persistValid(target, gate.continuationState());
    expect(
      restoreLocalContinuation(target, REPOSITORY)?.continuation.pendingRetry?.instruction,
    ).toBe(request);
  });

  it("returns undefined when no continuation entry exists", () => {
    expect(restoreLocalContinuation(session(), REPOSITORY)).toBeUndefined();
  });

  it("round-trips a failure retry anchored to consecutive operator messages", () => {
    const target = session();
    persistValid(target);
    const restored = restoreLocalContinuation(target, REPOSITORY);
    expect(restored?.continuation.pendingRetry).toMatchObject({
      instruction: "Update docs/guide.md.\n\nInclude the migration note.",
      anchor: 1,
    });
    expect(restored?.continuation.operatorMessages).toEqual([
      "Update docs/guide.md.",
      "Include the migration note.",
    ]);
    expect(restored?.sources).toEqual(SOURCE_STATE);
  });

  it.each(["failed", "needs-input"] satisfies RunStatus[])(
    "accepts the canonical %s retry status in v1 and v2 entries",
    (status) => {
      const v1 = session();
      persistValid(v1, failedRetryState(status));
      expect(
        restoreLocalContinuation(v1, REPOSITORY)?.continuation.pendingRetry?.failure,
      ).toMatchObject({
        kind: "run",
        status,
      });

      const v2 = session();
      const gate = failedRetryGate(status);
      persistLocalContinuationDelta(v2, REPOSITORY, gate.continuationStateSince(0), SOURCE_STATE);
      expect(
        restoreLocalContinuation(v2, REPOSITORY)?.continuation.pendingRetry?.failure,
      ).toMatchObject({
        kind: "run",
        status,
      });
    },
  );

  it.each([LIVE_AGENT_CONTINUATION_ENTRY, LIVE_AGENT_CONTINUATION_DELTA_ENTRY])(
    "rejects unsupported run statuses in %s entries",
    (customType) => {
      for (const status of ["rejected", "unknown", "constructor", "__proto__"]) {
        const target = session();
        if (customType === LIVE_AGENT_CONTINUATION_ENTRY) {
          persistValid(target);
          const data = latestData(target);
          const pendingRetry = data.continuation.pendingRetry;
          if (!pendingRetry) throw new Error("Expected a retry to mutate.");
          appendState(
            target,
            {
              ...data,
              continuation: {
                ...data.continuation,
                pendingRetry: {
                  ...pendingRetry,
                  failure: { ...pendingRetry.failure, status },
                },
              },
            },
            customType,
          );
        } else {
          const gate = failedRetryGate();
          persistLocalContinuationDelta(
            target,
            REPOSITORY,
            gate.continuationStateSince(0),
            SOURCE_STATE,
          );
          const entry = target.getBranch().at(-1);
          if (!entry || entry.type !== "custom") throw new Error("Expected a delta to mutate.");
          const data = entry.data as LocalContinuationDeltaV2;
          const pendingRetry = data.continuation.pendingRetry;
          if (!pendingRetry) throw new Error("Expected a retry to mutate.");
          appendState(
            target,
            {
              ...data,
              continuation: {
                ...data.continuation,
                pendingRetry: {
                  ...pendingRetry,
                  failure: { ...pendingRetry.failure, status },
                },
              },
            },
            customType,
          );
        }
        expect(() => restoreLocalContinuation(target, REPOSITORY)).toThrow(
          LIVE_AGENT_CONTINUATION_NOTICE,
        );
      }
    },
  );

  it("round-trips successful workflow state without restoring a retry", () => {
    const gate = createLiveWorkflowFailureGate();
    gate.beginUserTurn("Update docs/guide.md.");
    gate.recordSuccess();
    gate.endTurn();
    const target = session();
    persistValid(target, gate.continuationState());
    expect(restoreLocalContinuation(target, REPOSITORY)?.continuation.pendingRetry).toBeUndefined();
  });

  it("starts a v2-only session at offset zero and refuses a later interrupted turn", () => {
    const target = session();
    const gate = createLiveWorkflowFailureGate();
    gate.beginUserTurn("Update docs/guide.md.");
    gate.endTurn();
    expect(
      persistLocalContinuationDelta(
        target,
        REPOSITORY,
        gate.continuationStateSince(0),
        SOURCE_STATE,
      ),
    ).toBe(1);
    expect(restoreLocalContinuation(target, REPOSITORY)?.continuation.operatorMessages).toEqual([
      "Update docs/guide.md.",
    ]);
    invalidateLocalContinuation(target);
    expect(() => restoreLocalContinuation(target, REPOSITORY)).toThrow(
      LIVE_AGENT_CONTINUATION_NOTICE,
    );
  });

  it("appends only new operator messages after a v1 baseline and restores the whole bound retry", () => {
    const target = session();
    const gate = createLiveWorkflowFailureGate();
    gate.restoreContinuationState(failedRetryState());
    persistLocalContinuation(target, REPOSITORY, gate.continuationState(), SOURCE_STATE);
    gate.beginUserTurn("Add the validation result.");
    gate.noteBoundRequest(3);
    gate.recordFailure({
      kind: "run",
      workflow: "update-documentation",
      runId: "run-2",
      status: "needs-input",
    });
    gate.endTurn();
    const count = persistLocalContinuationDelta(
      target,
      REPOSITORY,
      gate.continuationStateSince(2),
      SOURCE_STATE,
    );
    expect(count).toBe(3);
    const latest = target.getBranch().at(-1);
    expect(latest).toMatchObject({
      type: "custom",
      customType: LIVE_AGENT_CONTINUATION_DELTA_ENTRY,
      data: {
        schema_version: 2,
        continuation: {
          baseCount: 2,
          operatorMessagesAdded: ["Add the validation result."],
          messageCount: 3,
        },
      },
    });
    const restored = restoreLocalContinuation(target, REPOSITORY);
    expect(restored?.continuation.operatorMessages).toEqual([
      "Update docs/guide.md.",
      "Include the migration note.",
      "Add the validation result.",
    ]);
    expect(restored?.continuation.pendingRetry?.instruction).toBe(
      "Update docs/guide.md.\n\nInclude the migration note.\n\nAdd the validation result.",
    );
  });

  it("refuses malformed delta lineage, bindings, and retry metadata without skipping prior entries", () => {
    const target = session();
    persistValid(target);
    const gate = createLiveWorkflowFailureGate();
    gate.restoreContinuationState(failedRetryState());
    gate.beginUserTurn("More detail.");
    gate.endTurn();
    persistLocalContinuationDelta(target, REPOSITORY, gate.continuationStateSince(2), SOURCE_STATE);
    const latest = target.getBranch().at(-1);
    if (!latest || latest.type !== "custom") throw new Error("Missing delta entry.");
    const valid = latest.data as LocalContinuationDeltaV2;
    for (const mutate of [
      (state: LocalContinuationDeltaV2) => ({
        ...state,
        continuation: { ...state.continuation, baseCount: 1, messageCount: 2 },
      }),
      (state: LocalContinuationDeltaV2) => ({ ...state, session_id: "other-session" }),
      (state: LocalContinuationDeltaV2) => ({ ...state, repository_binding: "other-repository" }),
      (state: LocalContinuationDeltaV2) => ({
        ...state,
        continuation: {
          ...state.continuation,
          pendingRetry: {
            failure: {
              kind: "run",
              workflow: "update-documentation",
              runId: "run-1",
              status: "needs-input",
            },
            instruction: "forged",
            anchor: 2,
          },
        },
      }),
    ]) {
      const copy = session();
      persistValid(copy);
      appendState(copy, mutate(valid), LIVE_AGENT_CONTINUATION_DELTA_ENTRY);
      expect(() => restoreLocalContinuation(copy, REPOSITORY)).toThrow();
    }
    const malformedBeforeValid = session();
    persistValid(malformedBeforeValid);
    appendState(malformedBeforeValid, { schema_version: 2 }, LIVE_AGENT_CONTINUATION_DELTA_ENTRY);
    appendState(malformedBeforeValid, valid, LIVE_AGENT_CONTINUATION_DELTA_ENTRY);
    expect(() => restoreLocalContinuation(malformedBeforeValid, REPOSITORY)).toThrow();
  });

  it("refuses wrong session, repository, and schema version bindings", () => {
    for (const mutate of [
      (data: LocalContinuationV1) => ({ ...data, session_id: "another-session" }),
      (data: LocalContinuationV1) => ({ ...data, repository_binding: "another-repository" }),
      (data: LocalContinuationV1) => ({ ...data, schema_version: 2 }),
    ]) {
      const target = session();
      persistValid(target);
      appendState(target, mutate(latestData(target)));
      expect(() => restoreLocalContinuation(target, REPOSITORY)).toThrow(
        LIVE_AGENT_CONTINUATION_NOTICE,
      );
    }
  });

  it("lets an unknown or malformed latest entry mask an older valid state", () => {
    const unknown = session();
    persistValid(unknown);
    appendState(unknown, { schema_version: 2 }, `${LIVE_AGENT_CONTINUATION_ENTRY}.v2`);
    expect(() => restoreLocalContinuation(unknown, REPOSITORY)).toThrow(
      LIVE_AGENT_CONTINUATION_NOTICE,
    );

    const malformed = session();
    persistValid(malformed);
    appendState(malformed, { schema_version: 1 });
    expect(() => restoreLocalContinuation(malformed, REPOSITORY)).toThrow(
      "Local continuation rejected: invalid-shape.",
    );
  });

  it("rejects missing sources and retry anchors or instructions that do not match operator messages", () => {
    const missingSources = session();
    persistValid(missingSources);
    const { sources: _sources, ...withoutSources } = latestData(missingSources);
    appendState(missingSources, withoutSources);
    expect(() => restoreLocalContinuation(missingSources, REPOSITORY)).toThrow(
      "Local continuation rejected: invalid-shape.",
    );

    const validRetry = failedRetryState().pendingRetry;
    if (!validRetry) throw new Error("Expected a failure retry from the gate.");
    for (const pendingRetry of [
      { ...validRetry, anchor: 99 },
      { ...validRetry, instruction: "A different instruction." },
    ]) {
      const target = session();
      persistValid(target);
      const data = latestData(target);
      appendState(target, { ...data, continuation: { ...data.continuation, pendingRetry } });
      expect(() => restoreLocalContinuation(target, REPOSITORY)).toThrow(
        LIVE_AGENT_CONTINUATION_NOTICE,
      );
    }
  });

  it("does not treat transcript text as a continuation entry", () => {
    const target = session();
    target.appendMessage({
      role: "user",
      content: JSON.stringify({ schema_version: 1 }),
      timestamp: 1,
    });
    target.appendCustomMessageEntry(
      LIVE_AGENT_CONTINUATION_ENTRY,
      JSON.stringify({ schema_version: 1, continuation: { pendingRetry: "model text" } }),
      false,
    );
    expect(restoreLocalContinuation(target, REPOSITORY)).toBeUndefined();
  });

  it("keeps a credential-screened append as an invalid marker after reopening", async () => {
    const root = await mkdtemp(join(tmpdir(), "docsfab-continuation-state-"));
    try {
      const sessions = join(root, "sessions");
      await mkdir(sessions, { recursive: true });
      const repositoryPath = repositoryVirtualCwd(root);
      const target = SessionManager.create(repositoryPath, sessions);
      target.appendMessage({ role: "user", content: "Start a durable session.", timestamp: 1 });
      persistLocalContinuation(target, root, failedRetryState(), SOURCE_STATE);
      const secret = configureCredential("continuation-state-credential-value");
      expect(() =>
        persistLocalContinuation(target, root, failedRetryState(), {
          ...SOURCE_STATE,
          marker: secret,
        }),
      ).toThrow(
        "DocsFab rejected data at a governed credential-isolation boundary before host credential material could escape.",
      );
      const reopened = SessionManager.continueRecent(repositoryPath, sessions);
      expect(() => restoreLocalContinuation(reopened, root)).toThrow(
        LIVE_AGENT_CONTINUATION_NOTICE,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses an explicit incomplete-turn marker", () => {
    const target = session();
    persistValid(target);
    invalidateLocalContinuation(target);
    expect(() => restoreLocalContinuation(target, REPOSITORY)).toThrow(
      LIVE_AGENT_CONTINUATION_NOTICE,
    );
  });
});
