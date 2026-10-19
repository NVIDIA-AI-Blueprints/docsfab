// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { OUTPUT_RECORD_CONTRACTS } from "../../contracts/model-output.generated.js";
import { estimateTurnRequestTokens } from "../../model/turn-governor.js";
import {
  ANSWER_RECORD_TYPES,
  ANSWER_RECORD_TOOL_NAME,
  answerRecordTool,
  corpusRefusal,
  isPlainObject,
  AnswerRecordLedgerError,
  type AnswerRecordCorpus,
  type AnswerRecordCorpusEntry,
  type AnswerRecordEnvelope,
  type AnswerRecordType,
} from "./codecs.js";
import type { AnswerRecordProbeTarget } from "../answer-record-probe.js";

/**
 * Phase A's rungs, raw outer bytes of one call's arguments, wrapper included
 * (§3.1 step 4). These are what the probe asks the model to copy; nothing is
 * refused or cut at them, so they are probe design constants, not bounds.
 */
const RECORD_RUNGS = [512, 2048, 4096, 8192] as const;
/** Exact phase-A cells used by the untyped profile. */
export const UNTYPED_PHASE_A_RUNGS = [512, 2048, 4096] as const;
/** Typed slice-1b phase-A cells; typed calls use the larger measured rungs. */
export const TYPED_PHASE_A_RUNGS = [2048, 4096] as const;
/** Remaining typed rung available to other probe phases. */
export const TYPED_RECORD_RUNGS = [2048, 4096, 8192] as const;
/** Phase B's fixed rungs: half a group and one group (§6.1). */
export const MESSAGE_RUNGS = [6144, 10_240] as const;
/** Phase C's one rung. */
export const ESCAPE_RUNG = 4096;
/** Phase K's records per message. Like the rungs, what the probe asks for, not bounds. */
export const GROUP_SIZES = [2, 3] as const;
/** The group sizes the cost projection covers: one record per message, then phase K's. */
export const PROJECTED_GROUP_SIZES = [1, ...GROUP_SIZES] as const;
/**
 * The step 8 report's output tokens in the design's answer-time arithmetic
 * (§4.2, D_full). A projection input, not a bound.
 */
export const PROJECTED_REPORT_TOKENS = 2700;
/**
 * §4.1's per-message budget term, ⌊share × allowance × ρ_floor⌋, gives phase
 * B's top rung: share 80% and ρ_floor 2.86, as basis points and thousandths.
 * MR 3a declares the sealed limits; here they size probe content only.
 */
const ALLOWANCE_SHARE_BASIS_POINTS = 8000;
export const BYTES_PER_TOKEN_FLOOR_MILLI = 2860;
/** GO needs `maxRecordBytes` of at least the largest real record × 1.5 (§4.4). */
export const RECORD_HEADROOM = { numerator: 3, denominator: 2 } as const;

/** Phase B message starts: (fixture, group) pairs, one per seed, cycled. */
const MESSAGE_STARTS = [
  ["a", 1],
  ["b", 2],
  ["a", 4],
  ["b", 1],
  ["a", 2],
  ["b", 4],
  ["a", 3],
  ["b", 3],
] as const;

/**
 * Phase C's strings: V6's quotes, backslashes, fences, braces, and line
 * breaks, plus tabs, markup, and non-ASCII text.
 */
const HARSH_FRAGMENTS = [
  'A finding "quoted" in the report',
  "A path C:\\docs\\guide.md and a backslash \\ alone",
  '```json\n{"fenced": true}\n```',
  "Braces {inside} a string and [brackets]",
  "Line one\nLine two\n\tTabbed line",
  "Caf\u00e9 \u2014 na\u00efve \u2192 \u2713 \u00bd",
  "Markup </script> & <tag attr='x'> 50%",
] as const;

export type AnswerRecordProbePhase = "A" | "A-t" | "A-t-context" | "B" | "C" | "K";

