// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The release-range kind at its resolver: `release:<base>..<head>` grammar,
 * first-parent unit enumeration, per-unit records and omissions, tag
 * integrity, bounds and paging, all against local fixture repositories. Unit
 * expectations are the ids the fixture created, in creation order.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  resolveCliChangeSource,
  resolveCliChangeSourceEvidence,
  sourceReadBudgetForModel,
} from "../src/cli/run/source-acquisition.js";
import { OperationalLimitError } from "../src/config/limits.js";
import {
  ChangeSourceError,
  parseChangeSourceSelector,
  type LocalRangeSelectorV1,
} from "../src/inputs/change-source.js";
import { resolveLocalChangeSource } from "../src/inputs/change-source/local.js";
import {
  releaseRangeSelectorArm,
  type ReleaseRangeSelectorV1,
} from "../src/inputs/change-source/release-member.js";
import {
  decodeReleaseUnitsIndexV1,
  isResolvedReleaseRange,
  releaseRangeStatusLines,
  releaseUnitsRepositoryPath,
  resolveReleaseRangeChangeSource,
  type ResolvedReleaseRangeV1,
} from "../src/inputs/change-source/release.js";
import { DIFF_SOURCE_MEDIA_TYPE, diffSourceExtractorAdapter } from "../src/inputs/adapters/diff.js";
import {
  CHANGE_SOURCE_MANIFEST_MEDIA_TYPE,
  changeSourceManifestExtractorAdapter,
} from "../src/inputs/change-source/acquisition.js";
import { planRequiredSourceReads } from "../src/inputs/source-evidence-artifacts.js";
import {
  extractSourceRepresentation,
  SourceExtractionError,
} from "../src/inputs/source-extraction.js";
import type { SourceReadBudgetV1 } from "../src/inputs/source-step-policy.js";
import { prepareRepositoryWorkspace } from "../src/repository/workspace/materialize.js";
import {
  appendMergeUnits,
  commitFiles,
  fixtureGit,
  initChangeRepository,
  rewriteLooseObject,
} from "./support/change-source-fixture.js";
import { configureCredential } from "./helpers/configured-credential.js";
import { temporaryRoots } from "./helpers/temp.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";

const roots = temporaryRoots();
const restore: Array<readonly [string, string | undefined]> = [];

/** Set a host override for this test only. */
function override(variable: string, value: number): void {
  restore.push([variable, process.env[variable]]);
  process.env[variable] = String(value);
}

afterEach(() => {
  for (const [variable, value] of restore.splice(0).reverse()) {
    if (value === undefined) delete process.env[variable];
    else process.env[variable] = value;
  }
});

async function caught(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("expected a refusal, but the call resolved");
}

async function expectCode(run: () => Promise<unknown>, code: string, detail?: string) {
  const error = await caught(run);
  expect(error).toBeInstanceOf(ChangeSourceError);
  expect((error as ChangeSourceError).code).toBe(code);
  if (detail !== undefined) expect((error as ChangeSourceError).detail).toBe(detail);
  return error as ChangeSourceError;
}

/** A source file of `lines` numbered lines, so each unit's diff has a known shape. */
function body(name: string, lines: number): string {
  return Array.from({ length: lines }, (_, index) => `${name} line ${index + 1}\n`).join("");
}

/**
 * main: root (tag v1.0) -> plain -> merge of feature (two commits) -> octopus
 * of left and right -> empty (tag v1.1). The units of v1.0..v1.1 are the last
 * four, in that order.
 */
async function releaseFixture() {
  const { repository } = await initChangeRepository(await roots.create("docsfab-release-"));
  const rev = (name: string) => fixtureGit(repository, ["rev-parse", name]);
  const root = await rev("HEAD");
  await fixtureGit(repository, ["tag", "-a", "v1.0", "-m", "release v1.0"]);
  const plain = await commitFiles(repository, { "docs/guide.md": "guide\n" }, "docs: add guide");
  await fixtureGit(repository, ["checkout", "-q", "-b", "feature"]);
  const featureOne = await commitFiles(
    repository,
    { "src/one.ts": body("one", 40) },
    "feature: one",
  );
  const featureTwo = await commitFiles(
    repository,
    { "src/two.ts": body("two", 40) },
    "feature: two",
  );
  await fixtureGit(repository, ["checkout", "-q", "main"]);
  await fixtureGit(repository, [
    "merge",
    "-q",
    "--no-ff",
    "-m",
    "Merge branch 'feature'",
    "feature",
  ]);
  const merge = await rev("HEAD");
  await fixtureGit(repository, ["checkout", "-q", "-b", "left", merge]);
  const left = await commitFiles(repository, { "left.md": "left\n" }, "left");
  await fixtureGit(repository, ["checkout", "-q", "-b", "right", merge]);
  const right = await commitFiles(repository, { "right.md": "right\n" }, "right");
  await fixtureGit(repository, ["checkout", "-q", "main"]);
  await fixtureGit(repository, [
    "merge",
    "-q",
    "--no-ff",
    "-m",
    "Merge left and right",
    "left",
    "right",
  ]);
  const octopus = await rev("HEAD");
  const empty = await commitFiles(repository, {}, "release: mark v1.1", { allowEmpty: true });
  await fixtureGit(repository, ["tag", "-a", "v1.1", "-m", "release v1.1"]);
  return {
    repository,
    root,
    plain,
    featureOne,
    featureTwo,
    merge,
    left,
    right,
    octopus,
    empty,
    baseTag: await rev("v1.0"),
    headTag: await rev("v1.1"),
  };
}

function resolveRelease(
  repository: string,
  value: string,
  extra: {
    readonly besideObservations?: number;
    readonly observeGit?: (args: readonly string[]) => void;
    readonly readBudget?: SourceReadBudgetV1;
  } = {},
): Promise<ResolvedReleaseRangeV1> {
  return resolveReleaseRangeChangeSource({
    sourcePath: repository,
    selector: parseChangeSourceSelector(value) as ReleaseRangeSelectorV1,
    workspaceRevision: "HEAD",
    readBudget: CEILING_BUDGET,
    ...extra,
  });
}

/** The budget a run with no attested model window gets: the declared ceiling. */
const CEILING_BUDGET = sourceReadBudgetForModel(undefined);

/** A ceiling-basis budget of exactly `bytes`. */
function budgetOf(bytes: number): SourceReadBudgetV1 {
  return { budgetBytes: bytes, basis: { kind: "ceiling" } };
}

