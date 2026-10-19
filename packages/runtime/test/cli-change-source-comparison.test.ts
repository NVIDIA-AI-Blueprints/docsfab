// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `docsfab run --change` beside `--comparison-base` or `--comparison-workspace`,
 * end to end through `executeRunRequest`. The change enters the source binding
 * through its producer scope and observations, never as a request field; the
 * comparison enters the projected request as `readerEvidenceRequest`. So a run
 * carrying both seals at projection version 4, and the change's relation to the
 * comparison is recorded, never refused. Only the model turn is substituted, at
 * the documented harness seam; every record assertion reads the persisted bytes.
 */
import { readFileSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import { executeRunRequest } from "../src/cli/run-request.js";
import { parseRunArguments } from "../src/cli/run-arguments.js";
import * as sourceAcquisition from "../src/cli/run/source-acquisition.js";
import * as readerTaskAdmission from "../src/execution/reader-task-admission.js";
import type { ReaderTaskContextObservationV1 } from "../src/execution/reader-task-admission.js";
import type { CommandRunner } from "../src/init/types.js";
import { GIT_FULL_OBJECT_ID } from "../src/inputs/change-source/revision.js";
import { changeSourceRepositoryPath } from "../src/inputs/change-source/acquisition.js";
import {
  projectSourceRequestContext,
  selectSourceRequestProjectionVersion,
  SourceEvidenceContractError,
} from "../src/inputs/source-evidence.js";
import { gitlabMrSourceRepositoryPath } from "../src/inputs/source-acquisition-gitlab.js";
import type { RunChangeSourceV1 } from "../src/records/change-sources.js";
import { runtimeConfig } from "./support/execution-convergence.js";
import {
  createSourceFixture,
  HTML_SOURCE_PATH,
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
const exec = promisify(execFile);

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  process.exitCode = undefined;
});

const INSTRUCTION = "Update docs/whats-new.md for the change.";

/** Git's SHA-1 object id width, from the git object format, not an operational bound. */
const SHA1_OBJECT_ID_HEX_CHARS = 40;
const objectId = (character: string) => character.repeat(SHA1_OBJECT_ID_HEX_CHARS);

/**
 * The admitted keys and projection version of a request that carries only one
 * of the change and the comparison. They pin the request's shape only: every
 * digest is recomputed from the captured request in its own test, so prompt,
 * quality-pack or request-intent wording never reaches this file.
 */
const SHAPE = Object.freeze({
  comparisonWithoutChange: {
    keys: [
      "allowWrite",
      "editorialEvidenceRefs",
      "instruction",
      "readerContextInput",
      "readerEvidenceRequest",
      "readerTaskContext",
      "repository",
      "requestIntent",
      "retryContext",
      "runId",
      "signal",
      "taskLineage",
      "workflow",
      "workspacePath",
    ],
    version: 4,
  },
  changeWithoutComparison: {
    keys: [
      "allowWrite",
      "editorialEvidenceRefs",
      "instruction",
      "readerContextInput",
      "readerTaskContext",
      "repository",
      "requestIntent",
      "retryContext",
      "runId",
      "signal",
      "taskLineage",
      "workflow",
      "workspacePath",
    ],
    version: 3,
  },
});

/**
 * The execution request without fields scoped to one run: its id, its task
 * lineage (the run's id, clock and checkout path) and its materialized
 * checkout, plus recovery-only metadata that does not change execution input.
 * Twin runs of one request agree on every other execution field.
 */
function requestFields(run: AdmittedRun): Record<string, unknown> {
  const admitted = run.binding.admittedRequest;
  expect(admitted.taskLineage).toMatchObject({ origin: { kind: "docsfab-task-origin" } });
  const {
    runId: _id,
    taskLineage: _lineage,
    workspacePath: _checkout,
    retryContext: _retryContext,
    ...stable
  } = admitted;
  return stable;
}

