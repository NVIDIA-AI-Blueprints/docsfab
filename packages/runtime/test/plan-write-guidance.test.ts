// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The documentation planner is told what its plan may write: the run's
 * documentation roots, directories and exact files, the Markdown or MDX page
 * shape, and a restructure's navigation file inside the roots (#2043). The
 * statement is guidance and plan admission stays the check. Through the real
 * CLI run, a scripted planner in the GV-3 shape (OpenAPI YAML under
 * docs/open-api/ on a no-change task) that reads the statement from its
 * rendered prompt delivers, and one that ignores it is refused at plan
 * admission before any write.
 */
import { access, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { executeRunRequest } from "../src/cli/run-request.js";
import type {
  AgentHarness,
  HarnessStepInput,
  HarnessStepResult,
} from "../src/execution/contracts.js";
import { buildHostStepPrompt } from "../src/harness/pi.js";
import { buildDocsFabStepPrompt } from "../src/harness/pi-session.js";
import { readRunFailure } from "../src/operator/failure-classification.js";
import { buildRunHumanNextCommand } from "../src/operator/run-summary.js";
import type { RunRecord } from "../src/records/contracts.js";
import { hostOwnedContractSections } from "../src/workflow-execution/contract-placeholders.js";
import {
  PLAN_TARGET_NOT_WRITABLE_CODE,
  PlanWriteScopeError,
} from "../src/workflow-execution/plan-binding.js";
import {
  planWriteGuidancePrompt,
  PLAN_WRITE_GUIDANCE_HEADER,
  type PlanWriteGuidanceV1,
} from "../src/workflow-execution/plan-write-guidance.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import { loadTemplateSet } from "../src/templates/load.js";
import { pageTemplateGuidance } from "../src/templates/page-guidance.js";
import { PAGE_TEMPLATE_GUIDANCE_HEADER } from "../src/workflow-execution/page-template-guidance.js";
import { EditorialProtocolHarness } from "./helpers/editorial-protocol-harness.js";
import { createSourceFixture } from "./support/source-acquisition-cli.js";
import { runtimeConfig } from "./support/execution-convergence.js";
import {
  git,
  observePublicContract,
  orbitOptionChangeRepository,
} from "./helpers/orbit-option-change-fixture.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";

const RUN_BUDGET = { timeout: testTimeoutMs(60_000) };
const temporaryDirectories: string[] = [];

afterEach(async () => {
  process.exitCode = undefined;
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

// ---------------------------------------------------------------------------
// The rendered statement

/** Roots that diverge from the defaults, so a wrong source cannot pass. */
const GUIDANCE: PlanWriteGuidanceV1 = {
  boundTargets: [],
  directoryRoots: ["docs/", "site/content/"],
  fileRoots: ["README.md"],
  navigationFiles: [],
};
const SHAPE =
  "The plan may write only Markdown or MDX pages, paths that end in .md or .mdx, inside the run's documentation roots. Plan admission refuses a plan that writes any other path, before any write step.";
const NOT_A_PAGE =
  "Give no other path a mutating disposition: not a path outside these roots, and not a file that is not a Markdown or MDX page even under a root, such as an OpenAPI or other YAML or JSON specification, a configuration file, or source code.";
const OUTSIDE_ROOT_PAGE =
  "For a Markdown or MDX page outside these roots, name each page in the summary and say to add the page or its directory to documentationRoots in .docsfab.json, commit that file, and start a new run. Keep the page retain or out-of-scope, or leave it out of pages, until the roots cover it.";
const KEEP_AND_RECORD =
  "For another file that is not a Markdown or MDX page, such as an OpenAPI specification, keep it retain or out-of-scope, or leave it out of pages, plan the pages inside the roots that the change affects, and say in the summary which file needs a change DocsFab does not make.";

type PlanWorkflow = "create-documentation" | "update-documentation" | "restructure-documentation";

function plannerInput(name: PlanWorkflow, guidance?: PlanWriteGuidanceV1): HarnessStepInput {
  const workflow = getWorkflow(name);
  return {
    repositoryPath: "/tmp/repository",
    workflow,
    step: workflow.steps.find((step) => step.skill === "plan-documentation")!,
    instruction: "Update the guide for the new option.",
    ...(guidance ? { planWriteGuidance: guidance } : {}),
  };
}

/**
 * The planner prompt the host sends. The update planner's reader-impact
 * contract needs admitted reader context, so its mode-generic prompt is used;
 * the run-level cases below render the reader-impact one.
 */
function plannerPrompt(name: PlanWorkflow, guidance?: PlanWriteGuidanceV1): string {
  const input = plannerInput(name, guidance);
  return name === "update-documentation"
    ? buildDocsFabStepPrompt(input)
    : buildHostStepPrompt(input);
}

describe("the planner prompt states what the plan may write", () => {
  it.each(["create-documentation", "update-documentation", "restructure-documentation"] as const)(
    "warns the %s planner about unnamed instruction and hidden files while preserving ordinary pages",
    (name) => {
      const prompt = plannerPrompt(name, GUIDANCE);
      expect(prompt).toContain(
        "Instruction and hidden files are refused unless the operator's request names them.",
      );
      expect(prompt).toContain(SHAPE);
      expect(prompt).toContain(
        'Directory roots, covering Markdown or MDX pages subject to protected-path rules: ["docs/","site/content/"]',
      );
    },
  );

  it("labels the exact host-bound create target as authorized despite a missing parent directory", () => {
    const prompt = planWriteGuidancePrompt({
      directoryRoots: ["docs/", "fern/"],
      fileRoots: [],
      navigationFiles: [],
      boundTargets: ["docs/new.md"],
    });
    expect(prompt).toContain(
      'Host-bound request targets authorized under these roots: ["docs/new.md"]',
    );
    expect(prompt).toContain(
      "A missing parent directory under an authorized root does not make a bound target ambiguous.",
    );
  });

  it("does not invent a target when the host bound none", () => {
    expect(planWriteGuidancePrompt(GUIDANCE)).not.toContain(
      "Host-bound request targets authorized",
    );
  });

  it("states the single existing RST update bound without Markdown guidance", () => {
    const prompt = planWriteGuidancePrompt({
      directoryRoots: ["docs/"],
      fileRoots: [],
      navigationFiles: [],
      boundTargets: ["docs/guide.rst"],
    });
    expect(prompt).toContain('Host-bound request target: ["docs/guide.rst"]');
    expect(prompt).toContain(
      "The plan may update only the one host-bound existing RST page named below.",
    );
    expect(prompt).toContain(
      "RST creation, restructuring, and any second write target are unsupported.",
    );
    expect(prompt).toContain("The writer will propose one top-level paragraph or insertion slot");
    expect(prompt).not.toContain(SHAPE);
    expect(prompt).not.toContain(NOT_A_PAGE);
  });

  it("names an outside-root page and its documentationRoots remedy instead of calling it unsupported", () => {
    const prompt = planWriteGuidancePrompt(GUIDANCE);
    expect(prompt, "outside-root pages need an actionable configuration remedy").toContain(
      "For a Markdown or MDX page outside these roots, name each page in the summary and say to add the page or its directory to documentationRoots in .docsfab.json",
    );
  });

  it("separates the guidance from the next host section with a blank line", () => {
    expect(planWriteGuidancePrompt(GUIDANCE), "guidance must end with a blank line").toMatch(
      /\n\n$/u,
    );
  });

  it("states that directory roots remain subject to protected-path rules", () => {
    const prompt = planWriteGuidancePrompt(GUIDANCE);
    expect(prompt, "roots must not promise every page is writable").not.toContain(
      "covering every page under it",
    );
    expect(prompt).toContain("protected-path rules");
  });

  it("leaves the navigation lead out of a page-only scope refusal", () => {
    const error = new PlanWriteScopeError(
      [{ path: "docs/spec.yml", refusal: "not-a-page" }],
      ["docs/"],
    );
    expect(
      error.message,
      "page-only scope errors must not offer restructure navigation",
    ).not.toContain("a restructure's navigation");
  });
  it.each(["create-documentation", "update-documentation", "restructure-documentation"] as const)(
    "states the roots, the page shape, and what to do instead for the %s planner",
    (name) => {
      const prompt = plannerPrompt(name, GUIDANCE);
      const block = [
        PLAN_WRITE_GUIDANCE_HEADER,
        SHAPE,
        "Instruction and hidden files are refused unless the operator's request names them.",
        'Directory roots, covering Markdown or MDX pages subject to protected-path rules: ["docs/","site/content/"]',
        'File roots, each covering exactly that one page: ["README.md"]',
        NOT_A_PAGE,
        OUTSIDE_ROOT_PAGE,
        KEEP_AND_RECORD,
      ].join("\n");
      expect(prompt.split(block)).toHaveLength(2);
      // After the planner's response contract, before the request.
      const contract = prompt.indexOf("Runtime planner response contract (host-owned):");
      expect(contract).toBeGreaterThanOrEqual(0);
      expect(prompt.indexOf(block)).toBeGreaterThan(contract);
      expect(prompt.indexOf(block)).toBeLessThan(prompt.indexOf("Requester instruction:"));
      expect(prompt).not.toContain("This restructure may also write");
    },
  );

  it("names the restructure's navigation file when the host passes one", () => {
    const prompt = plannerPrompt("restructure-documentation", {
      ...GUIDANCE,
      navigationFiles: ["fern/docs.yml"],
    });
    expect(prompt).toContain(
      'File roots, each covering exactly that one page: ["README.md"]\nThis restructure may also write these navigation files present as regular files in the base workspace and inside the roots: ["fern/docs.yml"].\n' +
        NOT_A_PAGE,
    );
  });

  it("tells a planner whose run has no root that the lists are empty", () => {
    const prompt = plannerPrompt("update-documentation", {
      directoryRoots: [],
      fileRoots: [],
      navigationFiles: [],
    });
    expect(prompt).toContain(
      "Directory roots, covering Markdown or MDX pages subject to protected-path rules: []",
    );
    expect(prompt).toContain("File roots, each covering exactly that one page: []");
  });

  it("renders nothing without guidance, and nothing for a step that is not the planner", () => {
    for (const name of [
      "create-documentation",
      "update-documentation",
      "restructure-documentation",
    ] as const) {
      expect(plannerPrompt(name)).not.toContain(PLAN_WRITE_GUIDANCE_HEADER);
    }
    const restructure = getWorkflow("restructure-documentation");
    const writer = restructure.steps.find((step) => step.skill === "write-documentation")!;
    expect(
      buildDocsFabStepPrompt({
        repositoryPath: "/tmp/repository",
        workflow: restructure,
        step: writer,
        planWriteGuidance: GUIDANCE,
      }),
    ).not.toContain(PLAN_WRITE_GUIDANCE_HEADER);
  });

  it("never joins the host-owned response contract section above it", () => {
    for (const name of [
      "create-documentation",
      "update-documentation",
      "restructure-documentation",
    ] as const) {
      const sections = hostOwnedContractSections(plannerPrompt(name, GUIDANCE)).join("\n");
      expect(sections).toContain("Runtime planner response contract (host-owned):");
      expect(sections).not.toContain(PLAN_WRITE_GUIDANCE_HEADER);
      expect(sections).not.toContain("site/content/");
    }
  });
});

// The shipped local entrypoint must pass its pre-planning target binding to the
// rendered planner prompt. This fixture has no docs/ and no .docsfab.json.
it(
  "shows an exact new docs target to the planner before it replies when docs/ is absent",
  RUN_BUDGET,
  async () => {
    const fixture = await createSourceFixture();
    temporaryDirectories.push(fixture.root);
    const { git } = await import("./helpers/git.js");
    await git(fixture.repository, ["rm", "-r", "--", "docs"]);
    await rm(join(fixture.repository, ".docsfab.json"), { force: true });
    await git(fixture.repository, ["add", "-A"]);
    await git(fixture.repository, ["commit", "-m", "fixture without docs root"]);
    await expect(access(join(fixture.repository, "docs"))).rejects.toThrow();
    const instruction =
      "Create docs/new.md for developers from README.md. Change only docs/new.md; leave the other files unchanged. Keep it local.";
    const captured: string[] = [];
    const sentinel = new Error("planner captured");
    const record = await executeRunRequest(
      {
        workflow: "create-documentation",
        repositoryPath: fixture.repository,
        revision: "HEAD",
        instruction,
        allowWrite: true,
        releaseGate: false,
        verbose: false,
        json: false,
        showScan: false,
      },
      runtimeConfig(fixture.stateDirectory),
      {
        silent: true,
        requestInterpreter: {
          async call() {
            return {
              text: JSON.stringify({
                operation: "create",
                targets: [
                  { path: "docs/new.md", role: "write", chosenFrom: "named", quote: "docs/new.md" },
                ],
                sources: [],
                preserve: [],
                exclusions: [],
                constraints: [],
                questions: [],
                authorityPreference: { preference: "unspecified", quote: null },
              }),
              usage: { inputTokens: 1, outputTokens: 1 },
            };
          },
        },
        executionHarness: {
          async runStep(input: HarnessStepInput) {
            if (input.step.id === "plan-documentation") captured.push(buildHostStepPrompt(input));
            throw sentinel;
          },
        },
      },
    );
    expect(
      captured,
      JSON.stringify({
        status: record.status,
        error: record.error,
        steps: record.steps.map((step) => [step.id, step.status]),
      }),
    ).toHaveLength(1);
    expect(captured[0]).toContain(
      'Host-bound request targets authorized under these roots: ["docs/new.md"]',
    );
    expect(captured[0]).toContain(
      "A missing parent directory under an authorized root does not make a bound target ambiguous.",
    );
  },
);

// ---------------------------------------------------------------------------
// A scripted planner through the real run

const DIRECTORY_ROOTS_LINE =
  /^Directory roots, covering Markdown or MDX pages subject to protected-path rules: (\[.*\])$/mu;
const FILE_ROOTS_LINE = /^File roots, each covering exactly that one page: (\[.*\])$/mu;

/**
 * Whether the write scope stated in `prompt` admits `path`, as a planner that
 * heeds it reads it: a Markdown or MDX page under a directory root, or exactly
 * a file root. Undefined when the prompt states no scope.
 */
function statedScope(prompt: string): ((path: string) => boolean) | undefined {
  const directories = DIRECTORY_ROOTS_LINE.exec(prompt)?.[1];
  const files = FILE_ROOTS_LINE.exec(prompt)?.[1];
  if (directories === undefined || files === undefined) return undefined;
  const directoryRoots = JSON.parse(directories) as string[];
  const fileRoots = JSON.parse(files) as string[];
  return (path) =>
    /\.mdx?$/u.test(path) &&
    (fileRoots.includes(path) || directoryRoots.some((root) => path.startsWith(root)));
}

type Disposition = "update" | "retain" | "out-of-scope";

/**
 * A model stand-in for the update planner. It wants to change `wanted`, as the
 * GV-3 planner wanted to change the OpenAPI specs. When it heeds the prompt,
 * it reads the write scope from the prompt the host would send and keeps each
 * wanted path the scope does not admit out-of-scope; a planner that ignores
 * it, or finds no scope, plans every wanted path as an update.
 */
class ScopeReadingPlanner implements AgentHarness {
  public prompt: string | undefined;
  public inner: EditorialProtocolHarness | undefined;

  public constructor(
    private readonly options: {
      readonly heed: boolean;
      readonly impactSource: { uri: string; sha256: string };
      readonly kept: readonly string[];
      readonly wanted: readonly string[];
    },
  ) {}

  public async runStep(input: HarnessStepInput): Promise<HarnessStepResult> {
    if (input.step.id === "plan-documentation") {
      this.prompt = buildHostStepPrompt(input);
      const admits = this.options.heed ? statedScope(this.prompt) : undefined;
      const pages: { path: string; disposition: Disposition }[] = [
        ...this.options.kept.map((path) => ({ path, disposition: "retain" as const })),
        ...this.options.wanted.map((path) => ({
          path,
          disposition: admits && !admits(path) ? ("out-of-scope" as const) : ("update" as const),
        })),
      ];
      const writes = pages.some((page) => page.disposition === "update");
      this.inner = new EditorialProtocolHarness({
        candidate: writes ? "update" : "no-change",
        impactSource: this.options.impactSource,
        plannerPages: pages,
        plannerJudgment: true,
        writePlannedPages: true,
      });
    }
    if (!this.inner) throw new Error("The scripted planner runs first.");
    return this.inner.runStep(input);
  }
}

const SPECS = ["docs/open-api/owners.yaml", "docs/open-api/policies.yaml"] as const;
const SPEC_FILES: Readonly<Record<string, string>> = {
  "docs/open-api/owners.yaml": "openapi: 3.0.0\ninfo:\n  title: Owners\n",
  "docs/open-api/policies.yaml": "openapi: 3.0.0\ninfo:\n  title: Policies\n",
};
const CHECK_REQUEST =
  "Check whether the documentation needs an update for this change, starting from the Orbit CLI page (docs/cli.md). Update the documentation only if the change requires it; if it does not, make no edits and explain why.";
const CURRENT_PAGE = "# Orbit CLI\n\nThe public option is --new.\n";

/** The Orbit change after docs/cli.md already documents it, with OpenAPI specs under docs/. */
async function noChangeFixture() {
  const fixture = await orbitOptionChangeRepository("docsfab-plan-guidance", temporaryDirectories, {
    files: SPEC_FILES,
  });
  await writeFile(join(fixture.repository, "docs/cli.md"), CURRENT_PAGE);
  await git(fixture.repository, "add", "--all");
  await git(
    fixture.repository,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "docs: describe --new",
  );
  const head = await git(fixture.repository, "rev-parse", "HEAD");
  await git(fixture.repository, "update-ref", "refs/remotes/origin/main", head);
  return { ...fixture, head, impactSource: await observePublicContract(fixture.repository, head) };
}

async function checkRun(
  fixture: Awaited<ReturnType<typeof noChangeFixture>>,
  harness: ScopeReadingPlanner,
) {
  const output: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (message?: unknown): void => {
    output.push(String(message));
  };
  console.error = (message?: unknown): void => {
    output.push(String(message));
  };
  let record: RunRecord | undefined;
  try {
    record = await executeRunRequest(
      {
        workflow: "update-documentation",
        repositoryPath: fixture.repository,
        revision: fixture.head,
        instruction: CHECK_REQUEST,
        allowWrite: true,
        releaseGate: false,
        verbose: false,
        json: true,
        showScan: false,
      },
      fixture.config,
      { harness },
    );
  } finally {
    console.log = log;
    console.error = error;
  }
  const json = JSON.parse(output.at(-1) ?? "{}") as Record<string, unknown>;
  return { record: record!, json };
}

describe("a scripted planner in the GV-3 shape, through the real run", () => {
  it(
    "delivers a verified no-change when the planner heeds the stated scope and keeps the specs out",
    RUN_BUDGET,
    async () => {
      const fixture = await noChangeFixture();
      const harness = new ScopeReadingPlanner({
        heed: true,
        impactSource: fixture.impactSource,
        kept: ["docs/cli.md"],
        wanted: SPECS,
      });
      const { record, json } = await checkRun(fixture, harness);
      expect(record.status, JSON.stringify(record.error)).toBe("succeeded");
      // The planner was told the default roots and the page shape...
      const planner = harness.inner!.inputs[0]!;
      expect(planner.step.id).toBe("plan-documentation");
      expect(planner.planWriteGuidance).toEqual({
        directoryRoots: ["docs/", "fern/"],
        fileRoots: [],
        navigationFiles: [],
        boundTargets: ["docs/cli.md"],
      });
      expect(harness.prompt).toContain(PLAN_WRITE_GUIDANCE_HEADER);
      expect(harness.prompt).toContain("Runtime reader-impact planner response contract");
      // ...and no later step is.
      expect(
        harness.inner!.inputs.slice(1).some((input) => input.planWriteGuidance !== undefined),
      ).toBe(false);
      expect(record.steps[0]?.planBinding?.pages).toEqual([
        { path: "docs/cli.md", disposition: "retain" },
        { path: "docs/open-api/owners.yaml", disposition: "out-of-scope" },
        { path: "docs/open-api/policies.yaml", disposition: "out-of-scope" },
      ]);
      expect(json).toMatchObject({
        execution: { status: "succeeded", exitCode: 0, patchPath: null },
        editorial: { outcome: "verified-no-change", decision: "no-change" },
      });
      expect(record.changes).toBeUndefined();
      expect(await git(fixture.repository, "status", "--short")).toBe("");
    },
  );

  it(
    "still refuses the specs at plan admission when the planner ignores the stated scope",
    RUN_BUDGET,
    async () => {
      const fixture = await noChangeFixture();
      const harness = new ScopeReadingPlanner({
        heed: false,
        impactSource: fixture.impactSource,
        kept: ["docs/cli.md"],
        wanted: SPECS,
      });
      const { record } = await checkRun(fixture, harness);
      expect(record.status).toBe("failed");
      // It was told; admission refuses what it planned anyway, by name.
      expect(harness.prompt).toContain(PLAN_WRITE_GUIDANCE_HEADER);
      const error = new PlanWriteScopeError(
        SPECS.map((path) => ({ path, refusal: "not-a-page" as const })),
        ["docs/", "fern/"],
      );
      expect(record.steps.find((step) => step.id === "plan-documentation")?.error).toBe(
        error.message,
      );
      expect(readRunFailure(record)).toMatchObject({
        class: "planning-refusal",
        code: PLAN_TARGET_NOT_WRITABLE_CODE,
      });
      expect(harness.inner!.stepIds).toEqual(["plan-documentation"]);
      const next = buildRunHumanNextCommand({
        record,
        recordPath: join(fixture.config.stateDirectory, `${record.id}.json`),
        exitCode: 1,
      });
      expect(next?.reason).toContain("Make that change by hand");
      for (const path of SPECS) {
        expect(await git(fixture.repository, "show", `HEAD:${path}`)).toBe(
          SPEC_FILES[path]!.trimEnd(),
        );
      }
      expect(await git(fixture.repository, "status", "--short")).toBe("");
    },
  );

  it(
    "writes a file root and a page under a directory root when the planner heeds them",
    RUN_BUDGET,
    async () => {
      // The Orbit change with docs/cli.md still on --old, and README.md listed
      // as a file root beside the docs directory.
      const fixture = await orbitOptionChangeRepository(
        "docsfab-plan-guidance-roots",
        temporaryDirectories,
        {
          files: { "README.md": "# Orbit\n\nUse --old.\n", ...SPEC_FILES },
          documentationRoots: ["docs", "README.md"],
        },
      );
      const harness = new ScopeReadingPlanner({
        heed: true,
        impactSource: await observePublicContract(fixture.repository, fixture.head),
        kept: [],
        wanted: ["docs/cli.md", "README.md", "docs/open-api/owners.yaml"],
      });
      const record = await executeRunRequest(
        {
          workflow: "update-documentation",
          repositoryPath: fixture.repository,
          revision: fixture.head,
          instruction: "Bring the documentation up to date with the new --new option.",
          comparisonRequest: {
            kind: "base-head",
            baseRevision: fixture.base,
            headRevision: fixture.head,
          },
          readerSources: [{ role: "public-contract", path: "src/orbit.ts" }],
          canonSnapshotPath: fixture.canonSnapshotPath,
          allowWrite: true,
          releaseGate: false,
          verbose: false,
          json: false,
          showScan: false,
        },
        fixture.config,
        { silent: true, harness },
      );
      expect(harness.inner!.inputs[0]?.planWriteGuidance).toEqual({
        directoryRoots: ["docs/"],
        fileRoots: ["README.md"],
        navigationFiles: [],
      });
      const pages = record.steps[0]?.planBinding?.pages ?? [];
      expect(pages).toHaveLength(3);
      expect(pages).toEqual(
        expect.arrayContaining([
          { path: "docs/cli.md", disposition: "update" },
          { path: "README.md", disposition: "update" },
          { path: "docs/open-api/owners.yaml", disposition: "out-of-scope" },
        ]),
      );
      expect(record.status, JSON.stringify(record.error)).toBe("succeeded");
      expect(record.changes?.files).toEqual([
        { path: "README.md", status: "modified" },
        { path: "docs/cli.md", status: "modified" },
      ]);
    },
  );
});

// ---------------------------------------------------------------------------
// Governed page template guidance, the block after the write scope

describe("the planner and writer prompts state page template guidance", () => {
  const templateGuidance = async () =>
    pageTemplateGuidance({
      bundle: await loadTemplateSet(resolve(import.meta.dirname, "..")),
      pages: [{ path: "docs/cli-troubleshooting.md" }, { path: "docs/concepts.md" }],
    });

  it.each(["create-documentation", "update-documentation", "restructure-documentation"] as const)(
    "renders the %s planner's template guidance right after its write scope",
    async (name) => {
      const input = {
        ...plannerInput(name, GUIDANCE),
        pageTemplateGuidance: await templateGuidance(),
      };
      const prompt =
        name === "update-documentation"
          ? buildDocsFabStepPrompt(input)
          : buildHostStepPrompt(input);
      const scope = prompt.indexOf(PLAN_WRITE_GUIDANCE_HEADER);
      const templates = prompt.indexOf(PAGE_TEMPLATE_GUIDANCE_HEADER);
      expect(scope).toBeGreaterThan(-1);
      expect(templates, "template guidance follows the write scope").toBeGreaterThan(scope);
      expect(prompt.slice(scope, templates)).toContain(KEEP_AND_RECORD);
      expect(prompt).toContain(
        'Page "docs/cli-troubleshooting.md": template troubleshooting-gfm (selected by filename-suffix: "cli-troubleshooting").',
      );
      expect(prompt).toContain(
        'Page "docs/concepts.md": no template guidance (no-template-signal).',
      );
      const sections = hostOwnedContractSections(prompt).join("\n");
      expect(sections).not.toContain(PAGE_TEMPLATE_GUIDANCE_HEADER);
    },
  );

  it("renders the writer's template guidance, which has no write scope block", async () => {
    const restructure = getWorkflow("restructure-documentation");
    const writer = restructure.steps.find((step) => step.skill === "write-documentation")!;
    const prompt = buildDocsFabStepPrompt({
      repositoryPath: "/tmp/repository",
      workflow: restructure,
      step: writer,
      pageTemplateGuidance: await templateGuidance(),
    });
    expect(prompt).toContain(PAGE_TEMPLATE_GUIDANCE_HEADER);
    expect(prompt).toContain("It is never a source of product facts");
    expect(prompt).not.toContain(PLAN_WRITE_GUIDANCE_HEADER);
  });

  it("renders nothing without template guidance", () => {
    for (const name of [
      "create-documentation",
      "update-documentation",
      "restructure-documentation",
    ] as const) {
      expect(plannerPrompt(name, GUIDANCE)).not.toContain(PAGE_TEMPLATE_GUIDANCE_HEADER);
    }
  });
});
