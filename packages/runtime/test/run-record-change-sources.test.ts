// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The run record's `changeSources` citation, end to end through
 * `executeRunRequest`: every assertion reads the record file the run store
 * wrote, never the returned record. Only the model turn is substituted, at the
 * documented harness seam; the GitHub kinds read a fixture forge through the
 * global `fetch`.
 */
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { executeRunRequest } from "../src/cli/run-request.js";
import { runChangeSourcesForRun } from "../src/cli/run/execution.js";
import { sourceReadBudgetForModel } from "../src/cli/run/source-acquisition.js";
import { parseRunArguments } from "../src/cli/run-arguments.js";
import type { CommandRunner } from "../src/init/types.js";
import {
  CHANGE_SOURCE_PROVENANCES,
  CHANGE_SOURCE_SOURCE_DECODERS,
  ChangeSourceError,
  createChangeSourceCodec,
  parseChangeSourceSelector,
  type ChangeSourceBodyV1,
  type ChangeSourceMemberV1,
  type ChangeSourceV1,
  type ResolvedChangeSourceV1,
} from "../src/inputs/change-source.js";
import {
  CHANGE_SOURCE_DIFF_MEDIA_TYPE,
  changeSourceRepositoryPath,
  type AcquiredChangeSourceEntryV1,
  type AcquiredChangeSourceV1,
} from "../src/inputs/change-source/acquisition.js";
import { gitlabProjectIdentity } from "../src/inputs/change-source/revision.js";
import { gitlabMrSourceRepositoryPath } from "../src/inputs/source-acquisition-gitlab.js";
import { operatorCodeFailureClass } from "../src/operator/failure-classification.js";
import {
  decodeRunChangeSources,
  RunChangeSourcesError,
  runChangeSourceFromAcquired,
  type RunChangeSourceV1,
} from "../src/records/change-sources.js";
import { runtimeConfig } from "./support/execution-convergence.js";
import {
  createSourceFixture,
  HTML_SOURCE_PATH,
  runRequest,
  skillResolver,
  SourceToolHarness,
} from "./support/source-acquisition-cli.js";
import { commitFiles, fixtureGit } from "./support/change-source-fixture.js";
import {
  buildChangeRepository,
  FakeGithub,
  NAME,
  OWNER,
} from "./support/github-change-source-fixture.js";
import { temporaryRoots } from "./helpers/temp.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";

const roots = temporaryRoots();

afterEach(() => {
  vi.unstubAllGlobals();
  process.exitCode = undefined;
});

/** The fixture plus one commit the change names. */
async function changeFixture() {
  const fixture = await createSourceFixture();
  roots.track(fixture.root);
  const guide = "The export command writes to the current directory.\n";
  await commitFiles(fixture.repository, { "src/export-notes.md": guide }, "seed export notes");
  const before = await fixtureGit(fixture.repository, ["rev-parse", "HEAD"]);
  const head = await commitFiles(
    fixture.repository,
    {
      "src/export-notes.md": null,
      "src/export-guide.md": guide,
      "src/export.ts": "export const requiresOutputPath = true;\n",
    },
    "Require an explicit export path",
  );
  return { fixture, before, head };
}

/** The scripted model, citing the diff and reading every observation whole. */
class DiffCitingHarness extends SourceToolHarness {
  public constructor() {
    super({
      readOnSkill: "plan-documentation",
      planSourcePaths: [HTML_SOURCE_PATH],
      readWindowMaxBytes: sourceReadBudgetForModel(undefined).budgetBytes,
    });
  }

  public override async runStep(input: Parameters<SourceToolHarness["runStep"]>[0]) {
    if (input.step.skill === "write-documentation") {
      this.readSpans.sort(
        (left, right) =>
          Number(right.mediaType === CHANGE_SOURCE_DIFF_MEDIA_TYPE) -
          Number(left.mediaType === CHANGE_SOURCE_DIFF_MEDIA_TYPE),
      );
    }
    return super.runStep(input);
  }
}

/** The manifest exactly as the model read it: the sealed record, not the builder's output. */
function manifestRead(model: SourceToolHarness, head: string): ChangeSourceV1 {
  const path = changeSourceRepositoryPath(head, "manifest");
  const window = model.windowReads.find(
    (read) =>
      model.readSpans.find((span) => span.spanId === read.spans[0]!.spanId)?.repositoryPath ===
      path,
  );
  expect(window, "the model read the manifest").toBeDefined();
  return JSON.parse(window!.spans.map((span) => span.text).join("\n")) as ChangeSourceV1;
}

