// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { PRIVATE_CONTENT_PATHS } from "../src/config/private-content-paths.js";
import { execFile, execFileSync, type ExecFileException } from "node:child_process";
import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { appendFile, cp, mkdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  compiledLauncherWatchPaths,
  compiledWorkflowCatalogMismatchesDisk,
  isSourceCheckout,
  readCompiledWorkflowNames,
  refreshCompiledLauncherIfStale,
  shouldRefreshCompiledLauncher,
} from "../bin/source-checkout-refresh.mjs";
import { CATALOG_SKILL_IDS, catalogSkillSourcePath } from "../src/skills/catalog-ids.js";
import { DERIVED_PRODUCT_BY_ID } from "../scripts/derived-products.mjs";
import { DEPLOY_ROOT_CONFIG_PATH } from "../scripts/limits-deploy-root.mjs";
import { copiedDerivedCheckout } from "./helpers/derived-checkout.js";
import { temporaryRoots } from "./helpers/temp.js";
import { nestedDeadlineMs, testTimeoutMs } from "./helpers/test-timeouts.js";
import {
  readBuildIdentity,
  renderBuildIdentityModule,
  renderReleaseIdentityModule,
} from "../scripts/build-identity.mjs";

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(runtimeRoot, "../..");
const roots = temporaryRoots();

// Local per-case budgets, declared through testTimeoutMs so CI never drops
// below its shared default: a copied checkout plus one regeneration and build,
// or a small fixture plus one launcher child.
const COPIED_CHECKOUT_TEST_MS = 60_000;
const FIXTURE_TEST_MS = 20_000;
const LAUNCHER_CHILD_MS = 15_000;
// Execution plumbing: room for a child's diagnostics, not a bound under test.
const CHILD_OUTPUT_BYTES = 16 * 1024 * 1024;

// The products the build's derived-generation step regenerates; the
// model-comparison kit and its benchmark corpus are not among them.
const REGENERATED_PRODUCT_IDS = [
  "skill-crate",
  "quality-pack",
  "limits",
  "env-admission",
  "model-output",
];
const PACKAGE_SOURCES = [
  "src",
  "workflows",
  "tsconfig.json",
  "package.json",
  "scripts/build-package.mjs",
  "scripts/build-identity.mjs",
];
const RECURSIVE = "/**/*";
const REBUILD_NOTICE =
  "DocsFab is rebuilding the compiled launcher, after regenerating any stale derived files, because this checkout is newer than dist/.";
const SKIP_NOTICE =
  "DocsFab is not rebuilding dist/ or regenerating derived files because DOCSFAB_SKIP_AUTO_BUILD=1, although this checkout is newer than dist/.";
const REGENERATED_PREFIX = "ensure-derived: regenerated stale derived outputs: ";
const LOAD_FAILURE_SKIP_PREFIX =
  "DocsFab is launching the existing dist/ without checking whether it is current, because DOCSFAB_SKIP_AUTO_BUILD=1 and scripts/ensure-derived.mjs could not load the derived-generation inputs: ";
const LOAD_FAILURE_REBUILD_PREFIX =
  "DocsFab is rebuilding the compiled launcher, after regenerating any stale derived files, because scripts/ensure-derived.mjs could not load the derived-generation inputs: ";
const DEPLOY_ROOT_CONFIG = DEPLOY_ROOT_CONFIG_PATH;
const MALFORMED_DEPLOY_ROOT = `Error: ${DEPLOY_ROOT_CONFIG} is not valid JSON: `;
// A valid deploy-root config naming a fixture host, not this checkout's host.
const DEPLOY_ROOT_FIXTURE = `${JSON.stringify({ scanRoot: "deploy/fixture-host" })}\n`;

// Inputs a contributor can leave malformed mid-edit; loading the watch list
// evaluates both.
const BROKEN_WATCH_LIST_INPUTS = [
  {
    path: DEPLOY_ROOT_CONFIG,
    content: "{ broken",
    failure: MALFORMED_DEPLOY_ROOT,
  },
  {
    path: "packages/runtime/src/skills/catalog-ids.js",
    content: "export const = ;\n",
    failure: "SyntaxError: ",
  },
];

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

const toPosix = (path: string) => path.split(sep).join("/");

/**
 * Repository-relative paths the launcher should read, derived here from the
 * product declarations rather than from the launcher's own list.
 */
