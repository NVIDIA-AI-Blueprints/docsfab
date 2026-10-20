// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Source-evidence consumer for knowledge gathering.
 *
 * Knowledge does not import runtime implementation, so this module owns a strict
 * decoder for the wire format and recomputes every record digest before trusting
 * a field. A decoded record is only evidence: it grants no access and cannot
 * widen the repository scope knowledge already has.
 *
 * The original's lineage identity is `original-<originalSha256>`; every
 * derivative keeps its host-generated `representationId` with the original as
 * its parent.
 */
import { createHash } from "node:crypto";

export const SOURCE_OBSERVATION_KIND = "docsfab-source-observation";
export const SOURCE_BINDING_KIND = "docsfab-source-binding";
export const SOURCE_EVIDENCE_SCHEMA_VERSION = 1;
export const SOURCE_REPRESENTATION_MEDIA_TYPE = "text/plain; charset=utf-8";

export const SOURCE_LOCATOR_KINDS = Object.freeze([
  "diff",
  "docx-block",
  "html-node",
  "json-pointer",
  "notebook-cell",
  "pdf-page",
  "text",
]);

const OBSERVATION_KEYS = Object.freeze([
  "acquisitionReceiptSha256",
  "inputId",
  "kind",
  "observationId",
  "observationSha256",
  "observedAt",
  "original",
  "originIdSha256",
  "producerId",
  "producerScopeSha256",
  "producerVersion",
  "registrationSha256",
  "repository",
  "representations",
  "requestSha256",
  "runIdSha256",
  "schemaVersion",
]);

const BINDING_KEYS = Object.freeze([
  "bindingSha256",
  "hostPolicySha256",
  "kind",
  "observations",
  "parentBindingSha256",
  "producerScopeSha256",
  "repository",
  "requestSha256",
  "requiredObservationIds",
  "runIdSha256",
  "schemaVersion",
]);

const REPRESENTATION_KEYS = Object.freeze([
  "byteLength",
  "completeness",
  "extractor",
  "limitations",
  "mediaType",
  "originalSha256",
  "representationId",
  "representationSha256",
  "sha256",
  "spans",
]);

const SHA256 = /^[a-f0-9]{64}$/u;

export class EvidenceSourceError extends Error {
  constructor(code) {
    super(`Source evidence rejected: ${code}.`);
    this.name = "EvidenceSourceError";
    this.code = code;
  }
}

function fail(code) {
  throw new EvidenceSourceError(code);
}

/** Matches the runtime canonical form: sorted keys, JSON.stringify output. */
export function canonicalJson(value) {
  return JSON.stringify(sortValue(value));
}

export function canonicalDigest(value) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => [key, sortValue(child)]),
  );
}

function plainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid-shape");
  if (Object.getPrototypeOf(value) !== Object.prototype) fail("invalid-shape");
  return value;
}

function exactKeys(value, keys) {
  const present = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (present.length !== expected.length) fail("invalid-shape");
  for (let index = 0; index < expected.length; index += 1) {
    if (present[index] !== expected[index]) fail("invalid-shape");
  }
}

function requireSha(value) {
  if (typeof value !== "string" || !SHA256.test(value)) fail("invalid-value");
  return value;
}

function requireNonNegativeInteger(value) {
  if (!Number.isSafeInteger(value) || value < 0) fail("invalid-value");
  return value;
}

/** Recompute the sealed digest over every field except its own named hash. */
function verifySealedDigest(record, digestKey, code) {
  const { [digestKey]: declared, ...body } = record;
  requireSha(declared);
  if (canonicalDigest(body) !== declared) fail(code);
  return declared;
}

export function decodeSourceObservationRecord(value) {
  const record = plainObject(value);
  exactKeys(record, OBSERVATION_KEYS);
  if (record.schemaVersion !== SOURCE_EVIDENCE_SCHEMA_VERSION) fail("unsupported-version");
  if (record.kind !== SOURCE_OBSERVATION_KIND) fail("unknown-record");
  verifySealedDigest(record, "observationSha256", "observation-digest-mismatch");

  const original = plainObject(record.original);
  requireSha(original.sha256);
  requireNonNegativeInteger(original.byteLength);
  const representations = record.representations;
  if (!Array.isArray(representations) || representations.length === 0) fail("invalid-shape");
  for (const representation of representations) {
    const entry = plainObject(representation);
    exactKeys(entry, REPRESENTATION_KEYS);
    if (entry.mediaType !== SOURCE_REPRESENTATION_MEDIA_TYPE) fail("invalid-value");
    if (requireSha(entry.originalSha256) !== original.sha256) fail("representation-mismatch");
    verifySealedDigest(entry, "representationSha256", "representation-digest-mismatch");
    requireSha(entry.sha256);
    requireNonNegativeInteger(entry.byteLength);
    if (!Array.isArray(entry.spans)) fail("invalid-shape");
    const seen = new Set();
    for (const span of entry.spans) {
      const row = plainObject(span);
      exactKeys(row, ["spanId", "startByte", "endByte", "locator"]);
      if (typeof row.spanId !== "string" || row.spanId.length === 0) fail("invalid-value");
      if (seen.has(row.spanId)) fail("duplicate-span");
      seen.add(row.spanId);
      requireNonNegativeInteger(row.startByte);
      requireNonNegativeInteger(row.endByte);
      if (row.endByte <= row.startByte || row.endByte > entry.byteLength) fail("invalid-span");
      const locator = plainObject(row.locator);
      if (!SOURCE_LOCATOR_KINDS.includes(locator.kind)) fail("unknown-locator");
    }
  }
  return record;
}

