// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { createContractKit, type ContractFail, deepFreeze } from "../contract-kit/index.js";
import type { VerifiedQualityPackContext } from "../quality-pack/manifest.js";
import type { QualityProfileSelectionReceiptV1 } from "../records/contracts.js";
import {
  validateRepositoryDiscoveryInventoryAuthority,
  type RepositoryDiscoveryInventoryV1,
} from "../repository/inventory.js";
import type { RepositoryWorkspace } from "../repository/workspace/contracts.js";
import { parseJsonEvidence } from "../json-evidence.js";
import { getWorkflow } from "../workflow-registry/catalog.js";
import type { WorkflowDefinition } from "../workflow-contracts/contracts.js";
import { sha256 } from "../content-ir/canonical.js";
import { enforceLimit, limit } from "../config/limits.js";
import {
  deriveEvaluationTarget,
  isExactEvaluationTarget,
  type EvaluationTargetEntryV1,
} from "./evaluation-target.js";

// The evaluation profile identity receipt v1 can represent; the binding itself
// comes from the locked product-default declaration.
const PROFILE_BAR_ID = "profile:docsfab-documentation-quality" as const;
const PROFILE_ASSET_PATH = "profiles/docsfab-documentation-quality/profile.json" as const;
const PROFILE_ID = "docsfab-documentation-quality" as const;
const PROFILE_VERSION = "v0.1" as const;
const SELECTOR_ID = "review-documentation:docsfab-documentation-quality:v1" as const;
const TARGET_SCOPE = "documentation-set" as const;

export class QualityProfileSelectionError extends Error {
  public readonly code: "quality-profile-selection-invalid" | "migration-required";

  public constructor(
    code:
      | "quality-profile-selection-invalid"
      | "migration-required" = "quality-profile-selection-invalid",
  ) {
    super(code);
    this.name = "QualityProfileSelectionError";
    this.code = code;
  }
}

function fail(
  code:
    | "quality-profile-selection-invalid"
    | "migration-required" = "quality-profile-selection-invalid",
): never {
  throw new QualityProfileSelectionError(code);
}

const kit = createContractKit({
  fail: fail as ContractFail<"quality-profile-selection-invalid" | "migration-required">,
  inertMode: "strict",
  codes: {
    invalidShape: "quality-profile-selection-invalid",
    invalidValue: "quality-profile-selection-invalid",
    digestMismatch: "quality-profile-selection-invalid",
    credentialMaterial: "quality-profile-selection-invalid",
    schemaMismatch: "migration-required",
  },
});

export interface SelectedDocumentationQualityProfile {
  receipt: QualityProfileSelectionReceiptV1;
  documentationPaths: readonly string[];
  /** The step 8 `evaluation.target.paths` the host states and writes, derived once from this scope. */
  evaluationTarget: readonly EvaluationTargetEntryV1[];
  focused?: boolean;
  discoveryLimitations?: readonly string[];
  profile: Readonly<Record<string, unknown>>;
  pack: VerifiedQualityPackContext;
}

