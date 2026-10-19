// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const testApi = process.env.VITEST ? await import("vitest") : await import("node:test");
const { describe, it } = testApi;

import {
  CATALOG_JSON_PATH,
  PAGE_PATHS,
  TABLE_PATHS,
  TABLE_REGIONS,
  TABLES_DIR,
  loadCatalog,
  markerLine,
  regionInclude,
  regionPath,
  renderRegionFile,
  renderRegionTable,
  runDocsLimitsTool,
} from "./docs-limits-table.mjs";
import { DERIVED_PRODUCT_BY_ID } from "./derived-products.mjs";

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(runtimeRoot, "../..");

// Tests run against the real committed catalog and doc tables, under a
// temporary directory or with an in-memory catalog override, not a hand-built
// fixture.
describe("docs-limits-table (#1307)", () => {
  it("the committed doc tables are current against the committed catalog (positive control)", () => {
    const result = runDocsLimitsTool({ checkOnly: true });
    assert.deepEqual(result, { status: "current" });
  });

  it("documents the internal GitHub review body budget without calling it a provider limit", () => {
    const catalog = loadCatalog();
    const defaults = TABLE_REGIONS.find((region) => region.id === "operational-limits-defaults");
    assert.ok(defaults.names.includes("githubReview.bodyMaxBytes"));
    const row = renderRegionTable(defaults, catalog)
      .split("\n")
      .find((line) => line.startsWith("| `githubReview.bodyMaxBytes` |"));
    assert.match(row, /65,000 bytes/u);
    assert.match(row, /Internal byte budget for one GitHub pending-review body/u);
    assert.doesNotMatch(row, /GitHub REST maximum/u);
  });

  it("renders exactly the declared rows, in declared order, for every declared region", () => {
    const catalog = loadCatalog();
    for (const region of TABLE_REGIONS) {
      const body = renderRegionTable(region, catalog);
      const lines = body.split("\n");
      assert.equal(lines.length, region.names.length + 2, region.id);
      assert.equal(lines[0], `| ${region.header.join(" | ")} |`);
      for (const [index, name] of region.names.entries()) {
        const key = region.keyBy === "name" ? name : catalog[name].override;
        assert.ok(
          lines[index + 2].startsWith(`| \`${key}\` | `),
          `${region.id} row ${index} should start with the ${region.keyBy} key ${key}: ${lines[index + 2]}`,
        );
      }
    }
  });

  it("fails with the named drift message when a docSummary is edited without regenerating (mutant: catalog value edited without regenerating the doc table)", () => {
    const catalog = structuredClone(loadCatalog());
    catalog["compositionExecution.maxCumulativeInputTokens"].docSummary =
      "mutated for test, never committed";
    const result = runDocsLimitsTool({ checkOnly: true, catalog });
    assert.equal(result.status, "drifted");
    // Only the table that renders the edited entry drifts.
    const defaults = TABLE_REGIONS.find((region) => region.id === "operational-limits-defaults");
    assert.deepEqual(result.messages, [
      `docs table drift: ${regionPath(defaults)} does not match the catalog; run npm run generate:limits`,
    ]);
  });

  it("fails the same way when a docValue is edited without regenerating (mutant: catalog value edited without regenerating the doc region)", () => {
    const catalog = structuredClone(loadCatalog());
    catalog["host.slack.liveAgentTurnTextMaxBytes"].docValue = "1 byte";
    const result = runDocsLimitsTool({ checkOnly: true, catalog });
    assert.equal(result.status, "drifted");
  });

  it("adjacent: a catalog field the doc never renders (rationale) does not trip drift", () => {
    const catalog = structuredClone(loadCatalog());
    // rationale is not a doc-facing field.
    catalog["compositionExecution.maxCumulativeInputTokens"].rationale = "unrelated rationale edit";
    const result = runDocsLimitsTool({ checkOnly: true, catalog });
    assert.deepEqual(result, { status: "current" });
  });

  it("refuses when config/limits.catalog.json does not exist, by name", () => {
    assert.throws(
      () => runDocsLimitsTool({ catalogPath: "config/does-not-exist.json", checkOnly: true }),
      /config\/does-not-exist\.json does not exist; run npm run generate:limits/u,
    );
  });

  describe("whole generated table files", () => {
    const scratch = () => mkdtempSync(join(tmpdir(), "docsfab-docs-limits-tables-"));
    const defaults = TABLE_REGIONS.find((region) => region.id === "operational-limits-defaults");

    it("renders each file as its start marker, its table, and its end marker", () => {
      const catalog = loadCatalog();
      for (const region of TABLE_REGIONS) {
        assert.equal(
          renderRegionFile(region, catalog),
          `${markerLine(region.id, "start")}\n${renderRegionTable(region, catalog)}\n${markerLine(region.id, "end")}\n`,
          region.id,
        );
      }
    });

    it("refuses a missing table file by name, and generation writes it", () => {
      const dir = scratch();
      try {
        cpSync(join(repoRoot, TABLES_DIR), dir, { recursive: true });
        const missing = regionPath(defaults, dir);
        rmSync(missing);
        assert.deepEqual(runDocsLimitsTool({ checkOnly: true, tablesDir: dir }).messages, [
          `docs table drift: ${missing} is missing; run npm run generate:limits`,
        ]);
        const generated = runDocsLimitsTool({ tablesDir: dir });
        assert.deepEqual(generated.changedPaths, [missing]);
        assert.equal(
          readFileSync(missing, "utf8"),
          readFileSync(join(repoRoot, regionPath(defaults)), "utf8"),
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("adjacent: generation creates an absent tables directory", () => {
      const dir = scratch();
      try {
        const tablesDir = join(dir, "tables");
        runDocsLimitsTool({ tablesDir });
        assert.deepEqual(runDocsLimitsTool({ checkOnly: true, tablesDir }), { status: "current" });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("refuses a hand edit anywhere in a table file, markers included", () => {
      const dir = scratch();
      try {
        cpSync(join(repoRoot, TABLES_DIR), dir, { recursive: true });
        const path = regionPath(defaults, dir);
        const original = readFileSync(path, "utf8");
        for (const edited of [
          `${original}\nA prose line.\n`,
          original.replace("start - run", "begin - run"),
        ]) {
          assert.notEqual(edited, original);
          writeFileSync(path, edited);
          assert.deepEqual(runDocsLimitsTool({ checkOnly: true, tablesDir: dir }).messages, [
            `docs table drift: ${path} does not match the catalog; run npm run generate:limits`,
          ]);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("refuses a stray file in the tables directory, and generation removes it", () => {
      const dir = scratch();
      try {
        cpSync(join(repoRoot, TABLES_DIR), dir, { recursive: true });
        const stray = `${dir}/retired-region.md`;
        writeFileSync(stray, "| a | b |\n");
        assert.deepEqual(runDocsLimitsTool({ checkOnly: true, tablesDir: dir }).messages, [
          `docs table drift: ${stray} is not a generated limits table; run npm run generate:limits`,
        ]);
        assert.deepEqual(runDocsLimitsTool({ tablesDir: dir }).changedPaths, [stray]);
        assert.equal(existsSync(stray), false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("row key selection", () => {
    it("keyBy: override renders the override env name as the row key", () => {
      const catalog = loadCatalog();
      const messageRegion = TABLE_REGIONS.find((region) => region.id === "slack-message-settings");
      const body = renderRegionTable(messageRegion, catalog);
      assert.ok(body.includes("`DOCSFAB_HOST_SLACK_TRANSPORT_TEXT_CHARS`"), body);
    });

    it("adjacent: keyBy: override refuses an entry with override: null, by name", () => {
      const catalog = structuredClone(loadCatalog());
      assert.equal(catalog["slackRoutes.replacementMaxRoutesPerProject"].override, null);
      const region = Object.freeze({
        id: "test-only-region",
        header: Object.freeze(["a", "b", "c"]),
        keyBy: "override",
        names: Object.freeze(["slackRoutes.replacementMaxRoutesPerProject"]),
      });
      assert.throws(
        () => renderRegionTable(region, catalog),
        /slackRoutes\.replacementMaxRoutesPerProject has no override but region uses keyBy: "override"/u,
      );
    });
  });

  it("refuses a region name absent from the catalog, by name", () => {
    const catalog = structuredClone(loadCatalog());
    const region = Object.freeze({
      id: "test-only-region",
      header: Object.freeze(["a", "b", "c"]),
      keyBy: "name",
      names: Object.freeze(["not.a.real.limit"]),
    });
    assert.throws(
      () => renderRegionTable(region, catalog),
      /catalog has no entry named not\.a\.real\.limit/u,
    );
  });

  it("adjacent: an existing entry missing docSummary is refused by name rather than rendering a blank cell", () => {
    const catalog = structuredClone(loadCatalog());
    delete catalog["compositionExecution.maxCumulativeInputTokens"].docSummary;
    const region = TABLE_REGIONS.find((entry) => entry.id === "operational-limits-defaults");
    assert.throws(
      () => renderRegionTable(region, catalog),
      /compositionExecution\.maxCumulativeInputTokens is missing docSummary/u,
    );
  });

  it("adjacent: an entry missing both docValue and docValueCode is refused by name rather than rendering a blank cell", () => {
    const catalog = structuredClone(loadCatalog());
    delete catalog["compositionExecution.maxCumulativeInputTokens"].docValue;
    const region = TABLE_REGIONS.find((entry) => entry.id === "operational-limits-defaults");
    assert.throws(
      () => renderRegionTable(region, catalog),
      /compositionExecution\.maxCumulativeInputTokens is missing docValue \(or docValueCode\)/u,
    );
  });

  it("docValueCode renders the bare numeric value as inline code instead of requiring docValue", () => {
    const catalog = loadCatalog();
    const messageRegion = TABLE_REGIONS.find((region) => region.id === "slack-message-settings");
    const body = renderRegionTable(messageRegion, catalog);
    assert.ok(body.includes("| `DOCSFAB_HOST_SLACK_LIVE_AGENT_ANSWER_MAX_CHUNKS` | `0` | "), body);
  });

  it("runs as a CLI when invoked through a symlink (W3-1 precedent: process.argv[1] is not symlink-resolved)", () => {
    const script = join(runtimeRoot, "scripts/docs-limits-table.mjs");
    const root = mkdtempSync(join(tmpdir(), "docsfab-docs-limits-symlink-"));
    try {
      const link = join(root, "docs-limits-table-link.mjs");
      symlinkSync(script, link);
      const direct = spawnSync(process.execPath, [script, "--check"], {
        cwd: repoRoot,
        encoding: "utf8",
      });
      const linked = spawnSync(process.execPath, [link, "--check"], {
        cwd: repoRoot,
        encoding: "utf8",
      });
      assert.equal(direct.status, 0, direct.stderr);
      assert.equal(linked.status, 0, linked.stderr);
      assert.equal(
        linked.stdout,
        direct.stdout,
        "invoking through a symlink produced different output than invoking directly",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("the derived-products graph's limits product covers docs-only and fragment-only changes (#1307)", () => {
    const product = DERIVED_PRODUCT_BY_ID.limits;
    const tables = `${TABLES_DIR}/**/*`;
    assert.ok(product.inputs.includes(tables), "limits.inputs should include the doc tables");
    assert.ok(
      product.inputs.includes("packages/runtime/scripts/docs-limits-table.mjs"),
      "limits.inputs should include the doc generator script",
    );
    assert.ok(product.outputs.includes(tables), "limits.outputs should include the doc tables");
    assert.ok(
      product.outputs.includes(CATALOG_JSON_PATH),
      "limits.outputs should still include the catalog mirror this module reads",
    );
    for (const path of TABLE_PATHS) {
      assert.ok(path.startsWith(`${TABLES_DIR}/`), `${path} should sit in ${TABLES_DIR}`);
    }
    // Adjacent: the prose pages are not part of the product, so a prose edit
    // selects no runtime job (the trigger coverage itself is pinned in
    // test/derived-preflight.test.ts).
    for (const path of PAGE_PATHS) {
      assert.ok(!product.inputs.includes(path), `limits.inputs should not include ${path}`);
      assert.ok(!product.outputs.includes(path), `limits.outputs should not include ${path}`);
    }
  });

  it("the prose pages include each generated table exactly once on its owning page", () => {
    const pages = new Map(
      PAGE_PATHS.map((path) => [path, readFileSync(join(repoRoot, path), "utf8")]),
    );
    for (const region of TABLE_REGIONS) {
      for (const [path, page] of pages) {
        assert.equal(
          page.split(regionInclude(region)).length - 1,
          path === region.pagePath ? 1 : 0,
          `${region.id}: ${path}`,
        );
      }
    }
    for (const [path, page] of pages) {
      assert.equal(page.includes("GENERATED:"), false, `${path} should hold no GENERATED marker`);
    }
  });

  it("the docs-lane CLI requires active includes while allowing ordinary prose edits", () => {
    const root = mkdtempSync(join(tmpdir(), "docsfab-docs-includes-"));
    try {
      const script = join(root, "packages/runtime/scripts/docs-limits-table.mjs");
      mkdirSync(dirname(script), { recursive: true });
      mkdirSync(join(root, "config"), { recursive: true });
      cpSync(join(runtimeRoot, "scripts/docs-limits-table.mjs"), script);
      cpSync(join(repoRoot, CATALOG_JSON_PATH), join(root, CATALOG_JSON_PATH));
      cpSync(join(repoRoot, TABLES_DIR), join(root, TABLES_DIR), { recursive: true });
      for (const path of PAGE_PATHS) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        cpSync(join(repoRoot, path), join(root, path));
      }
      const pagePath = join(root, TABLE_REGIONS[0].pagePath);
      const page = readFileSync(pagePath, "utf8");
      const include = regionInclude(TABLE_REGIONS[0]);
      const invoke = (body, entry = script) => {
        writeFileSync(pagePath, body);
        return spawnSync(process.execPath, [entry, "--check-includes"], { encoding: "utf8" });
      };
      for (const replacement of [
        "",
        `${include}\n\n${include}`,
        `\`\`\`mdx\n${include}\n\`\`\``,
        `<!--\n${include}\n-->`,
        `{/*\n${include}\n*/}`,
        `\`${include}\``,
        `    ${include}`,
      ]) {
        const result = invoke(page.replace(include, replacement));
        assert.equal(result.status, 1, result.stdout + result.stderr);
        assert.match(
          result.stderr,
          /docs table include: operational-limits-defaults expected exactly one active include/u,
        );
      }
      const metadataExample = invoke(
        page.replace(include, "").replace(/^description:.*$/mu, `description: |\n  ${include}`),
      );
      assert.equal(metadataExample.status, 1, metadataExample.stdout + metadataExample.stderr);
      assert.match(
        metadataExample.stderr,
        /docs table include: operational-limits-defaults expected exactly one active include/u,
      );
      for (const example of [
        "Ordinary additional prose.",
        "```text\n<!--\n```",
        "<!--\n```\n-->",
        "`<!--`",
      ]) {
        const result = invoke(page.replace(include, `${example}\n\n${include}`));
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.match(result.stdout, /pages include all generated limits tables/u);
      }
      const link = join(root, "linked-includes.mjs");
      symlinkSync(script, link);
      const linked = invoke(page, link);
      assert.equal(linked.status, 0, linked.stderr);
      assert.match(linked.stdout, /pages include all generated limits tables/u);
      for (const region of TABLE_REGIONS) {
        const path = join(root, region.pagePath);
        const body = readFileSync(path, "utf8");
        const tag = regionInclude(region);
        for (const replacement of ["", `${tag}\n\n${tag}`, `{/*\n${tag}\n*/}`]) {
          writeFileSync(path, body.replace(tag, replacement));
          const result = spawnSync(process.execPath, [script, "--check-includes"], {
            encoding: "utf8",
          });
          assert.equal(result.status, 1, result.stdout + result.stderr);
          assert.ok(result.stderr.includes(region.pagePath), result.stderr);
          assert.ok(result.stderr.includes(region.id), result.stderr);
        }
        writeFileSync(path, body);
        const otherPath = join(
          root,
          PAGE_PATHS.find((candidate) => candidate !== region.pagePath),
        );
        const otherBody = readFileSync(otherPath, "utf8");
        writeFileSync(otherPath, `${otherBody}\n${tag}\n`);
        const duplicate = spawnSync(process.execPath, [script, "--check-includes"], {
          encoding: "utf8",
        });
        assert.equal(duplicate.status, 1, duplicate.stdout + duplicate.stderr);
        assert.ok(
          duplicate.stderr.includes(`${region.id} belongs in ${region.pagePath}`),
          duplicate.stderr,
        );
        writeFileSync(otherPath, otherBody);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
