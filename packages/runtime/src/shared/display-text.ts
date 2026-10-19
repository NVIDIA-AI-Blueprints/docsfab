// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * One escape set for text a reader sees: repository names in content index
 * notices and run warnings, and context-preflight cause messages.
 */

/**
 * A code point a reader-facing line never carries raw: a control character
 * (C0, DEL, C1), a format character such as the right-to-left override
 * U+202E, the isolates U+2066 to U+2069, or a zero-width space, or a line or
 * paragraph separator.
 */
export const UNDISPLAYABLE_CODE_POINT = /[\u0000-\u001f\u007f-\u009f\p{Cf}\p{Zl}\p{Zp}]/u;
const UNDISPLAYABLE_CODE_POINTS = new RegExp(UNDISPLAYABLE_CODE_POINT.source, "gu");

/** One code point written as `\u{...}`, lowercase hex. */
export function escapeCodePoint(character: string): string {
  return `\\u{${character.codePointAt(0)!.toString(16)}}`;
}

/** `text` with every undisplayable code point written as `\u{...}`. */
export function escapeUndisplayable(text: string): string {
  return text.replace(UNDISPLAYABLE_CODE_POINTS, escapeCodePoint);
}
