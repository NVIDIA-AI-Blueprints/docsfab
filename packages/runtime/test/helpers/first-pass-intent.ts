// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Recorded request interpretations for first-pass binding tests: a sealed
 * intent built from quotes found in the operator's own NFC instruction, and
 * the run-record field an interpretation step writes around it.
 */
import { createHash } from "node:crypto";

import type {
  RequestIntentAdvisoryCode,
  RequestIntentConstraintKind,
  RequestIntentOperation,
  RequestIntentQuestion,
  RequestIntentQuote,
  RequestIntentTargetOrigin,
  RequestIntentTargetRole,
  RequestIntentV1,
} from "../../src/request-intent/contract.js";
import type {
  RequestIntentAdmissionOutcome,
  RunRecordRequestIntentV1,
} from "../../src/request-intent/interpret-record.js";
import { requestInstructionSha256 } from "../../src/request-intent/quote.js";
import { sealRequestIntent } from "../../src/request-intent/seal.js";

export interface IntentTargetSpec {
  readonly path: string;
  readonly quote: string;
  readonly role?: RequestIntentTargetRole;
  readonly chosenFrom?: RequestIntentTargetOrigin;
}

export interface IntentSpec {
  readonly operation: RequestIntentOperation;
  readonly targets: readonly IntentTargetSpec[];
  readonly sources?: readonly { readonly path: string; readonly quote: string }[];
  readonly exclusions?: readonly { readonly path: string; readonly quote: string }[];
  readonly preserve?: readonly string[];
  readonly constraints?: readonly {
    readonly kind: RequestIntentConstraintKind;
    readonly quote: string;
  }[];
  readonly question?: RequestIntentQuestion;
}

const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

/** The first occurrence of `text` in the NFC instruction, as a sealed quote. */
export function quoteOf(instruction: string, text: string): RequestIntentQuote {
  const nfc = instruction.normalize("NFC");
  const wanted = text.normalize("NFC");
  const start = nfc.indexOf(wanted);
  if (start < 0) throw new Error(`fixture quote is not in the instruction: ${text}`);
  return { text: wanted, start, end: start + wanted.length };
}

/** A sealed intent over `instruction`; its quotes are the operator's own text. */
export function sealedIntent(instruction: string, spec: IntentSpec): RequestIntentV1 {
  const quote = (text: string) => quoteOf(instruction, text);
  return sealRequestIntent({
    instructionSha256: requestInstructionSha256(instruction),
    operation: spec.operation,
    targets: spec.targets.map((target) => ({
      path: target.path,
      role: target.role ?? "write",
      chosenFrom: target.chosenFrom ?? (spec.operation === "create" ? "proposed-new" : "named"),
      quote: quote(target.quote),
    })),
    sources: (spec.sources ?? []).map((entry) => ({ path: entry.path, quote: quote(entry.quote) })),
    preserve: (spec.preserve ?? []).map((text) => ({ quote: quote(text) })),
    exclusions: (spec.exclusions ?? []).map((entry) => ({
      path: entry.path,
      quote: quote(entry.quote),
    })),
    constraints: (spec.constraints ?? []).map((entry) => ({
      kind: entry.kind,
      quote: quote(entry.quote),
    })),
    authorityPreference: { preference: "unspecified", quote: null },
    question: spec.question ?? null,
  });
}

const ONE_CALL = [
  {
    promptSha256: sha("fixture interpretation prompt"),
    responseSha256: sha("fixture interpretation reply"),
    inputTokens: 3,
    outputTokens: 2,
  },
] as const;

/** The run-record field an interpretation that reached the model writes. */
export function recordedIntent(
  instruction: string,
  spec: IntentSpec,
  outcome: Extract<
    RequestIntentAdmissionOutcome,
    "admitted" | "question" | "rejected" | "refused" | "unavailable"
  > = "admitted",
): RunRecordRequestIntentV1 {
  const sealed = outcome === "admitted" || outcome === "question";
  return {
    schemaVersion: 1,
    admission: {
      outcome,
      code: outcome === "admitted" ? null : `request-intent-fixture-${outcome}`,
      location: null,
      reason: null,
      boundary: null,
      calls: [...ONE_CALL],
      clippedTitles: 0,
    },
    intent: sealed ? sealedIntent(instruction, spec) : null,
  };
}

/**
 * The run-record field for a reading the run went on past as an advisory: a
 * sealed reading and the advisory's code. Only a model question keeps the
 * reading's question.
 */
export function advisoryIntent(
  instruction: string,
  spec: IntentSpec,
  code: RequestIntentAdvisoryCode,
): RunRecordRequestIntentV1 {
  return {
    schemaVersion: 1,
    admission: {
      outcome: "advisory",
      code,
      location: null,
      reason: null,
      boundary: null,
      calls: [...ONE_CALL],
      clippedTitles: 0,
    },
    intent: sealedIntent(instruction, spec),
  };
}

/** The run-record field for a run the interpretation did not read. */
export function notInterpreted(
  outcome: "offline" | "not-applicable" | "continuation",
): RunRecordRequestIntentV1 {
  const reason =
    outcome === "offline"
      ? "pi-offline"
      : outcome === "continuation"
        ? "knowledge-continuation"
        : "instruction-absent";
  return {
    schemaVersion: 1,
    admission: {
      outcome,
      code: null,
      location: null,
      reason,
      boundary: null,
      calls: [],
      clippedTitles: 0,
    },
    intent: null,
  };
}
