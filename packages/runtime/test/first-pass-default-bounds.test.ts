// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi, afterEach } from "vitest";

import { handleDoctorCommand } from "../src/cli/commands/doctor.js";
import { bindFirstPassKnowledge } from "../src/cli/first-pass.js";
import {
  firstPassBoundsNextAction,
  firstPassHostLimits,
  firstPassModelBudget,
  firstPassModelDeadlineMs,
  type FirstPassInputWindowSource,
  type FirstPassSupportModelBridge,
} from "../src/cli/first-pass-support.js";
import { parseLimitOverride } from "../src/config/limit-resolution.js";
import { limitDefinition } from "../src/config/limits.js";
import { LIMIT_DEFINITIONS } from "../src/config/limits.generated.js";
import {
  attested,
  bindingContext,
  compositionWith,
  implementationBridge,
  inventoryReader,
  missing,
  type ModelWindow,
  retainedSupport,
  scriptedBridge,
  supported,
  updateRequest,
  workspaceWith,
} from "./helpers/first-pass-bounds-fixture.js";
import { temporaryRoots } from "./helpers/temp.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";

const roots = temporaryRoots();
// Each end-to-end case writes a repository and runs real gather and validation.
const CASE_MS = testTimeoutMs(60_000);

// The benchmark composition's input window and the context reserve its profile sets.
const BENCHMARK_WINDOW: ModelWindow = { maxInputTokens: 1_050_000, reservedContextTokens: 4_096 };
// The former defaults, before the benchmark rerun measured first pass.
const FORMER_DEFAULTS = {
  DOCSFAB_FIRST_PASS_EVIDENCE_EXPANSION_MODEL_TURNS: "3",
  DOCSFAB_FIRST_PASS_MAX_SOURCE_FILES: "256",
  DOCSFAB_FIRST_PASS_MAX_SPANS: "1024",
  DOCSFAB_FIRST_PASS_MAX_PRESENTED_BYTES: "786432",
  DOCSFAB_FIRST_PASS_MODEL_INPUT_TOKENS_PER_TURN: "262144",
};
const WINDOW_SENTENCE =
  "A model profile with a larger input window also holds a larger assessment prompt.";

const grouped = (value: number) => value.toLocaleString("en-US");

afterEach(() => {
  vi.unstubAllEnvs();
});

function stubEnvironment(values: Record<string, string>): void {
  for (const [name, value] of Object.entries(values)) vi.stubEnv(name, value);
}

/** The evidence-gap limitation lines a first pass that continued recorded (#2113). */
function gapLines(outcome: unknown): readonly string[] {
  expect(outcome).not.toBeInstanceOf(Error);
  return (
    (outcome as { firstPassEvidenceWarnings?: readonly string[] } | undefined)
      ?.firstPassEvidenceWarnings ?? []
  );
}

/** The recorded line for one bound. */
function boundLine(outcome: unknown, bound: string): string | undefined {
  return gapLines(outcome).find((line) => line.includes(`(${bound}, `));
}

/** The assessment prompt bound the host derives for one bound profile. */
function promptBound(model: FirstPassInputWindowSource | undefined): number {
  return firstPassHostLimits({
    budget: firstPassModelBudget({ retryPolicy: { maxRetries: 3 } }),
    ...(model ? { model } : {}),
    modelDeadlineMs: firstPassModelDeadlineMs(),
  }).maxPresentedBytes;
}

