// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Where an operator-configured endpoint came from. Every one is trusted. */
export type OperatorEndpointSource =
  | "preset"
  | "host-config"
  | "secrets-env"
  | "legacy-env-file"
  | "profile-file"
  | "environment"
  | "cli-flag"
  | "catalog";

/** Inputs that are never an endpoint the operator configured. */
export type UntrustedEndpointKind =
  | "repository"
  | "request-text"
  | "model-output"
  | "forge-text"
  | "chat";

/** An endpoint's source: an operator source, or an explicitly untrusted input. */
export type EndpointSource = OperatorEndpointSource | `untrusted:${UntrustedEndpointKind}`;

/** Why a key is released, named in refusals; never part of the key's binding. */
export type CredentialReleasePurpose =
  | "model-connection"
  | "endpoint-probe"
  | "profile-probe"
  | "catalog-lookup"
  | "model-matrix";

export const OPERATOR_ENDPOINT_SOURCES: readonly OperatorEndpointSource[];
export const UNTRUSTED_ENDPOINT_KINDS: readonly UntrustedEndpointKind[];
export const CREDENTIAL_ENDPOINT_UNTRUSTED_CODE: "credential-endpoint-untrusted";
export const CREDENTIAL_ENDPOINT_UNTRUSTED_NEXT_ACTION: string;

export class CredentialEndpointUntrustedError extends Error {
  constructor(detail: string);
  readonly code: "credential-endpoint-untrusted";
  readonly nextAction: string;
  readonly retryable: false;
}

export function isOperatorEndpointSource(value: unknown): value is OperatorEndpointSource;

/**
 * A model key released for one endpoint. It carries no readable key: JSON,
 * string, and inspection forms name only the endpoint's origin.
 */
export class ReleasedModelCredential {
  private constructor();
  readonly endpointOrigin: string;
  /** The operator source label, or undefined for unlabelled operator configuration. */
  readonly endpointSource: OperatorEndpointSource | undefined;
  readonly purpose: CredentialReleasePurpose;
  toJSON(): {
    readonly kind: "released-model-credential";
    readonly endpointOrigin: string;
    readonly purpose: CredentialReleasePurpose;
  };
}

export interface ModelCredentialReleaseRequest {
  /** The endpoint the key will be sent to; its origin binds the release. */
  readonly endpoint: string;
  /** Absent means unlabelled operator configuration. */
  readonly endpointSource?: EndpointSource;
  readonly apiKey: string;
}

/**
 * Release a model key for the endpoint it will be sent to. Refuses, before
 * any request, an endpoint whose source label is not an operator source.
 */
export function releaseModelCredential(
  request: ModelCredentialReleaseRequest,
  purpose: CredentialReleasePurpose,
): ReleasedModelCredential;

/**
 * The released key, for one request to the released endpoint's origin. This
 * is the only way a sender reads a model key.
 */
export function credentialForRequest(
  released: ReleasedModelCredential,
  requestUrl: string | URL,
): string;