function expectedWatchPaths(): string[] {
  const expected = new Set(PACKAGE_SOURCES.map((path) => `packages/runtime/${path}`));
  for (const id of REGENERATED_PRODUCT_IDS) {
    for (const input of DERIVED_PRODUCT_BY_ID[id].inputs as string[]) {
      const path = input.endsWith(RECURSIVE) ? input.slice(0, -RECURSIVE.length) : input;
      // Inputs inside a package source root are read with that root.
      const covered = PACKAGE_SOURCES.some((source) =>
        path.startsWith(`packages/runtime/${source}/`),
      );
      if (!covered) expected.add(path);
    }
  }
  return [...expected];
}

describe("source-checkout compiled launcher refresh", () => {
  it(
    "refreshes exact tag changes and dirty transitions once",
    async () => {
      const runtime = await makeSourceCheckout({
        compiledNames: ["create-documentation"],
        workflowNames: ["create-documentation"],
      });
      const repository = dirname(dirname(runtime));
      await writeFile(
        join(runtime, "package.json"),
        JSON.stringify({ type: "module", version: "0.0.1" }),
      );
      await writeFile(join(repository, ".gitignore"), "packages/runtime/dist/\n");
      const git = (args: string[]) =>
        execFileSync(
          "git",
          ["-c", "user.name=DocsFab Test", "-c", "user.email=docsfab@example.test", ...args],
          { cwd: repository, encoding: "utf8" },
        ).trim();
      git(["init", "--quiet"]);
      git(["add", "."]);
      git(["commit", "--quiet", "-m", "fixture"]);
      const stamp = async () => {
        const identity = await readBuildIdentity(repository, { version: "0.0.1", env: {} });
        writeFileSync(join(runtime, "dist/build-identity.js"), renderBuildIdentityModule(identity));
        writeFileSync(
          join(runtime, "dist/release-identity.js"),
          renderReleaseIdentityModule(identity),
        );
      };
      await stamp();
      await setTreeTime(repository, OLD);
      await setCompiledTime(runtime, new Date("2030-01-01T00:00:00Z"));
      expect(await shouldRefreshCompiledLauncher(runtime, {})).toBe(false);

      for (const tag of ["v0.0.1-rc.3", "v0.0.1"]) {
        git(["tag", tag]);
        expect(await shouldRefreshCompiledLauncher(runtime, {})).toBe(true);
        expect(await shouldRefreshCompiledLauncher(runtime, { DOCSFAB_SKIP_AUTO_BUILD: "1" })).toBe(
          false,
        );
        await stamp();
        expect(await shouldRefreshCompiledLauncher(runtime, {})).toBe(false);
      }
      await writeFile(join(runtime, "src/launcher.ts"), "dirty source\n");
      expect(await shouldRefreshCompiledLauncher(runtime, {})).toBe(true);
      await stamp();
      expect(await shouldRefreshCompiledLauncher(runtime, {})).toBe(false);
      git(["checkout", "--", "packages/runtime/src/launcher.ts"]);
      expect(await shouldRefreshCompiledLauncher(runtime, {})).toBe(true);
      await stamp();
      expect(await shouldRefreshCompiledLauncher(runtime, {})).toBe(false);
    },
    testTimeoutMs(FIXTURE_TEST_MS),
  );
  it("treats a packed install without src as not a source checkout", async () => {
    const root = await makeRoot();
    await writeFile(join(root, "dist", "launcher.js"), "export {}\n");
    expect(isSourceCheckout(root)).toBe(false);
    expect(await shouldRefreshCompiledLauncher(root, {})).toBe(false);
  });

  it("rebuilds when the compiled catalog names a different workflow set than disk", async () => {
    const root = await makeSourceCheckout({
      compiledNames: ["audit", "create-documentation"],
      workflowNames: ["create-documentation"],
    });
    expect(compiledWorkflowCatalogMismatchesDisk(root)).toBe(true);
    expect(await shouldRefreshCompiledLauncher(root, {})).toBe(true);
    expect(await shouldRefreshCompiledLauncher(root, { DOCSFAB_SKIP_AUTO_BUILD: "1" })).toBe(false);

    let built = 0;
    const notices: string[] = [];
    await refreshCompiledLauncherIfStale(root, {
      env: {},
      runBuild: () => {
        built += 1;
      },
      write: (line) => notices.push(line),
    });
    expect(built).toBe(1);
    expect(notices).toEqual([REBUILD_NOTICE, ""]);
  });

  it("ignores workflow.schema.json when comparing the compiled catalog to disk", async () => {
    const root = await makeSourceCheckout({
      compiledNames: ["create-documentation", "review-documentation"],
      workflowNames: ["create-documentation", "review-documentation"],
    });
    await writeFile(join(root, "workflows", "workflow.schema.json"), "{}\n");
    expect(compiledWorkflowCatalogMismatchesDisk(root)).toBe(false);
  });

  it("rebuilds when checkout sources are newer than dist/launcher.js", async () => {
    const root = await makeSourceCheckout({
      compiledNames: ["create-documentation"],
      workflowNames: ["create-documentation"],
    });
    const old = new Date("2024-01-01T00:00:00Z");
    const recent = new Date("2026-08-25T00:00:00Z");
    await utimes(join(root, "dist", "launcher.js"), old, old);
    await utimes(join(root, "src", "launcher.ts"), recent, recent);
    expect(await shouldRefreshCompiledLauncher(root, {})).toBe(true);
  });

  it("names npm ci and the build diagnostics when the rebuild fails", async () => {
    const root = await makeSourceCheckout({
      compiledNames: ["create-documentation"],
      workflowNames: ["create-documentation", "review-documentation"],
    });
    await writeFile(
      join(root, "scripts", "build-package.mjs"),
      'process.stderr.write("src/doctor.ts(563,7): error TS2353\\n");\nprocess.exitCode = 1;\n',
    );

    const rebuild = () => refreshCompiledLauncherIfStale(root, { env: {}, write: () => {} });

    await expect(rebuild()).rejects.toThrow(/dist\/ is unchanged/u);
    await expect(rebuild()).rejects.toThrow(/run npm --prefix packages\/runtime ci/u);
    await expect(rebuild()).rejects.toThrow(/src\/doctor\.ts\(563,7\): error TS2353/u);
  });

  it("does not rebuild a current source checkout or when skip is set", async () => {
    const root = await makeSourceCheckout({
      compiledNames: ["create-documentation"],
      workflowNames: ["create-documentation"],
    });
    await setTreeTime(dirname(dirname(root)), OLD);
    await setCompiledTime(root, COMPILED);
    expect(compiledWorkflowCatalogMismatchesDisk(root)).toBe(false);
    expect(await shouldRefreshCompiledLauncher(root, {})).toBe(false);
    expect(await shouldRefreshCompiledLauncher(root, { DOCSFAB_SKIP_AUTO_BUILD: "1" })).toBe(false);

    let built = 0;
    const notices: string[] = [];
    await refreshCompiledLauncherIfStale(root, {
      env: { DOCSFAB_SKIP_AUTO_BUILD: "1" },
      runBuild: () => {
        built += 1;
      },
      write: (line) => notices.push(line),
    });
    expect(built).toBe(0);
    // A current checkout under the opt-out has nothing to report.
    expect(notices).toEqual([]);
  });

  it("says so on stderr when the opt-out keeps a stale checkout from rebuilding and regenerating", async () => {
    const { root: repository, runtime: root } = await makeInputCheckout();
    await setTreeTime(repository, OLD);
    await setCompiledTime(root, COMPILED);
    await touch(join(repository, "config/limits/input.txt"), NEWER);

    let built = 0;
    const notices: string[] = [];
    await refreshCompiledLauncherIfStale(root, {
      env: { DOCSFAB_SKIP_AUTO_BUILD: "1" },
      runBuild: () => {
        built += 1;
      },
      write: (line) => notices.push(line),
    });

    expect(built).toBe(0);
    expect(notices).toEqual([SKIP_NOTICE]);
  });

  it(
    "under the opt-out, launches the existing dist/ with a note when the watch list cannot load",
    async () => {
      const { root: repository, runtime } = await makeInputCheckout();
      await writeFile(join(repository, DEPLOY_ROOT_CONFIG), "{ broken");
      await setTreeTime(repository, OLD);
      await setCompiledTime(runtime, COMPILED);

      let built = 0;
      const notices: string[] = [];
      await refreshCompiledLauncherIfStale(runtime, {
        env: { DOCSFAB_SKIP_AUTO_BUILD: "1" },
        runBuild: () => {
          built += 1;
        },
        write: (line) => notices.push(line),
      });

      expect(built).toBe(0);
      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatch(
        new RegExp(`^${escapeRegExp(LOAD_FAILURE_SKIP_PREFIX + MALFORMED_DEPLOY_ROOT)}`, "u"),
      );
      expect(await shouldRefreshCompiledLauncher(runtime, { DOCSFAB_SKIP_AUTO_BUILD: "1" })).toBe(
        false,
      );
    },
    testTimeoutMs(FIXTURE_TEST_MS),
  );

  it(
    "without the opt-out, treats a watch list that cannot load as stale and runs the build",
    async () => {
      const { root: repository, runtime } = await makeInputCheckout();
      await writeFile(join(repository, DEPLOY_ROOT_CONFIG), "{ broken");
      await setTreeTime(repository, OLD);
      await setCompiledTime(runtime, COMPILED);
      expect(await shouldRefreshCompiledLauncher(runtime, {})).toBe(true);

      let built = 0;
      const notices: string[] = [];
      await refreshCompiledLauncherIfStale(runtime, {
        env: {},
        runBuild: () => {
          built += 1;
        },
        write: (line) => notices.push(line),
      });

      expect(built).toBe(1);
      expect(notices).toHaveLength(2);
      expect(notices[0]).toMatch(
        new RegExp(`^${escapeRegExp(LOAD_FAILURE_REBUILD_PREFIX + MALFORMED_DEPLOY_ROOT)}`, "u"),
      );
      expect(notices[1]).toBe("");
    },
    testTimeoutMs(FIXTURE_TEST_MS),
  );

  it(
    "under the opt-out, still throws when the compiled catalog cannot be read, which is not a watch-list load",
    async () => {
      const root = await makeSourceCheckout({
        compiledNames: ["create-documentation"],
        workflowNames: ["create-documentation"],
      });
      const manifest = join(root, "dist", "workflow-registry", "manifest.js");
      await rm(manifest);
      await mkdir(manifest);

      const notices: string[] = [];
      await expect(
        refreshCompiledLauncherIfStale(root, {
          env: { DOCSFAB_SKIP_AUTO_BUILD: "1" },
          runBuild: () => {},
          write: (line) => notices.push(line),
        }),
      ).rejects.toThrow(/EISDIR/u);
      expect(notices).toEqual([]);
    },
    testTimeoutMs(FIXTURE_TEST_MS),
  );

  it("parses compiled declarative workflow names from the built manifest", () => {
    expect(
      readCompiledWorkflowNames(`
export const DECLARATIVE_WORKFLOW_NAMES = [
    "review-documentation",
    "create-documentation",
];
`),
    ).toEqual(["create-documentation", "review-documentation"]);
  });
});

