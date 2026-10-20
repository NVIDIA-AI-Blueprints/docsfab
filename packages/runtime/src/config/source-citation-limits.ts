// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Operational bounds for source citation coverage. The values are read from
 * the generated mirror of `config/limits.yaml`; change them there and run
 * `npm run generate:limits`.
 *
 * A model cannot widen a bound by asking, and exceeding one refuses with a
 * coded message that names what to change rather than truncating, clamping or
 * skipping.
 */

import { limit, type ResolveLimitsOptions } from "./limits.js";
import { LIMIT_DEFINITION_BY_NAME } from "./limits.generated.js";

/** Read one catalog value, refusing loudly rather than falling back to a literal. */
function catalogLimit(name: string): number {
  const definition = LIMIT_DEFINITION_BY_NAME[name];
  if (!definition) {
    throw new Error(`Source citation limit ${name} is missing from config/limits.yaml.`);
  }
  return definition.value;
}

export const SOURCE_CLAIM_MIN_WORDS_LIMIT = "sources.claimMinWords" as const;

/**
 * Minimum words, counted on the normalized claim text its digest is taken on,
 * for a sentence a write step adds to documentation to be a material claim.
 * Resolved at use time, so the host override reaches the cite tool and the
 * coverage check alike.
 */
export function sourceClaimMinWords(options?: ResolveLimitsOptions): number {
  return limit(SOURCE_CLAIM_MIN_WORDS_LIMIT, options).value;
}

/**
 * Maximum span ids one `docsfab_cite_source` call may name. Kept equal to the
 * per-call span ceiling `docsfab_read_source` applies.
 */
export const SOURCE_CITE_MAX_SPANS_PER_CALL = catalogLimit("sources.citeMaxSpansPerCall");

/**
 * Maximum characters of claim text one call may carry, measured on the raw
 * argument before normalization so the bound is on what crosses the boundary.
 */
export const SOURCE_CITE_MAX_CLAIM_CHARACTERS = catalogLimit("sources.citeMaxClaimCharacters");

/** Maximum material claims one call may register after the host segments the text. */
export const SOURCE_CITE_MAX_CLAIMS_PER_CALL = catalogLimit("sources.citeMaxClaimsPerCall");

/**
 * Word-final tokens that do not end a sentence when followed by whitespace,
 * compared case-insensitively against the token before the period, with the
 * period removed.
 *
 * Deliberately not locale-aware: claim digests enter run records, so
 * segmentation must be a pure function of the text and this list, never of an
 * ICU version or a host locale.
 */
export const SOURCE_CLAIM_SENTENCE_ABBREVIATIONS: readonly string[] = Object.freeze([
  "al",
  "approx",
  "cf",
  "ch",
  "co",
  "corp",
  "dr",
  "e.g",
  "eg",
  "et",
  "etc",
  "fig",
  "figs",
  "i.e",
  "ie",
  "inc",
  "jr",
  "ltd",
  "mr",
  "mrs",
  "ms",
  "no",
  "nos",
  "pp",
  "prof",
  "rev",
  "sec",
  "sr",
  "st",
  "vol",
  "vs",
]);
