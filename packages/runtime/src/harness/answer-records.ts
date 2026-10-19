// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The answer-records core: record grammar, ledger, and pure assembly for any
 * records-mode contract (planning/design/closed-schema-answer-records-decision.md
 * §1, §3.1-§3.4, §4.4).
 *
 * A records-mode contract's declaration is generated from
 * `config/model-output/contracts/<id>.yaml` into `OUTPUT_RECORD_CONTRACTS`. This
 * module reads only that declaration and the host inputs its caller resolves
 * (skeleton keys, selector members, host-minted values, references, and a
 * derive step), so it knows no step, profile, or provider. It holds no I/O and
 * no transport: the tool, the disclosure screen (admission step 2), the
 * per-key sub-schema, the owner's record checks, link resolution, durable
 * rows, and settlement are the harness's (design §7, MR 3b).
 *
 * Receipts are content-free: they name a declared type, a planned or issued
 * key, a catalog code and location, and catalog feedback, never record text.
 */

import { limit } from "../config/limits.js";
import { canonicalJson, sha256 } from "../content-ir/canonical.js";
import {
  OUTPUT_RULE_HINTS,
  OUTPUT_RULES,
  rejectOutput,
  type AnswerRecordContractDeclaration,
  type AnswerRecordTypeDeclaration,
  type LocationOf,
  type RuleCodeOf,
} from "../contracts/model-output.js";
import { JsonEvidenceError, parseJsonEvidence, type JsonEvidenceValue } from "../json-evidence.js";
import {
  fillHostMinted,
  hostDefect,
  instances,
  isPrefix,
  parseRecordLocation,
  readAt,
  writeAt,
  type ConcretePath,
  type HostMintedValues,
  type Segment,
} from "./answer-record-fill.js";

export {
  AnswerRecordHostError,
  fillHostMinted,
  parseRecordLocation,
  type HostMintedValue,
  type HostMintedValues,
} from "./answer-record-fill.js";

export type AnswerRecordCode = RuleCodeOf<"answer-record">;

function isObject(value: unknown): value is Record<string, JsonEvidenceValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** One key a skeleton enumerates, resolved by the contract owner from its host input. */
export interface AnswerRecordSkeletonEntry {
  readonly key: string;
  /** The canonical member the record location's `*` stands for, such as a layer; `null` when the location has none. */
  readonly slot: string | null;
}

export interface AnswerRecordPlanInput {
  readonly declaration: AnswerRecordContractDeclaration;
  /** Every declared skeleton's keys, in plan order. */
  readonly skeletons: Readonly<Record<string, readonly AnswerRecordSkeletonEntry[]>>;
  /** The canonical member names each declared selector (such as `required`) picks. */
  readonly selectors?: Readonly<Record<string, readonly string[]>>;
  /** Effective limit values; defaults to the operational-limits catalog. */
  readonly limitValue?: (name: string) => number;
  /** Whether a declared `closedBy` flag also makes its open set terminal. */
  readonly enforceClosedSetAdmission?: boolean;
}

export interface PlannedAnswerRecordKey {
  readonly key: string;
  readonly slot: string | null;
  /** Index into the type's generated `shapes`. */
  readonly shape: number;
}

export interface PlannedAnswerRecordType {
  readonly declaration: AnswerRecordTypeDeclaration;
  /** Fixed keys in plan order; empty for a singleton or an open set. */
  readonly keys: readonly PlannedAnswerRecordKey[];
  /** The prefix of an open set's host-issued keys, such as `F` for `F-1`. */
  readonly serialPrefix: string | null;
}

export interface AnswerRecordPlan {
  readonly declaration: AnswerRecordContractDeclaration;
  readonly types: ReadonlyMap<string, PlannedAnswerRecordType>;
  readonly selectors: Readonly<Record<string, readonly string[]>>;
  readonly maxRecordBytes: number;
  readonly maxOpenRecordsPerSet: number;
  readonly maxRefusalsPerKey: number;
  /** Completion flags can be bookkeeping without preventing later record correction. */
  readonly enforceClosedSetAdmission: boolean;
  readonly requiredKeys: number;
  readonly optionalKeys: number;
  readonly openSets: number;
  /**
   * The derived per-step record-call ceiling (design §4.4): every planned key
   * and every open-set slot, each with its refusals.
   */
  readonly recordCallCeiling: number;
}

const SINGLETON = "singleton";
const HOST_SERIAL = "host-serial";
const SKELETON = "skeleton:";
const ROOT_KEYS = new Set(["type", "key", "record"]);

function contractLimit(
  declaration: AnswerRecordContractDeclaration,
  role: keyof AnswerRecordContractDeclaration["limits"],
  limitValue: (name: string) => number,
): number {
  const name = declaration.limits[role];
  if (!name) hostDefect(`The records contract declares no ${role} limit.`);
  const value = limitValue(name);
  if (!Number.isSafeInteger(value) || value < 0) hostDefect(`Limit ${name} is not a count.`);
  return value;
}

