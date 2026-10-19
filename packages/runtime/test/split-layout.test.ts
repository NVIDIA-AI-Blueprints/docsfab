// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadDocsFabEnvironment } from "../src/config/host-paths.js";
import { resolveDocsFabConfigurationRoot } from "../src/config/host-paths.js";
import {
  HOST_CONFIG_FILE,
  migrateMonolithicEnvToSplitLayout,
  SECRETS_ENV_FILE,
  usesSplitLayout,
} from "../src/config/split-layout.js";
import { loadConfig } from "../src/config/runtime-loader.js";
import { ModelCompositionError } from "../src/model-composition/types.js";
import {
  CONSERVATIVE_MODEL_FALLBACK,
  loadModelConfigurations,
} from "../src/model/configuration.js";
import { formatSetupBootstrapResult, runSetupBootstrap } from "../src/setup/bootstrap.js";
import { sealedCompositionContextWindow } from "./helpers/installed-composition-limits.js";
import { temporaryRoots } from "./helpers/temp.js";
import { EXECUTABLE_ROUTE_BASE_URLS } from "../src/config/executable-route-urls.js";

const HUB_BASE_URL = EXECUTABLE_ROUTE_BASE_URLS["nvidia-inference-api"];

const temporary = temporaryRoots();

/**
 * Historical GPT-5.4 operator attestation an existing host profile carries.
 * Inlined because setup no longer exports GPT-5.x attestations (#1512); a raw
 * GPT-5.4 profile still loads, only the GPT-5.4 setup preset is retired.
 */
const GPT_54_OPERATOR_ATTESTATION = {
  MODEL_PROFILE_APPROVED_SOURCE:
    "https://inference-backend.example.com/api/v1/models?search=gpt-5.4",
  MODEL_PROFILE_EFFECTIVE_DATE: "2026-08-04",
  MODEL_PROFILE_REVIEW_AFTER: "2026-12-31",
} as const;
const restored = new Map<string, string | undefined>();

afterEach(async () => {
  for (const [key, value] of restored.entries()) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  restored.clear();
});

function remember(key: string): void {
  if (!restored.has(key)) restored.set(key, process.env[key]);
}

