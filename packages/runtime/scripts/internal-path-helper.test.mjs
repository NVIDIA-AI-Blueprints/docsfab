// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseYaml } from "yaml";

import {
  EXPORT_EXCLUDED,
  EXPORT_MANIFEST_INPUTS,
  holdsExportExcluded,
  internalOnly,
  isExportExcluded,
  loadExportExcluded,
} from "./internal-path.test-helper.mjs";

// Runnable with `node --test` and collectable by Vitest.
const { describe, it } = process.env.VITEST ? await import("vitest") : await import("node:test");

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const [MANIFEST, MANIFEST_PARSER] = EXPORT_MANIFEST_INPUTS;
const PIPELINE = ".gitlab-ci.yml";

async function withTree(entries, run) {
  const root = mkdtempSync(join(tmpdir(), "docsfab-internal-path-"));
  try {
    for (const [path, contents] of Object.entries(entries)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), contents);
    }
    return await run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function manifestText(exclude) {
  return [
    "schemaVersion: 1",
    "include:",
    "  - packages/runtime",
    "exclude:",
    ...exclude.map((entry) => `  - ${entry}`),
    "publicHosts:",
    "  - docs.nvidia.com",
    "usernames:",
    "  - someone",
    "names:",
    "  - Some One",
    "",
  ].join("\n");
}

/** The pipeline's top-level keys across its local includes, in include order. */
function loadPipeline() {
  const read = (path) => parseYaml(readFileSync(join(repositoryRoot, path), "utf8")) ?? {};
  const pipeline = read(PIPELINE);
  const keys = { ...pipeline };
  for (const entry of pipeline.include ?? []) {
    if (typeof entry.local === "string") Object.assign(keys, read(entry.local));
  }
  return keys;
}

/** The `rules` a job resolves to: its own, else the last parent in `extends` that has some. */
function resolvedRules(pipeline, name) {
  const job = pipeline[name];
  assert.ok(job, `the pipeline defines no ${name}`);
  if (job.rules) return job.rules;
  const parents = typeof job.extends === "string" ? [job.extends] : (job.extends ?? []);
  for (const parent of [...parents].reverse()) {
    const rules = resolvedRules(pipeline, parent);
    if (rules) return rules;
  }
  return undefined;
}

// Fixture entries for the matchers, so they hold in an exported tree too.
const ENTRIES = Object.freeze([
  "scripts",
  "docs/agents",
  "config/limits-allowlist/deploy.*",
  "packages/example/internal",
]);

