// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * A daemon-free model of the Docker image builds' package stage: which files
 * in a bounded Git staging set a `Dockerfile.dockerignore` admits, and what
 * the `build` stage's COPY and RUN lines do with them. This is not a complete
 * model of the on-disk Docker context; ignored local state is checked by
 * explicit sentinels in the context tests.
 *
 * BuildKit is the real oracle and no CI job builds these images, so the model
 * accepts only the line forms the repository's files use and refuses any
 * other, rather than guess at a semantics it does not implement.
 */
import { execFile } from "node:child_process";
import { lstatSync } from "node:fs";
import { copyFile, mkdir, readdir, symlink } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** One `.dockerignore` line. A negated rule admits what it matches. */
export interface DockerignoreRule {
  readonly line: string;
  readonly negated: boolean;
  readonly pattern: RegExp;
}

const LITERAL_SEGMENT = /^[A-Za-z0-9._-]+$/u;
// Only a single trailing `*` in the last segment, as in `**/.env*` or `deploy.*`.
const PREFIX_SEGMENT = /^[A-Za-z0-9._-]+\*$/u;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * Parse `.dockerignore` text. Supported forms, each optionally negated with
 * `!`: `**`, a literal path with an optional trailing `/` or `/**`, and the same
 * behind a leading `**\/`; the last literal segment may end in one `*`.
 */
export function parseDockerignore(text: string): DockerignoreRule[] {
  const rules: DockerignoreRule[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const negated = line.startsWith("!");
    const body = negated ? line.slice(1) : line;
    rules.push({ line, negated, pattern: compileDockerignorePattern(body, line) });
  }
  return rules;
}

function compileDockerignorePattern(body: string, line: string): RegExp {
  if (body === "**") return /^.*$/u;
  let rest = body;
  let prefix = "";
  if (rest.startsWith("**/")) {
    prefix = "(?:.*/)?";
    rest = rest.slice("**/".length);
  }
  let suffix = "";
  if (rest.endsWith("/**")) {
    suffix = "/.*";
    rest = rest.slice(0, -"/**".length);
  } else if (rest.endsWith("/")) {
    // Docker cleans a trailing slash away; the ancestor rule covers the contents.
    rest = rest.slice(0, -1);
  }
  const segments = rest.split("/");
  const last = segments.length - 1;
  const valid = segments.every(
    (segment, index) =>
      segment !== "." &&
      segment !== ".." &&
      (LITERAL_SEGMENT.test(segment) || (index === last && PREFIX_SEGMENT.test(segment))),
  );
  if (!valid) {
    throw new Error(
      `The .dockerignore model does not support the line ${JSON.stringify(line)}; extend test/helpers/docker-context.ts with BuildKit's semantics for it before using it.`,
    );
  }
  const source = segments
    .map((segment) =>
      segment.endsWith("*") ? `${escapeRegExp(segment.slice(0, -1))}[^/]*` : escapeRegExp(segment),
    )
    .join("/");
  return new RegExp(`^${prefix}${source}${suffix}$`, "u");
}

/**
 * Whether the context keeps `path`. As in BuildKit, a rule applies when it
 * matches the path or any ancestor directory of it, and the last rule that
 * applies decides.
 */
export function isAdmitted(rules: readonly DockerignoreRule[], path: string): boolean {
  const segments = path.split("/");
  const candidates = segments.map((_, index) => segments.slice(0, index + 1).join("/"));
  let excluded = false;
  for (const rule of rules) {
    if (candidates.some((candidate) => rule.pattern.test(candidate))) excluded = !rule.negated;
  }
  return !excluded;
}

/**
 * Files in the bounded Git staging set: tracked and untracked, not
 * git-ignored, and present on disk. Docker can also see ignored files; this
 * listing intentionally does not enumerate them because the checkout can
 * contain large local trees. Tests check representative ignored local state
 * directly against each shipped `.dockerignore` file.
 */
export async function contextCandidates(repositoryRoot: string): Promise<string[]> {
  const { stdout } = await execFileAsync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: repositoryRoot, maxBuffer: GIT_LISTING_BYTES },
  );
  const paths = [...new Set(stdout.split("\0").filter((path) => path !== ""))];
  return paths.filter((path) => presentOnDisk(join(repositoryRoot, path))).sort();
}

// Execution plumbing: room for the repository's file listing, not a bound under test.
const GIT_LISTING_BYTES = 64 * 1024 * 1024;

