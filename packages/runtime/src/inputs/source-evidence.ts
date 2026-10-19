// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Closed, content-free wire records binding original bytes, derivative
 * representations, per-step reads, and output citations. They carry identity
 * and digests only: no body, custody path, credential, or raw private locator.
 *
 * A decoded record is inert and grants no access; only the process-local
 * service in `source-resolver.ts` can open a source.
 */
import { canonicalDigest } from "../content-ir/canonical.js";
import { createContractKit, deepFreeze, UNSAFE_PATH_CODE_POINT } from "../contract-kit/index.js";
import { limitDefinition } from "../config/limits.js";
import {
  SOURCE_AUTHORITY_MEMBER_PATH_MAX_CHARS_LIMIT,
  isDeclaredSourceOverflowLimitName,
} from "../config/source-read-limits.js";
import type { RunRequest } from "../execution/contracts.js";

export const SOURCE_EVIDENCE_SCHEMA_VERSION = 1 as const;

export const SOURCE_OBSERVATION_KIND = "docsfab-source-observation" as const;
export const SOURCE_BINDING_KIND = "docsfab-source-binding" as const;
export const SOURCE_SPAN_ACCESS_KIND = "docsfab-source-span-access" as const;
export const SOURCE_SPAN_CITATION_KIND = "docsfab-source-span-citation" as const;
export const SOURCE_EVIDENCE_FINAL_KIND = "docsfab-source-evidence-final" as const;
export const SOURCE_REQUEST_CONTEXT_KIND = "docsfab-source-request-context" as const;
export const SOURCE_SPAN_ID_KIND = "docsfab-source-span-id" as const;
export const SOURCE_REPRESENTATION_ID_KIND = "docsfab-source-representation-id" as const;
export const SOURCE_EXTRACTOR_OPTIONS_KIND = "docsfab-source-extractor-options" as const;

/** Derivatives are always plain UTF-8 text. */
export const SOURCE_REPRESENTATION_MEDIA_TYPE = "text/plain; charset=utf-8" as const;
export const SOURCE_EXACT_ORIGINAL_FORM = "exact-original-utf8" as const;

/** Frozen locator discriminants. */
export const SOURCE_LOCATOR_KINDS = [
  "diff",
  "docx-block",
  "html-node",
  "json-pointer",
  "notebook-cell",
  "pdf-page",
  "text",
] as const;
export type SourceLocatorKind = (typeof SOURCE_LOCATOR_KINDS)[number];

export const SOURCE_NOTEBOOK_PARTS = ["output", "source"] as const;

/**
 * What a `diff` span holds: the host's manifest of every file; a patch's
 * message before its first file (`preamble`); text after a file that opens no
 * file (`trailer`), such as a mail signature; one file's header lines; one
 * hunk; text after a hunk's counts that opens nothing (`note`); or one whole
 * file when per-hunk spans would not fit the span ceiling.
 */
export const SOURCE_DIFF_PARTS = [
  "file",
  "header",
  "hunk",
  "manifest",
  "note",
  "preamble",
  "trailer",
] as const;
export type SourceDiffPart = (typeof SOURCE_DIFF_PARTS)[number];
export const SOURCE_DIFF_CHANGES = ["added", "copied", "deleted", "modified", "renamed"] as const;
export type SourceDiffChange = (typeof SOURCE_DIFF_CHANGES)[number];
/**
 * What a reader may weigh differently about one file. `binary`, `non-utf8`, and
 * `combined` also mean some of the file's text is not addressed hunk by hunk;
 * `unrepresentable-path` means a path the locator cannot carry was nulled.
 */
export const SOURCE_DIFF_LABELS = [
  "binary",
  "combined",
  "generated",
  "lockfile",
  "non-utf8",
  "unrepresentable-path",
  "vendored",
] as const;
export type SourceDiffLabel = (typeof SOURCE_DIFF_LABELS)[number];

export const SOURCE_REPRESENTATION_COMPLETENESS = ["complete", "partial"] as const;
export type SourceRepresentationCompleteness = (typeof SOURCE_REPRESENTATION_COMPLETENESS)[number];

/** Adapters pick from this list; free prose is rejected. */
export const SOURCE_REPRESENTATION_LIMITATIONS = [
  "active-content-excluded",
  "byte-budget-truncated",
  "hidden-content-excluded",
  "non-text-content-excluded",
  "span-budget-truncated",
  "unsupported-encoding",
  "unsupported-structure",
] as const;
export type SourceRepresentationLimitation = (typeof SOURCE_REPRESENTATION_LIMITATIONS)[number];

export const SOURCE_REQUIRED_COVERAGE_STATUSES = [
  "considered",
  "partial",
  "unavailable",
  "unread",
] as const;
export type SourceRequiredCoverageStatus = (typeof SOURCE_REQUIRED_COVERAGE_STATUSES)[number];
export const SOURCE_EXACT_ORIGINAL_COVERAGE_STATUSES = [
  "complete",
  "partial",
  "unavailable",
  "unread",
] as const;
export type SourceExactOriginalCoverageStatus =
  (typeof SOURCE_EXACT_ORIGINAL_COVERAGE_STATUSES)[number];

export type SourceEvidenceErrorCode =
  | "invalid-shape"
  | "invalid-value"
  | "digest-mismatch"
  | "credential-material"
  | "migration-required"
  | "substitution"
  | "span-mismatch"
  | "projection-unversioned"
  | "continuation-projection-pending";

/** The refused field and why, in host vocabulary; never a source byte. */
export interface SourceEvidenceRefusalDetail {
  readonly field: string;
  readonly reason: string;
}

export class SourceEvidenceContractError extends Error {
  public readonly field?: string;
  public readonly reason?: string;

  public constructor(
    public readonly code: SourceEvidenceErrorCode,
    detail?: SourceEvidenceRefusalDetail,
  ) {
    super(
      detail
        ? `Source-evidence contract rejected: ${code}. Field ${detail.field}: ${detail.reason}.`
        : `Source-evidence contract rejected: ${code}.`,
    );
    this.name = "SourceEvidenceContractError";
    if (detail) {
      this.field = detail.field;
      this.reason = detail.reason;
    }
  }
}

export function failSourceEvidence(
  code: SourceEvidenceErrorCode,
  detail?: SourceEvidenceRefusalDetail,
): never {
  throw new SourceEvidenceContractError(code, detail);
}

const kit = createContractKit<SourceEvidenceErrorCode>({
  fail: (code) => failSourceEvidence(code),
  codes: {
    invalidShape: "invalid-shape",
    invalidValue: "invalid-value",
    digestMismatch: "digest-mismatch",
    credentialMaterial: "credential-material",
    schemaMismatch: "migration-required",
  },
});

const {
  assertInert,
  rejectCredentials,
  object,
  exact,
  array,
  string,
  identifier,
  hash,
  nullableHash,
  revision,
  timestamp,
  enumeration,
  compare,
  unique,
  normalizedHashes,
  normalizedIds,
  seal,
  decodeSealed,
} = kit;

export interface SourceRepositoryBindingV1 {
  identitySha256: string;
  revision: string;
}

export type SourceExternalVersionV1 =
  | { kind: "repository-revision"; revision: string }
  | { kind: "timestamp"; observedAt: string }
  | { kind: "etag"; etagSha256: string }
  | { kind: "content-digest"; contentDigestSha256: string }
  | { kind: "unavailable"; reasonCode: string };

/**
 * A span of a unified diff. `fileOrdinal` and `hunkOrdinal` are 1-based in the
 * diff's own order, so a path that repeats in a patch series still names one
 * file. A path is `null` on the `/dev/null` side or when the locator cannot
 * carry it. `startByte` and `endByte` are offsets into the original and are
 * `null` only for the host-written manifest.
 */
export interface SourceDiffLocatorV1 {
  kind: "diff";
  part: SourceDiffPart;
  fileOrdinal: number | null;
  oldPath: string | null;
  newPath: string | null;
  change: SourceDiffChange | null;
  /** Sorted and unique; empty for a part that names no file. */
  labels: SourceDiffLabel[];
  hunkOrdinal: number | null;
  hunkCount: number | null;
  oldStart: number | null;
  oldLines: number | null;
  newStart: number | null;
  newLines: number | null;
  startByte: number | null;
  endByte: number | null;
}

export type SourceSpanLocatorV1 =
  | { kind: "text"; startByte: number; endByte: number }
  | SourceDiffLocatorV1
  | { kind: "json-pointer"; pointer: string }
  | {
      kind: "notebook-cell";
      cellId: string | null;
      cellOrdinal: number;
      part: "source" | "output";
      outputOrdinal: number | null;
      startByte: number;
      endByte: number;
    }
  | { kind: "html-node"; nodeOrdinal: number; textStartByte: number; textEndByte: number }
  | { kind: "pdf-page"; pageNumber: number; itemStart: number; itemEnd: number }
  | {
      kind: "docx-block";
      part: string;
      blockPath: number[];
      paragraphOrdinal: number | null;
      tableCell: { row: number; column: number } | null;
    };

