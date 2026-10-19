// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Shared operator remediation identifiers for plans and error envelopes. */
export {
  OPERATOR_REMEDIATION_IDS,
  type OperatorRemediationId,
} from "./situation-catalog.js";
import type { OperatorRemediationId } from "./situation-catalog.js";

/** Init plan next-action codes (subset of the shared catalog). */
export type InitRemediationId = Extract<
  OperatorRemediationId,
  | "glab-auth-login"
  | "retry-gitlab-api"
  | "verify-gitlab-project-access"
  | "profile-inspect"
  | "doctor"
>;
