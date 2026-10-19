// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

import { limit } from "../src/config/limits.js";
import { readGitlabCiConfig } from "./helpers/gitlab-ci.js";
import { internalOnly } from "./helpers/internal-path.js";

// Wiring of the scheduled workflow canary: which pipelines create
// it, what it extends, and which of its commands see which credential.
// Offline; nothing here starts a pipeline, reads a secret, or calls a model.

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const runtimeRun = join(repositoryRoot, ".gitlab/ci/runtime-run.sh");
const JOB = "runtime:workflow-canary";
const TREND_JOB = "runtime:workflow-canary:trend";
const roots: string[] = [];
const gitlabCi = internalOnly(
  ".gitlab/ci",
  "it pins the GitLab CI definition, which is not exported",
);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

type Rule = { if?: string; when?: string; changes?: unknown };
type GitlabJob = {
  extends?: string | string[];
  rules?: Rule[];
  needs?: unknown[];
  variables?: Record<string, string>;
  script?: string[];
  secrets?: Record<string, unknown>;
  interruptible?: boolean;
  allow_failure?: boolean | { exit_codes?: number[] };
  tags?: string[];
  timeout?: string;
  retry?: { max?: number; when?: string[] };
  artifacts?: { when?: string; paths?: string[]; expire_in?: string };
  environment?: string | { name?: string; action?: string };
  id_tokens?: Record<string, unknown>;
  before_script?: string[];
  after_script?: string[];
  resource_group?: string;
};
type CiVariables = Record<string, string | undefined>;

async function readPipeline(): Promise<Record<string, GitlabJob>> {
  return (await readGitlabCiConfig(repositoryRoot)).definitions as Record<string, GitlabJob>;
}

function asList(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * The one template the canary extends that declares native CI secrets. The
 * template's name belongs to the internal CI configuration, so it is read from
 * the job rather than named here.
 */
function secretTemplateName(pipeline: Record<string, GitlabJob>): string {
  const names = asList(pipeline[JOB]!.extends).filter(
    (parent) => resolveJob(pipeline, parent).secrets !== undefined,
  );
  if (names.length !== 1) {
    throw new Error(
      `${JOB} must extend exactly one secret-bearing template; found ${names.length}`,
    );
  }
  return names[0]!;
}

/** GitLab `extends`: later parents win; rules and needs replace, variables merge. */
function resolveJob(pipeline: Record<string, GitlabJob>, name: string): GitlabJob {
  const raw = pipeline[name];
  if (!raw) throw new Error(`extends target ${name} is not in the loaded CI files`);
  let merged: GitlabJob = {};
  for (const parent of asList(raw.extends)) {
    const inherited = resolveJob(pipeline, parent);
    merged = {
      ...merged,
      ...inherited,
      variables: { ...merged.variables, ...inherited.variables },
    };
  }
  return { ...merged, ...raw, variables: { ...merged.variables, ...raw.variables } };
}

/**
 * The subset of GitLab `if:` syntax these rules use: == and != against a
 * quoted string, =~ with flags, and && / || without parentheses. An unset
 * variable is null: it never equals a literal. Anything else throws, so an
 * unsupported rule cannot pass as a non-match.
 */
function evaluateIf(expression: string, vars: CiVariables): boolean {
  return expression.split(" || ").some((group) =>
    group.split(" && ").every((atom) => {
      const trimmed = atom.trim();
      const comparison = /^\$([A-Z_]+) (==|!=) "([^"]*)"$/u.exec(trimmed);
      if (comparison) {
        const equal = vars[comparison[1]!] === comparison[3];
        return comparison[2] === "==" ? equal : !equal;
      }
      const regex = /^\$([A-Z_]+) =~ \/(.*)\/([a-z]*)$/u.exec(trimmed);
      if (regex) {
        const value = vars[regex[1]!];
        return value !== undefined && new RegExp(regex[2]!, `u${regex[3]}`).test(value);
      }
      throw new Error(`Unsupported CI rule expression: ${expression}`);
    }),
  );
}

/**
 * The `when` of the first rule that matches, or `never` when none does.
 * Predefined < job variables < project/pipeline/schedule overrides, as GitLab orders them.
 */
function selectedWhen(
  job: GitlabJob,
  predefined: CiVariables,
  overrides: CiVariables = {},
): string {
  const scope = { ...predefined, ...job.variables, ...overrides };
  for (const rule of job.rules ?? []) {
    if (rule.changes) throw new Error("the canary rules must not depend on changed paths");
    if (rule.if && !evaluateIf(rule.if, scope)) continue;
    return rule.when ?? "on_success";
  }
  return "never";
}

function created(job: GitlabJob, predefined: CiVariables, overrides: CiVariables = {}): boolean {
  return selectedWhen(job, predefined, overrides) !== "never";
}

/** The jobs that spend model budget on a schedule without being the canary. */
const LIVE_MODEL_JOBS = ["runtime:live-model", "runtime:live-journey"] as const;

