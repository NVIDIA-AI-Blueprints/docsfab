// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-call output cap for the model-facing read-only filesystem tools, plus a
 * per-tool-set archive that keeps each capped original recoverable by handle.
 *
 * Pi's `read` truncation is not configurable through `ReadToolOptions`, so a few
 * whole-file reads could exhaust the input budget. The cap is not part of any
 * sealed composition: `toolPolicySha256` covers tool names only. The archive
 * refuses past `toolOutput.archiveCeilingBytes`, never evicts, and fails closed
 * on credential-shaped text before retaining a byte.
 */
import { createHash } from "node:crypto";

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import {
  formatLimitObservation,
  limit,
  type ResolveLimitsOptions,
  type ResolvedLimit,
} from "../config/limits.js";
import type {
  ToolFailureCategory,
  ToolResultArchiveReceiptV1,
  ToolResultArchiveRefusalV1,
  ToolResultArchiveSnapshotV1,
  ToolResultRecallReceiptV1,
} from "../records/contracts.js";
import { assertConfinedToolResultCredentialFree } from "../security/credential-isolation.js";

type AnyToolDefinition = ToolDefinition<any, any, any>;

/**
 * Default per-call payload cap in bytes. Round trips against the job deadline,
 * not tokens, are the binding cost, so it fits most docs files in one call while
 * staying below Pi's 50 KB default.
 */
export const DEFAULT_TOOL_OUTPUT_CAP_BYTES = 32_768;

/** Mirrors FILESYSTEM_READ_ONLY_TOOLS. */
export const OUTPUT_CAPPED_TOOL_NAMES = ["read", "grep", "find", "ls"] as const;

/** Host-owned override for the per-call cap. Never a composition input. */
export const TOOL_OUTPUT_CAP_ENVIRONMENT_VARIABLE = "DOCSFAB_TOOL_OUTPUT_CAP_BYTES";
export const MINIMUM_TOOL_OUTPUT_CAP_BYTES = 1024;
export const MAXIMUM_TOOL_OUTPUT_CAP_BYTES = 262_144;

export const TOOL_RESULT_RECALL_TOOL_NAME = "docsfab_recall_tool_result" as const;

/** Declared in `config/limits/toolOutput.yaml`. */
export const TOOL_RESULT_ARCHIVE_CEILING_LIMIT = "toolOutput.archiveCeilingBytes" as const;
export const TOOL_RESULT_RECALL_PAGE_LIMIT = "toolOutput.recallPageBytes" as const;
export const TOOL_RESULT_EXCERPT_TAIL_LIMIT = "toolOutput.excerptTailBytes" as const;

const OFFSET_CONTINUABLE_TOOLS = new Set<string>(["read"]);

const MARKER_PREFIX = "docsfab-output-cap";
const RECALL_MARKER_PREFIX = "docsfab-recall";
const ARCHIVE_HANDLE_PREFIX = "docsfab-tr-";
/** Hex characters of the digest a handle carries; a prefix collision fails closed. */
const ARCHIVE_HANDLE_DIGEST_CHARACTERS = 16;

export interface ToolOutputCapResult {
  /** Payload actually returned to the model, never longer than the cap. */
  text: string;
  truncated: boolean;
  returnedBytes: number;
  totalBytes: number;
  /** Complete lines in the returned payload; 0 when a single line exceeded the cap. */
  returnedLines: number;
}

/** Tail of an archived result shown after the marker. Offsets are zero-indexed. */
export interface ToolOutputTail {
  text: string;
  startByte: number;
  /** Exclusive. */
  endByte: number;
}

export function assertValidToolOutputCapBytes(capBytes: number): void {
  if (!Number.isSafeInteger(capBytes) || capBytes < 1) {
    throw new Error("Tool output cap must be a positive safe integer number of bytes.");
  }
}

/**
 * Resolve the host-owned cap. An out-of-range or unparsable setting fails
 * closed rather than silently reverting to the default.
 */
