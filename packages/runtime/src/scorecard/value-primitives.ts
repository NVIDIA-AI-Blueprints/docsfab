// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const REVISION = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
export const REQUIRED_RECORDS = 5;

export type ScorecardInputErrorCode =
  | "invalid-campaign"
  | "invalid-record-set"
  | "invalid-record"
  | "invalid-provenance"
  | "invalid-arithmetic"
  | "invalid-acceptance"
  | "invalid-dependency"
  | "invalid-verification"
  | "structural-evaluation-failed";

/** Content- and path-free input failure. */
export class ScorecardInputError extends Error {
  public constructor(public readonly code: ScorecardInputErrorCode) {
    super(`MVP scorecard input failed (${code}).`);
    this.name = "ScorecardInputError";
  }
}

export function canonicalJson(value: unknown): string {
  return `${canonical(value)}\n`;
}

export function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new ScorecardInputError("invalid-arithmetic");
    }
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  throw new ScorecardInputError("invalid-campaign");
}
