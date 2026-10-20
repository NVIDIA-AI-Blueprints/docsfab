// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";
import { temporaryRoots } from "./helpers/temp.js";

const renderedProgress = vi.hoisted(() => Object.assign(vi.fn(), { dispose: vi.fn() }));
const createPrintProgressHandler = vi.hoisted(() => vi.fn(() => renderedProgress));

vi.mock("../src/cli/progress.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/cli/progress.js")>()),
  createPrintProgressHandler,
}));

import { executeRunRequest } from "../src/cli/run-request.js";
import type { DocsFabConfig } from "../src/config/runtime-loader.js";
import type { HarnessStepInput } from "../src/execution/contracts.js";
import { validModelConfig } from "./helpers.js";
import { initFixtureRepo } from "./helpers/git.js";

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const roots = temporaryRoots();

afterEach(async () => {
  process.exitCode = undefined;
  delete process.env.DOCSFAB_IA_REVIEWER_POLICY_PATH;
  createPrintProgressHandler.mockClear();
  renderedProgress.mockClear();
  renderedProgress.dispose.mockClear();
});

function stubConfig(stateDirectory: string): DocsFabConfig {
  return {
    projectRoot: runtimeRoot,
    skillCrateDirectory: join(runtimeRoot, "skill-crate"),
    qualityDirectory: join(runtimeRoot, "quality"),
    qualityPackDirectory: join(runtimeRoot, "quality-pack"),
    stateDirectory,
    retryPolicy: {
      maxRetries: 0,
      baseDelayMs: 0,
      maxDelayMs: 0,
      retryableCategories: [],
    },
    model: validModelConfig,
  };
}

async function minimalRepository(): Promise<string> {
  const root = await roots.create("docsfab-quiet-preflight-");
  const repository = join(root, "repo");
  await initFixtureRepo(repository, { "README.md": "# Fixture\n" });
  return repository;
}