export function resolveToolOutputCapBytes(environment: NodeJS.ProcessEnv = process.env): number {
  const raw = environment[TOOL_OUTPUT_CAP_ENVIRONMENT_VARIABLE]?.trim();
  if (!raw) return DEFAULT_TOOL_OUTPUT_CAP_BYTES;
  const value = Number(raw);
  if (
    !Number.isSafeInteger(value) ||
    value < MINIMUM_TOOL_OUTPUT_CAP_BYTES ||
    value > MAXIMUM_TOOL_OUTPUT_CAP_BYTES
  ) {
    throw new Error(
      `${TOOL_OUTPUT_CAP_ENVIRONMENT_VARIABLE} must be an integer between ` +
        `${MINIMUM_TOOL_OUTPUT_CAP_BYTES} and ${MAXIMUM_TOOL_OUTPUT_CAP_BYTES}.`,
    );
  }
  return value;
}

export interface ToolResultArchiveLimits {
  readonly ceiling: ResolvedLimit;
  readonly page: ResolvedLimit;
  readonly tail: ResolvedLimit;
}

/**
 * Resolve the archive limits when the tool set is built, so an out-of-range host
 * override fails there rather than on the first oversized result.
 */
export function resolveToolResultArchiveLimits(
  options?: ResolveLimitsOptions,
): ToolResultArchiveLimits {
  return {
    ceiling: limit(TOOL_RESULT_ARCHIVE_CEILING_LIMIT, options),
    page: limit(TOOL_RESULT_RECALL_PAGE_LIMIT, options),
    tail: limit(TOOL_RESULT_EXCERPT_TAIL_LIMIT, options),
  };
}

export type ToolResultArchiveOutcome =
  | { readonly receipt: ToolResultArchiveReceiptV1 }
  | { readonly refusal: string };

export interface ToolResultRecallRequest {
  readonly handle: string;
  /** Zero-indexed first byte; defaults to 0. */
  readonly byteOffset?: number;
  /** Bytes to return; defaults to, and may not exceed, the recall page size. */
  readonly byteLength?: number;
}

export interface ToolResultRecallPage {
  readonly receipt: ToolResultArchiveReceiptV1;
  /** Zero-indexed first byte returned. */
  readonly start: number;
  /** Zero-indexed exclusive end of the bytes returned. */
  readonly end: number;
  readonly text: string;
}

/** A recall the archive refused; `category` feeds the tool failure record. */
export class ToolResultRecallError extends Error {
  public constructor(
    message: string,
    public readonly category: ToolFailureCategory,
  ) {
    super(message);
    this.name = "ToolResultRecallError";
  }
}

/**
 * Exact originals of oversized tool results for one confined tool set.
 * Identical results share one entry. A result that would carry the stored total
 * past the ceiling is refused; no older entry is ever dropped to make room.
 */
export class ToolResultArchive {
  private readonly entries = new Map<
    string,
    { readonly receipt: ToolResultArchiveReceiptV1; readonly bytes: Buffer }
  >();
  private readonly refusals: ToolResultArchiveRefusalV1[] = [];
  private storedBytes = 0;

  public constructor(public readonly limits: ToolResultArchiveLimits) {}

  /** Archive `text` whole, or refuse at the ceiling. Credential-shaped text throws. */
  public archive(toolName: string, text: string): ToolResultArchiveOutcome {
    // Must run before any byte is retained.
    assertConfinedToolResultCredentialFree(text);
    const bytes = Buffer.from(text, "utf8");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const handle = `${ARCHIVE_HANDLE_PREFIX}${sha256.slice(0, ARCHIVE_HANDLE_DIGEST_CHARACTERS)}`;
    const existing = this.entries.get(handle);
    if (existing) {
      if (existing.receipt.sha256 !== sha256) {
        throw new Error(
          "DocsFab refused two different tool results that share one archive handle.",
        );
      }
      return { receipt: existing.receipt };
    }
    const observed = this.storedBytes + bytes.byteLength;
    if (observed > this.limits.ceiling.value) {
      this.refusals.push({
        limitName: this.limits.ceiling.name,
        observedBytes: observed,
      });
      return { refusal: formatLimitObservation(this.limits.ceiling, observed) };
    }
    const receipt: ToolResultArchiveReceiptV1 = {
      schemaVersion: 1,
      kind: "docsfab-tool-result-archive",
      handle,
      sha256,
      toolName,
      totalBytes: bytes.byteLength,
    };
    this.entries.set(handle, { receipt, bytes });
    this.storedBytes = observed;
    return { receipt };
  }

