// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { DocumentationMaturityGateId } from "../contracts.js";
import {
  assertInertPlainData,
  canonicalDigest,
  canonicalJson,
  deepFreeze,
  invalid,
} from "./dialect.js";

export const DOCUMENTATION_MATURITY_EVALUATOR_SCHEMA_VERSION = 1 as const;
export const DOCUMENTATION_MATURITY_EVALUATOR_CATALOG_VERSION = "1.0.0" as const;

export const DOCUMENTATION_MATURITY_CAPABILITIES = [
  "repository-inventory",
  "source-readiness",
  "release-documentation-readiness",
  "content-ir",
  "ia-diagnostics",
  "ia-semantic-review",
  "ia-self-service",
  "documentation-audit",
  "documentation-polish",
  "impact-analysis",
  "roadmap-maintenance",
] as const;
export type DocumentationMaturityCapability = (typeof DOCUMENTATION_MATURITY_CAPABILITIES)[number];

export const DOCUMENTATION_MATURITY_DEFECT_CLASSES = [
  "missing-infrastructure",
  "missing-content",
  "structural-defect",
  "quality-defect",
  "governance-defect",
] as const;
export type DocumentationMaturityDefectClass =
  (typeof DOCUMENTATION_MATURITY_DEFECT_CLASSES)[number];

export type DocumentationMaturityEvaluatorCheckState =
  | "satisfied"
  | "finding"
  | "unknown"
  | "blocked";

export interface DocumentationMaturityEvaluatorInputDefinitionV1 {
  id: string;
  capability: DocumentationMaturityCapability;
  required: boolean;
  contract: string;
  layer: "deterministic" | "semantic";
}

export interface DocumentationMaturityEvaluatorCheckDefinitionV1 {
  id: string;
  sourceInputIds: string[];
  mode: "deterministic";
  defectClass: DocumentationMaturityDefectClass;
}

export interface DocumentationMaturityEvaluatorDefinitionV1 {
  schemaVersion: 1;
  kind: "docsfab-documentation-maturity-evaluator-definition";
  id: string;
  version: "1.0.0";
  gateId: DocumentationMaturityGateId;
  applicability: "always" | "explicit-product-need";
  inputs: DocumentationMaturityEvaluatorInputDefinitionV1[];
  checks: DocumentationMaturityEvaluatorCheckDefinitionV1[];
  semanticReview: {
    policy: "optional-after-deterministic";
    authority: "authenticated-workflow-outcome-only";
    inputIds: string[];
  } | null;
  evidenceLimits: {
    maxMappings: number;
    maxFindings: number;
    allowed: Array<
      | "host-authenticated-source"
      | "repository-observation"
      | "authenticated-bounded-search"
      | "authenticated-workflow-outcome"
    >;
    forbidden: Array<
      "prompt-claim" | "folder-name-applicability" | "unbounded-absence" | "self-rehashed-source"
    >;
  };
  evaluatorSha256: string;
}

export interface DocumentationMaturityEvaluatorCatalogV1 {
  schemaVersion: 1;
  kind: "docsfab-documentation-maturity-evaluator-catalog";
  version: typeof DOCUMENTATION_MATURITY_EVALUATOR_CATALOG_VERSION;
  evaluators: DocumentationMaturityEvaluatorDefinitionV1[];
  catalogSha256: string;
}

type DefinitionSeed = Omit<
  DocumentationMaturityEvaluatorDefinitionV1,
  "schemaVersion" | "kind" | "version" | "semanticReview" | "evidenceLimits" | "evaluatorSha256"
> & { semantic: boolean };

