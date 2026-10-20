// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseDoArguments } from "../src/cli/commands/do.js";
import { parseRunArguments } from "../src/cli/run-arguments.js";
import { usage } from "../src/cli/usage.js";
import { deliverCliRunResult } from "../src/cli/run/delivery.js";
import type { CliRunInvocation, CliRunOutput } from "../src/cli/run/request.js";
import type { RunPreflight } from "../src/cli/run/preflight.js";
import type { ExecutedCliRun } from "../src/cli/run/execution.js";
import type { RunRecord } from "../src/records/contracts.js";
import type { DocsFabConfig } from "../src/config/runtime-loader.js";
import { StudySession } from "../src/records/study-store.js";
import { GOLDEN_OUTCOME_REQUEST } from "../src/cli/outcome-router.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import { validModelConfig } from "./helpers.js";
import { temporaryRoots } from "./helpers/temp.js";

const roots = temporaryRoots();

function capturingOutput(): { output: CliRunOutput; logs: string[] } {
  const logs: string[] = [];
  return {
    output: {
      log: (message: string) => logs.push(message),
      error: () => undefined,
    },
    logs,
  };
}

function minimalRunRecord(): RunRecord {
  return {
    schemaVersion: 2,
    id: "run-study-cli",
    workflow: "review-documentation",
    repository: {
      sourcePath: "/tmp/example",
      requestedRevision: "HEAD",
      revision: "a".repeat(40),
    },
    workspace: { strategy: "tracked-export", disposable: true },
    status: "succeeded",
    createdAt: "2026-08-25T16:00:00.000Z",
    models: [],
    skills: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0 },
    tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
    steps: [],
  };
}

function stubConfig(stateDirectory: string): DocsFabConfig {
  return {
    projectRoot: "/tmp/does-not-matter",
    skillCrateDirectory: "/tmp/does-not-matter/skill-crate",
    qualityDirectory: "/tmp/does-not-matter/quality",
    qualityPackDirectory: "/tmp/does-not-matter/quality-pack",
    stateDirectory,
    retryPolicy: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0, retryableCategories: [] },
    model: validModelConfig,
  };
}

function minimalWorkspace() {
  return {
    path: "/tmp/example-workspace",
    sourcePath: "/tmp/example",
    requestedRevision: "HEAD",
    revision: "a".repeat(40),
    dispose: async () => undefined,
  };
}

function minimalPreflight(): RunPreflight {
  return { workflow: getWorkflow("review-documentation") };
}

describe("study CLI flag", () => {
  it("defaults --study off on run and do", () => {
    expect(parseRunArguments(["review-documentation", "--repo", "repository"]).study).toBe(false);
    expect(parseDoArguments([GOLDEN_OUTCOME_REQUEST, "--repo", "/tmp/repo"]).study).toBe(false);
  });

  it("parses --study once and rejects duplicates", () => {
    expect(
      parseRunArguments(["review-documentation", "--repo", "repository", "--study"]).study,
    ).toBe(true);
    expect(parseDoArguments([GOLDEN_OUTCOME_REQUEST, "--repo", "/tmp/repo", "--study"]).study).toBe(
      true,
    );
    expect(() =>
      parseRunArguments(["review-documentation", "--repo", "repository", "--study", "--study"]),
    ).toThrow("must not be duplicated");
    expect(() =>
      parseDoArguments([GOLDEN_OUTCOME_REQUEST, "--repo", "/tmp/repo", "--study", "--study"]),
    ).toThrow("must not be duplicated");
  });

  it("documents --study and the STUDY footer without a study subcommand tree", () => {
    const text = usage();
    expect(text).toMatch(/docsfab do "<outcome request>"[\s\S]*?\[--study\]/u);
    expect(text).toMatch(/docsfab run <workflow>[\s\S]*?\[--study\]/u);
    expect(text).toContain("NEXT docsfab study show <runId>");
    expect(text).not.toMatch(/^ {2}docsfab study /mu);
  });
});

describe("STUDY plane", () => {
  it("prints STUDY counts and NEXT when --study is on, and omits them when off", async () => {
    const stateDirectory = await roots.create("docsfab-study-cli-");
    const session = new StudySession({
      directory: join(stateDirectory, "study"),
      now: () => new Date("2026-08-25T16:00:00.000Z"),
      id: () => "tmp1",
    });
    await session.ensureRun({
      runId: "run-study-cli",
      observationMode: "corpus",
      modelRef: { provider: "nvidia-api-catalog", catalogId: "operator-profile-model" },
    });
    const { output, logs } = capturingOutput();
    const invocation: CliRunInvocation = {
      request: {
        workflow: "review-documentation",
        repositoryPath: "/tmp/example",
        revision: "HEAD",
        allowWrite: false,
        releaseGate: false,
        verbose: false,
        json: false,
        showScan: false,
        study: true,
      },
      config: stubConfig(stateDirectory),
      options: {},
      output,
      studySession: session,
    };
    await deliverCliRunResult(invocation, minimalWorkspace(), minimalPreflight(), {
      record: minimalRunRecord(),
      exitCode: 0,
    } satisfies ExecutedCliRun);
    const printed = logs.join("\n");
    expect(printed).toContain("STUDY scheduled=0 extra=0");
    expect(printed).toContain("NEXT docsfab study show run-study-cli");

    const offLogs: string[] = [];
    await deliverCliRunResult(
      {
        ...invocation,
        request: { ...invocation.request, study: false },
        studySession: undefined,
        output: {
          log: (message: string) => offLogs.push(message),
          error: () => undefined,
        },
      },
      minimalWorkspace(),
      minimalPreflight(),
      { record: minimalRunRecord(), exitCode: 0 },
    );
    expect(offLogs.join("\n")).not.toContain("STUDY scheduled=");
    expect(await readdir(stateDirectory)).toEqual(["study"]);
  });

  it("--json wins: no STUDY plane", async () => {
    const stateDirectory = await roots.create("docsfab-study-json-");
    const session = new StudySession({
      directory: join(stateDirectory, "study"),
      now: () => new Date("2026-08-25T16:00:00.000Z"),
      id: () => "tmp1",
    });
    await session.ensureRun({
      runId: "run-study-cli",
      observationMode: "corpus",
      modelRef: { provider: "nvidia-api-catalog", catalogId: "operator-profile-model" },
    });
    const { output, logs } = capturingOutput();
    await deliverCliRunResult(
      {
        request: {
          workflow: "review-documentation",
          repositoryPath: "/tmp/example",
          revision: "HEAD",
          allowWrite: false,
          releaseGate: false,
          verbose: false,
          json: true,
          showScan: false,
          study: true,
        },
        config: stubConfig(stateDirectory),
        options: { json: true },
        output,
        studySession: session,
      },
      minimalWorkspace(),
      minimalPreflight(),
      { record: minimalRunRecord(), exitCode: 0 },
    );
    expect(logs.join("\n")).not.toContain("STUDY scheduled=");
    expect(logs.join("\n")).toContain("docsfab-run-result");
  });
});