/** The identity the runner resolved outside the hashed body for this run's binding. */
function resolvedOf(run: AdmittedRun): Parameters<typeof projectSourceRequestContext>[1] {
  return {
    runId: String(run.saved.id),
    workspaceIdentitySha256: run.binding.workspaceIdentitySha256,
    repository: run.binding.repository,
  };
}

/** A comparison no test requests, to show the digest commits to the comparison. */
const OTHER_COMPARISON = Object.freeze({
  comparisonRequest: {
    kind: "base-head",
    baseRevision: objectId("e"),
    headRevision: objectId("f"),
  },
});

/** The shared source fixture re-initialised as one root commit, optionally in sha256 format. */
async function reproducibleFixture(objectFormat?: "sha256") {
  const fixture = await createSourceFixture();
  roots.track(fixture.root);
  await rm(join(fixture.repository, ".git"), { recursive: true, force: true });
  await fixtureGit(fixture.repository, [
    "init",
    "-q",
    "-b",
    "main",
    ...(objectFormat ? [`--object-format=${objectFormat}`] : []),
  ]);
  const root = await commitFiles(fixture.repository, {}, "fixture baseline");
  return { ...fixture, revision: root };
}

/** The fixture plus one commit the change names: `HEAD~1..HEAD` is `before..head`. */
async function changeFixture(objectFormat?: "sha256") {
  const fixture = await reproducibleFixture(objectFormat);
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
  return { fixture, root: fixture.revision, before, head };
}

/** The persisted record bytes, parsed. The returned record only names the file. */
async function persisted(
  stateDirectory: string,
  record: { id: string } | undefined,
): Promise<Record<string, unknown>> {
  expect(record?.id).toBeDefined();
  return JSON.parse(await readFile(join(stateDirectory, `${record!.id}.json`), "utf8")) as Record<
    string,
    unknown
  >;
}

interface Captured {
  readonly admittedRequest: Record<string, unknown>;
  readonly runId: string;
  readonly requestSha256: string;
  readonly workspaceIdentitySha256: string;
  readonly repository: Parameters<typeof projectSourceRequestContext>[1]["repository"];
}

type Binder = "change" | "changeRequest" | "source";

interface Capture {
  /** Read every spy's calls and results, then restore the spies; call after the run returns. */
  readonly settle: () => Promise<void>;
  readonly change: () => Captured[];
  readonly changeRequest: () => Captured[];
  readonly source: () => Captured[];
  readonly observations: () => ReaderTaskContextObservationV1[];
}

/**
 * Pass-through spies on the shipped binders and on the reader-task observation:
 * what each was handed and what it returned, read after the run, so nothing
 * about the run itself is substituted. A merged merge request binds through
 * the change-request binder, its text beside its diff; every other change
 * binds through the change binder, and a run without a change through the
 * source binder.
 */
function captureBindings(): Capture {
  const change = vi.spyOn(sourceAcquisition, "resolveCliChangeSourceEvidence");
  const changeRequest = vi.spyOn(sourceAcquisition, "resolveCliChangeRequestEvidenceFromSelector");
  const source = vi.spyOn(sourceAcquisition, "resolveCliSourceEvidence");
  const observe = vi.spyOn(readerTaskAdmission, "observeReaderTaskContextAdmissionV1");
  const read = async (
    spy: typeof change | typeof changeRequest | typeof source,
  ): Promise<Captured[]> =>
    Promise.all(
      spy.mock.calls.map(async ([input], index) => {
        const bound = await (spy.mock.results[index]!.value as ReturnType<
          typeof sourceAcquisition.resolveCliSourceEvidence
        >);
        return {
          admittedRequest: input.admittedRequest as Record<string, unknown>,
          runId: input.runId,
          requestSha256: bound.acquired.binding.requestSha256,
          workspaceIdentitySha256: bound.runnerBinding.workspaceIdentitySha256,
          repository: bound.acquired.binding.repository,
        };
      }),
    );
  let changeCaptured: Captured[] = [];
  let changeRequestCaptured: Captured[] = [];
  let sourceCaptured: Captured[] = [];
  let observationsCaptured: ReaderTaskContextObservationV1[] = [];
  return {
    settle: async () => {
      changeCaptured = await read(change);
      changeRequestCaptured = await read(changeRequest);
      sourceCaptured = await read(source);
      observationsCaptured = await Promise.all(
        observe.mock.results.map(
          (result) => result.value as Promise<ReaderTaskContextObservationV1>,
        ),
      );
      // A second run in the same test starts from fresh spies.
      for (const spy of [change, changeRequest, source, observe]) spy.mockRestore();
    },
    change: () => changeCaptured,
    changeRequest: () => changeRequestCaptured,
    source: () => sourceCaptured,
    observations: () => observationsCaptured,
  };
}