/**
 * Resolve a declaration and its host inputs into the record plan: every
 * planned key with its shape and slot, the open sets, the effective limits,
 * and the derived record-call ceiling.
 */
export function planAnswerRecords(input: AnswerRecordPlanInput): AnswerRecordPlan {
  const { declaration } = input;
  const limitValue = input.limitValue ?? ((name: string) => limit(name).value);
  const types = new Map<string, PlannedAnswerRecordType>();
  const prefixes = new Set<string>();
  let requiredKeys = 0;
  let optionalKeys = 0;
  let openSets = 0;
  for (const record of declaration.records) {
    let keys: PlannedAnswerRecordKey[] = [];
    let serialPrefix: string | null = null;
    if (record.key.startsWith(SKELETON)) {
      keys = record.skeletons.flatMap((name, shape) => {
        const entries = input.skeletons[name];
        if (!entries) hostDefect(`Skeleton ${name} has no resolved keys.`);
        return entries.map((entry) => ({ key: entry.key, slot: entry.slot, shape }));
      });
      if (keys.length === 0) hostDefect(`Record type ${record.type} has no planned keys.`);
      if (new Set(keys.map((entry) => entry.key)).size !== keys.length) {
        hostDefect(`Record type ${record.type} plans a key twice.`);
      }
    } else if (record.key === HOST_SERIAL) {
      serialPrefix = record.type.charAt(0).toUpperCase();
      if (prefixes.has(serialPrefix)) hostDefect(`Two open sets share key prefix ${serialPrefix}.`);
      prefixes.add(serialPrefix);
      openSets += 1;
    } else if (record.key !== SINGLETON) {
      hostDefect(`Record type ${record.type} has an unknown key form.`);
    }
    const count = record.key === HOST_SERIAL ? 0 : record.key === SINGLETON ? 1 : keys.length;
    if (record.optional) optionalKeys += count;
    else requiredKeys += count;
    types.set(record.type, { declaration: record, keys, serialPrefix });
  }
  const maxOpenRecordsPerSet =
    openSets > 0 ? contractLimit(declaration, "openRecords", limitValue) : 0;
  const maxRefusalsPerKey = contractLimit(declaration, "refusalsPerKey", limitValue);
  return {
    declaration,
    types,
    selectors: input.selectors ?? {},
    maxRecordBytes: contractLimit(declaration, "recordBytes", limitValue),
    maxOpenRecordsPerSet,
    maxRefusalsPerKey,
    enforceClosedSetAdmission: input.enforceClosedSetAdmission ?? true,
    requiredKeys,
    optionalKeys,
    openSets,
    recordCallCeiling:
      (requiredKeys + optionalKeys + maxOpenRecordsPerSet * openSets) * (1 + maxRefusalsPerKey),
  };
}

// ---------------------------------------------------------------------------
// Grammar: one submit_answer_record call

export interface DecodedAnswerRecordCall {
  readonly type: string;
  /** The key the call named; `null` adds a new open-set record or names a singleton. */
  readonly key: string | null;
  /** The decoded record; `null` withdraws an open-set record or is a nullable record's value. */
  readonly record: JsonEvidenceValue;
  /** Raw outer bytes of the call's arguments, wrapper included. */
  readonly rawBytes: number;
}

export interface AnswerRecordRefusal {
  readonly status: "refused";
  readonly code: AnswerRecordCode;
  readonly location: string;
  readonly retry: "model-correctable" | "terminal";
  /** The declared type and planned key, when the call named them; never model text. */
  readonly type: string | null;
  readonly key: string | null;
}

function refusal(
  code: AnswerRecordCode,
  location: string,
  type: string | null = null,
  key: string | null = null,
): AnswerRecordRefusal {
  const rejection = rejectOutput(code, location as LocationOf<AnswerRecordCode>);
  return {
    status: "refused",
    code: rejection.code as AnswerRecordCode,
    location: rejection.location,
    retry: OUTPUT_RULES[code].retry,
    type,
    key,
  };
}

function strictDecode(
  text: string,
  location: "$" | "$.record",
): { value: JsonEvidenceValue } | { refusal: AnswerRecordRefusal } {
  try {
    return { value: parseJsonEvidence(text) };
  } catch (error) {
    return {
      refusal:
        error instanceof JsonEvidenceError && error.code === "duplicate-key"
          ? refusal("answer-record-duplicate-key", location)
          : refusal("answer-record-json", location),
    };
  }
}

/**
 * Decode one call's raw argument text, as the serving stack forwarded it
 * (design §3.1 steps 1, 3 and 4): a strict decode with duplicate keys
 * refused; `record` decoded once more when it arrives as a string; the root
 * keys, the declared type, and the key form; then the raw byte bound. The key
 * of an open-set record is checked against the ledger, not here.
 */
