// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Quote grounding (R1): what a model may change when it copies the operator's
 * words, what it may not, and parity with the knowledge first pass's
 * instruction-quote binding that this port follows.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { groundQuote, type RequestIntentAdmissionResult } from "../src/request-intent/index.js";
import {
  CREATE_HOST,
  CREATE_INSTRUCTION,
  createProposal,
  edited,
  interpret,
  type Proposal,
  REVIEW_HOST,
} from "./helpers/request-intent-fixture.js";

const NBSP = " ";
const ZWSP = "​";
const CAFE_NFC = "café";
const CAFE_NFD = "café";

/** [name, instruction, model quote, the operator text the quote must bind] */
const GROUNDED: readonly (readonly [string, string, string, string])[] = [
  ["an exact copy", "Keep the stable anchor.", "Keep the stable anchor", "Keep the stable anchor"],
  [
    "straight quotes for curly ones",
    "Keep the “stable anchor” section.",
    'Keep the "stable anchor" section',
    "Keep the “stable anchor” section",
  ],
  [
    "a hyphen for an en dash and an em dash",
    "Use the 30–60 s range — not 90.",
    "Use the 30-60 s range - not 90",
    "Use the 30–60 s range — not 90",
  ],
  [
    "a space for NBSP",
    `Keep${NBSP}the anchor intact.`,
    "Keep the anchor intact",
    `Keep${NBSP}the anchor intact`,
  ],
  [
    "one space for CRLF",
    "Keep the\r\nanchor intact.",
    "Keep the anchor intact",
    "Keep the\r\nanchor intact",
  ],
  [
    "changed letter case",
    "Keep the Anchor intact.",
    "KEEP THE ANCHOR INTACT",
    "Keep the Anchor intact",
  ],
  [
    "a trailing period",
    "Keep the anchor intact, please.",
    "Keep the anchor intact.",
    "Keep the anchor intact",
  ],
  [
    "surrounding quotation marks",
    "Keep the anchor intact.",
    '"Keep the anchor intact"',
    "Keep the anchor intact",
  ],
];

/** [name, instruction, model quote] that must not ground. */
const UNGROUNDED: readonly (readonly [string, string, string])[] = [
  ["absent words", "Keep the anchor intact.", "Delete the anchor"],
  ["whitespace only", "Keep the anchor intact.", "   "],
  ["no letter or digit", "Keep the anchor -- intact.", "--"],
  ["an empty quote", "Keep the anchor intact.", ""],
  // Known non-folds, kept for parity with the knowledge first pass.
  ["three dots for an ellipsis", "Wait… then retry the request.", "Wait... then retry"],
  ["a zero-width space dropped", `Run the configure${ZWSP}command first.`, "configurecommand"],
  // `İ` lower-cases to two units; a quote that starts on the second unit
  // must not widen to the whole letter.
  ["a quote starting inside a multi-unit fold", "Visit İzmir today.", "\u0307zmir today"],
];

/** A review that names no page and preserves one quote: only grounding can refuse it. */
function preserving(quote: string): Proposal {
  return edited(createProposal(), (p) => {
    p.operation = "review";
    p.targets = [];
    p.sources = [];
    p.constraints = [];
    p.authorityPreference = { preference: "unspecified", quote: null };
    p.preserve = [{ quote }];
  });
}

function sealedPreserve(result: RequestIntentAdmissionResult) {
  expect(result.outcome).toBe("admitted");
  if (result.outcome !== "admitted") throw new Error("Expected the quote to be admitted.");
  return result.intent.preserve[0]!.quote;
}

