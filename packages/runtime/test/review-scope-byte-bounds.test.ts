// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { handleRunsCommand } from "../src/cli/commands/runs.js";
import { handleWhyCommand } from "../src/cli/commands/why.js";
import { limit } from "../src/config/limits.js";
import { InferenceStepError, type HarnessStepInput } from "../src/execution/contracts.js";
import { hostFillRefusedJudgment } from "../src/harness/cut-judgment.js";
import { liveWorkflowScopeBoundStop } from "../src/live-agent/workflow-failure-gate.js";
import { buildRunHumanNextCommand } from "../src/operator/run-next-action.js";
import type { RunRecord, RunStore } from "../src/records/contracts.js";
import { prepareRepositoryWorkspace } from "../src/repository/workspace/materialize.js";
import { LocalWorkflowSearchCoordinator } from "../src/search/local-workflow-coordinator.js";
import { canonicalDigest } from "../src/contract-kit/index.js";
import { HOST_FILLED_COVERAGE_REASON } from "../src/workflow-execution/judgment-coverage.js";
import { WorkflowRunner } from "../src/workflow-execution/runner.js";
import {
  assertReviewScopeFitsProposalBound,
  decodeProvisionalVerificationJudgment,
  hostFilledCoverageBytes,
  judgmentOrigin,
  ReviewScopeBoundError,
} from "../src/workflow-execution/source-obligation.js";
import { classifyThrownFailure } from "../src/operator/failure-classification.js";
import { LocalSourceObligationSourceObserver } from "../src/workflow-execution/source-obligation-observer.js";
import { initFixtureRepo } from "./helpers/git.js";
import {
  RECORDED_JUDGMENT_TARGET,
  recordedReviewJudgmentFixture,
} from "./helpers/recorded-review-judgment.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";
import { publicReviewTargetScope } from "./fixtures/review-cli-correction/public-review-target-scope.js";
import { registerReviewScopeBoundReproduction } from "./scenarios/review-scope-bound-reproduction.scenario.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const PROPOSAL_BOUND = limit("technicalCorrection.proposalMaxBytes");
const MAX_TARGETS = limit("reviewScope.maxTargets").value;
const PATH_MAX_CHARS = limit("reviewScope.pathMaxChars").value;

/** `count` distinct documentation paths, each exactly `length` characters long. */
function pagesOfLength(count: number, length: number): string[] {
  return Array.from({ length: count }, (_, index) => {
    const stem = `docs/p${String(index).padStart(4, "0")}`;
    return `${stem}${"x".repeat(length - stem.length - ".md".length)}.md`;
  });
}

/** The floor reply the host builds once a step-4 judgment is refused with no retry left. */
function floorFor(targets: readonly string[]) {
  const fixture = recordedReviewJudgmentFixture("/workspace", { targets });
  const refusal = new InferenceStepError("refused", "malformed-response", false, undefined, {
    code: "invalid-accounting",
    location: "$response",
  });
  return {
    fixture,
    floor: hostFillRefusedJudgment(
      { ...fixture.provisional, inferenceAttempt: 4, finalInferenceAttempt: true },
      refusal,
    ),
  };
}

/** What a CLI handler prints through `console.log`. */
async function stdoutOf(action: () => Promise<unknown>): Promise<string> {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((message?: unknown) => {
    lines.push(String(message ?? ""));
  });
  try {
    await action();
  } finally {
    spy.mockRestore();
  }
  return lines.join("\n");
}

function refusal(run: () => unknown): InferenceStepError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(InferenceStepError);
    return error as InferenceStepError;
  }
  throw new Error("expected a refusal");
}

describe("the host-filled coverage a review scope carries", () => {
  it("is the canonical JSON of one host-filled entry per target page", () => {
    const targets = ["docs/a.md", "docs/b.md", "docs/a.md"];
    // Written out as the oracle: canonical JSON sorts keys and indents by two
    // spaces, which is what JSON.stringify writes for these sorted literals.
    const expected = JSON.stringify(
      ["docs/a.md", "docs/b.md"].map((path) => ({
        evidence: [],
        path,
        reason: HOST_FILLED_COVERAGE_REASON,
        status: "unverified",
      })),
      null,
      2,
    );

    expect(hostFilledCoverageBytes(targets)).toBe(Buffer.byteLength(expected, "utf8"));
  });
});

