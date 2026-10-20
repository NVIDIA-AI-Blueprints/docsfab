// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Lexical index over a project's documentation pages at one revision (#2400).
 *
 * A Slack question that names no page is answered from the pages this index
 * ranks highest, so the whole documentation set never enters the model's
 * context. The index is pure: the caller reads the pages and decides which
 * belong to the set; nothing here touches the filesystem.
 *
 * Ranking is BM25F over four fields (path, title, headings, body) plus a bonus
 * for query terms in the title, path, and headings, the strongest signal that
 * a page is about a topic. A title bonus scales with how much of the title the
 * question covers, so "Install DocsFab" outranks a long page that mentions
 * installing once. Terms are Porter-stemmed English words; camelCase is split
 * so `liveAgentTurn` matches "live agent turn". Semantic retrieval is future
 * work; this is the scaffold the live path uses today.
 */

/** Bumped when tokenizing or scoring changes, so a recorded selection names its ranking. */
export const DOCUMENTATION_INDEX_VERSION = 1 as const;

export interface DocumentationIndexPage {
  /** Repository-relative path; also the page's identity in results. */
  readonly path: string;
  readonly text: string;
}

export interface DocumentationIndexSearchOptions {
  /**
   * The project's declared documentation roots, directories or pages. Their
   * pages rank ahead of equally relevant pages elsewhere, as the repository's
   * canonical pages always do ({@link isCanonicalRepositoryPage}); nothing is
   * dropped.
   */
  readonly preferredRoots?: readonly string[];
}

/** One weighted query text, such as the question or an earlier question in its thread. */
export interface DocumentationIndexQuery {
  readonly text: string;
  readonly weight: number;
}

export interface DocumentationIndexHit {
  readonly path: string;
  readonly score: number;
}

export interface DocumentationIndexResult {
  /** Highest score first; ties by path. */
  readonly hits: readonly DocumentationIndexHit[];
  /** Pages that matched at least one query term, before the count bound. */
  readonly matchedPageCount: number;
}

/** Field order for every per-field array below. */
const FIELDS = ["path", "title", "heading", "body"] as const;
const PATH = 0;
const TITLE = 1;
const HEADING = 2;
const BODY = 3;

/** BM25F weight of one occurrence in each field, before saturation. */
const FIELD_WEIGHT = [2, 3, 2, 1] as const;
/**
 * BM25F length normalization per field. Path and title are short labels, so a
 * long body never dilutes them; headings normalize lightly.
 */
const FIELD_NORMALIZATION = [0, 0, 0.3, 0.75] as const;
/** BM25 term-frequency saturation (the usual k1). */
const TERM_SATURATION = 1.2;
/** Structural bonus per matched query term, in units of the term's IDF. */
const TITLE_BONUS = 2;
const PATH_BONUS = 1;
const HEADING_BONUS = 0.5;
/**
 * How much more a page under one of the project's declared documentation
 * roots, or one of the repository's canonical pages, counts than an equally
 * relevant page elsewhere. On 47 questions about DocsFab's own repository,
 * 1.5 for the declared roots put the expected page first for 27 of them
 * against 14 without it, where 2 found fewer expected pages (2026-10-14).
 * Giving the canonical pages the same 1.5 found an expected page in the top
 * six for 41 of them against 34 (2026-10-15): with only `docs/` preferred,
 * README.md and AGENTS.md fell behind `docs/` pages that mention a topic.
 */
const DOCUMENTATION_ROOT_PREFERENCE = 1.5;

/** English function words and question words that carry no topic. */
const STOP_WORDS: ReadonlySet<string> = new Set(
  (
    "a about after all also am an and any are as at be been before being between both but by " +
    "can could did do does doing done during each for from had has have having he her here hers " +
    "him his how i if in into is it its itself just me more most my no nor not of off on once " +
    "only or other our ours out over own same she should so some such than that the their theirs " +
    "them then there these they this those through to too under until up us very was we were " +
    "what when where which while who whom why will with would you your yours"
  ).split(" "),
);

/*
 * Every pattern below is linear in its input: page text and questions come
 * from people and repositories, so no pattern may backtrack over a long token.
 */