export interface SourceSpanV1 {
  spanId: string;
  startByte: number;
  endByte: number;
  locator: SourceSpanLocatorV1;
}

/** `observed` is the value before truncation. */
export interface SourceLimitOverflowV1 {
  limitation: SourceRepresentationLimitation;
  limitName: string;
  observed: number;
}

export interface SourceExtractorIdentityV1 {
  id: string;
  version: string;
  optionsSha256: string;
}

export interface SourceRepresentationV1 {
  representationId: string;
  mediaType: typeof SOURCE_REPRESENTATION_MEDIA_TYPE;
  sha256: string;
  byteLength: number;
  extractor: SourceExtractorIdentityV1;
  originalSha256: string;
  spans: SourceSpanV1[];
  completeness: SourceRepresentationCompleteness;
  limitations: SourceRepresentationLimitation[];
  overflows?: SourceLimitOverflowV1[];
  /** Absent for historical normalized derivatives. */
  form?: typeof SOURCE_EXACT_ORIGINAL_FORM;
  representationSha256: string;
}

export interface SourceOriginalV1 {
  sha256: string;
  byteLength: number;
  mediaType: string;
  locatorSha256: string;
  version: SourceExternalVersionV1;
  repositoryPath: string | null;
}

export interface SourceObservationV1 {
  schemaVersion: 1;
  kind: typeof SOURCE_OBSERVATION_KIND;
  observationId: string;
  originIdSha256: string;
  inputId: string;
  registrationSha256: string;
  /** Original-only observations use the primary registration. */
  primaryContentForm?: typeof SOURCE_EXACT_ORIGINAL_FORM;
  /** Paired original registration on a derivative-primary observation. */
  originalInputId?: string;
  originalRegistrationSha256?: string;
  runIdSha256: string;
  repository: SourceRepositoryBindingV1;
  requestSha256: string;
  producerId: string;
  producerVersion: string;
  producerScopeSha256: string;
  acquisitionReceiptSha256: string;
  observedAt: string;
  original: SourceOriginalV1;
  representations: SourceRepresentationV1[];
  observationSha256: string;
}

export interface SourceBindingObservationRefV1 {
  observationId: string;
  observationSha256: string;
}

export interface SourceBindingV1 {
  schemaVersion: 1;
  kind: typeof SOURCE_BINDING_KIND;
  runIdSha256: string;
  repository: SourceRepositoryBindingV1;
  requestSha256: string;
  hostPolicySha256: string;
  producerScopeSha256: string;
  parentBindingSha256: string | null;
  observations: SourceBindingObservationRefV1[];
  requiredObservationIds: string[];
  bindingSha256: string;
}

export interface SourceSpanAccessV1 {
  schemaVersion: 1;
  kind: typeof SOURCE_SPAN_ACCESS_KIND;
  bindingSha256: string;
  observationId: string;
  representationId: string;
  representationSha256: string;
  stepId: string;
  accessObservationSha256: string;
  spanIds: string[];
  observedAt: string;
  /** Actual serialized model-visible bytes, only for original-form reads. */
  serializedChargeBytes?: number;
  spanAccessSha256: string;
}

export interface SourceSpanCitationV1 {
  schemaVersion: 1;
  kind: typeof SOURCE_SPAN_CITATION_KIND;
  bindingSha256: string;
  observationId: string;
  representationId: string;
  representationSha256: string;
  stepId: string;
  spanIds: string[];
  spanAccessSha256s: string[];
  supportedClaimSha256: string;
  externalInputCitationSha256: string;
  spanCitationSha256: string;
}

export interface SourceEvidenceFinalV1 {
  schemaVersion: 1;
  kind: typeof SOURCE_EVIDENCE_FINAL_KIND;
  bindingSha256: string;
  externalInputManifestSha256: string;
  accessLedgerSha256: string;
  citationLedgerSha256: string;
  spanAccessSha256s: string[];
  spanCitationSha256s: string[];
  limitations: Array<{ observationId: string; reasonCode: SourceRepresentationLimitation }>;
  requiredCoverage: Array<{ observationId: string; status: SourceRequiredCoverageStatus }>;
  exactOriginalCoverage?: Array<{
    observationId: string;
    status: SourceExactOriginalCoverageStatus;
    originalBytesRead: number;
    originalByteLength: number;
    serializedBytesCharged: number;
    remainingSpanIds: string[];
  }>;
  evidenceSha256: string;
}

const MAX_BYTE_LENGTH = 64 * 1024 * 1024;
/** Largest ordinal or line number a `diff` locator admits. */
export const SOURCE_DIFF_LOCATOR_MAX_NUMBER = MAX_BYTE_LENGTH;
const MAX_SPANS_PER_REPRESENTATION = 4_096;
const MAX_REPRESENTATIONS = 32;
/** Observations one source binding holds; a producer that binds many checks it before any model call. */
export const MAX_OBSERVATIONS = 256;
const MEDIA_TYPE =
  /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}(?:; charset=[a-z0-9-]{1,32})?$/u;
/**
 * A hidden name such as `.bench/change.json` is a legitimate tracked source;
 * an entire `.` or `..` segment, absolute path or empty segment is refused.
 */
const REPOSITORY_PATH = /^[\p{L}\p{M}\p{N}\p{P}\p{S} \/]{1,1024}$/u;
const REPOSITORY_PATH_RULE =
  "a repository path is 1 to 1,024 printable letters, marks, digits, punctuation, symbols, plain spaces or '/' characters, is relative, and has no backslash, empty, '.' or '..' segment";

/** Exact UTF-8 Git path identity; only this field bypasses the NFC text validator. */
function originalRepositoryPath(value: unknown): string {
  if (
    typeof value !== "string" ||
    !REPOSITORY_PATH.test(value) ||
    value.startsWith("/") ||
    /^[A-Za-z]:/u.test(value) ||
    value.includes("\\") ||
    value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  )
    failSourceEvidence("invalid-value", {
      field: "original.repositoryPath",
      reason: REPOSITORY_PATH_RULE,
    });
  return value;
}

function count(value: unknown, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) {
    failSourceEvidence("invalid-value");
  }
  return value;
}

function mediaType(value: unknown): string {
  const result = string(value);
  if (!MEDIA_TYPE.test(result)) failSourceEvidence("invalid-value");
  return result;
}

function repositoryBinding(value: unknown): SourceRepositoryBindingV1 {
  const root = object(value);
  exact(root, ["identitySha256", "revision"]);
  return { identitySha256: hash(root.identitySha256), revision: revision(root.revision) };
}

function externalVersion(value: unknown): SourceExternalVersionV1 {
  const root = object(value);
  const kind = enumeration(root.kind, [
    "repository-revision",
    "timestamp",
    "etag",
    "content-digest",
    "unavailable",
  ] as const);
  if (kind === "repository-revision") {
    exact(root, ["kind", "revision"]);
    return { kind, revision: revision(root.revision) };
  }
  if (kind === "timestamp") {
    exact(root, ["kind", "observedAt"]);
    return { kind, observedAt: timestamp(root.observedAt) };
  }
  if (kind === "etag") {
    exact(root, ["kind", "etagSha256"]);
    return { kind, etagSha256: hash(root.etagSha256) };
  }
  if (kind === "content-digest") {
    exact(root, ["kind", "contentDigestSha256"]);
    return { kind, contentDigestSha256: hash(root.contentDigestSha256) };
  }
  exact(root, ["kind", "reasonCode"]);
  return { kind, reasonCode: identifier(root.reasonCode) };
}

