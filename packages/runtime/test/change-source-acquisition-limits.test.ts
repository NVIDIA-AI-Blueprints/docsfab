// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The bound a change-source refusal quotes is the one its extraction ran
 * under. An embedding host can narrow the extraction limits below the
 * catalog's through the acquisition seams; the refusal must then name that
 * narrowed value, not the catalog or host value it never ran under.
 */
import { createHash } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  resolveCliChangeSource,
  resolveCliChangeSourceEvidence,
} from "../src/cli/run/source-acquisition.js";
import { limit, limitDefinition, OperationalLimitError } from "../src/config/limits.js";
import {
  SOURCE_EXTRACTION_MAX_DERIVATIVE_BYTES_LIMIT,
  SOURCE_EXTRACTION_MAX_SPANS_LIMIT,
} from "../src/config/source-read-limits.js";
import { openExternalInputAccessCapture } from "../src/inputs/access.js";
import { parseChangeSourceSelector } from "../src/inputs/change-source.js";
import { acquireChangeSourceObservations } from "../src/inputs/change-source/acquisition.js";
import {
  changeSourceLimits,
  resolveLocalChangeSource,
  type ResolvedLocalChangeSourceV1,
} from "../src/inputs/change-source/local.js";
import {
  sourceExtractionLimits,
  type SourceExtractionLimitsV1,
} from "../src/inputs/source-extraction.js";
import { prepareRepositoryWorkspace } from "../src/repository/workspace/materialize.js";
import { temporaryRoots } from "./helpers/temp.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";
import { commitFiles, fixtureGit, initChangeRepository } from "./support/change-source-fixture.js";

const roots = temporaryRoots();

// Restores any override the operator or CI already set, not just deletes ours.
afterEach(() => {
  vi.unstubAllEnvs();
});

/** One line per letter: an edit near each end is two hunks under git's default context. */
const LETTERS = "abcdefghijklmnopqrstuvwxyz".split("");
const lettersWith = (edits: Readonly<Record<string, string>>) =>
  `${LETTERS.map((letter) => edits[letter] ?? letter).join("\n")}\n`;
/** Long lines rewritten whole: one hunk that makes the diff outweigh the manifest. */
const longLines = (transform: (text: string) => string) =>
  `${LETTERS.map((letter) => transform(`${letter} ${LETTERS.join(" ")}`)).join("\n")}\n`;

/** A range of several files, two of them with two hunks, so coalescing has work to do. */
async function multiFileRange() {
  const { repository } = await initChangeRepository(
    await roots.create("docsfab-change-source-limits-"),
    {
      "docs/alpha.md": lettersWith({}),
      "docs/beta.md": lettersWith({}),
      "docs/gamma.md": lettersWith({}),
      "docs/delta.md": longLines((text) => text),
    },
  );
  await commitFiles(
    repository,
    {
      "docs/alpha.md": lettersWith({ b: "B", y: "Y" }),
      "docs/beta.md": lettersWith({ c: "C", x: "X" }),
      "docs/gamma.md": lettersWith({ m: "M" }),
      "docs/delta.md": longLines((text) => text.toUpperCase()),
      "src/added.ts": "export const added = true;\n",
    },
    "edit three pages and add a module",
  );
  const resolved = await resolveLocalChangeSource({
    sourcePath: repository,
    selector: parseChangeSourceSelector("HEAD~1..HEAD"),
    workspaceRevision: await fixtureGit(repository, ["rev-parse", "HEAD"]),
  });
  return { repository, resolved };
}

const digest = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** The acquisition seam itself, under the limits an embedding host passes. */
function acquire(resolved: ResolvedLocalChangeSourceV1, limits: SourceExtractionLimitsV1) {
  const runIdSha256 = digest("change-source-acquisition-limits");
  const repository = {
    identitySha256: resolved.changeSource.revision.repository.identitySha256,
    revision: resolved.changeSource.revision.head,
  };
  return acquireChangeSourceObservations({
    resolved,
    externalInputs: openExternalInputAccessCapture({ runIdSha256, repository }),
    readScope: ["."],
    runIdSha256,
    repository,
    requestSha256: digest("request"),
    observedAt: "2026-01-01T00:00:00.000Z",
    limits,
  });
}

