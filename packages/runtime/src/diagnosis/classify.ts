// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Reads one failing run index row into a cause, its owner class, and the next
 * action. Only closed row fields are read, so the same row always yields the
 * same answer, and every cause names the `--where` clauses that select it.
 *
 * Rules run in order and the first match wins. Telemetry that proves the cut
 * or the provider's answer comes before the rejection code, because a code
 * such as `invalid-json` is also what a reply cut at its allowance produces.
 */
import {
  READ_LOOP_LIMITS,
  READ_LOOP_STOP_CODES,
  STEP_EXECUTION_CEILING_CODES,
} from "../config/execution-limit-stops.js";
import type { StepExecutionCeilingSource } from "../config/execution-ceiling-source.js";
import { OPERATIONAL_LIMIT_NAMES } from "../config/limit-stop.js";
import { LIMIT_DEFINITION_BY_NAME, type LimitDefinition } from "../config/limits.generated.js";
import {
  isContextPreflightCauseReason,
  type ContextPreflightCauseReason,
} from "../context/contracts.js";
import type { FailureClass } from "../operator/failure-class.js";
import {
  ATTEMPT_DEADLINE_AWAITING_PROVIDER,
  ATTEMPT_DEADLINE_IN_TOOL_LOOP,
  inferenceRejectionFailureClass,
} from "../operator/failure-classification.js";
import { situationRowForId } from "../operator/situation-catalog.js";
import { isHttpStatus } from "../records/model-telemetry.js";
import type { RunIndexRowV1 } from "../records/run-index.js";
import { RUN_INDEX_UNAVAILABLE } from "../records/run-index-query.js";
import {
  REQUEST_POLICY_REFUSALS,
  requestPolicyRefusalOfCode,
} from "../model/request-policy-refusals.js";
import { isHostBuiltQualityRejection } from "../workflow-execution/quality-rejection-retryability.js";
import { TECHNICAL_CORRECTION_BYTE_BOUNDS } from "../workflow-execution/technical-rejection-retryability.js";
import {
  WORKFLOW_SEARCH_CONTRACT_FAILURE_CODE,
  workflowSearchPhaseOfCode,
} from "../workflow-execution/search-failure-codes.js";
import {
  DIAGNOSIS_CAUSE_OWNERS,
  type DiagnosisAlsoCauseV1,
  type DiagnosisCause,
  type DiagnosisEvidenceV1,
  type DiagnosisOwnerClass,
} from "./contracts.js";

/** An attempt row's whole-attempt output figures. */
export type AttemptOutputTotals = NonNullable<DiagnosisEvidenceV1["attemptTotals"]>;

/** The row's whole-attempt figures, or `null` when it carries none of them. */
export function attemptOutputTotalsOf(row: RunIndexRowV1): AttemptOutputTotals | null {
  if (row.rowKind !== "attempt") return null;
  const totals = {
    outputTokens: row.attemptOutputTokens,
    allowance: row.outputAllowance,
    continuations: row.continuations,
  };
  return Object.values(totals).every((value) => value === null) ? null : totals;
}

/** Commands a next action can name; built by the caller for the run's index location. */
export interface CauseCommands {
  readonly whyJson: string;
  readonly runsShow: string;
}

export interface CauseReading {
  readonly cause: DiagnosisCause;
  readonly ownerClass: DiagnosisOwnerClass;
  readonly why: string;
  readonly nextAction: string;
  readonly nextCommand: string | null;
  /** Cause-defining `--where` clauses, beyond the run, step, provider, and model. */
  readonly signature: Readonly<Record<string, string>>;
  readonly limitations: readonly string[];
  readonly alsoCause: DiagnosisAlsoCauseV1 | null;
}

/** Outcomes a provider or the transport produced rather than the reply's content. */
const PROVIDER_OUTCOMES: ReadonlySet<string> = new Set([
  "provider-transient",
  "provider-terminal",
  "invalid-request",
  "throttled",
  "timeout",
]);

// Next commands are read-only inspections. None is `docsfab doctor`: a run
// that got past planning must not be sent back to readiness checks.
const PROFILE_INSPECT = "docsfab profile inspect";
const CONFIG_INSPECT = "docsfab config inspect";

// These closed codes describe a host-bound finalization check after the steps
// succeeded. New producer codes need an explicit diagnosis decision.
const EDITORIAL_FINALIZATION_HOST_BOUND_CODES: ReadonlySet<string> = new Set([
  "editorial-finalization-branch-coverage-invalid-shape",
  "editorial-finalization-branch-coverage-invalid-value",
  "editorial-finalization-branch-coverage-credential-material",
  "editorial-finalization-branch-coverage-digest-mismatch",
  "editorial-finalization-branch-coverage-manifest-mismatch",
  "editorial-finalization-branch-coverage-coverage-unverified",
  "editorial-finalization-host-invalid-shape",
  "editorial-finalization-host-invalid-value",
  "editorial-finalization-host-credential-material",
  "editorial-finalization-host-evidence-unavailable",
  "editorial-finalization-host-identity-mismatch",
  "editorial-finalization-host-producer-mismatch",
  "editorial-finalization-decision-invalid-shape",
  "editorial-finalization-decision-invalid-value",
  "editorial-finalization-decision-credential-material",
  "editorial-finalization-decision-digest-mismatch",
  "editorial-finalization-decision-evidence-unavailable",
  "editorial-finalization-decision-producer-mismatch",
  "editorial-finalization-decision-identity-mismatch",
]);

/** A row's in-stream provider status, when a newer index projection carries one. */
export function streamErrorStatusOf(row: RunIndexRowV1): number | null {
  const value = (row as { readonly streamErrorStatus?: unknown }).streamErrorStatus;
  return isHttpStatus(value) ? value : null;
}

const RAISE_ALLOWANCE =
  "Raise the output allowance (maxOutputTokens) of this model's profile so the answer fits in one turn, or use a model whose answer to this step fits it; a rerun with the same allowance is cut the same way.";

/** A finding limitation: the host asked for the answer before reading finished. */
export const ANSWER_ASKED_EARLY_LIMITATION = "answer-asked-early";

/**
 * Reads a failing `attempt` row. A succeeded attempt is not a failure and is
 * not passed here.
 */
export function classifyAttemptRow(row: RunIndexRowV1, commands: CauseCommands): CauseReading {
  const reading = weighOutputTotals(
    row,
    classifyAttemptRowFields(row, commands),
    attemptOutputTotalsOf(row),
  );
  // The host asked this attempt to answer before it finished reading:
  // whatever the cause, the answer came from partial reading.
  return row.concludeNow === null
    ? reading
    : { ...reading, limitations: [...reading.limitations, ANSWER_ASKED_EARLY_LIMITATION] };
}

