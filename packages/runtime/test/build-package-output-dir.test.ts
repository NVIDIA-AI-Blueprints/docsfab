// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `scripts/build-package.mjs --output-dir` builds into another package root.
 * The staged replace moves an existing output aside and deletes it, and the
 * build writes license files beside the output, so the option refuses any path
 * where either would touch an existing file. A successful isolated build is
 * exercised by `doctor-limits-built-cli.test.ts`.
 */
import { execFile } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { temporaryRoots } from "./helpers/temp.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";

const execFileAsync = promisify(execFile);
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const roots = temporaryRoots();
const USAGE = "Usage: node scripts/build-package.mjs [--output-dir";

async function runBuild(args: readonly string[]): Promise<{ exitCode: number; stderr: string }> {
  try {
    await execFileAsync(
      process.execPath,
      [join(projectRoot, "scripts", "build-package.mjs"), ...args],
      {
        cwd: projectRoot,
        env: { ...process.env, PI_OFFLINE: "1" },
      },
    );
    return { exitCode: 0, stderr: "" };
  } catch (error) {
    const failed = error as { code?: unknown; stderr?: string };
    if (typeof failed.code !== "number") throw error;
    return { exitCode: failed.code, stderr: failed.stderr ?? "" };
  }
}

describe("build-package --output-dir", () => {
  it("refuses an existing output directory and leaves its files in place", {
    timeout: testTimeoutMs(20_000),
  }, async () => {
    const root = await roots.create("docsfab-build-output-existing-");
    const existing = join(root, "dist");
    await mkdir(existing);
    await writeFile(join(existing, "keep.txt"), "operator file\n");

    const result = await runBuild(["--output-dir", existing]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(USAGE);
    expect(await readFile(join(existing, "keep.txt"), "utf8")).toBe("operator file\n");
  });

  it("refuses a parent that already holds a package license file and leaves it in place", {
    timeout: testTimeoutMs(60_000),
  }, async () => {
    for (const file of ["LICENSE", "LICENSE-CC-BY-4.0", "NOTICE"]) {
      const root = await roots.create("docsfab-build-output-license-");
      await writeFile(join(root, file), `sentinel ${file}\n`);

      const result = await runBuild(["--output-dir", join(root, "dist")]);

      expect(result.exitCode, file).toBe(1);
      expect(result.stderr, file).toContain(USAGE);
      expect(await readFile(join(root, file), "utf8"), file).toBe(`sentinel ${file}\n`);
      await expect(access(join(root, "dist")), file).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("refuses output paths that are relative, unnormalized, not named dist, or without a parent", {
    timeout: testTimeoutMs(40_000),
  }, async () => {
    const root = await roots.create("docsfab-build-output-shape-");
    await mkdir(join(root, "nested"));
    for (const args of [
      ["--output-dir", "dist"],
      // join() would normalize this path, so it is written out.
      ["--output-dir", `${root}/nested/../dist`],
      ["--output-dir", join(root, "build")],
      ["--output-dir", join(root, "missing", "dist")],
      ["--output-dir"],
      ["--output-dir", join(root, "dist"), "--output-dir", join(root, "dist")],
      ["--out", join(root, "dist")],
    ]) {
      const result = await runBuild(args);
      expect(result.exitCode, args.join(" ")).toBe(1);
      expect(result.stderr, args.join(" ")).toContain(USAGE);
    }
  });
});
