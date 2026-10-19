// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { canonicalJson } from "../../content-ir/canonical.js";
import type { DocumentationMaturityGateId } from "../../maturity/index.js";
import type { MaturityCascadeBaselineCaseV1 } from "../maturity-cascade.js";

const SHA = /^[a-f0-9]{64}$/u;

const SAFE_ID = /^[a-z0-9](?:[a-z0-9._-]{0,127})$/u;

export function record(value: unknown): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    invalid();
  return value as Record<string, unknown>;
}

export function exact(value: Record<string, unknown>, keys: string[]): void {
  if (canonicalJson(Object.keys(value).sort()) !== canonicalJson([...keys].sort())) invalid();
}

export function safeId(value: unknown): string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) invalid();
  return value;
}

export function safeMissingInputId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,255})$/u.test(value))
    invalid();
  return value;
}

export function safePath(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 1024 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.split("/").some((item) => item === "" || item === "." || item === "..")
  )
    invalid();
  return value;
}

export function sha(value: unknown): string {
  if (typeof value !== "string" || !SHA.test(value)) invalid();
  return value;
}

export function gateId(value: unknown): DocumentationMaturityGateId {
  if (!["G0", "G1", "G2", "G3", "G4", "G5"].includes(value as string)) invalid();
  return value as DocumentationMaturityGateId;
}

export function disposition(
  value: unknown,
): MaturityCascadeBaselineCaseV1["gateDispositions"][number]["disposition"] {
  if (!["satisfied", "not-ready", "unknown", "blocked", "not-applicable"].includes(value as string))
    invalid();
  return value as MaturityCascadeBaselineCaseV1["gateDispositions"][number]["disposition"];
}

export function sortedUnique(values: string[]): boolean {
  return (
    new Set(values).size === values.length &&
    values.every((value, index) => index === 0 || values[index - 1]! < value)
  );
}

export function invalid(): never {
  throw new Error("Maturity cascade evaluation input is invalid.");
}
