// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { lstat } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { canonicalJson } from "../src/content-ir/canonical.js";
import {
  emitStudySettlements,
  observationModeForStep,
  scratchFromToolCall,
} from "../src/harness/study-observer.js";
import { FileRunStoreError } from "../src/records/file-store.js";
import { readStudyRun, StudySession, studyDirectory } from "../src/records/study-store.js";
import { documentationObservationSearch } from "../src/search/observation-search-plan.js";
import { temporaryRoots } from "./helpers/temp.js";

const roots = temporaryRoots();
const T = "2026-08-25T16:00:00.000Z";

async function temporaryStudyRoot(): Promise<string> {
  const root = await roots.create("docsfab-study-");
  return join(root, "study");
}

describe("study directory policy", () => {
  it("creates an owner-only 0700 study dir and 0600 log only when a run is recorded", async () => {
    const directory = await temporaryStudyRoot();
    const session = new StudySession({
      directory,
      now: () => new Date(T),
      id: () => "tmp1",
    });
    expect(session.summary()).toBeUndefined();

    await session.ensureRun({
      runId: "run-study-001",
      observationMode: "corpus",
      modelRef: {
        provider: "nvidia-api-catalog",
        catalogId: "operator-profile-model",
      },
    });
    expect((await lstat(directory)).mode & 0o777).toBe(0o700);
    expect((await lstat(join(directory, "run-study-001.json"))).mode & 0o777).toBe(0o600);
    expect(session.summary()).toEqual({
      runId: "run-study-001",
      observationMode: "corpus",
      modelRef: {
        provider: "nvidia-api-catalog",
        catalogId: "operator-profile-model",
      },
      scheduled: 0,
      extra: 0,
    });
  });
});

describe("fixture Pi batch study log", () => {
  it("produces a byte-stable event log for a settled confined-tool batch", async () => {
    const directory = await temporaryStudyRoot();
    const session = new StudySession({
      directory,
      now: () => new Date(T),
      id: () => "tmp1",
    });
    await session.ensureRun({
      runId: "run-study-fixture",
      observationMode: "talk-tree+required-probes",
      modelRef: {
        provider: "nvidia-api-catalog",
        catalogId: "operator-profile-model",
      },
    });
    const scratch = new Map([
      [
        "a".repeat(64),
        scratchFromToolCall(
          "get_section",
          {
            name: "get_section",
            arguments: { path: "docs/api.md", headingId: "authentication" },
          },
          Date.parse(T) - 8,
        ),
      ],
      [
        "b".repeat(64),
        scratchFromToolCall(
          "read",
          { name: "read", arguments: { path: "docs/guide.md" } },
          Date.parse(T) - 4,
        ),
      ],
    ]);
    await emitStudySettlements(session, {
      runId: "run-study-fixture",
      workflow: "review-documentation",
      stepId: "evaluate-document-quality",
      nowMs: Date.parse(T),
      results: [
        { callSha256: "a".repeat(64), outcome: "succeeded" },
        { callSha256: "b".repeat(64), outcome: "succeeded" },
      ],
      scratch,
      fallbackTool: () => "unknown-tool",
    });
    const first = await readStudyRun(directory, "run-study-fixture");
    const replay = new StudySession({
      directory: await temporaryStudyRoot(),
      now: () => new Date(T),
      id: () => "tmp1",
    });
    await replay.ensureRun({
      runId: "run-study-fixture",
      observationMode: "talk-tree+required-probes",
      modelRef: {
        provider: "nvidia-api-catalog",
        catalogId: "operator-profile-model",
      },
    });
    await emitStudySettlements(replay, {
      runId: "run-study-fixture",
      workflow: "review-documentation",
      stepId: "evaluate-document-quality",
      nowMs: Date.parse(T),
      results: [
        { callSha256: "a".repeat(64), outcome: "succeeded" },
        { callSha256: "b".repeat(64), outcome: "succeeded" },
      ],
      scratch,
      fallbackTool: () => "unknown-tool",
    });
    expect(canonicalJson(replay.snapshot())).toBe(canonicalJson(first));
    expect(first.events).toHaveLength(2);
    expect(first.events[0]).toMatchObject({
      tool: "get_section",
      targetNodeId: "authentication",
      scheduled: true,
    });
    expect(first.events[1]).toMatchObject({
      tool: "read",
      pathClass: "product-page",
      scheduled: false,
    });
    expect(canonicalJson(first)).not.toContain("docs/api.md");
    expect(canonicalJson(first)).not.toContain("docs/guide.md");
    expect(session.summary()).toMatchObject({ scheduled: 1, extra: 1 });
  });
});

