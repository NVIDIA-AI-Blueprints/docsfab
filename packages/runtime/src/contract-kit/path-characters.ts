// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Code points a sealed repository path cannot carry or display safely:
 * controls (including NUL and line feeds), format characters such as
 * bidirectional overrides, surrogates, private-use and unassigned code points,
 * and line or paragraph separators. A path holding one could forge a line of
 * host-written text or read differently from the bytes it names.
 */
export const UNSAFE_PATH_CODE_POINT = /[\p{C}\p{Zl}\p{Zp}]/u;

const PATH_ESCAPED = new RegExp(`["\\\\]|${UNSAFE_PATH_CODE_POINT.source}`, "gu");

/**
 * A path's text for placing between double quotes in host-written text: `"`
 * and `\` are backslash-escaped and each unsafe code point becomes `\u{hex}`,
 * so the quoted path is one token whatever characters it holds.
 */
export function escapePathText(path: string): string {
  return path.replace(PATH_ESCAPED, (character) =>
    character === '"' || character === "\\"
      ? `\\${character}`
      : `\\u{${character.codePointAt(0)!.toString(16)}}`,
  );
}
