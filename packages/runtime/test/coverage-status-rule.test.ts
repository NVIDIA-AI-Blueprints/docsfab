// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Missing command execution is fact uncertainty, not unverified coverage.
 *
 * The recorded "r2" run marked coverage `unverified` only because no commands
 * were executed, and CREATE stopped. Every contract that asks for coverage
 * states the coverage rule. The host still refuses the recorded reply shape at
 * the CREATE gate; it does not read the reason prose.
 */

import { describe, expect, it } from "vitest";

import type { HarnessStepInput } from "../src/execution/contracts.js";
import { buildHostStepPrompt } from "../src/harness/pi.js";
import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../src/json-evidence.js";
import { getWorkflow, listCatalogWorkflows } from "../src/workflow-registry/catalog.js";
import { createDocumentationPlanBinding } from "../src/workflow-execution/plan-binding.js";
import {
  COVERAGE_STATUS_RULE,
  NESTED_EDITORIAL_VERIFICATION_RESULT_CONTRACT,
  NESTED_VERIFICATION_RESULT_CONTRACT,
  TECHNICAL_FACT_DIMENSIONS,
  VERIFICATION_RESPONSE_CONTRACT,
  type TechnicalFactDimension,
} from "../src/workflow-execution/review-response.js";
import {
  PROVISIONAL_VERIFICATION_JUDGMENT_CONTRACT,
  TECHNICAL_CORRECTION_RESPONSE_CONTRACT,
  TECHNICAL_CORRECTION_RESPONSE_CONTRACT_V3,
  bindSourceObligationLedgerV2,
  decodeProvisionalVerificationJudgment,
  decodeTechnicalCorrectionResponseV3,
  sourceObligationScopeSha256,
  type SourceObligationLedgerProposalV1,
} from "../src/workflow-execution/source-obligation.js";
import {
  issueOriginalSourceAuthorityAdmission,
  sealOriginalSourceAuthority,
} from "../src/workflow-execution/source-obligation-authority.js";
import { searchStepEvidence } from "./helpers/search-evidence-fixture.js";

const REVISION = "a".repeat(40);
const SOURCE_SHA256 = "f".repeat(64);
const SEARCH_SHA256 = "b".repeat(64);
const SNAPSHOT_SHA256 = "c".repeat(64);
const RUN_ID = "coverage-status-rule-run";
const TARGET = "docs/cli-reference.md";
const SOURCE = "src/sprout.mjs";

/** The r2 ledger's obligation count per dimension: all six applicable, 20 in all. */
const R2_OBLIGATION_COUNTS: Readonly<Record<TechnicalFactDimension, number>> = {
  "input-representations": 4,
  "defaults-and-overrides": 3,
  "mutable-state": 2,
  "destination-and-trust": 3,
  "error-status-retry": 5,
  "environment-prerequisite": 3,
};

/** The recorded verify-technical-accuracy coverage reason. */
const R2_COVERAGE_REASON =
  "Re-read the candidate page and the frozen approved source spans, then compared each host-issued obligation against the candidate. Coverage remains unverified because no commands were authorized or executed in this step.";

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function ledgerProposal(): SourceObligationLedgerProposalV1 {
  return {
    completeness: "bounded-not-proven",
    dimensions: TECHNICAL_FACT_DIMENSIONS.map((dimension) => ({
      dimension,
      status: "applicable" as const,
      reason: `The approved source establishes ${dimension} behavior.`,
      sourceLocators: [],
      obligations: Array.from({ length: R2_OBLIGATION_COUNTS[dimension] }, (_, index) => ({
        dimension,
        sourceLocators: [`${SOURCE}:${index + 1}`],
        statement: `The approved source establishes ${dimension} consequence number ${index + 1}.`,
        evidenceClass: "source-observation" as const,
        uncertainty: "Derived from source inspection only; command behavior was not executed.",
      })),
    })),
    limitations: [],
  };
}

