// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CI jobs that read the build-generated skill crate, quality staging and
 * quality pack from a checkout must generate them first, and the jobs gated on
 * those trees must also trigger on the sources they are generated from.
 */
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import { DERIVED_PRODUCT_BY_ID } from "../scripts/derived-products.mjs";
import { ENSURE_DERIVED_STEPS } from "../scripts/ensure-derived.mjs";
import { matchesCiPath } from "./helpers/gitlab-ci.js";
import { internalOnly } from "./helpers/internal-path.js";

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(runtimeRoot, "../..");
const gitlabCi = internalOnly(
  ".gitlab/ci",
  "it pins the GitLab CI definition, which is not exported",
);

const TREE_PRODUCTS = ["skill-crate", "quality-pack"] as const;
const HOOK = 'bash "$CI_PROJECT_DIR/.gitlab/ci/runtime-run.sh" node scripts/ensure-derived.mjs';

type CiJob = {
  script?: string[];
  rules?: Array<{ changes?: { paths?: string[] } }>;
};

async function readCiFile(path: string): Promise<Record<string, CiJob>> {
  return parseYaml(await readFile(resolve(repositoryRoot, path), "utf8")) as Record<string, CiJob>;
}

/** Index of the one script line that mentions `needle`; fails on none or several. */
function onlyLine(script: readonly string[], needle: string): number {
  const matches = script.flatMap((line, index) => (line.includes(needle) ? [index] : []));
  expect(matches, `script lines naming ${needle}`).toHaveLength(1);
  return matches[0];
}

/**
 * Paths a product input pattern stands for: the file itself, or for a
 * directory glob one file at its top and one nested below it.
 */
function samplePaths(input: string): string[] {
  if (!input.endsWith("/**/*")) return [input];
  const directory = input.slice(0, -"/**/*".length);
  return [`${directory}/x`, `${directory}/x/y/z`];
}

describe("CI readers of the generated skill crate and quality pack", () => {
  it("the default derived step generates both tree products", () => {
    const ids = ENSURE_DERIVED_STEPS.map((step: { id: string }) => step.id);
    for (const id of TREE_PRODUCTS) expect(ids).toContain(id);
  });

  it.skipIf(gitlabCi.skip)(
    gitlabCi.title(
      "runtime:mr-assessment generates through the runner wrapper before any model step",
    ),
    async () => {
      const pipeline = await readCiFile(".gitlab/ci/runtime.yml");
      const script = (pipeline["runtime:mr-assessment"]?.script ?? []).map((line) => line.trim());
      const hook = onlyLine(script, "ensure-derived.mjs");
      // The exact command: through runtime-run.sh, which keeps MODEL_API_KEY
      // from every child but config preparation, and with the default steps.
      expect(script[hook]).toBe(HOOK);
      expect(hook).toBeGreaterThan(onlyLine(script, " npm ci"));
      expect(hook).toBeLessThan(onlyLine(script, "scripts/prepare-live-model-ci-config.ts"));
      expect(hook).toBeLessThan(onlyLine(script, "scripts/run-mr-documentation-assessment.ts"));
    },
  );

  it.skipIf(gitlabCi.skip)(
    gitlabCi.title("benchmarks:offline triggers on every source input of the trees it verifies"),
    async () => {
      const processCi = await readCiFile(".gitlab/ci/process.yml");
      const changes = (processCi[".rules:benchmarks_offline"]?.rules ?? []).flatMap(
        (rule) => rule.changes?.paths ?? [],
      );
      expect(changes.length).toBeGreaterThan(0);
      const uncovered = TREE_PRODUCTS.flatMap((id) =>
        DERIVED_PRODUCT_BY_ID[id].inputs.flatMap((input: string) =>
          samplePaths(input)
            .filter((path) => !changes.some((pattern) => matchesCiPath(path, pattern)))
            .map((path) => `${id}: ${input} (${path})`),
        ),
      );
      expect(uncovered).toEqual([]);
    },
  );

  it("an input outside every trigger pattern is reported", () => {
    // Positive control for the coverage check above: a pattern list without
    // the knowledge procedures leaves exactly those inputs uncovered.
    const patterns = ["packages/skills/**/*", "packages/runtime/**/*"];
    const knowledge = DERIVED_PRODUCT_BY_ID["skill-crate"].inputs.filter((input: string) =>
      input.startsWith("packages/knowledge/skills/"),
    );
    expect(knowledge.length).toBeGreaterThan(0);
    for (const input of DERIVED_PRODUCT_BY_ID["skill-crate"].inputs) {
      const covered = samplePaths(input).every((path) =>
        patterns.some((pattern) => matchesCiPath(path, pattern)),
      );
      expect(covered, input).toBe(!knowledge.includes(input));
    }
  });
});