interface AdmittedRun {
  readonly parsed: ReturnType<typeof parseRunArguments>;
  readonly saved: Record<string, unknown>;
  readonly model: SourceToolHarness;
  readonly binding: Captured;
  /** The run's first reader-task admission, before any planned-page refresh. */
  readonly observation: ReaderTaskContextObservationV1;
}

/**
 * Parse `argv` exactly as the CLI does and run it. The scripted planner only
 * proposes create plans, so an update run stops at the plan step's
 * `invalid-mode` check, after the model turn: reaching it means every
 * pre-model refusal, the binding seal and the runner's recomputation passed.
 */
async function runAdmitted(
  stateDirectory: string,
  argv: readonly string[],
  options: {
    readonly changeRequestCommands?: CommandRunner;
    /**
     * Which binder seals the run: `changeRequest` for a merged merge request,
     * `source` for a run without a change.
     */
    readonly binder?: Binder;
  } = {},
): Promise<AdmittedRun> {
  const parsed = parseRunArguments([...argv]);
  const capture = captureBindings();
  const model = new SourceToolHarness({
    readOnSkill: "plan-documentation",
    planSourcePaths: [HTML_SOURCE_PATH],
  });
  const record = await executeRunRequest(
    { ...parsed, quiet: true },
    runtimeConfig(stateDirectory),
    {
      silent: true,
      executionHarness: model,
      skillResolver,
      ...(options.changeRequestCommands
        ? { changeRequestCommands: options.changeRequestCommands, changeRequestEnvironment: {} }
        : {}),
    },
  );
  await capture.settle();
  const saved = await persisted(stateDirectory, record);
  expect(model.calls[0]).toMatchObject({ stepId: "plan-documentation", hasSourceBinding: true });
  expect(saved.failure).toMatchObject({ layer: "workflow", code: "invalid-mode" });
  const binder = options.binder ?? "change";
  const binders: readonly Binder[] = ["change", "changeRequest", "source"];
  for (const other of binders.filter((name) => name !== binder)) {
    expect(capture[other](), other).toEqual([]);
  }
  expect(capture[binder]()).toHaveLength(1);
  expect(capture.observations().length).toBeGreaterThan(0);
  return {
    parsed,
    saved,
    model,
    binding: capture[binder]()[0]!,
    observation: capture.observations()[0]!,
  };
}

/** The sealed request digest is the projection of the captured admitted request, at `version`. */
function expectSealedAt(run: AdmittedRun, version: number): void {
  const admitted = run.binding.admittedRequest;
  expect(admitted.runId).toBe(run.saved.id);
  expect(selectSourceRequestProjectionVersion(admitted)).toBe(version);
  expect(run.binding.requestSha256).toBe(projectSourceRequestContext(admitted, resolvedOf(run)));
}

/** The repository paths the reader-task admission nominated as changed sources. */
function changedSources(observation: ReaderTaskContextObservationV1): string[] {
  return observation.admission.sources
    .filter((source) => source.role === "changed-source")
    .map((source) => source.uri);
}

/**
 * The positive checks for a run carrying a comparison: the binding committed
 * to the admitted request at version 4, recomputed here from the captured
 * request, the comparison is part of that commitment, version 3 cannot
 * represent it, and the comparison reached the reader-task admission too.
 */
