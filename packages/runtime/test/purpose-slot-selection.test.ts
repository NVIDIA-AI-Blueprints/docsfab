// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { stringify as stringifyYaml } from "yaml";
import { afterEach, describe, expect, it } from "vitest";

import {
  decodeHostConfig,
  defaultExecutionHostConfig,
  resolveHostJudgeSlot,
  resolveHostWritingSlot,
} from "../src/config/profile-projection.js";
import { HOST_CONFIG_FILE, loadSplitLayoutIntoEnvironment } from "../src/config/split-layout.js";
import { loadConfig } from "../src/config/runtime-loader.js";
import { resolveOperatorExecutionBinding } from "../src/model/operator-execution-binding.js";
import { temporaryRoots } from "./helpers/temp.js";
import { EXECUTABLE_ROUTE_BASE_URLS } from "../src/config/executable-route-urls.js";

const HUB_BASE_URL = EXECUTABLE_ROUTE_BASE_URLS["nvidia-inference-api"];

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

const WRITING = "nvidia-inference-gpt-6-sol-pi";
const JUDGE = "nvidia-inference-nemotron-3-super-v3-pi";
const RETIRED = "nvidia-llama-3.3-nemotron-super-49b-v1.5-pi";

const ISOLATED_KEYS = [
  "DOCSFAB_CONFIG_ROOT",
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
  "DOCSFAB_ACTIVE_JUDGE_EXECUTION_PROFILE",
  "DOCSFAB_WRITING_QUALIFICATION",
  "DOCSFAB_JUDGE_QUALIFICATION",
  "JUDGE_ENABLED",
  "JUDGE_PROVIDER",
  "JUDGE_BASE_URL",
  "JUDGE_MODEL_ID",
  "JUDGE_API_FORMAT",
  "JUDGE_API_KEY",
  "OPENAI_API_KEY",
  "NVIDIA_API_KEY",
] as const;

function isolateHostEnvironment(): void {
  remember("DOCSFAB_CONFIG_ROOT");
  for (const key of Object.keys(process.env)) {
    if (
      /^(?:MODEL_|JUDGE_)/u.test(key) ||
      key === "DOCSFAB_ACTIVE_EXECUTION_PROFILE" ||
      key === "DOCSFAB_ACTIVE_JUDGE_EXECUTION_PROFILE" ||
      key === "DOCSFAB_WRITING_QUALIFICATION" ||
      key === "DOCSFAB_JUDGE_QUALIFICATION" ||
      key === "OPENAI_API_KEY" ||
      key === "NVIDIA_API_KEY"
    ) {
      remember(key);
      delete process.env[key];
    }
  }
  for (const key of ISOLATED_KEYS) {
    remember(key);
    delete process.env[key];
  }
}

async function writeHost(root: string, host: unknown): Promise<void> {
  await writeFile(join(root, HOST_CONFIG_FILE), `${stringifyYaml(host)}\n`, { mode: 0o600 });
  await writeFile(
    join(root, "secrets.env"),
    ["MODEL_API_KEY=sk-writing-test", "JUDGE_API_KEY=nvapi-judge-test", ""].join("\n"),
    { mode: 0o600 },
  );
}

async function loadHost(root: string): Promise<void> {
  isolateHostEnvironment();
  process.env.DOCSFAB_CONFIG_ROOT = root;
  loadSplitLayoutIntoEnvironment(root, process.env);
}

