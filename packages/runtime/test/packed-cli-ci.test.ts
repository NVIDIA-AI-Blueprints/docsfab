// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { internalOnly } from "./helpers/internal-path.js";

const ciPipeline = internalOnly(
  ".gitlab/ci/runtime.yml",
  "it pins the GitLab CI definition, which is not exported",
);

type Need = string | { job: string; artifacts?: boolean; optional?: boolean };
type Job = {
  extends?: string | string[];
  script?: string[];
  artifacts?: { when?: string; paths?: string[] };
  needs?: Need[];
  rules?: Array<{ changes?: { paths?: string[] } }>;
};

function command(job: Job, fragment: string) {
  return job.script?.find((line) => line.includes(fragment));
}

function linuxDeliveryEvidenceErrors(job: Job): string[] {
  const errors: string[] = [];
  if (job.artifacts?.when !== "always") errors.push("Linux summary is not retained on failure");
  if (!job.artifacts?.paths?.includes("packages/runtime/ci-results/2332/")) {
    errors.push("Linux delivery summary path is not retained");
  }
  return errors;
}

/**
 * The retained Linux summary makes one source-checkout claim per leg (#2332).
 * The CLI run leaves the checkout unchanged. The write-enabled live-agent run
 * applies its saved patch by design, so it claims only that the checkout changed
 * by that patch; one shared "unchanged" field would overstate that leg.
 */
function linuxSummaryCheckoutClaimErrors(harness: string): string[] {
  const errors: string[] = [];
  const claims = [
    ["cliSourceCheckoutUnchanged", "CLI leg"],
    ["liveAgentSourceCheckoutChangedOnlyByAppliedPatch", "live-agent leg"],
  ] as const;
  for (const [field, leg] of claims) {
    if (!harness.includes(`\n  ${field}: false,\n`)) {
      errors.push(`The ${leg} claim ${field} does not start false in the retained summary`);
    }
    const sets = harness.split(`linuxDeliveryEvidenceForRetention.${field} = true;`).length - 1;
    if (sets !== 1) errors.push(`The ${leg} claim ${field} is set ${sets} times, not once`);
  }
  if (/\bsourceCheckoutUnchanged\b/u.test(harness)) {
    errors.push("A single sourceCheckoutUnchanged claim covers both legs");
  }
  return errors;
}

function need(job: Job, name: string) {
  return job.needs?.find((entry) => (typeof entry === "string" ? entry : entry.job) === name);
}

function dependencies(job: Job | undefined): string[] {
  if (!job) return [];
  const inherited = job.extends ? (Array.isArray(job.extends) ? job.extends : [job.extends]) : [];
  return [
    ...(job.needs ?? []).map((entry) => (typeof entry === "string" ? entry : entry.job)),
    ...inherited,
  ];
}

function dependsOn(pipeline: Record<string, Job>, start: string, target: string): boolean {
  const pending = [...dependencies(pipeline[start])];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const name = pending.pop();
    if (!name || visited.has(name)) continue;
    if (name === target) return true;
    visited.add(name);
    pending.push(...dependencies(pipeline[name]));
  }
  return false;
}

function runtimeProductPaths(pipeline: Record<string, Job>): string[] {
  return pipeline[".rules:runtime"].rules?.flatMap((rule) => rule.changes?.paths ?? []) ?? [];
}

function matchesRuntimeProductPath(path: string, pattern: string): boolean {
  if (pattern.endsWith("/**/*")) return path.startsWith(`${pattern.slice(0, -5)}/`);
  return path === pattern;
}

function uncoveredCandidateSources(
  pipeline: Record<string, Job>,
  sourceLocators: readonly string[],
): string[] {
  const patterns = runtimeProductPaths(pipeline);
  return sourceLocators.filter(
    (locator) => !patterns.some((pattern) => matchesRuntimeProductPath(locator, pattern)),
  );
}

