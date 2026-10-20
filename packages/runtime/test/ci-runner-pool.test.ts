// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { readGitlabCiConfig } from "./helpers/gitlab-ci.js";
import { internalOnly } from "./helpers/internal-path.js";

// Which runner pool a job resolves to, from the merged CI definition.

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const gitlabCi = internalOnly(
  ".gitlab/ci",
  "it pins the GitLab CI definition, which is not exported",
);

type Job = { extends?: string | string[]; tags?: string[]; inherit?: unknown };

/** Tags GitLab assigns a job: its own, else the last `extends` parent's, else `default:tags`. */
function resolvedTags(definitions: Record<string, unknown>, name: string): string[] | undefined {
  const job = definitions[name] as Job | undefined;
  if (!job) throw new Error(`${name} is not in the loaded CI files`);
  if (job.inherit !== undefined)
    throw new Error(`${name} sets inherit:, which this resolver does not model`);
  if (job.tags !== undefined) return job.tags;
  const parents = job.extends === undefined ? [] : [job.extends].flat();
  for (const parent of parents.reverse()) {
    const inherited = resolvedTags(definitions, parent);
    if (inherited !== undefined) return inherited;
  }
  if (name.startsWith(".")) return undefined;
  return (definitions.default as { tags?: string[] } | undefined)?.tags;
}

describe.skipIf(gitlabCi.skip)(gitlabCi.title("CI runner pools"), () => {
  it("runs host:test only on runners tagged docsfab-ci", async () => {
    const { definitions } = await readGitlabCiConfig(repositoryRoot);
    expect(
      resolvedTags(definitions, "host:test"),
      "host:test must resolve to the docsfab-ci runner pool",
    ).toEqual(["os/linux", "type/docker", "docsfab-ci"]);
  });

  it("resolves inherited and default tags (positive control)", async () => {
    const { definitions } = await readGitlabCiConfig(repositoryRoot);
    // A host job with no tags of its own takes the pipeline default, which
    // routes general jobs to the docsfab-ci runners.
    expect(resolvedTags(definitions, "host:sssd-postgres-local-override")).toEqual([
      "os/linux",
      "type/docker",
      "docsfab-ci",
    ]);
    // A job that extends a tagged job takes the parent's tags.
    expect(resolvedTags(definitions, "host:forge-merge-recovery-postgres")).toEqual(
      resolvedTags(definitions, "host:postgres-attestation"),
    );
    expect(resolvedTags(definitions, "host:postgres-attestation")).toContain("test_job");
  });
});
