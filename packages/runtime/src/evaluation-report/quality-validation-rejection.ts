// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The inner reason the locked evaluation validator refused a quality
 * evaluation.
 *
 * The validator's diagnostics interpolate values from the evaluator's artifact,
 * so they cannot be retained as written. This module reduces them to one
 * closed, host-authored code, a contract location, and an issue count, and
 * never copies validator text. A member name from a diagnostic enters a
 * location only when the frozen evaluation schema declares it. Anything the
 * table does not recognize reads as `evaluation-profile-semantics` at `$`.
 */

import { readFileSync } from "node:fs";

import {
  isRetainableInferenceRejection,
  retainedInferenceRejection,
} from "../config/inference-rejection-limits.js";
import {
  describeStagedQualityArtifactMismatch,
  type StagedQualitySchemaMismatchKeyword,
} from "./quality-schema-validation.js";

/**
 * The quality-path check that refused a step, in pipeline order. `evaluation`,
 * `quality-score`, and `report-binding` are the locked Python validators; the
 * rest are host checks. `quality-check-rejections.ts` lists their codes.
 */
export const QUALITY_VALIDATION_CHECKS = Object.freeze([
  "candidate-admission",
  "candidate-staging",
  "evaluation",
  "technical-trace",
  "quality-score",
  "report-finalization",
  "report-binding",
  "final-report-staging",
  "binding-storage",
] as const);

export type QualityValidationCheck = (typeof QUALITY_VALIDATION_CHECKS)[number];

/** Strictly read one retained validator refusal; unknown shape or grammar is absent. */
export function readQualityValidationRejection(
  value: unknown,
): QualityValidationRejectionV1 | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const keys = Object.keys(value).sort();
  if (
    keys.length !== 4 ||
    keys[0] !== "code" ||
    keys[1] !== "issueCount" ||
    keys[2] !== "location" ||
    keys[3] !== "validator"
  ) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.validator !== "string" ||
    !(QUALITY_VALIDATION_CHECKS as readonly string[]).includes(candidate.validator) ||
    typeof candidate.code !== "string" ||
    typeof candidate.location !== "string" ||
    !isRetainableInferenceRejection({ code: candidate.code, location: candidate.location }) ||
    typeof candidate.issueCount !== "number" ||
    !Number.isSafeInteger(candidate.issueCount) ||
    candidate.issueCount < 0
  ) {
    return null;
  }
  return Object.freeze({
    validator: candidate.validator as QualityValidationCheck,
    code: candidate.code,
    location: candidate.location,
    issueCount: candidate.issueCount,
  });
}

export interface QualityValidationRejectionV1 {
  /** A locked validator or a host check, despite the field name. */
  readonly validator: QualityValidationCheck;
  /** Closed host code for the check's first issue. */
  readonly code: string;
  /** `$`-rooted; the base depends on the check, as `run-records.md` names. */
  readonly location: string;
  /**
   * How many issues the check reported: 0 when a validator refused before
   * listing any; 1 for a host check, which stops at its first failure.
   */
  readonly issueCount: number;
}

/** A diagnostic the table has no row for. */
export const EVALUATION_SEMANTICS_FALLBACK = "evaluation-profile-semantics";
/** The validator exited without listing an issue (a load or shape refusal). */
export const EVALUATION_VALIDATOR_REFUSED = "evaluation-validator-refused";

interface EvaluationSchemaVocabulary {
  readonly layers: ReadonlySet<string>;
  readonly populations: ReadonlySet<string>;
  readonly constraints: ReadonlySet<string>;
}

let vocabularyCache: EvaluationSchemaVocabulary | undefined;

