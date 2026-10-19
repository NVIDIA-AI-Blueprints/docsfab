// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The run-record field the request interpretation writes, its strict decode,
 * and the INTENT lines `runs show` prints.
 *
 * Readers of model content verify the sealed intent against the record's own
 * `instruction`. Naming reads only the complete host admission marker, never
 * model content. The seal is an unkeyed digest: verification proves the intent
 * is consistent with that instruction, not that nobody edited both.
 */
import { OUTPUT_RULES } from "../contracts/model-output.js";
import {
  isRequestIntentAdvisoryCode,
  REQUEST_INTENT_PATH_SCOPE_KINDS,
  type RequestIntentBoundary,
  type RequestIntentPathScope,
  type RequestIntentV1,
} from "./contract.js";
import { isRepositoryRelativePath } from "./decode.js";
import { RequestIntentContractError } from "./kit.js";
import { verifyRequestIntentDigest } from "./seal.js";

/** Protocol constant: the only record schema this module reads or writes. */
export const RUN_RECORD_REQUEST_INTENT_SCHEMA_VERSION = 1 as const;

/**
 * How the interpretation step ended. `advisory` is a reading the run went on
 * with, recorded under its finding's code. `unavailable` covers both a
 * provider failure and the interpretation's own deadline; the code tells them
 * apart.
 */
export const REQUEST_INTENT_ADMISSION_OUTCOMES = [
  "admitted",
  "advisory",
  "question",
  "rejected",
  "refused",
  "unavailable",
  "offline",
  "not-applicable",
  "continuation",
] as const;
export type RequestIntentAdmissionOutcome = (typeof REQUEST_INTENT_ADMISSION_OUTCOMES)[number];

/** Outcomes after which the run goes on to its first step. */
export const REQUEST_INTENT_CONTINUING_OUTCOMES = [
  "admitted",
  "advisory",
  "offline",
  "not-applicable",
  "continuation",
] as const satisfies readonly RequestIntentAdmissionOutcome[];

/** Why the step did not ask the model; closed host vocabulary. */
export const REQUEST_INTENT_NOT_RUN_REASONS = {
  "not-applicable": ["workflow-without-operation", "instruction-absent"],
  continuation: ["knowledge-continuation", "operator-input-resume"],
  offline: ["pi-offline"],
} as const;
export type RequestIntentNotRunReason =
  (typeof REQUEST_INTENT_NOT_RUN_REASONS)[keyof typeof REQUEST_INTENT_NOT_RUN_REASONS][number];

