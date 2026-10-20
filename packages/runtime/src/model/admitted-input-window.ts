// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ModelProfile } from "./configuration.js";

/**
 * The part of a bound model execution profile that says which input window
 * DocsFab admits requests against. Structural, so a composition root passes
 * the profile it bound, whichever path bound it.
 */
export interface AdmittedInputWindowSource {
  readonly contextAdmission?: "host-window" | "provider";
  readonly profile?: Partial<Pick<ModelProfile, "maxInputTokens" | "effectiveLimitReason">>;
  /**
   * Never present. An endpoint configuration (`ModelEndpointConfig`, which
   * carries `apiKey`) also has a `profile`, but that is the configured profile,
   * not the bound one: `docsfab setup --profile <composition>` leaves its
   * metadata unknown, and only binding marks the installed composition's window
   * as admitted. Passing `config.model` would drop every composition's window,
   * so it does not typecheck.
   */
  readonly apiKey?: never;
}

/**
 * The input window, in tokens, that DocsFab admits a bound model's requests
 * against: the profile's `maxInputTokens` when that window is attested. An
 * installed composition's window is attested whatever its profile metadata
 * says (`effectiveLimitReason: composition-candidate`), and so is the window
 * of a profile whose metadata is current.
 *
 * `undefined` means no window is attested, and a caller must not size anything
 * from one:
 * - there is no bound profile;
 * - `contextAdmission` is `provider`, so the provider, not DocsFab, admits input;
 * - the profile matches no installed composition and its metadata is unknown or
 *   stale. This covers the placeholder window `docsfab setup` writes for an
 *   endpoint that matches no installed composition,
 *   `modelProfile.conservativeFallbackContextWindow`, even when a caller passes
 *   that profile without its `contextAdmission`;
 * - the window is not a positive whole number of tokens.
 *
 * Every budget sized from a model's window reads it here: source reads through
 * `sourceReadBudgetForModel`, and context packets through
 * `contextPacketInputWindow`. Pass the bound execution profile, never the
 * endpoint configuration it was bound from.
 */
export function admittedInputWindowTokens(
  bound: AdmittedInputWindowSource | null | undefined,
): number | undefined {
  if (!bound || bound.contextAdmission === "provider") return undefined;
  const reason = bound.profile?.effectiveLimitReason;
  if (reason === "metadata-unknown" || reason === "metadata-stale") return undefined;
  const window = bound.profile?.maxInputTokens;
  return typeof window === "number" && Number.isSafeInteger(window) && window > 0
    ? window
    : undefined;
}