/** Observation ids by role, from the inventory the model listed. */
function listedObservations(model: SourceToolHarness, head: string) {
  const id = (role: "diff" | "manifest") =>
    model.listed.find((entry) => entry.repositoryPath === changeSourceRepositoryPath(head, role))!
      .observationId;
  return [
    { role: "diff", observationId: id("diff") },
    { role: "manifest", observationId: id("manifest") },
  ];
}

function recordPath(stateDirectory: string, runId: string): string {
  return join(stateDirectory, `${runId}.json`);
}

/** The persisted record bytes, parsed. The returned record only names the file. */
async function persisted(
  stateDirectory: string,
  record: { id: string } | undefined,
): Promise<Record<string, unknown>> {
  expect(record?.id).toBeDefined();
  return JSON.parse(await readFile(recordPath(stateDirectory, record!.id), "utf8")) as Record<
    string,
    unknown
  >;
}

/**
 * Each kind's provenance in these fixtures, stated here rather than derived:
 * every merge request here has its objects in the checkout, so its diff is
 * local-verified; the GitHub kinds are always forge-reported.
 */
const EXPECTED_PROVENANCE: Readonly<Record<string, RunChangeSourceV1["provenance"]>> = {
  "local-range": "local-verified",
  "gitlab-merge-request": "local-verified",
  "github-pull-request": "forge-reported",
  "github-commit": "forge-reported",
};

/** The citation a run of this manifest must persist, built from the manifest the model read. */
function expectedEntry(
  manifest: ChangeSourceV1,
  observations: ReturnType<typeof listedObservations>,
): RunChangeSourceV1 {
  return {
    schemaVersion: 1,
    kind: "docsfab-run-change-source",
    sourceKind: manifest.source.kind,
    provenance: EXPECTED_PROVENANCE[manifest.source.kind]!,
    repository: manifest.revision.repository,
    objectFormat: manifest.objectFormat,
    rangeSemantics: manifest.rangeSemantics,
    base: manifest.revision.base ?? null,
    head: manifest.revision.head,
    mergeBase: manifest.mergeBase,
    diffFrom: manifest.diffFrom,
    labels: manifest.labels,
    fileCount: manifest.files.length,
    commitCount: manifest.commits.length,
    changeSourceSha256: manifest.changeSourceSha256,
    observations: observations as RunChangeSourceV1["observations"],
  };
}

