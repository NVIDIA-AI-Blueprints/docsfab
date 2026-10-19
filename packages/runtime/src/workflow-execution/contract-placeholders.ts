// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Non-literal example values for host-owned response contracts.
 *
 * Models copy plausible literals from a contract shape verbatim, so a contract
 * never shows a copyable example value. Each example string is either a
 * closed vocabulary value a closed-enum validator decides, or a placeholder
 * from {@link CONTRACT_PLACEHOLDER_ROLES}: an angle-bracketed description that
 * is obviously not a value. Contract modules render placeholders from this
 * table, and `test/contract-placeholders.test.ts` refuses any unlisted
 * angle-bracketed example in a rendered contract.
 *
 * The refusal is scoped twice so a legitimate value is not refused: by step
 * (only roles the step's own host-owned contract rendered,
 * {@link contractPlaceholderScope}), and by position (only under a key the
 * role occupies, so a verbatim repository quote equal to a placeholder is
 * admitted). Within that scope a reply that repeats the placeholder, or a
 * `retired` literal an earlier contract showed there, is a coded, retryable
 * `malformed-response`. Only literals that describe no run are retired.
 *
 * A reply carrying credential material is not refused here: the step's own
 * terminal disclosure refusal decides it, even when that runs after the
 * harness returns.
 *
 * This module depends only on leaf modules, so harness contract modules and
 * workflow-execution decoders can both import it without a cycle.
 */

import {
  MAX_INFERENCE_REJECTION_REASON_LENGTH,
  MAX_INFERENCE_REJECTION_SEGMENT_LENGTH,
} from "../config/inference-rejection-limits.js";
import type { InferenceRejectionReasonV1 } from "../execution/contracts.js";
import { jsonEnvelopeBody } from "../execution/json-envelope.js";
import { JsonEvidenceError, parseJsonEvidence } from "../json-evidence.js";
import { findConfiguredCredentialInValue } from "../security/configured-credentials.js";

/** One placeholder: its text, the reply keys it occupies, and the literals it replaced. */
export interface ContractPlaceholderRole {
  readonly placeholder: string;
  readonly keys: readonly string[];
  readonly retired: readonly string[];
}

function role(
  placeholder: string,
  keys: readonly string[],
  retired: readonly string[] = [],
): ContractPlaceholderRole {
  return Object.freeze({
    placeholder,
    keys: Object.freeze([...keys]),
    retired: Object.freeze([...retired]),
  });
}

export const CONTRACT_PLACEHOLDER_ROLES = Object.freeze({
  planSummary: role(
    "<bounded narrative of this plan>",
    ["summary"],
    ["non-empty plan narrative", "non-empty bounded narrative"],
  ),
  needsInputSummary: role(
    "<specific missing evidence or dependency and the resolution needed>",
    ["summary"],
    [
      "non-empty bounded status",
      "specific missing evidence or dependency and the resolution needed",
    ],
  ),
  pagePath: role(
    "<repository-relative documentation page path>",
    ["path", "pagePath"],
    ["repository/relative.md"],
  ),
  sourceLocator: role("<source locator>", ["sources"], ["sourceLocator"]),
  decisionRationale: role(
    "<substantive evidence-based rationale>",
    ["rationale"],
    ["substantive evidence-based rationale"],
  ),
  evidenceSlotId: role("<evidence slot id>", ["slotIds"]),
  /** A non-nested step result carried as text. */
  stepResultText: role(
    "<this step's complete result as text>",
    ["summary"],
    ["non-empty bounded narrative"],
  ),
  assessmentRationale: role(
    "<substantive independent assessment>",
    ["rationale"],
    ["substantive independent assessment"],
  ),
  limitationCode: role(
    "<limitation code the evidence establishes>",
    ["limitations"],
    ["bounded-code"],
  ),
  recommendationCode: role(
    "<recommendation code prefixed with its kind>",
    ["code"],
    ["matching-kind.prefixed-code"],
  ),
  /** The six nested dimension assessments. */
  dimensionAssessments: role(
    "<one assessment for each required dimension>",
    ["dimensions"],
    ["all six exact dimension assessments required above"],
  ),
  qualityReportMarkdown: role(
    "<complete quality evaluation report in Markdown>",
    ["reportMarkdown"],
    ["# Documentation quality evaluation report\n..."],
  ),
  /** One limitation or evidence gap line's text (a retry hint). */
  reportLineText: role("<text>", ["reportMarkdown"]),
  targetPagePath: role("<approved target page path>", ["path"], ["approved target path"]),
  coverageReason: role(
    "<claims sampled, checks completed, and remaining limits>",
    ["reason"],
    ["substantive reason"],
  ),
  sourceLine: role("<source path>:<line>", ["evidence", "locator"], ["specific source locator"]),
  sourceRange: role("<source path>:<start line>-<end line>", ["sourceLocators"]),
  issueId: role("<issue ID>", ["id"]),
  issueSeverity: role("<severity>", ["severity"]),
  issueCategory: role("<category>", ["category"]),
  issueLocation: role("<target page path>:<line>", ["location"]),
  /** An issue located by a section rather than a line. */
  sectionHeading: role("<section heading>", ["location"]),
  /** A plan source identity, which is not a source locator. */
  planSourceIdentity: role("<path>@<revision>", ["sourceLocators"]),
  issueFinding: role("<what the reader cannot do or find, and why>", ["finding"]),
  evidenceSourceId: role("<evidence source id>", ["source_id"]),
  requiredChange: role("<source-supported change the page needs>", ["required_change"]),
  factId: role("<fact ID>", ["id"]),
  applicableReason: role("<why this dimension is in scope>", ["reason"]),
  notApplicableReason: role("<why the cited source puts this dimension out of scope>", ["reason"]),
  factStatement: role("<behavior the cited source establishes>", ["statement"]),
  factUncertainty: role("<remaining uncertainty, or why there is none>", ["uncertainty"]),
} as const);

