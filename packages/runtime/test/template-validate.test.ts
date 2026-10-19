// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import { listTemplates } from "../src/templates/catalog.js";
import type { ApprovedTemplatePlan, GovernedTemplateBundle } from "../src/templates/contracts.js";
import { loadTemplateSet } from "../src/templates/load.js";
import { previewSite } from "../src/templates/preview.js";
import { templateSelectionDigest } from "../src/templates/selection.js";
import { parseStructuralSchema, validatePage } from "../src/templates/validate.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const revision = "a".repeat(40);
const digest = "b".repeat(64);
let bundle: GovernedTemplateBundle;

beforeAll(async () => {
  bundle = await loadTemplateSet(projectRoot);
});

describe("template.validatePage", () => {
  it("ignores headings inside a shorter fence nested within a longer CommonMark fence", () => {
    const page = previewSite({
      bundle,
      plan: plan("quickstart-gfm", []),
      evaluationTime: "2026-08-03T12:00:00.000Z",
      topics: [
        {
          id: "topic:quickstart",
          slug: "get-started/quickstart",
          title: "Quickstart",
          templateId: "quickstart-gfm",
          outputPath: "docs/get-started/quickstart.md",
          productName: "DocsFab",
          evidenceNodeIds: [],
        },
      ],
    }).outputs[0]!;
    page.content = [
      "# Quickstart",
      "",
      "````markdown",
      "```",
      "# Example inside the code block",
      "```",
      "````",
      "",
      "## Prerequisites",
      "",
      "## Quickstart Steps",
      "",
      "## What's Next",
      "",
    ].join("\n");
    page.contentSha256 = sha256(page.content);

    const report = validatePage({ bundle, page });

    expect(report.status).toBe("passed");
    expect(report.findings).not.toContainEqual(expect.objectContaining({ rule: "duplicate-h1" }));
  });

  it("loads the authentic locked GFM/MyST catalog without executing upstream scripts", () => {
    const catalog = listTemplates({ bundle });
    expect(catalog.templates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "quickstart-gfm", format: "gfm" }),
        expect.objectContaining({ id: "quickstart-myst", format: "myst" }),
      ]),
    );
    expect(
      catalog.templates.every(
        (entry) =>
          entry.template.sourceRevision ===
          "97dd73cf5ee17704d05cb64e8ffc6dc871e9670900ab12c092c8a197ee3febfb",
      ),
    ).toBe(true);
  });

  it.each(["gfm", "myst"] as const)(
    "passes required structural lint for a rendered authentic %s template",
    (format) => {
      const preview = previewSite({
        bundle,
        plan: plan("quickstart-" + format, ["document:readme"]),
        evaluationTime: "2026-08-03T12:00:00.000Z",
        topics: [
          {
            id: "topic:quickstart",
            slug: "get-started/quickstart",
            title: "Quickstart",
            templateId: `quickstart-${format}`,
            outputPath: "docs/get-started/quickstart.md",
            productName: "DocsFab",
            evidenceNodeIds: ["document:readme"],
          },
        ],
      });
      const report = validatePage({ bundle, page: preview.outputs[0]! });

      expect(report.status).toBe("passed");
      expect(report.templateId).toBe(`quickstart-${format}`);
      expect(report.findings.some((finding) => finding.severity === "error")).toBe(false);
      expect(JSON.stringify(report)).not.toContain("Install DocsFab");
      expect(preview.outputs[0]!.content).toContain("pip install docsfab");
      expect(preview.outputs[0]!.content).not.toContain("[package-name]");
    },
  );

  it("fails when a required heading is removed even if the caller re-hashes the content", () => {
    const page = previewSite({
      bundle,
      plan: plan("quickstart-gfm", ["document:readme"]),
      evaluationTime: "2026-08-03T12:00:00.000Z",
      topics: [
        {
          id: "topic:quickstart",
          slug: "get-started/quickstart",
          title: "Quickstart",
          templateId: "quickstart-gfm",
          outputPath: "docs/get-started/quickstart.md",
          productName: "DocsFab",
          evidenceNodeIds: ["document:readme"],
        },
      ],
    }).outputs[0]!;
    page.content = page.content.replace(/^# .+$/mu, "# Removed Required Title");
    page.contentSha256 = sha256(page.content);

    const report = validatePage({ bundle, page });
    expect(report.status).toBe("failed");
    expect(report.findings).toContainEqual(
      expect.objectContaining({
        rule: "missing-required-heading",
        severity: "error",
      }),
    );
  });

  it("matches upstream global NVIDIA package placeholder normalization", () => {
    const topic = {
      id: "topic:quickstart",
      slug: "get-started/quickstart",
      title: "Quickstart",
      templateId: "quickstart-gfm",
      outputPath: "docs/get-started/quickstart.md",
      productName: "Acme NVIDIA Foo",
      evidenceNodeIds: ["document:readme"],
    };
    const preview = previewSite({
      bundle,
      plan: planForTopic(topic),
      evaluationTime: "2026-08-03T12:00:00.000Z",
      topics: [topic],
    });

    expect(preview.outputs[0]!.content).toContain("pip install acme-foo");
    expect(preview.outputs[0]!.content).not.toContain("acme-nvidia-foo");
  });

  it("rejects preview provenance or content hashes not bound to the governed catalog", () => {
    const page = previewSite({
      bundle,
      plan: plan("quickstart-gfm", []),
      evaluationTime: "2026-08-03T12:00:00.000Z",
      topics: [
        {
          id: "topic:quickstart",
          slug: "get-started/quickstart",
          title: "Quickstart",
          templateId: "quickstart-gfm",
          outputPath: "docs/get-started/quickstart.md",
          productName: "DocsFab",
          evidenceNodeIds: [],
        },
      ],
    }).outputs[0]!;
    page.template.sourceRevision = "f".repeat(40);
    expect(() => validatePage({ bundle, page })).toThrow("not bound");

    page.template.sourceRevision = bundle.evidence.source.revision;
    page.content += "tampered";
    expect(() => validatePage({ bundle, page })).toThrow("content digest");
  });
});

