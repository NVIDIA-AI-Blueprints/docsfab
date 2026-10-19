// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Closed, host-sealed identity contracts for one CREATE authoring revision.
 *
 * No filesystem, writer, scheduling, or delivery behavior lives here.
 * Candidate bytes are represented by a digest and byte count; the host keeps
 * the artifact elsewhere.
 */

import {
  SOURCE_SUPPORT_UNSPECIFIED_DIMENSION,
  sourceSupportInputIdV1,
} from "../artifacts/editorial-input-ask.js";
import { createContractKit, type ContractFail } from "../contract-kit/index.js";
import { sha256 } from "../content-ir/canonical.js";
import type { HarnessStepInput } from "../execution/contracts.js";
import {
  canonicalizeJsonEvidence,
  parseJsonEvidence,
  type JsonEvidenceValue,
} from "../json-evidence.js";
import {
  TECHNICAL_FACT_DIMENSIONS,
  type ReviewResult,
  type TechnicalFactDimension,
  type TechnicalSourceFact,
  type VerificationResult,
  validateEditorialReviewResult,
  validateVerificationResult,
  normalizeRepositoryLocator,
} from "./review-response.js";
import {
  documentationPlanWritePaths,
  validateAdmittedDocumentationPlanBinding,
} from "./plan-binding.js";
import {
  type SourceObligationLedger,
  type TechnicalCorrectionEvidence,
  validateSourceObligationLedger,
  validateTechnicalCorrectionEvidence,
} from "./source-obligation.js";
import type { OriginalSourceAuthorityEvidenceV1 } from "./source-obligation-authority.js";

export const AUTHORING_CANDIDATE_SCHEMA_VERSION = 1 as const;
export const AUTHORING_CANDIDATE_KIND = "docsfab-authoring-candidate" as const;
export const AUTHORING_REVISION_INPUT_KIND = "docsfab-authoring-revision-input" as const;

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SAFE_PATH = /^(?!\.)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/u;
const FACT_ID = /^[A-Z][A-Z0-9_-]{0,63}$/u;
const ISSUE_ID = /^[A-Z]+-[0-9]{3}$/u;
const PRODUCER_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
const MAX_WRITE_PATHS = 512;
const MAX_FACTS = 256;
const MAX_SOURCE_LOCATORS = 64;
const MAX_ISSUES_PER_FACT = 32;
const MAX_SUMMARY_BYTES = 65_536;
const MAX_PATCH_BYTES = 1024 * 1024 * 1024;

/** Every closed refusal code, enumerated once so class tables and tests hold it closed. */
export const AUTHORING_CANDIDATE_ERROR_CODES = Object.freeze([
  "invalid-shape",
  "invalid-value",
  "digest-mismatch",
  "credential-material",
  // Raised only by older hosts; kept so their records still classify.
  "host-path",
  "schema-mismatch",
  "wrong-candidate",
  "wrong-ordinal",
  "wrong-revision",
  "wrong-plan",
  "wrong-write-paths",
  "stale-evidence",
  "invalid-evidence",
  "unverified-coverage",
  "unknown-fact",
  "duplicate-fact",
  "unknown-issue",
  "duplicate-issue",
  "inconsistent-linked-issues",
  "non-actionable",
] as const);

export type AuthoringCandidateErrorCode = (typeof AUTHORING_CANDIDATE_ERROR_CODES)[number];

export class AuthoringCandidateContractError extends Error {
  public readonly code: AuthoringCandidateErrorCode;
  public constructor(code: AuthoringCandidateErrorCode) {
    super(`Authoring candidate contract rejected: ${code}.`);
    this.code = code;
    this.name = "AuthoringCandidateContractError";
  }
}

export function failAuthoringCandidate(code: AuthoringCandidateErrorCode): never {
  throw new AuthoringCandidateContractError(code);
}

/**
 * The inner reason the CREATE revision selection refused its admitted
 * candidate-zero evidence (`RunRecord.authoringCandidateRejection`).
 *
 * - `code` is `authoring-candidate-<error code>`, read from the error's closed
 *   code, never from message text.
 * - `location` is the `$`-rooted member the refusing rule read.
 *   `unverified-coverage` reads the technical result's `$.coverage[].status`;
 *   every other code is raised from several rules and records `$`.
 *
 * Nothing here copies error, model, or validator text.
 */
export type AuthoringCandidateRejectionCode = `authoring-candidate-${AuthoringCandidateErrorCode}`;

export interface AuthoringCandidateRejectionV1 {
  readonly code: AuthoringCandidateRejectionCode;
  readonly location: string;
}

