#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { resolveConfig } from "vitest/node";

import {
  assertHeavyManifestMatchesDomains,
  isolationDomains,
  readList,
} from "./check-ci-heavy-manifest.mjs";
import { loadLimitDefinitions } from "./check-limits.mjs";
import { offlineTestEnvironment } from "./offline-test-environment.mjs";

const scriptPath = fileURLToPath(import.meta.url);
export const packageRoot = resolve(dirname(scriptPath), "..");
const vitestEntrypoint = join(packageRoot, "node_modules", "vitest", "vitest.mjs");

// These files still run in their lane, but in a second, uninstrumented Vitest
// run: V8 coverage plus their nested-git / bwrap work fails the job.
export const coverageExclusions = [
  "test/delivery-acceptance.test.ts",
  "test/delivery-publisher.test.ts",
  "test/delivery-worktree.test.ts",
  "test/doc-improvement-cli.test.ts",
  "test/doc-improvement.test.ts",
  "test/content-ir-v2.test.ts",
];

const baseExclusions = ["**/.docsfab/**"];
const schemaVersion = 2;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(path) {
  return sha256(await readFile(path));
}

async function walkFiles(root) {
  if (!existsSync(root)) return [];
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await walkFiles(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files.sort();
}

async function fingerprintFiles(root, paths) {
  const entries = [];
  for (const path of [...paths].sort()) {
    const absolute = isAbsolute(path) ? path : resolve(root, path);
    entries.push([relative(root, absolute).split(sep).join("/"), await sha256File(absolute)]);
  }
  return sha256(JSON.stringify(entries));
}

function exclusionsArgs() {
  return baseExclusions.flatMap((path) => ["--exclude", path]);
}

async function run(command, args, { cwd, env, capture = false, measure = false } = {}) {
  const started = performance.now();
  const measurementPath = join(cwd, `.coverage-time-${process.pid}-${Date.now()}.txt`);
  const canMeasure = measure && process.platform === "linux" && existsSync("/usr/bin/time");
  const actualCommand = canMeasure ? "/usr/bin/time" : command;
  const actualArgs = canMeasure ? ["-v", "-o", measurementPath, command, ...args] : args;

  const child = spawn(actualCommand, actualArgs, {
    cwd,
    env,
    shell: false,
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
  });
  let stdout = "";
  if (capture) child.stdout.on("data", (chunk) => (stdout += chunk));
  const status = await new Promise((done, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => done({ code, signal }));
  });

  let peakRssKiB = null;
  if (canMeasure) {
    const measurement = await readFile(measurementPath, "utf8").catch(() => "");
    const match = measurement.match(/Maximum resident set size \(kbytes\):\s*(\d+)/u);
    peakRssKiB = match ? Number(match[1]) : null;
    await rm(measurementPath, { force: true });
  }
  if (measure && process.env.CI && process.platform === "linux" && peakRssKiB === null) {
    throw new Error("GNU time peak RSS measurement is unavailable in CI");
  }
  return { ...status, stdout, elapsedMs: Math.round(performance.now() - started), peakRssKiB };
}

async function vitest(args, options = {}) {
  return run(process.execPath, [vitestEntrypoint, ...args], {
    cwd: options.root ?? packageRoot,
    env: options.env ?? process.env,
    capture: options.capture,
    measure: options.measure,
  });
}

async function listFiles(root) {
  const args = ["list", "--filesOnly", "--json", ...exclusionsArgs()];
  const result = await vitest(args, { root, capture: true });
  if (result.code !== 0 || result.signal) throw new Error("Vitest file discovery failed");
  const parsed = JSON.parse(result.stdout);
  return parsed.map(({ file }) => relative(root, file).split(sep).join("/")).sort();
}

/** Recorded per-file test durations that weight the fast-lane split. */
export const timingsFile = "scripts/ci-test-timings.json";
const timingsSchemaVersion = 1;

/**
 * Read the recorded durations, in whole milliseconds, keyed by root-relative
 * test file. No file means no timings: every file then weighs the same.
 */
export function readTimings(root) {
  const path = join(root, timingsFile);
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (
    parsed?.schemaVersion !== timingsSchemaVersion ||
    !parsed.files ||
    typeof parsed.files !== "object" ||
    Array.isArray(parsed.files)
  ) {
    throw new Error(`${timingsFile} is not a schemaVersion ${timingsSchemaVersion} timings file`);
  }
  for (const [file, ms] of Object.entries(parsed.files)) {
    if (!Number.isSafeInteger(ms) || ms < 0) {
      throw new Error(`${timingsFile} records an invalid duration for ${file}`);
    }
  }
  return parsed.files;
}

