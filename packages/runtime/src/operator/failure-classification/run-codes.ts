// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Operator, run, and workflow outcome code classes. */

import type { RunRecord } from "../../records/contracts.js";
import type { FileRunStoreErrorCode } from "../../records/file-store.js";

import type { RepositoryConfigurationRefusalCodeV1 } from "../../repository/workspace/configuration-refusal.js";

import type {
  WorkflowOutcomeRejectionCode,
  WorkflowOutcomeRejectionV1,
} from "../../workflow-execution/outcome-rejection.js";
import {
  WORKFLOW_SEARCH_CONTRACT_FAILURE_CODE,
  type WorkflowSearchFailureCode,
} from "../../workflow-execution/search-failure-codes.js";
import type {
  AuthoringCandidateRejectionCode,
  AuthoringCandidateRejectionV1,
} from "../../workflow-execution/authoring-candidate.js";
import type {
  EditorialFinalizationRejectionCode,
  EditorialFinalizationRejectionV1,
} from "../../workflow-execution/editorial-finalization-rejection.js";
import type { RequiredCheckRefusalCode } from "../../workflow-execution/workflow-checks.js";
import {
  failureClassification,
  readFailureClassification,
  type FailureClass,
  type FailureClassificationV1,
} from "../failure-class.js";

/**
 * CLI and checkout refusals: each is something the operator typed or
 * configured. The CLI sets are not type-imported because the CLI sits above the
 * workflow runner that imports this module; a test enumerates them instead.
 */
