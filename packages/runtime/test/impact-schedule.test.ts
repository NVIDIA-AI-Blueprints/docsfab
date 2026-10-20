// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { ContentIndexV1, DocumentNode } from "../src/content-ir/index.js";
import { DEFAULT_HEALING_POLICY } from "../src/impact/policy.js";
import {
  DEFAULT_FULL_CORPUS_SCHEDULE,
  FullCorpusScheduleError,
  runScheduledFullCorpusAnalysis,
} from "../src/impact/schedule.js";

describe("scheduled full-corpus impact analysis", () => {
  it("detects existing global sibling pressure when the schedule is due", () => {
    const before = index("a".repeat(40), false);
    const after = index("b".repeat(40), true);
    const result = runScheduledFullCorpusAnalysis({
      before,
      after,
      policy: policy(),
      siblingPressureThreshold: 2,
      observedAt: "2026-08-10T00:00:00.000Z",
      lastCompletedAt: "2026-08-03T00:00:00.000Z",
    });

    expect(result.mode).toBe("full");
    expect(
      result.neighborhood.find((entry) => entry.nodeId === "document:home")?.reasons,
    ).toContain("sibling-pressure");
    expect(result.digest).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("fails closed when not due or when the schedule digest is forged", () => {
    const before = index("a".repeat(40), false);
    const after = index("b".repeat(40), true);
    const base = {
      before,
      after,
      policy: policy(),
      observedAt: "2026-08-04T00:00:00.000Z",
      lastCompletedAt: "2026-08-03T00:00:00.000Z",
    };
    expect(() => runScheduledFullCorpusAnalysis(base)).toThrow(
      new FullCorpusScheduleError("not-due"),
    );
    expect(() =>
      runScheduledFullCorpusAnalysis({
        ...base,
        lastCompletedAt: undefined,
        schedule: { ...DEFAULT_FULL_CORPUS_SCHEDULE, digest: "f".repeat(64) },
      }),
    ).toThrow(new FullCorpusScheduleError("invalid-schedule"));
  });

  it("runs a due health sweep when the repository has not changed", () => {
    const current = index("a".repeat(40), false);
    const result = runScheduledFullCorpusAnalysis({
      before: current,
      after: current,
      policy: policy(),
      siblingPressureThreshold: 2,
      observedAt: "2026-08-10T00:00:00.000Z",
      lastCompletedAt: "2026-08-03T00:00:00.000Z",
    });

    expect(result).toMatchObject({
      mode: "full",
      beforeRepository: {
        revision: current.repository.revision,
        indexDigest: current.indexDigest,
      },
      afterRepository: {
        revision: current.repository.revision,
        indexDigest: current.indexDigest,
      },
      changedPaths: [],
      changedRegions: [],
    });
    expect(
      result.neighborhood.find((entry) => entry.nodeId === "document:home")?.reasons,
    ).toContain("sibling-pressure");
  });
});

function policy() {
  return {
    id: DEFAULT_HEALING_POLICY.id,
    version: DEFAULT_HEALING_POLICY.version,
    digest: DEFAULT_HEALING_POLICY.digest,
  };
}

function index(revision: string, changed: boolean): ContentIndexV1 {
  const documents = [
    document("document:home", "docs/index.md", "1"),
    document("document:a", "docs/a.md", changed ? "3" : "1"),
    document("document:b", "docs/b.md", "1"),
    document("document:c", "docs/c.md", "1"),
  ];
  const indexDigest = (changed ? "5" : "4").repeat(64);
  return {
    schemaVersion: 1,
    repository: { revision, contentDigest: (changed ? "7" : "6").repeat(64) },
    indexDigest,
    nodes: documents,
    edges: documents.slice(1).map((child) => ({
      kind: "parent" as const,
      from: child.id,
      to: "document:home",
    })),
    evidence: {
      repositoryRevision: revision,
      contentDigest: (changed ? "7" : "6").repeat(64),
      indexDigest,
      documentCount: documents.length,
      sectionCount: 0,
      edgeCount: documents.length - 1,
    },
  };
}

function document(id: string, sourcePath: string, seed: string): DocumentNode {
  const digest = seed.repeat(64);
  return {
    id,
    kind: "document",
    sourcePath,
    format: "gfm",
    byteLength: 10,
    anchors: [],
    frontmatter: [],
    directives: [],
    codeBlocks: [],
    regions: {
      body: digest,
      headings: digest,
      metadata: digest,
      navigation: digest,
      graph: digest,
    },
  };
}
