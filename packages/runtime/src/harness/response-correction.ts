// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The host validation feedback a bounded read-only retry receives: the catalog
 * rule behind the refused attempt's coded rejection, never the rejected
 * response or an error message.
 *
 * Every sentence is host-authored. The variable text is the rejection's `code`
 * and `location`, readmitted through the attempt record's content-free grammar;
 * the unissued obligation IDs an unknown-obligation correction repeats; and,
 * for an emptied-dimension correction, dimension names admitted only as host
 * vocabulary with their ledger obligation IDs and admitted evidence paths; and,
 * for an evaluation schema rejection, the values, keys, or bound the frozen
 * evaluation schema itself declares at that location. A value outside that grammar is
 * never printed and gets the generic guidance.
 */

import {
  UNRETAINABLE_INFERENCE_REJECTIONS,
  retainedInferenceRejection,
} from "../config/inference-rejection-limits.js";
import { limit } from "../config/limits.js";
import { OUTPUT_RULE_HINTS } from "../contracts/model-output.js";
import {
  STAGED_QUALITY_SCHEMA_MISMATCH_KEYWORDS,
  stagedQualitySchemaBound,
  stagedQualitySchemaStringRule,
  stagedQualitySchemaVocabulary,
  type StagedQualitySchemaMismatchKeyword,
} from "../evaluation-report/quality-schema-validation.js";
import { describeEvaluationTarget } from "../evaluation-report/evaluation-target.js";
import { patternRuleSentence } from "../evaluation-report/schema-field-rules.js";
import { retryCorrectionStatement } from "../records/inference-retry-rule-vocabulary.js";
import type {
  HarnessStepInput,
  InferenceRejectionReasonV1,
  EmptiedApplicableDimensionsCorrection,
  InferenceResponseCorrectionV1,
  QualityKeySetCorrection,
  QualityTraceFactIdsCorrection,
  SourceObligationDimensionReasonCorrection,
  UnknownObligationIdsCorrection,
} from "../execution/contracts.js";
import { QUALITY_ARTIFACT_ANSWER_KEYS } from "../execution/response-contract-keys.js";
import { QUALITY_SUBMISSION_TOOL_NAME } from "./answer-submission.js";
import { TECHNICAL_FACT_TRACE_MAX_VIOLATIONS } from "../evaluation-report/quality-artifact-staging.js";
import { isEchoableKeyName } from "../workflow-execution/quality-response-correction.js";
import {
  composeRejectionRuleHints,
  everywhere,
  ruleHintFor,
  type RejectionRuleHintCatalog,
} from "../workflow-execution/rejection-rule-hints.js";
import {
  EMPTIED_APPLICABLE_DIMENSION_REPAIR,
  TECHNICAL_RESPONSE_RULE_HINTS,
  UNKNOWN_OBLIGATION_LINK_REPAIR,
} from "../workflow-execution/review-response-rule-hints.js";
import {
  ECHOABLE_OBLIGATION_ID,
  EMPTIED_APPLICABLE_DIMENSION_REJECTION,
  TECHNICAL_FACT_DIMENSIONS,
  UNKNOWN_OBLIGATION_LINK_REJECTION,
} from "../workflow-execution/review-response.js";
import { CONTRACT_PLACEHOLDER_RULE_HINTS } from "../workflow-execution/contract-placeholder-rule-hints.js";
import { EDITORIAL_ASSESSMENT_RULE_HINTS } from "../workflow-execution/editorial-assessment-rule-hints.js";
import { QUALITY_RESPONSE_RULE_HINTS } from "../workflow-execution/quality-rejection-rule-hints.js";
import { SOURCE_OBLIGATION_RULE_HINTS } from "../workflow-execution/source-obligation-rule-hints.js";
import {
  admittedEvidencePathContract,
  applicableDimensionObligationIds,
  sealedObligationIdContract,
} from "../workflow-execution/source-obligation.js";

/** Hint for the envelope refusal recorded as `EDITORIAL_ENVELOPE_SHAPE_REJECTION`. */
export const EDITORIAL_RESPONSE_RULE_HINTS: RejectionRuleHintCatalog = Object.freeze({
  "editorial-envelope-shape": everywhere(
    "The previous response did not use the host outer editorial assessment envelope. Its only top-level keys must be summary and editorialAssessmentProposal. Put this step's result inside summary exactly as the host contract specifies; never return that result's fields at the top level.",
  ),
});

