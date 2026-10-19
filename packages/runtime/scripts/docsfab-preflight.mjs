#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * docsfab-preflight: runs the mechanical half of an agent worker's definition
 * of done before a push and prints a PASS/FAIL table.
 *
 * Modes:
 *   node scripts/docsfab-preflight.mjs [--base <ref>] [--mr <iid>] [--project <id>] [--root <dir>]
 *     Runs check:derived, check:pins, check:static (which runs check:limits),
 *     the repository-wide cross-package import ratchet and the
 *     secret-fixtures registry check, prints the package-* label map for
 *     paths changed against `--base` (default origin/main), lists the test
 *     files that import each changed module with the vitest command to run
 *     per file, and — with --mr and a working `glab` — compares the required
 *     labels against the MR's applied labels. `--root <dir>` targets a
 *     worktree other than whichever one this script file itself lives in;
 *     absent, the target is `git rev-parse --show-toplevel` from the
 *     current working directory (not this file's own location).
 *
 *   node scripts/docsfab-preflight.mjs --scan-file <path> [--allow-close <local-IID> ...]
 *     Final-text scan for GitLab closing patterns and credential-shaped text
 *     before posting an MR/issue body, a title, or a commit message. Explicit
 *     local-IID allowances permit only a precise `Closes #IID`, `Fixes #IID`,
 *     or `Resolves #IID` line; credentials remain refused.
 *
 *   node scripts/docsfab-preflight.mjs --mutant-applied <file>
 *     Confirms the working tree differs from HEAD in <file> (a mutant was
 *     actually applied, not a no-op) and prints its diffstat.
 *
 * Printed lists are never capped. The one named bound is
 * FAILURE_OUTPUT_TAIL_LINES; subprocess timeouts are execution plumbing, not a
 * product-facing bound.
 *
 * A repository-level command that lives under packages/runtime/ for `npm run`.
 * It mirrors .gitlab/ci/check-mr-hygiene.sh.
 */
import { execFile } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { writeBuildGeneratedMirrors } from "./check-limits.mjs";
import { TEXT_CREDENTIAL_SHAPES } from "../src/security/text-credential-shapes.js";

// Node's type stripping loads the credential module directly, and its imports
// read the build-generated limits mirror, which a fresh checkout lacks. Only
// that untracked mirror is written, so the committed-output checks this script
// runs still see any drift. The forge half of the rule is the dependency-free
// shared shape list; see FORGE_TEXT_CREDENTIAL_SHAPES.
try {
  writeBuildGeneratedMirrors();
} catch (error) {
  // Handles exactly a catalog that cannot load or a mirror that cannot be
  // written. A mirror already on disk still loads below, and check:derived
  // then reports the cause; an absent one fails that import, after this line.
  process.stderr.write(
    `docsfab-preflight: could not write the build-generated limits mirrors: ${error instanceof Error ? error.message : String(error)}\n`,
  );
}
const { containsStrictAssignedCredential } = await import("../src/security/credential-material.ts");

const execute = promisify(execFile);
const scriptDir = dirname(fileURLToPath(import.meta.url));
// `let`: default mode's `--root` handling (`resolveRoots`) reassigns these
// before any consumer reads them, so one copy of this script can target
// another worktree.
export let runtimeRoot = resolve(scriptDir, "..");
export let repositoryRoot = resolve(runtimeRoot, "../..");

const DEFAULT_BASE = "origin/main";
const DEFAULT_PROJECT = "437040";
export const EXEC_TIMEOUT_MS = 120_000;
export const EXEC_MAX_BUFFER = 8 * 1024 * 1024;

// package-* label map: mirrors `label_for_path` in .gitlab/ci/check-mr-hygiene.sh;
// keep the two in sync.

export function labelForPath(path) {
  if (path.startsWith("packages/runtime/")) return "package-runtime";
  if (path.startsWith("packages/knowledge/")) return "package-knowledge";
  if (path.startsWith("packages/quality/")) return "package-quality";
  if (path.startsWith("packages/skills/")) return "package-skills";
  if (path.startsWith("packages/host/")) return "package-host";
  if (path.startsWith("docs/") || path.startsWith("fern/")) return "package-docs";
  if (path === ".gitlab-ci.yml" || path.startsWith(".gitlab/ci/")) return "package-ci";
  if (
    path.startsWith("planning/") ||
    path.startsWith("experiments/") ||
    path.startsWith("scripts/") ||
    path.startsWith("roles/") ||
    path === ".gitlab/README.md" ||
    path.startsWith(".gitlab/issue_templates/") ||
    path.startsWith(".gitlab/merge_request_templates/")
  ) {
    return "package-process";
  }
  if (
    path === "AGENTS.md" ||
    path.endsWith("/AGENTS.md") ||
    path === "BOOT.md" ||
    path === "PRINCIPLES.md" ||
    path === "CONTRIBUTING.md" ||
    path === "PROCESS.md"
  ) {
    return "package-process";
  }
  return "";
}

export function computeLabelMap(changedPaths) {
  const byPath = {};
  const required = new Set();
  const unmapped = [];
  for (const path of changedPaths) {
    const trimmed = path.trim();
    if (!trimmed) continue;
    const label = labelForPath(trimmed);
    byPath[trimmed] = label || null;
    if (label) required.add(label);
    else unmapped.push(trimmed);
  }
  return { byPath, required: [...required].sort(), unmapped };
}

// Final-text scan. GitLab's closing-pattern match ignores negation, so a
// keyword anywhere on a line that also carries `#<number>` is flagged.

const CLOSING_KEYWORDS = [
  "close",
  "closes",
  "closed",
  "closing",
  "fix",
  "fixes",
  "fixed",
  "fixing",
  "resolve",
  "resolves",
  "resolved",
  "resolving",
  "implement",
  "implements",
  "implemented",
  "implementing",
];
const CLOSING_KEYWORD_PATTERN = new RegExp(`\\b(${CLOSING_KEYWORDS.join("|")})\\b`, "iu");
const ISSUE_REFERENCE_PATTERN = /#\d+/u;

/** The text list: MR and issue text is posted to shared GitLab fields. */
const FORGE_TEXT_CREDENTIAL_SHAPES = TEXT_CREDENTIAL_SHAPES;

/**
 * Union of the forge screen above and the runtime's canonical assignment check
 * under its strict value rule, `containsStrictAssignedCredential`: text posted
 * to a forge gains nothing from the detector's exemptions for references and
 * placeholders. Neither half is a superset: the forge screen misses
 * a compound key such as `service_api_key`, and the canonical detector misses
 * assigned values of 8 to 11 characters. A test probe list pins both halves.
 */
export function containsTokenShapedText(line) {
  return (
    FORGE_TEXT_CREDENTIAL_SHAPES.some((pattern) => pattern.test(line)) ||
    containsStrictAssignedCredential(line)
  );
}

export const WITHHELD_EXCERPT = "(line withheld; rewrite it before posting)";

export function scanText(text, { allowedCloseIids = [] } = {}) {
  if (
    !Array.isArray(allowedCloseIids) ||
    allowedCloseIids.some((iid) => !/^[1-9]\d*$/u.test(String(iid)))
  ) {
    throw new Error("allowedCloseIids must contain positive local issue IIDs");
  }
  const allowed = new Set(allowedCloseIids.map(String));
  const violations = [];
  const lines = text.split(/\r?\n/u);
  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    const credentialShaped = containsTokenShapedText(line);
    const preciseClose = /^\s*(?:closes|fixes|resolves)\s+#(\d+)[.!]?\s*$/iu.exec(line);
    const explicitlyAllowed = preciseClose !== null && allowed.has(preciseClose[1]);
    if (
      CLOSING_KEYWORD_PATTERN.test(line) &&
      ISSUE_REFERENCE_PATTERN.test(line) &&
      !explicitlyAllowed
    ) {
      violations.push({
        type: "closing-pattern",
        line: lineNumber,
        excerpt: credentialShaped ? WITHHELD_EXCERPT : line.trim(),
      });
    }
    if (credentialShaped) {
      violations.push({
        type: "token-shaped-text",
        line: lineNumber,
        // Never echo the offending line: preflight output is pasted into MR
        // comments, and credential-shaped text there is what this prevents.
        excerpt: WITHHELD_EXCERPT,
      });
    }
  });
  return { ok: violations.length === 0, violations };
}

