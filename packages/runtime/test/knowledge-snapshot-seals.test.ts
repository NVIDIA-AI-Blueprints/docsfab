// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { decodeKnowledgeAcceptedSnapshot } from "../src/canon/index.js";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const fixtureRoot = "packages/runtime/test/fixtures/public-runtime/knowledge";
const source = `${fixtureRoot}/source/knowledge-accepted-snapshot.json`;
const copy = `${fixtureRoot}/copy/knowledge-accepted-snapshot.json`;
const snapshots = execFileSync("git", ["ls-files", "-z", "--", `${fixtureRoot}/`], {
  cwd: repositoryRoot,
  encoding: "utf8",
})
  .split("\0")
  .filter((path) => path.endsWith("/knowledge-accepted-snapshot.json"))
  .sort();
const readSnapshot = (path: string): Record<string, unknown> =>
  JSON.parse(readFileSync(resolve(repositoryRoot, path), "utf8")) as Record<string, unknown>;

describe("independently authored tracked knowledge snapshot seals", () => {
  it("enumerates both portable copies it must seal", () => {
    expect(snapshots).toEqual([copy, source]);
  });

  it.each(snapshots)("decodes %s with its recorded seal", (path) => {
    const decoded = decodeKnowledgeAcceptedSnapshot(readSnapshot(path));
    expect(decoded.kind).toBe("knowledge-accepted-snapshot");
    expect(decoded.snapshotSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("retains byte-identical source and cached example snapshots", () => {
    expect(readFileSync(resolve(repositoryRoot, source))).toEqual(
      readFileSync(resolve(repositoryRoot, copy)),
    );
  });

  it("refuses an edited body whose original seal was retained", () => {
    const edited = readSnapshot(source);
    (edited.claims as { statement: string }[])[0]!.statement =
      "The edited statement has no matching seal.";
    expect(() => decodeKnowledgeAcceptedSnapshot(edited)).toThrowError(
      expect.objectContaining({ code: "digest-mismatch" }),
    );
  });
});
