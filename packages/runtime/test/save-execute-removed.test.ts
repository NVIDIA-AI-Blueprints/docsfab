// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";

import { mkdtemp } from "node:fs/promises";

import { tmpdir } from "node:os";

import { dirname, join, resolve } from "node:path";

import { fileURLToPath } from "node:url";

import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { parseNpmPackJson } from "../scripts/lib/packed-cli.mjs";

const execute = promisify(execFile);

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const NPM_PACK_TIMEOUT_MS = 30_000;

describe("save_execute.py removal (Task #1449, option B)", () => {
  it(
    "is absent from the packed npm tarball's file list",
    async () => {
      const cacheRoot = await mkdtemp(join(tmpdir(), "save-execute-removed-npm-cache-"));
      const packed = await execute("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
        cwd: projectRoot,
        env: {
          ...process.env,
          // Isolate the npm cache as packed-cli.test.ts does, so a parallel
          // `npm pack`/`npm install` elsewhere in the suite cannot race this one over
          // the shared user-level npm cache.
          npm_config_cache: cacheRoot,
          npm_config_audit: "false",
        },
      });
      const [record] = parseNpmPackJson(packed.stdout) as [{ files: Array<{ path: string }> }];
      expect(record.files.some((file) => file.path.endsWith("save_execute.py"))).toBe(false);
    },
    NPM_PACK_TIMEOUT_MS,
  );
});
