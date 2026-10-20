// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { decodeRunResultV1 } from "../src/operator/run-result.js";
import { decodeCheckoutPersistenceOutcome } from "../src/records/checkout-persistence.js";

describe("closed checkout persistence evidence", () => {
  it("accepts a coded failure and refuses unknown fields and object coercion", () => {
    const failed = {
      schemaVersion: 1,
      kind: "checkout-persistence",
      outcome: "failed",
      errorCode: "patch-conflict",
    };
    expect(decodeCheckoutPersistenceOutcome(failed)).toEqual(failed);
    expect(() =>
      decodeCheckoutPersistenceOutcome({ ...failed, privateReason: "secret" }),
    ).toThrow();
    expect(() =>
      decodeCheckoutPersistenceOutcome({ ...failed, errorCode: "arbitrary-error" }),
    ).toThrow();
    const coercion = { toString: () => "applied" };
    expect(() =>
      decodeCheckoutPersistenceOutcome({
        schemaVersion: 1,
        kind: "checkout-persistence",
        outcome: coercion,
      }),
    ).toThrow();
  });

  it("refuses a fabricated workflow status behind an overall failure", () => {
    const checkoutPersistence = decodeCheckoutPersistenceOutcome({
      schemaVersion: 1,
      kind: "checkout-persistence",
      outcome: "failed",
      errorCode: "patch-conflict",
    });
    const runResult = {
      schemaVersion: 1,
      kind: "docsfab-run-result",
      execution: {
        runId: "run",
        status: "failed",
        workflowStatus: "succeeded",
        checkoutPersistence,
      },
      resultSha256: "a".repeat(64),
    };
    expect(() => decodeRunResultV1(runResult)).not.toThrow();
    expect(() =>
      decodeRunResultV1({
        ...runResult,
        execution: { ...runResult.execution, workflowStatus: "fabricated" },
      }),
    ).toThrow("inconsistent checkout persistence");
  });
});