describe("request-intent quote grounding", () => {
  it.each(GROUNDED)(
    "grounds %s and seals the operator's own text",
    (_name, instruction, quote, expected) => {
      const sealed = sealedPreserve(interpret(preserving(quote), instruction, REVIEW_HOST));
      expect(sealed.text).toBe(expected);
      expect(instruction.normalize("NFC").slice(sealed.start, sealed.end)).toBe(sealed.text);
    },
  );

  it.each(UNGROUNDED)("rejects %s as an ungrounded quote", (_name, instruction, quote) => {
    expect(groundQuote(instruction, quote)).toBeUndefined();
    expect(interpret(preserving(quote), instruction, REVIEW_HOST)).toMatchObject({
      outcome: "rejected",
      code: "request-intent-quote-ungrounded",
      location: "$.preserve[].quote",
      retry: "model-correctable",
    });
  });

  it("grounds an NFD quote in an NFC instruction and seals the NFC text", () => {
    const instruction = `Update the ${CAFE_NFC} page.`;
    const sealed = sealedPreserve(
      interpret(preserving(`${CAFE_NFD} page`), instruction, REVIEW_HOST),
    );
    expect(sealed).toEqual({ text: `${CAFE_NFC} page`, start: 11, end: 20 });
  });

  it("grounds an NFC quote in an NFD instruction, with offsets into the NFC instruction", () => {
    const instruction = `Update the ${CAFE_NFD} page.`;
    const sealed = sealedPreserve(
      interpret(preserving(`${CAFE_NFC} page`), instruction, REVIEW_HOST),
    );
    expect(sealed.text).toBe(`${CAFE_NFC} page`);
    expect(instruction.normalize("NFC").slice(sealed.start, sealed.end)).toBe(sealed.text);
    expect(instruction.slice(sealed.start, sealed.end)).not.toBe(sealed.text);
  });

  it("checks every quote-bearing field, reporting the first ungrounded one", () => {
    const fields: readonly [string, (p: Proposal) => void][] = [
      ["$.targets[].quote", (p) => void ((p.targets as Proposal[])[0]!.quote = "nowhere in it")],
      ["$.sources[].quote", (p) => void ((p.sources as Proposal[])[0]!.quote = "nowhere in it")],
      ["$.preserve[].quote", (p) => void (p.preserve = [{ quote: "nowhere in it" }])],
      [
        "$.exclusions[].quote",
        (p) => void (p.exclusions = [{ path: "docs/index.md", quote: "nowhere in it" }]),
      ],
      [
        "$.constraints[].quote",
        (p) => void ((p.constraints as Proposal[])[0]!.quote = "nowhere in it"),
      ],
      [
        "$.authorityPreference.quote",
        (p) =>
          void (p.authorityPreference = {
            preference: "documentation",
            quote: "nowhere in it",
          }),
      ],
    ];
    const instruction = CREATE_INSTRUCTION;
    for (const [location, edit] of fields) {
      expect(
        interpret(edited(createProposal(), edit), instruction, CREATE_HOST),
        location,
      ).toMatchObject({
        outcome: "rejected",
        code: "request-intent-quote-ungrounded",
        location,
      });
    }
  });
});

// Parity: the knowledge first pass binds instruction quotes with the same fold.
// It does not export the binder, so the test loads an unchanged copy of the
// module with one added export line; nothing in the runtime imports it.
const KNOWLEDGE_ASSESS = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../knowledge/src/first-pass/assess.mjs",
);
const temporary: string[] = [];

afterAll(async () => {
  await Promise.all(temporary.map((directory) => rm(directory, { recursive: true, force: true })));
});

type Binder = (instruction: string, quote: string) => { start: number; end: number } | undefined;

async function knowledgeBinder(): Promise<Binder> {
  const source = await readFile(KNOWLEDGE_ASSESS, "utf8");
  const sourceDirectory = dirname(KNOWLEDGE_ASSESS);
  const rebased = source.replace(
    /from "(\.\.?\/[^"]+)"/gu,
    (_, file: string) => `from ${JSON.stringify(pathToFileURL(join(sourceDirectory, file)).href)}`,
  );
  const directory = await mkdtemp(join(tmpdir(), "request-intent-quote-parity-"));
  temporary.push(directory);
  const file = join(directory, "first-pass-assess.mjs");
  await writeFile(file, `${rebased}\nexport { bindInstructionQuote as __bindInstructionQuote };\n`);
  const module = (await import(pathToFileURL(file).href)) as {
    __bindInstructionQuote: Binder;
  };
  return module.__bindInstructionQuote;
}

describe("request-intent quote grounding parity with the knowledge first pass", () => {
  it("binds the same span as the knowledge binder on every NFC row", async () => {
    const bind = await knowledgeBinder();
    const rows = [
      ...GROUNDED.map(([name, instruction, quote]) => [name, instruction, quote] as const),
      ...UNGROUNDED,
    ];
    for (const [name, instruction, quote] of rows) {
      expect(instruction.normalize("NFC"), name).toBe(instruction);
      expect(groundQuote(instruction, quote), name).toEqual(bind(instruction, quote));
    }
  });

  it("records the boundary divergence: the port refuses a sub-word span and tries later hits", async () => {
    const bind = await knowledgeBinder();
    // The knowledge binder takes the first hit, inside "address".
    expect(bind("Please address it, then add docs/x.md.", "add")).toEqual({ start: 7, end: 10 });
    expect(groundQuote("Please address it, then add docs/x.md.", "add")).toEqual({
      start: 24,
      end: 27,
    });
    expect(bind("Please address the page.", "add")).toEqual({ start: 7, end: 10 });
    expect(groundQuote("Please address the page.", "add")).toBeUndefined();
  });

  it("records the NFC divergence: the port normalizes both sides to NFC", async () => {
    const bind = await knowledgeBinder();
    const nfdInstruction = `Update the ${CAFE_NFD} page.`;
    // The knowledge binder matches raw bytes, so it misses; the port grounds.
    expect(bind(nfdInstruction, `${CAFE_NFC} page`)).toBeUndefined();
    expect(groundQuote(nfdInstruction, `${CAFE_NFC} page`)).toEqual({
      start: 11,
      end: 20,
    });
    expect(bind(`Update the ${CAFE_NFC} page.`, `${CAFE_NFD} page`)).toBeUndefined();
    expect(groundQuote(`Update the ${CAFE_NFC} page.`, `${CAFE_NFD} page`)).toEqual({
      start: 11,
      end: 20,
    });
  });
});
