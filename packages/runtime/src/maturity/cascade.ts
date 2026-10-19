// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Documentation maturity cascade — public façade.
 * Implementation is layered across dialect, tracker, selection, and reporting.
 */

export {
  DOCUMENTATION_MATURITY_CASCADE_ALGORITHM_VERSION,
  DOCUMENTATION_MATURITY_CASCADE_POLICY_PATH,
  DocumentationMaturityCascadeError,
  decodeDocumentationMaturityCascadeAssessment,
  decodeDocumentationMaturityCascadeTrackerObservation,
  decodeDocumentationMaturityCascadeSelection,
  type DocumentationMaturityCascadeAssessmentV1,
  type DocumentationMaturityCascadeTrackerObservationV1,
  type DocumentationMaturityCascadeRankV1,
  type DocumentationMaturityCascadeRankInspectionV1,
  type DocumentationMaturityCascadeSelectionInspectionV1,
  type DocumentationMaturityGitLabBindingInspectionV1,
  type DocumentationMaturityPrerequisiteExceptionInspectionV1,
  type DocumentationMaturityCandidateBudgetInspectionV1,
  type DocumentationMaturityCascadeCandidateStatus,
  type DocumentationMaturityCascadeCandidateDecisionV1,
  type DocumentationMaturityCascadeOutcomeV1,
  type DocumentationMaturityCascadeSelectionV1,
  type DocumentationMaturityCascadeErrorCode,
} from "./cascade/dialect.js";

export {
  assessDocumentationMaturityCascade,
  validateDocumentationMaturityCascadeAssessment,
  selectDocumentationMaturityWorkUnit,
  validateDocumentationMaturityCascadeSelection,
} from "./cascade/selection.js";

export {
  observeDocumentationMaturityCascadeTracker,
  observeDocumentationMaturityCascadeTrackerFromHostSnapshot,
} from "./cascade/tracker.js";

export {
  inspectDocumentationMaturityWorkUnitRanking,
  inspectDocumentationMaturityCascadeSelection,
  inspectDocumentationMaturityGitLabBinding,
  inspectDocumentationMaturityPrerequisiteException,
  inspectDocumentationMaturityCandidateBudget,
} from "./cascade/reporting.js";
