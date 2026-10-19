// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { symlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import { createLocalWorkflowApplicationServices } from "../src/application/dependencies.js";
import { handleRunsCommand } from "../src/cli/commands/runs.js";
import { withLocalWorkflowRun } from "../src/cli/run/local-workflow.js";
import type { AgentHarness, HarnessStepInput, RunRequest } from "../src/execution/contracts.js";
import type { RunRecord } from "../src/records/contracts.js";
import type { RepositoryEvidenceCollector } from "../src/repository/contracts.js";
import { withRepositoryWorkspace } from "../src/repository/workspace/materialize.js";
import { canonicalDigest } from "../src/contract-kit/index.js";
import { projectReviewFindingsFromRun } from "../src/review/findings.js";
import {
  auditTemplateConformance,
  decodeTemplateAuditReport,
  mapPageToTemplate,
  retainedTemplateAuditReport,
  TEMPLATE_AUDIT_PAGE_BYTES_LIMIT,
  templateAuditReviewFindings,
  type TemplateAuditReportV1,
} from "../src/templates/audit.js";
import {
  TemplateAuditWorkflowOutcomeProjector,
  withoutInference,
} from "../src/templates/audit-operation.js";
import { listTemplates } from "../src/templates/catalog.js";
import type { GovernedTemplateBundle } from "../src/templates/contracts.js";
import { loadTemplateSet } from "../src/templates/load.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import { limit } from "../src/config/limits.js";
import { commitFixture, initFixtureRepo } from "./helpers/git.js";
import { temporaryRoots } from "./helpers/temp.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";
import { runtimeConfig } from "./support/execution-convergence.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const roots = temporaryRoots();
let bundle: GovernedTemplateBundle;
let templateIds: ReadonlySet<string>;

beforeAll(async () => {
  bundle = await loadTemplateSet(projectRoot);
  templateIds = new Set(listTemplates({ bundle }).templates.map((entry) => entry.id));
});

interface TemplateFixture {
  readonly template: string;
  readonly stem: string;
  readonly directory?: string;
  readonly title: string;
  readonly sections: readonly string[];
  /** A failing page uses this title instead of dropping its first section. */
  readonly failingTitle?: string;
}

/** One passing shape per path-mappable template, from each schema's required headings. */
const TEMPLATES: readonly TemplateFixture[] = [
  {
    template: "architecture-overview",
    stem: "architecture",
    title: "System Architecture",
    sections: ["Components", "Data Flow"],
  },
  {
    template: "beginner-tutorial",
    stem: "tutorial",
    title: "Build a Pipeline",
    sections: ["Prerequisites", "Concepts Overview", "Summary", "Next Steps"],
  },
  {
    template: "ecosystem",
    stem: "ecosystem",
    title: "Product Ecosystem",
    sections: ["Understanding the Product"],
  },
  {
    template: "environment-variables",
    stem: "environment-variables",
    title: "Environment Variables",
    sections: ["General Environment Variables"],
  },
  { template: "glossary", stem: "glossary", title: "Glossary", sections: ["A"] },
  {
    template: "helm-parameters",
    stem: "helm-parameters",
    title: "Helm Parameters",
    sections: ["General Helm Parameters"],
  },
  {
    template: "installation",
    stem: "installation",
    title: "Installation Guide",
    sections: ["Prerequisites", "Installation Methods", "Installation Verification"],
  },
  {
    template: "key-features",
    stem: "key-features",
    title: "Key Features",
    sections: ["Developer Tools"],
    failingTitle: "Highlights",
  },
  {
    template: "prerequisites",
    stem: "prerequisites",
    title: "Prerequisites",
    sections: ["Hardware Requirements", "Software Requirements"],
  },
  {
    template: "quickstart",
    stem: "quickstart",
    title: "Runner Quickstart",
    sections: ["Prerequisites", "Quickstart Steps", "What's Next"],
  },
  {
    template: "release-notes",
    directory: "release-notes",
    stem: "v1-2",
    title: "Release Notes 1.2",
    sections: ["Release 1.2"],
  },
  {
    template: "troubleshooting",
    directory: "troubleshooting",
    stem: "network-errors",
    title: "Troubleshoot Network Errors",
    sections: ["Symptoms"],
  },
];
const PASSING_PER_TEMPLATE = 9;
const FAILING_PER_TEMPLATE = 7;

