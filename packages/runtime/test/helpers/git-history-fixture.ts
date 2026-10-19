// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Local fixture repositories for the git history tools: built with the system
 * git in a temporary directory the caller's `temporaryRoots()` removes, never
 * touching the network or the operator's configuration. Also the confined tool
 * set the tool tests drive, and a git runner that tries a lazy fetch.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { createConfinedToolSet } from "../../src/harness/confined-tools.js";
import { MAX_GIT_OUTPUT_BYTES, TrustedGitError } from "../../src/host-invoker/trusted-git.js";
import { GitHistoryReader, type GitRunner } from "../../src/repository/git-history.js";
import type { TemporaryRoots } from "./temp.js";

const exec = promisify(execFile);

/** A closed environment: no global or system config, a fixed identity and clock. */
export const FIXTURE_GIT_ENVIRONMENT: NodeJS.ProcessEnv = {
  PATH: "/usr/bin:/bin",
  HOME: "/var/empty/docsfab-fixture",
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Fixture Author",
  GIT_AUTHOR_EMAIL: "author@example.invalid",
  GIT_COMMITTER_NAME: "Fixture Committer",
  GIT_COMMITTER_EMAIL: "committer@example.invalid",
  GIT_AUTHOR_DATE: "2026-10-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2026-10-01T00:00:00Z",
  GIT_ALLOW_PROTOCOL: "file",
};

/** Fixture output is small; the buffer only needs to hold a large-blob listing. */
const FIXTURE_GIT_MAX_BUFFER = 64 * 1024 * 1024;

export async function fixtureGit(
  cwd: string,
  args: readonly string[],
  input?: string,
): Promise<string> {
  if (input === undefined) {
    const { stdout } = await exec("/usr/bin/git", [...args], {
      cwd,
      env: FIXTURE_GIT_ENVIRONMENT,
      maxBuffer: FIXTURE_GIT_MAX_BUFFER,
    });
    return stdout.trim();
  }
  return new Promise((resolve, reject) => {
    const child = execFile(
      "/usr/bin/git",
      [...args],
      { cwd, env: FIXTURE_GIT_ENVIRONMENT, maxBuffer: FIXTURE_GIT_MAX_BUFFER },
      (error, stdout) => (error ? reject(error) : resolve(stdout.trim())),
    );
    child.stdin?.end(input);
  });
}

export async function writeFiles(root: string, files: Record<string, string | Buffer>) {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
}

/** Write the files, stage everything, commit, and return the new commit id. */
export async function commitFiles(
  repository: string,
  files: Record<string, string | Buffer>,
  message: string,
): Promise<string> {
  await writeFiles(repository, files);
  await fixtureGit(repository, ["add", "-A"]);
  await fixtureGit(repository, ["commit", "--quiet", "--allow-empty", "-m", message]);
  return fixtureGit(repository, ["rev-parse", "HEAD"]);
}

export interface HistoryFixture {
  readonly root: string;
  readonly repository: string;
  /** Oldest first: base, then head. */
  readonly base: string;
  readonly head: string;
}

export const BASE_APP = "export const answer = 1;\n";
export const HEAD_APP = "export const answer = 2;\n";

/** Two commits: the base and a head that changes code, a doc and a credential path. */
export async function historyFixture(roots: TemporaryRoots): Promise<HistoryFixture> {
  const root = await roots.create("docsfab-history-", { realpath: true });
  const repository = join(root, "repository");
  await mkdir(repository);
  await fixtureGit(repository, ["init", "--quiet", "--initial-branch=main"]);
  const base = await commitFiles(
    repository,
    { "src/app.ts": BASE_APP, "docs/guide.md": "# Guide\n\nThe answer is one.\n" },
    "Start the app",
  );
  const head = await commitFiles(
    repository,
    {
      "src/app.ts": HEAD_APP,
      "docs/guide.md": "# Guide\n\nThe answer is two.\n",
      ".env": "LOG_LEVEL=debug\n",
    },
    "Change the answer",
  );
  return { root, repository, base, head };
}