const DEFINITION_SEEDS: readonly DefinitionSeed[] = [
  {
    id: "documentation-foundations",
    gateId: "G0",
    applicability: "always",
    semantic: true,
    inputs: [
      input("inventory", "repository-inventory", true, "docsfab-repository-discovery-inventory@2"),
      input("readiness", "source-readiness", false, "docsfab-workflow-outcome@1", "semantic"),
    ],
    checks: [
      check("inventory-structure", ["inventory"], "deterministic", "missing-infrastructure"),
      check("inventory-text", ["inventory"], "deterministic", "missing-infrastructure"),
      check("documentation-input-surface", ["inventory"], "deterministic", "missing-content"),
      check("validation-infrastructure", ["inventory"], "deterministic", "missing-infrastructure"),
    ],
  },
  {
    id: "documentation-coverage",
    gateId: "G1",
    applicability: "explicit-product-need",
    semantic: true,
    inputs: [
      input(
        "release-readiness",
        "release-documentation-readiness",
        true,
        "docsfab-release-documentation-readiness@1",
      ),
      input("audit", "documentation-audit", false, "docsfab-workflow-outcome@1", "semantic"),
    ],
    checks: [
      check("audience-coverage", ["release-readiness"], "deterministic", "missing-content"),
      check(
        "surface-infrastructure",
        ["release-readiness"],
        "deterministic",
        "missing-infrastructure",
      ),
      check("journey-coverage", ["release-readiness"], "deterministic", "missing-content"),
      check("task-reference-coverage", ["release-readiness"], "deterministic", "missing-content"),
      check(
        "trust-and-release-coverage",
        ["release-readiness"],
        "deterministic",
        "missing-content",
      ),
    ],
  },
  {
    id: "documentation-structure",
    gateId: "G2",
    applicability: "explicit-product-need",
    semantic: true,
    inputs: [
      input("content-ir", "content-ir", true, "docsfab-content-index@2"),
      input("ia", "ia-diagnostics", true, "docsfab-ia-structural-diagnostics@1"),
      input("ia-input", "ia-self-service", true, "docsfab-ia-input-package@1"),
      input(
        "release-readiness",
        "release-documentation-readiness",
        false,
        "docsfab-release-documentation-readiness@1",
      ),
      input("ia-review", "ia-semantic-review", false, "docsfab-workflow-outcome@1", "semantic"),
    ],
    checks: [
      check("content-structure-indexed", ["content-ir"], "deterministic", "structural-defect"),
      check(
        "navigation-and-hierarchy",
        ["ia", "release-readiness"],
        "deterministic",
        "structural-defect",
      ),
      check("page-boundaries-and-naming", ["ia"], "deterministic", "structural-defect"),
      check("ia-self-service-input", ["ia-input"], "deterministic", "missing-infrastructure"),
    ],
  },
  {
    id: "documentation-content",
    gateId: "G3",
    applicability: "explicit-product-need",
    semantic: true,
    inputs: [
      input("audit", "documentation-audit", false, "docsfab-workflow-outcome@1", "semantic"),
      input("content-ir", "content-ir", true, "docsfab-content-index@2"),
      input("impact", "impact-analysis", false, "docsfab-impact-analysis@1"),
    ],
    checks: [
      check("article-completeness", ["content-ir"], "deterministic", "quality-defect"),
      check("article-modularity", ["content-ir"], "deterministic", "structural-defect"),
      check("article-accuracy", ["content-ir"], "deterministic", "quality-defect"),
      check("article-freshness", ["impact"], "deterministic", "quality-defect"),
    ],
  },
  {
    id: "documentation-polish",
    gateId: "G4",
    applicability: "explicit-product-need",
    semantic: true,
    inputs: [
      input(
        "release-readiness",
        "release-documentation-readiness",
        false,
        "docsfab-release-documentation-readiness@1",
      ),
      input("audit", "documentation-audit", false, "docsfab-workflow-outcome@1", "semantic"),
      input("polish", "documentation-polish", false, "docsfab-workflow-outcome@1", "semantic"),
    ],
    checks: [
      check("presentation-polish", ["release-readiness"], "deterministic", "quality-defect"),
      check("examples", ["release-readiness"], "deterministic", "quality-defect"),
      check("accessibility", ["release-readiness"], "deterministic", "quality-defect"),
      check("consistency", ["release-readiness"], "deterministic", "quality-defect"),
    ],
  },
  {
    id: "documentation-maintenance",
    gateId: "G5",
    applicability: "explicit-product-need",
    semantic: false,
    inputs: [
      input(
        "release-readiness",
        "release-documentation-readiness",
        true,
        "docsfab-release-documentation-readiness@1",
      ),
      input("impact", "impact-analysis", false, "docsfab-impact-analysis@1"),
      input("roadmap", "roadmap-maintenance", false, "docsfab-roadmap-ledger@1"),
    ],
    checks: [
      check("documentation-ownership", ["release-readiness"], "deterministic", "governance-defect"),
      check(
        "validation-lifecycle",
        ["release-readiness", "impact"],
        "deterministic",
        "governance-defect",
      ),
      check(
        "freshness-and-review-policy",
        ["release-readiness", "impact"],
        "deterministic",
        "governance-defect",
      ),
      check(
        "roadmap-maintenance",
        ["roadmap", "release-readiness"],
        "deterministic",
        "governance-defect",
      ),
    ],
  },
];

