// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { basename, sep } from "node:path";

import { resolveDocsFabConfigurationRoot } from "../config/host-paths.js";
import { resolveHostConfigPath, resolveSecretsEnvPath } from "../config/split-layout.js";
import { LIMIT_DEFINITION_BY_NAME } from "../config/limits.generated.js";
import {
  isOperatorOverride,
  MODEL_SETTINGS_ORIGINS_VARIABLE,
  modelEndpointShapeProblem,
  type ModelSlotSettingsV1,
  parseModelSettingValue,
  readModelSlotSettings,
  reasoningEffortDecision,
} from "../config/model-settings.js";
import {
  OPERATIONAL_LIMIT_NAMES,
  clampedLimitStop,
  formatOperationalLimitStop,
  type OperationalLimitName,
} from "../config/limit-stop.js";
import type {
  InstalledAnswerSubmission,
  InstalledRequestPolicy,
  MeasuredReasoningControl,
} from "../model-composition/types.js";
import type { EndpointSource } from "../security/model-credential-release.js";
import { redactDirectConfiguredCredentials } from "../security/configured-credentials.js";
import { redactCredentialMaterial } from "../security/credential-material-core.js";
import { escapeUndisplayable } from "../shared/display-text.js";
import { assertRawModelIdNotRetired } from "../setup/retired-selections.js";
import { assertModelEndpointTransport } from "./endpoint-transport.js";
import {
  assertCredentialEnvironmentName,
  parseProviderTransport,
  type ProviderTransport,
} from "../config/model-providers.js";

export type { ProviderTransport } from "../config/model-providers.js";

export type ModelProfileApiFormat = "chat_completions" | "messages";

export interface ModelEndpointConfig {
  providerId: string;
  baseUrl: string;
  /** Where `baseUrl` came from; absent is unlabelled operator configuration. */
  endpointSource?: EndpointSource;
  modelId: string;
  apiFormat: ModelProfileApiFormat;
  api: "openai-completions";
  /** Explicit protocol for operator-configured endpoints; absent on legacy profiles. */
  transport?: ProviderTransport;
  credentialEnv?: string;
  /** Private host selection carried with this loaded endpoint, never a credential. */
  compositionId?: string;
  apiKey: string;
  profile: ModelProfile;
  requestPolicy: {
    minimumOutputTokens: number;
    reservedContextTokens: number;
  };
  /**
   * Each effective model setting with its source, and the selected preset.
   * Absent on a configuration built in code rather than loaded.
   */
  modelSettings?: ModelSlotSettingsV1;
}

/**
 * The credential family selected before a provider connection is constructed.
 * `legacy-configured-endpoint` is a compatibility bridge for the original
 * MODEL_* endpoint contract; new compositions must select a route-specific
 * family.
 */
export type ProviderCredentialFamily =
  | "nvidia-inference-api"
  | "nvidia-api-catalog"
  | "openai-api"
  | "anthropic-api"
  | "openai-compatible-api"
  | "anthropic-compatible-api"
  | "legacy-configured-endpoint";

export interface ProviderCredential {
  family: ProviderCredentialFamily;
  apiKey: string;
}

/**
 * Credential-free profile frozen after composition resolution. Model identity,
 * serving route, transport, and operational limits are independent fields;
 * none is inferred from another.
 */
export interface BoundModelExecutionProfile {
  routeId: string;
  providerId: string;
  baseUrl: string;
  /**
   * Where `baseUrl` came from. The model key is released only for an operator
   * source; absent is unlabelled operator configuration.
   */
  endpointSource?: EndpointSource;
  modelId: string;
  transport: ProviderTransport;
  /** Compatibility projection used by the current profile-evidence schema. */
  apiFormat: ModelProfileApiFormat;
  profile: ModelProfile;
  requestPolicy: ModelEndpointConfig["requestPolicy"];
  /**
   * The reasoning effort each request sends, as the operator set it. Absent
   * sends none, so the provider default applies.
   */
  reasoningEffort?: string;
  /**
   * Present when an operator source set reasoning or an effort for this
   * model's slot. One-shot calls (request interpretation, the first-pass
   * checks, the judges) then send that reasoning too; otherwise they keep
   * their own policy, thinking off.
   */
  reasoningSetByOperator?: true;
  /** Closed provider-payload policy from the exact installed composition. */
  compositionRequestPolicy?: InstalledRequestPolicy;
  /**
   * Reasoning control installed compositions measured for this model, applied
   * to an unmatched chat-completions endpoint whose profile declares reasoning
   * off. Never set together with `compositionRequestPolicy`.
   */
  measuredReasoningControl?: MeasuredReasoningControl;
  /**
   * The answer submission recorded for this route: the bound
   * composition's own, or one an unmatched chat-completions endpoint borrows
   * by exact model ID and proven recorded origin. Absent means the route has
   * none recorded, and the final quality evaluator answers in text.
   */
  answerSubmission?: InstalledAnswerSubmission;
  /** Non-authoritative operational ceilings present only on the composition path. */
  compositionPolicy?: {
    maxProviderTurns: number;
    timeoutMs: number;
    maxResponseBytes: number;
  };
  /**
   * How DocsFab admits input against a context window.
   * `host-window` uses the bound profile windows. `provider` skips DocsFab
   * context admission so an unmatched, unattested selection is not given a
   * fake host ceiling.
   */
  contextAdmission?: "host-window" | "provider";
}

/**
 * Conservative unmatched-BYO bridge. Ordinary model-profile unique matching
 * uses resolveOperatorExecutionBinding; this helper never guesses a route
 * from a model ID and does not attach composition request policy.
 */
export function bindModelExecutionProfile(config: ModelEndpointConfig): {
  profile: BoundModelExecutionProfile;
  credential: ProviderCredential;
} {
  return {
    profile: bindModelExecutionIdentity(config),
    credential: {
      family: config.transport
        ? config.providerId === "openai-api"
          ? "openai-api"
          : config.providerId === "anthropic-api"
            ? "anthropic-api"
            : config.transport === "anthropic-messages"
              ? "anthropic-compatible-api"
              : "openai-compatible-api"
        : "legacy-configured-endpoint",
      apiKey: config.apiKey,
    },
  };
}