export const CLI_REFUSAL_FAILURE_CLASSES = {
  // The packaged workflow catalog a step list is read from is missing or unreadable.
  "workflow-catalog-unavailable": "infrastructure",
  "source-option-value-missing": "operator-input",
  "source-option-form-unrecognized": "operator-input",
  "selector-option-value-missing": "operator-input",
  "unknown-option": "operator-input",
  "review-target-workflow": "operator-input",
  "review-target-conflict": "operator-input",
  "rescope-from-repeated": "operator-input",
  "rescope-from-conflict": "operator-input",
  "rescope-from-incomplete": "operator-input",
  "rescope-from-preview": "operator-input",
  "rescope-from-revision": "operator-input",
  "repository-option-value-missing": "operator-input",
  "repository-option-repeated": "operator-input",
  "repository-not-local": "operator-input",
  "repository-unavailable": "operator-input",
  "help-not-combinable": "operator-input",
  "hooks-path": "operator-input",
  "filesystem-monitor": "operator-input",
  "attributes-file": "operator-input",
  "excludes-file": "operator-input",
  "content-filter": "operator-input",
  "diff-external-driver": "operator-input",
  "diff-named-driver": "operator-input",
  "remote-transport-helper": "operator-input",
  "archive-command": "operator-input",
  "included-configuration": "operator-input",
  "worktree-configuration-unreadable": "operator-input",
  // `init` storage: `INIT_CONFIGURATION_ROOT_REFUSAL_CODES` in init/storage.ts.
  "configuration-root-not-canonical": "operator-input",
  "configuration-root-not-private": "operator-input",
  // `docsfab sessions`: `LOCAL_SESSION_REFUSAL_CODES` in live-agent/local-sessions.ts.
  "live-agent-session-arguments-invalid": "operator-input",
  "live-agent-session-id-invalid": "operator-input",
  "live-agent-session-not-found": "operator-input",
  "live-agent-session-entry-unsafe": "operator-input",
  "live-agent-session-directory-unsafe": "operator-input",
  "live-agent-session-confirmation-mismatch": "operator-input",
  "live-agent-session-removal-incomplete": "infrastructure",
  // `DOCSFAB_ANSWER_SUBMISSION` outside its closed options (config/answer-submission.ts).
  "answer-submission-option-invalid": "operator-input",
  // `do` and `run` delivery flags: `DELIVERY_FLAG_REFUSAL_CODES` in cli/delivery-grants.ts.
  "delivery-flag-conflict": "operator-input",
  "workflow-delivery-flag-unsupported": "operator-input",
  "publication-prohibition-conflict": "operator-input",
  // `do --source` / `--pr` on a route that cannot bind it (cli/commands/do.ts).
  "source-route-unsupported": "operator-input",
  // An InputAsk continuation that cannot carry the stopped run's evidence:
  // `OPERATOR_INPUT_FILL_ERROR_CODES` in inputs/operator-input-fill.ts.
  "retained-reader-input-malformed": "contract-shape",
  "continue-planner-input-unsupported": "operator-input",
  "continue-revision-mismatch": "operator-input",
  "retained-evidence-bindings-malformed": "contract-shape",
  "continue-binding-forge-unsupported": "operator-input",
  "continue-release-unsupported": "operator-input",
  "continue-binding-conflict": "operator-input",
  "continue-binding-moved": "operator-input",
  // `--change`: `CHANGE_SOURCE_REFUSAL_CODES` in inputs/change-source.ts.
  "change-source-option-value-missing": "operator-input",
  "change-source-option-form-unrecognized": "operator-input",
  "change-source-selector-repeated": "operator-input",
  "change-source-selector-grammar": "operator-input",
  "change-source-kind-unsupported": "operator-input",
  "change-source-selector-conflict": "operator-input",
  "change-source-workflow-unsupported": "operator-input",
  "change-source-resume-unsupported": "operator-input",
  "change-source-date-window-conflict": "operator-input",
  "change-source-revision-unresolved": "operator-input",
  "change-source-history-unavailable": "operator-input",
  "change-source-no-merge-base": "operator-input",
  "change-source-empty-range": "operator-input",
  "change-source-integrity-mismatch": "contract-shape",
  "change-source-grafts-present": "operator-input",
  "change-source-encoding-unsupported": "operator-input",
  "change-source-credential-present": "operator-input",
  "change-source-limits-inconsistent": "operator-input",
  "change-source-git-failed": "infrastructure",
  "change-source-resolution-missing": "contract-shape",
  "change-source-mr-objects-unavailable": "operator-input",
  "change-source-mr-closed-unmerged": "operator-input",
  "change-source-mr-locked": "operator-input",
  "change-source-mr-diff-refs-missing": "infrastructure",
  "change-source-mr-moved": "operator-input",
  "change-source-github-url-credentials": "operator-input",
  "change-source-github-url-insecure": "operator-input",
  "change-source-github-url-grammar": "operator-input",
  "change-source-github-url-partial": "operator-input",
  "change-source-github-compare-unsupported": "operator-input",
  "change-source-github-pull-closed-unmerged": "operator-input",
  "change-source-github-head-moved": "operator-input",
  "change-source-github-incomplete": "infrastructure",
  "change-source-github-tree-truncated": "infrastructure",
  "change-source-github-redirect-cross-host": "infrastructure",
  "change-source-github-rate-limited": "infrastructure",
  "change-source-github-forbidden": "operator-input",
  "change-source-github-not-found": "operator-input",
  "change-source-github-request-failed": "infrastructure",
  "change-source-github-unreachable": "infrastructure",
  "change-source-github-response-invalid": "contract-shape",
  "change-source-record-unbound": "contract-shape",
  "change-source-mr-forge-incomplete": "infrastructure",
  "change-source-mr-forge-overflow": "infrastructure",
  "change-source-mr-forge-text-replaced": "operator-input",
  "change-source-mr-forge-page-bound": "infrastructure",
  "change-source-github-two-dot-not-ancestor": "operator-input",
  "change-source-github-pr-not-pull-request": "operator-input",
  "change-source-release-form-unsupported": "operator-input",
  "change-source-release-no-units": "operator-input",
  "change-source-release-observations-exceeded": "bound",
  "change-source-release-index-over-read-budget": "bound",
} as const satisfies Record<RepositoryConfigurationRefusalCodeV1, FailureClass> &
  Record<string, FailureClass>;

/** Run store failures, raised as `run-store-<code>`. */
export const RUN_STORE_FAILURE_CLASSES = {
  "run-store-invalid-root": "operator-input",
  "run-store-unsupported-platform": "infrastructure",
  "run-store-unsafe-root": "operator-input",
  "run-store-owner-mismatch": "operator-input",
  "run-store-insecure-permissions": "operator-input",
  "run-store-unsafe-record-id": "contract-shape",
  "run-store-serialization-failed": "contract-shape",
  "run-store-record-exists": "contract-shape",
  "run-store-unsafe-entry": "infrastructure",
  "run-store-record-not-found": "infrastructure",
  "run-store-invalid-record": "contract-shape",
  "run-store-write-failed": "infrastructure",
  "run-store-bounds-exceeded": "bound",
} as const satisfies Record<`run-store-${FileRunStoreErrorCode}`, FailureClass>;

