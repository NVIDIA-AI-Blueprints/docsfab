// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  readFile,
  readlink,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { expect, it } from "vitest";

import { copiedDerivedCheckout } from "./helpers/derived-checkout.js";
import { temporaryRoots } from "./helpers/temp.js";
import { nestedDeadlineMs, testTimeoutMs } from "./helpers/test-timeouts.js";
import type { TemporaryRoots } from "./helpers/temp.js";

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(runtimeRoot, "../..");
const roots = temporaryRoots();
const CHECKOUT_TEST_MS = 60_000;
const CHILD_MS = 45_000;
const run = promisify(execFile);

it(
  "copies independent derived checkouts for mutation, deletion, mode changes, and regeneration",
  async () => {
    const [a, b] = await Promise.all([copiedDerivedCheckout(roots), copiedDerivedCheckout(roots)]);
    const input = "config/limits/firstPass.yaml";
    const sourceInput = join(repositoryRoot, input);
    const inputA = join(a, input);
    const inputB = join(b, input);
    const original = await readFile(sourceInput, "utf8");
    const originalMode = (await stat(sourceInput)).mode & 0o777;

    expect(await readFile(inputA, "utf8")).toBe(original);
    expect(await readFile(inputB, "utf8")).toBe(original);
    expect((await stat(inputA)).ino).not.toBe((await stat(sourceInput)).ino);
    expect((await stat(inputB)).ino).not.toBe((await stat(sourceInput)).ino);
    expect((await stat(inputA)).ino).not.toBe((await stat(inputB)).ino);

    await appendFile(inputA, "\n# changed only in checkout A\n");
    await chmod(inputA, originalMode ^ 0o100);
    const deleted = "packages/runtime/README.md";
    await rm(join(a, deleted));

    expect(await readFile(sourceInput, "utf8")).toBe(original);
    expect(await readFile(inputB, "utf8")).toBe(original);
    expect((await stat(sourceInput)).mode & 0o777).toBe(originalMode);
    expect((await stat(inputB)).mode & 0o777).toBe(originalMode);
    expect(existsSync(join(repositoryRoot, deleted))).toBe(true);
    expect(existsSync(join(b, deleted))).toBe(true);
    expect(existsSync(join(a, ".git"))).toBe(false);
    expect(existsSync(join(a, "packages/runtime/test/ensure-derived.test.ts"))).toBe(false);
    expect((await lstat(join(a, "packages/runtime/node_modules"))).isSymbolicLink()).toBe(true);
    expect(await readlink(join(a, "packages/runtime/node_modules"))).toBe(
      join(runtimeRoot, "node_modules"),
    );

    const mirror = "packages/runtime/src/config/limits.generated.ts";
    const sourceMirror = await readFile(join(repositoryRoot, mirror), "utf8");
    await Promise.all([rm(join(a, mirror)), rm(join(b, mirror))]);
    const result = await run(process.execPath, ["scripts/ensure-derived.mjs"], {
      cwd: join(a, "packages/runtime"),
      timeout: nestedDeadlineMs(CHILD_MS, CHECKOUT_TEST_MS),
    });
    expect(result.stderr).toContain("ensure-derived: regenerated stale derived outputs:");
    expect(await readFile(join(a, mirror), "utf8")).toBe(sourceMirror);
    expect(existsSync(join(b, mirror))).toBe(false);
    expect(await readFile(join(repositoryRoot, mirror), "utf8")).toBe(sourceMirror);
  },
  testTimeoutMs(CHECKOUT_TEST_MS),
);

it(
  "waits for other copies to finish before reporting a failed copy",
  async () => {
    const root = await roots.create("docsfab-derived-copy-failure-", { realpath: true });
    await mkdir(join(root, "LICENSE"));
    const existingRoot: TemporaryRoots = { ...roots, create: async () => root };

    await expect(copiedDerivedCheckout(existingRoot)).rejects.toThrow();
    for (const path of ["packages/runtime/src", "packages/runtime/workflows"]) {
      expect((await readdir(join(root, path), { recursive: true })).sort()).toEqual(
        (await readdir(join(repositoryRoot, path), { recursive: true })).sort(),
      );
    }
    expect(await readFile(join(root, "packages/runtime/scripts/ensure-derived.mjs"), "utf8")).toBe(
      await readFile(join(repositoryRoot, "packages/runtime/scripts/ensure-derived.mjs"), "utf8"),
    );
    expect(existsSync(join(root, "packages/runtime/node_modules"))).toBe(false);
  },
  testTimeoutMs(CHECKOUT_TEST_MS),
);