/**
 * Combined defaults: reviewScope.maxTargets and reviewScope.pathMaxChars bound
 * every focused scope reviewScope admits, and technicalCorrection.proposalMaxBytes
 * bounds what the judgment steps can hold for it. They do not contradict.
 */
describe("reviewScope.maxTargets at its default against the proposal bound", () => {
  const widest = pagesOfLength(MAX_TARGETS, PATH_MAX_CHARS);

  it("admits the recorded one-page, 18-obligation all-host proposal", () => {
    const { fixture, floor } = floorFor([RECORDED_JUDGMENT_TARGET]);
    expect(fixture.ledger.dimensions.flatMap(({ obligations }) => obligations)).toHaveLength(18);
    expect(hostFilledCoverageBytes([RECORDED_JUDGMENT_TARGET])).toBeLessThan(PROPOSAL_BOUND.value);
    expect(() =>
      decodeProvisionalVerificationJudgment(
        floor.reply,
        fixture.ledger,
        [RECORDED_JUDGMENT_TARGET],
        undefined,
        floor.coveragePolicy,
      ),
    ).not.toThrow();
  });

  it("admits the widest ASCII focused scope at run start", () => {
    expect(widest).toHaveLength(MAX_TARGETS);
    expect(widest.every((path) => path.length === PATH_MAX_CHARS)).toBe(true);
    const bytes = hostFilledCoverageBytes(widest);

    expect(bytes).toBeLessThan(PROPOSAL_BOUND.value);
    expect(() => assertReviewScopeFitsProposalBound(widest)).not.toThrow();
  });

  it("admits maxTargets pages while their paths average at most 768 UTF-8 bytes", () => {
    // Each host-filled entry costs its path's UTF-8 bytes plus 255 bytes.
    expect(() => assertReviewScopeFitsProposalBound(pagesOfLength(MAX_TARGETS, 768))).not.toThrow();
    expect(() => assertReviewScopeFitsProposalBound(pagesOfLength(MAX_TARGETS, 769))).toThrow(
      ReviewScopeBoundError,
    );
  });

  it("refuses the widest scope of two-byte characters, since pathMaxChars counts characters", () => {
    const twoByte = pagesOfLength(MAX_TARGETS, PATH_MAX_CHARS).map((path) =>
      path.replaceAll("x", "é"),
    );
    expect(twoByte.every((path) => path.length === PATH_MAX_CHARS)).toBe(true);

    expect(hostFilledCoverageBytes(twoByte)).toBe(324_098);
    expect(() => assertReviewScopeFitsProposalBound(twoByte)).toThrow(ReviewScopeBoundError);
  });

  it("holds the all-host floor over the widest focused scope and the recorded ledger", () => {
    const { fixture, floor } = floorFor(widest);

    const result = decodeProvisionalVerificationJudgment(
      floor.reply,
      fixture.ledger,
      widest,
      undefined,
      floor.coveragePolicy,
    );

    expect(result.review).toEqual({ verdict: "human-review", issues: [] });
    expect(result.coverage).toHaveLength(MAX_TARGETS);
  });
});

/**
 * The floor over one target page: its coverage is a few hundred bytes, but a
 * ledger whose 18 obligations each cite 64 long locators makes the host's own
 * accounting rows exceed the proposal bound. Only the host-built origin can
 * make this stop terminal, since the coverage-alone test does not fire.
 */
