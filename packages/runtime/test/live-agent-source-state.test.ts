// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  createLiveAgentSourceSelection,
  renderSourceCommandOutcome,
  SOURCE_COMMAND_REFUSALS,
  sourceRevalidationWindowMs,
} from "../src/live-agent/source-commands.js";
import type { TrackedSourceReaderV1 } from "../src/inputs/source-acquisition.js";
import { parseChangeRequestSelector } from "../src/inputs/change-request-selector.js";
import { configureCredential } from "./helpers/configured-credential.js";
import { canonicalDigest } from "../src/content-ir/canonical.js";

function reader(contents = "baseline"): TrackedSourceReaderV1 {
  return {
    async isTrackedRegularFile(path) {
      return path === "docs/a.md";
    },
    async readTrackedBytes() {
      return new TextEncoder().encode(contents);
    },
  };
}

describe("live-agent source selection restart state", () => {
  it("round-trips request fields, recorded version, and revalidation baseline", async () => {
    const ports = {
      withTrackedSourceReader: async <T>(use: (r: TrackedSourceReaderV1) => Promise<T>) =>
        use(reader()),
      now: () => 1000,
    };
    const original = createLiveAgentSourceSelection({ sourcePaths: ["docs/a.md"], ports });
    await original.dispatch("/sources refresh");
    await original.dispatch("/sources revalidate");
    const restored = createLiveAgentSourceSelection({ sourcePaths: ["docs/a.md"], ports });
    await restored.restoreState(JSON.parse(JSON.stringify(original.snapshotState())) as unknown);
    expect(restored.requestFields()).toEqual(original.requestFields());
    expect(
      restored.entries().map(({ version, revalidation }) => ({ version, revalidation })),
    ).toEqual(original.entries().map(({ version, revalidation }) => ({ version, revalidation })));
  });

  it("retains restrictive verdicts and expiry across restore", async () => {
    let now = 1000;
    let contents = "baseline";
    const ports = {
      withTrackedSourceReader: async <T>(use: (r: TrackedSourceReaderV1) => Promise<T>) =>
        use(reader(contents)),
      now: () => now,
    };
    const original = createLiveAgentSourceSelection({ sourcePaths: ["docs/a.md"], ports });
    await original.dispatch("/sources refresh");
    await original.dispatch("/sources revalidate");
    const snapshot = original.snapshotState();
    const restored = createLiveAgentSourceSelection({ ports });
    await restored.restoreState(snapshot);
    now = 1000 + sourceRevalidationWindowMs() + 1;
    expect(() => restored.assertBindable()).toThrow(SOURCE_COMMAND_REFUSALS["bind-expired"]);
    contents = "drifted";
    const stale = createLiveAgentSourceSelection({ ports });
    await stale.restoreState(snapshot);
    await stale.dispatch("/sources revalidate");
    expect(() => stale.assertBindable()).toThrow(SOURCE_COMMAND_REFUSALS["bind-stale"]);
  });

  it("rejects malformed state atomically and never serializes hold authority", async () => {
    const state = createLiveAgentSourceSelection({ sourcePaths: ["docs/a.md"] });
    const before = state.snapshotState();
    const release = state.holdForRun("update-documentation");
    expect(state.snapshotState()).toEqual(before);
    release();
    const empty = createLiveAgentSourceSelection();
    const emptyBefore = empty.snapshotState();
    await expect(
      empty.restoreState({ schema_version: 1, entries: [{ ...before.entries[0], extra: "bad" }] }),
    ).rejects.toThrow("Source snapshot rejected: invalid-shape.");
    expect(empty.snapshotState()).toEqual(emptyBefore);
    const secret = configureCredential("source-snapshot-credential-value");
    await expect(
      empty.restoreState({
        schema_version: 1,
        entries: [{ ...before.entries[0], repositoryPath: `docs/${secret}.md` }],
      }),
    ).rejects.toThrow(
      "DocsFab rejected data at a governed credential-isolation boundary before host credential material could escape.",
    );
    expect(empty.snapshotState()).toEqual(emptyBefore);
  });

  it("refuses a saved source that differs from explicit constructor arguments", async () => {
    const saved = createLiveAgentSourceSelection({ sourcePaths: ["docs/a.md"] }).snapshotState();
    const explicit = createLiveAgentSourceSelection({ sourcePaths: ["docs/other.md"] });
    const before = explicit.snapshotState();
    await expect(explicit.restoreState(saved)).rejects.toThrow(
      "Source snapshot rejected: invalid-value.",
    );
    expect(explicit.snapshotState()).toEqual(before);
  });

  it("keeps the empty selection as a valid snapshot", async () => {
    const restored = createLiveAgentSourceSelection();
    await restored.restoreState({ schema_version: 1, entries: [] });
    expect(restored.requestFields()).toEqual({});
  });

  it("re-proves a recorded merge request project and refuses an identity change", async () => {
    let projectId = 41;
    const ports = {
      identityPort: {
        async resolveProjectIdentity(reference: { host: string; projectPath: string }) {
          return { ...reference, projectId };
        },
      },
    };
    const original = createLiveAgentSourceSelection({ ports });
    await original.dispatch("/sources add https://gitlab.example/team/project/-/merge_requests/19");
    const saved = original.snapshotState();
    const restored = createLiveAgentSourceSelection({ ports });
    await restored.restoreState(saved);
    expect(restored.requestFields()).toEqual(original.requestFields());
    projectId = 42;
    await expect(createLiveAgentSourceSelection({ ports }).restoreState(saved)).rejects.toThrow(
      SOURCE_COMMAND_REFUSALS["bind-identity-changed"],
    );
  });

  it("replays a serialized merged-change selection unchanged with a neutral human category", async () => {
    const projectReads: string[] = [];
    const bodyReads: string[] = [];
    const ports = {
      identityPort: {
        async resolveProjectIdentity(reference: { host: string; projectPath: string }) {
          projectReads.push(`${reference.host}/${reference.projectPath}`);
          return { ...reference, projectId: 41 };
        },
      },
      withTrackedSourceReader: async <T>(use: (r: TrackedSourceReaderV1) => Promise<T>) => {
        bodyReads.push("source-reader-opened");
        return use(reader());
      },
      now: () => 1000,
    };
    const original = createLiveAgentSourceSelection({ ports });
    await original.dispatch("/sources add https://gitlab.example/team/project/-/merge_requests/19");
    await original.dispatch("/sources revalidate");
    const serialized = JSON.stringify(original.snapshotState());
    const saved: unknown = JSON.parse(serialized);
    expect(saved).toMatchObject({
      schema_version: 1,
      entries: [{ kind: "merged-change", admission: { kind: "merged-change" } }],
    });
    const requestBefore = original.requestFields();
    const entriesBefore = original.entries();
    const snapshotDigest = canonicalDigest(saved);
    const projectionDigest = canonicalDigest(entriesBefore);

    const restored = createLiveAgentSourceSelection({ ports });
    await restored.restoreState(saved);
    expect(projectReads).toEqual([
      "gitlab.example/team/project",
      "gitlab.example/team/project",
      "gitlab.example/team/project",
    ]);
    const identityReadsBeforeListing = [...projectReads];
    const outcome = await restored.dispatch("/sources list");
    if (outcome?.kind !== "listing") throw new Error("Expected a restored source listing.");
    const human = renderSourceCommandOutcome(outcome);

    expect(human).toContain("change request; attached");
    expect(human).not.toContain("merged-change");
    expect(restored.snapshotState()).toEqual(saved);
    expect(canonicalDigest(restored.snapshotState())).toBe(snapshotDigest);
    expect(restored.entries()).toEqual(entriesBefore);
    expect(canonicalDigest(outcome.entries)).toBe(projectionDigest);
    expect(restored.requestFields()).toEqual(requestBefore);
    expect(projectReads).toEqual(identityReadsBeforeListing);
    expect(bodyReads).toEqual([]);
  });

  it("restores a constructor URL without retroactively admitting its unresolved identity", async () => {
    let calls = 0;
    const ports = {
      identityPort: {
        async resolveProjectIdentity(reference: { host: string; projectPath: string }) {
          calls += 1;
          return { ...reference, projectId: 41 };
        },
      },
    };
    const original = createLiveAgentSourceSelection({
      changeRequestSelector: parseChangeRequestSelector(
        "https://gitlab.example/team/project/-/merge_requests/19",
      ),
    });
    const saved = original.snapshotState();
    const restored = createLiveAgentSourceSelection({ ports });
    await restored.restoreState(saved);
    expect(calls).toBe(1);
    expect(restored.entries()[0]?.projectId).toBeNull();
    expect(restored.requestFields()).toEqual(original.requestFields());
  });
});
