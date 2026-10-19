// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { formatLimitObservation, limit, type ResolvedLimit } from "../../config/limits.js";
import {
  TECHNICAL_CORRECTION_BYTE_BOUNDS,
  rejectTechnicalCorrection,
  rejectTechnicalCorrectionHostBound,
  type TechnicalCorrectionByteBound,
} from "../review-response.js";
import { degradeJudgmentCoverage } from "../judgment-coverage.js";
import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../../json-evidence.js";
import type { SourceObligationLedgerV2 } from "./types.js";

/**
 * Who built a technical-correction value a byte bound checks, and the scope it
 * covers. `hostFillsCoverage` is the review policy that writes an unverified
 * coverage entry for every target page a reply leaves out.
 */
export interface TechnicalCorrectionByteBoundScope {
  readonly origin: "host" | "reply";
  readonly hostFillsCoverage: boolean;
  readonly targetPaths: readonly string[];
  readonly obligationCount: number;
}

export function byteBoundScope(
  ledger: SourceObligationLedgerV2,
  targetPaths: readonly string[],
  origin: TechnicalCorrectionByteBoundScope["origin"],
  options: { readonly hostFillsCoverage?: boolean } = {},
): TechnicalCorrectionByteBoundScope {
  return {
    origin,
    hostFillsCoverage: options.hostFillsCoverage ?? false,
    targetPaths,
    obligationCount: ledger.dimensions.reduce(
      (total, dimension) => total + dimension.obligations.length,
      0,
    ),
  };
}

export function canonicalJsonBytes(value: unknown): number {
  return new TextEncoder().encode(canonicalizeJsonEvidence(value as JsonEvidenceValue).trimEnd())
    .byteLength;
}

/**
 * Canonical JSON bytes of the coverage the host writes when a reply covers none
 * of `targetPaths`. Every technical-correction proposal of a review that fills
 * coverage carries at least one entry per target page, and the all-host floor
 * carries exactly these, so this is a lower bound on the floor's proposal, its
 * derived result, and its evidence.
 */
export function hostFilledCoverageBytes(targetPaths: readonly string[]): number {
  return canonicalJsonBytes(degradeJudgmentCoverage([], [...new Set(targetPaths)]).coverage);
}

/**
 * Refuse a review whose host-filled coverage alone exceeds
 * `technicalCorrection.proposalMaxBytes`, before any model call. Its judgment
 * steps could not fall back to the all-host floor, which carries exactly that
 * coverage. Throws the limit's own refusal.
 */
export function assertReviewScopeFitsProposalBound(targetPaths: readonly string[]): void {
  const resolved = limit(TECHNICAL_CORRECTION_BYTE_BOUNDS.proposal.limit);
  const pages = new Set(targetPaths).size;
  const bytes = hostFilledCoverageBytes(targetPaths);
  if (bytes <= resolved.value) return;
  throw new ReviewScopeBoundError(
    resolved,
    bytes,
    `Scope: ${pages} target pages. Observed is the host-filled coverage alone, which every technical-correction proposal for this scope carries, measured before any model call.`,
  );
}

/** A review scope refused at run start; `code` is the limit's catalog refusal. */
export class ReviewScopeBoundError extends Error {
  public readonly code: string;
  public readonly limitName: string;
  public readonly configured: number;
  public readonly observed: number;

  public constructor(resolved: ResolvedLimit, observed: number, scope: string) {
    super(`${formatLimitObservation(resolved, observed)} ${scope}`);
    this.code = resolved.refusal;
    this.limitName = resolved.name;
    this.configured = resolved.value;
    this.observed = observed;
  }
}

/**
 * Refuse `value` over its byte bound with the bound, the observed bytes, and
 * the scope named. Terminal when the host built the value, or when the scope's
 * host-filled coverage alone is over the bound, so the step's floor cannot fit
 * either: the scope must narrow. Otherwise the reply's own text pushed it
 * over, and a re-ask asks the model to condense it.
 */
export function assertCanonicalJsonByteBound(
  value: unknown,
  bound: TechnicalCorrectionByteBound,
  scope: TechnicalCorrectionByteBoundScope,
): void {
  const resolved = limit(TECHNICAL_CORRECTION_BYTE_BOUNDS[bound].limit);
  const bytes = canonicalJsonBytes(value);
  if (bytes <= resolved.value) return;
  const coverageBytes = scope.hostFillsCoverage ? hostFilledCoverageBytes(scope.targetPaths) : 0;
  const scopeClause = `Scope: ${new Set(scope.targetPaths).size} target pages and ${scope.obligationCount} source obligations${scope.hostFillsCoverage ? `; their host-filled coverage alone is ${coverageBytes} bytes` : ""}.`;
  if (scope.origin === "host" || coverageBytes > resolved.value) {
    rejectTechnicalCorrectionHostBound(
      bound,
      `${formatLimitObservation(resolved, bytes)} ${scopeClause}`,
    );
  }
  rejectTechnicalCorrection(
    "bounds-exceeded",
    `The reply's own text puts it at ${bytes} bytes, over ${resolved.name} = ${resolved.value} ${resolved.unit} (${resolved.refusal}), so a condensed reply can fit. ${scopeClause}`,
  );
}