// Mutant-application check: proves a mutant applied before its survival is read.

export async function checkMutantApplied(file, options = {}) {
  const cwd = options.cwd ?? repositoryRoot;
  const relativeFile = relative(cwd, resolve(cwd, file));
  const { stdout: statusOut } = await execute(
    "git",
    ["status", "--porcelain=v1", "--", relativeFile],
    {
      cwd,
      encoding: "utf8",
      timeout: EXEC_TIMEOUT_MS,
      maxBuffer: EXEC_MAX_BUFFER,
    },
  );
  // Porcelain status columns are significant (" M" vs "M "), so strip only
  // the trailing newline.
  const status = statusOut.replace(/\r?\n+$/u, "");
  let diffstat = "";
  try {
    const { stdout: diffOut } = await execute(
      "git",
      ["diff", "--stat", "HEAD", "--", relativeFile],
      {
        cwd,
        encoding: "utf8",
        timeout: EXEC_TIMEOUT_MS,
        maxBuffer: EXEC_MAX_BUFFER,
      },
    );
    diffstat = diffOut.trim();
  } catch {
    diffstat = "";
  }
  if (!diffstat && status.startsWith("??")) {
    // An untracked file has no HEAD diffstat; report its line count instead.
    const contents = readFileSync(resolve(cwd, relativeFile), "utf8");
    // A trailing newline ends the last line, not a new one.
    const withoutTrailingNewline = contents.replace(/\r?\n$/u, "");
    const lineCount =
      withoutTrailingNewline.length === 0 ? 0 : withoutTrailingNewline.split(/\r?\n/u).length;
    diffstat = `${relativeFile} | new file, ${lineCount} line(s)`;
  }
  const applied = status.length > 0 && (diffstat.length > 0 || status.startsWith("??"));
  return { applied, status, diffstat };
}