function byPath(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Split files into `total` shards by recorded duration: longest file first,
 * each into the shard with the least recorded time, then the fewest files,
 * then the lowest index. A file without a recording weighs the median of the
 * recorded files in this split. Every input decides the result, so each shard
 * job computes the same assignment on its own, and every file lands in
 * exactly one shard.
 */
export function assignShards(files, total, timings = {}) {
  if (!Number.isInteger(total) || total < 1) throw new Error("invalid shard total");
  const recorded = files
    .filter((file) => Object.hasOwn(timings, file))
    .map((file) => timings[file])
    .sort((left, right) => left - right);
  const fallback = recorded.length > 0 ? recorded[Math.floor((recorded.length - 1) / 2)] : 1;
  const weight = (file) => Math.max(1, Object.hasOwn(timings, file) ? timings[file] : fallback);
  const ordered = [...new Set(files)]
    .map((file) => ({ file, ms: weight(file) }))
    .sort((left, right) => right.ms - left.ms || byPath(left.file, right.file));
  const shards = Array.from({ length: total }, () => ({ ms: 0, files: [] }));
  for (const { file, ms } of ordered) {
    let target = shards[0];
    for (const shard of shards) {
      if (
        shard.ms < target.ms ||
        (shard.ms === target.ms && shard.files.length < target.files.length)
      ) {
        target = shard;
      }
    }
    target.ms += ms;
    target.files.push(file);
  }
  return shards.map((shard) => ({ ms: shard.ms, files: shard.files.sort(byPath) }));
}

function shardFiles(files, index, total, timings) {
  return assignShards(files, total, timings)[index - 1].files;
}

function xmlAttribute(attributes, name) {
  const match = new RegExp(`\\s${name}="([^"]*)"`, "u").exec(attributes);
  if (!match) return null;
  return match[1]
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

/**
 * Build the timings file from Vitest JUnit reports. Each `<testsuite>` is one
 * test file and its `time` is that file's duration in seconds; a file seen in
 * several reports records the mean. Only files in `inventory` are kept, so
 * deleted and isolation-lane files drop out. Internal-only suites
 * (`*.internal.test.*`) are left out too: the public export ships this file
 * without them, and its boundary gate refuses a public file that names one.
 * They weigh the median, like a new file.
 */
export function timingsFromReports(reports, inventory) {
  const samples = new Map();
  for (const xml of reports) {
    let suites = 0;
    for (const [, attributes] of xml.matchAll(/<testsuite\b([^>]*)>/gu)) {
      const file = xmlAttribute(attributes, "name");
      const seconds = Number(xmlAttribute(attributes, "time"));
      if (!file || !Number.isFinite(seconds) || seconds < 0) {
        throw new Error("JUnit testsuite lacks a file name or a valid time");
      }
      suites += 1;
      samples.set(file, [...(samples.get(file) ?? []), seconds]);
    }
    if (suites === 0) throw new Error("JUnit report contains no testsuite");
  }
  const files = {};
  for (const file of [...samples.keys()].sort(byPath)) {
    if (!inventory.has(file) || /\.internal\.test\.[^/]+$/u.test(file)) continue;
    const values = samples.get(file);
    files[file] = Math.round(
      (values.reduce((sum, value) => sum + value, 0) / values.length) * 1000,
    );
  }
  return { schemaVersion: timingsSchemaVersion, files };
}

/** Fast-lane files: every discovered file outside scripts/ci-heavy/<domain>.txt. */
function fastLaneFiles(root, fullFiles) {
  const heavy = new Set(
    isolationDomains.flatMap((domain) => readList(heavyListPath(root, domain))),
  );
  return fullFiles.filter((file) => !heavy.has(file));
}

/**
 * Regenerate scripts/ci-test-timings.json from JUnit reports, then print each
 * shard's estimated recorded time for `total` shards.
 */
export async function writeTimings({ root = packageRoot, reports, total }) {
  if (reports.length === 0) throw new Error("timings needs at least one JUnit report");
  const absoluteRoot = await realpath(resolve(root));
  const inventory = fastLaneFiles(absoluteRoot, await listFiles(absoluteRoot));
  const timings = timingsFromReports(
    await Promise.all(reports.map((path) => readFile(path, "utf8"))),
    new Set(inventory),
  );
  await writeFile(join(absoluteRoot, timingsFile), `${JSON.stringify(timings, null, 2)}\n`);
  const missing = inventory.filter((file) => !Object.hasOwn(timings.files, file));
  return {
    recorded: Object.keys(timings.files).length,
    missing,
    shards: assignShards(inventory, total, timings.files).map((shard, offset) => ({
      index: offset + 1,
      files: shard.files.length,
      seconds: Math.round(shard.ms / 1000),
    })),
  };
}

// Vitest blobs use a flatted JSON array. Strings nested in an object are array
// references; strings stored at the referenced array slot are literal values.
export function parseVitestBlob(text) {
  const input = JSON.parse(text);
  if (!Array.isArray(input) || input.length === 0) throw new Error("invalid Vitest blob");
  const cache = new Map();
  const resolveIndex = (index) => {
    if (!Number.isInteger(index) || index < 0 || index >= input.length) {
      throw new Error("invalid Vitest blob reference");
    }
    const raw = input[index];
    if (raw === null || typeof raw !== "object") return raw;
    if (cache.has(index)) return cache.get(index);
    const output = Array.isArray(raw) ? [] : {};
    cache.set(index, output);
    for (const [key, value] of Object.entries(raw)) {
      output[key] =
        typeof value === "string" && /^\d+$/u.test(value) ? resolveIndex(Number(value)) : value;
    }
    return output;
  };
  return resolveIndex(0);
}

function collectTests(tasks, output = []) {
  for (const task of tasks ?? []) {
    if (task.type === "test") {
      output.push({
        id: task.id,
        name: task.name,
        mode: task.mode,
        state: task.result?.state ?? null,
      });
    }
    collectTests(task.tasks, output);
  }
  return output;
}

export const FAILURE_REPORT_ENTRIES_LIMIT = "ci.coverageShard.failureReportMaxEntries";
export const FAILURE_MESSAGE_CHARS_LIMIT = "ci.coverageShard.failureMessageMaxChars";

function catalogLimit(name, definitions) {
  const definition = definitions.find((entry) => entry.name === name);
  if (!definition) {
    throw new Error(
      `${name} is missing from config/limits.yaml; declare it before reporting lane failures`,
    );
  }
  return definition;
}

function firstErrorLine(errors) {
  const [first] = Array.isArray(errors) ? errors : [];
  if (!first) return null;
  const text =
    typeof first === "string"
      ? first
      : typeof first.message === "string" && first.message.length > 0
        ? first.message
        : typeof first.stack === "string"
          ? first.stack
          : String(first.name ?? "unknown error");
  const line = firstLine(text);
  const named =
    typeof first === "object" && first.name && !line.startsWith(first.name)
      ? `${first.name}: ${line}`
      : line;
  // Assertion wrappers such as `.resolves` carry the real failure as the cause.
  const cause =
    typeof first === "object" && first.cause && typeof first.cause.message === "string"
      ? firstLine(first.cause.message)
      : "";
  return cause ? `${named} (cause: ${cause})` : named;
}

function firstLine(text) {
  return (text.split("\n").find((candidate) => candidate.trim().length > 0) ?? "").trim();
}

function boundedMessage(message, maxChars) {
  if (message === null) return "no error recorded";
  if (message.length <= maxChars.value) return message;
  const omitted = message.length - maxChars.value;
  return `${message.slice(0, maxChars.value)}... (${omitted} more characters omitted; ${maxChars.name} = ${maxChars.value} ${maxChars.unit})`;
}

function collectFailedTests(tasks, file, parents = [], output = []) {
  for (const task of tasks ?? []) {
    const path = [...parents, task.name];
    if (task.type === "test") {
      const state = task.result?.state ?? null;
      const expected =
        task.mode === "skip" || task.mode === "todo"
          ? [null, "skip"].includes(state)
          : state === "pass";
      if (!expected) {
        output.push({
          kind: "test",
          label: `${file} > ${path.join(" > ")}`,
          state: state ?? "not-run",
          message: firstErrorLine(task.result?.errors),
        });
      }
    } else if (task.type === "suite" && task.result?.errors?.length) {
      output.push({
        kind: "suite",
        label: `${file} > ${path.join(" > ")}`,
        state: task.result?.state ?? "not-run",
        message: firstErrorLine(task.result.errors),
      });
    }
    collectFailedTests(task.tasks, file, task.type === "suite" ? path : parents, output);
  }
  return output;
}

/**
 * Name each failed or incomplete file, test, and unhandled error, with its
 * state and first error line, so a CI trace shows the cause without the blob.
 * Entries past the catalog bound are counted, never silently dropped.
 */
export function describeBlobFailures(
  { files, errors, incompleteFiles },
  definitions = loadLimitDefinitions(),
) {
  const maxEntries = catalogLimit(FAILURE_REPORT_ENTRIES_LIMIT, definitions);
  const maxChars = catalogLimit(FAILURE_MESSAGE_CHARS_LIMIT, definitions);
  const incompletePaths = new Set(incompleteFiles.map((file) => file.path));
  const entries = [];
  let failedTests = 0;
  for (const file of files) {
    const tests = collectFailedTests(file.tasks, file.path);
    failedTests += tests.filter((entry) => entry.kind === "test").length;
    if (incompletePaths.has(file.path)) {
      entries.push({
        kind: "file",
        label: file.path,
        state: file.state ?? "not-run",
        message:
          firstErrorLine(file.errors) ??
          (file.testCount === 0
            ? "no tests collected"
            : `${tests.length} failed or incomplete test(s) listed below`),
      });
    }
    entries.push(...tests);
  }
  for (const error of errors) {
    entries.push({
      kind: "error",
      label: "unhandled",
      state: "error",
      message: firstErrorLine([error]),
    });
  }
  const shown = entries.slice(0, maxEntries.value);
  const lines = [
    `Vitest blob contains failed or incomplete tests: ${incompleteFiles.length} file(s), ${failedTests} test(s), ${errors.length} unhandled error(s).`,
    ...shown.map(
      (entry) =>
        `- ${entry.kind} ${entry.label}: ${entry.state}: ${boundedMessage(entry.message, maxChars)}`,
    ),
  ];
  const omitted = entries.length - shown.length;
  if (omitted > 0) {
    lines.push(
      `- ${omitted} more failed or incomplete entries omitted (${maxEntries.name} = ${maxEntries.value} ${maxEntries.unit}); open the lane blob artifact for the rest.`,
    );
  }
  return lines.join("\n");
}

export async function inspectBlob(path, root, { coverage: expectCoverage = true } = {}) {
  const [version, files, errors, coverage, executionTime] = parseVitestBlob(
    await readFile(path, "utf8"),
  );
  if (!version || !Array.isArray(files) || !Array.isArray(errors)) {
    throw new Error("incomplete Vitest blob");
  }
  if (expectCoverage && (!coverage || Object.keys(coverage).length === 0)) {
    throw new Error("empty Vitest coverage evidence");
  }
  if (!expectCoverage && coverage && Object.keys(coverage).length > 0) {
    throw new Error("uninstrumented Vitest run recorded coverage");
  }
  const normalizedFiles = files.map((file) => {
    if (!file.filepath.startsWith(`${root}${sep}`)) throw new Error("Vitest blob root mismatch");
    return {
      path: relative(root, file.filepath).split(sep).join("/"),
      mode: file.mode,
      state: file.result?.state ?? null,
      tests: collectTests(file.tasks),
      tasks: file.tasks,
      errors: file.result?.errors,
    };
  });
  const tests = normalizedFiles.flatMap((file) => file.tests);
  const ids = tests.map((test) => test.id);
  if (new Set(ids).size !== ids.length) throw new Error("duplicate Vitest task id in lane");
  const incomplete = tests.filter((test) => {
    if (test.mode === "skip" || test.mode === "todo") return ![null, "skip"].includes(test.state);
    return test.state !== "pass";
  });
  const incompleteFiles = normalizedFiles.filter((file) => {
    if (file.mode === "skip" || file.mode === "todo") return ![null, "skip"].includes(file.state);
    return file.state !== "pass" || file.tests.length === 0;
  });
  if (errors.length || incompleteFiles.length || incomplete.length) {
    throw new Error(
      describeBlobFailures({
        files: normalizedFiles.map((file) => ({ ...file, testCount: file.tests.length })),
        errors,
        incompleteFiles,
      }),
    );
  }
  const coveredSources = Object.keys(coverage ?? {}).map((coveredPath) => {
    if (!coveredPath.startsWith(`${root}${sep}`)) throw new Error("coverage blob root mismatch");
    return relative(root, coveredPath).split(sep).join("/");
  });
  return {
    vitestVersion: version,
    files: normalizedFiles.map((file) => file.path).sort(),
    coveredSources: coveredSources.sort(),
    tests,
    executionTimeMs: Math.round(executionTime),
  };
}

async function revision(root) {
  const result = await run("git", ["rev-parse", "HEAD"], {
    cwd: root,
    env: process.env,
    capture: true,
  });
  if (result.code !== 0) throw new Error("cannot resolve coverage source revision");
  const value = result.stdout.trim();
  if (process.env.CI_COMMIT_SHA && process.env.CI_COMMIT_SHA !== value) {
    throw new Error("CI_COMMIT_SHA does not match checkout HEAD");
  }
  return value;
}

async function fingerprints(root, allFiles) {
  const sourceFiles = await walkFiles(join(root, "src"));
  const orchestration = [
    "scripts/coverage-shards.mjs",
    "scripts/vitest-coverage-module-offset.mjs",
    "test/helpers/coverage-module-offset.setup.mjs",
    "vitest.config.ts",
    "package.json",
    "npm-shrinkwrap.json",
    ...(existsSync(join(root, timingsFile)) ? [timingsFile] : []),
    ...isolationDomains
      .map((domain) => heavyListPath(root, domain))
      .filter((path) => existsSync(path)),
  ];
  const vitestPackage = JSON.parse(
    await readFile(join(packageRoot, "node_modules/vitest/package.json"), "utf8"),
  );
  const coveragePackage = JSON.parse(
    await readFile(join(packageRoot, "node_modules/@vitest/coverage-v8/package.json"), "utf8"),
  );
  return {
    source: await fingerprintFiles(root, sourceFiles),
    plan: await fingerprintFiles(root, allFiles),
    config: await fingerprintFiles(root, orchestration),
    lock: await sha256File(join(root, "npm-shrinkwrap.json")),
    toolchain: sha256(
      JSON.stringify({
        node: process.version,
        vitest: vitestPackage.version,
        coverageV8: coveragePackage.version,
      }),
    ),
  };
}

function heavyListPath(root, domain) {
  return join(root, "scripts", "ci-heavy", `${domain}.txt`);
}

/** Lane ids the merge expects: `fast-1`..`fast-N`, then one per isolation domain. */
export function expectedLaneIds(fastTotal) {
  if (!Number.isInteger(fastTotal) || fastTotal < 1) throw new Error("invalid fast lane total");
  return [
    ...Array.from({ length: fastTotal }, (_, offset) => `fast-${offset + 1}`),
    ...isolationDomains.map((domain) => `isolation-${domain}`),
  ];
}

function laneFromId(id, fastTotal) {
  const fast = /^fast-(\d+)$/u.exec(id);
  if (fast) return { lane: "fast", index: Number(fast[1]), total: fastTotal };
  const isolation = /^isolation-([a-z]+)$/u.exec(id);
  if (isolation) return { lane: `isolation:${isolation[1]}` };
  throw new Error(`unexpected coverage lane artifact: ${id}`);
}

function laneId({ lane, index = 1, total = 1 }) {
  if (lane === "fast") {
    if (!Number.isInteger(index) || !Number.isInteger(total) || index < 1 || index > total) {
      throw new Error("invalid fast lane index/total");
    }
    return `fast-${index}`;
  }
  const domain = typeof lane === "string" ? lane.slice("isolation:".length) : "";
  if (lane !== `isolation:${domain}` || !isolationDomains.includes(domain)) {
    throw new Error(`unknown coverage lane: ${lane}`);
  }
  return `isolation-${domain}`;
}

/**
 * One CI test lane. scripts/ci-heavy/<domain>.txt is the only membership
 * source: an isolation lane runs its list; the fast lane runs every other
 * discovered file, split by recorded duration (assignShards). CI runs only
 * these lanes; scripts/vitest-ci.mjs derives its local modes from the same
 * lists. Files in coverageExclusions move to the lane's uninstrumented run.
 */
export function lanePlan(root, fullFiles, { lane, index = 1, total = 1 }) {
  const id = laneId({ lane, index, total });
  const heavy = new Map(
    isolationDomains.map((domain) => [domain, readList(heavyListPath(root, domain))]),
  );
  let laneFiles;
  if (lane === "fast") {
    laneFiles = shardFiles(fastLaneFiles(root, fullFiles), index, total, readTimings(root));
  } else {
    const domain = lane.slice("isolation:".length);
    const inventory = new Set(fullFiles);
    const missing = heavy.get(domain).filter((file) => !inventory.has(file));
    if (missing.length > 0) {
      throw new Error(`isolation lane ${domain} lists undiscovered files: ${missing.join(", ")}`);
    }
    index = 1;
    total = 1;
    laneFiles = [...heavy.get(domain)].sort();
  }
  const uninstrumented = new Set(coverageExclusions);
  return {
    id,
    lane: { id, name: lane, index, total },
    files: laneFiles.filter((file) => !uninstrumented.has(file)),
    plainFiles: laneFiles.filter((file) => uninstrumented.has(file)),
  };
}

/** The files fast lane `index` of `total` runs, instrumented or not. */
export async function fastShardFiles({ root = packageRoot, index, total }) {
  const absoluteRoot = await realpath(resolve(root));
  const plan = lanePlan(absoluteRoot, await listFiles(absoluteRoot), {
    lane: "fast",
    index,
    total,
  });
  return [...plan.files, ...plan.plainFiles].sort(byPath);
}

function sameList(left, right) {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

/**
 * Check that the lane manifests are the planned lanes, each ran exactly its
 * planned files, and together they ran the full test plan exactly once.
 */
export function validateLaneSet(manifests, plans) {
  const ids = manifests.map((manifest) => manifest.lane?.id);
  if (new Set(ids).size !== ids.length) throw new Error("duplicate coverage lane manifest");
  if (
    !sameList(
      ids,
      plans.map((plan) => plan.id),
    )
  ) {
    throw new Error("missing or extra coverage lane manifest");
  }
  const reference = manifests[0];
  const compatible = ["revision", "root", "fingerprints", "fullFiles"];
  for (const manifest of manifests) {
    if (manifest.schemaVersion !== schemaVersion) {
      throw new Error("incompatible coverage lane manifest");
    }
    if (!manifest.complete) throw new Error("incomplete coverage lane evidence");
    for (const field of compatible) {
      if (JSON.stringify(manifest[field]) !== JSON.stringify(reference[field])) {
        throw new Error(`coverage lane ${field} mismatch`);
      }
    }
  }
  for (const plan of plans) {
    const manifest = manifests.find((candidate) => candidate.lane.id === plan.id);
    if (!sameList(manifest.files, plan.files) || !sameList(manifest.plainFiles, plan.plainFiles)) {
      throw new Error(`coverage lane ${plan.id} membership differs from its plan`);
    }
    if (
      !sameList(manifest.evidence.files, plan.files) ||
      !sameList(manifest.plainEvidence.files, plan.plainFiles)
    ) {
      throw new Error(`coverage lane ${plan.id} execution differs from its plan`);
    }
  }
  const planned = plans.flatMap((plan) => [...plan.files, ...plan.plainFiles]);
  if (new Set(planned).size !== planned.length || !sameList(planned, reference.fullFiles)) {
    throw new Error("coverage lanes do not partition the full test plan");
  }
  const taskIds = manifests.flatMap((manifest) =>
    [...manifest.evidence.tests, ...manifest.plainEvidence.tests].map((test) => test.id),
  );
  if (new Set(taskIds).size !== taskIds.length) throw new Error("duplicate Vitest task evidence");
  const instrumented = manifests.filter((manifest) => manifest.files.length > 0);
  if (instrumented.length === 0) throw new Error("no coverage lane ran instrumented files");
  for (const manifest of instrumented) {
    if (
      JSON.stringify(manifest.evidence.coveredSources) !==
      JSON.stringify(instrumented[0].evidence.coveredSources)
    ) {
      throw new Error("coverage source membership mismatch");
    }
  }
  return reference;
}

export function assertMergeEnvironment(env = process.env) {
  if (env.DOCSFAB_COVERAGE_SHARD === "1") {
    throw new Error("DOCSFAB_COVERAGE_SHARD cannot bypass the coverage merge gate");
  }
}

export async function assertCoverageThresholds(root) {
  const { vitestConfig } = await resolveConfig({ root });
  const thresholds = vitestConfig.coverage.thresholds;
  const numeric = [];
  const visit = (value) => {
    if (typeof value === "number" && Number.isFinite(value)) numeric.push(value);
    else if (value && typeof value === "object") Object.values(value).forEach(visit);
  };
  visit(thresholds);
  if (!thresholds || numeric.every((value) => value <= 0)) {
    throw new Error("resolved Vitest config has no enforced coverage thresholds");
  }
  return thresholds;
}

function dedicatedOutput(root, candidate, kind, id) {
  const resolved = resolve(root, candidate);
  const expected =
    kind === "lane" ? join(root, "coverage-lanes", id) : join(root, "ci-results", "coverage-merge");
  if (resolved !== expected) throw new Error(`refusing unsafe ${kind} output path`);
  return resolved;
}

// JUnit reports go directly under ci-results/: `<prefix>-junit.xml` for the
// instrumented run and `<prefix>-plain-junit.xml` for the uninstrumented one.
function junitOutputs(root, prefix) {
  if (typeof prefix !== "string" || !/^ci-results\/[A-Za-z0-9._-]+$/u.test(prefix)) {
    throw new Error("--junit must name a ci-results/<prefix>");
  }
  return {
    instrumented: join(root, `${prefix}-junit.xml`),
    plain: join(root, `${prefix}-plain-junit.xml`),
  };
}

async function checkedArtifactPath(root, parts, { mustExist, leafType }) {
  let current = root;
  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index]);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (!mustExist && error?.code === "ENOENT") return current;
      throw error;
    }
    if (info.isSymbolicLink()) throw new Error("coverage artifact path contains a symbolic link");
    const expectedType = index === parts.length - 1 ? leafType : "directory";
    if (expectedType === "directory" ? !info.isDirectory() : !info.isFile()) {
      throw new Error(`coverage artifact path is not a ${expectedType}`);
    }
    if ((await realpath(current)) !== current) {
      throw new Error("coverage artifact path escapes its canonical parent");
    }
  }
  return current;
}