/** A refused readiness reply must assess the available, already admitted sources. */
const sourceReadinessResponseRuleHints: RejectionRuleHintCatalog = Object.freeze({
  "source-readiness-unassessed-available-sources": everywhere(
    "Review the admitted source brief, read the available source evidence, and assess each criterion. Retain unassessed only when a required input is unavailable.",
  ),
});

export const RESPONSE_REJECTION_RULE_HINTS: RejectionRuleHintCatalog = composeRejectionRuleHints(
  SOURCE_OBLIGATION_RULE_HINTS,
  TECHNICAL_RESPONSE_RULE_HINTS,
  EDITORIAL_RESPONSE_RULE_HINTS,
  sourceReadinessResponseRuleHints,
  EDITORIAL_ASSESSMENT_RULE_HINTS,
  QUALITY_RESPONSE_RULE_HINTS,
  // Every model-correctable rule in config/model-output/.
  OUTPUT_RULE_HINTS,
  CONTRACT_PLACEHOLDER_RULE_HINTS,
);

/** Guidance when the refusing decoder recorded no coded reason. */
export const UNCODED_RESPONSE_CORRECTION =
  "The previous response failed the host response contract. Check every required field, field type, allowed value, and cross-reference against the selected response contract before returning a complete replacement.";

const REPLACEMENT_INSTRUCTION =
  "Return a complete replacement that satisfies this rule and the rest of the selected response contract.";

const UNHINTED_INSTRUCTION =
  "The host has no specific repair hint for this rule. Check every required field, field type, allowed value, and cross-reference at that location against the selected response contract before returning a complete replacement.";

/** Keeps retry feedback from widening what the step may do. */
export const RESPONSE_CORRECTION_AUTHORITY_NOTE =
  "This feedback grants no new tools, source access, write scope, retries, or publication authority.";

/**
 * The retry prompt section for a correction, or `""` when there is none.
 *
 * `input` supplies the sealed ledger an unknown-obligation repair lists the
 * issued IDs from. Never throws: feedback about a refused response must not
 * fail the retry.
 */
export function responseCorrectionInstruction(
  correction: unknown,
  input: Pick<
    HarnessStepInput,
    "sourceObligationLedger" | "admittedSourceLineCounts" | "qualityEvaluationTarget"
  > = {},
): string {
  if (!correction || typeof correction !== "object") return "";
  const admitted = correction as InferenceResponseCorrectionV1;
  const rejection = admittedRejection(admitted);
  // The retry rule's own feedback for the refused attempt (a prose reply, a cut
  // answer, an expired attempt, a read loop), from the retry-policy catalog.
  const conditionStatement = retryCorrectionStatement(admitted);
  if (conditionStatement !== undefined && !rejection) {
    return `\n\nHost feedback for this bounded retry:\n${conditionStatement}\n${RESPONSE_CORRECTION_AUTHORITY_NOTE}`;
  }
  const reason = correctionReason(rejection, admittedDetail(admitted, rejection), input);
  const lead = conditionStatement === undefined ? "" : `${conditionStatement}\n`;
  return `\n\nHost validation feedback for this bounded retry:\n${lead}${reason}\n${RESPONSE_CORRECTION_AUTHORITY_NOTE}`;
}

function correctionReason(
  rejection: InferenceRejectionReasonV1 | undefined,
  detail: AdmittedCorrectionDetail | undefined,
  input: Pick<
    HarnessStepInput,
    "sourceObligationLedger" | "admittedSourceLineCounts" | "qualityEvaluationTarget"
  >,
): string {
  if (!rejection) return UNCODED_RESPONSE_CORRECTION;
  const cited = `The previous response failed host rule ${rejection.code} at ${rejection.location}.`;
  const catalogHint = ruleHintFor(RESPONSE_REJECTION_RULE_HINTS, rejection);
  const vocabulary = catalogHint && evaluationSchemaVocabularyRule(rejection);
  const boundTarget = catalogHint && evaluationTargetRule(rejection, input);
  const hint =
    (detail?.kind === "source-obligation-dimension-reason" &&
      catalogHint &&
      `The dimensions entry with dimension ${JSON.stringify(detail.dimension)} has the refused reason. ${catalogHint}`) ||
    (detail?.kind === "unknown-obligation-ids" && unknownObligationIdsRule(detail, input)) ||
    (detail?.kind === "emptied-applicable-dimensions" &&
      emptiedApplicableDimensionsRule(detail, input)) ||
    withQualityDetail(
      vocabulary
        ? `${catalogHint}\n${vocabulary}`
        : boundTarget
          ? `${catalogHint}\n${boundTarget}`
          : catalogHint,
      detail,
      rejection,
    );
  return hint
    ? `${cited}\n${hint}\n${REPLACEMENT_INSTRUCTION}`
    : `${cited}\n${UNHINTED_INSTRUCTION}`;
}

