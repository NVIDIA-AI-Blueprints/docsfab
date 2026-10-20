// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  readBuildIdentity,
  UNSTAMPED_BUILD_IDENTITY,
  writeBuildIdentityModule,
} from "../scripts/build-identity.mjs";
import { DOCSFAB_BUILD_IDENTITY } from "../src/build-identity.js";
import { docsfabBuildRevision } from "../src/records/run-index.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "docsfab-build-identity-")));
  roots.push(root);
  return root;
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=DocsFab Test", "-c", "user.email=docsfab@example.test", ...args],
    { cwd, encoding: "utf8" },
  ).trim();
}

function committedCheckout(): { root: string; commit: string } {
  const root = temporaryRoot();
  git(root, ["init", "--quiet"]);
  writeFileSync(join(root, "README.md"), "fixture\n");
  git(root, ["add", "README.md"]);
  git(root, ["commit", "--quiet", "-m", "fixture"]);
  return { root, commit: git(root, ["rev-parse", "HEAD"]) };
}

describe("DocsFab build identity (#1688)", () => {
  it("stamps a clean checkout's commit and marks tracked or untracked changes dirty", async () => {
    const { root, commit } = committedCheckout();
    expect(await readBuildIdentity(root)).toEqual({
      schemaVersion: 1,
      commit,
      dirty: false,
      releaseTag: null,
    });

    writeFileSync(join(root, "new-source.ts"), "export {};\n");
    expect(await readBuildIdentity(root)).toEqual({
      schemaVersion: 1,
      commit,
      dirty: true,
      releaseTag: null,
    });

    rmSync(join(root, "new-source.ts"));
    writeFileSync(join(root, "README.md"), "changed\n");
    expect(await readBuildIdentity(root)).toEqual({
      schemaVersion: 1,
      commit,
      dirty: true,
      releaseTag: null,
    });
  });

  it("selects exact release tags for the package train, including annotated tags and promotion", async () => {
    const { root, commit } = committedCheckout();
    git(root, ["tag", "v0.0.1-rc.2"]);
    git(root, ["tag", "-a", "v0.0.1-rc.7", "-m", "candidate"]);
    git(root, ["tag", "v0.0.2-rc.9"]);
    expect(await readBuildIdentity(root, { version: "0.0.1", env: {} })).toEqual({
      schemaVersion: 1,
      commit,
      dirty: false,
      releaseTag: "v0.0.1-rc.7",
    });
    git(root, ["tag", "v0.0.1"]);
    expect((await readBuildIdentity(root, { version: "0.0.1", env: {} })).releaseTag).toBe(
      "v0.0.1",
    );
    expect(
      (await readBuildIdentity(root, { version: "0.0.1", env: { CI_COMMIT_TAG: "v0.0.1-rc.2" } }))
        .releaseTag,
    ).toBe("v0.0.1-rc.2");
    expect(
      (await readBuildIdentity(root, { version: "0.0.1", env: { CI_COMMIT_TAG: "v0.0.2-rc.9" } }))
        .releaseTag,
    ).toBeNull();
    expect(
      (await readBuildIdentity(root, { version: "0.0.1-main.abc12345", env: {} })).releaseTag,
    ).toBe("v0.0.1");
  });

  it("rejects ancestor tags and dirty tags as release identity", async () => {
    const { root } = committedCheckout();
    git(root, ["tag", "v0.0.1-rc.4"]);
    writeFileSync(join(root, "README.md"), "next\n");
    git(root, ["add", "README.md"]);
    git(root, ["commit", "--quiet", "-m", "next"]);
    expect((await readBuildIdentity(root, { version: "0.0.1", env: {} })).releaseTag).toBeNull();
    expect(
      (await readBuildIdentity(root, { version: "0.0.1", env: { CI_COMMIT_TAG: "v0.0.1-rc.4" } }))
        .releaseTag,
    ).toBeNull();
    git(root, ["tag", "v0.0.1-rc.5"]);
    writeFileSync(join(root, "dirty.txt"), "dirty\n");
    expect((await readBuildIdentity(root, { version: "0.0.1", env: {} })).releaseTag).toBeNull();
  });

  it("leaves a build outside a checkout, or nested inside another repository, unstamped", async () => {
    expect(await readBuildIdentity(temporaryRoot())).toBe(UNSTAMPED_BUILD_IDENTITY);
    const { root } = committedCheckout();
    const nested = join(root, "node_modules", "docsfab");
    mkdirSync(nested, { recursive: true });
    expect(await readBuildIdentity(nested)).toBe(UNSTAMPED_BUILD_IDENTITY);
  });

  it("writes a module the run store reads back as the build's revision", async () => {
    const { root, commit } = committedCheckout();
    const output = temporaryRoot();
    await writeBuildIdentityModule(output, await readBuildIdentity(root));
    const stamped = (await import(pathToFileURL(join(output, "build-identity.js")).href)) as {
      DOCSFAB_BUILD_IDENTITY: unknown;
    };
    expect(docsfabBuildRevision(stamped.DOCSFAB_BUILD_IDENTITY)).toBe(commit);
    expect(Object.isFrozen(stamped.DOCSFAB_BUILD_IDENTITY)).toBe(true);
    expect(stamped.DOCSFAB_BUILD_IDENTITY).toEqual({ schemaVersion: 1, commit, dirty: false });
    const release = (await import(pathToFileURL(join(output, "release-identity.js")).href)) as {
      DOCSFAB_RELEASE_IDENTITY: unknown;
    };
    expect(release.DOCSFAB_RELEASE_IDENTITY).toEqual({ releaseTag: null });
  });

  it("keeps the checked-in module unstamped, so a source run records no revision", () => {
    expect(DOCSFAB_BUILD_IDENTITY).toEqual({ schemaVersion: 1, commit: null, dirty: null });
    expect(docsfabBuildRevision(DOCSFAB_BUILD_IDENTITY)).toBeNull();
  });
});