const AUTHORING_CANDIDATE_REJECTION_PREFIX = "authoring-candidate-";
const AUTHORING_CANDIDATE_ROOT_LOCATION = "$";
const AUTHORING_CANDIDATE_REJECTION_LOCATIONS: Readonly<
  Partial<Record<AuthoringCandidateErrorCode, string>>
> = Object.freeze({ "unverified-coverage": "$.coverage[].status" });

export const AUTHORING_CANDIDATE_REJECTION_CODES: readonly AuthoringCandidateRejectionCode[] =
  Object.freeze(AUTHORING_CANDIDATE_ERROR_CODES.map(authoringCandidateRejectionCode));

function authoringCandidateRejectionCode(
  code: AuthoringCandidateErrorCode,
): AuthoringCandidateRejectionCode {
  return `${AUTHORING_CANDIDATE_REJECTION_PREFIX}${code}`;
}

function authoringCandidateRejection(
  code: AuthoringCandidateErrorCode,
): AuthoringCandidateRejectionV1 {
  return Object.freeze({
    code: authoringCandidateRejectionCode(code),
    location: AUTHORING_CANDIDATE_REJECTION_LOCATIONS[code] ?? AUTHORING_CANDIDATE_ROOT_LOCATION,
  });
}

function isAuthoringCandidateErrorCode(value: unknown): value is AuthoringCandidateErrorCode {
  return (
    typeof value === "string" &&
    (AUTHORING_CANDIDATE_ERROR_CODES as readonly string[]).includes(value)
  );
}

/**
 * The inner reason for a refusal, rebuilt from the closed tables, or
 * `undefined` when the error is not a coded authoring candidate refusal.
 * Never throws: a diagnostic must not be able to fail the run it describes.
 */
export function authoringCandidateRejectionOf(
  error: unknown,
): AuthoringCandidateRejectionV1 | undefined {
  try {
    return error instanceof AuthoringCandidateContractError &&
      isAuthoringCandidateErrorCode(error.code)
      ? authoringCandidateRejection(error.code)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Strictly read a recorded inner reason; anything else reads as `null`. */
export function readAuthoringCandidateRejection(
  value: unknown,
): AuthoringCandidateRejectionV1 | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== "code" || keys[1] !== "location") return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.code !== "string") return null;
  const code = candidate.code.startsWith(AUTHORING_CANDIDATE_REJECTION_PREFIX)
    ? candidate.code.slice(AUTHORING_CANDIDATE_REJECTION_PREFIX.length)
    : undefined;
  if (!isAuthoringCandidateErrorCode(code)) return null;
  const expected = authoringCandidateRejection(code);
  return candidate.location === expected.location ? expected : null;
}

const kit = createContractKit({
  fail: failAuthoringCandidate as ContractFail<AuthoringCandidateErrorCode>,
  inertMode: "strict",
  codes: {
    invalidShape: "invalid-shape",
    invalidValue: "invalid-value",
    digestMismatch: "digest-mismatch",
    credentialMaterial: "credential-material",
    schemaMismatch: "schema-mismatch",
  },
});

export interface AuthoringCandidateInputV1 {
  readonly runId: string;
  readonly ordinal: 0 | 1;
  readonly originalRevision: string;
  readonly planDigest: string;
  readonly writePaths: readonly string[];
  /** SHA-256 of the complete patch against originalRevision. */
  readonly patchDigestSha256: string;
  /** Patch text is not retained here. */
  readonly patchBytes: number;
  readonly workspaceSnapshotDigest: string;
}

export interface AuthoringCandidateV1 extends AuthoringCandidateInputV1 {
  readonly schemaVersion: typeof AUTHORING_CANDIDATE_SCHEMA_VERSION;
  readonly kind: typeof AUTHORING_CANDIDATE_KIND;
  readonly digest: string;
}

export type AuthoringActionableTechnicalFactV1 = Pick<
  TechnicalSourceFact,
  | "id"
  | "dimension"
  | "sourceLocators"
  | "statement"
  | "documentationDisposition"
  | "uncertainty"
  | "issueIds"
>;

export interface AuthoringRevisionInputPayloadV1 {
  readonly candidate0Digest: string;
  readonly candidateOrdinal: 0;
  readonly originalRevision: string;
  readonly planDigest: string;
  readonly writePaths: readonly string[];
  readonly technicalSummaryDigest: string;
  readonly technicalProducerId: string;
  readonly editorialSummaryDigest: string;
  readonly editorialProducerId: string;
  readonly sourceObligationLedgerSha256: string;
  readonly technicalCorrectionEvidenceSha256: string;
  readonly actionableFacts: readonly AuthoringActionableTechnicalFactV1[];
}