const EVALUATION_SCHEMA_PREFIX = "evaluation-schema-";

function namedList(names: readonly string[], withheld: number, noun: string): string {
  const shown = names.join(", ");
  if (withheld === 0) return shown;
  const more = `${withheld} further ${noun}${withheld === 1 ? "" : "s"} not shown`;
  return shown ? `${shown}, and ${more}` : more;
}

/**
 * The catalog hint, closed by the quality repair the host recorded for this
 * refusal: the keys an object lacks or has undeclared, or the fact IDs no
 * finding names. Without a hint or a repair, the hint stays as it is.
 */
function withQualityDetail(
  hint: string | undefined,
  detail: AdmittedCorrectionDetail | undefined,
  rejection: InferenceRejectionReasonV1,
): string | undefined {
  if (!hint || !detail) return hint;
  if (detail.kind === "quality-key-set") {
    const undeclared =
      detail.undeclared.length + detail.withheldCount === 0
        ? ""
        : ` It has keys the contract does not declare there: ${namedList(detail.undeclared, detail.withheldCount, "key")}.`;
    if (rejection.code === "quality-envelope-shape") {
      const missing = detail.missing.length === 0 ? "" : ` It lacks: ${detail.missing.join(", ")}.`;
      return `${hint}\nThe leading JSON object must have exactly the keys ${QUALITY_ARTIFACT_ANSWER_KEYS.join(" and ")}.${missing}${undeclared}`;
    }
    if (rejection.code === "quality-submission-shape") {
      const missing =
        detail.missing.length === 0 ? "" : ` They lack: ${detail.missing.join(", ")}.`;
      const extra =
        detail.undeclared.length + detail.withheldCount === 0
          ? ""
          : ` They have arguments the tool does not declare: ${namedList(detail.undeclared, detail.withheldCount, "argument")}.`;
      return `${hint}\nThe ${QUALITY_SUBMISSION_TOOL_NAME} arguments must have exactly the keys ${QUALITY_ARTIFACT_ANSWER_KEYS.join(" and ")}.${missing}${extra}`;
    }
    const at = `evaluation${rejection.location.slice(1, rejection.location.lastIndexOf("."))}`;
    return `${hint}\nThe required key ${detail.missing[0]} is missing at ${at}, and that object has a key the schema does not declare.${undeclared} Write the required key in full, spelled exactly as the schema spells it, in place of the undeclared one.`;
  }
  if (detail.kind === "quality-trace-fact-ids") {
    return `${hint}\nNo finding names these facts that the admitted technical verification lists as not documented: ${namedList(detail.factIds, detail.withheldCount, "fact")}. Write each fact ID exactly as the technical verification spells it.`;
  }
  return hint;
}

/**
 * Name the host-bound target for a rule that is judged against
 * `evaluation.target.paths`. Host data only: never the rejected reply's paths.
 */
function evaluationTargetRule(
  rejection: InferenceRejectionReasonV1,
  input: Pick<HarnessStepInput, "qualityEvaluationTarget">,
): string | undefined {
  if (rejection.code !== "family-evidence-path-unrelated" || !input.qualityEvaluationTarget) {
    return undefined;
  }
  return describeEvaluationTarget(input.qualityEvaluationTarget);
}

/**
 * Name what the frozen evaluation schema allows where an evaluation schema
 * rejection points: its enum or const values, its declared keys, or the number
 * a bound keyword states. The location is relative to the envelope's
 * evaluation member.
 */
