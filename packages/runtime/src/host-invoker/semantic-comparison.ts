// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { LIMIT_DEFINITION_BY_NAME } from "../config/limits.generated.js";
/**
 * Hosted semantic-comparison, accepted-effect, and corrective-proposal wire.
 *
 * These parsers admit inert JSON evidence only. They do not grant owner
 * questions, repository reads, publication, or write authority.
 */
import { createHash } from "node:crypto";

import {
  assertHostRuntimeSemanticData,
  jsonRecord,
  parseHostRuntimeSemanticClaimCoreData,
  semanticCitationData,
} from "./semantic-comparison/inert-data.js";
import {
  parseHostRuntimeAcceptedEffectAssessmentData,
  parseHostRuntimeAcceptedEffectRevalidationData,
  parseHostRuntimeCorrectiveProposalAssessmentData,
  parseHostRuntimeCorrectiveProposalRevalidationData,
} from "./semantic-comparison/accepted-effects.js";
import {
  HOST_RUNTIME_SEMANTIC_MERGE_INTENTS,
  HOST_RUNTIME_SEMANTIC_SUGGESTIONS,
  type HostRuntimeAcceptedEffectAssessmentV1,
  type HostRuntimeAcceptedEffectRevalidation,
  type HostRuntimeCorrectiveProposalAssessmentV1,
  type HostRuntimeSemanticCitationV1,
  type HostRuntimeSemanticComparisonChunkV1,
  type HostRuntimeSemanticMergeIntent,
  type HostRuntimeSemanticProposalOptions,
  type HostRuntimeSemanticSuggestion,
} from "./semantic-comparison/types.js";
import { parseHostRuntimeSemanticComparisonChunk } from "./semantic-comparison/comparison-chunk.js";
export {
  assertHostRuntimeSemanticData,
  parseHostRuntimeSemanticClaimCoreData,
} from "./semantic-comparison/inert-data.js";
export {
  parseHostRuntimeAcceptedEffectAssessmentData,
  parseHostRuntimeAcceptedEffectRevalidationData,
  parseHostRuntimeCorrectiveProposalAssessmentData,
  parseHostRuntimeCorrectiveProposalRevalidationData,
  semanticAcceptedEffectFacets,
} from "./semantic-comparison/accepted-effects.js";
export {
  admitHostRuntimeSemanticMergeMessage,
  parseHostRuntimeSemanticComparisonChunk,
  parseHostRuntimeSemanticComparisonChunkData,
  qualifyHostRuntimeSemanticComparisonSources,
  sealHostRuntimeSemanticComparisonChunk,
  semanticComparisonSourceProofInputs,
} from "./semantic-comparison/comparison-chunk.js";
export {
  HOST_RUNTIME_SEMANTIC_MERGE_INTENTS,
  HOST_RUNTIME_SEMANTIC_SOURCE_KINDS,
  HOST_RUNTIME_SEMANTIC_SUGGESTIONS,
} from "./semantic-comparison/types.js";
export type {
  HostRuntimeAcceptedEffectAssessmentV1,
  HostRuntimeAcceptedEffectClaim,
  HostRuntimeAcceptedEffectFacet,
  HostRuntimeAcceptedEffectRevalidation,
  HostRuntimeAcceptedEffectRevalidationV1,
  HostRuntimeAcceptedEffectRevalidationV2,
  HostRuntimeAcceptedEffectRevalidationV3,
  HostRuntimeCorrectiveProposalAssessmentV1,
  HostRuntimeCorrectiveProposalRevalidationV1,
  HostRuntimeSemanticCitationV1,
  HostRuntimeSemanticComparisonChunkV1,
  HostRuntimeSemanticMergeIntent,
  HostRuntimeSemanticMergeMessageV1,
  HostRuntimeSemanticProposalOptions,
  HostRuntimeSemanticSuggestion,
  HostRuntimeSemanticRepositoryRole,
} from "./semantic-comparison/types.js";
import { deepFreezeGraph } from "../contract-kit/freeze.js";
import {
  REPOSITORY_MAX_BATCH_PROBES,
  REPOSITORY_PROBE_MAX_LITERAL_CHARS,
  REPOSITORY_PROBE_MAX_PATH_CHARS,
  REPOSITORY_PROBE_MIN_LITERAL_CHARS,
  isRepositoryLiteralProbeText,
  isRepositoryProbePath,
} from "../repository/probe-selectors.js";
import { HostRuntimeContractError } from "./contract-error.js";
import {
  parseSemanticDocumentProjection,
  bindSemanticDocumentProjection,
  semanticDocumentByteRanges,
  type SemanticDocumentProjection,
} from "./semantic-document-projection.js";
export {
  parseSemanticDocumentTargets,
  parseSemanticDocumentProjection,
  bindSemanticDocumentProjection,
} from "./semantic-document-projection.js";
export type {
  SemanticDocumentTargets,
  SemanticDocumentProjection,
} from "./semantic-document-projection.js";
import {
  bad,
  canonicalJson,
  containsCredentialDeep,
  digest,
  enumeration,
  id,
  nonnegative,
  positive,
  record,
  recordWithOptional,
  sha,
} from "./wire-decode.js";

const SUGGESTION_RATIONALE_LIMIT = "semantic.suggestionRationaleMaxChars";

function suggestionRationaleDefinition() {
  const definition = LIMIT_DEFINITION_BY_NAME[SUGGESTION_RATIONALE_LIMIT];
  if (!definition)
    throw new Error(
      `Operational limit ${SUGGESTION_RATIONALE_LIMIT} is absent from the generated catalog.`,
    );
  return definition;
}

/** A suggestion's rationale as one line of inert prose, the form a retained proposal carries. */
function normalizeSuggestionRationale(value: string): string {
  return inertProse(value).replace(/\s+/gu, " ").trim();
}

/** The refusal sentence of a catalogued limit, as the operator-facing limit formatter writes it. */
function suggestionRationaleRefusal(allowance: number, observed: number): string {
  const definition = suggestionRationaleDefinition();
  return `${definition.refusal}: ${observed} exceeds ${definition.name} = ${allowance} ${definition.unit}. ${definition.remediation} Follow the named remediation.`;
}

