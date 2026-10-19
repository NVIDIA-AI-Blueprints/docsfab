// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type ChildProcess, type ExecFileException, execFile, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { appendFile, chmod, cp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { LIMIT_DEFINITION_BY_NAME } from "../src/config/limits.generated.js";
import { catalogSkillSourcePath, CATALOG_SKILL_IDS } from "../src/skills/catalog-ids.js";
import { DERIVED_PRODUCT_BY_ID } from "../scripts/derived-products.mjs";
import {
  ENSURE_DERIVED_INPUTS,
  ENSURE_DERIVED_LISTING_STEPS,
  ENSURE_DERIVED_LOCK_PATH,
  ENSURE_DERIVED_LOCK_POLL_INTERVAL_MS,
  ENSURE_DERIVED_STEPS,
  EnsureDerivedRefusal,
  ensureDerived,
  reclaimStoppedLock,
  releaseLock,
} from "../scripts/ensure-derived.mjs";
import { MACHINE_DERIVED_TARGETS } from "../scripts/generate-derived.mjs";
import { DEPLOY_ROOT_CONFIG_PATH } from "../scripts/limits-deploy-root.mjs";
import { copiedDerivedCheckout } from "./helpers/derived-checkout.js";
import { temporaryRoots } from "./helpers/temp.js";
import { TEST_TIMEOUT_LIMITS, nestedDeadlineMs, testTimeoutMs } from "./helpers/test-timeouts.js";

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(runtimeRoot, "../..");
const roots = temporaryRoots();

// Local per-case budgets, declared through testTimeoutMs so CI never drops
// below its shared default: a copied checkout plus a few generator, tsc, or
// Vitest children.
const COPIED_CHECKOUT_TEST_MS = 60_000;
const STUB_CHECKOUT_TEST_MS = 20_000;
// Each child gets most of its case budget so it fails with its own output first.
const COPIED_CHECKOUT_CHILD_MS = 45_000;
const LIVE_MODEL_CLEAN_CHECKOUT_TEST_MS =
  LIMIT_DEFINITION_BY_NAME[TEST_TIMEOUT_LIMITS.ciTest]!.value;
const STUB_CHECKOUT_CHILD_MS = 15_000;
// Execution plumbing: room for a child's diagnostics, not a bound under test.
const CHILD_OUTPUT_BYTES = 16 * 1024 * 1024;
// Execution plumbing: how often a test re-reads a fixture file it waits on.
const POLL_INTERVAL_MS = 50;

const LIMITS_MIRROR = "packages/runtime/src/config/limits.generated.ts";
const ACCEPTANCE_GENERATED_MIRRORS = [
  LIMITS_MIRROR,
  "packages/runtime/src/config/env-admission.generated.ts",
  "packages/runtime/src/contracts/model-output.generated.ts",
];
const LIVE_MODEL_OLD_DERIVED_STEPS = "limits";
const LIVE_MODEL_REQUIRED_DERIVED_STEPS = "limits,env-admission,model-output";
const LOCK_WAIT_FRAGMENT = "config/limits/derived.yaml";
// The catalogued wait bound, and the catalogue's floor a fixture lowers it to.
const LOCK_WAIT_MS = LIMIT_DEFINITION_BY_NAME["derived.lockWaitMs"]!.value;
const LOCK_WAIT_FLOOR_MS = LIMIT_DEFINITION_BY_NAME["derived.lockWaitMs"]!.min;
// A refusal at the bound lands within one poll of it; one more bound's worth
// absorbs a loaded host's timer overshoot, so a refusal at twice the bound or
// later fails.
const LOCK_WAIT_REFUSAL_SLACK_MS = LOCK_WAIT_FLOOR_MS;
const REGENERATED_PREFIX = "ensure-derived: regenerated stale derived outputs: ";
// The generating machine steps; the composition verifiers stay in check:pins.
const STEP_IDS = ["skill-crate", "quality-pack", "limits", "env-admission", "model-output"];
const ENV_ADMISSION_MIRRORS = [
  "packages/runtime/src/config/env-admission.generated.ts",
  "packages/runtime/scripts/offline-test-env.generated.mjs",
];

interface Completed {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function childEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  // A nested Vitest must not inherit this worker's pool identity.
  for (const key of Object.keys(environment)) {
    if (key.startsWith("VITEST")) delete environment[key];
  }
  environment.VITEST_MAX_WORKERS = "1";
  return environment;
}