/**
 * A reply the host continued after a cut at the output limit and then refused
 * still reads as unparseable or misshapen JSON, and `outputTokens` is the last
 * turn's only. The row's whole-attempt total decides: over the allowance after
 * a continuation, the output limit owns it and the shape is the second cause.
 * Without the total, both are named and neither is asserted.
 */
function weighOutputTotals(
  row: RunIndexRowV1,
  base: CauseReading,
  totals: AttemptOutputTotals | null,
): CauseReading {
  if (base.cause !== "reply-not-json" && base.cause !== "reply-shape-rejected") return base;
  const known =
    totals !== null &&
    totals.outputTokens !== null &&
    totals.allowance !== null &&
    totals.continuations !== null;
  if (!known) {
    return {
      ...base,
      limitations: [...base.limitations, "attempt-output-total-not-recorded"],
      alsoCause: {
        ownerClass: DIAGNOSIS_CAUSE_OWNERS["reply-continued-over-allowance"],
        cause: "reply-continued-over-allowance",
        why: "The index row does not give this attempt's total output tokens and continuations (an earlier DocsFab indexed it, or its record kept no turn ledger), so a reply cut at the output limit and continued past it cannot be ruled out.",
        nextAction: RAISE_ALLOWANCE,
        nextCommand: PROFILE_INSPECT,
      },
    };
  }
  const { outputTokens, allowance, continuations } = totals as {
    readonly outputTokens: number;
    readonly allowance: number;
    readonly continuations: number;
  };
  if (continuations < 1 || outputTokens <= allowance) return base;
  return reading("reply-continued-over-allowance", {
    why: `The answer was cut at the output limit and continued ${String(continuations)} ${continuations === 1 ? "time" : "times"}: the attempt produced ${String(outputTokens)} output tokens against a per-request allowance of ${String(allowance)}, and the stitched reply was still refused by ${row.rejectionCode ?? RUN_INDEX_UNAVAILABLE}${locationOf(row)}. The last turn alone, which finishReason and outputTokens describe, produced ${count(row.outputTokens)} tokens.`,
    nextAction: RAISE_ALLOWANCE,
    nextCommand: PROFILE_INSPECT,
    signature: base.signature,
    alsoCause: {
      ownerClass: base.ownerClass,
      cause: base.cause,
      why: base.why,
      nextAction: base.nextAction,
      nextCommand: base.nextCommand,
    },
  });
}

function classifyAttemptRowFields(row: RunIndexRowV1, commands: CauseCommands): CauseReading {
  // Coordinator failures are host failures, even when Pi reports an error-like
  // finish reason or other provider-shaped metadata alongside the checkpoint.
  if (row.outcome === "host-runtime-failure") {
    if (
      row.failureClass === "infrastructure" &&
      row.failureLayer === "inference" &&
      row.failureCode === "invalid-execution-lease-coordinator"
    ) {
      return reading("host-runtime-failure", {
        why: "The host execution-lease coordinator failed while checkpointing the inference attempt; the saved attempt identifies this as host infrastructure, not a provider failure.",
        nextAction:
          "Report this DocsFab execution-lease coordinator defect with the saved run and diagnosis JSON. Changing provider settings will not repair the host checkpoint boundary.",
        nextCommand: commands.runsShow,
        signature: {
          outcome: "host-runtime-failure",
          failureClass: "infrastructure",
          failureLayer: "inference",
          failureCode: "invalid-execution-lease-coordinator",
        },
      });
    }
    return uncatalogued(row, commands, row.failureCode ?? row.outcome);
  }

  // A refused request was never sent, so no telemetry or reply outranks it.
  const refused = requestPolicyRefused(row, commands);
  if (refused) return refused;
  const outcome = row.outcome;
  const tokens = `${count(row.outputTokens)} of ${count(row.outputAllowance)} output tokens`;
  const rejected = rejectionClause(row);

  // A host progress stop names its own bound. The read-loop code is the more
  // specific reading when the same attempt also ended at a lease ceiling.
  const progress = progressStopOf(row, commands);
  if (progress) return progress;

  if (row.finishReason === "length") {
    return reading("output-allowance-reached", {
      why: `The reply stopped at the output allowance: finish reason length, ${tokens}${rejected}.`,
      nextAction:
        "Raise the output allowance (maxOutputTokens) of this model's profile, or use a model whose answer to this step fits it. A rerun with the same allowance stops at the same limit.",
      nextCommand: PROFILE_INSPECT,
      signature: { outcome, finishReason: "length", ...codeClause(row) },
    });
  }

  if (
    row.rejectedReplyParseCode === "json-unexpected-end" &&
    row.outputTokens !== null &&
    row.outputAllowance !== null &&
    row.outputTokens >= row.outputAllowance
  ) {
    return reading("reply-cut-over-allowance", {
      why: `The reply ended before its JSON closed, and its last turn used ${tokens}, at or over the allowance, although the provider reported finish reason ${row.finishReason ?? RUN_INDEX_UNAVAILABLE}${rejected}.`,
      nextAction:
        "Raise the output allowance (maxOutputTokens) of this model's profile, or use a model whose answer to this step fits it; reasoning output counts against the same allowance.",
      nextCommand: PROFILE_INSPECT,
      signature: {
        outcome,
        ...codeClause(row),
        rejectedReplyParseCode: "json-unexpected-end",
      },
    });
  }

  if (row.rejectionCode !== null) return classifyRejection(row, commands);

  const status = row.httpStatus;
  if (status !== null) return classifyHttpStatus(row, status);

  if (row.providerErrorClass !== null) return classifyUnansweredProviderError(row);

  if (PROVIDER_OUTCOMES.has(outcome)) {
    if (row.model === null && row.finishReason === null && row.outputAllowance === null) {
      return reading("request-not-sent", {
        why: "No model request was recorded for this attempt: it has no model, finish reason, or output allowance, so DocsFab stopped before sending, for example at its endpoint checks.",
        nextAction:
          "Check the configured model endpoint, including its scheme and host, against the endpoint rules DocsFab enforces, then rerun.",
        nextCommand: PROFILE_INSPECT,
        signature: {
          outcome,
          finishReason: RUN_INDEX_UNAVAILABLE,
          providerErrorClass: RUN_INDEX_UNAVAILABLE,
        },
      });
    }
    if (row.finishReason === "error") {
      return reading("boundary-refusal", {
        why: "The attempt ended with finish reason error, but no provider error class or HTTP status was recorded: the provider's response reached DocsFab, for example as an error event inside a successful stream, and DocsFab's own boundary refused it instead of classifying it.",
        nextAction:
          "Report this DocsFab defect with the diagnosis JSON. A rerun can pass when the provider answers differently, but the unclassified refusal is DocsFab's to fix; changing the model or provider settings does not address it.",
        nextCommand: commands.whyJson,
        signature: {
          outcome,
          finishReason: "error",
          providerErrorClass: RUN_INDEX_UNAVAILABLE,
        },
      });
    }
    if (outcome === "throttled") return rateLimited(row, "the provider throttled the request");
    if (outcome === "timeout") return providerTimeout(row);
  }

  if (outcome === "blank-response") {
    return reading("reply-blank", {
      why: "The model returned an empty reply.",
      nextAction:
        "Rerun once; if the reply is empty again for this step, use another model for it.",
      nextCommand: null,
      signature: { outcome },
    });
  }
  if (outcome === "context-exhausted") {
    return reading("context-window-exhausted", {
      why: "The step's input did not fit the model's context window.",
      nextAction:
        "Use a model with a larger context window for this step, or narrow the run's scope, then rerun.",
      nextCommand: PROFILE_INSPECT,
      signature: { outcome },
    });
  }
  if (outcome === "malformed-response") {
    return reading("reply-shape-rejected", {
      why: "The reply was refused as malformed, and the record names no rejection rule.",
      nextAction:
        "Inspect the rejected attempt, then check that the endpoint enforces structured output for this model.",
      nextCommand: commands.runsShow,
      signature: { outcome, rejectionCode: RUN_INDEX_UNAVAILABLE },
    });
  }
  return uncatalogued(row, commands, outcome);
}