function page(title: string, sections: readonly string[], style: "fern" | "markdown"): string {
  const body = sections.map((section) => `## ${section}\n\nContent for ${section}.\n`).join("\n");
  return style === "fern"
    ? `---\ntitle: ${title}\ndescription: Fixture page.\n---\n\nIntroduction.\n\n${body}`
    : `# ${title}\n\nIntroduction.\n\n${body}`;
}

/**
 * A documentation tree of more than 200 pages: passing and failing pages for
 * every path-mappable template, a frontmatter-declared page, a MyST page, the
 * quickstart shape seen in DocsFab's own docs, and pages with no confident
 * template.
 */
function fixtureTree(): {
  files: Record<string, string>;
  passing: string[];
  failing: string[];
  unmapped: Record<string, string>;
} {
  const files: Record<string, string> = {};
  const passing: string[] = [];
  const failing: string[] = [];
  for (const fixture of TEMPLATES) {
    for (let index = 0; index < PASSING_PER_TEMPLATE + FAILING_PER_TEMPLATE; index += 1) {
      const passes = index < PASSING_PER_TEMPLATE;
      const style = index % 2 === 0 ? "fern" : "markdown";
      const path = fixture.directory
        ? `docs/${fixture.directory}/p${index}-${fixture.stem}.md`
        : `docs/area-${index}/${fixture.stem}.md`;
      files[path] = passes
        ? page(fixture.title, fixture.sections, style)
        : fixture.failingTitle
          ? page(fixture.failingTitle, fixture.sections, style)
          : page(fixture.title, fixture.sections.slice(1), style);
      (passes ? passing : failing).push(path);
    }
  }
  files["docs/guides/start-here.md"] =
    `---\ntitle: Start Here Quickstart\ntemplate: quickstart\n---\n\n## Prerequisites\n\n## Steps\n\n## Next Steps\n`;
  passing.push("docs/guides/start-here.md");
  files["docs/myst/myst-quickstart.md"] =
    "# Quickstart\n\n```{note}\nMyST directive.\n```\n\n## Prerequisites\n\n## Quickstart Steps\n\n## What's Next\n";
  passing.push("docs/myst/myst-quickstart.md");
  files["docs/get-started/live-quickstart.md"] = page(
    "Live Agent Quickstart",
    ["Before You Start", "Start the Agent", "What's Next"],
    "fern",
  );
  failing.push("docs/get-started/live-quickstart.md");
  const unmapped: Record<string, string> = {
    "README.md": "section-index",
    "docs/index.md": "section-index",
    "docs/area-0/index.md": "section-index",
    "docs/troubleshooting/installation.md": "ambiguous-template-signal",
    "docs/guides/concept.md": "no-template-signal",
    "docs/guides/house-style.md": "unknown-declared-template",
    "docs/reports/lens-architecture.md": "no-template-signal",
  };
  for (const name of ["overview", "how-it-works", "architecture-decisions", "faq", "cli-flags"]) {
    unmapped[`docs/concepts/${name}.md`] = "no-template-signal";
  }
  for (const path of Object.keys(unmapped)) {
    files[path] =
      path === "docs/guides/concept.md"
        ? "---\ntitle: Concepts\ncontent_type: concept\n---\n\n## Overview\n"
        : path === "docs/guides/house-style.md"
          ? "---\ntitle: House Style\ntemplate: house-style\n---\n\n## Overview\n"
          : page("Overview", ["Details"], "markdown");
  }
  return { files, passing, failing, unmapped };
}

class CountingHarness implements AgentHarness {
  calls = 0;

  async inspectSkill(input: HarnessStepInput) {
    return { id: input.step.skill, contentSha256: "a".repeat(64) };
  }

  async runStep(): Promise<never> {
    this.calls += 1;
    throw new Error("The template audit fixture harness must not be called.");
  }
}

function audit(files: Record<string, string>): TemplateAuditReportV1 {
  return auditTemplateConformance({
    bundle,
    pages: Object.entries(files).map(([path, content]) => ({ path, content })),
    scope: COMPLETE_SCOPE,
  });
}

