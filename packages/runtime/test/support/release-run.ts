// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * A tagged two-unit release and a writing run over it, for the suites that
 * read what a release run persists. The record is the file the run store
 * wrote, so a suite citing it reads the writer's bytes, not a hand-built twin.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "vitest";

import { executeRunRequest } from "../../src/cli/run-request.js";
import { parseRunArguments } from "../../src/cli/run-arguments.js";
import { sourceReadBudgetForModel } from "../../src/cli/run/source-acquisition.js";
import { runtimeConfig } from "./execution-convergence.js";
import {
  createSourceFixture,
  HTML_SOURCE_PATH,
  runRequest,
  skillResolver,
  SourceToolHarness,
  type SourceFixture,
} from "./source-acquisition-cli.js";
import { commitFiles, fixtureGit } from "./change-source-fixture.js";

export interface ReleaseFixture {
  readonly fixture: SourceFixture;
  /** The commit `v1.0` tags. */
  readonly base: string;
  /** The first unit: a plain commit. */
  readonly plain: string;
  /** The second unit, which `v1.1` tags: a merge whose side adds two files. */
  readonly merge: string;
}

/** The caller removes `fixture.root`. */
export async function createReleaseFixture(): Promise<ReleaseFixture> {
  const fixture = await createSourceFixture();
  const { repository } = fixture;
  const base = await fixtureGit(repository, ["rev-parse", "HEAD"]);
  await fixtureGit(repository, ["tag", "-a", "v1.0", "-m", "release v1.0"]);
  const plain = await commitFiles(
    repository,
    { "src/export.ts": "export const requiresOutputPath = true;\n" },
    "Require an explicit export path",
  );
  await fixtureGit(repository, ["checkout", "-q", "-b", "feature"]);
  await commitFiles(
    repository,
    {
      "src/import.ts": "export const importFormats = ['csv'];\n",
      "src/import-notes.md": "CSV import reads the first sheet only.\n",
    },
    "Add CSV import",
  );
  await fixtureGit(repository, ["checkout", "-q", "-"]);
  await fixtureGit(repository, [
    "merge",
    "-q",
    "--no-ff",
    "-m",
    "Merge branch 'feature'",
    "feature",
  ]);
  const merge = await fixtureGit(repository, ["rev-parse", "HEAD"]);
  await fixtureGit(repository, ["tag", "-a", "v1.1", "-m", "release v1.1"]);
  return { fixture, base, plain, merge };
}

/** A writing run of `--change <selector>`; the model reads every observation whole. */
export async function runReleaseRecord(
  fixture: SourceFixture,
  selector: string,
): Promise<{ model: SourceToolHarness; saved: Record<string, unknown> }> {
  const parsed = parseRunArguments([
    "create-documentation",
    "--repo",
    fixture.repository,
    "--instruction",
    runRequest(fixture).instruction,
    "--allow-write",
    "--patch-only",
    "--change",
    selector,
  ]);
  const model = new SourceToolHarness({
    readOnSkill: "plan-documentation",
    planSourcePaths: [HTML_SOURCE_PATH],
    readWindowMaxBytes: sourceReadBudgetForModel(undefined).budgetBytes,
  });
  const record = await executeRunRequest(
    { ...parsed, quiet: true },
    runtimeConfig(fixture.stateDirectory),
    { silent: true, executionHarness: model, skillResolver },
  );
  expect(record?.status).toBe("succeeded");
  const saved = JSON.parse(
    await readFile(join(fixture.stateDirectory, `${record!.id}.json`), "utf8"),
  ) as Record<string, unknown>;
  return { model, saved };
}
