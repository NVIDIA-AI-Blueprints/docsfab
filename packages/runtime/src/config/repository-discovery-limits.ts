// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Operational bounds for repository inventory, navigation observation, and
 * workspace export, projected from the operational-limits catalog.
 *
 * Crossing an inventory or navigation bound records a failure or truncation
 * flag on the sealed observation. It does not silently drop the overflow.
 */
import { limit, resolveLimits, type ResolveLimitsOptions, type ResolvedLimit } from "./limits.js";
import { REPOSITORY_INVENTORY_MAX_ENTRIES_LIMIT } from "./repository-inventory-limit.js";

export {
  isRepositoryInventoryEntryLimitation,
  isRepositoryInventoryTextLimitation,
  REPOSITORY_INVENTORY_INVALID_TEXT_LINE_CODE,
  REPOSITORY_INVENTORY_MAX_ENTRIES_LIMIT,
  REPOSITORY_INVENTORY_TEXT_MAX_FILE_BYTES_LIMIT,
  REPOSITORY_INVENTORY_TEXT_MAX_TOTAL_BYTES_LIMIT,
  repositoryInventoryLineCode,
} from "./repository-inventory-limit.js";

export const REPOSITORY_NAVIGATION_MAX_SOURCES_LIMIT = "repository.navigationMaxSources" as const;
export const REPOSITORY_NAVIGATION_MAX_SOURCE_BYTES_LIMIT =
  "repository.navigationMaxSourceBytes" as const;
export const REPOSITORY_NAVIGATION_MAX_TOTAL_SOURCE_BYTES_LIMIT =
  "repository.navigationMaxTotalSourceBytes" as const;
export const REPOSITORY_NAVIGATION_MAX_TARGETS_LIMIT = "repository.navigationMaxTargets" as const;
export const REPOSITORY_NAVIGATION_MAX_TARGET_BYTES_LIMIT =
  "repository.navigationMaxTargetBytes" as const;
export const REPOSITORY_NAVIGATION_MAX_TOTAL_TARGET_BYTES_LIMIT =
  "repository.navigationMaxTotalTargetBytes" as const;

export interface RepositoryNavigationBudgetsV1 {
  readonly maxSources: number;
  readonly maxSourceBytes: number;
  readonly maxTotalSourceBytes: number;
  readonly maxTargets: number;
  readonly maxTargetBytes: number;
  readonly maxTotalTargetBytes: number;
}

export function repositoryInventoryMaxEntriesLimit(options?: ResolveLimitsOptions): ResolvedLimit {
  return limit(REPOSITORY_INVENTORY_MAX_ENTRIES_LIMIT, options);
}

export function repositoryInventoryMaxEntries(options?: ResolveLimitsOptions): number {
  return repositoryInventoryMaxEntriesLimit(options).value;
}

/**
 * The catalog limit behind each workspace export ceiling. `maxStallMs` is a
 * no-progress window, not a wall clock: every finished step of the export
 * restarts it, so a slow export that keeps moving is never stopped.
 */
export const REPOSITORY_WORKSPACE_EXPORT_LIMITS = Object.freeze({
  maxTreeEntries: "repository.workspaceExportMaxTreeEntries",
  maxAggregateBytes: "repository.workspaceExportMaxAggregateBytes",
  maxScratchBytes: "repository.workspaceExportMaxScratchBytes",
  maxTreeMetadataBytes: "repository.workspaceExportMaxTreeMetadataBytes",
  maxStallMs: "repository.workspaceExportStallMs",
} as const);

export type RepositoryWorkspaceExportLimitsV1 = {
  readonly [Axis in keyof typeof REPOSITORY_WORKSPACE_EXPORT_LIMITS]: ResolvedLimit;
};

/**
 * Every workspace export ceiling, resolved once with host overrides applied,
 * which may raise or lower each one. The export, the checked-tree walk, and the
 * original source authority read the same values, so a raise reaches all three.
 */
export function repositoryWorkspaceExportLimits(
  options?: ResolveLimitsOptions,
): RepositoryWorkspaceExportLimitsV1 {
  const resolved = resolveLimits(options);
  const named = (name: string): ResolvedLimit => {
    const entry = resolved.find((candidate) => candidate.name === name);
    if (!entry) {
      throw new Error(`Unknown operational limit ${name} is not declared in config/limits.yaml.`);
    }
    return entry;
  };
  return Object.freeze({
    maxTreeEntries: named(REPOSITORY_WORKSPACE_EXPORT_LIMITS.maxTreeEntries),
    maxAggregateBytes: named(REPOSITORY_WORKSPACE_EXPORT_LIMITS.maxAggregateBytes),
    maxScratchBytes: named(REPOSITORY_WORKSPACE_EXPORT_LIMITS.maxScratchBytes),
    maxTreeMetadataBytes: named(REPOSITORY_WORKSPACE_EXPORT_LIMITS.maxTreeMetadataBytes),
    maxStallMs: named(REPOSITORY_WORKSPACE_EXPORT_LIMITS.maxStallMs),
  });
}

export function repositoryNavigationBudgets(
  options?: ResolveLimitsOptions,
): RepositoryNavigationBudgetsV1 {
  return Object.freeze({
    maxSources: limit(REPOSITORY_NAVIGATION_MAX_SOURCES_LIMIT, options).value,
    maxSourceBytes: limit(REPOSITORY_NAVIGATION_MAX_SOURCE_BYTES_LIMIT, options).value,
    maxTotalSourceBytes: limit(REPOSITORY_NAVIGATION_MAX_TOTAL_SOURCE_BYTES_LIMIT, options).value,
    maxTargets: limit(REPOSITORY_NAVIGATION_MAX_TARGETS_LIMIT, options).value,
    maxTargetBytes: limit(REPOSITORY_NAVIGATION_MAX_TARGET_BYTES_LIMIT, options).value,
    maxTotalTargetBytes: limit(REPOSITORY_NAVIGATION_MAX_TOTAL_TARGET_BYTES_LIMIT, options).value,
  });
}
