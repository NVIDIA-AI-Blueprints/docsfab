// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Both Docker images pack the runtime in a `build` stage that runs
 * `npm pack`, whose `prepack` build regenerates derived products and copies
 * the repository license files into the package. No CI job builds the images
 * and the shared host has no daemon, so these tests reproduce the stage from
 * the bounded Git staging candidates its `.dockerignore` admits and its COPY
 * lines stage. A separate sentinel check covers ignored on-disk state against
 * each shipped ignore file before the stage's own `npm pack` runs.
 */
import { type ExecFileException, execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ENSURE_DERIVED_INPUTS, ENSURE_DERIVED_MODULES } from "../scripts/ensure-derived.mjs";
import { DERIVED_PRODUCT_BY_ID } from "../scripts/derived-products.mjs";
import { PACKAGE_LICENSE_FILES } from "../scripts/lib/package-license.mjs";
import { DEPLOY_ROOT_CONFIG_PATH } from "../scripts/limits-deploy-root.mjs";
import {
  contextCandidates,
  type DockerignoreRule,
  filesBelow,
  isAdmitted,
  materializeBuildStage,
  parseDockerignore,
  planBuildStage,
  readBuildStage,
  STAGE_PACK_RUN,
  stageWorkdir,
} from "./helpers/docker-context.js";
import { internalOnly } from "./helpers/internal-path.js";
import { temporaryRoots } from "./helpers/temp.js";
import { nestedDeadlineMs, testTimeoutMs } from "./helpers/test-timeouts.js";

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(runtimeRoot, "../..");
const roots = temporaryRoots();

// Local per-case budget for a reproduced stage: about 3,200 file copies, the
// derived-generation hook, tsc, npm pack, and removing the stage again. On a
// developer laptop whose endpoint scanner inspects every write, the copies and
// the removal each took over a minute, so the budget covers that host, not an
// idle one. testTimeoutMs keeps CI at or above its shared default.
const STAGE_TEST_MS = 300_000;
// The pack child gets most of what the copies leave, so it fails with its own output first.
const STAGE_CHILD_MS = 150_000;
// Execution plumbing: room for tsc and npm diagnostics, not a bound under test.
const CHILD_OUTPUT_BYTES = 16 * 1024 * 1024;

interface Image {
  readonly dockerfile: string;
  readonly ignore: string;
  /**
   * The image whose ignore file this one extends. Lines only this one has may
   * exclude more runtime-local state; they may not admit anything.
   */
  readonly extends?: Image;
}

const DOGFOOD_IMAGE: Image = {
  dockerfile: "packages/runtime/ci/Dockerfile",
  ignore: "packages/runtime/ci/Dockerfile.dockerignore",
};
const COMPOSE_IMAGE: Image = {
  dockerfile: "deploy/compose/Dockerfile",
  ignore: "deploy/compose/Dockerfile.dockerignore",
  extends: DOGFOOD_IMAGE,
};
const composeImage = internalOnly(
  [COMPOSE_IMAGE.dockerfile, COMPOSE_IMAGE.ignore],
  "the public export has no deploy tree",
);

/**
 * What the package stage needs from the repository, written out here rather
 * than read from the ignore files: the runtime package and the knowledge
 * provider it bundles, the canonical inputs its build regenerates derived
 * products from, and the license files it ships.
 */
const EXPECTED_CONTEXT_ROOTS = [
  "LICENSE",
  "LICENSE-CC-BY-4.0",
  "NOTICE",
  "config/env-admission.yaml",
  "config/limits.yaml",
  "config/limits",
  "config/limits-allowlist.json",
  // The limits outputs, so a current context checks without writing.
  "config/limits.catalog.json",
  "config/limits.json",
  "config/model-output",
  "config/model-output-allowlist.json",
  "docs/reference/status-and-configuration/operational-limits-tables",
  "packages/knowledge/skills",
  "packages/knowledge/src",
  "packages/quality/checks",
  "packages/quality/formats",
  "packages/quality/profiles",
  "packages/quality/rubrics",
  "packages/quality/runtime-policy",
  "packages/quality/schemas",
  "packages/runtime",
  "packages/skills",
];

