// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Source artifact references and final evidence assembly.
 *
 * Source references use `schemaVersion: 2`; version 3 is reserved for editorial
 * decisions. A reference is inert data: it never carries a body and never grants
 * access on its own.
 */
import {
  SOURCE_CITE_MAX_CLAIMS_PER_CALL,
  SOURCE_CLAIM_SENTENCE_ABBREVIATIONS,
  sourceClaimMinWords,
} from "../config/source-citation-limits.js";
import { formatLimitObservation, limit, type ResolveLimitsOptions } from "../config/limits.js";
import {
  SOURCE_AUTHORITY_MEMBER_PATH_MAX_CHARS_LIMIT,
  sourceReadInputWindowShare,
  sourceReadResponseCeiling,
} from "../config/source-read-limits.js";
import { canonicalDigest } from "../content-ir/canonical.js";
import { createContractKit } from "../contract-kit/index.js";
import {
  SOURCE_REPRESENTATION_LIMITATIONS,
  SOURCE_EXACT_ORIGINAL_FORM,
  createSourceEvidenceFinal,
  createSourceSpanCitation,
  type SourceBindingV1,
  type SourceEvidenceFinalV1,
  type SourceObservationV1,
  type SourceRepresentationLimitation,
  type SourceRepresentationV1,
  type SourceRequiredCoverageStatus,
  type SourceSpanAccessV1,
  type SourceSpanCitationV1,
  type SourceSpanV1,
} from "./source-evidence.js";
import type { SourceReadBudgetBasisV1 } from "./source-step-policy.js";

export const SOURCE_ARTIFACT_REFERENCE_SCHEMA_VERSION = 2 as const;

/** The frozen set of source reference-only kinds. */
export const SOURCE_ARTIFACT_REFERENCE_KINDS = [
  "source-binding",
  "source-evidence-final",
  "source-observation",
  "source-span-access",
  "source-span-citation",
] as const;
export type SourceArtifactReferenceKind = (typeof SOURCE_ARTIFACT_REFERENCE_KINDS)[number];

/** Reserved for editorial decisions only. Decoding it here is refused. */
export const EDITORIAL_ARTIFACT_REFERENCE_SCHEMA_VERSION = 3 as const;

export type SourceArtifactReferenceErrorCode =
  | "invalid-shape"
  | "invalid-value"
  | "digest-mismatch"
  | "credential-material"
  | "migration-required"
  | "substitution";

export class SourceArtifactReferenceError extends Error {
  public constructor(public readonly code: SourceArtifactReferenceErrorCode) {
    super(`Source artifact reference rejected: ${code}.`);
    this.name = "SourceArtifactReferenceError";
  }
}

function fail(code: SourceArtifactReferenceErrorCode): never {
  throw new SourceArtifactReferenceError(code);
}

const { assertInert, rejectCredentials, object, exact, hash, revision, enumeration, compare } =
  createContractKit<SourceArtifactReferenceErrorCode>({
    fail,
    codes: {
      invalidShape: "invalid-shape",
      invalidValue: "invalid-value",
      digestMismatch: "digest-mismatch",
      credentialMaterial: "credential-material",
      schemaMismatch: "migration-required",
    },
  });

export interface SourceArtifactReferenceV2<
  K extends SourceArtifactReferenceKind = SourceArtifactReferenceKind,
> {
  kind: K;
  schemaVersion: typeof SOURCE_ARTIFACT_REFERENCE_SCHEMA_VERSION;
  digest: string;
  repositoryRevision: string;
  repositoryContentDigest: string;
}

export function createSourceArtifactReference<K extends SourceArtifactReferenceKind>(input: {
  kind: K;
  digest: string;
  repositoryRevision: string;
  repositoryContentDigest: string;
}): SourceArtifactReferenceV2<K> {
  assertInert(input);
  rejectCredentials(input);
  const root = object(input);
  exact(root, ["kind", "digest", "repositoryRevision", "repositoryContentDigest"]);
  return Object.freeze({
    kind: enumeration(root.kind, SOURCE_ARTIFACT_REFERENCE_KINDS) as K,
    schemaVersion: SOURCE_ARTIFACT_REFERENCE_SCHEMA_VERSION,
    digest: hash(root.digest),
    repositoryRevision: revision(root.repositoryRevision),
    repositoryContentDigest: hash(root.repositoryContentDigest),
  });
}

/** Decodes a V2 reference; V1 and the reserved editorial V3 are refused, not coerced. */
export function decodeSourceArtifactReference<K extends SourceArtifactReferenceKind>(
  value: unknown,
  expectedKind?: K,
): SourceArtifactReferenceV2<K> {
  assertInert(value);
  rejectCredentials(value);
  const root = object(value);
  exact(root, ["kind", "schemaVersion", "digest", "repositoryRevision", "repositoryContentDigest"]);
  if (root.schemaVersion !== SOURCE_ARTIFACT_REFERENCE_SCHEMA_VERSION) fail("migration-required");
  const kind = enumeration(root.kind, SOURCE_ARTIFACT_REFERENCE_KINDS);
  if (expectedKind !== undefined && kind !== expectedKind) fail("substitution");
  return createSourceArtifactReference({
    kind: kind as K,
    digest: root.digest as string,
    repositoryRevision: root.repositoryRevision as string,
    repositoryContentDigest: root.repositoryContentDigest as string,
  });
}

export interface AssembleSourceEvidenceFinalInput {
  binding: SourceBindingV1;
  observations: readonly SourceObservationV1[];
  spanAccesses: readonly SourceSpanAccessV1[];
  spanCitations: readonly SourceSpanCitationV1[];
  externalInputManifestSha256: string;
  accessLedgerSha256: string;
  citationLedgerSha256: string;
  /** Observations the producer could not acquire at all, by observation id. */
  unavailableObservationIds?: readonly string[];
}

/**
 * Derives the final evidence record; coverage comes from recorded span accesses
 * against the sealed binding, not a caller's declaration, except that a caller
 * may mark an observation `unavailable`.
 */
