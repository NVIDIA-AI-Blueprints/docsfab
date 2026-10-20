// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHostAuthorityFactory } from "../contract-kit/index.js";
import type { AutoCycleAuthorityChallengeV1 } from "./contracts.js";

/** @internal Trusted host boundary. This module is intentionally absent from autonomy/index. */
export interface InternalAutoCycleHostAuthority {
  readonly kind: "docsfab-auto-cycle-internal-host-authority";
}

export interface InternalAutoCycleHostVerifier {
  verifyCurrent(challenge: AutoCycleAuthorityChallengeV1): Promise<{
    status: "current";
    challengeSha256: string;
    /** Host-owned wall clock; callers cannot supply authorization time. */
    observedAt: string;
  }>;
}

const authorities = createHostAuthorityFactory<
  "docsfab-auto-cycle-internal-host-authority",
  InternalAutoCycleHostVerifier
>({
  kind: "docsfab-auto-cycle-internal-host-authority",
  invalidMessage: "Trusted autonomous-cycle host verifier is invalid.",
});

/**
 * Host adapters may register a verifier inside DocsFab, but callers cannot
 * fabricate the returned authority by copying its public shape.
 */
export function internalCreateAutoCycleHostAuthority(
  verifier: InternalAutoCycleHostVerifier,
): InternalAutoCycleHostAuthority {
  return authorities.create(verifier);
}

export function internalAutoCycleHostVerifier(
  authority: InternalAutoCycleHostAuthority,
): InternalAutoCycleHostVerifier | undefined {
  return authorities.lookup(authority);
}