async function laneRun(root, files, { blobPath, junitPath, coverage, env, measure }) {
  const result = await vitest(
    [
      "run",
      ...(coverage ? ["--coverage"] : []),
      ...exclusionsArgs(),
      "--reporter=default",
      "--reporter=blob",
      "--reporter=junit",
      `--outputFile.blob=${blobPath}`,
      `--outputFile.junit=${junitPath}`,
      ...files,
    ],
    { root, env, measure },
  );
  const record = { metrics: { elapsedMs: result.elapsedMs, peakRssKiB: result.peakRssKiB } };
  if (!existsSync(blobPath)) {
    record.error = `Vitest wrote no blob (exit ${result.code ?? result.signal})`;
    return record;
  }
  record.blob = { file: basename(blobPath), sha256: await sha256File(blobPath) };
  try {
    record.evidence = await inspectBlob(blobPath, root, { coverage });
  } catch (error) {
    record.error = error instanceof Error ? error.message : String(error);
    return record;
  }
  if (!sameList(record.evidence.files, files)) {
    record.error = `lane execution differs from planned membership: planned=${JSON.stringify(files)} executed=${JSON.stringify(record.evidence.files)}`;
  } else if (result.code !== 0 || result.signal) {
    record.error = `Vitest exited ${result.code ?? result.signal}`;
  }
  return record;
}

