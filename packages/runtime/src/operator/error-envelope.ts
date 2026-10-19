// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import {
  RepositoryWorkspaceMaterializationError,
  type RepositoryWorkspaceMaterializationFailureEvidence,
} from "../repository/workspace/contracts.js";
import { RepositoryAccessRefusalError } from "../repository/workspace/access-refusal.js";
import { runtimeEgressRootSet } from "../config/egress-roots.js";
import { redactCredentialMaterial } from "../security/credential-material.js";
import { egressText } from "../security/egress.js";
import { PublicRootsOperatorError } from "../security/public-roots.js";
import { sanitizeDisplayText as redactDisplayText } from "./display-sanitize.js";
import { doctorFallbackRemediationText } from "./remediation.js";
import {
  DEFAULT_DOCS_ANCHORS,
  DEFAULT_NEXT_ACTIONS,
  REMEDIATION_DOCS_ANCHORS,
} from "./situation-catalog.js";
import { lookupDocsAnchor, lookupNextAction } from "./situation-lookup.js";
import {
  classifyFirstPassFailure,
  FIRST_PASS_FAILURE_LOCATION,
  FIRST_PASS_FAILURE_PHASES,
  FIRST_PASS_FAILURE_RULES,
  firstPassRuleFailureClass,
  PROPOSAL_SCOPE_FAILURE_CODES,
} from "./pre-record-failure.js";
import {
  failureClassification,
  readFailureClassification,
  type FailureClassificationV1,
} from "./failure-class.js";
import { classifyThrownFailure, operatorCodeFailureClass } from "./failure-classification.js";
import { InferenceStepError } from "../execution/contracts.js";
import { QualityPackError } from "../quality-pack/error.js";

export {
  DEFAULT_DOCS_ANCHORS,
  DEFAULT_NEXT_ACTIONS,
  REMEDIATION_DOCS_ANCHORS,
} from "./situation-catalog.js";

/**
 * Public operator-facing failure shape. Contract layers keep stable machine
 * `code` values; message / nextAction / docsAnchor are derived at boundaries.
 */
export interface OperatorErrorEnvelope {
  readonly schemaVersion: 1;
  readonly kind: "docsfab-operator-error";
  readonly code: string;
  readonly message: string;
  readonly nextAction?: string;
  readonly docsAnchor?: string;
  /** Optional in schemaVersion 1 for older envelopes; this build always writes it. */
  readonly failure?: FailureClassificationV1;
  /** Content-free structured evidence from a recognized host failure type. */
  readonly details?: OperatorFailureDetails;
  /** Independent of draft applicability. */
  readonly originalRequestCompletion?: "complete" | "incomplete";
  readonly draftApplicability?:
    | "useful-partial"
    | "scaffold-only"
    | "no-useful-deliverable"
    | "cancellation"
    | "execution-failure";
  readonly documentationPartialLocator?: string;
}

export interface ProposalScopeFailureDetailsV1 {
  readonly schemaVersion: 1;
  readonly kind: "docsfab-proposal-scope-admission-failure";
  readonly phase: "proposal-scope-admission";
  readonly retryable: false;
  readonly noWorkPerformed: true;
  readonly instructionSha256: string;
  readonly repositoryRevision: string;
}

export interface FirstPassSupportFailureDetailsV1 {
  readonly schemaVersion: 1;
  readonly kind: "docsfab-first-pass-support-failure";
  readonly phase: string;
  readonly rule: string;
  readonly location: string;
  readonly retryable: false;
  readonly instructionSha256: string;
  readonly repositoryRevision: string;
  readonly modelCalls: {
    readonly started: number | null;
    readonly completed: number | null;
  };
  /** Hinted correction rounds the stopping phase spent; `null` when none were reported. */
  readonly corrections: number | null;
  readonly lastPromptSha256: string | null;
  readonly lastResponseSha256: string | null;
  readonly lastIdentitySha256: string | null;
  readonly evidenceSha256: string;
}

/**
 * Which mandatory obligations the first-pass evidence gate could not resolve.
 * Conditions are model- and instruction-derived prose, so they are scrubbed
 * like every other operator string and the list is bounded.
 */
