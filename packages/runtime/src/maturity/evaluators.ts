// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Documentation maturity evaluators — public façade.
 * Implementation is layered across catalog, host-policy, gate, quality,
 * mappers, and dialect modules (contract-kit bottoms).
 */

export {
  DOCUMENTATION_MATURITY_EVALUATOR_SCHEMA_VERSION,
  DOCUMENTATION_MATURITY_EVALUATOR_CATALOG_VERSION,
  DOCUMENTATION_MATURITY_CAPABILITIES,
  DOCUMENTATION_MATURITY_DEFECT_CLASSES,
  DOCUMENTATION_MATURITY_EVALUATOR_CATALOG,
  documentationMaturityEvaluator,
  decodeDocumentationMaturityEvaluatorCatalog,
  type DocumentationMaturityCapability,
  type DocumentationMaturityDefectClass,
  type DocumentationMaturityEvaluatorCheckState,
  type DocumentationMaturityEvaluatorInputDefinitionV1,
  type DocumentationMaturityEvaluatorCheckDefinitionV1,
  type DocumentationMaturityEvaluatorDefinitionV1,
  type DocumentationMaturityEvaluatorCatalogV1,
} from "./evaluators/catalog.js";

export {
  DOCUMENTATION_MATURITY_HOST_POLICY_PATH,
  DOCUMENTATION_QUALITY_POLICY_PATH,
  type DocumentationProductNeed,
  type DocumentationRepositoryType,
  type DocumentationSurfaceType,
} from "./evaluators/host-policy.js";

export { DocumentationMaturityEvaluatorError } from "./evaluators/dialect.js";

export {
  evaluateDocumentationMaturityGate,
  decodeDocumentationMaturityGateEvaluation,
  validateDocumentationMaturityGateEvaluation,
  type DocumentationMaturityMappedCheckV1,
  type DocumentationMaturitySemanticReviewV1,
  type DocumentationMaturitySemanticOverlayV1,
  type DocumentationMaturityCapabilityMappingV1,
  type DocumentationMaturityAdaptedWorkUnitV1,
  type DocumentationMaturityGateEvaluationV1,
} from "./evaluators/gate.js";

export {
  mapRepositoryDocumentationQuality,
  type DocumentationQualityPolicyV1,
} from "./evaluators/quality.js";

export {
  mapRepositoryInventoryToG0,
  mapReleaseDocumentationReadiness,
  mapIaCapabilitiesToG2,
  mapIaSelfServiceInputToG2,
  mapContentIndexToG3,
  mapImpactAnalysisToMaturity,
  mapRoadmapLedgerToG5,
  mapWorkflowOutcomeToMaturity,
} from "./evaluators/mappers.js";