/**
 * The reasoning a configuration asks for before binding. An operator's
 * setting wins over the profile's, attested or not: a profile is a default.
 * An effort turns reasoning on unless an operator set reasoning to false;
 * then the effort is dropped and recorded. `reasoning` is undefined when no
 * operator set it, and `profileReasoning` is the profile's own value.
 */
export function requestedReasoning(config: ModelEndpointConfig): {
  readonly reasoning?: boolean;
  readonly effort?: string;
  readonly profileReasoning?: boolean;
} {
  const settings = config.modelSettings;
  const decision = settings ? reasoningEffortDecision(settings) : undefined;
  const effort = decision?.effort;
  const operatorReasoning =
    settings && isOperatorOverride(settings.settings.reasoning) ? decision?.reasoning : undefined;
  const reasoning = effort ? true : operatorReasoning;
  return {
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(effort ? { effort } : {}),
    ...(config.profile ? { profileReasoning: config.profile.reasoning } : {}),
  };
}

/** Credential-free projection for planning and identity inspection. */
export function bindModelExecutionIdentity(
  config: ModelEndpointConfig,
): BoundModelExecutionProfile {
  const requested = requestedReasoning(config);
  const reasoning = requested.reasoning;
  return {
    routeId: config.providerId,
    providerId: config.providerId,
    baseUrl: config.baseUrl,
    ...(config.endpointSource !== undefined ? { endpointSource: config.endpointSource } : {}),
    modelId: config.modelId,
    transport: config.transport ?? "openai-chat-completions",
    apiFormat: config.apiFormat,
    profile:
      reasoning === undefined || reasoning === config.profile?.reasoning
        ? config.profile
        : { ...config.profile, reasoning },
    requestPolicy: config.requestPolicy,
    ...(requested.effort ? { reasoningEffort: requested.effort } : {}),
    ...(requested.reasoning !== undefined ? { reasoningSetByOperator: true as const } : {}),
    contextAdmission: config.profile?.metadata?.status === "current" ? "host-window" : "provider",
  };
}

/**
 * The review date is an advisory reminder, never an expiry.
 * True exactly when an attested `reviewAfter` day (UTC) is strictly before
 * the UTC day of `asOf`; the review date itself is not overdue, and absent
 * metadata (`null` or absent) never is. An invalid `asOf` throws. Display
 * surfaces call this; it must not feed `ModelProfile`, `ModelProfileMetadata`,
 * or any digested projection, or run identity would change across the date
 * with no configuration change.
 */
export function isReviewOverdue(reviewAfter: string | null | undefined, asOf: Date): boolean {
  return typeof reviewAfter === "string" && reviewAfter < utcDay(asOf);
}

/** The `YYYY-MM-DD` UTC calendar day of an instant: the ISO date prefix. */
function utcDay(instant: Date): string {
  return instant.toISOString().slice(0, "YYYY-MM-DD".length);
}

export interface ModelProfileMetadata {
  /** Operator-approved metadata reference. Null means no source is approved. */
  approvedSource: string | null;
  effectiveDate: string | null;
  reviewAfter: string | null;
  status: "current" | "stale" | "unknown";
}

export interface ModelProfile {
  configuredLimits: {
    contextWindow: number;
    maxInputTokens: number;
    maxOutputTokens: number;
  };
  contextWindow: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  effectiveLimitReason: "none" | "metadata-unknown" | "metadata-stale" | "composition-candidate";
  reasoning: boolean;
  input: Array<"text" | "image">;
  compatibility: {
    supportsDeveloperRole: boolean;
    supportsReasoningEffort: boolean;
    apiFormats: ModelProfileApiFormat[];
  };
  costPerMillionTokens: {
    input: number | null;
    output: number | null;
    cacheRead: number | null;
    cacheWrite: number | null;
  };
  metadata: ModelProfileMetadata;
}

/**
 * YAML fill-in for unmatched setup profiles that still require numeric
 * fields. The window is not an executable DocsFab context ceiling:
 * unmatched unattested selections skip host admission, and unique
 * composition matches use installed windows. The output allowance is the
 * per-turn request allowance those selections send.
 */
export const CONSERVATIVE_MODEL_FALLBACK = Object.freeze({
  contextWindow: catalogValue(OPERATIONAL_LIMIT_NAMES.modelProfileFallbackContextWindow),
  maxOutputTokens: catalogValue(OPERATIONAL_LIMIT_NAMES.modelProfileFallbackMaxOutputTokens),
});

// Read from the generated mirror: `config/limits.ts` imports host
// configuration, which imports this module.
function catalogValue(name: OperationalLimitName): number {
  const definition = LIMIT_DEFINITION_BY_NAME[name];
  if (!definition) {
    throw new Error(`Operational limit ${name} is not declared in the generated limits catalog.`);
  }
  return definition.value;
}

export interface ModelProfileConfigurationIssue {
  profile: "MODEL" | "JUDGE";
  field: string;
  message: string;
}

/** Content-minimized refusal for invalid owner configuration during approval. */
export class InvalidModelProfileConfigurationError extends Error {
  readonly code = "invalid-model-profile-configuration" as const;
  readonly fields: readonly string[];
  readonly nextAction: string;

  constructor(issues: readonly ModelProfileConfigurationIssue[]) {
    const fields = [
      ...new Set(
        issues.map(({ profile, field }) =>
          field.startsWith(`${profile}_`) ? field : `${profile}_${field}`,
        ),
      ),
    ].sort();
    super(`Model profile configuration has invalid fields: ${fields.join(", ")}.`);
    this.name = "InvalidModelProfileConfigurationError";
    this.fields = fields;
    this.nextAction =
      `Correct ${fields.join(", ")} in the environment or DocsFab configuration root, ` +
      "then run `docsfab doctor` to confirm the profile loads.";
  }
}

/** Safe typed refusal when the selected profile API format cannot be approved. */
export class UnsupportedModelProfileApiFormatError extends Error {
  readonly code = "unsupported-model-profile-api-format" as const;
  readonly field: "MODEL_API_FORMAT" | "JUDGE_API_FORMAT";

