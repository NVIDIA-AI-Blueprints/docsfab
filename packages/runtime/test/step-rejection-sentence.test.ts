// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { fingerprintRejectedReply } from "../src/execution/rejected-reply-shape.js";
import { formatStepRejectionSentence } from "../src/operator/retry-disposition.js";
import type { RunRecord } from "../src/records/contracts.js";

type Step = RunRecord["steps"][number];

function step(fields: Record<string, unknown>): Step {
  return { id: "verify-technical-accuracy", status: "failed", ...fields } as unknown as Step;
}

describe("failed step rejection sentence (#1180)", () => {
  it("names the terminal attempt's inner rule, location, and reply keys", () => {
    expect(
      formatStepRejectionSentence(
        step({
          inference: {
            attempts: [
              {
                attempt: 1,
                outcome: "malformed-response",
                rejection: { code: "invalid-json", location: "$response" },
              },
              {
                attempt: 2,
                outcome: "malformed-response",
                rejection: {
                  code: "fact-link-unknown-obligation",
                  location: "$.issueJudgments[].obligationIds[]",
                },
                rejectedReplyShape: fingerprintRejectedReply(
                  '{"verdict":"pass","coverage":[],"issueJudgments":[]}',
                  () => true,
                ),
              },
            ],
          },
        }),
      ),
    ).toBe(
      "Rejected by fact-link-unknown-obligation at $.issueJudgments[].obligationIds[]; reply keys verdict, coverage, issueJudgments.",
    );
  });

  it("names a quality validator's inner rule with its issue count", () => {
    expect(
      formatStepRejectionSentence(
        step({
          id: "evaluate-document-quality",
          qualityValidationRejection: {
            validator: "evaluation",
            code: "required-dimension-not-applicable",
            location: "$.layers",
            issueCount: 3,
          },
        }),
      ),
    ).toBe(
      "Rejected by required-dimension-not-applicable at $.layers (3 quality validator issues).",
    );
  });

  it("does not echo a hand-edited code or location that is outside the retained grammar", () => {
    const prose = "SENTINEL the reply said this";
    expect(
      formatStepRejectionSentence(
        step({
          qualityValidationRejection: {
            validator: "evaluation",
            code: prose,
            location: "$",
            issueCount: 1,
          },
          inference: {
            attempts: [
              {
                attempt: 1,
                outcome: "malformed-response",
                rejection: { code: "x", location: prose },
              },
            ],
          },
        }),
      ),
    ).toBeUndefined();
    expect(formatStepRejectionSentence(step({}))).toBeUndefined();
  });
});
