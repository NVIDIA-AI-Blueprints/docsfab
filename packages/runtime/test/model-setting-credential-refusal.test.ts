// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The shipped `docsfab run` stops at load when a model setting holds DocsFab's
 * own model key, such as the key given as the model id (#1807): from the
 * environment or `--set` on a model profile slot, with the endpoint reachable
 * or not, and from a legacy configuration `.env`. No request is sent, no run
 * record is written, and neither the output nor any file under the state
 * directory shows the key. A normal model id runs (control).
 */
import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { commitFixture, initFixtureRepo } from "./helpers/git.js";
import { temporaryRoots } from "./helpers/temp.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";
import { closeModelEndpointStubs, startModelUpstream } from "./support/model-endpoint-stubs.js";

const execFileAsync = promisify(execFile);
const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const roots = temporaryRoots();
/** A placeholder key: plain words, never shaped like a real credential. */
const KEY = "refusal-cli-orchard-meadow-key";
/** The discard port on this machine: nothing listens there. */
const UNREACHABLE = "http://127.0.0.1:9/v1";
const RUN_TIMEOUT = testTimeoutMs(120_000);

afterEach(() => closeModelEndpointStubs());

/** Profile fields for an operator-configured endpoint, as `name: value` or `NAME=value`. */
function profileFields(baseUrl: string): ReadonlyArray<readonly [string, string, string]> {
  return [
    ["provider", "MODEL_PROVIDER", "operator-configured-openai-compatible"],
    ["baseUrl", "MODEL_BASE_URL", baseUrl],
    ["modelId", "MODEL_ID", "example/model"],
    ["apiFormat", "MODEL_API_FORMAT", "chat_completions"],
    ["transport", "MODEL_TRANSPORT", "openai-chat-completions"],
    ["contextWindow", "MODEL_CONTEXT_WINDOW", "128000"],
    ["maxInputTokens", "MODEL_MAX_INPUT_TOKENS", "128000"],
    ["maxOutputTokens", "MODEL_MAX_OUTPUT_TOKENS", "16384"],
    ["apiMinOutputTokens", "MODEL_API_MIN_OUTPUT_TOKENS", "16"],
    ["contextReserveTokens", "MODEL_CONTEXT_RESERVE_TOKENS", "1024"],
    ["reasoning", "MODEL_REASONING", "false"],
    ["inputTypes", "MODEL_INPUT_TYPES", "text"],
    ["supportsDeveloperRole", "MODEL_SUPPORTS_DEVELOPER_ROLE", "false"],
    ["supportsReasoningEffort", "MODEL_SUPPORTS_REASONING_EFFORT", "false"],
    ["compatibleApiFormats", "MODEL_COMPATIBLE_API_FORMATS", "chat_completions"],
    ["inputCostPerMillion", "MODEL_INPUT_COST_PER_MILLION", "unknown"],
    ["outputCostPerMillion", "MODEL_OUTPUT_COST_PER_MILLION", "unknown"],
    ["cacheReadCostPerMillion", "MODEL_CACHE_READ_COST_PER_MILLION", "unknown"],
    ["cacheWriteCostPerMillion", "MODEL_CACHE_WRITE_COST_PER_MILLION", "unknown"],
    ["profileApprovedSource", "MODEL_PROFILE_APPROVED_SOURCE", "unknown"],
    ["profileEffectiveDate", "MODEL_PROFILE_EFFECTIVE_DATE", "unknown"],
    ["profileReviewAfter", "MODEL_PROFILE_REVIEW_AFTER", "unknown"],
  ];
}

/** The split layout: host.yaml selects a model profile file; secrets.env holds the key. */
async function profileRoot(baseUrl: string): Promise<string> {
  const root = await roots.create("docsfab-key-setting-", { mode: 0o700, realpath: true });
  await writeFile(
    join(root, "host.yaml"),
    "schemaVersion: 1\nkind: docsfab-host-config\nactivePolicyProfile: profiles/byo.yaml\n",
  );
  await mkdir(join(root, "profiles"), { mode: 0o700 });
  await writeFile(
    join(root, "profiles", "byo.yaml"),
    [
      "schemaVersion: 1",
      "kind: docsfab-model-profile",
      "slot: policy",
      ...profileFields(baseUrl).map(([field, , value]) => `${field}: ${value}`),
      "",
    ].join("\n"),
  );
  await writeFile(join(root, "secrets.env"), `MODEL_API_KEY=${KEY}\n`, { mode: 0o600 });
  return root;
}

/** The legacy layout: one configuration .env whose model id is the model key. */
async function legacyRoot(baseUrl: string): Promise<string> {
  const root = await roots.create("docsfab-key-setting-legacy-", {
    mode: 0o700,
    realpath: true,
  });
  const lines = profileFields(baseUrl)
    .filter(([, name]) => name !== "MODEL_TRANSPORT")
    .map(([, name, value]) => `${name}=${name === "MODEL_ID" ? KEY : value}`);
  await writeFile(join(root, ".env"), `${[...lines, `MODEL_API_KEY=${KEY}`].join("\n")}\n`, {
    mode: 0o600,
  });
  return root;
}

async function repository(): Promise<string> {
  const repository = await roots.create("docsfab-key-setting-repo-", { realpath: true });
  await writeFile(join(repository, "README.md"), "# Fixture\n\nA fixture project.\n");
  await initFixtureRepo(repository);
  await commitFixture(repository, "fixture");
  return repository;
}

/** Run the shipped entry point with a child environment built from nothing. */
async function docsfab(
  args: readonly string[],
  input: { readonly root: string; readonly env?: NodeJS.ProcessEnv },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const result = await execFileAsync(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", ...args],
      {
        cwd: runtimeRoot,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: input.root,
          TMPDIR: tmpdir(),
          PI_OFFLINE: "1",
          CI: "1",
          NO_COLOR: "1",
          DOCSFAB_CONFIG_ROOT: input.root,
          ...input.env,
        },
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
      exitCode: typeof failure.code === "number" ? failure.code : 1,
    };
  }
}

