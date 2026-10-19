// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { InferenceStepError } from "../src/execution/contracts.js";
import { SOURCE_OBLIGATION_RULE_HINTS } from "../src/workflow-execution/source-obligation-rule-hints.js";
import { OUTPUT_RULE_HINTS } from "../src/contracts/model-output.js";
import {
  SOURCE_OBLIGATION_REJECTION_RETRYABILITY,
  isModelCorrectableSourceObligationRejection,
} from "../src/workflow-execution/source-obligation-rejection-retryability.js";
import {
  SOURCE_OBLIGATION_KIT_REJECTION_CODES,
  SOURCE_OBLIGATION_REJECTION_CODES,
  SOURCE_OBLIGATION_REJECTION_RETRYABILITY_COVERAGE,
  projectSourceObligationRejection,
  rejectSourceObligationKit,
  type SourceObligationKitRejectionCode,
  type SourceObligationRejectionCode,
} from "../src/workflow-execution/source-obligation.js";

/**
 * Authority, credential-material, and integrity rejections stop. The
 * `host-path-disclosure` code is recorded only by older hosts and stays
 * model-correctable, as they last classified it. Pinned so a change to the
 * table is a visible decision.
 */
const TERMINAL: readonly SourceObligationRejectionCode[] = [
  "unauthorized-source",
  "digest-mismatch",
  "stale-evidence",
  "credential-material",
];

const KIT_CODES = Object.keys(
  SOURCE_OBLIGATION_KIT_REJECTION_CODES,
) as SourceObligationKitRejectionCode[];

function thrown(run: () => unknown): InferenceStepError {
  try {
    run();
  } catch (error) {
    if (error instanceof InferenceStepError) return error;
    throw error;
  }
  throw new Error("expected a rejection");
}

describe("source-obligation rejection retryability table (#1292)", () => {
  it("classifies every closed code exactly once, with a reason", () => {
    // The compile-time reading: a code without an entry, or a stale entry,
    // fails the typecheck before this runs.
    expect(SOURCE_OBLIGATION_REJECTION_RETRYABILITY_COVERAGE).toBe(true);
    expect(Object.keys(SOURCE_OBLIGATION_REJECTION_RETRYABILITY).sort()).toEqual(
      [...SOURCE_OBLIGATION_REJECTION_CODES].sort(),
    );
    for (const code of SOURCE_OBLIGATION_REJECTION_CODES) {
      const entry = SOURCE_OBLIGATION_REJECTION_RETRYABILITY[code];
      expect(["model-correctable", "terminal"], code).toContain(entry.retry);
      expect(entry.reason.trim().length, code).toBeGreaterThan(0);
    }
  });

  it("stops on authority, credential, and integrity codes and retries every other code", () => {
    for (const code of SOURCE_OBLIGATION_REJECTION_CODES) {
      expect(isModelCorrectableSourceObligationRejection(code), code).toBe(
        !TERMINAL.includes(code),
      );
    }
  });

  it("gives every model-correctable code a rule hint", () => {
    for (const code of SOURCE_OBLIGATION_REJECTION_CODES.filter(
      isModelCorrectableSourceObligationRejection,
    )) {
      const hint = SOURCE_OBLIGATION_RULE_HINTS[code] ?? OUTPUT_RULE_HINTS[code];
      expect(hint?.rule.trim().length, code).toBeGreaterThan(0);
    }
  });

  it.each(KIT_CODES)("raises the kit code %s with the table's classification", (kitCode) => {
    const code = SOURCE_OBLIGATION_KIT_REJECTION_CODES[kitCode];
    const error = thrown(() => rejectSourceObligationKit(kitCode));
    expect(error.category).toBe("malformed-response");
    expect(error.retryable).toBe(isModelCorrectableSourceObligationRejection(code));
    expect(projectSourceObligationRejection(error)).toEqual({ code, location: "$" });
  });

  it("keeps credential material and a digest mismatch terminal on the kit path", () => {
    expect(thrown(() => rejectSourceObligationKit("kit-credential-material")).retryable).toBe(
      false,
    );
    expect(thrown(() => rejectSourceObligationKit("kit-digest-mismatch")).retryable).toBe(false);
  });
});
