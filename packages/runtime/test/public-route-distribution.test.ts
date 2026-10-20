// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

vi.mock("../src/config/private-route-urls.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config/private-route-urls.js")>()),
  PRIVATE_EXECUTABLE_ROUTE_BASE_URLS: Object.freeze({}),
}));

import { launch } from "../src/launcher.js";
import {
  EXECUTABLE_ROUTE_BASE_URLS,
  EXECUTABLE_ROUTE_ORIGINS,
  isExecutableRouteOrigin,
} from "../src/config/executable-route-urls.js";
import { projectExecutionProfileIntoEnvironment } from "../src/config/execution-profile.js";
import { isProbeableRouteId, runProfileProbe } from "../src/cli/profile-probe.js";
import {
  NVIDIA_INFERENCE_CATALOG_ORIGIN,
  resolveModelCatalogAdapterSet,
} from "../src/model/catalog-serving-route.js";
import {
  NVIDIA_INFERENCE_CATALOG_ENDPOINT,
  discoverNvidiaInferenceModelCatalog,
} from "../src/model/nvidia-inference-catalog.js";
import {
  CLOSED_EVAL_PRESET_IDS,
  PROFILE_SEED_PRESET_IDS,
  resolveEvalPresetFieldBlock,
  resolveProfileSeedPreset,
} from "../src/model/profile-apply/eval-presets.js";
import { runSetupBootstrap } from "../src/setup/bootstrap.js";
import { temporaryRoots } from "./helpers/temp.js";
import { validModelConfig } from "./helpers.js";

const roots = temporaryRoots();

describe("a distribution without private route defaults", () => {
  it("starts the actual launcher and keeps the working public route origins", async () => {
    const printed = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await expect(launch([])).resolves.toBeUndefined();
      expect(printed).toHaveBeenCalled();
    } finally {
      printed.mockRestore();
    }
    expect(EXECUTABLE_ROUTE_BASE_URLS["nvidia-inference-api"]).toBeUndefined();
    expect([...EXECUTABLE_ROUTE_ORIGINS]).toEqual([
      "https://integrate.api.nvidia.com",
      "https://api.openai.com",
      "https://api.anthropic.com",
    ]);
    expect(NVIDIA_INFERENCE_CATALOG_ORIGIN).toBeUndefined();
    expect(NVIDIA_INFERENCE_CATALOG_ENDPOINT).toBeUndefined();
    expect(isExecutableRouteOrigin("nvidia-inference-api", "https://elsewhere.example.test")).toBe(
      false,
    );
  });

  it("keeps public provider catalog adapters and a public executable profile usable", () => {
    expect(
      resolveModelCatalogAdapterSet({
        providerId: "openai-api",
        baseUrl: "https://api.openai.com/v1",
      }),
    ).toBe("openai-api");
    expect(
      resolveModelCatalogAdapterSet({
        providerId: "anthropic-api",
        baseUrl: "https://api.anthropic.com/v1",
      }),
    ).toBe("anthropic-api");
    const environment: NodeJS.ProcessEnv = {};
    projectExecutionProfileIntoEnvironment("anthropic-claude-opus-4.7-pi", environment);
    expect(environment.MODEL_BASE_URL).toBe("https://api.anthropic.com/v1");
    expect(() =>
      projectExecutionProfileIntoEnvironment("nvidia-inference-gpt-6-sol-pi", {}),
    ).toThrow(/no default endpoint.*docsfab setup/u);
  });

  it("offers only available preset routes and resolves public preset fields", () => {
    expect(CLOSED_EVAL_PRESET_IDS).toEqual(["nvidia/llama-3.3-nemotron-super-49b-v1.5"]);
    expect(PROFILE_SEED_PRESET_IDS).toEqual(CLOSED_EVAL_PRESET_IDS);
    expect(
      new Map(resolveEvalPresetFieldBlock(CLOSED_EVAL_PRESET_IDS[0]).assignments).get(
        "MODEL_BASE_URL",
      ),
    ).toBe("https://integrate.api.nvidia.com/v1");
    expect(() => resolveProfileSeedPreset("azure/openai/gpt-6-sol")).toThrow(
      /no default endpoint.*docsfab setup/u,
    );
  });

  it("refuses private catalog discovery before reading a credential or sending a request", async () => {
    const readCredential = vi.fn(() => {
      throw new Error("credential-bearing input must not be read");
    });
    const fetch = vi.fn();
    await expect(
      discoverNvidiaInferenceModelCatalog({
        config: {
          ...validModelConfig,
          baseUrl: "https://elsewhere.example.test/v1",
          get apiKey() {
            return readCredential();
          },
        },
        purpose: "policy",
        fetch,
      }),
    ).rejects.toMatchObject({ code: "invalid-configuration" });
    expect(readCredential).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses unavailable private probes before looking up credentials", async () => {
    const readCredential = vi.fn(() => {
      throw new Error("credentials must not be read");
    });
    expect(isProbeableRouteId("nvidia-inference-api")).toBe(false);
    expect(isProbeableRouteId("nvidia-api-catalog")).toBe(true);
    await expect(
      runProfileProbe(
        { routeId: "nvidia-inference-api", modelId: "synthetic-model", live: true, json: false },
        { environment: new Proxy({}, { get: readCredential }) },
      ),
    ).rejects.toThrow(/unknown serving route/u);
    expect(readCredential).not.toHaveBeenCalled();
  });

  it.each([
    {
      provider: "openai" as const,
      credential: "OPENAI_API_KEY",
      modelId: "synthetic-public-model",
      baseUrl: "https://api.openai.com/v1",
    },
    {
      provider: "anthropic" as const,
      credential: "ANTHROPIC_API_KEY",
      modelId: "synthetic-public-model",
      baseUrl: "https://api.anthropic.com",
    },
    {
      provider: "openai-compatible" as const,
      credential: "COMPATIBLE_API_KEY",
      modelId: "synthetic-public-model",
      baseUrl: "https://integrate.api.nvidia.com/v1",
    },
  ])(
    "sets up the supported public $provider provider without private route data",
    async ({ credential, ...model }) => {
      const configurationRoot = await roots.create("docsfab-public-route-setup-");
      const result = await runSetupBootstrap({
        model,
        environment: {
          DOCSFAB_CONFIG_ROOT: configurationRoot,
          [credential]: "synthetic-provider-value",
        },
      });
      expect(result.status).toBe("ready");
      expect(result.profile?.modelId).toBe(model.modelId);
    },
  );
});
