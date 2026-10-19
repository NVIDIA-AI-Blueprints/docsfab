// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  formatOfflineProductTest,
  OFFLINE_PRODUCT_TEST_STEPS,
  runOfflineProductTest,
  serializeOfflineProductTest,
} from "../src/product-test.js";

describe("offline product test", () => {
  it("covers the complete fake-provider and fake-GitLab cycle deterministically", () => {
    const first = runOfflineProductTest();
    const second = runOfflineProductTest();

    expect(first).toEqual(second);
    expect(first.steps.map((step) => step.id)).toEqual(OFFLINE_PRODUCT_TEST_STEPS);
    expect(first.isolation).toEqual({
      credentials: "not-used",
      network: "not-used",
      sourceCheckout: "unchanged",
    });
    expect(first.decision).toEqual({ workflow: "update-documentation", disposition: "execute" });
    expect(first.patch.changedPaths).toEqual(["README.md"]);
    expect(first.patch.byteLength).toBeLessThan(4 * 1024);
    expect(first.validation).toMatchObject({ status: "passed", checkCount: 3 });
    expect(first.tracker).toMatchObject({ status: "reconciled" });
    expect(first.publication).toMatchObject({
      mergeRequest: "draft",
      externalMutationCount: 1,
    });
    expect(first.retry).toEqual({
      status: "idempotent",
      sameReceipt: true,
      externalMutationCount: 1,
    });
  });

  it("emits closed credential-free human and JSON projections", () => {
    const result = runOfflineProductTest();
    const json = serializeOfflineProductTest(result);
    const output = formatOfflineProductTest(result);
    expect(JSON.parse(json)).toEqual(result);
    expect(output).toContain("Network: not-used");
    expect(output).toContain("Retry: idempotent; 1 fake mutation total");
    expect(output).toContain("no real external writes");
    expect(json).not.toMatch(/api[_-]?key|token|password|https?:\/\//iu);
  });

  it("renders the result with execution scope, simulated effects, steps, and record digest", () => {
    const result = runOfflineProductTest();
    const lines = formatOfflineProductTest(result, { tty: false }).split("\n");

    expect(lines[0]).toBe("Offline product test");
    expect(lines.join("\n")).toContain("Outcome: passed");
    expect(lines.join("\n")).toContain("Execution: succeeded");
    expect(lines.join("\n")).toContain("Publication: simulated");
    expect(lines).toContain("Simulated steps");
    expect(lines).toContain("Synthetic result");
    expect(lines.join("\n")).toContain(result.sha256);
    expect(lines.join("\n")).toContain("fake external mutation");
    expect(lines).not.toContain("NEXT");
  });

  it("uses the shared terminal presentation without obscuring its outcome", () => {
    const result = runOfflineProductTest();
    const text = formatOfflineProductTest(result, {
      tty: true,
      noColor: false,
      forceColor: false,
      forceColorDisabled: false,
      ci: false,
      termDumb: false,
    });
    expect(text.replace(/\u001b\[[0-9;]*m/g, "")).toContain("Outcome: passed");
    expect(text.replace(/\u001b\[[0-9;]*m/g, "")).toContain("Execution: succeeded");
    expect(text.replace(/\u001b\[[0-9;]*m/g, "")).toContain("Publication: simulated");
  });

  it("--quiet keeps the outcome, external-effects scope, and record digest", () => {
    const result = runOfflineProductTest();
    const lines = formatOfflineProductTest(result, { tty: false, quiet: true }).split("\n");

    expect(lines[0]).toBe("Offline product test");
    expect(lines.join("\n")).toContain("Outcome: passed");
    expect(lines.join("\n")).toContain("Execution: succeeded");
    expect(lines.join("\n")).toContain("Publication: simulated");
    expect(lines.join("\n")).toContain("no real external writes");
    expect(lines.join("\n")).toContain(result.sha256);
    expect(lines).not.toContain("Simulated steps");
  });
});