export type ContractPlaceholderRoleName = keyof typeof CONTRACT_PLACEHOLDER_ROLES;

export const CONTRACT_PLACEHOLDERS = Object.freeze(
  Object.fromEntries(
    Object.entries(CONTRACT_PLACEHOLDER_ROLES).map(([name, entry]) => [name, entry.placeholder]),
  ) as { readonly [Name in ContractPlaceholderRoleName]: string },
);

export const RETIRED_CONTRACT_EXAMPLE_VALUES: readonly string[] = Object.freeze([
  ...new Set(Object.values(CONTRACT_PLACEHOLDER_ROLES).flatMap((entry) => entry.retired)),
]);

export const CONTRACT_PLACEHOLDER_STATEMENT =
  "An angle-bracketed value in a shape above describes what belongs there; it is not a value. Replace it with the actual value this run's evidence supports, and never copy it or any other example into the reply.";

/**
 * An angle-bracketed description, or several joined by locator punctuation.
 * Every match in a rendered contract must be a {@link CONTRACT_PLACEHOLDERS}
 * value; the drift test applies it.
 */
export const CONTRACT_PLACEHOLDER_NOTATION = /<[^<>"\n]+>(?:[:@#-]<[^<>"\n]+>)*/gu;

const HOST_OWNED_HEADER = /\(host-owned\):$/u;

/**
 * The host-owned contract sections of a rendered prompt: each runs from a
 * line that ends in `(host-owned):` to the next blank line. Step, skill, and
 * repository evidence text outside those sections never widens the scope.
 */
export function hostOwnedContractSections(prompt: string): string[] {
  const sections: string[] = [];
  let current: string[] | undefined;
  for (const line of prompt.split("\n")) {
    if (current && line.trim() === "") {
      sections.push(current.join("\n"));
      current = undefined;
    } else if (current) {
      current.push(line);
    } else if (HOST_OWNED_HEADER.test(line)) {
      current = [line];
    }
  }
  if (current) sections.push(current.join("\n"));
  return sections;
}

/** The roles a step's contract rendered; its reply is checked for these alone. */
export type ContractPlaceholderScope = ReadonlySet<ContractPlaceholderRoleName>;

export const EMPTY_CONTRACT_PLACEHOLDER_SCOPE: ContractPlaceholderScope = Object.freeze(
  new Set<ContractPlaceholderRoleName>(),
);

export function contractPlaceholderScope(prompt: string): ContractPlaceholderScope {
  const contracts = hostOwnedContractSections(prompt).join("\n");
  const names = (Object.keys(CONTRACT_PLACEHOLDER_ROLES) as ContractPlaceholderRoleName[]).filter(
    (name) => contracts.includes(CONTRACT_PLACEHOLDER_ROLES[name].placeholder),
  );
  return names.length === 0 ? EMPTY_CONTRACT_PLACEHOLDER_SCOPE : Object.freeze(new Set(names));
}