describe("studyDirectory", () => {
  it("nests the study dir under the run-record state directory", () => {
    expect(studyDirectory("/tmp/docsfab-runs")).toBe("/tmp/docsfab-runs/study");
  });
});

describe("study observation mode", () => {
  it("selects talk-tree+required-probes, talk-tree, then corpus", () => {
    expect(observationModeForStep(documentationObservationSearch, ["read"])).toBe(
      "talk-tree+required-probes",
    );
    expect(observationModeForStep(undefined, ["get_section"])).toBe("talk-tree");
    expect(observationModeForStep(undefined, ["read"])).toBe("corpus");
  });
});

describe("study store fail-closed paths", () => {
  it("rejects unsafe ids, missing runs, and hostile temporary names", async () => {
    const directory = await temporaryStudyRoot();
    const session = new StudySession({
      directory,
      now: () => new Date(T),
      id: () => "tmp1",
    });
    const identity = {
      runId: "run-study-001",
      observationMode: "corpus" as const,
      modelRef: {
        provider: "nvidia-api-catalog",
        catalogId: "operator-profile-model",
      },
    };
    await expect(session.ensureRun({ ...identity, runId: "../escape" })).rejects.toMatchObject({
      name: "FileRunStoreError",
      code: "unsafe-record-id",
    });
    await expect(
      session.recordSettlement({
        runId: "run-study-001",
        workflow: "review-documentation",
        stepId: "evaluate-document-quality",
        tool: "read",
        pathClass: "other",
        disposition: "succeeded",
        durationMs: 1,
        scheduled: false,
      }),
    ).rejects.toMatchObject({ code: "write-failed" });
    await session.ensureRun(identity);
    await expect(session.ensureRun({ ...identity, runId: "run-other" })).rejects.toMatchObject({
      code: "unsafe-record-id",
    });
    await expect(readStudyRun(directory, "../escape")).rejects.toBeInstanceOf(FileRunStoreError);
    const hostile = new StudySession({
      directory: await temporaryStudyRoot(),
      now: () => new Date(T),
      id: () => "../tmp",
    });
    await expect(hostile.ensureRun(identity)).rejects.toMatchObject({
      code: "unsafe-entry",
    });
  });

  it("strengthens observation mode on a later ensureRun", async () => {
    const session = new StudySession({
      directory: await temporaryStudyRoot(),
      now: () => new Date(T),
      id: () => "tmp1",
    });
    const modelRef = {
      provider: "nvidia-api-catalog",
      catalogId: "operator-profile-model",
    };
    await session.ensureRun({
      runId: "run-study-001",
      observationMode: "corpus",
      modelRef,
    });
    await session.ensureRun({
      runId: "run-study-001",
      observationMode: "talk-tree+required-probes",
      modelRef,
    });
    expect(session.summary()?.observationMode).toBe("talk-tree+required-probes");
  });
});

describe("emitStudySettlements", () => {
  it("no-ops without a session and records fallback failed extras", async () => {
    await emitStudySettlements(undefined, {
      runId: "run-study-001",
      workflow: "review-documentation",
      stepId: "evaluate-document-quality",
      nowMs: Date.parse(T),
      results: [{ callSha256: "c".repeat(64), outcome: "failed" }],
      scratch: new Map(),
      fallbackTool: () => "unknown-tool",
    });
    const session = new StudySession({
      directory: await temporaryStudyRoot(),
      now: () => new Date(T),
      id: () => "tmp1",
    });
    await session.ensureRun({
      runId: "run-study-001",
      observationMode: "corpus",
      modelRef: {
        provider: "nvidia-api-catalog",
        catalogId: "operator-profile-model",
      },
    });
    const probeScratch = {
      tool: "get_section",
      scheduled: true,
      startedAt: Date.parse(T) - 5,
      probeId: "observation-doc-inventory",
      targetNodeId: "authentication",
    };
    await emitStudySettlements(session, {
      runId: "run-study-001",
      workflow: "review-documentation",
      stepId: "evaluate-document-quality",
      nowMs: Date.parse(T),
      results: [
        { callSha256: "c".repeat(64), outcome: "failed" },
        { callSha256: "d".repeat(64), outcome: "succeeded" },
      ],
      scratch: new Map([["d".repeat(64), probeScratch]]),
      fallbackTool: () => "unknown-tool",
    });
    expect(session.snapshot()?.events).toEqual([
      expect.objectContaining({
        tool: "unknown-tool",
        scheduled: false,
        disposition: "failed",
        pathClass: "other",
        durationMs: 0,
      }),
      expect.objectContaining({
        tool: "get_section",
        scheduled: true,
        disposition: "succeeded",
        probeId: "observation-doc-inventory",
        targetNodeId: "authentication",
        durationMs: 5,
      }),
    ]);
  });
});
