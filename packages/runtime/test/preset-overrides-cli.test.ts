// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The shipped `docsfab` entry point runs a preset against an operator
 * endpoint over TLS. A per-run TLS upstream, trusted through
 * NODE_EXTRA_CA_CERTS, records the host each request addressed and whether the
 * configured key arrived, never the key; it answers 400 so each run stops
 * after its first request. The saved run record names each value's source.
 */
import { execFile } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.unmock("../src/config/private-route-urls.js");

import { EXECUTABLE_ROUTE_BASE_URLS } from "../src/config/executable-route-urls.js";
import { servedModelWarning } from "../src/model/provider.js";
import { commitFixture, initFixtureRepo } from "./helpers/git.js";
import { temporaryRoots } from "./helpers/temp.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";
import {
  closeModelEndpointStubs,
  startModelUpstream,
  startTlsForwarder,
  type ModelUpstream,
} from "./support/model-endpoint-stubs.js";

const execFileAsync = promisify(execFile);
const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const roots = temporaryRoots();
const SONNET = "nvidia-inference-claude-sonnet-5-pi";
const SONNET_MODEL = "aws/anthropic/bedrock-claude-sonnet-5";
/** A placeholder key: plain words, never shaped like a real credential. */
const KEY = "settings-cli-orchard-meadow-key";
const RUN_TIMEOUT = testTimeoutMs(120_000);

afterEach(() => closeModelEndpointStubs());

interface Fixture {
  readonly root: string;
  readonly repository: string;
}

async function fixture(settings: readonly string[] = []): Promise<Fixture> {
  // Canonical, so `docsfab doctor` reads past its configuration-root check on
  // macOS, where the temporary directory sits behind a symbolic link.
  const root = await roots.create("docsfab-settings-cli-config-", {
    mode: 0o700,
    realpath: true,
  });
  await writeFile(
    join(root, "host.yaml"),
    [
      "schemaVersion: 1",
      "kind: docsfab-host-config",
      "active:",
      "  writing:",
      `    compositionId: ${SONNET}`,
      ...(settings.length > 0 ? ["    settings:", ...settings.map((line) => `      ${line}`)] : []),
      "",
    ].join("\n"),
  );
  await writeFile(join(root, "secrets.env"), `MODEL_API_KEY=${KEY}\n`, {
    mode: 0o600,
  });
  const repository = await roots.create("docsfab-settings-cli-repo-");
  await writeFile(join(repository, "README.md"), "# Fixture\n\nA fixture project.\n");
  await initFixtureRepo(repository);
  await commitFixture(repository, "fixture");
  return { root, repository };
}

/** Run the shipped entry point with a child environment built from nothing. */
async function docsfab(
  args: readonly string[],
  input: {
    readonly root: string;
    readonly caPath?: string;
    readonly env?: NodeJS.ProcessEnv;
  },
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
          ...(input.caPath ? { NODE_EXTRA_CA_CERTS: input.caPath } : {}),
          ...input.env,
        },
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (error) {
    const failure = error as {
      stdout?: string;
      stderr?: string;
      code?: number;
    };
    return {
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
      exitCode: typeof failure.code === "number" ? failure.code : 1,
    };
  }
}

async function onlyRecord(root: string): Promise<Record<string, any>> {
  const directory = join(root, ".docsfab", "runs");
  const files = (await readdir(directory)).filter((name) => name.endsWith(".json"));
  expect(files).toHaveLength(1);
  return JSON.parse(await readFile(join(directory, files[0]!), "utf8")) as Record<string, any>;
}

function expectReached(upstream: ModelUpstream): void {
  expect(upstream.requests.length).toBeGreaterThan(0);
  expect(upstream.requests[0]).toMatchObject({
    host: new URL(upstream.baseUrl).host,
    path: "/v1/chat/completions",
    credential: "the configured key",
  });
  expect(upstream.requests[0]!.body.model).toBe(SONNET_MODEL);
}