/** `git clone` of a fixture with extra arguments, such as `--depth=1`. */
export async function cloneFixture(
  fixture: HistoryFixture,
  name: string,
  args: readonly string[],
): Promise<string> {
  const target = join(fixture.root, name);
  // A local upload-pack ignores `--filter` unless the source allows it.
  if (args.some((arg) => arg.startsWith("--filter="))) {
    await fixtureGit(fixture.repository, ["config", "uploadpack.allowFilter", "true"]);
  }
  await fixtureGit(fixture.root, [
    "clone",
    "--quiet",
    "--no-local",
    ...args,
    `file://${fixture.repository}`,
    target,
  ]);
  return target;
}

/** The confined tool set the planner and writer get, over a history reader for `repository` at `head`. */
export interface ToolPage {
  readonly kind: string;
  readonly labels: string[];
  readonly nextCursor: string | null;
  readonly [key: string]: unknown;
}

export async function historyTools(
  repository: string,
  head: string,
  options: {
    git?: GitRunner;
    environment?: NodeJS.ProcessEnv;
    toolOutputCapBytes?: number;
  } = {},
) {
  const workspace = join(repository, "..", "workspace-export");
  await mkdir(workspace, { recursive: true });
  const toolSet = await createConfinedToolSet({
    workspacePath: workspace,
    allowWrite: false,
    historyReader: new GitHistoryReader({
      sourcePath: repository,
      headRevision: head,
      ...(options.git ? { git: options.git } : {}),
    }),
    ...(options.toolOutputCapBytes ? { toolOutputCapBytes: options.toolOutputCapBytes } : {}),
    ...(options.environment ? { limits: { environment: options.environment } } : {}),
  });
  const tools = new Map(toolSet.definitions.map((tool) => [tool.name, tool]));
  const raw = async (name: string, parameters: Record<string, unknown>) => {
    const tool = tools.get(name);
    if (!tool) throw new Error(`The tool set does not register ${name}.`);
    return tool.execute(`call-${name}`, parameters, undefined, undefined, undefined as never);
  };
  const text = async (name: string, parameters: Record<string, unknown>) => {
    const result = await raw(name, parameters);
    return (result.content as Array<{ type: string; text: string }>)[0]!.text;
  };
  const call = async (name: string, parameters: Record<string, unknown>) =>
    JSON.parse(await text(name, parameters)) as ToolPage;
  const refusal = async (name: string, parameters: Record<string, unknown>) => {
    try {
      await raw(name, parameters);
    } catch (error) {
      return (error as Error).message;
    }
    throw new Error(`Expected ${name} to refuse.`);
  };
  const categories = () =>
    Object.fromEntries(
      toolSet.getFailureCategories().map((entry) => [entry.category, entry.count]),
    );
  return { toolSet, raw, text, call, refusal, categories };
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** The code a refusal names, read from its fixed prefix. */
export function refusalCode(message: string): string {
  const match = /^DocsFab refused this history read: ([a-z-]+)\./u.exec(message);
  if (match) return match[1]!;
  const bound = /^([a-z-]+-bound): /u.exec(message);
  return bound ? bound[1]! : message;
}

/**
 * A git that ignores GIT_NO_LAZY_FETCH, as git before 2.45 does, under the
 * same closed protocol policy: a lazy fetch is attempted and blocked. Each
 * call that starts a fetch is noted.
 */
export function lazyFetchingGit(attempts: string[][]): GitRunner {
  return (cwd, args, _maximumBytes, input) =>
    new Promise<Buffer>((resolve, reject) => {
      const child = execFile(
        "/usr/bin/git",
        ["-c", "protocol.allow=never", "-c", "core.hooksPath=/dev/null", ...args],
        {
          cwd,
          env: { ...FIXTURE_GIT_ENVIRONMENT, GIT_ALLOW_PROTOCOL: "", GIT_TRACE: "1" },
          encoding: "buffer",
          maxBuffer: MAX_GIT_OUTPUT_BYTES,
        },
        (error, stdout, stderr) => {
          // GIT_TRACE names each child git runs; a lazy fetch is a `fetch` child.
          const trace = stderr.toString("utf8").split("\n");
          if (trace.some((line) => line.includes("run_command:") && line.includes(" fetch "))) {
            attempts.push([...args]);
          }
          if (!error) return resolve(stdout);
          const code = typeof error.code === "number" ? error.code : null;
          reject(new TrustedGitError("exit", "Fixture git exited.", code));
        },
      );
      if (input) child.stdin?.end(input);
      else child.stdin?.end();
    });
}
