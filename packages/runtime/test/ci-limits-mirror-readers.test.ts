// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Git does not track the limits code mirrors (BUILD_GENERATED_MIRRORS), so
 * every CI job that loads one generates it first. The reader inventory is
 * derived, not listed: each job's commands, with `npm run`/`npm test` scripts
 * and `make` targets expanded, and every Node entry point among them walked
 * through its relative imports. Shell test scripts are not expanded; the host
 * package's CI test holds the deploy and host-fixture shell tests to the same
 * rule.
 */
import { spawnSync } from "node:child_process";
import { existsSync, globSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

import { BUILD_GENERATED_MIRRORS } from "../scripts/check-limits.mjs";
import { LIMIT_DEFINITION_BY_NAME } from "../src/config/limits.generated.js";
import { jobNames, readGitlabCiConfig } from "./helpers/gitlab-ci.js";
import { internalOnly } from "./helpers/internal-path.js";
import { TEST_TIMEOUT_LIMITS, testTimeoutMs } from "./helpers/test-timeouts.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..", "..");
const ciPipeline = internalOnly(
  [".gitlab/ci/runtime.yml", "benchmarks"],
  "it walks the GitLab CI definition and the benchmark jobs, which are not exported",
);
// The whole merged CI definition: `make -n` per make line and an import walk
// over the runtime source graph. Budgeted at the shared CI default even
// locally, rather than with a literal of its own.
const DERIVATION_TEST_MS = LIMIT_DEFINITION_BY_NAME[TEST_TIMEOUT_LIMITS.ciTest]!.value;
const RUNTIME_RUN = /^bash "\$CI_PROJECT_DIR\/\.gitlab\/ci\/runtime-run\.sh" /u;
const NIGHTLY_DERIVED_ENTRY = "$CI_PROJECT_DIR/.gitlab/ci/bench-nightly/prepare-derived.mjs";
const nightlyDerivedPath = join(repositoryRoot, ".gitlab/ci/bench-nightly/prepare-derived.mjs");
// The exported public tree deliberately has no GitLab CI helper. Its whole CI
// audit is skipped there, so no import or read may occur before that skip.
const NIGHTLY_DERIVED_SOURCE = ciPipeline.skip ? "" : readFileSync(nightlyDerivedPath, "utf8");
const NIGHTLY_DERIVED_STEPS: readonly string[] = ciPipeline.skip
  ? []
  : (await import(pathToFileURL(nightlyDerivedPath).href)).DERIVED_STEPS;
// The shim re-exports the TS mirror, so loading either loads the mirror.
const MIRROR_FILES = new Set([
  ...BUILD_GENERATED_MIRRORS,
  "packages/runtime/src/config/limits.generated.js",
]);
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["'](\.\.?\/[^"']+)["']/gu;

type Command = { text: string; cwd: string };

function flatten(lines: unknown): string[] {
  if (lines === undefined || lines === null) return [];
  if (typeof lines === "string") return [lines];
  if (Array.isArray(lines)) return lines.flatMap((line) => flatten(line));
  throw new Error(`a script entry is neither a string nor a list: ${JSON.stringify(lines)}`);
}

/** Each job's before_script then script, with `extends` resolved. */
function jobScripts(
  definitions: Record<string, unknown>,
  names: readonly string[],
): Map<string, string[]> {
  const scriptOf = (
    name: string,
    key: "before_script" | "script",
    seen: string[] = [],
  ): unknown => {
    if (seen.includes(name))
      throw new Error(`extends cycle through ${[...seen, name].join(" -> ")}`);
    const job = definitions[name] as Record<string, unknown> | undefined;
    if (job === undefined) throw new Error(`${name} is not in the loaded CI files`);
    if (key in job) return job[key];
    // GitLab merges extends left to right, so the last parent that sets the key wins.
    for (const parent of [...flatten(job.extends)].reverse()) {
      const inherited = scriptOf(parent, key, [...seen, name]);
      if (inherited !== undefined) return inherited;
    }
    return undefined;
  };
  const jobs = new Map<string, string[]>();
  for (const name of names) {
    const script = scriptOf(name, "script");
    if (script !== undefined)
      jobs.set(name, [...flatten(scriptOf(name, "before_script")), ...flatten(script)]);
  }
  return jobs;
}

function words(text: string): string[] {
  return [...text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/gu)].map(
    (match) => match[1] ?? match[2] ?? match[3] ?? "",
  );
}

