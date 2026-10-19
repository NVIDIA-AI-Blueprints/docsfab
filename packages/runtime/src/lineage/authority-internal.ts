// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHostAuthorityFactory } from "../contract-kit/index.js";
import type { TaskLineageAuthorityChallengeV1 } from "./contracts.js";

/** @internal Trusted host boundary; intentionally absent from lineage/index. */
export interface InternalTaskLineageHostAuthority {
  readonly kind: "docsfab-task-lineage-internal-host-authority";
}

export interface InternalTaskLineageHostVerifier {
  verifyCurrent(challenge: TaskLineageAuthorityChallengeV1): Promise<{
    status: "current";
    challengeSha256: string;
    /** Host-owned wall clock. */
    observedAt: string;
    /** Single host-issued receipt identity; reusing it for another mint is rejected. */
    authorityReceiptSha256: string;
  }>;
}

const authorities = createHostAuthorityFactory<
  "docsfab-task-lineage-internal-host-authority",
  InternalTaskLineageHostVerifier
>({
  kind: "docsfab-task-lineage-internal-host-authority",
  invalidMessage: "Trusted task-lineage host verifier is invalid.",
});

export function internalCreateTaskLineageHostAuthority(
  verifier: InternalTaskLineageHostVerifier,
): InternalTaskLineageHostAuthority {
  return authorities.create(verifier);
}

export function internalTaskLineageHostVerifier(
  authority: InternalTaskLineageHostAuthority,
): InternalTaskLineageHostVerifier | undefined {
  return authorities.lookup(authority);
}
