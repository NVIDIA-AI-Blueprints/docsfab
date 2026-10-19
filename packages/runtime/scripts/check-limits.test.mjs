// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import Module from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative as relativePath, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const testApi = process.env.VITEST ? await import("vitest") : await import("node:test");
const { describe, it } = testApi;

import {
  boundAssignKind,
  BUILD_GENERATED_MIRRORS,
  compareAllowlist,
  extractGitlabJob,
  gitlabDurationFromMs,
  GITLAB_ARTIFACT_RETENTION_JOBS,
  gitlabExpireInFromDays,
  KNOWLEDGE_FIRST_PASS_GENERATED,
  limitsScanCiPathPatterns,
  loadAllowlist,
  loadLimitDefinitions,
  loadYamlParse,
  matchBoundLiterals,
  parseArgs,
  parseLimitsYamlSubset,
  renderGitlabArtifactRetentionLimits,
  renderGitlabLiveModelLimits,
  renderCatalogJson,
  renderGitlabSastLimits,
  renderTrainReuseLimits,
  renderKnowledgeFirstPassLimits,
  renderMirrors,
  renderShell,
  renderTypeScript,
  runLimitsTool,
  SAST_MAX_TARGET_BYTES_VARIABLE,
  SAST_SEMGREP_TIMEOUT_VARIABLE,
  scanBoundLiterals,
  verifyGitlabArtifactRetentionIncludePresence,
  verifyGitlabArtifactRetentionProjection,
  verifyGitlabLiveModelProjection,
  verifyGitlabSastIncludePresence,
  verifyGitlabSastProjection,
  writeBuildGeneratedMirrors,
} from "./check-limits.mjs";
import { PAGE_PATHS, TABLE_PATHS, TABLES_DIR } from "./docs-limits-table.mjs";
import {
  EXPORT_EXCLUDED,
  holdsExportExcluded,
  internalOnly,
  isExportExcluded,
} from "./internal-path.test-helper.mjs";
import {
  loadAllowlistForRewrite,
  partitionAllowlist,
  renderAllowlistFiles,
  shardFileForOwner,
} from "./limits-allowlist-shards.mjs";
import {
  DEPLOY_ROOT_CONFIG_PATH,
  deployShellMirrorPath,
  loadDeployRoot,
} from "./limits-deploy-root.mjs";

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(runtimeRoot, "../..");
// Git does not track the limits code mirrors, and this file runs under
// `node --test` with no generation step first (`test:generate-derived`). The
// copied-tree cases below copy them like every other output, so write them
// first: only those two, so a committed output stays as the checkout has it.
writeBuildGeneratedMirrors();
const yamlPath = join(repositoryRoot, "config/limits.yaml");
const fragmentDir = join(repositoryRoot, "config/limits");
const generatedPath = join(runtimeRoot, "src/config/limits.generated.ts");
const allowlistRootPath = join(repositoryRoot, "config/limits-allowlist.json");
const allowlistShardDir = join(repositoryRoot, "config/limits-allowlist");
// The deploy scan root this checkout configures. The public export leaves
// out config/limits-deploy.json, so there it is null and every case that
// needs it skips on that file.
const DEPLOY_ROOT = loadDeployRoot(repositoryRoot);
const DEPLOY_SHARD_FILE = DEPLOY_ROOT === null ? null : shardFileForOwner(DEPLOY_ROOT);
const DEPLOY_SHARD =
  DEPLOY_SHARD_FILE === null ? null : `config/limits-allowlist/${DEPLOY_SHARD_FILE}`;
const DEPLOY_MIRROR = DEPLOY_ROOT === null ? null : deployShellMirrorPath(DEPLOY_ROOT);
const deployPaths = (...paths) => [DEPLOY_ROOT_CONFIG_PATH, ...paths.filter(Boolean)];
const DEPLOY_ROOT_CASE = internalOnly(
  deployPaths(DEPLOY_ROOT, DEPLOY_SHARD),
  "needs the deploy scan root and its allowlist shard",
);
// Copies every registered allowlist shard, the deploy shard included.
const SHARD_SET_CASE = internalOnly(
  deployPaths(DEPLOY_SHARD),
  "copies every registered allowlist shard",
);
const DEPLOY_MIRROR_CASE = internalOnly(
  deployPaths(DEPLOY_MIRROR),
  "compares against the committed deploy shell mirror",
);
// A neutral deploy root the partial-tree cases configure for themselves.
const FIXTURE_DEPLOY_ROOT = "deploy/fixture-host";
const RUNTIME_CI_CASE = internalOnly(".gitlab/ci/runtime.yml", "reads the runtime CI jobs");
const SAST_JOB_CASE = internalOnly(
  ".gitlab/ci/blueprint-compliance.yml",
  "reads the checked-in semgrep-sast job",
);
const CI_INCLUDE_CASE = internalOnly(".gitlab-ci.yml", "reads the pipeline include lines");
const CI_YAML_JOB_CASE = internalOnly(".gitlab/ci/process.yml", "reads the ci:yaml job");

