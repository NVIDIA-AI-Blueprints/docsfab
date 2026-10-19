// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Local git fixture repositories for the `--change` suites. Every command runs
 * with no global or system configuration, fixed identities and dates, and no
 * signing, so object ids are reproducible and the operator's own git setup
 * never leaks into a fixture.
 */
import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { deflateSync, inflateSync } from "node:zlib";

const exec = promisify(execFile);

/** A closed environment: only what git needs to run, nothing from the operator's shell. */
export function fixtureGitEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: process.env.HOME ?? "/tmp",
    LANG: "C",
    LC_ALL: "C",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Fixture Author",
    GIT_AUTHOR_EMAIL: "author@example.test",
    GIT_COMMITTER_NAME: "Fixture Committer",
    GIT_COMMITTER_EMAIL: "committer@example.test",
    GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
    GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
    GIT_ALLOW_PROTOCOL: "file",
  };
}

/** Pin both commit dates to one instant, for a fixture whose dates must differ. */
export function fixtureDate(date: string): NodeJS.ProcessEnv {
  return { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
}

export async function fixtureGit(
  cwd: string,
  args: readonly string[],
  input?: Buffer | string,
  env: NodeJS.ProcessEnv = {},
): Promise<string> {
  const child = exec("git", ["-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args], {
    cwd,
    env: { ...fixtureGitEnvironment(), ...env },
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (input !== undefined) {
    child.child.stdin?.end(input);
  }
  const { stdout } = await child;
  return (stdout as Buffer).toString("utf8").trim();
}

/** Write (string or bytes) or delete (null) files, stage everything, and commit. */
export async function commitFiles(
  repository: string,
  files: Readonly<Record<string, string | Uint8Array | null>>,
  message: string,
  options: { readonly allowEmpty?: boolean; readonly date?: string } = {},
): Promise<string> {
  for (const [path, contents] of Object.entries(files)) {
    const target = join(repository, path);
    if (contents === null) {
      await rm(target, { force: true });
      continue;
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
  await fixtureGit(repository, ["add", "-A"]);
  await fixtureGit(
    repository,
    ["commit", "-q", ...(options.allowEmpty ? ["--allow-empty"] : []), "-m", message],
    undefined,
    options.date === undefined ? {} : fixtureDate(options.date),
  );
  return fixtureGit(repository, ["rev-parse", "HEAD"]);
}

/** A fresh repository on branch `main` with one root commit, SHA-1 unless asked otherwise. */
export async function initChangeRepository(
  root: string,
  files: Readonly<Record<string, string | Uint8Array | null>> = { "README.md": "# Fixture\n" },
  options: { readonly objectFormat?: "sha1" | "sha256" } = {},
): Promise<{ repository: string; root: string }> {
  const repository = join(root, "repository");
  await mkdir(repository, { recursive: true });
  await fixtureGit(repository, [
    "init",
    "-q",
    "-b",
    "main",
    ...(options.objectFormat ? [`--object-format=${options.objectFormat}`] : []),
  ]);
  await commitFiles(repository, files, "root commit");
  return { repository, root };
}

/**
 * Rewrite one loose object with different, well-formed bytes under the same
 * id: corruption git does not detect on its own for interior objects.
 */
export async function rewriteLooseObject(
  repository: string,
  id: string,
  rewrite: (body: Buffer) => Buffer,
): Promise<void> {
  const path = join(repository, ".git", "objects", id.slice(0, 2), id.slice(2));
  const raw = inflateSync(await readFile(path));
  const type = raw.subarray(0, raw.indexOf(0x20)).toString("latin1");
  const body = rewrite(raw.subarray(raw.indexOf(0) + 1));
  await chmod(path, 0o644);
  await writeFile(
    path,
    deflateSync(Buffer.concat([Buffer.from(`${type} ${body.length}\0`, "latin1"), body])),
  );
}

/**
 * The golden-record repository: fixed content, names and dates, SHA-1, so
 * every object id is the same on every host. `main` and `feature` diverge
 * from the root commit, tagged `root`, and `feature` carries an edit, a
 * rename, a binary file and an executable file.
 */
export async function buildGoldenRepository(root: string): Promise<string> {
  const { repository } = await initChangeRepository(root, {
    "README.md": "# Golden\n",
    "docs/guide.md": "one\ntwo\nthree\n",
    "docs/old-name.md": "a page that moves\n",
  });
  await fixtureGit(repository, ["tag", "root"]);
  await commitFiles(repository, { "notes.md": "main-only notes\n" }, "main: add notes");
  await fixtureGit(repository, ["checkout", "-q", "-b", "feature", "root"]);
  await commitFiles(
    repository,
    {
      "docs/guide.md": "one\nTWO\nthree\n",
      "docs/old-name.md": null,
      "docs/new-name.md": "a page that moves\n",
      "assets/blob.bin": new Uint8Array([0, 1, 2, 255, 0]),
    },
    "feature: edit, rename and add a binary",
  );
  await writeFile(join(repository, "run.sh"), "#!/bin/sh\necho run\n");
  await fixtureGit(repository, ["add", "run.sh"]);
  await fixtureGit(repository, ["update-index", "--chmod=+x", "run.sh"]);
  await fixtureGit(repository, ["commit", "-q", "-m", "feature: add an executable"]);
  return repository;
}

/**
 * Append `count` plain commits to `main` in one fast-import, each adding its
 * own file of `lines` numbered lines: a long first-parent line, fast.
 */
export async function appendPlainCommits(
  repository: string,
  count: number,
  lines: number,
): Promise<void> {
  const tip = await fixtureGit(repository, ["rev-parse", "HEAD"]);
  const branch = await fixtureGit(repository, ["symbolic-ref", "HEAD"]);
  const stream: string[] = [];
  for (let unit = 1; unit <= count; unit += 1) {
    const message = `unit ${unit}: document change ${unit}`;
    const content = Array.from(
      { length: lines },
      (_, line) => `unit ${unit} line ${line + 1}`,
    ).join("\n");
    stream.push(
      `commit ${branch}`,
      "committer Fixture Committer <committer@example.test> 1767225600 +0000",
      `data ${Buffer.byteLength(message)}`,
      message,
      ...(unit === 1 ? [`from ${tip}`] : []),
      `M 100644 inline docs/unit-${unit}.md`,
      `data ${Buffer.byteLength(content)}`,
      content,
      "",
    );
  }
  await fixtureGit(repository, ["fast-import", "--quiet"], `${stream.join("\n")}\n`);
  await fixtureGit(repository, ["reset", "-q", "--hard", branch]);
}

/**
 * Append `count` merge units to `main` in one fast-import, shaped like a
 * squash-free merge-request release: each unit merges a branch of one commit
 * that changes `files` files of `lines` numbered lines, and both carry
 * merge-request-length subjects.
 */
export async function appendMergeUnits(
  repository: string,
  count: number,
  files: number,
  lines: number,
): Promise<void> {
  const tip = await fixtureGit(repository, ["rev-parse", "HEAD"]);
  const branch = await fixtureGit(repository, ["symbolic-ref", "HEAD"]);
  const stream: string[] = [];
  const data = (text: string) => [`data ${Buffer.byteLength(text)}`, text];
  for (let unit = 1; unit <= count; unit += 1) {
    const changes = Array.from({ length: files }, (_, file) => {
      const content = Array.from(
        { length: lines },
        (_, line) => `unit ${unit} file ${file + 1} line ${line + 1}`,
      ).join("\n");
      return [`M 100644 inline src/unit-${unit}/module-${file + 1}.ts`, ...data(content)];
    }).flat();
    const committer = "committer Fixture Committer <committer@example.test> 1767225600 +0000";
    stream.push(
      `commit refs/heads/unit-${unit}`,
      `mark :${unit}`,
      committer,
      ...data(`feat(runtime): change the unit ${unit} modules for the release fixture`),
      unit === 1 ? `from ${tip}` : `from ${branch}^0`,
      ...changes,
      "",
      `commit ${branch}`,
      committer,
      ...data(`Merge branch 'agent/unit-${unit}-release-fixture' into 'main'`),
      ...(unit === 1 ? [`from ${tip}`] : []),
      `merge :${unit}`,
      ...changes,
      "",
    );
  }
  await fixtureGit(repository, ["fast-import", "--quiet"], `${stream.join("\n")}\n`);
  await fixtureGit(repository, ["reset", "-q", "--hard", branch]);
}