export function assembleSourceEvidenceFinal(
  input: AssembleSourceEvidenceFinalInput,
): SourceEvidenceFinalV1 {
  const known = new Map(input.observations.map((entry) => [entry.observationId, entry]));
  for (const reference of input.binding.observations) {
    const observation = known.get(reference.observationId);
    if (!observation || observation.observationSha256 !== reference.observationSha256) {
      fail("substitution");
    }
  }
  for (const access of input.spanAccesses) {
    if (access.bindingSha256 !== input.binding.bindingSha256) fail("substitution");
    const observation = known.get(access.observationId);
    const representation = observation?.representations.find(
      (row) =>
        row.representationId === access.representationId &&
        row.representationSha256 === access.representationSha256,
    );
    if (!representation) fail("substitution");
    if (
      (representation.form === SOURCE_EXACT_ORIGINAL_FORM) !==
      (access.serializedChargeBytes !== undefined)
    )
      fail("substitution");
    if (access.spanIds.some((id) => !representation.spans.some((span) => span.spanId === id)))
      fail("substitution");
  }
  for (const citation of input.spanCitations) {
    if (citation.bindingSha256 !== input.binding.bindingSha256) fail("substitution");
  }
  const limitations: Array<{
    observationId: string;
    reasonCode: SourceRepresentationLimitation;
  }> = [];
  for (const observation of input.observations) {
    for (const representation of observation.representations) {
      for (const reasonCode of representation.limitations) {
        if (!SOURCE_REPRESENTATION_LIMITATIONS.includes(reasonCode)) fail("invalid-value");
        limitations.push({ observationId: observation.observationId, reasonCode });
      }
    }
  }
  const dedupedLimitations = [
    ...new Map(
      limitations.map((entry) => [`${entry.observationId}|${entry.reasonCode}`, entry]),
    ).values(),
  ];

  const requiredCoverage = sourceRequiredCoverage({
    binding: input.binding,
    observations: input.observations,
    spanAccesses: input.spanAccesses,
    ...(input.unavailableObservationIds
      ? { unavailableObservationIds: input.unavailableObservationIds }
      : {}),
  });
  const exactOriginalCoverage = sourceExactOriginalCoverage({
    observations: input.observations,
    spanAccesses: input.spanAccesses,
    ...(input.unavailableObservationIds
      ? { unavailableObservationIds: input.unavailableObservationIds }
      : {}),
  });

  return createSourceEvidenceFinal({
    bindingSha256: input.binding.bindingSha256,
    externalInputManifestSha256: hash(input.externalInputManifestSha256),
    accessLedgerSha256: hash(input.accessLedgerSha256),
    citationLedgerSha256: hash(input.citationLedgerSha256),
    spanAccessSha256s: input.spanAccesses.map((entry) => entry.spanAccessSha256),
    spanCitationSha256s: input.spanCitations.map((entry) => entry.spanCitationSha256),
    limitations: dedupedLimitations,
    requiredCoverage,
    ...(exactOriginalCoverage.length > 0 ? { exactOriginalCoverage } : {}),
  });
}

/** Separate exact-byte proof; derivative spans never contribute to these rows. */
export function sourceExactOriginalCoverage(input: {
  observations: readonly SourceObservationV1[];
  spanAccesses: readonly SourceSpanAccessV1[];
  unavailableObservationIds?: readonly string[];
}): NonNullable<SourceEvidenceFinalV1["exactOriginalCoverage"]> {
  const unavailable = new Set(input.unavailableObservationIds ?? []);
  return input.observations
    .flatMap((observation) => {
      const raw = observation.representations.find(
        (row) => row.form === SOURCE_EXACT_ORIGINAL_FORM,
      );
      if (!raw) return [];
      const accesses = input.spanAccesses.filter(
        (access) =>
          access.observationId === observation.observationId &&
          access.representationId === raw.representationId &&
          access.representationSha256 === raw.representationSha256,
      );
      const read = new Set(accesses.flatMap((access) => access.spanIds));
      const unread = raw.spans.filter((span) => !read.has(span.spanId));
      const originalBytesRead = raw.spans.reduce(
        (sum, span) => sum + (read.has(span.spanId) ? span.endByte - span.startByte : 0),
        0,
      );
      const serializedBytesCharged = accesses.reduce(
        (sum, access) => sum + (access.serializedChargeBytes ?? 0),
        0,
      );
      if (!Number.isSafeInteger(serializedBytesCharged)) fail("invalid-value");
      return [
        {
          observationId: observation.observationId,
          status: unavailable.has(observation.observationId)
            ? ("unavailable" as const)
            : accesses.length === 0
              ? ("unread" as const)
              : unread.length === 0
                ? ("complete" as const)
                : ("partial" as const),
          originalBytesRead,
          originalByteLength: observation.original.byteLength,
          serializedBytesCharged,
          remainingSpanIds: unread.map((span) => span.spanId).sort(compare),
        },
      ];
    })
    .sort((left, right) => compare(left.observationId, right.observationId));
}

/** Bytes a read of `spans` charges: their extracted text, not separators. */
function spanBytes(spans: readonly SourceSpanV1[]): number {
  return spans.reduce((total, span) => total + span.endByte - span.startByte, 0);
}

/** What the run has read of one required source, in the representation that measures it. */
interface RequiredSourceReadState {
  readonly observationId: string;
  readonly repositoryPath: string | null;
  readonly status: SourceRequiredCoverageStatus;
  /** The representation reads are measured in; `null` when unavailable or spanless. */
  readonly representation: SourceRepresentationV1 | null;
  readonly readBytes: number;
  readonly totalBytes: number;
  /** Spans of `representation` no step of the run has read, in byte order. */
  readonly unreadSpans: readonly SourceSpanV1[];
}

/**
 * Required-source read state from recorded span accesses. A source is
 * `considered` only once every span of one complete representation was read
 * by any steps of the run. A complete original remains valid evidence when a
 * separate normalized extraction was partial. A source some step read only
 * part of is `partial`, so a partial read is never reported as considered.
 */
function requiredSourceReadStates(input: {
  binding: SourceBindingV1;
  observations: readonly SourceObservationV1[];
  spanAccesses: readonly SourceSpanAccessV1[];
  unavailableObservationIds?: readonly string[];
}): RequiredSourceReadState[] {
  const known = new Map(input.observations.map((entry) => [entry.observationId, entry]));
  const unavailable = new Set(input.unavailableObservationIds ?? []);
  const readSpanIds = new Map<string, Set<string>>();
  for (const access of input.spanAccesses) {
    if (access.bindingSha256 !== input.binding.bindingSha256) continue;
    const key = `${access.observationId}|${access.representationId}`;
    const spans = readSpanIds.get(key) ?? new Set<string>();
    for (const spanId of access.spanIds) spans.add(spanId);
    readSpanIds.set(key, spans);
  }
  return input.binding.requiredObservationIds
    .map((observationId): RequiredSourceReadState => {
      const observation = known.get(observationId);
      const repositoryPath = observation?.original.repositoryPath ?? null;
      if (unavailable.has(observationId) || !observation) {
        return {
          observationId,
          repositoryPath,
          status: "unavailable",
          representation: null,
          readBytes: 0,
          totalBytes: 0,
          unreadSpans: [],
        };
      }
      const measured = observation.representations
        .filter((representation) => representation.spans.length > 0)
        .map((representation, order) => {
          const read =
            readSpanIds.get(`${observationId}|${representation.representationId}`) ??
            new Set<string>();
          const unreadSpans = representation.spans
            .filter((span) => !read.has(span.spanId))
            .sort((left, right) => left.startByte - right.startByte);
          const totalBytes = spanBytes(representation.spans);
          return {
            representation,
            order,
            unreadSpans,
            totalBytes,
            readBytes: totalBytes - spanBytes(unreadSpans),
          };
        })
        // Read whole first, then a complete representation, then the most
        // bytes read. A complete original must win over a wholly read but
        // partial derivative even when the derivative has more text bytes.
        .sort(
          (left, right) =>
            Number(left.unreadSpans.length > 0) - Number(right.unreadSpans.length > 0) ||
            Number(left.representation.completeness !== "complete") -
              Number(right.representation.completeness !== "complete") ||
            right.readBytes - left.readBytes ||
            left.order - right.order,
        );
      const chosen = measured[0];
      const accessed = observation.representations.some(
        (representation) =>
          (readSpanIds.get(`${observationId}|${representation.representationId}`)?.size ?? 0) > 0,
      );
      let status: SourceRequiredCoverageStatus;
      if (!accessed) status = "unread";
      else if (!chosen || chosen.unreadSpans.length > 0) status = "partial";
      else if (chosen.representation.completeness === "partial") {
        status = "partial";
      } else status = "considered";
      return {
        observationId,
        repositoryPath,
        status,
        representation: chosen?.representation ?? null,
        readBytes: chosen?.readBytes ?? 0,
        totalBytes: chosen?.totalBytes ?? 0,
        unreadSpans: chosen?.unreadSpans ?? [],
      };
    })
    .sort((left, right) => compare(left.observationId, right.observationId));
}

