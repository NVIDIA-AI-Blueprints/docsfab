// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { listTemplates } from "../src/templates/catalog.js";
import { previewSite, template } from "../src/templates/preview.js";
import type {
  ApprovedTemplatePlan,
  GovernedTemplateBundle,
  TemplatePreviewSiteInput,
} from "../src/templates/contracts.js";
import { templateSelectionDigest } from "../src/templates/selection.js";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const digest = "a".repeat(64);
const revision = "b".repeat(40);
const gfmContent = "# {{title}}\n\nSlug: {{slug}}\n\n{{summary}}\n\n## Evidence\n\n{{evidence}}\n";
const gfmSchema = JSON.stringify({
  schemaVersion: 1,
  format: "gfm",
  variables: [
    { name: "title", required: true },
    { name: "slug", required: true },
    { name: "summary", required: true },
    { name: "evidence", required: true },
  ],
  minimumEvidenceNodes: 1,
});
const mystContent = "# {{title}}\n\n:slug: {{slug}}\n\n{{summary}}\n\n{{evidence}}\n";
const mystSchema = JSON.stringify({
  schemaVersion: 1,
  format: "myst",
  variables: [
    { name: "title", required: true },
    { name: "slug", required: true },
    { name: "summary", required: false },
    { name: "evidence", required: false },
  ],
  minimumEvidenceNodes: 0,
});

function bundle(): GovernedTemplateBundle {
  const templates: GovernedTemplateBundle["manifest"]["templates"] = [
    {
      id: "how-to",
      version: "2.1.0",
      format: "gfm",
      template: {
        path: "templates/how-to.gfm.md",
        sha256: sha256(gfmContent),
        content: gfmContent,
      },
      schema: {
        path: "schemas/how-to.schema.json",
        version: "3.0.0",
        sha256: sha256(gfmSchema),
        content: gfmSchema,
      },
    },
    {
      id: "concept-myst",
      version: "1.4.0",
      format: "myst",
      template: {
        path: "templates/concept.myst.md",
        sha256: sha256(mystContent),
        content: mystContent,
      },
      schema: {
        path: "schemas/concept.schema.json",
        version: "1.2.0",
        sha256: sha256(mystSchema),
        content: mystSchema,
      },
    },
  ];
  return {
    evidence: {
      id: "template-catalog-ia",
      version: "2026.08",
      license: "Apache-2.0",
      bundleSha256: "c".repeat(64),
      source: {
        repository: "https://gitlab.example.test/docs/templates.git",
        revision,
        path: "ia",
      },
      files: templates.flatMap((entry) => [
        { path: entry.template.path, sha256: entry.template.sha256 },
        { path: entry.schema.path, sha256: entry.schema.sha256 },
      ]),
    },
    manifest: { schemaVersion: 1, templates },
  };
}

function plan(topics: TemplatePreviewSiteInput["topics"]): ApprovedTemplatePlan {
  return {
    schemaVersion: 1,
    kind: "ia-plan",
    digest,
    repository: { revision, contentDigest: digest },
    planId: "plan:ia",
    candidateId: "candidate:primary",
    iaEvaluation: {
      kind: "ia-evaluation",
      digest: "d".repeat(64),
      repositoryRevision: revision,
      repositoryContentDigest: digest,
      eligible: true,
    },
    templateSelectionDigest: templateSelectionDigest(topics),
    templateCatalogDigest: listTemplates({ bundle: bundle() }).digest,
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
    outputs: topics.map((topic) => ({ path: topic.outputPath, operation: "create" as const })),
  };
}

function input(): TemplatePreviewSiteInput {
  const topics: TemplatePreviewSiteInput["topics"] = [
    {
      id: "topic:getting-started",
      slug: "getting-started",
      title: "Getting started",
      templateId: "how-to",
      outputPath: "docs/getting-started.md",
      summary: "Install and run DocsFab.",
      evidenceNodeIds: ["section:install"],
    },
    {
      id: "topic:model-profile",
      slug: "reference/model-profile",
      title: "Model profile reference",
      templateId: "concept-myst",
      outputPath: "docs/reference/model-profile.md",
      evidenceNodeIds: [],
    },
  ];
  return {
    bundle: bundle(),
    plan: plan(topics),
    evaluationTime: "2026-08-03T12:00:00.000Z",
    topics,
  };
}

