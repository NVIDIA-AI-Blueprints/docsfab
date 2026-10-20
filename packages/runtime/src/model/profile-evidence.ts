// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import type { BoundModelExecutionProfile, ModelEndpointConfig } from "./configuration.js";
import type { ModelEvidence, ModelProfileEvidence } from "../records/contracts.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_PROVIDER = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`);
    return `{${entries.join(",")}}`;
  }
  throw new Error("Model profile evidence is not canonicalizable.");
}

/**
 * Credential-free provider-neutral input admitted by the evidence projector.
 * Both the legacy endpoint configuration and a resolved composition's bound
 * execution profile satisfy this projection without a cast.
 */
export type ModelEvidenceSource = Pick<
  BoundModelExecutionProfile,
  "providerId" | "modelId" | "apiFormat" | "profile" | "requestPolicy"
>;

type CompleteModelEvidence = ModelEvidence & { profile: ModelProfileEvidence };
type LegacyModelProfileEvidence = Omit<
  ModelProfileEvidence,
  "apiFormat" | "effectiveLimitReason"
> & {
  apiFormat: "chat_completions" | "messages";
  effectiveLimitReason: Exclude<
    ModelProfileEvidence["effectiveLimitReason"],
    "composition-candidate"
  >;
};
type LegacyModelEvidence = Omit<ModelEvidence, "profile"> & {
  profile: LegacyModelProfileEvidence;
};

/**
 * Project a resolved model profile into credential-free, content-addressed
 * evidence. Endpoint URLs, transport details, routes, and credentials are
 * deliberately outside the admitted projection.
 */
export function createModelEvidence(config: ModelEndpointConfig): LegacyModelEvidence;
export function createModelEvidence(config: BoundModelExecutionProfile): CompleteModelEvidence;
export function createModelEvidence(config: ModelEvidenceSource): CompleteModelEvidence;
export function createModelEvidence(
  config: ModelEndpointConfig | BoundModelExecutionProfile | ModelEvidenceSource,
): CompleteModelEvidence {
  if ("api" in config && config.profile.effectiveLimitReason === "composition-candidate") {
    throw new Error("Composition candidate limits require a bound model execution profile.");
  }
  const metadata = config.profile.metadata;
  const pricing = Object.values(config.profile.costPerMillionTokens).every((rate) => rate !== null)
    ? "known"
    : "unknown";
  const profileWithoutDigest: Omit<ModelProfileEvidence, "sha256"> = {
    schemaVersion: 2,
    status: metadata.status,
    configuredContextWindow: config.profile.configuredLimits.contextWindow,
    effectiveContextWindow: config.profile.contextWindow,
    configuredMaxInputTokens: config.profile.configuredLimits.maxInputTokens,
    effectiveMaxInputTokens: config.profile.maxInputTokens,
    configuredMaxOutputTokens: config.profile.configuredLimits.maxOutputTokens,
    effectiveMaxOutputTokens: config.profile.maxOutputTokens,
    effectiveLimitReason: config.profile.effectiveLimitReason,
    apiFormat: config.apiFormat,
    reasoning: config.profile.reasoning,
    input: [...config.profile.input].sort(),
    compatibility: {
      supportsDeveloperRole: config.profile.compatibility.supportsDeveloperRole,
      supportsReasoningEffort: config.profile.compatibility.supportsReasoningEffort,
      apiFormats: [...config.profile.compatibility.apiFormats].sort(),
    },
    requestPolicy: { ...config.requestPolicy },
    costPerMillionTokens: { ...config.profile.costPerMillionTokens },
    pricing,
    ...(metadata.approvedSource ? { approvedSourceSha256: sha256(metadata.approvedSource) } : {}),
    ...(metadata.effectiveDate ? { effectiveDate: metadata.effectiveDate } : {}),
    ...(metadata.reviewAfter ? { reviewAfter: metadata.reviewAfter } : {}),
  };
  const profile: ModelProfileEvidence = {
    ...profileWithoutDigest,
    sha256: modelProfileEvidenceSha256({
      provider: config.providerId,
      model: config.modelId,
      profile: profileWithoutDigest,
    }),
  };
  return {
    provider: config.providerId,
    model: config.modelId,
    profile,
  };
}

/** Recompute the digest from the complete published safe projection. */
export function modelProfileEvidenceSha256(input: {
  provider: string;
  model: string;
  profile: Omit<ModelProfileEvidence, "sha256">;
}): string {
  return sha256(
    canonical({
      schemaVersion: input.profile.schemaVersion,
      provider: input.provider,
      model: input.model,
      profile: input.profile,
    }),
  );
}

/**
 * The projection rule a model evidence check found broken, named by the
 * profile field it guards. Readers map each field to the configuration that
 * supplies it; `shape` and `digest` are projector-owned, not configured.
 */
