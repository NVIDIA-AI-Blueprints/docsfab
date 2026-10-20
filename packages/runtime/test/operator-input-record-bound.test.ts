// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { listOpenEditorialRuns } from "../src/inputs/operator-input-fill.js";
import { temporaryRoots } from "./helpers/temp.js";

const roots = temporaryRoots();

afterEach(() => {
  delete process.env.DOCSFAB_RUNS_RECORD_MAX_BYTES;
  vi.restoreAllMocks();
});

describe("open InputAsk lookup under runs.recordMaxBytes (#1932)", () => {
  it("checks a record at the bound and names one byte more on stderr instead of skipping it silently", async () => {
    const stateDirectory = await roots.create("docsfab-open-runs-bound-");
    process.env.DOCSFAB_RUNS_RECORD_MAX_BYTES = "8192";
    await writeFile(join(stateDirectory, "at-limit.json"), "x".repeat(8192), { mode: 0o600 });
    await writeFile(join(stateDirectory, "over-limit.json"), "x".repeat(8193), { mode: 0o600 });
    const written: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });

    await expect(listOpenEditorialRuns(stateDirectory)).resolves.toEqual([]);

    const stderr = written.join("");
    expect(stderr).toContain(
      "WARNING runs-record-max-bytes-bound: saved run over-limit was not checked for an open InputAsk. runs-record-max-bytes-bound: 8193 exceeds runs.recordMaxBytes = 8192 bytes.",
    );
    expect(stderr).not.toContain("at-limit");
  });
});
