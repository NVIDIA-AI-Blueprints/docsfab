// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadLimitDefinitions } from "./check-limits.mjs";
import { internalOnly } from "./internal-path.test-helper.mjs";

const testApi = process.env.VITEST ? await import("vitest") : await import("node:test");
const { describe, it } = testApi;

// A whole-repository scan outlasts the local per-test default on a loaded host.
const REPOSITORY_SCAN_CASE = Object.freeze({
  timeout: loadLimitDefinitions().find((entry) => entry.name === "test.ciTimeoutMs").value,
});

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDir, "../../..");
const checker = join(scriptDir, "check-package-imports.mjs");
// The root path CI jobs and scripts/test still call; absent from the public export.
const rootShim = join(repositoryRoot, "scripts/check-package-imports.mjs");
const VIOLATION_REPORT =
  "Forbidden cross-package imports:\n- packages/runtime/scripts/violation.mjs imports ../../host/src/x.ts → packages/host/src/x.ts (packages/host/)\n";

function run(script, args = []) {
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8", cwd: tmpdir() });
}

/** A repository root holding a copy of the checker. */
function fixtureRepo() {
  const root = mkdtempSync(join(tmpdir(), "docsfab-package-imports-"));
  mkdirSync(join(root, "packages/runtime/scripts"), { recursive: true });
  copyFileSync(checker, join(root, "packages/runtime/scripts/check-package-imports.mjs"));
  return root;
}

function writeForbiddenImport(root, path, components) {
  const filePath = join(root, path);
  mkdirSync(dirname(filePath), { recursive: true });
  // Assembled so this file's own text holds no import the scan would read.
  writeFileSync(filePath, `import "${components.join("/")}";\n`);
}

/** A repository root with one forbidden runtime→host source import. */
function violatingRepo() {
  const root = fixtureRepo();
  writeForbiddenImport(root, "packages/runtime/scripts/violation.mjs", [
    "..",
    "..",
    "host",
    "src",
    "x.ts",
  ]);
  return root;
}

describe("check-package-imports in packages/runtime/scripts", () => {
  it("scans the repository root by default, not the directory it lives in", () => {
    const root = violatingRepo();
    try {
      const result = run(join(root, "packages/runtime/scripts/check-package-imports.mjs"));
      assert.equal(result.status, 1, result.stdout);
      assert.equal(result.stderr, VIOLATION_REPORT);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("passes this repository", REPOSITORY_SCAN_CASE, () => {
    const result = run(checker);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^Verified package façade imports \(\d+ importer trees\)\.\n$/u);
  });

  it("excludes generated dist staging imports while still rejecting real source imports", () => {
    const root = fixtureRepo();
    try {
      writeForbiddenImport(
        root,
        `packages/runtime/dist.staging-${process.pid}/host-invoker/index.js`,
        ["..", "..", "..", "host", "src", "x.ts"],
      );
      const stagingOnly = run(checker, ["--root", root]);
      assert.equal(stagingOnly.status, 0, stagingOnly.stderr);
      assert.match(stagingOnly.stdout, /^Verified package façade imports/u);

      writeForbiddenImport(root, "packages/runtime/scripts/violation.mjs", [
        "..",
        "..",
        "host",
        "src",
        "x.ts",
      ]);
      const realSource = run(checker, ["--root", root]);
      assert.equal(realSource.status, 1, realSource.stdout);
      assert.equal(realSource.stderr, VIOLATION_REPORT);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("runs as a CLI when invoked through a symlink", () => {
    const root = violatingRepo();
    const dir = mkdtempSync(join(tmpdir(), "docsfab-package-imports-link-"));
    try {
      const link = join(dir, "check-package-imports-link.mjs");
      symlinkSync(checker, link);
      const result = run(link, ["--root", root]);
      assert.equal(result.status, 1, result.stdout);
      assert.equal(result.stderr, VIOLATION_REPORT);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe(
  "root check-package-imports path",
  internalOnly("scripts/check-package-imports.mjs", "runs the root path CI jobs still call"),
  () => {
    it(
      "runs the moved checker with its arguments, directly and through a symlink",
      REPOSITORY_SCAN_CASE,
      () => {
        const root = violatingRepo();
        const dir = mkdtempSync(join(tmpdir(), "docsfab-package-imports-shim-"));
        try {
          const link = join(dir, "check-package-imports-shim-link.mjs");
          symlinkSync(rootShim, link);
          for (const script of [rootShim, link]) {
            const result = run(script, ["--root", root]);
            assert.equal(result.status, 1, `${script}: ${result.stdout}`);
            assert.equal(result.stderr, VIOLATION_REPORT);
          }
          const clean = run(rootShim);
          assert.equal(clean.status, 0, clean.stderr);
          assert.match(clean.stdout, /^Verified package façade imports/u);
        } finally {
          rmSync(dir, { recursive: true, force: true });
          rmSync(root, { recursive: true, force: true });
        }
      },
    );

    it("re-exports the checker without running it on import", async () => {
      const before = process.exitCode;
      const shim = await import(rootShim);
      const moved = await import(checker);
      assert.equal(shim.findPackageImportViolations, moved.findPackageImportViolations);
      assert.equal(process.exitCode, before);
    });
  },
);
