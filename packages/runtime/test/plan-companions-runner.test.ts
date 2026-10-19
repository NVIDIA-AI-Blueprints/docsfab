// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Navigation companions and reachability labels through the real
 * `WorkflowRunner`: a RESTRUCTURE run in a workspace shaped like the pilot's
 * metrics SDK, its planner, its writer, and the records and findings the run
 * leaves behind.
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AuthoringQualityWorkflowOutcomeProjector } from "../src/evaluation-report/authoring-outcome-projector.js";
import type {
  AgentHarness,
  HarnessStepInput,
  HostOperationExecutor,
} from "../src/execution/contracts.js";
import type { ChangeEvidence } from "../src/impact/contracts.js";
import type { RunRecord, RunStore } from "../src/records/contracts.js";
import type { RepositoryEvidenceCollector } from "../src/repository/contracts.js";
import { projectReviewFindingsFromRun } from "../src/review/findings.js";
import { LocalWorkflowSearchCoordinator } from "../src/search/local-workflow-coordinator.js";
import type { RepositorySecurityScanner } from "../src/security/contracts.js";
import {
  documentationPlanBindingDigest,
  documentationPlanWritePaths,
  type DocumentationPageDisposition,
} from "../src/workflow-execution/plan-binding.js";
import type { NavigationLabelV1 } from "../src/workflow-execution/plan-companions.js";
import { WorkflowRunner } from "../src/workflow-execution/runner.js";
import { documentationPlanWriteScope } from "../src/cli/first-pass.js";
import { readyContextPreflight } from "./helpers.js";
import { preservationSourceObserverFixture, verificationFixture } from "./helpers/verification.js";

const REVISION = "a".repeat(40);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** Shaped like the pilot's metrics SDK: stubs that point back to the index. */
const METRICS_SDK: Record<string, string> = {
  "nav.json": '{"version":"2","items":[{"label":"SDK reference","path":"docs/index.md"}]}\n',
  "docs/index.md": "# SDK reference\n\n- [SDK](sdk.md)\n",
  "docs/sdk.md": "# SDK\n\nInstall, client, and sending.\n",
  "docs/install.md": "# Install\n\nMoved. See [the index](index.md).\n",
  "docs/client.md": "# Client\n\nMoved. See [the index](index.md).\n",
};

const PAGES: readonly { path: string; disposition: DocumentationPageDisposition }[] = [
  { path: "docs/client.md", disposition: "move" },
  { path: "docs/install.md", disposition: "move" },
  { path: "docs/sdk.md", disposition: "split" },
];

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

function plannedBinding(
  pages: readonly { path: string; disposition: DocumentationPageDisposition }[],
  extra: Record<string, unknown> = {},
) {
  const mode = "restructure" as const;
  const sourceBindings = pages
    .filter((page) => page.disposition !== "retain" && page.disposition !== "out-of-scope")
    .map((page) => ({ pagePath: page.path, sources: ["README.md"] }));
  const body = { mode, pages: [...pages], sourceBindings, ...extra };
  return {
    kind: "docsfab-documentation-plan" as const,
    schemaVersion: 1 as const,
    ...body,
    digest: documentationPlanBindingDigest(
      body as Parameters<typeof documentationPlanBindingDigest>[0],
    ),
  };
}

interface Scenario {
  files?: Record<string, string>;
  pages?: readonly { path: string; disposition: DocumentationPageDisposition }[];
  /** What the writer leaves in the workspace; null deletes the file. */
  writes?: Record<string, string | null>;
  plannerExtra?: Record<string, unknown>;
  documentationCompanionGrant?: readonly string[];
  /** A local run's documentation write roots, as `.docsfab.json` configures them. */
  documentationRoots?: {
    readonly configured: readonly string[];
    readonly files: readonly string[];
  };
}

class RestructureHarness implements AgentHarness, HostOperationExecutor {
  public readonly writerAllowlists: (readonly string[])[] = [];

  public constructor(private readonly scenario: Scenario) {}

