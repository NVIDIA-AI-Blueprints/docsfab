// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { handleProfileCommand } from "../../cli/commands/profile.js";
import { parseProfileSeedArguments } from "../../cli/profile-arguments.js";
import { main } from "../../cli/router.js";
import { usage } from "../../cli/usage.js";
import { EXECUTABLE_ROUTE_BASE_URLS } from "../../config/executable-route-urls.js";
import { loadConfig } from "../../config/runtime-loader.js";
import { loadModelConfigurations } from "../configuration.js";
import { ModelCompositionError } from "../../model-composition/types.js";
import { toOperatorErrorEnvelope } from "../../operator/error-envelope.js";
import { situationRowForId } from "../../operator/situation-catalog.js";
import { detectCredentialRuleIds } from "../../security/repository-scanner.js";
import {
  CLOSED_EVAL_PRESET_IDS,
  PROFILE_SEED_PRESET_IDS,
  resolveEvalPresetFieldBlock,
} from "./eval-presets.js";
import { PROFILE_SEED_CHOICES, ProfileSeedChoiceRequiredError } from "./seed-choice.js";

// Spelled out rather than imported, so the operator contract is pinned
// independently of the source constants.
const INTERNAL_GPT_6_SOL_PRESET = "azure/openai/gpt-6-sol";
const PUBLIC_CATALOG_PRESET = "nvidia/llama-3.3-nemotron-super-49b-v1.5";
const CHOICE_REQUIRED = "profile-seed-choice-required";
const CHOICE_MESSAGE =
  "DocsFab profile seed has no default model. Name the model profile to write with --preset.";
const CHOICES =
  "Choose a model with `docsfab setup`, then enter MODEL_API_KEY through the hidden setup prompt.";
const INTERNAL_BASE_URL = EXECUTABLE_ROUTE_BASE_URLS["nvidia-inference-api"];
const originalArgv = process.argv;

const CLOSED_KEY = "sk-docsfabtestfixturekeyvaluexx";
const restored = new Map<string, string | undefined>();
const MODEL_ENV_KEYS = [
  "DOCSFAB_CONFIG_ROOT",
  "MODEL_API_KEY",
  "OPENAI_API_KEY",
  "MODEL_PROVIDER",
  "MODEL_BASE_URL",
  "MODEL_ID",
  "MODEL_API_FORMAT",
  "MODEL_CONTEXT_WINDOW",
  "MODEL_MAX_INPUT_TOKENS",
  "MODEL_MAX_OUTPUT_TOKENS",
  "MODEL_API_MIN_OUTPUT_TOKENS",
  "MODEL_CONTEXT_RESERVE_TOKENS",
  "MODEL_REASONING",
  "MODEL_INPUT_TYPES",
  "MODEL_SUPPORTS_DEVELOPER_ROLE",
  "MODEL_SUPPORTS_REASONING_EFFORT",
  "MODEL_COMPATIBLE_API_FORMATS",
  "MODEL_INPUT_COST_PER_MILLION",
  "MODEL_OUTPUT_COST_PER_MILLION",
  "MODEL_CACHE_READ_COST_PER_MILLION",
  "MODEL_CACHE_WRITE_COST_PER_MILLION",
  "MODEL_PROFILE_APPROVED_SOURCE",
  "MODEL_PROFILE_EFFECTIVE_DATE",
  "MODEL_PROFILE_REVIEW_AFTER",
] as const;

