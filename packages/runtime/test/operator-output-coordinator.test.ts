// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  withOutputCoordinator,
  writeRenderedPresentation,
  type OperatorOutputCoordinator,
  type PresentationProgressHandle,
  type PresentationProgressUpdate,
} from "../src/operator/index.js";

function coordinatorFixture() {
  const events: Array<readonly unknown[]> = [];
  const progress = { id: Symbol("progress") } satisfies PresentationProgressHandle;
  const coordinator: OperatorOutputCoordinator = {
    writeMessage(stream, completeMessage) {
      events.push(["write", stream, completeMessage]);
    },
    startProgress(initial: PresentationProgressUpdate) {
      events.push(["start", initial]);
      return progress;
    },
    updateProgress(handle, update) {
      events.push(["update", handle, update]);
    },
    finalizeProgress(handle, finalUpdate) {
      events.push(["finalize", handle, finalUpdate]);
    },
    dispose() {
      events.push(["dispose"]);
    },
  };
  return { coordinator, events, progress };
}

describe("operator output coordinator contract", () => {
  it("writes each complete stream message in one call and finalizes progress on success", async () => {
    const fixture = coordinatorFixture();
    await withOutputCoordinator(
      fixture.coordinator,
      async (output, progress) => {
        await writeRenderedPresentation(output, {
          stdout: "Human result\n",
          stderr: "Progress complete\n",
        });
        if (progress) output.updateProgress(progress, { phase: "completed", message: "done" });
        return "complete";
      },
      { phase: "started", message: "working" },
    );
    expect(fixture.events).toEqual([
      ["start", { phase: "started", message: "working" }],
      ["write", "stdout", "Human result\n"],
      ["write", "stderr", "Progress complete\n"],
      ["update", fixture.progress, { phase: "completed", message: "done" }],
      ["finalize", fixture.progress, undefined],
      ["dispose"],
    ]);
  });

  it("finalizes and disposes progress after an operation throws without replacing the error", async () => {
    const fixture = coordinatorFixture();
    const failure = new Error("operation failed");
    await expect(
      withOutputCoordinator(
        fixture.coordinator,
        async () => {
          throw failure;
        },
        { phase: "running", message: "started" },
      ),
    ).rejects.toBe(failure);
    expect(fixture.events).toEqual([
      ["start", { phase: "running", message: "started" }],
      [
        "finalize",
        fixture.progress,
        { phase: "failed", message: "Activity ended after an error." },
      ],
      ["dispose"],
    ]);
  });

  it.each(["finalizeProgress", "dispose"] as const)(
    "preserves the operation failure when %s also throws",
    async (cleanupMethod) => {
      const fixture = coordinatorFixture();
      const failure = new Error("operation failure is authoritative");
      const cleanupFailure = new Error(`${cleanupMethod} failed`);
      const coordinator: OperatorOutputCoordinator = {
        ...fixture.coordinator,
        ...(cleanupMethod === "finalizeProgress"
          ? {
              finalizeProgress: () => {
                throw cleanupFailure;
              },
            }
          : {
              dispose: () => {
                throw cleanupFailure;
              },
            }),
      };

      await expect(
        withOutputCoordinator(
          coordinator,
          async () => {
            throw failure;
          },
          { message: "working", phase: "started" },
        ),
      ).rejects.toBe(failure);
    },
  );

  it("skips empty streams so JSON remains under its existing serializer and writer", async () => {
    const fixture = coordinatorFixture();
    await withOutputCoordinator(fixture.coordinator, async (output) => {
      await writeRenderedPresentation(output, { stdout: "", stderr: "human diagnostics\n" });
    });
    expect(fixture.events).toEqual([["write", "stderr", "human diagnostics\n"], ["dispose"]]);
  });
});