function run(
  command: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
  extraEnvironment: NodeJS.ProcessEnv = {},
): Promise<Completed> {
  return new Promise((resolveRun) => {
    execFile(
      command,
      args,
      {
        cwd,
        env: { ...childEnvironment(), ...extraEnvironment },
        timeout: timeoutMs,
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

interface Started {
  readonly child: ChildProcess;
  readonly stderr: () => string;
  readonly exited: () => boolean;
  readonly done: Promise<Completed>;
}

function start(args: readonly string[], cwd: string): Started {
  const child = spawn(process.execPath, args, { cwd, env: childEnvironment() });
  let stdout = "";
  let stderr = "";
  let exited = false;
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const done = new Promise<Completed>((resolveDone) => {
    child.on("close", (code) => {
      exited = true;
      resolveDone({ code, stdout, stderr });
    });
  });
  return { child, stderr: () => stderr, exited: () => exited, done };
}

async function waitFor(description: string, condition: () => boolean, deadlineMs: number) {
  const deadline = Date.now() + deadlineMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
    await sleep(POLL_INTERVAL_MS);
  }
}

/** Repository-relative files and directories every hook step writes or rolls back. */
function outputEntries(root: string): string[] {
  const entries = new Set<string>();
  const add = (absolute: string) => {
    if (!existsSync(absolute)) return;
    entries.add(relative(root, absolute).split(sep).join("/"));
    if (!statSync(absolute).isDirectory()) return;
    for (const name of readdirSync(absolute)) add(join(absolute, name));
  };
  for (const id of STEP_IDS) {
    for (const pattern of DERIVED_PRODUCT_BY_ID[id].outputs as string[]) {
      add(resolve(root, pattern.replace(/\/\*\*\/\*$/u, "")));
    }
  }
  for (const target of MACHINE_DERIVED_TARGETS as string[]) {
    add(resolve(root, "packages/runtime", target));
  }
  return [...entries].sort();
}

/** Inode, change time, and directory listing: a rewrite with restored mtimes still changes ctime. */
function writeFingerprint(root: string, entries: readonly string[]): Record<string, string> {
  const fingerprint: Record<string, string> = {};
  for (const entry of entries) {
    const absolute = resolve(root, entry);
    if (!existsSync(absolute)) {
      fingerprint[entry] = "absent";
      continue;
    }
    const stat = statSync(absolute);
    const listing = stat.isDirectory() ? readdirSync(absolute).sort().join("|") : "";
    fingerprint[entry] = `${stat.ino}:${stat.ctimeMs}:${listing}`;
  }
  return fingerprint;
}

function entriesOf(root: string, ids: readonly string[]): string[] {
  return outputEntries(root).filter((entry) =>
    ids.some((id) =>
      (DERIVED_PRODUCT_BY_ID[id].outputs as string[]).some((pattern) => {
        const base = pattern.replace(/\/\*\*\/\*$/u, "");
        return entry === base || entry.startsWith(`${base}/`);
      }),
    ),
  );
}

const copiedCheckout = () => copiedDerivedCheckout(roots);

const STUB_OUTPUTS: Record<string, string> = {
  "skill-crate": "skill-crate/marker.txt",
  "quality-pack": "quality-pack/manifest.json",
  limits: "src/config/limits.generated.ts",
  "env-admission": "src/config/env-admission.generated.ts",
  "model-output": "src/contracts/model-output.generated.ts",
};

/** A second runtime-relative file a stub writes, for a step with two rolled-back outputs. */
const STUB_SECOND_OUTPUTS: Record<string, string> = {
  "env-admission": "scripts/offline-test-env.generated.mjs",
};

/** A file a stub writes outside its declared outputs; only its own listing names it. */
const stubExtraOutput = (id: string) => `packages/knowledge/src/${id}-extra.generated.mjs`;

/**
 * The copy of the real limits tool a stub `check-limits.mjs` re-exports, so a
 * waiting hook reads its lock-wait bound through the real catalog loader.
 */
const STUB_LIMITS_CATALOG = "check-limits-catalog.mjs";

/**
 * One stub generator per step. Flags under `fixture-state/` drive it: `<id>.stale`
 * fails its check, `<id>.hold` blocks generation until `release` exists,
 * `<id>.fail` writes and then fails, `<id>.sticky` leaves the check failing,
 * `<id>.extra` also writes an undeclared file, and `<id>.unlisted` fails
 * `--print-mirror-paths`. Every listing request is logged to `lists.log`.
 * It acts only when run, never when imported.
 */
function stubGenerator(id: string): string {
  const reexport =
    id === "limits" ? `export { loadLimitDefinitions } from "./${STUB_LIMITS_CATALOG}";\n` : "";
  return `${reexport}import { appendFileSync, existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
const runtime = join(dirname(fileURLToPath(import.meta.url)), "..");
const state = join(runtime, "fixture-state");
const flag = (name) => existsSync(join(state, ${JSON.stringify(id)} + "." + name));
const extra = join(runtime, "../..", ${JSON.stringify(stubExtraOutput(id))});
if (process.argv.includes("--print-mirror-paths")) {
  appendFileSync(join(state, "lists.log"), ${JSON.stringify(id)} + "\\n");
  if (flag("unlisted")) {
    console.error(${JSON.stringify(`${id} cannot list its mirrors`)});
    process.exit(1);
  }
  console.log(${JSON.stringify(`packages/runtime/${STUB_OUTPUTS[id]}\n${stubExtraOutput(id)}`)});
  process.exit(0);
}
if (process.argv.includes("--check")) {
  if (flag("stale")) {
    console.error(${JSON.stringify(`${id} is stale`)});
    process.exit(1);
  }
  process.exit(0);
}
appendFileSync(join(state, "runs.log"), ${JSON.stringify(id)} + "\\n");
while (flag("hold") && !existsSync(join(state, "release"))) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${POLL_INTERVAL_MS});
}
for (const path of ${JSON.stringify([STUB_OUTPUTS[id], STUB_SECOND_OUTPUTS[id]].filter(Boolean))}) {
  const output = join(runtime, path);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, ${JSON.stringify(`regenerated by ${id}\n`)});
}
if (flag("extra")) {
  mkdirSync(dirname(extra), { recursive: true });
  writeFileSync(extra, ${JSON.stringify(`extra from ${id}\n`)});
}
if (flag("fail")) {
  console.error(${JSON.stringify(`${id} generator failed`)});
  process.exit(1);
}
if (!flag("sticky")) rmSync(join(state, ${JSON.stringify(id)} + ".stale"), { force: true });
}
`;
}

/** The real coordinator and hook driving stub generators, for lock and failure cases. */
async function stubCheckout(): Promise<{ root: string; runtime: string; hook: string }> {
  const root = await roots.create("docsfab-ensure-derived-stub-", { realpath: true });
  const runtime = join(root, "packages/runtime");
  for (const path of [
    "scripts/ensure-derived.mjs",
    "scripts/generate-derived.mjs",
    "scripts/derived-products.mjs",
    "scripts/limits-deploy-root.mjs",
    "src/skills/catalog-ids.js",
    "src/skills/catalog-ids.ts",
    "src/config/private-content-paths.js",
  ]) {
    await cp(join(runtimeRoot, path), join(runtime, path));
  }
  // The real limits catalog and its loader, for the lock-wait bound.
  await cp(
    join(runtimeRoot, "scripts/check-limits.mjs"),
    join(runtime, "scripts", STUB_LIMITS_CATALOG),
  );
  for (const path of [
    "scripts/docs-limits-table.mjs",
    "scripts/limits-allowlist-shards.mjs",
    "src/config/limit-resolution.js",
  ]) {
    await cp(join(runtimeRoot, path), join(runtime, path));
  }
  for (const path of ["config/limits.yaml", "config/limits"]) {
    await cp(join(repositoryRoot, path), join(root, path), { recursive: true });
  }
  for (const step of ENSURE_DERIVED_STEPS as Array<{ id: string; script: string }>) {
    await writeFile(join(runtime, "scripts", step.script), stubGenerator(step.id));
    for (const path of [STUB_OUTPUTS[step.id]!, STUB_SECOND_OUTPUTS[step.id]].filter(Boolean)) {
      const output = join(runtime, path!);
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, `committed ${step.id}\n`);
    }
  }
  await mkdir(join(runtime, "fixture-state"));
  await mkdir(join(runtime, "node_modules"));
  return { root, runtime, hook: join(runtime, "scripts/ensure-derived.mjs") };
}

async function flagStub(runtime: string, id: string, ...names: string[]) {
  for (const name of names) await writeFile(join(runtime, "fixture-state", `${id}.${name}`), "");
}

function stubLog(runtime: string, name: string): string[] {
  const log = join(runtime, "fixture-state", name);
  return existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
}

const stubRuns = (runtime: string) => stubLog(runtime, "runs.log");

/** The `step: path, path` groups of the one regeneration line, parsed. */
function regeneratedPaths(stderr: string): Record<string, string[]> {
  const line = stderr.split("\n").find((entry) => entry.startsWith(REGENERATED_PREFIX));
  if (line === undefined) throw new Error(`no regeneration line in:\n${stderr}`);
  return Object.fromEntries(
    line
      .slice(REGENERATED_PREFIX.length)
      .split("; ")
      .map((group) => {
        const [step, paths] = group.split(": ");
        return [step!, paths!.split(", ")];
      }),
  );
}

function stoppedProcessPid(): Promise<number> {
  return new Promise((resolvePid, reject) => {
    const child = spawn(process.execPath, ["-e", ""]);
    child.on("error", reject);
    child.on("close", () => {
      if (child.pid === undefined) reject(new Error("the probe child has no pid"));
      else resolvePid(child.pid);
    });
  });
}

const copiedChildMs = nestedDeadlineMs(COPIED_CHECKOUT_CHILD_MS, COPIED_CHECKOUT_TEST_MS);
const stubChildMs = nestedDeadlineMs(STUB_CHECKOUT_CHILD_MS, STUB_CHECKOUT_TEST_MS);

describe("ensure-derived on a copied checkout", () => {
  it(
    "leaves a current checkout untouched across two runs and creates no lock",
    async () => {
      const root = await copiedCheckout();
      const runtime = join(root, "packages/runtime");
      const entries = outputEntries(root);
      expect(entries).toContain(LIMITS_MIRROR);
      expect(entries).toContain("packages/runtime/skill-crate/lock.json");
      const before = writeFingerprint(root, entries);

      for (let pass = 0; pass < 2; pass += 1) {
        const result = await run(
          process.execPath,
          ["scripts/ensure-derived.mjs"],
          runtime,
          copiedChildMs,
        );
        expect({ code: result.code, stderr: result.stderr }).toMatchObject({ code: 0 });
        expect(result.stderr).not.toContain("ensure-derived");
      }

      expect(writeFingerprint(root, entries)).toEqual(before);
      expect(existsSync(join(runtime, ".cache"))).toBe(false);
    },
    testTimeoutMs(COPIED_CHECKOUT_TEST_MS),
  );

  it(
    "regenerates a stale skill family and its dependent and leaves the other families untouched",
    async () => {
      const root = await copiedCheckout();
      const runtime = join(root, "packages/runtime");
      const id = CATALOG_SKILL_IDS[0]!;
      await appendFile(join(root, catalogSkillSourcePath(id)!), "\nA stale line.\n");
      const untouched = entriesOf(root, ["limits", "model-output"]);
      expect(untouched).toContain(LIMITS_MIRROR);
      const before = writeFingerprint(root, untouched);

      const result = await run(
        process.execPath,
        ["scripts/ensure-derived.mjs"],
        runtime,
        copiedChildMs,
      );

      expect({ code: result.code, stderr: result.stderr }).toMatchObject({ code: 0 });
      expect(result.stderr).toContain(
        `ensure-derived: regenerated stale derived outputs: skill-crate: packages/runtime/skill-crate/${id}/SKILL.md, packages/runtime/skill-crate/lock.json; quality-pack: packages/runtime/quality-pack/manifest.json`,
      );
      expect(writeFingerprint(root, untouched)).toEqual(before);
      for (const script of ["generate-catalog-crate.mjs", "generate-quality-pack.mjs"]) {
        const check = await run(
          process.execPath,
          [`scripts/${script}`, "--check"],
          runtime,
          copiedChildMs,
        );
        expect({ script, code: check.code, output: check.stdout + check.stderr }).toMatchObject({
          script,
          code: 0,
        });
      }
      expect(existsSync(join(runtime, ENSURE_DERIVED_LOCK_PATH))).toBe(false);
    },
    testTimeoutMs(COPIED_CHECKOUT_TEST_MS),
  );

  it(
    "regenerates quality-pack when it is the only stale family",
    async () => {
      const root = await copiedCheckout();
      const runtime = join(root, "packages/runtime");
      const checks = join(root, "packages/quality/checks");
      const source = readdirSync(checks).find((name) => name.endsWith(".py"))!;
      await appendFile(join(checks, source), "\n# a stale line\n");

      const result = await run(
        process.execPath,
        ["scripts/ensure-derived.mjs"],
        runtime,
        copiedChildMs,
      );

      expect({ code: result.code, stderr: result.stderr }).toMatchObject({ code: 0 });
      expect(result.stderr).toContain(
        `ensure-derived: regenerated stale derived outputs: quality-pack: packages/runtime/quality-pack/manifest.json, packages/runtime/quality/checks/${source}, packages/runtime/quality/lock.json`,
      );
      const check = await run(
        process.execPath,
        ["scripts/generate-quality-pack.mjs", "--check"],
        runtime,
        copiedChildMs,
      );
      expect({ code: check.code, output: check.stdout + check.stderr }).toMatchObject({ code: 0 });
    },
    testTimeoutMs(COPIED_CHECKOUT_TEST_MS),
  );

  it(
    "names every limits mirror a changed limit rewrites, the knowledge mirror included",
    async () => {
      const root = await copiedCheckout();
      const runtime = join(root, "packages/runtime");
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
      const knowledgeMirror = "packages/knowledge/src/first-pass-limits.generated.mjs";
      const committedKnowledge = await readFile(join(root, knowledgeMirror), "utf8");

      const result = await run(
        process.execPath,
        ["scripts/ensure-derived.mjs"],
        runtime,
        copiedChildMs,
      );

      expect({ code: result.code, stderr: result.stderr }).toMatchObject({ code: 0 });
      expect(await readFile(join(root, knowledgeMirror), "utf8")).not.toBe(committedKnowledge);
      expect(regeneratedPaths(result.stderr)).toEqual({
        limits: [
          "config/limits.catalog.json",
          "docs/reference/status-and-configuration/operational-limits-tables/first-pass-settings.md",
          knowledgeMirror,
          LIMITS_MIRROR,
        ],
      });
    },
    testTimeoutMs(COPIED_CHECKOUT_TEST_MS),
  );

  it(
    "build-package builds a current checkout without writes, then regenerates a missing mirror and a stale crate file byte for byte",
    async () => {
      const root = await copiedCheckout();
      const runtime = join(root, "packages/runtime");
      const entries = outputEntries(root);
      const before = writeFingerprint(root, entries);

      const current = await run(
        process.execPath,
        ["scripts/build-package.mjs"],
        runtime,
        copiedChildMs,
      );
      expect({ code: current.code, output: current.stderr }).toMatchObject({ code: 0 });
      expect(current.stderr).not.toContain("ensure-derived");
      expect(writeFingerprint(root, entries)).toEqual(before);
      expect(existsSync(join(runtime, "dist/launcher.js"))).toBe(true);

      const id = CATALOG_SKILL_IDS[0]!;
      const crateFile = join(runtime, "skill-crate", id, "SKILL.md");
      const committedCrate = await readFile(crateFile);
      // The source tree's mirror is the build's own generation: an independent one.
      const sourceMirror = await readFile(join(root, LIMITS_MIRROR));
      await rm(join(root, LIMITS_MIRROR));
      await appendFile(crateFile, "\nA stale line.\n");

      const stale = await run(
        process.execPath,
        ["scripts/build-package.mjs"],
        runtime,
        copiedChildMs,
      );

      expect({ code: stale.code, stderr: stale.stderr }).toMatchObject({ code: 0 });
      expect(stale.stderr).toContain(
        `skill-crate: packages/runtime/skill-crate/${id}/SKILL.md; limits: ${LIMITS_MIRROR} (added)`,
      );
      expect(await readFile(join(root, LIMITS_MIRROR))).toEqual(sourceMirror);
      expect(await readFile(crateFile)).toEqual(committedCrate);
    },
    testTimeoutMs(COPIED_CHECKOUT_TEST_MS),
  );

  it(
    "build-package and the Vitest config stop on a refusal, and any other hook error keeps its stack",
    async () => {
      const root = await copiedCheckout();
      const runtime = join(root, "packages/runtime");
      // Stale but compilable: only the hook's refusal can stop this build.
      await appendFile(
        join(runtime, "skill-crate", CATALOG_SKILL_IDS[0]!, "SKILL.md"),
        "\nA stale line.\n",
      );
      const lockPath = join(runtime, ENSURE_DERIVED_LOCK_PATH);
      await mkdir(dirname(lockPath), { recursive: true });
      await writeFile(lockPath, "not a record\n");
      const refusal = `ensure-derived: DERIVED_LOCK_UNREADABLE: ${lockPath} has no readable owner record.`;

      const refused = await run(
        process.execPath,
        ["scripts/build-package.mjs"],
        runtime,
        copiedChildMs,
      );
      expect({ code: refused.code, stderr: refused.stderr }).toMatchObject({ code: 1 });
      expect(refused.stderr).toContain(refusal);
      expect(refused.stderr).toContain("Build stopped; dist/ is unchanged.");
      expect(existsSync(join(runtime, "dist"))).toBe(false);

      await writeFile(
        join(runtime, "test/probe.test.ts"),
        `import { expect, it } from "vitest";
it("runs only after the shared generation step passes", () => {
  expect(true).toBe(true);
});
`,
      );
      const tests = await run(
        process.execPath,
        ["node_modules/vitest/vitest.mjs", "run", "test/probe.test.ts"],
        runtime,
        copiedChildMs,
      );
      expect(tests.code).not.toBe(0);
      expect(tests.code).not.toBeNull();
      expect(tests.stderr).toContain(refusal);
      expect(tests.stdout).not.toContain("1 passed");

      await rm(lockPath);
      await mkdir(lockPath);
      const crashed = await run(
        process.execPath,
        ["scripts/build-package.mjs"],
        runtime,
        copiedChildMs,
      );
      expect(crashed.code).not.toBe(0);
      expect(crashed.stderr).toContain("EISDIR");
      expect(crashed.stderr).not.toContain("Build stopped");
      expect(existsSync(join(runtime, "dist"))).toBe(false);
    },
    testTimeoutMs(COPIED_CHECKOUT_TEST_MS),
  );

  it(
    "the Vitest config restores a missing limits mirror before it loads the test timeouts",
    async () => {
      const root = await copiedCheckout();
      const runtime = join(root, "packages/runtime");
      await writeFile(
        join(runtime, "test/probe.test.ts"),
        `import { expect, it } from "vitest";
import { LIMIT_DEFINITION_BY_NAME } from "../src/config/limits.generated.js";
it("reads the regenerated mirror under Vitest", () => {
  expect(LIMIT_DEFINITION_BY_NAME["test.localTimeoutMs"]?.unit).toBe("ms");
});
`,
      );
      const sourceMirror = await readFile(join(root, LIMITS_MIRROR));
      await rm(join(root, LIMITS_MIRROR));

      const result = await run(
        process.execPath,
        ["node_modules/vitest/vitest.mjs", "run", "test/probe.test.ts"],
        runtime,
        copiedChildMs,
      );

      expect({ code: result.code, output: result.stdout + result.stderr }).toMatchObject({
        code: 0,
      });
      expect(result.stderr).toContain(`limits: ${LIMITS_MIRROR} (added)`);
      expect(result.stdout).toContain("1 passed");
      expect(await readFile(join(root, LIMITS_MIRROR))).toEqual(sourceMirror);
    },
    testTimeoutMs(COPIED_CHECKOUT_TEST_MS),
  );

  it(
    "the limits step regenerates both untracked mirrors when a checkout has neither, and a second run writes nothing",
    async () => {
      const root = await copiedCheckout();
      const runtime = join(root, "packages/runtime");
      const knowledgeMirror = "packages/knowledge/src/first-pass-limits.generated.mjs";
      // The source tree's mirrors are the build's own generation from the
      // same inputs: an independent generation to compare against.
      const expected = {
        [LIMITS_MIRROR]: await readFile(join(root, LIMITS_MIRROR)),
        [knowledgeMirror]: await readFile(join(root, knowledgeMirror)),
      };
      for (const path of Object.keys(expected)) await rm(join(root, path));

      const result = await run(
        process.execPath,
        ["scripts/ensure-derived.mjs", "--steps", "limits"],
        runtime,
        copiedChildMs,
      );

      expect({ code: result.code, stderr: result.stderr }).toMatchObject({ code: 0 });
      expect(regeneratedPaths(result.stderr)).toEqual({
        limits: [`${knowledgeMirror} (added)`, `${LIMITS_MIRROR} (added)`],
      });
      for (const [path, bytes] of Object.entries(expected)) {
        expect(await readFile(join(root, path))).toEqual(bytes);
      }
      const again = await run(
        process.execPath,
        ["scripts/ensure-derived.mjs", "--steps", "limits"],
        runtime,
        copiedChildMs,
      );
      expect({ code: again.code, stderr: again.stderr }).toEqual({ code: 0, stderr: "" });
    },
    testTimeoutMs(COPIED_CHECKOUT_TEST_MS),
  );

  it(
    "runtime typecheck restores a missing limits mirror before tsc runs",
    async () => {
      const root = await copiedCheckout();
      const runtime = join(root, "packages/runtime");
      const sourceMirror = await readFile(join(root, LIMITS_MIRROR));
      await rm(join(root, LIMITS_MIRROR));

      const result = await run("npm", ["run", "--silent", "typecheck"], runtime, copiedChildMs);

      expect({ code: result.code, output: result.stdout + result.stderr }).toMatchObject({
        code: 0,
      });
      expect(result.stderr).toContain(`limits: ${LIMITS_MIRROR} (added)`);
      expect(await readFile(join(root, LIMITS_MIRROR))).toEqual(sourceMirror);
    },
    testTimeoutMs(COPIED_CHECKOUT_TEST_MS),
  );

  it(
    "live-model acceptance import fails with limits-only preparation and passes with its full generated closure",
    async () => {
      const root = await copiedCheckout();
      const runtime = join(root, "packages/runtime");
      for (const mirror of ACCEPTANCE_GENERATED_MIRRORS) {
        await rm(join(root, mirror), { force: true });
      }

      const oldPreparation = await run(
        process.execPath,
        ["scripts/ensure-derived.mjs", "--steps", LIVE_MODEL_OLD_DERIVED_STEPS],
        runtime,
        nestedDeadlineMs(LIVE_MODEL_CLEAN_CHECKOUT_TEST_MS, LIVE_MODEL_CLEAN_CHECKOUT_TEST_MS),
      );
      expect({
        code: oldPreparation.code,
        output: oldPreparation.stdout + oldPreparation.stderr,
      }).toMatchObject({ code: 0 });
      const missingAfterOldPreparation = ACCEPTANCE_GENERATED_MIRRORS.filter(
        (mirror) => !existsSync(join(root, mirror)),
      );
      const rejectedImport = await run(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "--eval",
          "await import('./src/acceptance-cli.ts'); process.stdout.write('acceptance module loaded\\n');",
        ],
        runtime,
        nestedDeadlineMs(LIVE_MODEL_CLEAN_CHECKOUT_TEST_MS, LIVE_MODEL_CLEAN_CHECKOUT_TEST_MS),
      );
      expect(missingAfterOldPreparation).toEqual([
        "packages/runtime/src/config/env-admission.generated.ts",
        "packages/runtime/src/contracts/model-output.generated.ts",
      ]);
      expect(rejectedImport.code).not.toBe(0);
      expect(rejectedImport.stderr).toMatch(/env-admission\.generated/u);

      for (const mirror of ACCEPTANCE_GENERATED_MIRRORS) {
        await rm(join(root, mirror), { force: true });
      }
      const completePreparation = await run(
        process.execPath,
        ["scripts/ensure-derived.mjs", "--steps", LIVE_MODEL_REQUIRED_DERIVED_STEPS],
        runtime,
        nestedDeadlineMs(LIVE_MODEL_CLEAN_CHECKOUT_TEST_MS, LIVE_MODEL_CLEAN_CHECKOUT_TEST_MS),
      );
      expect({
        code: completePreparation.code,
        output: completePreparation.stdout + completePreparation.stderr,
      }).toMatchObject({ code: 0 });
      const missingBeforeImport = ACCEPTANCE_GENERATED_MIRRORS.filter(
        (mirror) => !existsSync(join(root, mirror)),
      );
      const imported = await run(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "--eval",
          "await import('./src/acceptance-cli.ts'); process.stdout.write('acceptance module loaded\\n');",
        ],
        runtime,
        nestedDeadlineMs(LIVE_MODEL_CLEAN_CHECKOUT_TEST_MS, LIVE_MODEL_CLEAN_CHECKOUT_TEST_MS),
      );
      expect({ missingBeforeImport, code: imported.code }).toEqual({
        missingBeforeImport: [],
        code: 0,
      });
      expect(imported.stdout).toContain("acceptance module loaded");
    },
    testTimeoutMs(LIVE_MODEL_CLEAN_CHECKOUT_TEST_MS),
  );

  it(
    "npm pack ships the same file list whether or not prepack runs the hook",
    async () => {
      const root = await copiedCheckout();
      const runtime = join(root, "packages/runtime");
      const entries = outputEntries(root);
      const before = writeFingerprint(root, entries);
      // Files the build itself writes; the hook must add nothing else.
      const built = (path: string) =>
        path.startsWith("dist/") || ["LICENSE", "LICENSE-CC-BY-4.0", "NOTICE"].includes(path);
      const packed = async (extra: string[]) => {
        const result = await run(
          "npm",
          ["pack", "--dry-run", "--json", ...extra],
          runtime,
          copiedChildMs,
          { npm_config_cache: join(root, "npm-cache") },
        );
        expect({ code: result.code, stderr: result.stderr }).toMatchObject({ code: 0 });
        const [manifest] = JSON.parse(result.stdout) as Array<{ files: Array<{ path: string }> }>;
        return manifest!.files.map((file) => file.path).sort();
      };

      const withoutHook = await packed(["--ignore-scripts"]);
      const withHook = await packed([]);

      expect(withHook.filter((path) => !built(path))).toEqual(
        withoutHook.filter((path) => !built(path)),
      );
      expect(withHook.some((path) => path.startsWith("dist/"))).toBe(true);
      expect(writeFingerprint(root, entries)).toEqual(before);
    },
    testTimeoutMs(COPIED_CHECKOUT_TEST_MS),
  );

  it(
    "an export-shaped tree with no git, CI, deploy, or deploy-root config passes with zero writes",
    async () => {
      const root = await copiedCheckout();
      const runtime = join(root, "packages/runtime");
      await rm(join(root, DEPLOY_ROOT_CONFIG_PATH), { force: true });
      for (const absent of [".git", ".gitlab", "deploy", "scripts", "planning"]) {
        expect(existsSync(join(root, absent))).toBe(false);
      }
      const entries = outputEntries(root);
      const before = writeFingerprint(root, entries);

      const result = await run(
        process.execPath,
        ["scripts/ensure-derived.mjs"],
        runtime,
        copiedChildMs,
      );

      expect({ code: result.code, stderr: result.stderr }).toMatchObject({ code: 0 });
      expect(result.stderr).not.toContain("ensure-derived");
      expect(writeFingerprint(root, entries)).toEqual(before);
      for (const absent of [".gitlab", "deploy", "packages/runtime/.cache"]) {
        expect(existsSync(join(root, absent))).toBe(false);
      }
    },
    testTimeoutMs(COPIED_CHECKOUT_TEST_MS),
  );
});

/**
 * Lower derived.lockWaitMs to its floor, let `hold` write a lock this test's
 * own process holds, and expect the refusal within the bound's tolerance,
 * naming the path `hold` returns and leaving every lock file in place.
 */
async function expectRefusalAtLockWaitBound(hold: (lockPath: string) => Promise<string>) {
  const { root, runtime, hook } = await stubCheckout();
  await flagStub(runtime, "limits", "stale");
  const fragment = join(root, LOCK_WAIT_FRAGMENT);
  const declared = await readFile(fragment, "utf8");
  const lowered = declared.replace(`value: ${LOCK_WAIT_MS}\n`, `value: ${LOCK_WAIT_FLOOR_MS}\n`);
  expect(lowered).not.toBe(declared);
  await writeFile(fragment, lowered);
  const lockPath = join(runtime, ENSURE_DERIVED_LOCK_PATH);
  await mkdir(dirname(lockPath), { recursive: true });
  const heldPath = await hold(lockPath);
  const lockFiles = () =>
    readdirSync(dirname(lockPath)).map((name) => [
      name,
      readFileSync(join(dirname(lockPath), name), "utf8"),
    ]);
  const before = lockFiles();

  const result = await run(process.execPath, [hook], runtime, stubChildMs);

  expect(result.code).toBe(1);
  expect(result.stderr).toContain(`Waiting at most derived.lockWaitMs = ${LOCK_WAIT_FLOOR_MS} ms.`);
  const prefix = "ensure-derived: derived-lock-wait-ms-bound: ";
  const line = result.stderr.split("\n").find((entry) => entry.startsWith(prefix));
  const waited = Number(/^waited (\d+) ms /u.exec(line?.slice(prefix.length) ?? "")?.[1]);
  expect(waited, result.stderr).toBeGreaterThan(LOCK_WAIT_FLOOR_MS);
  // The slack must cover the final poll, or an on-time refusal could fail.
  expect(LOCK_WAIT_REFUSAL_SLACK_MS).toBeGreaterThan(ENSURE_DERIVED_LOCK_POLL_INTERVAL_MS);
  expect(waited, result.stderr).toBeLessThan(LOCK_WAIT_FLOOR_MS + LOCK_WAIT_REFUSAL_SLACK_MS);
  expect(line).toBe(
    `${prefix}waited ${waited} ms for process ${process.pid}, which holds ${heldPath}; ${waited} exceeds derived.lockWaitMs = ${LOCK_WAIT_FLOOR_MS} ms. ${LIMIT_DEFINITION_BY_NAME["derived.lockWaitMs"]!.remediation} Follow the named remediation.`,
  );
  expect(stubRuns(runtime)).toEqual([]);
  // Another process's lock or reclaim marker is never removed by a refusing waiter.
  expect(lockFiles()).toEqual(before);
}

async function expectWaitOnLiveHolder(holderPid: number) {
  const { runtime, hook } = await stubCheckout();
  await flagStub(runtime, "limits", "stale");
  const lockPath = join(runtime, ENSURE_DERIVED_LOCK_PATH);
  await mkdir(dirname(lockPath), { recursive: true });
  await writeFile(lockPath, `${JSON.stringify({ pid: holderPid, token: "held" })}\n`);

  const waiter = start([hook], runtime);
  await waitFor(
    "the waiting notice or an exit",
    () => waiter.stderr().includes("waiting for process") || waiter.exited(),
    stubChildMs,
  ).catch((error: unknown) => {
    waiter.child.kill();
    throw error;
  });
  expect(waiter.stderr()).toContain(
    `ensure-derived: waiting for process ${holderPid}, which holds ${lockPath} while it regenerates derived outputs. Waiting at most derived.lockWaitMs = ${LOCK_WAIT_MS} ms.`,
  );
  expect(stubRuns(runtime)).toEqual([]);
  await rm(lockPath);
  const result = await waiter.done;

  expect(result.code).toBe(0);
  expect(stubRuns(runtime)).toEqual(["limits"]);
  expect(existsSync(lockPath)).toBe(false);
}

describe("ensure-derived lock and failure handling", () => {
  it(
    "two concurrent runs on one stale checkout generate once and both succeed",
    async () => {
      const { runtime, hook } = await stubCheckout();
      await flagStub(runtime, "skill-crate", "stale", "hold");

      const first = start([hook], runtime);
      const second = start([hook], runtime);
      const waiting = () =>
        [first, second].some((run) => run.stderr().includes("ensure-derived: waiting for process"));
      // Without the lock or its re-check, the second run starts its own generation instead.
      await waitFor(
        "one run to wait on the other's lock, or a second generation",
        () => waiting() || stubRuns(runtime).length >= 2,
        stubChildMs,
      ).finally(() => writeFile(join(runtime, "fixture-state/release"), ""));
      const results = await Promise.all([first.done, second.done]);

      expect(results.map((result) => result.code)).toEqual([0, 0]);
      expect(stubRuns(runtime)).toEqual(["skill-crate", "quality-pack"]);
      expect(await readFile(join(runtime, "skill-crate/marker.txt"), "utf8")).toBe(
        "regenerated by skill-crate\n",
      );
      expect(existsSync(join(runtime, ENSURE_DERIVED_LOCK_PATH))).toBe(false);
    },
    testTimeoutMs(STUB_CHECKOUT_TEST_MS),
  );

  it(
    "waits on a lock held by a live process instead of reclaiming it",
    () => expectWaitOnLiveHolder(process.pid),
    testTimeoutMs(STUB_CHECKOUT_TEST_MS),
  );

  // Signalling pid 1 from an unprivileged user fails with EPERM, which still means live.
  it(
    "treats a lock held by another user's live process as live",
    () => expectWaitOnLiveHolder(1),
    testTimeoutMs(STUB_CHECKOUT_TEST_MS),
  );

  it(
    "refuses at derived.lockWaitMs when a holder that looks live never releases",
    () =>
      expectRefusalAtLockWaitBound(async (lockPath) => {
        // This test's own process stands in for an unrelated process that reused a stopped holder's pid.
        await writeFile(lockPath, `${JSON.stringify({ pid: process.pid, token: "reused" })}\n`);
        return lockPath;
      }),
    testTimeoutMs(STUB_CHECKOUT_TEST_MS),
  );

  it(
    "refuses at derived.lockWaitMs naming the live reclaimer when a stopped lock's reclaim never finishes",
    () =>
      expectRefusalAtLockWaitBound(async (lockPath) => {
        const stopped = await stoppedProcessPid();
        await writeFile(lockPath, `${JSON.stringify({ pid: stopped, token: "stopped" })}\n`);
        const markerPath = `${lockPath}.reclaim-stopped`;
        await writeFile(
          markerPath,
          `${JSON.stringify({ pid: process.pid, token: "reclaimer" })}\n`,
        );
        return markerPath;
      }),
    testTimeoutMs(STUB_CHECKOUT_TEST_MS),
  );

  it(
    "reads the wait bound only on contention, and refuses a wait when the catalog lacks it",
    async () => {
      const { root, runtime, hook } = await stubCheckout();
      await flagStub(runtime, "limits", "stale");
      await rm(join(root, LOCK_WAIT_FRAGMENT));
      const registry = join(root, "config/limits.yaml");
      const registered = await readFile(registry, "utf8");
      const unregistered = registered.replace("  - file: derived.yaml\n    owner: derived\n", "");
      expect(unregistered).not.toBe(registered);
      await writeFile(registry, unregistered);

      // No other holder: no wait, so the missing bound is never read.
      const uncontended = await run(process.execPath, [hook], runtime, stubChildMs);
      expect({ code: uncontended.code, stderr: uncontended.stderr }).toMatchObject({ code: 0 });
      expect(stubRuns(runtime)).toEqual(["limits"]);

      await flagStub(runtime, "limits", "stale");
      const lockPath = join(runtime, ENSURE_DERIVED_LOCK_PATH);
      await writeFile(lockPath, `${JSON.stringify({ pid: process.pid, token: "held" })}\n`);
      const contended = await run(process.execPath, [hook], runtime, stubChildMs);

      expect(contended.code).toBe(1);
      expect(contended.stderr).toContain(
        "ensure-derived: DERIVED_LOCK_WAIT_UNDECLARED: another process holds the derived-generation lock and config/limits does not declare derived.lockWaitMs, so the wait would have no bound.",
      );
      expect(contended.stderr).not.toContain("waiting for process");
      expect(stubRuns(runtime)).toEqual(["limits"]);
    },
    testTimeoutMs(STUB_CHECKOUT_TEST_MS),
  );

  it(
    "reclaims a lock left by a stopped process",
    async () => {
      const { runtime, hook } = await stubCheckout();
      await flagStub(runtime, "limits", "stale");
      const lockPath = join(runtime, ENSURE_DERIVED_LOCK_PATH);
      await mkdir(dirname(lockPath), { recursive: true });
      const stopped = await stoppedProcessPid();
      await writeFile(lockPath, `${JSON.stringify({ pid: stopped, token: "stopped" })}\n`);

      const result = await run(process.execPath, [hook], runtime, stubChildMs);

      expect(result.code).toBe(0);
      expect(result.stderr).not.toContain("waiting for process");
      expect(stubRuns(runtime)).toEqual(["limits"]);
      expect(readdirSync(dirname(lockPath))).toEqual([]);
    },
    testTimeoutMs(STUB_CHECKOUT_TEST_MS),
  );

  it(
    "refuses an unreadable lock record and a reclaim abandoned by a stopped process",
    async () => {
      const { runtime, hook } = await stubCheckout();
      await flagStub(runtime, "limits", "stale");
      const lockPath = join(runtime, ENSURE_DERIVED_LOCK_PATH);
      await mkdir(dirname(lockPath), { recursive: true });

      await writeFile(lockPath, "not a record\n");
      const unreadable = await run(process.execPath, [hook], runtime, stubChildMs);
      expect(unreadable.code).toBe(1);
      expect(unreadable.stderr).toContain(
        `ensure-derived: DERIVED_LOCK_UNREADABLE: ${lockPath} has no readable owner record.`,
      );

      const stopped = await stoppedProcessPid();
      await writeFile(lockPath, `${JSON.stringify({ pid: stopped, token: "stopped" })}\n`);
      await writeFile(
        `${lockPath}.reclaim-stopped`,
        `${JSON.stringify({ pid: stopped, token: "reclaimer" })}\n`,
      );
      const abandoned = await run(process.execPath, [hook], runtime, stubChildMs);
      expect(abandoned.code).toBe(1);
      expect(abandoned.stderr).toContain(
        `ensure-derived: DERIVED_LOCK_ABANDONED: ${lockPath} names stopped process ${stopped}, and the process reclaiming it also stopped`,
      );
      expect(stubRuns(runtime)).toEqual([]);
    },
    testTimeoutMs(STUB_CHECKOUT_TEST_MS),
  );

  it(
    "waits on a live process that is already reclaiming a stopped lock",
    async () => {
      const { runtime, hook } = await stubCheckout();
      await flagStub(runtime, "limits", "stale");
      const lockPath = join(runtime, ENSURE_DERIVED_LOCK_PATH);
      await mkdir(dirname(lockPath), { recursive: true });
      const stopped = await stoppedProcessPid();
      await writeFile(lockPath, `${JSON.stringify({ pid: stopped, token: "stopped" })}\n`);
      const markerPath = `${lockPath}.reclaim-stopped`;
      await writeFile(markerPath, `${JSON.stringify({ pid: process.pid, token: "reclaimer" })}\n`);

      const waiter = start([hook], runtime);
      await waitFor(
        "the waiting notice or an exit",
        () => waiter.stderr().includes("waiting for process") || waiter.exited(),
        stubChildMs,
      ).catch((error: unknown) => {
        waiter.child.kill();
        throw error;
      });
      expect(waiter.stderr()).toContain(
        `ensure-derived: waiting for process ${process.pid}, which holds ${markerPath} while it regenerates derived outputs.`,
      );
      expect(stubRuns(runtime)).toEqual([]);
      await rm(markerPath);
      const result = await waiter.done;

      expect(result.code).toBe(0);
      expect(stubRuns(runtime)).toEqual(["limits"]);
      expect(readdirSync(dirname(lockPath))).toEqual([]);
    },
    testTimeoutMs(STUB_CHECKOUT_TEST_MS),
  );

  it.skipIf(process.getuid?.() === 0)(
    "refuses a lock directory it cannot write",
    async () => {
      const { runtime, hook } = await stubCheckout();
      await flagStub(runtime, "limits", "stale");
      const lockDirectory = dirname(join(runtime, ENSURE_DERIVED_LOCK_PATH));
      await mkdir(lockDirectory);
      await chmod(lockDirectory, 0o555);

      const result = await run(process.execPath, [hook], runtime, stubChildMs);
      await chmod(lockDirectory, 0o755);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain(
        `ensure-derived: DERIVED_LOCK_UNAVAILABLE: derived outputs are stale and the generation lock directory ${lockDirectory} is not writable (EACCES).`,
      );
      expect(stubRuns(runtime)).toEqual([]);
    },
    testTimeoutMs(STUB_CHECKOUT_TEST_MS),
  );

  it(
    "lets an error that is not one of its refusals keep its stack",
    async () => {
      const { runtime, hook } = await stubCheckout();
      await flagStub(runtime, "limits", "stale");
      await mkdir(join(runtime, ENSURE_DERIVED_LOCK_PATH), { recursive: true });

      const result = await run(process.execPath, [hook], runtime, stubChildMs);

      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("EISDIR");
      expect(result.stderr).not.toContain("ensure-derived: DERIVED_");
    },
    testTimeoutMs(STUB_CHECKOUT_TEST_MS),
  );

  it(
    "restores the crate and names the unrestored residue when a dependent step fails",
    async () => {
      const { runtime, hook } = await stubCheckout();
      await flagStub(runtime, "skill-crate", "stale");
      await flagStub(runtime, "quality-pack", "fail");

      const result = await run(process.execPath, [hook], runtime, stubChildMs);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain(
        "ensure-derived: DERIVED_GENERATION_FAILED: derived outputs are stale and regenerating them failed at quality-pack: quality-pack generator failed.",
      );
      // Residue: repository-level outputs (config/limits*.json, CI and deploy
      // mirrors, docs pages, the knowledge mirror) sit outside the rollback.
      expect(result.stderr).toContain(
        "repository-level outputs an earlier step wrote are not rolled back. Fix the cause, then run: npm --prefix packages/runtime run generate:pins",
      );
      expect(stubRuns(runtime)).toEqual(["skill-crate", "quality-pack"]);
      expect(await readFile(join(runtime, "skill-crate/marker.txt"), "utf8")).toBe(
        "committed skill-crate\n",
      );
      expect(await readFile(join(runtime, "quality-pack/manifest.json"), "utf8")).toBe(
        "committed quality-pack\n",
      );
      expect(existsSync(join(runtime, ENSURE_DERIVED_LOCK_PATH))).toBe(false);
    },
    testTimeoutMs(STUB_CHECKOUT_TEST_MS),
  );

  it(
    "names a rewritten file that only the generator's own list declares",
    async () => {
      const { runtime, hook } = await stubCheckout();
      await flagStub(runtime, "limits", "stale", "extra");

      const result = await run(process.execPath, [hook], runtime, stubChildMs);

      expect({ code: result.code, stderr: result.stderr }).toMatchObject({ code: 0 });
      expect(regeneratedPaths(result.stderr)).toEqual({
        limits: [`${stubExtraOutput("limits")} (added)`, LIMITS_MIRROR],
      });
      expect(stubLog(runtime, "lists.log")).toEqual(["limits"]);
    },
    testTimeoutMs(STUB_CHECKOUT_TEST_MS),
  );

  it(
    "refuses before any write when a listing step cannot list its files",
    async () => {
      const { runtime, hook } = await stubCheckout();
      await flagStub(runtime, "model-output", "stale", "unlisted");

      const result = await run(process.execPath, [hook], runtime, stubChildMs);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain(
        "ensure-derived: DERIVED_OUTPUTS_UNLISTED: derived outputs are stale and model-output could not list the files it writes (model-output cannot list its mirrors), so a regeneration could not name every rewritten path. Nothing was regenerated.",
      );
      expect(stubRuns(runtime)).toEqual([]);
      expect(readdirSync(join(runtime, ".cache"))).toEqual([]);
    },
    testTimeoutMs(STUB_CHECKOUT_TEST_MS),
  );

  it(
    "asks only the listing steps for their files",
    async () => {
      const { runtime, hook } = await stubCheckout();
      // A step outside the listing set would fail here if it were asked.
      await flagStub(runtime, "skill-crate", "stale", "unlisted");

      const result = await run(process.execPath, [hook], runtime, stubChildMs);

      expect({ code: result.code, stderr: result.stderr }).toMatchObject({ code: 0 });
      expect(stubRuns(runtime)).toEqual(["skill-crate", "quality-pack"]);
      expect(stubLog(runtime, "lists.log")).toEqual([]);
      expect(ENSURE_DERIVED_LISTING_STEPS).toEqual(["limits", "model-output"]);
    },
    testTimeoutMs(STUB_CHECKOUT_TEST_MS),
  );

  it("a late reclaim leaves a newer lock in place and removes only its own marker", async () => {
    const root = await roots.create("docsfab-ensure-derived-reclaim-", { realpath: true });
    const lockPath = join(root, "ensure-derived.lock");
    const stopped = { pid: await stoppedProcessPid(), token: "stopped" };
    const newer = `${JSON.stringify({ pid: process.pid, token: "newer" })}\n`;
    await writeFile(lockPath, newer);

    expect(reclaimStoppedLock(lockPath, stopped)).toEqual({ reclaimed: false });
    expect(await readFile(lockPath, "utf8")).toBe(newer);
    expect(readdirSync(root)).toEqual(["ensure-derived.lock"]);

    // The adjacent case: the lock still names the stopped holder, so it goes.
    await writeFile(lockPath, `${JSON.stringify(stopped)}\n`);
    expect(reclaimStoppedLock(lockPath, stopped)).toEqual({ reclaimed: true });
    expect(readdirSync(root)).toEqual([]);
  });

  it("releases only a lock that still carries its own token", async () => {
    const root = await roots.create("docsfab-ensure-derived-release-", { realpath: true });
    const lockPath = join(root, "ensure-derived.lock");
    const other = `${JSON.stringify({ pid: process.pid, token: "other" })}\n`;
    await writeFile(lockPath, other);

    releaseLock({ path: lockPath, owner: { pid: process.pid, token: "mine" } });
    expect(await readFile(lockPath, "utf8")).toBe(other);

    releaseLock({ path: lockPath, owner: { pid: process.pid, token: "other" } });
    expect(existsSync(lockPath)).toBe(false);
  });

  it(
    "refuses a regeneration that leaves its family stale",
    async () => {
      const { runtime, hook } = await stubCheckout();
      await flagStub(runtime, "model-output", "stale", "sticky");

      const result = await run(process.execPath, [hook], runtime, stubChildMs);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain(
        "ensure-derived: DERIVED_GENERATION_NOT_CURRENT: regeneration finished but model-output still fails its check: model-output is stale.",
      );
    },
    testTimeoutMs(STUB_CHECKOUT_TEST_MS),
  );

  it(
    "runs when invoked through a symlink",
    async () => {
      const { root, runtime, hook } = await stubCheckout();
      await flagStub(runtime, "limits", "stale");
      const link = join(root, "ensure-derived-link.mjs");
      await symlink(hook, link);

      const result = await run(process.execPath, [link], root, stubChildMs);

      expect(result.code).toBe(0);
      expect(result.stderr).toContain(
        "ensure-derived: regenerated stale derived outputs: limits: packages/runtime/src/config/limits.generated.ts",
      );
      expect(stubRuns(runtime)).toEqual(["limits"]);
    },
    testTimeoutMs(STUB_CHECKOUT_TEST_MS),
  );

  it(
    "regenerates a stale step before the runtime package is installed",
    async () => {
      const { runtime, hook } = await stubCheckout();
      await rm(join(runtime, "node_modules"), { recursive: true });
      const current = await run(process.execPath, [hook], runtime, stubChildMs);
      expect({ code: current.code, stderr: current.stderr }).toMatchObject({ code: 0 });
      expect(current.stderr).not.toContain("ensure-derived");
      await flagStub(runtime, "limits", "stale");

      const result = await run(process.execPath, [hook], runtime, stubChildMs);

      expect({ code: result.code, stderr: result.stderr }).toMatchObject({ code: 0 });
      expect(regeneratedPaths(result.stderr)).toEqual({
        limits: [`packages/runtime/${STUB_OUTPUTS.limits}`],
      });
      expect(stubRuns(runtime)).toEqual(["limits"]);
    },
    testTimeoutMs(STUB_CHECKOUT_TEST_MS),
  );

  it("propagates a step error that is not a check result instead of refusing", async () => {
    const root = await roots.create("docsfab-ensure-derived-inline-", { realpath: true });
    const failure = new Error("the step runner itself broke");
    const attempt = ensureDerived({
      runtimeRoot: join(root, "packages/runtime"),
      executeStep: () => {
        throw failure;
      },
    });

    await expect(attempt).rejects.toBe(failure);
    await expect(attempt).rejects.not.toBeInstanceOf(EnsureDerivedRefusal);
  });
});

describe("script order around the shared generation step", () => {
  it("runs exactly the generating machine steps, in dependency order", () => {
    expect(ENSURE_DERIVED_STEPS.map((step: { id: string }) => step.id)).toEqual(STEP_IDS);
  });

  const scripts = async (packageName: string): Promise<Record<string, string>> =>
    JSON.parse(
      await readFile(join(repositoryRoot, "packages", packageName, "package.json"), "utf8"),
    ).scripts;
  const commands = (script: string | undefined) =>
    (script ?? "").split("&&").map((command) => command.trim());

  it("runtime check runs check:pins before anything that can regenerate", async () => {
    const runtime = await scripts("runtime");
    const check = commands(runtime.check);
    expect(check[0]).toBe("npm run check:pins");
    expect(check.indexOf("npm run check:pins")).toBeLessThan(check.indexOf("npm run check:static"));
    expect(check.indexOf("npm run check:pins")).toBeLessThan(check.indexOf("npm test"));
  });

  // The host package pins its own scripts in its own test.
  it("runtime typecheck scripts run the hook first", async () => {
    const runtime = await scripts("runtime");
    expect(commands(runtime.typecheck)[0]).toBe("node scripts/ensure-derived.mjs");
    expect(commands(runtime["typecheck:tests"])[0]).toBe("node scripts/ensure-derived.mjs");
  });
});

describe("ensure-derived env-admission step", () => {
  it(
    "regenerates both missing env-admission code mirrors byte for byte",
    async () => {
      const root = await copiedCheckout();
      const runtime = join(root, "packages/runtime");
      const committed = await Promise.all(
        ENV_ADMISSION_MIRRORS.map((path) => readFile(join(root, path))),
      );
      for (const path of ENV_ADMISSION_MIRRORS) await rm(join(root, path));
      const untouched = entriesOf(root, ["skill-crate", "quality-pack", "limits", "model-output"]);
      const before = writeFingerprint(root, untouched);

      const result = await run(
        process.execPath,
        ["scripts/ensure-derived.mjs"],
        runtime,
        copiedChildMs,
      );

      expect({ code: result.code, stderr: result.stderr }).toMatchObject({ code: 0 });
      expect(regeneratedPaths(result.stderr)).toEqual({
        "env-admission": [
          "packages/runtime/scripts/offline-test-env.generated.mjs (added)",
          "packages/runtime/src/config/env-admission.generated.ts (added)",
        ],
      });
      for (const [index, path] of ENV_ADMISSION_MIRRORS.entries()) {
        expect(await readFile(join(root, path))).toEqual(committed[index]);
      }
      expect(writeFingerprint(root, untouched)).toEqual(before);
      expect(existsSync(join(runtime, ENSURE_DERIVED_LOCK_PATH))).toBe(false);
    },
    testTimeoutMs(COPIED_CHECKOUT_TEST_MS),
  );

  it("hands the launcher every env-admission input to watch", () => {
    for (const input of DERIVED_PRODUCT_BY_ID["env-admission"].inputs as string[]) {
      expect(ENSURE_DERIVED_INPUTS).toContain(input);
    }
  });

  it(
    "restores both env-admission outputs when a later step fails",
    async () => {
      const { runtime, hook } = await stubCheckout();
      await flagStub(runtime, "env-admission", "stale");
      await flagStub(runtime, "model-output", "stale", "fail");

      const result = await run(process.execPath, [hook], runtime, stubChildMs);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain(
        "ensure-derived: DERIVED_GENERATION_FAILED: derived outputs are stale and regenerating them failed at model-output: model-output generator failed.",
      );
      expect(stubRuns(runtime)).toEqual(["env-admission", "model-output"]);
      for (const path of [STUB_OUTPUTS["env-admission"]!, STUB_SECOND_OUTPUTS["env-admission"]!]) {
        expect({ path, text: await readFile(join(runtime, path), "utf8") }).toEqual({
          path,
          text: "committed env-admission\n",
        });
      }
    },
    testTimeoutMs(STUB_CHECKOUT_TEST_MS),
  );

  it(
    "without node_modules regenerates every stale generating step",
    async () => {
      const { runtime, hook } = await stubCheckout();
      await rm(join(runtime, "node_modules"), { recursive: true });
      await flagStub(runtime, "limits", "stale");
      await flagStub(runtime, "env-admission", "stale");
      await flagStub(runtime, "model-output", "stale");

      const result = await run(process.execPath, [hook], runtime, stubChildMs);

      expect({ code: result.code, stderr: result.stderr }).toMatchObject({ code: 0 });
      expect(stubRuns(runtime)).toEqual(["limits", "env-admission", "model-output"]);
      expect(Object.keys(regeneratedPaths(result.stderr))).toEqual([
        "limits",
        "env-admission",
        "model-output",
      ]);
    },
    testTimeoutMs(STUB_CHECKOUT_TEST_MS),
  );
});

describe("ensure-derived --steps", () => {
  it(
    "checks and regenerates only the named step and the steps built from it",
    async () => {
      const { runtime, hook } = await stubCheckout();
      await flagStub(runtime, "limits", "stale");
      await flagStub(runtime, "model-output", "stale");

      const only = await run(
        process.execPath,
        [hook, "--steps", "model-output"],
        runtime,
        stubChildMs,
      );

      expect({ code: only.code, stderr: only.stderr }).toMatchObject({ code: 0 });
      expect(stubRuns(runtime)).toEqual(["model-output"]);

      await flagStub(runtime, "skill-crate", "stale");
      const dependents = await run(
        process.execPath,
        [hook, "--steps", "skill-crate"],
        runtime,
        stubChildMs,
      );

      expect({ code: dependents.code, stderr: dependents.stderr }).toMatchObject({ code: 0 });
      // quality-pack is built from skill-crate; limits, still stale, is not named.
      expect(stubRuns(runtime)).toEqual(["model-output", "skill-crate", "quality-pack"]);
    },
    testTimeoutMs(STUB_CHECKOUT_TEST_MS),
  );

  it(
    "refuses an unknown step or argument before any check",
    async () => {
      const { runtime, hook } = await stubCheckout();
      await flagStub(runtime, "limits", "stale");
      const cases: Array<[string[], string]> = [
        [
          ["--steps", "model-outputs"],
          "ensure-derived: DERIVED_STEP_UNKNOWN: --steps names model-outputs, which is not a step of this hook. The steps are skill-crate, quality-pack, limits, env-admission, model-output.",
        ],
        [
          ["--steps"],
          "ensure-derived: DERIVED_ARGUMENTS_INVALID: expected no arguments or --steps <id>[,<id>...], got: --steps.",
        ],
        [
          ["--check"],
          "ensure-derived: DERIVED_ARGUMENTS_INVALID: expected no arguments or --steps <id>[,<id>...], got: --check.",
        ],
      ];
      for (const [args, line] of cases) {
        const result = await run(process.execPath, [hook, ...args], runtime, stubChildMs);
        expect({ args, code: result.code, stderr: result.stderr.trim() }).toEqual({
          args,
          code: 1,
          stderr: line,
        });
      }
      expect(stubRuns(runtime)).toEqual([]);
    },
    testTimeoutMs(STUB_CHECKOUT_TEST_MS),
  );
});

const OFFLINE_NAMES_MIRROR = "packages/runtime/scripts/offline-test-env.generated.mjs";
const OFFLINE_NAMES_ADDED = `env-admission: ${OFFLINE_NAMES_MIRROR} (added)`;
const PROBE_TEST = `import { expect, it } from "vitest";
it("runs after the runner restored the offline name list", () => {
  expect(true).toBe(true);
});
`;

/** Runtime-relative test files in a copied checkout, outside node_modules. */
function copiedTestFiles(runtime: string, directory = ""): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(join(runtime, directory), { withFileTypes: true })) {
    const path = directory === "" ? entry.name : `${directory}/${entry.name}`;
    if (entry.name === "node_modules") continue;
    if (entry.isDirectory()) files.push(...copiedTestFiles(runtime, path));
    else if (/\.test\.[cm]?[jt]s$/u.test(entry.name)) files.push(path);
  }
  return files;
}

