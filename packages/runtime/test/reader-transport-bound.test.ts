// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, it } from "vitest";
import { parseHostRuntimeSemanticClaimCoreData } from "../src/host-invoker/semantic-comparison.js";
import {
  assertInertTransportData,
  INERT_TRANSPORT_MAX_STRING_CHARS,
  projectInertTransportRecord,
} from "../src/reader-task-transport.js";

const fail = (code: string): never => {
  throw new Error(code);
};

it("exposes the strict transport string ceiling in UTF-16 units for chunk producers", () => {
  expect(INERT_TRANSPORT_MAX_STRING_CHARS).toBe(65_536);
  const content = "😀".repeat(INERT_TRANSPORT_MAX_STRING_CHARS / 2);
  expect(Buffer.byteLength(content)).toBeGreaterThan(INERT_TRANSPORT_MAX_STRING_CHARS);
  expect(() => assertInertTransportData({ content }, fail)).not.toThrow();
  expect(() => assertInertTransportData({ content: `${content}x` }, fail)).toThrow("invalid-value");
});

it("projects large inert records without imposing the strict request string bound", () => {
  const shared = { content: "x".repeat(INERT_TRANSPORT_MAX_STRING_CHARS + 1) };
  expect(
    projectInertTransportRecord({ first: shared, second: shared, optional: undefined }, fail),
  ).toEqual({ first: shared, second: shared });
  expect(() => assertInertTransportData({ shared }, fail)).toThrow("invalid-value");
});

it("refuses executable projection data before invoking getters, proxies or toJSON", () => {
  let reads = 0;
  for (const input of [
    {
      get length() {
        reads++;
        return 1;
      },
    },
    {
      nested: {
        get content() {
          reads++;
          return "value";
        },
      },
    },
    {
      nested: new Proxy(
        {},
        {
          getPrototypeOf() {
            reads++;
            return Object.prototype;
          },
        },
      ),
    },
    {
      toJSON() {
        reads++;
        return {};
      },
    },
  ]) {
    expect(() => projectInertTransportRecord(input, fail)).toThrow();
    expect(reads).toBe(0);
  }
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  expect(() => projectInertTransportRecord(cycle, fail)).toThrow();
});

it("inspects ordinary length properties before claim parsing without reading accessors", () => {
  let reads = 0;
  const claim = {
    claim_id: "CLAIM",
    statement: "Ordinary intent.",
    scope: {
      get length() {
        reads++;
        throw new Error("executed accessor");
      },
    },
  };
  expect(() => parseHostRuntimeSemanticClaimCoreData(claim)).toThrow("invalid-shape");
  expect(reads).toBe(0);
  expect(
    parseHostRuntimeSemanticClaimCoreData({
      ...claim,
      scope: { length: "ordinary data" },
    }).scope,
  ).toEqual({ length: "ordinary data" });
  expect(() => assertInertTransportData(["ordinary array"], fail)).not.toThrow();
  expect(() =>
    assertInertTransportData(
      {
        length: "x".repeat(INERT_TRANSPORT_MAX_STRING_CHARS + 1),
      },
      fail,
    ),
  ).toThrow("invalid-value");
});
