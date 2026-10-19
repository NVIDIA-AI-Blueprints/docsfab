// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { RepositoryTarget } from "../../repository/contracts.js";
import {
  readTrackedRepositoryFile,
  verifyActiveRepositoryWorkspace,
} from "../../repository/workspace/tracked-read.js";
import type { RepositoryWorkspace } from "../../repository/workspace/contracts.js";
import type { DocumentationMaturityGateId } from "../contracts.js";
import {
  assertInertPlainData,
  canonicalDigest,
  canonicalJson,
  choice,
  deepFreeze,
  hasExactKeys,
  invalid,
  plainObject,
  repositoryBinding,
  safeHostToken,
  sha,
  canonicalTimestamp,
  isSortedUnique,
  DocumentationMaturityEvaluatorError,
} from "./dialect.js";

export const DOCUMENTATION_MATURITY_HOST_POLICY_PATH =
  ".docsfab-documentation-maturity-policy.json" as const;
export const DOCUMENTATION_QUALITY_POLICY_PATH =
  ".docsfab-documentation-quality-policy.json" as const;
const MAXIMUM_HOST_POLICY_BYTES = 64 * 1024;

export type DocumentationProductNeed = "required" | "not-required" | "unknown";
export type DocumentationRepositoryType =
  | "application"
  | "library"
  | "service"
  | "documentation-only"
  | "monorepo"
  | "other";
export type DocumentationSurfaceType =
  | "public-product"
  | "developer-reference"
  | "operator-guide"
  | "internal"
  | "none"
  | "unknown";

interface DocumentationMaturityHostPolicyV1 {
  schemaVersion: 1;
  kind: "docsfab-documentation-maturity-host-policy";
  productNeed: {
    repositoryType: DocumentationRepositoryType;
    documentationType: DocumentationSurfaceType;
    gateIds: DocumentationMaturityGateId[];
    decision: {
      id: string;
      need: DocumentationProductNeed;
      authorityId: string;
      decidedAt: string;
      evidenceSha256: string | null;
      predecessorDecisionSha256: string | null;
    };
  };
  modularity: {
    activePolicyId: string;
    activePolicyVersion: string;
    policies: DocumentationModularityPolicyV1[];
  };
}

interface DocumentationProductNeedDecisionStateV1 {
  repository: { identitySha256: string; revision: string };
  scope: Omit<DocumentationMaturityHostPolicyV1["productNeed"], "decision">;
  decision: DocumentationMaturityHostPolicyV1["productNeed"]["decision"];
  ledgerSha256: string;
  decisionSha256: string;
}

interface DocumentationModularityPolicyV1 {
  id: string;
  version: string;
  maximumSectionsPerDocument: number;
  maximumSectionDepth: number;
}

interface DocumentationMaturityHostPolicyState {
  ledger: DocumentationMaturityHostPolicyV1;
  ledgerSha256: string;
  productNeed: DocumentationProductNeedDecisionStateV1;
  modularityPolicy: DocumentationModularityPolicyV1 & { policySha256: string };
}