/** Of the limits-allowlist shards, the context takes the runtime's, as the public export does. */
const RUNTIME_ALLOWLIST_SHARD = /^config\/limits-allowlist\/runtime\.[^/]+$/u;

/**
 * Deploy-only limits inputs, left out as the public export leaves them out:
 * they would point the limits step at deploy and host trees the context lacks.
 */
function isDeployOnlyConfig(path: string): boolean {
  return (
    path === DEPLOY_ROOT_CONFIG_PATH ||
    (path.startsWith("config/limits-allowlist/") && !RUNTIME_ALLOWLIST_SHARD.test(path))
  );
}

/** Prose about the config files; the package build never reads it. */
const CONFIG_DOCUMENTATION = ["config/README.md", "config/limits-reference.md"];

const LOCAL_STATE_NAMES = [".git", "node_modules", "dist", "coverage", ".cache", ".npmrc"];
const RUNTIME_LOCAL_STATE = [".docsfab", "ci-results", "package-artifacts", "package-candidate"];

function isLocalState(path: string): boolean {
  const segments = path.split("/");
  if (segments.some((segment) => LOCAL_STATE_NAMES.includes(segment))) return true;
  if (segments.some((segment) => segment.startsWith(".env"))) return true;
  return RUNTIME_LOCAL_STATE.some((directory) => path.startsWith(`packages/runtime/${directory}/`));
}

async function ignoreRules(image: Image): Promise<DockerignoreRule[]> {
  return parseDockerignore(await readFile(join(repositoryRoot, image.ignore), "utf8"));
}

/** The lines `image` adds to the ignore file it extends, refused unless they exclude runtime-local state. */
async function addedExclusions(image: Image): Promise<DockerignoreRule[]> {
  if (image.extends === undefined) return [];
  const inherited = new Set((await ignoreRules(image.extends)).map((rule) => rule.line));
  const added = (await ignoreRules(image)).filter((rule) => !inherited.has(rule.line));
  expect(
    added.filter((rule) => rule.negated || !rule.line.startsWith("packages/runtime/")),
    image.ignore,
  ).toEqual([]);
  return added;
}

