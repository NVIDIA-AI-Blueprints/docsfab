// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `docsfab run --change release:<base>..<head>` end to end through
 * `executeRunRequest`: the release is enumerated, re-hashed, bounded and paged
 * before any model call, and its units index and each unit's record and diff
 * join the run's one source binding. Only the model turn is substituted, at
 * the documented harness seam.
 */
import { afterEach, describe, expect, it } from "vitest";

import { executeRunRequest } from "../src/cli/run-request.js";
import { parseRunArguments } from "../src/cli/run-arguments.js";
import {
  resolveCliChangeSource,
  sourceReadBudgetForModel,
} from "../src/cli/run/source-acquisition.js";
import { OperationalLimitError } from "../src/config/limits.js";
import { ChangeSourceError, parseChangeSourceSelector } from "../src/inputs/change-source.js";
import { changeSourceRepositoryPath } from "../src/inputs/change-source/acquisition.js";
import {
  decodeReleaseUnitsIndexV1,
  isResolvedReleaseRange,
  releaseUnitsRepositoryPath,
} from "../src/inputs/change-source/release.js";
import { operatorCodeFailureClass } from "../src/operator/failure-classification.js";
import { prepareRepositoryWorkspace } from "../src/repository/workspace/materialize.js";
import type { RequestIntentInterpreterPort } from "../src/request-intent/interpret.js";
import { runtimeConfig } from "./support/execution-convergence.js";
import {
  createSourceFixture,
  HTML_SOURCE_PATH,
  PAGE_PATH,
  runRequest,
  skillResolver,
  SourceToolHarness,
} from "./support/source-acquisition-cli.js";
import {
  appendPlainCommits,
  commitFiles,
  fixtureGit,
  rewriteLooseObject,
} from "./support/change-source-fixture.js";
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

/** The source fixture plus a tagged release: a plain commit and a merge of two commits. */
async function releaseFixture() {
  const fixture = await createSourceFixture();
  roots.track(fixture.root);
  const { repository } = fixture;
  const base = await fixtureGit(repository, ["rev-parse", "HEAD"]);
  await fixtureGit(repository, ["tag", "-a", "v1.0", "-m", "release v1.0"]);
  const plain = await commitFiles(
    repository,
    { "src/export.ts": "export const requiresOutputPath = true;\n" },
    "Require an explicit export path",
  );
  await fixtureGit(repository, ["checkout", "-q", "-b", "feature"]);
  const side = await commitFiles(
    repository,
    { "src/import.ts": "export const importFormats = ['csv'];\n" },
    "Add CSV import",
  );
  await fixtureGit(repository, ["checkout", "-q", "-"]);
  await fixtureGit(repository, [
    "merge",
    "-q",
    "--no-ff",
    "-m",
    "Merge branch 'feature'",
    "feature",
  ]);
  const merge = await fixtureGit(repository, ["rev-parse", "HEAD"]);
  await fixtureGit(repository, ["tag", "-a", "v1.1", "-m", "release v1.1"]);
  return { fixture, base, plain, side, merge };
}

/** A request-intent port that counts calls: the first model call of a run. */
function countingInterpreter(): { port: RequestIntentInterpreterPort; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    port: {
      async call() {
        calls += 1;
        throw new Error("request-intent model call reached in a pre-model refusal test");
      },
    },
  };
}

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

