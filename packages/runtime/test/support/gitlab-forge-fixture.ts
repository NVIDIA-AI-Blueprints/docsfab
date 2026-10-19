// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * A recorded GitLab for the merge request forge arm. It answers the exact
 * `glab api` endpoints the arm requests, spelled out here rather than taken
 * from the arm's own builder, with bodies in GitLab 17.7's shapes (the
 * templates in `test/fixtures/change-source-gitlab/forge/`) filled from a
 * real local fixture repository's own git. Ids are real, and the hunks are
 * git's, so a forge record can be compared with a local one. No test reaches
 * GitLab.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import type { ReadOnlyCommandResult } from "../../src/delivery/command-types.js";
import type { CommandRunner } from "../../src/init/types.js";
import { fixtureGitEnvironment } from "./change-source-fixture.js";

const exec = promisify(execFile);

export const FORGE_HOST = "gitlab.example.test";
export const FORGE_PROJECT_PATH = "team/docs-project";
export const FORGE_PROJECT_ID = 4242;
export const FORGE_IID = 813;
/** GitLab's own page maximum, which the arm asks for on every paged read. */
export const FORGE_PAGE_SIZE = 100;

const FIXTURES = join(import.meta.dirname, "..", "fixtures", "change-source-gitlab");

function template(name: string): string {
  return readFileSync(join(FIXTURES, name), "utf8");
}

/** A template with every `"@key"` value replaced by `values[key]`, of any JSON type. */
function filled(
  source: string,
  values: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return JSON.parse(source, (_key, value: unknown) => {
    if (typeof value !== "string" || !value.startsWith("@")) return value;
    const key = value.slice(1);
    return Object.hasOwn(values, key) ? values[key] : value;
  }) as Record<string, unknown>;
}

/** One `/diffs` or commit `/diff` item in GitLab's shape. */
export function diffItemOf(fields: {
  readonly diff: string;
  readonly oldPath: string;
  readonly newPath: string;
  readonly aMode: string;
  readonly bMode: string;
  readonly newFile?: boolean;
  readonly renamedFile?: boolean;
  readonly deletedFile?: boolean;
  readonly generatedFile?: boolean | null;
}): Record<string, unknown> {
  return filled(template("forge/diff-item.json"), {
    diff: fields.diff,
    new_path: fields.newPath,
    old_path: fields.oldPath,
    a_mode: fields.aMode,
    b_mode: fields.bMode,
    new_file: fields.newFile ?? false,
    renamed_file: fields.renamedFile ?? false,
    deleted_file: fields.deletedFile ?? false,
    // `null` is GitLab's commit-diff value, kept as sent; only an omitted field defaults.
    generated_file: fields.generatedFile === undefined ? false : fields.generatedFile,
  });
}

/** A commit's facts as the commit templates read them. */
export interface CommitFacts {
  readonly id: string;
  readonly parents: readonly string[];
  readonly message: string;
}

function templateFacts(facts: CommitFacts) {
  const firstLine = facts.message.split("\n")[0]!;
  return {
    ...facts,
    short: facts.id.slice(0, 8),
    // GitLab clips a long title; the arm must read the subject from `message`.
    title: firstLine.length > 100 ? `${firstLine.slice(0, 97)}...` : firstLine,
  };
}

/** One `/repository/commits?ref_name=` item. */
export function commitsItemOf(facts: CommitFacts): Record<string, unknown> {
  return filled(template("forge/commits-item.json"), templateFacts(facts));
}

/** The `/repository/commits/:sha` answer with the given line totals. */
export function commitGetOf(
  facts: CommitFacts,
  stats: { readonly additions: number; readonly deletions: number },
): Record<string, unknown> {
  return filled(template("forge/commit-get.json"), {
    ...templateFacts(facts),
    ...stats,
    total: stats.additions + stats.deletions,
  });
}

/** The recorded merge request `get`, with its commit ids filled in. */
export function mergeRequestGet(
  ids: Readonly<Record<"base" | "start" | "head" | "merge", string | null>>,
  fields: Record<string, unknown> = {},
): Record<string, unknown> {
  return { ...filled(template("merge-request-get.json"), ids), ...fields };
}