export interface FirstPassEvidenceGapDetailsV1 {
  readonly schemaVersion: 1;
  readonly kind: "docsfab-first-pass-evidence-gap";
  readonly phase: "first-pass-support";
  readonly retryable: false;
  readonly noWorkPerformed: true;
  readonly unresolvedCount: number;
  readonly unresolved: readonly {
    readonly id: string;
    readonly targetPath: string;
    readonly condition: string;
    readonly status: string;
  }[];
}

export type OperatorFailureDetails =
  | RepositoryWorkspaceMaterializationFailureEvidence
  | ProposalScopeFailureDetailsV1
  | FirstPassSupportFailureDetailsV1
  | FirstPassEvidenceGapDetailsV1;

export interface OperatorErrorOptions {
  readonly code?: string;
  readonly nextAction?: string;
  readonly docsAnchor?: string;
}

export interface ReportOperatorFailureOptions {
  readonly json?: boolean;
  readonly write?: (line: string) => void;
}

const SAFE_CONTRACT_CODE = /^[a-z](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
/** Quality finding IDs and HTML check ids stay findings, not envelope codes. */
const QUALITY_FINDING_SHAPED_CODE = /^(?:[A-Z]{2,}(?:-[A-Z0-9]+)*-\d{3}|html-[a-z0-9-]+)$/u;
const SAFE_SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const PROPOSAL_SCOPE_CODES: ReadonlySet<string> = new Set(PROPOSAL_SCOPE_FAILURE_CODES);

/**
 * Duck-type detector for ContractError-like failures: an Error with a kebab-case
 * `code`, excluding Node errno codes and quality finding ids.
 */
export function isContractErrorLike(error: unknown): error is Error & { readonly code: string } {
  if (!(error instanceof Error)) return false;
  if (!("code" in error)) return false;
  const code = (error as { code: unknown }).code;
  return typeof code === "string" && isPublicContractCode(code);
}

function isPublicContractCode(code: string): boolean {
  return SAFE_CONTRACT_CODE.test(code) && !QUALITY_FINDING_SHAPED_CODE.test(code);
}

function isOperatorErrorEnvelope(value: unknown): value is OperatorErrorEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as {
    schemaVersion?: unknown;
    kind?: unknown;
    code?: unknown;
    message?: unknown;
  };
  return (
    candidate.schemaVersion === 1 &&
    candidate.kind === "docsfab-operator-error" &&
    typeof candidate.code === "string" &&
    isPublicContractCode(candidate.code) &&
    typeof candidate.message === "string"
  );
}

/** Build a credential-scrubbed operator envelope from any thrown value. */
export function toOperatorErrorEnvelope(
  error: unknown,
  options: OperatorErrorOptions = {},
): OperatorErrorEnvelope {
  if (isOperatorErrorEnvelope(error)) return withEnvelopeFailure(error);
  if (error instanceof Error && error.name === "KnowledgeAdapterOperatorError") {
    const envelope = (error as Error & { envelope?: unknown }).envelope;
    if (isOperatorErrorEnvelope(envelope)) return withEnvelopeFailure(envelope);
  }
  const code = sanitizeCode(
    options.code ??
      (isContractErrorLike(error) ? error.code : undefined) ??
      inferBoundaryCode(error),
  );
  const rawMessage =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "DocsFab rejected the request.";
  const message = scrubText(rawMessage.trim() || `Operation rejected: ${code}.`);
  const nextAction = scrubOptional(options.nextAction ?? inferNextAction(error, code));
  const docsAnchor = scrubOptional(options.docsAnchor ?? inferDocsAnchor(error, code));
  const details =
    proposalScopeDetails(error) ??
    firstPassSupportDetails(error) ??
    firstPassEvidenceGapDetails(error) ??
    materializationDetails(error);
  const partial = documentationPartialProjection(error);
  const failure = envelopeFailure(error, code, details);
  return Object.freeze({
    schemaVersion: 1 as const,
    kind: "docsfab-operator-error" as const,
    code,
    message,
    ...(nextAction ? { nextAction } : {}),
    ...(docsAnchor ? { docsAnchor } : {}),
    failure,
    ...(details ? { details } : {}),
    ...(partial
      ? {
          originalRequestCompletion: partial.originalRequestCompletion,
          draftApplicability: partial.draftApplicability,
          ...(partial.locator ? { documentationPartialLocator: partial.locator } : {}),
        }
      : {}),
  });
}

