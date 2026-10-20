// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Content-free classification of a stop raised before a workflow RunRecord
 * exists: first-pass knowledge support and proposal-scope admission. The CLI
 * envelope and the live-agent terminal share this vocabulary so one stop has
 * one wording.
 *
 * Nothing here carries model text, instruction quotes, target paths, or
 * credential values. Every rendered field is a fixed sentence or a value that
 * passed one of the closed validators below.
 */
import {
  failureClassification,
  type FailureClass,
  type FailureClassificationV1,
} from "./failure-class.js";
import { isModelCorrectableFirstPassRule } from "./first-pass-rejection-retryability.js";
import { DEFAULT_NEXT_ACTIONS, situationRowForId } from "./situation-catalog.js";

export const FIRST_PASS_FAILURE_PHASES: ReadonlySet<string> = new Set([
  "request",
  "decomposition",
  "completeness",
  "assessment",
  "identity",
  "evidence-acquisition",
]);

/** Stop-class handling kind; no `resume`, since there is no RunRecord to resume. */
export type PreRecordHandlingKind = "supply" | "recover" | "correct" | "redirect";

/**
 * Who a `correct` stop belongs to. A model-output rejection is a first-pass
 * policy on the model's answer; a producer defect is DocsFab's own binding.
 */
type CorrectSource = "model-output" | "producer";

interface RuleClass {
  readonly failureClass: FailureClass;
  readonly kind: PreRecordHandlingKind;
  readonly meaning: string;
  readonly source?: CorrectSource;
  /** Rule-specific NEXT when the kind's default would name the wrong actor. */
  readonly next?: string;
}

const PRODUCER_IDENTITY: RuleClass = {
  failureClass: "contract-shape",
  kind: "correct",
  source: "producer",
  meaning:
    "DocsFab could not bind the model-call identity evidence to the prompt and answer it observed.",
};
const ASSESSMENT_BINDING: RuleClass = {
  failureClass: "contract-shape",
  kind: "correct",
  source: "producer",
  meaning: "DocsFab could not bind the assessment prompt or the evidence provenance it produced.",
};
const MODEL_ACCESS: RuleClass = {
  failureClass: "infrastructure",
  kind: "recover",
  meaning: "The governed model could not be reached, was not configured, or stopped abnormally.",
};
const LIMIT: RuleClass = {
  failureClass: "bound",
  kind: "redirect",
  meaning: "First-pass support reached one of its configured bounds before it finished.",
};

/**
 * Every rule a first-pass stop may name, with its handling kind and fixed
 * content-free meaning. A rule outside this record falls back to content-free
 * text. A test scans the untyped knowledge raisers against this record.
 */