function candidateGraphErrors(pipeline: Record<string, Job>): string[] {
  const errors: string[] = [];
  const prepare = pipeline["runtime:prepare"];
  const downstream = pipeline[".runtime_downstream"];
  const cleanInstall = pipeline["runtime:acceptance:clean-install"];
  const liveAgent = pipeline["runtime:live-agent:e2e"];
  const packageVerify = pipeline["runtime:package:verify"];

  if (!command(prepare, "prepare-packed-cli.mjs")?.includes("--output-dir package-candidate")) {
    errors.push("prepare does not produce package-candidate");
  }
  for (const path of [
    "packages/runtime/package-candidate/docsfab.tgz",
    "packages/runtime/package-candidate/metadata.json",
  ]) {
    if (!prepare.artifacts?.paths?.includes(path)) errors.push(`prepare does not retain ${path}`);
  }
  const prepareNeed = need(downstream, "runtime:prepare");
  if (typeof prepareNeed === "string" || prepareNeed?.artifacts !== true) {
    errors.push("runtime downstream jobs do not inherit prepare artifacts");
  }
  for (const [name, job] of [
    ["runtime:acceptance:clean-install", cleanInstall],
    ["runtime:live-agent:e2e", liveAgent],
  ] as const) {
    const inherited = Array.isArray(job.extends) ? job.extends : [job.extends];
    if (!inherited.includes(".runtime_downstream")) errors.push(`${name} bypasses runtime prepare`);
    if (!command(job, "--artifact-dir package-candidate")) {
      errors.push(`${name} does not consume package-candidate`);
    }
  }
  if (
    !command(packageVerify, "verify:package")?.includes(
      "--artifact-dir package-candidate --output-dir package-artifacts",
    )
  ) {
    errors.push("final verifier does not compare and promote package-candidate");
  }
  for (const required of ["runtime:acceptance:clean-install", "runtime:live-agent:e2e"]) {
    const dependency = need(packageVerify, required);
    if (!dependency || (typeof dependency !== "string" && dependency.optional === true)) {
      errors.push(`final verifier does not require ${required}`);
    }
  }
  for (const source of [
    "runtime:prepare",
    "runtime:acceptance:clean-install",
    "runtime:live-agent:e2e",
  ]) {
    if (dependsOn(pipeline, source, "runtime:package:verify")) {
      errors.push(`${source} depends back on the final verifier`);
    }
  }
  return errors;
}