  /**
   * Return an exact byte range of an archived original without splitting a
   * UTF-8 code point: the start moves back to its code point's first byte and
   * the end pulls back to fit `byteLength`. A `byteLength` too small for the
   * code point at the start is refused rather than exceeded.
   */
  public recall(request: ToolResultRecallRequest): ToolResultRecallPage {
    const entry = this.entries.get(request.handle);
    if (!entry) {
      throw new ToolResultRecallError(
        "DocsFab has no archived tool result with that handle in this step. Use a handle named by a docsfab-output-cap notice.",
        "expected-missing-probe",
      );
    }
    const { bytes, receipt } = entry;
    const total = bytes.byteLength;
    const byteOffset = request.byteOffset ?? 0;
    if (byteOffset >= total) {
      throw new ToolResultRecallError(
        `DocsFab recall byteOffset ${byteOffset} is at or past the end of the archived result (${total} bytes).`,
        "expected-missing-probe",
      );
    }
    const length = request.byteLength ?? this.limits.page.value;
    if (length > this.limits.page.value) {
      throw new ToolResultRecallError(
        formatLimitObservation(this.limits.page, length),
        "unsupported-pattern",
      );
    }
    let start = byteOffset;
    while (start > 0 && isUtf8Continuation(bytes[start]!)) start -= 1;
    const codePointEnd = utf8CodePointEnd(bytes, start);
    const codePointBytes = codePointEnd - start;
    if (codePointBytes > length) {
      throw new ToolResultRecallError(
        `DocsFab recall cannot return a whole UTF-8 code point at byteOffset ${start} within ${length} bytes (the code point is ${codePointBytes} bytes).`,
        "unsupported-pattern",
      );
    }
    let end = Math.min(start + length, total);
    while (end > start && end < total && isUtf8Continuation(bytes[end]!)) end -= 1;
    return {
      receipt,
      start,
      end,
      text: bytes.subarray(start, end).toString("utf8"),
    };
  }

  /** Content-free state for evidence and tests. */
  public snapshot(): ToolResultArchiveSnapshotV1 {
    return {
      receipts: [...this.entries.values()].map((entry) => ({
        ...entry.receipt,
      })),
      storedBytes: this.storedBytes,
      ceilingBytes: this.limits.ceiling.value,
      refusals: this.refusals.map((refusal) => ({ ...refusal })),
    };
  }
}

/**
 * Cut `text` to at most `capBytes` UTF-8 bytes on a code-point boundary, pulled
 * back to the last newline when there is one. A single line longer than the cap
 * returns a code-point-safe prefix rather than nothing.
 */
export function capToolOutputText(text: string, capBytes: number): ToolOutputCapResult {
  assertValidToolOutputCapBytes(capBytes);
  const buffer = Buffer.from(text, "utf8");
  const totalBytes = buffer.byteLength;
  if (totalBytes <= capBytes) {
    return {
      text,
      truncated: false,
      returnedBytes: totalBytes,
      totalBytes,
      returnedLines: linesReturned(text),
    };
  }
  const safePrefix = codePointSafePrefix(buffer, capBytes);
  const lastNewline = safePrefix.lastIndexOf("\n");
  if (lastNewline >= 0) {
    const cut = safePrefix.slice(0, lastNewline + 1);
    return {
      text: cut,
      truncated: true,
      returnedBytes: Buffer.byteLength(cut, "utf8"),
      totalBytes,
      returnedLines: countCompleteLines(cut),
    };
  }
  // When the very next byte is the newline, the whole line fit and only its
  // terminator was cut. Counting it as one line lets the offset advance;
  // zero would stall paging on that line forever.
  const wholeLine = buffer[Buffer.byteLength(safePrefix, "utf8")] === 0x0a;
  return {
    text: safePrefix,
    truncated: true,
    returnedBytes: Buffer.byteLength(safePrefix, "utf8"),
    totalBytes,
    returnedLines: wholeLine ? 1 : 0,
  };
}

/**
 * The last whole lines of `source` that fit `budget` bytes and start at or after
 * `floor` (the end of the head). A final line longer than the window returns a
 * code-point-safe suffix instead.
 */
export function toolOutputTail(
  source: Buffer,
  budget: number,
  floor: number,
): ToolOutputTail | undefined {
  const end = source.byteLength;
  if (budget < 1 || end <= floor) return undefined;
  let start = Math.max(floor, end - budget);
  while (start < end && isUtf8Continuation(source[start]!)) start += 1;
  if (start > floor && source[start - 1] !== 0x0a) {
    const newline = source.indexOf(0x0a, start);
    if (newline >= 0 && newline + 1 < end) start = newline + 1;
  }
  if (start >= end) return undefined;
  return {
    text: source.subarray(start).toString("utf8"),
    startByte: start,
    endByte: end,
  };
}