const FIRST_PASS_RULE_CLASSES = {
  "assessment-invalid": {
    failureClass: "model-content",
    kind: "correct",
    meaning: "The model's evidence assessment failed first-pass validation.",
  },
  "assessment-binding-prompt-shape": ASSESSMENT_BINDING,
  "assessment-binding-provenance": ASSESSMENT_BINDING,
  // The model built these answers, so they are model output, not a DocsFab
  // binding defect.
  "assessment-binding-response-json": {
    failureClass: "contract-shape",
    kind: "correct",
    meaning: "The model's assessment answer is not valid JSON.",
  },
  "assessment-binding-response-rows": {
    failureClass: "contract-shape",
    kind: "correct",
    meaning: "The model's assessment answer has no assessments array.",
  },
  "assessment-binding-response-shape": {
    failureClass: "contract-shape",
    kind: "correct",
    meaning: "The model's assessment answer is not a JSON object.",
  },
  "assessment-binding-source-spans": ASSESSMENT_BINDING,
  "authority-expansion": {
    failureClass: "model-content",
    kind: "correct",
    meaning:
      "A model-proposed obligation would widen permission or publication authority beyond the request.",
  },
  "bound-source-unavailable": {
    failureClass: "operator-input",
    kind: "supply",
    meaning: "A selected source is not a readable tracked file at the selected revision.",
  },
  "budget-exhausted": LIMIT,
  "closed-schema": {
    failureClass: "contract-shape",
    kind: "correct",
    meaning: "The model's answer has missing or unexpected fields.",
  },
  "completion-consistency": {
    failureClass: "model-content",
    kind: "correct",
    meaning: "The model's completeness flag contradicts its list of omissions.",
  },
  "credential-material": {
    failureClass: "operator-input",
    kind: "supply",
    meaning:
      "One of DocsFab's own configured credentials, such as the model key or an SCM token, was found, so DocsFab stopped before sending it anywhere.",
  },
  "decomposition-omission": {
    failureClass: "model-content",
    kind: "correct",
    meaning: "The model's assessment omitted a mandatory obligation.",
  },
  "detail-shape": {
    failureClass: "contract-shape",
    kind: "correct",
    meaning: "A model assessment detail is not bounded text.",
  },
  "contradiction-sides": {
    failureClass: "contract-shape",
    kind: "correct",
    meaning:
      "A model assessment named the disagreeing sources of a contradiction in a shape first pass refuses.",
  },
  "evidence-frame-nonce-source": {
    failureClass: "infrastructure",
    kind: "correct",
    source: "producer",
    meaning:
      "DocsFab's random source could not mint an evidence frame nonce, so no repository evidence reached the model.",
  },
  "evidence-span-binding": {
    failureClass: "model-content",
    kind: "correct",
    meaning: "A model assessment cites evidence spans that were not provided or are repeated.",
  },
  "evidence-status-inference": {
    failureClass: "model-content",
    kind: "correct",
    meaning:
      "A model-proposed omission infers the state of evidence instead of naming a requirement.",
  },
  "explicit-quote-binding": {
    failureClass: "model-content",
    kind: "correct",
    meaning:
      "A model-proposed explicit obligation does not quote a contiguous passage of the request verbatim, or its condition differs from that quote.",
  },
  "identity-binding": PRODUCER_IDENTITY,
  "identity-shape": PRODUCER_IDENTITY,
  "inferred-origin-binding": {
    failureClass: "model-content",
    kind: "correct",
    meaning: "A model-proposed inferred obligation carries a request quote, which it must not.",
  },
  "insufficient-evidence": {
    failureClass: "planning-refusal",
    kind: "redirect",
    meaning: "No admissible repository evidence supports the request within first-pass bounds.",
  },
  "invalid-response": {
    failureClass: "contract-shape",
    kind: "correct",
    meaning: "The model's answer failed first-pass validation.",
  },
  "model-unavailable": MODEL_ACCESS,
  "model-connection-failed": MODEL_ACCESS,
  "model-cumulative-token-budget-exhausted": LIMIT,
  "model-deadline-exhausted": LIMIT,
  "model-input-budget-exhausted": LIMIT,
  "model-profile-unavailable": MODEL_ACCESS,
  "model-turn-budget-exhausted": LIMIT,
  // The 4,096 below copies the catalog default of firstPass.modelOutputTokensPerTurn,
  // the knowledge first pass's response bound; a test keeps them in step.
  "output-policy-limit": {
    failureClass: "bound",
    kind: "recover",
    meaning:
      "The first-pass output cap is below the request policy's minimum output tokens (`MODEL_API_MIN_OUTPUT_TOKENS`). That cap is the lower of DocsFab's first-pass response bound, `firstPass.modelOutputTokensPerTurn` (4,096 tokens by default), and the model profile's output-token limit. The request size does not change either value.",
    next: "Your host administrator can act. Narrowing the request does not clear this. Set `MODEL_API_MIN_OUTPUT_TOKENS` to `4096` or less, or raise `DOCSFAB_FIRST_PASS_MODEL_OUTPUT_TOKENS_PER_TURN` to that minimum or more. If the model profile's output-token limit is lower than that minimum, raise the limit or select a compatible profile with `docsfab setup --profile <id>`. Then retry the same request.",
  },
  "provider-call-failed": MODEL_ACCESS,
  "provider-stop-reason": MODEL_ACCESS,
  "obligation-binding": {
    failureClass: "model-content",
    kind: "correct",
    meaning: "A model assessment names an obligation that is unknown or repeated.",
  },
  "obligation-shape": {
    failureClass: "contract-shape",
    kind: "correct",
    meaning: "A model-proposed obligation has missing or invalid fields.",
  },
  "response-size": {
    failureClass: "contract-shape",
    kind: "correct",
    meaning: "The model's answer was empty or larger than the first-pass bound.",
  },
  "repository-read-budget-exhausted": LIMIT,
  // Finish reason `length` with incomplete JSON.
  "response-truncated": {
    failureClass: "bound",
    kind: "correct",
    meaning: "The model's answer reached the first-pass output bound before its JSON was complete.",
  },
  "repository-read-deadline-exhausted": LIMIT,
  "schema-v1": {
    failureClass: "contract-shape",
    kind: "correct",
    meaning: "The model's answer does not use the expected schema version or shape.",
  },
  status: {
    failureClass: "model-content",
    kind: "correct",
    meaning: "A model assessment uses an unsupported status.",
  },
  "strict-json": {
    failureClass: "contract-shape",
    kind: "correct",
    meaning: "The model's answer is not valid JSON.",
  },
  "target-binding": {
    failureClass: "model-content",
    kind: "correct",
    meaning: "A model-proposed obligation names a target outside the request's targets.",
  },
  "unsafe-target": {
    failureClass: "operator-input",
    kind: "supply",
    meaning: "The requested documentation target is unsafe or outside the authorized write roots.",
  },
} as const satisfies Readonly<Record<string, RuleClass>>;