export interface AuthoringRevisionInputV1 extends AuthoringRevisionInputPayloadV1 {
  readonly schemaVersion: typeof AUTHORING_CANDIDATE_SCHEMA_VERSION;
  readonly kind: typeof AUTHORING_REVISION_INPUT_KIND;
  readonly digest: string;
}

export interface AuthoringProducerBindingV1<T> {
  readonly summary: string;
  readonly summaryDigest: string;
  readonly producerId: string;
  readonly candidateDigest: string;
  readonly candidateOrdinal: 0 | 1;
  readonly workspaceSnapshotDigest: string;
  readonly result: T;
}

export type AuthoringSourceObligationInputV1 = Pick<
  HarnessStepInput,
  | "workflow"
  | "evidenceIdentity"
  | "searchEvidence"
  | "planBinding"
  | "reviewScope"
  | "contextTarget"
>;

export interface AuthoringRevisionValidationContextV1 {
  readonly candidate0: AuthoringCandidateV1;
  readonly originalRevision: string;
  readonly planDigest: string;
  readonly writePaths: readonly string[];
  readonly technical: AuthoringProducerBindingV1<VerificationResult>;
  readonly editorial: AuthoringProducerBindingV1<ReviewResult>;
  readonly sourceObligationInput: AuthoringSourceObligationInputV1;
  readonly sourceObligationLedger: SourceObligationLedger;
  readonly technicalCorrectionEvidence: TechnicalCorrectionEvidence;
  readonly originalSourceAuthority?: OriginalSourceAuthorityEvidenceV1;
}

export type AuthoringRevisionSelection =
  | { readonly kind: "retain"; readonly reason: "no-actionable" }
  | { readonly kind: "revise"; readonly input: AuthoringRevisionInputV1 };

const CANDIDATE_BODY_KEYS = [
  "runId",
  "ordinal",
  "originalRevision",
  "planDigest",
  "writePaths",
  "patchDigestSha256",
  "patchBytes",
  "workspaceSnapshotDigest",
] as const;
const REVISION_BODY_KEYS = [
  "candidate0Digest",
  "candidateOrdinal",
  "originalRevision",
  "planDigest",
  "writePaths",
  "technicalSummaryDigest",
  "technicalProducerId",
  "editorialSummaryDigest",
  "editorialProducerId",
  "sourceObligationLedgerSha256",
  "technicalCorrectionEvidenceSha256",
  "actionableFacts",
] as const;

export function createAuthoringCandidate(input: AuthoringCandidateInputV1): AuthoringCandidateV1 {
  return kit.seal(
    AUTHORING_CANDIDATE_KIND,
    "digest",
    normalizeCandidate(input),
  ) as AuthoringCandidateV1;
}

export function decodeAuthoringCandidate(value: unknown): AuthoringCandidateV1 {
  return kit.decodeSealed(
    value,
    AUTHORING_CANDIDATE_KIND,
    "digest",
    [...CANDIDATE_BODY_KEYS],
    (root) => normalizeCandidate(root as unknown as AuthoringCandidateInputV1),
  ) as AuthoringCandidateV1;
}

export function createAuthoringRevisionInput(
  value: AuthoringRevisionInputPayloadV1,
  context: AuthoringRevisionValidationContextV1,
): AuthoringRevisionInputV1 {
  const normalized = validateRevisionPayload(value, context);
  return kit.seal(AUTHORING_REVISION_INPUT_KIND, "digest", normalized) as AuthoringRevisionInputV1;
}

export function validateAuthoringRevisionInput(
  value: unknown,
  context: AuthoringRevisionValidationContextV1,
): AuthoringRevisionInputV1 {
  const decoded = kit.decodeSealed(
    value,
    AUTHORING_REVISION_INPUT_KIND,
    "digest",
    [...REVISION_BODY_KEYS],
    (root) => validateRevisionPayload(root as unknown as AuthoringRevisionInputPayloadV1, context),
  ) as AuthoringRevisionInputV1;
  return decoded;
}

/**
 * Select from already admitted evidence. A two-argument call validates a
 * caller-provided sealed input; a one-argument call derives the complete
 * actionable set from the host's admitted technical result.
 */
