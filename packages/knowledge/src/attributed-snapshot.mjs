// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Emit a new knowledge-accepted snapshot from one attributed needs-input
 * answer. Prior snapshot bytes stay immutable; interview JSON is not stored
 * on the snapshot envelope.
 */
import { createHash } from "node:crypto";

const SNAPSHOT_KIND = "knowledge-accepted-snapshot";
const ANSWER_KIND = "knowledge-attributed-answer";
const SCHEMA_VERSION = 1;
const ACCOUNTABLE_AUTHORITY = "product-decision-owner";
const RESOLVED_MODEL_STATE = "candidate";
const SUPERSEDED_MODEL_STATE = "superseded";
const NEEDS_INPUT_CLAIM_STATES = new Set(["disputed", "unresolved"]);
const CLAIM_MODEL_STATES = new Set([
  "participant-only",
  "candidate",
  "disputed",
  "unresolved",
  "canonical",
  "superseded",
]);
const SNAPSHOT_STATUSES = new Set(["approved", "canonical", "candidate"]);
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const DOCUMENTATION_PATH_PATTERN = /^docs\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.mdx?$/u;
const CONFLICT_IMPACTS = new Set(["advisory", "load-bearing"]);
const CONFLICT_CLASSIFICATION_KEYS = new Set([
  "impact",
  "impactBasisSha256",
  "blockingDocumentationPaths",
  "resolutionOwner",
  "authorityKind",
]);
const CREDENTIAL_MATERIAL =
  /(?:\b(?:glpat|gldt|glrt|glptt)-[A-Za-z0-9_-]{20,}\b|\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}\b|\bxox[baprcds]-[A-Za-z0-9-]{20,}\b|\b(?:nvapi|sk(?:-proj)?)-[A-Za-z0-9_-]{20,}\b|-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*\S{8,})/iu;

function compareString(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareId(left, right) {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function sortValue(value) {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => compareString(left, right))
      .map(([key, child]) => [key, sortValue(child)]),
  );
}