export function decodeAnswerRecordCall(
  plan: AnswerRecordPlan,
  raw: string | undefined,
): { readonly call: DecodedAnswerRecordCall } | { readonly refusal: AnswerRecordRefusal } {
  if (raw === undefined || raw.trim() === "")
    return { refusal: refusal("answer-record-json", "$") };
  const outer = strictDecode(raw, "$");
  if ("refusal" in outer) return outer;
  const root = outer.value;
  if (!isObject(root) || !Object.hasOwn(root, "type") || !Object.hasOwn(root, "record")) {
    return { refusal: refusal("answer-record-shape", "$") };
  }
  if (Object.keys(root).some((key) => !ROOT_KEYS.has(key))) {
    return { refusal: refusal("answer-record-shape", "$") };
  }
  let record: JsonEvidenceValue = root.record ?? null;
  if (typeof record === "string") {
    const inner = strictDecode(record, "$.record");
    if ("refusal" in inner) return inner;
    record = inner.value;
  }
  const type = typeof root.type === "string" ? plan.types.get(root.type) : undefined;
  if (!type) return { refusal: refusal("answer-record-key", "$.type") };
  const typeName = type.declaration.type;
  const key = root.key ?? null;
  if (key !== null && typeof key !== "string") {
    return { refusal: refusal("answer-record-key", "$.key", typeName) };
  }
  const form = type.declaration.key;
  if (form === SINGLETON && key !== null) {
    return { refusal: refusal("answer-record-key", "$.key", typeName) };
  }
  if (form.startsWith(SKELETON) && !type.keys.some((entry) => entry.key === key)) {
    return { refusal: refusal("answer-record-key", "$.key", typeName) };
  }
  const plannedKey = form.startsWith(SKELETON) ? key : null;
  if (record === null) {
    // Null withdraws an open-set record by its issued key, or is the value of
    // a nullable non-open record. An open set cannot allocate a new key with
    // a null payload, even if its declaration also says nullable.
    if (type.declaration.open && key === null) {
      return { refusal: refusal("answer-record-shape", "$.record", typeName, plannedKey) };
    }
    if (!(type.declaration.open && key !== null) && !type.declaration.nullable) {
      return { refusal: refusal("answer-record-shape", "$.record", typeName, plannedKey) };
    }
  } else if (!isObject(record)) {
    return { refusal: refusal("answer-record-shape", "$.record", typeName, plannedKey) };
  }
  const rawBytes = Buffer.byteLength(raw, "utf8");
  if (rawBytes > plan.maxRecordBytes) {
    return { refusal: refusal("answer-record-too-large", "$", typeName, plannedKey) };
  }
  return { call: { type: typeName, key, record, rawBytes } };
}

// ---------------------------------------------------------------------------
// Ledger

export interface AnswerRecordRow {
  readonly type: string;
  readonly key: string;
  readonly payload: JsonEvidenceValue;
  readonly payloadSha256: string;
}

export interface AnswerRecordLedger {
  readonly plan: AnswerRecordPlan;
  /** Admitted rows in admission order, by `type` and `key`. */
  readonly rows: ReadonlyMap<string, AnswerRecordRow>;
  /** Refusals charged per record key, or per call when no key was named. */
  readonly refusals: ReadonlyMap<string, number>;
  /** The last serial each open set issued. */
  readonly issued: ReadonlyMap<string, number>;
  /** The key whose refusals ran out; every later call is refused the same way. */
  readonly exhausted: { readonly type: string | null; readonly key: string | null } | null;
}

export type AnswerRecordOutcome = "admitted" | "replaced" | "unchanged" | "withdrawn" | "refused";

/** A content-free receipt for one call (design §3.1). */
export interface AnswerRecordReceipt {
  readonly status: AnswerRecordOutcome;
  readonly type: string | null;
  /** Internal ledger key; singleton receipts are projected to null on the wire. */
  readonly key: string | null;
  readonly code?: AnswerRecordCode;
  readonly location?: string;
  readonly retry?: "model-correctable" | "terminal";
  /** The catalog's hint for the refusal, never record text. */
  readonly feedback?: string;
  /** Planned keys still missing, as `<type>` or `<type>:<key>`. */
  readonly remaining: readonly string[];
  readonly complete: boolean;
}

/**
 * Project a core receipt to the accepted tool-wire key form. The ledger uses
 * `singleton` as its stable internal row key, while singleton calls omit key
 * or send null. Other contract key forms retain their planned or issued key.
 */
export function answerRecordReceiptForWire<
  T extends { readonly type: string | null; readonly key: string | null },
>(
  receipt: T,
  declaration: AnswerRecordContractDeclaration,
): Omit<T, "key"> & Pick<AnswerRecordReceipt, "key"> {
  if (
    receipt.type !== null &&
    receipt.key === SINGLETON &&
    declaration.records.some((record) => record.type === receipt.type && record.key === SINGLETON)
  ) {
    return { ...receipt, key: null };
  }
  return receipt;
}