export type FirstPassFailureRule = keyof typeof FIRST_PASS_RULE_CLASSES;

export const FIRST_PASS_FAILURE_RULES: ReadonlySet<string> = new Set(
  Object.keys(FIRST_PASS_RULE_CLASSES),
);

/** A first-pass rule's failure class, or `undefined` outside the rule set. */
export function firstPassRuleFailureClass(rule: string): FailureClass | undefined {
  return isFirstPassRule(rule) ? FIRST_PASS_RULE_CLASSES[rule].failureClass : undefined;
}

/** Model phases whose model-correctable rules get hinted correction rounds. */
const FIRST_PASS_CORRECTED_PHASES: ReadonlySet<string> = new Set([
  "decomposition",
  "completeness",
  "assessment",
]);

/** Whether the knowledge first pass re-asks the model before this stop. */
function hasCorrectionRounds(phase: string, rule: FirstPassFailureRule): boolean {
  return FIRST_PASS_CORRECTED_PHASES.has(phase) && isModelCorrectableFirstPassRule(rule);
}

export const FIRST_PASS_FAILURE_LOCATION =
  /^[$](?:instruction|repository|prompt\.mandatoryObligations|model\.(?:connection|deadline|inputBudget|outputBudget|profile|requestPolicy|turnBudget)|response(?:\.(?:identity|additionalObligations|omissions|assessments|complete)(?:\[\d+\])?(?:\.(?:condition|instructionQuote|targetPaths|obligationId|status|evidenceSpanIds|detail|providerId|modelId|profileSha256|compositionSha256|requestPolicySha256|systemPromptSha256|promptSha256|procedureSha256|responseSha256|turnEvidenceSha256))?)?)$/u;

/** Proposal-scope admission codes; the situation catalog owns their action sentence. */
export const PROPOSAL_SCOPE_FAILURE_CODES = [
  "proposal-scope-input-invalid",
  "proposal-scope-unsafe-target",
  "proposal-scope-ambiguous-targets",
  "proposal-scope-duplicate-targets",
  "proposal-scope-conflicting-targets",
  "proposal-scope-binding-mismatch",
  "proposal-scope-excludes-project-config",
  "proposal-scope-non-actionable-targets",
] as const;
export type ProposalScopeFailureCode = (typeof PROPOSAL_SCOPE_FAILURE_CODES)[number];

