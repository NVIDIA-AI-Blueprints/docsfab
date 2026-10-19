// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { parseRetryPolicy } from "../src/config/retry-policy.js";
import { InferenceStepError, type HarnessStepInput } from "../src/execution/contracts.js";
import { buildHostStepPrompt } from "../src/harness/pi.js";
import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../src/json-evidence.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import { executeInferenceStep } from "../src/workflow-execution/retry.js";
import { OUTPUT_RULE_HINTS } from "../src/contracts/model-output.js";
import {
  decodeVerificationResponse,
  technicalResponseCorrection,
  wrapTechnicalReviewFailure,
} from "../src/workflow-execution/review-response.js";
import {
  bindHostOwnedTechnicalCorrectionProposalV3,
  bindSourceObligationLedgerV2,
  decodeProvisionalVerificationJudgment,
  decodeTechnicalCorrectionResponseV3,
  JUDGMENT_ISSUE_LINK_RULE,
  OBLIGATION_JUDGMENT_ACCOUNTING_CONTRACT,
  PROVISIONAL_VERIFICATION_JUDGMENT_CONTRACT,
  sourceObligationScopeSha256,
  TECHNICAL_CORRECTION_RESPONSE_CONTRACT_V3,
  type SourceObligationLedgerProposalV1,
} from "../src/workflow-execution/source-obligation.js";
import { verificationResultFixture } from "./helpers/verification.js";
import {
  issueOriginalSourceAuthorityAdmission,
  sealOriginalSourceAuthority,
} from "../src/workflow-execution/source-obligation-authority.js";
import { searchStepEvidence } from "./helpers/search-evidence-fixture.js";
import { configureCredentialsForEachTest } from "./helpers/configured-credential.js";

// Configured for every test: only a configured credential is refused (#1807).
configureCredentialsForEachTest(["glpat", "abcdefghijklmnopqrstuv"].join("-"));

interface RecordedLedger {
  readonly recordedObligationIds: string[];
  readonly ledgerProposal: SourceObligationLedgerProposalV1;
  readonly repositoryRevision: string;
  readonly sources: Array<{ path: string; sha256: string }>;
}

interface Judgment {
  verdict: string;
  coverage: unknown[];
  issueJudgments: Array<{ id: string; obligationIds: string[] } & Record<string, unknown>>;
  obligationJudgments: Array<
    { obligationId: string; issueIds?: string[] } & Record<string, unknown>
  >;
}

const readFixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(new URL(`./fixtures/review-cli-correction/${name}`, import.meta.url), "utf8"),
  );
const recorded = readFixture("recorded-ledger.json") as RecordedLedger;
const recordedJudgment = readFixture("recorded-judgment.json") as Judgment;

/**
 * Regression from the review-cli shape. The ledger has 18 host-minted
 * OBL-<DIMENSION>-<n> IDs; the judgment reconstructs that run's admitted
 * provisional result in OBL identity. The mislinked variants below cite the
 * identities the correction step was shown: the provisional result's FACT-n
 * IDs and the skill example's OBL-001.
 */
const RUN_ID = "review-cli-1219";
const TARGETS = ["docs/quickstart.md"] as const;
const SOURCE_SHA256 = recorded.sources[0]!.sha256;
const SNAPSHOT_SHA256 = "c".repeat(64);

function stepInput(
  stepId:
    | "derive-source-obligations"
    | "provisional-technical-verification"
    | "verify-technical-accuracy",
): HarnessStepInput {
  const workflow = getWorkflow("review-documentation");
  return {
    runId: RUN_ID,
    repositoryPath: "/workspace",
    workflow,
    step: workflow.steps.find((step) => step.id === stepId)!,
    evidenceIdentity: { repositoryRevision: recorded.repositoryRevision },
    searchEvidence: searchStepEvidence({
      evidenceSha256: "b".repeat(64),
      workspaceSnapshotSha256: SNAPSHOT_SHA256,
    }),
    reviewScope: {
      scope: "focused-set",
      reason: "operator-named",
      targetPaths: [...TARGETS],
      deferredPaths: [],
      scopeSha256: "d".repeat(64),
      corpusFileCount: 3,
    },
  };
}

function recordedFixture() {
  const deriveInput = stepInput("derive-source-obligations");
  const scopeSha256 = sourceObligationScopeSha256(deriveInput);
  const sealed = sealOriginalSourceAuthority({
    runId: RUN_ID,
    scope: "review-tracked-workspace",
    repositoryRevision: recorded.repositoryRevision,
    scopeSha256,
    workspaceSnapshotSha256: SNAPSHOT_SHA256,
    members: [
      {
        path: "src/sprout.mjs",
        mode: 0o755,
        byteLength: 1,
        sourceSha256: SOURCE_SHA256,
      },
    ],
  });
  const ledger = bindSourceObligationLedgerV2(
    recorded.ledgerProposal,
    deriveInput,
    recorded.sources,
    sealed.evidence,
  );
  const admission = issueOriginalSourceAuthorityAdmission({
    capture: sealed.capture,
    observer: {
      observe: async (paths) =>
        [...new Set(paths)].sort().map((path) => ({ path, sha256: SOURCE_SHA256 })),
    },
    runId: RUN_ID,
    repositoryRevision: recorded.repositoryRevision,
    scopeSha256,
    workspaceSnapshotSha256: SNAPSHOT_SHA256,
  });
  const correctionInput: HarnessStepInput = {
    ...stepInput("verify-technical-accuracy"),
    sourceObligationLedger: ledger,
    originalSourceAuthorityAdmission: admission,
  };
  return {
    ledger,
    admission,
    correctionInput,
    decode: (judgment: unknown) =>
      decodeTechnicalCorrectionResponseV3(
        canonicalizeJsonEvidence(judgment as JsonEvidenceValue),
        ledger,
        admission,
        RUN_ID,
        TARGETS,
      ),
  };
}

