// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { replaceDirectoryAfterBuild } from "../scripts/lib/staged-output.mjs";
import { temporaryRoots } from "./helpers/temp.js";

const roots = temporaryRoots();

describe("staged package build output", () => {
  it("leaves no dist/launcher.js when the first build fails after emitting it", async () => {
    const root = await roots.create("docsfab-staged-output-");
    const target = join(root, "dist");

    await expect(
      replaceDirectoryAfterBuild(target, async (staging) => {
        await mkdir(staging, { recursive: true });
        await writeFile(join(staging, "launcher.js"), "export {}\n");
        throw new Error("tsc reported type errors after emitting launcher.js.");
      }),
    ).rejects.toThrow("tsc reported type errors");

    expect(existsSync(join(target, "launcher.js"))).toBe(false);
    expect(await readdir(root)).toEqual([]);
  });

  it("keeps the previous complete dist/ when a rebuild fails", async () => {
    const root = await roots.create("docsfab-staged-output-");
    const target = join(root, "dist");
    await mkdir(join(target, "operator"), { recursive: true });
    await writeFile(join(target, "launcher.js"), "old launcher\n");
    await writeFile(join(target, "operator", "display-sanitize.js"), "old module\n");

    await expect(
      replaceDirectoryAfterBuild(target, async (staging) => {
        await mkdir(staging, { recursive: true });
        await writeFile(join(staging, "launcher.js"), "new launcher\n");
        throw new Error("Copying JS-only modules failed after tsc emitted.");
      }),
    ).rejects.toThrow("Copying JS-only modules failed");

    expect(await readFile(join(target, "launcher.js"), "utf8")).toBe("old launcher\n");
    expect(await readFile(join(target, "operator", "display-sanitize.js"), "utf8")).toBe(
      "old module\n",
    );
    expect(await readdir(root)).toEqual(["dist"]);
  });

  it("restores the previous dist/ when swapping the staged build in fails", async () => {
    const root = await roots.create("docsfab-staged-output-");
    const target = join(root, "dist");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "launcher.js"), "old launcher\n");

    await expect(
      replaceDirectoryAfterBuild(
        target,
        async (staging) => {
          await mkdir(staging, { recursive: true });
          await writeFile(join(staging, "launcher.js"), "new launcher\n");
        },
        {
          rename: async (from, to) => {
            if (from.includes(".staging-")) {
              throw Object.assign(new Error("Directory not empty during the swap."), {
                code: "ENOTEMPTY",
              });
            }
            await rename(from, to);
          },
        },
      ),
    ).rejects.toThrow("Directory not empty");

    expect(await readFile(join(target, "launcher.js"), "utf8")).toBe("old launcher\n");
    expect(await readdir(root)).toEqual(["dist"]);
  });

  it("replaces dist/ wholesale after a successful build", async () => {
    const root = await roots.create("docsfab-staged-output-");
    const target = join(root, "dist");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "removed-module.js"), "stale\n");

    await replaceDirectoryAfterBuild(target, async (staging) => {
      await mkdir(staging, { recursive: true });
      await writeFile(join(staging, "launcher.js"), "new launcher\n");
    });

    expect(await readdir(target)).toEqual(["launcher.js"]);
    expect(await readFile(join(target, "launcher.js"), "utf8")).toBe("new launcher\n");
    expect(await readdir(root)).toEqual(["dist"]);
  });
});
