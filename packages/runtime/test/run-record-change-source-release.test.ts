// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * A release run's run-record citation: one `changeSources` entry per unit
 * record its page bound, and the units index in `changeSourceRelease`. The
 * end-to-end rows read the record file the run store wrote, and take every
 * expected value from the fixture's git history and the sealed texts the
 * scripted model read, never from the builder.
 */
import { afterEach, describe, expect, it } from "vitest";

import { runChangeSourcesForRun } from "../src/cli/run/execution.js";
import { resolveCliChangeSource } from "../src/cli/run/source-acquisition.js";
import {
  ChangeSourceError,
  parseChangeSourceSelector,
  type ChangeSourceV1,
} from "../src/inputs/change-source.js";
import {
  changeSourceRepositoryPath,
  type AcquiredChangeSourceV1,
} from "../src/inputs/change-source/acquisition.js";
import {
  decodeReleaseUnitsIndexV1,
  isResolvedReleaseRange,
  releaseUnitsRepositoryPath,
  type AcquiredReleaseRangeV1,
  type ReleaseUnitsIndexV1,
  type ResolvedReleaseRangeV1,
} from "../src/inputs/change-source/release.js";
import { prepareRepositoryWorkspace } from "../src/repository/workspace/materialize.js";
import { decodeRunChangeSources, type RunChangeSourceV1 } from "../src/records/change-sources.js";
import {
  decodeRunChangeSourceRelease,
  RunChangeSourceReleaseError,
  runChangeSourcesFromRelease,
  type RunChangeSourceReleaseV1,
} from "../src/records/change-source-release.js";
import type { SourceToolHarness } from "./support/source-acquisition-cli.js";
import { createReleaseFixture, runReleaseRecord } from "./support/release-run.js";
import { temporaryRoots } from "./helpers/temp.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";

const roots = temporaryRoots();
const restore: Array<readonly [string, string | undefined]> = [];

function override(variable: string, value: number): void {
  restore.push([variable, process.env[variable]]);
  process.env[variable] = String(value);
}

afterEach(() => {
  process.exitCode = undefined;
  for (const [variable, value] of restore.splice(0).reverse()) {
    if (value === undefined) delete process.env[variable];
    else process.env[variable] = value;
  }
});

/** A tagged release of two units, oldest first: a plain commit, then a merge. */
async function releaseFixture() {
  const release = await createReleaseFixture();
  roots.track(release.fixture.root);
  return release;
}

type Fixture = Awaited<ReturnType<typeof releaseFixture>>["fixture"];

/** Each observation's full text as the model read it, keyed by repository path. */
function readTexts(model: SourceToolHarness): Map<string, string> {
  const texts = new Map<string, string>();
  for (const window of model.windowReads) {
    const path = model.readSpans.find(
      (span) => span.spanId === window.spans[0]!.spanId,
    )!.repositoryPath;
    texts.set(path, window.spans.map((span) => span.text).join("\n"));
  }
  return texts;
}

function listedId(model: SourceToolHarness, path: string): string {
  const entry = model.listed.find((listed) => listed.repositoryPath === path);
  expect(entry, path).toBeDefined();
  return entry!.observationId;
}

/** The entry a unit's sealed manifest, as the model read it, must persist. */
function expectedUnitEntry(model: SourceToolHarness, unit: string): RunChangeSourceV1 {
  const text = readTexts(model).get(changeSourceRepositoryPath(unit, "manifest"));
  expect(text, `the model read unit ${unit}'s manifest`).toBeDefined();
  const manifest = JSON.parse(text!) as ChangeSourceV1;
  expect(manifest.revision.head).toBe(unit);
  return {
    schemaVersion: 1,
    kind: "docsfab-run-change-source",
    sourceKind: "release-range",
    provenance: "local-verified",
    repository: manifest.revision.repository,
    objectFormat: manifest.objectFormat,
    rangeSemantics: manifest.rangeSemantics,
    base: manifest.revision.base ?? null,
    head: unit,
    mergeBase: manifest.mergeBase,
    diffFrom: manifest.diffFrom,
    labels: manifest.labels,
    fileCount: manifest.files.length,
    commitCount: manifest.commits.length,
    changeSourceSha256: manifest.changeSourceSha256,
    observations: [
      {
        role: "diff",
        observationId: listedId(model, changeSourceRepositoryPath(unit, "diff")),
      },
      {
        role: "manifest",
        observationId: listedId(model, changeSourceRepositoryPath(unit, "manifest")),
      },
    ],
  };
}

