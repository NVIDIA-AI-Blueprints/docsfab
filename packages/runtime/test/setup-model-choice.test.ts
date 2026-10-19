// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";

import { SETUP_USAGE } from "../src/cli/commands/setup.js";
import { main } from "../src/cli/router.js";
import { EXECUTABLE_ROUTE_BASE_URLS } from "../src/config/executable-route-urls.js";
import { requiredSecretNamesForExecutionProfile } from "../src/config/execution-profile.js";
import { ensureLiveAgentConfiguration } from "../src/live-agent/host.js";
import { toOperatorErrorEnvelope } from "../src/operator/error-envelope.js";
import { situationRowForId } from "../src/operator/situation-catalog.js";
import type { InteractiveSetupPrompter } from "../src/setup/interactive.js";
import { runInteractiveSetup } from "../src/setup/interactive.js";
import {
  decodeHostConfig,
  resolveHostExecutionProfileId,
} from "../src/config/profile-projection.js";
import { loadConfig } from "../src/config/runtime-loader.js";
import { HOST_CONFIG_FILE, SECRETS_ENV_FILE } from "../src/config/split-layout.js";
import { formatSetupBootstrapResult, runSetupBootstrap } from "../src/setup/bootstrap.js";
import { INTERNAL_SETUP_EXECUTION_PROFILE } from "../src/setup/dogfood-profile.js";
import { SETUP_MODEL_CHOICES, SetupModelChoiceRequiredError } from "../src/setup/model-choice.js";
import { temporaryRoots } from "./helpers/temp.js";

// Spelled out rather than imported, so the operator contract is pinned
// independently of the source constants.
const GPT_6_SOL = "nvidia-inference-gpt-6-sol-pi";
const GPT_6_SOL_MODEL = "azure/openai/gpt-6-sol";
const CHOICE_REQUIRED = "setup-model-choice-required";
const CHOICES =
  "Run `docsfab setup` in a terminal to choose a provider, or pass `--provider <openai|openai-compatible|anthropic|anthropic-compatible> --model <id>` (compatible providers also need `--endpoint <url>`), or pass `--profile <compositionId>` with an installed composition from `docsfab composition list`.";
const PLACEHOLDER_KEY = "setup-choice-placeholder-not-a-credential";

const temporary = temporaryRoots();
const originalArgv = process.argv;

async function refusalOf(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }
  throw new Error("expected setup to refuse");
}

function expectChoiceRequired(error: unknown): void {
  expect(error).toBeInstanceOf(SetupModelChoiceRequiredError);
  expect(error).toMatchObject({ code: CHOICE_REQUIRED, nextAction: CHOICES });
  expect(toOperatorErrorEnvelope(error)).toMatchObject({
    kind: "docsfab-operator-error",
    code: CHOICE_REQUIRED,
    message:
      "DocsFab setup has no default model, and this host has no model selection. Setup without a terminal, or with --json, needs an explicit model choice.",
    nextAction: CHOICES,
    docsAnchor: "docs/configure/model.md",
  });
}