export function selectAuthoringRevision(
  context: AuthoringRevisionValidationContextV1,
): AuthoringRevisionSelection;
export function selectAuthoringRevision(
  value: unknown,
  context: AuthoringRevisionValidationContextV1,
): AuthoringRevisionSelection;
export function selectAuthoringRevision(
  valueOrContext: unknown,
  maybeContext?: AuthoringRevisionValidationContextV1,
): AuthoringRevisionSelection {
  const context = (maybeContext ?? valueOrContext) as AuthoringRevisionValidationContextV1;
  const admitted = validateContext(context);
  const qualifying = actionableFacts(admitted.technical.result);
  if (qualifying.length === 0) {
    if (maybeContext !== undefined) {
      const input = validateAuthoringRevisionInput(valueOrContext, admitted);
      if (input.actionableFacts.length !== 0) failAuthoringCandidate("inconsistent-linked-issues");
    }
    return { kind: "retain", reason: "no-actionable" };
  }
  if (maybeContext !== undefined) {
    const input = validateAuthoringRevisionInput(valueOrContext, admitted);
    assertFactsExactlyMatch(input.actionableFacts, qualifying);
    return { kind: "revise", input };
  }
  const payload: AuthoringRevisionInputPayloadV1 = {
    candidate0Digest: admitted.candidate0.digest,
    candidateOrdinal: 0,
    originalRevision: admitted.originalRevision,
    planDigest: admitted.planDigest,
    writePaths: admitted.writePaths,
    technicalSummaryDigest: admitted.technical.summaryDigest,
    technicalProducerId: admitted.technical.producerId,
    editorialSummaryDigest: admitted.editorial.summaryDigest,
    editorialProducerId: admitted.editorial.producerId,
    sourceObligationLedgerSha256: admitted.sourceObligationLedger.digest,
    technicalCorrectionEvidenceSha256: admitted.technicalCorrectionEvidence.digest,
    actionableFacts: qualifying,
  };
  return { kind: "revise", input: createAuthoringRevisionInput(payload, admitted) };
}

/**
 * The finding code of each CREATE source-support gap.
 *
 * - `coverage`: the admitted technical result reported the page's coverage
 *   `unverified`.
 * - `dimension`: the sealed source-obligation ledger marked a technical
 *   dimension `unverified`, so no bound source establishes it, whatever
 *   coverage the model reported.
 */
export const AUTHORING_SOURCE_SUPPORT_CODES = Object.freeze({
  coverage: authoringCandidateRejectionCode("unverified-coverage"),
  dimension: "source-obligation-unverified-dimension",
} as const);

export type AuthoringSourceSupportCode =
  (typeof AUTHORING_SOURCE_SUPPORT_CODES)[keyof typeof AUTHORING_SOURCE_SUPPORT_CODES];

const AUTHORING_SOURCE_SUPPORT_STEP_ERROR_PREFIX = "authoring-source-support";

/**
 * The retained rejection on the technical step a source-support stop marks
 * `needs-input`: `authoring-source-support:<code>:<technical summary sha256>`.
 */
export function authoringSourceSupportStepError(
  code: AuthoringSourceSupportCode,
  technicalSummary: string,
): string {
  return `${AUTHORING_SOURCE_SUPPORT_STEP_ERROR_PREFIX}:${code}:${sha256(technicalSummary)}`;
}

/** True only for the exact retained rejection of this technical summary. */
export function isAuthoringSourceSupportStepError(
  value: unknown,
  technicalSummary: string,
): boolean {
  return Object.values(AUTHORING_SOURCE_SUPPORT_CODES).some(
    (code) => value === authoringSourceSupportStepError(code, technicalSummary),
  );
}

/** One named InputAsk slot for a source the bound CREATE evidence lacks. */
export interface AuthoringSourceSupportGapV1 {
  readonly inputId: string;
  readonly code: AuthoringSourceSupportCode;
  readonly pagePath: string;
  readonly dimension: TechnicalFactDimension | typeof SOURCE_SUPPORT_UNSPECIFIED_DIMENSION;
}

/**
 * The source-support gaps that stop CREATE before revision selection.
 *
 * Runs the same whole-context validation as {@link selectAuthoringRevision},
 * but admits unverified coverage so the gap is named instead of refused. Any
 * other invalid binding still throws its closed code, so a stale, forged, or
 * malformed context never becomes an InputAsk.
 *
 * One gap per (unverified sealed-ledger dimension x target page), in dimension
 * then page order; a page with unverified coverage and no dimension gap gets
 * one `documented-behavior` gap. Selection keeps its own strict refusal.
 */