/** The index exactly as the model read it. */
function indexRead(model: SourceToolHarness, base: string, head: string): ReleaseUnitsIndexV1 {
  const text = readTexts(model).get(releaseUnitsRepositoryPath(base, head));
  expect(text, "the model read the units index").toBeDefined();
  return decodeReleaseUnitsIndexV1(JSON.parse(text!));
}

/** Both fields decode together through the shared reader decoders. */
function expectDecodes(saved: Record<string, unknown>): void {
  if (saved.changeSources !== undefined) {
    expect(decodeRunChangeSources(saved.changeSources, saved.workflow)).toEqual(
      saved.changeSources,
    );
  }
  expect(
    decodeRunChangeSourceRelease(saved.changeSourceRelease, saved.workflow, saved.changeSources),
  ).toEqual(saved.changeSourceRelease);
}

/** Each unit's diff size, from the resolver at the default bounds. */
async function unitDiffBytes(fixture: Fixture, selector: string): Promise<number[]> {
  const workspace = await prepareRepositoryWorkspace(fixture.repository, "HEAD");
  try {
    const resolved = await resolveCliChangeSource({
      workspace,
      selector: parseChangeSourceSelector(selector),
    });
    if (!isResolvedReleaseRange(resolved)) throw new Error("expected a release range");
    return resolved.units.map((unit) => unit.diffBytes.byteLength);
  } finally {
    await workspace.dispose();
  }
}

