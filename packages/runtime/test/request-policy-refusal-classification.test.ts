// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * An installed request policy refusal is classified by its own catalogued
 * code: in the attempt's failure class, the run index row, `docsfab why`, the
 * physical request accounting, and the operator docs.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { classifyAttemptRow, classifyRecordedFailure } from "../src/diagnosis/classify.js";
import { DIAGNOSIS_CAUSE_OWNERS } from "../src/diagnosis/contracts.js";
import { accountProviderAttempts } from "../src/model/provider-attempt.js";
import { ProviderRequestPolicyError } from "../src/model/request-policy.js";
import {
  REQUEST_POLICY_REFUSAL_IDS,
  REQUEST_POLICY_REFUSALS,
  requestPolicyFailureCode,
  requestPolicyRefusalOfCode,
} from "../src/model/request-policy-refusals.js";
import {
  classifyInferenceAttempt,
  classifyInferenceFailure,
  classifyThrownFailure,
  operatorCodeFailureClass,
} from "../src/operator/failure-classification.js";
import type { InferenceAttemptEvidence } from "../src/records/contracts.js";
import type { RunIndexRowV1 } from "../src/records/run-index.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const COMMANDS = { whyJson: "docsfab why run --json", runsShow: "docsfab runs show run" };

/** A failing attempt row; only the fields a classifier reads matter. */
function row(fields: Partial<RunIndexRowV1>): RunIndexRowV1 {
  return {
    rowKind: "attempt",
    outcome: "provider-terminal",
    stepId: "derive-source-obligations",
    failureClass: null,
    failureLayer: null,
    failureCode: null,
    rejectionSource: null,
    rejectionCode: null,
    rejectionLocation: null,
    rejectedReplyParseCode: null,
    finishReason: null,
    outputTokens: null,
    outputAllowance: null,
    providerErrorClass: null,
    httpStatus: null,
    attemptOutputTokens: null,
    continuations: null,
    model: "nvidia/nvidia/nemotron-3-ultra",
    provider: "nvidia-inference-api",
    ...fields,
  } as RunIndexRowV1;
}

const turn = (fields: Record<string, unknown>) => ({
  decision: "proceed",
  requestDigest: "a".repeat(64),
  evidenceDigest: "b".repeat(64),
  ...fields,
});

describe("request policy refusal: failure classification", () => {
  it("reads the refusal before an output-limit stop the last landed turn recorded", () => {
    expect(
      classifyInferenceFailure({
        category: "provider-terminal",
        requestPolicyRefusal: "message-shape",
        finishReason: "length",
        modelTelemetry: { schemaVersion: 1, finishReason: "length", providerLatencyMs: 1 },
        executionLimitCode: "execution-tool-calls-bound",
        condition: "cut-answer",
      }),
    ).toEqual({
      class: "contract-shape",
      layer: "inference",
      code: "request-policy-message-shape",
    });
    // Positive control: without the refusal the same evidence is an output-limit stop.
    expect(
      classifyInferenceFailure({ category: "provider-terminal", finishReason: "length" }).code,
    ).toBe("output-limit-reached");
  });

  it("reads only the attempt's last turn, and only a catalogued refusal", () => {
    const attempt = (turns: unknown[]) =>
      ({ attempt: 1, outcome: "provider-terminal", turns }) as unknown as InferenceAttemptEvidence;
    expect(
      classifyInferenceAttempt(attempt([turn({}), turn({ requestPolicyRefusal: "message-shape" })]))
        ?.code,
    ).toBe("request-policy-message-shape");
    expect(
      classifyInferenceAttempt(attempt([turn({ requestPolicyRefusal: "message-shape" }), turn({})]))
        ?.code,
    ).toBe("provider-terminal");
    expect(
      classifyInferenceAttempt(attempt([turn({ requestPolicyRefusal: "message-73" })]))?.code,
    ).toBe("provider-terminal");
  });

  it("classifies a thrown refusal by its closed reason, and every catalogued code", () => {
    expect(
      classifyThrownFailure(new ProviderRequestPolicyError("output-limit"), "workflow"),
    ).toEqual({ class: "contract-shape", layer: "workflow", code: "request-policy-output-limit" });
    for (const refusal of REQUEST_POLICY_REFUSAL_IDS) {
      const code = requestPolicyFailureCode(refusal);
      expect(requestPolicyRefusalOfCode(code)).toBe(refusal);
      expect(operatorCodeFailureClass(code)).toBe(REQUEST_POLICY_REFUSALS[refusal].failureClass);
    }
    expect(operatorCodeFailureClass("request-policy-message-73")).toBeUndefined();
    expect(requestPolicyRefusalOfCode("request-policy-")).toBeUndefined();
  });
});

