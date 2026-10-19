// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  createContractKit,
  createReceiptReplayGuard,
  deepFreeze,
  type ContractFail,
} from "../contract-kit/index.js";

/** Must stay equal to `ExternalInputContractErrorCode` in contracts.ts. */
export type InputsDialectCode =
  | "invalid-shape"
  | "invalid-value"
  | "digest-mismatch"
  | "credential-material"
  | "duplicate-input"
  | "lifecycle-conflict"
  | "authority-required"
  | "authority-replayed"
  | "substitution"
  | "migration-required";

export const INPUTS_DIALECT_CODES = {
  invalidShape: "invalid-shape",
  invalidValue: "invalid-value",
  digestMismatch: "digest-mismatch",
  credentialMaterial: "credential-material",
  schemaMismatch: "migration-required",
} as const satisfies Record<string, InputsDialectCode>;

export function createInputsDialect(fail: ContractFail<InputsDialectCode>) {
  return createContractKit({
    fail,
    codes: INPUTS_DIALECT_CODES,
  });
}

export function createInputsReceiptGuard(fail: ContractFail<InputsDialectCode>) {
  return createReceiptReplayGuard(fail, "authority-replayed");
}

export { deepFreeze };