const PROPOSAL_SCOPE_KINDS: Readonly<Record<ProposalScopeFailureCode, PreRecordHandlingKind>> = {
  "proposal-scope-input-invalid": "correct",
  "proposal-scope-unsafe-target": "supply",
  "proposal-scope-ambiguous-targets": "supply",
  "proposal-scope-duplicate-targets": "supply",
  "proposal-scope-conflicting-targets": "supply",
  "proposal-scope-binding-mismatch": "correct",
  "proposal-scope-excludes-project-config": "supply",
  "proposal-scope-non-actionable-targets": "supply",
};

/** One classified pre-record stop. Every field is fixed text or a validated token. */
export interface PreRecordFailureClassV1 {
  readonly code: string;
  readonly phase: string;
  readonly location?: string;
  readonly kind: PreRecordHandlingKind;
  readonly meaning: string;
  /** Names who can act, then the one action. Never a log that may not exist. */
  readonly next: string;
  readonly failure: FailureClassificationV1;
}

export interface FirstPassFailureIdentity {
  readonly phase: string;
  readonly rule: string;
  readonly location?: string;
}

function isFirstPassRule(rule: string): rule is FirstPassFailureRule {
  return Object.hasOwn(FIRST_PASS_RULE_CLASSES, rule);
}

/** Classify a first-pass rule, or `undefined` outside the closed vocabulary. */
export function classifyFirstPassFailure(
  identity: FirstPassFailureIdentity,
): PreRecordFailureClassV1 | undefined {
  const { phase, rule, location } = identity;
  if (!FIRST_PASS_FAILURE_PHASES.has(phase) || !isFirstPassRule(rule)) return undefined;
  if (location !== undefined && !FIRST_PASS_FAILURE_LOCATION.test(location)) return undefined;
  // Credential material in the model's own answer is a producer defect; in the
  // request or the repository evidence it is operator-held input.
  const cls: RuleClass =
    rule === "credential-material" && location?.startsWith("$response")
      ? {
          failureClass: "model-content",
          kind: "correct",
          meaning:
            "The model's answer contained one of DocsFab's own configured credentials, so DocsFab withheld it and stopped.",
        }
      : FIRST_PASS_RULE_CLASSES[rule];
  return Object.freeze({
    code: rule,
    phase,
    ...(location === undefined ? {} : { location }),
    kind: cls.kind,
    meaning: cls.meaning,
    next: cls.next ?? firstPassNext(cls, phase, rule, location),
    failure: failureClassification(cls.failureClass, "cli", rule),
  });
}

function where(location: string | undefined): string {
  return location === undefined ? "" : " at " + location;
}

function firstPassNext(
  cls: RuleClass,
  phase: string,
  rule: FirstPassFailureRule,
  location: string | undefined,
): string {
  switch (cls.kind) {
    case "correct":
      if (cls.source === "producer") {
        return (
          "DocsFab maintainers can act; DocsFab's own first-pass evidence binding failed, not your input. " +
          "Report rule " +
          rule +
          where(location) +
          " to them."
        );
      }
      if (hasCorrectionRounds(phase, rule)) {
        // This stop comes after the first pass's hinted correction rounds; a
        // new request gets its own.
        return (
          "You or DocsFab maintainers can act. This is a first-pass policy stop on the model's answer, not missing input from you. " +
          "Before stopping, DocsFab re-asks the model with a hint that names the rule and location, up to `retry.maxRetries` times per request; this stop comes from the last answer. " +
          "Retrying the unchanged request starts a new first pass with its own correction rounds. If it stops on this rule again, select a different model profile with `docsfab setup --profile <id>`, or report rule " +
          rule +
          where(location) +
          " to DocsFab maintainers."
        );
      }
      // A policy stop on the model's answer, not a forecast: a nondeterministic
      // model can pass a retry by chance without the rejection being fixed.
      return (
        "You or DocsFab maintainers can act. This is a first-pass policy stop on the model's answer, not missing input from you. " +
        "You can select a different model profile with `docsfab setup --profile <id>`, or report rule " +
        rule +
        where(location) +
        " to DocsFab maintainers. A retry can pass by chance but does not fix the rejection, so do not rely on retrying the unchanged request."
      );
    case "recover":
      return "You or your host administrator can act. Check model readiness with `docsfab doctor --live`, then retry the same request.";
    case "redirect":
      return rule === "insufficient-evidence"
        ? "You can act. Narrow the request to what the repository documents, or bind a tracked source that supports it, then start a new request."
        : "You can act. Narrow the request (fewer targets or a smaller scope), then start a new request. `docsfab doctor --limits` shows the effective limits.";
    case "supply":
      if (rule === "bound-source-unavailable") {
        return "You can act. Check the selected source path, or commit the file, then start a new request.";
      }
      if (rule === "unsafe-target") {
        return "You can act. Name a relative documentation target under the authorized write roots (docs/ or fern/ by default), then start a new request.";
      }
      return location === "$repository"
        ? "You can act. Remove the configured credential from the selected repository sources, and rotate it if it was committed, then start a new request."
        : "You can act. Remove the configured credential from the request, then start a new request.";
  }
}

