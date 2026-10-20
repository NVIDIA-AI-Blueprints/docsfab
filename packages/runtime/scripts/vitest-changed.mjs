#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Select and run the smallest honest Vitest set affected by a change. */
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fsyncSync,
  linkSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { PRIVATE_CONTENT_PATHS } from "../src/config/private-content-paths.js";
import { offlineTestEnvironment } from "./offline-test-environment.mjs";
import { randomUUID } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(packageRoot, "../..");
const DEFAULT_BASE = "origin/main";
const RUNTIME_PREFIX = "packages/runtime/";

/**
 * Host-wide Vitest graph lock identity.
 *
 * - **Unit:** one exclusive lock file covering every `test:changed` Vitest
 *   spawn on the host.
 * - **Default path:** `$TMPDIR/docsfab-vitest-graph.lock`.
 * - **Rationale:** mill workers sharing a host must not start a second Vitest
 *   graph. Related expansion of a hub module already occupies the machine for
 *   tens of minutes. Override the path with `DOCSFAB_VITEST_GRAPH_LOCK_PATH`
 *   only for an isolated lock in tests or a deliberate parallel run.
 */
const VITEST_GRAPH_LOCK_AXIS = "runtime.vitest.graphLock";
const DEFAULT_VITEST_GRAPH_LOCK_PATH = join(tmpdir(), "docsfab-vitest-graph.lock");