/**
 * Required-source coverage from recorded span accesses. The final evidence
 * record and the runner's write gate both use it so they cannot disagree.
 */
export function sourceRequiredCoverage(input: {
  binding: SourceBindingV1;
  observations: readonly SourceObservationV1[];
  spanAccesses: readonly SourceSpanAccessV1[];
  unavailableObservationIds?: readonly string[];
}): Array<{ observationId: string; status: SourceRequiredCoverageStatus }> {
  return requiredSourceReadStates(input).map(({ observationId, status }) => ({
    observationId,
    status,
  }));
}

/** How much of one required source the run has read. */
export interface SourceRequiredReadCoverageV1 {
  readonly observationId: string;
  /** The original's repository path, or `null` when it has none. */
  readonly repositoryPath: string | null;
  readonly status: SourceRequiredCoverageStatus;
  /** Bytes of extracted text the run has read, each span counted once. */
  readonly readBytes: number;
  /** Bytes of extracted text a whole read of the source charges. */
  readonly totalBytes: number;
}

/**
 * Required-source coverage with the bytes behind each status, from the same
 * read state as `sourceRequiredCoverage`, so a report and the gate agree.
 */
export function sourceRequiredReadCoverage(input: {
  binding: SourceBindingV1;
  observations: readonly SourceObservationV1[];
  spanAccesses: readonly SourceSpanAccessV1[];
  unavailableObservationIds?: readonly string[];
}): SourceRequiredReadCoverageV1[] {
  return requiredSourceReadStates(input).map(
    ({ observationId, repositoryPath, status, readBytes, totalBytes }) =>
      Object.freeze({ observationId, repositoryPath, status, readBytes, totalBytes }),
  );
}

/**
 * Gap codes (`observationId:status`) that block the affected write: `unread` and
 * `unavailable`. `partial` is not a gap; it carries its limitation forward.
 */
export function sourceEvidenceRequiredGapCodes(
  final: Pick<SourceEvidenceFinalV1, "requiredCoverage">,
): string[] {
  return final.requiredCoverage
    .filter((entry) => entry.status === "unread" || entry.status === "unavailable")
    .map((entry) => `${entry.observationId}:${entry.status}`)
    .sort();
}

/** Operator code of the required-source write stop; the situation catalog classifies it. */
export const REQUIRED_SOURCE_UNREAD_CODE = "required-source-unread" as const;

/**
 * Code of the run-record evidence warning, and LIMITATIONS line, for a required
 * source a write step started writing with only part of it read.
 */
export const SOURCE_READ_PARTIAL_CODE = "source-read-partial" as const;

/**
 * Why a write step cannot read a required source that no earlier step read: the
 * host could not acquire it, it has no span, or not one of its spans fits in
 * what is left of the step's read budget.
 */
export type RequiredSourceGapReason = "unavailable" | "no-readable-span" | "over-read-budget";

export interface RequiredSourceGapV1 {
  readonly observationId: string;
  /** The original's repository path, or `null` when it has none. */
  readonly repositoryPath: string | null;
  readonly reason: RequiredSourceGapReason;
  /** Bytes a whole read needs; set for `over-read-budget`. */
  readonly bytes?: number;
}

/**
 * One required source a write step reads, in one representation: the spans no
 * step of the run has read yet, in byte order, or the window of them that fits
 * the step's share of its read budget.
 */
export interface RequiredSourceReadV1 {
  readonly observationId: string;
  readonly representationId: string;
  readonly repositoryPath: string | null;
  readonly spanIds: readonly string[];
  /** Bytes of `spanIds`: what the step's read charges. */
  readonly bytes: number;
  /** Bytes of the representation earlier steps of the run already read. */
  readonly priorReadBytes: number;
  /** Bytes of every span of the representation: what a whole read charges. */
  readonly totalBytes: number;
}

export type RequiredSourceReadPlanV1 =
  | {
      readonly kind: "read";
      readonly reads: readonly RequiredSourceReadV1[];
      /** Bytes that reading what is left of every required source needs. */
      readonly neededBytes: number;
      readonly budgetBytes: number;
    }
  | {
      readonly kind: "stop";
      /** Every unread or unavailable required source, as `observationId:status`. */
      readonly gapCodes: readonly string[];
      /** The sources that stop the step, with the reason for each. */
      readonly gaps: readonly RequiredSourceGapV1[];
      /** Bytes that reading what is left of every readable required source needs. */
      readonly neededBytes: number;
      readonly budgetBytes: number;
    };

/**
 * Shares a read budget among sources, smallest need first. Each source gets an
 * equal share of what is left and reads the longest run of its unread spans
 * that fits that share; what it leaves over goes to the larger sources after
 * it. A source whose first unread span exceeds its share still reads that span
 * when what is left holds it, so every source the budget can reach is read at
 * least in part. When every need fits the budget, every source reads whole.
 */
function shareRequiredReadBudget(
  states: readonly RequiredSourceReadState[],
  budgetBytes: number,
): Map<string, readonly SourceSpanV1[]> {
  const order = [...states].sort(
    (left, right) =>
      spanBytes(left.unreadSpans) - spanBytes(right.unreadSpans) ||
      compare(left.observationId, right.observationId),
  );
  const windows = new Map<string, readonly SourceSpanV1[]>();
  let remaining = Math.max(budgetBytes, 0);
  order.forEach((state, index) => {
    const share = Math.floor(remaining / (order.length - index));
    const window: SourceSpanV1[] = [];
    for (const span of state.unreadSpans) {
      if (spanBytes(window) + span.endByte - span.startByte > share) break;
      window.push(span);
    }
    const first = state.unreadSpans[0];
    if (window.length === 0 && first && first.endByte - first.startByte <= remaining) {
      window.push(first);
    }
    remaining -= spanBytes(window);
    windows.set(state.observationId, window);
  });
  return windows;
}

/**
 * Plans how a write step covers the required sources. In one representation
 * each, it reads the spans no step of the run has read yet, so a source earlier
 * steps read part of is completed rather than counted as read. When those
 * spans fit the step's read budget, every required source ends the read whole.
 * When they do not, the budget is shared out smallest need first and each
 * source reads the window of its unread spans that fits its share: a large
 * source is read in part, not left unreachable, and its unread rest is reported
 * by `sourcePartialReadWarnings`, never as considered. The plan stops the step,
 * before anything is read, only when a required source is unavailable, has no
 * span, or was never read and not one of its spans fits what is left.
 */
