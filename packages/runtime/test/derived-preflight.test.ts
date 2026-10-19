// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { PRIVATE_CONTENT_PATHS } from "../src/config/private-content-paths.js";
import { CATALOG_SKILL_IDS, catalogSkillSourcePath } from "../src/skills/catalog-ids.js";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import { BUILD_GENERATED_MIRRORS, limitsScanCiPathPatterns } from "../scripts/check-limits.mjs";
import { BUILD_GENERATED_MIRRORS as MODEL_OUTPUT_BUILD_GENERATED_MIRRORS } from "../scripts/check-model-output.mjs";
import {
  derivedMachineCiPathPatterns,
  productRepairCommands,
} from "../scripts/derived-products.mjs";
import { affectedProductIds, parseArgs, runPreflight } from "../scripts/derived-preflight.mjs";
import { PAGE_PATHS as LIMITS_PAGE_PATHS, TABLE_PATHS } from "../scripts/docs-limits-table.mjs";
import { DEPLOY_ROOT_CONFIG_PATH, loadDeployRoot } from "../scripts/limits-deploy-root.mjs";
import {
  CHECKER_INPUTS,
  SCAN_ROOTS as REQUEST_WORDING_SCAN_ROOTS,
} from "../scripts/request-wording-scan-roots.mjs";
import { LIMIT_DEFINITION_BY_NAME } from "../src/config/limits.generated.js";
import { readGitlabCiConfig } from "./helpers/gitlab-ci.js";
import { internalOnly } from "./helpers/internal-path.js";
import { TEST_TIMEOUT_LIMITS, testTimeoutMs } from "./helpers/test-timeouts.js";

const comparisonProducts = PRIVATE_CONTENT_PATHS.modelComparisonSource
  ? ["model-comparison-kit"]
  : [];
const execute = promisify(execFile);
const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(runtimeRoot, "../..");
const roots: string[] = [];
const gitlabCi = internalOnly(
  ".gitlab/ci",
  "it pins the GitLab CI definition, which is not exported",
);

type DerivedCiRenderer = (source: string) => string;

// Loaded on first use so an exported tree without `.gitlab/ci` can still
// collect this file.
async function derivedCiGenerator(): Promise<{
  renderRuntimeDerivedCi: DerivedCiRenderer;
  renderProcessDerivedCi: DerivedCiRenderer;
  renderKnowledgeDerivedCi: DerivedCiRenderer;
}> {
  return import(
    pathToFileURL(resolve(repositoryRoot, ".gitlab/ci/generate-runtime-derived-ci.mjs")).href
  );
}

/**
 * Repository-relative files reached from `entries` through relative static
 * and dynamic imports, found by the TypeScript scanner rather than by the
 * module lists under test. A `.js` specifier with no file resolves to `.ts`.
 */
function importClosure(entries: string[]): string[] {
  const seen = new Set<string>();
  const pending = [...entries];
  while (pending.length > 0) {
    const file = pending.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const { importedFiles } = ts.preProcessFile(readFileSync(file, "utf8"), true, true);
    for (const { fileName } of importedFiles) {
      if (!fileName.startsWith(".")) continue;
      const target = resolve(dirname(file), fileName);
      const found = [target, target.replace(/\.js$/u, ".ts")].find(
        (candidate) => existsSync(candidate) && statSync(candidate).isFile(),
      );
      if (found === undefined) throw new Error(`${file} imports missing ${fileName}`);
      pending.push(found);
    }
  }
  return [...seen].map((file) => relative(repositoryRoot, file)).sort();
}

