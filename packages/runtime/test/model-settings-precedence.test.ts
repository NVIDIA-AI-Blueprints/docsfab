// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Model settings resolve through the real loader: `--set`, then the
 * environment (the process, then secrets.env or a legacy .env), then host.yaml
 * `active.<slot>.settings`, then the preset or profile file. Every case reads
 * the effective value from `loadConfig`, the label from its settings record,
 * and the value the binder runs with.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import { setCliModelSettings } from "../src/config/cli-model-settings.js";
import { loadDocsFabEnvironment } from "../src/config/host-paths.js";
import {
  formatModelSlotSettingsLines,
  MODEL_SETTINGS_ORIGINS_VARIABLE,
  readModelSlotSettings,
} from "../src/config/model-settings.js";
import { loadPrivateDocsFabEnvironment } from "../src/config/private-environment.js";
import { decodeHostConfig } from "../src/config/profile-projection.js";
import { EXECUTABLE_ROUTE_BASE_URLS } from "../src/config/executable-route-urls.js";
import { loadConfig, loadModelEndpointForInspection } from "../src/config/runtime-loader.js";
import { diagnose, formatDoctorResult, resolveDoctorModelBinding } from "../src/doctor.js";
import { bindModelExecutionIdentity } from "../src/model/configuration.js";
import { resolveOperatorExecutionBinding } from "../src/model/operator-execution-binding.js";
import { runSetupBootstrap } from "../src/setup/bootstrap.js";
import { validModelEnvironment } from "./helpers.js";
import { temporaryRoots } from "./helpers/temp.js";

const roots = temporaryRoots();
const SONNET = "nvidia-inference-claude-sonnet-5-pi";
const SONNET_MODEL = "aws/anthropic/bedrock-claude-sonnet-5";
const QWEN = "nvidia-inference-qwen3-5-397b-a17b-pi";
const HUB = EXECUTABLE_ROUTE_BASE_URLS["nvidia-inference-api"];
/** A placeholder key: plain words, never shaped like a real credential. */
const KEY = "settings-ladder-orchard-meadow-key";

/** Variables the loader reads; the developer's own shell must not reach a case. */
const LOADER_VARIABLES =
  /^(?:MODEL_|JUDGE_|DOCSFAB_|OPENAI_API_KEY$|ANTHROPIC_API_KEY$|NVIDIA_API_KEY$|COMPATIBLE_)/u;
let saved: NodeJS.ProcessEnv = {};

beforeEach(() => {
  saved = { ...process.env };
  for (const name of Object.keys(process.env)) {
    if (LOADER_VARIABLES.test(name)) delete process.env[name];
  }
});

afterEach(() => {
  setCliModelSettings(undefined);
  for (const name of Object.keys(process.env)) {
    if (!(name in saved)) delete process.env[name];
  }
  Object.assign(process.env, saved);
});

async function splitRoot(input: {
  readonly preset?: string;
  readonly profile?: string;
  readonly settings?: readonly string[];
  readonly secrets?: readonly string[];
}): Promise<string> {
  const root = await roots.create("docsfab-settings-ladder-", { mode: 0o700 });
  const host = ["schemaVersion: 1", "kind: docsfab-host-config"];
  if (input.profile) host.push(`activePolicyProfile: ${input.profile}`);
  if (input.preset || input.settings) {
    host.push("active:", "  writing:");
    if (input.preset) host.push(`    compositionId: ${input.preset}`);
    if (input.settings)
      host.push("    settings:", ...input.settings.map((line) => `      ${line}`));
  }
  await writeFile(join(root, "host.yaml"), `${host.join("\n")}\n`);
  await writeFile(
    join(root, "secrets.env"),
    `${(input.secrets ?? [`MODEL_API_KEY=${KEY}`]).join("\n")}\n`,
    {
      mode: 0o600,
    },
  );
  return root;
}