/** Human-facing lines: message, `code:`, then optional next action / docs. */
export function formatOperatorErrorEnvelope(envelope: OperatorErrorEnvelope): string {
  const lines = [envelope.message, `code: ${envelope.code}`];
  const failure = readFailureClassification(envelope.failure);
  if (failure) lines.push(formatEnvelopeFailureLine(failure, envelope.code));
  if (envelope.nextAction) lines.push(`Next action: ${envelope.nextAction}`);
  if (envelope.docsAnchor) lines.push(`Docs: ${envelope.docsAnchor}`);
  if (envelope.details?.kind === "docsfab-proposal-scope-admission-failure") {
    lines.push(
      "Evidence: proposal-scope admission stopped before workflow/model execution or target mutation; filesystem inspection may already have occurred; automatic retry is disabled.",
    );
  }
  if (envelope.details?.kind === "docsfab-first-pass-support-failure") {
    const { phase, rule, location, modelCalls, corrections } = envelope.details;
    const rounds = corrections === null ? "" : `, hinted correction rounds ${corrections}`;
    lines.push(
      `Evidence: first-pass support stopped in ${phase} at ${location} under rule ${rule}; model calls started ${modelCalls.started ?? "unknown"}, completed ${modelCalls.completed ?? "unknown"}${rounds}. This preflight did not create a RunRecord or mutate the target checkout.`,
    );
  }
  if (envelope.details?.kind === "docsfab-first-pass-evidence-gap") {
    const { unresolved, unresolvedCount } = envelope.details;
    lines.push(
      `Evidence: ${String(unresolvedCount)} mandatory first-pass obligation${unresolvedCount === 1 ? "" : "s"} unresolved${unresolved.length < unresolvedCount ? `, first ${String(unresolved.length)} shown` : ""}. This preflight did not create a RunRecord or mutate the target checkout.`,
      ...unresolved.map(
        (item) => `  ${item.id} (${item.status}) ${item.targetPath}: ${item.condition}`,
      ),
    );
  }
  if (envelope.originalRequestCompletion === "incomplete") {
    lines.push("Original request completion: incomplete. A host-held draft is not CREATE success.");
  }
  if (envelope.draftApplicability) {
    lines.push(`Draft applicability: ${envelope.draftApplicability}.`);
  }
  if (envelope.documentationPartialLocator) {
    lines.push(`Host-held draft locator: ${envelope.documentationPartialLocator}.`);
  }
  const output = lines.join("\n");
  return scrubText(output);
}

/** Stable JSON for `--json` modes; always includes `code` and `message`. */
export function serializeOperatorErrorEnvelope(envelope: OperatorErrorEnvelope): string {
  const body: {
    schemaVersion: number;
    kind: string;
    code: string;
    message: string;
    nextAction?: string;
    docsAnchor?: string;
    failure?: FailureClassificationV1;
    details?: OperatorFailureDetails;
    originalRequestCompletion?: "complete" | "incomplete";
    draftApplicability?: OperatorErrorEnvelope["draftApplicability"];
    documentationPartialLocator?: string;
  } = {
    schemaVersion: envelope.schemaVersion,
    kind: envelope.kind,
    code: envelope.code,
    message: envelope.message,
  };
  if (envelope.nextAction) body.nextAction = envelope.nextAction;
  if (envelope.docsAnchor) body.docsAnchor = envelope.docsAnchor;
  const failure = readFailureClassification(envelope.failure);
  if (failure) body.failure = failure;
  if (envelope.details) body.details = envelope.details;
  if (envelope.originalRequestCompletion) {
    body.originalRequestCompletion = envelope.originalRequestCompletion;
  }
  if (envelope.draftApplicability) body.draftApplicability = envelope.draftApplicability;
  if (envelope.documentationPartialLocator) {
    body.documentationPartialLocator = envelope.documentationPartialLocator;
  }
  return `${JSON.stringify(body, null, 2)}\n`;
}