/** Reads a failing `step` or `run` row from the failure class the record saved. */
export function classifyRecordedFailure(row: RunIndexRowV1, commands: CauseCommands): CauseReading {
  const signature: Record<string, string> = {
    rowKind: row.rowKind,
    failureClass: row.failureClass ?? RUN_INDEX_UNAVAILABLE,
    ...(row.rejectionCode !== null ? { rejectionCode: row.rejectionCode } : {}),
  };
  const code =
    row.rejectionCode !== null
      ? ` (${row.rejectionCode}${locationOf(row)})`
      : row.failureCode !== null
        ? ` (code ${row.failureCode})`
        : "";
  const subject = row.rowKind === "run" ? "The run" : `Step ${row.stepId ?? RUN_INDEX_UNAVAILABLE}`;
  const recorded = `${subject} recorded failure class ${row.failureClass ?? RUN_INDEX_UNAVAILABLE} at layer ${row.failureLayer ?? RUN_INDEX_UNAVAILABLE}${code}.`;
  // The code identifies a host check even in retained rows whose historical
  // class was model-content. An index row has no full command or result.
  if (row.failureCode === "required-check-failed") {
    return reading("required-check-failed", {
      why: `${recorded} A repository-required check failed on the candidate. The index does not retain its full command or result, and this evidence does not establish whether the baseline, candidate, or environment caused the failure.`,
      nextAction:
        "Inspect the saved run's required-check command and result, compare against a separately validated baseline check if available, then correct the candidate or repository and run the check again. Do not retry unchanged.",
      nextCommand: commands.runsShow,
      signature: { ...signature, failureCode: row.failureCode },
    });
  }
  const refused = requestPolicyRefused(row, commands);
  if (refused) return refused;
  const contextStop = contextPreflightStop(row, commands, signature, recorded);
  if (contextStop) return contextStop;
  if (row.rejectionCode !== null && isHostBuiltQualityRejection(row.rejectionCode)) {
    return hostBuiltRefusal(row, commands, signature, recorded);
  }
  const searchStop = governedSearchStop(row, commands, signature, recorded);
  if (searchStop) return searchStop;
  // A step that ended at its execution ceiling, including one whose final
  // attempt answered at it, is a progress stop, not an operator setting.
  const progress = progressStopOf(row, commands);
  if (progress) return progress;
  if (row.failureClass === "bound") {
    const named = scopeLimitStop(row, commands, signature, `${subject} stopped at`);
    if (named) return named;
  }
  if (
    row.rowKind === "run" &&
    row.outcome === "failed" &&
    row.failureLayer === "workflow" &&
    row.failureClass === "contract-shape" &&
    row.failureCode !== null &&
    EDITORIAL_FINALIZATION_HOST_BOUND_CODES.has(row.failureCode)
  ) {
    return reading("host-built-value-refused", {
      why: `${recorded} A DocsFab check of the host-bound final editorial evidence failed after every step succeeded. The index does not retain the refusal location; inspect the saved run for it.`,
      nextAction:
        "Report this DocsFab defect with the saved run and diagnosis JSON. Do not retry unchanged inference.",
      nextCommand: commands.whyJson,
      signature: { ...signature, failureCode: row.failureCode },
    });
  }
  if (
    row.rowKind === "run" &&
    row.outcome === "failed" &&
    row.failureLayer === "workflow" &&
    row.failureClass === "model-content" &&
    (row.failureCode === "editorial-finalization-host-conflicting-assessment" ||
      row.failureCode === "editorial-finalization-decision-independent-rejection")
  ) {
    return reading("reply-content-rejected", {
      why: `${recorded} ${row.failureCode === "editorial-finalization-host-conflicting-assessment" ? "The evaluator's rationale repeats the planner's, so it is not independent evidence." : "The independent assessments did not support the final editorial decision."} The index does not retain the refusal location.`,
      nextAction:
        "Inspect the recorded assessments in the saved run. Do not retry unchanged inference.",
      nextCommand: commands.runsShow,
      signature: { ...signature, failureCode: row.failureCode },
    });
  }
  if (
    row.rowKind === "run" &&
    row.outcome === "failed" &&
    row.failureLayer === "workflow" &&
    row.failureClass === "unknown" &&
    row.failureCode === "editorial-finalization-uncoded-error"
  ) {
    return reading("uncatalogued-failure", {
      why: `${recorded} Final editorial evidence was refused without a closed code; the index does not retain the refusal location.`,
      nextAction:
        "Report this DocsFab defect with the saved run and diagnosis JSON. Do not retry unchanged inference.",
      nextCommand: commands.whyJson,
      signature: { ...signature, failureCode: row.failureCode },
    });
  }
  const cause = causeForFailureClass(row.failureClass, row.failureLayer);
  switch (cause) {
    case "reply-content-rejected":
      return reading(cause, {
        why: `${recorded} The artifact was well formed, but a host rule rejected its content.`,
        nextAction:
          "Use a model that follows this step's rules, or report the rule with the diagnosis JSON if the artifact should pass.",
        nextCommand: null,
        signature,
      });
    case "reply-shape-rejected":
      return reading(cause, {
        why: `${recorded} The artifact did not match its contract shape.`,
        nextAction:
          "Check that the endpoint enforces structured output for this model, or use a model that follows the step's contract.",
        nextCommand: PROFILE_INSPECT,
        signature,
      });
    case "output-allowance-reached":
      return reading(cause, {
        why: `${recorded} The model output allowance was reached.`,
        nextAction: "Raise the output allowance (maxOutputTokens) of this model's profile.",
        nextCommand: PROFILE_INSPECT,
        signature,
      });
    case "uncatalogued-failure":
      return reading(cause, {
        why: `${recorded} DocsFab has no evidence of one cause for it.`,
        nextAction:
          "Report this DocsFab defect with the diagnosis JSON so the failure gets a class; the saved record holds the rest.",
        nextCommand: commands.runsShow,
        signature,
      });
    case "provider-unavailable":
      return reading(cause, {
        why: `${recorded} A provider or transport condition ended it.`,
        nextAction: "Rerun after the provider recovers.",
        nextCommand: null,
        signature,
      });
    default:
      return reading(cause, {
        why: recorded,
        nextAction:
          "Correct the request, configuration, credential, or limit the saved run names, then rerun.",
        nextCommand: commands.runsShow,
        signature,
      });
  }
}