describe("run --change cites the bound change in the persisted record", () => {
  it(
    "persists exactly one entry for an update range, built from the sealed record the model read",
    async () => {
      const { fixture, before, head } = await changeFixture();
      const model = new DiffCitingHarness();
      const record = await executeRunRequest(
        {
          ...runRequest(fixture),
          workflow: "update-documentation",
          instruction: "Update docs/whats-new.md for the change.",
          allowWrite: false,
          changeSource: parseChangeSourceSelector("HEAD~1..HEAD"),
        },
        runtimeConfig(fixture.stateDirectory),
        { silent: true, executionHarness: model, skillResolver },
      );
      const saved = await persisted(fixture.stateDirectory, record);
      const manifest = manifestRead(model, head);
      // Independent oracles: git for the pin, the read manifest for the digest.
      expect(manifest.revision).toMatchObject({ base: before, head });
      expect(saved.changeSources).toEqual([
        expectedEntry(manifest, listedObservations(model, head)),
      ]);
      expect((saved.changeSources as RunChangeSourceV1[])[0]).toMatchObject({
        sourceKind: "local-range",
        provenance: "local-verified",
        base: before,
        head,
        fileCount: 2,
        commitCount: 1,
      });
      // The update reader's decoder admits the persisted bytes on their own workflow.
      expect(saved.workflow).toBe("update-documentation");
      expect(decodeRunChangeSources(saved.changeSources, saved.workflow)).toEqual(
        saved.changeSources,
      );
    },
    testTimeoutMs(60_000),
  );

  it(
    "writes no key for a --source-only run",
    async () => {
      const { fixture } = await changeFixture();
      const sourceOnly = await executeRunRequest(
        runRequest(fixture, [HTML_SOURCE_PATH]),
        runtimeConfig(fixture.stateDirectory),
        {
          silent: true,
          executionHarness: new SourceToolHarness({
            readOnSkill: "plan-documentation",
            planSourcePaths: [HTML_SOURCE_PATH],
          }),
          skillResolver,
        },
      );
      const sourceSaved = await persisted(fixture.stateDirectory, sourceOnly);
      // A bound source reached the runner, so only the citation is absent.
      expect(sourceSaved.status).toBe("succeeded");
      expect(sourceSaved).not.toHaveProperty("changeSources");
    },
    testTimeoutMs(60_000),
  );

  it(
    "cites a merged --pr request's pinned diff beside its text, and an open --mr request's diff alone",
    async () => {
      const { fixture, base, head, merge } = await mergeRequestFixture();
      // Merged: the text arm acquires the change beside the text. Open: the
      // change arm acquires it alone. Both must cite the same kind of entry.
      const cases = [
        {
          option: "--pr",
          answer: recordedMergeRequest({ base, start: base, head, merge }),
          pin: merge,
          text: true,
        },
        {
          option: "--mr",
          answer: recordedMergeRequest(
            { base, start: base, head, merge: null },
            { state: "opened", merged_at: null },
          ),
          pin: head,
          text: false,
        },
      ] as const;
      for (const { option, answer, pin, text } of cases) {
        const forge = mergeRequestForge(answer);
        const parsed = parseRunArguments([
          "create-documentation",
          "--repo",
          fixture.repository,
          "--instruction",
          runRequest(fixture).instruction,
          "--allow-write",
          "--patch-only",
          option,
          MR_URL,
        ]);
        expect(parsed.changeSource, option).toBeDefined();
        const model = new DiffCitingHarness();
        const record = await executeRunRequest(
          { ...parsed, quiet: true },
          runtimeConfig(fixture.stateDirectory),
          {
            silent: true,
            executionHarness: model,
            skillResolver,
            changeRequestCommands: forge.commands,
            changeRequestEnvironment: {},
          },
        );
        const saved = await persisted(fixture.stateDirectory, record);
        expect(saved.status, option).toBe("succeeded");
        // The text observation is bound exactly when the request merged, and
        // is never cited as a change observation.
        expect(model.listedPaths.includes(MR_TEXT_PATH), option).toBe(text);
        expect(saved.changeSources, option).toEqual([
          expectedEntry(manifestRead(model, pin), listedObservations(model, pin)),
        ]);
        expect((saved.changeSources as RunChangeSourceV1[])[0], option).toMatchObject({
          sourceKind: "gitlab-merge-request",
          provenance: "local-verified",
          head: pin,
        });
        expect(decodeRunChangeSources(saved.changeSources, saved.workflow)).toEqual(
          saved.changeSources,
        );
      }
    },
    testTimeoutMs(120_000),
  );

  it(
    "cites a root-commit change with base null, and the shared decoder admits it",
    async () => {
      const { fixture } = await changeFixture();
      const root = await fixtureGit(fixture.repository, ["rev-list", "--max-parents=0", "HEAD"]);
      const model = new DiffCitingHarness();
      const record = await executeRunRequest(
        { ...runRequest(fixture), changeSource: parseChangeSourceSelector(root) },
        runtimeConfig(fixture.stateDirectory),
        { silent: true, executionHarness: model, skillResolver },
      );
      const saved = await persisted(fixture.stateDirectory, record);
      const [entry] = saved.changeSources as RunChangeSourceV1[];
      expect(entry).toHaveProperty("base", null);
      expect(entry).toMatchObject({ head: root, diffFrom: null, commitCount: 1 });
      expect(saved.changeSources).toEqual([
        expectedEntry(manifestRead(model, root), listedObservations(model, root)),
      ]);
      expect(saved.workflow).toBe("create-documentation");
      expect(decodeRunChangeSources(saved.changeSources, saved.workflow)).toEqual(
        saved.changeSources,
      );
    },
    testTimeoutMs(60_000),
  );

  it(
    "cites a GitHub pull request and a GitHub commit with their own kind and provenance",
    async () => {
      for (const kind of ["github-pull-request", "github-commit"] as const) {
        const fixture = await shallowWorkspace();
        const change = await buildChangeRepository(await roots.create("docsfab-record-gh-"));
        const fake = new FakeGithub(change.repository);
        let selector: string;
        if (kind === "github-commit") {
          await fake.serveCommit(change.head);
          selector = `https://github.com/${OWNER}/${NAME}/commit/${change.head}`;
        } else {
          await fixtureGit(change.repository, [
            "merge",
            "-q",
            "--no-ff",
            "-m",
            "Merge pull request #7",
            change.head,
          ]);
          await fake.servePull({
            number: 7,
            state: "closed",
            merged: true,
            baseSha: change.baseNow,
            baseRef: "main",
            headSha: change.head,
            baseNow: await fixtureGit(change.repository, ["rev-parse", "main"]),
          });
          selector = `https://github.com/${OWNER}/${NAME}/pull/7`;
        }
        vi.stubGlobal("fetch", fake.fetch);
        const model = new DiffCitingHarness();
        const record = await executeRunRequest(
          { ...runRequest(fixture), changeSource: parseChangeSourceSelector(selector) },
          runtimeConfig(fixture.stateDirectory),
          { silent: true, executionHarness: model, skillResolver },
        );
        vi.unstubAllGlobals();
        const saved = await persisted(fixture.stateDirectory, record);
        const manifest = manifestRead(model, change.head);
        expect(manifest.source.kind, kind).toBe(kind);
        expect(saved.changeSources, kind).toEqual([
          expectedEntry(manifest, listedObservations(model, change.head)),
        ]);
        expect((saved.changeSources as RunChangeSourceV1[])[0], kind).toMatchObject({
          sourceKind: kind,
          provenance: "forge-reported",
          repository: { kind: "github-repository" },
          head: change.head,
        });
      }
    },
    testTimeoutMs(120_000),
  );
});