/** Every file DocsFab saved under the state directory, with its text. */
async function savedFiles(root: string): Promise<{ path: string; text: string }[]> {
  const files: { path: string; text: string }[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) files.push({ path, text: await readFile(path, "utf8") });
    }
  };
  await walk(join(root, ".docsfab"));
  return files;
}

async function expectStoppedAtLoad(
  result: { stdout: string; stderr: string; exitCode: number },
  root: string,
  from: string,
): Promise<void> {
  expect(result.exitCode).not.toBe(0);
  expect(`${result.stdout}\n${result.stderr}`).not.toContain(KEY);
  expect(result.stderr).toContain(
    `The writing model setting modelId from ${from} holds one of DocsFab's own configured credentials (environment variable MODEL_API_KEY)`,
  );
  expect(result.stderr).toContain("code: credential-material");
  const saved = await savedFiles(root);
  expect(saved.filter(({ path }) => path.endsWith(".json") && path.includes("runs"))).toEqual([]);
  for (const { text } of saved) expect(text).not.toContain(KEY);
}

const SURFACES = [
  ["the environment", { MODEL_ID: KEY }, [], "the environment (MODEL_ID)"],
  ["--set", {}, ["--set", `modelId=${KEY}`], "the command line (--set modelId)"],
] as const;

describe.each(["reachable", "unreachable"] as const)("with the endpoint %s", (endpoint) => {
  it.each(SURFACES)(
    "stops at load when %s gives the model key as the model id",
    async (_surface, env, flags, from) => {
      const upstream =
        endpoint === "reachable" ? await startModelUpstream({ expectedKey: KEY }) : undefined;
      const root = await profileRoot(upstream?.baseUrl ?? UNREACHABLE);
      const result = await docsfab(
        ["run", "review-documentation", "--repo", await repository(), ...flags],
        { root, env },
      );

      await expectStoppedAtLoad(result, root, from);
      expect(upstream?.requests ?? []).toHaveLength(0);
    },
    RUN_TIMEOUT,
  );
});

describe("other layouts and the control", () => {
  it(
    "stops at load when a legacy .env gives the model key as the model id",
    async () => {
      const upstream = await startModelUpstream({ expectedKey: KEY });
      const root = await legacyRoot(upstream.baseUrl);
      const result = await docsfab(["run", "review-documentation", "--repo", await repository()], {
        root,
      });

      await expectStoppedAtLoad(result, root, "the configuration .env (.env:3)");
      expect(upstream.requests).toHaveLength(0);
    },
    RUN_TIMEOUT,
  );

  it(
    "runs a normal model id on the same configuration (control)",
    async () => {
      const upstream = await startModelUpstream({ expectedKey: KEY, mode: "refuse" });
      const root = await profileRoot(upstream.baseUrl);
      const result = await docsfab(["run", "review-documentation", "--repo", await repository()], {
        root,
        env: { MODEL_ID: "example/other-model" },
      });

      expect(result.stderr).not.toContain("credential-material");
      expect(upstream.requests.length).toBeGreaterThan(0);
      expect(upstream.requests[0]).toMatchObject({ credential: "the configured key" });
      expect(upstream.requests[0]!.body.model).toBe("example/other-model");
      const saved = await savedFiles(root);
      expect(saved.some(({ path }) => path.endsWith(".json") && path.includes("runs"))).toBe(true);
      for (const { text } of saved) expect(text).not.toContain(KEY);
    },
    RUN_TIMEOUT,
  );
});
