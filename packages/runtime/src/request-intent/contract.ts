// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * RequestIntentV1: the model's reading of an operator request, admitted by the
 * host and sealed for the run record.
 *
 * Two shapes. The proposal is what the model writes: no digest, no request
 * hash, no quote offsets, no kind or schema version. The sealed artifact is
 * what the host records: it stamps those fields itself, and every quote it
 * keeps is the operator's own NFC text, never the model's rendering.
 *
 * Offsets in a sealed quote are UTF-16 offsets into the NFC-normalized
 * instruction, the same string `instructionSha256` hashes. The quote fold
 * (case, whitespace, typographic quotes and dashes) is a matching tolerance
 * only; the sealed text is always `NFC(instruction).slice(start, end)`.
 */
import type {
  CorrectableCodeOf,
  LocationOf,
  OUTPUT_RULES,
  RuleCodeOf,
} from "../contracts/model-output.js";

export const REQUEST_INTENT_KIND = "docsfab-request-intent" as const;
/** Protocol constant: the only sealed schema this module reads or writes. */
export const REQUEST_INTENT_SCHEMA_VERSION = 1 as const;
export const REQUEST_INTENT_DIGEST_KEY = "digest" as const;

export const REQUEST_INTENT_OPERATIONS = ["create", "update", "restructure", "review"] as const;
export const REQUEST_INTENT_TARGET_ROLES = ["write", "companion-nav", "companion-index"] as const;
export const REQUEST_INTENT_TARGET_ORIGINS = ["named", "inventory", "proposed-new"] as const;
export const REQUEST_INTENT_AUTHORITY_PREFERENCES = [
  "implementation",
  "documentation",
  "unspecified",
] as const;
/**
 * Explicit obligations that are neither preservation nor exclusion. A
 * `non-publication` constraint only narrows: the publication prohibition
 * guard still decides on the request text itself.
 */
export const REQUEST_INTENT_CONSTRAINT_KINDS = [
  "evidence-only",
  "stop-before-mutation",
  "operational-next-steps",
  "non-publication",
] as const;

export type RequestIntentOperation = (typeof REQUEST_INTENT_OPERATIONS)[number];
export type RequestIntentTargetRole = (typeof REQUEST_INTENT_TARGET_ROLES)[number];
export type RequestIntentTargetOrigin = (typeof REQUEST_INTENT_TARGET_ORIGINS)[number];
export type RequestIntentAuthorityPreference =
  (typeof REQUEST_INTENT_AUTHORITY_PREFERENCES)[number];
export type RequestIntentConstraintKind = (typeof REQUEST_INTENT_CONSTRAINT_KINDS)[number];

/**
 * How a `write`-role target exists at the run's revision. The caller maps the
 * collision oracle's answer onto these: `file` is an exact-case, unique,
 * tracked regular file (a collision with a base); `case-fold` is a collision
 * without a base (a match only once letter case is folded, an ambiguous fold,
 * or a non-regular entry); `directory` and `parent-file` keep the oracle's
 * kind; `absent` is no collision; `file-not-granted` is a collision the run's
 * update grant does not cover, whatever its other fields say.
 */
export const REQUEST_INTENT_EXISTENCE_KINDS = [
  "file",
  "case-fold",
  "directory",
  "parent-file",
  "absent",
  "file-not-granted",
] as const;
/** A host path scope entry: a directory root (no trailing slash) or one file. */
export const REQUEST_INTENT_PATH_SCOPE_KINDS = ["root", "file"] as const;

export type RequestIntentExistenceKind = (typeof REQUEST_INTENT_EXISTENCE_KINDS)[number];
export type RequestIntentPathScopeKind = (typeof REQUEST_INTENT_PATH_SCOPE_KINDS)[number];

/** The host's answer for one asked path, exact case. */
export interface RequestIntentExistenceAnswer {
  readonly path: string;
  readonly existing: RequestIntentExistenceKind;
}

/**
 * One entry of a documentation root or write scope. A `root` covers every
 * path under it, segment-bounded, but not its own path; a `file` covers that
 * path only.
 */
export interface RequestIntentPathScope {
  readonly kind: RequestIntentPathScopeKind;
  readonly path: string;
}

/** One decision-shaped question: options, a recommended default, and its consequence. */
export interface RequestIntentQuestion {
  readonly question: string;
  readonly options: readonly string[];
  readonly recommendedDefault: string;
  readonly consequence: string;
}

// ---------------------------------------------------------------------------
// Proposal: model output after closed decode. Quotes are still the model's text.

export interface RequestIntentProposalTarget {
  readonly path: string;
  readonly role: RequestIntentTargetRole;
  readonly chosenFrom: RequestIntentTargetOrigin;
  readonly quote: string;
}

export interface RequestIntentProposalPathQuote {
  readonly path: string;
  readonly quote: string;
}

export interface RequestIntentProposalQuote {
  readonly quote: string;
}