/**
 * A row whose failure code names a request-policy refusal: DocsFab refused its
 * own outbound request before sending it. The catalog row names
 * what was refused and the next action; `policy-subject` is the installation's.
 */
function requestPolicyRefused(row: RunIndexRowV1, commands: CauseCommands): CauseReading | null {
  const refusal = requestPolicyRefusalOfCode(row.failureCode);
  if (!refusal) return null;
  const entry = REQUEST_POLICY_REFUSALS[refusal];
  return reading(
    refusal === "policy-subject" ? "installed-policy-unverified" : "request-policy-refused",
    {
      why: `DocsFab refused its own outbound request before sending it (${row.failureCode}): ${entry.meaning}`,
      nextAction: entry.next,
      nextCommand: refusal === "policy-subject" ? null : commands.whyJson,
      signature: { failureCode: row.failureCode as string },
    },
  );
}

/**
 * What each context preflight cause means for the step it stopped, and whose
 * problem it is. The next action is the code's situation catalog row.
 */
const CONTEXT_PREFLIGHT_STOPS: Readonly<
  Record<ContextPreflightCauseReason, { readonly cause: DiagnosisCause; readonly meaning: string }>
> = Object.freeze({
  "content-index-refused": {
    cause: "operator-input-refused",
    meaning:
      "The content index refused something in the checkout, so the step had no context packet; its contextPreflight.cause names the content index code and the file.",
  },
  "content-index-unreadable": {
    cause: "host-dependency-unavailable",
    meaning:
      "Reading the checkout for the content index failed, so the step had no context packet; its contextPreflight.cause names the file-system error.",
  },
  "context-compile-failed": {
    cause: "host-built-value-refused",
    meaning:
      "DocsFab could not compile context from the input DocsFab built, so the step had no context packet; its contextPreflight.cause names the raw reason.",
  },
  "navigation-alias-refused": {
    cause: "operator-input-refused",
    meaning:
      "The step selected a symlink, which DocsFab never follows, so it had no context packet; its contextPreflight.cause names the symlink.",
  },
});

/**
 * A step that stopped because its context preflight left it without a
 * packet, for a cause that has its own code. Only a write step stops this
 * way; a read-only step runs on without a packet.
 */
function contextPreflightStop(
  row: RunIndexRowV1,
  commands: CauseCommands,
  signature: Record<string, string>,
  recorded: string,
): CauseReading | null {
  const code = row.failureCode;
  if (!isContextPreflightCauseReason(code)) return null;
  const nextAction = situationRowForId(code)?.nextAction;
  if (!nextAction) return null;
  const stop = CONTEXT_PREFLIGHT_STOPS[code];
  return reading(stop.cause, {
    why: `${recorded} ${stop.meaning}`,
    nextAction,
    nextCommand: commands.runsShow,
    signature: { ...signature, failureCode: code },
  });
}

/**
 * A quality code that refuses a value DocsFab built or supplied, as the
 * quality-rejection retryability table marks it. Its failure class can read as
 * contract shape, but no model or endpoint change repairs it.
 */
function hostBuiltRefusal(
  row: RunIndexRowV1,
  commands: CauseCommands,
  signature: Record<string, string>,
  recorded: string,
): CauseReading {
  return reading("host-built-value-refused", {
    why: `${recorded} DocsFab built or supplied the refused value itself, so the refusal is a DocsFab defect, not the model's${row.model === null ? "" : ` (${row.model})`}.`,
    nextAction:
      "Report this DocsFab defect with the diagnosis JSON; rerunning, or switching model or endpoint, meets the same host-built value.",
    nextCommand: commands.whyJson,
    signature,
  });
}

/**
 * A governed workflow search stop (#1927) ends its step before that step's model call,
 * so it never reads as a model's reply. The coordinator could not finish its
 * search over the checkout; the other phases are host contract checks.
 */
function governedSearchStop(
  row: RunIndexRowV1,
  commands: CauseCommands,
  signature: Record<string, string>,
  recorded: string,
): CauseReading | null {
  const phase = workflowSearchPhaseOfCode(row.failureCode);
  if (row.failureCode === WORKFLOW_SEARCH_CONTRACT_FAILURE_CODE) {
    return reading("host-built-value-refused", {
      why: `${recorded} A trusted bounded-search or search-progress contract refused evidence inside the host search boundary before this step's inference. The saved error names its phase and a sanitized inner code when available.`,
      nextAction:
        "Report this DocsFab defect with the saved run and diagnosis JSON. Changing model or endpoint settings will not repair the host search contract.",
      nextCommand: commands.whyJson,
      signature: { ...signature, failureCode: row.failureCode },
    });
  }
  if (phase === undefined) return null;
  const stopped = `${recorded} Governed workflow search stopped in its ${phase} phase, before this step's inference.`;
  if (phase === "coordinator") {
    return reading("search-cause-unresolved", {
      why: `${stopped} The saved code does not establish whether the checkout, a host dependency, or DocsFab caused this coordinator stop. Inspect the sanitized step error for its type and inner code.`,
      nextAction:
        "Inspect the saved step error and checkout. If the cause remains unclear, report the saved run and diagnosis JSON for investigation.",
      nextCommand: commands.runsShow,
      signature,
    });
  }
  return reading("host-built-value-refused", {
    why: `${stopped} A host contract check refused a value DocsFab built itself, so the refusal is a DocsFab defect, not the model's.`,
    nextAction:
      "Report this DocsFab defect with the diagnosis JSON; rerunning, or switching model or endpoint, meets the same refusal.",
    nextCommand: commands.whyJson,
    signature,
  });
}

