// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { createWriteToolDefinition } from "@earendil-works/pi-coding-agent";
import { WorkflowRunner } from "../src/workflow-execution/runner.js";
import { executeInferenceStep } from "../src/workflow-execution/retry.js";
import { InferenceStepError, type HarnessStepInput } from "../src/execution/contracts.js";
import { createLiveAgentToolDefinitions } from "../src/live-agent/capabilities.js";
import { WORKFLOW_CANCELLED } from "../src/execution/cancellation.js";
import { readyContextPreflight } from "./helpers.js";
import { sourceObligationObserverFixture } from "./helpers/verification.js";

describe("workflow cancellation propagation", () => {
  it("waits for an active file write to finish before settling cancellation", async () => {
    const controller = new AbortController();
    let finishWrite!: () => void;
    const gate = new Promise<void>((resolve) => {
      finishWrite = resolve;
    });
    let contents = "original";
    let settled = false;
    const write = vi.fn(async (_path: string, content: string) => {
      await gate;
      contents = content;
    });
    const tool = createWriteToolDefinition("/fixture", {
      operations: { mkdir: async () => {}, writeFile: write },
    });
    const pending = tool
      .execute(
        "write-1",
        { path: "docs/page.md", content: "complete edit" },
        controller.signal,
        undefined,
        {} as never,
      )
      .then(
        () => {
          settled = true;
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );
    await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());
    controller.abort();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(contents).toBe("original");
    finishWrite();
    expect(await pending).toBeInstanceOf(Error);
    expect(contents).toBe("complete edit");
  });

  it("passes the live tool signal into the runner, saves cancellation, and starts no later stage", async () => {
    const controller = new AbortController();
    const saved: unknown[] = [];
    const runStep = vi.fn(async (input: HarnessStepInput) => {
      expect(input.signal).toBe(controller.signal);
      controller.abort("PRIVATE cancellation reason");
      // Even a non-cooperative operation returning success cannot start another stage.
      return {
        summary: "late result",
        skill: { id: input.step.skill, contentSha256: "a".repeat(64) },
      };
    });
    const runner = new WorkflowRunner({
      harness: { runStep },
      store: {
        save: async (record) => {
          saved.push(structuredClone(record));
        },
      },
      contextPreflight: readyContextPreflight,
      repositoryScanner: {
        scan: async () => ({
          ruleSet: "fixture",
          status: "passed",
          scannedFiles: 0,
          binaryFiles: 0,
          findings: [],
        }),
      },
      sourceObligationObserver: sourceObligationObserverFixture,
    });
    const tool = createLiveAgentToolDefinitions({
      capabilities: {
        skills: [],
        workflows: [{ name: "review-documentation", title: "Review" }],
        qualityPack: {} as never,
      },
      runWorkflow: (workflow, instruction, _progress, signal) =>
        runner.run({
          workflow,
          instruction,
          signal,
          workspacePath: "/fixture",
          repository: {
            sourcePath: "/fixture",
            revision: "a".repeat(40),
            requestedRevision: "HEAD",
          },
          allowWrite: false,
        }),
    }).find((candidate) => candidate.name === "docsfab_run_workflow")!;
    const result = await tool.execute(
      "call-cancel",
      { workflow: "review-documentation", instruction: "Review docs" },
      controller.signal,
      undefined,
      {} as never,
    );
    expect(runStep).toHaveBeenCalledOnce();
    expect(result.details.status).toBe("cancelled");
    expect(result.details.workflowStatus).toBe("failed");
    expect(result.details.error).toBe(WORKFLOW_CANCELLED);
    expect(
      result.details.steps.slice(1).every((step: { status: string }) => step.status === "pending"),
    ).toBe(true);
    expect(saved.at(-1)).toMatchObject({ status: "failed", error: WORKFLOW_CANCELLED });
    expect(JSON.stringify(saved)).not.toContain("PRIVATE");
    expect(JSON.stringify(saved)).not.toContain('"signal"');
  });

  it("stops a retry backoff promptly without a second inference attempt", async () => {
    const controller = new AbortController();
    const execute = vi.fn(async () => {
      throw new InferenceStepError("retry", "provider-transient", true);
    });
    const pending = executeInferenceStep({
      signal: controller.signal,
      mode: "read-only",
      policy: {
        maxRetries: 2,
        baseDelayMs: 60_000,
        maxDelayMs: 60_000,
        retryableCategories: ["provider-transient"],
      },
      execute,
    });
    const rejection = expect(pending).rejects.toThrow(WORKFLOW_CANCELLED);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    controller.abort("PRIVATE cancellation reason");
    await rejection;
    expect(execute).toHaveBeenCalledOnce();
  });
});
