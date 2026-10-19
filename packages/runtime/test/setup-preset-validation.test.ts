// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { handleSetupCommand, SETUP_USAGE } from "../src/cli/commands/setup.js";
import { ModelCompositionError } from "../src/model-composition/types.js";
import {
  formatSetupBootstrapResult,
  formatSetupBootstrapResultDetailed,
  type SetupBootstrapResult,
} from "../src/setup/bootstrap.js";
import {
  normalizeSetupEndpointUrl,
  resolveInstalledPresetForEndpoint,
  resolveSetupPreset,
} from "../src/setup/split-layout-presets.js";
import { EXECUTABLE_ROUTE_BASE_URLS } from "../src/config/executable-route-urls.js";

const HUB_BASE_URL = EXECUTABLE_ROUTE_BASE_URLS["nvidia-inference-api"];

describe("setup preset validation", () => {
  it("prints setup-specific help without starting configuration", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await handleSetupCommand(["--help"]);
      expect(log).toHaveBeenCalledWith(SETUP_USAGE);
      expect(SETUP_USAGE).toContain("provider, model, applicable endpoint/API");
      expect(SETUP_USAGE).toContain("required hidden API key");
      expect(SETUP_USAGE).toContain("--verbose");
      expect(SETUP_USAGE).toContain("--profile <id>");
    } finally {
      log.mockRestore();
    }
  });

  it("prints a concise setup summary and keeps bootstrap diagnostics under --verbose", () => {
    const result: SetupBootstrapResult = {
      schemaVersion: 1,
      kind: "docsfab-setup-bootstrap",
      status: "ready",
      configurationRoot: "/tmp/docsfab-config",
      layout: "split",
      hostConfigPath: "/tmp/docsfab-config/host.yaml",
      secretsPath: "/tmp/docsfab-config/secrets.env",
      envPath: "/tmp/docsfab-config/.env",
      activePolicyProfile: "profiles/operating-agent.yaml",
      seeded: true,
      migrated: false,
      credentialSource: "ambient",
      profile: {
        providerId: "nvidia-inference-api",
        modelId: "azure/openai/gpt-6-sol",
        endpointUrl: HUB_BASE_URL,
        requestUrl: `${HUB_BASE_URL}/chat/completions`,
        configuredContextWindow: 524_288,
        effectiveContextWindow: 524_288,
        effectiveLimitReason: "none",
      },
      nextCommand: "docsfab doctor",
      explanation: "The host policy profile can use its configured context limits.",
    };

    const concise = formatSetupBootstrapResult(result);
    expect(concise).toContain("DocsFab setup complete");
    expect(concise).toContain("Status: Ready");
    expect(concise).toContain("Model: azure/openai/gpt-6-sol");
    expect(concise).toContain("Provider: nvidia-inference-api");
    expect(concise).toContain(`Endpoint: ${HUB_BASE_URL}`);
    expect(concise).toContain(`Request URL: ${HUB_BASE_URL}/chat/completions`);
    expect(concise).toContain("Context limit: 524,288 tokens");
    expect(concise).toContain("API key: Saved in /tmp/docsfab-config/secrets.env (value hidden)");
    expect(concise).toContain("Configuration: /tmp/docsfab-config");
    expect(concise).toContain(
      "Connection check: Not run. Setup only validated the local configuration.",
    );
    expect(concise).toContain("Next step: docsfab doctor");
    expect(concise).not.toContain("Effective limit reason");
    expect(concise).toContain("Materialized");
    expect(formatSetupBootstrapResultDetailed(result)).toContain("Layout: split");
    expect(formatSetupBootstrapResultDetailed(result)).toContain(
      "Active policy profile: profiles/operating-agent.yaml",
    );
    expect(formatSetupBootstrapResultDetailed(result)).toContain(`Endpoint: ${HUB_BASE_URL}`);
    expect(formatSetupBootstrapResultDetailed(result)).toContain("Materialized");
    expect(formatSetupBootstrapResultDetailed(result)).toContain("Effective limit reason: none");

    const fallback = {
      ...result,
      profile: {
        ...result.profile!,
        effectiveContextWindow: 8_192,
        effectiveLimitReason: "metadata-unknown" as const,
      },
      explanation: "Internal profile explanation that is available only in verbose output.",
    };
    expect(formatSetupBootstrapResult(fallback)).toContain(
      "Note: Model metadata is unattested. Unique installed-composition matches use that composition's window.",
    );
    expect(formatSetupBootstrapResult(fallback)).not.toContain("Internal profile explanation");
    expect(formatSetupBootstrapResultDetailed(fallback)).toContain("Internal profile explanation");
  });

  it("rejects combining setup JSON and verbose output", async () => {
    await expect(handleSetupCommand(["--json", "--verbose"])).rejects.toThrow(
      'options "--json" and "--verbose" cannot be combined',
    );
  });

  it("accepts closed preset ids", () => {
    expect(resolveSetupPreset("nvidia/nvidia/nemotron-3-super-v3")).toBe(
      "nvidia/nvidia/nemotron-3-super-v3",
    );
    expect(resolveSetupPreset("nvidia/moonshotai/kimi-k2.6")).toBe("nvidia/moonshotai/kimi-k2.6");
    expect(resolveSetupPreset(undefined)).toBeUndefined();
  });

  it("refuses retired GPT-5.x preset ids with composition-retired", () => {
    for (const [preset, family] of [
      ["switchyard/openai/gpt-5.6-sol", "GPT-5.6"],
      ["gpt-5.6-sol", "GPT-5.6"],
      ["azure/openai/gpt-5.4", "GPT-5.4"],
    ] as const) {
      let thrown: unknown;
      try {
        resolveSetupPreset(preset);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ModelCompositionError);
      expect(thrown).toMatchObject({
        code: "composition-retired",
        nextAction: `${family} is retired; run \`docsfab setup --profile nvidia-inference-gpt-6-sol-pi\` to move to GPT-6 Sol with \`MODEL_API_KEY\`, or choose another model with \`docsfab setup\` in a terminal.`,
      });
    }
  });

  it("rejects unknown preset ids", () => {
    expect(() => resolveSetupPreset("switchyard/openai/gpt-5.6-terra")).toThrow(
      /unknown --preset/u,
    );
  });

  it("matches installed model and endpoint pairs without inferring a route from either alone", () => {
    expect(
      resolveInstalledPresetForEndpoint({
        modelId: "nvidia/nvidia/nemotron-3-super-v3",
        baseUrl: `${HUB_BASE_URL}/`,
      }),
    ).toBe("nvidia/nvidia/nemotron-3-super-v3");
    expect(
      resolveInstalledPresetForEndpoint({
        modelId: "nvidia/nvidia/nemotron-3-super-v3",
        baseUrl: "https://integrate.api.nvidia.com/v1",
      }),
    ).toBeUndefined();
    expect(
      resolveInstalledPresetForEndpoint({
        modelId: "switchyard/openai/gpt-5.6-sol",
        baseUrl: HUB_BASE_URL,
      }),
    ).toBeUndefined();
    expect(
      resolveInstalledPresetForEndpoint({
        modelId: "custom/model",
        baseUrl: HUB_BASE_URL,
      }),
    ).toBeUndefined();
  });

  it("accepts HTTP endpoints but rejects URLs that can carry credentials or ambiguous routing", () => {
    expect(normalizeSetupEndpointUrl("http://127.0.0.1:8000/v1/")).toBe("http://127.0.0.1:8000/v1");
    expect(() => normalizeSetupEndpointUrl("https://user:secret@example.test/v1")).toThrow(
      /without credentials/u,
    );
    expect(() => normalizeSetupEndpointUrl("https://example.test/v1?route=other")).toThrow(
      /query parameters/u,
    );
  });
});
