// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared "Orbit CLI" fixture for editorial runtime tests: a two-commit
 * repository whose public option changed from `--old` (base) to `--new` (head)
 * while `docs/cli.md` still documents `--old`, plus an accepted knowledge
 * snapshot and a stub runtime config under a private state directory.
 */
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { createKnowledgeAcceptedSnapshot } from "../../src/canon/from-knowledge-snapshot.js";
import type { DocsFabConfig } from "../../src/config/runtime-loader.js";
import { observeReaderTaskContextAdmissionV1 } from "../../src/execution/reader-task-admission.js";
import { validModelConfig } from "../helpers.js";

const execFile = promisify(execFileCallback);
const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export type OrbitOptionChangeFixture = {
  repository: string;
  base: string;
  head: string;
  config: DocsFabConfig;
  canonSnapshotPath: string;
};

/**
 * Builds the Orbit repository and state directory. Both directories use
 * `${prefix}-repository-` / `${prefix}-state-` and are pushed onto
 * `temporaryDirectories` so the calling test file owns their cleanup.
 * `options.files` adds tracked files to the base commit, `options.links`
 * adds tracked symbolic links (path to link target), and
 * `options.documentationRoots` sets that key in its `.docsfab.json`.
 */
export async function orbitOptionChangeRepository(
  prefix: string,
  temporaryDirectories: string[],
  options: {
    readonly files?: Readonly<Record<string, string>>;
    readonly links?: Readonly<Record<string, string>>;
    readonly documentationRoots?: readonly string[];
  } = {},
): Promise<OrbitOptionChangeFixture> {
  const repository = await temporaryDirectory(`${prefix}-repository-`, temporaryDirectories);
  await mkdir(join(repository, "docs"));
  await mkdir(join(repository, "src"));
  await writeFile(join(repository, "docs/cli.md"), "# Orbit CLI\n\nThe public option is --old.\n");
  await writeFile(join(repository, "src/orbit.ts"), "export const option = '--old';\n");
  for (const [path, text] of Object.entries(options.files ?? {})) {
    await mkdir(dirname(join(repository, path)), { recursive: true });
    await writeFile(join(repository, path), text);
  }
  for (const [path, target] of Object.entries(options.links ?? {})) {
    await mkdir(dirname(join(repository, path)), { recursive: true });
    await symlink(target, join(repository, path));
  }
  await writeFile(
    join(repository, ".docsfab.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      gitlab: { remote: "origin", defaultBranch: "main" },
      provider: { configuration: "host" },
      storage: { scope: "user-private" },
      ...(options.documentationRoots ? { documentationRoots: options.documentationRoots } : {}),
    })}\n`,
  );
  await git(repository, "init", "--quiet", "--initial-branch=main");
  await git(repository, "add", "--all");
  await git(
    repository,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "base",
  );
  const base = await git(repository, "rev-parse", "HEAD");
  await writeFile(join(repository, "src/orbit.ts"), "export const option = '--new';\n");
  await git(repository, "add", "--all");
  await git(
    repository,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "head",
  );
  const head = await git(repository, "rev-parse", "HEAD");
  await git(
    repository,
    "remote",
    "add",
    "origin",
    "ssh://git@gitlab.example.invalid/docs/orbit.git",
  );
  await git(repository, "update-ref", "refs/remotes/origin/main", head);
  const stateDirectory = await temporaryDirectory(`${prefix}-state-`, temporaryDirectories);
  const canonSnapshotPath = join(stateDirectory, "accepted-knowledge.json");
  await writeFile(
    canonSnapshotPath,
    `${JSON.stringify(
      createKnowledgeAcceptedSnapshot({
        projectId: "ORBIT",
        modelVersionId: "ORBIT-CLI-V2",
        streamVersion: 1,
        status: "approved",
        claims: [
          {
            id: "ORBIT-CLI-OPTION",
            kind: "behavior",
            scope: "docs/cli.md",
            statement: "The Orbit CLI public option changed to --new.",
            modelState: "canonical",
            evidenceIds: ["ORBIT-SOURCE"],
          },
        ],
        sources: [{ id: "ORBIT-SOURCE", locator: "src/orbit.ts" }],
        conflicts: [],
      }),
      null,
      2,
    )}\n`,
  );
  return {
    repository,
    base,
    head,
    config: stubConfig(join(stateDirectory, "runs")),
    canonSnapshotPath,
  };
}

/** Reader context for an Orbit CLI user tracking the current public option. */
export function orbitReaderContextInput() {
  return {
    schema_version: 1 as const,
    target_audience: "Orbit CLI users",
    reader_job: "use the current public option",
    change_scope: ["docs/cli.md"],
    source_priority: ["public contract", "current documentation"],
    required_content: ["the current public option"],
    excluded_content: [],
    unresolved_questions: [],
  };
}

/** Admits `src/orbit.ts` at `head` and returns its public-contract source binding. */
export async function observePublicContract(
  repository: string,
  head: string,
): Promise<{ uri: string; sha256: string }> {
  const observation = await observeReaderTaskContextAdmissionV1({
    repositoryPath: repository,
    revision: head,
    observationMode: "workflow-export",
    readerContextInput: orbitReaderContextInput(),
    sourceHints: [{ role: "public-contract", path: "src/orbit.ts" }],
  });
  const publicContract = observation.admission.sources.find(
    (source) => source.role === "public-contract",
  );
  if (!publicContract) throw new Error("fixture public contract was not admitted");
  return { uri: publicContract.uri, sha256: publicContract.sha256 };
}

function stubConfig(stateDirectory: string): DocsFabConfig {
  return {
    projectRoot: runtimeRoot,
    skillCrateDirectory: join(runtimeRoot, "skill-crate"),
    qualityDirectory: join(runtimeRoot, "quality"),
    qualityPackDirectory: join(runtimeRoot, "quality-pack"),
    stateDirectory,
    retryPolicy: {
      maxRetries: 0,
      baseDelayMs: 0,
      maxDelayMs: 0,
      retryableCategories: [],
    },
    model: validModelConfig,
  };
}

async function temporaryDirectory(prefix: string, temporaryDirectories: string[]): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(path);
  return path;
}

export async function git(repository: string, ...args: string[]): Promise<string> {
  const result = await execFile("git", args, {
    cwd: repository,
    env: {
      PATH: process.env.PATH,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    },
  });
  return result.stdout.trim();
}