/**
 * Model-visible truncation notice: the byte ranges returned, the cap, and how to
 * get the rest (continuation offset, archive handle and digest, or refusal).
 */
export function toolOutputCapMarker(input: {
  toolName: string;
  capBytes: number;
  result: ToolOutputCapResult;
  /** 1-indexed first line of the payload, for offset-continuable tools. */
  startLine?: number;
  /**
   * Bytes the tool produced for this call, when larger than the region the cap
   * measured. When omitted, a block cut only to fit the notice reports "1-N of N".
   */
  totalBytes?: number;
  /** Handle and digest of the archived original, when the archive accepted it. */
  archive?: { handle: string; sha256: string };
  /** Tail shown after the marker, as zero-indexed offsets into the original. */
  tail?: { startByte: number; endByte: number };
  /** Coded limit refusal when the archive declined the original. */
  refusal?: string;
}): string {
  const { toolName, capBytes, result, tail } = input;
  const total = Math.max(input.totalBytes ?? 0, result.totalBytes);
  const range = tail
    ? `bytes 1-${result.returnedBytes} and ${tail.startByte + 1}-${tail.endByte} of ${total}`
    : `bytes 1-${result.returnedBytes} of ${total}`;
  const sentences = [
    `[${MARKER_PREFIX} ${toolName}: returned ${range} (cap ${capBytes} bytes).`,
    continuationSentence(toolName, result, input.startLine),
  ];
  if (input.archive) {
    const omittedEnd = tail ? tail.startByte : total;
    sentences.push(
      `Full result archived as handle=${input.archive.handle} (sha256 ${input.archive.sha256}); ` +
        `call ${TOOL_RESULT_RECALL_TOOL_NAME} with that handle and byteOffset=${result.returnedBytes} ` +
        `for the omitted bytes ${result.returnedBytes + 1}-${omittedEnd} without running this tool again.`,
    );
  }
  if (tail) {
    sentences.push(`The tail (bytes ${tail.startByte + 1}-${tail.endByte}) follows this notice.`);
  }
  if (input.refusal) sentences.push(`The full result was not archived: ${input.refusal}`);
  return `${sentences.join(" ")}]`;
}

function continuationSentence(
  toolName: string,
  result: ToolOutputCapResult,
  startLine: number | undefined,
): string {
  if (!OFFSET_CONTINUABLE_TOOLS.has(toolName)) {
    return "Narrow the request (path, pattern, glob, or limit) and call again; this tool has no continuation offset.";
  }
  if (result.returnedLines === 0) {
    return `Line ${startLine ?? 1} alone exceeds the cap, so offset cannot advance; use grep to select the part you need.`;
  }
  const nextOffset = (startLine ?? 1) + result.returnedLines;
  return `Continue with offset=${nextOffset} (1-indexed line) and an explicit limit, or read a narrower range.`;
}

/**
 * Pi's trailing `read` notice, `\n\n[... Use offset=N to continue.]`. It must stay
 * out of the capped region: a cut inside it lands the continuation offset one
 * line too far and silently skips a file line. The pattern matches shape, not
 * wording, and is length-bounded so a long bracketed last line (such as
 * single-line JSON) is not mistaken for a notice; the caller also refuses to
 * hold out a notice once the whole block would pass the cap.
 */
const MAXIMUM_NOTICE_LENGTH = 256;
const TRAILING_BRACKETED_NOTICE = new RegExp(
  `\\n\\n\\[[^\\n\\]]{0,${MAXIMUM_NOTICE_LENGTH}}\\]$`,
  "u",
);

export function splitTrailingReadNotice(text: string): { body: string; notice: string } {
  const match = TRAILING_BRACKETED_NOTICE.exec(text);
  return match
    ? { body: text.slice(0, match.index), notice: match[0] }
    : { body: text, notice: "" };
}

/** `path:line: text`, the shape Pi's grep emits when `context` is 0. */
const GREP_MATCH_LINE = /^(.*?):(\d+): /u;

/**
 * Order grep matches by path and line before the cap sees them. Pi's grep
 * streams ripgrep's parallel output, so otherwise identical capped calls show
 * different subsets. Output that is not plain match-per-line (such as
 * `context` > 0) is returned unchanged.
 */