const COMPLETE_SCOPE = {
  kind: "documentation-set",
  enumeration: "complete",
  omittedEntries: 0,
  limitations: [],
} as const;

async function captureConsole(action: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (message?: unknown) => lines.push(String(message ?? ""));
  try {
    await action();
  } finally {
    console.log = originalLog;
  }
  return lines.join("\n");
}

describe("template page mapping", () => {
  const map = (path: string, content = "## Body\n") =>
    mapPageToTemplate({ path, content, templateIds });

  it("lets an explicit template key win and a generic page type fall through", () => {
    expect(
      map("docs/troubleshooting/start.md", "---\ntemplate: quickstart-gfm\n---\n## Body\n"),
    ).toMatchObject({
      status: "mapped",
      templateId: "quickstart-gfm",
      basis: "frontmatter",
      signal: "template: quickstart-gfm",
    });
    expect(
      map("docs/a.md", "---\ntemplate: quickstart\ncontent_type: concept\n---\n"),
    ).toMatchObject({ status: "mapped", templateId: "quickstart-gfm" });
    expect(
      map("docs/a.md", "---\ntemplate: quickstart\ncontent_type: glossary\n---\n"),
    ).toMatchObject({ status: "mapped", templateId: "quickstart-gfm" });
    expect(map("docs/a.md", "---\npage_type: Release Notes\n---\n")).toMatchObject({
      status: "mapped",
      templateId: "release-notes-gfm",
      signal: "page_type: Release Notes",
    });
    expect(
      map("docs/get-started/installation.md", "---\ncontent_type: concept\n---\n"),
    ).toMatchObject({ status: "mapped", templateId: "installation-gfm", basis: "filename" });
    expect(map("docs/a.md", "---\ntemplate: house-style\n---\n")).toEqual({
      status: "unmapped",
      reason: "unknown-declared-template",
      candidates: [],
    });
    expect(map("docs/a.md", "---\npage_type: quickstart\ncontent_type: glossary\n---\n")).toEqual({
      status: "unmapped",
      reason: "ambiguous-template-signal",
      candidates: ["glossary", "quickstart"],
    });
    expect(map("docs/a.md", "---\r\ntemplate: quickstart\r\n---\r\n## Body\r\n")).toMatchObject({
      status: "mapped",
      templateId: "quickstart-gfm",
    });
  });

  it("maps exact filenames, genre suffixes, and template directories distinctly", () => {
    expect(map("docs/get-started/runner-quickstart.md")).toMatchObject({
      status: "mapped",
      templateId: "quickstart-gfm",
      basis: "filename-suffix",
      signal: "runner-quickstart",
    });
    expect(map("docs/get-started/quickstart.md")).toMatchObject({
      templateId: "quickstart-gfm",
      basis: "filename",
      signal: "quickstart",
    });
    expect(map("docs/about/architecture.md")).toMatchObject({
      templateId: "architecture-overview-gfm",
      basis: "filename",
    });
    for (const path of [
      "planning/reports/rca/lens-architecture.md",
      ".docsfab/reviews/editorial-and-information-architecture.md",
      "docs/advanced-tutorial.md",
      "docs/workflows/runtime-installation-and-readiness.md",
    ]) {
      expect(map(path), path).toMatchObject({ status: "unmapped", reason: "no-template-signal" });
    }
    expect(map("docs/troubleshooting/setup/brev-cli.md")).toMatchObject({
      templateId: "troubleshooting-gfm",
      basis: "directory",
      signal: "troubleshooting/",
    });
    expect(map("docs/troubleshooting/index.md")).toMatchObject({ reason: "section-index" });
    expect(map("docs/troubleshooting/install.md")).toEqual({
      status: "unmapped",
      reason: "ambiguous-template-signal",
      candidates: ["installation", "troubleshooting"],
    });
    expect(map("docs/reference.rst")).toMatchObject({ reason: "unsupported-format" });
  });

  it("selects the MyST variant from a directive, a role, or a target", () => {
    for (const content of [
      "```{note}\nMyST.\n```\n",
      "   :::{important}\n   Indented.\n   :::\n",
      "Refer to {ref}`install-label`.\n",
      "(quickstart-label)=\n\n# Quickstart\n",
    ]) {
      expect(map("docs/quickstart.md", content), content).toMatchObject({
        templateId: "quickstart-myst",
      });
    }
    expect(map("docs/quickstart.md", "Use `{name}` in the config.\n")).toMatchObject({
      templateId: "quickstart-gfm",
    });
  });
});

