// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { JsonEvidenceError, parseJsonEvidence } from "../../json-evidence.js";

/** The untyped shell: every argument has a description only (§3.1, v10.1 B5). */
export function answerRecordTool(shell: "untyped" | "typed" = "untyped"): {
  readonly type: "function";
  readonly function: {
    readonly name: typeof ANSWER_RECORD_TOOL_NAME;
    readonly description: string;
    readonly parameters: {
      readonly type: "object";
      readonly properties: Readonly<
        Record<
          string,
          {
            readonly description: string;
            readonly type?: string | readonly string[];
            readonly enum?: readonly string[];
          }
        >
      >;
    };
  };
} {
  return {
    type: "function",
    function: {
      name: ANSWER_RECORD_TOOL_NAME,
      description:
        "Submit one judgment record of your answer. Call it once for each record; several calls may share one reply.",
      parameters: {
        type: "object",
        properties: {
          type: {
            description: "The record type.",
            ...(shell === "typed" ? { type: "string", enum: ANSWER_RECORD_TYPES } : {}),
          },
          key: {
            description: "The record's key, for a record type that has one.",
            ...(shell === "typed" ? { type: "string" } : {}),
          },
          record: {
            description: "The record itself, as a JSON object or one JSON-encoded string.",
            ...(shell === "typed" ? { type: ["object", "string"] as const } : {}),
          },
        },
      },
    },
  };
}

export const ANSWER_RECORD_CORPUS_KIND = "docsfab-answer-record-corpus" as const;
export const ANSWER_RECORD_TOOL_NAME = "submit_answer_record" as const;

export const ANSWER_RECORD_TYPES = [
  "target-judgment",
  "dimension",
  "finding",
  "layer-note",
  "evaluation-note",
  "quality-score",
] as const;
export type AnswerRecordType = (typeof ANSWER_RECORD_TYPES)[number];

/** Record types whose key is a skeleton key; every other type is sent without one. */
const KEYED_TYPES: ReadonlySet<AnswerRecordType> = new Set(["dimension", "layer-note"]);

export interface AnswerRecordCorpusEntry {
  readonly fixture: string;
  /** §4.1 group: 1 target and layer T, 2 layer U, 3 layer E, 4 the rest. */
  readonly group: 1 | 2 | 3 | 4;
  readonly type: AnswerRecordType;
  readonly key?: string;
  readonly record: unknown;
}

export interface AnswerRecordCorpus {
  readonly schemaVersion: 1;
  readonly kind: typeof ANSWER_RECORD_CORPUS_KIND;
  readonly provenance: unknown;
  readonly padding: {
    /** P: the median last-turn input of the retained step 8 attempts. */
    readonly targetTokens: number;
    readonly method: string;
    readonly source: unknown;
    /** The Lturn cross-check: median attempt time per provider turn, an upper bound. */
    readonly turnUpperBound: {
      readonly medianMsPerTurn: number;
      readonly attempts: number;
      readonly method: string;
    };
  };
  readonly statistics: unknown;
  readonly records: readonly AnswerRecordCorpusEntry[];
}

/** The corpus file is missing a member or has the wrong shape. */
export class AnswerRecordCorpusError extends Error {
  readonly code = "answer-record-corpus-invalid";

  constructor(message: string) {
    super(message);
    this.name = "AnswerRecordCorpusError";
  }
}

/** A retained file is unreadable, altered, of an unknown kind, or the premise run is missing. */
export class AnswerRecordLedgerError extends Error {
  readonly code = "answer-record-ledger-invalid";