describe("request policy refusal: docsfab why", () => {
  it("names the refusal on an attempt row before an output-limit finish reason", () => {
    const reading = classifyAttemptRow(
      row({
        failureCode: "request-policy-message-shape",
        failureClass: "contract-shape",
        failureLayer: "inference",
        finishReason: "length",
        outputTokens: 4096,
        outputAllowance: 4096,
      }),
      COMMANDS,
    );
    expect(reading.cause).toBe("request-policy-refused");
    expect(DIAGNOSIS_CAUSE_OWNERS[reading.cause]).toBe("docsfab-defect");
    expect(reading.why).toContain(REQUEST_POLICY_REFUSALS["message-shape"].meaning);
    expect(reading.nextAction).toBe(REQUEST_POLICY_REFUSALS["message-shape"].next);
    expect(reading.signature).toEqual({ failureCode: "request-policy-message-shape" });
    // Positive control: the same row without the code is the output limit's.
    expect(classifyAttemptRow(row({ finishReason: "length" }), COMMANDS).cause).toBe(
      "output-allowance-reached",
    );
  });

  it("names it on step and run rows instead of blaming the reply's shape", () => {
    for (const rowKind of ["step", "run"] as const) {
      const recorded = row({
        rowKind,
        outcome: "failed",
        failureCode: "request-policy-message-shape",
        failureClass: "contract-shape",
        failureLayer: "inference",
      });
      expect(classifyRecordedFailure(recorded, COMMANDS).cause).toBe("request-policy-refused");
      expect(
        classifyRecordedFailure({ ...recorded, failureCode: "malformed-json" }, COMMANDS).cause,
      ).toBe("reply-shape-rejected");
    }
  });

  it("gives an unverified installed policy to the operator", () => {
    const reading = classifyAttemptRow(
      row({ failureCode: "request-policy-policy-subject", failureClass: "operator-input" }),
      COMMANDS,
    );
    expect([reading.cause, DIAGNOSIS_CAUSE_OWNERS[reading.cause]]).toEqual([
      "installed-policy-unverified",
      "operator-configuration",
    ]);
    expect(reading.nextAction).toBe(REQUEST_POLICY_REFUSALS["policy-subject"].next);
  });

  it("is documented for every catalogued refusal", () => {
    const page = readFileSync(
      resolve(projectRoot, "../../docs/reference/status-and-configuration/diagnose-failed-runs.md"),
      "utf8",
    );
    expect(page).toContain("`request-policy-refused`");
    expect(page).toContain("`installed-policy-unverified`");
    const rows = page
      .split("\n")
      .filter(
        (line) =>
          line.startsWith("| `request-policy-") && !line.startsWith("| `request-policy-refused`"),
      );
    expect(rows).toHaveLength(REQUEST_POLICY_REFUSAL_IDS.length);
    // Each row is the catalog's own id, class, and meaning, so the page cannot drift.
    for (const refusal of REQUEST_POLICY_REFUSAL_IDS) {
      const { failureClass, meaning } = REQUEST_POLICY_REFUSALS[refusal];
      expect(rows).toContain(
        `| \`${requestPolicyFailureCode(refusal)}\` | \`${failureClass}\` | ${meaning} |`,
      );
    }
  });
});

describe("request policy refusal: physical request accounting", () => {
  it("counts an unsealed refused turn as a known zero", () => {
    expect(
      accountProviderAttempts([
        turn({ finalPayloadSha256: "c".repeat(64) }),
        turn({ requestPolicyRefusal: "message-shape" }),
      ]),
    ).toMatchObject({
      logicalTurns: 1,
      physicalRequests: 1,
      requestPolicyRefusedTurns: 1,
      unaccountedTurns: 0,
      coverage: "complete",
    });
    // Without the refusal the same row is unaccounted.
    expect(accountProviderAttempts([turn({})])).toMatchObject({
      unaccountedTurns: 1,
      coverage: "partial",
    });
  });

  it("does not count a request the send gate refused after promoting it", () => {
    const sealed = { finalPayloadSha256: "c".repeat(64) };
    expect(
      accountProviderAttempts([
        turn({ ...sealed, providerRetries: 2, requestPolicyRefusal: "payload-send" }),
      ]),
    ).toMatchObject({ physicalRequests: 2, replayedRequests: 1 });
    expect(
      accountProviderAttempts([turn({ ...sealed, requestPolicyRefusal: "payload-send" })]),
    ).toMatchObject({ physicalRequests: 0, replayedRequests: 0 });
    // A resend was refused after the counted request went out, so it counts.
    expect(
      accountProviderAttempts([turn({ ...sealed, requestPolicyRefusal: "payload-resend" })]),
    ).toMatchObject({ physicalRequests: 1, replayedRequests: 0 });
    // A replay the ledger check refused was never promoted, so the count stands.
    expect(
      accountProviderAttempts([
        turn({ ...sealed, providerRetries: 2, requestPolicyRefusal: "payload-authority" }),
      ]),
    ).toMatchObject({ physicalRequests: 3, replayedRequests: 2 });
  });
});
