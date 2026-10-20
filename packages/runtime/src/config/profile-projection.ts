// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isAbsolute, resolve } from "node:path";

import { LIMIT_DEFINITION_BY_NAME } from "./limits.generated.js";
import {
  assertCredentialEnvironmentName,
  parseProviderTransport,
  type ProviderTransport,
} from "./model-providers.js";
import {
  isModelSettingKey,
  MODEL_SETTING_KEYS,
  ModelSettingValueError,
  parseModelSettingValue,
  type ModelSettingKey,
  type ModelSettingValue,
  type ModelSettingValues,
} from "./model-settings.js";

export type ModelProfileSlot = "policy" | "judge";
export type ExecutionPurpose = "writing" | "judge";

export const PURPOSE_SLOT_QUALIFICATIONS = ["not-run", "failed", "qualified"] as const;
export type PurposeSlotQualification = (typeof PURPOSE_SLOT_QUALIFICATIONS)[number];
export const DEFAULT_PURPOSE_SLOT_QUALIFICATION: PurposeSlotQualification = "not-run";

export const HOST_CONFIG_SCHEMA_VERSION = 1 as const;
export const MODEL_PROFILE_SCHEMA_VERSION = 1 as const;

/** Independent installed-profile selection for one host purpose. */
export interface HostPurposeSlotV1 {
  compositionId?: string;
  /**
   * Role qualification for this purpose. Selecting a profile is not
   * qualification. Default `not-run` never gates ordinary writing.
   */
  qualification?: PurposeSlotQualification;
  /**
   * Setup/select-time replacement when `compositionId` is retired.
   * Never applied as a silent mid-run swap.
   */
  fallbackCompositionId?: string;
  /**
   * Operator values over the preset or profile for this slot. The environment
   * and `--set` outrank them; the preset's own values sit below.
   */
  settings?: ModelSettingValues;
}

export interface DocsFabHostConfigV1 {
  schemaVersion: typeof HOST_CONFIG_SCHEMA_VERSION;
  kind: "docsfab-host-config";
  /**
   * Installed composition id (or the legacy dogfood shortcut) selected as the
   * executable host profile. Secrets stay in secrets.env.
   */
  activeExecutionProfile?: string;
  /** Alias of `activeExecutionProfile` during migration. */
  compositionId?: string;
  /**
   * YAML policy profile path, or an alias of `activeExecutionProfile` when the
   * value is not a `profiles/*.yaml` path.
   */
  activePolicyProfile?: string;
  /** YAML judge profile path, or a composition-id alias of `active.judge`. */
  activeJudgeProfile?: string;
  /** Independent writing and judge slots. */
  active?: {
    writing?: HostPurposeSlotV1;
    judge?: HostPurposeSlotV1;
  };
  paths?: {
    skillCrateDir?: string;
    qualityDir?: string;
    qualityPackDir?: string;
    stateDir?: string;
  };
  retryPolicy?: {
    readOnlyMaxRetries?: number;
    /** Separate budget, within `readOnlyMaxRetries`, for retrying an attempt timeout. */
    readOnlyMaxTimeoutRetries?: number;
    /** Separate budget, within `readOnlyMaxRetries`, for retrying an answer cut at the output limit. */
    readOnlyMaxCutAnswerRetries?: number;
    /** Separate budget, within `readOnlyMaxRetries`, for retrying an attempt stopped as no-progress. */
    readOnlyMaxNoProgressRetries?: number;
    /** Separate budget, outside `readOnlyMaxRetries`, for throttles and transport faults. */
    readOnlyMaxTransportRetries?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    retryableCategories?: string[];
  };
}