const WORD = /[\p{L}\p{N}]+/gu;
const ASCII_LETTERS = /^[a-z]+$/u;
/** Characters that end a path as a question writes it. */
const PATH_DELIMITERS = /[\s`'"<>()[\]{},;]+/u;
const FENCE = /^ {0,3}(?:```|~~~)/u;
/** A setext heading underline: `=` for level 1 or `-` for level 2, nothing else. */
const SETEXT_UNDERLINE = /^ {0,3}(?:=+|-+)[ \t]*$/u;
/** A thematic break of `*`, `-`, or `_`, which ends a paragraph. */
const THEMATIC_BREAK = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/u;
/** A list item marker or a block quote, either of which opens a block of its own. */
const BLOCK_START = /^ {0,3}(?:[-*+](?:[ \t]|$)|\d{1,9}[.)](?:[ \t]|$)|>)/u;

interface Posting {
  readonly page: number;
  /** Occurrences per field, in {@link FIELDS} order. */
  readonly counts: readonly [number, number, number, number];
}

/** Opaque; build with {@link buildDocumentationIndex}. */
export interface DocumentationIndex {
  readonly version: typeof DOCUMENTATION_INDEX_VERSION;
  /** Indexed page paths, sorted. */
  readonly paths: readonly string[];
  /** @internal */
  readonly postings: ReadonlyMap<string, readonly Posting[]>;
  /** @internal Terms per field per page, in {@link FIELDS} order. */
  readonly fieldLengths: readonly (readonly number[])[];
  /** @internal */
  readonly averageFieldLengths: readonly number[];
  /** @internal Distinct title terms per page, the denominator of title coverage. */
  readonly titleTermCounts: readonly number[];
}

/** Build the index. Pages are sorted by path, so input order never changes a ranking. */
export function buildDocumentationIndex(
  pages: readonly DocumentationIndexPage[],
): DocumentationIndex {
  const sorted = [...pages].sort((left, right) => compareText(left.path, right.path));
  const stems = new Map<string, string>();
  const postings = new Map<string, Posting[]>();
  const fieldLengths: number[][] = [];
  const titleTermCounts: number[] = [];
  const totals = [0, 0, 0, 0];
  for (const [page, entry] of sorted.entries()) {
    if (page > 0 && sorted[page - 1]!.path === entry.path) {
      throw new Error(`The documentation index received the page ${entry.path} more than once.`);
    }
    const fields = pageFields(entry);
    const counts = new Map<string, [number, number, number, number]>();
    const lengths = [0, 0, 0, 0];
    for (const [field, text] of fields.entries()) {
      for (const term of documentationTermsWith(text, stems)) {
        let entryCounts = counts.get(term);
        if (!entryCounts) {
          entryCounts = [0, 0, 0, 0];
          counts.set(term, entryCounts);
        }
        entryCounts[field]! += 1;
        lengths[field]! += 1;
      }
    }
    let titleTerms = 0;
    for (const [term, entryCounts] of counts) {
      if (entryCounts[TITLE] > 0) titleTerms += 1;
      let list = postings.get(term);
      if (!list) {
        list = [];
        postings.set(term, list);
      }
      list.push({ page, counts: entryCounts });
    }
    fieldLengths.push(lengths);
    titleTermCounts.push(titleTerms);
    for (let field = 0; field < FIELDS.length; field += 1) totals[field]! += lengths[field]!;
  }
  const count = Math.max(sorted.length, 1);
  return Object.freeze({
    version: DOCUMENTATION_INDEX_VERSION,
    paths: Object.freeze(sorted.map((entry) => entry.path)),
    postings,
    fieldLengths,
    // A field no page uses averages to 1, so normalization never divides by zero.
    averageFieldLengths: totals.map((total) => Math.max(total / count, 1)),
    titleTermCounts,
  });
}