export interface HostRuntimeOwnerInformationRequestV1 {
  readonly evidenceId: string;
  readonly claimId: string;
  readonly requestKind: "scope" | "constraint" | "evidence";
  readonly question: string;
  readonly whyOwnerNeeded: string;
  readonly modelCitation: HostRuntimeSemanticCitationV1;
  readonly sourceCitations: readonly HostRuntimeSemanticCitationV1[];
}

/** A request for evidence, never repository access, classification or execution authority. */
export interface HostRuntimeSemanticGatherRequestV1 {
  readonly inputSha256: string;
  readonly evidenceId: string;
  readonly claimId: string;
  readonly question:
    | { readonly kind: "exact-path"; readonly path: string }
    | { readonly kind: "literal-text"; readonly value: string };
}

function semanticGatherBound(axis: string, observed: number, limit: number): never {
  const error = new HostRuntimeContractError("semantic-gather-bound-exceeded");
  error.message += ` axis=${axis} limit=${limit} observed=${observed}. Submit a selector or batch within the bound; retain remaining work for a later immutable input.`;
  throw error;
}

/** Structural data only; proposal parsing additionally checks the actual requesting assessment. */
export function parseHostRuntimeSemanticGatherRequestData(
  input: unknown,
): HostRuntimeSemanticGatherRequestV1 {
  assertHostRuntimeSemanticData(input);
  const row = record(input, ["inputSha256", "evidenceId", "claimId", "question"]);
  sha(row.inputSha256);
  id(row.evidenceId);
  id(row.claimId);
  const question = recordWithOptional(row.question, ["kind"], ["path", "value"]);
  if (question.kind === "exact-path") {
    record(question, ["kind", "path"]);
    if (typeof question.path === "string" && question.path.length > REPOSITORY_PROBE_MAX_PATH_CHARS)
      semanticGatherBound("path-characters", question.path.length, REPOSITORY_PROBE_MAX_PATH_CHARS);
    if (!isRepositoryProbePath(question.path)) bad("semantic-gather-path");
  } else {
    record(question, ["kind", "value"]);
    if (typeof question.value === "string") {
      if (question.value.length < REPOSITORY_PROBE_MIN_LITERAL_CHARS)
        semanticGatherBound(
          "minimum-literal-characters",
          question.value.length,
          REPOSITORY_PROBE_MIN_LITERAL_CHARS,
        );
      if (question.value.length > REPOSITORY_PROBE_MAX_LITERAL_CHARS)
        semanticGatherBound(
          "literal-characters",
          question.value.length,
          REPOSITORY_PROBE_MAX_LITERAL_CHARS,
        );
    }
    if (question.kind !== "literal-text" || !isRepositoryLiteralProbeText(question.value))
      bad("semantic-gather-selector");
  }
  if (containsCredentialDeep(row, "hosted-semantic:gatherRequest"))
    bad("semantic-proposal-size-or-credential");
  return deepFreezeGraph(row) as unknown as HostRuntimeSemanticGatherRequestV1;
}

export interface HostRuntimeSemanticComparisonProposalV1 {
  readonly schemaVersion: 1;
  readonly kind: "docsfab-semantic-comparison-proposal";
  readonly inputSha256: string;
  readonly assessments: readonly {
    readonly evidenceId: string;
    readonly claimId: string | null;
    readonly relationship:
      | "compatible"
      | "behavior-conflict"
      | "intent-conflict"
      | "scope-conflict"
      | "version-conflict"
      | "terminology-conflict"
      | "representation-conflict"
      | "documentation-quality-conflict"
      | "unknown"
      | "irrelevant";
    readonly assertion: "proposed-intent" | "observed-implementation" | "unknown";
    readonly explanation: string;
    readonly scope: string;
    readonly confidence: "low" | "medium" | "high";
    readonly modelCitation: HostRuntimeSemanticCitationV1 | null;
    readonly sourceCitations: readonly HostRuntimeSemanticCitationV1[];
    readonly documentProjection?: SemanticDocumentProjection;
    /** Proposed semantic content only; approval/test/representation metadata stays host-owned. */
    readonly proposedClaim?: {
      readonly statement: string;
      readonly scope: Readonly<Record<string, unknown>>;
    };
    /** Whether the chunk's `mergeMessage` presents this change as deliberate; absent without one. */
    readonly mergeIntent?: HostRuntimeSemanticMergeIntent;
    /**
     * The reply the comparison suggests for this conflict, with its one-sentence rationale. Both
     * are present or neither is, only on a conflict, and the pair is never a decision.
     */
    readonly suggestion?: HostRuntimeSemanticSuggestion;
    readonly rationale?: string;
  }[];
  readonly missingEvidence: readonly string[];
  /** Pending per-input work. A later immutable input carries any newly gathered evidence. */
  readonly gatherRequests?: readonly HostRuntimeSemanticGatherRequestV1[];
  readonly ownerInformationRequests?: readonly HostRuntimeOwnerInformationRequestV1[];
  readonly acceptedEffectAssessments?: readonly HostRuntimeAcceptedEffectAssessmentV1[];
  readonly correctiveProposalAssessments?: readonly HostRuntimeCorrectiveProposalAssessmentV1[];
}

/** Data only. No evidence availability, currentness, or owner authority is asserted. */
export function parseHostRuntimeOwnerInformationRequestData(
  input: unknown,
): HostRuntimeOwnerInformationRequestV1 {
  assertHostRuntimeSemanticData(input);
  const row = record(input, [
    "evidenceId",
    "claimId",
    "requestKind",
    "question",
    "whyOwnerNeeded",
    "modelCitation",
    "sourceCitations",
  ]);
  id(row.evidenceId);
  id(row.claimId);
  enumeration(row.requestKind, ["scope", "constraint", "evidence"] as const);
  for (const key of ["question", "whyOwnerNeeded"] as const)
    if (typeof row[key] !== "string" || !row[key].trim() || row[key].includes("\0"))
      bad("semantic-owner-information-text");
  if (
    semanticCitationData(row.modelCitation).evidenceId !== row.claimId ||
    !Array.isArray(row.sourceCitations) ||
    !row.sourceCitations.length ||
    !Array.from(row.sourceCitations, semanticCitationData).some(
      (citation) => citation.evidenceId === row.evidenceId,
    )
  )
    bad("semantic-owner-information-citation");
  if (containsCredentialDeep(row, "hosted-semantic:ownerInformationRequest"))
    bad("semantic-proposal-size-or-credential");
  return deepFreezeGraph(row) as unknown as HostRuntimeOwnerInformationRequestV1;
}

