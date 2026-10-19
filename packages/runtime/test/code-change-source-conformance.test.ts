// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ChangeSnapshotError,
  createChangeSnapshot,
  decodeChangeSnapshot,
  type ChangeSnapshotGraphV1,
  type ChangeSnapshotManifestRowV1,
} from "../src/inputs/change-snapshot.js";
import { createChangeRequestRef } from "../src/inputs/change-request.js";
import { projectVerifiedGitlabChange } from "../src/inputs/adapters/gitlab-change-projection.js";

const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./fixtures/code-change-conformance.json", import.meta.url)),
    "utf8",
  ),
) as { graph: ChangeSnapshotGraphV1; manifest: ChangeSnapshotManifestRowV1[] };

describe("paired provider code-change contract", () => {
  it("keeps exact composed and decomposed Git paths distinct and refuses unsafe paths", () => {
    const ref = createChangeRequestRef({
      provider: "github",
      canonicalHost: "github.com",
      targetRepositoryId: "42",
      objectKind: "pull-request",
      nativeChangeId: "7",
    });
    const snapshotAt = (path: string) =>
      createChangeSnapshot({
        ref,
        sourceRepositoryId: "43",
        graph: fixture.graph,
        manifest: [{ ...fixture.manifest[0]!, oldPath: path, newPath: path }],
        sourceSides: [],
        sourceBindingSha256: null,
        limitations: [],
        completeness: "complete",
      });
    const composed = "docs/caf\u00e9 guide.md";
    const decomposed = "docs/cafe\u0301 guide.md";
    const first = snapshotAt(composed);
    const second = snapshotAt(decomposed);
    expect(first.snapshotSha256).not.toBe(second.snapshotSha256);
    expect(decodeChangeSnapshot(JSON.parse(JSON.stringify(second))).manifest[0]!.newPath).toBe(
      decomposed,
    );
    for (const unsafe of [
      "/docs/guide.md",
      "C:/docs/guide.md",
      "C:docs/guide.md",
      "docs//guide.md",
      "docs/./guide.md",
      "docs/../guide.md",
      "docs\\guide.md",
      "docs/line\nbreak.md",
      "docs/\ud800.md",
    ]) {
      expect(() => snapshotAt(unsafe), unsafe).toThrow(
        expect.objectContaining({ code: "change-snapshot-invalid-value" }),
      );
    }
  });

  it("keeps provider identity distinct while preserving verified graph and manifest semantics", () => {
    const githubRef = createChangeRequestRef({
      provider: "github",
      canonicalHost: "github.com",
      targetRepositoryId: "42",
      objectKind: "pull-request",
      nativeChangeId: "7",
    });
    const github = createChangeSnapshot({
      ref: githubRef,
      sourceRepositoryId: "43",
      graph: fixture.graph,
      manifest: fixture.manifest,
      sourceSides: [],
      sourceBindingSha256: null,
      limitations: [],
      completeness: "complete",
    });
    const gitlab = projectVerifiedGitlabChange({
      host: "gitlab.example.test",
      targetProjectId: 42,
      sourceProjectId: 43,
      mergeRequestIid: 7,
      graph: fixture.graph,
      manifest: fixture.manifest,
      sourceSides: [],
      sourceBindingSha256: null,
      limitations: [],
    });
    expect(github.graph).toEqual(gitlab.snapshot.graph);
    expect(github.manifest).toEqual(gitlab.snapshot.manifest);
    expect(github.graph.B).not.toBe(github.graph.M);
    expect(github.manifest.map((entry) => entry.status)).toEqual(["R100", "D"]);
    expect(githubRef.referenceSha256).not.toBe(gitlab.ref.referenceSha256);
    expect(github.snapshotSha256).not.toBe(gitlab.snapshot.snapshotSha256);
    expect(decodeChangeSnapshot(JSON.parse(JSON.stringify(github)))).toEqual(github);
  });

  it("does not manufacture an M..H graph from GitLab forge-only B..H facts", () => {
    const refusal = (input: Parameters<typeof projectVerifiedGitlabChange>[0]): unknown => {
      try {
        projectVerifiedGitlabChange(input);
        return null;
      } catch (error) {
        return error;
      }
    };
    expect(
      refusal({
        host: "gitlab.example.test",
        targetProjectId: 42,
        sourceProjectId: 43,
        mergeRequestIid: 7,
        graph: undefined as never,
        manifest: fixture.manifest,
        sourceSides: [],
        sourceBindingSha256: null,
        limitations: [],
      }),
    ).toMatchObject({ code: "gitlab-change-native-facts-required" });
    expect(
      refusal({
        host: "gitlab.example.test",
        targetProjectId: 42,
        sourceProjectId: 43,
        mergeRequestIid: 7,
        graph: fixture.graph,
        manifest: fixture.manifest,
        sourceSides: undefined as never,
        sourceBindingSha256: null,
        limitations: [],
      }),
    ).toMatchObject({ code: "gitlab-change-native-facts-required" });
    expect(
      refusal({
        host: undefined as never,
        targetProjectId: 42,
        sourceProjectId: 43,
        mergeRequestIid: 7,
        graph: fixture.graph,
        manifest: fixture.manifest,
        sourceSides: [],
        sourceBindingSha256: null,
        limitations: [],
      }),
    ).toMatchObject({ code: "gitlab-change-native-facts-required" });
  });

  it("binds absent Git sides to zero modes and refuses present zero-mode sides", () => {
    const ref = createChangeRequestRef({
      provider: "github",
      canonicalHost: "github.com",
      targetRepositoryId: "42",
      objectKind: "pull-request",
      nativeChangeId: "7",
    });
    const snapshotWith = (row: ChangeSnapshotManifestRowV1) =>
      createChangeSnapshot({
        ref,
        sourceRepositoryId: "43",
        graph: fixture.graph,
        manifest: [row],
        sourceSides: [],
        sourceBindingSha256: null,
        limitations: [],
        completeness: "complete",
      });
    const deleted = fixture.manifest[1]!;
    expect(snapshotWith(deleted).manifest[0]!.newMode).toBe("000000");
    expect(snapshotWith({ ...deleted, newMode: "0" }).manifest[0]!.newMode).toBe("0");
    for (const row of [
      { ...fixture.manifest[0]!, oldMode: "0" },
      { ...fixture.manifest[0]!, newMode: "000000" },
      { ...deleted, newMode: "100644" },
    ]) {
      expect(() => snapshotWith(row)).toThrow(
        expect.objectContaining({ code: "change-snapshot-invalid-value" }),
      );
    }
  });

  it("admits an observed original-only empty side but refuses incompatible limitations", () => {
    const ref = createChangeRequestRef({
      provider: "github",
      canonicalHost: "github.com",
      targetRepositoryId: "42",
      objectKind: "pull-request",
      nativeChangeId: "7",
    });
    const side = {
      side: "after" as const,
      path: fixture.manifest[0]!.newPath!,
      repositoryId: "43",
      blobId: fixture.manifest[0]!.newId!,
      originalSha256: "a".repeat(64),
      originalByteLength: 12,
      observationId: "obs-1",
      observationSha256: "b".repeat(64),
    };
    const snapshotWith = (
      reason: "partial-extraction" | "unsupported-content" | "empty-extraction",
      observed: boolean,
    ) =>
      createChangeSnapshot({
        ref,
        sourceRepositoryId: "43",
        graph: fixture.graph,
        manifest: [fixture.manifest[0]!],
        sourceSides: [
          {
            ...side,
            observationId: observed ? side.observationId : null,
            observationSha256: observed ? side.observationSha256 : null,
          },
        ],
        sourceBindingSha256: observed ? "c".repeat(64) : null,
        limitations: [{ side: "after", path: side.path, reason }],
        completeness: "complete",
      });
    for (const reason of ["partial-extraction", "empty-extraction"] as const) {
      const snapshot = snapshotWith(reason, true);
      expect(snapshot.limitations[0]!.reason).toBe(reason);
      expect(decodeChangeSnapshot(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot);
    }
    for (const reason of ["unsupported-content", "empty-extraction"] as const) {
      const snapshot = snapshotWith(reason, false);
      expect(snapshot.limitations[0]!.reason).toBe(reason);
    }
    for (const [reason, observed] of [
      ["unsupported-content", true],
      ["partial-extraction", false],
    ] as const) {
      expect(() => snapshotWith(reason, observed)).toThrow(
        expect.objectContaining({ code: "change-snapshot-invalid-value" }),
      );
    }
  });

  it("rejects unknown fields, missing source side identity, and changed seals", () => {
    const githubRef = createChangeRequestRef({
      provider: "github",
      canonicalHost: "github.com",
      targetRepositoryId: "42",
      objectKind: "pull-request",
      nativeChangeId: "7",
    });
    const snapshot = createChangeSnapshot({
      ref: githubRef,
      sourceRepositoryId: "43",
      graph: fixture.graph,
      manifest: fixture.manifest,
      sourceSides: [],
      sourceBindingSha256: null,
      limitations: [],
      completeness: "complete",
    });
    for (const changed of [
      { ...snapshot, unknown: true },
      { ...snapshot, schemaVersion: 2 },
      { ...snapshot, graph: { ...snapshot.graph, M: snapshot.graph.B } },
      { ...snapshot, completeness: "partial" },
    ]) {
      expect(() => decodeChangeSnapshot(changed)).toThrow(ChangeSnapshotError);
    }
  });
});
