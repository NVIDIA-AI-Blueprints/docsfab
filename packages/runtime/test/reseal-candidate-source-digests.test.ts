// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(runtimeRoot, "..", "..");
const scriptPath = resolve(runtimeRoot, "scripts/reseal-candidate-source-digests.mts");
const outputs = [
  "packages/runtime/model-compositions/candidate-projections.json",
  "packages/runtime/model-compositions/installed-manifest.json",
  "packages/runtime/src/model-composition/installed-manifest-pin.js",
] as const;

function copy(root: string, relativePath: string): void {
  const destination = resolve(root, relativePath);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(resolve(repositoryRoot, relativePath), destination);
}

describe("candidate source digest reseal", () => {
  it("validates every downstream input before replacing any output", () => {
    const root = mkdtempSync(join(tmpdir(), "docsfab-reseal-candidates-"));
    try {
      for (const output of outputs) copy(root, output);
      const projections = JSON.parse(readFileSync(resolve(root, outputs[0]), "utf8")) as {
        candidates: Array<{ source: { locator: string } }>;
      };
      for (const candidate of projections.candidates) copy(root, candidate.source.locator);
      appendFileSync(resolve(root, projections.candidates[0]!.source.locator), "\n");
      writeFileSync(resolve(root, outputs[1]), "{ malformed\n");
      const before = outputs.map((output) => readFileSync(resolve(root, output)));

      const result = spawnSync(
        process.execPath,
        ["--import", "tsx", scriptPath, "--repository-root", root],
        { cwd: runtimeRoot, encoding: "utf8" },
      );

      expect(result.status).not.toBe(0);
      for (const [index, output] of outputs.entries()) {
        expect(readFileSync(resolve(root, output))).toEqual(before[index]);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
