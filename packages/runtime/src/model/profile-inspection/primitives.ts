// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../../json-evidence.js";
import { detectCredentialRuleIdsInValue } from "../../security/repository-scanner.js";

const SAFE_SOURCE_CODES = new Set([
  "invalid-configuration",
  "timeout",
  "network-failure",
  "redirected-response",
  "cross-origin-response",
  "http-status",
  "oversized-response",
  "malformed-response",
  "model-absent",
  "model-duplicate",
  "invalid-metadata-credential",
  "request-failed",
  "request-timeout",
  "response-rejected",
  "pagination-rejected",
  "model-not-found",
  "duplicate-model-label",
  "catalog-unavailable",
  "metadata-api-key-missing",
  "metadata-configuration-missing",
  "metadata-configuration-invalid",
  "hub-metadata-not-applicable",
  "adapter-not-implemented",
]);

function digest(value: unknown): string {
  return createHash("sha256")
    .update(canonicalizeJsonEvidence(value as JsonEvidenceValue))
    .digest("hex");
}

function assertCredentialFree(value: unknown): void {
  if (detectCredentialRuleIdsInValue(value).length > 0) {
    throw new Error("Model profile inspection rejected sensitive output.");
  }
}

function dataObject(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    invalidReport();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(value).some((key) => typeof key !== "string") ||
    Object.keys(descriptors).sort().join(",") !== [...keys].sort().join(",") ||
    Object.values(descriptors).some((item) => !("value" in item) || !item.enumerable)
  )
    invalidReport();
}

function invalidReport(): never {
  throw new Error("invalid-model-profile-inspection");
}

function validTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
    new Date(value).toISOString() === value
  );
}

export {
  SAFE_SOURCE_CODES,
  digest,
  assertCredentialFree,
  dataObject,
  invalidReport,
  validTimestamp,
};
