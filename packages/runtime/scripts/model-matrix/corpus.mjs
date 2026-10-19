// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Model-matrix corpora: load, verify, materialize, and seal.
 *
 * A corpus is a sealed fixture repository plus one task per workflow. The
 * tasks own the instructions, so an instruction changes only by versioning
 * the corpus, and earlier results stay comparable with the corpus they name.
 *
 * Every refusal here happens before any model call, and each one names the
 * task or file it refused.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { workflowManifest, writeClass } from "./delivery.mjs";

const execFileAsync = promisify(execFile);

export const CORPUS_MANIFEST_KIND = "docsfab-model-matrix-corpus";
export const CORPUS_TASKS_KIND = "docsfab-model-matrix-tasks";
const SENTINEL = ".docsfab-fixture-sentinel.json";
const OUTPUT_KINDS = new Set(["document", "report"]);

/**
 * Bootstrap's own contract (src/onboarding): it may change only README.md and
 * AGENTS.md files; a patch is refused (`missing-guidance`) unless every root
 * file below exists afterwards; and a changed file's directory must already
 * hold tracked files (`unobserved-directory`). The harness cannot load those
 * modules, so a test pins these two values against them.
 */
export const BOOTSTRAP_GUIDANCE_PATH = /^(?:[^/]+\/)*(?:README|AGENTS)\.md$/u;
export const BOOTSTRAP_REQUIRED_GUIDANCE = Object.freeze(["README.md", "AGENTS.md"]);

/**
 * What each write workflow can satisfy, per target. A create can only make a
 * page that does not exist; update and restructure can only change one that
 * does; bootstrap can only touch guidance files. A write workflow without a
 * rule here is refused, so a new one must be classified before a corpus can
 * use it.
 */
export const WRITE_TARGET_RULES = Object.freeze({
  "create-documentation": (target) => target.state === "absent" || "must not exist yet",
  "update-documentation": (target) => target.state === "present" || "must already exist",
  "restructure-documentation": (target) => target.state === "present" || "must already exist",
  bootstrap: (target) =>
    BOOTSTRAP_GUIDANCE_PATH.test(target.path) || "must be a README.md or AGENTS.md file",
});

/** Bootstrap's task-level contract: what the whole target set must cover. */
function bootstrapTaskProblem(targets, tracked) {
  for (const required of BOOTSTRAP_REQUIRED_GUIDANCE) {
    if (!tracked.has(required) && !targets.some((target) => target.path === required)) {
      return `the fixture has no root ${required}, so a bootstrap patch is refused (missing-guidance) unless the task adds it`;
    }
  }
  for (const target of targets) {
    const slash = target.path.lastIndexOf("/");
    const directory = target.path.slice(0, slash + 1);
    if (slash >= 0 && ![...tracked].some((path) => path.startsWith(directory))) {
      return `${target.path} is in a directory with no tracked files, so bootstrap refuses that write (unobserved-directory)`;
    }
  }
  return null;
}
const TARGET_STATES = new Set(["absent", "present"]);

export class CorpusError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "CorpusError";
    this.code = code;
  }
}

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys(value[key])]),
    );
  }
  return value;
}

/** sha256 of compact JSON with sorted keys. */
export const canonicalDigest = (value) => sha256(JSON.stringify(sortKeys(value)));

function manifestBody(manifest) {
  const { manifestSha256: _seal, ...body } = manifest;
  return body;
}

function safeRelative(path, label) {
  if (
    typeof path !== "string" ||
    path === "" ||
    isAbsolute(path) ||
    path.includes("\\") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new CorpusError(
      "corpus-path-invalid",
      `${label} ${JSON.stringify(path)} is not a plain repository-relative path.`,
    );
  }
  return path;
}

const fileMode = (stat) => ((stat.mode & 0o100) !== 0 ? "100755" : "100644");

/** Every regular file under `root`, sorted, refusing symlinks and special files. */
export async function ledger(root) {
  const files = [];
  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const rel = relative(root, path).split(sep).join("/");
      if (entry.isSymbolicLink()) {
        throw new CorpusError(
          "corpus-template-symlink",
          `fixture template contains a symlink: ${rel}`,
        );
      }
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) {
        const stat = await lstat(path);
        files.push({ path: rel, sha256: sha256(await readFile(path)), mode: fileMode(stat) });
      } else {
        throw new CorpusError(
          "corpus-template-special-file",
          `fixture template contains a special file: ${rel}`,
        );
      }
    }
  }
  await walk(root);
  return files.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
}

