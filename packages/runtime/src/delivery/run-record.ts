// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { RunRecord } from "../records/contracts.js";
import { type WorkflowDefinition } from "../workflow-contracts/contracts.js";
import { type CompositionExecutionWorkflowIdentity } from "../records/composition-execution.js";
import {
  CONTRACT_CODE,
  INVALID_SHAPE,
  PublicationRunRecordDecodeError,
} from "./run-record/contract.js";
import { TOP_KEYS, decode } from "./run-record/record-decoder.js";
import type { PublicationRunRecordDecodeOptionsV1 } from "./run-record/eligibility.js";
export { PublicationRunRecordDecodeError } from "./run-record/contract.js";
export { assertRunRecordEditorialDeliveryEligible } from "./run-record/eligibility.js";
export type { PublicationRunRecordDecodeOptionsV1 } from "./run-record/eligibility.js";
export { decodeCredentialFindings, isProjectConfigPath } from "./run-record/record-decoder.js";

/** The closed run-record key list this publication gate admits. */
export const PUBLICATION_RUN_RECORD_KEYS: readonly (keyof RunRecord)[] = TOP_KEYS;

/**
 * Decode a schema-v2 terminal record eligible for local-user publication. Only
 * workflows with a write step qualify; read-only workflows never authorize publication.
 */
export function decodeSuccessfulPublicationRunRecord(
  value: unknown,
  options: PublicationRunRecordDecodeOptionsV1 = {},
): RunRecord {
  try {
    return decode(value, null, options);
  } catch (error) {
    throw wrapPublicationDecodeError(error);
  }
}

/** Strict local patch reader; choice attribution grants no publication authority. */
export function decodeSuccessfulCheckoutRunRecord(
  value: unknown,
  options: PublicationRunRecordDecodeOptionsV1 = {},
): RunRecord {
  try {
    return decode(value, null, options, "checkout");
  } catch (error) {
    throw wrapPublicationDecodeError(error);
  }
}

/** Strict terminal read-only REVIEW admission, without publication eligibility. */
export function decodeSuccessfulReviewRunRecord(
  value: unknown,
  options: PublicationRunRecordDecodeOptionsV1 = {},
): RunRecord {
  try {
    return decode(value, null, options, "review");
  } catch (error) {
    throw wrapPublicationDecodeError(error);
  }
}

/**
 * Validate a retained successful record against an authenticated historical
 * workflow snapshot. This read-only adapter grants no execution or publication
 * authority; ordinary publication always uses the current catalog above.
 */
export function decodeSuccessfulPublicationRunRecordSnapshot(
  value: unknown,
  snapshot: {
    readonly workflow: WorkflowDefinition;
    readonly workflowIdentity: CompositionExecutionWorkflowIdentity;
  },
  options: PublicationRunRecordDecodeOptionsV1 = {},
): RunRecord {
  try {
    return decode(value, snapshot, options);
  } catch (error) {
    throw wrapPublicationDecodeError(error);
  }
}

function wrapPublicationDecodeError(error: unknown): never {
  if (error instanceof PublicationRunRecordDecodeError) throw error;
  throw new PublicationRunRecordDecodeError(innerContractCode(error) ?? INVALID_SHAPE, {
    cause: error,
  });
}

function innerContractCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || !("code" in error)) return undefined;
  const code = error.code;
  return typeof code === "string" && CONTRACT_CODE.test(code) ? code : undefined;
}