describe("source-checkout launcher watch list", () => {
  it("watches the package sources and every input of the products the build regenerates", async () => {
    const watched = (await compiledLauncherWatchPaths(runtimeRoot)).map((path) =>
      toPosix(relative(repositoryRoot, path)),
    );

    const expected = expectedWatchPaths();
    expect(new Set(watched)).toEqual(new Set(expected));
    expect(watched).toHaveLength(expected.length);
    expect(watched).toEqual(expect.arrayContaining(["config/limits", "packages/skills"]));
    const internalRoot = PRIVATE_CONTENT_PATHS.qualityBenchmarkRuntime;
    if (internalRoot) {
      expect(watched.some((path) => path.startsWith(dirname(internalRoot)))).toBe(false);
    }
  });

  it(
    "refuses a declared input glob it cannot watch instead of watching a path that never exists",
    async () => {
      const root = await makeSourceCheckout({
        compiledNames: ["create-documentation"],
        workflowNames: ["create-documentation"],
      });
      await writeFile(
        join(root, "scripts", "ensure-derived.mjs"),
        'export const ENSURE_DERIVED_INPUTS = ["config/limits/**/*", "config/*.json"];\n',
      );

      await expect(compiledLauncherWatchPaths(root)).rejects.toThrow(
        'scripts/ensure-derived.mjs declares the input "config/*.json", which the source-checkout launcher cannot watch',
      );
    },
    testTimeoutMs(FIXTURE_TEST_MS),
  );

  it(
    "rebuilds when any one watched path is newer than dist/launcher.js, and not when it is equal",
    async () => {
      const { root, runtime } = await makeInputCheckout();

      for (const path of expectedWatchPaths()) {
        const leaf = firstFile(join(root, path));
        const label = toPosix(relative(root, leaf));
        await setTreeTime(root, OLD);
        await setCompiledTime(runtime, COMPILED);
        expect({ label, stale: await shouldRefreshCompiledLauncher(runtime, {}) }).toEqual({
          label,
          stale: false,
        });

        await touch(leaf, COMPILED);
        expect({ label, equal: await shouldRefreshCompiledLauncher(runtime, {}) }).toEqual({
          label,
          equal: false,
        });

        await touch(leaf, NEWER);
        expect({ label, newer: await shouldRefreshCompiledLauncher(runtime, {}) }).toEqual({
          label,
          newer: true,
        });
      }
    },
    testTimeoutMs(FIXTURE_TEST_MS),
  );

  it(
    "reads a checkout without the deploy-root config, as the public export ships, as current until a watched file is newer",
    async () => {
      const { root, runtime } = await makeInputCheckout({ deployRootConfig: false });
      expect(existsSync(join(root, DEPLOY_ROOT_CONFIG))).toBe(false);
      await setTreeTime(root, OLD);
      await setCompiledTime(runtime, COMPILED);
      expect(await shouldRefreshCompiledLauncher(runtime, {})).toBe(false);

      const notices: string[] = [];
      const optOut = {
        env: { DOCSFAB_SKIP_AUTO_BUILD: "1" },
        runBuild: () => {
          throw new Error("the opt-out must not build");
        },
        write: (line: string) => notices.push(line),
      };
      // The watch list loads, so the opt-out has no load failure to report.
      await refreshCompiledLauncherIfStale(runtime, optOut);
      expect(notices).toEqual([]);

      await touch(join(root, "config/limits/input.txt"), NEWER);
      expect(await shouldRefreshCompiledLauncher(runtime, {})).toBe(true);
      await refreshCompiledLauncherIfStale(runtime, optOut);
      expect(notices).toEqual([SKIP_NOTICE]);
    },
    testTimeoutMs(FIXTURE_TEST_MS),
  );
});