describe("release-range: units of release:<base>..<head> (row 1)", () => {
  it(
    "lists every first-parent unit with its shape, its introduced commits and its sealed record",
    async () => {
      const fixture = await releaseFixture();
      const result = await resolveRelease(fixture.repository, "release:v1.0..v1.1");
      const { index } = result;
      expect(
        index.units.map((unit) => [unit.position, unit.id, unit.kind, unit.parents, unit.subject]),
      ).toEqual([
        [1, fixture.plain, "plain", [fixture.root], "docs: add guide"],
        [2, fixture.merge, "merge", [fixture.plain, fixture.featureTwo], "Merge branch 'feature'"],
        [
          3,
          fixture.octopus,
          "octopus",
          [fixture.merge, fixture.left, fixture.right],
          "Merge left and right",
        ],
        [4, fixture.empty, "empty", [fixture.octopus], "release: mark v1.1"],
      ]);
      expect(index.units[0]!.introduced).toEqual({ state: "listed", commits: [] });
      expect(index.units[1]!.introduced).toEqual({
        state: "listed",
        commits: [
          { id: fixture.featureOne, subject: "feature: one" },
          { id: fixture.featureTwo, subject: "feature: two" },
        ],
      });
      const octopusIntroduced = index.units[2]!.introduced;
      expect(octopusIntroduced.state).toBe("listed");
      expect(
        octopusIntroduced.state === "listed"
          ? [...octopusIntroduced.commits].sort((a, b) => a.id.localeCompare(b.id))
          : [],
      ).toEqual(
        [
          { id: fixture.left, subject: "left" },
          { id: fixture.right, subject: "right" },
        ].sort((a, b) => a.id.localeCompare(b.id)),
      );
      expect(index.units.map((unit) => [unit.link, unit.linkReason])).toEqual(
        Array(4).fill([null, "forge-identity-unavailable"]),
      );

      // Each unit is one change-source record of the release kind, read
      // against its first parent; the index names it by digest.
      expect(result.units.map((unit) => unit.changeSource.revision.head)).toEqual([
        fixture.plain,
        fixture.merge,
        fixture.octopus,
        fixture.empty,
      ]);
      expect(result.units.map((unit) => unit.changeSource.diffFrom)).toEqual([
        fixture.root,
        fixture.plain,
        fixture.merge,
        fixture.octopus,
      ]);
      for (const unit of result.units) {
        expect(unit.changeSource.source).toEqual({ kind: "release-range" });
        expect(unit.changeSource.rangeSemantics).toBe("first-parent-commit");
      }
      expect(index.units.map((unit) => unit.evidence)).toEqual(
        result.units.map((unit) => ({
          state: "bound",
          changeSourceSha256: unit.changeSource.changeSourceSha256,
        })),
      );
      expect(result.units[1]!.changeSource.files.map((file) => file.newPath)).toEqual([
        "src/one.ts",
        "src/two.ts",
      ]);
      expect(result.units[3]!.changeSource.files).toEqual([]);

      expect(index.revision).toMatchObject({ base: fixture.root, head: fixture.empty });
      expect(index.tags).toEqual({ base: fixture.baseTag, head: fixture.headTag });
      expect(index.labels).toEqual([]);
      expect(index.page).toEqual({
        unitsPerRun: 126,
        readBudgetBytes: CEILING_BUDGET.budgetBytes,
        bound: 4,
        remaining: 0,
        continuation: null,
      });
      const decoded = decodeReleaseUnitsIndexV1(
        JSON.parse(new TextDecoder().decode(result.indexBytes)),
      );
      expect(decoded).toEqual(index);
    },
    testTimeoutMs(60_000),
  );

  it(
    "names the same units from branch and commit names, with no tag objects",
    async () => {
      const fixture = await releaseFixture();
      const result = await resolveRelease(fixture.repository, `release:${fixture.root}..main`);
      expect(result.index.units.map((unit) => unit.id)).toEqual([
        fixture.plain,
        fixture.merge,
        fixture.octopus,
        fixture.empty,
      ]);
      expect(result.index.tags).toEqual({ base: null, head: null });
    },
    testTimeoutMs(60_000),
  );
});

describe("release-range: grammar (row 2)", () => {
  it("parses release:<base>..<head> and reserves the rest of the namespace", async () => {
    expect(parseChangeSourceSelector("release:v1.0..v1.1")).toEqual({
      schemaVersion: 1,
      kind: "docsfab-change-source-selector",
      source: "release-range",
      form: "range",
      base: "v1.0",
      head: "v1.1",
    });
    const parse = (value: string) => async () => parseChangeSourceSelector(value);
    await expectCode(
      parse("release:since-last"),
      "change-source-release-form-unsupported",
      "release:since-last",
    );
    await expectCode(
      parse("release:since-last..v1.1"),
      "change-source-release-form-unsupported",
      "release:since-last",
    );
    await expectCode(
      parse("release:dates:2026-09-01..2026-10-01:Europe/Berlin@main"),
      "change-source-release-form-unsupported",
      "release:dates:",
    );
    for (const value of ["release:v1.1", "release:", "release:since-lastly"]) {
      const error = await expectCode(parse(value), "change-source-release-form-unsupported");
      expect(error.detail).toBeUndefined();
    }
    await expectCode(parse("release:..v1.1"), "change-source-selector-grammar");
    await expectCode(parse("release:v1.0...v1.1"), "change-source-selector-grammar");
    // A URL or a merge request reference is never claimed by the namespace:
    // the arm declines it, and whichever kind owns it refuses it.
    const arm = releaseRangeSelectorArm(
      () => {
        throw new Error("the release arm refused a value it must decline");
      },
      (value) => value,
    );
    for (const value of ["release://example.test/v1.0..v1.1", "release:v1.0..v1.1!2"]) {
      expect(arm(value), value).toBeUndefined();
      const error = await caught(parse(value));
      expect((error as { code?: string }).code, value).not.toMatch(/^change-source-release-/u);
    }
    expect(arm("release:v1.0..v1.1")).toMatchObject({ source: "release-range" });
    // Outside the namespace a tag range stays a local range.
    expect(parseChangeSourceSelector("v1.0..v1.1")).toMatchObject({
      source: "local-range",
      form: "two-dot",
    });
  });

  it(
    "reads calendar-versioned tags as refs, never as dates",
    async () => {
      const fixture = await releaseFixture();
      await fixtureGit(fixture.repository, ["tag", "2026.09", fixture.root]);
      await fixtureGit(fixture.repository, ["tag", "2026-09-01", fixture.empty]);
      const result = await resolveRelease(fixture.repository, "release:2026.09..2026-09-01");
      expect(result.index.units.map((unit) => unit.id)).toEqual([
        fixture.plain,
        fixture.merge,
        fixture.octopus,
        fixture.empty,
      ]);
    },
    testTimeoutMs(60_000),
  );

  it(
    "refuses a plain tag range at the changed-file bound that the release form admits unit by unit",
    async () => {
      const fixture = await releaseFixture();
      override("DOCSFAB_CHANGE_SOURCES_CHANGED_FILES_MAX", 2);
      const local = await caught(() =>
        resolveLocalChangeSource({
          sourcePath: fixture.repository,
          selector: parseChangeSourceSelector("v1.0..v1.1") as LocalRangeSelectorV1,
          workspaceRevision: "HEAD",
        }),
      );
      expect(local).toBeInstanceOf(OperationalLimitError);
      expect(local).toMatchObject({ limitName: "changeSources.changedFilesMax", observed: 5 });
      const release = await resolveRelease(fixture.repository, "release:v1.0..v1.1");
      expect(release.index.units.map((unit) => unit.evidence.state)).toEqual(
        Array(4).fill("bound"),
      );
    },
    testTimeoutMs(60_000),
  );
});

