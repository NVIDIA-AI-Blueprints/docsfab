// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Pin C (bar ids): until a pack is bound, this host/quality-policy loader is
 * the visible C. `packages/quality/` mints pin C; "quality pack" means the
 * crate of hashed B+C, not the quality directory. Pin C does not get a new
 * `WorkflowStep` field; when a pack is bound, C is the manifest ids.
 *
 * Cite: planning/design/closed-job-three-pins.md
 */
import type { RepositoryTarget } from "../../repository/contracts.js";
import type { WorkflowName } from "../../workflow-contracts/contracts.js";
import type { RepositoryWorkspace } from "../../repository/workspace/contracts.js";
import {
  listTrackedRepositoryFiles,
  readTrackedRepositoryFile,
  verifyTrackedRepositoryEntries,
} from "../../repository/workspace/tracked-read.js";
import type { DocumentationMaturityGateId } from "../contracts.js";
import { documentationMaturityEvaluator, type DocumentationMaturityCapability } from "./catalog.js";
import { DOCUMENTATION_QUALITY_POLICY_PATH } from "./host-policy.js";
import {
  assertExactShallowInput,
  assertInertPlainData,
  authenticWorkspaceForRepository,
  boundedStrings,
  canonicalDigest,
  canonicalJson,
  choice,
  deepFreeze,
  exact,
  invalid,
  isSortedUnique,
  plainObject,
  safeId,
  snapshotRepositoryTarget,
} from "./dialect.js";
import {
  mappedCheck,
  sealObservationMapping,
  type DocumentationMaturityCapabilityMappingV1,
  type ObservationDefectSeed,
} from "./gate.js";

const MAXIMUM_QUALITY_POLICY_BYTES = 64 * 1024;
const MAXIMUM_QUALITY_DOCUMENT_BYTES = 512 * 1024;

export interface DocumentationQualityPolicyV1 {
  schemaVersion: 1;
  kind: "docsfab-documentation-quality-policy";
  productName: string;
  documentationPaths: string[];
  navigationRoot: string;
  gettingStartedPath: string;
  referencePath: string;
  iaInputPath: string;
  maintenancePath: string;
  roadmapPath: string;
  ownerPath: string;
  validationPath: string;
  currentVersion: string;
  reviewedAt: string;
  maximumPurposeHeadingsPerDocument: number;
  maximumSectionsPerDocument: number;
  requiredTopics: Array<{ id: string; path: string; phrases: string[] }>;
}

/**
 * Authenticates a tracked, repository-owned documentation quality policy and
 * maps bounded file/Markdown observations to every deterministic G0-G5 check.
 * The policy declares requirements only; dispositions and findings are
 * derived from the exact exported Git tree and cannot be supplied by callers.
 */
