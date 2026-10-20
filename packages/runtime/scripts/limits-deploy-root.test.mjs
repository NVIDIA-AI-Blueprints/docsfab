// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEPLOY_ROOT_CONFIG_PATH,
  deployShellMirrorPath,
  loadDeployRoot,
  parseDeployRootConfig,
} from "./limits-deploy-root.mjs";

// Runnable with `node --test` and collectable by Vitest.
const { describe, it } = process.env.VITEST ? await import("vitest") : await import("node:test");

function withRoot(run) {
  const root = mkdtempSync(join(tmpdir(), "docsfab-deploy-root-"));
  mkdirSync(join(root, "config"));
  try {
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("deploy scan root configuration", () => {
  it("reads the configured root and names its shell mirror (positive control)", () => {
    withRoot((root) => {
      writeFileSync(
        join(root, DEPLOY_ROOT_CONFIG_PATH),
        `${JSON.stringify({ scanRoot: "deploy/example-host" })}\n`,
      );
      assert.equal(loadDeployRoot(root), "deploy/example-host");
      assert.equal(
        deployShellMirrorPath("deploy/example-host"),
        "deploy/example-host/limits.generated.sh",
      );
    });
  });

  it("has no deploy root when the file is absent, as in the public export", () => {
    withRoot((root) => assert.equal(loadDeployRoot(root), null));
  });

  it("refuses a present file it cannot read or parse instead of reading it as absent", () => {
    withRoot((root) => {
      // Adjacent to absent: a directory at the path is present and unreadable.
      mkdirSync(join(root, DEPLOY_ROOT_CONFIG_PATH));
      assert.throws(() => loadDeployRoot(root), /EISDIR/u);
    });
    withRoot((root) => {
      writeFileSync(join(root, DEPLOY_ROOT_CONFIG_PATH), "{ scanRoot: deploy/x }\n");
      assert.throws(
        () => loadDeployRoot(root),
        /^Error: config\/limits-deploy\.json is not valid JSON: /u,
      );
    });
  });

  it("refuses every shape but one plain directory under deploy/", () => {
    const shape =
      /^Error: config\/limits-deploy\.json scanRoot must be a directory under deploy\/ named by plain segments \(no '\.', no empty segment\); found /u;
    for (const scanRoot of [
      "deploy",
      "deploy/",
      "deploy//x",
      "deploy/x.y",
      "deploy/.x",
      "packages/runtime/src",
      "/deploy/x",
      "deploy/../x",
      7,
      null,
    ]) {
      assert.throws(() => parseDeployRootConfig({ scanRoot }), shape, String(scanRoot));
    }
    assert.throws(
      () => parseDeployRootConfig({}),
      /^Error: config\/limits-deploy\.json scanRoot must be .*; found undefined$/u,
    );
    assert.throws(
      () => parseDeployRootConfig({ scanRoot: "deploy/x", shellMirror: "x.sh" }),
      /^Error: config\/limits-deploy\.json may declare only scanRoot; found shellMirror$/u,
    );
    for (const document of [[], "deploy/x", null]) {
      assert.throws(
        () => parseDeployRootConfig(document),
        /^Error: config\/limits-deploy\.json must be an object declaring scanRoot$/u,
      );
    }
    // Adjacent: a nested plain directory under deploy/ is accepted.
    assert.equal(parseDeployRootConfig({ scanRoot: "deploy/site/host-1" }), "deploy/site/host-1");
  });
});
