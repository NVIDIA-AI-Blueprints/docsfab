// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Host-minted source citations.
 *
 * A model cites evidence by location only: a tracked repository path and the
 * first and last physical line it read. The host copies the exact text of those
 * lines into the admitted artifact, so a quotation is exact by construction and
 * quote fidelity can never fail a step. The model never reproduces source text.
 *
 * Line coordinates are the LF-delimited segments of the file's bytes, counted
 * from 1, as the confined `read` tool numbers them under `source-coordinates`
 * rendering (`renderSourceCoordinates`) and as the read tool's line totals
 * count them. A CRLF line ends before its CR. A file that ends with LF has one
 * more, empty, line after it, which the rendering shows no prefix for but a
 * context-packet section range can end on; an empty file has no lines.
 *
 * Content-IR section ranges count the same lines for every file this module
 * mints from. It also breaks lines at a lone CR, which the read tool does not,
 * so a file with a CR not followed by LF has no one numbering and is refused
 * as unreadable text, as is a file holding a NUL byte, which is binary and
 * which no admitted artifact may carry.
 *
 * Every refusal is a rule of the `source-citation` catalog family
 * (`config/model-output/rules/source-citation.yaml`). This module owns the
 * decoding, the minting, and every refusal; callers only supply the bytes they
 * read through their own tracked reader.
 */

import { limit, formatLimitObservation } from "../config/limits.js";
import {
  OUTPUT_RULE_FAMILIES,
  OUTPUT_RULES,
  isModelCorrectableOutputRule,
  rejectCorrectable,
  renderOutputText,
  type OutputRuleRejection,
  type RuleCodeOf,
} from "../contracts/model-output.js";
import { InferenceStepError } from "../execution/contracts.js";

export interface SourceCitationLocatorV1 {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
}

/** A citation as admitted: the model's locator and the host-minted quote. */
export interface MintedSourceCitationV1 extends SourceCitationLocatorV1 {
  readonly quote: string;
}

/** Where a contract keeps its citation items, and the array they total over. */
export type SourceCitationLocations =
  | { readonly item: "$.criteria[].citations[]"; readonly total: "$.criteria" }
  | { readonly item: "$.evidence[]"; readonly total: "$.evidence" };

/**
 * One cited file as the caller's tracked reader found it: its bytes, or why
 * it has none. `unreadable` covers a file over the reader's ceiling.
 */
export type SourceCitationSource = Uint8Array | "untracked" | "unreadable";

/**
 * Lines the model was shown in one attempt, per repository-relative path, as
 * sorted, disjoint, inclusive `[first, last]` ranges. Host-internal and never
 * persisted; JSON-safe so it survives any result copy.
 */
export type ObservedSourceLinesV1 = Readonly<
  Record<string, readonly (readonly [number, number])[]>
>;

export type SourceCitationRuleCode = RuleCodeOf<"source-citation">;

export const SOURCE_CITATION_LOCATOR_KEYS = ["path", "startLine", "endLine"] as const;

/**
 * The model-facing citation sentences: every rule of the family, in catalog
 * order, rendered from the catalog so the prompt, the retry hint, and the
 * validator state one rule.
 */
export function sourceCitationContractText(): string {
  return OUTPUT_RULE_FAMILIES["source-citation"].codes
    .map((code) => renderOutputText(OUTPUT_RULES[code].statement ?? ""))
    .join(" ");
}

/** A citation the host refused, with the catalog rule and contract location. */
export class SourceCitationRefusal extends Error {
  public constructor(
    readonly rejection: OutputRuleRejection<SourceCitationRuleCode>,
    detail?: string,
  ) {
    super(detail ?? `Source citation rejected: ${rejection.code}.`);
    this.name = "SourceCitationRefusal";
  }

  public get code(): SourceCitationRuleCode {
    return this.rejection.code;
  }
}

function refuse(code: SourceCitationRuleCode, location: string, detail?: string): never {
  throw new SourceCitationRefusal(
    rejectCorrectable("source-citation", code, location as never),
    detail,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLineNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

/** A repository-relative path the trackers can key: no root, traversal, or control text. */
function isRepositoryRelativePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    // Control characters are never part of a tracked path the host reports.
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u001f\u007f]/u.test(value) &&
    value.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}

/** Decode one model citation item; anything but the exact locator is refused. */
export function decodeSourceCitationLocator(
  value: unknown,
  at: SourceCitationLocations,
): SourceCitationLocatorV1 {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== SOURCE_CITATION_LOCATOR_KEYS.length ||
    !SOURCE_CITATION_LOCATOR_KEYS.every((key) => Object.hasOwn(value, key)) ||
    !isRepositoryRelativePath(value.path) ||
    !isLineNumber(value.startLine) ||
    !isLineNumber(value.endLine) ||
    value.endLine < value.startLine
  ) {
    refuse("source-citation-locator-shape", at.item);
  }
  return Object.freeze({
    path: value.path as string,
    startLine: value.startLine as number,
    endLine: value.endLine as number,
  });
}

/** Distinct cited paths, in first-cited order, for the caller's reader. */
export function sourceCitationPaths(locators: readonly SourceCitationLocatorV1[]): string[] {
  return [...new Set(locators.map((locator) => locator.path))];
}

interface PhysicalLine {
  readonly start: number;
  /** End of the line's content: before its LF, and before a CR that precedes it. */
  readonly end: number;
}

/**
 * The file's citation lines: every LF-delimited segment,
 * including the empty one after a final LF. Each line's content ends before
 * its LF and before a CR that precedes that LF.
 */
