// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { types as nodeUtilTypes } from "node:util";

import type { RepositoryTarget } from "../../repository/contracts.js";
import type { RunRecord } from "../../records/contracts.js";
import type { IaPlanTaskInput } from "../../workflow-contracts/contracts.js";
import type { ContentIndexV2 } from "../../content-ir/contracts.js";
import { decodeContentIndexV2 } from "../../content-ir/decoder.js";
import { buildContentIndexV2 } from "../../content-ir/indexer.js";
import type { ImpactAnalysis } from "../../impact/contracts.js";
import type { IaDiagnosticEvaluationInput } from "../../ia/contracts.js";
import {
  inspectIaInputPackage,
  planningTaskKey,
  type InspectIaInputPackageOptions,
} from "../../ia/input-provider.js";
import {
  releaseDocumentationSpecification,
  type ReleaseDocumentationExpectedRepositoryV1,
  type ReleaseDocumentationReadinessCategory,
} from "../../release-documentation-rubric.js";
import {
  validateReleaseDocumentationReadinessArtifact,
  type ReleaseDocumentationReadinessArtifactV1,
} from "../../release-documentation-readiness.js";
import {
  validateRepositoryDiscoveryInventoryAuthority,
  type RepositoryDiscoveryInventoryV1,
} from "../../repository/inventory.js";
import { verifyTrackedRepositoryEntries } from "../../repository/workspace/tracked-read.js";
import type { RepositoryWorkspace } from "../../repository/workspace/contracts.js";
import type { RoadmapLedger } from "../../roadmap/contracts/ledger.js";
import type { DocumentationMaturityGateId } from "../contracts.js";
import {
  documentationMaturityEvaluator,
  type DocumentationMaturityEvaluatorCheckState,
} from "./catalog.js";
import {
  assertExactShallowInput,
  authenticWorkspaceForRepository,
  baseAuthority,
  canonicalDigest,
  canonicalJson,
  choice,
  invalid,
  primitiveString,
  repositoryBinding,
  snapshotPlainData,
  snapshotRepositoryTarget,
} from "./dialect.js";
import { loadDocumentationMaturityHostPolicy } from "./host-policy.js";
import {
  mappedCheck,
  sealMapping,
  sealObservationMapping,
  type DocumentationMaturityCapabilityMappingV1,
  type DocumentationMaturityMappedCheckV1,
  type DocumentationMaturitySemanticOverlayV1,
  type ObservationDefectSeed,
} from "./gate.js";