function classifyRejection(row: RunIndexRowV1, commands: CauseCommands): CauseReading {
  const code = row.rejectionCode as string;
  const where = ` at ${row.rejectionLocation ?? RUN_INDEX_UNAVAILABLE}`;
  const parse = row.rejectedReplyParseCode;
  if (parse !== null && parse.startsWith("json-")) {
    return reading("reply-not-json", {
      why: `${parseSentence(parse)} Rejected by ${code}${where}; last turn ${count(row.outputTokens)} of ${count(row.outputAllowance)} output tokens, finish reason ${row.finishReason ?? RUN_INDEX_UNAVAILABLE}.`,
      nextAction:
        "Check that the endpoint enforces JSON output (structured output or a JSON response format) for this model, or use a model that answers this step in JSON. The step's contract does not change.",
      nextCommand: PROFILE_INSPECT,
      signature: { outcome: row.outcome, rejectionCode: code, rejectedReplyParseCode: parse },
    });
  }
  const failureClass = inferenceRejectionFailureClass(code);
  const signature = {
    outcome: row.outcome,
    rejectionCode: code,
    ...(parse !== null ? { rejectedReplyParseCode: parse } : {}),
  };
  if (isHostBuiltQualityRejection(code)) {
    return hostBuiltRefusal(
      row,
      commands,
      signature,
      `The attempt was refused by ${code}${where}.`,
    );
  }
  if (failureClass === "model-content") {
    return reading("reply-content-rejected", {
      why: `The reply was well formed, but the step's rule ${code} rejected its content${where}.`,
      nextAction:
        "This model does not follow this step's rule reliably: use another model for the step, or report the rule with the diagnosis JSON if the reply should pass.",
      nextCommand: null,
      signature,
    });
  }
  // On the tool-call answer path the forwarded arguments come from the
  // serving stack's tool-call parser, so the text answer is the remediation
  // when that parser regresses.
  if (failureClass === "contract-shape" && row.answerPath === "tool-call") {
    return reading("reply-shape-rejected", {
      why: `The submitted answer${parse === "parsed" ? " parsed as JSON, but" : ""} ${code} rejected its structure${where}.`,
      nextAction:
        "If this route's tool-call parser alters the submitted arguments, set DOCSFAB_ANSWER_SUBMISSION=text-final to answer in text; otherwise use a model that follows the submission contract.",
      nextCommand: commands.runsShow,
      signature,
    });
  }
  if (failureClass === "contract-shape") {
    return reading("reply-shape-rejected", {
      why: `The reply${parse === "parsed" ? " parsed as JSON, but" : ""} ${code} rejected its structure${where}.`,
      nextAction:
        "Check that the endpoint enforces structured output for this model, or use a model that follows the step's contract.",
      nextCommand: PROFILE_INSPECT,
      signature,
    });
  }
  if (failureClass === "bound") {
    const named = scopeLimitStop(row, commands, signature, `The attempt stopped at`);
    if (named) return named;
    if (!replyReachedAllowance(row) && code !== "text-truncated") {
      return reading("operational-limit-reached", {
        why: `The reply was refused by ${code}${where}, a configured size or count bound, not the output allowance: finish reason ${row.finishReason ?? RUN_INDEX_UNAVAILABLE}, ${count(row.outputTokens)} of ${count(row.outputAllowance)} output tokens.`,
        nextAction:
          "Read the bound, the observed value, and its remediation in the saved run's failure. For a review, narrow the request's scope, for example to one directory; raising the output allowance does not move this bound.",
        nextCommand: commands.runsShow,
        signature,
      });
    }
    return reading("output-allowance-reached", {
      why: `The reply was refused by ${code}${where}, a model output bound.`,
      nextAction: "Raise the output allowance (maxOutputTokens) of this model's profile.",
      nextCommand: PROFILE_INSPECT,
      signature,
    });
  }
  if (failureClass === undefined || failureClass === "unknown") {
    return uncatalogued(row, commands, code);
  }
  return reading(causeForFailureClass(failureClass, "inference"), {
    why: `The attempt was refused by ${code}${where} (failure class ${failureClass}).`,
    nextAction: "Correct the condition the rejection names, then rerun.",
    nextCommand: commands.runsShow,
    signature,
  });
}

function classifyHttpStatus(row: RunIndexRowV1, status: number): CauseReading {
  const signature = { outcome: row.outcome, httpStatus: String(status) };
  const answered = `The provider answered HTTP ${String(status)}${row.providerErrorClass ? ` (${row.providerErrorClass})` : ""}`;
  if (status === 410) {
    return reading("provider-model-retired", {
      why: `${answered}: it no longer serves model ${row.model ?? RUN_INDEX_UNAVAILABLE} at this endpoint.`,
      nextAction:
        "Switch this step to a model or composition the provider still serves; waiting or rerunning cannot bring a retired model back.",
      nextCommand: PROFILE_INSPECT,
      signature,
    });
  }
  if (status === 429 || row.providerErrorClass === "rate-limit") {
    return rateLimited(row, answered.slice("The provider ".length), signature);
  }
  if (status === 401 || status === 403 || row.providerErrorClass === "auth") {
    return reading("provider-auth-refused", {
      why: `${answered}: the credential was refused or lacks access to this model.`,
      nextAction: "Check the configured credential and its access to this model, then rerun.",
      nextCommand: CONFIG_INSPECT,
      signature,
    });
  }
  if (status === 408 || status === 504 || row.providerErrorClass === "timeout") {
    return providerTimeout(row, signature);
  }
  if (row.providerErrorClass === "content-filter") return contentFilter(row, signature);
  if (status >= 500) {
    return reading("provider-server-error", {
      why: `${answered}, a provider-side failure such as overload or an outage.`,
      nextAction:
        "Rerun after the provider recovers; the same request fails again while it is overloaded or down. If it persists for this model, report it to the provider or use another model.",
      nextCommand: null,
      signature,
    });
  }
  return reading("provider-request-refused", {
    why: `${answered}: it refused the request as invalid for this endpoint or model.`,
    nextAction:
      "Check the endpoint URL, the model identifier, and the request features this endpoint supports, then rerun.",
    nextCommand: PROFILE_INSPECT,
    signature,
  });
}

