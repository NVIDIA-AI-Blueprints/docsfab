// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The inner reason terminal editorial finalization refused a run whose steps
 * all succeeded (`RunRecord.editorialFinalizationRejection`).
 *
 * - `code` is `editorial-finalization-<contract>-<error code>`, read from the
 *   refusing contract's closed error code, never from message text. The
 *   contract is `branch-coverage` (the selected path's coverage), `host` (the
 *   editorial evidence host), or `decision` (the final editorial decision).
 *   Any other error is `editorial-finalization-uncoded-error`.
 * - `location` is the `$`-rooted decision member the refusing rule read when
 *   the decision contract names one, such as
 *   `$.evidenceRefs[].producers[].assessment`; otherwise `$`. Array members
 *   are `[]`, never an index.
 *
 * Nothing here copies error, model, or validator text.
 */

import type { EditorialDecisionValidationErrorCode } from "../artifacts/editorial-decision.js";
import { INFERENCE_REJECTION_LOCATION_GRAMMAR } from "../config/inference-rejection-limits.js";
import type { WorkflowBranchCoverageErrorCode } from "../workflow-contracts/branch-coverage.js";
import type { EditorialEvidenceHostErrorCode } from "./editorial-evidence-host.js";

/** Each refusing contract's closed error codes, held exhaustive below. */
export const EDITORIAL_FINALIZATION_CONTRACT_CODES = Object.freeze({
  "branch-coverage": Object.freeze([
    "invalid-shape",
    "invalid-value",
    "credential-material",
    "digest-mismatch",
    "manifest-mismatch",
    "coverage-unverified",
  ] as const satisfies readonly WorkflowBranchCoverageErrorCode[]),
  host: Object.freeze([
    "invalid-shape",
    "invalid-value",
    "credential-material",
    "evidence-unavailable",
    "identity-mismatch",
    "producer-mismatch",
    "conflicting-assessment",
  ] as const satisfies readonly EditorialEvidenceHostErrorCode[]),
  decision: Object.freeze([
    "invalid-shape",
    "invalid-value",
    "credential-material",
    "digest-mismatch",
    "evidence-unavailable",
    "producer-mismatch",
    "identity-mismatch",
    "independent-rejection",
  ] as const satisfies readonly EditorialDecisionValidationErrorCode[]),
});

type ContractCodes = typeof EDITORIAL_FINALIZATION_CONTRACT_CODES;
export type EditorialFinalizationContract = keyof ContractCodes;

// A code added to one of these error classes does not typecheck until it is listed.
const contractCodesExhaustive: [
  Exclude<WorkflowBranchCoverageErrorCode, ContractCodes["branch-coverage"][number]>,
  Exclude<EditorialEvidenceHostErrorCode, ContractCodes["host"][number]>,
  Exclude<EditorialDecisionValidationErrorCode, ContractCodes["decision"][number]>,
] extends [never, never, never]
  ? true
  : false = true;
void contractCodesExhaustive;

const PREFIX = "editorial-finalization-";

const EDITORIAL_FINALIZATION_UNCODED_CODE = "editorial-finalization-uncoded-error";

/** At finalization, the host found the evaluator's rationale repeats the planner's. */
export const EDITORIAL_FINALIZATION_CONFLICTING_ASSESSMENT_CODE =
  "editorial-finalization-host-conflicting-assessment" satisfies EditorialFinalizationRejectionCode;

const EDITORIAL_FINALIZATION_ROOT_LOCATION = "$";

export type EditorialFinalizationRejectionCode =
  | {
      [Contract in EditorialFinalizationContract]: `${typeof PREFIX}${Contract}-${ContractCodes[Contract][number]}`;
    }[EditorialFinalizationContract]
  | typeof EDITORIAL_FINALIZATION_UNCODED_CODE;

/** Enumerated once so the class table and tests can hold it closed. */
export const EDITORIAL_FINALIZATION_REJECTION_CODES: readonly EditorialFinalizationRejectionCode[] =
  Object.freeze([
    ...(
      Object.keys(EDITORIAL_FINALIZATION_CONTRACT_CODES) as EditorialFinalizationContract[]
    ).flatMap((contract) =>
      EDITORIAL_FINALIZATION_CONTRACT_CODES[contract].map(
        (code) => `${PREFIX}${contract}-${code}` as EditorialFinalizationRejectionCode,
      ),
    ),
    EDITORIAL_FINALIZATION_UNCODED_CODE,
  ]);

/** Recorded on a failed run beside `failure` (`RunRecord.editorialFinalizationRejection`). */
export interface EditorialFinalizationRejectionV1 {
  readonly code: EditorialFinalizationRejectionCode;
  readonly location: string;
}

/** The inner reason of an error no contract coded. */
export const EDITORIAL_FINALIZATION_UNCODED: EditorialFinalizationRejectionV1 = Object.freeze({
  code: EDITORIAL_FINALIZATION_UNCODED_CODE,
  location: EDITORIAL_FINALIZATION_ROOT_LOCATION,
});

/**
 * The inner reason for one contract's closed code. A code outside that
 * contract's list reads as uncoded, and a location outside the retained
 * grammar reads as `$`, never as a copied string. Never throws.
 */
export function editorialFinalizationRejection(
  contract: EditorialFinalizationContract,
  code: unknown,
  location: unknown = EDITORIAL_FINALIZATION_ROOT_LOCATION,
): EditorialFinalizationRejectionV1 {
  const codes: readonly string[] = EDITORIAL_FINALIZATION_CONTRACT_CODES[contract];
  if (typeof code !== "string" || !codes.includes(code)) return EDITORIAL_FINALIZATION_UNCODED;
  return Object.freeze({
    code: `${PREFIX}${contract}-${code}` as EditorialFinalizationRejectionCode,
    location:
      typeof location === "string" && INFERENCE_REJECTION_LOCATION_GRAMMAR.test(location)
        ? location
        : EDITORIAL_FINALIZATION_ROOT_LOCATION,
  });
}

/** Strictly read a recorded inner reason; anything else reads as `null`. */
export function readEditorialFinalizationRejection(
  value: unknown,
): EditorialFinalizationRejectionV1 | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== "code" || keys[1] !== "location") return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.code !== "string" ||
    !(EDITORIAL_FINALIZATION_REJECTION_CODES as readonly string[]).includes(candidate.code) ||
    typeof candidate.location !== "string" ||
    !INFERENCE_REJECTION_LOCATION_GRAMMAR.test(candidate.location)
  ) {
    return null;
  }
  return Object.freeze({
    code: candidate.code as EditorialFinalizationRejectionCode,
    location: candidate.location,
  });
}