async function fixture() {
  const workflow = getWorkflow("create-documentation");
  const input = {
    runId: RUN_ID,
    repositoryPath: "/workspace",
    workflow,
    step: workflow.steps.find((candidate) => candidate.id === "derive-source-obligations")!,
    planBinding: createDocumentationPlanBinding({
      mode: "create",
      pages: [{ path: TARGET, disposition: "create" as const }],
      sourceBindings: [{ pagePath: TARGET, sources: [SOURCE] }],
    }),
    evidenceIdentity: { repositoryRevision: REVISION },
    searchEvidence: searchStepEvidence({
      evidenceSha256: SEARCH_SHA256,
      workspaceSnapshotSha256: SNAPSHOT_SHA256,
    }),
  } satisfies HarnessStepInput;
  const scopeSha256 = sourceObligationScopeSha256(input);
  const sealed = sealOriginalSourceAuthority({
    runId: RUN_ID,
    scope: "create-plan-sources",
    repositoryRevision: REVISION,
    scopeSha256,
    workspaceSnapshotSha256: SNAPSHOT_SHA256,
    members: [{ path: SOURCE, mode: 0o644, byteLength: 1, sourceSha256: SOURCE_SHA256 }],
  });
  const ledger = bindSourceObligationLedgerV2(
    ledgerProposal(),
    input,
    [{ path: SOURCE, sha256: SOURCE_SHA256 }],
    sealed.evidence,
  );
  const admission = issueOriginalSourceAuthorityAdmission({
    capture: sealed.capture,
    observer: {
      observe: async (paths: readonly string[]) =>
        [...new Set(paths)].sort().map((path) => ({ path, sha256: SOURCE_SHA256 })),
    },
    runId: RUN_ID,
    repositoryRevision: REVISION,
    scopeSha256,
    workspaceSnapshotSha256: SNAPSHOT_SHA256,
  });
  return { ledger, admission };
}

type Ledger = Awaited<ReturnType<typeof fixture>>["ledger"];

/**
 * The recorded r2 reply shape: 20 retained rows, 17 documented, 2 omitted, and
 * 1 conflicting, with coverage unverified only because nothing was executed.
 */
function r2Judgment(ledger: Ledger) {
  const ids = ledger.dimensions.flatMap(({ obligations }) => obligations.map(({ id }) => id));
  const omitted = ids.slice(0, 2);
  const conflicting = ids[2]!;
  return {
    verdict: "human-review",
    coverage: [
      {
        path: TARGET,
        status: "unverified",
        evidence: [`${TARGET}:1-81`, `${SOURCE}:1-27`],
        reason: R2_COVERAGE_REASON,
      },
    ],
    issueJudgments: [
      {
        id: "TECH-001",
        severity: "major",
        category: "completeness",
        location: `${TARGET}:1`,
        obligationIds: omitted,
      },
      {
        id: "TECH-002",
        severity: "major",
        category: "technical_accuracy",
        location: `${TARGET}:1`,
        obligationIds: [conflicting],
      },
    ],
    obligationJudgments: ids.map((obligationId) => ({
      obligationId,
      disposition: "retained",
      documentationDisposition: omitted.includes(obligationId)
        ? "omitted"
        : obligationId === conflicting
          ? "conflicting"
          : "documented",
      issueIds: omitted.includes(obligationId)
        ? ["TECH-001"]
        : obligationId === conflicting
          ? ["TECH-002"]
          : [],
    })),
  };
}

