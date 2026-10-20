// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";

import { canonicalDigest } from "../../content-ir/canonical.js";
import { isDeclaredSourceOverflowLimitName } from "../../config/source-read-limits.js";
import { SOURCE_REPRESENTATION_LIMITATIONS } from "../../inputs/source-evidence.js";
import { navigationFromInventory } from "../../operator/run-limit-overflow.js";
import { decodeRepositoryDiscoveryInventory } from "../../repository/inventory.js";
import { isRecord } from "../../shared/primitives.js";

const SHA256_HEX = /^[a-f0-9]{64}$/u;

function exactFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return Object.keys(value).every((key) => fields.includes(key));
}

function validNavigationRow(row: unknown, type: "source" | "route" | "failure"): boolean {
  if (!isRecord(row) || typeof row.adapter !== "string" || typeof row.path !== "string")
    return false;
  if (typeof row.evidenceSha256 !== "string" || !SHA256_HEX.test(row.evidenceSha256)) return false;
  if (type === "source") {
    if (
      !exactFields(row, ["adapter", "path", "contentSha256", "evidenceSha256"]) ||
      typeof row.contentSha256 !== "string" ||
      !SHA256_HEX.test(row.contentSha256)
    )
      return false;
    const { evidenceSha256, ...body } = row;
    return canonicalDigest(body) === evidenceSha256;
  }
  if (type === "route") {
    if (
      !exactFields(row, [
        "adapter",
        "sourcePath",
        "path",
        "route",
        "sourceSha256",
        "targetSha256",
        "evidenceSha256",
      ]) ||
      typeof row.sourcePath !== "string" ||
      (row.route !== null && typeof row.route !== "string") ||
      typeof row.sourceSha256 !== "string" ||
      !SHA256_HEX.test(row.sourceSha256) ||
      typeof row.targetSha256 !== "string" ||
      !SHA256_HEX.test(row.targetSha256)
    )
      return false;
    const { evidenceSha256, ...body } = row;
    return canonicalDigest(body) === evidenceSha256;
  }
  if (
    !exactFields(row, ["adapter", "code", "path", "evidenceSha256", "overflow"]) ||
    typeof row.code !== "string"
  )
    return false;
  if (row.overflow === undefined) return true;
  return (
    isRecord(row.overflow) &&
    exactFields(row.overflow, ["limitName", "observed"]) &&
    typeof row.overflow.limitName === "string" &&
    Number.isSafeInteger(row.overflow.observed) &&
    (row.overflow.observed as number) >= 0
  );
}

/** This is destructive admission; the display loader deliberately tolerates partial evidence. */
export function validOverflowSidecar(value: Record<string, unknown>, owner: string): boolean {
  if (
    value.schemaVersion !== 1 ||
    value.kind !== "docsfab-run-limit-overflow" ||
    value.runId !== owner ||
    !exactFields(value, [
      "schemaVersion",
      "kind",
      "runId",
      "inventory",
      "navigation",
      "sourceRepresentations",
    ])
  )
    return false;
  if (
    value.inventory === undefined &&
    value.navigation === undefined &&
    value.sourceRepresentations === undefined
  )
    return false;
  let inventory: ReturnType<typeof decodeRepositoryDiscoveryInventory> | undefined;
  if (value.inventory !== undefined) {
    try {
      inventory = decodeRepositoryDiscoveryInventory(value.inventory);
    } catch {
      return false;
    }
  }
  if (value.navigation !== undefined) {
    const navigation = value.navigation;
    if (
      !isRecord(navigation) ||
      !exactFields(navigation, [
        "schemaVersion",
        "kind",
        "repositoryRevision",
        "status",
        "graphEdgeCount",
        "navigationEdgeCount",
        "paths",
        "sources",
        "routes",
        "failures",
        "contentIndexSha256",
        "evidenceSha256",
      ]) ||
      navigation.schemaVersion !== 1 ||
      navigation.kind !== "docsfab-repository-navigation-observation" ||
      typeof navigation.repositoryRevision !== "string" ||
      (navigation.status !== "complete" && navigation.status !== "incomplete") ||
      !Number.isSafeInteger(navigation.graphEdgeCount) ||
      !Number.isSafeInteger(navigation.navigationEdgeCount) ||
      !Array.isArray(navigation.paths) ||
      !navigation.paths.every((path) => typeof path === "string") ||
      !Array.isArray(navigation.sources) ||
      !Array.isArray(navigation.routes) ||
      !Array.isArray(navigation.failures) ||
      (navigation.contentIndexSha256 !== null &&
        (typeof navigation.contentIndexSha256 !== "string" ||
          !SHA256_HEX.test(navigation.contentIndexSha256))) ||
      typeof navigation.evidenceSha256 !== "string" ||
      !SHA256_HEX.test(navigation.evidenceSha256)
    )
      return false;
    const { evidenceSha256, ...body } = navigation;
    const fromInventory =
      inventory !== undefined && isDeepStrictEqual(navigation, navigationFromInventory(inventory));
    if (canonicalDigest(body) !== evidenceSha256 && !fromInventory) return false;
    if (
      !navigation.sources.every((row) => validNavigationRow(row, "source")) ||
      !navigation.routes.every((row) => validNavigationRow(row, "route")) ||
      !navigation.failures.every((row) => validNavigationRow(row, "failure"))
    )
      return false;
  }
  if (value.sourceRepresentations !== undefined) {
    if (
      !Array.isArray(value.sourceRepresentations) ||
      value.sourceRepresentations.length === 0 ||
      !value.sourceRepresentations.every(
        (row) =>
          isRecord(row) &&
          exactFields(row, ["limitations", "overflows"]) &&
          Array.isArray(row.limitations) &&
          row.limitations.every(
            (item) =>
              typeof item === "string" &&
              SOURCE_REPRESENTATION_LIMITATIONS.includes(
                item as (typeof SOURCE_REPRESENTATION_LIMITATIONS)[number],
              ),
          ) &&
          (row.overflows === undefined ||
            (Array.isArray(row.overflows) &&
              row.overflows.every(
                (overflow) =>
                  isRecord(overflow) &&
                  exactFields(overflow, ["limitation", "limitName", "observed"]) &&
                  typeof overflow.limitation === "string" &&
                  SOURCE_REPRESENTATION_LIMITATIONS.includes(
                    overflow.limitation as (typeof SOURCE_REPRESENTATION_LIMITATIONS)[number],
                  ) &&
                  typeof overflow.limitName === "string" &&
                  isDeclaredSourceOverflowLimitName(overflow.limitName) &&
                  Number.isSafeInteger(overflow.observed) &&
                  (overflow.observed as number) >= 0,
              ))),
      )
    )
      return false;
  }
  return true;
}
