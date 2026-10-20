// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { parseRetryPolicy } from "../src/config/retry-policy.js";
import { canonicalDigest } from "../src/content-ir/canonical.js";
import { OUTPUT_RULES, OUTPUT_RULE_HINTS } from "../src/contracts/model-output.js";
import { InferenceStepError, type HarnessStepInput } from "../src/execution/contracts.js";
import { buildHostStepPrompt } from "../src/harness/pi.js";
import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../src/json-evidence.js";
import { executeInferenceStep } from "../src/workflow-execution/retry.js";
import {
  decodeVerificationResponse,
  wrapTechnicalReviewFailure,
} from "../src/workflow-execution/review-response.js";
import {
  OBLIGATION_JUDGMENT_ACCOUNTING_CONTRACT,
  decodeProvisionalVerificationJudgment,
  decodeTechnicalCorrectionResponseV3,
  judgmentCoveragePolicy,
} from "../src/workflow-execution/source-obligation.js";
import {
  RECORDED_JUDGMENT_TARGET,
  probe7AttemptRows,
  recordedReviewJudgmentFixture,
} from "./helpers/recorded-review-judgment.js";
import { verificationResultFixture } from "./helpers/verification.js";

/**
 * The `documentationDisposition` rule is a catalog declaration
 * (`config/model-output/rules/technical-judgment.yaml`), stated with its values
 * in both judgment contracts and repeated by the retry hint, and the judgment
 * fill raises it at the member the model wrote rather than `$.factInventory`.
 */
const CODE = "judgment-documentation-disposition-invalid";
const RETAINED = "$.obligationJudgments[].documentationDisposition";
const REPLACEMENT = "$.obligationJudgments[].replacements[].documentationDisposition";
const TARGETS = [RECORDED_JUDGMENT_TARGET];
const RUN_ID = "review-cli-1219";

function fixture() {
  return recordedReviewJudgmentFixture("/workspace");
}

/** Both judgment decoders over the recorded ledger, under the review workflow's policy. */
function decoders(built = fixture()) {
  const policy = judgmentCoveragePolicy(built.provisional);
  return {
    provisional: async (reply: string) =>
      decodeProvisionalVerificationJudgment(reply, built.ledger, TARGETS, undefined, policy),
    correction: async (reply: string) =>
      decodeTechnicalCorrectionResponseV3(
        reply,
        built.ledger,
        built.correction.originalSourceAuthorityAdmission,
        RUN_ID,
        TARGETS,
        undefined,
        policy,
      ),
  };
}

async function refusal(run: () => Promise<unknown>): Promise<InferenceStepError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(InferenceStepError);
    return error as InferenceStepError;
  }
  throw new Error("expected the judgment to be refused");
}

/** The recorded judgment with each row passed through `patch`. */
function withRows(
  judgment: Record<string, unknown>,
  patch: (row: Record<string, unknown>) => Record<string, unknown>,
): string {
  return JSON.stringify({
    ...judgment,
    obligationJudgments: (judgment.obligationJudgments as Array<Record<string, unknown>>).map(
      patch,
    ),
  });
}

describe("T8: both judgment contracts state the documentation disposition rule", () => {
  const statement = OUTPUT_RULES[CODE].statement;

  it("declares the five values, where the member is required, and that unassessed is not one", () => {
    for (const value of [
      '"documented"',
      '"omitted"',
      '"conflicting"',
      '"unverified-policy"',
      '"product-defect"',
      '"unassessed"',
      "obligationJudgments",
      "retained row",
      "replacement of a refined row",
      "rejected row sets none",
    ]) {
      expect(statement).toContain(value);
    }
    expect(OBLIGATION_JUDGMENT_ACCOUNTING_CONTRACT).toContain(statement);
  });

  it.each(["provisional-technical-verification", "verify-technical-accuracy"] as const)(
    "renders it into the %s prompt",
    (stepId) => {
      // The judgment prompt states the member's values, not only its name.
      const built = fixture();
      const input = stepId === "verify-technical-accuracy" ? built.correction : built.provisional;
      const prompt = buildHostStepPrompt(input);

      expect(prompt).toContain(statement);
      expect(prompt).toContain("unverified-policy");
      expect(prompt).toContain("product-defect");
    },
  );
});