// `--no-renames`: a rename lists both paths here but one in CI's diff. The
// superset is the safe direction for a label map.
export async function gitChangedPaths(base, cwd = repositoryRoot) {
  const { stdout: mergeBaseOut } = await execute("git", ["merge-base", base, "HEAD"], {
    cwd,
    encoding: "utf8",
    timeout: EXEC_TIMEOUT_MS,
  });
  const mergeBase = mergeBaseOut.trim();
  const { stdout } = await execute(
    "git",
    ["diff", "--no-renames", "--name-only", "-z", "--diff-filter=ACDMRTUXB", mergeBase, "HEAD"],
    { cwd, encoding: "utf8", timeout: EXEC_TIMEOUT_MS, maxBuffer: EXEC_MAX_BUFFER },
  );
  return stdout.split("\0").filter(Boolean);
}

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".js", ".mjs"];
const TEST_GLOB_EXTENSIONS = ["test.ts", "test.tsx", "test.mts", "test.mjs", "test.js"];

function isCandidateSourceFile(path) {
  if (!SOURCE_EXTENSIONS.some((extension) => path.endsWith(extension))) return false;
  if (TEST_GLOB_EXTENSIONS.some((suffix) => path.endsWith(`.${suffix}`))) return false;
  if (path.endsWith(".d.ts")) return false;
  return true;
}

function packageRootFor(path) {
  const match = /^(packages\/[^/]+)\//u.exec(path);
  return match ? match[1] : null;
}

function moduleStem(path) {
  const base = path.slice(path.lastIndexOf("/") + 1);
  return base.replace(/\.(tsx|ts|mts|mjs|js)$/u, "");
}

/**
 * Heuristic importer search: `git grep` for the module stem in the package's
 * test files. A printer, not a gate, so a false positive only adds a command.
 */
