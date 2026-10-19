// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Deterministic outcome router for `docsfab do`: maps a bounded request to a
 * fixed catalog workflow. Classification never grants tools, writes,
 * external-input access, or publication authority; delivery flags are parsed
 * outside this table.
 *
 * The generic terms "skill router", "skill pack", and "MCP" may be named as a
 * documentation subject. Asking the router to use one of those terms as a
 * classifier, or to install, enable, or discover one, stops. That rule matches
 * only those literal terms, not any tool an operator names.
 *
 * Recorded decision (orchestrator, delegated authority):
 *
 * > The delegated-selection guard in `outcome-router.ts` is a phrase-based
 * > PRE-FILTER, not a complete classifier. It is name-agnostic: no tool name in
 * > code or config. It refuses (`risk-expanding`) exactly these forms, where X
 * > is one to six words, with an optional possessive using any apostrophe
 * > (', ’, ʼ, ＇ or `):
 * > 1. a delegating verb before X: use, using, ask, call, invoke, tell, get,
 * >    have, let, rely on, allow, make;
 * > 2. followed by a choice clause, either:
 * >    (a) "to [help] <choice verb>", where choice verbs are pick, choose,
 * >        select, decide, determine, identify, recommend, suggest, route,
 * >        figure out, work out; or
 * >    (b) "for [a|the|the right|a suitable] workflow|skill", or "for
 * >        picking|choosing|selecting".
 * > 3. Also covered: "using X, <choice verb> the workflow|skill", and "let/have
 * >    X decide|pick|choose [which] workflow|skill".
 * >
 * > Documentation-subject clauses stay selected when introduced by: how to,
 * > explain, describe, document, show how, say that, and the like (listed in
 * > code).
 * >
 * > Phrasings outside these forms are ACCEPTED RESIDUE, not defects: a missed
 * > phrasing means DocsFab ignores the delegation clause and runs its normal
 * > workflow, which still ends in a Draft MR. The narrowed non-selection forms
 * > from the first decision ("install X", "enable X", "ask X to update ...",
 * > "using X, update ...") stay selected.
 *
 * How the code reads that grammar (see DELEGATED_SELECTION):
 * - Every choice clause must name a workflow or skill within a short window
 *   ("to pick the workflow", "for picking a skill"), or be "route this|the|my
 *   request". "use grep to find the commands" and "use the template to choose
 *   headings" therefore stay selected.
 * - "make" takes the bare form with let and have ("make X pick the workflow"),
 *   and every form uses the full choice-verb list.
 * - "to help [me|us|you] <choice verb>" and a comma before "to" ("use X, to
 *   pick the workflow") are the same clause.
 * - Also refused, beyond the listed forms: the choice verbs find and
 *   classify, "ask X which|what ... workflow|skill", and "X ... route
 *   this|the|my request". These refuse more than the listed forms; they never
 *   select more.
 * - Documentation-subject cues are listed in DOCUMENTATION_SUBJECT_CUE. After
 *   "how to", "<show|explain|describe|document|to|on|about|of> how", "say[s]
 *   that", or "to say", up to three subject words may sit before the
 *   delegating verb ("show how teams use X to pick a workflow"); a conjunction
 *   or clause punctuation ends the cue. Any other "how" or "say", and
 *   "documented" or "said", is not a cue.
 *
 * After this table returns needs-input, live `do` may ask a tool-free admission
 * model to name one catalog workflow, which cannot mint grants. `--patch-only`
 * and `--draft-mr` narrow that offer to the workflows that deliver them, and a
 * review the table picked runs as `update-documentation` under either flag
 * (`planDoRoute` in `commands/do.ts`). `--route-only` stays table-only: on an
 * eligible miss it names the offer instead of asking.
 */

import type { WorkflowName } from "../workflow-contracts/contracts.js";
import {
  getWorkflow,
  isRunnableWorkflowName,
  isWorkflowName,
  RUNNABLE_WORKFLOW_NAMES,
} from "../workflow-registry/catalog.js";
import {
  formatSectionHeader,
  indentCliBody,
  type CliFormatOptions,
} from "../operator/cli-format.js";
import { removeClearPublicationProhibitions } from "./publication-prohibition.js";

export const OUTCOME_ROUTE_SCHEMA_VERSION = 1 as const;

/** Frozen golden request used by acceptance + CLI smoke. */
export const GOLDEN_OUTCOME_REQUEST = "Review the documentation";

export interface OutcomeAuthorityGrants {
  readonly tools: false;
  readonly writes: false;
  readonly externalInputAccess: false;
  readonly publicationAuthority: false;
}

export const NO_OUTCOME_AUTHORITY_GRANTS: OutcomeAuthorityGrants = Object.freeze({
  tools: false,
  writes: false,
  externalInputAccess: false,
  publicationAuthority: false,
});

export type OutcomeRouteStopReason = "ambiguous" | "unsupported" | "risk-expanding";

export type OutcomeClassifiedBy = "fixed-table" | "admission-model";

export interface OutcomeRouteSelected {
  readonly status: "selected";
  readonly workflow: WorkflowName;
  readonly rationale: string;
  readonly readWriteScope: "read-only";
  readonly expectedValidations: readonly string[];
  readonly authorizationBoundary: string;
  readonly classifiedBy: OutcomeClassifiedBy;
  readonly grants: OutcomeAuthorityGrants;
}

export interface OutcomeRouteNeedsInput {
  readonly status: "needs-input";
  readonly reason: OutcomeRouteStopReason;
  readonly message: string;
  readonly choices: readonly string[];
  readonly nextAction: string;
  readonly grants: OutcomeAuthorityGrants;
}

export type OutcomeRouteDecision = OutcomeRouteSelected | OutcomeRouteNeedsInput;

/**
 * A `--route-only` preview of an eligible table miss: the run asks the
 * admission model to name one of these workflows, and stops if it names none.
 */
export interface OutcomeRouteAdmissionV1 {
  readonly decidedBy: "admission-model";
  readonly workflows: readonly string[];
}

export interface OutcomeRouteEnvelopeV1 {
  readonly schemaVersion: typeof OUTCOME_ROUTE_SCHEMA_VERSION;
  readonly kind: "docsfab-outcome-route";
  readonly request: string;
  readonly decision: OutcomeRouteDecision;
  /** Present only on a `--route-only` preview that leaves the choice to the admission model. */
  readonly admission?: OutcomeRouteAdmissionV1;
}

interface FixedOutcomeRoute {
  readonly workflow: WorkflowName;
  readonly match: (normalized: string) => boolean;
  readonly rationale: string;
  readonly expectedValidations: readonly string[];
}

const AUTHORIZATION_BOUNDARY =
  "Classification never grants tools, writes, external-input access, or publication " +
  "authority. After classification, create/update/restructure default to write and " +
  "one draft MR; `--patch-only` and `--dry-run` opt out. `--comment-mr` posts one " +
  "review summary on an explicit existing MR/head. The sentence does not mint those " +
  "flags. Existing gates stay with the runner, profile approval, and explicit " +
  "publish/roadmap commands.";

const PUBLICATION_RISK_EXPANDING =
  /\b(?:publish(?:ing)?|publication|draft[\s-]?mr|merge[\s-]?request|open\s+an?\s+mr)\b/u;

/** Any apostrophe an operator's keyboard or editor produces: ', ’, ʼ, ＇, or `. */
const APOSTROPHE = "['\u2019\u02BC\uFF07`]";
/** One word of a free-text tool name; the optional suffix is the possessive "<tool>'s". */
const TOOL_WORD = String.raw`[\w.@/-]+(?:${APOSTROPHE}s)?`;
/** A tool name of one to six words: "acme", "the house router", "acme v2 from the host". */
const TOOL_NAME = String.raw`${TOOL_WORD}(?:\s+${TOOL_WORD}){0,5}?`;
/** Verbs that hand something to the named tool. */
const DELEGATING_VERB = String.raw`(?:use|using|ask|call|invoke|tell|get|have|let|rely\s+on|allow|make)`;
/** Verbs whose object is the choice being handed over. */
const CHOICE_VERB = String.raw`(?:pick|choose|select|decide|determine|identify|recommend|suggest|route|figure\s+out|work\s+out|find|classify)`;
const WORKFLOW_OR_SKILL = String.raw`(?:workflows?|skills?)\b`;
/** The choice being handed over: a workflow or skill, or the routing of the request. */
const CHOICE_CLAUSE = String.raw`(?:${CHOICE_VERB}\b.{0,40}?\b${WORKFLOW_OR_SKILL}|route\s+(?:this|the|my)\s+requests?\b)`;
/** "for a skill", "for the right workflow", "for picking the workflow". */
const FOR_CHOICE = String.raw`for\s+(?:(?:(?:the\s+right|a\s+suitable|an?|the)\s+)?${WORKFLOW_OR_SKILL}|(?:picking|choosing|selecting)\b.{0,40}?\b${WORKFLOW_OR_SKILL})`;
/** One subject word inside a cue; a conjunction or clause punctuation ends the cue. */
const SUBJECT_WORD = String.raw`(?!(?:and|then|but|or|also|please)\b)[^\s,;:.!?()–—-]+`;
/** "how to", or "how" after show, explain, describe, document, to, on, about, or of. */
const HOW_CUE = String.raw`(?:how\s+to|(?:show(?:s|ed|ing)?|explain(?:s|ed|ing)?|describ(?:e|es|ed|ing)|document(?:s|ing)?|to|on|about|of)\s+how)`;
/** "say that", "says that", "saying that", or "to say". */
const SAY_CUE = String.raw`(?:say(?:s|ing)?\s+that|to\s+say)`;
/**
 * Cues that make the delegation the documentation subject. HOW_CUE and SAY_CUE
 * admit up to three subject words before the delegating verb; explain,
 * describe, and document (not "documented") must sit right before it.
 */
const DOCUMENTATION_SUBJECT_CUE = String.raw`(?:(?:${HOW_CUE}|${SAY_CUE})\s+(?:${SUBJECT_WORD}\s+){0,3}|(?:explain(?:s|ed|ing)?|describ(?:e|es|ed|ing)|document(?:s|ing)?)\s+)`;
const NOT_DOCUMENTATION_SUBJECT = String.raw`(?<!\b${DOCUMENTATION_SUBJECT_CUE})`;

/**
 * Handles exactly the recorded forms, documented in the module comment:
 * "<delegating verb> <tool>[,] to [help] <choice>", "<delegating verb> <tool>
 * for <workflow|skill choice>", "using <tool>, <choice>", "let|have|make <tool>
 * <choice>", and the retained "ask <tool> which|what ... workflow|skill", none
 * introduced by a documentation-subject cue. Its adjacent conditions, a
 * delegating verb with any other object ("ask <tool> to update the README",
 * "using <tool>, update the install guide") and a tool named without a
 * delegating verb ("install <tool>"), do not match.
 */
const DELEGATED_SELECTION = new RegExp(
  String.raw`\b${NOT_DOCUMENTATION_SUBJECT}(?:` +
    String.raw`${DELEGATING_VERB}\s+${TOOL_NAME},?\s+to\s+(?:help(?:\s+(?:me|us|you))?\s+)?${CHOICE_CLAUSE}` +
    String.raw`|${DELEGATING_VERB}\s+${TOOL_NAME}\s+${FOR_CHOICE}` +
    String.raw`|using\s+${TOOL_NAME},\s*${CHOICE_CLAUSE}` +
    String.raw`|(?:let|have|make)\s+${TOOL_NAME}\s+${CHOICE_CLAUSE}` +
    String.raw`|ask\s+${TOOL_NAME}\s+(?:which|what)\b.{0,40}?\b${WORKFLOW_OR_SKILL}` +
    ")",
  "u",
);

const RISK_EXPANDING = [
  /\b(?:grant|mint|issue)\b.{0,40}\b(?:write|authority|authorization|credential)\b/u,
  /\b(?:allow[\s-]?write|--allow-write)\b/u,
  /\b(?:tracker\s+write|roadmap[\s-]?issues?\s+apply|mutate\s+tracker)\b/u,
  /\b(?:install|enable|discover)\b.{0,40}\b(?:skill[\s-]?pack|mcp|skill[\s-]?router)\b/u,
  /\b(?:use|using|ask|call|invoke)\s+(?:skill[\s-]?router|mcp)\b/u,
  /\b(?:skill[\s-]?router|mcp)\s+to\s+(?:pick|select|choose|route|classify|install|enable)\b/u,
  /\bdynamic\s+skill\s+search\b/u,
  /\bmodel[\s-]selected\s+installation\b/u,
  DELEGATED_SELECTION,
] as const;

const UNSUPPORTED = [
  /\b(?:skill[\s-]?pack|optional\s+pack)\b/u,
  /\b(?:search\s+skills?|install\s+skills?)\b/u,
  /\b(?:chatgpt|claude\.ai|browser\s+agent)\b/u,
] as const;

/**
 * Documentation artifact nouns for ordinary English. A named `.md` token is
 * not required. `(?<!by\s)reference` keeps "pass by reference" out.
 */
const DOCUMENTATION_ARTIFACT = String.raw`(?:documentation|docs?|pages?|guide|book|readme|tutorial|overview|manual|(?<!by\s)references?)`;

/** Verb-to-artifact window. Covers "create a reader-facing health endpoint page". */
const DOCUMENTATION_JOB_WINDOW = 40;

function documentationJob(verbs: string): RegExp {
  return new RegExp(
    String.raw`\b(?:${verbs})\b.{0,${String(DOCUMENTATION_JOB_WINDOW)}}\b${DOCUMENTATION_ARTIFACT}\b`,
    "u",
  );
}

const CREATE_DOCUMENTATION_JOB = documentationJob("create|draft|write|add");
const UPDATE_DOCUMENTATION_JOB = documentationJob("update");
const REVIEW_DOCUMENTATION_JOB = documentationJob("evaluate|evaluation|review|audit");
const RESTRUCTURE_DOCUMENTATION_JOB = documentationJob("restructure|reorganize|split|merge");

/**
 * A request to check documentation for conformance to its templates: the
 * documentation must "follow", "conform to", "comply with", or be checked
 * "against" our, its, or the templates, or the request names "template
 * conformance". A mention of templates as a subject ("the templates guide")
 * is not enough. Accuracy, technical, and review requests stay on review,
 * and a request that also asks for a change falls through to the write routes.
 */
function isTemplateAuditRequest(normalized: string): boolean {
  return (
    /\b(?:follows?|following|conforms?\s+to|conforming\s+to|compl(?:y|ies|iant)\s+with|against)\s+(?:our|its|their|the|my)\s+(?:[\w-]+\s+)?templates?\b|\btemplate\s+(?:conformance|compliance)\b/u.test(
      normalized,
    ) &&
    new RegExp(String.raw`\b${DOCUMENTATION_ARTIFACT}\b`, "u").test(normalized) &&
    !/\b(?:review\w*|accura\w*|technical\w*|correct\w*|create|draft|write|add|document(?:s|ed|ing)?|explain\w*|update|restructure|reorganize|rewrite|fix|apply|scaffold)\b/u.test(
      normalized,
    ) &&
    !/\bhelm\s+chart\b/u.test(normalized)
  );
}

const FIXED_ROUTES: readonly FixedOutcomeRoute[] = Object.freeze([
  {
    workflow: "audit-documentation",
    match: isTemplateAuditRequest,
    rationale: "Request asks whether existing documentation pages follow their templates.",
    expectedValidations: Object.freeze([
      "page-to-template mapping from frontmatter or path conventions",
      "structural template checks on every mapped page",
      "no model call",
      "no write or publication authority",
    ]),
  },
  {
    workflow: "review-documentation",
    match: (normalized) =>
      !isTemplateAuditRequest(normalized) &&
      (REVIEW_DOCUMENTATION_JOB.test(normalized) ||
        /\b(?:documentation\s+audit|audit\s+the\s+(?:documentation|docs?))\b/u.test(normalized) ||
        /\bdocument[\s-]?quality\b/u.test(normalized) ||
        /\bcomprehensive\b.{0,20}\b(?:documentation|docs?)\b.{0,20}\b(?:evaluation|review)\b/u.test(
          normalized,
        ) ||
        /\b(?:documentation\s+impact|impact\s+(?:for|of|on)\s+(?:this\s+)?(?:change|diff|mr|pr)|review\s+documentation\s+impact)\b/u.test(
          normalized,
        )),
    rationale: "Request asks for the comprehensive read-only documentation review stack.",
    expectedValidations: Object.freeze([
      "audit-documentation catalog skill",
      "lint-documentation catalog skill",
      "verify-technical-accuracy catalog skill",
      "review-documentation catalog skill",
      "test-audience-understanding catalog skill",
      "evaluate-document-quality catalog skill",
      "no write or publication authority",
    ]),
  },
  {
    workflow: "create-documentation",
    match: (normalized) =>
      CREATE_DOCUMENTATION_JOB.test(normalized) &&
      !/\b(?:restructure|reorganize|update)\b/u.test(normalized),
    rationale: "Request asks for a new documentation page or coherent documentation set.",
    expectedValidations: Object.freeze([
      "source-grounded planning",
      "write authorization",
      "lint, technical verification, peer review, and quality evaluation",
    ]),
  },
  {
    workflow: "update-documentation",
    match: (normalized) =>
      UPDATE_DOCUMENTATION_JOB.test(normalized) &&
      !/\b(?:restructure|reorganize)\b/u.test(normalized) &&
      !/\bimpact\b/u.test(normalized),
    rationale: "Request asks to update existing documentation for a product or API change.",
    expectedValidations: Object.freeze([
      "change-scoped planning",
      "write authorization",
      "preserve unrelated pages",
      "lint, technical verification, peer review, and quality evaluation",
    ]),
  },
  {
    workflow: "restructure-documentation",
    match: (normalized) => RESTRUCTURE_DOCUMENTATION_JOB.test(normalized),
    rationale: "Request asks for a bounded documentation restructuring.",
    expectedValidations: Object.freeze([
      "documentation-set inventory and content map",
      "write authorization",
      "route, navigation, technical, audience, and quality evaluation",
    ]),
  },
]);

const SAY_THE_WORK =
  "Describe the task, target, and desired outcome in one sentence for `docsfab do`.";

const SAY_THE_WORK_LIVE = `${SAY_THE_WORK} Use \`docsfab live-agent\` when flexible skill use is appropriate.`;

const FLEXIBLE_SKILL_NEXT_ACTION =
  "This one-shot command supports fixed documentation workflows. Use `docsfab live-agent` when flexible skill use is appropriate.";

const PACK_OR_CLASSIFIER_LANGUAGE =
  /\b(?:skill[\s-]?pack|search\s+skills?|install\s+skills?|chatgpt|claude\.ai|browser\s+agent|(?:use|using|ask|call|invoke)\s+(?:skill[\s-]?router|mcp)|(?:skill[\s-]?router|mcp)\s+to\s+(?:pick|select|choose|route|classify|install|enable))\b/iu;

function quoteSuggestedCliString(value: string): string {
  return JSON.stringify(value);
}

function shouldPreserveOriginalAsInstruction(
  reason: OutcomeRouteStopReason,
  originalRequest: string,
): boolean {
  if (reason === "risk-expanding") return false;
  const trimmed = originalRequest.trim();
  if (trimmed.length < 12) return false;
  return !PACK_OR_CLASSIFIER_LANGUAGE.test(trimmed);
}

function writeJobInstructionPlaceholder(workflow: string): string | undefined {
  if (workflow === "bootstrap") return "Prepare …";
  if (workflow === "create-documentation") return "Create …";
  if (workflow === "update-documentation") return "Update …";
  if (workflow === "restructure-documentation") return "Restructure …";
  return undefined;
}

/**
 * `docsfab do` is one natural-language sentence. Needs-input choices describe
 * the task, target, and outcome rather than requiring catalog knowledge.
 * Authority-expanding requests retain explicit `run` recovery commands.
 */
function clarifyingOutcomeChoices(
  originalRequest: string,
  reason: OutcomeRouteStopReason,
): readonly string[] {
  if (reason !== "risk-expanding") {
    return Object.freeze([
      "Review the documentation for this repository or a specific target.",
      "Create a documentation page for a named audience and desired outcome.",
      "Update the documentation for a specific product or API change.",
      "Restructure the documentation navigation or page hierarchy for a specific target.",
    ]);
  }
  const preserved = shouldPreserveOriginalAsInstruction(reason, originalRequest)
    ? originalRequest.trim().replace(/\s+/gu, " ")
    : undefined;
  return Object.freeze(
    RUNNABLE_WORKFLOW_NAMES.map((workflow) => {
      const instruction = preserved ?? writeJobInstructionPlaceholder(workflow);
      if (instruction === undefined) {
        return `docsfab run ${workflow}`;
      }
      return `docsfab run ${workflow} --instruction ${quoteSuggestedCliString(instruction)}`;
    }),
  );
}

/**
 * Live `docsfab do` may ask a tool-free model to name one catalog workflow when
 * the table cannot. Risk-expanding text, empty/short requests, and
 * classifier/install language never take that path.
 */
export function isAdmissionModelEligible(request: string, decision: OutcomeRouteDecision): boolean {
  if (decision.status !== "needs-input") return false;
  if (decision.reason === "risk-expanding") return false;
  const trimmed = request.trim();
  if (trimmed.length < 12) return false;
  if (PACK_OR_CLASSIFIER_LANGUAGE.test(trimmed)) return false;
  return true;
}

export function applyAdmissionModelSelection(
  request: string,
  tableDecision: OutcomeRouteDecision,
  workflow: string,
): OutcomeRouteDecision {
  if (!isAdmissionModelEligible(request, tableDecision)) return tableDecision;
  if (!isRunnableWorkflowName(workflow)) return tableDecision;
  return selectedRoute(
    workflow,
    "Admission model selected a fixed catalog workflow after the table could not classify.",
    undefined,
    "admission-model",
  );
}

/**
 * `do` under `--patch-only` or `--draft-mr` when the table picked a review:
 * review-documentation cannot take either flag, so the request runs as
 * update-documentation, which reviews what it changes and can end in a patch
 * or a verified no-change. Deterministic, like the table: no admission model
 * call.
 */
export function reviewUnderWriteDeliveryRoute(): OutcomeRouteSelected {
  return selectedRoute(
    "update-documentation",
    "The table picked a review, which cannot take --patch-only or --draft-mr, so the request runs as update-documentation, which reviews what it changes and can end in a patch or a verified no-change.",
  );
}

export function normalizeOutcomeRequest(request: string): string {
  return request.trim().replace(/\s+/gu, " ").toLowerCase();
}

export function routeOutcomeRequest(request: string): OutcomeRouteDecision {
  const trimmed = request.trim();
  if (!trimmed) {
    return needsInput("ambiguous", "Outcome request is empty.", SAY_THE_WORK, trimmed);
  }
  const normalized = normalizeOutcomeRequest(trimmed);
  if (normalized.length < 12) {
    return needsInput(
      "ambiguous",
      "Outcome request is too short to classify safely.",
      SAY_THE_WORK,
      trimmed,
    );
  }

  // A clause that forbids publication is not a request for it.
  const publicationRiskText = removeClearPublicationProhibitions(trimmed) ?? normalized;
  if (PUBLICATION_RISK_EXPANDING.test(publicationRiskText)) {
    return needsInput(
      "risk-expanding",
      "Request would expand tools, writes, external-input access, publication, or installation authority.",
      "Do not ask the router to grant authority. Describe the task, target, and desired outcome, or use an explicit `docsfab run` command.",
      trimmed,
    );
  }

  for (const pattern of RISK_EXPANDING) {
    if (pattern.test(normalized)) {
      return needsInput(
        "risk-expanding",
        "Request would expand tools, writes, external-input access, publication, or installation authority.",
        "Do not ask the router to grant authority. Describe the task, target, and desired outcome, or use an explicit `docsfab run` command.",
        trimmed,
      );
    }
  }

  for (const pattern of UNSUPPORTED) {
    if (pattern.test(normalized)) {
      return needsInput(
        "unsupported",
        "Request depends on a skill router, MCP, dynamic skill search, or pack installation, which the outcome router does not perform.",
        FLEXIBLE_SKILL_NEXT_ACTION,
        trimmed,
      );
    }
  }

  if (/\bpolish\b/u.test(normalized) && !/\bfoundation\b/u.test(normalized)) {
    return needsInput(
      "unsupported",
      "Polish is not a public catalog workflow.",
      'Polish is not a catalog workflow. Say the update in one sentence for `docsfab do`, or run `docsfab run update-documentation --instruction "…"`.',
      trimmed,
    );
  }

  // Naming a catalog workflow explicitly is allowed for advanced operators, but
  // still cannot expand authority.
  if (isWorkflowName(normalized)) {
    if (!isRunnableWorkflowName(normalized)) {
      return needsInput(
        "unsupported",
        `Workflow "${normalized}" is not bound to a catalog skill.`,
        "Choose a workflow from `docsfab list`.",
        trimmed,
      );
    }
    return selectedRoute(normalized, `Request named the fixed workflow "${normalized}".`);
  }

  const matches = FIXED_ROUTES.filter((route) => route.match(normalized));
  if (matches.length === 1) {
    const route = matches[0]!;
    return selectedRoute(route.workflow, route.rationale, route.expectedValidations);
  }
  if (matches.length > 1) {
    return needsInput(
      "ambiguous",
      "Request matches more than one fixed DocsFab workflow.",
      SAY_THE_WORK_LIVE,
      trimmed,
    );
  }

  if (
    /^(?:help|improve(?:\s+my)?\s+docs?|fix(?:\s+the)?\s+docs?|make\s+docs?\s+better|do\s+something)\.?$/u.test(
      normalized,
    ) ||
    /\b(?:improve|fix|update|rewrite)\b.{0,20}\bdocs?\b/u.test(normalized)
  ) {
    return needsInput(
      "ambiguous",
      "Request is too open-ended to select a single fixed workflow.",
      SAY_THE_WORK_LIVE,
      trimmed,
    );
  }

  return needsInput(
    "unsupported",
    "No fixed DocsFab workflow matches this outcome request.",
    FLEXIBLE_SKILL_NEXT_ACTION,
    trimmed,
  );
}

export function buildOutcomeRouteEnvelope(
  request: string,
  decision: OutcomeRouteDecision = routeOutcomeRequest(request),
  admissionWorkflows?: readonly string[],
): OutcomeRouteEnvelopeV1 {
  return Object.freeze({
    schemaVersion: OUTCOME_ROUTE_SCHEMA_VERSION,
    kind: "docsfab-outcome-route",
    request: request.trim(),
    decision,
    ...(admissionWorkflows === undefined
      ? {}
      : {
          admission: Object.freeze({
            decidedBy: "admission-model" as const,
            workflows: Object.freeze([...admissionWorkflows]),
          }),
        }),
  });
}

/** The `--route-only` line that names the admission offer of an eligible table miss. */
export function formatOutcomeRouteAdmission(workflows: readonly string[]): string {
  return `Admission: the run asks the admission model to name one of ${workflows.join(", ")}; if it names none, the run stops here.`;
}

export interface FormatOutcomeRouteOptions {
  /** Adds the full authorization-boundary detail below the compact ROUTE block. */
  readonly verbose?: boolean;
  /** TTY header weight for the ROUTE section. Compact body is always words. */
  readonly format?: CliFormatOptions;
}

/**
 * Catalog write-ness for the compact ROUTE line. Distinct from
 * `decision.readWriteScope`, which stays `"read-only"` because classification
 * never grants writes.
 */
export function catalogRouteReadWriteScope(workflow: WorkflowName): "read-only" | "write" {
  return getWorkflow(workflow).steps.some((step) => step.mode === "write") ? "write" : "read-only";
}

/** Compact ROUTE block: workflow, then catalog write-ness and classifier grants. */
export function formatOutcomeRouteLines(
  decision: OutcomeRouteSelected,
  options: CliFormatOptions = {},
): string[] {
  const scope = catalogRouteReadWriteScope(decision.workflow);
  const lines = [
    formatSectionHeader("ROUTE", options),
    indentCliBody(decision.workflow),
    indentCliBody(`catalog ${scope}`, 2),
    indentCliBody("classifier grants none", 2),
  ];
  if (decision.classifiedBy === "admission-model") {
    lines.push(indentCliBody("admitted by model", 2));
  }
  return lines;
}

export function formatOutcomeRouteDecision(
  decision: OutcomeRouteDecision,
  options: FormatOutcomeRouteOptions = {},
): string[] {
  if (decision.status === "needs-input") {
    return [
      `Outcome route: needs-input (${decision.reason})`,
      decision.message,
      "Choices:",
      ...decision.choices.map((choice) => `  - ${choice}`),
      `Next action: ${decision.nextAction}`,
      "Authority: router grants none (tools/writes/external-input/publication remain closed).",
    ];
  }
  const routeLines = formatOutcomeRouteLines(decision, options.format ?? {});
  if (!options.verbose) {
    return routeLines;
  }
  const workflow = getWorkflow(decision.workflow);
  return [
    ...routeLines,
    indentCliBody(`Title: ${workflow.title}`),
    indentCliBody(`Rationale: ${decision.rationale}`),
    indentCliBody(`Expected validations: ${decision.expectedValidations.join("; ")}`),
    indentCliBody(`Authorization boundary: ${decision.authorizationBoundary}`),
    indentCliBody(
      "Authority grants: tools=false writes=false externalInputAccess=false publicationAuthority=false",
    ),
    indentCliBody(`Classified by: ${decision.classifiedBy}`),
  ];
}

function selectedRoute(
  workflow: WorkflowName,
  rationale: string,
  expectedValidations?: readonly string[],
  classifiedBy: OutcomeClassifiedBy = "fixed-table",
): OutcomeRouteSelected {
  const route = FIXED_ROUTES.find((item) => item.workflow === workflow);
  return Object.freeze({
    status: "selected",
    workflow,
    rationale,
    readWriteScope: "read-only",
    expectedValidations: Object.freeze([
      ...(expectedValidations ??
        route?.expectedValidations ?? ["fixed catalog workflow gates only"]),
    ]),
    authorizationBoundary: AUTHORIZATION_BOUNDARY,
    classifiedBy,
    grants: NO_OUTCOME_AUTHORITY_GRANTS,
  });
}

function needsInput(
  reason: OutcomeRouteStopReason,
  message: string,
  nextAction: string,
  originalRequest: string,
): OutcomeRouteNeedsInput {
  return Object.freeze({
    status: "needs-input",
    reason,
    message,
    choices: clarifyingOutcomeChoices(originalRequest, reason),
    nextAction,
    grants: NO_OUTCOME_AUTHORITY_GRANTS,
  });
}