export async function selectDocumentationQualityProfile(input: {
  workflow: WorkflowDefinition;
  workspace: RepositoryWorkspace;
  inventory: RepositoryDiscoveryInventoryV1;
  pack: VerifiedQualityPackContext;
  targetPaths?: readonly string[];
}): Promise<SelectedDocumentationQualityProfile> {
  const workflowName = kit.enumeration(input.workflow.name, [
    "review-documentation",
    "create-documentation",
    "update-documentation",
  ] as const);
  const selectorId = `${workflowName}:docsfab-documentation-quality:v1`;
  const expectedWorkflow = getWorkflow(workflowName);
  let inventory: RepositoryDiscoveryInventoryV1;
  try {
    inventory = validateRepositoryDiscoveryInventoryAuthority(input.inventory, {
      sourcePath: input.workspace.sourcePath,
      requestedRevision: input.workspace.requestedRevision,
      revision: input.workspace.revision,
    });
  } catch {
    fail();
  }
  if (
    input.workflow !== expectedWorkflow ||
    (workflowName === "review-documentation" &&
      input.workflow.steps.some((step) => step.mode !== "read-only")) ||
    inventory.schemaVersion !== 2 ||
    inventory.repositoryRevision !== input.workspace.revision ||
    input.pack.evidence.qualityBundleSha256 !== input.pack.qualityLock.bundleSha256
  ) {
    fail();
  }
  // The locked declaration names the evaluation profile. Receipt v1 can record
  // only one profile identity, so a declaration naming another one refuses.
  const declared = input.pack.qualityLock.productDefaults.evaluation;
  if (
    declared.barId !== PROFILE_BAR_ID ||
    declared.assetPath !== PROFILE_ASSET_PATH ||
    declared.profileId !== PROFILE_ID ||
    declared.version !== PROFILE_VERSION
  ) {
    fail();
  }
  const matches = input.pack.qualityLock.bars.filter((bar) => bar.id === declared.barId);
  if (
    matches.length !== 1 ||
    matches[0]!.kind !== "profile" ||
    matches[0]!.assetPath !== declared.assetPath
  ) {
    fail();
  }
  const locked = input.pack.qualityLock.files.filter((file) => file.path === declared.assetPath);
  if (locked.length !== 1) fail();
  const profilePayloadSha256 = kit.hash(locked[0]!.sha256);

  const profilePath = resolve(input.pack.qualityRoot, declared.assetPath);
  await assertContainedRegularFile(input.pack.qualityRoot, profilePath);
  const bytes = await readFile(profilePath);
  if (sha256(bytes) !== locked[0]!.sha256) fail();
  let profileValue: unknown;
  try {
    profileValue = parseJsonEvidence(bytes);
  } catch {
    fail();
  }
  kit.assertInert(profileValue);
  kit.rejectCredentials(profileValue);
  const profile = kit.object(profileValue);
  kit.exact(profile, [
    "schema_version",
    "id",
    "version",
    "status",
    "release_gate_eligible",
    "model",
    "source",
    "applicability",
    "decision_policy",
    "constraints",
    "evidence_policy",
    "outcome_policy",
    "evidence_strength",
    "confidence_anchors",
    "calibration",
    "hard_gates",
  ]);
  if (
    profile.schema_version !== "1.0" ||
    profile.id !== declared.profileId ||
    profile.version !== declared.version ||
    profile.model !== "documentation-quality-model-v0.2" ||
    profile.status !== "experimental" ||
    profile.release_gate_eligible !== false
  ) {
    fail();
  }

  const regularPaths = new Set(
    inventory.files.filter((file) => file.kind === "regular").map((file) => file.path),
  );
  const availableDocuments = inventory.documents
    .filter((document) => document.candidateAudience === "public")
    .sort((left, right) => kit.compare(left.path, right.path));
  const requestedPaths = input.targetPaths === undefined ? undefined : new Set(input.targetPaths);
  if (
    requestedPaths &&
    (requestedPaths.size === 0 ||
      requestedPaths.size !== input.targetPaths!.length ||
      [...requestedPaths].some((path) => !availableDocuments.some((doc) => doc.path === path)))
  )
    fail();
  const documents = requestedPaths
    ? availableDocuments.filter((document) => requestedPaths.has(document.path))
    : availableDocuments;
  const documentationPaths = documents.map((document) => document.path);
  kit.unique(documentationPaths);
  if (
    documentationPaths.length === 0 ||
    documents.some((document) => !regularPaths.has(document.path))
  ) {
    fail();
  }
  const targetInput = {
    scopePaths: documentationPaths,
    focused: requestedPaths !== undefined,
    documentPaths: inventory.documents.map((document) => document.path),
    failures: inventory.failures,
  };
  const evaluationTarget = deriveEvaluationTarget(targetInput);
  // Refused before any model turn: every entry is stated in the step 8 contract.
  enforceLimit(limit("reviewScope.maxTargets"), evaluationTarget.length);
  if (
    !isExactEvaluationTarget(
      evaluationTarget.map((entry) => entry.path),
      targetInput,
    )
  ) {
    fail();
  }
  const workflowSourceSha256 = kit.canonicalDigest(input.workflow);
  const repositoryIdentitySha256 = sha256(Buffer.from(input.workspace.sourcePath, "utf8"));
  const targetScopeSha256 = kit.canonicalDigest({
    scope: TARGET_SCOPE,
    ...(requestedPaths ? { selection: "operator-named" } : {}),
  });
  const targetPathSetSha256 = kit.canonicalDigest({
    repositoryIdentitySha256,
    repositoryRevision: input.workspace.revision,
    scope: TARGET_SCOPE,
    paths: documentationPaths,
  });
  const applicabilitySha256 = kit.canonicalDigest({
    policy: selectorId,
    repositoryIdentitySha256,
    repositoryRevision: input.workspace.revision,
    inventorySha256: inventory.inventorySha256,
    targetScopeSha256,
    targetPathSetSha256,
    coverageSha256s: Object.entries(inventory.coverage)
      .sort(([left], [right]) => kit.compare(left, right))
      .map(([kind, coverage]) => ({ kind, evidenceSha256: coverage.evidenceSha256 })),
    documentEvidenceSha256s: documents.map((document) => document.evidenceSha256),
  });
  const receipt = kit.seal("docsfab-quality-profile-selection-receipt", "selectionSha256", {
    workflow: workflowName,
    selectorId,
    workflowSourceSha256,
    repositoryIdentitySha256,
    repositoryRevision: kit.revision(input.workspace.revision),
    inventorySha256: kit.hash(inventory.inventorySha256),
    targetScope: TARGET_SCOPE,
    targetScopeSha256,
    targetPathSetSha256,
    applicabilitySha256,
    documentCount: documentationPaths.length,
    qualityPackManifestSha256: kit.hash(input.pack.evidence.manifestSha256),
    qualityPackBindingSha256: kit.hash(input.pack.evidence.bindingSha256),
    skillLockSha256: kit.hash(input.pack.evidence.skillLockSha256),
    qualityLockSha256: kit.hash(input.pack.evidence.qualityLockSha256),
    qualityBundleSha256: kit.hash(input.pack.evidence.qualityBundleSha256),
    profileBarId: PROFILE_BAR_ID,
    profileAssetPath: PROFILE_ASSET_PATH,
    profilePayloadSha256,
    profileId: "docsfab-documentation-quality" as const,
    profileVersion: "v0.1" as const,
    profileModel: "documentation-quality-model-v0.2" as const,
    profileStatus: "experimental" as const,
    releaseGateEligible: false as const,
  }) as QualityProfileSelectionReceiptV1;
  return deepFreeze({
    receipt,
    documentationPaths,
    evaluationTarget,
    ...(requestedPaths ? { focused: true } : {}),
    discoveryLimitations:
      inventory.status === "complete"
        ? []
        : [
            `Repository discovery is incomplete (${Object.entries(inventory.coverage)
              .filter(([, coverage]) => coverage.status !== "complete")
              .map(([kind]) => kind)
              .join(", ")}; ${inventory.failures.length} recorded gap(s)). ` +
              "The quality profile applies to recognized documentation; this does not establish exhaustive repository coverage. " +
              "Inspect the requested targets directly and report any unverified scope. Do not infer that missing evidence passed.",
          ],
    profile: structuredClone(profile),
    pack: input.pack,
  });
}

