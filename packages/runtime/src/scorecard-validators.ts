// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared scorecard SHA-256, identifier, and calendar-date checks.
 *
 * Decode (`scorecard.ts`) and render (`scorecard-render.ts`) must accept
 * the same hashes, ids, and dates. Kit `hash()` matches SHA-256, but kit
 * `identifier()` / `timestamp()` are broader (mixed case, path chars,
 * RFC3339 instants) and throw through a contract `fail()` — they are not
 * drop-in replacements for these boolean scorecard predicates.
 */

export const SHA256 = /^[a-f0-9]{64}$/u;
export const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;
export const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export function isScorecardSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256.test(value);
}

export function isScorecardSafeId(value: unknown): value is string {
  return typeof value === "string" && SAFE_ID.test(value);
}

export function isScorecardIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

export function isScorecardIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_TIMESTAMP.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}