/** One model call: digests and token counts only, never prompt or reply text. */
export interface RequestIntentInterpretationCallV1 {
  readonly promptSha256: string;
  /** Null when the call returned no reply. */
  readonly responseSha256: string | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface RequestIntentAdmissionRecordV1 {
  readonly outcome: RequestIntentAdmissionOutcome;
  /** The catalog or host code of a stop or an advisory; null otherwise. */
  readonly code: string | null;
  /** The concrete proposal location the code was raised at, when it has one. */
  readonly location: string | null;
  readonly reason: RequestIntentNotRunReason | null;
  /** The boundary an authority refusal crossed. */
  readonly boundary: RequestIntentBoundary | null;
  readonly calls: readonly RequestIntentInterpretationCallV1[];
  /** Inventory titles shown to the model cut at `requestIntent.maxInventoryTitleChars`. */
  readonly clippedTitles: number;
}

/** `RunRecord.requestIntent`. */
export interface RunRecordRequestIntentV1 {
  readonly schemaVersion: typeof RUN_RECORD_REQUEST_INTENT_SCHEMA_VERSION;
  readonly admission: RequestIntentAdmissionRecordV1;
  /**
   * The sealed intent: admitted, the advisory reading, or the one a
   * `question` was asked about. Consumers gate on
   * `admission.outcome === "admitted"`, never on this being non-null.
   */
  readonly intent: RequestIntentV1 | null;
}

const RECORD_KEYS = ["schemaVersion", "admission", "intent"] as const;
const ADMISSION_KEYS = [
  "outcome",
  "code",
  "location",
  "reason",
  "boundary",
  "calls",
  "clippedTitles",
] as const;
const CALL_KEYS = ["promptSha256", "responseSha256", "inputTokens", "outputTokens"] as const;
/** Each boundary kind's exact keys; `observed` and `remediation` are common to all. */
const BOUNDARY_KEYS: Readonly<Record<RequestIntentBoundary["kind"], readonly string[]>> = {
  "internal-segment": ["kind", "segment", "observed", "remediation"],
  "write-grant": ["kind", "observed", "remediation"],
  "docs-root": ["kind", "roots", "observed", "remediation"],
  "write-scope": ["kind", "grant", "observed", "remediation"],
};
const SHA256 = /^[a-f0-9]{64}$/u;
const CODE = /^[a-z](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;

/**
 * Decode `RunRecord.requestIntent` and verify its sealed intent against the
 * record's instruction. Throws `RequestIntentContractError` for any shape
 * fault or a sealed intent that does not verify.
 */
export function decodeRunRecordRequestIntent(
  value: unknown,
  instruction: unknown,
): RunRecordRequestIntentV1 {
  const { root, admission, sealed } = decodeRequestIntentEnvelope(value);
  const intent = sealed
    ? verifyRequestIntentDigest(root.intent, typeof instruction === "string" ? instruction : "")
    : null;
  if (admission.outcome === "question") shape(intent?.question !== null);
  // An advisory asked nothing and the run went on; only the model's own
  // question is kept, unanswered.
  if (admission.outcome === "advisory") {
    shape(
      admission.code === "request-intent-model-question"
        ? intent?.question !== null
        : intent?.question === null,
    );
  }
  return { schemaVersion: RUN_RECORD_REQUEST_INTENT_SCHEMA_VERSION, admission, intent };
}

/**
 * Decode the complete host marker without interpreting or verifying the model
 * reading. Naming uses this projection: model content and its digest supply
 * no original-input authority. Missing fields are never defaulted to null.
 */
export function decodeRunRecordRequestIntentAdmission(
  value: unknown,
): RequestIntentAdmissionRecordV1 {
  return decodeRequestIntentEnvelope(value).admission;
}

/** Shared envelope and host metadata contract for full-record and naming readers. */
function decodeRequestIntentEnvelope(value: unknown): {
  root: Record<string, unknown>;
  admission: RequestIntentAdmissionRecordV1;
  sealed: boolean;
} {
  const root = exactObject(value, RECORD_KEYS);
  shape(root.schemaVersion === RUN_RECORD_REQUEST_INTENT_SCHEMA_VERSION);
  const admission = decodeAdmission(root.admission);
  const sealed =
    admission.outcome === "admitted" ||
    admission.outcome === "advisory" ||
    admission.outcome === "question";
  shape(
    sealed
      ? typeof root.intent === "object" && root.intent !== null && !Array.isArray(root.intent)
      : root.intent === null,
  );
  return { root, admission, sealed };
}

function decodeAdmission(value: unknown): RequestIntentAdmissionRecordV1 {
  const root = exactObject(value, ADMISSION_KEYS);
  const outcome = root.outcome as RequestIntentAdmissionOutcome;
  shape((REQUEST_INTENT_ADMISSION_OUTCOMES as readonly unknown[]).includes(outcome));
  const stopped = !(REQUEST_INTENT_CONTINUING_OUTCOMES as readonly string[]).includes(outcome);
  // A stop and an advisory each carry the code they were raised under.
  const coded = stopped || outcome === "advisory";
  shape(coded ? typeof root.code === "string" && CODE.test(root.code) : root.code === null);
  shape(outcome !== "advisory" || isRequestIntentAdvisoryCode(root.code));
  shape(root.location === null || (coded && typeof root.location === "string"));
  const reasons: readonly string[] =
    REQUEST_INTENT_NOT_RUN_REASONS[outcome as keyof typeof REQUEST_INTENT_NOT_RUN_REASONS] ?? [];
  shape(
    reasons.length === 0
      ? root.reason === null
      : typeof root.reason === "string" && reasons.includes(root.reason),
  );
  const boundary = root.boundary === null ? null : decodeBoundary(root.boundary);
  shape(boundary === null || outcome === "refused");
  shape(Array.isArray(root.calls));
  const calls = (root.calls as unknown[]).map(decodeCall);
  shape(
    outcome === "admitted" ||
      outcome === "advisory" ||
      outcome === "question" ||
      outcome === "rejected"
      ? calls.length > 0
      : outcome === "refused" || outcome === "unavailable" || calls.length === 0,
  );
  shape(Number.isSafeInteger(root.clippedTitles) && (root.clippedTitles as number) >= 0);
  return {
    outcome,
    code: root.code as string | null,
    location: root.location as string | null,
    reason: root.reason as RequestIntentNotRunReason | null,
    boundary,
    calls,
    clippedTitles: root.clippedTitles as number,
  };
}

function decodeCall(value: unknown): RequestIntentInterpretationCallV1 {
  const root = exactObject(value, CALL_KEYS);
  shape(typeof root.promptSha256 === "string" && SHA256.test(root.promptSha256));
  shape(
    root.responseSha256 === null ||
      (typeof root.responseSha256 === "string" && SHA256.test(root.responseSha256)),
  );
  for (const tokens of [root.inputTokens, root.outputTokens]) {
    shape(Number.isSafeInteger(tokens) && (tokens as number) >= 0);
  }
  return {
    promptSha256: root.promptSha256 as string,
    responseSha256: root.responseSha256 as string | null,
    inputTokens: root.inputTokens as number,
    outputTokens: root.outputTokens as number,
  };
}

function decodeBoundary(value: unknown): RequestIntentBoundary {
  shape(typeof value === "object" && value !== null && !Array.isArray(value));
  const kind = (value as Record<string, unknown>).kind;
  shape(typeof kind === "string" && Object.hasOwn(BOUNDARY_KEYS, kind));
  const root = exactObject(value, BOUNDARY_KEYS[kind as RequestIntentBoundary["kind"]]);
  for (const field of [root.observed, root.remediation]) {
    shape(typeof field === "string" && field.length > 0);
  }
  const observed = root.observed as string;
  const remediation = root.remediation as string;
  switch (kind as RequestIntentBoundary["kind"]) {
    case "internal-segment":
      shape(typeof root.segment === "string" && root.segment.length > 0);
      return { kind: "internal-segment", segment: root.segment, observed, remediation };
    case "write-grant":
      return { kind: "write-grant", observed, remediation };
    case "docs-root":
      return { kind: "docs-root", roots: decodePathScopes(root.roots), observed, remediation };
    case "write-scope":
      return { kind: "write-scope", grant: decodePathScopes(root.grant), observed, remediation };
  }
}

/** A recorded root or write scope, as admission validated it when it refused. */
function decodePathScopes(value: unknown): RequestIntentPathScope[] {
  shape(Array.isArray(value));
  return (value as unknown[]).map((entry) => {
    const scope = exactObject(entry, ["kind", "path"]);
    shape((REQUEST_INTENT_PATH_SCOPE_KINDS as readonly unknown[]).includes(scope.kind));
    shape(typeof scope.path === "string" && isRepositoryRelativePath(scope.path));
    return { kind: scope.kind as RequestIntentPathScope["kind"], path: scope.path };
  });
}

/** A scope list for the operator: roots end in `/`, so a file never reads as a directory. */
function describeScopes(scopes: readonly RequestIntentPathScope[]): string {
  return scopes.length === 0
    ? "none"
    : scopes.map((scope) => (scope.kind === "root" ? `${scope.path}/` : scope.path)).join(", ");
}

/** What a refusal's boundary is, in operator words, without the observed path. */
export function describeRequestIntentBoundary(boundary: RequestIntentBoundary): string {
  switch (boundary.kind) {
    case "internal-segment":
      return `inside ${boundary.segment}, which no grant covers`;
    case "write-grant":
      return "an existing page the run's update grant does not cover";
    case "docs-root":
      return `outside the documentation roots (${describeScopes(boundary.roots)})`;
    case "write-scope":
      return `outside the run's write scope (${describeScopes(boundary.grant)})`;
  }
}

function exactObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  shape(typeof value === "object" && value !== null && !Array.isArray(value));
  const present = Object.keys(value as object);
  shape(present.length === keys.length && present.every((key) => keys.includes(key)));
  return value as Record<string, unknown>;
}

function shape(condition: boolean): asserts condition {
  if (!condition) {
    throw new RequestIntentContractError(
      "sealed-shape",
      "the recorded request interpretation does not match its record shape.",
    );
  }
}

/**
 * INTENT section lines for a record, or none for a record that predates the
 * field. A record that does not verify prints the fault code and nothing it
 * carries.
 */
export function formatRequestIntentLines(record: {
  readonly requestIntent?: unknown;
  readonly instruction?: unknown;
}): string[] {
  if (record.requestIntent === undefined) return [];
  let decoded: RunRecordRequestIntentV1;
  try {
    decoded = decodeRunRecordRequestIntent(record.requestIntent, record.instruction);
  } catch (error) {
    if (!(error instanceof RequestIntentContractError)) throw error;
    return [`Admission: unverified (${error.code})`];
  }
  const { admission, intent } = decoded;
  const lines = [
    `Admission: ${admission.outcome}${admission.code ? ` (${admission.code})` : ""}${
      admission.reason ? ` (${admission.reason})` : ""
    }`,
  ];
  if (intent) {
    if (admission.outcome === "advisory" && isRequestIntentAdvisoryCode(admission.code)) {
      // The catalog owns the operator text of every code, advisories included.
      lines.push(`Advisory: ${OUTPUT_RULES[admission.code].operator.meaning}`);
    } else if (admission.outcome !== "admitted") {
      lines.push("Intent: not admitted");
    }
    lines.push(`Operation: ${intent.operation}`);
    for (const target of intent.targets) {
      lines.push(`Target: ${target.path} · ${target.role} · ${target.chosenFrom}`);
    }
    for (const source of intent.sources) lines.push(`Source: ${source.path}`);
    for (const exclusion of intent.exclusions) lines.push(`Exclusion: ${exclusion.path}`);
    for (const constraint of intent.constraints) lines.push(`Constraint: ${constraint.kind}`);
    lines.push(`Authority preference: ${intent.authorityPreference.preference}`);
    if (intent.question) {
      lines.push(`Question: ${intent.question.question}`);
      lines.push(`Options: ${intent.question.options.join(" | ")}`);
      lines.push(`Recommended: ${intent.question.recommendedDefault}`);
    }
  }
  if (admission.boundary) {
    lines.push(
      `Refused path: ${admission.boundary.observed} (${describeRequestIntentBoundary(admission.boundary)})`,
    );
    lines.push(`Remediation: ${admission.boundary.remediation}`);
  }
  lines.push(`Model calls: ${admission.calls.length}`);
  // The run's usage sums its workflow steps only; these tokens are recorded here alone.
  const tokens = (key: "inputTokens" | "outputTokens") =>
    admission.calls.reduce((total, call) => total + call[key], 0);
  lines.push(
    `Model tokens: ${tokens("inputTokens")} input, ${tokens("outputTokens")} output (not in the run's usage)`,
  );
  lines.push(`Clipped titles: ${admission.clippedTitles}`);
  return lines;
}