/**
 * Run-level failures the workflow runner raises after or around its steps,
 * and the classifier's own signal codes. `unclassified-*` and `uncoded-error`
 * are catalogued on purpose: they name a gap, visibly, as `unknown`.
 */
export const RUN_FAILURE_CODE_CLASSES = Object.freeze({
  "workflow-cancelled": "cancelled",
  // A locked quality derivation fault is terminal host infrastructure, not a
  // model rejection or a retryable validation-binding failure.
  "quality-derivation-failed": "infrastructure",
  "patch-persistence-failed": "infrastructure",
  "evidence-provenance-rejected": "contract-shape",
  "review-result-retention-failed": "infrastructure",
  "impact-postflight-failed": "infrastructure",
  "write-outside-authorized-scope": "model-content",
  "empty-write-result": "model-content",
  "no-change-produced-changes": "model-content",
  // The required-check gate's refusals record their inner code (#1918). Only
  // a check that ran and failed on the candidate has unknown origin without
  // a validated baseline comparison. Editing the instructions remains a
  // model-content refusal. A check that could not run is a limitation.
  "required-check-failed": "unknown",
  "required-check-instructions-altered": "model-content",
  "required-check-evidence-missing": "contract-shape",
  "required-check-evidence-stale": "contract-shape",
  "required-check-snapshot-unavailable": "infrastructure",
  // Older records: one code for every required-check refusal. It covers
  // several causes, so a refusal now records its inner code instead.
  "required-check-refused": "unknown",
  "branch-coverage-unavailable": "contract-shape",
  // Older records; a refusal now records its inner code instead.
  "editorial-evidence-inadmissible": "contract-shape",
  // Terminal editorial finalization refused the final decision after every
  // step succeeded, by the refusing contract's own code. Two codes judge
  // model replies: the decision's `independent-rejection` (the assessments do
  // not support the final decision) and the host's `conflicting-assessment`
  // (at finalization, the evaluator's rationale repeats the planner's). Every
  // other code re-checks evidence the host bound.
  "editorial-finalization-branch-coverage-invalid-shape": "contract-shape",
  "editorial-finalization-branch-coverage-invalid-value": "contract-shape",
  "editorial-finalization-branch-coverage-credential-material": "contract-shape",
  "editorial-finalization-branch-coverage-digest-mismatch": "contract-shape",
  "editorial-finalization-branch-coverage-manifest-mismatch": "contract-shape",
  "editorial-finalization-branch-coverage-coverage-unverified": "contract-shape",
  "editorial-finalization-host-invalid-shape": "contract-shape",
  "editorial-finalization-host-invalid-value": "contract-shape",
  "editorial-finalization-host-credential-material": "contract-shape",
  "editorial-finalization-host-evidence-unavailable": "contract-shape",
  "editorial-finalization-host-identity-mismatch": "contract-shape",
  "editorial-finalization-host-producer-mismatch": "contract-shape",
  "editorial-finalization-host-conflicting-assessment": "model-content",
  "editorial-finalization-decision-invalid-shape": "contract-shape",
  "editorial-finalization-decision-invalid-value": "contract-shape",
  "editorial-finalization-decision-credential-material": "contract-shape",
  "editorial-finalization-decision-digest-mismatch": "contract-shape",
  "editorial-finalization-decision-evidence-unavailable": "contract-shape",
  "editorial-finalization-decision-producer-mismatch": "contract-shape",
  "editorial-finalization-decision-identity-mismatch": "contract-shape",
  "editorial-finalization-decision-independent-rejection": "model-content",
  "editorial-finalization-uncoded-error": "unknown",
  "execution-finalization-failed": "infrastructure",
  "task-lineage-incompatible": "contract-shape",
  // Older records; a refusal now records its inner code instead.
  "workflow-outcome-persistence-failed": "contract-shape",
  "preflight-application-rejected": "contract-shape",
  "preflight-reviewer-policy-rejected": "auth",
  "output-limit-reached": "bound",
  // The attempt timer fired while the model was still calling tools.
  "attempt-deadline-in-tool-loop": "bound",
  "attempt-deadline-awaiting-provider": "infrastructure",
  "authoring-revision-reset-failed": "infrastructure",
  "authoring-revision-observation-failed": "infrastructure",
  // A CREATE plan targets a path the revision already holds.
  "create-target-exists": "planning-refusal",
  // Governed workflow search could not complete (#1927), by the phase that
  // failed. A coordinator that could not finish its search over the
  // repository is `infrastructure`, like `impact-postflight-failed`; the plan,
  // evidence, and release-authority phases re-check host contracts. A search
  // error whose own code a table names keeps that code, and a decode bound
  // records its limit's refusal, so these rows cover only errors none names.
  "workflow-search-plan-failed": "contract-shape",
  "workflow-search-coordinator-failed": "infrastructure",
  "workflow-search-evidence-failed": "contract-shape",
  "workflow-search-release-authority-failed": "contract-shape",
  [WORKFLOW_SEARCH_CONTRACT_FAILURE_CODE]: "contract-shape",
  // A plan writer's index edit dropped a link the index held before the run.
  "navigation-companion-link-removed": "model-content",
  // The request interpretation before the first step: its provider failed or
  // its own deadline passed, or its prompt exceeds the bound input window.
  "request-intent-model-unavailable": "infrastructure",
  "request-intent-model-deadline": "infrastructure",
  "request-intent-model-input-budget": "bound",
  // An admitted plan does not address a page the request named.
  "omitted-mandatory-obligation": "planning-refusal",
  // A local run's plan wrote a page outside its documentation write roots, or
  // a file no root admits, or an agent instruction file or hidden path inside
  // the roots that the request does not name.
  "plan-outside-write-roots": "planning-refusal",
  "plan-target-not-writable": "planning-refusal",
  "plan-target-not-named": "planning-refusal",
  // Older records: either refusal, made only after an advisory reading.
  "advisory-plan-outside-write-roots": "planning-refusal",
  "unclassified-run-failure": "unknown",
  "unclassified-step-failure": "unknown",
  "uncoded-error": "unknown",
  "unreadable-rejection-code": "unknown",
} as const satisfies Record<RequiredCheckRefusalCode, FailureClass> & Record<string, FailureClass>);