export async function mapRepositoryDocumentationQuality(inputValue: {
  gateId: DocumentationMaturityGateId;
  repository: RepositoryTarget;
  workspace: RepositoryWorkspace;
}): Promise<DocumentationMaturityCapabilityMappingV1[]> {
  assertExactShallowInput(inputValue, ["gateId", "repository", "workspace"]);
  const descriptors = Object.getOwnPropertyDescriptors(inputValue);
  const gateId = choice(descriptors.gateId!.value, ["G0", "G1", "G2", "G3", "G4", "G5"] as const);
  const repository = snapshotRepositoryTarget(descriptors.repository!.value);
  const workspace = await authenticWorkspaceForRepository(descriptors.workspace!.value, repository);
  const tracked = await listTrackedRepositoryFiles(workspace);
  if (tracked.length > 10_000) invalid("evidence-limit-exceeded");
  const trackedPaths = new Set(tracked.map((entry) => entry.path));
  let policyBytes: Buffer;
  try {
    policyBytes = await readTrackedRepositoryFile(
      workspace,
      DOCUMENTATION_QUALITY_POLICY_PATH,
      MAXIMUM_QUALITY_POLICY_BYTES,
    );
  } catch {
    invalid("invalid-source");
  }
  const policy = decodeDocumentationQualityPolicy(policyBytes!.toString("utf8"));
  const observedPaths = [
    ...new Set([
      ...policy.documentationPaths,
      policy.navigationRoot,
      policy.gettingStartedPath,
      policy.referencePath,
      policy.iaInputPath,
      policy.maintenancePath,
      policy.roadmapPath,
      policy.ownerPath,
      policy.validationPath,
      ...policy.requiredTopics.map((topic) => topic.path),
    ]),
  ].sort();
  if (observedPaths.length > 64) invalid("evidence-limit-exceeded");
  const documents = new Map<string, string | null>();
  for (const path of observedPaths) {
    if (!trackedPaths.has(path)) {
      documents.set(path, null);
      continue;
    }
    const trackedFile = tracked.find((entry) => entry.path === path)!;
    if (trackedFile.byteLength > MAXIMUM_QUALITY_DOCUMENT_BYTES) invalid("evidence-limit-exceeded");
    let bytes: Buffer;
    try {
      bytes = await readTrackedRepositoryFile(workspace, path, MAXIMUM_QUALITY_DOCUMENT_BYTES);
    } catch {
      invalid("invalid-source");
    }
    documents.set(path, bytes!.toString("utf8"));
  }
  const verifiedEntries = await verifyTrackedRepositoryEntries(workspace);
  await authenticWorkspaceForRepository(workspace, repository);
  if (verifiedEntries.some((entry) => entry.status !== "verified")) invalid("invalid-source");
  const sourceSha256 = canonicalDigest({
    policySha256: canonicalDigest(policy),
    files: observedPaths.map((path) => ({
      path,
      sha256: documents.get(path) === null ? null : canonicalDigest(documents.get(path)),
    })),
  });
  const signals = documentationQualitySignals(policy, documents);
  const definition = documentationMaturityEvaluator(gateId);
  return qualityCapabilities(gateId).map((capability) => {
    const sourceInputIds = definition.inputs
      .filter((input) => input.capability === capability && input.layer === "deterministic")
      .map((input) => input.id);
    const declaredChecks = definition.checks.filter((check) =>
      check.sourceInputIds.some((inputId) => sourceInputIds.includes(inputId)),
    );
    const checks = declaredChecks.map((declared) => {
      const signal = signals.get(`${gateId}:${declared.id}`);
      if (!signal) invalid("invalid-source");
      return mappedCheck({
        checkId: declared.id,
        state: signal.affectedPaths.length === 0 ? "satisfied" : "finding",
        defectClass: declared.defectClass,
        evidenceSha256s: [sourceSha256],
      });
    });
    const defects = declaredChecks.flatMap((declared): ObservationDefectSeed[] => {
      const signal = signals.get(`${gateId}:${declared.id}`)!;
      if (signal.affectedPaths.length === 0) return [];
      return [
        {
          checkId: declared.id,
          defectClass: declared.defectClass,
          affectedPaths: signal.affectedPaths,
          issuePriority: signal.priority,
          workflow: qualityWorkflow(gateId),
          requirementSubjectSha256: canonicalDigest({
            evaluatorCheck: declared,
            policySha256: canonicalDigest(policy),
          }),
          scopeSha256: canonicalDigest({
            policySha256: canonicalDigest(policy),
            gateId,
            checkId: declared.id,
            observedPaths,
          }),
        },
      ];
    });
    return sealObservationMapping({
      gateId,
      capability,
      repository,
      sourceSha256,
      checks,
      defects,
    });
  });
}

interface DocumentationQualitySignal {
  affectedPaths: string[];
  priority: "P0" | "P1" | "P2";
}

