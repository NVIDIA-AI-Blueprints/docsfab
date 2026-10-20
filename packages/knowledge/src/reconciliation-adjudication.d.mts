// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/** Types for the closed retained-evidence parsers this module exports. Every value is
 * validated at run time by the module itself; these declarations only let the host import
 * them statically. Bounds are always supplied by the host caller from its limits catalog. */
export function registerReconciliationDecisionSource(input: unknown): Readonly<Record<string, unknown>>;
export function adjudicateReconciliationDecision(input: unknown): Readonly<Record<string, unknown>>;
export function parseReconciliationSemanticOffer(input: unknown): Readonly<Record<string, unknown>>;
/** `offerPartsMax` is required: the module fails closed on a semantic question when the
 * caller names no part maximum, so an optional declaration would let a TypeScript caller
 * omit it and meet that refusal only at run time. */
export function validateRetainedReconciliationDecision(question: unknown, answer: unknown,
  bounds: { readonly answerTextMaxBytes: number; readonly offerPartsMax: number }): Readonly<Record<string, unknown>>;