/** Normalizes one locator; an unfamiliar kind or extra field is rejected. */
export function normalizeSourceLocator(
  value: unknown,
  allowEmptyOriginalWitness = false,
): SourceSpanLocatorV1 {
  const root = object(value);
  const kind = enumeration(root.kind, SOURCE_LOCATOR_KINDS);
  if (kind === "text") {
    exact(root, ["kind", "startByte", "endByte"]);
    const startByte = count(root.startByte, MAX_BYTE_LENGTH);
    const endByte = count(root.endByte, MAX_BYTE_LENGTH);
    if (endByte <= startByte && !(allowEmptyOriginalWitness && startByte === 0 && endByte === 0))
      failSourceEvidence("invalid-value");
    return { kind, startByte, endByte };
  }
  if (kind === "json-pointer") {
    exact(root, ["kind", "pointer"]);
    const pointer = string(root.pointer);
    if (pointer.length > 4_096) failSourceEvidence("invalid-value");
    if (pointer !== "" && !/^(?:\/(?:[^~/]|~[01])*)+$/u.test(pointer)) {
      failSourceEvidence("invalid-value");
    }
    return { kind, pointer };
  }
  if (kind === "notebook-cell") {
    exact(root, ["kind", "cellId", "cellOrdinal", "part", "outputOrdinal", "startByte", "endByte"]);
    const part = enumeration(root.part, SOURCE_NOTEBOOK_PARTS);
    const outputOrdinal =
      root.outputOrdinal === null ? null : count(root.outputOrdinal, MAX_SPANS_PER_REPRESENTATION);
    if ((part === "output") !== (outputOrdinal !== null)) failSourceEvidence("invalid-value");
    const startByte = count(root.startByte, MAX_BYTE_LENGTH);
    const endByte = count(root.endByte, MAX_BYTE_LENGTH);
    if (endByte <= startByte) failSourceEvidence("invalid-value");
    return {
      kind,
      cellId: root.cellId === null ? null : identifier(root.cellId),
      cellOrdinal: count(root.cellOrdinal, MAX_SPANS_PER_REPRESENTATION),
      part,
      outputOrdinal,
      startByte,
      endByte,
    };
  }
  if (kind === "html-node") {
    exact(root, ["kind", "nodeOrdinal", "textStartByte", "textEndByte"]);
    const textStartByte = count(root.textStartByte, MAX_BYTE_LENGTH);
    const textEndByte = count(root.textEndByte, MAX_BYTE_LENGTH);
    if (textEndByte <= textStartByte) failSourceEvidence("invalid-value");
    return {
      kind,
      nodeOrdinal: count(root.nodeOrdinal, MAX_BYTE_LENGTH),
      textStartByte,
      textEndByte,
    };
  }
  if (kind === "diff") return normalizeDiffLocator(root);
  if (kind === "pdf-page") {
    exact(root, ["kind", "pageNumber", "itemStart", "itemEnd"]);
    const pageNumber = count(root.pageNumber, MAX_BYTE_LENGTH);
    if (pageNumber < 1) failSourceEvidence("invalid-value");
    const itemStart = count(root.itemStart, MAX_BYTE_LENGTH);
    const itemEnd = count(root.itemEnd, MAX_BYTE_LENGTH);
    if (itemEnd <= itemStart) failSourceEvidence("invalid-value");
    return { kind, pageNumber, itemStart, itemEnd };
  }
  if (kind === "docx-block") {
    exact(root, ["kind", "part", "blockPath", "paragraphOrdinal", "tableCell"]);
    const blockPath = array(root.blockPath).map((entry) => count(entry, MAX_BYTE_LENGTH));
    if (blockPath.length === 0 || blockPath.length > 64) failSourceEvidence("invalid-value");
    let tableCell: { row: number; column: number } | null = null;
    if (root.tableCell !== null) {
      const cell = object(root.tableCell);
      exact(cell, ["row", "column"]);
      tableCell = {
        row: count(cell.row, MAX_BYTE_LENGTH),
        column: count(cell.column, MAX_BYTE_LENGTH),
      };
    }
    return {
      kind,
      part: identifier(root.part),
      blockPath,
      paragraphOrdinal:
        root.paragraphOrdinal === null ? null : count(root.paragraphOrdinal, MAX_BYTE_LENGTH),
      tableCell,
    };
  }
  // A kind added to the discriminant set without a branch here is refused, not
  // decoded as some other kind.
  return failSourceEvidence("invalid-value");
}

const DIFF_LOCATOR_KEYS = [
  "kind",
  "part",
  "fileOrdinal",
  "oldPath",
  "newPath",
  "change",
  "labels",
  "hunkOrdinal",
  "hunkCount",
  "oldStart",
  "oldLines",
  "newStart",
  "newLines",
  "startByte",
  "endByte",
];

/** The catalogued bound on a repository-relative path that sealed evidence keeps. */
const DIFF_PATH_MAX_CHARS = limitDefinition(SOURCE_AUTHORITY_MEMBER_PATH_MAX_CHARS_LIMIT).value;
const WINDOWS_DRIVE = /^[A-Za-z]:/u;

/**
 * True when a diff path is one a `diff` locator carries: non-empty NFC text of
 * at most `sources.authorityMemberPathMaxChars` code units, with none of the
 * code points a sealed path refuses, so a path cannot forge a manifest line.
 * It is repository-relative: no backslash, drive letter, or empty, `.`, or
 * `..` segment. Adapters null any other path and label it.
 */
export function isSourceDiffPathAdmitted(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= DIFF_PATH_MAX_CHARS &&
    path === path.normalize("NFC") &&
    !UNSAFE_PATH_CODE_POINT.test(path) &&
    !path.includes("\\") &&
    !WINDOWS_DRIVE.test(path) &&
    path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

function nullableCount(value: unknown): number | null {
  return value === null ? null : count(value, SOURCE_DIFF_LOCATOR_MAX_NUMBER);
}

function diffPath(value: unknown): string | null {
  if (value === null) return null;
  const path = string(value);
  if (!isSourceDiffPathAdmitted(path)) failSourceEvidence("invalid-value");
  return path;
}

function diffLabels(value: unknown): SourceDiffLabel[] {
  const labels = array(value).map((entry) => enumeration(entry, SOURCE_DIFF_LABELS));
  if (labels.some((label, index) => index > 0 && compare(labels[index - 1]!, label) >= 0)) {
    failSourceEvidence("invalid-value");
  }
  return labels;
}

/**
 * Cross-field rules per part. The manifest is host text, so it names no file
 * and no original bytes. A preamble or trailer names original bytes but no
 * file. A header or file span names one file and its hunk count, and a hunk
 * span names its file, ordinal, and `@@` ranges.
 */
function normalizeDiffLocator(root: Record<string, unknown>): SourceDiffLocatorV1 {
  exact(root, DIFF_LOCATOR_KEYS);
  const part = enumeration(root.part, SOURCE_DIFF_PARTS);
  const locator: SourceDiffLocatorV1 = {
    kind: "diff",
    part,
    fileOrdinal: nullableCount(root.fileOrdinal),
    oldPath: diffPath(root.oldPath),
    newPath: diffPath(root.newPath),
    change: root.change === null ? null : enumeration(root.change, SOURCE_DIFF_CHANGES),
    labels: diffLabels(root.labels),
    hunkOrdinal: nullableCount(root.hunkOrdinal),
    hunkCount: nullableCount(root.hunkCount),
    oldStart: nullableCount(root.oldStart),
    oldLines: nullableCount(root.oldLines),
    newStart: nullableCount(root.newStart),
    newLines: nullableCount(root.newLines),
    startByte: nullableCount(root.startByte),
    endByte: nullableCount(root.endByte),
  };
  const ranges = [locator.oldStart, locator.oldLines, locator.newStart, locator.newLines];
  const hunkFields = [locator.hunkOrdinal, ...ranges];
  const fileFields = [locator.fileOrdinal, locator.oldPath, locator.newPath, locator.change];
  const bytesNamed =
    locator.startByte !== null && locator.endByte !== null && locator.endByte > locator.startByte;
  const allNull = (values: readonly unknown[]) => values.every((value) => value === null);
  let valid: boolean;
  if (part === "manifest") {
    valid =
      allNull([
        ...fileFields,
        ...hunkFields,
        locator.hunkCount,
        locator.startByte,
        locator.endByte,
      ]) && locator.labels.length === 0;
  } else if (part === "preamble" || part === "trailer") {
    valid =
      bytesNamed &&
      allNull([...fileFields, ...hunkFields, locator.hunkCount]) &&
      locator.labels.length === 0;
  } else {
    // A header that states no path, such as a bare `diff -u` line, leaves both null.
    const fileNamed =
      bytesNamed &&
      locator.fileOrdinal !== null &&
      locator.fileOrdinal >= 1 &&
      locator.change !== null;
    valid =
      fileNamed &&
      (part === "hunk"
        ? locator.hunkOrdinal !== null &&
          locator.hunkOrdinal >= 1 &&
          locator.hunkCount === null &&
          ranges.every((value) => value !== null)
        : part === "note"
          ? locator.hunkCount === null && allNull(hunkFields)
          : locator.hunkCount !== null &&
            (part === "file" || locator.hunkCount >= 1) &&
            allNull(hunkFields));
  }
  if (!valid) failSourceEvidence("invalid-value");
  return locator;
}

/** Digests the pinned transformation settings, never the source bytes. */
export function digestSourceExtractorOptions(options: unknown): string {
  assertInert(options);
  rejectCredentials(options);
  return canonicalDigest({
    schemaVersion: SOURCE_EVIDENCE_SCHEMA_VERSION,
    kind: SOURCE_EXTRACTOR_OPTIONS_KIND,
    options: options ?? null,
  });
}

function extractorIdentity(value: unknown): SourceExtractorIdentityV1 {
  const root = object(value);
  exact(root, ["id", "version", "optionsSha256"]);
  return {
    id: identifier(root.id),
    version: identifier(root.version),
    optionsSha256: hash(root.optionsSha256),
  };
}

/**
 * Host-computed span identity over the original, extractor, derivative, range,
 * and locator. The model only receives span ids; it never supplies one.
 */
export function computeSourceSpanId(input: {
  originalSha256: string;
  extractor: SourceExtractorIdentityV1;
  derivativeSha256: string;
  startByte: number;
  endByte: number;
  locator: SourceSpanLocatorV1;
  /** Only the sealed exact-original zero-byte witness may use a zero extent. */
  allowEmptyOriginalWitness?: boolean;
}): string {
  return `span-${canonicalDigest({
    schemaVersion: SOURCE_EVIDENCE_SCHEMA_VERSION,
    kind: SOURCE_SPAN_ID_KIND,
    originalSha256: hash(input.originalSha256),
    extractor: extractorIdentity(input.extractor),
    derivativeSha256: hash(input.derivativeSha256),
    startByte: count(input.startByte, MAX_BYTE_LENGTH),
    endByte: count(input.endByte, MAX_BYTE_LENGTH),
    locator: normalizeSourceLocator(input.locator, input.allowEmptyOriginalWitness),
  })}`;
}

/** Independent of `representationSha256`, so no identifier/hash cycle exists. */
export function computeSourceRepresentationId(input: {
  originalSha256: string;
  extractor: SourceExtractorIdentityV1;
}): string {
  return `rep-${canonicalDigest({
    schemaVersion: SOURCE_EVIDENCE_SCHEMA_VERSION,
    kind: SOURCE_REPRESENTATION_ID_KIND,
    originalSha256: hash(input.originalSha256),
    extractor: extractorIdentity(input.extractor),
  })}`;
}

export function originalSourceRepresentationId(originalSha256: string): string {
  return `original-${hash(originalSha256)}`;
}

function limitations(value: unknown): SourceRepresentationLimitation[] {
  const result = array(value)
    .map((entry) => enumeration(entry, SOURCE_REPRESENTATION_LIMITATIONS))
    .sort(compare);
  unique(result);
  return result;
}

function limitName(value: unknown): string {
  const result = string(value);
  if (
    !/^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)+$/u.test(result) ||
    !isDeclaredSourceOverflowLimitName(result)
  ) {
    failSourceEvidence("invalid-value");
  }
  return result;
}

