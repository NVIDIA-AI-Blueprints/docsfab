// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Scan roots and CI trigger paths for the request-wording ratchet.
 *
 * Kept free of third-party imports: the CI path generator imports this module
 * in a job that runs before `npm ci`, so it must load from a bare checkout.
 */

/** Repository-relative roots holding product code that reads request text. */
export const SCAN_ROOTS = Object.freeze(["packages/runtime/src", "packages/knowledge/src"]);

/** Repository-relative paths of the checker and its baseline. */
export const CHECKER_INPUTS = Object.freeze([
  "packages/runtime/scripts/check-request-wording.mjs",
  "packages/runtime/scripts/request-wording-baseline.json",
  "packages/runtime/scripts/request-wording-scan-roots.mjs",
]);

/**
 * Repository-relative paths whose change can alter the ratchet's verdict:
 * every scan root, the checker, and its baseline. The CI generator renders
 * them into the runtime trigger rules, so the job that runs the check cannot
 * be skipped by an MR that touches only one of them.
 *
 * @returns {string[]}
 */
export function requestWordingCiPathPatterns() {
  return [...SCAN_ROOTS.map((root) => `${root}/**/*`), ...CHECKER_INPUTS];
}
