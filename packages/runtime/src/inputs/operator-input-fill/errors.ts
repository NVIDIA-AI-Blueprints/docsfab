// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Stable refusal codes for a continuation that cannot carry the original run's evidence. */
export const OPERATOR_INPUT_FILL_ERROR_CODES = [
  "continue-planner-input-unsupported",
  "retained-reader-input-malformed",
  "continue-revision-mismatch",
  "retained-evidence-bindings-malformed",
  "continue-binding-forge-unsupported",
  "continue-release-unsupported",
  "continue-binding-conflict",
  "continue-binding-moved",
] as const;
export type OperatorInputFillErrorCode = (typeof OPERATOR_INPUT_FILL_ERROR_CODES)[number];

export class OperatorInputFillError extends Error {
  public readonly code?: OperatorInputFillErrorCode;
  public readonly nextAction?: string;

  public constructor(message: string, code?: OperatorInputFillErrorCode, nextAction?: string) {
    super(message);
    this.name = "OperatorInputFillError";
    if (code !== undefined) this.code = code;
    if (nextAction !== undefined) this.nextAction = nextAction;
  }
}