  constructor(purpose: "policy" | "judge") {
    const field = purpose === "judge" ? "JUDGE_API_FORMAT" : "MODEL_API_FORMAT";
    super(`${field} must select a supported API format for profile approval.`);
    this.name = "UnsupportedModelProfileApiFormatError";
    this.field = field;
  }
}

export const MODEL_PROFILE_CLAMP_REMEDIATION =
  "The effective window is below the configured YAML/config value because an installed composition or host limit reduced it. Attest current metadata to own the YAML numbers, or re-qualify the composition window.";

/**
 * The clamps that actually bound this profile: configured windows compared to
 * the effective windows after any later reduction, such as a unique
 * composition `min()`. Empty when nothing was reduced.
 */
export function modelProfileLimitClampIssues(
  profile: ModelProfile,
  prefix: "MODEL" | "JUDGE" = "MODEL",
): ModelProfileConfigurationIssue[] {
  const clamps: Array<{
    field: string;
    limit: OperationalLimitName;
    effective: number;
    requested: number;
  }> = [
    {
      field: `${prefix}_CONTEXT_WINDOW`,
      limit: OPERATIONAL_LIMIT_NAMES.modelProfileFallbackContextWindow,
      effective: profile.contextWindow,
      requested: profile.configuredLimits.contextWindow,
    },
    {
      field: `${prefix}_MAX_INPUT_TOKENS`,
      limit: OPERATIONAL_LIMIT_NAMES.modelProfileFallbackMaxInputTokens,
      effective: profile.maxInputTokens,
      requested: profile.configuredLimits.maxInputTokens,
    },
    {
      field: `${prefix}_MAX_OUTPUT_TOKENS`,
      limit: OPERATIONAL_LIMIT_NAMES.modelProfileFallbackMaxOutputTokens,
      effective: profile.maxOutputTokens,
      requested: profile.configuredLimits.maxOutputTokens,
    },
  ];
  return clamps.flatMap((clamp) => {
    const stop = clampedLimitStop({
      limit: clamp.limit,
      unit: "tokens",
      configured: clamp.effective,
      requested: clamp.requested,
      remediation: MODEL_PROFILE_CLAMP_REMEDIATION,
    });
    return stop
      ? [{ profile: prefix, field: clamp.field, message: formatOperationalLimitStop(stop) }]
      : [];
  });
}

export type ModelProfileConfigurationOrigin = "fresh" | "legacy";

export interface ModelProfileMigrationOptions {
  origin?: ModelProfileConfigurationOrigin;
}

/**
 * "no-profile" means every field DocsFab checked for every affected profile
 * (MODEL and/or JUDGE) is entirely absent from the environment — the
 * operator has not configured a MODEL_* block at all (the typical first-run
 * `do`/`run` shape). "missing-primary-credential" is the narrow setup-recovery
 * case where every MODEL field except MODEL_API_KEY is present. Other partially
 * configured or malformed profiles are "invalid-profile", where correcting the
 * listed fields remains the actionable next step.
 */
function classifyModelProfileMigrationReason(
  issues: ModelProfileConfigurationIssue[],
): "no-profile" | "missing-primary-credential" | "invalid-profile" {
  if (issues.length === 0) return "invalid-profile";
  if (
    issues.length === 1 &&
    issues[0]?.profile === "MODEL" &&
    issues[0].field === "MODEL_API_KEY" &&
    (issues[0].message === "missing required environment variable" ||
      issues[0].message.startsWith("missing credential referenced by MODEL_CREDENTIAL_ENV:"))
  ) {
    return "missing-primary-credential";
  }
  const byProfile = new Map<"MODEL" | "JUDGE", ModelProfileConfigurationIssue[]>();
  for (const issue of issues) {
    const list = byProfile.get(issue.profile) ?? [];
    list.push(issue);
    byProfile.set(issue.profile, list);
  }
  for (const [profile, profileIssues] of byProfile) {
    const expectedFields = profileFieldNames(profile);
    if (
      profileIssues.length !== expectedFields.length ||
      profileIssues.some((issue) => !expectedFields.includes(issue.field)) ||
      new Set(profileIssues.map((issue) => issue.field)).size !== expectedFields.length
    ) {
      return "invalid-profile";
    }
    if (profileIssues.some((issue) => issue.message !== "missing required environment variable")) {
      return "invalid-profile";
    }
  }
  return "no-profile";
}

/** Local-only, generated paths retained without keeping the environment or secret values. */
const localMissingProfileLocators = new WeakMap<ModelProfileMigrationError, readonly string[]>();

function createLocalMissingProfileLocator(environment?: NodeJS.ProcessEnv): readonly string[] {
  const root = resolveDocsFabConfigurationRoot(environment);
  const screenedRoot = redactDirectConfiguredCredentials(
    redactDirectConfiguredCredentials(root, environment),
  );
  const displayRoot = escapeUndisplayable(redactCredentialMaterial(screenedRoot));
  const hostFile = basename(resolveHostConfigPath(root));
  const secretsFile = basename(resolveSecretsEnvPath(root));
  return Object.freeze([
    `Configuration root: ${displayRoot}`,
    `Host configuration: ${displayRoot}${sep}${hostFile}`,
    `Credential file: ${displayRoot}${sep}${secretsFile}`,
  ]);
}

/** A generated local locator exists only for a genuine missing-profile error. */
export function localMissingModelProfileLocator(error: unknown): readonly string[] | undefined {
  return error instanceof ModelProfileMigrationError
    ? localMissingProfileLocators.get(error)
    : undefined;
}

/**
 * Length cap for operator-configured values echoed in a public error message.
 * `sanitizeDisplayText` also strips C0/C1 controls: BASE_URL and PROVIDER are
 * untrusted and can carry newlines or escapes that forge report lines.
 */
const displayTextCharCeiling = 200;

function isDisplayControlCodePoint(codePoint: number): boolean {
  // C0 controls (0x00-0x1F), DEL (0x7F), and C1 controls (0x80-0x9F).
  return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
}
function sanitizeDisplayText(value: string): string {
  const characters = Array.from(value);
  const kept = characters.filter(
    (character) => !isDisplayControlCodePoint(character.codePointAt(0) ?? 0),
  );
  const stripped = kept.join("");
  return stripped.length > displayTextCharCeiling
    ? stripped.slice(0, displayTextCharCeiling) + "..."
    : stripped;
}

