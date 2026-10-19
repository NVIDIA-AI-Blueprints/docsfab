// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Public compatibility surface for failure classification domain leaves.
 * The leaves keep limit-failure reporting loadable without importing the
 * model-output runtime module, which resolves limits at module load.
 */
export {
  FAILURE_CLASSES,
  FAILURE_CLASS_MEANINGS,
  FAILURE_LAYERS,
  describeFailureClassification,
  failureClassification,
  isFailureClass,
  isFailureLayer,
  readFailureClassification,
  type FailureClass,
  type FailureClassificationV1,
  type FailureLayer,
} from "./failure-class.js";
export {
  INFERENCE_CATEGORY_FAILURE_CLASSES,
  PROVIDER_STATUS_ERROR_FAILURE_CLASSES,
  PROVIDER_UNANSWERED_ERROR_FAILURE_CLASSES,
  REJECTION_FAMILY_FAILURE_CLASSES,
  OPERATOR_CODE_FAMILY_FAILURE_CLASSES,
  LIMIT_REFUSAL_CODES,
  INFERENCE_REJECTION_FAILURE_CLASSES,
} from "./failure-classification/inference-codes.js";
export {
  QUALITY_VALIDATION_REJECTION_FAILURE_CLASSES,
  qualityRejectionFailureClass,
  QUALITY_ARTIFACT_FAILURE_CLASSES,
} from "./failure-classification/quality-codes.js";
export {
  RUN_FAILURE_CODE_CLASSES,
  type RunFailureCode,
  WORKFLOW_OUTCOME_REJECTION_FAILURE_CLASSES,
  workflowOutcomeRejectionFailure,
  AUTHORING_CANDIDATE_REJECTION_FAILURE_CLASSES,
  authoringCandidateRejectionFailure,
  markRunAuthoringCandidateRejection,
  editorialFinalizationRejectionFailure,
  markRunEditorialFinalizationRejection,
  runFailure,
} from "./failure-classification/run-codes.js";
export {
  OUTPUT_LIMIT_MODEL_FINISH_REASONS,
  OUTPUT_LIMIT_FINISH_REASONS,
  inferenceRejectionFailureClass,
  ATTEMPT_DEADLINE_IN_TOOL_LOOP,
  ATTEMPT_DEADLINE_AWAITING_PROVIDER,
  classifyInferenceFailure,
  classifyInferenceAttempt,
  classifyQualityValidationFailure,
} from "./failure-classification/inference-classification.js";
export {
  operatorCodeFailureClass,
  markRunRefusal,
  classifyThrownFailure,
  classifyStepFailure,
  readStepFailure,
  readRunFailure,
  attachRunFailureClassifications,
  classifyingRunStore,
  serializingRunStore,
  markRunFailure,
  markRunThrownFailure,
  type FailureOccurrenceV1,
  projectRunFailureOccurrences,
} from "./failure-classification/run-projection.js";
