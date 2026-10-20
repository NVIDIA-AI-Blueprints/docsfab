// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { loadOfflineTestNames, offlineTestEnvironment } from "./offline-test-environment.mjs";
const testApi = process.env.VITEST ? await import("vitest") : await import("node:test");
const { it } = testApi;
const OFFLINE_TEST_NAMES = loadOfflineTestNames();

it("admits exactly the declared test controls and removes unknown environment entries", () => {
  const base = Object.fromEntries(OFFLINE_TEST_NAMES.map((name) => [name, "fixture-value"]));
  Object.assign(base, {
    MODEL_API_KEY: "synthetic-only",
    INFERENCE_HUB_API: "synthetic-only",
    UNRECOGNIZED_PROVIDER_VARIABLE: "synthetic-only",
    NODE_OPTIONS: "synthetic-only",
    npm_config_call: "synthetic-only",
  });
  const selected = offlineTestEnvironment(base);
  assert.deepEqual(Object.keys(selected).sort(), [...OFFLINE_TEST_NAMES].sort());
  for (const name of OFFLINE_TEST_NAMES) assert.equal(selected[name], "fixture-value");
  assert.deepEqual(offlineTestEnvironment({}), { PI_OFFLINE: "1" });
  assert.equal(base.MODEL_API_KEY, "synthetic-only");
});

