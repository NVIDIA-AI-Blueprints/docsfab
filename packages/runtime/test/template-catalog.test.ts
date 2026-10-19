// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { listTemplates } from "../src/templates/catalog.js";
import type { GovernedTemplateBundle } from "../src/templates/contracts.js";
import { loadTemplateSet } from "../src/templates/load.js";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const revision = "a".repeat(40);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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
      bundleSha256: "b".repeat(64),
      source: {
        repository: "https://gitlab.example.test/docs/template-catalog.git",
        revision,
        path: "templates/ia",
      },
      files: templates.flatMap((entry) => [
        { path: entry.template.path, sha256: entry.template.sha256 },
        { path: entry.schema.path, sha256: entry.schema.sha256 },
      ]),
    },
    manifest: { schemaVersion: 1, templates },
  };
}

describe("template.list", { timeout: 30_000 }, () => {
  it("lists a verified governed catalog deterministically with exact provenance", () => {
    const firstBundle = bundle();
    const secondBundle = bundle();
    secondBundle.manifest.templates.reverse();
    secondBundle.evidence.files.reverse();
    const first = listTemplates({ bundle: firstBundle });
    const second = listTemplates({ bundle: secondBundle });

    expect(first).toEqual(second);
    expect(first.templates.map((entry) => entry.id)).toEqual(["concept-myst", "how-to"]);
    expect(first.templates[1]).toMatchObject({
      id: "how-to",
      format: "gfm",
      version: "2.1.0",
      template: {
        sourceRepository: "https://gitlab.example.test/docs/template-catalog.git",
        sourceRevision: revision,
        sourcePath: "templates/ia/templates/how-to.gfm.md",
        version: "2.1.0",
        license: "Apache-2.0",
        sha256: sha256(gfmContent),
      },
      schema: {
        sourcePath: "templates/ia/schemas/how-to.schema.json",
        version: "3.0.0",
        sha256: sha256(gfmSchema),
      },
    });
  });

  it("supports only closed GFM/MyST format filters", () => {
    expect(
      listTemplates({ bundle: bundle(), format: "myst" }).templates.map((entry) => entry.id),
    ).toEqual(["concept-myst"]);
    expect(() => listTemplates({ bundle: bundle(), format: "mdx" })).toThrow("unsupported");
    expect(() => listTemplates({ bundle: bundle(), format: "gfm", surprise: true })).toThrow(
      "unknown field",
    );
  });

  it("rejects content or manifest records not bound to verified evidence", () => {
    const contentMismatch = bundle();
    contentMismatch.manifest.templates[0]!.template.content += "tampered";
    expect(() => listTemplates({ bundle: contentMismatch })).toThrow("does not match its SHA-256");

    const evidenceMismatch = bundle();
    evidenceMismatch.evidence.files[0]!.sha256 = "c".repeat(64);
    expect(() => listTemplates({ bundle: evidenceMismatch })).toThrow(
      "not bound to verified bundle evidence",
    );

    const unknown = bundle() as unknown as { manifest: { surprise?: boolean } };
    unknown.manifest.surprise = true;
    expect(() => listTemplates({ bundle: unknown })).toThrow("unknown field surprise");
  });

  it("rejects unsafe paths, generic template filenames, and unknown schema fields", () => {
    const unsafe = bundle();
    unsafe.manifest.templates[0]!.template.path = "../how-to.md";
    expect(() => listTemplates({ bundle: unsafe })).toThrow("safe relative path");

    const generic = bundle();
    const definition = generic.manifest.templates[0]!;
    const evidence = generic.evidence.files.find(
      (entry) => entry.path === definition.template.path,
    )!;
    definition.template.path = "templates/template.md";
    evidence.path = definition.template.path;
    expect(() => listTemplates({ bundle: generic })).toThrow("generic template filename");

    const unknownSchema = bundle();
    const schema = unknownSchema.manifest.templates[0]!.schema;
    schema.content = JSON.stringify({ ...JSON.parse(schema.content), unknown: true });
    schema.sha256 = sha256(schema.content);
    unknownSchema.evidence.files.find((entry) => entry.path === schema.path)!.sha256 =
      schema.sha256;
    expect(() => listTemplates({ bundle: unknownSchema })).toThrow("unknown field unknown");
  });

  it("adapts the authentic verified template set bytes without executing scripts", async () => {
    const adapted = await loadTemplateSet(projectRoot);
    const catalog = listTemplates({ bundle: adapted });

    expect(catalog.templates.map((entry) => entry.id)).toEqual(
      expect.arrayContaining([
        "installation-gfm",
        "installation-myst",
        "quickstart-gfm",
        "quickstart-myst",
        "troubleshooting-gfm",
      ]),
    );
    expect(catalog.templates.find((entry) => entry.id === "installation-gfm")).toMatchObject({
      format: "gfm",
      template: {
        sourceRevision: adapted.evidence.source.revision,
        sha256: adapted.evidence.files.find((entry) =>
          entry.path.endsWith("get-started/installation-gfm.md"),
        )?.sha256,
      },
      schema: {
        version: "1.0",
        sha256: adapted.evidence.files.find((entry) =>
          entry.path.endsWith("schemas/installation.yaml"),
        )?.sha256,
      },
    });
  });
});