export interface DocsFabModelProfileV1 {
  schemaVersion: typeof MODEL_PROFILE_SCHEMA_VERSION;
  kind: "docsfab-model-profile";
  slot: ModelProfileSlot;
  provider: string;
  baseUrl: string;
  modelId: string;
  apiFormat: string;
  transport?: ProviderTransport;
  credentialEnv?: string;
  contextWindow: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  apiMinOutputTokens: number;
  contextReserveTokens: number;
  reasoning: boolean;
  inputTypes: string;
  supportsDeveloperRole: boolean;
  supportsReasoningEffort: boolean;
  compatibleApiFormats: string;
  inputCostPerMillion: string;
  outputCostPerMillion: string;
  cacheReadCostPerMillion: string;
  cacheWriteCostPerMillion: string;
  profileApprovedSource: string;
  profileEffectiveDate: string;
  profileReviewAfter: string;
}

const POLICY_FIELD_MAP: ReadonlyArray<readonly [keyof DocsFabModelProfileV1, string]> = [
  ["provider", "MODEL_PROVIDER"],
  ["baseUrl", "MODEL_BASE_URL"],
  ["modelId", "MODEL_ID"],
  ["apiFormat", "MODEL_API_FORMAT"],
  ["contextWindow", "MODEL_CONTEXT_WINDOW"],
  ["maxInputTokens", "MODEL_MAX_INPUT_TOKENS"],
  ["maxOutputTokens", "MODEL_MAX_OUTPUT_TOKENS"],
  ["apiMinOutputTokens", "MODEL_API_MIN_OUTPUT_TOKENS"],
  ["contextReserveTokens", "MODEL_CONTEXT_RESERVE_TOKENS"],
  ["reasoning", "MODEL_REASONING"],
  ["inputTypes", "MODEL_INPUT_TYPES"],
  ["supportsDeveloperRole", "MODEL_SUPPORTS_DEVELOPER_ROLE"],
  ["supportsReasoningEffort", "MODEL_SUPPORTS_REASONING_EFFORT"],
  ["compatibleApiFormats", "MODEL_COMPATIBLE_API_FORMATS"],
  ["inputCostPerMillion", "MODEL_INPUT_COST_PER_MILLION"],
  ["outputCostPerMillion", "MODEL_OUTPUT_COST_PER_MILLION"],
  ["cacheReadCostPerMillion", "MODEL_CACHE_READ_COST_PER_MILLION"],
  ["cacheWriteCostPerMillion", "MODEL_CACHE_WRITE_COST_PER_MILLION"],
  ["profileApprovedSource", "MODEL_PROFILE_APPROVED_SOURCE"],
  ["profileEffectiveDate", "MODEL_PROFILE_EFFECTIVE_DATE"],
  ["profileReviewAfter", "MODEL_PROFILE_REVIEW_AFTER"],
];

const JUDGE_FIELD_MAP: ReadonlyArray<readonly [keyof DocsFabModelProfileV1, string]> =
  POLICY_FIELD_MAP.map(([field, envName]) => {
    if (envName === "MODEL_ID") return [field, "JUDGE_MODEL_ID"] as const;
    return [field, envName.replace(/^MODEL_/u, "JUDGE_")] as const;
  });

const HOST_PATH_MAP: ReadonlyArray<
  readonly [keyof NonNullable<DocsFabHostConfigV1["paths"]>, string]
> = [
  ["skillCrateDir", "DOCSFAB_SKILL_CRATE_DIR"],
  ["qualityDir", "DOCSFAB_QUALITY_DIR"],
  ["qualityPackDir", "DOCSFAB_QUALITY_PACK_DIR"],
  ["stateDir", "DOCSFAB_STATE_DIR"],
];

/**
 * Installed-package asset paths that older `docsfab setup` versions wrote into host.yaml. They
 * name directories that do not exist under a configuration root, so decode drops them and the
 * installed package defaults apply. Any other operator value is honoured.
 */
const SUPERSEDED_INSTALLED_ASSET_PATHS: Readonly<
  Partial<Record<keyof NonNullable<DocsFabHostConfigV1["paths"]>, string>>
> = {
  skillCrateDir: "./skill-crate",
  qualityDir: "./quality",
  qualityPackDir: "./quality-pack",
};