/**
 * Display a configured BASE_URL as origin and path only. The profile collector
 * accepts userinfo, query, and fragment, any of which can carry a credential,
 * so they are excluded. Returns null when the value is not an HTTP(S) URL.
 */
function safeRouteUrlDisplay(rawBaseUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawBaseUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const pathname = url.pathname === "/" ? "" : url.pathname;
  return sanitizeDisplayText(`${url.protocol}//${url.host}${pathname}`);
}

/**
 * Name the serving route a missing-credential report is about. The provider is
 * sanitized and the base URL goes through {@link safeRouteUrlDisplay}, so
 * hostile configured strings are never interpolated raw.
 */
function describeSelectedModelRoute(
  prefix: "MODEL" | "JUDGE",
  environment: NodeJS.ProcessEnv | undefined,
): string {
  const rawProvider = environment?.[`${prefix}_PROVIDER`]?.trim();
  const provider = rawProvider ? sanitizeDisplayText(rawProvider) : undefined;
  const rawBaseUrl = environment?.[`${prefix}_BASE_URL`]?.trim();
  const baseUrlDisplay = rawBaseUrl ? safeRouteUrlDisplay(rawBaseUrl) : null;
  if (provider && baseUrlDisplay)
    return `the "${provider}" route (${prefix}_BASE_URL: ${baseUrlDisplay})`;
  if (provider) return `the "${provider}" route`;
  return `the selected ${prefix} route`;
}

/**
 * Environment-variable name grammar, matching
 * {@link assertCredentialEnvironmentName} in config/model-providers.ts.
 * Re-checked as defense in depth so a public error message never interpolates
 * a *_CREDENTIAL_ENV value raw.
 */
const CREDENTIAL_VARIABLE_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/u;

function safeCredentialVariableName(value: string | undefined): string | null {
  if (!value) return null;
  return CREDENTIAL_VARIABLE_NAME_PATTERN.test(value) ? value : null;
}

/**
 * Action text for the single-issue "missing-primary-credential" report. Names
 * the exact variable the selected route requires (the field, or the
 * *_CREDENTIAL_ENV target), echoing only names that pass
 * {@link safeCredentialVariableName} and never a credential value; a malformed
 * redirected name falls back to the known-safe issue field.
 */
function missingPrimaryCredentialAction(
  issue: ModelProfileConfigurationIssue,
  environment: NodeJS.ProcessEnv | undefined,
): string {
  const viaCredentialEnv = issue.message.startsWith("missing credential referenced by");
  const requiredVariable = viaCredentialEnv
    ? (safeCredentialVariableName(environment?.[`${issue.profile}_CREDENTIAL_ENV`]?.trim()) ??
      issue.field)
    : issue.field;
  const route = describeSelectedModelRoute(issue.profile, environment);
  return viaCredentialEnv
    ? `Run \`docsfab setup\` and enter the ${requiredVariable} value required by ${route} through the hidden prompt before retrying.`
    : `Set ${requiredVariable}, the credential ${route} requires, through the hidden setup prompt before retrying.`;
}

export class ModelProfileMigrationError extends Error {
  readonly code = "migration-required" as const;
  readonly issues: ModelProfileConfigurationIssue[];
  /** See {@link classifyModelProfileMigrationReason}. */
  readonly reason: "no-profile" | "missing-primary-credential" | "invalid-profile";
  readonly origin: ModelProfileConfigurationOrigin | undefined;
  readonly nextAction?: string;

  constructor(
    issues: ModelProfileConfigurationIssue[],
    options: ModelProfileMigrationOptions = {},
    /** Read only to name a route/variable in the message; never persisted. */
    environment?: NodeJS.ProcessEnv,
  ) {
    const reason = classifyModelProfileMigrationReason(issues);
    const localLocator =
      reason === "no-profile" ? createLocalMissingProfileLocator(environment) : undefined;
    const sections = (["MODEL", "JUDGE"] as const)
      .map((profile) => {
        const profileIssues = issues.filter((issue) => issue.profile === profile);
        if (profileIssues.length === 0) return null;
        return [
          `${profile} profile (${profileIssues.length} issue${profileIssues.length === 1 ? "" : "s"}):`,
          ...profileIssues.map((issue) => `- ${issue.field}: ${issue.message}`),
        ].join("\n");
      })
      .filter((section): section is string => section !== null);
    super(
      reason === "no-profile"
        ? [
            "DocsFab found no loadable model profile. No MODEL_* (or JUDGE_*) environment variables are configured; this is not a schema migration.",
            "Configuration files: host.yaml and secrets.env in the selected configuration root.",
            ...sections,
            options.origin === "fresh"
              ? "Action: run `docsfab setup` to create the initial configuration, then set MODEL_API_KEY through the hidden setup prompt."
              : "Action: run `docsfab profile seed --preset <id>` to create an unsigned profile (without --preset it names the choices), then set MODEL_API_KEY before retrying.",
            "No credential values are included in this report.",
          ].join("\n")
        : reason === "missing-primary-credential"
          ? [
              "DocsFab found a configured model profile without its primary credential.",
              ...sections,
              missingPrimaryCredentialAction(issues[0]!, environment),
              "No credential values are included in this report.",
            ].join("\n")
          : [
              "Model profile migration required. DocsFab did not register an invalid or incompatible profile.",
              ...sections,
              "Action: add or correct the listed fields using .env.example. Keep the three *_PROFILE_* provenance fields set to unknown unless an operator has approved a source and dates.",
              "No credential values are included in this report.",
            ].join("\n"),
    );
    this.name = "ModelProfileMigrationError";
    this.origin = options.origin;
    this.issues = issues;
    this.reason = reason;
    if (localLocator) localMissingProfileLocators.set(this, localLocator);
    if (reason === "invalid-profile") {
      this.nextAction =
        "Correct the listed MODEL_* or JUDGE_* fields in the environment or DocsFab configuration root, then run `docsfab doctor` to confirm the profile loads.";
    }
  }
}