/** A configuration root whose writing slot is a model profile file with unattested metadata. */
async function profileRoot(
  settings: readonly string[] = [],
  /** Profile fields to replace, such as `reasoning: true`. */
  fields: Readonly<Record<string, string>> = {},
): Promise<string> {
  const root = await splitRoot({
    profile: "profiles/example.yaml",
    ...(settings.length > 0 ? { settings } : {}),
  });
  await mkdir(join(root, "profiles"), { mode: 0o700 });
  await writeFile(
    join(root, "profiles", "example.yaml"),
    [
      "schemaVersion: 1",
      "kind: docsfab-model-profile",
      "slot: policy",
      "provider: operator-configured-openai-compatible",
      "baseUrl: https://models.example.test/v1",
      "modelId: example/model",
      "apiFormat: chat_completions",
      "transport: openai-chat-completions",
      "contextWindow: 128000",
      "maxInputTokens: 128000",
      "maxOutputTokens: 16384",
      "apiMinOutputTokens: 16",
      "contextReserveTokens: 1024",
      "reasoning: false",
      "inputTypes: text",
      "supportsDeveloperRole: false",
      "supportsReasoningEffort: false",
      "compatibleApiFormats: chat_completions",
      "inputCostPerMillion: unknown",
      "outputCostPerMillion: unknown",
      "cacheReadCostPerMillion: unknown",
      "cacheWriteCostPerMillion: unknown",
      "profileApprovedSource: unknown",
      "profileEffectiveDate: unknown",
      "profileReviewAfter: unknown",
      "",
    ]
      .map((line) => {
        const field = line.slice(0, line.indexOf(":"));
        return fields[field] !== undefined ? `${field}: ${fields[field]}` : line;
      })
      .join("\n"),
  );
  return root;
}

function load(root: string, environment: NodeJS.ProcessEnv = {}, writingPreset?: string) {
  return loadConfig(
    { DOCSFAB_CONFIG_ROOT: root, HOME: root, ...environment },
    writingPreset === undefined ? {} : { writingPreset },
  );
}

async function boundOutput(config: ReturnType<typeof loadConfig>): Promise<number> {
  const binding = await resolveOperatorExecutionBinding({
    model: config.model,
    environment: {},
  });
  return binding.profile.profile.maxOutputTokens;
}