const HOST_RETRY_MAP: ReadonlyArray<
  readonly [keyof NonNullable<DocsFabHostConfigV1["retryPolicy"]>, string]
> = [
  ["readOnlyMaxRetries", "DOCSFAB_READ_ONLY_MAX_RETRIES"],
  ["readOnlyMaxTimeoutRetries", "DOCSFAB_READ_ONLY_MAX_TIMEOUT_RETRIES"],
  ["readOnlyMaxCutAnswerRetries", "DOCSFAB_READ_ONLY_MAX_CUT_ANSWER_RETRIES"],
  ["readOnlyMaxNoProgressRetries", "DOCSFAB_READ_ONLY_MAX_NO_PROGRESS_RETRIES"],
  ["readOnlyMaxTransportRetries", "DOCSFAB_READ_ONLY_MAX_TRANSPORT_RETRIES"],
  ["baseDelayMs", "DOCSFAB_RETRY_BASE_DELAY_MS"],
  ["maxDelayMs", "DOCSFAB_RETRY_MAX_DELAY_MS"],
  ["retryableCategories", "DOCSFAB_RETRYABLE_CATEGORIES"],
];

export const SECRET_ENV_KEYS = [
  "MODEL_API_KEY",
  "DOCSFAB_NVIDIA_API_KEY",
  "NVIDIA_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "COMPATIBLE_API_KEY",
  "COMPATIBLE_ANTHROPIC_API_KEY",
  "INFERENCE_HUB_METADATA_API_KEY",
  "JUDGE_API_KEY",
] as const;

export const MODEL_PROFILE_API_FORMATS = ["chat_completions", "messages"] as const;
export type ModelProfileApiFormatName = (typeof MODEL_PROFILE_API_FORMATS)[number];

/**
 * Composition `deployment.transport` values that correspond to a profile
 * `MODEL_API_FORMAT`. `opaque-cli-managed` is omitted because those
 * compositions do not read a profile API format.
 */
export const COMPOSITION_TRANSPORT_API_FORMATS = {
  "openai-chat-completions": "chat_completions",
  "openai-responses": "chat_completions",
  "anthropic-messages": "messages",
} as const satisfies Record<ProviderTransport, ModelProfileApiFormatName>;

export type CompositionTransportWithApiFormat = keyof typeof COMPOSITION_TRANSPORT_API_FORMATS;

export function rejectedModelApiFormatMessage(value: string): string {
  return (
    `MODEL_API_FORMAT "${value}" is not a profile API format. ` +
    "Accepted values are chat_completions (composition transport openai-chat-completions or openai-responses) " +
    "and messages (composition transport anthropic-messages)."
  );
}

export function modelApiFormatFromCompositionTransport(
  transport: string,
): ModelProfileApiFormatName {
  if (!Object.hasOwn(COMPOSITION_TRANSPORT_API_FORMATS, transport)) {
    throw new Error(rejectedModelApiFormatMessage(transport));
  }
  return COMPOSITION_TRANSPORT_API_FORMATS[transport as CompositionTransportWithApiFormat];
}

export function parseModelApiFormatValue(value: string): ModelProfileApiFormatName {
  const trimmed = value.trim();
  if (trimmed === "chat_completions" || trimmed === "messages") return trimmed;
  if (Object.hasOwn(COMPOSITION_TRANSPORT_API_FORMATS, trimmed)) {
    return COMPOSITION_TRANSPORT_API_FORMATS[trimmed as CompositionTransportWithApiFormat];
  }
  throw new Error(rejectedModelApiFormatMessage(trimmed));
}

export function applyAmbientModelApiFormatFromCompositionTransport(
  environment: NodeJS.ProcessEnv,
): void {
  const raw = environment.MODEL_API_FORMAT;
  if (raw === undefined) return;
  const trimmed = raw.trim();
  if (!trimmed) return;
  environment.MODEL_API_FORMAT = parseModelApiFormatValue(trimmed);
}