describe("a host-built floor over the proposal bound whose coverage fits", () => {
  const SOURCE = `src/${"s".repeat(200)}/${"m".repeat(200)}.mjs`;
  const TARGETS = [RECORDED_JUDGMENT_TARGET];

  function widenedFloor() {
    const fixture = recordedReviewJudgmentFixture("/workspace", {
      targets: TARGETS,
      widenLedger: { sourcePath: SOURCE, locatorsPerObligation: 64 },
    });
    const refused = new InferenceStepError("refused", "malformed-response", false, undefined, {
      code: "invalid-accounting",
      location: "$response",
    });
    const floor = hostFillRefusedJudgment(
      { ...fixture.provisional, inferenceAttempt: 4, finalInferenceAttempt: true },
      refused,
    );
    return { fixture, floor };
  }

  it("is a terminal host bound stop under the limit's own code, class bound", () => {
    const { fixture, floor } = widenedFloor();
    expect(hostFilledCoverageBytes(TARGETS)).toBeLessThan(PROPOSAL_BOUND.value);
    expect(judgmentOrigin(JSON.parse(floor.reply), fixture.ledger, floor.coveragePolicy)).toBe(
      "host",
    );

    const error = refusal(() =>
      decodeProvisionalVerificationJudgment(
        floor.reply,
        fixture.ledger,
        TARGETS,
        undefined,
        floor.coveragePolicy,
      ),
    );

    expect(error.retryable).toBe(false);
    expect(error.rejection).toEqual({
      code: "technical-correction-proposal-max-bytes-bound",
      location: "$response",
    });
    expect(error.message).toMatch(
      new RegExp(
        `^Technical correction response rejected: bounds-exceeded\\. technical-correction-proposal-max-bytes-bound: \\d+ exceeds technicalCorrection\\.proposalMaxBytes = 262144 bytes\\. .* Scope: 1 target pages and 18 source obligations; their host-filled coverage alone is ${hostFilledCoverageBytes(TARGETS)} bytes\\.$`,
        "u",
      ),
    );
    expect(classifyThrownFailure(error, "workflow")).toEqual({
      class: "bound",
      layer: "inference",
      code: "technical-correction-proposal-max-bytes-bound",
    });
  });
});

describe("judgmentOrigin", () => {
  const fixture = recordedReviewJudgmentFixture("/workspace");
  const ids = fixture.ledger.dimensions.flatMap((dimension) =>
    dimension.obligations.map(({ id }) => id),
  );
  const floorJudgment = { verdict: "human-review", coverage: [], issueJudgments: [] };
  const everyRow = { degradeCoverage: true, hostFilledObligationIds: new Set(ids) };

  it("reads the all-host floor as host", () => {
    expect(judgmentOrigin(floorJudgment, fixture.ledger, everyRow)).toBe("host");
  });

  it.each([
    ["no host-written rows", floorJudgment, { degradeCoverage: true }],
    [
      "one row the model wrote",
      floorJudgment,
      { degradeCoverage: true, hostFilledObligationIds: new Set(ids.slice(1)) },
    ],
    ["a coverage entry", { ...floorJudgment, coverage: [{ path: "docs/a.md" }] }, everyRow],
    ["an issue judgment", { ...floorJudgment, issueJudgments: [{ id: "TC-1" }] }, everyRow],
    ["no coverage member", { verdict: "human-review", issueJudgments: [] }, everyRow],
    ["a non-object reply", "{}", everyRow],
  ] as const)("reads a judgment with %s as the model's reply", (_label, judgment, policy) => {
    expect(judgmentOrigin(judgment, fixture.ledger, policy as never)).toBe("reply");
  });
});