function canonicalDigest(value) {
  return createHash("sha256")
    .update(JSON.stringify(sortValue(value)))
    .digest("hex");
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required`);
  }
  return value.trim().normalize("NFC");
}

function requireIdentifier(value, label) {
  const identifier = requireString(value, label);
  if (!IDENTIFIER_PATTERN.test(identifier)) {
    throw new Error(`${label} is not a snapshot identifier`);
  }
  return identifier;
}

function bytesToUtf8(bytes, label) {
  if (typeof bytes === "string") {
    return bytes;
  }
  if (bytes instanceof Uint8Array) {
    return new TextDecoder("utf8").decode(Uint8Array.from(bytes));
  }
  throw new Error(`${label} must be UTF-8 bytes or a JSON string`);
}

function parseJsonBytes(bytes, label) {
  const text = bytesToUtf8(bytes, label);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function uniqueIds(values, label) {
  if (new Set(values.map((value) => value.id)).size !== values.length) {
    throw new Error(`${label} contain duplicate ids`);
  }
}

function normalizeClaim(claim) {
  const root = requireObject(claim, "Claim");
  const id = requireIdentifier(root.id, "Claim id");
  const evidenceIds = [...(root.evidenceIds ?? [])]
    .map((evidenceId) => requireIdentifier(evidenceId, "Claim evidence id"))
    .sort(compareString);
  if (evidenceIds.length === 0) {
    throw new Error(`Claim ${id} must reference at least one source`);
  }
  if (new Set(evidenceIds).size !== evidenceIds.length) {
    throw new Error(`Claim ${id} has duplicate evidence ids`);
  }
  const modelState = requireString(root.modelState, "Claim modelState");
  if (!CLAIM_MODEL_STATES.has(modelState)) {
    throw new Error(`Unsupported claim modelState: ${modelState}`);
  }
  return {
    id,
    kind: requireIdentifier(root.kind, "Claim kind"),
    scope: requireString(root.scope, "Claim scope"),
    statement: requireString(root.statement, "Claim statement"),
    modelState,
    evidenceIds,
  };
}

function normalizeSource(source) {
  const root = requireObject(source, "Source");
  const locator = requireString(root.locator, "Source locator");
  return {
    id: requireIdentifier(root.id, "Source id"),
    locator,
  };
}

function normalizeConflict(conflict) {
  const root = requireObject(conflict, "Conflict");
  const id = requireIdentifier(root.id, "Conflict id");
  const claimIds = [...(root.claimIds ?? [])]
    .map((claimId) => requireIdentifier(claimId, "Conflict claim id"))
    .sort(compareString);
  if (claimIds.length < 2) {
    throw new Error(`Conflict ${id} must reference at least two claims`);
  }
  if (new Set(claimIds).size !== claimIds.length) {
    throw new Error(`Conflict ${id} has duplicate claim ids`);
  }
  return {
    id,
    claimIds,
    ...(root.classification === undefined
      ? {}
      : { classification: normalizeConflictClassification(root.classification) }),
  };
}

function normalizeConflictClassification(classification) {
  const root = requireObject(classification, "Conflict classification");
  const keys = Object.keys(root);
  if (
    keys.length !== CONFLICT_CLASSIFICATION_KEYS.size ||
    keys.some((key) => !CONFLICT_CLASSIFICATION_KEYS.has(key))
  ) {
    throw new Error("Conflict classification must use the closed v1 fields");
  }
  const impact = requireString(root.impact, "Conflict impact");
  if (!CONFLICT_IMPACTS.has(impact)) {
    throw new Error(`Unsupported conflict impact: ${impact}`);
  }
  const impactBasisSha256 = requireString(
    root.impactBasisSha256,
    "Conflict impact basis digest",
  );
  if (!SHA256_PATTERN.test(impactBasisSha256)) {
    throw new Error("Conflict impact basis digest must be sha256");
  }
  if (!Array.isArray(root.blockingDocumentationPaths)) {
    throw new Error("Conflict blocking documentation paths must be an array");
  }
  const blockingDocumentationPaths = root.blockingDocumentationPaths
    .map((value) => requireString(value, "Conflict blocking documentation path"))
    .sort(compareString);
  if (
    blockingDocumentationPaths.some((value) => !DOCUMENTATION_PATH_PATTERN.test(value))
  ) {
    throw new Error("Conflict blocking documentation path is unsafe");
  }
  if (new Set(blockingDocumentationPaths).size !== blockingDocumentationPaths.length) {
    throw new Error("Conflict has duplicate blocking documentation paths");
  }
  if (
    (impact === "advisory" && blockingDocumentationPaths.length !== 0) ||
    (impact === "load-bearing" && blockingDocumentationPaths.length === 0)
  ) {
    throw new Error("Conflict impact and blocking documentation paths disagree");
  }
  const resolutionOwner = requireIdentifier(
    root.resolutionOwner,
    "Conflict resolution owner",
  );
  if (root.authorityKind !== ACCOUNTABLE_AUTHORITY) {
    throw new Error("Conflict classification authority must be product-decision-owner");
  }
  const normalized = {
    impact,
    impactBasisSha256,
    blockingDocumentationPaths,
    resolutionOwner,
    authorityKind: ACCOUNTABLE_AUTHORITY,
  };
  if (CREDENTIAL_MATERIAL.test(JSON.stringify(normalized))) {
    throw new Error("Conflict classification contains credential material");
  }
  return normalized;
}

function snapshotEnvelope(body) {
  const claims = [...body.claims].map(normalizeClaim).sort(compareId);
  const sources = [...body.sources].map(normalizeSource).sort(compareId);
  const conflicts = [...(body.conflicts ?? [])]
    .map(normalizeConflict)
    .sort(compareId);
  uniqueIds(claims, "Claims");
  uniqueIds(sources, "Sources");
  uniqueIds(conflicts, "Conflicts");
  if (claims.length === 0 || sources.length === 0) {
    throw new Error("Snapshot requires at least one claim and one source");
  }
  const sourceIds = new Set(sources.map((source) => source.id));
  const claimIds = new Set(claims.map((claim) => claim.id));
  for (const claim of claims) {
    if (claim.evidenceIds.some((evidenceId) => !sourceIds.has(evidenceId))) {
      throw new Error(`Claim ${claim.id} references an unknown source`);
    }
  }
  const claimedBy = new Map();
  for (const conflict of conflicts) {
    if (conflict.claimIds.some((claimId) => !claimIds.has(claimId))) {
      throw new Error(`Conflict ${conflict.id} references an unknown claim`);
    }
    for (const claimId of conflict.claimIds) {
      const prior = claimedBy.get(claimId);
      if (prior !== undefined && prior !== conflict.id) {
        throw new Error(`Claim ${claimId} belongs to more than one conflict`);
      }
      claimedBy.set(claimId, conflict.id);
    }
  }
  const status = requireString(body.status, "Snapshot status");
  if (!SNAPSHOT_STATUSES.has(status)) {
    throw new Error(`Unsupported snapshot status: ${status}`);
  }
  if (
    typeof body.streamVersion !== "number" ||
    !Number.isSafeInteger(body.streamVersion) ||
    body.streamVersion < 0
  ) {
    throw new Error("Snapshot streamVersion must be a non-negative integer");
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    kind: SNAPSHOT_KIND,
    projectId: requireIdentifier(body.projectId, "projectId"),
    modelVersionId: requireIdentifier(body.modelVersionId, "modelVersionId"),
    streamVersion: body.streamVersion,
    status,
    claims,
    sources,
    conflicts,
  };
}

export function sealKnowledgeAcceptedSnapshot(body) {
  const envelope = snapshotEnvelope(body);
  return {
    ...envelope,
    snapshotSha256: canonicalDigest(envelope),
  };
}

export function decodeKnowledgeAcceptedSnapshot(bytes) {
  const parsed = requireObject(
    parseJsonBytes(bytes, "Prior snapshot"),
    "Prior snapshot",
  );
  if (parsed.schemaVersion !== SCHEMA_VERSION || parsed.kind !== SNAPSHOT_KIND) {
    throw new Error("Prior snapshot must be knowledge-accepted-snapshot v1");
  }
  const { snapshotSha256: _digest, ...body } = parsed;
  const sealed = sealKnowledgeAcceptedSnapshot(body);
  if (canonicalDigest(parsed) !== canonicalDigest(sealed)) {
    throw new Error("Prior snapshot digest mismatch");
  }
  return sealed;
}

export function decodeAttributedAnswer(value) {
  const parsed =
    typeof value === "string" || value instanceof Uint8Array
      ? parseJsonBytes(value, "Attributed answer")
      : value;
  const root = requireObject(parsed, "Attributed answer");
  if (root.schemaVersion !== SCHEMA_VERSION || root.kind !== ANSWER_KIND) {
    throw new Error("Attributed answer must be knowledge-attributed-answer v1");
  }
  const authority = requireString(root.authority, "Attributed answer authority");
  if (authority !== ACCOUNTABLE_AUTHORITY) {
    throw new Error(
      "Attributed answer requires product-decision-owner authority",
    );
  }
  const winningClaimId =
    root.winningClaimId === undefined || root.winningClaimId === null
      ? undefined
      : requireIdentifier(root.winningClaimId, "winningClaimId");
  return {
    schemaVersion: SCHEMA_VERSION,
    kind: ANSWER_KIND,
    actor: requireString(root.actor, "Attributed answer actor"),
    authority,
    token: requireIdentifier(root.token, "Attributed answer token"),
    statement: requireString(root.statement, "Attributed answer statement"),
    ...(winningClaimId ? { winningClaimId } : {}),
  };
}

function nextNumericId(current) {
  const match = /^(.*?)(\d+)$/u.exec(current);
  if (!match) {
    const fallback = `${current}-2`;
    return requireIdentifier(fallback, "modelVersionId");
  }
  const next = Number.parseInt(match[2], 10) + 1;
  if (!Number.isSafeInteger(next) || next < 1) {
    throw new Error("Cannot allocate a new modelVersionId");
  }
  const candidate = `${match[1]}${String(next).padStart(match[2].length, "0")}`;
  return requireIdentifier(candidate, "modelVersionId");
}

function allocateSourceId(sources) {
  const taken = new Set(sources.map((source) => source.id));
  for (let index = 1; index < 10_000; index += 1) {
    const candidate = `SRC-ANS-${String(index).padStart(3, "0")}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
  throw new Error("Cannot allocate an attributed-answer source id");
}

