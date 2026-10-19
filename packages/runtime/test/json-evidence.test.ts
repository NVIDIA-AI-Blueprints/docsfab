// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  canonicalizeJsonEvidence,
  isJsonEvidence,
  JsonEvidenceError,
  parseJsonEvidence,
} from "../src/json-evidence.js";

describe("strict JSON evidence parsing", () => {
  it.each([
    ["unexpected-end", '{"private":"unfinished'],
    ["unexpected-token", '{"private":true,}'],
    ["invalid-escape", '{"private":"bad\\xescape"}'],
    ["unescaped-control", '{"private":"raw\nnewline"}'],
    ["unpaired-surrogate", '{"private":"\\ud800"}'],
  ])("reports content-free %s syntax detail", (detail, source) => {
    let failure: unknown;
    try {
      parseJsonEvidence(source);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "malformed-json", detail });
    expect(JSON.stringify(failure)).not.toContain("private");
    expect(String(failure)).toBe("JsonEvidenceError: JSON evidence rejected: malformed-json");
  });

  it("parses valid UTF-8 JSON without changing data", () => {
    const source = new TextEncoder().encode(
      '{"campaign":{"id":"campaign-1","sample":5},"runs":[true,false,null,0.25,1e3]}',
    );

    expect(parseJsonEvidence(source)).toEqual({
      campaign: { id: "campaign-1", sample: 5 },
      runs: [true, false, null, 0.25, 1000],
    });
  });

  it.each([
    ['{"id":1,"id":2}', "duplicate-key"],
    ['{"outer":{"id":1,"id":2}}', "duplicate-key"],
    ['[{"id":1,"\\u0069d":2}]', "duplicate-key"],
  ])("rejects duplicate object keys at any depth", (source, code) => {
    expectErrorCode(source, code);
  });

  it.each([
    "",
    " ",
    "undefined",
    "{'id':1}",
    '{"id":1,}',
    '{"id" 1}',
    "[1,]",
    "[01]",
    '"unterminated',
    '"bad\\xescape"',
    '"\\ud800"',
    "\uFEFF{}",
  ])("rejects malformed JSON", (source) => {
    expectErrorCode(source, "malformed-json");
  });

  it("rejects malformed UTF-8 byte sequences", () => {
    expectErrorCode(new Uint8Array([0x7b, 0x22, 0xc3, 0x28, 0x22, 0x7d]), "invalid-utf8");
    expectErrorCode(new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d]), "malformed-json");
  });

  it.each([
    "9007199254740992",
    "-9007199254740992",
    "9007199254740992.0",
    "1e20",
    "1e400",
    "1e-400",
    "-0",
  ])("rejects lossy or non-finite numeric evidence: %s", (source) => {
    expectErrorCode(source, "unsafe-number");
  });

  it.each(["0", "-1", "9007199254740991", "0.1", "-12.75", "1e3", "1.25e-2"])(
    "accepts finite safe numeric evidence: %s",
    (source) => {
      expect(parseJsonEvidence(source)).toBeTypeOf("number");
    },
  );

  it("produces recursively sorted pretty canonical JSON", () => {
    const value = parseJsonEvidence('{"z":0,"a":{"y":2,"x":1},"list":[{"b":2,"a":1}]}');

    expect(canonicalizeJsonEvidence(value)).toBe(`{
  "a": {
    "x": 1,
    "y": 2
  },
  "list": [
    {
      "a": 1,
      "b": 2
    }
  ],
  "z": 0
}
`);
  });

  it("can require byte-identical canonical serialization", () => {
    const canonical = '{\n  "a": 1,\n  "b": 2\n}\n';

    expect(parseJsonEvidence(canonical, { requireCanonical: true })).toEqual({ a: 1, b: 2 });
    expectErrorCode('{"a":1,"b":2}', "noncanonical-json", { requireCanonical: true });
    expectErrorCode('{\n  "b": 2,\n  "a": 1\n}\n', "noncanonical-json", {
      requireCanonical: true,
    });
  });

  it("provides a boolean API and content-free errors", () => {
    const sentinel = "PRIVATE_PATH_AND_TOKEN_SENTINEL";
    let caught: unknown;
    try {
      parseJsonEvidence(`{"${sentinel}":1,"${sentinel}":2}`);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(JsonEvidenceError);
    expect(String(caught)).toBe("JsonEvidenceError: JSON evidence rejected: duplicate-key");
    expect(String(caught)).not.toContain(sentinel);
    expect(isJsonEvidence('{"safe":true}')).toBe(true);
    expect(isJsonEvidence('{"safe":true,"safe":false}')).toBe(false);
  });

  it("treats __proto__ as ordinary evidence data", () => {
    const value = parseJsonEvidence('{"__proto__":{"polluted":true}}') as Record<string, unknown>;

    expect(Object.hasOwn(value, "__proto__")).toBe(true);
    expect(Object.getOwnPropertyDescriptor(value, "__proto__")?.value).toEqual({ polluted: true });
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });
});

function expectErrorCode(
  source: string | Uint8Array,
  code: string,
  options: { requireCanonical?: boolean } = {},
): void {
  let caught: unknown;
  try {
    parseJsonEvidence(source, options);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(JsonEvidenceError);
  expect((caught as JsonEvidenceError).code).toBe(code);
}
