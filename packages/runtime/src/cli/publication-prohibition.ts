// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The publication-prohibition phrase guard that `docsfab run` and `docsfab do`
 * share: whether request or instruction text forbids publishing, and, for
 * `do`'s risk check, the request without those clauses.
 *
 * A prohibition only narrows: it refuses a delivery that publishes and never
 * selects a delivery mode. Publication authority fails closed, so the grammar
 * errs toward refusing. A prohibition is a whole clause made of these forms,
 * optionally after a lead-in such as "however", "also", or "please":
 * - "do not", "don't" (any apostrophe), or "never", optionally with "ever" or
 *   an aside such as ", under any circumstances,", before publish, post, push,
 *   or commit with an optional bounded object, adverb, and destination ("push
 *   the new page directly to origin"), or before opening, creating, raising,
 *   or submitting a merge request, MR, pull request, or PR; several of these
 *   may follow one negation as a list;
 * - "this must not be published", "nothing should be pushed", "I don't want
 *   an MR", "skip the MR", "no publishing", "no need for an MR", "publication
 *   is forbidden", and "without publishing" or "without opening a merge
 *   request" as a clause of its own;
 * - "keep (or leave) it, the result, or the new page local", "local only",
 *   "only produce a patch", "just give me the diff", "patch only";
 * - any of these followed by a time or condition ("yet", "until it is
 *   reviewed", "unless", "without approval").
 *
 * The text is read after compatibility normalization, with invisible format
 * characters dropped, every kind of line break unified, HTML tags and a few
 * entities, emoji, and :shortcode: names removed, and Markdown list, heading,
 * quote, emphasis, and code markers ignored. Text inside a double-quoted
 * passage is content: a pair masks only when its quotes touch the words they
 * enclose and nothing between them is another quote. When any quote is left
 * unpaired, such as an inch mark, the unmasked text is read as well. Single
 * quotes are also apostrophes, so they never mask.
 *
 * Sentence ends, colons, semicolons, parentheses, dashes, "but", and "then"
 * end a clause, and the text is read four ways, any of which can refuse: line
 * breaks as clause ends, line breaks as spaces, every period as an end (as
 * when a space is missing after one), and every comma as an end. A clause that
 * is not one prohibition as a whole is read again split at "and". So "without
 * publishing" counts as ", without publishing" or "Without publishing, ...",
 * but not inside a description such as "check the page without publishing".
 *
 * `do`'s risk check still sees a merge request asked for beside a negated
 * list, as in "do not publish and open a merge request" or "do not publish,
 * open a merge request", so `do` stops there; both still refuse publication.
 * Phrasings outside these forms rely on the interpretation's
 * `non-publication` constraint.
 */

/** An apostrophe after normalization, or a backquote typed for one inside a word. */
const APOSTROPHE = "['`]";
/** An aside after the negation: "never, ever publish", "do not, under any circumstances, push". */
const NEGATION_ASIDE = String.raw`(?:\s*,\s*(?:ever|please|again|in\s+any\s+case|under\s+any\s+circumstances|at\s+any\s+(?:point|time|stage)|whatever\s+happens|by\s+any\s+means)(?:\s*,)?)`;
const NEGATION = String.raw`(?:do\s+not|don${APOSTROPHE}?t|never)(?:\s+ever)?${NEGATION_ASIDE}?`;
const DO_NOT = String.raw`(?:do\s+not|don${APOSTROPHE}?t)`;
/** A merge request by any of its names, optionally a draft, singular or plural. */
const MERGE_REQUEST = String.raw`(?:draft[\s-]+)?(?:mrs?|merge[\s-]?requests?|pull[\s-]?requests?|prs?)`;
const DELIVERY_NOUN = String.raw`(?:results?|changes?|patch(?:es)?|documentation|docs?|pages?|guides?|drafts?|branch(?:es)?|commits?|work|edits?|files?|output|comments?|${MERGE_REQUEST})`;
const DOCUMENTATION_PATH = String.raw`[\p{L}\p{N}_./-]+\.(?:md|mdx|rst|adoc|txt|html?)`;
/** A word before the noun, such as "new"; never a preposition, conjunction, or qualifier. */
const MODIFIER = String.raw`(?!(?:to|on|in|into|for|with|from|of|at|by|as|about|and|or|nor|but|until|till|unless|before|after|without|while|yet|now|anywhere|directly|straight|upstream)\b)[\p{L}\p{N}][\p{L}\p{N}_./-]*`;
/** What a publication verb may name; anything else ("secrets", "internal URLs") is content. */
const PUBLICATION_OBJECT = String.raw`(?:it|them|this|that|anything|everything|${DOCUMENTATION_PATH}|(?:(?:the|a|an|any|my|our|your|its|this|these|those|all)\s+)?(?:${MODIFIER}\s+){0,3}${DELIVERY_NOUN})`;
/** Where the result would go. A branch such as main is not one: delivery pushes its own branch. */
const REMOTE = String.raw`(?:remote|origin|gitlab|github|upstream|repository|repo|server|${MERGE_REQUEST})`;
const PUBLICATION_DESTINATION = String.raw`(?:to|on|into)\s+(?:(?:the|a|an|any|our|my|your)\s+)?(?:${MODIFIER}\s+)?${REMOTE}(?:(?:\s*,\s*|\s+)(?:or|and|nor)\s+(?:(?:the|a|an|any)\s+)?${REMOTE})*`;
const PUBLICATION_ADVERB = String.raw`(?:directly|straight|anywhere|upstream|remotely|publicly)`;
const PUBLICATION_INTENSIFIER = String.raw`(?:\s+(?:anywhere|at\s+all|either|ever))?`;
const PUBLISH_ACTION = String.raw`(?:publish|post|push|commit)(?:\s+${PUBLICATION_OBJECT})?(?:\s+${PUBLICATION_ADVERB})?(?:\s+${PUBLICATION_DESTINATION})?${PUBLICATION_INTENSIFIER}`;
const OPEN_MERGE_REQUEST_ACTION = String.raw`(?:open|create|raise|submit|file|make)\s+(?:(?:a|an|any|the)\s+)?${MERGE_REQUEST}${PUBLICATION_INTENSIFIER}`;
const PUBLICATION_ACTION = String.raw`(?:${PUBLISH_ACTION}|${OPEN_MERGE_REQUEST_ACTION})`;
/**
 * One action, or a list `do` can route past: commas ending in "or" or "nor",
 * commas ending in "and", or a bare "and" before publish, post, push, or commit.
 */
const PUBLICATION_ACTION_LIST = String.raw`${PUBLICATION_ACTION}(?:(?:\s*,\s*${PUBLICATION_ACTION})*(?:\s*,\s*|\s+)(?:or|nor)\s+${PUBLICATION_ACTION}|(?:\s*,\s*${PUBLICATION_ACTION})+(?:\s*,\s*|\s+)and\s+${PUBLICATION_ACTION}|\s+and\s+${PUBLISH_ACTION})?`;
/** Any list of actions after one negation, with any of those connectors. */
const PUBLICATION_ACTION_SEQUENCE = String.raw`${PUBLICATION_ACTION}(?:(?:\s*,\s*|(?:\s*,\s*|\s+)(?:and|or|nor)\s+)${PUBLICATION_ACTION})*`;
const BE_NOT = String.raw`(?:must\s+not|mustn${APOSTROPHE}?t|should\s+not|shouldn${APOSTROPHE}?t|shall\s+not|may\s+not|cannot|can\s+not|can${APOSTROPHE}?t|will\s+not|won${APOSTROPHE}?t|(?:is|are)\s+not\s+to|must\s+never|should\s+never|(?:is|are)\s+never\s+to)`;
const PUBLISHED = String.raw`(?:published|pushed|committed|posted)`;
const NOT_PUBLISHED = String.raw`(?:${PUBLICATION_OBJECT}|they)\s+${BE_NOT}\s+be\s+${PUBLISHED}(?:\s+${PUBLICATION_ADVERB})?(?:\s+${PUBLICATION_DESTINATION})?${PUBLICATION_INTENSIFIER}`;
const NOTHING_PUBLISHED = String.raw`nothing\s+(?:must|should|shall|may|can|will|is\s+to)\s+be\s+${PUBLISHED}(?:\s+${PUBLICATION_DESTINATION})?`;
const NOT_WANTED = String.raw`(?:i|we)\s+${DO_NOT}\s+(?:want|need)\s+(?:(?:(?:a|an|any|the)\s+)?${MERGE_REQUEST}|(?:${PUBLICATION_OBJECT}\s+)?(?:to\s+be\s+)?${PUBLISHED}(?:\s+${PUBLICATION_DESTINATION})?|(?:you\s+)?to\s+${PUBLICATION_ACTION_SEQUENCE})`;
const SKIPPED = String.raw`skip\s+(?:(?:the|a|an|any)\s+)?(?:${MERGE_REQUEST}|publishing|publication|pushing|push|committing|commit|posting|delivery|(?:opening|creating)\s+(?:(?:a|an|any|the)\s+)?${MERGE_REQUEST})(?:\s+steps?)?`;
const WITHOUT_PUBLICATION = String.raw`without\s+(?:(?:publishing|pushing|committing|posting)(?:\s+${PUBLICATION_OBJECT})?(?:\s+${PUBLICATION_ADVERB})?(?:\s+${PUBLICATION_DESTINATION})?|(?:opening|creating|raising|submitting|filing)\s+(?:(?:a|an|any|the)\s+)?${MERGE_REQUEST})${PUBLICATION_INTENSIFIER}`;
const PATCH = String.raw`(?:(?:a|the)\s+)?(?:local\s+)?(?:patch|diff)`;
const HAND_OVER = String.raw`(?:produce|create|give|return|generate|make|output|provide|write|send|show|deliver|leave|keep)\s+(?:(?:me|us)\s+)?`;
const PATCH_ONLY = String.raw`(?:(?:only|just)\s+(?:${HAND_OVER})?${PATCH}(?:\s+only)?|(?:${HAND_OVER})?${PATCH}\s+only|${HAND_OVER}(?:only|just)\s+${PATCH})`;
const KEEP_LOCAL = String.raw`(?:keep|leave)\s+(?:${PUBLICATION_OBJECT}|all\s+of\s+it|all)\s+(?:local(?:ly)?|on\s+(?:this|my|the\s+local)\s+machine|offline)(?:\s+only)?`;
const LOCAL_ONLY = String.raw`local(?:\s+(?:changes|patch|result|work))?\s+only`;
const NO_PUBLICATION = String.raw`no\s+(?:publishing|publication|pushing|push(?:es)?|commits?|committing|posting|${MERGE_REQUEST}|need\s+(?:for\s+(?:(?:a|an|any)\s+)?${MERGE_REQUEST}|to\s+${PUBLICATION_ACTION}))`;
const PUBLICATION_FORBIDDEN = String.raw`(?:publication|publishing|pushing|committing|posting)\s+(?:is\s+)?(?:forbidden|prohibited|not\s+allowed|not\s+permitted|disallowed)`;
/** A time or condition after a prohibition; publication waits on nothing DocsFab can check. */
const PROHIBITION_QUALIFIER = String.raw`(?:\s+(?:yet|now|for\s+now|right\s+now|today|at\s+this\s+(?:time|stage|point)|(?:until|till|unless|before|without|while|pending)\b[\s\S]*))?`;
const COMMA_OR_SPACE = String.raw`(?:\s*,\s*|\s+)`;
const LEAD_IN = String.raw`(?:(?:however|also|and|but|then|finally|additionally|importantly|again|so|lastly|plus|otherwise|instead|just|remember|note)${COMMA_OR_SPACE})?(?:(?:please|kindly)${COMMA_OR_SPACE})?`;
const PROHIBITION_SEPARATOR = String.raw`${COMMA_OR_SPACE}(?:(?:and|or|but|also|then|plus)${COMMA_OR_SPACE})?(?:(?:please|kindly)${COMMA_OR_SPACE})?`;
const COURTESY = String.raw`(?:${COMMA_OR_SPACE}(?:please|thanks|thank\s+you|ok|okay|cheers))?`;

/** A whole clause of one or more prohibitions; whitespace includes line breaks. */
function publicationProhibitionClause(actions: string): RegExp {
  const prohibition = String.raw`(?:${NEGATION}\s+${actions}|${NOT_PUBLISHED}|${NOTHING_PUBLISHED}|${NOT_WANTED}|${SKIPPED}|${WITHOUT_PUBLICATION}|${PATCH_ONLY}|${KEEP_LOCAL}|${LOCAL_ONLY}|${NO_PUBLICATION}|${PUBLICATION_FORBIDDEN})${PROHIBITION_QUALIFIER}`;
  return new RegExp(
    String.raw`^\s*${LEAD_IN}${prohibition}(?:${PROHIBITION_SEPARATOR}${prohibition})*${COURTESY}\s*$`,
    "u",
  );
}

/** A prohibition `do` routes past. */
const ROUTABLE_PROHIBITION_CLAUSE = publicationProhibitionClause(PUBLICATION_ACTION_LIST);
/** A prohibition that refuses publication; every routable one is one too. */
const PUBLICATION_PROHIBITION_CLAUSE = publicationProhibitionClause(PUBLICATION_ACTION_SEQUENCE);
const SENTENCE_END = String.raw`[.!?\u3002]+(?=[\s"')\]\u201D]|$)`;
const OTHER_CLAUSE_ENDS = String.raw`;+|:+(?=\s|$)|(?:,\s*|(?<=\s))(?:but|then)(?=\s)|[\u2013\u2014]+|(?<=\s)-{1,2}(?=\s)|[()[\]]`;
/** Clause ends when line breaks are read as spaces. */
const CLAUSE_END = new RegExp(String.raw`${SENTENCE_END}|${OTHER_CLAUSE_ENDS}`, "gu");
/** Clause ends when a line break also ends a clause. */
const CLAUSE_OR_LINE_END = new RegExp(String.raw`${SENTENCE_END}|${OTHER_CLAUSE_ENDS}|\n`, "gu");
/** Clause ends when every period ends a clause, even one inside a word. */
const CLAUSE_END_AT_ANY_PERIOD = new RegExp(String.raw`[.!?\u3002]+|${OTHER_CLAUSE_ENDS}`, "gu");
/** Clause ends when every comma ends a clause, as in "update the guide, do not push". */
const CLAUSE_OR_COMMA_END = new RegExp(String.raw`${SENTENCE_END}|${OTHER_CLAUSE_ENDS}|,`, "gu");
/** Where a clause that is not one prohibition is split again. */
const CLAUSE_AND = /(?:,\s*|(?<=\s))and(?=\s)/gu;
/** Every kind of line break, unified before anything else. */
const LINE_BREAK = /\r\n?|[\u0085\u2028\u2029]/gu;
/** Apostrophe-like marks, mapped before compatibility normalization splits ´ into a space and an accent. */
const APOSTROPHE_LIKE = /[\u00B4\u2018\u2019\u02BC\uFF07\u2032]/gu;
/** Invisible format characters, such as a zero-width space. */
const FORMAT_CHARACTER = /\p{Cf}/gu;
/** The HTML entities that appear in pasted text. */
const HTML_ENTITY = /&(?:nbsp|quot|apos|amp|lt|gt|#39|#160);/gu;
const HTML_ENTITY_TEXT: Readonly<Record<string, string>> = Object.freeze({
  "&nbsp;": " ",
  "&#160;": " ",
  "&quot;": '"',
  "&apos;": "'",
  "&#39;": "'",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
});
/** An HTML tag; it ends a clause where a line break would. */
const HTML_TAG = /<\/?[a-z][^<>\n]*>/gu;
/** Pictographs, skin tones, the emoji presentation selector, and :shortcode: names. */
const EMOJI = /\p{Extended_Pictographic}|\p{Emoji_Modifier}|\uFE0F|:[a-z0-9_+-]+:/gu;
/** A Markdown list, heading, or block quote marker at the start of a line. */
const LINE_MARKER = /^[ \t]*(?:#{1,6}|[-*+\u2022]|\d{1,3}[.)]|>+)[ \t]+/gmu;
/** A block quote marker inside a line. */
const INLINE_QUOTE_MARKER = /(?<=\s)>+(?=[ \t])/gu;
/** Emphasis, strike, and code markers that are not inside a word. */
const EMPHASIS_MARKER = /(?<![\p{L}\p{N}])[*_`~]+|[*_`~]+(?![\p{L}\p{N}])/gu;
/**
 * A double-quoted passage on one line: its quotes touch the words they
 * enclose, and nothing between them is another quote.
 */
const QUOTED_PASSAGE =
  /(?<![\p{L}\p{N}])"(?=[^\s"\u201C\u201D])[^"\u201C\u201D\n]*(?<=[^\s"\u201C\u201D])"(?![\p{L}\p{N}])|\u201C(?=[^\s"\u201C\u201D])[^"\u201C\u201D\n]*(?<=[^\s"\u201C\u201D])\u201D/gu;