export function authoringSourceSupportGaps(
  context: AuthoringRevisionValidationContextV1,
): readonly AuthoringSourceSupportGapV1[] {
  const admitted = validateContext(context, { admitUnverifiedCoverage: true });
  const unverifiedPages = new Set(
    admitted.technical.result.coverage
      .filter((entry) => entry.status !== "verified")
      .map((entry) => entry.path),
  );
  const unverifiedDimensions = new Set(
    admitted.sourceObligationLedger.dimensions
      .filter((entry) => entry.status === "unverified")
      .map((entry) => entry.dimension),
  );
  const gaps: AuthoringSourceSupportGapV1[] = [];
  const add = (
    pagePath: string,
    dimension: AuthoringSourceSupportGapV1["dimension"],
    code: AuthoringSourceSupportCode,
  ): void => {
    const inputId =
      sourceSupportInputIdV1({ dimension, pagePath }) ?? failAuthoringCandidate("invalid-value");
    gaps.push(Object.freeze({ inputId, code, pagePath, dimension }));
  };
  for (const dimension of TECHNICAL_FACT_DIMENSIONS) {
    if (!unverifiedDimensions.has(dimension)) continue;
    for (const pagePath of admitted.writePaths) {
      add(
        pagePath,
        dimension,
        unverifiedPages.has(pagePath)
          ? AUTHORING_SOURCE_SUPPORT_CODES.coverage
          : AUTHORING_SOURCE_SUPPORT_CODES.dimension,
      );
    }
  }
  if (unverifiedDimensions.size === 0) {
    for (const pagePath of admitted.writePaths) {
      if (!unverifiedPages.has(pagePath)) continue;
      add(pagePath, SOURCE_SUPPORT_UNSPECIFIED_DIMENSION, AUTHORING_SOURCE_SUPPORT_CODES.coverage);
    }
  }
  return Object.freeze(gaps);
}

function normalizeCandidate(input: AuthoringCandidateInputV1): AuthoringCandidateInputV1 {
  assertSafeInput(input);
  const root = kit.object(input);
  kit.exact(root, [...CANDIDATE_BODY_KEYS]);
  const runId = kit.string(root.runId);
  if (!RUN_ID.test(runId)) failAuthoringCandidate("invalid-value");
  if (root.ordinal !== 0 && root.ordinal !== 1) failAuthoringCandidate("invalid-value");
  const writePaths = normalizePaths(root.writePaths, true);
  const patchBytes = root.patchBytes;
  if (
    typeof patchBytes !== "number" ||
    !Number.isSafeInteger(patchBytes) ||
    patchBytes < 0 ||
    patchBytes > MAX_PATCH_BYTES
  ) {
    failAuthoringCandidate("invalid-value");
  }
  return {
    runId,
    ordinal: root.ordinal,
    originalRevision: kit.revision(root.originalRevision),
    planDigest: kit.hash(root.planDigest),
    writePaths,
    patchDigestSha256: kit.hash(root.patchDigestSha256),
    patchBytes,
    workspaceSnapshotDigest: kit.hash(root.workspaceSnapshotDigest),
  };
}

function validateRevisionPayload(
  value: AuthoringRevisionInputPayloadV1,
  context: AuthoringRevisionValidationContextV1,
): AuthoringRevisionInputPayloadV1 {
  // Actionable facts copy the ledger's statements; admit the tokens the ledger
  // sealed. validateContext then validates that ledger itself.
  assertSafeInput(value);
  const admitted = validateContext(context);
  const root = kit.object(value);
  kit.exact(root, [...REVISION_BODY_KEYS]);
  const candidate0Digest = kit.hash(root.candidate0Digest);
  if (candidate0Digest !== admitted.candidate0.digest) failAuthoringCandidate("wrong-candidate");
  if (root.candidateOrdinal !== 0) failAuthoringCandidate("wrong-ordinal");
  const originalRevision = kit.revision(root.originalRevision);
  if (originalRevision !== admitted.originalRevision) failAuthoringCandidate("wrong-revision");
  const planDigest = kit.hash(root.planDigest);
  if (planDigest !== admitted.planDigest) failAuthoringCandidate("wrong-plan");
  const writePaths = normalizePaths(root.writePaths, true);
  if (!sameStrings(writePaths, admitted.writePaths)) failAuthoringCandidate("wrong-write-paths");
  const technicalSummaryDigest = kit.hash(root.technicalSummaryDigest);
  const technicalProducerId = boundedProducer(root.technicalProducerId);
  const editorialSummaryDigest = kit.hash(root.editorialSummaryDigest);
  const editorialProducerId = boundedProducer(root.editorialProducerId);
  const sourceObligationLedgerSha256 = kit.hash(root.sourceObligationLedgerSha256);
  const technicalCorrectionEvidenceSha256 = kit.hash(root.technicalCorrectionEvidenceSha256);
  if (
    technicalSummaryDigest !== admitted.technical.summaryDigest ||
    technicalProducerId !== admitted.technical.producerId
  ) {
    failAuthoringCandidate("stale-evidence");
  }
  if (
    sourceObligationLedgerSha256 !== admitted.sourceObligationLedger.digest ||
    technicalCorrectionEvidenceSha256 !== admitted.technicalCorrectionEvidence.digest
  ) {
    failAuthoringCandidate("stale-evidence");
  }
  if (
    editorialSummaryDigest !== admitted.editorial.summaryDigest ||
    editorialProducerId !== admitted.editorial.producerId
  ) {
    failAuthoringCandidate("stale-evidence");
  }
  const facts = normalizeFacts(root.actionableFacts);
  const qualifying = actionableFacts(admitted.technical.result);
  assertFactsExactlyMatch(facts, qualifying);
  return {
    candidate0Digest,
    candidateOrdinal: 0,
    originalRevision,
    planDigest,
    writePaths,
    technicalSummaryDigest,
    technicalProducerId,
    editorialSummaryDigest,
    editorialProducerId,
    sourceObligationLedgerSha256,
    technicalCorrectionEvidenceSha256,
    actionableFacts: facts,
  };
}

