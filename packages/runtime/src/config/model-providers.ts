// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Wire protocols supported by the Pi provider adapters. */
export type ProviderTransport =
  | "openai-chat-completions"
  | "openai-responses"
  | "anthropic-messages";

/** Public setup choices; compatible providers always require an operator-supplied URL. */
export const MODEL_PROVIDERS = {
  openai: {
    label: "OpenAI",
    providerId: "openai-api",
    baseUrl: "https://api.openai.com/v1",
    transport: "openai-responses",
    credentialEnv: "OPENAI_API_KEY",
  },
  "openai-compatible": {
    label: "OpenAI-compatible",
    providerId: "operator-configured-openai-compatible",
    baseUrl: "",
    transport: "openai-chat-completions",
    credentialEnv: "COMPATIBLE_API_KEY",
  },
  anthropic: {
    label: "Anthropic",
    providerId: "anthropic-api",
    baseUrl: "https://api.anthropic.com",
    transport: "anthropic-messages",
    credentialEnv: "ANTHROPIC_API_KEY",
  },
  "anthropic-compatible": {
    label: "Anthropic-compatible",
    providerId: "operator-configured-anthropic-compatible",
    baseUrl: "",
    transport: "anthropic-messages",
    credentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
  },
} as const;

export type ModelProviderOption = keyof typeof MODEL_PROVIDERS;

export const PROVIDER_TRANSPORTS: readonly ProviderTransport[] = [
  "openai-chat-completions",
  "openai-responses",
  "anthropic-messages",
];

/** Token defaults for custom profiles; operators can configure both in the saved profile. */
export const CUSTOM_ENDPOINT_REQUEST_LIMITS = {
  // Responses requires a nonzero minimum output budget.
  minimumOutputTokens: 16,
  // Reserve provider framing outside DocsFab's input estimate, in tokens.
  reservedContextTokens: 1024,
} as const;

export function parseModelProviderOption(value: string): ModelProviderOption {
  if (!Object.hasOwn(MODEL_PROVIDERS, value)) {
    throw new Error(
      "Choose a provider: openai, openai-compatible, anthropic, or anthropic-compatible.",
    );
  }
  return value as ModelProviderOption;
}

export function parseProviderTransport(value: string): ProviderTransport {
  if (!PROVIDER_TRANSPORTS.includes(value as ProviderTransport)) {
    throw new Error(
      "Choose one supported provider API: openai-chat-completions, openai-responses, or anthropic-messages.",
    );
  }
  return value as ProviderTransport;
}

export function assertProviderTransport(
  provider: ModelProviderOption,
  transport: ProviderTransport,
): void {
  if (provider.startsWith("anthropic") !== (transport === "anthropic-messages")) {
    throw new Error("The selected API does not match the provider's protocol family.");
  }
}

export function assertCredentialEnvironmentName(value: string): void {
  if (!/^[A-Z][A-Z0-9_]*$/u.test(value)) {
    throw new Error("The credential environment reference must be an uppercase variable name.");
  }
}

/** Anthropic's SDK adds /v1 itself; accept the same versioned base URLs as OpenAI. */
export function providerSdkBaseUrl(baseUrl: string, transport: ProviderTransport): string {
  const base = baseUrl.replace(/\/$/u, "");
  return transport === "anthropic-messages" ? base.replace(/\/v1$/u, "") : base;
}

/** The path each SDK appends to its base URL. */
const PROVIDER_REQUEST_PATHS: Record<ProviderTransport, string> = {
  "openai-chat-completions": "/chat/completions",
  "openai-responses": "/responses",
  "anthropic-messages": "/v1/messages",
};

/** Keep setup's displayed destination and the runtime's request-path guard aligned. */
export function providerRequestUrl(baseUrl: string, transport: ProviderTransport): string {
  const query = transport === "anthropic-messages" ? "?beta=true" : "";
  return `${providerSdkBaseUrl(baseUrl, transport)}${PROVIDER_REQUEST_PATHS[transport]}${query}`;
}

/**
 * A pasted request URL becomes its base URL. The SDK appends the API path
 * again, so keeping it would send every request to `/responses/responses`.
 */
export function providerBaseUrl(endpointUrl: string, transport: ProviderTransport): string {
  const base = endpointUrl.replace(/\/$/u, "");
  const path = PROVIDER_REQUEST_PATHS[transport];
  return base.endsWith(path) ? base.slice(0, -path.length) : base;
}
