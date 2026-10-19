// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { jobNames, keysDeclaredIn, readGitlabCiConfig } from "./helpers/gitlab-ci.js";
import { internalOnly } from "./helpers/internal-path.js";
import { temporaryRoots } from "./helpers/temp.js";

const roots = temporaryRoots();
const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const gitlabCi = internalOnly(
  ".gitlab/ci",
  "it reads the GitLab CI definition, which is not exported",
);

async function fixture(files: Record<string, string>): Promise<string> {
  const root = await roots.create("docsfab-gitlab-ci-");
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), contents);
  }
  return root;
}

describe("readGitlabCiConfig", () => {
  it("deep-merges a job overlaid across includes: hashes merge, arrays and scalars replace", async () => {
    const root = await fixture({
      ".gitlab-ci.yml": [
        "include:",
        "  - local: ci/base.yml",
        "  - local: /ci/overlay.yml",
        "stages: [verify]",
        "",
      ].join("\n"),
      "ci/base.yml": [
        "job:",
        "  stage: verify",
        "  script: [make]",
        "  rules:",
        "    - if: $CI_COMMIT_TAG",
        "  variables: { KEPT: base, REPLACED: base }",
        "  artifacts: { when: always, paths: [out/] }",
        "",
      ].join("\n"),
      "ci/overlay.yml": [
        "job:",
        "  stage: publish",
        "  needs: [other]",
        "  variables: { REPLACED: overlay, ADDED: overlay }",
        "  artifacts: { paths: [dist/] }",
        "",
      ].join("\n"),
    });
    const config = await readGitlabCiConfig(root);
    expect(config.definitions.job).toEqual({
      stage: "publish",
      script: ["make"],
      rules: [{ if: "$CI_COMMIT_TAG" }],
      needs: ["other"],
      variables: { KEPT: "base", REPLACED: "overlay", ADDED: "overlay" },
      artifacts: { when: "always", paths: ["dist/"] },
    });
    expect(keysDeclaredIn(config, "ci/base.yml")).toEqual(["job"]);
    expect(keysDeclaredIn(config, "ci/overlay.yml")).toEqual(["job"]);
  });

  it("merges .gitlab-ci.yml last, so its own keys win over every include", async () => {
    const root = await fixture({
      ".gitlab-ci.yml": ["include: ci/a.yml", "job:", "  variables: { V: root }", ""].join("\n"),
      "ci/a.yml": ["job:", "  script: [a]", "  variables: { V: include, W: include }", ""].join(
        "\n",
      ),
    });
    const config = await readGitlabCiConfig(root);
    expect(config.definitions.job).toEqual({
      script: ["a"],
      variables: { V: "root", W: "include" },
    });
    expect([...config.keysByFile.keys()]).toEqual(["ci/a.yml", ".gitlab-ci.yml"]);
  });

  it("names jobs apart from hidden keys and global keywords", async () => {
    const root = await fixture({
      ".gitlab-ci.yml": [
        "include: []",
        "stages: [verify]",
        "variables: { A: b }",
        "default: { image: node }",
        "workflow: { rules: [{ when: always }] }",
        ".hidden: { script: [x] }",
        "job: { script: [x] }",
        "",
      ].join("\n"),
    });
    expect(jobNames(await readGitlabCiConfig(root))).toEqual(["job"]);
  });

  it("refuses a file included twice and a path that is not a local include", async () => {
    const twice = await fixture({
      ".gitlab-ci.yml": ["include:", "  - local: a.yml", "  - a.yml", ""].join("\n"),
      "a.yml": "job: { script: [x] }\n",
    });
    await expect(readGitlabCiConfig(twice)).rejects.toThrow("a.yml is included more than once");
    const once = await fixture({
      ".gitlab-ci.yml": "include: a.yml\n",
      "a.yml": "job: { script: [x] }\n",
    });
    const config = await readGitlabCiConfig(once);
    expect(keysDeclaredIn(config, "a.yml")).toEqual(["job"]);
    expect(() => keysDeclaredIn(config, "b.yml")).toThrow(
      "b.yml is not a local include of .gitlab-ci.yml",
    );
  });
});

describe.skipIf(gitlabCi.skip)(gitlabCi.title("readGitlabCiConfig on this repository"), () => {
  it("keeps the immutable upload and serialized promotion wired through security/governance gates", async () => {
    const config = await readGitlabCiConfig(repositoryRoot);
    expect(keysDeclaredIn(config, ".gitlab/ci/runtime.yml")).toContain("runtime:package:upload");
    expect(keysDeclaredIn(config, ".gitlab/ci/runtime.yml")).toContain("runtime:package:promote");
    expect(keysDeclaredIn(config, ".gitlab/ci/blueprint-compliance.yml")).toContain(
      "runtime:package:upload",
    );
    expect(keysDeclaredIn(config, ".gitlab/ci/blueprint-compliance.yml")).toContain(
      "runtime:package:promote",
    );
    const job = config.definitions["runtime:package:upload"] as {
      rules?: { if?: string }[];
      script?: string[];
      needs?: { job: string }[];
    };
    expect(job.rules?.[0]?.if).toMatch(/\$CI_COMMIT_TAG =~/u);
    expect(job.script).toContain("node scripts/publish-package.mjs upload package-artifacts");
    expect(job.needs?.map((need) => need.job)).toEqual([
      "runtime:package:verify",
      "secret_detection",
      "semgrep-sast",
      "gemnasium-dependency_scanning",
      "gemnasium-python-dependency_scanning",
      "blueprint:governance",
      "blueprint:inventory",
    ]);
    const promotion = config.definitions["runtime:package:promote"] as {
      needs?: { job: string }[];
      resource_group?: string;
      script?: string[];
    };
    expect(promotion.needs?.map((need) => need.job)).toEqual([
      "runtime:package:upload",
      "secret_detection",
      "semgrep-sast",
      "gemnasium-dependency_scanning",
      "gemnasium-python-dependency_scanning",
      "blueprint:governance",
      "blueprint:inventory",
    ]);
    expect(promotion.resource_group).toBe("docsfab-package-publication");
    expect(promotion.script).toContain(
      "node scripts/publish-package.mjs promote package-artifacts",
    );
  });
});
