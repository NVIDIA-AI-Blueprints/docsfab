// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { nextInvocationArguments } from "../src/cli/preview-presentation.js";
import { parseRunArguments } from "../src/cli/run-arguments.js";
import { executeRunRequest } from "../src/cli/run-request.js";

function commandArguments(output: string, label: string): string[] {
  const line = output.split("\n").find((item) => item.startsWith(`${label}: `));
  if (!line) throw new Error(`missing ${label} action`);
  const command = line.slice(`${label}: `.length);
  const words = [...command.matchAll(/'([^']*)'/gu)].map((match) => match[1]!);
  if (words.length === 0) throw new Error(`missing quoted command in ${label} action`);
  return words;
}

describe("preview next-invocation arguments", () => {
  it("removes only preview/output switches and preserves option-like values and -- operands", () => {
    expect(
      nextInvocationArguments(
        [
          "Create the guide",
          "--repo",
          "--quiet",
          "--instruction",
          "--json",
          "--remote=--dry-run",
          "--route-only",
          "--quiet",
          "--",
          "--json",
          "--route-only",
        ],
        ["--route-only"],
        ["--repo", "--instruction", "--remote"],
      ),
    ).toEqual([
      "Create the guide",
      "--repo",
      "--quiet",
      "--instruction",
      "--json",
      "--remote=--dry-run",
      "--quiet",
      "--",
      "--json",
      "--route-only",
    ]);
  });

  it("preserves equals-form values while removing preview flags", () => {
    expect(
      nextInvocationArguments(
        ["review-documentation", "--repo=--quiet", "--dry-run", "--json=true"],
        ["--dry-run"],
        ["--repo"],
      ),
    ).toEqual(["review-documentation", "--repo=--quiet"]);
  });

  it("emits a run-preview command that reparses with its repository and request context", async () => {
    const original = parseRunArguments([
      "update-documentation",
      "--repo",
      "/tmp/example-repo",
      "--revision",
      "main",
      "--instruction",
      "Update docs to preserve all examples",
      "--dry-run",
      "--study",
      "--release-gate",
      "--source",
      "docs/api.md",
      "--pr",
      "12",
    ]);
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => logs.push(String(message ?? ""));
    try {
      await executeRunRequest(original);
    } finally {
      console.log = originalLog;
    }
    const args = commandArguments(logs.join("\n"), "Run this selection");
    expect(logs.join("\n")).toContain("Next run would write:");
    expect(logs.join("\n")).toContain("Next run would publish:");
    expect(args.slice(0, 2)).toEqual(["docsfab", "run"]);
    const replayed = parseRunArguments(args.slice(2));
    expect(replayed).toMatchObject({
      workflow: original.workflow,
      repositoryPath: original.repositoryPath,
      revision: original.revision,
      instruction: original.instruction,
      study: original.study,
      releaseGate: original.releaseGate,
      sourcePaths: original.sourcePaths,
      changeRequestSelector: original.changeRequestSelector,
      changeSource: original.changeSource,
      dryRun: false,
    });
  });

  it("keeps an independent --change selector parseable in the next run command", async () => {
    const original = parseRunArguments([
      "update-documentation",
      "--repo",
      "/tmp/example-repo",
      "--instruction",
      "Update documentation from the selected change",
      "--dry-run",
      "--change",
      "base..topic",
    ]);
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => logs.push(String(message ?? ""));
    try {
      await executeRunRequest(original);
    } finally {
      console.log = originalLog;
    }
    const args = commandArguments(logs.join("\n"), "Run this selection");
    const replayed = parseRunArguments(args.slice(2));
    expect(replayed.changeSource).toEqual(original.changeSource);
  });

  it("matches explicit-composition dry-run effects to the suggested next invocation", async () => {
    const original = parseRunArguments([
      "update-documentation",
      "--repo",
      "/tmp/example-repo",
      "--instruction",
      "Update the selected page",
      "--composition",
      "example-composition",
      "--dry-run",
    ]);
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => logs.push(String(message ?? ""));
    try {
      await executeRunRequest(original);
    } finally {
      console.log = originalLog;
    }
    const output = logs.join("\n");
    const args = commandArguments(output, "Run this selection");
    const replayed = parseRunArguments(args.slice(2));
    expect(replayed.compositionId).toBe("example-composition");
    expect(replayed.draftMr).toBe(false);
    expect(output).toContain("Next run would write: documentation");
    expect(output).toContain("Next run would publish: nothing");
  });
});