function fail(message) {
  console.error(`vitest-changed: ${message}`);
  process.exitCode = 1;
}
function parseBooleanEnv(name) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return false;
  const value = raw.trim().toLowerCase();
  if (value === "1" || value === "true" || value === "yes") return true;
  if (value === "0" || value === "false" || value === "no") return false;
  throw new Error(`${name} must be 1, true, yes, 0, false, or no`);
}
function graphLockPath() {
  const raw = process.env.DOCSFAB_VITEST_GRAPH_LOCK_PATH;
  if (raw === undefined || raw.trim() === "") return DEFAULT_VITEST_GRAPH_LOCK_PATH;
  return raw;
}
function readLockOwner(path) {
  try {
    const owner = JSON.parse(readFileSync(path, "utf8"));
    if (
      !owner ||
      !Number.isInteger(owner.pid) ||
      owner.pid <= 0 ||
      typeof owner.token !== "string" ||
      !owner.token
    )
      return undefined;
    return { pid: owner.pid, token: owner.token };
  } catch {
    return undefined;
  }
}
function pidIsLive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}
function publishGraphLock(path, owner) {
  const stagingPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = openSync(
      stagingPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      0o600,
    );
    writeSync(fd, `${JSON.stringify(owner)}\n`);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    try {
      // A hard link publishes the complete record without replacing an existing lock.
      linkSync(stagingPath, path);
      return true;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      return false;
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(stagingPath, { force: true });
  }
}
function acquireGraphLock() {
  const path = graphLockPath();
  for (;;) {
    const owner = { pid: process.pid, token: randomUUID() };
    if (publishGraphLock(path, owner)) return { path, owner };
    const holder = readLockOwner(path);
    if (!holder && !existsSync(path)) continue;
    if (holder && pidIsLive(holder.pid)) {
      throw new Error(
        `another Vitest graph holds ${VITEST_GRAPH_LOCK_AXIS} at ${path} (pid ${holder.pid}). Wait for that process to exit, or set DOCSFAB_VITEST_GRAPH_LOCK_PATH to an isolated lock for a deliberate parallel run.`,
      );
    }
    throw new Error(
      `cannot acquire ${VITEST_GRAPH_LOCK_AXIS} at ${path}: the existing lock has incomplete, unreadable, or stale ownership. Verify that no Vitest graph is running, remove the lock file manually, and retry.`,
    );
  }
}
function releaseGraphLock(lock) {
  if (!lock) return;
  const current = readLockOwner(lock.path);
  if (!current || current.pid !== lock.owner.pid || current.token !== lock.owner.token) return;
  try {
    rmSync(lock.path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
function runGit(args) {
  const r = spawnSync("git", args, { cwd: repoRoot, encoding: "buffer", shell: false });
  if (r.status !== 0)
    throw new Error(
      (r.stderr || Buffer.alloc(0)).toString("utf8").trim() || `git ${args[0]} failed`,
    );
  return r.stdout || Buffer.alloc(0);
}
function nulPaths(buffer) {
  return buffer.toString("utf8").split("\0").filter(Boolean);
}
function normalizePath(value) {
  const normalized = String(value).replaceAll("\\", "/").replace(/^\.\//u, "");
  return normalized.startsWith(RUNTIME_PREFIX)
    ? normalized.slice(RUNTIME_PREFIX.length)
    : normalized;
}
function parseExplicit(values) {
  const paths = [];
  for (const value of values)
    for (const part of value.split(/[\n,]/u)) {
      const path = normalizePath(part.trim());
      if (path && !paths.includes(path)) paths.push(path);
    }
  return paths;
}
function options(args) {
  let base = process.env.DOCSFAB_TEST_CHANGED_BASE || DEFAULT_BASE;
  let dirty = false;
  let allowRelated = parseBooleanEnv("DOCSFAB_TEST_CHANGED_ALLOW_RELATED");
  const explicit = [];
  const passthrough = [];
  let after = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (after) {
      passthrough.push(arg);
      continue;
    }
    if (arg === "--") {
      after = true;
      continue;
    }
    if (arg === "--dirty") {
      dirty = true;
      continue;
    }
    if (arg === "--allow-related") {
      allowRelated = true;
      continue;
    }
    if (arg === "--base") {
      if (i + 1 >= args.length || !args[i + 1].trim() || args[i + 1].startsWith("--")) {
        throw new Error("--base requires a value");
      }
      base = args[++i];
      continue;
    }
    if (arg.startsWith("--base=")) {
      base = arg.slice(7);
      if (!base.trim()) throw new Error("--base requires a value");
      continue;
    }
    if (arg === "--paths") {
      if (i + 1 >= args.length || !args[i + 1].trim() || args[i + 1].startsWith("--")) {
        throw new Error("--paths requires a value");
      }
      explicit.push(args[++i]);
      continue;
    }
    if (arg.startsWith("--paths=")) {
      const value = arg.slice(8);
      if (!value.trim()) throw new Error("--paths requires a value");
      explicit.push(value);
      continue;
    }
    throw new Error(
      `unknown selector option ${JSON.stringify(arg)}; put Vitest arguments after --`,
    );
  }
  if (process.env.DOCSFAB_TEST_CHANGED_PATHS) explicit.push(process.env.DOCSFAB_TEST_CHANGED_PATHS);
  const parsedExplicit = parseExplicit(explicit);
  if (explicit.length && !parsedExplicit.length) throw new Error("--paths requires a value");
  return { base, dirty, allowRelated, explicit: parsedExplicit, passthrough };
}
function parseNameStatus(buffer) {
  const fields = nulPaths(buffer);
  const paths = [];
  for (let i = 0; i < fields.length; i += 1) {
    const status = fields[i];
    if (/^[RC]/u.test(status)) {
      paths.push(normalizePath(fields[++i] || ""), normalizePath(fields[++i] || ""));
    } else paths.push(normalizePath(fields[++i] || ""));
  }
  return paths.filter(Boolean);
}
function changed(opts) {
  if (opts.explicit.length) return opts.explicit;
  const paths = [];
  if (opts.base)
    paths.push(
      ...parseNameStatus(
        runGit([
          "diff",
          "--find-renames",
          "--name-status",
          "-z",
          "--diff-filter=ACMRD",
          `${opts.base}...HEAD`,
        ]),
      ),
    );
  if (opts.dirty) {
    paths.push(
      ...parseNameStatus(
        runGit(["diff", "--find-renames", "--name-status", "-z", "--diff-filter=ACMRD", "HEAD"]),
      ),
    );
    paths.push(
      ...nulPaths(runGit(["ls-files", "-z", "--others", "--exclude-standard"])).map(normalizePath),
    );
  }
  return [...new Set(paths)];
}
const FAMILY_RULES = [
  ["runtime workflow manifests", (path) => path.startsWith("workflows/"), null],
  ["canonical governed skills", (path) => path.startsWith("packages/skills/"), null],
  [
    "canonical quality pack",
    (path) => /^packages\/quality\/(?:checks|formats|profiles|rubrics|schemas)\//u.test(path),
    null,
  ],
  [
    "generated quality pack",
    (path) => /^(?:quality|quality-pack)\//u.test(path),
    ["test/quality-pack.test.ts"],
  ],
  [
    "generated skill crate",
    (path) => path.startsWith("skill-crate/"),
    [
      "test/catalog-skill-crate.test.ts",
      "test/governed-skills.test.ts",
      "test/package-compose-golden.test.ts",
    ],
  ],
  [
    "governed assets and locks",
    (path) => path.startsWith("governed-assets/"),
    [
      "test/governed-asset-catalog.test.ts",
      "test/template-assets.test.ts",
      ...(PRIVATE_CONTENT_PATHS.governedAssetsQualificationTest
        ? [PRIVATE_CONTENT_PATHS.governedAssetsQualificationTest]
        : []),
    ],
  ],
  ["knowledge package", (path) => path.startsWith("packages/knowledge/"), null],
  [
    "model-matrix probe",
    (path) => path.startsWith("scripts/model-matrix/"),
    ["src/cli/profile-probe.test.ts", "src/cli/profile-draft.test.ts"],
  ],
  [
    "runtime generators",
    (path) =>
      /^scripts\/(?:generate-(?:derived|catalog-crate|quality-pack|model-comparison-kit)|reseal-(?:candidate-source|composition)-digests)\.(?:mjs|mts)$/u.test(
        path,
      ),
    null,
  ],
  ["qualification kit assets", (path) => path.startsWith("qualification-kits/"), null],
  [
    "changed-test selector",
    (path) => path === "scripts/vitest-changed.mjs",
    ["scripts/vitest-changed.test.mjs"],
  ],
  [
    "package metadata",
    (path) =>
      path === "package.json" || path === "package-lock.json" || path === "npm-shrinkwrap.json",
    null,
  ],
  [
    "Vitest and CI manifests",
    (path) =>
      path === "vitest.config.ts" ||
      path === ".gitlab-ci.yml" ||
      path.startsWith(".gitlab/ci/") ||
      path.startsWith("scripts/ci-heavy/") ||
      path === "scripts/ci-heavy-tests.txt",
    null,
  ],
];
function isDirectTest(path) {
  return /(?:^|\/).+\.test\.(?:[cm]?[jt]s|tsx?)$/u.test(path);
}
function isPackageLocalTest(path) {
  return (
    isDirectTest(path) &&
    !path.startsWith("/") &&
    !/^[A-Za-z]:\//u.test(path) &&
    !path.split("/").includes("..") &&
    !path.startsWith("packages/") &&
    !path.startsWith(".gitlab/")
  );
}
function isStaticRelated(path) {
  return /^(?:src|test)\/.+\.(?:[cm]?[jt]s|tsx?)$/u.test(path);
}
function isRelevant(path) {
  return (
    /^(?:src|test|scripts|workflows|governed-assets|quality|quality-pack|skill-crate|model-compositions|qualification-kits)\//u.test(
      path,
    ) ||
    /^(?:package\.json|package-lock\.json|npm-shrinkwrap\.json|vitest\.config\.ts)$/u.test(path) ||
    /^(?:packages\/(?:knowledge|quality|skills)\/|\.gitlab(?:\/ci\/|-ci\.yml$))/u.test(path)
  );
}
/**
 * Report explicit paths that name no file or directory.
 *
 * Git-diff selection routes deleted inputs to the full suite because an absent
 * input is a real change. An operator-named path that does not exist is a typo
 * or a quoting mistake, never a request for the full suite, so it is refused
 * before any runner starts. Package-local tests and static inputs resolve only
 * inside the runtime package, because that is where the selector runs them.
 * Other paths resolve inside the runtime package or the repository root.
 */
function unresolvedExplicit(paths) {
  const exists = (path) => {
    if (existsSync(resolve(packageRoot, path))) return true;
    if (isPackageLocalTest(path) || isStaticRelated(path)) return false;
    return existsSync(resolve(repoRoot, path));
  };
  return paths.filter((path) => !exists(path));
}
function explicitRefusal(unresolved) {
  const lines = unresolved.map((path) =>
    /\s/u.test(path)
      ? `  ${JSON.stringify(path)} (contains whitespace and matches no file: this looks like a whole list passed as one string. Separate paths with commas or repeat --paths; an unsplit shell variable such as zsh "$paths" arrives as one argument)`
      : `  ${JSON.stringify(path)}`,
  );
  return [
    `refused explicit --paths: ${unresolved.length} path(s) match no file in the runtime package or repository:`,
    ...lines,
    "No tests were run. An explicit path that does not exist never selects the full suite; the full suite belongs to CI. Check the spelling and the comma-separated quoting of --paths and DOCSFAB_TEST_CHANGED_PATHS. To cover a deleted test or source file, use Git selection (--base, --dirty) instead of --paths.",
  ].join("\n");
}
function mapping(paths) {
  const directTests = new Set();
  const related = new Set();
  const routes = [];
  let fullSuite = false;
  for (const path of paths) {
    if (isPackageLocalTest(path)) {
      if (existsSync(join(packageRoot, path))) {
        directTests.add(path);
        routes.push(`${path} -> direct test`);
      } else {
        fullSuite = true;
        routes.push(`${path} -> full suite (deleted test)`);
      }
      continue;
    }
    if (!isRelevant(path)) continue;
    if (isStaticRelated(path)) {
      if (existsSync(join(packageRoot, path))) {
        related.add(path);
        routes.push(`${path} -> Vitest related`);
      } else {
        fullSuite = true;
        routes.push(`${path} -> full suite (deleted static input)`);
      }
      continue;
    }
    const family = FAMILY_RULES.find(([, matches]) => matches(path));
    if (family) {
      const [name, , tests] = family;
      if (tests) {
        for (const test of tests) directTests.add(test);
        routes.push(`${path} -> ${name}: ${tests.join(", ")}`);
      } else {
        fullSuite = true;
        routes.push(`${path} -> full suite (${name})`);
      }
    } else {
      fullSuite = true;
      routes.push(`${path} -> full suite (conservative fallback)`);
    }
  }
  return {
    directTests: [...directTests].sort(),
    related: [...related].sort(),
    routes,
    fullSuite,
  };
}
function validatePassthrough(args) {
  const flagOptions = new Set([
    "--disableConsoleIntercept",
    "--expandSnapshotDiff",
    "--fileParallelism",
    "--hideSkippedTests",
    "--logHeapUsage",
    "--no-color",
    "--no-fileParallelism",
    "--no-isolate",
    "--printConsoleTrace",
  ]);
  const valueOptions = new Set([
    "--hookTimeout",
    "--maxConcurrency",
    "--maxWorkers",
    "--minWorkers",
    "--pool",
    "--sequence.seed",
    "--slowTestThreshold",
    "--teardownTimeout",
    "--testTimeout",
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const equals = argument.indexOf("=");
    const name = equals === -1 ? argument : argument.slice(0, equals);
    if (flagOptions.has(name) && equals === -1) continue;
    if (valueOptions.has(name)) {
      if (equals !== -1) {
        if (argument.slice(equals + 1)) continue;
      } else if (args[index + 1] && !args[index + 1].startsWith("-")) {
        index += 1;
        continue;
      }
      throw new Error(`${name} requires a passthrough value`);
    }
    throw new Error(`${JSON.stringify(argument)} is not an allowed non-selection Vitest option`);
  }
}
function reportCount(file) {
  let report;
  try {
    report = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error("Vitest did not produce a readable JSON report");
  }
  const passed = report.numPassedTests;
  const rejected = report.numFailedTests;
  if (![passed, rejected].every((value) => Number.isInteger(value) && value >= 0)) {
    throw new Error("Vitest JSON report has invalid execution counts");
  }
  return { count: passed + rejected, failed: rejected, failures: failedTests(report) };
}
function firstLine(value) {
  return typeof value === "string" ? value.trim().split("\n")[0].trim() : "";
}
/**
 * Vitest builds a test or hook timeout from a stack captured at registration
 * (`makeTimeoutError` in `@vitest/runner`), and the JSON reporter keeps only
 * that stack. The "timed out" message is lost and the first line reads
 * `Error: STACK_TRACE_ERROR`. Other runner errors prepend their own message.
 */
const VITEST_TIMEOUT_PLACEHOLDER = "Error: STACK_TRACE_ERROR";
function failureSummary(message, duration) {
  const line = firstLine(message);
  if (line !== VITEST_TIMEOUT_PLACEHOLDER) return line;
  const elapsed = Number.isFinite(duration) ? ` after ${Math.round(duration)}ms` : "";
  return `Vitest test or hook timeout${elapsed} (the JSON report keeps only Vitest's ${VITEST_TIMEOUT_PLACEHOLDER} placeholder)`;
}
/**
 * Name every failed test in a Vitest JSON report as `file > title` with the
 * first line of its failure message, so a shared-host reader can tell a load
 * timeout from an assertion failure without a rerun. A file that failed
 * without a failed test (for example, an import error) is named as a file.
 */
function failedTests(report) {
  const failures = [];
  for (const file of Array.isArray(report.testResults) ? report.testResults : []) {
    const name =
      typeof file?.name === "string" && file.name
        ? relative(packageRoot, file.name).replaceAll("\\", "/")
        : "<unnamed file>";
    const assertions = Array.isArray(file?.assertionResults) ? file.assertionResults : [];
    const failed = assertions.filter((assertion) => assertion?.status === "failed");
    for (const assertion of failed) {
      const titles = [
        ...(Array.isArray(assertion.ancestorTitles) ? assertion.ancestorTitles : []),
        assertion.title,
      ].filter((title) => typeof title === "string" && title);
      const title = titles.length ? titles.join(" > ") : assertion.fullName || "<untitled test>";
      const messages = Array.isArray(assertion.failureMessages) ? assertion.failureMessages : [];
      failures.push({
        kind: "test",
        test: `${name} > ${title}`,
        message: failureSummary(messages[0], assertion.duration),
      });
    }
    if (!failed.length && file?.status === "failed")
      failures.push({
        kind: "file",
        test: `${name} (file failed)`,
        message: firstLine(file.message),
      });
  }
  return failures;
}
export function main(args = process.argv.slice(2)) {
  let opts;
  try {
    opts = options(args);
    validatePassthrough(opts.passthrough);
  } catch (e) {
    fail(e.message);
    return 1;
  }
  let paths;
  try {
    paths = changed(opts);
  } catch (e) {
    fail(`unable to discover changed paths: ${e.message}`);
    return 1;
  }
  if (paths.length) {
    console.error("vitest-changed: considered changed paths:");
    for (const path of paths) console.error(`  ${path}`);
  }
  if (opts.explicit.length) {
    const unresolved = unresolvedExplicit(opts.explicit);
    if (unresolved.length) {
      fail(explicitRefusal(unresolved));
      return 1;
    }
  }
  const selection = mapping(paths);
  if (!selection.routes.length) {
    console.error(
      `vitest-changed: no relevant runtime changes; runner not started (${paths.length ? "only unrelated paths" : "empty change set"})`,
    );
    return 0;
  }
  console.error("vitest-changed: selected routes:");
  for (const route of selection.routes) console.error(`  ${route}`);
  console.error(`vitest-changed: related inputs: ${selection.related.length}`);
  for (const path of selection.related) console.error(`  ${path}`);
  if (!selection.fullSuite && selection.related.length && !opts.allowRelated) {
    fail(
      `refused Vitest related (${selection.related.length} path(s)). Related import-graph expansion is unbounded on hub modules and starves sibling mill workers. Name the tests with --paths, or pass --allow-related / DOCSFAB_TEST_CHANGED_ALLOW_RELATED=1 on a quiet host.`,
    );
    return 1;
  }
  const temp = mkdtempSync(join(tmpdir(), "docsfab-vitest-changed-"));
  let lock;
  try {
    lock = acquireGraphLock();
    let total = 0;
    let failed = false;
    const invocations = selection.fullSuite
      ? [["run", []]]
      : [
          ["run", selection.directTests],
          ["related", selection.related],
        ].filter(([, inputs]) => inputs.length);
    for (const [index, [command, inputs]] of invocations.entries()) {
      const report = join(temp, `report-${index}.json`);
      const result = spawnSync(
        "npx",
        [
          "vitest",
          command,
          "--run",
          "--exclude",
          "**/.docsfab/**",
          "--reporter=json",
          `--outputFile=${report}`,
          ...inputs,
          ...opts.passthrough,
        ],
        { cwd: packageRoot, env: offlineTestEnvironment(), stdio: "inherit", shell: false },
      );
      if (result.error) {
        fail(`unable to launch Vitest runner: ${result.error.message}`);
        return 1;
      }
      const counts = reportCount(report);
      total += counts.count;
      if (counts.failed || counts.count === 0 || result.status !== 0) failed = true;
      const named = counts.failures.length
        ? ` [${counts.failures.map((failure) => failure.test).join("; ")}]`
        : "";
      const unnamed =
        counts.failed > counts.failures.filter((failure) => failure.kind === "test").length
          ? " (the report does not name every failed test)"
          : "";
      console.error(
        `vitest-changed: ${command}${inputs.length ? ` ${inputs.join(" ")}` : " <full suite>"} executed ${counts.count} test(s), ${counts.failed} failed${named}${unnamed}, runner exit ${String(result.status)}`,
      );
      for (const failure of counts.failures)
        console.error(`  FAIL ${failure.test}${failure.message ? `: ${failure.message}` : ""}`);
    }
    if (failed || total === 0) {
      fail(
        `relevant selection did not complete successfully (${total} non-skipped test(s) executed)`,
      );
      return 1;
    }
    console.error(`vitest-changed: completed ${total} non-skipped test(s)`);
    return 0;
  } catch (e) {
    fail(e.message);
    return 1;
  } finally {
    releaseGraphLock(lock);
    rmSync(temp, { recursive: true, force: true });
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  process.exitCode = main();
}