async function withCapturedConsole<T>(run: () => Promise<T>): Promise<{
  result: T;
  logs: string[];
  errors: string[];
}> {
  const logs: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (message?: unknown) => {
    logs.push(String(message ?? ""));
  };
  console.error = (message?: unknown) => {
    errors.push(String(message ?? ""));
  };
  try {
    const result = await run();
    return { result, logs, errors };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

describe("executeRunRequest public --quiet vs internal silent (#314)", () => {
  it.each([
    {
      mode: "human",
      json: false,
      options: {},
      outputJson: false,
      expected: "Dry run:",
    },
    {
      mode: "json",
      json: true,
      options: {},
      outputJson: true,
      expected: "docsfab-dry-run",
    },
    {
      mode: "json option override",
      json: false,
      options: { json: true },
      outputJson: true,
      expected: "docsfab-dry-run",
    },
  ])(
    "routes $mode dry-run output through one invocation message",
    async ({ json, expected, options, outputJson }) => {
      const repositoryPath = await minimalRepository();
      const { result, logs, errors } = await withCapturedConsole(() =>
        executeRunRequest(
          {
            workflow: "readiness",
            repositoryPath,
            revision: "HEAD",
            allowWrite: false,
            releaseGate: false,
            verbose: false,
            json,
            showScan: false,
            dryRun: true,
          },
          undefined,
          options,
        ),
      );

      expect(result).toBeUndefined();
      expect(logs).toHaveLength(1);
      if (outputJson) {
        expect(JSON.parse(logs[0]!)).toMatchObject({ kind: expected, schemaVersion: 1 });
      } else {
        expect(logs[0]).toContain(expected);
      }
      expect(errors).toEqual([]);
      expect(createPrintProgressHandler).not.toHaveBeenCalled();
    },
  );

  it("uses the resolved quiet option for dry-run preview output", async () => {
    const repositoryPath = await minimalRepository();
    const request = {
      workflow: "readiness" as const,
      repositoryPath,
      revision: "HEAD",
      allowWrite: false,
      releaseGate: false,
      verbose: false,
      json: false,
      quiet: false,
      showScan: false,
      dryRun: true,
    };
    const expected = await withCapturedConsole(() =>
      executeRunRequest({ ...request, quiet: true }),
    );
    const actual = await withCapturedConsole(() =>
      executeRunRequest(request, undefined, { quiet: true }),
    );

    expect(actual.logs).toEqual(expected.logs);
    expect(actual.errors).toEqual([]);
  });

  it.each([
    { mode: "default", options: {}, renders: true },
    { mode: "quiet", options: { quiet: true }, renders: false },
    { mode: "json", options: { json: true }, renders: false },
    { mode: "silent", options: { silent: true }, renders: false },
  ] as const)("keeps progress facts caller-visible in $mode mode", async ({ options, renders }) => {
    const repositoryPath = await minimalRepository();
    const stateDirectory = await roots.create("docsfab-progress-state-");
    const observer = vi.fn();
    await withCapturedConsole(() =>
      executeRunRequest(
        {
          workflow: "readiness",
          repositoryPath,
          revision: "HEAD",
          allowWrite: false,
          releaseGate: false,
          verbose: false,
          json: false,
          showScan: false,
        },
        stubConfig(stateDirectory),
        {
          ...options,
          onProgress: observer,
          executionHarness: {
            inspectSkill: async (input: HarnessStepInput) => ({
              id: input.step.skill,
              contentSha256: "a".repeat(64),
            }),
            runStep: async (input: HarnessStepInput) => ({
              summary: `Completed ${input.step.id}.`,
              model: { provider: "fixture", model: "fixture" },
              skill: { id: input.step.skill, contentSha256: "a".repeat(64) },
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
                turns: 0,
              },
              tools: { totalCalls: 0, failedCalls: 0, byTool: [], failureCategories: [] },
            }),
          },
          skillResolver: {
            resolveSkill: async (input: HarnessStepInput) => ({
              id: input.step.skill,
              contentSha256: "a".repeat(64),
            }),
          },
        },
      ),
    );

    expect(observer).toHaveBeenCalled();
    if (renders) {
      expect(createPrintProgressHandler).toHaveBeenCalledTimes(1);
      expect(renderedProgress).toHaveBeenCalledTimes(observer.mock.calls.length);
      expect(renderedProgress.dispose).toHaveBeenCalledTimes(1);
    } else {
      expect(createPrintProgressHandler).not.toHaveBeenCalled();
      expect(renderedProgress).not.toHaveBeenCalled();
      expect(renderedProgress.dispose).not.toHaveBeenCalled();
    }
  });

  it("--quiet still reports a preflight rejection reason and the run record path", async () => {
    // `--quiet` must not swallow failure diagnostics: `site-bootstrap` without a
    // reviewer policy rejects before mutation (src/cli/run/preflight.ts).
    const repositoryPath = await minimalRepository();
    const stateDirectory = await roots.create("docsfab-quiet-state-");
    const config = stubConfig(stateDirectory);

    const { result, logs, errors } = await withCapturedConsole(() =>
      executeRunRequest(
        {
          workflow: "site-bootstrap",
          runId: "quiet-preflight-stop",
          repositoryPath,
          revision: "HEAD",
          allowWrite: true,
          releaseGate: false,
          verbose: false,
          json: false,
          showScan: false,
        },
        config,
        { quiet: true },
      ),
    );

    expect(result).toBeUndefined();
    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain(
      "Site bootstrap rejected the host reviewer policy before mutation.",
    );
    expect(logs.some((line) => line.startsWith("Record: "))).toBe(true);
    const stopped = JSON.parse(
      await readFile(join(stateDirectory, "quiet-preflight-stop.json"), "utf8"),
    ) as { id: string; steps: unknown[] };
    expect(stopped).toMatchObject({ id: "quiet-preflight-stop", steps: [] });
  });

  it("keeps site-bootstrap preflight-stop JSON to one RunResultV1 message", async () => {
    const repositoryPath = await minimalRepository();
    const stateDirectory = await roots.create("docsfab-json-preflight-state-");
    const { result, logs, errors } = await withCapturedConsole(() =>
      executeRunRequest(
        {
          workflow: "site-bootstrap",
          repositoryPath,
          revision: "HEAD",
          allowWrite: true,
          releaseGate: false,
          verbose: false,
          json: true,
          showScan: false,
        },
        stubConfig(stateDirectory),
      ),
    );

    expect(result).toBeUndefined();
    expect(process.exitCode).toBe(1);
    expect(errors).toEqual([]);
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0]!)).toMatchObject({ schemaVersion: 1, kind: "docsfab-run-result" });
  });

  it("internal silent fully suppresses the same rejection, unlike public --quiet", async () => {
    const repositoryPath = await minimalRepository();
    const stateDirectory = await roots.create("docsfab-silent-state-");
    const config = stubConfig(stateDirectory);

    const { result, logs, errors } = await withCapturedConsole(() =>
      executeRunRequest(
        {
          workflow: "site-bootstrap",
          repositoryPath,
          revision: "HEAD",
          allowWrite: true,
          releaseGate: false,
          verbose: false,
          json: false,
          showScan: false,
        },
        config,
        // Internal-only: never parsed from argv. Distinct from `quiet`
        // above, which must still surface the rejection reason and record.
        { silent: true },
      ),
    );

    expect(result).toBeUndefined();
    expect(process.exitCode).toBe(1);
    expect(logs).toEqual([]);
    expect(errors).toEqual([]);
  });
});