describe("source-checkout launcher refresh through the real build", () => {
  it(
    "regenerates stale limits and skill outputs, then rebuilds, and the checkout is current afterwards",
    async () => {
      const root = await copiedDerivedCheckout(roots, "docsfab-launcher-refresh-");
      const runtime = join(root, "packages/runtime");
      await writeStaleCompiledLauncher(runtime);

      const fragment = join(root, "config/limits/firstPass.yaml");
      const source = await readFile(fragment, "utf8");
      const changed = source
        .replace(
          "name: firstPass.evidenceExpansionModelTurns\n    value: 6\n",
          "name: firstPass.evidenceExpansionModelTurns\n    value: 7\n",
        )
        .replace("docValue: 6 rounds\n", "docValue: 7 rounds\n");
      expect(changed).not.toBe(source);
      await writeFile(fragment, changed);
      const id = CATALOG_SKILL_IDS[0]!;
      await appendFile(join(root, catalogSkillSourcePath(id)!), "\nA newer line.\n");
      const limitsMirror = join(runtime, "src/config/limits.generated.ts");
      const committedMirror = await readFile(limitsMirror, "utf8");

      const notices: string[] = [];
      await refreshCompiledLauncherIfStale(runtime, {
        env: {},
        write: (line) => notices.push(line),
      });

      expect(notices.slice(0, 2)).toEqual([REBUILD_NOTICE, ""]);
      const regenerated = notices.find((line) => line.startsWith(REGENERATED_PREFIX));
      expect(regenerated, notices.join("\n")).toBeDefined();
      const families = regenerated!
        .slice(REGENERATED_PREFIX.length)
        .split("; ")
        .map((group) => group.split(": ")[0]);
      expect(families).toEqual(["skill-crate", "quality-pack", "limits"]);
      expect(regenerated).toContain(`packages/runtime/skill-crate/${id}/SKILL.md`);
      expect(regenerated).toContain("packages/runtime/src/config/limits.generated.ts");
      expect(await readFile(limitsMirror, "utf8")).not.toBe(committedMirror);
      expect(await readFile(join(runtime, "dist/launcher.js"), "utf8")).toContain("launch");

      expect(await shouldRefreshCompiledLauncher(runtime, {})).toBe(false);
      const hook = await runNode(["scripts/ensure-derived.mjs"], runtime);
      expect({ code: hook.code, stderr: hook.stderr }).toEqual({ code: 0, stderr: "" });
    },
    testTimeoutMs(COPIED_CHECKOUT_TEST_MS),
  );
});

