// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { inspectDoctorReadiness, reinstallAction } from "../src/doctor-readiness.js";
import { QualityPackError } from "../src/quality-pack/manifest.js";
import {
  qualityPackRestoreAction,
  reinstallAction as packageReinstallAction,
} from "../src/quality-pack/restore.js";
import { readyDoctorFixture } from "./helpers/doctor-ready-fixture.js";
import { expectTarballReinstall } from "./helpers/reinstall-instruction.js";
import { temporaryRoots } from "./helpers/temp.js";

const roots = temporaryRoots();

/** The reinstall step a packed install prints, pinned apart from the source that builds it. */
const PACKED_REINSTALL =
  "Reinstall DocsFab 9.8.7-test from its exact release tarball: run `npm i -g --ignore-scripts --engine-strict '<tarball URL>'`, as the \"Repair an Installed Package\" section of docs/manage/update-or-uninstall.md describes.";

/** A package root laid out like a packed install: a manifest, no sources. */
async function packedRoot(manifest: string | undefined): Promise<{ path: string; url: URL }> {
  const path = await roots.create("docsfab-packed-root-");
  if (manifest !== undefined) await writeFile(join(path, "package.json"), manifest);
  return { path, url: pathToFileURL(`${path}/`) };
}

describe("the quality-pack restore step", () => {
  it("regenerates a source checkout from its own sources", () => {
    expect(qualityPackRestoreAction()).toBe(
      "Regenerate the quality pack from this checkout's sources: from the repository root, run `npm --prefix packages/runtime run build`, then run the command again.",
    );
    expect(new QualityPackError("stale").nextAction).toBe(qualityPackRestoreAction());
  });

  it("reinstalls the same release from its exact tarball in a packed install", async () => {
    const root = await packedRoot(JSON.stringify({ name: "docsfab", version: "9.8.7-test" }));
    expect(qualityPackRestoreAction(root.url)).toBe(
      `${PACKED_REINSTALL} Then run the command again.`,
    );
  });

  it("never prints a registry package name as a packed install's next action", async () => {
    for (const manifest of [
      JSON.stringify({ name: "docsfab", version: "9.8.7-test" }),
      JSON.stringify({ name: "docsfab", version: "0.0.1-main.17c65c55" }),
      JSON.stringify({ name: "docsfab" }),
      "{ not a manifest",
      undefined,
    ]) {
      const root = await packedRoot(manifest);
      expectTarballReinstall(qualityPackRestoreAction(root.url));
      expectTarballReinstall(packageReinstallAction(root.url));
    }
  });

  it("needs both the source launcher and the build script to call a root a checkout", async () => {
    const root = await packedRoot(JSON.stringify({ name: "docsfab", version: "9.8.7-test" }));
    await mkdir(join(root.path, "src"));
    await writeFile(join(root.path, "src", "launcher.ts"), "");
    expect(qualityPackRestoreAction(root.url)).toContain("from its exact release tarball");
    await mkdir(join(root.path, "scripts"));
    await writeFile(join(root.path, "scripts", "build-package.mjs"), "");
    expect(qualityPackRestoreAction(root.url)).toContain("npm --prefix packages/runtime run build");
  });

  it("falls back to a reinstall that names no version when the manifest cannot be read", async () => {
    const root = await packedRoot(undefined);
    expect(qualityPackRestoreAction(root.url)).toContain(
      "Reinstall DocsFab from its exact release tarball: run `npm i -g --ignore-scripts",
    );
  });

  it("keeps doctor's reinstall step the package's own", () => {
    expect(reinstallAction()).toBe(packageReinstallAction());
    expectTarballReinstall(reinstallAction());
  });

  it("gives doctor's own installation diagnostics the same safe reinstall step", async () => {
    const fixture = await readyDoctorFixture(roots);
    const result = await inspectDoctorReadiness({
      ...fixture.options,
      loadConfiguration: () => fixture.config,
      validateConfiguration: async () => {
        throw new Error("Skill lock is unreadable.");
      },
    });
    const diagnostic = result.diagnostics.find(
      (item) => item.code === "installation-runtime-invalid",
    );
    expect(diagnostic?.nextCommand).toBe(reinstallAction());
    expectTarballReinstall(diagnostic?.nextCommand ?? "");
  });
});