function fieldMap(slot: ModelProfileSlot): typeof POLICY_FIELD_MAP {
  return slot === "policy" ? POLICY_FIELD_MAP : JUDGE_FIELD_MAP;
}

function stringifyProfileValue(field: keyof DocsFabModelProfileV1, value: unknown): string {
  if (
    field === "reasoning" ||
    field === "supportsDeveloperRole" ||
    field === "supportsReasoningEffort"
  ) {
    return value === true ? "true" : "false";
  }
  if (
    field === "contextWindow" ||
    field === "maxInputTokens" ||
    field === "maxOutputTokens" ||
    field === "apiMinOutputTokens" ||
    field === "contextReserveTokens"
  ) {
    return String(value);
  }
  return String(value);
}

function parseProfileScalar(
  field: keyof DocsFabModelProfileV1,
  value: unknown,
): string | number | boolean {
  if (value === undefined || value === null) {
    throw new Error(`Model profile field ${field} is required and must not be null.`);
  }
  if (
    field === "reasoning" ||
    field === "supportsDeveloperRole" ||
    field === "supportsReasoningEffort"
  ) {
    if (typeof value === "boolean") return value;
    const raw = String(value).trim().toLowerCase();
    if (raw === "true") return true;
    if (raw === "false") return false;
    throw new Error(`Model profile field ${field} must be the literal value true or false.`);
  }
  if (
    field === "contextWindow" ||
    field === "maxInputTokens" ||
    field === "maxOutputTokens" ||
    field === "apiMinOutputTokens" ||
    field === "contextReserveTokens"
  ) {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      throw new Error(`Model profile field ${field} must be a positive integer above zero.`);
    }
    return parsed;
  }
  const text = String(value).trim();
  if (!text) throw new Error(`Model profile field ${field} is required and must not be empty.`);
  if (field === "apiFormat") return parseModelApiFormatValue(text);
  return text;
}

export function modelProfileFromAssignments(
  slot: ModelProfileSlot,
  assignments: ReadonlyArray<readonly [string, string]>,
): DocsFabModelProfileV1 {
  const env = Object.fromEntries(assignments);
  const map = fieldMap(slot);
  const profile = {
    schemaVersion: MODEL_PROFILE_SCHEMA_VERSION,
    kind: "docsfab-model-profile" as const,
    slot,
  } as Record<string, unknown>;
  for (const [field, envName] of map) {
    profile[field] = parseProfileScalar(field, env[envName]);
  }
  const prefix = slot === "policy" ? "MODEL" : "JUDGE";
  assignEndpointOptions(profile, env[`${prefix}_TRANSPORT`], env[`${prefix}_CREDENTIAL_ENV`]);
  return profile as unknown as DocsFabModelProfileV1;
}

export function projectModelProfileToEnvironment(
  profile: DocsFabModelProfileV1,
  target: NodeJS.ProcessEnv,
): void {
  const map = fieldMap(profile.slot);
  for (const [field, envName] of map) {
    target[envName] = stringifyProfileValue(field, profile[field]);
  }
  const prefix = profile.slot === "policy" ? "MODEL" : "JUDGE";
  for (const [suffix, value] of [
    ["TRANSPORT", profile.transport],
    ["CREDENTIAL_ENV", profile.credentialEnv],
  ] as const) {
    if (value === undefined) delete target[`${prefix}_${suffix}`];
    else target[`${prefix}_${suffix}`] = value;
  }
}

/**
 * Project host paths. When a configuration root is given, relative host.yaml paths are anchored
 * to it; otherwise the loader would resolve them against the working directory and a command run
 * elsewhere would point at directories that do not exist.
 */
