// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { handleRunsCommand } from "../src/cli/commands/runs.js";
import { handleWhyCommand } from "../src/cli/commands/why.js";
import { limit } from "../src/config/limits.js";
import { canonicalDigest } from "../src/content-ir/canonical.js";
import { InferenceStepError, type HarnessStepInput } from "../src/execution/contracts.js";
import {
  hostCompleteCutJudgment,
  hostFillRefusedJudgment,
  type CutJudgmentAnswer,
} from "../src/harness/cut-judgment.js";
import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../src/json-evidence.js";
import type { RunRecord, RunStore } from "../src/records/contracts.js";
import { prepareRepositoryWorkspace } from "../src/repository/workspace/materialize.js";
import { LocalWorkflowSearchCoordinator } from "../src/search/local-workflow-coordinator.js";
import {
  assertReviewLedgerFitsProposalCore,
  canonicalSourceObligationProposal,
  hostFilledCoverageBytes,
  hostFilledJudgmentCoreBytes,
  hostFillTechnicalCorrectionProposalFromJudgmentV3,
  type HostFillReason,
  ReviewScopeBoundError,
  type SourceObligationLedgerV2,
  type SourceObligationLedgerProposalV1,
  validateSourceObligationProposal,
  validateSourceObligationLedger,
} from "../src/workflow-execution/source-obligation.js";
import { LocalSourceObligationSourceObserver } from "../src/workflow-execution/source-obligation-observer.js";
import type { OriginalSourceAuthorityEvidenceV1 } from "../src/workflow-execution/source-obligation-authority.js";
import { WorkflowRunner } from "../src/workflow-execution/runner.js";
import { initFixtureRepo } from "./helpers/git.js";
import {
  RECORDED_JUDGMENT_TARGET,
  recordedReviewJudgmentFixture,
} from "./helpers/recorded-review-judgment.js";

const TARGETS = [RECORDED_JUDGMENT_TARGET];
const PROPOSAL_BOUND = limit("technicalCorrection.proposalMaxBytes");
const REFUSAL = new InferenceStepError("refused", "malformed-response", false, undefined, {
  code: "invalid-accounting",
  location: "$response",
});

function canonicalBytes(value: unknown): number {
  return Buffer.byteLength(canonicalizeJsonEvidence(value as JsonEvidenceValue).trimEnd(), "utf8");
}

