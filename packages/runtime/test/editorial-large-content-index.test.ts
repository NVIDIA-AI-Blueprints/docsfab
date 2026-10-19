// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalDigest } from "../src/content-ir/index.js";
import {
  admitEditorialEvidence,
  completeNoChangeDecision,
  contentIndexOfAtLeast,
  replayNoChangeDecision,
} from "./helpers/editorial-large-index.js";
import { temporaryRoots } from "./helpers/temp.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";

const OVERRIDE = "DOCSFAB_ARTIFACTS_MAX_OBJECT_BYTES";
/** Just over 20 MB, above the 17,410,521-byte vLLM Semantic Router index. */
const LARGE_INDEX_BYTES = 20 * 1024 * 1024 + 1;
const LOWERED_BOUND = 4 * 1024 * 1024;
const CASE_TIMEOUT = testTimeoutMs(180_000);
const PART_KIND = "docsfab-editorial-content-index-part";

const roots = temporaryRoots();

afterEach(() => {
  delete process.env[OVERRIDE];
});

describe("editorial admission of a content index over 20 MB (#1932)", () => {
  it(
    "admits and replays the whole index as one object under the default object bound",
    async () => {
      const index = contentIndexOfAtLeast(LARGE_INDEX_BYTES);
      expect(Buffer.byteLength(JSON.stringify(index))).toBeGreaterThan(LARGE_INDEX_BYTES);
      const storeRoot = join(await roots.create("docsfab-large-index-whole-"), "store");

      const fixture = await admitEditorialEvidence(storeRoot, index);
      const sizes = await objectSizes(storeRoot);
      expect(Math.max(...sizes.map(({ bytes }) => bytes))).toBeGreaterThan(LARGE_INDEX_BYTES);

      const { record, finalReference } = await completeNoChangeDecision(fixture, "large-whole");
      await expect(
        replayNoChangeDecision({ storeRoot, record, finalReference, sources: fixture.sources }),
      ).resolves.toEqual({ phase: "validated", candidate: "no-change" });
    },
    CASE_TIMEOUT,
  );

  it(
    "stores the index in parts no larger than a lowered bound and replays it",
    async () => {
      process.env[OVERRIDE] = String(LOWERED_BOUND);
      const index = contentIndexOfAtLeast(LARGE_INDEX_BYTES);
      const storeRoot = join(await roots.create("docsfab-large-index-parts-"), "store");

      const fixture = await admitEditorialEvidence(storeRoot, index);
      const sizes = await objectSizes(storeRoot);
      expect(Math.max(...sizes.map(({ bytes }) => bytes))).toBeLessThanOrEqual(LOWERED_BOUND);
      const parts = await partObjects(storeRoot);
      expect(parts.length).toBeGreaterThanOrEqual(Math.ceil(LARGE_INDEX_BYTES / LOWERED_BOUND));

      const { record, finalReference } = await completeNoChangeDecision(fixture, "large-parts");
      await expect(
        replayNoChangeDecision({ storeRoot, record, finalReference, sources: fixture.sources }),
      ).resolves.toEqual({ phase: "validated", candidate: "no-change" });
    },
    CASE_TIMEOUT,
  );

  it(
    "fails closed when one stored index part is substituted",
    async () => {
      process.env[OVERRIDE] = String(LOWERED_BOUND);
      const index = contentIndexOfAtLeast(LARGE_INDEX_BYTES);
      const storeRoot = join(await roots.create("docsfab-large-index-tamper-"), "store");
      const fixture = await admitEditorialEvidence(storeRoot, index);
      const { record, finalReference } = await completeNoChangeDecision(fixture, "large-tamper");

      const [part] = await partObjects(storeRoot);
      const value = JSON.parse(await readFile(part!, "utf8")) as {
        nodes: { anchors: string[] }[];
      };
      const withAnchors = value.nodes.find((node) => node.anchors.length > 0)!;
      withAnchors.anchors[0] = "substituted-anchor";
      await writeFile(part!, sortedJson(value), { mode: 0o600 });

      await expect(
        replayNoChangeDecision({ storeRoot, record, finalReference, sources: fixture.sources }),
      ).rejects.toMatchObject({ code: "identity-mismatch" });
    },
    CASE_TIMEOUT,
  );

  it(
    "admits the same index into one store again under another bound by reusing its verified parts",
    async () => {
      // Two local runs at one revision share a store. Under a 128 KiB bound and
      // then a 256 KiB bound the 1 MiB index splits differently; the second run
      // reuses the first, verified split instead of colliding with its manifest.
      const index = contentIndexOfAtLeast(1024 * 1024);
      const storeRoot = join(await roots.create("docsfab-large-index-rebound-"), "store");
      process.env[OVERRIDE] = String(128 * 1024);
      await admitEditorialEvidence(storeRoot, index);
      const firstObjects = (await objectSizes(storeRoot)).map(({ path }) => path).sort();
      const firstParts = await partObjects(storeRoot);
      expect(firstParts.length).toBeGreaterThan(1);

      process.env[OVERRIDE] = String(256 * 1024);
      const second = await admitEditorialEvidence(storeRoot, index);
      expect((await objectSizes(storeRoot)).map(({ path }) => path).sort()).toEqual(firstObjects);
      const { record, finalReference } = await completeNoChangeDecision(second, "rebound");
      await expect(
        replayNoChangeDecision({ storeRoot, record, finalReference, sources: second.sources }),
      ).resolves.toEqual({ phase: "validated", candidate: "no-change" });

      // Under a bound below the stored parts, the store refuses by its own code
      // and names the part's size; it never writes a second, conflicting split.
      process.env[OVERRIDE] = String(64 * 1024);
      const lowered = await admitEditorialEvidence(storeRoot, index).catch(
        (error: unknown) => error,
      );
      expect(lowered).toMatchObject({
        code: "artifacts-max-object-bytes-bound",
        configured: 64 * 1024,
      });
      expect((lowered as { observed: number }).observed).toBeGreaterThan(64 * 1024);
      expect(await partObjects(storeRoot)).toEqual(firstParts);
    },
    CASE_TIMEOUT,
  );

  it(
    "refuses a whole stored index whose digest differs from the one the run bound",
    async () => {
      const index = contentIndexOfAtLeast(16 * 1024);
      const storeRoot = join(await roots.create("docsfab-large-index-whole-digest-"), "store");
      const fixture = await admitEditorialEvidence(storeRoot, index);
      const { record, finalReference } = await completeNoChangeDecision(fixture, "whole-digest");

      // A different valid index of the same repository, stored where the bound
      // index belongs: only the digest check can tell the two apart.
      const other = contentIndexOfAtLeast(64 * 1024);
      expect(other.indexDigest).not.toBe(index.indexDigest);
      const locator = canonicalDigest({
        schemaVersion: 1,
        kind: "docsfab-content-index-locator",
        digest: index.indexDigest,
      });
      await writeFile(join(storeRoot, "objects", "sha256", `${locator}.json`), sortedJson(other), {
        mode: 0o600,
      });
      await expect(
        replayNoChangeDecision({ storeRoot, record, finalReference, sources: fixture.sources }),
      ).rejects.toMatchObject({ code: "identity-mismatch" });
    },
    CASE_TIMEOUT,
  );
});

async function objectSizes(storeRoot: string): Promise<{ path: string; bytes: number }[]> {
  const directory = join(storeRoot, "objects", "sha256");
  return Promise.all(
    (await readdir(directory)).map(async (name) => {
      const path = join(directory, name);
      return { path, bytes: (await stat(path)).size };
    }),
  );
}

async function partObjects(storeRoot: string): Promise<string[]> {
  const parts: string[] = [];
  for (const { path } of await objectSizes(storeRoot)) {
    const value = JSON.parse(await readFile(path, "utf8")) as { kind?: unknown };
    if (value.kind === PART_KIND) parts.push(path);
  }
  return parts.sort();
}

/** Sorted-key JSON, the form the store keeps for opaque records. */
function sortedJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
  );
}