/** Whether `value` is any role's placeholder or retired literal, whatever its position. */
export function isContractPlaceholder(value: string): boolean {
  const text = value.trim();
  return Object.values(CONTRACT_PLACEHOLDER_ROLES).some(
    (entry) => entry.placeholder === text || entry.retired.includes(text),
  );
}

/** Whether `value` under reply key `key` repeats a placeholder of a role in `scope`. */
function copiesPlaceholder(
  value: string,
  key: string | undefined,
  scope: ContractPlaceholderScope,
): boolean {
  if (key === undefined) return false;
  const text = value.trim();
  for (const name of scope) {
    const entry = CONTRACT_PLACEHOLDER_ROLES[name];
    if (!entry.keys.includes(key)) continue;
    if (entry.placeholder === text || entry.retired.includes(text)) return true;
  }
  return false;
}

export const CONTRACT_PLACEHOLDER_REJECTION_CODE = "contract-placeholder-copied" as const;

const ROOT_LOCATION = "$";
const LOCATION_SEGMENT = /^[A-Za-z][A-Za-z0-9_]*$/u;

/**
 * The first placeholder of a role in `scope` that a parsed reply repeats at
 * one of that role's keys, as a coded rejection, or `undefined`.
 *
 * A value's key is the object key that holds it or its array. The location
 * names contract positions only: segments only for keys `isDeclared` accepts,
 * array members as `[]`, and the path stops at the first undeclared key or the
 * retained length bound, so no reply content, index, or size reaches the
 * record.
 */
export function findContractPlaceholder(
  value: unknown,
  scope: ContractPlaceholderScope,
  isDeclared: (key: string) => boolean,
): InferenceRejectionReasonV1 | undefined {
  if (scope.size === 0) return undefined;
  const location = placeholderLocation(value, undefined, ROOT_LOCATION, true, scope, isDeclared);
  return location === undefined
    ? undefined
    : Object.freeze({ code: CONTRACT_PLACEHOLDER_REJECTION_CODE, location });
}

/**
 * {@link findContractPlaceholder} over a raw reply's document, read through the
 * shared model-reply extraction policy, so a fenced reply is scanned as the
 * document a decoder admits. A reply with no strict JSON document is left to
 * its step decoder, or is free text no JSON contract governs.
 */
export function findContractPlaceholderInReply(
  reply: string,
  scope: ContractPlaceholderScope,
  isDeclared: (key: string) => boolean,
): InferenceRejectionReasonV1 | undefined {
  if (scope.size === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = parseJsonEvidence(jsonEnvelopeBody(reply).trim());
  } catch (error) {
    if (error instanceof JsonEvidenceError) return undefined;
    throw error;
  }
  // A disclosure refusal wins. Some steps screen for credentials only after
  // the harness returns, so a reply carrying a configured credential is left
  // to the step's own terminal refusal. Same match as `rejectCredentials`.
  if (findConfiguredCredentialInValue(parsed)) return undefined;
  return findContractPlaceholder(parsed, scope, isDeclared);
}

function placeholderLocation(
  value: unknown,
  key: string | undefined,
  location: string,
  named: boolean,
  scope: ContractPlaceholderScope,
  isDeclared: (key: string) => boolean,
): string | undefined {
  if (typeof value === "string") {
    return copiesPlaceholder(value, key, scope) ? location : undefined;
  }
  if (Array.isArray(value)) {
    const member = named ? extend(location, "[]") : { location, named: false };
    for (const item of value) {
      const found = placeholderLocation(
        item,
        key,
        member.location,
        member.named,
        scope,
        isDeclared,
      );
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  for (const [child, item] of Object.entries(value)) {
    const member =
      named &&
      child.length <= MAX_INFERENCE_REJECTION_SEGMENT_LENGTH &&
      LOCATION_SEGMENT.test(child) &&
      isDeclared(child)
        ? extend(location, `.${child}`)
        : { location, named: false };
    const found = placeholderLocation(
      item,
      child,
      member.location,
      member.named,
      scope,
      isDeclared,
    );
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Append one segment, or stop naming deeper members at the retained bound. */
function extend(location: string, segment: string): { location: string; named: boolean } {
  const next = `${location}${segment}`;
  return next.length <= MAX_INFERENCE_REJECTION_REASON_LENGTH
    ? { location: next, named: true }
    : { location, named: false };
}
