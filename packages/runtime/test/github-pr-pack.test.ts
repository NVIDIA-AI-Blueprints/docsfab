// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { testTimeoutMs } from "./helpers/test-timeouts.js";
import {
  GithubPackPreflightError,
  preflightGithubPack,
} from "../src/inputs/adapters/github-pr-pack.js";

function packEntry(type: number, content: Buffer, prefix = Buffer.alloc(0)): Buffer {
  let size = content.length;
  let first = ((type & 7) << 4) | (size & 0x0f);
  size = Math.floor(size / 16);
  if (size > 0) first |= 0x80;
  const header = [first];
  while (size > 0) {
    let b = size & 0x7f;
    size = Math.floor(size / 128);
    if (size > 0) b |= 0x80;
    header.push(b);
  }
  return Buffer.concat([Buffer.from(header), prefix, deflateSync(content)]);
}
function makePack(entries: Buffer[], version = 2, count = entries.length): Buffer {
  const body = Buffer.concat([Buffer.from("PACK"), u32(version), u32(count), ...entries]);
  return Buffer.concat([body, createHash("sha1").update(body).digest()]);
}
function resign(pack: Buffer): Buffer {
  const body = pack.subarray(0, -20);
  return Buffer.concat([body, createHash("sha1").update(body).digest()]);
}
function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
}
function limits(
  overrides: Partial<{
    packInflatedMaxBytes: number;
    objectMaterializedMaxBytes: number;
    objectsMax: number;
  }> = {},
) {
  return {
    packInflatedMaxBytes: 100_000,
    objectMaterializedMaxBytes: 100_000,
    objectsMax: 20,
    ...overrides,
  };
}
async function rejected(pack: Buffer, budget = limits()) {
  await expect(preflightGithubPack(pack, budget)).rejects.toBeInstanceOf(GithubPackPreflightError);
}