export interface RequestIntentProposalConstraint {
  readonly kind: RequestIntentConstraintKind;
  readonly quote: string;
}

export interface RequestIntentProposalAuthority {
  readonly preference: RequestIntentAuthorityPreference;
  /** Null exactly when the preference is `unspecified`. */
  readonly quote: string | null;
}

export interface RequestIntentProposal {
  readonly operation: RequestIntentOperation;
  readonly targets: readonly RequestIntentProposalTarget[];
  readonly sources: readonly RequestIntentProposalPathQuote[];
  readonly preserve: readonly RequestIntentProposalQuote[];
  readonly exclusions: readonly RequestIntentProposalPathQuote[];
  readonly constraints: readonly RequestIntentProposalConstraint[];
  readonly authorityPreference: RequestIntentProposalAuthority;
  /** Decoded as written; admission refuses more than one. */
  readonly questions: readonly RequestIntentQuestion[];
}

// ---------------------------------------------------------------------------
// Sealed artifact: host-stamped, recordable on the run.

/** The operator's own NFC text at `[start, end)` of the NFC instruction. */
export interface RequestIntentQuote {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

export interface RequestIntentTarget {
  readonly path: string;
  readonly role: RequestIntentTargetRole;
  readonly chosenFrom: RequestIntentTargetOrigin;
  readonly quote: RequestIntentQuote;
}

export interface RequestIntentPathQuote {
  readonly path: string;
  readonly quote: RequestIntentQuote;
}

export interface RequestIntentPreserve {
  readonly quote: RequestIntentQuote;
}

export interface RequestIntentConstraint {
  readonly kind: RequestIntentConstraintKind;
  readonly quote: RequestIntentQuote;
}

export interface RequestIntentAuthority {
  readonly preference: RequestIntentAuthorityPreference;
  readonly quote: RequestIntentQuote | null;
}

export interface RequestIntentBody {
  /** sha256 of the NFC-normalized instruction, recomputed by verification. */
  readonly instructionSha256: string;
  readonly operation: RequestIntentOperation;
  readonly targets: readonly RequestIntentTarget[];
  readonly sources: readonly RequestIntentPathQuote[];
  readonly preserve: readonly RequestIntentPreserve[];
  readonly exclusions: readonly RequestIntentPathQuote[];
  readonly constraints: readonly RequestIntentConstraint[];
  readonly authorityPreference: RequestIntentAuthority;
  /** Set only on the sealed intent a `question` outcome carries. */
  readonly question: RequestIntentQuestion | null;
}

export type RequestIntentV1 = RequestIntentBody & {
  readonly schemaVersion: typeof REQUEST_INTENT_SCHEMA_VERSION;
  readonly kind: typeof REQUEST_INTENT_KIND;
  readonly digest: string;
};

// ---------------------------------------------------------------------------
// Codes, inputs, and outcomes.

/** Every code this family declares in config/model-output/rules/request-intent.yaml. */
export type RequestIntentCode = RuleCodeOf<"request-intent">;
/** Codes that re-ask the model (Correct class). */
export type RequestIntentCorrectCode = CorrectableCodeOf<"request-intent">;
export type RequestIntentLocation = LocationOf<RequestIntentCode>;

/** The bound a `request-intent-size` rejection crossed. */
export interface RequestIntentBoundExceeded {
  readonly name: string;
  readonly limit: number;
  readonly observed: number;
  readonly scope: string;
}

export interface RequestIntentRejected {
  readonly outcome: "rejected";
  readonly code: RequestIntentCorrectCode;
  /** The declared catalog location. */
  readonly location: RequestIntentLocation;
  /** The concrete location, with array indexes. */
  readonly at: string;
  /** From the catalog; never decided at the call site. */
  readonly retry: "model-correctable";
  readonly bound?: RequestIntentBoundExceeded;
}

type RequestIntentCodeOfKind<K extends string> = {
  [C in RequestIntentCode]: (typeof OUTPUT_RULES)[C]["kind"] extends K ? C : never;
}[RequestIntentCode];
/** Codes the catalog declares as security refusals. */
export type RequestIntentDisclosureCode = RequestIntentCodeOfKind<"disclosure">;
/** Codes the catalog declares as authority refusals; each names its boundary. */
export type RequestIntentAuthorityCode = RequestIntentCodeOfKind<"authority">;

/** A path segment no request may read or write, such as `.git`. */
export interface RequestIntentInternalSegmentBoundary {
  readonly kind: "internal-segment";
  /** The internal segment, as the host's set spells it. */
  readonly segment: string;
  /** The path the proposal named. */
  readonly observed: string;
  readonly remediation: string;
}

/** An existing page the run's update grant does not cover. */
export interface RequestIntentWriteGrantBoundary {
  readonly kind: "write-grant";
  readonly observed: string;
  readonly remediation: string;
}

/** A create target outside every documentation root the run declared. */
export interface RequestIntentDocsRootBoundary {
  readonly kind: "docs-root";
  /** The documentation roots the host passed, as passed. */
  readonly roots: readonly RequestIntentPathScope[];
  readonly observed: string;
  readonly remediation: string;
}

/** A written path outside the run's write scope. */
export interface RequestIntentWriteScopeBoundary {
  readonly kind: "write-scope";
  /** The write scope the host passed, as passed. */
  readonly grant: readonly RequestIntentPathScope[];
  readonly observed: string;
  readonly remediation: string;
}

/** The boundary an authority refusal crossed. */
export type RequestIntentBoundary =
  | RequestIntentInternalSegmentBoundary
  | RequestIntentWriteGrantBoundary
  | RequestIntentDocsRootBoundary
  | RequestIntentWriteScopeBoundary;

interface RequestIntentRefusedBase {
  readonly outcome: "refused";
  readonly location: RequestIntentLocation;
  readonly at: string;
  readonly retry: "terminal";
}

export interface RequestIntentDisclosureRefused extends RequestIntentRefusedBase {
  readonly code: RequestIntentDisclosureCode;
}

export interface RequestIntentAuthorityRefused extends RequestIntentRefusedBase {
  readonly code: RequestIntentAuthorityCode;
  readonly boundary: RequestIntentBoundary;
}

export type RequestIntentRefused = RequestIntentDisclosureRefused | RequestIntentAuthorityRefused;

type RequestIntentCodeOfOperator<K extends string> = {
  [C in RequestIntentCode]: (typeof OUTPUT_RULES)[C]["operator"]["kind"] extends K ? C : never;
}[RequestIntentCode];
/** Codes the operator answers: a question, or an advisory a rerun can act on. */
export type RequestIntentQuestionCode = RequestIntentCodeOfOperator<"supply">;

/**
 * Findings that do not stop a run, because the reading is model output: the
 * operator's command, not the reading, chooses the workflow; without a named
 * page an update or a restructure leaves the pages to the workflow; and a
 * question the model asks goes unanswered. The reading is recorded and the
 * run goes on. A create run that names no page still asks
 * `request-intent-target-missing`.
 */
export type RequestIntentAdvisoryCode = Extract<
  RequestIntentQuestionCode,
  | "request-intent-target-missing"
  | "request-intent-operation-mismatch"
  | "request-intent-model-question"
>;

/** Whether a recorded code is one of the advisory findings. */
export function isRequestIntentAdvisoryCode(code: unknown): code is RequestIntentAdvisoryCode {
  return (
    code === "request-intent-target-missing" ||
    code === "request-intent-operation-mismatch" ||
    code === "request-intent-model-question"
  );
}

/** Questions the host asks from the repository and the run, not the model. */
export type RequestIntentSupplyCode = Exclude<
  RequestIntentQuestionCode,
  "request-intent-model-question" | "request-intent-operation-mismatch"
>;

/** What a host question or advisory was decided from; never the request's wording. */
export interface RequestIntentSupplyEvidence {
  /** The operation the run declared. */
  readonly declaredOperation: RequestIntentOperation;
  /** The operation the proposal read. */
  readonly operation: RequestIntentOperation;
  /** The write-role target the question is about, or null when it is about none. */
  readonly observed: string | null;
  /** The host's existence answer for `observed`, or null when it is about none. */
  readonly existing: RequestIntentExistenceKind | null;
}

/** The host found a choice only the operator can make. */
export interface RequestIntentSupplyQuestionOutcome {
  readonly outcome: "question";
  readonly code: RequestIntentSupplyCode;
  readonly location: RequestIntentLocation;
  readonly at: string;
  /** Equal to `intent.question`, so the sealed record keeps the question. */
  readonly question: RequestIntentQuestion;
  readonly evidence: RequestIntentSupplyEvidence;
  /** The grounded intent the question was asked about, sealed for the record. */
  readonly intent: RequestIntentV1;
}

export type RequestIntentQuestionOutcome = RequestIntentSupplyQuestionOutcome;

/** A finding recorded beside the reading; the run goes on. */
export interface RequestIntentAdvisoryOutcome {
  readonly outcome: "advisory";
  readonly code: RequestIntentAdvisoryCode;
  readonly location: RequestIntentLocation;
  readonly at: string;
  readonly evidence: RequestIntentSupplyEvidence;
  /**
   * The reading, sealed with the question the model asked for
   * `request-intent-model-question`, and with no question otherwise.
   */
  readonly intent: RequestIntentV1;
}

export interface RequestIntentAdmitted {
  readonly outcome: "admitted";
  readonly intent: RequestIntentV1;
}

export interface RequestIntentDecoded {
  readonly outcome: "decoded";
  readonly proposal: RequestIntentProposal;
}

export type RequestIntentDecodeResult = RequestIntentDecoded | RequestIntentRejected;

export type RequestIntentAdmissionResult =
  | RequestIntentAdmitted
  | RequestIntentAdvisoryOutcome
  | RequestIntentQuestionOutcome
  | RequestIntentRefused
  | RequestIntentRejected;