function expectSealedAtVersion4(run: AdmittedRun): void {
  const { binding, parsed } = run;
  const admitted = binding.admittedRequest;
  expect(admitted.readerEvidenceRequest).toEqual({ comparisonRequest: parsed.comparisonRequest });
  expectSealedAt(run, 4);
  const resolved = resolvedOf(run);
  expect(
    projectSourceRequestContext({ ...admitted, readerEvidenceRequest: OTHER_COMPARISON }, resolved),
  ).not.toBe(binding.requestSha256);
  const comparison = parsed.comparisonRequest!;
  expect(run.observation.admission.comparison).toEqual(
    comparison.kind === "base-head"
      ? {
          kind: "base-head",
          base_revision: comparison.baseRevision,
          head_revision: comparison.headRevision,
        }
      : { kind: "workspace", snapshot_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) },
  );
  const refused = (() => {
    try {
      projectSourceRequestContext(admitted, resolved, { projectionVersion: 3 });
    } catch (caught) {
      return caught;
    }
  })();
  expect(refused).toBeInstanceOf(SourceEvidenceContractError);
  expect(refused).toMatchObject({
    code: "projection-unversioned",
    field: "request.readerEvidenceRequest",
  });
}

/** The persisted record carries the comparison and exactly one change citation. */
function expectRecorded(run: AdmittedRun, head: string): RunChangeSourceV1 {
  const { saved, parsed } = run;
  expect(saved.readerEvidenceRequest).toEqual({ comparisonRequest: parsed.comparisonRequest });
  const changeSources = saved.changeSources as RunChangeSourceV1[];
  expect(changeSources).toHaveLength(1);
  expect(changeSources[0]!.head).toBe(head);
  expect(run.model.listedPaths).toEqual(
    expect.arrayContaining([
      changeSourceRepositoryPath(head, "diff"),
      changeSourceRepositoryPath(head, "manifest"),
    ]),
  );
  // A base-head comparison names the run's own revision as its head; the
  // change's relation to that revision is a label on its citation, not a check.
  const comparison = (saved.readerEvidenceRequest as { comparisonRequest: { kind: string } })
    .comparisonRequest as { kind: string; headRevision?: string };
  if (comparison.kind === "base-head") {
    expect(comparison.headRevision).toBe((saved.repository as { revision: string }).revision);
  }
  return changeSources[0]!;
}

function updateArgv(repository: string, ...extra: string[]): string[] {
  return [
    "update-documentation",
    "--repo",
    repository,
    "--instruction",
    INSTRUCTION,
    "--patch-only",
    ...extra,
  ];
}

