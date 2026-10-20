// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `resolveConfiguredRuntimeAssetPaths` selects the pack directories
 * `loadConfig` selects, in every configuration layout, without loading a
 * credential into the environment.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { projectModelProfileToEnvironment } from "../src/config/profile-projection.js";
import { loadConfig, resolveConfiguredRuntimeAssetPaths } from "../src/config/runtime-loader.js";
import { buildPolicyProfileFromEndpoint } from "../src/setup/split-layout-presets.js";
import { validModelConfig } from "./helpers.js";
import { temporaryRoots } from "./helpers/temp.js";

const roots = temporaryRoots();
const VARIABLES = ["DOCSFAB_SKILL_CRATE_DIR", "DOCSFAB_QUALITY_DIR", "DOCSFAB_QUALITY_PACK_DIR"];
const saved = Object.fromEntries(
  [...VARIABLES, "DOCSFAB_CONFIG_ROOT"].map((name) => [name, process.env[name]]),
);

afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const profile = buildPolicyProfileFromEndpoint({
  provider: "openai-compatible",
  baseUrl: "http://127.0.0.1:9/v1",
  modelId: "fixture/loopback-model",
});
const modelEnvironment: NodeJS.ProcessEnv = {};
projectModelProfileToEnvironment(profile, modelEnvironment);
const CREDENTIAL = modelEnvironment.MODEL_CREDENTIAL_ENV!;

/** Distinct directories per source, so a wrong precedence picks a visibly wrong one. */
function pack(source: string) {
  return {
    DOCSFAB_SKILL_CRATE_DIR: `/from/${source}/skill-crate`,
    DOCSFAB_QUALITY_DIR: `/from/${source}/quality`,
    DOCSFAB_QUALITY_PACK_DIR: `/from/${source}/quality-pack`,
  };
}

function dotenv(assignments: Record<string, string | undefined>): string {
  return `${Object.entries(assignments)
    .map(([name, value]) => `${name}=${value ?? ""}`)
    .join("\n")}\n`;
}

/** A split layout: host.yaml naming a YAML policy profile, and secrets.env. */
async function splitLayout(options: {
  readonly hostPaths?: boolean;
  /** host.yaml names paths relative to the configuration root. */
  readonly relativeHostPaths?: boolean;
  readonly secretsPaths?: boolean;
}) {
  const root = await roots.create("docsfab-asset-paths-split-");
  await mkdir(join(root, "profiles"), { recursive: true });
  await writeFile(join(root, "profiles", "policy.yaml"), `${JSON.stringify(profile, null, 2)}\n`);
  const host = pack("host-yaml");
  await writeFile(
    join(root, "host.yaml"),
    [
      "schemaVersion: 1",
      "kind: docsfab-host-config",
      "activePolicyProfile: profiles/policy.yaml",
      ...(options.hostPaths
        ? [
            "paths:",
            `  skillCrateDir: ${host.DOCSFAB_SKILL_CRATE_DIR}`,
            `  qualityDir: ${host.DOCSFAB_QUALITY_DIR}`,
            `  qualityPackDir: ${host.DOCSFAB_QUALITY_PACK_DIR}`,
          ]
        : options.relativeHostPaths
          ? [
              "paths:",
              "  skillCrateDir: relative/skill-crate",
              "  qualityDir: relative/quality",
              "  qualityPackDir: relative/quality-pack",
            ]
          : []),
      "",
    ].join("\n"),
  );
  await writeFile(
    join(root, "secrets.env"),
    dotenv({
      [CREDENTIAL]: validModelConfig.apiKey,
      ...(options.secretsPaths ? pack("secrets-env") : {}),
    }),
  );
  return root;
}

/** A legacy layout: one .env holding the model profile, credential, and paths. */
async function legacyLayout() {
  const root = await roots.create("docsfab-asset-paths-legacy-");
  await writeFile(
    join(root, ".env"),
    dotenv({ ...modelEnvironment, [CREDENTIAL]: validModelConfig.apiKey, ...pack("dotenv") }),
  );
  return root;
}