describe("first-pass default bounds", () => {
  it("derives the assessment prompt from three quarters of the model's admitted window after its reserve", () => {
    expect(limitDefinition("firstPass.assessmentInputWindowShare").value).toBe(0.75);
    // The benchmark composition, the other installed windows, and the smallest.
    expect(promptBound(attested(BENCHMARK_WINDOW))).toBe(2_353_284);
    expect(promptBound(attested({ maxInputTokens: 1_000_000, reservedContextTokens: 4_096 }))).toBe(
      2_240_784,
    );
    expect(promptBound(attested({ maxInputTokens: 524_288, reservedContextTokens: 4_096 }))).toBe(
      1_170_432,
    );
    expect(promptBound(attested({ maxInputTokens: 128_000, reservedContextTokens: 4_096 }))).toBe(
      278_784,
    );
    expect(promptBound(attested({ maxInputTokens: 65_536, reservedContextTokens: 4_096 }))).toBe(
      138_240,
    );
    // The 1,024-token reserve setup writes for a custom endpoint adds 6,912 bytes.
    expect(
      promptBound(attested({ maxInputTokens: 1_050_000, reservedContextTokens: 1_024 })) -
        promptBound(attested(BENCHMARK_WINDOW)),
    ).toBe(6_912);
    // A larger window holds a larger prompt; the ceiling stays above every installed one.
    expect(limitDefinition("firstPass.maxPresentedBytes").value).toBeGreaterThan(
      3 * BENCHMARK_WINDOW.maxInputTokens,
    );
    // No attested window: no profile, a placeholder whose metadata is unknown, or
    // provider-side admission. One turn's input share stands in for the window.
    const standIn =
      3 * Math.floor(0.75 * limitDefinition("firstPass.modelInputTokensPerTurn").value);
    expect(promptBound(undefined)).toBe(standIn);
    expect(
      promptBound({
        profile: { maxInputTokens: 32_768, effectiveLimitReason: "metadata-unknown" },
        requestPolicy: { reservedContextTokens: 1_024 },
      }),
    ).toBe(standIn);
    expect(
      promptBound({
        contextAdmission: "provider",
        profile: { maxInputTokens: 128_000 },
        requestPolicy: { reservedContextTokens: 1_024 },
      }),
    ).toBe(standIn);
    // A window its reserve fills keeps the catalog minimum, so acquisition stops by name.
    expect(promptBound(attested({ maxInputTokens: 4_096, reservedContextTokens: 4_096 }))).toBe(
      limitDefinition("firstPass.maxPresentedBytes").min,
    );
  });

  it("keeps headroom over every first pass the former defaults stopped in the benchmark rerun", () => {
    const bound = promptBound(attested(BENCHMARK_WINDOW));
    // The largest prompt demand at the former 786,432-byte bound, among 18 stops.
    expect(bound / 794_513).toBeGreaterThan(2.9);
    // Seven rounds at the 90th-percentile growth of a round, after the largest first round.
    expect(bound).toBeGreaterThanOrEqual(403_832 + 6 * 305_690);
    // Nine stops used all four rounds of the former allowance and wanted a fifth.
    const rounds = 1 + limitDefinition("firstPass.evidenceExpansionModelTurns").value;
    expect(rounds).toBe(7);
    // Each round keeps the former first-round share of 64 sources.
    expect(limitDefinition("firstPass.maxSourceFiles").value).toBe(64 * rounds);
    // Prompt bytes still bind before spans of the smallest measured average, 1,289 bytes.
    expect(limitDefinition("firstPass.maxSpans").value * 1_289).toBeGreaterThan(bound);
    expect(limitDefinition("firstPass.maxSpans").value).toBeGreaterThan(7 * 202);
    // The per-turn share is the largest window an installed composition seals,
    // so one turn holds a full assessment on every installed composition.
    expect(limitDefinition("firstPass.modelInputTokensPerTurn").value).toBe(
      limitDefinition("sealed.compositionLimits.maxInputTokens").value,
    );
    expect(limitDefinition("firstPass.modelInputTokensPerTurn").value * 3).toBeGreaterThanOrEqual(
      bound,
    );
  });

  it("raises the prompt with whichever override the stop names, for each setting that can bind it", () => {
    const cases: Array<{ label: string; setup: Record<string, string>; named: string }> = [
      {
        label: "window share",
        setup: {},
        named: "DOCSFAB_FIRST_PASS_ASSESSMENT_INPUT_WINDOW_SHARE",
      },
      {
        label: "turn share",
        setup: { DOCSFAB_FIRST_PASS_MODEL_INPUT_TOKENS_PER_TURN: "262144" },
        named: "DOCSFAB_FIRST_PASS_MODEL_INPUT_TOKENS_PER_TURN",
      },
      {
        label: "ceiling",
        setup: { DOCSFAB_FIRST_PASS_MAX_PRESENTED_BYTES: "1000000" },
        named: "DOCSFAB_FIRST_PASS_MAX_PRESENTED_BYTES",
      },
    ];
    for (const { label, setup, named } of cases) {
      vi.unstubAllEnvs();
      stubEnvironment(setup);
      const bound = promptBound(attested(BENCHMARK_WINDOW));
      const nextAction = firstPassBoundsNextAction([
        { bound: "maxPresentedBytes", observed: bound + 1, limit: bound },
      ]);
      const raised = [...nextAction.matchAll(/(DOCSFAB_[A-Z_]+) \(up to [\d,.]+\)/gu)].map(
        ([, name]) => name!,
      );
      // Raising exactly what the stop names, to its maximum, raises the prompt.
      for (const name of raised) {
        const definition = LIMIT_DEFINITIONS.find((item) => item.override === name)!;
        vi.stubEnv(name, String(definition.max));
      }
      expect(promptBound(attested(BENCHMARK_WINDOW)), label).toBeGreaterThan(bound);
      expect(raised, label).toEqual([named]);
    }
  });

  it("names the model's window when the window share sets the prompt, and no share raise once it is 1", () => {
    const bound = promptBound(attested(BENCHMARK_WINDOW));
    const nextAction = firstPassBoundsNextAction([
      { bound: "maxPresentedBytes", observed: bound + 1, limit: bound },
    ]);
    expect(nextAction).toContain("DOCSFAB_FIRST_PASS_ASSESSMENT_INPUT_WINDOW_SHARE (up to 1)");
    expect(nextAction).toContain(WINDOW_SENTENCE);
    // A share already at its maximum cannot raise the prompt; the window can.
    vi.stubEnv("DOCSFAB_FIRST_PASS_ASSESSMENT_INPUT_WINDOW_SHARE", "1");
    const whole = promptBound(attested(BENCHMARK_WINDOW));
    const atMax = firstPassBoundsNextAction([
      { bound: "maxPresentedBytes", observed: whole + 1, limit: whole },
    ]);
    expect(atMax).not.toContain("DOCSFAB_FIRST_PASS_ASSESSMENT_INPUT_WINDOW_SHARE");
    expect(atMax).not.toContain("Or raise");
    expect(atMax).toContain(WINDOW_SENTENCE);
    // A bound the ceiling set names the ceiling alone.
    vi.stubEnv("DOCSFAB_FIRST_PASS_MAX_PRESENTED_BYTES", "1000000");
    const ceiling = firstPassBoundsNextAction([
      { bound: "maxPresentedBytes", observed: 1_000_001, limit: 1_000_000 },
    ]);
    expect(ceiling).toContain("DOCSFAB_FIRST_PASS_MAX_PRESENTED_BYTES (up to 67,108,864)");
    expect(ceiling).not.toContain("input window");
  });

  it("names the source budget a round allowance stop also needs, because rounds share it", () => {
    const nextAction = firstPassBoundsNextAction([{ bound: "maxRounds", observed: 8, limit: 7 }]);
    expect(nextAction).toContain(
      "Or raise DOCSFAB_FIRST_PASS_EVIDENCE_EXPANSION_MODEL_TURNS (up to 16), DOCSFAB_FIRST_PASS_MAX_SOURCE_FILES (up to 100,000) in the host configuration",
    );
    expect(nextAction).toContain(
      "Each round reads an even share of DOCSFAB_FIRST_PASS_MAX_SOURCE_FILES, so more rounds alone read fewer files a round.",
    );
    // A source budget stop alone carries no round sentence.
    const sources = firstPassBoundsNextAction([
      { bound: "maxSourceFiles", observed: 449, limit: 448 },
    ]);
    expect(sources).toContain("DOCSFAB_FIRST_PASS_MAX_SOURCE_FILES (up to 100,000)");
    expect(sources).not.toContain("EVIDENCE_EXPANSION");
    expect(sources).not.toContain("Each round reads");
  });

  it("refuses a window share override outside its range as a number, and an integer limit as an integer", () => {
    const share = limitDefinition("firstPass.assessmentInputWindowShare");
    expect(parseLimitOverride(share, "1")).toBe(1);
    expect(parseLimitOverride(share, "0.5")).toBe(0.5);
    expect(() => parseLimitOverride(share, "1.5")).toThrow(
      "DOCSFAB_FIRST_PASS_ASSESSMENT_INPUT_WINDOW_SHARE must be a number between 0.01 and 1.",
    );
    expect(() => parseLimitOverride(limitDefinition("firstPass.maxSpans"), "1.5")).toThrow(
      "DOCSFAB_FIRST_PASS_MAX_SPANS must be an integer between 1 and 1000000.",
    );
  });

  it("shows the first-pass defaults and a raised host value in doctor --limits", async () => {
    vi.stubEnv("DOCSFAB_STATE_DIR", await roots.create("docsfab-first-pass-doctor-state-"));
    // An empty configuration root, so no host file overrides a default.
    vi.stubEnv("DOCSFAB_CONFIG_ROOT", await roots.create("docsfab-first-pass-doctor-empty-"));
    const defaults = await doctorLimits();
    for (const row of [
      "firstPass.evidenceExpansionModelTurns | 6 | count | config/limits.yaml",
      "firstPass.modelInputTokensPerTurn | 1050000 | tokens | config/limits.yaml",
      "firstPass.maxSourceFiles | 448 | count | config/limits.yaml",
      "firstPass.maxSpans | 2048 | count | config/limits.yaml",
      "firstPass.maxPresentedBytes | 4194304 | bytes | config/limits.yaml",
      "firstPass.assessmentInputWindowShare | 0.75 | ratio | config/limits.yaml",
    ]) {
      expect(defaults).toContain(row);
    }
    const configRoot = await roots.create("docsfab-first-pass-doctor-config-");
    await writeFile(
      join(configRoot, ".env"),
      "DOCSFAB_FIRST_PASS_ASSESSMENT_INPUT_WINDOW_SHARE=0.9\nDOCSFAB_FIRST_PASS_EVIDENCE_EXPANSION_MODEL_TURNS=8\n",
      "utf8",
    );
    vi.stubEnv("DOCSFAB_CONFIG_ROOT", configRoot);
    const raised = await doctorLimits();
    expect(raised).toContain("firstPass.assessmentInputWindowShare | 0.9 | ratio | host |");
    expect(raised).toContain("firstPass.evidenceExpansionModelTurns | 8 | count | host |");
  });
});