export function projectHostConfigToEnvironment(
  host: DocsFabHostConfigV1,
  target: NodeJS.ProcessEnv,
  configurationRoot?: string,
): void {
  for (const [field, envName] of HOST_PATH_MAP) {
    const value = host.paths?.[field];
    if (value === undefined) continue;
    target[envName] =
      configurationRoot !== undefined && !isAbsolute(value)
        ? resolve(configurationRoot, value)
        : value;
  }
  for (const [field, envName] of HOST_RETRY_MAP) {
    const value = host.retryPolicy?.[field];
    if (value === undefined) continue;
    target[envName] =
      field === "retryableCategories" && Array.isArray(value) ? value.join(",") : String(value);
  }
}

export function decodeHostConfig(value: unknown): DocsFabHostConfigV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The host.yaml configuration file must contain a mapping at its top level.");
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== HOST_CONFIG_SCHEMA_VERSION) {
    throw new Error(
      "The host.yaml configuration file must declare schemaVersion 1 at its top level.",
    );
  }
  if (record.kind !== "docsfab-host-config") {
    throw new Error(
      "The host.yaml configuration file must declare kind docsfab-host-config at its top level.",
    );
  }
  const activeExecutionProfile = optionalHostString(record.activeExecutionProfile);
  const compositionId = optionalHostString(record.compositionId);
  const activePolicyProfile = optionalHostString(record.activePolicyProfile);
  const active = record.active === undefined ? undefined : decodeActivePurposeSlots(record.active);
  const writingCompositionId = optionalHostString(active?.writing?.compositionId);
  if (!activeExecutionProfile && !compositionId && !activePolicyProfile && !writingCompositionId) {
    throw new Error(
      "The host.yaml configuration file must name a non-empty activeExecutionProfile, compositionId, active.writing compositionId, or activePolicyProfile value.",
    );
  }
  assertSameWritingProfileIds(activeExecutionProfile, compositionId, writingCompositionId);
  const host: DocsFabHostConfigV1 = {
    schemaVersion: HOST_CONFIG_SCHEMA_VERSION,
    kind: "docsfab-host-config",
    ...(activeExecutionProfile ? { activeExecutionProfile } : {}),
    ...(compositionId ? { compositionId } : {}),
    ...(activePolicyProfile ? { activePolicyProfile } : {}),
    ...(active ? { active } : {}),
  };
  if (record.activeJudgeProfile !== undefined) {
    const activeJudgeProfile = String(record.activeJudgeProfile).trim();
    if (activeJudgeProfile) host.activeJudgeProfile = activeJudgeProfile;
  }
  assertJudgeSlotAliases(host);
  if (record.paths !== undefined) {
    if (!record.paths || typeof record.paths !== "object" || Array.isArray(record.paths)) {
      throw new Error("The host.yaml paths field must be a mapping of path names to values.");
    }
    const paths = record.paths as Record<string, unknown>;
    host.paths = {};
    for (const [field] of HOST_PATH_MAP) {
      if (paths[field] === undefined) continue;
      const value = String(paths[field]).trim();
      if (SUPERSEDED_INSTALLED_ASSET_PATHS[field] === value) continue;
      host.paths[field] = value;
    }
  }
  if (record.retryPolicy !== undefined) {
    if (
      !record.retryPolicy ||
      typeof record.retryPolicy !== "object" ||
      Array.isArray(record.retryPolicy)
    ) {
      throw new Error(
        "The host.yaml retryPolicy field must be a mapping of policy names to values.",
      );
    }
    const retryPolicy = record.retryPolicy as Record<string, unknown>;
    host.retryPolicy = {};
    for (const [field] of HOST_RETRY_MAP) {
      if (retryPolicy[field] === undefined) continue;
      if (field === "retryableCategories") {
        const categories = retryPolicy[field];
        if (!Array.isArray(categories) || categories.some((item) => typeof item !== "string")) {
          throw new Error(
            "The host.yaml retryPolicy.retryableCategories field must be an array of strings.",
          );
        }
        host.retryPolicy.retryableCategories = categories
          .map((item) => item.trim())
          .filter(Boolean);
      } else {
        const parsed = Number(retryPolicy[field]);
        if (!Number.isSafeInteger(parsed) || parsed < 0) {
          throw new Error(`host.yaml retryPolicy.${field} must be a non-negative integer.`);
        }
        host.retryPolicy[field] = parsed;
      }
    }
  }
  return host;
}