/**
 * The per-task permitted paths stated in the repository's AGENTS.md
 * "Writing boundary" table. Only that section counts: a path mentioned
 * anywhere else (for example under source priority) grants nothing.
 */
export function writingBoundary(agentsText) {
  const lines = agentsText.split("\n");
  const start = lines.findIndex((line) => /^## Writing boundary\s*$/u.test(line));
  if (start < 0) {
    throw new CorpusError(
      "corpus-boundary-missing",
      "repository AGENTS.md has no `## Writing boundary` section.",
    );
  }
  const end = lines.findIndex((line, index) => index > start && /^## /u.test(line));
  const section = lines.slice(start + 1, end < 0 ? undefined : end);
  const boundary = new Map();
  for (const line of section) {
    const cells = /^\|(.+)\|\s*$/u
      .exec(line.trim())?.[1]
      .split("|")
      .map((cell) => cell.trim());
    if (!cells || cells.length !== 2 || /^-+$/u.test(cells[0]) || cells[0] === "Task") continue;
    const paths = [...cells[1].matchAll(/`([^`]+)`/gu)].map((match) => match[1]);
    if (paths.length === 0 && !/^none\b/u.test(cells[1])) {
      throw new CorpusError(
        "corpus-boundary-row-invalid",
        `AGENTS.md writing-boundary row ${cells[0]} names no path and is not "none".`,
      );
    }
    if (boundary.has(cells[0])) {
      throw new CorpusError(
        "corpus-boundary-row-duplicate",
        `AGENTS.md writing boundary lists ${cells[0]} twice.`,
      );
    }
    boundary.set(cells[0], paths);
  }
  return boundary;
}

const sameSet = (left, right) =>
  left.length === right.length &&
  [...left].sort().every((value, index) => value === [...right].sort()[index]);

/** Validate the task set against the product's workflows and the fixture it ships. */
export function validateTasks(tasks, files, agentsText) {
  if (
    tasks?.schemaVersion !== 1 ||
    tasks.kind !== CORPUS_TASKS_KIND ||
    !Array.isArray(tasks.tasks)
  ) {
    throw new CorpusError(
      "corpus-tasks-shape",
      "tasks.json is not a docsfab-model-matrix-tasks v1 document.",
    );
  }
  const tracked = new Set(files.map((file) => file.path));
  const boundary = writingBoundary(agentsText);
  const ids = new Set();
  for (const task of tasks.tasks) {
    const where = `task ${task?.id ?? "(no id)"}`;
    if (typeof task?.id !== "string" || !/^[a-z][a-z0-9-]*$/u.test(task.id) || ids.has(task.id)) {
      throw new CorpusError("corpus-task-id", `${where} needs a unique lower-case id.`);
    }
    ids.add(task.id);
    let manifest;
    try {
      manifest = workflowManifest(task.workflow);
    } catch (error) {
      throw new CorpusError("corpus-task-workflow-unknown", `${where}: ${error.message}`);
    }
    if (!OUTPUT_KINDS.has(task.output)) {
      throw new CorpusError("corpus-task-output", `${where} output must be document or report.`);
    }
    const targets = task.targets ?? [];
    const permitted = task.permittedPaths ?? [];
    for (const path of permitted) safeRelative(path, `${where} permitted path`);
    const kind = writeClass(task.workflow);
    if (kind === "read-only") {
      if (task.output !== "report" || targets.length > 0 || permitted.length > 0) {
        throw new CorpusError(
          "corpus-task-read-only-writes",
          `${where}: ${task.workflow} is read-only, so it needs report output and no targets or permitted paths.`,
        );
      }
    } else {
      if (task.output !== "document" || targets.length === 0) {
        throw new CorpusError(
          "corpus-task-write-without-target",
          `${where}: ${task.workflow} writes, so it needs document output and at least one target.`,
        );
      }
      if (typeof task.instruction !== "string" || task.instruction.trim() === "") {
        throw new CorpusError(
          "corpus-task-instruction-missing",
          `${where}: a write task needs an instruction.`,
        );
      }
    }
    if (task.instruction !== null && typeof task.instruction !== "string") {
      throw new CorpusError(
        "corpus-task-instruction-shape",
        `${where}: instruction must be a string or null.`,
      );
    }
    for (const target of targets) {
      const path = safeRelative(target?.path, `${where} target`);
      if (!TARGET_STATES.has(target.state)) {
        throw new CorpusError(
          "corpus-task-target-state",
          `${where} target ${path} state must be absent or present.`,
        );
      }
      if (!permitted.includes(path)) {
        throw new CorpusError(
          "corpus-task-target-not-permitted",
          `${where} target ${path} is not in its permitted paths.`,
        );
      }
      if (!task.instruction.includes(path)) {
        throw new CorpusError(
          "corpus-task-target-not-in-instruction",
          `${where} target ${path} is not named in its instruction, so the model cannot know it.`,
        );
      }
      if ((target.state === "present") !== tracked.has(path)) {
        throw new CorpusError(
          "corpus-task-target-state-mismatch",
          `${where} target ${path} is declared ${target.state} but the fixture ${tracked.has(path) ? "has" : "lacks"} it.`,
        );
      }
      const rule = WRITE_TARGET_RULES[task.workflow];
      const verdict = rule ? rule(target) : "has no target rule for this workflow";
      if (verdict !== true) {
        throw new CorpusError(
          "corpus-task-target-unsatisfiable",
          `${where}: a ${task.workflow} target ${verdict}, so ${path} (${target.state}) cannot be satisfied.`,
        );
      }
    }
    const taskProblem =
      task.workflow === "bootstrap" ? bootstrapTaskProblem(targets, tracked) : null;
    if (taskProblem) {
      throw new CorpusError("corpus-task-target-unsatisfiable", `${where}: ${taskProblem}.`);
    }
    const stated = boundary.get(task.id);
    if (!stated) {
      throw new CorpusError(
        "corpus-task-boundary-missing",
        `${where} has no row in the AGENTS.md writing boundary, so the model is not told what it may change.`,
      );
    }
    if (!sameSet(stated, permitted)) {
      throw new CorpusError(
        "corpus-task-boundary-mismatch",
        `${where} permits [${permitted.join(", ")}] but AGENTS.md permits [${stated.join(", ")}].`,
      );
    }
    const stepIds = new Set((manifest.steps ?? []).map((step) => step.id));
    for (const step of task.reportSteps ?? []) {
      if (task.output !== "report" || !stepIds.has(step)) {
        throw new CorpusError(
          "corpus-task-report-step",
          `${where} report step ${step} is not a step of ${task.workflow} or the task is not a report.`,
        );
      }
    }
  }
  for (const row of boundary.keys()) {
    if (!ids.has(row)) {
      throw new CorpusError(
        "corpus-boundary-row-orphan",
        `AGENTS.md writing boundary names unknown task ${row}.`,
      );
    }
  }
  const sources = tasks.judgeSources ?? [];
  if (sources.length === 0)
    throw new CorpusError("corpus-judge-sources-missing", "tasks.json names no judge sources.");
  const seen = new Set();
  for (const source of sources) {
    const path = safeRelative(source?.path, "judge source");
    if (!tracked.has(path) || seen.has(path) || typeof source.role !== "string") {
      throw new CorpusError(
        "corpus-judge-source-invalid",
        `judge source ${path} must be a unique tracked fixture file with a role.`,
      );
    }
    seen.add(path);
  }
}

/** Load a corpus and verify its seal, file ledger, and tasks. Refuses on any drift. */
export async function loadCorpus(corpusDir) {
  const dir = resolve(corpusDir);
  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"));
  } catch (error) {
    throw new CorpusError("corpus-manifest-unreadable", `${dir}/manifest.json: ${error.message}`);
  }
  if (manifest?.schemaVersion !== 1 || manifest.kind !== CORPUS_MANIFEST_KIND) {
    throw new CorpusError(
      "corpus-manifest-kind",
      `${dir}/manifest.json is not a ${CORPUS_MANIFEST_KIND} v1 manifest.`,
    );
  }
  if (manifest.manifestSha256 !== canonicalDigest(manifestBody(manifest))) {
    throw new CorpusError(
      "corpus-manifest-seal",
      `${manifest.id} manifest self-seal mismatch; reseal with \`npm run seal:model-matrix-corpus -- ${dir}\`.`,
    );
  }
  const tasksBytes = await readFile(join(dir, "tasks.json"));
  if (sha256(tasksBytes) !== manifest.tasksSha256) {
    throw new CorpusError(
      "corpus-tasks-digest",
      `${manifest.id} tasks.json differs from its sealed digest.`,
    );
  }
  const template = join(dir, manifest.repository.templatePath);
  const files = await ledger(template);
  if (canonicalDigest(files) !== manifest.repository.treeSha256) {
    const sealed = new Map(manifest.repository.files.map((file) => [file.path, file]));
    const drift = files
      .filter(
        (file) =>
          sealed.get(file.path)?.sha256 !== file.sha256 ||
          sealed.get(file.path)?.mode !== file.mode,
      )
      .map((file) => file.path);
    const missing = [...sealed.keys()].filter((path) => !files.some((file) => file.path === path));
    throw new CorpusError(
      "corpus-repository-drift",
      `${manifest.id} repository differs from its sealed ledger (changed or added: ${drift.join(", ") || "none"}; missing: ${missing.join(", ") || "none"}).`,
    );
  }
  const tasks = JSON.parse(tasksBytes.toString("utf8"));
  if (tasks.corpusId !== manifest.id) {
    throw new CorpusError(
      "corpus-tasks-id",
      `tasks.json names ${tasks.corpusId}, manifest names ${manifest.id}.`,
    );
  }
  validateTasks(tasks, files, await readFile(join(template, "AGENTS.md"), "utf8"));
  const sentinel = JSON.parse(await readFile(join(template, SENTINEL), "utf8"));
  if (sentinel.corpusId !== manifest.id) {
    throw new CorpusError(
      "corpus-sentinel",
      `${SENTINEL} names ${sentinel.corpusId}, manifest names ${manifest.id}.`,
    );
  }
  return { dir, manifest, tasks, template };
}

function gitEnvironment(identity) {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: identity.authorName,
    GIT_AUTHOR_EMAIL: identity.authorEmail,
    GIT_AUTHOR_DATE: identity.authorDate,
    GIT_COMMITTER_NAME: identity.committerName,
    GIT_COMMITTER_EMAIL: identity.committerEmail,
    GIT_COMMITTER_DATE: identity.committerDate,
    LC_ALL: "C",
    TZ: "UTC",
  };
}