describe("template structural schema", () => {
  it("reads each heading rule with its description and the section order", () => {
    const quickstart = bundle.manifest.templates.find((entry) => entry.id === "quickstart-gfm")!;
    const schema = parseStructuralSchema(quickstart.schema.content);
    expect(schema.headings.length).toBeGreaterThan(0);
    expect(schema.headings.every((heading) => heading.level >= 1 && heading.level <= 6)).toBe(true);
    expect(schema.headings.some((heading) => heading.required)).toBe(true);

    const parsed = parseStructuralSchema(
      [
        "name: sample",
        "structure:",
        "  headings:",
        "    h1:",
        "      required:",
        '        - pattern: "Sample.*"',
        '          description: "Page title"',
        "    h2:",
        "      required:",
        '        - pattern: "Steps"',
        "      optional:",
        '        - pattern: "Next Steps?"',
        '          description: "Follow-on links"',
        "  section_order:",
        '    - "Steps"',
        '    - "Next Steps?"',
        "severity:",
        "  duplicate_h1: error",
      ].join("\n"),
    );
    expect(parsed).toEqual({
      headings: [
        { level: 1, pattern: "Sample.*", required: true, description: "Page title" },
        { level: 2, pattern: "Steps", required: true },
        { level: 2, pattern: "Next Steps?", required: false, description: "Follow-on links" },
      ],
      sectionOrder: ["Steps", "Next Steps?"],
    });
  });

  it("keeps validation unchanged by the descriptions it now reads", () => {
    const troubleshooting = bundle.manifest.templates.find(
      (entry) => entry.id === "troubleshooting-gfm",
    )!;
    expect(
      parseStructuralSchema(troubleshooting.schema.content).headings.map(
        ({ level, pattern, required }) => ({ level, pattern, required }),
      ),
    ).toEqual([
      { level: 1, pattern: "Troubleshoot.*", required: true },
      { level: 2, pattern: ".+", required: true },
      { level: 2, pattern: "Error Message Reference", required: false },
      { level: 2, pattern: "Related Topics?", required: false },
      { level: 3, pattern: ".*", required: false },
    ]);
  });
});

function plan(templateId: string, evidenceNodeIds: string[]): ApprovedTemplatePlan {
  const topic = {
    id: "topic:quickstart",
    slug: "get-started/quickstart",
    title: "Quickstart",
    templateId,
    outputPath: "docs/get-started/quickstart.md",
    productName: "DocsFab",
    evidenceNodeIds,
  };
  return planForTopic(topic);
}

function planForTopic(topic: {
  id: string;
  slug: string;
  title: string;
  templateId: string;
  outputPath: string;
  productName: string;
  evidenceNodeIds: string[];
}): ApprovedTemplatePlan {
  return {
    schemaVersion: 1,
    kind: "ia-plan",
    digest,
    repository: { revision, contentDigest: digest },
    planId: "plan:quickstart",
    candidateId: "candidate:reader-job",
    iaEvaluation: {
      kind: "ia-evaluation",
      digest: "c".repeat(64),
      repositoryRevision: revision,
      repositoryContentDigest: digest,
      eligible: true,
    },
    templateSelectionDigest: templateSelectionDigest([topic]),
    templateCatalogDigest: listTemplates({ bundle }).digest,
    repositoryCheckPolicy: {
      id: "docsfab:repository-checks:test",
      version: "1",
      digest: "e".repeat(64),
    },
    approval: {
      status: "approved",
      requirement: "maintainer",
      approvedBy: "maintainer:docs",
      approvedAt: "2026-08-03T10:00:00.000Z",
    },
    expiresAt: "2026-08-04T10:00:00.000Z",
    outputs: [{ path: topic.outputPath, operation: "create" }],
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
