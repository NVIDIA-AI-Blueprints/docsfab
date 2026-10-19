// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `docsfab run --change` end to end through `executeRunRequest`: the range is
 * resolved before any model call, minted into the run's one source binding,
 * read and cited by the scripted model, and the checkout is left untouched.
 * Only the model turn is substituted, at the documented harness seam.
 */
import { execFile } from "node:child_process";
import { lstat, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  resolveCliChangeSource,
  resolveCliChangeSourceEvidence,
  sourceReadBudgetForModel,
} from "../src/cli/run/source-acquisition.js";
import { prepareRepositoryWorkspace } from "../src/repository/workspace/materialize.js";
import { executeRunRequest } from "../src/cli/run-request.js";
import { parseRunArguments } from "../src/cli/run-arguments.js";
import { OperationalLimitError } from "../src/config/limits.js";
import {
  ChangeSourceError,
  parseChangeSourceSelector,
  type ChangeSourceV1,
} from "../src/inputs/change-source.js";
import {
  CHANGE_SOURCE_DIFF_MEDIA_TYPE,
  changeSourceRepositoryPath,
} from "../src/inputs/change-source/acquisition.js";
import type { RequestIntentInterpreterPort } from "../src/request-intent/interpret.js";
import { runtimeConfig } from "./support/execution-convergence.js";
import {
  createSourceFixture,
  HTML_SOURCE_PATH,
  runRequest,
  skillResolver,
  SourceToolHarness,
} from "./support/source-acquisition-cli.js";
import { commitFiles, fixtureGit, rewriteLooseObject } from "./support/change-source-fixture.js";
import { temporaryRoots } from "./helpers/temp.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";

const roots = temporaryRoots();
const exec = promisify(execFile);

afterEach(() => {
  process.exitCode = undefined;
});

/** The fixture plus one commit the change names, with ids taken as it is built. */
async function changeFixture() {
  const fixture = await createSourceFixture();
  roots.track(fixture.root);
  const base = await fixtureGit(fixture.repository, ["rev-parse", "HEAD"]);
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
  return { fixture, base, before, head };
}

/**
 * The shipped scripted model, citing a span of the diff: the inventory lists
 * observations in id order, so the writer is pointed at the diff explicitly.
 */