async function git(cwd, args, identity) {
  const { stdout } = await execFileAsync("git", args, { cwd, env: gitEnvironment(identity) });
  return stdout.trim();
}

async function isRecognizedMaterialization(destination, corpusId) {
  try {
    const sentinel = JSON.parse(await readFile(join(destination, SENTINEL), "utf8"));
    return sentinel.kind === "docsfab-fixture-sentinel" && sentinel.corpusId === corpusId;
  } catch {
    return false;
  }
}

/** The safety refusals the v1 materializer applies, for any destination. */
async function prepareDestination(destination, corpus, force) {
  if (!isAbsolute(destination)) {
    throw new CorpusError(
      "corpus-destination-relative",
      `destination must be absolute: ${destination}`,
    );
  }
  if (existsSync(destination) && lstatSync(destination).isSymbolicLink()) {
    throw new CorpusError(
      "corpus-destination-symlink",
      `refusing symlink destination: ${destination}`,
    );
  }
  const parent = dirname(destination);
  const canonical = join(
    existsSync(parent) ? realpathSync(parent) : parent,
    destination.slice(parent.length + 1),
  );
  if (canonical !== destination) {
    throw new CorpusError(
      "corpus-destination-not-canonical",
      `destination must be canonical: ${destination}`,
    );
  }
  const home = realpathSync(homedir());
  const corpusRoot = realpathSync(corpus.dir);
  const inside = (child, root) => child === root || child.startsWith(`${root}${sep}`);
  if (
    destination === sep ||
    destination === home ||
    inside(destination, corpusRoot) ||
    inside(corpusRoot, destination) ||
    inside(home, destination)
  ) {
    throw new CorpusError(
      "corpus-destination-protected",
      `refusing protected destination: ${destination}`,
    );
  }
  if (!existsSync(destination)) return;
  const entries = await readdir(destination);
  if (!force) {
    throw new CorpusError(
      "corpus-destination-exists",
      `destination already exists: ${destination}`,
    );
  }
  if (entries.length > 0 && !(await isRecognizedMaterialization(destination, corpus.manifest.id))) {
    throw new CorpusError(
      "corpus-destination-foreign",
      `force replaces only an empty directory or a prior ${corpus.manifest.id} materialization: ${destination}`,
    );
  }
  await rm(destination, { recursive: true, force: true });
}