const rowId = (type: string, key: string) => `${type}\u0000${key}`;
const CALL_CHARGE = "\u0000call";
const NEW_OPEN_RECORD = "\u0000new";

export function createAnswerRecordLedger(plan: AnswerRecordPlan): AnswerRecordLedger {
  return { plan, rows: new Map(), refusals: new Map(), issued: new Map(), exhausted: null };
}

function feedbackFor(code: AnswerRecordCode, location: string): string | undefined {
  const hint = OUTPUT_RULE_HINTS[code];
  return hint ? (hint.atLocation?.[location] ?? hint.rule) : undefined;
}

/** Planned keys the ledger still lacks; an open set counts as its closing flag. */
export function remainingAnswerRecordKeys(ledger: AnswerRecordLedger): string[] {
  const remaining: string[] = [];
  for (const [type, planned] of ledger.plan.types) {
    const record = planned.declaration;
    if (record.optional || record.open) continue;
    if (record.key === SINGLETON) {
      if (!ledger.rows.has(rowId(type, SINGLETON))) remaining.push(type);
      continue;
    }
    for (const entry of planned.keys) {
      if (!ledger.rows.has(rowId(type, entry.key))) remaining.push(`${type}:${entry.key}`);
    }
  }
  for (const planned of ledger.plan.types.values()) {
    const closedBy = planned.declaration.closedBy;
    if (!closedBy) continue;
    const [closer, flag] = closedBy.split(".") as [string, string];
    const row = ledger.rows.get(rowId(closer, SINGLETON));
    const closed = row !== undefined && isObject(row.payload) && row.payload[flag] === true;
    if (!closed && !remaining.includes(closer)) remaining.push(closer);
  }
  return remaining;
}

function isOpenRecordSetClosed(
  ledger: AnswerRecordLedger,
  planned: PlannedAnswerRecordType,
): boolean {
  const closedBy = planned.declaration.closedBy;
  if (!closedBy) return false;
  const [closer, flag] = closedBy.split(".") as [string, string];
  const row = ledger.rows.get(rowId(closer, SINGLETON));
  return row !== undefined && isObject(row.payload) && row.payload[flag] === true;
}

function receipt(
  ledger: AnswerRecordLedger,
  status: Exclude<AnswerRecordOutcome, "refused">,
  type: string,
  key: string,
): AnswerRecordReceipt {
  const remaining = remainingAnswerRecordKeys(ledger);
  return { status, type, key, remaining, complete: remaining.length === 0 };
}

function refuse(
  ledger: AnswerRecordLedger,
  denied: AnswerRecordRefusal,
  exhaustPerKeyRefusals = true,
): { ledger: AnswerRecordLedger; receipt: AnswerRecordReceipt } {
  // A refusal is charged to its key; a new open-set record, which has no key
  // yet, to its type; a call that named no declared type, to the call.
  const charge =
    denied.type === null ? CALL_CHARGE : rowId(denied.type, denied.key ?? NEW_OPEN_RECORD);
  const used = ledger.refusals.get(charge) ?? 0;
  const spent =
    ledger.exhausted !== null || (exhaustPerKeyRefusals && used >= ledger.plan.maxRefusalsPerKey);
  const final = spent ? refusal("answer-record-exhausted", "$", denied.type, denied.key) : denied;
  const refusals = new Map(ledger.refusals);
  refusals.set(charge, used + 1);
  const next: AnswerRecordLedger = {
    ...ledger,
    refusals,
    exhausted: spent ? (ledger.exhausted ?? { type: denied.type, key: denied.key }) : null,
  };
  const remaining = remainingAnswerRecordKeys(next);
  const feedback = feedbackFor(final.code, final.location);
  return {
    ledger: next,
    receipt: {
      status: "refused",
      type: final.type,
      key: final.key,
      code: final.code,
      location: final.location,
      retry: final.retry,
      ...(feedback ? { feedback } : {}),
      remaining,
      complete: false,
    },
  };
}

/**
 * Admit or refuse one call against the ledger (design §3.1 step 8 and §3.3):
 * a new key is `admitted`; an existing key with other content is `replaced`,
 * and with the same content `unchanged`; `null` on an issued open-set key is
 * `withdrawn`. An open set issues `<P>-<n>` keys, refuses a record whose
 * content another of its keys already holds, and refuses a new record when
 * it is full; admitted rows are always kept. Every refusal is charged to its
 * key, and the refusal after `maxRefusalsPerKey` is `answer-record-exhausted`.
 * Pure: returns the next ledger.
 */