describe("a judgment reply over the proposal bound", () => {
  it("is the model's to condense when the host-filled coverage for its scope fits", () => {
    // The reply's own coverage text, at its per-entry ceilings, is what pushes
    // the proposal over; the same pages host-filled fit with room to spare.
    // The recorded judgment's issues locate the recorded page, so it stays a target.
    const targets = [RECORDED_JUDGMENT_TARGET, ...pagesOfLength(MAX_TARGETS - 1, 40)];
    const fixture = recordedReviewJudgmentFixture("/workspace", { targets });
    const reasonMaxChars = limit("technicalCorrection.coverageReasonMaxChars").value;
    const evidenceEntries = limit("technicalCorrection.coverageEvidenceMaxEntries").value;
    const evidenceMaxChars = limit("technicalCorrection.coverageEvidenceEntryMaxChars").value;
    const answer = JSON.stringify({
      ...fixture.judgment,
      coverage: targets.map((path) => ({
        path,
        status: "unverified",
        evidence: Array.from(
          { length: evidenceEntries },
          (_, index) => `src/sprout.mjs:${index + 1}${"#".repeat(evidenceMaxChars - 20)}`,
        ),
        reason: "r".repeat(reasonMaxChars),
      })),
    });
    const coverageBytes = hostFilledCoverageBytes(targets);
    expect(coverageBytes).toBeLessThan(PROPOSAL_BOUND.value);

    const error = refusal(() =>
      decodeProvisionalVerificationJudgment(answer, fixture.ledger, targets, undefined, {
        degradeCoverage: true,
      }),
    );

    expect(error.rejection).toEqual({ code: "bounds-exceeded", location: "$response" });
    expect(error.message).toMatch(
      new RegExp(
        `^Technical correction response rejected: bounds-exceeded\\. The reply's own text puts it at (\\d+) bytes, over technicalCorrection\\.proposalMaxBytes = 262144 bytes \\(technical-correction-proposal-max-bytes-bound\\), so a condensed reply can fit\\. Scope: ${MAX_TARGETS} target pages and 18 source obligations; their host-filled coverage alone is ${coverageBytes} bytes\\.$`,
        "u",
      ),
    );
    const observed = Number(/puts it at (\d+) bytes/u.exec(error.message)![1]);
    expect(observed).toBeGreaterThan(PROPOSAL_BOUND.value);
    expect(error.retryable).toBe(true);
    // The live agent does not read the model's own overflow as a scope stop.
    expect(liveWorkflowScopeBoundStop(error.message)).toBeUndefined();
  });
});

registerReviewScopeBoundReproduction(publicReviewTargetScope());

/**
 * The offline acceptance fixture: a whole-documentation-set review of a real
 * Git checkout whose pages' host-filled coverage alone is over the proposal
 * bound. The runner refuses it before any step, so no model call is made.
 */
