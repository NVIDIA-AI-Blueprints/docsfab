// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { ANSWER_RECORD_TYPES, type AnswerRecordType } from "./codecs.js";
import { MESSAGE_RUNGS } from "./planning.js";
import { canonicalDigest } from "../../content-ir/canonical.js";
import type {
  AnswerRecordDiagnosticEvidence,
  AnswerRecordExactQualificationEvidence,
} from "../answer-record-probe.js";

export const ANSWER_RECORD_DIAGNOSTIC_PURPOSE = "transport-call-assembly-diagnostic-only" as const;

/** Closed validation for diagnostic evidence retained in the shared ledger. */
export function isAnswerRecordDiagnosticEvidence(
  value: unknown,
): value is AnswerRecordDiagnosticEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const keys = [
    "schemaVersion",
    "kind",
    "purpose",
    "diagnosticFingerprint",
    "qualificationFingerprint",
    "modelId",
    "routeId",
    "transport",
    "deploymentIdentitySha256",
    "compositionId",
    "compositionSha256",
    "requestPolicySha256",
    "systemPromptSha256",
    "installedSystemInstructionCanonicalDigest",
    "corpusSha256",
    "shell",
    "requestOptions",
    "maxOutputTokens",
    "paddingTargetTokens",
    "cell",
  ];
  if (Object.keys(row).length !== keys.length || keys.some((key) => !Object.hasOwn(row, key))) {
    return false;
  }
  const digest = (item: unknown): item is string =>
    typeof item === "string" && /^[a-f0-9]{64}$/u.test(item);
  if (
    row.schemaVersion !== 1 ||
    row.kind !== "docsfab-answer-record-diagnostic" ||
    row.purpose !== ANSWER_RECORD_DIAGNOSTIC_PURPOSE ||
    !digest(row.diagnosticFingerprint) ||
    !digest(row.qualificationFingerprint) ||
    typeof row.modelId !== "string" ||
    row.modelId.length === 0 ||
    typeof row.routeId !== "string" ||
    row.routeId.length === 0 ||
    row.transport !== "openai-chat-completions" ||
    !digest(row.deploymentIdentitySha256) ||
    typeof row.compositionId !== "string" ||
    row.compositionId.length === 0 ||
    !digest(row.compositionSha256) ||
    !digest(row.requestPolicySha256) ||
    !digest(row.systemPromptSha256) ||
    !digest(row.installedSystemInstructionCanonicalDigest) ||
    !digest(row.corpusSha256) ||
    row.shell !== "typed" ||
    !isAnswerRecordDiagnosticRequestOptions(row.requestOptions) ||
    !Number.isSafeInteger(row.maxOutputTokens) ||
    (row.maxOutputTokens as number) <= 0 ||
    !Number.isSafeInteger(row.paddingTargetTokens) ||
    (row.paddingTargetTokens as number) <= 0 ||
    !isAnswerRecordDiagnosticCell(row.cell)
  ) {
    return false;
  }
  const { diagnosticFingerprint, ...binding } = row;
  return canonicalDigest(binding) === diagnosticFingerprint;
}

function isAnswerRecordDiagnosticRequestOptions(
  value: unknown,
): value is AnswerRecordDiagnosticEvidence["requestOptions"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const options = value as Record<string, unknown>;
  return (
    Object.keys(options).length === 2 &&
    Object.hasOwn(options, "toolChoice") &&
    Object.hasOwn(options, "parallelToolCalls") &&
    options.toolChoice === "required" &&
    options.parallelToolCalls === "omitted"
  );
}

function isAnswerRecordDiagnosticCell(
  value: unknown,
): value is AnswerRecordDiagnosticEvidence["cell"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const cell = value as Record<string, unknown>;
  if (
    Object.keys(cell).length !== 7 ||
    ![
      "phase",
      "rungBytes",
      "seed",
      "plannedBytes",
      "paddingChars",
      "estimatedInputTokens",
      "calls",
    ].every((key) => Object.hasOwn(cell, key)) ||
    cell.phase !== "B" ||
    cell.rungBytes !== MESSAGE_RUNGS[0] ||
    cell.seed !== 1 ||
    cell.plannedBytes !== MESSAGE_RUNGS[0] ||
    !Number.isSafeInteger(cell.paddingChars) ||
    (cell.paddingChars as number) < 0 ||
    !Number.isSafeInteger(cell.estimatedInputTokens) ||
    (cell.estimatedInputTokens as number) <= 0 ||
    !Array.isArray(cell.calls) ||
    cell.calls.length !== 9
  ) {
    return false;
  }
  return cell.calls.every((call) => {
    if (!call || typeof call !== "object" || Array.isArray(call)) return false;
    const row = call as Record<string, unknown>;
    return (
      Object.keys(row).length === 3 &&
      Object.hasOwn(row, "type") &&
      Object.hasOwn(row, "rawBytes") &&
      Object.hasOwn(row, "stringifiedNull") &&
      typeof row.type === "string" &&
      ANSWER_RECORD_TYPES.includes(row.type as AnswerRecordType) &&
      Number.isSafeInteger(row.rawBytes) &&
      (row.rawBytes as number) > 0 &&
      typeof row.stringifiedNull === "boolean"
    );
  });
}

