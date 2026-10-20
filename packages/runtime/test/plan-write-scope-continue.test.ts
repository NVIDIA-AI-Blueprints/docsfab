// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * A continuation keeps its plan inside the documentation write roots, like
 * every local run, whatever the run it continues: an advisory or an admitted
 * one, through `docsfab do --continue` or the live agent, however long the
 * chain. The original stop comes from the shipped writer, `executeRunRequest`
 * with a stubbed interpretation and the editorial fixture harness. Its
 * continuation records `continuation`, and no interpretation outcome reaches
 * the rule.
 */
import { access, readFile, realpath, rm } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { handleDoCommand, type DoRunArguments } from "../src/cli/commands/do.js";
import { parseRunArguments } from "../src/cli/run-arguments.js";
import { executeRunRequest } from "../src/cli/run-request.js";
import { editorialInputAskSlots } from "../src/inputs/operator-input-fill.js";
import { readRunFailure } from "../src/operator/failure-classification.js";
import type { RunRecord } from "../src/records/contracts.js";
import type {
  RequestIntentInterpreterCall,
  RequestIntentInterpreterPort,
} from "../src/request-intent/interpret.js";
import {
  PLAN_OUTSIDE_WRITE_ROOTS_CODE,
  PLAN_TARGET_NOT_WRITABLE_CODE,
  PlanWriteScopeError,
  type PlanWriteRefusal,
} from "../src/workflow-execution/plan-binding.js";
import { continueLiveAgentEditorialInputAsk, runBoundedWorkflow } from "../src/live-agent/host.js";
import { planLiveAgentEditorialInputAskTurn } from "../src/live-agent/workflow-delivery.js";
import { EditorialProtocolHarness } from "./helpers/editorial-protocol-harness.js";
import {
  observePublicContract,
  orbitOptionChangeRepository,
  type OrbitOptionChangeFixture,
} from "./helpers/orbit-option-change-fixture.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";

const RUN_BUDGET = { timeout: testTimeoutMs(90_000) };
const DEFAULT_ROOTS = ["docs/", "fern/"];
/** Why plan admission refuses each planned write these continuations name. */
const REFUSAL: Readonly<Record<string, PlanWriteRefusal>> = {
  "AGENTS.md": "protected",
  "CLAUDE.md": "protected",
  "src/notes.md": "protected",
  "notes/guide.md": "outside-roots",
};
const ADVISORY_INSTRUCTION = "Review AGENTS.md and fix whatever is stale.";
const ADMITTED_INSTRUCTION = "Bring the CLI page up to date with the changed option.";
const ADMITTED_READING = {
  operation: "update",
  targets: [{ path: "docs/cli.md", role: "write", chosenFrom: "inventory", quote: "the CLI page" }],
};
const temporaryDirectories: string[] = [];