export function planRequiredSourceReads(input: {
  binding: SourceBindingV1;
  observations: readonly SourceObservationV1[];
  spanAccesses: readonly SourceSpanAccessV1[];
  /** The step's per-attempt read budget; 0 for a step that holds no reader. */
  budgetBytes: number;
}): RequiredSourceReadPlanV1 {
  const states = requiredSourceReadStates({
    binding: input.binding,
    observations: input.observations,
    spanAccesses: input.spanAccesses,
  });
  const gaps: RequiredSourceGapV1[] = [];
  const pending: RequiredSourceReadState[] = [];
  for (const state of states) {
    const { observationId, repositoryPath } = state;
    if (state.status === "unavailable") {
      gaps.push({ observationId, repositoryPath, reason: "unavailable" });
    } else if (state.representation === null) {
      gaps.push({ observationId, repositoryPath, reason: "no-readable-span" });
    } else if (state.unreadSpans.length > 0) {
      pending.push(state);
    }
  }
  const neededBytes = pending.reduce((total, state) => total + spanBytes(state.unreadSpans), 0);
  const windows = shareRequiredReadBudget(pending, input.budgetBytes);
  for (const state of pending) {
    if (state.status === "unread" && (windows.get(state.observationId) ?? []).length === 0) {
      gaps.push({
        observationId: state.observationId,
        repositoryPath: state.repositoryPath,
        reason: "over-read-budget",
        bytes: state.totalBytes,
      });
    }
  }
  if (gaps.length > 0) {
    return {
      kind: "stop",
      gapCodes: sourceEvidenceRequiredGapCodes({ requiredCoverage: states }),
      gaps: gaps.sort((left, right) => compare(left.observationId, right.observationId)),
      neededBytes,
      budgetBytes: input.budgetBytes,
    };
  }
  const reads = pending.flatMap((state): RequiredSourceReadV1[] => {
    const window = windows.get(state.observationId) ?? [];
    if (window.length === 0 || state.representation === null) return [];
    return [
      {
        observationId: state.observationId,
        representationId: state.representation.representationId,
        repositoryPath: state.repositoryPath,
        spanIds: window.map((span) => span.spanId),
        bytes: spanBytes(window),
        priorReadBytes: state.readBytes,
        totalBytes: state.totalBytes,
      },
    ];
  });
  return { kind: "read", reads, neededBytes, budgetBytes: input.budgetBytes };
}

/**
 * The evidence warnings for a write step that starts writing with required
 * sources the run has read only part of: one per such source, naming it with
 * the bytes read against its total and any bytes the credential screen
 * withheld, then, when the budget is what cut the read short, one naming the
 * step's read budget against what reading the rest of every required source
 * needed, with its remediation. Empty when every required source the run has
 * started to read was read whole. The runner records these on the run record,
 * and the LIMITATIONS footer projects them. The path sits on a line of its own,
 * shown by its tail when it is very long, so every line stays inside the
 * per-warning bound the run-record readers apply.
 */
export function sourcePartialReadWarnings(input: {
  stepId: string;
  coverage: readonly SourceRequiredReadCoverageV1[];
  /** What reading what was left of every required source needed, before the step read. */
  neededBytes: number;
  budgetBytes: number;
  /** Bytes the credential screen withheld from this step's read, by observation id. */
  withheldBytes?: ReadonlyMap<string, number>;
  /** How the budget was set; the declared ceiling when absent. */
  budgetBasis?: SourceReadBudgetBasisV1;
  limits?: ResolveLimitsOptions;
}): string[] {
  const withheldOf = (entry: SourceRequiredReadCoverageV1) =>
    input.withheldBytes?.get(entry.observationId) ?? 0;
  const partial = input.coverage.filter(
    (entry) => entry.readBytes < entry.totalBytes && (entry.readBytes > 0 || withheldOf(entry) > 0),
  );
  if (partial.length === 0) return [];
  const lines = partial.map((entry) => {
    const withheld = withheldOf(entry);
    return `${SOURCE_READ_PARTIAL_CODE}: ${displayedSourceName(entry, input.limits)} was read ${entry.readBytes} of ${entry.totalBytes} bytes when step ${input.stepId} started writing; the rest of it was not read${withheld > 0 ? `, including ${withheld} bytes the credential screen withheld` : ""}.`;
  });
  if (input.neededBytes > input.budgetBytes) {
    lines.push(
      `${SOURCE_READ_PARTIAL_CODE}: step ${input.stepId} could not read every required source whole. ${sourceReadBudgetObservation(input)}`,
    );
  }
  return lines;
}

/**
 * A source's name for an operator line: its path, or, past the longest path
 * the source authority admits as a member (`sources.authorityMemberPathMaxChars`),
 * the tail of the path with the observation id that identifies it whole.
 */
function displayedSourceName(
  entry: { readonly observationId: string; readonly repositoryPath: string | null },
  limits?: ResolveLimitsOptions,
): string {
  const path = entry.repositoryPath;
  if (path === null) return entry.observationId;
  const keep = limit(SOURCE_AUTHORITY_MEMBER_PATH_MAX_CHARS_LIMIT, limits).value;
  return path.length <= keep ? path : `…${path.slice(-keep)} (observation ${entry.observationId})`;
}

/**
 * The coded line for `neededBytes` that the step's source-read budget cannot
 * hold: the limit that set the budget, the observed bytes, and its remediation.
 */
export function sourceReadBudgetObservation(input: {
  neededBytes: number;
  budgetBytes: number;
  budgetBasis?: SourceReadBudgetBasisV1;
  limits?: ResolveLimitsOptions;
}): string {
  const basis = input.budgetBasis;
  if (basis?.kind === "input-window-share") {
    const share = sourceReadInputWindowShare(input.limits);
    return `${share.refusal}: ${input.neededBytes} exceeds the step's source-read budget of ${input.budgetBytes} bytes, ${share.name} = ${basis.share} of the model's ${basis.inputWindowTokens}-token input window. ${share.remediation} Follow the named remediation.`;
  }
  return formatLimitObservation(
    { ...sourceReadResponseCeiling(input.limits), value: input.budgetBytes },
    input.neededBytes,
  );
}

function sourceNames(gaps: readonly RequiredSourceGapV1[], withBytes = false): string {
  return gaps
    .map((gap) => {
      const name = gap.repositoryPath ?? gap.observationId;
      return withBytes && gap.bytes !== undefined ? `${name} (${gap.bytes} bytes)` : name;
    })
    .join(", ");
}

/**
 * The operator-visible stop for a blocked required-source write: the failing
 * condition, then each blocking source with its reason and remediation. Hosts
 * and tests match on the condition sentence, so keep it stable.
 */