export async function loadDocumentationMaturityHostPolicy(
  workspaceValue: RepositoryWorkspace,
  repository: RepositoryTarget,
): Promise<DocumentationMaturityHostPolicyState> {
  let workspace: RepositoryWorkspace;
  let bytes: Buffer;
  try {
    workspace = await verifyActiveRepositoryWorkspace(workspaceValue);
    if (
      workspace.sourcePath !== repository.sourcePath ||
      workspace.requestedRevision !== repository.requestedRevision ||
      workspace.revision !== repository.revision
    )
      invalid("repository-mismatch");
    bytes = await readTrackedRepositoryFile(
      workspace,
      DOCUMENTATION_MATURITY_HOST_POLICY_PATH,
      MAXIMUM_HOST_POLICY_BYTES,
    );
  } catch (error) {
    if (error instanceof DocumentationMaturityEvaluatorError) throw error;
    invalid("invalid-product-need");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    invalid("invalid-product-need");
  }
  assertInertPlainData(parsed);
  const root = plainObject(parsed);
  if (
    !hasExactKeys(root, ["schemaVersion", "kind", "productNeed", "modularity"]) ||
    root.schemaVersion !== 1 ||
    root.kind !== "docsfab-documentation-maturity-host-policy"
  ) {
    invalid("invalid-product-need");
  }
  const productNeedValue = plainObject(root.productNeed);
  const decisionValue = plainObject(productNeedValue.decision);
  const modularityValue = plainObject(root.modularity);
  if (
    !hasExactKeys(productNeedValue, [
      "repositoryType",
      "documentationType",
      "gateIds",
      "decision",
    ]) ||
    !hasExactKeys(decisionValue, [
      "id",
      "need",
      "authorityId",
      "decidedAt",
      "evidenceSha256",
      "predecessorDecisionSha256",
    ]) ||
    !hasExactKeys(modularityValue, ["activePolicyId", "activePolicyVersion", "policies"])
  )
    invalid("invalid-product-need");
  const gateIds = Array.isArray(productNeedValue.gateIds)
    ? productNeedValue.gateIds.map((value) =>
        choice(value, ["G1", "G2", "G3", "G4", "G5"] as const),
      )
    : invalid("invalid-product-need");
  if (!isSortedUnique(gateIds)) invalid("invalid-product-need");
  const repositoryType = choice(productNeedValue.repositoryType, [
    "application",
    "library",
    "service",
    "documentation-only",
    "monorepo",
    "other",
  ] as const);
  const documentationType = choice(productNeedValue.documentationType, [
    "public-product",
    "developer-reference",
    "operator-guide",
    "internal",
    "none",
    "unknown",
  ] as const);
  const need = choice(decisionValue.need, ["required", "not-required", "unknown"] as const);
  const evidenceSha256 =
    decisionValue.evidenceSha256 === null ? null : sha(decisionValue.evidenceSha256);
  const predecessorDecisionSha256 =
    decisionValue.predecessorDecisionSha256 === null
      ? null
      : sha(decisionValue.predecessorDecisionSha256);
  const decision = {
    id: safeHostToken(decisionValue.id),
    need,
    authorityId: safeHostToken(decisionValue.authorityId),
    decidedAt: canonicalTimestamp(decisionValue.decidedAt),
    evidenceSha256,
    predecessorDecisionSha256,
  };
  if (
    (need !== "unknown" && evidenceSha256 === null) ||
    (need === "unknown" && evidenceSha256 !== null) ||
    (need === "not-required") !== (documentationType === "none") ||
    (need === "unknown") !== (documentationType === "unknown")
  ) {
    invalid("invalid-product-need");
  }
  if (
    !Array.isArray(modularityValue.policies) ||
    modularityValue.policies.length === 0 ||
    modularityValue.policies.length > 32
  )
    invalid("invalid-source");
  const policies = modularityValue.policies.map((value) => {
    const policyValue = plainObject(value);
    if (
      !hasExactKeys(policyValue, [
        "id",
        "version",
        "maximumSectionsPerDocument",
        "maximumSectionDepth",
      ])
    )
      invalid("invalid-source");
    const maximumSectionsPerDocument = policyValue.maximumSectionsPerDocument;
    const maximumSectionDepth = policyValue.maximumSectionDepth;
    if (
      !Number.isSafeInteger(maximumSectionsPerDocument) ||
      (maximumSectionsPerDocument as number) < 1 ||
      !Number.isSafeInteger(maximumSectionDepth) ||
      (maximumSectionDepth as number) < 1
    ) {
      invalid("invalid-source");
    }
    return {
      id: safeHostToken(policyValue.id),
      version: safeHostToken(policyValue.version),
      maximumSectionsPerDocument: maximumSectionsPerDocument as number,
      maximumSectionDepth: maximumSectionDepth as number,
    };
  });
  const policyKeys = policies.map((policy) => `${policy.id}@${policy.version}`);
  if (!isSortedUnique(policyKeys)) invalid("invalid-source");
  const activePolicyId = safeHostToken(modularityValue.activePolicyId);
  const activePolicyVersion = safeHostToken(modularityValue.activePolicyVersion);
  const activePolicy = policies.find(
    (policy) => policy.id === activePolicyId && policy.version === activePolicyVersion,
  );
  if (!activePolicy) invalid("invalid-source");
  const ledger: DocumentationMaturityHostPolicyV1 = {
    schemaVersion: 1,
    kind: "docsfab-documentation-maturity-host-policy",
    productNeed: {
      repositoryType,
      documentationType,
      gateIds,
      decision,
    },
    modularity: { activePolicyId, activePolicyVersion, policies },
  };
  if (bytes.toString("utf8") !== canonicalJson(ledger)) invalid("invalid-product-need");
  const repositoryBindingValue = repositoryBinding(repository.sourcePath, repository.revision);
  const ledgerSha256 = canonicalDigest(ledger);
  const scope = { repositoryType, documentationType, gateIds };
  const productNeedBody = {
    repository: repositoryBindingValue,
    scope,
    decision,
    ledgerSha256,
  };
  const policyBody = {
    repository: repositoryBindingValue,
    gateId: "G3" as const,
    ledgerSha256,
    policy: activePolicy,
  };
  return deepFreeze({
    ledger,
    ledgerSha256,
    productNeed: {
      ...productNeedBody,
      decisionSha256: canonicalDigest(productNeedBody),
    },
    modularityPolicy: { ...activePolicy, policySha256: canonicalDigest(policyBody) },
  });
}
