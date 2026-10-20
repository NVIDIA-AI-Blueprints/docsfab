// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Step identity of the hosted semantic comparison workflow, shared by the
 * harness and host invoker so the step's reply is the final settled assistant
 * message rather than text joined across turns. The manifest owns the names.
 */
export const SEMANTIC_COMPARISON_WORKFLOW = "reconcile-product-behavior" as const;
export const SEMANTIC_COMPARISON_STEP = "compare-product-behavior" as const;

/** Whether this is the one step whose reply is the semantic comparison proposal. */
export function isSemanticComparisonStep(input: {
  readonly workflow: { readonly name: string };
  readonly step: { readonly id: string };
}): boolean {
  return (
    input.workflow.name === SEMANTIC_COMPARISON_WORKFLOW &&
    input.step.id === SEMANTIC_COMPARISON_STEP
  );
}
