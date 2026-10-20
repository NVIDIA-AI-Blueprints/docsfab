// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  inferAttemptWriteSettlement,
  type AttemptWriteSettlementInput,
} from "../src/harness/write-settlement.js";

const empty: AttemptWriteSettlementInput = {
  leaseTerminal: true,
  presented: ["read", "edit", "write"],
  calls: [],
  counters: {
    requested: 0,
    executed: 0,
    succeeded: 0,
    failed: 0,
    denied: 0,
    governanceBlocked: 0,
  },
  toolActivity: { totalCalls: 0, failedCalls: 0, byTool: [] },
};

describe("attempt-wide host write settlement", () => {
  it("proves no write across every settled read-only call", () => {
    expect(
      inferAttemptWriteSettlement({
        ...empty,
        calls: [{ name: "read", authorized: true, hostDenied: false, outcome: "succeeded" }],
        counters: {
          requested: 1,
          executed: 1,
          succeeded: 1,
          failed: 0,
          denied: 0,
          governanceBlocked: 0,
        },
        toolActivity: {
          totalCalls: 1,
          failedCalls: 0,
          byTool: [{ name: "read", calls: 1, failures: 0 }],
        },
      }),
    ).toBe("no-write");
  });

  it("records a settled mutator even when the tool reported failure", () => {
    expect(
      inferAttemptWriteSettlement({
        ...empty,
        calls: [{ name: "write", authorized: true, hostDenied: false, outcome: "failed" }],
        counters: {
          requested: 1,
          executed: 1,
          succeeded: 0,
          failed: 1,
          denied: 0,
          governanceBlocked: 0,
        },
        toolActivity: {
          totalCalls: 1,
          failedCalls: 1,
          byTool: [{ name: "write", calls: 1, failures: 1 }],
        },
      }),
    ).toBe("write-executed");
  });

  it.each([
    [
      "missing authorized result",
      {
        ...empty,
        calls: [{ name: "read", authorized: true, hostDenied: false }],
        counters: {
          requested: 1,
          executed: 1,
          succeeded: 1,
          failed: 0,
          denied: 0,
          governanceBlocked: 0,
        },
        toolActivity: {
          totalCalls: 1,
          failedCalls: 0,
          byTool: [{ name: "read", calls: 1, failures: 0 }],
        },
      },
    ],
    [
      "unrecognized tool",
      {
        ...empty,
        presented: ["read"],
        calls: [{ name: "shell", authorized: true, hostDenied: false, outcome: "succeeded" }],
        counters: {
          requested: 1,
          executed: 1,
          succeeded: 1,
          failed: 0,
          denied: 0,
          governanceBlocked: 0,
        },
        toolActivity: {
          totalCalls: 1,
          failedCalls: 0,
          byTool: [{ name: "shell", calls: 1, failures: 0 }],
        },
      },
    ],
    ["unrecognized presented bash capability", { ...empty, presented: ["read", "bash"] }],
    ["counter disagreement", { ...empty, counters: { ...empty.counters, requested: 1 } }],
    ["nonterminal lease", { ...empty, leaseTerminal: false }],
  ] as const)("fails closed on %s", (_label, input) => {
    expect(inferAttemptWriteSettlement(input)).toBe("unavailable");
  });

  it("accounts for a write explicitly refused before host execution", () => {
    expect(
      inferAttemptWriteSettlement({
        ...empty,
        calls: [{ name: "edit", authorized: true, hostDenied: true }],
        counters: {
          requested: 1,
          executed: 0,
          succeeded: 0,
          failed: 0,
          denied: 0,
          governanceBlocked: 1,
        },
      }),
    ).toBe("no-write");
  });
});
