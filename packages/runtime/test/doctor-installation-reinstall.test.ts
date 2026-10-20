// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { readyDoctorFixture } from "./helpers/doctor-ready-fixture.js";
import { expectTarballReinstall } from "./helpers/reinstall-instruction.js";
import { temporaryRoots } from "./helpers/temp.js";

/** The package root doctor checks for the installed assets; the test points it at an empty one. */
const installation = vi.hoisted(() => ({ root: "" }));

vi.mock("../src/config/host-paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/config/host-paths.js")>();
  return { ...actual, resolveDocsFabProjectRoot: () => installation.root };
});

import { inspectDoctorReadiness } from "../src/doctor-readiness.js";
import { reinstallAction } from "../src/quality-pack/restore.js";

const roots = temporaryRoots();

describe("doctor's missing-assets diagnostic", () => {
  it("prints the same tarball reinstall step as every other installation failure", async () => {
    const fixture = await readyDoctorFixture(roots);
    // No lock file exists under this root, as in a package whose assets were deleted.
    installation.root = await roots.create("docsfab-no-installed-assets-");
    const result = await inspectDoctorReadiness({
      ...fixture.options,
      loadConfiguration: () => fixture.config,
      validateConfiguration: async () => undefined,
    });

    const diagnostic = result.diagnostics.find((item) => item.code === "installation-invalid");
    expect(diagnostic).toEqual({
      area: "installation",
      code: "installation-invalid",
      explanation: "The installed package is missing its immutable governed assets.",
      nextCommand: reinstallAction(),
    });
    expectTarballReinstall(diagnostic?.nextCommand ?? "");
  });
});
