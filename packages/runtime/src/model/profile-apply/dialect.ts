// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Profile-apply closed-schema dialect: contract-kit primitives bound to ProfileApplyError. */
import { createContractKit, deepFreeze, type ContractFail } from "../../contract-kit/index.js";
import { ProfileApplyError } from "./types.js";

export type ProfileApplyDialectCode =
  | "invalid-shape"
  | "invalid-value"
  | "digest-mismatch"
  | "credential-material"
  | "schema-mismatch"
  | "migration-required";

export const PROFILE_APPLY_DIALECT_CODES = {
  invalidShape: "invalid-shape",
  invalidValue: "invalid-value",
  digestMismatch: "digest-mismatch",
  credentialMaterial: "credential-material",
  schemaMismatch: "migration-required",
} as const satisfies Record<string, ProfileApplyDialectCode>;

export function invalid(): never {
  throw new ProfileApplyError();
}

const fail: ContractFail<ProfileApplyDialectCode> = () => invalid();

export const kit = createContractKit({
  fail,
  codes: PROFILE_APPLY_DIALECT_CODES,
});

export { deepFreeze };
