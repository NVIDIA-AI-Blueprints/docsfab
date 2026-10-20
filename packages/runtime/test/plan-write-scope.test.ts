// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Runner plan admission keeps every planned write inside the run's write
 * scope: under a local run's documentation write roots, directory roots and
 * exact file roots, for update and restructure plans alike, whatever the
 * request reading. Pages the request named are the least a plan addresses: a
 * plan may add pages inside the roots. A run bound to named pages with no
 * roots writes only those pages, and a run with neither, a hosted run, keeps
 * its own authority.
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { documentationPlanWriteScope } from "../src/cli/first-pass.js";
import { AuthoringQualityWorkflowOutcomeProjector } from "../src/evaluation-report/authoring-outcome-projector.js";
import type {
  AgentHarness,
  HarnessStepInput,
  HostOperationExecutor,
} from "../src/execution/contracts.js";
import type { ChangeEvidence } from "../src/impact/contracts.js";
import { readRunFailure } from "../src/operator/failure-classification.js";
import type { RunRecord, RunStore } from "../src/records/contracts.js";
import type { RepositoryEvidenceCollector } from "../src/repository/contracts.js";
import { LocalWorkflowSearchCoordinator } from "../src/search/local-workflow-coordinator.js";
import type { RepositorySecurityScanner } from "../src/security/contracts.js";
import {
  documentationPlanBindingDigest,
  OmittedFirstPassTargetError,
  PLAN_OUTSIDE_WRITE_ROOTS_CODE,
  PLAN_TARGET_NOT_WRITABLE_CODE,
  PlanWriteScopeError,
  type PlanWriteRefusal,
} from "../src/workflow-execution/plan-binding.js";
import type { DocumentationPlanWriteScope } from "../src/workflow-execution/runner-ports.js";
import {
  WorkflowRunner,
  type FirstPassDocumentationTargetControl,
} from "../src/workflow-execution/runner.js";
import { readyContextPreflight } from "./helpers.js";
import { scriptedEditorialProtocol } from "./helpers/editorial-protocol.js";
import {
  preservationSourceObserverFixture,
  sourceObligationObserverFixture,
  verificationFixture,
} from "./helpers/verification.js";

type Mode = "update" | "restructure";

const REVISION = "a".repeat(40);
const INSTRUCTION = "Fix whatever is stale.";
const ROOTS = ["docs/", "fern/"];
/** The scope a local run without documentationRoots hands the runner. */
const LOCAL_SCOPE: DocumentationPlanWriteScope = documentationPlanWriteScope(
  undefined,
  "local-widen",
);
const WORKFLOW_FOR_MODE = {
  update: "update-documentation",
  restructure: "restructure-documentation",
} as const;

class MemoryStore implements RunStore {
  public records: RunRecord[] = [];
  public async save(record: RunRecord): Promise<void> {
    this.records.push(structuredClone(record));
  }
}

class PassingScanner implements RepositorySecurityScanner {
  public async scan() {
    return {
      ruleSet: "test-v1",
      status: "passed" as const,
      scannedFiles: 1,
      binaryFiles: 0,
      findings: [],
    };
  }
}

class NoChangeEvidence implements RepositoryEvidenceCollector {
  public async capture(): Promise<ChangeEvidence> {
    return { files: [] };
  }
}

function plan(mode: Mode, paths: readonly string[]) {
  const pages = paths.map((path) => ({ path, disposition: mode }));
  const sourceBindings = paths.map((path) => ({ pagePath: path, sources: ["src/api.ts:1"] }));
  return {
    kind: "docsfab-documentation-plan" as const,
    schemaVersion: 1 as const,
    mode,
    pages,
    sourceBindings,
    digest: documentationPlanBindingDigest({ mode, pages, sourceBindings }),
  };
}

/** A planner that plans the pages at `paths`; every other step runs as a fixture. */
class PlanPathHarness implements AgentHarness, HostOperationExecutor {
  public readonly calls: string[] = [];
  public readonly inputs: HarnessStepInput[] = [];