/** A double quote of either kind. */
const DOUBLE_QUOTE = /["\u201C\u201D]/u;

interface TextSpan {
  readonly start: number;
  readonly end: number;
}

type ProhibitionReading = "refuses" | "routable";

/** How a text is cut into clauses; see the module comment. */
const SEGMENTATIONS = ["sentences-and-lines", "sentences", "periods", "commas"] as const;

type Segmentation = (typeof SEGMENTATIONS)[number];

/** The same text with every character but a line break replaced by a space. */
function blank(text: string): string {
  return text.replace(/[^\n]/gu, " ");
}

/**
 * The request as the grammar reads it: line breaks unified, apostrophes
 * folded, compatibility-normalized, lowercased, with format characters,
 * HTML tags and entities, emoji, and shortcodes removed.
 */
function normalizedRequest(request: string): string {
  return request
    .replace(LINE_BREAK, "\n")
    .replace(APOSTROPHE_LIKE, "'")
    .normalize("NFKC")
    .replace(FORMAT_CHARACTER, "")
    .toLowerCase()
    .replace(HTML_ENTITY, (entity) => HTML_ENTITY_TEXT[entity] ?? " ")
    .replace(HTML_TAG, "\n")
    .replace(EMOJI, " ");
}

/**
 * The texts the grammar reads, each as long as `normalized`: Markdown markers
 * blanked and quoted passages masked, and, when any quote is left unpaired,
 * the same text unmasked as well.
 */
function readableTexts(normalized: string): string[] {
  const plain = normalized
    .replace(LINE_MARKER, blank)
    .replace(INLINE_QUOTE_MARKER, blank)
    .replace(EMPHASIS_MARKER, blank);
  const masked = plain.replace(QUOTED_PASSAGE, (quoted) => "\u0000".repeat(quoted.length));
  return DOUBLE_QUOTE.test(masked) ? [masked, plain] : [masked];
}

/** The spans of `length` characters between `separators`, offset by `base`. */
function spansBetween(
  separators: Iterable<RegExpMatchArray>,
  base: number,
  length: number,
): TextSpan[] {
  const spans: TextSpan[] = [];
  let start = 0;
  for (const separator of separators) {
    spans.push({ start: base + start, end: base + separator.index! });
    start = separator.index! + separator[0].length;
  }
  spans.push({ start: base + start, end: base + length });
  return spans;
}

function isProhibitionClause(clause: string, reading: ProhibitionReading): boolean {
  return reading === "routable"
    ? ROUTABLE_PROHIBITION_CLAUSE.test(clause)
    : PUBLICATION_PROHIBITION_CLAUSE.test(clause);
}

/** The clause ends one segmentation reads. */
function clauseEnds(text: string, segmentation: Segmentation): Iterable<RegExpMatchArray> {
  switch (segmentation) {
    case "sentences-and-lines":
      return text.matchAll(CLAUSE_OR_LINE_END);
    case "sentences":
      return text.matchAll(CLAUSE_END);
    case "periods":
      return text.matchAll(CLAUSE_END_AT_ANY_PERIOD);
    case "commas":
      return text.matchAll(CLAUSE_OR_COMMA_END);
  }
}

/** The prohibition spans of one reading of the text, under one segmentation. */
function clauseSpans(
  text: string,
  segmentation: Segmentation,
  reading: ProhibitionReading,
): TextSpan[] {
  const found: TextSpan[] = [];
  for (const clause of spansBetween(clauseEnds(text, segmentation), 0, text.length)) {
    const clauseText = text.slice(clause.start, clause.end);
    if (isProhibitionClause(clauseText, reading)) {
      found.push(clause);
      continue;
    }
    for (const part of spansBetween(
      clauseText.matchAll(CLAUSE_AND),
      clause.start,
      clauseText.length,
    )) {
      if (isProhibitionClause(text.slice(part.start, part.end), reading)) found.push(part);
    }
  }
  return found;
}

/**
 * The spans of the normalized request that are prohibitions under `reading`,
 * merged across every text and segmentation the grammar reads.
 */
function prohibitionSpans(
  request: string,
  reading: ProhibitionReading,
): { normalized: string; spans: TextSpan[] } {
  const normalized = normalizedRequest(request);
  const found: TextSpan[] = [];
  for (const text of readableTexts(normalized)) {
    for (const segmentation of SEGMENTATIONS) {
      found.push(...clauseSpans(text, segmentation, reading));
    }
  }
  found.sort((left, right) => left.start - right.start);
  const spans: TextSpan[] = [];
  for (const span of found) {
    const last = spans.at(-1);
    if (last && span.start <= last.end) {
      spans[spans.length - 1] = { start: last.start, end: Math.max(last.end, span.end) };
    } else {
      spans.push(span);
    }
  }
  return { normalized, spans };
}

/**
 * The request, lowercased with single spaces, without the prohibitions `do`
 * routes past, or undefined when it has none. `do` tests its publication-risk
 * wording on this text, so a negated publication phrase does not stop it.
 */
export function removeClearPublicationProhibitions(request: string): string | undefined {
  const { normalized, spans } = prohibitionSpans(request, "routable");
  if (spans.length === 0) return undefined;
  let remainder = "";
  let cursor = 0;
  for (const span of spans) {
    remainder += `${normalized.slice(cursor, span.start)} `;
    cursor = span.end;
  }
  return `${remainder}${normalized.slice(cursor)}`.replace(/\s+/gu, " ").trim();
}

/**
 * Whether the text holds a publication prohibition. A constraint signal for
 * delivery, never an authority or delivery-mode grant.
 */
export function hasExplicitPublicationProhibition(request: string | undefined): boolean {
  return request !== undefined && prohibitionSpans(request, "refuses").spans.length > 0;
}