function overflows(value: unknown): SourceLimitOverflowV1[] {
  const result = array(value).map((row) => {
    const entry = object(row);
    exact(entry, ["limitation", "limitName", "observed"]);
    return {
      limitation: enumeration(entry.limitation, SOURCE_REPRESENTATION_LIMITATIONS),
      limitName: limitName(entry.limitName),
      observed: count(entry.observed, MAX_BYTE_LENGTH),
    };
  });
  unique(result.map((entry) => `${entry.limitation}\0${entry.limitName}`));
  return result;
}

function spans(
  value: unknown,
  context: {
    originalSha256: string;
    extractor: SourceExtractorIdentityV1;
    derivativeSha256: string;
    byteLength: number;
    exactOriginal: boolean;
  },
): SourceSpanV1[] {
  const rows = array(value);
  if (rows.length > MAX_SPANS_PER_REPRESENTATION) failSourceEvidence("invalid-value");
  const normalized = rows.map((row) => {
    const entry = object(row);
    exact(entry, ["spanId", "startByte", "endByte", "locator"]);
    const startByte = count(entry.startByte, MAX_BYTE_LENGTH);
    const endByte = count(entry.endByte, MAX_BYTE_LENGTH);
    const emptyWitness =
      context.exactOriginal && context.byteLength === 0 && startByte === 0 && endByte === 0;
    if ((endByte <= startByte && !emptyWitness) || endByte > context.byteLength)
      failSourceEvidence("invalid-value");
    const locator = normalizeSourceLocator(entry.locator, emptyWitness);
    if (
      context.exactOriginal &&
      (locator.kind !== "text" || locator.startByte !== startByte || locator.endByte !== endByte)
    )
      failSourceEvidence("invalid-value");
    const spanId = identifier(entry.spanId);
    // A wrong original, extractor, derivative, range, or locator produces a
    // different identity here, so a substituted span cannot decode.
    if (
      spanId !==
      computeSourceSpanId({
        originalSha256: context.originalSha256,
        extractor: context.extractor,
        derivativeSha256: context.derivativeSha256,
        startByte,
        endByte,
        locator,
        ...(emptyWitness ? { allowEmptyOriginalWitness: true } : {}),
      })
    ) {
      failSourceEvidence("span-mismatch");
    }
    return { spanId, startByte, endByte, locator };
  });
  unique(normalized.map((entry) => entry.spanId));
  const ordered = [...normalized].sort((left, right) => left.startByte - right.startByte);
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index]!.startByte < ordered[index - 1]!.endByte) {
      failSourceEvidence("invalid-value");
    }
  }
  if (context.exactOriginal) {
    if (ordered.length === 0 || ordered[0]!.startByte !== 0) failSourceEvidence("invalid-value");
    for (let index = 1; index < ordered.length; index += 1) {
      if (ordered[index]!.startByte !== ordered[index - 1]!.endByte)
        failSourceEvidence("invalid-value");
    }
    if (
      ordered.at(-1)!.endByte !== context.byteLength ||
      (context.byteLength === 0 && ordered.length !== 1)
    )
      failSourceEvidence("invalid-value");
  }
  // Extraction order is retained; only the overlap check uses byte order.
  return normalized;
}

function sealRepresentation(
  body: Omit<SourceRepresentationV1, "representationSha256">,
): SourceRepresentationV1 {
  return deepFreeze({ ...body, representationSha256: canonicalDigest(body) });
}

function representation(value: unknown, originalSha256: string): SourceRepresentationV1 {
  assertInert(value);
  rejectCredentials(value);
  const root = object(value);
  exact(
    root,
    [
      "representationId",
      "mediaType",
      "sha256",
      "byteLength",
      "extractor",
      "originalSha256",
      "spans",
      "completeness",
      "limitations",
      "overflows",
      "form",
      "representationSha256",
    ],
    ["overflows", "form"],
  );
  const exactOriginal = Object.hasOwn(root, "form");
  if (exactOriginal && root.form !== SOURCE_EXACT_ORIGINAL_FORM)
    failSourceEvidence("invalid-value");
  if (root.mediaType !== SOURCE_REPRESENTATION_MEDIA_TYPE) failSourceEvidence("invalid-value");
  const extractor = extractorIdentity(root.extractor);
  const boundOriginal = hash(root.originalSha256);
  if (boundOriginal !== originalSha256) failSourceEvidence("substitution");
  const representationId = identifier(root.representationId);
  if (representationId !== computeSourceRepresentationId({ originalSha256, extractor })) {
    failSourceEvidence("substitution");
  }
  const sha256 = hash(root.sha256);
  const byteLength = count(root.byteLength, MAX_BYTE_LENGTH);
  const completeness = enumeration(root.completeness, SOURCE_REPRESENTATION_COMPLETENESS);
  if (exactOriginal && (sha256 !== originalSha256 || completeness !== "complete" || byteLength < 0))
    failSourceEvidence("invalid-value");
  const reasons = limitations(root.limitations);
  if ((completeness === "partial") !== reasons.length > 0) failSourceEvidence("invalid-value");
  if (exactOriginal && reasons.length > 0) failSourceEvidence("invalid-value");
  const overflowRows = Object.hasOwn(root, "overflows") ? overflows(root.overflows) : undefined;
  if (overflowRows && overflowRows.some((entry) => !reasons.includes(entry.limitation))) {
    failSourceEvidence("invalid-value");
  }
  const body = {
    representationId,
    mediaType: SOURCE_REPRESENTATION_MEDIA_TYPE,
    sha256,
    byteLength,
    extractor,
    originalSha256: boundOriginal,
    spans: spans(root.spans, {
      originalSha256,
      extractor,
      derivativeSha256: sha256,
      byteLength,
      exactOriginal,
    }),
    completeness,
    limitations: reasons,
    ...(overflowRows && overflowRows.length > 0 ? { overflows: overflowRows } : {}),
    ...(exactOriginal ? { form: SOURCE_EXACT_ORIGINAL_FORM } : {}),
  };
  const sealed = sealRepresentation(body);
  if (root.representationSha256 !== sealed.representationSha256) {
    failSourceEvidence("digest-mismatch");
  }
  return sealed;
}