function requireValue(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}.`);
  return value;
}

function positiveInteger(environment: NodeJS.ProcessEnv, name: string): number {
  const raw = requireValue(environment, name);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function costValue(environment: NodeJS.ProcessEnv, name: string): number | null {
  const raw = requireValue(environment, name);
  if (raw.toLowerCase() === "unknown") return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number or unknown.`);
  }
  return value;
}

function booleanValue(environment: NodeJS.ProcessEnv, name: string): boolean {
  const raw = requireValue(environment, name).toLowerCase();
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`${name} must be true or false.`);
}

function inputTypes(environment: NodeJS.ProcessEnv, name: string): Array<"text" | "image"> {
  const values = requireValue(environment, name)
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (values.length === 0 || values.some((value) => value !== "text" && value !== "image")) {
    throw new Error(`${name} must contain only text and image.`);
  }
  return [...new Set(values)] as Array<"text" | "image">;
}

function apiFormats(environment: NodeJS.ProcessEnv, name: string): ModelProfileApiFormat[] {
  const values = requireValue(environment, name)
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (
    values.length === 0 ||
    values.some((value) => value !== "chat_completions" && value !== "messages")
  ) {
    throw new Error(`${name} must contain only chat_completions and messages.`);
  }
  return [...new Set(values)] as ModelProfileApiFormat[];
}

function isoDate(raw: string, name: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new Error(`${name} must be a YYYY-MM-DD date or unknown.`);
  }
  const parsed = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || utcDay(parsed) !== raw) {
    throw new Error(`${name} must be a valid YYYY-MM-DD date or unknown.`);
  }
  return raw;
}

function parseProfileMetadata(
  environment: NodeJS.ProcessEnv,
  prefix: "MODEL" | "JUDGE",
  now: Date,
): ModelProfileMetadata {
  const sourceRaw = requireValue(environment, `${prefix}_PROFILE_APPROVED_SOURCE`);
  const effectiveRaw = requireValue(environment, `${prefix}_PROFILE_EFFECTIVE_DATE`);
  const reviewRaw = requireValue(environment, `${prefix}_PROFILE_REVIEW_AFTER`);
  const unknown = [sourceRaw, effectiveRaw, reviewRaw].map(
    (value) => value.toLowerCase() === "unknown",
  );
  if (unknown.every(Boolean)) {
    return {
      approvedSource: null,
      effectiveDate: null,
      reviewAfter: null,
      status: "unknown",
    };
  }
  if (unknown.some(Boolean)) {
    throw new Error(
      `${prefix}_PROFILE_APPROVED_SOURCE, ${prefix}_PROFILE_EFFECTIVE_DATE, and ${prefix}_PROFILE_REVIEW_AFTER must all be supplied or all be unknown.`,
    );
  }

  let source: URL;
  try {
    source = new URL(sourceRaw);
  } catch {
    throw new Error(
      `${prefix}_PROFILE_APPROVED_SOURCE must be an HTTPS URL without credentials or unknown.`,
    );
  }
  if (source.protocol !== "https:" || source.username !== "" || source.password !== "") {
    throw new Error(
      `${prefix}_PROFILE_APPROVED_SOURCE must be an HTTPS URL without credentials or unknown.`,
    );
  }
  const effectiveDate = isoDate(effectiveRaw, `${prefix}_PROFILE_EFFECTIVE_DATE`);
  const reviewAfter = isoDate(reviewRaw, `${prefix}_PROFILE_REVIEW_AFTER`);
  const today = utcDay(now);
  if (effectiveDate > today) {
    throw new Error(`${prefix}_PROFILE_EFFECTIVE_DATE must not be in the future.`);
  }
  if (reviewAfter < effectiveDate) {
    throw new Error(
      `${prefix}_PROFILE_REVIEW_AFTER must not precede ${prefix}_PROFILE_EFFECTIVE_DATE.`,
    );
  }
  // A passed review date is advisory (see `isReviewOverdue`), so an attested
  // profile is current on both sides of the date. `stale` stays decodable for
  // saved records and packets.
  return {
    approvedSource: source.toString(),
    effectiveDate,
    reviewAfter,
    status: "current",
  };
}

function profileFieldNames(prefix: "MODEL" | "JUDGE"): string[] {
  return [
    `${prefix}_PROVIDER`,
    `${prefix}_BASE_URL`,
    prefix === "MODEL" ? "MODEL_ID" : "JUDGE_MODEL_ID",
    `${prefix}_API_FORMAT`,
    `${prefix}_API_KEY`,
    `${prefix}_CONTEXT_WINDOW`,
    `${prefix}_MAX_OUTPUT_TOKENS`,
    `${prefix}_API_MIN_OUTPUT_TOKENS`,
    `${prefix}_CONTEXT_RESERVE_TOKENS`,
    `${prefix}_REASONING`,
    `${prefix}_INPUT_TYPES`,
    `${prefix}_SUPPORTS_DEVELOPER_ROLE`,
    `${prefix}_SUPPORTS_REASONING_EFFORT`,
    `${prefix}_COMPATIBLE_API_FORMATS`,
    `${prefix}_INPUT_COST_PER_MILLION`,
    `${prefix}_OUTPUT_COST_PER_MILLION`,
    `${prefix}_CACHE_READ_COST_PER_MILLION`,
    `${prefix}_CACHE_WRITE_COST_PER_MILLION`,
    `${prefix}_PROFILE_APPROVED_SOURCE`,
    `${prefix}_PROFILE_EFFECTIVE_DATE`,
    `${prefix}_PROFILE_REVIEW_AFTER`,
  ];
}