describe("docsfab run --change release: end to end (row 8)", () => {
  it(
    "binds the units index and every unit's record and diff on a writing run, read and decoded by the model",
    async () => {
      const { fixture, base, plain, side, merge } = await releaseFixture();
      const parsed = parseRunArguments([
        "create-documentation",
        "--repo",
        fixture.repository,
        "--instruction",
        runRequest(fixture).instruction,
        "--allow-write",
        "--patch-only",
        "--change",
        "release:v1.0..v1.1",
      ]);
      const model = new SourceToolHarness({
        readOnSkill: "plan-documentation",
        planSourcePaths: [HTML_SOURCE_PATH],
        readWindowMaxBytes: sourceReadBudgetForModel(undefined).budgetBytes,
      });
      const record = await executeRunRequest(
        { ...parsed, quiet: true },
        runtimeConfig(fixture.stateDirectory),
        { silent: true, executionHarness: model, skillResolver },
      );
      expect(record?.status).toBe("succeeded");
      expect(model.sawReferenceOn).toContain("write-documentation");

      const indexPath = releaseUnitsRepositoryPath(base, merge);
      expect([...model.listedPaths].sort()).toEqual(
        [
          indexPath,
          changeSourceRepositoryPath(plain, "manifest"),
          changeSourceRepositoryPath(plain, "diff"),
          changeSourceRepositoryPath(merge, "manifest"),
          changeSourceRepositoryPath(merge, "diff"),
        ].sort(),
      );
      const texts = readTexts(model);
      const index = decodeReleaseUnitsIndexV1(JSON.parse(texts.get(indexPath)!));
      expect(index.units.map((unit) => [unit.id, unit.kind, unit.evidence.state])).toEqual([
        [plain, "plain", "bound"],
        [merge, "merge", "bound"],
      ]);
      expect(index.units[1]!.introduced).toEqual({
        state: "listed",
        commits: [{ id: side, subject: "Add CSV import" }],
      });
      // The index names each unit record by the digest the record itself carries.
      for (const unit of index.units) {
        const manifest = JSON.parse(texts.get(changeSourceRepositoryPath(unit.id, "manifest"))!);
        expect(unit.evidence).toEqual({
          state: "bound",
          changeSourceSha256: manifest.changeSourceSha256,
        });
        expect(manifest.source).toEqual({ kind: "release-range" });
      }
      const listedIds = new Set(model.listed.map((entry) => entry.observationId));
      expect(listedIds.size).toBe(5);
    },
    testTimeoutMs(120_000),
  );

  it(
    "admits run update-documentation --change release:<base>..<head> and binds the release for its planner",
    async () => {
      const { fixture, base, merge } = await releaseFixture();
      const parsed = parseRunArguments([
        "update-documentation",
        "--repo",
        fixture.repository,
        "--instruction",
        `Update ${PAGE_PATH} for the release.`,
        "--change",
        "release:v1.0..v1.1",
      ]);
      expect(parsed.changeSource).toMatchObject({
        source: "release-range",
        form: "range",
        base: "v1.0",
        head: "v1.1",
      });
      const model = new SourceToolHarness({
        readOnSkill: "plan-documentation",
        planSourcePaths: [HTML_SOURCE_PATH],
      });
      // Read-only, as the plain-range suite runs it: the planner sees the binding.
      await executeRunRequest(
        {
          ...runRequest(fixture),
          workflow: "update-documentation",
          instruction: `Update ${PAGE_PATH} for the release.`,
          allowWrite: false,
          changeSource: parsed.changeSource!,
        },
        runtimeConfig(fixture.stateDirectory),
        {
          silent: true,
          executionHarness: model,
          skillResolver,
        },
      );
      expect(model.calls[0]?.stepId).toBe("plan-documentation");
      expect(model.listedPaths).toContain(releaseUnitsRepositoryPath(base, merge));
      expect(model.listedPaths).toContain(changeSourceRepositoryPath(merge, "diff"));
    },
    testTimeoutMs(120_000),
  );

  it(
    "reports the page, every later unit and its continuation before any model call",
    async () => {
      const { fixture, plain, merge } = await releaseFixture();
      override("DOCSFAB_CHANGE_SOURCES_RELEASE_UNITS_PER_RUN_MAX", 1);
      const workspace = await prepareRepositoryWorkspace(fixture.repository, "HEAD");
      const status: string[] = [];
      try {
        await resolveCliChangeSource({
          workspace,
          selector: parseChangeSourceSelector("release:v1.0..v1.1"),
          onStatus: (line) => status.push(line),
        });
      } finally {
        await workspace.dispose();
      }
      expect(status).toContain(
        `release range continues: 1 unit(s) after this page; run again with --change release:${plain}..${merge} to bind them`,
      );
      expect(status).toContain(`release unit 2 (${merge}) is on a later page`);
    },
    testTimeoutMs(60_000),
  );
});