/** The recorded judgment with each issue linking `replace(obligationId)` instead. */
function relinked(replace: (obligationId: string) => string): Judgment {
  const judgment = structuredClone(recordedJudgment);
  for (const issue of judgment.issueJudgments) {
    issue.obligationIds = issue.obligationIds.map(replace);
  }
  return judgment;
}

/** The provisional FACT-n identity the correction step was shown for each obligation. */
const PROVISIONAL_FACT_ID: Readonly<Record<string, string>> = {
  "OBL-DEFAULTS-AND-OVERRIDES-3": "FACT-6",
  "OBL-DESTINATION-AND-TRUST-1": "FACT-9",
  "OBL-DESTINATION-AND-TRUST-2": "FACT-10",
};

async function rejection(promise: Promise<unknown>): Promise<InferenceStepError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof InferenceStepError) return error;
    throw error;
  }
  throw new Error("expected the correction to be rejected");
}

describe("review-cli technical correction obligation links (#1219)", () => {
  it("mints the recorded obligation IDs from the recorded ledger", () => {
    const { ledger } = recordedFixture();
    expect(
      ledger.dimensions.flatMap((dimension) => dimension.obligations.map(({ id }) => id)),
    ).toEqual(recorded.recordedObligationIds);
  });

  it("admits the recorded correction when every link names a host-issued ID", async () => {
    const bound = await recordedFixture().decode(recordedJudgment);
    expect(bound.verificationResult.review.issues.map(({ id }) => id)).toEqual([
      "TECH-001",
      "TECH-002",
      "TECH-003",
      "TECH-004",
      "TECH-005",
    ]);
    expect(bound.proposal.obligationAccounting).toHaveLength(recorded.recordedObligationIds.length);
  });

  it("states the sealed obligation ID set in the correction contract", () => {
    const { correctionInput } = recordedFixture();
    const prompt = buildHostStepPrompt(correctionInput);
    expect(prompt).toContain(
      `Host-issued obligation IDs in the sealed ledger: ${JSON.stringify(recorded.recordedObligationIds)}.`,
    );
    expect(prompt).toContain("Fact IDs and issue IDs in earlier results are not obligation IDs.");
  });

  it("names every unissued link as a correctable rejection, keeping the outer code", async () => {
    const fixture = recordedFixture();
    const judgment = relinked((id) => PROVISIONAL_FACT_ID[id] ?? id);
    judgment.issueJudgments[3]!.obligationIds = ["OBL-001"];
    const error = await rejection(fixture.decode(judgment));
    expect(error).toMatchObject({
      message: "Technical correction response rejected: invalid-fact-link.",
      category: "malformed-response",
      retryable: true,
      rejection: {
        code: "fact-link-unknown-obligation",
        location: "$.issueJudgments[].obligationIds[]",
      },
    });
    // Named across every judgment, once each, in reply order.
    expect(technicalResponseCorrection(wrapTechnicalReviewFailure(error))).toEqual({
      kind: "unknown-obligation-ids",
      unknownObligationIds: ["FACT-6", "FACT-9", "FACT-10", "OBL-001"],
      withheldCount: 0,
    });
    // The cited values never reach the message or the recorded reason.
    expect(JSON.stringify({ message: error.message, rejection: error.rejection })).not.toMatch(
      /FACT-|OBL-001/u,
    );
  });

  it("classifies the same unissued link identically in provisional verification", async () => {
    const { ledger } = recordedFixture();
    let error: unknown;
    try {
      decodeProvisionalVerificationJudgment(
        canonicalizeJsonEvidence(
          relinked((id) => PROVISIONAL_FACT_ID[id] ?? id) as unknown as JsonEvidenceValue,
        ),
        ledger,
        TARGETS,
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({
      retryable: true,
      rejection: { code: "fact-link-unknown-obligation" },
    });
  });

  it("withholds cited values that are not identifier-shaped", async () => {
    const fixture = recordedFixture();
    const judgment = structuredClone(recordedJudgment);
    judgment.issueJudgments[0]!.obligationIds = ["see the ledger", '"OBL-1"', "OBL-DEFAULTS-3"];
    const error = await rejection(fixture.decode(judgment));
    expect(technicalResponseCorrection(error)).toEqual({
      kind: "unknown-obligation-ids",
      unknownObligationIds: ["OBL-DEFAULTS-3"],
      withheldCount: 2,
    });
  });

  it("refuses a credential-shaped link before any retry hint", async () => {
    const fixture = recordedFixture();
    const judgment = structuredClone(recordedJudgment);
    judgment.issueJudgments[0]!.obligationIds = ["glpat-abcdefghijklmnopqrstuv"];
    const error = await rejection(fixture.decode(judgment));
    expect(error).toMatchObject({
      message: "Technical correction response rejected: unsafe-disclosure.",
      retryable: false,
    });
    expect(technicalResponseCorrection(error)).toBeUndefined();
  });

  it("derives a host-issued link that the obligation's stale issueIds omit", async () => {
    const fixture = recordedFixture();
    const judgment = structuredClone(recordedJudgment);
    // TECH-001 also links an obligation whose legacy issueIds name only
    // TECH-005. issueJudgments[].obligationIds is the one link direction, and the
    // host derives the fact's issueIds from it.
    judgment.issueJudgments[0]!.obligationIds.push("OBL-DEFAULTS-AND-OVERRIDES-2");
    const bound = await fixture.decode(judgment);
    const facts = bound.proposal.factInventory.dimensions.flatMap((dimension) => dimension.facts);
    const tech001 = bound.proposal.issueJudgments.find(({ id }) => id === "TECH-001")!;
    expect(tech001.factIds).toHaveLength(2);
    for (const factId of tech001.factIds) {
      expect(facts.find(({ id }) => id === factId)!.issueIds).toContain("TECH-001");
    }
    const both = facts.filter(
      ({ issueIds }) => issueIds.includes("TECH-001") && issueIds.includes("TECH-005"),
    );
    expect(both).toHaveLength(1);
  });

  it("selects the unissued-ID hint and the fact-locator hint each by its own rejection", async () => {
    const unissued = await rejection(
      recordedFixture().decode(relinked((id) => PROVISIONAL_FACT_ID[id] ?? id)),
    );
    const locators = new InferenceStepError(
      "Technical correction response rejected: invalid-fact-inventory.",
      "malformed-response",
      true,
      undefined,
      { code: "inventory-fact-locators", location: "$.factInventory" },
    );
    const received: unknown[] = [];
    for (const failure of [unissued, locators]) {
      await executeInferenceStep({
        mode: "read-only",
        policy: {
          maxRetries: 1,
          baseDelayMs: 0,
          maxDelayMs: 0,
          retryableCategories: ["malformed-response"],
        },
        execute: async (attempt, responseCorrection) => {
          if (attempt === 1)
            throw failure === unissued ? wrapTechnicalReviewFailure(failure) : failure;
          received.push(responseCorrection);
          return { summary: "{}" };
        },
      });
    }
    // The correction carries the coded rejection, with the repair beside it as
    // the closed `detail`.
    expect(received).toEqual([
      {
        rejection: {
          code: "fact-link-unknown-obligation",
          location: "$.issueJudgments[].obligationIds[]",
        },
        detail: {
          kind: "unknown-obligation-ids",
          unknownObligationIds: ["FACT-6", "FACT-9", "FACT-10"],
          withheldCount: 0,
        },
      },
      { rejection: { code: "inventory-fact-locators", location: "$.factInventory" } },
    ]);
  });

  it("retries with a hint naming the unissued IDs and the valid set, then admits", async () => {
    const fixture = recordedFixture();
    const replies = [relinked((id) => PROVISIONAL_FACT_ID[id] ?? id), recordedJudgment];
    const prompts: string[] = [];
    const execution = await executeInferenceStep({
      mode: "read-only",
      policy: {
        maxRetries: 3,
        baseDelayMs: 0,
        maxDelayMs: 0,
        retryableCategories: ["malformed-response"],
      },
      execute: async (attempt, responseCorrection) => {
        prompts.push(
          buildHostStepPrompt({
            ...fixture.correctionInput,
            inferenceAttempt: attempt,
            retriesConsumed: attempt - 1,
            ...(responseCorrection ? { responseCorrection } : {}),
          }),
        );
        try {
          const bound = await fixture.decode(replies[attempt - 1]);
          return { summary: JSON.stringify(bound.verificationResult) };
        } catch (error) {
          throw wrapTechnicalReviewFailure(error);
        }
      },
    });
    expect(execution.status).toBe("succeeded");
    expect(execution.evidence.attempts).toMatchObject([
      {
        attempt: 1,
        outcome: "malformed-response",
        retryScheduled: true,
        retryDecision: "retried",
        rejection: {
          code: "fact-link-unknown-obligation",
          location: "$.issueJudgments[].obligationIds[]",
        },
      },
      { attempt: 2, outcome: "succeeded" },
    ]);
    expect(prompts[0]).not.toContain("Host validation feedback");
    expect(prompts[1]).toContain("Host validation feedback for this bounded retry");
    expect(prompts[1]).toContain(
      'linked obligation IDs the host never issued in issueJudgments[].obligationIds: ["FACT-6","FACT-9","FACT-10"].',
    );
    const feedback = prompts[1]!.slice(prompts[1]!.indexOf("Host validation feedback"));
    expect(feedback).toContain(
      `Host-issued obligation IDs in the sealed ledger: ${JSON.stringify(recorded.recordedObligationIds)}.`,
    );
  });
});

/**
 * Regression from the create-live shape. The recorded rejected-reply shape has
 * exactly the four contract keys, every obligation judgment is `retained` with
 * documentationDisposition and issueIds and no `replacements`, and every
 * rejected issue judgment has an 8-character category, a length no host
 * category has. The reply text was not retained, so `omission` stands in for
 * the 8-character value.
 */
describe("provisional judgment issue vocabulary (#1234)", () => {
  const OFF_VOCABULARY = "omission";

  /** The recorded judgment in the create-live shape: all obligations retained. */
  function createLiveShape(): Judgment {
    const judgment = structuredClone(recordedJudgment);
    judgment.obligationJudgments = judgment.obligationJudgments.map((row) =>
      row.disposition === "refined"
        ? {
            obligationId: row.obligationId,
            disposition: "retained",
            documentationDisposition: "omitted",
            issueIds: ["TECH-002"],
          }
        : row,
    );
    return judgment;
  }

  function withIssueField(field: "category" | "severity", value: string): Judgment {
    const judgment = createLiveShape();
    for (const issue of judgment.issueJudgments) issue[field] = value;
    return judgment;
  }

  function provisionalRejection(judgment: Judgment): InferenceStepError {
    const { ledger } = recordedFixture();
    try {
      decodeProvisionalVerificationJudgment(
        canonicalizeJsonEvidence(judgment as unknown as JsonEvidenceValue),
        ledger,
        TARGETS,
      );
    } catch (error) {
      if (error instanceof InferenceStepError) return error;
      throw error;
    }
    throw new Error("expected the provisional judgment to be rejected");
  }

  it("admits the 4-key, all-retained reply without replacements", () => {
    const judgment = createLiveShape();
    expect(Object.keys(judgment).sort()).toEqual(
      ["coverage", "issueJudgments", "obligationJudgments", "verdict"].sort(),
    );
    expect(judgment.obligationJudgments.every((row) => !("replacements" in row))).toBe(true);
    const { ledger } = recordedFixture();
    const result = decodeProvisionalVerificationJudgment(
      canonicalizeJsonEvidence(judgment as unknown as JsonEvidenceValue),
      ledger,
      TARGETS,
    );
    expect(result.review.issues.map(({ id }) => id)).toEqual([
      "TECH-001",
      "TECH-002",
      "TECH-003",
      "TECH-004",
      "TECH-005",
    ]);
  });

  it("names an off-vocabulary category as a correctable rejection at its member", () => {
    const error = provisionalRejection(withIssueField("category", OFF_VOCABULARY));
    expect(error).toMatchObject({
      message: "Technical correction response rejected: invalid-review.",
      category: "malformed-response",
      retryable: true,
      rejection: {
        code: "judgment-category-invalid",
        location: "$.issueJudgments[].category",
      },
    });
    expect(JSON.stringify({ message: error.message, rejection: error.rejection })).not.toContain(
      OFF_VOCABULARY,
    );
  });

  it("names an off-vocabulary severity the same way", () => {
    expect(provisionalRejection(withIssueField("severity", "moderate"))).toMatchObject({
      retryable: true,
      rejection: {
        code: "judgment-severity-invalid",
        location: "$.issueJudgments[].severity",
      },
    });
  });

  it("classifies the same category identically in the technical correction", async () => {
    const error = await rejection(
      recordedFixture().decode(withIssueField("category", OFF_VOCABULARY)),
    );
    expect(error).toMatchObject({
      retryable: true,
      rejection: {
        code: "judgment-category-invalid",
        location: "$.issueJudgments[].category",
      },
    });
  });

  it("states the exact issue vocabulary in both judgment contracts", () => {
    const { ledger, correctionInput } = recordedFixture();
    const vocabulary =
      "Use only severity critical|major|minor and category technical_accuracy|source_grounding|completeness|task_success|example_validity|information_architecture|style_compliance|security_compliance.";
    for (const input of [
      {
        ...stepInput("provisional-technical-verification"),
        sourceObligationLedger: ledger,
      },
      correctionInput,
    ]) {
      const prompt = buildHostStepPrompt(input);
      expect(prompt).toContain("Return judgment only");
      expect(prompt).toContain(vocabulary);
      expect(prompt).not.toContain("Use the existing review issue ID, severity, category");
    }
  });

  it("retries with a hint that restates the vocabulary, not the rejected value, then admits", async () => {
    const { ledger } = recordedFixture();
    const input = {
      ...stepInput("provisional-technical-verification"),
      sourceObligationLedger: ledger,
    };
    const replies = [withIssueField("category", OFF_VOCABULARY), createLiveShape()];
    const prompts: string[] = [];
    const execution = await executeInferenceStep({
      mode: "read-only",
      policy: {
        maxRetries: 3,
        baseDelayMs: 0,
        maxDelayMs: 0,
        retryableCategories: ["malformed-response"],
      },
      execute: async (attempt, responseCorrection) => {
        prompts.push(
          buildHostStepPrompt({
            ...input,
            inferenceAttempt: attempt,
            retriesConsumed: attempt - 1,
            ...(responseCorrection ? { responseCorrection } : {}),
          }),
        );
        try {
          const result = decodeProvisionalVerificationJudgment(
            canonicalizeJsonEvidence(replies[attempt - 1] as unknown as JsonEvidenceValue),
            ledger,
            TARGETS,
          );
          return { summary: JSON.stringify(result) };
        } catch (error) {
          throw wrapTechnicalReviewFailure(error);
        }
      },
    });
    expect(execution.status).toBe("succeeded");
    expect(execution.evidence.attempts).toMatchObject([
      {
        attempt: 1,
        outcome: "malformed-response",
        retryScheduled: true,
        retryDecision: "retried",
        rejection: {
          code: "judgment-category-invalid",
          location: "$.issueJudgments[].category",
        },
      },
      { attempt: 2, outcome: "succeeded" },
    ]);
    const feedback = prompts[1]!.slice(prompts[1]!.indexOf("Host validation feedback"));
    expect(feedback).toContain(
      "The previous response failed host rule judgment-category-invalid at $.issueJudgments[].category.",
    );
    expect(feedback).toContain(
      'Each issueJudgments[].category must be exactly one of "technical_accuracy", "source_grounding", "completeness",',
    );
    expect(feedback).not.toContain(OFF_VOCABULARY);
  });
});

/**
 * Regression from the review-cli shape: `verify-technical-accuracy` refused
 * with `fact-link-judgment-fact-mismatch` at `$.issueJudgments[].factIds` and
 * declined the retry with budget left. The recorded reply had more issue links
 * on the obligation side (`obligationJudgments[].issueIds`) than on the issue
 * side (`issueJudgments[].obligationIds`). Neither its text nor its ledger was
 * retained, so this reuses the ledger and judgment above and reproduces only
 * the asymmetry: TECH-005 drops one of the 11 obligations whose judgments
 * still name it.
 *
 * issueJudgments[].obligationIds is the one link direction, so the obligation
 * side's stale TECH-005 link is ignored. What remains is a real gap: the
 * dropped obligation is omitted from the page, yet no issue links it. That is
 * the catalog rule `judgment-fact-unlinked`, stated in the contract and
 * retried with the same sentence.
 */
describe("review-cli unlinked open fact retries within budget (#1238, #1342)", () => {
  const UNLINKED = {
    code: "judgment-fact-unlinked",
    location: "$.issueJudgments[].obligationIds",
  } as const;

  function mismatchedJudgment(): Judgment {
    const judgment = structuredClone(recordedJudgment);
    const issue = judgment.issueJudgments.find(({ id }) => id === "TECH-005")!;
    issue.obligationIds = issue.obligationIds.filter((id) => id !== "OBL-MUTABLE-STATE-1");
    expect(issue.obligationIds).toHaveLength(10);
    return judgment;
  }

  /** The configured read-only budget from config/limits.yaml, without delays. */
  function configuredPolicy() {
    const policy = parseRetryPolicy({});
    expect(policy.maxRetriesSource).toBe("config/limits.yaml");
    expect(policy.maxRetries).toBeGreaterThan(0);
    expect(policy.retryableCategories).toContain("malformed-response");
    return policy;
  }

  async function run(replies: readonly unknown[]) {
    const fixture = recordedFixture();
    const prompts: string[] = [];
    const execution = await executeInferenceStep({
      mode: "read-only",
      policy: configuredPolicy(),
      sleep: async () => {},
      execute: async (attempt, responseCorrection) => {
        prompts.push(
          buildHostStepPrompt({
            ...fixture.correctionInput,
            inferenceAttempt: attempt,
            retriesConsumed: attempt - 1,
            ...(responseCorrection ? { responseCorrection } : {}),
          }),
        );
        try {
          const bound = await fixture.decode(replies[Math.min(attempt, replies.length) - 1]);
          return { summary: JSON.stringify(bound.verificationResult) };
        } catch (error) {
          throw wrapTechnicalReviewFailure(error);
        }
      },
    });
    return { execution, prompts };
  }

  it("records the recorded reply shape as a model-correctable unlinked open fact", async () => {
    const error = await rejection(recordedFixture().decode(mismatchedJudgment()));
    expect(error).toMatchObject({
      message: "Technical correction response rejected: invalid-fact-link.",
      category: "malformed-response",
      retryable: true,
      rejection: UNLINKED,
    });
  });

  it("classifies the same unlinked fact identically in provisional verification", () => {
    const { ledger } = recordedFixture();
    let error: unknown;
    try {
      decodeProvisionalVerificationJudgment(
        canonicalizeJsonEvidence(mismatchedJudgment() as unknown as JsonEvidenceValue),
        ledger,
        TARGETS,
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ retryable: true, rejection: UNLINKED });
  });

  it("retries with the catalog rule the contract states, then admits the corrected reply", async () => {
    const { execution, prompts } = await run([mismatchedJudgment(), recordedJudgment]);
    expect(execution.status).toBe("succeeded");
    expect(execution.evidence).toMatchObject({ maxRetriesSource: "config/limits.yaml" });
    expect(execution.evidence.attempts).toMatchObject([
      {
        attempt: 1,
        outcome: "malformed-response",
        retryable: true,
        retryScheduled: true,
        conditionRetryability: "eligible",
        retryDecision: "retried",
        rejection: UNLINKED,
      },
      { attempt: 2, outcome: "succeeded" },
    ]);
    // The contract states the rule, and the hint repeats it.
    expect(prompts[0]).toContain(JUDGMENT_ISSUE_LINK_RULE);
    expect(prompts[0]).not.toContain("Host validation feedback");
    const feedback = prompts[1]!.slice(prompts[1]!.indexOf("Host validation feedback"));
    expect(feedback).toContain(
      "The previous response failed host rule judgment-fact-unlinked at $.issueJudgments[].obligationIds.",
    );
    expect(feedback).toContain(OUTPUT_RULE_HINTS["judgment-fact-unlinked"]!.rule);
    expect(feedback).not.toContain("both directions");
    expect(feedback).not.toContain("The host has no specific repair hint");
  });

  it("reports the last rejection when every attempt in the budget repeats the gap", async () => {
    const { execution } = await run([mismatchedJudgment()]);
    const attempts = configuredPolicy().maxRetries + 1;
    expect(execution.status).toBe("failed");
    expect(execution.evidence.attempts).toHaveLength(attempts);
    expect(execution.evidence.attempts.at(-1)).toMatchObject({
      attempt: attempts,
      retryable: true,
      retryScheduled: false,
      retryDecision: "exhausted",
      rejection: UNLINKED,
    });
    expect(execution).toMatchObject({
      error: {
        message: "Technical correction response rejected: invalid-fact-link.",
        rejection: UNLINKED,
      },
    });
  });

  it.each([
    ["credential material", ["glpat-abcdefghijklmnopqrstuv"], "docs/quickstart.md:1"],
  ] as const)(
    "declines %s as a terminal security refusal with budget left",
    async (_label, obligationIds, location) => {
      const judgment = structuredClone(recordedJudgment);
      judgment.issueJudgments[0] = {
        ...judgment.issueJudgments[0]!,
        obligationIds: [...obligationIds],
        location,
      };
      const { execution, prompts } = await run([judgment, recordedJudgment]);
      expect(execution.status).toBe("failed");
      expect(prompts).toHaveLength(1);
      expect(execution.evidence.attempts).toEqual([
        expect.objectContaining({
          retryable: false,
          retryScheduled: false,
          conditionRetryability: "eligible",
          retryDecision: "declined",
          rejection: { code: "unsafe-disclosure", location: "$response" },
        }),
      ]);
    },
  );
});

/**
 * A judgment reply links issues to facts in one direction only,
 * `issueJudgments[].obligationIds`. The host derives each retained or
 * replacement fact's `issueIds` from those links; an `issueIds` field the
 * reply still carries is ignored, not matched.
 */
describe("host-derived fact issue links in judgment replies (#1342)", () => {
  /** The recorded judgment with every obligation-side issue link removed. */
  function withoutIssueIds(): Judgment {
    const judgment = structuredClone(recordedJudgment);
    for (const row of judgment.obligationJudgments) {
      delete row.issueIds;
      for (const replacement of (row.replacements ?? []) as Array<Record<string, unknown>>) {
        delete replacement.issueIds;
      }
    }
    return judgment;
  }

  /**
   * The recorded judgment with every obligation-side link contradicting the
   * issue side: a documented obligation names an issue, the others name an issue
   * no judgment has, and each replacement names none.
   */
  function withStaleIssueIds(): Judgment {
    const judgment = structuredClone(recordedJudgment);
    for (const row of judgment.obligationJudgments) {
      if (row.disposition === "retained") {
        row.issueIds = row.documentationDisposition === "documented" ? ["TECH-001"] : ["TECH-999"];
      }
      for (const replacement of (row.replacements ?? []) as Array<Record<string, unknown>>) {
        replacement.issueIds = [];
      }
    }
    return judgment;
  }

  type Bound = Awaited<ReturnType<ReturnType<typeof recordedFixture>["decode"]>>;

  function factsOf(bound: Bound) {
    return bound.proposal.factInventory.dimensions.flatMap((dimension) => dimension.facts);
  }

  /** The non-documented facts of the obligations `issueId`'s judgment linked. */
  function expectedFactIds(bound: Bound, judgment: Judgment, issueId: string): string[] {
    const facts = factsOf(bound);
    const obligationIds = judgment.issueJudgments.find(({ id }) => id === issueId)!.obligationIds;
    return bound.proposal.obligationAccounting
      .filter(({ obligationId }) => obligationIds.includes(obligationId))
      .flatMap(({ factIds }) => factIds)
      .filter(
        (factId) =>
          facts.find(({ id }) => id === factId)!.documentationDisposition !== "documented",
      )
      .sort();
  }

  it("admits a reply whose obligation-side links contradict its issue judgments", async () => {
    const judgment = withStaleIssueIds();
    const bound = await recordedFixture().decode(judgment);
    const facts = factsOf(bound);
    for (const issue of bound.proposal.issueJudgments) {
      // A judgment's facts are exactly the open facts of its own obligations.
      expect([...issue.factIds].sort(), issue.id).toEqual(
        expectedFactIds(bound, judgment, issue.id),
      );
      for (const factId of issue.factIds) {
        expect(facts.find(({ id }) => id === factId)!.issueIds, factId).toContain(issue.id);
      }
    }
    for (const fact of facts) {
      // No stale value survives, and a documented fact has no issue.
      expect(fact.issueIds, fact.id).not.toContain("TECH-999");
      if (fact.documentationDisposition === "documented") expect(fact.issueIds).toEqual([]);
      else expect(fact.issueIds.length, fact.id).toBeGreaterThan(0);
    }
  });

  it("builds the same proposal whatever issueIds the reply carries", async () => {
    const fixture = recordedFixture();
    const [stale, absent, recordedShape] = await Promise.all([
      fixture.decode(withStaleIssueIds()),
      fixture.decode(withoutIssueIds()),
      fixture.decode(recordedJudgment),
    ]);
    expect(stale.proposal).toEqual(absent.proposal);
    expect(recordedShape.proposal).toEqual(absent.proposal);
  });

  it("derives the same links in provisional verification", () => {
    const { ledger } = recordedFixture();
    const decode = (judgment: Judgment) =>
      decodeProvisionalVerificationJudgment(
        canonicalizeJsonEvidence(judgment as unknown as JsonEvidenceValue),
        ledger,
        TARGETS,
      );
    const stale = decode(withStaleIssueIds());
    expect(stale).toEqual(decode(withoutIssueIds()));
    expect(stale.review.issues.map(({ id }) => id)).toEqual([
      "TECH-001",
      "TECH-002",
      "TECH-003",
      "TECH-004",
      "TECH-005",
    ]);
  });

  it("never gives a documented obligation's fact an issue beside an open link", async () => {
    const judgment = withoutIssueIds();
    judgment.issueJudgments[0]!.obligationIds.push("OBL-INPUT-REPRESENTATIONS-1");
    const bound = await recordedFixture().decode(judgment);
    expect(bound.proposal.issueJudgments.map(({ id }) => id)).toContain("TECH-001");
    const documented = factsOf(bound).filter(
      ({ documentationDisposition }) => documentationDisposition === "documented",
    );
    expect(documented.length).toBeGreaterThan(0);
    for (const fact of documented) expect(fact.issueIds, fact.id).toEqual([]);
  });

  /**
   * A judgment that links only documented obligations is refused by name, not
   * omitted silently, whether the reply states the link in one direction or
   * also on the documented row's issueIds.
   */
  it.each([
    ["one direction", false],
    ["both directions", true],
  ] as const)(
    "refuses a judgment that links only documented obligations (%s), in both judgment steps",
    async (_form, bothDirections) => {
      const judgment = withoutIssueIds();
      judgment.issueJudgments.push({
        ...judgment.issueJudgments[0]!,
        id: "TECH-006",
        obligationIds: ["OBL-INPUT-REPRESENTATIONS-1", "OBL-ENVIRONMENT-PREREQUISITE-1"],
      });
      if (bothDirections) {
        for (const row of judgment.obligationJudgments) {
          if (row.documentationDisposition === "documented") row.issueIds = ["TECH-006"];
        }
      }
      const expected = {
        message: "Technical correction response rejected: invalid-fact-link.",
        retryable: true,
        rejection: { code: "judgment-links-no-open-fact", location: "$.issueJudgments[]" },
      };
      const fixture = recordedFixture();
      expect(await rejection(fixture.decode(judgment))).toMatchObject(expected);
      let provisional: unknown;
      try {
        decodeProvisionalVerificationJudgment(
          canonicalizeJsonEvidence(judgment as unknown as JsonEvidenceValue),
          fixture.ledger,
          TARGETS,
        );
      } catch (error) {
        provisional = error;
      }
      expect(provisional).toMatchObject(expected);
    },
  );

  it("keeps target authority terminal ahead of the no-open-fact rule", async () => {
    const judgment = withoutIssueIds();
    judgment.issueJudgments.push({
      ...judgment.issueJudgments[0]!,
      id: "TECH-006",
      location: "docs/unapproved.md:1",
      obligationIds: ["OBL-INPUT-REPRESENTATIONS-1"],
    });
    expect(await rejection(recordedFixture().decode(judgment))).toMatchObject({
      message: "Technical correction response rejected: target-authority.",
      retryable: false,
    });
  });

  it("refuses a refined obligation whose open second replacement no judgment links", async () => {
    // OBL-DESTINATION-AND-TRUST-1 is refined into a documented replacement
    // followed by an omitted one; TECH-002 is the only judgment linking it.
    // The check must reach every replacement, not only the first fact.
    const judgment = withoutIssueIds();
    const refined = judgment.obligationJudgments.find(
      ({ obligationId }) => obligationId === "OBL-DESTINATION-AND-TRUST-1",
    )!;
    expect(
      (refined.replacements as Array<{ documentationDisposition: string }>).map(
        ({ documentationDisposition }) => documentationDisposition,
      ),
    ).toEqual(["documented", "omitted"]);
    judgment.issueJudgments = judgment.issueJudgments.filter(({ id }) => id !== "TECH-002");
    expect(await rejection(recordedFixture().decode(judgment))).toMatchObject({
      retryable: true,
      rejection: { code: "judgment-fact-unlinked", location: "$.issueJudgments[].obligationIds" },
    });
  });

  it("still refuses an open fact that no issue judgment links, in both judgment steps", async () => {
    const judgment = withoutIssueIds();
    // TECH-001 is the only judgment that links this conflicting obligation.
    judgment.issueJudgments = judgment.issueJudgments.filter(({ id }) => id !== "TECH-001");
    const expected = {
      message: "Technical correction response rejected: invalid-fact-link.",
      retryable: true,
      rejection: { code: "judgment-fact-unlinked", location: "$.issueJudgments[].obligationIds" },
    };
    const fixture = recordedFixture();
    expect(await rejection(fixture.decode(judgment))).toMatchObject(expected);
    let provisional: unknown;
    try {
      decodeProvisionalVerificationJudgment(
        canonicalizeJsonEvidence(judgment as unknown as JsonEvidenceValue),
        fixture.ledger,
        TARGETS,
      );
    } catch (error) {
      provisional = error;
    }
    expect(provisional).toMatchObject(expected);
  });

  it("keeps two-direction agreement as a terminal check of a host-built proposal", async () => {
    const fixture = recordedFixture();
    const bound = await fixture.decode(withoutIssueIds());
    const forged = structuredClone(bound.proposal);
    const fact = forged.factInventory.dimensions
      .flatMap((dimension) => dimension.facts)
      .find(({ issueIds }) => issueIds.includes("TECH-005"))!;
    fact.issueIds = [...fact.issueIds.filter((id) => id !== "TECH-005"), "TECH-001"];
    const error = await rejection(
      bindHostOwnedTechnicalCorrectionProposalV3(
        forged,
        fixture.ledger,
        fixture.admission,
        RUN_ID,
        TARGETS,
      ),
    );
    expect(error).toMatchObject({
      retryable: false,
      rejection: { code: "fact-link-judgment-fact-mismatch" },
    });
  });

  it("states one link direction in both judgment contracts", () => {
    expect(OBLIGATION_JUDGMENT_ACCOUNTING_CONTRACT).not.toContain("issueIds");
    for (const contract of [
      PROVISIONAL_VERIFICATION_JUDGMENT_CONTRACT,
      TECHNICAL_CORRECTION_RESPONSE_CONTRACT_V3,
    ]) {
      expect(contract).toContain(JUDGMENT_ISSUE_LINK_RULE);
      expect(contract).toContain(OUTPUT_RULE_HINTS["judgment-fact-unlinked"]!.rule);
      expect(contract).toContain(OUTPUT_RULE_HINTS["judgment-links-no-open-fact"]!.rule);
      expect(contract).not.toContain("both directions");
      expect(contract).not.toContain("host omits a judgment");
    }
  });
});

/**
 * The ordinary verification reply is unchanged: the model writes the fact
 * inventory, `issueIds` is its only link direction, and every semantic rule on
 * it still refuses.
 */
describe("fact issue links in an ordinary verification reply (#1342)", () => {
  const TARGET = "docs/page.md";

  function withIssue(disposition: string, issueIds: string[]): string {
    const result = verificationResultFixture([TARGET]);
    result.review = {
      verdict: "needs-revision",
      issues: [
        {
          id: "TECH-001",
          severity: "major",
          category: "completeness",
          location: `${TARGET}:1`,
          finding: "The page omits the fixture behavior.",
          evidence: { source_id: "fixture", locator: "src/api.ts:42" },
          required_change: "Document the fixture behavior.",
        },
      ],
    };
    const fact = result.factInventory.dimensions[0]!.facts[0]!;
    fact.documentationDisposition = disposition as typeof fact.documentationDisposition;
    fact.issueIds = issueIds;
    return JSON.stringify(result);
  }

  function refusal(response: string): unknown {
    try {
      decodeVerificationResponse(response, [TARGET]);
    } catch (error) {
      return error;
    }
    throw new Error("expected the verification reply to be rejected");
  }

  it("admits a fact linked to its own issue", () => {
    expect(
      decodeVerificationResponse(withIssue("omitted", ["TECH-001"]), [TARGET]).review.issues,
    ).toHaveLength(1);
  });

  it.each([
    ["a documented fact with an issue", "documented", ["TECH-001"]],
    ["a non-documented fact with no issue", "omitted", []],
    ["a fact that names an issue the review lacks", "omitted", ["TECH-002"]],
  ] as const)("still refuses %s", (_label, disposition, issueIds) => {
    expect(refusal(withIssue(disposition, [...issueIds]))).toMatchObject({
      retryable: true,
      rejection: { code: "inventory-fact-finding-link", location: "$.factInventory" },
    });
  });
});
