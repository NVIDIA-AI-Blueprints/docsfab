// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Every local run keeps its plan inside the documentation write roots. Through
 * the real CLI run (a scripted request interpretation, first-pass binding, and
 * runner plan admission) a scripted planner that names a page outside the
 * roots is refused before any write step, whatever the run: an advisory, an
 * admitted, or an uninterpreted update, and an admitted restructure. Pages
 * inside the roots go on. The pages a request names are the least its plan
 * addresses (the RL-1 shape delivers), and a tracked file listed in
 * `documentationRoots` grants exactly that file (the DR-2 and DD-2 shapes).
 */
import { access, mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { handleDoCommand } from "../src/cli/commands/do.js";
import { createKnowledgeAcceptedSnapshot } from "../src/canon/from-knowledge-snapshot.js";
import { executeRunRequest } from "../src/cli/run-request.js";
import type { AgentHarness, HarnessStepInput } from "../src/execution/contracts.js";
import { observeReaderTaskContextAdmissionV1 } from "../src/execution/reader-task-admission.js";
import { buildHostStepPrompt } from "../src/harness/pi.js";
import { readRunFailure } from "../src/operator/failure-classification.js";
import { buildRunHumanNextCommand } from "../src/operator/run-summary.js";
import type { RunRecord } from "../src/records/contracts.js";
import type {
  RequestIntentInterpreterCall,
  RequestIntentInterpreterPort,
} from "../src/request-intent/interpret.js";
import {
  documentationPlanBindingDigest,
  OmittedFirstPassTargetError,
  PLAN_OUTSIDE_WRITE_ROOTS_CODE,
  PLAN_TARGET_NOT_WRITABLE_CODE,
  PlanWriteScopeError,
  type PlanWriteRefusal,
} from "../src/workflow-execution/plan-binding.js";
import { EditorialProtocolHarness } from "./helpers/editorial-protocol-harness.js";
import { commitFixture, initFixtureRepo } from "./helpers/git.js";
import {
  orbitOptionChangeRepository,
  orbitReaderContextInput,
} from "./helpers/orbit-option-change-fixture.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";
import { verificationFixture } from "./helpers/verification.js";
import { runtimeConfig } from "./support/execution-convergence.js";

const RUN_BUDGET = { timeout: testTimeoutMs(60_000) };
const DEFAULT_ROOTS = ["docs/", "fern/"];
/**
 * Planned writes outside the default roots and why each is refused: agent
 * instruction and source files no root admits, a Markdown page a root could
 * hold, and an OpenAPI spec under docs/ that is not a page at all (#2043).
 */
const REFUSAL: Readonly<Record<string, PlanWriteRefusal>> = {
  "AGENTS.md": "protected",
  "CLAUDE.md": "protected",
  "src/notes.md": "protected",
  "src/README.md": "protected",
  "notes/guide.md": "outside-roots",
  "docs/open-api/owners.yaml": "not-a-page",
  "CONTRIBUTING.md": "outside-roots",
  "demo/x/OTHER.md": "outside-roots",
  "docs/guide.md": "outside-roots",
  "fern/docs.yml": "not-a-page",
  "fern/other.yml": "not-a-page",
};
const OUTSIDE = [
  "AGENTS.md",
  "CLAUDE.md",
  "src/notes.md",
  "notes/guide.md",
  "docs/open-api/owners.yaml",
] as const;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  process.exitCode = undefined;
  vi.unstubAllEnvs();
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

/** Pages every update fixture tracks, inside and outside the default roots. */
const PAGES: Readonly<Record<string, string>> = {
  "docs/guide.md": "# Guide\n\nRun Orbit with --old.\n",
  "docs/reference.md": "# Reference\n\nThe option is --old.\n",
  "AGENTS.md": "# Agents\n",
  "CLAUDE.md": "# Claude\n",
  "src/notes.md": "# Notes\n",
  "notes/guide.md": "# Notes guide\n",
  "docs/open-api/owners.yaml": "openapi: 3.0.0\n",
};

type PlannedPage = { readonly path: string; readonly disposition: "update" | "retain" };

function stubPort(reply: Record<string, unknown>): RequestIntentInterpreterPort & {
  readonly calls: RequestIntentInterpreterCall[];
} {
  const calls: RequestIntentInterpreterCall[] = [];
  const text = JSON.stringify({
    authorityPreference: { preference: "unspecified", quote: null },
    targets: [],
    ...reply,
  });
  return {
    calls,
    async call(request) {
      calls.push(request);
      return { text, usage: { inputTokens: 3, outputTokens: 2 } };
    },
  };
}

/** A reading that names `paths` as write targets, each quoted by its own path. */
function namedReading(operation: string, paths: readonly string[]): Record<string, unknown> {
  return {
    operation,
    targets: paths.map((path) => ({ path, role: "write", chosenFrom: "named", quote: path })),
  };
}

async function updateFixture(
  name: string,
  options: {
    readonly files?: Readonly<Record<string, string>>;
    readonly links?: Readonly<Record<string, string>>;
    readonly documentationRoots?: readonly string[];
  } = {},
) {
  const fixture = await orbitOptionChangeRepository(
    `docsfab-plan-scope-${name}`,
    temporaryDirectories,
    {
      files: { ...PAGES, ...options.files },
      ...(options.links ? { links: options.links } : {}),
      ...(options.documentationRoots ? { documentationRoots: options.documentationRoots } : {}),
    },
  );
  const observation = await observeReaderTaskContextAdmissionV1({
    repositoryPath: fixture.repository,
    revision: fixture.head,
    observationMode: "workflow-export",
    readerContextInput: orbitReaderContextInput(),
    comparisonRequest: {
      kind: "base-head",
      baseRevision: fixture.base,
      headRevision: fixture.head,
    },
    sourceHints: [{ role: "public-contract", path: "src/orbit.ts" }],
  });
  const publicContract = observation.admission.sources.find(
    (source) => source.role === "public-contract",
  );
  if (!publicContract) throw new Error("fixture public contract was not admitted");
  return { ...fixture, impactSource: { uri: publicContract.uri, sha256: publicContract.sha256 } };
}

type UpdateFixture = Awaited<ReturnType<typeof updateFixture>>;

/** The run request `docsfab run update-documentation` builds for `instruction`. */
function updateRequest(fixture: UpdateFixture, instruction: string) {
  return {
    workflow: "update-documentation" as const,
    repositoryPath: fixture.repository,
    revision: fixture.head,
    instruction,
    comparisonRequest: {
      kind: "base-head" as const,
      baseRevision: fixture.base,
      headRevision: fixture.head,
    },
    readerSources: [{ role: "public-contract" as const, path: "src/orbit.ts" }],
    canonSnapshotPath: fixture.canonSnapshotPath,
    allowWrite: true,
    releaseGate: false,
    verbose: false,
    json: false,
    showScan: false,
  };
}

/**
 * One update-documentation run with the reading and the planner's pages
 * scripted. Without a reading the run is not interpreted (`PI_OFFLINE=1`).
 */
async function updateRun(input: {
  readonly fixture: UpdateFixture;
  readonly instruction: string;
  readonly reading?: Record<string, unknown>;
  readonly plannerPages?: readonly PlannedPage[];
  readonly writePlannedPages?: boolean;
}) {
  const harness = new EditorialProtocolHarness({
    candidate: "update",
    impactSource: input.fixture.impactSource,
    ...(input.plannerPages ? { plannerPages: input.plannerPages } : {}),
    ...(input.writePlannedPages ? { writePlannedPages: true } : {}),
  });
  if (!input.reading) vi.stubEnv("PI_OFFLINE", "1");
  const port = input.reading ? stubPort(input.reading) : undefined;
  let error: unknown;
  let record: RunRecord | undefined;
  try {
    record = await executeRunRequest(
      updateRequest(input.fixture, input.instruction),
      input.fixture.config,
      { silent: true, harness, ...(port ? { requestInterpreter: port } : {}) },
    );
  } catch (thrown) {
    error = thrown;
  }
  return { harness, port, record, error };
}

/** Plan admission did not refuse the plan for its write scope, by either code. */
function expectNotScopeRefused(record: RunRecord): void {
  expect([PLAN_OUTSIDE_WRITE_ROOTS_CODE, PLAN_TARGET_NOT_WRITABLE_CODE]).not.toContain(
    readRunFailure(record)?.code,
  );
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

/**
 * Refused at plan admission, before any write step, with the code and its
 * NEXT. A path alone takes its refusal from `REFUSAL`.
 */
function expectRefusedBeforeWriting(
  run: { readonly record?: RunRecord; readonly harness: { readonly stepIds: string[] } },
  outside: readonly (string | { readonly path: string; readonly refusal: PlanWriteRefusal })[],
  roots: readonly string[],
  stateDirectory: string,
): void {
  expect(run.record?.status, JSON.stringify(run.record?.error)).toBe("failed");
  const planStep = run.record?.steps.find((step) => step.skill === "plan-documentation");
  const error = new PlanWriteScopeError(
    outside.map((entry) =>
      typeof entry === "string" ? { path: entry, refusal: REFUSAL[entry]! } : entry,
    ),
    roots,
  );
  expect(planStep?.error).toBe(error.message);
  expect(readRunFailure(run.record!)).toMatchObject({
    class: "planning-refusal",
    code: error.code,
  });
  // Nothing after the planner ran, and nothing was written.
  expect(run.harness.stepIds.at(-1)).toBe("plan-documentation");
  expect(run.harness.stepIds).not.toContain("write-documentation");
  expect(run.record?.changes?.files ?? []).toEqual([]);
  // A restructure's collector records the empty patch it found.
  expect(run.record?.changes?.patch?.byteLength ?? 0).toBe(0);
  // NEXT gives the remedy that can work, and it is never doctor: a root for a
  // page outside the roots, never a root for a file no root admits.
  const next = buildRunHumanNextCommand({
    record: run.record!,
    recordPath: join(stateDirectory, `${run.record!.id}.json`),
    exitCode: 1,
  });
  expect(next?.command).not.toContain("doctor");
  if (error.code === PLAN_OUTSIDE_WRITE_ROOTS_CODE) {
    expect(next?.reason).toContain("documentationRoots in .docsfab.json");
  } else {
    expect(error.code).toBe(PLAN_TARGET_NOT_WRITABLE_CODE);
    expect(next?.reason).toContain("Make that change by hand");
    expect(next?.reason).not.toContain("documentationRoots");
  }
}

describe("every update run keeps its plan inside the documentation write roots", () => {
  it.each([
    [
      "an advisory review reading that cites AGENTS.md only as a source",
      "Review AGENTS.md and fix whatever is stale.",
      { operation: "review", sources: [{ path: "AGENTS.md", quote: "AGENTS.md" }] },
      "AGENTS.md",
    ],
    [
      "an advisory review reading with no target",
      "Review AGENTS.md and fix whatever is stale.",
      { operation: "review" },
      "AGENTS.md",
    ],
    [
      "an advisory update reading with no target",
      "Fix whatever is stale in src/notes.md.",
      { operation: "update" },
      "src/notes.md",
    ],
    [
      "an advisory restructure reading with no target",
      "Restructure src/notes.md so the notes read in order.",
      { operation: "restructure" },
      "src/notes.md",
    ],
  ])(
    "refuses %s when the planner writes a page outside the roots",
    RUN_BUDGET,
    async (_name, instruction, reading, plannedPath) => {
      const fixture = await updateFixture("advisory");
      const run = await updateRun({
        fixture,
        instruction,
        reading,
        plannerPages: [{ path: plannedPath, disposition: "update" }],
      });
      expect(run.error).toBeUndefined();
      expect(run.record?.requestIntent?.admission.outcome).toBe("advisory");
      expectRefusedBeforeWriting(run, [plannedPath], DEFAULT_ROOTS, fixture.config.stateDirectory);
      expect(await readFile(join(fixture.repository, plannedPath), "utf8")).toBe(
        PAGES[plannedPath],
      );
    },
  );

  it.each(OUTSIDE)(
    "refuses an admitted update whose plan adds %s to the named page",
    RUN_BUDGET,
    async (outside) => {
      const fixture = await updateFixture("admitted");
      const run = await updateRun({
        fixture,
        instruction: "Bring docs/cli.md up to date with the new option.",
        reading: namedReading("update", ["docs/cli.md"]),
        plannerPages: [
          { path: "docs/cli.md", disposition: "update" },
          { path: outside, disposition: "update" },
        ],
      });
      expect(run.error).toBeUndefined();
      expect(run.record?.requestIntent?.admission.outcome).toBe("admitted");
      expectRefusedBeforeWriting(run, [outside], DEFAULT_ROOTS, fixture.config.stateDirectory);
    },
  );

  it.each(OUTSIDE)(
    "refuses an uninterpreted (offline) update whose planner writes %s",
    RUN_BUDGET,
    async (outside) => {
      const fixture = await updateFixture("offline");
      const run = await updateRun({
        fixture,
        instruction: "Fix whatever is stale in the documentation.",
        plannerPages: [{ path: outside, disposition: "update" }],
      });
      expect(run.error).toBeUndefined();
      expect(run.record?.requestIntent?.admission).toMatchObject({
        outcome: "offline",
        reason: "pi-offline",
      });
      expectRefusedBeforeWriting(run, [outside], DEFAULT_ROOTS, fixture.config.stateDirectory);
    },
  );

  it.each([
    ["an advisory", { operation: "update" }],
    ["an admitted", namedReading("update", ["docs/cli.md"])],
    ["an uninterpreted", undefined],
  ] as const)(
    "lets %s update whose plan keeps to the roots go past plan admission (control)",
    RUN_BUDGET,
    async (_name, reading) => {
      const fixture = await updateFixture("in-root");
      const run = await updateRun({
        fixture,
        instruction: "Bring docs/cli.md up to date with the new option.",
        ...(reading ? { reading } : {}),
        plannerPages: [
          { path: "docs/cli.md", disposition: "update" },
          { path: "docs/guide.md", disposition: "update" },
        ],
      });
      expect(run.error).toBeUndefined();
      expectNotScopeRefused(run.record!);
      expect(run.record?.steps[0]?.planBinding?.pages.map((page) => page.path)).toEqual([
        "docs/cli.md",
        "docs/guide.md",
      ]);
      expect(run.harness.stepIds.length).toBeGreaterThan(1);
    },
  );
});

// ---------------------------------------------------------------------------
// #2037: the pages a request names are a minimum, not a ceiling.

const RL1_INSTRUCTION =
  "Update docs/cli.md and docs/guide.md for the new --new option, and correct any other page that the change makes out of date.";
const RL1_READING = namedReading("update", ["docs/cli.md", "docs/guide.md"]);

describe("named pages are the least an update plan addresses (the RL-1 shape)", () => {
  it(
    "delivers a run update-documentation whose plan adds a page inside the roots",
    RUN_BUDGET,
    async () => {
      const fixture = await updateFixture("rl1-run");
      const run = await updateRun({
        fixture,
        instruction: RL1_INSTRUCTION,
        reading: RL1_READING,
        plannerPages: [
          { path: "docs/cli.md", disposition: "update" },
          { path: "docs/guide.md", disposition: "update" },
          { path: "docs/reference.md", disposition: "update" },
        ],
        writePlannedPages: true,
      });
      expect(run.error).toBeUndefined();
      expect(run.record?.requestIntent?.admission.outcome).toBe("admitted");
      expect(run.record?.status, JSON.stringify(run.record?.error)).toBe("succeeded");
      expect(run.record?.changes?.files).toEqual([
        { path: "docs/cli.md", status: "modified" },
        { path: "docs/guide.md", status: "modified" },
        { path: "docs/reference.md", status: "modified" },
      ]);
    },
  );

  it("delivers it through docsfab do; --canon-snapshot skips first pass", RUN_BUDGET, async () => {
    const fixture = await updateFixture("rl1-do");
    const harness = new EditorialProtocolHarness({
      candidate: "update",
      impactSource: fixture.impactSource,
      plannerPages: [
        { path: "docs/cli.md", disposition: "update" },
        { path: "docs/guide.md", disposition: "update" },
        { path: "docs/reference.md", disposition: "update" },
      ],
      writePlannedPages: true,
    });
    const routed: string[] = [];
    let record: RunRecord | undefined;
    await handleDoCommand(
      [RL1_INSTRUCTION, "--repo", fixture.repository, "--patch-only", "--quiet"],
      {
        stateDirectory: fixture.config.stateDirectory,
        admitCatalogWorkflow: async () => "update-documentation",
        runWorkflow: async (request) => {
          routed.push(request.workflow);
          // The same evidence `run` binds above, so only the entry differs.
          const {
            workflow: _workflow,
            instruction: _instruction,
            ...bound
          } = updateRequest(fixture, RL1_INSTRUCTION);
          record = await executeRunRequest({ ...request, ...bound }, fixture.config, {
            silent: true,
            harness,
            requestInterpreter: stubPort(RL1_READING),
          });
          return record;
        },
      },
    );
    expect(routed).toEqual(["update-documentation"]);
    expect(record?.status, JSON.stringify(record?.error)).toBe("succeeded");
    expect(record?.changes?.files?.map((file) => file.path)).toEqual([
      "docs/cli.md",
      "docs/guide.md",
      "docs/reference.md",
    ]);
  });

  it("still refuses a plan that leaves a named page unaddressed", RUN_BUDGET, async () => {
    const fixture = await updateFixture("rl1-omitted");
    const run = await updateRun({
      fixture,
      instruction: RL1_INSTRUCTION,
      reading: RL1_READING,
      plannerPages: [
        { path: "docs/cli.md", disposition: "update" },
        { path: "docs/reference.md", disposition: "update" },
      ],
    });
    expect(run.record?.status).toBe("failed");
    expect(run.record?.steps[0]?.error).toBe(
      new OmittedFirstPassTargetError(["docs/guide.md"], "update").message,
    );
    expect(readRunFailure(run.record!)).toMatchObject({
      class: "planning-refusal",
      code: "omitted-mandatory-obligation",
    });
    expect(run.harness.stepIds).toEqual(["plan-documentation"]);
  });

  it("refuses, with a code, a plan that adds a page outside the roots", RUN_BUDGET, async () => {
    const fixture = await updateFixture("rl1-outside");
    const run = await updateRun({
      fixture,
      instruction: RL1_INSTRUCTION,
      reading: RL1_READING,
      plannerPages: [
        { path: "docs/cli.md", disposition: "update" },
        { path: "docs/guide.md", disposition: "update" },
        { path: "notes/guide.md", disposition: "update" },
      ],
    });
    expectRefusedBeforeWriting(
      run,
      ["notes/guide.md"],
      DEFAULT_ROOTS,
      fixture.config.stateDirectory,
    );
  });
});

// ---------------------------------------------------------------------------
// Decision A: a tracked file listed in documentationRoots grants exactly it.

const DR2_ROOTS = ["README.md", "RELEASE.md", "demo/x/README.md", "tests/bats/README.md"];
const DR2_FILES: Readonly<Record<string, string>> = {
  "README.md": "# Orbit\n\nUse --old.\n",
  "RELEASE.md": "# Release\n\nShips --old.\n",
  "CONTRIBUTING.md": "# Contributing\n",
  "demo/x/README.md": "# Demo\n\nRun with --old.\n",
  "demo/x/OTHER.md": "# Other demo\n",
  "tests/bats/README.md": "# Bats\n\nTests --old.\n",
};

describe("a tracked file root grants exactly that file through the real run", () => {
  it(
    "delivers an update of README.md, RELEASE.md, demo/x/README.md and tests/bats/README.md as file roots",
    RUN_BUDGET,
    async () => {
      const fixture = await updateFixture("dr2", {
        files: DR2_FILES,
        documentationRoots: DR2_ROOTS,
      });
      const run = await updateRun({
        fixture,
        instruction: `Update ${DR2_ROOTS.join(", ")} for the new --new option.`,
        reading: namedReading("update", DR2_ROOTS),
        plannerPages: DR2_ROOTS.map((path) => ({ path, disposition: "update" as const })),
        writePlannedPages: true,
      });
      expect(run.error).toBeUndefined();
      expect(run.record?.requestIntent?.admission.outcome).toBe("admitted");
      expect(run.record?.status, JSON.stringify(run.record?.error)).toBe("succeeded");
      expect(run.record?.changes?.files?.map((file) => file.path)).toEqual([...DR2_ROOTS].sort());
    },
  );

  it.each([
    ["a tracked sibling", "CONTRIBUTING.md"],
    ["a sibling in a file root's directory", "demo/x/OTHER.md"],
    ["a default root a configured list replaces", "docs/guide.md"],
  ])("refuses a plan that adds %s, %s, to the file roots", RUN_BUDGET, async (_name, extra) => {
    const fixture = await updateFixture("dr2-outside", {
      files: DR2_FILES,
      documentationRoots: DR2_ROOTS,
    });
    const run = await updateRun({
      fixture,
      instruction: "Update README.md for the new --new option.",
      reading: namedReading("update", ["README.md"]),
      plannerPages: [
        { path: "README.md", disposition: "update" },
        { path: extra, disposition: "update" },
      ],
    });
    expectRefusedBeforeWriting(run, [extra], [...DR2_ROOTS].sort(), fixture.config.stateDirectory);
  });

  it("keeps an agent instruction or source file listed as a root refused", RUN_BUDGET, async () => {
    const fixture = await updateFixture("dr2-protected", {
      files: { ...DR2_FILES, "src/README.md": "# Source\n" },
      documentationRoots: ["README.md", "AGENTS.md", "src/README.md"],
    });
    const run = await updateRun({
      fixture,
      instruction: "Update README.md for the new --new option.",
      reading: namedReading("update", ["README.md"]),
      plannerPages: [
        { path: "README.md", disposition: "update" },
        { path: "AGENTS.md", disposition: "update" },
        { path: "src/README.md", disposition: "update" },
      ],
    });
    expectRefusedBeforeWriting(
      run,
      ["AGENTS.md", "src/README.md"],
      ["README.md"],
      fixture.config.stateDirectory,
    );
  });

  it(
    "refuses a tracked symlink listed as a file root, and writes nothing through it",
    RUN_BUDGET,
    async () => {
      // LINK.md is a tracked link to README.md, so it is no regular file and
      // never a file root: a plan that writes it is refused like any page
      // outside the roots, and neither the link nor its target changes.
      const fixture = await updateFixture("link-root", {
        files: { "README.md": "# Orbit\n\nUse --old.\n" },
        links: { "LINK.md": "README.md" },
        documentationRoots: ["LINK.md", "docs"],
      });
      const run = await updateRun({
        fixture,
        instruction: "Fix whatever is stale in the documentation.",
        reading: { operation: "update" },
        plannerPages: [{ path: "LINK.md", disposition: "update" }],
      });
      expect(run.error).toBeUndefined();
      expect(run.record?.status, JSON.stringify(run.record?.error)).toBe("failed");
      const failure = readRunFailure(run.record!);
      expect(failure?.class).toBe("planning-refusal");
      expect([PLAN_OUTSIDE_WRITE_ROOTS_CODE, PLAN_TARGET_NOT_WRITABLE_CODE]).toContain(
        failure?.code,
      );
      const planError = run.record?.steps.find(
        (step) => step.skill === "plan-documentation",
      )?.error;
      expect(planError).toMatch(
        /^plan-(?:outside-write-roots|target-not-writable): the plan writes LINK\.md /u,
      );
      expect(run.harness.stepIds.at(-1)).toBe("plan-documentation");
      expect(run.record?.changes?.files ?? []).toEqual([]);
      expect(await readlink(join(fixture.repository, "LINK.md"))).toBe("README.md");
      expect(await readFile(join(fixture.repository, "README.md"), "utf8")).toBe(
        "# Orbit\n\nUse --old.\n",
      );
    },
  );

  it(
    "refuses a create before any model call when every root left is a file",
    RUN_BUDGET,
    async () => {
      const fixture = await updateFixture("dr2-create", {
        files: DR2_FILES,
        documentationRoots: DR2_ROOTS,
      });
      const port = stubPort(namedReading("create", ["demo/x/NEW.md"]));
      let error: unknown;
      try {
        await executeRunRequest(
          {
            ...updateRequest(fixture, "Create demo/x/NEW.md for the new --new option."),
            workflow: "create-documentation",
          },
          fixture.config,
          { silent: true, requestInterpreter: port },
        );
      } catch (thrown) {
        error = thrown;
      }
      expect(port.calls).toHaveLength(0);
      expect(error).toMatchObject({ code: "documentation-roots-outside-write-roots" });
      expect((error as Error).message).toContain(
        `every documentationRoots entry in .docsfab.json that grants a write is a file: ${[...DR2_ROOTS].sort().join(", ")}.`,
      );
    },
  );

  it(
    "delivers the DD-2 shape: a directory root beside a package README file root",
    RUN_BUDGET,
    async () => {
      const pages = ["fern/versions/latest/pages/models.mdx", "packages/config/README.md"];
      const fixture = await updateFixture("dd2", {
        files: {
          "fern/versions/latest/pages/models.mdx": "---\ntitle: Models\n---\n\nUse --old.\n",
          "packages/config/README.md": "# Config\n\nUse --old.\n",
        },
        documentationRoots: ["fern/versions/latest/pages", "packages/config/README.md"],
      });
      const run = await updateRun({
        fixture,
        instruction: `Update ${pages.join(" and ")} for the new --new option.`,
        reading: namedReading("update", pages),
        plannerPages: pages.map((path) => ({ path, disposition: "update" as const })),
        writePlannedPages: true,
      });
      expect(run.error).toBeUndefined();
      expect(run.record?.status, JSON.stringify(run.record?.error)).toBe("succeeded");
      expect(run.record?.changes?.files?.map((file) => file.path)).toEqual(pages);
    },
  );
});

// ---------------------------------------------------------------------------
// An admitted restructure: no first pass binds it, so only the roots do.

class RestructurePlanHarness implements AgentHarness {
  public readonly stepIds: string[] = [];
  public readonly inputs: HarnessStepInput[] = [];

  public constructor(
    private readonly pages: readonly string[],
    private readonly mode: "create" | "restructure" = "restructure",
  ) {}

  public async inspectSkill(input: HarnessStepInput) {
    return { id: input.step.skill, contentSha256: "a".repeat(64) };
  }

  public async runStep(input: HarnessStepInput) {
    this.stepIds.push(input.step.id);
    this.inputs.push(input);
    if (input.step.id === "write-documentation") {
      for (const page of this.pages) {
        const path = join(input.repositoryPath, page);
        const line = /\.ya?ml$/u.test(page) ? "# Restructured." : "Restructured.";
        const before = this.mode === "create" ? "" : await readFile(path, "utf8");
        await writeFile(path, `${before}\n${line}\n`);
      }
    }
    const mode = this.mode;
    const pages = this.pages.map((path) => ({ path, disposition: mode }));
    const sourceBindings = this.pages.map((path) => ({ pagePath: path, sources: ["README.md"] }));
    return {
      summary: `Completed ${input.step.id}.`,
      ...(input.step.id === "plan-documentation"
        ? {
            planBinding: {
              kind: "docsfab-documentation-plan" as const,
              schemaVersion: 1 as const,
              mode,
              pages,
              sourceBindings,
              digest: documentationPlanBindingDigest({ mode, pages, sourceBindings }),
            },
          }
        : {}),
      ...(await verificationFixture(input)),
      model: { provider: "fixture", model: "fixture-model" },
      skill: { id: input.step.skill, contentSha256: "a".repeat(64) },
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0 },
      tools: { totalCalls: 0, failedCalls: 0, byTool: [], failureCategories: [] },
    };
  }
}

async function restructureRun(
  plannedPages: readonly string[],
  options: {
    readonly files?: Readonly<Record<string, string>>;
    readonly documentationRoots?: readonly string[];
    readonly named?: readonly string[];
    readonly mode?: "create" | "restructure";
    readonly links?: Readonly<Record<string, string>>;
  } = {},
) {
  const named = options.named ?? ["docs/guide.md"];
  const root = await mkdtemp(join(tmpdir(), "docsfab-plan-scope-restructure-"));
  temporaryDirectories.push(root);
  const repository = join(root, "repository");
  const stateDirectory = join(root, "state", "runs");
  await initFixtureRepo(
    repository,
    {
      ".docsfab.json": `${JSON.stringify({
        schemaVersion: 1,
        gitlab: { remote: "origin", defaultBranch: "main" },
        provider: { configuration: "host" },
        storage: { scope: "user-private" },
        ...(options.documentationRoots ? { documentationRoots: options.documentationRoots } : {}),
      })}\n`,
      "README.md": "# Fixture\n",
      "src/api.ts": "export const enabled = true;\n",
      ...PAGES,
      ...options.files,
    },
    { branch: "main" },
  );
  for (const [path, target] of Object.entries(options.links ?? {})) {
    await mkdir(dirname(join(repository, path)), { recursive: true });
    await symlink(target, join(repository, path));
  }
  if (options.links) await commitFixture(repository, "track fixture navigation link");
  const mode = options.mode ?? "restructure";
  const harness = new RestructurePlanHarness(plannedPages, mode);
  const canonSnapshotPath = join(root, "canon.json");
  if (mode === "create") {
    await writeFile(
      canonSnapshotPath,
      `${JSON.stringify(
        createKnowledgeAcceptedSnapshot({
          projectId: "FIXTURE",
          modelVersionId: "FIXTURE-V1",
          streamVersion: 1,
          status: "approved",
          claims: [
            {
              id: "FIXTURE-API",
              kind: "behavior",
              scope: named[0]!,
              statement: "The fixture API is enabled.",
              modelState: "canonical",
              evidenceIds: ["FIXTURE-SOURCE"],
            },
          ],
          sources: [{ id: "FIXTURE-SOURCE", locator: "src/api.ts" }],
          conflicts: [],
        }),
      )}\n`,
    );
  }
  const record = await executeRunRequest(
    {
      workflow: mode === "create" ? "create-documentation" : "restructure-documentation",
      instruction:
        mode === "create"
          ? `Create ${named.join(" and ")} for the fixture API.`
          : `Restructure ${named.join(" and ")} so the steps come first.`,
      repositoryPath: repository,
      revision: "HEAD",
      allowWrite: true,
      releaseGate: false,
      verbose: false,
      json: false,
      showScan: false,
      ...(mode === "create" ? { canonSnapshotPath } : {}),
    },
    runtimeConfig(stateDirectory),
    {
      silent: true,
      executionHarness: harness,
      skillResolver: {
        resolveSkill: async (input: HarnessStepInput) => ({
          id: input.step.skill,
          contentSha256: "a".repeat(64),
        }),
      },
      requestInterpreter: stubPort(namedReading(mode, named)),
    },
  );
  return { record, harness, repository, stateDirectory };
}

describe("an admitted restructure keeps its plan inside the documentation write roots", () => {
  it.each(OUTSIDE)("refuses a plan that also restructures %s", RUN_BUDGET, async (outside) => {
    const run = await restructureRun(["docs/guide.md", outside]);
    expect(run.record?.requestIntent?.admission.outcome).toBe("admitted");
    expectRefusedBeforeWriting(run, [outside], DEFAULT_ROOTS, run.stateDirectory);
    expect(await readFile(join(run.repository, outside), "utf8")).toBe(PAGES[outside]);
  });

  it("delivers the plan that keeps to the roots (control)", RUN_BUDGET, async () => {
    const run = await restructureRun(["docs/guide.md"]);
    expect(run.record?.requestIntent?.admission.outcome).toBe("admitted");
    expect(run.record?.status, JSON.stringify(run.record?.error)).toBe("succeeded");
    expect(run.record?.changes?.files).toEqual([{ path: "docs/guide.md", status: "modified" }]);
    expect(await exists(join(run.repository, "docs/guide.md"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// A restructure may write the repository's declarative navigation file, such
// as Fern's fern/docs.yml, inside the roots; no other file that is no page.

const FERN: Readonly<Record<string, string>> = {
  "fern/docs.yml": "navigation:\n  - page: Intro\n    path: pages/intro.mdx\n",
  "fern/other.yml": "other: true\n",
  "fern/pages/intro.mdx": "---\ntitle: Intro\n---\n\nIntro.\n",
};

describe("a restructure writes the Fern navigation file only inside the roots", () => {
  it("delivers a Fern restructure whose plan writes fern/docs.yml", RUN_BUDGET, async () => {
    const run = await restructureRun(["fern/pages/intro.mdx", "fern/docs.yml"], {
      files: FERN,
      named: ["fern/pages/intro.mdx"],
    });
    expect(run.record?.requestIntent?.admission.outcome).toBe("admitted");
    expect(run.record?.status, JSON.stringify(run.record?.error)).toBe("succeeded");
    expect(run.record?.changes?.files).toEqual([
      { path: "fern/docs.yml", status: "modified" },
      { path: "fern/pages/intro.mdx", status: "modified" },
    ]);
  });

  it(
    "refuses a planner-chosen fern/other.yml, which is no navigation file",
    RUN_BUDGET,
    async () => {
      const run = await restructureRun(["fern/pages/intro.mdx", "fern/other.yml"], {
        files: FERN,
        named: ["fern/pages/intro.mdx"],
      });
      expectRefusedBeforeWriting(run, ["fern/other.yml"], DEFAULT_ROOTS, run.stateDirectory);
      expect(await readFile(join(run.repository, "fern/other.yml"), "utf8")).toBe(
        FERN["fern/other.yml"],
      );
    },
  );

  it(
    "refuses fern/docs.yml when the roots leave fern/ out, with a NEXT to add its directory",
    RUN_BUDGET,
    async () => {
      const run = await restructureRun(["docs/guide.md", "fern/docs.yml"], {
        files: FERN,
        documentationRoots: ["docs"],
      });
      expectRefusedBeforeWriting(
        run,
        [{ path: "fern/docs.yml", refusal: "navigation-outside-roots" }],
        ["docs/"],
        run.stateDirectory,
      );
      // A root on its directory is the remedy that works, so neither the step
      // nor NEXT sends the operator to make the change by hand.
      const planStep = run.record?.steps.find((step) => step.skill === "plan-documentation");
      expect(planStep?.error).toContain(
        "fern/docs.yml (the repository's navigation file, outside the documentation write roots)",
      );
      expect(planStep?.error).toContain(
        "add the directory of fern/docs.yml, fern, to documentationRoots in .docsfab.json",
      );
      const next = buildRunHumanNextCommand({
        record: run.record!,
        recordPath: join(run.stateDirectory, `${run.record!.id}.json`),
        exitCode: 1,
      });
      expect(next?.reason).toContain(
        "for a restructure's navigation file, such as fern/docs.yml, add its directory, such as fern.",
      );
      expect(next?.reason).not.toContain("by hand");
      expect(await readFile(join(run.repository, "fern/docs.yml"), "utf8")).toBe(
        FERN["fern/docs.yml"],
      );
    },
  );

  it(
    "delivers the same restructure once fern is listed in documentationRoots (control)",
    RUN_BUDGET,
    async () => {
      const run = await restructureRun(["docs/guide.md", "fern/docs.yml"], {
        files: FERN,
        documentationRoots: ["docs", "fern"],
      });
      expect(run.record?.status, JSON.stringify(run.record?.error)).toBe("succeeded");
      expect(run.record?.changes?.files).toEqual([
        { path: "docs/guide.md", status: "modified" },
        { path: "fern/docs.yml", status: "modified" },
      ]);
    },
  );

  it("refuses fern/docs.yml in an update plan", RUN_BUDGET, async () => {
    const fixture = await updateFixture("fern-update", { files: FERN });
    const run = await updateRun({
      fixture,
      instruction: "Fix whatever is stale in the documentation.",
      plannerPages: [
        { path: "docs/guide.md", disposition: "update" },
        { path: "fern/docs.yml", disposition: "update" },
      ],
    });
    expectRefusedBeforeWriting(
      run,
      ["fern/docs.yml"],
      DEFAULT_ROOTS,
      fixture.config.stateDirectory,
    );
    const planners = run.harness.inputs.filter((input) => input.step.id === "plan-documentation");
    expect(planners, "the real update planner step must run").toHaveLength(1);
    expect(
      planners[0]!.planWriteGuidance?.navigationFiles,
      "only a restructure may be offered navigation",
    ).toEqual([]);
    expect(buildHostStepPrompt(planners[0]!)).not.toContain("This restructure may also write");
  });

  it("never offers a Fern navigation write to a create planner (control)", RUN_BUDGET, async () => {
    const run = await restructureRun(["docs/new.md"], {
      files: FERN,
      named: ["docs/new.md"],
      mode: "create",
    });
    const planners = run.harness.inputs.filter((input) => input.step.id === "plan-documentation");
    expect(planners, "the real create planner step must run").toHaveLength(1);
    expect(
      planners[0]!.planWriteGuidance?.navigationFiles,
      "only a restructure may be offered navigation",
    ).toEqual([]);
    expect(buildHostStepPrompt(planners[0]!)).not.toContain("This restructure may also write");
    expect(await readFile(join(run.repository, "fern/docs.yml"), "utf8")).toBe(
      FERN["fern/docs.yml"],
    );
  });
});

// ---------------------------------------------------------------------------
// The exemption is the one navigation file the repository has, matched
// exactly: no other letter case, no other directory, no second Fern file
// beside it, none in a repository without a Fern site, and never MkDocs'
// mkdocs.yml, which sits where no root reaches.

const FERN_YAML: Readonly<Record<string, string>> = {
  "fern/docs.yaml": FERN["fern/docs.yml"]!,
  "fern/pages/intro.mdx": FERN["fern/pages/intro.mdx"]!,
};
const MKDOCS = "site_name: Fixture\nnav:\n  - Guide: guide.md\n";

describe("a restructure writes only the navigation file the repository has", () => {
  it.each(["fern/Docs.yml", "fern/sub/docs.yml"])(
    "refuses a planned %s beside fern/docs.yml as a file that is no page",
    RUN_BUDGET,
    async (variant) => {
      const run = await restructureRun(["fern/pages/intro.mdx", variant], {
        files: FERN,
        named: ["fern/pages/intro.mdx"],
      });
      expectRefusedBeforeWriting(
        run,
        [{ path: variant, refusal: "not-a-page" }],
        DEFAULT_ROOTS,
        run.stateDirectory,
      );
      expect(await readFile(join(run.repository, "fern/docs.yml"), "utf8")).toBe(
        FERN["fern/docs.yml"],
      );
    },
  );

  it(
    "refuses a fern/docs.yaml created beside the repository's fern/docs.yml",
    RUN_BUDGET,
    async () => {
      const run = await restructureRun(["fern/pages/intro.mdx", "fern/docs.yaml"], {
        files: FERN,
        named: ["fern/pages/intro.mdx"],
      });
      expectRefusedBeforeWriting(
        run,
        [{ path: "fern/docs.yaml", refusal: "not-a-page" }],
        DEFAULT_ROOTS,
        run.stateDirectory,
      );
      expect(await exists(join(run.repository, "fern/docs.yaml"))).toBe(false);
    },
  );

  it.each(["conf.py", "docs/conf.py", "docusaurus.config.js", "docusaurus.config.ts"])(
    "delivers the base Fern navigation beside %s without changing reachability precedence",
    RUN_BUDGET,
    async (configuration) => {
      const run = await restructureRun(["fern/pages/intro.mdx", "fern/docs.yml"], {
        files: { ...FERN, [configuration]: "SETTINGS = {}\n" },
        named: ["fern/pages/intro.mdx"],
      });
      expect(run.record?.status, "mixed-site Fern navigation must remain writable").toBe(
        "succeeded",
      );
      expect(run.record?.changes?.files).toEqual([
        { path: "fern/docs.yml", status: "modified" },
        { path: "fern/pages/intro.mdx", status: "modified" },
      ]);
      const planner = run.harness.inputs.find((input) => input.step.id === "plan-documentation");
      expect(planner?.planWriteGuidance?.navigationFiles).toEqual(["fern/docs.yml"]);
      expect(buildHostStepPrompt(planner!)).toContain("fern/docs.yml");
      expect(await readFile(join(run.repository, configuration), "utf8")).toBe("SETTINGS = {}\n");
    },
  );

  it(
    "delivers both navigation files only when both are present in the base workspace",
    RUN_BUDGET,
    async () => {
      const run = await restructureRun(
        ["fern/pages/intro.mdx", "fern/docs.yml", "fern/docs.yaml"],
        {
          files: { ...FERN, ...FERN_YAML },
          named: ["fern/pages/intro.mdx"],
        },
      );
      expect(run.record?.status, "both base Fern navigation files must remain writable").toBe(
        "succeeded",
      );
      expect(run.record?.changes?.files).toEqual([
        { path: "fern/docs.yaml", status: "modified" },
        { path: "fern/docs.yml", status: "modified" },
        { path: "fern/pages/intro.mdx", status: "modified" },
      ]);
      const planner = run.harness.inputs.find((input) => input.step.id === "plan-documentation");
      expect(planner?.planWriteGuidance?.navigationFiles).toEqual([
        "fern/docs.yaml",
        "fern/docs.yml",
      ]);
      const prompt = buildHostStepPrompt(planner!);
      expect(prompt, "guidance must name the whole admitted navigation set").toContain(
        "fern/docs.yaml",
      );
      expect(prompt, "guidance must name the whole admitted navigation set").toContain(
        "fern/docs.yml",
      );
    },
  );

  it("refuses a fern/docs.yml in a repository with no Fern site", RUN_BUDGET, async () => {
    const run = await restructureRun(["docs/guide.md", "fern/docs.yml"]);
    expectRefusedBeforeWriting(
      run,
      [{ path: "fern/docs.yml", refusal: "not-a-page" }],
      DEFAULT_ROOTS,
      run.stateDirectory,
    );
    expect(await exists(join(run.repository, "fern/docs.yml"))).toBe(false);
  });

  it.each([
    [
      "a final file link",
      { "fern/pages/intro.mdx": FERN["fern/pages/intro.mdx"]! },
      { "fern/docs.yml": "../docs/guide.md" },
    ],
    ["a directory link", { "docs/docs.yml": FERN["fern/docs.yml"]! }, { fern: "docs" }],
  ] as const)(
    "refuses navigation reached through %s (control)",
    RUN_BUDGET,
    async (_shape, files, links) => {
      const run = await restructureRun(["docs/guide.md", "fern/docs.yml"], { files, links });
      expectRefusedBeforeWriting(
        run,
        [{ path: "fern/docs.yml", refusal: "not-a-page" }],
        DEFAULT_ROOTS,
        run.stateDirectory,
      );
      const planner = run.harness.inputs.find((input) => input.step.id === "plan-documentation");
      expect(planner?.planWriteGuidance?.navigationFiles).toEqual([]);
      expect(await readFile(join(run.repository, "docs/guide.md"), "utf8")).toBe(
        PAGES["docs/guide.md"],
      );
    },
  );

  it(
    "delivers fern/docs.yaml in a repository that keeps that file (control)",
    RUN_BUDGET,
    async () => {
      const run = await restructureRun(["fern/pages/intro.mdx", "fern/docs.yaml"], {
        files: FERN_YAML,
        named: ["fern/pages/intro.mdx"],
      });
      expect(run.record?.status, JSON.stringify(run.record?.error)).toBe("succeeded");
      expect(run.record?.changes?.files).toEqual([
        { path: "fern/docs.yaml", status: "modified" },
        { path: "fern/pages/intro.mdx", status: "modified" },
      ]);
    },
  );

  it.each([
    ["mkdocs.yml", "under the default roots", undefined],
    ["mkdocs.yaml", "under the default roots", undefined],
    ["mkdocs.yml", "when documentationRoots lists it", ["mkdocs.yml", "docs"]],
  ] as const)(
    "keeps MkDocs' %s at the repository root unwritable %s",
    RUN_BUDGET,
    async (navigation, _roots, documentationRoots) => {
      const run = await restructureRun(["docs/guide.md", navigation], {
        files: { [navigation]: MKDOCS },
        ...(documentationRoots ? { documentationRoots } : {}),
      });
      // The tracked mkdocs.yml listed as a root grants nothing: it is no page.
      expectRefusedBeforeWriting(
        run,
        [{ path: navigation, refusal: "not-a-page" }],
        documentationRoots ? ["docs/"] : DEFAULT_ROOTS,
        run.stateDirectory,
      );
      expect(await readFile(join(run.repository, navigation), "utf8")).toBe(MKDOCS);
    },
  );
});

// ---------------------------------------------------------------------------
// The restructure planner is told what its plan may write, the navigation
// file included only where plan admission admits it.

describe("the restructure planner is told the roots, the page shape and the navigation file", () => {
  it.each([
    ["a Fern site under the default roots", { files: FERN }, ["docs/", "fern/"], "fern/docs.yml"],
    [
      "a Fern site that keeps fern/docs.yaml",
      { files: FERN_YAML },
      ["docs/", "fern/"],
      "fern/docs.yaml",
    ],
    [
      "a Fern site whose roots leave fern/ out",
      { files: FERN, documentationRoots: ["docs"] },
      ["docs/"],
      null,
    ],
    ["a repository with no Fern site", {}, ["docs/", "fern/"], null],
    ["a MkDocs site", { files: { "mkdocs.yml": MKDOCS } }, ["docs/", "fern/"], null],
  ] as const)("for %s", RUN_BUDGET, async (_name, options, directoryRoots, navigationFile) => {
    const run = await restructureRun(["docs/guide.md"], options);
    const planner = run.harness.inputs.find((input) => input.step.id === "plan-documentation");
    expect(planner?.planWriteGuidance).toEqual({
      directoryRoots,
      fileRoots: [],
      navigationFiles: navigationFile ? [navigationFile] : [],
    });
    const prompt = buildHostStepPrompt(planner!);
    expect(prompt).toContain(
      `Directory roots, covering Markdown or MDX pages subject to protected-path rules: ${JSON.stringify(directoryRoots)}`,
    );
    expect(prompt).toContain("The plan may write only Markdown or MDX pages");
    if (navigationFile) {
      expect(prompt).toContain(
        `This restructure may also write these navigation files present as regular files in the base workspace and inside the roots: ${JSON.stringify([navigationFile])}.`,
      );
    } else {
      expect(prompt).not.toContain("This restructure may also write");
    }
    // Only the planner is told; no other step carries the statement.
    expect(run.harness.inputs.filter((input) => input.planWriteGuidance !== undefined).length).toBe(
      1,
    );
  });
});
