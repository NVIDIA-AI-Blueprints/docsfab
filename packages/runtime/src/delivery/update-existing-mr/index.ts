// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export {
  UPDATE_EXISTING_MR_AUTHORITY_KIND,
  UPDATE_EXISTING_MR_EVALUATION_KIND,
  UPDATE_EXISTING_MR_KIND,
  UPDATE_EXISTING_MR_POLICY_VERSION,
  UpdateExistingMrError,
  authorityPolicy,
  createFallback,
  createUpdateExistingMrAuthority,
  createUpdateExistingMrRequest,
  decodeUpdateExistingMrRequest,
  normalizeUpdateExistingMrObservation,
  normalizeUpdateExistingMrGrant,
  sealEvaluation,
  type UpdateExistingMrAuthorityPolicyV1,
  type UpdateExistingMrAuthorityV1,
  type UpdateExistingMrEvaluationV1,
  type UpdateExistingMrFallbackV1,
  type UpdateExistingMrGrantV1,
  type UpdateExistingMrRequestInputV1,
  type UpdateExistingMrRequestV1,
  type UpdateExistingMrScmObservationV1,
} from "./contracts.js";
export {
  assertUpdateExistingMrAllowed,
  evaluateUpdateExistingMr,
} from "./evaluate.js";