describe("T9: the judgment fill raises the rule at the member the model wrote", () => {
  it.each(["provisional", "correction"] as const)(
    "refuses probe 7's rows without documentationDisposition at the row member (%s)",
    async (decoder) => {
      // Raised at the member, not as `inventory-fact-disposition` at
      // `$.factInventory`.
      const built = fixture();
      const error = await refusal(() =>
        decoders(built)[decoder](probe7AttemptRows(built.judgment)),
      );

      expect(error.rejection).toEqual({ code: CODE, location: RETAINED });
      expect(error.message).toBe("Technical correction response rejected: invalid-fact-inventory.");
      expect(error.category).toBe("malformed-response");
      expect(error.retryable).toBe(true);
    },
  );

  it.each(["provisional", "correction"] as const)(
    "refuses a retained row whose disposition is unassessed the same way (%s)",
    async (decoder) => {
      // The skill's working value (`SKILL.md` "Initialize ... as unassessed")
      // is not a judgment value.
      const built = fixture();
      const reply = withRows(built.judgment, (row) =>
        row.obligationId === "OBL-INPUT-REPRESENTATIONS-2"
          ? { ...row, documentationDisposition: "unassessed" }
          : row,
      );

      const error = await refusal(() => decoders(built)[decoder](reply));

      expect(error.rejection).toEqual({ code: CODE, location: RETAINED });
      expect(error.retryable).toBe(true);
    },
  );

  it.each(["provisional", "correction"] as const)(
    "refuses a refined replacement without documentationDisposition at the replacement member (%s)",
    async (decoder) => {
      const built = fixture();
      const reply = withRows(built.judgment, (row) =>
        row.disposition === "refined"
          ? {
              ...row,
              replacements: (row.replacements as Array<Record<string, unknown>>).map(
                ({ documentationDisposition: _dropped, ...replacement }) => replacement,
              ),
            }
          : row,
      );

      const error = await refusal(() => decoders(built)[decoder](reply));

      expect(error.rejection).toEqual({ code: CODE, location: REPLACEMENT });
      expect(error.retryable).toBe(true);
    },
  );

  it("ignores a documentationDisposition on a rejected row, as before", async () => {
    // Positive control for the rejected path: only retained rows and refined
    // replacements carry the member, so a stray one on a rejected row is not
    // read and is not refused.
    const built = fixture();
    const reply = withRows(built.judgment, (row) =>
      row.obligationId === "OBL-INPUT-REPRESENTATIONS-1"
        ? {
            obligationId: row.obligationId,
            disposition: "rejected",
            reason: "The admitted source does not establish this input representation.",
            documentationDisposition: "unassessed",
          }
        : row,
    );

    const result = await decoders(built).provisional(reply);

    expect(result.review.verdict).toBe("needs-revision");
  });
});

describe("T10: the retry names the member and repeats the catalog statement", () => {
  it("re-asks with the rule at obligationJudgments, never the fact-inventory hint", async () => {
    const built = fixture();
    const policy = parseRetryPolicy({});
    expect(policy.maxRetriesSource).toBe("config/limits.yaml");
    expect(policy.retryableCategories).toContain("malformed-response");
    const replies = [probe7AttemptRows(built.judgment), built.answer];
    const prompts: string[] = [];

    const execution = await executeInferenceStep({
      mode: "read-only",
      policy,
      sleep: async () => {},
      execute: async (attempt, responseCorrection) => {
        const input: HarnessStepInput = {
          ...built.provisional,
          inferenceAttempt: attempt,
          retriesConsumed: attempt - 1,
          ...(responseCorrection ? { responseCorrection } : {}),
        };
        prompts.push(buildHostStepPrompt(input));
        try {
          const result = await decoders(built).provisional(replies[attempt - 1]!);
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
        rejection: { code: CODE, location: RETAINED },
      },
      { attempt: 2, outcome: "succeeded" },
    ]);
    const feedback = prompts[1]!.slice(prompts[1]!.indexOf("Host validation feedback"));
    expect(feedback).toContain(`The previous response failed host rule ${CODE} at ${RETAINED}.`);
    expect(feedback).toContain(OUTPUT_RULE_HINTS[CODE]!.rule);
    expect(feedback).not.toContain("Each fact documentationDisposition");
    expect(feedback).not.toContain("$.factInventory");
  });
});

describe("T11: the verification-result path keeps its fact-inventory rule", () => {
  it("still records inventory-fact-disposition at $.factInventory for a full verification result", () => {
    const result = verificationResultFixture(["docs/guide.md"]) as unknown as {
      factInventory: { dimensions: Array<{ facts: Array<Record<string, unknown>> }> };
    };
    const fact = result.factInventory.dimensions.flatMap((dimension) => dimension.facts)[0];
    expect(fact).toBeDefined();
    fact!.documentationDisposition = "unassessed";

    let error: unknown;
    try {
      decodeVerificationResponse(canonicalizeJsonEvidence(result as unknown as JsonEvidenceValue), [
        "docs/guide.md",
      ]);
    } catch (caught) {
      error = caught;
    }

    expect(error).toMatchObject({
      message: "Technical review response rejected: invalid-fact-inventory.",
      retryable: true,
      rejection: { code: "inventory-fact-disposition", location: "$.factInventory" },
    });
  });
});

describe("T12: real-reply positive control", () => {
  // The canonical digest of each decoder result for the recorded judgment,
  // pinned so a change to how that valid reply decodes fails here.
  it.each([
    ["provisional", "34db6f9493bee954479a84acdaf9b10fba626283a5b5116dee0a5afafb4c6ab1"],
    ["correction", "12c45f0e474c5cff14a22bab6f12bf690b78ea10a1b4817e311c441f739ad8e9"],
  ] as const)("decodes the recorded judgment exactly as before (%s)", async (decoder, digest) => {
    const result = await decoders()[decoder](fixture().answer);
    expect(canonicalDigest(result)).toBe(digest);
  });
});