describe("template conformance audit", () => {
  it("audits a tree of more than 200 pages with a finding for every failing mapped page", () => {
    const tree = fixtureTree();
    const enumerated = Object.keys(tree.files).length;
    expect(enumerated).toBeGreaterThan(200);
    const report = audit(tree.files);

    expect(report.coverage).toEqual({
      enumerated,
      checked: tree.passing.length + tree.failing.length,
      passed: tree.passing.length,
      failed: tree.failing.length,
      unmapped: Object.keys(tree.unmapped).length,
      refused: 0,
    });
    const byPath = new Map(report.pages.map((entry) => [entry.path, entry]));
    for (const path of tree.passing) expect(byPath.get(path)).toMatchObject({ status: "passed" });
    for (const path of tree.failing) {
      const result = byPath.get(path)!;
      expect(result.status, path).toBe("failed");
      expect(
        "findings" in result &&
          result.findings.some((finding) => finding.rule === "missing-required-heading"),
        path,
      ).toBe(true);
    }
    for (const [path, reason] of Object.entries(tree.unmapped)) {
      expect(byPath.get(path), path).toMatchObject({ status: "unmapped", reason });
    }
    expect(byPath.get("docs/get-started/live-quickstart.md")).toMatchObject({
      templateId: "quickstart-gfm",
      h1Source: "frontmatter-title",
      findings: [
        { rule: "missing-required-heading", severity: "error", expected: "h2:(Quickstart )?Steps" },
        { rule: "missing-required-heading", severity: "error", expected: "h2:Prerequisites" },
      ],
    });
    expect(byPath.get("docs/myst/myst-quickstart.md")).toMatchObject({
      templateId: "quickstart-myst",
      h1Source: "markdown",
    });
  });

  it("projects each structural finding as a deterministic review finding", () => {
    const report = audit(fixtureTree().files);
    const findings = templateAuditReviewFindings(report);
    const errorCount = report.pages.reduce(
      (total, entry) =>
        total +
        ("findings" in entry
          ? entry.findings.filter((finding) => finding.severity === "error").length
          : 0),
      0,
    );
    expect(findings.filter((finding) => finding.severity === "error")).toHaveLength(errorCount);
    expect(findings.every((finding) => finding.origin === "deterministic")).toBe(true);
    expect(findings).toContainEqual(
      expect.objectContaining({
        code: "template:missing-required-heading",
        path: "docs/get-started/live-quickstart.md",
        summary:
          'Missing a required H2 heading matching "Prerequisites" for template quickstart-gfm.',
      }),
    );
  });

  it("refuses a retained report whose page results or coverage were edited", () => {
    const report = audit(fixtureTree().files);
    const round = JSON.parse(JSON.stringify(report)) as Record<string, unknown>;
    expect(decodeTemplateAuditReport(round)).toEqual(report);

    const flipped = JSON.parse(JSON.stringify(report)) as {
      pages: Array<{ status: string; findings?: unknown[] }>;
    };
    const failed = flipped.pages.find((entry) => entry.status === "failed")!;
    failed.status = "passed";
    failed.findings = [];
    expect(() => decodeTemplateAuditReport(flipped)).toThrow(/invalid/u);

    const recount = JSON.parse(JSON.stringify(report)) as { coverage: { passed: number } };
    recount.coverage.passed += 1;
    expect(() => decodeTemplateAuditReport(recount)).toThrow(/invalid/u);
  });

  it("refuses a resealed report whose page status disagrees with its findings", () => {
    const report = audit(fixtureTree().files);
    const reseal = (value: Record<string, unknown>) => {
      const { digest: _digest, ...body } = value;
      return { ...body, digest: canonicalDigest(body) };
    };
    const copy = () => JSON.parse(JSON.stringify(report)) as Record<string, unknown>;
    expect(decodeTemplateAuditReport(reseal(copy()))).toEqual(report);

    const tampered = copy() as unknown as {
      pages: Array<{ status: string }>;
      coverage: { passed: number; failed: number };
    };
    tampered.pages.find((entry) => entry.status === "failed")!.status = "passed";
    tampered.coverage.passed += 1;
    tampered.coverage.failed -= 1;
    expect(() =>
      decodeTemplateAuditReport(reseal(tampered as unknown as Record<string, unknown>)),
    ).toThrow("The template audit report is invalid: invalid-value.");
  });

  it("reads CRLF frontmatter and nested code fences the way a renderer does", () => {
    const report = audit({
      "docs/crlf-quickstart.md":
        "---\r\ntitle: CRLF Quickstart\r\n---\r\n\r\n## Prerequisites\r\n\r\n## Quickstart Steps\r\n\r\n## What's Next\r\n",
      "docs/fenced-quickstart.md": [
        "# Quickstart",
        "",
        "## Prerequisites",
        "",
        "````markdown",
        "```bash",
        "# Not a heading inside the outer fence",
        "```",
        "# Still inside the outer fence",
        "````",
        "",
        "## Quickstart Steps",
        "",
        "## What's Next",
        "",
      ].join("\n"),
    });
    expect(report.pages.map((entry) => [entry.path, entry.status])).toEqual([
      ["docs/crlf-quickstart.md", "passed"],
      ["docs/fenced-quickstart.md", "passed"],
    ]);
    expect(report.pages[0]).toMatchObject({ h1Source: "frontmatter-title" });
    expect(report.pages.flatMap((entry) => ("findings" in entry ? entry.findings : []))).toEqual(
      [],
    );
  });

  it("projects not-ready, inconclusive, and ready dispositions from host coverage", async () => {
    const projector = new TemplateAuditWorkflowOutcomeProjector();
    const outcome = async (files: Record<string, string>) => {
      const summary = JSON.stringify(audit(files));
      const record = {
        workflow: "audit-documentation",
        status: "succeeded",
        repository: { revision: "a".repeat(40) },
        steps: [
          {
            id: "audit-template-conformance",
            kind: "host-operation",
            skill: "audit-documentation",
            mode: "read-only",
            status: "succeeded",
            summary,
          },
        ],
      } as unknown as RunRecord;
      return projector.project(record);
    };
    const quickstart = page(
      "Quickstart",
      ["Prerequisites", "Quickstart Steps", "What's Next"],
      "fern",
    );

    expect(await outcome({ "docs/quickstart.md": quickstart })).toMatchObject({
      disposition: "ready",
      findings: [],
    });
    expect(
      await outcome({ "docs/quickstart.md": quickstart, "docs/overview.md": "## Body\n" }),
    ).toMatchObject({
      disposition: "inconclusive",
      limitations: ["template-audit-unmapped-pages"],
    });
    expect(
      await outcome({ "docs/quickstart.md": page("Quickstart", ["Steps"], "fern") }),
    ).toMatchObject({
      disposition: "not-ready",
      findings: [
        expect.objectContaining({ code: "template-structure-errors", kind: "product-gap" }),
      ],
    });
  });
});

