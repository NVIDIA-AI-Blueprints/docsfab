// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createContractKit, deepFreeze, type ContractFail } from "../contract-kit/index.js";

/** Closed-schema dialect binding for autonomous-cycle contracts. */
export type AutonomyDialectCode =
  | "invalid-shape"
  | "invalid-value"
  | "digest-mismatch"
  | "scope-expansion"
  | "workflow-not-registered"
  | "prerequisite-unsatisfied"
  | "decision-conflict"
  | "authorization-required"
  | "authorization-expired"
  | "migration-required";

export const AUTONOMY_DIALECT_CODES = {
  invalidShape: "invalid-shape",
  invalidValue: "invalid-value",
  digestMismatch: "digest-mismatch",
  credentialMaterial: "invalid-value",
  schemaMismatch: "migration-required",
} as const satisfies Record<string, AutonomyDialectCode>;

export function createAutonomyDialect(fail: ContractFail<AutonomyDialectCode>) {
  return createContractKit({
    fail,
    inertMode: "strict",
    codes: AUTONOMY_DIALECT_CODES,
  });
}

export { deepFreeze };