export function decodeQualityProfileSelectionReceipt(
  value: unknown,
): QualityProfileSelectionReceiptV1 {
  return kit.decodeSealed(
    value,
    "docsfab-quality-profile-selection-receipt",
    "selectionSha256",
    [
      "workflow",
      "selectorId",
      "workflowSourceSha256",
      "repositoryIdentitySha256",
      "repositoryRevision",
      "inventorySha256",
      "targetScope",
      "targetScopeSha256",
      "targetPathSetSha256",
      "applicabilitySha256",
      "documentCount",
      "qualityPackManifestSha256",
      "qualityPackBindingSha256",
      "skillLockSha256",
      "qualityLockSha256",
      "qualityBundleSha256",
      "profileBarId",
      "profileAssetPath",
      "profilePayloadSha256",
      "profileId",
      "profileVersion",
      "profileModel",
      "profileStatus",
      "releaseGateEligible",
    ],
    (root) => {
      const workflowName = kit.enumeration(root.workflow, [
        "review-documentation",
        "create-documentation",
        "update-documentation",
      ] as const);
      const selectorId = `${workflowName}:docsfab-documentation-quality:v1`;
      if (
        root.selectorId !== selectorId ||
        root.profileBarId !== PROFILE_BAR_ID ||
        root.profileAssetPath !== PROFILE_ASSET_PATH ||
        root.profileId !== "docsfab-documentation-quality" ||
        root.profileVersion !== "v0.1" ||
        root.profileModel !== "documentation-quality-model-v0.2" ||
        root.profileStatus !== "experimental" ||
        root.releaseGateEligible !== false ||
        root.targetScope !== TARGET_SCOPE ||
        !Number.isSafeInteger(root.documentCount) ||
        (root.documentCount as number) < 1
      ) {
        fail();
      }
      return {
        workflow: workflowName,
        selectorId,
        workflowSourceSha256: kit.hash(root.workflowSourceSha256),
        repositoryIdentitySha256: kit.hash(root.repositoryIdentitySha256),
        repositoryRevision: kit.revision(root.repositoryRevision),
        inventorySha256: kit.hash(root.inventorySha256),
        targetScope: TARGET_SCOPE,
        targetScopeSha256: kit.hash(root.targetScopeSha256),
        targetPathSetSha256: kit.hash(root.targetPathSetSha256),
        applicabilitySha256: kit.hash(root.applicabilitySha256),
        documentCount: root.documentCount as number,
        qualityPackManifestSha256: kit.hash(root.qualityPackManifestSha256),
        qualityPackBindingSha256: kit.hash(root.qualityPackBindingSha256),
        skillLockSha256: kit.hash(root.skillLockSha256),
        qualityLockSha256: kit.hash(root.qualityLockSha256),
        qualityBundleSha256: kit.hash(root.qualityBundleSha256),
        profileBarId: PROFILE_BAR_ID,
        profileAssetPath: PROFILE_ASSET_PATH,
        profilePayloadSha256: kit.hash(root.profilePayloadSha256),
        profileId: "docsfab-documentation-quality" as const,
        profileVersion: "v0.1" as const,
        profileModel: "documentation-quality-model-v0.2" as const,
        profileStatus: "experimental" as const,
        releaseGateEligible: false as const,
      };
    },
  ) as QualityProfileSelectionReceiptV1;
}

async function assertContainedRegularFile(root: string, path: string): Promise<void> {
  try {
    const [rootReal, pathReal, metadata] = await Promise.all([
      realpath(root),
      realpath(path),
      lstat(path),
    ]);
    const scoped = relative(rootReal, pathReal);
    if (
      metadata.isSymbolicLink() ||
      !metadata.isFile() ||
      metadata.nlink !== 1 ||
      scoped === "" ||
      scoped === ".." ||
      scoped.startsWith(`..${sep}`) ||
      isAbsolute(scoped)
    ) {
      fail();
    }
  } catch (error) {
    if (error instanceof QualityProfileSelectionError) throw error;
    fail();
  }
}
