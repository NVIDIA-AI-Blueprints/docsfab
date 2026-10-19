// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { lstat, readFile } from "node:fs/promises";
import { join, posix } from "node:path";

import { limit, limitDefinition } from "../config/limits.js";
import type { DocsFabConfig } from "../config/runtime-loader.js";
import {
  admittedInputWindowTokens,
  type AdmittedInputWindowSource,
} from "../model/admitted-input-window.js";
import { normalizeModelFinishReason } from "../model/attempt-telemetry.js";
import { createModelEvidence } from "../model/profile-evidence.js";
import {
  resolveOperatorExecutionBinding,
  type OperatorExecutionBinding,
} from "../model/operator-execution-binding.js";
import { createProviderConnectionFactory, type ModelConnection } from "../model/provider.js";
import type { CompositionRunRuntime } from "./run/composition-runtime.js";
import type { FirstPassDocumentationTargetControl } from "../workflow-execution/runner.js";
import type { FirstPassFailureRule } from "../operator/pre-record-failure.js";
import { classifyTaskWritePath } from "../execution/task-scope.js";
import { withinWriteCeiling } from "../host-invoker/wire-decode.js";
import { documentationMarkdownLinkTargets } from "../repository/documentation-source-support.js";
import {
  findExecutableEvidenceValue,
  type DocumentedEvidenceBinding,
} from "../repository/executable-evidence-value.js";
import { isAgentInstructionFile } from "../repository/agent-instruction-files.js";
import { sourceCommentQuotationReader } from "../repository/source-quotation-role.js";
import { compareText } from "../shared/primitives.js";
import { LOCAL_DOCUMENTATION_WRITE_ROOTS } from "../workflow-execution/plan-companions.js";
import { canonicalDigest, sha256 } from "../content-ir/canonical.js";
import { FIRST_PASS_EVIDENCE_GAPS_PREFIX } from "./first-pass-evidence-gaps.js";
import type { RequestIntentV1 } from "../request-intent/contract.js";
import { isRecordableEvidenceWarning } from "../records/evidence-warnings.js";
import { escapeUndisplayable } from "../shared/display-text.js";
import { WorkflowCancelledError } from "../execution/cancellation.js";
import { assertConfinedToolResultCredentialFree } from "../security/credential-isolation.js";
import { FirstPassChoiceContinuationError } from "./run/first-pass-choice-continuation.js";