function packageScript(cwd: string, name: string): string | undefined {
  const manifest = join(repositoryRoot, cwd, "package.json");
  if (!existsSync(manifest)) return undefined;
  return (JSON.parse(readFileSync(manifest, "utf8")).scripts ?? {})[name];
}

/** One command, expanded into the atomic commands it runs, in order. */
function expand(command: Command, expanding: readonly string[] = []): Command[] {
  // A script or target that reaches itself again would expand forever.
  const key = `${command.cwd}\0${command.text}`;
  if (expanding.includes(key)) throw new Error(`expansion cycle through ${command.text}`);
  const within = [...expanding, key];
  let { text, cwd } = command;
  if (RUNTIME_RUN.test(text)) {
    text = text.replace(RUNTIME_RUN, "");
    cwd = "packages/runtime";
  }
  const parts = words(text).filter((word) => !/^[A-Z_][A-Z0-9_]*=/u.test(word));
  if (parts[0] === "npm" && (parts[1] === "run" || parts[1] === "test")) {
    const prefix = parts.indexOf("--prefix");
    const target =
      prefix === -1
        ? cwd
        : relative(
            repositoryRoot,
            resolve(repositoryRoot, parts[prefix + 1]!.replace("$CI_PROJECT_DIR", ".")),
          );
    const name = parts[1] === "test" ? "test" : parts[2]!;
    const script = packageScript(target, name);
    if (script === undefined) return [{ text, cwd }];
    return script.split("&&").flatMap((part) => expand({ text: part.trim(), cwd: target }, within));
  }
  if (parts[0] === "make" && !text.includes("$")) {
    const planned = spawnSync("make", ["-n", ...parts.slice(1)], {
      cwd: join(repositoryRoot, cwd),
      encoding: "utf8",
    });
    if (planned.status !== 0)
      throw new Error(`make -n ${parts.slice(1).join(" ")} failed: ${planned.stderr}`);
    return planned.stdout
      .split("\n")
      .filter((line) => line.trim() !== "")
      .flatMap((line) => expand({ text: line.trim(), cwd }, within));
  }
  return [{ text, cwd }];
}

// Many jobs share their install and make lines; each expands once.
const expansions = new Map<string, Command[]>();

/** Each script entry split into its commands, then expanded. */
function jobCommands(lines: readonly string[]): Command[] {
  return lines
    .flatMap((line) => line.split(/\n|&&|;/u))
    .map((text) => text.trim())
    .filter((text) => text !== "" && !text.startsWith("#"))
    .flatMap((text) => {
      let expanded = expansions.get(text);
      if (expanded === undefined) {
        expanded = expand({ text, cwd: "." });
        expansions.set(text, expanded);
      }
      return expanded;
    });
}

/** Whether the command writes the limits code mirrors. */
function generates({ text }: Command): boolean {
  if (nightlyWrapperGenerates(text)) return true;
  const steps = /ensure-derived\.mjs(?:\s+--steps\s+(\S+))?/u.exec(text);
  if (steps !== null) return steps[1] === undefined || steps[1].split(",").includes("limits");
  return /\bcheck-limits\.mjs\s*$|\bgenerate-derived\.mjs(?:\s+--machine)?\s*(?:--report|$)/u.test(
    text,
  );
}

/** Only the exact stripped bootstrap command may stand for its maintained generator call. */
function nightlyWrapperGenerates(
  text: string,
  steps: readonly string[] = NIGHTLY_DERIVED_STEPS,
  source: string = NIGHTLY_DERIVED_SOURCE,
): boolean {
  const parts = words(text).filter((word) => !/^[A-Z_][A-Z0-9_]*=/u.test(word));
  return (
    parts.length === 4 &&
    parts[0] === "env" &&
    parts[1] === "-i" &&
    parts[2] === "node" &&
    parts[3] === NIGHTLY_DERIVED_ENTRY &&
    steps.includes("limits") &&
    /await ensureDerived\(\{\s*runtimeRoot,\s*steps:\s*selectEnsureDerivedSteps\(DERIVED_STEPS\)\s*\}\)/u.test(
      source,
    )
  );
}