export function mapRepositoryInventoryToG0(inputValue: {
  inventory: RepositoryDiscoveryInventoryV1;
  repository: RepositoryTarget;
}): DocumentationMaturityCapabilityMappingV1 {
  assertExactShallowInput(inputValue, ["inventory", "repository"]);
  const descriptors = Object.getOwnPropertyDescriptors(inputValue);
  const repository = snapshotRepositoryTarget(descriptors.repository!.value);
  const inventory = validateRepositoryDiscoveryInventoryAuthority(descriptors.inventory!.value, {
    sourcePath: repository.sourcePath,
    requestedRevision: repository.requestedRevision,
    revision: repository.revision,
  });
  const fallbackPath =
    inventory.documents[0]?.path ?? inventory.files.find((item) => item.kind === "regular")?.path;
  const documentationPaths = inventory.documents.map((item) => item.path).sort();
  const hasValidation =
    inventory.commands.some((command) =>
      ["build", "docs-build", "lint", "link-check", "test"].includes(command.purpose),
    ) || inventory.signals.some((signal) => signal.category === "ci-validation");
  const defects: ObservationDefectSeed[] = [];
  const checks: DocumentationMaturityMappedCheckV1[] = [];
  checks.push(
    mappedCheck({
      checkId: "inventory-structure",
      state: inventory.coverage.structure.status === "complete" ? "satisfied" : "blocked",
      defectClass: "missing-infrastructure",
      evidenceSha256s: [inventory.coverage.structure.evidenceSha256],
      limitationCodes:
        inventory.coverage.structure.status === "complete" ? [] : ["structure-index-incomplete"],
    }),
  );
  checks.push(
    mappedCheck({
      checkId: "inventory-text",
      state: inventory.coverage.text.status === "complete" ? "satisfied" : "blocked",
      defectClass: "missing-infrastructure",
      evidenceSha256s: [inventory.coverage.text.evidenceSha256],
      limitationCodes:
        inventory.coverage.text.status === "complete" ? [] : ["text-index-incomplete"],
    }),
  );
  // Absence of a conventional docs path never proves the product needs one.
  // G1's explicit product-need authority decides applicability; G0 records the
  // input limitation without inventing that decision.
  const surfaceState = documentationPaths.length > 0 ? "satisfied" : "unknown";
  checks.push(
    mappedCheck({
      checkId: "documentation-input-surface",
      state: surfaceState,
      defectClass: "missing-content",
      evidenceSha256s: [inventory.coverage.structure.evidenceSha256],
      limitationCodes:
        surfaceState === "unknown"
          ? [
              inventory.coverage.structure.status === "complete"
                ? "documentation-product-need-unresolved"
                : "structure-index-incomplete",
            ]
          : [],
    }),
  );
  const validationState = hasValidation
    ? "satisfied"
    : inventory.coverage.metadata.status !== "complete" || !fallbackPath
      ? "unknown"
      : "finding";
  checks.push(
    mappedCheck({
      checkId: "validation-infrastructure",
      state: validationState,
      defectClass: "missing-infrastructure",
      evidenceSha256s: [inventory.coverage.metadata.evidenceSha256],
      limitationCodes:
        validationState === "unknown"
          ? [fallbackPath ? "metadata-index-incomplete" : "no-repository-relative-evidence-path"]
          : [],
    }),
  );
  if (validationState === "finding")
    defects.push({
      checkId: "validation-infrastructure",
      defectClass: "missing-infrastructure",
      affectedPaths: [fallbackPath!],
      issuePriority: "P0",
      workflow: { name: "readiness", stepId: "assess-readiness" },
    });
  return sealObservationMapping({
    gateId: "G0",
    capability: "repository-inventory",
    repository,
    sourceSha256: inventory.inventorySha256,
    checks,
    defects,
  });
}

const G1_CATEGORIES = new Set<ReleaseDocumentationReadinessCategory>([
  "audience",
  "site-infrastructure",
  "site-build",
  "site-template",
  "site-validation",
  "journey",
  "task-guide",
  "reference",
  "trust",
  "release-policy",
]);
const G5_CATEGORIES = new Set<ReleaseDocumentationReadinessCategory>([
  "governance",
  "scoped-guidance",
  "human-decision",
  "release-policy",
  "site-validation",
]);

/**
 * Reuses the exact release-documentation readiness artifact and its authentic
 * inventory authority. Bounded gaps stay mapped findings rather than being
 * relabeled as exact repository absence.
 */
