// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AuthorityBasis } from "../delivery-authority.js";
import { existsSync } from "node:fs";

/** Marks a nested Linux container execute host, which must keep validation confined. */
export const NESTED_SANDBOX_MARKER = "/.dockerenv";

export function nestedExecuteHostMustStayConfined(
  exists: (path: string) => boolean = existsSync,
): boolean {
  return exists(NESTED_SANDBOX_MARKER);
}

export type ValidationIsolationMode = "confined" | "operator-supervised";

/**
 * Host-selected isolation bar keyed on delivery authority and execute-host class.
 * Plan, config, environment, and CLI cannot widen this policy.
 */
export interface ValidationIsolationPolicyV1 {
  readonly authorityBasis: AuthorityBasis;
  readonly nestedExecuteHost: boolean;
  /** Run validation without a confinement prefix when confined backends fail. */
  readonly allowOperatorSupervisedFallback: boolean;
  /** Fail closed instead of falling back when confinement is unavailable. */
  readonly requireConfinement: boolean;
}

export function resolveValidationIsolationPolicy(input: {
  authorityBasis: AuthorityBasis;
  nestedExecuteHost?: boolean;
}): ValidationIsolationPolicyV1 {
  const nestedExecuteHost = input.nestedExecuteHost ?? nestedExecuteHostMustStayConfined();
  if (input.authorityBasis === "none") {
    return {
      authorityBasis: "none",
      nestedExecuteHost,
      allowOperatorSupervisedFallback: false,
      requireConfinement: false,
    };
  }
  if (input.authorityBasis === "standing-repo-grant") {
    return {
      authorityBasis: "standing-repo-grant",
      nestedExecuteHost,
      allowOperatorSupervisedFallback: false,
      requireConfinement: true,
    };
  }
  return {
    authorityBasis: "interactive-once",
    nestedExecuteHost,
    allowOperatorSupervisedFallback: !nestedExecuteHost,
    requireConfinement: nestedExecuteHost,
  };
}

export function shouldUseOperatorSupervisedValidationFallback(
  policy: ValidationIsolationPolicyV1,
  error: unknown,
): boolean {
  if (!policy.allowOperatorSupervisedFallback) return false;
  if (
    typeof error === "object" &&
    error !== null &&
    (error as Error).name === "NestedSandboxIsolationError"
  ) {
    return (
      (error as { allowOperatorSupervisedFallback?: boolean }).allowOperatorSupervisedFallback ===
      true
    );
  }
  return error instanceof Error;
}