it("filters the actual CI-tier launcher child before npm or Vitest can inspect its environment", () => {
  const root = mkdtempSync(join(tmpdir(), "docsfab-offline-launch-"));
  try {
    const output = join(root, "observed.json"),
      executable = join(root, "npx");
    writeFileSync(
      executable,
      `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(output)}, JSON.stringify({names:Object.keys(process.env),args:process.argv.slice(2),ci:process.env.CI,workers:process.env.VITEST_MAX_WORKERS,offline:process.env.PI_OFFLINE}));\n`,
    );
    chmodSync(executable, 0o755);
    const result = spawnSync(
      process.execPath,
      [resolve(import.meta.dirname, "vitest-ci.mjs"), "smoke", "--maxWorkers=1"],
      {
        env: {
          ...offlineTestEnvironment(),
          PATH: root + ":" + process.env.PATH,
          CI: "1",
          VITEST_MAX_WORKERS: "2",
          MODEL_API_KEY: "synthetic-only",
          INFERENCE_HUB_API: "synthetic-only",
          UNRECOGNIZED_PROVIDER_VARIABLE: "synthetic-only",
        },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const child = JSON.parse(readFileSync(output, "utf8"));
    for (const name of ["MODEL_API_KEY", "INFERENCE_HUB_API", "UNRECOGNIZED_PROVIDER_VARIABLE"])
      assert.equal(child.names.includes(name), false, name);
    assert.equal(child.ci, "1");
    assert.equal(child.workers, "2");
    assert.equal(child.offline, "1");
    assert.ok(child.args.includes("--maxWorkers=1"));
    assert.ok(child.args.includes("test/provider.test.ts"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("filters the outer check process before it can form an npm process title", () => {
  const result = spawnSync(
    process.execPath,
    [
      resolve(import.meta.dirname, "offline-test-environment.mjs"),
      process.execPath,
      "--input-type=module",
      "-e",
      "console.log(JSON.stringify({names:Object.keys(process.env),args:process.argv.slice(1)}))",
      "--",
      "fixture-argument",
    ],
    {
      env: {
        ...offlineTestEnvironment(),
        MODEL_API_KEY: "synthetic-only",
        UNRECOGNIZED_PROVIDER_VARIABLE: "synthetic-only",
      },
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const child = JSON.parse(result.stdout);
  assert.equal(child.names.includes("MODEL_API_KEY"), false);
  assert.equal(child.names.includes("UNRECOGNIZED_PROVIDER_VARIABLE"), false);
  assert.deepEqual(child.args, ["fixture-argument"]);
});

/**
 * A scripts directory holding this module and a stub generation step that
 * runs `stubBody`, with no offline name list until the stub writes one.
 */
function stubScripts(stubBody) {
  const root = mkdtempSync(join(tmpdir(), "docsfab-offline-names-"));
  const scripts = join(root, "scripts");
  mkdirSync(scripts);
  copyFileSync(
    resolve(import.meta.dirname, "offline-test-environment.mjs"),
    join(scripts, "offline-test-environment.mjs"),
  );
  writeFileSync(
    join(scripts, "ensure-derived.mjs"),
    `import { appendFileSync, writeFileSync } from "node:fs";
appendFileSync(new URL("./hook-runs.log", import.meta.url), "run\\n");
${stubBody}
`,
  );
  return { root, scripts };
}

const WRITE_NAMES = `writeFileSync(new URL("./offline-test-env.generated.mjs", import.meta.url), 'export const OFFLINE_TEST_NAMES = ["FIXTURE_ADMITTED"];\\n');`;

/** Selects through the module `calls` times in one process and prints the last result. */
function selectThrough(scripts, calls = 1) {
  return spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const m = await import(${JSON.stringify(pathToFileURL(join(scripts, "offline-test-environment.mjs")).href)});
try {
  let selected;
  for (let call = 0; call < ${calls}; call += 1) {
    selected = m.offlineTestEnvironment({ FIXTURE_ADMITTED: "kept", FIXTURE_OTHER: "dropped" });
  }
  console.log(JSON.stringify(selected));
} catch (error) {
  console.log(JSON.stringify({ name: error.name, code: error.code, message: error.message }));
}`,
    ],
    { encoding: "utf8" },
  );
}

const hookRuns = (scripts) =>
  existsSync(join(scripts, "hook-runs.log"))
    ? readFileSync(join(scripts, "hook-runs.log"), "utf8").split("\n").filter(Boolean).length
    : 0;

it("runs the generation step before it loads the generated name list", () => {
  const { root, scripts } = stubScripts(WRITE_NAMES);
  try {
    // Importing alone runs nothing: a runner module stays importable by its tests.
    const imported = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `await import(${JSON.stringify(pathToFileURL(join(scripts, "offline-test-environment.mjs")).href)});`,
      ],
      { encoding: "utf8" },
    );
    assert.equal(imported.status, 0, imported.stderr);
    assert.equal(hookRuns(scripts), 0);
    assert.equal(existsSync(join(scripts, "offline-test-env.generated.mjs")), false);

    // A second selection in the same process reuses the loaded list.
    const result = selectThrough(scripts, 2);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { FIXTURE_ADMITTED: "kept", PI_OFFLINE: "1" });
    assert.equal(hookRuns(scripts), 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("refuses with its code when the generation step exits nonzero or dies, and loads nothing", () => {
  for (const [body, status] of [
    ['process.stderr.write("stub refusal\\n");\nprocess.exitCode = 3;', "3"],
    ['process.kill(process.pid, "SIGKILL");', "SIGKILL"],
  ]) {
    const { root, scripts } = stubScripts(`${WRITE_NAMES}\n${body}`);
    try {
      const result = selectThrough(scripts);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), {
        name: "OfflineTestNamesUnavailable",
        code: "OFFLINE_TEST_NAMES_UNAVAILABLE",
        message: `OFFLINE_TEST_NAMES_UNAVAILABLE: scripts/ensure-derived.mjs exited ${status} before ./offline-test-env.generated.mjs could load; its own message above names the cause. Fix it, then run: npm --prefix packages/runtime run generate:pins`,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

it("runs its command line when invoked through a symlink", () => {
  const root = mkdtempSync(join(tmpdir(), "docsfab-offline-link-"));
  try {
    const link = join(root, "offline-test-environment-link.mjs");
    symlinkSync(resolve(import.meta.dirname, "offline-test-environment.mjs"), link);
    const result = spawnSync(process.execPath, [link], { encoding: "utf8" });
    // An unresolved entry check would skip the command line and exit 0.
    assert.equal(result.status, 2, result.stderr);
    assert.equal(
      result.stderr,
      "Usage: node scripts/offline-test-environment.mjs <check-command> [arguments]\n",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