export function mapReleaseDocumentationReadiness(inputValue: {
  gateId: "G1" | "G2" | "G5";
  artifact: ReleaseDocumentationReadinessArtifactV1;
  record: RunRecord;
  expectedRepository: ReleaseDocumentationExpectedRepositoryV1;
  trustedInventory: RepositoryDiscoveryInventoryV1;
}): DocumentationMaturityCapabilityMappingV1 {
  assertExactShallowInput(inputValue, [
    "gateId",
    "artifact",
    "record",
    "expectedRepository",
    "trustedInventory",
  ]);
  const descriptors = Object.getOwnPropertyDescriptors(inputValue);
  const gateId = choice(descriptors.gateId!.value, ["G1", "G2", "G5"] as const);
  const artifact = validateReleaseDocumentationReadinessArtifact(
    descriptors.artifact!.value as ReleaseDocumentationReadinessArtifactV1,
    descriptors.record!.value as RunRecord,
    descriptors.expectedRepository!.value as ReleaseDocumentationExpectedRepositoryV1,
    descriptors.trustedInventory!.value as RepositoryDiscoveryInventoryV1,
  );
  const repository = (descriptors.record!.value as RunRecord).repository;
  const definition = documentationMaturityEvaluator(gateId);
  const selected = artifact.findings.filter((finding) => {
    const specification = releaseDocumentationSpecification(finding.targetId)!;
    return gateId === "G1"
      ? G1_CATEGORIES.has(specification.category)
      : gateId === "G2"
        ? specification.category === "information-architecture"
        : G5_CATEGORIES.has(specification.category);
  });
  const checks = definition.checks.flatMap((declared) => {
    const related = selected.filter(
      (finding) =>
        releaseCheckFor(gateId, releaseDocumentationSpecification(finding.targetId)!) ===
        declared.id,
    );
    if (related.length === 0) return [];
    const state: DocumentationMaturityEvaluatorCheckState = related.some(
      (item) => item.state === "missing" || item.state === "needs-human-decision",
    )
      ? "finding"
      : related.some((item) => item.state === "blocked")
        ? "blocked"
        : related.some((item) => item.state === "inconclusive")
          ? "unknown"
          : "satisfied";
    return [
      mappedCheck({
        checkId: declared.id,
        state,
        defectClass: declared.defectClass,
        evidenceSha256s: related.flatMap((item) => [
          item.findingSha256,
          item.evidence.boundedSearchEvidenceSha256,
          item.evidence.batchEvidenceSha256,
        ]),
        limitationCodes:
          state === "unknown"
            ? ["release-readiness-inconclusive"]
            : state === "blocked"
              ? ["release-readiness-blocked"]
              : [],
      }),
    ];
  });
  const selectedTargets = new Set(selected.map((finding) => finding.targetId));
  const adaptedWorkUnits = artifact.workUnits
    .filter((unit) => selectedTargets.has(unit.targetId))
    .map((value) => ({
      sourceKind: "release-documentation-readiness" as const,
      sourceArtifactSha256: artifact.artifactSha256,
      workflow: {
        name: "release-documentation-readiness" as const,
        stepId: "assess-release-documentation-readiness" as const,
      },
      value,
    }));
  return sealMapping(
    {
      gateId,
      capability: "release-documentation-readiness",
      repository: repositoryBinding(repository.sourcePath, repository.revision),
      sourceSha256: artifact.artifactSha256,
      checks,
      // Readiness gaps are authenticated bounded-search facts. They stay
      // attached to the readiness artifact until the v2 maturity evidence union
      // admits that identity scheme; fabricating v1 observed-absence findings
      // here would be an authority escalation.
      findings: [],
      workUnits: [],
      adaptedWorkUnits,
    },
    baseAuthority(repository),
  );
}

function releaseCheckFor(
  gateId: "G1" | "G2" | "G5",
  specification: NonNullable<ReturnType<typeof releaseDocumentationSpecification>>,
): string {
  if (gateId === "G2") return "navigation-and-hierarchy";
  if (gateId === "G5") {
    if (specification.category === "governance" || specification.category === "human-decision") {
      return specification.targetId === "release-ownership"
        ? "documentation-ownership"
        : "freshness-and-review-policy";
    }
    if (specification.category === "scoped-guidance") return "roadmap-maintenance";
    return "validation-lifecycle";
  }
  if (specification.category === "audience") return "audience-coverage";
  if (
    ["site-infrastructure", "site-build", "site-template", "site-validation"].includes(
      specification.category,
    )
  )
    return "surface-infrastructure";
  if (specification.category === "journey") return "journey-coverage";
  if (["task-guide", "reference"].includes(specification.category))
    return "task-reference-coverage";
  return "trust-and-release-coverage";
}

