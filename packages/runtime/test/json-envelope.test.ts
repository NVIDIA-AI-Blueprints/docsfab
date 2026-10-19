// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { isAmbiguousJsonEnvelope, jsonEnvelopeBody } from "../src/execution/json-envelope.js";
import { parseJsonEvidence } from "../src/json-evidence.js";

const DOCUMENT = '{"completeness":"bounded-not-proven","dimensions":[]}';

/** What the strict parser makes of the span this module chose. */
function decoded(response: string): unknown {
  return parseJsonEvidence(jsonEnvelopeBody(response));
}

describe("model reply JSON envelope (#1046)", () => {
  it("returns a raw JSON reply byte-for-byte, so an already-conforming reply is untouched", () => {
    expect(jsonEnvelopeBody(DOCUMENT)).toBe(DOCUMENT);
    // Leading and trailing whitespace is not an envelope; trimming keeps the
    // same document.
    expect(jsonEnvelopeBody(`\n  ${DOCUMENT}\n\n`)).toBe(DOCUMENT);
  });

  it.each([
    ["a json-tagged backtick fence", "```json\n" + DOCUMENT + "\n```"],
    ["an untagged backtick fence", "```\n" + DOCUMENT + "\n```"],
    ["a tilde fence", "~~~json\n" + DOCUMENT + "\n~~~"],
    ["a longer fence run", "````json\n" + DOCUMENT + "\n````"],
    ["an indented fence", "  ```json\n" + DOCUMENT + "\n  ```"],
    ["prose before the fence", "Here is the ledger:\n\n```json\n" + DOCUMENT + "\n```"],
    [
      "prose on both sides of the fence",
      "Here is the ledger:\n\n```json\n" + DOCUMENT + "\n```\n\nLet me know if you need more.",
    ],
    ["prose before a bare object", "Here is the ledger:\n\n" + DOCUMENT],
    ["prose after a bare object", DOCUMENT + "\n\nThat is the whole ledger."],
  ])("unwraps %s", (_label, response) => {
    expect(jsonEnvelopeBody(response)).toBe(DOCUMENT);
    expect(decoded(response)).toEqual(JSON.parse(DOCUMENT));
  });

  describe("ambiguity is refused, never guessed", () => {
    // Each case comes back unchanged: the caller re-parses the original reply,
    // so the operator reads the strict parser's own coded refusal.
    it.each([
      [
        "two fenced documents that both parse",
        "```json\n" + DOCUMENT + '\n```\nor maybe\n```json\n{"completeness":"x"}\n```',
      ],
      ["a reply with no object at all", "I could not produce the ledger."],
      ["an empty reply", ""],
    ])("leaves %s unchanged", (_label, response) => {
      expect(jsonEnvelopeBody(response)).toBe(response);
      expect(() => parseJsonEvidence(jsonEnvelopeBody(response))).toThrow();
    });

    it("hands over the body of a single broken fence, so the code names the document", () => {
      // One fence is unambiguous even when its body is broken, so the parser
      // judges the body.
      expect(jsonEnvelopeBody("```json\n{oops}\n```")).toBe("{oops}");
      expect(() => decoded("```json\n{oops}\n```")).toThrow(/malformed-json/u);
      // A duplicate key inside one fence reads as `duplicate-key`, not
      // `malformed-json` for the fence.
      expect(() => decoded('```json\n{"dimensions":[],"dimensions":[]}\n```')).toThrow(
        /duplicate-key/u,
      );
    });

    it("opens an unterminated fence around a complete document", () => {
      // An unclosed fence still carries one complete document, which the brace
      // span finds. A reply truncated inside the document is refused by the
      // parser; the truncation repair hint depends on that distinction.
      expect(jsonEnvelopeBody("```json\n" + DOCUMENT)).toBe(DOCUMENT);
      expect(() => decoded('```json\n{"completeness":"bounded-not-prov')).toThrow(
        /malformed-json/u,
      );
    });

    it("takes the one fenced document that parses when the other fence is prose", () => {
      // Two fences, but only one is a candidate, so there is no ambiguity.
      const response = "```text\nnot json at all\n```\n```json\n" + DOCUMENT + "\n```";
      expect(jsonEnvelopeBody(response)).toBe(DOCUMENT);
    });

    it("never takes a valid illustration when the json answer is malformed", () => {
      const response = '```text\n{"example":true}\n```\n```json\n{oops}\n```';
      expect(jsonEnvelopeBody(response)).toBe("{oops}");
      expect(isAmbiguousJsonEnvelope(response)).toBe(false);
      expect(() => decoded(response)).toThrow(/malformed-json/u);
    });

    it("preserves a duplicate-key refusal after a valid text illustration", () => {
      const response =
        '```text\n{"example":true}\n```\n```json\n{"dimensions":[],"dimensions":[]}\n```';
      expect(jsonEnvelopeBody(response)).toBe('{"dimensions":[],"dimensions":[]}');
      expect(() => decoded(response)).toThrow(/duplicate-key/u);
    });

    it("refuses two eligible fences even when only one parses", () => {
      const response = '```json\n{"example":true}\n```\n```json\n{oops}\n```';
      expect(jsonEnvelopeBody(response)).toBe(response);
      expect(isAmbiguousJsonEnvelope(response)).toBe(true);
      expect(() => decoded(response)).toThrow(/malformed-json/u);
    });

    it("leaves multiple non-json fences untouched even if their bodies parse", () => {
      const response = `\`\`\`text\n${DOCUMENT}\n\`\`\`\n~~~javascript\n{"example":true}\n~~~`;
      expect(jsonEnvelopeBody(response)).toBe(response);
      expect(isAmbiguousJsonEnvelope(response)).toBe(false);
      expect(() => decoded(response)).toThrow(/malformed-json/u);
    });

    it("treats untagged and case-normalized json fences as eligible", () => {
      const broken = "{oops}";
      const one = `\`\`\`text\n${DOCUMENT}\n\`\`\`\n\`\`\`  JsOn  example\n${broken}\n\`\`\``;
      expect(jsonEnvelopeBody(one)).toBe(broken);
      const two = `${one}\n~~~   \n${DOCUMENT}\n~~~`;
      expect(jsonEnvelopeBody(two)).toBe(two);
      expect(isAmbiguousJsonEnvelope(two)).toBe(true);
    });

    it("does not reduce a two-object reply to whichever object came first", () => {
      // A reply whose first `{` and last `}` do not bracket one document must
      // not become the first object.
      const response = `${DOCUMENT}\nand also\n{"completeness":"other","dimensions":[]}`;
      expect(jsonEnvelopeBody(response)).not.toBe(DOCUMENT);
      expect(() => decoded(response)).toThrow(/malformed-json/u);
    });
  });

  it("does not mistake a fence quoted INSIDE a document for the document", () => {
    // A fence opener is a whole line, and strict JSON forbids a raw newline
    // inside a string, so a fence a document quotes is escaped and cannot
    // present itself as an envelope.
    const quoting = JSON.stringify({
      completeness: "bounded-not-proven",
      dimensions: [],
      note: "Return one object, not ```json\n{}\n```.",
    });
    expect(jsonEnvelopeBody(quoting)).toBe(quoting);
    expect(decoded(quoting)).toEqual(JSON.parse(quoting));

    // With trailing prose the brace span is taken, and it still returns the
    // document, not the `{}` the document mentions.
    const trailing = `${quoting}\n\nLet me know if you need more.`;
    expect(jsonEnvelopeBody(trailing)).toBe(quoting);
    expect(decoded(trailing)).toEqual(JSON.parse(quoting));
  });

  it("refuses a reply whose prose itself contains braces", () => {
    // The span runs from the first `{` to the last `}`, so prose braces before
    // the document break the span and the reply is refused rather than guessed.
    const response = `The shape is {key: value}. Here it is:\n${DOCUMENT}`;
    expect(() => decoded(response)).toThrow(/malformed-json/u);
    // The same prose inside a fence is unambiguous and is unwrapped.
    const fenced = `The shape is {key: value}. Here it is:\n\n\`\`\`json\n${DOCUMENT}\n\`\`\``;
    expect(jsonEnvelopeBody(fenced)).toBe(DOCUMENT);
  });

  describe("names the one wrapping it refuses as ambiguous (#1426)", () => {
    const fenced = "```json\n" + DOCUMENT + "\n```";
    it.each([
      ["two fenced documents that both parse", `${fenced}\nor\n${fenced}`, true],
      ["three fenced documents that parse", `${fenced}\n${fenced}\n${fenced}`, true],
      // Every other reply is admitted, or refused as not JSON.
      ["one fenced document", fenced, false],
      ["one fenced document beside a prose fence", "```text\nnot json\n```\n" + fenced, false],
      ["two fences of which one parses", "```json\n{oops}\n```\n" + fenced, true],
      ["one fence around a broken document", "```json\n{oops}\n```", false],
      ["two bare documents", `${DOCUMENT}\n${DOCUMENT}`, false],
      ["the bare document", DOCUMENT, false],
      ["prose alone", "I could not produce the ledger.", false],
      ["an empty reply", "", false],
    ])("%s", (_label, response, ambiguous) => {
      expect(isAmbiguousJsonEnvelope(response)).toBe(ambiguous);
      // Ambiguous means the policy handed the reply back untouched although a
      // fence held a document.
      if (ambiguous) expect(jsonEnvelopeBody(response)).toBe(response);
    });
  });
});