describe("bin/docsfab.mjs launch", () => {
  it(
    "launches a packed install that ships no src/ or scripts/",
    async () => {
      const root = await makeRoot();
      await copyLauncherBin(root);
      await writeLauncherStub(root, "packed launcher");
      expect(existsSync(join(root, "scripts"))).toBe(false);
      expect(existsSync(join(root, "src"))).toBe(false);

      const result = await runNode(["bin/docsfab.mjs"], root);

      expect(result).toEqual({ code: 0, stdout: "packed launcher\n", stderr: "" });
    },
    testTimeoutMs(FIXTURE_TEST_MS),
  );

  it(
    "through a linked bin, rebuilds for a newer generator input before it loads the compiled launcher, and reports what the build regenerated",
    async () => {
      const root = await makeSourceCheckout({
        compiledNames: ["create-documentation"],
        workflowNames: ["create-documentation"],
      });
      await copyLauncherBin(root);
      await writeLauncherStub(root, "stale launcher");
      const regenerated = `${REGENERATED_PREFIX}limits: packages/runtime/src/config/limits.generated.ts`;
      await writeFile(
        join(root, "scripts", "build-package.mjs"),
        `import { writeFileSync } from "node:fs";
writeFileSync(new URL("../dist/launcher.js", import.meta.url), ${JSON.stringify(launcherStub("rebuilt launcher"))});
process.stderr.write(${JSON.stringify(`${regenerated}\n`)});
`,
      );
      await setTreeTime(dirname(dirname(root)), OLD);
      await setCompiledTime(root, COMPILED);
      // A generator input outside the package's src/ and workflows/.
      await touch(join(root, "scripts", "derived-products.mjs"), NEWER);
      // npm links a global bin as a symlink in another directory.
      const linkDirectory = await roots.create("docsfab-linked-bin-", { realpath: true });
      const link = join(linkDirectory, "docsfab");
      await symlink(join(root, "bin", "docsfab.mjs"), link);

      const result = await runNode([link], linkDirectory);

      expect(result).toEqual({
        code: 0,
        stdout: "rebuilt launcher\n",
        stderr: `${REBUILD_NOTICE}\n\n${regenerated}\n`,
      });
    },
    testTimeoutMs(FIXTURE_TEST_MS),
  );
});

