// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The differential regression test for the publication-prohibition guard:
 * every prohibition main's recognizer accepted, placed in pasted, formatted,
 * and punctuated surroundings. Wherever main refused, the guard must refuse
 * too, and it must refuse every decorated form, including those main missed.
 */
import { describe, expect, it } from "vitest";

import { DeliveryFlagOperatorError } from "../src/cli/delivery-grants.js";
import { hasExplicitPublicationProhibition } from "../src/cli/publication-prohibition.js";
import { parseRunArguments } from "../src/cli/run-arguments.js";

/** Main's recognizer before the shared guard, frozen as the regression reference. */
const MAIN_PROHIBITIONS = [
  /^(?:do\s+not|don['\u2019]?t|dont|never)\s+(?:publish|post)(?:\s+(?:the\s+)?(?:result|changes?|patch|documentation|docs?|it|anything|draft[\s-]?mr|merge[\s-]?request))?$/u,
  /^keep\s+(?:the\s+)?(?:result|changes?|patch|documentation|docs?)\s+local$/u,
  /^(?:publication|publishing)\s+(?:is\s+)?(?:forbidden|prohibited|not\s+allowed)$/u,
] as const;
const MAIN_CLAUSE_BOUNDARY = /[.!?;]+|,\s*(?:but|and)\s+/u;

function mainRefuses(text: string): boolean {
  return text
    .trim()
    .replace(/\s+/gu, " ")
    .toLowerCase()
    .split(MAIN_CLAUSE_BOUNDARY)
    .map((clause) => clause.trim())
    .some((clause) => MAIN_PROHIBITIONS.some((pattern) => pattern.test(clause)));
}

/** Every phrase main's three patterns accept, in its spellings. */
function mainPhrases(): string[] {
  const phrases: string[] = [];
  const objects = [
    "",
    "the result",
    "result",
    "the changes",
    "changes",
    "the change",
    "the patch",
    "patch",
    "the documentation",
    "documentation",
    "the docs",
    "docs",
    "the doc",
    "it",
    "anything",
    "the draft MR",
    "draft-MR",
    "the merge request",
    "merge-request",
  ];
  for (const negation of ["Do not", "Don't", "Don\u2019t", "Dont", "Never"]) {
    for (const verb of ["publish", "post"]) {
      for (const object of objects)
        phrases.push(`${negation} ${verb}${object ? ` ${object}` : ""}`);
    }
  }
  for (const object of [
    "the result",
    "result",
    "the changes",
    "changes",
    "the change",
    "the patch",
    "patch",
    "the documentation",
    "documentation",
    "the docs",
    "docs",
    "the doc",
  ]) {
    phrases.push(`Keep ${object} local`);
  }
  for (const subject of ["Publication", "Publishing"]) {
    for (const rest of [
      "is forbidden",
      "is prohibited",
      "is not allowed",
      "forbidden",
      "prohibited",
      "not allowed",
    ]) {
      phrases.push(`${subject} ${rest}`);
    }
  }
  return phrases;
}

const PHRASES = mainPhrases();
const BASE = "Create docs/cli-reference.md for developers using Sprout from src/sprout.mjs.";
const LEAD = BASE.slice(0, -1);
const lowerFirst = (phrase: string): string => phrase[0]!.toLowerCase() + phrase.slice(1);
/** The phrase in fullwidth forms, as some input methods type it. */
const fullwidth = (phrase: string): string =>
  [...phrase]
    .map((character) =>
      character === " "
        ? "\u3000"
        : character >= "!" && character <= "~"
          ? String.fromCodePoint(character.codePointAt(0)! + 0xfee0)
          : character,
    )
    .join("");

/** Surroundings an operator's editor, shell, chat client, or Markdown leaves. */
const DECORATIONS: Readonly<Record<string, (phrase: string) => string>> = {
  "a sentence": (phrase) => `${BASE} ${phrase}.`,
  "a sentence with no final period": (phrase) => `${BASE} ${phrase}`,
  "the first sentence": (phrase) => `${phrase}. ${BASE}`,
  "its own line": (phrase) => `${BASE}\n${phrase}.`,
  "a line wrapped inside it": (phrase) => `${BASE} ${phrase.replace(" ", "\n")}.`,
  "CRLF lines": (phrase) => `${BASE}\r\n${phrase}.\r\n`,
  "a lone CR": (phrase) => `${BASE}\r${phrase}`,
  "a Unicode line separator": (phrase) => `${BASE}\u2028${phrase}`,
  "a CR after an unfinished line": (phrase) => `${LEAD}\r${phrase}`,
  "a line separator after an unfinished line": (phrase) => `${LEAD}\u2028${phrase}`,
  "a paragraph separator after an unfinished line": (phrase) => `${LEAD}\u2029${phrase}`,
  "a next-line character after an unfinished line": (phrase) => `${LEAD}\u0085${phrase}`,
  bold: (phrase) => `${BASE} **${phrase}.**`,
  italics: (phrase) => `${BASE} _${phrase}._`,
  "a code span": (phrase) => `${BASE} \`${phrase}.\``,
  "a list item": (phrase) => `${BASE}\n- ${phrase}.`,
  "a numbered item": (phrase) => `${BASE}\n1. ${phrase}.`,
  "a block quote": (phrase) => `${BASE}\n> ${phrase}.`,
  "an inline quote marker": (phrase) => `${BASE} > ${phrase}.`,
  "a heading": (phrase) => `${BASE}\n## ${phrase}`,
  "an HTML paragraph": (phrase) => `${BASE} <p>${phrase}.</p>`,
  "non-breaking space entities": (phrase) => `${BASE} ${phrase.replaceAll(" ", "&nbsp;")}.`,
  "a comma splice": (phrase) => `${LEAD}, ${lowerFirst(phrase)}.`,
  "a semicolon": (phrase) => `${LEAD}; ${lowerFirst(phrase)}.`,
  parentheses: (phrase) => `${BASE} (${lowerFirst(phrase)}).`,
  "an unspaced em dash": (phrase) => `${LEAD}\u2014${lowerFirst(phrase)}.`,
  "a following then": (phrase) => `${LEAD} then ${lowerFirst(phrase)}.`,
  "a lead-in": (phrase) => `${BASE} Please, ${lowerFirst(phrase)}.`,
  "stray quotes around it": (phrase) =>
    `${BASE} Explain that a " inside a field is doubled. ${phrase}. Note that " must wrap fields.`,
  "inch marks around it": (phrase) => `${BASE} Use a 3" margin. ${phrase}. Use a 2" gutter.`,
  "mismatched quotes around it": (phrase) =>
    `${BASE} Name it "Quick start\u201D. ${phrase}. Add a \u201CUsage" section.`,
  "a quoted title beside it": (phrase) => `${BASE} Add a "Usage" section. ${phrase}.`,
  "a quoted rule before an open quote": (phrase) =>
    `${BASE} Add the rule "Build first. ${phrase}." and a "Usage section.`,
  "a curly-quoted rule before an open curly quote": (phrase) =>
    `${BASE} Add the rule \u201CBuild first. ${phrase}.\u201D and a \u201CUsage section.`,
  "backquoted quote characters around it": (phrase) =>
    `${BASE} Document how \`"\` works. ${phrase}. Escape \`"\` too.`,
  "a zero-width space": (phrase) => `${BASE} ${phrase.replace(" ", " \u200B")}.`,
  "fullwidth forms": (phrase) => `${BASE} ${fullwidth(phrase)}\u3002`,
  "a trailing emoji": (phrase) => `${BASE} ${phrase} \u{1F64F}`,
  "a trailing shortcode": (phrase) => `${BASE} ${phrase} :pray:`,
  "a trailing OK": (phrase) => `${BASE} ${phrase}, OK?`,
  "a trailing please": (phrase) => `${BASE} ${phrase} please.`,
};

describe("the guard refuses every prohibition main refused, however it is decorated", () => {
  it("reproduces main's phrase list, so the comparison is not empty", () => {
    expect(PHRASES).toHaveLength(214);
    expect(PHRASES.filter((phrase) => !mainRefuses(`${BASE} ${phrase}.`))).toEqual([]);
  });

  it.each(Object.keys(DECORATIONS))("refuses wherever main refused, in %s", (name) => {
    const decorate = DECORATIONS[name]!;
    const regressions = PHRASES.map(decorate).filter(
      (text) => mainRefuses(text) && !hasExplicitPublicationProhibition(text),
    );
    expect(regressions).toEqual([]);
  });

  it.each(Object.keys(DECORATIONS))("refuses every main prohibition in %s", (name) => {
    const decorate = DECORATIONS[name]!;
    const missed = PHRASES.map(decorate).filter((text) => !hasExplicitPublicationProhibition(text));
    expect(missed).toEqual([]);
  });

  it.each(Object.keys(DECORATIONS))("refuses run's default delivery in %s", (name) => {
    const instruction = DECORATIONS[name]!("Do not publish");
    let error: unknown;
    try {
      parseRunArguments([
        "create-documentation",
        "--repo",
        "/tmp/example-repo",
        "--instruction",
        instruction,
      ]);
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(DeliveryFlagOperatorError);
    expect(error).toMatchObject({ code: "publication-prohibition-conflict" });
  });
});
