// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { readdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { DurableArtifactStore, opaqueRecordDigest } from "../src/artifacts/store.js";
import { limit } from "../src/config/limits.js";
import { canonicalJson } from "../src/content-ir/canonical.js";
import { sourceExtractionLimits } from "../src/inputs/source-extraction.js";
import { openExternalInputAccessCapture } from "../src/inputs/access.js";
import {
  createChangeSource,
  parseChangeSourceSelector,
  type ChangeSourceSourceV1,
  type LocalRangeSelectorV1,
} from "../src/inputs/change-source.js";
import { acquireChangeSourceObservations } from "../src/inputs/change-source/acquisition.js";
import { resolveLocalChangeSource } from "../src/inputs/change-source/local.js";
import { objectId } from "../src/inputs/change-source/objects.js";
import { createSourceBinding } from "../src/inputs/source-evidence.js";
import {
  githubRepositoryIdentity,
  gitlabProjectIdentity,
} from "../src/inputs/change-source/revision.js";
import { runChangeSourceFromAcquired } from "../src/records/change-sources.js";
import { FileRunStore } from "../src/records/file-store.js";
import { reviewDeliverySnapshotDigest } from "../src/review-delivery/plan.js";
import type { ReviewDeliverySnapshot } from "../src/review-delivery/contracts.js";
import {
  loadRetainedReviewSource,
  readSourceSnapshotParts,
  retainSourceSnapshotParts,
} from "../src/review-delivery/source-snapshot-store.js";
import {
  retainReviewDeliverySourceSnapshot,
  type ReviewOriginalSideReader,
} from "../src/review-delivery/source-snapshot-writer.js";
import { temporaryRoots } from "./helpers/temp.js";
import { runRichCandidateFixture } from "./helpers/rich-candidate-run.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";
import { commitFiles, fixtureGit, initChangeRepository } from "./support/change-source-fixture.js";

const roots = temporaryRoots();
const encode = (text: string) => new TextEncoder().encode(text);
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

function runBindingFor(
  acquired: Awaited<ReturnType<typeof acquireChangeSourceObservations>>,
  runId: string,
) {
  const observations = acquired.acquired.map(({ observation }) => ({
    observationId: observation.observationId,
    observationSha256: observation.observationSha256,
  }));
  const first = acquired.acquired[0]!.observation;
  return createSourceBinding({
    runIdSha256: digest(runId),
    repository: first.repository,
    requestSha256: first.requestSha256,
    hostPolicySha256: digest("writer-fixture-policy"),
    producerScopeSha256: digest("writer-fixture-producer-scopes"),
    parentBindingSha256: null,
    observations,
    requiredObservationIds: observations.map(({ observationId }) => observationId),
  });
}

function forgeAddition(provider: "github" | "gitlab") {
  const base = "a".repeat(40);
  const head = "b".repeat(40);
  const afterBytes = encode("new\n");
  const source = createChangeSource({
    source: (provider === "github"
      ? {
          kind: "github-pull-request",
          provenance: "forge-reported",
          host: "github.com",
          repositoryId: 7,
          fullName: "team/docs",
          number: 9,
          state: "open",
          headRepositoryId: 7,
        }
      : {
          kind: "gitlab-merge-request",
          provenance: "forge-reported",
          host: "gitlab.example.com",
          projectPath: "team/docs",
          projectId: 7,
          iid: 9,
          state: "opened",
          mergeMode: null,
          diffRefs: { base, start: base, head },
          mergeCommit: null,
          squashCommit: null,
          fork: false,
        }) as ChangeSourceSourceV1,
    revision: {
      schemaVersion: 1,
      kind: "docsfab-pinned-repository-revision",
      repository:
        provider === "github"
          ? githubRepositoryIdentity({ host: "github.com", repositoryId: 7 })
          : gitlabProjectIdentity({ host: "gitlab.example.com", projectId: 7 }),
      base,
      head,
    },
    objectFormat: "sha1",
    rangeSemantics: provider === "github" ? "three-dot" : "two-dot",
    mergeBase: provider === "github" ? base : null,
    diffFrom: base,
    baseTree: null,
    headTree: null,
    commits: [{ id: head, parents: [base], subject: "Add guide" }],
    files: [
      {
        status: "A",
        similarity: null,
        oldPath: null,
        newPath: "docs/new.md",
        oldMode: provider === "github" ? null : "000000",
        newMode: "100644",
        oldBlob: null,
        newBlob: provider === "github" ? objectId("sha1", "blob", Buffer.from(afterBytes)) : null,
        binary: false,
        added: 1,
        removed: 0,
      },
    ],
    labels: [],
    protocol: { provider },
  });
  const snapshot: ReviewDeliverySnapshot = {
    changeSourceSha256: source.changeSourceSha256,
    files: [
      {
        oldPath: null,
        newPath: "docs/new.md",
        beforeBytes: null,
        afterBytes,
        beforeSha256: null,
        afterSha256: digest("new\n"),
        state: "complete",
        hunks: [],
      },
    ],
  };
  return { source, snapshot };
}