/** Boundary reporter for CLI, doctor, and init; returns the envelope it reported. */
export function reportOperatorFailure(
  error: unknown,
  options: ReportOperatorFailureOptions = {},
): OperatorErrorEnvelope {
  const envelope = toOperatorErrorEnvelope(error);
  const write =
    options.write ??
    ((line: string) => {
      console.error(line);
    });
  write(
    options.json
      ? serializeOperatorErrorEnvelope(envelope).trimEnd()
      : formatOperatorErrorEnvelope(envelope),
  );
  return envelope;
}

export function wantsJsonFailureOutput(argv: readonly string[] = process.argv): boolean {
  return argv.includes("--json");
}

export { doctorFallbackRemediationText };

/**
 * The envelope's cause class. A code no table names is `unknown` with that
 * code, never a guessed class.
 */
function envelopeFailure(
  error: unknown,
  code: string,
  details: OperatorFailureDetails | undefined,
): FailureClassificationV1 {
  try {
    return envelopeFailureOf(error, code, details);
  } catch {
    // A hostile error must not turn its own envelope into a crash.
    return failureClassification(operatorCodeFailureClass(code) ?? "unknown", "cli", code);
  }
}

function envelopeFailureOf(
  error: unknown,
  code: string,
  details: OperatorFailureDetails | undefined,
): FailureClassificationV1 {
  if (isExplicitWriteScopeRefusal(error, code)) {
    return failureClassification("planning-refusal", "cli", code);
  }
  if (details?.kind === "docsfab-first-pass-support-failure") {
    const classified = classifyFirstPassFailure(details);
    if (classified) return classified.failure;
  }
  if (error instanceof RepositoryAccessRefusalError) {
    return failureClassification("operator-input", "host", error.code);
  }
  // These classify by the error's type, which the code alone cannot name.
  if (error instanceof InferenceStepError || error instanceof QualityPackError) {
    return classifyThrownFailure(error, "cli");
  }
  if (error instanceof Error && error.name.startsWith("FirstPassSupport")) {
    const ruleClass = firstPassRuleFailureClass(code);
    if (ruleClass) return failureClassification(ruleClass, "cli", code);
  }
  return failureClassification(operatorCodeFailureClass(code) ?? "unknown", "cli", code);
}

/** An envelope built elsewhere (the knowledge adapter) gains its class here once. */
function withEnvelopeFailure(envelope: OperatorErrorEnvelope): OperatorErrorEnvelope {
  if (readFailureClassification(envelope.failure)) return envelope;
  return Object.freeze({
    ...envelope,
    failure: failureClassification(
      operatorCodeFailureClass(envelope.code) ?? "unknown",
      "cli",
      envelope.code,
    ),
  });
}

/** `failure class: auth (layer cli)`, naming the classified code when it is not `code:`. */
function formatEnvelopeFailureLine(failure: FailureClassificationV1, code: string): string {
  const classifiedCode = failure.code === code ? "" : `, code ${failure.code}`;
  return `failure class: ${failure.class} (layer ${failure.layer}${classifiedCode})`;
}

function inferBoundaryCode(error: unknown): string {
  if (!(error instanceof Error)) return "operator-error";
  const message = error.message;
  if (
    /unknown (?:or duplicated )?(?:doctor |test )?option/iu.test(message) ||
    /requires --/iu.test(message) ||
    /cannot use --json/iu.test(message) ||
    /init --json requires/iu.test(message) ||
    /must not be duplicated/iu.test(message) ||
    /Unknown command/iu.test(message)
  ) {
    return "cli-usage";
  }
  return "operator-error";
}

function inferNextAction(error: unknown, code: string): string | undefined {
  const firstPassAction = firstPassSupportNextAction(error);
  if (firstPassAction) return firstPassAction;
  const materializationNext = materializationNextAction(error);
  if (materializationNext) return materializationNext;
  const lookedUp = lookupNextAction(error, code, DEFAULT_NEXT_ACTIONS);
  if (lookedUp) return lookedUp;
  // Publication `.action` is the fallback for codes the catalog does not own;
  // inferred remediations win first so `gitlab-unreachable` keeps its sentence.
  return publicationPreflightAction(error);
}

/** Only the host's early negative probe; interpreted request failures keep their own class. */
function isExplicitWriteScopeRefusal(error: unknown, code: string): error is Error {
  return (
    error instanceof Error &&
    error.name === "ExplicitDocumentationWriteScopeError" &&
    code === "request-intent-outside-write-scope"
  );
}