describe("run --change beside a comparison admits and seals at projection version 4", () => {
  it(
    "binds a local range beside --comparison-base and records both",
    async () => {
      const { fixture, root, before, head } = await changeFixture();
      const run = await runAdmitted(
        fixture.stateDirectory,
        updateArgv(
          fixture.repository,
          "--change",
          "HEAD~1..HEAD",
          "--comparison-base",
          root,
          "--revision",
          head,
        ),
      );
      expect(run.parsed.comparisonRequest).toEqual({
        kind: "base-head",
        baseRevision: root,
        headRevision: head,
      });
      expectSealedAtVersion4(run);
      // The base-head comparison still nominates its own changed paths beside
      // the change: root..head, not the change's before..head.
      expect(changedSources(run.observation)).toEqual(["src/export-guide.md", "src/export.ts"]);
      const entry = expectRecorded(run, head);
      expect(entry).toMatchObject({ sourceKind: "local-range", base: before, head, labels: [] });
      expect((run.saved.repository as { revision: string }).revision).toBe(head);
    },
    testTimeoutMs(60_000),
  );

  it(
    "binds a local range beside --comparison-workspace",
    async () => {
      const { fixture, before, head } = await changeFixture();
      const run = await runAdmitted(
        fixture.stateDirectory,
        updateArgv(fixture.repository, "--change", "HEAD~1..HEAD", "--comparison-workspace"),
      );
      expect(run.parsed.comparisonRequest).toEqual({ kind: "workspace" });
      expectSealedAtVersion4(run);
      expect(expectRecorded(run, head)).toMatchObject({ sourceKind: "local-range", base: before });
    },
    testTimeoutMs(60_000),
  );

  it(
    "binds run --mr's pinned diff beside --comparison-base",
    async () => {
      const { fixture, base, head, merge } = await mergeRequestFixture();
      const forge = mergeRequestForge(
        recordedMergeRequest(
          { base, start: base, head, merge: null },
          { state: "opened", merged_at: null },
        ),
      );
      const run = await runAdmitted(
        fixture.stateDirectory,
        updateArgv(
          fixture.repository,
          "--mr",
          MR_URL,
          "--comparison-base",
          base,
          "--revision",
          merge,
        ),
        { changeRequestCommands: forge.commands },
      );
      expect(run.parsed.changeSource).toMatchObject({ source: "gitlab-merge-request" });
      expectSealedAtVersion4(run);
      expect(expectRecorded(run, head)).toMatchObject({
        sourceKind: "gitlab-merge-request",
        provenance: "local-verified",
      });
      // An open merge request binds its diff alone, never its text.
      expect(run.model.listedPaths).not.toContain(MR_TEXT_PATH);
    },
    testTimeoutMs(60_000),
  );

  it(
    "binds a merged --pr request's text and pinned diff beside --comparison-base",
    async () => {
      const { fixture, base, head, merge } = await mergeRequestFixture();
      const forge = mergeRequestForge(recordedMergeRequest({ base, start: base, head, merge }));
      const run = await runAdmitted(
        fixture.stateDirectory,
        updateArgv(
          fixture.repository,
          "--pr",
          MR_URL,
          "--comparison-base",
          base,
          "--revision",
          merge,
        ),
        { changeRequestCommands: forge.commands, binder: "changeRequest" },
      );
      expectSealedAtVersion4(run);
      // A merged merge request is pinned at its merge commit, text beside diff.
      expect(expectRecorded(run, merge)).toMatchObject({ sourceKind: "gitlab-merge-request" });
      expect(run.model.listedPaths).toContain(MR_TEXT_PATH);
    },
    testTimeoutMs(60_000),
  );
});

