// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { containsConfiguredCredentialInBytes } from "../src/security/configured-credentials.js";
import { configureCredential } from "./helpers/configured-credential.js";
import { plantedCredentialValue } from "./helpers/planted-credential.js";

/** UTF-16 big-endian bytes of `text`. */
const utf16be = (text: string) => Buffer.from(text, "utf16le").swap16();
/** `bytes` one byte later, as text embedded at an odd offset in a binary file. */
const atOddOffset = (bytes: Buffer) => Buffer.concat([Buffer.from([7]), bytes]);

// A value with a character outside Latin-1 in every piece the registry
// matches. For ASCII text, UTF-16 of one byte order at one alignment reads as
// the other byte order a byte later, so a value with a long ASCII run is found
// by either reading. This one shows that each reading is needed (#1807).
const planted = (seed: number) =>
  [...plantedCredentialValue(seed, 20)]
    .map((character, index) => (index % 4 === 3 ? `${character}€` : character))
    .join("");

describe("configured credentials in bytes (#1807)", () => {
  it.each([
    ["UTF-8", (text: string) => Buffer.from(text)],
    ["UTF-16LE at an even offset", (text: string) => Buffer.from(text, "utf16le")],
    ["UTF-16LE at an odd offset", (text: string) => atOddOffset(Buffer.from(text, "utf16le"))],
    ["UTF-16BE at an even offset", (text: string) => utf16be(text)],
    ["UTF-16BE at an odd offset", (text: string) => atOddOffset(utf16be(text))],
  ] as const)(
    "finds a configured value stored as %s, and not an unconfigured one",
    (_label, encode) => {
      const configured = configureCredential(planted(1501));
      const unconfigured = planted(1502);
      expect(containsConfiguredCredentialInBytes(encode(`note ${configured}\n`))).toBe(true);
      expect(containsConfiguredCredentialInBytes(encode(`note ${unconfigured}\n`))).toBe(false);
    },
  );

  it("finds nothing in empty or single-byte input", () => {
    configureCredential(planted(1503));
    expect(containsConfiguredCredentialInBytes(Buffer.alloc(0))).toBe(false);
    expect(containsConfiguredCredentialInBytes(Buffer.from([0]))).toBe(false);
  });
});