/** Validate the single closed exact-qualification evidence shape and its fingerprint. */
export function isAnswerRecordExactQualificationEvidence(
  value: unknown,
): value is AnswerRecordExactQualificationEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const keys = [
    "schemaVersion",
    "qualificationFingerprint",
    "modelId",
    "routeId",
    "transport",
    "deploymentIdentitySha256",
    "compositionId",
    "compositionSha256",
    "requestPolicySha256",
    "systemPromptSha256",
    "installedSystemInstructionCanonicalDigest",
    "corpusSha256",
    "shell",
    "maxOutputTokens",
    "paddingTargetTokens",
    "cells",
  ];
  if (Object.keys(row).length !== keys.length || keys.some((key) => !Object.hasOwn(row, key)))
    return false;
  const digest = (item: unknown): item is string =>
    typeof item === "string" && /^[a-f0-9]{64}$/u.test(item);
  if (
    row.schemaVersion !== 1 ||
    !digest(row.qualificationFingerprint) ||
    typeof row.modelId !== "string" ||
    row.modelId.length === 0 ||
    typeof row.routeId !== "string" ||
    row.routeId.length === 0 ||
    row.transport !== "openai-chat-completions" ||
    !digest(row.deploymentIdentitySha256) ||
    typeof row.compositionId !== "string" ||
    row.compositionId.length === 0 ||
    !digest(row.compositionSha256) ||
    !digest(row.requestPolicySha256) ||
    !digest(row.systemPromptSha256) ||
    !digest(row.installedSystemInstructionCanonicalDigest) ||
    !digest(row.corpusSha256) ||
    (row.shell !== "typed" && row.shell !== "untyped") ||
    !Number.isSafeInteger(row.maxOutputTokens) ||
    (row.maxOutputTokens as number) <= 0 ||
    !Number.isSafeInteger(row.paddingTargetTokens) ||
    (row.paddingTargetTokens as number) <= 0 ||
    !Array.isArray(row.cells) ||
    row.cells.length === 0
  )
    return false;
  for (const cell of row.cells) {
    if (!cell || typeof cell !== "object" || Array.isArray(cell)) return false;
    const c = cell as Record<string, unknown>;
    if (
      Object.keys(c).length !== 7 ||
      [
        "phase",
        "rungBytes",
        "seed",
        "plannedBytes",
        "paddingChars",
        "estimatedInputTokens",
        "calls",
      ].some((key) => !Object.hasOwn(c, key))
    )
      return false;
    if (
      typeof c.phase !== "string" ||
      !Number.isSafeInteger(c.rungBytes) ||
      (c.rungBytes as number) <= 0 ||
      !Number.isSafeInteger(c.seed) ||
      !Number.isSafeInteger(c.plannedBytes) ||
      (c.plannedBytes as number) <= 0 ||
      !Number.isSafeInteger(c.paddingChars) ||
      (c.paddingChars as number) < 0 ||
      !Number.isSafeInteger(c.estimatedInputTokens) ||
      (c.estimatedInputTokens as number) <= 0 ||
      !Array.isArray(c.calls) ||
      c.calls.length === 0
    )
      return false;
    for (const call of c.calls) {
      if (!call || typeof call !== "object" || Array.isArray(call)) return false;
      const callRow = call as Record<string, unknown>;
      if (
        Object.keys(callRow).length !== 3 ||
        !["type", "rawBytes", "stringifiedNull"].every((key) => Object.hasOwn(callRow, key)) ||
        typeof callRow.type !== "string" ||
        !Number.isSafeInteger(callRow.rawBytes) ||
        (callRow.rawBytes as number) <= 0 ||
        typeof callRow.stringifiedNull !== "boolean"
      )
        return false;
    }
  }
  const { qualificationFingerprint, ...identity } = row;
  return canonicalDigest(identity) === qualificationFingerprint;
}
