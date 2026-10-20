// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const RESPONSE_BOUNDARY_ERROR =
  "Provider response rejected because it exceeded the composition response byte limit.";
/**
 * A request or response the provider boundary refuses: the configured origin, a
 * redirect, a malformed Content-Length, or an unverifiable or mismatched model
 * identity. Typed so the transport tells DocsFab's own refusal from a provider
 * or network failure by `instanceof`, not by message wording.
 */
export class ProviderBoundaryRefusalError extends Error {
  // `name` stays "Error" so the operator-visible text is unchanged by the type.
}

export class ProviderResponseLimitError extends Error {
  public readonly code = "provider-response-too-large" as const;
  public readonly retryable = false as const;

  public constructor(public readonly maxResponseBytes: number) {
    super(`${RESPONSE_BOUNDARY_ERROR} limit=${maxResponseBytes}`);
    this.name = "ProviderResponseLimitError";
  }
}
