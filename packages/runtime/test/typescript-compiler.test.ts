// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { resolveTypeScriptCompiler } from "../scripts/resolve-typescript-compiler.mjs";

const exec = promisify(execFile);

describe("TypeScript compiler resolution", () => {
  it("resolves native TypeScript 7 tsc without wrapping Node", async () => {
    const compiler = resolveTypeScriptCompiler();
    expect(compiler).toContain("@typescript/native");
    const { stdout } = await exec(compiler, ["--version"]);
    expect(stdout).toMatch(/Version 7\./u);
  });
});