export function createSourceRepresentation(
  body: Omit<SourceRepresentationV1, "representationSha256" | "representationId" | "mediaType">,
): SourceRepresentationV1 {
  const extractor = extractorIdentity(body.extractor);
  const overflows =
    body.overflows && body.overflows.length > 0
      ? [...body.overflows].sort(
          (left, right) =>
            compare(left.limitation, right.limitation) || compare(left.limitName, right.limitName),
        )
      : undefined;
  const candidate = {
    representationId: computeSourceRepresentationId({
      originalSha256: body.originalSha256,
      extractor,
    }),
    mediaType: SOURCE_REPRESENTATION_MEDIA_TYPE,
    sha256: body.sha256,
    byteLength: body.byteLength,
    extractor,
    originalSha256: body.originalSha256,
    spans: body.spans,
    completeness: body.completeness,
    limitations: body.limitations,
    ...(overflows ? { overflows } : {}),
    ...(body.form ? { form: body.form } : {}),
  };
  return representation(
    { ...candidate, representationSha256: canonicalDigest(candidate) },
    hash(body.originalSha256),
  );
}

function original(value: unknown): SourceOriginalV1 {
  const root = object(value);
  exact(root, ["sha256", "byteLength", "mediaType", "locatorSha256", "version", "repositoryPath"]);
  let repositoryPath: string | null = null;
  if (root.repositoryPath !== null) {
    repositoryPath = originalRepositoryPath(root.repositoryPath);
  }
  return {
    sha256: hash(root.sha256),
    byteLength: count(root.byteLength, MAX_BYTE_LENGTH),
    mediaType: mediaType(root.mediaType),
    locatorSha256: hash(root.locatorSha256),
    version: externalVersion(root.version),
    repositoryPath,
  };
}

const OBSERVATION_BODY_KEYS = [
  "observationId",
  "originIdSha256",
  "inputId",
  "registrationSha256",
  "primaryContentForm",
  "originalInputId",
  "originalRegistrationSha256",
  "runIdSha256",
  "repository",
  "requestSha256",
  "producerId",
  "producerVersion",
  "producerScopeSha256",
  "acquisitionReceiptSha256",
  "observedAt",
  "original",
  "representations",
];

function normalizeObservation(
  root: Record<string, unknown>,
): Omit<SourceObservationV1, "schemaVersion" | "kind" | "observationSha256"> {
  const originalBody = original(root.original);
  const rows = array(root.representations);
  if (rows.length === 0 || rows.length > MAX_REPRESENTATIONS) failSourceEvidence("invalid-value");
  const representations = rows
    .map((row) => representation(row, originalBody.sha256))
    .sort(
      (left, right) =>
        Number(left.form === SOURCE_EXACT_ORIGINAL_FORM) -
          Number(right.form === SOURCE_EXACT_ORIGINAL_FORM) ||
        compare(left.representationId, right.representationId),
    );
  unique(representations.map((entry) => entry.representationId));
  const raw = representations.filter((entry) => entry.form === SOURCE_EXACT_ORIGINAL_FORM);
  if (raw.length > 1) failSourceEvidence("invalid-value");
  const originalOnly = Object.hasOwn(root, "primaryContentForm");
  if (originalOnly && root.primaryContentForm !== SOURCE_EXACT_ORIGINAL_FORM)
    failSourceEvidence("invalid-value");
  const hasOriginalInput = Object.hasOwn(root, "originalInputId");
  const hasOriginalRegistration = Object.hasOwn(root, "originalRegistrationSha256");
  if (hasOriginalInput !== hasOriginalRegistration) failSourceEvidence("invalid-value");
  if (raw.length === 0 && (originalOnly || hasOriginalInput)) failSourceEvidence("invalid-value");
  if (raw.length === 1) {
    if (raw[0]!.byteLength !== originalBody.byteLength) failSourceEvidence("substitution");
    if (originalOnly) {
      if (representations.length !== 1 || hasOriginalInput) failSourceEvidence("invalid-value");
    } else if (!hasOriginalInput || representations.length < 2) failSourceEvidence("invalid-value");
  }
  const inputId = identifier(root.inputId);
  const registrationSha256 = hash(root.registrationSha256);
  const originalInputId = hasOriginalInput ? identifier(root.originalInputId) : undefined;
  const originalRegistrationSha256 = hasOriginalRegistration
    ? hash(root.originalRegistrationSha256)
    : undefined;
  if (originalInputId === inputId || originalRegistrationSha256 === registrationSha256)
    failSourceEvidence("invalid-value");
  return {
    observationId: identifier(root.observationId),
    originIdSha256: hash(root.originIdSha256),
    inputId,
    registrationSha256,
    ...(originalOnly ? { primaryContentForm: SOURCE_EXACT_ORIGINAL_FORM } : {}),
    ...(originalInputId ? { originalInputId, originalRegistrationSha256 } : {}),
    runIdSha256: hash(root.runIdSha256),
    repository: repositoryBinding(root.repository),
    requestSha256: hash(root.requestSha256),
    producerId: identifier(root.producerId),
    producerVersion: identifier(root.producerVersion),
    producerScopeSha256: hash(root.producerScopeSha256),
    acquisitionReceiptSha256: hash(root.acquisitionReceiptSha256),
    observedAt: timestamp(root.observedAt),
    original: originalBody,
    representations,
  };
}

export function createSourceObservation(
  body: Omit<SourceObservationV1, "schemaVersion" | "kind" | "observationSha256">,
): SourceObservationV1 {
  assertInert(body);
  rejectCredentials(body);
  const root = object(body);
  exact(root, OBSERVATION_BODY_KEYS, [
    "primaryContentForm",
    "originalInputId",
    "originalRegistrationSha256",
  ]);
  return seal(SOURCE_OBSERVATION_KIND, "observationSha256", normalizeObservation(root));
}

export function decodeSourceObservation(value: unknown): SourceObservationV1 {
  assertInert(value);
  rejectCredentials(value);
  const root = object(value);
  exact(
    root,
    ["schemaVersion", "kind", "observationSha256", ...OBSERVATION_BODY_KEYS],
    ["primaryContentForm", "originalInputId", "originalRegistrationSha256"],
  );
  if (
    root.schemaVersion !== SOURCE_EVIDENCE_SCHEMA_VERSION ||
    root.kind !== SOURCE_OBSERVATION_KIND
  )
    failSourceEvidence("migration-required");
  const sealed = seal(SOURCE_OBSERVATION_KIND, "observationSha256", normalizeObservation(root));
  if (canonicalDigest(root) !== canonicalDigest(sealed)) failSourceEvidence("digest-mismatch");
  return sealed;
}

const BINDING_BODY_KEYS = [
  "runIdSha256",
  "repository",
  "requestSha256",
  "hostPolicySha256",
  "producerScopeSha256",
  "parentBindingSha256",
  "observations",
  "requiredObservationIds",
];

function normalizeBinding(
  root: Record<string, unknown>,
): Omit<SourceBindingV1, "schemaVersion" | "kind" | "bindingSha256"> {
  const rows = array(root.observations);
  if (rows.length === 0 || rows.length > MAX_OBSERVATIONS) failSourceEvidence("invalid-value");
  const observations = rows
    .map((row) => {
      const entry = object(row);
      exact(entry, ["observationId", "observationSha256"]);
      return {
        observationId: identifier(entry.observationId),
        observationSha256: hash(entry.observationSha256),
      };
    })
    .sort((left, right) => compare(left.observationId, right.observationId));
  unique(observations.map((entry) => entry.observationId));
  unique(observations.map((entry) => entry.observationSha256));
  const requiredObservationIds = normalizedIds(root.requiredObservationIds);
  const known = new Set(observations.map((entry) => entry.observationId));
  if (requiredObservationIds.some((id) => !known.has(id))) failSourceEvidence("substitution");
  return {
    runIdSha256: hash(root.runIdSha256),
    repository: repositoryBinding(root.repository),
    requestSha256: hash(root.requestSha256),
    hostPolicySha256: hash(root.hostPolicySha256),
    producerScopeSha256: hash(root.producerScopeSha256),
    parentBindingSha256: nullableHash(root.parentBindingSha256),
    observations,
    requiredObservationIds,
  };
}

export function createSourceBinding(
  body: Omit<SourceBindingV1, "schemaVersion" | "kind" | "bindingSha256">,
): SourceBindingV1 {
  assertInert(body);
  rejectCredentials(body);
  const root = object(body);
  exact(root, BINDING_BODY_KEYS);
  return seal(SOURCE_BINDING_KIND, "bindingSha256", normalizeBinding(root));
}