/** Structural normalized proposal data only. Execution must use the real chunk-bound parser below. */
export function parseHostRuntimeSemanticComparisonProposalData(
  input: unknown,
): HostRuntimeSemanticComparisonProposalV1 {
  assertHostRuntimeSemanticData(input);
  const root = recordWithOptional(
    input,
    ["schemaVersion", "kind", "inputSha256", "assessments", "missingEvidence"],
    [
      "ownerInformationRequests",
      "acceptedEffectAssessments",
      "correctiveProposalAssessments",
      "gatherRequests",
    ],
  );
  if (
    root.schemaVersion !== 1 ||
    root.kind !== "docsfab-semantic-comparison-proposal" ||
    !Array.isArray(root.assessments) ||
    !Array.isArray(root.missingEvidence)
  )
    bad("semantic-proposal-binding");
  sha(root.inputSha256);
  const pairs = new Set<string>();
  const assessments = Array.from(root.assessments, (value) => {
    const row = recordWithOptional(
      value,
      [
        "evidenceId",
        "claimId",
        "relationship",
        "assertion",
        "explanation",
        "scope",
        "confidence",
        "modelCitation",
        "sourceCitations",
      ],
      ["proposedClaim", "documentProjection", "mergeIntent", "suggestion", "rationale"],
    );
    id(row.evidenceId);
    if (row.claimId !== null) id(row.claimId);
    if (row.mergeIntent !== undefined)
      enumeration(row.mergeIntent, HOST_RUNTIME_SEMANTIC_MERGE_INTENTS);
    const relationship = enumeration(row.relationship, [
      "compatible",
      "behavior-conflict",
      "intent-conflict",
      "scope-conflict",
      "version-conflict",
      "terminology-conflict",
      "representation-conflict",
      "documentation-quality-conflict",
      "unknown",
      "irrelevant",
    ] as const);
    enumeration(row.assertion, ["proposed-intent", "observed-implementation", "unknown"] as const);
    enumeration(row.confidence, ["low", "medium", "high"] as const);
    // A retained suggestion is exactly what the reply parser admits: both fields or neither, only
    // on a conflict, the rationale one line of inert prose within the catalog maximum.
    if (row.suggestion !== undefined || row.rationale !== undefined) {
      if (
        row.suggestion === undefined ||
        row.rationale === undefined ||
        !relationship.endsWith("-conflict")
      )
        bad("semantic-suggestion");
      enumeration(row.suggestion, HOST_RUNTIME_SEMANTIC_SUGGESTIONS);
      if (
        typeof row.rationale !== "string" ||
        !row.rationale ||
        row.rationale !== normalizeSuggestionRationale(row.rationale) ||
        [...row.rationale].length > suggestionRationaleDefinition().max
      )
        bad("semantic-suggestion-rationale");
    }
    if (
      (relationship === "irrelevant") !== (row.claimId === null) ||
      (row.claimId === null) !== (row.modelCitation === null)
    )
      bad("semantic-claim-binding");
    if (
      row.modelCitation !== null &&
      semanticCitationData(row.modelCitation).evidenceId !== row.claimId
    )
      bad("semantic-claim-citation");
    if (
      !Array.isArray(row.sourceCitations) ||
      !row.sourceCitations.length ||
      !Array.from(row.sourceCitations, semanticCitationData).some(
        (citation) => citation.evidenceId === row.evidenceId,
      )
    )
      bad("semantic-assessment-citation");
    for (const key of ["explanation", "scope"] as const)
      if (typeof row[key] !== "string" || !row[key].trim()) bad("semantic-explanation");
    if (row.proposedClaim !== undefined) {
      const proposed = record(row.proposedClaim, ["statement", "scope"]);
      if (
        row.claimId === null ||
        ["compatible", "irrelevant"].includes(relationship) ||
        typeof proposed.statement !== "string" ||
        !proposed.statement.trim()
      )
        bad("semantic-proposed-claim");
      jsonRecord(proposed.scope);
    }
    if (row.documentProjection !== undefined) {
      if (row.proposedClaim === undefined) bad("semantic-projection-without-claim");
      parseSemanticDocumentProjection(row.documentProjection);
    }
    const pair = canonicalJson([row.evidenceId, row.claimId]);
    if (pairs.has(pair)) bad("semantic-duplicate-assessment");
    pairs.add(pair);
    return row;
  });
  for (const missing of root.missingEvidence)
    if (typeof missing !== "string" || !missing.trim()) bad("semantic-missing-evidence");
  // One malformed gather request is not a refusal of the whole reply: the same
  // drop-and-name treatment as a dropped assessment applies per request, so a
  // chunk with several requests still delivers its other, well-formed ones and
  // every assessment it made. Only the proposal-wide over-32 count stays a hard
  // refusal; that bound is the model's own declared per-batch ceiling, not a
  // single request's malformed shape. `root` mutates in place, only on an actual
  // drop, and only via property replacement (never a fresh root object): an
  // already-valid, already-frozen reply must reparse to the identical reference.
  if (root.gatherRequests !== undefined) {
    const rawGatherRequests = root.gatherRequests;
    if (
      !Array.isArray(rawGatherRequests) ||
      rawGatherRequests.length === 0 ||
      (root.missingEvidence as string[]).length === 0
    )
      bad("semantic-gather-pending-evidence");
    if (rawGatherRequests.length > REPOSITORY_MAX_BATCH_PROBES)
      semanticGatherBound(
        "requests-per-proposal",
        rawGatherRequests.length,
        REPOSITORY_MAX_BATCH_PROBES,
      );
    const requests = new Set<string>();
    const knownEvidenceIds = new Set(assessments.map((row) => row.evidenceId as string));
    const kept: HostRuntimeSemanticGatherRequestV1[] = [];
    let dropped = false;
    for (const value of rawGatherRequests) {
      try {
        const request = parseHostRuntimeSemanticGatherRequestData(value);
        const assessment = assessments.find(
          (row) => row.evidenceId === request.evidenceId && row.claimId === request.claimId,
        );
        const key = canonicalJson(request);
        if (
          request.inputSha256 !== root.inputSha256 ||
          !assessment ||
          assessment.relationship !== "unknown" ||
          assessment.proposedClaim !== undefined ||
          requests.has(key)
        )
          bad("semantic-gather-assessment-binding");
        requests.add(key);
        kept.push(request);
      } catch (error) {
        if (!(error instanceof HostRuntimeContractError)) throw error;
        dropped = true;
        const note = droppedGatherRequestNote(value, error.code, knownEvidenceIds);
        const missingEvidence = root.missingEvidence as string[];
        if (!missingEvidence.includes(note)) root.missingEvidence = [...missingEvidence, note];
      }
    }
    if (dropped) {
      if (kept.length) root.gatherRequests = kept;
      else delete root.gatherRequests;
    }
  }
  if (
    root.ownerInformationRequests === null ||
    (Array.isArray(root.ownerInformationRequests) && root.ownerInformationRequests.length === 0)
  )
    delete root.ownerInformationRequests;
  if (root.ownerInformationRequests !== undefined) {
    if (!Array.isArray(root.ownerInformationRequests)) bad("semantic-owner-information-count");
    const seen = new Set<string>();
    for (const value of root.ownerInformationRequests) {
      const request = parseHostRuntimeOwnerInformationRequestData(value);
      const assessment = assessments.find(
          (row) => row.evidenceId === request.evidenceId && row.claimId === request.claimId,
        ),
        key = canonicalJson([request.evidenceId, request.claimId]);
      if (
        !assessment ||
        !String(assessment.relationship).endsWith("-conflict") ||
        assessment.proposedClaim !== undefined ||
        seen.has(key)
      )
        bad("semantic-owner-information-assessment");
      seen.add(key);
    }
  }
  if (
    root.acceptedEffectAssessments === null ||
    (Array.isArray(root.acceptedEffectAssessments) && root.acceptedEffectAssessments.length === 0)
  )
    delete root.acceptedEffectAssessments;
  if (root.acceptedEffectAssessments !== undefined) {
    if (!Array.isArray(root.acceptedEffectAssessments)) bad("accepted-effect-assessments");
    const seen = new Set<string>();
    for (const value of root.acceptedEffectAssessments) {
      const assessment = parseHostRuntimeAcceptedEffectAssessmentData(value);
      if (seen.has(assessment.facetId)) bad("accepted-effect-duplicate-facet");
      seen.add(assessment.facetId);
    }
  }
  if (root.correctiveProposalAssessments !== undefined) {
    if (
      !Array.isArray(root.correctiveProposalAssessments) ||
      !root.correctiveProposalAssessments.length ||
      root.acceptedEffectAssessments === undefined
    )
      bad("corrective-proposal-assessments");
    const seen = new Set<string>();
    for (const value of root.correctiveProposalAssessments) {
      const row = parseHostRuntimeCorrectiveProposalAssessmentData(value);
      if (seen.has(row.facetId)) bad("corrective-proposal-duplicate-facet");
      seen.add(row.facetId);
    }
  }
  if (containsCredentialDeep(root, "hosted-semantic:comparisonProposal"))
    bad("semantic-proposal-size-or-credential");
  return deepFreezeGraph(root) as unknown as HostRuntimeSemanticComparisonProposalV1;
}

