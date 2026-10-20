// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  applyAmbientModelApiFormatFromCompositionTransport,
  decodeHostConfig,
  decodeModelProfile,
  defaultHostConfig,
  modelApiFormatFromCompositionTransport,
  modelProfileFromAssignments,
  parseModelApiFormatValue,
  projectHostConfigToEnvironment,
  projectModelProfileToEnvironment,
  rejectedModelApiFormatMessage,
} from "../src/config/profile-projection.js";
import { EXECUTABLE_ROUTE_BASE_URLS } from "../src/config/executable-route-urls.js";

const HUB_BASE_URL = EXECUTABLE_ROUTE_BASE_URLS["nvidia-inference-api"];

/**
 * Historical GPT-5.4 operator attestation, inlined because setup no longer
 * exports GPT-5.x attestations (#1512). Projection is model-agnostic.
 */
const GPT_54_OPERATOR_ATTESTATION = {
  MODEL_PROFILE_APPROVED_SOURCE:
    "https://inference-backend.example.com/api/v1/models?search=gpt-5.4",
  MODEL_PROFILE_EFFECTIVE_DATE: "2026-08-04",
  MODEL_PROFILE_REVIEW_AFTER: "2026-12-31",
} as const;

describe("profile projection", () => {
  it("round-trips a policy profile through environment variables", () => {
    const assignments = [
      ["MODEL_PROVIDER", "nvidia-inference-api"],
      ["MODEL_BASE_URL", HUB_BASE_URL],
      ["MODEL_ID", "azure/openai/gpt-5.4"],
      ["MODEL_API_FORMAT", "chat_completions"],
      ["MODEL_CONTEXT_WINDOW", "1000000"],
      ["MODEL_MAX_INPUT_TOKENS", "1000000"],
      ["MODEL_MAX_OUTPUT_TOKENS", "128000"],
      ["MODEL_API_MIN_OUTPUT_TOKENS", "16"],
      ["MODEL_CONTEXT_RESERVE_TOKENS", "4096"],
      ["MODEL_REASONING", "true"],
      ["MODEL_INPUT_TYPES", "text"],
      ["MODEL_SUPPORTS_DEVELOPER_ROLE", "false"],
      ["MODEL_SUPPORTS_REASONING_EFFORT", "false"],
      ["MODEL_COMPATIBLE_API_FORMATS", "chat_completions"],
      ["MODEL_INPUT_COST_PER_MILLION", "unknown"],
      ["MODEL_OUTPUT_COST_PER_MILLION", "unknown"],
      ["MODEL_CACHE_READ_COST_PER_MILLION", "unknown"],
      ["MODEL_CACHE_WRITE_COST_PER_MILLION", "unknown"],
      ["MODEL_PROFILE_APPROVED_SOURCE", GPT_54_OPERATOR_ATTESTATION.MODEL_PROFILE_APPROVED_SOURCE],
      ["MODEL_PROFILE_EFFECTIVE_DATE", GPT_54_OPERATOR_ATTESTATION.MODEL_PROFILE_EFFECTIVE_DATE],
      ["MODEL_PROFILE_REVIEW_AFTER", GPT_54_OPERATOR_ATTESTATION.MODEL_PROFILE_REVIEW_AFTER],
    ] as const;
    const profile = modelProfileFromAssignments("policy", assignments);
    const env: NodeJS.ProcessEnv = {};
    projectModelProfileToEnvironment(profile, env);
    expect(env.MODEL_PROVIDER).toBe("nvidia-inference-api");
    expect(env.MODEL_ID).toBe("azure/openai/gpt-5.4");
    expect(env.MODEL_CONTEXT_WINDOW).toBe("1000000");
    expect(decodeModelProfile(profile).modelId).toBe("azure/openai/gpt-5.4");
  });

  it("projects host.yaml paths and retry policy into DOCSFAB_* variables", () => {
    const host = decodeHostConfig({
      schemaVersion: 1,
      kind: "docsfab-host-config",
      activePolicyProfile: "profiles/operating-agent.yaml",
      paths: { stateDir: "./.docsfab/runs" },
      retryPolicy: { readOnlyMaxRetries: 1, retryableCategories: ["timeout"] },
    });
    const env: NodeJS.ProcessEnv = {};
    projectHostConfigToEnvironment(host, env, "/private/host/docsfab");
    expect(env.DOCSFAB_STATE_DIR).toBe("/private/host/docsfab/.docsfab/runs");
    expect(env.DOCSFAB_READ_ONLY_MAX_RETRIES).toBe("1");
    expect(env.DOCSFAB_RETRYABLE_CATEGORIES).toBe("timeout");
  });

  it("anchors relative host paths to the configuration root instead of the working directory", () => {
    const host = decodeHostConfig({
      schemaVersion: 1,
      kind: "docsfab-host-config",
      activePolicyProfile: "profiles/operating-agent.yaml",
      paths: { skillCrateDir: "./crates/governed", stateDir: "/var/docsfab/runs" },
    });
    const env: NodeJS.ProcessEnv = {};
    projectHostConfigToEnvironment(host, env, "/private/host/docsfab");
    expect(env.DOCSFAB_SKILL_CRATE_DIR).toBe("/private/host/docsfab/crates/governed");
    expect(env.DOCSFAB_STATE_DIR).toBe("/var/docsfab/runs");
  });

  it("drops superseded installed-asset paths so the installed package assets stay in effect", () => {
    const host = decodeHostConfig({
      schemaVersion: 1,
      kind: "docsfab-host-config",
      activePolicyProfile: "profiles/operating-agent.yaml",
      paths: {
        skillCrateDir: "./skill-crate",
        qualityDir: "./quality",
        qualityPackDir: "./quality-pack",
        stateDir: "./.docsfab/runs",
      },
    });
    expect(host.paths).toEqual({ stateDir: "./.docsfab/runs" });
    const env: NodeJS.ProcessEnv = {};
    projectHostConfigToEnvironment(host, env, "/private/host/docsfab");
    expect(env.DOCSFAB_SKILL_CRATE_DIR).toBeUndefined();
    expect(env.DOCSFAB_QUALITY_DIR).toBeUndefined();
    expect(env.DOCSFAB_QUALITY_PACK_DIR).toBeUndefined();
  });

  it("keeps the default host config free of installed-asset path overrides", () => {
    expect(defaultHostConfig("profiles/operating-agent.yaml").paths).toEqual({
      stateDir: "./.docsfab/runs",
    });
  });

  it("decodes activeExecutionProfile and compositionId as the selected host profile", () => {
    const host = decodeHostConfig({
      schemaVersion: 1,
      kind: "docsfab-host-config",
      activeExecutionProfile: "anthropic-claude-opus-4.7-pi",
      compositionId: "anthropic-claude-opus-4.7-pi",
    });
    expect(host.activeExecutionProfile).toBe("anthropic-claude-opus-4.7-pi");
    expect(host.compositionId).toBe("anthropic-claude-opus-4.7-pi");
    expect(host.activePolicyProfile).toBeUndefined();
  });

  it("decodes independent active.writing and active.judge composition slots", () => {
    const host = decodeHostConfig({
      schemaVersion: 1,
      kind: "docsfab-host-config",
      active: {
        writing: {
          compositionId: "anthropic-claude-opus-4.7-pi",
          qualification: "not-run",
        },
        judge: {
          compositionId: "nvidia-inference-nemotron-3-super-v3-pi",
          qualification: "not-run",
        },
      },
    });
    expect(host.active?.writing?.compositionId).toBe("anthropic-claude-opus-4.7-pi");
    expect(host.active?.judge?.compositionId).toBe("nvidia-inference-nemotron-3-super-v3-pi");
    expect(host.active?.writing?.qualification).toBe("not-run");
    expect(host.active?.judge?.qualification).toBe("not-run");
  });

  it("rejects unknown purpose slots under active", () => {
    expect(() =>
      decodeHostConfig({
        schemaVersion: 1,
        kind: "docsfab-host-config",
        active: {
          writing: { compositionId: "anthropic-claude-opus-4.7-pi" },
          review: { compositionId: "anthropic-claude-opus-4.7-pi" },
        },
      }),
    ).toThrow(/only accepts writing and judge purpose slots/u);
  });

  it("rejects mismatched writing composition aliases", () => {
    expect(() =>
      decodeHostConfig({
        schemaVersion: 1,
        kind: "docsfab-host-config",
        activeExecutionProfile: "anthropic-claude-opus-4.7-pi",
        active: {
          writing: { compositionId: "nvidia-inference-nemotron-3-super-v3-pi" },
        },
      }),
    ).toThrow(/must name the same installed profile/u);
  });

  it("derives MODEL_API_FORMAT from a composition transport", () => {
    expect(modelApiFormatFromCompositionTransport("openai-chat-completions")).toBe(
      "chat_completions",
    );
    expect(modelApiFormatFromCompositionTransport("openai-responses")).toBe("chat_completions");
    expect(modelApiFormatFromCompositionTransport("anthropic-messages")).toBe("messages");
    expect(parseModelApiFormatValue("openai-chat-completions")).toBe("chat_completions");
    expect(parseModelApiFormatValue("messages")).toBe("messages");

    const openaiProfile = modelProfileFromAssignments(
      "policy",
      withApiFormat("openai-chat-completions"),
    );
    expect(openaiProfile.apiFormat).toBe("chat_completions");
    const projected: NodeJS.ProcessEnv = {};
    projectModelProfileToEnvironment(openaiProfile, projected);
    expect(projected.MODEL_API_FORMAT).toBe("chat_completions");
    expect(decodeModelProfile({ ...openaiProfile, apiFormat: "openai-responses" }).apiFormat).toBe(
      "chat_completions",
    );

    const anthropicProfile = modelProfileFromAssignments(
      "policy",
      withApiFormat("anthropic-messages"),
    );
    expect(anthropicProfile.apiFormat).toBe("messages");

    const ambient: NodeJS.ProcessEnv = { MODEL_API_FORMAT: "openai-chat-completions" };
    applyAmbientModelApiFormatFromCompositionTransport(ambient);
    expect(ambient.MODEL_API_FORMAT).toBe("chat_completions");
  });

  it("rejects unknown MODEL_API_FORMAT values by naming accepted profile values and composition transports", () => {
    const message = rejectedModelApiFormatMessage("openai-completions");
    expect(message).toContain(
      "chat_completions (composition transport openai-chat-completions or openai-responses)",
    );
    expect(message).toContain("messages (composition transport anthropic-messages)");
    expect(() => parseModelApiFormatValue("openai-completions")).toThrow(message);
    expect(() => parseModelApiFormatValue("opaque-cli-managed")).toThrow(
      rejectedModelApiFormatMessage("opaque-cli-managed"),
    );
    expect(() =>
      modelProfileFromAssignments("policy", withApiFormat("openai-completions")),
    ).toThrow(rejectedModelApiFormatMessage("openai-completions"));
  });
});

