// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { createLiveAgentToolDefinitions } from "../src/live-agent/capabilities.js";
import { LiveAgentActivityRenderer } from "../src/live-agent/activity-renderer.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import type { RunRecord, StepStatus } from "../src/records/contracts.js";

describe("live-agent workflow stage progress", () => {
  it.each([true, false])(
    "streams real stage identities before the workflow settles, tty=%s",
    async (tty) => {
      const chunks: string[] = [];
      const activity = new LiveAgentActivityRenderer({
        write: (text) => chunks.push(text),
        tty,
        columns: () => 120,
        environment: { NO_COLOR: "1" },
        skillIds: [],
        workflowIds: ["update-documentation"],
      });
      const definition = getWorkflow("update-documentation");
      let finish!: () => void;
      const settled = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const tools = createLiveAgentToolDefinitions({
        capabilities: {
          skills: [],
          workflows: [{ name: definition.name as "update-documentation", title: definition.title }],
          qualityPack: {} as never,
        },
        runWorkflow: async (_workflow, _instruction, progress) => {
          let sequence = 0;
          for (const step of definition.steps) {
            for (const status of ["running", "succeeded"] as const) {
              progress?.(
                {
                  type: "step-status",
                  runId: "run-stage-test",
                  stepId: step.id,
                  status,
                  sequence: ++sequence,
                },
                definition,
              );
              if (status === "running")
                expect(chunks.join("")).toContain(`update-documentation · ${step.id}`);
            }
          }
          progress?.(
            {
              type: "text",
              runId: "run-stage-test",
              stepId: definition.steps[0]!.id,
              text: "PRIVATE provider content",
              sequence: ++sequence,
            },
            definition,
          );
          await settled;
          return {
            id: "run-stage-test",
            workflow: definition.name,
            status: "succeeded",
            steps: [],
            livePersistence: { status: "failed", error: "Patch conflicts with checkout." },
          } as unknown as RunRecord;
        },
      });
      activity.begin();
      activity.handle({
        type: "tool_execution_start",
        toolName: "docsfab_run_workflow",
        toolCallId: "call-1",
        args: { workflow: definition.name },
      });
      const tool = tools.find((entry) => entry.name === "docsfab_run_workflow")!;
      const result = tool.execute(
        "call-1",
        { workflow: definition.name, instruction: "Update docs" },
        undefined,
        (partialResult) =>
          activity.handle({
            type: "tool_execution_update",
            toolName: tool.name,
            toolCallId: "call-1",
            args: { workflow: definition.name },
            partialResult,
          }),
        {} as never,
      );
      try {
        await vi.waitFor(() =>
          expect(chunks.join("")).toContain(
            `[Done] update-documentation · ${definition.steps.at(-1)!.id}`,
          ),
        );
        expect(chunks.join("")).not.toContain("[Done] Running workflow:");
        expect(chunks.join("")).not.toMatch(/step \d+\/\d+/u);
        expect(chunks.join("")).not.toContain("PRIVATE");
        if (!tty) expect(chunks.join("")).not.toContain("\r");
        finish();
        activity.handle({
          type: "tool_execution_end",
          toolName: tool.name,
          toolCallId: "call-1",
          result: await result,
          isError: false,
        });
        expect(chunks.join("")).toContain("[Failed] Running workflow: update-documentation");
      } finally {
        finish();
        activity.dispose();
      }
    },
  );

  it("rejects a one-sided ordinal while rendering a branched stage without one", () => {
    const chunks: string[] = [];
    const activity = new LiveAgentActivityRenderer({
      write: (text) => chunks.push(text),
      tty: false,
      skillIds: [],
      workflowIds: ["update-documentation"],
    });
    const send = (details: unknown) =>
      activity.handle({
        type: "tool_execution_update",
        toolName: "docsfab_run_workflow",
        toolCallId: "call-1",
        args: {},
        partialResult: { details },
      });
    const details = {
      kind: "docsfab-live-workflow-progress",
      workflow: "update-documentation",
      stepId: "verify-technical-accuracy",
      status: "running",
    };
    activity.begin();
    activity.handle({
      type: "tool_execution_start",
      toolName: "docsfab_run_workflow",
      toolCallId: "call-1",
      args: { workflow: details.workflow },
    });
    send({ ...details, step: 2 });
    expect(chunks.join("")).not.toContain("verify-technical-accuracy");
    send(details);
    send({ ...details, status: "needs-input" });
    expect(chunks.join("")).toContain(
      "[Needs input] update-documentation · verify-technical-accuracy",
    );
    expect(chunks.join("")).not.toMatch(/step \d+\/\d+/u);
    activity.dispose();
  });

  it.each(["failed", "needs-input", "needs-human-decision"] as const)(
    "keeps stage %s distinct from completion and ignores untrusted updates",
    (status: StepStatus) => {
      const chunks: string[] = [];
      const activity = new LiveAgentActivityRenderer({
        write: (text) => chunks.push(text),
        tty: false,
        skillIds: [],
        workflowIds: ["review-documentation"],
      });
      const send = (details: unknown, toolCallId = "call-1") =>
        activity.handle({
          type: "tool_execution_update",
          toolName: "docsfab_run_workflow",
          toolCallId,
          args: {},
          partialResult: { details },
        });
      const details = {
        kind: "docsfab-live-workflow-progress",
        workflow: "review-documentation",
        stepId: "review-documentation",
        step: 1,
        total: 2,
        status: "running",
      };
      activity.begin();
      activity.handle({
        type: "tool_execution_start",
        toolName: "docsfab_run_workflow",
        toolCallId: "call-1",
        args: { workflow: details.workflow },
      });
      send({ ...details, stepId: "PRIVATE\nsecret" });
      send({ ...details, workflow: "PRIVATE" });
      send({ ...details, status: "PRIVATE" });
      send(details, "unknown-call");
      expect(chunks.join("")).not.toContain("step 1/2");
      send(details);
      send({ ...details, status });
      expect(chunks.join("")).toContain(
        `[${status === "failed" ? "Failed" : "Needs input"}] review-documentation · step 1/2`,
      );
      expect(chunks.join("")).not.toContain("[Done]");
      expect(chunks.join("")).not.toContain("PRIVATE");
      activity.interrupt();
      const before = chunks.join("");
      send({ ...details, status: "succeeded" });
      expect(chunks.join("")).toBe(before);
    },
  );
});