async function copyTemplate(template, files, destination) {
  for (const file of files) {
    const target = join(destination, ...file.path.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(template, ...file.path.split("/")), target);
    await chmod(target, file.mode === "100755" ? 0o755 : 0o644);
  }
}

async function commitTree(destination, identity) {
  await git(destination, ["init", "--quiet", "--initial-branch=main"], identity);
  await git(destination, ["config", "core.autocrlf", "false"], identity);
  await git(destination, ["config", "core.filemode", "true"], identity);
  await git(destination, ["add", "--all"], identity);
  await git(
    destination,
    ["commit", "--quiet", "--no-gpg-sign", "--no-verify", "-m", identity.message],
    identity,
  );
  return {
    revision: await git(destination, ["rev-parse", "HEAD"], identity),
    gitTree: await git(destination, ["rev-parse", "HEAD^{tree}"], identity),
    status: await git(destination, ["status", "--porcelain=v1"], identity),
  };
}

/** Materialize a loaded corpus to a new Git repository at its sealed revision. */
export async function materializeCorpus(corpus, destination, { force = false } = {}) {
  await prepareDestination(destination, corpus, force);
  await copyTemplate(corpus.template, corpus.manifest.repository.files, destination);
  const result = await commitTree(destination, corpus.manifest.repository.git);
  if (
    result.revision !== corpus.manifest.repository.revision ||
    result.gitTree !== corpus.manifest.repository.gitTree
  ) {
    throw new CorpusError(
      "corpus-materialized-revision",
      `${corpus.manifest.id} materialized ${result.revision} (tree ${result.gitTree}); sealed ${corpus.manifest.repository.revision} (tree ${corpus.manifest.repository.gitTree}).`,
    );
  }
  if (result.status !== "") {
    throw new CorpusError(
      "corpus-materialized-dirty",
      `${destination} is dirty after materialization.`,
    );
  }
  return { destination, revision: result.revision, gitTree: result.gitTree };
}

