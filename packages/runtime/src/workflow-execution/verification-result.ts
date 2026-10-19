// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Import facade for the technical-verification contract. Validation lives in
 * review-response.ts so execution has one decoder and one grammar; legacy
 * retained-record decoding stays explicit at its caller.
 */
export {
  authoritativeReviewTargetPaths,
  decodeVerificationResponse,
  projectTechnicalReviewFailure,
  requiresVerificationResult,
  retainedTechnicalReviewFindings,
  retainSafeReviewFindings,
  TECHNICAL_FACT_DIMENSIONS,
  validateVerificationResult,
  VERIFICATION_RESPONSE_CONTRACT,
  wrapTechnicalReviewFailure,
  type TechnicalFactDimension,
  type TechnicalFactInventory,
  type VerificationResult,
} from "./review-response.js";