describe("the unavoidable serialized all-host proposal core", () => {
  it("admits the recorded one-page, 18-obligation review under combined defaults", () => {
    const { ledger } = recordedReviewJudgmentFixture("/workspace", { targets: TARGETS });
    const measured = hostFilledJudgmentCoreBytes(ledger, TARGETS);
    expect(measured.minimumBytes).toBeLessThan(PROPOSAL_BOUND.value);
    expect(() => assertReviewLedgerFitsProposalCore(ledger, TARGETS)).not.toThrow();
  });

  it("never exceeds the real all-host proposal from any reason family on either judgment step", () => {
    const fixture = recordedReviewJudgmentFixture("/workspace", { targets: TARGETS });
    const measured = hostFilledJudgmentCoreBytes(fixture.ledger, TARGETS);
    const cut: CutJudgmentAnswer = {
      shape: "output-truncated",
      stitched: "",
      finalCut: "",
      continuationTurns: 0,
      outputTokenLimit: 32_768,
      answerOutputTokens: 32_768,
    };
    for (const input of [fixture.provisional, fixture.correction]) {
      const floors: Array<[HostFillReason, ReturnType<typeof hostFillRefusedJudgment>]> = [
        ["answer-cut-at-output-limit", hostCompleteCutJudgment(input, cut, undefined)],
        ["judgment-reply-refused", hostFillRefusedJudgment(input, REFUSAL)],
        [
          "continued-judgment-reply-refused",
          hostFillRefusedJudgment(input, REFUSAL, "continued-refusal"),
        ],
      ];
      for (const [reason, floor] of floors) {
        const actual = hostFillTechnicalCorrectionProposalFromJudgmentV3(
          JSON.parse(floor.reply),
          fixture.ledger,
          TARGETS,
          undefined,
          floor.coveragePolicy,
        );
        expect(canonicalBytes(actual), `${input.step.id}: ${reason}`).toBeGreaterThanOrEqual(
          measured.byReason[reason],
        );
      }
    }

    const refused = hostFillRefusedJudgment(fixture.provisional, REFUSAL);
    const eventNote = refused.coveragePolicy.hostLimitations?.[0];
    expect(eventNote).toBeDefined();
    const repeatedLedger = withAdditionalLedgerLimitation(
      fixture.ledger,
      eventNote!,
      fixture.sealedEvidence,
    );
    const repeatedInput = { ...fixture.provisional, sourceObligationLedger: repeatedLedger };
    const repeated = hostFillRefusedJudgment(repeatedInput, REFUSAL);
    const actual = hostFillTechnicalCorrectionProposalFromJudgmentV3(
      JSON.parse(repeated.reply),
      repeatedLedger,
      TARGETS,
      undefined,
      repeated.coveragePolicy,
    );
    expect(actual.factInventory.limitations.filter((note) => note === eventNote)).toHaveLength(1);
    expect(canonicalBytes(actual)).toBeGreaterThanOrEqual(
      hostFilledJudgmentCoreBytes(repeatedLedger, TARGETS).byReason["judgment-reply-refused"],
    );
  });

  it("refuses a long-locator ledger while its host-filled coverage alone fits", () => {
    const sourcePath = `src/${"s".repeat(200)}/${"m".repeat(200)}.mjs`;
    const { ledger } = recordedReviewJudgmentFixture("/workspace", {
      targets: TARGETS,
      widenLedger: { sourcePath, locatorsPerObligation: 64 },
    });
    const measured = hostFilledJudgmentCoreBytes(ledger, TARGETS);
    expect(hostFilledCoverageBytes(TARGETS)).toBeLessThan(PROPOSAL_BOUND.value);
    expect(Object.values(measured.byReason).every((bytes) => bytes > PROPOSAL_BOUND.value)).toBe(
      true,
    );
    expect(measured.minimumBytes).toBeGreaterThan(PROPOSAL_BOUND.value);
    expect(() => assertReviewLedgerFitsProposalCore(ledger, TARGETS)).toThrow(
      ReviewScopeBoundError,
    );
  });

  it("admits equality and refuses one UTF-8 byte over, even when a longer family crosses early", () => {
    const { atBound, overBound } = ledgersAtProposalBound();
    const equal = hostFilledJudgmentCoreBytes(atBound, TARGETS);
    const over = hostFilledJudgmentCoreBytes(overBound, TARGETS);
    expect(equal.minimumBytes).toBe(PROPOSAL_BOUND.value);
    expect(over.minimumBytes).toBe(PROPOSAL_BOUND.value + 1);
    expect(Math.max(...Object.values(equal.byReason))).toBeGreaterThan(PROPOSAL_BOUND.value);
    const minimumFamily = Object.entries(equal.byReason).find(
      ([, bytes]) => bytes === equal.minimumBytes,
    )![0] as HostFillReason;
    const input = {
      ...recordedReviewJudgmentFixture("/workspace", { targets: TARGETS }).provisional,
      sourceObligationLedger: atBound,
    };
    const completion =
      minimumFamily === "answer-cut-at-output-limit"
        ? hostCompleteCutJudgment(input, {
            shape: "output-truncated",
            stitched: "",
            finalCut: "",
            continuationTurns: 0,
            outputTokenLimit: 32_768,
            answerOutputTokens: 32_768,
          })
        : hostFillRefusedJudgment(
            input,
            REFUSAL,
            minimumFamily === "continued-judgment-reply-refused" ? "continued-refusal" : undefined,
          );
    const serializedCore = hostFillTechnicalCorrectionProposalFromJudgmentV3(
      JSON.parse(completion.reply),
      atBound,
      TARGETS,
      undefined,
      { ...completion.coveragePolicy, hostLimitations: [] },
    );
    expect(canonicalBytes(serializedCore)).toBe(PROPOSAL_BOUND.value);
    expect(() => assertReviewLedgerFitsProposalCore(atBound, TARGETS)).not.toThrow();
    expect(() => assertReviewLedgerFitsProposalCore(overBound, TARGETS)).toThrow(
      ReviewScopeBoundError,
    );
  });

  it("keeps the later exact full-proposal bound for event metadata beyond a fitting core", () => {
    const { atBound } = ledgersAtProposalBound();
    const measured = hostFilledJudgmentCoreBytes(atBound, TARGETS);
    const minimumFamily = Object.entries(measured.byReason).find(
      ([, bytes]) => bytes === measured.minimumBytes,
    )![0] as HostFillReason;
    const input = {
      ...recordedReviewJudgmentFixture("/workspace", { targets: TARGETS }).provisional,
      sourceObligationLedger: atBound,
    };
    const completion =
      minimumFamily === "answer-cut-at-output-limit"
        ? hostCompleteCutJudgment(input, {
            shape: "output-truncated",
            stitched: "",
            finalCut: "",
            continuationTurns: 0,
            outputTokenLimit: 32_768,
            answerOutputTokens: 32_768,
          })
        : hostFillRefusedJudgment(
            input,
            REFUSAL,
            minimumFamily === "continued-judgment-reply-refused" ? "continued-refusal" : undefined,
          );
    const serializedCore = hostFillTechnicalCorrectionProposalFromJudgmentV3(
      JSON.parse(completion.reply),
      atBound,
      TARGETS,
      undefined,
      { ...completion.coveragePolicy, hostLimitations: [] },
    );
    expect(canonicalBytes(serializedCore)).toBe(measured.minimumBytes);
    expect(completion.coveragePolicy.hostLimitations?.[0]).toBeDefined();
    expect(() => assertReviewLedgerFitsProposalCore(atBound, TARGETS)).not.toThrow();
    expect(() =>
      hostFillTechnicalCorrectionProposalFromJudgmentV3(
        JSON.parse(completion.reply),
        atBound,
        TARGETS,
        undefined,
        completion.coveragePolicy,
      ),
    ).toThrow(/technicalCorrection.proposalMaxBytes/u);
  });
});