describe("a whole-documentation-set review over the proposal bound", () => {
  /** Few, long page paths: each host-filled entry is about 700 bytes. */
  const PAGES = Array.from({ length: 400 }, (_, index) => {
    const directory = `docs/${"d".repeat(230)}`;
    return `${directory}/${String(index).padStart(4, "0")}${"p".repeat(240)}.md`;
  });

  it("is refused at run start, before any provider call, with the bound named", {
    timeout: testTimeoutMs(60_000),
  }, async () => {
    expect(hostFilledCoverageBytes(PAGES)).toBeGreaterThan(PROPOSAL_BOUND.value);
    const root = await mkdtemp(join(tmpdir(), "docsfab-review-scope-bound-"));
    const source = join(root, "source");
    await initFixtureRepo(source, {
      "src/api.ts": "export const value = 1;\n",
      ...Object.fromEntries(PAGES.map((path) => [path, "# Page\n"])),
    });
    const workspace = await prepareRepositoryWorkspace(source, "HEAD");
    try {
      const calls: string[] = [];
      const saved: RunRecord[] = [];
      const harness = {
        async runStep(input: HarnessStepInput): Promise<never> {
          calls.push(input.step.id);
          throw new Error("no step may run for a refused scope");
        },
      };
      const runIds = ["run-review-scope-bound", "run-review-named-page", "run-review-context-page"];
      const runner = new WorkflowRunner({
        harness,
        hostOperations: harness,
        store: {
          save: async (record) => {
            saved.push(structuredClone(record));
          },
        } satisfies RunStore,
        repositoryScanner: {
          scan: async () => ({
            ruleSet: "review-scope-bound-fixture",
            status: "passed" as const,
            scannedFiles: PAGES.length + 1,
            binaryFiles: 0,
            findings: [],
          }),
        },
        contextPreflight: {
          preflight: async () => ({
            status: "unnecessary" as const,
            reason: "target-not-applicable",
          }),
        },
        workflowSearch: new LocalWorkflowSearchCoordinator({ workspace }),
        sourceObligationObserver: new LocalSourceObligationSourceObserver(workspace),
        id: () => runIds.shift()!,
      });

      const record = await runner.run({
        workflow: "review-documentation",
        workspacePath: workspace.path,
        repository: {
          sourcePath: source,
          requestedRevision: "HEAD",
          revision: workspace.revision,
        },
        allowWrite: false,
      });

      expect(calls).toEqual([]);
      expect(record.status).toBe("failed");
      expect(record.steps.every((step) => step.status === "pending")).toBe(true);
      expect(record.failure).toEqual({
        class: "bound",
        layer: "workflow",
        code: "technical-correction-proposal-max-bytes-bound",
      });
      const bytes = hostFilledCoverageBytes(PAGES);
      expect(record.error).toBe(
        `technical-correction-proposal-max-bytes-bound: ${bytes} exceeds technicalCorrection.proposalMaxBytes = 262144 bytes. ` +
          `${PROPOSAL_BOUND.remediation} Follow the named remediation. ` +
          `Scope: ${PAGES.length} target pages. Observed is the host-filled coverage alone, which every technical-correction proposal for this scope carries, measured before any model call.`,
      );
      expect(saved.at(-1)?.status).toBe("failed");
      const next = buildRunHumanNextCommand({ record });
      expect(next).toMatchObject({
        command: "docsfab runs show run-review-scope-bound",
        recoveryAction: "rescope",
      });
      expect(next?.reason).toContain("technicalCorrection.proposalMaxBytes");
      expect(next?.reason).toContain(`--rescope-from ${record.id}`);
      expect(next?.reason).toContain(`--revision ${record.repository.revision}`);
      expect(next?.reason).toContain("--review-target");
      expect(next?.reason).toContain(PROPOSAL_BOUND.remediation);

      // The saved record, read back the way an operator reads it.
      const stateDirectory = join(root, "runs");
      await mkdir(stateDirectory, { recursive: true });
      await writeFile(join(stateDirectory, `${record.id}.json`), JSON.stringify(record));
      const shown = await stdoutOf(() =>
        handleRunsCommand(["show", record.id, "--state-dir", stateDirectory]),
      );
      expect(shown).toContain(record.error);
      expect(shown).toContain(
        "Reason: Rescope: the review stopped at technicalCorrection.proposalMaxBytes",
      );
      expect(shown).not.toContain("docsfab doctor");
      const why = await stdoutOf(() =>
        handleWhyCommand([record.id, "--state-dir", stateDirectory]),
      );
      expect(why).toContain(
        "The run stopped at technicalCorrection.proposalMaxBytes = 262144 bytes (technical-correction-proposal-max-bytes-bound).",
      );
      expect(why).toContain(PROPOSAL_BOUND.remediation);
      expect(why).not.toMatch(/output-allowance-reached|maxOutputTokens/u);

      // The same checkout reviewed one named page at a time is admitted: the
      // run reaches the harness, whose stub then fails the first step.
      const focused = {
        scope: "focused-set" as const,
        reason: "operator-named" as const,
        targetPaths: [PAGES[0]!],
        deferredPaths: [],
        corpusFileCount: PAGES.length,
      };
      for (const narrowed of [
        { reviewScope: { ...focused, scopeSha256: canonicalDigest(focused) } },
        { contextTarget: { sourcePath: PAGES[1]! } },
      ]) {
        calls.length = 0;
        const admitted = await runner.run({
          workflow: "review-documentation",
          workspacePath: workspace.path,
          repository: {
            sourcePath: source,
            requestedRevision: "HEAD",
            revision: workspace.revision,
          },
          allowWrite: false,
          ...narrowed,
        });
        expect(calls.length, Object.keys(narrowed)[0]).toBeGreaterThan(0);
        expect(admitted.failure?.code).not.toBe("technical-correction-proposal-max-bytes-bound");
        expect(admitted.error ?? "").not.toContain("technical-correction-proposal-max-bytes-bound");
      }
    } finally {
      await workspace.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
});