describe("run --change release: cites each bound unit record and the units index", () => {
  it(
    "persists one entry per bound unit, in index order, each the unit manifest the model read",
    async () => {
      const { fixture, base, plain, merge } = await releaseFixture();
      const { model, saved } = await runReleaseRecord(fixture, "release:v1.0..v1.1");
      const index = indexRead(model, base, merge);
      expect(saved.changeSources).toEqual([
        expectedUnitEntry(model, plain),
        expectedUnitEntry(model, merge),
      ]);
      // Each cited digest is the one the index names for that unit.
      expect((saved.changeSources as RunChangeSourceV1[]).map((e) => e.changeSourceSha256)).toEqual(
        index.units.map((unit) =>
          unit.evidence.state === "bound" ? unit.evidence.changeSourceSha256 : unit.evidence.state,
        ),
      );
      expect(saved.changeSourceRelease).toEqual({
        schemaVersion: 1,
        kind: "docsfab-run-change-source-release",
        repository: index.revision.repository,
        objectFormat: index.objectFormat,
        base,
        head: merge,
        releaseUnitsSha256: index.releaseUnitsSha256,
        observationId: listedId(model, releaseUnitsRepositoryPath(base, merge)),
        units: 2,
        pageUnits: 2,
        omittedUnits: 0,
        remainingUnits: 0,
        continuation: null,
      } satisfies RunChangeSourceReleaseV1);
      expectDecodes(saved);
    },
    testTimeoutMs(120_000),
  );

  it(
    "persists exactly one entry for a one-unit release",
    async () => {
      const { fixture, base, plain } = await releaseFixture();
      const { model, saved } = await runReleaseRecord(fixture, `release:v1.0..${plain}`);
      expect(saved.changeSources).toEqual([expectedUnitEntry(model, plain)]);
      expect(saved.changeSourceRelease).toMatchObject({
        base,
        head: plain,
        units: 1,
        pageUnits: 1,
        omittedUnits: 0,
        remainingUnits: 0,
        continuation: null,
      });
      expectDecodes(saved);
    },
    testTimeoutMs(120_000),
  );

  it(
    "persists only the bound page of a paged release, with its continuation",
    async () => {
      const { fixture, base, plain, merge } = await releaseFixture();
      override("DOCSFAB_CHANGE_SOURCES_RELEASE_UNITS_PER_RUN_MAX", 1);
      const { model, saved } = await runReleaseRecord(fixture, "release:v1.0..v1.1");
      expect(saved.changeSources).toEqual([expectedUnitEntry(model, plain)]);
      expect(model.listedPaths).not.toContain(changeSourceRepositoryPath(merge, "manifest"));
      expect(saved.changeSourceRelease).toMatchObject({
        base,
        head: merge,
        units: 2,
        pageUnits: 1,
        omittedUnits: 0,
        remainingUnits: 1,
        continuation: `release:${plain}..${merge}`,
      });
      expectDecodes(saved);
    },
    testTimeoutMs(120_000),
  );

  it(
    "gives an omitted unit no entry and counts it in the index citation",
    async () => {
      const { fixture, plain, merge } = await releaseFixture();
      const [plainBytes, mergeBytes] = await unitDiffBytes(fixture, "release:v1.0..v1.1");
      // The merge unit adds two files, so its diff is the larger.
      expect(mergeBytes!).toBeGreaterThan(plainBytes!);
      override("DOCSFAB_CHANGE_SOURCES_DIFF_MAX_BYTES", mergeBytes! - 1);
      override("DOCSFAB_CHANGE_SOURCES_FILE_DIFF_MAX_BYTES", mergeBytes! - 1);
      const { model, saved } = await runReleaseRecord(fixture, "release:v1.0..v1.1");
      expect(model.listedPaths).not.toContain(changeSourceRepositoryPath(merge, "manifest"));
      expect(saved.changeSources).toEqual([expectedUnitEntry(model, plain)]);
      expect(saved.changeSourceRelease).toMatchObject({
        units: 2,
        pageUnits: 2,
        omittedUnits: 1,
        remainingUnits: 0,
        continuation: null,
      });
      expectDecodes(saved);
    },
    testTimeoutMs(120_000),
  );

  it(
    "cites the index alone when every unit on the page was omitted",
    async () => {
      const { fixture, plain, merge } = await releaseFixture();
      // The merge unit alone: it changes two files, over a bound of one.
      override("DOCSFAB_CHANGE_SOURCES_CHANGED_FILES_MAX", 1);
      const { model, saved } = await runReleaseRecord(fixture, `release:${plain}..v1.1`);
      expect(model.listedPaths).toEqual([releaseUnitsRepositoryPath(plain, merge)]);
      expect(saved).not.toHaveProperty("changeSources");
      expect(saved.changeSourceRelease).toMatchObject({
        base: plain,
        head: merge,
        units: 1,
        pageUnits: 1,
        omittedUnits: 1,
        remainingUnits: 0,
      });
      expectDecodes(saved);
    },
    testTimeoutMs(120_000),
  );
});

const REPOSITORY = {
  kind: "local-checkout",
  identitySha256: "e".repeat(64),
} as const;
const id = (character: string) => character.repeat(40);

function unitEntry(head: string): RunChangeSourceV1 {
  return {
    schemaVersion: 1,
    kind: "docsfab-run-change-source",
    sourceKind: "release-range",
    provenance: "local-verified",
    repository: REPOSITORY,
    objectFormat: "sha1",
    rangeSemantics: "first-parent-commit",
    base: id("0"),
    head,
    mergeBase: null,
    diffFrom: id("0"),
    labels: [],
    fileCount: 1,
    commitCount: 1,
    changeSourceSha256: `${head.slice(0, 1)}`.repeat(64),
    observations: [
      { role: "diff", observationId: `obs-${head.slice(0, 1)}-diff` },
      { role: "manifest", observationId: `obs-${head.slice(0, 1)}-manifest` },
    ],
  };
}

const CITATION: RunChangeSourceReleaseV1 = {
  schemaVersion: 1,
  kind: "docsfab-run-change-source-release",
  repository: REPOSITORY,
  objectFormat: "sha1",
  base: id("0"),
  head: id("b"),
  releaseUnitsSha256: "f".repeat(64),
  observationId: "obs-release-units",
  units: 3,
  pageUnits: 2,
  omittedUnits: 0,
  remainingUnits: 1,
  continuation: `release:${id("a")}..${id("b")}`,
};

function decodeCode(
  value: unknown,
  changeSources: unknown,
  workflow: unknown = "update-documentation",
): string {
  try {
    decodeRunChangeSourceRelease(value, workflow, changeSources);
  } catch (error) {
    return error instanceof RunChangeSourceReleaseError ? "release-invalid" : "entries-invalid";
  }
  return "admitted";
}