  constructor(message: string) {
    super(message);
    this.name = "AnswerRecordLedgerError";
  }
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function corpusRefusal(location: string): never {
  throw new AnswerRecordCorpusError(
    `The answer-record corpus is not usable: ${location} is missing or has the wrong shape.`,
  );
}

/**
 * Strictly decode the committed corpus. Every record is a declared type with
 * a key exactly when the type is keyed, and the corpus holds the 3 layer
 * notes and both dimension sets the plan reads.
 */
export function decodeAnswerRecordCorpus(text: string): AnswerRecordCorpus {
  let parsed: unknown;
  try {
    parsed = parseJsonEvidence(text);
  } catch {
    corpusRefusal("the corpus JSON");
  }
  if (!isPlainObject(parsed)) corpusRefusal("the corpus root");
  if (parsed.schemaVersion !== 1 || parsed.kind !== ANSWER_RECORD_CORPUS_KIND) {
    corpusRefusal("schemaVersion or kind");
  }
  const padding = parsed.padding;
  if (
    !isPlainObject(padding) ||
    !positiveInteger(padding.targetTokens) ||
    typeof padding.method !== "string" ||
    !isPlainObject(padding.turnUpperBound) ||
    !positiveInteger(padding.turnUpperBound.medianMsPerTurn) ||
    !positiveInteger(padding.turnUpperBound.attempts) ||
    typeof padding.turnUpperBound.method !== "string"
  ) {
    corpusRefusal("padding");
  }
  if (!Array.isArray(parsed.records) || parsed.records.length === 0) corpusRefusal("records");
  const records = parsed.records.map((entry, index): AnswerRecordCorpusEntry => {
    const at = `records[${String(index)}]`;
    if (!isPlainObject(entry)) corpusRefusal(at);
    const type = entry.type;
    if (typeof type !== "string" || !ANSWER_RECORD_TYPES.includes(type as AnswerRecordType)) {
      corpusRefusal(`${at}.type`);
    }
    const keyed = KEYED_TYPES.has(type as AnswerRecordType);
    if (keyed ? typeof entry.key !== "string" || entry.key === "" : "key" in entry) {
      corpusRefusal(`${at}.key`);
    }
    if (typeof entry.fixture !== "string" || ![1, 2, 3, 4].includes(entry.group as number)) {
      corpusRefusal(`${at}.fixture or group`);
    }
    if (
      type === "quality-score"
        ? entry.record !== null && !isPlainObject(entry.record)
        : !isPlainObject(entry.record)
    ) {
      corpusRefusal(`${at}.record`);
    }
    return entry as unknown as AnswerRecordCorpusEntry;
  });
  for (const type of ["dimension", "finding", "layer-note"] as const) {
    if (!records.some((entry) => entry.type === type)) corpusRefusal(`a ${type} record`);
  }
  return { ...(parsed as unknown as AnswerRecordCorpus), records };
}

export type AnswerRecordDecodeCode =
  | "answer-record-json"
  | "answer-record-duplicate-key"
  | "answer-record-shape"
  | "answer-record-key";

export interface AnswerRecordEnvelope {
  readonly type: AnswerRecordType;
  readonly key?: string;
  readonly record: unknown;
}

export type RecordEncoding = "object" | "string" | "null";

export type DecodeResult =
  | {
      readonly decode: "admitted";
      readonly envelope: AnswerRecordEnvelope;
      readonly recordEncoding: RecordEncoding;
    }
  | {
      readonly decode: AnswerRecordDecodeCode;
      readonly location: string;
    };

const ENVELOPE_MEMBERS = new Set(["type", "key", "record"]);

function strictParse(
  text: string,
  location: string,
):
  | { readonly value: unknown }
  | { readonly decode: AnswerRecordDecodeCode; readonly location: string } {
  try {
    return { value: parseJsonEvidence(text) };
  } catch (error) {
    return {
      decode:
        error instanceof JsonEvidenceError && error.code === "duplicate-key"
          ? "answer-record-duplicate-key"
          : "answer-record-json",
      location,
    };
  }
}

/**
 * The strict decode of one call's raw argument text (§3.1 steps 1 and 3):
 * strict JSON with duplicate keys refused, the members exactly `{type, key?,
 * record}`, a declared type, a skeleton key exactly for keyed types, and a
 * record that is an object (`null` only for the score), where a record sent as
 * one JSON string is decoded once by the same strict parser.
 */
export function decodeAnswerRecordArguments(
  raw: string,
  keys: ReadonlyMap<AnswerRecordType, ReadonlySet<string>>,
): DecodeResult {
  if (!raw.trim()) return { decode: "answer-record-json", location: "$" };
  const outer = strictParse(raw, "$");
  if ("decode" in outer) return outer;
  const root = outer.value;
  if (
    !isPlainObject(root) ||
    !("type" in root) ||
    !("record" in root) ||
    Object.keys(root).some((member) => !ENVELOPE_MEMBERS.has(member))
  ) {
    return { decode: "answer-record-shape", location: "$" };
  }
  const type = root.type;
  if (typeof type !== "string" || !ANSWER_RECORD_TYPES.includes(type as AnswerRecordType)) {
    return { decode: "answer-record-shape", location: "$.type" };
  }
  const declared = type as AnswerRecordType;
  if (KEYED_TYPES.has(declared)) {
    if (typeof root.key !== "string" || !(keys.get(declared)?.has(root.key) ?? false)) {
      return { decode: "answer-record-key", location: "$.key" };
    }
  } else if ("key" in root) {
    return { decode: "answer-record-key", location: "$.key" };
  }
  let record = root.record;
  let recordEncoding: RecordEncoding = record === null ? "null" : "object";
  if (typeof record === "string") {
    const inner = strictParse(record, "$.record");
    if ("decode" in inner) return inner;
    record = inner.value;
    recordEncoding = "string";
  }
  if (
    declared === "quality-score"
      ? record !== null && !isPlainObject(record)
      : !isPlainObject(record)
  ) {
    return { decode: "answer-record-shape", location: "$.record" };
  }
  return {
    decode: "admitted",
    envelope: {
      type: declared,
      ...(KEYED_TYPES.has(declared) ? { key: root.key as string } : {}),
      record,
    },
    recordEncoding,
  };
}