export function decodeModelProfile(value: unknown): DocsFabModelProfileV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The model profile YAML file must contain a mapping at its top level.");
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== MODEL_PROFILE_SCHEMA_VERSION) {
    throw new Error("The model profile YAML file must declare schemaVersion 1 at its top level.");
  }
  if (record.kind !== "docsfab-model-profile") {
    throw new Error(
      "The model profile YAML file must declare kind docsfab-model-profile at its top level.",
    );
  }
  const slot = record.slot;
  if (slot !== "policy" && slot !== "judge") {
    throw new Error("The model profile YAML file must declare a slot of either policy or judge.");
  }
  const profile = {
    schemaVersion: MODEL_PROFILE_SCHEMA_VERSION,
    kind: "docsfab-model-profile" as const,
    slot,
  } as Record<string, unknown>;
  const map = fieldMap(slot);
  for (const [field] of map) {
    profile[field] = parseProfileScalar(field, record[field]);
  }
  assignEndpointOptions(profile, record.transport, record.credentialEnv);
  return profile as unknown as DocsFabModelProfileV1;
}

function assignEndpointOptions(
  profile: Record<string, unknown>,
  transport: unknown,
  credentialEnv: unknown,
): void {
  if (transport !== undefined) profile.transport = parseProviderTransport(String(transport));
  if (credentialEnv !== undefined) {
    assertCredentialEnvironmentName(String(credentialEnv));
    profile.credentialEnv = String(credentialEnv);
  }
}

const PROFILES_DIRECTORY_PREFIX = "profiles";

export function optionalHostString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text || undefined;
}

export function isYamlPolicyProfilePath(value: string): boolean {
  const normalized = value.trim();
  return normalized.startsWith(`${PROFILES_DIRECTORY_PREFIX}/`) || /\.ya?ml$/u.test(normalized);
}

function decodePurposeSlot(value: unknown, purpose: ExecutionPurpose): HostPurposeSlotV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`The host.yaml active.${purpose} field must be a mapping of slot properties.`);
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (
      key !== "compositionId" &&
      key !== "qualification" &&
      key !== "fallbackCompositionId" &&
      key !== "settings"
    ) {
      throw new Error(
        `The host.yaml active.${purpose} field does not accept the unknown property ${key}.`,
      );
    }
  }
  const compositionId = optionalHostString(record.compositionId);
  const fallbackCompositionId = optionalHostString(record.fallbackCompositionId);
  const settings =
    record.settings === undefined || record.settings === null
      ? undefined
      : decodeSlotSettings(record.settings, purpose);
  let qualification: PurposeSlotQualification | undefined;
  if (record.qualification !== undefined && record.qualification !== null) {
    const raw = String(record.qualification).trim();
    if (!PURPOSE_SLOT_QUALIFICATIONS.includes(raw as PurposeSlotQualification)) {
      throw new Error(
        "The host.yaml purpose-slot qualification must be not-run, failed, or qualified.",
      );
    }
    qualification = raw as PurposeSlotQualification;
  }
  return {
    ...(compositionId ? { compositionId } : {}),
    qualification: qualification ?? DEFAULT_PURPOSE_SLOT_QUALIFICATION,
    ...(fallbackCompositionId ? { fallbackCompositionId } : {}),
    ...(settings ? { settings } : {}),
  };
}