/**
 * Rank the indexed pages against weighted query texts and return at most
 * `count` hits, each with a positive score. Ties break by path. A page named
 * by its exact path is the caller's to honour (`pathsNamedIn`), because it
 * may lie outside the index.
 *
 * Each text is scored on its own, every text's scores are scaled by one
 * divisor, the best score any text reaches, and the scaled scores add by
 * weight. One divisor keeps a weak text weak: scaling each text by its own
 * best would lift the faint matches of a vague follow-up such as "how long
 * does that take?" to full matches that bury the earlier topic. With a lower
 * weight on a follow-up's previous question, the earlier topic leads only
 * when the new question matches nothing nearly as well.
 */
export function searchDocumentationIndex(
  index: DocumentationIndex,
  query: readonly DocumentationIndexQuery[],
  count: number,
  options: DocumentationIndexSearchOptions = {},
): DocumentationIndexResult {
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new Error("Documentation index search needs a positive whole page count.");
  }
  const scored = query.map((part) => {
    if (!(part.weight > 0) || !Number.isFinite(part.weight)) {
      throw new Error("Documentation index query weights must be positive and finite.");
    }
    return { weight: part.weight, scores: scoreText(index, part.text) };
  });
  let scale = 0;
  for (const { scores } of scored) {
    for (const score of scores.values()) scale = Math.max(scale, score);
  }
  const totals = new Map<number, number>();
  for (const { weight, scores } of scale > 0 ? scored : []) {
    for (const [page, score] of scores) {
      totals.set(page, (totals.get(page) ?? 0) + (weight * score) / scale);
    }
  }
  const roots = options.preferredRoots ?? [];
  const ranked: DocumentationIndexHit[] = [];
  for (const [page, total] of totals) {
    if (!(total > 0)) continue;
    const path = index.paths[page]!;
    const preferred =
      isCanonicalRepositoryPage(path) ||
      roots.some((root) => path === root || path.startsWith(`${root}/`));
    ranked.push({ path, score: preferred ? total * DOCUMENTATION_ROOT_PREFERENCE : total });
  }
  ranked.sort((left, right) => right.score - left.score || compareText(left.path, right.path));
  return Object.freeze({
    hits: Object.freeze(ranked.slice(0, count).map((hit) => Object.freeze(hit))),
    matchedPageCount: ranked.length,
  });
}

/** Every matching page's score for one query text. */
function scoreText(index: DocumentationIndex, text: string): Map<number, number> {
  const terms = [...new Set(documentationTermsWith(text, new Map()))].sort(compareText);
  const pageCount = index.paths.length;
  const scores = new Map<number, PageScore>();
  // Sorted, so floating-point sums accumulate in one order on every run.
  for (const term of terms) {
    const list = index.postings.get(term);
    if (!list) continue;
    const idf = Math.log(1 + (pageCount - list.length + 0.5) / (list.length + 0.5));
    for (const { page, counts } of list) {
      const lengths = index.fieldLengths[page]!;
      let frequency = 0;
      for (let field = 0; field < FIELDS.length; field += 1) {
        const occurrences = counts[field]!;
        if (occurrences === 0) continue;
        const normalization = FIELD_NORMALIZATION[field]!;
        frequency +=
          (FIELD_WEIGHT[field]! * occurrences) /
          (1 -
            normalization +
            (normalization * lengths[field]!) / index.averageFieldLengths[field]!);
      }
      const score = scores.get(page) ?? { relevance: 0, title: 0, titleTerms: 0, structure: 0 };
      score.relevance += idf * (frequency / (TERM_SATURATION + frequency));
      if (counts[TITLE] > 0) {
        score.title += idf;
        score.titleTerms += 1;
      }
      if (counts[PATH] > 0) score.structure += idf * PATH_BONUS;
      if (counts[HEADING] > 0) score.structure += idf * HEADING_BONUS;
      scores.set(page, score);
    }
  }
  const totals = new Map<number, number>();
  for (const [page, score] of scores) {
    const titleTerms = index.titleTermCounts[page]!;
    const coverage = titleTerms === 0 ? 0 : score.titleTerms / titleTerms;
    totals.set(page, score.relevance + score.structure + TITLE_BONUS * coverage * score.title);
  }
  return totals;
}

interface PageScore {
  relevance: number;
  /** IDF-weighted sum of the query terms found in the title. */
  title: number;
  titleTerms: number;
  structure: number;
}