export async function findImporters(changedPath, cwd = repositoryRoot) {
  const packageRoot = packageRootFor(changedPath);
  if (!packageRoot || !isCandidateSourceFile(changedPath)) return [];
  const stem = moduleStem(changedPath);
  if (!stem || stem === "index") return [];
  try {
    const { stdout } = await execute(
      "git",
      [
        "grep",
        "--fixed-strings",
        "--files-with-matches",
        "-e",
        stem,
        "--",
        `${packageRoot}/**/*.test.ts`,
        `${packageRoot}/**/*.test.tsx`,
        `${packageRoot}/**/*.test.mts`,
        `${packageRoot}/**/*.test.mjs`,
      ],
      { cwd, encoding: "utf8", timeout: EXEC_TIMEOUT_MS, maxBuffer: EXEC_MAX_BUFFER },
    );
    return stdout.split("\n").filter(Boolean).sort();
  } catch (error) {
    // `git grep` exits 1 with no matches; anything else is a real failure.
    if (error && error.code === 1) return [];
    throw error;
  }
}

export function vitestCommandFor(testFile) {
  const packageRoot = packageRootFor(testFile);
  const relativeTestFile = packageRoot ? testFile.slice(packageRoot.length + 1) : testFile;
  return `(cd ${packageRoot ?? "packages/runtime"} && npx vitest run ${relativeTestFile} --testTimeout=180000)`;
}

/**
 * Trailing non-empty output lines a failed check reproduces under the table.
 * The cause of a failed step is at the end of its output; more lines would
 * bury the table. The row's DETAIL column is never truncated.
 *
 * Not a config/limits.yaml entry: it is the display height of a developer
 * command's console output, refuses nothing, and no product surface reads it.
 */
export const FAILURE_OUTPUT_TAIL_LINES = 12;

/**
 * The npm scripts that started, in order, read from npm's two-line stdout
 * banner (`> <package>@<version> <script>` then `> <command>`). The last one
 * names the step running when a chain stopped. Requiring the second `> ` line
 * keeps a command line that contains `name@version` from matching.
 */
export function npmStepNames(stdout) {
  const lines = (stdout ?? "").split(/\r?\n/u);
  const names = [];
  for (let index = 0; index < lines.length - 1; index += 1) {
    const match = /^> (?:@[^\s/]+\/)?[^\s@]+@\S+ (\S+)\s*$/u.exec(lines[index]);
    if (match && lines[index + 1].startsWith("> ")) names.push(match[1]);
  }
  return names;
}

/** stdout produced after the last npm banner, i.e. the failing step's own. */
export function outputAfterLastStep(stdout) {
  const lines = (stdout ?? "").split(/\r?\n/u);
  let start = 0;
  for (let index = 0; index < lines.length - 1; index += 1) {
    const match = /^> (?:@[^\s/]+\/)?[^\s@]+@\S+ \S+\s*$/u.exec(lines[index]);
    if (match && lines[index + 1].startsWith("> ")) start = index + 2;
  }
  return lines.slice(start).join("\n");
}

/**
 * Name the sub-script that failed. When npm prints ``Lifecycle script `x`
 * failed``, innermost first, the first match is the real step. npm 10 and 11
 * omit that line for a plain non-zero exit in a nested `npm run` chain, so the
 * banner trail is the usual path. `fallback` covers a non-npm command and one
 * that died before printing.
 */
export function failingStepName(stdout, stderr, fallback) {
  const lifecycle = /Lifecycle script [`'"]([^`'"]+)[`'"] failed/u.exec(
    `${stderr ?? ""}\n${stdout ?? ""}`,
  );
  if (lifecycle) return lifecycle[1];
  return npmStepNames(stdout).at(-1) ?? fallback;
}

function tailLines(text, count) {
  const lines = (text ?? "")
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
  return lines.slice(-count);
}

function oneLine(text) {
  return (text ?? "").replaceAll(/\s+/gu, " ").trim();
}

function lastNonEmptyLine(text) {
  return tailLines(text, 1).at(-1) ?? "";
}

/**
 * Build the FAIL row: DETAIL names the failing step and the last line it
 * printed, not the first stderr line (an earlier passing step may warn there).
 *
 * stderr carries no step banners, so its tail is preferred only when at most
 * one step ran; for a chain, the failing step's own stdout comes first.
 * Everything captured is reproduced below the table either way.
 */