/** A provider error with no HTTP error status: an error event inside a 2xx stream, or a cut. */
function classifyUnansweredProviderError(row: RunIndexRowV1): CauseReading {
  const errorClass = row.providerErrorClass as string;
  const signature = {
    outcome: row.outcome,
    providerErrorClass: errorClass,
    httpStatus: RUN_INDEX_UNAVAILABLE,
  };
  if (errorClass === "rate-limit")
    return rateLimited(row, "the provider reported a rate limit", signature);
  if (errorClass === "timeout") return providerTimeout(row, signature);
  if (errorClass === "auth") {
    return reading("provider-auth-refused", {
      why: "The provider reported an authentication error without an HTTP error status.",
      nextAction: "Check the configured credential and its access to this model, then rerun.",
      nextCommand: CONFIG_INSPECT,
      signature,
    });
  }
  if (errorClass === "content-filter") return contentFilter(row, signature);
  if (errorClass === "invalid-request") {
    return reading("provider-request-refused", {
      why: "The provider refused the request as invalid without an HTTP error status.",
      nextAction:
        "Check the endpoint URL, the model identifier, and the request features this endpoint supports, then rerun.",
      nextCommand: PROFILE_INSPECT,
      signature,
    });
  }
  // A newer telemetry class; older indexes read it as unavailable.
  if (errorClass === "stream-incomplete") {
    return reading("provider-stream-incomplete", {
      why: "The provider closed the response stream cleanly in the middle of the answer, without a finish reason or an end-of-stream marker.",
      nextAction:
        "This is a transient provider truncation, and DocsFab retries it within the step's retry budget. If it recurs across runs, use another model or composition, or report it to the provider.",
      nextCommand: null,
      signature,
    });
  }
  if (errorClass === "network") {
    return reading("provider-unavailable", {
      why: "The connection to the provider failed before it answered.",
      nextAction:
        "Rerun after the provider or network recovers; check the endpoint if it keeps failing.",
      nextCommand: null,
      signature,
    });
  }
  const stream = streamErrorStatusOf(row);
  return reading("provider-stream-error", {
    why: `The provider ended the response stream with an error (provider error class ${errorClass}) after a success status${stream === null ? "" : `; the stream declared status ${String(stream)}`}. Mid-stream errors of this kind are provider capacity or serving failures.`,
    nextAction:
      "Rerun after the provider recovers; the same request can fail again while the model is overloaded. If it persists for this model, report it to the provider or use another model.",
    nextCommand: null,
    signature,
    limitations: stream === null ? ["stream-error-status-not-indexed"] : [],
  });
}

function rateLimited(
  row: RunIndexRowV1,
  detail: string,
  signature: Readonly<Record<string, string>> = { outcome: row.outcome },
): CauseReading {
  return reading("provider-rate-limited", {
    why: `The provider refused the request for rate or quota: ${detail}.`,
    nextAction:
      "Wait for the provider's rate limit to reset, or run fewer requests at once, then rerun.",
    nextCommand: null,
    signature,
  });
}

function providerTimeout(
  row: RunIndexRowV1,
  signature: Readonly<Record<string, string>> = { outcome: row.outcome },
): CauseReading {
  return reading("provider-timeout", {
    why: "The provider did not answer within the request deadline.",
    nextAction: "Rerun after the provider recovers, or use a faster model or route for this step.",
    nextCommand: null,
    signature,
  });
}

function contentFilter(
  row: RunIndexRowV1,
  signature: Readonly<Record<string, string>>,
): CauseReading {
  return reading("provider-content-filter", {
    why: `The provider's content filter refused the ${row.outcome === "invalid-request" ? "request" : "reply"}.`,
    nextAction:
      "Review the documentation input for content the filter refuses, or use a route without that filter.",
    nextCommand: null,
    signature,
  });
}

const READ_LOOP_UNCHANGED_RE_READS_CODE =
  LIMIT_DEFINITION_BY_NAME[READ_LOOP_LIMITS.unchangedReReads]!.refusal;

/**
 * A read-loop stop (its rejection or failure code is a read-loop bound) or an
 * execution-ceiling stop (its failure code is a tool-call or provider-turn
 * ceiling), else `undefined`. Both are model progress: the model kept calling
 * tools instead of answering inside the step's bounds.
 */
function progressStopOf(row: RunIndexRowV1, commands: CauseCommands): CauseReading | undefined {
  const readLoopCode = [row.rejectionCode, row.failureCode].find(
    (code): code is string => code !== null && READ_LOOP_STOP_CODES.has(code),
  );
  if (readLoopCode !== undefined) return readLoopStopped(row, readLoopCode, commands);
  const ceiling =
    row.failureCode === null ? undefined : STEP_EXECUTION_CEILING_CODES.get(row.failureCode);
  if (ceiling !== undefined) return ceilingReached(row, row.failureCode!, ceiling, commands);
  if (row.failureCode === ATTEMPT_DEADLINE_IN_TOOL_LOOP) return deadlineInToolLoop(row, commands);
  if (row.failureCode === ATTEMPT_DEADLINE_AWAITING_PROVIDER) return deadlineAwaitingProvider(row);
  return undefined;
}

/**
 * The attempt timer fired while a provider request had no first byte: the
 * provider stalled, whatever the model did in earlier turns.
 */
function deadlineAwaitingProvider(row: RunIndexRowV1): CauseReading {
  return reading("attempt-deadline-awaiting-provider", {
    why: `DocsFab's attempt timer ended the attempt while a provider request had sent no first byte; the model had produced ${count(row.attemptOutputTokens)} output tokens in earlier turns of the attempt, so the provider, not the model, used the remaining time.`,
    nextAction:
      "Rerun after the provider recovers, or use a route whose time to first token fits this step's prompt; a model change does not shorten a provider stall.",
    nextCommand: null,
    signature: rowSignature(row, { failureCode: ATTEMPT_DEADLINE_AWAITING_PROVIDER }),
  });
}

/**
 * The attempt timer fired while the model was still producing tool calls (its
 * tools running, or tool calls streaming): model progress, not provider
 * capacity.
 */