export function decodeSourceBindingRecord(value) {
  const record = plainObject(value);
  exactKeys(record, BINDING_KEYS);
  if (record.schemaVersion !== SOURCE_EVIDENCE_SCHEMA_VERSION) fail("unsupported-version");
  if (record.kind !== SOURCE_BINDING_KIND) fail("unknown-record");
  verifySealedDigest(record, "bindingSha256", "binding-digest-mismatch");
  if (!Array.isArray(record.observations) || record.observations.length === 0) fail("invalid-shape");
  for (const row of record.observations) {
    const entry = plainObject(row);
    exactKeys(entry, ["observationId", "observationSha256"]);
    requireSha(entry.observationSha256);
  }
  if (!Array.isArray(record.requiredObservationIds)) fail("invalid-shape");
  const known = new Set(record.observations.map((entry) => entry.observationId));
  for (const id of record.requiredObservationIds) {
    if (!known.has(id)) fail("unknown-required-observation");
  }
  return record;
}

/**
 * Representation lineage rows for one observation, rooted at the original so a
 * derivative is not presented as the original bytes.
 */
export function sourceRepresentationLineage(observation) {
  const record = decodeSourceObservationRecord(observation);
  const originalRepresentationId = `original-${record.original.sha256}`;
  return Object.freeze([
    Object.freeze({
      representationId: originalRepresentationId,
      parentRepresentationId: null,
      role: "original",
      mediaType: record.original.mediaType,
      sha256: record.original.sha256,
      byteLength: record.original.byteLength,
      completeness: "complete",
      limitations: Object.freeze([]),
    }),
    ...record.representations.map((entry) =>
      Object.freeze({
        representationId: entry.representationId,
        parentRepresentationId: originalRepresentationId,
        role: "derivative",
        mediaType: entry.mediaType,
        sha256: entry.sha256,
        byteLength: entry.byteLength,
        extractor: Object.freeze({ ...entry.extractor }),
        completeness: entry.completeness,
        limitations: Object.freeze([...entry.limitations]),
      }),
    ),
  ]);
}

/**
 * Resolve a binding, its observations, and retained derivative text into source
 * registrations and exact span quotations. Every digest is recomputed, every
 * derivative is matched to its sealed representation, and every required
 * observation must be present, so a divergence fails here, not as a citation.
 */
export function resolveSourceEvidence(input) {
  const binding = decodeSourceBindingRecord(input?.binding);
  const supplied = Array.isArray(input?.observations) ? input.observations : fail("invalid-shape");
  const derivatives = input?.derivatives ?? {};
  const decoded = new Map();
  for (const observation of supplied) {
    const record = decodeSourceObservationRecord(observation);
    if (decoded.has(record.observationId)) fail("duplicate-observation");
    decoded.set(record.observationId, record);
  }
  for (const reference of binding.observations) {
    const record = decoded.get(reference.observationId);
    if (!record) fail("observation-unavailable");
    if (record.observationSha256 !== reference.observationSha256) fail("observation-mismatch");
    if (record.runIdSha256 !== binding.runIdSha256) fail("observation-mismatch");
    if (record.requestSha256 !== binding.requestSha256) fail("observation-mismatch");
  }
  for (const required of binding.requiredObservationIds) {
    if (!decoded.has(required)) fail("required-source-missing");
  }

  const sources = [];
  for (const reference of binding.observations) {
    const record = decoded.get(reference.observationId);
    for (const representation of record.representations) {
      const text = derivatives[representation.representationId];
      if (text === undefined) continue;
      if (typeof text !== "string") fail("invalid-derivative");
      const bytes = Buffer.from(text, "utf8");
      if (
        bytes.byteLength !== representation.byteLength ||
        createHash("sha256").update(bytes).digest("hex") !== representation.sha256
      ) {
        fail("derivative-mismatch");
      }
      sources.push(
        Object.freeze({
          observationId: record.observationId,
          representationId: representation.representationId,
          required: binding.requiredObservationIds.includes(record.observationId),
          location: record.original.repositoryPath,
          mediaType: record.original.mediaType,
          authority: "source-evidence-binding",
          freshness: record.repository.revision,
          completeness: representation.completeness,
          limitations: Object.freeze([...representation.limitations]),
          spans: Object.freeze(
            representation.spans.map((span) =>
              Object.freeze({
                spanId: span.spanId,
                locator: Object.freeze({ ...span.locator }),
                text: bytes.subarray(span.startByte, span.endByte).toString("utf8"),
              }),
            ),
          ),
        }),
      );
    }
  }
  if (sources.length === 0) fail("no-readable-representation");
  return Object.freeze({ bindingSha256: binding.bindingSha256, sources: Object.freeze(sources) });
}

/** Confirm a quotation is the exact retained derivative bytes for one span. */
export function verifySourceSpanQuotation(input) {
  const resolved = resolveSourceEvidence({
    binding: input?.binding,
    observations: input?.observations,
    derivatives: input?.derivatives,
  });
  for (const source of resolved.sources) {
    if (source.representationId !== input?.representationId) continue;
    for (const span of source.spans) {
      if (span.spanId === input?.spanId) return span.text === input?.quotedText;
    }
  }
  fail("unknown-span");
}
