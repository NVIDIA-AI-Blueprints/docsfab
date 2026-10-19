// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  canonicalizeJsonEvidence,
  parseJsonEvidence,
  type JsonEvidenceValue,
} from "../../operator/json-evidence.js";
import { assertReviewFindingDisclosure, type ReviewFindingV1 } from "../contracts.js";
import { normalizeRepositoryLocator } from "../../workflow-execution/review-response.js";

export const SAFE_CODE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
export interface ProjectedFindingBatch {
  readonly findings: readonly ReviewFindingV1[];
  readonly limitations: readonly string[];
}

export function parseCanonicalJson(
  summary: string | undefined,
): Record<string, JsonEvidenceValue> | null {
  if (typeof summary !== "string" || summary.trim() === "") return null;
  try {
    const source = summary.trim();
    const value = parseJsonEvidence(source);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    if (canonicalizeJsonEvidence(value) !== `${source}\n`) return null;
    return value;
  } catch {
    return null;
  }
}

export function object(
  value: JsonEvidenceValue | undefined,
): Record<string, JsonEvidenceValue> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

export function text(value: JsonEvidenceValue | undefined): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

export function safeText(value: JsonEvidenceValue | undefined): string | null {
  const result = text(value);
  if (
    !result ||
    /https?:\/\//iu.test(result) ||
    /(?:^|\s)(?:diff --git |index [a-f0-9]{7,}\.\.|@@ )/u.test(result)
  )
    return null;
  try {
    assertReviewFindingDisclosure(result);
  } catch {
    return null;
  }
  return result;
}

export function safeCode(value: string): string {
  return SAFE_CODE.test(value) ? value : "review-finding";
}

export function mapSeverity(value: JsonEvidenceValue | undefined): ReviewFindingV1["severity"] {
  switch (value) {
    case "critical":
      return "error";
    case "major":
    case "moderate":
      return "warning";
    case "minor":
      return "info";
    case "error":
      return "error";
    case "warning":
      return "warning";
    default:
      return "info";
  }
}

export function truncate(value: string): string {
  return value.length > 512 ? `${value.slice(0, 509)}...` : value;
}

export function parseLocation(value: JsonEvidenceValue | undefined): {
  path: string | null;
  line?: number;
  fidelity: "exact" | "partial" | "unavailable";
  malformed: boolean;
} {
  const textValue = text(value);
  if (!textValue) return { path: null, fidelity: "unavailable", malformed: false };
  const normalized = normalizeRepositoryLocator(textValue);
  return {
    path: normalized.path,
    ...(normalized.line !== undefined ? { line: normalized.line } : {}),
    fidelity: normalized.fidelity,
    malformed: normalized.malformed,
  };
}

export function parseEvidenceLocation(value: string): {
  path: string | null;
  line?: number;
  fidelity: "exact" | "partial" | "unavailable";
  malformed: boolean;
} {
  const normalized = normalizeRepositoryLocator(value, true);
  return {
    path: normalized.path,
    ...(normalized.line !== undefined ? { line: normalized.line } : {}),
    fidelity: normalized.fidelity,
    malformed: normalized.malformed,
  };
}

export function hasOnlyKeys(
  root: Record<string, JsonEvidenceValue>,
  required: readonly string[],
): boolean {
  return (
    Object.keys(root).length === required.length &&
    required.every((key) => Object.hasOwn(root, key))
  );
}

export function hasKeys(
  root: Record<string, JsonEvidenceValue>,
  required: readonly string[],
): boolean {
  return required.every((key) => Object.hasOwn(root, key));
}

export function keysWithin(
  root: Record<string, JsonEvidenceValue>,
  allowed: readonly string[],
): boolean {
  return Object.keys(root).every((key) => allowed.includes(key));
}