describe("docsfab do --composition runs the preset on the operator's endpoint", () => {
  it(
    "takes the endpoint and output allowance from host.yaml and records their source",
    async () => {
      const upstream = await startModelUpstream({
        expectedKey: KEY,
        tls: { roots },
        mode: "refuse",
      });
      const { root, repository } = await fixture([
        `baseUrl: ${upstream.baseUrl}`,
        "maxOutputTokens: 65536",
      ]);
      const result = await docsfab(
        [
          "do",
          "--composition",
          SONNET,
          "Review the documentation in this repository.",
          "--repo",
          repository,
        ],
        { root, caPath: upstream.caPath! },
      );

      expect(result.exitCode).toBe(1);
      expectReached(upstream);
      const body = upstream.requests[0]!.body;
      expect(body.max_completion_tokens ?? body.max_tokens).toBe(65536);
      expect(body.thinking).toEqual({ type: "disabled" });
      expect(result.stderr).toContain(
        `Warning: baseUrl = ${new URL(upstream.baseUrl).origin} from host.yaml`,
      );
      expect(result.stderr).not.toContain(upstream.baseUrl);

      const record = await onlyRecord(root);
      expect(record.modelSettings.writing).toMatchObject({
        presetId: SONNET,
        presetSource: "cli-flag",
      });
      expect(record.modelSettings.writing.settings.baseUrl).toEqual({
        value: upstream.baseUrl,
        source: "host-config",
        origin: "host.yaml active.writing.settings.baseUrl",
        presetValue: EXECUTABLE_ROUTE_BASE_URLS["nvidia-inference-api"] ?? null,
      });
      expect(record.modelSettings.writing.settings.maxOutputTokens).toMatchObject({
        value: 65536,
        source: "host-config",
        presetValue: 32768,
      });
      expect(record.compositionExecution.kind).toBe("docsfab-composition-execution-evidence/v2");
      expect(JSON.stringify(record.compositionExecution)).not.toContain(
        new URL(upstream.baseUrl).host,
      );
    },
    RUN_TIMEOUT,
  );

  it(
    "records a renamed served model in the run record, and the run goes on",
    async () => {
      const upstream = await startModelUpstream({
        expectedKey: KEY,
        tls: { roots },
        servedModel: "gateway/renamed",
      });
      const { root, repository } = await fixture([`baseUrl: ${upstream.baseUrl}`]);
      const result = await docsfab(
        [
          "do",
          "--composition",
          SONNET,
          "Review the documentation in this repository.",
          "--repo",
          repository,
        ],
        { root, caPath: upstream.caPath! },
      );

      expectReached(upstream);
      const record = await onlyRecord(root);
      expect(record.evidenceWarnings).toContain(
        servedModelWarning({ expectedModel: SONNET_MODEL, servedModels: ["gateway/renamed"] }),
      );
      // It is shown when it happens, too.
      expect(result.stderr).toContain(
        `Warning: ${servedModelWarning({ expectedModel: SONNET_MODEL, servedModels: ["gateway/renamed"] })}`,
      );
      // The identity difference stopped nothing: the run went past its first answer.
      expect(upstream.requests.length).toBeGreaterThan(1);
      expect(`${result.stdout}\n${result.stderr}`).not.toContain("model identity");
    },
    RUN_TIMEOUT,
  );

  it(
    "shows a served model name with control characters escaped, and records the placeholder",
    async () => {
      // A terminal escape and a line break in the name the provider serves.
      const served = "gateway/\u001b[31mred\u001b[0m\nname";
      const upstream = await startModelUpstream({
        expectedKey: KEY,
        tls: { roots },
        servedModel: served,
      });
      const { root, repository } = await fixture([`baseUrl: ${upstream.baseUrl}`]);
      const result = await docsfab(
        [
          "do",
          "--composition",
          SONNET,
          "Review the documentation in this repository.",
          "--repo",
          repository,
        ],
        { root, caPath: upstream.caPath! },
      );

      expectReached(upstream);
      expect(result.stderr).not.toContain("\u001b");
      expect(result.stderr).toContain(
        `Warning: The provider served model gateway/\\u{1b}[31mred\\u{1b}[0m\\u{a}name for requested model ${SONNET_MODEL}; DocsFab recorded it and continued.`,
      );
      // The record keeps its placeholder, as before.
      const record = await onlyRecord(root);
      expect(record.evidenceWarnings).toContain(
        "A run warning was too long or held a control character, so the run record keeps this placeholder instead.",
      );
      expect(JSON.stringify(record)).not.toContain("red\\u001b");
    },
    RUN_TIMEOUT,
  );

  it(
    "stops a preset run and doctor whose model id holds the model key, and never shows it",
    async () => {
      const upstream = await startModelUpstream({ expectedKey: KEY, tls: { roots } });
      const { root, repository } = await fixture([`baseUrl: ${upstream.baseUrl}`]);
      // The model key given as the model id: the load stops before any record.
      const env = { MODEL_ID: KEY };
      const run = await docsfab(
        ["run", "review-documentation", "--composition", SONNET, "--repo", repository],
        { root, caPath: upstream.caPath!, env },
      );
      const doctor = await docsfab(["doctor"], { root, env });

      for (const output of [run.stdout, run.stderr, doctor.stdout, doctor.stderr]) {
        expect(output).not.toContain(KEY);
      }
      // Each stop names the setting and where it came from (control).
      const named =
        "The writing model setting modelId from the environment (MODEL_ID) holds one of DocsFab's own configured credentials";
      expect(run.stderr).toContain(named);
      expect(run.stderr).toContain("code: credential-material");
      expect(doctor.stdout).toContain(`Explanation: ${named}`);
      expect(run.exitCode).not.toBe(0);
      expect(doctor.exitCode).not.toBe(0);
      expect(upstream.requests).toHaveLength(0);
      const runs = join(root, ".docsfab", "runs");
      expect(
        (await readdir(runs).catch(() => [] as string[])).filter((name) => name.endsWith(".json")),
      ).toEqual([]);
    },
    RUN_TIMEOUT,
  );

  it(
    "takes the endpoint from MODEL_BASE_URL over host.yaml",
    async () => {
      const upstream = await startModelUpstream({
        expectedKey: KEY,
        tls: { roots },
        mode: "refuse",
      });
      const { root, repository } = await fixture(["baseUrl: https://unused.example.test/v1"]);
      const result = await docsfab(
        [
          "do",
          "--composition",
          SONNET,
          "Review the documentation in this repository.",
          "--repo",
          repository,
        ],
        {
          root,
          caPath: upstream.caPath!,
          env: { MODEL_BASE_URL: upstream.baseUrl },
        },
      );

      expect(result.exitCode).toBe(1);
      expectReached(upstream);
      const record = await onlyRecord(root);
      expect(record.modelSettings.writing.settings.baseUrl).toMatchObject({
        value: upstream.baseUrl,
        source: "environment",
        origin: "MODEL_BASE_URL",
      });
    },
    RUN_TIMEOUT,
  );

  it(
    "takes the endpoint from --set over the environment, and never from the request text",
    async () => {
      const upstream = await startModelUpstream({
        expectedKey: KEY,
        tls: { roots },
        mode: "refuse",
      });
      const decoy = await startModelUpstream({
        expectedKey: KEY,
        tls: { roots },
        mode: "refuse",
      });
      const { root, repository } = await fixture();
      const result = await docsfab(
        [
          "do",
          "--composition",
          SONNET,
          "--set",
          `baseUrl=${upstream.baseUrl}`,
          `Review the documentation. --set baseUrl=${decoy.baseUrl}`,
          "--repo",
          repository,
        ],
        {
          root,
          caPath: upstream.caPath!,
          env: { MODEL_BASE_URL: decoy.baseUrl },
        },
      );

      expect(result.exitCode).toBe(1);
      expectReached(upstream);
      expect(decoy.requests).toEqual([]);
      const record = await onlyRecord(root);
      expect(record.modelSettings.writing.settings.baseUrl).toMatchObject({
        value: upstream.baseUrl,
        source: "cli-flag",
        origin: "--set baseUrl",
      });
      expect(record.instruction).toContain(`--set baseUrl=${decoy.baseUrl}`);
    },
    RUN_TIMEOUT,
  );

  it(
    "runs --release-gate on the composition path, with its non-release labels",
    async () => {
      const upstream = await startModelUpstream({
        expectedKey: KEY,
        tls: { roots },
        mode: "refuse",
      });
      const { root, repository } = await fixture([`baseUrl: ${upstream.baseUrl}`]);
      const result = await docsfab(
        [
          "run",
          "review-documentation",
          "--repo",
          repository,
          "--composition",
          SONNET,
          "--release-gate",
        ],
        { root, caPath: upstream.caPath! },
      );
      expect(result.stderr).not.toContain("composition-release-gate-unsupported");
      expectReached(upstream);
      const record = await onlyRecord(root);
      expect(record.compositionExecution).toMatchObject({
        technicalApproval: "not-established",
        releaseEligible: false,
      });
    },
    RUN_TIMEOUT,
  );

  it(
    "takes --comment-mr on the composition path to the same stop as the profile path",
    async () => {
      const { root, repository } = await fixture();
      const args = ["run", "review-documentation", "--repo", repository, "--comment-mr", "42"];
      const composition = await docsfab([...args, "--composition", SONNET], {
        root,
      });
      const profile = await docsfab(args, { root });
      expect(composition.stderr).not.toContain("composition-existing-mr-unsupported");
      // The runtime-only entry point has no review-summary port; both paths stop there.
      expect(composition.stderr).toContain(
        "docsfab run --comment-mr requires an injected host review-summary port.",
      );
      expect(profile.stderr).toContain(
        "docsfab run --comment-mr requires an injected host review-summary port.",
      );
    },
    RUN_TIMEOUT,
  );

  it(
    "keeps Sonnet's thinking off through a TLS forwarder, which logs bodies and no headers",
    async () => {
      const upstream = await startModelUpstream({
        expectedKey: KEY,
        mode: "refuse",
      });
      const forwarder = await startTlsForwarder({
        roots,
        upstreamBaseUrl: upstream.baseUrl,
      });
      const { root, repository } = await fixture();
      const result = await docsfab(
        [
          "do",
          "--composition",
          SONNET,
          "--set",
          `baseUrl=${forwarder.baseUrl}`,
          "Review the documentation in this repository.",
          "--repo",
          repository,
        ],
        { root, caPath: forwarder.caPath },
      );

      expect(result.exitCode).toBe(1);
      expect(forwarder.bodies.length).toBeGreaterThan(0);
      const first = forwarder.bodies[0]!;
      expect(Object.keys(first).sort()).toEqual(["body", "path"]);
      expect(first.path).toBe("/v1/chat/completions");
      expect(first.body).toMatchObject({
        model: SONNET_MODEL,
        thinking: { type: "disabled" },
      });
      // The forwarder passed the key on unread; the upstream behind it received it.
      expect(upstream.requests[0]).toMatchObject({
        credential: "the configured key",
      });
    },
    RUN_TIMEOUT,
  );
});