export function deterministicGrepText(text: string): string {
  const { body, notice } = splitTrailingReadNotice(text);
  if (body.length === 0) return text;
  const keyed: Array<{ line: string; path: string; lineNumber: number }> = [];
  for (const line of body.split("\n")) {
    const match = GREP_MATCH_LINE.exec(line);
    if (!match) return text;
    keyed.push({ line, path: match[1]!, lineNumber: Number(match[2]) });
  }
  keyed.sort((left, right) =>
    left.path === right.path
      ? left.lineNumber - right.lineNumber
      : left.path.localeCompare(right.path),
  );
  return `${keyed.map((item) => item.line).join("\n")}${notice}`;
}

/**
 * Wrap a tool definition so its text payload stays within `capBytes`, apart
 * from the DocsFab truncation marker and a one-byte floor per text block;
 * non-text blocks pass through. With an `archive`, a cut result is stored
 * whole and the marker names its handle; without one, or on refusal, the model
 * gets the capped head and marker alone.
 */
export function withToolOutputCap<T extends AnyToolDefinition>(
  definition: T,
  capBytes: number,
  archive?: ToolResultArchive,
): T {
  assertValidToolOutputCapBytes(capBytes);
  const execute = definition.execute.bind(definition) as (...arguments_: any[]) => Promise<any>;
  return {
    ...definition,
    async execute(...arguments_: any[]) {
      const result = await execute(...arguments_);
      return capToolResult(definition.name, result, capBytes, arguments_[1], archive);
    },
  };
}

function capToolResult(
  toolName: string,
  result: unknown,
  capBytes: number,
  parameters: unknown,
  archive: ToolResultArchive | undefined,
): unknown {
  if (!result || typeof result !== "object") return result;
  const record = result as { content?: unknown; details?: unknown };
  if (!Array.isArray(record.content)) return result;
  const blocks: unknown[] = record.content;

  let remaining = capBytes;
  let truncated = false;
  let rewritten = false;
  let receipt: ToolResultArchiveReceiptV1 | undefined;
  const content: unknown[] = [];
  for (const [index, block] of blocks.entries()) {
    const raw = textBlockValue(block);
    if (raw === undefined) {
      content.push(block);
      continue;
    }
    // Ordering has to settle before the cut, or the capped window is a different
    // subset on every identical call.
    const text = orderedToolText(toolName, raw);
    // Budget spent: later text blocks belong to the cut block's original.
    if (truncated) continue;
    // Only `read` carries Pi's continuation notice and a continuation offset.
    const { body } = toolName === "read" ? splitTrailingReadNotice(text) : { body: text };
    const budget = Math.max(1, remaining);
    const capped = capToolOutputText(body, budget);
    // Holding Pi's notice out of the cap is only sound while the whole block
    // fits; an untouched block larger than the cap would bypass it.
    const wholeBlockFits = Buffer.byteLength(text, "utf8") <= budget;
    if (!capped.truncated && wholeBlockFits) {
      remaining -= Buffer.byteLength(text, "utf8");
      // Pi's notice is still accurate when DocsFab did not cut the content.
      if (text !== raw) rewritten = true;
      content.push(text === raw ? block : { ...(block as Record<string, unknown>), text });
      continue;
    }
    truncated = true;
    const later = blocks.slice(index + 1).flatMap((item) => {
      const value = textBlockValue(item);
      return value === undefined ? [] : [orderedToolText(toolName, value)];
    });
    const projected = projectCutBlock({
      toolName,
      capBytes,
      budget,
      body,
      original: [text, ...later].join("\n"),
      hasLaterText: later.length > 0,
      capped,
      startLine: readStartLine(parameters),
      archive,
    });
    receipt = projected.receipt;
    content.push({
      ...(block as Record<string, unknown>),
      text: projected.text,
    });
  }
  if (!truncated && !rewritten) return result;
  return {
    ...(result as Record<string, unknown>),
    content,
    ...(receipt && canCarryArchiveReceipt(record.details)
      ? {
          details: {
            ...(record.details ?? {}),
            docsfabToolResultArchive: receipt,
          },
        }
      : {}),
  };
}

/**
 * Model-visible text for the block the cap cut. The archive, when present and
 * under its ceiling, keeps `original` whole; the budget is then split so the
 * head keeps at least half and the tail at most `toolOutput.excerptTailBytes`.
 */