function documentationQualitySignals(
  policy: DocumentationQualityPolicyV1,
  files: ReadonlyMap<string, string | null>,
): ReadonlyMap<string, DocumentationQualitySignal> {
  const result = new Map<string, DocumentationQualitySignal>();
  const missing = (paths: readonly string[]): string[] =>
    paths.filter((path) => files.get(path) === null);
  const lacks = (path: string, text: string): boolean =>
    !(files.get(path)?.includes(text) ?? false);
  const docsPresent = policy.documentationPaths.filter((path) => files.get(path) !== null);
  const validationMissing = lacks(policy.validationPath, '"docs:check"');
  const topicFailures = policy.requiredTopics
    .filter((topic) => topic.phrases.some((phrase) => lacks(topic.path, phrase)))
    .map((topic) => topic.path);
  const purposeFailures = docsPresent.filter(
    (path) => countMarkdownHeadings(files.get(path)!, 2) > policy.maximumPurposeHeadingsPerDocument,
  );
  const sectionFailures = docsPresent.filter(
    (path) => countMarkdownHeadings(files.get(path)!) > policy.maximumSectionsPerDocument,
  );
  const accuracyFailures = docsPresent.filter((path) =>
    lacks(path, `Version: ${policy.currentVersion}`),
  );
  const freshnessFailures = docsPresent.filter((path) =>
    lacks(path, `Reviewed: ${policy.reviewedAt}`),
  );
  const consistencyFailures = docsPresent.filter((path) => lacks(path, policy.productName));
  const accessibilityFailures = docsPresent.filter((path) => hasImageWithoutAlt(files.get(path)!));
  const navigationFailures = [policy.gettingStartedPath, policy.referencePath].filter((path) =>
    lacks(policy.navigationRoot, path),
  );
  const noDocsPath = policy.documentationPaths[0]!;
  const put = (
    gateId: DocumentationMaturityGateId,
    checkId: string,
    affectedPaths: string[],
    priority: DocumentationQualitySignal["priority"],
  ): void => {
    result.set(`${gateId}:${checkId}`, {
      affectedPaths: [...new Set(affectedPaths)].sort(),
      priority,
    });
  };

  put("G0", "inventory-structure", [], "P0");
  put("G0", "inventory-text", [], "P0");
  put("G0", "documentation-input-surface", docsPresent.length === 0 ? [noDocsPath] : [], "P0");
  put("G0", "validation-infrastructure", validationMissing ? [policy.validationPath] : [], "P0");

  put(
    "G1",
    "audience-coverage",
    lacks(policy.navigationRoot, "Audience:") ? [policy.navigationRoot] : [],
    "P1",
  );
  put("G1", "surface-infrastructure", validationMissing ? [policy.validationPath] : [], "P0");
  put("G1", "journey-coverage", missing([policy.gettingStartedPath]), "P0");
  put("G1", "task-reference-coverage", missing([policy.referencePath]), "P1");
  put(
    "G1",
    "trust-and-release-coverage",
    lacks(policy.navigationRoot, "Support:") ? [policy.navigationRoot] : [],
    "P1",
  );

  put("G2", "content-structure-indexed", missing(policy.documentationPaths), "P0");
  put("G2", "navigation-and-hierarchy", navigationFailures, "P1");
  put("G2", "page-boundaries-and-naming", purposeFailures, "P0");
  put("G2", "ia-self-service-input", missing([policy.iaInputPath]), "P1");

  put("G3", "article-completeness", topicFailures, "P1");
  put("G3", "article-modularity", sectionFailures, "P0");
  put("G3", "article-accuracy", accuracyFailures, "P0");
  put("G3", "article-freshness", freshnessFailures, "P1");

  put(
    "G4",
    "presentation-polish",
    docsPresent.filter((path) => lacks(path, "Status: polished")),
    "P2",
  );
  put(
    "G4",
    "examples",
    lacks(policy.gettingStartedPath, "```sh") ? [policy.gettingStartedPath] : [],
    "P1",
  );
  put("G4", "accessibility", accessibilityFailures, "P1");
  put("G4", "consistency", consistencyFailures, "P2");

  put(
    "G5",
    "documentation-ownership",
    lacks(policy.ownerPath, "docs/") ? [policy.ownerPath] : [],
    "P1",
  );
  put("G5", "validation-lifecycle", validationMissing ? [policy.validationPath] : [], "P1");
  put(
    "G5",
    "freshness-and-review-policy",
    lacks(policy.maintenancePath, "Review cadence:") ? [policy.maintenancePath] : [],
    "P1",
  );
  put(
    "G5",
    "roadmap-maintenance",
    lacks(policy.roadmapPath, "Documentation roadmap:") ? [policy.roadmapPath] : [],
    "P2",
  );
  return result;
}

