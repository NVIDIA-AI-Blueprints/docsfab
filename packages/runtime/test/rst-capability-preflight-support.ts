// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { RunRequestWithPublishProjection } from "../src/cli/run/request.js";
import type { DocsFabConfig } from "../src/config/runtime-loader.js";
import { canonicalDigest } from "../src/content-ir/canonical.js";
import type { WorkflowTaskInput } from "../src/workflow-contracts/contracts.js";
import { prepareRunPreflight } from "../src/cli/run/preflight.js";
import { withRepositoryWorkspace } from "../src/repository/workspace/materialize.js";
import { validModelConfig } from "./helpers.js";
import { initFixtureRepo } from "./helpers/git.js";
import { temporaryRoots } from "./helpers/temp.js";

const roots = temporaryRoots();
const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const proposal = "Add the source-backed prerequisite to the existing page.";
export const digest = "a".repeat(64);

export async function fixture(
  options: {
    readonly competingRootConf?: boolean;
    readonly documentationRoots?: readonly string[] | null;
  } = {},
) {
  const base = await roots.create("docsfab-rst-capability-");
  const repositoryPath = join(base, "repository");
  const revision = await initFixtureRepo(repositoryPath, {
    "docs/guide.rst": "Guide\n=====\n\nExisting content.\n",
    "docs/other.rst": "Other\n=====\n\nExisting content.\n",
    "docs/conf.py": "project = 'Fixture'\nroot_doc = 'index'\n",
    ...(options.competingRootConf
      ? { "conf.py": "project = 'Competing fixture'\nroot_doc = 'index'\n" }
      : {}),
    "docs/index.rst": "Guide\n=====\n\n.. toctree::\n\n   guide\n   other\n",
    "src/change.md": "# Change\n",
    ".docsfab.json": `${JSON.stringify({
      schemaVersion: 1,
      gitlab: { remote: "origin", defaultBranch: "main" },
      provider: { configuration: "host" },
      storage: { scope: "user-private" },
      ...(options.documentationRoots === null
        ? {}
        : { documentationRoots: options.documentationRoots ?? ["docs"] }),
    })}\n`,
  });
  const stateDirectory = await roots.create("docsfab-rst-capability-state-");
  const config: DocsFabConfig = {
    projectRoot: runtimeRoot,
    skillCrateDirectory: join(runtimeRoot, "skill-crate"),
    qualityDirectory: join(runtimeRoot, "quality"),
    qualityPackDirectory: join(runtimeRoot, "quality-pack"),
    stateDirectory,
    retryPolicy: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0, retryableCategories: [] },
    model: validModelConfig,
  };
  return { repositoryPath, revision, config };
}

export function task(repositoryPath: string, revision: string, intendedPaths: string[]) {
  const approvedProposal = proposal;
  return {
    kind: "bounded-doc-improvement" as const,
    campaignId: "campaign",
    repositoryId: "fixture/docs",
    testedCommit: revision,
    repositoryIdentitySha256: createHash("sha256")
      .update(realpathSync(repositoryPath))
      .digest("hex"),
    contextSourcePath: "src/change.md",
    gap: { id: "gap", evidenceSha256: digest, successCriterionSha256: digest },
    analysis: {
      runId: "analysis-run",
      recordSha256: digest,
      approvedOutcomeSha256: canonicalDigest(approvedProposal),
      approvedProposal,
    },
    authorization: { sha256: digest, digest },
    intendedPaths,
  };
}

export function runRequest(
  repositoryPath: string,
  requestTask: WorkflowTaskInput | null,
  patchOnly: boolean,
  workflow: "update-documentation" | "foundation-to-patch" = "update-documentation",
): RunRequestWithPublishProjection {
  return {
    workflow,
    repositoryPath,
    revision: "HEAD",
    ...(requestTask ? { task: requestTask } : {}),
    allowWrite: true,
    patchOnly,
    releaseGate: false,
    verbose: false,
    json: false,
    showScan: false,
  };
}

export function countingInterpreter() {
  let calls = 0;
  return {
    port: {
      async call() {
        calls += 1;
        return { text: "{}", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    },
    get calls() {
      return calls;
    },
  };
}

export async function prepared(
  fixtureData: Awaited<ReturnType<typeof fixture>>,
  requestTask: WorkflowTaskInput | null,
  patchOnly: boolean,
) {
  const request = runRequest(fixtureData.repositoryPath, requestTask, patchOnly);
  return withRepositoryWorkspace(fixtureData.repositoryPath, "HEAD", (workspace) =>
    prepareRunPreflight(
      {
        request,
        config: fixtureData.config,
        options: {},
        output: { log: () => undefined, error: () => undefined },
      },
      workspace,
    ),
  );
}
