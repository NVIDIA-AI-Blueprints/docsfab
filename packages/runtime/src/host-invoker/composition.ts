// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Hosted composition packet: route, credential family, profile, tools, digest.
 *
 * The composition never carries the credential. Route and credential family
 * must match; a mismatch is `credential-route-mismatch`.
 */
import type {
  BoundModelExecutionProfile,
  ProviderCredentialFamily,
} from "../model/configuration.js";
import {
  bad,
  boolean,
  boundedString,
  containsCredentialDeep,
  digest,
  enumeration,
  freezeDeep,
  httpsUrl,
  id,
  positive,
  record,
  recordWithOptional,
  sha,
  tool,
} from "./wire-decode.js";

export const HOST_RUNTIME_ROUTES = [
  "offline-fixture",
  "openai-direct",
  "anthropic-direct",
  "nvidia-api-catalog",
  "nvidia-inference-api",
  "native-codex",
  "native-claude",
] as const;
export type HostRuntimeRoute = (typeof HOST_RUNTIME_ROUTES)[number];

export interface HostRuntimeCompositionV1 {
  readonly compositionId: string;
  readonly route: HostRuntimeRoute;
  readonly credentialFamily: ProviderCredentialFamily | "none";
  readonly executionProfile: BoundModelExecutionProfile | null;
  readonly declaredTools: readonly string[];
  readonly compositionSha256: string;
}

const ROUTE_CREDENTIAL: Readonly<
  Record<
    Exclude<HostRuntimeRoute, "offline-fixture" | "native-codex" | "native-claude">,
    ProviderCredentialFamily
  >
> = {
  "openai-direct": "openai-api",
  "anthropic-direct": "anthropic-api",
  "nvidia-api-catalog": "nvidia-api-catalog",
  "nvidia-inference-api": "nvidia-inference-api",
};

export function sealHostRuntimeComposition(
  input: Omit<HostRuntimeCompositionV1, "compositionSha256">,
): HostRuntimeCompositionV1 {
  return parseHostRuntimeComposition({ ...input, compositionSha256: digest(input) });
}

export function parseHostRuntimeComposition(input: unknown): HostRuntimeCompositionV1 {
  const root = record(input, [
    "compositionId",
    "route",
    "credentialFamily",
    "executionProfile",
    "declaredTools",
    "compositionSha256",
  ]);
  const route = enumeration(root.route, HOST_RUNTIME_ROUTES);
  if (!Array.isArray(root.declaredTools) || root.declaredTools.length > 32)
    bad("invalid-composition");
  const tools = [...new Set(root.declaredTools.map(tool))].sort();
  if (tools.length !== root.declaredTools.length) bad("invalid-composition");
  const expectedCredential: HostRuntimeCompositionV1["credentialFamily"] =
    route === "offline-fixture" || route === "native-codex" || route === "native-claude"
      ? "none"
      : ROUTE_CREDENTIAL[route];
  if (root.credentialFamily !== expectedCredential) bad("credential-route-mismatch");
  const profileRequired =
    route !== "offline-fixture" && route !== "native-codex" && route !== "native-claude";
  if (profileRequired === (root.executionProfile === null)) bad("invalid-composition");
  const executionProfile =
    root.executionProfile === null ? null : parseExecutionProfile(root.executionProfile, route);
  const body = {
    compositionId: id(root.compositionId),
    route,
    credentialFamily: expectedCredential,
    executionProfile,
    declaredTools: Object.freeze(tools),
  };
  if (sha(root.compositionSha256) !== digest(body)) bad("composition-digest-mismatch");
  return freezeDeep({ ...body, compositionSha256: digest(body) });
}

function parseExecutionProfile(
  input: unknown,
  route: HostRuntimeRoute,
): BoundModelExecutionProfile {
  const root = recordWithOptional(
    input,
    [
      "routeId",
      "providerId",
      "baseUrl",
      "modelId",
      "transport",
      "apiFormat",
      "profile",
      "requestPolicy",
    ],
    ["compositionRequestPolicy", "compositionPolicy"],
  );
  if (containsCredentialDeep(root, "hosted-composition")) bad("credential-material");
  if (root.routeId !== route || root.providerId !== route) bad("profile-route-mismatch");
  const transport = enumeration(root.transport, [
    "openai-chat-completions",
    "openai-responses",
    "anthropic-messages",
  ] as const);
  if ((route === "anthropic-direct") !== (transport === "anthropic-messages"))
    bad("profile-route-mismatch");
  if (route.startsWith("nvidia-") && transport !== "openai-chat-completions")
    bad("profile-route-mismatch");
  const apiFormat = enumeration(root.apiFormat, ["chat_completions", "messages"] as const);
  if ((transport === "anthropic-messages" ? "messages" : "chat_completions") !== apiFormat)
    bad("profile-route-mismatch");
  const url = httpsUrl(root.baseUrl);
  const profile = parseModelProfile(root.profile, apiFormat);
  const requestPolicy = integerPolicy(root.requestPolicy, [
    "minimumOutputTokens",
    "reservedContextTokens",
  ]);
  const compositionRequestPolicy =
    root.compositionRequestPolicy === undefined
      ? undefined
      : parseInstalledRequestPolicy(root.compositionRequestPolicy, route);
  const compositionPolicy =
    root.compositionPolicy === undefined
      ? undefined
      : integerPolicy(root.compositionPolicy, [
          "maxProviderTurns",
          "timeoutMs",
          "maxResponseBytes",
        ]);
  return Object.freeze({
    routeId: route,
    providerId: route,
    baseUrl: url,
    modelId: boundedString(root.modelId, 256),
    transport,
    apiFormat,
    profile,
    requestPolicy,
    ...(compositionRequestPolicy ? { compositionRequestPolicy } : {}),
    ...(compositionPolicy ? { compositionPolicy } : {}),
  });
}

