// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/** The knowledge boundary accepts inert data; host adapters expose the typed consumer contracts. */
export const PRODUCT_FEEDBACK_MODEL_MARKER: string;
export const PRODUCT_FEEDBACK_MATERIALIZER_VERSION: string;
/** Versions a retained manifest may name; new candidates use `PRODUCT_FEEDBACK_MATERIALIZER_VERSION`. */
export const PRODUCT_FEEDBACK_MATERIALIZER_VERSIONS: readonly string[];
export const PRODUCT_REFERENCE_MODEL_TARGET_ID: "product-reference-model";
/** The section a v4 projection is appended under when the document holds no region for its claim. */
export const PRODUCT_FEEDBACK_PROJECTION_HEADING: string;
/** A candidate whose projection would replace someone's text: published as a draft, never merged by DocsFab. */
export const PROJECTION_REVIEW_CODE: "projection-normalisation-needs-review";
export const PRODUCT_FEEDBACK_CARRIED_CLAIM_CHANGED: "product-feedback: carried claim changed";
export function encodeProductFeedbackFile(value: Uint8Array): string | { encoding: "base64"; data: string };
export function productFeedbackTargetRoutePolicySha256(routes: unknown): string;
export function assertProductFeedbackTargetRoutes(input: unknown): void;
export function renderProductFeedbackModel(model: unknown): string;
/** Closed data only; no approval, currentness, route authority or actual-byte verification. */
export function parseProductFeedbackCandidateManifest(input: unknown): unknown;
export function requiredProductFeedbackBasePaths(input: { baseline: unknown; recipe: unknown }): string[];
export function materializeProductFeedbackCandidate(input: unknown): unknown;
export function verifyProductFeedbackCandidate(input: unknown): unknown;
/** The snapshot a verified candidate becomes once merged at one revision; grants no approval. */
export function productFeedbackSuccessorSnapshot(input: unknown): unknown;