export function admitAnswerRecordCall(
  ledger: AnswerRecordLedger,
  raw: string | undefined,
  options: { readonly exhaustPerKeyRefusals?: boolean } = {},
): { ledger: AnswerRecordLedger; receipt: AnswerRecordReceipt } {
  const deny = (reason: AnswerRecordRefusal) =>
    refuse(ledger, reason, options.exhaustPerKeyRefusals !== false);
  if (ledger.exhausted) {
    return deny(
      refusal("answer-record-exhausted", "$", ledger.exhausted.type, ledger.exhausted.key),
    );
  }
  const decoded = decodeAnswerRecordCall(ledger.plan, raw);
  if ("refusal" in decoded) return deny(decoded.refusal);
  const { call } = decoded;
  const planned = ledger.plan.types.get(call.type)!;
  const record = planned.declaration;
  if (
    record.open &&
    ledger.plan.enforceClosedSetAdmission &&
    isOpenRecordSetClosed(ledger, planned)
  ) {
    return deny(refusal("answer-record-closed", "$", call.type, call.key));
  }
  const slotMember = record.slotFrom;
  const slot = slotMember === null || !isObject(call.record) ? null : call.record[slotMember];
  if (
    slotMember !== null &&
    call.record !== null &&
    (typeof slot !== "string" || !ledger.plan.selectors[slotMember]?.includes(slot))
  ) {
    return deny(refusal("answer-record-shape", "$.record", call.type, call.key));
  }
  const payloadSha256 = semanticPayloadSha256(record, call.record);
  const rows = new Map(ledger.rows);
  if (record.open) {
    const prefix = planned.serialPrefix!;
    const issued = ledger.issued.get(call.type) ?? 0;
    const serial =
      call.key === null ? null : new RegExp(`^${prefix}-([1-9][0-9]*)$`, "u").exec(call.key);
    if (call.key !== null && (!serial || Number(serial[1]) > issued)) {
      return deny(refusal("answer-record-key", "$.key", call.type));
    }
    const sameContent = [...ledger.rows.values()].find((row) => {
      if (row.type !== call.type || row.key === call.key) return false;
      const priorSlot =
        slotMember === null || !isObject(row.payload) ? null : row.payload[slotMember];
      return priorSlot === slot && semanticPayloadSha256(record, row.payload) === payloadSha256;
    });
    if (call.record !== null && sameContent) {
      return deny(refusal("answer-record-duplicate", "$.record", call.type, call.key));
    }
    const id = call.key === null ? null : rowId(call.type, call.key);
    const existing = id === null ? undefined : ledger.rows.get(id);
    // Every call that would add a row is bounded: a new record, and a
    // withdrawn issued key sent again. Admitted rows are always kept.
    if (call.record !== null && !existing) {
      const open = [...ledger.rows.values()].filter((row) => row.type === call.type).length;
      if (open >= ledger.plan.maxOpenRecordsPerSet) {
        return deny(refusal("answer-record-open-set-bound", "$", call.type, call.key));
      }
    }
    if (call.key === null) {
      const key = `${prefix}-${issued + 1}`;
      rows.set(rowId(call.type, key), {
        type: call.type,
        key,
        payload: call.record,
        payloadSha256,
      });
      const next = { ...ledger, rows, issued: new Map(ledger.issued).set(call.type, issued + 1) };
      return { ledger: next, receipt: receipt(next, "admitted", call.type, key) };
    }
    if (call.record === null) {
      if (!existing) return { ledger, receipt: receipt(ledger, "unchanged", call.type, call.key!) };
      rows.delete(id!);
      const next = { ...ledger, rows };
      return { ledger: next, receipt: receipt(next, "withdrawn", call.type, call.key!) };
    }
    return settle(ledger, rows, call.type, call.key!, call.record, payloadSha256, existing);
  }
  const key = call.key ?? SINGLETON;
  return settle(
    ledger,
    rows,
    call.type,
    key,
    call.record,
    payloadSha256,
    ledger.rows.get(rowId(call.type, key)),
  );
}

/**
 * Charge a domain-owned semantic refusal through the common ledger without
 * inventing an answer-record catalog code. The owner supplies only a
 * catalog-validated code/location pair and retry class; the receipt remains
 * content-free and the normal per-key refusal bound still applies.
 */
export function refuseAnswerRecordCall(
  ledger: AnswerRecordLedger,
  denied: {
    readonly code: string;
    readonly location: string;
    readonly retry: "model-correctable" | "terminal";
    readonly type: string | null;
    readonly key: string | null;
  },
): { ledger: AnswerRecordLedger; receipt: AnswerRecordReceipt } {
  return refuse(ledger, {
    status: "refused",
    code: denied.code as AnswerRecordCode,
    location: denied.location,
    retry: denied.retry,
    type: denied.type,
    key: denied.key,
  });
}

/** Routing members resolve only a finite host slot and are not record content. */
function semanticPayloadSha256(
  declaration: AnswerRecordTypeDeclaration,
  payload: JsonEvidenceValue,
): string {
  if (declaration.slotFrom === null || !isObject(payload)) {
    return sha256(canonicalJson(payload));
  }
  const semantic = Object.fromEntries(
    Object.entries(payload).filter(([name]) => name !== declaration.slotFrom),
  );
  return sha256(canonicalJson(semantic as JsonEvidenceValue));
}