export function sourceRequiredCoverageRefusal(input: {
  stepId: string;
  gapCodes: readonly string[];
  gaps: readonly RequiredSourceGapV1[];
  neededBytes: number;
  budgetBytes: number;
  /** How the budget was set; the declared ceiling when absent. */
  budgetBasis?: SourceReadBudgetBasisV1;
}): string {
  const sentences = [
    `Workflow step "${input.stepId}" cannot write while required source evidence is missing (${input.gapCodes.join(", ")}).`,
  ];
  const overBudget = input.gaps.filter((gap) => gap.reason === "over-read-budget");
  if (overBudget.length > 0) {
    const basis = input.budgetBasis;
    const windowShare = basis?.kind === "input-window-share" ? basis : undefined;
    sentences.push(
      `No earlier step read ${sourceNames(overBudget, true)} with docsfab_read_source, and not one span of ${overBudget.length === 1 ? "it" : "them"} fits in what is left of the step's source-read budget of ${input.budgetBytes} bytes (${windowShare ? `sources.readInputWindowShare = ${windowShare.share} of the model's ${windowShare.inputWindowTokens}-token input window` : "sources.readResponseCeilingBytes"}); reading what is left of every required source needs ${input.neededBytes} bytes.`,
      windowShare
        ? "Raise DOCSFAB_SOURCES_READ_INPUT_WINDOW_SHARE so source reads may fill more of the model's input window, run with a model whose input window is larger, or bind fewer or smaller sources, such as fewer --source files or a narrower merge-request date range, then start a new run."
        : `Raise DOCSFAB_SOURCES_READ_RESPONSE_CEILING_BYTES to at least ${input.neededBytes}, or bind fewer or smaller sources, such as fewer --source files or a narrower merge-request date range, then start a new run.`,
    );
  }
  const spanless = input.gaps.filter((gap) => gap.reason === "no-readable-span");
  if (spanless.length > 0) {
    sentences.push(
      `${sourceNames(spanless)} ${spanless.length === 1 ? "has" : "have"} no readable span. Drop each such source from this run, then start a new run.`,
    );
  }
  const unavailable = input.gaps.filter((gap) => gap.reason === "unavailable");
  if (unavailable.length > 0) {
    sentences.push(
      `The host could not acquire ${sourceNames(unavailable)}. Re-attach each unavailable required source at a revision the host can read, or drop it from this run, then run again.`,
    );
  }
  return sentences.join(" ");
}

/**
 * The coded required-source write stop. It names the step, each source it could
 * not read, and the read budget, so the failure classifies by its code.
 */
export class RequiredSourceUnreadError extends Error {
  public readonly code = REQUIRED_SOURCE_UNREAD_CODE;
  public readonly stepId: string;
  public readonly gaps: readonly RequiredSourceGapV1[];

  public constructor(input: {
    stepId: string;
    gapCodes: readonly string[];
    gaps: readonly RequiredSourceGapV1[];
    neededBytes: number;
    budgetBytes: number;
    budgetBasis?: SourceReadBudgetBasisV1;
  }) {
    super(sourceRequiredCoverageRefusal(input));
    this.name = "RequiredSourceUnreadError";
    this.stepId = input.stepId;
    this.gaps = input.gaps;
  }
}

export type SourceCitationDiagnosticCode =
  | "unread-span"
  | "wrong-step"
  | "foreign-binding"
  | "unknown-span"
  | "unsupported-claim";

export interface SourceCitationDiagnosticV1 {
  supportedClaimSha256: string;
  code: SourceCitationDiagnosticCode;
}

/**
 * Checks that every material claim is carried by a citation whose spans were
 * read in the same step of the same binding; each failure is a diagnostic.
 */
export function verifySourceSpanCitations(input: {
  binding: SourceBindingV1;
  observations: readonly SourceObservationV1[];
  spanAccesses: readonly SourceSpanAccessV1[];
  spanCitations: readonly SourceSpanCitationV1[];
  materialClaimSha256s: readonly string[];
}): SourceCitationDiagnosticV1[] {
  const spansByRepresentation = new Map<string, Set<string>>();
  for (const observation of input.observations) {
    for (const representation of observation.representations) {
      spansByRepresentation.set(
        `${observation.observationId}|${representation.representationId}`,
        new Set(representation.spans.map((entry) => entry.spanId)),
      );
    }
  }
  const readByStep = new Map<string, Set<string>>();
  const accessByDigest = new Map<string, SourceSpanAccessV1>();
  for (const access of input.spanAccesses) {
    if (access.bindingSha256 !== input.binding.bindingSha256) continue;
    accessByDigest.set(access.spanAccessSha256, access);
    const key = `${access.stepId}|${access.observationId}|${access.representationId}`;
    const spans = readByStep.get(key) ?? new Set<string>();
    for (const spanId of access.spanIds) spans.add(spanId);
    readByStep.set(key, spans);
  }

  const diagnostics: SourceCitationDiagnosticV1[] = [];
  const citedClaims = new Set<string>();
  for (const citation of input.spanCitations) {
    if (citation.bindingSha256 !== input.binding.bindingSha256) {
      diagnostics.push({
        supportedClaimSha256: citation.supportedClaimSha256,
        code: "foreign-binding",
      });
      continue;
    }
    const known = spansByRepresentation.get(
      `${citation.observationId}|${citation.representationId}`,
    );
    if (!known || citation.spanIds.some((spanId) => !known.has(spanId))) {
      diagnostics.push({
        supportedClaimSha256: citation.supportedClaimSha256,
        code: "unknown-span",
      });
      continue;
    }
    if (
      citation.spanAccessSha256s.some(
        (digest) => accessByDigest.get(digest)?.stepId !== citation.stepId,
      )
    ) {
      diagnostics.push({ supportedClaimSha256: citation.supportedClaimSha256, code: "wrong-step" });
      continue;
    }
    const read = readByStep.get(
      `${citation.stepId}|${citation.observationId}|${citation.representationId}`,
    );
    if (!read || citation.spanIds.some((spanId) => !read.has(spanId))) {
      diagnostics.push({
        supportedClaimSha256: citation.supportedClaimSha256,
        code: "unread-span",
      });
      continue;
    }
    citedClaims.add(citation.supportedClaimSha256);
  }
  for (const claim of input.materialClaimSha256s) {
    if (!citedClaims.has(claim)) {
      diagnostics.push({ supportedClaimSha256: claim, code: "unsupported-claim" });
    }
  }
  return diagnostics.sort(
    (left, right) =>
      compare(left.supportedClaimSha256, right.supportedClaimSha256) ||
      compare(left.code, right.code),
  );
}

/**
 * Leading bullets, ordered-list markers, block quotes and ATX headings, stripped
 * so `- The note says X` and `The note says X` are the same claim.
 */
