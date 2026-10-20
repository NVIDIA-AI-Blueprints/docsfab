// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { describe, expect, it } from "vitest";

import {
  jobNames,
  keysDeclaredIn,
  matchesCiPath,
  readGitlabCiConfig,
} from "./helpers/gitlab-ci.js";
import { internalOnly } from "./helpers/internal-path.js";

// Expensive CI jobs wait for the pipeline's deterministic code gates (#2119
// lever A3), so a pipeline a cheap gate has already failed does not spend
// runner time on them. This pins those edges on the merged CI definition.

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const gitlabCi = internalOnly(
  ".gitlab/ci",
  "it pins the GitLab CI definition, which is not exported",
);

/** Cheap, deterministic checks of code every expensive job below tests. */
const CODE_GATES = [
  "runtime:derived:preflight",
  "runtime:prepare",
  "runtime:static",
  "process:public-export-boundary",
] as const;

/** Checks MR metadata, not code: a failing title must not hold back any suite. */
const NEVER_A_GATE = "process:mr-hygiene";

const DRAFT_ONLY_HOLD = {
  if: '$CI_PIPELINE_SOURCE == "merge_request_event" && ($CI_MERGE_REQUEST_EVENT_TYPE == "detached" || $CI_MERGE_REQUEST_EVENT_TYPE == "merged_result") && $CI_MERGE_REQUEST_TITLE =~ /^(Draft|WIP):/',
  when: "never",
} as const;

const SELECTED_MERGE_TRAIN_HOLD = {
  if: '$CI_PIPELINE_SOURCE == "merge_request_event" && $CI_MERGE_REQUEST_EVENT_TYPE == "merge_train"',
  when: "never",
} as const;

const SELECTED_DEFAULT_PUSH_HOLD = {
  if: '$CI_PIPELINE_SOURCE == "push" && $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH',
  when: "never",
} as const;

const SELECTED_HEAVY_TESTS = new Set([
  "runtime:isolation:delivery",
  "runtime:isolation:profile",
  "runtime:isolation:docs",
  "runtime:coverage",
]);

/** Required consumers may add only the named draft and selected-phase holds. */
function safeRequiredRules(consumer: unknown, producer: unknown, consumerName: string): boolean {
  if (isDeepStrictEqual(consumer, producer)) return true;
  if (!Array.isArray(consumer) || !Array.isArray(producer)) return false;
  const allowedPrefix =
    consumerName === "runtime:test"
      ? [SELECTED_MERGE_TRAIN_HOLD, SELECTED_DEFAULT_PUSH_HOLD]
      : SELECTED_HEAVY_TESTS.has(consumerName)
        ? [SELECTED_MERGE_TRAIN_HOLD, SELECTED_DEFAULT_PUSH_HOLD, DRAFT_ONLY_HOLD]
        : [DRAFT_ONLY_HOLD];
  return (
    consumer.length === producer.length + allowedPrefix.length &&
    allowedPrefix.every((rule, index) => isDeepStrictEqual(consumer[index], rule)) &&
    isDeepStrictEqual(consumer.slice(allowedPrefix.length), producer)
  );
}

const RUNTIME_EXPENSIVE = [
  "runtime:test",
  "runtime:isolation:delivery",
  "runtime:isolation:profile",
  "runtime:isolation:docs",
  "runtime:live-agent:e2e",
  "runtime:acceptance:clean-install",
];

/** Jobs that read only the source checkout, so no gate's artifacts may land in it. */
const CHECKOUT_ONLY = [
  "public-export:dry-run",
  "host:deploy-retention-redaction",
  "host:deploy-pilot-service",
];

type Definitions = Record<string, unknown>;
type Need = { job: string; optional: boolean; artifacts: boolean };
type JobStatus = "pending" | "passed" | "failed";

function isHash(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** GitLab `extends` merging: hashes merge recursively, arrays and scalars replace. */
function merge(base: unknown, overlay: unknown): unknown {
  if (!isHash(base) || !isHash(overlay)) return overlay;
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    merged[key] = Object.hasOwn(merged, key) ? merge(merged[key], value) : value;
  }
  return merged;
}

/**
 * A job as GitLab runs it: every `extends` parent in order, then its own keys.
 * With `skipUnloaded`, a parent from a template include this loader does not
 * read is left out instead of refused.
 */