function deadlineInToolLoop(row: RunIndexRowV1, commands: CauseCommands): CauseReading {
  return reading("attempt-deadline-in-tool-loop", {
    why: `DocsFab's attempt timer ended the attempt while the model was still calling tools: its last landed turn finished with ${row.finishReason ?? RUN_INDEX_UNAVAILABLE}, and the timer found its tools running or its next tool calls streaming, after ${count(row.attemptOutputTokens)} output tokens in the attempt. The model was working, not waiting on the provider.`,
    nextAction:
      "DocsFab asks a read-only step to conclude once only its answer reserve remains. If the step still ran out of time, use a model that answers this step sooner or narrow the request; a longer attempt timer is a composition re-qualification.",
    nextCommand: commands.runsShow,
    signature: rowSignature(row, { failureCode: ATTEMPT_DEADLINE_IN_TOOL_LOOP }),
  });
}

function rowSignature(row: RunIndexRowV1, clause: Record<string, string>): Record<string, string> {
  return row.rowKind === "attempt"
    ? { outcome: row.outcome, ...clause }
    : { rowKind: row.rowKind, ...clause };
}

function readLoopStopped(row: RunIndexRowV1, code: string, commands: CauseCommands): CauseReading {
  const across = code === READ_LOOP_UNCHANGED_RE_READS_CODE;
  const counted =
    across && row.maxUnchangedReReadsAcrossResults !== null
      ? ` It made ${String(row.maxUnchangedReReadsAcrossResults)} unchanged re-reads with no progress call between, at most ${count(row.maxRepeatsOfOneResult)} of any one result.`
      : !across && row.maxRepeatsOfOneResult !== null
        ? ` It re-read one unchanged result ${String(row.maxRepeatsOfOneResult)} times with no progress call between (${count(row.unchangedReReads)} unchanged re-reads in the attempt).`
        : "";
  return reading("read-loop-stopped", {
    why: `DocsFab ended the attempt as no-progress (${code}): the model kept re-reading ${across ? "results" : "a result"} it already had, unchanged, instead of answering.${counted}`,
    nextAction:
      "DocsFab retries this stop once and asks for the answer at the first withheld re-read. If the step still failed, use another model for this step or narrow the request; raising the read-loop limits only delays the stop.",
    nextCommand: commands.runsShow,
    signature: rowSignature(row, {
      [row.rejectionCode === code ? "rejectionCode" : "failureCode"]: code,
    }),
  });
}

const SEALED_PROVIDER_TURNS_CODE =
  LIMIT_DEFINITION_BY_NAME[OPERATIONAL_LIMIT_NAMES.sealedCompositionMaxProviderTurns]!.refusal;

/** The host overrides that can lower an execution ceiling, named by the catalog. */
const CEILING_OVERRIDES = [
  OPERATIONAL_LIMIT_NAMES.compositionMaxToolCallsPerStep,
  OPERATIONAL_LIMIT_NAMES.compositionMaxProviderTurns,
]
  .map((name) => LIMIT_DEFINITION_BY_NAME[name]!.override)
  .filter((override): override is string => typeof override === "string")
  .join(" or ");

const NARROW_OR_SWITCH =
  "Narrow the request, for example to fewer pages or sources, or use another model for this step, so the step finishes inside its ceiling.";

/** A row indexed before the source was projected: only its code is known. */
type CeilingSourceReading = StepExecutionCeilingSource | "host-provider-turn-code" | "not-indexed";

/**
 * What set the ceiling: the row's projected source, else what the code alone
 * says on a row indexed before the source was projected.
 */
function ceilingSourceOf(row: RunIndexRowV1, code: string): CeilingSourceReading {
  if (row.executionCeilingSource !== null) return row.executionCeilingSource;
  if (code === SEALED_PROVIDER_TURNS_CODE) return "sealed-budget";
  return STEP_EXECUTION_CEILING_CODES.get(code) === "provider-turns"
    ? "host-provider-turn-code"
    : "not-indexed";
}

/** Why a row cannot say what set its ceiling, as a limitation and a sentence. */
const UNKNOWN_CEILING_SOURCES = Object.freeze({
  "not-indexed": {
    limitation: "execution-ceiling-source-not-indexed",
    why: "the index row does not say what set it (an earlier DocsFab indexed the run)",
    next: "Re-import the run with docsfab runs import to read the ceiling's source from its record, or check",
  },
  "limits-not-recorded": {
    limitation: "execution-ceiling-limits-not-recorded",
    why: "the run record does not carry the run host's configured provider-turn limit and the composition's sealed budgets",
    next: "Check",
  },
  "codes-mismatch": {
    limitation: "execution-ceiling-codes-mismatch",
    why: "the recorded ceiling code names a ceiling that the stopped attempt's turn, lease, and recorded limits do not explain",
    next: "Read the saved run's limits and check",
  },
} as const);

/**
 * A step that used its whole execution ceiling before answering. The model's
 * progress owns it when the composition's sealed budget set the ceiling; the
 * operator's configuration owns it when a host limit or an override did, with
 * the model's progress as the second cause.
 */
function ceilingReached(
  row: RunIndexRowV1,
  code: string,
  ceiling: "tool-calls" | "provider-turns",
  commands: CauseCommands,
): CauseReading {
  const noun = ceiling === "tool-calls" ? "tool-call" : "provider-turn";
  const reReads =
    row.unchangedReReads !== null && row.unchangedReReads > 0
      ? ` It made ${String(row.unchangedReReads)} unchanged re-reads on the way.`
      : "";
  const used = `The step used its whole ${noun} ceiling before the model answered (${code}).${reReads}`;
  const signature = rowSignature(row, { failureCode: code });
  const progress = {
    why: `${used} The model kept calling tools instead of answering inside the step's ceiling.`,
    nextAction: `${NARROW_OR_SWITCH} The saved run names the ceiling.`,
    nextCommand: commands.runsShow,
  };
  const source = ceilingSourceOf(row, code);
  if (source === "sealed-budget") {
    return reading("execution-ceiling-reached", {
      why: `${used} The ceiling is fitted to the composition's sealed turn budget, which only re-qualifying the composition raises.`,
      nextAction: progress.nextAction,
      nextCommand: progress.nextCommand,
      signature,
    });
  }
  const alsoCause = {
    ownerClass: DIAGNOSIS_CAUSE_OWNERS["execution-ceiling-reached"],
    cause: "execution-ceiling-reached" as const,
    ...progress,
  };
  if (source === "operator-override") {
    return reading("execution-ceiling-configured", {
      why: `${used} An operator override lowered this ceiling below its catalog value.`,
      nextAction: `Raise or remove the override (${CEILING_OVERRIDES}) so the step gets its catalog ceiling, then start a new run. ${NARROW_OR_SWITCH}`,
      nextCommand: CONFIG_INSPECT,
      signature,
      alsoCause,
    });
  }
  if (source === "host-limit") {
    return reading("execution-ceiling-configured", {
      why: `${used} The run host's execution limit, at its catalog value, set this ceiling, not a composition's sealed budget.`,
      nextAction: `The host limit is at its catalog value and an override can only lower it. ${NARROW_OR_SWITCH}`,
      nextCommand: CONFIG_INSPECT,
      signature,
      alsoCause,
    });
  }
  if (source === "host-provider-turn-code") {
    return reading("execution-ceiling-configured", {
      why: `${used} The code names the host provider-turn limit, not a composition's sealed budget; the index row does not say whether an override lowered that limit.`,
      nextAction: `Check whether ${LIMIT_DEFINITION_BY_NAME[OPERATIONAL_LIMIT_NAMES.compositionMaxProviderTurns]!.override} lowered the limit on the run host; raise or remove it if so. ${NARROW_OR_SWITCH}`,
      nextCommand: CONFIG_INSPECT,
      signature,
      alsoCause,
    });
  }
  const unknown = UNKNOWN_CEILING_SOURCES[source];
  return reading("execution-ceiling-reached", {
    ...progress,
    signature,
    limitations: [unknown.limitation],
    alsoCause: {
      ownerClass: DIAGNOSIS_CAUSE_OWNERS["execution-ceiling-configured"],
      cause: "execution-ceiling-configured",
      why: `DocsFab cannot tell what set this ${noun} ceiling: ${unknown.why}. An operator override that lowered it cannot be ruled out.`,
      nextAction: `${unknown.next} the overrides on the run host (${CEILING_OVERRIDES}).`,
      nextCommand: CONFIG_INSPECT,
    },
  });
}