describe("limits yaml preflight parser", () => {
  it("validates proposed host overrides without npm dependencies", async () => {
    const root = mkdtempSync(join(tmpdir(), "docsfab-host-limits-"));
    const valid = join(root, "valid.env");
    const invalid = join(root, "invalid.env");
    writeFileSync(
      valid,
      "DOCSFAB_COMPOSITION_EXECUTION_TIMEOUT_MS=2000000\nDOCSFAB_HEALTH_PORT=4311\n",
    );
    writeFileSync(invalid, "DOCSFAB_COMPOSITION_EXECUTION_TIMEOUT_MS=3600001\n");
    try {
      const checked = await runLimitsTool({ hostFile: valid });
      assert.deepEqual(checked, {
        status: "host-overrides-checked",
        keys: ["DOCSFAB_COMPOSITION_EXECUTION_TIMEOUT_MS"],
      });
      await assert.rejects(
        () => runLimitsTool({ hostFile: invalid }),
        /DOCSFAB_COMPOSITION_EXECUTION_TIMEOUT_MS must be an integer between 1 and 3600000/u,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("matches the npm yaml package on the canonical document", () => {
    const npmParse = loadYamlParse();
    assert.ok(npmParse, "local check expects yaml when node_modules is installed");
    const parseYaml = (text) => npmParse(text);
    const fromPackage = loadLimitDefinitions({ parseYaml });
    const fromSubset = loadLimitDefinitions({ parseYaml: parseLimitsYamlSubset });
    assert.deepEqual(fromSubset, fromPackage);
    // Document-level parity too: a subset-parser divergence in a field the
    // loader ignores would not show in the composed result.
    const documents = [
      yamlPath,
      ...registeredFragments().map(({ file }) => join(fragmentDir, file)),
    ];
    assert.ok(documents.length > 1, "expected the root plus at least one fragment");
    for (const path of documents) {
      const text = readFileSync(path, "utf8");
      assert.deepEqual(parseLimitsYamlSubset(text), npmParse(text), path);
    }
  });

  it("renders the same TypeScript mirror from the subset parser as from the npm yaml package", () => {
    // The build may generate the mirror without the npm package installed, so
    // both parsers must yield the same bytes; a file on disk would only show
    // whichever parser wrote it.
    const npmParse = loadYamlParse();
    assert.ok(npmParse, "local check expects yaml when node_modules is installed");
    const fromSubset = renderTypeScript(loadLimitDefinitions({ parseYaml: parseLimitsYamlSubset }));
    assert.equal(
      fromSubset,
      renderTypeScript(loadLimitDefinitions({ parseYaml: (text) => npmParse(text) })),
    );
    assert.match(fromSubset, /^export const LIMIT_DEFINITIONS: /mu);
  });

  it("loadLimitDefinitions and --check work when yaml cannot be required", async () => {
    const definitions = withYamlHidden(() => loadLimitDefinitions());
    assert.ok(definitions.length > 0);
    const result = await withYamlHidden(() => runLimitsTool({ checkOnly: true, scope: "all" }));
    assert.equal(result.status, "checked");
    assert.equal(result.count, definitions.length);

    const preloadDir = mkdtempSync(join(tmpdir(), "docsfab-hide-yaml-"));
    const preload = join(preloadDir, "hide-yaml.cjs");
    writeFileSync(
      preload,
      `const Module = require("module");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "yaml") {
    const error = new Error("Cannot find module 'yaml'");
    error.code = "MODULE_NOT_FOUND";
    throw error;
  }
  return origResolve.call(this, request, ...rest);
};
`,
    );
    try {
      const spawned = spawnSync(
        process.execPath,
        ["--require", preload, "scripts/check-limits.mjs", "--check"],
        { cwd: runtimeRoot, encoding: "utf8" },
      );
      assert.equal(spawned.status, 0, spawned.stderr || spawned.stdout);
      assert.match(spawned.stdout, /Limits configuration is current/u);
    } finally {
      rmSync(preloadDir, { recursive: true, force: true });
    }
  });

  it("rejects quoted and folded scalars outside the subset", () => {
    assert.throws(() => parseLimitsYamlSubset('kind: "quoted"\n'), /unsupported scalar/u);
  });

  it("names the document it is parsing in a syntax refusal", () => {
    assert.throws(
      () => parseLimitsYamlSubset("limits:\n\t- name: x\n", "config/limits/host.yaml"),
      /^Error: config\/limits\/host\.yaml: tabs are not in the preflight subset \(line 2\)$/u,
    );
    // Adjacent: the default label stays the root path callers already see.
    assert.throws(() => parseLimitsYamlSubset("x:\n  - y: 1\n"), /^Error: config\/limits\.yaml:/u);
  });
});

// Refusals run the production loadLimitDefinitions against a copy of the real
// catalog (root registry plus per-owner fragments) under a temporary root.
describe("limits catalog fragments (#1305)", () => {
  it("owns the GitHub pending-review body budget in its registered fragment and generated catalog", () => {
    const definitions = loadLimitDefinitions({ repoRoot: repositoryRoot });
    const entry = definitions.find(({ name }) => name === "githubReview.bodyMaxBytes");
    assert.deepEqual(entry, {
      name: "githubReview.bodyMaxBytes",
      value: 65000,
      unit: "bytes",
      scope: "per-run",
      warnAt: 0.8,
      override: "DOCSFAB_GITHUB_REVIEW_BODY_MAX_BYTES",
      min: 256,
      max: 131072,
      refusal: "github-review-body-bytes-bound",
      remediation: entry?.remediation,
      rationale: entry?.rationale,
      docValue: "65,000 bytes",
      docSummary:
        "Internal byte budget for one GitHub pending-review body; native inline comments have separate transport bounds.",
    });
    assert.match(entry.remediation, /Inspect the saved review inventory/u);
    assert.match(entry.rationale, /not a GitHub REST maximum/u);
    const catalog = JSON.parse(
      readFileSync(join(repositoryRoot, "config/limits.catalog.json"), "utf8"),
    );
    assert.deepEqual(
      catalog.limits[entry.name],
      Object.fromEntries(Object.entries(entry).filter(([field]) => field !== "name")),
    );
  });

  it("composes the copied catalog into exactly the committed catalog mirror (positive control)", () => {
    const root = copyCatalog();
    try {
      const definitions = loadLimitDefinitions({ repoRoot: root });
      const committed = JSON.parse(
        readFileSync(join(repositoryRoot, "config/limits.catalog.json"), "utf8"),
      ).limits;
      const loaded = Object.fromEntries(definitions.map(({ name, ...fields }) => [name, fields]));
      assert.equal(definitions.length, Object.keys(loaded).length);
      assert.deepEqual(loaded, committed);
      // Multi-segment names load in their first-segment owner's fragment.
      assert.ok(
        readFileSync(join(root, "config/limits/host.yaml"), "utf8").includes(
          "- name: host.slack.liveAgentAnswerMaxChunks\n",
        ),
      );
      assert.ok(definitions.some(({ name }) => name === "host.slack.liveAgentAnswerMaxChunks"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a limit name declared in two fragment files, naming both", () => {
    const root = copyCatalog();
    try {
      const block = entryBlock(root, "host.yaml", "host.slack.liveAgentAnswerMaxChunks");
      appendEntry(root, "hostInvoker.yaml", block);
      assert.throws(
        () => loadLimitDefinitions({ repoRoot: root }),
        (error) => {
          assert.match(
            error.message,
            /^config\/limits\.yaml repeats limit host\.slack\.liveAgentAnswerMaxChunks \(first in config\/limits\/(?:host|hostInvoker)\.yaml, again in config\/limits\/(?:host|hostInvoker)\.yaml\)$/u,
          );
          assert.ok(error.message.includes("config/limits/host.yaml"), error.message);
          assert.ok(error.message.includes("config/limits/hostInvoker.yaml"), error.message);
          return true;
        },
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a limit name repeated inside one fragment", () => {
    const root = copyCatalog();
    try {
      appendEntry(
        root,
        "host.yaml",
        entryBlock(root, "host.yaml", "host.slack.liveAgentAnswerMaxChunks"),
      );
      assert.throws(
        () => loadLimitDefinitions({ repoRoot: root }),
        /^Error: config\/limits\.yaml repeats limit host\.slack\.liveAgentAnswerMaxChunks \(first in config\/limits\/host\.yaml, again in config\/limits\/host\.yaml\)$/u,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a limit whose first name segment is not its fragment's owner", () => {
    const root = copyCatalog();
    try {
      // hostInvoker.* starts with "host"; a prefix match would pass it.
      const name = firstEntryName(root, "hostInvoker.yaml");
      const block = entryBlock(root, "hostInvoker.yaml", name);
      removeEntry(root, "hostInvoker.yaml", block);
      appendEntry(root, "host.yaml", block);
      assert.throws(
        () => loadLimitDefinitions({ repoRoot: root }),
        new RegExp(
          `^Error: config/limits/host\\.yaml holds limit ${name.replaceAll(".", "\\.")}, whose owner prefix hostInvoker is not the fragment owner host$`,
          "u",
        ),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a fragment file the root registry does not list, in any extension case", () => {
    for (const unknown of ["extra.yaml", "Extra.YML"]) {
      const root = copyCatalog();
      try {
        writeFileSync(join(root, "config/limits", unknown), "limits:\n");
        assert.throws(
          () => loadLimitDefinitions({ repoRoot: root }),
          new RegExp(
            `^Error: config/limits/${unknown.replace(".", "\\.")} is not registered in config/limits\\.yaml; add it to the fragments registry or remove it$`,
            "u",
          ),
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("refuses a subdirectory under config/limits/", () => {
    const root = copyCatalog();
    try {
      mkdirSync(join(root, "config/limits/nested"));
      assert.throws(
        () => loadLimitDefinitions({ repoRoot: root }),
        /^Error: config\/limits\/nested is a directory; limit fragments are flat files registered in config\/limits\.yaml$/u,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("ignores non-fragment files an owner checkout carries (.DS_Store, README.md, editor backups)", () => {
    const root = copyCatalog();
    try {
      for (const name of [".DS_Store", "README.md", "host.yaml~", "host.yaml.orig"]) {
        writeFileSync(join(root, "config/limits", name), "not: a fragment\n");
      }
      assert.deepEqual(loadLimitDefinitions({ repoRoot: root }), loadLimitDefinitions());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a fragment whose on-disk name differs from its registration only in case", () => {
    const root = copyCatalog();
    try {
      const dir = join(root, "config/limits");
      // Two-step rename so a case-insensitive filesystem (APFS) records the new case.
      renameSync(join(dir, "host.yaml"), join(dir, "host.tmp"));
      renameSync(join(dir, "host.tmp"), join(dir, "Host.yaml"));
      assert.throws(
        () => loadLimitDefinitions({ repoRoot: root }),
        /^Error: config\/limits\/Host\.yaml differs only in case from the registered fragment host\.yaml; rename it to match config\/limits\.yaml exactly$/u,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a registered fragment that is missing on disk, by name", () => {
    const root = copyCatalog();
    try {
      // Otherwise this surfaces later as a render-time error naming no file.
      rmSync(join(root, "config/limits/ci.yaml"));
      assert.throws(
        () => loadLimitDefinitions({ repoRoot: root }),
        /^Error: registered fragment config\/limits\/ci\.yaml is missing; restore it or remove it from config\/limits\.yaml$/u,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a root that still carries a limits list, and loads a registry-only root", () => {
    const root = copyCatalog();
    try {
      const rootPath = join(root, "config/limits.yaml");
      const registryOnly = readFileSync(rootPath, "utf8");
      const parsed = parseLimitsYamlSubset(registryOnly);
      assert.deepEqual(Object.keys(parsed).sort(), ["fragments", "kind", "schemaVersion"]);
      writeFileSync(
        rootPath,
        `${registryOnly}limits:\n${entryBlock(root, "host.yaml", "host.slack.liveAgentAnswerMaxChunks")}`,
      );
      assert.throws(
        () => loadLimitDefinitions({ repoRoot: root }),
        /^Error: config\/limits\.yaml must not declare a limits list; each limit lives in its owner's fragment under config\/limits\/$/u,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses an empty fragment by name with either parser", () => {
    for (const parseYaml of [parseLimitsYamlSubset, (text) => loadYamlParse()(text)]) {
      const root = copyCatalog();
      try {
        writeFileSync(join(root, "config/limits/semantic.yaml"), "# emptied\nlimits:\n");
        assert.throws(
          () => loadLimitDefinitions({ repoRoot: root, parseYaml }),
          /^Error: config\/limits\/semantic\.yaml must declare a non-empty limits list$/u,
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("refuses a fragment carrying a top-level key other than limits", () => {
    const root = copyCatalog();
    try {
      const path = join(root, "config/limits/semantic.yaml");
      writeFileSync(path, `owner: semantic\n${readFileSync(path, "utf8")}`);
      assert.throws(
        () => loadLimitDefinitions({ repoRoot: root }),
        /^Error: config\/limits\/semantic\.yaml may declare only a limits list; found owner$/u,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a registry entry whose file is not named for its owner, or repeats an owner", () => {
    const root = copyCatalog();
    try {
      const rootPath = join(root, "config/limits.yaml");
      const original = readFileSync(rootPath, "utf8");
      writeFileSync(
        rootPath,
        original.replace(
          "  - file: host.yaml\n    owner: host\n",
          "  - file: host.yaml\n    owner: hosts\n",
        ),
      );
      assert.throws(
        () => loadLimitDefinitions({ repoRoot: root }),
        /^Error: config\/limits\.yaml registers fragment host\.yaml for owner hosts; the file must be named hosts\.yaml$/u,
      );
      writeFileSync(rootPath, `${original}  - file: host.yaml\n    owner: host\n`);
      assert.throws(
        () => loadLimitDefinitions({ repoRoot: root }),
        /^Error: config\/limits\.yaml registers owner host more than once$/u,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("composes in root-registry order, never directory-listing order", DEPLOY_MIRROR_CASE, () => {
    const owners = registeredFragments().map(({ owner }) => owner);
    const prefixOrder = (definitions) => [
      ...new Set(definitions.map(({ name }) => name.split(".")[0])),
    ];
    assert.deepEqual(prefixOrder(loadLimitDefinitions()), owners);
    const root = copyCatalog({ reverseCreation: true });
    try {
      // Fragments written to disk in reverse order still compose to the
      // committed mirror bytes.
      const definitions = loadLimitDefinitions({ repoRoot: root });
      assert.equal(
        renderCatalogJson(definitions),
        readFileSync(join(repositoryRoot, "config/limits.catalog.json"), "utf8"),
      );
      assert.equal(
        renderShell(definitions, DEPLOY_ROOT),
        readFileSync(join(repositoryRoot, DEPLOY_MIRROR), "utf8"),
      );
      // Reversing the registry reverses the composed owner order; the files
      // on disk (and so any directory listing) are untouched.
      const rootPath = join(root, "config/limits.yaml");
      const text = readFileSync(rootPath, "utf8");
      const head = text.slice(0, text.indexOf("fragments:\n") + "fragments:\n".length);
      const reversed = registeredFragments()
        .reverse()
        .map(({ file, owner }) => `  - file: ${file}\n    owner: ${owner}\n`)
        .join("");
      writeFileSync(rootPath, `${head}${reversed}`);
      assert.deepEqual(
        prefixOrder(loadLimitDefinitions({ repoRoot: root })),
        [...owners].reverse(),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses the pre-#1305 whole-document text argument instead of ignoring it", () => {
    assert.throws(
      () => loadLimitDefinitions(readFileSync(yamlPath, "utf8")),
      /^TypeError: loadLimitDefinitions takes an options object/u,
    );
    // Adjacent: no argument and an empty options object both load the repository catalog.
    assert.deepEqual(loadLimitDefinitions({}), loadLimitDefinitions());
  });
});

// Refusals run the production loadAllowlist against a copy of the real shards
// under a temporary root; the gate and writer also run as the shipped CLI.
// A shipped-CLI case runs up to four full scans, which can outrun
// test.localTimeoutMs on a loaded host, so these cases use test.ciTimeoutMs.
const SHIPPED_CLI_CASE = Object.freeze({
  timeout: loadLimitDefinitions().find((entry) => entry.name === "test.ciTimeoutMs").value,
});

describe("limits allowlist shards (#1306)", () => {
  const scanRootList = `packages/runtime/src, packages/host/src, ${DEPLOY_ROOT}`;

  it(
    "composes the copied shards into exactly the fresh scan, with segment-boundary owners (positive control)",
    SHARD_SET_CASE,
    () => {
      const root = copyAllowlist();
      try {
        const allowlist = loadAllowlist({ repoRoot: root });
        assert.equal(allowlist.unknownRationaleBudget, 0);
        assert.deepEqual(
          allowlist.shards.map(({ file, owner }) => ({ file, owner })),
          composedShards(),
        );
        // Zero extra, zero missing against an independent source: the scan.
        assert.deepEqual(compareAllowlist(scanBoundLiterals("all"), allowlist), {
          extra: [],
          missing: [],
        });
        const byFile = Object.fromEntries(allowlist.shards.map((shard) => [shard.file, shard]));
        const paths = (file) => byFile[file].literals.map(({ path }) => path);
        // model-composition/ shares the text "model" with a named owner but not
        // a path segment, and harness/ shares "harness" with
        // harness-qualification: both stay in the runtime remainder.
        for (const prefix of [
          "packages/runtime/src/model-composition/",
          "packages/runtime/src/harness/",
        ]) {
          assert.ok(
            paths("runtime.json").some((path) => path.startsWith(prefix)),
            prefix,
          );
          for (const shard of allowlist.shards.filter(({ file }) => file !== "runtime.json")) {
            assert.ok(!paths(shard.file).some((path) => path.startsWith(prefix)), shard.file);
          }
        }
        assert.ok(paths("runtime.model.json").length > 0);
        assert.ok(
          paths("runtime.model.json").every((path) =>
            path.startsWith("packages/runtime/src/model/"),
          ),
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it(
    "refuses an entry in the wrong shard, naming the entry, its shard, and its owning shard",
    SHARD_SET_CASE,
    () => {
      const cases = [
        // The Task's case: a deploy literal filed under the host remainder.
        {
          from: DEPLOY_SHARD_FILE,
          to: "host.json",
          pick: () => true,
          owner: DEPLOY_SHARD_FILE,
        },
        // A named area's literal filed in its own remainder: the longest owner wins.
        {
          from: "runtime.model.json",
          to: "runtime.json",
          pick: () => true,
          owner: "runtime.model.json",
        },
        // A remainder literal filed under a text-prefix sibling, not a path parent.
        {
          from: "runtime.json",
          to: "runtime.model.json",
          pick: ({ path }) => path.startsWith("packages/runtime/src/model-composition/"),
          owner: "runtime.json",
        },
      ];
      for (const { from, to, pick, owner } of cases) {
        const root = copyAllowlist();
        try {
          const moved = moveLiteral(root, from, to, pick);
          assert.throws(
            () => loadAllowlist({ repoRoot: root }),
            new RegExp(
              `^Error: ${escapeRe(`config/limits-allowlist/${to} holds literal ${moved.path}, owned by shard config/limits-allowlist/${owner}; move it there`)}$`,
              "u",
            ),
          );
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      }
    },
  );

  it(
    "refuses a literal no registered shard owns with its own message (adjacent to wrong-shard)",
    SHARD_SET_CASE,
    () => {
      const root = copyAllowlist();
      try {
        const shard = readShard(root, "runtime.json");
        shard.literals.push({
          path: "packages/quality/probe.py",
          kind: "ts",
          lexeme: "x",
          count: 1,
        });
        writeShard(root, "runtime.json", shard);
        assert.throws(
          () => loadAllowlist({ repoRoot: root }),
          /^Error: config\/limits-allowlist\/runtime\.json holds literal packages\/quality\/probe\.py, which no registered shard owns; the checker never scans it, so remove it$/u,
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it(
    "routes by longest owner whatever the registry order (remainders listed first)",
    SHARD_SET_CASE,
    () => {
      const root = copyAllowlist();
      try {
        const document = readRoot(root);
        // The deploy remainder is configured, not registered, so it follows the registry.
        const remainders = ["packages/runtime/src", "packages/host/src"];
        document.shards = [
          ...remainders.map((owner) => document.shards.find((row) => row.owner === owner)),
          ...document.shards.filter(({ owner }) => !remainders.includes(owner)).reverse(),
        ];
        assert.equal(document.shards[0].owner, "packages/runtime/src");
        writeRoot(root, document);
        const shuffled = loadAllowlist({ repoRoot: root });
        assert.deepEqual(compareAllowlist(scanBoundLiterals("all"), shuffled), {
          extra: [],
          missing: [],
        });
        assert.equal(shuffled.shards[0].file, "runtime.json");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it(
    "refuses a root that still carries a literals list, with or without a registry, naming the writer",
    SHARD_SET_CASE,
    () => {
      const root = copyAllowlist();
      try {
        const document = readRoot(root);
        const literals = readShard(root, "host.json").literals.slice(0, 1);
        // The merged shape and the legacy single-file shape a rebase brings back.
        for (const legacy of [
          { ...document, literals },
          { unknownRationaleBudget: 0, literals },
        ]) {
          writeRoot(root, legacy);
          assert.throws(() => loadAllowlist({ repoRoot: root }), LEGACY_ROOT_REFUSAL);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("refuses unknown root keys and a malformed budget", SHARD_SET_CASE, () => {
    const root = copyAllowlist();
    try {
      const document = readRoot(root);
      writeRoot(root, { ...document, owners: [] });
      assert.throws(
        () => loadAllowlist({ repoRoot: root }),
        /^Error: config\/limits-allowlist\.json may declare only unknownRationaleBudget and shards; found owners$/u,
      );
      for (const budget of ["0", -1, 0.5]) {
        writeRoot(root, { ...document, unknownRationaleBudget: budget });
        assert.throws(
          () => loadAllowlist({ repoRoot: root }),
          /^Error: config\/limits-allowlist\.json unknownRationaleBudget must be a non-negative integer$/u,
          String(budget),
        );
      }
      // Adjacent: the boundary value loads.
      writeRoot(root, { ...document, unknownRationaleBudget: 0 });
      assert.equal(loadAllowlist({ repoRoot: root }).unknownRationaleBudget, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it(
    "refuses a shard carrying a key other than literals, and unparseable shard JSON by path",
    SHARD_SET_CASE,
    () => {
      const root = copyAllowlist();
      try {
        writeShard(root, "runtime.search.json", {
          unknownRationaleBudget: 0,
          ...readShard(root, "runtime.search.json"),
        });
        assert.throws(
          () => loadAllowlist({ repoRoot: root }),
          /^Error: config\/limits-allowlist\/runtime\.search\.json may declare only a literals list; found unknownRationaleBudget$/u,
        );
        writeFileSync(join(root, "config/limits-allowlist/runtime.search.json"), "{ literals: [");
        assert.throws(
          () => loadAllowlist({ repoRoot: root }),
          /^Error: config\/limits-allowlist\/runtime\.search\.json is not valid JSON: /u,
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it(
    "refuses a shard file the registry does not list, in any extension case",
    SHARD_SET_CASE,
    () => {
      for (const unknown of ["extra.json", "Foo.JSON"]) {
        const root = copyAllowlist();
        try {
          writeFileSync(join(root, "config/limits-allowlist", unknown), '{ "literals": [] }\n');
          assert.throws(
            () => loadAllowlist({ repoRoot: root }),
            new RegExp(
              `^Error: ${escapeRe(`config/limits-allowlist/${unknown} is not registered in config/limits-allowlist.json; add it to the shards registry or remove it`)}$`,
              "u",
            ),
          );
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      }
    },
  );

  it(
    "refuses a shard whose on-disk name differs from its registration only in case",
    SHARD_SET_CASE,
    () => {
      const root = copyAllowlist();
      try {
        const dir = join(root, "config/limits-allowlist");
        // Two-step rename so a case-insensitive filesystem (APFS) records the new case.
        renameSync(join(dir, "runtime.json"), join(dir, "runtime.tmp"));
        renameSync(join(dir, "runtime.tmp"), join(dir, "Runtime.json"));
        assert.throws(
          () => loadAllowlist({ repoRoot: root }),
          /^Error: config\/limits-allowlist\/Runtime\.json differs only in case from the registered shard runtime\.json; rename it to match config\/limits-allowlist\.json exactly$/u,
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("refuses a registered shard that is missing, and a subdirectory", SHARD_SET_CASE, () => {
    const root = copyAllowlist();
    try {
      rmSync(join(root, "config/limits-allowlist/runtime.cli.json"));
      assert.throws(
        () => loadAllowlist({ repoRoot: root }),
        /^Error: registered shard config\/limits-allowlist\/runtime\.cli\.json is missing; restore it or remove it from config\/limits-allowlist\.json$/u,
      );
      mkdirSync(join(root, "config/limits-allowlist/nested"));
      assert.throws(
        () => loadAllowlist({ repoRoot: root }),
        /^Error: config\/limits-allowlist\/nested is a directory; allowlist shards are flat files registered in config\/limits-allowlist\.json$/u,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it(
    "loads a missing shard as empty only when its scanned root is absent",
    DEPLOY_ROOT_CASE,
    () => {
      const root = copyAllowlist();
      try {
        rmSync(join(root, DEPLOY_SHARD));
        rmSync(join(root, "config/limits-allowlist/host.service.json"));
        assert.throws(
          () => loadAllowlist({ repoRoot: root }),
          /^Error: registered shard config\/limits-allowlist\/host\.service\.json is missing; restore it or remove it from config\/limits-allowlist\.json$/u,
        );
        // The configured deploy shard names the configuration that registers it.
        assert.throws(
          () => loadAllowlist({ repoRoot: root, absentRoots: ["packages/host/src"] }),
          new RegExp(
            `^Error: ${escapeRe(`shard ${DEPLOY_SHARD}, which config/limits-deploy.json registers, is missing; restore it`)}$`,
            "u",
          ),
        );
        const loaded = loadAllowlist({
          repoRoot: root,
          absentRoots: [DEPLOY_ROOT, "packages/host/src"],
        });
        const byFile = new Map(loaded.shards.map((shard) => [shard.file, shard.literals]));
        assert.deepEqual(byFile.get(DEPLOY_SHARD_FILE), []);
        assert.deepEqual(byFile.get("host.service.json"), []);
        assert.deepEqual(byFile.get("host.json"), readShard(root, "host.json").literals);
        rmSync(join(root, "config/limits-allowlist/runtime.cli.json"));
        assert.throws(
          () =>
            loadAllowlist({
              repoRoot: root,
              absentRoots: [DEPLOY_ROOT, "packages/host/src"],
            }),
          /^Error: registered shard config\/limits-allowlist\/runtime\.cli\.json is missing; restore it or remove it from config\/limits-allowlist\.json$/u,
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it(
    "ignores non-shard files an owner checkout carries (.DS_Store, README.md, editor backups)",
    SHARD_SET_CASE,
    () => {
      const root = copyAllowlist();
      try {
        const baseline = loadAllowlist({ repoRoot: root });
        for (const name of [".DS_Store", "README.md", "runtime.json~", ".runtime.json.swp"]) {
          writeFileSync(join(root, "config/limits-allowlist", name), "not a shard\n");
        }
        // Emacs's lock file: a dangling symlink named for the shard it guards.
        symlinkSync(
          join(root, "no-such-target"),
          join(root, "config/limits-allowlist/.#runtime.json"),
        );
        assert.deepEqual(loadAllowlist({ repoRoot: root }), baseline);
        // Adjacent: a dangling link under a shard-shaped name is still refused by name.
        symlinkSync(join(root, "no-such-target"), join(root, "config/limits-allowlist/stray.json"));
        assert.throws(
          () => loadAllowlist({ repoRoot: root }),
          /^Error: config\/limits-allowlist\/stray\.json is not registered in config\/limits-allowlist\.json; add it to the shards registry or remove it$/u,
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it(
    "treats an absent root as an empty allowlist, but refuses a root without its shard directory",
    SHARD_SET_CASE,
    () => {
      const root = copyAllowlist();
      try {
        rmSync(join(root, "config/limits-allowlist"), { recursive: true });
        assert.throws(
          () => loadAllowlist({ repoRoot: root }),
          /^Error: config\/limits-allowlist\/ is missing; config\/limits-allowlist\.json registers its shards there$/u,
        );
        rmSync(join(root, "config/limits-allowlist.json"));
        assert.deepEqual(loadAllowlist({ repoRoot: root }), {
          unknownRationaleBudget: 0,
          shards: [],
          literals: [],
        });
        // The writer has no registry to partition into and says so.
        assert.throws(
          () =>
            renderAllowlistFiles({
              findings: [],
              previous: loadAllowlist({ repoRoot: root }),
              unknownRationaleBudget: 0,
            }),
          /^Error: config\/limits-allowlist\.json is missing; restore its shards registry before running --write-allowlist$/u,
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it(
    "refuses registry rows that break single ownership or the file-name rule",
    SHARD_SET_CASE,
    () => {
      const root = copyAllowlist();
      try {
        const document = readRoot(root);
        const cases = [
          {
            shards: [...document.shards, { file: "host.json", owner: "packages/host/src" }],
            message:
              "config/limits-allowlist.json registers owner packages/host/src more than once",
          },
          {
            shards: document.shards.map((row) =>
              row.owner === "packages/runtime/src/model" ? { ...row, file: "model.json" } : row,
            ),
            message:
              "config/limits-allowlist.json registers shard model.json for owner packages/runtime/src/model; the file must be named runtime.model.json",
          },
          {
            shards: [...document.shards, { file: "quality.json", owner: "packages/quality/src" }],
            message: `config/limits-allowlist.json registers owner packages/quality/src outside every scanned root (${scanRootList})`,
          },
          // Shares the text of a scan root but not a path segment.
          {
            shards: [
              ...document.shards,
              { file: "runtime.srcx.json", owner: "packages/runtime/srcx" },
            ],
            message: `config/limits-allowlist.json registers owner packages/runtime/srcx outside every scanned root (${scanRootList})`,
          },
          {
            shards: document.shards.filter(({ owner }) => owner !== "packages/host/src"),
            message:
              "config/limits-allowlist.json has no shard owning scanned root packages/host/src; register { file: host.json, owner: packages/host/src } as its remainder shard",
          },
          // The deploy root's row belongs to its configuration alone.
          {
            shards: [...document.shards, { file: DEPLOY_SHARD_FILE, owner: DEPLOY_ROOT }],
            message: `config/limits-allowlist.json registers owner ${DEPLOY_ROOT}, which config/limits-deploy.json already declares; remove the row from config/limits-allowlist.json`,
          },
          {
            shards: [
              ...document.shards,
              { file: "runtime.Model.json", owner: "packages/runtime/src/Model" },
            ],
            message:
              "config/limits-allowlist.json registers shards runtime.model.json and runtime.Model.json, whose names differ only in case",
          },
          {
            shards: [
              ...document.shards,
              { file: "runtime.a.b.json", owner: "packages/runtime/src/a.b" },
            ],
            message:
              "config/limits-allowlist.json shard owner packages/runtime/src/a.b must be a repository path of plain segments (no '.', no empty segment)",
          },
        ];
        for (const { shards, message } of cases) {
          writeRoot(root, { ...document, shards });
          assert.throws(
            () => loadAllowlist({ repoRoot: root }),
            new RegExp(`^Error: ${escapeRe(message)}$`, "u"),
          );
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("refuses malformed root and shard shapes by name", SHARD_SET_CASE, () => {
    const root = copyAllowlist();
    try {
      const document = readRoot(root);
      const rootCases = [
        [
          [],
          "config/limits-allowlist.json must be an object declaring unknownRationaleBudget and shards",
        ],
        [
          { unknownRationaleBudget: 0, shards: [] },
          "config/limits-allowlist.json must declare a non-empty shards registry",
        ],
        [
          { ...document, shards: [...document.shards, { file: "x.json" }] },
          "each config/limits-allowlist.json shards entry must be exactly { file, owner } strings",
        ],
      ];
      for (const [value, message] of rootCases) {
        writeRoot(root, value);
        assert.throws(
          () => loadAllowlist({ repoRoot: root }),
          new RegExp(`^Error: ${escapeRe(message)}$`, "u"),
        );
      }
      writeRoot(root, document);
      const original = readShard(root, "runtime.search.json");
      const shardCases = [
        [[], "config/limits-allowlist/runtime.search.json must declare a literals list"],
        [
          { literals: {} },
          "config/limits-allowlist/runtime.search.json must declare a literals list",
        ],
        [
          { literals: [{ kind: "ts", lexeme: "x", count: 1 }] },
          "config/limits-allowlist/runtime.search.json holds a literal without a string path",
        ],
        [
          { literals: [null] },
          "config/limits-allowlist/runtime.search.json holds a literal without a string path",
        ],
      ];
      for (const [value, message] of shardCases) {
        writeShard(root, "runtime.search.json", value);
        assert.throws(
          () => loadAllowlist({ repoRoot: root }),
          new RegExp(`^Error: ${escapeRe(message)}$`, "u"),
        );
      }
      // Adjacent: the restored shard loads again.
      writeShard(root, "runtime.search.json", original);
      assert.ok(loadAllowlist({ repoRoot: root }).literals.length > 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("names every shard file by one rule", () => {
    assert.equal(shardFileForOwner("packages/runtime/src"), "runtime.json");
    assert.equal(shardFileForOwner("packages/runtime/src/model"), "runtime.model.json");
    assert.equal(shardFileForOwner("packages/host/src/service"), "host.service.json");
    assert.equal(shardFileForOwner("deploy/example-host"), "deploy.example-host.json");
    for (const { file, owner } of composedShards()) assert.equal(file, shardFileForOwner(owner));
  });

  it(
    "re-renders every committed shard and the root byte-for-byte, rationales included (writer round-trip)",
    SHARD_SET_CASE,
    () => {
      const root = copyAllowlist();
      try {
        const committed = readRoot(root);
        const { files, count, shards } = renderAllowlistFiles({
          findings: scanBoundLiterals("all"),
          previous: loadAllowlist({ repoRoot: root }),
          unknownRationaleBudget: committed.unknownRationaleBudget,
        });
        const expected = [
          "config/limits-allowlist.json",
          ...readdirSync(allowlistShardDir)
            .sort()
            .map((name) => `config/limits-allowlist/${name}`),
        ];
        assert.deepEqual(Object.keys(files).sort(), expected.sort());
        for (const [path, contents] of Object.entries(files)) {
          assert.equal(contents, readFileSync(join(repositoryRoot, path), "utf8"), path);
        }
        assert.ok(!Object.hasOwn(JSON.parse(files["config/limits-allowlist.json"]), "literals"));
        // The root keeps only registry rows; the configured deploy shard is
        // written beside them.
        assert.equal(shards, composedShards().length);
        assert.equal(
          JSON.parse(files["config/limits-allowlist.json"]).shards.length,
          committed.shards.length,
        );
        assert.equal(count, scanBoundLiterals("all").length);
        const rationales = Object.entries(files)
          .filter(([path]) => path !== "config/limits-allowlist.json")
          .flatMap(([, text]) => JSON.parse(text).literals)
          .filter((literal) => Object.hasOwn(literal, "rationale"));
        assert.ok(rationales.length > 0, "the committed shards carry rationales");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("drains an area to an empty shard that still loads", SHARD_SET_CASE, () => {
    const root = copyAllowlist();
    try {
      const findings = scanBoundLiterals("all").filter(
        ({ path }) => !path.startsWith("packages/runtime/src/search/"),
      );
      const { files } = renderAllowlistFiles({
        findings,
        previous: loadAllowlist({ repoRoot: root }),
        unknownRationaleBudget: 0,
      });
      assert.equal(
        files["config/limits-allowlist/runtime.search.json"],
        '{\n  "literals": []\n}\n',
      );
      for (const [path, contents] of Object.entries(files))
        writeFileSync(join(root, path), contents);
      const drained = loadAllowlist({ repoRoot: root });
      assert.deepEqual(
        drained.shards.find(({ file }) => file === "runtime.search.json").literals,
        [],
      );
      assert.equal(drained.literals.length, findings.length);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("partitions only into registered owners", () => {
    const shards = [
      { file: "runtime.json", owner: "packages/runtime/src" },
      { file: "runtime.model.json", owner: "packages/runtime/src/model" },
    ];
    const finding = (path) => ({ path, kind: "ts", lexeme: "x", count: 1 });
    assert.deepEqual(
      partitionAllowlist(
        [
          finding("packages/runtime/src/model/b.ts"),
          finding("packages/runtime/src/model-composition/a.ts"),
        ],
        shards,
      ).map(({ file, literals }) => [file, literals.map(({ path }) => path)]),
      [
        ["runtime.json", ["packages/runtime/src/model-composition/a.ts"]],
        ["runtime.model.json", ["packages/runtime/src/model/b.ts"]],
      ],
    );
    assert.throws(
      () => partitionAllowlist([finding("packages/host/src/a.ts")], shards),
      /^Error: no shard registered in config\/limits-allowlist\.json owns packages\/host\/src\/a\.ts; register one for its scanned root$/u,
    );
  });

  it("writes the shards through the shipped --write-allowlist CLI, keeping every rationale", {
    ...SHIPPED_CLI_CASE,
    ...SHARD_SET_CASE,
  }, () => {
    const root = linkedRepo();
    try {
      // Restoring the committed bytes requires reading rationales from the
      // composed shards; the scan carries none.
      for (const { file } of composedShards()) {
        const shard = readShard(root, file);
        writeFileSync(
          join(root, "config/limits-allowlist", file),
          JSON.stringify({ literals: shard.literals.reverse() }),
        );
      }
      const result = runLinkedCli(root, ["--write-allowlist"]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(
        result.stdout,
        `Wrote config/limits-allowlist.json and ${composedShards().length} shards under config/limits-allowlist/ with ${scanBoundLiterals("all").length} literal findings\n`,
      );
      for (const name of [
        "limits-allowlist.json",
        ...readdirSync(allowlistShardDir).map((file) => `limits-allowlist/${file}`),
      ]) {
        assert.equal(
          readFileSync(join(root, "config", name), "utf8"),
          readFileSync(join(repositoryRoot, "config", name), "utf8"),
          name,
        );
      }
    } finally {
      removeLinkedRepo(root);
    }
  });

  it(
    "names the owning shard on each stale gate line and keeps the un-allowlisted message",
    SHIPPED_CLI_CASE,
    () => {
      const root = linkedRepo();
      try {
        const probe = (path) => ({ path, kind: "kib-product", lexeme: "7 * 1024", count: 1 });
        const model = readShard(root, "runtime.model.json");
        const dropped = model.literals.shift();
        model.literals.push(probe("packages/runtime/src/model/stale-probe.ts"));
        writeShard(root, "runtime.model.json", model);
        const remainder = readShard(root, "runtime.json");
        remainder.literals.push(probe("packages/runtime/src/model-composition/stale-probe.ts"));
        writeShard(root, "runtime.json", remainder);
        const result = runLinkedCli(root, ["--check", "--gate"]);
        assert.equal(result.status, 1, result.stdout);
        assert.equal(
          result.stderr,
          [
            "check:limits failed: un-allowlisted bound literals:",
            `  ${dropped.path} ${dropped.kind} ${dropped.lexeme} x${dropped.count}`,
            "config/limits-allowlist/ has stale entries; shrink the shard named on each line:",
            "  packages/runtime/src/model-composition/stale-probe.ts kib-product 7 * 1024 (config/limits-allowlist/runtime.json)",
            "  packages/runtime/src/model/stale-probe.ts kib-product 7 * 1024 (config/limits-allowlist/runtime.model.json)",
            "",
          ].join("\n"),
        );
      } finally {
        removeLinkedRepo(root);
      }
    },
  );

  it(
    "reads leniently for the writer but refuses by name what it cannot use",
    SHARD_SET_CASE,
    () => {
      const scanRoots = ["packages/runtime/src", "packages/host/src", DEPLOY_ROOT];
      const configuredShards = [
        { file: DEPLOY_SHARD_FILE, owner: DEPLOY_ROOT, source: DEPLOY_ROOT_CONFIG_PATH },
      ];
      const read = (root) =>
        loadAllowlistForRewrite({ repoRoot: root, scanRoots, configuredShards });
      const root = copyAllowlist();
      try {
        const document = readRoot(root);
        // Positive control: the committed tree reads to its own registry, then
        // the configured deploy row.
        assert.deepEqual(read(root).shards, [...registeredShards(), ...configuredShards]);
        // Lenient where the gate is strict: a legacy literals list beside the
        // registry, and a registered shard not yet on disk.
        writeRoot(root, { ...document, literals: [] });
        rmSync(join(root, "config/limits-allowlist/runtime.cli.json"));
        assert.equal(read(root).shards.length, composedShards().length);
        const cases = [
          [
            [],
            "config/limits-allowlist.json must be an object declaring unknownRationaleBudget and shards",
          ],
          [
            { ...document, owners: [] },
            "config/limits-allowlist.json may declare only unknownRationaleBudget and shards; found owners",
          ],
          [
            { unknownRationaleBudget: 0, literals: {} },
            "config/limits-allowlist.json must declare a literals list",
          ],
          [
            { unknownRationaleBudget: 0, literals: [null] },
            "config/limits-allowlist.json holds a literal without a string path",
          ],
        ];
        for (const [value, message] of cases) {
          writeRoot(root, value);
          assert.throws(() => read(root), new RegExp(`^Error: ${escapeRe(message)}$`, "u"));
        }
        // A registry recovered from file names refuses a name no owner maps to.
        writeRoot(root, { unknownRationaleBudget: 0, literals: [] });
        writeFileSync(join(root, "config/limits-allowlist/stray.json"), '{ "literals": [] }\n');
        assert.throws(
          () => read(root),
          /^Error: config\/limits-allowlist\/stray\.json does not name exactly one owner under a scanned root, so config\/limits-allowlist\.json's shards registry cannot be recovered from it; rename or remove it$/u,
        );
        // A registered root still reads the stray file, as a rationale source that must parse.
        writeRoot(root, document);
        writeFileSync(join(root, "config/limits-allowlist/stray.json"), "[]\n");
        assert.throws(
          () => read(root),
          /^Error: config\/limits-allowlist\/stray\.json must declare a literals list$/u,
        );
        rmSync(join(root, "config/limits-allowlist.json"));
        assert.throws(
          () => read(root),
          /^Error: config\/limits-allowlist\.json is missing; restore its shards registry before running --write-allowlist$/u,
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  // A rebased branch's single-file allowlist as the root, beside the shard
  // directory (or with it absent), with one rationale only in that root.
  for (const keepShardDir of [true, false]) {
    const name = keepShardDir ? "beside main's shards" : "without a shard directory";
    it(`carries a pre-#1306 root's literals and rationales into the shards by following the gate's refusal, ${name} (shipped CLI)`, {
      ...SHIPPED_CLI_CASE,
      ...SHARD_SET_CASE,
    }, () => {
      const root = linkedRepo();
      try {
        const composed = loadAllowlist({ repoRoot: root }).literals;
        const model = readShard(root, "runtime.model.json");
        const [sibling] = model.literals.splice(0, 1);
        writeShard(root, "runtime.model.json", model);
        const rationale = "Sibling rationale that only the legacy root carries.";
        const same = (literal) =>
          literal.path === sibling.path &&
          literal.kind === sibling.kind &&
          literal.lexeme === sibling.lexeme;
        assert.equal(composed.filter(same).length, 1);
        writeRoot(root, {
          unknownRationaleBudget: 0,
          literals: composed.map((literal) =>
            same(literal) ? { ...literal, rationale } : literal,
          ),
        });
        if (!keepShardDir) rmSync(join(root, "config/limits-allowlist"), { recursive: true });

        // 1. The gate refuses and names one command.
        const refused = runLinkedCli(root, ["--check", "--gate"]);
        assert.equal(refused.status, 1, name);
        const message = refused.stderr.replace(/^check:limits failed: /u, "Error: ").trimEnd();
        assert.match(message, LEGACY_ROOT_REFUSAL, name);
        // 2. Run exactly that command.
        let written = followRefusal(root, message);
        if (!keepShardDir) {
          // Adjacent: no registry to recover; the writer names the restore step.
          assert.equal(written.status, 1, name);
          assert.equal(
            written.stderr,
            "check:limits failed: config/limits-allowlist.json declares no shards registry and config/limits-allowlist/ holds no shard to recover it from; restore that directory from main (from the repository root: `git checkout origin/main -- config/limits-allowlist`), then rerun --write-allowlist\n",
          );
          // The linked root is no git checkout: restore main's directory as
          // that git command would, then rerun the same command.
          cpSync(allowlistShardDir, join(root, "config/limits-allowlist"), {
            recursive: true,
          });
          written = followRefusal(root, message);
        }
        assert.equal(written.status, 0, `${name}: ${written.stderr}`);
        // 3. The gate is green and the root-only rationale reached its owning shard.
        const gate = runLinkedCli(root, ["--check", "--gate"]);
        assert.equal(gate.status, 0, `${name}: ${gate.stderr}`);
        assert.equal(
          readShard(root, "runtime.model.json").literals.find(same)?.rationale,
          rationale,
          name,
        );
        // Every other file, the recovered root registry included, is the committed bytes.
        for (const path of committedAllowlistFiles()) {
          if (path.endsWith("/runtime.model.json")) continue;
          assert.equal(
            readFileSync(join(root, path), "utf8"),
            readFileSync(join(repositoryRoot, path), "utf8"),
            `${name}: ${path}`,
          );
        }
      } finally {
        removeLinkedRepo(root);
      }
    });
  }

  it("refuses a legacy root and a shard that give one finding different rationales (shipped CLI)", {
    ...SHIPPED_CLI_CASE,
    ...SHARD_SET_CASE,
  }, () => {
    const root = linkedRepo();
    try {
      const composed = loadAllowlist({ repoRoot: root });
      const held = composed.literals.find((literal) => typeof literal.rationale === "string");
      const heldIn = shardPathForLiteralFile(composed, held);
      const literals = composed.literals.map((literal) =>
        literal === held ? { ...literal, rationale: "A different rationale." } : literal,
      );
      writeRoot(root, { unknownRationaleBudget: 0, literals });
      const before = readFileSync(join(root, heldIn), "utf8");
      const result = runLinkedCli(root, ["--write-allowlist"]);
      assert.equal(result.status, 1, result.stdout);
      assert.equal(
        result.stderr,
        `check:limits failed: ${held.path} ${held.kind} ${held.lexeme} x${held.count} carries different rationales in config/limits-allowlist.json and ${heldIn}; make them agree, then rerun --write-allowlist\n`,
      );
      assert.equal(readFileSync(join(root, heldIn), "utf8"), before, "nothing written");
      // Adjacent: the same rationale in both is one rationale, not a conflict.
      writeRoot(root, {
        unknownRationaleBudget: 0,
        literals: composed.literals,
      });
      const agreed = runLinkedCli(root, ["--write-allowlist"]);
      assert.equal(agreed.status, 0, agreed.stderr);
      assert.equal(runLinkedCli(root, ["--check", "--gate"]).status, 0);
    } finally {
      removeLinkedRepo(root);
    }
  });

  it("re-partitions after the registry gains or loses an owner, keeping every rationale (shipped CLI)", {
    ...SHIPPED_CLI_CASE,
    ...SHARD_SET_CASE,
  }, () => {
    const root = linkedRepo();
    try {
      const rationales = () =>
        loadAllowlist({ repoRoot: root })
          .literals.filter((literal) => typeof literal.rationale === "string")
          .map(({ path, kind, lexeme, rationale }) => `${path}\t${kind}\t${lexeme}\t${rationale}`)
          .sort();
      const before = rationales();
      const document = readRoot(root);
      // Gain: harness/ leaves the runtime remainder for a shard not yet on disk.
      // Lose: search/ folds back into the runtime remainder; its old file stays.
      document.shards = [
        ...document.shards.filter(({ owner }) => owner !== "packages/runtime/src/search"),
        { file: "runtime.harness.json", owner: "packages/runtime/src/harness" },
      ];
      writeRoot(root, document);
      const written = runLinkedCli(root, ["--write-allowlist"]);
      assert.equal(written.status, 0, written.stderr);
      const harness = readShard(root, "runtime.harness.json").literals;
      assert.ok(harness.length > 0);
      assert.ok(harness.every(({ path }) => path.startsWith("packages/runtime/src/harness/")));
      assert.ok(
        readShard(root, "runtime.json").literals.some(({ path }) =>
          path.startsWith("packages/runtime/src/search/"),
        ),
      );
      // The writer never deletes: the gate names the file the registry dropped.
      const stale = runLinkedCli(root, ["--check", "--gate"]);
      assert.equal(
        stale.stderr,
        "check:limits failed: config/limits-allowlist/runtime.search.json is not registered in config/limits-allowlist.json; add it to the shards registry or remove it\n",
      );
      rmSync(join(root, "config/limits-allowlist/runtime.search.json"));
      assert.equal(runLinkedCli(root, ["--check", "--gate"]).status, 0);
      assert.deepEqual(rationales(), before);
    } finally {
      removeLinkedRepo(root);
    }
  });

  it("refuses a wrong-shard entry through the shipped gate", {
    ...SHIPPED_CLI_CASE,
    ...SHARD_SET_CASE,
  }, () => {
    const root = linkedRepo();
    try {
      const moved = moveLiteral(root, DEPLOY_SHARD_FILE, "host.json", () => true);
      for (const args of [
        ["--check", "--gate"],
        ["--check", "--gate", "--scope", "deploy"],
      ]) {
        const result = runLinkedCli(root, args);
        assert.equal(result.status, 1, result.stdout);
        assert.equal(
          result.stderr,
          `check:limits failed: config/limits-allowlist/host.json holds literal ${moved.path}, owned by shard ${DEPLOY_SHARD}; move it there\n`,
        );
      }
    } finally {
      removeLinkedRepo(root);
    }
  });
});

// Loader side of the optional docs-facing fields; rendering is covered in
// docs-limits-table.test.mjs.
describe("docs-facing optional fields (#1307)", () => {
  it("omits docValue/docSummary/docValueCode from an entry that declares none of them", () => {
    const root = copyCatalog();
    try {
      const definitions = loadLimitDefinitions({ repoRoot: root });
      const entry = definitions.find(
        (definition) => definition.name === "compositionExecution.callsPerLease",
      );
      assert.ok(entry, "fixture entry should exist");
      assert.ok(!Object.hasOwn(entry, "docValue"));
      assert.ok(!Object.hasOwn(entry, "docSummary"));
      assert.ok(!Object.hasOwn(entry, "docValueCode"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("adjacent: an entry declaring docValue/docSummary carries exactly those two extra fields", () => {
    const root = copyCatalog();
    try {
      const definitions = loadLimitDefinitions({ repoRoot: root });
      const entry = definitions.find(
        (definition) => definition.name === "compositionExecution.maxCumulativeInputTokens",
      );
      assert.equal(entry.docValue, "16,777,216 tokens");
      assert.equal(entry.docSummary, "Cumulative input for one step attempt.");
      assert.ok(!Object.hasOwn(entry, "docValueCode"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses an empty-string docValue rather than silently accepting a blank cell", () => {
    // A bare `docValue:` is null (absent); an empty string needs a quoted
    // scalar, which only the real `yaml` package parses.
    const root = copyCatalog();
    try {
      const path = join(root, "config/limits/compositionExecution.yaml");
      const text = readFileSync(path, "utf8");
      writeFileSync(path, text.replace("docValue: 16,777,216 tokens", 'docValue: ""'));
      assert.throws(
        () => loadLimitDefinitions({ repoRoot: root, parseYaml: (text) => loadYamlParse()(text) }),
        /compositionExecution\.maxCumulativeInputTokens: docValue must be a non-empty string when present/u,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("adjacent: a bare docValue key with no value parses as absent, not a refusal", () => {
    const root = copyCatalog();
    try {
      const path = join(root, "config/limits/compositionExecution.yaml");
      const text = readFileSync(path, "utf8");
      writeFileSync(path, text.replace("docValue: 16,777,216 tokens", "docValue:"));
      const definitions = loadLimitDefinitions({
        repoRoot: root,
        parseYaml: (text) => loadYamlParse()(text),
      });
      const entry = definitions.find(
        (definition) => definition.name === "compositionExecution.maxCumulativeInputTokens",
      );
      assert.ok(!Object.hasOwn(entry, "docValue"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("normalizes docValueCode: code to the boolean true (positive control)", () => {
    const root = copyCatalog();
    try {
      const definitions = loadLimitDefinitions({ repoRoot: root });
      const entry = definitions.find(
        (definition) => definition.name === "host.slack.liveAgentAnswerMaxChunks",
      );
      assert.equal(entry.docValueCode, true);
      assert.ok(!Object.hasOwn(entry, "docValue"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses docValue and docValueCode declared on the same entry", () => {
    const root = copyCatalog();
    try {
      const path = join(root, "config/limits/host.yaml");
      const text = readFileSync(path, "utf8");
      const mutated = text.replace(
        "docValueCode: code",
        "docValueCode: code\n    docValue: also set",
      );
      assert.notEqual(mutated, text, "fixture entry should have docValueCode: code");
      writeFileSync(path, mutated);
      assert.throws(
        () => loadLimitDefinitions({ repoRoot: root }),
        /host\.slack\.liveAgentAnswerMaxChunks: docValueCode and docValue are mutually exclusive/u,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("adjacent: an unrecognized docValueCode value is refused by name, not silently ignored", () => {
    const root = copyCatalog();
    try {
      const path = join(root, "config/limits/host.yaml");
      const text = readFileSync(path, "utf8");
      writeFileSync(path, text.replace("docValueCode: code", "docValueCode: yes"));
      assert.throws(
        () => loadLimitDefinitions({ repoRoot: root }),
        /host\.slack\.liveAgentAnswerMaxChunks: docValueCode must be exactly "code" when present/u,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Changing `value` without the hand-kept `docValue` must be refused by
  // `loadLimitDefinitions`, before any doc-drift check runs.
  it("refuses a docValue whose leading number no longer matches value (mutant C1 replay: providerAttempt.baseDelayMs 500 -> 750)", () => {
    const root = copyCatalog();
    try {
      const path = join(root, "config/limits/providerAttempt.yaml");
      const text = readFileSync(path, "utf8");
      const mutated = text.replace("value: 500\n", "value: 750\n");
      assert.notEqual(mutated, text, "fixture entry should declare value: 500");
      writeFileSync(path, mutated);
      assert.throws(
        () => loadLimitDefinitions({ repoRoot: root }),
        /providerAttempt\.baseDelayMs: docValue "500 ms" starts with 500, but value is 750; update docValue's leading number to match value/u,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("adjacent: updating both value and docValue's leading number together still passes", () => {
    const root = copyCatalog();
    try {
      const path = join(root, "config/limits/providerAttempt.yaml");
      const text = readFileSync(path, "utf8");
      const mutated = text
        .replace("value: 500\n", "value: 750\n")
        .replace("docValue: 500 ms\n", "docValue: 750 ms\n");
      assert.notEqual(
        mutated,
        text,
        "fixture entry should declare value: 500 and docValue: 500 ms",
      );
      const definitions = loadLimitDefinitions({ repoRoot: root });
      const entry = definitions.find(
        (definition) => definition.name === "providerAttempt.baseDelayMs",
      );
      assert.equal(entry.value, 500, "sanity: unmutated copy still reads 500");
      writeFileSync(path, mutated);
      const mutatedDefinitions = loadLimitDefinitions({ repoRoot: root });
      const mutatedEntry = mutatedDefinitions.find(
        (definition) => definition.name === "providerAttempt.baseDelayMs",
      );
      assert.equal(mutatedEntry.value, 750);
      assert.equal(mutatedEntry.docValue, "750 ms");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("adjacent: a docValue whose leading number carries thousands separators still matches a plain-digit value", () => {
    // The gate strips separators before comparing.
    const definitions = loadLimitDefinitions();
    const entry = definitions.find(
      (definition) => definition.name === "compositionExecution.maxCumulativeInputTokens",
    );
    assert.equal(entry.value, 16777216);
    assert.equal(entry.docValue, "16,777,216 tokens");
  });

  it("refuses a docValue that does not start with a number at all", () => {
    const root = copyCatalog();
    try {
      const path = join(root, "config/limits/compositionExecution.yaml");
      const text = readFileSync(path, "utf8");
      const mutated = text.replace("docValue: 16,777,216 tokens", "docValue: many tokens");
      assert.notEqual(mutated, text);
      writeFileSync(path, mutated);
      assert.throws(
        () => loadLimitDefinitions({ repoRoot: root }),
        /compositionExecution\.maxCumulativeInputTokens: docValue "many tokens" must start with the numeric default/u,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// Remediation text names the fragment that owns the limit it tells the
// operator to change, and loader refusals name the fragment.
const { remediationCitations } = await import("./check-limits.mjs");
const { declaredLimits } = await import("./check-model-output.mjs");

describe("remediation citations name the owning fragment (#1305 MR-B)", () => {
  const registeredFiles = () => registeredFragments().map(({ file }) => file);

  it("resolves every committed citation to its limit's owner (positive control)", () => {
    const definitions = loadLimitDefinitions();
    const citations = remediationCitations(definitions, registeredFiles());
    // No remediation cites the fragment registry itself.
    assert.equal(
      definitions.filter(({ remediation }) => remediation.includes("config/limits.yaml")).length,
      0,
    );
    // Every citation resolves to the fragment that owns the limit it names.
    for (const citation of citations) {
      assert.equal(citation.cited, `config/limits/${citation.limit.split(".")[0]}.yaml`);
    }
    // Reachability positive control: each resolution rule (before/after/self)
    // fires for at least one committed citation.
    const byRule = Object.groupBy(citations, ({ rule }) => rule);
    for (const rule of ["before", "after", "self"]) {
      assert.ok((byRule[rule] ?? []).length > 0, `expected at least one "${rule}" citation`);
    }
    // Pinned examples of each rule, not catalog-wide totals.
    assert.ok(
      citations.some(
        (citation) => citation.entry === "runs.recordMaxBytes" && citation.rule === "after",
      ),
      "expected runs.recordMaxBytes to resolve via an after citation",
    );
    for (const entry of ["compositionExecution.callsPerLease", "compositionExecution.maxLeases"]) {
      assert.ok(
        citations.some((citation) => citation.entry === entry && citation.rule === "self"),
        `expected ${entry} to resolve via a self citation`,
      );
    }
    // The two cross-fragment cases cite the owner of the limit they name.
    const cited = (entry) =>
      citations
        .filter((citation) => citation.entry === entry)
        .map(({ cited, limit }) => [cited, limit]);
    assert.deepEqual(cited("localWorkflows.canaryRepeats"), [
      ["config/limits/localWorkflows.yaml", "localWorkflows.canaryRepeats"],
      ["config/limits/ci.yaml", "ci.liveModel.jobTimeoutMs"],
    ]);
    assert.deepEqual(cited("localWorkflows.canaryJobReserveMs"), [
      ["config/limits/ci.yaml", "ci.liveModel.jobTimeoutMs"],
    ]);
  });

  it("refuses a remaining root config/limits.yaml citation by fragment and limit name", () => {
    const root = copyCatalog();
    try {
      rewriteRemediation(root, "runs.yaml", "runs.indexMaxBytes", (text) =>
        text.replace("config/limits/runs.yaml", "config/limits.yaml"),
      );
      assert.throws(
        () => loadLimitDefinitions({ repoRoot: root }),
        /^Error: config\/limits\/runs\.yaml: remediation of runs\.indexMaxBytes cites config\/limits\.yaml, the fragment registry; cite config\/limits\/runs\.yaml, the fragment that owns runs\.indexMaxBytes$/u,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a citation of the fragment holding the text when the named limit lives elsewhere", () => {
    const root = copyCatalog();
    try {
      // localWorkflows.canaryJobReserveMs tells the operator to raise a ci.* limit.
      rewriteRemediation(root, "localWorkflows.yaml", "localWorkflows.canaryJobReserveMs", (text) =>
        text.replace("config/limits/ci.yaml", "config/limits/localWorkflows.yaml"),
      );
      assert.throws(
        () => loadLimitDefinitions({ repoRoot: root }),
        /^Error: config\/limits\/localWorkflows\.yaml: remediation of localWorkflows\.canaryJobReserveMs cites config\/limits\/localWorkflows\.yaml for ci\.liveModel\.jobTimeoutMs, whose owning fragment is config\/limits\/ci\.yaml$/u,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a citation of a fragment the registry does not list, in any case", () => {
    for (const cited of ["config/limits/nonesuch.yaml", "config/limits/Runs.yaml"]) {
      const root = copyCatalog();
      try {
        rewriteRemediation(root, "runs.yaml", "runs.indexMaxBytes", (text) =>
          text.replace("config/limits/runs.yaml", cited),
        );
        assert.throws(
          () => loadLimitDefinitions({ repoRoot: root }),
          new RegExp(
            `^Error: config/limits/runs\\.yaml: remediation of runs\\.indexMaxBytes cites ${cited.replaceAll(".", "\\.")}, which config/limits\\.yaml does not register$`,
            "u",
          ),
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("refuses a citation whose sentence names only a limit the catalog does not have", () => {
    const root = copyCatalog();
    try {
      rewriteRemediation(
        root,
        "compositionExecution.yaml",
        "compositionExecution.maxLeases",
        (text) => text.replace("raise this limit in", "raise compositionExecution.maxLeasez in"),
      );
      assert.throws(
        () => loadLimitDefinitions({ repoRoot: root }),
        /^Error: config\/limits\/compositionExecution\.yaml: remediation of compositionExecution\.maxLeases cites config\/limits\/compositionExecution\.yaml for compositionExecution\.maxLeasez, which is not a catalogued limit; name a limit from the catalog$/u,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("adjacent: a dotted file name that no fragment owns does not block the containing-entry rule", () => {
    const root = copyCatalog();
    try {
      rewriteRemediation(
        root,
        "compositionExecution.yaml",
        "compositionExecution.maxLeases",
        (text) =>
          text.replace("raise this limit in", "raise this limit (see stream.log and CANARY.md) in"),
      );
      const citations = remediationCitations(
        loadLimitDefinitions({ repoRoot: root }),
        registeredFiles(),
      );
      assert.deepEqual(
        citations
          .filter(({ entry }) => entry === "compositionExecution.maxLeases")
          .map(({ limit, rule }) => [limit, rule]),
        [["compositionExecution.maxLeases", "self"]],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolves only within the citation's sentence, not from an earlier one", () => {
    const root = copyCatalog();
    try {
      // runs.indexMaxBytes sits in the previous sentence, so the citation
      // falls back to the containing entry and is refused as ci.yaml.
      rewriteRemediation(
        root,
        "runs.yaml",
        "runs.indexFieldMaxChars",
        () => "Compare runs.indexMaxBytes. Then change it in config/limits/ci.yaml.",
      );
      assert.throws(
        () => loadLimitDefinitions({ repoRoot: root }),
        /^Error: config\/limits\/runs\.yaml: remediation of runs\.indexFieldMaxChars cites config\/limits\/ci\.yaml for runs\.indexFieldMaxChars, whose owning fragment is config\/limits\/runs\.yaml$/u,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not read a host file, the catalog JSON, or an embedded path as a fragment citation", () => {
    const definitions = [
      {
        name: "runs.indexMaxBytes",
        remediation:
          "Raise it in .docsfab/limits.yaml, the host limits file, /etc/x/config/limits.yaml, config/limits.catalog.json, or config/limits.yaml.bak.",
      },
    ];
    assert.deepEqual(remediationCitations(definitions, ["runs.yaml"]), []);
  });

  it("names the fragment in an npm-yaml parse error, through check-model-output's own wrapper too", () => {
    const npmParse = loadYamlParse();
    assert.notEqual(npmParse, null, "the npm yaml package must be installed for this test");
    const root = copyCatalog();
    try {
      writeFileSync(join(root, "config/limits/semantic.yaml"), "limits:\n  - name: [unclosed\n");
      const expected = /^Error: config\/limits\/semantic\.yaml: /u;
      assert.throws(() => loadLimitDefinitions({ repoRoot: root }), expected);
      assert.throws(() => declaredLimits(root, npmParse), expected);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("adjacent: a subset-parser error that already names the fragment is not prefixed twice", () => {
    const root = copyCatalog();
    try {
      writeFileSync(join(root, "config/limits/semantic.yaml"), "limits:\n  - name: [unclosed\n");
      assert.throws(
        () =>
          loadLimitDefinitions({
            repoRoot: root,
            parseYaml: parseLimitsYamlSubset,
          }),
        /^Error: config\/limits\/semantic\.yaml: unsupported scalar at line 2$/u,
      );
      assert.throws(
        () => declaredLimits(root, null),
        /^Error: config\/limits\/semantic\.yaml: unsupported scalar at line 2$/u,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("names the fragment in an entry refusal, and keeps the registry's own refusal unprefixed", () => {
    const root = copyCatalog();
    try {
      const path = join(root, "config/limits/semantic.yaml");
      writeFileSync(path, readFileSync(path, "utf8").replace(/^ {4}unit: .*\n/mu, ""));
      assert.throws(
        () => loadLimitDefinitions({ repoRoot: root }),
        /^Error: config\/limits\/semantic\.yaml: limits\.yaml entry missing unit$/u,
      );
      const rootPath = join(root, "config/limits.yaml");
      writeFileSync(
        rootPath,
        readFileSync(rootPath, "utf8").replace("    owner: host\n", "    owner: \n"),
      );
      assert.throws(
        () => loadLimitDefinitions({ repoRoot: root }),
        /^Error: limits\.yaml entry missing owner$/u,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a dangling yaml-named symlink by name and ignores any other dangling link", () => {
    const root = copyCatalog();
    try {
      const dir = join(root, "config/limits");
      symlinkSync(join(dir, "gone.yaml"), join(dir, "extra.yaml"));
      assert.throws(
        () => loadLimitDefinitions({ repoRoot: root }),
        /^Error: config\/limits\/extra\.yaml is a symlink whose target does not exist; restore the target or remove the link$/u,
      );
      rmSync(join(dir, "extra.yaml"));
      symlinkSync(join(dir, "gone.txt"), join(dir, "notes.txt"));
      assert.deepEqual(loadLimitDefinitions({ repoRoot: root }), loadLimitDefinitions());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("adjacent: a live symlink keeps today's handling, and a link loop is not reported as dangling", () => {
    const root = copyCatalog();
    try {
      const dir = join(root, "config/limits");
      symlinkSync(join(dir, "host.yaml"), join(dir, "extra.yaml"));
      assert.throws(
        () => loadLimitDefinitions({ repoRoot: root }),
        /^Error: config\/limits\/extra\.yaml is not registered in config\/limits\.yaml; add it to the fragments registry or remove it$/u,
      );
      rmSync(join(dir, "extra.yaml"));
      mkdirSync(join(root, "elsewhere"));
      symlinkSync(join(root, "elsewhere"), join(dir, "linked"));
      assert.throws(
        () => loadLimitDefinitions({ repoRoot: root }),
        /^Error: config\/limits\/linked is a directory; limit fragments are flat files registered in config\/limits\.yaml$/u,
      );
      rmSync(join(dir, "linked"));
      symlinkSync(join(dir, "loop.yaml"), join(dir, "loop.yaml"));
      assert.throws(
        () => loadLimitDefinitions({ repoRoot: root }),
        (error) => {
          assert.equal(error.code, "ELOOP");
          return true;
        },
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("bound identifier scanner (#1027)", () => {
  it("flags SCREAMING_CASE MAX_* without a digit separator", () => {
    const hits = matchBoundLiterals("export const MAX_FOO_BYTES = 256;\n");
    assert.ok(
      hits.some((hit) => hit.kind === "max-assign" && hit.lexeme.includes("MAX_FOO_BYTES")),
      `expected MAX_FOO_BYTES finding, got ${JSON.stringify(hits)}`,
    );
  });

  it("still flags camelCase max-assign", () => {
    const hits = matchBoundLiterals("const maxFooBytes = 4096;\n");
    assert.ok(
      hits.some((hit) => hit.kind === "max-assign" && hit.lexeme.includes("maxFooBytes")),
      `expected maxFooBytes finding, got ${JSON.stringify(hits)}`,
    );
  });

  it("flags SCREAMING_CASE WINDOW_MS by identifier, not a digit separator", () => {
    const hits = matchBoundLiterals("const WINDOW_MS = 900_000;\n");
    assert.ok(
      hits.some((hit) => hit.kind === "timeout-assign" && hit.lexeme.includes("WINDOW_MS")),
      `expected WINDOW_MS finding, got ${JSON.stringify(hits)}`,
    );
    assert.equal(
      hits.filter((hit) => hit.kind === "underscore").length,
      0,
      "digit separators are not a bound proxy",
    );
  });

  it("does not flag a generated catalog projection", () => {
    const hits = matchBoundLiterals(
      'export const MAX_INFERENCE_REJECTION_REASON_LENGTH = catalogLimit("inference.rejectionReasonLength");\n',
    );
    assert.deepEqual(hits, []);
  });

  it("does not flag catalog projections in source-citation-limits.ts", () => {
    const hits = scanBoundLiterals("runtime").filter((finding) =>
      finding.path.endsWith("source-citation-limits.ts"),
    );
    assert.deepEqual(hits, []);
  });

  it("does not treat a digit separator as a bound without a bound identifier", () => {
    const hits = matchBoundLiterals("const HASH_CHUNK = 12_345;\nconst versionStamp = 1_000;\n");
    assert.deepEqual(hits, []);
  });

  it("classifies MIN_/LIMIT_/BUDGET_ and _MS/_BYTES suffixes in any casing", () => {
    assert.equal(boundAssignKind("SOURCE_CLAIM_MIN_WORDS"), "max-assign");
    assert.equal(boundAssignKind("sourceCiteMaxSpansPerCall"), "max-assign");
    assert.equal(boundAssignKind("HOSTED_CONTEXT_PREFLIGHT_BUDGET_MS"), "max-assign");
    assert.equal(boundAssignKind("timeoutMs"), "timeout-assign");
    assert.equal(boundAssignKind("WINDOW_MS"), "timeout-assign");
    assert.equal(boundAssignKind("payload_bytes"), "max-assign");
    assert.equal(boundAssignKind("DEFAULT_TOOL_OUTPUT_CAP_BYTES"), "max-assign");
    assert.equal(boundAssignKind("stdoutBytes"), null);
    assert.equal(boundAssignKind("min"), null);
    assert.equal(boundAssignKind("HASH_CHUNK"), null);
  });
});

describe("live-model GitLab platform projection", () => {
  it("projects the catalog timeout and retention into GitLab duration syntax", () => {
    assert.equal(gitlabDurationFromMs(2_700_000), "45m");
    assert.equal(gitlabExpireInFromDays(30), "30 days");
    const definitions = loadLimitDefinitions();
    const rendered = renderGitlabLiveModelLimits(definitions);
    assert.match(rendered, /^# Generated by packages\/runtime\/scripts\/check-limits\.mjs/u);
    assert.match(
      rendered,
      /\.ci_live_model_platform_bounds:\n {2}timeout: 45m\n {2}artifacts:\n {4}expire_in: 30 days\n/u,
    );
  });

  it(
    "requires the live-model job to extend the generated bounds without inline literals",
    RUNTIME_CI_CASE,
    () => {
      const runtimeYaml = readFileSync(join(repositoryRoot, ".gitlab/ci/runtime.yml"), "utf8");
      const job = extractGitlabJob(runtimeYaml, "runtime:live-model");
      assert.match(job, /- \.ci_live_model_acceptance_platform_bounds/u);
      assert.doesNotMatch(job, /^\s+timeout:/mu);
      assert.doesNotMatch(job, /expire_in:/u);
      assert.equal(verifyGitlabLiveModelProjection(runtimeYaml).length, 0);
      // Adjacent: the acceptance run on the shared live-model bounds is refused.
      const swapped = runtimeYaml.replace(
        /(runtime:live-model:[\s\S]*?)- \.ci_live_model_acceptance_platform_bounds/u,
        "$1- .ci_live_model_platform_bounds",
      );
      assert.deepEqual(verifyGitlabLiveModelProjection(swapped), [
        "runtime.yml runtime:live-model must extend .ci_live_model_acceptance_platform_bounds from the generated CI limits include",
        "runtime.yml runtime:live-model must not also extend .ci_live_model_platform_bounds; GitLab applies the last of several bounds",
      ]);
      // Adding the shared bounds after its own would silently restore 45 minutes.
      const added = runtimeYaml.replace(
        /(runtime:live-model:[\s\S]*?- \.ci_live_model_acceptance_platform_bounds\n)/u,
        "$1    - .ci_live_model_platform_bounds\n",
      );
      assert.notEqual(added, runtimeYaml);
      assert.deepEqual(verifyGitlabLiveModelProjection(added), [
        "runtime.yml runtime:live-model must not also extend .ci_live_model_platform_bounds; GitLab applies the last of several bounds",
      ]);
    },
  );

  it("projects the acceptance run's own three-hour ceiling as a separate anchor", () => {
    const definitions = loadLimitDefinitions();
    const rendered = renderGitlabLiveModelLimits(definitions);
    assert.match(
      rendered,
      /\.ci_live_model_acceptance_platform_bounds:\n {2}timeout: 3h\n {2}artifacts:\n {4}expire_in: 30 days\n/u,
    );
    // The shared ceiling keeps its value, so canary rounds and mr-assessment
    // are unchanged.
    assert.match(rendered, /\.ci_live_model_platform_bounds:\n {2}timeout: 45m\n/u);
  });

  it(
    "prepares the acceptance CLI's complete generated mirror closure before importing it",
    RUNTIME_CI_CASE,
    () => {
      const runtimeYaml = readFileSync(join(repositoryRoot, ".gitlab/ci/runtime.yml"), "utf8");
      const job = extractGitlabJob(runtimeYaml, "runtime:live-model");
      assert.match(
        job,
        /node scripts\/ensure-derived\.mjs --steps limits,env-admission,model-output/u,
      );
      assert.ok(
        job.indexOf("--steps limits,env-admission,model-output") <
          job.indexOf("scripts/prepare-live-model-ci-config.ts"),
        "generated inputs must be ready before the acceptance preparation imports its CLI",
      );
    },
  );

  it(
    "prepares the live-journey bootstrap and gate generated closure before importing them",
    RUNTIME_CI_CASE,
    () => {
      const runtimeYaml = readFileSync(join(repositoryRoot, ".gitlab/ci/runtime.yml"), "utf8");
      const job = extractGitlabJob(runtimeYaml, "runtime:live-journey");
      assert.match(
        job,
        /node scripts\/ensure-derived\.mjs --steps limits,env-admission,model-output/u,
      );
      assert.ok(
        job.indexOf("--steps limits,env-admission,model-output") <
          job.indexOf("scripts/prepare-live-model-ci-config.ts"),
        "generated inputs must be ready before the live-journey setup import",
      );
    },
  );

  it("projects the journey gate's own ceiling as a second anchor (#1046)", () => {
    const definitions = loadLimitDefinitions();
    const rendered = renderGitlabLiveModelLimits(definitions);
    assert.match(
      rendered,
      /\.ci_live_journey_platform_bounds:\n {2}timeout: 3h\n {2}artifacts:\n {4}expire_in: 30 days\n/u,
    );
    // The two anchors must be distinct ceilings: a journey does not fit the
    // live-model job timeout.
    assert.notEqual(
      definitions.find((entry) => entry.name === "ci.liveJourney.jobTimeoutMs").value,
      definitions.find((entry) => entry.name === "ci.liveModel.jobTimeoutMs").value,
    );
  });

  it(
    "requires the live-journey job to extend ITS anchor, not the live-model one",
    RUNTIME_CI_CASE,
    () => {
      const runtimeYaml = readFileSync(join(repositoryRoot, ".gitlab/ci/runtime.yml"), "utf8");
      const job = extractGitlabJob(runtimeYaml, "runtime:live-journey");
      assert.match(job, /- \.ci_live_journey_platform_bounds/u);
      assert.doesNotMatch(job, /^\s+timeout:/mu);
      assert.doesNotMatch(job, /expire_in:/u);
      assert.equal(verifyGitlabLiveModelProjection(runtimeYaml).length, 0);
      // Adjacent: the journey gate on the live-model bounds is refused.
      const swapped = runtimeYaml.replace(
        /(runtime:live-journey:[\s\S]*?)- \.ci_live_journey_platform_bounds/u,
        "$1- .ci_live_model_platform_bounds",
      );
      assert.deepEqual(verifyGitlabLiveModelProjection(swapped), [
        "runtime.yml runtime:live-journey must extend .ci_live_journey_platform_bounds from the generated CI limits include",
        "runtime.yml runtime:live-journey must not also extend .ci_live_model_platform_bounds; GitLab applies the last of several bounds",
      ]);
    },
  );
});

const GITLAB_CI_CASE = internalOnly(
  [
    ".gitlab-ci.yml",
    ".gitlab/ci/runtime.yml",
    ".gitlab/ci/knowledge.yml",
    ".gitlab/ci/public-export.yml",
  ],
  "reads the GitLab CI definition",
);

// Every retention owner is read by the unscoped check:limits in runtime:static,
// so a change to any of them alone must trigger that job on a merge request.
describe("artifact retention owners trigger the limits gate", () => {
  it("lists every retention owner file in the unscoped limits-scan patterns", () => {
    const patterns = limitsScanCiPathPatterns("all");
    for (const owner of Object.keys(GITLAB_ARTIFACT_RETENTION_JOBS)) {
      assert.ok(patterns.includes(owner), `${owner} is not in limitsScanCiPathPatterns("all")`);
    }
  });
});

describe("artifact retention GitLab platform projection", GITLAB_CI_CASE, () => {
  const readCi = () => ({
    ".gitlab/ci/runtime.yml": readFileSync(join(repositoryRoot, ".gitlab/ci/runtime.yml"), "utf8"),
    ".gitlab/ci/knowledge.yml": readFileSync(
      join(repositoryRoot, ".gitlab/ci/knowledge.yml"),
      "utf8",
    ),
    ".gitlab/ci/public-export.yml": readFileSync(
      join(repositoryRoot, ".gitlab/ci/public-export.yml"),
      "utf8",
    ),
  });

  it("projects handoff and report retention as two anchors", () => {
    const rendered = renderGitlabArtifactRetentionLimits(loadLimitDefinitions());
    assert.match(rendered, /^# Generated by packages\/runtime\/scripts\/check-limits\.mjs/u);
    assert.match(rendered, /\.ci_handoff_artifacts:\n {2}artifacts:\n {4}expire_in: 3 days\n/u);
    assert.match(rendered, /\.ci_report_artifacts:\n {2}artifacts:\n {4}expire_in: 14 days\n/u);
  });

  it("passes at the checked-in runtime, knowledge and public-export CI (positive control)", () => {
    assert.deepEqual(verifyGitlabArtifactRetentionProjection(readCi()), []);
  });

  it("refuses a hand-declared expire_in: in any job of a governed file", () => {
    const ci = readCi();
    const runtimeYaml = ci[".gitlab/ci/runtime.yml"];
    const mutated = runtimeYaml.replace(
      /(runtime:static:\n[\s\S]*?\n  script:\n)/u,
      "$1    - true\n  artifacts:\n    expire_in: 90 days\n",
    );
    assert.notEqual(mutated, runtimeYaml, "mutant did not change the fixture");
    const failures = verifyGitlabArtifactRetentionProjection({
      ...ci,
      ".gitlab/ci/runtime.yml": mutated,
    });
    assert.equal(failures.length, 1);
    assert.match(failures[0], /^\.gitlab\/ci\/runtime\.yml:\d+ must not declare expire_in:/u);
  });

  it("refuses a hand-declared expire_in: in the public-export job file", () => {
    const ci = readCi();
    const exportYaml = ci[".gitlab/ci/public-export.yml"];
    const mutated = exportYaml.replace(
      /(public-export:dry-run:\n[\s\S]*?\n {2}artifacts:\n)/u,
      "$1    expire_in: 90 days\n",
    );
    assert.notEqual(mutated, exportYaml, "mutant did not change the fixture");
    const expireLine = mutated.split("\n").indexOf("    expire_in: 90 days") + 1;
    assert.deepEqual(
      verifyGitlabArtifactRetentionProjection({ ...ci, ".gitlab/ci/public-export.yml": mutated }),
      [
        `.gitlab/ci/public-export.yml:${expireLine} must not declare expire_in:; extend a generated retention include instead`,
      ],
    );
  });

  it("refuses a public-export dry run that drops its retention anchor", () => {
    const ci = readCi();
    const exportYaml = ci[".gitlab/ci/public-export.yml"];
    const mutated = exportYaml.replace(
      /(public-export:dry-run:\n[\s\S]*?)\n {4}- \.ci_report_artifacts/u,
      "$1",
    );
    assert.notEqual(mutated, exportYaml, "mutant did not change the fixture");
    assert.deepEqual(
      verifyGitlabArtifactRetentionProjection({ ...ci, ".gitlab/ci/public-export.yml": mutated }),
      [
        ".gitlab/ci/public-export.yml public-export:dry-run must extend .ci_report_artifacts from the generated artifact retention include",
      ],
    );
  });

  it("refuses a listed job that drops its retention anchor", () => {
    const ci = readCi();
    const knowledgeYaml = ci[".gitlab/ci/knowledge.yml"];
    const mutated = knowledgeYaml.replace(
      /(documentation:freshness:\n[\s\S]*?)\n {4}- \.ci_report_artifacts/u,
      "$1",
    );
    assert.notEqual(mutated, knowledgeYaml, "mutant did not change the fixture");
    assert.deepEqual(
      verifyGitlabArtifactRetentionProjection({ ...ci, ".gitlab/ci/knowledge.yml": mutated }),
      [
        ".gitlab/ci/knowledge.yml documentation:freshness must extend .ci_report_artifacts from the generated artifact retention include",
      ],
    );
  });

  it("refuses a handoff job moved onto the report anchor", () => {
    const ci = readCi();
    const runtimeYaml = ci[".gitlab/ci/runtime.yml"];
    const swapped = runtimeYaml.replace(
      /(runtime:package:verify:\n[\s\S]*?)- \.ci_handoff_artifacts/u,
      "$1- .ci_report_artifacts",
    );
    assert.notEqual(swapped, runtimeYaml, "mutant did not change the fixture");
    assert.deepEqual(
      verifyGitlabArtifactRetentionProjection({ ...ci, ".gitlab/ci/runtime.yml": swapped }),
      [
        ".gitlab/ci/runtime.yml runtime:package:verify must extend .ci_handoff_artifacts from the generated artifact retention include",
      ],
    );
  });

  it("refuses a missing or commented-out retention include line", () => {
    const gitlabCiYaml = readFileSync(join(repositoryRoot, ".gitlab-ci.yml"), "utf8");
    assert.deepEqual(verifyGitlabArtifactRetentionIncludePresence(gitlabCiYaml), []);
    const line = "  - local: .gitlab/ci/artifact-retention-limits.generated.yml\n";
    for (const mutated of [
      gitlabCiYaml.replace(line, ""),
      gitlabCiYaml.replace(line, `  # ${line.trimStart()}`),
    ]) {
      assert.notEqual(mutated, gitlabCiYaml, "mutant did not change the fixture");
      const failures = verifyGitlabArtifactRetentionIncludePresence(mutated);
      assert.equal(failures.length, 1);
      assert.match(
        failures[0],
        /must include an active, uncommented ".*artifact-retention-limits\.generated\.yml"/u,
      );
    }
  });
});

describe("SAST GitLab platform projection (#916 follow-up)", () => {
  it("projects the catalog timeout and max-target-bytes into the semgrep-sast job's variables", () => {
    const definitions = loadLimitDefinitions();
    const rendered = renderGitlabSastLimits(definitions);
    assert.match(rendered, /^# Generated by packages\/runtime\/scripts\/check-limits\.mjs/u);
    assert.match(
      rendered,
      /semgrep-sast:\n {2}variables:\n {4}SEMGREP_RULE_TIMEOUT_SECONDS: "15"\n {4}SEMGREP_MAX_TARGET_BYTES: "1000000"\n/u,
    );
  });

  it(
    "passes at the real checked-in blueprint-compliance.yml (positive control)",
    SAST_JOB_CASE,
    () => {
      const blueprintYaml = readFileSync(
        join(repositoryRoot, ".gitlab/ci/blueprint-compliance.yml"),
        "utf8",
      );
      const definitions = loadLimitDefinitions();
      assert.deepEqual(verifyGitlabSastProjection(blueprintYaml, definitions), []);
    },
  );

  it("refuses a hand-declared literal --timeout (critic B1 refusal mutant)", SAST_JOB_CASE, () => {
    const blueprintYaml = readFileSync(
      join(repositoryRoot, ".gitlab/ci/blueprint-compliance.yml"),
      "utf8",
    );
    const definitions = loadLimitDefinitions();
    const mutated = blueprintYaml.replace(
      `SAST_SCANNER_ALLOWED_CLI_OPTS: "--timeout $${SAST_SEMGREP_TIMEOUT_VARIABLE} --max-target-bytes $${SAST_MAX_TARGET_BYTES_VARIABLE}"`,
      'SAST_SCANNER_ALLOWED_CLI_OPTS: "--timeout 15 --max-target-bytes $SEMGREP_MAX_TARGET_BYTES"',
    );
    assert.notEqual(mutated, blueprintYaml, "mutant did not change the fixture");
    const failures = verifyGitlabSastProjection(mutated, definitions);
    assert.equal(failures.length, 1);
    assert.match(
      failures[0],
      /must set SAST_SCANNER_ALLOWED_CLI_OPTS.*not a hand-declared literal/u,
    );
  });

  it(
    "refuses when the generated variables are dropped from the job (critic mutant M4)",
    SAST_JOB_CASE,
    () => {
      const blueprintYaml = readFileSync(
        join(repositoryRoot, ".gitlab/ci/blueprint-compliance.yml"),
        "utf8",
      );
      const definitions = loadLimitDefinitions();
      // Deleting the `variables:` block would fall back to the analyzer's
      // defaults and drop SAST_EXCLUDED_PATHS.
      const mutated = blueprintYaml.replace(/\n {2}variables:\n(?: {4}.*\n| *#.*\n)+/u, "\n");
      assert.notEqual(mutated, blueprintYaml, "mutant did not change the fixture");
      assert.doesNotMatch(mutated, /SAST_SCANNER_ALLOWED_CLI_OPTS/u);
      const failures = verifyGitlabSastProjection(mutated, definitions);
      assert.equal(failures.length, 2);
      assert.match(failures[0], /must set SAST_SCANNER_ALLOWED_CLI_OPTS/u);
      assert.match(failures[1], /must set SAST_EXCLUDED_PATHS/u);
    },
  );

  it(
    "refuses a hand-declared SEMGREP_RULE_TIMEOUT_SECONDS shadowing the generated include (mutant M-G)",
    SAST_JOB_CASE,
    () => {
      const blueprintYaml = readFileSync(
        join(repositoryRoot, ".gitlab/ci/blueprint-compliance.yml"),
        "utf8",
      );
      const definitions = loadLimitDefinitions();
      const mutated = blueprintYaml.replace(
        "  variables:\n",
        `  variables:\n    ${SAST_SEMGREP_TIMEOUT_VARIABLE}: "5"\n`,
      );
      assert.notEqual(mutated, blueprintYaml, "mutant did not change the fixture");
      const failures = verifyGitlabSastProjection(mutated, definitions);
      assert.equal(failures.length, 1);
      assert.match(failures[0], /must not hand-declare SEMGREP_RULE_TIMEOUT_SECONDS:.*shadows/u);
      // Distinguishable from the --timeout literal message above.
      assert.doesNotMatch(failures[0], /SAST_SCANNER_ALLOWED_CLI_OPTS/u);
    },
  );

  it(
    "refuses a hand-declared SEMGREP_MAX_TARGET_BYTES shadowing the generated include",
    SAST_JOB_CASE,
    () => {
      const blueprintYaml = readFileSync(
        join(repositoryRoot, ".gitlab/ci/blueprint-compliance.yml"),
        "utf8",
      );
      const definitions = loadLimitDefinitions();
      const mutated = blueprintYaml.replace(
        "  variables:\n",
        `  variables:\n    ${SAST_MAX_TARGET_BYTES_VARIABLE}: "2000000"\n`,
      );
      assert.notEqual(mutated, blueprintYaml, "mutant did not change the fixture");
      const failures = verifyGitlabSastProjection(mutated, definitions);
      assert.equal(failures.length, 1);
      assert.match(failures[0], /must not hand-declare SEMGREP_MAX_TARGET_BYTES:.*shadows/u);
    },
  );

  it("refuses a restored SAST_EXCLUDED_PATHS literal (mutant M2)", SAST_JOB_CASE, () => {
    const blueprintYaml = readFileSync(
      join(repositoryRoot, ".gitlab/ci/blueprint-compliance.yml"),
      "utf8",
    );
    const definitions = loadLimitDefinitions();
    const mutated = blueprintYaml.replace(
      'SAST_EXCLUDED_PATHS: ""',
      'SAST_EXCLUDED_PATHS: "spec, test, tests, tmp"',
    );
    assert.notEqual(mutated, blueprintYaml, "mutant did not change the fixture");
    const failures = verifyGitlabSastProjection(mutated, definitions);
    assert.equal(failures.length, 1);
    assert.match(failures[0], /must set SAST_EXCLUDED_PATHS: "" \(empty\)/u);
    // Distinguishable from (a)'s shadowing and CLI-opts messages.
    assert.doesNotMatch(failures[0], /hand-declare|SAST_SCANNER_ALLOWED_CLI_OPTS/u);
  });

  it("refuses a deleted SAST_EXCLUDED_PATHS line (mutant M3)", SAST_JOB_CASE, () => {
    const blueprintYaml = readFileSync(
      join(repositoryRoot, ".gitlab/ci/blueprint-compliance.yml"),
      "utf8",
    );
    const definitions = loadLimitDefinitions();
    const mutated = blueprintYaml.replace(/^\s+SAST_EXCLUDED_PATHS: ""\n/mu, "");
    assert.notEqual(mutated, blueprintYaml, "mutant did not change the fixture");
    assert.doesNotMatch(mutated, /SAST_EXCLUDED_PATHS/u);
    const failures = verifyGitlabSastProjection(mutated, definitions);
    assert.equal(failures.length, 1);
    assert.match(failures[0], /must set SAST_EXCLUDED_PATHS: "" \(empty\)/u);
  });

  // GitLab and PyYAML keep the last of a repeated `semgrep-sast:` key, so
  // reading the first would check a job GitLab never runs.
  it("refuses a repeated top-level semgrep-sast: header (mutant C7)", SAST_JOB_CASE, () => {
    const blueprintYaml = readFileSync(
      join(repositoryRoot, ".gitlab/ci/blueprint-compliance.yml"),
      "utf8",
    );
    const definitions = loadLimitDefinitions();
    const mutated = `${blueprintYaml}semgrep-sast:\n  variables:\n    SAST_EXCLUDED_PATHS: "spec, test"\n`;
    assert.notEqual(mutated, blueprintYaml, "mutant did not change the fixture");
    assert.throws(
      () => verifyGitlabSastProjection(mutated, definitions),
      /more than one top-level "semgrep-sast:" mapping key/u,
    );
  });

  it(
    "passes at the real checked-in .gitlab-ci.yml include line (positive control)",
    CI_INCLUDE_CASE,
    () => {
      const gitlabCiYaml = readFileSync(join(repositoryRoot, ".gitlab-ci.yml"), "utf8");
      assert.deepEqual(verifyGitlabSastIncludePresence(gitlabCiYaml), []);
    },
  );

  it("refuses a missing SAST limits include line (mutant M-F)", CI_INCLUDE_CASE, () => {
    const gitlabCiYaml = readFileSync(join(repositoryRoot, ".gitlab-ci.yml"), "utf8");
    const mutated = gitlabCiYaml.replace("  - local: .gitlab/ci/sast-limits.generated.yml\n", "");
    assert.notEqual(mutated, gitlabCiYaml, "mutant did not change the fixture");
    const failures = verifyGitlabSastIncludePresence(mutated);
    assert.equal(failures.length, 1);
    assert.match(
      failures[0],
      /must include an active, uncommented ".*sast-limits\.generated\.yml"/u,
    );
  });

  // A substring test would still find the include line inside a comment,
  // the ordinary way an operator disables an include.
  it("refuses a commented-out SAST limits include line (mutant C1)", CI_INCLUDE_CASE, () => {
    const gitlabCiYaml = readFileSync(join(repositoryRoot, ".gitlab-ci.yml"), "utf8");
    const mutated = gitlabCiYaml.replace(
      "  - local: .gitlab/ci/sast-limits.generated.yml\n",
      "  # - local: .gitlab/ci/sast-limits.generated.yml\n",
    );
    assert.notEqual(mutated, gitlabCiYaml, "mutant did not change the fixture");
    assert.ok(
      mutated.includes(".gitlab/ci/sast-limits.generated.yml"),
      "mutant must keep the path text present, only commented out -- otherwise it is indistinguishable from M-F",
    );
    const failures = verifyGitlabSastIncludePresence(mutated);
    assert.equal(failures.length, 1);
    assert.match(
      failures[0],
      /must include an active, uncommented ".*sast-limits\.generated\.yml"/u,
    );
  });

  it(
    "asserts the ci:yaml job's script checks the generated SAST limits file exists",
    CI_YAML_JOB_CASE,
    () => {
      const parse = loadYamlParse();
      assert.ok(parse, "the yaml package must be installed to parse process.yml in this test");
      const processYaml = parse(
        readFileSync(join(repositoryRoot, ".gitlab/ci/process.yml"), "utf8"),
      );
      const script = processYaml["ci:yaml"].script;
      assert.ok(Array.isArray(script), "ci:yaml script must be a list");
      assert.ok(
        script.includes("test -f .gitlab/ci/sast-limits.generated.yml"),
        "ci:yaml script is missing the SAST limits generated-file existence check " +
          "(this only proves the line is present in the checked-in job, not that " +
          "GitLab CI executes it -- ci:yaml is exercised only by GitLab CI itself)",
      );
    },
  );
});

describe("renderCatalogJson (#1169)", () => {
  // The drift gate only compares against the generator's own output, so a
  // generator that dropped a field would stay green; checker.py reads this.
  const definitions = [
    {
      name: "alpha.maxThings",
      value: 512,
      unit: "characters",
      scope: "product",
      warnAt: 400,
      override: "DOCSFAB_ALPHA_MAX_THINGS",
      min: 1,
      max: 4096,
      refusal: "refuses above 512 characters",
      remediation: "shorten the identifier",
      rationale: "bounded so a hostile identifier cannot grow without limit",
    },
    {
      name: "beta.timeoutMs",
      value: 30000,
      unit: "milliseconds",
      scope: "sealed",
      warnAt: null,
      override: null,
      min: null,
      max: null,
      refusal: null,
      remediation: null,
      rationale: "unknown",
    },
  ];

  it("emits the sealed envelope and one entry per definition, keyed by name", () => {
    const parsed = JSON.parse(renderCatalogJson(definitions));
    assert.equal(parsed.schemaVersion, 1);
    assert.equal(parsed.kind, "docsfab-limits-catalog");
    assert.deepEqual(Object.keys(parsed.limits), ["alpha.maxThings", "beta.timeoutMs"]);
  });

  it("carries exactly the ten documented fields, in order, for every entry", () => {
    const parsed = JSON.parse(renderCatalogJson(definitions));
    const expected = [
      "value",
      "unit",
      "scope",
      "warnAt",
      "override",
      "min",
      "max",
      "refusal",
      "remediation",
      "rationale",
    ];
    for (const name of Object.keys(parsed.limits)) {
      assert.deepEqual(
        Object.keys(parsed.limits[name]),
        expected,
        `${name} does not carry the documented catalog field set`,
      );
    }
  });

  it("adjacent: an entry that also declares docValue/docSummary/docValueCode appends exactly those, after the ten documented fields (#1307)", () => {
    const withDocFields = [
      ...definitions,
      {
        ...definitions[0],
        name: "gamma.docExample",
        docValue: "512 characters",
        docSummary: "An example.",
      },
      {
        ...definitions[1],
        name: "delta.docCodeExample",
        docValueCode: true,
        docSummary: "An example.",
      },
    ];
    const parsed = JSON.parse(renderCatalogJson(withDocFields));
    assert.deepEqual(Object.keys(parsed.limits["gamma.docExample"]).slice(-2), [
      "docValue",
      "docSummary",
    ]);
    assert.deepEqual(Object.keys(parsed.limits["delta.docCodeExample"]).slice(-2), [
      "docValueCode",
      "docSummary",
    ]);
    assert.equal(parsed.limits["delta.docCodeExample"].docValueCode, true);
    // Entries without doc fields are unaffected by a sibling that has them.
    assert.deepEqual(Object.keys(parsed.limits["alpha.maxThings"]).length, 10);
  });

  it("preserves a numeric value as a JSON number, never a string", () => {
    // checker.py refuses a non-integer `value`.
    const parsed = JSON.parse(renderCatalogJson(definitions));
    assert.equal(parsed.limits["alpha.maxThings"].value, 512);
    assert.equal(typeof parsed.limits["alpha.maxThings"].value, "number");
    assert.equal(typeof parsed.limits["beta.timeoutMs"].value, "number");
  });

  it("preserves absent optional fields as null rather than dropping the key", () => {
    const parsed = JSON.parse(renderCatalogJson(definitions));
    const beta = parsed.limits["beta.timeoutMs"];
    for (const field of ["warnAt", "override", "min", "max", "refusal", "remediation"]) {
      assert.equal(beta[field], null, `${field} should be null, not absent`);
      assert.ok(field in beta, `${field} key was dropped`);
    }
  });

  it("ends with exactly one trailing newline, as the drift gate compares bytes", () => {
    const rendered = renderCatalogJson(definitions);
    assert.ok(rendered.endsWith("}\n"));
    assert.ok(!rendered.endsWith("\n\n"));
  });

  it("is the value renderMirrors writes to config/limits.catalog.json", () => {
    // Reachability. Uses the real definitions: renderMirrors' other renderers
    // demand named entries the fixture lacks.
    const real = loadLimitDefinitions();
    const mirrors = renderMirrors(real);
    assert.ok(
      Object.keys(mirrors).includes("config/limits.catalog.json"),
      "renderMirrors no longer writes config/limits.catalog.json",
    );
    assert.equal(mirrors["config/limits.catalog.json"], renderCatalogJson(real));
  });
});

// The knowledge first pass cannot import runtime code, so its firstPass.*
// defaults come from a generated mirror the drift gate compares (#1915).
describe("knowledge first-pass limits mirror (#1915)", () => {
  const real = loadLimitDefinitions();
  const firstPass = real.filter((definition) => definition.name.startsWith("firstPass."));

  it("renders every firstPass.* catalog default under its name after firstPass.", () => {
    const rendered = renderKnowledgeFirstPassLimits(real);
    assert.ok(firstPass.length >= 11, String(firstPass.length));
    const fields = [...rendered.matchAll(/^ {2}([A-Za-z]+): (\d+(?:\.\d+)?),$/gmu)].map((match) => [
      match[1],
      Number(match[2]),
    ]);
    assert.deepEqual(
      fields,
      firstPass.map((definition) => [definition.name.slice("firstPass.".length), definition.value]),
    );
    assert.ok(rendered.endsWith("});\n"));
  });

  it("is the mirror renderMirrors writes, and a build-generated one git does not track", () => {
    const mirrors = renderMirrors(real);
    assert.equal(mirrors[KNOWLEDGE_FIRST_PASS_GENERATED], renderKnowledgeFirstPassLimits(real));
    assert.ok(BUILD_GENERATED_MIRRORS.includes(KNOWLEDGE_FIRST_PASS_GENERATED));
  });

  it("refuses a firstPass limit name that is not one identifier", () => {
    const [template] = firstPass;
    assert.throws(
      () => renderKnowledgeFirstPassLimits([{ ...template, name: "firstPass.max-spans" }]),
      /firstPass\.max-spans: a firstPass limit name must be one identifier/u,
    );
    assert.throws(
      () =>
        renderKnowledgeFirstPassLimits(real.filter((item) => !item.name.startsWith("firstPass."))),
      /must declare firstPass\.\* limits/u,
    );
  });

  it("refuses a stale knowledge mirror", SHIPPED_CLI_CASE, () => {
    const root = partialRepo({
      copied: ["config", "packages/runtime/scripts", "packages/knowledge/src"],
    });
    try {
      writeFileSync(join(root, KNOWLEDGE_FIRST_PASS_GENERATED), "stale\n");
      const result = runLinkedCli(root, ["--check"]);
      assert.equal(result.status, 1, result.stdout);
      assert.equal(
        result.stderr,
        `check:limits failed: ${KNOWLEDGE_FIRST_PASS_GENERATED} drifted from config/limits.yaml; run npm run generate:limits\n`,
      );
    } finally {
      removeLinkedRepo(root);
    }
  });
});

describe("offline train-reuse metadata limits mirror", () => {
  const definitions = loadLimitDefinitions();
  const path = ".gitlab/ci/train-reuse/limits.generated.json";

  it("emits exactly the four approved definitions and hashes the fixed source files", () => {
    const rendered = renderTrainReuseLimits(definitions);
    const mirror = JSON.parse(rendered);
    assert.equal(mirror.schemaVersion, 1);
    assert.equal(mirror.kind, "docsfab-ci-train-reuse-limits");
    assert.deepEqual(Object.keys(mirror.limits), [
      "ci.trainReuse.apiPageSize",
      "ci.trainReuse.apiResponseMaxBytes",
      "ci.trainReuse.evidenceMaxBytes",
      "ci.trainReuse.discoveryTimeoutMs",
    ]);
    const sourcePaths = [
      "config/limits.yaml",
      "config/limits/ci.yaml",
      "packages/runtime/scripts/check-limits.mjs",
    ];
    assert.deepEqual(Object.keys(mirror.sourceDigests), sourcePaths);
    for (const source of sourcePaths) {
      assert.equal(
        mirror.sourceDigests[source],
        createHash("sha256")
          .update(readFileSync(join(repositoryRoot, source)))
          .digest("hex"),
      );
    }
    assert.ok(rendered.endsWith("\n"));
    assert.equal(rendered.endsWith("\n\n"), false);
  });

  it("is the committed mirror renderMirrors checks, owned by the train-reuse reader", () => {
    const mirrors = renderMirrors(definitions);
    assert.equal(mirrors[path], renderTrainReuseLimits(definitions));
    assert.ok(mirrors[path].includes("DOCSFAB_LIMIT_CI_TRAIN_REUSE_API_PAGE_SIZE"));
    const owner = join(repositoryRoot, ".gitlab/ci/train-reuse/metadata.mjs");
    if (existsSync(owner)) {
      assert.equal(readFileSync(join(repositoryRoot, path), "utf8"), mirrors[path]);
    } else {
      assert.equal(existsSync(join(repositoryRoot, path)), false);
    }
  });
});

describe("the configured deploy root in mirrors and CI trigger patterns", () => {
  const definitions = loadLimitDefinitions();

  it("writes the deploy shell mirror only for a configured root, sourced from that root", () => {
    const configured = renderMirrors(definitions, FIXTURE_DEPLOY_ROOT);
    const mirror = configured["deploy/fixture-host/limits.generated.sh"];
    assert.ok(mirror, "no shell mirror for the configured root");
    assert.match(mirror, /^# Sourced by deploy\/fixture-host\/lib\.sh and service-status\.sh\.$/mu);
    // Adjacent: without a deploy root no deploy path is written at all.
    const unconfigured = renderMirrors(definitions, null);
    assert.deepEqual(
      Object.keys(unconfigured).filter((path) => path.startsWith("deploy/")),
      [],
    );
    assert.deepEqual(
      Object.keys(unconfigured),
      Object.keys(configured).filter((path) => path !== "deploy/fixture-host/limits.generated.sh"),
    );
  });

  it("triggers on the deploy configuration in every scope, and on the root only when configured", () => {
    const configured = limitsScanCiPathPatterns("deploy", FIXTURE_DEPLOY_ROOT);
    for (const pattern of [
      "deploy/fixture-host/**/*",
      "deploy/fixture-host/limits.generated.sh",
      DEPLOY_ROOT_CONFIG_PATH,
      "packages/runtime/scripts/limits-deploy-root.mjs",
    ]) {
      assert.ok(configured.includes(pattern), pattern);
    }
    const unconfigured = limitsScanCiPathPatterns("all", null);
    assert.ok(unconfigured.includes(DEPLOY_ROOT_CONFIG_PATH));
    assert.deepEqual(
      unconfigured.filter((pattern) => pattern.startsWith("deploy/")),
      [],
    );
    assert.throws(
      () => limitsScanCiPathPatterns("deploy", null),
      /^Error: --scope deploy needs a deploy root, and config\/limits-deploy\.json is absent from this tree; restore it, or check another scope$/u,
    );
    // Adjacent: the host scope never needs the deploy root.
    assert.ok(limitsScanCiPathPatterns("host", null).includes("packages/host/src/**/*"));
  });
});

describe("mirror path listing and entry-point guard (#1169)", () => {
  const script = join(runtimeRoot, "scripts/check-limits.mjs");

  it("prints exactly the paths renderMirrors writes", async () => {
    const result = await runLimitsTool({
      checkOnly: false,
      writeAllowlist: false,
      gate: false,
      scope: "all",
      hostFile: null,
      printMirrorPaths: true,
    });
    assert.equal(result.status, "mirror-paths");
    assert.deepEqual(result.paths, Object.keys(renderMirrors(loadLimitDefinitions())));
    assert.ok(result.paths.includes("config/limits.catalog.json"));
    assert.ok(result.paths.includes(".gitlab/ci/sast-limits.generated.yml"));
  });

  it("runs as a CLI when invoked through a symlink", () => {
    // `import.meta.url` is symlink-resolved but argv[1] is not; an npm bin
    // shim or macOS temp path reaches this shape.
    const root = mkdtempSync(join(tmpdir(), "docsfab-limits-symlink-"));
    try {
      const link = join(root, "check-limits-link.mjs");
      symlinkSync(script, link);
      const direct = spawnSync(process.execPath, [script, "--print-mirror-paths"], {
        encoding: "utf8",
      });
      const linked = spawnSync(process.execPath, [link, "--print-mirror-paths"], {
        encoding: "utf8",
      });
      assert.equal(direct.status, 0, direct.stderr);
      assert.ok(direct.stdout.trim().length > 0, "direct invocation printed nothing");
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
});

// Drives `runLimitsTool`, the `npm run check:limits` call site, against a
// scratch copy of the doc tables via the test-only `docTablesDir`, so the
// wiring into the check path is proven, not only the helper.
describe("doc-drift check wired into runLimitsTool's real call site (#1307 round-1 review !1164 finding 2)", () => {
  const copyTables = (dir) => cpSync(join(repositoryRoot, TABLES_DIR), dir, { recursive: true });
  const checkGateOptions = {
    checkOnly: true,
    gate: true,
    scope: "all",
    hostFile: null,
    writeAllowlist: false,
    printMirrorPaths: false,
  };

  it("positive control: an unmodified doc copy passes through runLimitsTool({checkOnly, gate}) -- the real npm run check:limits entry point", async () => {
    const dir = mkdtempSync(join(tmpdir(), "docsfab-limits-doc-wiring-"));
    try {
      copyTables(dir);
      const result = await runLimitsTool({ ...checkGateOptions, docTablesDir: dir });
      assert.equal(result.status, "checked");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails through runLimitsTool({checkOnly, gate}) -- not just the runDocsLimitsTool helper -- when the doc drifts (critic mutant C2 target)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "docsfab-limits-doc-wiring-"));
    const docPath = join(dir, "operational-limits-defaults.md");
    try {
      copyTables(dir);
      const realDocText = readFileSync(docPath, "utf8");
      const mutated = realDocText.replace("| 500 ms |", "| 999 ms |");
      assert.notEqual(
        mutated,
        realDocText,
        "fixture row `| 500 ms |` (providerAttempt.baseDelayMs) should exist verbatim in the committed table",
      );
      writeFileSync(docPath, mutated);
      let caught = null;
      try {
        await runLimitsTool({ ...checkGateOptions, docTablesDir: dir });
      } catch (error) {
        caught = error;
      }
      assert.ok(caught, "runLimitsTool should reject when the injected doc has drifted");
      assert.ok(
        Array.isArray(caught.failures),
        "runLimitsTool should attach .failures to the thrown error",
      );
      const expected = `docs table drift: ${docPath} does not match the catalog; run npm run generate:limits`;
      assert.ok(
        caught.failures.includes(expected),
        `expected a failure exactly equal to:\n  ${expected}\ngot:\n${caught.failures.join("\n")}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("adjacent: the prose pages sit outside the checked tables, so a prose edit cannot trip drift", () => {
    // The check reads only the tables directory; each page that includes the
    // tables holds no generated region of its own.
    for (const path of PAGE_PATHS) {
      assert.ok(!path.startsWith(`${TABLES_DIR}/`), path);
      const page = readFileSync(join(repositoryRoot, path), "utf8");
      assert.ok(page.length > 0, `${path} should hold hand-authored prose`);
      assert.equal(page.includes("{/* GENERATED:"), false);
    }
  });
});

function withYamlHidden(callback) {
  const origResolve = Module._resolveFilename;
  Module._resolveFilename = function hideYaml(request, ...rest) {
    if (request === "yaml") {
      const error = new Error("Cannot find module 'yaml'");
      error.code = "MODULE_NOT_FOUND";
      throw error;
    }
    return origResolve.call(this, request, ...rest);
  };
  try {
    return callback();
  } finally {
    Module._resolveFilename = origResolve;
  }
}

/** The root registry's fragments, in composition order, read with the subset parser. */
function registeredFragments() {
  return parseLimitsYamlSubset(readFileSync(yamlPath, "utf8")).fragments;
}

/**
 * Copy the checked-in root registry and every file under config/limits/ into
 * a temporary repository root. `reverseCreation` writes the fragments in
 * reverse registry order, so the copy's creation order differs from the
 * original's.
 */
function copyCatalog({ reverseCreation = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "docsfab-limit-fragments-"));
  mkdirSync(join(root, "config/limits"), { recursive: true });
  writeFileSync(join(root, "config/limits.yaml"), readFileSync(yamlPath, "utf8"));
  const files = registeredFragments().map(({ file }) => file);
  for (const file of reverseCreation ? [...files].reverse() : files) {
    writeFileSync(join(root, "config/limits", file), readFileSync(join(fragmentDir, file), "utf8"));
  }
  return root;
}

function fragmentText(root, file) {
  return readFileSync(join(root, "config/limits", file), "utf8");
}

/** One entry's lines, from its `- name:` line to the line before the next blank line. */
function entryBlock(root, file, name) {
  const text = fragmentText(root, file);
  const start = text.indexOf(`  - name: ${name}\n`);
  assert.ok(start >= 0, `${name} is not in ${file}`);
  const end = text.indexOf("\n\n", start);
  return text.slice(start, end < 0 ? text.length : end + 1);
}

/** Replace one entry's remediation text in a copied fragment. */
function rewriteRemediation(root, file, name, edit) {
  const path = join(root, "config/limits", file);
  const text = readFileSync(path, "utf8");
  const block = entryBlock(root, file, name);
  const line = /^ {4}remediation: (.*)$/mu.exec(block);
  assert.ok(line, `${name} has no remediation`);
  const next = edit(line[1]);
  assert.notEqual(next, line[1], `the edit did not change ${name}'s remediation`);
  writeFileSync(path, text.replace(block, block.replace(line[0], `    remediation: ${next}`)));
}

function firstEntryName(root, file) {
  const match = /^ {2}- name: (\S+)$/mu.exec(fragmentText(root, file));
  assert.ok(match, `${file} has no entries`);
  return match[1];
}

function appendEntry(root, file, block) {
  const path = join(root, "config/limits", file);
  writeFileSync(path, `${readFileSync(path, "utf8").trimEnd()}\n\n${block}`);
}

function removeEntry(root, file, block) {
  const path = join(root, "config/limits", file);
  const text = readFileSync(path, "utf8");
  const next = text.replace(`${block}\n`, "").replace(block, "");
  assert.notEqual(next, text, `could not remove the entry from ${file}`);
  writeFileSync(path, next);
}

/** The repository path of the shard in a composed `allowlist` that holds `literal`. */
function shardPathForLiteralFile({ shards }, literal) {
  return `config/limits-allowlist/${shards.find(({ literals }) => literals.includes(literal)).file}`;
}

/** The rows the root registry declares. */
function registeredShards() {
  return JSON.parse(readFileSync(allowlistRootPath, "utf8")).shards;
}

/** The registry rows, then the deploy row config/limits-deploy.json registers. */
function composedShards() {
  return [
    ...registeredShards(),
    ...(DEPLOY_ROOT === null ? [] : [{ file: DEPLOY_SHARD_FILE, owner: DEPLOY_ROOT }]),
  ];
}

/**
 * Copy the checked-in allowlist root, the deploy configuration, and every
 * shard they register into a temporary repository root.
 */
function copyAllowlist() {
  const root = mkdtempSync(join(tmpdir(), "docsfab-allowlist-shards-"));
  mkdirSync(join(root, "config/limits-allowlist"), { recursive: true });
  writeFileSync(
    join(root, "config/limits-allowlist.json"),
    readFileSync(allowlistRootPath, "utf8"),
  );
  writeFileSync(
    join(root, DEPLOY_ROOT_CONFIG_PATH),
    readFileSync(join(repositoryRoot, DEPLOY_ROOT_CONFIG_PATH), "utf8"),
  );
  for (const { file } of composedShards()) {
    writeFileSync(
      join(root, "config/limits-allowlist", file),
      readFileSync(join(allowlistShardDir, file), "utf8"),
    );
  }
  return root;
}

function readRoot(root) {
  return JSON.parse(readFileSync(join(root, "config/limits-allowlist.json"), "utf8"));
}

function writeRoot(root, document) {
  writeFileSync(
    join(root, "config/limits-allowlist.json"),
    `${JSON.stringify(document, null, 2)}\n`,
  );
}

function readShard(root, file) {
  return JSON.parse(readFileSync(join(root, "config/limits-allowlist", file), "utf8"));
}

function writeShard(root, file, document) {
  writeFileSync(
    join(root, "config/limits-allowlist", file),
    `${JSON.stringify(document, null, 2)}\n`,
  );
}

/** Move the first literal matching `pick` from one shard to another; returns it. */
function moveLiteral(root, from, to, pick) {
  const source = readShard(root, from);
  const index = source.literals.findIndex(pick);
  assert.ok(index >= 0, `no matching literal in ${from}`);
  const [moved] = source.literals.splice(index, 1);
  writeShard(root, from, source);
  const target = readShard(root, to);
  target.literals.push(moved);
  writeShard(root, to, target);
  return moved;
}

const LEGACY_ROOT_REFUSAL =
  /^Error: config\/limits-allowlist\.json must not declare a literals list; each literal lives in its owning shard under config\/limits-allowlist\/\. To carry root literals forward, run `node scripts\/check-limits\.mjs --write-allowlist` from packages\/runtime; it files each root literal, rationale included, in its owning shard and rewrites the root as the shards registry$/u;

/** Run the one command a refusal message names, from the directory it names. */
function followRefusal(root, message) {
  const match =
    /run `node (scripts\/check-limits\.mjs(?: --[a-z-]+)+)` from packages\/runtime/u.exec(message);
  assert.ok(match, message);
  const [script, ...args] = match[1].split(" ");
  return spawnSync(process.execPath, [script, ...args], {
    cwd: join(root, "packages/runtime"),
    encoding: "utf8",
  });
}

/** Every committed allowlist file's repository-relative path. */
function committedAllowlistFiles() {
  return [
    "config/limits-allowlist.json",
    ...readdirSync(allowlistShardDir).map((file) => `config/limits-allowlist/${file}`),
  ];
}

function escapeRe(text) {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

// Symlinks each linkedRepo() created, unlinked before its root is removed.
const LINKED_REPO_LINKS = new Map();

/**
 * A repository root for the shipped CLI, which resolves its root from its own
 * location. packages/runtime/scripts and config/ are real copies (written by
 * the tests); every other entry is a symlink to this checkout.
 */
function linkedRepo() {
  const root = mkdtempSync(join(tmpdir(), "docsfab-allowlist-cli-"));
  const links = [];
  const link = (relative) => {
    symlinkSync(join(repositoryRoot, relative), join(root, relative));
    links.push(join(root, relative));
  };
  const mirror = (relative, copied) => {
    mkdirSync(join(root, relative), { recursive: true });
    for (const name of readdirSync(join(repositoryRoot, relative))) {
      const child = relative === "" ? name : `${relative}/${name}`;
      if (child === ".git") continue;
      if (copied.has(child)) {
        cpSync(join(repositoryRoot, child), join(root, child), { recursive: true });
      } else if (["packages", "packages/runtime"].includes(child)) {
        mirror(child, copied);
      } else {
        link(child);
      }
    }
  };
  mirror("", new Set(["config", "packages/runtime/scripts"]));
  LINKED_REPO_LINKS.set(root, links);
  return root;
}

/** Unlink the symlinks first, so removal can never reach the checkout they point at. */
function removeLinkedRepo(root) {
  for (const path of LINKED_REPO_LINKS.get(root) ?? []) unlinkSync(path);
  LINKED_REPO_LINKS.delete(root);
  rmSync(root, { recursive: true, force: true });
}

function runLinkedCli(root, args) {
  return spawnSync(
    process.execPath,
    [join(root, "packages/runtime/scripts/check-limits.mjs"), ...args],
    { encoding: "utf8" },
  );
}

/**
 * A repository root for the shipped CLI with `omit` paths absent and
 * `copied` paths as real copies; every other entry is a symlink to this
 * checkout. `omit` applies inside a copy too, so the default is the public
 * export's shape: no deploy configuration and no host or deploy shard.
 */
function partialRepo({
  omit = EXPORT_EXCLUDED,
  copied = ["config", "packages/runtime/scripts"],
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "docsfab-limits-partial-"));
  const links = [];
  const copies = new Set(copied);
  const holdsSelection = (relative) =>
    holdsExportExcluded(relative, omit) ||
    [...copies].some((path) => path.startsWith(`${relative}/`));
  const mirror = (relative) => {
    mkdirSync(join(root, relative), { recursive: true });
    for (const name of readdirSync(join(repositoryRoot, relative))) {
      const child = relative === "" ? name : `${relative}/${name}`;
      if (child === ".git" || isExportExcluded(child, omit)) continue;
      if (copies.has(child)) {
        cpSync(join(repositoryRoot, child), join(root, child), {
          recursive: true,
          filter: (source) => !isExportExcluded(relativePath(repositoryRoot, source), omit),
        });
      } else if (holdsSelection(child)) {
        mirror(child);
      } else {
        symlinkSync(join(repositoryRoot, child), join(root, child));
        links.push(join(root, child));
      }
    }
  };
  mirror("");
  LINKED_REPO_LINKS.set(root, links);
  return root;
}

/** Name `deployRoot` in the tree's deploy configuration. */
function configureDeployRoot(root, deployRoot) {
  writeFileSync(
    join(root, DEPLOY_ROOT_CONFIG_PATH),
    `${JSON.stringify({ scanRoot: deployRoot })}\n`,
  );
}

/** Every file under the tree's config/limits-allowlist/, by name, with its bytes. */
function shardDirectorySnapshot(root) {
  const directory = join(root, "config/limits-allowlist");
  return Object.fromEntries(
    readdirSync(directory)
      .sort()
      .map((name) => [name, readFileSync(join(directory, name), "utf8")]),
  );
}

const DEPLOY_UNCONFIGURED =
  "config/limits-deploy.json is absent from this tree, so no deploy root is configured";
const EXPORT_SKIP_LINES = Object.freeze([
  `deploy shell mirror: skipped, ${DEPLOY_UNCONFIGURED}`,
  ".gitlab/ci/live-model-limits.generated.yml: skipped, its owner .gitlab-ci.yml is absent from this tree",
  ".gitlab/ci/wsl2-limits.generated.yml: skipped, its owner .gitlab-ci.yml is absent from this tree",
  ".gitlab/ci/nightly-limits.generated.yml: skipped, its owner .gitlab-ci.yml is absent from this tree",
  ".gitlab/ci/sast-limits.generated.yml: skipped, its owner .gitlab-ci.yml is absent from this tree",
  ".gitlab/ci/artifact-retention-limits.generated.yml: skipped, its owner .gitlab-ci.yml is absent from this tree",
  ".gitlab/ci/train-reuse/limits.generated.json: skipped, its owner .gitlab/ci/train-reuse/metadata.mjs is absent from this tree",
  ".gitlab/ci/runtime.yml limits projection: skipped, its owner .gitlab/ci/runtime.yml is absent from this tree",
  ".gitlab/ci/knowledge.yml limits projection: skipped, its owner .gitlab/ci/knowledge.yml is absent from this tree",
  ".gitlab/ci/public-export.yml limits projection: skipped, its owner .gitlab/ci/public-export.yml is absent from this tree",
  ".gitlab/ci/blueprint-compliance.yml limits projection: skipped, its owner .gitlab/ci/blueprint-compliance.yml is absent from this tree",
  ".gitlab-ci.yml limits projection: skipped, its owner .gitlab-ci.yml is absent from this tree",
  "packages/host/src literal scan: skipped, the scan root is absent from this tree",
  `deploy literal scan: skipped, ${DEPLOY_UNCONFIGURED}`,
]);
// The export's shape with the host allowlist shards kept, for cases about an
// absent root whose shard is still on disk.
const EXPORT_WITH_HOST_SHARDS = EXPORT_EXCLUDED.filter(
  (path) => path !== "config/limits-allowlist/host.*",
);

describe("check:limits in a tree without CI, deploy, or host owners", () => {
  it(
    "passes the export-shaped tree and names every mirror, projection, and scan root it skipped",
    SHIPPED_CLI_CASE,
    () => {
      const root = partialRepo();
      try {
        for (const left of [DEPLOY_ROOT_CONFIG_PATH, "config/limits-allowlist/host.json"]) {
          assert.equal(existsSync(join(root, left)), false, left);
        }
        assert.deepEqual(
          readdirSync(join(root, "config/limits-allowlist")).filter(
            (name) => name.startsWith("deploy.") || name.startsWith("host."),
          ),
          [],
        );
        const result = runLinkedCli(root, ["--check", "--gate"]);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(
          result.stdout,
          [
            ...EXPORT_SKIP_LINES,
            `Limits configuration is current (${loadLimitDefinitions().length} entries)`,
            "",
          ].join("\n"),
        );
        // Scoped runs name only their own skips; the runtime scope never
        // scans a deploy root.
        const runtime = runLinkedCli(root, ["--check", "--scope", "runtime"]);
        assert.equal(runtime.status, 0, runtime.stderr);
        assert.doesNotMatch(runtime.stdout, /deploy literal scan/u);
      } finally {
        removeLinkedRepo(root);
      }
    },
  );

  it("refuses --scope deploy when no deploy root is configured", SHIPPED_CLI_CASE, () => {
    const root = partialRepo();
    try {
      const result = runLinkedCli(root, ["--check", "--scope", "deploy"]);
      assert.equal(result.status, 1, result.stdout);
      assert.equal(
        result.stderr,
        "check:limits failed: --scope deploy needs a deploy root, and config/limits-deploy.json is absent from this tree; restore it, or check another scope\n",
      );
      // Adjacent: a configured but absent deploy root is skipped by name, not refused.
      configureDeployRoot(root, FIXTURE_DEPLOY_ROOT);
      const configured = runLinkedCli(root, ["--check", "--scope", "deploy"]);
      assert.equal(configured.status, 0, configured.stderr);
      assert.match(
        configured.stdout,
        /^deploy\/fixture-host literal scan: skipped, the scan root is absent from this tree$/mu,
      );
      assert.match(
        configured.stdout,
        /^deploy\/fixture-host\/limits\.generated\.sh: skipped, its owner deploy\/fixture-host is absent from this tree$/mu,
      );
    } finally {
      removeLinkedRepo(root);
    }
  });

  it(
    "still refuses a missing mirror and runs the projection check when the owner is present",
    SHIPPED_CLI_CASE,
    () => {
      const root = partialRepo();
      try {
        configureDeployRoot(root, FIXTURE_DEPLOY_ROOT);
        mkdirSync(join(root, FIXTURE_DEPLOY_ROOT), { recursive: true });
        writeFileSync(join(root, ".gitlab-ci.yml"), "include: []\n");
        const result = runLinkedCli(root, ["--check"]);
        assert.equal(result.status, 1, result.stdout);
        assert.equal(
          result.stderr,
          [
            "check:limits failed: deploy/fixture-host/limits.generated.sh drifted from config/limits.yaml; run npm run generate:limits",
            ".gitlab/ci/live-model-limits.generated.yml drifted from config/limits.yaml; run npm run generate:limits",
            ".gitlab/ci/wsl2-limits.generated.yml drifted from config/limits.yaml; run npm run generate:limits",
            ".gitlab/ci/nightly-limits.generated.yml drifted from config/limits.yaml; run npm run generate:limits",
            ".gitlab/ci/sast-limits.generated.yml drifted from config/limits.yaml; run npm run generate:limits",
            ".gitlab/ci/artifact-retention-limits.generated.yml drifted from config/limits.yaml; run npm run generate:limits",
            '.gitlab-ci.yml must include an active, uncommented "- local: .gitlab/ci/sast-limits.generated.yml" line; without it the generated SAST limits mirror never reaches the pipeline',
            '.gitlab-ci.yml must include an active, uncommented "- local: .gitlab/ci/artifact-retention-limits.generated.yml" line; without it the generated artifact retention mirror never reaches the pipeline',
            ".gitlab-ci.yml must include .gitlab/ci/wsl2-limits.generated.yml for the installed WSL2 job",
            "",
          ].join("\n"),
        );
        assert.doesNotMatch(result.stdout, /limits\.generated\.sh: skipped/u);
        assert.doesNotMatch(result.stdout, /deploy shell mirror: skipped/u);
        assert.doesNotMatch(result.stdout, /\.gitlab-ci\.yml limits projection: skipped/u);
      } finally {
        removeLinkedRepo(root);
      }
    },
  );

  it("refuses a stale mirror whose owner is present", SHIPPED_CLI_CASE, () => {
    const root = partialRepo();
    try {
      configureDeployRoot(root, FIXTURE_DEPLOY_ROOT);
      mkdirSync(join(root, FIXTURE_DEPLOY_ROOT), { recursive: true });
      writeFileSync(join(root, FIXTURE_DEPLOY_ROOT, "limits.generated.sh"), "stale\n");
      const result = runLinkedCli(root, ["--check"]);
      assert.equal(result.status, 1, result.stdout);
      assert.equal(
        result.stderr,
        "check:limits failed: deploy/fixture-host/limits.generated.sh drifted from config/limits.yaml; run npm run generate:limits\n",
      );
    } finally {
      removeLinkedRepo(root);
    }
  });

  it("refuses a missing shard whose scanned root is present", {
    ...SHIPPED_CLI_CASE,
    ...DEPLOY_ROOT_CASE,
  }, () => {
    const root = partialRepo({
      omit: EXPORT_EXCLUDED.filter((path) => path !== "deploy" && path !== DEPLOY_ROOT_CONFIG_PATH),
    });
    try {
      assert.equal(existsSync(join(root, DEPLOY_SHARD)), false);
      const result = runLinkedCli(root, ["--check", "--gate"]);
      assert.equal(result.status, 1, result.stdout);
      assert.equal(
        result.stderr,
        `check:limits failed: shard ${DEPLOY_SHARD}, which config/limits-deploy.json registers, is missing; restore it\n`,
      );
    } finally {
      removeLinkedRepo(root);
    }
  });

  it("refuses a deploy shard that no deploy configuration registers, and writing without one", {
    ...SHIPPED_CLI_CASE,
    ...DEPLOY_ROOT_CASE,
  }, () => {
    const root = partialRepo({ omit: [DEPLOY_ROOT_CONFIG_PATH] });
    try {
      const before = shardDirectorySnapshot(root);
      assert.ok(Object.hasOwn(before, DEPLOY_SHARD_FILE), DEPLOY_SHARD_FILE);
      const gate = runLinkedCli(root, ["--check", "--gate"]);
      assert.equal(gate.status, 1, gate.stdout);
      assert.equal(
        gate.stderr,
        `check:limits failed: ${DEPLOY_SHARD} is not registered: no config/limits-deploy.json declares its deploy root; restore that file or remove the shard\n`,
      );
      const written = runLinkedCli(root, ["--write-allowlist"]);
      assert.equal(written.status, 1, written.stdout);
      assert.equal(
        written.stderr,
        "check:limits failed: --write-allowlist needs the deploy root, and config/limits-deploy.json is absent from this tree; run it in the full repository\n",
      );
      assert.deepEqual(shardDirectorySnapshot(root), before);
      // Adjacent: a configuration naming another root is present, so the
      // refusal names that root instead of asking for the file.
      const otherRoot = `${DEPLOY_ROOT}x`;
      writeFileSync(
        join(root, DEPLOY_ROOT_CONFIG_PATH),
        `${JSON.stringify({ scanRoot: otherRoot })}\n`,
      );
      const misnamed = runLinkedCli(root, ["--check", "--gate"]);
      assert.equal(misnamed.status, 1, misnamed.stdout);
      assert.equal(
        misnamed.stderr,
        `check:limits failed: ${DEPLOY_SHARD} is not registered: config/limits-deploy.json declares deploy root ${otherRoot}, whose shard is ${shardFileForOwner(otherRoot)}; correct that root or remove the shard\n`,
      );
      // Adjacent: with the configuration restored, the same tree passes the gate.
      writeFileSync(
        join(root, DEPLOY_ROOT_CONFIG_PATH),
        readFileSync(join(repositoryRoot, DEPLOY_ROOT_CONFIG_PATH), "utf8"),
      );
      const restored = runLinkedCli(root, ["--check", "--gate"]);
      assert.equal(restored.status, 0, restored.stderr);
    } finally {
      removeLinkedRepo(root);
    }
  });

  it("refuses a stale literal under a present root while an absent root's literals are skipped", {
    ...SHIPPED_CLI_CASE,
    ...SHARD_SET_CASE,
  }, () => {
    const root = partialRepo({ omit: EXPORT_WITH_HOST_SHARDS });
    try {
      const remainder = readShard(root, "runtime.json");
      remainder.literals.push({
        path: "packages/runtime/src/stale-probe.ts",
        kind: "kib-product",
        lexeme: "7 * 1024",
        count: 1,
      });
      writeShard(root, "runtime.json", remainder);
      assert.ok(readShard(root, "host.json").literals.length > 0, "host shard is empty");
      const result = runLinkedCli(root, ["--check", "--gate"]);
      assert.equal(result.status, 1, result.stdout);
      assert.equal(
        result.stderr,
        [
          "check:limits failed: config/limits-allowlist/ has stale entries; shrink the shard named on each line:",
          "  packages/runtime/src/stale-probe.ts kib-product 7 * 1024 (config/limits-allowlist/runtime.json)",
          "",
        ].join("\n"),
      );
    } finally {
      removeLinkedRepo(root);
    }
  });

  it("refuses --write-allowlist when a scanned root is absent, leaving every shard untouched", {
    ...SHIPPED_CLI_CASE,
    ...SHARD_SET_CASE,
  }, () => {
    const root = partialRepo({ omit: EXPORT_WITH_HOST_SHARDS });
    try {
      const before = shardDirectorySnapshot(root);
      assert.ok(Object.hasOwn(before, "host.json"), "host.json");
      const result = runLinkedCli(root, ["--write-allowlist"]);
      assert.equal(result.status, 1, result.stdout);
      assert.equal(
        result.stderr,
        "check:limits failed: --write-allowlist needs every scanned root; absent from this tree: packages/host/src. Rewriting would empty their shards and drop their rationales; run it in the full repository\n",
      );
      assert.deepEqual(shardDirectorySnapshot(root), before);
    } finally {
      removeLinkedRepo(root);
    }
  });

  it("generates only the mirrors whose owner is present", SHIPPED_CLI_CASE, () => {
    const root = partialRepo({
      copied: [
        "config",
        "packages/runtime/scripts",
        "packages/runtime/src/config",
        "packages/knowledge/src",
        "docs/reference/status-and-configuration",
      ],
    });
    try {
      const result = runLinkedCli(root, []);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(
        result.stdout,
        [
          ...EXPORT_SKIP_LINES.slice(0, 7),
          `Updated limits mirrors: packages/runtime/src/config/limits.generated.ts, ${KNOWLEDGE_FIRST_PASS_GENERATED}, config/limits.json, config/limits.catalog.json, ${TABLE_PATHS.join(", ")}`,
          "",
        ].join("\n"),
      );
      assert.equal(existsSync(join(root, "deploy")), false);
      assert.equal(existsSync(join(root, ".gitlab")), false);
      assert.equal(
        readFileSync(join(root, "packages/runtime/src/config/limits.generated.ts"), "utf8"),
        readFileSync(generatedPath, "utf8"),
      );
    } finally {
      removeLinkedRepo(root);
    }
  });
});

describe("artifact retention checks at the shipped check:limits entry point", {
  ...SHIPPED_CLI_CASE,
  ...GITLAB_CI_CASE,
}, () => {
  const ciCopies = ["config", "packages/runtime/scripts", ".gitlab", ".gitlab-ci.yml"];
  const fullRepo = () => partialRepo({ omit: [], copied: ciCopies });

  it("passes the checked-in CI (positive control)", () => {
    const root = fullRepo();
    try {
      const result = runLinkedCli(root, ["--check", "--gate"]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(
        result.stdout,
        `Limits configuration is current (${loadLimitDefinitions().length} entries)\n`,
      );
    } finally {
      removeLinkedRepo(root);
    }
  });

  it("refuses a hand-declared expire_in: in runtime and public-export CI, a dropped anchor, and a commented-out include", () => {
    const root = fullRepo();
    try {
      const edit = (path, pattern, replacement) => {
        const before = readFileSync(join(root, path), "utf8");
        const after = before.replace(pattern, replacement);
        assert.notEqual(after, before, `mutant did not change ${path}`);
        writeFileSync(join(root, path), after);
        return after;
      };
      const runtimeYaml = edit(
        ".gitlab/ci/runtime.yml",
        /(runtime:package:verify:\n[\s\S]*?\n {2}artifacts:\n)/u,
        "$1    expire_in: 30 days\n",
      );
      const expireLine = runtimeYaml.split("\n").indexOf("    expire_in: 30 days") + 1;
      edit(
        ".gitlab/ci/knowledge.yml",
        /(documentation:freshness:\n[\s\S]*?)\n {4}- \.ci_report_artifacts/u,
        "$1",
      );
      const exportYaml = edit(
        ".gitlab/ci/public-export.yml",
        /(public-export:dry-run:\n[\s\S]*?\n {2}artifacts:\n)/u,
        "$1    expire_in: 90 days\n",
      );
      const exportExpireLine = exportYaml.split("\n").indexOf("    expire_in: 90 days") + 1;
      edit(
        ".gitlab-ci.yml",
        "  - local: .gitlab/ci/artifact-retention-limits.generated.yml\n",
        "  # - local: .gitlab/ci/artifact-retention-limits.generated.yml\n",
      );
      const result = runLinkedCli(root, ["--check", "--gate"]);
      assert.equal(result.status, 1, result.stdout);
      assert.equal(
        result.stderr,
        [
          `check:limits failed: .gitlab/ci/runtime.yml:${expireLine} must not declare expire_in:; extend a generated retention include instead`,
          ".gitlab/ci/knowledge.yml documentation:freshness must extend .ci_report_artifacts from the generated artifact retention include",
          `.gitlab/ci/public-export.yml:${exportExpireLine} must not declare expire_in:; extend a generated retention include instead`,
          '.gitlab-ci.yml must include an active, uncommented "- local: .gitlab/ci/artifact-retention-limits.generated.yml" line; without it the generated artifact retention mirror never reaches the pipeline',
          "",
        ].join("\n"),
      );
    } finally {
      removeLinkedRepo(root);
    }
  });
});

describe("check:limits --committed-only", () => {
  const TS_MIRROR = "packages/runtime/src/config/limits.generated.ts";
  const SKIPPED = (path) =>
    `${path}: not checked here, the build generates it (scripts/ensure-derived.mjs)`;
  // A full-repository-shaped tree: every owner present, the outputs under test
  // and the sealed registry copied so each can be staled on its own.
  const fullTree = () =>
    partialRepo({
      omit: [],
      copied: [
        "config",
        "packages/runtime/scripts",
        "packages/runtime/src/config",
        "packages/runtime/model-compositions",
        "packages/knowledge/src",
        "docs/reference/status-and-configuration",
        ".gitlab",
        DEPLOY_ROOT,
      ],
    });
  // Every committed output, the deploy and CI ones included, which the export lacks.
  const FULL_TREE_CASE = Object.freeze({
    ...SHIPPED_CLI_CASE,
    ...internalOnly(
      deployPaths(
        DEPLOY_ROOT,
        DEPLOY_MIRROR,
        ".gitlab-ci.yml",
        ".gitlab/ci/runtime.yml",
        ".gitlab/ci/train-reuse/metadata.mjs",
        ".gitlab/ci/train-reuse/limits.generated.json",
      ),
      "stales each committed deploy and CI limits output on its own",
    ),
  });
  // The copy's own checker, so its repository root is the copy.
  const copiedTool = (root) =>
    import(pathToFileURL(join(root, "packages/runtime/scripts/check-limits.mjs")).href);
  const committedOnly = { checkOnly: true, committedOnly: true, scope: "all" };
  const failuresOf = async (tool) => {
    try {
      await tool.runLimitsTool(committedOnly);
    } catch (error) {
      assert.ok(Array.isArray(error.failures), error.stack);
      return error.failures;
    }
    return [];
  };
  const drift = (path) => `${path} drifted from config/limits.yaml; run npm run generate:limits`;
  const editText = (root, path, edit) =>
    writeFileSync(join(root, path), edit(readFileSync(join(root, path), "utf8")));

  it(
    "checks every committed output, one stale output at a time, while the build-generated mirrors are skipped",
    FULL_TREE_CASE,
    async () => {
      const root = fullTree();
      try {
        rmSync(join(root, TS_MIRROR));
        const tool = await copiedTool(root);
        // Positive control: absent TS mirror, everything else current.
        const current = await tool.runLimitsTool(committedOnly);
        assert.equal(current.status, "checked");
        assert.ok(current.skipped.includes(SKIPPED(TS_MIRROR)), current.skipped.join("\n"));
        assert.ok(current.skipped.includes(SKIPPED(KNOWLEDGE_FIRST_PASS_GENERATED)));
        // Present but stale, as a developer's local leftover: still skipped.
        writeFileSync(join(root, TS_MIRROR), "stale\n");
        writeFileSync(join(root, KNOWLEDGE_FIRST_PASS_GENERATED), "stale\n");
        assert.deepEqual(await failuresOf(tool), []);
        // Adjacent: without --committed-only the same tree refuses both.
        await assert.rejects(
          tool.runLimitsTool({ checkOnly: true, scope: "all" }),
          (error) =>
            assert.deepEqual(error.failures.slice(0, 2), [
              drift(TS_MIRROR),
              drift(KNOWLEDGE_FIRST_PASS_GENERATED),
            ]) ?? true,
        );
        rmSync(join(root, TS_MIRROR));

        const deployMirror = deployShellMirrorPath(DEPLOY_ROOT);
        const cases = [
          ["config/limits.json", [drift("config/limits.json")]],
          ["config/limits.catalog.json", [drift("config/limits.catalog.json")]],
          [
            ".gitlab/ci/train-reuse/limits.generated.json",
            [drift(".gitlab/ci/train-reuse/limits.generated.json")],
          ],
          [deployMirror, [drift(deployMirror)]],
          [
            ".gitlab/ci/live-model-limits.generated.yml",
            [drift(".gitlab/ci/live-model-limits.generated.yml")],
          ],
          [
            ".gitlab/ci/nightly-limits.generated.yml",
            [drift(".gitlab/ci/nightly-limits.generated.yml")],
          ],
          [".gitlab/ci/sast-limits.generated.yml", [drift(".gitlab/ci/sast-limits.generated.yml")]],
          [
            ".gitlab/ci/artifact-retention-limits.generated.yml",
            [drift(".gitlab/ci/artifact-retention-limits.generated.yml")],
          ],
        ];
        for (const [path, expected] of cases) {
          const original = readFileSync(join(root, path), "utf8");
          writeFileSync(join(root, path), `${original}\n`);
          assert.deepEqual(
            { path, failures: await failuresOf(tool) },
            { path, failures: expected },
          );
          writeFileSync(join(root, path), original);
        }

        const ciFragment = "config/limits/ci.yaml";
        const ciOriginal = readFileSync(join(root, ciFragment), "utf8");
        const updatedSource = ciOriginal.replace(
          /(name: ci\.trainReuse\.apiPageSize\n\s+value: )100/u,
          "$1 99",
        );
        assert.notEqual(updatedSource, ciOriginal, "test source value was not found");
        writeFileSync(join(root, ciFragment), updatedSource);
        assert.ok(
          (await failuresOf(tool)).includes(drift(".gitlab/ci/train-reuse/limits.generated.json")),
          "the generated mirror accepted a changed canonical owner source",
        );
        writeFileSync(join(root, ciFragment), ciOriginal);

        // The docs region and the sealed entries are checked after the mirrors.
        const docTable = TABLE_PATHS[0];
        const docOriginal = readFileSync(join(root, docTable), "utf8");
        const marker = "{/* GENERATED:operational-limits-defaults end */}";
        assert.ok(docOriginal.includes(marker));
        editText(root, docTable, (text) => text.replace(marker, `| stale | row |\n${marker}`));
        assert.deepEqual(await failuresOf(tool), [
          `docs table drift: ${docTable} does not match the catalog; run npm run generate:limits`,
        ]);
        writeFileSync(join(root, docTable), docOriginal);

        const registry = "packages/runtime/model-compositions/composition-registry.json";
        const registryOriginal = readFileSync(join(root, registry), "utf8");
        const parsed = JSON.parse(registryOriginal);
        const ceiling = Math.max(
          ...parsed.compositions.map(
            (composition) => composition.compositionLimits.maxProviderTurns,
          ),
        );
        parsed.compositions[0].compositionLimits.maxProviderTurns = ceiling + 1;
        writeFileSync(join(root, registry), `${JSON.stringify(parsed, null, 2)}\n`);
        assert.deepEqual(await failuresOf(tool), [
          `sealed.compositionLimits.maxProviderTurns value ${ceiling} disagrees with sealed composition-registry ceiling ${ceiling + 1}`,
        ]);
        writeFileSync(join(root, registry), registryOriginal);

        assert.deepEqual(await failuresOf(tool), []);
      } finally {
        removeLinkedRepo(root);
      }
    },
  );

  it(
    "npm run check:limits reports a stale committed catalog before anything regenerates it",
    FULL_TREE_CASE,
    () => {
      const root = fullTree();
      try {
        rmSync(join(root, TS_MIRROR));
        const catalog = join(root, "config/limits.catalog.json");
        writeFileSync(catalog, `${readFileSync(catalog, "utf8")}\n`);
        const result = spawnSync("npm", ["run", "--silent", "check:limits"], {
          cwd: join(root, "packages/runtime"),
          encoding: "utf8",
        });
        assert.equal(result.status, 1, result.stdout);
        // The copy symlinks the scanned source roots, so the gate's literal
        // scan adds its own lines after the mirror comparison's.
        const lines = result.stderr.split("\n");
        assert.equal(lines[0], `check:limits failed: ${drift("config/limits.catalog.json")}`);
        assert.deepEqual(
          lines.filter((line) => line.includes("limits.generated.ts")),
          [],
          result.stderr,
        );
        assert.equal(existsSync(join(root, TS_MIRROR)), false, "check:limits generated the mirror");
      } finally {
        removeLinkedRepo(root);
      }
    },
  );

  it("parses --committed-only only as a narrowing of --check", () => {
    assert.equal(
      parseArgs(["--check", "--committed-only", "--gate", "--scope=host"]).committedOnly,
      true,
    );
    assert.equal(parseArgs(["--check"]).committedOnly, false);
    for (const [argv, message] of [
      [["--committed-only"], "--committed-only narrows --check and does not apply to generation"],
      [
        ["--committed-only", "--gate"],
        "--committed-only narrows --check and does not apply to generation",
      ],
      [
        ["--check", "--committed-only", "--print-mirror-paths"],
        "--committed-only narrows --check and does not combine with --print-mirror-paths",
      ],
      [
        ["--check", "--committed-only", "--check-host-file", "host.env"],
        "--committed-only narrows --check and does not combine with --check-host-file",
      ],
      [
        ["--check", "--committed-only", "--write-allowlist"],
        "--committed-only narrows --check and does not combine with --write-allowlist",
      ],
    ]) {
      assert.throws(() => parseArgs(argv), { message }, argv.join(" "));
    }
  });

  it("exports exactly the two untracked code mirrors, not the committed shell mirror of the same shape", () => {
    assert.deepEqual(BUILD_GENERATED_MIRRORS, [TS_MIRROR, KNOWLEDGE_FIRST_PASS_GENERATED]);
    assert.ok(
      Object.keys(renderMirrors(loadLimitDefinitions(), "deploy/fixture-host")).includes(
        "deploy/fixture-host/limits.generated.sh",
      ),
    );
  });
});

describe("writeBuildGeneratedMirrors", () => {
  it(
    "writes only the missing or stale build-generated mirrors and never a committed output",
    SHIPPED_CLI_CASE,
    async () => {
      const root = partialRepo({
        omit: [],
        copied: [
          "config",
          "packages/runtime/scripts",
          "packages/runtime/src/config",
          "packages/knowledge/src",
        ],
      });
      try {
        const tool = await import(
          pathToFileURL(join(root, "packages/runtime/scripts/check-limits.mjs")).href
        );
        const catalog = join(root, "config/limits.catalog.json");
        writeFileSync(catalog, "stale\n");
        rmSync(join(root, "packages/runtime/src/config/limits.generated.ts"));
        writeFileSync(join(root, KNOWLEDGE_FIRST_PASS_GENERATED), "stale\n");
        assert.deepEqual(tool.writeBuildGeneratedMirrors(), [...BUILD_GENERATED_MIRRORS]);
        const mirrors = renderMirrors(loadLimitDefinitions());
        for (const path of BUILD_GENERATED_MIRRORS) {
          assert.equal(readFileSync(join(root, path), "utf8"), mirrors[path], path);
        }
        assert.equal(readFileSync(catalog, "utf8"), "stale\n");
        // A second run writes nothing.
        assert.deepEqual(tool.writeBuildGeneratedMirrors(), []);
      } finally {
        removeLinkedRepo(root);
      }
    },
  );

  it(
    "skips the knowledge mirror when its owner package is absent, and still writes the runtime one",
    SHIPPED_CLI_CASE,
    async () => {
      const root = partialRepo({
        omit: [...EXPORT_EXCLUDED, "packages/knowledge"],
        copied: ["config", "packages/runtime/scripts", "packages/runtime/src/config"],
      });
      try {
        rmSync(join(root, "packages/runtime/src/config/limits.generated.ts"));
        const tool = await import(
          pathToFileURL(join(root, "packages/runtime/scripts/check-limits.mjs")).href
        );
        assert.deepEqual(tool.writeBuildGeneratedMirrors(), [
          "packages/runtime/src/config/limits.generated.ts",
        ]);
        assert.equal(existsSync(join(root, "packages/knowledge")), false);
      } finally {
        removeLinkedRepo(root);
      }
    },
  );
});

describe("the untracked limits code mirrors", () => {
  const git = (...args) => spawnSync("git", ["-C", repositoryRoot, ...args], { encoding: "utf8" });

  it("the limits product declares every file the generator lists, plus its doc tables directory", async () => {
    const { DERIVED_PRODUCT_BY_ID } = await import("./derived-products.mjs");
    const listed = (await runLimitsTool({ printMirrorPaths: true })).paths;
    assert.deepEqual(
      [...DERIVED_PRODUCT_BY_ID.limits.outputs].sort(),
      [...listed, `${TABLES_DIR}/**/*`].sort(),
    );
    assert.deepEqual(DERIVED_PRODUCT_BY_ID.limits.committedCheckArguments, [
      "--check",
      "--committed-only",
    ]);
  });

  it("git ignores exactly the two build-generated mirrors and still tracks every other limits output", () => {
    const outputs = Object.keys(renderMirrors(loadLimitDefinitions()));
    const ignored = git(
      "check-ignore",
      "--no-index",
      ...outputs,
      "packages/runtime/src/config/limits.generated.js",
    );
    assert.equal(ignored.error, undefined);
    assert.deepEqual(
      ignored.stdout.split("\n").filter(Boolean).sort(),
      [...BUILD_GENERATED_MIRRORS].sort(),
    );
    const tracked = git(
      "ls-files",
      "--",
      ...BUILD_GENERATED_MIRRORS,
      "packages/runtime/src/config/limits.generated.js",
      ...outputs.filter((path) => !BUILD_GENERATED_MIRRORS.includes(path)),
    );
    assert.equal(tracked.status, 0, tracked.stderr);
    const trackedPaths = tracked.stdout.split("\n").filter(Boolean).sort();
    // The authored re-export shares the suffix and stays tracked; so does every
    // committed output this tree has (the export has no deploy or CI tree).
    assert.ok(
      trackedPaths.includes("packages/runtime/src/config/limits.generated.js"),
      tracked.stdout,
    );
    assert.deepEqual(
      trackedPaths.filter((path) => BUILD_GENERATED_MIRRORS.includes(path)),
      [],
    );
    for (const path of outputs.filter((entry) => !BUILD_GENERATED_MIRRORS.includes(entry))) {
      if (existsSync(join(repositoryRoot, path))) assert.ok(trackedPaths.includes(path), path);
    }
  });

  it("no other *.generated.* file is ignored", () => {
    const generated = git("ls-files", "--", "*.generated.*");
    assert.equal(generated.status, 0, generated.stderr);
    const paths = generated.stdout.split("\n").filter(Boolean);
    assert.ok(paths.includes("packages/runtime/src/config/limits.generated.js"), generated.stdout);
    const ignored = git("check-ignore", "--no-index", ...paths);
    assert.equal(ignored.stdout, "", "a tracked *.generated.* file matches an ignore rule");
  });
});
