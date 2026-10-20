// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Closed preset field blocks for `docsfab profile seed --preset` and the
 * deprecated `docsfab setup --preset` YAML migration path. Each id is the exact
 * MODEL_ID of its field block; this is a closed map, not a second scheduler,
 * and unpublished names here are not Blueprint defaults.
 *
 * @deprecated Field-block copy for YAML hosts. Prefer setup --profile.
 */
import { EXECUTABLE_ROUTE_BASE_URLS } from "../../config/executable-route-urls.js";
import { assertSelectionNotRetired } from "../../setup/retired-selections.js";

const MODEL_FIELD_ORDER = [
  "MODEL_PROVIDER",
  "MODEL_BASE_URL",
  "MODEL_ID",
  "MODEL_API_FORMAT",
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
] as const;

type ModelFieldName = (typeof MODEL_FIELD_ORDER)[number];

type ModelFieldBlock = { readonly [K in ModelFieldName]: string };

/**
 * GPT-6 Sol on the internal Inference Hub route: the same model and route as
 * the installed GPT-6 Sol composition, so a seeded profile uniquely matches
 * it. Seed fills MODEL_API_KEY. The other Hub presets override this block.
 */
const INTERNAL_GPT_6_SOL_MODEL_FIELDS = {
  MODEL_PROVIDER: "nvidia-inference-api",
  MODEL_ID: "azure/openai/gpt-6-sol",
  MODEL_API_FORMAT: "chat_completions",
  MODEL_CONTEXT_WINDOW: "524288",
  MODEL_MAX_INPUT_TOKENS: "524288",
  MODEL_MAX_OUTPUT_TOKENS: "128000",
  MODEL_API_MIN_OUTPUT_TOKENS: "16",
  MODEL_CONTEXT_RESERVE_TOKENS: "1024",
  MODEL_REASONING: "false",
  MODEL_INPUT_TYPES: "text",
  MODEL_SUPPORTS_DEVELOPER_ROLE: "false",
  MODEL_SUPPORTS_REASONING_EFFORT: "false",
  MODEL_COMPATIBLE_API_FORMATS: "chat_completions",
  MODEL_INPUT_COST_PER_MILLION: "unknown",
  MODEL_OUTPUT_COST_PER_MILLION: "unknown",
  MODEL_CACHE_READ_COST_PER_MILLION: "unknown",
  MODEL_CACHE_WRITE_COST_PER_MILLION: "unknown",
  MODEL_PROFILE_APPROVED_SOURCE: "unknown",
  MODEL_PROFILE_EFFECTIVE_DATE: "unknown",
  MODEL_PROFILE_REVIEW_AFTER: "unknown",
} as const satisfies Omit<ModelFieldBlock, "MODEL_BASE_URL">;

/**
 * The GPT-5.x presets (`switchyard/openai/gpt-5.6-sol`, `gpt-5.6-sol`,
 * `azure/openai/gpt-5.4`) are retired (#1512) and refuse by name through
 * `setup/retired-selections.ts`; they are not selectable field blocks.
 */
export const CLOSED_EVAL_PRESET_IDS = [
  "nvidia/llama-3.3-nemotron-super-49b-v1.5",
  ...(EXECUTABLE_ROUTE_BASE_URLS["nvidia-inference-api"] === undefined
    ? []
    : (["nvidia/nvidia/nemotron-3-super-v3", "nvidia/moonshotai/kimi-k2.6"] as const)),
] as const;

export type ClosedEvalPresetId = (typeof CLOSED_EVAL_PRESET_IDS)[number];

export type EvalPresetAssignments = ReadonlyArray<readonly [string, string]>;

function assignmentsFrom(block: ModelFieldBlock): EvalPresetAssignments {
  return Object.freeze(MODEL_FIELD_ORDER.map((key) => [key, block[key]] as const));
}

function completeBlock(overrides: Partial<ModelFieldBlock>): EvalPresetAssignments {
  const baseUrl = overrides.MODEL_BASE_URL ?? EXECUTABLE_ROUTE_BASE_URLS["nvidia-inference-api"];
  if (baseUrl === undefined) {
    throw new Error(
      "This preset's serving route has no default endpoint in this installation. Run docsfab setup to configure a supported provider endpoint.",
    );
  }
  return assignmentsFrom({
    ...INTERNAL_GPT_6_SOL_MODEL_FIELDS,
    ...overrides,
    MODEL_BASE_URL: baseUrl,
  });
}