describe("run --change beside a comparison: relations are recorded, never refused", () => {
  it(
    "admits a comparison base on an orphan history beside a local range",
    async () => {
      const { fixture, head } = await changeFixture();
      await fixtureGit(fixture.repository, ["checkout", "-q", "--orphan", "island"]);
      const island = await commitFiles(fixture.repository, { "island.md": "isle\n" }, "island");
      await fixtureGit(fixture.repository, ["checkout", "-q", "-f", "main"]);
      const run = await runAdmitted(
        fixture.stateDirectory,
        updateArgv(
          fixture.repository,
          "--change",
          "HEAD~1..HEAD",
          "--comparison-base",
          island,
          "--revision",
          head,
        ),
      );
      expectSealedAtVersion4(run);
      expect(expectRecorded(run, head).labels).toEqual([]);
    },
    testTimeoutMs(60_000),
  );

  it(
    "admits a change whose head is outside --revision's history and labels it",
    async () => {
      const { fixture, before, head } = await changeFixture();
      await fixtureGit(fixture.repository, ["checkout", "-q", "-b", "side", before]);
      const side = await commitFiles(fixture.repository, { "src/side.ts": "side\n" }, "side");
      await fixtureGit(fixture.repository, ["checkout", "-q", "main"]);
      const run = await runAdmitted(
        fixture.stateDirectory,
        updateArgv(
          fixture.repository,
          "--change",
          `${before}..side`,
          "--comparison-base",
          before,
          "--revision",
          head,
        ),
      );
      expectSealedAtVersion4(run);
      const entry = expectRecorded(run, side);
      expect(entry.labels).toContain("head-not-ancestor-of-workspace");
    },
    testTimeoutMs(60_000),
  );

  it(
    "admits a forge-reported GitHub pull request beside --comparison-base with no labels",
    async () => {
      const { fixture, root, head } = await changeFixture();
      const change = await buildChangeRepository(await roots.create("docsfab-comparison-gh-"));
      const fake = new FakeGithub(change.repository);
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
      vi.stubGlobal("fetch", fake.fetch);
      const run = await runAdmitted(
        fixture.stateDirectory,
        updateArgv(
          fixture.repository,
          "--change",
          `https://github.com/${OWNER}/${NAME}/pull/7`,
          "--comparison-base",
          root,
          "--revision",
          head,
        ),
      );
      expectSealedAtVersion4(run);
      expect(expectRecorded(run, change.head)).toMatchObject({
        sourceKind: "github-pull-request",
        provenance: "forge-reported",
        labels: [],
      });
    },
    testTimeoutMs(60_000),
  );

  it(
    "admits a comparison base equal to the change's own base",
    async () => {
      const { fixture, before, head } = await changeFixture();
      const run = await runAdmitted(
        fixture.stateDirectory,
        updateArgv(
          fixture.repository,
          "--change",
          "HEAD~1..HEAD",
          "--comparison-base",
          before,
          "--revision",
          head,
        ),
      );
      expectSealedAtVersion4(run);
      expect(expectRecorded(run, head).base).toBe(before);
      expect(run.parsed.comparisonRequest).toMatchObject({ baseRevision: before });
    },
    testTimeoutMs(60_000),
  );

  it(
    "admits sha256 object ids in both the change and the comparison",
    async () => {
      const { fixture, root, head } = await changeFixture("sha256");
      expect(
        [root, head].every(
          (id) => GIT_FULL_OBJECT_ID.test(id) && id.length > SHA1_OBJECT_ID_HEX_CHARS,
        ),
      ).toBe(true);
      const run = await runAdmitted(
        fixture.stateDirectory,
        updateArgv(
          fixture.repository,
          "--change",
          "HEAD~1..HEAD",
          "--comparison-base",
          root,
          "--revision",
          head,
        ),
      );
      expectSealedAtVersion4(run);
      expect(expectRecorded(run, head).objectFormat).toBe("sha256");
    },
    testTimeoutMs(60_000),
  );

  it.skipIf(process.getuid?.() === 0)(
    "admits a change beside a comparison from a checkout whose files are all read-only",
    async () => {
      const { fixture, root, head } = await changeFixture();
      await exec("chmod", ["-R", "a-w", fixture.repository]);
      try {
        const run = await runAdmitted(
          fixture.stateDirectory,
          updateArgv(
            fixture.repository,
            "--change",
            "HEAD~1..HEAD",
            "--comparison-base",
            root,
            "--revision",
            head,
          ),
        );
        expectSealedAtVersion4(run);
        expectRecorded(run, head);
      } finally {
        await exec("chmod", ["-R", "u+w", fixture.repository]);
      }
    },
    testTimeoutMs(60_000),
  );
});