export function failureRow(name, error) {
  const stdout = typeof error?.stdout === "string" ? error.stdout : "";
  const stderr = typeof error?.stderr === "string" ? error.stderr : "";
  const step = failingStepName(stdout, stderr, name);
  const stepStdout = tailLines(outputAfterLastStep(stdout), FAILURE_OUTPUT_TAIL_LINES);
  const stepStderr = tailLines(stderr, FAILURE_OUTPUT_TAIL_LINES);
  const reported = oneLine(error?.message) || "unknown failure";
  const attributable = npmStepNames(stdout).length <= 1;
  const ordered = attributable ? [stepStderr, stepStdout] : [stepStdout, stepStderr];
  // A killed or overflowed child never prints its own failing line, so name
  // that cause ahead of whatever unrelated tail was captured. `killed` is true
  // when Node's own timeout sent the signal; a `signal` with `killed: false`
  // came from elsewhere (OOM, runner cancel) and is not the timeout.
  const childProcessCause =
    error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
      ? `output exceeded ${EXEC_MAX_BUFFER} bytes (EXEC_MAX_BUFFER)`
      : error?.killed
        ? `timed out after ${EXEC_TIMEOUT_MS}ms (EXEC_TIMEOUT_MS; signal ${error?.signal ?? "unknown"})`
        : error?.signal
          ? `terminated by signal ${error.signal} before it finished (not the EXEC_TIMEOUT_MS timeout; the parent did not kill it)`
          : undefined;
  const cause = childProcessCause ?? ordered[0].at(-1) ?? ordered[1].at(-1) ?? reported;
  const output = [];
  if (stepStdout.length > 0) {
    output.push(`stdout, last ${stepStdout.length} line(s) of ${step}:`, ...stepStdout);
  }
  if (stepStderr.length > 0) {
    output.push(`stderr, last ${stepStderr.length} line(s):`, ...stepStderr);
  }
  return { status: "FAIL", detail: `${step}: ${oneLine(cause)}`, output };
}

async function runNpmScript(name, cwd) {
  try {
    // A package check can contain a full chain of required commands. Its
    // caller owns admission and cancellation; a query watchdog must not cut
    // that chain short while it is still making progress.
    const { stdout } = await execute("npm", ["run", name], {
      cwd,
      encoding: "utf8",
      maxBuffer: EXEC_MAX_BUFFER,
      // Step banners name a failing sub-script; a caller's `--silent` would
      // suppress them in the child.
      env: { ...process.env, npm_config_loglevel: "notice" },
    });
    // npm interleaves a chain's output, so the last line is not deterministic.
    const steps = npmStepNames(stdout);
    return {
      status: "PASS",
      detail: steps.length > 0 ? `${steps.length} npm step(s), last: ${steps.at(-1)}` : "ok",
    };
  } catch (error) {
    return failureRow(name, error);
  }
}

/** Run a repository-wide checker, from the repository root, that CI runs and `check:static` does not. */
async function runRepositoryCheck(label, command, args, cwd) {
  try {
    const { stdout } = await execute(command, args, {
      cwd,
      encoding: "utf8",
      timeout: EXEC_TIMEOUT_MS,
      maxBuffer: EXEC_MAX_BUFFER,
    });
    return { status: "PASS", detail: lastNonEmptyLine(stdout) };
  } catch (error) {
    return failureRow(label, error);
  }
}

async function fetchMrLabels(project, iid) {
  try {
    const { stdout } = await execute("glab", ["api", `projects/${project}/merge_requests/${iid}`], {
      encoding: "utf8",
      timeout: EXEC_TIMEOUT_MS,
      maxBuffer: EXEC_MAX_BUFFER,
    });
    const parsed = JSON.parse(stdout);
    return { available: true, labels: Array.isArray(parsed.labels) ? parsed.labels : [] };
  } catch {
    return { available: false, labels: [] };
  }
}

// Flags that consume the next argv element. A missing value is refused at
// parse time rather than falling back to a default.
const VALUE_FLAGS = new Set([
  "--base",
  "--project",
  "--mr",
  "--root",
  "--scan-file",
  "--allow-close",
  "--mutant-applied",
]);