export function decodeSourceBinding(value: unknown): SourceBindingV1 {
  return decodeSealed(
    value,
    SOURCE_BINDING_KIND,
    "bindingSha256",
    BINDING_BODY_KEYS,
    normalizeBinding,
  ) as SourceBindingV1;
}

const SPAN_ACCESS_BODY_KEYS = [
  "bindingSha256",
  "observationId",
  "representationId",
  "representationSha256",
  "stepId",
  "accessObservationSha256",
  "spanIds",
  "observedAt",
  "serializedChargeBytes",
];

function normalizeSpanAccess(
  root: Record<string, unknown>,
): Omit<SourceSpanAccessV1, "schemaVersion" | "kind" | "spanAccessSha256"> {
  return {
    bindingSha256: hash(root.bindingSha256),
    observationId: identifier(root.observationId),
    representationId: identifier(root.representationId),
    representationSha256: hash(root.representationSha256),
    stepId: identifier(root.stepId),
    accessObservationSha256: hash(root.accessObservationSha256),
    spanIds: normalizedIds(root.spanIds, true),
    observedAt: timestamp(root.observedAt),
    ...(Object.hasOwn(root, "serializedChargeBytes")
      ? { serializedChargeBytes: positiveCharge(root.serializedChargeBytes) }
      : {}),
  };
}

function positiveCharge(value: unknown): number {
  const charge = count(value, MAX_BYTE_LENGTH);
  if (charge === 0) failSourceEvidence("invalid-value");
  return charge;
}

export function createSourceSpanAccess(
  body: Omit<SourceSpanAccessV1, "schemaVersion" | "kind" | "spanAccessSha256">,
): SourceSpanAccessV1 {
  assertInert(body);
  rejectCredentials(body);
  const root = object(body);
  exact(root, SPAN_ACCESS_BODY_KEYS, ["serializedChargeBytes"]);
  return seal(SOURCE_SPAN_ACCESS_KIND, "spanAccessSha256", normalizeSpanAccess(root));
}

export function decodeSourceSpanAccess(value: unknown): SourceSpanAccessV1 {
  assertInert(value);
  rejectCredentials(value);
  const root = object(value);
  exact(
    root,
    ["schemaVersion", "kind", "spanAccessSha256", ...SPAN_ACCESS_BODY_KEYS],
    ["serializedChargeBytes"],
  );
  if (
    root.schemaVersion !== SOURCE_EVIDENCE_SCHEMA_VERSION ||
    root.kind !== SOURCE_SPAN_ACCESS_KIND
  )
    failSourceEvidence("migration-required");
  const sealed = seal(SOURCE_SPAN_ACCESS_KIND, "spanAccessSha256", normalizeSpanAccess(root));
  if (canonicalDigest(root) !== canonicalDigest(sealed)) failSourceEvidence("digest-mismatch");
  return sealed;
}

const SPAN_CITATION_BODY_KEYS = [
  "bindingSha256",
  "observationId",
  "representationId",
  "representationSha256",
  "stepId",
  "spanIds",
  "spanAccessSha256s",
  "supportedClaimSha256",
  "externalInputCitationSha256",
];

function normalizeSpanCitation(
  root: Record<string, unknown>,
): Omit<SourceSpanCitationV1, "schemaVersion" | "kind" | "spanCitationSha256"> {
  return {
    bindingSha256: hash(root.bindingSha256),
    observationId: identifier(root.observationId),
    representationId: identifier(root.representationId),
    representationSha256: hash(root.representationSha256),
    stepId: identifier(root.stepId),
    spanIds: normalizedIds(root.spanIds, true),
    spanAccessSha256s: normalizedHashes(root.spanAccessSha256s, true),
    supportedClaimSha256: hash(root.supportedClaimSha256),
    externalInputCitationSha256: hash(root.externalInputCitationSha256),
  };
}

export function createSourceSpanCitation(
  body: Omit<SourceSpanCitationV1, "schemaVersion" | "kind" | "spanCitationSha256">,
): SourceSpanCitationV1 {
  assertInert(body);
  rejectCredentials(body);
  const root = object(body);
  exact(root, SPAN_CITATION_BODY_KEYS);
  return seal(SOURCE_SPAN_CITATION_KIND, "spanCitationSha256", normalizeSpanCitation(root));
}

export function decodeSourceSpanCitation(value: unknown): SourceSpanCitationV1 {
  return decodeSealed(
    value,
    SOURCE_SPAN_CITATION_KIND,
    "spanCitationSha256",
    SPAN_CITATION_BODY_KEYS,
    normalizeSpanCitation,
  ) as SourceSpanCitationV1;
}

const FINAL_BODY_KEYS = [
  "bindingSha256",
  "externalInputManifestSha256",
  "accessLedgerSha256",
  "citationLedgerSha256",
  "spanAccessSha256s",
  "spanCitationSha256s",
  "limitations",
  "requiredCoverage",
  "exactOriginalCoverage",
];

function normalizeFinal(
  root: Record<string, unknown>,
): Omit<SourceEvidenceFinalV1, "schemaVersion" | "kind" | "evidenceSha256"> {
  const limitationRows = array(root.limitations)
    .map((row) => {
      const entry = object(row);
      exact(entry, ["observationId", "reasonCode"]);
      return {
        observationId: identifier(entry.observationId),
        reasonCode: enumeration(entry.reasonCode, SOURCE_REPRESENTATION_LIMITATIONS),
      };
    })
    .sort(
      (left, right) =>
        compare(left.observationId, right.observationId) ||
        compare(left.reasonCode, right.reasonCode),
    );
  unique(limitationRows.map((entry) => `${entry.observationId}|${entry.reasonCode}`));
  const coverageRows = array(root.requiredCoverage)
    .map((row) => {
      const entry = object(row);
      exact(entry, ["observationId", "status"]);
      return {
        observationId: identifier(entry.observationId),
        status: enumeration(entry.status, SOURCE_REQUIRED_COVERAGE_STATUSES),
      };
    })
    .sort((left, right) => compare(left.observationId, right.observationId));
  unique(coverageRows.map((entry) => entry.observationId));
  const exactOriginalCoverage = Object.hasOwn(root, "exactOriginalCoverage")
    ? array(root.exactOriginalCoverage)
        .map((row) => {
          const entry = object(row);
          exact(entry, [
            "observationId",
            "status",
            "originalBytesRead",
            "originalByteLength",
            "serializedBytesCharged",
            "remainingSpanIds",
          ]);
          const originalBytesRead = count(entry.originalBytesRead, MAX_BYTE_LENGTH);
          const originalByteLength = count(entry.originalByteLength, MAX_BYTE_LENGTH);
          if (originalBytesRead > originalByteLength) failSourceEvidence("invalid-value");
          return {
            observationId: identifier(entry.observationId),
            status: enumeration(entry.status, SOURCE_EXACT_ORIGINAL_COVERAGE_STATUSES),
            originalBytesRead,
            originalByteLength,
            serializedBytesCharged: count(entry.serializedBytesCharged, Number.MAX_SAFE_INTEGER),
            remainingSpanIds: normalizedIds(entry.remainingSpanIds),
          };
        })
        .sort((left, right) => compare(left.observationId, right.observationId))
    : undefined;
  if (exactOriginalCoverage) unique(exactOriginalCoverage.map((entry) => entry.observationId));
  return {
    bindingSha256: hash(root.bindingSha256),
    externalInputManifestSha256: hash(root.externalInputManifestSha256),
    accessLedgerSha256: hash(root.accessLedgerSha256),
    citationLedgerSha256: hash(root.citationLedgerSha256),
    spanAccessSha256s: normalizedHashes(root.spanAccessSha256s),
    spanCitationSha256s: normalizedHashes(root.spanCitationSha256s),
    limitations: limitationRows,
    requiredCoverage: coverageRows,
    ...(exactOriginalCoverage ? { exactOriginalCoverage } : {}),
  };
}

export function createSourceEvidenceFinal(
  body: Omit<SourceEvidenceFinalV1, "schemaVersion" | "kind" | "evidenceSha256">,
): SourceEvidenceFinalV1 {
  assertInert(body);
  rejectCredentials(body);
  const root = object(body);
  exact(root, FINAL_BODY_KEYS, ["exactOriginalCoverage"]);
  return seal(SOURCE_EVIDENCE_FINAL_KIND, "evidenceSha256", normalizeFinal(root));
}

export function decodeSourceEvidenceFinal(value: unknown): SourceEvidenceFinalV1 {
  assertInert(value);
  rejectCredentials(value);
  const root = object(value);
  exact(
    root,
    ["schemaVersion", "kind", "evidenceSha256", ...FINAL_BODY_KEYS],
    ["exactOriginalCoverage"],
  );
  if (
    root.schemaVersion !== SOURCE_EVIDENCE_SCHEMA_VERSION ||
    root.kind !== SOURCE_EVIDENCE_FINAL_KIND
  )
    failSourceEvidence("migration-required");
  const sealed = seal(SOURCE_EVIDENCE_FINAL_KIND, "evidenceSha256", normalizeFinal(root));
  if (canonicalDigest(root) !== canonicalDigest(sealed)) failSourceEvidence("digest-mismatch");
  return sealed;
}