describe("the shared decoder admits only what the writer produces", () => {
  it(
    "refuses every citation the writer cannot produce and admits the shapes it can",
    async () => {
      const { fixture } = await changeFixture();
      const record = await executeRunRequest(
        { ...runRequest(fixture), changeSource: parseChangeSourceSelector("HEAD~1..HEAD") },
        runtimeConfig(fixture.stateDirectory),
        { silent: true, executionHarness: new DiffCitingHarness(), skillResolver },
      );
      const saved = await persisted(fixture.stateDirectory, record);
      expect(saved.workflow).toBe("create-documentation");
      const [valid] = saved.changeSources as RunChangeSourceV1[];
      const decode = (value: unknown) => decodeRunChangeSources(value, saved.workflow);
      const [diff, manifest] = valid!.observations;
      const { base: _base, ...withoutBase } = valid!;
      // Every id at the sha256 width, so each nullable id's row below fails on its own width.
      const wide = {
        ...valid!,
        objectFormat: "sha256",
        base: "a".repeat(64),
        head: "b".repeat(64),
        mergeBase: "c".repeat(64),
        diffFrom: "c".repeat(64),
      };
      const refused: Record<string, unknown> = {
        null: null,
        empty: [],
        "an extra key": [{ ...valid, extra: true }],
        // Not a kind any branch adds, so the row keeps refusing as kinds join.
        "an unknown source kind": [{ ...valid, sourceKind: "test-only-kind" }],
        "an unknown provenance": [{ ...valid, provenance: "operator-reported" }],
        "a schema version 2": [{ ...valid, schemaVersion: 2 }],
        "another kind": [{ ...valid, kind: "docsfab-change-source" }],
        "an unknown identity kind": [{ ...valid, repository: { ...valid!.repository, kind: "x" } }],
        "40-hex ids in a sha256 record": [{ ...valid, objectFormat: "sha256" }],
        "an extra key in the repository": [
          { ...valid, repository: { ...valid!.repository, extra: true } },
        ],
        "a 40-hex base in a sha256 record": [{ ...wide, base: "a".repeat(40) }],
        "a 40-hex merge base in a sha256 record": [{ ...wide, mergeBase: "c".repeat(40) }],
        "a 40-hex diff origin in a sha256 record": [{ ...wide, diffFrom: "c".repeat(40) }],
        "a missing role": [{ ...valid, observations: [diff] }],
        "a duplicated role beside both": [
          {
            ...valid,
            observations: [diff, manifest, { role: "diff", observationId: "obs-extra" }],
          },
        ],
        "one observation id for both roles": [
          {
            ...valid,
            observations: [diff, { role: "manifest", observationId: diff!.observationId }],
          },
        ],
        "two entries with one digest": [valid, valid],
        "unsorted labels": [
          { ...valid, labels: ["head-not-ancestor-of-workspace", "base-not-ancestor-of-head"] },
        ],
        "duplicate labels": [
          { ...valid, labels: ["base-not-ancestor-of-head", "base-not-ancestor-of-head"] },
        ],
        "a negative file count": [{ ...valid, fileCount: -1 }],
        "a fractional file count": [{ ...valid, fileCount: 1.5 }],
        "a negative commit count": [{ ...valid, commitCount: -1 }],
        "a fractional commit count": [{ ...valid, commitCount: 1.5 }],
        "no base key": [withoutBase],
        "an empty base": [{ ...valid, base: "" }],
      };
      for (const [name, value] of Object.entries(refused)) {
        expect(() => decode(value), name).toThrow(RunChangeSourcesError);
      }
      const admitted: Record<string, unknown> = {
        "the persisted entry": [valid],
        "two distinct entries": [valid, { ...valid, changeSourceSha256: "f".repeat(64) }],
        "zero counts": [{ ...valid, fileCount: 0, commitCount: 0 }],
        "a base-null entry": [{ ...valid, base: null }],
        "a sha256 entry": [wide],
        "sorted labels": [
          { ...valid, labels: ["base-not-ancestor-of-head", "head-not-ancestor-of-workspace"] },
        ],
      };
      for (const [name, value] of Object.entries(admitted)) {
        expect(decode(value), name).toEqual(value);
      }
      // The closed citation is valid for each writer-admitted workflow. The
      // persisted review writer and cold reader are exercised in the retained
      // review-plan integration tests; unrelated workflows still refuse it.
      expect(decodeRunChangeSources([valid], "update-documentation")).toEqual([valid]);
      expect(decodeRunChangeSources([valid], "review-documentation")).toEqual([valid]);
      expect(() => decodeRunChangeSources([valid], "answer-question")).toThrow(
        RunChangeSourcesError,
      );
    },
    testTimeoutMs(60_000),
  );
});