describe("first-pass default bounds end to end", () => {
  it("settles a first pass the former defaults stopped: five rounds and a prompt past 786,432 bytes", {
    timeout: CASE_MS,
  }, async () => {
    // 400 ranked sources, 64 a round. Each step closes once its round's
    // sources are offered, so every round closes a gap and expansion goes on
    // (#2113): the last step needs more than the 256 the first four rounds read.
    const files: Record<string, string> = { "docs/guide.md": GUIDE };
    for (let index = 0; index < 400; index += 1) {
      files[`src/scheduler/widget_retry_${String(index).padStart(3, "0")}.py`] =
        rankedSource(index);
    }
    const thresholds = [100, 150, 200, 256];
    const bridge = () =>
      scriptedBridge({
        obligations: thresholds.map((_threshold, index) => ({
          id: `decomposed-coverage-${String(index + 1)}`,
          condition: `The guide covers retry step ${String(index + 1)}.`,
        })),
        assess: (id, spanByPath) => {
          const ranked = [...spanByPath.keys()].filter((path) => path.startsWith("src/"));
          const step = Number(id.slice("decomposed-coverage-".length));
          return ranked.length > thresholds[step - 1]!
            ? supported(spanByPath.get(ranked[0]!)!)
            : missing("Not every retry step is offered yet.");
        },
      });
    const current = await workspaceWith(roots, files);
    await bindFirstPassKnowledge({
      request: updateRequest(RETRY_INSTRUCTION),
      ...bindingContext(current),
      ...compositionWith(BENCHMARK_WINDOW),
      supportModelBridge: bridge(),
      trackedSourceReader: inventoryReader(current.tracked),
    });
    const settled = await retainedSupport(current.root);
    expect(settled.terminationReason).toBe("supported");
    expect(settled.limits).toMatchObject({ maxRounds: 7, maxPresentedBytes: 2_353_284 });
    expect(settled.cost.rounds).toBe(5);
    expect(settled.cost.presentedBytes).toBeGreaterThan(786_432);
    expect(settled).not.toHaveProperty("exhaustedBounds");

    // The former defaults stop reading at their prompt bound; the run continues
    // with the evidence gathered and names the bound, its demand, and its remedy.
    stubEnvironment(FORMER_DEFAULTS);
    const former = await workspaceWith(roots, files);
    const outcome = await bindFirstPassKnowledge({
      request: updateRequest(RETRY_INSTRUCTION),
      ...bindingContext(former),
      ...compositionWith(BENCHMARK_WINDOW),
      supportModelBridge: bridge(),
      trackedSourceReader: inventoryReader(former.tracked),
    });
    const stopped = await retainedSupport(former.root);
    expect(stopped.limits).toMatchObject({ maxRounds: 4, maxPresentedBytes: 786_432 });
    const prompt = stopped.exhaustedBounds?.find((item) => item.bound === "maxPresentedBytes");
    expect(prompt).toBeDefined();
    const lines = outcome?.firstPassEvidenceWarnings ?? [];
    expect(lines[0]).toMatch(/^first-pass-evidence-gaps: first pass continued after /u);
    expect(lines).toContain(
      `first-pass-evidence-gaps: assessment prompt bytes needed ${grouped(prompt!.observed)}, over the limit of 786,432 (maxPresentedBytes, firstPass.maxPresentedBytes, firstPass.modelInputTokensPerTurn). To read more, raise DOCSFAB_FIRST_PASS_MAX_PRESENTED_BYTES (up to 67,108,864), DOCSFAB_FIRST_PASS_MODEL_INPUT_TOKENS_PER_TURN (up to 4,194,304).`,
    );
  });

  it("sizes the prompt from the selected composition's window, not the configured endpoint's", {
    timeout: CASE_MS,
  }, async () => {
    const files = { "docs/guide.md": GUIDE, "src/widget/retry_backoff.py": RETRY_SOURCE };
    // The configured endpoint claims a different, smaller window; the
    // composition the run selected is the one first pass is bound to.
    const workspace = await workspaceWith(roots, files);
    await bindFirstPassKnowledge({
      request: updateRequest(RETRY_INSTRUCTION),
      ...bindingContext(workspace, { maxInputTokens: 65_536, reservedContextTokens: 1_024 }),
      ...compositionWith({ maxInputTokens: 524_288, reservedContextTokens: 4_096 }),
      supportModelBridge: implementationBridge("src/widget/retry_backoff.py"),
      trackedSourceReader: inventoryReader(workspace.tracked),
    });
    const support = await retainedSupport(workspace.root);
    expect(support.terminationReason).toBe("supported");
    expect(support.limits.maxPresentedBytes).toBe(1_170_432);
  });

  it("offers a prompt of exactly a raised bound past 786,432 bytes and, one byte under it, continues with a coded limitation naming the demand, limit, and remedy", {
    timeout: CASE_MS,
  }, async () => {
    // One window of about 800 KB: past the former bound, which the former
    // per-turn share held even when the ceiling override was raised.
    const files = {
      "docs/guide.md": GUIDE,
      "src/widget/retry_backoff.py": oneWindowSource("RETRY_BACKOFF_SECONDS = 30", 20, 50_000),
    };
    const run = runner(files);
    // Measured with every setting that bounds the prompt at its maximum.
    const measured = (
      await run({
        environment: {
          DOCSFAB_FIRST_PASS_MAX_PRESENTED_BYTES: String(
            limitDefinition("firstPass.maxPresentedBytes").max,
          ),
          DOCSFAB_FIRST_PASS_MODEL_INPUT_TOKENS_PER_TURN: String(
            limitDefinition("firstPass.modelInputTokensPerTurn").max,
          ),
        },
      })
    ).support;
    expect(measured.terminationReason).toBe("supported");
    const needed = measured.cost.presentedBytes;
    expect(needed).toBeGreaterThan(786_432);

    // Only the setting the stop below names, raised to exactly the prompt.
    const atLimit = await run({
      environment: { DOCSFAB_FIRST_PASS_MAX_PRESENTED_BYTES: String(needed) },
    });
    expect(atLimit.outcome).not.toBeInstanceOf(Error);
    expect(atLimit.support).toMatchObject({
      terminationReason: "supported",
      limits: { maxPresentedBytes: needed },
      cost: { presentedBytes: needed },
    });
    expect(atLimit.support).not.toHaveProperty("exhaustedBounds");

    const over = await run({
      environment: { DOCSFAB_FIRST_PASS_MAX_PRESENTED_BYTES: String(needed - 1) },
    });
    expect(over.support.exhaustedBounds).toEqual([
      { bound: "maxPresentedBytes", observed: needed, limit: needed - 1 },
    ]);
    // A gathering bound is a limitation, not a stop (#2113): the run goes on
    // with the evidence gathered, and the record names the bound and its remedy.
    expect(over.outcome).not.toBeInstanceOf(Error);
    expect(gapLines(over.outcome)).toEqual([
      "first-pass-evidence-gaps: first pass continued after 1 assessment round with 1 mandatory obligation its repository evidence did not support. It ended budget-exhausted: an evidence bound stopped its reading. The run used the evidence first pass gathered; to give an obligation its evidence, name its source by path in the request or with --source <path>.",
      "first-pass-evidence-gaps: obligation decomposed-implementation is missing.",
      `first-pass-evidence-gaps: assessment prompt bytes needed ${grouped(needed)}, over the limit of ${grouped(needed - 1)} (maxPresentedBytes, firstPass.maxPresentedBytes). To read more, raise DOCSFAB_FIRST_PASS_MAX_PRESENTED_BYTES (up to 67,108,864).`,
    ]);
  });

  it("sizes the prompt from the model's window, names the share when it binds, and lets its override raise it", {
    timeout: CASE_MS,
  }, async () => {
    const run = runner({
      "docs/guide.md": GUIDE,
      "src/widget/retry_backoff.py": oneWindowSource("RETRY_BACKOFF_SECONDS = 30", 20, 500),
    });
    const needed = (await run({})).support.cost.presentedBytes;
    // A window whose whole share holds the prompt and whose default share does not.
    const inputTokens = Math.ceil(needed / 3);
    const window = { maxInputTokens: inputTokens + 4_096, reservedContextTokens: 4_096 };
    const shareBound = 3 * Math.floor(0.75 * inputTokens);
    expect(shareBound).toBeLessThan(needed);

    const narrow = await run({ window });
    expect(narrow.support.limits.maxPresentedBytes).toBe(shareBound);
    expect(boundLine(narrow.outcome, "maxPresentedBytes")).toBe(
      `first-pass-evidence-gaps: assessment prompt bytes needed ${grouped(needed)}, over the limit of ${grouped(shareBound)} (maxPresentedBytes, firstPass.assessmentInputWindowShare). To read more, raise DOCSFAB_FIRST_PASS_ASSESSMENT_INPUT_WINDOW_SHARE (up to 1). ${WINDOW_SENTENCE}`,
    );

    const whole = await run({
      window,
      environment: { DOCSFAB_FIRST_PASS_ASSESSMENT_INPUT_WINDOW_SHARE: "1" },
    });
    expect(whole.outcome).not.toBeInstanceOf(Error);
    expect(whole.support).toMatchObject({
      terminationReason: "supported",
      limits: { maxPresentedBytes: 3 * inputTokens },
    });
  });

  it("holds the prompt in the smallest window share that fits it and stops one token under, at a share of 1", {
    timeout: CASE_MS,
  }, async () => {
    const run = runner({ "docs/guide.md": GUIDE, "src/widget/retry_backoff.py": RETRY_SOURCE });
    const needed = (await run({})).support.cost.presentedBytes;
    const share = { DOCSFAB_FIRST_PASS_ASSESSMENT_INPUT_WINDOW_SHARE: "1" };
    // At a share of 1 the bound is three bytes per token of the window after its reserve.
    const fitting = Math.ceil(needed / 3);
    const at = await run({
      window: { maxInputTokens: fitting + 2_048, reservedContextTokens: 2_048 },
      environment: share,
    });
    expect(at.outcome).not.toBeInstanceOf(Error);
    expect(at.support).toMatchObject({
      terminationReason: "supported",
      limits: { maxPresentedBytes: 3 * fitting },
    });
    expect(at.support).not.toHaveProperty("exhaustedBounds");

    const under = await run({
      window: { maxInputTokens: fitting - 1 + 2_048, reservedContextTokens: 2_048 },
      environment: share,
    });
    expect(under.support.exhaustedBounds).toEqual([
      { bound: "maxPresentedBytes", observed: needed, limit: 3 * (fitting - 1) },
    ]);
    // The share is already 1, so only a larger window raises the prompt.
    expect(boundLine(under.outcome, "maxPresentedBytes")).toBe(
      `first-pass-evidence-gaps: assessment prompt bytes needed ${grouped(needed)}, over the limit of ${grouped(3 * (fitting - 1))} (maxPresentedBytes, firstPass.assessmentInputWindowShare). ${WINDOW_SENTENCE}`,
    );
  });

  it("holds the prompt in the smallest turn share that fits it and stops one token under", {
    timeout: CASE_MS,
  }, async () => {
    const run = runner({ "docs/guide.md": GUIDE, "src/widget/retry_backoff.py": RETRY_SOURCE });
    const needed = (await run({})).support.cost.presentedBytes;
    const fitting = Math.ceil(needed / 3);
    const at = await run({
      window: BENCHMARK_WINDOW,
      environment: { DOCSFAB_FIRST_PASS_MODEL_INPUT_TOKENS_PER_TURN: String(fitting) },
    });
    expect(at.outcome).not.toBeInstanceOf(Error);
    expect(at.support).toMatchObject({
      terminationReason: "supported",
      limits: { maxPresentedBytes: 3 * fitting },
    });

    const under = await run({
      window: BENCHMARK_WINDOW,
      environment: { DOCSFAB_FIRST_PASS_MODEL_INPUT_TOKENS_PER_TURN: String(fitting - 1) },
    });
    expect(under.support.exhaustedBounds).toEqual([
      { bound: "maxPresentedBytes", observed: needed, limit: 3 * (fitting - 1) },
    ]);
    expect(boundLine(under.outcome, "maxPresentedBytes")).toBe(
      `first-pass-evidence-gaps: assessment prompt bytes needed ${grouped(needed)}, over the limit of ${grouped(3 * (fitting - 1))} (maxPresentedBytes, firstPass.modelInputTokensPerTurn). To read more, raise DOCSFAB_FIRST_PASS_MODEL_INPUT_TOKENS_PER_TURN (up to 4,194,304).`,
    );
  });

  it("offers 2,048 spans at the default span bound and names the bound when a 2,049th is needed", {
    timeout: CASE_MS,
  }, async () => {
    const limitSpans = limitDefinition("firstPass.maxSpans").value;
    expect(limitSpans).toBe(2_048);
    const diff = "upstream/release.diff";
    // The target page takes one span; every 120-line window of the named diff
    // takes one more, and the obligation needs every one of them offered.
    const run = async (diffWindows: number) => {
      const lines = Array.from({ length: diffWindows * 120 }, () => "+x");
      const workspace = await workspaceWith(roots, {
        "docs/changes.md": "# Changes\n\nThe release changes defaults.\n",
        [diff]: `${lines.join("\n")}\n`,
      });
      const outcome = await bindFirstPassKnowledge({
        request: updateRequest(`Update docs/changes.md to describe the defaults in ${diff}.`),
        ...bindingContext(workspace),
        supportModelBridge: scriptedBridge({
          obligations: [{ id: "decomposed-diff", condition: "The page covers the whole diff." }],
          assess: (_id, spanByPath, frames) =>
            frames.filter((frame) => frame.path === diff).length === diffWindows
              ? supported(spanByPath.get(diff)!)
              : missing("Part of the diff was not offered."),
        }),
        trackedSourceReader: inventoryReader(workspace.tracked),
      }).catch((caught: unknown) => caught);
      return { outcome, support: await retainedSupport(workspace.root) };
    };

    const atLimit = await run(limitSpans - 1);
    expect(atLimit.outcome).not.toBeInstanceOf(Error);
    expect(atLimit.support.terminationReason).toBe("supported");
    expect(atLimit.support.cost.spans).toBe(limitSpans);
    expect(atLimit.support).not.toHaveProperty("exhaustedBounds");

    const over = await run(limitSpans);
    expect(over.support.exhaustedBounds).toEqual([
      { bound: "maxSpans", observed: limitSpans + 1, limit: limitSpans },
    ]);
    expect(boundLine(over.outcome, "maxSpans")).toBe(
      `first-pass-evidence-gaps: evidence spans offered needed ${grouped(limitSpans + 1)}, over the limit of ${grouped(limitSpans)} (maxSpans, firstPass.maxSpans). To read more, raise DOCSFAB_FIRST_PASS_MAX_SPANS (up to 1,000,000).`,
    );
  });

  it("settles in the last allowed round and, when an eighth round is needed, continues naming the round allowance as a real need", {
    timeout: CASE_MS,
  }, async () => {
    // One ranked source and one chain file a round: the chain file the last
    // assessment names is read next, and seven chain steps fill seven rounds.
    const files: Record<string, string> = { "docs/guide.md": GUIDE };
    for (let step = 1; step <= 8; step += 1) {
      files[chainPath(step)] = `step ${String(step)} of the chained setting\n`;
    }
    for (let index = 1; index <= 20; index += 1) {
      files[`src/filler/f${String(index).padStart(2, "0")}.py`] = `VALUE_${String(index)} = 0\n`;
    }
    const run = async (need: number, sideAt?: number) => {
      const workspace = await workspaceWith(roots, files);
      const outcome = await bindFirstPassKnowledge({
        request: updateRequest(CHAIN_INSTRUCTION),
        ...bindingContext(workspace),
        supportModelBridge: chainBridge(need, sideAt),
        trackedSourceReader: inventoryReader(workspace.tracked),
      }).catch((caught: unknown) => caught);
      return { outcome, support: await retainedSupport(workspace.root) };
    };
    vi.stubEnv("DOCSFAB_FIRST_PASS_MAX_SOURCE_FILES", "14");

    // At the limit: the sixth step arrives in round 7, the last the default allows.
    const atLimit = await run(6);
    expect(atLimit.outcome).not.toBeInstanceOf(Error);
    expect(atLimit.support.terminationReason).toBe("supported");
    expect(atLimit.support.limits.maxRounds).toBe(7);
    expect(atLimit.support.cost.rounds).toBe(7);
    expect(atLimit.support.exhaustedBounds?.map((item) => item.bound) ?? []).not.toContain(
      "maxRounds",
    );

    // One round over: the seventh step needs round 8. Every round followed the
    // file the last assessment named, so the eighth round is a real need (#2113),
    // and the side obligation the last round settled makes the allowance the
    // cause. The run continues and names the allowance and how to raise it.
    const over = await run(7, 6);
    expect(over.support.cost.rounds).toBe(7);
    expect(over.support.terminationReason).toBe("budget-exhausted");
    expect(over.support.exhaustedBounds).toContainEqual({
      bound: "maxRounds",
      observed: 8,
      limit: 7,
    });
    expect(boundLine(over.outcome, "maxRounds")).toBe(
      "first-pass-evidence-gaps: assessment rounds needed 8, over the limit of 7 (maxRounds, firstPass.evidenceExpansionModelTurns). To read more, raise DOCSFAB_FIRST_PASS_EVIDENCE_EXPANSION_MODEL_TURNS (up to 16), DOCSFAB_FIRST_PASS_MAX_SOURCE_FILES (up to 100,000). Each round reads an even share of DOCSFAB_FIRST_PASS_MAX_SOURCE_FILES, so raise both.",
    );
    expect(gapLines(over.outcome)).toContain(
      "first-pass-evidence-gaps: obligation decomposed-chain is missing.",
    );

    // The host override raises the allowance, and the same request settles in round 8.
    vi.stubEnv("DOCSFAB_FIRST_PASS_EVIDENCE_EXPANSION_MODEL_TURNS", "7");
    vi.stubEnv("DOCSFAB_FIRST_PASS_MAX_SOURCE_FILES", "16");
    const raised = await run(7, 6);
    expect(raised.outcome).not.toBeInstanceOf(Error);
    expect(raised.support.terminationReason).toBe("supported");
    expect(raised.support.limits.maxRounds).toBe(8);
    expect(raised.support.cost.rounds).toBe(8);
  });
});