const SOURCE_CLAIM_LEADING_MARKUP = /^(?:[>\-*+#]+[ \t]*|\d+[.)][ \t]+)/u;
const SOURCE_CLAIM_TRAILING_TOKEN = /([\p{L}\p{N}.]+)$/u;
/** A token is a word when it holds a letter or a digit; `|` and `---` are not. */
const SOURCE_CLAIM_WORD = /[\p{L}\p{N}]/u;
/** Block quote markers in front of a line's content. */
const SOURCE_TEXT_QUOTE_PREFIX = /^(?:[ \t]*>)+[ \t]?/u;
/** A line that opens its own block: a list item or a table row. */
const SOURCE_TEXT_BLOCK_START = /^(?:[-*+][ \t]|\d+[.)][ \t]|\|)/u;
/** A table row is one block on its own line. */
const SOURCE_TEXT_SINGLE_LINE_BLOCK = /^\|/u;
/** A fence marker and what follows it on the line, its info string. */
const SOURCE_TEXT_FENCE = /^(`{3,}|~{3,})(.*)$/u;
/** A list item marker and the whitespace after it, which sets its content column. */
const SOURCE_TEXT_LIST_ITEM = /^([-*+]|\d{1,9}[.)])([ \t]*)/u;
/**
 * A line that is markup, not prose: an ATX heading, a line holding only an HTML
 * or MDX tag such as `<Note>`, or an admonition marker such as `!!! note` or
 * `:::tip`.
 */
const SOURCE_TEXT_MARKUP_LINE =
  /^(?:#{1,6}(?:[ \t]|$)|<\/?[A-Za-z][^<>]*>$|(?:!!!|\?\?\?\+?)(?:[ \t]|$)|:{3,})/u;
const SOURCE_TEXT_LINE_BREAK = /\r\n|\r|\n/u;

/**
 * Strips leading markup to a fixed point (`- - x`, `> 1. x`); a single pass
 * would not be idempotent. Terminates because every iteration shortens the text.
 */
function stripLeadingClaimMarkup(value: string): string {
  let current = value;
  for (;;) {
    const next = current.replace(SOURCE_CLAIM_LEADING_MARKUP, "").trimStart();
    if (next === current) return current;
    current = next;
  }
}

/**
 * Normalizes one claim sentence: NFC, collapsed whitespace, leading markup
 * removed, lowercased.
 *
 * Must stay idempotent so the cite tool and the coverage check normalize to the
 * same text. Whitespace is collapsed before the markup strip so an indented
 * marker is stripped too.
 */
export function sourceClaimText(value: string): string {
  const collapsed = String(value ?? "")
    .normalize("NFC")
    .replace(/[\s\u00a0]+/gu, " ")
    .trim();
  return stripLeadingClaimMarkup(collapsed).toLowerCase().trim();
}

/**
 * Counts the words of the same normalized text the digest is taken on: its
 * space-separated tokens that hold a letter or a digit.
 */
export function sourceClaimWordCount(normalized: string): number {
  return normalized.length === 0
    ? 0
    : normalized.split(" ").filter((token) => SOURCE_CLAIM_WORD.test(token)).length;
}

export function sourceClaimSha256(value: string): string {
  return canonicalDigest({
    schemaVersion: 1 as const,
    kind: "docsfab-source-material-claim" as const,
    claim: sourceClaimText(value),
  });
}

/**
 * Splits one block of text into sentences at a terminator followed by a space or
 * tab and more text. `!` and `?` always end one there; a period does not when
 * the next non-space character is lowercase or a digit, the token before it is a
 * single letter (initials, `U.S.`), or it is a declared abbreviation. Each
 * sentence carries its offset in the block.
 *
 * A pure function of the text and the abbreviation list, never of host locale or
 * ICU version, because these digests enter run records.
 */
function splitClaimSentences(block: string): { start: number; text: string }[] {
  const sentences: { start: number; text: string }[] = [];
  let start = 0;
  for (let index = 0; index < block.length; index += 1) {
    const character = block[index]!;
    if (character !== "." && character !== "!" && character !== "?") continue;
    let after = index + 1;
    while (after < block.length && (block[after] === " " || block[after] === "\t")) after += 1;
    // A terminator with nothing after it ends the block, not a sentence within it.
    if (after === index + 1 || after >= block.length) continue;
    if (character === ".") {
      const next = block[after]!;
      if (next.toLowerCase() === next && next.toUpperCase() !== next) continue;
      if (/[0-9]/u.test(next)) continue;
      const preceding = SOURCE_CLAIM_TRAILING_TOKEN.exec(block.slice(start, index));
      const token = (preceding?.[1] ?? "").replace(/\.+$/u, "");
      const tail = token.slice(token.lastIndexOf(".") + 1);
      // A single letter, not a digit: a sentence ending in a number still ends.
      if (/^\p{L}$/u.test(tail)) continue;
      if (SOURCE_CLAIM_SENTENCE_ABBREVIATIONS.includes(token.toLowerCase())) continue;
    }
    sentences.push({ start, text: block.slice(start, after) });
    start = after;
  }
  if (start < block.length) sentences.push({ start, text: block.slice(start) });
  return sentences;
}

/** Columns of leading whitespace, a tab advancing to the next multiple of four. */
function leadingColumns(text: string): number {
  let columns = 0;
  for (const character of text) {
    if (character === " ") columns += 1;
    else if (character === "\t") columns += 4 - (columns % 4);
    else break;
  }
  return columns;
}

/** The line after YAML front matter that opens a text, or 0 when it has none. */
function frontMatterEnd(lines: readonly string[]): number {
  if (lines[0]?.trim() !== "---") return 0;
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (line === "---" || line === "...") return index + 1;
  }
  return 0;
}

/**
 * The sentences of a text, each with the 1-based line it starts on. Lines join
 * into one block until a blank line, a fence, a markup line, or a line that
 * opens its own block, so a sentence wrapped across lines is one sentence and a
 * table row is one block. Front matter, fenced code, headings, tags, and
 * admonition markers are not prose and yield none.
 *
 * The cite tool and the coverage check both segment through this function, so
 * a sentence quoted whole is the claim the written page holds.
 */
function sourceTextSentences(text: string): { line: number; text: string }[] {
  const lines = String(text ?? "").split(SOURCE_TEXT_LINE_BREAK);
  const sentences: { line: number; text: string }[] = [];
  let block:
    | { quoted: boolean; single: boolean; text: string; starts: { offset: number; line: number }[] }
    | undefined;
  const flush = () => {
    if (!block) return;
    const starts = block.starts;
    for (const piece of splitClaimSentences(block.text)) {
      // The last joined line that starts at or before the sentence.
      let line = starts[0]!.line;
      for (const entry of starts) if (entry.offset <= piece.start) line = entry.line;
      sentences.push({ line, text: piece.text });
    }
    block = undefined;
  };
  // The open fence, and the content column of the list item it opened in.
  let fence: { marker: string; base: number } | undefined;
  // The content column of the list item the text is in, if any.
  let listColumn: number | undefined;
  let previousBlank = true;
  for (let index = frontMatterEnd(lines); index < lines.length; index += 1) {
    const raw = lines[index]!;
    const quoted = SOURCE_TEXT_QUOTE_PREFIX.test(raw);
    const body = raw.replace(SOURCE_TEXT_QUOTE_PREFIX, "");
    const content = body.trim();
    const indent = leadingColumns(body);
    const fenceMatch = SOURCE_TEXT_FENCE.exec(content);
    if (fence !== undefined) {
      // A closing fence carries no info string and is indented at most three
      // columns past the content column the fence opened in.
      const closes =
        fenceMatch !== null &&
        fenceMatch[1]![0] === fence.marker[0] &&
        fenceMatch[1]!.length >= fence.marker.length &&
        fenceMatch[2]!.trim() === "" &&
        indent <= fence.base + 3;
      if (closes) fence = undefined;
      continue;
    }
    if (content === "") {
      flush();
      previousBlank = true;
      continue;
    }
    const item = SOURCE_TEXT_LIST_ITEM.exec(content);
    const listItem = item !== null && (item[2] !== "" || item[0] === content);
    // A list item ends at a less-indented line after a blank line, or at one
    // that interrupts it, such as a fence or a heading.
    const opensFence = fenceMatch !== null;
    if (
      listColumn !== undefined &&
      !listItem &&
      indent < listColumn &&
      (previousBlank || opensFence || SOURCE_TEXT_MARKUP_LINE.test(content))
    ) {
      listColumn = undefined;
    }
    previousBlank = false;
    // CommonMark fences: at most three columns of indentation inside the
    // container, so a backtick line in indented code is text, and a backtick
    // fence's info string holds no backtick, so a line that opens with an
    // inline triple-backtick span is text too.
    const base = listColumn !== undefined && indent >= listColumn ? listColumn : 0;
    if (
      fenceMatch !== null &&
      indent - base <= 3 &&
      !(fenceMatch[1]!.startsWith("`") && fenceMatch[2]!.includes("`"))
    ) {
      flush();
      fence = { marker: fenceMatch[1]!, base };
      continue;
    }
    if (listItem) {
      const gap = leadingColumns(item[2]!);
      listColumn = indent + item[1]!.length + (gap >= 1 && gap <= 4 ? gap : 1);
    }
    if (SOURCE_TEXT_MARKUP_LINE.test(content)) {
      flush();
      continue;
    }
    if (
      block &&
      !block.single &&
      block.quoted === quoted &&
      !SOURCE_TEXT_BLOCK_START.test(content)
    ) {
      block.starts.push({ offset: block.text.length + 1, line: index + 1 });
      block.text = `${block.text} ${content}`;
      continue;
    }
    flush();
    block = {
      quoted,
      single: SOURCE_TEXT_SINGLE_LINE_BLOCK.test(content),
      text: content,
      starts: [{ offset: 0, line: index + 1 }],
    };
  }
  flush();
  return sentences;
}

/** The normalized sentences of a text that reach the word floor, at their lines. */
function materialClaimsAtLines(text: string, minWords: number): { line: number; claim: string }[] {
  return sourceTextSentences(text).flatMap((sentence) => {
    const claim = sourceClaimText(sentence.text);
    return sourceClaimWordCount(claim) >= minWords ? [{ line: sentence.line, claim }] : [];
  });
}

/**
 * The material claims of a text: its distinct normalized sentences with at
 * least `minWords` words, `sources.claimMinWords` unless given. This is the only
 * implementation of the rule; the cite tool reads a cited claim through it.
 */
export function sourceMaterialClaims(text: string, minWords = sourceClaimMinWords()): string[] {
  const claims: string[] = [];
  for (const { claim } of materialClaimsAtLines(text, minWords)) {
    if (!claims.includes(claim)) claims.push(claim);
  }
  return claims;
}

export function sourceMaterialClaimSha256s(
  text: string,
  minWords = sourceClaimMinWords(),
): string[] {
  return [...new Set(sourceMaterialClaims(text, minWords).map(sourceClaimSha256))].sort(compare);
}

/** One planned documentation page, as the write step found it and left it. */
export interface SourceDocumentationPageV1 {
  /** Repository-relative path. */
  readonly path: string;
  /** Text before the step, or `null` when the page did not exist. */
  readonly before: string | null;
  /** Text after the step, or `null` when the page does not exist. */
  readonly after: string | null;
}

/** One material claim a write step added to documentation, by location. */
export interface SourceDocumentationClaimV1 {
  readonly path: string;
  /** 1-based line of the written page where the sentence starts. */
  readonly line: number;
  /** Normalized claim text; never recorded, only its digest is. */
  readonly claim: string;
  readonly claimSha256: string;
}

/**
 * The material claims a write step added: each sentence of a written page, at
 * its line, whose normalized text no planned page held before the step. A
 * sentence the step kept, rewrapped, or moved between planned pages is not a new
 * claim; one it changed is. The step's status reply is never read.
 */
export function sourceDocumentationClaims(input: {
  pages: readonly SourceDocumentationPageV1[];
  minWords: number;
}): SourceDocumentationClaimV1[] {
  const held = new Set(
    input.pages.flatMap((page) =>
      page.before === null
        ? []
        : sourceTextSentences(page.before).map((sentence) => sourceClaimText(sentence.text)),
    ),
  );
  return [...input.pages]
    .sort((left, right) => compare(left.path, right.path))
    .flatMap((page) =>
      page.after === null
        ? []
        : materialClaimsAtLines(page.after, input.minWords)
            .filter(({ claim }) => !held.has(claim))
            .map(({ line, claim }) => ({
              path: page.path,
              line,
              claim,
              claimSha256: sourceClaimSha256(claim),
            })),
    );
}

/**
 * Splits a write step's added claims by whether one of the step's own accepted
 * citations supports them. Another step's citations never count.
 */
export function sourceDocumentationCitationCoverage(input: {
  claims: readonly SourceDocumentationClaimV1[];
  spanCitations: readonly SourceSpanCitationV1[];
}): {
  cited: SourceDocumentationClaimV1[];
  uncited: SourceDocumentationClaimV1[];
} {
  const supported = new Set(input.spanCitations.map((entry) => entry.supportedClaimSha256));
  return {
    cited: input.claims.filter((claim) => supported.has(claim.claimSha256)),
    uncited: input.claims.filter((claim) => !supported.has(claim.claimSha256)),
  };
}

export class SourceCitationError extends Error {
  /**
   * `detail` adds what the static refusal table cannot, such as an exceeded
   * bound, the observed value and what to change. Current callers pass fixed
   * text, counts and constant names, not refused claim or span content.
   */
  public constructor(
    public readonly code: SourceCitationDiagnosticCode,
    public readonly detail?: string,
  ) {
    super(`Source citation refused: ${code}.`);
    this.name = "SourceCitationError";
  }
}

function failCitation(code: SourceCitationDiagnosticCode): never {
  throw new SourceCitationError(code);
}

export function failSourceCitation(code: SourceCitationDiagnosticCode, detail?: string): never {
  throw new SourceCitationError(code, detail);
}

/**
 * Remediation per refusal code. It interpolates no refused span id, claim, path
 * or locator, so nothing from the refused input reaches a model through it.
 */
export const SOURCE_CITATION_REFUSALS: Record<SourceCitationDiagnosticCode, string> = {
  "foreign-binding":
    "Cite only evidence from this run's own sealed source binding, at the revision it was sealed at.",
  "unknown-span":
    "Name an observation, representation and span ids that docsfab_list_sources returned for this run.",
  "wrong-step":
    "Cite spans through the receipt the host recorded for them, not through an identifier from another step.",
  "unread-span":
    "Have a source-granted step read the span with docsfab_read_source in this run before citing it.",
  "unsupported-claim":
    "Cite a whole sentence you write into the documentation, word for word as it appears there.",
};

/** Everything a model may say about a citation; it names no binding, run, step or path. */
export interface SourceSpanCitationRequestV1 {
  readonly claim: string;
  readonly observationId: string;
  readonly representationId: string;
  readonly spanIds: readonly string[];
}

/**
 * Screens a model-proposed citation against the run's own access ledger and
 * mints sealed citations only if it survives. It checks no grant: its only
 * production caller is the confined `docsfab_cite_source` step citer, which
 * enforces the cite grant, and the runner's coverage check re-verifies the
 * citations with `verifySourceSpanCitations`.
 *
 * The proposal carries a claim and identifiers only; apart from the claim
 * digest, every digest in the result comes from host state, and a span with no
 * receipt in this run is refused. A span counts as read when any source-granted
 * step of the run read it, so each citation carries the reading step's id, not
 * the citing step's.
 */
export function screenSourceSpanCitation(input: {
  binding: SourceBindingV1;
  observations: readonly SourceObservationV1[];
  spanAccesses: readonly SourceSpanAccessV1[];
  request: SourceSpanCitationRequestV1;
  /** Host join into the external-input citation ledger; refusals fail closed. */
  mintExternalInputCitationSha256: (input: {
    observationId: string;
    representationId: string;
    stepId: string;
    spanIds: readonly string[];
    accessObservationSha256s: readonly string[];
    supportedClaimSha256: string;
  }) => string;
}): SourceSpanCitationV1[] {
  const request = input.request;
  if (!request || typeof request !== "object") failCitation("unknown-span");
  // One call may cite several sentences; each is segmented as the coverage check
  // segments the written pages and must still match what the step wrote.
  const minWords = sourceClaimMinWords();
  const claims = sourceMaterialClaims(request.claim, minWords);
  if (claims.length === 0) {
    failSourceCitation(
      "unsupported-claim",
      `Cite a whole sentence you write into the documentation, word for word as it appears there, of at least ${minWords} words (sources.claimMinWords).`,
    );
  }
  if (claims.length > SOURCE_CITE_MAX_CLAIMS_PER_CALL) {
    failSourceCitation(
      "unsupported-claim",
      `This call carried ${claims.length} sentences; the limit sources.citeMaxClaimsPerCall is ${SOURCE_CITE_MAX_CLAIMS_PER_CALL}. Cite fewer sentences per call.`,
    );
  }

  const observation = input.observations.find(
    (entry) => entry.observationId === request.observationId,
  );
  const representation = observation?.representations.find(
    (entry) => entry.representationId === request.representationId,
  );
  if (!observation || !representation) failCitation("unknown-span");
  const known = new Set(representation.spans.map((entry) => entry.spanId));
  const spanIds = Array.isArray(request.spanIds)
    ? [...new Set(request.spanIds.filter((value): value is string => typeof value === "string"))]
    : [];
  if (spanIds.length === 0 || spanIds.some((spanId) => !known.has(spanId))) {
    failCitation("unknown-span");
  }

  const coverBySpan = new Map<string, SourceSpanAccessV1>();
  for (const access of input.spanAccesses) {
    if (
      access.observationId !== observation.observationId ||
      access.representationId !== representation.representationId
    ) {
      continue;
    }
    if (!access.spanIds.some((spanId) => spanIds.includes(spanId))) continue;
    // A receipt under another binding or representation digest is evidence about
    // a different revision of this source.
    if (access.bindingSha256 !== input.binding.bindingSha256) failCitation("foreign-binding");
    if (access.representationSha256 !== representation.representationSha256) {
      failCitation("foreign-binding");
    }
    for (const spanId of access.spanIds) {
      if (spanIds.includes(spanId) && !coverBySpan.has(spanId)) coverBySpan.set(spanId, access);
    }
  }
  if (spanIds.some((spanId) => !coverBySpan.has(spanId))) failCitation("unread-span");

  // One citation per reading step, so every sealed citation stays consistent
  // with the receipt it names and with `verifySourceSpanCitations`.
  const grouped = new Map<
    string,
    { spanIds: string[]; accesses: Map<string, SourceSpanAccessV1> }
  >();
  for (const spanId of [...spanIds].sort(compare)) {
    const access = coverBySpan.get(spanId)!;
    const group = grouped.get(access.stepId) ?? {
      spanIds: [],
      accesses: new Map<string, SourceSpanAccessV1>(),
    };
    group.spanIds.push(spanId);
    group.accesses.set(access.spanAccessSha256, access);
    grouped.set(access.stepId, group);
  }
  const groups = [...grouped.entries()].sort((left, right) => compare(left[0], right[0]));
  return claims.flatMap((claimText) => {
    const supportedClaimSha256 = sourceClaimSha256(claimText);
    return groups.map(([stepId, group]) => {
      const supporting = [...group.accesses.values()].sort((left, right) =>
        compare(left.spanAccessSha256, right.spanAccessSha256),
      );
      return createSourceSpanCitation({
        bindingSha256: input.binding.bindingSha256,
        observationId: observation.observationId,
        representationId: representation.representationId,
        representationSha256: representation.representationSha256,
        stepId,
        spanIds: group.spanIds,
        spanAccessSha256s: supporting.map((entry) => entry.spanAccessSha256),
        supportedClaimSha256,
        externalInputCitationSha256: input.mintExternalInputCitationSha256({
          observationId: observation.observationId,
          representationId: representation.representationId,
          stepId,
          spanIds: group.spanIds,
          accessObservationSha256s: supporting.map((entry) => entry.accessObservationSha256),
          supportedClaimSha256,
        }),
      });
    });
  });
}

export const SOURCE_CITATION_LEDGER_CONTRADICTION_CODE =
  "source-citation-ledger-contradiction" as const;

/**
 * The stop when the coverage check's re-verification rejects a citation the
 * screen minted. Both read the same ledger, so this is a host defect, not a
 * model mistake.
 */
export function sourceCitationLedgerContradiction(input: {
  stepId: string;
  codes: readonly string[];
}): string {
  return [
    `Workflow step "${input.stepId}" stopped because DocsFab's own citation ledger did not verify against the evidence it was minted from (${[...new Set(input.codes)].sort().join(", ")}).`,
    "This is a DocsFab defect, not a problem with the written documentation. The saved run keeps the patch; report the run id with this message.",
  ].join(" ");
}