function claimNeedsInput(claim, conflicts) {
  if (NEEDS_INPUT_CLAIM_STATES.has(claim.modelState)) {
    return true;
  }
  return conflicts.some((conflict) => conflict.claimIds.includes(claim.id));
}

function snapshotNeedsInput(snapshot) {
  return (
    snapshot.conflicts.length > 0 ||
    snapshot.claims.some((claim) =>
      NEEDS_INPUT_CLAIM_STATES.has(claim.modelState),
    )
  );
}

function resolveAnsweredClaim(snapshot, answer) {
  const conflict = snapshot.conflicts.find(
    (item) => item.id === answer.token,
  );
  if (conflict) {
    const winningClaimId = answer.winningClaimId;
    if (!winningClaimId) {
      throw new Error("Conflict token requires winningClaimId");
    }
    if (!conflict.claimIds.includes(winningClaimId)) {
      throw new Error("winningClaimId is not in the answered conflict");
    }
    return { answeredClaimId: winningClaimId, resolvedConflictId: conflict.id };
  }

  const claim = snapshot.claims.find((item) => item.id === answer.token);
  if (!claim) {
    throw new Error(`Unknown answered token: ${answer.token}`);
  }
  if (
    answer.winningClaimId !== undefined &&
    answer.winningClaimId !== claim.id
  ) {
    throw new Error("winningClaimId must match the answered claim token");
  }
  const enclosing = snapshot.conflicts.find((item) =>
    item.claimIds.includes(claim.id),
  );
  if (!claimNeedsInput(claim, snapshot.conflicts)) {
    throw new Error(`Claim ${claim.id} does not need input`);
  }
  return {
    answeredClaimId: claim.id,
    resolvedConflictId: enclosing?.id,
  };
}