function schemaVocabulary(): EvaluationSchemaVocabulary {
  if (vocabularyCache) return vocabularyCache;
  const schema = JSON.parse(
    readFileSync(
      new URL(
        "../../quality/schemas/documentation-quality-evaluation.schema.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as { properties?: Record<string, { properties?: Record<string, unknown> }> };
  const members = (name: string) =>
    new Set(Object.keys(schema.properties?.[name]?.properties ?? {}));
  vocabularyCache = {
    layers: members("layers"),
    populations: members("outcomes"),
    constraints: members("constraints"),
  };
  return vocabularyCache;
}

type Locate = (match: RegExpExecArray, vocabulary: EvaluationSchemaVocabulary) => string;

const at =
  (location: string): Locate =>
  () =>
    location;

/** `$.<parent>.<member><rest>` when the schema declares the captured member, else `$.<parent>`. */
const member =
  (parent: "layers" | "outcomes" | "constraints", rest = ""): Locate =>
  (match, vocabulary) => {
    const name = match.groups?.member;
    const known =
      parent === "layers"
        ? vocabulary.layers
        : parent === "outcomes"
          ? vocabulary.populations
          : vocabulary.constraints;
    return name !== undefined && known.has(name) ? `$.${parent}.${name}${rest}` : `$.${parent}`;
  };

/**
 * One row per diagnostic family the locked validator emits. Patterns match the
 * validator's fixed wording and capture only schema member names; quoted
 * values are matched by shape and never captured.
 */
const EVALUATION_DIAGNOSTICS = [
  // Unloadable inputs or a malformed locked profile or schema. These come first
  // so a profile-derived diagnostic never reads as the evaluator's; no
  // evaluator reply repairs them.
  [/^unable to read JSON file /u, "evaluation-input-unreadable", at("$")],
  [
    /^(?:invalid JSON in |non-finite JSON number: |unsupported JSON Schema type: |unsupported non-local JSON Schema reference: |unresolved JSON Schema reference: |JSON Schema reference does not resolve to an object: )/u,
    "evaluation-pack-invalid",
    at("$"),
  ],
  [
    /^documentation quality (?:evaluation|profile) must contain an object$/u,
    "evaluation-pack-invalid",
    at("$"),
  ],
  [/^profile[ .]/u, "evaluation-pack-invalid", at("$")],
  [/ path '.*' must be repository-relative$/u, "target-path-not-relative", at("$.target")],
  [/ path '.*' must use POSIX separators$/u, "target-path-not-posix", at("$.target")],
  [
    / path '.*' must not contain empty, '\.', or '\.\.' segments$/u,
    "target-path-dot-segments",
    at("$.target"),
  ],
  [/ path '.*' must identify a repository location$/u, "target-path-not-location", at("$.target")],
  [
    /^documentation family evidence references undeclared family /u,
    "family-evidence-undeclared",
    at("$.target.documentation_family_evidence"),
  ],
  [
    /^documentation family evidence repeats family /u,
    "family-evidence-repeated",
    at("$.target.documentation_family_evidence"),
  ],
  [
    /^documentation family evidence path .* is unrelated to target\.paths$/u,
    "family-evidence-path-unrelated",
    at("$.target.documentation_family_evidence"),
  ],
  [
    /^documentation family .* lacks classification evidence$/u,
    "family-evidence-missing",
    at("$.target.documentation_families"),
  ],
  [
    /^path .* implies family .*, not the declared family$/u,
    "family-path-mismatch",
    at("$.target.documentation_families"),
  ],
  [
    /^layers\.(?<member>\w+) repeats dimension /u,
    "layer-dimension-repeated",
    member("layers", ".dimensions"),
  ],
  [
    /^layers\.(?<member>\w+) contains unknown dimension /u,
    "layer-dimension-unknown",
    member("layers", ".dimensions"),
  ],
  [
    /^layers\.(?<member>\w+) is missing required dimension /u,
    "layer-dimension-missing",
    member("layers", ".dimensions"),
  ],
  [
    /^required dimension .* must have applicability 'required'$/u,
    "required-dimension-applicability",
    at("$.layers"),
  ],
  [
    /^layers\.(?<member>\w+) \S+ requires dimension .* to be met$/u,
    "layer-decision-requires-met-dimension",
    member("layers", ".decision"),
  ],
  [
    /^layers\.(?<member>\w+) \S+ requires at least one required dimension$/u,
    "layer-decision-requires-required-dimension",
    member("layers", ".decision"),
  ],
  [/^dimension .* is met without evidence$/u, "dimension-met-without-evidence", at("$.layers")],
  [
    /^required dimension .* cannot be not-applicable$/u,
    "required-dimension-not-applicable",
    at("$.layers"),
  ],
  [
    /^dimension .* is met with evidence strength 'none'$/u,
    "dimension-met-with-no-evidence",
    at("$.layers"),
  ],
  [
    /^dimension .* lacks required evidence class /u,
    "dimension-evidence-class-missing",
    at("$.layers"),
  ],
  [
    /^layers\.(?<member>\w+) confidence exceeds its lowest required-dimension confidence$/u,
    "layer-confidence-exceeds-dimensions",
    member("layers", ".confidence"),
  ],
  [
    /^layers\.(?<member>\w+) confidence must be 0 when no dimensions are required$/u,
    "layer-confidence-no-required-dimensions",
    member("layers", ".confidence"),
  ],
  [
    /^layers\.(?<member>\w+) confidence is below its lowest required-dimension confidence$/u,
    "layer-confidence-below-dimensions",
    member("layers", ".confidence"),
  ],
  [
    /^hard_gate_failures must be unique$/u,
    "hard-gate-failures-not-unique",
    at("$.hard_gate_failures"),
  ],
  [/^hard_gate_failures contains unknown gate /u, "hard-gate-unknown", at("$.hard_gate_failures")],
  [
    /^layers\.(?<member>\w+) hard gate failures require layer decision 'fail'$/u,
    "layer-hard-gate-requires-fail",
    member("layers", ".decision"),
  ],
  [
    /^layers\.(?<member>\w+) contains unknown hard gate /u,
    "layer-hard-gate-unknown",
    member("layers", ".hard_gate_failures"),
  ],
  [
    /^layer hard gate .* is missing from top-level hard_gate_failures$/u,
    "layer-hard-gate-not-top-level",
    at("$.hard_gate_failures"),
  ],
  [
    /^a nonempty hard_gate_failures list requires overall_decision 'fail'$/u,
    "hard-gate-requires-fail",
    at("$.overall_decision"),
  ],
  [
    /^constraints\.(?<member>\w+) dimension_id must be /u,
    "constraint-dimension-mismatch",
    member("constraints", ".dimension_id"),
  ],
  [/^constraints repeats dimension_id /u, "constraint-dimension-repeated", at("$.constraints")],
  [
    /^constraint .* must have applicability 'required'$/u,
    "constraint-applicability",
    at("$.constraints"),
  ],
  [/^outcomes repeats attempt_id /u, "outcome-attempt-repeated", at("$.outcomes")],
  [
    /^outcomes\.(?<member>\w+) outcome-evaluation evidence must be labeled for population /u,
    "outcome-evidence-population-label",
    member("outcomes"),
  ],
  [
    /^outcomes\.(?<member>\w+) contains evidence for population /u,
    "outcome-evidence-population-mismatch",
    member("outcomes"),
  ],
  [
    /^a failing layer requires overall_decision 'fail'$/u,
    "failing-layer-requires-fail",
    at("$.overall_decision"),
  ],
  [
    /^the selected experimental profile is not release-gate eligible$/u,
    "experimental-profile-not-release-gate",
    at("$.overall_decision"),
  ],
  [
    /^pass or conditional-pass requires an independent evaluator$/u,
    "pass-requires-independent-evaluator",
    at("$.evaluator"),
  ],
  [
    /^the selected profile does not permit conditional-pass$/u,
    "conditional-pass-not-permitted",
    at("$.overall_decision"),
  ],
  [
    /^pass or conditional-pass requires every layer decision to pass$/u,
    "pass-requires-passing-layers",
    at("$.layers"),
  ],
  [
    /^pass or conditional-pass requires constraint .* to be met$/u,
    "pass-requires-constraint-met",
    at("$.constraints"),
  ],
  [
    /^pass or conditional-pass requires (?<member>\w+) outcome evidence$/u,
    "pass-requires-outcome-evidence",
    member("outcomes"),
  ],
  [
    /^pass or conditional-pass rejects unverified (?<member>\w+) outcomes$/u,
    "pass-rejects-unverified-outcomes",
    member("outcomes"),
  ],
  [
    /^pass or conditional-pass requires at least \d+ verified (?<member>\w+) outcome attempt\(s\)$/u,
    "pass-requires-outcome-attempts",
    member("outcomes"),
  ],
  [
    /^verified (?<member>\w+) outcome success rate [\d.]+ is below required [\d.]+$/u,
    "outcome-success-rate-below-required",
    member("outcomes"),
  ],
  [
    /^overall confidence exceeds the lowest required-dimension confidence$/u,
    "overall-confidence-exceeds-dimensions",
    at("$.confidence"),
  ],
  [
    /^overall confidence must be 0 when no dimensions are required$/u,
    "overall-confidence-no-required-dimensions",
    at("$.confidence"),
  ],
  [
    /^overall confidence is below the lowest required-dimension confidence$/u,
    "overall-confidence-below-dimensions",
    at("$.confidence"),
  ],
  [
    /^evaluation profile ID does not match the selected profile$/u,
    "profile-id-mismatch",
    at("$.profile"),
  ],
  [
    /^evaluation profile version does not match the selected profile$/u,
    "profile-version-mismatch",
    at("$.profile"),
  ],
  [
    /^evaluation model_version does not match the selected profile$/u,
    "model-version-mismatch",
    at("$.model_version"),
  ],
  [
    /^findings\[\w+\]\.dimension_id '.*' is not a profile dimension or constraint$/u,
    "finding-dimension-unrecognized",
    at("$.findings"),
  ],
  [/^finding IDs must be unique$/u, "finding-ids-not-unique", at("$.findings")],
] as const satisfies ReadonlyArray<readonly [RegExp, string, Locate]>;

/**
 * Every code this module can record except the `evaluation-schema-<keyword>`
 * family. The failure-class table must name each one; a test keeps them in step.
 */
export type EvaluationDiagnosticCode =
  | typeof EVALUATION_VALIDATOR_REFUSED
  | typeof EVALUATION_SEMANTICS_FALLBACK
  | (typeof EVALUATION_DIAGNOSTICS)[number][1];
export type EvaluationSchemaRejectionCode =
  `evaluation-schema-${StagedQualitySchemaMismatchKeyword}`;

export const EVALUATION_DIAGNOSTIC_CODES: readonly EvaluationDiagnosticCode[] = Object.freeze([
  EVALUATION_VALIDATOR_REFUSED,
  EVALUATION_SEMANTICS_FALLBACK,
  ...new Set(EVALUATION_DIAGNOSTICS.map(([, code]) => code)),
]);

/** The validator's issue lines, without their `error: ` prefix. Never retained. */
function issueLines(stderr: string): string[] {
  return stderr
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("error: "))
    .map((line) => line.slice("error: ".length).trim());
}

export function classifyEvaluationDiagnostic(message: string): { code: string; location: string } {
  const vocabulary = schemaVocabulary();
  for (const [pattern, code, locate] of EVALUATION_DIAGNOSTICS) {
    const match = pattern.exec(message);
    if (match) return { code, location: locate(match, vocabulary) };
  }
  return { code: EVALUATION_SEMANTICS_FALLBACK, location: "$" };
}

/**
 * Reduce a failed evaluation validator run to a closed, content-free reason. A
 * schema violation is named from the frozen schema; otherwise the first
 * diagnostic is classified. The attempt rejection grammar keeps it retainable.
 */
export function projectEvaluationValidatorRejection(input: {
  readonly stderr: string;
  readonly payload: unknown;
}): QualityValidationRejectionV1 {
  const lines = issueLines(input.stderr);
  // An absent payload means none was staged to check, not an invalid one.
  const schema =
    input.payload === undefined
      ? undefined
      : describeStagedQualityArtifactMismatch(
          "documentation-quality-evaluation.schema.json",
          input.payload,
        );
  const reason = schema
    ? { code: `evaluation-schema-${schema.keyword}`, location: schema.location }
    : lines[0] !== undefined
      ? classifyEvaluationDiagnostic(lines[0])
      : { code: EVALUATION_VALIDATOR_REFUSED, location: "$" };
  const retained = retainedInferenceRejection(reason);
  return {
    validator: "evaluation",
    code: retained.code,
    location: retained.location,
    issueCount: lines.length,
  };
}

export { issueLines as validatorIssueLines };