  public async runStep(input: HarnessStepInput): ReturnType<AgentHarness["runStep"]> {
    const common = {
      model: { provider: "hosted", model: "test-model" },
      skill: { id: input.step.skill, contentSha256: "a".repeat(64) },
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2, turns: 1 },
    };
    if (input.step.id === "plan-documentation") {
      return {
        ...common,
        summary: "Plan the restructure of the SDK reference.",
        ...(await verificationFixture(input)),
        planBinding: plannedBinding(this.scenario.pages ?? PAGES, this.scenario.plannerExtra),
      };
    }
    if (input.step.id === "write-documentation") {
      // The writer's allowlist is exactly what the Pi harness grants.
      this.writerAllowlists.push(documentationPlanWritePaths(input.planBinding!));
      for (const [path, content] of Object.entries(this.scenario.writes ?? {})) {
        const target = join(input.repositoryPath, path);
        if (content === null) await rm(target);
        else {
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, content);
        }
      }
      return {
        ...common,
        summary: "Restructured the SDK reference.",
        tools: {
          totalCalls: 1,
          failedCalls: 0,
          byTool: [{ name: "write", calls: 1, failures: 0 }],
        },
      };
    }
    return { ...common, summary: `ran ${input.step.skill}`, ...(await verificationFixture(input)) };
  }
}

async function workspaceOf(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "docsfab-companions-run-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

async function runRestructure(scenario: Scenario) {
  const workspacePath = await workspaceOf(scenario.files ?? METRICS_SDK);
  const harness = new RestructureHarness(scenario);
  const store = new MemoryStore();
  const changed = Object.keys(scenario.writes ?? {}).sort();
  const evidence: RepositoryEvidenceCollector = {
    async capture(): Promise<ChangeEvidence> {
      const patch = changed.map((path) => `diff --git a/${path} b/${path}\n`).join("");
      return {
        files: changed.map((path) => ({ path, status: "modified" as const })),
        patch: {
          sha256: createHash("sha256").update(patch).digest("hex"),
          byteLength: patch.length,
          lineCount: changed.length,
          artifactPath: ".docsfab/patches/companions.patch",
          format: "git-diff",
        },
      };
    },
  };
  const searchRoot = await workspaceOf({ "docs/sdk.md": "# SDK\n" });
  const record = await new WorkflowRunner({
    harness,
    hostOperations: harness,
    store,
    repositoryScanner: new PassingScanner(),
    contextPreflight: readyContextPreflight,
    repositoryEvidence: evidence,
    workflowSearch: {
      search: (input) =>
        new LocalWorkflowSearchCoordinator().search({ ...input, repositoryPath: searchRoot }),
    },
    sourceObligationObserver: preservationSourceObserverFixture(REVISION),
    outcomeProjector: new AuthoringQualityWorkflowOutcomeProjector(),
    ...(scenario.documentationCompanionGrant
      ? { documentationCompanionGrant: scenario.documentationCompanionGrant }
      : {}),
    ...(scenario.documentationRoots
      ? {
          planWriteScope: documentationPlanWriteScope(
            scenario.documentationRoots.configured,
            "local-widen",
            scenario.documentationRoots.files,
          ),
        }
      : {}),
    id: () => "run-restructure-companions",
  }).run({
    workflow: "restructure-documentation",
    workspacePath,
    repository: { sourcePath: "/tmp/repo", requestedRevision: "HEAD", revision: REVISION },
    instruction: "Restructure the SDK reference into task pages.",
    allowWrite: true,
  });
  return { record, harness, store };
}

function step(record: RunRecord, id: string) {
  const found = record.steps.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`The run record has no step named ${id} to inspect.`);
  return found;
}

const INDEX_COMPANION = {
  path: "docs/index.md",
  role: "companion-index",
  baseSha256: createHash("sha256").update(METRICS_SDK["docs/index.md"]!).digest("hex"),
};

