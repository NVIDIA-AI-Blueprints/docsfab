// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { parseJsonEvidence } from "../json-evidence.js";
import { verifyBoundedDocImprovementWriteResult } from "../doc-improvement.js";
import { validateIaPlanReviewerPolicy } from "../ia/plan-review.js";
import { parseScorecardRunRecord } from "../scorecard-record.js";
import { getWorkflow } from "../workflow-registry/catalog.js";
import type { WorkflowOutcomeDecodeOptionsV1 } from "../workflow-contracts/outcome.js";
import {
  finalizeDeliveryAcceptanceChainBinding,
  type DeliveryAcceptanceChainBindingV1,
  type DeliveryAcceptanceRunBindingV1,
} from "./acceptance-manifest.js";
import { sha256 } from "../content-ir/canonical.js";

const REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const MAXIMUM_JSON_LEAF_BYTES = 4 * 1024 * 1024;

export interface DeliveryAcceptanceChainEvidence {
  testedRevision: string;
  readinessRecordBytes: Uint8Array;
  declarationBytes: Uint8Array;
  analysisRecordBytes: Uint8Array;
  authorizationBytes: Uint8Array;
  reviewerPolicyBytes: Uint8Array;
  applicationRecordBytes: Uint8Array;
  patchBytes: Uint8Array;
}

/**
 * Build the sanitized delivery chain only after verifying every private leaf.
 * The returned hashes are summaries of authenticated evidence, never evidence
 * supplied independently by a caller.
 */
export function assembleVerifiedDeliveryAcceptanceChain(
  evidence: DeliveryAcceptanceChainEvidence,
  editorialDecodeOptions: WorkflowOutcomeDecodeOptionsV1 = {},
): DeliveryAcceptanceChainBindingV1 {
  if (!REVISION.test(evidence.testedRevision)) invalid();
  const readinessValue = json(evidence.readinessRecordBytes);
  const declarationValue = json(evidence.declarationBytes);
  const analysisValue = json(evidence.analysisRecordBytes);
  const authorizationValue = json(evidence.authorizationBytes);
  const reviewerPolicy = validateIaPlanReviewerPolicy(json(evidence.reviewerPolicyBytes));
  const applicationValue = json(evidence.applicationRecordBytes);
  const readiness = parseScorecardRunRecord(readinessValue);
  const verified = verifyBoundedDocImprovementWriteResult({
    declaration: declarationValue,
    declarationBytes: evidence.declarationBytes,
    analysisRecord: analysisValue,
    analysisRecordBytes: evidence.analysisRecordBytes,
    authorization: authorizationValue,
    authorizationBytes: evidence.authorizationBytes,
    applicationRecord: applicationValue,
    applicationRecordBytes: evidence.applicationRecordBytes,
    patchBytes: evidence.patchBytes,
    reviewerPolicy,
    editorialDecodeOptions,
  });
  const sourceRevision = verified.declaration.testedCommit;
  if (
    readiness.status !== "succeeded" ||
    readiness.workflow !== "readiness" ||
    readiness.repository.revision !== sourceRevision ||
    sha256(readiness.repository.sourcePath) !== verified.declaration.repositoryIdentitySha256 ||
    readiness.changes !== undefined ||
    readiness.task !== undefined
  ) {
    invalid();
  }
  const readinessBinding: DeliveryAcceptanceRunBindingV1 = {
    id: readiness.id,
    recordSha256: sha256(evidence.readinessRecordBytes),
    workflow: "readiness",
    status: "succeeded",
    outcome: getWorkflow("readiness").outcome,
    changedPaths: [],
  };
  const auditBinding: DeliveryAcceptanceRunBindingV1 = {
    id: verified.analysis.id,
    recordSha256: verified.analysis.recordSha256,
    workflow: "review-documentation",
    status: "succeeded",
    outcome: getWorkflow("review-documentation").outcome,
    changedPaths: [],
  };
  const writeBinding: DeliveryAcceptanceRunBindingV1 = {
    id: verified.application.id,
    recordSha256: verified.application.recordSha256,
    workflow: "update-documentation",
    status: "succeeded",
    outcome: getWorkflow("update-documentation").outcome,
    changedPaths: [...verified.patch.changedPaths],
  };
  return finalizeDeliveryAcceptanceChainBinding({
    schemaVersion: 1,
    kind: "docsfab-delivery-acceptance-chain-binding",
    testedRevision: evidence.testedRevision,
    sourceRevision,
    readiness: readinessBinding,
    audit: auditBinding,
    write: writeBinding,
    selection: {
      gapId: verified.declaration.gap.id,
      evidenceSha256: verified.authorization.gap.evidenceSha256,
      successCriterionSha256: verified.authorization.gap.successCriterionSha256,
      intendedPaths: [...verified.authorization.intendedPaths],
      approvedOutcomeSha256: verified.authorization.approvedOutcomeSha256,
    },
    authorization: {
      sha256: sha256(evidence.authorizationBytes),
      digest: verified.authorization.digest,
      decision: "approved",
      reviewerId: verified.authorization.reviewer.id,
      policyDigest: verified.authorization.policy.digest,
      decidedAt: verified.authorization.decidedAt,
      expiresAt: verified.authorization.expiresAt,
    },
    patch: {
      sha256: verified.patch.sha256,
      byteLength: verified.patch.byteLength,
      lineCount: verified.patch.lineCount,
      changedPaths: [...verified.patch.changedPaths],
    },
  });
}

function json(bytes: Uint8Array): unknown {
  if (bytes.byteLength < 2 || bytes.byteLength > MAXIMUM_JSON_LEAF_BYTES) invalid();
  try {
    return parseJsonEvidence(bytes);
  } catch {
    invalid();
  }
}

function invalid(): never {
  throw new Error("Delivery acceptance chain evidence is invalid.");
}