async function refusalOf(promise: Promise<unknown>): Promise<OperationalLimitError> {
  const caught = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(caught).toBeInstanceOf(OperationalLimitError);
  return caught as OperationalLimitError;
}

function diffEntry(acquired: Awaited<ReturnType<typeof acquire>>) {
  return acquired.acquired.find((entry) => entry.role === "diff")!;
}

function diffParts(acquired: Awaited<ReturnType<typeof acquire>>): string[] {
  return diffEntry(acquired).representation.spans.map((span) =>
    span.locator.kind === "diff" ? span.locator.part : span.locator.kind,
  );
}

describe("change-source refusal quotes the extraction limit in force", () => {
  it(
    "refuses a narrowed span ceiling with the narrowed value, at the coalesced minimum and one under",
    async () => {
      const { resolved } = await multiFileRange();
      const defaults = sourceExtractionLimits();
      const spans = (maxSpans: number) => ({ ...defaults, maxSpans });

      // The fewest spans the diff can take: every coalescible file read whole.
      const floor = limitDefinition(SOURCE_EXTRACTION_MAX_SPANS_LIMIT).min!;
      const minimum = (await refusalOf(acquire(resolved, spans(floor)))).observed;
      const perHunk = diffEntry(await acquire(resolved, defaults)).representation.spans.length;
      expect(floor).toBeLessThan(minimum - 1);
      expect(minimum).toBeLessThan(perHunk - 1);

      // At the minimum: admitted, every file whole.
      const atMinimum = await acquire(resolved, spans(minimum));
      expect(diffParts(atMinimum).filter((part) => part === "hunk")).toEqual([]);

      // One per-hunk span short still admits: the adapter reads a file whole
      // rather than drop a hunk, so the per-hunk count is not the refusal's.
      const coalesced = await acquire(resolved, spans(perHunk - 1));
      expect(diffParts(coalesced)).toContain("file");
      expect(diffParts(coalesced)).toContain("hunk");

      // One under the minimum: refused, quoting the bound it ran under.
      const narrowed = minimum - 1;
      expect(narrowed).toBeLessThan(limit(SOURCE_EXTRACTION_MAX_SPANS_LIMIT).value);
      const error = await refusalOf(acquire(resolved, spans(narrowed)));
      expect(error).toMatchObject({
        code: "sources-extraction-max-spans-bound",
        limitName: SOURCE_EXTRACTION_MAX_SPANS_LIMIT,
        configured: narrowed,
        observed: minimum,
      });
      expect(error.message).toContain(
        `${minimum} exceeds ${SOURCE_EXTRACTION_MAX_SPANS_LIMIT} = ${narrowed} count.`,
      );
    },
    testTimeoutMs(60_000),
  );

  it(
    "refuses a narrowed derivative ceiling with the narrowed value, on the diff original",
    async () => {
      const { resolved } = await multiFileRange();
      const defaults = sourceExtractionLimits();
      const admitted = await acquire(resolved, defaults);
      const derivative = diffEntry(admitted).representation.byteLength;
      const manifest = admitted.acquired.find((entry) => entry.role === "manifest")!;
      // The manifest fits under a bound one byte below the diff's derivative,
      // so only the diff, which extracts first, can refuse it.
      expect(manifest.representation.byteLength).toBeLessThan(derivative - 1);

      await expect(
        acquire(resolved, { ...defaults, maxDerivativeBytes: derivative }),
      ).resolves.toBeDefined();
      const narrowed = derivative - 1;
      expect(narrowed).toBeLessThan(limit(SOURCE_EXTRACTION_MAX_DERIVATIVE_BYTES_LIMIT).value);
      const error = await refusalOf(
        acquire(resolved, { ...defaults, maxDerivativeBytes: narrowed }),
      );
      expect(error).toMatchObject({
        code: "sources-extraction-max-derivative-bytes-bound",
        limitName: SOURCE_EXTRACTION_MAX_DERIVATIVE_BYTES_LIMIT,
        configured: narrowed,
        observed: derivative,
      });
    },
    testTimeoutMs(60_000),
  );

  it(
    "quotes an embedding bound above a host override, not the override",
    async () => {
      const { resolved } = await multiFileRange();
      const defaults = sourceExtractionLimits();
      const derivative = diffEntry(await acquire(resolved, defaults)).representation.byteLength;
      const variable = limitDefinition(SOURCE_EXTRACTION_MAX_DERIVATIVE_BYTES_LIMIT).override!;
      const hostValue = derivative - 2;
      vi.stubEnv(variable, String(hostValue));
      expect(limit(SOURCE_EXTRACTION_MAX_DERIVATIVE_BYTES_LIMIT).value).toBe(hostValue);
      const error = await refusalOf(
        acquire(resolved, { ...defaults, maxDerivativeBytes: derivative - 1 }),
      );
      expect(error).toMatchObject({ configured: derivative - 1, observed: derivative });
    },
    testTimeoutMs(60_000),
  );

  it(
    "refuses at resolve a diff inside the raw-byte relation whose extracted form crosses the derivative bound",
    async () => {
      const { repository, resolved: probe } = await multiFileRange();
      const raw = probe.diffBytes.byteLength;
      const derivative = diffEntry(await acquire(probe, sourceExtractionLimits())).representation
        .byteLength;
      // The extracted diff carries a manifest, so it outweighs the raw bytes.
      expect(derivative).toBeGreaterThan(raw);
      const overrides = {
        [limitDefinition("changeSources.diffMaxBytes").override!]: raw,
        [limitDefinition("changeSources.fileDiffMaxBytes").override!]: raw,
        [limitDefinition(SOURCE_EXTRACTION_MAX_DERIVATIVE_BYTES_LIMIT).override!]: raw,
      };
      for (const [variable, value] of Object.entries(overrides))
        vi.stubEnv(variable, String(value));
      // The raw-byte relation holds at equality, so only extraction can refuse.
      expect(() => changeSourceLimits()).not.toThrow();
      const error = await refusalOf(
        resolveLocalChangeSource({
          sourcePath: repository,
          selector: parseChangeSourceSelector("HEAD~1..HEAD"),
          workspaceRevision: await fixtureGit(repository, ["rev-parse", "HEAD"]),
        }),
      );
      expect(error).toMatchObject({
        code: "sources-extraction-max-derivative-bytes-bound",
        configured: raw,
        observed: derivative,
      });
    },
    testTimeoutMs(60_000),
  );

  it(
    "refuses through the CLI evidence seam with the embedding host's narrowed span ceiling",
    async () => {
      const { repository, resolved: probe } = await multiFileRange();
      const floor = limitDefinition(SOURCE_EXTRACTION_MAX_SPANS_LIMIT).min!;
      const minimum = (
        await refusalOf(acquire(probe, { ...sourceExtractionLimits(), maxSpans: floor }))
      ).observed;
      const workspace = await prepareRepositoryWorkspace(repository, "HEAD");
      try {
        const resolved = await resolveCliChangeSource({
          workspace,
          selector: parseChangeSourceSelector("HEAD~1..HEAD"),
        });
        const evidence = (maxSpans: number) =>
          resolveCliChangeSourceEvidence({
            workspace,
            resolved,
            admittedRequest: { workflow: "create-documentation", allowWrite: true },
            runId: "change-source-acquisition-limits",
            limits: { maxSpans },
          });
        const admitted = await evidence(minimum);
        expect(admitted.acquired.acquired.map((entry) => entry.role)).toEqual(["diff", "manifest"]);
        const error = await refusalOf(evidence(minimum - 1));
        expect(error).toMatchObject({
          code: "sources-extraction-max-spans-bound",
          configured: minimum - 1,
          observed: minimum,
        });
      } finally {
        await workspace.dispose();
      }
    },
    testTimeoutMs(60_000),
  );
});
