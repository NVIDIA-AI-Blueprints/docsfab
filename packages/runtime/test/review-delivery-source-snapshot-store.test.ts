// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { DurableArtifactStore, opaqueRecordDigest } from "../src/artifacts/store.js";
import {
  projectReviewDiffHunks,
  readSourceSnapshotParts,
  retainSourceSnapshotParts,
  type SourceSnapshotPartInput,
} from "../src/review-delivery/source-snapshot-store.js";
import { temporaryRoots } from "./helpers/temp.js";

const roots = temporaryRoots();
const encoder = new TextEncoder();
const bytes = (value: string) => encoder.encode(value);
const hash = (value: Uint8Array) =>
  // The test independently uses Node's hash, rather than the codec's helper.
  createHash("sha256").update(value).digest("hex");

function input(): SourceSnapshotPartInput {
  const shared = bytes("\ufeffsame\r\nlast");
  return {
    runId: "run-saved",
    sourceSha256: "a".repeat(64),
    repositoryIdentitySha256: "b".repeat(64),
    reviewedHeadSha: "c".repeat(40),
    snapshotSha256: "d".repeat(64),
    manifest: { observationId: "manifest-1", bytes: bytes('{"files":[]}\n') },
    diff: { observationId: "diff-1", bytes: bytes("diff --git a/a b/a\n") },
    rows: [
      {
        state: "complete",
        sections: 1,
        before: { objectId: "e".repeat(40), bytes: shared, statedSha256: "f".repeat(64) },
        after: { objectId: "e".repeat(40), bytes: shared, statedSha256: "f".repeat(64) },
      },
      {
        state: "absent",
        sections: 0,
        before: { reason: "not-in-source", statedSha256: null },
        after: { reason: "source-omitted", statedSha256: "1".repeat(64) },
      },
      {
        state: "truncated",
        sections: 0,
        before: { reason: "unsupported-gitlink", statedSha256: null },
        after: { reason: "unsupported-mode", statedSha256: null },
      },
    ],
  };
}

async function storeFixture(maxArtifactBytes?: number) {
  const root = join(await roots.create("docsfab-source-snapshot-"), "artifacts");
  const artifacts = new DurableArtifactStore(root, maxArtifactBytes ? { maxArtifactBytes } : {});
  const reference = await retainSourceSnapshotParts(artifacts, input());
  return { root, artifacts, reference };
}

async function tamperRecord(
  root: string,
  digest: string,
  change: (record: Record<string, unknown>) => void,
) {
  const path = join(root, "objects", "sha256", `${digest}.json`);
  const record = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  change(record);
  await writeFile(path, JSON.stringify(record));
}

