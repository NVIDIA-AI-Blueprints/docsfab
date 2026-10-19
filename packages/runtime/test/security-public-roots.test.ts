// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { delimiter } from "node:path";

import { describe, expect, it } from "vitest";

import {
  declaredPublicRoots,
  PublicRootsOperatorError,
  publicRootPredicate,
} from "../src/security/public-roots.js";

function declared(value: string | undefined) {
  return declaredPublicRoots({ DOCSFAB_PUBLIC_ROOTS: value });
}

describe("declaredPublicRoots", () => {
  it("is empty when the variable is unset or empty", () => {
    expect([...declared(undefined)]).toEqual([]);
    expect([...declared("")]).toEqual([]);
    expect([...declaredPublicRoots({})]).toEqual([]);
  });

  it("parses delimiter-separated absolute roots", () => {
    const roots = declared(["/workspace", "/home/node", "/var/lib/docsfab"].join(delimiter));
    expect([...roots]).toEqual(["/workspace", "/home/node", "/var/lib/docsfab"]);
  });

  it.each([
    ["an empty entry", ["/workspace", ""], 1],
    ["a relative entry", ["docs"], 0],
    ["the filesystem root", ["/workspace", "/"], 1],
    ["an unnormalized entry", ["/home/node/../x"], 0],
    ["a trailing separator", ["/home/node/"], 0],
    ["a trailing space", ["/workspace", "/home/node "], 1],
    ["a trailing newline", ["/workspace\n"], 0],
    ["a trailing tab", ["/workspace\t"], 0],
  ])("refuses %s with its index and without its value", (_label, entries, index) => {
    const value = entries.join(delimiter);
    let caught: unknown;
    try {
      declared(value);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PublicRootsOperatorError);
    const error = caught as PublicRootsOperatorError;
    expect(error.code).toBe("public-roots-invalid");
    expect(error.index).toBe(index);
    const bad = entries[index] ?? "";
    if (bad.length > 1) expect(error.message).not.toContain(bad);
  });
});

describe("publicRootPredicate", () => {
  it("matches declared roots exactly", () => {
    const isPublic = publicRootPredicate(new Set(["/home/node"]));
    expect(isPublic("/home/node")).toBe(true);
    expect(isPublic("/home/nodejs")).toBe(false);
    expect(isPublic("/home")).toBe(false);
    expect(isPublic("/home/node/x")).toBe(false);
  });
});