describe("docsfab setup with no model option", () => {
  afterEach(() => {
    process.argv = originalArgv;
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it("names no default model in its usage", () => {
    expect(SETUP_USAGE).not.toContain(GPT_6_SOL);
    expect(SETUP_USAGE.replace(/\s+/gu, " ")).toContain(
      "DocsFab has no default model: without a terminal, or with --json, bare setup on a host with no model selection stops with setup-model-choice-required;",
    );
  });

  it.each([
    ["with no credential", {}, undefined],
    ["with an exported MODEL_API_KEY", { MODEL_API_KEY: PLACEHOLDER_KEY }, undefined],
    ["with an exported OPENAI_API_KEY", { OPENAI_API_KEY: PLACEHOLDER_KEY }, undefined],
    ["with a .env that stores only the key", {}, [".env", `MODEL_API_KEY=${PLACEHOLDER_KEY}\n`]],
    [
      "with a secrets.env and no host.yaml",
      {},
      [SECRETS_ENV_FILE, `MODEL_API_KEY=${PLACEHOLDER_KEY}\n`],
    ],
    [
      "with a host.yaml whose policy profile file is missing",
      { MODEL_API_KEY: PLACEHOLDER_KEY },
      [
        HOST_CONFIG_FILE,
        "schemaVersion: 1\nkind: docsfab-host-config\nactivePolicyProfile: profiles/missing.yaml\n",
      ],
    ],
  ] as const)("refuses %s and writes nothing", async (_label, exported, stored) => {
    const root = await temporary.create("docsfab-setup-choice-refuse-");
    if (stored) await writeFile(join(root, stored[0]), stored[1], { mode: 0o600 });
    const before = (await readdir(root)).sort();
    const beforeBytes = stored ? await readFile(join(root, stored[0]), "utf8") : undefined;

    expectChoiceRequired(
      await refusalOf(() =>
        runSetupBootstrap({
          environment: { DOCSFAB_CONFIG_ROOT: root, ...exported },
        }),
      ),
    );

    expect((await readdir(root)).sort()).toEqual(before);
    if (stored) expect(await readFile(join(root, stored[0]), "utf8")).toBe(beforeBytes);
  });

  it("catalogues the same choices the refusal carries", () => {
    expect(SETUP_MODEL_CHOICES).toBe(CHOICES);
    expect(situationRowForId(CHOICE_REQUIRED)?.nextAction).toBe(SETUP_MODEL_CHOICES);
  });

  it("keeps the shipped setup docs free of a bare-setup default", async () => {
    const repoRoot = resolve("..", "..");
    const docs = {
      "README.md": true,
      "docs/get-started/installation.md": false,
      "docs/configure/model.md": true,
      "docs/reference/status-and-configuration/runtime-cli-and-configuration.md": true,
      "packages/runtime/CONTRIBUTING.md": true,
      "packages/runtime/docs/reference/model-governance/model-profiles.md": false,
    };
    for (const [path, namesRefusal] of Object.entries(docs)) {
      const text = (await readFile(join(repoRoot, path), "utf8")).replace(/\s+/gu, " ");
      expect(text, path).not.toMatch(
        /bare `?(?:docsfab )?setup`?[^.]*\b(?:selects|to move it)\b/iu,
      );
      if (namesRefusal) expect(text, path).toContain(CHOICE_REQUIRED);
    }
  });

  it("refuses through the shipped CLI with the catalogued envelope", async () => {
    const root = await temporary.create("docsfab-setup-choice-cli-");
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((value?: unknown) => {
      lines.push(String(value));
    });
    vi.stubEnv("DOCSFAB_CONFIG_ROOT", root);
    vi.stubEnv("MODEL_API_KEY", PLACEHOLDER_KEY);
    process.argv = [originalArgv[0]!, originalArgv[1]!, "setup", "--json"];

    await main();

    vi.unstubAllEnvs();
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      kind: "docsfab-operator-error",
      code: CHOICE_REQUIRED,
      nextAction: CHOICES,
    });
    expect(await readdir(root)).toEqual([]);
  });

  it("resolves the internal gateway only through the explicit internal composition", async () => {
    expect(INTERNAL_SETUP_EXECUTION_PROFILE).toBe(GPT_6_SOL);
    expect(requiredSecretNamesForExecutionProfile(GPT_6_SOL)).toEqual(["MODEL_API_KEY"]);
    const root = await temporary.create("docsfab-setup-choice-internal-");
    const environment = {
      DOCSFAB_CONFIG_ROOT: root,
      MODEL_API_KEY: PLACEHOLDER_KEY,
    };

    const selected = await runSetupBootstrap({
      profile: GPT_6_SOL,
      environment,
    });

    expect(selected).toMatchObject({
      status: "ready",
      layout: "split",
      seeded: true,
      activeExecutionProfile: GPT_6_SOL,
      requiredSecretNames: ["MODEL_API_KEY"],
      profile: {
        providerId: "nvidia-inference-api",
        modelId: GPT_6_SOL_MODEL,
        endpointUrl: EXECUTABLE_ROUTE_BASE_URLS["nvidia-inference-api"],
      },
    });
    expect(await readFile(join(root, HOST_CONFIG_FILE), "utf8")).toContain(
      `activeExecutionProfile: ${GPT_6_SOL}`,
    );
    expect(existsSync(join(root, "profiles"))).toBe(false);
    expect(loadConfig(environment).model.baseUrl).toBe(
      EXECUTABLE_ROUTE_BASE_URLS["nvidia-inference-api"],
    );
    expect(formatSetupBootstrapResult(selected)).not.toContain(PLACEHOLDER_KEY);

    // A rerun with no option keeps that explicit selection.
    const rerun = await runSetupBootstrap({ environment });
    expect(rerun).toMatchObject({
      status: "ready",
      activeExecutionProfile: GPT_6_SOL,
    });
  });

  it("keeps an existing preset selection instead of refusing", async () => {
    const root = await temporary.create("docsfab-setup-choice-retained-");
    const environment = {
      DOCSFAB_CONFIG_ROOT: root,
      MODEL_API_KEY: PLACEHOLDER_KEY,
    };
    await runSetupBootstrap({
      preset: "nvidia/nvidia/nemotron-3-super-v3",
      environment,
    });

    const rerun = await runSetupBootstrap({ environment });

    expect(rerun.status).toBe("ready");
    expect(rerun.seeded).toBe(false);
    expect(rerun.activeExecutionProfile).toBeUndefined();
    expect(rerun.profile?.modelId).toBe("nvidia/nvidia/nemotron-3-super-v3");
  });

  it("keeps the shipped host.yaml example on the internal composition", async () => {
    const example = decodeHostConfig(
      parseYaml(
        await readFile(join(import.meta.dirname, "..", "config", "host.yaml.example"), "utf8"),
      ),
    );
    expect(resolveHostExecutionProfileId(example)).toBe(GPT_6_SOL);
    expect(example.active?.writing?.compositionId).toBe(GPT_6_SOL);
    expect(example.activePolicyProfile).toBeUndefined();
  });

  it("reports a missing choice at live-agent startup without writing, even with an exported key", async () => {
    const root = await temporary.create("docsfab-setup-choice-startup-");
    const result = await runSetupBootstrap({
      environment: {
        DOCSFAB_CONFIG_ROOT: root,
        MODEL_API_KEY: PLACEHOLDER_KEY,
      },
      purpose: "startup-check",
    });

    expect(result).toMatchObject({
      status: "blocked-model-choice-required",
      seeded: false,
      credentialSource: "none",
      nextCommand: "docsfab setup",
      explanation: `No model is selected, and DocsFab has no default model. ${CHOICES}`,
    });
    expect(result.activeExecutionProfile).toBeUndefined();
    expect(result.requiredSecretNames).toBeUndefined();
    const rendered = formatSetupBootstrapResult(result);
    expect(rendered).toContain("Status: Model choice required");
    expect(rendered).toContain(`Action: ${CHOICES}`);
    expect(rendered).not.toContain("MODEL_API_KEY");
    expect(await readdir(root)).toEqual([]);
  });

  it("refuses at noninteractive live-agent startup and asks for a provider in a terminal", async () => {
    const root = await temporary.create("docsfab-setup-choice-live-agent-");
    const environment = {
      DOCSFAB_CONFIG_ROOT: root,
      MODEL_API_KEY: PLACEHOLDER_KEY,
    };

    await expect(
      ensureLiveAgentConfiguration({
        environment: { ...environment },
        input: Object.assign(new PassThrough(), { isTTY: false }),
        output: Object.assign(new PassThrough(), { isTTY: false }),
      }),
    ).rejects.toThrow(
      `DocsFab live-agent could not use the current model configuration. No model is selected, and DocsFab has no default model. ${CHOICES} Next action: docsfab setup.`,
    );

    const labels: string[] = [];
    const stop = new Error("stop at the first interactive setup question");
    const record = async (label: string): Promise<string> => {
      labels.push(label);
      throw stop;
    };
    const prompter: InteractiveSetupPrompter = {
      readChoice: record,
      readValue: record,
      readSecret: record,
    };
    await expect(
      ensureLiveAgentConfiguration({
        environment: { ...environment },
        input: Object.assign(new PassThrough(), { isTTY: true }),
        output: Object.assign(new PassThrough(), { isTTY: true }),
        prompter,
      }),
    ).rejects.toBe(stop);
    expect(labels).toEqual(["Provider"]);
    expect(await readdir(root)).toEqual([]);
  });

  it("keeps the interactive provider prompt on a fresh root", async () => {
    const root = await temporary.create("docsfab-setup-choice-interactive-");
    const labels: string[] = [];
    const answers = new Map([
      ["Provider", "openai"],
      ["Model name", "gpt-6-sol"],
      ["API", "openai-responses"],
      ["Model API key", PLACEHOLDER_KEY],
    ]);
    const answer = async (label: string): Promise<string> => {
      labels.push(label);
      return answers.get(label)!;
    };
    const environment: NodeJS.ProcessEnv = { DOCSFAB_CONFIG_ROOT: root };

    const result = await runInteractiveSetup({
      environment,
      prompter: { readChoice: answer, readValue: answer, readSecret: answer },
    });

    expect(labels).toEqual(["Provider", "Model name", "API", "Model API key"]);
    expect(result).toMatchObject({
      status: "ready",
      profile: { providerId: "openai-api", modelId: "gpt-6-sol" },
    });
  });
});