function presentOnDisk(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    // Exactly a tracked file deleted in the working tree; Docker cannot see it either.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** One instruction of the Dockerfile's `build` stage. */
export interface StageInstruction {
  readonly keyword: "WORKDIR" | "COPY" | "RUN";
  readonly args: string;
}

/** The RUN lines the model knows how to execute, by their exact text. */
export const STAGE_INSTALL_RUN = "npm ci";
export const STAGE_PACK_RUN =
  "mkdir /tmp/package && npm pack --pack-destination /tmp/package && mv /tmp/package/*.tgz /tmp/docsfab.tgz";

/**
 * The `FROM … AS build` stage, up to the next `FROM`, with continuation lines
 * joined and comments dropped. Any instruction or RUN text the model cannot
 * execute is refused.
 */
export function readBuildStage(dockerfile: string): StageInstruction[] {
  const logical: string[] = [];
  let pending = "";
  for (const raw of dockerfile.split("\n")) {
    const line = raw.trim();
    if (pending === "" && (line === "" || line.startsWith("#"))) continue;
    if (line.endsWith("\\")) {
      pending += `${line.slice(0, -1).trim()} `;
      continue;
    }
    logical.push(`${pending}${line}`.replace(/\s+/gu, " ").trim());
    pending = "";
  }
  const start = logical.findIndex((line) => /^FROM \S+ AS build$/iu.test(line));
  if (start === -1) throw new Error("The Dockerfile has no `FROM <image> AS build` stage.");
  const end = logical.findIndex((line, index) => index > start && /^FROM /iu.test(line));
  const stage = logical.slice(start + 1, end === -1 ? undefined : end);
  return stage.map((line) => {
    const [keyword = "", ...rest] = line.split(" ");
    const args = rest.join(" ");
    if (keyword === "WORKDIR") return { keyword, args };
    if (keyword === "COPY" && !args.startsWith("--")) return { keyword, args };
    if (keyword === "RUN" && (args === STAGE_INSTALL_RUN || args === STAGE_PACK_RUN)) {
      return { keyword, args };
    }
    throw new Error(
      `The build-stage model cannot execute ${JSON.stringify(line)}; extend test/helpers/docker-context.ts before changing the stage.`,
    );
  });
}

/** Where each staged file comes from: container path -> repository path. */
export type StagePlan = ReadonlyMap<string, string>;

/**
 * Resolve the stage's COPY lines against the admitted context, with Docker's
 * rules: a directory source copies its contents, a file source lands at the
 * destination or, for a destination ending in `/`, inside it.
 */
export function planBuildStage(
  stage: readonly StageInstruction[],
  admitted: readonly string[],
): StagePlan {
  const plan = new Map<string, string>();
  let workdir = "/";
  for (const { keyword, args } of stage) {
    if (keyword === "WORKDIR") {
      workdir = posix.resolve(workdir, args);
      continue;
    }
    if (keyword !== "COPY") continue;
    const parts = args.split(" ");
    const destination = parts.pop() ?? "";
    const intoDirectory = destination.endsWith("/") || parts.length > 1;
    const target = posix.resolve(workdir, destination);
    for (const rawSource of parts) {
      const source = rawSource.replace(/\/+$/u, "");
      const under = admitted.filter((path) => path.startsWith(`${source}/`));
      if (admitted.includes(source)) {
        plan.set(intoDirectory ? posix.join(target, posix.basename(source)) : target, source);
      } else if (under.length > 0) {
        for (const path of under) plan.set(posix.join(target, path.slice(source.length + 1)), path);
      } else {
        throw new Error(
          `COPY ${rawSource} names nothing in the build context, so the image build would fail at that line.`,
        );
      }
    }
  }
  return plan;
}

/** The stage's working directory when its RUN lines execute. */
export function stageWorkdir(stage: readonly StageInstruction[]): string {
  let workdir = "/";
  for (const { keyword, args } of stage) {
    if (keyword === "WORKDIR") workdir = posix.resolve(workdir, args);
  }
  return workdir;
}

/**
 * Write the planned files under `root` (standing in for the container's `/`)
 * and link `node_modules` where `npm ci` would install it.
 */
export async function materializeBuildStage(
  root: string,
  stage: readonly StageInstruction[],
  plan: StagePlan,
  repositoryRoot: string,
  nodeModules: string,
): Promise<void> {
  for (const directory of new Set([...plan.keys()].map((path) => dirname(join(root, path))))) {
    await mkdir(directory, { recursive: true });
  }
  for (const [containerPath, repositoryPath] of plan) {
    await copyFile(join(repositoryRoot, repositoryPath), join(root, containerPath));
  }
  if (stage.some(({ keyword, args }) => keyword === "RUN" && args === STAGE_INSTALL_RUN)) {
    await symlink(nodeModules, join(root, stageWorkdir(stage), "node_modules"), "dir");
  }
}

/** Every regular file under `directory`, relative to it, sorted. */
export async function filesBelow(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => posix.relative(directory, posix.join(entry.parentPath, entry.name)))
    .sort();
}