/** Authenticate only the exact repository index until the other IA inputs gain producer receipts. */
export async function mapIaCapabilitiesToG2(inputValue: {
  repository: RepositoryTarget;
  workspace: RepositoryWorkspace;
  diagnosticsInput: Omit<IaDiagnosticEvaluationInput, "index"> & { index: ContentIndexV2 };
}): Promise<DocumentationMaturityCapabilityMappingV1[]> {
  assertExactShallowInput(inputValue, ["repository", "workspace", "diagnosticsInput"]);
  const descriptors = Object.getOwnPropertyDescriptors(inputValue);
  const repositoryTarget = snapshotRepositoryTarget(descriptors.repository!.value);
  const diagnosticsInputValue = descriptors.diagnosticsInput!.value;
  assertExactShallowInput(diagnosticsInputValue, [
    "index",
    "ontology",
    "candidates",
    "semantics",
    "candidateId",
    "structure",
    "policy",
  ]);
  const diagnosticsDescriptors = Object.getOwnPropertyDescriptors(diagnosticsInputValue);
  const index = snapshotPlainData(diagnosticsDescriptors.index!.value as ContentIndexV2);
  const workspace = await authenticWorkspaceForRepository(
    descriptors.workspace!.value,
    repositoryTarget,
  );
  const rebuiltIndex = await buildContentIndexV2({ workspace });
  const verifiedEntries = await verifyTrackedRepositoryEntries(workspace);
  await authenticWorkspaceForRepository(workspace, repositoryTarget);
  if (
    verifiedEntries.some((entry) => entry.status !== "verified") ||
    canonicalJson(rebuiltIndex) !== canonicalJson(index)
  ) {
    invalid("invalid-source");
  }
  // The exact index is repository-authenticated. Ontology, candidate,
  // projection, and semantic artifacts remain public self-rehashable values,
  // so they cannot authorize IA diagnostic satisfaction or findings here.
  const emptyAuthority = baseAuthority(repositoryTarget);
  const repository = repositoryBinding(repositoryTarget.sourcePath, repositoryTarget.revision);
  const contentMapping = sealMapping(
    {
      gateId: "G2",
      capability: "content-ir",
      repository,
      sourceSha256: rebuiltIndex.indexDigest,
      checks: [
        mappedCheck({
          checkId: "content-structure-indexed",
          state: "satisfied",
          defectClass: "structural-defect",
          evidenceSha256s: [rebuiltIndex.indexDigest],
        }),
      ],
      findings: [],
      workUnits: [],
    },
    emptyAuthority,
  );
  return [contentMapping];
}

/** Consume the on-disk package inspection boundary; receipt-shaped caller data is never accepted. */
export async function mapIaSelfServiceInputToG2(inputValue: {
  repository: RepositoryTarget;
  inspection: InspectIaInputPackageOptions;
}): Promise<DocumentationMaturityCapabilityMappingV1> {
  assertExactShallowInput(inputValue, ["repository", "inspection"]);
  const inputDescriptors = Object.getOwnPropertyDescriptors(inputValue);
  const repository = snapshotRepositoryTarget(inputDescriptors.repository!.value);
  const inspection = snapshotIaInputPackageInspection(inputDescriptors.inspection!.value);
  if (
    inspection.repositoryPath !== repository.sourcePath ||
    inspection.repositoryRevision !== repository.revision
  ) {
    invalid("repository-mismatch");
  }
  let receipt: Awaited<ReturnType<typeof inspectIaInputPackage>>;
  try {
    receipt = await inspectIaInputPackage(inspection);
  } catch {
    invalid("invalid-source");
  }
  if (
    receipt.repositoryRevision !== repository.revision ||
    receipt.packageKind !== inspection.packageKind ||
    receipt.created
  ) {
    invalid("invalid-source");
  }
  const sourceSha256 = canonicalDigest({
    schemaVersion: receipt.schemaVersion,
    packageKind: receipt.packageKind,
    taskKey: receipt.taskKey,
    digest: receipt.digest,
    repositoryIdentity: receipt.repositoryIdentity,
    repositoryRevision: receipt.repositoryRevision,
    repositoryContentDigest: receipt.repositoryContentDigest,
    indexDigest: receipt.indexDigest,
    expiresAt: receipt.expiresAt,
  });
  return sealMapping(
    {
      gateId: "G2",
      capability: "ia-self-service",
      repository: repositoryBinding(repository.sourcePath, repository.revision),
      sourceSha256,
      checks: [
        mappedCheck({
          checkId: "ia-self-service-input",
          state: "satisfied",
          defectClass: "missing-infrastructure",
          evidenceSha256s: [receipt.digest, sourceSha256],
        }),
      ],
      findings: [],
      workUnits: [],
    },
    baseAuthority(repository),
  );
}