function projectCutBlock(input: {
  toolName: string;
  capBytes: number;
  budget: number;
  body: string;
  original: string;
  hasLaterText: boolean;
  capped: ToolOutputCapResult;
  startLine: number;
  archive: ToolResultArchive | undefined;
}): { text: string; receipt?: ToolResultArchiveReceiptV1 } {
  const { toolName, capBytes, budget, capped, startLine, archive } = input;
  const totalBytes = Buffer.byteLength(input.original, "utf8");
  const outcome = archive?.archive(toolName, input.original);
  if (!archive || !outcome || "refusal" in outcome) {
    const marker = toolOutputCapMarker({
      toolName,
      capBytes,
      result: capped,
      startLine,
      totalBytes,
      ...(outcome && "refusal" in outcome ? { refusal: outcome.refusal } : {}),
    });
    return { text: joinProjection(capped.text, marker) };
  }
  let head = capped;
  let tail: ToolOutputTail | undefined;
  if (capped.truncated) {
    const tailBudget = Math.min(archive.limits.tail.value, Math.floor(budget / 2));
    head = capToolOutputText(input.body, budget - tailBudget);
    const tailSource = Buffer.from(input.hasLaterText ? input.original : input.body, "utf8");
    tail = toolOutputTail(tailSource, tailBudget, head.returnedBytes);
  }
  const marker = toolOutputCapMarker({
    toolName,
    capBytes,
    result: head,
    startLine,
    totalBytes,
    archive: { handle: outcome.receipt.handle, sha256: outcome.receipt.sha256 },
    ...(tail ? { tail: { startByte: tail.startByte, endByte: tail.endByte } } : {}),
  });
  return {
    text: joinProjection(head.text, marker, tail?.text),
    receipt: outcome.receipt,
  };
}

function joinProjection(head: string, marker: string, tail?: string): string {
  const withMarker = head.length > 0 ? `${head}\n${marker}` : marker;
  return tail === undefined ? withMarker : `${withMarker}\n${tail}`;
}

function canCarryArchiveReceipt(details: unknown): details is Record<string, unknown> | undefined {
  return (
    details === undefined ||
    (typeof details === "object" && details !== null && !Array.isArray(details))
  );
}

function orderedToolText(toolName: string, raw: string): string {
  return toolName === "grep" ? deterministicGrepText(raw) : raw;
}

function recallArgumentsAreWellFormed(raw: unknown): raw is ToolResultRecallRequest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const record = raw as Record<string, unknown>;
  return (
    Object.keys(record).every((key) => ["handle", "byteOffset", "byteLength"].includes(key)) &&
    typeof record.handle === "string" &&
    record.handle.length > 0 &&
    (record.byteOffset === undefined ||
      (Number.isSafeInteger(record.byteOffset) && (record.byteOffset as number) >= 0)) &&
    (record.byteLength === undefined ||
      (Number.isSafeInteger(record.byteLength) && (record.byteLength as number) >= 1))
  );
}

/**
 * The confined recall tool. It reads only `archive`; it never re-executes the
 * original tool or touches the workspace.
 */