describe("template.previewSite", () => {
  it("renders deterministic GFM and MyST previews entirely in memory", () => {
    const first = previewSite(input());
    const reordered = input();
    reordered.topics.reverse();
    const second = previewSite(reordered);

    expect(first).toEqual(second);
    expect(first.writesPerformed).toBe(false);
    expect(first.outputs.map((output) => [output.path, output.format])).toEqual([
      ["docs/getting-started.md", "gfm"],
      ["docs/reference/model-profile.md", "myst"],
    ]);
    expect(first.outputs[0]!.content).toContain("# Getting started");
    expect(first.outputs[0]!.content).toContain("- `section:install`");
    expect(first.outputs[0]!.template.sourceRevision).toBe(revision);
    expect(first.outputs[0]!.schema.version).toBe("3.0.0");
    expect(template.previewSite(input())).toEqual(first);
    expect(template.list({ bundle: bundle() }).templates).toHaveLength(2);
  });

  it("emits explicit evidence gaps and format-specific TODO markers", () => {
    const value = input();
    value.topics = [
      {
        id: "topic:getting-started",
        slug: "getting-started",
        title: "Getting started",
        templateId: "how-to",
        outputPath: "docs/getting-started.md",
        evidenceNodeIds: [],
      },
    ];
    value.plan = plan(value.topics);
    const preview = previewSite(value);

    expect(preview.outputs[0]!.evidenceGaps.map((gap) => gap.code)).toEqual([
      "insufficient-node-evidence",
      "missing-required-summary",
    ]);
    expect(preview.outputs[0]!.todos).toHaveLength(2);
    expect(preview.outputs[0]!.content).toContain("TODO(missing-required-summary)");
    expect(preview.outputs[0]!.content).toContain("TODO(insufficient-node-evidence)");
  });

  it("requires an effective explicit approval and matching eligible evaluation", () => {
    const pending = input() as unknown as { plan: { approval: { status: string } } };
    pending.plan.approval.status = "pending";
    expect(() => previewSite(pending)).toThrow("explicit maintainer or owner approval");

    const stale = input();
    stale.evaluationTime = stale.plan.expiresAt;
    expect(() => previewSite(stale)).toThrow("not effective");

    const mismatched = input();
    mismatched.plan.iaEvaluation.repositoryRevision = "e".repeat(40);
    expect(() => previewSite(mismatched)).toThrow("another repository revision");
  });

  it("rejects unknown fields, unsafe paths, and outputs outside the approved plan", () => {
    const unknown = input() as unknown as { extra?: boolean };
    unknown.extra = true;
    expect(() => previewSite(unknown)).toThrow("unknown field extra");

    const unsafe = input();
    unsafe.topics[0]!.outputPath = "docs/../escape.md";
    expect(() => previewSite(unsafe)).toThrow("safe docs/*.md path");

    const unapproved = input();
    unapproved.topics[0]!.outputPath = "docs/unapproved.md";
    unapproved.topics[0]!.slug = "unapproved";
    expect(() => previewSite(unapproved)).toThrow("not approved by the plan");
  });

  it("rejects duplicate topic identities, slugs, and colliding output paths", () => {
    const duplicateId = input();
    duplicateId.topics[1]!.id = duplicateId.topics[0]!.id;
    expect(() => previewSite(duplicateId)).toThrow("topic ids");

    const duplicateSlug = input();
    duplicateSlug.topics[1]!.slug = duplicateSlug.topics[0]!.slug;
    duplicateSlug.topics[1]!.outputPath = "docs/getting-started.md";
    expect(() => previewSite(duplicateSlug)).toThrow("topic slugs");

    const collision = input();
    collision.topics[1]!.slug = "reference/getting-started";
    collision.topics[1]!.outputPath = collision.topics[0]!.outputPath;
    expect(() => previewSite(collision)).toThrow("does not match its slug");
  });
});