function underRoot(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

let candidates: Promise<string[]> | undefined;
function repositoryCandidates(): Promise<string[]> {
  candidates ??= contextCandidates(repositoryRoot);
  return candidates;
}

async function admittedContext(image: Image): Promise<string[]> {
  const rules = await ignoreRules(image);
  return (await repositoryCandidates()).filter((path) => isAdmitted(rules, path));
}

async function expectedContext(image: Image): Promise<string[]> {
  const added = await addedExclusions(image);
  return (await repositoryCandidates()).filter(
    (path) =>
      (EXPECTED_CONTEXT_ROOTS.some((root) => underRoot(path, root)) ||
        RUNTIME_ALLOWLIST_SHARD.test(path)) &&
      !isLocalState(path) &&
      isAdmitted(added, path),
  );
}

/** A declared input path or `<directory>/**\/*` glob as a predicate. */
function inputMatcher(pattern: string): (path: string) => boolean {
  if (!pattern.endsWith("/**/*")) return (path) => path === pattern;
  const directory = pattern.slice(0, -"/**/*".length);
  return (path) => path.startsWith(`${directory}/`);
}

function requiredCanonicalInputs(
  candidates: readonly string[],
  admitted: readonly string[],
  matchers: readonly ((path: string) => boolean)[],
): string[] {
  const admittedSet = new Set(admitted);
  const optionalOwners = new Set(DERIVED_PRODUCT_BY_ID.limits.optionalOwnerInputs ?? []);
  return candidates.filter(
    (path) =>
      matchers.some((matches) => matches(path)) &&
      !isDeployOnlyConfig(path) &&
      (!optionalOwners.has(path) || admittedSet.has(path)),
  );
}

function missingStagedInputs(required: readonly string[], staged: ReadonlySet<string>): string[] {
  return required.filter((path) => !staged.has(path));
}

function missingCanonicalStageInputs(
  candidates: readonly string[],
  admitted: readonly string[],
  matchers: readonly ((path: string) => boolean)[],
  staged: ReadonlySet<string>,
): string[] {
  return missingStagedInputs(requiredCanonicalInputs(candidates, admitted, matchers), staged);
}

function assertCanonicalStageIncludesInputs(
  candidates: readonly string[],
  admitted: readonly string[],
  matchers: readonly ((path: string) => boolean)[],
  staged: ReadonlySet<string>,
  label: string,
): void {
  expect(missingCanonicalStageInputs(candidates, admitted, matchers, staged), label).toEqual([]);
}

async function stagePlan(image: Image) {
  const stage = readBuildStage(await readFile(join(repositoryRoot, image.dockerfile), "utf8"));
  return { stage, plan: planBuildStage(stage, await admittedContext(image)) };
}

interface Completed {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function run(
  command: string,
  args: readonly string[],
  cwd: string,
  extraEnvironment: NodeJS.ProcessEnv = {},
): Promise<Completed> {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    PI_OFFLINE: "1",
    ...extraEnvironment,
  };
  // A nested build must not inherit this worker's pool identity.
  for (const key of Object.keys(environment)) {
    if (key.startsWith("VITEST")) delete environment[key];
  }
  return new Promise((resolveRun) => {
    execFile(
      command,
      args,
      {
        cwd,
        env: environment,
        timeout: nestedDeadlineMs(STAGE_CHILD_MS, STAGE_TEST_MS),
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

interface ReproducedStage {
  /** The directory standing in for the container's `/`. */
  readonly root: string;
  /** The stage's working directory under `root`. */
  readonly workdir: string;
  readonly pack: Completed;
  /** The packed file list, when the pack succeeded. */
  readonly files: readonly string[];
}

/**
 * Stage the image's context under a fresh directory outside any git work
 * tree (the stage has no git), let `prepare` change it the way a broken
 * context would, and run the stage's `npm pack` line.
 */
async function reproduceStage(
  image: Image,
  root: string,
  prepare: (root: string) => Promise<void> = async () => {},
): Promise<ReproducedStage> {
  const { stage, plan } = await stagePlan(image);
  expect(stage.at(-1)).toEqual({ keyword: "RUN", args: STAGE_PACK_RUN });
  await materializeBuildStage(root, stage, plan, repositoryRoot, join(runtimeRoot, "node_modules"));
  await prepare(root);
  const destination = join(root, "tmp", "package");
  await mkdir(destination, { recursive: true });
  const workdir = join(root, stageWorkdir(stage));
  const pack = await run("npm", ["pack", "--json", "--pack-destination", destination], workdir, {
    npm_config_cache: join(root, "npm-cache"),
  });
  if (pack.code !== 0) return { root, workdir, pack, files: [] };
  // The stage's `mv /tmp/package/*.tgz` needs exactly one tarball.
  expect((await readdir(destination)).filter((name) => name.endsWith(".tgz"))).toHaveLength(1);
  const [manifest] = JSON.parse(pack.stdout) as Array<{
    files: Array<{ path: string }>;
  }>;
  return {
    root,
    workdir,
    pack,
    files: manifest!.files.map((file) => file.path),
  };
}

/**
 * Run `check` on a reproduced stage, then remove it inside the case budget:
 * a few thousand staged files can outlast the shared after-each hook budget.
 * Only this case's stage is removed, so a case that outlives its timeout
 * cannot delete the stage a later case is building.
 */
async function inReproducedStage(
  image: Image,
  prepare: ((root: string) => Promise<void>) | undefined,
  check: (stage: ReproducedStage) => Promise<void> | void,
): Promise<void> {
  const root = await roots.create("docsfab-docker-stage-", { realpath: true });
  try {
    await check(await reproduceStage(image, root, prepare));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const PACKED_PATHS = [
  "LICENSE",
  "LICENSE-CC-BY-4.0",
  "NOTICE",
  "dist/launcher.js",
  "skill-crate/lock.json",
  "quality/lock.json",
  "quality-pack/manifest.json",
];

const GENERATED_TREES = ["skill-crate", "quality", "quality-pack"];

describe("the .dockerignore model", () => {
  it("refuses every line form it does not implement", () => {
    for (const line of [
      "*.md",
      "packages/*/src",
      "docs/**/limits.md",
      "file?.txt",
      "[ab]",
      "/LICENSE",
      "packages/../config",
      "./config",
      "**/a*b",
      "\\!literal",
      "packages//runtime",
    ]) {
      expect(() => parseDockerignore(line), line).toThrow(
        `The .dockerignore model does not support the line ${JSON.stringify(line)}`,
      );
    }
  });

  it("applies the last rule that matches the path or one of its ancestors", () => {
    const rules = parseDockerignore(
      ["# comment", "**", "!a/", "a/b/secret", "!keep/**", "**/.env*", "!x/", "x/deploy.*"].join(
        "\n",
      ),
    );
    const table: Array<[string, boolean]> = [
      ["root.txt", false],
      // `**` matches first; the later `!a/` decides through the ancestor `a`.
      ["a/b/c", true],
      ["a/b/secret", false],
      ["a/b/secret/inner", false],
      ["a/b/secrets", true],
      ["keep/file", true],
      ["keep", false],
      ["keep/.env", false],
      ["keep/.envrc/file", false],
      ["x/deploy.json", false],
      ["x/deploy.d/file", false],
      ["x/deployment", true],
    ];
    expect(table.map(([path]) => [path, isAdmitted(rules, path)])).toEqual(table);
  });
});

describe("the context candidates", () => {
  it("drops a tracked file deleted from the working tree and refuses any other unreadable path", async () => {
    const root = await roots.create("docsfab-docker-candidates-", {
      realpath: true,
    });
    const git = (args: readonly string[]) => run("git", args, root);
    await mkdir(join(root, "kept"));
    await mkdir(join(root, "moved"));
    for (const path of ["kept/file", "deleted", "moved/file"]) {
      await writeFile(join(root, path), `${path}\n`);
    }
    expect((await git(["init", "-q"])).code).toBe(0);
    expect((await git(["add", "-A"])).code).toBe(0);
    await rm(join(root, "deleted"));
    expect(await contextCandidates(root)).toEqual(["kept/file", "moved/file"]);

    // A file where a tracked directory was is ENOTDIR, not a deleted file.
    await rm(join(root, "moved"), { recursive: true });
    await writeFile(join(root, "moved"), "now a file\n");
    await expect(contextCandidates(root)).rejects.toMatchObject({
      code: "ENOTDIR",
    });
  });
});

describe("the package-stage build context", () => {
  it("admits exactly the package build's inputs from the bounded Git staging set", async () => {
    expect(await admittedContext(DOGFOOD_IMAGE)).toEqual(await expectedContext(DOGFOOD_IMAGE));
  });

  it.skipIf(composeImage.skip)(
    composeImage.title(
      "admits exactly the package build's inputs from the bounded Git staging set",
    ),
    async () => {
      expect(await admittedContext(COMPOSE_IMAGE)).toEqual(await expectedContext(COMPOSE_IMAGE));
    },
  );

  it("excludes ignored local-state sentinels from both shipped Docker contexts", async () => {
    const root = await roots.create("docsfab-docker-ignored-canaries-", { realpath: true });
    const fixtureFiles = [
      "packages/runtime/.cache/ensure-derived.lock",
      "packages/runtime/.cache/nested/derived.json",
      "packages/runtime/.env",
      "packages/runtime/.env.local",
      "packages/runtime/.npmrc",
    ];
    await writeFile(
      join(root, ".gitignore"),
      [
        "packages/runtime/.cache/",
        "packages/runtime/.env",
        "packages/runtime/.env.*",
        "packages/runtime/.npmrc",
      ].join("\n") + "\n",
    );
    for (const path of fixtureFiles) {
      const file = join(root, path);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, "synthetic local-state canary\n");
    }
    expect((await run("git", ["init", "-q"], root)).code).toBe(0);

    // These fixtures are intentionally absent from contextCandidates. That list
    // is the bounded staging set; direct path assertions cover Docker's broader
    // on-disk context, including ignored local state.
    const gitIgnored = await Promise.all(
      fixtureFiles.map(
        async (path) => [path, await run("git", ["check-ignore", "--", path], root)] as const,
      ),
    );
    expect(gitIgnored.filter(([, result]) => result.code !== 0).map(([path]) => path)).toEqual([]);
    const candidates = await contextCandidates(root);
    expect(fixtureFiles.filter((path) => candidates.includes(path))).toEqual([]);

    const images = composeImage.skip ? [DOGFOOD_IMAGE] : [DOGFOOD_IMAGE, COMPOSE_IMAGE];
    const protectedPaths = [
      ...fixtureFiles,
      "packages/runtime/.cache/ensure-derived.lock/descendant.json",
    ];
    for (const image of images) {
      const rules = await ignoreRules(image);
      expect(
        protectedPaths.filter((path) => isAdmitted(rules, path)),
        image.ignore,
      ).toEqual([]);
    }
  });

  it("stages the bounded Git candidates that the COPY lines select, less local state and deploy-only config", async () => {
    const images = composeImage.skip ? [DOGFOOD_IMAGE] : [DOGFOOD_IMAGE, COMPOSE_IMAGE];
    for (const image of images) {
      const { stage, plan } = await stagePlan(image);
      const added = await addedExclusions(image);
      const wholeCheckout = (await repositoryCandidates()).filter(
        (path) =>
          !isLocalState(path) &&
          !isDeployOnlyConfig(path) &&
          !CONFIG_DOCUMENTATION.includes(path) &&
          isAdmitted(added, path),
      );
      expect([...plan].sort(), image.dockerfile).toEqual(
        [...planBuildStage(stage, wholeCheckout)].sort(),
      );
    }
  });

  it("stages every canonical input the derived-generation hook reads and every file the build ships", async () => {
    const images = composeImage.skip ? [DOGFOOD_IMAGE] : [DOGFOOD_IMAGE, COMPOSE_IMAGE];
    const matchers = [...ENSURE_DERIVED_INPUTS, ...ENSURE_DERIVED_MODULES].map(inputMatcher);
    const candidates = await repositoryCandidates();
    for (const image of images) {
      const admitted = await admittedContext(image);
      const required = requiredCanonicalInputs(candidates, admitted, matchers);
      expect(required.some((path) => path.startsWith("packages/quality/"))).toBe(true);
      expect(required.some((path) => path.startsWith("config/"))).toBe(true);
      const { plan } = await stagePlan(image);
      const staged = new Set(plan.values());
      assertCanonicalStageIncludesInputs(candidates, admitted, matchers, staged, image.dockerfile);
      expect(
        [...plan.values()].filter((path) => path.startsWith("config/") && isDeployOnlyConfig(path)),
        image.dockerfile,
      ).toEqual([]);
      for (const file of [...PACKAGE_LICENSE_FILES, "NOTICE"]) {
        // build-package.mjs reads them from the repository root, two levels above the package.
        expect(plan.get(`/opt/docsfab/${file}`), `${image.dockerfile} ${file}`).toBe(file);
      }
    }
  });

  it("requires an admitted optional owner in the actual COPY plan", async () => {
    const owner = DERIVED_PRODUCT_BY_ID.limits.optionalOwnerInputs?.[0];
    expect(owner).toBe(".gitlab/ci/train-reuse/metadata.mjs");
    const requiredInput = "config/limits.yaml";
    const candidates = [owner!, requiredInput];
    const matchers = [inputMatcher(owner!), inputMatcher(requiredInput)];

    expect(requiredCanonicalInputs(candidates, [requiredInput], matchers)).toEqual([requiredInput]);
    const admittedOwner = requiredCanonicalInputs(candidates, [owner!, requiredInput], matchers);
    expect(admittedOwner).toEqual([owner!, requiredInput]);
    expect(() =>
      assertCanonicalStageIncludesInputs(
        candidates,
        [owner!, requiredInput],
        matchers,
        new Set([requiredInput]),
        "synthetic image stage",
      ),
    ).toThrow();
    expect(() =>
      assertCanonicalStageIncludesInputs(
        candidates,
        [owner!, requiredInput],
        matchers,
        new Set(admittedOwner),
        "synthetic image stage",
      ),
    ).not.toThrow();
    expect(() =>
      assertCanonicalStageIncludesInputs(
        [requiredInput],
        [],
        matchers,
        new Set(),
        "synthetic image stage",
      ),
    ).toThrow();

    const baseRules = await ignoreRules(DOGFOOD_IMAGE);
    expect(isAdmitted(baseRules, owner!)).toBe(false);
    const syntheticRules = [...baseRules, ...parseDockerignore(`!${owner}`)];
    const contextCandidates = [...new Set([...(await repositoryCandidates()), owner!])];
    const admitted = contextCandidates.filter((path) => isAdmitted(syntheticRules, path));
    expect(admitted).toContain(owner);

    const stage = readBuildStage(
      await readFile(join(repositoryRoot, DOGFOOD_IMAGE.dockerfile), "utf8"),
    );
    const staged = new Set(planBuildStage(stage, admitted).values());
    expect(staged.has(owner!)).toBe(false);
    expect(missingCanonicalStageInputs(contextCandidates, admitted, matchers, staged)).toEqual([
      owner,
    ]);
    expect(() =>
      assertCanonicalStageIncludesInputs(contextCandidates, admitted, matchers, staged, "dogfood"),
    ).toThrow();

    const runIndex = stage.findIndex(({ keyword }) => keyword === "RUN");
    const ownerCopyStage = [
      ...stage.slice(0, runIndex),
      { keyword: "COPY" as const, args: `${owner} /opt/docsfab/${owner}` },
      ...stage.slice(runIndex),
    ];
    const ownerStaged = new Set(planBuildStage(ownerCopyStage, admitted).values());
    expect(ownerStaged.has(owner!)).toBe(true);
    expect(() =>
      assertCanonicalStageIncludesInputs(
        contextCandidates,
        admitted,
        matchers,
        ownerStaged,
        "synthetic admitted owner staged",
      ),
    ).not.toThrow();
  });

  it.skipIf(composeImage.skip)(
    composeImage.title("keeps both images' package stages and context admissions identical"),
    async () => {
      const [dogfood, compose] = await Promise.all(
        [DOGFOOD_IMAGE, COMPOSE_IMAGE].map(async (image) => {
          const dockerfile = await readFile(join(repositoryRoot, image.dockerfile), "utf8");
          return {
            from: dockerfile.match(/^FROM \S+ AS build$/imu)?.[0],
            stage: readBuildStage(dockerfile),
            rules: await ignoreRules(image),
          };
        }),
      );
      expect(dogfood!.from).toMatch(/^FROM node:\S+ AS build$/u);
      expect(compose!.from).toEqual(dogfood!.from);
      expect(compose!.stage).toEqual(dogfood!.stage);
      // The admissions must match line for line; local-state exclusions may differ.
      const admission = (rules: readonly DockerignoreRule[]) =>
        rules.filter((rule) => rule.negated || rule.line === "**").map((rule) => rule.line);
      expect(admission(compose!.rules)).toEqual(admission(dogfood!.rules));
    },
  );
});

describe("the reproduced package stage", () => {
  it(
    "builds dist/ and packs the license, notice, and generated trees in the dogfood image",
    () =>
      inReproducedStage(DOGFOOD_IMAGE, undefined, async (stage) => {
        expect({
          code: stage.pack.code,
          stderr: stage.pack.stderr,
        }).toMatchObject({ code: 0 });
        expect(PACKED_PATHS.filter((path) => !stage.files.includes(path))).toEqual([]);
        expect(existsSync(join(stage.workdir, "dist", "launcher.js"))).toBe(true);
      }),
    testTimeoutMs(STAGE_TEST_MS),
  );

  it.skipIf(composeImage.skip)(
    composeImage.title(
      "builds dist/ and packs the license, notice, and generated trees in the compose image",
    ),
    () =>
      inReproducedStage(COMPOSE_IMAGE, undefined, async (stage) => {
        expect({
          code: stage.pack.code,
          stderr: stage.pack.stderr,
        }).toMatchObject({ code: 0 });
        expect(PACKED_PATHS.filter((path) => !stage.files.includes(path))).toEqual([]);
        expect(existsSync(join(stage.workdir, "dist", "launcher.js"))).toBe(true);
      }),
    testTimeoutMs(STAGE_TEST_MS),
  );

  it(
    "regenerates the skill crate, quality staging, and quality pack when the context lacks them",
    () =>
      inReproducedStage(
        DOGFOOD_IMAGE,
        async (root) => {
          for (const tree of GENERATED_TREES) {
            await rm(join(root, "opt/docsfab/packages/runtime", tree), {
              recursive: true,
            });
          }
        },
        async (stage) => {
          expect({
            code: stage.pack.code,
            stderr: stage.pack.stderr,
          }).toMatchObject({ code: 0 });
          expect(stage.pack.stderr).toContain("ensure-derived: regenerated stale derived outputs");
          expect(PACKED_PATHS.filter((path) => !stage.files.includes(path))).toEqual([]);
          for (const tree of GENERATED_TREES) {
            const regenerated = join(stage.workdir, tree);
            const checkout = join(runtimeRoot, tree);
            const files = await filesBelow(regenerated);
            expect(files, tree).toEqual(await filesBelow(checkout));
            for (const file of files) {
              expect(await readFile(join(regenerated, file)), `${tree}/${file}`).toEqual(
                await readFile(join(checkout, file)),
              );
            }
          }
        },
      ),
    testTimeoutMs(STAGE_TEST_MS),
  );

  it(
    "refuses at the license read when the stage lacks the repository license files",
    () =>
      inReproducedStage(
        DOGFOOD_IMAGE,
        async (root) => {
          for (const file of [...PACKAGE_LICENSE_FILES, "NOTICE"]) {
            await rm(join(root, "opt/docsfab", file));
          }
        },
        (stage) => {
          expect(stage.pack.code).not.toBe(0);
          expect(stage.pack.stderr).toContain(
            `ENOENT: no such file or directory, open '${join(stage.root, "opt/docsfab/LICENSE")}'`,
          );
        },
      ),
    testTimeoutMs(STAGE_TEST_MS),
  );

  it(
    "refuses at the derived-generation hook when the stage lacks packages/quality",
    () =>
      inReproducedStage(
        DOGFOOD_IMAGE,
        async (root) => {
          await rm(join(root, "opt/docsfab/packages/quality"), {
            recursive: true,
          });
        },
        (stage) => {
          expect(stage.pack.code).not.toBe(0);
          expect(stage.pack.stderr).toContain("ensure-derived: DERIVED_OUTPUTS_UNLISTED");
          expect(stage.pack.stderr).toContain(
            "canonical member evaluation names no schema file packages/quality/schemas/documentation-quality-evaluation.schema.json",
          );
          expect(stage.pack.stderr).toContain("Build stopped; dist/ is unchanged.");
          expect(existsSync(join(stage.workdir, "dist"))).toBe(false);
        },
      ),
    testTimeoutMs(STAGE_TEST_MS),
  );
});
