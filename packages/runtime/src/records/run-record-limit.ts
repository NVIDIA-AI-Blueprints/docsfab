// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  enforceLimit,
  limit,
  type ResolvedLimit,
  type ResolveLimitsOptions,
} from "../config/limits.js";

/**
 * The one bound every reader of a saved run record applies (#1932): `docsfab
 * runs` list and import, `docsfab why`, publication preflight, delivery
 * acceptance, the live agent's saved-run tool, and operator input fills. Its
 * value lives only in `config/limits/runs.yaml`.
 */
export const RUN_RECORD_MAX_BYTES_LIMIT = "runs.recordMaxBytes";

/** The effective run-record bound, host overrides included. */
export function runRecordMaxBytes(options?: ResolveLimitsOptions): ResolvedLimit {
  return limit(RUN_RECORD_MAX_BYTES_LIMIT, options);
}

/**
 * Refuse a record of `observedBytes` over the bound with the limit's own code,
 * observed size, and remediation (`OperationalLimitError`), never as malformed.
 */
export function enforceRunRecordMaxBytes(observedBytes: number, bound = runRecordMaxBytes()): void {
  enforceLimit(bound, observedBytes);
}