async function fixture(
  options: {
    readonly kind?: "addition" | "deletion" | "empty" | "omitted" | "gitlink" | "binary";
    readonly runId?: string;
  } = {},
) {
  const { repository } = await initChangeRepository(await roots.create("docsfab-source-writer-"), {
    "README.md": "# Fixture\n",
    "docs/a.md": "old\n",
  });
  if (options.kind === "deletion") {
    await rm(join(repository, "docs/a.md"));
    await fixtureGit(repository, ["add", "-A"]);
    await fixtureGit(repository, ["commit", "-q", "-m", "delete"]);
  } else if (options.kind === "empty") {
    await commitFiles(repository, {}, "empty commit", { allowEmpty: true });
  } else if (options.kind === "gitlink") {
    await fixtureGit(repository, [
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${"1".repeat(40)},vendor`,
    ]);
    await fixtureGit(repository, ["commit", "-q", "-m", "add gitlink"]);
  } else if (options.kind === "binary") {
    await commitFiles(repository, { "binary.bin": Uint8Array.from([0, 1, 2, 0, 3]) }, "add binary");
  } else {
    await commitFiles(repository, { "docs/a.md": "new\n", "docs/b.md": "new\n" }, "change");
  }
  const resolved = await resolveLocalChangeSource({
    sourcePath: repository,
    selector: parseChangeSourceSelector("HEAD~1..HEAD") as LocalRangeSelectorV1,
    workspaceRevision: await fixtureGit(repository, ["rev-parse", "HEAD"]),
    ...(options.kind === "omitted"
      ? { limits: { environment: { DOCSFAB_CHANGE_SOURCES_FILE_DIFF_MAX_BYTES: "1" } } }
      : {}),
  });
  const runId = options.runId ?? "writer-run";
  const runIdSha256 = digest(runId);
  const repositoryBinding = {
    identitySha256: resolved.changeSource.revision.repository.identitySha256,
    revision: resolved.changeSource.revision.head,
  };
  const acquired = await acquireChangeSourceObservations({
    resolved,
    externalInputs: openExternalInputAccessCapture({ runIdSha256, repository: repositoryBinding }),
    readScope: ["."],
    runIdSha256,
    repository: repositoryBinding,
    requestSha256: digest("request"),
    observedAt: "2026-01-01T00:00:00.000Z",
    limits: sourceExtractionLimits(),
  });
  const originals = new Map(
    (options.kind === "empty"
      ? []
      : options.kind === "gitlink"
        ? []
        : options.kind === "binary"
          ? ["\0\x01\x02\0\x03"]
          : options.kind === "deletion"
            ? ["old\n"]
            : ["old\n", "new\n"]
    ).map((text) => {
      const bytes = encode(text);
      return [objectId(resolved.changeSource.objectFormat, "blob", Buffer.from(bytes)), bytes];
    }),
  );
  const events: string[] = [];
  const readOriginal: ReviewOriginalSideReader = {
    async inspect(input) {
      events.push(`inspect:${input.blobId}`);
      const bytes = originals.get(input.blobId!);
      if (!bytes) throw new Error("unexpected fixture blob");
      return {
        kind: "verified",
        objectId: input.blobId!,
        objectType: "blob",
        byteLength: bytes.byteLength,
      };
    },
    async read(input) {
      events.push(`read:${input.expected.objectId}`);
      return originals.get(input.expected.objectId)!;
    },
  };
  const artifactRoot = join(await roots.create("docsfab-source-writer-cas-"), "artifacts");
  const artifacts = new DurableArtifactStore(artifactRoot);
  return {
    resolved,
    acquired,
    runId,
    runSourceBinding: runBindingFor(acquired, runId),
    readOriginal,
    artifacts,
    artifactRoot,
    originals,
    events,
  };
}

describe("pre-model retained review source writer", () => {
  it("accepts both admitted forge absent-side encodings and refuses forged absence", () => {
    for (const provider of ["github", "gitlab"] as const) {
      const { source, snapshot } = forgeAddition(provider);
      expect(reviewDeliverySnapshotDigest(snapshot, source)).toMatch(/^[a-f0-9]{64}$/u);
      const { schemaVersion: _version, kind: _kind, changeSourceSha256: _digest, ...body } = source;
      const alternate = createChangeSource({
        ...body,
        files: [
          { ...source.files[0]!, oldMode: source.files[0]!.oldMode === null ? "000000" : null },
        ],
      });
      expect(
        reviewDeliverySnapshotDigest(
          { ...snapshot, changeSourceSha256: alternate.changeSourceSha256 },
          alternate,
        ),
      ).toMatch(/^[a-f0-9]{64}$/u);
      const rejectFile = (change: Partial<(typeof source.files)[number]>) => {
        const file = { ...source.files[0]!, ...change };
        const altered = createChangeSource({ ...body, files: [file] });
        const paired = {
          ...snapshot,
          changeSourceSha256: altered.changeSourceSha256,
          files: [{ ...snapshot.files[0]!, oldPath: file.oldPath, newPath: file.newPath }],
        };
        expect(() => reviewDeliverySnapshotDigest(paired, altered)).toThrow("snapshot-mismatch");
      };
      rejectFile({ oldMode: "100644" });
      rejectFile({ oldBlob: "c".repeat(40) });
      rejectFile({ status: "M" });
      rejectFile({ newPath: null });
      rejectFile({ oldPath: "docs/phantom.md" });
      expect(() =>
        reviewDeliverySnapshotDigest(
          {
            ...snapshot,
            files: [
              {
                ...snapshot.files[0]!,
                beforeBytes: encode("forged"),
                beforeSha256: digest("forged"),
              },
            ],
          },
          source,
        ),
      ).toThrow("snapshot-mismatch");
      expect(() =>
        reviewDeliverySnapshotDigest(
          { ...snapshot, files: [{ ...snapshot.files[0]!, beforeSha256: digest("forged") }] },
          source,
        ),
      ).toThrow("snapshot-mismatch");
    }
  });

  it("inventories distinct blobs before reads, persists actual bytes once and binds the source reference", async () => {
    const input = await fixture();
    // Git's raw addition retains a zero-mode/object sentinel despite having no old path.
    expect(input.resolved.changeSource.files[1]).toMatchObject({
      oldPath: null,
      oldMode: "000000",
      oldBlob: "0".repeat(40),
    });
    const reference = await retainReviewDeliverySourceSnapshot(input);
    const firstRead = input.events.findIndex((event) => event.startsWith("read:"));
    expect(input.events.slice(0, firstRead)).toHaveLength(2);
    expect(input.events.filter((event) => event.startsWith("inspect:"))).toHaveLength(2);
    expect(reference).toMatchObject({
      kind: "docsfab-review-delivery-snapshot-reference",
      schemaVersion: 1,
      runId: input.runId,
      changeSourceSha256: input.resolved.changeSource.changeSourceSha256,
      repositoryIdentitySha256: input.resolved.changeSource.revision.repository.identitySha256,
      reviewedHeadSha: input.resolved.changeSource.revision.head,
    });
    const retained = await readSourceSnapshotParts(input.artifacts, reference.rootObjectSha256);
    expect(retained.root.blobs).toHaveLength(2);
    expect(retained.root.states).toEqual(["complete", "complete"]);
    expect(retained.root.sectionCounts).toEqual([1, 1]);
    expect(retained.root.sideBlobIndices).toEqual([0, 1, null, 1]);
    expect(retained.root.sideReasons[2]).toBe("not-in-source");
    expect(retained.root.sideStatedSha256[2]).toBeNull();
    expect(retained.blobBytes).toEqual([...input.originals.values()]);
  });

  it(
    "refuses changed bytes after inventory before persisting a root",
    async () => {
      const input = await fixture();
      const reader: ReviewOriginalSideReader = {
        inspect: input.readOriginal.inspect,
        async read(value) {
          return value.expected.objectId === [...input.originals.keys()][0]
            ? encode("tampered\n")
            : input.readOriginal.read(value);
        },
      };
      await expect(
        retainReviewDeliverySourceSnapshot({ ...input, readOriginal: reader }),
      ).rejects.toThrow(/blob|object|length/u);
      expect(await readdir(input.artifactRoot).catch(() => [])).toEqual([]);
    },
    testTimeoutMs(limit("test.applicationExecutionTimeoutMs").value),
  );

  it.each(["diff", "manifest"] as const)(
    "pins the admitted %s bytes across asynchronous original inspection",
    async (role) => {
      const saved = await runRichCandidateFixture();
      try {
        const input = await fixture({ runId: saved.saved.id });
        const admitted = Uint8Array.from(
          role === "diff" ? input.resolved.diffBytes : input.resolved.manifestBytes,
        );
        const writable = role === "diff" ? input.resolved.diffBytes : input.resolved.manifestBytes;
        const needle = role === "diff" ? "-old" : "docs/a.md";
        const offset = Buffer.from(writable).indexOf(needle);
        expect(offset).toBeGreaterThanOrEqual(0);
        let mutated = false;
        const reader: ReviewOriginalSideReader = {
          async inspect(value) {
            const checked = await input.readOriginal.inspect(value);
            if (!mutated) {
              writable[offset + (role === "diff" ? 1 : 5)] = "x".charCodeAt(0);
              mutated = true;
            }
            return checked;
          },
          read: input.readOriginal.read,
        };
        const reference = await retainReviewDeliverySourceSnapshot({
          ...input,
          readOriginal: reader,
        });
        expect(mutated).toBe(true);
        const retained = await readSourceSnapshotParts(input.artifacts, reference.rootObjectSha256);
        expect(role === "diff" ? retained.diffBytes : retained.manifestBytes).toEqual(admitted);
        const store = new FileRunStore(
          join(await roots.create("docsfab-source-writer-pinned-cold-"), "state"),
        );
        await store.save({
          ...saved.saved,
          changeSources: [runChangeSourceFromAcquired(input.acquired)],
          reviewDeliverySnapshot: reference,
        });
        const loaded = await loadRetainedReviewSource({
          runStore: store,
          artifacts: input.artifacts,
          runId: input.runId,
        });
        expect(loaded.source).toEqual(input.resolved.changeSource);
      } finally {
        await saved.dispose();
      }
    },
    testTimeoutMs(limit("test.applicationExecutionTimeoutMs").value),
  );

  it("refuses a non-blob inventory without reading the claimed object", async () => {
    const input = await fixture();
    const reader: ReviewOriginalSideReader = {
      async inspect(value) {
        const inspected = await input.readOriginal.inspect(value);
        return { ...inspected, objectType: "tree" } as unknown as typeof inspected;
      },
      read: input.readOriginal.read,
    };
    await expect(
      retainReviewDeliverySourceSnapshot({ ...input, readOriginal: reader }),
    ).rejects.toThrow("blob-inventory-mismatch");
    expect(input.events.some((event) => event.startsWith("read:"))).toBe(false);
  });

  it("keeps the inspected length private when a reader mutates its read argument", async () => {
    const input = await fixture();
    const reader: ReviewOriginalSideReader = {
      async inspect(value) {
        const inspected = await input.readOriginal.inspect(value);
        return { ...inspected, byteLength: 1 };
      },
      async read(value) {
        const bytes = await input.readOriginal.read(value);
        (value.expected as { byteLength: number }).byteLength = bytes.byteLength;
        return bytes;
      },
    };
    await expect(
      retainReviewDeliverySourceSnapshot({ ...input, readOriginal: reader }),
    ).rejects.toThrow("blob-length-mismatch");
    expect(await readdir(input.artifactRoot).catch(() => [])).toEqual([]);
  });

  it("refuses an over-budget unique inventory before reading any original", async () => {
    const input = await fixture();
    await expect(
      retainReviewDeliverySourceSnapshot({
        ...input,
        limits: {
          environment: {
            DOCSFAB_REVIEW_DELIVERY_SNAPSHOT_UNIQUE_ORIGINAL_BYTES_MAX: "1",
            DOCSFAB_CHANGE_SOURCES_GITHUB_OBJECT_MATERIALIZED_MAX_BYTES: "1",
          },
        },
      }),
    ).rejects.toThrow(/reviewDelivery\.snapshotUniqueOriginalBytesMax/u);
    expect(input.events.some((event) => event.startsWith("read:"))).toBe(false);
  });

  it("refuses a mismatched resolved/acquired pair before inspecting blobs", async () => {
    const input = await fixture();
    const other = await fixture();
    await expect(
      retainReviewDeliverySourceSnapshot({ ...input, acquired: other.acquired }),
    ).rejects.toThrow("source-pair-mismatch");
    expect(input.events).toEqual([]);
  });

  it("refuses observations sealed for another repository before reading any original", async () => {
    const input = await fixture();
    const runIdSha256 = digest(input.runId);
    const foreignRepository = {
      identitySha256: digest("foreign-repository"),
      revision: input.resolved.changeSource.revision.head,
    };
    const acquired = await acquireChangeSourceObservations({
      resolved: input.resolved,
      externalInputs: openExternalInputAccessCapture({
        runIdSha256,
        repository: foreignRepository,
      }),
      readScope: ["."],
      runIdSha256,
      repository: foreignRepository,
      requestSha256: digest("request"),
      observedAt: "2026-01-01T00:00:00.000Z",
      limits: sourceExtractionLimits(),
    });
    expect(acquired.acquired.map((entry) => entry.observation.repository)).toEqual([
      foreignRepository,
      foreignRepository,
    ]);
    await expect(retainReviewDeliverySourceSnapshot({ ...input, acquired })).rejects.toThrow(
      "observation-pair-mismatch",
    );
    expect(input.events).toEqual([]);
    expect(await readdir(input.artifactRoot).catch(() => [])).toEqual([]);
  });

  it("refuses one substituted workspace observation under the legitimate run binding", async () => {
    const input = await fixture();
    const foreignRepository = {
      identitySha256: digest("foreign-workspace"),
      revision: input.resolved.changeSource.revision.head,
    };
    const foreign = await acquireChangeSourceObservations({
      resolved: input.resolved,
      externalInputs: openExternalInputAccessCapture({
        runIdSha256: digest(input.runId),
        repository: foreignRepository,
      }),
      readScope: ["."],
      runIdSha256: digest(input.runId),
      repository: foreignRepository,
      requestSha256: digest("request"),
      observedAt: "2026-01-01T00:00:00.000Z",
      limits: sourceExtractionLimits(),
    });
    const acquired = {
      ...input.acquired,
      acquired: [foreign.acquired[0]!, input.acquired.acquired[1]!],
    };
    await expect(retainReviewDeliverySourceSnapshot({ ...input, acquired })).rejects.toThrow(
      "observation-pair-mismatch",
    );
    expect(input.events).toEqual([]);
    expect(await readdir(input.artifactRoot).catch(() => [])).toEqual([]);
  });

  it("requires the exact run, request, workspace head, and both required observation references", async () => {
    const input = await fixture();
    const {
      schemaVersion: _version,
      kind: _kind,
      bindingSha256: _digest,
      ...body
    } = input.runSourceBinding;
    const first = body.observations[0]!;
    const diffId = input.acquired.acquired.find((entry) => entry.role === "diff")!.observation
      .observationId;
    const manifestId = input.acquired.acquired.find((entry) => entry.role === "manifest")!
      .observation.observationId;
    const candidates = [
      { ...body, runIdSha256: digest("other-run") },
      { ...body, requestSha256: digest("other-request") },
      { ...body, repository: { ...body.repository, revision: "f".repeat(40) } },
      { ...body, repository: { ...body.repository, identitySha256: digest("other-workspace") } },
      {
        ...body,
        requiredObservationIds: body.requiredObservationIds.filter((id) => id !== diffId),
      },
      {
        ...body,
        requiredObservationIds: body.requiredObservationIds.filter((id) => id !== manifestId),
      },
      {
        ...body,
        observations: body.observations.slice(1),
        requiredObservationIds: body.requiredObservationIds.slice(1),
      },
      {
        ...body,
        observations: body.observations.map((entry) =>
          entry.observationId === first.observationId
            ? { ...entry, observationSha256: digest("wrong-observation") }
            : entry,
        ),
      },
    ];
    for (const candidate of candidates) {
      const runSourceBinding = createSourceBinding(candidate);
      await expect(
        retainReviewDeliverySourceSnapshot({ ...input, runSourceBinding }),
      ).rejects.toThrow("observation-pair-mismatch");
      expect(input.events).toEqual([]);
      expect(await readdir(input.artifactRoot).catch(() => [])).toEqual([]);
    }
  });

  it(
    "refuses a readdressed raw-empty diff in place of the acquired no-file witness",
    async () => {
      const saved = await runRichCandidateFixture();
      try {
        const input = await fixture({ kind: "empty", runId: saved.saved.id });
        const reference = await retainReviewDeliverySourceSnapshot(input);
        const retained = await readSourceSnapshotParts(input.artifacts, reference.rootObjectSha256);
        const forged = await retainSourceSnapshotParts(input.artifacts, {
          runId: input.runId,
          sourceSha256: reference.changeSourceSha256,
          repositoryIdentitySha256: reference.repositoryIdentitySha256,
          reviewedHeadSha: reference.reviewedHeadSha,
          snapshotSha256: reference.snapshotSha256,
          manifest: {
            observationId: retained.root.manifest.observationId,
            bytes: retained.manifestBytes,
          },
          diff: {
            observationId: retained.root.diff.observationId,
            bytes: new Uint8Array(0),
          },
          rows: [],
        });
        const store = new FileRunStore(
          join(await roots.create("docsfab-source-writer-forged-witness-"), "state"),
        );
        await store.save({
          ...saved.saved,
          changeSources: [runChangeSourceFromAcquired(input.acquired)],
          reviewDeliverySnapshot: { ...reference, rootObjectSha256: forged.rootObjectSha256 },
        });
        await expect(
          loadRetainedReviewSource({
            runStore: store,
            artifacts: input.artifacts,
            runId: input.runId,
          }),
        ).rejects.toThrow("observation-content-mismatch");
      } finally {
        await saved.dispose();
      }
    },
    testTimeoutMs(limit("test.applicationExecutionTimeoutMs").value),
  );

  it(
    "retains a real empty-commit range with exact acquired witness and zero source rows",
    async () => {
      const saved = await runRichCandidateFixture();
      try {
        const input = await fixture({ kind: "empty", runId: saved.saved.id });
        expect(input.resolved.changeSource.files).toEqual([]);
        expect(input.resolved.diffBytes.byteLength).toBe(0);
        const acquiredDiff = input.acquired.acquired[0]!;
        expect(acquiredDiff.observation.original.byteLength).toBeGreaterThan(0);
        const reference = await retainReviewDeliverySourceSnapshot(input);
        expect(input.events).toEqual([]);
        const retained = await readSourceSnapshotParts(input.artifacts, reference.rootObjectSha256);
        expect(retained.root.states).toEqual([]);
        expect(retained.root.blobs).toEqual([]);
        expect(retained.diffBytes.byteLength).toBe(acquiredDiff.observation.original.byteLength);
        expect(new TextDecoder().decode(retained.diffBytes)).toBe(
          "# no file diffs in this range\n",
        );
        const store = new FileRunStore(
          join(await roots.create("docsfab-source-writer-empty-cold-"), "state"),
        );
        await store.save({
          ...saved.saved,
          changeSources: [runChangeSourceFromAcquired(input.acquired)],
          reviewDeliverySnapshot: reference,
        });
        const loaded = await loadRetainedReviewSource({
          runStore: store,
          artifacts: input.artifacts,
          runId: input.runId,
        });
        expect(loaded.source.files).toEqual([]);
        expect(loaded.snapshot.files).toEqual([]);
        const forged = {
          ...input.acquired,
          acquired: [
            {
              ...acquiredDiff,
              observation: {
                ...acquiredDiff.observation,
                original: { ...acquiredDiff.observation.original, sha256: "f".repeat(64) },
              },
            },
            input.acquired.acquired[1]!,
          ],
        };
        await expect(
          retainReviewDeliverySourceSnapshot({ ...input, acquired: forged }),
        ).rejects.toThrow("observation-invalid");
      } finally {
        await saved.dispose();
      }
    },
    testTimeoutMs(limit("test.applicationExecutionTimeoutMs").value),
  );

  it(
    "retains the canonical acquired witness when every changed-file diff is omitted",
    async () => {
      const saved = await runRichCandidateFixture();
      try {
        const input = await fixture({ kind: "omitted", runId: saved.saved.id });
        expect(input.resolved.changeSource.files.length).toBeGreaterThan(0);
        expect(
          input.resolved.changeSource.files.every((file) => file.diffOmitted !== undefined),
        ).toBe(true);
        expect(input.resolved.diffBytes.byteLength).toBe(0);
        const reference = await retainReviewDeliverySourceSnapshot(input);
        const retained = await readSourceSnapshotParts(input.artifacts, reference.rootObjectSha256);
        expect(retained.diffBytes.byteLength).toBe(
          input.acquired.acquired[0]!.observation.original.byteLength,
        );
        expect(new TextDecoder().decode(retained.diffBytes)).toBe(
          "# no file diffs in this range\n",
        );
        expect(retained.root.states).toEqual(["truncated", "truncated"]);
        expect(retained.root.sectionCounts).toEqual([0, 0]);
        const store = new FileRunStore(
          join(await roots.create("docsfab-source-writer-omitted-cold-"), "state"),
        );
        await store.save({
          ...saved.saved,
          changeSources: [runChangeSourceFromAcquired(input.acquired)],
          reviewDeliverySnapshot: reference,
        });
        const loaded = await loadRetainedReviewSource({
          runStore: store,
          artifacts: input.artifacts,
          runId: input.runId,
        });
        expect(loaded.snapshot.files).toHaveLength(2);
        expect(loaded.snapshot.files.every((file) => file.state === "truncated")).toBe(true);
        expect(loaded.snapshot.files.every((file) => file.hunks?.length === 0)).toBe(true);
      } finally {
        await saved.dispose();
      }
    },
    testTimeoutMs(limit("test.applicationExecutionTimeoutMs").value),
  );

  it("refuses a canonical no-file witness paired with an unomitted source row", async () => {
    const input = await fixture();
    const resolved = { ...input.resolved, diffBytes: new Uint8Array(0) };
    const runIdSha256 = digest(input.runId);
    const acquired = await acquireChangeSourceObservations({
      resolved,
      externalInputs: openExternalInputAccessCapture({
        runIdSha256,
        repository: {
          identitySha256: resolved.changeSource.revision.repository.identitySha256,
          revision: resolved.changeSource.revision.head,
        },
      }),
      readScope: ["."],
      runIdSha256,
      repository: {
        identitySha256: resolved.changeSource.revision.repository.identitySha256,
        revision: resolved.changeSource.revision.head,
      },
      requestSha256: digest("request"),
      observedAt: "2026-01-01T00:00:00.000Z",
      limits: sourceExtractionLimits(),
    });
    await expect(
      retainReviewDeliverySourceSnapshot({
        ...input,
        resolved,
        acquired,
        runSourceBinding: runBindingFor(acquired, input.runId),
      }),
    ).rejects.toThrow("diff-section-source-mismatch");
    expect(input.events).toEqual([]);
    expect(await readdir(input.artifactRoot).catch(() => [])).toEqual([]);
  });

  it("retains two ordered sections and both exact blob types for a regular-to-symlink change", async () => {
    const { repository } = await initChangeRepository(
      await roots.create("docsfab-source-writer-type-change-"),
      { "docs/link.md": "old\n" },
    );
    await rm(join(repository, "docs/link.md"));
    await symlink("target.md", join(repository, "docs/link.md"));
    await fixtureGit(repository, ["add", "-A"]);
    await fixtureGit(repository, ["commit", "-q", "-m", "type change"]);
    const resolved = await resolveLocalChangeSource({
      sourcePath: repository,
      selector: parseChangeSourceSelector("HEAD~1..HEAD") as LocalRangeSelectorV1,
      workspaceRevision: await fixtureGit(repository, ["rev-parse", "HEAD"]),
    });
    const runId = "type-change-run";
    const runIdSha256 = digest(runId);
    const repositoryBinding = {
      identitySha256: resolved.changeSource.revision.repository.identitySha256,
      revision: resolved.changeSource.revision.head,
    };
    const acquired = await acquireChangeSourceObservations({
      resolved,
      externalInputs: openExternalInputAccessCapture({
        runIdSha256,
        repository: repositoryBinding,
      }),
      readScope: ["."],
      runIdSha256,
      repository: repositoryBinding,
      requestSha256: digest("request"),
      observedAt: "2026-01-01T00:00:00.000Z",
      limits: sourceExtractionLimits(),
    });
    const originals = new Map(
      ["old\n", "target.md"].map((text) => {
        const bytes = encode(text);
        return [objectId(resolved.changeSource.objectFormat, "blob", Buffer.from(bytes)), bytes];
      }),
    );
    const readOriginal: ReviewOriginalSideReader = {
      async inspect(value) {
        const bytes = originals.get(value.blobId!);
        if (!bytes) throw new Error("unexpected fixture blob");
        return {
          kind: "verified",
          objectId: value.blobId!,
          objectType: "blob",
          byteLength: bytes.byteLength,
        };
      },
      async read(value) {
        return originals.get(value.expected.objectId)!;
      },
    };
    const artifacts = new DurableArtifactStore(
      join(await roots.create("docsfab-source-writer-type-cas-"), "artifacts"),
    );
    const reference = await retainReviewDeliverySourceSnapshot({
      artifacts,
      runId,
      resolved,
      acquired,
      runSourceBinding: runBindingFor(acquired, runId),
      readOriginal,
    });
    const retained = await readSourceSnapshotParts(artifacts, reference.rootObjectSha256);
    expect(resolved.changeSource.files).toHaveLength(1);
    expect(retained.root.sectionCounts).toEqual([2]);
    expect(retained.root.states).toEqual(["complete"]);
    expect(retained.blobBytes).toEqual([...originals.values()]);
  });

  it(
    "cold-loads authentic added and deleted sides and refuses forged absent-side stored metadata",
    async () => {
      const saved = await runRichCandidateFixture();
      try {
        for (const kind of ["addition", "deletion"] as const) {
          const input = await fixture({ kind, runId: saved.saved.id });
          const reference = await retainReviewDeliverySourceSnapshot(input);
          const source = input.resolved.changeSource;
          const absentOrdinal = kind === "addition" ? 1 : 0;
          const absentSideIndex = absentOrdinal * 2 + (kind === "deletion" ? 1 : 0);
          const absentFile = source.files[absentOrdinal]!;
          expect(absentFile).toMatchObject(
            kind === "addition"
              ? { status: "A", oldPath: null, oldMode: "000000", oldBlob: "0".repeat(40) }
              : { status: "D", newPath: null, newMode: "000000", newBlob: "0".repeat(40) },
          );
          const retained = await readSourceSnapshotParts(
            input.artifacts,
            reference.rootObjectSha256,
          );
          expect(retained.root.sideBlobIndices[absentSideIndex]).toBeNull();
          expect(retained.root.sideReasons[absentSideIndex]).toBe("not-in-source");
          expect(retained.root.sideStatedSha256[absentSideIndex]).toBeNull();
          const store = new FileRunStore(
            join(await roots.create("docsfab-source-writer-cold-"), "state"),
          );
          const record = {
            ...saved.saved,
            changeSources: [runChangeSourceFromAcquired(input.acquired)] as const,
            reviewDeliverySnapshot: reference,
          };
          await store.save(record);
          const loaded = await loadRetainedReviewSource({
            runStore: store,
            artifacts: input.artifacts,
            runId: input.runId,
          });
          expect(loaded.source).toEqual(source);
          expect(loaded.snapshot.files[absentOrdinal]).toMatchObject(
            kind === "addition"
              ? {
                  oldPath: null,
                  beforeBytes: null,
                  beforeSha256: null,
                  afterBytes: encode("new\n"),
                }
              : {
                  newPath: null,
                  afterBytes: null,
                  afterSha256: null,
                  beforeBytes: encode("old\n"),
                },
          );
          const {
            schemaVersion: _version,
            kind: _sourceKind,
            changeSourceSha256: _sourceDigest,
            ...sourceBody
          } = source;
          const forgedFiles = source.files.map((file, index) =>
            index === absentOrdinal
              ? {
                  ...file,
                  ...(kind === "addition"
                    ? { oldBlob: "f".repeat(40) }
                    : { newBlob: "f".repeat(40) }),
                }
              : file,
          );
          const forgedSource = createChangeSource({ ...sourceBody, files: forgedFiles });
          expect(() =>
            reviewDeliverySnapshotDigest(
              { ...loaded.snapshot, changeSourceSha256: forgedSource.changeSourceSha256 },
              forgedSource,
            ),
          ).toThrow("snapshot-mismatch");
          const root = (await input.artifacts.getRecord(reference.rootObjectSha256)) as Record<
            string,
            unknown
          >;
          for (const change of [
            (copy: Record<string, unknown>) => {
              (copy.sideBlobIndices as (number | null)[])[absentSideIndex] = 0;
            },
            (copy: Record<string, unknown>) => {
              (copy.sideReasons as (string | null)[])[absentSideIndex] = "source-omitted";
            },
            (copy: Record<string, unknown>) => {
              (copy.sideStatedSha256 as (string | null)[])[absentSideIndex] = digest("forged");
            },
            (copy: Record<string, unknown>) => {
              (copy.sideBlobIndices as (number | null)[])[absentSideIndex] = 0;
              (copy.sideReasons as (string | null)[])[absentSideIndex] = null;
              (copy.sideStatedSha256 as (string | null)[])[absentSideIndex] = digest("old\n");
            },
          ]) {
            const forged = structuredClone(root);
            change(forged);
            const rootObjectSha256 = opaqueRecordDigest(forged);
            await input.artifacts.putRecord(rootObjectSha256, forged);
            const forgedStore = new FileRunStore(
              join(await roots.create("docsfab-source-writer-forged-"), "state"),
            );
            await forgedStore.save({
              ...record,
              reviewDeliverySnapshot: { ...reference, rootObjectSha256 },
            });
            await expect(
              loadRetainedReviewSource({
                runStore: forgedStore,
                artifacts: input.artifacts,
                runId: input.runId,
              }),
            ).rejects.toThrow();
          }
        }
      } finally {
        await saved.dispose();
      }
    },
    testTimeoutMs(limit("test.applicationExecutionTimeoutMs").value),
  );

  it(
    "cold-loads authentic binary and gitlink absent rows without treating their present paths as missing",
    async () => {
      const saved = await runRichCandidateFixture();
      try {
        for (const kind of ["binary", "gitlink"] as const) {
          const input = await fixture({ kind, runId: saved.saved.id });
          const reference = await retainReviewDeliverySourceSnapshot(input);
          const retained = await readSourceSnapshotParts(
            input.artifacts,
            reference.rootObjectSha256,
          );
          expect(retained.root.states).toEqual(["absent"]);
          expect(retained.root.sideReasons[0]).toBe("not-in-source");
          expect(retained.root.sideReasons[1]).toBe(
            kind === "gitlink" ? "unsupported-gitlink" : null,
          );
          const record = {
            ...saved.saved,
            changeSources: [runChangeSourceFromAcquired(input.acquired)] as const,
            reviewDeliverySnapshot: reference,
          };
          const store = new FileRunStore(
            join(await roots.create("docsfab-writer-absent-cold-"), "state"),
          );
          await store.save(record);
          const loaded = await loadRetainedReviewSource({
            runStore: store,
            artifacts: input.artifacts,
            runId: input.runId,
          });
          expect(loaded.snapshot.files[0]).toMatchObject({
            state: "absent",
            oldPath: null,
            newPath: kind === "gitlink" ? "vendor" : "binary.bin",
            beforeBytes: null,
            afterBytes: kind === "gitlink" ? null : Uint8Array.from([0, 1, 2, 0, 3]),
          });
          const root = (await input.artifacts.getRecord(reference.rootObjectSha256)) as Record<
            string,
            unknown
          >;
          const forged = structuredClone(root);
          (forged.sideBlobIndices as (number | null)[])[1] = null;
          (forged.sideReasons as (string | null)[])[1] = "not-in-source";
          const rootObjectSha256 = opaqueRecordDigest(forged);
          await input.artifacts.putRecord(rootObjectSha256, forged);
          const forgedStore = new FileRunStore(
            join(await roots.create("docsfab-writer-absent-forged-"), "state"),
          );
          await forgedStore.save({
            ...record,
            reviewDeliverySnapshot: { ...reference, rootObjectSha256 },
          });
          await expect(
            loadRetainedReviewSource({
              runStore: forgedStore,
              artifacts: input.artifacts,
              runId: input.runId,
            }),
          ).rejects.toThrow();
        }
      } finally {
        await saved.dispose();
      }
    },
    testTimeoutMs(limit("test.applicationExecutionTimeoutMs").value),
  );

  it(
    "retains forge-reported source omission and unsupported-mode reasons across a cold load",
    async () => {
      const { repository } = await initChangeRepository(
        await roots.create("docsfab-writer-forge-unavailable-"),
        { "README.md": "# Fixture\n" },
      );
      await commitFiles(repository, { "docs/new.md": "new\n" }, "add source");
      const local = await resolveLocalChangeSource({
        sourcePath: repository,
        selector: parseChangeSourceSelector("HEAD~1..HEAD") as LocalRangeSelectorV1,
        workspaceRevision: await fixtureGit(repository, ["rev-parse", "HEAD"]),
      });
      const saved = await runRichCandidateFixture();
      try {
        for (const kind of [
          "source-omitted",
          "source-omitted-unsupported-mode",
          "unsupported-mode",
        ] as const) {
          const base = forgeAddition("gitlab").source;
          const {
            schemaVersion: _version,
            kind: _kind,
            changeSourceSha256: _digest,
            ...body
          } = base;
          const source =
            kind === "source-omitted"
              ? base
              : createChangeSource({
                  ...body,
                  files: [
                    {
                      ...base.files[0]!,
                      newBlob:
                        kind === "unsupported-mode"
                          ? objectId("sha1", "blob", Buffer.from("new\n"))
                          : null,
                      newMode: "100664",
                    },
                  ],
                });
          const resolved = {
            changeSource: source,
            manifestBytes: encode(
              `${JSON.stringify(JSON.parse(canonicalJson(source)), null, 2)}\n`,
            ),
            diffBytes:
              kind === "source-omitted"
                ? local.diffBytes
                : encode(
                    new TextDecoder()
                      .decode(local.diffBytes)
                      .replace("new file mode 100644", "new file mode 100664"),
                  ),
          };
          const runId = saved.saved.id;
          const runIdSha256 = digest(runId);
          const repositoryBinding = {
            identitySha256: digest("writer-workspace-repository"),
            revision: source.revision.head,
          };
          expect(repositoryBinding.identitySha256).not.toBe(
            source.revision.repository.identitySha256,
          );
          const acquired = await acquireChangeSourceObservations({
            resolved,
            externalInputs: openExternalInputAccessCapture({
              runIdSha256,
              repository: repositoryBinding,
            }),
            readScope: ["."],
            runIdSha256,
            repository: repositoryBinding,
            requestSha256: digest("request"),
            observedAt: "2026-01-01T00:00:00.000Z",
            limits: sourceExtractionLimits(),
          });
          const artifacts = new DurableArtifactStore(
            join(await roots.create("docsfab-writer-forge-cas-"), "artifacts"),
          );
          const readOriginal: ReviewOriginalSideReader = {
            async inspect() {
              throw new Error("unavailable side must not be inspected");
            },
            async read() {
              throw new Error("unavailable side must not be read");
            },
          };
          const reference = await retainReviewDeliverySourceSnapshot({
            artifacts,
            runId,
            resolved,
            acquired,
            runSourceBinding: runBindingFor(acquired, runId),
            readOriginal,
          });
          const retained = await readSourceSnapshotParts(artifacts, reference.rootObjectSha256);
          expect(retained.root.states).toEqual(["absent"]);
          expect(retained.root.sideReasons).toEqual([
            "not-in-source",
            kind === "unsupported-mode" ? "unsupported-mode" : "source-omitted",
          ]);
          const store = new FileRunStore(
            join(await roots.create("docsfab-writer-forge-cold-"), "state"),
          );
          await store.save({
            ...saved.saved,
            changeSources: [runChangeSourceFromAcquired(acquired)],
            reviewDeliverySnapshot: reference,
          });
          const loaded = await loadRetainedReviewSource({ runStore: store, artifacts, runId });
          expect(loaded.snapshot.files[0]).toMatchObject({
            state: "absent",
            beforeBytes: null,
            afterBytes: null,
            newPath: "docs/new.md",
          });
          if (kind === "unsupported-mode") {
            expect(() =>
              reviewDeliverySnapshotDigest(
                {
                  ...loaded.snapshot,
                  files: [{ ...loaded.snapshot.files[0]!, afterBytes: encode("new\n") }],
                },
                source,
              ),
            ).toThrow("snapshot-mismatch");
          }
          const root = (await artifacts.getRecord(reference.rootObjectSha256)) as Record<
            string,
            unknown
          >;
          const forged = structuredClone(root);
          (forged.sideReasons as (string | null)[])[1] = "not-in-source";
          const rootObjectSha256 = opaqueRecordDigest(forged);
          await artifacts.putRecord(rootObjectSha256, forged);
          const forgedStore = new FileRunStore(
            join(await roots.create("docsfab-writer-forge-forged-"), "state"),
          );
          await forgedStore.save({
            ...saved.saved,
            changeSources: [runChangeSourceFromAcquired(acquired)],
            reviewDeliverySnapshot: { ...reference, rootObjectSha256 },
          });
          await expect(
            loadRetainedReviewSource({ runStore: forgedStore, artifacts, runId }),
          ).rejects.toThrow();
        }
      } finally {
        await saved.dispose();
      }
    },
    testTimeoutMs(limit("test.applicationExecutionTimeoutMs").value),
  );
});
