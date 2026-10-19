// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import type { PrintProgressHandler } from "../src/cli/progress.js";
import { RunInvocationOutputCoordinator } from "../src/cli/run/invocation-output-coordinator.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";

describe("run invocation output coordination", () => {
  it("disposes active progress before a complete message and accepts later progress", () => {
    const order: string[] = [];
    let handlerNumber = 0;
    const coordinator = new RunInvocationOutputCoordinator(
      (_stream, message) => order.push(`message:${message}`),
      false,
      () => {
        const number = ++handlerNumber;
        const handler = vi.fn(() => order.push(`progress:${number}`));
        return Object.assign(handler, {
          dispose: vi.fn(() => order.push(`dispose:${number}`)),
        }) as unknown as PrintProgressHandler;
      },
    );
    const workflow = getWorkflow("readiness");
    const progress = coordinator.startProgress({ phase: "started", message: "Starting." });

    coordinator.forwardProgressEvent(
      progress,
      { sequence: 1, type: "run-status", runId: "run-1", status: "running" },
      workflow,
    );
    coordinator.writeMessage("stdout", "Completed run-1.");
    coordinator.forwardProgressEvent(
      progress,
      { sequence: 2, type: "run-status", runId: "run-1", status: "succeeded" },
      workflow,
    );
    coordinator.finalizeProgress(progress);
    coordinator.dispose();

    expect(order).toEqual([
      "progress:1",
      "dispose:1",
      "message:Completed run-1.",
      "progress:2",
      "dispose:2",
    ]);
  });
});
