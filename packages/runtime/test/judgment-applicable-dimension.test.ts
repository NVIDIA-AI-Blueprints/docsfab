// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * A verification judgment that rejects every obligation of an applicable
 * ledger dimension. The fixtures rebuild a recorded reply shape from the sealed
 * ledger alone: 20 obligation rows over six applicable dimensions of
 * 3/3/3/3/5/3 obligations, 17 retained and 3 rejected, which empties one
 * 3-obligation dimension.
 */

import { describe, expect, it } from "vitest";

import {
  InferenceStepError,
  type HarnessStepInput,
  type InferenceRetryPolicy,
} from "../src/execution/contracts.js";
import { buildHostStepPrompt } from "../src/harness/pi.js";
import { buildDocsFabStepPrompt } from "../src/harness/pi-session.js";
import { responseCorrectionInstruction } from "../src/harness/response-correction.js";
import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../src/json-evidence.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import { createDocumentationPlanBinding } from "../src/workflow-execution/plan-binding.js";
import { executeInferenceStep } from "../src/workflow-execution/retry.js";
import {
  EMPTIED_APPLICABLE_DIMENSION_REPAIR,
  FACT_INVENTORY_RULE_HINTS,
} from "../src/workflow-execution/review-response-rule-hints.js";
import {
  APPLICABLE_DIMENSION_JUDGMENT_RULE,
  EMPTIED_APPLICABLE_DIMENSION_REJECTION,
  TECHNICAL_FACT_DIMENSIONS,
  technicalResponseCorrection,
  type TechnicalFactDimension,
} from "../src/workflow-execution/review-response.js";
import {
  OBLIGATION_JUDGMENT_ACCOUNTING_CONTRACT,
  PROVISIONAL_VERIFICATION_JUDGMENT_CONTRACT,
  TECHNICAL_CORRECTION_RESPONSE_CONTRACT_V3,
  applicableDimensionContract,
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
const RUN_ID = "judgment-applicable-dimension-run";
const TARGET = "docs/cli-reference.md";

/** The recorded ledger's obligation count per applicable dimension, in ledger order. */
const R3_OBLIGATION_COUNTS: Readonly<Record<TechnicalFactDimension, number>> = {
  "input-representations": 3,
  "defaults-and-overrides": 3,
  "mutable-state": 3,
  "destination-and-trust": 3,
  "error-status-retry": 5,
  "environment-prerequisite": 3,
};

function ledgerProposal(): SourceObligationLedgerProposalV1 {
  return {
    completeness: "bounded-not-proven",
    dimensions: TECHNICAL_FACT_DIMENSIONS.map((dimension) => ({
      dimension,
      status: "applicable" as const,
      reason: `The fixture source establishes ${dimension} behavior.`,
      sourceLocators: [],
      obligations: Array.from({ length: R3_OBLIGATION_COUNTS[dimension] }, (_, index) => ({
        dimension,
        sourceLocators: [`src/sprout.mjs:${index + 1}`],
        statement: `The fixture source establishes ${dimension} consequence number ${index + 1}.`,
        evidenceClass: "source-observation" as const,
        uncertainty: "The source was inspected but the command was not executed.",
      })),
    })),
    limitations: [],
  };
}

async function fixture() {
  const workflow = getWorkflow("create-documentation");
  const planBinding = createDocumentationPlanBinding({
    mode: "create",
    pages: [{ path: TARGET, disposition: "create" as const }],
    sourceBindings: [{ pagePath: TARGET, sources: ["src/sprout.mjs"] }],
  });
  const input = {
    runId: RUN_ID,
    repositoryPath: "/workspace",
    workflow,
    step: workflow.steps.find((candidate) => candidate.id === "derive-source-obligations")!,
    planBinding,
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
    members: [{ path: "src/sprout.mjs", mode: 0o644, byteLength: 1, sourceSha256: SOURCE_SHA256 }],
  });
  const ledger = bindSourceObligationLedgerV2(
    ledgerProposal(),
    input,
    [{ path: "src/sprout.mjs", sha256: SOURCE_SHA256 }],
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

function obligationIdsOf(ledger: Ledger, dimension: TechnicalFactDimension): string[] {
  return ledger.dimensions
    .find((entry) => entry.dimension === dimension)!
    .obligations.map(({ id }) => id);
}

/**
 * The recorded reply shape: every obligation retained as documented except
 * those in `emptied`, which are all rejected. No issues, so verdict pass.
 */
function r3Judgment(ledger: Ledger, emptied: readonly TechnicalFactDimension[]) {
  return {
    verdict: "pass",
    coverage: [
      {
        path: TARGET,
        status: "verified",
        evidence: ["src/sprout.mjs:1"],
        reason: "Compared the candidate with the cited frozen source.",
      },
    ],
    issueJudgments: [],
    obligationJudgments: ledger.dimensions.flatMap(({ dimension, obligations }) =>
      obligations.map(({ id }) =>
        emptied.includes(dimension)
          ? {
              obligationId: id,
              disposition: "rejected",
              reason: "The frozen source does not establish this statement.",
            }
          : {
              obligationId: id,
              disposition: "retained",
              documentationDisposition: "documented",
              issueIds: [],
            },
      ),
    ),
  };
}

function refusal(run: () => unknown): Promise<InferenceStepError> {
  return Promise.resolve()
    .then(run)
    .then(
      () => {
        throw new Error("expected the judgment to be refused");
      },
      (error: unknown) => {
        expect(error).toBeInstanceOf(InferenceStepError);
        return error as InferenceStepError;
      },
    );
}

function provisional(ledger: Ledger, value: unknown) {
  return decodeProvisionalVerificationJudgment(
    canonicalizeJsonEvidence(value as JsonEvidenceValue),
    ledger,
    [TARGET],
  );
}

describe("a judgment that empties an applicable ledger dimension (#1248)", () => {
  it("rebuilds the r3 shape: 20 rows over six applicable dimensions, 17 retained and 3 rejected", async () => {
    const { ledger } = await fixture();
    const judgment = r3Judgment(ledger, ["mutable-state"]);
    expect(judgment.obligationJudgments).toHaveLength(20);
    expect(
      judgment.obligationJudgments.filter((row) => row.disposition === "rejected"),
    ).toHaveLength(3);
    expect(ledger.dimensions.every(({ status }) => status === "applicable")).toBe(true);
  });

  it("records the defect at $.obligationJudgments and names the emptied dimension", async () => {
    const { ledger } = await fixture();
    const error = await refusal(() => provisional(ledger, r3Judgment(ledger, ["mutable-state"])));
    expect(error).toMatchObject({
      message: "Technical correction response rejected: invalid-fact-inventory.",
      category: "malformed-response",
      retryable: true,
      rejection: { code: "inventory-dimension-facts", location: "$.obligationJudgments" },
    });
    expect(technicalResponseCorrection(error)).toEqual({
      kind: "emptied-applicable-dimensions",
      dimensions: ["mutable-state"],
    });
  });

  it("names every emptied dimension at once, in ledger order, in the final correction", async () => {
    const { ledger, admission } = await fixture();
    const error = await refusal(() =>
      decodeTechnicalCorrectionResponseV3(
        canonicalizeJsonEvidence(
          r3Judgment(ledger, ["environment-prerequisite", "mutable-state"]) as JsonEvidenceValue,
        ),
        ledger,
        admission,
        RUN_ID,
        [TARGET],
      ),
    );
    expect(error.rejection).toEqual({ ...EMPTIED_APPLICABLE_DIMENSION_REJECTION });
    expect(error.retryable).toBe(true);
    expect(technicalResponseCorrection(error)).toEqual({
      kind: "emptied-applicable-dimensions",
      dimensions: ["mutable-state", "environment-prerequisite"],
    });
  });

  it("admits the same judgment once one obligation of the dimension is retained", async () => {
    const { ledger } = await fixture();
    const judgment = r3Judgment(ledger, ["mutable-state"]);
    const [kept] = obligationIdsOf(ledger, "mutable-state");
    const repaired = {
      ...judgment,
      obligationJudgments: judgment.obligationJudgments.map((row) =>
        row.obligationId === kept
          ? {
              obligationId: kept,
              disposition: "retained",
              documentationDisposition: "documented",
              issueIds: [],
            }
          : row,
      ),
    };
    const result = provisional(ledger, repaired);
    const mutableState = result.factInventory.dimensions.find(
      ({ dimension }) => dimension === "mutable-state",
    )!;
    expect(mutableState.status).toBe("applicable");
    expect(mutableState.facts).toHaveLength(1);
  });
});

describe("the judgment contracts state the rule (#1248)", () => {
  it("states it once, in the accounting rule both judgment contracts share", () => {
    expect(OBLIGATION_JUDGMENT_ACCOUNTING_CONTRACT).toContain(APPLICABLE_DIMENSION_JUDGMENT_RULE);
    expect(APPLICABLE_DIMENSION_JUDGMENT_RULE).toContain(
      "keep at least one obligation of every dimension the sealed ledger marks applicable retained or refined",
    );
    for (const contract of [
      PROVISIONAL_VERIFICATION_JUDGMENT_CONTRACT,
      TECHNICAL_CORRECTION_RESPONSE_CONTRACT_V3,
    ]) {
      expect(contract.split("\n")).toContain(OBLIGATION_JUDGMENT_ACCOUNTING_CONTRACT);
    }
  });

  it("renders each applicable dimension's obligation IDs from the sealed ledger", async () => {
    const { ledger } = await fixture();
    const contract = applicableDimensionContract({ sourceObligationLedger: ledger });
    expect(contract).toContain(
      `"mutable-state":${JSON.stringify(obligationIdsOf(ledger, "mutable-state"))}`,
    );
    for (const dimension of TECHNICAL_FACT_DIMENSIONS) {
      expect(contract).toContain(`"${dimension}":`);
    }
    expect(applicableDimensionContract({})).toBeUndefined();
  });

  it.each([
    ["provisional-technical-verification", PROVISIONAL_VERIFICATION_JUDGMENT_CONTRACT],
    ["verify-technical-accuracy", TECHNICAL_CORRECTION_RESPONSE_CONTRACT_V3],
  ])(
    "the host prompt for %s carries the rule and the ledger's dimensions",
    async (id, contract) => {
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
      expect(prompt).toContain(applicableDimensionContract({ sourceObligationLedger: ledger })!);
    },
  );

  it("the fact-inventory hint states the rule in judgment terms too", () => {
    expect(FACT_INVENTORY_RULE_HINTS["dimension-facts"]).toContain(
      APPLICABLE_DIMENSION_JUDGMENT_RULE,
    );
  });
});

const policy: InferenceRetryPolicy = {
  maxRetries: 1,
  baseDelayMs: 0,
  maxDelayMs: 0,
  retryableCategories: ["malformed-response"],
};

/** Drive the real retry loop from the real refusal to the real retry prompt. */
async function retryFeedback(failure: InferenceStepError, ledger: Ledger): Promise<string> {
  const workflow = getWorkflow("create-documentation");
  const step = workflow.steps.find((candidate) => candidate.id === "verify-technical-accuracy")!;
  let prompt = "";
  await executeInferenceStep({
    mode: "read-only",
    policy,
    sleep: async () => {},
    execute: async (attempt, responseCorrection) => {
      if (attempt === 1) throw failure;
      prompt = buildDocsFabStepPrompt({
        repositoryPath: "/tmp/repository",
        workflow,
        step,
        sourceObligationLedger: ledger,
        inferenceAttempt: attempt,
        responseCorrection,
      });
      return { summary: "admitted" };
    },
  });
  const start = prompt.indexOf("\n\nHost validation feedback for this bounded retry:");
  expect(start).toBeGreaterThan(0);
  return prompt.slice(start);
}

describe("the bounded retry names the emptied dimensions (#1248)", () => {
  it("names the dimension, its obligation IDs, and the repair", async () => {
    const { ledger } = await fixture();
    const failure = await refusal(() => provisional(ledger, r3Judgment(ledger, ["mutable-state"])));
    const feedback = await retryFeedback(failure, ledger);
    expect(feedback).toContain(
      "The previous response failed host rule inventory-dimension-facts at $.obligationJudgments.",
    );
    expect(feedback).toContain(
      `rejected every obligation of these applicable ledger dimensions in obligationJudgments without a substantive rejection for each, so the host-built fact inventory has an applicable dimension with no facts: ${JSON.stringify({ "mutable-state": obligationIdsOf(ledger, "mutable-state") })}.`,
    );
    expect(feedback).toContain('Admitted source paths for evidenceLocators: ["src/sprout.mjs"].');
    expect(feedback).toContain(EMPTIED_APPLICABLE_DIMENSION_REPAIR);
    expect(feedback).not.toContain("input-representations");
    expect(feedback).not.toContain("does not establish this statement");
  });

  it("falls back to the catalog rule when no sealed ledger is bound", () => {
    const text = responseCorrectionInstruction({
      rejection: { ...EMPTIED_APPLICABLE_DIMENSION_REJECTION },
      detail: { kind: "emptied-applicable-dimensions", dimensions: ["mutable-state"] },
    });
    expect(text).toContain(FACT_INVENTORY_RULE_HINTS["dimension-facts"]);
    expect(text).not.toContain("mutable-state");
  });

  it("refuses a detail outside the dimension vocabulary or beside another rule", async () => {
    const { ledger } = await fixture();
    const input = { sourceObligationLedger: ledger };
    const rejection = { ...EMPTIED_APPLICABLE_DIMENSION_REJECTION };
    const valid = { kind: "emptied-applicable-dimensions", dimensions: ["mutable-state"] };
    expect(responseCorrectionInstruction({ rejection, detail: valid }, input)).toContain(
      EMPTIED_APPLICABLE_DIMENSION_REPAIR,
    );
    const forged = [
      { ...valid, dimensions: ["CANARY prose"] },
      { ...valid, dimensions: ["mutable-state", "mutable-state"] },
      { ...valid, dimensions: [] },
      { ...valid, dimensions: "mutable-state" },
      { ...valid, kind: "unknown-obligation-ids" },
    ];
    for (const detail of forged) {
      const text = responseCorrectionInstruction(
        { rejection, detail } as unknown as Parameters<typeof responseCorrectionInstruction>[0],
        input,
      );
      expect(text).not.toContain("CANARY");
      expect(text).not.toContain(EMPTIED_APPLICABLE_DIMENSION_REPAIR);
      expect(text).toContain(FACT_INVENTORY_RULE_HINTS["dimension-facts"]);
    }
    // The ordinary factInventory location keeps the catalog rule.
    const ordinary = responseCorrectionInstruction(
      {
        rejection: { code: "inventory-dimension-facts", location: "$.factInventory" },
        detail: valid,
      },
      input,
    );
    expect(ordinary).not.toContain(EMPTIED_APPLICABLE_DIMENSION_REPAIR);
  });
});