/** Classify a proposal-scope admission code, reusing the catalog's action sentence. */
export function classifyProposalScopeFailure(
  code: string,
  meaning: string,
): PreRecordFailureClassV1 | undefined {
  if (!(PROPOSAL_SCOPE_FAILURE_CODES as readonly string[]).includes(code)) return undefined;
  const kind = PROPOSAL_SCOPE_KINDS[code as ProposalScopeFailureCode];
  const action = DEFAULT_NEXT_ACTIONS[code];
  if (!action) return undefined;
  const who =
    kind === "supply"
      ? "You can act."
      : "DocsFab maintainers can act; DocsFab built this scope from your request.";
  const failureClass = situationRowForId(code)?.failureClass;
  if (!failureClass) return undefined;
  return Object.freeze({
    code,
    phase: "proposal-scope-admission",
    kind,
    meaning,
    next: who + " " + action,
    failure: failureClassification(failureClass, "cli", code),
  });
}

// Exact wire forms. The tool boundary keeps only an error message, so these are
// the one channel for the typed identity; anything decorated is not this stop.
const FIRST_PASS_STOP_MESSAGE =
  /^First-pass support stopped in ([a-z-]{1,32}) at ([$][A-Za-z0-9.[\]]{1,200}) under rule ([a-z0-9-]{1,64})\.$/u;
const FIRST_PASS_MODEL_CALL_MESSAGE =
  /^First-pass support stopped during ([a-z-]{1,32}) \(([a-z0-9-]{1,64})\)\.$/u;

/** Parse an exact first-pass stop message; `undefined` for any other text. */
export function firstPassFailureFromMessage(message: string): PreRecordFailureClassV1 | undefined {
  const located = FIRST_PASS_STOP_MESSAGE.exec(message);
  if (located) {
    return classifyFirstPassFailure({
      phase: located[1]!,
      location: located[2]!,
      rule: located[3]!,
    });
  }
  const unlocated = FIRST_PASS_MODEL_CALL_MESSAGE.exec(message);
  if (unlocated)
    return classifyFirstPassFailure({
      phase: unlocated[1]!,
      rule: unlocated[2]!,
    });
  return undefined;
}

/** One-line identity: the code plus where it fired. */
export function preRecordFailureIdentity(failure: PreRecordFailureClassV1): string {
  return failure.code + " in " + failure.phase + where(failure.location);
}

/** Terminal rendering for a stop before any RunRecord: identity, meaning, and NEXT. */
export function renderPreRecordFailure(failure: PreRecordFailureClassV1): string {
  return [
    "Stopped before the workflow created a run record: " +
      preRecordFailureIdentity(failure) +
      ". No workflow steps ran, so there is no run log to inspect.",
    "Meaning: " + failure.meaning,
    "Failure class: " + failure.failure.class + ".",
    "NEXT: " + failure.next,
  ].join("\n");
}
