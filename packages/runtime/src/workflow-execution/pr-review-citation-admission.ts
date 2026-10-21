// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  assertGithubPrReviewBasis,
  type GithubPrReviewBasis,
} from "../inputs/adapters/github-pr-provider.js";
import type { PrReviewBasisBindingV1 } from "../inputs/pr-review-basis-binding.js";
import { bindPrReviewBasis } from "../inputs/pr-review-basis-binding.js";
import type {
  PrReviewCitationAdmissionV1,
  SourceEvidenceRunnerBinding,
} from "../execution/contracts/execution-services.js";
import type { WorkflowDefinition } from "../workflow-contracts/contracts.js";

interface AdmissionState {
  readonly basis: GithubPrReviewBasis;
  readonly basisBinding: PrReviewBasisBindingV1;
  readonly runId: string;
  readonly requestSha256: string;
  readonly sourceBindingSha256: string;
  readonly policySha256: string;
}

const minted = new WeakMap<object, AdmissionState>();
const allowed = new Map([
  ["review-documentation", "review-documentation"],
  ["verify-technical-accuracy", "verify-technical-accuracy"],
]);

/** Only the CLI host may mint this after the live basis and one source binding exist. */
export function createPrReviewCitationAdmission(
  state: AdmissionState,
): PrReviewCitationAdmissionV1 {
  assertGithubPrReviewBasis(state.basis);
  if (
    state.basisBinding.basisSha256 !== bindPrReviewBasis(state.basis).basisSha256 ||
    state.sourceBindingSha256.length === 0
  ) {
    throw new Error("PR citation admission requires bound basis and source evidence.");
  }
  const admission = Object.freeze({ kind: "docsfab-pr-review-citation-admission" as const });
  minted.set(admission, state);
  return admission;
}

export function assertPrReviewCitationAdmission(input: {
  readonly admission: PrReviewCitationAdmissionV1 | undefined;
  readonly workflow: WorkflowDefinition;
  readonly runId: string;
  readonly requestSha256: string;
  readonly basisBinding: PrReviewBasisBindingV1 | undefined;
  readonly sourceBindingSha256: string | undefined;
  readonly sourceEvidence: SourceEvidenceRunnerBinding | undefined;
}): void {
  const state = input.admission && minted.get(input.admission);
  if (!state) throw new Error("PR review citation admission requires a live host capability.");
  assertGithubPrReviewBasis(state.basis);
  if (
    input.workflow.name !== "review-documentation" ||
    state.runId !== input.runId ||
    state.requestSha256 !== input.requestSha256 ||
    state.basisBinding.basisSha256 !== input.basisBinding?.basisSha256 ||
    state.basisBinding.basisSha256 !== bindPrReviewBasis(state.basis).basisSha256 ||
    state.sourceBindingSha256 !== input.sourceBindingSha256 ||
    state.policySha256 !== input.sourceEvidence?.policy.policySha256
  ) {
    throw new Error("PR review citation admission differs from the bound run or source policy.");
  }
}

/** Independent mode/step gate; a policy's skill list alone cannot register citation. */
export function prReviewStepAdmitsCitation(input: {
  readonly admission: PrReviewCitationAdmissionV1 | undefined;
  readonly workflow: WorkflowDefinition;
  readonly stepId: string;
  readonly skill: string;
  readonly mode: string;
}): boolean {
  if (!input.admission || !minted.has(input.admission)) return false;
  return (
    input.workflow.name === "review-documentation" &&
    input.mode === "read-only" &&
    allowed.get(input.stepId) === input.skill
  );
}
