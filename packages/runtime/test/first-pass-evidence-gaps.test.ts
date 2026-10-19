// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * First pass converges, and continues past evidence gaps with a coded
 * limitation (#2113).
 *
 * In the rr-20261007a benchmark rerun at 1a293eabb, SR-1 explicit r1, W1 DY-1
 * seeded r1, and W2 MB-3 unseeded r1 stopped at first pass on three
 * repositories with the same values: 8 rounds needed against 7, and 449
 * source files against 448. Each value was written as one past its limit, and
 * the even per-round share spends exactly 448 files over 7 rounds, so any
 * first pass whose open obligation no source closes reported them. Every span
 * SR-1's last assessment cited came from its first 64 files.
 *
 * The replays here keep each cell's recorded inventory size, its open
 * obligations, and the catalog defaults, and run the real knowledge gather and
 * runtime validation with a tool-free model. The run-record cases read the
 * lines a continuing first pass records back through the operator summary and
 * `runs show` with and without `--json`; first-pass-evidence-gaps-journey
 * follows them from a run to the saved record.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { decodeSavedRunRecord, handleRunsCommand } from "../src/cli/commands/runs.js";
import { bindFirstPassKnowledge } from "../src/cli/first-pass.js";
import { FIRST_PASS_EVIDENCE_GAPS_LIMITATION } from "../src/cli/first-pass-evidence-gaps.js";
import type { RunRequestWithPublishProjection } from "../src/cli/run/request.js";
import { limitDefinition } from "../src/config/limits.js";
import { canonicalizeJsonEvidence } from "../src/json-evidence.js";
import { formatRunSummary } from "../src/operator/run-summary.js";
import type { RunRecord } from "../src/records/contracts.js";
import { appendEvidenceWarnings } from "../src/workflow-execution/runner-evidence.js";
import {
  type Assessment,
  bindingContext,
  inventoryReader,
  missing,
  retainedSupport,
  scriptedBridge,
  supported,
  workspaceWith,
} from "./helpers/first-pass-bounds-fixture.js";
import { temporaryRoots } from "./helpers/temp.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";

const roots = temporaryRoots();
// Each replay writes a repository and runs real gather and validation.
const CASE_MS = testTimeoutMs(90_000);
const GAP = "first-pass-evidence-gaps: ";

afterEach(() => {
  process.exitCode = undefined;
  vi.unstubAllEnvs();
});

/** Sources that rank above every padded inventory entry; more than the 448 default. */
const RANKED_SOURCES = 460;

function request(
  workflow: "create-documentation" | "update-documentation",
  instruction: string,
): RunRequestWithPublishProjection {
  return {
    workflow,
    repositoryPath: "/repository",
    revision: "HEAD",
    instruction,
    allowWrite: true,
    releaseGate: false,
    verbose: false,
    json: false,
    showScan: false,
  };
}

/**
 * The cell's repository: its pages and named sources, `RANKED_SOURCES` small
 * settings sources every request term ranks alike, and padded inventory
 * entries up to the cell's recorded tracked-file count. The padding has none
 * of the request's terms and sorts after every written source, so it is
 * listed but never read.
 */
async function cellRepository(files: Record<string, string>, trackedFiles: number) {
  const written: Record<string, string> = { ...files };
  for (let index = 0; index < RANKED_SOURCES; index += 1) {
    written[`src/settings/settings_${String(index).padStart(3, "0")}.go`] =
      `package settings\n\n// settings value ${String(index)}\nconst Value${String(index)} = ${String(index)}\n`;
  }
  const workspace = await workspaceWith(roots, written);
  const padding = Array.from(
    { length: trackedFiles - workspace.tracked.length },
    (_entry, index) => `zzpadding/entry_${String(index).padStart(5, "0")}.txt`,
  );
  return { ...workspace, inventory: [...workspace.tracked, ...padding].sort() };
}

interface Cell {
  /** The rr-20261007a cell and its recorded support record. */
  readonly cell: string;
  readonly workflow: "create-documentation" | "update-documentation";
  readonly trackedFiles: number;
  readonly instruction: string;
  readonly files: Record<string, string>;
  readonly obligations: readonly {
    id: string;
    condition: string;
    requiredSourceSupport?: boolean;
  }[];
  /** The cell's open obligations, by id or by the target page a seed binds. */
  readonly open: ReadonlyMap<string, Assessment>;
  /** The span a supported obligation cites. */
  readonly evidencePath: string;
  /**
   * Sources two rounds read at the 64-file share. A page a create writes is
   * not a file yet: its read attempt spends the first round's share and adds
   * no source, so the second round's share is a little larger.
   */
  readonly twoRoundSources: number;
}

const SR1: Cell = {
  // lane-h sr1 lx-explicit-r1, knowledge/first-pass/44941fc4…/docsfab-first-pass-support.json:
  // update of two pages, 7,232 tracked files scanned, open: implementation
  // sources (the configuration defaults) and the project's rule for new keys.
  cell: "SR-1 explicit r1",
  workflow: "update-documentation",
  trackedFiles: 7_232,
  instruction:
    "Update docs/api-and-observability.md and docs/configuration.md to document the optional profiling listener configured under the observability settings. The implementation is in src/router/profiling.go, src/router/metrics_server.go, and the configuration defaults. Follow the project's rule for new configuration keys, and keep related pages consistent with the change.",
  files: {
    "docs/api-and-observability.md": "# API and observability\n\nThe router serves metrics.\n",
    "docs/configuration.md": "# Configuration\n\nThe router reads its settings file.\n",
    "src/router/profiling.go":
      "package router\n\n// StartProfiling serves pprof on its own listener when enabled.\nfunc StartProfiling() {}\n",
    "src/router/metrics_server.go": "package router\n\n// The metrics server keeps its own mux.\n",
  },
  obligations: [
    {
      id: "decomposed-profiling-listener",
      condition: "The router serves profiling endpoints on an optional listener.",
    },
    {
      id: "decomposed-implementation-sources",
      condition: "The implementation includes the configuration defaults.",
    },
    {
      id: "decomposed-new-key-rule",
      condition: "Following the project's rule for new configuration keys",
    },
  ],
  open: new Map([
    [
      "decomposed-implementation-sources",
      missing("The offered spans do not show the configuration defaults."),
    ],
    [
      "decomposed-new-key-rule",
      missing("No offered span states the rule for documenting new keys."),
    ],
  ]),
  evidencePath: "src/router/profiling.go",
  twoRoundSources: 128,
};

const DY1: Cell = {
  // w1 dy1 seeded-docsfab-r1, knowledge/first-pass/bfc492ae…/docsfab-first-pass-support.json:
  // create of five pages, 5,204 tracked files scanned, open: the install page,
  // the supported-artifacts page, and the release artifacts the request states.
  cell: "W1 DY-1 seeded r1",
  workflow: "create-documentation",
  trackedFiles: 5_204,
  instruction:
    "Create docs/enterprise/overview.md, docs/enterprise/install.md, docs/enterprise/scope-boundaries.md, docs/enterprise/support-coverage.md, and docs/enterprise/supported-artifacts.md, an Enterprise section that tells users what enterprise support covers. The supported artifacts for the current release line are the enterprise images at version 1.4.2. The onboarding plan and the release process notes are in product/onboarding-plan.txt and product/release-process.txt.",
  files: {
    "product/onboarding-plan.txt":
      "Enterprise onboarding plan: support covers the platform components.\n",
    "product/release-process.txt":
      "Release process: enterprise labels qualify each release line.\n",
  },
  obligations: [
    {
      id: "decomposed-enterprise-coverage",
      condition: "The section says what enterprise support covers.",
    },
    {
      id: "decomposed-release-artifacts",
      condition: "The supported artifacts are the enterprise images at version 1.4.2.",
    },
    {
      id: "decomposed-product-notes",
      condition: "The onboarding plan and the release process notes are in product/.",
    },
  ],
  open: new Map([
    [
      "docs/enterprise/install.md",
      missing("No offered source states an enterprise install procedure."),
    ],
    [
      "docs/enterprise/supported-artifacts.md",
      missing("No offered source verifies the stated image versions."),
    ],
    [
      "decomposed-release-artifacts",
      missing("The stated image versions are not in the offered evidence."),
    ],
  ]),
  evidencePath: "product/onboarding-plan.txt",
  twoRoundSources: 124,
};

const MB3: Cell = {
  // wave2 mb3 unseeded-docsfab-r1, knowledge/first-pass/0afd3c02…/docsfab-first-pass-support.json:
  // create of one page, 2,651 tracked files scanned, open: the page and every
  // design fact, which only the unseeded research deck held.
  cell: "W2 MB-3 unseeded r1",
  workflow: "create-documentation",
  trackedFiles: 2_651,
  instruction:
    "Create docs/training/draft-speculative-decoding.md, a design document that explains how a draft model works and how it is trained, describes where it fits in the training stack today, and proposes a design. Use the research team's deep-dive deck in product/ as grounding.",
  files: {
    "docs/training/multi-token-prediction.md":
      "# Multi-token prediction\n\nThe training stack supports MTP.\n",
  },
  obligations: [
    {
      id: "decomposed-design-format",
      condition: "Write a design document",
      requiredSourceSupport: false,
    },
    {
      id: "decomposed-draft-and-training",
      condition: "Explain how a draft model works and how it is trained.",
    },
    {
      id: "decomposed-current-fit",
      condition: "Describe where it fits in the training stack today.",
    },
    { id: "decomposed-design-proposal", condition: "Propose a design." },
    {
      id: "decomposed-research-deck-source",
      condition: "Use the research team's deep-dive deck as grounding.",
    },
  ],
  open: new Map([
    [
      "docs/training/draft-speculative-decoding.md",
      missing("The offered evidence does not ground the page."),
    ],
    ["decomposed-draft-and-training", missing("The offered spans explain MTP, not a draft model.")],
    [
      "decomposed-current-fit",
      missing("The offered spans do not establish the draft model's fit."),
    ],
    ["decomposed-design-proposal", missing("The offered evidence does not ground the design.")],
    [
      "decomposed-research-deck-source",
      { status: "unavailable", evidenceSpanIds: [], detail: "No excerpt of the deck was offered." },
    ],
  ]),
  evidencePath: "docs/training/multi-token-prediction.md",
  twoRoundSources: 128,
};

/** The model the cell's records show: what it left open stays open every round. */
function cellBridge(cell: Cell) {
  const cite = (spanByPath: ReadonlyMap<string, string>): Assessment =>
    supported(spanByPath.get(cell.evidencePath) ?? [...spanByPath.values()][0]!);
  return scriptedBridge({
    obligations: cell.obligations,
    assess: (id, spanByPath) => {
      const open = cell.open.get(id);
      if (open) return open;
      const declared = cell.obligations.find((item) => item.id === id);
      return declared?.requiredSourceSupport === false
        ? { status: "supported", evidenceSpanIds: [], detail: "Bound by the instruction." }
        : cite(spanByPath);
    },
    seeded: (obligation, spanByPath) => {
      const open = cell.open.get(obligation.targetPaths[0]!);
      if (open && /^target-\d+$/u.test(obligation.id)) return open;
      // A page this create writes is not yet a file; its support cites the evidence.
      return cell.workflow === "create-documentation" && /^target-\d+$/u.test(obligation.id)
        ? cite(spanByPath)
        : undefined;
    },
  });
}

async function replay(cell: Cell) {
  const repository = await cellRepository(cell.files, cell.trackedFiles);
  const statuses: string[] = [];
  const binding = await bindFirstPassKnowledge({
    request: request(cell.workflow, cell.instruction),
    ...bindingContext(repository),
    status: (message: string) => statuses.push(message),
    supportModelBridge: cellBridge(cell),
    trackedSourceReader: inventoryReader(repository.inventory),
  });
  return { binding, statuses, support: await retainedSupport(repository.root) };
}

/**
 * The replayed cell converges after two rounds at the defaults, reaches no
 * bound, and continues with each open obligation named in its coded lines.
 */
async function expectConverged(cell: Cell): Promise<void> {
  const { binding, statuses, support } = await replay(cell);
  // The recorded repository size, read to the second round's share and no further.
  expect(support.cost.scannedFiles).toBe(cell.trackedFiles);
  expect(support.limits).toMatchObject({ maxRounds: 7, maxSourceFiles: 448 });
  expect(support.cost.rounds).toBe(2);
  expect(support.cost.sourceFiles).toBe(cell.twoRoundSources);
  // Decomposition, completeness, and two assessments; the cells spent nine.
  expect(support.cost.modelTurns).toBe(4);
  expect(support.terminationReason).toBe("no-progress");
  expect(support).not.toHaveProperty("exhaustedBounds");
  expect(support).not.toHaveProperty("unreadFiles");

  const open = support.obligations.filter((item) => item.status !== "supported");
  expect(open.length).toBe(cell.open.size);
  // The run continues to the workflow with every gap named and coded.
  expect(binding?.firstPassTargetControl?.targetPaths.length).toBeGreaterThan(0);
  const lines = binding?.firstPassEvidenceWarnings ?? [];
  expect(lines[0]).toMatch(
    new RegExp(
      `^${GAP}first pass continued after 2 assessment rounds with ${String(open.length)} mandatory obligations? its repository evidence did not support(, leaving \\d+ of \\d+ target pages? without page support of its own)?\\. It ended no-progress: its last round either did not reduce the number of open obligations or found no new evidence, so reading further was not expected to close one\\. The run used`,
      "u",
    ),
  );
  expect(lines.slice(1)).toEqual(
    open.map((item) => `${GAP}obligation ${item.id} is ${item.status}.`),
  );
  // No bound was reached, so none is named, and none is one past its limit.
  expect(lines.join("\n")).not.toMatch(/needed \d|DOCSFAB_FIRST_PASS_/u);
  expect(statuses).toEqual(expect.arrayContaining([...lines]));
}

/** A saved review run holding `evidenceWarnings`, as the run record keeps them. */
function savedRunRecord(runId: string, evidenceWarnings: readonly string[]): RunRecord {
  const review = canonicalizeJsonEvidence({ verdict: "approved", issues: [] });
  return {
    schemaVersion: 2,
    id: runId,
    workflow: "review-documentation",
    repository: {
      sourcePath: "/tmp/repository",
      requestedRevision: "HEAD",
      revision: "a".repeat(40),
    },
    workspace: { strategy: "tracked-export", disposable: true },
    status: "succeeded",
    createdAt: "2026-10-07T00:00:00.000Z",
    models: [],
    skills: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0 },
    tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
    evidenceWarnings: [...evidenceWarnings],
    steps: [
      {
        id: "review-documentation",
        title: "review-documentation",
        skill: "review-documentation",
        mode: "read-only",
        status: "succeeded",
        summary: review,
      },
    ],
  } as RunRecord;
}