describe("advisory template conformance on an authoring check step", () => {
  /** An authoring run whose documentation check step retained `summary`. */
  const authoringRun = (summary: string) =>
    ({
      workflow: "update-documentation",
      status: "succeeded",
      steps: [
        {
          id: "lint-documentation",
          title: "Lint documentation",
          kind: "host-operation",
          skill: "lint-documentation",
          mode: "read-only",
          status: "succeeded",
          summary,
        },
      ],
    }) as unknown as RunRecord;
  const checks = { status: "unavailable", coverage: "Fixture checks.", checks: [] };
  const conformance = () =>
    auditTemplateConformance({
      bundle,
      pages: [
        { path: "docs/troubleshooting.md", content: "# Troubleshooting Orbit\n" },
        { path: "docs/orbit.md", content: "# Orbit\n" },
        {
          path: "docs/huge-quickstart.md",
          refused: "page-too-large",
          observedBytes: 9,
          limitBytes: 8,
        },
      ],
      scope: { ...COMPLETE_SCOPE, kind: "focused-set" },
    });

  it("projects the report's findings and names unmapped and refused pages as limitations", () => {
    const projection = projectReviewFindingsFromRun(
      authoringRun(JSON.stringify({ ...checks, templateConformance: conformance() })),
    );
    expect(projection.findings).toEqual([
      expect.objectContaining({
        code: "template:missing-required-heading",
        path: "docs/troubleshooting.md",
        severity: "error",
        origin: "deterministic",
      }),
    ]);
    expect(projection.limitations).toEqual(
      expect.arrayContaining([
        "template-conformance-unmapped:no-template-signal:docs/orbit.md",
        "template-conformance-refused:page-too-large:docs/huge-quickstart.md",
        "review-findings-unparsed:lint-documentation",
      ]),
    );
    expect(projection.availability).toBe("partial");
  });

  it("projects an older check summary without the report exactly as before", () => {
    const projection = projectReviewFindingsFromRun(authoringRun(JSON.stringify(checks)));
    expect(projection.findings).toEqual([]);
    expect(projection.limitations).toEqual(["review-findings-unparsed:lint-documentation"]);
  });

  it("names an edited report as invalid and projects none of its findings", () => {
    const edited = JSON.parse(JSON.stringify(conformance())) as {
      coverage: { failed: number };
    };
    edited.coverage.failed += 1;
    const projection = projectReviewFindingsFromRun(
      authoringRun(JSON.stringify({ ...checks, templateConformance: edited })),
    );
    expect(projection.findings).toEqual([]);
    expect(projection.limitations).toContain(
      "review-findings-invalid:lint-documentation:template-conformance",
    );
  });
});

