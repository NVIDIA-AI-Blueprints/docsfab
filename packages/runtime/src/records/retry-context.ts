// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createContractKit, type ContractFail } from "../contract-kit/index.js";
import { READER_CONTEXT_SOURCE_ROLES } from "../context/reader-context.js";

/** Minimal CLI input needed to reconstruct a safe retry command. */
export interface CliRunRetryContextV1 {
  readonly schemaVersion: 1;
  readonly reconstructable: boolean;
  readonly instructionPresent: boolean;
  readonly deliveryMode:
    | "read-only"
    | "dry-run"
    | "patch-only"
    | "draft-mr"
    | "comment-mr"
    | "write-only";
  readonly allowWrite: boolean;
  readonly writeGrantExplicit: boolean;
  readonly releaseGate: boolean;
  readonly study?: boolean;
  readonly compositionId?: string;
  readonly experimentalAnswerRecords?: true;
  readonly contextTarget?: import("../context/contracts.js").ContextPreflightTarget;
  readonly docImprovementCampaignPath?: string;
  readonly docImprovementReviewerPolicyPath?: string;
  readonly canonSnapshotPath?: string;
  readonly acceptCandidateSnapshot?: boolean;
  readonly canonSnapshotAuthorityId?: string;
  readonly commentMrCanonSha256?: string;
  /** Present only when the operator explicitly selected a revision. */
  readonly revision?: string;
  /** Present only for an explicitly selected draft-MR remote. */
  readonly remoteName?: string;
  readonly commentMr?: string;
  readonly comparisonRequest?: import("../search/change-impact.js").ReaderComparisonRequestV1;
  readonly readerSources?: import("../execution/reader-task-admission.js").ReaderSourceHintV1[];
  readonly sourcePaths?: string[];
}

class InvalidCliRunRetryContextError extends Error {}
const fail: ContractFail<"invalid"> = () => {
  throw new InvalidCliRunRetryContextError(
    "The saved CLI retry context does not match its record contract.",
  );
};
const kit = createContractKit<"invalid">({
  fail,
  inertMode: "strict",
  codes: {
    invalidShape: "invalid",
    invalidValue: "invalid",
    digestMismatch: "invalid",
    credentialMaterial: "invalid",
    schemaMismatch: "invalid",
  },
});

/** Closed-shape guard used before any persisted context becomes a command. */
export function isCliRunRetryContextV1(value: unknown): value is CliRunRetryContextV1 {
  try {
    const context = kit.object(value);
    kit.exact(
      context,
      [
        "schemaVersion",
        "reconstructable",
        "instructionPresent",
        "deliveryMode",
        "allowWrite",
        "writeGrantExplicit",
        "releaseGate",
        "study",
        "compositionId",
        "experimentalAnswerRecords",
        "contextTarget",
        "docImprovementCampaignPath",
        "docImprovementReviewerPolicyPath",
        "canonSnapshotPath",
        "acceptCandidateSnapshot",
        "canonSnapshotAuthorityId",
        "commentMrCanonSha256",
        "revision",
        "remoteName",
        "commentMr",
        "comparisonRequest",
        "readerSources",
        "sourcePaths",
      ],
      [
        "study",
        "compositionId",
        "experimentalAnswerRecords",
        "contextTarget",
        "docImprovementCampaignPath",
        "docImprovementReviewerPolicyPath",
        "canonSnapshotPath",
        "acceptCandidateSnapshot",
        "canonSnapshotAuthorityId",
        "commentMrCanonSha256",
        "revision",
        "remoteName",
        "commentMr",
        "comparisonRequest",
        "readerSources",
        "sourcePaths",
      ],
    );
    if (context.schemaVersion !== 1) fail("invalid");
    kit.enumeration(context.deliveryMode, [
      "read-only",
      "dry-run",
      "patch-only",
      "draft-mr",
      "comment-mr",
      "write-only",
    ] as const);
    if (
      typeof context.reconstructable !== "boolean" ||
      typeof context.allowWrite !== "boolean" ||
      typeof context.writeGrantExplicit !== "boolean" ||
      typeof context.instructionPresent !== "boolean"
    )
      fail("invalid");
    if (typeof context.releaseGate !== "boolean") fail("invalid");
    if (
      (["draft-mr", "patch-only", "write-only"].includes(context.deliveryMode as string) &&
        context.allowWrite !== true) ||
      (["read-only", "dry-run"].includes(context.deliveryMode as string) &&
        context.allowWrite !== false)
    ) {
      fail("invalid");
    }
    if (context.study !== undefined && typeof context.study !== "boolean") fail("invalid");
    for (const key of [
      "compositionId",
      "docImprovementCampaignPath",
      "docImprovementReviewerPolicyPath",
      "canonSnapshotPath",
      "canonSnapshotAuthorityId",
      "commentMrCanonSha256",
      "revision",
      "remoteName",
      "commentMr",
    ]) {
      if (context[key] !== undefined) kit.string(context[key]);
    }
    if (
      context.experimentalAnswerRecords !== undefined &&
      context.experimentalAnswerRecords !== true
    )
      fail("invalid");
    if (
      context.acceptCandidateSnapshot !== undefined &&
      typeof context.acceptCandidateSnapshot !== "boolean"
    )
      fail("invalid");
    if (context.contextTarget !== undefined) {
      const target = kit.object(context.contextTarget);
      kit.exact(
        target,
        ["sourcePath", "anchor", "candidateParentPath", "candidateParentAnchor"],
        ["anchor", "candidateParentPath", "candidateParentAnchor"],
      );
      kit.string(target.sourcePath);
      for (const key of ["anchor", "candidateParentPath", "candidateParentAnchor"]) {
        if (target[key] !== undefined) kit.string(target[key]);
      }
    }
    if (context.comparisonRequest !== undefined) {
      const comparison = kit.object(context.comparisonRequest);
      if (comparison.kind === "workspace") {
        kit.exact(comparison, ["kind"]);
      } else {
        kit.exact(comparison, ["kind", "baseRevision", "headRevision"]);
        if (comparison.kind !== "base-head") fail("invalid");
        kit.string(comparison.baseRevision);
        kit.string(comparison.headRevision);
      }
    }
    if (context.readerSources !== undefined) {
      for (const item of kit.array(context.readerSources)) {
        const source = kit.object(item);
        kit.exact(source, ["role", "path"]);
        kit.enumeration(source.role, READER_CONTEXT_SOURCE_ROLES);
        kit.string(source.path);
      }
    }
    if (context.sourcePaths !== undefined) {
      for (const path of kit.array(context.sourcePaths)) kit.string(path);
    }
    return true;
  } catch {
    return false;
  }
}