/** A test-only kind, so the builder is shown to read the record rather than name a kind. */
const testCodec = createChangeSourceCodec({
  ...CHANGE_SOURCE_SOURCE_DECODERS,
  "test-forge": (root, decode) => {
    decode.exact(root, ["kind", "provenance"]);
    return {
      kind: "test-forge",
      provenance: decode.enumeration(root.provenance, CHANGE_SOURCE_PROVENANCES),
    };
  },
});

const objectId = (character: string) => character.repeat(40);

function testRecord(): ChangeSourceV1<ChangeSourceMemberV1> {
  const body: ChangeSourceBodyV1<ChangeSourceMemberV1> = {
    source: { kind: "test-forge", provenance: "forge-reported" },
    revision: {
      schemaVersion: 1,
      kind: "docsfab-pinned-repository-revision",
      repository: gitlabProjectIdentity({ host: "gitlab.example.test", projectId: 7 }),
      base: objectId("a"),
      head: objectId("b"),
    },
    objectFormat: "sha1",
    rangeSemantics: "three-dot",
    mergeBase: objectId("c"),
    diffFrom: objectId("c"),
    baseTree: null,
    headTree: null,
    commits: [
      { id: objectId("d"), parents: [objectId("c")], subject: "one" },
      { id: objectId("b"), parents: [objectId("d")], subject: "two" },
    ],
    files: [],
    labels: ["commit-list-incomplete-shallow"],
    protocol: { provider: "gitlab" },
  };
  return testCodec.create(body);
}

function acquiredOf(changeSource: ChangeSourceV1<ChangeSourceMemberV1>): AcquiredChangeSourceV1 {
  const entry = (role: "diff" | "manifest", observationId: string) =>
    ({ role, observation: { observationId } }) as unknown as AcquiredChangeSourceEntryV1;
  return {
    changeSource,
    acquired: [entry("diff", "obs-test-diff"), entry("manifest", "obs-test-manifest")],
    producerScopes: [],
  };
}

