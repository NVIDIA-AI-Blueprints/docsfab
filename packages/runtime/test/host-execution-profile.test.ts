// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { parse as parseYaml } from "yaml";

import { afterEach, describe, expect, it } from "vitest";

import {
  decodeHostConfig,
  defaultExecutionHostConfig,
  defaultHostConfig,
  resolveHostExecutionProfileId,
  resolveHostYamlPolicyProfile,
} from "../src/config/profile-projection.js";
import { HOST_CONFIG_FILE } from "../src/config/split-layout.js";
import { loadConfig } from "../src/config/runtime-loader.js";
import { ModelCompositionError } from "../src/model-composition/types.js";
import { resolveOperatorExecutionBinding } from "../src/model/operator-execution-binding.js";
import { formatSetupBootstrapResult, runSetupBootstrap } from "../src/setup/bootstrap.js";
import { temporaryRoots } from "./helpers/temp.js";

const temporary = temporaryRoots();
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

function isolateHostEnvironment(): void {
  remember("DOCSFAB_CONFIG_ROOT");
  for (const key of [
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
    "DOCSFAB_ACTIVE_EXECUTION_PROFILE",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
  ] as const) {
    remember(key);
    delete process.env[key];
  }
}

const DIRECT_ANTHROPIC = "anthropic-claude-opus-4.7-pi";
const RETIRED = "nvidia-llama-3.3-nemotron-super-49b-v1.5-pi";
const RETIRED_OPENAI_SOL = "openai-gpt-5.6-sol-pi";
const RETIRED_OPENAI_SOL_PREFLIGHT = "openai-gpt-5.6-sol-codex-preflight";
const PREFLIGHT = "anthropic-claude-opus-4.7-claude-code-preflight";
const RETIRED_SWITCHYARD_SHORTCUT = "switchyard/openai/gpt-5.6-sol";
const GPT_56_RETIRED_NEXT_ACTION =
  "GPT-5.6 is retired; run `docsfab setup --profile nvidia-inference-gpt-6-sol-pi` to move to GPT-6 Sol with `MODEL_API_KEY`, or choose another model with `docsfab setup` in a terminal.";
const NVIDIA_CATALOG = "nvidia-nemotron-3.5-lightning-30b-a3b-pi";