function assetPaths(paths: {
  skillCrateDirectory: string;
  qualityDirectory: string;
  qualityPackDirectory: string;
}) {
  return {
    DOCSFAB_SKILL_CRATE_DIR: paths.skillCrateDirectory,
    DOCSFAB_QUALITY_DIR: paths.qualityDirectory,
    DOCSFAB_QUALITY_PACK_DIR: paths.qualityPackDirectory,
  };
}

describe("resolveConfiguredRuntimeAssetPaths", () => {
  it.each([
    ["host.yaml paths.* with no environment override", "host-yaml", { hostPaths: true }, false],
    ["host.yaml paths.* over an environment override", "host-yaml", { hostPaths: true }, true],
    ["an environment override when host.yaml names no path", "env", {}, true],
    [
      "secrets.env paths when neither host.yaml nor the environment does",
      "secrets-env",
      { secretsPaths: true },
      false,
    ],
  ] as const)("selects %s, as loadConfig does", async (_label, winner, layout, withEnvironment) => {
    const root = await splitLayout(layout);
    for (const name of VARIABLES) delete process.env[name];
    const environment: NodeJS.ProcessEnv = {
      DOCSFAB_CONFIG_ROOT: root,
      ...(withEnvironment ? pack("env") : {}),
    };
    const resolved = assetPaths(resolveConfiguredRuntimeAssetPaths(environment));
    expect(resolved).toEqual(pack(winner));
    expect(resolved).toEqual(assetPaths(loadConfig(environment)));
  });

  it.each([
    ["the legacy .env paths with no environment override", "dotenv", false],
    ["an environment override over the legacy .env", "env", true],
  ] as const)(
    "selects %s in the legacy layout, as loadConfig does",
    async (_label, winner, withEnvironment) => {
      const root = await legacyLayout();
      for (const name of VARIABLES) delete process.env[name];
      const environment: NodeJS.ProcessEnv = {
        DOCSFAB_CONFIG_ROOT: root,
        ...(withEnvironment ? pack("env") : {}),
      };
      const resolved = assetPaths(resolveConfiguredRuntimeAssetPaths(environment));
      expect(resolved).toEqual(pack(winner));
      expect(resolved).toEqual(assetPaths(loadConfig(environment)));
    },
  );

  it("resolves a relative host.yaml path under the configuration root, as loadConfig does", async () => {
    const root = await splitLayout({ relativeHostPaths: true });
    for (const name of VARIABLES) delete process.env[name];
    const environment: NodeJS.ProcessEnv = { DOCSFAB_CONFIG_ROOT: root };
    const resolved = assetPaths(resolveConfiguredRuntimeAssetPaths(environment));
    expect(resolved).toEqual({
      DOCSFAB_SKILL_CRATE_DIR: join(root, "relative", "skill-crate"),
      DOCSFAB_QUALITY_DIR: join(root, "relative", "quality"),
      DOCSFAB_QUALITY_PACK_DIR: join(root, "relative", "quality-pack"),
    });
    // Not the working directory, which the test runs from.
    expect(resolved.DOCSFAB_QUALITY_DIR).not.toBe(resolve("relative", "quality"));
    expect(resolved).toEqual(assetPaths(loadConfig(environment)));
  });

  it.each([
    ["the legacy .env", "dotenv", () => legacyLayout()],
    ["a split layout's secrets.env", "secrets-env", () => splitLayout({ secretsPaths: true })],
  ] as const)(
    "reads no credential from %s into the process environment",
    async (_label, winner, layout) => {
      const credentialBefore = process.env[CREDENTIAL];
      delete process.env[CREDENTIAL];
      try {
        for (const name of VARIABLES) delete process.env[name];
        process.env.DOCSFAB_CONFIG_ROOT = await layout();
        expect(assetPaths(resolveConfiguredRuntimeAssetPaths())).toEqual(pack(winner));
        expect(process.env[CREDENTIAL]).toBeUndefined();
        for (const name of VARIABLES) expect(process.env[name]).toBeUndefined();
      } finally {
        if (credentialBefore === undefined) delete process.env[CREDENTIAL];
        else process.env[CREDENTIAL] = credentialBefore;
      }
    },
  );
});