describe("adding a change or a comparison to a run moves only the request fields it owns", () => {
  it(
    "leaves a comparison run's execution request and commitment unchanged when --change is added",
    async () => {
      const { fixture, root, head } = await changeFixture();
      const comparison = ["--comparison-base", root, "--revision", head];
      const without = await runAdmitted(
        fixture.stateDirectory,
        updateArgv(fixture.repository, "--source", HTML_SOURCE_PATH, ...comparison),
        { binder: "source" },
      );
      const withChange = await runAdmitted(
        fixture.stateDirectory,
        updateArgv(
          fixture.repository,
          "--source",
          HTML_SOURCE_PATH,
          "--change",
          "HEAD~1..HEAD",
          ...comparison,
        ),
      );
      const shape = SHAPE.comparisonWithoutChange;
      expect(Object.keys(without.binding.admittedRequest).sort()).toEqual(shape.keys);
      expect(without.binding.admittedRequest.retryContext).toMatchObject({
        reconstructable: false,
        comparisonRequest: { kind: "base-head", baseRevision: root, headRevision: head },
      });
      expect(withChange.binding.admittedRequest.retryContext).toMatchObject({
        reconstructable: false,
        comparisonRequest: { kind: "base-head", baseRevision: root, headRevision: head },
      });
      expectSealedAt(without, shape.version);
      expectSealedAtVersion4(without);
      expectSealedAtVersion4(withChange);
      // The change enters the binding and the record, never the request: both
      // runs admit the same request and so commit to the same body.
      expect(requestFields(withChange)).toEqual(requestFields(without));
      expect(
        projectSourceRequestContext(
          {
            ...withChange.binding.admittedRequest,
            runId: without.binding.admittedRequest.runId,
            taskLineage: without.binding.admittedRequest.taskLineage,
          },
          resolvedOf(without),
        ),
      ).toBe(without.binding.requestSha256);
      expect(changedSources(withChange.observation)).toEqual(changedSources(without.observation));
      expect(without.saved.changeSources ?? []).toEqual([]);
      expectRecorded(withChange, head);
    },
    testTimeoutMs(120_000),
  );

  it(
    "adds reader evidence to execution input and comparison to retry context",
    async () => {
      const { fixture, root, head } = await changeFixture();
      const change = ["--change", "HEAD~1..HEAD", "--revision", head];
      const changeAlone = await runAdmitted(
        fixture.stateDirectory,
        updateArgv(fixture.repository, ...change),
      );
      expect(changeAlone.parsed.comparisonRequest).toBeUndefined();
      const shape = SHAPE.changeWithoutComparison;
      expect(Object.keys(changeAlone.binding.admittedRequest).sort()).toEqual(shape.keys);
      expect(changeAlone.binding.admittedRequest.retryContext).toMatchObject({
        reconstructable: false,
      });
      expectSealedAt(changeAlone, shape.version);
      expect(changeAlone.observation.admission.comparison).toEqual({ kind: "unknown" });
      expect(changedSources(changeAlone.observation)).toEqual([]);

      const withComparison = await runAdmitted(
        fixture.stateDirectory,
        updateArgv(fixture.repository, ...change, "--comparison-base", root),
      );
      expect(withComparison.binding.admittedRequest.retryContext).toMatchObject({
        reconstructable: false,
        comparisonRequest: { kind: "base-head", baseRevision: root, headRevision: head },
      });
      expectSealedAtVersion4(withComparison);
      expect(requestFields(withComparison)).toEqual({
        ...requestFields(changeAlone),
        readerEvidenceRequest: { comparisonRequest: withComparison.parsed.comparisonRequest },
      });
      expect(changedSources(withComparison.observation)).toEqual([
        "src/export-guide.md",
        "src/export.ts",
      ]);
      expect(expectRecorded(withComparison, head).sourceKind).toBe("local-range");
      expect(changeAlone.saved.changeSources).toEqual(withComparison.saved.changeSources);
    },
    testTimeoutMs(120_000),
  );
});