/** Every fixture path the model-output catalog files name. */
async function catalogFixturePaths(catalogRoot: string): Promise<string[]> {
  const paths = new Set<string>();
  for (const entry of await readdir(catalogRoot, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const text = await readFile(join(entry.parentPath, entry.name), "utf8");
    for (const [path] of text.matchAll(/packages\/runtime\/test\/fixtures\/[\w./-]+\.json/gu)) {
      paths.add(path);
    }
  }
  return [...paths].sort();
}

// Whether a GitLab `changes.paths` list of literals and `<dir>/**/*` globs
// selects `path`.
function triggeredBy(path: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    if (pattern.endsWith("/**/*")) return path.startsWith(pattern.slice(0, -"**/*".length));
    if (/[*?[{]/u.test(pattern)) throw new Error(`unsupported trigger pattern ${pattern}`);
    return path === pattern;
  });
}

type CiRule = { if?: string; changes?: { paths?: string[] } };

// Resolve the MR changes rule from parsed YAML so aliases and earlier rules
// cannot be mistaken for path entries.
function mergeRequestChangePaths(document: unknown, template: string): string[] {
  const definitions = document as Record<string, { rules?: CiRule[] }>;
  const rule = definitions[template]?.rules?.find(
    (candidate) =>
      candidate.if === '$CI_PIPELINE_SOURCE == "merge_request_event"' &&
      candidate.changes?.paths !== undefined,
  );
  if (!rule?.changes?.paths) throw new Error(`no MR changes rule in ${template}`);
  return rule.changes.paths;
}

// A generated limits doc table, wherever it lives: the start marker the limits
// generator writes, whatever the region id.
const LIMITS_TABLE_START = /\{\/\* GENERATED:[\w-]+ start - run `npm run generate:limits`/u;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("derived-product preflight selection", () => {
  it("normalizes safe paths, accumulates repeated flags, and rejects traversal", () => {
    expect(
      parseArgs([
        "--paths",
        "./packages/quality/checks/example.py",
        "--paths=packages/skills/example/SKILL.md",
      ]).paths,
    ).toEqual(["packages/quality/checks/example.py", "packages/skills/example/SKILL.md"]);
    expect(() => parseArgs(["--paths", "packages/quality/../skills/example/SKILL.md"])).toThrow(
      "Invalid repository-relative path",
    );
    expect(() => parseArgs(["--paths", "C:/workspace/file.txt"])).toThrow(
      "Invalid repository-relative path",
    );
  });

  // A job whose rules:changes are narrower than what it scans is a silent hole:
  // the MR skips the gate, the default branch runs it, and the failure lands on
  // main.
  it.skipIf(gitlabCi.skip)(
    gitlabCi.title("triggers the limits gate on every directory the checker scans"),
    async () => {
      // The deploy root is the one config/limits-deploy.json names.
      const deployRoot: string = loadDeployRoot(repositoryRoot);
      expect(deployRoot).toMatch(/^deploy\/[^/]+$/u);
      for (const scope of ["all", "deploy"] as const) {
        const patterns = limitsScanCiPathPatterns(scope);
        const scanned =
          scope === "deploy"
            ? [deployRoot]
            : ["packages/runtime/src", "packages/host/src", deployRoot];
        for (const root of scanned) {
          expect(patterns).toContain(`${root}/**/*`);
        }
        // The checker reads every fragment the root registry lists.
        expect(patterns).toContain("config/limits/**/*");
        // And every allowlist shard, through the shard loader module.
        expect(patterns).toContain("config/limits-allowlist/**/*");
        expect(patterns).toContain("packages/runtime/scripts/limits-allowlist-shards.mjs");
        // And the deploy configuration, through its reader.
        expect(patterns).toContain(DEPLOY_ROOT_CONFIG_PATH);
        expect(patterns).toContain("packages/runtime/scripts/limits-deploy-root.mjs");
      }

      const runtimeYml = await readFile(resolve(repositoryRoot, ".gitlab/ci/runtime.yml"), "utf8");
      const processYml = await readFile(resolve(repositoryRoot, ".gitlab/ci/process.yml"), "utf8");
      // runtime:static runs the gate unscoped; process:scripts runs --scope deploy.
      for (const pattern of limitsScanCiPathPatterns("all")) {
        expect(runtimeYml).toContain(`- ${pattern}`);
      }
      for (const pattern of limitsScanCiPathPatterns("deploy")) {
        expect(processYml).toContain(`- ${pattern}`);
      }
      // host.yml's service-status list is hand-maintained: wherever it names the
      // root registry it must also name the fragments.
      const hostYml = await readFile(resolve(repositoryRoot, ".gitlab/ci/host.yml"), "utf8");
      const rootLines = hostYml
        .split("\n")
        .filter((line) => line.trim() === "- config/limits.yaml");
      expect(rootLines.length).toBeGreaterThan(0);
      expect(
        hostYml.split("\n").filter((line) => line.trim() === "- config/limits/**/*"),
      ).toHaveLength(rootLines.length);
    },
  );

  it.skipIf(gitlabCi.skip)(
    gitlabCi.title("triggers runtime CI on every request-wording scan root and checker input"),
    async () => {
      const { renderRuntimeDerivedCi } = await derivedCiGenerator();
      const runtimeYml = await readFile(resolve(repositoryRoot, ".gitlab/ci/runtime.yml"), "utf8");
      const paths = mergeRequestChangePaths(parseYaml(runtimeYml), ".rules:runtime");
      // `<dir>/**/*` matches anything beneath <dir>; any other entry is a file.
      const selects = (file: string) =>
        paths.some((path) =>
          path.endsWith("/**/*") ? file.startsWith(path.slice(0, -"**/*".length)) : path === file,
        );
      for (const file of [
        "packages/knowledge/src/first-pass/parse.mjs",
        ...REQUEST_WORDING_SCAN_ROOTS.map((root) => `${root}/new-module.mjs`),
        ...CHECKER_INPUTS,
      ]) {
        expect({ file, selected: selects(file) }).toEqual({ file, selected: true });
      }
      // Adjacent: a knowledge change outside the scan roots does not select it.
      expect(selects("packages/knowledge/tests/first-pass-parse.test.mjs")).toBe(false);

      // The block is generated: dropping the knowledge root is restored.
      const knowledgeLine = "          - packages/knowledge/src/**/*\n";
      expect(runtimeYml).toContain(knowledgeLine);
      expect(renderRuntimeDerivedCi(runtimeYml.replace(knowledgeLine, ""))).toBe(runtimeYml);
    },
  );

  it.skipIf(gitlabCi.skip)(
    gitlabCi.title(
      "triggers runtime and knowledge CI on every file that holds a generated limits doc table, and not on the prose page",
    ),
    async () => {
      // Every Markdown file in the checkout, tracked or not yet added, so a
      // table pasted back into a page or written to a new path is found.
      const { stdout } = await execute(
        "git",
        ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "*.md", "*.mdx"],
        { cwd: repositoryRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
      );
      const holders: string[] = [];
      for (const path of new Set(stdout.split("\0").filter(Boolean))) {
        const file = resolve(repositoryRoot, path);
        if (!existsSync(file)) continue;
        if (LIMITS_TABLE_START.test(await readFile(file, "utf8"))) holders.push(path);
      }
      // The generated content lives in the generator's own files and nowhere else.
      expect(holders.sort()).toEqual([...TABLE_PATHS].sort());

      const runtime = mergeRequestChangePaths(
        parseYaml(await readFile(resolve(repositoryRoot, ".gitlab/ci/runtime.yml"), "utf8")),
        ".rules:runtime",
      );
      const knowledge = mergeRequestChangePaths(
        parseYaml(await readFile(resolve(repositoryRoot, ".gitlab/ci/knowledge.yml"), "utf8")),
        ".rules:knowledge",
      );
      const { definitions } = await readGitlabCiConfig(repositoryRoot);
      const docsTemplate = definitions[".rules:docs"] as {
        rules: { if?: string; changes?: { paths: string[] } }[];
      };
      const docsRule = docsTemplate.rules.find(
        (rule) => rule.if === '$CI_PIPELINE_SOURCE == "merge_request_event"',
      );
      if (!docsRule?.changes) throw new Error("The docs MR changes rule is missing.");
      const docs = docsRule.changes.paths;
      for (const path of holders) {
        expect({
          path,
          runtime: triggeredBy(path, runtime),
          knowledge: triggeredBy(path, knowledge),
          preflight: affectedProductIds([path]).includes("limits"),
        }).toEqual({ path, runtime: true, knowledge: true, preflight: true });
      }
      // The prose pages select docs checks; runtime, knowledge and the limits
      // preflight stay unselected.
      for (const path of LIMITS_PAGE_PATHS) {
        expect({
          path,
          runtime: triggeredBy(path, runtime),
          knowledge: triggeredBy(path, knowledge),
          docs: triggeredBy(path, docs),
          preflight: affectedProductIds([path]),
        }).toEqual({ path, runtime: false, knowledge: false, docs: true, preflight: [] });
      }
      const docsJob = definitions["docs:check"] as { script: string[] };
      expect(docsJob.script).toContain(
        'node "$CI_PROJECT_DIR/packages/runtime/scripts/docs-limits-table.mjs" --check-includes',
      );
    },
  );

  it.skipIf(gitlabCi.skip)(
    gitlabCi.title("detects stale generated CI path blocks without mutating the file"),
    async () => {
      const { renderProcessDerivedCi, renderRuntimeDerivedCi } = await derivedCiGenerator();
      const pipelinePath = resolve(repositoryRoot, ".gitlab/ci/runtime.yml");
      const current = await readFile(pipelinePath, "utf8");
      expect(renderRuntimeDerivedCi(current)).toBe(current);
      const stale = current.replace(
        "          - packages/skills/**/*",
        "          - packages/skills/removed/**/*",
      );
      expect(renderRuntimeDerivedCi(stale)).toBe(current);
      expect(await readFile(pipelinePath, "utf8")).toBe(current);

      const processPath = resolve(repositoryRoot, ".gitlab/ci/process.yml");
      const currentProcess = await readFile(processPath, "utf8");
      expect(renderProcessDerivedCi(currentProcess)).toBe(currentProcess);
      const deployGlob = `          - ${loadDeployRoot(repositoryRoot)}/**/*`;
      expect(currentProcess).toContain(deployGlob);
      const staleProcess = currentProcess.replace(
        deployGlob,
        deployGlob.replace("/**/*", "/removed/**/*"),
      );
      expect(renderProcessDerivedCi(staleProcess)).toBe(currentProcess);
      expect(await readFile(processPath, "utf8")).toBe(currentProcess);
    },
  );

  it("selects prerequisites and dependents in graph order", () => {
    // The model-output catalog reads canonical schemas, so it depends on no
    // staged product.
    expect(affectedProductIds(["packages/quality/checks/example.py"])).toEqual([
      "skill-crate",
      "quality-pack",
    ]);
    expect(affectedProductIds(["packages/quality/schemas/review-result.schema.json"])).toEqual([
      "model-output",
      "skill-crate",
      "quality-pack",
    ]);
    expect(affectedProductIds(["packages/skills/write-documentation/SKILL.md"])).toEqual([
      "skill-crate",
      "quality-pack",
    ]);
    expect(affectedProductIds(["config/model-output/rules/revision-accounting.yaml"])).toEqual([
      "model-output",
    ]);
    expect(affectedProductIds(["packages/knowledge/src/model-output.generated.mjs"])).toEqual([
      "model-output",
    ]);
    expect(
      affectedProductIds(["packages/runtime/governed-assets/model-comparison/output.json"]),
    ).toEqual(comparisonProducts);
    expect(
      affectedProductIds(["packages/runtime/scripts/generate-model-comparison-kit-corpus.mjs"]),
    ).toEqual(comparisonProducts);
    expect(affectedProductIds(["packages/runtime/scripts/derived-preflight.mjs"])).toEqual([
      "skill-crate",
      "quality-pack",
      ...comparisonProducts,
    ]);
    expect(affectedProductIds(["packages/runtime/src/skills/catalog-ids.ts"])).toEqual([
      "skill-crate",
      "quality-pack",
    ]);
    expect(
      affectedProductIds(["packages/runtime/src/execution/response-contract-keys.js"]),
    ).toEqual(["model-output"]);
    // Hosted knowledge skills feed the crate and quality pack; the campaign kit is
    // not a factory-loop dependent (it has no skill inputs and no dependencies).
    expect(
      affectedProductIds(["packages/knowledge/skills/reconcile-product-behavior/SKILL.md"]),
    ).toEqual(["skill-crate", "quality-pack"]);
    expect(affectedProductIds(["packages/knowledge/skills/unpack-source-thread/SKILL.md"])).toEqual(
      [],
    );
    expect(affectedProductIds(["docs/about/index.md"])).toEqual([]);
    expect(affectedProductIds(["packages/runtime/src/cli.ts"])).toEqual([]);
    // check-model-output reads the catalog through check-limits' loader.
    expect(affectedProductIds(["packages/runtime/scripts/check-limits.mjs"])).toEqual([
      "limits",
      "model-output",
    ]);
    // Catalog statements name limits, so the catalog is re-checked with them.
    expect(affectedProductIds(["config/limits.yaml"])).toEqual(["limits", "model-output"]);
    // A per-owner fragment is an input to both, like the root registry.
    expect(affectedProductIds(["config/limits/host.yaml"])).toEqual(["limits", "model-output"]);
    // A sibling path that only shares the prefix text is not.
    expect(affectedProductIds(["config/limits-notes/host.yaml"])).toEqual([]);
    // An allowlist shard re-checks the limits product only; the shard loader
    // is also a module check-model-output imports, so it re-checks both.
    expect(affectedProductIds(["config/limits-allowlist/runtime.model.json"])).toEqual(["limits"]);
    expect(affectedProductIds(["packages/runtime/scripts/limits-allowlist-shards.mjs"])).toEqual([
      "limits",
      "model-output",
    ]);
    expect(affectedProductIds(["config/env-admission.yaml"])).toEqual(["env-admission"]);
    expect(affectedProductIds([".gitlab/ci/runtime-run-env.generated.sh"])).toEqual([
      "env-admission",
    ]);
    expect(affectedProductIds(["packages/runtime/scripts/check-env-admission.mjs"])).toEqual([
      "env-admission",
    ]);
    expect(productRepairCommands("env-admission")).toEqual(["npm run generate:env-admission"]);
    expect(productRepairCommands("skill-crate")).toEqual([
      "npm run generate:skill-crate",
      "npm run generate:quality-pack",
    ]);
    expect(productRepairCommands("quality-pack")).toEqual(["npm run generate:quality-pack"]);
    expect(productRepairCommands("model-output")).toEqual(["npm run generate:model-output"]);
  });

  it(
    "checks the limits product's committed outputs only and names the build-generated mirrors it skips",
    async () => {
      const report = await runPreflight({ paths: ["config/limits/derived.yaml"] });
      expect({ status: report.status, products: report.products }).toEqual({
        status: "passed",
        products: ["limits", "model-output"],
      });
      // Each skip line names one path; check-limits.test.mjs holds their wording.
      expect(report.skipped.map((line) => line.split(": ")[0]).sort()).toEqual(
        [...BUILD_GENERATED_MIRRORS, ...MODEL_OUTPUT_BUILD_GENERATED_MIRRORS].sort(),
      );
      // Two generator checks; budgeted at the shared CI default rather than a literal.
    },
    testTimeoutMs(LIMIT_DEFINITION_BY_NAME[TEST_TIMEOUT_LIMITS.ciTest]!.value),
  );

  it("checks every product when an explicit diff base is unavailable", async () => {
    const report = await runPreflight({ base: "f".repeat(40) });
    expect(report.products).toEqual([
      "limits",
      "env-admission",
      "model-output",
      "skill-crate",
      "quality-pack",
      ...comparisonProducts,
    ]);
    expect(report.source).toContain("all (diff base unavailable)");
  }, 60_000);

  it.skipIf(gitlabCi.skip)(
    gitlabCi.title("selects runtime CI for env-admission yaml-only and generated-shell-only paths"),
    async () => {
      const patterns = derivedMachineCiPathPatterns();
      for (const pattern of [
        "config/env-admission.yaml",
        "packages/runtime/scripts/check-env-admission.mjs",
        "packages/runtime/src/config/env-admission.generated.ts",
        ".gitlab/ci/runtime-run-env.generated.sh",
      ]) {
        expect(patterns).toContain(pattern);
      }

      const { renderRuntimeDerivedCi } = await derivedCiGenerator();
      const runtimeYml = await readFile(resolve(repositoryRoot, ".gitlab/ci/runtime.yml"), "utf8");
      expect(renderRuntimeDerivedCi(runtimeYml)).toBe(runtimeYml);
      for (const pattern of [
        "config/env-admission.yaml",
        ".gitlab/ci/runtime-run-env.generated.sh",
      ]) {
        expect(runtimeYml).toContain(`- ${pattern}`);
      }
      // A derived path under a hand-listed `<dir>/**/*` in the same array is
      // dropped, since it only spends one of GitLab's 50 `changes` entries.
      expect(runtimeYml).not.toContain("- packages/runtime/scripts/check-env-admission.mjs");
      expect(runtimeYml).toContain("- packages/runtime/**/*");

      const omittedYaml = runtimeYml.replace("          - config/env-admission.yaml\n", "");
      expect(omittedYaml).not.toBe(runtimeYml);
      expect(renderRuntimeDerivedCi(omittedYaml)).toBe(runtimeYml);

      const omittedShell = runtimeYml.replace(
        "          - .gitlab/ci/runtime-run-env.generated.sh\n",
        "",
      );
      expect(omittedShell).not.toBe(runtimeYml);
      expect(renderRuntimeDerivedCi(omittedShell)).toBe(runtimeYml);
    },
  );
});

describe("derived-product mutation regression", () => {
  it("requires quality-pack only and leaves checks read-only", async () => {
    const root = await fixtureRepository();
    const runtime = join(root, "packages/runtime");
    const qualitySource = join(root, "packages/quality/checks/collect_doc_quality_signals.py");
    const qualityLock = join(runtime, "quality/lock.json");
    await execute(process.execPath, [join(runtime, "scripts/generate-quality-pack.mjs")], {
      cwd: runtime,
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const beforeQuality = await readFile(qualityLock);
    await writeFile(
      qualitySource,
      `${await readFile(qualitySource, "utf8")}# preflight mutation\n`,
    );

    const staleQuality = await runPreflight({
      paths: ["packages/quality/checks/collect_doc_quality_signals.py"],
      repositoryRoot: root,
      runtimeRoot: runtime,
    });
    expect(staleQuality.status).toBe("failed");
    expect(staleQuality.firstFailure?.id).toBe("quality-pack");
    expect(staleQuality.firstFailure?.message).toContain("npm run generate:quality-pack");
    expect(staleQuality.firstFailure?.message).not.toContain(
      "npm run generate:model-comparison-kit",
    );
    expect(await readFile(qualityLock)).toEqual(beforeQuality);

    await execute(process.execPath, [join(runtime, "scripts/generate-quality-pack.mjs")], {
      cwd: runtime,
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    await expect(
      runPreflight({
        paths: ["packages/quality/checks/collect_doc_quality_signals.py"],
        repositoryRoot: root,
        runtimeRoot: runtime,
      }),
    ).resolves.toMatchObject({
      status: "passed",
      products: ["skill-crate", "quality-pack"],
    });
  }, 60_000);

  it.skipIf(gitlabCi.skip)(
    gitlabCi.title(
      "refuses drifted env-admission mirrors on yaml-only and generated-shell-only paths",
    ),
    async () => {
      const shellPath = resolve(repositoryRoot, ".gitlab/ci/runtime-run-env.generated.sh");
      const original = await readFile(shellPath, "utf8");
      try {
        await writeFile(shellPath, `${original}\n# preflight mutation\n`);
        for (const path of [
          "config/env-admission.yaml",
          ".gitlab/ci/runtime-run-env.generated.sh",
        ]) {
          const stale = await runPreflight({ paths: [path] });
          expect(stale.status).toBe("failed");
          expect(stale.firstFailure?.id).toBe("env-admission");
          expect(stale.firstFailure?.message).toContain("npm run generate:env-admission");
        }
      } finally {
        await writeFile(shellPath, original);
      }
      await expect(runPreflight({ paths: ["config/env-admission.yaml"] })).resolves.toMatchObject({
        status: "passed",
        products: ["env-admission"],
      });
    },
    60_000,
  );
});

async function fixtureRepository(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "docsfab-derived-preflight-")));
  roots.push(root);
  const copies: Array<[string, string]> = [
    [".gitignore", ".gitignore"],
    ["packages/quality/checks", "packages/quality/checks"],
    ["packages/quality/formats", "packages/quality/formats"],
    ["packages/quality/profiles", "packages/quality/profiles"],
    ["packages/quality/rubrics", "packages/quality/rubrics"],
    ["packages/quality/runtime-policy", "packages/quality/runtime-policy"],
    ["packages/quality/schemas", "packages/quality/schemas"],
    ["packages/runtime/skill-crate/lock.json", "packages/runtime/skill-crate/lock.json"],
    ["packages/runtime/src/skills/catalog-ids.ts", "packages/runtime/src/skills/catalog-ids.ts"],
    ["packages/runtime/src/skills/catalog-ids.js", "packages/runtime/src/skills/catalog-ids.js"],
    [
      "packages/runtime/src/config/private-content-paths.js",
      "packages/runtime/src/config/private-content-paths.js",
    ],
    [
      "packages/runtime/src/quality-pack/resource-roles.js",
      "packages/runtime/src/quality-pack/resource-roles.js",
    ],
    ["packages/runtime/quality", "packages/runtime/quality"],
    ["packages/runtime/quality-pack/manifest.json", "packages/runtime/quality-pack/manifest.json"],
    ["packages/runtime/.gitignore", "packages/runtime/.gitignore"],
    [
      "packages/runtime/scripts/generate-catalog-crate.mjs",
      "packages/runtime/scripts/generate-catalog-crate.mjs",
    ],
    [
      "packages/runtime/scripts/generate-quality-pack.mjs",
      "packages/runtime/scripts/generate-quality-pack.mjs",
    ],
    [
      "packages/runtime/scripts/derived-products.mjs",
      "packages/runtime/scripts/derived-products.mjs",
    ],
    // derived-products.mjs reads the deploy root through this module.
    [
      "packages/runtime/scripts/limits-deploy-root.mjs",
      "packages/runtime/scripts/limits-deploy-root.mjs",
    ],
    [
      "packages/runtime/scripts/derived-preflight.mjs",
      "packages/runtime/scripts/derived-preflight.mjs",
    ],
  ];
  for (const id of CATALOG_SKILL_IDS) {
    const sourceDirectory = dirname(catalogSkillSourcePath(id)!);
    copies.push([sourceDirectory, sourceDirectory]);
    copies.push([`packages/runtime/skill-crate/${id}`, `packages/runtime/skill-crate/${id}`]);
  }
  for (const [source, destination] of copies) {
    await cp(resolve(repositoryRoot, source), join(root, destination), { recursive: true });
  }
  await execute("git", ["init", "--initial-branch", "main"], { cwd: root });
  await execute("git", ["config", "user.name", "DocsFab Generator Test"], { cwd: root });
  await execute("git", ["config", "user.email", "generator@example.invalid"], { cwd: root });
  await execute("git", ["add", "--all"], { cwd: root });
  await execute("git", ["commit", "--message", "fixture"], { cwd: root });
  return root;
}

describe("build-generated mirrors in CI", () => {
  it.skipIf(gitlabCi.skip)(
    gitlabCi.title("runtime:prepare runs the reproducibility check after npm ci"),
    async () => {
      const pipeline = parseYaml(
        await readFile(resolve(repositoryRoot, ".gitlab/ci/runtime.yml"), "utf8"),
      ) as Record<string, { script?: string[] }>;
      const script = (pipeline["runtime:prepare"]?.script ?? []).map((line) => line.trim());
      // Each line runs its command through the job's runner wrapper.
      const reproducible = script.findIndex((line) => line.endsWith(" npm run check:reproducible"));
      const install = script.findIndex((line) => line.endsWith(" npm ci"));
      expect(install).toBeGreaterThanOrEqual(0);
      expect(reproducible).toBeGreaterThan(install);
      const scripts = (
        JSON.parse(await readFile(join(runtimeRoot, "package.json"), "utf8")) as {
          scripts: Record<string, string>;
        }
      ).scripts;
      expect(scripts["check:reproducible"]).toBe("node scripts/check-derived-reproducible.mjs");
    },
  );

  it.skipIf(gitlabCi.skip)(
    gitlabCi.title("the CI path-block generator runs its command line through a symlink"),
    async () => {
      const root = await mkdtemp(join(tmpdir(), "docsfab-derived-ci-link-"));
      roots.push(root);
      const link = join(root, "generate-runtime-derived-ci-link.mjs");
      await symlink(resolve(repositoryRoot, ".gitlab/ci/generate-runtime-derived-ci.mjs"), link);
      // An unresolved entry check would skip the command line and exit 0.
      const failure = await execute(process.execPath, [link, "--no-such-flag"]).then(
        () => undefined,
        (error: { code?: number; stderr?: string }) => error,
      );
      expect({ code: failure?.code, stderr: failure?.stderr }).toEqual({
        code: 1,
        stderr:
          "runtime CI rendering failed: runtime CI rendering accepts only the optional --check flag\n",
      });
    },
  );

  it.skipIf(gitlabCi.skip)(
    gitlabCi.title(
      "knowledge:test triggers on every module its generation step imports and every fixture its catalog names",
    ),
    async () => {
      const { renderKnowledgeDerivedCi } = await derivedCiGenerator();
      const { ENSURE_DERIVED_MODULES, selectEnsureDerivedSteps } = await import(
        "../scripts/ensure-derived.mjs"
      );
      const { DERIVED_PRODUCT_BY_ID } = await import("../scripts/derived-products.mjs");
      // The hook entry and its steps, read from the command knowledge:test runs.
      const knowledgeRoot = resolve(repositoryRoot, "packages/knowledge");
      const scripts = (
        JSON.parse(await readFile(join(knowledgeRoot, "package.json"), "utf8")) as {
          scripts: Record<string, string>;
        }
      ).scripts;
      const invocations = Object.entries(scripts).flatMap(([name, command]) => {
        const match = /node (\S*ensure-derived\.mjs) --steps (\S+)/u.exec(command);
        return match ? [{ name, hook: resolve(knowledgeRoot, match[1]), ids: match[2] }] : [];
      });
      expect(invocations.map(({ name }) => name)).toEqual(["test:control-plane"]);
      const [{ name, hook, ids }] = invocations;
      expect(scripts.test).toContain(`npm run ${name}`);
      const knowledgeCi = await readFile(
        resolve(repositoryRoot, ".gitlab/ci/knowledge.yml"),
        "utf8",
      );
      const pipeline = parseYaml(renderKnowledgeDerivedCi(knowledgeCi)) as Record<
        string,
        { extends?: string; rules?: { if?: string; changes?: { paths?: string[] } }[] }
      >;
      expect(pipeline["knowledge:test"]?.extends).toBe(".rules:knowledge");
      const triggers = mergeRequestChangePaths(pipeline, ".rules:knowledge");
      const steps = selectEnsureDerivedSteps(ids.split(",")) as { id: string }[];
      expect(steps.map(({ id }) => id)).toEqual(["limits", "model-output"]);
      const hookModules = importClosure([hook]);
      expect([...ENSURE_DERIVED_MODULES].sort()).toEqual(hookModules);
      const read = importClosure([
        hook,
        ...steps.map(({ id }) =>
          resolve(runtimeRoot, "scripts", DERIVED_PRODUCT_BY_ID[id].script as string),
        ),
      ]);
      // Each product declares its own generator's closure, which the
      // preflight and the source-checkout launcher read too.
      for (const { id } of steps) {
        const { inputs, script } = DERIVED_PRODUCT_BY_ID[id] as {
          inputs: string[];
          script: string;
        };
        const closure = importClosure([resolve(runtimeRoot, "scripts", script)]);
        expect(closure.filter((path) => !triggeredBy(path, inputs))).toEqual([]);
      }
      // derived-products.mjs reads the deploy-root config when it loads.
      expect(triggers).toContain(DEPLOY_ROOT_CONFIG_PATH);
      const fixtures = await catalogFixturePaths(resolve(repositoryRoot, "config/model-output"));
      expect(fixtures.length).toBeGreaterThan(0);
      expect([...read, ...fixtures].filter((path) => !triggeredBy(path, triggers))).toEqual([]);
    },
  );

  it.skipIf(gitlabCi.skip)(
    gitlabCi.title("the CI path-block generator command line checks and rewrites knowledge.yml"),
    async () => {
      const root = await realpath(await mkdtemp(join(tmpdir(), "docsfab-derived-ci-cli-")));
      roots.push(root);
      const ci = join(root, ".gitlab/ci");
      await mkdir(ci, { recursive: true });
      for (const file of [
        "generate-runtime-derived-ci.mjs",
        "runtime.yml",
        "process.yml",
        "knowledge.yml",
      ]) {
        await cp(resolve(repositoryRoot, ".gitlab/ci", file), join(ci, file));
      }
      // The copied entry imports the real derivation modules through this link.
      await symlink(resolve(repositoryRoot, "packages"), join(root, "packages"));
      const run = (args: string[]) =>
        execute(process.execPath, [join(ci, "generate-runtime-derived-ci.mjs"), ...args]).then(
          ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
          (error: { code?: number; stdout?: string; stderr?: string }) => ({
            code: error.code,
            stdout: error.stdout,
            stderr: error.stderr,
          }),
        );
      const current = await run(["--check"]);
      expect(current.code).toBe(0);
      expect(current.stdout).toContain("knowledge.yml derived-product paths are current\n");

      const committed = await readFile(join(ci, "knowledge.yml"), "utf8");
      const dropped = "          - packages/runtime/scripts/check-model-output.mjs\n";
      expect(committed).toContain(dropped);
      const stale = committed.replace(dropped, "");
      await writeFile(join(ci, "knowledge.yml"), stale);
      const checked = await run(["--check"]);
      expect({ code: checked.code, stderr: checked.stderr }).toEqual({
        code: 1,
        stderr:
          "knowledge.yml derived-product paths are stale\n" +
          "runtime CI rendering failed: generated CI path blocks are stale; run node .gitlab/ci/generate-runtime-derived-ci.mjs\n",
      });
      expect(await readFile(join(ci, "knowledge.yml"), "utf8")).toBe(stale);

      const rewritten = await run([]);
      expect(rewritten.code).toBe(0);
      expect(rewritten.stdout).toContain("Updated knowledge.yml derived-product paths\n");
      expect(await readFile(join(ci, "knowledge.yml"), "utf8")).toBe(committed);
    },
  );
});
