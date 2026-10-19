// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * RequestIntentV1: contract, closed decode, Correct-class admission, seal,
 * and verification. Nothing in the shipped product calls these yet; the
 * request-interpretation step is their first caller.
 */
export * from "./contract.js";
export {
  decodeRequestIntentProposal,
  isRepositoryRelativePath,
} from "./decode.js";
export { admitRequestIntent } from "./admit.js";
export { requestIntentExistencePaths } from "./host-input.js";
export { requestIntentWriteSet, verifyRequestIntentDigest } from "./seal.js";
export {
  groundQuote,
  requestInstructionSha256,
  type QuoteSpan,
} from "./quote.js";
export {
  REQUEST_INTENT_LIMIT_NAMES,
  resolveRequestIntentLimits,
  type RequestIntentAdmissionInput,
  type RequestIntentDecodeInput,
  type RequestIntentLimits,
} from "./limits.js";
export {
  RequestIntentContractError,
  type RequestIntentHostFaultCode,
} from "./kit.js";