afterEach(async () => {
  process.exitCode = undefined;
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

type PlannedPage = { readonly path: string; readonly disposition: "update" | "retain" };

function stubPort(reply: Record<string, unknown>): RequestIntentInterpreterPort & {
  readonly calls: RequestIntentInterpreterCall[];
} {
  const calls: RequestIntentInterpreterCall[] = [];
  const text = JSON.stringify({
    authorityPreference: { preference: "unspecified", quote: null },
    targets: [],
    ...reply,
  });
  return {
    calls,
    async call(request) {
      calls.push(request);
      return { text, usage: { inputTokens: 3, outputTokens: 2 } };
    },
  };
}

interface ContinueFixture extends OrbitOptionChangeFixture {
  readonly canonicalRepository: string;
  readonly impactSource: { readonly uri: string; readonly sha256: string };
}

async function continueFixture(name: string): Promise<ContinueFixture> {
  const fixture = await orbitOptionChangeRepository(
    `docsfab-advisory-continue-${name}`,
    temporaryDirectories,
  );
  return {
    ...fixture,
    canonicalRepository: await realpath(fixture.repository),
    impactSource: await observePublicContract(fixture.repository, fixture.head),
  };
}

/**
 * The editorial fixture harness with the planner's pages scripted. A no-change
 * candidate that also keeps a page the revision does not hold has no admitted
 * evidence for it, so its run stops on the evidence a continuation supplies.
 */
function harness(
  fixture: ContinueFixture,
  pages: readonly PlannedPage[],
  candidate: "update" | "no-change" = "update",
): EditorialProtocolHarness {
  return new EditorialProtocolHarness({
    candidate,
    impactSource: fixture.impactSource,
    plannerPages: pages,
  });
}

const STOPPING_PAGES: readonly PlannedPage[] = [
  { path: "docs/absent.md", disposition: "retain" },
  { path: "docs/cli.md", disposition: "retain" },
];

/**
 * The original run: the current page is nominated but the public contract is
 * not, so the run stops for it with an InputAsk the continuation fills. A
 * workspace comparison nominates no changed source either, so its first
 * continuation stops again.
 */
async function originalStop(
  fixture: ContinueFixture,
  instruction: string,
  reading: Record<string, unknown>,
  comparison: "base-head" | "workspace" = "base-head",
): Promise<RunRecord> {
  const request = parseRunArguments([
    "update-documentation",
    "--repo",
    fixture.canonicalRepository,
    "--instruction",
    instruction,
    "--patch-only",
    ...(comparison === "base-head"
      ? ["--revision", fixture.head, "--comparison-base", fixture.base]
      : ["--comparison-workspace"]),
    "--reader-source",
    "current-documentation=docs/cli.md",
  ]);
  const record = await executeRunRequest(request, fixture.config, {
    silent: true,
    harness: harness(fixture, STOPPING_PAGES, "no-change"),
    requestInterpreter: stubPort(reading),
  });

  if (!record) throw new Error("the original run saved no record");
  return record;
}

/** One `docsfab do --continue <run> --attach src/orbit.ts`, with the planner's pages scripted. */
async function continueRun(
  fixture: ContinueFixture,
  runId: string,
  pages: readonly PlannedPage[],
  options: {
    readonly fill?: { readonly attach?: string; readonly reply?: string };
    readonly candidate?: "update" | "no-change";
  } = {},
): Promise<{
  readonly request: DoRunArguments;
  readonly record: RunRecord;
  readonly harness: EditorialProtocolHarness;
}> {
  const fill = options.fill ?? { attach: "src/orbit.ts" };
  const continued = harness(fixture, pages, options.candidate);
  const captured: DoRunArguments[] = [];
  await handleDoCommand(
    [
      ...(fill.reply ? [fill.reply] : []),
      "--repo",
      fixture.canonicalRepository,
      "--continue",
      runId,
      ...(fill.attach ? ["--attach", fill.attach] : []),
      "--patch-only",
      "--quiet",
    ],
    {
      stateDirectory: fixture.config.stateDirectory,
      runWorkflow: async (request) => {
        captured.push(structuredClone(request));
        return executeRunRequest(request, fixture.config, { silent: true, harness: continued });
      },
    },
  );
  expect(captured).toHaveLength(1);
  const request = captured[0]!;

  const record = JSON.parse(
    await readFile(join(fixture.config.stateDirectory, `${request.runId!}.json`), "utf8"),
  ) as RunRecord;
  return { request, record, harness: continued };
}

/** Plan admission did not refuse the plan for its write scope, by either code. */
function expectNotScopeRefused(record: RunRecord): void {
  expect([PLAN_OUTSIDE_WRITE_ROOTS_CODE, PLAN_TARGET_NOT_WRITABLE_CODE]).not.toContain(
    readRunFailure(record)?.code,
  );
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

function expectRefusedBeforeWriting(
  continued: { readonly record: RunRecord; readonly harness: EditorialProtocolHarness },
  outside: readonly string[],
): void {
  expect(continued.record.status).toBe("failed");
  const planStep = continued.record.steps.find((step) => step.skill === "plan-documentation");
  const error = new PlanWriteScopeError(
    outside.map((path) => ({ path, refusal: REFUSAL[path]! })),
    DEFAULT_ROOTS,
  );
  expect(planStep?.error).toBe(error.message);
  expect(readRunFailure(continued.record)).toMatchObject({
    class: "planning-refusal",
    code: error.code,
  });
  // Nothing after the planner ran, and nothing was written.
  expect(continued.harness.stepIds).toEqual(["plan-documentation"]);
  expect(continued.record.changes?.files ?? []).toEqual([]);
  expect(continued.record.changes?.patch).toBeUndefined();
}

describe("a do --continue keeps its plan inside the documentation write roots", () => {
  it(
    "refuses a continuation of an advisory run whose planner writes AGENTS.md, before any write step",
    RUN_BUDGET,
    async () => {
      const fixture = await continueFixture("refused");
      const original = await originalStop(fixture, ADVISORY_INSTRUCTION, { operation: "review" });
      expect(original.status, JSON.stringify(original.error)).toBe("needs-input");
      expect(original.requestIntent?.admission).toMatchObject({
        outcome: "advisory",
        code: "request-intent-operation-mismatch",
      });
      expect(editorialInputAskSlots(original).map((slot) => slot.inputId)).toContain(
        "public-contract",
      );

      const continued = await continueRun(fixture, original.id, [
        { path: "AGENTS.md", disposition: "update" },
      ]);
      expectRefusedBeforeWriting(continued, ["AGENTS.md"]);
      expect(await exists(join(fixture.repository, "AGENTS.md"))).toBe(false);
      // The continuation is not interpreted again, and its record says so.
      expect(continued.record.requestIntent?.admission).toMatchObject({
        outcome: "continuation",
        reason: "operator-input-resume",
      });
      expect(continued.request.operatorInputResume?.originalRunId).toBe(original.id);
    },
  );

  it.each(["AGENTS.md", "CLAUDE.md", "src/notes.md", "notes/guide.md"])(
    "refuses a continuation of an admitted run whose planner writes %s",
    RUN_BUDGET,
    async (outside) => {
      const fixture = await continueFixture("admitted");
      const original = await originalStop(fixture, ADMITTED_INSTRUCTION, ADMITTED_READING);
      expect(original.requestIntent?.admission.outcome).toBe("admitted");
      expect(original.status, JSON.stringify(original.error)).toBe("needs-input");
      const continued = await continueRun(fixture, original.id, [
        { path: outside, disposition: "update" },
      ]);
      expectRefusedBeforeWriting(continued, [outside]);
      expect(await exists(join(fixture.repository, outside))).toBe(false);
    },
  );

  it.each([
    ["an advisory", ADVISORY_INSTRUCTION, { operation: "review" }],
    ["an admitted", ADMITTED_INSTRUCTION, ADMITTED_READING],
  ] as const)(
    "lets a continuation of %s run go on when its planner keeps to the roots (control)",
    RUN_BUDGET,
    async (_name, instruction, reading) => {
      const fixture = await continueFixture("in-root");
      const original = await originalStop(fixture, instruction, reading);
      expect(original.status, JSON.stringify(original.error)).toBe("needs-input");
      const continued = await continueRun(fixture, original.id, [
        { path: "docs/cli.md", disposition: "update" },
      ]);
      expectNotScopeRefused(continued.record);
      expect(continued.harness.stepIds[0]).toBe("plan-documentation");
      expect(continued.harness.stepIds.length).toBeGreaterThan(1);
    },
  );

  it("keeps the confinement on a continuation of a continuation", RUN_BUDGET, async () => {
    const fixture = await continueFixture("chain");
    const original = await originalStop(
      fixture,
      ADVISORY_INSTRUCTION,
      { operation: "review" },
      "workspace",
    );
    expect(original.status, JSON.stringify(original.error)).toBe("needs-input");
    // No changed source is nominated, so after the public contract the
    // evidence is still incomplete and the first continuation stops again.
    const first = await continueRun(fixture, original.id, STOPPING_PAGES, {
      candidate: "no-change",
    });
    expect(first.record.status, JSON.stringify(first.record.error)).toBe("needs-input");
    // The second continuation's stop is the first continuation's record,
    // which records `continuation`; no outcome is walked back for the rule.
    const second = await continueRun(
      fixture,
      first.record.id,
      [{ path: "AGENTS.md", disposition: "update" }],
      { fill: { reply: "Admit the product requirements: the public option is --new." } },
    );
    expectRefusedBeforeWriting(second, ["AGENTS.md"]);
    expect(second.request.operatorInputResume?.originalRunId).toBe(first.record.id);
  });
});

/**
 * One live-agent reply that fills the original stop's public-contract slot by
 * naming the file, and the continuation the live agent runs through the shared
 * local run assembly, with the planner's pages scripted.
 */
async function liveAgentContinue(
  fixture: ContinueFixture,
  runId: string,
  pages: readonly PlannedPage[],
) {
  const turn = await planLiveAgentEditorialInputAskTurn({
    stateDirectory: fixture.config.stateDirectory,
    repositoryPath: fixture.canonicalRepository,
    revision: "HEAD",
    replyText: "src/orbit.ts",
  });
  if (turn.kind !== "input-ask-resume") throw new Error("no InputAsk resume was planned");
  expect(turn.plan.originalRunId).toBe(runId);
  const continued = harness(fixture, pages);
  const record = await continueLiveAgentEditorialInputAsk(turn.plan, {
    repositoryPath: fixture.canonicalRepository,
    allowWrite: true,
    config: fixture.config,
    persist: async () => ({ status: "not-needed" }),
    runWorkflow: (request) => runBoundedWorkflow({ ...request, executionHarness: continued }),
  });
  return { record, harness: continued };
}

describe("a live-agent continuation keeps its plan inside the documentation write roots", () => {
  it.each([
    ["an advisory", ADVISORY_INSTRUCTION, { operation: "review" }],
    ["an admitted", ADMITTED_INSTRUCTION, ADMITTED_READING],
  ] as const)(
    "refuses a live-agent continuation of %s run whose planner writes AGENTS.md",
    RUN_BUDGET,
    async (_name, instruction, reading) => {
      const fixture = await continueFixture("live");
      const original = await originalStop(fixture, instruction, reading);
      expect(original.status, JSON.stringify(original.error)).toBe("needs-input");
      const continued = await liveAgentContinue(fixture, original.id, [
        { path: "AGENTS.md", disposition: "update" },
      ]);
      expect(continued.record.requestIntent?.admission).toMatchObject({
        outcome: "continuation",
        reason: "operator-input-resume",
      });
      expectRefusedBeforeWriting(continued, ["AGENTS.md"]);
      expect(await exists(join(fixture.repository, "AGENTS.md"))).toBe(false);
    },
  );

  it(
    "lets a live-agent continuation whose planner keeps to the roots go on (control)",
    RUN_BUDGET,
    async () => {
      const fixture = await continueFixture("live-in-root");
      const original = await originalStop(fixture, ADMITTED_INSTRUCTION, ADMITTED_READING);
      expect(original.status, JSON.stringify(original.error)).toBe("needs-input");
      const continued = await liveAgentContinue(fixture, original.id, [
        { path: "docs/cli.md", disposition: "update" },
      ]);
      expectNotScopeRefused(continued.record);
      expect(continued.harness.stepIds.length).toBeGreaterThan(1);
    },
  );
});