export const SOURCE_CITATION_PAGE_UNREADABLE_CODE = "source-citation-page-unreadable" as const;

/**
 * The coded stop when the coverage check cannot read a planned page for a reason
 * other than its absence, such as a permission or disk error. It names the
 * repository-relative page and the error code, never a host path.
 */
export class SourceCitationPageReadError extends Error {
  public readonly code = SOURCE_CITATION_PAGE_UNREADABLE_CODE;
  public readonly stepId: string;

  public constructor(input: { stepId: string; path: string; errorCode: string }) {
    super(
      `Workflow step "${input.stepId}" could not read the planned page ${input.path} to check its source citations (${input.errorCode}). Make the workspace readable to DocsFab, then start a new run.`,
    );
    this.name = "SourceCitationPageReadError";
    this.stepId = input.stepId;
  }
}

/** The coded ledger-contradiction stop, so the failure classifies by its code. */
export class SourceCitationLedgerError extends Error {
  public readonly code = SOURCE_CITATION_LEDGER_CONTRADICTION_CODE;
  public readonly stepId: string;

  public constructor(input: { stepId: string; codes: readonly string[] }) {
    super(sourceCitationLedgerContradiction(input));
    this.name = "SourceCitationLedgerError";
    this.stepId = input.stepId;
  }
}

export function sourceRepositoryContentDigest(input: {
  identitySha256: string;
  revision: string;
  treeSha256: string;
}): string {
  const root = object(input);
  exact(root, ["identitySha256", "revision", "treeSha256"]);
  return canonicalDigest({
    schemaVersion: 1 as const,
    kind: "docsfab-source-repository-content" as const,
    identitySha256: hash(root.identitySha256),
    revision: revision(root.revision),
    treeSha256: hash(root.treeSha256),
  });
}