export type ModelEvidenceProjectionDefect =
  | "provider"
  | "model"
  | "profile"
  | "shape"
  | "context-window"
  | "max-input-tokens"
  | "max-output-tokens"
  | "limit-reason"
  | "api-format"
  | "reasoning"
  | "input-types"
  | "compatibility"
  | "request-policy"
  | "pricing"
  | "approved-source"
  | "effective-date"
  | "review-after"
  | "digest";

/** Strictly validate the complete safe projection before trusting its digest. */
export function validModelEvidenceProjection(
  model: ModelEvidence,
): model is ModelEvidence & { profile: ModelProfileEvidence } {
  return modelEvidenceProjectionDefect(model) === undefined;
}

/**
 * Name the first broken projection rule, or `undefined` when the projection is
 * complete and its digest recomputes. Stale and unknown metadata keep their
 * configured windows; neither carries an invented 8k lid.
 */
export function modelEvidenceProjectionDefect(
  model: ModelEvidence,
): ModelEvidenceProjectionDefect | undefined {
  const profile = model.profile;
  if (!SAFE_PROVIDER.test(model.provider)) return "provider";
  if (
    !SAFE_MODEL.test(model.model) ||
    model.model.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  )
    return "model";
  if (!profile) return "profile";
  const { sha256: profileSha256, ...profileWithoutDigest } = profile;
  const allowedKeys = [
    "schemaVersion",
    "status",
    "configuredContextWindow",
    "effectiveContextWindow",
    "configuredMaxInputTokens",
    "effectiveMaxInputTokens",
    "configuredMaxOutputTokens",
    "effectiveMaxOutputTokens",
    "effectiveLimitReason",
    "apiFormat",
    "reasoning",
    "input",
    "compatibility",
    "requestPolicy",
    "costPerMillionTokens",
    "pricing",
    "approvedSourceSha256",
    "effectiveDate",
    "reviewAfter",
    "sha256",
  ];
  const hasConfiguredMaxInput = profile.configuredMaxInputTokens !== undefined;
  const hasEffectiveMaxInput = profile.effectiveMaxInputTokens !== undefined;
  if (
    Object.keys(profile).some((key) => !allowedKeys.includes(key)) ||
    (profile.schemaVersion !== 1 && profile.schemaVersion !== 2) ||
    !["current", "stale", "unknown"].includes(profile.status) ||
    !["known", "unknown"].includes(profile.pricing) ||
    !SHA256.test(profileSha256)
  )
    return "shape";
  if (
    !positiveInteger(profile.configuredContextWindow) ||
    !positiveInteger(profile.effectiveContextWindow)
  )
    return "context-window";
  if (
    hasConfiguredMaxInput !== hasEffectiveMaxInput ||
    (profile.schemaVersion === 1 && hasConfiguredMaxInput) ||
    (profile.schemaVersion === 2 && !hasConfiguredMaxInput) ||
    (hasConfiguredMaxInput &&
      (!positiveInteger(profile.configuredMaxInputTokens) ||
        !positiveInteger(profile.effectiveMaxInputTokens) ||
        profile.configuredMaxInputTokens > profile.configuredContextWindow ||
        profile.effectiveMaxInputTokens > profile.effectiveContextWindow ||
        profile.effectiveMaxInputTokens > profile.configuredMaxInputTokens))
  )
    return "max-input-tokens";
  if (
    !positiveInteger(profile.configuredMaxOutputTokens) ||
    !positiveInteger(profile.effectiveMaxOutputTokens)
  )
    return "max-output-tokens";
  if (profile.effectiveContextWindow > profile.configuredContextWindow) return "context-window";
  if (
    profile.effectiveMaxOutputTokens > profile.configuredMaxOutputTokens ||
    profile.configuredMaxOutputTokens > profile.configuredContextWindow ||
    profile.effectiveMaxOutputTokens > profile.effectiveContextWindow
  )
    return "max-output-tokens";
  if (
    !["none", "metadata-unknown", "metadata-stale", "composition-candidate"].includes(
      profile.effectiveLimitReason,
    )
  )
    return "limit-reason";
  if (profile.apiFormat !== "chat_completions" && profile.apiFormat !== "messages")
    return "api-format";
  if (typeof profile.reasoning !== "boolean") return "reasoning";
  if (
    !Array.isArray(profile.input) ||
    profile.input.length === 0 ||
    !profile.input.includes("text") ||
    profile.input.some((item) => item !== "text" && item !== "image")
  )
    return "input-types";
  if (
    !plain(profile.compatibility) ||
    Object.keys(profile.compatibility).sort().join(",") !==
      ["apiFormats", "supportsDeveloperRole", "supportsReasoningEffort"].sort().join(",") ||
    typeof profile.compatibility.supportsDeveloperRole !== "boolean" ||
    typeof profile.compatibility.supportsReasoningEffort !== "boolean" ||
    !Array.isArray(profile.compatibility.apiFormats) ||
    profile.compatibility.apiFormats.length === 0 ||
    profile.compatibility.apiFormats.some(
      (item) => item !== "chat_completions" && item !== "messages",
    ) ||
    !profile.compatibility.apiFormats.includes(profile.apiFormat) ||
    (profile.compatibility.supportsReasoningEffort && !profile.reasoning)
  )
    return "compatibility";
  if (
    !plain(profile.requestPolicy) ||
    Object.keys(profile.requestPolicy).sort().join(",") !==
      ["minimumOutputTokens", "reservedContextTokens"].sort().join(",") ||
    !positiveInteger(profile.requestPolicy.minimumOutputTokens) ||
    !positiveInteger(profile.requestPolicy.reservedContextTokens)
  )
    return "request-policy";
  if (
    !validCosts(profile.costPerMillionTokens) ||
    profile.pricing !==
      (Object.values(profile.costPerMillionTokens).every((rate) => rate !== null)
        ? "known"
        : "unknown")
  )
    return "pricing";
  if (profile.approvedSourceSha256 !== undefined && !SHA256.test(profile.approvedSourceSha256))
    return "approved-source";
  if (profile.effectiveDate !== undefined && !validDate(profile.effectiveDate))
    return "effective-date";
  if (profile.reviewAfter !== undefined && !validDate(profile.reviewAfter)) return "review-after";
  const statusDefect =
    profile.effectiveLimitReason === "composition-candidate"
      ? validCompositionCandidateMetadata(profile)
        ? undefined
        : "limit-reason"
      : profile.status === "current"
        ? currentStatusDefect(profile, hasConfiguredMaxInput)
        : profile.status === "stale"
          ? staleStatusDefect(profile)
          : unknownStatusDefect(profile);
  if (statusDefect) return statusDefect;
  return modelProfileEvidenceSha256({
    provider: model.provider,
    model: model.model,
    profile: profileWithoutDigest,
  }) === profileSha256
    ? undefined
    : "digest";
}

