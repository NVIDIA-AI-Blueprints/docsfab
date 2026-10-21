// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { DurableArtifactStore } from "../src/artifacts/store.js";
import { limit } from "../src/config/limits.js";
import {
  parseChangeSourceSelector,
  type LocalRangeSelectorV1,
} from "../src/inputs/change-source.js";
import { acquireChangeSourceObservations } from "../src/inputs/change-source/acquisition.js";
import { resolveLocalChangeSource } from "../src/inputs/change-source/local.js";
import { objectId } from "../src/inputs/change-source/objects.js";
import { openExternalInputAccessCapture } from "../src/inputs/access.js";
import { sourceExtractionLimits } from "../src/inputs/source-extraction.js";
import { createSourceBinding } from "../src/inputs/source-evidence.js";
import {
  createReviewChangeSource,
  ReviewChangeCapture,
} from "../src/harness/confined-tools/review-change-side.js";
import { retainReviewDeliverySourceSnapshot } from "../src/review-delivery/source-snapshot-writer.js";
import { temporaryRoots } from "./helpers/temp.js";
import { commitFiles, fixtureGit, initChangeRepository } from "./support/change-source-fixture.js";

const roots = temporaryRoots();
const bytes = (text: string) => new TextEncoder().encode(text);
const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

async function pinnedSource(input: {
  readonly initial: Readonly<Record<string, string>>;
  readonly final: Readonly<Record<string, string | null>>;
  readonly runId?: string;
  readonly limits?: { readonly environment: Record<string, string> };
}) {
  const { repository } = await initChangeRepository(
    await roots.create("docsfab-review-side-source-"),
    input.initial,
  );
  await commitFiles(repository, input.final, "change review source");
  const resolved = await resolveLocalChangeSource({
    sourcePath: repository,
    selector: parseChangeSourceSelector("HEAD~1..HEAD") as LocalRangeSelectorV1,
    workspaceRevision: await fixtureGit(repository, ["rev-parse", "HEAD"]),
    ...(input.limits ? { limits: input.limits } : {}),
  });
  const runId = input.runId ?? "review-side-source-run";
  const runIdSha256 = sha256(runId);
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
    requestSha256: sha256("review-side source fixture request"),
    observedAt: "2026-01-01T00:00:00.000Z",
    limits: sourceExtractionLimits(),
  });
  const originals = new Map<string, Uint8Array>();
  for (const text of [...Object.values(input.initial), ...Object.values(input.final)].filter(
    (value): value is string => value !== null,
  )) {
    const raw = bytes(text);
    originals.set(objectId(resolved.changeSource.objectFormat, "blob", Buffer.from(raw)), raw);
  }
  const readOriginal = {
    async inspect(value: { readonly blobId: string | null }) {
      const raw = value.blobId === null ? undefined : originals.get(value.blobId);
      if (!raw || !value.blobId) throw new Error("unexpected fixture blob");
      return {
        kind: "verified" as const,
        objectId: value.blobId,
        objectType: "blob" as const,
        byteLength: raw.byteLength,
      };
    },
    async read(value: { readonly expected: { readonly objectId: string } }) {
      const raw = originals.get(value.expected.objectId);
      if (!raw) throw new Error("unexpected fixture blob");
      return raw;
    },
  };
  const observations = acquired.acquired.map(({ observation }) => ({
    observationId: observation.observationId,
    observationSha256: observation.observationSha256,
  }));
  const first = acquired.acquired[0]!.observation;
  const runSourceBinding = createSourceBinding({
    runIdSha256,
    repository: first.repository,
    requestSha256: first.requestSha256,
    hostPolicySha256: sha256("review-side fixture policy"),
    producerScopeSha256: sha256("review-side fixture producer scopes"),
    parentBindingSha256: null,
    observations,
    requiredObservationIds: observations.map(({ observationId }) => observationId),
  });
  const artifacts = new DurableArtifactStore(
    join(await roots.create("docsfab-review-side-cas-"), "artifacts"),
  );
  const reference = await retainReviewDeliverySourceSnapshot({
    artifacts,
    runId,
    resolved,
    acquired,
    runSourceBinding,
    readOriginal,
    ...(input.limits ? { limits: input.limits } : {}),
  });
  return { artifacts, reference, source: resolved.changeSource };
}

