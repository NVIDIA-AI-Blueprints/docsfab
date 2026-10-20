// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Quote grounding: find where a model's quote sits in the operator's request.
 *
 * Ported from the knowledge first pass's instruction-quote binding, which the
 * runtime may not import; a parity test drives both with one fixture table.
 * The only difference is normalization: both sides are NFC-normalized here,
 * so offsets index the NFC instruction that the request digest hashes.
 *
 * The fold forgives only what a model changes when it copies a passage:
 * letter case, whitespace runs, typographic quotes and dashes, surrounding
 * quotation marks, and trailing sentence punctuation. It is character-level
 * matching and decides nothing about what the request asks for.
 *
 * Unlike the knowledge binder, a span must also sit on word boundaries, and
 * every match is tried rather than only the first: "add" never grounds inside
 * "address", while a later whole-word "add" does. The boundary and the path
 * token below are admission checks only; verification re-reads offsets and
 * text, so its quote check never depends on the running engine's Unicode
 * property tables. Its path fold still uses the engine's case mapping.
 */
import { sha256 } from "../content-ir/canonical.js";

export interface QuoteSpan {
  readonly start: number;
  readonly end: number;
}

const QUOTE_EQUIVALENTS: ReadonlyMap<string, string> = new Map([
  ["\u2018", "'"],
  ["\u2019", "'"],
  ["\u201a", "'"],
  ["\u201b", "'"],
  ["\u2032", "'"],
  ["\u201c", '"'],
  ["\u201d", '"'],
  ["\u201e", '"'],
  ["\u201f", '"'],
  ["\u2033", '"'],
  ["\u2010", "-"],
  ["\u2011", "-"],
  ["\u2012", "-"],
  ["\u2013", "-"],
  ["\u2014", "-"],
  ["\u2212", "-"],
]);

interface FoldedText {
  readonly text: string;
  /** Source offset where each folded UTF-16 unit starts. */
  readonly starts: readonly number[];
  /** Source offset where each folded UTF-16 unit ends. */
  readonly ends: readonly number[];
}

/** Fold text for comparison, keeping each folded unit's source range. */
function foldText(text: string): FoldedText {
  let folded = "";
  const starts: number[] = [];
  const ends: number[] = [];
  let pendingSpace: [number, number] | undefined;
  let offset = 0;
  for (const character of text) {
    const start = offset;
    offset += character.length;
    if (/\s/u.test(character)) {
      if (folded.length > 0) pendingSpace = [pendingSpace?.[0] ?? start, offset];
      continue;
    }
    if (pendingSpace) {
      folded += " ";
      starts.push(pendingSpace[0]);
      ends.push(pendingSpace[1]);
      pendingSpace = undefined;
    }
    const unit = (QUOTE_EQUIVALENTS.get(character) ?? character).toLowerCase();
    folded += unit;
    for (let index = 0; index < unit.length; index += 1) {
      starts.push(start);
      ends.push(offset);
    }
  }
  return { text: folded, starts, ends };
}