/** Untrimmed git output, in the fixture's closed environment. */
export async function gitBytes(repository: string, args: readonly string[]): Promise<Buffer> {
  const { stdout } = await exec("git", [...args], {
    cwd: repository,
    env: fixtureGitEnvironment(),
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout as Buffer;
}

export type DiffItem = Record<string, unknown>;

/**
 * The diff items GitLab lists for `from`..`to` (`from` null: a root commit),
 * from git's own raw diff and hunks: `diff` is the hunks alone, GitLab's raw
 * binary marker, or empty; an absent side's mode is `"0"`.
 */
export async function diffItems(
  repository: string,
  from: string | null,
  to: string,
  generated: boolean | null,
): Promise<DiffItem[]> {
  const sides = from === null ? ["--root", to] : [from, to];
  const raw = (
    await gitBytes(repository, [
      "-c",
      "core.quotePath=false",
      "diff-tree",
      "-r",
      "-z",
      "--raw",
      "-M50%",
      "--full-index",
      ...(from === null ? ["--no-commit-id"] : []),
      ...sides,
    ])
  )
    .toString("utf8")
    .split("\0");
  const items: DiffItem[] = [];
  let index = 0;
  while (index < raw.length) {
    const meta = raw[index]!;
    if (!meta.startsWith(":")) {
      index += 1;
      continue;
    }
    const [oldMode, newMode, , , status] = meta.slice(1).split(" ") as [
      string,
      string,
      string,
      string,
      string,
    ];
    const renamed = status.startsWith("R");
    const oldPath = raw[index + 1]!;
    const newPath = renamed ? raw[index + 2]! : oldPath;
    index += renamed ? 3 : 2;
    const patch = (
      await gitBytes(repository, [
        "-c",
        "core.quotePath=false",
        "diff-tree",
        "-p",
        "-M50%",
        "-U3",
        "--no-color",
        ...sides,
        "--",
        ...new Set([oldPath, newPath]),
      ])
    ).toString("utf8");
    const added = status === "A";
    const deleted = status === "D";
    const hunk = patch.search(/^@@ /mu);
    const diff =
      hunk >= 0
        ? patch.slice(hunk)
        : /^Binary files /mu.test(patch)
          ? `Binary files ${added ? "/dev/null" : `a/${oldPath}`} and ${
              deleted ? "/dev/null" : `b/${newPath}`
            } differ\n`
          : "";
    items.push(
      diffItemOf({
        diff,
        newPath,
        oldPath,
        aMode: added ? "0" : oldMode,
        bMode: deleted ? "0" : newMode,
        newFile: added,
        renamedFile: renamed,
        deletedFile: deleted,
        generatedFile: generated,
      }),
    );
  }
  // GitLab lists in git's own order, which the raw diff already has.
  return items;
}

/** A commit's id, parents and message from its raw object. */
export async function commitFacts(repository: string, sha: string): Promise<CommitFacts> {
  const body = (await gitBytes(repository, ["cat-file", "commit", sha])).toString("utf8");
  const separator = body.indexOf("\n\n");
  const parents = body
    .slice(0, separator)
    .split("\n")
    .filter((line) => line.startsWith("parent "))
    .map((line) => line.slice("parent ".length));
  return { id: sha, parents, message: body.slice(separator + "\n\n".length) };
}

/** One `/repository/commits?ref_name=` item, from the repository. */
export async function commitsItem(repository: string, sha: string): Promise<DiffItem> {
  return commitsItemOf(await commitFacts(repository, sha));
}

/** The `/repository/commits/:sha` answer, with `stats` from git's numstat against the first parent. */
export async function commitGet(repository: string, sha: string): Promise<DiffItem> {
  const facts = await commitFacts(repository, sha);
  const numstat = (
    await gitBytes(repository, [
      "diff-tree",
      "-r",
      "--numstat",
      "-M50%",
      ...(facts.parents.length === 0
        ? ["--root", "--no-commit-id", sha]
        : [facts.parents[0]!, sha]),
    ])
  )
    .toString("utf8")
    .split("\n")
    .filter((line) => line.length > 0);
  let additions = 0;
  let deletions = 0;
  for (const line of numstat) {
    const [added, removed] = line.split("\t");
    // Binary files count no lines, as GitLab's stats count them.
    if (added !== "-") additions += Number(added);
    if (removed !== "-") deletions += Number(removed);
  }
  return commitGetOf(facts, { additions, deletions });
}

/** The page bodies a paged read of `items` returns, an empty one after an exact multiple. */
export function pages<T>(items: readonly T[]): T[][] {
  const result: T[][] = [];
  for (let start = 0; ; start += FORGE_PAGE_SIZE) {
    const page = items.slice(start, start + FORGE_PAGE_SIZE);
    result.push(page);
    if (page.length < FORGE_PAGE_SIZE) return result;
  }
}

/** The forge-arm endpoints, spelled out independently of the arm's own builder. */
export const ENDPOINTS = Object.freeze({
  pin: `projects/${encodeURIComponent(FORGE_PROJECT_PATH)}/merge_requests/${FORGE_IID}`,
  reread: `projects/${FORGE_PROJECT_ID}/merge_requests/${FORGE_IID}`,
  diffs: (page: number) =>
    `projects/${FORGE_PROJECT_ID}/merge_requests/${FORGE_IID}/diffs?per_page=${FORGE_PAGE_SIZE}&page=${page}`,
  commits: (base: string, head: string, page: number) =>
    `projects/${FORGE_PROJECT_ID}/repository/commits?ref_name=${base}..${head}&order=topo&per_page=${FORGE_PAGE_SIZE}&page=${page}`,
  commit: (sha: string) => `projects/${FORGE_PROJECT_ID}/repository/commits/${sha}`,
  commitDiff: (sha: string, page: number) =>
    `projects/${FORGE_PROJECT_ID}/repository/commits/${sha}/diff?per_page=${FORGE_PAGE_SIZE}&page=${page}`,
});

export type Answer = unknown | { readonly result: ReadOnlyCommandResult };

/** A failed `glab` call, as a lapsed login fails. */
export const LOGIN_EXPIRED: { readonly result: ReadOnlyCommandResult } = Object.freeze({
  result: { stdout: "", stderr: "glab: 401 Unauthorized", exitCode: 1 },
});

function isResult(answer: Answer): answer is { readonly result: ReadOnlyCommandResult } {
  return typeof answer === "object" && answer !== null && Object.hasOwn(answer, "result");
}

/**
 * The `glab` stand-in: each endpoint answers its recorded body, the last of a
 * list repeating; an endpoint with no answer asks `otherwise`, else fails as
 * GitLab's 404 does. Every call is recorded with its arguments.
 */
export class RecordedGitLab {
  public readonly calls: string[][] = [];
  private readonly answers = new Map<string, Answer[]>();
  private readonly served = new Map<string, number>();

  public constructor(private readonly otherwise?: (endpoint: string) => Answer | undefined) {}

  public on(endpoint: string, ...answers: Answer[]): this {
    this.answers.set(endpoint, answers);
    return this;
  }

  /** Register each page body of `items` under `endpoint(page)`. */
  public paged(endpoint: (page: number) => string, items: readonly unknown[]): this {
    pages(items).forEach((page, index) => this.on(endpoint(index + 1), page));
    return this;
  }

  /** The endpoints requested, in order. */
  public endpoints(): string[] {
    return this.calls.map((args) => args.at(-1)!);
  }

  public readonly commands: CommandRunner = {
    run: async (_command, args) => {
      this.calls.push([...args]);
      const endpoint = String(args.at(-1));
      const fallback = this.otherwise?.(endpoint);
      const answers =
        this.answers.get(endpoint) ?? (fallback === undefined ? undefined : [fallback]);
      if (answers === undefined) {
        return { stdout: "", stderr: "glab: 404 Not Found", exitCode: 1 };
      }
      const count = this.served.get(endpoint) ?? 0;
      this.served.set(endpoint, count + 1);
      const answer = answers[Math.min(count, answers.length - 1)];
      return isResult(answer)
        ? answer.result
        : { stdout: JSON.stringify(answer), stderr: "", exitCode: 0 };
    },
  };

  public access() {
    return { commands: this.commands, environment: {} };
  }
}