const MODEL_ENV_KEYS = [
  "MODEL_PROVIDER",
  "MODEL_BASE_URL",
  "MODEL_ID",
  "MODEL_API_FORMAT",
  "MODEL_API_KEY",
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

function isolateHostEnvironment(): void {
  remember("DOCSFAB_CONFIG_ROOT");
  for (const key of MODEL_ENV_KEYS) {
    remember(key);
    delete process.env[key];
  }
}

async function writeLegacyUnknownMetadataEnv(
  root: string,
  fields: {
    modelId: string;
    provider: string;
    contextWindow: string;
    maxOutputTokens: string;
    baseUrl?: string;
  },
): Promise<void> {
  const legacy = [
    `MODEL_PROVIDER=${fields.provider}`,
    `MODEL_BASE_URL=${fields.baseUrl ?? HUB_BASE_URL}`,
    `MODEL_ID=${fields.modelId}`,
    "MODEL_API_FORMAT=chat_completions",
    "MODEL_API_KEY=sk-legacy-key",
    `MODEL_CONTEXT_WINDOW=${fields.contextWindow}`,
    `MODEL_MAX_INPUT_TOKENS=${fields.contextWindow}`,
    `MODEL_MAX_OUTPUT_TOKENS=${fields.maxOutputTokens}`,
    "MODEL_API_MIN_OUTPUT_TOKENS=16",
    "MODEL_CONTEXT_RESERVE_TOKENS=4096",
    "MODEL_REASONING=true",
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
  ].join("\n");
  await writeFile(join(root, ".env"), legacy, { mode: 0o600 });
  await chmod(join(root, ".env"), 0o600);
}

describe("split host configuration layout", () => {
  it("loads host.yaml, profile yaml, and secrets.env into process environment", async () => {
    const root = await temporary.create("docsfab-split-load-");
    remember("DOCSFAB_CONFIG_ROOT");
    process.env.DOCSFAB_CONFIG_ROOT = root;

    await mkdir(join(root, "profiles"), { recursive: true });
    await writeFile(
      join(root, HOST_CONFIG_FILE),
      [
        "schemaVersion: 1",
        "kind: docsfab-host-config",
        "activePolicyProfile: profiles/operating-agent.yaml",
        "paths:",
        "  stateDir: ./.docsfab/runs",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    await writeFile(
      join(root, "profiles", "operating-agent.yaml"),
      [
        "schemaVersion: 1",
        "kind: docsfab-model-profile",
        "slot: policy",
        "provider: nvidia-inference-api",
        `baseUrl: ${HUB_BASE_URL}`,
        "modelId: azure/openai/gpt-5.4",
        "apiFormat: chat_completions",
        "contextWindow: 1000000",
        "maxInputTokens: 1000000",
        "maxOutputTokens: 128000",
        "apiMinOutputTokens: 16",
        "contextReserveTokens: 4096",
        "reasoning: true",
        "inputTypes: text",
        "supportsDeveloperRole: false",
        "supportsReasoningEffort: false",
        "compatibleApiFormats: chat_completions",
        "inputCostPerMillion: unknown",
        "outputCostPerMillion: unknown",
        "cacheReadCostPerMillion: unknown",
        "cacheWriteCostPerMillion: unknown",
        `profileApprovedSource: ${GPT_54_OPERATOR_ATTESTATION.MODEL_PROFILE_APPROVED_SOURCE}`,
        `profileEffectiveDate: "${GPT_54_OPERATOR_ATTESTATION.MODEL_PROFILE_EFFECTIVE_DATE}"`,
        `profileReviewAfter: "${GPT_54_OPERATOR_ATTESTATION.MODEL_PROFILE_REVIEW_AFTER}"`,
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    await writeFile(join(root, SECRETS_ENV_FILE), "MODEL_API_KEY=sk-test-key\n", { mode: 0o600 });

    for (const key of [
      "MODEL_PROVIDER",
      "MODEL_ID",
      "MODEL_API_KEY",
      "DOCSFAB_STATE_DIR",
    ] as const) {
      remember(key);
      delete process.env[key];
    }

    loadDocsFabEnvironment(process.env);
    const { model } = loadModelConfigurations(process.env);
    expect(process.env.MODEL_PROVIDER).toBe("nvidia-inference-api");
    expect(process.env.MODEL_ID).toBe("azure/openai/gpt-5.4");
    expect(process.env.MODEL_API_KEY).toBe("sk-test-key");
    expect(process.env.DOCSFAB_STATE_DIR).toBe(join(root, ".docsfab", "runs"));
    expect(model.profile.effectiveLimitReason).toBe("none");
    expect(model.profile.contextWindow).toBe(1_000_000);

    const previewState = join(root, "preview", "runs");
    process.env.DOCSFAB_STATE_DIR = previewState;
    loadDocsFabEnvironment(process.env);
    expect(loadConfig().stateDirectory).toBe(previewState);
  });

  it("materializes split layout and switches presets without monolithic seed conflicts", async () => {
    const root = await temporary.create("docsfab-split-setup-");
    remember("DOCSFAB_CONFIG_ROOT");
    remember("MODEL_API_KEY");
    process.env.DOCSFAB_CONFIG_ROOT = root;
    process.env.MODEL_API_KEY = "sk-test-key";

    const initial = await runSetupBootstrap({
      profile: "nvidia-inference-gpt-6-sol-pi",
      environment: process.env,
    });
    expect(initial.layout).toBe("split");
    expect(initial.seeded).toBe(true);
    expect(initial.status).toBe("ready");
    expect(initial.activeExecutionProfile).toBe("nvidia-inference-gpt-6-sol-pi");
    expect(initial.profile?.modelId).toBe("azure/openai/gpt-6-sol");
    expect(usesSplitLayout(root)).toBe(true);

    const switched = await runSetupBootstrap({
      preset: "nvidia/nvidia/nemotron-3-super-v3",
      environment: process.env,
    });
    expect(switched.status).toBe("ready");
    expect(switched.activePolicyProfile).toBe("profiles/nvidia-nemotron-3-super-v3.yaml");
    expect(switched.profile?.effectiveLimitReason).toBe("composition-candidate");
    expect(switched.profile?.effectiveContextWindow).toBeGreaterThan(8_192);
    const host = await readFile(join(root, HOST_CONFIG_FILE), "utf8");
    expect(host).toContain("profiles/nvidia-nemotron-3-super-v3.yaml");
    const profile = await readFile(
      join(root, "profiles", "nvidia-nemotron-3-super-v3.yaml"),
      "utf8",
    );
    expect(profile).toContain("modelId: nvidia/nvidia/nemotron-3-super-v3");
  });

  it("keeps installed assets and run state independent of the working directory", async () => {
    const root = await temporary.create("docsfab-split-cwd-");
    remember("DOCSFAB_CONFIG_ROOT");
    remember("MODEL_API_KEY");
    remember("DOCSFAB_SKILL_CRATE_DIR");
    remember("DOCSFAB_QUALITY_DIR");
    remember("DOCSFAB_QUALITY_PACK_DIR");
    remember("DOCSFAB_STATE_DIR");
    delete process.env.DOCSFAB_SKILL_CRATE_DIR;
    delete process.env.DOCSFAB_QUALITY_DIR;
    delete process.env.DOCSFAB_QUALITY_PACK_DIR;
    delete process.env.DOCSFAB_STATE_DIR;
    process.env.DOCSFAB_CONFIG_ROOT = root;
    process.env.MODEL_API_KEY = "sk-test-key";

    await runSetupBootstrap({
      profile: "nvidia-inference-gpt-6-sol-pi",
      environment: process.env,
    });

    const config = loadConfig(process.env);
    expect(config.skillCrateDirectory).toBe(join(config.projectRoot, "skill-crate"));
    expect(config.qualityDirectory).toBe(join(config.projectRoot, "quality"));
    expect(config.qualityPackDirectory).toBe(join(config.projectRoot, "quality-pack"));
    expect(config.stateDirectory).toBe(join(root, ".docsfab", "runs"));
  });

  it("migrates a monolithic .env into split layout and keeps a legacy backup", async () => {
    const root = await temporary.create("docsfab-split-migrate-");
    remember("DOCSFAB_CONFIG_ROOT");
    process.env.DOCSFAB_CONFIG_ROOT = root;

    const legacy = [
      "MODEL_PROVIDER=nvidia-inference-api",
      `MODEL_BASE_URL=${HUB_BASE_URL}`,
      "MODEL_ID=azure/openai/gpt-5.4",
      "MODEL_API_FORMAT=chat_completions",
      "MODEL_API_KEY=sk-migrated",
      "MODEL_CONTEXT_WINDOW=1000000",
      "MODEL_MAX_INPUT_TOKENS=1000000",
      "MODEL_MAX_OUTPUT_TOKENS=128000",
      "MODEL_API_MIN_OUTPUT_TOKENS=16",
      "MODEL_CONTEXT_RESERVE_TOKENS=4096",
      "MODEL_REASONING=true",
      "MODEL_INPUT_TYPES=text",
      "MODEL_SUPPORTS_DEVELOPER_ROLE=false",
      "MODEL_SUPPORTS_REASONING_EFFORT=false",
      "MODEL_COMPATIBLE_API_FORMATS=chat_completions",
      "MODEL_INPUT_COST_PER_MILLION=unknown",
      "MODEL_OUTPUT_COST_PER_MILLION=unknown",
      "MODEL_CACHE_READ_COST_PER_MILLION=unknown",
      "MODEL_CACHE_WRITE_COST_PER_MILLION=unknown",
      `MODEL_PROFILE_APPROVED_SOURCE=${GPT_54_OPERATOR_ATTESTATION.MODEL_PROFILE_APPROVED_SOURCE}`,
      `MODEL_PROFILE_EFFECTIVE_DATE=${GPT_54_OPERATOR_ATTESTATION.MODEL_PROFILE_EFFECTIVE_DATE}`,
      `MODEL_PROFILE_REVIEW_AFTER=${GPT_54_OPERATOR_ATTESTATION.MODEL_PROFILE_REVIEW_AFTER}`,
      "",
    ].join("\n");
    await writeFile(join(root, ".env"), legacy, { mode: 0o600 });
    await chmod(join(root, ".env"), 0o600);

    const migration = await migrateMonolithicEnvToSplitLayout(root);
    expect(migration.legacyBackupPath.endsWith(".env.legacy")).toBe(true);
    expect(migration.policyRelative).toBe("profiles/azure-openai-gpt-5.4.yaml");
    expect(usesSplitLayout(root)).toBe(true);
    const secrets = await readFile(join(root, SECRETS_ENV_FILE), "utf8");
    expect(secrets).toContain("MODEL_API_KEY=sk-migrated");
  });

  it("defaults the configuration root to ~/.config/docsfab when unset", () => {
    remember("DOCSFAB_CONFIG_ROOT");
    delete process.env.DOCSFAB_CONFIG_ROOT;
    expect(resolveDocsFabConfigurationRoot(process.env)).toBe(
      join(homedir(), ".config", "docsfab"),
    );
  });

  it("rejects unknown setup presets before writing profile files", async () => {
    const root = await temporary.create("docsfab-split-unknown-preset-");
    remember("DOCSFAB_CONFIG_ROOT");
    remember("MODEL_API_KEY");
    process.env.DOCSFAB_CONFIG_ROOT = root;
    process.env.MODEL_API_KEY = "sk-test-key";

    await expect(
      runSetupBootstrap({ preset: "not-a-real-preset", environment: process.env }),
    ).rejects.toThrow(/unknown --preset/u);
    expect(usesSplitLayout(root)).toBe(false);
  });

  it("does not loop bare setup on a legacy host with unknown metadata", async () => {
    const root = await temporary.create("docsfab-legacy-unknown-");
    isolateHostEnvironment();
    process.env.DOCSFAB_CONFIG_ROOT = root;
    // An unmatched, current model: GPT-5.6 ids are retired and bare setup
    // would migrate them (#1512).
    await writeLegacyUnknownMetadataEnv(root, {
      modelId: "nvidia/meta/llama-3.3-70b-instruct",
      provider: "nvidia-inference-api",
      contextWindow: "128000",
      maxOutputTokens: "8192",
    });

    const configured = await runSetupBootstrap({ environment: process.env });
    expect(configured.layout).toBe("legacy");
    expect(configured.seeded).toBe(false);
    expect(configured.status).toBe("ready");
    expect(configured.profile?.effectiveLimitReason).toBe("metadata-unknown");
    expect(configured.profile?.contextAdmission).toBe("provider");
    expect(configured.profile?.effectiveContextWindow).toBe(128_000);
    expect(configured.nextCommand).toBe("docsfab doctor");
    expect(configured.explanation).toContain("does not invent a host context ceiling");
    expect(usesSplitLayout(root)).toBe(false);

    const repaired = await runSetupBootstrap({
      preset: "nvidia/nvidia/nemotron-3-super-v3",
      environment: process.env,
    });
    expect(repaired.layout).toBe("split");
    expect(repaired.seeded).toBe(true);
    expect(repaired.status).toBe("ready");
    expect(repaired.profile?.modelId).toBe("nvidia/nvidia/nemotron-3-super-v3");
    expect(repaired.profile?.effectiveLimitReason).toBe("composition-candidate");
    expect(repaired.profile?.effectiveContextWindow).toBe(
      await sealedCompositionContextWindow("nvidia-inference-nemotron-3-super-v3-pi"),
    );
    expect(usesSplitLayout(root)).toBe(true);
  });

  it("does not expose credentials embedded in a legacy endpoint URL", async () => {
    const root = await temporary.create("docsfab-legacy-sensitive-endpoint-");
    isolateHostEnvironment();
    process.env.DOCSFAB_CONFIG_ROOT = root;
    await writeLegacyUnknownMetadataEnv(root, {
      modelId: "legacy/model",
      provider: "legacy-provider",
      contextWindow: "128000",
      maxOutputTokens: "8192",
      baseUrl: "https://endpoint-user:endpoint-secret@models.example.test/v1",
    });

    const configured = await runSetupBootstrap({ environment: process.env });
    const rendered = formatSetupBootstrapResult(configured);
    // The endpoint shape rule refuses the user name and password by name.
    expect(configured.status).toBe("blocked-invalid-profile");
    expect(configured.profile?.endpointUrl).toBeUndefined();
    expect(rendered).not.toContain("endpoint-user");
    expect(rendered).not.toContain("endpoint-secret");
  });

  it("refuses a retired GPT-5.x preset on a legacy host before writing", async () => {
    const root = await temporary.create("docsfab-legacy-retired-preset-");
    isolateHostEnvironment();
    process.env.DOCSFAB_CONFIG_ROOT = root;
    await writeLegacyUnknownMetadataEnv(root, {
      modelId: "azure/openai/gpt-5.6-sol",
      provider: "nvidia-inference-api",
      contextWindow: "128000",
      maxOutputTokens: "8192",
    });
    const before = await readFile(join(root, ".env"), "utf8");

    for (const [preset, family] of [
      ["switchyard/openai/gpt-5.6-sol", "GPT-5.6"],
      ["gpt-5.6-sol", "GPT-5.6"],
      ["azure/openai/gpt-5.4", "GPT-5.4"],
    ] as const) {
      let thrown: unknown;
      try {
        await runSetupBootstrap({ preset, environment: process.env });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ModelCompositionError);
      expect(thrown).toMatchObject({
        code: "composition-retired",
        nextAction: `${family} is retired; run \`docsfab setup --profile nvidia-inference-gpt-6-sol-pi\` to move to GPT-6 Sol with \`MODEL_API_KEY\`, or choose another model with \`docsfab setup\` in a terminal.`,
      });
      expect(usesSplitLayout(root)).toBe(false);
      expect(await readFile(join(root, ".env"), "utf8")).toBe(before);
    }
  });

  it("honors --preset on a legacy host that already has a profile", async () => {
    const root = await temporary.create("docsfab-legacy-preset-honor-");
    isolateHostEnvironment();
    process.env.DOCSFAB_CONFIG_ROOT = root;
    await writeLegacyUnknownMetadataEnv(root, {
      modelId: "azure/openai/gpt-5.6-sol",
      provider: "nvidia-inference-api",
      contextWindow: "128000",
      maxOutputTokens: "8192",
    });

    const switched = await runSetupBootstrap({
      preset: "nvidia/moonshotai/kimi-k2.6",
      environment: process.env,
    });
    expect(switched.layout).toBe("split");
    expect(switched.seeded).toBe(true);
    expect(switched.activePolicyProfile).toBe("profiles/nvidia-moonshotai-kimi-k2.6.yaml");
    expect(switched.status).toBe("ready");
    expect(switched.profile?.modelId).toBe("nvidia/moonshotai/kimi-k2.6");
    expect(switched.profile?.effectiveContextWindow).toBe(128_000);
    expect(switched.nextCommand).toBe("docsfab doctor");
    const profile = await readFile(
      join(root, "profiles", "nvidia-moonshotai-kimi-k2.6.yaml"),
      "utf8",
    );
    expect(profile).toContain("modelId: nvidia/moonshotai/kimi-k2.6");
    expect(profile).not.toContain("azure/openai/gpt-5.6-sol");
    expect(profile).toContain("profileApprovedSource: unknown");
  });

  it("materializes a custom OpenAI-compatible endpoint without a DocsFab host ceiling", async () => {
    const root = await temporary.create("docsfab-custom-endpoint-");
    isolateHostEnvironment();
    process.env.DOCSFAB_CONFIG_ROOT = root;
    process.env.MODEL_API_KEY = "sk-custom-test";

    const configured = await runSetupBootstrap({
      model: {
        modelId: "acme/documentation-model",
        baseUrl: "https://models.example.test/v1/",
      },
      environment: process.env,
    });

    expect(configured.status).toBe("ready");
    expect(configured.activePolicyProfile).toBe("profiles/acme-documentation-model.yaml");
    expect(configured.profile?.modelId).toBe("acme/documentation-model");
    expect(configured.profile?.endpointUrl).toBe("https://models.example.test/v1");
    expect(configured.profile?.effectiveLimitReason).toBe("metadata-unknown");
    expect(configured.profile?.contextAdmission).toBe("provider");
    expect(configured.profile?.effectiveContextWindow).toBe(
      CONSERVATIVE_MODEL_FALLBACK.contextWindow,
    );
    const profile = await readFile(join(root, "profiles", "acme-documentation-model.yaml"), "utf8");
    expect(profile).toContain(`maxOutputTokens: ${CONSERVATIVE_MODEL_FALLBACK.maxOutputTokens}`);
    expect(profile).toContain("provider: operator-configured-openai-compatible");
    expect(profile).toContain("baseUrl: https://models.example.test/v1");
  });
});
