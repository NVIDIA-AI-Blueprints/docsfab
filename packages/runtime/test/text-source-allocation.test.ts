// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { textSourceExtractorAdapter } from "../src/inputs/adapters/structured.js";
import type { SourceLimitOverflowV1 } from "../src/inputs/source-evidence.js";
import {
  DEFAULT_SOURCE_EXTRACTION_LIMITS,
  extractSourceRepresentation,
  sourceSegmentSpanCount,
  SourceExtractionError,
  type SourceExtractionLimitsV1,
  type SourceExtractionSegmentV1,
} from "../src/inputs/source-extraction.js";

const bytes = new Uint8Array(Buffer.from("\uFEFFα\r\n\r\nβeta\rtail\nz"));
const fullSegments: SourceExtractionSegmentV1[] = [
  { text: "α", locator: { kind: "text", startByte: 3, endByte: 5 } },
  { text: "βeta", locator: { kind: "text", startByte: 9, endByte: 14 } },
  { text: "tail", locator: { kind: "text", startByte: 15, endByte: 19 } },
  { text: "z", locator: { kind: "text", startByte: 20, endByte: 21 } },
];
// A hand-authored fixture keeps the original host admission and identity rules
// as an oracle without materializing unbounded input in the text adapter.
const eagerFixtureAdapter = {
  ...textSourceExtractorAdapter,
  extract: () => ({ segments: fullSegments, limitations: [] }),
};

const spanOverflow: SourceLimitOverflowV1 = {
  limitation: "span-budget-truncated",
  limitName: "sources.extractionMaxSpans",
  observed: 5,
};
const byteOverflow: SourceLimitOverflowV1 = {
  limitation: "byte-budget-truncated",
  limitName: "sources.extractionMaxDerivativeBytes",
  observed: 15,
};

const cases: Array<{
  name: string;
  limits: Partial<SourceExtractionLimitsV1>;
  derivative: string;
  kept: number;
  overflow?: SourceLimitOverflowV1;
}> = [
  { name: "exact span boundary", limits: { maxSpans: 5 }, derivative: "α\nβeta\ntail\nz", kept: 4 },
  {
    name: "one span over",
    limits: { maxSpans: 4 },
    derivative: "α\nβeta\ntail",
    kept: 3,
    overflow: spanOverflow,
  },
  {
    name: "exact byte boundary",
    limits: { maxDerivativeBytes: 15 },
    derivative: "α\nβeta\ntail\nz",
    kept: 4,
  },
  {
    name: "one byte over",
    limits: { maxDerivativeBytes: 14 },
    derivative: "α\nβeta\ntail",
    kept: 3,
    overflow: byteOverflow,
  },
  {
    name: "split line fits exactly",
    limits: { maxSpans: 3 },
    derivative: "α\nβeta",
    kept: 2,
    overflow: spanOverflow,
  },
  {
    name: "split line and later small lines stay excluded",
    limits: { maxSpans: 2 },
    derivative: "α",
    kept: 1,
    overflow: spanOverflow,
  },
  {
    name: "span wins when both first overflow",
    limits: { maxSpans: 1, maxDerivativeBytes: 2 },
    derivative: "α",
    kept: 1,
    overflow: spanOverflow,
  },
  {
    name: "earlier byte overflow wins over later span overflow",
    limits: { maxSpans: 3, maxDerivativeBytes: 3 },
    derivative: "α",
    kept: 1,
    overflow: byteOverflow,
  },
];

describe("bounded text source materialization", () => {
  it.each(cases)(
    "preserves evidence identity at $name",
    async ({ limits, derivative, kept, overflow }) => {
      const effective = { maxSpanBytes: 4, ...limits };
      const actual = await extractSourceRepresentation({
        adapter: textSourceExtractorAdapter,
        bytes,
        mediaType: "text/plain",
        limits: effective,
      });
      const originalHostResult = await extractSourceRepresentation({
        adapter: eagerFixtureAdapter,
        bytes,
        mediaType: "text/plain",
        limits: effective,
      });
      expect(actual).toEqual(originalHostResult);
      expect(Buffer.from(actual.derivative).toString("utf8")).toBe(derivative);
      expect(actual.originalSha256).toBe(createHash("sha256").update(bytes).digest("hex"));
      expect(actual.representation.completeness).toBe(overflow ? "partial" : "complete");
      expect(actual.representation.overflows ?? []).toEqual(overflow ? [overflow] : []);
      for (const span of actual.representation.spans) {
        if (span.locator.kind !== "text") throw new Error("Expected text locator.");
        expect(bytes.subarray(span.locator.startByte, span.locator.endByte)).toEqual(
          actual.derivative.subarray(span.startByte, span.endByte),
        );
      }

      const materialized = await textSourceExtractorAdapter.extract({
        bytes,
        options: textSourceExtractorAdapter.defaultOptions,
        limits: { ...DEFAULT_SOURCE_EXTRACTION_LIMITS, ...effective },
      });
      expect(materialized.segments).toEqual(fullSegments.slice(0, kept));
      expect(materialized.limitations).toEqual(overflow ? [overflow.limitation] : []);
      expect(materialized.overflows ?? []).toEqual(overflow ? [overflow] : []);
    },
  );

  it.each([
    {
      limits: { maxSpans: 1 },
      limitation: "span-budget-truncated",
      limitName: "sources.extractionMaxSpans",
      observed: 3,
    },
    {
      limits: { maxDerivativeBytes: 5 },
      limitation: "byte-budget-truncated",
      limitName: "sources.extractionMaxDerivativeBytes",
      observed: 8,
    },
  ] as const)(
    "refuses an overflowing first line without retaining a later line: $limitation",
    async ({ limits, ...overflow }) => {
      const original = new Uint8Array(Buffer.from("αβγ\nx"));
      const effective = { ...DEFAULT_SOURCE_EXTRACTION_LIMITS, maxSpanBytes: 4, ...limits };
      const materialized = await textSourceExtractorAdapter.extract({
        bytes: original,
        options: textSourceExtractorAdapter.defaultOptions,
        limits: effective,
      });
      expect(materialized.segments).toEqual([]);
      expect(materialized.limitations).toEqual([overflow.limitation]);
      expect(materialized.overflows).toEqual([overflow]);
      await expect(
        extractSourceRepresentation({
          adapter: textSourceExtractorAdapter,
          bytes: original,
          mediaType: "text/plain",
          limits: effective,
        }),
      ).rejects.toThrowError(new SourceExtractionError("empty-extraction"));
    },
  );

  it("validates an invalid UTF-8 suffix even when the prefix fills the span budget", async () => {
    const original = new Uint8Array([...Buffer.from("ok\n"), 0xff]);
    await expect(
      extractSourceRepresentation({
        adapter: textSourceExtractorAdapter,
        bytes: original,
        mediaType: "text/plain",
        limits: { maxSpans: 1 },
      }),
    ).rejects.toThrowError(new SourceExtractionError("adapter-failed"));
  });

  it.each([
    { text: "", maxBytes: 4, spans: 1 },
    { text: "abcd", maxBytes: 4, spans: 1 },
    { text: "abcde", maxBytes: 4, spans: 2 },
    { text: "a😀b", maxBytes: 4, spans: 3 },
    { text: "αβγδ", maxBytes: 5, spans: 2 },
  ])(
    "counts UTF-8 pieces without rounding through a code point: $text",
    ({ text, maxBytes, spans }) => {
      expect(sourceSegmentSpanCount(text, maxBytes)).toBe(spans);
    },
  );
});