/**
 * @param {string | Uint8Array} priorSnapshotBytes
 * @param {string | Uint8Array | object} attributedAnswer
 */
export function emitAttributedSnapshot(priorSnapshotBytes, attributedAnswer) {
  const prior = decodeKnowledgeAcceptedSnapshot(priorSnapshotBytes);
  const answer = decodeAttributedAnswer(attributedAnswer);
  if (!snapshotNeedsInput(prior)) {
    throw new Error("Prior snapshot does not need input");
  }

  const { answeredClaimId, resolvedConflictId } = resolveAnsweredClaim(
    prior,
    answer,
  );
  const evidenceId = allocateSourceId(prior.sources);
  const sources = [
    ...prior.sources.map((source) => ({ ...source })),
    {
      id: evidenceId,
      locator: `attributed-answer:${answer.authority}:${answer.actor}`,
    },
  ];
  const claims = prior.claims.map((claim) => {
    const copy = { ...claim, evidenceIds: [...claim.evidenceIds] };
    if (
      resolvedConflictId &&
      prior.conflicts
        .find((conflict) => conflict.id === resolvedConflictId)
        ?.claimIds.includes(claim.id) &&
      claim.id !== answeredClaimId
    ) {
      copy.modelState = SUPERSEDED_MODEL_STATE;
      return copy;
    }
    if (claim.id !== answeredClaimId) {
      return copy;
    }
    copy.statement = answer.statement;
    copy.modelState = RESOLVED_MODEL_STATE;
    if (!copy.evidenceIds.includes(evidenceId)) {
      copy.evidenceIds = [...copy.evidenceIds, evidenceId];
    }
    return copy;
  });
  const conflicts = prior.conflicts.filter(
    (conflict) => conflict.id !== resolvedConflictId,
  );
  const snapshot = sealKnowledgeAcceptedSnapshot({
    projectId: prior.projectId,
    modelVersionId: nextNumericId(prior.modelVersionId),
    streamVersion: prior.streamVersion + 1,
    status: prior.status,
    claims,
    sources,
    conflicts,
  });
  return {
    snapshot,
    priorSnapshotSha256: prior.snapshotSha256,
    answeredClaimId,
  };
}