export type RunFailureCode = keyof typeof RUN_FAILURE_CODE_CLASSES;

// Every governed search phase code must have a row above; a phase added to
// `WORKFLOW_SEARCH_PHASES` does not typecheck until it does.
const workflowSearchCodesCatalogued: WorkflowSearchFailureCode extends RunFailureCode
  ? true
  : false = true;
void workflowSearchCodesCatalogued;

// Every editorial finalization code must have a row above; a code added to a
// refusing contract does not typecheck until it does.
const editorialFinalizationCodesCatalogued: EditorialFinalizationRejectionCode extends RunFailureCode
  ? true
  : false = true;
void editorialFinalizationCodesCatalogued;

/**
 * The inner reason a workflow product outcome was refused, recorded as the
 * run's failure code. Every producer check is a host contract over admitted
 * evidence, so a refusal is `contract-shape`. Model-authored codes reach the
 * outcome only through the editorial assessment admission, which checks the
 * same grammar first.
 */
export const WORKFLOW_OUTCOME_REJECTION_FAILURE_CLASSES = Object.freeze({
  "workflow-outcome-release-readiness-invalid-authority": "contract-shape",
  "workflow-outcome-release-readiness-invalid-artifact": "contract-shape",
  "workflow-outcome-release-readiness-execution-incomplete": "contract-shape",
  "workflow-outcome-release-readiness-uncoded-error": "unknown",
  "workflow-outcome-projection-invalid-workflow": "contract-shape",
  "workflow-outcome-projection-invalid-record": "contract-shape",
  "workflow-outcome-projection-invalid-outcome": "contract-shape",
  "workflow-outcome-projection-invalid-evidence": "contract-shape",
  "workflow-outcome-projection-contradictory-outcome": "contract-shape",
  "workflow-outcome-projection-execution-product-mismatch": "contract-shape",
  "workflow-outcome-projection-migration-required": "contract-shape",
  "workflow-outcome-projection-uncoded-error": "unknown",
  "workflow-outcome-admission-invalid-outcome": "contract-shape",
  "workflow-outcome-admission-invalid-evidence": "contract-shape",
  "workflow-outcome-admission-contradictory-outcome": "contract-shape",
  "workflow-outcome-admission-execution-product-mismatch": "contract-shape",
  "workflow-outcome-admission-migration-required": "contract-shape",
  "workflow-outcome-admission-uncoded-error": "unknown",
} as const satisfies Record<WorkflowOutcomeRejectionCode, FailureClass>);

