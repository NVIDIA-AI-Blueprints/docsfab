// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { types as nodeUtilTypes } from "node:util";

/** Existing strict wire ceiling in UTF-16 code units; chunk producers share this guard's bound. */
export const INERT_TRANSPORT_MAX_STRING_CHARS = 65_536;

export function normalizeReaderContextInputTransportV1(value, hooks) {
  assertInert(value, hooks.fail);
  hooks.rejectCredentials(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) hooks.fail("invalid-shape");
  const keys = [
    "schema_version",
    "target_audience",
    "reader_job",
    "change_scope",
    "source_priority",
    "required_content",
    "excluded_content",
    "unresolved_questions",
    "known_limitations",
  ];
  const required = keys.filter((key) => key !== "known_limitations");
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    hooks.fail("invalid-shape");
  if (value.schema_version !== 1) hooks.fail("invalid-value");
  const text = (candidate, maximum) => {
    if (
      typeof candidate !== "string" ||
      candidate !== candidate.normalize("NFC") ||
      candidate.includes("\r") ||
      !/\S/u.test(candidate) ||
      [...candidate].length > maximum
    )
      hooks.fail("invalid-value");
    return candidate;
  };
  const texts = (candidate, minimum, maximum, codePoints) => {
    if (!Array.isArray(candidate)) hooks.fail("invalid-shape");
    const parsed = candidate.map((item) => text(item, codePoints));
    if (
      parsed.length < minimum ||
      parsed.length > maximum ||
      new Set(parsed).size !== parsed.length
    )
      hooks.fail("invalid-value");
    return parsed;
  };
  const result = {
    schema_version: 1,
    target_audience: text(value.target_audience, 1_024),
    reader_job: text(value.reader_job, 1_024),
    change_scope: texts(value.change_scope, 1, 32, 1_024),
    source_priority: texts(value.source_priority, 1, 64, 4_096),
    required_content: texts(value.required_content, 1, 64, 4_096),
    excluded_content: texts(value.excluded_content, 0, 64, 4_096),
    unresolved_questions: texts(value.unresolved_questions, 0, 64, 4_096),
    ...(value.known_limitations === undefined
      ? {}
      : { known_limitations: texts(value.known_limitations, 0, 64, 4_096) }),
  };
  if (Buffer.byteLength(canonicalJson(result), "utf8") > 64 * 1024) hooks.fail("size-exceeded");
  return freezeDeep(result);
}

export function normalizeReaderSourceHintTransportV1(value, hooks) {
  assertInert(value, hooks.fail);
  hooks.rejectCredentials(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) hooks.fail("invalid-shape");
  if (
    Object.keys(value).length !== 2 ||
    !Object.hasOwn(value, "role") ||
    !Object.hasOwn(value, "path")
  )
    hooks.fail("invalid-shape");
  if (
    typeof value.role !== "string" ||
    ![
      "public-contract",
      "changed-source",
      "current-documentation",
      "repository-instruction",
      "accepted-knowledge",
      "request",
    ].includes(value.role)
  )
    hooks.fail("invalid-value");
  if (typeof value.path !== "string" || !safePath(value.path)) hooks.fail("invalid-value");
  return freezeDeep({ role: value.role, path: value.path });
}

function safePath(value) {
  return (
    value.length > 0 &&
    value.length <= 4_096 &&
    value === value.normalize("NFC") &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    !value.startsWith("/") &&
    !/^[A-Za-z]:/u.test(value) &&
    value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..")
  );
}

function inspectTransportData(value, fail, projection) {
  let nodes = 0;
  const active = new Set();
  const visit = (candidate, depth) => {
    nodes += 1;
    if (!projection && (nodes > 100_000 || depth > 64)) fail("invalid-shape");
    if (projection && candidate === undefined) return;
    if (candidate === null || typeof candidate === "boolean") return;
    if (typeof candidate === "string") {
      if (!projection && candidate.length > INERT_TRANSPORT_MAX_STRING_CHARS) fail("invalid-value");
      return;
    }
    if (typeof candidate === "number") {
      if (
        !projection &&
        (!Number.isFinite(candidate) ||
          Object.is(candidate, -0) ||
          (Number.isInteger(candidate) && !Number.isSafeInteger(candidate)))
      )
        fail("invalid-value");
      return;
    }
    if (
      candidate === undefined ||
      typeof candidate !== "object" ||
      nodeUtilTypes.isProxy(candidate) ||
      active.has(candidate)
    )
      fail("invalid-shape");
    const array = Array.isArray(candidate);
    const proto = Object.getPrototypeOf(candidate);
    if (
      (array && proto !== Array.prototype) ||
      (!array && proto !== Object.prototype && proto !== null)
    )
      fail("invalid-shape");
    active.add(candidate);
    const keys = Reflect.ownKeys(candidate);
    if (
      keys.some((key) => typeof key !== "string") ||
      (!projection && array && keys.length !== candidate.length + 1)
    )
      fail("invalid-shape");
    for (const key of keys) {
      if (array && key === "length") continue;
      const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
      if (!descriptor || (!projection && !descriptor.enumerable) || !("value" in descriptor))
        fail("invalid-shape");
      visit(descriptor.value, depth + 1);
    }
    active.delete(candidate);
  };
  visit(value, 0);
}

function assertInert(value, fail) {
  inspectTransportData(value, fail, false);
}

/** Native-Node-compatible terminal projection. Undefined optional fields use
 * JSON wire semantics only after every original own property is inert data. */
export function projectInertTransportRecord(value, fail) {
  try {
    inspectTransportData(value, fail, true);
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    )
      fail("terminal-record-shape");
    const copy = JSON.parse(JSON.stringify(value));
    if (!copy || typeof copy !== "object" || Array.isArray(copy)) fail("terminal-record-shape");
    return copy;
  } catch {
    return fail("terminal-record-shape");
  }
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

function freezeDeep(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

/** Shared inert transport guard; it grants no source or operation authority. */
export { assertInert as assertInertTransportData };

/** Shared conservative intent defaults; callers apply their canonical validation. */
export function conservativeReaderContextInputTransport(input) {
  // The full request is retained separately as request:instruction and passed to
  // every workflow step. These bounded intent fields must not duplicate an MR
  // evidence packet or reject an otherwise supported long instruction.
  const requestLength = [...input.instruction].length;
  return {
    schema_version: 1,
    target_audience: "documentation readers",
    reader_job:
      requestLength <= 1_024
        ? input.instruction
        : "Complete the documentation update described in the full request:instruction evidence.",
    change_scope:
      input.changeScope && input.changeScope.length > 0
        ? [...input.changeScope]
        : ["documentation scope selected by the validated plan"],
    source_priority: [
      "request",
      "current documentation",
      "current public contract",
      "changed source when available",
    ],
    required_content: [
      requestLength <= 4_096
        ? input.instruction
        : "Preserve all applicable requirements and exclusions in the full request:instruction evidence.",
    ],
    excluded_content: ["unrelated documentation and implementation details"],
    // The host's own directive is a limitation, not an open reader question:
    // an unresolved question would make every no-change structurally
    // unreachable for an ordinary request.
    unresolved_questions: [],
    known_limitations: [
      "No explicit reader-impact brief was supplied; independently establish audience, scope, and evidence from the request and the repository.",
      "Conservative fallback context: a no-change candidate needs the evidence the reader-impact baseline names. Unless a base and head commit comparison declares the change, that can be a plan that keeps every planned page unchanged, each kept page admitted as current documentation. Independent read-only checks must confirm it.",
    ],
  };
}
