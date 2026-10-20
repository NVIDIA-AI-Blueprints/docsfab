// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { readGitlabCiConfig } from "./helpers/gitlab-ci.js";
import { internalOnly } from "./helpers/internal-path.js";
import { temporaryRoots } from "./helpers/temp.js";
import { installedVersionIdentity } from "../scripts/clean-install-acceptance.mjs";

const roots = temporaryRoots();
const ciPipeline = internalOnly(
  ".gitlab/ci/runtime.yml",
  "it pins the GitLab CI job, which is not exported",
);

// The clean-install offline acceptance harness is a heavy, network-free gate
// with its own npm script and CI job; this asserts it stays wired and that
// packing is composed, never re-implemented.
describe("clean-install offline acceptance wiring", () => {
  it("requires the installed stamp when checking the displayed version", async () => {
    const root = await roots.create("docsfab-installed-version-");
    await mkdir(join(root, "dist"), { recursive: true });
    const commit = "a".repeat(40);
    const stamp = async (identity: object) => {
      const { releaseTag, ...buildIdentity } = identity as { releaseTag?: string | null };
      await writeFile(
        join(root, "dist", "build-identity.js"),
        `export const DOCSFAB_BUILD_IDENTITY = Object.freeze(${JSON.stringify({ schemaVersion: 1, ...buildIdentity })});\n`,
      );
      await writeFile(
        join(root, "dist", "release-identity.js"),
        `export const DOCSFAB_RELEASE_IDENTITY = Object.freeze(${JSON.stringify({ releaseTag: releaseTag ?? null })});\n`,
      );
    };
    await stamp({ commit, dirty: false, releaseTag: "v0.0.1-rc.7" });
    expect(await installedVersionIdentity(root, "0.0.1")).toBe("0.0.1-rc.7\n");
    await stamp({ commit, dirty: true, releaseTag: "v0.0.1-rc.7" });
    expect(await installedVersionIdentity(root, "0.0.1")).toBe(`0.0.1-dev+${commit}.dirty\n`);
    expect(await installedVersionIdentity(root, "0.0.1-main.abc12345")).toBe(
      "0.0.1-main.abc12345.dirty\n",
    );
    await stamp({ commit: null, dirty: null, releaseTag: null });
    expect(await installedVersionIdentity(root, "0.0.1")).toBe("0.0.1+unknown\n");
  });
  it.skipIf(ciPipeline.skip)(
    ciPipeline.title("exposes one npm script and one offline CI job"),
    async () => {
      const [packageJson, config] = await Promise.all([
        readFile(resolve("package.json"), "utf8"),
        readGitlabCiConfig(resolve("..", "..")),
      ]);
      const scripts = (JSON.parse(packageJson) as { scripts: Record<string, string> }).scripts;
      expect(scripts["acceptance:clean-install"]).toBe("node scripts/clean-install-acceptance.mjs");
      // Parse the actual job: a preceding draft rule must not obscure its
      // unprivileged offline template or the command it runs.
      expect(config.definitions["runtime:acceptance:clean-install"]).toMatchObject({
        extends: expect.arrayContaining([".runtime_downstream", ".rules:runtime-heavy"]),
        script: expect.arrayContaining([
          expect.stringContaining("npm run acceptance:clean-install"),
        ]),
      });
    },
  );

  it("composes shared packing rather than re-implementing it", async () => {
    const [harness, verifyPacked, sharedLib] = await Promise.all([
      readFile(resolve("scripts/clean-install-acceptance.mjs"), "utf8"),
      readFile(resolve("scripts/verify-packed-cli.mjs"), "utf8"),
      readFile(resolve("scripts/lib/packed-cli.mjs"), "utf8"),
    ]);
    expect(sharedLib).toContain("export async function packDocsFab");
    expect(sharedLib).toContain("export async function preparePackedCandidate");
    expect(sharedLib).toContain("export function parseNpmPackJson");
    expect(sharedLib).toContain("export async function installPackedDocsFab");
    for (const consumer of [harness, verifyPacked]) {
      expect(consumer).toContain("./lib/packed-cli.mjs");
      expect(consumer).toContain("installPackedDocsFab");
      // Neither consumer runs its own `npm pack`/`npm install` invocation.
      expect(consumer).not.toMatch(/"pack",\s*\n\s*"--json"/);
    }
    expect(harness).toContain("preparePackedCandidate");
    expect(verifyPacked).toContain("packDocsFab");
  });

  it("drives the installed executable through the whole offline journey", async () => {
    const harness = await readFile(resolve("scripts/clean-install-acceptance.mjs"), "utf8");
    for (const step of ['"test", "--json"', '"init"', '"auto", "--dry-run"', '"auto", "--once"']) {
      expect(harness).toContain(step);
    }
    // The product run — not the environment-setup install — is what must be
    // offline: PI_OFFLINE is pinned and the trusted roadmap host is removed.
    expect(harness).toContain('PI_OFFLINE: "1"');
    expect(harness).toContain("delete cliEnvironment.DOCSFAB_ROADMAP_GITLAB_HOST");
  });
});