const GUIDED_RECORD_TYPES = ["dimension", "finding"] as const;

function assertGuidedTypesDeclared(): void {
  const declared = new Set(
    OUTPUT_RECORD_CONTRACTS["quality-evaluation"].records.map((record) => record.type),
  );
  if (GUIDED_RECORD_TYPES.some((recordType) => !declared.has(recordType))) {
    throw new AnswerRecordLedgerError(
      "The generated quality-evaluation record declaration is missing the dimension or finding schema used by phase G.",
    );
  }
}

export interface PlannedCall {
  readonly envelope: AnswerRecordEnvelope;
  /** The compact JSON the prompt asks the model to copy. */
  readonly text: string;
  readonly bytes: number;
}

export interface PlannedRequest {
  readonly phase: AnswerRecordProbePhase;
  readonly rungBytes: number;
  readonly seed: number;
  readonly calls: readonly PlannedCall[];
  /** Record types represented by an A-t-context request. */
  readonly contextTypes?: readonly AnswerRecordType[];
  readonly plannedBytes: number;
  readonly paddingChars: number;
  /** Escape sequences per KiB of the planned argument text. */
  readonly escapesPerKiB: number;
  /** Builds the request's prompt for one send; `send` changes only the leading nonce. */
  readonly prompt: (send: number) => string;
  readonly estimatedInputTokens: number;
}

export function plannedCall(envelope: AnswerRecordEnvelope): PlannedCall {
  const text = JSON.stringify(envelope);
  return { envelope, text, bytes: Buffer.byteLength(text, "utf8") };
}

/** Preserve the decoded null while emitting the production typed-shell string representation. */
function plannedStringifiedNullCall(envelope: AnswerRecordEnvelope): PlannedCall {
  const text = JSON.stringify({ ...envelope, record: "null" });
  return { envelope, text, bytes: Buffer.byteLength(text, "utf8") };
}

export function envelopeOf(entry: AnswerRecordCorpusEntry): AnswerRecordEnvelope {
  return {
    type: entry.type,
    ...(entry.key === undefined ? {} : { key: entry.key }),
    record: entry.record,
  };
}

function escapeCount(text: string): number {
  return (text.match(/\\./gu) ?? []).length;
}

function nonce(
  salt: string,
  phase: AnswerRecordProbePhase,
  rung: number,
  seed: number,
  send: number,
): string {
  return createHash("sha256")
    .update(`${salt}:${phase}:${String(rung)}:${String(seed)}:${String(send)}`)
    .digest("hex");
}

/** Real prose from the corpus: rationales, descriptions, and evidence text, in corpus order. */
function corpusProse(corpus: AnswerRecordCorpus): string[] {
  const texts: string[] = [];
  const visit = (value: unknown, member?: string): void => {
    if (typeof value === "string") {
      if (member === "rationale" || member === "description" || member === "acceptance_condition") {
        texts.push(value);
      }
      return;
    }
    if (Array.isArray(value)) value.forEach((item) => visit(item, member));
    else if (isPlainObject(value)) {
      for (const [name, item] of Object.entries(value)) visit(item, name);
    }
  };
  corpus.records.forEach((entry) => visit(entry.record));
  return texts;
}

function rotate<T>(items: readonly T[], start: number): T[] {
  const offset = items.length === 0 ? 0 : start % items.length;
  return [...items.slice(offset), ...items.slice(0, offset)];
}

/** The largest prefix length of `filler` whose value from `build` stays within `target` bytes. */
function fitFiller(
  filler: string,
  target: number,
  build: (text: string) => PlannedCall,
): PlannedCall {
  let low = 0;
  let high = filler.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (build(filler.slice(0, middle)).bytes <= target) low = middle;
    else high = middle - 1;
  }
  return build(filler.slice(0, low));
}

/** The record member whose text grows to the rung: a dimension's rationale or a finding's description. */
function grownMember(type: AnswerRecordType): "rationale" | "description" {
  return type === "finding" ? "description" : "rationale";
}

