// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The repository inventory's limit names and operator-line grammar, as a
 * stable leaf: contract modules read them without importing the limits
 * resolver, which sits in an import cycle.
 */
import { LIMIT_DEFINITION_BY_NAME } from "./limits.generated.js";

export const REPOSITORY_INVENTORY_MAX_ENTRIES_LIMIT = "repository.inventoryMaxEntries" as const;
/** Largest tracked file the inventory reads into its text index (#1932). */
export const REPOSITORY_INVENTORY_TEXT_MAX_FILE_BYTES_LIMIT =
  "repository.inventoryTextMaxFileBytes" as const;
/** Bytes of tracked text the inventory's text index holds, summed over files (#1932). */
export const REPOSITORY_INVENTORY_TEXT_MAX_TOTAL_BYTES_LIMIT =
  "repository.inventoryTextMaxTotalBytes" as const;
/**
 * Code of the operator line that counts tracked files the text index left out
 * because they are not UTF-8 text, with a sample of their paths (#1932). No
 * limit governs it, so it is a line code rather than a limit's refusal.
 */
export const REPOSITORY_INVENTORY_INVALID_TEXT_LINE_CODE =
  "repository-inventory-invalid-text-input" as const;

/**
 * The inventory limits whose operator lines governed search records on the
 * run, so LIMITATIONS shows them even when the run keeps no inventory.
 */
const RECORDED_INVENTORY_LIMITS = Object.freeze([
  REPOSITORY_INVENTORY_MAX_ENTRIES_LIMIT,
  REPOSITORY_INVENTORY_TEXT_MAX_FILE_BYTES_LIMIT,
  REPOSITORY_INVENTORY_TEXT_MAX_TOTAL_BYTES_LIMIT,
]);

/**
 * The code an operator line starts with when it is one governed search records
 * for the repository inventory: a recorded limit's catalog refusal, or the
 * invalid-text line code. The line carries no control character. `undefined`
 * for any other line.
 */
export function repositoryInventoryLineCode(line: unknown): string | undefined {
  if (typeof line !== "string" || /[\u0000-\u001f\u007f]/u.test(line)) return undefined;
  for (const name of RECORDED_INVENTORY_LIMITS) {
    const refusal = LIMIT_DEFINITION_BY_NAME[name]?.refusal;
    if (refusal !== undefined && line.startsWith(`${refusal}: `)) return refusal;
  }
  if (line.startsWith(`${REPOSITORY_INVENTORY_INVALID_TEXT_LINE_CODE}: `)) {
    return REPOSITORY_INVENTORY_INVALID_TEXT_LINE_CODE;
  }
  return undefined;
}

/**
 * Whether an operator line reports `repository.inventoryMaxEntries`: it
 * starts with that limit's catalog refusal code and carries no control
 * character. Governed workflow search records such a line on the run when it
 * degraded past the limit, and LIMITATIONS projects it (#1927).
 */
export function isRepositoryInventoryEntryLimitation(line: unknown): line is string {
  const refusal = LIMIT_DEFINITION_BY_NAME[REPOSITORY_INVENTORY_MAX_ENTRIES_LIMIT]?.refusal;
  return refusal !== undefined && repositoryInventoryLineCode(line) === refusal;
}

/**
 * Whether an operator line reports a text index limit,
 * `repository.inventoryTextMaxFileBytes` or
 * `repository.inventoryTextMaxTotalBytes`. Governed workflow search records
 * one such line for each limit that left files out of the text index, naming
 * the observed value, the setting to raise, and how many files it left out,
 * and LIMITATIONS projects it (#1932).
 */
export function isRepositoryInventoryTextLimitation(line: unknown): line is string {
  const refusal = repositoryInventoryLineCode(line);
  return (
    refusal !== undefined &&
    (refusal ===
      LIMIT_DEFINITION_BY_NAME[REPOSITORY_INVENTORY_TEXT_MAX_FILE_BYTES_LIMIT]?.refusal ||
      refusal ===
        LIMIT_DEFINITION_BY_NAME[REPOSITORY_INVENTORY_TEXT_MAX_TOTAL_BYTES_LIMIT]?.refusal)
  );
}
