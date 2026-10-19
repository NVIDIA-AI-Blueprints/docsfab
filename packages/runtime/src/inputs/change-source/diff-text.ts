// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Git's own spelling of the unified diff header lines, for a forge arm that
 * writes `diff --git` sections around a forge's hunks. Every forge arm uses
 * these, so a header a forge record writes reads exactly as git would write
 * it for the same paths and modes.
 */

/** The object-type digits of a tree entry's mode: `10` file, `12` symlink, `16` submodule. */
const MODE_TYPE_DIGITS = 2;

/** Git's C-quoting for a header path (`core.quotePath=true`): the whole token, octal per UTF-8 byte. */
export function quotePath(prefixed: string): string {
  const bytes = Buffer.from(prefixed, "utf8");
  const plain = (byte: number) => byte >= 0x20 && byte < 0x7f && byte !== 0x22 && byte !== 0x5c;
  if (bytes.every(plain)) return prefixed;
  // Git's named escapes; every other byte outside printable ASCII is octal.
  const escapes: Readonly<Record<string, string>> = {
    "\u0007": "\\a",
    "\b": "\\b",
    "\t": "\\t",
    "\n": "\\n",
    "\v": "\\v",
    "\f": "\\f",
    "\r": "\\r",
    '"': '\\"',
    "\\": "\\\\",
  };
  let quoted = '"';
  for (const byte of bytes) {
    quoted += plain(byte)
      ? String.fromCharCode(byte)
      : (escapes[String.fromCharCode(byte)] ?? `\\${byte.toString(8).padStart(3, "0")}`);
  }
  return `${quoted}"`;
}

/** A `---`/`+++` line; git ends one whose name holds a space with a tab, as GNU diff does. */
export function fileLine(marker: string, name: string): string {
  return `${marker} ${name}${name.includes(" ") ? "\t" : ""}`;
}

export function modeType(mode: string): string {
  return mode.slice(0, MODE_TYPE_DIGITS);
}