describe("bin/docsfab.mjs launch with a watch list that cannot load", () => {
  it(
    "under the opt-out, launches the existing dist/ with a note on a malformed deploy-root config",
    () => expectOptOutLaunchDespite(BROKEN_WATCH_LIST_INPUTS[0]!),
    testTimeoutMs(FIXTURE_TEST_MS),
  );

  it(
    "under the opt-out, launches the existing dist/ with a note on a syntax error in src/skills/catalog-ids.js",
    () => expectOptOutLaunchDespite(BROKEN_WATCH_LIST_INPUTS[1]!),
    testTimeoutMs(FIXTURE_TEST_MS),
  );

  it(
    "without the opt-out, runs the build and reports its failure through the rebuild refusal on a malformed deploy-root config",
    async () => {
      const [broken] = BROKEN_WATCH_LIST_INPUTS;
      const { runtime } = await brokenInputLaunchCheckout(broken!);
      const compiled = await readFile(join(runtime, "dist/launcher.js"), "utf8");

      const result = await runNode(["bin/docsfab.mjs"], runtime);

      expect(result.code).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toMatch(
        new RegExp(`^${escapeRegExp(LOAD_FAILURE_REBUILD_PREFIX + MALFORMED_DEPLOY_ROOT)}`, "u"),
      );
      expect(result.stderr).toContain(
        "DocsFab could not rebuild the compiled launcher, so dist/ is unchanged.",
      );
      // The build's own diagnostics name the malformed file.
      const detail = result.stderr.slice(result.stderr.indexOf("dist/ is unchanged"));
      expect(detail).toContain(`${DEPLOY_ROOT_CONFIG} is not valid JSON`);
      expect(existsSync(join(runtime, ".build-ran"))).toBe(true);
      expect(await readFile(join(runtime, "dist/launcher.js"), "utf8")).toBe(compiled);
    },
    testTimeoutMs(FIXTURE_TEST_MS),
  );
});

