// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { loadConfig, loadModelEndpointForInspection } from "../src/config/runtime-loader.js";
import { loadCompositionRunRuntime } from "../src/cli/run/composition-runtime.js";
import type { RunRequestWithPublishProjection } from "../src/cli/run/request.js";
import {
  findConfiguredCredential,
  redactConfiguredCredentials,
  refreshConfiguredCredentials,
} from "../src/security/configured-credentials.js";
import { temporaryRoots } from "./helpers/temp.js";
import { validModelEnvironment } from "./helpers.js";

const roots = temporaryRoots();
const modelVariables = Object.keys(validModelEnvironment);

function syntheticCredential(label: string): string {
  return `${label}-${randomUUID()}`;
}

function clearRuntimeVariables(): () => void {
  const names = [
    ...new Set([
      ...Object.keys(process.env).filter((name) => /^(?:MODEL|JUDGE)_/u.test(name)),
      ...modelVariables,
      "DOCSFAB_FIXTURE_TOKEN",
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
    ]),
  ];
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  return () => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("private configuration environment", () => {
  it("keeps composition runtime credentials private when it performs its implicit load", async () => {
    const root = await roots.create("docsfab-private-composition-");
    const credential = syntheticCredential("private-composition-route-secret");
    const restoreRuntimeVariables = clearRuntimeVariables();
    vi.stubEnv("DOCSFAB_CONFIG_ROOT", root);
    const assignments = {
      ...validModelEnvironment,
      MODEL_PROVIDER: "anthropic-api",
      MODEL_BASE_URL: "https://api.anthropic.com/v1",
      MODEL_ID: "claude-opus-4-7",
      MODEL_API_FORMAT: "messages",
      MODEL_COMPATIBLE_API_FORMATS: "messages",
      MODEL_API_KEY: "",
      ANTHROPIC_API_KEY: credential,
      JUDGE_ENABLED: "false",
    };
    await writeFile(
      join(root, ".env"),
      `${Object.entries(assignments)
        .map(([name, value]) => `${name}=${value}`)
        .join("\n")}\n`,
      { mode: 0o600 },
    );
    const request: RunRequestWithPublishProjection = {
      workflow: "review-documentation",
      repositoryPath: "/tmp/docsfab-private-composition-target",
      revision: "HEAD",
      compositionId: "anthropic-claude-opus-4.7-pi",
      allowWrite: false,
      releaseGate: false,
      verbose: false,
      json: false,
      showScan: false,
    };

    try {
      const runtime = await loadCompositionRunRuntime(request);
      expect(runtime.credentialSourceName).toBe("ANTHROPIC_API_KEY");
      expect(runtime.credential.apiKey).toBe(credential);
      expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(process.env.MODEL_API_KEY).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
      restoreRuntimeVariables();
    }
  });

  it.each(["legacy", "split"] as const)(
    "loads the %s secret privately while preserving exact-match credential screening",
    async (layout) => {
      const root = await roots.create(`docsfab-private-${layout}-`);
      const fileCredential = syntheticCredential(`private-file-secret-${layout}`);
      const nonModelCredential = syntheticCredential(`private-non-model-secret-${layout}`);

      const restoreRuntimeVariables = clearRuntimeVariables();
      vi.stubEnv("DOCSFAB_CONFIG_ROOT", root);

      if (layout === "legacy") {
        const assignments = {
          ...validModelEnvironment,
          MODEL_API_KEY: fileCredential,
          DOCSFAB_FIXTURE_TOKEN: nonModelCredential,
        };
        await writeFile(
          join(root, ".env"),
          `${Object.entries(assignments)
            .map(([name, value]) => `${name}=${value}`)
            .join("\n")}\n`,
          { mode: 0o600 },
        );
      } else {
        await mkdir(join(root, "profiles"), { recursive: true });
        await writeFile(
          join(root, "host.yaml"),
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
            "baseUrl: https://integrate.api.nvidia.com/v1",
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
            'profileApprovedSource: "https://metadata.example.test/models/gpt-5.4"',
            'profileEffectiveDate: "2026-08-04"',
            'profileReviewAfter: "2026-12-31"',
            "",
          ].join("\n"),
          { mode: 0o600 },
        );
        await writeFile(
          join(root, "secrets.env"),
          `MODEL_API_KEY=${fileCredential}\nDOCSFAB_FIXTURE_TOKEN=${nonModelCredential}\n`,
          { mode: 0o600 },
        );
      }

      try {
        const config = loadConfig();
        expect(config.model.apiKey).toBe(fileCredential);
        expect(process.env.MODEL_API_KEY).toBeUndefined();
        expect(process.env.DOCSFAB_FIXTURE_TOKEN).toBeUndefined();

        expect(findConfiguredCredential(`prefix ${nonModelCredential} suffix`)).toMatchObject({
          source: "environment variable DOCSFAB_FIXTURE_TOKEN",
          form: "value",
        });
        expect(redactConfiguredCredentials(`prefix ${nonModelCredential} suffix`)).toBe(
          "prefix [REDACTED] suffix",
        );
        refreshConfiguredCredentials();
        expect(findConfiguredCredential(nonModelCredential)).not.toBeNull();

        const inspected = loadModelEndpointForInspection("policy");
        expect(inspected.apiKey).toBe(fileCredential);
        expect(process.env.MODEL_API_KEY).toBeUndefined();
      } finally {
        vi.unstubAllEnvs();
        restoreRuntimeVariables();
      }
    },
  );

  it("preserves an operator-exported credential over the file value", async () => {
    const root = await roots.create("docsfab-private-precedence-");
    const fileCredential = syntheticCredential("private-file-model-secret");
    const exportedCredential = syntheticCredential("operator-exported-model-secret");
    const restoreRuntimeVariables = clearRuntimeVariables();
    vi.stubEnv("DOCSFAB_CONFIG_ROOT", root);
    const assignments = {
      ...validModelEnvironment,
      MODEL_API_KEY: fileCredential,
    };
    await writeFile(
      join(root, ".env"),
      `${Object.entries(assignments)
        .map(([name, value]) => `${name}=${value}`)
        .join("\n")}\n`,
      { mode: 0o600 },
    );
    vi.stubEnv("MODEL_API_KEY", exportedCredential);

    try {
      const config = loadConfig();
      expect(config.model.apiKey).toBe(exportedCredential);
      expect(process.env.MODEL_API_KEY).toBe(exportedCredential);
    } finally {
      vi.unstubAllEnvs();
      restoreRuntimeVariables();
    }
  });
});