describe("retained review source parts", () => {
  it("charges each distinct original blob once at the effective snapshot limit", async () => {
    const source = input();
    const uniqueLength = (source.rows[0]!.before as { bytes: Uint8Array }).bytes.byteLength;
    const root = join(await roots.create("docsfab-source-snapshot-limit-"), "artifacts");
    const artifacts = new DurableArtifactStore(root);
    const atBoundary = {
      environment: {
        DOCSFAB_REVIEW_DELIVERY_SNAPSHOT_UNIQUE_ORIGINAL_BYTES_MAX: String(uniqueLength),
        DOCSFAB_CHANGE_SOURCES_GITHUB_OBJECT_MATERIALIZED_MAX_BYTES: String(uniqueLength),
      },
    };
    await expect(
      retainSourceSnapshotParts(artifacts, source, { limits: atBoundary }),
    ).resolves.toEqual({
      rootObjectSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    await expect(
      retainSourceSnapshotParts(artifacts, source, {
        limits: {
          environment: {
            DOCSFAB_REVIEW_DELIVERY_SNAPSHOT_UNIQUE_ORIGINAL_BYTES_MAX: String(uniqueLength - 1),
            DOCSFAB_CHANGE_SOURCES_GITHUB_OBJECT_MATERIALIZED_MAX_BYTES: String(uniqueLength - 1),
          },
        },
      }),
    ).rejects.toThrow(/reviewDelivery\.snapshotUniqueOriginalBytesMax/u);
  });

  it("fragments a large observation by the effective raw-part limit before object serialization", async () => {
    const root = join(await roots.create("docsfab-source-snapshot-part-limit-"), "artifacts");
    const artifacts = new DurableArtifactStore(root);
    const source = {
      ...input(),
      diff: { observationId: "diff-1", bytes: bytes("x".repeat(10_000)) },
    };
    const reference = await retainSourceSnapshotParts(artifacts, source, {
      limits: {
        environment: { DOCSFAB_REVIEW_DELIVERY_SNAPSHOT_PART_BYTES: "4096" },
      },
    });
    const retained = await readSourceSnapshotParts(artifacts, reference.rootObjectSha256);
    expect(retained.root.partDigests.length).toBeGreaterThan(1);
    for (const digest of retained.root.partDigests) {
      const part = (await artifacts.getRecord(digest)) as { rawLength: number };
      expect(part.rawLength).toBeLessThanOrEqual(4096);
    }
    expect(retained.diffBytes).toEqual(source.diff.bytes);
  });

  it("persists a closed root and shared blob once, then reads exact bytes from a fresh store", async () => {
    const { root, reference } = await storeFixture();
    const restored = await readSourceSnapshotParts(
      new DurableArtifactStore(root),
      reference.rootObjectSha256,
    );
    expect(restored.root).toMatchObject({
      kind: "docsfab-review-delivery-snapshot",
      schemaVersion: 2,
      states: ["complete", "absent", "truncated"],
      sectionCounts: [1, 0, 0],
      sideBlobIndices: [0, 0, null, null, null, null],
      sideReasons: [
        null,
        null,
        "not-in-source",
        "source-omitted",
        "unsupported-gitlink",
        "unsupported-mode",
      ],
    });
    expect(restored.root.blobs).toHaveLength(1);
    expect(restored.manifestBytes).toEqual(input().manifest.bytes);
    expect(restored.diffBytes).toEqual(input().diff.bytes);
    expect(restored.blobBytes[0]).toEqual(bytes("\ufeffsame\r\nlast"));
    expect(restored.root.sideStatedSha256[0]).toBe("f".repeat(64));
    expect(restored.root.sideStatedSha256[3]).toBe("1".repeat(64));
    expect(restored.root.blobs[0]!.rawSha256).toBe(hash(restored.blobBytes[0]!));
  });

  it("retains two ordered diff sections for one type-change row and refuses a legacy root without counts", async () => {
    const artifacts = new DurableArtifactStore(
      join(await roots.create("docsfab-source-snapshot-sections-"), "store"),
    );
    const source = {
      ...input(),
      diff: {
        observationId: "diff-1",
        bytes: bytes(
          "diff --git a/a b/a\n--- a/a\n+++ /dev/null\ndiff --git a/a b/a\n--- /dev/null\n+++ b/a\n",
        ),
      },
      rows: [{ ...input().rows[0]!, sections: 2 }],
    };
    const retained = await retainSourceSnapshotParts(artifacts, source);
    const loaded = await readSourceSnapshotParts(artifacts, retained.rootObjectSha256);
    expect(loaded.root.sectionCounts).toEqual([2]);
    expect(
      projectReviewDiffHunks(loaded.diffBytes, [{ state: "complete", sections: 2 }]),
    ).toHaveLength(1);
    const { sectionCounts: _counts, ...oldRoot } = loaded.root;
    const legacy = { ...oldRoot, schemaVersion: 1 };
    const legacyDigest = opaqueRecordDigest(legacy);
    await artifacts.putRecord(legacyDigest, legacy);
    await expect(readSourceSnapshotParts(artifacts, legacyDigest)).rejects.toThrow();
  });

  it("splits under the artifact store's existing object bound and verifies ordered parts", async () => {
    const root = join(await roots.create("docsfab-source-snapshot-"), "artifacts");
    const artifacts = new DurableArtifactStore(root, { maxArtifactBytes: 1800 });
    const source = {
      ...input(),
      diff: { observationId: "diff-1", bytes: bytes("x".repeat(4200)) },
    };
    const reference = await retainSourceSnapshotParts(artifacts, source);
    const result = await readSourceSnapshotParts(
      new DurableArtifactStore(root, { maxArtifactBytes: 1800 }),
      reference.rootObjectSha256,
    );
    expect(result.root.partDigests.length).toBeGreaterThan(1);
    expect(result.diffBytes).toEqual(source.diff.bytes);
    const first = result.root.partDigests[0]!;
    await tamperRecord(root, first, (part) => {
      part.ordinal = (part.ordinal as number) + 1;
    });
    await expect(readSourceSnapshotParts(artifacts, reference.rootObjectSha256)).rejects.toThrow(
      "part-address-mismatch",
    );
  });

  it("rejects a foreign root, a corrupt part, noncanonical base64 and leftover stream bytes", async () => {
    const { root, artifacts, reference } = await storeFixture();
    await expect(readSourceSnapshotParts(artifacts, "0".repeat(64))).rejects.toThrow("not-found");
    const originalRoot = (await artifacts.getRecord(reference.rootObjectSha256)) as Record<
      string,
      unknown
    >;
    const first = (originalRoot.partDigests as string[])[0]!;
    const originalPart = (await artifacts.getRecord(first)) as Record<string, unknown>;
    await tamperRecord(root, first, (part) => {
      part.rawBase64 = `${part.rawBase64 as string}=`;
    });
    await expect(readSourceSnapshotParts(artifacts, reference.rootObjectSha256)).rejects.toThrow(
      "part-address-mismatch",
    );
    await writeFile(join(root, "objects", "sha256", `${first}.json`), JSON.stringify(originalPart));

    const noncanonicalPart = { ...originalPart, rawBase64: `${originalPart.rawBase64 as string}=` };
    const noncanonicalDigest = opaqueRecordDigest(noncanonicalPart);
    await artifacts.putRecord(noncanonicalDigest, noncanonicalPart);
    const noncanonicalRoot = { ...originalRoot, partDigests: [noncanonicalDigest] };
    const noncanonicalRootDigest = opaqueRecordDigest(noncanonicalRoot);
    await artifacts.putRecord(noncanonicalRootDigest, noncanonicalRoot);
    await expect(readSourceSnapshotParts(artifacts, noncanonicalRootDigest)).rejects.toThrow(
      "part-base64-noncanonical",
    );

    const shortPart = {
      ...originalPart,
      rawBase64: "YQ==",
      rawLength: 1,
      rawSha256: hash(bytes("a")),
    };
    const shortDigest = opaqueRecordDigest(shortPart);
    await artifacts.putRecord(shortDigest, shortPart);
    const alteredRoot = { ...originalRoot, partDigests: [shortDigest] };
    const alteredDigest = opaqueRecordDigest(alteredRoot);
    await artifacts.putRecord(alteredDigest, alteredRoot);
    await expect(readSourceSnapshotParts(artifacts, alteredDigest)).rejects.toThrow(
      "part-stream-length-mismatch",
    );

    const extraPart = {
      ...originalPart,
      ordinal: 1,
      rawBase64: "YQ==",
      rawLength: 1,
      rawSha256: hash(bytes("a")),
    };
    const extraDigest = opaqueRecordDigest(extraPart);
    await artifacts.putRecord(extraDigest, extraPart);
    const leftoverRoot = { ...originalRoot, partDigests: [first, extraDigest] };
    const leftoverDigest = opaqueRecordDigest(leftoverRoot);
    await artifacts.putRecord(leftoverDigest, leftoverRoot);
    await expect(readSourceSnapshotParts(artifacts, leftoverDigest)).rejects.toThrow(
      "part-stream-length-mismatch",
    );
  });

  it("refuses malleable root keys and a foreign part binding", async () => {
    const { artifacts, reference } = await storeFixture();
    const root = (await artifacts.getRecord(reference.rootObjectSha256)) as Record<string, unknown>;
    const extraKeyRoot = { ...root, unrecognized: true };
    const extraKeyDigest = opaqueRecordDigest(extraKeyRoot);
    await artifacts.putRecord(extraKeyDigest, extraKeyRoot);
    await expect(readSourceSnapshotParts(artifacts, extraKeyDigest)).rejects.toThrow(
      "root-shape-invalid",
    );

    const first = (root.partDigests as string[])[0]!;
    const part = (await artifacts.getRecord(first)) as Record<string, unknown>;
    const foreignPart = { ...part, runId: "another-run" };
    const foreignDigest = opaqueRecordDigest(foreignPart);
    await artifacts.putRecord(foreignDigest, foreignPart);
    const foreignRoot = { ...root, partDigests: [foreignDigest] };
    const foreignRootDigest = opaqueRecordDigest(foreignRoot);
    await artifacts.putRecord(foreignRootDigest, foreignRoot);
    await expect(readSourceSnapshotParts(artifacts, foreignRootDigest)).rejects.toThrow(
      "part-binding-mismatch",
    );
  });

  it("rejects duplicate blob keys, conflicting bytes and unreferenced indexes", async () => {
    const artifacts = new DurableArtifactStore(
      join(await roots.create("docsfab-source-snapshot-"), "store"),
    );
    const source = input();
    const bad = {
      ...source,
      rows: [
        {
          state: "complete" as const,
          sections: 1,
          before: { objectId: "e".repeat(40), bytes: bytes("one"), statedSha256: null },
          after: { objectId: "e".repeat(40), bytes: bytes("two"), statedSha256: null },
        },
      ],
    };
    await expect(retainSourceSnapshotParts(artifacts, bad)).rejects.toThrow("blob-id-conflict");

    const reference = await retainSourceSnapshotParts(artifacts, source);
    const root = (await artifacts.getRecord(reference.rootObjectSha256)) as Record<string, unknown>;
    const blobs = root.blobs as unknown[];
    const duplicate = { ...root, blobs: [...blobs, blobs[0]] };
    const duplicateDigest = opaqueRecordDigest(duplicate);
    await artifacts.putRecord(duplicateDigest, duplicate);
    await expect(readSourceSnapshotParts(artifacts, duplicateDigest)).rejects.toThrow(
      "blob-index-invalid",
    );
  });

  it("holds two distinct blobs in first-side order and rejects a forward or unused index", async () => {
    const artifacts = new DurableArtifactStore(
      join(await roots.create("docsfab-source-snapshot-"), "store"),
    );
    const source = {
      ...input(),
      rows: [
        {
          state: "complete" as const,
          sections: 1,
          before: { objectId: "e".repeat(40), bytes: bytes("before"), statedSha256: null },
          after: { objectId: "f".repeat(40), bytes: bytes("after"), statedSha256: null },
        },
        {
          state: "complete" as const,
          sections: 1,
          before: { objectId: "f".repeat(40), bytes: bytes("after"), statedSha256: null },
          after: { objectId: "e".repeat(40), bytes: bytes("before"), statedSha256: null },
        },
      ],
    };
    const reference = await retainSourceSnapshotParts(artifacts, source);
    const restored = await readSourceSnapshotParts(artifacts, reference.rootObjectSha256);
    expect(restored.root.sideBlobIndices).toEqual([0, 1, 1, 0]);
    expect(restored.blobBytes).toEqual([bytes("before"), bytes("after")]);
    const root = (await artifacts.getRecord(reference.rootObjectSha256)) as Record<string, unknown>;
    for (const edited of [
      { ...root, sideBlobIndices: [1, 0, 1, 0] },
      { ...root, sideReasons: ["source-omitted", null, null, null] },
      {
        ...root,
        blobs: [
          ...(root.blobs as unknown[]),
          { objectId: "1".repeat(40), rawLength: 0, rawSha256: hash(bytes("")) },
        ],
      },
    ]) {
      const digest = opaqueRecordDigest(edited);
      await artifacts.putRecord(digest, edited);
      await expect(readSourceSnapshotParts(artifacts, digest)).rejects.toThrow(
        "blob-index-invalid",
      );
    }
  });

  it("checks readdressed part order, raw length/hash and observation/blob digests", async () => {
    const rootPath = join(await roots.create("docsfab-source-snapshot-"), "store");
    const artifacts = new DurableArtifactStore(rootPath, { maxArtifactBytes: 1800 });
    const source = {
      ...input(),
      diff: { observationId: "diff-1", bytes: bytes("x".repeat(4200)) },
    };
    const reference = await retainSourceSnapshotParts(artifacts, source);
    const root = (await artifacts.getRecord(reference.rootObjectSha256)) as Record<string, unknown>;
    const partDigests = root.partDigests as string[];
    expect(partDigests.length).toBeGreaterThan(1);
    const reordered = {
      ...root,
      partDigests: [partDigests[1], partDigests[0], ...partDigests.slice(2)],
    };
    const reorderedDigest = opaqueRecordDigest(reordered);
    await artifacts.putRecord(reorderedDigest, reordered);
    await expect(readSourceSnapshotParts(artifacts, reorderedDigest)).rejects.toThrow(
      "part-binding-mismatch",
    );

    const firstPart = (await artifacts.getRecord(partDigests[0]!)) as Record<string, unknown>;
    for (const edited of [
      { ...firstPart, rawLength: (firstPart.rawLength as number) + 1 },
      { ...firstPart, rawSha256: "0".repeat(64) },
    ]) {
      const partDigest = opaqueRecordDigest(edited);
      await artifacts.putRecord(partDigest, edited);
      const changedRoot = { ...root, partDigests: [partDigest, ...partDigests.slice(1)] };
      const rootDigest = opaqueRecordDigest(changedRoot);
      await artifacts.putRecord(rootDigest, changedRoot);
      await expect(readSourceSnapshotParts(artifacts, rootDigest)).rejects.toThrow(
        "part-content-mismatch",
      );
    }

    for (const [edited, code] of [
      [
        { ...root, manifest: { ...(root.manifest as object), originalSha256: "0".repeat(64) } },
        "observation-content-mismatch",
      ],
      [
        { ...root, diff: { ...(root.diff as object), originalSha256: "0".repeat(64) } },
        "observation-content-mismatch",
      ],
      [
        {
          ...root,
          blobs: [{ ...((root.blobs as object[])[0] as object), rawSha256: "0".repeat(64) }],
        },
        "blob-content-mismatch",
      ],
    ] as const) {
      const rootDigest = opaqueRecordDigest(edited);
      await artifacts.putRecord(rootDigest, edited);
      await expect(readSourceSnapshotParts(artifacts, rootDigest)).rejects.toThrow(code);
    }
  });
});

describe("pure review diff projection", () => {
  it("preserves ordered hunks, BOM, CRLF text and a final no-newline marker", () => {
    const diff = bytes(
      "diff --git a/old b/new\nrename from old\nrename to new\n--- a/old\n+++ b/new\n@@ -1,2 +1,2 @@\n \ufefffirst\r\n-old\n+new\n\\ No newline at end of file\n",
    );
    expect(projectReviewDiffHunks(diff, [{ state: "complete", sections: 1 }])).toEqual([
      [
        {
          lines: [
            { kind: "context", text: "\ufefffirst", beforeLine: 1, afterLine: 1 },
            { kind: "removed", text: "old", beforeLine: 2, afterLine: null },
            { kind: "added", text: "new", beforeLine: null, afterLine: 2 },
          ],
        },
      ],
    ]);
  });

  it("keeps binary and omitted rows distinct, and isolates an incomplete hunk", () => {
    const diff = bytes("diff --git a/binary b/binary\nBinary files a/binary and b/binary differ\n");
    expect(
      projectReviewDiffHunks(diff, [
        { state: "absent", sections: 1 },
        { state: "truncated", sections: 0 },
      ]),
    ).toEqual([[], []]);
    const malformed = bytes("diff --git a/a b/a\n@@ -1,2 +1,2 @@\n-old\n+new\n");
    expect(projectReviewDiffHunks(malformed, [{ state: "complete", sections: 1 }])).toEqual([null]);
  });

  it("preserves a valid neighboring row when another hunk is malformed", () => {
    const diff = bytes(
      "diff --git a/bad b/bad\n@@ -1,2 +1,2 @@\n-old\n+new\ndiff --git a/good b/good\n@@ -1 +1 @@\n-before\n+after\n",
    );
    const rows = [
      { state: "complete" as const, sections: 1 },
      { state: "complete" as const, sections: 1 },
    ];
    const projected = projectReviewDiffHunks(diff, rows);
    expect(projected[0]).toBeNull();
    expect(projected[1]).toEqual([
      {
        lines: [
          { kind: "removed", text: "before", beforeLine: 1, afterLine: null },
          { kind: "added", text: "after", beforeLine: null, afterLine: 1 },
        ],
      },
    ]);
  });

  it("accepts GitHub's terminated patch plus section LF and keeps adjacent rows", () => {
    const terminated = bytes(
      "diff --git a/one b/one\n--- a/one\n+++ b/one\n@@ -1 +1 @@\n-old\n+new\n\ndiff --git a/two b/two\n--- a/two\n+++ b/two\n@@ -1 +1 @@\n-before\n+after\n",
    );
    const unterminated = bytes(
      "diff --git a/one b/one\n--- a/one\n+++ b/one\n@@ -1 +1 @@\n-old\n+new\ndiff --git a/two b/two\n--- a/two\n+++ b/two\n@@ -1 +1 @@\n-before\n+after\n",
    );
    for (const diff of [terminated, unterminated]) {
      const projected = projectReviewDiffHunks(diff, [
        { state: "complete", sections: 1 },
        { state: "complete", sections: 1 },
      ]);
      expect(projected[0]).toHaveLength(1);
      expect(projected[1]).toHaveLength(1);
    }
  });

  it("keeps hunk order through multiple sections of a type change", () => {
    const diff = bytes(
      "diff --git a/file b/file\n@@ -1 +0,0 @@\n-old\ndiff --git a/file b/file\n@@ -0,0 +1 @@\n+new\n@@ -0,0 +4 @@\n+later\n",
    );
    const [hunks] = projectReviewDiffHunks(diff, [{ state: "complete", sections: 2 }]);
    expect(hunks).toHaveLength(3);
    expect(hunks?.map((hunk) => hunk.lines[0]?.text)).toEqual(["old", "new", "later"]);
  });
});