const SUPPORT_KIND = "docsfab-first-pass-support";
/** The obligation id of a target the host found without page support. */
const HOST_PAGE_SUPPORT_ID = "host-page-support";
const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_TARGET = /^(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.mdx?$/u;
const SAFE_UPDATE_TARGET = /^(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:mdx?|rst)$/u;
const STATUSES = new Set([
  "supported",
  "missing",
  "contradicted",
  "unavailable",
  "budget-exhausted",
]);
/**
 * Statuses of an obligation repository evidence did not close: an evidence
 * gap, which first pass records as a limitation and continues past (#2113).
 * `contradicted` is not one: sources that disagree need a person.
 */
const EVIDENCE_GAP_STATUSES = new Set(["missing", "unavailable", "budget-exhausted"]);

/** The mandatory first-pass model phases, in order. Their count is structure, not a bound. */
export const FIRST_PASS_MANDATORY_MODEL_PHASES = [
  "decomposition",
  "completeness",
  "assessment",
] as const;

/**
 * Bytes per token in the bridge's own input estimate (`estimateTokens`). It
 * also converts one turn's input share into the evidence bytes one assessment
 * may offer, so the two agree.
 */
export const FIRST_PASS_ESTIMATED_BYTES_PER_TOKEN = 3;

/**
 * Host-sized first-pass acquisition bounds and deadlines, passed to the
 * knowledge first pass as `firstPassLimits`. Each is a `firstPass.*` limit
 * resolved with host overrides; the knowledge record carries them back.
 */
export interface FirstPassHostLimits {
  readonly maxFileBytes: number;
  readonly maxPresentedBytes: number;
  readonly maxScannedFiles: number;
  readonly maxSourceFiles: number;
  readonly maxSpans: number;
  readonly maxTotalReadBytes: number;
  readonly modelDeadlineMs: number;
  readonly readDeadlineMs: number;
}

/**
 * The first-pass model clock: `firstPass.modelDeadlineMs`, or the installed
 * composition's shorter attempt timer.
 */
export function firstPassModelDeadlineMs(
  compositionRuntime?: Pick<CompositionRunRuntime, "executionProfile">,
): number {
  const declared = limit("firstPass.modelDeadlineMs").value;
  return Math.min(
    compositionRuntime?.executionProfile.compositionPolicy?.timeoutMs ?? declared,
    declared,
  );
}

/** The bound model profile whose admitted input window sizes the assessment prompt. */
export type FirstPassInputWindowSource = AdmittedInputWindowSource & {
  readonly requestPolicy?: { readonly reservedContextTokens?: number };
};

/**
 * The host's first-pass limits for one request. One assessment prompt fills at
 * most `firstPass.assessmentInputWindowShare` of the bound model's admitted
 * input window after its context reserve, and at most one turn's input share,
 * at the bridge's token estimate, under the `firstPass.maxPresentedBytes`
 * ceiling.
 */
export function firstPassHostLimits(input: {
  readonly budget: Pick<FirstPassModelBudget, "inputTokensPerTurn">;
  /**
   * The bound model profile, never the endpoint configuration. Without one, or
   * when its window is not attested, one turn's input share stands in for it.
   */
  readonly model?: FirstPassInputWindowSource;
  readonly modelDeadlineMs: number;
}): FirstPassHostLimits {
  const window = admittedInputWindowTokens(input.model);
  const inputWindowTokens =
    window === undefined
      ? input.budget.inputTokensPerTurn
      : Math.max(0, window - (input.model?.requestPolicy?.reservedContextTokens ?? 0));
  const promptTokens = Math.min(
    Math.floor(limit("firstPass.assessmentInputWindowShare").value * inputWindowTokens),
    input.budget.inputTokensPerTurn,
  );
  return Object.freeze({
    maxFileBytes: limit("firstPass.maxFileBytes").value,
    // A window too small for one byte of prompt still gets the catalog
    // minimum, so acquisition stops on this bound by name.
    maxPresentedBytes: Math.max(
      Math.min(
        limit("firstPass.maxPresentedBytes").value,
        promptTokens * FIRST_PASS_ESTIMATED_BYTES_PER_TOKEN,
      ),
      limitDefinition("firstPass.maxPresentedBytes").min,
    ),
    maxScannedFiles: limit("firstPass.maxScannedFiles").value,
    maxSourceFiles: limit("firstPass.maxSourceFiles").value,
    maxSpans: limit("firstPass.maxSpans").value,
    maxTotalReadBytes: limit("firstPass.maxTotalReadBytes").value,
    modelDeadlineMs: input.modelDeadlineMs,
    readDeadlineMs: limit("firstPass.readDeadlineMs").value,
  });
}

/**
 * The operator binding first pass connects through when the run selects no
 * composition. The host resolves it once: the prompt is sized from its
 * admitted window, and the support bridge connects through the same binding.
 */
export function firstPassOperatorBinding(
  config: Pick<DocsFabConfig, "model">,
): Promise<OperatorExecutionBinding> {
  return resolveOperatorExecutionBinding({
    model: config.model,
    workflowId: "create-documentation",
  });
}

/** The widest first-pass limits a host can configure: each catalog maximum. */
function firstPassHostLimitsCeiling(): FirstPassHostLimits {
  return Object.freeze({
    maxFileBytes: limitDefinition("firstPass.maxFileBytes").max,
    maxPresentedBytes: limitDefinition("firstPass.maxPresentedBytes").max,
    maxScannedFiles: limitDefinition("firstPass.maxScannedFiles").max,
    maxSourceFiles: limitDefinition("firstPass.maxSourceFiles").max,
    maxSpans: limitDefinition("firstPass.maxSpans").max,
    maxTotalReadBytes: limitDefinition("firstPass.maxTotalReadBytes").max,
    modelDeadlineMs: limitDefinition("firstPass.modelDeadlineMs").max,
    readDeadlineMs: limitDefinition("firstPass.readDeadlineMs").max,
  });
}

/**
 * The first-pass model budget for one request. Turns are the mandatory phases
 * plus `firstPass.evidenceExpansionModelTurns` plus `retry.maxRetries` hinted
 * correction rounds; the cumulative token budgets are that many turns of the
 * per-turn `firstPass` token limits.
 */
export interface FirstPassModelBudget {
  readonly maxCorrections: number;
  readonly evidenceExpansionModelTurns: number;
  readonly inputTokensPerTurn: number;
  readonly outputTokensPerTurn: number;
  readonly maxModelTurns: number;
  readonly maxCumulativeInputTokens: number;
  readonly maxCumulativeOutputTokens: number;
}

/**
 * The configuration lacks the resolved retry policy, so first pass cannot size
 * its correction rounds. Reached by an embedder passing a partial configuration;
 * the CLI and live agent pass what `loadConfig` resolves.
 */
export class FirstPassRuntimeConfigurationError extends Error {
  public readonly name = "FirstPassRuntimeConfigurationError";
  public readonly code = "installation-runtime-invalid";
}

export function firstPassModelBudget(config: {
  readonly retryPolicy?: { readonly maxRetries?: unknown };
}): FirstPassModelBudget {
  const maxCorrections = config.retryPolicy?.maxRetries;
  if (
    typeof maxCorrections !== "number" ||
    !Number.isSafeInteger(maxCorrections) ||
    maxCorrections < 0
  ) {
    throw new FirstPassRuntimeConfigurationError(
      "First-pass support needs the resolved runtime configuration's retryPolicy.maxRetries (retry.maxRetries) to size its correction rounds, and the caller passed a configuration without it. Pass the configuration loadConfig resolves.",
    );
  }
  return sizedFirstPassModelBudget({
    maxCorrections,
    evidenceExpansionModelTurns: limit("firstPass.evidenceExpansionModelTurns").value,
    inputTokensPerTurn: limit("firstPass.modelInputTokensPerTurn").value,
    outputTokensPerTurn: limit("firstPass.modelOutputTokensPerTurn").value,
  });
}

function sizedFirstPassModelBudget(shares: {
  readonly maxCorrections: number;
  readonly evidenceExpansionModelTurns: number;
  readonly inputTokensPerTurn: number;
  readonly outputTokensPerTurn: number;
}): FirstPassModelBudget {
  const maxModelTurns =
    FIRST_PASS_MANDATORY_MODEL_PHASES.length +
    shares.evidenceExpansionModelTurns +
    shares.maxCorrections;
  return Object.freeze({
    ...shares,
    maxModelTurns,
    maxCumulativeInputTokens: maxModelTurns * shares.inputTokensPerTurn,
    maxCumulativeOutputTokens: maxModelTurns * shares.outputTokensPerTurn,
  });
}

/**
 * The widest first-pass budget a host can configure: `retry.maxRetries` and
 * every `firstPass.*` model limit at its catalog maximum.
 */
export function firstPassModelBudgetCeiling(): FirstPassModelBudget {
  return sizedFirstPassModelBudget({
    maxCorrections: limitDefinition("retry.maxRetries").max,
    evidenceExpansionModelTurns: limitDefinition("firstPass.evidenceExpansionModelTurns").max,
    inputTokensPerTurn: limitDefinition("firstPass.modelInputTokensPerTurn").max,
    outputTokensPerTurn: limitDefinition("firstPass.modelOutputTokensPerTurn").max,
  });
}

export interface FirstPassSupportModelRequest {
  readonly systemPrompt: string;
  readonly prompt: string;
  readonly maxOutputTokens: number;
  readonly procedureId: string;
  readonly procedureSha256: string;
  readonly promptSha256: string;
}

export interface FirstPassSupportModelResult {
  readonly responseText: string;
  readonly identity: FirstPassAssessmentIdentity;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
}

export interface FirstPassAssessmentIdentity {
  readonly providerId: string;
  readonly modelId: string;
  readonly profileSha256: string;
  readonly compositionSha256: string | null;
  readonly requestPolicySha256: string | null;
  readonly systemPromptSha256: string;
  readonly promptSha256: string;
  readonly procedureSha256: string;
  readonly responseSha256: string;
  readonly turnEvidenceSha256: string;
}

export interface FirstPassSupportModelBridge {
  readonly call: (request: FirstPassSupportModelRequest) => Promise<FirstPassSupportModelResult>;
  readonly lastAssessmentIdentitySha256: () => string | undefined;
  readonly lastAssessmentBindingSha256: () => string | undefined;
  readonly failureEvidence?: () => FirstPassSupportModelCallEvidence;
}

export interface FirstPassSupportModelCallEvidence {
  readonly modelCallsStarted: number;
  readonly modelCallsCompleted: number;
  readonly lastPromptSha256: string | null;
  readonly lastResponseSha256: string | null;
  readonly lastIdentitySha256: string | null;
}

/**
 * Rules the runtime model-call boundary can raise. `satisfies` ties them to the
 * operator classification table: a rule missing from that table fails
 * `npm run typecheck` here, before it can reach an operator surface.
 */
export const FIRST_PASS_MODEL_CALL_RULES = [
  "model-connection-failed",
  "model-cumulative-token-budget-exhausted",
  "model-deadline-exhausted",
  "model-input-budget-exhausted",
  "model-profile-unavailable",
  "model-turn-budget-exhausted",
  "output-policy-limit",
  "assessment-binding-prompt-shape",
  "assessment-binding-provenance",
  "assessment-binding-response-json",
  "assessment-binding-response-rows",
  "assessment-binding-response-shape",
  "assessment-binding-source-spans",
  "provider-call-failed",
  "provider-stop-reason",
  "response-truncated",
] as const satisfies readonly FirstPassFailureRule[];
export type FirstPassModelCallRule = (typeof FIRST_PASS_MODEL_CALL_RULES)[number];

export class FirstPassSupportModelCallError extends Error {
  public readonly name = "FirstPassSupportModelCallError";
  public readonly code = "first-pass-model-boundary";

  public constructor(
    public readonly phase: "decomposition" | "completeness" | "assessment",
    public readonly rule: FirstPassModelCallRule,
    public readonly location:
      | "$model.connection"
      | "$model.deadline"
      | "$model.inputBudget"
      | "$model.outputBudget"
      | "$model.profile"
      | "$model.requestPolicy"
      | "$model.turnBudget"
      | "$prompt.mandatoryObligations"
      | "$repository"
      | "$response"
      | "$response.assessments",
  ) {
    super(`First-pass support stopped during ${phase} (${rule}).`);
  }
}

/** One disagreeing source of a contradicted obligation, as the host verified it. */
export interface FirstPassContradictionSideV1 {
  readonly path: string;
  readonly lineStart: number;
  readonly lineEnd: number;
  /**
   * The disputed value, found verbatim in the verified span text; null when
   * the assessment gave no value the host could find there.
   */
  readonly value: string | null;
}

/** A contradicted mandatory obligation and the sources that disagree on it. */
export interface FirstPassContradictionV1 {
  readonly obligationId: string;
  readonly targetPaths: readonly string[];
  readonly condition: string;
  readonly sides: readonly FirstPassContradictionSideV1[];
}

export class FirstPassSupportValidationError extends Error {
  /** The validated assessment that produced a contradiction-only stop. */
  public replay?: import("../records/first-pass-replay.js").FirstPassReplayV1;
  /** Set for a stop whose remediation is fixed, such as an exhausted bound. */
  public readonly nextAction?: string;
  /**
   * Set only with code `contradicted`: every unresolved obligation, each with
   * the sides the host verified, for the one question the stop asks.
   */
  public readonly contradictions?: readonly FirstPassContradictionV1[];

  public constructor(
    public readonly code:
      | "invalid-support"
      | "support-binding-mismatch"
      | "support-provenance-invalid"
      | "insufficient-evidence"
      | "budget-exhausted"
      | "contradicted",
    message: string,
    /**
     * Unresolved mandatory obligations, so the operator boundary can name
     * which failed. `id` is the retained first-pass document's obligation id.
     */
    public readonly details: readonly {
      id: string;
      targetPath: string;
      condition: string;
      status: string;
    }[] = [],
    /**
     * Labeled host-held draft beside the incomplete original request. Never
     * implies publication eligibility or original-request completion.
     */
    public readonly partial?: DocumentationPartialProjection,
    nextAction?: string,
    contradictions?: readonly FirstPassContradictionV1[],
  ) {
    super(message);
    this.name = "FirstPassSupportValidationError";
    if (nextAction !== undefined) this.nextAction = nextAction;
    if (contradictions !== undefined) this.contradictions = contradictions;
  }
}

/**
 * First-pass bounds a support record can name as exhausted: what each
 * counts, and the `firstPass.*` catalog limit a host raises for it. maxRounds
 * is the first assessment plus `firstPass.evidenceExpansionModelTurns`.
 * maxPresentedBytes counts the whole assessment prompt: the request, its
 * obligations, and every evidence span with its frame. Its limit is derived,
 * so `boundLimitNames` names the setting that set it.
 */
const FIRST_PASS_ACQUISITION_BOUNDS = {
  maxScannedFiles: { label: "tracked files listed", limitName: "firstPass.maxScannedFiles" },
  maxSourceFiles: { label: "source files read", limitName: "firstPass.maxSourceFiles" },
  maxFileBytes: { label: "bytes in one unnamed source file", limitName: "firstPass.maxFileBytes" },
  maxTotalReadBytes: { label: "repository bytes read", limitName: "firstPass.maxTotalReadBytes" },
  maxSpans: { label: "evidence spans offered", limitName: "firstPass.maxSpans" },
  maxPresentedBytes: {
    label: "assessment prompt bytes",
    limitName: "firstPass.maxPresentedBytes",
  },
  maxRounds: {
    label: "assessment rounds",
    limitName: "firstPass.evidenceExpansionModelTurns",
  },
} as const;

type FirstPassAcquisitionBound = keyof typeof FIRST_PASS_ACQUISITION_BOUNDS;

export interface FirstPassExhaustedBound {
  readonly bound: FirstPassAcquisitionBound;
  readonly observed: number;
  readonly limit: number;
}

/** Candidate source files a bound left unread, with the ones named by path. */
export interface FirstPassUnreadFiles {
  readonly count: number;
  readonly namedPaths: readonly string[];
}

/**
 * Why a source the request named was not offered: `missing` when it is not a
 * readable regular file in the selected revision, `empty`, or `not-text` when
 * its bytes are not UTF-8.
 */
const NAMED_SOURCE_GAP_REASONS = {
  missing: "is not a readable regular file in the selected revision",
  empty: "is empty",
  "not-text": "is not UTF-8 text",
} as const;

export interface FirstPassNamedSourceGap {
  readonly path: string;
  readonly reason: keyof typeof NAMED_SOURCE_GAP_REASONS;
}

const count = (value: number) => value.toLocaleString("en-US");

const WINDOW_SHARE_LIMIT = "firstPass.assessmentInputWindowShare";

/**
 * The catalog limits that set a bound's recorded limit. The assessment prompt
 * bound is the smallest of the terms `firstPassHostLimits` takes: the ceiling
 * and the turn share set it when they equal it, and the window share otherwise.
 */
function boundLimitNames({ bound, limit: recorded }: FirstPassExhaustedBound): readonly string[] {
  if (bound !== "maxPresentedBytes") return [FIRST_PASS_ACQUISITION_BOUNDS[bound].limitName];
  const names = [
    ...(recorded >= limit("firstPass.maxPresentedBytes").value
      ? ["firstPass.maxPresentedBytes"]
      : []),
    ...(recorded >=
    limit("firstPass.modelInputTokensPerTurn").value * FIRST_PASS_ESTIMATED_BYTES_PER_TOKEN
      ? ["firstPass.modelInputTokensPerTurn"]
      : []),
  ];
  return names.length > 0 ? names : [WINDOW_SHARE_LIMIT];
}

/** One bound, the demand it refused, its limit, and the catalog limits behind it. */
function exhaustedBoundPhrase(item: FirstPassExhaustedBound): string {
  const { label } = FIRST_PASS_ACQUISITION_BOUNDS[item.bound];
  return `${label} needed ${count(item.observed)}, over the limit of ${count(item.limit)} (${item.bound}, ${boundLimitNames(item).join(", ")})`;
}

/** Names each bound, the demand it refused, and its limit, in one sentence. */
function firstPassBoundsMessage(bounds: readonly FirstPassExhaustedBound[]): string {
  return `First-pass support stopped at its acquisition bounds with mandatory obligations unresolved: ${bounds.map(exhaustedBoundPhrase).join("; ")}.`;
}

/**
 * The settings that raise the bounds: each that set one, and for the round
 * allowance also the source budget its rounds share. A window share already
 * at its maximum cannot raise anything, so it is left out.
 */
function raisableLimitNames(bounds: readonly FirstPassExhaustedBound[]): readonly string[] {
  const names = new Set(bounds.flatMap(boundLimitNames));
  if (bounds.some(({ bound }) => bound === "maxRounds")) names.add("firstPass.maxSourceFiles");
  return [...names].filter(
    (name) => name !== WINDOW_SHARE_LIMIT || limit(name).value < limitDefinition(name).max,
  );
}

/** Each bound's host override, or its catalog name, and how far it can go. */
function firstPassBoundRaises(bounds: readonly FirstPassExhaustedBound[]): string {
  return raisableLimitNames(bounds)
    .map((name) => {
      const definition = limitDefinition(name);
      return definition.override === null
        ? `${name} (up to ${count(definition.max)})`
        : `${definition.override} (up to ${count(definition.max)})`;
    })
    .join(", ");
}

/**
 * The remediation for exhausted bounds: name the sources, or raise each bound
 * with its host override, up to the catalog maximum. A prompt bound the window
 * share set also grows with a model whose input window is larger.
 */
export function firstPassBoundsNextAction(bounds: readonly FirstPassExhaustedBound[]): string {
  const raises = firstPassBoundRaises(bounds);
  const raise = raises
    ? ` Or raise ${raises} in the host configuration; \`docsfab doctor --limits\` shows the effective values.`
    : "";
  const rounds = bounds.some(({ bound }) => bound === "maxRounds")
    ? " Each round reads an even share of DOCSFAB_FIRST_PASS_MAX_SOURCE_FILES, so more rounds alone read fewer files a round."
    : "";
  const window = bounds.some((item) => boundLimitNames(item).includes(WINDOW_SHARE_LIMIT))
    ? " A model profile with a larger input window also holds a larger assessment prompt."
    : "";
  return `Name the sources the request needs by path, in the request or with --source <path>; first pass reads named sources before it ranks the rest.${raise}${rounds}${window} Then start a new run.`;
}

/** The named sources first pass could not offer, as one leading sentence. */
function namedSourceGapsSentence(gaps: readonly FirstPassNamedSourceGap[]): string {
  if (gaps.length === 0) return "";
  return `The request names sources first pass could not read: ${gaps.map(({ path, reason }) => `${path} ${NAMED_SOURCE_GAP_REASONS[reason]}`).join("; ")}. `;
}

const NAMED_SOURCE_GAP_ACTION =
  "Check each source the request names: correct its path, commit it to the selected revision, or name a UTF-8 text source in its place. ";

/** The files a bound left unread, with the named ones by path, as one sentence. */
function unreadFilesSentence(unread: FirstPassUnreadFiles | undefined): string {
  if (!unread) return "";
  const named = unread.namedPaths.length > 0 ? `, including ${unread.namedPaths.join(", ")}` : "";
  return ` Reading stopped with ${count(unread.count)} candidate source file${unread.count === 1 ? "" : "s"} unread${named}.`;
}

/**
 * Bounds a supported first pass reached, and named sources it could not
 * read: limitations of its evidence, not a stop. Empty when the record names
 * none. Call after validateFirstPassSupport.
 */
export function firstPassRecordedLimitations(support: unknown): readonly string[] {
  if (!support || typeof support !== "object") return [];
  const record = support as {
    exhaustedBounds?: unknown;
    namedSourceGaps?: unknown;
  };
  const bounds = recordedBounds(record.exhaustedBounds);
  const gaps = Array.isArray(record.namedSourceGaps)
    ? record.namedSourceGaps.filter(
        (item): item is FirstPassNamedSourceGap =>
          Boolean(item) &&
          typeof item === "object" &&
          typeof (item as { path?: unknown }).path === "string" &&
          Object.hasOwn(NAMED_SOURCE_GAP_REASONS, (item as { reason?: unknown }).reason as string),
      )
    : [];
  return [
    ...gaps.map(({ path, reason }) => `named source ${path} ${NAMED_SOURCE_GAP_REASONS[reason]}`),
    ...bounds.map(exhaustedBoundPhrase),
  ];
}

/**
 * The status line for a supported first pass with limitations: each
 * limitation, the files a bound left unread, and how to raise each bound.
 * Undefined when the record names none. Call after validateFirstPassSupport.
 */
export function firstPassLimitationStatus(support: unknown): string | undefined {
  const limitations = firstPassRecordedLimitations(support);
  if (limitations.length === 0) return undefined;
  const record = support as {
    exhaustedBounds?: readonly FirstPassExhaustedBound[];
    unreadFiles?: FirstPassUnreadFiles;
  };
  const bounds = (record.exhaustedBounds ?? []).filter((item) =>
    Object.hasOwn(FIRST_PASS_ACQUISITION_BOUNDS, item.bound),
  );
  const raises = firstPassBoundRaises(bounds);
  const raise = raises ? ` To read more, raise ${raises}.` : "";
  return `first-pass evidence has limitations, and every mandatory obligation is still supported: ${limitations.join("; ")}.${unreadFilesSentence(record.unreadFiles)}${raise}`;
}

/** The first-pass bounds a record names, read leniently after validation. */
function recordedBounds(value: unknown): readonly FirstPassExhaustedBound[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is FirstPassExhaustedBound =>
          Boolean(item) &&
          typeof item === "object" &&
          Object.hasOwn(
            FIRST_PASS_ACQUISITION_BOUNDS,
            (item as { bound?: unknown }).bound as string,
          ),
      )
    : [];
}

/**
 * How a first pass that kept gaps open ended, by its recorded termination
 * reason. `no-progress` is either a round after which no fewer obligations
 * were open, or an attempt to read further that found no new evidence. The
 * record keeps one reason for both, so the first is claimed only when an
 * expansion round ran.
 */
const GAP_ENDINGS: Readonly<Record<string, string>> = Object.freeze({
  "no-progress":
    "its last round either did not reduce the number of open obligations or found no new evidence, so reading further was not expected to close one",
  "budget-exhausted": "an evidence bound stopped its reading",
  "unresolved-obligations": "its reading ended with obligations still open",
});

/** The `no-progress` ending after one assessment round: no expansion round ran. */
const NO_EXPANSION_ENDING =
  "an attempt to read further found no new evidence, so reading further was not expected to close an open obligation";

interface RecordedObligation {
  readonly id: string;
  readonly status: string;
  readonly requiredSourceSupport: boolean;
  readonly evidenceSpanIds: readonly string[];
  readonly targetPaths: readonly string[];
}

function isRecordedObligation(value: unknown): value is RecordedObligation {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === "string" &&
    typeof item.status === "string" &&
    typeof item.requiredSourceSupport === "boolean" &&
    Array.isArray(item.evidenceSpanIds) &&
    Array.isArray(item.targetPaths)
  );
}

const plural = (value: number, noun: string) => `${count(value)} ${noun}${value === 1 ? "" : "s"}`;

