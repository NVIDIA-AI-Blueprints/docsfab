// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * A verification judgment against a sealed ledger that marks a dimension
 * unverified. The host copies the unverified dimension into the inventory it
 * builds, so the consistency rule requires `human-review` although the model
 * does not author that inventory. The fixtures rebuild a recorded shape from
 * the sealed ledger alone: `environment-prerequisite` unverified with no
 * obligations, five dimensions applicable with 3/3/2/4/5 obligations, and a
 * `needs-revision` reply with 17 obligation rows.
 */

import { describe, expect, it } from "vitest";

import {
  InferenceStepError,
  type HarnessStepInput,
  type InferenceRetryPolicy,
} from "../src/execution/contracts.js";
import { buildHostStepPrompt } from "../src/harness/pi.js";
import { buildDocsFabStepPrompt } from "../src/harness/pi-session.js";
import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../src/json-evidence.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import { createDocumentationPlanBinding } from "../src/workflow-execution/plan-binding.js";
import { executeInferenceStep } from "../src/workflow-execution/retry.js";
import { TECHNICAL_RESPONSE_RULE_HINTS } from "../src/workflow-execution/review-response-rule-hints.js";
import {
  JUDGMENT_VERDICT_CONTRACT,
  JUDGMENT_VERDICT_RULE,
  TECHNICAL_FACT_DIMENSIONS,
  VERDICT_CONSISTENCY_RULE,
  VERIFICATION_RESPONSE_CONTRACT,
  type TechnicalFactDimension,
} from "../src/workflow-execution/review-response.js";
import {
  PROVISIONAL_VERIFICATION_JUDGMENT_CONTRACT,
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
const RUN_ID = "judgment-unverified-verdict-run";
const TARGET = "docs/quickstart.md";
const UNVERIFIED_REASON =
  "The admitted source establishes a Node-executed CLI script but does not by itself authorize a specific supported Node.js version.";

/** The recorded ledger's obligation count per dimension; 0 marks it unverified. */
const R1_OBLIGATION_COUNTS: Readonly<Record<TechnicalFactDimension, number>> = {
  "input-representations": 3,
  "defaults-and-overrides": 3,
  "mutable-state": 2,
  "destination-and-trust": 4,
  "error-status-retry": 5,
  "environment-prerequisite": 0,
};

const ALL_APPLICABLE_COUNTS: Readonly<Record<TechnicalFactDimension, number>> = {
  ...R1_OBLIGATION_COUNTS,
  "environment-prerequisite": 1,
};

function ledgerProposal(
  counts: Readonly<Record<TechnicalFactDimension, number>>,
): SourceObligationLedgerProposalV1 {
  return {
    completeness: "bounded-not-proven",
    dimensions: TECHNICAL_FACT_DIMENSIONS.map((dimension) =>
      counts[dimension] === 0
        ? {
            dimension,
            status: "unverified" as const,
            reason: UNVERIFIED_REASON,
            sourceLocators: [],
            obligations: [],
          }
        : {
            dimension,
            status: "applicable" as const,
            reason: `The fixture source establishes ${dimension} behavior.`,
            sourceLocators: [],
            obligations: Array.from({ length: counts[dimension] }, (_, index) => ({
              dimension,
              sourceLocators: [`src/sprout.mjs:${index + 1}`],
              statement: `The fixture source establishes ${dimension} consequence number ${index + 1}.`,
              evidenceClass: "source-observation" as const,
              uncertainty: "Observed from source only; command execution was not authorized.",
            })),
          },
    ),
    limitations: Object.values(counts).includes(0) ? [UNVERIFIED_REASON] : [],
  };
}

async function fixture(counts = R1_OBLIGATION_COUNTS) {
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
    ledgerProposal(counts),
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

const NON_DOCUMENTED = ["omitted", "conflicting", "unverified-policy", "product-defect"] as const;

/**
 * The recorded reply shape: 17 retained rows, one documented and 16 linked to
 * four issue judgments that cite 13, 1, 1, and 1 obligations.
 */
function r1Judgment(ledger: Ledger, verdict = "needs-revision") {
  const ids = ledger.dimensions.flatMap(({ obligations }) => obligations.map(({ id }) => id));
  const [documented, ...linked] = ids;
  const groups = [
    linked.slice(0, 13),
    linked.slice(13, 14),
    linked.slice(14, 15),
    linked.slice(15),
  ];
  const issueFor = (id: string) => `TECH-00${groups.findIndex((group) => group.includes(id)) + 1}`;
  return {
    verdict,
    coverage: [
      {
        path: TARGET,
        status: "verified",
        evidence: ["src/sprout.mjs:1"],
        reason: "Compared the quickstart commands with the cited frozen source.",
      },
    ],
    issueJudgments: groups.map((obligationIds, index) => ({
      id: `TECH-00${index + 1}`,
      severity: "major",
      category: index === 0 ? "technical_accuracy" : "completeness",
      location: `${TARGET}:1`,
      obligationIds,
    })),
    obligationJudgments: ids.map((obligationId, index) =>
      obligationId === documented
        ? {
            obligationId,
            disposition: "retained",
            documentationDisposition: "documented",
            issueIds: [],
          }
        : {
            obligationId,
            disposition: "retained",
            documentationDisposition: NON_DOCUMENTED[index % NON_DOCUMENTED.length],
            issueIds: [issueFor(obligationId)],
          },
    ),
  };
}

/** Every obligation retained as documented, with no issue judgments. */
function documentedJudgment(ledger: Ledger, verdict: string, coverageStatus = "verified") {
  return {
    verdict,
    coverage: [
      {
        path: TARGET,
        status: coverageStatus,
        evidence: ["src/sprout.mjs:1"],
        reason: "Compared the quickstart commands with the cited frozen source.",
      },
    ],
    issueJudgments: [] as unknown[],
    obligationJudgments: ledger.dimensions.flatMap(({ obligations }) =>
      obligations.map(({ id }) => ({
        obligationId: id,
        disposition: "retained",
        documentationDisposition: "documented",
        issueIds: [],
      })),
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

describe("a judgment against a ledger with an unverified dimension (#1283)", () => {
  it("rebuilds the r1 shape: 17 rows over five applicable dimensions and one unverified", async () => {
    const { ledger } = await fixture();
    const judgment = r1Judgment(ledger);
    expect(Object.keys(judgment)).toEqual([
      "verdict",
      "coverage",
      "issueJudgments",
      "obligationJudgments",
    ]);
    expect(judgment.verdict).toHaveLength(14);
    expect(judgment.obligationJudgments).toHaveLength(17);
    expect(judgment.issueJudgments.map(({ obligationIds }) => obligationIds.length)).toEqual([
      13, 1, 1, 1,
    ]);
    expect(judgment.obligationJudgments.flatMap((row) => row.issueIds)).toHaveLength(16);
    expect(
      ledger.dimensions
        .filter(({ status }) => status === "unverified")
        .map(({ dimension }) => dimension),
    ).toEqual(["environment-prerequisite"]);
  });

  it("admits the recorded provisional reply with the host-derived human-review verdict", async () => {
    const { ledger } = await fixture();
    const result = provisional(ledger, r1Judgment(ledger));
    expect(result.review.verdict).toBe("human-review");
    expect(result.review.issues.map(({ id }) => id)).toEqual([
      "TECH-001",
      "TECH-002",
      "TECH-003",
      "TECH-004",
    ]);
    expect(
      result.factInventory.dimensions.find(
        ({ dimension }) => dimension === "environment-prerequisite",
      ),
    ).toMatchObject({ status: "unverified", reason: UNVERIFIED_REASON, facts: [] });
    expect(result.factInventory.limitations).toContain(UNVERIFIED_REASON);
  });

  it("admits the same reply in the final V3 correction and records human-review in the proposal", async () => {
    const { ledger, admission } = await fixture();
    const response = await decodeTechnicalCorrectionResponseV3(
      canonicalizeJsonEvidence(r1Judgment(ledger) as JsonEvidenceValue),
      ledger,
      admission,
      RUN_ID,
      [TARGET],
    );
    expect(response.proposal.verdict).toBe("human-review");
    expect(response.verificationResult.review.verdict).toBe("human-review");
    expect(response.verificationResult.review.issues).toHaveLength(4);
  });

  it.each(["pass", "needs-revision", "human-review"])(
    "records human-review for a %s verdict with no issues",
    async (verdict) => {
      const { ledger } = await fixture();
      const result = provisional(ledger, documentedJudgment(ledger, verdict));
      expect(result.review).toEqual({ verdict: "human-review", issues: [] });
    },
  );

  it("records human-review when the reply marks its own coverage unverified", async () => {
    const { ledger } = await fixture(ALL_APPLICABLE_COUNTS);
    const result = provisional(ledger, documentedJudgment(ledger, "pass", "unverified"));
    expect(result.review.verdict).toBe("human-review");
    expect(result.coverage[0]!.status).toBe("unverified");
  });

  it("still refuses a verdict outside the review vocabulary", async () => {
    const { ledger } = await fixture();
    const error = await refusal(() => provisional(ledger, r1Judgment(ledger, "fail")));
    expect(error.rejection?.code).not.toBe("inconsistent-verdict");
    expect(error.rejection?.location).toMatch(/^\$\.review/u);
  });
});

describe("the consistency check is not loosened (#1283)", () => {
  it("keeps the model verdict when every dimension and coverage entry is verified", async () => {
    const { ledger } = await fixture(ALL_APPLICABLE_COUNTS);
    expect(provisional(ledger, r1Judgment(ledger)).review.verdict).toBe("needs-revision");
    expect(provisional(ledger, documentedJudgment(ledger, "pass")).review.verdict).toBe("pass");
  });

  it("refuses pass with issue judgments", async () => {
    const { ledger } = await fixture(ALL_APPLICABLE_COUNTS);
    const error = await refusal(() => provisional(ledger, r1Judgment(ledger, "pass")));
    expect(error).toMatchObject({
      category: "malformed-response",
      retryable: true,
      rejection: { code: "inconsistent-verdict", location: "$.review.verdict" },
    });
  });

  it("refuses needs-revision whose only judgment links no non-documented obligation", async () => {
    const { ledger } = await fixture(ALL_APPLICABLE_COUNTS);
    const [first] = ledger.dimensions[0]!.obligations;
    const judgment = {
      ...documentedJudgment(ledger, "needs-revision"),
      issueJudgments: [
        {
          id: "TECH-001",
          severity: "major",
          category: "completeness",
          location: `${TARGET}:1`,
          obligationIds: [first!.id],
        },
      ],
    };
    // The host refuses such a judgment by name before the verdict rule would
    // see an empty review.
    const error = await refusal(() => provisional(ledger, judgment));
    expect(error.rejection).toEqual({
      code: "judgment-links-no-open-fact",
      location: "$.issueJudgments[]",
    });
  });
});

describe("the verdict rule is stated once (#1283)", () => {
  it("both judgment contracts state it in judgment terms", () => {
    expect(JUDGMENT_VERDICT_CONTRACT).toBe(`${VERDICT_CONSISTENCY_RULE} ${JUDGMENT_VERDICT_RULE}`);
    expect(JUDGMENT_VERDICT_RULE).toContain(
      'When the sealed ledger marks any dimension unverified, the host demotes a dimension to unverified, or any coverage entry is unverified, the verdict is "human-review" and the host records it.',
    );
    for (const contract of [
      PROVISIONAL_VERIFICATION_JUDGMENT_CONTRACT,
      TECHNICAL_CORRECTION_RESPONSE_CONTRACT_V3,
    ]) {
      const lines = contract.split("\n");
      expect(lines).toContain(JUDGMENT_VERDICT_CONTRACT);
      expect(lines.filter((line) => line.includes(VERDICT_CONSISTENCY_RULE))).toHaveLength(1);
      expect(contract).not.toContain("Keep verdict");
    }
  });

  it("the full verification contract and the retry hint quote the same rule", () => {
    expect(VERIFICATION_RESPONSE_CONTRACT).toContain(VERDICT_CONSISTENCY_RULE);
    const hint = TECHNICAL_RESPONSE_RULE_HINTS["inconsistent-verdict"]!;
    expect(hint.atLocation).toBeUndefined();
    expect(hint.rule).toContain(VERDICT_CONSISTENCY_RULE);
    expect(hint.rule).toContain(JUDGMENT_VERDICT_RULE);
  });

  it("the provisional host prompt carries the rule", async () => {
    const { ledger } = await fixture();
    const workflow = getWorkflow("create-documentation");
    const step = workflow.steps.find(
      (candidate) => candidate.id === "provisional-technical-verification",
    )!;
    const prompt = buildHostStepPrompt({
      repositoryPath: "/workspace",
      workflow,
      step,
      sourceObligationLedger: ledger,
    });
    expect(prompt).toContain(JUDGMENT_VERDICT_CONTRACT);
  });
});

const policy: InferenceRetryPolicy = {
  maxRetries: 1,
  baseDelayMs: 0,
  maxDelayMs: 0,
  retryableCategories: ["malformed-response"],
};

describe("a residual inconsistent verdict reaches the retry with the rule (#1283)", () => {
  it("restates the judgment verdict rule in the bounded retry", async () => {
    const { ledger } = await fixture(ALL_APPLICABLE_COUNTS);
    const failure = await refusal(() => provisional(ledger, r1Judgment(ledger, "pass")));
    const workflow = getWorkflow("create-documentation");
    const step = workflow.steps.find(
      (candidate) => candidate.id === "provisional-technical-verification",
    )!;
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
    const feedback = prompt.slice(start);
    expect(feedback).toContain(
      "The previous response failed host rule inconsistent-verdict at $.review.verdict.",
    );
    expect(feedback).toContain(JUDGMENT_VERDICT_RULE);
  });
});
