// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { loadLimitDefinitions } from "../scripts/check-limits.mjs";
import { resolveLimitDefinitions } from "../src/config/limit-resolution.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const name = "githubReview.bodyMaxBytes";
const variable = "DOCSFAB_GITHUB_REVIEW_BODY_MAX_BYTES";

async function registeredDefinitions() {
  return loadLimitDefinitions({ repoRoot: repo });
}

describe("GitHub review body policy fragment", () => {
  it("composes the fragment into the complete catalog with its internal byte policy", async () => {
    const definitions = await registeredDefinitions();
    expect(definitions.filter((entry) => entry.name === name)).toEqual([
      expect.objectContaining({
        name,
        value: 65_000,
        unit: "bytes",
        scope: "per-run",
        override: variable,
        min: 256,
        max: 131_072,
        refusal: "github-review-body-bytes-bound",
        docValue: "65,000 bytes",
        docSummary:
          "Internal byte budget for one GitHub pending-review body; native inline comments have separate transport bounds.",
      }),
    ]);
  });

  it("uses a validated host override and refuses invalid or project overrides", async () => {
    const definitions = await registeredDefinitions();
    const defaultValue = resolveLimitDefinitions(definitions, { environment: {} }).find(
      (entry) => entry.name === name,
    );
    expect(defaultValue).toMatchObject({ value: 65_000, source: "config/limits.yaml" });

    const hostValues = new Map([[name, "64000"]]);
    const effective = resolveLimitDefinitions(definitions, {
      environment: { [variable]: "66498" },
      hostValues,
    }).find((entry) => entry.name === name);
    expect(effective).toMatchObject({ value: 66_498, source: "host" });

    for (const invalid of ["255", "131073", "1.5", "not-a-number"]) {
      expect(() =>
        resolveLimitDefinitions(definitions, { environment: { [variable]: invalid } }),
      ).toThrow(`${variable} must be an integer between 256 and 131072.`);
    }
    expect(() =>
      resolveLimitDefinitions(definitions, { projectValues: new Map([[name, 512]]) }),
    ).toThrow(`${name}: project policy may only override per-project limits.`);
  });
});