/**
 * One record of exactly `target` raw outer bytes, or a few bytes under when a
 * multibyte character or escape would cross it: a real dimension or finding
 * record, with real evidence items appended and its text member extended
 * with real prose until the rung.
 */
function rungRecord(
  base: AnswerRecordCorpusEntry,
  target: number,
  evidence: readonly unknown[],
  prose: string,
  transform: (text: string) => string = (text) => text,
): PlannedCall {
  const record = structuredClone(base.record) as Record<string, unknown>;
  const member = grownMember(base.type);
  const harden = (value: unknown): unknown => {
    if (typeof value === "string") return transform(value);
    if (Array.isArray(value)) return value.map(harden);
    if (isPlainObject(value)) {
      return Object.fromEntries(
        Object.entries(value).map(([name, item]) =>
          ["description", "rationale", "locator", "acceptance_condition"].includes(name)
            ? [name, harden(item)]
            : [name, item],
        ),
      );
    }
    return value;
  };
  const items = [...((record.evidence as unknown[] | undefined) ?? [])].map(harden);
  const build = (items: readonly unknown[], extra: string): PlannedCall =>
    plannedCall({
      type: base.type,
      ...(base.key === undefined ? {} : { key: base.key }),
      record: {
        ...(harden(record) as Record<string, unknown>),
        evidence: items,
        [member]: `${transform(String(record[member] ?? ""))}${extra ? ` ${extra}` : ""}`,
      },
    });
  for (const item of evidence) {
    const next = [...items, harden(item)];
    if (build(next, "").bytes > target) break;
    items.push(harden(item));
  }
  return fitFiller(transform(prose), target, (text) => build(items, text));
}

/** Insert one harsh fragment after each clause and sentence: phase C's escape mix. */
function harshen(text: string): string {
  let index = 0;
  return text.replace(/([.!?,;:])(\s|$)/gu, (_match, stop: string, space: string) => {
    const fragment = HARSH_FRAGMENTS[index % HARSH_FRAGMENTS.length]!;
    index += 1;
    return `${stop} ${fragment}${space}`;
  });
}

/** Seeded record bases for a rung: dimension and finding records that fit under it. */
function rungBases(
  corpus: AnswerRecordCorpus,
  target: number,
  types: readonly AnswerRecordType[],
): AnswerRecordCorpusEntry[] {
  return corpus.records.filter(
    (entry) => types.includes(entry.type) && plannedCall(envelopeOf(entry)).bytes < target,
  );
}

function pick<T>(items: readonly T[], seed: number, samples: number): T {
  return items[Math.floor(((seed + 0.5) * items.length) / samples) % items.length]!;
}

function estimate(target: AnswerRecordProbeTarget, prompt: string): number {
  return estimateTurnRequestTokens({
    systemPrompt: target.systemPrompt,
    messages: [{ role: "user", content: prompt }],
    tools: [answerRecordTool(target.selection === "typed" ? "typed" : "untyped")],
  });
}

function singlePrompt(call: PlannedCall, tag: string): string {
  return [
    `Probe request ${tag}.`,
    `Call ${ANSWER_RECORD_TOOL_NAME} exactly once, with exactly these arguments, copied character for character:`,
    call.text,
  ].join("\n");
}

function messagePrompt(calls: readonly PlannedCall[], tag: string, padding: string): string {
  return [
    `Probe request ${tag}.`,
    "Reading context, for size only; do not act on it:",
    padding,
    "",
    `Call ${ANSWER_RECORD_TOOL_NAME} exactly ${String(calls.length)} times in this one reply, once for each argument object below, each copied character for character:`,
    ...calls.flatMap((call, index) => [`Call ${String(index + 1)}:`, call.text]),
  ].join("\n");
}

