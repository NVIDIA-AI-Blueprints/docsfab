// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  CLOSED_EVAL_PRESET_IDS,
  type ClosedEvalPresetId,
  resolveEvalPresetFieldBlock,
} from "../model/profile-apply/eval-presets.js";
import { CONSERVATIVE_MODEL_FALLBACK } from "../model/configuration.js";
import { assertModelEndpointTransport } from "../model/endpoint-transport.js";
import { modelProfileFromAssignments } from "../config/profile-projection.js";
import type { DocsFabModelProfileV1 } from "../config/profile-projection.js";
import { assertSelectionNotRetired } from "./retired-selections.js";
import {
  assertProviderTransport,
  CUSTOM_ENDPOINT_REQUEST_LIMITS,
  MODEL_PROVIDERS,
  parseModelProviderOption,
  providerBaseUrl,
  type ModelProviderOption,
} from "../config/model-providers.js";
import type { ProviderTransport } from "../model/configuration.js";

const PRESET_PROFILE_FILES: Record<ClosedEvalPresetId, string> = {
  "nvidia/llama-3.3-nemotron-super-49b-v1.5":
    "profiles/nvidia-llama-3.3-nemotron-super-49b-v1.5.yaml",
  "nvidia/nvidia/nemotron-3-super-v3": "profiles/nvidia-nemotron-3-super-v3.yaml",
  "nvidia/moonshotai/kimi-k2.6": "profiles/nvidia-moonshotai-kimi-k2.6.yaml",
};

const UNKNOWN_SETUP_PRESET = "setup received an unknown --preset identifier value.";

export function resolveSetupPreset(preset: string | undefined): ClosedEvalPresetId | undefined {
  if (preset === undefined) return undefined;
  // A retired GPT-5.x preset refuses by name before the unknown-id check.
  assertSelectionNotRetired(preset);
  if (!(CLOSED_EVAL_PRESET_IDS as readonly string[]).includes(preset)) {
    throw new Error(UNKNOWN_SETUP_PRESET);
  }
  return preset as ClosedEvalPresetId;
}

export function resolvePresetProfilePath(preset: ClosedEvalPresetId): string {
  return PRESET_PROFILE_FILES[preset];
}

/**
 * The YAML field block of one named preset. There is no implicit preset, and
 * bare setup selects no model.
 */
export function buildPolicyProfileFromPreset(preset: ClosedEvalPresetId): DocsFabModelProfileV1 {
  const assignments = resolveEvalPresetFieldBlock(preset).assignments;
  if (!assignments) throw new Error(UNKNOWN_SETUP_PRESET);
  return modelProfileFromAssignments("policy", assignments);
}

export interface SetupModelEndpoint {
  modelId: string;
  baseUrl: string;
  provider?: ModelProviderOption;
  transport?: ProviderTransport;
}