describe("the coverage status rule is stated once (#1296)", () => {
  it("says missing command execution is fact uncertainty, not unverified coverage", () => {
    expect(COVERAGE_STATUS_RULE).toContain(
      'Missing command execution is not grounds for "unverified": a command that was not authorized or not run belongs in the affected facts\' uncertainty, not in coverage status.',
    );
    // A real source gap, such as a missing prerequisite, stays unverified.
    expect(COVERAGE_STATUS_RULE).toContain(
      'Use "unverified" only when a claim the page makes cannot be compared with any admitted source because none addresses it, and name that claim and the missing source in reason.',
    );
  });

  it.each([
    ["ordinary verification", VERIFICATION_RESPONSE_CONTRACT],
    ["nested verification", NESTED_VERIFICATION_RESULT_CONTRACT],
    ["editorial-nested verification", NESTED_EDITORIAL_VERIFICATION_RESULT_CONTRACT],
    ["provisional judgment", PROVISIONAL_VERIFICATION_JUDGMENT_CONTRACT],
    ["V2 correction", TECHNICAL_CORRECTION_RESPONSE_CONTRACT],
    ["V3 correction judgment", TECHNICAL_CORRECTION_RESPONSE_CONTRACT_V3],
  ])("the %s contract carries the rule exactly once", (_name, contract) => {
    expect(contract.split("\n").filter((line) => line === COVERAGE_STATUS_RULE)).toHaveLength(1);
    expect(occurrences(contract, "Missing command execution")).toBe(1);
    expect(contract).not.toContain("If verification cannot be completed");
  });

  it.each([
    ["provisional-technical-verification", PROVISIONAL_VERIFICATION_JUDGMENT_CONTRACT],
    ["verify-technical-accuracy", TECHNICAL_CORRECTION_RESPONSE_CONTRACT_V3],
  ])("the host prompt for the %s judgment carries the rule once", async (id, contract) => {
    const { ledger } = await fixture();
    const workflow = getWorkflow("create-documentation");
    const step = workflow.steps.find((candidate) => candidate.id === id)!;
    const prompt = buildHostStepPrompt({
      repositoryPath: "/workspace",
      workflow,
      step,
      sourceObligationLedger: ledger,
    });
    expect(prompt).toContain(contract);
    expect(occurrences(prompt, COVERAGE_STATUS_RULE)).toBe(1);
  });

  it("every catalog verification prompt that asks for coverage carries the rule once", async () => {
    const { ledger } = await fixture();
    const asksForCoverage = /exactly (?:review, coverage, and factInventory|verdict, coverage,)/u;
    const reached: string[] = [];
    for (const workflow of listCatalogWorkflows()) {
      for (const step of workflow.steps.filter(
        ({ skill }) => skill === "verify-technical-accuracy",
      )) {
        for (const sourceObligationLedger of [undefined, ledger]) {
          const label = `${workflow.name}/${step.id}/${sourceObligationLedger ? "v2" : "none"}`;
          let prompt: string;
          try {
            prompt = buildHostStepPrompt({
              repositoryPath: "/workspace",
              workflow,
              step,
              ...(sourceObligationLedger ? { sourceObligationLedger } : {}),
            });
          } catch (error) {
            // Update-documentation V2 editorial steps need an admitted reader
            // task context; the editorial-nested contract is checked above.
            expect(String(error), label).toContain("requires an admitted reader task context");
            continue;
          }
          if (!asksForCoverage.test(prompt)) {
            expect(occurrences(prompt, COVERAGE_STATUS_RULE), label).toBe(0);
            continue;
          }
          expect(occurrences(prompt, COVERAGE_STATUS_RULE), label).toBe(1);
          reached.push(label);
        }
      }
    }
    // Ordinary, V2 correction, provisional judgment, and V3 correction prompts.
    expect(reached).toEqual(
      expect.arrayContaining([
        "create-documentation/provisional-technical-verification/none",
        "create-documentation/provisional-technical-verification/v2",
        "create-documentation/verify-technical-accuracy/none",
        "create-documentation/verify-technical-accuracy/v2",
        "review-documentation/verify-technical-accuracy/none",
      ]),
    );
  });
});

describe("the recorded r2 reply still reports unverified coverage (#1296)", () => {
  it("rebuilds the r2 shape: 20 retained rows over six applicable dimensions", async () => {
    const { ledger } = await fixture();
    expect(ledger.dimensions.map(({ status }) => status)).toEqual(
      TECHNICAL_FACT_DIMENSIONS.map(() => "applicable"),
    );
    const judgment = r2Judgment(ledger);
    expect(judgment.obligationJudgments).toHaveLength(20);
    expect(
      judgment.obligationJudgments.filter((row) => row.documentationDisposition === "documented"),
    ).toHaveLength(17);
  });

  it("admits the provisional reply without rewriting its coverage", async () => {
    const { ledger } = await fixture();
    const result = decodeProvisionalVerificationJudgment(
      canonicalizeJsonEvidence(r2Judgment(ledger) as JsonEvidenceValue),
      ledger,
      [TARGET],
    );
    expect(result.review.verdict).toBe("human-review");
    expect(result.coverage).toEqual([
      expect.objectContaining({ path: TARGET, status: "unverified", reason: R2_COVERAGE_REASON }),
    ]);
    expect(result.factInventory.dimensions.every(({ facts }) => facts.length > 0)).toBe(true);
  });

  it("admits the final V3 correction without rewriting its coverage", async () => {
    const { ledger, admission } = await fixture();
    const response = await decodeTechnicalCorrectionResponseV3(
      canonicalizeJsonEvidence(r2Judgment(ledger) as JsonEvidenceValue),
      ledger,
      admission,
      RUN_ID,
      [TARGET],
    );
    expect(response.verificationResult.review.verdict).toBe("human-review");
    expect(response.verificationResult.coverage.map(({ status }) => status)).toEqual([
      "unverified",
    ]);
  });
});