const CLOSED_EVAL_PRESET_BLOCKS: Record<
  ClosedEvalPresetId,
  Partial<ModelFieldBlock>
> = Object.freeze({
  "nvidia/llama-3.3-nemotron-super-49b-v1.5": {
    MODEL_PROVIDER: "nvidia-api-catalog",
    MODEL_BASE_URL: EXECUTABLE_ROUTE_BASE_URLS["nvidia-api-catalog"],
    MODEL_ID: "nvidia/llama-3.3-nemotron-super-49b-v1.5",
    MODEL_CONTEXT_WINDOW: "128000",
    MODEL_MAX_INPUT_TOKENS: "128000",
    MODEL_MAX_OUTPUT_TOKENS: "8192",
  },
  "nvidia/nvidia/nemotron-3-super-v3": {
    MODEL_ID: "nvidia/nvidia/nemotron-3-super-v3",
    MODEL_REASONING: "true",
    // Inference Hub Metadata record, 2026-09-28 (#1454).
    MODEL_CONTEXT_WINDOW: "1048576",
    MODEL_MAX_INPUT_TOKENS: "1048576",
    MODEL_MAX_OUTPUT_TOKENS: "32768",
  },
  "nvidia/moonshotai/kimi-k2.6": {
    MODEL_ID: "nvidia/moonshotai/kimi-k2.6",
    MODEL_REASONING: "false",
    MODEL_CONTEXT_WINDOW: "128000",
    MODEL_MAX_INPUT_TOKENS: "128000",
    MODEL_MAX_OUTPUT_TOKENS: "8192",
  },
});

/**
 * The internal GPT-6 Sol block, as a seed preset. An internal host names it
 * explicitly; it is not a setup preset, because setup selects that route with
 * `--profile nvidia-inference-gpt-6-sol-pi`.
 */
export const INTERNAL_GPT_6_SOL_SEED_PRESET = "azure/openai/gpt-6-sol";

/** Every `docsfab profile seed --preset` id. */
export const PROFILE_SEED_PRESET_IDS = [
  ...(EXECUTABLE_ROUTE_BASE_URLS["nvidia-inference-api"] === undefined
    ? []
    : ([INTERNAL_GPT_6_SOL_SEED_PRESET] as const)),
  ...CLOSED_EVAL_PRESET_IDS,
] as const;

export type ProfileSeedPresetId = (typeof PROFILE_SEED_PRESET_IDS)[number];

const UNKNOWN_PRESET = "profile seed received an unknown --preset identifier value.";

function isClosedEvalPresetId(value: string): value is ClosedEvalPresetId {
  return (CLOSED_EVAL_PRESET_IDS as readonly string[]).includes(value);
}

/**
 * Resolve a `--preset` id to the closed field block.
 *
 * @deprecated YAML MODEL_* field-block copy. `docsfab setup --profile` does not call this.
 */
export function resolveEvalPresetFieldBlock(preset: string): {
  preset: ClosedEvalPresetId;
  assignments: EvalPresetAssignments;
} {
  assertSelectionNotRetired(preset);
  if (!isClosedEvalPresetId(preset)) throw new Error(UNKNOWN_PRESET);
  return { preset, assignments: completeBlock(CLOSED_EVAL_PRESET_BLOCKS[preset]) };
}

/**
 * Resolve a `docsfab profile seed --preset` id to its field block. Seed has no
 * default block; the argument parser refuses an omitted preset.
 */
export function resolveProfileSeedPreset(preset: string): {
  preset: ProfileSeedPresetId;
  assignments: EvalPresetAssignments;
} {
  assertSelectionNotRetired(preset);
  if (preset === INTERNAL_GPT_6_SOL_SEED_PRESET) {
    return {
      preset,
      assignments: completeBlock({}),
    };
  }
  return resolveEvalPresetFieldBlock(preset);
}
