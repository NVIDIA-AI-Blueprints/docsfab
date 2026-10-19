// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Reader-side contract for per-run source citation evidence on the run record.
 * It defines and validates the shape; the runner produces it.
 */
import { createContractKit } from "../contract-kit/index.js";

export const SOURCE_RUN_CITATIONS_KIND = "docsfab-source-run-citations" as const;

export type SourceRunCitationsErrorCode = "invalid-shape" | "invalid-value" | "duplicate-step";

export class SourceRunCitationsError extends Error {
  public constructor(public readonly code: SourceRunCitationsErrorCode) {
    super(`Source run citations rejected: ${code}.`);
    this.name = "SourceRunCitationsError";
  }
}

function fail(code: SourceRunCitationsErrorCode): never {
  throw new SourceRunCitationsError(code);
}

const { assertInert, rejectCredentials, object, exact, hash, array, identifier, string, compare } =
  createContractKit<SourceRunCitationsErrorCode>({
    fail,
    codes: {
      invalidShape: "invalid-shape",
      invalidValue: "invalid-value",
      digestMismatch: "invalid-value",
      credentialMaterial: "invalid-value",
      schemaMismatch: "invalid-shape",
    },
  });

/**
 * One sealed span citation. Its `stepId` names the step whose recorded read
 * carries the citation, which need not be the enclosing
 * `SourceRunCitationStepV1.stepId` (the write step whose claims were judged).
 */
export interface SourceRunSpanCitationV1 {
  readonly schemaVersion: 1;
  readonly kind: "docsfab-source-span-citation";
  readonly bindingSha256: string;
  readonly observationId: string;
  readonly representationId: string;
  readonly representationSha256: string;
  readonly stepId: string;
  readonly spanIds: readonly string[];
  readonly spanAccessSha256s: readonly string[];
  readonly supportedClaimSha256: string;
  readonly externalInputCitationSha256: string;
  readonly spanCitationSha256: string;
}

/**
 * A sentence the write step added to documentation with no accepted citation of
 * its own, named by location and digest, never by its text.
 */
export interface SourceRunUncitedClaimV1 {
  /** Repository-relative path of the written page. */
  readonly path: string;
  /** 1-based line of that page where the sentence starts. */
  readonly line: number;
  readonly claimSha256: string;
}

/** One gated write step: the claims it added, what carried them, and what did not. */
export interface SourceRunCitationStepV1 {
  /** The write step whose material claims were judged. */
  readonly stepId: string;
  readonly materialClaimSha256s: readonly string[];
  readonly citations: readonly SourceRunSpanCitationV1[];
  /** Present only when some added claim has no citation; ordered by path and line. */
  readonly uncitedClaims?: readonly SourceRunUncitedClaimV1[];
}

export interface SourceRunCitationsV1 {
  readonly schemaVersion: 1;
  readonly kind: typeof SOURCE_RUN_CITATIONS_KIND;
  readonly bindingSha256: string;
  readonly steps: readonly SourceRunCitationStepV1[];
}

const CITATION_KEYS = [
  "schemaVersion",
  "kind",
  "bindingSha256",
  "observationId",
  "representationId",
  "representationSha256",
  "stepId",
  "spanIds",
  "spanAccessSha256s",
  "supportedClaimSha256",
  "externalInputCitationSha256",
  "spanCitationSha256",
];

function decodeCitation(value: unknown): SourceRunSpanCitationV1 {
  const root = object(value);
  exact(root, CITATION_KEYS);
  if (root.schemaVersion !== 1 || root.kind !== "docsfab-source-span-citation") {
    fail("invalid-shape");
  }
  const spanIds = array(root.spanIds).map((entry) => identifier(entry));
  const spanAccessSha256s = array(root.spanAccessSha256s).map((entry) => hash(entry));
  if (spanIds.length === 0 || spanAccessSha256s.length === 0) fail("invalid-value");
  return Object.freeze({
    schemaVersion: 1 as const,
    kind: "docsfab-source-span-citation" as const,
    bindingSha256: hash(root.bindingSha256),
    observationId: identifier(root.observationId),
    representationId: identifier(root.representationId),
    representationSha256: hash(root.representationSha256),
    stepId: identifier(root.stepId),
    spanIds: Object.freeze([...spanIds]),
    spanAccessSha256s: Object.freeze([...spanAccessSha256s]),
    supportedClaimSha256: hash(root.supportedClaimSha256),
    externalInputCitationSha256: hash(root.externalInputCitationSha256),
    spanCitationSha256: hash(root.spanCitationSha256),
  });
}

function decodeUncitedClaim(value: unknown): SourceRunUncitedClaimV1 {
  const root = object(value);
  exact(root, ["path", "line", "claimSha256"]);
  const path = string(root.path);
  // A repository-relative path: no root, drive, backslash, or empty, `.` or `..` segment.
  if (
    path.startsWith("/") ||
    /^[A-Za-z]:/u.test(path) ||
    path.includes("\\") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    fail("invalid-value");
  }
  if (!Number.isSafeInteger(root.line) || (root.line as number) < 1) fail("invalid-value");
  return Object.freeze({
    path,
    line: root.line as number,
    claimSha256: hash(root.claimSha256),
  });
}

/**
 * Strict about shape, silent about semantics: coverage is decided where it is
 * produced, against the sealed binding and access ledger, because a record
 * cannot prove itself. A step id appears at most once.
 */
export function decodeSourceRunCitations(value: unknown): SourceRunCitationsV1 {
  assertInert(value);
  rejectCredentials(value);
  const root = object(value);
  exact(root, ["schemaVersion", "kind", "bindingSha256", "steps"]);
  if (root.schemaVersion !== 1 || root.kind !== SOURCE_RUN_CITATIONS_KIND) fail("invalid-shape");
  const bindingSha256 = hash(root.bindingSha256);
  const seen = new Set<string>();
  const steps = array(root.steps).map((entry) => {
    const step = object(entry);
    exact(
      step,
      ["stepId", "materialClaimSha256s", "citations", "uncitedClaims"],
      ["uncitedClaims"],
    );
    const stepId = identifier(step.stepId);
    if (seen.has(stepId)) fail("duplicate-step");
    seen.add(stepId);
    const materialClaimSha256s = array(step.materialClaimSha256s).map((claim) => hash(claim));
    const sorted = [...materialClaimSha256s].sort(compare);
    if (materialClaimSha256s.some((claim, index) => claim !== sorted[index])) fail("invalid-value");
    if (new Set(materialClaimSha256s).size !== materialClaimSha256s.length) fail("invalid-value");
    const citations = array(step.citations).map((citation) => decodeCitation(citation));
    if (citations.some((citation) => citation.bindingSha256 !== bindingSha256)) {
      fail("invalid-value");
    }
    const uncitedClaims =
      step.uncitedClaims === undefined
        ? undefined
        : array(step.uncitedClaims).map((claim) => decodeUncitedClaim(claim));
    return Object.freeze({
      stepId,
      materialClaimSha256s: Object.freeze(materialClaimSha256s),
      citations: Object.freeze(citations),
      ...(uncitedClaims === undefined ? {} : { uncitedClaims: Object.freeze(uncitedClaims) }),
    });
  });
  return Object.freeze({
    schemaVersion: 1 as const,
    kind: SOURCE_RUN_CITATIONS_KIND,
    bindingSha256,
    steps: Object.freeze(steps),
  });
}