/** Unresolved first-pass questions a next action names; the rest are counted. */
const FIRST_PASS_NAMED_QUESTIONS = 8;

function firstPassSupportNextAction(error: unknown): string | undefined {
  // A stop at a named first-pass bound carries its own remediation: name the
  // sources, or raise the bound. It leads, because the bound is the cause.
  const boundRemediation = firstPassBoundStopNextAction(error);
  if (boundRemediation) return boundRemediation;
  // An evidence gap can carry its own remediation too: fix a named source
  // first pass could not read, or raise a bound it reached. It leads the
  // focused questions.
  const gapRemediation = firstPassEvidenceGapNextAction(error);
  const partial = documentationPartialProjection(error);
  if (partial && partial.unresolvedQuestions.length > 0) {
    const named = partial.unresolvedQuestions.slice(0, FIRST_PASS_NAMED_QUESTIONS);
    const unnamed = partial.unresolvedQuestions.length - named.length;
    const questions = named
      .map((item) => `${item.readerTask}: ${item.neededSourceOrDecision}`)
      .join(" ");
    const more =
      unnamed > 0
        ? ` ${String(unnamed)} more unresolved obligation${unnamed === 1 ? " is" : "s are"} listed in the error details.`
        : "";
    return `${gapRemediation ? `${gapRemediation} ` : ""}Original request remains incomplete. Answer the focused questions bound to the current request, then start a new bound run for the same instruction and revision. This preflight did not create a RunRecord. ${questions}${more} Do not re-ask unchanged authority.`;
  }
  if (gapRemediation) return gapRemediation;
  const details = firstPassSupportDetails(error);
  if (!details) return undefined;
  // One wording with the live-agent terminal: meaning, then who can act.
  const failure = classifyFirstPassFailure(details);
  if (!failure) return undefined;
  return failure.meaning + " This preflight did not create a RunRecord. " + failure.next;
}

function firstPassBoundStopNextAction(error: unknown): string | undefined {
  return firstPassStopOwnNextAction(error, "budget-exhausted");
}

function firstPassEvidenceGapNextAction(error: unknown): string | undefined {
  return firstPassStopOwnNextAction(error, "insufficient-evidence");
}

/** The remediation a first-pass validation stop with `code` carries itself. */
function firstPassStopOwnNextAction(error: unknown, code: string): string | undefined {
  if (!(error instanceof Error) || error.name !== "FirstPassSupportValidationError") {
    return undefined;
  }
  const candidate = error as Error & { readonly code?: unknown; readonly nextAction?: unknown };
  return candidate.code === code && typeof candidate.nextAction === "string"
    ? candidate.nextAction
    : undefined;
}

function documentationPartialProjection(error: unknown):
  | {
      originalRequestCompletion: "complete" | "incomplete";
      draftApplicability: NonNullable<OperatorErrorEnvelope["draftApplicability"]>;
      locator?: string;
      unresolvedQuestions: readonly {
        obligationId: string;
        readerTask: string;
        neededSourceOrDecision: string;
      }[];
    }
  | undefined {
  if (!(error instanceof Error) || error.name !== "FirstPassSupportValidationError") {
    return undefined;
  }
  const candidate = error as Error & { readonly partial?: unknown };
  if (
    !candidate.partial ||
    typeof candidate.partial !== "object" ||
    Array.isArray(candidate.partial)
  ) {
    return undefined;
  }
  const partial = candidate.partial as Record<string, unknown>;
  if (
    partial.originalRequestCompletion !== "complete" &&
    partial.originalRequestCompletion !== "incomplete"
  ) {
    return undefined;
  }
  if (
    partial.draftApplicability !== "useful-partial" &&
    partial.draftApplicability !== "scaffold-only" &&
    partial.draftApplicability !== "no-useful-deliverable" &&
    partial.draftApplicability !== "cancellation" &&
    partial.draftApplicability !== "execution-failure"
  ) {
    return undefined;
  }
  const questions = Array.isArray(partial.unresolvedQuestions)
    ? partial.unresolvedQuestions.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const row = item as Record<string, unknown>;
        if (
          typeof row.obligationId !== "string" ||
          typeof row.readerTask !== "string" ||
          typeof row.neededSourceOrDecision !== "string"
        ) {
          return [];
        }
        return [
          {
            obligationId: row.obligationId,
            readerTask: row.readerTask,
            neededSourceOrDecision: row.neededSourceOrDecision,
          },
        ];
      })
    : [];
  return {
    originalRequestCompletion: partial.originalRequestCompletion,
    draftApplicability: partial.draftApplicability,
    ...(typeof partial.locator === "string" ? { locator: partial.locator } : {}),
    unresolvedQuestions: questions,
  };
}