/** A copied checkout with a probe test and no offline name list. */
async function checkoutWithoutOfflineNames() {
  const root = await copiedCheckout();
  const runtime = join(root, "packages/runtime");
  await writeFile(join(runtime, "test/probe.test.ts"), PROBE_TEST);
  const committed = await readFile(join(root, OFFLINE_NAMES_MIRROR));
  await rm(join(root, OFFLINE_NAMES_MIRROR));
  return { root, runtime, committed };
}

describe("test runner entries restore the offline name list before they load it", () => {
  it(
    "npm run test:changed regenerates the list, then runs the named test",
    async () => {
      const { root, runtime, committed } = await checkoutWithoutOfflineNames();

      const result = await run(
        "npm",
        ["run", "--silent", "test:changed", "--", "--paths", "test/probe.test.ts"],
        runtime,
        copiedChildMs,
        { DOCSFAB_VITEST_GRAPH_LOCK_PATH: join(root, "vitest-graph.lock") },
      );

      expect({ code: result.code, output: result.stdout + result.stderr }).toMatchObject({
        code: 0,
      });
      expect(result.stderr).toContain(OFFLINE_NAMES_ADDED);
      expect(result.stderr).toMatch(/^vitest-changed: completed 1 non-skipped test\(s\)$/mu);
      expect(await readFile(join(root, OFFLINE_NAMES_MIRROR))).toEqual(committed);
    },
    testTimeoutMs(COPIED_CHECKOUT_TEST_MS),
  );

  it(
    "the documented node scripts/offline-test-environment.mjs <command> entry regenerates the list",
    async () => {
      const { root, runtime, committed } = await checkoutWithoutOfflineNames();

      const result = await run(
        process.execPath,
        [
          "scripts/offline-test-environment.mjs",
          process.execPath,
          "-e",
          "process.stdout.write(String(process.env.PI_OFFLINE))",
        ],
        runtime,
        copiedChildMs,
      );

      expect({ code: result.code, stdout: result.stdout, stderr: result.stderr }).toMatchObject({
        code: 0,
        stdout: "1",
      });
      expect(result.stderr).toContain(OFFLINE_NAMES_ADDED);
      expect(await readFile(join(root, OFFLINE_NAMES_MIRROR))).toEqual(committed);
    },
    testTimeoutMs(COPIED_CHECKOUT_TEST_MS),
  );

  it(
    "npm run test:ci:fast regenerates the list, then runs the lane",
    async () => {
      const { root, runtime, committed } = await checkoutWithoutOfflineNames();

      const result = await run(
        "npm",
        ["run", "--silent", "test:ci:fast", "--", "test/probe.test.ts"],
        runtime,
        copiedChildMs,
      );

      expect({ code: result.code, output: result.stdout + result.stderr }).toMatchObject({
        code: 0,
      });
      expect(result.stderr).toContain(OFFLINE_NAMES_ADDED);
      expect(result.stdout).toContain("1 passed");
      expect(await readFile(join(root, OFFLINE_NAMES_MIRROR))).toEqual(committed);
    },
    testTimeoutMs(COPIED_CHECKOUT_TEST_MS),
  );

  it(
    "the direct CI entry node scripts/coverage-shards.mjs lane loads and runs without the list",
    async () => {
      const { root, runtime, committed } = await checkoutWithoutOfflineNames();
      // The lane runs every discovered test file; keep only the probe.
      for (const file of copiedTestFiles(runtime)) {
        if (file !== "test/probe.test.ts") await rm(join(runtime, file));
      }
      for (const args of [
        ["init", "-q"],
        [
          "-c",
          "user.email=fixture@example.invalid",
          "-c",
          "user.name=Fixture",
          "commit",
          "-q",
          "--allow-empty",
          "-m",
          "fixture",
        ],
      ]) {
        const git = await run("git", args, root, copiedChildMs);
        expect({ args, code: git.code, stderr: git.stderr }).toMatchObject({ code: 0 });
      }

      // In CI the lane refuses on Linux without GNU time for its peak-RSS
      // evidence. This case proves the entry loads and runs, not that
      // measurement, so it must not depend on the host having GNU time.
      const result = await run(
        process.execPath,
        ["scripts/coverage-shards.mjs", "lane", "--lane=fast", "--junit=ci-results/probe"],
        runtime,
        copiedChildMs,
        { CI: undefined },
      );
      const laneOutput = `coverage-shards lane exited ${result.code}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`;

      expect(result.code, laneOutput).toBe(0);
      expect(result.stderr, laneOutput).not.toContain("ERR_MODULE_NOT_FOUND");
      expect(result.stdout, laneOutput).toContain(
        "coverage lane fast-1: 1 instrumented and 0 uninstrumented files, 1 tests",
      );
      expect(await readFile(join(root, OFFLINE_NAMES_MIRROR))).toEqual(committed);
    },
    testTimeoutMs(COPIED_CHECKOUT_TEST_MS),
  );
});