function resolvedJob(
  definitions: Definitions,
  name: string,
  skipUnloaded = false,
): Record<string, unknown> {
  const own = definitions[name];
  if (!isHash(own)) throw new Error(`${name} is not in the loaded CI files`);
  const parents = own.extends === undefined ? [] : [own.extends].flat();
  let job: unknown = {};
  for (const parent of parents.map(String)) {
    if (skipUnloaded && !(parent in definitions)) continue;
    job = merge(job, resolvedJob(definitions, parent, skipUnloaded));
  }
  const { extends: _extends, ...rest } = own;
  return merge(job, rest) as Record<string, unknown>;
}

/** The job's `needs:`, or `undefined` when it waits on stage order instead. */
function needsOf(definitions: Definitions, name: string, skipUnloaded = false): Need[] | undefined {
  const needs = resolvedJob(definitions, name, skipUnloaded).needs;
  if (needs === undefined) return undefined;
  if (!Array.isArray(needs)) throw new Error(`${name} needs: is not a list`);
  return needs.map((entry) => {
    if (typeof entry === "string") return { job: entry, optional: false, artifacts: true };
    if (!isHash(entry) || typeof entry.job !== "string")
      throw new Error(`${name} has a needs: entry this test does not model`);
    return {
      job: entry.job,
      optional: entry.optional === true,
      artifacts: entry.artifacts !== false,
    };
  });
}

/**
 * Jobs `name` always waits for when it runs: each direct need, and what a
 * non-optional need waits for in turn. An optional need that is absent from
 * the pipeline gates nothing, so the walk stops there.
 */
function guaranteedWaits(definitions: Definitions, name: string, seen = new Set<string>()) {
  if (seen.has(name)) throw new Error(`needs: cycle through ${name}`);
  const waits = new Set<string>();
  for (const need of needsOf(definitions, name) ?? []) {
    waits.add(need.job);
    if (need.optional) continue;
    for (const job of guaranteedWaits(definitions, need.job, new Set([...seen, name])))
      waits.add(job);
  }
  return waits;
}

/** Every job `name` can wait for through `needs:`, optional or not. */
function anyWaits(definitions: Definitions, name: string, seen = new Set<string>()) {
  if (seen.has(name)) throw new Error(`needs: cycle through ${name}`);
  const waits = new Set<string>();
  for (const need of needsOf(definitions, name, true) ?? []) {
    if (!(need.job in definitions)) continue; // template jobs this loader does not read
    waits.add(need.job);
    for (const job of anyWaits(definitions, need.job, new Set([...seen, name]))) waits.add(job);
  }
  return waits;
}

/** GitLab `needs` scheduling for a selected job in a fixed pipeline fixture. */
function canStart(
  definitions: Definitions,
  name: string,
  selected: ReadonlySet<string>,
  statuses: ReadonlyMap<string, JobStatus>,
): boolean {
  if (!selected.has(name)) return false;
  for (const need of needsOf(definitions, name) ?? []) {
    if (!selected.has(need.job)) {
      if (need.optional) continue;
      return false;
    }
    if (statuses.get(need.job) !== "passed") return false;
  }
  return true;
}

async function loadGraph() {
  const config = await readGitlabCiConfig(repositoryRoot);
  const hostJobs = keysDeclaredIn(config, ".gitlab/ci/host.yml").filter(
    (name) => !name.startsWith("."),
  );
  const gated = new Map<string, readonly string[]>();
  for (const name of [...RUNTIME_EXPENSIVE, ...hostJobs]) gated.set(name, CODE_GATES);
  gated.set("public-export:dry-run", [...CODE_GATES, "public-export:test"]);
  return { config, definitions: config.definitions, gated, hostJobs };
}