/** `LocalUserPublicationPreflightError.action` without importing the delivery layer. */
function publicationPreflightAction(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const action = (error as { action?: unknown }).action;
  return typeof action === "string" && action.trim().length > 0 ? action : undefined;
}

function materializationDetails(
  error: unknown,
): RepositoryWorkspaceMaterializationFailureEvidence | undefined {
  if (!(error instanceof RepositoryWorkspaceMaterializationError)) return undefined;
  const evidence = error.evidence;
  const quantity =
    evidence.quantity === null
      ? null
      : Object.freeze({
          unit: evidence.quantity.unit,
          limit: scrubText(evidence.quantity.limit),
          observed: scrubText(evidence.quantity.observed),
        });
  return Object.freeze({
    schemaVersion: 1 as const,
    kind: evidence.kind,
    code: evidence.code,
    phase: evidence.phase,
    quantity,
    children: Object.freeze({ ...evidence.children }),
  });
}

function proposalScopeDetails(error: unknown): ProposalScopeFailureDetailsV1 | undefined {
  if (!(error instanceof Error) || error.name !== "FirstRunProposalScopeError") return undefined;
  const candidate = error as Error & {
    readonly code?: unknown;
    readonly phase?: unknown;
    readonly retryable?: unknown;
    readonly noWorkPerformed?: unknown;
    readonly instructionSha256?: unknown;
    readonly repositoryRevision?: unknown;
  };
  if (
    typeof candidate.code !== "string" ||
    !PROPOSAL_SCOPE_CODES.has(candidate.code) ||
    candidate.phase !== "proposal-scope-admission" ||
    candidate.retryable !== false ||
    candidate.noWorkPerformed !== true ||
    typeof candidate.instructionSha256 !== "string" ||
    !SAFE_SHA256.test(candidate.instructionSha256) ||
    typeof candidate.repositoryRevision !== "string" ||
    !SAFE_REVISION.test(candidate.repositoryRevision)
  ) {
    return undefined;
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: "docsfab-proposal-scope-admission-failure",
    phase: "proposal-scope-admission",
    retryable: false,
    noWorkPerformed: true,
    instructionSha256: candidate.instructionSha256,
    repositoryRevision: candidate.repositoryRevision,
  });
}

/** Bounded so an adversarial obligation set cannot flood operator output. */
const MAX_REPORTED_EVIDENCE_GAPS = 32;
const MAX_EVIDENCE_GAP_CONDITION_CHARS = 240;
const FIRST_PASS_OBLIGATION_STATUSES = new Set([
  "missing",
  "unavailable",
  "contradicted",
  "budget-exhausted",
]);

function firstPassEvidenceGapDetails(error: unknown): FirstPassEvidenceGapDetailsV1 | undefined {
  if (!(error instanceof Error) || error.name !== "FirstPassSupportValidationError") {
    return undefined;
  }
  const candidate = error as Error & { readonly code?: unknown; readonly details?: unknown };
  // A bound stop lists the obligations it left unresolved, as an evidence gap does.
  if (
    (candidate.code !== "insufficient-evidence" && candidate.code !== "budget-exhausted") ||
    !Array.isArray(candidate.details)
  ) {
    return undefined;
  }
  const unresolved: FirstPassEvidenceGapDetailsV1["unresolved"][number][] = [];
  for (const item of candidate.details) {
    if (unresolved.length >= MAX_REPORTED_EVIDENCE_GAPS) break;
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const entry = item as Record<string, unknown>;
    if (
      typeof entry.id !== "string" ||
      typeof entry.targetPath !== "string" ||
      typeof entry.condition !== "string" ||
      typeof entry.status !== "string"
    ) {
      continue;
    }
    unresolved.push({
      id: scrubText(entry.id),
      targetPath: scrubText(entry.targetPath),
      condition: scrubText(entry.condition).slice(0, MAX_EVIDENCE_GAP_CONDITION_CHARS),
      status: FIRST_PASS_OBLIGATION_STATUSES.has(entry.status) ? entry.status : "unknown",
    });
  }
  if (unresolved.length === 0) return undefined;
  return Object.freeze({
    schemaVersion: 1 as const,
    kind: "docsfab-first-pass-evidence-gap" as const,
    phase: "first-pass-support" as const,
    retryable: false as const,
    noWorkPerformed: true as const,
    unresolvedCount: candidate.details.length,
    unresolved: Object.freeze(unresolved.map((entry) => Object.freeze(entry))),
  });
}

