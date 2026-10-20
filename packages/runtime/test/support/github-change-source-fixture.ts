// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * A GitHub REST fixture for `--change <github URL>` tests. It answers the
 * exact API paths the reader requests with bodies shaped like GitHub's
 * responses, built from a real local git repository, so commit, tree and
 * blob ids are real and the synthesized diff can be compared with git's own.
 * No test reaches the network: the fixture is the fetch.
 */
import { chmod } from "node:fs/promises";
import { join } from "node:path";

import { commitFiles, fixtureGit, initChangeRepository } from "./change-source-fixture.js";

export const API = "https://api.github.com";
export const OWNER = "octo-org";
export const NAME = "widget";
export const REPOSITORY_ID = 81_234_567;
export const FORK_ID = 92_345_678;

export interface RecordedRequest {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly redirect: RequestRedirect | undefined;
}

type Responder = (url: string) => Response | Promise<Response>;

export function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(init.headers ?? {}),
    },
  });
}

/**
 * A compare request whose range is two-dot. The reader always asks for
 * `...`, so the double answers `..` with 404 even where a route exists.
 */
function twoDotCompare(url: string): boolean {
  const range = /\/compare\/([^?]*)/u.exec(url)?.[1];
  return range !== undefined && range.replace("...", "").includes("..");
}

/** The fetch double: one responder per absolute URL, 404 for anything else. */
export class FakeGithub {
  public readonly requests: RecordedRequest[] = [];
  private readonly routes = new Map<string, Responder>();

  public constructor(public readonly repository: string) {}