/** Decode `active.<slot>.settings`: model settings only, each checked as a flag would be. */
function decodeSlotSettings(value: unknown, purpose: ExecutionPurpose): ModelSettingValues {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      `The host.yaml active.${purpose}.settings field must be a mapping of model settings.`,
    );
  }
  const settings: Partial<Record<ModelSettingKey, ModelSettingValue>> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!isModelSettingKey(key)) {
      throw new Error(
        `The host.yaml active.${purpose}.settings field has no model setting named ${key}. Use one of: ${MODEL_SETTING_KEYS.join(", ")}.`,
      );
    }
    try {
      settings[key] = parseModelSettingValue(
        key,
        raw,
        `host.yaml active.${purpose}.settings.${key}`,
      );
    } catch (error) {
      if (error instanceof ModelSettingValueError) throw new Error(error.message);
      throw error;
    }
  }
  return settings;
}

function decodeActivePurposeSlots(value: unknown): NonNullable<DocsFabHostConfigV1["active"]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The host.yaml active field must be a mapping of purpose slot names.");
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "writing" && key !== "judge") {
      throw new Error("The host.yaml active field only accepts writing and judge purpose slots.");
    }
  }
  return {
    ...(record.writing !== undefined
      ? { writing: decodePurposeSlot(record.writing, "writing") }
      : {}),
    ...(record.judge !== undefined ? { judge: decodePurposeSlot(record.judge, "judge") } : {}),
  };
}

function assertSameWritingProfileIds(
  activeExecutionProfile: string | undefined,
  compositionId: string | undefined,
  writingCompositionId: string | undefined,
): void {
  const named = [activeExecutionProfile, compositionId, writingCompositionId].filter(
    (value): value is string => Boolean(value),
  );
  if (new Set(named).size > 1) {
    throw new Error(
      "The host.yaml activeExecutionProfile, compositionId, and active.writing compositionId fields must name the same installed profile.",
    );
  }
}

function assertJudgeSlotAliases(host: DocsFabHostConfigV1): void {
  const nested = host.active?.judge?.compositionId;
  const alias = host.activeJudgeProfile;
  if (!nested || !alias) return;
  if (isYamlPolicyProfilePath(alias)) {
    throw new Error(
      "The host.yaml active.judge compositionId cannot be combined with a YAML activeJudgeProfile path.",
    );
  }
  if (nested !== alias) {
    throw new Error(
      "The host.yaml active.judge compositionId must match the activeJudgeProfile composition alias.",
    );
  }
}

export function resolveHostExecutionProfileId(host: DocsFabHostConfigV1): string | undefined {
  const named = [
    host.activeExecutionProfile,
    host.compositionId,
    host.active?.writing?.compositionId,
  ].filter((value): value is string => Boolean(value));
  if (new Set(named).size > 1) {
    throw new Error(
      "The host.yaml activeExecutionProfile, compositionId, and active.writing compositionId fields must name the same installed profile.",
    );
  }
  if (named[0]) return named[0];
  if (host.activePolicyProfile && !isYamlPolicyProfilePath(host.activePolicyProfile)) {
    return host.activePolicyProfile;
  }
  return undefined;
}

export function resolveHostWritingSlot(host: DocsFabHostConfigV1): HostPurposeSlotV1 {
  const compositionId = resolveHostExecutionProfileId(host);
  const fromActive = host.active?.writing;
  return {
    ...(compositionId ? { compositionId } : {}),
    qualification: fromActive?.qualification ?? DEFAULT_PURPOSE_SLOT_QUALIFICATION,
    ...(fromActive?.fallbackCompositionId
      ? { fallbackCompositionId: fromActive.fallbackCompositionId }
      : {}),
    ...(fromActive?.settings ? { settings: fromActive.settings } : {}),
  };
}