function firstPassSupportDetails(error: unknown): FirstPassSupportFailureDetailsV1 | undefined {
  if (!(error instanceof Error) || error.name !== "FirstPassSupportPreflightError") {
    return undefined;
  }
  const candidate = error as Error & {
    readonly code?: unknown;
    readonly retryable?: unknown;
    readonly evidence?: unknown;
  };
  if (
    candidate.code !== "first-pass-support-invalid" ||
    candidate.retryable !== false ||
    !candidate.evidence ||
    typeof candidate.evidence !== "object" ||
    Array.isArray(candidate.evidence)
  ) {
    return undefined;
  }
  const evidence = candidate.evidence as Record<string, unknown>;
  const calls = evidence.modelCalls;
  if (
    evidence.schemaVersion !== 1 ||
    evidence.kind !== "docsfab-first-pass-support-failure" ||
    typeof evidence.phase !== "string" ||
    !FIRST_PASS_FAILURE_PHASES.has(evidence.phase) ||
    typeof evidence.rule !== "string" ||
    !FIRST_PASS_FAILURE_RULES.has(evidence.rule) ||
    typeof evidence.location !== "string" ||
    !FIRST_PASS_FAILURE_LOCATION.test(evidence.location) ||
    typeof evidence.instructionSha256 !== "string" ||
    !SAFE_SHA256.test(evidence.instructionSha256) ||
    typeof evidence.repositoryRevision !== "string" ||
    !SAFE_REVISION.test(evidence.repositoryRevision) ||
    !calls ||
    typeof calls !== "object" ||
    Array.isArray(calls) ||
    !nullableNonnegativeInteger((calls as Record<string, unknown>).started) ||
    !nullableNonnegativeInteger((calls as Record<string, unknown>).completed) ||
    !nullableNonnegativeInteger(evidence.corrections) ||
    !nullableSha256(evidence.lastPromptSha256) ||
    !nullableSha256(evidence.lastResponseSha256) ||
    !nullableSha256(evidence.lastIdentitySha256) ||
    typeof evidence.evidenceSha256 !== "string" ||
    !SAFE_SHA256.test(evidence.evidenceSha256)
  ) {
    return undefined;
  }
  const started = (calls as { started: number | null }).started;
  const completed = (calls as { completed: number | null }).completed;
  if ((started === null) !== (completed === null) || (started !== null && completed! > started)) {
    return undefined;
  }
  const body = {
    schemaVersion: 1,
    kind: "docsfab-first-pass-support-failure",
    phase: evidence.phase,
    rule: evidence.rule,
    location: evidence.location,
    instructionSha256: evidence.instructionSha256,
    repositoryRevision: evidence.repositoryRevision,
    modelCalls: { started, completed },
    corrections: evidence.corrections,
    lastPromptSha256: evidence.lastPromptSha256,
    lastResponseSha256: evidence.lastResponseSha256,
    lastIdentitySha256: evidence.lastIdentitySha256,
  };
  if (
    createHash("sha256").update(JSON.stringify(body), "utf8").digest("hex") !==
    evidence.evidenceSha256
  ) {
    return undefined;
  }
  return Object.freeze({
    ...body,
    schemaVersion: 1,
    kind: "docsfab-first-pass-support-failure",
    retryable: false,
    modelCalls: Object.freeze(body.modelCalls),
    evidenceSha256: evidence.evidenceSha256,
  });
}

function nullableNonnegativeInteger(value: unknown): value is number | null {
  return value === null || (Number.isSafeInteger(value) && Number(value) >= 0);
}