/**
 * The `paths` that `text` names exactly, in order of first mention. A
 * question that names a page by its path asked about that page, wherever it
 * lives, so the caller honours it ahead of any ranking.
 */
export function pathsNamedIn(text: string, paths: ReadonlySet<string>): string[] {
  const named: string[] = [];
  for (const token of text.split(PATH_DELIMITERS)) {
    let end = token.length;
    // Sentence punctuation after a path, as in "see README.md.".
    while (end > 0 && ".:!?".includes(token[end - 1]!)) end -= 1;
    const path = token.slice(token.startsWith("./") ? 2 : 0, end);
    if (path.endsWith(".md") && paths.has(path) && !named.includes(path)) named.push(path);
  }
  return named;
}

/**
 * The index terms of `text`: lowercased words and numbers, without English
 * function words or single characters, Porter-stemmed, with each camelCase
 * part added beside the whole word.
 */
export function documentationTerms(text: string): string[] {
  return documentationTermsWith(text, new Map());
}

function documentationTermsWith(text: string, stems: Map<string, string>): string[] {
  const terms: string[] = [];
  const add = (word: string): void => {
    if (word.length < 2 || STOP_WORDS.has(word)) return;
    let stem = stems.get(word);
    if (stem === undefined) {
      stem = ASCII_LETTERS.test(word) ? porterStem(word) : word;
      stems.set(word, stem);
    }
    terms.push(stem);
  };
  for (const match of text.matchAll(WORD)) {
    const raw = match[0];
    const lower = raw.toLowerCase();
    add(lower);
    // Only a word with an upper-case letter after its first can split.
    if (lower === raw || lower.slice(1) === raw.slice(1)) continue;
    const parts = camelCaseParts(raw);
    if (parts.length > 1) for (const part of parts) add(part.toLowerCase());
  }
  return terms;
}

/**
 * `liveAgentTurn` -> live, Agent, Turn; `HTTPServer` -> HTTP, Server;
 * `v2Beta` -> v2, Beta. One pass over the word.
 */
function camelCaseParts(word: string): string[] {
  const letters = [...word];
  const parts: string[] = [];
  let start = 0;
  for (let index = 1; index < letters.length; index += 1) {
    const previous = letters[index - 1]!;
    const current = letters[index]!;
    const next = letters[index + 1];
    const boundary =
      isUpper(current) &&
      (isLower(previous) ||
        isDigit(previous) ||
        (isUpper(previous) && next !== undefined && isLower(next)));
    if (!boundary) continue;
    parts.push(letters.slice(start, index).join(""));
    start = index;
  }
  parts.push(letters.slice(start).join(""));
  return parts;
}

function isUpper(letter: string): boolean {
  return letter !== letter.toLowerCase();
}

function isLower(letter: string): boolean {
  return letter !== letter.toUpperCase();
}

function isDigit(letter: string): boolean {
  return letter >= "0" && letter <= "9";
}

/**
 * Split a page into its four fields: the path without `.md`, the title (the
 * frontmatter `title` or the first level-1 heading), the other headings plus
 * the frontmatter `description`, and the remaining text. Headings are ATX
 * (`## Text`) or setext (a paragraph underlined with `===` or `---`). A `---`
 * after a blank line, a list item, or a heading is a thematic break, and the
 * frontmatter fences are never headings. Headings inside fenced code are body
 * text.
 */
