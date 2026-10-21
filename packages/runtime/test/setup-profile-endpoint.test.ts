// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";

// Public installations omit private endpoint defaults. Exercise that product
// configuration without changing the checked-in internal composition registry.
vi.mock("../src/config/executable-route-urls.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/config/executable-route-urls.js")>();
  return {
    ...actual,
    EXECUTABLE_ROUTE_BASE_URLS: {
      ...actual.EXECUTABLE_ROUTE_BASE_URLS,
      "nvidia-inference-api": undefined,
    },
  };
});

import { parseSetupArguments } from "../src/cli/commands/setup.js";
import { loadConfig } from "../src/config/runtime-loader.js";
import { formatSetupBootstrapResult, runSetupBootstrap } from "../src/setup/bootstrap.js";
import { runInteractiveSetup } from "../src/setup/interactive.js";
import { temporaryRoots } from "./helpers/temp.js";

const roots = temporaryRoots();
const profile = "nvidia-inference-gpt-6-sol-pi";
const endpoint = "https://models.example.test/v1";
const placeholderKey = "profile-endpoint-placeholder-not-a-credential";

describe("installed composition endpoint setup", () => {
  it("accepts an endpoint with a profile while rejecting unrelated provider options", () => {
    expect(parseSetupArguments(["--profile", profile, "--endpoint", endpoint])).toMatchObject({
      profile,
      baseUrl: endpoint,
    });
    for (const args of [
      ["--endpoint", endpoint],
      ["--profile", profile, "--model", "other-model"],
      ["--profile", profile, "--api", "openai-responses"],
      ["--preset", "some-preset", "--endpoint", endpoint],
    ]) {
      expect(() => parseSetupArguments(args)).toThrow();
    }
  });

  it("names a missing endpoint and offers a command that can actually repair it", async () => {
    const root = await roots.create("docsfab-profile-no-endpoint-");
    const result = await runSetupBootstrap({
      profile,
      environment: { DOCSFAB_CONFIG_ROOT: root, MODEL_API_KEY: placeholderKey },
    });
    expect(result.status).toBe("blocked-missing-endpoint");
    expect(result.explanation).toMatch(/endpoint/iu);
    expect(result.nextCommand).toBe(
      `docsfab setup --profile ${profile} --endpoint <provider-base-url>`,
    );
    const human = formatSetupBootstrapResult(result);
    expect(human).toContain("Endpoint required");
    expect(human).toContain("--endpoint");
    expect(human).not.toContain("Configuration is invalid");
    expect(human).not.toContain(placeholderKey);
  });

  it("persists the endpoint without changing composition identity or requiring ambient settings on reload", async () => {
    const root = await roots.create("docsfab-profile-endpoint-");
    const result = await runSetupBootstrap({
      profile,
      baseUrl: endpoint,
      environment: { DOCSFAB_CONFIG_ROOT: root, MODEL_API_KEY: placeholderKey },
    });
    expect(result.status).toBe("ready");
    const hostPath = join(root, "host.yaml");
    const host = parseYaml(await readFile(hostPath, "utf8"));
    expect(host.active.writing).toMatchObject({
      compositionId: profile,
      settings: { baseUrl: endpoint },
    });
    expect(await readFile(hostPath, "utf8")).not.toContain(placeholderKey);
    const reloaded = loadConfig({ DOCSFAB_CONFIG_ROOT: root });
    expect(reloaded.model.baseUrl).toBe(endpoint);
    expect(reloaded.model.modelId).toBe("azure/openai/gpt-6-sol");
    expect(reloaded.model.apiKey).toBe(placeholderKey);
    expect(reloaded.model.profile.contextWindow).toBe(result.profile?.effectiveContextWindow);

    const before = await readFile(hostPath, "utf8");
    expect(
      (await runSetupBootstrap({ profile, environment: { DOCSFAB_CONFIG_ROOT: root } })).status,
    ).toBe("ready");
    expect(await readFile(hostPath, "utf8")).toBe(before);
  });

  it.each([
    "https://user:secret@models.example.test/v1",
    "http://models.example.test/v1",
    "https://models.example.test/v1?key=secret",
  ])("rejects unsafe endpoint %s before changing the configuration", async (baseUrl) => {
    const root = await roots.create("docsfab-profile-endpoint-invalid-");
    await expect(
      runSetupBootstrap({
        profile,
        baseUrl,
        environment: { DOCSFAB_CONFIG_ROOT: root, MODEL_API_KEY: placeholderKey },
      }),
    ).rejects.toThrow();
    expect(await readdir(root)).toEqual([]);
  });

  it("accepts the same explicit endpoint when profile setup runs in a terminal", async () => {
    const root = await roots.create("docsfab-profile-endpoint-interactive-");
    const result = await runInteractiveSetup({
      profile,
      baseUrl: endpoint,
      environment: { DOCSFAB_CONFIG_ROOT: root },
      prompter: {
        readChoice: vi.fn().mockRejectedValue(new Error("profile already selects the model")),
        readValue: vi.fn().mockRejectedValue(new Error("endpoint already supplied")),
        readSecret: async () => placeholderKey,
      },
    });
    expect(result.status).toBe("ready");
    expect(loadConfig({ DOCSFAB_CONFIG_ROOT: root }).model.baseUrl).toBe(endpoint);
  });

  it.each(["?", "#"])(
    "keeps a working root unchanged when an endpoint ends in %s",
    async (delimiter) => {
      const root = await roots.create("docsfab-profile-endpoint-preserve-");
      expect(
        (
          await runSetupBootstrap({
            profile,
            baseUrl: endpoint,
            environment: { DOCSFAB_CONFIG_ROOT: root, MODEL_API_KEY: placeholderKey },
          })
        ).status,
      ).toBe("ready");
      const hostPath = join(root, "host.yaml");
      const secretsPath = join(root, "secrets.env");
      const beforeHost = await readFile(hostPath, "utf8");
      const beforeSecrets = await readFile(secretsPath, "utf8");
      await expect(
        runSetupBootstrap({
          profile,
          baseUrl: `${endpoint}${delimiter}`,
          environment: { DOCSFAB_CONFIG_ROOT: root },
        }),
      ).rejects.toThrow();
      expect(await readFile(hostPath, "utf8")).toBe(beforeHost);
      expect(await readFile(secretsPath, "utf8")).toBe(beforeSecrets);
      expect(loadConfig({ DOCSFAB_CONFIG_ROOT: root }).model.baseUrl).toBe(endpoint);
    },
  );
});