/** What `docsfab runs show <run-id>` prints for a record holding `lines`, human or `--json`. */
async function showSavedRun(
  runId: string,
  lines: readonly string[],
  json: boolean,
): Promise<string> {
  const stateDirectory = await roots.create("docsfab-first-pass-gaps-runs-");
  await writeFile(
    join(stateDirectory, `${runId}.json`),
    `${JSON.stringify(savedRunRecord(runId, lines))}\n`,
    { mode: 0o600 },
  );
  const output: string[] = [];
  const log = console.log;
  console.log = (message?: unknown) => output.push(String(message ?? ""));
  try {
    await handleRunsCommand([
      "show",
      runId,
      ...(json ? ["--json"] : []),
      "--state-dir",
      stateDirectory,
    ]);
  } finally {
    console.log = log;
  }
  return output.join("\n");
}

describe("first pass on the recorded shapes of the cells that stopped at 8/7 and 449/448 (#2113)", () => {
  it("runs at the catalog defaults the cells ran at: 7 rounds and 448 sources, 64 a round", () => {
    const rounds = 1 + limitDefinition("firstPass.evidenceExpansionModelTurns").value;
    const sources = limitDefinition("firstPass.maxSourceFiles").value;
    expect(rounds).toBe(7);
    expect(sources).toBe(448);
    // The first round's even share; every later share is the same 64.
    expect(Math.ceil(sources / rounds)).toBe(64);
  });

  it("converges after two rounds on SR-1 explicit r1 and continues, naming each open obligation", {
    timeout: CASE_MS,
  }, async () => {
    await expectConverged(SR1);
  });

  it("converges after two rounds on W1 DY-1 seeded r1 and continues, naming each open obligation", {
    timeout: CASE_MS,
  }, async () => {
    await expectConverged(DY1);
  });

  it("converges after two rounds on W2 MB-3 unseeded r1 and continues, naming each open obligation", {
    timeout: CASE_MS,
  }, async () => {
    await expectConverged(MB3);
  });

  it("keeps reading while a later round closes a gap: the DD-2 shape settles in round 3", {
    timeout: CASE_MS,
  }, async () => {
    // wave2 dd2 seeded-docsfab-r1 settled in round 6, when the constants file
    // that closed its last gap was read. Here two gaps close in rounds 2 and 3
    // as their files arrive, 64 a round, so expansion continues and settles.
    // The closing files sit at ranks 100 and 150 of the equally ranked
    // settings sources, inside the second and third rounds' shares.
    const files = {
      "docs/models.md": "# Models\n\nThe default model settings.\n",
    };
    const bridge = (closers: Record<string, string>) =>
      scriptedBridge({
        obligations: [
          {
            id: "decomposed-default-alias",
            condition: "The documented default alias matches the code.",
          },
          {
            id: "decomposed-default-settings",
            condition: "The documented default settings match the code.",
          },
        ],
        assess: (id, spanByPath) => {
          const span = spanByPath.get(closers[id]!);
          return span ? supported(span) : missing("The defaults in the code are not offered yet.");
        },
      });
    const run = async (closers: Record<string, string>) => {
      const repository = await cellRepository(files, 1_500);
      const binding = await bindFirstPassKnowledge({
        request: request(
          "update-documentation",
          "Update docs/models.md so the documented default model settings match the settings code.",
        ),
        ...bindingContext(repository),
        supportModelBridge: bridge(closers),
        trackedSourceReader: inventoryReader(repository.inventory),
      });
      return { binding, support: await retainedSupport(repository.root) };
    };

    const settled = await run({
      "decomposed-default-alias": "src/settings/settings_100.go",
      "decomposed-default-settings": "src/settings/settings_150.go",
    });
    expect(settled.support.terminationReason).toBe("supported");
    expect(settled.support.cost.rounds).toBe(3);
    expect(settled.binding?.firstPassEvidenceWarnings).toBeUndefined();

    // The recorded DD-2 shape closed nothing in rounds 2 to 5. A round that
    // leaves as many gaps open now ends expansion, so a file that only
    // round 6 would have reached stays unread, and the run continues with
    // that gap named.
    const stalled = await run({
      "decomposed-default-alias": "src/settings/never-offered.go",
      "decomposed-default-settings": "src/settings/settings_150.go",
    });
    expect(stalled.support.terminationReason).toBe("no-progress");
    expect(stalled.support.cost.rounds).toBe(2);
    expect(stalled.binding?.firstPassEvidenceWarnings).toEqual(
      expect.arrayContaining([
        `${GAP}obligation decomposed-default-alias is missing.`,
        `${GAP}obligation decomposed-default-settings is missing.`,
      ]),
    );
  });

  it("follows a file an open gap names after a round that closed nothing, on the SR-1 shape", {
    timeout: CASE_MS,
  }, async () => {
    // SR-1's open gap wanted the configuration defaults. When the assessment
    // names the file that holds them, the next round reads it first.
    // None of the request's or the gap's words are in this path, so ranking
    // alone never reaches it before the share runs out.
    const defaults = "zz/core/base_values.go";
    const repository = await cellRepository(
      {
        ...SR1.files,
        [defaults]:
          "package config\n\n// Profiling is off by default.\nconst ProfilingEnabled = false\n",
      },
      SR1.trackedFiles,
    );
    let assessments = 0;
    const named = scriptedBridge({
      obligations: SR1.obligations,
      assess: (id, spanByPath) => {
        if (id === "decomposed-implementation-sources") {
          const span = spanByPath.get(defaults);
          if (span) return supported(span);
          return missing(
            assessments >= 2
              ? `The configuration defaults are in ${defaults}, which was not offered.`
              : "The offered spans do not show the configuration defaults.",
          );
        }
        return SR1.open.get(id) ?? supported(spanByPath.get(SR1.evidencePath)!);
      },
    });
    const counting = {
      ...named,
      call: async (call: Parameters<typeof named.call>[0]) => {
        if (!call.prompt.startsWith("Phase:")) assessments += 1;
        return named.call(call);
      },
    };
    const binding = await bindFirstPassKnowledge({
      request: request(SR1.workflow, SR1.instruction),
      ...bindingContext(repository),
      supportModelBridge: counting,
      trackedSourceReader: inventoryReader(repository.inventory),
    });
    const support = await retainedSupport(repository.root);
    // Round 2 closed nothing but named the file; round 3 read it and closed
    // that gap; round 4 closed nothing and named nothing, so first pass converged.
    expect(support.cost.rounds).toBe(4);
    expect(support.terminationReason).toBe("no-progress");
    expect(
      support.obligations.filter((item) => item.status !== "supported").map((item) => item.id),
    ).toEqual(["decomposed-new-key-rule"]);
    expect(binding?.firstPassEvidenceWarnings?.slice(1)).toEqual([
      `${GAP}obligation decomposed-new-key-rule is missing.`,
    ]);
  });

  it("keeps reading past a round that closed nothing while the request names a source the revision lacks", {
    timeout: CASE_MS,
  }, async () => {
    // The obligation closes only when the file at rank 150 of the 460 equally
    // ranked settings sources is offered, which the third round's share
    // reaches; round 2 closes nothing. A request that names a source the
    // revision lacks stops the run unless every gap closes, so the loop does
    // not converge at round 2 there: it reads on, as before #2113, and the
    // run continues supported. Converging at round 2 stopped it with
    // `insufficient-evidence`.
    const files = { "docs/guide.md": "# Guide\n\nThe widget saves state.\n" };
    const closer = "src/settings/settings_150.go";
    const run = async (instruction: string) => {
      const repository = await cellRepository(files, 1_500);
      const statuses: string[] = [];
      const binding = await bindFirstPassKnowledge({
        request: request("update-documentation", instruction),
        ...bindingContext(repository),
        status: (message: string) => statuses.push(message),
        supportModelBridge: scriptedBridge({
          obligations: [
            { id: "decomposed-values", condition: "The guide states the settings values." },
          ],
          assess: (_id, spanByPath) => {
            const span = spanByPath.get(closer);
            return span ? supported(span) : missing("The settings values are not offered yet.");
          },
        }),
        trackedSourceReader: inventoryReader(repository.inventory),
      });
      return { binding, statuses, support: await retainedSupport(repository.root) };
    };

    const named = await run(
      "Update docs/guide.md to document the settings values. The old notes are in upstream/gone.diff.",
    );
    expect(named.support.cost.rounds).toBe(3);
    expect(named.support.terminationReason).toBe("supported");
    expect(named.support.namedSourceGaps).toEqual([
      { path: "upstream/gone.diff", reason: "missing" },
    ]);
    expect(named.binding?.firstPassTargetControl?.targetPaths).toEqual(["docs/guide.md"]);
    // Every obligation is supported, so there is no gap line; the source the
    // revision lacks stays a stated limitation.
    expect(named.binding?.firstPassEvidenceWarnings).toBeUndefined();
    expect(named.statuses).toContain(
      "first-pass evidence has limitations, and every mandatory obligation is still supported: named source upstream/gone.diff is not a readable regular file in the selected revision.",
    );

    // Control: the same repository, model, and gap, with no source named that
    // the revision lacks. Round 2 closes nothing, so expansion converges there
    // and the run continues with the gap named.
    const unnamed = await run("Update docs/guide.md to document the settings values.");
    expect(unnamed.support.cost.rounds).toBe(2);
    expect(unnamed.support.terminationReason).toBe("no-progress");
    expect(unnamed.support).not.toHaveProperty("namedSourceGaps");
    expect(unnamed.binding?.firstPassEvidenceWarnings?.slice(1)).toEqual([
      `${GAP}obligation decomposed-values is missing.`,
    ]);
  });

  it("ends in unresolved-obligations when the last allowed round closed one gap and nothing is left to read", {
    timeout: CASE_MS,
  }, async () => {
    // Two rounds are allowed, and the six-source budget splits three and three,
    // so round 2 reads every source there is. It closes one of the two gaps, so
    // expansion has not converged, and the allowance ends it with nothing
    // unread: no bound is recorded, and the pass ends with obligations open.
    vi.stubEnv("DOCSFAB_FIRST_PASS_EVIDENCE_EXPANSION_MODEL_TURNS", "1");
    vi.stubEnv("DOCSFAB_FIRST_PASS_MAX_SOURCE_FILES", "6");
    const written: Record<string, string> = {
      "docs/guide.md": "# Guide\n\nThe widget saves state.\n",
    };
    for (let index = 0; index < 5; index += 1) {
      written[`src/widget_${String(index)}.go`] =
        `package widget\n\n// widget step ${String(index)}\nconst Step${String(index)} = ${String(index)}\n`;
    }
    const workspace = await workspaceWith(roots, written);
    const statuses: string[] = [];
    const binding = await bindFirstPassKnowledge({
      request: request(
        "update-documentation",
        "Update docs/guide.md to describe every widget step.",
      ),
      ...bindingContext(workspace),
      status: (message: string) => statuses.push(message),
      supportModelBridge: scriptedBridge({
        obligations: [
          { id: "decomposed-first-step", condition: "The guide describes the first widget step." },
          { id: "decomposed-last-step", condition: "The guide describes the last widget step." },
        ],
        // Closed once four sources are offered, which round 2 reaches and
        // round 1 does not; the other obligation is never supported.
        assess: (id, spanByPath) =>
          id === "decomposed-first-step" && spanByPath.size >= 4
            ? supported([...spanByPath.values()][0]!)
            : missing("No offered source states it."),
      }),
      trackedSourceReader: inventoryReader(workspace.tracked),
    });
    const support = await retainedSupport(workspace.root);
    expect(support.limits.maxRounds).toBe(2);
    expect(support.cost.rounds).toBe(2);
    expect(support.cost.sourceFiles).toBe(6);
    expect(support.terminationReason).toBe("unresolved-obligations");
    expect(support).not.toHaveProperty("exhaustedBounds");
    expect(support).not.toHaveProperty("unreadFiles");
    expect(binding?.firstPassEvidenceWarnings).toEqual([
      `${GAP}first pass continued after 2 assessment rounds with 1 mandatory obligation its repository evidence did not support. It ended unresolved-obligations: its reading ended with obligations still open. The run used the evidence first pass gathered; to give an obligation its evidence, name its source by path in the request or with --source <path>.`,
      `${GAP}obligation decomposed-last-step is missing.`,
    ]);
    expect(statuses).toEqual(
      expect.arrayContaining([...(binding?.firstPassEvidenceWarnings ?? [])]),
    );
  });
});