/**
 * Recompute every digest a corpus manifest pins, from the bytes on disk, and
 * write the sealed manifest. The authored fields (id, kind, derivedFrom,
 * template path, Git identity) are kept; everything derived is recomputed.
 * `seal-corpus.mjs` reseals the knowledge snapshot first.
 */
export async function sealCorpus(corpusDir) {
  const dir = resolve(corpusDir);
  const previous = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"));
  const template = join(dir, previous.repository.templatePath);
  const files = await ledger(template);
  const tasksBytes = await readFile(join(dir, "tasks.json"));
  validateTasks(
    JSON.parse(tasksBytes.toString("utf8")),
    files,
    await readFile(join(template, "AGENTS.md"), "utf8"),
  );
  const scratch = await mkdtemp(join(await realpath(tmpdir()), "model-matrix-seal-"));
  try {
    const destination = join(scratch, "repository");
    await mkdir(destination);
    await copyTemplate(template, files, destination);
    const { revision, gitTree } = await commitTree(destination, previous.repository.git);
    const body = {
      schemaVersion: 1,
      kind: CORPUS_MANIFEST_KIND,
      id: previous.id,
      derivedFrom: previous.derivedFrom,
      repository: {
        templatePath: previous.repository.templatePath,
        git: previous.repository.git,
        files,
        treeSha256: canonicalDigest(files),
        revision,
        gitTree,
      },
      tasksSha256: sha256(tasksBytes),
    };
    const manifest = { ...body, manifestSha256: canonicalDigest(body) };
    await writeFile(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    return manifest;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
