// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const CANDIDATE_SOURCE_STATUSES: readonly ["added", "modified", "deleted", "renamed"];
export type CandidateSourceStatusV1 = (typeof CANDIDATE_SOURCE_STATUSES)[number];
export interface CandidateSourceChangeV1 {
  readonly path: string;
  readonly status: CandidateSourceStatusV1;
  readonly previousPath: string | null;
}
export type CandidateSourceManifestParseCodeV1 =
  | "invalid-shape"
  | "invalid-value"
  | "credential-material";
export interface CandidateSourceManifestHooksV1 {
  fail(code: CandidateSourceManifestParseCodeV1): never;
  rejectCredentials(value: unknown): void;
}
export function normalizeCandidateSourceManifestV1(
  value: unknown,
  hooks: CandidateSourceManifestHooksV1,
): readonly CandidateSourceChangeV1[];
export function candidateSourceManifestSha256V1(
  value: unknown,
  hooks: CandidateSourceManifestHooksV1,
): string;