describe("unread files a bound left, with each path the request named (#2113)", () => {
  const NAMING =
    "Update docs/guide.md to describe the widget. The behavior is in src/alpha.go and src/beta.go.";
  const NOT_NAMING = "Update docs/guide.md to describe the widget.";

  /** One first pass over a repository of two sources and five more, under the host `env`. */
  async function firstPassWith(instruction: string, env: Record<string, string>) {
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    const written: Record<string, string> = {
      "docs/guide.md": "# Guide\n\nThe widget saves state.\n",
      "src/alpha.go": "package alpha\n\n// alpha handles the widget\nconst Alpha = 1\n",
      "src/beta.go": "package beta\n\n// beta handles the widget\nconst Beta = 2\n",
    };
    // Candidates the instruction does not name: a bound counts them unread, and
    // the lines never list them.
    for (let index = 0; index < 5; index += 1) {
      written[`src/gamma_${String(index)}.go`] =
        `package gamma\n\n// gamma ${String(index)} handles the widget\nconst Gamma${String(index)} = ${String(index)}\n`;
    }
    const workspace = await workspaceWith(roots, written);
    const statuses: string[] = [];
    const binding = await bindFirstPassKnowledge({
      request: request("update-documentation", instruction),
      ...bindingContext(workspace),
      status: (message: string) => statuses.push(message),
      supportModelBridge: scriptedBridge({
        obligations: [
          { id: "decomposed-behavior", condition: "The guide states the widget behavior." },
        ],
        assess: () => missing("Nothing offered states the behavior."),
      }),
      trackedSourceReader: inventoryReader(workspace.tracked),
    });
    return { binding, statuses, support: await retainedSupport(workspace.root) };
  }

  it("lists each unread path the request named, one to a line, and counts every unread file", {
    timeout: CASE_MS,
  }, async () => {
    // The target page spends the one-file budget, so both named sources stay
    // unread. Before #2113 the run stopped with `budget-exhausted` and its
    // message listed them; continuing must not hide which ones were left.
    const { binding, statuses, support } = await firstPassWith(NAMING, {
      DOCSFAB_FIRST_PASS_MAX_SOURCE_FILES: "1",
    });
    expect(support.terminationReason).toBe("budget-exhausted");
    expect(support.unreadFiles).toEqual({
      count: 7,
      namedPaths: ["src/alpha.go", "src/beta.go"],
    });
    const lines = [
      `${GAP}first pass continued after 1 assessment round with 1 mandatory obligation its repository evidence did not support. It ended budget-exhausted: an evidence bound stopped its reading. The run used the evidence first pass gathered; to give an obligation its evidence, name its source by path in the request or with --source <path>.`,
      `${GAP}obligation decomposed-behavior is missing.`,
      `${GAP}source files read needed 2, over the limit of 1 (maxSourceFiles, firstPass.maxSourceFiles). To read more, raise DOCSFAB_FIRST_PASS_MAX_SOURCE_FILES (up to 100,000).`,
      `${GAP}reading stopped with 7 candidate source files unread, 2 of them named by path.`,
      `${GAP}named path src/alpha.go was left unread.`,
      `${GAP}named path src/beta.go was left unread.`,
    ];
    expect(binding?.firstPassEvidenceWarnings).toEqual(lines);
    expect(statuses).toEqual(expect.arrayContaining(lines));
    // The unnamed candidates are counted, never listed.
    expect(lines.join("\n")).not.toContain("gamma");
  });

  it("counts the unread files and lists no path when the request named none", {
    timeout: CASE_MS,
  }, async () => {
    // Controls on the same repository. A request that names no source leaves
    // the same seven candidates unread at a budget of one file, and none of
    // them is named: the line counts them and lists nothing.
    const unnamed = await firstPassWith(NOT_NAMING, { DOCSFAB_FIRST_PASS_MAX_SOURCE_FILES: "1" });
    expect(unnamed.support.unreadFiles).toEqual({ count: 7, namedPaths: [] });
    expect(unnamed.binding?.firstPassEvidenceWarnings?.slice(3)).toEqual([
      `${GAP}reading stopped with 7 candidate source files unread.`,
    ]);
  });

  it("states no unread file when the request names two sources and the budget reads them", {
    timeout: CASE_MS,
  }, async () => {
    const roomy = await firstPassWith(NAMING, {});
    expect(roomy.support).not.toHaveProperty("unreadFiles");
    expect(roomy.support).not.toHaveProperty("exhaustedBounds");
    expect(roomy.binding?.firstPassEvidenceWarnings?.join("\n")).not.toMatch(/unread|named path/u);
  });

  it("keeps each path line inside what the run record holds, and shows it in runs show and --json", {
    timeout: CASE_MS,
  }, async () => {
    const { binding } = await firstPassWith(NAMING, { DOCSFAB_FIRST_PASS_MAX_SOURCE_FILES: "1" });
    const lines = [...(binding?.firstPassEvidenceWarnings ?? [])];
    const pathLines = [
      `${GAP}named path src/alpha.go was left unread.`,
      `${GAP}named path src/beta.go was left unread.`,
    ];
    expect(lines).toEqual(expect.arrayContaining(pathLines));
    const record = {} as RunRecord;
    appendEvidenceWarnings(record, lines);
    // The record kept every line as written: none was replaced by the
    // placeholder it keeps for a line it cannot hold.
    expect(record.evidenceWarnings).toEqual(lines);
    const human = await showSavedRun("run-first-pass-unread", lines, false);
    for (const line of lines) expect(human).toContain(line);
    for (const line of pathLines) expect(human).toContain(line);
    const result = JSON.parse(await showSavedRun("run-first-pass-unread", lines, true)) as {
      product: { limitations: string[] };
      limitOverflow?: string[];
    };
    expect(result.product.limitations).toContain(FIRST_PASS_EVIDENCE_GAPS_LIMITATION);
    expect(result.limitOverflow?.slice(0, lines.length)).toEqual(lines);
    expect(result.limitOverflow).toEqual(expect.arrayContaining(pathLines));
  });
});