function snapshotIaInputPackageInspection(value: unknown): InspectIaInputPackageOptions {
  assertExactShallowInput(
    value,
    ["packageKind", "packageRoot", "repositoryPath", "repositoryRevision", "task"],
    ["repositoryIdentity", "commandRepositoryPath", "packageDigest", "now", "maxPackageBytes"],
  );
  const descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>;
  const now = snapshotDate(descriptors.now?.value);
  const task = snapshotIaPlanTask(descriptors.task!.value);
  const inert = snapshotPlainData({
    packageKind: descriptors.packageKind!.value,
    packageRoot: descriptors.packageRoot!.value,
    repositoryPath: descriptors.repositoryPath!.value,
    repositoryRevision: descriptors.repositoryRevision!.value,
    repositoryIdentity: descriptors.repositoryIdentity?.value,
    commandRepositoryPath: descriptors.commandRepositoryPath?.value,
    packageDigest: descriptors.packageDigest?.value,
    task,
    now: now?.toISOString(),
    maxPackageBytes: descriptors.maxPackageBytes?.value,
  });
  return Object.freeze({
    ...inert,
    ...(now === undefined ? {} : { now }),
  }) as InspectIaInputPackageOptions;
}

function snapshotIaPlanTask(value: unknown): Readonly<IaPlanTaskInput> {
  assertExactShallowInput(value, ["kind", "scope", "mode"], ["target"]);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const kind = choice(descriptors.kind!.value, ["ia-plan"] as const);
  const scope = choice(descriptors.scope!.value, ["site", "section", "page"] as const);
  const mode = choice(descriptors.mode!.value, ["create", "reevaluate"] as const);
  const task = Object.freeze({
    kind,
    scope,
    mode,
    ...(descriptors.target === undefined
      ? {}
      : { target: snapshotIaPlanTarget(descriptors.target.value) }),
  }) as Readonly<IaPlanTaskInput>;
  try {
    planningTaskKey(task);
  } catch {
    invalid("invalid-source");
  }
  return task;
}

function snapshotIaPlanTarget(value: unknown): NonNullable<IaPlanTaskInput["target"]> {
  assertExactShallowInput(value, ["sourcePath"], ["anchor"]);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const sourcePath = primitiveString(descriptors.sourcePath!.value);
  const anchor =
    descriptors.anchor === undefined ? undefined : primitiveString(descriptors.anchor.value);
  return Object.freeze({
    sourcePath,
    ...(anchor === undefined ? {} : { anchor }),
  }) as NonNullable<IaPlanTaskInput["target"]>;
}

function snapshotDate(value: unknown): Date | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "object" ||
    value === null ||
    nodeUtilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Date.prototype ||
    Reflect.ownKeys(value).length > 0
  ) {
    invalid("invalid-source");
  }
  const milliseconds = Date.prototype.getTime.call(value);
  if (!Number.isFinite(milliseconds)) invalid("invalid-source");
  return new Date(milliseconds);
}

