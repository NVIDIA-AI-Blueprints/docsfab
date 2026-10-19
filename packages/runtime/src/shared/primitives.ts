// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Leaf value, error, and filesystem primitives shared across runtime modules.
 *
 * Keep this module free of runtime-source imports (Node built-ins only) so any
 * module can import it without creating an evaluation cycle.
 */
import { lstat } from "node:fs/promises";

/** Orders strings by UTF-16 code unit (`<` / `>`), never by locale. */
export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Accepts any non-null, non-array object, whatever its prototype chain. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Accepts only a non-array object that inherits directly from
 * `Object.prototype`; null-prototype objects and class instances fail.
 */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

/** Accepts an `Error` instance whose `code` equals `code`. */
export function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

/** Accepts any non-null object, `Error` or not, whose `code` equals `code`. */
export function hasErrnoCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

/** Reports whether `lstat` succeeds; every `lstat` failure reads as absent. */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}