function parseModelProfile(
  input: unknown,
  apiFormat: "chat_completions" | "messages",
): BoundModelExecutionProfile["profile"] {
  const root = record(input, [
    "configuredLimits",
    "contextWindow",
    "maxInputTokens",
    "maxOutputTokens",
    "effectiveLimitReason",
    "reasoning",
    "input",
    "compatibility",
    "costPerMillionTokens",
    "metadata",
  ]);
  const configured = integerPolicy(root.configuredLimits, [
    "contextWindow",
    "maxInputTokens",
    "maxOutputTokens",
  ]);
  const compatibility = record(root.compatibility, [
    "supportsDeveloperRole",
    "supportsReasoningEffort",
    "apiFormats",
  ]);
  if (
    typeof compatibility.supportsDeveloperRole !== "boolean" ||
    typeof compatibility.supportsReasoningEffort !== "boolean" ||
    !Array.isArray(compatibility.apiFormats)
  )
    bad("invalid-profile");
  const apiFormats = compatibility.apiFormats.map((value) =>
    enumeration(value, ["chat_completions", "messages"] as const),
  );
  if (!apiFormats.includes(apiFormat) || new Set(apiFormats).size !== apiFormats.length)
    bad("invalid-profile");
  if (!Array.isArray(root.input) || root.input.length < 1) bad("invalid-profile");
  const inputs = root.input.map((value) => enumeration(value, ["text", "image"] as const));
  const costs = record(root.costPerMillionTokens, ["input", "output", "cacheRead", "cacheWrite"]);
  for (const value of Object.values(costs))
    if (value !== null && (typeof value !== "number" || !Number.isFinite(value) || value < 0))
      bad("invalid-profile");
  const metadata = record(root.metadata, [
    "approvedSource",
    "effectiveDate",
    "reviewAfter",
    "status",
  ]);
  if (metadata.approvedSource !== null && typeof metadata.approvedSource !== "string")
    bad("invalid-profile");
  if (metadata.effectiveDate !== null && typeof metadata.effectiveDate !== "string")
    bad("invalid-profile");
  if (metadata.reviewAfter !== null && typeof metadata.reviewAfter !== "string")
    bad("invalid-profile");
  return Object.freeze({
    configuredLimits: configured,
    contextWindow: positive(root.contextWindow),
    maxInputTokens: positive(root.maxInputTokens),
    maxOutputTokens: positive(root.maxOutputTokens),
    effectiveLimitReason: enumeration(root.effectiveLimitReason, [
      "none",
      "metadata-unknown",
      "metadata-stale",
      "composition-candidate",
    ] as const),
    reasoning: boolean(root.reasoning),
    input: inputs,
    compatibility: {
      supportsDeveloperRole: compatibility.supportsDeveloperRole,
      supportsReasoningEffort: compatibility.supportsReasoningEffort,
      apiFormats,
    },
    costPerMillionTokens:
      costs as unknown as BoundModelExecutionProfile["profile"]["costPerMillionTokens"],
    metadata: {
      approvedSource: metadata.approvedSource as string | null,
      effectiveDate: metadata.effectiveDate as string | null,
      reviewAfter: metadata.reviewAfter as string | null,
      status: enumeration(metadata.status, ["current", "stale", "unknown"] as const),
    },
  });
}

function parseInstalledRequestPolicy(
  input: unknown,
  route: HostRuntimeRoute,
): NonNullable<BoundModelExecutionProfile["compositionRequestPolicy"]> {
  const root = record(input, [
    "schemaVersion",
    "modelId",
    "routeId",
    "deploymentIdentitySha256",
    "transport",
    "reasoningMode",
    "reasoningControl",
    "installedSystemInstructionSha256",
    "temperature",
    "topP",
    "policySha256",
  ]);
  if (
    root.schemaVersion !== 1 ||
    root.routeId !== route ||
    !route.startsWith("nvidia-") ||
    root.transport !== "openai-chat-completions" ||
    root.reasoningMode !== "disabled" ||
    root.temperature !== 0 ||
    root.topP !== 1
  )
    bad("invalid-request-policy");
  const control = root.reasoningControl;
  if (!control || typeof control !== "object" || Array.isArray(control))
    bad("invalid-request-policy");
  const controlRecord = control as Record<string, unknown>;
  const reasoningControl =
    controlRecord.kind === "system-directive"
      ? record(control, ["kind", "directive"]).directive === "/no_think"
        ? { kind: "system-directive" as const, directive: "/no_think" as const }
        : bad("invalid-request-policy")
      : record(control, ["kind", "thinking"]).kind === "chat-template-kwarg" &&
          controlRecord.thinking === false
        ? { kind: "chat-template-kwarg" as const, thinking: false as const }
        : bad("invalid-request-policy");
  return Object.freeze({
    schemaVersion: 1,
    modelId: boundedString(root.modelId, 256),
    routeId: route as "nvidia-api-catalog" | "nvidia-inference-api",
    deploymentIdentitySha256: sha(root.deploymentIdentitySha256),
    transport: "openai-chat-completions",
    reasoningMode: "disabled",
    reasoningControl,
    installedSystemInstructionSha256: sha(root.installedSystemInstructionSha256),
    temperature: 0,
    topP: 1,
    policySha256: sha(root.policySha256),
  });
}

function integerPolicy<const K extends string>(
  input: unknown,
  keys: readonly K[],
): Record<K, number> {
  const root = record(input, keys);
  return Object.freeze(
    Object.fromEntries(keys.map((key) => [key, positive(root[key])])) as Record<K, number>,
  );
}