describe("audit-documentation workflow", () => {
  it("binds a harness that refuses every model call", async () => {
    const base = new CountingHarness();
    const harness = withoutInference(base);
    await expect(harness.runStep({} as HarnessStepInput)).rejects.toThrow("cannot call a model");
    expect(base.calls).toBe(0);
    const direct = withoutInference();
    await expect(direct.runStep({} as HarnessStepInput)).rejects.toThrow("cannot call a model");
    expect(direct.inspectSkill).toBeUndefined();
    expect(getWorkflow("audit-documentation").steps.map((step) => step.kind)).toEqual([
      "host-operation",
    ]);
  });

  it("assembles local services with the refusing harness and the template audit projector", {
    timeout: testTimeoutMs(30_000),
  }, async () => {
    const root = await roots.create("docsfab-template-audit-services-");
    const repository = resolve(root, "repository");
    const revision = await initFixtureRepo(repository, {
      "docs/quickstart.md": page("Quickstart", ["Prerequisites"], "fern"),
    });
    const base = new CountingHarness();
    await withRepositoryWorkspace(repository, revision, async (workspace) => {
      const assembly = await createLocalWorkflowApplicationServices({
        config: runtimeConfig(resolve(root, "state", "runs")),
        request: {
          workflow: "audit-documentation",
          workspacePath: workspace.path,
          repository: { sourcePath: repository, requestedRevision: revision, revision },
          allowWrite: false,
        } as RunRequest,
        workflow: getWorkflow("audit-documentation"),
        workspace,
        repositoryEvidence: {} as RepositoryEvidenceCollector,
        baseHarness: base,
      });
      await expect(assembly.services.harness.runStep({} as HarnessStepInput)).rejects.toThrow(
        "cannot call a model",
      );
      expect(assembly.services.outcomeProjector).toBeInstanceOf(
        TemplateAuditWorkflowOutcomeProjector,
      );
    });
    expect(base.calls).toBe(0);
  });

  it("runs offline over the fixture tree and shows findings and coverage in runs show", {
    timeout: testTimeoutMs(60_000),
  }, async () => {
    const root = await roots.create("docsfab-template-audit-run-");
    const repository = resolve(root, "repository");
    const stateDirectory = resolve(root, "state", "runs");
    const tree = fixtureTree();
    const revision = await initFixtureRepo(repository, tree.files);
    const harness = new CountingHarness();

    const record = await withLocalWorkflowRun(
      {
        workflow: "audit-documentation",
        repositoryPath: repository,
        revision,
        allowWrite: false,
        releaseGate: false,
        verbose: false,
        json: false,
        showScan: false,
      },
      runtimeConfig(stateDirectory),
      {
        silent: true,
        output: { log: () => undefined, error: () => undefined },
        executionHarness: harness,
      },
      async ({ execution }) => ({ value: execution.record }),
    );

    expect(harness.calls).toBe(0);
    expect(record!.status).toBe("succeeded");
    expect(record!.models).toEqual([]);
    expect(record!.steps.map((step) => [step.id, step.kind, step.status])).toEqual([
      ["audit-template-conformance", "host-operation", "succeeded"],
    ]);
    const report = retainedTemplateAuditReport(record!)!;
    const enumerated = Object.keys(tree.files).length;
    expect(report.coverage).toEqual({
      enumerated,
      checked: tree.passing.length + tree.failing.length,
      passed: tree.passing.length,
      failed: tree.failing.length,
      unmapped: Object.keys(tree.unmapped).length,
      refused: 0,
    });
    expect(record!.workflowOutcome).toMatchObject({
      disposition: "not-ready",
      limitations: ["template-audit-unmapped-pages"],
    });
    const projection = projectReviewFindingsFromRun(record!);
    expect(projection.availability).toBe("partial");
    expect(projection.limitations).toEqual([
      `template-audit-unmapped:${Object.keys(tree.unmapped).length}`,
    ]);
    expect(projection.findings.length).toBeGreaterThan(0);

    const human = await captureConsole(() =>
      handleRunsCommand(["show", record!.id, "--state-dir", stateDirectory]),
    );
    expect(human).toContain(
      `Template audit: ${report.coverage.checked} of ${enumerated} pages checked (${report.coverage.passed} passed, ${report.coverage.failed} failed); ${report.coverage.unmapped} unmapped; 0 refused.`,
    );
    expect(human).toContain("Unmapped pages: 3 (section-index).");
    expect(human).toContain("REVIEW FINDINGS");
    expect(human).toContain(
      `Read every per-page finding: ${report.coverage.failed} of ${report.coverage.checked} checked pages failed their template.`,
    );
    expect(human).not.toContain("capability or policy wall");
    expect(human).toContain("template:missing-required-heading");

    const json = JSON.parse(
      await captureConsole(() =>
        handleRunsCommand(["show", record!.id, "--json", "--state-dir", stateDirectory]),
      ),
    ) as { reviewFindings?: Array<{ origin?: string; path?: string }> };
    expect(json.reviewFindings?.length).toBeGreaterThan(0);
    expect(json.reviewFindings?.every((finding) => finding.origin === "deterministic")).toBe(true);
  });

  it("audits only the named page when the run names one", {
    timeout: testTimeoutMs(30_000),
  }, async () => {
    const root = await roots.create("docsfab-template-audit-focused-");
    const repository = resolve(root, "repository");
    const revision = await initFixtureRepo(repository, {
      "docs/get-started/runner-quickstart.md": page("Runner Quickstart", ["Steps"], "fern"),
      "docs/get-started/installation.md": page("Installation", ["Prerequisites"], "fern"),
    });
    const record = await withLocalWorkflowRun(
      {
        workflow: "audit-documentation",
        repositoryPath: repository,
        revision,
        contextTarget: { sourcePath: "docs/get-started/runner-quickstart.md" },
        allowWrite: false,
        releaseGate: false,
        verbose: false,
        json: false,
        showScan: false,
      },
      runtimeConfig(resolve(root, "state", "runs")),
      {
        silent: true,
        output: { log: () => undefined, error: () => undefined },
        executionHarness: new CountingHarness(),
      },
      async ({ execution }) => ({ value: execution.record }),
    );
    const report = retainedTemplateAuditReport(record!)!;
    expect(report.scope.kind).toBe("focused-set");
    expect(report.pages.map((entry) => [entry.path, entry.status])).toEqual([
      ["docs/get-started/runner-quickstart.md", "failed"],
    ]);
  });

  async function runAudit(repository: string, revision: string, stateDirectory: string) {
    const record = await withLocalWorkflowRun(
      {
        workflow: "audit-documentation",
        repositoryPath: repository,
        revision,
        allowWrite: false,
        releaseGate: false,
        verbose: false,
        json: false,
        showScan: false,
      },
      runtimeConfig(stateDirectory),
      {
        silent: true,
        output: { log: () => undefined, error: () => undefined },
        executionHarness: new CountingHarness(),
      },
      async ({ execution }) => ({ value: execution.record }),
    );
    const human = await captureConsole(() =>
      handleRunsCommand(["show", record!.id, "--state-dir", stateDirectory]),
    );
    return { record: record!, human };
  }

  it("names refused pages and an incomplete enumeration instead of dropping them", {
    timeout: testTimeoutMs(60_000),
  }, async () => {
    const root = await roots.create("docsfab-template-audit-refused-");
    const repository = resolve(root, "repository");
    const bound = limit(TEMPLATE_AUDIT_PAGE_BYTES_LIMIT);
    expect(bound.name).toBe("contentIndex.maxSourceBytes");
    const oversized = `# Quickstart\n\n${"x".repeat(bound.value)}\n`;
    await initFixtureRepo(repository, {
      "docs/quickstart.md": page("Quickstart", ["Prerequisites", "Steps", "What's Next"], "fern"),
      "docs/big-quickstart.md": oversized,
      "docs/latin1-quickstart.md": Buffer.from([0x23, 0x20, 0x51, 0xe9, 0x0a]),
    });
    await symlink("quickstart.md", resolve(repository, "docs/linked-quickstart.md"));
    const revision = await commitFixture(repository, "add a symlinked page");
    const { record, human } = await runAudit(repository, revision, resolve(root, "state", "runs"));

    const report = retainedTemplateAuditReport(record)!;
    expect(report.coverage).toEqual({
      enumerated: 3,
      checked: 1,
      passed: 1,
      failed: 0,
      unmapped: 0,
      refused: 2,
    });
    expect(report.scope).toMatchObject({ enumeration: "incomplete", omittedEntries: 1 });
    expect(record.workflowOutcome).toMatchObject({
      disposition: "inconclusive",
      limitations: ["template-audit-enumeration-incomplete", "template-audit-refused-pages"],
    });
    const size = Buffer.byteLength(oversized);
    expect(human).toContain(
      `Refused page: docs/big-quickstart.md (page-too-large: ${size} bytes exceeds contentIndex.maxSourceBytes, ${bound.value} bytes). Next: ${bound.remediation}`,
    );
    expect(bound.remediation).toContain("Split the page");
    expect(report.pages.find((entry) => entry.path === "docs/big-quickstart.md")).toMatchObject({
      status: "refused",
      code: "page-too-large",
      observedBytes: size,
      limitBytes: bound.value,
    });
    expect(human).toContain(
      "Refused page: docs/latin1-quickstart.md (page-not-utf8: the tracked bytes are not valid UTF-8). Next: save the page as UTF-8, then run the audit again.",
    );
    expect(human).toContain(
      "Enumeration incomplete: 1 tracked entry could not be audited (repository-inventory-unsafe-tracked-entry (docs/linked-quickstart.md)).",
    );
    expect(human).toContain("resolve the 2 refused pages as their PRODUCT lines say");
    expect(human).not.toContain("`template:` frontmatter key on the");
  });

  it("reaches ready when every page passes though text indexing was incomplete", {
    timeout: testTimeoutMs(30_000),
  }, async () => {
    const root = await roots.create("docsfab-template-audit-ready-");
    const repository = resolve(root, "repository");
    const revision = await initFixtureRepo(repository, {
      "docs/quickstart.md": page("Quickstart", ["Prerequisites", "Steps", "What's Next"], "fern"),
      "assets/latin1.txt": Buffer.from([0x51, 0xe9, 0x0a]),
    });
    const { record, human } = await runAudit(repository, revision, resolve(root, "state", "runs"));
    expect(retainedTemplateAuditReport(record)!.scope).toEqual({
      kind: "documentation-set",
      enumeration: "complete",
      omittedEntries: 0,
      limitations: [],
    });
    expect(record.workflowOutcome).toMatchObject({ disposition: "ready" });
    expect(human).toContain("All 1 pages passed their templates.");
    expect(human).not.toContain("Enumeration incomplete");
  });
});