describe("model settings precedence through the real loader", () => {
  it("takes each value from the highest layer that sets it: --set, environment, secrets.env, host.yaml, preset", async () => {
    const root = await splitRoot({
      preset: SONNET,
      settings: ["maxOutputTokens: 40000"],
      secrets: [`MODEL_API_KEY=${KEY}`, "MODEL_MAX_OUTPUT_TOKENS=45000"],
    });
    const environment = { MODEL_MAX_OUTPUT_TOKENS: "50000" };

    setCliModelSettings({ writing: { maxOutputTokens: 55000 }, judge: {} });
    let config = load(root, environment);
    expect(config.model.modelSettings?.settings.maxOutputTokens).toMatchObject({
      value: 55000,
      source: "cli-flag",
      origin: "--set maxOutputTokens",
      presetValue: 32768,
    });
    expect(await boundOutput(config)).toBe(55000);

    setCliModelSettings(undefined);
    config = load(root, environment);
    expect(config.model.modelSettings?.settings.maxOutputTokens).toMatchObject({
      value: 50000,
      source: "environment",
      origin: "MODEL_MAX_OUTPUT_TOKENS",
    });
    expect(await boundOutput(config)).toBe(50000);

    config = load(root);
    expect(config.model.modelSettings?.settings.maxOutputTokens).toMatchObject({
      value: 45000,
      source: "secrets-env",
      origin: "secrets.env:2",
    });
    expect(await boundOutput(config)).toBe(45000);

    await writeFile(join(root, "secrets.env"), `MODEL_API_KEY=${KEY}\n`, {
      mode: 0o600,
    });
    config = load(root);
    expect(config.model.modelSettings?.settings.maxOutputTokens).toMatchObject({
      value: 40000,
      source: "host-config",
      origin: "host.yaml active.writing.settings.maxOutputTokens",
    });
    expect(await boundOutput(config)).toBe(40000);

    const presetOnly = await splitRoot({ preset: SONNET });
    config = load(presetOnly);
    expect(config.model.modelSettings?.settings.maxOutputTokens).toMatchObject({
      value: 32768,
      source: "preset",
      origin: SONNET,
    });
    expect(await boundOutput(config)).toBe(32768);
  });

  it("lets the environment override host.yaml's preset instead of being overwritten by it", async () => {
    const root = await splitRoot({ preset: SONNET });
    const config = load(root, {
      MODEL_BASE_URL: "https://env-gateway.example.test/v1",
    });
    expect(config.model.baseUrl).toBe("https://env-gateway.example.test/v1");
    expect(config.model.endpointSource).toBe("environment");
    expect(config.model.modelSettings?.settings.baseUrl).toMatchObject({
      source: "environment",
      origin: "MODEL_BASE_URL",
      presetValue: HUB,
    });

    // Control: the same root without the variable runs on the preset's endpoint.
    const control = load(root);
    expect(control.model.baseUrl).toBe(HUB);
    expect(control.model.endpointSource).toBe("preset");
  });

  it("puts a model profile file below the environment and host.yaml settings", async () => {
    const root = await splitRoot({
      profile: "profiles/example.yaml",
      settings: ["contextReserveTokens: 2048"],
    });
    await mkdir(join(root, "profiles"), { mode: 0o700 });
    await writeFile(
      join(root, "profiles", "example.yaml"),
      [
        "schemaVersion: 1",
        "kind: docsfab-model-profile",
        "slot: policy",
        "provider: operator-configured-openai-compatible",
        "baseUrl: https://models.example.test/v1",
        "modelId: example/model",
        "apiFormat: chat_completions",
        "transport: openai-chat-completions",
        "contextWindow: 128000",
        "maxInputTokens: 128000",
        "maxOutputTokens: 16384",
        "apiMinOutputTokens: 16",
        "contextReserveTokens: 1024",
        "reasoning: false",
        "inputTypes: text",
        "supportsDeveloperRole: false",
        "supportsReasoningEffort: false",
        "compatibleApiFormats: chat_completions",
        "inputCostPerMillion: unknown",
        "outputCostPerMillion: unknown",
        "cacheReadCostPerMillion: unknown",
        "cacheWriteCostPerMillion: unknown",
        "profileApprovedSource: unknown",
        "profileEffectiveDate: unknown",
        "profileReviewAfter: unknown",
        "",
      ].join("\n"),
    );
    const config = load(root, { MODEL_MAX_OUTPUT_TOKENS: "20000" });
    const settings = config.model.modelSettings!;
    expect(settings.presetId).toBeNull();
    expect(settings.settings.modelId).toMatchObject({
      value: "example/model",
      source: "profile-file",
      origin: "profiles/example.yaml",
    });
    expect(settings.settings.contextReserveTokens).toMatchObject({
      value: 2048,
      source: "host-config",
    });
    expect(config.model.requestPolicy.reservedContextTokens).toBe(2048);
    expect(settings.settings.maxOutputTokens).toMatchObject({
      value: 20000,
      source: "environment",
    });
    expect(config.model.profile.maxOutputTokens).toBe(20000);
  });

  it("names a legacy .env file and line, below the environment", async () => {
    const root = await roots.create("docsfab-settings-legacy-", {
      mode: 0o700,
    });
    await writeFile(
      join(root, ".env"),
      [
        "MODEL_PROVIDER=operator-configured-openai-compatible",
        "MODEL_BASE_URL=https://legacy.example.test/v1",
        "MODEL_ID=example/model",
        "MODEL_API_FORMAT=chat_completions",
        `MODEL_API_KEY=${KEY}`,
        "MODEL_CONTEXT_WINDOW=128000",
        "MODEL_MAX_OUTPUT_TOKENS=16384",
        "MODEL_API_MIN_OUTPUT_TOKENS=16",
        "MODEL_CONTEXT_RESERVE_TOKENS=1024",
        "MODEL_REASONING=false",
        "MODEL_INPUT_TYPES=text",
        "MODEL_SUPPORTS_DEVELOPER_ROLE=false",
        "MODEL_SUPPORTS_REASONING_EFFORT=false",
        "MODEL_COMPATIBLE_API_FORMATS=chat_completions",
        "MODEL_INPUT_COST_PER_MILLION=unknown",
        "MODEL_OUTPUT_COST_PER_MILLION=unknown",
        "MODEL_CACHE_READ_COST_PER_MILLION=unknown",
        "MODEL_CACHE_WRITE_COST_PER_MILLION=unknown",
        "MODEL_PROFILE_APPROVED_SOURCE=unknown",
        "MODEL_PROFILE_EFFECTIVE_DATE=unknown",
        "MODEL_PROFILE_REVIEW_AFTER=unknown",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    const config = load(root);
    expect(config.model.modelSettings?.settings.baseUrl).toMatchObject({
      value: "https://legacy.example.test/v1",
      source: "legacy-env-file",
      origin: ".env:2",
    });
    expect(config.model.endpointSource).toBe("legacy-env-file");

    const overridden = load(root, { MODEL_MAX_OUTPUT_TOKENS: "8000" });
    expect(overridden.model.modelSettings?.settings.maxOutputTokens).toMatchObject({
      value: 8000,
      source: "environment",
    });
    expect(overridden.model.profile.maxOutputTokens).toBe(8000);
  });

  it("selects the --composition preset by id and keeps the slot's host.yaml settings", async () => {
    const root = await splitRoot({
      preset: QWEN,
      settings: ["baseUrl: https://llm-gateway.example.test/v1"],
    });
    const config = load(root, {}, SONNET);
    const settings = config.model.modelSettings!;
    expect(settings.presetId).toBe(SONNET);
    expect(settings.presetSource).toBe("cli-flag");
    expect(config.model.modelId).toBe(SONNET_MODEL);
    expect(config.model.baseUrl).toBe("https://llm-gateway.example.test/v1");

    // Control: without --composition, host.yaml's own preset applies.
    const control = load(root);
    expect(control.model.modelSettings?.presetId).toBe(QWEN);
    expect(control.model.modelSettings?.presetSource).toBe("host-config");
  });

  it("binds a preset behind a gateway by its id, not as an unmatched profile", async () => {
    const root = await splitRoot({
      preset: SONNET,
      settings: ["baseUrl: https://llm-gateway.example.test/v1"],
    });
    const config = load(root);
    const binding = await resolveOperatorExecutionBinding({
      model: config.model,
      environment: {},
    });
    expect(binding.match).toBe("installed-composition");
    expect(binding.bound?.composition.compositionId).toBe(SONNET);
    expect(binding.profile.baseUrl).toBe("https://llm-gateway.example.test/v1");
    expect(binding.profile.routeId).toBe("nvidia-inference-api");

    // The settings' preset alone binds it too, with no host selection carried.
    const { compositionId: _hostSelection, ...settingsOnly } = config.model;
    const viaSettings = await resolveOperatorExecutionBinding({
      model: settingsOnly,
      environment: {},
    });
    expect(viaSettings.match).toBe("installed-composition");
    expect(viaSettings.bound?.composition.compositionId).toBe(SONNET);

    // Control: the same endpoint and model with no preset named, by the
    // settings or by the host selection the endpoint carries, stays an
    // unmatched profile.
    const { modelSettings: _settings, compositionId: _host, ...unnamed } = config.model;
    const unmatched = await resolveOperatorExecutionBinding({
      model: unnamed,
      environment: {},
    });
    expect(unmatched.match).toBe("unmatched-byo");
  });

  it("labels and warns about a value that differs from the preset, never refusing it", async () => {
    const root = await splitRoot({
      preset: SONNET,
      settings: [
        "baseUrl: https://llm-gateway.example.test/v1/proxy/path",
        "modelId: gateway/sonnet",
      ],
    });
    const config = load(root);
    const notes = config.model.modelSettings!.notes;
    expect(notes).toContainEqual(
      expect.stringContaining("baseUrl = https://llm-gateway.example.test from host.yaml"),
    );
    expect(notes.join("\n")).not.toContain("/proxy/path");
    expect(notes).toContainEqual(
      expect.stringContaining("modelId = gateway/sonnet from host.yaml"),
    );
    const binding = await resolveOperatorExecutionBinding({
      model: config.model,
      environment: {},
    });
    expect(binding.profile.modelId).toBe("gateway/sonnet");
    expect(binding.notes).toEqual(notes);
  });

  it("shows doctor each effective value with its source, and the endpoint's host only", async () => {
    const root = await splitRoot({
      preset: SONNET,
      settings: [
        "baseUrl: https://llm-gateway.example.test/private/deployment/v1",
        "maxOutputTokens: 65536",
      ],
    });
    const config = load(root, { MODEL_REASONING_EFFORT: "high" });
    // As `docsfab doctor` composes it: the configuration, then the bound model.
    const output = formatDoctorResult({
      ...(await diagnose(config)),
      ...(await resolveDoctorModelBinding(config.model)),
    });
    const lines = output.split("\n").map((line) => line.trim());

    expect(lines).toContain(
      "Endpoint: https://llm-gateway.example.test (path withheld; from host.yaml active.writing.settings.baseUrl)",
    );
    expect(lines).toContain("Preset: nvidia-inference-claude-sonnet-5-pi (selected in host.yaml)");
    expect(lines).toContain(
      `baseUrl: https://llm-gateway.example.test (host.yaml active.writing.settings.baseUrl; preset ${new URL(HUB).origin})`,
    );
    expect(lines).toContain(
      "maxOutputTokens: 65536 (host.yaml active.writing.settings.maxOutputTokens; preset 32768)",
    );
    expect(lines).toContain(
      "reasoning: true (the environment (MODEL_REASONING_EFFORT, as reasoningEffort turns reasoning on); preset false)",
    );
    expect(lines).toContain(
      "reasoningEffort: high (the environment (MODEL_REASONING_EFFORT); preset not set)",
    );
    expect(lines).toContain(`modelId: ${SONNET_MODEL} (the preset (${SONNET}))`);
    expect(lines).toContain(
      `Warning: maxOutputTokens = 65536 from host.yaml active.writing.settings.maxOutputTokens differs from preset ${SONNET} (32768).`,
    );
    // The run uses what the block says, and nothing shows the path or the root.
    expect(lines).toContainEqual(expect.stringMatching(/^Capabilities: reasoning=true,/u));
    expect(lines).toContainEqual(expect.stringMatching(/effective-output=65536$/u));
    expect(output).not.toContain("/private/deployment");
    expect(output).not.toContain(root);
  });

  it("carries the preset's larger input and output defaults down to an operator context window", async () => {
    const root = await splitRoot({ preset: SONNET });
    const config = load(root, { MODEL_CONTEXT_WINDOW: "20000" });
    const settings = config.model.modelSettings!.settings;
    expect(settings.contextWindow).toMatchObject({
      value: 20000,
      source: "environment",
    });
    expect(settings.maxInputTokens).toMatchObject({
      value: 20000,
      source: "environment",
      origin: "MODEL_CONTEXT_WINDOW",
      presetValue: 1_000_000,
    });
    expect(settings.maxOutputTokens).toMatchObject({
      value: 20000,
      presetValue: 32768,
    });

    // Adjacent condition: a window above the preset's output leaves the output alone.
    const wide = load(root, { MODEL_CONTEXT_WINDOW: "200000" });
    expect(wide.model.modelSettings!.settings.maxOutputTokens).toMatchObject({
      value: 32768,
      source: "preset",
    });
  });

  it("recognizes values an earlier load wrote, so the next preset replaces them", async () => {
    const root = await splitRoot({ preset: SONNET });
    const target: NodeJS.ProcessEnv = {
      DOCSFAB_CONFIG_ROOT: root,
      HOME: root,
      MODEL_REASONING_EFFORT: "high",
    };
    loadDocsFabEnvironment(target);
    expect(target.MODEL_ID).toBe(SONNET_MODEL);
    loadDocsFabEnvironment(target, { writingPreset: QWEN });
    expect(target.MODEL_ID).toBe("nvidia/qwen/qwen3-5-397b-a17b");
    const settings = readModelSlotSettings(target, "writing", root)!;
    expect(settings.presetId).toBe(QWEN);
    expect(settings.settings.modelId).toMatchObject({
      source: "preset",
      origin: QWEN,
    });
    // The operator's own variable keeps its label across loads.
    expect(settings.settings.reasoningEffort).toMatchObject({
      value: "high",
      source: "environment",
    });
    expect(target[MODEL_SETTINGS_ORIGINS_VARIABLE]).toBeDefined();
  });

  it("keeps a --set label when a later load reads the same environment without the flag", async () => {
    const root = await splitRoot({ preset: SONNET });
    const target: NodeJS.ProcessEnv = { DOCSFAB_CONFIG_ROOT: root, HOME: root };
    setCliModelSettings({ writing: { maxOutputTokens: 12000 }, judge: {} });
    loadDocsFabEnvironment(target);
    // A child process inherits the environment the first load wrote, but not
    // the parent's command line.
    setCliModelSettings(undefined);
    loadDocsFabEnvironment(target);
    expect(target.MODEL_MAX_OUTPUT_TOKENS).toBe("12000");
    expect(readModelSlotSettings(target, "writing", root)!.settings.maxOutputTokens).toEqual({
      value: 12000,
      source: "cli-flag",
      origin: "--set maxOutputTokens",
      presetValue: 32768,
    });
  });

  it("refuses an unknown or malformed host.yaml setting by name, and admits loopback HTTP", async () => {
    const unknown = await splitRoot({
      preset: SONNET,
      settings: ["maxOutputToken: 65536"],
    });
    expect(() => load(unknown)).toThrow(
      "The host.yaml active.writing.settings field has no model setting named maxOutputToken.",
    );
    const zero = await splitRoot({
      preset: SONNET,
      settings: ["maxOutputTokens: 0"],
    });
    expect(() => load(zero)).toThrow(
      "host.yaml active.writing.settings.maxOutputTokens must be a positive integer.",
    );
    const remote = await splitRoot({
      preset: SONNET,
      settings: ["baseUrl: http://models.example.test/v1"],
    });
    expect(() => load(remote)).toThrow(
      "host.yaml active.writing.settings.baseUrl uses plain HTTP to a host that is not loopback.",
    );
    const loopback = await splitRoot({
      preset: SONNET,
      settings: ["baseUrl: http://127.0.0.1:9/v1"],
    });
    expect(load(loopback).model.baseUrl).toBe("http://127.0.0.1:9/v1");
  });

  it("applies host.yaml judge settings to a judge configured by the environment, naming any it overrides", async () => {
    const root = await splitRoot({ preset: SONNET });
    const host = await readFile(join(root, "host.yaml"), "utf8");
    await writeFile(
      join(root, "host.yaml"),
      `${host}  judge:\n    settings:\n      reasoningEffort: high\n      maxOutputTokens: 1234\n`,
    );
    // A judge the environment configures: every JUDGE_* profile field.
    const judgeEnvironment: NodeJS.ProcessEnv = { JUDGE_ENABLED: "true" };
    for (const [name, value] of Object.entries(validModelEnvironment)) {
      judgeEnvironment[
        name === "MODEL_ID" ? "JUDGE_MODEL_ID" : name.replace(/^MODEL_/u, "JUDGE_")
      ] = value;
    }
    const config = load(root, judgeEnvironment);
    const judge = config.judge!.modelSettings!;
    // A key the environment leaves unset takes host.yaml's value.
    expect(judge.settings.reasoningEffort).toMatchObject({
      value: "high",
      source: "host-config",
      origin: "host.yaml active.judge.settings.reasoningEffort",
    });
    // A key the environment sets keeps the environment's value, and says so.
    expect(judge.settings.maxOutputTokens).toMatchObject({
      value: 16384,
      source: "environment",
    });
    expect(judge.notes).toContain(
      "judge.maxOutputTokens = 1234 in host.yaml active.judge.settings is overridden by the environment (JUDGE_MAX_OUTPUT_TOKENS).",
    );
    expect(config.judge!.profile.maxOutputTokens).toBe(16384);

    // Control: with no judge configured, the writing slot is unaffected.
    const withoutJudge = load(root);
    expect(withoutJudge.judge).toBeUndefined();
  });

  it("applies host.yaml judge settings to a judge that only secrets.env configures", async () => {
    // Every JUDGE_* profile field, and JUDGE_ENABLED itself, only in secrets.env.
    const judgeLines = Object.entries(validModelEnvironment).map(
      ([name, value]) =>
        `${name === "MODEL_ID" ? "JUDGE_MODEL_ID" : name.replace(/^MODEL_/u, "JUDGE_")}=${value}`,
    );
    const root = await splitRoot({
      preset: SONNET,
      secrets: [`MODEL_API_KEY=${KEY}`, "JUDGE_ENABLED=true", ...judgeLines],
    });
    const host = await readFile(join(root, "host.yaml"), "utf8");
    await writeFile(
      join(root, "host.yaml"),
      `${host}  judge:\n    settings:\n      reasoningEffort: high\n`,
    );
    const config = load(root);

    expect(config.judge?.modelSettings?.settings.reasoningEffort).toMatchObject({
      value: "high",
      source: "host-config",
      origin: "host.yaml active.judge.settings.reasoningEffort",
    });
    // The judge binds the effort its settings name.
    expect(bindModelExecutionIdentity(config.judge!).reasoningEffort).toBe("high");
  });

  describe("a setting that holds the model key stops the load", () => {
    /** A legacy configuration .env whose model id is the model key. */
    async function legacyRoot(): Promise<string> {
      const root = await roots.create("docsfab-settings-legacy-key-", { mode: 0o700 });
      const lines = Object.entries({ ...validModelEnvironment, MODEL_ID: KEY, MODEL_API_KEY: KEY });
      await writeFile(join(root, ".env"), `${lines.map(([n, v]) => `${n}=${v}`).join("\n")}\n`, {
        mode: 0o600,
      });
      return root;
    }
    const judgeEnvironment = (): NodeJS.ProcessEnv => {
      const environment: NodeJS.ProcessEnv = { JUDGE_ENABLED: "true" };
      for (const [name, value] of Object.entries(validModelEnvironment)) {
        environment[name === "MODEL_ID" ? "JUDGE_MODEL_ID" : name.replace(/^MODEL_/u, "JUDGE_")] =
          value;
      }
      return { ...environment, JUDGE_MODEL_ID: KEY };
    };
    const SURFACES = [
      [
        "the environment on a preset",
        () => splitRoot({ preset: SONNET }),
        () => ({ MODEL_ID: KEY }),
        "The writing model setting modelId from the environment (MODEL_ID)",
      ],
      [
        "--set on a model profile",
        () => profileRoot(),
        () => {
          setCliModelSettings({ writing: { modelId: KEY }, judge: {} });
          return {};
        },
        "The writing model setting modelId from the command line (--set modelId)",
      ],
      [
        "host.yaml settings",
        () => splitRoot({ preset: SONNET, settings: [`modelId: ${KEY}`] }),
        () => ({}),
        "The writing model setting modelId from host.yaml active.writing.settings.modelId",
      ],
      [
        "secrets.env",
        () => splitRoot({ preset: SONNET, secrets: [`MODEL_API_KEY=${KEY}`, `MODEL_ID=${KEY}`] }),
        () => ({}),
        "The writing model setting modelId from secrets.env",
      ],
      [
        "a legacy .env",
        legacyRoot,
        () => ({}),
        "The writing model setting modelId from the configuration .env (.env:",
      ],
      [
        "the judge slot",
        () => splitRoot({ preset: SONNET }),
        judgeEnvironment,
        "The judge model setting modelId from the environment (JUDGE_MODEL_ID)",
      ],
      [
        "another setting",
        () => profileRoot(),
        () => ({ MODEL_BASE_URL: `https://${KEY}.example.test/v1` }),
        "The writing model setting baseUrl from the environment (MODEL_BASE_URL)",
      ],
    ] as const;

    it.each(SURFACES)(
      "from %s, naming the setting and its source, never the value",
      async (_surface, makeRoot, environment, named) => {
        const root = await makeRoot();
        let refusal: unknown;
        try {
          load(root, environment());
        } catch (error) {
          refusal = error;
        }

        expect(refusal).toMatchObject({ code: "credential-material" });
        const message = (refusal as Error).message;
        expect(message).toContain(named);
        expect(message).toContain("(environment variable MODEL_API_KEY)");
        expect(message).not.toContain(KEY);
      },
    );

    it("loads the same configurations with a normal value (control)", async () => {
      expect(
        load(await splitRoot({ preset: SONNET }), { MODEL_ID: "example/model" }).model.modelId,
      ).toBe("example/model");
      setCliModelSettings({ writing: { modelId: "example/other-model" }, judge: {} });
      expect(load(await profileRoot()).model.modelId).toBe("example/other-model");
    });

    it("stops the profile inspection load too", async () => {
      const root = await splitRoot({ preset: SONNET });
      Object.assign(process.env, { DOCSFAB_CONFIG_ROOT: root, HOME: root, MODEL_ID: KEY });

      expect(() => loadModelEndpointForInspection("policy")).toThrow(
        "The writing model setting modelId from the environment (MODEL_ID)",
      );
    });
  });

  describe("behind the load's stop, each layer still withholds the model key", () => {
    /** The loaded private environment, which the load-time stop never screens itself. */
    async function loadedWithKeyAsModel(): Promise<NodeJS.ProcessEnv> {
      const root = await splitRoot({ preset: SONNET });
      return loadPrivateDocsFabEnvironment({
        DOCSFAB_CONFIG_ROOT: root,
        HOME: root,
        MODEL_ID: KEY,
      });
    }

    it("never puts a setting value that holds the model key in a note", async () => {
      const notes = readModelSlotSettings(await loadedWithKeyAsModel(), "writing")!.notes.join(
        "\n",
      );

      expect(notes).not.toContain(KEY);
      // The note still names the setting and its source (control).
      expect(notes).toContain("modelId = [REDACTED] from the environment (MODEL_ID)");
    });

    it("never shows it in doctor's settings lines or model line", async () => {
      const record = readModelSlotSettings(await loadedWithKeyAsModel(), "writing")!;
      const lines = formatModelSlotSettingsLines(record).join("\n");
      const config = load(await splitRoot({ preset: SONNET }));
      const doctor = formatDoctorResult({
        provider: config.model.providerId,
        endpoint: config.model.baseUrl,
        model: KEY,
        profile: config.model.profile,
        requestPolicy: config.model.requestPolicy,
        retryPolicy: config.retryPolicy,
        skills: [],
        contextSources: [],
      });

      expect(lines).not.toContain(KEY);
      expect(lines).toContain("modelId: [REDACTED] (the environment (MODEL_ID)");
      expect(doctor).not.toContain(KEY);
      expect(doctor).toContain("  Model: withheld-unsafe-identity");
    });
  });

  it("never puts the model key in a note the binding writes", async () => {
    const root = await splitRoot({ preset: SONNET });
    // The load registers the key; a configuration built in code carries no
    // settings record, so the binding names the differing model itself.
    const config = load(root);
    const { modelSettings: _settings, ...built } = config.model;
    const binding = await resolveOperatorExecutionBinding({
      model: { ...built, modelId: KEY },
      environment: {},
    });
    const notes = binding.notes.join("\n");

    expect(notes).not.toContain(KEY);
    expect(notes).toContain("The configured model [REDACTED] differs from preset");
  });

  describe("an operator's reasoning: false over a profile that declares effort support", () => {
    const ATTESTED = {
      profileApprovedSource: "https://metadata.example.test/models/example-model",
      profileEffectiveDate: "2020-01-01",
      profileReviewAfter: "2099-12-31",
    };
    const SUPPORTED = { reasoning: "true", supportsReasoningEffort: "true" };
    const SURFACES = [
      ["--set", [], {}, () => setCliModelSettings({ writing: { reasoning: false }, judge: {} })],
      ["the environment", [], { MODEL_REASONING: "false" }, () => undefined],
      ["host.yaml", ["reasoning: false"], {}, () => undefined],
    ] as const;

    it.each(SURFACES)(
      "from %s binds the effort support off with a warning, never refusing",
      async (_surface, settings, environment, flag) => {
        const root = await profileRoot([...settings], { ...SUPPORTED, ...ATTESTED });
        flag();
        const config = load(root, environment);

        expect(config.model.profile.reasoning).toBe(false);
        expect(config.model.profile.compatibility.supportsReasoningEffort).toBe(false);
        expect(
          config.model.modelSettings?.notes.some(
            (note) =>
              note.startsWith("reasoning = false from ") &&
              note.endsWith(
                "also turns off the reasoning-effort support that MODEL_SUPPORTS_REASONING_EFFORT declares.",
              ),
          ),
        ).toBe(true);
      },
    );

    it("from the profile itself is still an invalid profile (control)", async () => {
      const root = await profileRoot([], {
        reasoning: "false",
        supportsReasoningEffort: "true",
        ...ATTESTED,
      });
      expect(() => load(root)).toThrow(
        "MODEL_SUPPORTS_REASONING_EFFORT: cannot be true when MODEL_REASONING is false",
      );
    });
  });

  describe("one endpoint shape rule at every entry", () => {
    const SHAPES = [
      [
        "a user name and password",
        "https://user:secret@models.example.test/v1",
        "must not carry a user name or password; DocsFab sends the model key in a request header",
      ],
      [
        "a query string",
        "https://models.example.test/v1?api-version=1",
        "must not carry a query string",
      ],
      ["a fragment", "https://models.example.test/v1#frag", "must not carry a fragment"],
    ] as const;

    it.each(SHAPES)(
      "refuses an environment endpoint with %s on a profile slot before anything is recorded",
      async (_label, baseUrl, problem) => {
        const root = await profileRoot();
        let message = "";
        try {
          load(root, { MODEL_BASE_URL: baseUrl });
        } catch (error) {
          message = (error as Error).message;
        }
        expect(message).toContain(`- MODEL_BASE_URL: ${problem}`);
        // The refusal names the field and the problem, never the URL's parts.
        expect(message).not.toContain("secret");
        expect(message).not.toContain("api-version");
        expect(message).not.toContain("#frag");
      },
    );

    it.each(SHAPES)(
      "refuses an environment endpoint with %s on a preset slot",
      async (_label, baseUrl, problem) => {
        const root = await splitRoot({ preset: SONNET });
        expect(() => load(root, { MODEL_BASE_URL: baseUrl })).toThrow(
          `- MODEL_BASE_URL: ${problem}`,
        );
      },
    );

    it.each(SHAPES)(
      "refuses a host.yaml endpoint with %s on a profile slot",
      async (_label, baseUrl, problem) => {
        const root = await profileRoot([`baseUrl: "${baseUrl}"`]);
        expect(() => load(root)).toThrow(`host.yaml active.writing.settings.baseUrl ${problem}.`);
      },
    );

    it("refuses a judge endpoint with a query string from the environment", async () => {
      const root = await splitRoot({ preset: SONNET });
      const judgeEnvironment: NodeJS.ProcessEnv = { JUDGE_ENABLED: "true" };
      for (const [name, value] of Object.entries(validModelEnvironment)) {
        judgeEnvironment[
          name === "MODEL_ID" ? "JUDGE_MODEL_ID" : name.replace(/^MODEL_/u, "JUDGE_")
        ] = value;
      }
      expect(load(root, judgeEnvironment).judge).toBeDefined();
      expect(() =>
        load(root, {
          ...judgeEnvironment,
          JUDGE_BASE_URL: "https://models.example.test/v1?api-version=1",
        }),
      ).toThrow("- JUDGE_BASE_URL: must not carry a query string");
    });

    it("loads a plain endpoint with a path on a profile slot (control)", async () => {
      const root = await profileRoot();
      const config = load(root, { MODEL_BASE_URL: "https://models.example.test/deploy/v1" });
      expect(config.model.baseUrl).toBe("https://models.example.test/deploy/v1");
      expect(config.model.modelSettings?.settings.baseUrl).toMatchObject({
        value: "https://models.example.test/deploy/v1",
        source: "environment",
      });
    });
  });

  it("keeps the slot's settings block when setup --profile selects another preset", async () => {
    const root = await splitRoot({
      preset: QWEN,
      settings: ["maxOutputTokens: 65536", "reasoningEffort: high"],
    });
    process.env.DOCSFAB_CONFIG_ROOT = root;
    process.env.HOME = root;
    process.env.MODEL_API_KEY = KEY;
    await runSetupBootstrap({ profile: SONNET, environment: process.env });
    const host = decodeHostConfig(parseYaml(await readFile(join(root, "host.yaml"), "utf8")));
    expect(host.active?.writing?.compositionId).toBe(SONNET);
    expect(host.active?.writing?.settings).toEqual({
      maxOutputTokens: 65536,
      reasoningEffort: "high",
    });
  });
});