describe("unsigned profile seed", () => {
  afterEach(() => {
    process.argv = originalArgv;
    for (const [key, value] of restored) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    restored.clear();
  });

  it("names the seed command and refuses argv credentials", () => {
    expect(usage()).toContain("docsfab profile seed --preset <id> [--json]");
    expect(parseProfileSeedArguments(["--preset", INTERNAL_GPT_6_SOL_PRESET])).toEqual({
      preset: INTERNAL_GPT_6_SOL_PRESET,
      json: false,
    });
    expect(() => parseProfileSeedArguments(["--api-key", CLOSED_KEY])).toThrow(
      "Unknown profile command option.",
    );
  });

  it("acceptance:first-run-seed", async () => {
    const root = await realpath(await mkdtemp(resolve(tmpdir(), "docsfab-first-run-seed-")));
    await chmod(root, 0o700);
    const logs: string[] = [];
    const originalLog = console.log;
    try {
      isolateSeedEnvironment(root, CLOSED_KEY);
      console.log = (message?: unknown) => {
        logs.push(String(message ?? ""));
      };
      await handleProfileCommand(["seed", "--preset", INTERNAL_GPT_6_SOL_PRESET, "--json"]);
      const first = logs.join("\n");
      expect(first).not.toContain(CLOSED_KEY);
      expect(detectCredentialRuleIds(first)).toEqual([]);
      const receipt = JSON.parse(first) as {
        kind: string;
        applied: boolean;
        sha256: string;
        created: boolean;
        keySource: string;
        preview: { patch: { preset: string | null } };
      };
      expect(receipt.kind).toBe("docsfab-profile-seed-receipt");
      expect(receipt.applied).toBe(true);
      expect(receipt.created).toBe(true);
      expect(receipt.keySource).toBe("ambient");
      expect(receipt.preview.patch.preset).toBe(INTERNAL_GPT_6_SOL_PRESET);

      const dotenv = await readFile(resolve(root, ".env"), "utf8");
      expect(dotenv).toContain(`MODEL_API_KEY=${CLOSED_KEY}`);
      expect(dotenv).toContain("MODEL_ID=azure/openai/gpt-6-sol");
      expect(dotenv).toContain(`MODEL_BASE_URL=${INTERNAL_BASE_URL}`);
      expect(dotenv).toContain("MODEL_CONTEXT_WINDOW=524288");
      expect(dotenv).toContain("MODEL_MAX_INPUT_TOKENS=524288");
      expect(dotenv).toContain("MODEL_MAX_OUTPUT_TOKENS=128000");
      expect(dotenv).toContain("MODEL_API_MIN_OUTPUT_TOKENS=16");
      expect(dotenv).toContain("MODEL_CONTEXT_RESERVE_TOKENS=1024");
      expect(dotenv).toContain("MODEL_REASONING=false");
      expect(dotenv).toContain("MODEL_PROFILE_APPROVED_SOURCE=unknown");
      await expect(readFile(resolve(root, ".docsfab.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });

      const config = loadConfig();
      expect(config.model.providerId).toBe("nvidia-inference-api");
      expect(config.model.modelId).toBe("azure/openai/gpt-6-sol");
      expect(config.model.apiKey).toBe(CLOSED_KEY);

      logs.length = 0;
      await handleProfileCommand(["seed", "--preset", INTERNAL_GPT_6_SOL_PRESET, "--json"]);
      const second = logs.join("\n");
      expect(second).not.toContain(CLOSED_KEY);
      expect(detectCredentialRuleIds(second)).toEqual([]);
      const replay = JSON.parse(second) as { sha256: string; applied: boolean };
      expect(replay.sha256).toBe(receipt.sha256);
      expect(await readFile(resolve(root, ".env"), "utf8")).toBe(dotenv);
    } finally {
      console.log = originalLog;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a conflicting profile and unknown presets", async () => {
    const root = await realpath(await mkdtemp(resolve(tmpdir(), "docsfab-seed-conflict-")));
    await chmod(root, 0o700);
    try {
      isolateSeedEnvironment(root, CLOSED_KEY);
      await writeFile(resolve(root, ".env"), "MODEL_PROVIDER=other-provider\n", { mode: 0o600 });
      await expect(
        handleProfileCommand(["seed", "--preset", INTERNAL_GPT_6_SOL_PRESET]),
      ).rejects.toThrow(/conflicting MODEL profile/u);
      expect(() => parseProfileSeedArguments(["--api-key", CLOSED_KEY])).toThrow(
        "Unknown profile command option.",
      );
      isolateSeedEnvironment(root, CLOSED_KEY);
      const unknownIds = [
        "not-frozen",
        "azure/openai/gpt-5.6-sol",
        "azure/openai/gpt-5.4-mini",
        "azure/openai/gpt-5.6-terra",
        "azure/openai/gpt-5.6-luna",
        "nvidia/nvidia/nemotron-3.5-lightning",
        "nvidia/moonshotai/kimi-k3-high-preview",
        "nvidia/llama-3.3-nemotron-super-49b-v1",
        "claude-opus-4-7",
      ];
      for (const preset of unknownIds) {
        await expect(handleProfileCommand(["seed", "--preset", preset])).rejects.toThrow(
          /unknown --preset/u,
        );
        expect(() => resolveEvalPresetFieldBlock(preset)).toThrow(/unknown --preset/u);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("honors each named seed preset field block", async () => {
    expect(PROFILE_SEED_PRESET_IDS).toEqual([INTERNAL_GPT_6_SOL_PRESET, ...CLOSED_EVAL_PRESET_IDS]);
    for (const preset of PROFILE_SEED_PRESET_IDS) {
      const root = await realpath(await mkdtemp(resolve(tmpdir(), "docsfab-seed-preset-")));
      await chmod(root, 0o700);
      const logs: string[] = [];
      const originalLog = console.log;
      try {
        isolateSeedEnvironment(root, CLOSED_KEY);
        console.log = (message?: unknown) => {
          logs.push(String(message ?? ""));
        };
        await handleProfileCommand(["seed", "--preset", preset, "--json"]);
        const first = logs.join("\n");
        expect(first).not.toContain(CLOSED_KEY);
        expect(detectCredentialRuleIds(first)).toEqual([]);
        const receipt = JSON.parse(first) as {
          applied: boolean;
          created: boolean;
          sha256: string;
          preview: { patch: { preset: string | null } };
        };
        expect(receipt.applied).toBe(true);
        expect(receipt.created).toBe(true);
        expect(receipt.preview.patch.preset).toBe(preset);

        const dotenv = await readFile(resolve(root, ".env"), "utf8");
        expect(dotenv).toContain(`MODEL_ID=${preset}`);
        const loaded = loadModelConfigurations(dotenvToEnv(dotenv));
        expect(loaded.model.modelId).toBe(preset);
        expect(loaded.model.providerId).toBe(
          preset === PUBLIC_CATALOG_PRESET ? "nvidia-api-catalog" : "nvidia-inference-api",
        );

        logs.length = 0;
        await handleProfileCommand(["seed", "--preset", preset, "--json"]);
        const replay = JSON.parse(logs.join("\n")) as { sha256: string };
        expect(replay.sha256).toBe(receipt.sha256);
        expect(await readFile(resolve(root, ".env"), "utf8")).toBe(dotenv);
      } finally {
        console.log = originalLog;
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  it("refuses seed with no --preset through the CLI entry point and writes nothing", async () => {
    const parent = await realpath(await mkdtemp(resolve(tmpdir(), "docsfab-seed-choice-")));
    const root = resolve(parent, "config");
    const originalLog = console.log;
    const logs: string[] = [];
    try {
      console.log = (message?: unknown) => {
        logs.push(String(message ?? ""));
      };
      isolateSeedEnvironment(root, CLOSED_KEY);
      for (const argv of [
        ["profile", "seed"],
        ["profile", "seed", "--json"],
      ]) {
        process.argv = [originalArgv[0]!, originalArgv[1]!, ...argv];
        const refusal = await main().then(
          () => undefined,
          (error: unknown) => error,
        );
        expect(refusal).toBeInstanceOf(ProfileSeedChoiceRequiredError);
        expect(refusal).toMatchObject({
          code: CHOICE_REQUIRED,
          message: CHOICE_MESSAGE,
          nextAction: CHOICES,
        });
        expect(toOperatorErrorEnvelope(refusal)).toMatchObject({
          kind: "docsfab-operator-error",
          code: CHOICE_REQUIRED,
          message: CHOICE_MESSAGE,
          nextAction: CHOICES,
          docsAnchor: "docs/reference/status-and-configuration/model-profile-fields.md",
        });
        // The refusal comes before the config root is created or read.
        expect(existsSync(root)).toBe(false);
      }
      expect(logs).toEqual([]);
    } finally {
      console.log = originalLog;
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("leaves an existing config-root .env untouched when seed names no preset", async () => {
    const root = await realpath(await mkdtemp(resolve(tmpdir(), "docsfab-seed-choice-existing-")));
    await chmod(root, 0o700);
    try {
      isolateSeedEnvironment(root, CLOSED_KEY);
      const stored = `MODEL_API_KEY=${CLOSED_KEY}\n`;
      await writeFile(resolve(root, ".env"), stored, { mode: 0o600 });
      await expect(handleProfileCommand(["seed", "--json"])).rejects.toMatchObject({
        code: CHOICE_REQUIRED,
      });
      expect(await readFile(resolve(root, ".env"), "utf8")).toBe(stored);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("routes a missing seed choice to setup without repeating the failed command", () => {
    expect(PROFILE_SEED_CHOICES).toBe(CHOICES);
    expect(situationRowForId(CHOICE_REQUIRED)?.nextAction).toBe(PROFILE_SEED_CHOICES);
    expect(PROFILE_SEED_CHOICES).toContain("docsfab setup");
    expect(PROFILE_SEED_CHOICES).not.toContain("docsfab profile seed");
  });

  it("seeds GPT-6 Sol on the Inference Hub only when its preset is named", async () => {
    const root = await realpath(await mkdtemp(resolve(tmpdir(), "docsfab-seed-internal-")));
    await chmod(root, 0o700);
    const originalLog = console.log;
    try {
      console.log = () => undefined;
      isolateSeedEnvironment(root, CLOSED_KEY);
      process.argv = [
        originalArgv[0]!,
        originalArgv[1]!,
        "profile",
        "seed",
        "--preset",
        INTERNAL_GPT_6_SOL_PRESET,
        "--json",
      ];
      await main();
      const seeded = loadModelConfigurations(
        dotenvToEnv(await readFile(resolve(root, ".env"), "utf8")),
      );
      expect(seeded.model.providerId).toBe("nvidia-inference-api");
      expect(seeded.model.baseUrl).toBe(INTERNAL_BASE_URL);
      expect(seeded.model.modelId).toBe(INTERNAL_GPT_6_SOL_PRESET);
      expect(seeded.model.profile.contextWindow).toBe(524288);
      expect(seeded.model.profile.maxOutputTokens).toBe(128000);
    } finally {
      console.log = originalLog;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not treat an explicit public preset, an empty preset, or an unknown preset as a missing choice", async () => {
    const root = await realpath(await mkdtemp(resolve(tmpdir(), "docsfab-seed-adjacent-")));
    await chmod(root, 0o700);
    const originalLog = console.log;
    try {
      console.log = () => undefined;
      isolateSeedEnvironment(root, CLOSED_KEY);
      process.argv = [
        originalArgv[0]!,
        originalArgv[1]!,
        "profile",
        "seed",
        "--preset",
        PUBLIC_CATALOG_PRESET,
        "--json",
      ];
      await main();
      const seeded = loadModelConfigurations(
        dotenvToEnv(await readFile(resolve(root, ".env"), "utf8")),
      );
      expect(seeded.model.providerId).toBe("nvidia-api-catalog");
      expect(seeded.model.modelId).toBe(PUBLIC_CATALOG_PRESET);

      const empty = await handleProfileCommand(["seed", "--preset", " "]).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(empty).not.toBeInstanceOf(ProfileSeedChoiceRequiredError);
      expect((empty as Error).message).toBe(
        "profile seed requires a non-empty --preset identifier value.",
      );
      const unknown = await handleProfileCommand(["seed", "--preset", "not-frozen"]).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(unknown).not.toBeInstanceOf(ProfileSeedChoiceRequiredError);
      expect((unknown as Error).message).toBe(
        "profile seed received an unknown --preset identifier value.",
      );
    } finally {
      console.log = originalLog;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses retired GPT-5.x presets with composition-retired before writing", async () => {
    const root = await realpath(await mkdtemp(resolve(tmpdir(), "docsfab-seed-retired-")));
    await chmod(root, 0o700);
    const originalLog = console.log;
    const retired: ReadonlyArray<readonly [string, string]> = [
      ["switchyard/openai/gpt-5.6-sol", "GPT-5.6"],
      ["gpt-5.6-sol", "GPT-5.6"],
      ["azure/openai/gpt-5.4", "GPT-5.4"],
    ];
    try {
      console.log = () => undefined;
      isolateSeedEnvironment(root, CLOSED_KEY);
      for (const [preset, family] of retired) {
        const nextAction = `${family} is retired; run \`docsfab setup --profile nvidia-inference-gpt-6-sol-pi\` to move to GPT-6 Sol with \`MODEL_API_KEY\`, or choose another model with \`docsfab setup\` in a terminal.`;
        expect((CLOSED_EVAL_PRESET_IDS as readonly string[]).includes(preset)).toBe(false);
        let thrown: unknown;
        try {
          resolveEvalPresetFieldBlock(preset);
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(ModelCompositionError);
        expect(thrown).toMatchObject({ code: "composition-retired", nextAction });
        expect((thrown as Error).message).toContain(`Model selection "${preset}" is retired`);
        // The command handler refuses before writing, with the same named
        // refusal and remediation rather than a generic apply rejection.
        await expect(
          handleProfileCommand(["seed", "--preset", preset, "--json"]),
        ).rejects.toMatchObject({ code: "composition-retired", nextAction });
        await expect(readFile(resolve(root, ".env"))).rejects.toMatchObject({ code: "ENOENT" });
      }
    } finally {
      console.log = originalLog;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("admits a closed nvapi credential shape without lecturing", async () => {
    const root = await realpath(await mkdtemp(resolve(tmpdir(), "docsfab-seed-nvapi-")));
    await chmod(root, 0o700);
    const nvapi = "nvapi-docsfabtestfixturekeyvalxx";
    const logs: string[] = [];
    const originalLog = console.log;
    try {
      isolateSeedEnvironment(root, nvapi);
      console.log = (message?: unknown) => {
        logs.push(String(message ?? ""));
      };
      await handleProfileCommand(["seed", "--preset", INTERNAL_GPT_6_SOL_PRESET, "--json"]);
      expect(logs.join("\n")).not.toContain(nvapi);
      expect(detectCredentialRuleIds(logs.join("\n"))).toEqual([]);
      expect(loadConfig().model.apiKey).toBe(nvapi);
    } finally {
      console.log = originalLog;
      await rm(root, { recursive: true, force: true });
    }
  });
});

function isolateSeedEnvironment(root: string, apiKey: string): void {
  for (const key of MODEL_ENV_KEYS) {
    if (!restored.has(key)) restored.set(key, process.env[key]);
    delete process.env[key];
  }
  process.env.DOCSFAB_CONFIG_ROOT = root;
  process.env.MODEL_API_KEY = apiKey;
}

function dotenvToEnv(source: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const line of source.split(/\r\n|\n|\r/u)) {
    const match = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/u.exec(line);
    if (!match) continue;
    env[match[1]!] = match[2]!;
  }
  return env;
}