function validateContext(
  context: AuthoringRevisionValidationContextV1,
  options: { readonly admitUnverifiedCoverage?: boolean } = {},
): AuthoringRevisionValidationContextV1 {
  const root = kit.object(context);
  kit.exact(
    root,
    [
      "candidate0",
      "originalRevision",
      "planDigest",
      "writePaths",
      "technical",
      "editorial",
      "sourceObligationInput",
      "sourceObligationLedger",
      "technicalCorrectionEvidence",
      "originalSourceAuthority",
    ],
    ["originalSourceAuthority"],
  );
  const priorContext = Object.fromEntries(
    Object.entries(root).filter(([key]) => key !== "originalSourceAuthority"),
  );
  kit.assertInert(priorContext);
  kit.rejectCredentials(priorContext);
  const candidate0 = decodeAuthoringCandidate(root.candidate0);
  const originalRevision = kit.revision(root.originalRevision);
  const planDigest = kit.hash(root.planDigest);
  const writePaths = normalizePaths(root.writePaths, true);
  if (candidate0.ordinal !== 0 || candidate0.originalRevision !== originalRevision) {
    failAuthoringCandidate("wrong-ordinal");
  }
  if (candidate0.planDigest !== planDigest || !sameStrings(candidate0.writePaths, writePaths)) {
    failAuthoringCandidate("wrong-plan");
  }
  const technical = validateProducerBinding<VerificationResult>(
    root.technical,
    "technical",
    writePaths,
    options.admitUnverifiedCoverage === true,
  );
  const editorial = validateProducerBinding<ReviewResult>(root.editorial, "editorial", writePaths);
  const sourceObligationInput =
    root.sourceObligationInput as AuthoringRevisionValidationContextV1["sourceObligationInput"];
  assertSourceInputBinding(sourceObligationInput, originalRevision, planDigest, writePaths);
  const originalSourceAuthority = root.originalSourceAuthority as
    | OriginalSourceAuthorityEvidenceV1
    | undefined;
  let sourceObligationLedger: SourceObligationLedger;
  try {
    sourceObligationLedger = validateSourceObligationLedger(
      root.sourceObligationLedger,
      sourceObligationInput,
      originalSourceAuthority,
    );
    if (sourceObligationLedger.schemaVersion === 1 && originalSourceAuthority !== undefined) {
      failAuthoringCandidate("invalid-evidence");
    }
  } catch {
    failAuthoringCandidate("invalid-evidence");
  }
  let technicalCorrectionEvidence: TechnicalCorrectionEvidence;
  try {
    technicalCorrectionEvidence = validateTechnicalCorrectionEvidence(
      root.technicalCorrectionEvidence,
      sourceObligationLedger,
      technical.result,
      originalSourceAuthority,
      writePaths,
    );
  } catch {
    failAuthoringCandidate("invalid-evidence");
  }
  if (
    technical.candidateOrdinal !== 0 ||
    technical.candidateDigest !== candidate0.digest ||
    technical.workspaceSnapshotDigest !== candidate0.workspaceSnapshotDigest ||
    editorial.candidateOrdinal !== 0 ||
    editorial.candidateDigest !== candidate0.digest ||
    editorial.workspaceSnapshotDigest !== candidate0.workspaceSnapshotDigest
  ) {
    failAuthoringCandidate("stale-evidence");
  }
  assertAdmittedFactLocators(technical.result, sourceObligationLedger, technicalCorrectionEvidence);
  if (
    technical.producerId !== "verify-technical-accuracy" ||
    editorial.producerId !== "review-documentation"
  ) {
    failAuthoringCandidate("stale-evidence");
  }
  return {
    candidate0,
    originalRevision,
    planDigest,
    writePaths,
    technical,
    editorial,
    sourceObligationInput,
    sourceObligationLedger,
    technicalCorrectionEvidence,
    ...(originalSourceAuthority ? { originalSourceAuthority } : {}),
  };
}