describe("release-range: base on and off head's first-parent line (row 3)", () => {
  it(
    "labels only a base off the line, whose walk can repeat already-released changes",
    async () => {
      const fixture = await releaseFixture();
      const onLine = await resolveRelease(fixture.repository, `release:${fixture.plain}..v1.1`);
      expect(onLine.index.units.map((unit) => unit.id)).toEqual([
        fixture.merge,
        fixture.octopus,
        fixture.empty,
      ]);
      expect(onLine.index.labels).toEqual([]);

      // featureTwo was released through the merge, but is not on main's line.
      const offLine = await resolveRelease(
        fixture.repository,
        `release:${fixture.featureTwo}..v1.1`,
      );
      expect(offLine.index.units.map((unit) => unit.id)).toEqual([
        fixture.merge,
        fixture.octopus,
        fixture.empty,
      ]);
      expect(offLine.index.labels).toEqual(["base-off-first-parent-line"]);
      expect(offLine.index.units[0]!.introduced).toEqual({
        state: "listed",
        commits: [
          { id: fixture.featureOne, subject: "feature: one" },
          { id: fixture.featureTwo, subject: "feature: two" },
        ],
      });
      expect(releaseRangeStatusLines(offLine.index)).toContain(
        "release range label: base-off-first-parent-line",
      );
    },
    testTimeoutMs(60_000),
  );

  it(
    "lists a root unit when base shares no history with head",
    async () => {
      const fixture = await releaseFixture();
      await fixtureGit(fixture.repository, ["checkout", "-q", "--orphan", "other"]);
      const orphan = await commitFiles(
        fixture.repository,
        { "other.md": "other\n" },
        "orphan root",
      );
      await fixtureGit(fixture.repository, ["checkout", "-q", "main"]);
      const result = await resolveRelease(
        fixture.repository,
        `release:${orphan}..${fixture.plain}`,
      );
      expect(result.index.units.map((unit) => [unit.id, unit.kind])).toEqual([
        [fixture.root, "root"],
        [fixture.plain, "plain"],
      ]);
      expect(result.units[0]!.changeSource.diffFrom).toBeNull();
      expect(result.index.labels).toEqual(["base-off-first-parent-line"]);
    },
    testTimeoutMs(60_000),
  );

  it(
    "refuses a range whose head is base's ancestor, and base equal to head",
    async () => {
      const fixture = await releaseFixture();
      await expectCode(
        () => resolveRelease(fixture.repository, "release:v1.1..v1.0"),
        "change-source-release-no-units",
      );
      await expectCode(
        () => resolveRelease(fixture.repository, `release:v1.1..${fixture.empty}`),
        "change-source-empty-range",
      );
      await expectCode(
        () => resolveRelease(fixture.repository, "release:v1.0..no-such-tag"),
        "change-source-revision-unresolved",
      );
    },
    testTimeoutMs(60_000),
  );
});