const PROTECTED_MAIN_SCHEDULE: CiVariables = {
  CI_PIPELINE_SOURCE: "schedule",
  CI_PROJECT_ID: "437040",
  CI_COMMIT_BRANCH: "main",
  CI_DEFAULT_BRANCH: "main",
  CI_COMMIT_REF_PROTECTED: "true",
};
const OPT_IN = { DOCSFAB_WORKFLOW_CANARY: "1" };

/** The command lines of a job as GitLab runs them: inherited setup, then script, then teardown. */
function jobCommands(job: GitlabJob): string[] {
  return [...(job.before_script ?? []), ...(job.script ?? []), ...(job.after_script ?? [])];
}

/**
 * The tarball arguments of every `npm install` (`i`, `add`) in the command
 * lines: the shell words ending in .tgz, .tar.gz, or .tar, quotes removed. A
 * command ends at the next `;`, `&`, `|`, or line break; a backslash continues it.
 */
function npmInstallTarballs(lines: readonly string[]): string[] {
  const text = lines.join("\n").replace(/\\\n/gu, " ");
  const specs: string[] = [];
  for (const command of text.matchAll(/\bnpm\s+(?:install|i|add)\b([^\n;&|]*)/gu)) {
    for (const word of command[1]!.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/gu)) {
      const spec = (word[1] ?? word[2] ?? word[3]!).replace(/["']/gu, "");
      if (/\.(?:tgz|tar\.gz|tar)$/iu.test(spec)) specs.push(spec);
    }
  }
  return specs;
}

/** The `--output-dir` a job gives prepare-packed-cli.mjs, a directory under packages/runtime. */
function preparedLeaf(commands: readonly string[]): string | undefined {
  return /prepare-packed-cli\.mjs --output-dir (\S+)/u.exec(commands.join("\n"))?.[1];
}

/**
 * What npm reads as a file path. Any other `dir/file.tgz` is a GitHub
 * owner/repo shorthand, and npm runs a git ls-remote over ssh against
 * github.com for it. `$` starts a variable that expands to an absolute path.
 */
const FILE_SPEC = /^(?:\.\/|\/|\$)/u;

describe.skipIf(gitlabCi.skip)(gitlabCi.title("workflow canary CI selection"), () => {
  it("is created only on a scheduled protected-main pipeline whose schedule opts in", async () => {
    const pipeline = await readPipeline();
    const job = resolveJob(pipeline, JOB);
    expect(created(job, PROTECTED_MAIN_SCHEDULE, OPT_IN)).toBe(true);

    // The nightly live-model schedule sets no opt-in, so it does not buy a canary.
    expect(created(job, PROTECTED_MAIN_SCHEDULE)).toBe(false);
    expect(created(job, PROTECTED_MAIN_SCHEDULE, { DOCSFAB_WORKFLOW_CANARY: "0" })).toBe(false);
    expect(created(job, PROTECTED_MAIN_SCHEDULE, { DOCSFAB_WORKFLOW_CANARY: "true" })).toBe(false);
    for (const source of [
      "push",
      "merge_request_event",
      "web",
      "api",
      "trigger",
      "pipeline",
      "parent_pipeline",
    ]) {
      expect(
        created(job, { ...PROTECTED_MAIN_SCHEDULE, CI_PIPELINE_SOURCE: source }, OPT_IN),
        source,
      ).toBe(false);
    }
    for (const changed of [
      { CI_PROJECT_ID: "1" },
      { CI_COMMIT_BRANCH: "feature" },
      { CI_COMMIT_BRANCH: undefined },
      { CI_COMMIT_REF_PROTECTED: "false" },
      { CI_COMMIT_REF_PROTECTED: undefined },
    ]) {
      expect(
        created(job, { ...PROTECTED_MAIN_SCHEDULE, ...changed }, OPT_IN),
        JSON.stringify(changed),
      ).toBe(false);
    }
    // A redirected Vault connection or debug trace never reaches native secret resolution.
    for (const override of [
      { VAULT_SERVER_URL: "https://vault.example.test" },
      { VAULT_NAMESPACE: "other" },
      { VAULT_AUTH_PATH: "jwt/other" },
      { VAULT_AUTH_ROLE: "other" },
      { CI_DEBUG_TRACE: "true" },
      { CI_DEBUG_SERVICES: "1" },
    ]) {
      expect(
        created(job, PROTECTED_MAIN_SCHEDULE, { ...OPT_IN, ...override }),
        JSON.stringify(override),
      ).toBe(false);
    }
    // The guards are the secret template's own, in the same order, before the allow rule.
    expect(job.rules?.slice(0, 2)).toEqual(
      pipeline[secretTemplateName(pipeline)]!.rules?.slice(0, 2),
    );
    expect(job.rules?.at(-1)).toEqual({ when: "never" });
  });

  it("starts the live-model jobs on the plain schedule and the canary only on a schedule that opts in", async () => {
    const pipeline = await readPipeline();
    const canary = resolveJob(pipeline, JOB);
    const guards = pipeline[secretTemplateName(pipeline)]!.rules?.slice(0, 2);
    // The live-model schedule sets no opt-in: it starts the live jobs and no canary.
    expect(created(canary, PROTECTED_MAIN_SCHEDULE)).toBe(false);
    // The canary schedule opts in: it starts the canary and no live job.
    expect(created(canary, PROTECTED_MAIN_SCHEDULE, OPT_IN)).toBe(true);
    for (const name of LIVE_MODEL_JOBS) {
      const live = resolveJob(pipeline, name);
      expect(selectedWhen(live, PROTECTED_MAIN_SCHEDULE), name).toBe("on_success");
      expect(selectedWhen(live, PROTECTED_MAIN_SCHEDULE, OPT_IN), name).toBe("never");
      // Only the literal 1 opts in, as for the canary, so a near miss keeps the live job.
      for (const value of ["0", "true", "yes", ""]) {
        expect(
          selectedWhen(live, PROTECTED_MAIN_SCHEDULE, { DOCSFAB_WORKFLOW_CANARY: value }),
          `${name} DOCSFAB_WORKFLOW_CANARY=${JSON.stringify(value)}`,
        ).toBe("on_success");
      }
      // The Vault and debug guards stay first, ahead of the opt-in guard and every allow rule.
      expect(live.rules?.slice(0, 2), name).toEqual(guards);
      expect(live.rules?.at(-1), name).toEqual({ when: "never" });
    }
  });

  it("never selects the canary and a live-model job in one pipeline, and changes no other selection", async () => {
    const pipeline = await readPipeline();
    const canary = resolveJob(pipeline, JOB);
    const sources = ["schedule", "web", "api", "push", "merge_request_event", "trigger"];
    const optIns = [undefined, "", "0", "1", "true"];
    const scopes: CiVariables[] = [
      {},
      { CI_PROJECT_ID: "1" },
      { CI_COMMIT_BRANCH: "feature" },
      { CI_COMMIT_REF_PROTECTED: "false" },
    ];
    const cells = sources.flatMap((source) =>
      optIns.flatMap((optIn) => scopes.map((scope) => ({ source, optIn, scope }))),
    );
    for (const name of LIVE_MODEL_JOBS) {
      const live = resolveJob(pipeline, name);
      // The same job without the opt-in rule: how it selected before the guard.
      const before = {
        ...live,
        rules: live.rules?.filter((rule) => !rule.if?.includes("DOCSFAB_WORKFLOW_CANARY")),
      };
      expect(live.rules?.length, name).toBe((before.rules?.length ?? 0) + 1);
      let overlapWithoutGuard = 0;
      for (const { source, optIn, scope } of cells) {
        const predefined = { ...PROTECTED_MAIN_SCHEDULE, ...scope, CI_PIPELINE_SOURCE: source };
        const overrides = { DOCSFAB_WORKFLOW_CANARY: optIn };
        const cell = `${name} ${source} ${JSON.stringify(overrides)} ${JSON.stringify(scope)}`;
        const was = selectedWhen(before, predefined, overrides);
        const now = selectedWhen(live, predefined, overrides);
        // Only a schedule that opts in changes, and it changes to never.
        expect(now, cell).toBe(source === "schedule" && optIn === "1" ? "never" : was);
        if (created(canary, predefined, overrides)) {
          expect(now, cell).toBe("never");
          if (was !== "never") overlapWithoutGuard += 1;
        }
      }
      // Positive control: without the guard the same pipelines select both jobs.
      expect(overlapWithoutGuard, name).toBeGreaterThan(0);
    }
  });
});

describe.skipIf(gitlabCi.skip)(gitlabCi.title("workflow canary CI job"), () => {
  it("extends the secret template and the catalogued platform bounds, survives newer commits, and needs nothing", async () => {
    const pipeline = await readPipeline();
    const raw = pipeline[JOB]!;
    const secretTemplate = secretTemplateName(pipeline);
    expect(asList(raw.extends)).toEqual([
      ".runtime_unprivileged",
      secretTemplate,
      ".rules:workflow-canary",
      ".ci_live_model_platform_bounds",
    ]);
    const job = resolveJob(pipeline, JOB);
    expect(job.secrets).toBeDefined();
    expect(job.secrets).toEqual(pipeline[secretTemplate]!.secrets);
    expect(job.rules).toEqual(pipeline[".rules:workflow-canary"]!.rules);
    // auto_cancel on_new_commit: interruptible cancels only interruptible jobs.
    expect(raw.interruptible).toBe(false);
    expect(raw.needs).toEqual([]);
    expect(raw.allow_failure).toBe(true);
    expect(raw.retry?.when).toEqual(["runner_system_failure"]);
    // Job timeout and artifact expiry come only from the generated include.
    expect(raw.timeout).toBeUndefined();
    expect(raw.artifacts?.expire_in).toBeUndefined();
    expect(job.timeout).toBe(pipeline[".ci_live_model_platform_bounds"]!.timeout);
    expect(raw.artifacts).toEqual({
      when: "always",
      paths: ["packages/runtime/ci-results/workflow-canary/"],
    });
    // The matrix reserve leaves the job time to write its summary and upload it.
    expect(limit("localWorkflows.canaryJobReserveMs").value).toBeLessThan(
      limit("ci.liveModel.jobTimeoutMs").value,
    );
    expect(raw.resource_group).toBe("workflow-canary-matrix");
  });

  it("hands MODEL_API_KEY only to configuration preparation and holds no GitLab token", async () => {
    const job = (await readPipeline())[JOB]!;
    const script = job.script ?? [];
    const prepare = script.filter((line) => line.includes("prepare-live-model-ci-config.ts"));
    expect(prepare).toEqual([
      'bash "$CI_PROJECT_DIR/.gitlab/ci/runtime-run.sh" node --import tsx scripts/prepare-live-model-ci-config.ts',
    ]);
    const run = script.find((line) => line.includes('canary.mjs" run'));
    expect(run).toMatch(
      /bash "\$CI_PROJECT_DIR\/\.gitlab\/ci\/runtime-run\.sh" node "\$CI_PROJECT_DIR\/benchmarks\/local-workflows\/canary\.mjs" run/u,
    );
    expect(run).toContain(
      '--collect-dir "$CI_PROJECT_DIR/packages/runtime/ci-results/workflow-canary"',
    );
    // The deadline counts from job start, so setup time is measured, not guessed.
    expect(run).toContain('--job-started-at "$CI_JOB_STARTED_AT"');
    // Private output root outside the checkout, as for the live-model evidence roots.
    expect(run).toMatch(/"\$[A-Z_][A-Z0-9_]*\/workflow-canary"/u);
    // The comparison and the token live only in the trend job.
    expect(script.join("\n")).not.toMatch(/canary-trend\.mjs|DOCSFAB_CANARY_GITLAB_TOKEN/u);
    expect(job.environment).toBeUndefined();
    // No repeat count, budget, window, or threshold literal in the job. The one
    // optional flag takes a schedule variable, never a number, so the catalogued
    // rounds stand when the schedule sets nothing.
    const text = script.join("\n");
    expect(text).not.toMatch(/--budget-ms\b/u);
    expect(text.match(/--repeats\b/gu)).toHaveLength(1);
    expect(run).toContain('${DOCSFAB_CANARY_REPEATS:+--repeats "$DOCSFAB_CANARY_REPEATS"}');
  });

  it("passes DOCSFAB_CANARY_REPEATS as one --repeats argument, or nothing when it is unset or empty", async () => {
    const job = (await readPipeline())[JOB]!;
    const step = (job.script ?? []).find((line) => line.includes('canary.mjs" run'));
    expect(step).toBeDefined();
    const checkout = await mkdtemp(join(tmpdir(), "docsfab-canary-argv-"));
    roots.push(checkout);
    await mkdir(join(checkout, ".gitlab", "ci"), { recursive: true });
    // Stands in for runtime-run.sh and prints each argument the matrix would receive.
    await writeFile(
      join(checkout, ".gitlab", "ci", "runtime-run.sh"),
      '#!/usr/bin/env bash\nprintf "%s\\n" "$@"\n',
    );
    const matrixArguments = (schedule: Record<string, string>): string[] => {
      const result = spawnSync("bash", ["-c", step!], {
        encoding: "utf8",
        cwd: checkout,
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          CI_PROJECT_DIR: checkout,
          DOCSFAB_TEST_TRUSTED_ROOT: join(checkout, "trusted"),
          CI_JOB_STARTED_AT: "2026-10-01T00:00:00Z",
          ...schedule,
        },
      });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout.split("\n").slice(0, -1);
    };
    // Nothing set: node runs the canary script with its output root, collect
    // directory, and job start, and no round count.
    const unset = matrixArguments({});
    expect(unset.slice(0, 3)).toEqual(["node", expect.stringMatching(/canary\.mjs$/u), "run"]);
    expect(unset.slice(-2)).toEqual(["--job-started-at", "2026-10-01T00:00:00Z"]);
    expect(unset).not.toContain("--repeats");
    expect(matrixArguments({ DOCSFAB_CANARY_REPEATS: "" })).toEqual(unset);
    expect(matrixArguments({ DOCSFAB_CANARY_REPEATS: "2" })).toEqual([...unset, "--repeats", "2"]);
    // A value with spaces or shell syntax stays one argument, and canary.mjs refuses it as not a number.
    const hostile = "2 --concurrency 9 $(touch injected)";
    expect(matrixArguments({ DOCSFAB_CANARY_REPEATS: hostile })).toEqual([
      ...unset,
      "--repeats",
      hostile,
    ]);
    expect(await readdir(checkout)).toEqual([".gitlab"]);
  });

  it("keeps the GitLab token and the model key out of the unprivileged matrix run", async () => {
    const bin = await mkdtemp(join(tmpdir(), "docsfab-canary-run-bin-"));
    roots.push(bin);
    await writeFile(join(bin, "runuser"), '#!/usr/bin/env bash\nshift\nshift\nshift\nexec "$@"\n');
    await chmod(join(bin, "runuser"), 0o755);
    await writeFile(join(bin, "node"), "#!/usr/bin/env bash\nprintenv\n");
    await chmod(join(bin, "node"), 0o755);
    const childEnv = (command: readonly string[]) => {
      const result = spawnSync("bash", [runtimeRun, ...command], {
        encoding: "utf8",
        env: {
          PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
          CI_PROJECT_DIR: repositoryRoot,
          HOME: join(bin, "home"),
          DOCSFAB_TEST_TRUSTED_ROOT: join(bin, "tmp"),
          CI_JOB_NAME: JOB,
          PI_OFFLINE: "0",
          MODEL_API_KEY: "model-key-fixture",
          DOCSFAB_CONFIG_ROOT: join(bin, "config"),
          DOCSFAB_CANARY_GITLAB_TOKEN: "gitlab-token-fixture",
          CI_JOB_TOKEN: "job-token-fixture",
        },
      });
      if (result.status !== 0)
        throw new Error(result.stderr || `runtime-run.sh exited ${result.status}`);
      return result.stdout;
    };
    const matrix = childEnv([
      "node",
      "/checkout/benchmarks/local-workflows/canary.mjs",
      "run",
      "/tmp/out",
    ]);
    expect(matrix).toMatch(/^DOCSFAB_CONFIG_ROOT=/mu);
    expect(matrix).toMatch(/^PI_OFFLINE=0$/mu);
    expect(matrix).not.toMatch(/^MODEL_API_KEY=/mu);
    expect(matrix).not.toMatch(/gitlab-token-fixture|job-token-fixture/u);
    const prepare = childEnv([
      "node",
      "--import",
      "tsx",
      "scripts/prepare-live-model-ci-config.ts",
    ]);
    expect(prepare).toMatch(/^MODEL_API_KEY=model-key-fixture$/mu);
    expect(prepare).not.toMatch(/gitlab-token-fixture|job-token-fixture/u);
  });

  it("reads the tarball arguments of every npm install form and tells a bare spec from a file path", () => {
    const tarballs = (line: string) => npmInstallTarballs([line]);
    const bareSpecs = [
      "workflow-canary-candidate/docsfab.tgz",
      "docsfab.tgz",
      "a/b.tar.gz",
      "a/b.tar",
    ];
    const fileSpecs = ["./a/b.tgz", "/opt/b.tgz", "$ROOT/a/b.tgz"];
    for (const form of ["install", "i", "add"]) {
      for (const bare of bareSpecs) {
        const line = `bash run.sh npm ${form} --global --prefix "$ROOT/x" ${bare}`;
        expect(tarballs(line), line).toEqual([bare]);
        expect(bare, line).not.toMatch(FILE_SPEC);
      }
      for (const path of fileSpecs) {
        for (const written of [path, `"${path}"`, `'${path}'`]) {
          const line = `npm ${form} ${written}`;
          expect(tarballs(line), line).toEqual([path]);
          expect(path, line).toMatch(FILE_SPEC);
        }
      }
    }
    // Not a tarball, or not an install: nothing to check.
    expect(tarballs("npm install --global fern-api@5.106.0")).toEqual([]);
    expect(tarballs("npm ci && npm pack a/b.tgz && npx a/b.tgz")).toEqual([]);
    // Each install ends with its own command: `&&`, `;`, a pipe, a line break, or a continued line.
    expect(tarballs("npm i ./a.tgz && npm add b/c.tgz; npm install d/e.tgz | cat")).toEqual([
      "./a.tgz",
      "b/c.tgz",
      "d/e.tgz",
    ]);
    expect(
      npmInstallTarballs(["npm install --global \\", "  --prefix /x \\", "  y/z.tgz", "npm ci"]),
    ).toEqual(["y/z.tgz"]);
  });

  it("names the tarball it installs by a file path, which npm never reads as a GitHub shorthand", async () => {
    const commands = jobCommands(resolveJob(await readPipeline(), JOB));
    const specs = npmInstallTarballs(commands);
    // Positive control: the candidate install is found, so a missed match cannot pass below.
    expect(
      specs.map((spec) => spec.replace(/^.*\//u, "")),
      "the job must npm install the packed candidate, docsfab.tgz",
    ).toEqual(["docsfab.tgz"]);
    for (const spec of specs) {
      expect(
        spec,
        `npm reads "${spec}" as a GitHub owner/repo shorthand; start the spec with ./, /, or $`,
      ).toMatch(FILE_SPEC);
    }
    // It is the candidate the previous step prepared, named from the directory both steps run in.
    const leaf = preparedLeaf(commands);
    expect(leaf, "the job must prepare the candidate with prepare-packed-cli.mjs").toBeDefined();
    const candidate = `./${leaf}/docsfab.tgz`;
    expect(
      specs,
      `the install must name ${candidate}, the candidate the prepare step writes`,
    ).toEqual([candidate]);
  });

  it("runs the install in packages/runtime, where prepare-packed-cli.mjs writes the candidate the ./ path names", async () => {
    const job = resolveJob(await readPipeline(), JOB);
    const step = job.script?.find((line) => /\bnpm install\b/u.test(line));
    expect(step, "the job has no npm install step").toBeDefined();
    const leaf = preparedLeaf(jobCommands(job));
    expect(leaf, "the job must prepare the candidate with prepare-packed-cli.mjs").toBeDefined();
    const bin = await mkdtemp(join(tmpdir(), "docsfab-canary-install-bin-"));
    roots.push(bin);
    await writeFile(join(bin, "runuser"), '#!/usr/bin/env bash\nshift\nshift\nshift\nexec "$@"\n');
    // Stands in for npm: prints the directory the wrapper started it in, then its arguments.
    await writeFile(join(bin, "npm"), '#!/usr/bin/env bash\npwd -P\nprintf "%s\\n" "$@"\n');
    await chmod(join(bin, "runuser"), 0o755);
    await chmod(join(bin, "npm"), 0o755);
    // The job script starts at the checkout root; the wrapper moves the child.
    const result = spawnSync("bash", ["-c", step!], {
      encoding: "utf8",
      cwd: repositoryRoot,
      env: {
        PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        CI_PROJECT_DIR: repositoryRoot,
        HOME: join(bin, "home"),
        DOCSFAB_TEST_TRUSTED_ROOT: join(bin, "tmp"),
      },
    });
    expect(result.status, result.stderr).toBe(0);
    const [directory, ...args] = result.stdout.split("\n").slice(0, -1);
    expect(directory, "runtime-run.sh must start its child in packages/runtime").toBe(
      await realpath(join(repositoryRoot, "packages", "runtime")),
    );
    // prepare-packed-cli.mjs resolves --output-dir against packages/runtime and keeps docsfab.tgz there.
    const tarball = args.find((arg) => arg.endsWith(".tgz"));
    expect(tarball, "the install step must pass npm a tarball").toBeDefined();
    expect(
      resolve(directory!, tarball!),
      "the tarball path must resolve to the candidate the prepare step writes",
    ).toBe(join(directory!, leaf!, "docsfab.tgz"));
  });
});

async function readAllCiFiles(): Promise<Record<string, GitlabJob>> {
  const files = [
    join(repositoryRoot, ".gitlab-ci.yml"),
    ...(await readdir(join(repositoryRoot, ".gitlab/ci")))
      .filter((name) => name.endsWith(".yml"))
      .map((name) => join(repositoryRoot, ".gitlab/ci", name)),
  ];
  const jobs: Record<string, GitlabJob> = {};
  for (const file of files) {
    const document = parse(await readFile(file, "utf8")) as Record<string, unknown>;
    for (const [name, value] of Object.entries(document ?? {})) {
      if (value && typeof value === "object" && !Array.isArray(value))
        jobs[name] = value as GitlabJob;
    }
  }
  return jobs;
}

function environmentName(job: GitlabJob): string | undefined {
  return typeof job.environment === "string" ? job.environment : job.environment?.name;
}

describe.skipIf(gitlabCi.skip)(gitlabCi.title("workflow canary trend job"), () => {
  it("exists in exactly the pipelines that create the matrix job, and runs after it whatever its result", async () => {
    const pipeline = await readPipeline();
    const matrix = resolveJob(pipeline, JOB);
    const trend = resolveJob(pipeline, TREND_JOB);
    const variations: CiVariables[] = [
      OPT_IN,
      {},
      { DOCSFAB_WORKFLOW_CANARY: "0" },
      { ...OPT_IN, CI_PIPELINE_SOURCE: "push" },
      { ...OPT_IN, CI_PIPELINE_SOURCE: "web" },
      { ...OPT_IN, CI_PROJECT_ID: "1" },
      { ...OPT_IN, CI_COMMIT_REF_PROTECTED: "false" },
      { ...OPT_IN, CI_COMMIT_BRANCH: "feature" },
      { ...OPT_IN, CI_DEBUG_TRACE: "true" },
      { ...OPT_IN, CI_DEBUG_SERVICES: "1" },
    ];
    for (const overrides of variations) {
      expect(created(trend, PROTECTED_MAIN_SCHEDULE, overrides), JSON.stringify(overrides)).toBe(
        created(matrix, PROTECTED_MAIN_SCHEDULE, overrides),
      );
    }
    expect(created(trend, PROTECTED_MAIN_SCHEDULE, OPT_IN)).toBe(true);
    const allow = trend.rules?.find((rule) => rule.when !== "never");
    expect(allow?.when).toBe("always");
    // A Vault override removes the matrix job before secret resolution; the
    // trend job still runs and fails on the missing summary, so the canary
    // cannot go quiet. Its need is optional so the pipeline is still created.
    const redirected = { ...OPT_IN, VAULT_SERVER_URL: "https://vault.example.test" };
    expect(created(matrix, PROTECTED_MAIN_SCHEDULE, redirected)).toBe(false);
    expect(created(trend, PROTECTED_MAIN_SCHEDULE, redirected)).toBe(true);
    expect(pipeline[TREND_JOB]!.needs).toEqual([{ job: JOB, artifacts: true, optional: true }]);
  });

  it("holds no model credential and runs no unprivileged step or package setup", async () => {
    const pipeline = await readPipeline();
    const raw = pipeline[TREND_JOB]!;
    expect(asList(raw.extends)).toEqual([
      ".rules:workflow-canary-trend",
      ".ci_live_model_platform_bounds",
    ]);
    const trend = resolveJob(pipeline, TREND_JOB);
    expect(trend.secrets).toBeUndefined();
    expect(trend.id_tokens).toBeUndefined();
    // Explicitly empty, so no default or template can add setup.
    expect(raw.before_script).toEqual([]);
    expect(raw.after_script).toEqual([]);
    expect(raw.cache).toEqual([]);
    const commands = [
      ...(trend.before_script ?? []),
      ...(trend.script ?? []),
      ...(trend.after_script ?? []),
    ].join("\n");
    expect(commands).not.toMatch(/runtime-run\.sh|runuser|npm |npx /u);
    // Neither the unprivileged user runtime-run.sh switches to, nor any of the
    // unprivileged template's variables, appears in the trend job.
    const unprivilegedUser = /runuser -u (\S+)/u.exec(await readFile(runtimeRun, "utf8"))?.[1];
    expect(unprivilegedUser).toBeTruthy();
    expect(commands).not.toContain(unprivilegedUser!);
    for (const name of Object.keys(pipeline[".runtime_unprivileged"]!.variables ?? {})) {
      expect(commands).not.toContain(name);
      expect(Object.keys(trend.variables ?? {})).not.toContain(name);
    }
    expect(asList(trend.extends)).not.toContain(".runtime_unprivileged");
    expect(commands).toContain("node benchmarks/local-workflows/canary-trend.mjs");
    expect(commands).toContain(
      "--summary packages/runtime/ci-results/workflow-canary/summary.json",
    );
    // A new output directory, not the extracted matrix artifact directory.
    expect(commands).toContain("--out packages/runtime/ci-results/workflow-canary-trend");
    expect(commands).toContain("--previous-from-gitlab --post-alert");
    expect(raw.interruptible).toBe(false);
    // Only a posted regression (exit 2) is a warning; a dead canary fails the
    // scheduled pipeline so the schedule owner is notified.
    expect(raw.allow_failure).toEqual({ exit_codes: [2] });
    // The token-holding job runs on the same trusted runner class as the matrix job.
    expect(raw.tags).toEqual(pipeline[JOB]!.tags);
    expect(raw.tags).toContain("bwrap-userns");
    expect(raw.resource_group).toBe("workflow-canary-trend");
    expect(raw.timeout).toBeUndefined();
    expect(raw.artifacts).toEqual({
      when: "always",
      paths: ["packages/runtime/ci-results/workflow-canary-trend/"],
    });
  });

  it("is the only job that declares the environment the GitLab token is scoped to", async () => {
    const jobs = await readAllCiFiles();
    const declaring = Object.entries(jobs)
      .filter(([, job]) => environmentName(job) === "workflow-canary")
      .map(([name]) => name);
    expect(declaring).toEqual([TREND_JOB]);
    expect(jobs[TREND_JOB]!.environment).toEqual({ name: "workflow-canary", action: "access" });
    // The token is operator-scoped, never defined in CI YAML.
    for (const [name, job] of Object.entries(jobs)) {
      expect(Object.keys(job.variables ?? {}), name).not.toContain("DOCSFAB_CANARY_GITLAB_TOKEN");
    }
  });
});

const EXPECTED_GIT_ARGS =
  "status --porcelain --untracked-files=all -- benchmarks packages/runtime/src/config";

// Names node may receive: the allowlist in the trend script, plus what bash sets itself.
const TREND_ENV_ALLOWLIST = new Set([
  "PATH",
  "HOME",
  "LANG",
  "TZ",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "CI_API_V4_URL",
  "CI_SERVER_URL",
  "CI_PROJECT_ID",
  "CI_PROJECT_URL",
  "CI_COMMIT_BRANCH",
  "CI_COMMIT_SHA",
  "CI_JOB_NAME",
  "CI_JOB_ID",
  "CI_PIPELINE_ID",
  "DOCSFAB_CANARY_GITLAB_TOKEN",
  "DOCSFAB_CANARY_ALERT_ISSUE_IID",
]);
const BASH_SET = new Set(["PWD", "SHLVL", "_", "OLDPWD"]);

describe.skipIf(gitlabCi.skip)(gitlabCi.title("workflow canary trend job script"), () => {
  async function trendScript(): Promise<string> {
    const job = (await readPipeline())[TREND_JOB]!;
    expect(job.script).toHaveLength(1);
    return job.script![0]!;
  }

  async function runScript(gitStatus: string, extra: Record<string, string> = {}) {
    const bin = await mkdtemp(join(tmpdir(), "docsfab-canary-trend-bin-"));
    roots.push(bin);
    // A fake node that reports its argv and environment.
    await writeFile(join(bin, "node"), '#!/bin/sh\nprintf "ARGV %s\\n" "$*"\n/usr/bin/env\n');
    await chmod(join(bin, "node"), 0o755);
    // A fake git that accepts only the exact checkout check.
    await writeFile(
      join(bin, "git"),
      `#!/usr/bin/env bash\nif [ "$*" != "${EXPECTED_GIT_ARGS}" ]; then echo "unexpected git $*" >&2; exit 97; fi\nprintf '%s' '${gitStatus}'\n`,
    );
    await chmod(join(bin, "git"), 0o755);
    return spawnSync("bash", ["-c", await trendScript()], {
      encoding: "utf8",
      cwd: repositoryRoot,
      env: {
        PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        HOME: bin,
        DOCSFAB_CANARY_GITLAB_TOKEN: "canary-token-fixture",
        DOCSFAB_CANARY_ALERT_ISSUE_IID: "1183",
        CI_PIPELINE_ID: "900",
        CI_COMMIT_SHA: "a".repeat(40),
        MODEL_API_KEY: "leak-model-key",
        DOCSFAB_NVIDIA_API_KEY: "leak-nvidia-key",
        CI_JOB_TOKEN: "leak-job-token",
        CI_REGISTRY_PASSWORD: "leak-registry-password",
        DOCKER_AUTH_CONFIG: "leak-docker-auth",
        CI_JOB_JWT_V2: "leak-job-jwt",
        VAULT_ID_JWT: "leak-vault-jwt",
        GH_PAT: "leak-gh-pat",
        NPM_AUTH: "leak-npm-auth",
        DB_PASSWD: "leak-db-passwd",
        SERVICE_CREDS: "leak-service-creds",
        Api_Key: "leak-api-key",
        ...extra,
      },
    });
  }

  it("hands node only the allowlisted environment and the trend arguments", async () => {
    const result = await runScript("");
    expect(result.status, result.stderr).toBe(0);
    const names = result.stdout
      .split("\n")
      .filter((line) => /^[A-Za-z_][A-Za-z0-9_]*=/u.test(line))
      .map((line) => line.slice(0, line.indexOf("=")));
    expect(names.filter((name) => !TREND_ENV_ALLOWLIST.has(name) && !BASH_SET.has(name))).toEqual(
      [],
    );
    expect(result.stdout).toMatch(/^DOCSFAB_CANARY_GITLAB_TOKEN=canary-token-fixture$/mu);
    expect(result.stdout).toMatch(/^DOCSFAB_CANARY_ALERT_ISSUE_IID=1183$/mu);
    expect(result.stdout).toMatch(/^CI_PIPELINE_ID=900$/mu);
    expect(result.stdout).not.toMatch(/leak-/u);
    expect(result.stdout).toMatch(
      /^ARGV benchmarks\/local-workflows\/canary-trend\.mjs --summary packages\/runtime\/ci-results\/workflow-canary\/summary\.json --out packages\/runtime\/ci-results\/workflow-canary-trend --previous-from-gitlab --post-alert$/mu,
    );
    // The inner shell reads no startup file, so nothing from a runner's rc files is added.
    expect(await trendScript()).toContain("env -i /bin/bash --norc --noprofile -c");
    const allowed = await runScript("", { DOCSFAB_CANARY_ALLOW_NEW_BASELINE: "1" });
    expect(allowed.stdout).toMatch(/--post-alert --allow-new-baseline$/mu);
    expect(allowed.stdout).not.toMatch(/^DOCSFAB_CANARY_ALLOW_NEW_BASELINE=/mu);
  });

  it("refuses to run node when the extracted artifacts changed the code it loads", async () => {
    const result = await runScript("?? benchmarks/local-workflows/lib/canary-rates.mjs");
    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain("canary-token-fixture");
    expect(result.stderr).toMatch(/refusing to run/u);
  });
});