function validateProducerBinding<T>(
  value: unknown,
  kind: "technical" | "editorial",
  targetPaths: readonly string[],
  admitUnverifiedCoverage = false,
): AuthoringProducerBindingV1<T> {
  const root = kit.object(value);
  kit.exact(root, [
    "summary",
    "summaryDigest",
    "producerId",
    "candidateDigest",
    "candidateOrdinal",
    "workspaceSnapshotDigest",
    "result",
  ]);
  const summary = kit.string(root.summary);
  if (new TextEncoder().encode(summary).byteLength > MAX_SUMMARY_BYTES) {
    failAuthoringCandidate("invalid-value");
  }
  try {
    parseJsonEvidence(summary);
  } catch {
    failAuthoringCandidate("invalid-evidence");
  }
  const result = root.result as T;
  if (canonicalizeJsonEvidence(result as unknown as JsonEvidenceValue).trimEnd() !== summary) {
    failAuthoringCandidate("stale-evidence");
  }
  const summaryDigest = kit.hash(root.summaryDigest);
  if (summaryDigest !== sha256(summary)) failAuthoringCandidate("stale-evidence");
  try {
    if (kind === "technical") {
      validateVerificationResult(result, targetPaths);
      const verification = result as VerificationResult;
      if (
        !admitUnverifiedCoverage &&
        verification.coverage.some((entry) => entry.status !== "verified")
      ) {
        failAuthoringCandidate("unverified-coverage");
      }
    } else {
      validateEditorialReviewResult(result);
    }
  } catch (error) {
    if (error instanceof AuthoringCandidateContractError) throw error;
    failAuthoringCandidate("invalid-evidence");
  }
  if (root.candidateOrdinal !== 0 && root.candidateOrdinal !== 1) {
    failAuthoringCandidate("wrong-ordinal");
  }
  return {
    summary,
    summaryDigest,
    producerId: boundedProducer(root.producerId),
    candidateDigest: kit.hash(root.candidateDigest),
    candidateOrdinal: root.candidateOrdinal,
    workspaceSnapshotDigest: kit.hash(root.workspaceSnapshotDigest),
    result,
  };
}

function normalizeFacts(value: unknown): AuthoringActionableTechnicalFactV1[] {
  const facts = kit.array(value);
  if (facts.length > MAX_FACTS) failAuthoringCandidate("invalid-value");
  const seen = new Set<string>();
  const normalized = facts.map((value) => {
    const root = kit.object(value);
    kit.exact(root, [
      "id",
      "dimension",
      "sourceLocators",
      "statement",
      "documentationDisposition",
      "uncertainty",
      "issueIds",
    ]);
    const id = kit.string(root.id);
    if (!FACT_ID.test(id) || seen.has(id)) {
      failAuthoringCandidate(seen.has(id) ? "duplicate-fact" : "invalid-value");
    }
    seen.add(id);
    const dimension = kit.enumeration(root.dimension, TECHNICAL_FACT_DIMENSIONS);
    const disposition = kit.enumeration(root.documentationDisposition, [
      "omitted",
      "conflicting",
    ] as const);
    const sourceLocators = normalizeLocators(root.sourceLocators);
    const statement = boundedText(root.statement, 4_096, 8);
    const uncertainty = boundedText(root.uncertainty, 2_048);
    const issueIds = normalizeIssueIds(root.issueIds);
    if (issueIds.length === 0) failAuthoringCandidate("inconsistent-linked-issues");
    return {
      id,
      dimension,
      sourceLocators,
      statement,
      documentationDisposition: disposition,
      uncertainty,
      issueIds,
    };
  });
  return normalized.sort((left, right) => left.id.localeCompare(right.id));
}

