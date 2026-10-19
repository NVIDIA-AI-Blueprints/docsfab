// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../src/config/runtime-loader.js";
import { handleDoCommand, type DoCommandOptions } from "../src/cli/commands/do.js";
import {
  inspectPauseDelegatedTask,
  resumeDelegatedTask,
} from "../src/delegated-task/continuation.js";
import { temporaryRoots } from "./helpers/temp.js";
import { validModelEnvironment } from "./helpers.js";

const roots = temporaryRoots();
const REVISION = "a".repeat(40);
const NOW = () => new Date("2026-10-05T20:00:00.000Z");
const restoreEnvironment: Array<() => void> = [];

afterEach(() => {
  process.exitCode = undefined;
  vi.unstubAllEnvs();
  for (const restore of restoreEnvironment.splice(0)) restore();
  vi.restoreAllMocks();
});

function clearModelEnvironment(): void {
  const names = Object.keys(process.env).filter((name) => /^(?:MODEL|JUDGE)_/u.test(name));
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  restoreEnvironment.push(() => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

function options(repositoryPath: string, stateDirectory: string): DoCommandOptions {
  return {
    stateDirectory,
    now: NOW,
    inspectDelegatedWorkspaceBasis: async () => ({
      canonicalRepositoryPath: repositoryPath,
      committedHeadRevision: REVISION,
      dirtyPaths: [],
      workspace: {
        strategy: "tracked-export",
        disposable: true,
        origin: "committed-head",
        revision: REVISION,
      },
    }),
    createDelegatedTaskAuthority: async () =>
      ({ kind: "docsfab-delegated-task-authority" }) as never,
    runDelegatedTask: async () => ({
      kind: "docsfab-delegated-task-result",
      status: "completed",
      answer: "The API page exists ([source-line 1]).",
      transcript: [
        { kind: "tool-call", name: "read", arguments: { path: "docs/api.md" } },
        { kind: "tool-result", name: "read", isError: false, text: "# API\n" },
      ],
      childWorkflows: [],
    }),
    inspectPauseDelegatedTask: inspectPauseDelegatedTask,
    resumeDelegatedTask,
    signal: new AbortController().signal,
  };
}

async function runCheck(repositoryPath: string, stateDirectory: string): Promise<string> {
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => undefined;
  console.error = () => undefined;
  try {
    await handleDoCommand(
      [
        "--delegate",
        "Read docs/api.md and summarize it.",
        "--repo",
        repositoryPath,
        "--check",
        "credential-probe",
        "--no-input",
        "--json",
      ],
      options(repositoryPath, stateDirectory),
    );
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  return readFile(join(repositoryPath, "child-env-result.json"), "utf8");
}

describe("delegated npm checks receive a credential-free child environment", () => {
  it("hides configured file credentials while retaining supported execution settings", async () => {
    const root = await roots.create("docsfab-delegated-env-file-");
    const repositoryPath = join(root, "repo");
    const fileModelKey = "file-model-secret-82a4c1f7";
    const fileOtherSecret = "file-other-secret-49d2a5c8";
    await mkdir(join(repositoryPath, "docs"), { recursive: true });
    await writeFile(join(repositoryPath, "docs", "api.md"), "# API\n", "utf8");
    await writeFile(
      join(repositoryPath, "package.json"),
      JSON.stringify({
        scripts: {
          "credential-probe":
            "node -e \"const f=require('node:fs');f.writeFileSync('child-env-result.json',JSON.stringify({model:!!process.env.MODEL_API_KEY,other:!!process.env.DOCSFAB_FIXTURE_TOKEN,path:!!process.env.PATH,home:!!process.env.HOME,proxy:process.env.HTTPS_PROXY==='http://proxy.example.test:8080'}))\"",
        },
      }),
    );

    clearModelEnvironment();
    vi.stubEnv("DOCSFAB_CONFIG_ROOT", root);
    vi.stubEnv("HTTPS_PROXY", "http://proxy.example.test:8080");
    await writeFile(
      join(root, ".env"),
      `${Object.entries({
        ...validModelEnvironment,
        MODEL_API_KEY: fileModelKey,
        DOCSFAB_FIXTURE_TOKEN: fileOtherSecret,
      })
        .map(([name, value]) => `${name}=${value}`)
        .join("\n")}\n`,
      { mode: 0o600 },
    );

    loadConfig();
    const fullEnvironmentControl = execFileSync(
      process.execPath,
      [
        "-e",
        "process.stdout.write(String(Boolean(process.env.MODEL_API_KEY && process.env.DOCSFAB_FIXTURE_TOKEN)))",
      ],
      {
        env: {
          ...process.env,
          MODEL_API_KEY: fileModelKey,
          DOCSFAB_FIXTURE_TOKEN: fileOtherSecret,
        },
        encoding: "utf8",
      },
    );
    expect(fullEnvironmentControl).toBe("true");

    const observed = JSON.parse(await runCheck(repositoryPath, join(root, "state"))) as {
      model: boolean;
      other: boolean;
      path: boolean;
      home: boolean;
      proxy: boolean;
    };
    expect(observed).toEqual({ model: false, other: false, path: true, home: true, proxy: true });
  });

  it("also removes an operator-exported model credential", async () => {
    const root = await roots.create("docsfab-delegated-env-exported-");
    const repositoryPath = join(root, "repo");
    await mkdir(join(repositoryPath, "docs"), { recursive: true });
    await writeFile(join(repositoryPath, "docs", "api.md"), "# API\n", "utf8");
    await writeFile(
      join(repositoryPath, "package.json"),
      JSON.stringify({
        scripts: {
          "credential-probe":
            "node -e \"require('node:fs').writeFileSync('child-env-result.json',String(Boolean(process.env.MODEL_API_KEY)))\"",
        },
      }),
    );
    clearModelEnvironment();
    vi.stubEnv("DOCSFAB_CONFIG_ROOT", root);
    vi.stubEnv("MODEL_API_KEY", "operator-model-secret-5a8e2c41");
    vi.stubEnv("MODEL_PROVIDER", "test-provider");
    vi.stubEnv("MODEL_BASE_URL", "https://inference.example.test/v1/");
    vi.stubEnv("MODEL_ID", "example/model");
    vi.stubEnv("MODEL_API_FORMAT", "chat_completions");
    vi.stubEnv("MODEL_CONTEXT_WINDOW", "128000");
    vi.stubEnv("MODEL_MAX_OUTPUT_TOKENS", "16384");
    vi.stubEnv("MODEL_API_MIN_OUTPUT_TOKENS", "16");
    vi.stubEnv("MODEL_CONTEXT_RESERVE_TOKENS", "4096");
    vi.stubEnv("MODEL_REASONING", "true");
    vi.stubEnv("MODEL_INPUT_TYPES", "text,image");
    vi.stubEnv("MODEL_SUPPORTS_DEVELOPER_ROLE", "true");
    vi.stubEnv("MODEL_SUPPORTS_REASONING_EFFORT", "true");
    vi.stubEnv("MODEL_COMPATIBLE_API_FORMATS", "chat_completions");
    vi.stubEnv("MODEL_INPUT_COST_PER_MILLION", "1.25");
    vi.stubEnv("MODEL_OUTPUT_COST_PER_MILLION", "10");
    vi.stubEnv("MODEL_CACHE_READ_COST_PER_MILLION", "0.5");
    vi.stubEnv("MODEL_CACHE_WRITE_COST_PER_MILLION", "unknown");
    vi.stubEnv(
      "MODEL_PROFILE_APPROVED_SOURCE",
      "https://metadata.example.test/models/example-model",
    );
    vi.stubEnv("MODEL_PROFILE_EFFECTIVE_DATE", "2020-01-01");
    vi.stubEnv("MODEL_PROFILE_REVIEW_AFTER", "2099-12-31");

    loadConfig();
    const fullEnvironmentControl = execFileSync(
      process.execPath,
      ["-e", "process.stdout.write(String(Boolean(process.env.MODEL_API_KEY)))"],
      { env: process.env, encoding: "utf8" },
    );
    expect(fullEnvironmentControl).toBe("true");
    const observed = await runCheck(repositoryPath, join(root, "state"));
    expect(observed).toBe("false");
  });
});
