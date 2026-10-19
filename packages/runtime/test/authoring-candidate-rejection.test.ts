// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The inner reason the CREATE revision selection refused its admitted
 * candidate-zero evidence. When technical verification reports coverage
 * `unverified`, the run records `authoring-candidate-unverified-coverage` at
 * `$.coverage[].status` with its class, not `{class: unknown}`.
 */
import { describe, expect, it } from "vitest";

import { INFERENCE_REJECTION_LOCATION_GRAMMAR } from "../src/config/inference-rejection-limits.js";
import {
  AUTHORING_CANDIDATE_REJECTION_FAILURE_CLASSES,
  attachRunFailureClassifications,
  authoringCandidateRejectionFailure,
  markRunAuthoringCandidateRejection,
  markRunThrownFailure,
  readRunFailure,
} from "../src/operator/failure-classification.js";
import { isFailureCode } from "../src/operator/failure-class.js";
import { formatRunFailureDiagnosticLines } from "../src/operator/run-summary.js";
import type { RunRecord } from "../src/records/contracts.js";
import {
  AUTHORING_CANDIDATE_ERROR_CODES,
  AUTHORING_CANDIDATE_REJECTION_CODES,
  AuthoringCandidateContractError,
  authoringCandidateRejectionOf,
  readAuthoringCandidateRejection,
} from "../src/workflow-execution/authoring-candidate.js";

const UNVERIFIED_COVERAGE = Object.freeze({
  code: "authoring-candidate-unverified-coverage",
  location: "$.coverage[].status",
});

/** A failed CREATE run whose seven prefix steps all succeeded. */
function stoppedCreateRecord(): RunRecord {
  return {
    id: "run-1293",
    workflow: "create-documentation",
    status: "failed",
    error: "Authoring candidate contract rejected: unverified-coverage.",
    steps: [
      { id: "provisional-technical-verification", status: "succeeded" },
      { id: "review-documentation", status: "succeeded" },
      { id: "verify-technical-accuracy", status: "succeeded" },
    ],
  } as unknown as RunRecord;
}

