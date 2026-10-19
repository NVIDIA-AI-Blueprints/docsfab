// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Pinned local Git object reads for the review source snapshot writer. */
import { describe, expect, it } from "vitest";

import { limit } from "../src/config/limits.js";
import { MAX_GIT_OUTPUT_BYTES } from "../src/host-invoker/trusted-git.js";
import { objectId, type RawObjectReader } from "../src/inputs/change-source/objects.js";
import {
  createChangeSourceOriginalSideReader,
  createWorkspaceOriginalSideReader,
  OriginalSideReaderError,
} from "../src/inputs/change-source/original-side-reader.js";
import { temporaryRoots } from "./helpers/temp.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";
import { fixtureGit, initChangeRepository } from "./support/change-source-fixture.js";

const roots = temporaryRoots();

const side = (blobId: string, mode = "100644") => ({
  ordinal: 0,
  side: "before" as const,
  path: "only.md",
  blobId,
  mode,
});

function expectCode(promise: Promise<unknown>, code: OriginalSideReaderError["code"]) {
  return expect(promise).rejects.toMatchObject({ name: "OriginalSideReaderError", code });
}

describe("change-source original-side reader", () => {
  it.each(["sha1", "sha256"] as const)(
    "reads actual %s original blob bytes from a local Git object",
    async (objectFormat) => {
      const bytes = Buffer.from("Before\r\n\ufeffafter\n", "utf8");
      const { repository } = await initChangeRepository(
        await roots.create("docsfab-original-side-"),
        { "only.md": bytes },
        { objectFormat },
      );
      const blobId = await fixtureGit(repository, ["rev-parse", "HEAD:only.md"]);
      const reader = createWorkspaceOriginalSideReader({ sourcePath: repository, objectFormat });
      const inspected = await reader.inspect(side(blobId));
      expect(inspected).toEqual({
        kind: "verified",
        objectId: blobId,
        objectType: "blob",
        byteLength: bytes.byteLength,
      });
      if (inspected.kind !== "verified") throw new Error("fixture blob was not verified");
      expect(
        Buffer.from(await reader.read({ ordinal: 0, side: "before", expected: inspected })),
      ).toEqual(bytes);
    },
  );

  it.each(["sha1", "sha256"] as const)(
    "reads a %s blob above the buffered Git output cap but inside snapshot capacity",
    { timeout: testTimeoutMs(60_000) },
    async (objectFormat) => {
      const bytes = Buffer.alloc(MAX_GIT_OUTPUT_BYTES + 1, 0x61);
      expect(bytes.byteLength).toBeLessThan(
        limit("reviewDelivery.snapshotUniqueOriginalBytesMax").value,
      );
      const { repository } = await initChangeRepository(
        await roots.create("docsfab-original-side-large-"),
        { "only.bin": bytes },
        { objectFormat },
      );
      const blobId = await fixtureGit(repository, ["rev-parse", "HEAD:only.bin"]);
      const reader = createWorkspaceOriginalSideReader({ sourcePath: repository, objectFormat });
      const inspected = await reader.inspect({ ...side(blobId), path: "only.bin" });
      if (inspected.kind !== "verified") throw new Error("fixture blob was not verified");
      expect(
        Buffer.from(await reader.read({ ordinal: 0, side: "before", expected: inspected })),
      ).toEqual(bytes);
    },
  );

  it("refuses a real non-blob object during metadata preflight", async () => {
    const { repository } = await initChangeRepository(await roots.create("docsfab-original-side-"));
    const commitId = await fixtureGit(repository, ["rev-parse", "HEAD"]);
    const reader = createWorkspaceOriginalSideReader({
      sourcePath: repository,
      objectFormat: "sha1",
    });
    await expectCode(reader.inspect(side(commitId)), "original-side-type-mismatch");
  });

  it("returns unavailable for gitlinks and unsupported modes without reading Git", async () => {
    const reader = createChangeSourceOriginalSideReader({
      objectFormat: "sha1",
      shallow: false,
      run: async () => {
        throw new Error("unavailable sides must not read Git");
      },
    });
    const id = "a".repeat(40);
    await expect(reader.inspect(side(id, "160000"))).resolves.toEqual({
      kind: "unavailable",
      reason: "unsupported-gitlink",
    });
    await expect(reader.inspect(side(id, "100600"))).resolves.toEqual({
      kind: "unavailable",
      reason: "unsupported-mode",
    });
  });

  it("requires matching inspected identity before returning bytes", async () => {
    const body = Buffer.from("good");
    const id = objectId("sha1", "blob", body);
    const reader = createChangeSourceOriginalSideReader(fakeGit(id, body));
    const expected = {
      kind: "verified" as const,
      objectId: id,
      objectType: "blob" as const,
      byteLength: 4,
    };
    await expectCode(
      reader.read({ ordinal: 0, side: "before", expected }),
      "original-side-read-uninspected",
    );
    const inspected = await reader.inspect(side(id));
    if (inspected.kind !== "verified") throw new Error("fixture blob was not verified");
    await expectCode(
      reader.read({ ordinal: 1, side: "before", expected: inspected }),
      "original-side-read-uninspected",
    );
    await expectCode(
      reader.read({ ordinal: 0, side: "before", expected: { ...inspected, byteLength: 5 } }),
      "original-side-read-uninspected",
    );
  });

  it("refuses changed bytes even when metadata still claims the expected blob", async () => {
    const original = Buffer.from("good");
    const id = objectId("sha1", "blob", original);
    const reader = createChangeSourceOriginalSideReader(
      fakeGit(id, Buffer.from("evil"), original.length),
    );
    const inspected = await reader.inspect(side(id));
    if (inspected.kind !== "verified") throw new Error("fixture blob was not verified");
    await expectCode(
      reader.read({ ordinal: 0, side: "before", expected: inspected }),
      "original-side-object-id-mismatch",
    );
  });

  it("refuses bytes whose actual type or length differs from preflight", async () => {
    const original = Buffer.from("good");
    const id = objectId("sha1", "blob", original);
    for (const [body, type, code] of [
      [original, "tree", "original-side-type-mismatch"],
      [Buffer.from("longer"), "blob", "original-side-length-mismatch"],
    ] as const) {
      const reader = createChangeSourceOriginalSideReader(fakeGit(id, body, original.length, type));
      const inspected = await reader.inspect(side(id));
      if (inspected.kind !== "verified") throw new Error("fixture blob was not verified");
      await expectCode(reader.read({ ordinal: 0, side: "before", expected: inspected }), code);
    }
  });
});

function fakeGit(
  id: string,
  body: Buffer,
  claimedLength = body.length,
  actualType = "blob",
): RawObjectReader {
  return {
    objectFormat: "sha1",
    shallow: false,
    async run(args) {
      if (args[0] !== "cat-file") throw new Error("unexpected Git operation");
      if (args[1] === "--batch-check") return Buffer.from(`${id} blob ${claimedLength}\n`);
      if (args[1] === "--batch")
        return Buffer.concat([
          Buffer.from(`${id} ${actualType} ${body.length}\n`),
          body,
          Buffer.from("\n"),
        ]);
      throw new Error("unexpected Git operation");
    },
  };
}