const GUIDE = "# Guide\n\nThe widget client retries.\n";
const RETRY_INSTRUCTION =
  "Update docs/guide.md to describe how the widget scheduler retries with backoff.";
const CHAIN_INSTRUCTION = "Update docs/guide.md to describe the chained widget setting.";

/** A ranked source of three term windows, about 4 KB offered. */
function rankedSource(index: number): string {
  const lines: string[] = [];
  for (let line = 0; line < 80; line += 1) {
    lines.push(
      line % 27 === 13
        ? `RETRY_BACKOFF_${String(index)}_${String(line)} = ${String(line)}  # widget scheduler retry backoff`
        : `value_${String(index)}_${String(line)} = compute_widget_step(${String(line)}, factor=0.5)`,
    );
  }
  return `${lines.join("\n")}\n`;
}

/** A source short enough to be offered in one window around its first term hit. */
function oneWindowSource(marker: string, lineCount: number, lineBytes: number): string {
  const lines = [marker];
  for (let line = 1; line < lineCount; line += 1) {
    lines.push(`# ${"x".repeat(lineBytes)}`);
  }
  return `${lines.join("\n")}\n`;
}

const RETRY_SOURCE = oneWindowSource("RETRY_BACKOFF_SECONDS = 30", 20, 400);

function chainPath(step: number): string {
  return `chain/step-${String(step).padStart(2, "0")}.dat`;
}