function settle(
  ledger: AnswerRecordLedger,
  rows: Map<string, AnswerRecordRow>,
  type: string,
  key: string,
  payload: JsonEvidenceValue,
  payloadSha256: string,
  existing: AnswerRecordRow | undefined,
): { ledger: AnswerRecordLedger; receipt: AnswerRecordReceipt } {
  if (existing?.payloadSha256 === payloadSha256) {
    return { ledger, receipt: receipt(ledger, "unchanged", type, key) };
  }
  // A replacement keeps the key's first admission position; ledger order is
  // the order keys were first admitted.
  rows.set(rowId(type, key), { type, key, payload, payloadSha256 });
  const next = { ...ledger, rows };
  return { ledger: next, receipt: receipt(next, existing ? "replaced" : "admitted", type, key) };
}

// ---------------------------------------------------------------------------
// Assembly (design §3.4 steps 2-6; checking and settlement are the harness's)

/** One admitted record as assembly places it, with its record-only fields. */
export interface AssembledAnswerRecord {
  readonly type: string;
  readonly key: string;
  readonly slot: string | null;
  readonly payload: JsonEvidenceValue;
  /** Where the record's canonical fields were placed; `null` for a record that fills none. */
  readonly path: ConcretePath | null;
}

export interface AnswerRecordDraft {
  /** The canonical artifact with records placed and host-known members filled; derived members absent. */
  readonly artifact: Record<string, unknown>;
  readonly records: readonly AssembledAnswerRecord[];
}

export type AnswerRecordDerivation =
  | {
      readonly status: "derived";
      readonly artifact: Record<string, unknown>;
      /** Host items for compose parts that name a rule, by `<owner>:<rule>`. */
      readonly hostParts: Readonly<Record<string, readonly unknown[]>>;
    }
  /** The rules leave members open, such as a layer awaiting its residual judgment (O2). */
  | { readonly status: "open"; readonly open: readonly string[] };

export interface AnswerRecordAssemblyInput {
  readonly ledger: AnswerRecordLedger;
  readonly hostMinted: HostMintedValues;
  /** The value of each `field` reference, by namespace. */
  readonly references: Readonly<Record<string, unknown>>;
  /** Each `part` reference namespace's known IDs, from its sealed source. */
  readonly referenceIds: Readonly<Record<string, readonly string[]>>;
  /** The host items one record's links to `namespace` render. */
  readonly renderReference: (namespace: string, ids: readonly string[]) => readonly unknown[];
  /** Fills every derived member (the owner's rule implementations). */
  readonly derive: (
    draft: AnswerRecordDraft,
  ) => AnswerRecordDerivation | Promise<AnswerRecordDerivation>;
}

export type AnswerRecordAssembly =
  | {
      readonly status: "assembled";
      readonly artifact: Record<string, unknown>;
      readonly artifactSha256: string;
      /** Model items dropped because they equal a host item in the same composed member (lossless). */
      readonly droppedDuplicates: number;
    }
  | { readonly status: "incomplete"; readonly remaining: readonly string[] }
  | { readonly status: "open"; readonly open: readonly string[] };

function shapeOf(record: AnswerRecordTypeDeclaration, index: number) {
  return record.shapes[index] ?? hostDefect(`Record type ${record.type} has no shape ${index}.`);
}

/** The record-only fields of a type: everything it adds to its canonical members. */
function stripAddFields(
  record: AnswerRecordTypeDeclaration,
  payload: JsonEvidenceValue,
): JsonEvidenceValue {
  if (!isObject(payload) || record.add.length === 0) return payload;
  return Object.fromEntries(Object.entries(payload).filter(([name]) => !record.add.includes(name)));
}

/**
 * Assemble the canonical artifact from a complete ledger: place each record
 * at its declared location (fixed keys in plan order, open sets in key
 * order), fill the host-minted members, resolve field references, run the
 * owner's derive step, then compose each composed member from its ordered
 * host and model parts, dropping a model item that equals a host item.
 * Returns `incomplete` with the remaining keys, or `open` when the derive
 * step leaves members to judge.
 */
