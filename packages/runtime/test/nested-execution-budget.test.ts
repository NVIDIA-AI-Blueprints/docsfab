// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { executeWorkflowApplication } from "../src/application/execute-workflow.js";
import {
  assertTaskBudgetActive,
  beginBudgetedEffect,
  composeSourceReadBudget,
  createRootTaskBudget,
  endBudgetedEffect,
  projectTaskBudget,
  remainingTaskBudget,
  releaseChildReservation,
  reserveChildBudget,
  settlePhysicalEffect,
  settleSourceRead,
  TaskBudgetError,
  type TaskBudgetEnvelope,
} from "../src/execution/task-budget.js";

const HASH_A = "a".repeat(64);

function envelope(overrides: Partial<TaskBudgetEnvelope> = {}): TaskBudgetEnvelope {
  return {
    "provider-turns": 8,
    "tool-calls": 8,
    "input-tokens": 80,
    "output-tokens": 80,
    "source-bytes": 80,
    "elapsed-ms": 80,
    "cost-microusd": 80,
    ...overrides,
  };
}

function charge(dimension: keyof TaskBudgetEnvelope, amount: number): TaskBudgetEnvelope {
  return envelope({
    "provider-turns": 0,
    "tool-calls": 0,
    "input-tokens": 0,
    "output-tokens": 0,
    "source-bytes": 0,
    "elapsed-ms": 0,
    "cost-microusd": 0,
    [dimension]: amount,
  });
}

describe("nested execution budget", () => {
  it("lets a child reserve only from the parent remaining budget", () => {
    const parent = createRootTaskBudget({ envelope: envelope() });
    const child = reserveChildBudget(parent, envelope({ "provider-turns": 3, "tool-calls": 3 }));
    expect(remainingTaskBudget(parent)["provider-turns"]).toBe(5);
    expect(remainingTaskBudget(child)["provider-turns"]).toBe(3);
    expect(() => reserveChildBudget(parent, envelope({ "provider-turns": 6 }))).toThrowError(
      expect.objectContaining({
        code: "budget-exhausted",
        dimension: "provider-turns",
        remaining: 5,
        observed: 6,
      }),
    );
    expect(projectTaskBudget(parent).availability).toBe("available");
    expect(() => assertTaskBudgetActive({ kind: "docsfab-task-budget-owner" })).toThrowError(
      TaskBudgetError,
    );
  });

  it("settles one physical effect once, not as both parent and child", () => {
    const parent = createRootTaskBudget({ envelope: envelope() });
    const child = reserveChildBudget(parent, envelope({ "provider-turns": 4 }));
    settlePhysicalEffect(child, {
      effectId: "provider-attempt-1",
      charges: charge("provider-turns", 2),
    });
    expect(projectTaskBudget(child).settled["provider-turns"]).toBe(2);
    expect(projectTaskBudget(parent).settled["provider-turns"]).toBe(0);
    expect(() =>
      settlePhysicalEffect(parent, {
        effectId: "provider-attempt-1",
        charges: charge("provider-turns", 2),
      }),
    ).toThrowError(expect.objectContaining({ code: "effect-already-settled" }));
    expect(() =>
      settlePhysicalEffect(child, {
        effectId: "provider-attempt-1",
        charges: charge("provider-turns", 1),
      }),
    ).toThrowError(expect.objectContaining({ code: "effect-already-settled" }));
    releaseChildReservation(child);
    expect(projectTaskBudget(parent).settled["provider-turns"]).toBe(2);
    expect(remainingTaskBudget(parent)["provider-turns"]).toBe(6);
    expect(projectTaskBudget(parent).reservedOutstanding["provider-turns"]).toBe(0);
  });

  it("returns unused reservation only after proven settlement", () => {
    const parent = createRootTaskBudget({ envelope: envelope() });
    const child = reserveChildBudget(parent, envelope({ "tool-calls": 4 }));
    beginBudgetedEffect(child);
    expect(() => releaseChildReservation(child)).toThrowError(
      expect.objectContaining({ code: "reservation-release-unproven" }),
    );
    endBudgetedEffect(child);
    settlePhysicalEffect(child, {
      effectId: "tool-1",
      charges: charge("tool-calls", 1),
    });
    releaseChildReservation(child);
    expect(remainingTaskBudget(parent)["tool-calls"]).toBe(7);
    expect(() =>
      settlePhysicalEffect(child, {
        effectId: "tool-2",
        charges: charge("tool-calls", 1),
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid-value" }));
  });

  it("honors the lower of task remaining and source acquisition, without widening", () => {
    const parent = createRootTaskBudget({
      envelope: envelope({ "source-bytes": 40 }),
    });
    expect(composeSourceReadBudget(40, 16)).toBe(16);
    expect(composeSourceReadBudget(8, 16)).toBe(8);
    expect(() =>
      composeSourceReadBudget(8, 16, {
        sourceReferencePresent: true,
        requestedBytes: 12,
      }),
    ).toThrowError(expect.objectContaining({ code: "source-reference-cannot-widen" }));
    settleSourceRead(parent, {
      effectId: "parent-read-1",
      bytes: 4,
      role: "parent-observer",
    });
    expect(() =>
      settleSourceRead(parent, {
        effectId: "parent-read-1",
        bytes: 4,
        role: "writer",
      }),
    ).toThrowError(expect.objectContaining({ code: "parent-read-is-not-writer-charge" }));
    expect(() =>
      settlePhysicalEffect(parent, {
        effectId: "parent-read-1",
        charges: charge("source-bytes", 4),
      }),
    ).toThrowError(expect.objectContaining({ code: "parent-read-is-not-writer-charge" }));
    settleSourceRead(parent, {
      effectId: "writer-1",
      bytes: 4,
      role: "writer",
    });
    expect(projectTaskBudget(parent).settled["source-bytes"]).toBe(8);
  });

  it("refuses nested work after cancellation and does not settle a cancelled in-flight child", () => {
    const controller = new AbortController();
    const parent = createRootTaskBudget({
      envelope: envelope(),
      signal: controller.signal,
    });
    const child = reserveChildBudget(parent, envelope({ "elapsed-ms": 8 }), controller.signal);
    beginBudgetedEffect(child);
    controller.abort();
    expect(() => assertTaskBudgetActive(child)).toThrowError(
      expect.objectContaining({ code: "cancelled" }),
    );
    expect(() =>
      settlePhysicalEffect(child, {
        effectId: "late-turn",
        charges: charge("elapsed-ms", 1),
      }),
    ).toThrowError(expect.objectContaining({ code: "cancelled" }));
    expect(() => releaseChildReservation(child)).toThrowError(
      expect.objectContaining({ code: "reservation-release-unproven" }),
    );
  });

  it("binds shared workflow execution to the nested remaining-budget owner", async () => {
    const controller = new AbortController();
    const parent = createRootTaskBudget({
      envelope: envelope(),
      signal: controller.signal,
    });
    const child = reserveChildBudget(parent, envelope({ "provider-turns": 2 }), controller.signal);
    controller.abort();
    await expect(
      executeWorkflowApplication({
        request: {
          workflow: "review-documentation",
          workspacePath: "/fixture",
          repository: {
            sourcePath: "/fixture",
            requestedRevision: "HEAD",
            revision: HASH_A.slice(0, 40),
          },
          allowWrite: false,
          signal: controller.signal,
        },
        services: {
          harness: {
            runStep: async () => {
              throw new Error("runner must not start on a cancelled child budget");
            },
          },
          store: { save: async () => undefined },
        },
        childBudget: child,
      }),
    ).rejects.toThrow();
  });
});