function collectModelProfileIssues(
  environment: NodeJS.ProcessEnv,
  prefix: "MODEL" | "JUDGE",
  now: Date,
): ModelProfileConfigurationIssue[] {
  const credentialEnv = environment[`${prefix}_CREDENTIAL_ENV`];
  if (credentialEnv !== undefined) assertCredentialEnvironmentName(credentialEnv);
  const issues: ModelProfileConfigurationIssue[] = [];
  const add = (field: string, message: string): void => {
    issues.push({ profile: prefix, field, message });
  };
  const present = (field: string): boolean => Boolean(environment[field]?.trim());
  const check = (field: string, validation: () => unknown): void => {
    if (!present(field)) return;
    try {
      validation();
    } catch (error) {
      add(field, error instanceof Error ? error.message : String(error));
    }
  };

  for (const field of profileFieldNames(prefix)) {
    const source = field === `${prefix}_API_KEY` ? (credentialEnv ?? field) : field;
    if (!present(source)) {
      add(
        field,
        credentialEnv && source === credentialEnv
          ? `missing credential referenced by ${prefix}_CREDENTIAL_ENV: ${credentialEnv}`
          : "missing required environment variable",
      );
    }
  }

  const contextField = `${prefix}_CONTEXT_WINDOW`;
  const inputLimitField = `${prefix}_MAX_INPUT_TOKENS`;
  const outputField = `${prefix}_MAX_OUTPUT_TOKENS`;
  const minimumOutputField = `${prefix}_API_MIN_OUTPUT_TOKENS`;
  const reserveField = `${prefix}_CONTEXT_RESERVE_TOKENS`;
  const reasoningField = `${prefix}_REASONING`;
  const developerRoleField = `${prefix}_SUPPORTS_DEVELOPER_ROLE`;
  const reasoningEffortField = `${prefix}_SUPPORTS_REASONING_EFFORT`;
  const inputField = `${prefix}_INPUT_TYPES`;
  const compatibleFormatsField = `${prefix}_COMPATIBLE_API_FORMATS`;
  const apiFormatField = `${prefix}_API_FORMAT`;
  const baseUrlField = `${prefix}_BASE_URL`;
  const sourceField = `${prefix}_PROFILE_APPROVED_SOURCE`;
  const effectiveField = `${prefix}_PROFILE_EFFECTIVE_DATE`;
  const reviewField = `${prefix}_PROFILE_REVIEW_AFTER`;

  check(contextField, () => positiveInteger(environment, contextField));
  check(inputLimitField, () => positiveInteger(environment, inputLimitField));
  check(outputField, () => positiveInteger(environment, outputField));
  check(minimumOutputField, () => positiveInteger(environment, minimumOutputField));
  check(reserveField, () => positiveInteger(environment, reserveField));
  check(reasoningField, () => booleanValue(environment, reasoningField));
  check(developerRoleField, () => booleanValue(environment, developerRoleField));
  check(reasoningEffortField, () => booleanValue(environment, reasoningEffortField));
  check(inputField, () => inputTypes(environment, inputField));
  check(compatibleFormatsField, () => apiFormats(environment, compatibleFormatsField));
  for (const suffix of [
    "INPUT_COST_PER_MILLION",
    "OUTPUT_COST_PER_MILLION",
    "CACHE_READ_COST_PER_MILLION",
    "CACHE_WRITE_COST_PER_MILLION",
  ]) {
    const field = `${prefix}_${suffix}`;
    check(field, () => costValue(environment, field));
  }
  const reasoningEffortValueField = `${prefix}_REASONING_EFFORT`;
  check(reasoningEffortValueField, () =>
    parseModelSettingValue(
      "reasoningEffort",
      environment[reasoningEffortValueField],
      reasoningEffortValueField,
    ),
  );
  check(apiFormatField, () => {
    const value = requireValue(environment, apiFormatField);
    if (value !== "chat_completions" && value !== "messages") {
      throw new Error("must select either chat_completions or messages for this profile.");
    }
  });
  check(baseUrlField, () => {
    const value = requireValue(environment, baseUrlField);
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error("must be a valid HTTP or HTTPS URL");
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error("must use HTTP or HTTPS");
    }
    const problem = modelEndpointShapeProblem(url);
    if (problem) throw new Error(problem);
  });

  const sourceRaw = environment[sourceField]?.trim();
  const effectiveRaw = environment[effectiveField]?.trim();
  const reviewRaw = environment[reviewField]?.trim();
  const provenance = [sourceRaw, effectiveRaw, reviewRaw];
  if (provenance.every(Boolean)) {
    const unknown = provenance.map((value) => value?.toLowerCase() === "unknown");
    if (unknown.some(Boolean) && !unknown.every(Boolean)) {
      add(
        `${prefix}_PROFILE_*`,
        "approved source, effective date, and review date must all be supplied or all be unknown",
      );
    } else if (!unknown.every(Boolean)) {
      check(sourceField, () => {
        let source: URL;
        try {
          source = new URL(sourceRaw ?? "");
        } catch {
          throw new Error("must be an HTTPS URL without credentials or unknown");
        }
        if (source.protocol !== "https:" || source.username !== "" || source.password !== "") {
          throw new Error("must be an HTTPS URL without credentials or unknown");
        }
      });
      check(effectiveField, () => isoDate(effectiveRaw ?? "", effectiveField));
      check(reviewField, () => isoDate(reviewRaw ?? "", reviewField));
      try {
        const effectiveDate = isoDate(effectiveRaw ?? "", effectiveField);
        const reviewAfter = isoDate(reviewRaw ?? "", reviewField);
        const today = utcDay(now);
        if (effectiveDate > today) {
          add(effectiveField, "must not be in the future");
        }
        if (reviewAfter < effectiveDate) {
          add(reviewField, `must not precede ${effectiveField}`);
        }
      } catch {
        // Individual date diagnostics above are more actionable.
      }
    }
  }

  if (present(contextField) && present(outputField)) {
    try {
      if (positiveInteger(environment, outputField) > positiveInteger(environment, contextField)) {
        add(outputField, `must not exceed ${contextField}`);
      }
    } catch {
      // Individual numeric diagnostics above are more actionable.
    }
  }
  if (present(contextField) && present(inputLimitField)) {
    try {
      if (
        positiveInteger(environment, inputLimitField) > positiveInteger(environment, contextField)
      ) {
        add(inputLimitField, `must not exceed ${contextField}`);
      }
    } catch {
      // Individual numeric diagnostics above are more actionable.
    }
  }
  if (present(outputField) && present(minimumOutputField)) {
    try {
      if (
        positiveInteger(environment, outputField) < positiveInteger(environment, minimumOutputField)
      ) {
        add(outputField, `must be at least ${minimumOutputField}`);
      }
    } catch {
      // Individual numeric diagnostics above are more actionable.
    }
  }
  if (present(reasoningField) && present(reasoningEffortField)) {
    try {
      if (
        booleanValue(environment, reasoningEffortField) &&
        !booleanValue(environment, reasoningField)
      ) {
        add(reasoningEffortField, `cannot be true when ${reasoningField} is false`);
      }
    } catch {
      // Individual boolean diagnostics above are more actionable.
    }
  }
  if (present(inputField)) {
    try {
      if (!inputTypes(environment, inputField).includes("text")) {
        add(inputField, "must include text for DocsFab workflows");
      }
    } catch {
      // The field-level diagnostic above already explains malformed input.
    }
  }
  if (present(apiFormatField) && present(compatibleFormatsField)) {
    try {
      const selected = requireValue(environment, apiFormatField);
      if (
        selected === "chat_completions" &&
        !apiFormats(environment, compatibleFormatsField).includes(selected)
      ) {
        add(
          compatibleFormatsField,
          `${apiFormatField} "${selected}" is incompatible with the configured model profile`,
        );
      }
    } catch {
      // Individual API-format diagnostics above are more actionable.
    }
  }

  return issues;
}

