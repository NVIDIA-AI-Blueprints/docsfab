// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Governed template guidance for authoring: which template a page selects,
 * what guidance the planner and writer read for it, and that the guidance can
 * never carry a template's example or body text into a prompt.
 */
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { auditTemplateConformance } from "../src/templates/audit.js";
import type { GovernedTemplateBundle } from "../src/templates/contracts.js";
import { loadTemplateSet } from "../src/templates/load.js";
import {
  PAGE_TEMPLATE_GUIDANCE_BYTES_LIMIT,
  pageTemplateGuidance,
  readWorkspacePage,
  selectPageTemplate,
  templateStructureGuidance,
} from "../src/templates/page-guidance.js";
import { limit } from "../src/config/limits.js";
import {
  PAGE_TEMPLATE_GUIDANCE_HEADER,
  pageTemplateGuidancePrompt,
} from "../src/workflow-execution/page-template-guidance.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let bundle: GovernedTemplateBundle;
const directories: string[] = [];

beforeAll(async () => {
  bundle = await loadTemplateSet(projectRoot);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("selecting a page's template", () => {
  it("lets an explicit template frontmatter key win over the page's path", () => {
    const selection = selectPageTemplate({
      bundle,
      path: "docs/troubleshooting.md",
      content: "---\ntitle: Get Going\ntemplate: quickstart\n---\n\n# Get Going\n",
    });
    expect(selection).toMatchObject({
      status: "mapped",
      templateId: "quickstart-gfm",
      basis: "frontmatter",
      signal: "template: quickstart",
    });
  });

  it("maps a new page with no content by its path", () => {
    expect(
      selectPageTemplate({ bundle, path: "docs/guides/cli-troubleshooting.md" }),
    ).toMatchObject({
      status: "mapped",
      templateId: "troubleshooting-gfm",
      basis: "filename-suffix",
    });
    expect(selectPageTemplate({ bundle, path: "docs/release-notes/v2.md" })).toMatchObject({
      status: "mapped",
      templateId: "release-notes-gfm",
      basis: "directory",
    });
  });

  it("returns the reason, not guidance, for a page no template maps", () => {
    const guidance = pageTemplateGuidance({
      bundle,
      pages: [{ path: "docs/concepts/lenses.md" }, { path: "docs/index.md" }],
    });
    expect(guidance.pages).toEqual([
      {
        path: "docs/concepts/lenses.md",
        status: "unmapped",
        reason: "no-template-signal",
        candidates: [],
      },
      { path: "docs/index.md", status: "unmapped", reason: "section-index", candidates: [] },
    ]);
    expect(guidance.templates).toEqual([]);
    const prompt = pageTemplateGuidancePrompt(guidance);
    expect(prompt).toContain(
      'Page "docs/concepts/lenses.md": no template guidance (no-template-signal). Follow the repository\'s existing conventions for this page.',
    );
    expect(prompt).not.toContain("Template ");
  });

  it("states each selected template once however many pages map to it", () => {
    const guidance = pageTemplateGuidance({
      bundle,
      pages: [
        { path: "docs/cli-troubleshooting.md" },
        { path: "docs/api-troubleshooting.md" },
        { path: "docs/cli-troubleshooting.md" },
      ],
    });
    expect(guidance.pages.map((page) => page.path)).toEqual([
      "docs/cli-troubleshooting.md",
      "docs/api-troubleshooting.md",
    ]);
    expect(guidance.templates.map((template) => template.templateId)).toEqual([
      "troubleshooting-gfm",
    ]);
  });
});

describe("template guidance content", () => {
  it("carries the schema headings, the heading skeleton, and the tagged notes", () => {
    const guidance = templateStructureGuidance(bundle, "troubleshooting-gfm");
    expect(guidance.status).toBe("included");
    if (guidance.status !== "included") return;
    expect(guidance.requiredHeadings).toEqual([
      {
        level: 1,
        pattern: "Troubleshoot.*",
        required: true,
        description: "Troubleshooting page title",
      },
      {
        level: 2,
        pattern: ".+",
        required: true,
        description: "Issue entries (issue name or error message)",
      },
    ]);
    expect(guidance.optionalHeadings.map((heading) => heading.pattern)).toEqual([
      "Error Message Reference",
      "Related Topics?",
      ".*",
    ]);
    expect(guidance.skeleton.map((section) => section.heading?.text ?? null)).toEqual([
      "Troubleshooting [Product Name]",
      "[Add an Issue Heading Here (Issue 1)]",
      "[Add an Issue Heading Here (Issue 2)]",
      "[Add an Issue Heading Here (Issue 3)]",
      "Error Messages",
      "Related Topics",
    ]);
    const notes = guidance.skeleton.flatMap((section) => section.notes);
    expect(notes.map((note) => note.kind)).toEqual(
      expect.arrayContaining(["naming", "formatting", "optional"]),
    );
    expect(notes.map((note) => note.text)).toContain(
      "Include this section if your product produces specific error messages.",
    );
    // An identical note repeated under each issue section is stated once.
    expect(
      notes.filter((note) => note.text === "Provide the troubleshooting item here.").length,
    ).toBe(1);
  });

  it("never carries an example block or template body prose, for every template", () => {
    for (const definition of bundle.manifest.templates) {
      const guidance = templateStructureGuidance(bundle, definition.id);
      expect(guidance.status, definition.id).toBe("included");
      const text = `${JSON.stringify(guidance)}\n${pageTemplateGuidancePrompt({
        pages: [
          {
            path: "docs/page.md",
            status: "mapped",
            templateId: definition.id,
            basis: "frontmatter",
            signal: `template: ${definition.id}`,
          },
        ],
        templates: [guidance],
      })}`;
      const { examples, prose, kept } = templateText(definition.template.content);
      for (const line of examples.filter((entry) => !kept.some((part) => part.includes(entry)))) {
        expect(text, `${definition.id} example line`).not.toContain(line);
      }
      for (const line of prose.filter((entry) => !kept.some((part) => part.includes(entry)))) {
        expect(text, `${definition.id} body prose`).not.toContain(line);
      }
    }
    const troubleshooting = JSON.stringify(
      templateStructureGuidance(bundle, "troubleshooting-gfm"),
    );
    for (const fact of [
      "Out of Memory Issues When Deploying",
      "torch.OutOfMemoryError",
      "NIM_MODEL_PROFILE",
      "troubleshooting-asr-nim-gfm.md",
      "When you [scenario]",
      "The following issues might arise",
      "This is the Troubleshooting template",
    ]) {
      expect(troubleshooting).not.toContain(fact);
    }
  });

  it("omits a template whose guidance exceeds the byte bound and names the limit", () => {
    const included = templateStructureGuidance(bundle, "troubleshooting-gfm");
    const bytes = Buffer.byteLength(JSON.stringify(included), "utf8");
    expect(bytes).toBeLessThanOrEqual(limit(PAGE_TEMPLATE_GUIDANCE_BYTES_LIMIT).value);

    vi.stubEnv("DOCSFAB_AUTHORING_PAGE_TEMPLATE_GUIDANCE_MAX_BYTES", String(bytes));
    expect(templateStructureGuidance(bundle, "troubleshooting-gfm").status).toBe("included");

    vi.stubEnv("DOCSFAB_AUTHORING_PAGE_TEMPLATE_GUIDANCE_MAX_BYTES", String(bytes - 1));
    const omitted = templateStructureGuidance(bundle, "troubleshooting-gfm");
    expect(omitted).toEqual({
      templateId: "troubleshooting-gfm",
      status: "omitted",
      reason: expect.stringContaining(
        `authoring-page-template-guidance-max-bytes-bound: ${bytes} exceeds ${PAGE_TEMPLATE_GUIDANCE_BYTES_LIMIT} = ${bytes - 1} bytes.`,
      ),
    });
    const prompt = pageTemplateGuidancePrompt(
      pageTemplateGuidance({ bundle, pages: [{ path: "docs/troubleshooting.md" }] }),
    );
    expect(prompt).toContain("Template troubleshooting-gfm: guidance omitted. ");
    expect(prompt).not.toContain("Heading skeleton");
  });

  it("fits every governed template within the default bound", () => {
    const bound = limit(PAGE_TEMPLATE_GUIDANCE_BYTES_LIMIT).value;
    for (const definition of bundle.manifest.templates) {
      expect(templateStructureGuidance(bundle, definition.id).status, definition.id).toBe(
        "included",
      );
      expect(
        Buffer.byteLength(JSON.stringify(templateStructureGuidance(bundle, definition.id))),
      ).toBeLessThan(bound);
    }
  });
});

describe("the page template guidance prompt", () => {
  it("states that templates are structure guidance only and how the H1 is supplied", () => {
    const prompt = pageTemplateGuidancePrompt(
      pageTemplateGuidance({ bundle, pages: [{ path: "docs/troubleshooting.md" }] }),
    );
    expect(prompt.startsWith(`\n\n${PAGE_TEMPLATE_GUIDANCE_HEADER}\n`)).toBe(true);
    expect(prompt).toContain("It is never a source of product facts");
    expect(prompt).toContain(
      "When the documentation site renders the frontmatter title as the page H1, as Fern and Docusaurus do, the page must not add a Markdown H1",
    );
    expect(prompt).toContain("  - H1 /Troubleshoot.*/: Troubleshooting page title");
    expect(prompt).toContain("  ## Error Messages");
    expect(prompt).toMatch(/\n\n$/u);
  });

  it("renders nothing for guidance that names no page", () => {
    expect(pageTemplateGuidancePrompt({ pages: [], templates: [] })).toBe("");
  });
});

describe("the advisory audit of an authored page", () => {
  it("passes a Fern page whose frontmatter title is its H1 and that adds no Markdown H1", () => {
    const report = auditTemplateConformance({
      bundle,
      pages: [
        {
          path: "fern/pages/troubleshooting.mdx",
          content: [
            "---",
            "title: Troubleshooting DocsFab",
            "---",
            "",
            "## Runs Stop With a Limit Code",
            "",
            "Raise the named limit.",
            "",
            "## Related Topics",
            "",
            "- [Limits](limits.mdx)",
            "",
          ].join("\n"),
        },
      ],
      scope: { kind: "focused-set", enumeration: "complete", omittedEntries: 0, limitations: [] },
    });
    expect(report.pages).toEqual([
      expect.objectContaining({
        path: "fern/pages/troubleshooting.mdx",
        status: "passed",
        templateId: "troubleshooting-gfm",
        h1Source: "frontmatter-title",
        findings: [],
      }),
    ]);
  });
});

describe("reading a workspace page", () => {
  it("reads a page, reports an absent one, and refuses a link or an oversized page", async () => {
    const root = await mkdtemp(join(tmpdir(), "docsfab-page-guidance-"));
    directories.push(root);
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(join(root, "docs", "guide.md"), "# Guide\n");
    await symlink(join(root, "docs", "guide.md"), join(root, "docs", "linked.md"));
    await writeFile(join(root, "docs", "binary.md"), Buffer.from([0xff, 0xfe, 0x00]));

    expect(await readWorkspacePage(root, "docs/guide.md")).toEqual({
      path: "docs/guide.md",
      content: "# Guide\n",
    });
    expect(await readWorkspacePage(root, "docs/absent.md")).toBeUndefined();
    expect(await readWorkspacePage(root, "docs/linked.md")).toEqual({
      path: "docs/linked.md",
      refused: "page-unreadable",
    });
    expect(await readWorkspacePage(root, "docs/binary.md")).toEqual({
      path: "docs/binary.md",
      refused: "page-not-utf8",
    });
    vi.stubEnv("DOCSFAB_AUTHORING_PLANNED_PAGE_MAX_BYTES", "4");
    expect(await readWorkspacePage(root, "docs/guide.md")).toEqual({
      path: "docs/guide.md",
      refused: "page-too-large",
      observedBytes: 8,
      limitBytes: 4,
    });
  });

  it("reads every page a plan may write: the content index bound does not apply", async () => {
    const root = await mkdtemp(join(tmpdir(), "docsfab-page-guidance-"));
    directories.push(root);
    await mkdir(join(root, "docs"), { recursive: true });
    const content = "---\ntemplate: quickstart\n---\n\n# Get Going\n";
    await writeFile(join(root, "docs", "troubleshooting.md"), content);
    // A content index bound smaller than the page no longer refuses the read;
    // only the planned-page bound does.
    vi.stubEnv("DOCSFAB_CONTENT_INDEX_MAX_SOURCE_BYTES", "4");
    const read = await readWorkspacePage(root, "docs/troubleshooting.md");
    expect(read).toEqual({ path: "docs/troubleshooting.md", content });
    expect(pageTemplateGuidance({ bundle, pages: [read!] }).pages).toEqual([
      expect.objectContaining({
        status: "mapped",
        templateId: "quickstart-gfm",
        basis: "frontmatter",
      }),
    ]);
  });
});

describe("a page the host refused to read", () => {
  it("keeps the refusal, selects no template, and tells the writer to keep the page's structure", () => {
    const guidance = pageTemplateGuidance({
      bundle,
      pages: [
        {
          path: "docs/troubleshooting.md",
          refused: "page-too-large",
          observedBytes: 9,
          limitBytes: 8,
        },
        { path: "docs/cli-troubleshooting.md", refused: "page-not-utf8" },
        { path: "docs/linked-troubleshooting.md", refused: "page-unreadable" },
      ],
    });
    // A filename that alone would map to the troubleshooting template maps to
    // nothing: the page's own declaration is unknown, so no guess is made.
    expect(guidance.pages).toEqual([
      {
        path: "docs/troubleshooting.md",
        status: "refused",
        code: "page-too-large",
        observedBytes: 9,
        limitBytes: 8,
      },
      { path: "docs/cli-troubleshooting.md", status: "refused", code: "page-not-utf8" },
      { path: "docs/linked-troubleshooting.md", status: "refused", code: "page-unreadable" },
    ]);
    expect(guidance.templates).toEqual([]);
    const prompt = pageTemplateGuidancePrompt(guidance);
    expect(prompt).toContain(
      'Page "docs/troubleshooting.md": no template guidance, because the host could not read the current page (page-too-large: 9 bytes exceeds authoring.plannedPageMaxBytes, 8 bytes). Its own template choice is unknown, so keep the page\'s existing structure and headings, and do not restructure it to match a template.',
    );
    expect(prompt).toContain("(page-not-utf8: the page bytes are not valid UTF-8)");
    expect(prompt).toContain("(page-unreadable: the page is not a readable regular file)");
    expect(prompt).not.toContain("Template troubleshooting-gfm");
  });

  it("still maps an absent page by its path, unlike a refused one", () => {
    expect(
      pageTemplateGuidance({ bundle, pages: [{ path: "docs/troubleshooting.md" }] }).pages,
    ).toEqual([expect.objectContaining({ status: "mapped", templateId: "troubleshooting-gfm" })]);
  });
});

/**
 * A template's example-comment lines, its body prose lines, and the text of
 * everything guidance may keep (headings and tagged guidance notes). Lines
 * shorter than a phrase are skipped, since they can coincide by chance.
 */
function templateText(content: string): {
  examples: string[];
  prose: string[];
  kept: string[];
} {
  const lines = content.replace(/\r\n?/gu, "\n").split("\n");
  const examples: string[] = [];
  const prose: string[] = [];
  const kept: string[] = [];
  let comment: { kind: string; lines: string[] } | undefined;
  let frontmatter = lines[0]?.trim() === "---";
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (frontmatter) {
      if (index > 0 && (line === "---" || line === "...")) frontmatter = false;
      continue;
    }
    if (comment) {
      const end = line.indexOf("-->");
      comment.lines.push(end >= 0 ? line.slice(0, end) : line);
      if (end >= 0) {
        (comment.kind === "example" ? examples : comment.kind === "kept" ? kept : prose).push(
          ...comment.lines.map((entry) => entry.trim()),
        );
        comment = undefined;
      }
      continue;
    }
    const start = line.indexOf("<!--");
    if (start >= 0) {
      const body = line.slice(start + 4);
      const tag = /^\s*@tpl:([a-z-]+)/u.exec(body)?.[1];
      const kind =
        tag === "example"
          ? "example"
          : tag === "naming" || tag === "formatting" || tag === "optional"
            ? "kept"
            : "other";
      comment = { kind, lines: [] };
      const end = body.indexOf("-->");
      comment.lines.push((end >= 0 ? body.slice(0, end) : body).replace(/^\s*@tpl:[a-z-]+/u, ""));
      if (end >= 0) {
        (kind === "example" ? examples : kind === "kept" ? kept : prose).push(
          ...comment.lines.map((entry) => entry.trim()),
        );
        comment = undefined;
      }
      continue;
    }
    if (/^#{1,6}\s/u.test(line)) {
      kept.push(line.replace(/^#{1,6}\s+/u, ""));
      continue;
    }
    prose.push(line);
  }
  const phrase = (entry: string) => entry.length >= 24;
  return { examples: examples.filter(phrase), prose: prose.filter(phrase), kept };
}
