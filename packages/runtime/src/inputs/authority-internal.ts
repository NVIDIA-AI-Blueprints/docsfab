// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHostAuthorityFactory } from "../contract-kit/index.js";
import type { ExternalInputAuthorityChallengeV1 } from "./contracts.js";

/** @internal Trusted host boundary; intentionally absent from inputs/index. */
export interface InternalExternalInputHostAuthority {
  readonly kind: "docsfab-external-input-internal-host-authority";
}

export interface InternalExternalInputHostVerifier {
  verifyCurrent(challenge: ExternalInputAuthorityChallengeV1): Promise<{
    status: "current";
    challengeSha256: string;
    /** Host-owned wall clock. */
    observedAt: string;
    /** Single host-issued receipt identity; reusing it for another mint is rejected. */
    authorityReceiptSha256: string;
  }>;
}

const authorities = createHostAuthorityFactory<
  "docsfab-external-input-internal-host-authority",
  InternalExternalInputHostVerifier
>({
  kind: "docsfab-external-input-internal-host-authority",
  invalidMessage: "Trusted external-input host verifier is invalid.",
});

export function internalCreateExternalInputHostAuthority(
  verifier: InternalExternalInputHostVerifier,
): InternalExternalInputHostAuthority {
  return authorities.create(verifier);
}

export function internalExternalInputHostVerifier(
  authority: InternalExternalInputHostAuthority,
): InternalExternalInputHostVerifier | undefined {
  return authorities.lookup(authority);
}