describe("run parses every change selector beside every comparison option", () => {
  const BASE = ["update-documentation", "--instruction", INSTRUCTION] as const;
  const COMPARISONS = [
    ["--comparison-base", objectId("a"), "--revision", objectId("b")],
    ["--comparison-workspace"],
  ] as const;
  const codeOfParse = (args: readonly string[]) => {
    try {
      parseRunArguments([...args]);
      return undefined;
    } catch (caught) {
      return (caught as { code?: string }).code ?? String(caught);
    }
  };

  it("parses --change of every kind, and run --mr or a GitLab --pr, beside each comparison", () => {
    const selectors = [
      ["--change", "HEAD~1..HEAD", "local-range"],
      ["--change", MR_URL, "gitlab-merge-request"],
      ["--change", `https://github.com/${OWNER}/${NAME}/pull/7`, "github-pull-request"],
      ["--mr", MR_URL, "gitlab-merge-request"],
      ["--pr", MR_URL, "gitlab-merge-request"],
    ] as const;
    for (const comparison of COMPARISONS) {
      for (const [option, value, source] of selectors) {
        const label = `${option} ${value} ${comparison[0]}`;
        expect(codeOfParse([...BASE, option, value, ...comparison]), label).toBeUndefined();
        const parsed = parseRunArguments([...BASE, option, value, ...comparison]);
        expect(parsed.changeSource, label).toMatchObject({ source });
        expect(parsed.comparisonRequest?.kind, label).toBe(
          comparison[0] === "--comparison-base" ? "base-head" : "workspace",
        );
      }
    }
  });

  it("binds a GitHub --pr beside a comparison exactly as it binds it alone", () => {
    // On run, a github.com pull request URL under --pr is the run's change
    // source, so it parses beside a comparison as --change does.
    const pull = `https://github.com/${OWNER}/${NAME}/pull/7`;
    expect(codeOfParse([...BASE, "--pr", pull])).toBeUndefined();
    const alone = parseRunArguments([...BASE, "--pr", pull]).changeSource;
    expect(alone).toMatchObject({ source: "github-pull-request", number: 7 });
    for (const comparison of COMPARISONS) {
      expect(codeOfParse([...BASE, "--pr", pull, ...comparison]), comparison[0]).toBeUndefined();
      const parsed = parseRunArguments([...BASE, "--pr", pull, ...comparison]);
      expect(parsed.changeSource, comparison[0]).toEqual(alone);
      expect(parsed.changeRequestSelector, comparison[0]).toBeUndefined();
      expect(parsed.comparisonRequest?.kind, comparison[0]).toBe(
        comparison[0] === "--comparison-base" ? "base-head" : "workspace",
      );
    }
    // Adjacent: a pull URL on another forge still refuses by its provider, and
    // a GitHub commit URL under --pr by its own code, with or without a comparison.
    const refusals = [
      ["https://gitea.example.test/o/r/pull/3", "unsupported-provider"],
      [
        `https://github.com/${OWNER}/${NAME}/commit/${objectId("c")}`,
        "change-source-github-pr-not-pull-request",
      ],
    ] as const;
    for (const [value, code] of refusals) {
      expect(codeOfParse([...BASE, "--pr", value]), value).toBe(code);
      for (const comparison of COMPARISONS) {
        expect(codeOfParse([...BASE, "--pr", value, ...comparison]), comparison[0]).toBe(code);
      }
    }
  });

  it("parses the comparison alone and the change alone", () => {
    for (const comparison of COMPARISONS) {
      expect(codeOfParse([...BASE, ...comparison]), comparison[0]).toBeUndefined();
      expect(parseRunArguments([...BASE, ...comparison]).changeSource).toBeUndefined();
    }
    for (const selector of [
      ["--change", "HEAD~1..HEAD"],
      ["--mr", MR_URL],
    ]) {
      expect(codeOfParse([...BASE, ...selector]), selector[0]).toBeUndefined();
      expect(parseRunArguments([...BASE, ...selector]).comparisonRequest).toBeUndefined();
    }
  });

  it("still refuses a comparison base that is not a full object id beside a change", () => {
    // The comparison's own grammar is unchanged by sitting beside a change.
    expect(
      codeOfParse([
        ...BASE,
        "--change",
        "HEAD~1..HEAD",
        "--comparison-base",
        "HEAD~1",
        "--revision",
        objectId("b"),
      ]),
    ).toBe(
      "Error: --comparison-base requires both it and --revision to be exact full Git object IDs.",
    );
  });
});

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

/** The reproducible fixture plus a two-commit feature merged into `main` with a merge commit. */
async function mergeRequestFixture() {
  const fixture = await reproducibleFixture();
  const base = fixture.revision;
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
  await fixtureGit(fixture.repository, ["checkout", "-q", "main"]);
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
