// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The one path a model credential takes onto a request.
 *
 * A model key is released only for an endpoint the operator configured: a
 * configuration file, the environment, a command-line flag, or the selected
 * preset's default. Every place that puts a model key on a request accepts
 * only the released value, and reads the key back only for a request to the
 * released endpoint's origin. Those places are the Pi runtime key, the probe
 * client's `Authorization` header, and the catalog lookups.
 *
 * An endpoint's source is a label. Every operator source is trusted, and an
 * unlabelled endpoint is operator configuration. A producer that builds an
 * endpoint from repository files, task or chat text, model output, or merge
 * request or issue text must label it `untrusted:<kind>`; the release then
 * stops with `credential-endpoint-untrusted` before any request is sent.
 *
 * Plain JavaScript, so the plain-node probe scripts load the same bytes.
 */

/** Where an operator-configured endpoint came from. Every one is trusted. */
export const OPERATOR_ENDPOINT_SOURCES = Object.freeze([
  "preset",
  "host-config",
  "secrets-env",
  "legacy-env-file",
  "profile-file",
  "environment",
  "cli-flag",
  "catalog",
]);

/** Inputs that are never an endpoint the operator configured. */
export const UNTRUSTED_ENDPOINT_KINDS = Object.freeze([
  "repository",
  "request-text",
  "model-output",
  "forge-text",
  "chat",
]);

const UNTRUSTED_KIND_WORDING = Object.freeze({
  repository: "repository files",
  "request-text": "task or request text",
  "model-output": "model output",
  "forge-text": "merge request or issue text",
  chat: "chat messages",
});

export const CREDENTIAL_ENDPOINT_UNTRUSTED_CODE = "credential-endpoint-untrusted";

export const CREDENTIAL_ENDPOINT_UNTRUSTED_NEXT_ACTION =
  "Set the model endpoint in your own DocsFab configuration with `docsfab setup` or MODEL_BASE_URL, then run the same command again.";

/** The key stayed home: its endpoint is not one the operator configured. */
export class CredentialEndpointUntrustedError extends Error {
  constructor(detail) {
    super(`DocsFab did not send the model key: ${detail}`);
    this.name = "CredentialEndpointUntrustedError";
    this.code = CREDENTIAL_ENDPOINT_UNTRUSTED_CODE;
    this.nextAction = CREDENTIAL_ENDPOINT_UNTRUSTED_NEXT_ACTION;
    this.retryable = false;
  }
}

/** Whether a label names an operator source. */
export function isOperatorEndpointSource(value) {
  return typeof value === "string" && OPERATOR_ENDPOINT_SOURCES.includes(value);
}

/** Keys of released values, reachable only through `credentialForRequest`. */
const releasedKeys = new WeakMap();
const MINT = Symbol("docsfab.model-credential-release");
const INSPECT = Symbol.for("nodejs.util.inspect.custom");

/**
 * A model key released for one endpoint. It carries no readable key: JSON,
 * string, and inspection forms name only the endpoint's origin.
 */
export class ReleasedModelCredential {
  #endpointOrigin;
  #endpointSource;
  #purpose;

  constructor(mint, endpointOrigin, endpointSource, purpose) {
    if (mint !== MINT) {
      throw new TypeError("Only releaseModelCredential() creates a released model credential.");
    }
    this.#endpointOrigin = endpointOrigin;
    this.#endpointSource = endpointSource;
    this.#purpose = purpose;
    Object.freeze(this);
  }

  get endpointOrigin() {
    return this.#endpointOrigin;
  }

  /** The operator source label, or undefined for unlabelled operator configuration. */
  get endpointSource() {
    return this.#endpointSource;
  }

  get purpose() {
    return this.#purpose;
  }

  toJSON() {
    return {
      kind: "released-model-credential",
      endpointOrigin: this.#endpointOrigin,
      purpose: this.#purpose,
    };
  }

  toString() {
    return `[model credential released for ${this.#endpointOrigin}]`;
  }

  [INSPECT]() {
    return this.toString();
  }
}

/**
 * Release a model key for the endpoint it will be sent to. Refuses, before
 * any request, an endpoint whose source label is not an operator source.
 */
export function releaseModelCredential(request, purpose) {
  const { endpoint, endpointSource, apiKey } = request ?? {};
  const origin = originOf(endpoint);
  if (endpointSource !== undefined && !isOperatorEndpointSource(endpointSource)) {
    throw new CredentialEndpointUntrustedError(
      `the endpoint${origin ? ` ${origin}` : ""} came from ${describeSource(endpointSource)}, not from your configuration.`,
    );
  }
  if (typeof apiKey !== "string" || apiKey.length === 0) {
    throw new TypeError("The selected provider credential must contain one nonempty secret value.");
  }
  if (origin === null) {
    throw new TypeError(
      "The model endpoint is not an absolute URL, so no credential is released for it.",
    );
  }
  const released = new ReleasedModelCredential(MINT, origin, endpointSource, purpose);
  releasedKeys.set(released, apiKey);
  return released;
}

/**
 * The released key, for one request to the released endpoint's origin. This
 * is the only way a sender reads a model key.
 */
export function credentialForRequest(released, requestUrl) {
  const apiKey =
    released instanceof ReleasedModelCredential ? releasedKeys.get(released) : undefined;
  if (apiKey === undefined) {
    throw new TypeError(
      "A model credential reaches a request only through releaseModelCredential().",
    );
  }
  const origin = originOf(requestUrl);
  if (origin !== released.endpointOrigin) {
    throw new CredentialEndpointUntrustedError(
      `the request goes to ${origin ?? "an address that is not an absolute URL"}, not to the configured endpoint ${released.endpointOrigin}.`,
    );
  }
  return apiKey;
}

function originOf(value) {
  if (typeof value !== "string" && !(value instanceof URL)) return null;
  try {
    const origin = new URL(value instanceof URL ? value.href : value).origin;
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
}

function describeSource(label) {
  const kind =
    typeof label === "string" && label.startsWith("untrusted:")
      ? label.slice("untrusted:".length)
      : "";
  return Object.hasOwn(UNTRUSTED_KIND_WORDING, kind)
    ? UNTRUSTED_KIND_WORDING[kind]
    : "a source DocsFab does not recognize as your configuration";
}