/** The review scope bounds, by the catalog refusal each records. */
const SCOPE_LIMIT_BY_REFUSAL: ReadonlyMap<string, LimitDefinition> = new Map(
  Object.values(TECHNICAL_CORRECTION_BYTE_BOUNDS).map(({ code, limit }) => [
    code,
    LIMIT_DEFINITION_BY_NAME[limit]!,
  ]),
);

/** Whether the reply itself was cut at, or used all of, its output allowance. */
function replyReachedAllowance(row: RunIndexRowV1): boolean {
  return (
    row.finishReason === "length" ||
    (row.outputTokens !== null &&
      row.outputAllowance !== null &&
      row.outputTokens >= row.outputAllowance)
  );
}

/**
 * A stop at a review scope bound, which its recorded code names: the scope is
 * too large for the step's record, whatever the output allowance was. Read
 * with the limit's own remediation.
 */
function scopeLimitStop(
  row: RunIndexRowV1,
  commands: CauseCommands,
  signature: Readonly<Record<string, string>>,
  subject: string,
): CauseReading | null {
  const code = row.rejectionCode ?? row.failureCode;
  const definition = code === null ? undefined : SCOPE_LIMIT_BY_REFUSAL.get(code);
  if (!definition) return null;
  const tokens =
    row.outputAllowance === null
      ? ""
      : ` The output allowance did not bind: finish reason ${row.finishReason ?? RUN_INDEX_UNAVAILABLE}, ${count(row.outputTokens)} of ${count(row.outputAllowance)} output tokens.`;
  return reading("operational-limit-reached", {
    why: `${subject} ${definition.name} = ${definition.value} ${definition.unit} (${definition.refusal}${row.rejectionCode !== null ? locationOf(row) : ""}).${replyReachedAllowance(row) ? "" : tokens} The saved run's failure names the observed value.`,
    nextAction: definition.remediation,
    nextCommand: commands.runsShow,
    signature,
  });
}

function uncatalogued(row: RunIndexRowV1, commands: CauseCommands, code: string): CauseReading {
  return reading("uncatalogued-failure", {
    why: `DocsFab recorded ${code}${row.rejectionCode !== null ? locationOf(row) : ""}, which its failure catalog does not classify, and the row carries no provider evidence that names a cause.`,
    nextAction:
      "Report this DocsFab defect with the diagnosis JSON so the code gets a class; the saved record holds the rest.",
    nextCommand: commands.runsShow,
    signature: { outcome: row.outcome, ...codeClause(row) },
  });
}

/** Owner of a recorded failure class; `bound` and `infrastructure` depend on the layer. */
function causeForFailureClass(
  failureClass: FailureClass | null,
  layer: string | null,
): DiagnosisCause {
  switch (failureClass) {
    case "model-content":
      return "reply-content-rejected";
    case "contract-shape":
      return "reply-shape-rejected";
    case "planning-refusal":
    case "operator-input":
      return "operator-input-refused";
    case "bound":
      return layer === "inference" ? "output-allowance-reached" : "operational-limit-reached";
    case "auth":
      return "provider-auth-refused";
    case "infrastructure":
      return layer === "inference" ? "provider-unavailable" : "host-dependency-unavailable";
    case "flake":
      return "provider-unavailable";
    case "cancelled":
      return "run-cancelled";
    default:
      return "uncatalogued-failure";
  }
}

function reading(
  cause: DiagnosisCause,
  fields: Omit<CauseReading, "cause" | "ownerClass" | "limitations" | "alsoCause"> & {
    readonly limitations?: readonly string[];
    readonly alsoCause?: DiagnosisAlsoCauseV1;
  },
): CauseReading {
  return {
    cause,
    ownerClass: DIAGNOSIS_CAUSE_OWNERS[cause],
    ...fields,
    limitations: fields.limitations ?? [],
    alsoCause: fields.alsoCause ?? null,
  };
}

function parseSentence(parse: string): string {
  switch (parse) {
    case "json-unexpected-token":
      return "The reply was not JSON where JSON was required: its text did not start or continue as JSON, as when prose or reasoning text precedes the JSON.";
    case "json-unexpected-end":
      return "The reply ended before its JSON closed.";
    default:
      return `The reply could not be read as strict JSON (${parse}).`;
  }
}

function rejectionClause(row: RunIndexRowV1): string {
  return row.rejectionCode === null ? "" : `; rejected by ${row.rejectionCode}${locationOf(row)}`;
}

function locationOf(row: RunIndexRowV1): string {
  return row.rejectionLocation === null ? "" : ` at ${row.rejectionLocation}`;
}

function codeClause(row: RunIndexRowV1): Record<string, string> {
  return row.rejectionCode === null ? {} : { rejectionCode: row.rejectionCode };
}

function count(value: number | null): string {
  return value === null ? RUN_INDEX_UNAVAILABLE : String(value);
}