export async function assembleAnswerRecords(
  input: AnswerRecordAssemblyInput,
): Promise<AnswerRecordAssembly> {
  const { ledger } = input;
  const { plan } = ledger;
  const { declaration } = plan;
  const remaining = remainingAnswerRecordKeys(ledger);
  if (remaining.length > 0) return { status: "incomplete", remaining };

  const artifact: Record<string, unknown> = {};
  const records: AssembledAnswerRecord[] = [];
  for (const [type, planned] of plan.types) {
    const record = planned.declaration;
    const rows = [...ledger.rows.values()].filter((row) => row.type === type);
    const ordered =
      planned.keys.length > 0
        ? planned.keys.flatMap((entry) => {
            const row = ledger.rows.get(rowId(type, entry.key));
            return row ? [{ row, slot: entry.slot, shape: entry.shape }] : [];
          })
        : rows
            .sort((left, right) => serialOf(left.key) - serialOf(right.key))
            .map((row) => ({
              row,
              slot:
                planned.declaration.slotFrom === null
                  ? null
                  : (() => {
                      const member = planned.declaration.slotFrom!;
                      const value = isObject(row.payload) ? row.payload[member] : undefined;
                      const allowed = plan.selectors[member];
                      if (typeof value !== "string" || !allowed || !allowed.includes(value)) {
                        hostDefect(`Record type ${type} has no planned slot for ${member}.`);
                      }
                      return value;
                    })(),
              shape: 0,
            }));
    for (const { row, slot, shape } of ordered) {
      const at = shapeOf(record, shape).at;
      if (at === null) {
        records.push({ type, key: row.key, slot, payload: row.payload, path: null });
        continue;
      }
      const path = placementPath(artifact, parseRecordLocation(at), slot, plan.selectors);
      writeAt(artifact, path, structuredClone(stripAddFields(record, row.payload)));
      records.push({ type, key: row.key, slot, payload: row.payload, path });
    }
  }
  // Initialize closed, empty open collections after every record has placed
  // its parent objects so declaration order cannot hide a collection path.
  for (const planned of plan.types.values()) {
    const record = planned.declaration;
    if (record.open !== true || [...ledger.rows.values()].some((row) => row.type === record.type)) {
      continue;
    }
    for (const shape of record.shapes) {
      if (shape.at === null) continue;
      const segments = parseRecordLocation(shape.at);
      if (!segments.at(-1) || !("items" in segments.at(-1)!)) continue;
      for (const path of instances(artifact, segments.slice(0, -1), plan.selectors)) {
        const value = readAt(artifact, path);
        if (value === undefined) writeAt(artifact, path, []);
        else if (!Array.isArray(value)) {
          hostDefect(
            `The closed empty record set ${record.type} requires an array at ${shape.at}.`,
          );
        }
      }
    }
  }
  const recordKeyAt = (path: ConcretePath) =>
    records.find((entry) => entry.path !== null && isPrefix(entry.path, path))?.key;
  const filled = fillHostMinted(declaration, artifact, input.hostMinted, {
    recordKeyAt,
    selectors: plan.selectors,
    requireAll: true,
  }).artifact;
  for (const reference of declaration.references) {
    if (reference.field === null) continue;
    if (!Object.hasOwn(input.references, reference.namespace)) {
      hostDefect(`Reference ${reference.namespace} is not resolved.`);
    }
    writeAt(
      filled,
      concretePath(reference.field),
      structuredClone(input.references[reference.namespace]),
    );
  }

  const derivation = await input.derive({ artifact: filled, records });
  if (derivation.status === "open") return { status: "open", open: derivation.open };
  const derived = structuredClone(derivation.artifact);
  for (const entry of declaration.derive) {
    const segments = parseRecordLocation(entry.field);
    for (const path of instances(derived, segments.slice(0, -1), plan.selectors)) {
      // A nullable record's null value has no members to derive.
      if (!isObject(readAt(derived, path))) continue;
      const last = segments.at(-1)!;
      const names =
        "prop" in last
          ? [last.prop]
          : "selector" in last
            ? (plan.selectors[last.selector] ?? [])
            : Object.keys(readAt(derived, path) as object);
      for (const name of names) {
        if (readAt(derived, [...path, name]) === undefined) {
          hostDefect(`The derive step left ${entry.field} (${entry.rule}) unset.`);
        }
      }
    }
  }

  let droppedDuplicates = 0;
  for (const entry of declaration.compose) {
    const segments = parseRecordLocation(entry.field);
    const parentPaths = instances(derived, segments.slice(0, -1), plan.selectors);
    const last = segments.at(-1)!;
    if (!("prop" in last)) hostDefect(`Composed member ${entry.field} must end in a member name.`);
    for (const parent of parentPaths) {
      if (!isObject(readAt(derived, parent))) continue;
      const path = [...parent, last.prop];
      const owner = records.find((record) => record.path !== null && isPrefix(record.path, path));
      const composed: { readonly item: unknown; readonly host: boolean }[] = [];
      for (const part of entry.parts) {
        const items =
          "host" in part
            ? part.host.startsWith("reference:")
              ? referenceItems(plan, input, owner, part.host.slice("reference:".length))
              : (derivation.hostParts[part.host] ??
                hostDefect(`The derive step returned no items for ${part.host}.`))
            : modelItems(plan, records, derived, path, part.model, wildcardSlot(segments, path));
        for (const item of items) composed.push({ item, host: "host" in part });
      }
      // A model item byte-identical to a host item adds nothing; dropping it
      // loses no information and keeps uniqueItems members valid.
      const hostItems = new Set(
        composed.filter((entry) => entry.host).map((entry) => canonicalJson(entry.item)),
      );
      const kept = composed.flatMap((entry) => {
        if (entry.host || !hostItems.has(canonicalJson(entry.item))) return [entry.item];
        droppedDuplicates += 1;
        return [];
      });
      writeAt(derived, path, structuredClone(kept));
    }
  }
  return {
    status: "assembled",
    artifact: derived,
    artifactSha256: sha256(canonicalJson(derived)),
    droppedDuplicates,
  };
}

