// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Cycle-free presentation symbols for operator next-commands.
 * Scheduler modules own persistence and revision behavior; they import these
 * strings and parsers instead of exporting them for operator consumption.
 */

import { OUTPUT_RULE_FAMILIES, type RuleCodeOf } from "../contracts/model-output.generated.js";

export const workflowOutcomePersistenceError =
  "Workflow product outcome could not be validated or persisted.";

export const REVISE_DOCUMENTATION_STEP_ID = "revise-documentation" as const;

export const AUTHORING_REVISION_ACCOUNTING_ERROR =
  "Authoring revision accounting did not satisfy the host-owned contract.";

/** The recorded prefix; persisted codes are never renamed, so the catalog declares it. */
export const REVISION_ACCOUNTING_REJECTION_PREFIX =
  OUTPUT_RULE_FAMILIES["revision-accounting"].recordedPrefix;

/** Every revision-accounting rejection code, as recorded. */
export type RevisionAccountingRejectionCode = RuleCodeOf<"revision-accounting">;

/** A revision-accounting code without its recorded prefix, as the diagnostic message names it. */
export type AuthoringRevisionAccountingDiagnosticCode =
  RevisionAccountingRejectionCode extends `${typeof REVISION_ACCOUNTING_REJECTION_PREFIX}${infer Code}`
    ? Code
    : never;

export const REVISION_ACCOUNTING_REJECTION_CODES: readonly RevisionAccountingRejectionCode[] =
  OUTPUT_RULE_FAMILIES["revision-accounting"].codes;

/** Every revision-accounting code the host raises; the catalog classifies each. */
export const AUTHORING_REVISION_ACCOUNTING_DIAGNOSTIC_CODES: readonly AuthoringRevisionAccountingDiagnosticCode[] =
  Object.freeze(
    REVISION_ACCOUNTING_REJECTION_CODES.map(
      (code) =>
        code.slice(
          REVISION_ACCOUNTING_REJECTION_PREFIX.length,
        ) as AuthoringRevisionAccountingDiagnosticCode,
    ),
  );

export function authoringRevisionAccountingDiagnosticMessage(
  code: AuthoringRevisionAccountingDiagnosticCode,
): string {
  return `${AUTHORING_REVISION_ACCOUNTING_ERROR.slice(0, -1)}: ${REVISION_ACCOUNTING_REJECTION_PREFIX}${code}.`;
}

export function authoringRevisionAccountingDiagnosticFromMessage(
  message: unknown,
): AuthoringRevisionAccountingDiagnosticCode | "historical-generic" | undefined {
  if (message === AUTHORING_REVISION_ACCOUNTING_ERROR) return "historical-generic";
  return AUTHORING_REVISION_ACCOUNTING_DIAGNOSTIC_CODES.find(
    (code) => message === authoringRevisionAccountingDiagnosticMessage(code),
  );
}

/**
 * The diagnostic a recorded rejection code names, or `undefined` for any code
 * outside the closed set. Reads the structured code only, never a message.
 */
export function revisionAccountingDiagnosticForRejectionCode(
  code: unknown,
): AuthoringRevisionAccountingDiagnosticCode | undefined {
  return typeof code === "string" &&
    (REVISION_ACCOUNTING_REJECTION_CODES as readonly string[]).includes(code)
    ? (code.slice(
        REVISION_ACCOUNTING_REJECTION_PREFIX.length,
      ) as AuthoringRevisionAccountingDiagnosticCode)
    : undefined;
}