function matchKey(text: string): string {
  return foldText(text)
    .text.replace(/^["'`]+/u, "")
    .replace(/["'`]+$/u, "")
    .replace(/[.,;:!?]+$/u, "")
    .replace(/["'`]+$/u, "")
    .trim();
}

/**
 * The span of `quote` in `instruction`, both NFC-normalized, or `undefined`
 * when the quote has no letter or digit or no word-bounded occurrence that
 * `accept` takes. Exact occurrences are tried before folded ones, each in text
 * order. The span indexes `instruction.normalize("NFC")`.
 */
export function groundQuote(
  instruction: string,
  quote: string,
  accept: (span: QuoteSpan) => boolean = () => true,
): QuoteSpan | undefined {
  const text = instruction.normalize("NFC");
  const needleText = quote.normalize("NFC");
  // Whitespace or punctuation alone names nothing in the request.
  if (!/[\p{L}\p{N}]/u.test(needleText)) return undefined;
  for (const exact of occurrences(text, needleText)) {
    const span = { start: exact, end: exact + needleText.length };
    if (wordBounded(text, span) && accept(span)) return span;
  }
  const needle = matchKey(needleText);
  if (needle === "") return undefined;
  const haystack = foldText(text);
  for (const at of occurrences(haystack.text, needle)) {
    const span = {
      start: haystack.starts[at]!,
      end: haystack.ends[at + needle.length - 1]!,
    };
    // A folded hit that starts inside a multi-unit fold widens; the re-check refuses it.
    if (
      matchKey(text.slice(span.start, span.end)) === needle &&
      wordBounded(text, span) &&
      accept(span)
    ) {
      return span;
    }
  }
  return undefined;
}

/** Every start offset of `needle` in `haystack` from `from` on, overlapping hits included. */
function* occurrences(haystack: string, needle: string, from?: number): Generator<number> {
  // Step one UTF-16 unit past each hit so overlapping occurrences are tried too.
  for (let at = haystack.indexOf(needle, from); at >= 0; at = haystack.indexOf(needle, at + 1)) {
    yield at;
  }
}

/** The code point that starts at `index`, or `undefined` at the end of `text`. */
function characterAt(text: string, index: number): string | undefined {
  const code = text.codePointAt(index);
  return code === undefined ? undefined : String.fromCodePoint(code);
}

/** The code point that ends at `index`, or `undefined` at the start of `text`. */
function characterBefore(text: string, index: number): string | undefined {
  // A sticky lookbehind reads one whole code point, surrogate pairs included.
  const before = /(?<=(.))/suy;
  before.lastIndex = index;
  return before.exec(text)?.[1];
}

/**
 * Scripts written without spaces between words. Inside them no word boundary
 * is enforced, or a quote of part of a sentence would never ground.
 */
const UNSPACED_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u;

/** A letter, digit or combining mark, outside the unspaced scripts. */
function isWordCharacter(character: string | undefined): boolean {
  return (
    character !== undefined &&
    /[\p{L}\p{N}\p{M}]/u.test(character) &&
    !UNSPACED_SCRIPT.test(character)
  );
}

/**
 * A span breaks a word at an edge when the character inside the span at that
 * edge and its neighbour outside are both word characters. A combining mark
 * counts, so a span cannot end between a letter and its accent.
 */
function wordBounded(text: string, span: QuoteSpan): boolean {
  const startBreaks =
    isWordCharacter(characterAt(text, span.start)) &&
    isWordCharacter(characterBefore(text, span.start));
  const endBreaks =
    isWordCharacter(characterBefore(text, span.end)) &&
    isWordCharacter(characterAt(text, span.end));
  return !startBreaks && !endBreaks;
}

/** Full-width and CJK brackets and quotes, which open and close a token like their ASCII forms. */
const WIDE_OPENERS = [
  "\uff08",
  "\uff3b",
  "\uff5b",
  "\uff1c",
  "\uff02",
  "\uff07",
  "\u3008",
  "\u300a",
  "\u300c",
  "\u300e",
  "\u3010",
  "\u3014",
];
const WIDE_CLOSERS = [
  "\uff09",
  "\uff3d",
  "\uff5d",
  "\uff1e",
  "\uff02",
  "\uff07",
  "\u3009",
  "\u300b",
  "\u300d",
  "\u300f",
  "\u3011",
  "\u3015",
];
const TOKEN_OPENERS: ReadonlySet<string> = new Set([
  "(",
  "[",
  "{",
  "<",
  '"',
  "'",
  "`",
  "\u201c",
  "\u2018",
  ...WIDE_OPENERS,
]);
const TOKEN_CLOSERS: ReadonlySet<string> = new Set([
  ")",
  "]",
  "}",
  ">",
  '"',
  "'",
  "`",
  "\u201d",
  "\u2019",
  ...WIDE_CLOSERS,
]);
const SENTENCE_PUNCTUATION: ReadonlySet<string> = new Set([".", ",", ":", ";", "!", "?"]);
/**
 * Full-width and ideographic sentence punctuation. Text that uses it puts no
 * space after it, and no ASCII path is spelled with it, so it ends a token
 * wherever it follows the path.
 */
const WIDE_PUNCTUATION: ReadonlySet<string> = new Set([
  "\u3001",
  "\u3002",
  "\uff01",
  "\uff0c",
  "\uff0e",
  "\uff1a",
  "\uff1b",
  "\uff1f",
]);
const FRAGMENT_MARK = "#";
const CURRENT_DIRECTORY = "./";
const PATH_SEPARATOR = "/";
const EXTENSION_MARK = ".";

function isSpace(character: string | undefined): boolean {
  return character !== undefined && /\s/u.test(character);
}

/**
 * Text in a script written without spaces runs straight into a path, as in
 * "请更新docs/cli.md的内容". A change between such a script and any other
 * character is a token edge; two characters of those scripts side by side are
 * not, so `docs/指南` never names part of `docs/指南.md`.
 */
function scriptEdge(inside: string | undefined, outside: string | undefined): boolean {
  return (
    inside !== undefined &&
    outside !== undefined &&
    UNSPACED_SCRIPT.test(outside) &&
    !UNSPACED_SCRIPT.test(inside)
  );
}

/** ASCII sentence punctuation at `index` that ends a token: end of text, whitespace or a closer follows it. */
function endsSentence(text: string, index: number): boolean {
  const character = characterAt(text, index);
  if (character === undefined || !SENTENCE_PUNCTUATION.has(character)) return false;
  const next = characterAt(text, index + character.length);
  return next === undefined || isSpace(next) || TOKEN_CLOSERS.has(next);
}

/** Characters that bound the stretch a path could still continue into. */
function boundsStretch(character: string): boolean {
  return (
    isSpace(character) ||
    TOKEN_OPENERS.has(character) ||
    TOKEN_CLOSERS.has(character) ||
    character === FRAGMENT_MARK ||
    WIDE_PUNCTUATION.has(character)
  );
}

/**
 * The path's last segment carries an extension: a `.` after its first
 * character. Unspaced text after `docs/api` may be the rest of its name, as in
 * `docs/api参考`; after `docs/api.md` it is not, so only an extended path
 * ends at a script edge.
 */
function hasExtension(path: string): boolean {
  const name = path.slice(path.lastIndexOf(PATH_SEPARATOR) + 1);
  return name.indexOf(EXTENSION_MARK, 1) > 0;
}

/** A `/` or `.` inside the stretch past a script edge: the path runs on. */
function marksPath(character: string): boolean {
  return character === PATH_SEPARATOR || character === EXTENSION_MARK;
}

/**
 * The NFC instruction, with whether a path runs on across a script edge at
 * each offset. A path runs on past an edge when, before the stretch after it
 * ends, a `/` or a `.` that does not end the sentence shows the unspaced text
 * is part of a longer name, as in `docs/api参考.md`; the mirror holds before
 * an edge, as in `a/参考docs/x.md`, where any `.` counts because a
 * sentence-ending `.` is followed by a space that bounds the stretch first.
 * This errs closed, so `docs/a.md和docs/b.md` names neither path; a wrong
 * token end would let a named target ground on a prefix of the path the
 * operator wrote. Each table is filled in one pass, so judging every
 * occurrence of every named path never rescans the instruction.
 */
export interface PathTokenText {
  readonly text: string;
  readonly runsOnAfter: Uint8Array;
  readonly runsOnBefore: Uint8Array;
}

/** The run-on tables for `text`, the NFC instruction. */
export function pathTokenText(text: string): PathTokenText {
  const runsOnAfter = new Uint8Array(text.length + 1);
  for (let at = text.length - 1; at >= 0; at -= 1) {
    const character = characterAt(text, at) as string;
    runsOnAfter[at] =
      boundsStretch(character) || endsSentence(text, at)
        ? 0
        : marksPath(character)
          ? 1
          : runsOnAfter[at + character.length]!;
  }
  const runsOnBefore = new Uint8Array(text.length + 1);
  for (let at = 1; at <= text.length; at += 1) {
    const character = characterBefore(text, at) as string;
    runsOnBefore[at] = boundsStretch(character)
      ? 0
      : marksPath(character)
        ? 1
        : runsOnBefore[at - character.length]!;
  }
  return { text, runsOnAfter, runsOnBefore };
}

/**
 * Start of text, whitespace, an opening bracket or quote, or a script edge
 * the path does not run back across precedes `index`.
 */
function opensToken({ text, runsOnBefore }: PathTokenText, index: number): boolean {
  const before = characterBefore(text, index);
  return (
    before === undefined ||
    isSpace(before) ||
    TOKEN_OPENERS.has(before) ||
    (scriptEdge(characterAt(text, index), before) && runsOnBefore[index] === 0)
  );
}

/** A path token starts at `index`, directly or after a `./` that itself opens a token. */
function pathTokenStarts(tokens: PathTokenText, index: number): boolean {
  if (opensToken(tokens, index)) return true;
  const prefix = index - CURRENT_DIRECTORY.length;
  return (
    prefix >= 0 && tokens.text.startsWith(CURRENT_DIRECTORY, prefix) && opensToken(tokens, prefix)
  );
}

/**
 * A path token ends at `index` before end of text, whitespace, a closing
 * bracket or quote, a fragment mark, full-width sentence punctuation, a
 * script edge after an extended path that does not run on across it, or
 * ASCII sentence punctuation that itself ends the token, so `docs/cli.md.`
 * ends a sentence while `docs/cli.mdx` and `docs/cli.md.bak` name other files.
 */
function pathTokenEnds(
  { text, runsOnAfter }: PathTokenText,
  index: number,
  extended: boolean,
): boolean {
  const after = characterAt(text, index);
  return (
    after === undefined ||
    isSpace(after) ||
    TOKEN_CLOSERS.has(after) ||
    after === FRAGMENT_MARK ||
    WIDE_PUNCTUATION.has(after) ||
    (extended && scriptEdge(characterBefore(text, index), after) && runsOnAfter[index] === 0) ||
    endsSentence(text, index)
  );
}

/**
 * Whether `span` of the NFC instruction holds `path`, exact case, as a whole
 * path token. Token edges are judged against the text around the span, not
 * the span's own edges, and every occurrence inside it is tried.
 */
export function spanNamesPath(tokens: PathTokenText, span: QuoteSpan, path: string): boolean {
  const extended = hasExtension(path);
  for (const at of occurrences(tokens.text, path, span.start)) {
    if (at + path.length > span.end) return false;
    if (pathTokenStarts(tokens, at) && pathTokenEnds(tokens, at + path.length, extended)) {
      return true;
    }
  }
  return false;
}

/**
 * Whether `tokens.text` holds `path`, exact case, as a whole path token that
 * opens on its own: unlike {@link spanNamesPath}, a `./` before it does not
 * open the token, so `./docs/AGENTS.md` names no path here.
 */
export function textNamesPath(tokens: PathTokenText, path: string): boolean {
  if (path === "") return false;
  const extended = hasExtension(path);
  for (const at of occurrences(tokens.text, path)) {
    if (opensToken(tokens, at) && pathTokenEnds(tokens, at + path.length, extended)) return true;
  }
  return false;
}

/** sha256 of the NFC-normalized instruction: the request digest target controls check. */
export function requestInstructionSha256(instruction: string): string {
  return sha256(instruction.normalize("NFC"));
}