describe("the release citation decoder admits only what the writer produces", () => {
  const entries = [unitEntry(id("a")), unitEntry(id("b"))];

  it("admits a citation with one entry per bound unit, and both fields absent", () => {
    expect(decodeCode(CITATION, entries)).toBe("admitted");
    expect(decodeCode(CITATION, entries, "create-documentation")).toBe("admitted");
    expect(decodeCode(undefined, undefined)).toBe("admitted");
    // Every page unit omitted: the citation alone.
    expect(decodeCode({ ...CITATION, omittedUnits: 2 }, undefined)).toBe("admitted");
    // A local range cites its record without any release citation.
    expect(decodeCode(undefined, [{ ...unitEntry(id("a")), sourceKind: "local-range" }])).toBe(
      "admitted",
    );
    expect(
      decodeCode({ ...CITATION, remainingUnits: 0, units: 2, continuation: null }, entries),
    ).toBe("admitted");
  });

  it("refuses a release entry without the citation, and a count or kind that disagrees", () => {
    expect(decodeCode(undefined, entries)).toBe("release-invalid");
    expect(decodeCode(CITATION, [entries[0]])).toBe("release-invalid");
    expect(decodeCode(CITATION, undefined)).toBe("release-invalid");
    expect(decodeCode({ ...CITATION, omittedUnits: 1 }, entries)).toBe("release-invalid");
    expect(decodeCode(CITATION, [entries[0], { ...entries[1]!, sourceKind: "local-range" }])).toBe(
      "release-invalid",
    );
    expect(
      decodeCode(CITATION, [
        entries[0],
        {
          ...entries[1]!,
          repository: { ...REPOSITORY, identitySha256: "d".repeat(64) },
        },
      ]),
    ).toBe("release-invalid");
  });

  it("refuses entries in another object format, or of another repository kind with the same identity", () => {
    const wide = (character: string) => character.repeat(64);
    const sha256Citation: RunChangeSourceReleaseV1 = {
      ...CITATION,
      objectFormat: "sha256",
      base: wide("0"),
      head: wide("b"),
      continuation: `release:${wide("a")}..${wide("b")}`,
    };
    const sha256Entries = entries.map((entry) => ({
      ...entry,
      objectFormat: "sha256" as const,
      base: wide("0"),
      head: wide(entry.head.slice(0, 1)),
      diffFrom: wide("0"),
    }));
    // Adjacent: each citation admits entries of its own format.
    expect(decodeCode(sha256Citation, sha256Entries)).toBe("admitted");
    expect(decodeCode(sha256Citation, entries)).toBe("release-invalid");
    expect(decodeCode(CITATION, sha256Entries)).toBe("release-invalid");

    const project = { ...REPOSITORY, kind: "gitlab-project" } as const;
    const projectEntries = entries.map((entry) => ({
      ...entry,
      repository: project,
    }));
    // Adjacent: the same kind on both sides admits; the digest alone does not bind the kind.
    expect(decodeCode({ ...CITATION, repository: project }, projectEntries)).toBe("admitted");
    expect(decodeCode(CITATION, projectEntries)).toBe("release-invalid");
    expect(decodeCode({ ...CITATION, repository: project }, entries)).toBe("release-invalid");
  });

  it("refuses a malformed citation and one outside the workflows that bind a change", () => {
    expect(decodeCode(CITATION, entries, "site-bootstrap")).toBe("entries-invalid");
    expect(decodeCode({ ...CITATION, omittedUnits: 2 }, undefined, "site-bootstrap")).toBe(
      "release-invalid",
    );
    for (const malformed of [
      null,
      { ...CITATION, extra: true },
      { ...CITATION, kind: "docsfab-run-change-source" },
      { ...CITATION, pageUnits: 0, units: 1 },
      { ...CITATION, units: 4 },
      { ...CITATION, omittedUnits: 3 },
      { ...CITATION, remainingUnits: 0, units: 2 },
      { ...CITATION, continuation: null },
      { ...CITATION, continuation: `release:${id("a")}..${id("c")}` },
      { ...CITATION, continuation: `release:${"a".repeat(64)}..${id("b")}` },
      { ...CITATION, continuation: `${id("a")}..${id("b")}` },
      { ...CITATION, base: "b".repeat(64) },
      { ...CITATION, pageUnits: 1.5 },
    ]) {
      expect(decodeCode(malformed, entries), JSON.stringify(malformed)).toBe("release-invalid");
    }
  });
});