describe("release-range: per-unit bounds become listed omissions (row 4)", () => {
  it(
    "binds a unit at the diff bound and omits it one byte over while the release continues",
    async () => {
      const fixture = await releaseFixture();
      const clean = await resolveRelease(fixture.repository, "release:v1.0..v1.1");
      const sizes = clean.units.map((unit) => unit.diffBytes.byteLength);
      const largest = sizes[1]!;
      // The merge unit is the largest, and the whole release is larger still.
      expect(Math.max(...sizes)).toBe(largest);
      expect(sizes.reduce((sum, size) => sum + size, 0)).toBeGreaterThan(largest);

      override("DOCSFAB_CHANGE_SOURCES_DIFF_MAX_BYTES", largest);
      override("DOCSFAB_CHANGE_SOURCES_FILE_DIFF_MAX_BYTES", largest);
      const atLimit = await resolveRelease(fixture.repository, "release:v1.0..v1.1");
      expect(atLimit.index.units.map((unit) => unit.evidence.state)).toEqual(
        Array(4).fill("bound"),
      );

      override("DOCSFAB_CHANGE_SOURCES_DIFF_MAX_BYTES", largest - 1);
      override("DOCSFAB_CHANGE_SOURCES_FILE_DIFF_MAX_BYTES", largest - 1);
      const over = await resolveRelease(fixture.repository, "release:v1.0..v1.1");
      expect(over.index.units.map((unit) => unit.evidence)).toEqual([
        { state: "bound", changeSourceSha256: clean.units[0]!.changeSource.changeSourceSha256 },
        {
          state: "omitted",
          code: "change-source-diff-bound",
          limitName: "changeSources.diffMaxBytes",
          observed: largest,
          limit: largest - 1,
        },
        { state: "bound", changeSourceSha256: clean.units[2]!.changeSource.changeSourceSha256 },
        { state: "bound", changeSourceSha256: clean.units[3]!.changeSource.changeSourceSha256 },
      ]);
      expect(over.units.map((unit) => unit.changeSource.revision.head)).toEqual([
        fixture.plain,
        fixture.octopus,
        fixture.empty,
      ]);
      expect(releaseRangeStatusLines(over.index)).toContain(
        `change-source-diff-bound: release unit 2 (${fixture.merge}) is ${largest}, over ` +
          `changeSources.diffMaxBytes = ${largest - 1}; it stays listed in the units index ` +
          "without its change record or diff",
      );
    },
    testTimeoutMs(60_000),
  );

  it(
    "binds units at the changed-file bound and omits the ones over it",
    async () => {
      const fixture = await releaseFixture();
      override("DOCSFAB_CHANGE_SOURCES_CHANGED_FILES_MAX", 2);
      const atLimit = await resolveRelease(fixture.repository, "release:v1.0..v1.1");
      expect(atLimit.index.units.map((unit) => unit.evidence.state)).toEqual(
        Array(4).fill("bound"),
      );
      override("DOCSFAB_CHANGE_SOURCES_CHANGED_FILES_MAX", 1);
      const over = await resolveRelease(fixture.repository, "release:v1.0..v1.1");
      expect(over.index.units.map((unit) => unit.evidence)).toEqual([
        expect.objectContaining({ state: "bound" }),
        {
          state: "omitted",
          code: "change-source-changed-files-bound",
          limitName: "changeSources.changedFilesMax",
          observed: 2,
          limit: 1,
        },
        {
          state: "omitted",
          code: "change-source-changed-files-bound",
          limitName: "changeSources.changedFilesMax",
          observed: 2,
          limit: 1,
        },
        expect.objectContaining({ state: "bound" }),
      ]);
    },
    testTimeoutMs(60_000),
  );

  it(
    "omits a unit whose diff extraction is over a span or derivative bound and binds the rest",
    async () => {
      const { repository } = await initChangeRepository(await roots.create("docsfab-release-"));
      await fixtureGit(repository, ["tag", "v0"]);
      const first = await commitFiles(repository, { "a.md": "a\n" }, "first");
      const wide: Record<string, string> = {};
      for (let index = 0; index < 30; index += 1) wide[`wide/f${index}.md`] = body(`f${index}`, 20);
      const widest = await commitFiles(repository, wide, "wide");
      const last = await commitFiles(repository, { "b.md": "b\n" }, "last");
      const clean = await resolveRelease(repository, "release:v0..HEAD");
      expect(clean.units.map((unit) => unit.changeSource.revision.head)).toEqual([
        first,
        widest,
        last,
      ]);

      // Each original's fewest spans (the extractor reads files whole once
      // per-hunk spans overflow) and its whole derivative size.
      const footprint = async (bytes: Uint8Array, role: "diff" | "manifest") => {
        const extracted = await extractSourceRepresentation({
          ...(role === "diff"
            ? { adapter: diffSourceExtractorAdapter, mediaType: DIFF_SOURCE_MEDIA_TYPE }
            : {
                adapter: changeSourceManifestExtractorAdapter,
                mediaType: CHANGE_SOURCE_MANIFEST_MEDIA_TYPE,
              }),
          bytes,
          limits: { maxSpans: 1 },
        });
        const whole = await extractSourceRepresentation({
          ...(role === "diff"
            ? { adapter: diffSourceExtractorAdapter, mediaType: DIFF_SOURCE_MEDIA_TYPE }
            : {
                adapter: changeSourceManifestExtractorAdapter,
                mediaType: CHANGE_SOURCE_MANIFEST_MEDIA_TYPE,
              }),
          bytes,
        });
        expect(whole.representation.completeness).toBe("complete");
        return {
          spans:
            extracted.representation.overflows?.find(
              (entry) => entry.limitName === "sources.extractionMaxSpans",
            )?.observed ?? extracted.representation.spans.length,
          derivativeBytes: whole.representation.byteLength,
        };
      };
      const units = await Promise.all(
        clean.units.map(async (unit) => ({
          diff: await footprint(unit.diffBytes, "diff"),
          manifest: await footprint(unit.manifestBytes, "manifest"),
        })),
      );
      const { spans, derivativeBytes } = units[1]!.diff;
      // Only the wide unit's diff is over each bound one below its own size.
      for (const [index, unit] of units.entries()) {
        expect(unit.manifest.spans).toBeLessThan(spans);
        expect(unit.manifest.derivativeBytes).toBeLessThan(derivativeBytes);
        if (index === 1) continue;
        expect(unit.diff.spans).toBeLessThan(spans);
        expect(unit.diff.derivativeBytes).toBeLessThan(derivativeBytes);
      }
      const bound = (index: number) => ({
        state: "bound",
        changeSourceSha256: clean.units[index]!.changeSource.changeSourceSha256,
      });

      override("DOCSFAB_SOURCES_EXTRACTION_MAX_SPANS", spans);
      const spansAtLimit = await resolveRelease(repository, "release:v0..HEAD");
      expect(spansAtLimit.index.units.map((unit) => unit.evidence.state)).toEqual(
        Array(3).fill("bound"),
      );
      override("DOCSFAB_SOURCES_EXTRACTION_MAX_SPANS", spans - 1);
      const spansOver = await resolveRelease(repository, "release:v0..HEAD");
      expect(spansOver.index.units.map((unit) => unit.evidence)).toEqual([
        bound(0),
        {
          state: "omitted",
          code: "sources-extraction-max-spans-bound",
          limitName: "sources.extractionMaxSpans",
          observed: spans,
          limit: spans - 1,
        },
        bound(2),
      ]);
      expect(spansOver.units.map((unit) => unit.changeSource.revision.head)).toEqual([first, last]);
      expect(
        decodeReleaseUnitsIndexV1(JSON.parse(new TextDecoder().decode(spansOver.indexBytes))),
      ).toEqual(spansOver.index);
      expect(releaseRangeStatusLines(spansOver.index)).toContain(
        `sources-extraction-max-spans-bound: release unit 2 (${widest}) is ${spans}, over ` +
          `sources.extractionMaxSpans = ${spans - 1}; it stays listed in the units index ` +
          "without its change record or diff",
      );
      delete process.env.DOCSFAB_SOURCES_EXTRACTION_MAX_SPANS;

      // The change-source byte bounds may not exceed the derivative bound, so
      // they move with it; the wide unit's diff stays under them.
      expect(clean.units[1]!.diffBytes.byteLength).toBeLessThan(derivativeBytes - 1);
      for (const value of [derivativeBytes, derivativeBytes - 1]) {
        override("DOCSFAB_SOURCES_EXTRACTION_MAX_DERIVATIVE_BYTES", value);
        override("DOCSFAB_CHANGE_SOURCES_DIFF_MAX_BYTES", value);
        override("DOCSFAB_CHANGE_SOURCES_FILE_DIFF_MAX_BYTES", value);
        const resolved = await resolveRelease(repository, "release:v0..HEAD");
        expect(resolved.index.units.map((unit) => unit.evidence)).toEqual([
          bound(0),
          value === derivativeBytes
            ? bound(1)
            : {
                state: "omitted",
                code: "sources-extraction-max-derivative-bytes-bound",
                limitName: "sources.extractionMaxDerivativeBytes",
                observed: derivativeBytes,
                limit: derivativeBytes - 1,
              },
          bound(2),
        ]);
      }
    },
    testTimeoutMs(60_000),
  );

  it(
    "refuses the whole release for a unit record over the original byte bound, which is not omittable",
    async () => {
      const fixture = await releaseFixture();
      const clean = await resolveRelease(fixture.repository, "release:v1.0..v1.1");
      const manifest = Math.max(...clean.units.map((unit) => unit.manifestBytes.byteLength));
      // The change-source byte bounds may not exceed the original bound, so
      // they move under it; every unit's diff stays within them.
      expect(Math.max(...clean.units.map((unit) => unit.diffBytes.byteLength))).toBeLessThan(
        manifest - 1,
      );
      expect(clean.indexBytes.byteLength).not.toBe(manifest);
      override("DOCSFAB_CHANGE_SOURCES_DIFF_MAX_BYTES", manifest - 1);
      override("DOCSFAB_CHANGE_SOURCES_FILE_DIFF_MAX_BYTES", manifest - 1);
      // Adjacent: the lowered diff bounds alone bind every unit.
      expect(
        (await resolveRelease(fixture.repository, "release:v1.0..v1.1")).index.units.map(
          (unit) => unit.evidence.state,
        ),
      ).toEqual(clean.index.units.map((unit) => unit.evidence.state));
      override("DOCSFAB_SOURCES_EXTRACTION_MAX_ORIGINAL_BYTES", manifest - 1);
      const error = await caught(() => resolveRelease(fixture.repository, "release:v1.0..v1.1"));
      expect(error).toBeInstanceOf(SourceExtractionError);
      expect((error as SourceExtractionError).code).toBe("original-budget-exceeded");
      // A unit's own record, not the index: the refusal came from inside the unit.
      expect((error as SourceExtractionError).limitRefusal).toContain(
        `sources-extraction-max-original-bytes-bound: ${manifest} exceeds ` +
          `sources.extractionMaxOriginalBytes = ${manifest - 1} bytes`,
      );
    },
    testTimeoutMs(60_000),
  );

  it(
    "refuses the whole release for a configured credential or a tampered object inside one unit",
    async () => {
      const { repository } = await initChangeRepository(await roots.create("docsfab-release-"));
      await fixtureGit(repository, ["tag", "v0"]);
      await commitFiles(repository, { "a.md": "a\n" }, "first");
      const token = configureCredential(["glpat", "Rq3Ws8Ed1Fv6Tg4Yh9Uj2Ik7"].join("-"));
      await commitFiles(repository, { "leak.md": `token ${token}\n` }, "second");
      // Adjacent: a credential-free release over the same first unit binds.
      expect((await resolveRelease(repository, "release:v0..HEAD~1")).units).toHaveLength(1);
      await expectCode(
        () => resolveRelease(repository, "release:v0..HEAD"),
        "change-source-credential-present",
      );

      // A unit's root tree, re-hashed only inside the unit's own resolution.
      const tampered = await initChangeRepository(await roots.create("docsfab-release-"));
      await fixtureGit(tampered.repository, ["tag", "v0"]);
      const unit = await commitFiles(tampered.repository, { "a.md": "a\n" }, "first");
      const tree = await fixtureGit(tampered.repository, ["rev-parse", `${unit}^{tree}`]);
      await rewriteLooseObject(tampered.repository, tree, (bytes) =>
        Buffer.from(bytes.toString("latin1").replace("a.md", "b.md"), "latin1"),
      );
      await expectCode(
        () => resolveRelease(tampered.repository, "release:v0..HEAD"),
        "change-source-integrity-mismatch",
        "head tree",
      );

      // A unit's own commit object, re-hashed by the enumeration.
      const interior = await initChangeRepository(await roots.create("docsfab-release-"));
      await fixtureGit(interior.repository, ["tag", "v0"]);
      const first = await commitFiles(interior.repository, { "a.md": "a\n" }, "first");
      await commitFiles(interior.repository, { "b.md": "b\n" }, "second");
      await rewriteLooseObject(interior.repository, first, (bytes) =>
        Buffer.from(bytes.toString("latin1").replace("first", "FIRST"), "latin1"),
      );
      await expectCode(
        () => resolveRelease(interior.repository, "release:v0..HEAD"),
        "change-source-integrity-mismatch",
        "unit 1",
      );
    },
    testTimeoutMs(60_000),
  );
});