describe("host execution profile selection by compositionId", () => {
  it("setup --profile does not copy eval-preset YAML MODEL_* field blocks", async () => {
    const root = await temporary.create("docsfab-setup-profile-");
    isolateHostEnvironment();
    process.env.DOCSFAB_CONFIG_ROOT = root;
    process.env.MODEL_API_KEY = "sk-test-key";

    const result = await runSetupBootstrap({
      profile: DIRECT_ANTHROPIC,
      environment: process.env,
    });

    expect(result.status).toBe("ready");
    expect(result.activeExecutionProfile).toBe(DIRECT_ANTHROPIC);
    expect(result.requiredSecretNames).toEqual(["MODEL_API_KEY", "ANTHROPIC_API_KEY"]);
    expect(result.activePolicyProfile).toBeUndefined();
    const host = await readFile(join(root, HOST_CONFIG_FILE), "utf8");
    expect(host).toContain(`activeExecutionProfile: ${DIRECT_ANTHROPIC}`);
    expect(host).toContain(`compositionId: ${DIRECT_ANTHROPIC}`);
    expect(host).toContain("qualification: not-run");
    expect(host).not.toMatch(/MODEL_CONTEXT_WINDOW|MODEL_MAX_INPUT_TOKENS|MODEL_ID:/u);
    const files = await readdir(root);
    expect(files).not.toContain("profiles");
    const secrets = await readFile(join(root, "secrets.env"), "utf8");
    expect(secrets).toContain("MODEL_API_KEY=");
    expect(secrets).toContain("ANTHROPIC_API_KEY=");
    expect(formatSetupBootstrapResult(result)).toContain(`Execution profile: ${DIRECT_ANTHROPIC}`);
    expect(formatSetupBootstrapResult(result)).toContain(
      "Required secrets: MODEL_API_KEY, ANTHROPIC_API_KEY",
    );
  });

  it("does not substitute MODEL_API_KEY for a composition's differently named credential", async () => {
    const root = await temporary.create("docsfab-setup-profile-nvidia-");
    isolateHostEnvironment();
    remember("DOCSFAB_NVIDIA_API_KEY");
    delete process.env.DOCSFAB_NVIDIA_API_KEY;
    process.env.DOCSFAB_CONFIG_ROOT = root;
    process.env.MODEL_API_KEY = "sk-test-key";

    const result = await runSetupBootstrap({
      profile: NVIDIA_CATALOG,
      environment: process.env,
    });

    // The nvidia-api-catalog route declares exactly one credential source,
    // DOCSFAB_NVIDIA_API_KEY. MODEL_API_KEY is not a stand-in: that would forward
    // a credential to a route never confirmed for it. This mirrors
    // resolveCompositionCredential in model/operator-execution-binding.ts.
    expect(result.requiredSecretNames).toEqual(["DOCSFAB_NVIDIA_API_KEY"]);
    expect(result.credentialSource).toBe("none");
    expect(result.status).toBe("blocked-missing-credential");
    expect(result.explanation).toContain("DOCSFAB_NVIDIA_API_KEY");
    const secrets = await readFile(join(root, "secrets.env"), "utf8");
    const nvidiaLine = secrets
      .split("\n")
      .find((line) => line.startsWith("DOCSFAB_NVIDIA_API_KEY="));
    expect(nvidiaLine).toBe("DOCSFAB_NVIDIA_API_KEY=");
    expect(secrets).toContain("MODEL_API_KEY=sk-test-key");
  });

  it("rerunning setup without --profile does not substitute MODEL_API_KEY for a retained execution profile's differently named credential", async () => {
    const root = await temporary.create("docsfab-setup-rerun-nvidia-");
    isolateHostEnvironment();
    remember("DOCSFAB_NVIDIA_API_KEY");
    delete process.env.DOCSFAB_NVIDIA_API_KEY;
    process.env.DOCSFAB_CONFIG_ROOT = root;

    // Establish an active split-layout profile as `docsfab setup --profile
    // nvidia-...` would, with no credential set yet.
    const initial = await runSetupBootstrap({
      profile: NVIDIA_CATALOG,
      environment: process.env,
    });
    expect(initial.activeExecutionProfile).toBe(NVIDIA_CATALOG);
    const hostAfterInitial = await readFile(join(root, HOST_CONFIG_FILE), "utf8");
    expect(hostAfterInitial).toContain(`activeExecutionProfile: ${NVIDIA_CATALOG}`);
    expect(hostAfterInitial).not.toMatch(/activePolicyProfile:/u);

    // Rerun setup with no --profile/--preset/--model. The active composition is
    // retained from host.yaml, with no YAML policy profile to read
    // selectedSecretNames from; only the generic MODEL_API_KEY is set.
    process.env.MODEL_API_KEY = "sk-test-key";

    const rerun = await runSetupBootstrap({ environment: process.env });

    // The rerun derives the requirement from the active composition with the
    // same exact-name rule as --profile and --model, so MODEL_API_KEY does not
    // satisfy it; the runtime never substitutes it for a declared source name.
    expect(rerun.activeExecutionProfile).toBe(NVIDIA_CATALOG);
    expect(rerun.requiredSecretNames).toEqual(["DOCSFAB_NVIDIA_API_KEY"]);
    expect(rerun.credentialSource).toBe("none");
    expect(rerun.status).toBe("blocked-missing-credential");
    expect(rerun.explanation).toContain("DOCSFAB_NVIDIA_API_KEY");
    const secrets = await readFile(join(root, "secrets.env"), "utf8");
    const nvidiaLine = secrets
      .split("\n")
      .find((line) => line.startsWith("DOCSFAB_NVIDIA_API_KEY="));
    expect(nvidiaLine).toBe("DOCSFAB_NVIDIA_API_KEY=");
  });

  it("loads activePolicyProfile as a compositionId alias during migration", () => {
    const host = decodeHostConfig({
      schemaVersion: 1,
      kind: "docsfab-host-config",
      activePolicyProfile: DIRECT_ANTHROPIC,
    });
    expect(resolveHostExecutionProfileId(host)).toBe(DIRECT_ANTHROPIC);
    expect(resolveHostYamlPolicyProfile(host)).toBeUndefined();
  });

  it("keeps YAML-only hosts working without an execution profile id", async () => {
    const root = await temporary.create("docsfab-yaml-only-");
    isolateHostEnvironment();
    process.env.DOCSFAB_CONFIG_ROOT = root;
    process.env.MODEL_API_KEY = "sk-test-key";

    const yaml = await runSetupBootstrap({
      preset: "nvidia/nvidia/nemotron-3-super-v3",
      environment: process.env,
    });
    expect(yaml.activePolicyProfile).toBe("profiles/nvidia-nemotron-3-super-v3.yaml");
    expect(yaml.activeExecutionProfile).toBeUndefined();
    const host = decodeHostConfig(parseYaml(await readFile(join(root, HOST_CONFIG_FILE), "utf8")));
    expect(resolveHostYamlPolicyProfile(host)).toBe("profiles/nvidia-nemotron-3-super-v3.yaml");
    expect(resolveHostExecutionProfileId(host)).toBeUndefined();

    const config = loadConfig(process.env);
    expect(config.model.modelId).toBe("nvidia/nvidia/nemotron-3-super-v3");
    const binding = await resolveOperatorExecutionBinding({
      model: config.model,
      environment: process.env,
    });
    expect(binding.match).toBe("installed-composition");
    expect(binding.bound?.composition.compositionId).toBe(
      "nvidia-inference-nemotron-3-super-v3-pi",
    );
  });

  it("binds setup --profile through the private loaded selection after load", async () => {
    const root = await temporary.create("docsfab-profile-bind-");
    isolateHostEnvironment();
    process.env.DOCSFAB_CONFIG_ROOT = root;
    process.env.MODEL_API_KEY = "sk-test-key";

    await runSetupBootstrap({ profile: DIRECT_ANTHROPIC, environment: process.env });
    const config = loadConfig(process.env);
    expect(process.env.DOCSFAB_ACTIVE_EXECUTION_PROFILE).toBeUndefined();
    expect(config.model.compositionId).toBe(DIRECT_ANTHROPIC);
    expect(config.model.providerId).toBe("anthropic-api");
    expect(config.model.modelId).toBe("claude-opus-4-7");
    const binding = await resolveOperatorExecutionBinding({
      model: config.model,
    });
    expect(binding.match).toBe("installed-composition");
    expect(binding.bound?.composition.compositionId).toBe(DIRECT_ANTHROPIC);
  });

  it("refuses the retired Switchyard GPT-5.6 shortcut as a --profile id before writing", async () => {
    const root = await temporary.create("docsfab-dogfood-profile-");
    isolateHostEnvironment();
    process.env.DOCSFAB_CONFIG_ROOT = root;
    process.env.MODEL_API_KEY = "sk-test-key";

    let thrown: unknown;
    try {
      await runSetupBootstrap({ profile: RETIRED_SWITCHYARD_SHORTCUT, environment: process.env });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ModelCompositionError);
    expect(thrown).toMatchObject({
      code: "composition-retired",
      nextAction: GPT_56_RETIRED_NEXT_ACTION,
    });
    expect(await readdir(root)).toEqual([]);
  });

  it("rejects retired and preflight-only compositions from setup --profile", async () => {
    await expect(runSetupBootstrap({ profile: RETIRED })).rejects.toThrow(/retired/u);
    await expect(runSetupBootstrap({ profile: RETIRED_OPENAI_SOL })).rejects.toMatchObject({
      code: "composition-retired",
      nextAction: expect.stringContaining("Select its successor, `nvidia-inference-gpt-6-sol-pi`"),
    });
    await expect(
      runSetupBootstrap({ profile: RETIRED_OPENAI_SOL_PREFLIGHT }),
    ).rejects.toMatchObject({
      code: "composition-retired",
      nextAction: expect.stringContaining(
        "Select its successor, `openai-gpt-6-sol-codex-preflight`",
      ),
    });
    await expect(runSetupBootstrap({ profile: PREFLIGHT })).rejects.toThrow(
      /not an executable composition/u,
    );
    await expect(runSetupBootstrap({ profile: "not-a-real-composition" })).rejects.toThrow(
      /executable installed composition id/u,
    );
  });

  it("refuses to combine setup --profile with --preset", async () => {
    await expect(
      runSetupBootstrap({
        profile: DIRECT_ANTHROPIC,
        preset: "nvidia/nvidia/nemotron-3-super-v3",
      }),
    ).rejects.toThrow(/either --profile or --preset/u);
  });

  it("writes defaultExecutionHostConfig without a YAML policy path", () => {
    const host = defaultExecutionHostConfig(DIRECT_ANTHROPIC);
    expect(host.activeExecutionProfile).toBe(DIRECT_ANTHROPIC);
    expect(host.compositionId).toBe(DIRECT_ANTHROPIC);
    expect(host.activePolicyProfile).toBeUndefined();
    expect(host.active?.writing?.compositionId).toBe(DIRECT_ANTHROPIC);
    expect(host.active?.writing?.qualification).toBe("not-run");
    expect(defaultHostConfig("profiles/operating-agent.yaml").activePolicyProfile).toBe(
      "profiles/operating-agent.yaml",
    );
  });
});