/** The run failure a workflow outcome refusal records: its inner code and class. */
export function workflowOutcomeRejectionFailure(
  rejection: Pick<WorkflowOutcomeRejectionV1, "code">,
): FailureClassificationV1 {
  return failureClassification(
    WORKFLOW_OUTCOME_REJECTION_FAILURE_CLASSES[rejection.code],
    "workflow",
    rejection.code,
  );
}

/**
 * The inner reason the create revision selection refused its admitted
 * candidate-zero evidence, recorded as the run's failure code.
 * `unverified-coverage` refuses a model-authored status; every other code
 * re-checks a host-built binding, so it is `contract-shape`.
 */
export const AUTHORING_CANDIDATE_REJECTION_FAILURE_CLASSES = Object.freeze({
  "authoring-candidate-invalid-shape": "contract-shape",
  "authoring-candidate-invalid-value": "contract-shape",
  "authoring-candidate-digest-mismatch": "contract-shape",
  "authoring-candidate-credential-material": "contract-shape",
  "authoring-candidate-host-path": "contract-shape",
  "authoring-candidate-schema-mismatch": "contract-shape",
  "authoring-candidate-wrong-candidate": "contract-shape",
  "authoring-candidate-wrong-ordinal": "contract-shape",
  "authoring-candidate-wrong-revision": "contract-shape",
  "authoring-candidate-wrong-plan": "contract-shape",
  "authoring-candidate-wrong-write-paths": "contract-shape",
  "authoring-candidate-stale-evidence": "contract-shape",
  "authoring-candidate-invalid-evidence": "contract-shape",
  "authoring-candidate-unverified-coverage": "model-content",
  "authoring-candidate-unknown-fact": "contract-shape",
  "authoring-candidate-duplicate-fact": "contract-shape",
  "authoring-candidate-unknown-issue": "contract-shape",
  "authoring-candidate-duplicate-issue": "contract-shape",
  "authoring-candidate-inconsistent-linked-issues": "contract-shape",
  "authoring-candidate-non-actionable": "contract-shape",
} as const satisfies Record<AuthoringCandidateRejectionCode, FailureClass>);

/** The run failure an authoring candidate refusal records: its inner code and class. */
export function authoringCandidateRejectionFailure(
  rejection: Pick<AuthoringCandidateRejectionV1, "code">,
): FailureClassificationV1 {
  return failureClassification(
    AUTHORING_CANDIDATE_REJECTION_FAILURE_CLASSES[rejection.code],
    "workflow",
    rejection.code,
  );
}

/**
 * Record an authoring candidate refusal that stopped the run between steps,
 * and return whether it recorded. An earlier class, cancellation, a run store
 * code, or a failed step names the first cause and wins.
 */
export function markRunAuthoringCandidateRejection(
  record: RunRecord,
  rejection: AuthoringCandidateRejectionV1 | undefined,
  options: { readonly cancelled: boolean; readonly storeCode?: FileRunStoreErrorCode },
): boolean {
  if (!rejection || options.cancelled || options.storeCode !== undefined) return false;
  if (readFailureClassification(record.failure)) return false;
  const steps = Array.isArray(record.steps) ? record.steps : [];
  if (steps.some((step) => step.status === "failed")) return false;
  record.authoringCandidateRejection = rejection;
  record.failure = authoringCandidateRejectionFailure(rejection);
  return true;
}

/** The run failure an editorial finalization refusal records: its inner code and class. */
export function editorialFinalizationRejectionFailure(
  rejection: Pick<EditorialFinalizationRejectionV1, "code">,
): FailureClassificationV1 {
  return runFailure(rejection.code);
}

/**
 * Record the inner reason terminal editorial finalization refused the run, and
 * return whether it recorded. An earlier class or a failed step names the
 * first cause and wins.
 */
export function markRunEditorialFinalizationRejection(
  record: RunRecord,
  rejection: EditorialFinalizationRejectionV1,
): boolean {
  if (readFailureClassification(record.failure)) return false;
  const steps = Array.isArray(record.steps) ? record.steps : [];
  if (steps.some((step) => step.status === "failed")) return false;
  record.editorialFinalizationRejection = rejection;
  record.failure = editorialFinalizationRejectionFailure(rejection);
  return true;
}

/** A catalogued run-level code at the workflow layer. */
export function runFailure(code: RunFailureCode): FailureClassificationV1 {
  return failureClassification(RUN_FAILURE_CODE_CLASSES[code], "workflow", code);
}