export function parseHostRuntimeSemanticComparisonProposal(
  input: unknown,
  chunkInput: HostRuntimeSemanticComparisonChunkV1,
  options: HostRuntimeSemanticProposalOptions = {},
): HostRuntimeSemanticComparisonProposalV1 {
  assertHostRuntimeSemanticData(input);
  const chunk = parseHostRuntimeSemanticComparisonChunk(chunkInput);
  // The effective allowance for a fresh reply's suggestion rationale; the catalog default without one.
  const rationaleAllowance =
    options.suggestionRationaleMaxChars ?? suggestionRationaleDefinition().value;
  // The host binds the reply to its own chunk: schema, kind and input digest are
  // injected, never echoed, and a field outside the contract is ignored. Only the
  // assessments are required; a blank or non-text missing-evidence entry is dropped.
  const reply = knownFields(input, [
    "assessments",
    "missingEvidence",
    "ownerInformationRequests",
    "acceptedEffectAssessments",
    "correctiveProposalAssessments",
    "gatherRequests",
  ]);
  const root: Record<string, unknown> & { missingEvidence: string[] } = {
    ...reply,
    schemaVersion: 1,
    kind: "docsfab-semantic-comparison-proposal",
    inputSha256: chunk.inputSha256,
    missingEvidence: (Array.isArray(reply.missingEvidence) ? reply.missingEvidence : []).filter(
      (value): value is string => typeof value === "string" && value.trim() !== "",
    ),
    ...(Array.isArray(reply.gatherRequests)
      ? {
          gatherRequests: reply.gatherRequests.map((value) =>
            value && typeof value === "object" && !Array.isArray(value)
              ? { ...value, inputSha256: chunk.inputSha256 }
              : value,
          ),
        }
      : {}),
  };
  if (!Array.isArray(root.assessments)) bad("semantic-proposal-binding");
  const evidence = new Map(chunk.evidence.map((item) => [item.evidenceId, item]));
  const claims = new Map(chunk.claims.map((claim) => [claim.claimId, claim]));
  const covered = new Set<string>(),
    pairs = new Set<string>();
  const normalizedAssessments: Array<Record<string, unknown>> = [];
  const cite = (
    value: unknown,
    records: ReadonlyMap<string, { content: string }>,
  ): HostRuntimeSemanticCitationV1 => {
    // Models nominate text, not cryptographic proofs. A unique exact quote can
    // be anchored and hashed by the host without asking a model to compute SHA.
    if (value && typeof value === "object" && Object.hasOwn(value, "quote")) {
      const nomination = record(value, ["evidenceId", "quote"]);
      const evidenceId = id(nomination.evidenceId),
        item = records.get(evidenceId);
      if (
        !item ||
        typeof nomination.quote !== "string" ||
        Buffer.from(nomination.quote).toString("utf8") !== nomination.quote
      )
        bad("semantic-citation-membership");
      // A repeated quote cites its first occurrence; an empty one, or one the host
      // cannot find verbatim, cites the whole record it names.
      const found = nomination.quote ? item.content.indexOf(nomination.quote) : -1;
      const quote = found < 0 ? item.content : nomination.quote,
        startByte = Buffer.byteLength(item.content.slice(0, Math.max(found, 0))),
        endByte = startByte + Buffer.byteLength(quote);
      return Object.freeze({
        evidenceId,
        startByte,
        endByte,
        sha256: createHash("sha256").update(quote).digest("hex"),
      });
    }
    const row = record(value, ["evidenceId", "startByte", "endByte", "sha256"]);
    const evidenceId = id(row.evidenceId),
      item = records.get(evidenceId);
    const start = nonnegative(row.startByte),
      end = nonnegative(row.endByte);
    if (!item || end < start) bad("semantic-citation-membership");
    const bytes = Buffer.from(item.content, "utf8");
    if (
      (end === start && bytes.length !== 0) ||
      end > bytes.length ||
      createHash("sha256").update(bytes.subarray(start, end)).digest("hex") !== sha(row.sha256)
    )
      bad("semantic-citation-span");
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(start, end));
    } catch {
      bad("semantic-citation-encoding");
    }
    return row as unknown as HostRuntimeSemanticCitationV1;
  };
  const purpose = chunk.acceptedEffectRevalidation;
  const isCurrentAbsence = (citation: HostRuntimeSemanticCitationV1): boolean => {
    const source = evidence.get(citation.evidenceId);
    if (
      !purpose ||
      !source ||
      source.kind !== "supporting-context" ||
      source.sourcePath !== null ||
      source.sourceVersionSha256 === null ||
      source.version !== purpose.repository.observedRevision ||
      source.startByte !== 0 ||
      source.endByte !== source.totalBytes ||
      citation.startByte !== 0 ||
      citation.endByte !== Buffer.byteLength(source.content) ||
      citation.sha256 !== source.contentSha256
    )
      return false;
    let parsed: unknown;
    try {
      parsed = JSON.parse(source.content);
    } catch {
      bad("accepted-effect-absence-record");
    }
    const marker = record(parsed, ["kind", "path", "revision", "tree", "observationSha256"]);
    return (
      marker.kind === "docsfab-observed-repository-absence" &&
      typeof marker.path === "string" &&
      marker.path.length > 0 &&
      !marker.path.startsWith("/") &&
      !/[\\\u0000-\u001f\u007f]/u.test(marker.path) &&
      marker.path.split("/").every((part) => part && ![".", "..", ".git"].includes(part)) &&
      marker.revision === purpose.repository.observedRevision &&
      marker.tree === purpose.repository.observedTree &&
      marker.observationSha256 === purpose.repository.observationSha256 &&
      canonicalJson(marker) === source.content
    );
  };
  const currentCitation = (citation: HostRuntimeSemanticCitationV1): boolean => {
    const source = evidence.get(citation.evidenceId)!;
    return (
      !!purpose &&
      ((source.sourcePath !== null &&
        source.version === purpose.repository.observedRevision &&
        ["repository-after", "supporting-context"].includes(source.kind)) ||
        isCurrentAbsence(citation))
    );
  };
  const currentImplementationCitation = (citation: HostRuntimeSemanticCitationV1): boolean => {
    const role = evidence.get(citation.evidenceId)!.repositoryRole;
    return (
      currentCitation(citation) &&
      (purpose?.schemaVersion === 1 ||
        (role?.classification === "implementation" && role.sourceKind === "repository-source"))
    );
  };
  const modelEvidence = new Map(
    chunk.claims.map((claim) => [claim.claimId, { content: claim.statement }]),
  );
  for (const value of root.assessments) {
    try {
      const row = recordWithOptional(
        knownFields(value, SEMANTIC_ASSESSMENT_FIELDS),
        [
          "evidenceId",
          "claimId",
          "relationship",
          "assertion",
          "explanation",
          "scope",
          "confidence",
          "modelCitation",
          "sourceCitations",
        ],
        ["proposedClaim", "documentProjection", "mergeIntent", "suggestion", "rationale"],
      );
      let assessmentNote: string | null = null;
      let suggestionNote: string | null = null;
      // A model's casing or padding of an enumerated value is not a different value.
      for (const key of ["relationship", "assertion", "confidence", "mergeIntent"])
        if (typeof row[key] === "string") row[key] = (row[key] as string).trim().toLowerCase();
      // The condition: an intent judgement the chunk gave no merge message for, or a value
      // outside the three judgements. It is dropped and the assessment stands; a valid
      // judgement on an input that carries the merge message is kept.
      if (
        row.mergeIntent !== undefined &&
        (chunk.mergeMessage === undefined ||
          !(HOST_RUNTIME_SEMANTIC_MERGE_INTENTS as readonly unknown[]).includes(row.mergeIntent))
      )
        delete row.mergeIntent;
      const evidenceId = id(row.evidenceId),
        claimId = row.claimId === null ? null : id(row.claimId);
      if (!evidence.has(evidenceId) || (claimId !== null && !claims.has(claimId)))
        bad("semantic-assessment-membership");
      const relationship = enumeration(row.relationship, [
        "compatible",
        "behavior-conflict",
        "intent-conflict",
        "scope-conflict",
        "version-conflict",
        "terminology-conflict",
        "representation-conflict",
        "documentation-quality-conflict",
        "unknown",
        "irrelevant",
      ] as const);
      const assertion = enumeration(row.assertion, [
        "proposed-intent",
        "observed-implementation",
        "unknown",
      ] as const);
      enumeration(row.confidence, ["low", "medium", "high"] as const);
      // The condition: a suggested reply that is not exactly keep, update or later with a
      // one-sentence rationale, either field without the other, or a pair on an assessment that
      // is not a conflict. The pair is dropped and the assessment stands; the host then
      // suggests by its own default rule. A rationale past the allowance is named, never cut.
      if (row.suggestion !== undefined || row.rationale !== undefined) {
        const suggestion =
          typeof row.suggestion === "string" ? row.suggestion.trim().toLowerCase() : null;
        const rationale =
          typeof row.rationale === "string" ? normalizeSuggestionRationale(row.rationale) : null;
        const length = rationale === null ? 0 : [...rationale].length;
        const usable =
          suggestion !== null &&
          (HOST_RUNTIME_SEMANTIC_SUGGESTIONS as readonly string[]).includes(suggestion) &&
          rationale !== null &&
          rationale !== "" &&
          relationship.endsWith("-conflict") &&
          length <= rationaleAllowance;
        if (usable) {
          row.suggestion = suggestion;
          row.rationale = rationale;
        } else {
          delete row.suggestion;
          delete row.rationale;
          if (
            rationale !== null &&
            length > rationaleAllowance &&
            relationship.endsWith("-conflict")
          )
            suggestionNote = `The comparison's suggested reply${claimId === null ? "" : ` for ${claimId}`} was not used: ${suggestionRationaleRefusal(rationaleAllowance, length)}`;
        }
      }
      if (
        (relationship === "irrelevant") !== (claimId === null) ||
        (claimId === null) !== (row.modelCitation === null)
      )
        bad("semantic-claim-binding");
      const modelCitation = claimId === null ? null : cite(row.modelCitation, modelEvidence);
      if (modelCitation !== null && modelCitation.evidenceId !== claimId)
        bad("semantic-claim-citation");
      if (!Array.isArray(row.sourceCitations) || row.sourceCitations.length === 0)
        bad("semantic-source-citations");
      const citations = row.sourceCitations.map((citation) => cite(citation, evidence));
      if (!citations.some((citation) => citation.evidenceId === evidenceId))
        bad("semantic-assessment-citation");
      if (
        assertion === "observed-implementation" &&
        chunk.repositoryObservationVersion === 3 &&
        evidence.get(evidenceId)!.repositoryRole?.classification !== "implementation"
      )
        bad("semantic-unclassified-is-not-implementation");
      if (
        assertion === "observed-implementation" &&
        !citations.some(
          (citation) =>
            ["repository-before", "repository-after"].includes(
              evidence.get(citation.evidenceId)!.kind,
            ) || isCurrentAbsence(citation),
        )
      )
        bad("semantic-intent-is-not-implementation");
      // A model restates the claim's structured scope as an object, as the chunk's claims
      // carry it; the assessment keeps that object as its canonical JSON text.
      if (row.scope && typeof row.scope === "object" && !Array.isArray(row.scope))
        row.scope = canonicalJson(jsonRecord(row.scope));
      for (const key of ["explanation", "scope"]) {
        if (typeof row[key] !== "string" || !(row[key] as string).trim())
          bad("semantic-explanation");
      }
      if (row.proposedClaim !== undefined) {
        const proposed = knownFields(row.proposedClaim, ["statement", "scope"]);
        if (
          claimId === null ||
          relationship === "compatible" ||
          relationship === "irrelevant" ||
          typeof proposed.statement !== "string" ||
          !proposed.statement.trim()
        )
          bad("semantic-proposed-claim");
        const scope = proposedClaimScope(proposed.scope);
        if (!scope)
          assessmentNote = `The comparison kept the approved scope of ${claimId} for its proposed claim.`;
        row.proposedClaim = {
          statement: proposed.statement,
          scope: scope ?? jsonRecord(JSON.parse(claims.get(claimId)!.scope)),
        };
      }
      // The condition: a proposal, on a chunk with a protected document-target policy, that
      // carries no document plan. The proposal is dropped and named, so the assessment stands
      // as a conflict with no exact alternative; a proposal with its plan is bound below.
      if (
        chunk.documentTargets &&
        row.proposedClaim !== undefined &&
        row.documentProjection === undefined
      ) {
        delete row.proposedClaim;
        assessmentNote = `The comparison proposed a claim for ${claimId} without its document plan; the proposal was dropped.`;
      }
      if (row.documentProjection !== undefined) {
        if (row.proposedClaim === undefined || chunk.documentTargets === undefined)
          bad("semantic-projection-without-policy-or-claim");
        const projection = bindSemanticDocumentProjection(
          chunk.documentTargets,
          row.documentProjection,
        );
        for (const document of projection.documents) {
          const supplied = chunk.evidence
            .filter(
              (item) =>
                item.sourcePath === document.path &&
                item.version === document.sourceRevision &&
                item.sourceContentSha256 === document.sourceSha256 &&
                ["repository-after", "supporting-context"].includes(item.kind),
            )
            .sort((a, b) => a.startByte - b.startByte);
          const expected = chunk.documentTargets.targets.find(
            (item) => item.targetId === document.targetId,
          )!;
          if (
            supplied.some(
              (item) =>
                item.repositoryRole?.sourceKind !== expected.sourceKind ||
                item.repositoryRole.classification !== "context",
            )
          )
            bad("semantic-projection-full-current-source-required");
          const ranges = semanticDocumentByteRanges(supplied);
          if (
            createHash("sha256")
              .update(ranges.map((item) => item.content).join(""))
              .digest("hex") !== document.sourceSha256 ||
            document.citations.length !== supplied.length
          )
            bad("semantic-projection-source-hash");
          for (const [index, citation] of document.citations.entries()) {
            const resolved = cite(citation, evidence),
              item = supplied[index]!;
            if (
              resolved.evidenceId !== item.evidenceId ||
              resolved.startByte !== 0 ||
              resolved.endByte !== Buffer.byteLength(item.content) ||
              resolved.sha256 !== item.contentSha256
            )
              bad("semantic-projection-complete-citation");
            if (!citations.some((existing) => canonicalJson(existing) === canonicalJson(resolved)))
              citations.push(resolved);
          }
        }
      }
      const pair = canonicalJson([evidenceId, claimId]);
      if (pairs.has(pair)) bad("semantic-duplicate-assessment");
      pairs.add(pair);
      covered.add(evidenceId);
      normalizedAssessments.push({
        ...row,
        explanation: inertProse(row.explanation as string),
        ...(row.proposedClaim === undefined
          ? {}
          : {
              proposedClaim: {
                ...(row.proposedClaim as Record<string, unknown>),
                statement: inertProse((row.proposedClaim as { statement: string }).statement),
              },
            }),
        modelCitation,
        sourceCitations: citations,
      });
      if (assessmentNote && !root.missingEvidence.includes(assessmentNote))
        root.missingEvidence = [...root.missingEvidence, assessmentNote];
      if (suggestionNote && !root.missingEvidence.includes(suggestionNote))
        root.missingEvidence = [...root.missingEvidence, suggestionNote];
    } catch (error) {
      // The condition: the contract refuses this one assessment. It is dropped and named,
      // and the rest of the reply stands. Not that condition, so still a refusal of the
      // whole reply: any error that is not a contract code, and any document-projection
      // refusal or chunk with a protected document-target policy, because projections
      // plan document writes. A dropped row's text never reaches the result; the admitted
      // rows still pass the whole-reply credential check below.
      if (
        !(error instanceof HostRuntimeContractError) ||
        /^semantic-(?:projection|document)-/u.test(error.code) ||
        chunk.documentTargets !== undefined
      )
        throw error;
      const note = droppedAssessmentNote(value, evidence, error.code);
      if (!root.missingEvidence.includes(note))
        root.missingEvidence = [...root.missingEvidence, note];
    }
  }
  // Evidence the reply left unassessed is named, never a refusal of the assessments
  // it made. The note is deterministic, so parsing the normalized proposal again
  // yields the same proposal.
  const unassessed = chunk.evidence.filter((item) => !covered.has(item.evidenceId)).length;
  const unassessedNote = `The comparison did not assess ${unassessed} supplied evidence fragment(s).`;
  if (unassessed && !root.missingEvidence.includes(unassessedNote))
    root.missingEvidence = [...root.missingEvidence, unassessedNote];
  let ownerInformationRequests: HostRuntimeOwnerInformationRequestV1[] | undefined;
  if (
    root.ownerInformationRequests === null ||
    (Array.isArray(root.ownerInformationRequests) && root.ownerInformationRequests.length === 0)
  )
    delete root.ownerInformationRequests;
  if (root.ownerInformationRequests !== undefined) {
    if (!Array.isArray(root.ownerInformationRequests)) bad("semantic-owner-information-count");
    const requested = new Set<string>();
    ownerInformationRequests = root.ownerInformationRequests.map((item) => {
      const request = record(item, [
        "evidenceId",
        "claimId",
        "requestKind",
        "question",
        "whyOwnerNeeded",
        "modelCitation",
        "sourceCitations",
      ]);
      const evidenceId = id(request.evidenceId),
        claimId = id(request.claimId);
      const assessment = normalizedAssessments.find(
        (row) => row.evidenceId === evidenceId && row.claimId === claimId,
      );
      const pair = canonicalJson([evidenceId, claimId]);
      if (
        !assessment ||
        !String(assessment.relationship).endsWith("-conflict") ||
        assessment.proposedClaim !== undefined ||
        requested.has(pair)
      )
        bad("semantic-owner-information-assessment");
      requested.add(pair);
      const requestKind = enumeration(request.requestKind, [
        "scope",
        "constraint",
        "evidence",
      ] as const);
      for (const key of ["question", "whyOwnerNeeded"] as const) {
        if (typeof request[key] !== "string" || !request[key].trim() || request[key].includes("\0"))
          bad("semantic-owner-information-text");
      }
      const modelCitation = cite(request.modelCitation, modelEvidence);
      if (
        modelCitation.evidenceId !== claimId ||
        !Array.isArray(request.sourceCitations) ||
        request.sourceCitations.length === 0
      )
        bad("semantic-owner-information-citation");
      const sourceCitations = request.sourceCitations.map((citation) => cite(citation, evidence));
      if (!sourceCitations.some((citation) => citation.evidenceId === evidenceId))
        bad("semantic-owner-information-citation");
      return {
        evidenceId,
        claimId,
        requestKind,
        question: request.question as string,
        whyOwnerNeeded: request.whyOwnerNeeded as string,
        modelCitation,
        sourceCitations,
      };
    });
  }
  let acceptedEffectAssessments: HostRuntimeAcceptedEffectAssessmentV1[] | undefined;
  if (
    root.acceptedEffectAssessments === null ||
    (Array.isArray(root.acceptedEffectAssessments) && root.acceptedEffectAssessments.length === 0)
  )
    delete root.acceptedEffectAssessments;
  if (
    purpose === undefined
      ? root.acceptedEffectAssessments !== undefined
      : !Array.isArray(root.acceptedEffectAssessments)
  )
    bad("accepted-effect-purpose-binding");
  if (purpose) {
    const facets = new Map(purpose.facets.map((facet) => [facet.facetId, facet]));
    const intentEvidence = new Map(
      purpose.facets.map((facet) => [facet.facetId, { content: facet.content }]),
    );
    const seen = new Set<string>();
    acceptedEffectAssessments = (root.acceptedEffectAssessments as unknown[]).map((value) => {
      const row = record(value, [
        "facetId",
        "relationship",
        "assertion",
        "explanation",
        "intentCitation",
        "sourceCitations",
      ]);
      const facetId = id(row.facetId),
        facet = facets.get(facetId);
      if (!facet || seen.has(facetId) || !Array.isArray(row.sourceCitations))
        bad("accepted-effect-facet-membership");
      seen.add(facetId);
      const intentCitation = cite(row.intentCitation, intentEvidence);
      if (
        intentCitation.evidenceId !== facetId ||
        intentCitation.startByte !== 0 ||
        intentCitation.endByte !== Buffer.byteLength(facet.content) ||
        intentCitation.sha256 !== facet.contentSha256
      )
        bad("accepted-effect-complete-intent-citation");
      const sourceCitations = row.sourceCitations.map((citation) => cite(citation, evidence));
      const normalized = parseHostRuntimeAcceptedEffectAssessmentData({
        ...row,
        intentCitation,
        sourceCitations,
      });
      if (
        ["supports-full-facet", "supports-part-of-facet", "contradicts"].includes(
          normalized.relationship,
        )
      ) {
        if (
          normalized.assertion !==
            (purpose.subject === "desired-intent"
              ? "proposed-intent"
              : "observed-implementation") ||
          !sourceCitations.some(
            purpose.subject === "observed-implementation"
              ? currentImplementationCitation
              : currentCitation,
          )
        )
          bad("accepted-effect-current-evidence");
      }
      return normalized;
    });
    if (seen.size !== facets.size) bad("accepted-effect-uncovered-facet");
  }
  let correctiveProposalAssessments: HostRuntimeCorrectiveProposalAssessmentV1[] | undefined;
  if (
    chunk.correctiveProposalRevalidation === undefined
      ? root.correctiveProposalAssessments !== undefined
      : !Array.isArray(root.correctiveProposalAssessments)
  )
    bad("corrective-proposal-purpose-binding");
  if (chunk.correctiveProposalRevalidation && purpose) {
    const facets = new Map(purpose.facets.map((facet) => [facet.facetId, facet]));
    const intentEvidence = new Map(
      purpose.facets.map((facet) => [facet.facetId, { content: facet.content }]),
    );
    const seen = new Set<string>();
    correctiveProposalAssessments = (root.correctiveProposalAssessments as unknown[]).map(
      (value) => {
        const row = record(value, [
          "facetId",
          "applicability",
          "implementation",
          "explanation",
          "intentCitation",
          "sourceCitations",
          "gapFindings",
        ]);
        const facet = facets.get(id(row.facetId));
        if (!facet || seen.has(facet.facetId) || !Array.isArray(row.sourceCitations))
          bad("corrective-proposal-facet-membership");
        seen.add(facet.facetId);
        const intentCitation = cite(row.intentCitation, intentEvidence),
          sourceCitations = row.sourceCitations.map((value) => cite(value, evidence));
        if (
          intentCitation.evidenceId !== facet.facetId ||
          intentCitation.startByte !== 0 ||
          intentCitation.endByte !== Buffer.byteLength(facet.content) ||
          intentCitation.sha256 !== facet.contentSha256
        )
          bad("corrective-proposal-full-intent-citation");
        const normalized = parseHostRuntimeCorrectiveProposalAssessmentData({
          ...row,
          intentCitation,
          sourceCitations,
        });
        if (
          (["within-approved-scope", "partially-established", "scope-change-required"].includes(
            normalized.applicability,
          ) ||
            ["retained-deviation-present", "aligned", "partially-established"].includes(
              normalized.implementation,
            )) &&
          !sourceCitations.some(currentCitation)
        )
          bad("corrective-proposal-current-evidence");
        if (
          ["retained-deviation-present", "aligned", "partially-established"].includes(
            normalized.implementation,
          ) &&
          !sourceCitations.some(currentImplementationCitation)
        )
          bad("corrective-proposal-implementation-evidence");
        for (const gap of normalized.gapFindings) {
          const finding = normalizedAssessments.find(
            (value) => value.evidenceId === gap.evidenceId && value.claimId === gap.claimId,
          ) as HostRuntimeSemanticComparisonProposalV1["assessments"][number] | undefined;
          if (
            !finding ||
            finding.claimId !== purpose.claim.before.claim_id ||
            !finding.relationship.endsWith("-conflict") ||
            finding.assertion !== "observed-implementation" ||
            !finding.proposedClaim ||
            canonicalJson({ claim_id: finding.claimId, ...finding.proposedClaim }) !==
              canonicalJson(purpose.claim.offeredAfter) ||
            !finding.sourceCitations.some(currentImplementationCitation)
          )
            bad("corrective-proposal-unbound-implementation-gap");
        }
        return normalized;
      },
    );
    if (seen.size !== facets.size) bad("corrective-proposal-uncovered-facet");
  }
  const normalized = {
    ...root,
    assessments: normalizedAssessments,
    ...(ownerInformationRequests === undefined ? {} : { ownerInformationRequests }),
    ...(acceptedEffectAssessments === undefined ? {} : { acceptedEffectAssessments }),
    ...(correctiveProposalAssessments === undefined ? {} : { correctiveProposalAssessments }),
  };
  // Exact quote spans have already become citations. Their source text is
  // retained in the verified input, while every metadata field stays strict.
  if (containsCredentialDeep(normalized, "hosted-semantic:comparisonProposal"))
    bad("semantic-proposal-size-or-credential");
  return parseHostRuntimeSemanticComparisonProposalData(normalized);
}