describe("docsfab run --change release: refuses before any model call", () => {
  it(
    "refuses a tampered tag and the units bound with no request-intent or step call",
    async () => {
      const tagged = await releaseFixture();
      const tag = await fixtureGit(tagged.fixture.repository, ["rev-parse", "v1.0"]);
      await rewriteLooseObject(tagged.fixture.repository, tag, (bytes) =>
        Buffer.from(bytes.toString("latin1").replace("release v1.0", "RELEASE V1.0"), "latin1"),
      );
      const bounded = await releaseFixture();
      const cases = [
        { fixture: tagged.fixture, units: undefined, code: "change-source-integrity-mismatch" },
        { fixture: bounded.fixture, units: 1, code: "change-source-release-units-bound" },
      ] as const;
      for (const { fixture, units, code } of cases) {
        if (units !== undefined) override("DOCSFAB_CHANGE_SOURCES_RELEASE_UNITS_MAX", units);
        const model = new SourceToolHarness({ readOnSkill: null, planSourcePaths: [] });
        const interpreter = countingInterpreter();
        const error = await executeRunRequest(
          {
            ...runRequest(fixture),
            changeSource: parseChangeSourceSelector("release:v1.0..v1.1"),
          },
          runtimeConfig(fixture.stateDirectory),
          {
            silent: true,
            executionHarness: model,
            skillResolver,
            requestInterpreter: interpreter.port,
          },
        ).catch((caught: unknown) => caught);
        expect(error, code).toBeInstanceOf(
          units === undefined ? ChangeSourceError : OperationalLimitError,
        );
        expect((error as { code?: string }).code, code).toBe(code);
        expect(interpreter.calls(), code).toBe(0);
        expect(model.calls, code).toEqual([]);
      }
    },
    testTimeoutMs(120_000),
  );

  it(
    "refuses a full page plus --source files over the binding cap, and admits one file fewer",
    async () => {
      const fixture = await createSourceFixture();
      roots.track(fixture.root);
      await fixtureGit(fixture.repository, ["tag", "base"]);
      await appendPlainCommits(fixture.repository, 127, 2);
      override("DOCSFAB_CHANGE_SOURCES_RELEASE_UNITS_PER_RUN_MAX", 127);
      const selector = parseChangeSourceSelector("release:base..HEAD");
      // Adjacent: 1 index + 2 x 127 units + 1 file is exactly the 256 a binding holds.
      const workspace = await prepareRepositoryWorkspace(fixture.repository, "HEAD");
      try {
        await resolveCliChangeSource({ workspace, selector, besideObservations: 1 });
      } finally {
        await workspace.dispose();
      }
      const model = new SourceToolHarness({ readOnSkill: null, planSourcePaths: [] });
      const interpreter = countingInterpreter();
      const error = await executeRunRequest(
        { ...runRequest(fixture, [HTML_SOURCE_PATH, "docs/guide.md"]), changeSource: selector },
        runtimeConfig(fixture.stateDirectory),
        {
          silent: true,
          executionHarness: model,
          skillResolver,
          requestInterpreter: interpreter.port,
        },
      ).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ChangeSourceError);
      expect((error as ChangeSourceError).code).toBe("change-source-release-observations-exceeded");
      expect((error as ChangeSourceError).detail).toBe(
        "257 observations: 1 units index, 2 for each of 127 units, and 2 --source files, over the 256 one source binding holds",
      );
      expect(interpreter.calls()).toBe(0);
      expect(model.calls).toEqual([]);
    },
    testTimeoutMs(300_000),
  );

  it(
    "refuses a units index over the extraction limit before the request-intent call, while units under it admit",
    async () => {
      const fixture = await createSourceFixture();
      roots.track(fixture.root);
      await fixtureGit(fixture.repository, ["tag", "base"]);
      await appendPlainCommits(fixture.repository, 60, 2);
      const workspace = await prepareRepositoryWorkspace(fixture.repository, "HEAD");
      let limitBytes: number;
      try {
        const clean = await resolveCliChangeSource({
          workspace,
          selector: parseChangeSourceSelector("release:base..HEAD"),
        });
        if (!isResolvedReleaseRange(clean)) throw new Error("expected a release range");
        const shortSelector = parseChangeSourceSelector(
          `release:base..${clean.units[0]!.changeSource.revision.head}`,
        );
        const shortIndex = await resolveCliChangeSource({ workspace, selector: shortSelector });
        if (!isResolvedReleaseRange(shortIndex)) throw new Error("expected a release range");
        // Every unit's record and diff, and a one-unit release's index, sit at
        // the limit or under it; only the whole release's index is over.
        limitBytes = Math.max(
          shortIndex.indexBytes.byteLength,
          ...clean.units.flatMap((unit) => [
            unit.manifestBytes.byteLength,
            unit.diffBytes.byteLength,
          ]),
        );
        expect(clean.indexBytes.byteLength).toBeGreaterThan(2 * limitBytes);
        override("DOCSFAB_SOURCES_EXTRACTION_MAX_DERIVATIVE_BYTES", limitBytes);
        // The per-range diff bounds may not exceed the extraction limit.
        override("DOCSFAB_CHANGE_SOURCES_DIFF_MAX_BYTES", limitBytes);
        override("DOCSFAB_CHANGE_SOURCES_FILE_DIFF_MAX_BYTES", limitBytes);
        // Adjacent: the one-unit release of the same first unit admits.
        const short = await resolveCliChangeSource({ workspace, selector: shortSelector });
        expect(isResolvedReleaseRange(short) && short.units.length).toBe(1);
      } finally {
        await workspace.dispose();
      }
      const model = new SourceToolHarness({
        readOnSkill: null,
        planSourcePaths: [],
      });
      const interpreter = countingInterpreter();
      const error = await executeRunRequest(
        {
          ...runRequest(fixture),
          changeSource: parseChangeSourceSelector("release:base..HEAD"),
        },
        runtimeConfig(fixture.stateDirectory),
        {
          silent: true,
          executionHarness: model,
          skillResolver,
          requestInterpreter: interpreter.port,
        },
      ).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(OperationalLimitError);
      expect(error).toMatchObject({
        limitName: "sources.extractionMaxDerivativeBytes",
        configured: limitBytes,
      });
      expect(interpreter.calls()).toBe(0);
      expect(model.calls).toEqual([]);
    },
    testTimeoutMs(300_000),
  );

  it("classes every release refusal and both release limit refusals", () => {
    expect(operatorCodeFailureClass("change-source-release-form-unsupported")).toBe(
      "operator-input",
    );
    expect(operatorCodeFailureClass("change-source-release-no-units")).toBe("operator-input");
    expect(operatorCodeFailureClass("change-source-release-observations-exceeded")).toBe("bound");
    expect(operatorCodeFailureClass("change-source-release-index-over-read-budget")).toBe("bound");
    expect(operatorCodeFailureClass("change-source-release-units-bound")).toBe("bound");
  });
});