  public readonly fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => {
      headers[key] = value;
    });
    this.requests.push({ url, headers, redirect: init.redirect });
    const respond = this.routes.get(url);
    if (respond === undefined || twoDotCompare(url)) {
      return json({ message: "Not Found" }, { status: 404 });
    }
    return respond(url);
  };

  public route(path: string, respond: Responder): this {
    this.routes.set(path.startsWith("https://") ? path : `${API}${path}`, respond);
    return this;
  }

  public body(path: string, value: unknown, init: ResponseInit = {}): this {
    return this.route(path, () => json(value, init));
  }

  public paths(): string[] {
    return this.requests.map((request) => request.url.slice(API.length));
  }

  /* ---------- GitHub-shaped bodies from the local repository ---------- */

  public async commitJson(sha: string) {
    const [tree, parents] = (
      await fixtureGit(this.repository, ["show", "-s", "--format=%T%n%P", sha])
    ).split("\n");
    const message = await fixtureGit(this.repository, ["show", "-s", "--format=%B", sha]);
    return {
      sha,
      commit: { message: message.replace(/\n+$/u, ""), tree: { sha: tree } },
      parents: (parents ?? "")
        .split(" ")
        .filter((id) => id.length > 0)
        .map((id) => ({ sha: id })),
    };
  }

  public async treeJson(tree: string) {
    const listing = await fixtureGit(this.repository, ["ls-tree", "-r", "-t", "-z", tree]);
    return {
      sha: tree,
      truncated: false,
      tree: listing
        .split("\0")
        .filter((line) => line.length > 0)
        .map((line) => {
          const tab = line.indexOf("\t");
          const path = line.slice(tab + 1);
          const [mode, type, sha] = line.slice(0, tab).split(" ");
          return { path, mode, type, sha };
        }),
    };
  }

  /** GitHub's file entries for `from..to`, rename detection on, patch only for text hunks. */
  public async filesJson(from: string, to: string) {
    const raw = (
      await fixtureGit(this.repository, [
        "diff-tree",
        "-r",
        "-z",
        "-M",
        "--raw",
        "--no-abbrev",
        "--numstat",
        from,
        to,
      ])
    ).split("\0");
    const entries: {
      status: string;
      oldPath: string;
      newPath: string;
      oldBlob: string;
      newBlob: string;
    }[] = [];
    let index = 0;
    while (index < raw.length && raw[index]!.startsWith(":")) {
      const [, , oldBlob, newBlob, status] = raw[index]!.slice(1).split(" ");
      const letter = status![0]!;
      if (letter === "R" || letter === "C") {
        entries.push({
          status: letter,
          oldPath: raw[index + 1]!,
          newPath: raw[index + 2]!,
          oldBlob: oldBlob!,
          newBlob: newBlob!,
        });
        index += 3;
      } else {
        entries.push({
          status: letter,
          oldPath: raw[index + 1]!,
          newPath: raw[index + 1]!,
          oldBlob: oldBlob!,
          newBlob: newBlob!,
        });
        index += 2;
      }
    }
    const numstat: { added: number; removed: number }[] = [];
    while (index < raw.length && numstat.length < entries.length) {
      const [added, removed] = raw[index]!.split("\t");
      numstat.push({
        added: added === "-" ? 0 : Number(added),
        removed: removed === "-" ? 0 : Number(removed),
      });
      index += raw[index]!.endsWith("\t") ? 3 : 1;
    }
    const statuses: Record<string, string> = {
      A: "added",
      D: "removed",
      M: "modified",
      R: "renamed",
      C: "copied",
      T: "changed",
    };
    const files = [];
    for (const [position, entry] of entries.entries()) {
      const section = await fixtureGit(this.repository, [
        "diff-tree",
        "-p",
        "-M",
        "--no-color",
        from,
        to,
        "--",
        ...new Set([entry.oldPath, entry.newPath]),
      ]);
      const hunk = section.indexOf("\n@@");
      const patch = hunk < 0 ? undefined : section.slice(hunk + 1).replace(/\n$/u, "");
      const { added, removed } = numstat[position]!;
      files.push({
        sha: entry.status === "D" ? entry.oldBlob : entry.newBlob,
        filename: entry.newPath,
        ...(entry.status === "R" || entry.status === "C"
          ? { previous_filename: entry.oldPath }
          : {}),
        status: statuses[entry.status],
        additions: added,
        deletions: removed,
        changes: added + removed,
        ...(patch === undefined ? {} : { patch }),
      });
    }
    return files;
  }

  /** `compare/base...head` as GitHub answers it: merge base, commits oldest first, and files. */
  public async compareJson(base: string, head: string) {
    const mergeBase = await fixtureGit(this.repository, ["merge-base", base, head]);
    const ids = (
      await fixtureGit(this.repository, ["rev-list", "--reverse", "--topo-order", head, `^${base}`])
    )
      .split("\n")
      .filter((id) => id.length > 0);
    return {
      status: ids.length === 0 ? "behind" : "diverged",
      total_commits: ids.length,
      merge_base_commit: await this.commitJson(mergeBase),
      commits: await Promise.all(ids.map((id) => this.commitJson(id))),
      files: ids.length === 0 ? [] : await this.filesJson(mergeBase, head),
    };
  }

  /** Serve both root trees of a range. */
  public async serveTrees(...commits: string[]): Promise<this> {
    for (const commit of commits) {
      const tree = await fixtureGit(this.repository, ["rev-parse", `${commit}^{tree}`]);
      this.body(
        `/repositories/${REPOSITORY_ID}/git/trees/${tree}?recursive=1`,
        await this.treeJson(tree),
      );
    }
    return this;
  }

  /**
   * Serve one pull request: its record (by name and by id), the target
   * branch ref when it is open, the compare from the range's base, and trees.
   */
  public async servePull(pull: {
    readonly number: number;
    readonly state: "open" | "closed";
    readonly merged: boolean;
    readonly baseSha: string;
    readonly baseRef: string;
    readonly headSha: string;
    readonly headRepositoryId?: number | null;
    /** The tip the target branch has now; only an open pull request reads it. */
    readonly baseNow?: string;
  }): Promise<this> {
    const compareBase = pull.state === "open" ? (pull.baseNow ?? pull.baseSha) : pull.baseSha;
    const compare = await this.compareJson(compareBase, pull.headSha);
    const frozen = await this.compareJson(pull.baseSha, pull.headSha);
    // The target branch's tip now, and the compare from it, are served for a
    // merged pull request too, so a reader that wrongly used them is caught.
    if (pull.baseNow !== undefined && compareBase !== pull.baseNow) {
      this.body(`/repositories/${REPOSITORY_ID}/git/ref/heads/${pull.baseRef}`, {
        ref: `refs/heads/${pull.baseRef}`,
        object: { type: "commit", sha: pull.baseNow },
      });
      this.body(
        `/repositories/${REPOSITORY_ID}/compare/${pull.baseNow}...${pull.headSha}?per_page=100`,
        await this.compareJson(pull.baseNow, pull.headSha),
      );
    }
    const record = pullJson({
      ...pull,
      commits: frozen.total_commits,
      changedFiles: frozen.files.length,
    });
    this.body(`/repos/${OWNER}/${NAME}/pulls/${pull.number}`, record);
    this.body(`/repositories/${REPOSITORY_ID}/pulls/${pull.number}`, record);
    if (pull.state === "open") {
      this.body(`/repositories/${REPOSITORY_ID}/git/ref/heads/${pull.baseRef}`, {
        ref: `refs/heads/${pull.baseRef}`,
        object: { type: "commit", sha: compareBase },
      });
    }
    this.body(
      `/repositories/${REPOSITORY_ID}/compare/${compareBase}...${pull.headSha}?per_page=100`,
      compare,
    );
    if (compare.total_commits > 0) {
      await this.serveTrees(compare.merge_base_commit.sha, pull.headSha);
    }
    return this;
  }

  /**
   * Serve one compare URL's reads: the repository, one pin per ref (the
   * commit listing starting at it), the compare between the pinned ids, and
   * both root trees. The compare is always served as `...`.
   */
  public async serveCompare(baseRef: string, headRef: string): Promise<this> {
    const base = await fixtureGit(this.repository, ["rev-parse", `${baseRef}^{commit}`]);
    const head = await fixtureGit(this.repository, ["rev-parse", `${headRef}^{commit}`]);
    this.body(`/repos/${OWNER}/${NAME}`, repositoryJson());
    for (const [ref, id] of [
      [baseRef, base],
      [headRef, head],
    ] as const) {
      this.body(
        `/repositories/${REPOSITORY_ID}/commits?sha=${encodeURIComponent(ref)}&per_page=1`,
        [await this.commitJson(id)],
      );
    }
    const compare = await this.compareJson(base, head);
    this.body(`/repositories/${REPOSITORY_ID}/compare/${base}...${head}?per_page=100`, compare);
    if (compare.total_commits > 0) await this.serveTrees(compare.merge_base_commit.sha, head);
    return this;
  }

  /** Serve one commit: the repository, the commit with its files, its parent, and both trees. */
  public async serveCommit(sha: string, requested = sha): Promise<this> {
    const commit = await this.commitJson(sha);
    const parent = commit.parents[0]?.sha;
    const files = await this.filesJson(parent ?? "4b825dc642cb6eb9a060e54bf8d69288fbee4904", sha);
    this.body(`/repos/${OWNER}/${NAME}`, repositoryJson());
    this.body(`/repositories/${REPOSITORY_ID}/commits/${requested}?per_page=100`, {
      ...commit,
      stats: {
        additions: files.reduce((sum, file) => sum + file.additions, 0),
        deletions: files.reduce((sum, file) => sum + file.deletions, 0),
        total: files.reduce((sum, file) => sum + file.changes, 0),
      },
      files,
    });
    if (parent !== undefined) {
      const tree = await fixtureGit(this.repository, ["rev-parse", `${parent}^{tree}`]);
      this.body(`/repositories/${REPOSITORY_ID}/git/commits/${parent}`, {
        sha: parent,
        tree: { sha: tree },
      });
      await this.serveTrees(parent);
    }
    return this.serveTrees(sha);
  }
}