/**
 * Version-1 source request-context projection; its shape is frozen so existing
 * digests keep verifying.
 *
 * `sourceBinding` is excluded because its digest is derived from this hash.
 * `signal` and the raw workspace path are excluded; the workspace appears as its
 * host-authenticated identity digest. Absent optional values are explicit null.
 */
export interface SourceRequestContextV1 {
  runId: string;
  workflow: string;
  repository: SourceRepositoryBindingV1;
  workspaceIdentitySha256: string;
  task: unknown;
  contextTarget: unknown;
  instruction: string | null;
  reviewScope: unknown;
  allowWrite: boolean;
  releaseDefaultBranch: string | null;
  taskLineage: unknown;
  compositionExecution: unknown;
  knowledgeResumeReceipt: unknown;
}

/** Adds the reader and editorial fields an `update-documentation` run carries. */
export interface SourceRequestContextV2 extends SourceRequestContextV1 {
  readerContextInput: unknown;
  readerTaskContext: unknown;
  readerContext: unknown;
  readerContextProvenance: unknown;
  editorialEvidenceRefs: unknown;
}

/** Adds the recorded request interpretation, which first-pass binding reads. */
export interface SourceRequestContextV3 extends SourceRequestContextV2 {
  requestIntent: unknown;
}

/** Adds the operator's retained comparison and reader-source request and live-agent context. */
export interface SourceRequestContextV4 extends SourceRequestContextV3 {
  instructionContext: string | null;
  readerEvidenceRequest: unknown;
}

/** Lowest first. */
export const SOURCE_REQUEST_PROJECTION_VERSIONS = [1, 2, 3, 4] as const;
export type SourceRequestProjectionVersion = (typeof SOURCE_REQUEST_PROJECTION_VERSIONS)[number];

/**
 * How the projection treats one run-request field: the projection version that
 * first hashes it, `resolved` for a field the host resolves outside the hashed
 * body, or `continuation-pending` for a field no version represents yet.
 */
export type SourceRequestFieldClass =
  | SourceRequestProjectionVersion
  | "resolved"
  | "continuation-pending";

/**
 * Every `RunRequest` field, classified. The mapped type makes a new request
 * field a compile error until it is classified here, so the projection cannot
 * fall behind the request schema; a key outside the schema still refuses at
 * run time with `projection-unversioned`. Entry order is projection order.
 */
export const SOURCE_REQUEST_FIELD_CLASSES = Object.freeze({
  runId: "resolved",
  workflow: "resolved",
  repository: "resolved",
  workspacePath: "resolved",
  signal: "resolved",
  sourceBinding: "resolved",
  task: 1,
  contextTarget: 1,
  instruction: 1,
  reviewScope: 1,
  allowWrite: 1,
  retryContext: "resolved",
  releaseDefaultBranch: 1,
  taskLineage: 1,
  compositionExecution: 1,
  answerRecordDiscovery: "resolved",
  modelSettings: "resolved",
  knowledgeResumeReceipt: 1,
  readerContextInput: 2,
  readerTaskContext: 2,
  readerContext: 2,
  readerContextProvenance: 2,
  editorialEvidenceRefs: 2,
  requestIntent: 3,
  firstPassChoices: "resolved",
  instructionContext: 4,
  readerEvidenceRequest: 4,
  knowledgeContinuationAcceptanceSha256: "continuation-pending",
  knowledgeContinuationRecoveryAuthorization: "continuation-pending",
  knowledgeContinuationReceipt: "continuation-pending",
  knowledgeContinuationSnapshotSha256: "continuation-pending",
  answerRecordContinuation: "continuation-pending",
  answerRecordContinuationReceipt: "continuation-pending",
} as const satisfies { readonly [Field in keyof Required<RunRequest>]: SourceRequestFieldClass });

type SourceRequestField = keyof typeof SOURCE_REQUEST_FIELD_CLASSES;
type FieldsOfClass<Class extends SourceRequestFieldClass> = {
  [Field in SourceRequestField]: (typeof SOURCE_REQUEST_FIELD_CLASSES)[Field] extends Class
    ? Field
    : never;
}[SourceRequestField];

function fieldsOfClass<Class extends SourceRequestFieldClass>(
  fieldClass: Class,
): readonly FieldsOfClass<Class>[] {
  return Object.freeze(
    (Object.keys(SOURCE_REQUEST_FIELD_CLASSES) as SourceRequestField[]).filter(
      (field) => SOURCE_REQUEST_FIELD_CLASSES[field] === fieldClass,
    ) as FieldsOfClass<Class>[],
  );
}

function sourceRequestFieldClass(key: string): SourceRequestFieldClass | undefined {
  return Object.hasOwn(SOURCE_REQUEST_FIELD_CLASSES, key)
    ? SOURCE_REQUEST_FIELD_CLASSES[key as SourceRequestField]
    : undefined;
}

/** In projection order. */
export const SOURCE_REQUEST_PROJECTED_FIELDS = fieldsOfClass(1);

/**
 * Admission-affecting continuation fields no projection covers yet. A
 * source-aware run carrying one refuses with `continuation-projection-pending`
 * rather than dropping it from evidence.
 */
export const SOURCE_REQUEST_PENDING_CONTINUATION_FIELDS = fieldsOfClass("continuation-pending");

/** In projection order. */
export const SOURCE_REQUEST_PROJECTED_FIELDS_V2_ADDITIONS = fieldsOfClass(2);

export const SOURCE_REQUEST_PROJECTED_FIELDS_V2 = Object.freeze([
  ...SOURCE_REQUEST_PROJECTED_FIELDS,
  ...SOURCE_REQUEST_PROJECTED_FIELDS_V2_ADDITIONS,
]);

/** In projection order. */
export const SOURCE_REQUEST_PROJECTED_FIELDS_V3_ADDITIONS = fieldsOfClass(3);

export const SOURCE_REQUEST_PROJECTED_FIELDS_V3 = Object.freeze([
  ...SOURCE_REQUEST_PROJECTED_FIELDS_V2,
  ...SOURCE_REQUEST_PROJECTED_FIELDS_V3_ADDITIONS,
]);

/** In projection order. */
export const SOURCE_REQUEST_PROJECTED_FIELDS_V4_ADDITIONS = fieldsOfClass(4);

export const SOURCE_REQUEST_PROJECTED_FIELDS_V4 = Object.freeze([
  ...SOURCE_REQUEST_PROJECTED_FIELDS_V3,
  ...SOURCE_REQUEST_PROJECTED_FIELDS_V4_ADDITIONS,
]);

/**
 * Request fields the host resolves outside the projection body, including the
 * deliberate exclusions `workspacePath`, `signal`, and `sourceBinding`.
 */
export const SOURCE_REQUEST_RESOLVED_FIELDS = fieldsOfClass("resolved");

/**
 * The body every projection shares. Each later version only appends to it, so
 * an earlier version's digest cannot move when a later one changes.
 */
function sourceRequestIdentityBody(root: Record<string, unknown>): Record<string, unknown> {
  if (typeof root.allowWrite !== "boolean") failSourceEvidence("invalid-value");
  return {
    runId: identifier(root.runId),
    workflow: identifier(root.workflow),
    repository: repositoryBinding(root.repository),
    workspaceIdentitySha256: hash(root.workspaceIdentitySha256),
    task: root.task ?? null,
    contextTarget: root.contextTarget ?? null,
    instruction:
      root.instruction === undefined || root.instruction === null ? null : string(root.instruction),
    reviewScope: root.reviewScope ?? null,
    allowWrite: root.allowWrite,
    releaseDefaultBranch:
      root.releaseDefaultBranch === undefined || root.releaseDefaultBranch === null
        ? null
        : string(root.releaseDefaultBranch),
    taskLineage: root.taskLineage ?? null,
    compositionExecution: root.compositionExecution ?? null,
    knowledgeResumeReceipt: root.knowledgeResumeReceipt ?? null,
  };
}

function sourceRequestVersion2Additions(root: Record<string, unknown>): Record<string, unknown> {
  return {
    readerContextInput: root.readerContextInput ?? null,
    readerTaskContext: root.readerTaskContext ?? null,
    readerContext: root.readerContext ?? null,
    readerContextProvenance: root.readerContextProvenance ?? null,
    editorialEvidenceRefs: root.editorialEvidenceRefs ?? null,
  };
}