/** An acquired release whose index lists `bound` and `omitted` units, with these acquired records. */
function acquiredRelease(
  index: ReadonlyArray<{ state: "bound"; digest: string } | { state: "omitted" }>,
  records: readonly string[],
): AcquiredReleaseRangeV1 {
  const record = (head: string) =>
    ({
      changeSource: {
        source: { kind: "release-range" },
        revision: { repository: REPOSITORY, base: id("0"), head },
        objectFormat: "sha1",
        rangeSemantics: "first-parent-commit",
        mergeBase: null,
        diffFrom: id("0"),
        labels: [],
        files: [],
        commits: [],
        changeSourceSha256: head.slice(0, 1).repeat(64),
      },
      acquired: [
        { role: "diff", observation: { observationId: `obs-${head}-diff` } },
        {
          role: "manifest",
          observation: { observationId: `obs-${head}-manifest` },
        },
      ],
      producerScopes: [],
    }) as unknown as AcquiredChangeSourceV1;
  return {
    release: {
      units: index.map((unit) =>
        unit.state === "bound"
          ? {
              evidence: {
                state: "bound",
                changeSourceSha256: unit.digest.repeat(64),
              },
            }
          : { evidence: { state: "omitted" } },
      ),
    },
    index: { observation: { observationId: "obs-index" } },
    units: records.map(record),
    acquired: [],
    producerScopes: [],
    requiredObservationIds: [],
  } as unknown as AcquiredReleaseRangeV1;
}

function builderCode(acquired: AcquiredReleaseRangeV1): string | readonly string[] | undefined {
  try {
    return runChangeSourcesFromRelease(acquired)?.map((entry) => entry.head);
  } catch (error) {
    return error instanceof ChangeSourceError ? error.code : "unexpected";
  }
}

describe("the release citation builder and its run guard", () => {
  it("cites exactly the units the index names as bound, in index order", () => {
    expect(
      builderCode(
        acquiredRelease(
          [{ state: "bound", digest: "b" }, { state: "omitted" }, { state: "bound", digest: "a" }],
          [id("a"), id("b")],
        ),
      ),
    ).toEqual([id("b"), id("a")]);
    expect(builderCode(acquiredRelease([{ state: "omitted" }], []))).toBeUndefined();
  });

  it("refuses an index and acquired records that disagree", () => {
    const cases = [
      // A bound unit without its record.
      acquiredRelease(
        [
          { state: "bound", digest: "a" },
          { state: "bound", digest: "b" },
        ],
        [id("a")],
      ),
      // A record the index does not name as bound.
      acquiredRelease([{ state: "bound", digest: "a" }, { state: "omitted" }], [id("a"), id("b")]),
      // The same record twice.
      acquiredRelease([{ state: "bound", digest: "a" }], [id("a"), id("a")]),
    ];
    for (const acquired of cases) {
      expect(builderCode(acquired)).toBe("change-source-record-unbound");
    }
  });

  it("refuses a release resolved but acquired as one record, and the reverse", () => {
    const release = acquiredRelease([{ state: "bound", digest: "a" }], [id("a")]);
    const resolvedRelease = {
      kind: "docsfab-resolved-release-range",
    } as unknown as ResolvedReleaseRangeV1;
    const single = release.units[0]!;
    const resolvedSingle = {
      changeSource: single.changeSource,
      manifestBytes: new Uint8Array(),
      diffBytes: new Uint8Array(),
    };
    for (const [resolved, acquired] of [
      [resolvedRelease, single],
      [resolvedSingle, release],
    ] as const) {
      expect(() => runChangeSourcesForRun(resolved, acquired)).toThrow(
        expect.objectContaining({ code: "change-source-record-unbound" }),
      );
    }
    expect(runChangeSourcesForRun(resolvedRelease, release)?.map((entry) => entry.head)).toEqual([
      id("a"),
    ]);
  });
});