function input(
  id: string,
  capability: DocumentationMaturityCapability,
  required: boolean,
  contract: string,
  layer: DocumentationMaturityEvaluatorInputDefinitionV1["layer"] = "deterministic",
): DocumentationMaturityEvaluatorInputDefinitionV1 {
  return { id, capability, required, contract, layer };
}

function check(
  id: string,
  sourceInputIds: string[],
  mode: DocumentationMaturityEvaluatorCheckDefinitionV1["mode"],
  defectClass: DocumentationMaturityDefectClass,
): DocumentationMaturityEvaluatorCheckDefinitionV1 {
  return { id, sourceInputIds, mode, defectClass };
}

function buildCatalog(): DocumentationMaturityEvaluatorCatalogV1 {
  const evaluators = DEFINITION_SEEDS.map((seed) => {
    const { semantic, ...definition } = seed;
    const deterministicInputIds = new Set(
      definition.inputs
        .filter((candidate) => candidate.layer === "deterministic")
        .map((candidate) => candidate.id),
    );
    const semanticInputIds = definition.inputs
      .filter((candidate) => candidate.layer === "semantic")
      .map((candidate) => candidate.id);
    if (
      definition.checks.some(
        (candidate) =>
          candidate.sourceInputIds.length === 0 ||
          candidate.sourceInputIds.some(
            (sourceInputId) => !deterministicInputIds.has(sourceInputId),
          ),
      ) ||
      semantic !== semanticInputIds.length > 0
    ) {
      throw new Error(`Invalid evaluator layering for ${definition.gateId}.`);
    }
    const body = {
      schemaVersion: 1 as const,
      kind: "docsfab-documentation-maturity-evaluator-definition" as const,
      version: "1.0.0" as const,
      ...definition,
      semanticReview: semantic
        ? {
            policy: "optional-after-deterministic" as const,
            authority: "authenticated-workflow-outcome-only" as const,
            inputIds: semanticInputIds,
          }
        : null,
      evidenceLimits: {
        maxMappings: 16,
        maxFindings: 256,
        allowed: [
          "host-authenticated-source",
          "repository-observation",
          "authenticated-bounded-search",
          "authenticated-workflow-outcome",
        ] as DocumentationMaturityEvaluatorDefinitionV1["evidenceLimits"]["allowed"],
        forbidden: [
          "prompt-claim",
          "folder-name-applicability",
          "unbounded-absence",
          "self-rehashed-source",
        ] as DocumentationMaturityEvaluatorDefinitionV1["evidenceLimits"]["forbidden"],
      },
    };
    return { ...body, evaluatorSha256: canonicalDigest(body) };
  });
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-documentation-maturity-evaluator-catalog" as const,
    version: DOCUMENTATION_MATURITY_EVALUATOR_CATALOG_VERSION,
    evaluators,
  };
  return deepFreeze({ ...body, catalogSha256: canonicalDigest(body) });
}

export const DOCUMENTATION_MATURITY_EVALUATOR_CATALOG = buildCatalog();

export function documentationMaturityEvaluator(
  gateId: DocumentationMaturityGateId,
): DocumentationMaturityEvaluatorDefinitionV1 {
  return DOCUMENTATION_MATURITY_EVALUATOR_CATALOG.evaluators.find(
    (candidate) => candidate.gateId === gateId,
  )!;
}

export function decodeDocumentationMaturityEvaluatorCatalog(
  value: unknown,
): DocumentationMaturityEvaluatorCatalogV1 {
  assertInertPlainData(value);
  if (canonicalJson(value) !== canonicalJson(DOCUMENTATION_MATURITY_EVALUATOR_CATALOG)) {
    invalid("invalid-catalog");
  }
  return DOCUMENTATION_MATURITY_EVALUATOR_CATALOG;
}