function resolveImport(from: string, specifier: string): string | undefined {
  const target = resolve(dirname(from), specifier);
  for (const candidate of [target, target.replace(/\.js$/u, ".ts")]) {
    if (MIRROR_FILES.has(relative(repositoryRoot, candidate))) return candidate;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return undefined;
}

// Each file's relative imports, parsed once: many entry points share most of
// the runtime source graph.
const importsOf = new Map<string, string[]>();
function fileImports(file: string): string[] {
  let imports = importsOf.get(file);
  if (imports === undefined) {
    imports = [];
    if (/\.(?:m?[jt]s|mts)$/u.test(file) && !file.includes("node_modules")) {
      for (const [, specifier] of readFileSync(file, "utf8").matchAll(SPECIFIER)) {
        const target = resolveImport(file, specifier!);
        if (target !== undefined) imports.push(target);
      }
    }
    importsOf.set(file, imports);
  }
  return imports;
}

/** The mirrors an entry point loads through its relative imports. */
function mirrorsReached(entry: string): string[] {
  const seen = new Set<string>([entry]);
  const reached = new Set<string>();
  const queue = [entry];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    const path = relative(repositoryRoot, next);
    if (MIRROR_FILES.has(path)) {
      reached.add(path);
      continue;
    }
    for (const target of fileImports(next)) {
      if (!seen.has(target)) {
        seen.add(target);
        queue.push(target);
      }
    }
  }
  return [...reached].sort();
}

const entriesOf = new Map<string, string[]>();
/** The Node entry points of one atomic command, globs expanded. */
function nodeEntries(command: Command): string[] {
  const key = `${command.cwd}\0${command.text}`;
  let entries = entriesOf.get(key);
  if (entries === undefined) {
    entries = commandEntries(command);
    entriesOf.set(key, entries);
  }
  return entries;
}

function commandEntries({ text, cwd }: Command): string[] {
  const parts = words(text).filter((word) => !/^[A-Z_][A-Z0-9_]*=/u.test(word));
  const node = parts[0] === "env" && parts[1] === "-i" ? 2 : 0;
  if (parts[node] !== "node") return [];
  const entries: string[] = [];
  for (let index = node + 1; index < parts.length; index += 1) {
    const word = parts[index]!;
    if (word === "--import" || word === "--require") {
      index += 1;
      continue;
    }
    if (!/\.(?:m?[jt]s|mts)$/u.test(word)) continue;
    const path = word.replace("$CI_PROJECT_DIR", repositoryRoot);
    const base = join(repositoryRoot, cwd);
    entries.push(...globSync(path, { cwd: base }).map((match) => resolve(base, match)));
  }
  return entries;
}

/** Each reader command that runs before any command generating the mirrors. */
function unanchoredReaders(jobs: Map<string, string[]>): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const [name, lines] of jobs) {
    let generated = false;
    for (const command of jobCommands(lines)) {
      if (generates(command)) generated = true;
      const reached = nodeEntries(command).flatMap((entry) => mirrorsReached(entry));
      if (reached.length > 0 && !generated) {
        result.set(name, [
          ...(result.get(name) ?? []),
          `${command.text} loads ${[...new Set(reached)].join(", ")}`,
        ]);
      }
    }
  }
  return result;
}

function readers(jobs: Map<string, string[]>): string[] {
  return [...jobs]
    .filter(([, lines]) =>
      jobCommands(lines).some((command) =>
        nodeEntries(command).some((entry) => mirrorsReached(entry).length > 0),
      ),
    )
    .map(([name]) => name)
    .sort();
}

function syntheticJobs(text: string): Map<string, string[]> {
  const definitions = parse(text) as Record<string, unknown>;
  return jobScripts(
    definitions,
    Object.keys(definitions).filter((name) => !name.startsWith(".")),
  );
}

