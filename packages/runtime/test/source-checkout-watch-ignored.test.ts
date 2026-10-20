// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readdirSync } from "node:fs";

import { cp, mkdir, utimes, writeFile } from "node:fs/promises";

import { dirname, join, resolve } from "node:path";

import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { shouldRefreshCompiledLauncher } from "../bin/source-checkout-refresh.mjs";

import { DERIVED_PRODUCT_BY_ID } from "../scripts/derived-products.mjs";

import { DEPLOY_ROOT_CONFIG_PATH } from "../scripts/limits-deploy-root.mjs";

import { temporaryRoots } from "./helpers/temp.js";

import { testTimeoutMs } from "./helpers/test-timeouts.js";

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const roots = temporaryRoots();

const FIXTURE_TEST_MS = 20_000;

// The products the build's derived-generation step regenerates; the
// model-comparison kit and its benchmark corpus are not among them.
const REGENERATED_PRODUCT_IDS = [
  "skill-crate",
  "quality-pack",
  "limits",
  "env-admission",
  "model-output",
];

const RECURSIVE = "/**/*";

const DEPLOY_ROOT_CONFIG = DEPLOY_ROOT_CONFIG_PATH;

// A valid deploy-root config naming a fixture host, not this checkout's host.
const DEPLOY_ROOT_FIXTURE = `${JSON.stringify({ scanRoot: "deploy/fixture-host" })}\n`;

// The hook modules a source checkout loads its watch list from.
const HOOK_MODULES = [
  "scripts/ensure-derived.mjs",
  "scripts/generate-derived.mjs",
  "scripts/derived-products.mjs",
  "scripts/limits-deploy-root.mjs",
  "src/config/private-content-paths.js",
  "src/skills/catalog-ids.js",
  "src/skills/catalog-ids.ts",
];

const OLD = new Date("2024-01-01T00:00:00Z");

const COMPILED = new Date("2025-01-01T00:00:00Z");

const NEWER = new Date("2025-01-01T00:00:01Z");

/** A package root under `<repository>/packages/runtime`, holding only `dist/`. */
async function makeRoot(): Promise<string> {
  const repository = await roots.create("docsfab-source-checkout-", { realpath: true });
  const root = join(repository, "packages", "runtime");
  await mkdir(join(root, "dist"), { recursive: true });
  return root;
}

async function makeSourceCheckout(input: {
  compiledNames: readonly string[];
  workflowNames: readonly string[];
}): Promise<string> {
  const root = await makeRoot();
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "scripts"), { recursive: true });
  await mkdir(join(root, "workflows"), { recursive: true });
  await mkdir(join(root, "dist", "workflow-registry"), { recursive: true });
  for (const path of HOOK_MODULES) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await cp(join(runtimeRoot, path), join(root, path));
  }
  await writeFile(join(root, "src", "launcher.ts"), "export {}\n");
  await writeFile(join(root, "scripts", "build-package.mjs"), "export {}\n");
  await cp(
    join(runtimeRoot, "scripts", "build-identity.mjs"),
    join(root, "scripts", "build-identity.mjs"),
  );
  await writeFile(join(root, "package.json"), `${JSON.stringify({ type: "module" })}\n`);
  await writeFile(join(root, "tsconfig.json"), "{}\n");
  await writeFile(join(root, "dist", "launcher.js"), "export {}\n");
  await writeCompiledManifest(root, input.compiledNames);
  for (const name of input.workflowNames) {
    await writeFile(join(root, "workflows", `${name}.json`), "{}\n");
  }
  return root;
}

async function writeCompiledManifest(root: string, names: readonly string[]) {
  await mkdir(join(root, "dist", "workflow-registry"), { recursive: true });
  await writeFile(
    join(root, "dist", "workflow-registry", "manifest.js"),
    `export const DECLARATIVE_WORKFLOW_NAMES = [\n${names
      .map((name) => `    "${name}",`)
      .join("\n")}\n];\n`,
  );
}

/**
 * A source checkout whose repository holds one file under every regenerated
 * product's inputs. Nothing is copied from this checkout's layout: the public
 * export omits the deploy-root config, so a host copy would make the fixture
 * differ by where the suite runs. `deployRootConfig: false` leaves it out, as
 * the export does.
 */
async function makeInputCheckout(
  options: { deployRootConfig?: boolean } = {},
): Promise<{ root: string; runtime: string }> {
  const runtime = await makeSourceCheckout({
    compiledNames: ["create-documentation"],
    workflowNames: ["create-documentation"],
  });
  const root = dirname(dirname(runtime));
  for (const id of REGENERATED_PRODUCT_IDS) {
    for (const input of DERIVED_PRODUCT_BY_ID[id].inputs as string[]) {
      const file = input.endsWith(RECURSIVE)
        ? join(root, input.slice(0, -RECURSIVE.length), "input.txt")
        : join(root, input);
      if (existsSync(file)) continue;
      if (input === DEPLOY_ROOT_CONFIG && options.deployRootConfig === false) continue;
      await mkdir(dirname(file), { recursive: true });
      // The deploy-root config is the one declared file parsed on load.
      await writeFile(file, input === DEPLOY_ROOT_CONFIG ? DEPLOY_ROOT_FIXTURE : "fixture\n");
    }
  }
  return { root, runtime };
}

async function setCompiledTime(runtime: string, time: Date) {
  for (const path of ["dist/launcher.js", "dist/workflow-registry/manifest.js"]) {
    await touch(join(runtime, path), time);
  }
}

async function touch(path: string, time: Date) {
  await utimes(path, time, time);
}

/** Every file and directory under `root`, except `dist/`, set to `time`. */
async function setTreeTime(root: string, time: Date) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === "dist" || entry.name === "node_modules") continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) await setTreeTime(path, time);
    await touch(path, time);
  }
  await touch(root, time);
}

describe("source-checkout launcher watch list", () => {
  it(
    "ignores independently authored corpus-shaped paths and Python bytecode caches but not a quality check source",
    async () => {
      const { root, runtime } = await makeInputCheckout();
      const corpus = join(root, "task.json");
      const bytecode = join(root, "packages/quality/checks/__pycache__/check.cpython-312.pyc");
      const check = join(root, "packages/quality/checks/check.py");
      for (const path of [corpus, bytecode, check]) {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, "fixture\n");
      }
      await setTreeTime(root, OLD);
      await setCompiledTime(runtime, COMPILED);

      await touch(corpus, NEWER);
      await touch(bytecode, NEWER);
      // A new bytecode file also changes its own directory's time.
      await touch(dirname(bytecode), NEWER);
      expect(await shouldRefreshCompiledLauncher(runtime, {})).toBe(false);

      await touch(check, NEWER);
      expect(await shouldRefreshCompiledLauncher(runtime, {})).toBe(true);
    },
    testTimeoutMs(FIXTURE_TEST_MS),
  );
});