function actionableFacts(result: VerificationResult): AuthoringActionableTechnicalFactV1[] {
  return result.factInventory.dimensions
    .flatMap((dimension) => dimension.facts)
    .filter(
      (fact) =>
        fact.documentationDisposition === "omitted" ||
        fact.documentationDisposition === "conflicting",
    )
    .map((fact) => ({
      id: fact.id,
      dimension: fact.dimension,
      sourceLocators: [...fact.sourceLocators].sort(),
      statement: fact.statement,
      documentationDisposition: fact.documentationDisposition,
      uncertainty: fact.uncertainty,
      issueIds: [...fact.issueIds].sort(),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function assertAdmittedFactLocators(
  result: VerificationResult,
  ledger: SourceObligationLedger,
  correction: TechnicalCorrectionEvidence,
): void {
  const admittedPaths = new Set(
    ledger.schemaVersion === 2 &&
      (correction.schemaVersion === 2 ||
        correction.schemaVersion === 3 ||
        correction.schemaVersion === 4)
      ? correction.sourceChecks.map((source) => source.path)
      : ledger.identity.sources.map((source) => source.path),
  );
  for (const fact of actionableFacts(result)) {
    for (const locator of fact.sourceLocators) {
      const path = normalizeRepositoryLocator(locator).path;
      if (!path || !admittedPaths.has(path)) failAuthoringCandidate("invalid-evidence");
    }
  }
}

function assertSourceInputBinding(
  input: AuthoringSourceObligationInputV1,
  originalRevision: string,
  planDigest: string,
  writePaths: readonly string[],
): void {
  if (!input.planBinding) failAuthoringCandidate("stale-evidence");
  try {
    validateAdmittedDocumentationPlanBinding(input.planBinding, { expectedMode: "create" });
  } catch {
    failAuthoringCandidate("invalid-evidence");
  }
  if (
    input.workflow.name !== "create-documentation" ||
    input.evidenceIdentity?.repositoryRevision !== originalRevision ||
    input.planBinding.digest !== planDigest ||
    !sameStrings(documentationPlanWritePaths(input.planBinding), writePaths)
  ) {
    failAuthoringCandidate("stale-evidence");
  }
}

function assertFactsExactlyMatch(
  actual: readonly AuthoringActionableTechnicalFactV1[],
  expected: readonly AuthoringActionableTechnicalFactV1[],
): void {
  if (actual.length !== expected.length) failAuthoringCandidate("inconsistent-linked-issues");
  const expectedById = new Map(expected.map((fact) => [fact.id, fact]));
  for (let index = 0; index < expected.length; index += 1) {
    const actualFact = actual[index]!;
    const expectedFact = expectedById.get(actualFact.id);
    if (!expectedFact) failAuthoringCandidate("unknown-fact");
    if (actualFact.issueIds.some((issueId) => !expectedFact.issueIds.includes(issueId))) {
      failAuthoringCandidate("unknown-issue");
    }
    if (kit.canonicalDigest(actualFact) !== kit.canonicalDigest(expectedFact)) {
      failAuthoringCandidate("inconsistent-linked-issues");
    }
  }
}

function normalizePaths(value: unknown, requireNonEmpty: boolean): string[] {
  const paths = kit.array(value);
  if (paths.length > MAX_WRITE_PATHS || (requireNonEmpty && paths.length === 0)) {
    failAuthoringCandidate("invalid-value");
  }
  const normalized = paths.map((path) => {
    const result = kit.string(path);
    if (
      !SAFE_PATH.test(result) ||
      result.includes("\\") ||
      result.split("/").some((part) => !part || part === "." || part === "..")
    ) {
      failAuthoringCandidate("wrong-write-paths");
    }
    return result;
  });
  if (new Set(normalized).size !== normalized.length) failAuthoringCandidate("wrong-write-paths");
  return normalized.sort();
}

function normalizeLocators(value: unknown): string[] {
  const locators = kit.array(value);
  if (locators.length === 0 || locators.length > MAX_SOURCE_LOCATORS) {
    failAuthoringCandidate("invalid-value");
  }
  const normalized = locators.map((locator) => {
    const result = boundedText(locator, 4_096);
    const normalizedLocator = normalizeRepositoryLocator(result);
    if (normalizedLocator.malformed || !normalizedLocator.specific) {
      failAuthoringCandidate("invalid-value");
    }
    return result;
  });
  if (new Set(normalized).size !== normalized.length) failAuthoringCandidate("duplicate-fact");
  return normalized.sort();
}

function normalizeIssueIds(value: unknown): string[] {
  const issueIds = kit.array(value);
  if (issueIds.length > MAX_ISSUES_PER_FACT) failAuthoringCandidate("invalid-value");
  const normalized = issueIds.map((issueId) => {
    const result = kit.string(issueId);
    if (!ISSUE_ID.test(result)) failAuthoringCandidate("invalid-value");
    return result;
  });
  if (new Set(normalized).size !== normalized.length) failAuthoringCandidate("duplicate-issue");
  return normalized.sort();
}

function boundedProducer(value: unknown): string {
  const result = kit.string(value);
  if (!PRODUCER_ID.test(result)) failAuthoringCandidate("invalid-value");
  return result;
}

function boundedText(value: unknown, maxLength: number, minLength = 1): string {
  const result = kit.string(value);
  const trimmed = result.trim();
  if (result !== trimmed || trimmed.length < minLength || trimmed.length > maxLength) {
    failAuthoringCandidate("invalid-value");
  }
  return result;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assertSafeInput(value: unknown): void {
  kit.assertInert(value);
  kit.rejectCredentials(value);
}