function withAdditionalLedgerLimitation(
  ledger: SourceObligationLedgerV2,
  note: string,
  authority: OriginalSourceAuthorityEvidenceV1,
): SourceObligationLedgerV2 {
  const { digest: _digest, ...content } = ledger;
  const changed = { ...content, limitations: [...content.limitations, note] };
  return validateSourceObligationLedger(
    { ...changed, digest: canonicalDigest(changed) },
    undefined,
    authority,
  ) as SourceObligationLedgerV2;
}

function ledgersAtProposalBound(): {
  atBound: SourceObligationLedgerV2;
  overBound: SourceObligationLedgerV2;
} {
  for (let width = 200; width >= 175; width -= 1) {
    const sourcePath = `src/${"s".repeat(width)}.mjs`;
    const { ledger, sealedEvidence } = recordedReviewJudgmentFixture("/workspace", {
      targets: TARGETS,
      widenLedger: { sourcePath, locatorsPerObligation: 64 },
    });
    const seed = withAdditionalLedgerLimitation(ledger, "é", sealedEvidence);
    const missingBytes =
      PROPOSAL_BOUND.value - hostFilledJudgmentCoreBytes(seed, TARGETS).minimumBytes;
    if (missingBytes < 0 || missingBytes > 3_000) continue;
    const atBound = withAdditionalLedgerLimitation(
      ledger,
      `é${"x".repeat(missingBytes)}`,
      sealedEvidence,
    );
    const overBound = withAdditionalLedgerLimitation(
      ledger,
      `é${"x".repeat(missingBytes + 1)}`,
      sealedEvidence,
    );
    return { atBound, overBound };
  }
  throw new Error("The supported fixture could not be calibrated to the proposal bound.");
}

