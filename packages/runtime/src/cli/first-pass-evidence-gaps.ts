// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The limitation a first pass records when it continues with evidence gaps
 * (#2113): mandatory obligations its repository evidence did not support, how
 * first pass ended, and each evidence bound it reached with the setting that
 * raises it. A gap is a limitation of first pass, not a stop: the run
 * continues with the evidence gathered, and these lines travel in
 * `RunRecord.evidenceWarnings` to the operator summary and the `--json` result.
 *
 * This module imports nothing, so the operator summary and the `--json` result
 * read the recorded lines without loading first pass.
 */

/** The `--json` product limitation code; every recorded line starts with it. */
export const FIRST_PASS_EVIDENCE_GAPS_LIMITATION = "first-pass-evidence-gaps";

/** Every recorded line starts with this text. */
export const FIRST_PASS_EVIDENCE_GAPS_PREFIX = `${FIRST_PASS_EVIDENCE_GAPS_LIMITATION}: `;

/** The first-pass evidence-gap lines a run recorded, in record order. */
export function readFirstPassEvidenceGapLines(record: {
  readonly evidenceWarnings?: readonly unknown[];
}): string[] {
  const warnings = Array.isArray(record.evidenceWarnings) ? record.evidenceWarnings : [];
  return warnings.filter(
    (warning): warning is string =>
      typeof warning === "string" && warning.startsWith(FIRST_PASS_EVIDENCE_GAPS_PREFIX),
  );
}