class DiffCitingHarness extends SourceToolHarness {
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

async function snapshot(root: string): Promise<Map<string, string>> {
  const entries = new Map<string, string>();
  const walk = async (directory: string): Promise<void> => {
    for (const name of await readdir(directory)) {
      const path = join(directory, name);
      const info = await lstat(path);
      entries.set(relative(root, path), `${info.mode}:${info.size}:${info.mtimeMs}`);
      if (info.isDirectory()) await walk(path);
    }
  };
  await walk(root);
  return entries;
}

describe("docsfab run --change end to end", () => {
  it(
    "binds the diff and manifest, cites the diff, and leaves the checkout untouched",
    async () => {
      const { fixture, before, head } = await changeFixture();
      const model = new DiffCitingHarness({
        readOnSkill: "plan-documentation",
        planSourcePaths: [HTML_SOURCE_PATH],
        readWindowMaxBytes: sourceReadBudgetForModel(undefined).budgetBytes,
      });
      const untouched = await snapshot(fixture.repository);

      const record = await executeRunRequest(
        {
          ...runRequest(fixture),
          changeSource: parseChangeSourceSelector("HEAD~1..HEAD"),
        },
        runtimeConfig(fixture.stateDirectory),
        { silent: true, executionHarness: model, skillResolver },
      );

      expect(record?.status).toBe("succeeded");
      const diffPath = changeSourceRepositoryPath(head, "diff");
      const manifestPath = changeSourceRepositoryPath(head, "manifest");
      expect([...model.listedPaths].sort()).toEqual([diffPath, manifestPath].sort());

      const manifest = JSON.parse(readTexts(model).get(manifestPath)!) as ChangeSourceV1;
      expect(manifest.revision).toMatchObject({ base: before, head });
      expect(manifest.rangeSemantics).toBe("two-dot");
      expect(manifest.commits).toEqual([
        { id: head, parents: [before], subject: "Require an explicit export path" },
      ]);
      expect(
        manifest.files.map((file) => [
          file.status,
          file.oldPath,
          file.newPath,
          file.added,
          file.removed,
        ]),
      ).toEqual([
        ["R", "src/export-notes.md", "src/export-guide.md", 0, 0],
        ["A", null, "src/export.ts", 1, 0],
      ]);
      const diffLines = readTexts(model).get(diffPath)!.split("\n");
      expect(diffLines).toContain("rename from src/export-notes.md");
      expect(diffLines).toContain("rename to src/export-guide.md");
      expect(diffLines).toContain("+export const requiresOutputPath = true;");
      // The diff extracts through the unified diff adapter: a manifest first,
      // then file and hunk spans whose locators name their ordinals.
      const diffLocators = model.listed
        .filter((entry) => entry.repositoryPath === diffPath)
        .map((entry) => entry.locator);
      expect(diffLocators.every((locator) => locator.kind === "diff")).toBe(true);
      expect(
        diffLocators.map((locator) =>
          locator.kind === "diff"
            ? [locator.part, locator.fileOrdinal, locator.hunkOrdinal, locator.newPath]
            : [],
        ),
      ).toEqual([
        ["manifest", null, null, null],
        ["file", 1, null, "src/export-guide.md"],
        ["header", 2, null, "src/export.ts"],
        ["hunk", 2, 1, "src/export.ts"],
      ]);
      expect(diffLines[0]).toBe("diff manifest: 2 files, 1 hunk, +1 -0 lines");

      // The writer's citation names the diff observation, not merely the binding.
      const diffObservation = model.listed.find((entry) => entry.repositoryPath === diffPath)!;
      const citations = record!.sourceCitations!.steps.flatMap((step) => step.citations);
      expect(citations.map((citation) => citation.observationId)).toEqual([
        diffObservation.observationId,
      ]);

      // Read-only: every path, size and mtime under the checkout, .git included.
      // The one exception predates --change: delivery's freshness check runs
      // `git status`, which refreshes the index's stat cache; a run without
      // --change rewrites it the same way. The change-source path alone is
      // held to an exact snapshot in the next test.
      const after = await snapshot(fixture.repository);
      const changed = [...new Set([...after.keys(), ...untouched.keys()])].filter(
        (key) => after.get(key) !== untouched.get(key),
      );
      expect(changed.filter((key) => key !== ".git" && key !== join(".git", "index"))).toEqual([]);
      expect([...untouched.keys()].some((path) => path.endsWith("index.lock"))).toBe(false);
    },
    testTimeoutMs(60_000),
  );

  it(
    "resolves and binds the change without writing anything under the checkout",
    async () => {
      const { fixture } = await changeFixture();
      const untouched = await snapshot(fixture.repository);
      const workspace = await prepareRepositoryWorkspace(fixture.repository, "HEAD");
      try {
        const resolved = await resolveCliChangeSource({
          workspace,
          selector: parseChangeSourceSelector("HEAD~1..HEAD"),
        });
        const evidence = await resolveCliChangeSourceEvidence({
          workspace,
          resolved,
          admittedRequest: { workflow: "create-documentation", allowWrite: true },
          runId: "change-source-read-only",
        });
        expect(evidence.acquired.binding.requiredObservationIds).toHaveLength(2);
      } finally {
        await workspace.dispose();
      }
      expect(await snapshot(fixture.repository)).toEqual(untouched);
    },
    testTimeoutMs(60_000),
  );

  it.skipIf(process.getuid?.() === 0)(
    "runs end to end from a checkout whose files are all read-only",
    async () => {
      const { fixture, head } = await changeFixture();
      await exec("chmod", ["-R", "a-w", fixture.repository]);
      try {
        const model = new SourceToolHarness({
          readOnSkill: "plan-documentation",
          planSourcePaths: [HTML_SOURCE_PATH],
        });
        const record = await executeRunRequest(
          { ...runRequest(fixture), changeSource: parseChangeSourceSelector("HEAD~1..HEAD") },
          runtimeConfig(fixture.stateDirectory),
          { silent: true, executionHarness: model, skillResolver },
        );
        expect(record?.status).toBe("succeeded");
        expect(model.listedPaths).toContain(changeSourceRepositoryPath(head, "diff"));
      } finally {
        await exec("chmod", ["-R", "u+w", fixture.repository]);
      }
    },
    testTimeoutMs(60_000),
  );

  it(
    "mints a run id for the binding when nothing earlier in the run did",
    async () => {
      // A read-only update skips the first pass, the only earlier place a run
      // id is minted, so the change itself must ask for one.
      const { fixture, head } = await changeFixture();
      const model = new SourceToolHarness({
        readOnSkill: "plan-documentation",
        planSourcePaths: [HTML_SOURCE_PATH],
      });
      await executeRunRequest(
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
      expect(model.calls[0]?.stepId).toBe("plan-documentation");
      expect([...model.listedPaths].sort()).toEqual(
        [
          changeSourceRepositoryPath(head, "diff"),
          changeSourceRepositoryPath(head, "manifest"),
        ].sort(),
      );
    },
    testTimeoutMs(60_000),
  );

  it(
    "joins --source files into the same binding beside the change",
    async () => {
      const { fixture, head } = await changeFixture();
      const model = new SourceToolHarness({
        readOnSkill: "plan-documentation",
        planSourcePaths: [HTML_SOURCE_PATH],
      });
      const record = await executeRunRequest(
        {
          ...runRequest(fixture, [HTML_SOURCE_PATH]),
          changeSource: parseChangeSourceSelector("HEAD~1..HEAD"),
        },
        runtimeConfig(fixture.stateDirectory),
        { silent: true, executionHarness: model, skillResolver },
      );
      expect(record?.status).toBe("succeeded");
      expect([...model.listedPaths].sort()).toEqual(
        [
          changeSourceRepositoryPath(head, "diff"),
          changeSourceRepositoryPath(head, "manifest"),
          HTML_SOURCE_PATH,
        ].sort(),
      );
    },
    testTimeoutMs(60_000),
  );

  it(
    "admits --change beside an explicit full --revision with no projection refusal",
    async () => {
      const { fixture, head } = await changeFixture();
      const parsed = parseRunArguments([
        "create-documentation",
        "--repo",
        fixture.repository,
        "--instruction",
        runRequest(fixture).instruction,
        "--allow-write",
        "--patch-only",
        "--change",
        "HEAD~1..HEAD",
        "--revision",
        head,
      ]);
      const model = new SourceToolHarness({
        readOnSkill: "plan-documentation",
        planSourcePaths: [HTML_SOURCE_PATH],
      });
      const record = await executeRunRequest(
        { ...parsed, quiet: true },
        runtimeConfig(fixture.stateDirectory),
        { silent: true, executionHarness: model, skillResolver },
      );
      expect(record?.status).toBe("succeeded");
      expect(record?.repository.revision).toBe(head);
      expect(model.sawReferenceOn).toContain("write-documentation");
    },
    testTimeoutMs(60_000),
  );
});

describe("docsfab run --change refuses before any model call", () => {
  it("prints a required-check isolation PREFLIGHT warning before the first provider call", async () => {
    const fixture = await createSourceFixture();
    roots.track(fixture.root);
    await commitFiles(
      fixture.repository,
      { "AGENTS.md": "Run `npm test` before proposing a documentation change.\n" },
      "require validation",
    );
    const lines: string[] = [];
    const stderr = vi.spyOn(console, "error").mockImplementation((message) => {
      lines.push(String(message));
    });
    let providerCalls = 0;
    try {
      await executeRunRequest(runRequest(fixture), runtimeConfig(fixture.stateDirectory), {
        json: true,
        probeRequiredCheckReadiness: async () => ({
          code: "required-check-isolation-unavailable",
          explanation: "The isolated check backend is unavailable.",
          nextCommand: "Enable the isolated check backend.",
        }),
        requestInterpreter: {
          async call() {
            providerCalls += 1;
            expect(
              lines.some((line) => line.includes("PREFLIGHT required-check-isolation-unavailable")),
            ).toBe(true);
            throw new Error("provider stub stopped after checking preflight order");
          },
        },
      });
    } catch (error) {
      expect(String(error)).toContain("provider stub stopped");
    } finally {
      stderr.mockRestore();
    }
    expect(providerCalls).toBe(1);
    expect(
      lines.some((line) => line.includes("PREFLIGHT required-check-isolation-unavailable")),
    ).toBe(true);
  });

  it(
    "refuses missing history, an unresolved name, and a tampered interior commit with no request-intent or step call",
    async () => {
      const { fixture, before } = await changeFixture();
      const shallow = join(fixture.root, "shallow");
      await fixtureGit(fixture.root, [
        "clone",
        "-q",
        "--depth=1",
        `file://${fixture.repository}`,
        shallow,
      ]);
      const tampered = await createSourceFixture();
      roots.track(tampered.root);
      const interior = await commitFiles(tampered.repository, { "src/a.md": "one\n" }, "interior");
      await commitFiles(tampered.repository, { "src/a.md": "two\n" }, "head");
      await rewriteLooseObject(tampered.repository, interior, (body) =>
        Buffer.from(body.toString("latin1").replace("interior", "INTERIOR"), "latin1"),
      );
      const cases = [
        {
          repository: shallow,
          selector: "HEAD~1..HEAD",
          code: "change-source-history-unavailable",
        },
        // The adjacent case: a name that does not exist is never missing history.
        {
          repository: shallow,
          selector: "no-such-branch..HEAD",
          code: "change-source-revision-unresolved",
        },
        {
          repository: fixture.repository,
          selector: `${before}..no-such-branch`,
          code: "change-source-revision-unresolved",
        },
        {
          repository: tampered.repository,
          selector: "HEAD~2..HEAD",
          code: "change-source-integrity-mismatch",
        },
      ] as const;
      for (const { repository, selector, code } of cases) {
        const model = new SourceToolHarness({ readOnSkill: null, planSourcePaths: [] });
        const interpreter = countingInterpreter();
        const error = await executeRunRequest(
          { ...runRequest({ repository }), changeSource: parseChangeSourceSelector(selector) },
          runtimeConfig(fixture.stateDirectory),
          {
            silent: true,
            executionHarness: model,
            skillResolver,
            requestInterpreter: interpreter.port,
          },
        ).catch((caught: unknown) => caught);
        expect(error, selector).toBeInstanceOf(ChangeSourceError);
        expect((error as ChangeSourceError).code, selector).toBe(code);
        expect(interpreter.calls()).toBe(0);
        expect(model.calls).toEqual([]);
      }
    },
    testTimeoutMs(60_000),
  );

  it(
    "refuses a manifest over the extraction limit with no request-intent or step call",
    async () => {
      const { fixture } = await changeFixture();
      const selector = parseChangeSourceSelector("HEAD~1..HEAD");
      const workspace = await prepareRepositoryWorkspace(fixture.repository, "HEAD");
      const clean = await resolveCliChangeSource({ workspace, selector }).finally(() =>
        workspace.dispose(),
      );
      const manifest = clean.manifestBytes.byteLength;
      const overrides = {
        DOCSFAB_CHANGE_SOURCES_DIFF_MAX_BYTES: clean.diffBytes.byteLength,
        DOCSFAB_CHANGE_SOURCES_FILE_DIFF_MAX_BYTES: clean.diffBytes.byteLength,
        DOCSFAB_SOURCES_EXTRACTION_MAX_DERIVATIVE_BYTES: manifest - 1,
      };
      const prior = Object.keys(overrides).map((name) => [name, process.env[name]] as const);
      for (const [name, value] of Object.entries(overrides)) process.env[name] = String(value);
      try {
        const model = new SourceToolHarness({ readOnSkill: null, planSourcePaths: [] });
        const interpreter = countingInterpreter();
        const error = await executeRunRequest(
          { ...runRequest(fixture), changeSource: selector },
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
          code: "sources-extraction-max-derivative-bytes-bound",
          observed: manifest,
        });
        expect(interpreter.calls()).toBe(0);
        expect(model.calls).toEqual([]);
      } finally {
        for (const [name, value] of prior) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
      }
    },
    testTimeoutMs(60_000),
  );

  it(
    "lets the workspace configuration refusal for a diff driver fire first",
    async () => {
      const { fixture } = await changeFixture();
      await fixtureGit(fixture.repository, ["config", "diff.marked.textconv", "sed s/^/X/"]);
      const model = new SourceToolHarness({ readOnSkill: null, planSourcePaths: [] });
      const error = (await executeRunRequest(
        { ...runRequest(fixture), changeSource: parseChangeSourceSelector("HEAD~1..HEAD") },
        runtimeConfig(fixture.stateDirectory),
        { silent: true, executionHarness: model, skillResolver },
      ).catch((caught: unknown) => caught)) as { code?: string };
      expect(error.code).toBe("diff-named-driver");
      expect(model.calls).toEqual([]);
    },
    testTimeoutMs(60_000),
  );
});

describe("bin/docsfab.mjs run --change", () => {
  it(
    "parses --change at the shipped entry point and refuses bad grammar there with its code",
    async () => {
      const bin = join(import.meta.dirname, "..", "bin", "docsfab.mjs");
      const environment = {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: process.env.HOME ?? "/tmp",
        XDG_CONFIG_HOME: await roots.create("docsfab-change-xdg-"),
        DOCSFAB_CONFIG_ROOT: await roots.create("docsfab-change-config-"),
      };
      const refused = await exec(
        process.execPath,
        [
          bin,
          "run",
          "update-documentation",
          "--instruction",
          "Update the guide.",
          "--change",
          "HEAD^!",
          "--json",
        ],
        { env: environment },
      ).then(
        () => undefined,
        (caught: { stdout: string; stderr: string; code: number }) => caught,
      );
      expect(refused?.code).not.toBe(0);
      expect(`${refused?.stdout}${refused?.stderr}`).toContain("change-source-selector-grammar");
    },
    testTimeoutMs(60_000),
  );
});