describe("pinned review change side source", () => {
  it("reads the authentic old blob and path for a deletion and refuses its absent after side", async () => {
    const { artifacts, reference, source } = await pinnedSource({
      initial: { "docs/gone.md": "kept before deletion\n" },
      final: { "docs/gone.md": null },
    });
    const pinned = await createReviewChangeSource({ artifacts, reference, source });
    const file = source.files[0]!;
    expect(file).toMatchObject({ status: "D", oldPath: "docs/gone.md", newPath: null });
    expect(pinned.listFiles()).toEqual([
      {
        fileOrdinal: 0,
        oldPath: "docs/gone.md",
        newPath: null,
        beforeAvailable: true,
        afterAvailable: false,
      },
    ]);
    expect(pinned.readSide(0, "before")).toMatchObject({
      oldPath: "docs/gone.md",
      newPath: null,
      blob: file.oldBlob,
      rawSha256: sha256("kept before deletion\n"),
      lines: ["kept before deletion"],
    });
    expect(pinned.readSide(0, "after")).toBeUndefined();
  });

  it("keeps both sides of a same-text rename bound to their respective paths", async () => {
    const { artifacts, reference, source } = await pinnedSource({
      initial: { "docs/old.md": "same bytes on both sides\n" },
      final: { "docs/old.md": null, "docs/new.md": "same bytes on both sides\n" },
    });
    const pinned = await createReviewChangeSource({ artifacts, reference, source });
    const file = source.files[0]!;
    expect(file).toMatchObject({ status: "R", oldPath: "docs/old.md", newPath: "docs/new.md" });
    expect(pinned.listFiles()).toEqual([
      {
        fileOrdinal: 0,
        oldPath: "docs/old.md",
        newPath: "docs/new.md",
        beforeAvailable: true,
        afterAvailable: true,
      },
    ]);
    expect(pinned.readSide(0, "before")).toMatchObject({
      oldPath: "docs/old.md",
      newPath: "docs/new.md",
      blob: file.oldBlob,
    });
    expect(pinned.readSide(0, "after")).toMatchObject({
      oldPath: "docs/old.md",
      newPath: "docs/new.md",
      blob: file.newBlob,
    });
    expect(pinned.readSide(0, "before")?.rawSha256).toBe(sha256("same bytes on both sides\n"));
    expect(pinned.readSide(0, "after")?.rawSha256).toBe(sha256("same bytes on both sides\n"));
  });

  it("retains real CRLF and unterminated physical bytes through read and range selection", async () => {
    const original = "first\r\nlast";
    const { artifacts, reference, source } = await pinnedSource({
      initial: { "docs/terminators.md": original },
      final: { "docs/terminators.md": "first\nlast\n" },
    });
    const pinned = await createReviewChangeSource({ artifacts, reference, source });
    expect(
      pinned.readSide(0, "before")?.lineBytes.map((line) => Buffer.from(line).toString("utf8")),
    ).toEqual(["first\r\n", "last"]);
    const capture = new ReviewChangeCapture(
      pinned,
      reference.runId,
      "verify-technical-accuracy",
      limit("artifacts.maxObjectBytes").value,
    );
    const read = await capture
      .observeDelivered(capture.readTool())
      .execute(
        "read-terminators",
        { fileOrdinal: 0, side: "before", startLine: 1, endLine: 2 },
        undefined,
        undefined,
        undefined as never,
      );
    expect(read.content[0]?.text).toContain("[source-line 1] first\r\n[source-line 2] last");
    expect(read.content[0]?.text).not.toMatch(/last\n$/u);
    await capture.selectTool().execute(
      "select-terminators",
      {
        originalIssueId: "TECH-TERMINATORS",
        fileOrdinal: 0,
        side: "before",
        startLine: 1,
        endLine: 2,
      },
      undefined,
      undefined,
      undefined as never,
    );
    expect(capture.snapshot().proposals[0]?.rangeSha256).toBe(sha256(original));
  });

  it("preserves a reused old path and a copied path as separate modify and add sides", async () => {
    const { artifacts, reference, source } = await pinnedSource({
      initial: { "docs/old.md": "moved document\n" },
      final: { "docs/old.md": "new document at old path\n", "docs/moved.md": "moved document\n" },
    });
    const pinned = await createReviewChangeSource({ artifacts, reference, source });
    expect(source.files).toHaveLength(2);
    const reused = source.files.find(({ status }) => status === "M")!;
    const added = source.files.find(({ status }) => status === "A")!;
    expect(reused).toMatchObject({ oldPath: "docs/old.md", newPath: "docs/old.md" });
    expect(added).toMatchObject({ oldPath: null, newPath: "docs/moved.md" });
    const reusedOrdinal = source.files.indexOf(reused);
    const addOrdinal = source.files.indexOf(added);
    expect(pinned.readSide(reusedOrdinal, "before")).toMatchObject({
      oldPath: "docs/old.md",
      newPath: "docs/old.md",
      blob: reused.oldBlob,
      lines: ["moved document"],
    });
    expect(pinned.readSide(reusedOrdinal, "after")).toMatchObject({
      oldPath: "docs/old.md",
      newPath: "docs/old.md",
      blob: reused.newBlob,
      lines: ["new document at old path"],
    });
    expect(pinned.readSide(addOrdinal, "after")).toMatchObject({
      oldPath: null,
      newPath: "docs/moved.md",
      lines: ["moved document"],
    });
  });

  it("refuses empty, unavailable, and out-of-range side reads", async () => {
    const empty = await pinnedSource({
      initial: { "docs/empty.md": "" },
      final: { "docs/empty.md": "now populated\n" },
    });
    const emptySource = await createReviewChangeSource(empty);
    expect(emptySource.readSide(0, "before")).toBeUndefined();
    expect(emptySource.listFiles()).toMatchObject([
      { beforeAvailable: false, afterAvailable: true },
    ]);

    const omitted = await pinnedSource({
      initial: { "docs/large.md": "old content\n" },
      final: { "docs/large.md": "new content\n" },
      limits: { environment: { DOCSFAB_CHANGE_SOURCES_FILE_DIFF_MAX_BYTES: "1" } },
    });
    const omittedSource = await createReviewChangeSource(omitted);
    expect(omittedSource.readSide(0, "before")).toBeUndefined();
    expect(omittedSource.readSide(0, "after")).toBeUndefined();
    expect(omittedSource.listFiles()).toMatchObject([
      {
        oldPath: "docs/large.md",
        newPath: "docs/large.md",
        beforeAvailable: false,
        afterAvailable: false,
      },
    ]);

    const captured = new ReviewChangeCapture(
      await createReviewChangeSource({
        ...empty,
        reference: { ...empty.reference, runId: "review-side-source-run" },
      }),
      "review-side-source-run",
      "step",
      limit("artifacts.maxObjectBytes").value,
    );
    // A one-line read ending beyond the pinned physical side must be refused as incomplete.
    const tool = captured.readTool();
    await expect(
      tool.execute(
        "truncated-range",
        { fileOrdinal: 0, side: "after", startLine: 1, endLine: 2 },
        undefined,
        undefined,
        undefined as never,
      ),
    ).rejects.toThrow(/unavailable/u);
  });
});