describe("authoring candidate refusal inner reason (#1293)", () => {
  it("reduces the unverified-coverage refusal to its code and coverage status location", () => {
    expect(
      authoringCandidateRejectionOf(new AuthoringCandidateContractError("unverified-coverage")),
    ).toEqual(UNVERIFIED_COVERAGE);
  });

  it("records the whole selection context for a code raised from several rules", () => {
    expect(
      authoringCandidateRejectionOf(new AuthoringCandidateContractError("stale-evidence")),
    ).toEqual({ code: "authoring-candidate-stale-evidence", location: "$" });
  });

  it("reads no inner reason from an error that is not a coded authoring candidate refusal", () => {
    const lookalike = Object.assign(new Error("unverified-coverage"), {
      code: "unverified-coverage",
    });
    expect(authoringCandidateRejectionOf(lookalike)).toBeUndefined();
    expect(authoringCandidateRejectionOf("unverified-coverage")).toBeUndefined();
    const offCatalog = new AuthoringCandidateContractError("unverified-coverage");
    Object.defineProperty(offCatalog, "code", { value: "not-a-candidate-code" });
    expect(authoringCandidateRejectionOf(offCatalog)).toBeUndefined();
  });

  it("gives every inner code a class, a code grammar match, and a retained location", () => {
    expect(Object.keys(AUTHORING_CANDIDATE_REJECTION_FAILURE_CLASSES).sort()).toEqual(
      [...AUTHORING_CANDIDATE_REJECTION_CODES].sort(),
    );
    expect(AUTHORING_CANDIDATE_REJECTION_CODES).toHaveLength(
      AUTHORING_CANDIDATE_ERROR_CODES.length,
    );
    for (const code of AUTHORING_CANDIDATE_ERROR_CODES) {
      const rejection = authoringCandidateRejectionOf(new AuthoringCandidateContractError(code));
      expect(rejection?.code).toBe(`authoring-candidate-${code}`);
      expect(isFailureCode(rejection!.code)).toBe(true);
      expect(INFERENCE_REJECTION_LOCATION_GRAMMAR.test(rejection!.location)).toBe(true);
      expect(authoringCandidateRejectionFailure(rejection!).class).not.toBe("unknown");
    }
  });

  it("classes unverified coverage as model content and every host binding refusal as contract shape", () => {
    expect(authoringCandidateRejectionFailure(UNVERIFIED_COVERAGE)).toEqual({
      class: "model-content",
      layer: "workflow",
      code: "authoring-candidate-unverified-coverage",
    });
    for (const [code, failureClass] of Object.entries(
      AUTHORING_CANDIDATE_REJECTION_FAILURE_CLASSES,
    )) {
      if (code === UNVERIFIED_COVERAGE.code) continue;
      expect(failureClass, code).toBe("contract-shape");
    }
  });

  it("records the inner reason and its class on a run stopped between steps", () => {
    const record = stoppedCreateRecord();
    const error = new AuthoringCandidateContractError("unverified-coverage");
    expect(
      markRunAuthoringCandidateRejection(record, authoringCandidateRejectionOf(error), {
        cancelled: false,
      }),
    ).toBe(true);
    markRunThrownFailure(record, error, { cancelled: false });

    expect(record.authoringCandidateRejection).toEqual(UNVERIFIED_COVERAGE);
    expect(record.failure).toEqual({
      class: "model-content",
      layer: "workflow",
      code: "authoring-candidate-unverified-coverage",
    });
    attachRunFailureClassifications(record);
    expect(readRunFailure(record)?.code).toBe("authoring-candidate-unverified-coverage");
    expect(readAuthoringCandidateRejection(record.authoringCandidateRejection)).toEqual(
      UNVERIFIED_COVERAGE,
    );
  });

  it.each([
    ["cancellation", { cancelled: true }, undefined],
    ["a run store failure", { cancelled: false, storeCode: "write-failed" as const }, undefined],
    ["a failed step", { cancelled: false }, "failed-step"],
    ["an earlier recorded class", { cancelled: false }, "earlier-class"],
  ])("leaves the first cause to %s", (_name, options, variant) => {
    const record = stoppedCreateRecord();
    if (variant === "failed-step") record.steps[1]!.status = "failed";
    const earlier = {
      class: "infrastructure",
      layer: "workflow",
      code: "patch-persistence-failed",
    };
    if (variant === "earlier-class") record.failure = earlier as RunRecord["failure"];

    expect(markRunAuthoringCandidateRejection(record, UNVERIFIED_COVERAGE, options)).toBe(false);
    expect(record.authoringCandidateRejection).toBeUndefined();
    expect(record.failure).toEqual(variant === "earlier-class" ? earlier : undefined);
  });

  it("drops the inner reason from a record that did not fail", () => {
    const record = {
      ...stoppedCreateRecord(),
      status: "succeeded",
      authoringCandidateRejection: UNVERIFIED_COVERAGE,
    } as RunRecord;
    attachRunFailureClassifications(record);
    expect(record.authoringCandidateRejection).toBeUndefined();
  });

  it("reads back only the closed code with its own location", () => {
    expect(readAuthoringCandidateRejection({ ...UNVERIFIED_COVERAGE })).toEqual(
      UNVERIFIED_COVERAGE,
    );
    for (const value of [
      undefined,
      null,
      [],
      { code: UNVERIFIED_COVERAGE.code },
      { ...UNVERIFIED_COVERAGE, detail: "extra" },
      { code: "unverified-coverage", location: UNVERIFIED_COVERAGE.location },
      { code: "authoring-candidate-not-a-code", location: "$" },
      { code: UNVERIFIED_COVERAGE.code, location: "$" },
      { code: UNVERIFIED_COVERAGE.code, location: "$.coverage[0].status" },
      { code: "authoring-candidate-stale-evidence", location: "$.coverage[].status" },
    ]) {
      expect(readAuthoringCandidateRejection(value)).toBeNull();
    }
  });

  it("names the rule and location in the run failure diagnostics", () => {
    const record = stoppedCreateRecord();
    markRunAuthoringCandidateRejection(record, UNVERIFIED_COVERAGE, { cancelled: false });
    const lines = formatRunFailureDiagnosticLines(record);
    expect(lines).toContain(
      "Failure class: model-content (layer workflow, code authoring-candidate-unverified-coverage).",
    );
    expect(lines).toContain(
      "Authoring candidate rejected by authoring-candidate-unverified-coverage at $.coverage[].status.",
    );

    const forged = {
      ...stoppedCreateRecord(),
      authoringCandidateRejection: { code: "x", location: "/tmp" },
    };
    expect(
      formatRunFailureDiagnosticLines(forged as RunRecord).some((line) =>
        line.startsWith("Authoring candidate rejected"),
      ),
    ).toBe(false);
  });
});