function evaluationSchemaVocabularyRule(rejection: InferenceRejectionReasonV1): string | undefined {
  if (!rejection.code.startsWith(EVALUATION_SCHEMA_PREFIX)) return undefined;
  const keyword = rejection.code.slice(EVALUATION_SCHEMA_PREFIX.length);
  if (!(STAGED_QUALITY_SCHEMA_MISMATCH_KEYWORDS as readonly string[]).includes(keyword)) {
    return undefined;
  }
  const mismatch = {
    keyword: keyword as StagedQualitySchemaMismatchKeyword,
    location: rejection.location,
  };
  const at = `evaluation${rejection.location.slice(1)}`;
  const bound = stagedQualitySchemaBound("documentation-quality-evaluation.schema.json", mismatch);
  if (bound) return `The locked evaluation schema sets ${bound.member} to ${bound.value} at ${at}.`;
  const stringRule = stagedQualitySchemaStringRule(
    "documentation-quality-evaluation.schema.json",
    mismatch,
  );
  if (stringRule) {
    return "pattern" in stringRule
      ? `The locked evaluation schema requires ${at} to match ${patternRuleSentence(stringRule.pattern)}.`
      : `The locked evaluation schema requires ${at} to have format ${stringRule.format}${stringRule.format === "date-time" ? ", an RFC 3339 date-time string" : ""}.`;
  }
  const values = stagedQualitySchemaVocabulary(
    "documentation-quality-evaluation.schema.json",
    mismatch,
  );
  if (!values || values.length === 0) return undefined;
  const list = values.map((value) => JSON.stringify(value)).join(", ");
  if (keyword === "required") {
    // The location names the missing key; the list belongs to its parent.
    const parent = at.slice(0, at.lastIndexOf("."));
    return `The locked evaluation schema requires these keys at ${parent}: ${list}.`;
  }
  return keyword === "additional-properties"
    ? `The locked evaluation schema declares only these keys at ${at}: ${list}.`
    : `The locked evaluation schema allows only these values at ${at}: ${list}.`;
}

/**
 * Name the unissued IDs the previous judgment linked and the valid set from the
 * sealed ledger. Without that ledger the catalog rule for the code applies.
 */
function unknownObligationIdsRule(
  detail: UnknownObligationIdsCorrection,
  input: Pick<HarnessStepInput, "sourceObligationLedger" | "admittedSourceLineCounts">,
): string | undefined {
  const validSet = sealedObligationIdContract(input);
  if (!validSet) return undefined;
  const withheld =
    detail.withheldCount > 0
      ? ` ${detail.withheldCount} further cited value(s) were not identifier-shaped and are not shown.`
      : "";
  return `The previous response linked obligation IDs the host never issued in issueJudgments[].obligationIds: ${JSON.stringify(detail.unknownObligationIds)}.${withheld} ${UNKNOWN_OBLIGATION_LINK_REPAIR} ${validSet}`;
}

/**
 * Name the applicable ledger dimensions the previous judgment emptied, each with
 * its obligation IDs from the sealed ledger. Without that ledger, or when none
 * of them is applicable, the catalog rule for the code applies.
 */
function emptiedApplicableDimensionsRule(
  detail: EmptiedApplicableDimensionsCorrection,
  input: Pick<HarnessStepInput, "sourceObligationLedger" | "admittedSourceLineCounts">,
): string | undefined {
  const byDimension = applicableDimensionObligationIds(input, detail.dimensions);
  const admittedPaths = admittedEvidencePathContract(input);
  if (!byDimension || !admittedPaths) return undefined;
  // The host can neither build a fact for these dimensions nor demote them,
  // because not every rejection was substantive.
  return `The previous response rejected every obligation of these applicable ledger dimensions in obligationJudgments without a substantive rejection for each, so the host-built fact inventory has an applicable dimension with no facts: ${byDimension}. ${admittedPaths} ${EMPTIED_APPLICABLE_DIMENSION_REPAIR}`;
}

type AdmittedCorrectionDetail =
  | SourceObligationDimensionReasonCorrection
  | UnknownObligationIdsCorrection
  | EmptiedApplicableDimensionsCorrection
  | QualityKeySetCorrection
  | QualityTraceFactIdsCorrection;

/**
 * Readmit a rule-specific detail, and only beside the rule it belongs to.
 * A retry repeats two kinds of model-cited value: unknown obligation IDs, which
 * must again be identifier-shaped and inside the same catalog bounds the
 * judgment decoder enforces, and a quality object's undeclared key names,
 * which must be identifier-shaped, not credential-shaped, and no more than the
 * contract declares there (`admittedQualityDetail`). Emptied dimensions and
 * missing keys must be host vocabulary. Anything else admits as no detail, and
 * the catalog rule applies instead.
 */