describe("independent writing and judge purpose slots", () => {
  it("names distinct writing and judge compositionIds and records not-run qualification", async () => {
    const root = await temporary.create("docsfab-purpose-slots-");
    await writeHost(root, {
      schemaVersion: 1,
      kind: "docsfab-host-config",
      active: {
        writing: { compositionId: WRITING, qualification: "not-run" },
        judge: { compositionId: JUDGE, qualification: "not-run" },
      },
    });
    await loadHost(root);

    const host = decodeHostConfig({
      schemaVersion: 1,
      kind: "docsfab-host-config",
      active: {
        writing: { compositionId: WRITING, qualification: "not-run" },
        judge: { compositionId: JUDGE, qualification: "not-run" },
      },
    });
    expect(resolveHostWritingSlot(host).compositionId).toBe(WRITING);
    expect(resolveHostJudgeSlot(host).compositionId).toBe(JUDGE);
    expect(process.env.DOCSFAB_ACTIVE_EXECUTION_PROFILE).toBe(WRITING);
    expect(process.env.DOCSFAB_ACTIVE_JUDGE_EXECUTION_PROFILE).toBe(JUDGE);
    expect(process.env.DOCSFAB_WRITING_QUALIFICATION).toBe("not-run");
    expect(process.env.DOCSFAB_JUDGE_QUALIFICATION).toBe("not-run");
    expect(process.env.JUDGE_ENABLED).toBe("true");
    expect(process.env.MODEL_ID).toBe("azure/openai/gpt-6-sol");
    expect(process.env.JUDGE_MODEL_ID).toBe("nvidia/nvidia/nemotron-3-super-v3");

    const config = loadConfig(process.env);
    expect(config.model.modelId).toBe("azure/openai/gpt-6-sol");
    expect(config.judge?.modelId).toBe("nvidia/nvidia/nemotron-3-super-v3");
    const writing = await resolveOperatorExecutionBinding({
      model: config.model,
      environment: process.env,
    });
    const judge = await resolveOperatorExecutionBinding({
      model: config.judge!,
      environment: process.env,
    });
    expect(writing.bound?.composition.compositionId).toBe(WRITING);
    expect(judge.bound?.composition.compositionId).toBe(JUDGE);
  });

  it("still runs ordinary writing when judge qualification is not-run or the judge slot is unset", async () => {
    const root = await temporary.create("docsfab-purpose-writing-");
    await writeHost(root, {
      schemaVersion: 1,
      kind: "docsfab-host-config",
      active: {
        writing: { compositionId: WRITING, qualification: "failed" },
        judge: { compositionId: JUDGE, qualification: "not-run" },
      },
    });
    await loadHost(root);
    const withJudge = loadConfig(process.env);
    const writingWithJudge = await resolveOperatorExecutionBinding({
      model: withJudge.model,
      environment: process.env,
    });
    expect(writingWithJudge.bound?.composition.compositionId).toBe(WRITING);
    expect(process.env.DOCSFAB_JUDGE_QUALIFICATION).toBe("not-run");

    const unsetRoot = await temporary.create("docsfab-purpose-unset-");
    await writeHost(unsetRoot, {
      schemaVersion: 1,
      kind: "docsfab-host-config",
      active: { writing: { compositionId: WRITING, qualification: "not-run" } },
    });
    await loadHost(unsetRoot);
    expect(process.env.JUDGE_ENABLED).toBeUndefined();
    expect(process.env.DOCSFAB_ACTIVE_JUDGE_EXECUTION_PROFILE).toBeUndefined();
    const writingOnly = loadConfig(process.env);
    expect(writingOnly.judge).toBeUndefined();
    const bound = await resolveOperatorExecutionBinding({
      model: writingOnly.model,
      environment: process.env,
    });
    expect(bound.bound?.composition.compositionId).toBe(WRITING);
  });

  it("does not auto-select a qualified judge profile for writing", async () => {
    const root = await temporary.create("docsfab-purpose-no-auto-");
    await writeHost(root, {
      schemaVersion: 1,
      kind: "docsfab-host-config",
      active: {
        writing: { compositionId: WRITING, qualification: "not-run" },
        judge: { compositionId: JUDGE, qualification: "qualified" },
      },
    });
    await loadHost(root);
    const config = loadConfig(process.env);
    const writing = await resolveOperatorExecutionBinding({
      model: config.model,
      environment: process.env,
    });
    expect(writing.bound?.composition.compositionId).toBe(WRITING);
    expect(writing.bound?.composition.compositionId).not.toBe(JUDGE);
    expect(process.env.DOCSFAB_JUDGE_QUALIFICATION).toBe("qualified");
  });

  it("does not silently swap the frozen writing composition mid-run", async () => {
    const root = await temporary.create("docsfab-purpose-freeze-");
    await writeHost(root, {
      schemaVersion: 1,
      kind: "docsfab-host-config",
      active: {
        writing: { compositionId: WRITING, qualification: "not-run" },
        judge: { compositionId: JUDGE, qualification: "not-run" },
      },
    });
    await loadHost(root);
    const config = loadConfig(process.env);
    await writeHost(root, {
      schemaVersion: 1,
      kind: "docsfab-host-config",
      active: {
        writing: { compositionId: JUDGE, qualification: "qualified" },
      },
    });
    const writing = await resolveOperatorExecutionBinding({
      model: config.model,
      environment: process.env,
    });
    expect(writing.bound?.composition.compositionId).toBe(WRITING);
    expect(process.env.DOCSFAB_ACTIVE_EXECUTION_PROFILE).toBe(WRITING);
  });

  it("applies a declared writing fallback only at select time when the primary is retired", async () => {
    const root = await temporary.create("docsfab-purpose-fallback-");
    await writeHost(root, {
      schemaVersion: 1,
      kind: "docsfab-host-config",
      active: {
        writing: {
          compositionId: RETIRED,
          fallbackCompositionId: WRITING,
          qualification: "not-run",
        },
      },
    });
    await loadHost(root);
    expect(process.env.DOCSFAB_ACTIVE_EXECUTION_PROFILE).toBe(WRITING);
    const config = loadConfig(process.env);
    const writing = await resolveOperatorExecutionBinding({
      model: config.model,
      environment: process.env,
    });
    expect(writing.bound?.composition.compositionId).toBe(WRITING);
  });

  it("leaves ordinary writing runnable when a retired judge has no fallback", async () => {
    const root = await temporary.create("docsfab-purpose-retired-judge-");
    await writeHost(root, {
      schemaVersion: 1,
      kind: "docsfab-host-config",
      active: {
        writing: { compositionId: WRITING, qualification: "not-run" },
        judge: { compositionId: RETIRED, qualification: "not-run" },
      },
    });
    await loadHost(root);
    expect(process.env.JUDGE_ENABLED).toBeUndefined();
    expect(process.env.DOCSFAB_ACTIVE_JUDGE_EXECUTION_PROFILE).toBeUndefined();
    const config = loadConfig(process.env);
    expect(config.judge).toBeUndefined();
    const writing = await resolveOperatorExecutionBinding({
      model: config.model,
      environment: process.env,
    });
    expect(writing.bound?.composition.compositionId).toBe(WRITING);
  });

  it("keeps a YAML judge path independent of the writing composition", async () => {
    const root = await temporary.create("docsfab-purpose-yaml-judge-");
    await mkdir(join(root, "profiles"), { recursive: true, mode: 0o700 });
    await writeFile(
      join(root, "profiles", "evaluation-judge.yaml"),
      `${stringifyYaml({
        schemaVersion: 1,
        kind: "docsfab-model-profile",
        slot: "judge",
        provider: "nvidia-inference-api",
        baseUrl: HUB_BASE_URL,
        modelId: "nvidia/nvidia/nemotron-3-super-v3",
        apiFormat: "chat_completions",
        contextWindow: 8192,
        maxInputTokens: 8192,
        maxOutputTokens: 1024,
        apiMinOutputTokens: 16,
        contextReserveTokens: 1024,
        reasoning: false,
        inputTypes: "text",
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        compatibleApiFormats: "chat_completions",
        inputCostPerMillion: "unknown",
        outputCostPerMillion: "unknown",
        cacheReadCostPerMillion: "unknown",
        cacheWriteCostPerMillion: "unknown",
        profileApprovedSource: "unknown",
        profileEffectiveDate: "unknown",
        profileReviewAfter: "unknown",
      })}\n`,
      { mode: 0o600 },
    );
    await writeHost(root, {
      schemaVersion: 1,
      kind: "docsfab-host-config",
      activeExecutionProfile: WRITING,
      compositionId: WRITING,
      activeJudgeProfile: "profiles/evaluation-judge.yaml",
    });
    await loadHost(root);
    expect(process.env.DOCSFAB_ACTIVE_EXECUTION_PROFILE).toBe(WRITING);
    expect(process.env.JUDGE_ENABLED).toBe("true");
    expect(process.env.JUDGE_MODEL_ID).toBe("nvidia/nvidia/nemotron-3-super-v3");
    const config = loadConfig(process.env);
    const writing = await resolveOperatorExecutionBinding({
      model: config.model,
      environment: process.env,
    });
    expect(writing.bound?.composition.compositionId).toBe(WRITING);
  });

  it("writes defaultExecutionHostConfig with a writing slot that stays not-run", () => {
    const host = defaultExecutionHostConfig(WRITING);
    expect(host.active?.writing?.compositionId).toBe(WRITING);
    expect(host.active?.writing?.qualification).toBe("not-run");
    expect(host.active?.judge).toBeUndefined();
  });
});
