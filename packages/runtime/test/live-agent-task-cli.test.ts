// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import {
  handleLiveAgentCommand,
  parseLiveAgentArguments,
  parseLiveAgentTaskArguments,
} from "../src/cli/commands/live-agent.js";
import { runLiveAgentTask } from "../src/live-agent/task-runner.js";

vi.mock("../src/live-agent/task-runner.js", () => ({ runLiveAgentTask: vi.fn() }));

describe("live-agent task CLI", () => {
  it("requires an explicit task file, result directory, and JSON output", () => {
    expect(
      parseLiveAgentTaskArguments([
        "--task-file",
        "/inputs/task.json",
        "--result-dir",
        "/outputs/attempt",
        "--json",
        "--allow-write",
        "--docs-file",
        "README.md",
      ]),
    ).toMatchObject({
      taskFile: "/inputs/task.json",
      resultDirectory: "/outputs/attempt",
      allowWrite: true,
      taskGrantedFiles: ["README.md"],
    });
    expect(() =>
      parseLiveAgentTaskArguments(["--task-file", "/inputs/task.json", "--json"]),
    ).toThrow(/requires --task-file, --result-dir, and --json/u);
    expect(() =>
      parseLiveAgentTaskArguments([
        "--task-file",
        "/inputs/task.json",
        "--result-dir",
        "/outputs/attempt",
        "--json",
        "--new",
      ]),
    ).toThrow(/does not recognize/u);
  });

  it("keeps the interactive defaults and source selection unchanged", () => {
    expect(parseLiveAgentArguments([])).toMatchObject({ newSession: false, allowWrite: true });
    expect(parseLiveAgentArguments(["--new", "--read-only"])).toMatchObject({
      newSession: true,
      allowWrite: false,
    });
  });

  it.each(["SIGINT", "SIGTERM"] as const)(
    "drains a %s cancellation through the public task command and removes its handler",
    async (signalName) => {
      const prior = process.listeners(signalName);
      const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
      vi.mocked(runLiveAgentTask).mockImplementationOnce(async (options) => {
        await new Promise<void>((resolve) =>
          options.signal?.addEventListener("abort", () => resolve(), { once: true }),
        );
        return {
          schemaVersion: 1,
          kind: "docsfab-live-agent-task-cli-result",
          exportPath: "/outputs/attempt/export.json",
          exportSha256: "a".repeat(64),
          executionStatus: "cancelled",
          agentDecision: "needs-input",
        };
      });
      try {
        const pending = handleLiveAgentCommand([
          "--task-file",
          "/inputs/task.json",
          "--result-dir",
          "/outputs/attempt",
          "--json",
        ]);
        const handler = process.listeners(signalName).find((listener) => !prior.includes(listener));
        expect(handler).toBeDefined();
        handler?.();
        await pending;
        expect(output).toHaveBeenCalledWith(
          expect.stringContaining('"executionStatus":"cancelled"'),
        );
        expect(process.listeners(signalName)).toEqual(prior);
      } finally {
        output.mockRestore();
      }
    },
  );
});