function parseModelProfile(
  environment: NodeJS.ProcessEnv,
  prefix: "MODEL" | "JUDGE",
  now: Date,
): ModelProfile {
  const metadata = parseProfileMetadata(environment, prefix, now);
  const contextWindow = positiveInteger(environment, `${prefix}_CONTEXT_WINDOW`);
  const maxInputField = `${prefix}_MAX_INPUT_TOKENS`;
  const configuredMaxInput = environment[maxInputField]?.trim();
  const configuredLimits = {
    contextWindow,
    // Compatibility default for profiles created before the independent cap.
    // Unknown and stale metadata do not invent an 8k executable lid.
    maxInputTokens: configuredMaxInput
      ? positiveInteger(environment, maxInputField)
      : contextWindow,
    maxOutputTokens: positiveInteger(environment, `${prefix}_MAX_OUTPUT_TOKENS`),
  };
  const profile: ModelProfile = {
    configuredLimits,
    contextWindow: configuredLimits.contextWindow,
    maxInputTokens: configuredLimits.maxInputTokens,
    maxOutputTokens: configuredLimits.maxOutputTokens,
    effectiveLimitReason:
      metadata.status === "unknown"
        ? "metadata-unknown"
        : metadata.status === "stale"
          ? "metadata-stale"
          : "none",
    reasoning: booleanValue(environment, `${prefix}_REASONING`),
    input: inputTypes(environment, `${prefix}_INPUT_TYPES`),
    compatibility: {
      supportsDeveloperRole: booleanValue(environment, `${prefix}_SUPPORTS_DEVELOPER_ROLE`),
      supportsReasoningEffort: booleanValue(environment, `${prefix}_SUPPORTS_REASONING_EFFORT`),
      apiFormats: apiFormats(environment, `${prefix}_COMPATIBLE_API_FORMATS`),
    },
    costPerMillionTokens: {
      input: costValue(environment, `${prefix}_INPUT_COST_PER_MILLION`),
      output: costValue(environment, `${prefix}_OUTPUT_COST_PER_MILLION`),
      cacheRead: costValue(environment, `${prefix}_CACHE_READ_COST_PER_MILLION`),
      cacheWrite: costValue(environment, `${prefix}_CACHE_WRITE_COST_PER_MILLION`),
    },
    metadata,
  };
  if (profile.maxOutputTokens > profile.contextWindow) {
    throw new Error(`${prefix}_MAX_OUTPUT_TOKENS must not exceed ${prefix}_CONTEXT_WINDOW.`);
  }
  if (profile.maxInputTokens > profile.contextWindow) {
    throw new Error(`${prefix}_MAX_INPUT_TOKENS must not exceed ${prefix}_CONTEXT_WINDOW.`);
  }
  if (profile.compatibility.supportsReasoningEffort && !profile.reasoning) {
    throw new Error(
      `${prefix}_SUPPORTS_REASONING_EFFORT cannot be true when ${prefix}_REASONING is false.`,
    );
  }
  if (!profile.input.includes("text")) {
    throw new Error(`${prefix}_INPUT_TYPES must include text for DocsFab workflows.`);
  }
  if (metadata.status !== "current") {
    // Handles exactly absent provenance (`unknown`); a passed review date
    // never reaches here. Do not invent a token lid. Keep the
    // configured windows as identity. Strip unattested capability and
    // price claims so those do not become evidence.
    profile.reasoning = false;
    profile.input = ["text"];
    profile.compatibility.supportsDeveloperRole = false;
    profile.compatibility.supportsReasoningEffort = false;
    profile.costPerMillionTokens = {
      input: null,
      output: null,
      cacheRead: null,
      cacheWrite: null,
    };
  }
  return profile;
}

/**
 * Refuse plain HTTP to a host that is not loopback before listing other field
 * issues: the provider boundary would refuse every request to it. An
 * unparseable URL stays a field issue.
 */
function assertConfiguredEndpointTransport(
  environment: NodeJS.ProcessEnv,
  prefix: "MODEL" | "JUDGE",
): void {
  const raw = environment[`${prefix}_BASE_URL`]?.trim();
  if (!raw) return;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return;
  }
  assertModelEndpointTransport(url, `${prefix}_BASE_URL`);
}