const noEvidence = Object.freeze({ files: [], tests: [], coveredSources: [] });

/**
 * Run one CI test lane: its instrumented files with V8 coverage, then its
 * coverageExclusions files without. Both runs write JUnit and a blob; the
 * manifest binds them to the revision, inputs, and planned membership.
 */
export async function runLane({
  root = packageRoot,
  lane,
  index,
  total,
  output,
  junit,
  measure = true,
}) {
  const absoluteRoot = await realpath(resolve(root));
  const id = laneId({ lane, index, total });
  const outputRoot = dedicatedOutput(absoluteRoot, output ?? `coverage-lanes/${id}`, "lane", id);
  const reports = junitOutputs(absoluteRoot, junit);
  await checkedArtifactPath(absoluteRoot, ["coverage-lanes"], {
    mustExist: false,
    leafType: "directory",
  });
  await checkedArtifactPath(absoluteRoot, ["coverage-lanes", id], {
    mustExist: false,
    leafType: "directory",
  });
  await checkedArtifactPath(absoluteRoot, ["ci-results"], {
    mustExist: false,
    leafType: "directory",
  });
  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(outputRoot, { recursive: true });
  await mkdir(join(absoluteRoot, "ci-results"), { recursive: true });
  if (absoluteRoot === (await realpath(packageRoot))) assertHeavyManifestMatchesDomains();
  const fullFiles = await listFiles(absoluteRoot);
  const plan = lanePlan(absoluteRoot, fullFiles, { lane, index, total });
  const manifest = {
    schemaVersion,
    revision: await revision(absoluteRoot),
    root: absoluteRoot,
    lane: plan.lane,
    fullFiles,
    files: plan.files,
    plainFiles: plan.plainFiles,
    fingerprints: await fingerprints(absoluteRoot, fullFiles),
    complete: false,
    evidence: noEvidence,
    plainEvidence: noEvidence,
  };
  const environment = offlineTestEnvironment();
  const errors = [];
  if (plan.files.length > 0) {
    const record = await laneRun(absoluteRoot, plan.files, {
      blobPath: join(outputRoot, `blob-${plan.id}.json`),
      junitPath: reports.instrumented,
      coverage: true,
      env: { ...environment, DOCSFAB_COVERAGE_SHARD: "1" },
      measure,
    });
    Object.assign(manifest, {
      metrics: record.metrics,
      blob: record.blob,
      evidence: record.evidence ?? noEvidence,
    });
    if (record.error) errors.push(`instrumented run: ${record.error}`);
  }
  if (plan.plainFiles.length > 0) {
    const record = await laneRun(absoluteRoot, plan.plainFiles, {
      blobPath: join(outputRoot, `plain-${plan.id}.json`),
      junitPath: reports.plain,
      coverage: false,
      env: environment,
      measure,
    });
    Object.assign(manifest, {
      plainMetrics: record.metrics,
      plainBlob: record.blob,
      plainEvidence: record.evidence ?? noEvidence,
    });
    if (record.error) errors.push(`uninstrumented run: ${record.error}`);
  }
  manifest.complete = errors.length === 0;
  if (errors.length > 0) manifest.error = errors.join("\n");
  await writeFile(join(outputRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  if (!manifest.complete) throw new Error(`coverage lane ${plan.id} failed:\n${manifest.error}`);
  return manifest;
}

async function verifiedBlob(absoluteRoot, manifest, key, evidenceKey, coverage) {
  const blob = manifest[key];
  const prefix = key === "blob" ? "blob" : "plain";
  if (blob?.file !== `${prefix}-${manifest.lane.id}.json`) {
    throw new Error("invalid coverage blob filename");
  }
  const source = await checkedArtifactPath(
    absoluteRoot,
    ["coverage-lanes", manifest.lane.id, blob.file],
    { mustExist: true, leafType: "file" },
  );
  if ((await sha256File(source)) !== blob.sha256) throw new Error("coverage blob digest mismatch");
  const evidence = await inspectBlob(source, absoluteRoot, { coverage });
  if (JSON.stringify(evidence) !== JSON.stringify(manifest[evidenceKey])) {
    throw new Error("coverage blob evidence differs from manifest");
  }
  return source;
}

/**
 * Verify every planned lane's evidence, then merge the instrumented blobs with
 * Vitest's native merger, which enforces the canonical thresholds once.
 */
export async function mergeLanes({ root = packageRoot, input, fastTotal, output, measure = true }) {
  assertMergeEnvironment();
  const absoluteRoot = await realpath(resolve(root));
  const inputRoot = resolve(absoluteRoot, input);
  if (inputRoot !== join(absoluteRoot, "coverage-lanes")) {
    throw new Error("refusing unsafe coverage lane input path");
  }
  const outputRoot = dedicatedOutput(absoluteRoot, output, "merge");
  await checkedArtifactPath(absoluteRoot, ["coverage-lanes"], {
    mustExist: true,
    leafType: "directory",
  });
  await checkedArtifactPath(absoluteRoot, ["ci-results"], {
    mustExist: false,
    leafType: "directory",
  });
  await checkedArtifactPath(absoluteRoot, ["ci-results", "coverage-merge"], {
    mustExist: false,
    leafType: "directory",
  });
  await assertCoverageThresholds(absoluteRoot);
  const manifests = [];
  for (const entry of await readdir(inputRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^(fast-\d+|isolation-[a-z]+)$/u.test(entry.name)) {
      throw new Error(`unexpected coverage lane artifact: ${entry.name}`);
    }
    const path = await checkedArtifactPath(
      absoluteRoot,
      ["coverage-lanes", entry.name, "manifest.json"],
      { mustExist: true, leafType: "file" },
    );
    const manifest = JSON.parse(await readFile(path, "utf8"));
    if (manifest.lane?.id !== entry.name) {
      throw new Error("coverage lane manifest directory mismatch");
    }
    manifests.push(manifest);
  }
  // The fast lanes record their shard count; runtime:test's `parallel` is its
  // only declaration. A caller may still pin it.
  const totals = new Set(
    manifests.filter((manifest) => manifest.lane.name === "fast").map((m) => m.lane.total),
  );
  if (fastTotal === undefined) {
    if (totals.size !== 1) throw new Error("fast coverage lanes disagree on or omit their total");
    [fastTotal] = totals;
  }
  const expectedIds = expectedLaneIds(fastTotal);
  const currentFiles = await listFiles(absoluteRoot);
  const plans = expectedIds.map((id) =>
    lanePlan(absoluteRoot, currentFiles, laneFromId(id, fastTotal)),
  );
  const reference = validateLaneSet(manifests, plans);
  if (reference.root !== absoluteRoot) {
    throw new Error("coverage lane root differs from merge root");
  }
  if (JSON.stringify(currentFiles) !== JSON.stringify(reference.fullFiles)) {
    throw new Error("coverage full file plan changed before merge");
  }
  const current = await fingerprints(absoluteRoot, currentFiles);
  if (JSON.stringify(current) !== JSON.stringify(reference.fingerprints)) {
    throw new Error("coverage source, plan, config, lock, or toolchain changed before merge");
  }
  if ((await revision(absoluteRoot)) !== reference.revision) {
    throw new Error("coverage revision changed before merge");
  }

  const verifiedSources = [];
  for (const manifest of manifests) {
    const expectedArtifacts = ["manifest.json"];
    if (manifest.files.length > 0) {
      verifiedSources.push(await verifiedBlob(absoluteRoot, manifest, "blob", "evidence", true));
      expectedArtifacts.push(manifest.blob.file);
    }
    if (manifest.plainFiles.length > 0) {
      await verifiedBlob(absoluteRoot, manifest, "plainBlob", "plainEvidence", false);
      expectedArtifacts.push(manifest.plainBlob.file);
    }
    const artifacts = (await readdir(join(inputRoot, manifest.lane.id))).sort();
    if (JSON.stringify(artifacts) !== JSON.stringify(expectedArtifacts.sort())) {
      throw new Error("unexpected coverage lane artifact");
    }
  }
  const blobsRoot = join(outputRoot, "verified-blobs");
  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(blobsRoot, { recursive: true });
  for (const source of verifiedSources) {
    await copyFile(source, join(blobsRoot, basename(source)));
  }

  const result = await vitest(
    [
      `--merge-reports=${blobsRoot}`,
      "--coverage",
      "--reporter=default",
      "--reporter=junit",
      "--outputFile=ci-results/ci-coverage-junit.xml",
    ],
    { root: absoluteRoot, env: { ...process.env, DOCSFAB_COVERAGE_SHARD: "0" }, measure },
  );
  if (result.code !== 0 || result.signal) throw new Error("native Vitest coverage merge failed");
  const tests = (field) =>
    manifests.reduce((sum, manifest) => sum + manifest[field].tests.length, 0);
  return {
    lanes: manifests.length,
    files: reference.fullFiles.length,
    instrumentedTests: tests("evidence"),
    uninstrumentedTests: tests("plainEvidence"),
    mergeElapsedMs: result.elapsedMs,
    peakRssKiB: result.peakRssKiB,
  };
}

function option(name, fallback) {
  const prefix = `--${name}=`;
  const value = process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
  return value ?? fallback;
}

async function main() {
  const command = process.argv[2];
  if (command === "lane") {
    const manifest = await runLane({
      lane: option("lane"),
      index: Number(option("index", "1")),
      total: Number(option("total", "1")),
      junit: option("junit"),
    });
    const tests = manifest.evidence.tests.length + manifest.plainEvidence.tests.length;
    console.log(
      `coverage lane ${manifest.lane.id}: ${manifest.files.length} instrumented and ${manifest.plainFiles.length} uninstrumented files, ${tests} tests`,
    );
    return;
  }
  if (command === "merge") {
    const pinned = option("fast-total");
    const summary = await mergeLanes({
      input: option("input", "coverage-lanes"),
      fastTotal: pinned === undefined ? undefined : Number(pinned),
      output: option("output", "ci-results/coverage-merge"),
    });
    console.log(`coverage merge: ${JSON.stringify(summary)}`);
    return;
  }
  if (command === "timings") {
    const summary = await writeTimings({
      reports: process.argv.slice(3).filter((argument) => !argument.startsWith("--")),
      total: Number(option("total", "4")),
    });
    console.log(
      `${timingsFile}: ${summary.recorded} files recorded, ${summary.missing.length} weighed by the median`,
    );
    for (const shard of summary.shards) {
      console.log(`shard ${shard.index}: ${shard.files} files, ${shard.seconds}s recorded`);
    }
    return;
  }
  throw new Error(
    "usage: coverage-shards.mjs lane --lane=<fast|isolation:DOMAIN> [--index=N --total=N] --junit=ci-results/<prefix> | merge [--fast-total=N] | timings [--total=N] <junit.xml>...",
  );
}

/**
 * True when Node was started with this file as its main module. Realpaths both
 * sides, or a symlinked invocation path would skip `main()` and exit 0 having
 * done nothing. An unreadable argv[1] means "not the entry point".
 */
function isEntryPoint() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(resolve(process.argv[1])) === realpathSync(scriptPath);
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