export function computeSourceRequestSha256(context: SourceRequestContextV1): string {
  assertInert(context);
  rejectCredentials(context);
  const root = object(context);
  exact(root, [
    "runId",
    "workflow",
    "repository",
    "workspaceIdentitySha256",
    ...SOURCE_REQUEST_PROJECTED_FIELDS,
  ]);
  return canonicalDigest({
    schemaVersion: SOURCE_EVIDENCE_SCHEMA_VERSION,
    kind: SOURCE_REQUEST_CONTEXT_KIND,
    ...sourceRequestIdentityBody(root),
  });
}

/** `projectionVersion: 2` in the body keeps this digest distinct from version 1's. */
export function computeSourceRequestSha256V2(context: SourceRequestContextV2): string {
  assertInert(context);
  rejectCredentials(context);
  const root = object(context);
  exact(root, [
    "runId",
    "workflow",
    "repository",
    "workspaceIdentitySha256",
    ...SOURCE_REQUEST_PROJECTED_FIELDS_V2,
  ]);
  return canonicalDigest({
    schemaVersion: SOURCE_EVIDENCE_SCHEMA_VERSION,
    kind: SOURCE_REQUEST_CONTEXT_KIND,
    projectionVersion: 2 as const,
    ...sourceRequestIdentityBody(root),
    ...sourceRequestVersion2Additions(root),
  });
}

/** `projectionVersion: 3` keeps this digest distinct from versions 1 and 2. */
export function computeSourceRequestSha256V3(context: SourceRequestContextV3): string {
  assertInert(context);
  rejectCredentials(context);
  const root = object(context);
  exact(root, [
    "runId",
    "workflow",
    "repository",
    "workspaceIdentitySha256",
    ...SOURCE_REQUEST_PROJECTED_FIELDS_V3,
  ]);
  return canonicalDigest({
    schemaVersion: SOURCE_EVIDENCE_SCHEMA_VERSION,
    kind: SOURCE_REQUEST_CONTEXT_KIND,
    projectionVersion: 3 as const,
    ...sourceRequestIdentityBody(root),
    ...sourceRequestVersion2Additions(root),
    requestIntent: root.requestIntent ?? null,
  });
}

/** `projectionVersion: 4` keeps this digest distinct from versions 1 to 3. */
export function computeSourceRequestSha256V4(context: SourceRequestContextV4): string {
  assertInert(context);
  rejectCredentials(context);
  const root = object(context);
  exact(root, [
    "runId",
    "workflow",
    "repository",
    "workspaceIdentitySha256",
    ...SOURCE_REQUEST_PROJECTED_FIELDS_V4,
  ]);
  return canonicalDigest({
    schemaVersion: SOURCE_EVIDENCE_SCHEMA_VERSION,
    kind: SOURCE_REQUEST_CONTEXT_KIND,
    projectionVersion: 4 as const,
    ...sourceRequestIdentityBody(root),
    ...sourceRequestVersion2Additions(root),
    requestIntent: root.requestIntent ?? null,
    instructionContext:
      root.instructionContext === undefined || root.instructionContext === null
        ? null
        : string(root.instructionContext),
    readerEvidenceRequest: root.readerEvidenceRequest ?? null,
  });
}

/**
 * The lowest projection version that represents every key on the request. It
 * derives from the request alone so the CLI producer and runner verifier agree.
 */
export function selectSourceRequestProjectionVersion(
  request: Record<string, unknown>,
): SourceRequestProjectionVersion {
  let version: SourceRequestProjectionVersion = 1;
  for (const key of Object.keys(object(request))) {
    const fieldClass = sourceRequestFieldClass(key);
    if (typeof fieldClass === "number" && fieldClass > version) version = fieldClass;
  }
  return version;
}

/** A refused request key is echoed only when it is identifier-shaped. */
const ECHOABLE_REQUEST_KEY = /^[A-Za-z][A-Za-z0-9]{0,63}$/u;

function requestFieldList(keys: readonly string[]): string {
  const named = keys.filter((key) => ECHOABLE_REQUEST_KEY.test(key));
  const withheld = keys.length - named.length;
  return [
    ...named.map((key) => `request.${key}`),
    ...(withheld > 0 ? [`${withheld} unnamed request field${withheld === 1 ? "" : "s"}`] : []),
  ].join(", ");
}

/**
 * Projects an admitted run request. Unrecognized fields fail closed with
 * `projection-unversioned` so nothing is silently dropped from evidence.
 *
 * `projectionVersion` pins a version instead of selecting the lowest that fits;
 * an unknown pinned version is refused.
 */
export function projectSourceRequestContext(
  request: Record<string, unknown>,
  resolved: {
    runId: string;
    workspaceIdentitySha256: string;
    /** Host-normalized repository identity; the raw target shape never enters. */
    repository: SourceRepositoryBindingV1;
  },
  options?: { readonly projectionVersion?: number },
): string {
  const root = object(request);
  const pinned = options?.projectionVersion;
  if (
    pinned !== undefined &&
    !(SOURCE_REQUEST_PROJECTION_VERSIONS as readonly number[]).includes(pinned)
  ) {
    failSourceEvidence("projection-unversioned", {
      field: "projectionVersion",
      reason: `only source request projection versions ${SOURCE_REQUEST_PROJECTION_VERSIONS.join(", ")} are defined`,
    });
  }
  const version: SourceRequestProjectionVersion =
    pinned === undefined
      ? selectSourceRequestProjectionVersion(root)
      : (pinned as SourceRequestProjectionVersion);
  const present = Object.keys(root);
  const pendingContinuation = present.filter(
    (key) => sourceRequestFieldClass(key) === "continuation-pending",
  );
  if (pendingContinuation.length > 0) {
    failSourceEvidence("continuation-projection-pending", {
      field: requestFieldList(pendingContinuation),
      reason: "no source request projection represents a durable knowledge continuation yet",
    });
  }
  const unrepresented = present.filter((key) => {
    const fieldClass = sourceRequestFieldClass(key);
    return fieldClass === undefined || (typeof fieldClass === "number" && fieldClass > version);
  });
  if (unrepresented.length > 0) {
    failSourceEvidence("projection-unversioned", {
      field: requestFieldList(unrepresented),
      reason: `source request projection version ${version} does not represent ${unrepresented.length === 1 ? "it" : "them"}, so a source binding cannot commit to the request`,
    });
  }
  const shared: SourceRequestContextV1 = {
    runId: resolved.runId,
    workflow: root.workflow as string,
    repository: resolved.repository,
    workspaceIdentitySha256: resolved.workspaceIdentitySha256,
    task: root.task ?? null,
    contextTarget: root.contextTarget ?? null,
    instruction: (root.instruction as string | undefined) ?? null,
    reviewScope: root.reviewScope ?? null,
    allowWrite: root.allowWrite as boolean,
    releaseDefaultBranch: (root.releaseDefaultBranch as string | undefined) ?? null,
    taskLineage: root.taskLineage ?? null,
    compositionExecution: root.compositionExecution ?? null,
    knowledgeResumeReceipt: root.knowledgeResumeReceipt ?? null,
  };
  if (version === 1) return computeSourceRequestSha256(shared);
  const versionTwo: SourceRequestContextV2 = {
    ...shared,
    readerContextInput: root.readerContextInput ?? null,
    readerTaskContext: root.readerTaskContext ?? null,
    readerContext: root.readerContext ?? null,
    readerContextProvenance: root.readerContextProvenance ?? null,
    editorialEvidenceRefs: root.editorialEvidenceRefs ?? null,
  };
  if (version === 2) return computeSourceRequestSha256V2(versionTwo);
  const versionThree: SourceRequestContextV3 = {
    ...versionTwo,
    requestIntent: root.requestIntent ?? null,
  };
  if (version === 3) return computeSourceRequestSha256V3(versionThree);
  return computeSourceRequestSha256V4({
    ...versionThree,
    instructionContext: (root.instructionContext as string | undefined) ?? null,
    readerEvidenceRequest: root.readerEvidenceRequest ?? null,
  });
}

export function digestSourceProducerScopes(
  rows: ReadonlyArray<{ producerId: string; scopeSha256: string }>,
): string {
  const normalized = [...rows]
    .map((row) => {
      const entry = object(row);
      exact(entry, ["producerId", "scopeSha256"]);
      return { producerId: identifier(entry.producerId), scopeSha256: hash(entry.scopeSha256) };
    })
    .sort((left, right) => compare(left.producerId, right.producerId));
  unique(normalized.map((entry) => entry.producerId));
  if (normalized.length === 0) failSourceEvidence("invalid-value");
  return canonicalDigest({
    schemaVersion: SOURCE_EVIDENCE_SCHEMA_VERSION,
    kind: "docsfab-source-producer-scopes" as const,
    rows: normalized,
  });
}