function decodeDocumentationQualityPolicy(text: string): DocumentationQualityPolicyV1 {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    invalid("invalid-source");
  }
  assertInertPlainData(value);
  const root = plainObject(value);
  exact(root, [
    "schemaVersion",
    "kind",
    "productName",
    "documentationPaths",
    "navigationRoot",
    "gettingStartedPath",
    "referencePath",
    "iaInputPath",
    "maintenancePath",
    "roadmapPath",
    "ownerPath",
    "validationPath",
    "currentVersion",
    "reviewedAt",
    "maximumPurposeHeadingsPerDocument",
    "maximumSectionsPerDocument",
    "requiredTopics",
  ]);
  if (root.schemaVersion !== 1 || root.kind !== "docsfab-documentation-quality-policy") {
    invalid("invalid-source");
  }
  const documentationPaths = qualityPaths(root.documentationPaths, false);
  if (
    !Array.isArray(root.requiredTopics) ||
    root.requiredTopics.length === 0 ||
    root.requiredTopics.length > 32
  )
    invalid("invalid-source");
  const requiredTopics = root.requiredTopics.map((value) => {
    const item = plainObject(value);
    exact(item, ["id", "path", "phrases"]);
    const phrases = boundedStrings(item.phrases);
    if (phrases.length === 0 || !isSortedUnique(phrases)) invalid("invalid-source");
    return { id: safeId(item.id), path: qualityPath(item.path), phrases };
  });
  if (!isSortedUnique(requiredTopics.map((topic) => topic.id))) invalid("invalid-source");
  const positiveInteger = (candidate: unknown): number => {
    if (!Number.isSafeInteger(candidate) || Number(candidate) < 1 || Number(candidate) > 256) {
      invalid("invalid-source");
    }
    return Number(candidate);
  };
  const policy: DocumentationQualityPolicyV1 = {
    schemaVersion: 1,
    kind: "docsfab-documentation-quality-policy",
    productName: qualityText(root.productName),
    documentationPaths,
    navigationRoot: qualityPath(root.navigationRoot),
    gettingStartedPath: qualityPath(root.gettingStartedPath),
    referencePath: qualityPath(root.referencePath),
    iaInputPath: qualityPath(root.iaInputPath),
    maintenancePath: qualityPath(root.maintenancePath),
    roadmapPath: qualityPath(root.roadmapPath),
    ownerPath: qualityPath(root.ownerPath),
    validationPath: qualityPath(root.validationPath),
    currentVersion: qualityText(root.currentVersion),
    reviewedAt: qualityText(root.reviewedAt),
    maximumPurposeHeadingsPerDocument: positiveInteger(root.maximumPurposeHeadingsPerDocument),
    maximumSectionsPerDocument: positiveInteger(root.maximumSectionsPerDocument),
    requiredTopics,
  };
  if (canonicalJson(policy) !== text) invalid("invalid-source");
  return deepFreeze(policy);
}

function qualityPath(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    invalid("invalid-source");
  }
  return value;
}

function qualityPaths(value: unknown, allowEmpty: boolean): string[] {
  if (!Array.isArray(value) || value.length > 64 || (!allowEmpty && value.length === 0)) {
    invalid("invalid-source");
  }
  const result = value.map(qualityPath);
  if (!isSortedUnique(result)) invalid("invalid-source");
  return result;
}

function qualityText(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    /[\r\n\0]/u.test(value)
  )
    invalid("invalid-source");
  return value;
}

function countMarkdownHeadings(text: string, exactDepth?: number): number {
  return text.split("\n").filter((line) => {
    const match = /^(#{1,6})\s+\S/u.exec(line);
    return match && (exactDepth === undefined || match[1]!.length === exactDepth);
  }).length;
}

function hasImageWithoutAlt(text: string): boolean {
  return /!\[\]\([^\r\n)]+\)/u.test(text);
}

function qualityCapabilities(
  gateId: DocumentationMaturityGateId,
): DocumentationMaturityCapability[] {
  if (gateId === "G0") return ["repository-inventory"];
  if (gateId === "G1" || gateId === "G4" || gateId === "G5") {
    return ["release-documentation-readiness"];
  }
  if (gateId === "G2") return ["content-ir", "ia-diagnostics", "ia-self-service"];
  return ["content-ir", "impact-analysis"];
}

function qualityWorkflow(gateId: DocumentationMaturityGateId): {
  name: WorkflowName;
  stepId: string;
} {
  if (gateId === "G0" || gateId === "G1" || gateId === "G5") {
    return { name: "readiness", stepId: "assess-readiness" };
  }
  if (gateId === "G2") {
    return { name: "ia-analysis", stepId: "analyze-information-architecture" };
  }
  if (gateId === "G3") return { name: "review-documentation", stepId: "audit-documentation" };
  return { name: "update-documentation", stepId: "write-documentation" };
}