/**
 * Runs one retry request over fresh copies of `files`, with an optional
 * selected composition window and host overrides, and returns the outcome
 * and the retained support record.
 */
function runner(files: Record<string, string>) {
  return async (options: { window?: ModelWindow; environment?: Record<string, string> }) => {
    vi.unstubAllEnvs();
    stubEnvironment(options.environment ?? {});
    const workspace = await workspaceWith(roots, files);
    const outcome = await bindFirstPassKnowledge({
      request: updateRequest(RETRY_INSTRUCTION),
      ...bindingContext(workspace),
      ...(options.window ? compositionWith(options.window) : {}),
      supportModelBridge: implementationBridge("src/widget/retry_backoff.py"),
      trackedSourceReader: inventoryReader(workspace.tracked),
    }).catch((caught: unknown) => caught);
    return { outcome, support: await retainedSupport(workspace.root) };
  };
}

/**
 * The chain obligation is supported once step `need` is offered; until then
 * its detail names the next step, which the next round reads. The side
 * obligation, when present, is supported once step `sideAt` is offered.
 */
function chainBridge(need: number, sideAt?: number): FirstPassSupportModelBridge {
  return scriptedBridge({
    obligations: [
      { id: "decomposed-chain", condition: "The guide states the final chained setting." },
      ...(sideAt === undefined
        ? []
        : [{ id: "decomposed-side", condition: "The guide states the side setting." }]),
    ],
    assess: (id, spanByPath) => {
      if (id === "decomposed-side") {
        const span = spanByPath.get(chainPath(sideAt!));
        return span ? supported(span) : missing("The side setting is not offered yet.");
      }
      const span = spanByPath.get(chainPath(need));
      if (span) return supported(span);
      let next = 1;
      while (spanByPath.has(chainPath(next))) next += 1;
      return missing(`The setting continues in ${chainPath(next)}.`);
    },
  });
}

async function doctorLimits(): Promise<string> {
  const lines: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (message?: unknown) => lines.push(String(message ?? ""));
  console.error = (message?: unknown) => lines.push(String(message ?? ""));
  try {
    await handleDoctorCommand(["--limits"]);
  } finally {
    console.log = log;
    console.error = error;
  }
  return lines.join("\n");
}
