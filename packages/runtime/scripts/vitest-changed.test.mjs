// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
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
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const testApi = process.env.VITEST ? await import("vitest") : await import("node:test");
const { afterEach, describe, it } = testApi;
const longIt = (name, body) =>
  process.env.VITEST ? it(name, body, 20_000) : it(name, { timeout: 20_000 }, body);
// Only Vitest can load the catalog-backed budget helper; under plain
// `node --test` its TypeScript imports do not resolve.
const testTimeouts = process.env.VITEST
  ? await import("../test/helpers/test-timeouts.ts")
  : undefined;
// waitForFile's contract caller (the synchronized-contender case) is a plain
// case, so under Vitest its enclosing budget is the shared default
// (test.localTimeoutMs, and test.ciTimeoutMs in CI). The wait takes a smaller
// share of it through nestedDeadlineMs(), so its own message lands before
// that case times out. Plain `node --test` sets no per-case timeout, so there
// the local share alone bounds the wait.
const WAIT_FOR_FILE_LOCAL_MS = 4_000;
const defaultCaseLocalMs = () => testTimeouts.vitestDefaultTimeouts({}).testTimeout;
const WAIT_FOR_FILE_TIMEOUT_MS = testTimeouts
  ? testTimeouts.nestedDeadlineMs(WAIT_FOR_FILE_LOCAL_MS, defaultCaseLocalMs())
  : WAIT_FOR_FILE_LOCAL_MS;

const script = join(dirname(fileURLToPath(import.meta.url)), "vitest-changed.mjs");
const installedModules = join(dirname(script), "..", "node_modules");
const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {}
  }
});

function command(cwd, executable, args, options = {}) {
  const result = spawnSync(executable, args, { cwd, encoding: "utf8", ...options });
  assert.equal(result.status, 0, `${executable} ${args.join(" ")} failed:\n${result.stderr}`);
  return result.stdout.trim();
}

function write(root, path, contents = `${path}\n`) {
  const destination = join(root, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, contents);
  return destination;
}

function git(root, ...args) {
  return command(root, "git", args);
}

function commit(root, message = "fixture") {
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", message);
  return git(root, "rev-parse", "HEAD");
}

function repository() {
  const root = mkdtempSync(join(tmpdir(), "docsfab-vitest-changed-repo-"));
  roots.push(root);
  mkdirSync(join(root, "packages/runtime/scripts"), { recursive: true });
  copyFileSync(script, join(root, "packages/runtime/scripts/vitest-changed.mjs"));
  for (const name of ["offline-test-environment.mjs", "offline-test-env.generated.mjs"])
    copyFileSync(join(dirname(script), name), join(root, "packages/runtime/scripts", name));
  copyFileSync(
    join(dirname(script), "../src/config/private-content-paths.js"),
    write(root, "packages/runtime/src/config/private-content-paths.js", ""),
  );
  // The runner's shared generation step; this fixture has nothing to generate.
  write(root, "packages/runtime/scripts/ensure-derived.mjs", "");
  write(root, "packages/runtime/package.json", '{"name":"fixture","type":"module"}\n');
  write(root, "README.md", "fixture\n");
  git(root, "init", "-q");
  git(root, "config", "user.email", "fixture@example.invalid");
  git(root, "config", "user.name", "Fixture");
  const base = commit(root, "base");
  return { root, runtime: join(root, "packages/runtime"), base };
}

function sentinel(mode = "pass") {
  const root = mkdtempSync(join(tmpdir(), "docsfab-vitest-changed-runner-"));
  roots.push(root);
  const log = join(root, "calls.jsonl");
  const executable = join(root, "npx");
  writeFileSync(
    executable,
    `#!${process.execPath}\n` +
      `const fs = require("node:fs");\n` +
      `const control = JSON.parse(fs.readFileSync(require("node:path").join(__dirname, "control.json"), "utf8"));\n` +
      `const args = process.argv.slice(2);\n` +
      `fs.writeFileSync(require("node:path").join(__dirname, "environment.json"), JSON.stringify({ names: Object.keys(process.env), offline: process.env.PI_OFFLINE, ci: process.env.CI, workers: process.env.VITEST_MAX_WORKERS }));\n` +
      `fs.appendFileSync(control.log, JSON.stringify(args) + "\\n");\n` +
      `const output = args.find((arg) => arg.startsWith("--outputFile="));\n` +
      `if (control.mode !== "missing-report" && output) {\n` +
      `  const reports = { pass: { numPassedTests: 2, numFailedTests: 0, numPendingTests: 0 }, zero: { numPassedTests: 0, numFailedTests: 0, numPendingTests: 0 }, skipped: { numPassedTests: 0, numFailedTests: 0, numPendingTests: 2 }, nonzero: { numPassedTests: 1, numFailedTests: 0, numPendingTests: 0 }, failed: { numPassedTests: 1, numFailedTests: 2, numPendingTests: 0, testResults: [{ name: require("node:path").join(process.cwd(), "test/direct.test.ts"), status: "failed", assertionResults: [{ status: "passed", title: "passes", ancestorTitles: ["suite"] }, { status: "failed", title: "times out", ancestorTitles: ["suite", "under load"], duration: 5003.4, failureMessages: ["Error: STACK_TRACE_ERROR\\n    at stack"] }, { status: "failed", title: "asserts", ancestorTitles: [], failureMessages: ["AssertionError: expected 1 to be 2\\n    at stack"] }] }, { name: require("node:path").join(process.cwd(), "test/broken.test.ts"), status: "failed", message: "Failed to load url ./missing\\n    at stack", assertionResults: [] }] } };\n` +
      `  fs.writeFileSync(output.slice("--outputFile=".length), JSON.stringify(reports[control.mode] || reports.pass));\n` +
      `}\n` +
      `if (control.replace_lock) fs.writeFileSync(control.replace_lock, JSON.stringify({ pid: 999999, token: "replacement" }) + "\\n");\n` +
      `const hold = Number(control.hold_ms || 0);\n` +
      `if (Number.isFinite(hold) && hold > 0) {\n` +
      `  const end = Date.now() + hold;\n` +
      `  while (Date.now() < end) {}\n` +
      `}\n` +
      `process.exitCode = control.mode === "nonzero" ? 7 : control.mode === "failed" ? 1 : 0;\n`,
  );
  chmodSync(executable, 0o755);
  return { root, log, mode };
}