async function expectOptOutLaunchDespite(broken: (typeof BROKEN_WATCH_LIST_INPUTS)[number]) {
  const { runtime } = await brokenInputLaunchCheckout(broken);

  const result = await runNode(["bin/docsfab.mjs"], runtime, { DOCSFAB_SKIP_AUTO_BUILD: "1" });

  expect({ code: result.code, stdout: result.stdout }).toEqual({
    code: 0,
    stdout: "existing launcher\n",
  });
  const lines = result.stderr.split("\n").filter((line) => line !== "");
  expect(lines, result.stderr).toHaveLength(1);
  expect(lines[0]).toMatch(
    new RegExp(`^${escapeRegExp(LOAD_FAILURE_SKIP_PREFIX + broken.failure)}`, "u"),
  );
  expect(existsSync(join(runtime, ".build-ran"))).toBe(false);
}

/**
 * A current source checkout whose build loads the derived-generation step the
 * way scripts/build-package.mjs does, with one watched input left malformed.
 */
async function brokenInputLaunchCheckout(broken: {
  path: string;
  content: string;
}): Promise<{ root: string; runtime: string }> {
  const { root, runtime } = await makeInputCheckout();
  await copyLauncherBin(runtime);
  await writeLauncherStub(runtime, "existing launcher");
  await writeFile(
    join(runtime, "scripts", "build-package.mjs"),
    `import { writeFileSync } from "node:fs";
writeFileSync(new URL("../.build-ran", import.meta.url), "");
await import("./ensure-derived.mjs");
writeFileSync(new URL("../dist/launcher.js", import.meta.url), ${JSON.stringify(launcherStub("rebuilt launcher"))});
`,
  );
  await writeFile(join(root, broken.path), broken.content);
  // Every input predates dist/, so only the failed load can make it stale.
  await setTreeTime(root, OLD);
  await setCompiledTime(runtime, COMPILED);
  return { root, runtime };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

interface Completed {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runNode(
  args: readonly string[],
  cwd: string,
  extraEnvironment: NodeJS.ProcessEnv = {},
): Promise<Completed> {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  delete environment.DOCSFAB_SKIP_AUTO_BUILD;
  Object.assign(environment, extraEnvironment);
  return new Promise((resolveRun) => {
    execFile(
      process.execPath,
      args,
      {
        cwd,
        env: environment,
        timeout: nestedDeadlineMs(LAUNCHER_CHILD_MS, FIXTURE_TEST_MS),
        maxBuffer: CHILD_OUTPUT_BYTES,
        encoding: "utf8",
      },
      (error: ExecFileException | null, stdout: string, stderr: string) => {
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : null;
        resolveRun({ code, stdout, stderr });
      },
    );
  });
}

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

/** A compiled launcher and catalog that match the copied workflows but predate every source. */
async function writeStaleCompiledLauncher(runtime: string) {
  const names = readdirSync(join(runtime, "workflows"))
    .filter((name) => name.endsWith(".json") && name !== "workflow.schema.json")
    .map((name) => name.slice(0, -".json".length));
  await mkdir(join(runtime, "dist"), { recursive: true });
  await writeFile(join(runtime, "dist", "launcher.js"), "export {}\n");
  await writeCompiledManifest(runtime, names);
  await setCompiledTime(runtime, OLD);
}

async function copyLauncherBin(root: string) {
  await mkdir(join(root, "bin"), { recursive: true });
  for (const name of ["docsfab.mjs", "source-checkout-refresh.mjs"]) {
    await cp(join(runtimeRoot, "bin", name), join(root, "bin", name));
  }
}

function launcherStub(output: string): string {
  return `export async function launch() {\n  process.stdout.write(${JSON.stringify(`${output}\n`)});\n}\n`;
}

async function writeLauncherStub(root: string, output: string) {
  await mkdir(join(root, "dist", "operator"), { recursive: true });
  await writeFile(join(root, "dist", "launcher.js"), launcherStub(output));
  await writeFile(
    join(root, "dist", "operator", "error-envelope.js"),
    "export function reportOperatorFailure(error) { process.stderr.write(`${error}\\n`); }\nexport function wantsJsonFailureOutput() { return false; }\n",
  );
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

/** The path itself when it is a file, else the first file beneath it in name order. */
function firstFile(path: string): string {
  if (!statSync(path).isDirectory()) return path;
  const [first] = readdirSync(path).sort();
  if (first === undefined) throw new Error(`${path} holds no file`);
  return firstFile(join(path, first));
}
