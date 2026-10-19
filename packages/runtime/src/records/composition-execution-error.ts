// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Closed refusal codes for composition execution evidence. */
export type CompositionExecutionEvidenceErrorCode =
  | "credential-material"
  | "digest-mismatch"
  | "invalid-shape"
  | "invalid-value"
  | "schema-mismatch"
  | "migration-required"
  | "subject-mismatch";

export class CompositionExecutionEvidenceError extends Error {
  public constructor(public readonly code: CompositionExecutionEvidenceErrorCode) {
    super(`Composition execution evidence rejected (${code}).`);
    this.name = "CompositionExecutionEvidenceError";
  }
}