function pageFields(page: DocumentationIndexPage): [string, string, string, string] {
  let lines = page.text.split(/\r?\n/u);
  let title: string | null = null;
  const headings: string[] = [];
  const body: string[] = [];
  if (lines[0]?.trim() === "---") {
    const close = lines.slice(1).findIndex((line) => line.trim() === "---");
    if (close >= 0) {
      for (const line of lines.slice(1, close + 1)) {
        const field = /^(title|description):[ \t]*(.*)$/u.exec(line);
        if (!field) continue;
        const value = field[2]!.trim().replace(/^(["'])(.*)\1$/u, "$2");
        if (field[1] === "title" && value && title === null) title = value;
        else if (value) headings.push(value);
      }
      lines = lines.slice(close + 2);
    }
  }
  const heading = (level: number, text: string): void => {
    if (level === 1 && title === null) title = text;
    else headings.push(text);
  };
  // The open paragraph's lines, held back until it ends: an underline turns
  // them into a heading instead of body text.
  let paragraph: string[] = [];
  const endParagraph = (): void => {
    body.push(...paragraph);
    paragraph = [];
  };
  let fenced = false;
  // Inside a list item or block quote until the next blank line: its text
  // continues that block, so an underline below it is a thematic break.
  let inBlock = false;
  for (const line of lines) {
    if (FENCE.test(line)) {
      endParagraph();
      fenced = !fenced;
      body.push(line);
      continue;
    }
    if (fenced) {
      body.push(line);
      continue;
    }
    const atx = atxHeading(line);
    if (atx) {
      endParagraph();
      heading(atx.level, atx.text);
      continue;
    }
    if (paragraph.length > 0 && SETEXT_UNDERLINE.test(line)) {
      heading(line.trim().startsWith("=") ? 1 : 2, paragraph.map((text) => text.trim()).join(" "));
      paragraph = [];
      continue;
    }
    const blank = line.trim() === "";
    if (blank || inBlock || THEMATIC_BREAK.test(line) || BLOCK_START.test(line)) {
      endParagraph();
      inBlock = !blank && (inBlock || BLOCK_START.test(line));
      body.push(line);
      continue;
    }
    paragraph.push(line);
  }
  endParagraph();
  return [page.path.replace(/\.md$/u, ""), title ?? "", headings.join("\n"), body.join("\n")];
}

/** An ATX heading (`## Text ##`): up to three spaces, one to six `#`, then a space or the end. */
function atxHeading(line: string): { readonly level: number; readonly text: string } | null {
  let offset = 0;
  while (offset < 3 && line[offset] === " ") offset += 1;
  let level = 0;
  while (line[offset + level] === "#") level += 1;
  const after = line[offset + level];
  if (level < 1 || level > 6 || (after !== undefined && after !== " " && after !== "\t")) {
    return null;
  }
  let text = line.slice(offset + level).trim();
  let end = text.length;
  while (end > 0 && text[end - 1] === "#") end -= 1;
  // A closing run of `#` counts only after whitespace, or as the whole text.
  if (end < text.length && (end === 0 || text[end - 1] === " " || text[end - 1] === "\t")) {
    text = text.slice(0, end).trim();
  }
  return { level, text };
}

/**
 * Directory names that hold test data: fixture repositories, recorded inputs,
 * snapshots, and corpora a test or an evaluation reads. Matched
 * case-insensitively against every directory in a page's path.
 */
const TEST_DATA_DIRECTORIES: ReadonlySet<string> = new Set([
  "fixture",
  "fixtures",
  "__fixtures__",
  "test-fixtures",
  "test_fixtures",
  "testdata",
  "__tests__",
  "__snapshots__",
  "corpus",
  "corpora",
]);

/** Benchmark case trees: each case's repository, its inputs, and canary cases. */
const BENCHMARK_CASE_DIRECTORIES: ReadonlySet<string> = new Set([
  "cases",
  "repository",
  "canaries",
]);

/** The pages that describe a benchmark directory rather than feed it. */
const BENCHMARK_GUIDE_PAGES: ReadonlySet<string> = new Set(["readme.md", "agents.md"]);

/**
 * Whether a tracked Markdown page belongs to the project's documentation set,
 * the pages a question without `target=` is answered from (#2400). The set is
 * every tracked Markdown page except test data and benchmark inputs:
 *
 * - Nothing inside a test-data directory (`fixture`, `fixtures`,
 *   `__fixtures__`, `test-fixtures`, `test_fixtures`, `testdata`, `__tests__`,
 *   `__snapshots__`, `corpus`, or `corpora`, at any depth).
 * - Below a `benchmarks` directory, nothing inside a `cases`, `repository`, or
 *   `canaries` directory, and otherwise only `README.md`, `AGENTS.md`, and the
 *   pages directly in a `reports` directory. The rest there are prompts,
 *   rubrics, oracles, evaluation inputs, and the outputs a run delivered.
 *
 * Such a page imitates documentation for a tool to read: on DocsFab's own
 * repository, benchmark case-repository pages filled the top four places for
 * a vague follow-up (2026-10-15). A test directory keeps its other pages,
 * because test data lives in the directories above: DocsFab's `test/` pages
 * outside them are a proof runbook, its report, and a test contract. Page
 * templates, planning, design, and runbook pages stay too; the preference
 * for declared roots and canonical pages ranks the pages a template imitates
 * ahead of it.
 *
 * The project's `documentationRoots` in `.docsfab.json` is not this set: it
 * names the roots a local run may write, and DocsFab's is only `docs`, which
 * would leave out README.md, the product reference model, the deploy
 * runbooks, and every package's own documentation.
 *
 * A question that names an excluded page by its exact path still gets it.
 */
export function isDocumentationSetPage(path: string): boolean {
  const parts = path.split("/");
  const directories = parts.slice(0, -1).map((directory) => directory.toLowerCase());
  if (directories.some((directory) => TEST_DATA_DIRECTORIES.has(directory))) return false;
  const benchmarks = directories.indexOf("benchmarks");
  if (benchmarks === -1) return true;
  const below = directories.slice(benchmarks + 1);
  if (below.some((directory) => BENCHMARK_CASE_DIRECTORIES.has(directory))) return false;
  return BENCHMARK_GUIDE_PAGES.has(parts.at(-1)!.toLowerCase()) || below.at(-1) === "reports";
}

/** Top-level directories where a forge looks for repository process pages. */
const FORGE_DIRECTORIES: ReadonlySet<string> = new Set([".gitlab", ".github"]);

/**
 * The repository's own front pages: every top-level page, such as README.md,
 * AGENTS.md, and CONTRIBUTING.md, and the README.md of a top-level forge
 * directory, `.gitlab/` or `.github/`. They rank like the declared
 * documentation roots.
 */
export function isCanonicalRepositoryPage(path: string): boolean {
  const parts = path.split("/");
  return (
    parts.length === 1 ||
    (parts.length === 2 && FORGE_DIRECTORIES.has(parts[0]!) && parts[1] === "README.md")
  );
}

/**
 * Porter's 1980 suffix-stripping stemmer, for lowercase ASCII words. It maps
 * inflected forms to one stem: `configure`, `configured`, and `configuration`
 * all become `configur`.
 */
export function porterStem(word: string): string {
  if (word.length <= 2) return word;
  let stem = word;
  // Step 1a: plurals.
  if (stem.endsWith("sses")) stem = stem.slice(0, -2);
  else if (stem.endsWith("ies")) stem = stem.slice(0, -2);
  else if (!stem.endsWith("ss") && stem.endsWith("s")) stem = stem.slice(0, -1);
  // Step 1b: past tense and progressive.
  let extend = false;
  if (stem.endsWith("eed")) {
    if (measure(stem.slice(0, -3)) > 0) stem = stem.slice(0, -1);
  } else if (stem.endsWith("ed") && hasVowel(stem.slice(0, -2))) {
    stem = stem.slice(0, -2);
    extend = true;
  } else if (stem.endsWith("ing") && hasVowel(stem.slice(0, -3))) {
    stem = stem.slice(0, -3);
    extend = true;
  }
  if (extend) {
    if (stem.endsWith("at") || stem.endsWith("bl") || stem.endsWith("iz")) stem += "e";
    else if (endsWithDoubleConsonant(stem) && !/[lsz]$/u.test(stem)) stem = stem.slice(0, -1);
    else if (measure(stem) === 1 && endsConsonantVowelConsonant(stem)) stem += "e";
  }
  // Step 1c: a final y after a vowel-bearing stem.
  if (stem.endsWith("y") && hasVowel(stem.slice(0, -1))) stem = `${stem.slice(0, -1)}i`;
  stem = replaceSuffix(stem, STEP_2);
  stem = replaceSuffix(stem, STEP_3);
  // Step 4: residual suffixes, removed only from a long stem.
  for (const suffix of STEP_4) {
    if (!stem.endsWith(suffix)) continue;
    const base = stem.slice(0, -suffix.length);
    if (suffix === "ion" && !/[st]$/u.test(base)) break;
    if (measure(base) > 1) stem = base;
    break;
  }
  // Step 5: a final e, and a double l.
  if (stem.endsWith("e")) {
    const base = stem.slice(0, -1);
    const size = measure(base);
    if (size > 1 || (size === 1 && !endsConsonantVowelConsonant(base))) stem = base;
  }
  if (stem.endsWith("ll") && measure(stem) > 1) stem = stem.slice(0, -1);
  return stem;
}

type SuffixRule = readonly [suffix: string, replacement: string];

/** Longest suffix first: a step applies only its longest matching rule. */
function longestFirst(rules: readonly SuffixRule[]): readonly SuffixRule[] {
  return [...rules].sort((left, right) => right[0].length - left[0].length);
}

/** Step 2 and step 3 rules, applied when the stem's measure exceeds 0. */
const STEP_2 = longestFirst([
  ["ational", "ate"],
  ["tional", "tion"],
  ["enci", "ence"],
  ["anci", "ance"],
  ["izer", "ize"],
  ["abli", "able"],
  ["alli", "al"],
  ["entli", "ent"],
  ["eli", "e"],
  ["ousli", "ous"],
  ["ization", "ize"],
  ["ation", "ate"],
  ["ator", "ate"],
  ["alism", "al"],
  ["iveness", "ive"],
  ["fulness", "ful"],
  ["ousness", "ous"],
  ["aliti", "al"],
  ["iviti", "ive"],
  ["biliti", "ble"],
]);

const STEP_3 = longestFirst([
  ["icate", "ic"],
  ["ative", ""],
  ["alize", "al"],
  ["iciti", "ic"],
  ["ical", "ic"],
  ["ful", ""],
  ["ness", ""],
]);

const STEP_4: readonly string[] = [
  "al",
  "ance",
  "ence",
  "er",
  "ic",
  "able",
  "ible",
  "ant",
  "ement",
  "ment",
  "ent",
  "ion",
  "ou",
  "ism",
  "ate",
  "iti",
  "ous",
  "ive",
  "ize",
].sort((left, right) => right.length - left.length);

/** Only the longest matching rule applies; when its condition fails, the step does nothing. */
function replaceSuffix(stem: string, rules: readonly SuffixRule[]): string {
  for (const [suffix, replacement] of rules) {
    if (!stem.endsWith(suffix)) continue;
    const base = stem.slice(0, -suffix.length);
    return measure(base) > 0 ? base + replacement : stem;
  }
  return stem;
}

/**
 * Whether each letter is a consonant: a letter other than a vowel, and other
 * than a y after a consonant. Computed in one pass, never recursively, so a
 * long run of `y` cannot exhaust the stack.
 */
function consonants(word: string): boolean[] {
  const result: boolean[] = [];
  for (let index = 0; index < word.length; index += 1) {
    const letter = word[index]!;
    result.push(
      "aeiou".includes(letter) ? false : letter === "y" ? index === 0 || !result[index - 1] : true,
    );
  }
  return result;
}

/** The number of vowel-consonant sequences in [C](VC)^m[V]. */
function measure(word: string): number {
  let count = 0;
  let previousVowel = false;
  for (const consonant of consonants(word)) {
    if (consonant && previousVowel) count += 1;
    previousVowel = !consonant;
  }
  return count;
}

function hasVowel(word: string): boolean {
  return consonants(word).includes(false);
}

function endsWithDoubleConsonant(word: string): boolean {
  const last = word.length - 1;
  return last > 0 && word[last] === word[last - 1] && consonants(word)[last] === true;
}

/** Ends consonant-vowel-consonant, where the final consonant is not w, x, or y. */
function endsConsonantVowelConsonant(word: string): boolean {
  const last = word.length - 1;
  if (last < 2 || "wxy".includes(word[last]!)) return false;
  const kinds = consonants(word);
  return kinds[last - 2] === true && kinds[last - 1] === false && kinds[last] === true;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
