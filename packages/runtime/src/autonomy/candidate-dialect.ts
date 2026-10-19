// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createContractKit, deepFreeze, type ContractFail } from "../contract-kit/index.js";

/**
 * Closed-schema dialect for candidate keep/discard, plateau, and experiment
 * ledger records. Distinct from the catalog's `evaluate` WorkflowStepKind.
 */
export type CandidateDialectCode =
  | "invalid-shape"
  | "invalid-value"
  | "digest-mismatch"
  | "credential-material"
  | "schema-mismatch"
  | "migration-required"
  | "objective-regression"
  | "budget-exhausted"
  | "plateau"
  | "replay-duplicate"
  | "workspace-isolation";

export const CANDIDATE_DIALECT_CODES = {
  invalidShape: "invalid-shape",
  invalidValue: "invalid-value",
  digestMismatch: "digest-mismatch",
  credentialMaterial: "credential-material",
  schemaMismatch: "migration-required",
} as const satisfies Record<string, CandidateDialectCode>;

export function createCandidateDialect(fail: ContractFail<CandidateDialectCode>) {
  return createContractKit({
    fail,
    inertMode: "strict",
    codes: CANDIDATE_DIALECT_CODES,
  });
}

export { deepFreeze };