/**
 * The limitation lines of a first pass that continued with evidence gaps
 * (#2113), for the preflight status and `RunRecord.evidenceWarnings`, which
 * the operator summary and the `--json` result show: how many mandatory
 * obligations its repository evidence did not support and how first pass
 * ended; each open obligation by id; each bound it reached, with the demand,
 * the limit, the `firstPass.*` setting and the override that raises it; and
 * the candidate files it left unread, with each unread path the request or an
 * obligation named, one to a line. A line holds counts, ids, setting names,
 * or one path, never a condition, so its length does not grow with the
 * request; the support record keeps the rest. Empty for a supported first
 * pass. Call after validateFirstPassSupport, which admitted the record.
 */
export function firstPassEvidenceGapLines(
  support: unknown,
  resolvedIds: ReadonlySet<string> = new Set(),
): readonly string[] {
  if (!support || typeof support !== "object") return [];
  const record = support as {
    readonly terminationReason?: unknown;
    readonly targetPaths?: unknown;
    readonly cost?: { readonly rounds?: unknown };
    readonly obligations?: unknown;
    readonly exhaustedBounds?: unknown;
    readonly unreadFiles?: FirstPassUnreadFiles;
  };
  const obligations = Array.isArray(record.obligations)
    ? record.obligations.filter(isRecordedObligation)
    : [];
  const targetPaths = Array.isArray(record.targetPaths)
    ? record.targetPaths.filter((path): path is string => typeof path === "string")
    : [];
  const open = obligations.filter(
    (item) => item.status !== "supported" && !resolvedIds.has(item.id),
  );
  const pages = pagesWithoutSupport(obligations, targetPaths, resolvedIds);
  if (
    (open.length === 0 && pages.length === 0) ||
    !open.every((item) => EVIDENCE_GAP_STATUSES.has(item.status))
  ) {
    return [];
  }
  const rounds = Number.isSafeInteger(record.cost?.rounds) ? Number(record.cost?.rounds) : 0;
  const reason = String(record.terminationReason);
  const pageClause =
    pages.length > 0
      ? `, leaving ${count(pages.length)} of ${plural(targetPaths.length, "target page")} without page support of its own`
      : "";
  const ending =
    reason === "no-progress" && rounds <= 1 ? NO_EXPANSION_ENDING : GAP_ENDINGS[reason];
  // Every obligation can be supported while a target page has no support of its
  // own: then no obligation is unsupported, and the pass did not end on one.
  const first =
    open.length > 0
      ? `with ${plural(open.length, "mandatory obligation")} its repository evidence did not support${pageClause}. It ended ${reason}: ${ending ?? "obligations were still open"}. The run used the evidence first pass gathered; to give an obligation its evidence, name its source by path in the request or with --source <path>.`
      : `with every mandatory obligation supported${pageClause}. The run used the evidence first pass gathered; to give a page its own support, name its source by path in the request or with --source <path>.`;
  const lines = [
    `${FIRST_PASS_EVIDENCE_GAPS_PREFIX}first pass continued after ${plural(rounds, "assessment round")} ${first}`,
    ...open.map(
      (item) => `${FIRST_PASS_EVIDENCE_GAPS_PREFIX}obligation ${item.id} is ${item.status}.`,
    ),
  ];
  for (const bound of recordedBounds(record.exhaustedBounds)) {
    const raises = firstPassBoundRaises([bound]);
    const share =
      bound.bound === "maxRounds"
        ? " Each round reads an even share of DOCSFAB_FIRST_PASS_MAX_SOURCE_FILES, so raise both."
        : "";
    const window = boundLimitNames(bound).includes(WINDOW_SHARE_LIMIT)
      ? " A model profile with a larger input window also holds a larger assessment prompt."
      : "";
    lines.push(
      `${FIRST_PASS_EVIDENCE_GAPS_PREFIX}${exhaustedBoundPhrase(bound)}.${raises ? ` To read more, raise ${raises}.` : ""}${share}${window}`,
    );
  }
  const unread = record.unreadFiles;
  if (unread && Number.isSafeInteger(unread.count) && unread.count > 0) {
    // Each unread path is shown whole, one to a line: the run record keeps a
    // line as written, so no path is clipped or left to a count alone.
    const namedPaths = Array.isArray(unread.namedPaths)
      ? unread.namedPaths.filter((path) => typeof path === "string" && path.length > 0)
      : [];
    const named = namedPaths.length;
    lines.push(
      `${FIRST_PASS_EVIDENCE_GAPS_PREFIX}reading stopped with ${plural(unread.count, "candidate source file")} unread${named > 0 ? `, ${count(named)} of them named by path` : ""}.`,
      ...namedPaths.map(
        (path) =>
          `${FIRST_PASS_EVIDENCE_GAPS_PREFIX}named path ${escapeUndisplayable(path)} was left unread.`,
      ),
    );
  }
  return Object.freeze(lines);
}

export type DocumentationDraftApplicability =
  | "useful-partial"
  | "scaffold-only"
  | "no-useful-deliverable"
  | "cancellation"
  | "execution-failure";

export type OriginalRequestCompletion = "complete" | "incomplete";

export interface DocumentationPartialProjection {
  readonly originalRequestCompletion: OriginalRequestCompletion;
  readonly draftApplicability: DocumentationDraftApplicability;
  readonly locator?: string;
  readonly envelope: Readonly<Record<string, unknown>>;
  readonly unresolvedQuestions: readonly {
    readonly obligationId: string;
    readonly readerTask: string;
    readonly neededSourceOrDecision: string;
  }[];
}

/** One evidence frame read back from an assessment prompt, text verbatim. */
export interface FirstPassEvidenceFrame {
  readonly id: string;
  readonly path: string;
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly fileSha256: string;
  readonly spanSha256: string;
  readonly text: string;
}

/**
 * `parseEvidenceFrames` from the same installed knowledge provider that built
 * the prompt, so framing has one definition. It throws on framing the builder
 * cannot produce; the runtime still checks every span digest itself.
 */
export type FirstPassEvidenceFrameParser = (prompt: string) => readonly FirstPassEvidenceFrame[];

export function createFirstPassSupportModelBridge(input: {
  readonly config: DocsFabConfig;
  readonly repositoryRevision: string;
  /**
   * Loads the knowledge provider's frame parser. Called once, before the first
   * model call of any phase, so a missing parser costs no model spend.
   */
  readonly loadEvidenceFrameParser: () => Promise<FirstPassEvidenceFrameParser>;
  readonly compositionRuntime?: CompositionRunRuntime;
  /** The operator binding the host resolved for this request, when it selects no composition. */
  readonly operatorBinding?: Promise<OperatorExecutionBinding>;
  readonly signal?: AbortSignal;
  /** Provider-bound test seam; production resolves the configured governed connection. */
  readonly connectionFactory?: () => Promise<ModelConnection>;
}): FirstPassSupportModelBridge {
  let lastIdentitySha256: string | undefined;
  let lastAssessmentBindingSha256: string | undefined;
  let modelCalls = 0;
  let modelCallsStarted = 0;
  let modelCallsCompleted = 0;
  let cumulativeInputTokens = 0;
  let cumulativeOutputTokens = 0;
  let lastPromptSha256: string | null = null;
  let lastResponseSha256: string | null = null;
  let connection: Promise<ModelConnection> | undefined;
  let omittedBinding: OperatorExecutionBinding | undefined;
  let evidenceFrameParser: Promise<FirstPassEvidenceFrameParser> | undefined;
  // Sized once, before any model call, from the same configuration the host
  // passes to the knowledge first pass, so both sides count one budget.
  const budget = firstPassModelBudget(input.config);
  const preludeTimeoutMs = firstPassModelDeadlineMs(input.compositionRuntime);
  const timeoutSignal = AbortSignal.timeout(preludeTimeoutMs);
  const signal = input.signal ? AbortSignal.any([input.signal, timeoutSignal]) : timeoutSignal;
  const assertActive = (phase: ReturnType<typeof firstPassModelPhase>) => {
    if (input.signal?.aborted) throw new WorkflowCancelledError();
    if (timeoutSignal.aborted) {
      throw new FirstPassSupportModelCallError(
        phase,
        "model-deadline-exhausted",
        "$model.deadline",
      );
    }
  };
  return Object.freeze({
    call: async (request: FirstPassSupportModelRequest) => {
      const phase = firstPassModelPhase(request.prompt);
      assertActive(phase);
      const profileSource = input.compositionRuntime?.executionProfile ?? input.config.model;
      const maxCumulativeInputTokens =
        budget.maxModelTurns *
        Math.min(profileSource.profile.maxInputTokens, budget.inputTokensPerTurn);
      const maxCumulativeOutputTokens =
        budget.maxModelTurns *
        Math.min(profileSource.profile.maxOutputTokens, budget.outputTokensPerTurn);
      if (modelCalls >= budget.maxModelTurns) {
        throw new FirstPassSupportModelCallError(
          phase,
          "model-turn-budget-exhausted",
          "$model.turnBudget",
        );
      }
      const estimatedInputTokens = estimateTokens(`${request.systemPrompt}\n${request.prompt}`);
      if (cumulativeInputTokens + estimatedInputTokens > maxCumulativeInputTokens) {
        throw new FirstPassSupportModelCallError(
          phase,
          "model-input-budget-exhausted",
          "$model.inputBudget",
        );
      }
      // Loaded before the first model call of any phase, so a provider without
      // a frame parser stops before any model spend. Only the evidence-bearing
      // assessment prompt is bound; obligation phases carry no evidence.
      let loadedParser: FirstPassEvidenceFrameParser;
      try {
        loadedParser = await (evidenceFrameParser ??= input.loadEvidenceFrameParser());
      } catch (error) {
        assertActive(phase);
        throw error;
      }
      assertActive(phase);
      const parseEvidenceFrames = request.prompt.startsWith("Phase:") ? undefined : loadedParser;
      modelCalls += 1;
      let activeConnection: ModelConnection;
      try {
        connection ??=
          input.connectionFactory?.() ??
          resolveFirstPassConnection({ ...input, maxModelTurns: budget.maxModelTurns }).then(
            (resolved) => {
              omittedBinding = resolved.binding;
              return resolved.connection;
            },
          );
        activeConnection = await connection;
      } catch {
        assertActive(phase);
        throw new FirstPassSupportModelCallError(
          phase,
          "model-connection-failed",
          "$model.connection",
        );
      }
      let modelEvidence: ReturnType<typeof createModelEvidence>;
      try {
        modelEvidence = createModelEvidence(profileSource);
      } catch {
        assertActive(phase);
        throw new FirstPassSupportModelCallError(
          phase,
          "model-profile-unavailable",
          "$model.profile",
        );
      }
      assertActive(phase);
      if (!modelEvidence.profile) {
        throw new FirstPassSupportModelCallError(
          phase,
          "model-profile-unavailable",
          "$model.profile",
        );
      }
      const maxTokens = Math.min(request.maxOutputTokens, profileSource.profile.maxOutputTokens);
      if (maxTokens < profileSource.requestPolicy.minimumOutputTokens) {
        throw new FirstPassSupportModelCallError(
          phase,
          "output-policy-limit",
          "$model.requestPolicy",
        );
      }
      lastPromptSha256 = request.promptSha256;
      lastResponseSha256 = null;
      lastIdentitySha256 = undefined;
      modelCallsStarted += 1;
      let response: Awaited<ReturnType<typeof activeConnection.runtime.completeSimple>>;
      try {
        response = await activeConnection.runtime.completeSimple(
          activeConnection.model,
          {
            systemPrompt: request.systemPrompt,
            messages: [{ role: "user", content: request.prompt, timestamp: Date.now() }],
          },
          { maxTokens, maxRetries: 0, signal, timeoutMs: preludeTimeoutMs },
        );
      } catch {
        assertActive(phase);
        throw new FirstPassSupportModelCallError(
          phase,
          "provider-call-failed",
          "$model.connection",
        );
      }
      modelCallsCompleted += 1;
      if (input.signal?.aborted) {
        const lateResponseText = response.content
          .filter((item) => item.type === "text")
          .map((item) => item.text)
          .join("");
        lastResponseSha256 = sha256(lateResponseText);
        throw new WorkflowCancelledError();
      }
      assertActive(phase);
      if (response.stopReason === "error" || response.stopReason === "aborted") {
        throw new FirstPassSupportModelCallError(phase, "provider-stop-reason", "$response");
      }
      const responseText = response.content
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("");
      lastResponseSha256 = sha256(responseText);
      const turnEvidence = activeConnection.turnGovernance?.evidence() ?? [];
      const identity: FirstPassAssessmentIdentity = Object.freeze({
        providerId: modelEvidence.provider,
        modelId: modelEvidence.model,
        profileSha256: modelEvidence.profile.sha256,
        compositionSha256:
          input.compositionRuntime?.bound.composition.compositionSha256 ??
          omittedBinding?.bound?.composition.compositionSha256 ??
          null,
        requestPolicySha256:
          input.compositionRuntime?.bound.composition.requestPolicy?.policySha256 ??
          omittedBinding?.profile.compositionRequestPolicy?.policySha256 ??
          null,
        systemPromptSha256: sha256(request.systemPrompt),
        promptSha256: request.promptSha256,
        procedureSha256: request.procedureSha256,
        responseSha256: sha256(responseText),
        turnEvidenceSha256: sha256(stableJson(turnEvidence)),
      });
      lastIdentitySha256 = sha256(stableJson(identity));
      const usage = response as unknown as {
        usage?: {
          input?: number;
          output?: number;
          inputTokens?: number;
          outputTokens?: number;
          cacheRead?: number;
          cacheWrite?: number;
        };
      };
      const reportedInputTokens = optionalNonnegativeInteger(
        usage.usage?.inputTokens ?? usage.usage?.input,
      );
      const cacheReadTokens = optionalNonnegativeInteger(usage.usage?.cacheRead);
      const cacheWriteTokens = optionalNonnegativeInteger(usage.usage?.cacheWrite);
      const reportedInputComponents = safeTokenSum([
        reportedInputTokens ?? 0,
        cacheReadTokens ?? 0,
        cacheWriteTokens ?? 0,
      ]);
      const inputTokens =
        reportedInputTokens !== undefined &&
        cacheReadTokens !== undefined &&
        cacheWriteTokens !== undefined
          ? reportedInputComponents
          : Math.max(reportedInputComponents, estimatedInputTokens);
      const reportedOutputTokens = optionalNonnegativeInteger(
        usage.usage?.outputTokens ?? usage.usage?.output,
      );
      const outputTokens = reportedOutputTokens ?? estimateTokens(responseText);
      cumulativeInputTokens = safeTokenSum([cumulativeInputTokens, inputTokens]);
      cumulativeOutputTokens = safeTokenSum([cumulativeOutputTokens, outputTokens]);
      if (
        cumulativeInputTokens > maxCumulativeInputTokens ||
        cumulativeOutputTokens > maxCumulativeOutputTokens
      ) {
        throw new FirstPassSupportModelCallError(
          phase,
          "model-cumulative-token-budget-exhausted",
          cumulativeInputTokens > maxCumulativeInputTokens
            ? "$model.inputBudget"
            : "$model.outputBudget",
        );
      }
      // An answer cut at the output bound (finish reason `length`) that is not
      // complete JSON is not a malformed reply; the first pass re-asks with a
      // shorter-answer hint instead of a strict-JSON one.
      if (
        normalizeModelFinishReason(
          response.stopReason,
          (response as { rawStopReason?: unknown }).rawStopReason,
        ) === "length" &&
        !isJsonText(responseText)
      ) {
        throw new FirstPassSupportModelCallError(phase, "response-truncated", "$response");
      }
      if (parseEvidenceFrames) {
        try {
          lastAssessmentBindingSha256 = firstPassAssessmentBindingSha256(
            request.prompt,
            responseText,
            parseEvidenceFrames,
          );
        } catch (error) {
          if (!(error instanceof FirstPassAssessmentBindingError)) throw error;
          throw new FirstPassSupportModelCallError(phase, error.rule, error.location);
        }
      }
      return {
        responseText,
        identity,
        usage: {
          inputTokens,
          outputTokens,
        },
      };
    },
    lastAssessmentIdentitySha256: () => lastIdentitySha256,
    lastAssessmentBindingSha256: () => lastAssessmentBindingSha256,
    failureEvidence: () =>
      Object.freeze({
        modelCallsStarted,
        modelCallsCompleted,
        lastPromptSha256,
        lastResponseSha256,
        lastIdentitySha256: lastIdentitySha256 ?? null,
      }),
  });
}