/** Current metadata: effective limits equal the configured ones, fully dated. */
function currentStatusDefect(
  profile: ModelProfileEvidence,
  hasConfiguredMaxInput: boolean,
): ModelEvidenceProjectionDefect | undefined {
  if (profile.effectiveLimitReason !== "none") return "limit-reason";
  if (profile.effectiveContextWindow !== profile.configuredContextWindow) return "context-window";
  if (hasConfiguredMaxInput && profile.effectiveMaxInputTokens !== profile.configuredMaxInputTokens)
    return "max-input-tokens";
  if (profile.effectiveMaxOutputTokens !== profile.configuredMaxOutputTokens)
    return "max-output-tokens";
  if (!profile.approvedSourceSha256) return "approved-source";
  if (!profile.effectiveDate) return "effective-date";
  if (!profile.reviewAfter) return "review-after";
  return undefined;
}

/**
 * Legacy `stale` status, carried only by saved records (the loader never
 * writes it): attested source and dates stay, price claims are stripped.
 * Configured windows stay as identity; no invented lid.
 */
function staleStatusDefect(
  profile: ModelProfileEvidence,
): ModelEvidenceProjectionDefect | undefined {
  if (profile.effectiveLimitReason !== "metadata-stale") return "limit-reason";
  if (profile.pricing !== "unknown") return "pricing";
  if (!profile.approvedSourceSha256) return "approved-source";
  if (!profile.effectiveDate) return "effective-date";
  if (!profile.reviewAfter) return "review-after";
  return undefined;
}

/** Unattested metadata: no source, dates, or prices; configured windows stay. */
function unknownStatusDefect(
  profile: ModelProfileEvidence,
): ModelEvidenceProjectionDefect | undefined {
  if (profile.effectiveLimitReason !== "metadata-unknown") return "limit-reason";
  if (profile.pricing !== "unknown") return "pricing";
  if (profile.approvedSourceSha256 !== undefined) return "approved-source";
  if (profile.effectiveDate !== undefined) return "effective-date";
  if (profile.reviewAfter !== undefined) return "review-after";
  return undefined;
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function plain(value: unknown): value is Record<string, unknown> {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function validCosts(value: unknown): value is ModelProfileEvidence["costPerMillionTokens"] {
  return (
    plain(value) &&
    Object.keys(value).sort().join(",") ===
      ["cacheRead", "cacheWrite", "input", "output"].sort().join(",") &&
    Object.values(value).every(
      (rate) => rate === null || (typeof rate === "number" && Number.isFinite(rate) && rate >= 0),
    )
  );
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().startsWith(value);
}

function validCompositionCandidateMetadata(profile: ModelProfileEvidence): boolean {
  if (profile.pricing !== "unknown") return false;
  if (profile.status === "unknown") {
    return (
      profile.approvedSourceSha256 === undefined &&
      profile.effectiveDate === undefined &&
      profile.reviewAfter === undefined
    );
  }
  return Boolean(profile.approvedSourceSha256 && profile.effectiveDate && profile.reviewAfter);
}