function withApiFormat(apiFormat: string): ReadonlyArray<readonly [string, string]> {
  return [
    ["MODEL_PROVIDER", "nvidia-inference-api"],
    ["MODEL_BASE_URL", HUB_BASE_URL],
    ["MODEL_ID", "azure/openai/gpt-5.4"],
    ["MODEL_API_FORMAT", apiFormat],
    ["MODEL_CONTEXT_WINDOW", "1000000"],
    ["MODEL_MAX_INPUT_TOKENS", "1000000"],
    ["MODEL_MAX_OUTPUT_TOKENS", "128000"],
    ["MODEL_API_MIN_OUTPUT_TOKENS", "16"],
    ["MODEL_CONTEXT_RESERVE_TOKENS", "4096"],
    ["MODEL_REASONING", "true"],
    ["MODEL_INPUT_TYPES", "text"],
    ["MODEL_SUPPORTS_DEVELOPER_ROLE", "false"],
    ["MODEL_SUPPORTS_REASONING_EFFORT", "false"],
    ["MODEL_COMPATIBLE_API_FORMATS", "chat_completions"],
    ["MODEL_INPUT_COST_PER_MILLION", "unknown"],
    ["MODEL_OUTPUT_COST_PER_MILLION", "unknown"],
    ["MODEL_CACHE_READ_COST_PER_MILLION", "unknown"],
    ["MODEL_CACHE_WRITE_COST_PER_MILLION", "unknown"],
    ["MODEL_PROFILE_APPROVED_SOURCE", GPT_54_OPERATOR_ATTESTATION.MODEL_PROFILE_APPROVED_SOURCE],
    ["MODEL_PROFILE_EFFECTIVE_DATE", GPT_54_OPERATOR_ATTESTATION.MODEL_PROFILE_EFFECTIVE_DATE],
    ["MODEL_PROFILE_REVIEW_AFTER", GPT_54_OPERATOR_ATTESTATION.MODEL_PROFILE_REVIEW_AFTER],
  ];
}