describe("EXPORT_EXCLUDED", () => {
  it(
    "is this checkout's export manifest exclude list, which leaves out the manifest and its parser",
    internalOnly([MANIFEST, MANIFEST_PARSER], "reads the export manifest"),
    async () => {
      assert.deepEqual(EXPORT_EXCLUDED, await loadExportExcluded(repositoryRoot));
      assert.ok(Object.isFrozen(EXPORT_EXCLUDED));
      for (const input of EXPORT_MANIFEST_INPUTS) {
        assert.equal(isExportExcluded(input), true, input);
      }
    },
  );

  it(
    "reads the exclude list, in order, from the manifest under the root",
    internalOnly(MANIFEST_PARSER, "parses with the export manifest parser"),
    async () => {
      const exclude = ["zeta", "alpha/*.json", "docs/agents"];
      const loaded = await withTree(
        { ".gitlab-ci.yml": "", [MANIFEST]: manifestText(exclude) },
        (root) => loadExportExcluded(root),
      );
      assert.deepEqual(loaded, exclude);
      assert.ok(Object.isFrozen(loaded));
    },
  );

  it("is empty in an exported tree, which holds neither the manifest nor the pipeline", async () => {
    const loaded = await withTree({ "packages/runtime/package.json": "{}" }, (root) =>
      loadExportExcluded(root),
    );
    assert.deepEqual(loaded, []);
    assert.ok(Object.isFrozen(loaded));
  });

  it(
    "refuses an internal tree without the manifest, naming the missing file",
    internalOnly(MANIFEST_PARSER, "parses with the export manifest parser"),
    async () => {
      await withTree({ ".gitlab-ci.yml": "" }, async (root) => {
        await assert.rejects(loadExportExcluded(root), {
          message: `public-export manifest not found: ${join(root, MANIFEST)}`,
        });
      });
    },
  );

  it(
    "refuses an invalid manifest rather than reading a partial list",
    internalOnly(MANIFEST_PARSER, "parses with the export manifest parser"),
    async () => {
      await withTree(
        {
          ".gitlab-ci.yml": "",
          [MANIFEST]: "schemaVersion: 1\nexclude:\n  - x\n",
        },
        async (root) => {
          await assert.rejects(loadExportExcluded(root), {
            message: `${join(root, MANIFEST)}: include must be a non-empty list`,
          });
        },
      );
    },
  );

  it(
    "triggers the runtime test jobs on an edit to the manifest or its parser alone",
    internalOnly(PIPELINE, "reads the GitLab pipeline"),
    () => {
      const pipeline = loadPipeline();
      const rules = resolvedRules(pipeline, "runtime:test");
      const changeRules = rules.filter((rule) => rule.changes !== undefined);
      assert.ok(
        changeRules.some((rule) => rule.if === '$CI_PIPELINE_SOURCE == "merge_request_event"'),
        "runtime:test has no merge-request changes rule",
      );
      for (const rule of changeRules) {
        for (const input of EXPORT_MANIFEST_INPUTS) {
          assert.ok(rule.changes.paths.includes(input), `${rule.if} does not list ${input}`);
        }
      }
    },
  );

  it("covers an excluded entry and every path beneath it, and nothing that only shares a prefix", () => {
    for (const path of ["scripts", "scripts/public-export/manifest.yaml", "docs/agents/x.md"]) {
      assert.equal(isExportExcluded(path, ENTRIES), true, path);
    }
    for (const path of ["scriptsx", "docs", "docs/agentsx", "packages/runtime/src/index.ts"]) {
      assert.equal(isExportExcluded(path, ENTRIES), false, path);
    }
  });

  it("matches `*` within one path segment only", () => {
    assert.equal(isExportExcluded("config/limits-allowlist/deploy.example.json", ENTRIES), true);
    assert.equal(isExportExcluded("config/limits-allowlist/runtime.json", ENTRIES), false);
    assert.equal(isExportExcluded("config/limits-allowlist/redeploy.json", ENTRIES), false);
    assert.equal(isExportExcluded("config/limits-allowlist/deploy.json.bak", ENTRIES), true);
    assert.equal(isExportExcluded("config/limits-allowlist", ENTRIES), false);
    assert.equal(isExportExcluded("a/b", ["a*b"]), false);
  });

  it("reports a directory holding an excluded entry strictly beneath it", () => {
    for (const path of ["docs", "config", "config/limits-allowlist", "packages"]) {
      assert.equal(holdsExportExcluded(path, ENTRIES), true, path);
    }
    // An excluded entry itself holds nothing further; a sibling holds nothing.
    for (const path of ["scripts", "docs/agents", "fern", "packages/runtime/src"]) {
      assert.equal(holdsExportExcluded(path, ENTRIES), false, path);
    }
  });
});

describe("internalOnly", () => {
  it("skips in an exported tree that lacks a declared path, naming it and the reason", async () => {
    await withTree({ "present.txt": "" }, (root) => {
      assert.deepEqual(internalOnly(["present.txt", "deploy/x.sh"], "reads the shard", root), {
        skip: "internal-only, skipped: deploy/x.sh absent from the exported tree; reads the shard",
      });
    });
  });

  it("runs in an exported tree that has every declared path", async () => {
    await withTree({ "deploy/x.sh": "" }, (root) => {
      assert.deepEqual(internalOnly("deploy/x.sh", "reads the shard", root), {
        skip: false,
      });
    });
  });

  it("runs, and so fails loudly, in the internal tree even when a declared path is missing", async () => {
    await withTree({ ".gitlab-ci.yml": "" }, (root) => {
      assert.deepEqual(internalOnly("deploy/x.sh", "reads the shard", root), {
        skip: false,
      });
    });
  });

  it("throws on a path that cannot be read for a reason other than absence", async () => {
    await withTree({ deploy: "a file where a directory belongs" }, (root) => {
      assert.throws(() => internalOnly("deploy/x.sh", "reads the shard", root), {
        code: "ENOTDIR",
      });
    });
  });

  it("refuses a path outside the repository, no path, and a blank reason", () => {
    for (const path of ["/etc/passwd", "../x", "a/../../x", ""]) {
      assert.throws(() => internalOnly(path, "why"), {
        message: `internalOnly path must be repository-relative: ${JSON.stringify(path)}.`,
      });
    }
    for (const [paths, reason] of [
      [[], "why"],
      ["a", " "],
    ]) {
      assert.throws(() => internalOnly(paths, reason), {
        message: "internalOnly needs at least one repository path and a reason.",
      });
    }
  });
});
