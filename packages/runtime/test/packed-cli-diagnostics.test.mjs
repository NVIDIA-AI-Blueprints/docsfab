// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { comparePackedArchives } from "../scripts/lib/packed-cli-diagnostics.mjs";
import { assertPackedCandidateReproducible } from "../scripts/lib/packed-cli.mjs";

function archive(members, modes = {}) {
  const blocks = [];
  for (const [path, contents] of Object.entries(members)) {
    const body = Buffer.from(contents);
    const header = Buffer.alloc(512);
    header.write(path, 0, 100, "utf8");
    header.write(`${modes[path] ?? "0000644"}\0`, 100, 8, "ascii");
    header.write("0000000\0", 108, 8, "ascii");
    header.write("0000000\0", 116, 8, "ascii");
    header.write(body.byteLength.toString(8).padStart(11, "0") + "\0", 124, 12, "ascii");
    header.write("00000000000\0", 136, 12, "ascii");
    header.fill(32, 148, 156);
    header[156] = 48;
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
    blocks.push(header, body, Buffer.alloc((512 - (body.byteLength % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks), { mtime: 0 });
}

describe("packed archive reproducibility diagnostics", () => {
  it("accepts an exact byte pair without diagnostic differences", () => {
    const candidate = archive({
      "package/package.json": "same metadata",
      "package/dist/cli.js": "same payload",
    });
    const repeated = Buffer.from(candidate);
    expect(() => assertPackedCandidateReproducible(candidate, repeated)).not.toThrow();
    const result = comparePackedArchives(candidate, repeated);
    expect(result.differingMemberCount).toBe(0);
    expect(result.classification).toBe("exact-byte-match");
  });

  it("reports bounded hash-only member differences", () => {
    const candidate = archive({
      "package/package.json": '{"version":"1.0.0-main.12345678"}',
      "package/npm-shrinkwrap.json": '{"version":"1.0.0-main.12345678"}',
      "package/dist/cli.js": "same payload",
    });
    const repeated = archive({
      "package/package.json": '{"version":"1.0.0-main.abcdefgh"}',
      "package/npm-shrinkwrap.json": '{"version":"1.0.0-main.abcdefgh"}',
      "package/dist/cli.js": "same payload",
    });
    const result = comparePackedArchives(candidate, repeated);
    expect(result.gate).toBe("failed");
    expect(result.classification).toBe("manifest-only-difference-review-required");
    expect(result.differingMembers.map(({ path }) => path)).toEqual([
      "package/npm-shrinkwrap.json",
      "package/package.json",
    ]);
    expect(JSON.stringify(result)).not.toContain("same payload");
    expect(JSON.stringify(result)).not.toContain("1.0.0-main.");
    expect(() => assertPackedCandidateReproducible(candidate, repeated)).toThrow(
      /exact packed candidate bytes/u,
    );
  });

  it("distinguishes executable payload changes", () => {
    const result = comparePackedArchives(
      archive({ "package/dist/cli.js": "first" }),
      archive({ "package/dist/cli.js": "second" }),
    );
    expect(result.classification).toBe("member-content-difference-review-required");
    expect(result.differingMembers[0].path).toBe("package/dist/cli.js");
    expect(result.differingMembers[0].candidate.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(() =>
      assertPackedCandidateReproducible(
        archive({ "package/dist/cli.js": "first" }),
        archive({ "package/dist/cli.js": "second" }),
      ),
    ).toThrow(/exact packed candidate bytes/u);
  });

  it("keeps strict refusal when bounded diagnostics cannot inspect a malformed pair", () => {
    const candidate = archive({ "package/dist/cli.js": "accepted" });
    const malformed = Buffer.from("not a gzip archive");
    expect(() => comparePackedArchives(candidate, malformed)).toThrow();
    expect(() => assertPackedCandidateReproducible(candidate, malformed)).toThrow(
      /exact packed candidate bytes/u,
    );
  });

  it("classifies tar header metadata changes without exposing member bytes", () => {
    const candidate = archive({ "package/dist/cli.js": "same payload" });
    const repeated = archive(
      { "package/dist/cli.js": "same payload" },
      { "package/dist/cli.js": "0000755" },
    );
    const result = comparePackedArchives(candidate, repeated);
    expect(result.classification).toBe("tar-metadata-only-difference-review-required");
    expect(result.differingMemberCount).toBe(0);
    expect(result.differingHeaderCount).toBe(1);
    expect(JSON.stringify(result)).not.toContain("same payload");
  });

  it("retains compressed-stream evidence for gzip-only differences", () => {
    const candidate = archive({ "package/dist/cli.js": "same" });
    const repeated = Buffer.from(candidate);
    repeated[4] = 1;
    const result = comparePackedArchives(candidate, repeated);
    expect(result.differingMemberCount).toBe(0);
    expect(result.candidate.compressed.sha256).not.toBe(result.repeated.compressed.sha256);
    expect(result.candidate.expanded.sha256).toBe(result.repeated.expanded.sha256);
    expect(result.classification).toBe("gzip-only-difference-review-required");
    expect(() => assertPackedCandidateReproducible(candidate, repeated)).toThrow(
      /exact packed candidate bytes/u,
    );
  });
});
