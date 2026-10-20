// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { recoverJudgmentPrefix } from "../src/harness/cut-judgment.js";
import { parseJsonEvidence } from "../src/json-evidence.js";

/**
 * The bounded prefix scanner that recovers the complete elements of a judgment
 * answer cut at the output limit. Every case also asserts the scanner's
 * contract: the kept text is a prefix of the bounded input followed by closing
 * brackets only, and the value is the strict parse of exactly that text.
 */
describe("recoverJudgmentPrefix", () => {
  const coverageEntry = (path: string) => ({
    path,
    status: "verified",
    evidence: ["src/cli.ts:42"],
    reason: "Compared the documented flag with the option parser.",
  });
  const row = (obligationId: string, reason = "The parser defines the flag.") => ({
    obligationId,
    disposition: "retained",
    documentationDisposition: "documented",
    reason,
  });
  const answer = JSON.stringify({
    verdict: "needs-revision",
    coverage: [coverageEntry("docs/a.md"), coverageEntry("docs/b.md")],
    issueJudgments: [
      {
        id: "TECH-001",
        severity: "major",
        category: "technical_accuracy",
        location: "docs/a.md:3",
        obligationIds: ["OBL-A-1"],
      },
    ],
    obligationJudgments: [row("OBL-A-1"), row("OBL-A-2"), row("OBL-A-3")],
  });

  /** Cut `answer` just after the first occurrence of `marker`, plus `offset`. */
  function cutAfter(marker: string, offset = 0): string {
    const index = answer.indexOf(marker);
    expect(index, `marker ${marker} not in the fixture`).toBeGreaterThanOrEqual(0);
    return answer.slice(0, index + marker.length + offset);
  }

  function recover(text: string, maxBytes?: number) {
    const recovered = recoverJudgmentPrefix(text, maxBytes);
    // The kept text is a prefix of the input plus closers, and nothing else.
    expect(recovered.closers).toMatch(/^[\]}]*$/u);
    expect(recovered.end).toBeLessThanOrEqual(text.length);
    if (recovered.value !== undefined) {
      expect(
        parseJsonEvidence(text.slice(recovered.start, recovered.end) + recovered.closers),
      ).toEqual(recovered.value);
    }
    return recovered;
  }

  function counts(value: Record<string, unknown> | undefined) {
    const length = (key: string) =>
      Array.isArray(value?.[key]) ? (value![key] as unknown[]).length : undefined;
    return {
      coverage: length("coverage"),
      issueJudgments: length("issueJudgments"),
      obligationJudgments: length("obligationJudgments"),
      verdict: value?.verdict,
    };
  }

  it("keeps the complete rows before a cut inside a string", () => {
    const { value } = recover(cutAfter('{"obligationId":"OBL-A-3","disposition":"ret'));
    expect(counts(value)).toEqual({
      coverage: 2,
      issueJudgments: 1,
      obligationJudgments: 2,
      verdict: "needs-revision",
    });
  });

  it("keeps every complete row when the cut falls right after a comma", () => {
    const afterFirst = recover(answer.slice(0, answer.indexOf(',{"obligationId":"OBL-A-2"') + 1));
    expect(counts(afterFirst.value).obligationJudgments).toBe(1);
    expect(afterFirst.closers).toBe("]}");
    const afterSecond = recover(answer.slice(0, answer.indexOf(',{"obligationId":"OBL-A-3"') + 1));
    expect(counts(afterSecond.value).obligationJudgments).toBe(2);
  });

  it("drops a row cut inside a nested object and keeps the ones before it", () => {
    const nested = JSON.stringify({
      verdict: "needs-revision",
      obligationJudgments: [
        row("OBL-A-1"),
        {
          obligationId: "OBL-A-2",
          disposition: "refined",
          replacements: [
            { statement: "The flag is optional.", documentationDisposition: "omitted" },
          ],
        },
      ],
    });
    const cut = nested.slice(0, nested.indexOf('"statement"') + 5);
    const { value } = recover(cut);
    expect(counts(value)).toEqual({
      coverage: undefined,
      issueJudgments: undefined,
      obligationJudgments: 1,
      verdict: "needs-revision",
    });
  });

  it("keeps the complete coverage entries before a cut inside coverage", () => {
    const { value } = recover(cutAfter('{"path":"docs/b.md","status":"verified","evid'));
    expect(counts(value)).toEqual({
      coverage: 1,
      issueJudgments: undefined,
      obligationJudgments: undefined,
      verdict: "needs-revision",
    });
  });

  it("keeps every earlier member when the cut falls before obligationJudgments starts", () => {
    const { value } = recover(cutAfter('"obligationJudgments"'));
    expect(counts(value)).toEqual({
      coverage: 2,
      issueJudgments: 1,
      obligationJudgments: undefined,
      verdict: "needs-revision",
    });
  });

  it("keeps the rows before a cut on an escape, whether a quote or a unicode escape", () => {
    const escaped = JSON.stringify({
      obligationJudgments: [
        row("OBL-A-1", 'Says "one".'),
        row("OBL-A-2", 'Says \u00e9 and "two".'),
      ],
    });
    // The first escape of row 2's reason, cut right after its backslash.
    const quoteEscape = escaped.slice(0, escaped.lastIndexOf('\\"') + 1);
    expect(counts(recover(quoteEscape).value).obligationJudgments).toBe(1);
    const unicode = JSON.stringify({
      obligationJudgments: [row("OBL-A-1"), row("OBL-A-2", "\u0001")],
    });
    const unicodeEscape = unicode.slice(0, unicode.lastIndexOf("\\u") + 4);
    expect(counts(recover(unicodeEscape).value).obligationJudgments).toBe(1);
  });

  it("stops at a restarted answer and keeps only what came before the junction", () => {
    // The in-turn nudge can make the model start the answer again: the host
    // then holds half of one object followed by the beginning of another.
    const stitched = cutAfter('{"obligationId":"OBL-A-2"') + answer;
    const { value } = recover(stitched);
    expect(counts(value)).toEqual({
      coverage: 2,
      issueJudgments: 1,
      obligationJudgments: 1,
      verdict: "needs-revision",
    });
  });

  it("recovers nothing from text that begins no object, and an empty object from a cut first member", () => {
    expect(recover("The judgment is: needs revision because").value).toBeUndefined();
    expect(recover('{"verdict":"needs-rev').value).toEqual({});
  });

  it("reads through an opening Markdown fence, whose closing fence a cut never delivers", () => {
    const { value } = recover(`\`\`\`json\n${cutAfter('{"obligationId":"OBL-A-3"')}`);
    expect(counts(value).obligationJudgments).toBe(2);
  });

  it("keeps a whole object and ignores the text after its closing brace", () => {
    const { value, closers } = recover(`${answer}{"verdict":"pass"`);
    expect(closers).toBe("");
    expect(value).toEqual(JSON.parse(answer));
  });

  it("never reads past the response byte ceiling it is given", () => {
    // Two complete rows fit under the ceiling; the third row and everything
    // after it lie past it and are never scanned, though they are complete.
    const ceiling = Buffer.byteLength(cutAfter('{"obligationId":"OBL-A-3"'), "utf8");
    const bounded = recover(answer, ceiling);
    expect(counts(bounded.value).obligationJudgments).toBe(2);
    expect(bounded.end).toBeLessThanOrEqual(ceiling);
    // At the whole answer's own size, all three rows survive.
    expect(
      counts(recover(answer, Buffer.byteLength(answer, "utf8")).value).obligationJudgments,
    ).toBe(3);
  });

  it("measures the ceiling in UTF-8 bytes, not characters", () => {
    // Row 1 carries eight two-byte characters: at exactly its byte length it is
    // kept, one byte fewer it is not. A character-counted ceiling keeps both.
    const wide = JSON.stringify({
      obligationJudgments: [row("OBL-A-1", "é".repeat(8)), row("OBL-A-2")],
    });
    const throughFirst = wide.slice(0, wide.indexOf(',{"obligationId":"OBL-A-2"'));
    const bytes = Buffer.byteLength(throughFirst, "utf8");
    expect(bytes).toBe(throughFirst.length + 8);
    expect(counts(recover(wide, bytes).value).obligationJudgments).toBe(1);
    expect(counts(recover(wide, bytes - 1).value).obligationJudgments).toBeUndefined();
  });
});