export function parseModelEndpoint(
  environment: NodeJS.ProcessEnv,
  prefix: "MODEL" | "JUDGE" = "MODEL",
  now: Date = new Date(),
  options: ModelProfileMigrationOptions = {},
): ModelEndpointConfig {
  // A retired model is the actionable stop even when other fields are missing.
  assertRawModelIdNotRetired(environment[prefix === "MODEL" ? "MODEL_ID" : "JUDGE_MODEL_ID"]);
  assertConfiguredEndpointTransport(environment, prefix);
  const credentialEnv = environment[`${prefix}_CREDENTIAL_ENV`];
  if (credentialEnv !== undefined) {
    assertCredentialEnvironmentName(credentialEnv);
    // An explicit reference is authoritative: never fall back to a previous provider's key.
    environment = { ...environment, [`${prefix}_API_KEY`]: environment[credentialEnv] };
  }
  const rawTransport = environment[`${prefix}_TRANSPORT`];
  const transport = rawTransport === undefined ? undefined : parseProviderTransport(rawTransport);
  const issues = collectModelProfileIssues(environment, prefix, now);
  if (issues.length > 0) throw new ModelProfileMigrationError(issues, options, environment);

  const apiFormat = requireValue(environment, `${prefix}_API_FORMAT`);
  if (apiFormat !== "chat_completions" && apiFormat !== "messages") {
    throw new Error(
      `Unsupported ${prefix}_API_FORMAT "${apiFormat}". DocsFab supports chat_completions or messages when the selected execution adapter admits that format.`,
    );
  }

  const profile = parseModelProfile(environment, prefix, now);
  if (
    transport !== undefined &&
    (transport === "anthropic-messages") !== (apiFormat === "messages")
  ) {
    throw new Error(
      `${prefix}_API_FORMAT does not match the selected protocol in ${prefix}_TRANSPORT.`,
    );
  }
  if (!profile.compatibility.apiFormats.includes(apiFormat)) {
    throw new Error(
      `${prefix}_API_FORMAT "${apiFormat}" is incompatible with the configured model profile.`,
    );
  }

  const baseUrl = requireValue(environment, `${prefix}_BASE_URL`);
  const url = new URL(baseUrl);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`${prefix}_BASE_URL must use HTTP or HTTPS.`);
  }

  const modelSettings = loadedModelSettings(environment, prefix === "MODEL" ? "writing" : "judge");
  return {
    providerId: requireValue(environment, `${prefix}_PROVIDER`),
    baseUrl: baseUrl.replace(/\/$/, ""),
    // The resolver's label for the endpoint, so the key is released only for
    // an operator source.
    ...(modelSettings ? { endpointSource: modelSettings.settings.baseUrl.source } : {}),
    modelId: requireValue(environment, prefix === "MODEL" ? "MODEL_ID" : "JUDGE_MODEL_ID"),
    apiFormat,
    api: "openai-completions",
    ...(transport ? { transport } : {}),
    ...(credentialEnv ? { credentialEnv } : {}),
    apiKey: requireValue(environment, `${prefix}_API_KEY`),
    profile,
    requestPolicy: {
      minimumOutputTokens: positiveInteger(environment, `${prefix}_API_MIN_OUTPUT_TOKENS`),
      reservedContextTokens: positiveInteger(environment, `${prefix}_CONTEXT_RESERVE_TOKENS`),
    },
    ...(modelSettings ? { modelSettings } : {}),
  };
}

/**
 * The slot's settings record when the configuration loader resolved it. A
 * label written for another configuration root does not apply here.
 */
function loadedModelSettings(
  environment: NodeJS.ProcessEnv,
  slot: "writing" | "judge",
): ModelSlotSettingsV1 | undefined {
  if (environment[MODEL_SETTINGS_ORIGINS_VARIABLE] === undefined) return undefined;
  let root: string | undefined;
  try {
    root = resolveDocsFabConfigurationRoot(environment);
  } catch {
    root = undefined;
  }
  return readModelSlotSettings(environment, slot, root);
}

function parseOptionalJudge(environment: NodeJS.ProcessEnv): ModelEndpointConfig | undefined {
  const enabled = environment.JUDGE_ENABLED?.trim().toLowerCase();
  if (!enabled || enabled === "false") return undefined;
  if (enabled !== "true") throw new Error("JUDGE_ENABLED must be true or false.");
  return parseModelEndpoint(environment, "JUDGE");
}

export function loadModelConfigurations(
  environment: NodeJS.ProcessEnv = process.env,
  options: ModelProfileMigrationOptions = {},
): {
  model: ModelEndpointConfig;
  judge?: ModelEndpointConfig;
} {
  // Refuse a retired model before listing incomplete fields: the remediation
  // replaces the whole profile, so field-level repair would be a dead end.
  assertRawModelIdNotRetired(environment.MODEL_ID);
  assertConfiguredEndpointTransport(environment, "MODEL");
  if (environment.JUDGE_ENABLED?.trim().toLowerCase() === "true") {
    assertRawModelIdNotRetired(environment.JUDGE_MODEL_ID);
    assertConfiguredEndpointTransport(environment, "JUDGE");
  }
  const issues = collectModelProfileIssues(environment, "MODEL", new Date());
  const enabled = environment.JUDGE_ENABLED?.trim().toLowerCase();
  if (enabled && enabled !== "true" && enabled !== "false") {
    issues.push({
      profile: "JUDGE",
      field: "JUDGE_ENABLED",
      message: "must be true or false",
    });
  } else if (enabled === "true") {
    issues.push(...collectModelProfileIssues(environment, "JUDGE", new Date()));
  }
  if (issues.length > 0) throw new ModelProfileMigrationError(issues, options, environment);

  const judge = parseOptionalJudge(environment);
  return {
    model: parseModelEndpoint(environment),
    ...(judge ? { judge } : {}),
  };
}

/** Load and validate only the explicitly selected profile-inspection slot. */
export function loadModelEndpointForInspection(
  purpose: "policy" | "judge",
  environment: NodeJS.ProcessEnv = process.env,
  options: ModelProfileMigrationOptions = {},
): ModelEndpointConfig {
  const prefix = purpose === "judge" ? "JUDGE" : "MODEL";
  if (purpose === "judge" && environment.JUDGE_ENABLED?.trim().toLowerCase() !== "true") {
    throw new ModelProfileMigrationError(
      [
        {
          profile: "JUDGE",
          field: "JUDGE_ENABLED",
          message: "must be true for judge profile inspection",
        },
      ],
      options,
    );
  }
  assertConfiguredEndpointTransport(environment, prefix);
  const issues = collectModelProfileIssues(environment, prefix, new Date());
  if (issues.length > 0) throw new ModelProfileMigrationError(issues, options, environment);
  return parseModelEndpoint(environment, prefix, new Date(), options);
}