describe("release-range: annotated tag integrity (row 5)", () => {
  it(
    "refuses a tampered base or head tag naming its role, though git still resolves its ref",
    async () => {
      for (const [tag, role] of [
        ["v1.0", "base tag"],
        ["v1.1", "head tag"],
      ] as const) {
        const fixture = await releaseFixture();
        const id = await fixtureGit(fixture.repository, ["rev-parse", tag]);
        await rewriteLooseObject(fixture.repository, id, (bytes) =>
          Buffer.from(
            bytes.toString("latin1").replace(`release ${tag}`, `RELEASE ${tag}`),
            "latin1",
          ),
        );
        // Positive control: git still resolves the ref and prints the altered tag.
        expect(await fixtureGit(fixture.repository, ["rev-parse", "--verify", tag])).toBe(id);
        expect(await fixtureGit(fixture.repository, ["cat-file", "tag", id])).toContain(
          `RELEASE ${tag}`,
        );
        await expectCode(
          () => resolveRelease(fixture.repository, "release:v1.0..v1.1"),
          "change-source-integrity-mismatch",
          role,
        );
      }
    },
    testTimeoutMs(60_000),
  );
});

describe("release-range: adjacent conditions of each repository-state branch", () => {
  it(
    "follows a nested tag to its commit, and lets an abort through the name probe",
    async () => {
      const fixture = await releaseFixture();
      await fixtureGit(fixture.repository, ["tag", "-a", "nested", "-m", "nested", "v1.1"]);
      const nested = await fixtureGit(fixture.repository, ["rev-parse", "nested"]);
      const result = await resolveRelease(fixture.repository, "release:v1.0..nested");
      expect(result.index.tags).toEqual({ base: fixture.baseTag, head: nested });
      expect(result.index.units.at(-1)!.id).toBe(fixture.empty);

      // The probe handles only the runner's own failure for a name; an abort is not one.
      const controller = new AbortController();
      const error = await caught(() =>
        resolveReleaseRangeChangeSource({
          sourcePath: fixture.repository,
          selector: parseChangeSourceSelector("release:v1.0..v1.1") as ReleaseRangeSelectorV1,
          workspaceRevision: "HEAD",
          readBudget: CEILING_BUDGET,
          signal: controller.signal,
          observeGit: (args) => {
            if (args.includes("--verify")) controller.abort();
          },
        }),
      );
      expect((error as Error).name).toBe("AbortError");
      expect(error).not.toBeInstanceOf(ChangeSourceError);
    },
    testTimeoutMs(60_000),
  );

  it(
    "omits a merge's introduced list over changeSources.commitsMax and keeps it at the bound",
    async () => {
      const fixture = await releaseFixture();
      override("DOCSFAB_CHANGE_SOURCES_COMMITS_MAX", 2);
      const atLimit = await resolveRelease(fixture.repository, "release:v1.0..v1.1");
      expect(atLimit.index.units[1]!.introduced.state).toBe("listed");
      override("DOCSFAB_CHANGE_SOURCES_COMMITS_MAX", 1);
      const over = await resolveRelease(fixture.repository, "release:v1.0..v1.1");
      expect(over.index.units[1]!.introduced).toEqual({
        state: "omitted",
        code: "change-source-commits-bound",
        limitName: "changeSources.commitsMax",
        observed: 2,
        limit: 1,
      });
      // The unit itself still binds: the bound applies to what the merge brought in.
      expect(over.index.units[1]!.evidence.state).toBe("bound");
    },
    testTimeoutMs(60_000),
  );

  it(
    "refuses a grafts file before walking, and a shallow range past its boundary as missing history",
    async () => {
      const fixture = await releaseFixture();
      const shallow = roots.track(`${fixture.repository}-shallow`);
      // Three generations of main: empty, octopus, then merge, left and right on the boundary.
      await fixtureGit(fixture.repository, [
        "clone",
        "-q",
        "--no-tags",
        "--depth=3",
        `file://${fixture.repository}`,
        shallow,
      ]);
      await expectCode(
        () => resolveRelease(shallow, `release:${fixture.root}..HEAD`),
        "change-source-revision-unresolved",
      );
      // Adjacent: a range inside the held history resolves, and labels the
      // octopus's introduced list, which the boundary may have cut.
      const inside = await resolveRelease(shallow, `release:${fixture.merge}..HEAD`);
      expect(inside.index.units.map((unit) => unit.id)).toEqual([fixture.octopus, fixture.empty]);
      expect(inside.index.labels).toEqual(["introduced-lists-unproven-shallow"]);
      // With the base fetched, the walk crosses the boundary at the merge,
      // whose first parent this clone does not hold.
      await fixtureGit(shallow, [
        "fetch",
        "-q",
        "--depth=1",
        "origin",
        "refs/tags/v1.0:refs/tags/v1.0",
      ]);
      await expectCode(
        () => resolveRelease(shallow, "release:v1.0..HEAD"),
        "change-source-history-unavailable",
      );

      await writeFile(join(fixture.repository, ".git", "info", "grafts"), `${fixture.plain}\n`);
      await expectCode(
        () => resolveRelease(fixture.repository, "release:v1.0..v1.1"),
        "change-source-grafts-present",
      );
    },
    testTimeoutMs(60_000),
  );
});