export function parseArgs(argv) {
  const options = {
    mode: "run",
    base: DEFAULT_BASE,
    project: DEFAULT_PROJECT,
    mr: null,
    file: null,
    root: null,
    allowedCloseIids: [],
  };
  let modeFlag = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    // An empty or whitespace-only value (an unset `"$TARGET"`) counts as missing.
    if (VALUE_FLAGS.has(argument)) {
      const value = argv[index + 1];
      if (value === undefined || value.trim() === "") {
        throw new Error(`${argument} requires a value`);
      }
    }
    if (argument === "--base") {
      options.base = argv[++index];
    } else if (argument === "--project") {
      options.project = argv[++index];
    } else if (argument === "--mr") {
      options.mr = argv[++index];
    } else if (argument === "--root") {
      options.root = argv[++index];
    } else if (argument === "--scan-file") {
      options.mode = "scan-file";
      modeFlag = argument;
      options.file = argv[++index];
    } else if (argument === "--allow-close") {
      const iid = argv[++index];
      if (!/^[1-9]\d*$/u.test(iid)) {
        throw new Error(`--allow-close requires a positive local issue IID: ${iid}`);
      }
      options.allowedCloseIids.push(iid);
    } else if (argument === "--mutant-applied") {
      options.mode = "mutant-applied";
      modeFlag = argument;
      options.file = argv[++index];
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  // --scan-file and --mutant-applied resolve their path from process.cwd(), so
  // `--root` with either would be silently ignored; refuse it instead.
  if (options.root !== null && modeFlag) {
    throw new Error(
      `--root is not supported with ${modeFlag}; ${modeFlag} always resolves its file from the current working directory, not --root`,
    );
  }
  if (options.allowedCloseIids.length > 0 && options.mode !== "scan-file") {
    throw new Error("--allow-close is supported only with --scan-file");
  }
  return options;
}

function printTable(rows) {
  const nameWidth = Math.max(...rows.map((row) => row.name.length), "CHECK".length);
  const statusWidth = Math.max(...rows.map((row) => row.status.length), "STATUS".length);
  const header = `${"CHECK".padEnd(nameWidth)}  ${"STATUS".padEnd(statusWidth)}  DETAIL`;
  console.log(header);
  console.log("-".repeat(header.length));
  for (const row of rows) {
    console.log(
      `${row.name.padEnd(nameWidth)}  ${row.status.padEnd(statusWidth)}  ${row.detail ?? ""}`,
    );
  }
  for (const row of rows) {
    if (!row.output || row.output.length === 0) continue;
    console.log(`\nFailure output for ${row.name}:`);
    for (const line of row.output) console.log(`  ${line}`);
  }
}

async function runDefault(options) {
  const rows = [];
  rows.push({ name: "check:derived", ...(await runNpmScript("check:derived", runtimeRoot)) });
  rows.push({ name: "check:pins", ...(await runNpmScript("check:pins", runtimeRoot)) });
  rows.push({
    name: "check:static (incl. check:limits)",
    ...(await runNpmScript("check:static", runtimeRoot)),
  });
  rows.push({
    name: "check-package-imports.mjs",
    // `node` from PATH like every other command here; an absent node fails
    // the row rather than skipping the gate.
    ...(await runRepositoryCheck(
      "check-package-imports.mjs",
      "node",
      ["packages/runtime/scripts/check-package-imports.mjs"],
      repositoryRoot,
    )),
  });
  rows.push({
    name: "triage-secret-findings.py --check",
    ...(await runRepositoryCheck(
      "triage-secret-findings.py",
      "python3",
      ["scripts/triage-secret-findings.py", "--check"],
      repositoryRoot,
    )),
  });

  // A bad --base renders as a row so the checks already run still print.
  let changedPaths = null;
  let baseError = null;
  try {
    changedPaths = await gitChangedPaths(options.base, repositoryRoot);
  } catch (error) {
    baseError = error;
  }
  const labelRowName = `package-* labels (vs ${options.base})`;
  const { required, unmapped } = computeLabelMap(changedPaths ?? []);
  if (baseError) {
    rows.push({
      name: labelRowName,
      status: "FAIL",
      detail: `cannot diff against ${options.base}`,
      output: tailLines(baseError?.stderr, FAILURE_OUTPUT_TAIL_LINES),
    });
  } else {
    rows.push({
      name: labelRowName,
      status: required.length > 0 ? "INFO" : "N/A",
      detail: required.length > 0 ? required.join(", ") : "no mapped paths changed",
    });
  }

  if (options.mr && !baseError) {
    const mrLabels = await fetchMrLabels(options.project, options.mr);
    if (!mrLabels.available) {
      rows.push({ name: `MR !${options.mr} labels`, status: "SKIP", detail: "glab unavailable" });
    } else {
      const missing = required.filter((label) => !mrLabels.labels.includes(label));
      rows.push({
        name: `MR !${options.mr} labels`,
        status: missing.length === 0 ? "PASS" : "FAIL",
        detail:
          missing.length === 0
            ? `applied: ${mrLabels.labels.join(", ") || "(none required)"}`
            : `missing: ${missing.join(", ")}`,
      });
    }
  }

  printTable(rows);

  if (unmapped.length > 0) {
    console.log("\nChanged paths with no package-* mapping (informational):");
    for (const path of unmapped) console.log(`  ${path}`);
  }

  const changedImporters = [];
  for (const path of changedPaths ?? []) {
    const importers = await findImporters(path, repositoryRoot);
    if (importers.length > 0) changedImporters.push({ path, importers });
  }
  if (changedImporters.length > 0) {
    console.log(
      `\nImporter test files to run before push (source: git diff --name-only ${options.base}):`,
    );
    for (const { path, importers } of changedImporters) {
      console.log(`  ${path}`);
      for (const importer of importers) {
        console.log(`    ${vitestCommandFor(importer)}`);
      }
    }
  }

  return rows.some((row) => row.status === "FAIL") ? 1 : 0;
}

async function runScanFile(file, allowedCloseIids = []) {
  const text = readFileSync(resolve(process.cwd(), file), "utf8");
  const { ok, violations } = scanText(text, { allowedCloseIids });
  if (ok) {
    console.log(`PASS: ${file} carries no closing-pattern or token-shaped text.`);
    return 0;
  }
  console.log(`FAIL: ${file} carries ${violations.length} finding(s):`);
  for (const violation of violations) {
    console.log(`  line ${violation.line} [${violation.type}]: ${violation.excerpt}`);
  }
  return 1;
}

async function runMutantApplied(file) {
  const { applied, status, diffstat } = await checkMutantApplied(file, { cwd: process.cwd() });
  if (!applied) {
    console.log(`FAIL: ${file} does not differ from HEAD; the mutant was not applied.`);
    return 1;
  }
  console.log(`PASS: ${file} differs from HEAD.`);
  console.log(`  git status: ${status || "(clean; unexpected)"}`);
  console.log(`  diffstat:   ${diffstat || "(no diffstat)"}`);
  return 0;
}

/**
 * Default mode's repository root: `--root <dir>`, else the git root of the
 * current working directory rather than of this script's own location.
 */
async function resolveRoots(root) {
  let repoRoot;
  // `!== null`, not truthiness: `null` means the flag is absent, and an empty
  // value must not fall through to the cwd default.
  if (root !== null) {
    repoRoot = resolve(root);
  } else {
    const { stdout } = await execute("git", ["rev-parse", "--show-toplevel"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    repoRoot = stdout.trim();
  }
  return { repositoryRoot: repoRoot, runtimeRoot: resolve(repoRoot, "packages", "runtime") };
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
    return;
  }
  if (options.mode === "scan-file") {
    process.exitCode = await runScanFile(options.file, options.allowedCloseIids);
    return;
  }
  if (options.mode === "mutant-applied") {
    process.exitCode = await runMutantApplied(options.file);
    return;
  }
  ({ repositoryRoot, runtimeRoot } = await resolveRoots(options.root));
  process.exitCode = await runDefault(options);
}

/**
 * Entry-point guard over realpaths. Node's module URL is symlink-resolved, so
 * comparing it to argv[1] as given fails under any symlinked path (macOS
 * `/var`) and `main()` would silently never run, exiting 0 with no output.
 */
function isEntryPoint() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) await main();