function nullableSha256(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && SAFE_SHA256.test(value));
}

/**
 * The sentence an operator acts on after a materialization stall. Both stall
 * codes come from one no-progress window, `repository.workspaceExportStallMs`,
 * which is not a wall clock: tree size alone never causes them.
 */
const EXPORT_STALL_REMEDY =
  "An export that keeps making progress is never stopped, so tree size alone does not cause this stop. Check that git and the disk respond, then retry. If they are healthy and one step legitimately takes longer on this host, for example under heavy load, raise DOCSFAB_REPOSITORY_WORKSPACE_EXPORT_STALL_MS (repository.workspaceExportStallMs). Run `docsfab doctor` for offline readiness; it does not materialize the workspace.";

/** Export stops at a size ceiling; each names its catalog limit and override. */
const EXPORT_SIZE_CODES: ReadonlySet<string> = new Set([
  "file-count-limit",
  "aggregate-byte-limit",
  "scratch-space-limit",
  "tree-metadata-limit",
]);

function materializationNextAction(error: unknown): string | undefined {
  if (!(error instanceof RepositoryWorkspaceMaterializationError)) return undefined;
  if (EXPORT_SIZE_CODES.has(error.evidence.code)) {
    return "The workspace export crossed the size limit the message names. If this host has the memory and scratch space, raise that limit with the override the message names, then retry; otherwise run on a revision that tracks fewer or smaller files. A scratch-space-limit that names no limit means the scratch volume is full: free space there, then retry.";
  }
  if (error.evidence.code === "per-blob-timeout") {
    return `The file being exported made no progress for the whole no-progress window: no bytes arrived from git or were written to the workspace, so git or a disk stopped answering. ${EXPORT_STALL_REMEDY}`;
  }
  if (error.evidence.code === "filesystem-path-collision") {
    return "The workspace filesystem could not keep distinct repository paths separate. Use a filesystem that preserves the repository's distinct names, or rename the conflicting paths in the repository, then retry.";
  }
  if (error.evidence.code !== "aggregate-timeout") {
    return "Correct the reported workspace materialization limit, then retry. Callers can only tighten harness limits, not raise them.";
  }
  switch (error.evidence.phase) {
    case "preflight":
      return `The export made no progress for the whole no-progress window before any file export: a git read, the tree listing, or the scratch-space check did not finish. ${EXPORT_STALL_REMEDY}`;
    case "materialization":
      return `The export made no progress for the whole no-progress window while exporting tracked files: no directory, file write, or closing fsync finished. ${EXPORT_STALL_REMEDY}`;
    case "verification":
      return `The export made no progress for the whole no-progress window while verifying the exported workspace: no exported file finished its check. ${EXPORT_STALL_REMEDY}`;
  }
}

/** Docs anchor for `(error.name, error.code)`, then remediation, then catalog defaults. */
function inferDocsAnchor(error: unknown, code: string): string | undefined {
  return lookupDocsAnchor(error, code, DEFAULT_DOCS_ANCHORS, REMEDIATION_DOCS_ANCHORS);
}

function sanitizeCode(code: string): string {
  const trimmed = code.trim();
  if (isPublicContractCode(trimmed)) return trimmed;
  return "operator-error";
}

function scrubText(value: string): string {
  return sanitizeDisplayText(redactCredentialMaterial(value));
}

/** Operator display text: credentials and URLs redacted, then this host's roots replaced. */
export function sanitizeDisplayText(value: string): string {
  const roots = envelopeRootSet();
  return (
    redactDisplayText(value, (text) => {
      const result = egressText(text, roots);
      // Credential material that survived redaction withholds the whole text.
      return result.ok ? result.text : "[REDACTED]";
    }) ?? ""
  );
}

/**
 * An envelope must render even when `DOCSFAB_PUBLIC_ROOTS` is the failure it
 * reports, so an invalid declaration here only means no root is public.
 */
function envelopeRootSet() {
  try {
    return runtimeEgressRootSet();
  } catch (error) {
    if (!(error instanceof PublicRootsOperatorError)) throw error;
    return runtimeEgressRootSet({ publicRoots: new Set() });
  }
}

function scrubOptional(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const scrubbed = scrubText(value).trim();
  return scrubbed.length > 0 ? scrubbed : undefined;
}