describe("release-range: bounds and paging (row 6)", () => {
  it(
    "admits at changeSourcesRelease.unitsMax and refuses one over before listing a unit",
    async () => {
      const fixture = await releaseFixture();
      override("DOCSFAB_CHANGE_SOURCES_RELEASE_UNITS_MAX", 4);
      expect((await resolveRelease(fixture.repository, "release:v1.0..v1.1")).units).toHaveLength(
        4,
      );
      override("DOCSFAB_CHANGE_SOURCES_RELEASE_UNITS_MAX", 3);
      const calls: string[][] = [];
      const error = await caught(() =>
        resolveRelease(fixture.repository, "release:v1.0..v1.1", {
          observeGit: (args) => calls.push([...args]),
        }),
      );
      expect(error).toBeInstanceOf(OperationalLimitError);
      expect(error).toMatchObject({
        code: "change-source-release-units-bound",
        limitName: "changeSourcesRelease.unitsMax",
        observed: 4,
        configured: 3,
      });
      const revLists = calls.filter((args) => args.includes("rev-list"));
      expect(revLists.map((args) => args.includes("--count"))).toEqual([true]);
    },
    testTimeoutMs(60_000),
  );

  it(
    "pages past changeSourcesRelease.unitsPerRunMax, listing every later unit and its continuation",
    async () => {
      const fixture = await releaseFixture();
      override("DOCSFAB_CHANGE_SOURCES_RELEASE_UNITS_PER_RUN_MAX", 2);
      const first = await resolveRelease(fixture.repository, "release:v1.0..v1.1");
      const continuation = `release:${fixture.merge}..${fixture.empty}`;
      expect(first.index.page).toEqual({
        unitsPerRun: 2,
        readBudgetBytes: CEILING_BUDGET.budgetBytes,
        bound: 2,
        remaining: 2,
        continuation,
      });
      expect(
        first.index.units.map((unit) => [unit.id, unit.evidence.state, unit.introduced.state]),
      ).toEqual([
        [fixture.plain, "bound", "listed"],
        [fixture.merge, "bound", "listed"],
        [fixture.octopus, "next-page", "next-page"],
        [fixture.empty, "next-page", "next-page"],
      ]);
      expect(first.units).toHaveLength(2);
      const status = releaseRangeStatusLines(first.index);
      expect(status).toEqual([
        `release range: 4 first-parent unit(s) to ${fixture.empty}; 2 bound and 0 omitted in this run, 2 on later pages`,
        `release range continues: 2 unit(s) after this page; run again with --change ${continuation} to bind them`,
        `release unit 3 (${fixture.octopus}) is on a later page`,
        `release unit 4 (${fixture.empty}) is on a later page`,
      ]);

      const next = await resolveRelease(fixture.repository, continuation);
      expect(next.index.units.map((unit) => [unit.id, unit.evidence.state])).toEqual([
        [fixture.octopus, "bound"],
        [fixture.empty, "bound"],
      ]);
      expect(next.index.labels).toEqual([]);
      expect(next.index.page.continuation).toBeNull();
    },
    testTimeoutMs(60_000),
  );

  it(
    "refuses before resolving any unit when the index, the page and --source files exceed the binding cap",
    async () => {
      const fixture = await releaseFixture();
      // 1 index + 2 x 4 units + 247 files is exactly the 256 a binding holds.
      const atCap = await resolveRelease(fixture.repository, "release:v1.0..v1.1", {
        besideObservations: 247,
      });
      expect(atCap.units).toHaveLength(4);
      const calls: string[][] = [];
      await expectCode(
        () =>
          resolveRelease(fixture.repository, "release:v1.0..v1.1", {
            besideObservations: 248,
            observeGit: (args) => calls.push([...args]),
          }),
        "change-source-release-observations-exceeded",
        "257 observations: 1 units index, 2 for each of 4 units, and 248 --source files, over the 256 one source binding holds",
      );
      // Nothing was read after the listing: no unit's objects or introduced commits.
      const listing = calls.findIndex((args) => args.includes("--reverse"));
      expect(listing).toBeGreaterThanOrEqual(0);
      expect(calls.slice(listing + 1)).toEqual([]);
    },
    testTimeoutMs(60_000),
  );
});

