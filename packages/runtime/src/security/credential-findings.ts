// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Content-free findings for credential-like content (#1807).
 *
 * Under the owner decision on #1807, text that only looks like a credential
 * never stops a run: DocsFab records a finding, tells the maintainers, and
 * continues. Only DocsFab's own configured credentials fail closed, matched
 * exactly by `configured-credentials.ts`. A finding names where the text is
 * and which rule matched, never the text itself.
 */

import { createHash } from "node:crypto";

import { limit } from "../config/limits.js";
import { LIMIT_DEFINITION_BY_NAME } from "../config/limits.generated.js";
import {
  findConfiguredCredentialInValue,
  redactConfiguredCredentials,
} from "./configured-credentials.js";

export const CREDENTIAL_LIKE_CONTENT = "credential-like-content";

/** The limit that bounds the location a run records for one finding. */
export const CREDENTIAL_FINDING_LOCATION_LIMIT = "runs.credentialFindingLocationChars";
/** Hex characters of the whole location's digest that a cut location keeps. */
const CUT_LOCATION_DIGEST_CHARS = 16;
/**
 * Characters a finding location never carries raw: controls (C0, DEL, C1),
 * format characters such as bidi overrides and zero-width marks, and line and
 * paragraph separators. Each would let a path rewrite or split the line that
 * `docsfab runs show` prints.
 */
const UNSAFE_LOCATION_CHARACTER = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/**
 * The longest location a record reader admits: the limit's declared maximum,
 * so a record written under any setting of the limit stays readable.
 */
export function credentialFindingLocationReadBound(): number {
  const definition = LIMIT_DEFINITION_BY_NAME[CREDENTIAL_FINDING_LOCATION_LIMIT];
  if (!definition) {
    throw new Error(
      `Unknown operational limit ${CREDENTIAL_FINDING_LOCATION_LIMIT} is not declared in config/limits.yaml.`,
    );
  }
  return definition.max;
}

/**
 * The saved-location allowance expressed in its safe display representation.
 * One retained UTF-16 unit can become a complete Unicode escape. Configured
 * credential redaction has a smaller expansion: the supported matching minimum
 * is longer than half its replacement marker. Neither transformation cuts the
 * saved location or changes the record reader's allowance.
 */
export function credentialFindingPresentationLocationReadBound(): number {
  return credentialFindingLocationReadBound() * escapeCredentialFindingLocation("\u0000").length;
}

export interface CredentialFinding {
  readonly code: typeof CREDENTIAL_LIKE_CONTENT;
  /**
   * A repository-relative `path:line` (1-based, the first line the rule
   * matches) or a bare path when no line is known; for content that is not a
   * repository file, `<surface>:<field>`, such as `request:instruction`.
   */
  readonly location: string;
  /** The scanner rule id, such as `credential.assigned-secret`. */
  readonly rule: string;
}

/** A content-free refusal when metadata cannot be safely shown. */
export class CredentialFindingProjectionError extends Error {
  readonly code = "credential-material" as const;
  readonly nextAction =
    "Inspect the saved run privately and resolve the configured-credential exposure before requesting a public projection. The saved record is unchanged.";

  constructor() {
    super("Credential finding metadata contains a configured credential.");
    this.name = "CredentialFindingProjectionError";
  }
}

/** Public metadata, including replay under the current configured credentials. */
export function projectCredentialFindingsForPresentation(
  findings: readonly CredentialFinding[] | undefined,
): readonly CredentialFinding[] | undefined {
  if (!findings?.length) return undefined;
  const projected = findings.map((finding): CredentialFinding => {
    if (finding.code !== CREDENTIAL_LIKE_CONTENT) {
      throw new Error(
        "Credential finding metadata has an invalid code; expected credential-like-content.",
      );
    }
    return {
      code: CREDENTIAL_LIKE_CONTENT,
      // A retained location already satisfies its writer's bound. Redact and
      // escape it without cutting it again under a smaller current setting.
      location: escapeCredentialFindingLocation(redactConfiguredCredentials(finding.location)),
      rule: finding.rule,
    };
  });
  if (findConfiguredCredentialInValue(projected)) {
    throw new CredentialFindingProjectionError();
  }
  return sortCredentialFindings(projected);
}

/**
 * A finding location every record reader admits, so a heuristic finding can
 * never stop a record from decoding or publishing (#1807). DocsFab's own
 * configured credentials are redacted, each control, format, or separator
 * character is written as `\uXXXX`, and a location longer than
 * `runs.credentialFindingLocationChars`
 * keeps its line and is cut at a visible marker that carries a digest of the
 * whole location, so two long paths stay distinct.
 */
export function credentialFindingLocation(path: string, line?: number): string {
  const shown = escapeCredentialFindingLocation(redactConfiguredCredentials(path));
  const suffix = line === undefined ? "" : `:${String(line)}`;
  const bound = limit(CREDENTIAL_FINDING_LOCATION_LIMIT).value;
  if (shown.length + suffix.length <= bound) {
    return `${shown}${suffix}`;
  }
  const digest = createHash("sha256")
    .update(`${path}${suffix}`)
    .digest("hex")
    .slice(0, CUT_LOCATION_DIGEST_CHARS);
  const marker = `…[cut; sha256 ${digest}]`;
  let kept = shown.slice(0, bound - marker.length - suffix.length);
  // Never end on half of a surrogate pair, which a strict reader refuses.
  if (/[\ud800-\udbff]$/u.test(kept)) kept = kept.slice(0, -1);
  return `${kept}${marker}${suffix}`;
}

/**
 * `text` with each control, format, line separator, or paragraph separator
 * character written as `\uXXXX`, one escape per UTF-16 unit, so the text
 * prints as one line that shows exactly what is there.
 */
export function escapeCredentialFindingLocation(text: string): string {
  return text.replace(UNSAFE_LOCATION_CHARACTER, (character) =>
    Array.from(
      { length: character.length },
      (_, index) => `\\u${character.charCodeAt(index).toString(16).padStart(4, "0")}`,
    ).join(""),
  );
}

/** Findings sorted by location, then rule, with duplicates removed. */
export function sortCredentialFindings(
  findings: readonly CredentialFinding[],
): CredentialFinding[] {
  const unique = new Map<string, CredentialFinding>();
  for (const finding of findings) {
    unique.set(`${finding.location}\0${finding.rule}`, {
      code: CREDENTIAL_LIKE_CONTENT,
      location: finding.location,
      rule: finding.rule,
    });
  }
  return [...unique.values()].sort(
    (left, right) =>
      compareText(left.location, right.location) || compareText(left.rule, right.rule),
  );
}

/**
 * One Markdown notes line listing the findings for maintainers, or undefined
 * when there are none. At most `maxListed` are named; the rest are counted.
 */
export function formatCredentialFindingNotes(
  findings: readonly CredentialFinding[],
  maxListed: number,
): string | undefined {
  const sorted = sortCredentialFindings(findings);
  if (sorted.length === 0) return undefined;
  const listed = sorted
    .slice(0, Math.max(0, maxListed))
    .map((finding) => `\`${finding.location}\` (\`${finding.rule}\`)`);
  const more = sorted.length - listed.length;
  const items = more > 0 ? [...listed, `and ${String(more)} more`] : listed;
  return `- **Credential-like content (flagged for maintainers; DocsFab did not remove it):** ${items.join(", ")}`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