describe("the REVIEW runner's post-ledger admission", () => {
  const SOURCE = `src/${"s".repeat(200)}/${"m".repeat(200)}.mjs`;

  async function runReview(locatorsPerObligation: number) {
    const root = await mkdtemp(join(tmpdir(), "docsfab-ledger-core-runner-"));
    const source = join(root, "source");
    await initFixtureRepo(source, {
      [SOURCE]:
        Array.from({ length: 64 }, (_, index) => `export const v${index} = ${index};`).join("\n") +
        "\n",
      [RECORDED_JUDGMENT_TARGET]: "# Quickstart\n\nA bounded review target.\n",
    });
    const workspace = await prepareRepositoryWorkspace(source, "HEAD");
    const fixture = recordedReviewJudgmentFixture(workspace.path, {
      targets: TARGETS,
      widenLedger: { sourcePath: SOURCE, locatorsPerObligation },
    });
    const proposal: SourceObligationLedgerProposalV1 = {
      completeness: fixture.ledger.completeness,
      dimensions: structuredClone(fixture.ledger.dimensions),
      limitations: [...fixture.ledger.limitations],
    };
    const calls: string[] = [];
    const saved: RunRecord[] = [];
    const harness = {
      async runStep(input: HarnessStepInput) {
        calls.push(input.step.id);
        if (input.step.id === "derive-source-obligations") {
          return {
            summary: canonicalSourceObligationProposal(
              validateSourceObligationProposal(proposal, input),
            ),
            sourceObligationProposal: proposal,
          };
        }
        if (input.step.id === "audit-documentation") return { summary: "Scope audit completed." };
        throw new Error("later step reached");
      },
    };
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
          ruleSet: "ledger-core-bound-fixture",
          status: "passed" as const,
          scannedFiles: 2,
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
      id: () => "run-ledger-core-bound",
    });
    try {
      const record = await runner.run({
        workflow: "review-documentation",
        workspacePath: workspace.path,
        repository: {
          sourcePath: source,
          requestedRevision: "HEAD",
          revision: workspace.revision,
        },
        contextTarget: { sourcePath: RECORDED_JUDGMENT_TARGET },
        allowWrite: false,
      });
      return { record, calls, saved, root };
    } finally {
      await workspace.dispose();
      // The caller reads and removes `root` after saved-record/CLI assertions.
    }
  }

  it("stops after the sealed second step, saves its ledger, and explains the bound in runs/why", async () => {
    const { record, calls, saved, root } = await runReview(64);
    try {
      expect(calls).toEqual(["audit-documentation", "derive-source-obligations"]);
      expect(record.status).toBe("failed");
      expect(record.failure?.code, record.error).toBe(
        "technical-correction-proposal-max-bytes-bound",
      );
      expect(record.error).toContain("unavoidable serialized");
      expect(record.error).not.toMatch(/maxOutputTokens|output-allowance-reached/u);
      const derive = record.steps.find((step) => step.id === "derive-source-obligations")!;
      expect(derive.status).toBe("failed");
      const sealed = JSON.parse(derive.summary!);
      expect(
        validateSourceObligationLedger(sealed, undefined, derive.originalSourceAuthority),
      ).toEqual(sealed);
      expect(
        saved.at(-1)?.steps.find((step) => step.id === "derive-source-obligations")?.summary,
      ).toBe(derive.summary);
      const stateDirectory = join(root, "runs");
      await mkdir(stateDirectory);
      await writeFile(join(stateDirectory, `${record.id}.json`), JSON.stringify(record));
      const shown = await captureStdout(() =>
        handleRunsCommand(["show", record.id, "--state-dir", stateDirectory]),
      );
      const why = await captureStdout(() =>
        handleWhyCommand([record.id, "--state-dir", stateDirectory]),
      );
      expect(shown).toContain(record.error);
      expect(why).toContain("technicalCorrection.proposalMaxBytes");
      expect(why).not.toMatch(/maxOutputTokens|output-allowance-reached/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("lets the adjacent fitting ledger reach step 3", async () => {
    const { record, calls, root } = await runReview(1);
    try {
      expect(calls, record.error).toEqual([
        "audit-documentation",
        "derive-source-obligations",
        "lint-documentation",
      ]);
      expect(record.failure?.code).not.toBe("technical-correction-proposal-max-bytes-bound");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function captureStdout(action: () => Promise<unknown>): Promise<string> {
  const original = console.log;
  const lines: string[] = [];
  console.log = (message?: unknown) => {
    lines.push(String(message ?? ""));
  };
  try {
    await action();
  } finally {
    console.log = original;
  }
  return lines.join("\n");
}