  public constructor(
    private readonly mode: Mode,
    private readonly paths: readonly string[],
  ) {}

  public async runStep(input: HarnessStepInput): ReturnType<AgentHarness["runStep"]> {
    this.calls.push(input.step.id);
    this.inputs.push(input);
    const common = {
      model: { provider: "hosted", model: "test-model" },
      skill: { id: input.step.skill, contentSha256: "a".repeat(64) },
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2, turns: 1 },
    };
    if (input.step.id === "plan-documentation") {
      return {
        ...common,
        summary: `Plan the ${this.mode} of ${this.paths.join(", ")}.`,
        ...(await verificationFixture(input)),
        planBinding: plan(this.mode, this.paths),
      };
    }
    return { ...common, summary: `ran ${input.step.skill}`, ...(await verificationFixture(input)) };
  }
}

const workflowSearchFixture = {
  async search(input: Parameters<LocalWorkflowSearchCoordinator["search"]>[0]) {
    const repositoryPath = await mkdtemp(join(tmpdir(), "docsfab-plan-scope-search-"));
    try {
      await mkdir(join(repositoryPath, "docs"), { recursive: true });
      await mkdir(join(repositoryPath, "src"), { recursive: true });
      await writeFile(join(repositoryPath, "docs/guide.md"), "# Guide\n");
      await writeFile(join(repositoryPath, "src/api.ts"), "export const api = 1;\n");
      return await new LocalWorkflowSearchCoordinator().search({ ...input, repositoryPath });
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  },
};

/** The control first-pass binding hands the runner for an update that names `targetPaths`. */
function targetControl(targetPaths: readonly string[]): FirstPassDocumentationTargetControl {
  const body = {
    workflow: "update-documentation" as const,
    instructionSha256: createHash("sha256").update(INSTRUCTION.normalize("NFC")).digest("hex"),
    repositoryRevision: REVISION,
    targetPaths: [...targetPaths].sort(),
  };
  return {
    ...body,
    bodySha256: createHash("sha256").update(JSON.stringify(body), "utf8").digest("hex"),
  };
}

async function planRun(
  mode: Mode,
  path: string | readonly string[],
  options: {
    readonly planWriteScope?: DocumentationPlanWriteScope;
    readonly targetControl?: FirstPassDocumentationTargetControl;
  } = {},
) {
  const workflow = WORKFLOW_FOR_MODE[mode];
  const harness = new PlanPathHarness(mode, typeof path === "string" ? [path] : path);
  // UPDATE runs with its editorial host, as the CLI composes it.
  const editorial = mode === "update" ? scriptedEditorialProtocol(harness) : undefined;
  const record = await new WorkflowRunner({
    harness: editorial?.harness ?? harness,
    hostOperations: harness,
    store: new MemoryStore(),
    repositoryScanner: new PassingScanner(),
    contextPreflight: readyContextPreflight,
    repositoryEvidence: new NoChangeEvidence(),
    workflowSearch: workflowSearchFixture,
    sourceObligationObserver:
      mode === "restructure"
        ? preservationSourceObserverFixture(REVISION)
        : sourceObligationObserverFixture,
    outcomeProjector: new AuthoringQualityWorkflowOutcomeProjector(),
    ...(editorial ? { workflowBranchEvidence: editorial.workflowBranchEvidence } : {}),
    ...(options.planWriteScope ? { planWriteScope: options.planWriteScope } : {}),
    id: () => `run-${workflow}-plan-scope`,
  }).run(
    {
      workflow,
      workspacePath: "/tmp/docsfab-workspace/repository",
      repository: { sourcePath: "/tmp/repo", requestedRevision: "HEAD", revision: REVISION },
      instruction: INSTRUCTION,
      allowWrite: true,
    },
    options.targetControl,
  );
  return { record, harness };
}

function expectRefused(
  { record, harness }: Awaited<ReturnType<typeof planRun>>,
  refused: readonly { readonly path: string; readonly refusal: PlanWriteRefusal }[],
  roots: readonly string[],
): void {
  expect(record.status).toBe("failed");
  const planStep = record.steps.find((step) => step.id === "plan-documentation");
  const error = new PlanWriteScopeError(refused, roots);
  expect(planStep?.error).toBe(error.message);
  expect(readRunFailure(record)).toMatchObject({ class: "planning-refusal", code: error.code });
  expect(harness.calls).not.toContain("write-documentation");
}

/** Plan admission did not refuse the plan for its write scope, by either code. */
function expectNotScopeRefused(record: RunRecord): void {
  expect([PLAN_OUTSIDE_WRITE_ROOTS_CODE, PLAN_TARGET_NOT_WRITABLE_CODE]).not.toContain(
    readRunFailure(record)?.code,
  );
}

const outsideRoots = (path: string) => ({ path, refusal: "outside-roots" as const });
const protectedFile = (path: string) => ({ path, refusal: "protected" as const });
const notAPage = (path: string) => ({ path, refusal: "not-a-page" as const });

describe("a local run's plan admission keeps every write inside the roots", () => {
  it.each([
    ["update", protectedFile("AGENTS.md")],
    ["update", protectedFile("CLAUDE.md")],
    ["update", protectedFile("src/notes.md")],
    ["update", outsideRoots("notes/guide.md")],
    ["update", notAPage("docs/open-api/owners.yaml")],
    ["restructure", protectedFile("AGENTS.md")],
    ["restructure", protectedFile("CLAUDE.md")],
    ["restructure", protectedFile("src/notes.md")],
    ["restructure", outsideRoots("notes/guide.md")],
    ["restructure", notAPage("docs/open-api/owners.yaml")],
  ] as const)("refuses a %s plan that writes %j before any write step", async (mode, refused) => {
    expectRefused(
      await planRun(mode, refused.path, { planWriteScope: LOCAL_SCOPE }),
      [refused],
      ROOTS,
    );
  });

  // A page outside the roots names the roots; a file no root admits never does.
  it("codes each refusal by whether a root could ever hold the path", () => {
    expect(new PlanWriteScopeError([outsideRoots("notes/guide.md")], ROOTS).code).toBe(
      PLAN_OUTSIDE_WRITE_ROOTS_CODE,
    );
    for (const refused of [protectedFile("AGENTS.md"), notAPage("docs/open-api/owners.yaml")]) {
      const error = new PlanWriteScopeError([refused], ROOTS);
      expect(error.code).toBe(PLAN_TARGET_NOT_WRITABLE_CODE);
      expect(error.message).not.toContain("documentationRoots");
    }
    // A spec under a root is under it: the reason is the page type, never the roots.
    expect(
      new PlanWriteScopeError([notAPage("docs/open-api/owners.yaml")], ROOTS).message,
    ).toContain("docs/open-api/owners.yaml (not a Markdown or MDX page)");
  });

  // A restructure's navigation file outside the roots is fixed by a root on its
  // directory, so it codes as outside the roots and names that directory.
  it("codes a navigation file outside the roots as one a root on its directory fixes", () => {
    const navigation = { path: "fern/docs.yml", refusal: "navigation-outside-roots" as const };
    const alone = new PlanWriteScopeError([navigation], ["docs/"]);
    expect(alone.code).toBe(PLAN_OUTSIDE_WRITE_ROOTS_CODE);
    expect(alone.message).toContain(
      "fern/docs.yml (the repository's navigation file, outside the documentation write roots)",
    );
    expect(alone.message).toContain(
      "Remediation: add the directory of fern/docs.yml, fern, to documentationRoots in .docsfab.json and commit it, or ask for a restructure that leaves the navigation unchanged, then start a new run.",
    );
    expect(alone.message).not.toContain("by hand");
    // Beside a file no root admits, the plan is not writable whatever the roots.
    const mixed = new PlanWriteScopeError(
      [navigation, notAPage("docs/open-api/owners.yaml")],
      ["docs/"],
    );
    expect(mixed.code).toBe(PLAN_TARGET_NOT_WRITABLE_CODE);
    expect(mixed.message).toContain("by hand");
    expect(mixed.message).toContain("add the directory of fern/docs.yml, fern,");
  });

  // Every planned write is checked, not only the first in sorted order.
  it.each(["update", "restructure"] as const)(
    "refuses a %s plan whose page outside the roots sorts after a page inside them",
    async (mode) => {
      expectRefused(
        await planRun(mode, ["docs/guide.md", "notes/guide.md"], { planWriteScope: LOCAL_SCOPE }),
        [outsideRoots("notes/guide.md")],
        ROOTS,
      );
    },
  );

  it.each(["update", "restructure"] as const)(
    "admits a %s plan that keeps to the roots and reaches the write step",
    async (mode) => {
      const { record, harness } = await planRun(mode, "docs/guide.md", {
        planWriteScope: LOCAL_SCOPE,
      });
      expectNotScopeRefused(record);
      expect(harness.calls).toContain("write-documentation");
    },
  );

  it.each(["update", "restructure"] as const)(
    "leaves a %s plan with no write scope and no named page to the run's own authority (a hosted run)",
    async (mode) => {
      const { record, harness } = await planRun(mode, "AGENTS.md");
      expectNotScopeRefused(record);
      expect(harness.calls).toContain("write-documentation");
    },
  );
});

describe("an exact file root in the plan's write scope", () => {
  const FILE_ROOTS = ["README.md", "docs/", "tests/bats/README.md"];
  const fileScope = documentationPlanWriteScope(
    ["README.md", "docs", "tests/bats/README.md"],
    "local-widen",
    ["README.md", "tests/bats/README.md"],
  );

  it("resolves the configured entries into the roots the runner checks", () => {
    expect(fileScope.roots).toEqual(FILE_ROOTS);
  });

  it.each(["README.md", "tests/bats/README.md"])(
    "admits the file root %s itself and reaches the write step",
    async (path) => {
      const { record, harness } = await planRun("update", path, { planWriteScope: fileScope });
      expectNotScopeRefused(record);
      expect(harness.calls).toContain("write-documentation");
    },
  );

  it.each([
    ["a sibling", "RELEASE.md"],
    ["a sibling in the same directory", "tests/bats/other.md"],
    ["a longer name it is a prefix of", "README.md.md"],
    ["a page under it as if it were a directory", "README.md/x.md"],
    ["a letter-case variant", "readme.md"],
  ])("refuses %s of a file root, %s", async (_name, path) => {
    expectRefused(
      await planRun("update", path, { planWriteScope: fileScope }),
      [outsideRoots(path)],
      FILE_ROOTS,
    );
  });
});

describe("the pages a request named are the least a plan addresses", () => {
  const NAMED = ["docs/guide.md", "docs/setup.md"];

  it("admits a plan that adds a page inside the roots to the named pages", async () => {
    const { record, harness } = await planRun("update", [...NAMED, "docs/reference.md"], {
      planWriteScope: LOCAL_SCOPE,
      targetControl: targetControl(NAMED),
    });
    // Plan admission passes; this fixture's writer changes nothing, so the run
    // ends later, on its own evidence, not on the plan.
    expect(record.steps.find((step) => step.id === "plan-documentation")?.status).toBe("succeeded");
    expectNotScopeRefused(record);
    expect(harness.calls).toContain("write-documentation");
  });

  it("still refuses a plan that leaves a named page unaddressed", async () => {
    const { record, harness } = await planRun("update", ["docs/guide.md", "docs/reference.md"], {
      planWriteScope: LOCAL_SCOPE,
      targetControl: targetControl(NAMED),
    });
    expect(record.status).toBe("failed");
    expect(record.steps.find((step) => step.id === "plan-documentation")?.error).toBe(
      new OmittedFirstPassTargetError(["docs/setup.md"], "update").message,
    );
    expect(readRunFailure(record)?.code).toBe("omitted-mandatory-obligation");
    expect(harness.calls).not.toContain("write-documentation");
  });

  it("refuses a page the plan adds outside the roots, with a code", async () => {
    expectRefused(
      await planRun("update", [...NAMED, "notes/guide.md"], {
        planWriteScope: LOCAL_SCOPE,
        targetControl: targetControl(NAMED),
      }),
      [outsideRoots("notes/guide.md")],
      ROOTS,
    );
  });

  // With no roots to read, the safe scope is the named pages themselves.
  it("confines a run bound to named pages with no write scope to those pages", async () => {
    expectRefused(
      await planRun("update", [...NAMED, "docs/reference.md"], {
        targetControl: targetControl(NAMED),
      }),
      [outsideRoots("docs/reference.md")],
      NAMED,
    );
  });
});

describe("the planner is told the write scope its plan admission checks", () => {
  function plannerGuidance(run: Awaited<ReturnType<typeof planRun>>) {
    const planners = run.harness.inputs.filter((input) => input.step.id === "plan-documentation");
    expect(planners).toHaveLength(1);
    // No other step is told.
    expect(
      run.harness.inputs.filter(
        (input) => input.step.id !== "plan-documentation" && input.planWriteGuidance !== undefined,
      ),
    ).toEqual([]);
    return planners[0]!.planWriteGuidance;
  }

  it.each(["update", "restructure"] as const)(
    "tells a %s planner a local run's directory roots",
    async (mode) => {
      const run = await planRun(mode, "docs/guide.md", { planWriteScope: LOCAL_SCOPE });
      expect(plannerGuidance(run)).toEqual({
        directoryRoots: ["docs/", "fern/"],
        fileRoots: [],
        navigationFiles: [],
      });
    },
  );

  it("passes only a validated target inside the local root to planner guidance", async () => {
    const run = await planRun("update", "docs/guide.md", {
      planWriteScope: LOCAL_SCOPE,
      targetControl: targetControl(["docs/guide.md"]),
    });
    expect(plannerGuidance(run)).toEqual({
      directoryRoots: ["docs/", "fern/"],
      fileRoots: [],
      navigationFiles: [],
      boundTargets: ["docs/guide.md"],
    });
  });

  it("refuses an injected out-of-root target before labeling it authorized", async () => {
    const run = await planRun("update", "docs/guide.md", {
      planWriteScope: LOCAL_SCOPE,
      targetControl: targetControl(["notes/guide.md"]),
    });
    expect(run.record.status).toBe("failed");
    expect(readRunFailure(run.record)).toMatchObject({
      class: "planning-refusal",
      code: PLAN_OUTSIDE_WRITE_ROOTS_CODE,
    });
    expect(run.harness.inputs.some((input) => input.step.id === "plan-documentation")).toBe(false);
  });

  it("tells the planner a run's file roots apart from its directory roots", async () => {
    const run = await planRun("update", "README.md", {
      planWriteScope: documentationPlanWriteScope(
        ["README.md", "site/content", "tests/bats/README.md"],
        "local-widen",
        ["README.md", "tests/bats/README.md"],
      ),
    });
    expect(plannerGuidance(run)).toEqual({
      directoryRoots: ["site/content/"],
      fileRoots: ["README.md", "tests/bats/README.md"],
      navigationFiles: [],
    });
  });

  it("tells a run bound to named pages with no write scope those pages", async () => {
    const run = await planRun("update", ["docs/guide.md", "docs/setup.md"], {
      targetControl: targetControl(["docs/setup.md", "docs/guide.md"]),
    });
    expect(plannerGuidance(run)).toEqual({
      directoryRoots: [],
      fileRoots: ["docs/guide.md", "docs/setup.md"],
      navigationFiles: [],
      boundTargets: ["docs/guide.md", "docs/setup.md"],
    });
  });

  it.each(["update", "restructure"] as const)(
    "tells a %s planner nothing when the run keeps its own authority (a hosted run)",
    async (mode) => {
      const run = await planRun(mode, "docs/guide.md");
      expect(plannerGuidance(run)).toBeUndefined();
    },
  );
});