describe.skipIf(ciPipeline.skip)(
  ciPipeline.title("CI jobs that load a limits code mirror generate it first"),
  () => {
    it(
      "derives the readers from the merged CI definition, and every one generates the mirrors before it loads one",
      async () => {
        const config = await readGitlabCiConfig(repositoryRoot);
        const jobs = jobScripts(config.definitions, jobNames(config));
        const derived = readers(jobs);
        // Positive controls are real runtime and knowledge readers. Bench jobs
        // using their checked-in projection stay independent of runtime mirrors.
        for (const expected of ["knowledge:test", "runtime:mr-assessment"]) {
          expect(derived, `${expected} is not among the derived readers`).toContain(expected);
        }
        expect(derived).not.toContain("benchmarks:dind-tls-proof");
        expect(Object.fromEntries(unanchoredReaders(jobs))).toEqual({});
      },
      testTimeoutMs(DERIVATION_TEST_MS),
    );

    it("admits only the exact key-free nightly generator before a reader", () => {
      const helper = `env -i PATH=/usr/bin:/bin node "${NIGHTLY_DERIVED_ENTRY}"`;
      const reader = "node --import tsx packages/runtime/test/first-pass-default-bounds.test.ts";
      expect(nightlyWrapperGenerates(helper)).toBe(true);
      expect(nightlyWrapperGenerates(helper, ["model-output"])).toBe(false);
      expect(nightlyWrapperGenerates(helper.replace("prepare-derived.mjs", "other.mjs"))).toBe(
        false,
      );
      expect(
        nightlyWrapperGenerates(
          helper,
          NIGHTLY_DERIVED_STEPS,
          NIGHTLY_DERIVED_SOURCE.replace(
            "selectEnsureDerivedSteps(DERIVED_STEPS)",
            "selectEnsureDerivedSteps([])",
          ),
        ),
      ).toBe(false);
      const ordered = syntheticJobs(
        ["ordered:", "  script:", `    - ${helper}`, `    - ${reader}`].join("\n"),
      );
      expect(Object.fromEntries(unanchoredReaders(ordered))).toEqual({});
      const moved = syntheticJobs(
        ["moved:", "  script:", `    - ${reader}`, `    - ${helper}`].join("\n"),
      );
      expect(unanchoredReaders(moved).has("moved")).toBe(true);
      const wrong = syntheticJobs(
        [
          "wrong:",
          "  script:",
          `    - ${helper.replace("prepare-derived.mjs", "other.mjs")}`,
          `    - ${reader}`,
        ].join("\n"),
      );
      expect(unanchoredReaders(wrong).has("wrong")).toBe(true);
    });

    it("refuses a job that loads a mirror before generating it, through Node, make or npm", () => {
      const jobs = syntheticJobs(
        [
          "direct:",
          "  script:",
          "    - node --import tsx packages/runtime/test/first-pass-default-bounds.test.ts",
          "late:",
          "  script:",
          "    - node --test packages/knowledge/tests/*.test.mjs",
          "    - node packages/runtime/scripts/ensure-derived.mjs --steps limits",
          "other-step:",
          "  script:",
          "    - node packages/runtime/scripts/ensure-derived.mjs --steps model-output",
          "    - node packages/knowledge/tests/first-pass-intent-seeds.test.mjs",
          "knowledge-direct:",
          "  script:",
          "    - node packages/knowledge/tests/first-pass-intent-seeds.test.mjs",
          "benchmark-direct-nonreader:",
          "  script:",
          "    - node benchmarks/sandbox/probes.mjs",
          "benchmark-glob-nonreader:",
          "  script:",
          "    - node --test benchmarks/sandbox/*.test.mjs",
          "benchmark-late-nonreader:",
          "  script:",
          "    - node benchmarks/sandbox/probes.mjs",
          "    - node packages/runtime/scripts/ensure-derived.mjs --steps limits",
          "benchmark-make-nonreader:",
          "  script:",
          "    - make benchmark-validate",
          "",
        ].join("\n"),
      );
      expect([...unanchoredReaders(jobs).keys()].sort()).toEqual([
        "direct",
        "knowledge-direct",
        "late",
        "other-step",
      ]);
      const benchmarkNonReaders = [
        "benchmark-direct-nonreader",
        "benchmark-glob-nonreader",
        "benchmark-late-nonreader",
        "benchmark-make-nonreader",
      ];
      for (const job of benchmarkNonReaders) {
        expect(
          readers(jobs),
          `${job} should use the benchmark-local limits projection`,
        ).not.toContain(job);
      }
    });

    it("accepts the adjacent jobs: generation first, a hooked npm script, a make target that generates, and a non-reader", () => {
      // Retained product adapter tests still load runtime mirrors. Benchmark
      // validation can use only its independent checked-in limits projection.
      const jobs = syntheticJobs(
        [
          "anchored:",
          "  script:",
          "    - node packages/runtime/scripts/ensure-derived.mjs --steps limits",
          "    - node --import tsx packages/runtime/test/first-pass-default-bounds.test.ts",
          "npm-hook:",
          "  script:",
          "    - npm test --prefix packages/knowledge",
          "make-target:",
          "  script:",
          "    - make benchmark-test",
          "non-reader:",
          "  script:",
          "    - node benchmarks/runtime-contribution/run/cli.mjs validate",
          "",
        ].join("\n"),
      );
      expect(readers(jobs)).toEqual(["anchored", "make-target", "npm-hook"]);
      expect(Object.fromEntries(unanchoredReaders(jobs))).toEqual({});
    });
  },
);
