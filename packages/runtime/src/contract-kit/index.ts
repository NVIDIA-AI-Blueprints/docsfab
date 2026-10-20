// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared closed-schema contract primitives and opaque host-authority factory.
 * Domain modules (lineage, inputs, autonomy, leases) bind fail() + codes.
 * Not exported from the published package surface.
 */

export { deepFreeze } from "./freeze.js";
export { escapePathText, UNSAFE_PATH_CODE_POINT } from "./path-characters.js";
export {
  annotateContractBoundExceeded,
  CONTRACT_DECODE_BOUND_AXES,
  CONTRACT_MAX_ARRAY_LENGTH,
  CONTRACT_MAX_DEPTH,
  CONTRACT_MAX_NODES,
  CONTRACT_MAX_STRING_CHARS,
  contractBoundExceededOf,
  contractDecodeLimits,
  formatContractBoundExceeded,
  type ContractBoundExceeded,
  type ContractDecodeBoundAxis,
  type ContractDecodeLimitSnapshot,
} from "./decode-bounds.js";
export {
  createContractKit,
  createReceiptReplayGuard,
  type ContractFail,
  type ContractInertMode,
  type ContractKit,
  type ContractKitCodes,
  type ContractKitOptions,
  type SealedEnvelope,
} from "./primitives.js";
export {
  createHostAuthorityFactory,
  type HostAuthorityFactory,
  type HostAuthorityFactoryOptions,
} from "./host-authority.js";
export { canonicalDigest, canonicalJson } from "../content-ir/canonical.js";