/** The phase B budget maximum, ⌊share × allowance × ρ_floor⌋ (§4.1). */
export function messageBudgetBytes(maxOutputTokens: number): number {
  return Math.floor(
    (maxOutputTokens * ALLOWANCE_SHARE_BASIS_POINTS * BYTES_PER_TOKEN_FLOOR_MILLI) / 10_000_000,
  );
}

export function buildPlan(target: AnswerRecordProbeTarget, salt: string): PlannedRequest[] {
  const { corpus } = target;
  const samples = target.samplesPerRung;
  const ordered = corpus.records;
  const paddingPool = ordered.map((entry) => JSON.stringify(entry.record)).join("\n");
  /** A padded request, with its prompt brought to P using corpus text (N3). */
  const padded = (
    phase: "A-t-context" | "B" | "K",
    rung: number,
    seed: number,
    calls: readonly PlannedCall[],
  ): PlannedRequest => {
    const tag = (send: number) => nonce(salt, phase, rung, seed, send);
    const offset = Math.floor((seed * paddingPool.length) / samples);
    const body = `${paddingPool.slice(offset)}\n${paddingPool.slice(0, offset)}`;
    // Repeat the corpus text until it can reach P, then fit the padding to P.
    const reach = Math.ceil((corpus.padding.targetTokens * 4) / Math.max(1, body.length)) + 1;
    const pool = body.repeat(reach);
    let low = 0;
    let high = pool.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (
        estimate(target, messagePrompt(calls, tag(0), pool.slice(0, middle))) <=
        corpus.padding.targetTokens
      ) {
        low = middle;
      } else high = middle - 1;
    }
    const padding = pool.slice(0, low);
    const prompt = (send: number) => messagePrompt(calls, tag(send), padding);
    const text = calls.map((call) => call.text).join("");
    const bytes = calls.reduce((sum, call) => sum + call.bytes, 0);
    return {
      phase,
      ...(phase === "A-t-context" ? { contextTypes: calls.map((call) => call.envelope.type) } : {}),
      rungBytes: phase === "K" ? bytes : rung,
      seed,
      calls,
      plannedBytes: bytes,
      paddingChars: padding.length,
      escapesPerKiB: Math.round((escapeCount(text) * 1024) / Math.max(1, bytes)),
      prompt,
      estimatedInputTokens: estimate(target, prompt(0)),
    };
  };
  /** The seed's message start: a (fixture, group) pair, cycled. */
  const startOf = (seed: number) => {
    const [fixture, group] = MESSAGE_STARTS[seed % MESSAGE_STARTS.length]!;
    return { fixture, group };
  };
  const exactMessageCalls = (seed: number, rung: number): PlannedCall[] => {
    const { fixture, group } = startOf(seed);
    const start = Math.max(
      0,
      ordered.findIndex((entry) => entry.fixture === fixture && entry.group === group),
    );
    const candidates = rotate(ordered, start).map((entry) => {
      const envelope = envelopeOf(entry);
      return target.selection === "typed" && entry.type === "quality-score" && entry.record === null
        ? plannedStringifiedNullCall(envelope)
        : plannedCall(envelope);
    });
    const reachable = new Map<number, PlannedCall[]>([[0, []]]);
    for (const call of candidates) {
      for (const [bytes, calls] of [...reachable.entries()].reverse()) {
        const next = bytes + call.bytes;
        if (next <= rung && !reachable.has(next)) reachable.set(next, [...calls, call]);
      }
      if (reachable.has(rung)) break;
    }
    const calls = reachable.get(rung);
    if (!calls)
      corpusRefusal(`distinct corpus records totaling exactly ${String(rung)} outer bytes`);
    return calls;
  };
  if ((target.selection ?? "premise") === "small-groups") {
    // Phase K: the first k records of one production group, as the records
    // protocol sends them, so a message never crosses a group (§4.1).
    const requests: PlannedRequest[] = [];
    for (const size of GROUP_SIZES) {
      for (let seed = 0; seed < samples; seed += 1) {
        const { fixture, group } = startOf(seed);
        const members = ordered.filter(
          (entry) => entry.fixture === fixture && entry.group === group,
        );
        if (members.length < size) corpusRefusal(`group ${fixture}:${String(group)}`);
        requests.push(
          padded(
            "K",
            size,
            seed,
            members.slice(0, size).map((entry) => plannedCall(envelopeOf(entry))),
          ),
        );
      }
    }
    return requests;
  }
  if (target.selection === "typed") {
    assertGuidedTypesDeclared();
    const requests: PlannedRequest[] = [];
    if (target.typedContextMix) {
      const maxByType = (type: AnswerRecordType, index = 0): AnswerRecordCorpusEntry => {
        const entries = ordered
          .filter((entry) => entry.type === type)
          .sort((left, right) => {
            const byteDifference =
              plannedCall(envelopeOf(right)).bytes - plannedCall(envelopeOf(left)).bytes;
            return (
              byteDifference ||
              left.fixture.localeCompare(right.fixture) ||
              left.group - right.group ||
              (left.key ?? "").localeCompare(right.key ?? "")
            );
          });
        const entry = entries[index];
        if (!entry)
          corpusRefusal(`a ${type} record${index > 0 ? ` at rank ${String(index + 1)}` : ""}`);
        return entry;
      };
      const callOf = (entry: AnswerRecordCorpusEntry): PlannedCall => {
        const envelope = envelopeOf(entry);
        // The typed Pi schema admits object|string. A quality-score null is
        // represented as the one-level JSON string "null"; the strict
        // decoder normalizes it back to the canonical null envelope.
        return entry.type === "quality-score" && entry.record === null
          ? plannedStringifiedNullCall(envelope)
          : plannedCall(envelope);
      };
      const contextEntries = ANSWER_RECORD_TYPES.map((type) => maxByType(type));
      if (!target.typedContextGroupOnly) {
        for (let seed = 0; seed < contextEntries.length; seed += 1) {
          const call = callOf(contextEntries[seed]!);
          requests.push(padded("A-t-context", call.bytes, seed, [call]));
        }
      }
      const grouped = [callOf(maxByType("dimension")), callOf(maxByType("finding"))];
      const groupedBytes = grouped.reduce((sum, call) => sum + call.bytes, 0);
      requests.push(padded("A-t-context", groupedBytes, contextEntries.length, grouped));
      return requests;
    }
    const evidencePool = ordered.flatMap((entry) =>
      entry.type === "dimension" || entry.type === "finding"
        ? (((entry.record as Record<string, unknown>).evidence as unknown[] | undefined) ?? [])
        : [],
    );
    const prose = corpusProse(corpus);
    for (const rung of target.qualificationCells ? TYPED_PHASE_A_RUNGS : TYPED_RECORD_RUNGS) {
      const bases = rungBases(corpus, rung, ["dimension", "finding"]);
      for (let seed = 0; seed < samples; seed += 1) {
        const base = pick(bases, seed, samples);
        const call = rungRecord(
          base,
          rung,
          rotate(evidencePool, seed * 7),
          rotate(prose, seed * 11).join(" "),
        );
        const prompt = (send: number) => singlePrompt(call, nonce(salt, "A-t", rung, seed, send));
        requests.push({
          phase: "A-t",
          rungBytes: rung,
          seed,
          calls: [call],
          plannedBytes: call.bytes,
          paddingChars: 0,
          escapesPerKiB: Math.round((escapeCount(call.text) * 1024) / call.bytes),
          prompt,
          estimatedInputTokens: estimate(target, prompt(0)),
        });
      }
    }
    if (target.qualificationCells) {
      const top = MESSAGE_RUNGS[0];
      for (let seed = 0; seed < samples; seed += 1) {
        requests.push(padded("B", top, seed, exactMessageCalls(seed, top)));
      }
      const escapeBases = rungBases(corpus, ESCAPE_RUNG, ["dimension"]);
      for (let seed = 0; seed < samples; seed += 1) {
        const call = rungRecord(
          pick(escapeBases, seed, samples),
          ESCAPE_RUNG,
          rotate(evidencePool, seed * 13),
          rotate(prose, seed * 17).join(" "),
          harshen,
        );
        const prompt = (send: number) =>
          singlePrompt(call, nonce(salt, "C", ESCAPE_RUNG, seed, send));
        requests.push({
          phase: "C",
          rungBytes: ESCAPE_RUNG,
          seed,
          calls: [call],
          plannedBytes: call.bytes,
          paddingChars: 0,
          escapesPerKiB: Math.round((escapeCount(call.text) * 1024) / call.bytes),
          prompt,
          estimatedInputTokens: estimate(target, prompt(0)),
        });
      }
      return requests;
    }
    return requests;
  }
  const evidencePool = corpus.records.flatMap((entry) =>
    entry.type === "dimension" || entry.type === "finding"
      ? (((entry.record as Record<string, unknown>).evidence as unknown[] | undefined) ?? [])
      : [],
  );
  const prose = corpusProse(corpus);
  const single = (
    phase: AnswerRecordProbePhase,
    rung: number,
    seed: number,
    call: PlannedCall,
  ): PlannedRequest => {
    const prompt = (send: number) => singlePrompt(call, nonce(salt, phase, rung, seed, send));
    return {
      phase,
      rungBytes: rung,
      seed,
      calls: [call],
      plannedBytes: call.bytes,
      paddingChars: 0,
      escapesPerKiB: Math.round((escapeCount(call.text) * 1024) / call.bytes),
      prompt,
      estimatedInputTokens: estimate(target, prompt(0)),
    };
  };
  const requests: PlannedRequest[] = [];
  for (const rung of target.qualificationCells ? UNTYPED_PHASE_A_RUNGS : RECORD_RUNGS) {
    const bases = rungBases(corpus, rung, ["dimension", "finding"]);
    for (let seed = 0; seed < samples; seed += 1) {
      const base = pick(bases, seed, samples);
      const call = rungRecord(
        base,
        rung,
        rotate(evidencePool, seed * 7),
        rotate(prose, seed * 11).join(" "),
      );
      requests.push(single("A", rung, seed, call));
    }
  }
  const top = messageBudgetBytes(target.maxOutputTokens);
  const messageRungs = target.qualificationCells
    ? [MESSAGE_RUNGS[0]]
    : [...new Set([...MESSAGE_RUNGS, top])]
        .filter((rung) => rung <= top)
        .sort((left, right) => left - right);
  for (const rung of messageRungs) {
    for (let seed = 0; seed < samples; seed += 1) {
      if (target.qualificationCells) {
        requests.push(padded("B", rung, seed, exactMessageCalls(seed, rung)));
        continue;
      }
      const { fixture, group } = startOf(seed);
      const start = Math.max(
        0,
        ordered.findIndex((entry) => entry.fixture === fixture && entry.group === group),
      );
      const calls: PlannedCall[] = [];
      let bytes = 0;
      // Plan order from the seeded start; a record that would cross the rung
      // is skipped so a later, smaller one can fill the message.
      for (const entry of rotate(ordered, start)) {
        const call = plannedCall(envelopeOf(entry));
        if (bytes + call.bytes > rung) continue;
        calls.push(call);
        bytes += call.bytes;
      }
      requests.push(padded("B", rung, seed, calls));
    }
  }
  const escapeBases = rungBases(corpus, ESCAPE_RUNG, ["dimension"]);
  for (let seed = 0; seed < samples; seed += 1) {
    const call = rungRecord(
      pick(escapeBases, seed, samples),
      ESCAPE_RUNG,
      rotate(evidencePool, seed * 13),
      rotate(prose, seed * 17).join(" "),
      harshen,
    );
    requests.push(single("C", ESCAPE_RUNG, seed, call));
  }
  return requests;
}