describe.skipIf(ciPipeline.skip)(ciPipeline.title("packed candidate CI graph"), () => {
  it("keeps one source-checkout claim per leg in the retained Linux delivery summary", async () => {
    const harness = await readFile(resolve("scripts", "live-agent-session-e2e.mjs"), "utf8");
    expect(linuxSummaryCheckoutClaimErrors(harness)).toEqual([]);

    // One shared claim says the live-agent leg left the checkout unchanged.
    const shared = harness.replace(
      "\n  cliSourceCheckoutUnchanged: false,\n  liveAgentSourceCheckoutChangedOnlyByAppliedPatch: false,\n",
      "\n  sourceCheckoutUnchanged: false,\n",
    );
    expect(shared).not.toBe(harness);
    expect(linuxSummaryCheckoutClaimErrors(shared)).toEqual([
      "The CLI leg claim cliSourceCheckoutUnchanged does not start false in the retained summary",
      "The live-agent leg claim liveAgentSourceCheckoutChangedOnlyByAppliedPatch does not start false in the retained summary",
      "A single sourceCheckoutUnchanged claim covers both legs",
    ]);

    // A leg whose check passes must say so, and only once.
    const unset = harness.replace(
      "linuxDeliveryEvidenceForRetention.liveAgentSourceCheckoutChangedOnlyByAppliedPatch = true;",
      "",
    );
    expect(unset).not.toBe(harness);
    expect(linuxSummaryCheckoutClaimErrors(unset)).toEqual([
      "The live-agent leg claim liveAgentSourceCheckoutChangedOnlyByAppliedPatch is set 0 times, not once",
    ]);
  });

  it("builds once in prepare and routes the retained bytes through both installed journeys", async () => {
    const source = await readFile(resolve("..", "..", ".gitlab/ci/runtime.yml"), "utf8");
    const pipeline = parse(source) as Record<string, Job>;
    expect(candidateGraphErrors(pipeline)).toEqual([]);
    expect(linuxDeliveryEvidenceErrors(pipeline["runtime:live-agent:e2e"])).toEqual([]);

    const missingEvidence = structuredClone(pipeline);
    missingEvidence["runtime:live-agent:e2e"].artifacts = undefined;
    expect(linuxDeliveryEvidenceErrors(missingEvidence["runtime:live-agent:e2e"])).toEqual([
      "Linux summary is not retained on failure",
      "Linux delivery summary path is not retained",
    ]);

    const successOnlyEvidence = structuredClone(pipeline);
    successOnlyEvidence["runtime:live-agent:e2e"].artifacts!.when = "on_success";
    expect(linuxDeliveryEvidenceErrors(successOnlyEvidence["runtime:live-agent:e2e"])).toEqual([
      "Linux summary is not retained on failure",
    ]);

    const objectNeed = structuredClone(pipeline);
    const objectNeeds = objectNeed["runtime:package:verify"].needs ?? [];
    objectNeed["runtime:package:verify"].needs = objectNeeds.map((entry) =>
      entry === "runtime:acceptance:clean-install"
        ? { job: "runtime:acceptance:clean-install" }
        : entry,
    );
    expect(candidateGraphErrors(objectNeed)).toEqual([]);

    const missing = structuredClone(pipeline);
    missing["runtime:package:verify"].needs = (
      missing["runtime:package:verify"].needs ?? []
    ).filter(
      (entry) =>
        (typeof entry === "string" ? entry : entry.job) !== "runtime:acceptance:clean-install",
    );
    expect(candidateGraphErrors(missing)).toContain(
      "final verifier does not require runtime:acceptance:clean-install",
    );

    const optional = structuredClone(pipeline);
    optional["runtime:package:verify"].needs = (optional["runtime:package:verify"].needs ?? []).map(
      (entry) =>
        entry === "runtime:live-agent:e2e"
          ? { job: "runtime:live-agent:e2e", optional: true }
          : entry,
    );
    expect(candidateGraphErrors(optional)).toContain(
      "final verifier does not require runtime:live-agent:e2e",
    );
  });

  it("selects runtime CI for every governed candidate source", async () => {
    const [source, projectionsSource] = await Promise.all([
      readFile(resolve("..", "..", ".gitlab/ci/runtime.yml"), "utf8"),
      readFile(resolve("model-compositions/candidate-projections.json"), "utf8"),
    ]);
    const pipeline = parse(source) as Record<string, Job>;
    const projections = JSON.parse(projectionsSource) as {
      candidates: Array<{ source: { locator: string } }>;
    };
    const locators = [
      ...new Set(projections.candidates.map((candidate) => candidate.source.locator)),
    ];

    expect(uncoveredCandidateSources(pipeline, locators)).toEqual([]);

    const missingRuntimeSources = structuredClone(pipeline);
    for (const rule of missingRuntimeSources[".rules:runtime"].rules ?? []) {
      if (rule.changes?.paths) {
        rule.changes.paths = rule.changes.paths.filter((path) => path !== "packages/runtime/**/*");
      }
    }
    // Every source lives in the runtime package, so the package rule alone covers them.
    expect(uncoveredCandidateSources(missingRuntimeSources, locators)).toEqual(locators);
    expect(
      locators.filter(
        (locator) => !locator.startsWith("packages/runtime/model-compositions/sources/"),
      ),
    ).toEqual([]);

    expect(command(pipeline["runtime:prepare"], "npm run check:pins")).toContain(
      "--report-json=ci-results/derived-preflight.json",
    );
    expect(command(pipeline["runtime:prepare"], "npm run check:pins")).toContain(
      "--report-junit=ci-results/derived-preflight-junit.xml",
    );
  });
});

describe.skipIf(ciPipeline.skip)(ciPipeline.title("mr-assessment CI composition"), () => {
  it("does not inherit a required runtime:prepare need", async () => {
    const source = await readFile(resolve("..", "..", ".gitlab/ci/runtime.yml"), "utf8");
    const pipeline = parse(source) as Record<string, Job>;
    const job = pipeline["runtime:mr-assessment"];
    const inherited = Array.isArray(job.extends) ? job.extends : [job.extends];
    expect(inherited).toContain(".runtime_unprivileged");
    expect(inherited).toContain(".rules:mr-assessment");
    expect(inherited).not.toContain(".runtime_downstream");
    expect(job.needs).toEqual([]);
    expect(need(job, "runtime:prepare")).toBeUndefined();
  });
});