/**
 * The index's byte length when the budget it records is that length itself:
 * the budget is written into the index, so iterate to the fixed point.
 */
async function indexFixedPoint(
  run: (budget: SourceReadBudgetV1) => Promise<ResolvedReleaseRangeV1>,
): Promise<number> {
  let bytes = (await run(CEILING_BUDGET)).indexBytes.byteLength;
  for (;;) {
    const next = (await run(budgetOf(bytes))).indexBytes.byteLength;
    if (next === bytes) return bytes;
    bytes = next;
  }
}

describe("release-range: the page fits the units index to one step's read budget", () => {
  it(
    "binds the whole range at a budget equal to its index and one unit fewer one byte under it",
    async () => {
      const fixture = await releaseFixture();
      const run = (readBudget: SourceReadBudgetV1) =>
        resolveRelease(fixture.repository, "release:v1.0..v1.1", {
          readBudget,
        });
      const whole = await indexFixedPoint(run);
      const atBudget = await run(budgetOf(whole));
      expect(atBudget.indexBytes.byteLength).toBe(whole);
      expect(atBudget.index.page).toMatchObject({ bound: 4, remaining: 0, readBudgetBytes: whole });
      expect(
        releaseRangeStatusLines(atBudget.index).some((line) =>
          line.startsWith("release range page:"),
        ),
      ).toBe(false);

      const under = await run(budgetOf(whole - 1));
      expect(under.indexBytes.byteLength).toBeLessThanOrEqual(whole - 1);
      const continuation = `release:${fixture.octopus}..${fixture.empty}`;
      expect(under.index.page).toEqual({
        unitsPerRun: 126,
        readBudgetBytes: whole - 1,
        bound: 3,
        remaining: 1,
        continuation,
      });
      expect(under.units.map((unit) => unit.changeSource.revision.head)).toEqual([
        fixture.plain,
        fixture.merge,
        fixture.octopus,
      ]);
      expect(under.index.units.map((unit) => unit.evidence.state)).toEqual([
        "bound",
        "bound",
        "bound",
        "next-page",
      ]);
      expect(releaseRangeStatusLines(under.index)).toEqual([
        `release range: 4 first-parent unit(s) to ${fixture.empty}; 3 bound and 0 omitted in this run, 1 on later pages`,
        `release range page: 3 of at most 126 unit(s), the most whose units index fits one step's ${whole - 1}-byte source-read budget`,
        `release range continues: 1 unit(s) after this page; run again with --change ${continuation} to bind them`,
        `release unit 4 (${fixture.empty}) is on a later page`,
      ]);
    },
    testTimeoutMs(120_000),
  );

  it(
    "binds a one-unit page whose index fits exactly and refuses one byte under it",
    async () => {
      const fixture = await releaseFixture();
      // The refusal names the one-unit index's bytes; at any four-digit budget
      // that index records a four-digit budget, so the count holds for each.
      const probe = await expectCode(
        () =>
          resolveRelease(fixture.repository, "release:v1.0..v1.1", {
            readBudget: budgetOf(1_000),
          }),
        "change-source-release-index-over-read-budget",
      );
      const one = Number(/^(\d+)-byte units index/u.exec(probe.detail ?? "")?.[1]);
      expect(one).toBeGreaterThan(1_000);
      expect(one).toBeLessThan(10_000);
      // Adjacent: the default page bound, cut to one unit by the budget alone.
      const fits = await resolveRelease(fixture.repository, "release:v1.0..v1.1", {
        readBudget: budgetOf(one),
      });
      expect(fits.index.page).toMatchObject({ unitsPerRun: 126, bound: 1, remaining: 3 });
      expect(fits.indexBytes.byteLength).toBe(one);
      expect(fits.units).toHaveLength(1);

      await expectCode(
        () =>
          resolveRelease(fixture.repository, "release:v1.0..v1.1", {
            readBudget: budgetOf(one - 1),
          }),
        "change-source-release-index-over-read-budget",
        `${one}-byte units index for 4 unit(s) with a one-unit page, over the ${one - 1}-byte ` +
          "source-read budget of one step (sources.readResponseCeilingBytes)",
      );
      const windowed = await expectCode(
        () =>
          resolveRelease(fixture.repository, "release:v1.0..v1.1", {
            readBudget: {
              budgetBytes: 100,
              basis: { kind: "input-window-share", share: 0.15, inputWindowTokens: 4_096 },
            },
          }),
        "change-source-release-index-over-read-budget",
      );
      expect(windowed.detail).toMatch(
        /over the 100-byte source-read budget of one step \(sources\.readInputWindowShare = 0\.15 of the model's 4096-token input window\)$/u,
      );
    },
    testTimeoutMs(120_000),
  );

  it(
    "refuses a configured credential that only the index carries, in an introduced-commit subject",
    async () => {
      const token = configureCredential(["glpat", "Ws8Ed1Fv6Tg4Yh9Uj2Ik7Rq3"].join("-"));
      // A merge brings in a commit whose subject alone holds the credential;
      // the merge's own record lists only the merge.
      const merged = await initChangeRepository(await roots.create("docsfab-release-"));
      await fixtureGit(merged.repository, ["tag", "v0"]);
      await fixtureGit(merged.repository, ["checkout", "-q", "-b", "side"]);
      await commitFiles(merged.repository, { "side.md": "side\n" }, `side ${token}`);
      await fixtureGit(merged.repository, ["checkout", "-q", "main"]);
      await fixtureGit(merged.repository, ["merge", "-q", "--no-ff", "-m", "Merge side", "side"]);
      const mergeId = await fixtureGit(merged.repository, ["rev-parse", "HEAD"]);
      const record = await resolveLocalChangeSource({
        sourcePath: merged.repository,
        selector: {
          schemaVersion: 1,
          kind: "docsfab-change-source-selector",
          source: "local-range",
          form: "single-commit",
          base: null,
          head: mergeId,
        } satisfies LocalRangeSelectorV1,
        workspaceRevision: "HEAD",
      });
      expect(record.changeSource.commits.map((commit) => commit.id)).toEqual([mergeId]);
      await expectCode(
        () => resolveRelease(merged.repository, "release:v0..HEAD"),
        "change-source-credential-present",
      );
    },
    testTimeoutMs(120_000),
  );

  it(
    "refuses a configured credential that only the index carries, in a later-page unit's subject",
    async () => {
      const token = configureCredential(["glpat", "Ws8Ed1Fv6Tg4Yh9Uj2Ik7Rq3"].join("-"));
      // A unit after the page: never resolved, listed in the index by subject.
      const later = await initChangeRepository(await roots.create("docsfab-release-"));
      await fixtureGit(later.repository, ["tag", "v0"]);
      await commitFiles(later.repository, { "a.md": "a\n" }, "first");
      await commitFiles(later.repository, {}, `second ${token}`, { allowEmpty: true });
      // Adjacent: the clean first unit alone binds.
      expect((await resolveRelease(later.repository, "release:v0..HEAD~1")).units).toHaveLength(1);
      override("DOCSFAB_CHANGE_SOURCES_RELEASE_UNITS_PER_RUN_MAX", 1);
      await expectCode(
        () => resolveRelease(later.repository, "release:v0..HEAD"),
        "change-source-credential-present",
      );
    },
    testTimeoutMs(120_000),
  );
});

/**
 * A release shaped like this repository's v0.0.1-rc.1..v0.0.1-rc.2: `count`
 * merge units after the tag `base`, each bringing one commit that changes
 * fifteen files.
 */
async function mergeRelease(count: number) {
  const { repository } = await initChangeRepository(await roots.create("docsfab-release-long-"));
  await fixtureGit(repository, ["tag", "base"]);
  await appendMergeUnits(repository, count, 15, 12);
  return { repository };
}

describe("release-range: combined defaults on a 126-unit release (row 7)", () => {
  it(
    "binds every unit under the default page and reads the units index whole at the default step budget",
    async () => {
      const { repository } = await mergeRelease(126);
      const workspace = await prepareRepositoryWorkspace(repository, "HEAD");
      try {
        const started = performance.now();
        const resolved = await resolveCliChangeSource({
          workspace,
          selector: parseChangeSourceSelector("release:base..main"),
        });
        const elapsedMs = performance.now() - started;
        expect(isResolvedReleaseRange(resolved)).toBe(true);
        const release = resolved as ResolvedReleaseRangeV1;
        expect(release.index.page).toMatchObject({
          readBudgetBytes: CEILING_BUDGET.budgetBytes,
          bound: 126,
          remaining: 0,
        });
        expect(release.units).toHaveLength(126);
        expect(release.index.units.every((unit) => unit.kind === "merge")).toBe(true);
        expect(release.units.every((unit) => unit.changeSource.files.length === 15)).toBe(true);
        const evidence = await resolveCliChangeSourceEvidence({
          workspace,
          resolved,
          admittedRequest: { workflow: "update-documentation", allowWrite: true },
          runId: "release-combined-defaults",
        });
        const entries = evidence.acquired.acquired;
        expect(entries).toHaveLength(1 + 2 * 126);
        const required = new Set(evidence.acquired.binding.requiredObservationIds);
        // Only the index is required; unit records and diffs are bound but optional.
        expect(
          entries
            .filter((entry) => required.has(entry.observation.observationId))
            .map((entry) => entry.role),
        ).toEqual(["release-units"]);
        const index = entries.find((entry) => entry.role === "release-units")!;
        expect(index.repositoryPath).toBe(
          releaseUnitsRepositoryPath(release.index.revision.base!, release.index.revision.head),
        );
        const plan = planRequiredSourceReads({
          binding: evidence.acquired.binding,
          observations: entries.map((entry) => entry.observation),
          spanAccesses: [],
          budgetBytes: CEILING_BUDGET.budgetBytes,
        });
        expect(plan.kind).toBe("read");
        if (plan.kind !== "read") return;
        expect(plan.reads.map((read) => read.observationId)).toEqual([
          index.observation.observationId,
        ]);
        // Whole: the read covers every span, which the original's bytes bound.
        expect(plan.reads[0]!.bytes).toBe(plan.reads[0]!.totalBytes);
        expect(plan.reads[0]!.totalBytes).toBeLessThanOrEqual(release.indexBytes.byteLength);
        expect(release.indexBytes.byteLength).toBeLessThanOrEqual(CEILING_BUDGET.budgetBytes);
        // The unit records alone are several budgets: the set this replaced
        // read each of them, and the index, in fragments.
        const manifests = planRequiredSourceReads({
          binding: {
            ...evidence.acquired.binding,
            requiredObservationIds: entries
              .filter((entry) => entry.role !== "diff")
              .map((entry) => entry.observation.observationId),
          },
          observations: entries.map((entry) => entry.observation),
          spanAccesses: [],
          budgetBytes: CEILING_BUDGET.budgetBytes,
        });
        expect(manifests.neededBytes).toBeGreaterThan(2 * CEILING_BUDGET.budgetBytes);
        // Reported as the measured pre-model latency of a 126-unit release.
        console.info(
          `release-range 126-unit pre-model resolution: ${Math.round(elapsedMs)} ms; ` +
            `units index ${release.indexBytes.byteLength} bytes`,
        );
      } finally {
        await workspace.dispose();
      }
    },
    testTimeoutMs(300_000),
  );
});