export function resolveHostJudgeSlot(host: DocsFabHostConfigV1): HostPurposeSlotV1 {
  const fromActive = host.active?.judge;
  const alias = host.activeJudgeProfile;
  const aliasIsYaml = alias ? isYamlPolicyProfilePath(alias) : false;
  const aliasCompositionId = alias && !aliasIsYaml ? alias : undefined;
  if (fromActive?.compositionId && aliasIsYaml) {
    throw new Error(
      "The host.yaml active.judge compositionId cannot be combined with a YAML activeJudgeProfile path.",
    );
  }
  if (
    fromActive?.compositionId &&
    aliasCompositionId &&
    fromActive.compositionId !== aliasCompositionId
  ) {
    throw new Error(
      "The host.yaml active.judge compositionId must match the activeJudgeProfile composition alias.",
    );
  }
  const compositionId = fromActive?.compositionId ?? aliasCompositionId;
  return {
    ...(compositionId ? { compositionId } : {}),
    qualification: fromActive?.qualification ?? DEFAULT_PURPOSE_SLOT_QUALIFICATION,
    ...(fromActive?.fallbackCompositionId
      ? { fallbackCompositionId: fromActive.fallbackCompositionId }
      : {}),
    ...(fromActive?.settings ? { settings: fromActive.settings } : {}),
  };
}

export function resolveHostYamlJudgeProfile(host: DocsFabHostConfigV1): string | undefined {
  if (host.active?.judge?.compositionId) return undefined;
  if (host.activeJudgeProfile && isYamlPolicyProfilePath(host.activeJudgeProfile)) {
    return host.activeJudgeProfile;
  }
  return undefined;
}

export function resolveHostYamlPolicyProfile(host: DocsFabHostConfigV1): string | undefined {
  if (host.activePolicyProfile && isYamlPolicyProfilePath(host.activePolicyProfile)) {
    return host.activePolicyProfile;
  }
  return undefined;
}

function catalogLimitValue(name: string): number {
  const definition = LIMIT_DEFINITION_BY_NAME[name];
  if (!definition) {
    throw new Error(`Unknown operational limit ${name} is not declared in config/limits.yaml.`);
  }
  return definition.value;
}

export function defaultRetryPolicy(): NonNullable<DocsFabHostConfigV1["retryPolicy"]> {
  return {
    readOnlyMaxRetries: catalogLimitValue("retry.maxRetries"),
    readOnlyMaxTimeoutRetries: catalogLimitValue("retry.maxTimeoutRetries"),
    readOnlyMaxCutAnswerRetries: catalogLimitValue("retry.maxCutAnswerRetries"),
    readOnlyMaxNoProgressRetries: catalogLimitValue("retry.maxNoProgressRetries"),
    readOnlyMaxTransportRetries: catalogLimitValue("retry.maxTransportRetries"),
    baseDelayMs: catalogLimitValue("retry.baseDelayMs"),
    maxDelayMs: catalogLimitValue("retry.maxDelayMs"),
    // No category list: the default retries every category the taxonomy lets a
    // policy list (`config/retry-policy.ts`), and a host pins one only on purpose.
  };
}

export function defaultHostConfig(activePolicyProfile: string): DocsFabHostConfigV1 {
  return {
    schemaVersion: HOST_CONFIG_SCHEMA_VERSION,
    kind: "docsfab-host-config",
    activePolicyProfile,
    // Asset paths stay unset so the loader uses the installed package, not the configuration
    // root; host configuration owns only the writable state directory.
    paths: { stateDir: "./.docsfab/runs" },
    // Retry defaults, the category list included, stay in the catalog and
    // the taxonomy; generated host.yaml pins none, so a host follows them.
  };
}

export function defaultExecutionHostConfig(activeExecutionProfile: string): DocsFabHostConfigV1 {
  return {
    schemaVersion: HOST_CONFIG_SCHEMA_VERSION,
    kind: "docsfab-host-config",
    activeExecutionProfile,
    compositionId: activeExecutionProfile,
    active: {
      writing: {
        compositionId: activeExecutionProfile,
        qualification: DEFAULT_PURPOSE_SLOT_QUALIFICATION,
      },
    },
    paths: { stateDir: "./.docsfab/runs" },
    // Retry defaults, the category list included, stay in the catalog and
    // the taxonomy; generated host.yaml pins none, so a host follows them.
  };
}