describe("a local restructure's companions keep inside its write roots", () => {
  it("attaches the docs/ index when the roots cover it", async () => {
    const { record, harness } = await runRestructure({
      documentationRoots: { configured: ["docs"], files: [] },
      writes: {
        "docs/index.md":
          "# SDK reference\n\n- [Install](install.md)\n- [SDK](sdk.md)\n- [Client](client.md)\n",
      },
    });
    expect(record.status, record.error).toBe("succeeded");
    expect(step(record, "plan-documentation").planBinding?.navigationCompanions).toEqual([
      INDEX_COMPANION,
    ]);
    expect(harness.writerAllowlists).toEqual([
      ["docs/client.md", "docs/index.md", "docs/install.md", "docs/sdk.md"],
    ]);
  });

  it("labels the docs/ index instead of granting it when the roots leave it out", async () => {
    // File roots cover the pages the plan moves, but not the index beside them.
    const pages = ["docs/client.md", "docs/install.md", "docs/sdk.md"];
    const { record, harness } = await runRestructure({
      documentationRoots: { configured: pages, files: pages },
    });
    const planner = step(record, "plan-documentation");
    expect(planner.status).toBe("succeeded");
    expect(planner.planBinding?.navigationCompanions).toBeUndefined();
    expect(planner.navigationLabels).toEqual([
      { code: "navigation-companion-not-granted", path: "docs/index.md", grant: pages },
    ]);
    expect(harness.writerAllowlists).toEqual([pages]);
  });
});

describe("restructure plan admission with a navigation companion", () => {
  it("admits the index into the writer's allowlist and labels nothing once linked", async () => {
    const { record, harness } = await runRestructure({
      writes: {
        "docs/index.md":
          "# SDK reference\n\n- [Install](install.md)\n- [SDK](sdk.md)\n- [Client](client.md)\n",
      },
    });
    expect(record.status, record.error).toBe("succeeded");
    const planner = step(record, "plan-documentation");
    expect(planner.planBinding?.navigationCompanions).toEqual([INDEX_COMPANION]);
    expect(planner.navigationLabels).toBeUndefined();
    expect(harness.writerAllowlists).toEqual([
      ["docs/client.md", "docs/index.md", "docs/install.md", "docs/sdk.md"],
    ]);
    expect(step(record, "write-documentation").navigationLabels).toBeUndefined();
    expect(
      projectReviewFindingsFromRun(record).findings.map((finding) => finding.code),
    ).not.toContain("navigation-unreachable-page");
  });

  it("labels each page left unlinked after the write and lets the run finish", async () => {
    const { record } = await runRestructure({
      writes: { "docs/index.md": "# SDK reference\n\n- [SDK](sdk.md)\n- [Install](install.md)\n" },
    });
    expect(record.status, record.error).toBe("succeeded");
    const expected: NavigationLabelV1[] = [
      {
        code: "navigation-unreachable-page",
        path: "docs/client.md",
        navigation: null,
        index: "docs/index.md",
      },
    ];
    expect(step(record, "write-documentation").navigationLabels).toEqual(expected);
    const findings = projectReviewFindingsFromRun(record).findings.filter((finding) =>
      finding.code.startsWith("navigation-"),
    );
    expect(findings).toEqual([
      expect.objectContaining({
        id: "navigation:navigation-unreachable-page:docs/client.md",
        code: "navigation-unreachable-page",
        severity: "warning",
        path: "docs/client.md",
        origin: "deterministic",
      }),
    ]);
  });

  it("refuses an index edit that drops an existing link and admits no candidate", async () => {
    const { record } = await runRestructure({
      writes: { "docs/index.md": "# SDK reference\n\n- [Install](install.md)\n" },
    });
    expect(record.status).toBe("failed");
    expect(record.failure?.code).toBe("navigation-companion-link-removed");
    expect(record.failure?.class).toBe("model-content");
    expect(step(record, "write-documentation").status).toBe("failed");
  });

  it("applies preservation to an index the planner listed as its own page", async () => {
    const { record } = await runRestructure({
      pages: [...PAGES, { path: "docs/index.md", disposition: "restructure" }],
      writes: { "docs/index.md": "# SDK reference\n\n- [Install](install.md)\n" },
    });
    expect(step(record, "plan-documentation").planBinding?.navigationCompanions).toBeUndefined();
    expect(record.failure?.code).toBe("navigation-companion-link-removed");
  });

  it("refuses a planner result that carries host companions", async () => {
    const { record, harness } = await runRestructure({
      plannerExtra: {
        navigationCompanions: [
          { path: "docs/zz.md", role: "companion-index", baseSha256: "c".repeat(64) },
        ],
      },
    });
    expect(record.status).toBe("failed");
    expect(step(record, "plan-documentation").error).toBe(
      "A planner result cannot carry host navigation companions for the writer.",
    );
    expect(harness.writerAllowlists).toEqual([]);
  });
});