describe("the evidence-gap lines on the run record, the operator summary, and the JSON result (#2113)", () => {
  const RUN_ID = "run-first-pass-gaps";
  const LINES = [
    `${GAP}first pass continued after 2 assessment rounds with 2 mandatory obligations its repository evidence did not support. It ended no-progress: its last round either did not reduce the number of open obligations or found no new evidence, so reading further was not expected to close one. The run used the evidence first pass gathered; to give an obligation its evidence, name its source by path in the request or with --source <path>.`,
    `${GAP}obligation decomposed-implementation-sources is missing.`,
    `${GAP}obligation decomposed-new-key-rule is missing.`,
  ];

  it("decodes as a saved record, and leads the LIMITATIONS footer of the operator summary", () => {
    const record = savedRunRecord(RUN_ID, [
      ...LINES,
      "credential-like-content: one file looks like it holds a credential.",
    ]);
    expect(
      decodeSavedRunRecord(JSON.parse(JSON.stringify(record)), RUN_ID).evidenceWarnings,
    ).toEqual(record.evidenceWarnings);
    const human = formatRunSummary({
      record,
      recordPath: `/private/state/${RUN_ID}.json`,
      exitCode: 0,
      repositoryPath: "/tmp/repository",
      tty: false,
      reportUnavailableReason: "no retained evaluator report",
    }).join("\n");
    const footer = human.slice(human.indexOf("LIMITATIONS"));
    expect(human).toContain("LIMITATIONS");
    for (const line of LINES) expect(footer).toContain(line);
    expect(footer.indexOf(LINES[0]!)).toBeLessThan(footer.indexOf("credential-like-content:"));
  });

  it("shows the lines in docsfab runs show, and the coded limitation with them in --json", async () => {
    const human = await showSavedRun(RUN_ID, LINES, false);
    for (const line of LINES) expect(human).toContain(line);
    const result = JSON.parse(await showSavedRun(RUN_ID, LINES, true)) as {
      product: { limitations: string[] };
      limitOverflow?: string[];
    };
    expect(result.product.limitations).toContain(FIRST_PASS_EVIDENCE_GAPS_LIMITATION);
    expect(result.limitOverflow?.slice(0, LINES.length)).toEqual(LINES);
  });
});
