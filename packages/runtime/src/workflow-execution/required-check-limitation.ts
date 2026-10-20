// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Limitations for repository-required checks DocsFab could not run (#1918).
 *
 * When a required check cannot run under isolated command authority, or runs
 * past its declared time limit (#1932), the run keeps the finished patch for
 * delivery and records one limitation per check in `RunRecord.evidenceWarnings`.
 * Each names the command, why it did not complete, and what the operator runs
 * instead. A check that ran and failed is never a limitation: it still refuses
 * the proposal.
 *
 * This module imports nothing, so the operator summary and the `--json` result
 * read the recorded lines without loading the check executor.
 */

/** Closed reasons a required check did not run, recorded as `cause` on its evidence. */
export const REQUIRED_CHECK_NOT_RUN_CAUSES = Object.freeze([
  "unsupported-check-form",
  "isolation-unavailable",
  "dependency-unavailable",
  "git-metadata-unavailable",
  "network-unavailable",
  "launch-failed",
  "timeout",
  "credential-scan-bound",
  "tree-changed",
  "cancelled",
  "pr-review-not-admitted",
] as const);

export type RequiredCheckNotRunCause = (typeof REQUIRED_CHECK_NOT_RUN_CAUSES)[number];

const REASONS: Readonly<Record<RequiredCheckNotRunCause, string>> = Object.freeze({
  "unsupported-check-form": "unsupported check form",
  "isolation-unavailable": "no check isolation on this host",
  "dependency-unavailable": "dependency unavailable",
  "git-metadata-unavailable": "git metadata unavailable in the check sandbox",
  "network-unavailable": "network unavailable in the check sandbox",
  "launch-failed": "the check executor could not start the command",
  timeout: "it did not finish within the check time limit",
  "credential-scan-bound": "the checkout exceeds the check credential scan limit",
  "tree-changed": "the checked tree changed while checks ran",
  cancelled: "the checks were cancelled",
  "pr-review-not-admitted": "public PR review did not admit repository script execution",
});

/** Every recorded limitation line starts with this text. */
export const REQUIRED_CHECK_LIMITATION_PREFIX = "required check could not run: ";

/** The `--json` product limitation code that accompanies the recorded lines. */
export const REQUIRED_CHECK_NOT_RUN_LIMITATION = "required-check-not-run";

/** One required check that did not run, as the gate reports it. */
export interface RequiredCheckLimitationV1 {
  /** Exact inline-code command text from the repository instruction. */
  readonly command: string;
  /** Repository-relative directory the command runs from. */
  readonly directory: string;
  /** The instruction file that requires the check. */
  readonly instruction: string;
  /** `null` when the check evidence names no closed cause. */
  readonly cause: RequiredCheckNotRunCause | null;
  /**
   * How to let DocsFab run the check: the platform remedy for an isolation
   * cause, or the coded limit line for a declared bound (a timeout or the
   * credential scan). Absent otherwise.
   */
  readonly remedy?: string;
}

export function isRequiredCheckNotRunCause(value: unknown): value is RequiredCheckNotRunCause {
  return (REQUIRED_CHECK_NOT_RUN_CAUSES as readonly unknown[]).includes(value);
}

/**
 * The limitation line: the command and its reason, then the next action that
 * names the command to run and where. Only an isolation cause adds a platform
 * remedy, and only a declared bound adds its coded limit line; no other cause
 * sends the operator to another host or setting. Paths are code spans, so a
 * forge or chat that renders the line treats them as text.
 */
export function formatRequiredCheckLimitation(limitation: RequiredCheckLimitationV1): string {
  const reason =
    limitation.cause === null
      ? "the check executor reported it unavailable"
      : REASONS[limitation.cause];
  const from = limitation.directory === "." ? "the repository root" : `\`${limitation.directory}\``;
  return [
    `${REQUIRED_CHECK_LIMITATION_PREFIX}\`${limitation.command}\` (${reason}).`,
    `Next action: run this command from ${from}, as \`${limitation.instruction}\` requires, before you merge this change.`,
    ...(limitation.remedy
      ? [
          `${limitation.cause === "isolation-unavailable" ? "Platform remedy" : "Limit"}: ${limitation.remedy}`,
        ]
      : []),
  ].join(" ");
}

/** The required-check limitation lines a run recorded, in record order. */
export function readRequiredCheckLimitations(record: {
  readonly evidenceWarnings?: readonly unknown[];
}): string[] {
  const warnings = Array.isArray(record.evidenceWarnings) ? record.evidenceWarnings : [];
  return warnings.filter(
    (warning): warning is string =>
      typeof warning === "string" && warning.startsWith(REQUIRED_CHECK_LIMITATION_PREFIX),
  );
}
