// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Candidate source documents are pinned by `check:pins` in a checkout, but the
 * installed CLI never reads them, so they stay out of the npm tarball while the
 * installed model-composition assets beside them still ship.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { parseNpmPackJson } from "../scripts/lib/packed-cli.mjs";
import { testTimeoutMs } from "./helpers/test-timeouts.js";

const execute = promisify(execFile);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// `npm pack` walks the full package tree; local budget in ms, raised in CI.
const localPackCaseMs = 30_000;

describe("model-composition sources packaging", () => {
  it(
    "packs every installed model-composition asset and no candidate source document",
    async () => {
      const cacheRoot = await mkdtemp(join(tmpdir(), "composition-sources-npm-cache-"));
      try {
        // --ignore-scripts keeps `prepack` from rebuilding dist/ under other suites.
        const packed = await execute("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
          cwd: projectRoot,
          env: { ...process.env, npm_config_cache: cacheRoot, npm_config_audit: "false" },
        });
        const [record] = parseNpmPackJson(packed.stdout) as [{ files: Array<{ path: string }> }];
        const packedPaths = record.files.map((file) => file.path);
        const manifest = JSON.parse(
          await readFile(
            resolve(projectRoot, "model-compositions/installed-manifest.json"),
            "utf8",
          ),
        ) as { assets: Array<{ path: string }> };

        expect(
          packedPaths.filter((path) => path.startsWith("model-compositions/sources/")),
        ).toEqual([]);
        expect(
          manifest.assets
            .map((asset) => `model-compositions/${asset.path}`)
            .filter((path) => !packedPaths.includes(path)),
        ).toEqual([]);
        expect(packedPaths).toContain("model-compositions/installed-manifest.json");
      } finally {
        await rm(cacheRoot, { recursive: true, force: true });
      }
    },
    testTimeoutMs(localPackCaseMs),
  );
});