describe.skipIf(gitlabCi.skip)(gitlabCi.title("CI code gates"), () => {
  it("gates every expensive job on each code gate of the pipeline", async () => {
    const { definitions, gated, hostJobs } = await loadGraph();
    // Positive control: the host set is read from host.yml, not hard-coded.
    expect(hostJobs).toEqual(
      expect.arrayContaining([
        "host:test",
        "host:recovery-gitlab-storage",
        "host:postgres-attestation",
        "host:linux-attestation",
        "host:forge-merge-recovery-postgres",
      ]),
    );
    for (const [name, gates] of gated) {
      const waits = guaranteedWaits(definitions, name);
      for (const gate of gates) {
        expect(gate in definitions, `${gate} is not a CI job`).toBe(true);
        expect(waits.has(gate), `${name} must wait for ${gate}`).toBe(true);
      }
    }
  });

  it("marks path-scoped gates optional while retaining the runtime prepare gate", async () => {
    const { definitions, gated, hostJobs } = await loadGraph();
    for (const name of hostJobs) {
      const byJob = new Map((needsOf(definitions, name) ?? []).map((need) => [need.job, need]));
      for (const gate of CODE_GATES) {
        expect(byJob.get(gate)?.optional, `${name} must allow absent ${gate}`).toBe(true);
      }
    }
    for (const name of RUNTIME_EXPENSIVE) {
      const byJob = new Map((needsOf(definitions, name) ?? []).map((need) => [need.job, need]));
      expect(byJob.get("runtime:prepare")?.optional, `${name} keeps prepare required`).toBe(false);
      for (const gate of ["runtime:static", "process:public-export-boundary"]) {
        expect(byJob.get(gate)?.optional, `${name} must allow absent ${gate}`).toBe(true);
      }
    }
    const exportNeeds = new Map(
      (needsOf(definitions, "public-export:dry-run") ?? []).map((need) => [need.job, need]),
    );
    for (const gate of [...CODE_GATES, "public-export:test"]) {
      expect(
        exportNeeds.get(gate)?.optional,
        `public-export:dry-run must allow absent ${gate}`,
      ).toBe(true);
    }
    expect(gated.has("process:mr-hygiene")).toBe(false);
  });

  it("never lets a gate edge make a job uncreatable", async () => {
    const { definitions, gated } = await loadGraph();
    // GitLab refuses to create a pipeline whose job needs an absent job. A
    // required gate must run in every pipeline that selects its consumer.
    for (const [name, gates] of gated) {
      const rules = resolvedJob(definitions, name).rules;
      for (const need of needsOf(definitions, name) ?? []) {
        if (!gates.includes(need.job) || need.optional) continue;
        expect(
          safeRequiredRules(rules, resolvedJob(definitions, need.job).rules, name),
          `${name} requires ${need.job}, whose rules would select fewer pipelines; keep producer selection at least as broad`,
        ).toBe(true);
      }
    }
  });

  it("rejects required-gate rule drift beyond the exact draft and selected-phase holds", () => {
    const producer = [{ if: '$CI_PIPELINE_SOURCE == "merge_request_event"' }, { when: "never" }];
    expect(safeRequiredRules(producer, producer, "runtime:static")).toBe(true);
    expect(safeRequiredRules([DRAFT_ONLY_HOLD, ...producer], producer, "runtime:static")).toBe(
      true,
    );
    expect(
      safeRequiredRules(
        [SELECTED_MERGE_TRAIN_HOLD, SELECTED_DEFAULT_PUSH_HOLD, ...producer],
        producer,
        "runtime:test",
      ),
    ).toBe(true);
    expect(
      safeRequiredRules(
        [SELECTED_MERGE_TRAIN_HOLD, SELECTED_DEFAULT_PUSH_HOLD, DRAFT_ONLY_HOLD, ...producer],
        producer,
        "runtime:isolation:docs",
      ),
    ).toBe(true);
    // Removing the required producer on draft, or adding a wider consumer
    // rule, would make a selected consumer depend on an absent gate.
    expect(safeRequiredRules(producer, [DRAFT_ONLY_HOLD, ...producer], "runtime:static")).toBe(
      false,
    );
    expect(
      safeRequiredRules(
        [
          DRAFT_ONLY_HOLD,
          { if: '$CI_PIPELINE_SOURCE == "merge_request_event"', changes: ["other/**/*"] },
          { when: "never" },
        ],
        producer,
        "runtime:static",
      ),
    ).toBe(false);
    expect(
      safeRequiredRules(
        [{ ...DRAFT_ONLY_HOLD, when: "on_success" }, ...producer],
        producer,
        "runtime:static",
      ),
    ).toBe(false);
    expect(
      safeRequiredRules(
        [{ if: '$CI_PIPELINE_SOURCE == "push"', when: "never" }, ...producer],
        producer,
        "runtime:static",
      ),
    ).toBe(false);
    expect(
      safeRequiredRules([SELECTED_MERGE_TRAIN_HOLD, ...producer], producer, "runtime:static"),
    ).toBe(false);
    expect(
      safeRequiredRules(
        [SELECTED_MERGE_TRAIN_HOLD, SELECTED_DEFAULT_PUSH_HOLD, ...producer],
        producer,
        "runtime:isolation:docs",
      ),
    ).toBe(false);
  });

  it("orders every gate no later than the job it gates", async () => {
    const { definitions, gated } = await loadGraph();
    const stages = definitions.stages as string[];
    const stageIndex = (job: string) => {
      const index = stages.indexOf(String(resolvedJob(definitions, job).stage));
      expect(index, `${job} has no declared stage`).toBeGreaterThanOrEqual(0);
      return index;
    };
    for (const [name, gates] of gated) {
      for (const gate of gates) {
        expect(stageIndex(gate), `${gate} runs in a later stage than ${name}`).toBeLessThanOrEqual(
          stageIndex(name),
        );
      }
    }
  });

  it("never makes any job wait for process:mr-hygiene", async () => {
    const { config, definitions } = await loadGraph();
    expect(NEVER_A_GATE in definitions, `${NEVER_A_GATE} is not a CI job`).toBe(true);
    for (const name of jobNames(config)) {
      expect(
        anyWaits(definitions, name).has(NEVER_A_GATE),
        `${name} waits for ${NEVER_A_GATE}`,
      ).toBe(false);
    }
  });

  it("keeps a selected job selected when optional path-scoped gates are absent", async () => {
    const { definitions } = await loadGraph();
    const selected = new Set(["runtime:derived:preflight", "runtime:prepare", "runtime:test"]);
    const statuses = new Map<string, JobStatus>([
      ["runtime:derived:preflight", "passed"],
      ["runtime:prepare", "passed"],
    ]);

    // The fixture represents a runtime-focused pipeline where static and
    // public-export path rules select no jobs. Optional absence is ignored by
    // scheduling; the selected runtime suite still starts after prepare.
    expect(selected.has("runtime:test")).toBe(true);
    expect(canStart(definitions, "runtime:test", selected, statuses)).toBe(true);
  });

  it("holds a selected expensive job while any selected code gate fails", async () => {
    const { definitions } = await loadGraph();
    const selected = new Set([
      "runtime:derived:preflight",
      "runtime:prepare",
      "runtime:static",
      "runtime:test",
    ]);
    const statuses = new Map<string, JobStatus>([
      ["runtime:derived:preflight", "passed"],
      ["runtime:prepare", "passed"],
      ["runtime:static", "failed"],
    ]);

    // This is the failing-gate acceptance fixture: the expensive job remains
    // selected but cannot start until the present gate succeeds.
    expect(selected.has("runtime:test")).toBe(true);
    expect(canStart(definitions, "runtime:test", selected, statuses)).toBe(false);
    statuses.set("runtime:static", "passed");
    expect(canStart(definitions, "runtime:test", selected, statuses)).toBe(true);
  });

  it("downloads no gate artifacts into a checkout-only job", async () => {
    const { definitions } = await loadGraph();
    for (const name of CHECKOUT_ONLY) {
      const needs = needsOf(definitions, name);
      expect(needs, `${name} must declare its gates`).toBeDefined();
      for (const need of needs ?? []) {
        expect(need.artifacts, `${name} downloads ${need.job}'s artifacts`).toBe(false);
      }
    }
  });

  it("retains the prepared runtime artifact for consumers that declare it", async () => {
    const { definitions, hostJobs } = await loadGraph();
    const artifactConsumers = [...RUNTIME_EXPENSIVE, ...hostJobs].filter(
      (job) => !CHECKOUT_ONLY.includes(job),
    );
    for (const name of artifactConsumers) {
      const prepare = (needsOf(definitions, name) ?? []).find(
        (need) => need.job === "runtime:prepare",
      );
      expect(prepare, `${name} must retain its runtime:prepare edge`).toBeDefined();
      expect(prepare?.artifacts, `${name} must retain runtime:prepare artifacts`).toBe(true);
    }
  });

  it("has no needs cycles, including inherited attestation children", async () => {
    const { definitions, hostJobs } = await loadGraph();
    for (const name of [...RUNTIME_EXPENSIVE, ...hostJobs, "public-export:dry-run"]) {
      expect(() => anyWaits(definitions, name), `${name} has a needs cycle`).not.toThrow();
    }
    for (const name of [
      "host:reconciliation-notifications-postgres",
      "host:forge-merge-recovery-postgres",
      "host:forge-merge-recovery-configured",
    ]) {
      expect(guaranteedWaits(definitions, name)).toEqual(expect.any(Set));
      for (const gate of CODE_GATES) {
        expect(anyWaits(definitions, name).has(gate), `${name} misses inherited ${gate}`).toBe(
          true,
        );
      }
    }
  });
});