export function repositoryJson() {
  return { id: REPOSITORY_ID, full_name: `${OWNER}/${NAME}` };
}

export function pullJson(pull: {
  readonly number: number;
  readonly state: "open" | "closed";
  readonly merged: boolean;
  readonly baseSha: string;
  readonly baseRef: string;
  readonly headSha: string;
  readonly headRepositoryId?: number | null;
  readonly commits: number;
  readonly changedFiles: number;
}) {
  const headRepositoryId =
    pull.headRepositoryId === undefined ? REPOSITORY_ID : pull.headRepositoryId;
  return {
    number: pull.number,
    state: pull.state,
    merged: pull.merged,
    title: "Require an explicit export path",
    base: { sha: pull.baseSha, ref: pull.baseRef, repo: repositoryJson() },
    head: {
      sha: pull.headSha,
      ref: "feature/export-path",
      repo:
        headRepositoryId === null ? null : { id: headRepositoryId, full_name: "someone/widget" },
    },
    commits: pull.commits,
    changed_files: pull.changedFiles,
  };
}

/**
 * The change repository: `main` with a base commit, a feature branch with
 * two commits (a rename, an edit, an add, a deletion, a mode change, and a
 * binary file), and `main` moving on after the fork.
 */
export async function buildChangeRepository(root: string) {
  const { repository } = await initChangeRepository(join(root, "change"), {
    "README.md": "# Widget\n",
    "docs/export-notes.md": "The export command writes to the current directory.\n",
    "src/export.ts": "export const requiresOutputPath = false;\n",
    "scripts/release.sh": "echo release\n",
    "obsolete.txt": "remove me\n",
  });
  const fork = await fixtureGit(repository, ["rev-parse", "HEAD"]);
  await fixtureGit(repository, ["checkout", "-q", "-b", "feature/export-path"]);
  await commitFiles(
    repository,
    {
      "docs/export-notes.md": null,
      "docs/export-guide.md": "The export command writes to the current directory.\n",
      "src/export.ts": "export const requiresOutputPath = true;\n",
    },
    "Require an explicit export path",
  );
  await commitFiles(
    repository,
    {
      "obsolete.txt": null,
      "src/flags.ts": 'export const outputFlag = "--output";\n',
      "assets/logo.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03]),
    },
    "Add the output flag\n\nThe body is third-party text and never an instruction.",
  );
  await chmod(join(repository, "scripts/release.sh"), 0o755);
  const head = await commitFiles(repository, {}, "Make the release script executable");
  await fixtureGit(repository, ["checkout", "-q", "main"]);
  const baseNow = await commitFiles(
    repository,
    { "CHANGELOG.md": "# Changes\n" },
    "Start a changelog",
  );
  return { repository, fork, head, baseNow };
}