function serialOf(key: string): number {
  return Number(/-([0-9]+)$/u.exec(key)?.[1] ?? Number.NaN);
}

function concretePath(location: string): ConcretePath {
  return parseRecordLocation(location).map((segment) =>
    "prop" in segment ? segment.prop : hostDefect(`${location} must name one member.`),
  );
}

/** The concrete path a record goes to: its slot fills `*`, and a final `[]` appends. */
function placementPath(
  artifact: Record<string, unknown>,
  segments: readonly Segment[],
  slot: string | null,
  selectors: Readonly<Record<string, readonly string[]>>,
): ConcretePath {
  const path: (string | number)[] = [];
  segments.forEach((segment, index) => {
    if ("prop" in segment) path.push(segment.prop);
    else if ("any" in segment) path.push(slot ?? hostDefect("A keyed location needs a slot."));
    else if ("selector" in segment) {
      const selected = slot ?? hostDefect("A selected location needs a host-planned slot.");
      const ordinal = selectors[segment.selector]?.indexOf(selected) ?? -1;
      if (ordinal < 0) hostDefect(`Location selector ${segment.selector} has no planned slot.`);
      path.push(ordinal);
    } else if ("items" in segment && index === segments.length - 1) {
      const existing = readAt(artifact, path);
      if (existing === undefined) writeAt(artifact, path, []);
      path.push((readAt(artifact, path) as unknown[]).length);
    } else hostDefect("A record location may append only at its end.");
  });
  return path;
}

/** The member a location's `*` matched in a concrete path, for a keyed note's slot. */
function wildcardSlot(segments: readonly Segment[], path: ConcretePath): string | null {
  const index = segments.findIndex((segment) => "any" in segment);
  return index < 0 ? null : String(path[index]);
}

function modelItems(
  plan: AnswerRecordPlan,
  records: readonly AssembledAnswerRecord[],
  artifact: Record<string, unknown>,
  path: ConcretePath,
  part: string,
  slot: string | null,
): unknown[] {
  const [type, name] = part.split(".") as [string, string];
  const planned = plan.types.get(type) ?? hostDefect(`Compose names undeclared type ${type}.`);
  const record = planned.declaration;
  const asList = (value: unknown) =>
    value === undefined ? [] : Array.isArray(value) ? value : [value];
  if (!record.add.includes(name)) return asList(readAt(artifact, path));
  const holder = records.find(
    (entry) => entry.type === type && (record.key === SINGLETON || entry.slot === slot),
  );
  if (!holder) {
    if (record.optional && record.default === "empty") return [];
    hostDefect(`No ${type} record holds the composed member.`);
  }
  return asList(isObject(holder.payload) ? holder.payload[name] : undefined);
}

function referenceItems(
  plan: AnswerRecordPlan,
  input: AnswerRecordAssemblyInput,
  owner: AssembledAnswerRecord | undefined,
  part: string,
): readonly unknown[] {
  const reference = plan.declaration.references.find((entry) => entry.part === part);
  if (!reference) hostDefect(`Compose names undeclared reference part ${part}.`);
  if (!owner) hostDefect(`No record holds the links for ${part}.`);
  const record = plan.types.get(owner.type)!.declaration;
  const known = new Set(input.referenceIds[reference.namespace] ?? []);
  const ids: string[] = [];
  for (const name of record.add) {
    const shape = record.shapes[0]?.shape as {
      properties?: Record<string, { items?: Record<string, unknown> }>;
    };
    const source = shape.properties?.[name]?.items?.["x-docsfab-enum-source"];
    if (typeof source !== "string" || !source.startsWith("references:")) continue;
    const namespaces = source.slice("references:".length).split("+");
    if (!namespaces.includes(reference.namespace)) continue;
    const linked = isObject(owner.payload) ? owner.payload[name] : undefined;
    for (const id of Array.isArray(linked) ? linked : []) {
      // Admission resolves every link (design §3.1 step 7), so a link no
      // namespace knows reaching assembly is a host defect, never dropped.
      const resolved = namespaces.some((namespace) =>
        (input.referenceIds[namespace] ?? []).includes(id as string),
      );
      if (typeof id !== "string" || !resolved) {
        hostDefect(`A ${owner.type} link reached assembly unresolved in ${namespaces.join(", ")}.`);
      }
      if (known.has(id) && !ids.includes(id)) ids.push(id);
    }
  }
  return ids.length === 0 ? [] : input.renderReference(reference.namespace, ids);
}
