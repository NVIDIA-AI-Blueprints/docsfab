// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { fail } from "./evidence-error.js";
import { compareText } from "../shared/primitives.js";

export const SHA256 = /^[a-f0-9]{64}$/u;
export const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export function timestamp(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    fail("invalid-timestamp");
  }
  try {
    if (new Date(value).toISOString() !== value) fail("invalid-timestamp");
  } catch {
    fail("invalid-timestamp");
  }
  return value;
}

export function identifier(value: unknown): string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) fail("invalid-identifier");
  return value;
}

export function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  const sortedRight = [...right].sort(compareText);
  return (
    left.length === right.length &&
    [...left].sort(compareText).every((value, index) => value === sortedRight[index])
  );
}