describe("the change-source citation builder and its run guard", () => {
  it("copies kind, provenance and pin from the sealed record of any kind", () => {
    const changeSource = testRecord();
    expect(runChangeSourceFromAcquired(acquiredOf(changeSource))).toEqual({
      schemaVersion: 1,
      kind: "docsfab-run-change-source",
      sourceKind: "test-forge",
      provenance: "forge-reported",
      repository: changeSource.revision.repository,
      objectFormat: "sha1",
      rangeSemantics: "three-dot",
      base: objectId("a"),
      head: objectId("b"),
      mergeBase: objectId("c"),
      diffFrom: objectId("c"),
      labels: ["commit-list-incomplete-shallow"],
      fileCount: 0,
      commitCount: 2,
      changeSourceSha256: changeSource.changeSourceSha256,
      observations: [
        { role: "diff", observationId: "obs-test-diff" },
        { role: "manifest", observationId: "obs-test-manifest" },
      ],
    });
  });

  it("refuses a resolved change with no acquired record, and cites nothing without a change", () => {
    const changeSource = testRecord();
    const resolved = {
      changeSource,
      manifestBytes: new Uint8Array(),
      diffBytes: new Uint8Array(),
    } as ResolvedChangeSourceV1<ChangeSourceMemberV1>;
    const acquired = acquiredOf(changeSource);

    const error = (() => {
      try {
        runChangeSourcesForRun(resolved, undefined);
      } catch (caught) {
        return caught;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(ChangeSourceError);
    expect((error as ChangeSourceError).code).toBe("change-source-record-unbound");
    expect((error as ChangeSourceError).message).toContain("run again without that option");
    expect(operatorCodeFailureClass("change-source-record-unbound")).toBe("contract-shape");

    expect(runChangeSourcesForRun(undefined, undefined)).toBeUndefined();
    // The adjacent condition: an acquired change with no resolved `--change` cites nothing.
    expect(runChangeSourcesForRun(undefined, acquired)).toBeUndefined();
    expect(runChangeSourcesForRun(resolved, acquired)).toEqual([
      runChangeSourceFromAcquired(acquired),
    ]);
  });
});

/** The docs workspace as the alpha tasks build it: shallow, detached, remote-less. */
async function shallowWorkspace() {
  const fixture = await createSourceFixture();
  roots.track(fixture.root);
  const repository = join(fixture.root, "shallow-checkout");
  await fixtureGit(fixture.root, ["init", "-q", repository]);
  await fixtureGit(repository, [
    "fetch",
    "-q",
    "--depth",
    "1",
    `file://${fixture.repository}`,
    "HEAD",
  ]);
  await fixtureGit(repository, ["checkout", "-q", "FETCH_HEAD"]);
  return { ...fixture, repository };
}

const MR_HOST = "gitlab.example.test";
const MR_PROJECT = "team/docs-project";
const MR_PROJECT_ID = 4242;
const MR_IID = 813;
const MR_URL = `https://${MR_HOST}/${MR_PROJECT}/-/merge_requests/${MR_IID}`;
const MR_TEXT_PATH = gitlabMrSourceRepositoryPath(MR_IID);

const RECORDED_MR = readFileSync(
  join(import.meta.dirname, "fixtures", "change-source-gitlab", "merge-request-get.json"),
  "utf8",
);

/** The recorded merge request read, with the fixture's commit ids filled in. */
function recordedMergeRequest(
  ids: Readonly<Record<"base" | "start" | "head" | "merge", string | null>>,
  fields: Record<string, unknown> = {},
): Record<string, unknown> {
  const filled = JSON.parse(RECORDED_MR, (_key, value: unknown) =>
    typeof value === "string" && value.startsWith("@")
      ? ids[value.slice(1) as keyof typeof ids]
      : value,
  ) as Record<string, unknown>;
  return { ...filled, ...fields };
}

/** A recorded `glab api` forge: the project read answers its identity, every merge request read `answer`. */
function mergeRequestForge(answer: Record<string, unknown>): { commands: CommandRunner } {
  return {
    commands: {
      async run(_command: string, args: readonly string[]) {
        const endpoint = String(args.at(-1));
        const body = endpoint.includes("/merge_requests/")
          ? answer
          : { id: MR_PROJECT_ID, path_with_namespace: MR_PROJECT };
        return { stdout: JSON.stringify(body), stderr: "", exitCode: 0 };
      },
    },
  };
}

/** The source fixture plus a two-commit feature merged into its branch with a merge commit. */
async function mergeRequestFixture() {
  const fixture = await createSourceFixture();
  roots.track(fixture.root);
  const branch = await fixtureGit(fixture.repository, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const base = await fixtureGit(fixture.repository, ["rev-parse", "HEAD"]);
  await fixtureGit(fixture.repository, ["checkout", "-q", "-b", "feature/export-path"]);
  await commitFiles(
    fixture.repository,
    { "src/export-notes.md": "The export command writes to the current directory.\n" },
    "Seed export notes",
  );
  const head = await commitFiles(
    fixture.repository,
    { "src/export.ts": "export const requiresOutputPath = true;\n" },
    "Require an explicit export path",
  );
  await fixtureGit(fixture.repository, ["checkout", "-q", branch]);
  await fixtureGit(fixture.repository, [
    "merge",
    "-q",
    "--no-ff",
    "-m",
    "Merge branch 'feature/export-path'",
    "feature/export-path",
  ]);
  const merge = await fixtureGit(fixture.repository, ["rev-parse", "HEAD"]);
  return { fixture, base, head, merge };
}