describe("navigation labels read back from a record", () => {
  it("names an uncatalogued limit label as a limitation instead of throwing", async () => {
    const { record } = await runRestructure({
      writes: {
        "docs/index.md":
          "# SDK reference\n\n- [Install](install.md)\n- [SDK](sdk.md)\n- [Client](client.md)\n",
      },
    });
    expect(record.status, record.error).toBe("succeeded");
    const writer = step(record, "write-documentation");
    const overrun = (name: string) => ({
      code: "navigation-not-checked",
      path: null,
      reason: "limit-exceeded",
      navigation: null,
      limit: { name, observed: 5, value: 4 },
    });
    // A catalogued name renders the run's own value.
    writer.navigationLabels = [overrun("repository.inventoryMaxEntries")] as NavigationLabelV1[];
    const known = projectReviewFindingsFromRun(record);
    expect(known.findings).toContainEqual(
      expect.objectContaining({
        id: "navigation:navigation-not-checked:run",
        summary: expect.stringContaining("5 exceeds repository.inventoryMaxEntries = 4 count."),
      }),
    );
    expect(known.limitations).not.toContain(
      "review-findings-invalid:write-documentation:navigation-labels",
    );
    // A name the catalog no longer declares, as a record from before a rename.
    writer.navigationLabels = [overrun("repository.renamedLimit")] as NavigationLabelV1[];
    const unknown = projectReviewFindingsFromRun(record);
    expect(unknown.limitations).toContain(
      "review-findings-invalid:write-documentation:navigation-labels",
    );
    expect(unknown.findings.map((finding) => finding.code)).not.toContain("navigation-not-checked");
  });
});

describe("restructure without a granted companion", () => {
  it("labels an index the hosted ceiling excludes and finishes without writing it", async () => {
    const { record, harness } = await runRestructure({
      documentationCompanionGrant: ["docs/client.md", "docs/install.md", "docs/sdk.md"],
      writes: { "docs/install.md": "# Install\n\nSteps.\n" },
    });
    expect(record.status, record.error).toBe("succeeded");
    const planner = step(record, "plan-documentation");
    expect(planner.planBinding?.navigationCompanions).toBeUndefined();
    expect(planner.navigationLabels).toEqual([
      {
        code: "navigation-companion-not-granted",
        path: "docs/index.md",
        grant: ["docs/client.md", "docs/install.md", "docs/sdk.md"],
      },
    ]);
    expect(harness.writerAllowlists).toEqual([
      ["docs/client.md", "docs/install.md", "docs/sdk.md"],
    ]);
  });

  it("labels explicit MkDocs navigation at the root once and never makes it a companion", async () => {
    const { record, harness } = await runRestructure({
      files: {
        "mkdocs.yml": "site_name: SDK\nnav:\n  - SDK: sdk.md\n  - Install: install.md\n",
        "docs/sdk.md": "# SDK\n",
        "docs/install.md": "# Install\n",
        "docs/client.md": "# Client\n",
      },
      writes: { "docs/install.md": "# Install\n\nSteps.\n" },
    });
    expect(record.status, record.error).toBe("succeeded");
    expect(step(record, "plan-documentation").navigationLabels).toEqual([
      {
        code: "navigation-companion-not-granted",
        path: "mkdocs.yml",
        grant: ["docs/", "fern/"],
      },
    ]);
    expect(harness.writerAllowlists.flat()).not.toContain("mkdocs.yml");
    expect(step(record, "write-documentation").navigationLabels).toEqual([
      {
        code: "navigation-unreachable-page",
        path: "docs/client.md",
        navigation: "mkdocs.yml",
        index: null,
      },
    ]);
  });

  it("labels a run with neither navigation nor an index as not checked", async () => {
    const { record } = await runRestructure({
      files: {
        "docs/sdk.md": "# SDK\n",
        "docs/install.md": "# Install\n",
        "docs/client.md": "# Client\n",
      },
      writes: { "docs/install.md": "# Install\n\nSteps.\n" },
    });
    expect(record.status, record.error).toBe("succeeded");
    expect(step(record, "plan-documentation").planBinding?.navigationCompanions).toBeUndefined();
    expect(step(record, "write-documentation").navigationLabels).toEqual([
      {
        code: "navigation-not-checked",
        path: null,
        reason: "no-navigation-or-index",
        navigation: null,
        limit: null,
      },
    ]);
  });
});