/** Deterministic G3 modularity check over the existing Content IR. */
export async function mapContentIndexToG3(inputValue: {
  repository: RepositoryTarget;
  policyWorkspace: RepositoryWorkspace;
  index: ContentIndexV2;
}): Promise<DocumentationMaturityCapabilityMappingV1> {
  assertExactShallowInput(inputValue, ["repository", "policyWorkspace", "index"]);
  const descriptors = Object.getOwnPropertyDescriptors(inputValue);
  const repository = snapshotRepositoryTarget(descriptors.repository!.value);
  const policyWorkspace = descriptors.policyWorkspace!.value as RepositoryWorkspace;
  const index = decodeContentIndexV2(snapshotPlainData(descriptors.index!.value));
  if (index.repository.revision !== repository.revision) invalid("repository-mismatch");
  const workspace = await authenticWorkspaceForRepository(policyWorkspace, repository);
  const rebuiltIndex = await buildContentIndexV2({ workspace });
  const verifiedEntries = await verifyTrackedRepositoryEntries(workspace);
  if (
    verifiedEntries.some((entry) => entry.status !== "verified") ||
    canonicalJson(rebuiltIndex) !== canonicalJson(index)
  )
    invalid("invalid-source");
  const policy = (await loadDocumentationMaturityHostPolicy(workspace, repository))
    .modularityPolicy;
  const policySemantics = {
    maximumSectionsPerDocument: policy.maximumSectionsPerDocument,
    maximumSectionDepth: policy.maximumSectionDepth,
  };
  const evaluator = documentationMaturityEvaluator("G3");
  const modularityCheck = evaluator.checks.find((item) => item.id === "article-modularity")!;
  const documents = index.nodes.filter(
    (node): node is Extract<typeof node, { kind: "document" }> => node.kind === "document",
  );
  const violations = documents
    .filter((document) => {
      const sections = index.nodes.filter(
        (node): node is Extract<typeof node, { kind: "section" }> =>
          node.kind === "section" && node.documentId === document.id,
      );
      return (
        sections.length > policy.maximumSectionsPerDocument ||
        sections.some((section) => section.depth > policy.maximumSectionDepth)
      );
    })
    .map((document) => document.sourcePath)
    .sort();
  return sealObservationMapping({
    gateId: "G3",
    capability: "content-ir",
    repository,
    sourceSha256: index.indexDigest,
    checks: [
      mappedCheck({
        checkId: "article-modularity",
        state: violations.length > 0 ? "finding" : "satisfied",
        defectClass: "structural-defect",
        evidenceSha256s: [index.indexDigest, policy.policySha256],
      }),
    ],
    defects:
      violations.length === 0
        ? []
        : [
            {
              checkId: "article-modularity",
              defectClass: "structural-defect",
              affectedPaths: violations,
              issuePriority: "P1",
              workflow: { name: "update-documentation", stepId: "write-documentation" },
              requirementSubjectSha256: canonicalDigest({
                check: modularityCheck,
                policy: policySemantics,
              }),
              scopeSha256: canonicalDigest({
                evaluatorId: evaluator.id,
                evaluatorVersion: evaluator.version,
                checkId: "article-modularity",
                policy: policySemantics,
              }),
            },
          ],
  });
}

/** Compatibility boundary retained until impact analysis exposes an opaque producer receipt. */
export function mapImpactAnalysisToMaturity(inputValue: {
  gateId: "G3" | "G5";
  repository: RepositoryTarget;
  impact: ImpactAnalysis;
}): DocumentationMaturityCapabilityMappingV1 {
  assertExactShallowInput(inputValue, ["gateId", "repository", "impact"]);
  const descriptors = Object.getOwnPropertyDescriptors(inputValue);
  choice(descriptors.gateId!.value, ["G3", "G5"] as const);
  // Public impact contracts have no opaque producer receipt. Reject instead
  // of minting even an unknown mapping that could collide with genuine input.
  invalid("invalid-source");
}

/** Compatibility boundary retained until roadmap planning exposes an opaque producer receipt. */
export function mapRoadmapLedgerToG5(inputValue: {
  repository: RepositoryTarget;
  ledger: RoadmapLedger;
}): DocumentationMaturityCapabilityMappingV1 {
  assertExactShallowInput(inputValue, ["repository", "ledger"]);
  // Public ledger contracts have no opaque producer receipt. Reject instead
  // of minting even an unknown mapping that could collide with genuine input.
  invalid("invalid-source");
}

/** Compatibility boundary retained until workflow outcomes expose an opaque producer receipt. */
export function mapWorkflowOutcomeToMaturity(inputValue: {
  gateId: DocumentationMaturityGateId;
  record: RunRecord;
}): DocumentationMaturitySemanticOverlayV1 {
  assertExactShallowInput(inputValue, ["gateId", "record"]);
  choice(Object.getOwnPropertyDescriptors(inputValue).gateId!.value, [
    "G0",
    "G1",
    "G2",
    "G3",
    "G4",
    "G5",
  ] as const);
  // A serialized RunRecord and its checksum-valid outcome are reproducible by
  // any caller. Until the harness exposes an opaque producer receipt, accepting
  // them here would turn this public adapter into a semantic-authority mint.
  invalid("invalid-source");
}