export function createToolResultRecallTool(archive: ToolResultArchive): AnyToolDefinition {
  const pageBytes = archive.limits.page.value;
  return {
    name: TOOL_RESULT_RECALL_TOOL_NAME,
    label: "Recall archived tool result",
    description:
      "Return exact bytes of an oversized read, grep, find, ls, or quality-tool result that " +
      "this step already archived. Pass the handle from a docsfab-output-cap notice and a " +
      `zero-indexed byteOffset; one call returns at most ${pageBytes} bytes. It never runs ` +
      "the original tool again and never reads the workspace.",
    promptSnippet: "Recall exact bytes of an archived oversized tool result by handle",
    promptGuidelines: [
      "Use the handle and byteOffset a docsfab-output-cap notice names instead of re-reading the file.",
    ],
    parameters: {
      type: "object" as const,
      additionalProperties: false,
      required: ["handle"],
      properties: {
        handle: {
          type: "string" as const,
          description: "Handle named by a docsfab-output-cap notice in this step.",
        },
        byteOffset: {
          type: "integer" as const,
          minimum: 0,
          description: "Zero-indexed first byte to return; omit for 0.",
        },
        byteLength: {
          type: "integer" as const,
          minimum: 1,
          description: `Bytes to return; omit for ${pageBytes}, and never more than ${pageBytes}.`,
        },
      },
    },
    // Malformed arguments become a refused call rather than a repaired one, so
    // the authorized prefix of a batch still continues.
    prepareArguments(raw: unknown) {
      return recallArgumentsAreWellFormed(raw) ? raw : { handle: "" };
    },
    async execute(_toolCallId: unknown, raw: unknown) {
      if (!recallArgumentsAreWellFormed(raw)) {
        throw new ToolResultRecallError(
          "DocsFab recall needs a handle string, an optional non-negative integer byteOffset, and an optional positive integer byteLength.",
          "unsupported-pattern",
        );
      }
      const page = archive.recall(raw);
      const { receipt } = page;
      const next =
        page.end < receipt.totalBytes
          ? `Continue with byteOffset=${page.end}.`
          : "End of the archived result.";
      const notice =
        `[${RECALL_MARKER_PREFIX} ${receipt.handle}: returned bytes ${page.start + 1}-${page.end} ` +
        `of ${receipt.totalBytes} (sha256 ${receipt.sha256}). ${next}]`;
      const recalled: ToolResultRecallReceiptV1 = {
        schemaVersion: 1,
        kind: "docsfab-tool-result-recall",
        handle: receipt.handle,
        sha256: receipt.sha256,
        byteOffset: page.start,
        byteEnd: page.end,
        totalBytes: receipt.totalBytes,
      };
      return {
        content: [{ type: "text" as const, text: `${page.text}\n${notice}` }],
        details: { docsfabToolResultRecall: recalled },
      };
    },
  } as AnyToolDefinition;
}

function textBlockValue(block: unknown): string | undefined {
  if (!block || typeof block !== "object") return undefined;
  const item = block as Record<string, unknown>;
  return item.type === "text" && typeof item.text === "string" ? item.text : undefined;
}

function readStartLine(parameters: unknown): number {
  if (!parameters || typeof parameters !== "object") return 1;
  const offset = (parameters as Record<string, unknown>).offset;
  return typeof offset === "number" && Number.isFinite(offset) && offset >= 1
    ? Math.floor(offset)
    : 1;
}

/** Lines actually delivered, counting a final line with no trailing newline. */
function linesReturned(text: string): number {
  if (text.length === 0) return 0;
  const newlines = countCompleteLines(text);
  return text.endsWith("\n") ? newlines : newlines + 1;
}

function countCompleteLines(text: string): number {
  let count = 0;
  for (let index = text.indexOf("\n"); index >= 0; index = text.indexOf("\n", index + 1)) {
    count += 1;
  }
  return count;
}

/** Longest prefix of `buffer` no longer than `capBytes` that ends on a code point. */
function codePointSafePrefix(buffer: Buffer, capBytes: number): string {
  let end = Math.min(capBytes, buffer.byteLength);
  while (end > 0 && isUtf8Continuation(buffer[end]!)) end -= 1;
  return buffer.subarray(0, end).toString("utf8");
}

function isUtf8Continuation(byte: number): boolean {
  return (byte & 0b1100_0000) === 0b1000_0000;
}

/** Exclusive end of the UTF-8 code point that starts at `start`. */
function utf8CodePointEnd(bytes: Buffer, start: number): number {
  let end = start + 1;
  while (end < bytes.byteLength && isUtf8Continuation(bytes[end]!)) end += 1;
  return end;
}

/**
 * Merge archive snapshots from several attempts of one step. Receipts and stored
 * bytes come from the last (live) snapshot; refusals are unioned so an earlier
 * attempt's ceiling clip still reaches the saved step.
 */
export function mergeToolResultArchiveSnapshots(
  snapshots: readonly ToolResultArchiveSnapshotV1[],
): ToolResultArchiveSnapshotV1 | undefined {
  if (snapshots.length === 0) return undefined;
  const last = snapshots[snapshots.length - 1]!;
  const refusals: ToolResultArchiveRefusalV1[] = [];
  const seen = new Set<string>();
  for (const snapshot of snapshots) {
    for (const refusal of snapshot.refusals) {
      const key = `${refusal.limitName}:${String(refusal.observedBytes)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      refusals.push({ ...refusal });
    }
  }
  return {
    receipts: last.receipts.map((receipt) => ({ ...receipt })),
    storedBytes: last.storedBytes,
    ceilingBytes: last.ceilingBytes,
    refusals,
  };
}