function admittedDetail(
  correction: InferenceResponseCorrectionV1,
  rejection: InferenceRejectionReasonV1 | undefined,
): AdmittedCorrectionDetail | undefined {
  const detail: unknown = correction.detail;
  if (!detail || typeof detail !== "object") return undefined;
  if (
    rejection?.location === "$.dimensions[].reason" &&
    (rejection.code === "invalid-value" || rejection.code === "empty-required-field")
  ) {
    return admittedSourceObligationReasonDimension(detail, rejection);
  }
  const quality = admittedQualityDetail(detail as Record<string, unknown>, rejection);
  if (quality) return quality;
  if (
    rejection?.code === EMPTIED_APPLICABLE_DIMENSION_REJECTION.code &&
    rejection.location === EMPTIED_APPLICABLE_DIMENSION_REJECTION.location
  ) {
    return admittedEmptiedDimensions(detail as Record<string, unknown>);
  }
  if (rejection?.code !== UNKNOWN_OBLIGATION_LINK_REJECTION.code) return undefined;
  const { kind, unknownObligationIds, withheldCount } = detail as Record<string, unknown>;
  const maxIds =
    limit("technicalCorrection.maxIssueJudgments").value *
    limit("technicalCorrection.maxJudgmentFactIds").value;
  const maxChars = limit("technicalCorrection.identifierMaxChars").value;
  if (
    kind !== "unknown-obligation-ids" ||
    !Array.isArray(unknownObligationIds) ||
    unknownObligationIds.length > maxIds ||
    typeof withheldCount !== "number" ||
    !Number.isSafeInteger(withheldCount) ||
    withheldCount < 0 ||
    withheldCount > maxIds ||
    !unknownObligationIds.every(
      (id) => typeof id === "string" && id.length <= maxChars && ECHOABLE_OBLIGATION_ID.test(id),
    )
  ) {
    return undefined;
  }
  return Object.freeze({
    kind,
    unknownObligationIds: Object.freeze([...(unknownObligationIds as string[])]),
    withheldCount,
  });
}

/** Read a value-only, host-vocabulary dimension beside its exact reason refusal. */
function admittedSourceObligationReasonDimension(
  detail: object,
  rejection: InferenceRejectionReasonV1 | undefined,
): SourceObligationDimensionReasonCorrection | undefined {
  if (
    rejection?.location !== "$.dimensions[].reason" ||
    (rejection.code !== "invalid-value" && rejection.code !== "empty-required-field")
  ) {
    return undefined;
  }
  try {
    const keys = Object.keys(detail);
    if (keys.length !== 2 || !keys.includes("kind") || !keys.includes("dimension")) {
      return undefined;
    }
    const kind = Object.getOwnPropertyDescriptor(detail, "kind");
    const dimension = Object.getOwnPropertyDescriptor(detail, "dimension");
    if (
      kind?.value !== "source-obligation-dimension-reason" ||
      typeof dimension?.value !== "string" ||
      !TECHNICAL_FACT_DIMENSIONS.includes(
        dimension.value as (typeof TECHNICAL_FACT_DIMENSIONS)[number],
      )
    ) {
      return undefined;
    }
    return Object.freeze({
      kind: "source-obligation-dimension-reason",
      dimension: dimension.value,
    });
  } catch {
    return undefined;
  }
}

/** A count a repair carries: a non-negative safe integer no larger than `max`. */
function isCount(value: unknown, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;
}

/**
 * Readmit a quality repair beside its own refusal only. Missing keys must be
 * host vocabulary for that refusal; undeclared key names must be location
 * segment identifiers, at most as many as the contract declares there; fact
 * IDs must be identifier-shaped and within the trace check's violation bound.
 * Anything else admits as no detail.
 */