function isJsonText(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function firstPassModelPhase(prompt: string): "decomposition" | "completeness" | "assessment" {
  if (prompt.startsWith("Phase: obligation-decomposition")) return "decomposition";
  if (prompt.startsWith("Phase: obligation-completeness-audit")) return "completeness";
  return "assessment";
}

async function resolveFirstPassConnection(input: {
  readonly config: DocsFabConfig;
  readonly maxModelTurns: number;
  readonly repositoryRevision: string;
  readonly compositionRuntime?: CompositionRunRuntime;
  readonly operatorBinding?: Promise<OperatorExecutionBinding>;
  readonly signal?: AbortSignal;
}): Promise<{
  readonly connection: ModelConnection;
  readonly binding?: OperatorExecutionBinding;
}> {
  const turnOptions = {
    evidenceIdentity: { repositoryRevision: input.repositoryRevision },
    limits: {
      maxProviderTurns: Math.min(
        input.maxModelTurns,
        input.compositionRuntime?.executionProfile.compositionPolicy?.maxProviderTurns ??
          input.maxModelTurns,
      ),
      maxToolCalls: 1,
      maxCompactions: 0,
    },
  } as const;
  if (input.compositionRuntime) {
    return {
      connection: await input.compositionRuntime.providerConnectionFactory.create(
        {
          profile: input.compositionRuntime.executionProfile,
          credential: input.compositionRuntime.credential,
        },
        turnOptions,
      ),
    };
  }
  const binding = await (input.operatorBinding ?? firstPassOperatorBinding(input.config));
  return {
    connection: await createProviderConnectionFactory({
      routeId: binding.profile.routeId,
      transport: binding.profile.transport,
    }).create({ profile: binding.profile, credential: binding.credential }, turnOptions),
    binding,
  };
}

function estimateTokens(value: string): number {
  return Math.ceil(Buffer.byteLength(value, "utf8") / FIRST_PASS_ESTIMATED_BYTES_PER_TOKEN);
}

export async function validateFirstPassSupport(input: {
  readonly support: unknown;
  readonly firstPassChoices?: readonly import("./run/first-pass-choice-continuation.js").BoundFirstPassChoiceV1[];
  readonly authorityPreference?: RequestIntentV1["authorityPreference"];
  readonly onResolvedContradictions?: (ids: ReadonlySet<string>, lines: readonly string[]) => void;
  readonly workspacePath: string;
  readonly workflow: "create-documentation" | "update-documentation";
  readonly instruction: string;
  readonly revision: string;
  readonly snapshotSha256: string;
  /**
   * The pages first pass bound: the admitted intent's write targets, or those
   * the same installed provider parsed. Support must name exactly these.
   */
  readonly instructionTargetPaths: readonly string[];
  readonly expectedAssessmentIdentitySha256?: string;
  readonly expectedAssessmentBindingSha256?: string;
  /** The request's first-pass model budget; omitted, the widest a host can configure. */
  readonly modelBudget?: FirstPassModelBudget;
  /** The request's first-pass host limits; omitted, the widest a host can configure. */
  readonly hostLimits?: FirstPassHostLimits;
  readonly classifyPartial?: (
    support: unknown,
  ) =>
    | Promise<DocumentationPartialProjection | undefined>
    | DocumentationPartialProjection
    | undefined;
}): Promise<FirstPassDocumentationTargetControl> {
  const root = closed(
    input.support,
    [
      "schemaVersion",
      "kind",
      "workflow",
      "instructionSha256",
      "repositoryRevision",
      "targetPaths",
      "snapshotSha256",
      "assessmentIdentity",
      "assessmentIdentitySha256",
      "limits",
      "cost",
      "terminationReason",
      "repeatabilitySha256",
      "obligations",
      "sourceSpans",
      "supportSha256",
    ],
    ["exhaustedBounds", "unreadFiles", "namedSourceGaps"],
  );
  if (root.schemaVersion !== 1 || root.kind !== SUPPORT_KIND) invalidSupport();
  const targetPaths = decodeTargets(root.targetPaths);
  const instructionSha256 = sha256(input.instruction.normalize("NFC"));
  if (
    root.workflow !== input.workflow ||
    root.instructionSha256 !== instructionSha256 ||
    root.repositoryRevision !== input.revision ||
    root.snapshotSha256 !== input.snapshotSha256 ||
    !/^[a-f0-9]{40,64}$/u.test(input.revision) ||
    !firstPassTargetsMatchInstruction(input.instructionTargetPaths, targetPaths)
  ) {
    bindingMismatch();
  }
  requireSha(root.instructionSha256);
  requireSha(root.snapshotSha256);
  requireSha(root.repeatabilitySha256);
  const identity = decodeIdentity(root.assessmentIdentity);
  const identitySha256 = sha256(stableJson(identity));
  if (
    root.assessmentIdentitySha256 !== identitySha256 ||
    (input.expectedAssessmentIdentitySha256 !== undefined &&
      input.expectedAssessmentIdentitySha256 !== identitySha256)
  ) {
    bindingMismatch();
  }
  const limits = decodeLimits(
    root.limits,
    input.modelBudget ?? firstPassModelBudgetCeiling(),
    input.hostLimits ?? firstPassHostLimitsCeiling(),
  );
  decodeCost(root.cost, limits);
  const exhaustedBounds = decodeExhaustedBounds(root, limits);
  const unreadFiles = decodeUnreadFiles(root, exhaustedBounds);
  const namedSourceGaps = decodeNamedSourceGaps(root);
  const spans = decodeSpans(root.sourceSpans);
  const spanIds = new Set(spans.map((span) => span.id));
  const obligations = decodeObligations(root.obligations, targetPaths, spanIds, input.instruction);
  const assessmentBindingSha256 = supportAssessmentBindingSha256(obligations, spans);
  if (
    input.expectedAssessmentBindingSha256 === undefined ||
    input.expectedAssessmentBindingSha256 !== assessmentBindingSha256
  )
    bindingMismatch();

  const { supportSha256: _supportSha256, ...body } = root;
  if (root.supportSha256 !== sha256(stableJson(body))) invalidSupport();
  const { spanText, fileText } = await verifySourceSpans(input.workspacePath, spans);
  const commentReaders = new Map<string, ReturnType<typeof sourceCommentQuotationReader>>();

  // Resolution is host-only and never rewrites the assessment or support digests.
  const resolvedIds = new Set<string>();
  const discrepancyLines: string[] = [];
  for (const item of obligations) {
    if (item.status !== "contradicted") continue;
    if (input.firstPassChoices?.some((bound) => bound.choice.obligationId === item.id)) continue;
    const lines = resolveVerifiedDiscrepancy(
      item,
      spans,
      spanText,
      fileText,
      commentReaders,
      input.authorityPreference,
      resolvedIds.size + 1,
    );
    if (lines === undefined) continue;
    resolvedIds.add(item.id);
    discrepancyLines.push(...lines);
  }
  for (const bound of input.firstPassChoices ?? []) {
    const item = obligations.find((candidate) => candidate.id === bound.choice.obligationId);
    if (bound.choice.selection === "withhold") {
      throw new FirstPassChoiceContinuationError("ineligible"); // hygiene: ok -- stable typed code; the constructor supplies the operator-safe message.
    }
    const sourceContradiction = bound.source.contradictions.find(
      (entry) => entry.obligationId === bound.choice.obligationId,
    );
    if (!sourceContradiction) {
      throw new FirstPassChoiceContinuationError("tampered"); // hygiene: ok -- stable typed code; the constructor supplies the operator-safe message.
    }
    const offset = bound.source.contradictions
      .slice(0, bound.source.contradictions.indexOf(sourceContradiction))
      .reduce((count, entry) => count + entry.sides.length, 0);
    const selected = sourceContradiction.sides[bound.choice.optionIndex - offset];
    // A fresh model decomposition may replace an opaque obligation ID. Keep the
    // selected excerpt as attributed context, without resolving any new obligation.
    // It must still occur in the same pinned, hash-verified repository bytes.
    const selectedFile = selected && fileText.get(selected.path);
    const selectedLines = selectedFile?.split("\n");
    const selectedText = selectedLines
      ?.slice(selected!.lineStart - 1, selected!.lineEnd)
      .join("\n");
    if (
      !selected ||
      !selectedLines ||
      selected.lineEnd > selectedLines.length ||
      (selected.value !== null && !selectedText?.includes(selected.value)) ||
      (item !== undefined && item.status !== "contradicted")
    ) {
      throw new FirstPassChoiceContinuationError("stale"); // hygiene: ok -- stable typed code; the constructor supplies the operator-safe message.
    }
    const current = item && verifiedContradiction(item, spans, spanText);
    // The offered excerpt stays selected when reassessment adds or omits a scalar.
    // Its obligation, location, pinned source bytes, and any original value must still match.
    if (
      current &&
      (contradictionObligationDigest(current) !==
        contradictionObligationDigest(sourceContradiction) ||
        !current.sides.some(
          (side) =>
            side.path === selected.path &&
            side.lineStart === selected.lineStart &&
            side.lineEnd === selected.lineEnd &&
            (selected.value === null ||
              spans.some(
                (span) =>
                  span.path === side.path &&
                  span.lineStart === side.lineStart &&
                  span.lineEnd === side.lineEnd &&
                  spanText.get(span.id)?.includes(selected.value!),
              )),
        ))
    ) {
      throw new FirstPassChoiceContinuationError("stale"); // hygiene: ok -- stable typed code; the constructor supplies the operator-safe message.
    }
    assertConfinedToolResultCredentialFree(selected);
    if (item) resolvedIds.add(item.id);
    const valueDescription =
      selected.value === null
        ? "with no verified scalar value"
        : `with value ${JSON.stringify(selected.value)}`;
    discrepancyLines.push(
      ...recordableDiscrepancyLines(
        "operator-choice: ",
        `obligation ${JSON.stringify(sourceContradiction.obligationId)} selected ${JSON.stringify(selected.path)} lines ${selected.lineStart}-${selected.lineEnd} ${valueDescription}; attributed operator choice, not verified product truth.`,
      ),
    );
  }
  input.onResolvedContradictions?.(resolvedIds, Object.freeze(discrepancyLines));
  const unresolved = obligations.filter(
    (item) => item.status !== "supported" && !resolvedIds.has(item.id),
  );
  for (const targetPath of pagesWithoutSupport(obligations, targetPaths, resolvedIds)) {
    unresolved.push({
      id: HOST_PAGE_SUPPORT_ID,
      origin: "workflow",
      targetPaths: [targetPath],
      condition: `Substantive repository support is required for ${targetPath}.`,
      requiredSourceSupport: true,
      status: "missing",
      evidenceSpanIds: [],
      detail: "No supported page-specific evidence was retained.",
    });
  }
  const control = () => {
    const controlBody = {
      workflow: input.workflow,
      instructionSha256,
      repositoryRevision: input.revision,
      targetPaths,
    };
    return Object.freeze({
      ...controlBody,
      targetPaths: Object.freeze([...targetPaths]),
      bodySha256: sha256(JSON.stringify(controlBody)),
    });
  };
  const settledTermination =
    root.terminationReason === "unresolved-obligations" &&
    resolvedIds.size > 0 &&
    unresolved.length === 0 &&
    namedSourceGaps.length === 0;
  if ((!settledTermination && root.terminationReason !== "supported") || unresolved.length > 0) {
    // Gaps repository evidence did not close are a limitation of first pass,
    // not a stop (#2113): the run continues with the evidence gathered, and
    // `firstPassEvidenceGapLines` states each gap, how first pass ended, and
    // every bound it reached with the setting that raises it. A source the
    // request names that first pass could not read, and sources that
    // disagree, still stop below: each needs the operator, not more reading.
    if (
      unresolved.length > 0 &&
      namedSourceGaps.length === 0 &&
      unresolved.every((item) => EVIDENCE_GAP_STATUSES.has(item.status))
    ) {
      return control();
    }
    let partial: DocumentationPartialProjection | undefined;
    try {
      partial = await input.classifyPartial?.(input.support);
    } catch {
      partial = undefined;
    }
    const details = unresolved.map((item) => ({
      id: item.id,
      targetPath: item.targetPaths.join(","),
      condition: item.condition,
      status: item.status,
    }));
    // Named sources first pass could not read lead, whatever decided the stop.
    const gapLead = namedSourceGapsSentence(namedSourceGaps);
    const gapAction = namedSourceGaps.length > 0 ? NAMED_SOURCE_GAP_ACTION : "";
    const unread = unreadFilesSentence(unreadFiles);
    // A bound that stopped acquisition is the cause, with its demand and limit.
    if (root.terminationReason === "budget-exhausted" && exhaustedBounds.length > 0) {
      // hygiene: ok -- the typed stop code accompanies a complete operator-facing message.
      throw new FirstPassSupportValidationError(
        "budget-exhausted",
        `${gapLead}${firstPassBoundsMessage(exhaustedBounds)}${unread}`,
        details,
        partial,
        `${gapAction}${firstPassBoundsNextAction(exhaustedBounds)}`,
      );
    }
    // Sources that disagree need a person, not more evidence: one question.
    // A named source first pass could not read, or a bound it reached, is
    // evidence still to gather, so those keep the evidence-gap stop below.
    if (
      namedSourceGaps.length === 0 &&
      exhaustedBounds.length === 0 &&
      contradictionOnly(root.terminationReason, obligations, unresolved)
    ) {
      const contradictions = unresolved
        .filter((item) => item.status === "contradicted")
        .map((item) => verifiedContradiction(item, spans, spanText));
      // hygiene: ok -- the typed stop carries its question data to the run record.
      throw new FirstPassSupportValidationError(
        "contradicted",
        `First-pass sources disagree on ${String(contradictions.length)} mandatory obligation${contradictions.length === 1 ? "" : "s"}; one answer is needed before any step runs.`,
        details,
        partial,
        undefined,
        Object.freeze(contradictions),
      );
    }
    // An evidence gap no bound caused: the bounds it reached are its limitations.
    const limitations =
      exhaustedBounds.length > 0
        ? ` First pass also reached these bounds, which may have left evidence unread: ${exhaustedBounds.map(exhaustedBoundPhrase).join("; ")}.`
        : "";
    const raise =
      exhaustedBounds.length > 0
        ? `To read past its bounds, raise ${firstPassBoundRaises(exhaustedBounds)} in the host configuration. `
        : "";
    // hygiene: ok -- the typed stop code accompanies a complete operator-facing message.
    throw new FirstPassSupportValidationError(
      "insufficient-evidence",
      `${gapLead}First-pass support has unresolved mandatory obligations.${limitations}${unread}`,
      details,
      partial,
      gapAction || raise ? `${gapAction}${raise}`.trim() : undefined,
    );
  }
  return control();
}

/**
 * The bound targets without page support of their own: no supported,
 * evidence-citing, required obligation names that page alone.
 */
function pagesWithoutSupport(
  obligations: readonly {
    readonly id: string;
    readonly status: string;
    readonly requiredSourceSupport: boolean;
    readonly evidenceSpanIds: readonly string[];
    readonly targetPaths: readonly string[];
  }[],
  targetPaths: readonly string[],
  resolvedIds: ReadonlySet<string> = new Set(),
): readonly string[] {
  const supportedTargets = new Set(
    obligations
      .filter(
        (item) =>
          (item.status === "supported" || resolvedIds.has(item.id)) &&
          item.requiredSourceSupport &&
          item.evidenceSpanIds.length > 0 &&
          item.targetPaths.length === 1,
      )
      .flatMap((item) => item.targetPaths),
  );
  return targetPaths.filter((targetPath) => !supportedTargets.has(targetPath));
}

/**
 * The one first-pass write-root check, identical to the knowledge provider's
 * `isFirstPassWriteRoot`: `docs/`, `fern/`, or a directory under one of them,
 * in the page-path alphabet, with no empty, dot-prefixed, `node_modules`, or
 * `vendor` segment, so it stays inside the task-scope documentation class. Under
 * the `narrow` policy, project configuration can only narrow to such a root. A
 * local run widens through {@link isLocalDocumentationRoot}; hosted widening
 * belongs to host-sealed adapter roots (#1603). Both packages run one case table.
 */
export function isFirstPassWriteRoot(root: string): boolean {
  return FIRST_PASS_WRITE_ROOT.test(root);
}

const FIRST_PASS_WRITE_ROOT =
  /^(?:docs|fern)\/(?:(?!(?:node_modules|vendor)\/)[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*$/u;

/**
 * The default documentation write roots, and the hosted ceiling configuration
 * cannot widen; the same roots a local navigation companion may take.
 */
export const DOCUMENTATION_WRITE_ROOTS: readonly string[] = LOCAL_DOCUMENTATION_WRITE_ROOTS;

/**
 * Where a project's `.docsfab.json` `documentationRoots` can lead.
 * - `narrow`: configured roots only narrow `docs/` and `fern/` (Decision 8,
 *   #1594). The default, and the only policy for hosted runs until #1603's
 *   security review.
 * - `local-widen`: a local run may also write under any configured
 *   documentation directory that {@link isLocalDocumentationRoot} admits, such
 *   as Hugo `site/content` or Docusaurus `website/docs`. Owner amendment to
 *   Decision 8, option A (#1914 note 72942914, #1594 note 72942910). Pages
 *   stay Markdown or MDX.
 */
export type DocumentationRootPolicy = "narrow" | "local-widen";

/**
 * A documentation directory a local run may write under when `.docsfab.json`
 * names it: one or more segments, each ending with `/`, in the page-path
 * alphabet. It refuses `.` and `..`, empty and dot-prefixed segments,
 * `node_modules` and `vendor` segments, a bare `packages/`, and the code
 * directories (`app`, `bin`, `build`, `ci`, `cmd`, `config`, `deploy`, `dist`,
 * `internal`, `lib`, `pkg`, `scripts`, `skills`, `spec`, `specs`, `src`,
 * `test`, `tests`, `third_party`), at the top or under `packages/<name>/`, all
 * case-insensitively. The knowledge first pass keeps the same line.
 */
const LOCAL_DOCUMENTATION_ROOT =
  /^(?!(?:app|bin|build|ci|cmd|config|deploy|dist|internal|lib|pkg|scripts|skills|spec|specs|src|test|tests|third_party)\/)(?!packages\/$)(?!packages\/[^/]+\/(?:app|bin|build|ci|cmd|config|deploy|dist|internal|lib|pkg|scripts|skills|spec|specs|src|test|tests|third_party)\/)(?:(?!(?:node_modules|vendor)\/)[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)+$/iu;

/**
 * ASCII only, checked without case folding: under the `iu` flags `[A-Za-z]`
 * also matches U+017F (long s) and U+212A (Kelvin sign).
 */
const ASCII_ROOT = /^[\x00-\x7F]*$/u;

/** Whether a `/`-terminated root is a documentation directory a local run may widen to. */
export function isLocalDocumentationRoot(root: string): boolean {
  return ASCII_ROOT.test(root) && LOCAL_DOCUMENTATION_ROOT.test(root);
}

/** Whether `root` is a write root under `policy`. */
export function isDocumentationWriteRootUnder(
  root: string,
  policy: DocumentationRootPolicy,
): boolean {
  return policy === "local-widen" ? isLocalDocumentationRoot(root) : isFirstPassWriteRoot(root);
}

/**
 * The rule a named page breaks:
 * - `page-path`: not a relative `.md` or `.mdx` path whose segments use only
 *   letters, digits, `.`, `_`, and `-`, with no `.` or `..` segment;
 * - `write-roots`: outside the write roots, `docs/` and `fern/` by default;
 * - `configured-roots`: outside the roots `.docsfab.json` configures;
 * - `protected-path`: in a protected, source, or CI path, or, under a widened
 *   root, in a hidden, third-party, or code directory or an agent instruction
 *   file. A file root breaks it only as a hidden, third-party, source, CI, or
 *   agent instruction file.
 */
export type DocumentationWriteTargetRule =
  | "page-path"
  | "write-roots"
  | "configured-roots"
  | "protected-path";

const PAGE_PATH = /^(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.mdx?$/u;
const RST_UPDATE_PAGE_PATH = /^(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.rst$/u;
const DOT_SEGMENT = /^\.+$/u;

/**
 * Whether `path` is an agent instruction or skill file rather than a
 * documentation page, from the shared list in `AGENT_INSTRUCTION_FILE_NAMES`.
 * `.cursorrules` is not a page at all.
 */
export function isAgentInstructionPage(path: string): boolean {
  return isAgentInstructionFile(path);
}

function underDefaultRoots(path: string): boolean {
  return DOCUMENTATION_WRITE_ROOTS.some((root) => path.startsWith(root));
}

/**
 * The rule a page breaks whatever the roots are, or `undefined`. A page is a
 * Markdown or MDX file. Under `docs/` or `fern/` the task-scope classifier
 * must call it documentation. Anywhere else its directory must be a local
 * documentation directory, the classifier must not call it source or CI, and
 * it must not be an agent instruction file. The sealed proposal-scope grammar
 * uses this; admission adds the roots.
 */
export function documentationPageShapeRule(
  path: string,
): "page-path" | "protected-path" | undefined {
  if (!PAGE_PATH.test(path) || path.split("/").some((segment) => DOT_SEGMENT.test(segment))) {
    return "page-path";
  }
  const pathClass = classifyTaskWritePath(path);
  if (underDefaultRoots(path)) return pathClass === "documentation" ? undefined : "protected-path";
  const directory = path.slice(0, path.lastIndexOf("/") + 1);
  return isLocalDocumentationRoot(directory) &&
    pathClass !== "source" &&
    pathClass !== "ci" &&
    !isAgentInstructionFile(path)
    ? undefined
    : "protected-path";
}

const THIRD_PARTY_SEGMENT = /^(?:node_modules|vendor)$/iu;

/**
 * The rule a tracked file named as a root breaks, or `undefined` when it is a
 * file root: a Markdown or MDX page in the page-path alphabet, with no segment
 * that starts with `.`, no `node_modules` or `vendor` directory, that the
 * task-scope classifier does not call source or CI and that is not an agent
 * instruction file. It skips the documentation-directory check a page under a
 * directory root meets, so `README.md` and `tests/bats/README.md` qualify.
 * Under `narrow` it must also lie under `docs/` or `fern/`.
 */
export function documentationFileRootRule(
  path: string,
  policy: DocumentationRootPolicy,
): DocumentationWriteTargetRule | undefined {
  return documentationTrackedFileRule(path, policy, PAGE_PATH);
}

/** The same protected-file policy for a tracked existing RST update target. */
export function documentationRstUpdatePathRule(
  path: string,
  policy: DocumentationRootPolicy,
): DocumentationWriteTargetRule | undefined {
  return documentationTrackedFileRule(path, policy, RST_UPDATE_PAGE_PATH);
}

function documentationTrackedFileRule(
  path: string,
  policy: DocumentationRootPolicy,
  pagePath: RegExp,
): DocumentationWriteTargetRule | undefined {
  const segments = path.split("/");
  if (!pagePath.test(path) || segments.some((segment) => DOT_SEGMENT.test(segment))) {
    return "page-path";
  }
  if (policy === "narrow" && !underDefaultRoots(path)) return "write-roots";
  const pathClass = classifyTaskWritePath(path);
  return segments.some((segment) => segment.startsWith(".")) ||
    segments.slice(0, -1).some((segment) => THIRD_PARTY_SEGMENT.test(segment)) ||
    pathClass === "source" ||
    pathClass === "ci" ||
    isAgentInstructionFile(path)
    ? "protected-path"
    : undefined;
}

/**
 * The one rule for a page a run may write, shared by proposal-scope admission,
 * plan admission, and the destination check below. `roots` are what
 * `firstPassDocumentationWriteRoots` resolves: directory roots, each ending in
 * `/`, that {@link isDocumentationWriteRootUnder} admits under `policy`, and
 * file roots, without one, each granting exactly that path in that letter
 * case. Under `narrow` the `docs/` and `fern/` ceiling applies whatever
 * `roots` holds.
 */
export function documentationWriteTargetRule(
  path: string,
  roots: readonly string[] = DOCUMENTATION_WRITE_ROOTS,
  policy: DocumentationRootPolicy = "narrow",
): DocumentationWriteTargetRule | undefined {
  // A file root is its own page: it is never a prefix of another path.
  if (roots.some((root) => !root.endsWith("/") && root === path)) {
    return documentationFileRootRule(path, policy);
  }
  const shape = documentationPageShapeRule(path);
  if (shape === "page-path") return shape;
  if (policy === "narrow" && !underDefaultRoots(path)) return "write-roots";
  const directories = roots.filter((root) => root.endsWith("/"));
  if (!withinWriteCeiling(path, directories)) {
    const defaults =
      roots.length === DOCUMENTATION_WRITE_ROOTS.length &&
      DOCUMENTATION_WRITE_ROOTS.every((root) => roots.includes(root));
    return policy === "local-widen" && defaults ? "write-roots" : "configured-roots";
  }
  return shape;
}

/** Why a configured documentation root is not a write root. */
export type DroppedDocumentationRootReason =
  | "outside-write-roots"
  | "segment-characters"
  | "hidden-segment"
  | "third-party-segment"
  | "code-directory"
  | "file-not-a-page"
  | "protected-file";

const DROPPED_ROOT_REASON_TEXT: Readonly<Record<DroppedDocumentationRootReason, string>> = {
  "outside-write-roots": "outside docs/ and fern/",
  "segment-characters": 'a segment uses a character other than a letter, digit, ".", "_", or "-"',
  "hidden-segment": 'a segment starts with "."',
  "third-party-segment": "a node_modules or vendor segment",
  "code-directory": "a code directory",
  "file-not-a-page": "a file that is not a Markdown or MDX page",
  "protected-file": "a hidden, third-party, source, CI, or agent instruction file",
};

const CODE_DIRECTORY =
  /^(?:app|bin|build|ci|cmd|config|deploy|dist|internal|lib|pkg|scripts|skills|spec|specs|src|test|tests|third_party)$/iu;

/**
 * Why a configured root is not a write root under `policy`, or `undefined`
 * when it is one, so a refusal states the rule the root breaks. `file` says
 * the revision tracks the root as a regular file, which the file-root rule
 * judges instead of the directory rule.
 */
export function droppedDocumentationRootReason(
  root: string,
  policy: DocumentationRootPolicy = "narrow",
  file = false,
): DroppedDocumentationRootReason | undefined {
  if (file) {
    const rule = documentationFileRootRule(root, policy);
    return rule === undefined
      ? undefined
      : rule === "page-path"
        ? "file-not-a-page"
        : rule === "write-roots"
          ? "outside-write-roots"
          : "protected-file";
  }
  const withSlash = root.endsWith("/") ? root : `${root}/`;
  if (isDocumentationWriteRootUnder(withSlash, policy)) return undefined;
  const narrow = policy === "narrow";
  if (narrow && !underDefaultRoots(withSlash)) return "outside-write-roots";
  const segments = withSlash.slice(0, -1).split("/");
  const checked = narrow ? segments.slice(1) : segments;
  if (checked.some((segment) => segment.startsWith("."))) return "hidden-segment";
  if (checked.some((segment) => /^(?:node_modules|vendor)$/iu.test(segment))) {
    return "third-party-segment";
  }
  const packages = /^packages$/iu.test(segments[0] ?? "");
  if (
    !narrow &&
    (CODE_DIRECTORY.test(segments[0] ?? "") ||
      (packages && (segments.length === 1 || CODE_DIRECTORY.test(segments[2] ?? ""))))
  ) {
    return "code-directory";
  }
  return "segment-characters";
}

const PLAIN_ROOT_CHARACTER = /^[A-Za-z0-9_./ -]$/u;

/**
 * Configured roots for operator output, each quoted with the rule it breaks
 * under `policy`; `files` are the ones the revision tracks as regular files.
 * Repository content never reaches the terminal raw: any character outside a
 * plain path alphabet, such as a control, bidirectional, or markup character,
 * is shown as an escape like `\u{1b}`.
 */
export function describeDroppedDocumentationRoots(
  roots: readonly string[],
  policy: DocumentationRootPolicy = "narrow",
  files: readonly string[] = [],
): string {
  return roots
    .map((root) => {
      const quoted = [...root]
        .map((character) =>
          PLAIN_ROOT_CHARACTER.test(character)
            ? character
            : `\\u{${(character.codePointAt(0) ?? 0).toString(16)}}`,
        )
        .join("");
      const reason =
        droppedDocumentationRootReason(root, policy, files.includes(root)) ?? "segment-characters";
      return `"${quoted}" (${DROPPED_ROOT_REASON_TEXT[reason]})`;
    })
    .join(", ");
}

/**
 * Support binds exactly the pages first pass bound before it gathered: the
 * admitted intent's write targets, or the named pages the no-intent arm
 * parsed. An empty bound set matches nothing, so a provider that proposes a
 * page of its own is refused however safe that page looks.
 */
function firstPassTargetsMatchInstruction(
  instructionTargets: readonly string[],
  targetPaths: readonly string[],
): boolean {
  return (
    instructionTargets.length > 0 &&
    instructionTargets.length === targetPaths.length &&
    instructionTargets.every((path, index) => path === targetPaths[index])
  );
}

/**
 * Check every span against the working tree and return each span's verified
 * text by id, normalized as its `spanSha256` was: NFC, with `\r\n` and `\r`
 * as `\n`.
 */
async function verifySourceSpans(
  workspacePath: string,
  spans: ReturnType<typeof decodeSpans>,
): Promise<{
  readonly spanText: ReadonlyMap<string, string>;
  readonly fileText: ReadonlyMap<string, string>;
}> {
  const verified = new Map<string, string>();
  const cached = new Map<string, { raw: string; normalizedLines: string[]; digest: string }>();
  for (const span of spans) {
    let file = cached.get(span.path);
    if (!file) {
      await assertRegularPath(workspacePath, span.path);
      let raw: string;
      try {
        raw = await readFile(join(workspacePath, ...span.path.split("/")), "utf8");
      } catch {
        provenanceInvalid();
      }
      file = {
        raw,
        normalizedLines: normalizeSpanText(raw).split("\n"),
        digest: sha256(raw),
      };
      cached.set(span.path, file);
    }
    if (file.digest !== span.fileSha256 || span.lineEnd > file.normalizedLines.length) {
      provenanceInvalid();
    }
    const text = file.normalizedLines.slice(span.lineStart - 1, span.lineEnd).join("\n");
    if (sha256(text) !== span.spanSha256) provenanceInvalid();
    verified.set(span.id, text);
  }
  return {
    spanText: verified,
    fileText: new Map([...cached].map(([path, file]) => [path, normalizeSpanText(file.raw)])),
  };
}

/**
 * Whether the stop is a disagreement between sources and nothing else: first
 * pass ended on unresolved obligations (not a bound and not a round without
 * new evidence), every unresolved obligation is contradicted, and every page
 * left without support has a required contradicted obligation of its own that
 * an answer would turn into that page's support. A missing or unavailable
 * obligation, or a page with no such contradiction, is an evidence gap. A
 * required contradicted obligation over several pages is not a page's own: an
 * answer to it leaves each page still needing single-page support.
 */
function contradictionOnly(
  terminationReason: unknown,
  obligations: ReturnType<typeof decodeObligations>,
  unresolved: readonly { id: string; status: string; targetPaths: readonly string[] }[],
): boolean {
  if (terminationReason !== "unresolved-obligations") return false;
  const pageGaps = unresolved.filter((item) => item.id === HOST_PAGE_SUPPORT_ID);
  const assessed = unresolved.filter((item) => item.id !== HOST_PAGE_SUPPORT_ID);
  if (assessed.length === 0 || assessed.some((item) => item.status !== "contradicted")) {
    return false;
  }
  return pageGaps.every((gap) =>
    obligations.some(
      (item) =>
        item.status === "contradicted" &&
        item.requiredSourceSupport &&
        item.targetPaths.length === 1 &&
        item.targetPaths[0] === gap.targetPaths[0],
    ),
  );
}

/**
 * A contradicted obligation with its sides as the host verified them. Sides
 * with a value keep it only when every value is found verbatim in its own
 * verified span text; otherwise, or without sides, each cited span becomes a
 * side with no value, so the question names paths and lines but no value the
 * model could have invented.
 */
/** An opaque ID and matching span cannot authorize a different obligation definition. */
function contradictionObligationDigest(
  value: Pick<FirstPassContradictionV1, "obligationId" | "condition" | "targetPaths">,
): string {
  return canonicalDigest({
    obligationId: value.obligationId,
    condition: value.condition,
    targetPaths: value.targetPaths,
  });
}

function verifiedContradiction(
  item: ReturnType<typeof decodeObligations>[number],
  spans: ReturnType<typeof decodeSpans>,
  spanText: ReadonlyMap<string, string>,
): FirstPassContradictionV1 {
  const byId = new Map(spans.map((span) => [span.id, span]));
  const located = (spanId: string, value: string | null): FirstPassContradictionSideV1 => {
    const span = byId.get(spanId)!;
    return { path: span.path, lineStart: span.lineStart, lineEnd: span.lineEnd, value };
  };
  const valued = item.sides?.every((side) =>
    (spanText.get(side.spanId) ?? "").includes(normalizeSpanText(side.value)),
  )
    ? item.sides.map((side) => located(side.spanId, normalizeSpanText(side.value)))
    : undefined;
  return {
    obligationId: item.id,
    targetPaths: [...item.targetPaths],
    condition: item.condition,
    sides: valued ?? item.evidenceSpanIds.map((spanId) => located(spanId, null)),
  };
}

/** Classify evidence roles conservatively; an unfamiliar source is never implementation. */
function discrepancySourceRole(path: string): "documentation" | "implementation" | "unknown" {
  if (/(?:^|\/)(?:planning|plans?|design|tickets?|issues?|status)(?:\/|[.-]|$)/iu.test(path))
    return "unknown";
  if (
    /\.(?:md|mdx|rst|adoc|asciidoc|txt|text|html?|xhtml|textile)$/iu.test(path) ||
    /(?:^|\/)readme(?:\.[^/]*)?$/iu.test(path)
  )
    return "documentation";
  if (
    /\.(?:[cm]?[jt]sx?|py|go|rs|c|cc|cpp|cxx|h|hpp|java|kt|kts|rb|php|swift|scala|sh|bash|zsh|ps1|cs|fs|ex|exs|erl|hs|lua|pl|r|sql)$/iu.test(
      path,
    )
  )
    return "implementation";
  if (
    /(?:^|\/)(?:Dockerfile(?:[.-][^/]*)?|(?:docker-)?compose\.ya?ml|(?:deploy|deployment|config|settings|server|application|runtime)(?:[.-][^/]*)?\.(?:ya?ml|json|toml|ini|conf))$/iu.test(
      path,
    ) ||
    /(?:^|\/)(?:config|deploy|deployment|k8s|kubernetes|helm)\/.*\.(?:ya?ml|json|toml|ini|conf)$/iu.test(
      path,
    )
  )
    return "implementation";
  return "unknown";
}

function resolveVerifiedDiscrepancy(
  item: ReturnType<typeof decodeObligations>[number],
  spans: ReturnType<typeof decodeSpans>,
  spanText: ReadonlyMap<string, string>,
  fileText: ReadonlyMap<string, string>,
  commentReaders: Map<string, ReturnType<typeof sourceCommentQuotationReader>>,
  authority: RequestIntentV1["authorityPreference"] | undefined,
  discrepancyNumber: number,
): readonly string[] | undefined {
  if (!item.sides) return undefined;
  const roleFor = (side: FirstPassContradictionSideV1) => {
    let role = discrepancySourceRole(side.path);
    if (role === "implementation") {
      let reader = commentReaders.get(side.path);
      if (!reader) {
        reader = sourceCommentQuotationReader(side.path, fileText.get(side.path)!);
        commentReaders.set(side.path, reader);
      }
      if (reader(side)) role = "documentation";
    }
    return role;
  };
  const supporting = item.evidenceSpanIds
    .filter((id) => !item.sides!.some((side) => side.spanId === id))
    .map((id) => {
      const span = spans.find((entry) => entry.id === id)!;
      return {
        ...span,
        role: roleFor({
          path: span.path,
          lineStart: span.lineStart,
          lineEnd: span.lineEnd,
          value: spanText.get(span.id) ?? null,
        }),
      };
    });
  // A citation can support the page without asserting a disputed value. Unknown
  // or unvalued implementation authorities still need positive corroboration.
  if (supporting.some((span) => span.role === "unknown")) return undefined;
  const verified = verifiedContradiction(item, spans, spanText);
  if (verified.sides.some((side) => side.value === null)) return undefined;
  const classified = verified.sides.map((side) => ({ ...side, role: roleFor(side) }));
  if (classified.some((side) => side.role === "unknown")) return undefined;
  const docs = classified.filter((side) => side.role === "documentation");
  const implementation = classified.filter((side) => side.role === "implementation");
  const corroboratedFiles = new Set<string>();
  const citedText = (side: FirstPassContradictionSideV1) =>
    spans
      .filter(
        (span) =>
          span.path === side.path &&
          span.lineStart === side.lineStart &&
          span.lineEnd === side.lineEnd,
      )
      .map((span) => spanText.get(span.id) ?? "")
      .join("\n");
  const documentedBinding = commonDocumentedBinding(
    docs.map((side) => ({ value: side.value!, text: citedText(side) })),
  );
  let corroboratedJsonKey: string | undefined;
  const jsonExamples = docs.map((side) => {
    try {
      const direct: unknown = JSON.parse(side.value!.startsWith("{") ? side.value! : "null");
      const examples =
        direct !== null
          ? [direct]
          : [...citedText(side).matchAll(/(?<!`)`([^`\r\n]+)`(?!`)/gu)].flatMap((match) => {
              try {
                const parsed: unknown = JSON.parse(match[1]!);
                return parsed &&
                  typeof parsed === "object" &&
                  !Array.isArray(parsed) &&
                  Object.keys(parsed).length === 1 &&
                  Object.hasOwn(parsed, side.value!)
                  ? [parsed]
                  : [];
              } catch {
                return [];
              }
            });
      if (examples.length !== 1) return undefined;
      const value = examples[0];
      if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
      const entries = Object.entries(value);
      return entries.length === 1
        ? { key: entries[0]![0], payload: canonicalDigest(entries[0]![1]) }
        : undefined;
    } catch {
      return undefined;
    }
  });
  const comparableJson =
    jsonExamples.every((value) => value !== undefined) &&
    new Set(jsonExamples.map((value) => value!.payload)).size === 1 &&
    new Set(jsonExamples.map((value) => value!.key)).size > 1;
  // A model can cite only the disagreeing docs even though both link to the same
  // already-read implementation. Corroborate its runtime value without inventing
  // a scalar, executing code, or treating an unrelated literal as authority.
  if (docs.length === classified.length) {
    if (!comparableJson && !documentedBinding) return undefined;
    const linked = docs.map(
      (side) =>
        new Set(
          documentationMarkdownLinkTargets(fileText.get(side.path) ?? "").flatMap((target) => {
            const path = posix.normalize(
              posix.join(posix.dirname(side.path), target.split(/[?#]/u)[0]!),
            );
            return fileText.has(path) && discrepancySourceRole(path) === "implementation"
              ? [path]
              : [];
          }),
        ),
    );
    const common = linked[0]!;
    for (const paths of linked.slice(1))
      for (const path of common) if (!paths.has(path)) common.delete(path);
    for (const path of common) {
      const source = fileText.get(path)!;
      const before = implementation.length;
      for (const value of new Set(
        comparableJson
          ? jsonExamples.map((example) => example!.key)
          : docs.map((side) => side.value!),
      )) {
        const location = findExecutableEvidenceValue({
          source,
          ...(comparableJson
            ? { identifierRole: "json-key" as const }
            : { documentedBinding: documentedBinding! }),
          side: { path, lineStart: 1, lineEnd: source.split("\n").length, value },
        });
        if (location) {
          implementation.push({ path, ...location, value, role: "implementation" });
          corroboratedFiles.add(path);
          if (comparableJson) corroboratedJsonKey = value;
        }
      }
      if (implementation.length === before) return undefined;
    }
    classified.push(...implementation);
  }
  if (
    supporting.some(
      (span) =>
        span.role === "implementation" &&
        !implementation.some(
          (side) =>
            side.path === span.path &&
            ((side.lineStart >= span.lineStart && side.lineEnd <= span.lineEnd) ||
              corroboratedFiles.has(span.path)),
        ),
    )
  )
    return undefined;
  const implementationValues = new Set(implementation.map((side) => side.value));
  if (docs.length === 0 || implementationValues.size !== 1) return undefined;
  const preference = authority?.preference ?? "unspecified";
  const selected = preference === "documentation" ? docs : implementation;
  if (preference === "documentation" && new Set(docs.map((side) => side.value)).size !== 1)
    return undefined;
  const value = selected[0]!.value!;
  if (classified.every((side) => side.value === value)) return undefined;
  const prefix = preference === "documentation" ? "documentation-preference: " : "docs-stale: ";
  const origin =
    preference === "unspecified" ? "implementation default" : `${preference} preference`;
  const fields = [
    `obligation ${JSON.stringify(item.id)}; ${preference === "documentation" ? "documentation preference; implementation differs" : "documentation differs from implementation"}; verification needed.`,
    corroboratedJsonKey && preference !== "documentation"
      ? `chosen authority: ${origin}; corroborated JSON property: ${JSON.stringify(corroboratedJsonKey)}; example payload is not verified product truth.`
      : `chosen authority: ${origin}; chosen value: ${JSON.stringify(value)}.`,
    ...(authority?.quote ? [`admitted preference quote: ${JSON.stringify(authority.quote)}.`] : []),
    ...classified.flatMap((side, index) => [
      `source ${index + 1} (${side.role}) path: ${JSON.stringify(side.path)}; lines ${side.lineStart}-${side.lineEnd}.`,
      `source ${index + 1} value: ${JSON.stringify(side.value)}.`,
    ]),
    ...supporting.map(
      (span) =>
        `supporting citation (${span.role}) path: ${JSON.stringify(span.path)}; lines ${span.lineStart}-${span.lineEnd}; no disputed value asserted.`,
    ),
  ];
  return fields.flatMap((field, index) =>
    recordableDiscrepancyLines(
      `${prefix}discrepancy ${discrepancyNumber}, detail ${index + 1}: `,
      field,
    ),
  );
}

/** Corroboration needs a declared code identity or an actual CLI option/default relationship. */
function commonDocumentedBinding(
  sides: readonly { value: string; text: string }[],
): DocumentedEvidenceBinding | undefined {
  const choices = sides.map(({ value, text }) => {
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const bindings: DocumentedEvidenceBinding[] = [];
    const defaults = new RegExp(
      String.raw`\bdefault\s+([A-Za-z_$][\w$-]*)\s+is\s+\x60?` + escaped + String.raw`(?:\x60|\b)`,
      "giu",
    );
    for (const match of text.matchAll(defaults)) {
      const flag = `--${match[1]}`;
      if (text.includes(flag)) bindings.push({ kind: "cli-default", flag });
    }
    const exports = new RegExp(
      String.raw`\x60([A-Za-z_$][\w$]*)\x60\s+export\s+is\s+\x60?` +
        escaped +
        String.raw`(?:\x60|\b)`,
      "gu",
    );
    for (const match of text.matchAll(exports))
      bindings.push({ kind: "exported-constant", name: match[1]! });
    return new Map(bindings.map((binding) => [JSON.stringify(binding), binding]));
  });
  const common = choices[0];
  if (!common) return undefined;
  for (const choice of choices.slice(1))
    for (const key of common.keys()) if (!choice.has(key)) common.delete(key);
  return common.size === 1 ? [...common.values()][0] : undefined;
}

/** Split by the record's own predicate, preserving escaped text without clipping. */
function recordableDiscrepancyLines(prefix: string, field: string): string[] {
  const escaped = escapeUndisplayable(field);
  if (isRecordableEvidenceWarning(prefix + escaped)) return [prefix + escaped];
  const lines: string[] = [];
  let fragment = "";
  const lead = () => `${prefix}part ${lines.length + 1}: `;
  for (const character of escaped) {
    if (!isRecordableEvidenceWarning(lead() + fragment + character)) {
      lines.push(lead() + fragment);
      fragment = "";
    }
    fragment += character;
  }
  if (fragment) lines.push(lead() + fragment);
  return lines;
}

/** Text as a span's `spanSha256` reads it: NFC, `\r\n` and `\r` as `\n`. */
function normalizeSpanText(value: string): string {
  return value.normalize("NFC").replace(/\r\n?/gu, "\n");
}

async function assertRegularPath(workspacePath: string, path: string): Promise<void> {
  let current = workspacePath;
  const segments = path.split("/");
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    let metadata;
    try {
      metadata = await lstat(current);
    } catch {
      provenanceInvalid();
    }
    if (metadata.isSymbolicLink()) provenanceInvalid();
    const leaf = index === segments.length - 1;
    if ((leaf && !metadata.isFile()) || (!leaf && !metadata.isDirectory())) provenanceInvalid();
  }
}

function decodeIdentity(value: unknown): FirstPassAssessmentIdentity {
  const root = closed(value, [
    "providerId",
    "modelId",
    "profileSha256",
    "compositionSha256",
    "requestPolicySha256",
    "systemPromptSha256",
    "promptSha256",
    "procedureSha256",
    "responseSha256",
    "turnEvidenceSha256",
  ]);
  if (
    typeof root.providerId !== "string" ||
    !root.providerId ||
    typeof root.modelId !== "string" ||
    !root.modelId
  )
    invalidSupport();
  for (const key of [
    "profileSha256",
    "systemPromptSha256",
    "promptSha256",
    "procedureSha256",
    "responseSha256",
    "turnEvidenceSha256",
  ])
    requireSha(root[key]);
  for (const key of ["compositionSha256", "requestPolicySha256"]) {
    if (root[key] !== null) requireSha(root[key]);
  }
  return root as unknown as FirstPassAssessmentIdentity;
}

function decodeLimits(
  value: unknown,
  budget: FirstPassModelBudget,
  hostLimits: FirstPassHostLimits,
) {
  const root = closed(value, [
    "maxRounds",
    "maxScannedFiles",
    "maxSourceFiles",
    "maxFileBytes",
    "maxTotalReadBytes",
    "maxSpans",
    "maxPresentedBytes",
    "maxModelTurns",
    "maxResponseTokens",
    "maxCumulativeInputTokens",
    "maxCumulativeOutputTokens",
    "modelDeadlineMs",
    "readDeadlineMs",
  ]);
  for (const value of Object.values(root)) positiveInteger(value);
  // A record can never carry a wider bound than the request's host granted.
  if (
    Number(root.maxRounds) > 1 + budget.evidenceExpansionModelTurns ||
    Number(root.maxModelTurns) > budget.maxModelTurns ||
    Number(root.maxResponseTokens) > budget.outputTokensPerTurn ||
    Number(root.maxCumulativeInputTokens) > budget.maxCumulativeInputTokens ||
    Number(root.maxCumulativeOutputTokens) > budget.maxCumulativeOutputTokens ||
    (Object.keys(hostLimits) as (keyof FirstPassHostLimits)[]).some(
      (key) => Number(root[key]) > hostLimits[key],
    )
  )
    invalidSupport();
  return root;
}

function decodeCost(value: unknown, limits: Record<string, unknown>): void {
  const root = closed(value, [
    "scannedFiles",
    "sourceFiles",
    "readBytes",
    "presentedBytes",
    "spans",
    "rounds",
    "modelTurns",
    "inputTokens",
    "outputTokens",
  ]);
  for (const item of Object.values(root)) nonnegative(item);
  for (const [costKey, limitKey] of [
    ["scannedFiles", "maxScannedFiles"],
    ["sourceFiles", "maxSourceFiles"],
    ["readBytes", "maxTotalReadBytes"],
    ["presentedBytes", "maxPresentedBytes"],
    ["spans", "maxSpans"],
    ["rounds", "maxRounds"],
    ["modelTurns", "maxModelTurns"],
    ["inputTokens", "maxCumulativeInputTokens"],
    ["outputTokens", "maxCumulativeOutputTokens"],
  ] as const) {
    if (Number(root[costKey]) > Number(limits[limitKey])) invalidSupport();
  }
}

function decodeTargets(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.some(
      (path) =>
        typeof path !== "string" ||
        !SAFE_UPDATE_TARGET.test(path) ||
        posix.normalize(path) !== path,
    )
  )
    invalidSupport();
  const paths = value as string[];
  if (
    new Set(paths).size !== paths.length ||
    [...paths].sort(compareText).some((path, index) => path !== paths[index])
  )
    invalidSupport();
  return [...paths];
}

function decodeSpans(value: unknown) {
  if (!Array.isArray(value) || value.length === 0) invalidSupport();
  const ids = new Set<string>();
  return value.map((item) => {
    const root = closed(item, ["id", "path", "lineStart", "lineEnd", "fileSha256", "spanSha256"]);
    if (typeof root.id !== "string" || !/^SPAN-\d{3,}$/u.test(root.id) || ids.has(root.id))
      invalidSupport();
    if (typeof root.path !== "string" || !isSafeEvidencePath(root.path)) invalidSupport();
    positiveInteger(root.lineStart);
    positiveInteger(root.lineEnd);
    if (Number(root.lineEnd) < Number(root.lineStart)) invalidSupport();
    requireSha(root.fileSha256);
    requireSha(root.spanSha256);
    ids.add(root.id);
    return {
      id: root.id,
      path: root.path,
      lineStart: Number(root.lineStart),
      lineEnd: Number(root.lineEnd),
      fileSha256: root.fileSha256 as string,
      spanSha256: root.spanSha256 as string,
    };
  });
}

function decodeObligations(
  value: unknown,
  targetPaths: readonly string[],
  spanIds: ReadonlySet<string>,
  instruction: string,
) {
  if (!Array.isArray(value) || value.length < targetPaths.length) invalidSupport();
  const ids = new Set<string>();
  const maxConditionChars = limit("firstPass.maxObligationConditionChars").value;
  return value.map((item) => {
    const raw = item as Record<string, unknown>;
    const keys = [
      "id",
      "origin",
      ...(raw?.instructionSpan === undefined ? [] : ["instructionSpan"]),
      "targetPaths",
      "condition",
      "requiredSourceSupport",
      "status",
      "evidenceSpanIds",
      "detail",
      ...(raw?.sides === undefined ? [] : ["sides"]),
    ];
    const root = closed(item, keys);
    if (typeof root.id !== "string" || !root.id || ids.has(root.id)) invalidSupport();
    if (!["explicit", "workflow", "inferred"].includes(String(root.origin))) invalidSupport();
    if (
      !Array.isArray(root.targetPaths) ||
      root.targetPaths.length === 0 ||
      root.targetPaths.some((path) => !targetPaths.includes(path as string))
    )
      invalidSupport();
    if (
      typeof root.condition !== "string" ||
      !root.condition.trim() ||
      root.condition.length > maxConditionChars
    )
      invalidSupport();
    if (typeof root.requiredSourceSupport !== "boolean" || !STATUSES.has(String(root.status)))
      invalidSupport();
    if (
      !Array.isArray(root.evidenceSpanIds) ||
      new Set(root.evidenceSpanIds).size !== root.evidenceSpanIds.length ||
      root.evidenceSpanIds.some((id) => !spanIds.has(id as string))
    )
      invalidSupport();
    if (
      root.requiredSourceSupport === true &&
      root.status === "supported" &&
      root.evidenceSpanIds.length === 0
    )
      invalidSupport();
    if (typeof root.detail !== "string" || root.detail.length > 1000) invalidSupport();
    const sides =
      root.sides === undefined
        ? undefined
        : decodeContradictionSides(root.sides, root.status, root.evidenceSpanIds as string[]);
    if (root.origin === "explicit") {
      const span = closed(root.instructionSpan, ["start", "end"]);
      nonnegative(span.start);
      positiveInteger(span.end);
      if (
        Number(span.end) <= Number(span.start) ||
        Number(span.end) > instruction.length ||
        instruction.slice(Number(span.start), Number(span.end)) !== root.condition
      )
        invalidSupport();
    } else if (root.instructionSpan !== undefined) invalidSupport();
    ids.add(root.id);
    return {
      ...(root as unknown as {
        id: string;
        origin: string;
        targetPaths: string[];
        condition: string;
        requiredSourceSupport: boolean;
        status: string;
        evidenceSpanIds: string[];
        detail: string;
      }),
      ...(sides === undefined ? {} : { sides }),
    };
  });
}

/**
 * The sides of a contradicted obligation, as the assessment wrote them: each
 * cites one of that obligation's own evidence spans and carries a non-empty
 * value within `firstPass.maxContradictionValueChars`, with between two and
 * `firstPass.maxContradictionSides` sides and at least two distinct values.
 * Whether each value is in its span is checked after the spans verify.
 */
function decodeContradictionSides(
  value: unknown,
  status: unknown,
  evidenceSpanIds: readonly string[],
): { spanId: string; value: string }[] {
  if (
    status !== "contradicted" ||
    !Array.isArray(value) ||
    value.length > limit("firstPass.maxContradictionSides").value
  )
    invalidSupport();
  const maxChars = limit("firstPass.maxContradictionValueChars").value;
  const sides = value.map((entry) => {
    const side = closed(entry, ["spanId", "value"]);
    if (
      typeof side.spanId !== "string" ||
      !evidenceSpanIds.includes(side.spanId) ||
      typeof side.value !== "string" ||
      side.value.trim() === "" ||
      side.value.length > maxChars
    )
      invalidSupport();
    return { spanId: side.spanId, value: side.value };
  });
  // A contradiction is sides that do not all agree, so two at the least,
  // compared as the question shows them.
  if (new Set(sides.map((side) => normalizeSpanText(side.value))).size < 2) invalidSupport();
  return sides;
}

function obligationBase(item: Record<string, unknown>): Record<string, unknown> {
  return {
    id: item.id as string,
    origin: item.origin as string,
    ...(item.instructionSpan === undefined
      ? {}
      : {
          instructionSpan: item.instructionSpan as { readonly start: number; readonly end: number },
        }),
    targetPaths: item.targetPaths as string[],
    condition: item.condition as string,
    requiredSourceSupport: item.requiredSourceSupport as boolean,
  };
}

function supportAssessmentBindingSha256(
  obligations: ReturnType<typeof decodeObligations>,
  spans: ReturnType<typeof decodeSpans>,
): string {
  return sha256(
    stableJson({
      obligations: obligations.map(obligationBase),
      // Every key the assessment row carried, so the model's answer and this
      // record bind the same sides.
      assessments: obligations.map((item) => ({
        obligationId: item.id,
        status: item.status,
        evidenceSpanIds: item.evidenceSpanIds,
        detail: item.detail,
        ...(item.sides === undefined ? {} : { sides: item.sides }),
      })),
      sourceSpans: spans,
    }),
  );
}

export function firstPassAssessmentBindingSha256(
  prompt: string,
  responseText: string,
  parseEvidenceFrames: FirstPassEvidenceFrameParser,
): string {
  const mandatoryLine = prompt
    .split("\n")
    .find((line) => line.startsWith("Mandatory obligations: "));
  if (!mandatoryLine) {
    throw new FirstPassAssessmentBindingError(
      "The first-pass assessment prompt omitted mandatory obligation rows.",
      "assessment-binding-prompt-shape",
      "$prompt.mandatoryObligations",
    );
  }
  let obligations: unknown;
  try {
    obligations = JSON.parse(mandatoryLine.slice("Mandatory obligations: ".length));
  } catch {
    throw new FirstPassAssessmentBindingError(
      "The first-pass assessment prompt has invalid mandatory obligation rows.",
      "assessment-binding-prompt-shape",
      "$prompt.mandatoryObligations",
    );
  }
  if (!Array.isArray(obligations)) {
    throw new FirstPassAssessmentBindingError(
      "The first-pass assessment prompt has invalid mandatory obligation rows.",
      "assessment-binding-prompt-shape",
      "$prompt.mandatoryObligations",
    );
  }
  // Frame boundaries carry a per-prompt nonce the repository cannot contain, so
  // repository text can neither close a span early nor open a forged one.
  let frames: readonly FirstPassEvidenceFrame[];
  try {
    frames = parseEvidenceFrames(prompt);
  } catch {
    throw new FirstPassAssessmentBindingError(
      "The first-pass assessment prompt has malformed evidence frames.",
      "assessment-binding-prompt-shape",
      "$repository",
    );
  }
  if (!Array.isArray(frames) || !frames.every(isEvidenceFrame)) {
    throw new FirstPassAssessmentBindingError(
      "The first-pass assessment prompt has malformed evidence frames.",
      "assessment-binding-prompt-shape",
      "$repository",
    );
  }
  const sourceSpans = frames.map((frame) => {
    if (sha256(frame.text) !== frame.spanSha256) {
      throw new FirstPassAssessmentBindingError(
        "The first-pass assessment prompt has invalid source span provenance.",
        "assessment-binding-provenance",
        "$repository",
      );
    }
    return {
      id: frame.id,
      path: frame.path,
      lineStart: frame.lineStart,
      lineEnd: frame.lineEnd,
      fileSha256: frame.fileSha256,
      spanSha256: frame.spanSha256,
    };
  });
  if (sourceSpans.length === 0) {
    throw new FirstPassAssessmentBindingError(
      "The first-pass assessment prompt omitted required source evidence spans.",
      "assessment-binding-source-spans",
      "$repository",
    );
  }
  // DocsFab built everything above; the model built the answer. Prompt-owned
  // checks run first, so a host defect is never reported as a model-correctable
  // answer defect and never spends a correction round.
  let response: unknown;
  try {
    response = JSON.parse(responseText);
  } catch {
    throw new FirstPassAssessmentBindingError(
      "The first-pass assessment response is not valid strict JSON.",
      "assessment-binding-response-json",
      "$response",
    );
  }
  if (!response || typeof response !== "object") {
    throw new FirstPassAssessmentBindingError(
      "The first-pass assessment response has an invalid object shape.",
      "assessment-binding-response-shape",
      "$response",
    );
  }
  const assessments = (response as { assessments?: unknown }).assessments;
  if (!Array.isArray(assessments)) {
    throw new FirstPassAssessmentBindingError(
      "The first-pass assessment response omitted its required assessment rows.",
      "assessment-binding-response-rows",
      "$response.assessments",
    );
  }
  return sha256(stableJson({ obligations, assessments, sourceSpans }));
}

function isEvidenceFrame(value: unknown): value is FirstPassEvidenceFrame {
  if (!value || typeof value !== "object") return false;
  const frame = value as Record<string, unknown>;
  return (
    typeof frame.id === "string" &&
    /^SPAN-\d+$/u.test(frame.id) &&
    typeof frame.path === "string" &&
    Number.isSafeInteger(frame.lineStart) &&
    Number.isSafeInteger(frame.lineEnd) &&
    typeof frame.fileSha256 === "string" &&
    /^[a-f0-9]{64}$/u.test(frame.fileSha256) &&
    typeof frame.spanSha256 === "string" &&
    /^[a-f0-9]{64}$/u.test(frame.spanSha256) &&
    typeof frame.text === "string"
  );
}

class FirstPassAssessmentBindingError extends Error {
  public readonly name = "FirstPassAssessmentBindingError";

  public constructor(
    message: string,
    public readonly rule:
      | "assessment-binding-prompt-shape"
      | "assessment-binding-provenance"
      | "assessment-binding-response-json"
      | "assessment-binding-response-rows"
      | "assessment-binding-response-shape"
      | "assessment-binding-source-spans",
    public readonly location:
      | "$prompt.mandatoryObligations"
      | "$repository"
      | "$response"
      | "$response.assessments",
  ) {
    super(message);
  }
}

function isSafeEvidencePath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 512 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.split("/").some((segment) => segment === "" || segment === "." || segment === "..") &&
    posix.normalize(path) === path
  );
}

function closed(
  value: unknown,
  keys: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalidSupport();
  const root = value as Record<string, unknown>;
  const required = [...keys, ...optional.filter((key) => Object.hasOwn(root, key))];
  if (Object.keys(root).sort(compareText).join("|") !== required.sort(compareText).join("|"))
    invalidSupport();
  return root;
}

/** The termination reasons the knowledge first pass records. */
const TERMINATION_REASONS = new Set([
  "supported",
  "budget-exhausted",
  "unresolved-obligations",
  "no-progress",
]);

/**
 * The bounds a record names: the cause of a budget-exhausted stop, or the
 * limitations of a supported first pass or of an evidence gap no bound
 * caused. Each is a first-pass bound of this record, its limit matches the
 * record's, and its demand is over it.
 */
function decodeExhaustedBounds(
  root: Record<string, unknown>,
  limits: Record<string, unknown>,
): readonly FirstPassExhaustedBound[] {
  if (!Object.hasOwn(root, "exhaustedBounds")) return [];
  const value = root.exhaustedBounds;
  if (
    !TERMINATION_REASONS.has(String(root.terminationReason)) ||
    !Array.isArray(value) ||
    value.length === 0
  )
    invalidSupport();
  const seen = new Set<string>();
  return value.map((item) => {
    const entry = closed(item, ["bound", "observed", "limit"]);
    const bound = entry.bound;
    if (
      typeof bound !== "string" ||
      !Object.hasOwn(FIRST_PASS_ACQUISITION_BOUNDS, bound) ||
      seen.has(bound) ||
      !Number.isSafeInteger(entry.limit) ||
      entry.limit !== limits[bound] ||
      !Number.isSafeInteger(entry.observed) ||
      Number(entry.observed) <= Number(entry.limit)
    )
      invalidSupport();
    seen.add(bound);
    return {
      bound: bound as FirstPassAcquisitionBound,
      observed: Number(entry.observed),
      limit: Number(entry.limit),
    };
  });
}

/**
 * The candidate source files a bound left unread. Only a record that names an exhausted
 * bound can carry them; the named ones are distinct, sorted, and no more than
 * the count.
 */
function decodeUnreadFiles(
  root: Record<string, unknown>,
  exhaustedBounds: readonly FirstPassExhaustedBound[],
): FirstPassUnreadFiles | undefined {
  if (!Object.hasOwn(root, "unreadFiles")) return undefined;
  if (exhaustedBounds.length === 0) invalidSupport();
  const entry = closed(root.unreadFiles, ["count", "namedPaths"]);
  positiveInteger(entry.count);
  const namedPaths = decodeSortedPaths(entry.namedPaths);
  if (namedPaths.length > Number(entry.count)) invalidSupport();
  return { count: Number(entry.count), namedPaths };
}

/** Named sources first pass could not offer, one entry per path, sorted by path. */
function decodeNamedSourceGaps(root: Record<string, unknown>): readonly FirstPassNamedSourceGap[] {
  if (!Object.hasOwn(root, "namedSourceGaps")) return [];
  const value = root.namedSourceGaps;
  if (!Array.isArray(value) || value.length === 0) invalidSupport();
  const gaps = value.map((item) => {
    const entry = closed(item, ["path", "reason"]);
    if (typeof entry.reason !== "string" || !Object.hasOwn(NAMED_SOURCE_GAP_REASONS, entry.reason))
      invalidSupport();
    return {
      path: entry.path as string,
      reason: entry.reason as FirstPassNamedSourceGap["reason"],
    };
  });
  decodeSortedPaths(gaps.map((gap) => gap.path));
  return gaps;
}

/** Distinct repository-relative paths in code-point order. */
function decodeSortedPaths(value: unknown): string[] {
  if (!Array.isArray(value)) invalidSupport();
  const paths = value as unknown[];
  for (const [index, path] of paths.entries()) {
    if (
      typeof path !== "string" ||
      !isRepositoryRelativePath(path) ||
      (index > 0 && compareText(paths[index - 1] as string, path) >= 0)
    )
      invalidSupport();
  }
  return [...(paths as string[])];
}

/** A plain repository-relative path, with no empty, `.`, or `..` segment. */
function isRepositoryRelativePath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    !path.split("/").some((segment) => segment === "" || segment === "." || segment === "..") &&
    posix.normalize(path) === path
  );
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const root = value as Record<string, unknown>;
    return `{${Object.keys(root)
      .sort(compareText)
      .map((key) => `${JSON.stringify(key)}:${stableJson(root[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function requireSha(value: unknown): asserts value is string {
  if (typeof value !== "string" || !SHA256.test(value)) invalidSupport();
}

function positiveInteger(value: unknown): void {
  if (!Number.isSafeInteger(value) || Number(value) < 1) invalidSupport();
}

function nonnegative(value: unknown): void {
  if (!Number.isSafeInteger(value) || Number(value) < 0) invalidSupport();
}

function nonnegativeInteger(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
}

function optionalNonnegativeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
}

function safeTokenSum(values: readonly number[]): number {
  const sum = values.reduce((total, value) => total + value, 0);
  return Number.isSafeInteger(sum) ? sum : Number.MAX_SAFE_INTEGER;
}

function invalidSupport(): never {
  // hygiene: ok -- the typed stop code accompanies a complete operator-facing message.
  throw new FirstPassSupportValidationError(
    "invalid-support",
    "The first-pass support record is invalid.",
  );
}

function bindingMismatch(): never {
  // hygiene: ok -- the typed stop code accompanies a complete operator-facing message.
  throw new FirstPassSupportValidationError(
    "support-binding-mismatch",
    "The first-pass support record does not match the current request and snapshot.",
  );
}

function provenanceInvalid(): never {
  // hygiene: ok -- the typed stop code accompanies a complete operator-facing message.
  throw new FirstPassSupportValidationError(
    "support-provenance-invalid",
    "The first-pass support record has invalid repository provenance.",
  );
}