describe("github PR pack preflight", () => {
  it("admits exact entry and aggregate boundaries", async () => {
    const pack = makePack([
      packEntry(3, Buffer.from("hello")),
      packEntry(3, Buffer.from("world!")),
    ]);
    await expect(
      preflightGithubPack(
        pack,
        limits({ packInflatedMaxBytes: 11, objectMaterializedMaxBytes: 11, objectsMax: 2 }),
      ),
    ).resolves.toMatchObject({
      version: 2,
      objectCount: 2,
      inflatedBytes: 11,
      materializedBytes: 11,
    });
    await expect(
      preflightGithubPack(pack, limits({ packInflatedMaxBytes: 10 })),
    ).rejects.toMatchObject({ code: "inflated-byte-limit", observed: 11 });
    await expect(
      preflightGithubPack(pack, limits({ objectMaterializedMaxBytes: 10 })),
    ).rejects.toMatchObject({ code: "materialized-byte-limit", observed: 11 });
    await expect(preflightGithubPack(pack, limits({ objectsMax: 1 }))).rejects.toMatchObject({
      code: "object-count-limit",
      observed: 2,
    });
  });

  it("admits an empty blob and a one-byte blob without rounding their size", async () => {
    const admitted = await preflightGithubPack(
      makePack([packEntry(3, Buffer.alloc(0)), packEntry(3, Buffer.from("x"))]),
      limits({ packInflatedMaxBytes: 1, objectMaterializedMaxBytes: 1, objectsMax: 2 }),
    );
    expect(admitted.entries.map((entry) => entry.materializedLength)).toEqual([0, 1]);
    expect(admitted.inflatedBytes).toBe(1);
  });

  it("rejects inflated bombs before exceeding the supplied budget", async () => {
    const pack = makePack([packEntry(3, Buffer.alloc(64 * 1024, 65))]);
    await rejected(pack, limits({ packInflatedMaxBytes: 1024 }));
  });

  it("charges a delta target size separately from its small instruction payload", async () => {
    const delta = Buffer.from([0, 0x80, 0x80, 0x40]); // base size 0, target size 1 MiB
    const pack = makePack([packEntry(7, delta, Buffer.alloc(20))]);
    await rejected(
      pack,
      limits({ packInflatedMaxBytes: delta.length, objectMaterializedMaxBytes: 1024 }),
    );
  });

  it("walks OFS and REF metadata without applying deltas", async () => {
    const base = packEntry(3, Buffer.from("base"));
    const ofsDelta = packEntry(6, Buffer.from([4, 4, 0x90, 4]), Buffer.from([base.length]));
    const refDelta = packEntry(7, Buffer.from([4, 4, 0x90, 4]), Buffer.alloc(20, 1));
    const result = await preflightGithubPack(makePack([base, ofsDelta, refDelta]), limits());
    expect(result.entries.map((entry) => entry.type)).toEqual(["blob", "ofs-delta", "ref-delta"]);
    expect(result.materializedBytes).toBe(12);
  });

  it("refuses truncation, trailing bytes, checksum damage, bad OFS, and count mismatch", async () => {
    const entry = packEntry(3, Buffer.from("x"));
    const valid = makePack([entry]);
    await rejected(valid.subarray(0, valid.length - 1));
    await rejected(makePack([Buffer.concat([entry, Buffer.from([0])])]));
    const corrupt = Buffer.from(valid);
    corrupt[corrupt.length - 1] = corrupt[corrupt.length - 1]! ^ 1;
    await rejected(corrupt);
    await rejected(makePack([packEntry(6, Buffer.from([0, 0]), Buffer.from([127]))]));
    await rejected(makePack([entry], 2, 2));
  });

  it("refuses truncated zlib streams, entry size mismatch, and overflowing delta varints", async () => {
    const entry = packEntry(3, Buffer.from("x"));
    await rejected(resign(makePack([entry.subarray(0, -1)])));
    const wrongSize = Buffer.from(entry);
    wrongSize[0] = wrongSize[0]! + 1;
    await rejected(makePack([wrongSize]));
    const overflowDelta = Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f]);
    await rejected(makePack([packEntry(7, overflowDelta, Buffer.alloc(20))]));
  });

  it(
    "admits native OFS and forward REF deltas that Git reconstructs",
    async () => {
      const base = Buffer.from("base");
      const target = Buffer.from("base!");
      const blobId = (body: Buffer) =>
        createHash("sha1")
          .update(Buffer.from(`blob ${body.length}\0`, "ascii"))
          .update(body)
          .digest("hex");
      const delta = Buffer.from([4, 5, 0x90, 4, 1, 33]);
      const baseEntry = packEntry(3, base);
      const packs = [
        makePack([baseEntry, packEntry(6, delta, Buffer.from([baseEntry.length]))]),
        makePack([packEntry(7, delta, Buffer.from(blobId(base), "hex")), baseEntry]),
      ];
      const root = mkdtempSync(join(tmpdir(), "github-pr-native-deltas-"));
      const repository = join(root, "mirror.git");
      try {
        execFileSync("git", ["init", "-q", "--bare", "--object-format=sha1", repository]);
        for (const pack of packs) {
          const admitted = await preflightGithubPack(pack, limits());
          expect(admitted.objectCount).toBe(2);
          expect(admitted.materializedBytes).toBe(base.length + target.length);
          const imported = execFileSync(
            "git",
            ["--git-dir", repository, "index-pack", "--stdin", "--fsck-objects"],
            { input: pack },
          );
          expect(imported.toString("ascii")).toMatch(/^pack\t[0-9a-f]{40}\n$/u);
          expect(
            execFileSync("git", ["--git-dir", repository, "cat-file", "blob", blobId(target)]),
          ).toEqual(target);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    testTimeoutMs(30000),
  );

  it("supports PACK v3 and honors cancellation", async () => {
    await expect(
      preflightGithubPack(makePack([packEntry(3, Buffer.from("ok"))], 3), limits()),
    ).resolves.toMatchObject({ version: 3, objectCount: 1 });
    const controller = new AbortController();
    controller.abort();
    await expect(
      preflightGithubPack(makePack([packEntry(3, Buffer.from("ok"))]), limits(), {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "cancelled" });
  });

  it(
    "interrupts an active preflight worker and reports its deadline",
    async () => {
      const pack = makePack([packEntry(3, Buffer.alloc(8 * 1024 * 1024, 65))]);
      const controller = new AbortController();
      const pending = preflightGithubPack(
        pack,
        limits({
          packInflatedMaxBytes: 8 * 1024 * 1024,
          objectMaterializedMaxBytes: 8 * 1024 * 1024,
        }),
        { signal: controller.signal },
      );
      controller.abort();
      await expect(pending).rejects.toMatchObject({ code: "cancelled" });
      await expect(
        preflightGithubPack(
          pack,
          limits({
            packInflatedMaxBytes: 8 * 1024 * 1024,
            objectMaterializedMaxBytes: 8 * 1024 * 1024,
          }),
          { deadlineAt: Date.now() + 1 },
        ),
      ).rejects.toMatchObject({ code: "deadline" });
    },
    testTimeoutMs(30000),
  );

  it(
    "preflights a real native Git pack containing a delta",
    async () => {
      const repo = mkdtempSync(join(tmpdir(), "github-pr-pack-"));
      const git = (...args: string[]) =>
        execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
      try {
        git("init", "-q");
        git("config", "user.email", "fixture@example.invalid");
        git("config", "user.name", "Fixture");
        for (let revision = 0; revision < 4; revision++) {
          writeFileSync(
            join(repo, "payload.md"),
            `${"a".repeat(12_000)}revision=${revision}\n${"b".repeat(12_000)}\n`,
          );
          git("add", "payload.md");
          git("commit", "-qm", `revision ${revision}`);
        }
        const pack = execFileSync("git", ["-C", repo, "pack-objects", "--stdout", "--all"]);
        const result = await preflightGithubPack(pack, limits());
        expect(result.objectCount).toBeGreaterThan(4);
        expect(
          result.entries.some((entry) => entry.type === "ofs-delta" || entry.type === "ref-delta"),
        ).toBe(true);
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    },
    testTimeoutMs(30000),
  );
});