function configureSentinel(runner, extraEnv) {
  writeFileSync(
    join(runner.root, "control.json"),
    JSON.stringify({
      log: runner.log,
      mode: runner.mode,
      hold_ms: extraEnv.SENTINEL_HOLD_MS,
      replace_lock: extraEnv.SENTINEL_REPLACE_LOCK,
    }),
  );
}

function invoke(fixture, args, runner = sentinel(), extraEnv = {}) {
  configureSentinel(runner, extraEnv);
  const result = spawnSync(
    process.execPath,
    [join(fixture.runtime, "scripts/vitest-changed.mjs"), ...args],
    {
      cwd: fixture.runtime,
      env: {
        ...process.env,
        PATH: `${runner.root}:${process.env.PATH}`,
        SENTINEL_LOG: runner.log,
        SENTINEL_MODE: runner.mode,
        DOCSFAB_TEST_CHANGED_PATHS: "",
        DOCSFAB_TEST_CHANGED_ALLOW_RELATED: "",
        DOCSFAB_VITEST_GRAPH_LOCK_PATH: join(fixture.root, "vitest-graph.lock"),
        ...extraEnv,
      },
      encoding: "utf8",
    },
  );
  return { ...result, calls: readCalls(runner.log) };
}

function startInvoke(fixture, args, runner = sentinel(), extraEnv = {}) {
  configureSentinel(runner, extraEnv);
  const child = spawn(
    process.execPath,
    [join(fixture.runtime, "scripts/vitest-changed.mjs"), ...args],
    {
      cwd: fixture.runtime,
      env: {
        ...process.env,
        PATH: runner.root + ":" + process.env.PATH,
        SENTINEL_LOG: runner.log,
        SENTINEL_MODE: runner.mode,
        DOCSFAB_TEST_CHANGED_PATHS: "",
        DOCSFAB_TEST_CHANGED_ALLOW_RELATED: "",
        DOCSFAB_VITEST_GRAPH_LOCK_PATH: join(fixture.root, "vitest-graph.lock"),
        ...extraEnv,
      },
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const done = new Promise((resolve) => {
    child.on("close", (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
  return { child, done };
}

/**
 * Polls every 5 ms until `path` exists, up to a deadline, so a child that
 * stalls before writing the file cannot hang the case.
 */
async function waitForFile(path, timeoutMilliseconds = WAIT_FOR_FILE_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (!existsSync(path)) {
    if (Date.now() > deadline)
      throw new Error(`${path} was not created within ${timeoutMilliseconds}ms`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function readCalls(path) {
  try {
    return readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function assertPassed(result) {
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /completed [1-9][0-9]* non-skipped test/u);
}

function assertRouted(result, ...values) {
  assertPassed(result);
  for (const value of values) {
    assert.ok(
      result.calls.some((call) => call.includes(value)),
      `${value} absent from ${JSON.stringify(result.calls)}`,
    );
  }
}

function relatedArgs(args) {
  return ["--allow-related", ...args];
}

function createRelated(fixture, path, contents = "export const fixture = true;\n") {
  write(fixture.runtime, path, contents);
}

function commitPath(fixture, path, contents) {
  write(fixture.root, path, contents);
  commit(fixture.root, path);
}

describe("waitForFile (test-harness deadline, not product behavior)", () => {
  if (testTimeouts) {
    it("keeps waitForFile's deadline strictly inside the default case budget, locally and in CI", () => {
      // The value the synchronized-contender case uses, in this run's environment.
      assert.ok(
        WAIT_FOR_FILE_TIMEOUT_MS < testTimeouts.vitestDefaultTimeouts().testTimeout,
        `${WAIT_FOR_FILE_TIMEOUT_MS} must be below the default case budget`,
      );
      for (const environment of [{}, { CI: "true" }]) {
        const wait = testTimeouts.nestedDeadlineMs(
          WAIT_FOR_FILE_LOCAL_MS,
          defaultCaseLocalMs(),
          environment,
        );
        const enclosing = testTimeouts.vitestDefaultTimeouts(environment).testTimeout;
        assert.ok(wait < enclosing, `${wait} must be below ${enclosing}`);
      }
    });
  }

  it("returns once the path exists", async () => {
    const root = mkdtempSync(join(tmpdir(), "docsfab-wait-for-file-ok-"));
    roots.push(root);
    const marker = join(root, "marker");
    const pending = waitForFile(marker);
    setTimeout(() => writeFileSync(marker, "ready\n"), 10);
    await pending;
    assert.ok(existsSync(marker));
  });

  // Adjacent condition to the case above: the path never appears. Deleting
  // the deadline check makes this case poll forever instead of failing with
  // the message below.
  it("fails with its own message when the path never appears", async () => {
    const root = mkdtempSync(join(tmpdir(), "docsfab-wait-for-file-timeout-"));
    roots.push(root);
    const marker = join(root, "never-created");
    await assert.rejects(
      () => waitForFile(marker, 50),
      (error) => error.message === `${marker} was not created within 50ms`,
    );
  });
});

describe("vitest-changed contract", () => {
  it("normalizes a committed repository-relative runtime change", () => {
    const fixture = repository();
    commitPath(fixture, "packages/runtime/src/probe.ts", "export const probe = 1;\n");
    const result = invoke(fixture, relatedArgs(["--base", fixture.base]));
    assertRouted(result, "src/probe.ts");
    assert.match(result.stderr, /src\/probe\.ts -> Vitest related/u);
  });

  it("refuses Vitest related without --allow-related and does not launch a runner", () => {
    const fixture = repository();
    commitPath(fixture, "packages/runtime/src/probe.ts", "export const probe = 1;\n");
    const result = invoke(fixture, ["--base", fixture.base]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /related inputs: 1/u);
    assert.match(result.stderr, /refused Vitest related \(1 path\(s\)\)/u);
    assert.match(result.stderr, /Name the tests with --paths/u);
    assert.deepEqual(result.calls, []);
  });

  longIt("refuses related source --paths unless --allow-related is set", () => {
    const fixture = repository();
    createRelated(fixture, "src/probe.ts");
    write(fixture.runtime, "test/direct.test.ts", "void 0;\n");
    const sourceOnly = invoke(fixture, ["--paths", "src/probe.ts"]);
    assert.notEqual(sourceOnly.status, 0);
    assert.match(sourceOnly.stderr, /refused Vitest related/u);
    assert.deepEqual(sourceOnly.calls, []);
    const mixed = invoke(fixture, ["--paths", "src/probe.ts,test/direct.test.ts"]);
    assert.notEqual(mixed.status, 0);
    assert.deepEqual(mixed.calls, []);
    createRelated(fixture, "src/from-env.ts");
    const envAllowed = invoke(fixture, ["--paths", "src/from-env.ts"], sentinel(), {
      DOCSFAB_TEST_CHANGED_ALLOW_RELATED: "true",
    });
    assertRouted(envAllowed, "src/from-env.ts");
  });

  it("rejects a malformed related-allow environment value before discovery", () => {
    const fixture = repository();
    createRelated(fixture, "src/probe.ts");
    const result = invoke(fixture, ["--paths", "src/probe.ts"], sentinel(), {
      DOCSFAB_TEST_CHANGED_ALLOW_RELATED: "maybe",
    });
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /DOCSFAB_TEST_CHANGED_ALLOW_RELATED must be 1, true, yes, 0, false, or no/u,
    );
    assert.deepEqual(result.calls, []);
  });

  it("refuses a second Vitest graph while the host lock is held", () => {
    const fixture = repository();
    write(fixture.runtime, "test/direct.test.ts", "void 0;\n");
    const lockPath = join(fixture.root, "shared-graph.lock");
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: "live" }) + "\n");
    const result = invoke(fixture, ["--paths", "test/direct.test.ts"], sentinel(), {
      DOCSFAB_VITEST_GRAPH_LOCK_PATH: lockPath,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /another Vitest graph holds runtime\.vitest\.graphLock/u);
    assert.match(result.stderr, new RegExp(`pid ${process.pid}`));
    assert.deepEqual(result.calls, []);
    assert.equal(
      readFileSync(lockPath, "utf8"),
      JSON.stringify({ pid: process.pid, token: "live" }) + "\n",
    );
  });

  it("fails closed on an incomplete graph lock", () => {
    const fixture = repository();
    write(fixture.runtime, "test/direct.test.ts", "void 0;\n");
    const lockPath = join(fixture.root, "incomplete-graph.lock");
    writeFileSync(lockPath, "");
    const result = invoke(fixture, ["--paths", "test/direct.test.ts"], sentinel(), {
      DOCSFAB_VITEST_GRAPH_LOCK_PATH: lockPath,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /incomplete, unreadable, or stale ownership/u);
    assert.match(result.stderr, /remove the lock file manually/u);
    assert.deepEqual(result.calls, []);
    assert.equal(readFileSync(lockPath, "utf8"), "");
  });

  it("fails closed on a stale graph lock owner", () => {
    const fixture = repository();
    write(fixture.runtime, "test/direct.test.ts", "void 0;\n");
    const lockPath = join(fixture.root, "stale-graph.lock");
    const dead = spawnSync(process.execPath, ["-e", ""], { encoding: "utf8" });
    assert.ok(dead.pid, "need a completed child process to prove stale-lock refusal");
    writeFileSync(lockPath, JSON.stringify({ pid: dead.pid, token: "stale" }) + "\n");
    const result = invoke(fixture, ["--paths", "test/direct.test.ts"], sentinel(), {
      DOCSFAB_VITEST_GRAPH_LOCK_PATH: lockPath,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /incomplete, unreadable, or stale ownership/u);
    assert.deepEqual(result.calls, []);
    assert.equal(
      readFileSync(lockPath, "utf8"),
      JSON.stringify({ pid: dead.pid, token: "stale" }) + "\n",
    );
  });

  it("admits exactly one synchronized contender and preserves its lock", async () => {
    const fixture = repository();
    write(fixture.runtime, "test/direct.test.ts", "void 0;\n");
    const runner = sentinel();
    const winner = startInvoke(fixture, ["--paths", "test/direct.test.ts"], runner, {
      SENTINEL_HOLD_MS: "500",
    });
    try {
      await waitForFile(runner.log);
      const loser = startInvoke(fixture, ["--paths", "test/direct.test.ts"], runner);
      const loserResult = await loser.done;
      assert.notEqual(loserResult.status, 0);
      assert.match(loserResult.stderr, /another Vitest graph holds runtime\.vitest\.graphLock/u);
      assert.equal(readCalls(runner.log).length, 1);
      assert.equal(
        JSON.parse(readFileSync(join(fixture.root, "vitest-graph.lock"), "utf8")).pid,
        winner.child.pid,
      );
      const winnerResult = await winner.done;
      assert.equal(winnerResult.status, 0, winnerResult.stderr);
      assert.equal(existsSync(join(fixture.root, "vitest-graph.lock")), false);
    } finally {
      if (winner.child.exitCode === null) winner.child.kill("SIGTERM");
    }
  });

  it("does not remove a replacement lock during old-owner cleanup", () => {
    const fixture = repository();
    write(fixture.runtime, "test/direct.test.ts", "void 0;\n");
    const lockPath = join(fixture.root, "replacement-graph.lock");
    const runner = sentinel();
    const result = invoke(fixture, ["--paths", "test/direct.test.ts"], runner, {
      DOCSFAB_VITEST_GRAPH_LOCK_PATH: lockPath,
      SENTINEL_REPLACE_LOCK: lockPath,
    });
    assertPassed(result);
    assert.equal(
      readFileSync(lockPath, "utf8"),
      JSON.stringify({ pid: 999999, token: "replacement" }) + "\n",
    );
  });

  it("reports a valid empty diff without launching a runner", () => {
    const fixture = repository();
    const runner = sentinel();
    const result = invoke(fixture, ["--base", "HEAD"], runner);
    assert.equal(result.status, 0);
    assert.match(result.stderr, /empty change set/u);
    assert.deepEqual(result.calls, []);
  });

  it("treats an unavailable base as an actionable error", () => {
    const fixture = repository();
    const result = invoke(fixture, ["--base", "refs/heads/no-such-base"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unable to discover changed paths.*no-such-base/su);
    assert.deepEqual(result.calls, []);
  });

  it("fails when the base and HEAD have no merge base", () => {
    const fixture = repository();
    const tree = git(fixture.root, "rev-parse", "HEAD^{tree}");
    const unrelated = git(fixture.root, "commit-tree", tree, "-m", "unrelated root");
    const result = invoke(fixture, ["--base", unrelated]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /no merge base/u);
    assert.deepEqual(result.calls, []);
  });

  longIt("accepts package-relative, repository-relative, and canonical environment paths", () => {
    const fixture = repository();
    createRelated(fixture, "src/explicit.ts");
    assertRouted(invoke(fixture, relatedArgs(["--paths", "src/explicit.ts"])), "src/explicit.ts");
    assertRouted(
      invoke(fixture, relatedArgs(["--paths", "packages/runtime/src/explicit.ts"])),
      "src/explicit.ts",
    );
    assertRouted(
      invoke(fixture, relatedArgs([]), sentinel(), {
        DOCSFAB_TEST_CHANGED_PATHS: "packages/runtime/src/explicit.ts",
      }),
      "src/explicit.ts",
    );
    write(fixture.runtime, "test/direct snow 雪.test.ts", "void 0;\n");
    assertRouted(
      invoke(fixture, ["--paths", "test/direct snow 雪.test.ts"]),
      "test/direct snow 雪.test.ts",
    );
  });

  longIt("executes a tracked package-local test outside the standard test directories", () => {
    const fixture = repository();
    commitPath(fixture, "packages/runtime/extra-tests/pack.test.ts", "void 0;\n");
    const result = invoke(fixture, ["--paths", "extra-tests/pack.test.ts"]);
    assertRouted(result, "extra-tests/pack.test.ts");
    assert.match(result.stderr, /extra-tests\/pack\.test\.ts -> direct test/u);
    assertRouted(
      invoke(fixture, ["--paths", "packages/runtime/extra-tests/pack.test.ts"]),
      "extra-tests/pack.test.ts",
    );
    assertRouted(invoke(fixture, ["--base", fixture.base]), "extra-tests/pack.test.ts");

    write(fixture.root, "packages/host/test/pack.test.ts", "void 0;\n");
    const outside = invoke(fixture, ["--paths", "packages/host/test/pack.test.ts"]);
    assert.equal(outside.status, 0, outside.stderr);
    assert.match(outside.stderr, /only unrelated paths/u);
    assert.deepEqual(outside.calls, []);
  });

  it("lets explicit input bypass an invalid base", () => {
    const fixture = repository();
    createRelated(fixture, "src/explicit.ts");
    assertRouted(
      invoke(
        fixture,
        relatedArgs(["--base", "refs/heads/no-such-base", "--paths", "src/explicit.ts"]),
      ),
      "src/explicit.ts",
    );
  });

  it("keeps dirty discovery opt-in", () => {
    const fixture = repository();
    commitPath(fixture, "packages/runtime/src/dirty.ts", "export const dirty = 1;\n");
    write(fixture.runtime, "src/dirty.ts", "export const dirty = 2;\n");
    const result = invoke(fixture, ["--base", "HEAD"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /empty change set/u);
    assert.deepEqual(result.calls, []);
  });

  for (const [name, prepare] of [
    [
      "staged",
      (fixture) => {
        createRelated(fixture, "src/staged.ts");
        git(fixture.root, "add", "packages/runtime/src/staged.ts");
      },
    ],
    [
      "unstaged",
      (fixture) => {
        commitPath(fixture, "packages/runtime/src/unstaged.ts", "export const value = 1;\n");
        write(fixture.runtime, "src/unstaged.ts", "export const value = 2;\n");
      },
    ],
    ["untracked", (fixture) => createRelated(fixture, "src/untracked.ts")],
  ]) {
    it(`discovers a dirty ${name} path`, () => {
      const fixture = repository();
      prepare(fixture);
      const result = invoke(fixture, relatedArgs(["--base", "HEAD", "--dirty"]));
      assertRouted(result, `src/${name}.ts`);
    });
  }

  for (const [name, oldPath, newPath] of [
    ["inside runtime", "packages/runtime/src/old.ts", "packages/runtime/src/new.ts"],
    ["into runtime", "outside/old.ts", "packages/runtime/src/new.ts"],
    ["out of runtime", "packages/runtime/src/old.ts", "outside/new.ts"],
  ]) {
    it(`retains both sides of a rename ${name}`, () => {
      const fixture = repository();
      commitPath(fixture, oldPath, "export const renamed = 'same content long enough';\n");
      mkdirSync(dirname(join(fixture.root, newPath)), { recursive: true });
      git(fixture.root, "mv", oldPath, newPath);
      const result = invoke(fixture, relatedArgs(["--base", "HEAD", "--dirty"]));
      assertPassed(result);
      assert.match(result.stderr, new RegExp(oldPath.replace("packages/runtime/", "")));
      if (newPath.startsWith("packages/runtime/")) {
        assert.match(result.stderr, new RegExp(newPath.replace("packages/runtime/", "")));
      }
      if (oldPath.startsWith("packages/runtime/")) assert.match(result.stderr, /full suite/u);
    });
  }

  it("retains deleted source and test paths with a conservative full-suite route", () => {
    const fixture = repository();
    commitPath(fixture, "packages/runtime/src/deleted.ts", "export const deleted = true;\n");
    commitPath(fixture, "packages/runtime/test/deleted.test.ts", "void 0;\n");
    git(
      fixture.root,
      "rm",
      "packages/runtime/src/deleted.ts",
      "packages/runtime/test/deleted.test.ts",
    );
    const result = invoke(fixture, ["--base", "HEAD", "--dirty"]);
    assertPassed(result);
    assert.match(result.stderr, /src\/deleted\.ts -> full suite \(deleted static input\)/u);
    assert.match(result.stderr, /test\/deleted\.test\.ts -> full suite \(deleted test\)/u);
    assert.equal(result.calls.length, 1);
    assert.ok(!result.calls[0].includes("src/deleted.ts"));
  });

  longIt("refuses an explicit missing test by name and never launches the full suite", () => {
    const fixture = repository();
    write(fixture.runtime, "test/direct.test.ts", "void 0;\n");
    for (const [args, extraEnv] of [
      [["--paths", "test/does-not-exist.test.ts"], {}],
      [["--paths=packages/runtime/test/does-not-exist.test.ts"], {}],
      [["--paths", "test/direct.test.ts,test/does-not-exist.test.ts"], {}],
      [[], { DOCSFAB_TEST_CHANGED_PATHS: "test/does-not-exist.test.ts" }],
    ]) {
      const result = invoke(fixture, args, sentinel(), extraEnv);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /refused explicit --paths: 1 path\(s\) match no file/u);
      assert.match(result.stderr, /^ {2}"test\/does-not-exist\.test\.ts"$/mu);
      assert.match(result.stderr, /No tests were run/u);
      assert.match(result.stderr, /the full suite belongs to CI/u);
      assert.match(result.stderr, /comma-separated quoting/u);
      assert.doesNotMatch(result.stderr, /full suite \(deleted test\)/u);
      assert.deepEqual(result.calls, []);
      assert.equal(existsSync(join(fixture.root, "vitest-graph.lock")), false);
    }
  });

  it("refuses every explicit missing input before any fallback route", () => {
    const fixture = repository();
    const missing = [
      "src/missing.ts",
      "workflows/missing.json",
      "package-lock.json",
      "test/fixtures/missing.json",
      "packages/host/test/missing.test.ts",
    ];
    const result = invoke(fixture, relatedArgs(["--paths", missing.join(",")]));
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /refused explicit --paths: 5 path\(s\) match no file/u);
    for (const path of missing)
      assert.ok(result.stderr.includes(`  ${JSON.stringify(path)}`), `${path} not named`);
    assert.doesNotMatch(result.stderr, /-> full suite|only unrelated paths/u);
    assert.deepEqual(result.calls, []);
  });

  longIt("diagnoses a whole path list passed as one unsplit string", () => {
    const fixture = repository();
    write(fixture.runtime, "test/one.test.ts", "void 0;\n");
    write(fixture.runtime, "test/two.test.ts", "void 0;\n");
    const result = invoke(fixture, ["--paths", "test/one.test.ts test/two.test.ts"]);
    assert.equal(result.status, 1, result.stderr);
    assert.match(
      result.stderr,
      /"test\/one\.test\.ts test\/two\.test\.ts" \(contains whitespace and matches no file: this looks like a whole list passed as one string\. Separate paths with commas or repeat --paths/u,
    );
    assert.match(result.stderr, /the full suite belongs to CI/u);
    assert.deepEqual(result.calls, []);
    const split = invoke(fixture, ["--paths", "test/one.test.ts, test/two.test.ts"]);
    assertRouted(split, "test/one.test.ts", "test/two.test.ts");
  });

  longIt("keeps the Git deleted-file full-suite fallback that explicit paths refuse", () => {
    const fixture = repository();
    commitPath(fixture, "packages/runtime/test/deleted.test.ts", "void 0;\n");
    git(fixture.root, "rm", "-q", "packages/runtime/test/deleted.test.ts");
    const deletedBase = commit(fixture.root, "delete test");
    const fromGit = invoke(fixture, ["--base", `${deletedBase}~1`]);
    assertPassed(fromGit);
    assert.match(fromGit.stderr, /test\/deleted\.test\.ts -> full suite \(deleted test\)/u);
    assert.equal(fromGit.calls.length, 1);
    assert.ok(!fromGit.calls[0].includes("test/deleted.test.ts"));
    const named = invoke(fixture, ["--paths", "test/deleted.test.ts"]);
    assert.equal(named.status, 1, named.stderr);
    assert.match(named.stderr, /refused explicit --paths/u);
    assert.deepEqual(named.calls, []);
  });

  it("names each failed test with its file, title, and first failure line", () => {
    const fixture = repository();
    write(fixture.runtime, "test/direct.test.ts", "void 0;\n");
    const result = invoke(fixture, ["--paths", "test/direct.test.ts"], sentinel("failed"));
    assert.equal(result.status, 1, result.stderr);
    assert.match(
      result.stderr,
      /^vitest-changed: run test\/direct\.test\.ts executed 3 test\(s\), 2 failed \[test\/direct\.test\.ts > suite > under load > times out; test\/direct\.test\.ts > asserts; test\/broken\.test\.ts \(file failed\)\], runner exit 1$/mu,
    );
    assert.match(
      result.stderr,
      /^ {2}FAIL test\/direct\.test\.ts > suite > under load > times out: Vitest test or hook timeout after 5003ms \(the JSON report keeps only Vitest's Error: STACK_TRACE_ERROR placeholder\)$/mu,
    );
    assert.match(
      result.stderr,
      /^ {2}FAIL test\/direct\.test\.ts > asserts: AssertionError: expected 1 to be 2$/mu,
    );
    assert.match(
      result.stderr,
      /^ {2}FAIL test\/broken\.test\.ts \(file failed\): Failed to load url \.\/missing$/mu,
    );
    assert.doesNotMatch(result.stderr, /passes|at stack|does not name every failed test/u);
  });

  it("preserves whitespace and Unicode pathnames through NUL-separated Git output", () => {
    const fixture = repository();
    const path = "packages/runtime/src/space 雪 probe.ts";
    commitPath(fixture, path, "export const snow = true;\n");
    const result = invoke(fixture, relatedArgs(["--base", fixture.base]));
    assertRouted(result, "src/space 雪 probe.ts");
  });

  it("reports an outside-package unrelated change without launching a runner", () => {
    const fixture = repository();
    commitPath(fixture, "docs/guide.md", "guide\n");
    const result = invoke(fixture, ["--base", fixture.base]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /only unrelated paths/u);
    assert.deepEqual(result.calls, []);
  });

  longIt("rejects malformed or misplaced selector options", () => {
    const fixture = repository();
    commitPath(fixture, "packages/runtime/src/changed.ts", "export const changed = true;\n");
    for (const args of [
      ["--base"],
      ["--base", ""],
      ["--base", " "],
      ["--base="],
      ["--base= "],
      ["--base", "--dirty"],
      ["--paths"],
      ["--paths", ""],
      ["--paths", " "],
      ["--paths="],
      ["--paths= "],
      ["--paths", "--dirty"],
      ["--unknown"],
    ]) {
      const result = invoke(fixture, args);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /requires a value|unknown selector option/u);
      assert.deepEqual(result.calls, []);
    }
    const emptyEnvironment = invoke(fixture, [], sentinel(), {
      DOCSFAB_TEST_CHANGED_PATHS: " , \n ",
    });
    assert.notEqual(emptyEnvironment.status, 0);
    assert.match(emptyEnvironment.stderr, /--paths requires a value/u);
    assert.deepEqual(emptyEnvironment.calls, []);
  });

  it("reports an unavailable runner", () => {
    const fixture = repository();
    createRelated(fixture, "src/probe.ts");
    const emptyRoot = mkdtempSync(join(tmpdir(), "docsfab-vitest-changed-no-runner-"));
    roots.push(emptyRoot);
    const runner = { root: emptyRoot, log: join(emptyRoot, "calls.jsonl"), mode: "pass" };
    const result = invoke(fixture, relatedArgs(["--paths", "src/probe.ts"]), runner, {
      PATH: runner.root,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unable to launch Vitest runner/u);
  });

  it("preserves a nonzero runner exit even when its report contains a passing test", () => {
    const fixture = repository();
    createRelated(fixture, "src/probe.ts");
    const result = invoke(fixture, relatedArgs(["--paths", "src/probe.ts"]), sentinel("nonzero"));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /runner exit 7/u);
  });

  it("keeps direct and related invocations isolated and fails either zero result", () => {
    const fixture = repository();
    createRelated(fixture, "src/probe.ts");
    write(fixture.runtime, "test/direct.test.ts", "void 0;\n");
    const pass = invoke(fixture, relatedArgs(["--paths", "src/probe.ts,test/direct.test.ts"]));
    assertPassed(pass);
    assert.equal(pass.calls.length, 2);
    assert.ok(
      pass.calls.some((call) => call.includes("run") && call.includes("test/direct.test.ts")),
    );
    assert.ok(pass.calls.some((call) => call.includes("related") && call.includes("src/probe.ts")));
    const zero = invoke(
      fixture,
      relatedArgs(["--paths", "src/probe.ts,test/direct.test.ts"]),
      sentinel("zero"),
    );
    assert.notEqual(zero.status, 0);
    assert.equal(zero.calls.length, 2);
    assert.match(zero.stderr, /0 non-skipped test/u);
  });

  longIt("rejects zero, all-skipped, missing-report, and masking controls", () => {
    const fixture = repository();
    write(fixture.runtime, "test/direct.test.ts", "void 0;\n");
    for (const mode of ["zero", "skipped", "missing-report"]) {
      const result = invoke(fixture, ["--paths", "test/direct.test.ts"], sentinel(mode));
      assert.notEqual(result.status, 0, `${mode} unexpectedly passed`);
    }
    for (const control of [
      "--passWithNoTests",
      "--passWithNoTests=true",
      "-t",
      "--testNamePattern",
      "--reporter=dot",
      "--reporter",
      "--outputFile=result.json",
      "--outputFile",
      "--config=other.ts",
      "--config",
      "-c",
      "--exclude=anything",
      "--include=one.test.ts",
      "--shard=1/2",
      "--changed",
      "--root=elsewhere",
      "--dir=elsewhere",
      "--project=one",
      "related",
      "another.test.ts",
    ]) {
      const result = invoke(fixture, ["--paths", "test/direct.test.ts", "--", control]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /not an allowed non-selection Vitest option/u);
      assert.deepEqual(result.calls, []);
    }
  });

  it("rejects passthrough controls that could mask zero execution", () => {
    const fixture = repository();
    write(fixture.runtime, "test/direct.test.ts", "void 0;\n");
    const result = invoke(fixture, ["--paths", "test/direct.test.ts", "--", "--passWithNoTests"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not an allowed non-selection Vitest option/u);
  });

  it("passes passthrough values as inert data with shell execution disabled", () => {
    const fixture = repository();
    write(fixture.runtime, "test/direct.test.ts", "void 0;\n");
    const marker = join(fixture.root, "must-not-exist");
    const payload = `$(touch ${marker})`;
    const result = invoke(fixture, [
      "--paths",
      "test/direct.test.ts",
      "--",
      "--testTimeout",
      payload,
    ]);
    assertPassed(result);
    assert.ok(result.calls[0].includes(payload));
    assert.equal(relative(fixture.root, marker), "must-not-exist");
    assert.equal(existsSync(marker), false);
  });

  longIt("routes the audited dynamic and filesystem families to named existing suites", () => {
    const fixture = repository();
    createRelated(fixture, "test/helpers/helper.ts");
    const cases = [
      ["workflows/create-documentation.json", null],
      ["packages/skills/audit-documentation/SKILL.md", null],
      ["packages/quality/checks/link.yml", null],
      ["packages/quality/formats/html/config.json", null],
      ["packages/quality/profiles/example/profile.yml", null],
      ["packages/quality/rubrics/default.md", null],
      ["packages/quality/schemas/report.json", null],
      ["quality/checks/link.yml", "test/quality-pack.test.ts"],
      ["quality-pack/manifest.json", "test/quality-pack.test.ts"],
      ["skill-crate/audit-documentation/SKILL.md", "test/catalog-skill-crate.test.ts"],
      ["skill-crate/verify-technical-accuracy/SKILL.md", "test/package-compose-golden.test.ts"],
      [
        "skill-crate/verify-technical-accuracy/references/example-checks.md",
        "test/package-compose-golden.test.ts",
      ],
      ["skill-crate/lock.json", "test/package-compose-golden.test.ts"],
      ["governed-assets/lock.json", "test/governed-asset-catalog.test.ts"],
      ["packages/knowledge/src/cli.mjs", null],
      ["scripts/generate-quality-pack.mjs", null],
      ["qualification-kits/portable-contract/manifest.json", null],
      ["package.json", null],
      ["package-lock.json", null],
      ["npm-shrinkwrap.json", null],
      ["vitest.config.ts", null],
      [".gitlab/ci/runtime.yml", null],
      ["scripts/ci-heavy/docs.txt", null],
      ["test/helpers/helper.ts", "test/helpers/helper.ts"],
    ];
    for (const [path, expected] of cases) {
      if (!existsSync(join(fixture.runtime, path)))
        write(/^(?:packages|\.gitlab)\//u.test(path) ? fixture.root : fixture.runtime, path);
      const result = invoke(fixture, relatedArgs(["--paths", path]));
      if (expected) assertRouted(result, expected);
      else {
        assertPassed(result);
        assert.match(result.stderr, /full suite/u);
        assert.equal(result.calls.length, 1);
      }
      if (/^(?:workflows|packages\/quality|quality(?:-pack)?\/)/u.test(path)) {
        assert.ok(!result.calls.some((call) => call.includes("test/ci-smoke-membership.test.ts")));
      }
    }
  });

  it("normalizes and classifies the retained synthetic 22-runtime-path shape", () => {
    const fixture = repository();
    const paths = [
      "quality/checks/links.yml",
      "quality/checks/style.yml",
      "quality/formats/html/config.json",
      "quality/formats/html/rules.json",
      "quality/profiles/docsfab-documentation-quality/profile.yml",
      "quality/profiles/example-public-docs/profile.yml",
      "quality/profiles/nvidia-technical-documentation/profile.yml",
      "quality/rubrics/accuracy.md",
      "quality/rubrics/completeness.md",
      "quality/rubrics/style.md",
      "quality/schemas/finding.json",
      "quality/schemas/report.json",
      "quality-pack/manifest.json",
      "quality-pack/checks/links.yml",
      "quality-pack/formats/html/config.json",
      "quality-pack/profiles/docsfab-documentation-quality/profile.yml",
      "quality-pack/rubrics/accuracy.md",
      "quality-pack/schemas/finding.json",
      "governed-assets/lock.json",
      "skill-crate/audit-documentation/SKILL.md",
      "workflows/create-documentation.json",
      "scripts/generate-derived.mjs",
    ].map((path) => `packages/runtime/${path}`);
    for (const path of paths) write(fixture.root, path);
    const result = invoke(fixture, ["--paths", paths.join(",")]);
    assertPassed(result);
    assert.equal(paths.length, 22);
    for (const path of paths) {
      assert.match(
        result.stderr,
        new RegExp(path.slice("packages/runtime/".length).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")),
      );
    }
    assert.doesNotMatch(result.stderr, /executed 22 test/u);
  });

  if (process.argv.includes("--real-vitest")) {
    function realFixture() {
      const fixture = repository();
      symlinkSync(installedModules, join(fixture.runtime, "node_modules"), "dir");
      return fixture;
    }

    it("runs a passing disposable test with the installed Vitest", () => {
      const fixture = realFixture();
      write(
        fixture.runtime,
        "test/pass.test.js",
        'import { expect, test } from "vitest"; test("passes", () => expect(2 + 2).toBe(4));\n',
      );
      const result = invoke(
        fixture,
        ["--paths", "test/pass.test.js"],
        { root: dirname(process.execPath), log: "", mode: "" },
        { PATH: process.env.PATH },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stderr, /completed 1 non-skipped test/u);
    });

    it("fails a real Vitest zero-test selection", () => {
      const fixture = realFixture();
      createRelated(fixture, "src/unreferenced.ts");
      const result = invoke(
        fixture,
        relatedArgs(["--paths", "src/unreferenced.ts"]),
        { root: dirname(process.execPath), log: "", mode: "" },
        { PATH: process.env.PATH },
      );
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /0 non-skipped test|readable JSON report/u);
    });

    it("fails a real Vitest all-skipped selection", () => {
      const fixture = realFixture();
      write(
        fixture.runtime,
        "test/skipped.test.js",
        'import { test } from "vitest"; test.skip("skipped", () => {});\n',
      );
      const result = invoke(
        fixture,
        ["--paths", "test/skipped.test.js"],
        { root: dirname(process.execPath), log: "", mode: "" },
        { PATH: process.env.PATH },
      );
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /0 non-skipped test/u);
    });

    it("rejects a name filter that would hide a failing selected test", () => {
      const fixture = realFixture();
      write(
        fixture.runtime,
        "test/mixed.test.js",
        'import { expect, test } from "vitest"; test("allowed passing control", () => expect(true).toBe(true)); test("selected failure", () => expect(true).toBe(false));\n',
      );
      const realRunner = { root: dirname(process.execPath), log: "", mode: "" };
      const unfiltered = invoke(fixture, ["--paths", "test/mixed.test.js"], realRunner, {
        PATH: process.env.PATH,
      });
      assert.notEqual(unfiltered.status, 0);
      assert.match(unfiltered.stderr, /executed 2 test\(s\), 1 failed/u);

      const filtered = invoke(
        fixture,
        ["--paths", "test/mixed.test.js", "--", "--testNamePattern", "allowed passing control"],
        realRunner,
        { PATH: process.env.PATH },
      );
      assert.notEqual(filtered.status, 0);
      assert.match(filtered.stderr, /not an allowed non-selection Vitest option/u);
    });
  }
});

longIt(
  "does not pass ambient credentials or unknown variables into the actual test subprocess",
  () => {
    const fixture = repository(),
      runner = sentinel();
    write(fixture.runtime, "test/fixture.test.ts", "void 0;\n");
    const result = invoke(fixture, ["--paths", "test/fixture.test.ts"], runner, {
      MODEL_API_KEY: "synthetic-model-only",
      INFERENCE_HUB_API: "synthetic-hub-only",
      DOCSFAB_GITLAB_READ_API_TOKEN: "synthetic-scm-only",
      UNRECOGNIZED_PROVIDER_VARIABLE: "synthetic-unknown-only",
      CI: "1",
      VITEST_MAX_WORKERS: "2",
      PI_OFFLINE: "1",
    });
    assert.equal(result.status, 0, result.stderr);
    const child = JSON.parse(readFileSync(join(runner.root, "environment.json"), "utf8"));
    for (const name of [
      "MODEL_API_KEY",
      "INFERENCE_HUB_API",
      "DOCSFAB_GITLAB_READ_API_TOKEN",
      "UNRECOGNIZED_PROVIDER_VARIABLE",
    ])
      assert.equal(child.names.includes(name), false, name);
    assert.equal(child.offline, "1");
    assert.equal(child.ci, "1");
    assert.equal(child.workers, "2");
  },
);