const SEMANTIC_ASSESSMENT_FIELDS = [
  "evidenceId",
  "claimId",
  "relationship",
  "assertion",
  "explanation",
  "scope",
  "confidence",
  "modelCitation",
  "sourceCitations",
  "proposedClaim",
  "documentProjection",
  "mergeIntent",
  "suggestion",
  "rationale",
] as const;

/**
 * Model prose the merge result stores as a one-line claim statement: the text is NFC,
 * control characters become spaces, angle or square brackets become parentheses and an
 * absolute path loses its leading slash, so one reply's markup never refuses the whole
 * comparison. The raw reply stays in the run record.
 */
function inertProse(value: string): string {
  return value
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f-\u009f]+/gu, " ")
    .replace(/[<[]/gu, "(")
    .replace(/[>\]]/gu, ")")
    .replace(/(^|[\s"'(])\/(?=[A-Za-z0-9._-]+\/)/gu, "$1")
    .trim();
}

/**
 * The scope of a proposed claim: an object as given, or the same object written as JSON
 * text, which is how the chunk hands every claim scope to the model. Anything else is
 * `null`, and the caller keeps the affected claim's approved scope.
 */
function proposedClaimScope(value: unknown): Record<string, unknown> | null {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  return parsed &&
    typeof parsed === "object" &&
    !Array.isArray(parsed) &&
    Object.getPrototypeOf(parsed) === Object.prototype
    ? jsonRecord(parsed)
    : null;
}

/** The deterministic note for a dropped assessment; only a declared evidence ID is named. */
function droppedAssessmentNote(
  value: unknown,
  evidence: ReadonlyMap<string, unknown>,
  code: string,
): string {
  const evidenceId =
    value &&
    typeof value === "object" &&
    typeof (value as { evidenceId?: unknown }).evidenceId === "string"
      ? (value as { evidenceId: string }).evidenceId
      : null;
  const named =
    evidenceId !== null && evidence.has(evidenceId) ? evidenceId : "undeclared evidence";
  return `The comparison dropped an assessment of ${named} (${code}).`;
}

/**
 * The deterministic note for a dropped gather request; a malformed or unbound request never
 * fails the rest of the reply's assessments or its other, well-formed gather requests. The
 * request may have failed structural parsing itself, so its raw evidenceId is untrusted model
 * text; only named when it equals a real assessment's evidenceId already present elsewhere in
 * this same reply (the same "only a declared identity is named" rule `droppedAssessmentNote`
 * applies against the chunk's own evidence), never echoed raw. Otherwise unnamed.
 */
function droppedGatherRequestNote(
  value: unknown,
  code: string,
  knownEvidenceIds: ReadonlySet<string>,
): string {
  const raw =
    value &&
    typeof value === "object" &&
    typeof (value as { evidenceId?: unknown }).evidenceId === "string"
      ? (value as { evidenceId: string }).evidenceId
      : "";
  const named = raw && knownEvidenceIds.has(raw) ? raw : "undeclared evidence";
  return `The comparison dropped a gather request for ${named} (${code}).`;
}

/** The named fields of one reply object; a field outside the contract is ignored. */
function knownFields(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const source = recordWithOptional(value, [], Object.keys(value ?? {}));
  return Object.fromEntries(
    keys.filter((key) => Object.hasOwn(source, key)).map((key) => [key, source[key]]),
  );
}