export function normalizeSetupEndpointUrl(value: string): string {
  let endpoint: URL;
  try {
    endpoint = new URL(value.trim());
  } catch {
    throw new Error("DocsFab setup requires a valid model endpoint URL.");
  }
  if (
    (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.search !== "" ||
    endpoint.hash !== ""
  ) {
    throw new Error(
      "DocsFab setup requires an HTTP or HTTPS model endpoint URL without credentials, query parameters, or a fragment.",
    );
  }
  assertModelEndpointTransport(endpoint, "The model endpoint URL");
  return endpoint.toString().replace(/\/$/u, "");
}

export function resolveInstalledPresetForEndpoint(
  model: SetupModelEndpoint,
): ClosedEvalPresetId | undefined {
  const modelId = model.modelId.trim();
  const baseUrl = normalizeSetupEndpointUrl(model.baseUrl);
  for (const preset of CLOSED_EVAL_PRESET_IDS) {
    const assignments = new Map(resolveEvalPresetFieldBlock(preset).assignments ?? []);
    if (
      assignments.get("MODEL_ID") === modelId &&
      normalizeSetupEndpointUrl(assignments.get("MODEL_BASE_URL") ?? "") === baseUrl
    ) {
      return preset;
    }
  }
  return undefined;
}

/**
 * Build an operator-selected provider endpoint. A closed-eval identity
 * keeps that preset's real windows. Unmatched selections still persist
 * numeric YAML fields for the parser; they are not a DocsFab host ceiling.
 */
export function buildPolicyProfileFromEndpoint(model: SetupModelEndpoint): DocsFabModelProfileV1 {
  const modelId = model.modelId.trim();
  if (!modelId) throw new Error("DocsFab setup requires you to provide a non-empty model name.");
  const provider =
    model.provider === undefined ? undefined : parseModelProviderOption(model.provider);
  const selected = provider ? MODEL_PROVIDERS[provider] : undefined;
  const transport = model.transport ?? selected?.transport;
  if (provider && transport) assertProviderTransport(provider, transport);
  const normalized = normalizeSetupEndpointUrl(model.baseUrl);
  const baseUrl = transport ? providerBaseUrl(normalized, transport) : normalized;
  if (selected?.baseUrl && selected.baseUrl !== baseUrl) {
    throw new Error("Use the compatible provider option to configure a custom endpoint URL.");
  }
  const apiFormat = transport === "anthropic-messages" ? "messages" : "chat_completions";
  const knownPreset = resolveInstalledPresetForEndpoint({ ...model, baseUrl });
  if (knownPreset !== undefined) {
    return {
      ...buildPolicyProfileFromPreset(knownPreset),
      ...(selected
        ? {
            provider: selected.providerId,
            transport,
            credentialEnv: selected.credentialEnv,
          }
        : {}),
      ...(transport && !selected ? { transport } : {}),
    };
  }
  return modelProfileFromAssignments("policy", [
    ["MODEL_PROVIDER", selected?.providerId ?? "operator-configured-openai-compatible"],
    ["MODEL_BASE_URL", baseUrl],
    ["MODEL_ID", modelId],
    ["MODEL_API_FORMAT", apiFormat],
    ...(transport ? [["MODEL_TRANSPORT", transport] as const] : []),
    ...(selected ? [["MODEL_CREDENTIAL_ENV", selected.credentialEnv] as const] : []),
    ["MODEL_CONTEXT_WINDOW", String(CONSERVATIVE_MODEL_FALLBACK.contextWindow)],
    ["MODEL_MAX_INPUT_TOKENS", String(CONSERVATIVE_MODEL_FALLBACK.contextWindow)],
    ["MODEL_MAX_OUTPUT_TOKENS", String(CONSERVATIVE_MODEL_FALLBACK.maxOutputTokens)],
    ["MODEL_API_MIN_OUTPUT_TOKENS", String(CUSTOM_ENDPOINT_REQUEST_LIMITS.minimumOutputTokens)],
    ["MODEL_CONTEXT_RESERVE_TOKENS", String(CUSTOM_ENDPOINT_REQUEST_LIMITS.reservedContextTokens)],
    ["MODEL_REASONING", "false"],
    ["MODEL_INPUT_TYPES", "text"],
    ["MODEL_SUPPORTS_DEVELOPER_ROLE", "false"],
    ["MODEL_SUPPORTS_REASONING_EFFORT", "false"],
    ["MODEL_COMPATIBLE_API_FORMATS", apiFormat],
    ["MODEL_INPUT_COST_PER_MILLION", "unknown"],
    ["MODEL_OUTPUT_COST_PER_MILLION", "unknown"],
    ["MODEL_CACHE_READ_COST_PER_MILLION", "unknown"],
    ["MODEL_CACHE_WRITE_COST_PER_MILLION", "unknown"],
    ["MODEL_PROFILE_APPROVED_SOURCE", "unknown"],
    ["MODEL_PROFILE_EFFECTIVE_DATE", "unknown"],
    ["MODEL_PROFILE_REVIEW_AFTER", "unknown"],
  ]);
}

export function profileRelativePathFromModelId(modelId: string): string {
  const slug = modelId
    .trim()
    .replace(/\//gu, "-")
    .replace(/[^a-zA-Z0-9.-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  if (!slug) throw new Error("Model profile filenames require a non-empty model id.");
  return `profiles/${slug}.yaml`;
}