function admittedQualityDetail(
  detail: Record<string, unknown>,
  rejection: InferenceRejectionReasonV1 | undefined,
): QualityKeySetCorrection | QualityTraceFactIdsCorrection | undefined {
  if (!rejection) return undefined;
  const strings = (value: unknown, max: number, valid: (item: string) => boolean) =>
    Array.isArray(value) &&
    value.length <= max &&
    value.every((item) => typeof item === "string" && valid(item));
  if (detail.kind === "quality-trace-fact-ids") {
    const maxChars = limit("technicalCorrection.identifierMaxChars").value;
    if (
      rejection.code !== "technical-trace-missing-fact-id" ||
      !strings(
        detail.factIds,
        TECHNICAL_FACT_TRACE_MAX_VIOLATIONS,
        (id) => id.length <= maxChars && ECHOABLE_OBLIGATION_ID.test(id),
      ) ||
      !isCount(detail.withheldCount, Number.MAX_SAFE_INTEGER)
    ) {
      return undefined;
    }
    return Object.freeze({
      kind: "quality-trace-fact-ids",
      factIds: Object.freeze([...(detail.factIds as string[])]),
      withheldCount: detail.withheldCount,
    });
  }
  if (detail.kind !== "quality-key-set") return undefined;
  let vocabulary: readonly string[];
  let declaredCount: number;
  if (
    (rejection.code === "quality-envelope-shape" ||
      rejection.code === "quality-submission-shape") &&
    rejection.location === "$"
  ) {
    vocabulary = QUALITY_ARTIFACT_ANSWER_KEYS;
    declaredCount = QUALITY_ARTIFACT_ANSWER_KEYS.length;
  } else if (rejection.code === "evaluation-schema-required") {
    const parent = rejection.location.slice(0, rejection.location.lastIndexOf("."));
    const declared = stagedQualitySchemaVocabulary("documentation-quality-evaluation.schema.json", {
      keyword: "additional-properties",
      location: parent,
    });
    if (!declared) return undefined;
    vocabulary = [rejection.location.slice(rejection.location.lastIndexOf(".") + 1)];
    declaredCount = declared.length;
  } else {
    return undefined;
  }
  if (
    !strings(detail.missing, vocabulary.length, (key) => vocabulary.includes(key)) ||
    !strings(detail.undeclared, declaredCount, isEchoableKeyName) ||
    !isCount(detail.withheldCount, Number.MAX_SAFE_INTEGER) ||
    // A required-key repair names the one missing key and some undeclared one.
    (rejection.code === "evaluation-schema-required" &&
      ((detail.missing as string[]).length !== 1 ||
        (detail.undeclared as string[]).length + detail.withheldCount === 0))
  ) {
    return undefined;
  }
  return Object.freeze({
    kind: "quality-key-set",
    missing: Object.freeze([...(detail.missing as string[])]),
    undeclared: Object.freeze([...(detail.undeclared as string[])]),
    withheldCount: detail.withheldCount,
  });
}

/**
 * Admit only distinct technical fact dimensions, which also bounds the list by
 * the vocabulary size. Anything else admits as no detail.
 */
function admittedEmptiedDimensions(
  detail: Record<string, unknown>,
): EmptiedApplicableDimensionsCorrection | undefined {
  const { kind, dimensions } = detail;
  const vocabulary: readonly unknown[] = TECHNICAL_FACT_DIMENSIONS;
  if (
    kind !== "emptied-applicable-dimensions" ||
    !Array.isArray(dimensions) ||
    dimensions.length === 0 ||
    new Set(dimensions).size !== dimensions.length ||
    !dimensions.every((dimension) => vocabulary.includes(dimension))
  ) {
    return undefined;
  }
  return Object.freeze({ kind, dimensions: Object.freeze([...(dimensions as string[])]) });
}

const PLACEHOLDER_CODES: ReadonlySet<string> = new Set(
  Object.values(UNRETAINABLE_INFERENCE_REJECTIONS).map((reason) => reason.code),
);

/**
 * Readmit the correction's coded pair. A caller-built input could carry any
 * value here, so both fields must be strings inside the retained grammar. A
 * pair that is not retainable, or that already is the placeholder, admits as
 * no code at all.
 */
function admittedRejection(
  correction: InferenceResponseCorrectionV1,
): InferenceRejectionReasonV1 | undefined {
  const rejection: unknown = correction.rejection;
  if (!rejection || typeof rejection !== "object") return undefined;
  const { code, location } = rejection as Record<string, unknown>;
  if (typeof code !== "string" || typeof location !== "string") return undefined;
  const retained = retainedInferenceRejection({ code, location });
  return PLACEHOLDER_CODES.has(retained.code) ? undefined : retained;
}
