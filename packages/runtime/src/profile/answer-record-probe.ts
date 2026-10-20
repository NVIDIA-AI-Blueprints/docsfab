// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The answer-record premise probe: `docsfab doctor --live --answer-records`
 * (#1967; design `closed-schema-answer-records-decision.md` §6.1, MR 1a). It
 * measures whether the bound route admits real judgment records, one per
 * `submit_answer_record` call, at the sizes the records transport plans, and
 * gives a GO or NO-GO for that transport. Nothing is recorded: the
 * capability is sealed later, from this observation.
 *
 * The plan, on the untyped shell with `tool_choice: "required"`:
 * - phase A: one record per call at 0.5, 2, 4 and 8 KiB of raw outer bytes,
 *   each rung sent once per seed, climbing until the first failure;
 * - phase B: one message of several calls at about 6 KiB (half a group),
 *   10 KiB (one group), and the per-message budget maximum, ascending, each
 *   prompt padded to P tokens, the median step 8 input (N3);
 * - phase C: one 4 KiB record whose strings carry a harsh escape mix.
 *
 * The small-group run (`--answer-record-small-groups`) sends phase K only:
 * one message of exactly k real records, for k = 2 and 3, each prompt padded
 * to P like phase B, and projects the step 8 cost of k = 1, 2 and 3 from what
 * it measured. Its budget is what the approval has left after every retained
 * observation.
 *
 * Every call is decided as production would decide it: Pi's lenient parse and
 * `validateToolArguments` against the exact shell first, then the strict raw
 * decode (§3.1 steps 1 and 3). Records come from the committed corpus of the
 * two live step 8 fixtures. The observation keeps no model text: per sample,
 * the HTTP status, timing, token counts, finish reason, and per call the
 * verdicts, byte length and SHA-256. Its canonical digest is the
 * `evidenceSha256` the records capability will cite.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import {
  ANSWER_RECORD_CORPUS_KIND,
  ANSWER_RECORD_TOOL_NAME,
  ANSWER_RECORD_TYPES,
  AnswerRecordCorpusError,
  AnswerRecordLedgerError,
  answerRecordTool,
  decodeAnswerRecordArguments,
  decodeAnswerRecordCorpus,
  type AnswerRecordCorpus,
  type AnswerRecordCorpusEntry,
  type AnswerRecordDecodeCode,
  type AnswerRecordEnvelope,
  type AnswerRecordType,
  type RecordEncoding,
} from "./answer-record-probe/codecs.js";
import {
  buildPlan,
  messageBudgetBytes,
  plannedCall,
  envelopeOf,
  MESSAGE_RUNGS,
  GROUP_SIZES,
  RECORD_HEADROOM,
  ESCAPE_RUNG,
  TYPED_PHASE_A_RUNGS,
  UNTYPED_PHASE_A_RUNGS,
  TYPED_RECORD_RUNGS,
  type PlannedRequest,
} from "./answer-record-probe/planning.js";
import {
  percentile,
  projectRecordsPhase,
  recordMessages,
  sampleDecodeRate,
} from "./answer-record-probe/measurement-projection.js";
import type {
  AnswerRecordDecodeRate,
  AnswerRecordDecodeRateSource,
} from "./answer-record-probe/measurement-projection.js";
export { messageBudgetBytes } from "./answer-record-probe/planning.js";
export { recordMessages, sampleDecodeRate };
export type { AnswerRecordDecodeRate, AnswerRecordDecodeRateSource };
export {
  ANSWER_RECORD_DIAGNOSTIC_PURPOSE,
  isAnswerRecordDiagnosticEvidence,
  isAnswerRecordExactQualificationEvidence,
};

export {
  ANSWER_RECORD_CORPUS_KIND,
  ANSWER_RECORD_TOOL_NAME,
  ANSWER_RECORD_TYPES,
  AnswerRecordCorpusError,
  AnswerRecordLedgerError,
  answerRecordTool,
  decodeAnswerRecordArguments,
  decodeAnswerRecordCorpus,
};
export type {
  AnswerRecordCorpus,
  AnswerRecordCorpusEntry,
  AnswerRecordDecodeCode,
  AnswerRecordEnvelope,
  AnswerRecordType,
};

import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { limit, refuseLimit, type ResolvedLimit } from "../config/limits.js";
import { canonicalDigest } from "../content-ir/canonical.js";
import {
  ANSWER_RECORD_DIAGNOSTIC_PURPOSE,
  isAnswerRecordDiagnosticEvidence,
  isAnswerRecordExactQualificationEvidence,
} from "./answer-record-probe/evidence-codecs.js";
import { sampleOf, timedFetch } from "./answer-record-probe/sample-observation.js";
import {
  streamChatCompletion,
  type ProbeProvider,
  type ProbeRequestIdentifier,
  type ProbeStreamObservation,
  type ProbeRequestShape,
  type TransportErrorClass,
} from "./probe-core.js";

export const ANSWER_RECORD_PROBE_KIND = "docsfab-answer-record-probe" as const;
/**
 * SHA-256 of the committed corpus, `answer-record-corpus-2026-10/corpus.json`.
 * The GO bound comes from the corpus, so doctor sends only this corpus; a
 * regenerated corpus changes this pin in the same change.
 */
export const ANSWER_RECORD_CORPUS_SHA256 =
  "334933a1b38a3e4fc7a01c9575e1ec302231ddc9ecd591c31b7c3d490825b716";
const GUIDED_RECORD_TYPES = ["dimension", "finding"] as const;

// --- Pi parity --------------------------------------------------------------

/** The two Pi functions every production tool call passes before `beforeToolCall`. */
export interface PiToolArgumentValidation {
  /** Pi's lenient parse of a call's streamed argument text. */
  readonly parseStreamingJson: (text: string) => unknown;
  /** Pi's check of the parsed arguments against the tool's parameters; throws on refusal. */
  readonly validateToolArguments: (
    tool: { readonly name: string; readonly description: string; readonly parameters: unknown },
    call: {
      readonly type: "toolCall";
      readonly id: string;
      readonly name: string;
      readonly arguments: unknown;
    },
  ) => unknown;
}

/**
 * Load Pi's own argument parse and validation from the Pi AI package the
 * installed Pi agent resolves, so the probe decides each call with the code
 * production runs. Undefined when that package cannot be found.
 */
export async function loadPiToolArgumentValidation(): Promise<
  PiToolArgumentValidation | undefined
> {
  const piRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
  for (const base of piRequire.resolve.paths("@earendil-works/pi-ai") ?? []) {
    const directory = join(base, "@earendil-works/pi-ai");
    if (!existsSync(join(directory, "package.json"))) continue;
    const loaded = (await import(pathToFileURL(join(directory, "dist/index.js")).href)) as Partial<
      Record<keyof PiToolArgumentValidation, unknown>
    >;
    if (
      typeof loaded.parseStreamingJson !== "function" ||
      typeof loaded.validateToolArguments !== "function"
    ) {
      return undefined;
    }
    return loaded as unknown as PiToolArgumentValidation;
  }
  return undefined;
}

// --- The tool and the strict decode ------------------------------------------

// --- Plan ------------------------------------------------------------------------

/** Which plan a run sends: premise phases A, B and C, phase K alone, or a typed context screen. */
export type AnswerRecordProbeSelection = "premise" | "small-groups" | "typed";
export type { AnswerRecordProbePhase } from "./answer-record-probe/planning.js";
import type { AnswerRecordProbePhase } from "./answer-record-probe/planning.js";

export interface AnswerRecordProbeTarget {
  readonly modelId: string;
  /**
   * Content-free identity of the host-bound route used for this probe. An
   * unmatched operator endpoint can still be measured, but its observation
   * cannot qualify a sealed records capability.
   */
  readonly deploymentBinding: AnswerRecordProbeDeploymentBinding;
  /** Exact bound composition identity used for plan-only/source reconciliation. */
  readonly compositionBinding?: {
    readonly compositionId: string;
    readonly compositionSha256: string;
    readonly requestPolicySha256?: string;
  };
  /** Present only for a live target; provider-free plans carry no credentials. */
  readonly provider?: ProbeProvider;
  /** The bound profile's effective output limit, sent as `max_tokens`. */
  readonly maxOutputTokens: number;
  /** Seeds per rung (`endpointProbe.answerRecordSamples`). */
  readonly samplesPerRung: number;
  /** The plan to send; the premise phases when absent. */
  readonly selection?: AnswerRecordProbeSelection;
  /** Build the verifier-minimum A/B/C qualification matrix. Planning only unless passed to the live runner. */
  readonly qualificationCells?: boolean;
  /** Fingerprint copied from the reviewed provider-free plan for exact live qualification. */
  readonly expectedQualificationFingerprint?: string;
  /** Select only the fixed typed B/6,144/seed-1 diagnostic cell. */
  readonly diagnosticCell?: true;
  /** Fingerprint copied from the provider-free one-cell diagnostic plan. */
  readonly expectedDiagnosticFingerprint?: string;
  /** Send six P-padded typed singleton requests and one typed dimension+finding group. */
  readonly typedContextMix?: boolean;
  /** Continue an exact retained six-singleton context screen with its sole unsent group. */
  readonly typedContextGroupOnly?: boolean;
  /**
   * `endpointProbe.answerRecordDecodeWindowMinBasisPoints`: the share of a
   * sample's elapsed time its argument window must cover to give r.
   */
  readonly decodeWindowMinBasisPoints: number;
  /** The bound composition's `maxProviderTurns`, for the projected turn fit (§4.4). */
  readonly maxProviderTurns: number;
  /** The reading share s of the attempt timer, in basis points; T* = A / (1 − s) (§4.3). */
  readonly answerNowShareBasisPoints: number;
  readonly systemPrompt: string;
  readonly shape: Required<ProbeRequestShape>;
  /** The target route's fetch, wrapped by the caller in `captureProxyRefusal`. */
  readonly fetch: typeof globalThis.fetch;
  /** Throws a proxy refusal the fetch captured; called after every request. */
  readonly throwIfRefused?: () => void;
  /** Each request's timeout: the bound attempt timer, the most time a production record turn has. */
  readonly timeoutMs: number;
  /**
   * Most re-sends after a transport failure that is not a byte bound
   * (`endpointProbe.answerRecordTransportRetries`), each sample at most once:
   * the pool the premise runs share. The small-group run never draws on it;
   * its re-sends spend only its own request and token budgets.
   */
  readonly transportRetries: number;
  /**
   * The premise run's `endpointProbe.answerRecordRequestBudget`, the plan's
   * requests with retries excluded; or, for the small-group run, what
   * `endpointProbe.answerRecordGroupRequestBudget` has left after the ledger,
   * every send with retries included.
   */
  readonly requestBudget: ResolvedLimit;
  /**
   * The premise run's `endpointProbe.answerRecordInputTokenBudget`, or what
   * `endpointProbe.answerRecordGroupInputTokenBudget` has left after the ledger.
   */
  readonly inputTokenBudget: ResolvedLimit;
  readonly corpus: AnswerRecordCorpus;
  /** SHA-256 of the corpus file as read. */
  readonly corpusSha256: string;
  /** The small-group run's ledger; its budgets are already reduced by it. */
  readonly ledger?: AnswerRecordLedger;
  /**
   * Records the small-group run's reservation after the plan passes its
   * budgets and before the first request; required for that run, and a
   * failure here sends nothing.
   */
  readonly onReserve?: (reservation: AnswerRecordReservation) => Promise<void>;
  readonly pi: PiToolArgumentValidation;
  /** Shown the plan before any request is sent. */
  readonly onPlan?: (plan: AnswerRecordProbePlan) => void;
  readonly now?: () => number;
  readonly errorBodyMaxChars: number;
  readonly credentialEchoMinChars: number;
  /** The bound request policy's finalizer: sampling, reasoning control, and payload checks. */
  readonly finalizeBody?: (body: Record<string, unknown>) => Record<string, unknown>;
}

/** Deployment identity is recorded only when the installed composition bound it. */
export type AnswerRecordProbeDeploymentBinding =
  | {
      readonly status: "bound";
      readonly routeId: string;
      readonly deploymentIdentitySha256: string;
      readonly transport: "openai-chat-completions";
    }
  | {
      readonly status: "unavailable";
      readonly reason: "unmatched-byo";
    };

/** The plan as printed before sending: its request count and input tokens. */
export interface AnswerRecordProbePlan {
  readonly selection: AnswerRecordProbeSelection;
  readonly typedContextMix: boolean;
  readonly typedContextGroupOnly?: boolean;
  /** Present only when the plan contains the one B/6,144/seed-1 diagnostic cell. */
  readonly diagnosticFingerprint?: string;
  /** Each request's timeout, the bound attempt timer. */
  readonly requestTimeoutMs: number;
  /** The argument-window share a sample needs for a window decode rate (`endpointProbe.answerRecordDecodeWindowMinBasisPoints`). */
  readonly decodeWindowMinBasisPoints: number;
  /** The reading share s the projections divide by, T* = A / (1 − s). */
  readonly answerNowShareBasisPoints: number;
  readonly requests: number;
  /** Shared transport retries the run may draw on; 0 for the small-group run, which never does. */
  readonly transportRetries: number;
  /**
   * The request budget the plan is checked against: planned requests only
   * for the premise run; every send, re-sends included, for the small-group run.
   */
  readonly requestBudget: number;
  readonly paddedRequests: number;
  /** P, the padding target per padded request. */
  readonly paddingTargetTokens: number;
  /** The padded requests' estimated input, about `paddedRequests × P`. */
  readonly paddedInputTokens: number;
  /** Phase A and C's estimated input. */
  readonly otherInputTokens: number;
  readonly plannedInputTokens: number;
  readonly inputTokenBudget: number;
  /**
   * Whether one phase B re-send fits beside the plan. When it does not, a
   * phase B transport failure is not re-sent and the run ends INCONCLUSIVE.
   */
  readonly paddedRetryFits: boolean;
  /**
   * Padded re-sends that fit beside the whole plan: within the transport
   * retries, the input-token budget, and, for the small-group run, the
   * request budget. A re-send is sent only when it still fits at the time.
   */
  readonly paddedRetriesThatFit: number;
  /** The recorded runs the small-group budget was reduced by; null for the premise run. */
  readonly ledger: AnswerRecordLedger | null;
}

/**
 * The evidenceSha256 of the premise run every small-group ledger must hold, so
 * a ledger that lost it cannot return that run's spend to the budget.
 */
export const ANSWER_RECORD_PREMISE_EVIDENCE_SHA256 =
  "a556782a4c1db76a65c58b8b3ce25988b77865e4f9694b27ae3a501436070605";

/** The kind of a reservation a small-group run writes before its first request. */
export const ANSWER_RECORD_RESERVATION_KIND = "docsfab-answer-record-probe-reservation" as const;

/**
 * What a small-group run may spend, recorded before its first request and
 * replaced by its observation when it finishes, so an interrupted run stays
 * charged at all of it.
 */
export interface AnswerRecordReservation {
  readonly schemaVersion: 1;
  readonly kind: typeof ANSWER_RECORD_RESERVATION_KIND;
  /** Random per run, so two reservations with the same plan have different digests. */
  readonly runId: string;
  readonly modelId: string;
  readonly corpusSha256: string;
  readonly selection?: AnswerRecordProbeSelection;
  /** Every request the ledger had left, the most the run's gates let it send. */
  readonly requests: number;
  /** Every input token the ledger had left, the most the run's gates let it charge. */
  readonly inputTokens: number;
  /** Maximum shared retries reserved by the run; 0 for small-group runs. */
  readonly transportRetries?: number;
  readonly plan: AnswerRecordProbePlan;
  /** Pinned, content-addressed qualification identity; absent on ordinary runs. */
  readonly exactQualification?: AnswerRecordExactQualificationEvidence;
  /** A non-qualification diagnostic reservation, bound to one exact cell. */
  readonly diagnosticOnly?: AnswerRecordDiagnosticEvidence;
}

/** What earlier untyped record-probe runs spent, read from their retained files. */
export interface AnswerRecordLedger {
  /** Observations and reservations charged. */
  readonly observations: number;
  /** Of those, reservations of runs that never finished. */
  readonly reservations: number;
  /** Every request sent, re-sends included, plus each reservation's maximum. */
  readonly requests: number;
  /** Typed-shell requests within the separately approved slice-1b tranche. */
  readonly typedRequests?: number;
  /** Shared retries used or reserved across all retained probe observations. */
  readonly transportRetriesUsed?: number;
  /** Each sample charged the larger of its reported and estimated input, as the run charged it. */
  readonly inputTokens: number;
}

function requestMessages(target: AnswerRecordProbeTarget, prompt: string) {
  return [
    { role: target.shape.systemRole, content: target.systemPrompt },
    { role: "user", content: prompt },
  ];
}

/** Provider-free exact plan based on the same production request builder used by the live probe. */
export interface AnswerRecordExactQualificationEvidence {
  readonly schemaVersion: 1;
  readonly qualificationFingerprint: string;
  readonly modelId: string;
  readonly routeId: string;
  readonly transport: "openai-chat-completions";
  readonly deploymentIdentitySha256: string;
  readonly compositionId: string;
  readonly compositionSha256: string;
  readonly requestPolicySha256: string;
  readonly systemPromptSha256: string;
  readonly installedSystemInstructionCanonicalDigest: string;
  readonly corpusSha256: string;
  readonly shell: "typed" | "untyped";
  readonly maxOutputTokens: number;
  readonly paddingTargetTokens: number;
  readonly cells: readonly {
    readonly phase: AnswerRecordProbePhase;
    readonly rungBytes: number;
    readonly seed: number;
    readonly plannedBytes: number;
    readonly paddingChars: number;
    readonly estimatedInputTokens: number;
    readonly calls: readonly {
      readonly type: AnswerRecordType;
      readonly rawBytes: number;
      readonly stringifiedNull: boolean;
    }[];
  }[];
}

export function buildAnswerRecordQualificationPlan(target: AnswerRecordProbeTarget): {
  readonly shell: "typed" | "untyped";
  readonly modelId: string;
  readonly routeId: string | null;
  readonly transport: "openai-chat-completions" | null;
  readonly deploymentIdentitySha256: string | null;
  readonly compositionId: string | null;
  readonly compositionSha256: string | null;
  readonly requestPolicySha256: string | null;
  readonly systemPromptSha256: string;
  readonly installedSystemInstructionCanonicalDigest: string;
  readonly qualificationFingerprint: string;
  readonly corpusSha256: string;
  readonly maxOutputTokens: number;
  readonly paddingTargetTokens: number;
  readonly requestBudget: number;
  readonly inputTokenBudget: number;
  readonly transportRetries: number;
  readonly requests: number;
  readonly paddedRequests: number;
  readonly paddedInputTokens: number;
  readonly otherInputTokens: number;
  readonly plannedInputTokens: number;
  readonly cells: readonly {
    readonly phase: AnswerRecordProbePhase;
    readonly rungBytes: number;
    readonly seed: number;
    readonly plannedBytes: number;
    readonly paddingChars: number;
    readonly estimatedInputTokens: number;
    readonly calls: readonly {
      readonly type: AnswerRecordType;
      readonly rawBytes: number;
      readonly stringifiedNull: boolean;
    }[];
  }[];
} {
  const bindingIssue = qualificationBindingIssue(target);
  if (bindingIssue) throw new AnswerRecordCorpusError(bindingIssue);
  if (target.samplesPerRung !== limit("endpointProbe.answerRecordSamples").value) {
    throw new AnswerRecordCorpusError(
      `Qualification minimum requires 3 samples per rung; effective value is ${String(target.samplesPerRung)}.`,
    );
  }
  const requests = buildPlan(
    { ...target, qualificationCells: true, transportRetries: 0 },
    "qualification-plan-only",
  );
  const padded = requests.filter((request) => isPadded(request.phase));
  const paddedInputTokens = padded.reduce((sum, request) => sum + request.estimatedInputTokens, 0);
  const otherInputTokens = requests
    .filter((request) => !isPadded(request.phase))
    .reduce((sum, request) => sum + request.estimatedInputTokens, 0);
  const cells = requests.map(
    ({ phase, rungBytes, seed, plannedBytes, paddingChars, estimatedInputTokens, calls }) => ({
      phase,
      rungBytes,
      seed,
      plannedBytes,
      paddingChars,
      estimatedInputTokens,
      calls: calls.map((call) => ({
        type: call.envelope.type,
        rawBytes: call.bytes,
        stringifiedNull:
          target.selection === "typed" &&
          call.envelope.type === "quality-score" &&
          call.envelope.record === null,
      })),
    }),
  );
  const identity = {
    modelId: target.modelId,
    routeId: target.deploymentBinding.status === "bound" ? target.deploymentBinding.routeId : null,
    transport:
      target.deploymentBinding.status === "bound" ? target.deploymentBinding.transport : null,
    deploymentIdentitySha256:
      target.deploymentBinding.status === "bound"
        ? target.deploymentBinding.deploymentIdentitySha256
        : null,
    compositionId: target.compositionBinding?.compositionId ?? null,
    compositionSha256: target.compositionBinding?.compositionSha256 ?? null,
    requestPolicySha256: target.compositionBinding?.requestPolicySha256 ?? null,
    systemPromptSha256: createHash("sha256").update(target.systemPrompt).digest("hex"),
    installedSystemInstructionCanonicalDigest: canonicalDigest(target.systemPrompt),
    corpusSha256: target.corpusSha256,
    shell: target.selection === "typed" ? "typed" : "untyped",
    maxOutputTokens: target.maxOutputTokens,
    paddingTargetTokens: target.corpus.padding.targetTokens,
    cells,
  } as const;
  const qualificationFingerprint = canonicalDigest({ schemaVersion: 1, ...identity });
  return {
    shell: target.selection === "typed" ? "typed" : "untyped",
    modelId: target.modelId,
    routeId: target.deploymentBinding.status === "bound" ? target.deploymentBinding.routeId : null,
    transport:
      target.deploymentBinding.status === "bound" ? target.deploymentBinding.transport : null,
    deploymentIdentitySha256:
      target.deploymentBinding.status === "bound"
        ? target.deploymentBinding.deploymentIdentitySha256
        : null,
    compositionId: target.compositionBinding?.compositionId ?? null,
    compositionSha256: target.compositionBinding?.compositionSha256 ?? null,
    requestPolicySha256: target.compositionBinding?.requestPolicySha256 ?? null,
    systemPromptSha256: identity.systemPromptSha256,
    installedSystemInstructionCanonicalDigest: identity.installedSystemInstructionCanonicalDigest,
    qualificationFingerprint,
    corpusSha256: target.corpusSha256,
    paddingTargetTokens: target.corpus.padding.targetTokens,
    maxOutputTokens: target.maxOutputTokens,
    requestBudget: target.requestBudget.value,
    inputTokenBudget: target.inputTokenBudget.value,
    transportRetries: 0,
    requests: requests.length,
    paddedRequests: padded.length,
    paddedInputTokens,
    otherInputTokens,
    plannedInputTokens: paddedInputTokens + otherInputTokens,
    cells,
  };
}

export interface AnswerRecordDiagnosticEvidence {
  readonly schemaVersion: 1;
  readonly kind: "docsfab-answer-record-diagnostic";
  readonly purpose: typeof ANSWER_RECORD_DIAGNOSTIC_PURPOSE;
  readonly diagnosticFingerprint: string;
  /** The full, frozen qualification-plan identity from which this diagnostic cell was selected. */
  readonly qualificationFingerprint: string;
  readonly modelId: string;
  readonly routeId: string;
  readonly transport: "openai-chat-completions";
  readonly deploymentIdentitySha256: string;
  readonly compositionId: string;
  readonly compositionSha256: string;
  readonly requestPolicySha256: string;
  readonly systemPromptSha256: string;
  readonly installedSystemInstructionCanonicalDigest: string;
  readonly corpusSha256: string;
  readonly shell: "typed";
  /** Effective API controls sent for the cell; omission is explicit evidence. */
  readonly requestOptions: {
    readonly toolChoice: "required";
    readonly parallelToolCalls: "omitted";
  };
  readonly maxOutputTokens: number;
  readonly paddingTargetTokens: number;
  readonly cell: NonNullable<
    ReturnType<typeof buildAnswerRecordQualificationPlan>["cells"]
  >[number];
}

/**
 * Select one exact, non-qualifying diagnostic cell from the production-built
 * typed qualification matrix. The full parent fingerprint pins every route,
 * deployment, composition, request policy, prompt, corpus, shell, and matrix
 * identity; the child fingerprint additionally pins the selected cell.
 */
export function buildAnswerRecordDiagnosticPlan(target: AnswerRecordProbeTarget): {
  readonly diagnostic: AnswerRecordDiagnosticEvidence;
  readonly requestBudget: number;
  readonly inputTokenBudget: number;
  readonly requests: 1;
  readonly plannedInputTokens: number;
  readonly transportRetries: 0;
  readonly billing: { readonly status: "not-reported"; readonly cost: null };
} {
  if (target.selection !== "typed") {
    throw new AnswerRecordCorpusError(
      "The B-cell diagnostic requires the production typed shell; no plan or request was produced.",
    );
  }
  const qualification = buildAnswerRecordQualificationPlan(target);
  const cell = qualification.cells.find(
    (candidate) =>
      candidate.phase === "B" && candidate.rungBytes === MESSAGE_RUNGS[0] && candidate.seed === 1,
  );
  // This selector is intentionally bound to the exact failed cell. A changed
  // corpus/planner that no longer builds nine calls must require a new proposal.
  if (!cell || cell.calls.length !== 9 || cell.plannedBytes !== MESSAGE_RUNGS[0]) {
    throw new AnswerRecordCorpusError(
      "The production qualification planner no longer produces the exact B/6,144/seed-1/nine-call diagnostic cell; no plan or request was produced.",
    );
  }
  if (
    !qualification.routeId ||
    !qualification.transport ||
    !qualification.deploymentIdentitySha256 ||
    !qualification.compositionId ||
    !qualification.compositionSha256 ||
    !qualification.requestPolicySha256
  ) {
    throw new AnswerRecordCorpusError(
      "The B-cell diagnostic requires a complete route, deployment, composition, and request-policy identity; no plan or request was produced.",
    );
  }
  const binding = {
    schemaVersion: 1 as const,
    kind: "docsfab-answer-record-diagnostic" as const,
    purpose: ANSWER_RECORD_DIAGNOSTIC_PURPOSE,
    qualificationFingerprint: qualification.qualificationFingerprint,
    modelId: qualification.modelId,
    routeId: qualification.routeId,
    transport: qualification.transport,
    deploymentIdentitySha256: qualification.deploymentIdentitySha256,
    compositionId: qualification.compositionId,
    compositionSha256: qualification.compositionSha256,
    requestPolicySha256: qualification.requestPolicySha256,
    systemPromptSha256: qualification.systemPromptSha256,
    installedSystemInstructionCanonicalDigest:
      qualification.installedSystemInstructionCanonicalDigest,
    corpusSha256: qualification.corpusSha256,
    shell: "typed" as const,
    requestOptions: {
      toolChoice: "required" as const,
      parallelToolCalls: "omitted" as const,
    },
    maxOutputTokens: qualification.maxOutputTokens,
    paddingTargetTokens: qualification.paddingTargetTokens,
    cell,
  };
  return {
    diagnostic: {
      ...binding,
      diagnosticFingerprint: canonicalDigest(binding),
    },
    requestBudget: target.requestBudget.value,
    inputTokenBudget: target.inputTokenBudget.value,
    requests: 1,
    plannedInputTokens: cell.estimatedInputTokens,
    transportRetries: 0,
    billing: { status: "not-reported", cost: null },
  };
}

/** Project the reviewed identity and exact cells into retained probe evidence. */
export function exactQualificationEvidence(
  target: AnswerRecordProbeTarget,
): AnswerRecordExactQualificationEvidence {
  const plan = buildAnswerRecordQualificationPlan(target);
  if (
    !plan.routeId ||
    !plan.transport ||
    !plan.deploymentIdentitySha256 ||
    !plan.compositionId ||
    !plan.compositionSha256 ||
    !plan.requestPolicySha256
  ) {
    throw new AnswerRecordCorpusError(
      "Exact qualification evidence requires a complete route, deployment, composition, and request-policy identity.",
    );
  }
  return {
    schemaVersion: 1,
    qualificationFingerprint: plan.qualificationFingerprint,
    modelId: plan.modelId,
    routeId: plan.routeId,
    transport: plan.transport,
    deploymentIdentitySha256: plan.deploymentIdentitySha256,
    compositionId: plan.compositionId,
    compositionSha256: plan.compositionSha256,
    requestPolicySha256: plan.requestPolicySha256,
    systemPromptSha256: plan.systemPromptSha256,
    installedSystemInstructionCanonicalDigest: plan.installedSystemInstructionCanonicalDigest,
    corpusSha256: plan.corpusSha256,
    shell: plan.shell,
    maxOutputTokens: plan.maxOutputTokens,
    paddingTargetTokens: plan.paddingTargetTokens,
    cells: plan.cells,
  };
}

/** Exact qualification requires a complete host binding before a plan can be pinned. */
export function qualificationBindingIssue(target: AnswerRecordProbeTarget): string | undefined {
  if (target.deploymentBinding.status !== "bound") {
    return "Exact qualification requires a host-bound route and deployment identity; no plan or request was produced.";
  }
  if (
    !target.modelId ||
    !target.deploymentBinding.routeId ||
    !/^[a-f0-9]{64}$/u.test(target.deploymentBinding.deploymentIdentitySha256) ||
    target.deploymentBinding.transport !== "openai-chat-completions" ||
    !target.compositionBinding?.compositionId ||
    !/^[a-f0-9]{64}$/u.test(target.compositionBinding.compositionSha256) ||
    !/^[a-f0-9]{64}$/u.test(target.compositionBinding.requestPolicySha256 ?? "") ||
    !/^[a-f0-9]{64}$/u.test(target.corpusSha256)
  ) {
    return "Exact qualification requires nonempty model, route, deployment, composition, and request-policy identities; no plan or request was produced.";
  }
  return undefined;
}

// --- Samples and observation -----------------------------------------------------

/** One call's closed findings; never its text. */
export interface AnswerRecordProbeCall {
  /** Pi's lenient parse and `validateToolArguments` on the exact shell. */
  readonly piValidation: "ok" | "refused";
  readonly decode: "admitted" | AnswerRecordDecodeCode;
  readonly decodeLocation: string | null;
  /** How the record arrived; null when the decoder refused the call. */
  readonly recordEncoding: RecordEncoding | null;
  readonly rawBytes: number;
  readonly rawSha256: string;
  /**
   * The decoded envelope equals one the prompt asked for that no earlier call
   * matched. Phase K requires it of every call; the other phases record it.
   */
  readonly deepEqual: boolean;
  /** Position, in the prompt, of the planned call this call copies; null when none. */
  readonly plannedIndex: number | null;
}

/**
 * Why a transport failure was not sent again: the transport retries were
 * spent, the re-send would cross the input-token budget, or, in the
 * small-group run, the request budget.
 */
export type AnswerRecordRetryWithheld = "input-budget" | "request-budget" | "retries-exhausted";

export type AnswerRecordProbeFailure =
  | "http-refused"
  | "transport"
  | "length"
  | "no-tool-call"
  | "pi-validation"
  | "decode"
  | "call-count"
  | "short-copy"
  | "copy";

export interface AnswerRecordProbeSample {
  readonly phase: AnswerRecordProbePhase;
  /** Record type selected for this A-t-context sample; absent for other phases. */
  readonly contextTypes?: readonly AnswerRecordType[];
  /** The rung in raw outer bytes: one call's for A and C, the message's for B. */
  readonly rungBytes: number;
  readonly seed: number;
  readonly expectedCalls: number;
  /** Raw outer bytes the prompt asked for, summed over its calls. */
  readonly plannedBytes: number;
  readonly escapesPerKiB: number;
  /** Characters of padding before the calls; 0 outside the padded phases. */
  readonly paddingChars: number;
  /** The host's estimate of the request's input tokens. */
  readonly estimatedInputTokens: number;
  /** HTTP status; 0 when no response arrived. */
  readonly httpStatus: number;
  readonly transportError: TransportErrorClass | null;
  /** HTTP 0 only: the response bytes that arrived before it failed. */
  readonly streamedBytes: number | null;
  /** This transport failure was sent again; the re-send names it in `retryOf`. */
  readonly retried: boolean;
  /** The index, in `samples`, of the transport failure this sample re-sends. */
  readonly retryOf: number | null;
  /** Why a transport failure was not sent again; null when it was, or needed no re-send. */
  readonly retryWithheld: AnswerRecordRetryWithheld | null;
  /** From sending the request to the end of its response, or to its failure. */
  readonly elapsedMs: number | null;
  /** From sending the request to the first streamed content, reasoning, or tool-call delta. */
  readonly ttftMs: number | null;
  /** From sending the request to the first tool-call argument text that arrived. */
  readonly firstArgumentDeltaMs: number | null;
  /** From sending the request to the last tool-call argument text that arrived. */
  readonly lastArgumentDeltaMs: number | null;
  /** Bytes of tool-call argument text the stream carried, over every call. */
  readonly argumentBytes: number;
  /**
   * Of those, the bytes that arrived after the first argument text: what the
   * route decoded inside the argument window. 0 when every argument arrived
   * in one burst.
   */
  readonly argumentBytesAfterFirstDelta: number;
  readonly outputTokens: number | null;
  /** The provider's reported input tokens, when the stream carried usage. */
  readonly promptTokens: number | null;
  /** Of those, the tokens the provider reported as cached. */
  readonly cachedPromptTokens: number | null;
  readonly finishReason: string | null;
  /** Bounded, content-free response and SSE assembly metadata; absent in older retained v2 observations. */
  readonly transportObservation?: AnswerRecordProbeTransportObservation;
  /** Calls to tools other than the record tool. */
  readonly otherToolCalls: number;
  readonly calls: readonly AnswerRecordProbeCall[];
  /**
   * Every call copies a different planned call, in the prompt's order. Records
   * are keyed, so order is recorded, never required. Null unless every
   * planned call was copied.
   */
  readonly inPlannedOrder: boolean | null;
  /** Production would admit every call, and the message carries exactly the calls asked for. */
  readonly admitted: boolean;
  readonly failure: AnswerRecordProbeFailure | null;
}

export interface AnswerRecordProbeTransportObservation {
  readonly responseBytes: number;
  readonly requestIdentifier: ProbeRequestIdentifier;
  readonly streamClass: ProbeStreamObservation["streamClass"] | "transport-error" | "http-error";
  /** Missing when no complete successful response body was available to parse. */
  readonly stream?: ProbeStreamObservation;
}

export interface AnswerRecordProbeObservation {
  /** 2: selection, argument timing on every sample, and typed context-screen marker. */
  readonly schemaVersion: 2;
  readonly kind: typeof ANSWER_RECORD_PROBE_KIND;
  /** Host-resolved route identity; never derived from an endpoint URL or credential. */
  readonly deploymentBinding: AnswerRecordProbeDeploymentBinding;
  readonly selection: AnswerRecordProbeSelection;
  readonly typedContextMix: boolean;
  /** True only for the one-run continuation of the pinned six-singleton partial screen. */
  readonly typedContextGroupOnly?: boolean;
  readonly modelId: string;
  readonly maxOutputTokens: number;
  readonly shell: "untyped" | "typed";
  /** Guided decoding is not sent unless the bound request policy admits it. */
  readonly phaseG: {
    readonly status: "not-executed";
    readonly reason: "request-policy-blocked";
    readonly requests: 0;
    readonly schemas: readonly ["dimension", "finding"];
  } | null;
  readonly toolChoice: "required";
  readonly samplesPerRung: number;
  readonly corpusSha256: string;
  /**
   * Largest corpus record and the GO bound it gives, in raw outer bytes of
   * the call arguments, wrapper included: the rungs' unit (§3.1 step 4).
   */
  readonly largestRecordBytes: number;
  readonly requiredRecordBytes: number;
  /** Phases not sent because the run could no longer reach GO. */
  readonly skippedPhases: readonly AnswerRecordProbePhase[];
  readonly padding: {
    readonly targetTokens: number;
    readonly method: string;
    readonly source: unknown;
    /** A leading per-request nonce keeps a provider prefix cache from shortening prefill. */
    readonly cacheBusting: "leading-nonce";
  };
  readonly plan: AnswerRecordProbePlan;
  /** Requests not sent because the input-token budget would be exceeded; 0 normally. */
  readonly withheldForInputBudget: number;
  readonly samples: readonly AnswerRecordProbeSample[];
  /** Exact reviewed plan binding; omitted for ordinary/non-qualification observations. */
  readonly exactQualification?: AnswerRecordExactQualificationEvidence;
  /** Explicit diagnostic-only binding; this evidence is never a qualification matrix. */
  readonly diagnosticOnly?: AnswerRecordDiagnosticEvidence;
}

/** The values a records capability would be sealed from; nothing is recorded here. */
export interface AnswerRecordProbeMeasurement {
  /**
   * The bytes phase A's largest rung actually carried, admitted for every
   * seed with every lower rung: its smallest admitted call. Null when none.
   */
  readonly maxRecordBytes: number | null;
  readonly requiredRecordBytes: number;
  /** min(budget term, the smallest message the largest phase B rung admitted 3/3 actually carried). */
  readonly maxMessageBytes: number | null;
  readonly messageBudgetBytes: number;
  readonly escapeMix: "admitted" | "refused" | "unmeasured";
  /** Lturn: p90 of the padded samples' time to first token (phase B, or K), prompts padded to P. */
  readonly ttftP90Ms: number | null;
  /**
   * r, tokens per second, never silently invalid: the median argument-window
   * rate when any completed sample streamed a valid window, else the median
   * end-to-end rate. `decodeRateSource` names which.
   */
  readonly decodeTokensPerSecond: number | null;
  /**
   * `stream-window`: output tokens decoded inside the window from the first
   * to the last tool-call argument text, over that window. `end-to-end`:
   * output tokens over elapsed time, prefill included, a lower bound on
   * decode, used when every window was degenerate (a burst at the end).
   */
  readonly decodeRateSource: AnswerRecordDecodeRateSource | null;
  /** Completed samples behind each rate kind. */
  readonly decodeRateSamples: {
    readonly streamWindow: number;
    readonly endToEnd: number;
  };
  /** Median end-to-end rate over every completed sample, shown beside r. */
  readonly endToEndTokensPerSecond: number | null;
  /** Median reported prompt tokens of the padded samples; the estimate when none was reported. */
  readonly paddedPromptTokens: number | null;
  /** Median reported cached prompt tokens of the padded samples. */
  readonly paddedCachedPromptTokens: number | null;
  /** In the typed context screen, the six singleton maximum-record TTFT p90; excludes its grouped request. */
  readonly typedContextSingletonTtftP90Ms: number | null;
  /** In the typed context screen, the separate max-dimension + max-finding group TTFT. */
  readonly typedContextGroupTtftMs: number | null;
  /** The retained attempts' time per provider turn, an upper bound on Lturn (§4.2). */
  readonly turnUpperBoundMs: number;
  /** How admitted records arrived: as objects, as JSON strings, or both. */
  readonly recordMembers: "object" | "stringified" | "mixed" | null;
  readonly requests: number;
  /** Re-sends drawn from the shared transport retries; always 0 in the small-group run. */
  readonly transportRetriesUsed: number;
  /** Re-sends the small-group run paid from its own remainder; 0 in the premise run. */
  readonly remainderResends: number;
  /** Phase K, one entry per group size; empty for the premise run. */
  readonly groups: readonly AnswerRecordGroupResult[];
  /**
   * Projections, not measurements: the step 8 records phase at k = 1, 2 and
   * 3 records per message, from the measured r, Lturn and padded prompt.
   * Empty when one of them is unmeasured.
   */
  readonly projections: readonly AnswerRecordProjection[];
}

/** One group size of phase K. */
export interface AnswerRecordGroupResult {
  /** k: the records each message asked for. */
  readonly recordsPerMessage: number;
  readonly seeds: number;
  /** Seeds sent, re-sends not counted. */
  readonly sent: number;
  readonly admittedSeeds: number;
  /** Every seed admitted, every call carried in full: k-record messages are admitted 3/3. */
  readonly admitted: boolean;
  /** `unsent`: a smaller group was not admitted, or the run stopped first. */
  readonly state: CellState | "unsent";
  /** The failures of the seeds that were not admitted. */
  readonly failures: readonly string[];
  /** Record messages one step 8 answer needs at k: the larger fixture's. */
  readonly impliedMessages: number;
  readonly impliedMessagesByFixture: Readonly<Record<string, number>>;
}

/** The step 8 records phase at one group size: a projection, not a measurement. */
export interface AnswerRecordProjection {
  readonly recordsPerMessage: number;
  /** M: record messages one answer needs, groups split at record boundaries (§4.1). */
  readonly messages: number;
  /** M × the measured padded prompt: the records phase's input tokens. */
  readonly recordTurnInputTokens: number;
  /** Of those, M × the measured cached prompt tokens. */
  readonly cachedInputTokens: number;
  /** A = D_full + (M + 2) × Lturn, seconds (§4.2). */
  readonly answerSeconds: number;
  /** T* = A / (1 − s), seconds (§4.3). */
  readonly timerSeconds: number;
  /** The bound composition's maxProviderTurns the turn fit uses. */
  readonly maxProviderTurns: number;
  /** maxProviderTurns − (2M + 1): the reading turns the turn fit leaves (§4.4). */
  readonly readingTurnsLeft: number;
}

export interface AnswerRecordProbeTransportError {
  readonly phase: AnswerRecordProbePhase;
  readonly rungBytes: number;
  readonly class: TransportErrorClass;
  readonly elapsedMs: number;
  readonly streamedBytes: number;
  readonly retried: boolean;
  readonly retryWithheld: AnswerRecordRetryWithheld | null;
}

export type AnswerRecordProbeNoGoCause =
  | "record-bound-below-record"
  | "r9-one-record-per-message"
  | "escape-mix-not-admitted"
  | "typed-shell-not-admitted"
  | "provider-request-refused";

interface VerdictBase {
  readonly measurement: AnswerRecordProbeMeasurement;
  readonly observation: AnswerRecordProbeObservation;
  readonly evidenceSha256: string;
}

export type AnswerRecordProbeVerdict =
  | (VerdictBase & {
      readonly decision: "go";
      readonly notes: readonly string[];
      readonly nextAction: string;
    })
  | (VerdictBase & {
      readonly decision: "no-go";
      readonly stopClass: "provider-compatibility";
      readonly cause: AnswerRecordProbeNoGoCause;
      readonly reason: string;
      readonly nextAction: string;
      readonly notes: readonly string[];
    })
  | (VerdictBase & {
      /** One predeclared diagnostic cell ran; this outcome never means qualified. */
      readonly decision: "diagnostic";
      readonly outcome: "observed" | "transport-error" | "http-refused" | "not-sent";
      readonly billing: { readonly status: "not-reported"; readonly cost: null };
      readonly nextAction: string;
      readonly notes: readonly string[];
    })
  | (VerdictBase & {
      /**
       * The small-group run decided every group size it could reach: each
       * is admitted 3/3, or not. Neither GO nor NO-GO; the records plan is
       * chosen from it in the design record.
       */
      readonly decision: "measured";
      readonly notes: readonly string[];
      readonly nextAction: string;
    })
  | (VerdictBase & {
      /** Transport failures or the input budget kept a GO criterion unmeasured; no stop class. */
      readonly decision: "inconclusive";
      readonly reason: string;
      readonly transportErrors: readonly AnswerRecordProbeTransportError[];
      readonly nextAction: string;
      readonly notes: readonly string[];
    });

const NEXT_ACTIONS: Readonly<Record<AnswerRecordProbeNoGoCause | "go" | "inconclusive", string>> = {
  go: "Post the GO with this observation and its evidenceSha256 on #1965; the records transport (#1970) may proceed, and nothing is recorded until the records capability (#1973).",
  "record-bound-below-record":
    "Hold the records transport (#1970). Text-path derivation (#1972) still lands, and the piecewise transport v10.1 is re-planned on top of it (#1707).",
  "r9-one-record-per-message":
    "R9 applies: plan one record per message and apply the §4.4 turn-fit rule; if the p90 reading turns exceed what remains of maxProviderTurns, requalify it as a stated re-qualification event, or revisit fan-out (#1569).",
  "escape-mix-not-admitted":
    "Hold the records transport (#1970) and review the refused phase C calls in the observation; text-path derivation (#1972) still lands.",
  "typed-shell-not-admitted":
    "The typed shell was not admitted consistently. Review the retained A-t observation and request-policy contract; phase G remains unexecuted until guided JSON is authorized.",
  "provider-request-refused":
    "Keep the route on the text answer; review the retained observation and the route's tools support before probing again.",
  inconclusive:
    "A re-run is outside the approved O10 spend: get the cost owner's approval before probing again. Transport failures or the input-token budget left a GO criterion unmeasured.",
};
const GROUP_NEXT_ACTIONS = {
  measured:
    "Post this observation and its evidenceSha256 on #1967, then amend the design record (r4) with the R9 plan: choose one record per message, the largest group size admitted 3/3, or fan-out (#1569), from the projections; a non-author critic reviews it before #1970 and #1973.",
  inconclusive:
    "The approval is spent or a group size stayed unmeasured: get the cost owner's approval before probing again, or settle R9 on one record per message.",
} as const;

/** Phases whose prompts are padded to P: the multi-call messages. */
function isPadded(phase: AnswerRecordProbePhase): boolean {
  return phase === "A-t-context" || phase === "B" || phase === "K";
}

/** A cell's rung: records per message for phase K, raw outer bytes otherwise. */
function rungOf(item: {
  readonly phase: AnswerRecordProbePhase;
  readonly rungBytes: number;
  readonly calls: readonly unknown[];
}): number {
  return item.phase === "K" ? item.calls.length : item.rungBytes;
}

/** The request got an HTTP 2xx response, so its findings are complete. */
function completed(sample: AnswerRecordProbeSample): boolean {
  return sample.httpStatus >= 200 && sample.httpStatus < 300;
}

type CellState = "admitted" | "failed" | "unmeasured";

/**
 * Run the probe and apply the §6.1 gate. Phases run in order A, B, C; A and B
 * climb their rungs until the first sample that is not admitted, and a later
 * phase runs only while GO is still reachable. An HTTP refusal ends the
 * probe. A transport failure that is not a byte bound is sent again, each
 * sample at most once, within `transportRetries` and the input-token budget.
 * GO needs every one of, for every seed: phase A carrying at least the
 * largest corpus call × 1.5, in raw outer bytes; phase B admitting a 6 KiB
 * rung or larger; and phase C admitted, or cut for size only above
 * `maxRecordBytes`. Sizes are the bytes the admitted calls carried, never
 * the plan's.
 */
export async function probeAnswerRecords(
  target: AnswerRecordProbeTarget,
): Promise<AnswerRecordProbeVerdict> {
  const provider = target.provider;
  if (!provider) {
    throw new AnswerRecordLedgerError(
      "A live answer-record probe requires a credentialed provider binding; no reservation or request was made.",
    );
  }
  let pinnedExactQualification: AnswerRecordExactQualificationEvidence | undefined;
  let pinnedDiagnostic: AnswerRecordDiagnosticEvidence | undefined;
  if (target.typedContextMix && target.selection !== "typed") {
    throw new AnswerRecordLedgerError(
      "The typed context screen requires the typed answer-record selection; no request was sent.",
    );
  }
  if (target.typedContextGroupOnly && !target.typedContextMix) {
    throw new AnswerRecordLedgerError(
      "The typed context group continuation requires the typed context screen; no request was sent.",
    );
  }
  if (target.qualificationCells && target.selection !== "typed") {
    throw new AnswerRecordLedgerError(
      "Live exact qualification cells require the typed selection so the retained typed tranche can reserve the complete matrix; no request was sent.",
    );
  }
  if (target.qualificationCells) {
    const bindingIssue = qualificationBindingIssue(target);
    if (bindingIssue) throw new AnswerRecordLedgerError(bindingIssue);
    const expected = target.expectedQualificationFingerprint;
    if (!expected || !/^[a-f0-9]{64}$/u.test(expected)) {
      throw new AnswerRecordLedgerError(
        "Live exact qualification requires the 64-character fingerprint from its reviewed provider-free plan; no reservation or request was made.",
      );
    }
    const exactQualification = exactQualificationEvidence(target);
    const actual = exactQualification.qualificationFingerprint;
    if (actual !== expected) {
      throw new AnswerRecordLedgerError(
        `Live exact qualification identity or cell plan changed (expected ${expected}, resolved ${actual}); no reservation or request was made.`,
      );
    }
    pinnedExactQualification = exactQualification;
  }
  if (target.diagnosticCell) {
    const bindingIssue = qualificationBindingIssue(target);
    if (bindingIssue) throw new AnswerRecordLedgerError(bindingIssue);
    const expected = target.expectedDiagnosticFingerprint;
    if (!expected || !/^[a-f0-9]{64}$/u.test(expected)) {
      throw new AnswerRecordLedgerError(
        "The one-cell diagnostic requires the 64-character fingerprint from its provider-free plan; no reservation or request was made.",
      );
    }
    let diagnostic: AnswerRecordDiagnosticEvidence;
    try {
      diagnostic = buildAnswerRecordDiagnosticPlan(target).diagnostic;
    } catch (error) {
      if (!(error instanceof AnswerRecordCorpusError)) throw error;
      throw new AnswerRecordLedgerError(
        `${error.message} No reservation or request was made for this diagnostic plan.`,
      );
    }
    if (diagnostic.diagnosticFingerprint !== expected) {
      throw new AnswerRecordLedgerError(
        `The one-cell diagnostic identity or selected cell changed (expected ${expected}, resolved ${diagnostic.diagnosticFingerprint}); no reservation or request was made.`,
      );
    }
    pinnedDiagnostic = diagnostic;
  }
  const now = target.now ?? Date.now;
  const finalize = target.finalizeBody ?? ((body: Record<string, unknown>) => body);
  // A per-run salt keeps a re-run's prompts out of a provider prefix cache.
  const planTarget = target.diagnosticCell
    ? { ...target, qualificationCells: true, transportRetries: 0 }
    : target;
  const builtPlan = buildPlan(planTarget, randomBytes(16).toString("hex"));
  const plan = target.diagnosticCell
    ? builtPlan.filter(
        (request) =>
          request.phase === "B" && request.rungBytes === MESSAGE_RUNGS[0] && request.seed === 1,
      )
    : builtPlan;
  if (target.diagnosticCell && (plan.length !== 1 || plan[0]!.calls.length !== 9)) {
    throw new AnswerRecordLedgerError(
      "The live production planner did not resolve exactly the bound B/6,144/seed-1/nine-call cell; no reservation or request was made.",
    );
  }
  const keys = new Map<AnswerRecordType, Set<string>>();
  for (const entry of target.corpus.records) {
    if (entry.key === undefined) continue;
    const set = keys.get(entry.type) ?? new Set<string>();
    set.add(entry.key);
    keys.set(entry.type, set);
  }
  const largestRecordBytes = Math.max(
    ...target.corpus.records.map((entry) => plannedCall(envelopeOf(entry)).bytes),
  );
  const requiredRecordBytes = Math.ceil(
    (largestRecordBytes * RECORD_HEADROOM.numerator) / RECORD_HEADROOM.denominator,
  );
  const selection = target.selection ?? "premise";
  // The small-group run's request budget counts every send, so a re-send
  // spends from it like any request and never from the shared retries.
  const resendsCounted = selection === "small-groups";
  const requiresReservation =
    resendsCounted ||
    selection === "typed" ||
    target.qualificationCells === true ||
    target.diagnosticCell === true;
  const sharedRetries =
    resendsCounted || target.qualificationCells || target.diagnosticCell
      ? 0
      : target.transportRetries;
  const padded = plan.filter((request) => isPadded(request.phase));
  const paddedInputTokens = padded.reduce((sum, request) => sum + request.estimatedInputTokens, 0);
  const otherInputTokens = plan
    .filter((request) => !isPadded(request.phase))
    .reduce((sum, request) => sum + request.estimatedInputTokens, 0);
  const plannedInputTokens = paddedInputTokens + otherInputTokens;
  const largestPadded = Math.max(0, ...padded.map((request) => request.estimatedInputTokens));
  const largestRequest = Math.max(0, ...plan.map((request) => request.estimatedInputTokens));
  const retryReservation = largestPadded || largestRequest;
  const tokenFit =
    retryReservation === 0
      ? 0
      : Math.floor((target.inputTokenBudget.value - plannedInputTokens) / retryReservation);
  const paddedRetriesThatFit = Math.max(
    0,
    resendsCounted
      ? Math.min(tokenFit, target.requestBudget.value - plan.length)
      : Math.min(sharedRetries, tokenFit),
  );
  const summary: AnswerRecordProbePlan = {
    selection,
    typedContextMix: target.typedContextMix === true,
    ...(target.typedContextGroupOnly ? { typedContextGroupOnly: true } : {}),
    ...(pinnedDiagnostic ? { diagnosticFingerprint: pinnedDiagnostic.diagnosticFingerprint } : {}),
    requestTimeoutMs: target.timeoutMs,
    decodeWindowMinBasisPoints: target.decodeWindowMinBasisPoints,
    answerNowShareBasisPoints: target.answerNowShareBasisPoints,
    requests: plan.length,
    transportRetries: sharedRetries,
    requestBudget: target.requestBudget.value,
    paddedRequests: padded.length,
    paddingTargetTokens: target.corpus.padding.targetTokens,
    paddedInputTokens,
    otherInputTokens,
    plannedInputTokens,
    inputTokenBudget: target.inputTokenBudget.value,
    paddedRetryFits: paddedRetriesThatFit > 0,
    paddedRetriesThatFit,
    ledger: requiresReservation ? (target.ledger ?? null) : null,
  };
  target.onPlan?.(summary);
  // Refuse before any request when the plan alone exceeds the approved spend.
  if (summary.requests > target.requestBudget.value) {
    refuseLimit(target.requestBudget, summary.requests);
  }
  if (plannedInputTokens > target.inputTokenBudget.value) {
    refuseLimit(target.inputTokenBudget, plannedInputTokens);
  }
  if (requiresReservation) {
    // Ledger-backed runs reserve their complete remaining tranche before
    // sending; an interrupted run cannot return unobserved authority.
    if (!target.onReserve) {
      throw new AnswerRecordLedgerError(
        `The ${selection} run sends nothing without a reservation in its ledger; run it through docsfab doctor --live --answer-records.`,
      );
    }
    await target.onReserve({
      schemaVersion: 1,
      kind: ANSWER_RECORD_RESERVATION_KIND,
      runId: randomBytes(16).toString("hex"),
      modelId: target.modelId,
      corpusSha256: target.corpusSha256,
      selection,
      requests: target.requestBudget.value,
      inputTokens: target.inputTokenBudget.value,
      transportRetries: sharedRetries,
      plan: summary,
      ...(pinnedExactQualification ? { exactQualification: pinnedExactQualification } : {}),
      ...(pinnedDiagnostic ? { diagnosticOnly: pinnedDiagnostic } : {}),
    });
  }

  const samples: AnswerRecordProbeSample[] = [];
  const tap = timedFetch(target.fetch, now);
  let retriesLeft = sharedRetries;
  let remainderResends = 0;
  let spentInputTokens = 0;
  let withheld = 0;
  let refused = false;
  const pending = new Set(plan);
  /**
   * The worst reported-over-estimated input ratio of any earlier sample, in
   * any phase, and at least 1: a request is charged at the largest overrun
   * the route has shown, never at its estimate alone. Phase B's padding is
   * the same corpus JSON phases A and C send, so their ratios carry over.
   */
  const inputRatio = (): number =>
    samples.reduce(
      (worst, sample) =>
        sample.promptTokens === null || sample.estimatedInputTokens === 0
          ? worst
          : Math.max(worst, sample.promptTokens / sample.estimatedInputTokens),
      1,
    );
  const predicted = (request: PlannedRequest): number =>
    Math.ceil(request.estimatedInputTokens * inputRatio());
  const fits = (request: PlannedRequest, reserve: number): boolean =>
    spentInputTokens + predicted(request) + reserve <= target.inputTokenBudget.value;

  const sendOne = async (request: PlannedRequest, retryOf: number | null): Promise<number> => {
    const send = samples.length;
    const body = {
      model: target.modelId,
      messages: requestMessages(target, request.prompt(send)),
      stream: true,
      stream_options: { include_usage: true },
      ...(target.shape.store ? { store: false } : {}),
      [target.shape.tokenField]: target.maxOutputTokens,
      tools: [answerRecordTool(target.selection === "typed" ? "typed" : "untyped")],
      tool_choice: "required",
    };
    const startedAt = now();
    const turn = await streamChatCompletion(provider, finalize(body), {
      fetch: tap.fetch,
      timeoutMs: target.timeoutMs,
      errorBodyMaxChars: target.errorBodyMaxChars,
      credentialEchoMinChars: target.credentialEchoMinChars,
      now,
    });
    const elapsedMs = Math.max(0, now() - startedAt);
    // A proxy refusal sent nothing and names its own fix: stop before spending more.
    target.throwIfRefused?.();
    const sample = sampleOf(request, turn, tap.take(), elapsedMs, retryOf, target, keys);
    samples.push(sample);
    spentInputTokens += Math.max(sample.promptTokens ?? 0, request.estimatedInputTokens);
    return samples.length - 1;
  };

  /** Send one seed of a cell, with its retry; returns the deciding sample. */
  const sendSeed = async (
    request: PlannedRequest,
  ): Promise<AnswerRecordProbeSample | undefined> => {
    pending.delete(request);
    if (!fits(request, 0)) {
      withheld += 1;
      return undefined;
    }
    const index = await sendOne(request, null);
    const sample = samples[index]!;
    if (sample.httpStatus !== 0 || sample.transportError === "byte-bound") return sample;
    // Planned requests keep their share of the budget ahead of any retry.
    const reserve = [...pending].reduce((sum, item) => sum + predicted(item), 0);
    const countFits =
      !resendsCounted || samples.length + pending.size + 1 <= target.requestBudget.value;
    const poolEmpty = !resendsCounted && retriesLeft === 0;
    if (poolEmpty || !countFits || !fits(request, reserve)) {
      samples[index] = {
        ...sample,
        retryWithheld: poolEmpty
          ? "retries-exhausted"
          : !countFits
            ? "request-budget"
            : "input-budget",
      };
      return samples[index];
    }
    if (resendsCounted) remainderResends += 1;
    else retriesLeft -= 1;
    samples[index] = { ...sample, retried: true };
    const retry = await sendOne(request, index);
    return samples[retry];
  };

  /** A timeout whose re-send also timed out, both while output was streaming. */
  const timerFit = (sample: AnswerRecordProbeSample): boolean => {
    if (sample.retryOf === null) return false;
    const original = samples[sample.retryOf]!;
    return (
      original.transportError === "timeout" &&
      sample.transportError === "timeout" &&
      (original.streamedBytes ?? 0) > 0 &&
      (sample.streamedBytes ?? 0) > 0
    );
  };
  const failedSample = (sample: AnswerRecordProbeSample): boolean =>
    (completed(sample) && !sample.admitted) ||
    sample.transportError === "byte-bound" ||
    timerFit(sample);

  const cells = new Map<string, { state: CellState; deciding: AnswerRecordProbeSample[] }>();
  const cellKey = (phase: AnswerRecordProbePhase, rung: number) => `${phase}:${String(rung)}`;
  /** Send a phase's cells in order; a ladder stops at the first seed that is not admitted. */
  const runPhase = async (phase: AnswerRecordProbePhase, ladder: boolean): Promise<void> => {
    const rungs = [...new Set(plan.filter((request) => request.phase === phase).map(rungOf))];
    for (const rung of rungs) {
      const deciding: AnswerRecordProbeSample[] = [];
      let state: CellState = "admitted";
      for (const request of plan.filter((item) => item.phase === phase && rungOf(item) === rung)) {
        if (refused || (ladder && state !== "admitted")) {
          pending.delete(request);
          continue;
        }
        const sample = await sendSeed(request);
        if (sample === undefined) state = state === "failed" ? state : "unmeasured";
        else {
          deciding.push(sample);
          if (sample.httpStatus !== 0 && !completed(sample)) refused = true;
          if (failedSample(sample)) state = "failed";
          else if (!sample.admitted && state === "admitted") state = "unmeasured";
        }
      }
      // Every seed must be decided for a rung to count as admitted.
      if (state === "admitted" && deciding.length < target.samplesPerRung) state = "unmeasured";
      cells.set(cellKey(phase, rung), { state, deciding });
      if (ladder && state !== "admitted") {
        for (const request of plan.filter((item) => item.phase === phase)) pending.delete(request);
        return;
      }
    }
  };
  const runTypedContextMix = async (): Promise<void> => {
    for (const request of plan) {
      if (refused) {
        pending.delete(request);
        continue;
      }
      const sample = await sendSeed(request);
      if (sample && sample.httpStatus !== 0 && !completed(sample)) {
        refused = true;
        continue;
      }
      if (sample && sample.failure !== null && sample.failure !== "transport") break;
    }
  };
  // --- Gate ---
  const consecutive = (
    phase: AnswerRecordProbePhase,
  ): { last: number | null; next: CellState | "unsent" } => {
    let last: number | null = null;
    for (const rung of [
      ...new Set(
        plan.filter((request) => request.phase === phase).map((request) => request.rungBytes),
      ),
    ]) {
      const cell = cells.get(cellKey(phase, rung));
      if (!cell) return { last, next: "unsent" };
      if (cell.state !== "admitted") return { last, next: cell.state };
      last = rung;
    }
    return { last, next: "admitted" };
  };
  /** The smallest admitted message a rung actually carried, in raw outer bytes. */
  const carried = (phase: AnswerRecordProbePhase, rung: number): number =>
    Math.min(
      ...(cells.get(cellKey(phase, rung))?.deciding ?? []).map((sample) =>
        sample.calls.reduce((sum, call) => sum + call.rawBytes, 0),
      ),
    );
  const recordPhase = selection === "typed" ? "A-t" : "A";
  const recordGate = () => {
    const a = consecutive(recordPhase);
    const maxRecordBytes = a.last === null ? null : carried(recordPhase, a.last);
    const pass = maxRecordBytes !== null && maxRecordBytes >= requiredRecordBytes;
    return { maxRecordBytes, pass, fail: !pass && a.next === "failed" };
  };
  /** Phase B must admit 6 KiB or more; below it, a group cannot share a message (R9). */
  const messageGate = () => {
    const b = consecutive("B");
    const pass = b.last !== null && b.last >= MESSAGE_RUNGS[0];
    return {
      last: b.last,
      pass,
      fail: !pass && (b.next === "failed" || (b.next === "admitted" && b.last !== null)),
    };
  };
  // B and C run only while GO is still reachable; otherwise the earned
  // verdict stands and their spend is saved.
  const skippedPhases: AnswerRecordProbePhase[] = [];
  if (target.diagnosticCell) {
    const request = plan[0];
    if (request) await sendSeed(request);
  } else if (selection === "small-groups") {
    // A group size counts only when every seed is admitted, so phase K climbs
    // like a ladder: a larger group is not sent once a smaller one failed.
    await runPhase("K", true);
  } else if (selection === "typed") {
    if (target.typedContextMix) await runTypedContextMix();
    else if (target.qualificationCells) {
      await runPhase("A-t", true);
      if (!refused && recordGate().pass) {
        await runPhase("B", true);
        if (!refused && messageGate().pass) await runPhase("C", false);
        else skippedPhases.push("C");
      } else skippedPhases.push("B", "C");
    } else await runPhase("A-t", true);
  } else {
    await runPhase("A", true);
    if (!refused && recordGate().pass) {
      await runPhase("B", true);
      if (!refused && messageGate().pass) await runPhase("C", false);
      else skippedPhases.push("C");
    } else skippedPhases.push("B", "C");
  }
  if (refused) skippedPhases.length = 0;

  const { maxRecordBytes, pass: aPass, fail: aFail } = recordGate();
  const { last: messageRung, pass: bPass, fail: bFail } = messageGate();
  const firstMessageRung = plan.find((request) => request.phase === "B")?.rungBytes;
  const escapeCell = cells.get(cellKey("C", ESCAPE_RUNG));
  const cDeciding = escapeCell?.deciding ?? [];
  const cRefused = cDeciding.filter((sample) => failedSample(sample));
  // A refused phase C call is excused only for a size failure (a cut at the
  // output limit, or the response byte bound) above the measured record bound.
  const excused = (sample: AnswerRecordProbeSample): boolean => {
    if (sample.failure !== "length" && sample.transportError !== "byte-bound") return false;
    const bytes = Math.max(sample.plannedBytes, ...sample.calls.map((call) => call.rawBytes));
    return bytes > (maxRecordBytes ?? 0);
  };
  const cFail = cRefused.some((sample) => !excused(sample));
  const cPass =
    !cFail &&
    cDeciding.length === target.samplesPerRung &&
    cDeciding.every((sample) => sample.admitted || (failedSample(sample) && excused(sample)));

  const largestMessage = messageRung === null ? null : carried("B", messageRung);
  const budgetBytes = messageBudgetBytes(target.maxOutputTokens);
  const admittedSamples = samples.filter((sample) => sample.admitted);
  const encodings = new Set(
    admittedSamples.flatMap((sample) =>
      sample.calls
        .map((call) => call.recordEncoding)
        .filter((value) => value === "object" || value === "string"),
    ),
  );
  const typedContextSingletons = samples.filter(
    (sample) =>
      sample.phase === "A-t-context" && sample.contextTypes?.length === 1 && completed(sample),
  );
  const typedContextGroup = samples.find(
    (sample) => sample.phase === "A-t-context" && sample.expectedCalls === 2,
  );
  const paddedSamples = samples.filter(
    (sample) =>
      isPadded(sample.phase) &&
      completed(sample) &&
      (!target.typedContextMix || sample.expectedCalls === 1),
  );
  const ttftP90Ms = percentile(
    paddedSamples.filter((sample) => sample.ttftMs !== null).map((sample) => sample.ttftMs!),
    0.9,
  );
  const rated = samples
    .filter((sample) => !target.typedContextMix || sample.expectedCalls === 1)
    .map((sample) => ({
      sample,
      rate: sampleDecodeRate(sample, target.decodeWindowMinBasisPoints),
    }))
    .filter(
      (
        item,
      ): item is {
        sample: AnswerRecordProbeSample;
        rate: AnswerRecordDecodeRate;
      } => item.rate !== null,
    );
  const windowRates = rated
    .filter((item) => item.rate.source === "stream-window")
    .map((item) => item.rate.tokensPerSecond);
  const endToEndRates = rated.map(
    (item) => (item.sample.outputTokens! * 1000) / item.sample.elapsedMs!,
  );
  const decodeRate = percentile(windowRates.length > 0 ? windowRates : endToEndRates, 0.5);
  const decodeRateSource: AnswerRecordDecodeRateSource | null =
    decodeRate === null ? null : windowRates.length > 0 ? "stream-window" : "end-to-end";
  const endToEndRate = percentile(endToEndRates, 0.5);
  const paddedPromptTokens = percentile(
    paddedSamples.map((sample) => sample.promptTokens ?? sample.estimatedInputTokens),
    0.5,
  );
  const paddedCachedPromptTokens = percentile(
    paddedSamples
      .filter((sample) => sample.cachedPromptTokens !== null)
      .map((sample) => sample.cachedPromptTokens!),
    0.5,
  );
  const groups: AnswerRecordGroupResult[] =
    selection === "small-groups"
      ? GROUP_SIZES.map((size) => {
          const cell = cells.get(cellKey("K", size));
          const deciding = cell?.deciding ?? [];
          const messages = recordMessages(target.corpus, size);
          return {
            recordsPerMessage: size,
            seeds: target.samplesPerRung,
            sent: samples.filter(
              (sample) =>
                sample.phase === "K" && sample.expectedCalls === size && sample.retryOf === null,
            ).length,
            admittedSeeds: deciding.filter((sample) => sample.admitted).length,
            admitted: cell?.state === "admitted",
            state: cell?.state ?? "unsent",
            failures: [
              ...new Set(
                deciding
                  .filter((sample) => !sample.admitted)
                  .map((sample) => sample.failure ?? sample.transportError ?? "unmeasured"),
              ),
            ],
            impliedMessages: messages.messages,
            impliedMessagesByFixture: messages.byFixture,
          };
        })
      : [];
  const projections = target.typedContextMix
    ? []
    : projectRecordsPhase(target, {
        decodeTokensPerSecond: decodeRate,
        ttftP90Ms,
        paddedPromptTokens,
        paddedCachedPromptTokens,
        largestRecordBytes,
      });
  const measurement: AnswerRecordProbeMeasurement = {
    maxRecordBytes,
    requiredRecordBytes,
    maxMessageBytes: largestMessage === null ? null : Math.min(budgetBytes, largestMessage),
    messageBudgetBytes: budgetBytes,
    escapeMix: cFail ? "refused" : cPass ? "admitted" : "unmeasured",
    ttftP90Ms,
    decodeTokensPerSecond: decodeRate === null ? null : Math.round(decodeRate * 10) / 10,
    decodeRateSource,
    decodeRateSamples: {
      streamWindow: windowRates.length,
      endToEnd: rated.length - windowRates.length,
    },
    endToEndTokensPerSecond: endToEndRate === null ? null : Math.round(endToEndRate * 10) / 10,
    paddedPromptTokens,
    paddedCachedPromptTokens,
    typedContextSingletonTtftP90Ms: target.typedContextMix
      ? percentile(
          typedContextSingletons
            .filter((sample) => sample.ttftMs !== null)
            .map((sample) => sample.ttftMs!),
          0.9,
        )
      : null,
    typedContextGroupTtftMs:
      target.typedContextMix && typedContextGroup?.ttftMs !== undefined
        ? typedContextGroup.ttftMs
        : null,
    turnUpperBoundMs: target.corpus.padding.turnUpperBound.medianMsPerTurn,
    recordMembers:
      encodings.size === 0
        ? null
        : encodings.size === 2
          ? "mixed"
          : encodings.has("string")
            ? "stringified"
            : "object",
    requests: samples.length,
    transportRetriesUsed: sharedRetries - retriesLeft,
    remainderResends,
    groups,
    projections,
  };
  const observation: AnswerRecordProbeObservation = {
    schemaVersion: 2,
    kind: ANSWER_RECORD_PROBE_KIND,
    deploymentBinding: target.deploymentBinding,
    selection,
    typedContextMix: target.typedContextMix === true,
    ...(target.typedContextGroupOnly ? { typedContextGroupOnly: true } : {}),
    modelId: target.modelId,
    maxOutputTokens: target.maxOutputTokens,
    shell: selection === "typed" ? "typed" : "untyped",
    phaseG:
      selection === "typed"
        ? {
            status: "not-executed",
            reason: "request-policy-blocked",
            requests: 0,
            schemas: GUIDED_RECORD_TYPES,
          }
        : null,
    toolChoice: "required",
    samplesPerRung: target.samplesPerRung,
    corpusSha256: target.corpusSha256,
    largestRecordBytes,
    requiredRecordBytes,
    skippedPhases,
    padding: {
      targetTokens: target.corpus.padding.targetTokens,
      method: target.corpus.padding.method,
      source: target.corpus.padding.source,
      cacheBusting: "leading-nonce",
    },
    plan: summary,
    withheldForInputBudget: withheld,
    samples,
    ...(pinnedExactQualification ? { exactQualification: pinnedExactQualification } : {}),
    ...(pinnedDiagnostic ? { diagnosticOnly: pinnedDiagnostic } : {}),
  };
  const evidenceSha256 = canonicalDigest(observation);
  const notes = [
    ...(target.typedContextMix
      ? [
          target.typedContextGroupOnly
            ? "This one-request continuation sends only the previously unsent P-padded dimension+finding group from the pinned six-singleton partial screen; it does not re-run singleton requests. No padded retry fits the retained input-token remainder. The grouped sample is exploratory, not a grouped-admission qualification, R9 turn-fit result, or records capability GO."
            : "A-t-context is a seven-request typed context screen: one P-padded corpus-maximum singleton for each declared type and one P-padded two-call group containing the maximum dimension and finding. The single grouped sample is exploratory, not a grouped-admission qualification, R9 turn-fit result, or records capability GO.",
          'The typed tool advertises record as object|string. The pinned Pi validator normalizes optional null fields before schema validation, so its acceptance is reported separately from strict decoding of the original raw JSON. The quality-score planned encoding is JSON string "null"; canonical raw null decodes to the same envelope but is not JSON-Schema conformance.',
        ]
      : []),
    ...(selection === "typed"
      ? [
          "A-t measures typed-schema admission and carried bytes only. Per-call deepEqual records canonical planned-envelope matches separately; MEASURED is not an exact-copy qualification or capability GO.",
        ]
      : []),
    ...(ttftP90Ms !== null && measurement.turnUpperBoundMs < ttftP90Ms
      ? [
          `The probe's Lturn (p90 TTFT ${String(ttftP90Ms)} ms) exceeds the retained attempts' median time per turn (${String(measurement.turnUpperBoundMs)} ms), an upper bound that includes decode, so the probe value is suspect.`,
        ]
      : []),
    ...(samples.some((sample) =>
      sample.calls.some((call) => call.decode === "admitted" && !call.deepEqual),
    )
      ? [
          "An admitted call decoded to a record other than the one asked for (a copying slip, recorded only).",
        ]
      : []),
    ...(samples.some((sample) => (sample.cachedPromptTokens ?? 0) > 0)
      ? [
          "The provider reported cached prompt tokens on some requests, so their TTFT may understate a full prefill.",
        ]
      : []),
    ...(withheld > 0
      ? [`${String(withheld)} request(s) were withheld to stay within the input-token budget.`]
      : []),
    ...(samples.some((sample) => sample.retryWithheld === "input-budget")
      ? [
          selection === "premise"
            ? "A transport failure was not re-sent because the re-send does not fit the input-token budget; at the default budget a phase B re-send never fits."
            : "A transport failure was not re-sent because the re-send does not fit what the approval has left of the input-token budget.",
        ]
      : []),
    ...(samples.some((sample) => sample.retryWithheld === "request-budget")
      ? [
          "A transport failure was not re-sent because the re-send does not fit what the approval has left of the request budget.",
        ]
      : []),
    ...(skippedPhases.length > 0
      ? [`Phase ${skippedPhases.join(" and ")} not sent: the run could no longer reach GO.`]
      : []),
    ...groups
      .filter((group) => group.state === "unsent" && !refused)
      .map(
        (group) =>
          `k = ${String(group.recordsPerMessage)} not sent: a smaller group was not admitted for every seed.`,
      ),
    ...(decodeRateSource === "end-to-end"
      ? [
          "r is the end-to-end rate, output tokens over elapsed time with prefill included, a lower bound on decode: every completed sample sent its tool-call arguments in a burst, so no decode window was measurable.",
        ]
      : []),
    ...(paddedSamples.some(
      (sample) =>
        sample.firstArgumentDeltaMs !== null &&
        sample.ttftMs === sample.firstArgumentDeltaMs &&
        (sample.argumentBytes - sample.argumentBytesAfterFirstDelta) * 2 * sample.expectedCalls >=
          sample.argumentBytes,
    )
      ? [
          "Lturn includes decode: on some padded samples the first output was at least half a call's argument text in one burst, so their TTFT counts that call's decode as well as prefill.",
        ]
      : []),
    ...(projections.length > 0
      ? [
          "The projections are arithmetic on this run's r, Lturn and padded prompt (design §4.2 to §4.4), not measurements.",
        ]
      : []),
  ];
  const base = { measurement, observation, evidenceSha256, notes };
  const noGo = (cause: AnswerRecordProbeNoGoCause, reason: string): AnswerRecordProbeVerdict => ({
    ...base,
    decision: "no-go",
    stopClass: "provider-compatibility",
    cause,
    reason,
    nextAction: NEXT_ACTIONS[cause],
  });
  if (pinnedDiagnostic) {
    const sample = samples[0];
    const outcome =
      sample === undefined
        ? "not-sent"
        : sample.httpStatus !== 0 && !completed(sample)
          ? "http-refused"
          : sample.transportError !== null
            ? "transport-error"
            : "observed";
    return {
      ...base,
      decision: "diagnostic",
      outcome,
      billing: { status: "not-reported", cost: null },
      nextAction:
        "Retain this one-cell transport diagnosis only. It cannot qualify phase B, replace a failed seed, or activate answer records; review received-call and assembled-call metadata before proposing any new bounded work.",
      notes: [
        ...base.notes,
        "This observation is diagnostic-only and contains one B/6,144/seed-1 cell. It does not satisfy the three-independent-seed A/B/C criteria or qualify a records capability. Billing cost was not reported by this probe path.",
      ],
    };
  }
  const failures = (phase: AnswerRecordProbePhase): string =>
    [
      ...new Set(
        samples
          .filter((sample) => sample.phase === phase && failedSample(sample))
          .map((sample) => sample.failure ?? sample.transportError),
      ),
    ].join(", ");

  const httpRefusal = samples.find((sample) => sample.httpStatus !== 0 && !completed(sample));
  if (httpRefusal) {
    return noGo(
      "provider-request-refused",
      `The route refused a phase ${httpRefusal.phase} records request with HTTP ${String(httpRefusal.httpStatus)}.`,
    );
  }
  const transportErrors = (): AnswerRecordProbeTransportError[] =>
    samples
      .filter((sample) => sample.transportError !== null)
      .map((sample) => ({
        phase: sample.phase,
        rungBytes: sample.rungBytes,
        class: sample.transportError!,
        elapsedMs: sample.elapsedMs ?? 0,
        streamedBytes: sample.streamedBytes ?? 0,
        retried: sample.retried,
        retryWithheld: sample.retryWithheld,
      }));
  if (target.qualificationCells) {
    const requiredA = selection === "typed" ? TYPED_PHASE_A_RUNGS : UNTYPED_PHASE_A_RUNGS;
    const aSamples = samples.filter(
      (sample) => sample.phase === (selection === "typed" ? "A-t" : "A"),
    );
    const bSamples = samples.filter((sample) => sample.phase === "B");
    const cSamples = samples.filter((sample) => sample.phase === "C");
    const aComplete = requiredA.every((rung) => {
      const rungSamples = aSamples.filter((sample) => sample.rungBytes === rung);
      return (
        rungSamples.length === target.samplesPerRung &&
        new Set(rungSamples.map((sample) => sample.seed)).size === target.samplesPerRung &&
        rungSamples.every(
          (sample) =>
            sample.admitted &&
            sample.calls.length === sample.expectedCalls &&
            sample.expectedCalls === 1 &&
            sample.calls[0]?.piValidation === "ok" &&
            sample.calls[0]?.decode === "admitted" &&
            sample.calls[0]?.deepEqual,
        )
      );
    });
    const bComplete =
      bSamples.length === target.samplesPerRung &&
      new Set(bSamples.map((sample) => sample.seed)).size === target.samplesPerRung &&
      bSamples.every(
        (sample) =>
          sample.rungBytes === MESSAGE_RUNGS[0] &&
          sample.admitted &&
          sample.calls.length === sample.expectedCalls &&
          sample.expectedCalls > 0 &&
          sample.calls.every(
            (call) => call.piValidation === "ok" && call.decode === "admitted" && call.deepEqual,
          ),
      );
    const qualifiedABytes = aComplete ? requiredA.at(-1)! : 0;
    const cComplete =
      cSamples.length === target.samplesPerRung &&
      new Set(cSamples.map((sample) => sample.seed)).size === target.samplesPerRung &&
      cSamples.every(
        (sample) =>
          (sample.calls.length === sample.expectedCalls &&
            sample.expectedCalls === 1 &&
            sample.admitted &&
            sample.calls.every(
              (call) => call.piValidation === "ok" && call.decode === "admitted" && call.deepEqual,
            )) ||
          (sample.calls.length === sample.expectedCalls &&
            sample.expectedCalls === 1 &&
            !sample.admitted &&
            sample.failure === "length" &&
            Math.max(0, ...sample.calls.map((call) => call.rawBytes)) > qualifiedABytes),
      );
    if (aComplete && bComplete && cComplete) {
      return {
        ...base,
        decision: "measured",
        notes: [
          ...base.notes,
          "The exact A/B/C qualification cell set completed on the selected answer shell. Apply the frozen #1973 verifier and retained step-8 selector; this measurement alone does not seal or activate a records capability.",
        ],
        nextAction:
          "Retain the observation and verify its schema-v2 route/deployment binding, all A/B/C cells, exact QJG run selector, timer and turn-fit criteria before any seal or activation.",
      };
    }
    const errors = transportErrors();
    if (errors.length > 0) {
      return {
        ...base,
        decision: "inconclusive",
        reason: `The exact qualification matrix stopped with ${String(errors.length)} transport failure(s); no retries were planned.`,
        transportErrors: errors,
        nextAction:
          "Retain the reservation and partial observation; do not resume or retry without a new verified cell plan and approved budget.",
      };
    }
    return noGo(
      "typed-shell-not-admitted",
      "The exact A/B/C qualification cells did not satisfy all independent-seed admission and strict-copy criteria; retain the partial observation and do not infer a bound.",
    );
  }
  if (selection === "typed" && target.typedContextMix) {
    const contextSamples = samples.filter((sample) => sample.phase === "A-t-context");
    if (target.typedContextGroupOnly) {
      const group = contextSamples[0];
      if (group && completed(group)) {
        return {
          ...base,
          decision: "measured",
          notes: [
            ...base.notes,
            "This observation covers only one exploratory typed dimension+finding group. It neither repeats the six singleton samples nor completes the context screen, proves repeatable grouped admission, satisfies R9, or qualifies records capability GO.",
          ],
          nextAction:
            "Retain this one group outcome with the pinned six-singleton observation. Do not repeat the group or infer grouped qualification; full screen, production turn-fit, #1967 GO, and R9 remain open.",
        };
      }
      const errors = transportErrors();
      return {
        ...base,
        decision: "inconclusive",
        reason: `The one-request typed context continuation produced ${String(contextSamples.length)} completed group sample(s) and ${String(errors.length)} transport failure(s). No singleton was repeated; the remaining input-token budget does not fit a padded retry.`,
        transportErrors: errors,
        nextAction:
          "Retain the reservation and observation. This continuation is one exploratory sample only; do not automatically retry or increase the approved tranche.",
        notes: base.notes,
      };
    }
    const complete =
      contextSamples.length === ANSWER_RECORD_TYPES.length + 1 &&
      contextSamples.every(
        (sample) =>
          sample.admitted &&
          sample.contextTypes !== undefined &&
          sample.calls.length === sample.expectedCalls &&
          sample.calls.every((call) => call.deepEqual),
      ) &&
      ANSWER_RECORD_TYPES.every((type) =>
        contextSamples.some((sample) => sample.contextTypes?.includes(type)),
      ) &&
      contextSamples.filter((sample) => sample.expectedCalls === 2).length === 1;
    if (complete) {
      return {
        ...base,
        decision: "measured",
        notes: [
          ...base.notes,
          "The seven-request typed context screen passed per-sample Pi validation, strict decode, and exact-envelope checks. It does not satisfy the #1967 live-probe GO prerequisite for #1970; full record-mix timing and 43-record turn-fit criteria remain open.",
        ],
        nextAction:
          "Retain this screen as context-mix evidence only. Reconcile its measured full-context timings with the recorded reading-turn distribution and the 43-record plus resend turn-fit gate; do not activate #1970 or declare R9 GO from this screen.",
      };
    }
    const contextFailure = contextSamples.find((sample) => !sample.admitted);
    if (
      contextFailure &&
      ((contextFailure.failure !== null &&
        contextFailure.failure !== "transport" &&
        contextFailure.failure !== "http-refused") ||
        contextFailure.transportError === "byte-bound")
    ) {
      return noGo(
        "typed-shell-not-admitted",
        `The typed context screen failed its ${contextFailure.contextTypes?.join("+") ?? "unknown-type"} sample (${contextFailure.failure ?? contextFailure.transportError}); inspect Pi validation, strict decode, and exact-copy evidence. This is not a qualification verdict for the existing A-t ladder.`,
      );
    }
    const errors = transportErrors();
    return {
      ...base,
      decision: "inconclusive",
      reason: `The seven-request typed context screen completed ${String(contextSamples.length)} sample(s), with ${String(withheld)} withheld by the approved input-token remainder and ${String(errors.length)} transport failure(s). No budget was increased.`,
      transportErrors: errors,
      nextAction:
        "Retain the reservation and observation. Do not automatically retry or increase the approved tranche; review the remaining typed ledger and qualification evidence before any separately authorized measurement.",
      notes: base.notes,
    };
  }
  if (selection === "typed") {
    const typed = consecutive("A-t");
    const typedSamples = samples.filter((sample) => sample.phase === "A-t");
    if (typed.next === "admitted" && typed.last === TYPED_RECORD_RUNGS.at(-1)) {
      return {
        ...base,
        decision: "measured",
        notes: [
          ...base.notes,
          "A-t measured typed-shell behavior only. It does not qualify records capability GO; phase G was not executed because the bound request policy does not admit guided JSON.",
        ],
        nextAction:
          "Retain this typed A-t evidence as slice 1b measurement. Phase G remains open pending an authorized guided-decoding request policy; do not infer provider support or a records capability seal.",
      };
    }
    if (
      typedSamples.some(
        (sample) => sample.failure !== null || sample.transportError === "byte-bound",
      )
    ) {
      return noGo(
        "typed-shell-not-admitted",
        `The typed A-t ladder stopped at ${typed.last === null ? "no admitted rung" : `${String(typed.last)} bytes`}; inspect typed Pi validation, response shape, and request-policy behavior in the retained observation. Phase G was not executed (0 requests) because the bound request policy does not admit guided JSON.`,
      );
    }
    const errors = transportErrors();
    return {
      ...base,
      decision: "inconclusive",
      reason: `A-t remained unmeasured: ${String(errors.length)} request(s) ended without an HTTP response and ${String(withheld)} planned request(s) were withheld by the combined input-token budget. Phase G was not executed (0 requests) because the bound request policy does not admit guided JSON.`,
      transportErrors: errors,
      nextAction:
        "Do not retry without reviewing the retained typed ledger and approved shared retry/input-token remainder. Phase G remains open pending an authorized guided-decoding request policy.",
      notes: base.notes,
    };
  }
  if (selection === "small-groups") {
    // Decided when every group size up to the first failure is admitted 3/3.
    const firstOpen = groups.find((group) => group.state !== "admitted");
    if (firstOpen === undefined || firstOpen.state === "failed") {
      return {
        ...base,
        decision: "measured",
        nextAction: GROUP_NEXT_ACTIONS.measured,
      };
    }
    const errors = transportErrors();
    return {
      ...base,
      decision: "inconclusive",
      reason: `k = ${String(firstOpen.recordsPerMessage)} was not decided for every seed: ${String(errors.length)} request(s) ended without an HTTP response and ${String(withheld)} planned request(s) were withheld for the input-token budget.`,
      transportErrors: errors,
      nextAction: GROUP_NEXT_ACTIONS.inconclusive,
    };
  }
  if (aFail) {
    return noGo(
      "record-bound-below-record",
      `Phase A admitted records only up to ${maxRecordBytes === null ? "no rung" : `${String(maxRecordBytes)} bytes`} for every seed, below the ${String(requiredRecordBytes)} bytes the largest real record needs (${failures("A")}).`,
    );
  }
  if (bFail) {
    return noGo(
      "r9-one-record-per-message",
      messageRung !== null && messageRung < MESSAGE_RUNGS[0]
        ? `Phase B's largest message is ${String(messageRung)} bytes, below the ${String(MESSAGE_RUNGS[0])}-byte rung, because the output limit's budget term is smaller; below 6 KiB is R9.`
        : `Phase B did not admit its ${String(firstMessageRung ?? 0)}-byte message for every seed (${failures("B")}), so a group cannot share one message.`,
    );
  }
  if (cFail) {
    return noGo(
      "escape-mix-not-admitted",
      `Phase C's escape-mix record was refused within the measured record bound (${failures("C")}).`,
    );
  }
  if (!aPass || !bPass || !cPass) {
    const transport = transportErrors();
    return {
      ...base,
      decision: "inconclusive",
      reason: `${String(transport.length)} request(s) ended without an HTTP response (${String(transport.filter((error) => error.retryWithheld === "input-budget").length)} not re-sent because the re-send does not fit the input-token budget) and ${String(withheld)} planned request(s) were withheld for that budget, so a GO criterion stayed unmeasured.`,
      transportErrors: transport,
      nextAction: NEXT_ACTIONS.inconclusive,
    };
  }
  return { ...base, decision: "go", nextAction: NEXT_ACTIONS.go };
}