export function physicalLines(text: string): PhysicalLine[] {
  if (text === "") return [];
  const lines: PhysicalLine[] = [];
  let start = 0;
  for (;;) {
    const feed = text.indexOf("\n", start);
    if (feed === -1) {
      lines.push({ start, end: text.length });
      return lines;
    }
    lines.push({
      start,
      end: feed > start && text[feed - 1] === "\r" ? feed - 1 : feed,
    });
    start = feed + 1;
  }
}

/**
 * The file as citable text: exact UTF-8 with LF or CRLF line breaks and no NUL
 * byte; anything else is `undefined` (see the module comment).
 */
function decodeText(bytes: Uint8Array): string | undefined {
  let text: string;
  try {
    // ignoreBOM keeps a leading U+FEFF, so the text is the file's exact bytes
    // and line 1 mints the same quote whichever step cites it.
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
  return text.includes("\0") || /\r(?!\n)/u.test(text) ? undefined : text;
}

function isObserved(
  observed: ObservedSourceLinesV1 | undefined,
  locator: SourceCitationLocatorV1,
): boolean {
  const ranges = observed && Object.hasOwn(observed, locator.path) ? observed[locator.path] : [];
  let next = locator.startLine;
  for (const [first, last] of ranges ?? []) {
    if (first > next) break;
    if (last >= next) next = last + 1;
    if (next > locator.endLine) return true;
  }
  return false;
}

/**
 * Mint the exact quote for each locator from the caller's file bytes.
 *
 * Refusals, in order per citation: the path is not a tracked regular file; it
 * is not readable UTF-8 text; `endLine` is past the last line; a cited line
 * was not shown to the model this attempt (an absent ledger shows nothing);
 * the span is whitespace only. Then the minted total is bounded by
 * `sourceCitation.mintedMaxChars`.
 */
export function mintSourceCitations(
  locators: readonly SourceCitationLocatorV1[],
  sources: ReadonlyMap<string, SourceCitationSource>,
  observed: ObservedSourceLinesV1 | undefined,
  at: SourceCitationLocations,
): MintedSourceCitationV1[] {
  const texts = new Map<string, { text: string; lines: PhysicalLine[] }>();
  const minted: MintedSourceCitationV1[] = [];
  let total = 0;
  for (const locator of locators) {
    let file = texts.get(locator.path);
    if (!file) {
      const source = sources.get(locator.path);
      if (source === undefined || source === "untracked") {
        refuse("source-citation-untracked-path", at.item);
      }
      const text = source === "unreadable" ? undefined : decodeText(source);
      if (text === undefined) refuse("source-citation-unreadable-text", at.item);
      file = { text, lines: physicalLines(text) };
      texts.set(locator.path, file);
    }
    if (locator.endLine > file.lines.length) refuse("source-citation-line-range", at.item);
    if (!isObserved(observed, locator)) refuse("source-citation-unobserved", at.item);
    const quote = file.text.slice(
      file.lines[locator.startLine - 1]!.start,
      file.lines[locator.endLine - 1]!.end,
    );
    if (!quote.trim()) refuse("source-citation-blank-span", at.item);
    total += quote.length;
    minted.push(Object.freeze({ ...locator, quote }));
  }
  const bound = limit("sourceCitation.mintedMaxChars");
  if (total > bound.value) {
    refuse(
      "source-citation-minted-max-chars-bound",
      at.total,
      `${formatLimitObservation(bound, total)} Scope: the cited lines of one admitted artifact.`,
    );
  }
  return minted;
}

/**
 * Re-mint an admitted citation and report whether its recorded quote is still
 * exactly the cited lines. An integrity check of a host artifact, not a model
 * rule: the caller decides the code.
 */
export function mintedSourceCitationHolds(
  citation: MintedSourceCitationV1,
  source: SourceCitationSource,
): boolean {
  if (source === "untracked" || source === "unreadable") return false;
  const text = decodeText(source);
  if (text === undefined) return false;
  const lines = physicalLines(text);
  if (citation.startLine < 1 || citation.endLine > lines.length) return false;
  if (citation.endLine < citation.startLine) return false;
  return (
    text.slice(lines[citation.startLine - 1]!.start, lines[citation.endLine - 1]!.end) ===
    citation.quote
  );
}

/** The step error for a refused citation; retryability comes from the catalog. */
export function sourceCitationStepError(
  refusal: SourceCitationRefusal,
  prefix: string,
  evidence?: ConstructorParameters<typeof InferenceStepError>[3],
): InferenceStepError {
  return new InferenceStepError(
    `${prefix} ${refusal.message}`,
    "malformed-response",
    isModelCorrectableOutputRule(refusal.rejection.code),
    evidence,
    refusal.rejection,
  );
}

/**
 * Merge one more shown line range into a path's sorted, disjoint ranges.
 * The ledger's only writer, so its ranges stay canonical.
 */
export function addObservedLines(
  ledger: Map<string, [number, number][]>,
  path: string,
  first: number,
  last: number,
): void {
  const merged: [number, number][] = [];
  let range: [number, number] = [first, last];
  for (const current of ledger.get(path) ?? []) {
    if (current[1] + 1 < range[0] || range[1] + 1 < current[0]) merged.push(current);
    else range = [Math.min(current[0], range[0]), Math.max(current[1], range[1])];
  }
  merged.push(range);
  merged.sort((left, right) => left[0] - right[0]);
  ledger.set(path, merged);
}

/** A frozen, JSON-safe copy of a ledger. */
export function snapshotObservedLines(
  ledger: ReadonlyMap<string, readonly [number, number][]>,
): ObservedSourceLinesV1 {
  return Object.freeze(
    Object.fromEntries(
      [...ledger].map(([path, ranges]) => [
        path,
        Object.freeze(ranges.map((range) => Object.freeze([range[0], range[1]] as const))),
      ]),
    ),
  );
}
