// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The preset and `--set` paths load configuration into a private
 * environment: secrets.env values, settings, and their labels reach the run,
 * never `process.env` or a child process. The settings still resolve in
 * their order: `--set`, then secrets.env, then host.yaml, then the preset.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadCompositionRunRuntime } from "../src/cli/run/composition-runtime.js";
import type { RunRequestWithPublishProjection } from "../src/cli/run/request.js";
import { setCliModelSettings } from "../src/config/cli-model-settings.js";
import type { ModelSlotSettingsV1 } from "../src/config/model-settings.js";
import { loadConfig } from "../src/config/runtime-loader.js";
import { temporaryRoots } from "./helpers/temp.js";

const roots = temporaryRoots();
const SONNET = "nvidia-inference-claude-sonnet-5-pi";
/** A placeholder key: plain words, never shaped like a real credential. */
const KEY = "private-settings-orchard-meadow-key";
/** Names the loads write privately; none may reach the process environment. */
const PRIVATE_NAMES = [
  "MODEL_API_KEY",
  "MODEL_ID",
  "MODEL_MAX_OUTPUT_TOKENS",
  "MODEL_MAX_INPUT_TOKENS",
  "MODEL_CONTEXT_RESERVE_TOKENS",
  "DOCSFAB_SETTINGS_ORIGINS",
  "DOCSFAB_ACTIVE_EXECUTION_PROFILE",
] as const;
const LOADER_VARIABLES = /^(?:MODEL_|JUDGE_|DOCSFAB_|OPENAI_API_KEY$|ANTHROPIC_API_KEY$)/u;
let saved: NodeJS.ProcessEnv = {};

beforeEach(() => {
  saved = { ...process.env };
  for (const name of Object.keys(process.env)) {
    if (LOADER_VARIABLES.test(name)) delete process.env[name];
  }
});

afterEach(() => {
  setCliModelSettings(undefined);
  vi.unstubAllEnvs();
  for (const name of Object.keys(process.env)) {
    if (!(name in saved)) delete process.env[name];
  }
  Object.assign(process.env, saved);
});

async function configurationRoot(): Promise<string> {
  const root = await roots.create("docsfab-private-settings-", { mode: 0o700 });
  await writeFile(
    join(root, "host.yaml"),
    [
      "schemaVersion: 1",
      "kind: docsfab-host-config",
      "active:",
      "  writing:",
      `    compositionId: ${SONNET}`,
      "    settings:",
      "      contextReserveTokens: 2048",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(root, "secrets.env"),
    `MODEL_API_KEY=${KEY}\nMODEL_MAX_INPUT_TOKENS=200000\n`,
    { mode: 0o600 },
  );
  vi.stubEnv("DOCSFAB_CONFIG_ROOT", root);
  vi.stubEnv("HOME", root);
  setCliModelSettings({ writing: { maxOutputTokens: 12000 }, judge: {} });
  return root;
}

/** What a child process started now inherits: which names, and whether the key is any value. */
function childSees(): { names: Record<string, boolean>; keyInEnvironment: boolean } {
  const digest = createHash("sha256").update(KEY).digest("hex");
  const script = [
    'const { createHash } = require("node:crypto");',
    "const [digest, ...names] = process.argv.slice(1);",
    "const hash = (value) => createHash('sha256').update(value).digest('hex');",
    "process.stdout.write(JSON.stringify({",
    "  names: Object.fromEntries(names.map((name) => [name, name in process.env])),",
    "  keyInEnvironment: Object.values(process.env).some((value) => value && hash(value) === digest),",
    "}));",
  ].join("\n");
  return JSON.parse(
    execFileSync(process.execPath, ["-e", script, digest, ...PRIVATE_NAMES], { encoding: "utf8" }),
  );
}

function expectPrivate(): void {
  for (const name of PRIVATE_NAMES) expect(process.env[name], name).toBeUndefined();
  expect(childSees()).toEqual({
    names: Object.fromEntries(PRIVATE_NAMES.map((name) => [name, false])),
    keyInEnvironment: false,
  });
}

function expectLadder(settings: ModelSlotSettingsV1 | undefined): void {
  expect(settings?.presetId).toBe(SONNET);
  expect(settings?.settings.maxOutputTokens).toMatchObject({ value: 12000, source: "cli-flag" });
  expect(settings?.settings.maxInputTokens).toMatchObject({ value: 200000, source: "secrets-env" });
  expect(settings?.settings.contextReserveTokens).toMatchObject({
    value: 2048,
    source: "host-config",
  });
  expect(settings?.settings.modelId).toMatchObject({ source: "preset" });
}

describe("settings load into a private environment", () => {
  it("--composition: the run gets the key and the settings; the process and its children get neither", async () => {
    await configurationRoot();
    const request: RunRequestWithPublishProjection = {
      workflow: "review-documentation",
      repositoryPath: "/tmp/docsfab-private-settings-target",
      revision: "HEAD",
      compositionId: SONNET,
      allowWrite: false,
      releaseGate: false,
      verbose: false,
      json: false,
      showScan: false,
    };
    const runtime = await loadCompositionRunRuntime(request);

    expect(runtime.credential.apiKey).toBe(KEY);
    expect(runtime.modelSettings?.presetSource).toBe("cli-flag");
    expectLadder(runtime.modelSettings);
    expect(runtime.executionProfile.profile.maxOutputTokens).toBe(12000);
    expectPrivate();
  });

  it("a resume's load with its --composition preset stays private too", async () => {
    await configurationRoot();
    const config = loadConfig(process.env, { writingPreset: SONNET });

    expect(config.model.apiKey).toBe(KEY);
    expectLadder(config.model.modelSettings);
    expectPrivate();
  });

  it("the host.yaml preset with --set stays private (control: the default load)", async () => {
    await configurationRoot();
    const config = loadConfig();

    expect(config.model.apiKey).toBe(KEY);
    expect(config.model.modelSettings?.presetSource).toBe("host-config");
    expectLadder(config.model.modelSettings);
    expectPrivate();
  });
});