const KNOWLEDGE_MIRROR = "packages/knowledge/src/model-output.generated.mjs";
const KNOWLEDGE_TEST = "packages/knowledge/tests/model-output-generated.test.mjs";

/** A copied checkout with the knowledge package's scripts and its one mirror reader, and no mirror. */
async function knowledgeCheckout() {
  const root = await copiedCheckout();
  for (const path of ["packages/knowledge/package.json", KNOWLEDGE_TEST]) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await cp(join(repositoryRoot, path), join(root, path));
  }
  const committed = await readFile(join(root, KNOWLEDGE_MIRROR));
  await rm(join(root, KNOWLEDGE_MIRROR));
  return { root, knowledge: join(root, "packages/knowledge"), committed };
}

describe("knowledge tests restore the model-output mirror through the hook", () => {
  /** Run the knowledge entry on a checkout without the mirror, installed or not. */
  async function regeneratesKnowledgeMirror(installed: boolean) {
    const { root, knowledge, committed } = await knowledgeCheckout();
    if (!installed) await rm(join(root, "packages/runtime/node_modules"));
    const untouched = entriesOf(root, ["skill-crate", "quality-pack", "limits", "env-admission"]);
    const before = writeFingerprint(root, untouched);

    const result = await run(
      "npm",
      ["run", "--silent", "test:control-plane"],
      knowledge,
      copiedChildMs,
    );

    expect({ code: result.code, output: result.stdout + result.stderr }).toMatchObject({
      code: 0,
    });
    expect(regeneratedPaths(result.stderr)).toEqual({
      "model-output": [`${KNOWLEDGE_MIRROR} (added)`],
    });
    expect(result.stdout).toMatch(/^ℹ fail 0$/mu);
    expect(result.stdout).not.toMatch(/^ℹ pass 0$/mu);
    // Identical bytes whether the npm yaml parser or the subset parser read the catalog.
    expect(await readFile(join(root, KNOWLEDGE_MIRROR))).toEqual(committed);
    expect(writeFingerprint(root, untouched)).toEqual(before);
  }

  it(
    "npm run test:control-plane regenerates the mirror with runtime node_modules",
    () => regeneratesKnowledgeMirror(true),
    testTimeoutMs(COPIED_CHECKOUT_TEST_MS),
  );

  it(
    "npm run test:control-plane regenerates the mirror without runtime node_modules",
    () => regeneratesKnowledgeMirror(false),
    testTimeoutMs(COPIED_CHECKOUT_TEST_MS),
  );

  it(
    "waits on the checkout lock without writing, then names what it regenerated",
    async () => {
      const { root, knowledge } = await knowledgeCheckout();
      const lockPath = join(root, "packages/runtime", ENSURE_DERIVED_LOCK_PATH);
      await mkdir(dirname(lockPath), { recursive: true });
      await writeFile(lockPath, `${JSON.stringify({ pid: process.pid, token: "held" })}\n`);
      const child = spawn("npm", ["run", "--silent", "test:control-plane"], {
        cwd: knowledge,
        env: childEnvironment(),
      });
      let stderr = "";
      let stdout = "";
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      const done = new Promise<number | null>((resolveDone) => child.on("close", resolveDone));
      try {
        await waitFor(
          "the waiting notice",
          () => stderr.includes("ensure-derived: waiting for process"),
          copiedChildMs,
        );
        expect(stderr).toContain(
          `ensure-derived: waiting for process ${process.pid}, which holds ${lockPath} while it regenerates derived outputs.`,
        );
        expect(existsSync(join(root, KNOWLEDGE_MIRROR))).toBe(false);
      } finally {
        await rm(lockPath, { force: true });
      }
      expect({ code: await done, stdout, stderr }).toMatchObject({ code: 0 });
      expect(regeneratedPaths(stderr)).toEqual({
        "model-output": [`${KNOWLEDGE_MIRROR} (added)`],
      });
    },
    testTimeoutMs(COPIED_CHECKOUT_TEST_MS),
  );
});