// A clean install starts from the exported tree, which lacks internal-only paths.
describe("internal-only path skips", () => {
  async function tree(options: { internal: boolean }): Promise<string> {
    const root = await roots.create("docsfab-internal-path-");
    await mkdir(join(root, "packages/runtime"), { recursive: true });
    await writeFile(join(root, "packages/runtime/package.json"), "{}\n");
    // The GitLab pipeline file, spelled out so a renamed marker cannot pass.
    if (options.internal) await writeFile(join(root, ".gitlab-ci.yml"), "stages: []\n");
    return root;
  }

  it("skips in an exported tree only when a declared path is absent, and names it in the title", async () => {
    const root = await tree({ internal: false });
    const gate = internalOnly(
      [".gitlab/ci/runtime.yml", "packages/runtime/package.json"],
      "it pins CI",
      root,
    );
    expect(gate.skip).toBe(true);
    expect(gate.reason).toBe(
      "internal-only, skipped: .gitlab/ci/runtime.yml absent from the exported tree; it pins CI",
    );
    expect(gate.title("wires the job")).toBe(
      "wires the job [internal-only, skipped: .gitlab/ci/runtime.yml absent from the exported tree; it pins CI]",
    );
  });

  it("runs unchanged in an exported tree when every declared path is present", async () => {
    const root = await tree({ internal: false });
    const gate = internalOnly("packages/runtime/package.json", "it pins CI", root);
    expect(gate).toMatchObject({ skip: false, reason: undefined });
    expect(gate.title("wires the job")).toBe("wires the job");
  });

  it("never skips in the internal tree, even when a declared path is missing", async () => {
    const root = await tree({ internal: true });
    const gate = internalOnly(".gitlab/ci/runtime.yml", "it pins CI", root);
    expect(gate).toMatchObject({ skip: false, reason: undefined });
    expect(gate.title("wires the job")).toBe("wires the job");
  });

  it("fails on a path that is blocked rather than missing", async () => {
    const root = await tree({ internal: false });
    await writeFile(join(root, "deploy"), "a file where a directory belongs\n");
    expect(() => internalOnly("deploy/agent/Dockerfile", "it pins the image", root)).toThrow(
      expect.objectContaining({ code: "ENOTDIR" }),
    );
  });

  it("refuses a path outside the repository or a missing reason", () => {
    expect(() => internalOnly("../outside", "reason")).toThrow(
      'internalOnly path must be repository-relative: "../outside".',
    );
    expect(() => internalOnly("/etc/hosts", "reason")).toThrow(
      'internalOnly path must be repository-relative: "/etc/hosts".',
    );
    expect(() => internalOnly([], "reason")).toThrow(
      "internalOnly needs at least one repository path and a reason.",
    );
    expect(() => internalOnly("deploy", " ")).toThrow(
      "internalOnly needs at least one repository path and a reason.",
    );
  });

  it("resolves the default root to the repository that holds this package", () => {
    const gate = internalOnly("packages/runtime/test/helpers/internal-path.ts", "it is shipped");
    expect(gate).toMatchObject({ skip: false, reason: undefined });
  });
});
