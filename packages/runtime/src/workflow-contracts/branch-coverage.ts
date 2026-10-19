// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { validateArtifactReference } from "../artifacts/validate.js";
import { createContractKit, type ContractFail } from "../contract-kit/index.js";
import type { WorkflowBranchCoverageV1, WorkflowManifestV2 } from "./contracts.js";
import { sha256 } from "../content-ir/canonical.js";

export type WorkflowBranchCoverageErrorCode =
  | "invalid-shape"
  | "invalid-value"
  | "credential-material"
  | "digest-mismatch"
  | "manifest-mismatch"
  | "coverage-unverified";

export class WorkflowBranchCoverageError extends Error {
  public constructor(public readonly code: WorkflowBranchCoverageErrorCode) {
    super(`Workflow branch coverage rejected: ${code}.`);
    this.name = "WorkflowBranchCoverageError";
  }
}

function fail(code: WorkflowBranchCoverageErrorCode): never {
  throw new WorkflowBranchCoverageError(code);
}

const kit = createContractKit<WorkflowBranchCoverageErrorCode>({
  fail: fail as ContractFail<WorkflowBranchCoverageErrorCode>,
  inertMode: "strict",
  codes: {
    invalidShape: "invalid-shape",
    invalidValue: "invalid-value",
    digestMismatch: "digest-mismatch",
    credentialMaterial: "credential-material",
    schemaMismatch: "invalid-shape",
  },
});

export interface WorkflowBranchCoverageDecodeOptionsV1 {
  /** Mandatory strict V2 manifest decoder supplied by the runtime-owned registry seam. */
  decodeManifest(value: unknown): WorkflowManifestV2;
  /** Mandatory selected-path reconstruction. No default accepts coverage. */
  validateCoverage(coverage: Readonly<WorkflowBranchCoverageV1>): void;
}

const BODY_KEYS = [
  "workflow",
  "manifest",
  "manifestSha256",
  "repositoryRevision",
  "workspaceSnapshotSha256",
  "selection",
  "requiredStepIds",
  "excludedStepIds",
] as const;

/** Structural seal plus mandatory runtime-owned manifest/path semantic validation. */
export function decodeWorkflowBranchCoverageV1(
  value: unknown,
  options: WorkflowBranchCoverageDecodeOptionsV1,
): WorkflowBranchCoverageV1 {
  if (
    typeof options?.decodeManifest !== "function" ||
    typeof options?.validateCoverage !== "function"
  ) {
    fail("coverage-unverified");
  }
  if (Buffer.byteLength(kit.canonicalJson(value), "utf8") > 128 * 1024) {
    fail("invalid-value");
  }
  const decoded = kit.decodeSealed(
    value,
    "docsfab-workflow-branch-coverage",
    "coverageSha256",
    [...BODY_KEYS],
    (body) => normalizeBody(body, options),
  );
  try {
    options.validateCoverage(decoded);
  } catch (error) {
    if (error instanceof WorkflowBranchCoverageError) throw error;
    fail("coverage-unverified");
  }
  return decoded;
}

function normalizeBody(
  value: unknown,
  options: WorkflowBranchCoverageDecodeOptionsV1,
): Omit<WorkflowBranchCoverageV1, "schemaVersion" | "kind" | "coverageSha256"> {
  const root = kit.object(value);
  kit.exact(root, [...BODY_KEYS]);
  if (root.workflow !== "update-documentation") fail("invalid-value");
  let manifest: WorkflowManifestV2;
  try {
    manifest = options.decodeManifest(root.manifest);
  } catch {
    return fail("manifest-mismatch");
  }
  if (Buffer.byteLength(kit.canonicalJson(manifest), "utf8") > 64 * 1024) {
    fail("invalid-value");
  }
  const manifestSha256 = kit.hash(root.manifestSha256);
  if (sha256(kit.canonicalJson(manifest)) !== manifestSha256) fail("manifest-mismatch");
  const selection = decodeSelection(root.selection);
  const requiredStepIds = orderedStepIds(root.requiredStepIds, true);
  const excludedStepIds = orderedStepIds(root.excludedStepIds, false);
  if (requiredStepIds.some((id) => excludedStepIds.includes(id))) fail("invalid-value");
  return {
    workflow: "update-documentation",
    manifest,
    manifestSha256,
    repositoryRevision: kit.revision(root.repositoryRevision),
    workspaceSnapshotSha256: kit.hash(root.workspaceSnapshotSha256),
    selection,
    requiredStepIds,
    excludedStepIds,
  };
}

function decodeSelection(value: unknown): WorkflowBranchCoverageV1["selection"] {
  if (value === null) return null;
  const root = kit.object(value);
  kit.exact(root, ["branchId", "candidateArtifact"]);
  const candidateArtifact = validateArtifactReference(root.candidateArtifact, {
    expectedKind: "editorial-decision",
  });
  if (candidateArtifact.schemaVersion !== 3) fail("invalid-value");
  return {
    branchId: kit.enumeration(root.branchId, ["author", "assess-no-change"] as const),
    candidateArtifact: candidateArtifact as WorkflowBranchCoverageV1["selection"] extends infer S
      ? S extends { candidateArtifact: infer R }
        ? R
        : never
      : never,
  };
}

function orderedStepIds(value: unknown, requireNonEmpty: boolean): string[] {
  const result = kit.array(value).map((item) => kit.identifier(item));
  if (result.length > 16 || (requireNonEmpty && result.length === 0)) fail("invalid-value");
  kit.unique(result);
  return result;
}