describe("check:static scope on a tree without the build-generated mirrors", () => {
  const BUILD_GENERATED = [
    "packages/runtime/src/contracts/model-output.generated.ts",
    "packages/runtime/src/execution/response-contract-vocabulary.generated.json",
    KNOWLEDGE_MIRROR,
    ...ENV_ADMISSION_MIRRORS,
  ];

  it(
    "runs both committed-output checks before anything generates, and the typecheck hook then generates the mirrors",
    async () => {
      const runtimeScripts = (
        JSON.parse(await readFile(join(runtimeRoot, "package.json"), "utf8")) as {
          scripts: Record<string, string>;
        }
      ).scripts;
      const staticCommands = runtimeScripts["check:static"]!.split("&&").map((command) =>
        command.trim(),
      );
      const typecheck = staticCommands.indexOf("npm run typecheck");
      const checks = ["npm run check:env-admission", "npm run check:model-output"];
      for (const check of checks) {
        expect(staticCommands.indexOf(check)).toBeGreaterThanOrEqual(0);
        expect(staticCommands.indexOf(check)).toBeLessThan(typecheck);
      }
      const generating = (command: string) =>
        /generate|ensure-derived|typecheck|build/u.test(command) ||
        /generate|ensure-derived/u.test(runtimeScripts[command.replace(/^npm run /u, "")] ?? "");
      const firstCheck = Math.min(...checks.map((check) => staticCommands.indexOf(check)));
      expect(staticCommands.slice(0, firstCheck).filter(generating)).toEqual([]);

      const root = await copiedCheckout();
      const runtime = join(root, "packages/runtime");
      const committed = await Promise.all(
        BUILD_GENERATED.map((path) => readFile(join(root, path))),
      );
      for (const path of BUILD_GENERATED) await rm(join(root, path));

      for (const check of checks) {
        const result = await run(
          "npm",
          ["run", "--silent", check.replace(/^npm run /u, "")],
          runtime,
          copiedChildMs,
        );
        expect({ check, code: result.code, stderr: result.stderr }).toMatchObject({
          check,
          code: 0,
        });
        for (const path of BUILD_GENERATED)
          expect({ check, path, exists: existsSync(join(root, path)) }).toEqual({
            check,
            path,
            exists: false,
          });
      }
      const hook = await run(
        process.execPath,
        ["scripts/ensure-derived.mjs"],
        runtime,
        copiedChildMs,
      );
      expect({ code: hook.code, stderr: hook.stderr }).toMatchObject({ code: 0 });
      for (const [index, path] of BUILD_GENERATED.entries()) {
        expect({
          path,
          same: (await readFile(join(root, path))).equals(committed[index]!),
        }).toEqual({ path, same: true });
      }
    },
    testTimeoutMs(COPIED_CHECKOUT_TEST_MS),
  );

  it(
    "check:model-output still refuses a stale committed rule reference",
    async () => {
      const root = await copiedCheckout();
      const runtime = join(root, "packages/runtime");
      const reference = "packages/runtime/docs/reference/contracts/model-output-rules.md";
      await appendFile(join(root, reference), "\nA stale line.\n");

      const result = await run(
        "npm",
        ["run", "--silent", "check:model-output"],
        runtime,
        copiedChildMs,
      );

      expect(result.code).toBe(1);
      expect(result.stderr).toContain(
        `check:model-output failed: ${reference} drifted from config/model-output/; run npm run generate:model-output`,
      );
      expect(await readFile(join(root, reference), "utf8")).toMatch(/A stale line\.\n$/u);
    },
    testTimeoutMs(COPIED_CHECKOUT_TEST_MS),
  );
});
