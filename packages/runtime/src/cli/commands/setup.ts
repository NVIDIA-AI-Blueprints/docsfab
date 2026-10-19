// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { applyAmbientModelApiFormatFromCompositionTransport } from "../../config/profile-projection.js";
import {
  MODEL_PROVIDERS,
  parseModelProviderOption,
  parseProviderTransport,
} from "../../config/model-providers.js";
import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../../json-evidence.js";
import {
  runSetupBootstrap,
  formatSetupBootstrapResult,
  formatSetupBootstrapResultDetailed,
} from "../../setup/bootstrap.js";
import { createTerminalSetupPrompter, runInteractiveSetup } from "../../setup/interactive.js";

export const SETUP_USAGE = `Usage:
  docsfab setup [--provider <provider>] [--model <id>] [--endpoint <url>] [--api <api>] [--verbose | --json]
  docsfab setup [--profile <compositionId> | --preset <id> | --migrate] [--verbose | --json]

Configures the host model profile and credential. In an attached terminal,
bare setup asks for a provider, model, applicable endpoint/API, and a
required hidden API key. DocsFab has no default model: without a terminal, or
with --json, bare setup on a host with no model selection stops with
setup-model-choice-required; pass --provider and --model, or --profile.
Setup validates configuration without making inference requests.
Use arrow keys and Enter to select the provider and OpenAI API.

Options:
  --provider     openai, openai-compatible, anthropic, or anthropic-compatible
  --model <id>   Model id offered by the selected provider
  --endpoint     HTTPS base URL, or http:// to localhost, 127.0.0.1, or [::1];
                 required for compatible providers without a terminal
  --api          openai-chat-completions, openai-responses, or anthropic-messages
  --profile <id>  Select an installed composition by id and write that id plus required secret names
  --preset <id>  Deprecated YAML field-block copy for existing hosts; prefer --profile
  --migrate      Convert an existing monolithic .env configuration to split layout
  --verbose      Print configuration layout and model-profile diagnostics
  --json         Print machine-readable output; setup cannot prompt in this mode

Credentials (environment variables; never command-line values):
  openai: OPENAI_API_KEY; openai-compatible: COMPATIBLE_API_KEY
  anthropic: ANTHROPIC_API_KEY; anthropic-compatible: COMPATIBLE_ANTHROPIC_API_KEY
`;

/** Setup argument errors use the CLI usage remediation at the operator boundary. */
class SetupOperatorError extends Error {
  readonly code = "cli-usage";

  constructor(message: string) {
    super(message);
    this.name = "SetupOperatorError";
  }
}

export function parseSetupArguments(args: string[]) {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const valueOptions = new Set([
    "--profile",
    "--preset",
    "--provider",
    "--model",
    "--endpoint",
    "--api",
  ]);
  const flagOptions = new Set(["--json", "--verbose", "--migrate"]);
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index]!;
    if (values.has(option) || flags.has(option))
      throw new SetupOperatorError("Setup options must not be repeated.");
    if (flagOptions.has(option)) {
      flags.add(option);
    } else if (valueOptions.has(option)) {
      const value = args[++index];
      if (!value?.trim() || value.startsWith("--")) {
        throw new SetupOperatorError(
          `The setup command requires a non-empty value after ${option}.`,
        );
      }
      values.set(option, value.trim());
    } else {
      throw new SetupOperatorError(
        "Unknown setup option; run docsfab setup --help for supported options.",
      );
    }
  }
  const provider = values.get("--provider");
  const modelId = values.get("--model");
  const baseUrl = values.get("--endpoint");
  const api = values.get("--api");
  const profile = values.get("--profile");
  const preset = values.get("--preset");
  const migrate = flags.has("--migrate");
  if ((modelId || baseUrl || api) && !provider) {
    throw new SetupOperatorError("The --model, --endpoint, and --api options require --provider.");
  }
  if (provider) parseModelProviderOption(provider);
  if (api) parseProviderTransport(api);
  if (provider && (profile || preset || migrate)) {
    throw new SetupOperatorError(
      "Provider options cannot be combined with --profile, --preset, or --migrate.",
    );
  }
  if (flags.has("--json") && flags.has("--verbose")) {
    throw new SetupOperatorError('The setup options "--json" and "--verbose" cannot be combined.');
  }
  return {
    provider,
    modelId,
    baseUrl,
    api,
    profile,
    preset,
    migrate,
    json: flags.has("--json"),
    verbose: flags.has("--verbose"),
  };
}

export async function handleSetupCommand(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    if (args.length !== 1) {
      throw new SetupOperatorError(
        "DocsFab setup help must be requested without any other options.",
      );
    }
    console.log(SETUP_USAGE);
    return;
  }
  const parsed = parseSetupArguments(args);
  applyAmbientModelApiFormatFromCompositionTransport(process.env);
  const { json, verbose, migrate, preset, profile, provider, modelId, baseUrl, api } = parsed;
  const interactive = !json && Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const selected = provider ? MODEL_PROVIDERS[parseModelProviderOption(provider)] : undefined;
  if (!interactive && selected && (!modelId || !(baseUrl || selected.baseUrl))) {
    throw new SetupOperatorError(
      "Non-interactive provider setup requires --model and a custom --endpoint for compatible providers.",
    );
  }
  const result = interactive
    ? await runInteractiveSetup({
        ...(provider ? { provider, modelId, baseUrl, api } : {}),
        ...(preset ? { preset } : {}),
        ...(profile ? { profile } : {}),
        ...(migrate ? { migrate: true } : {}),
        prompter: createTerminalSetupPrompter(),
      })
    : await runSetupBootstrap({
        ...(provider && selected
          ? {
              model: {
                provider: parseModelProviderOption(provider),
                modelId: modelId!,
                baseUrl: baseUrl ?? selected.baseUrl,
                transport: api ? parseProviderTransport(api) : selected.transport,
              },
            }
          : {}),
        ...(preset ? { preset } : {}),
        ...(profile ? { profile } : {}),
        ...(migrate ? { migrate: true } : {}),
      });
  console.log(
    json
      ? canonicalizeJsonEvidence(result as unknown as JsonEvidenceValue)
      : verbose
        ? formatSetupBootstrapResultDetailed(result)
        : formatSetupBootstrapResult(result, process.stdout.isTTY ? process.env : undefined),
  );
  if (result.status !== "ready") process.exitCode = 1;
}
