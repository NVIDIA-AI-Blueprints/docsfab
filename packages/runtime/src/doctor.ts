// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type ModelSlotSettingsV1 } from "./config/model-settings.js";
import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

import { limit, type ResolvedLimit } from "./config/limits.js";
import { canonicalJson } from "./content-ir/canonical.js";
import type { DocsFabConfig } from "./config/runtime-loader.js";
import {
  createDocsFabResourceLoader,
  getDocsFabContextSources,
  type DocsFabContextSource,
} from "./harness/pi.js";
import { VIRTUAL_WORKSPACE_CWD } from "./harness/pi-session.js";
import {
  ModelCompositionError,
  type InstalledAnswerSubmission,
  type MeasuredReasoningControl,
} from "./model-composition/types.js";
import { type AnswerSubmissionOption } from "./config/answer-submission.js";
import {
  assertLocalhostEndpointResolvesToLoopback,
  InsecureModelEndpointError,
} from "./model/endpoint-transport.js";
import { OutboundProxyRefusal } from "./model/outbound-http-policy.js";
import {
  resolveOperatorExecutionBinding,
  resolveOperatorExecutionIdentity,
  type OperatorExecutionBinding,
  type OperatorExecutionIdentityBinding,
} from "./model/operator-execution-binding.js";
import { createModelConnection } from "./model/provider.js";
import {
  applyReasoningControl,
  DOCSFAB_SYSTEM_PROMPT,
  finalizeNvidiaApiCatalogPayload,
} from "./model/request-policy.js";
import {
  formatOperatorErrorEnvelope,
  serializeOperatorErrorEnvelope,
  toOperatorErrorEnvelope,
  type OperatorErrorEnvelope,
} from "./operator/error-envelope.js";
import { doctorFallbackRemediationText } from "./operator/remediation.js";
import { rejectSituation } from "./operator/situation-catalog.js";
import {
  probeAnswerSubmission,
  type AnswerSubmissionProbeVerdict,
  type AnswerSubmissionProbeTarget,
} from "./profile/answer-submission-probe.js";
import {
  ANSWER_RECORD_CORPUS_SHA256,
  buildAnswerRecordDiagnosticPlan,
  buildAnswerRecordQualificationPlan,
  ANSWER_RECORD_PREMISE_EVIDENCE_SHA256,
  AnswerRecordCorpusError,
  AnswerRecordLedgerError,
  decodeAnswerRecordCorpus,
  loadPiToolArgumentValidation,
  probeAnswerRecords,
  qualificationBindingIssue,
  type AnswerRecordLedger,
  type AnswerRecordProbeDeploymentBinding,
  type AnswerRecordProbePlan,
  type AnswerRecordDiagnosticEvidence,
  type AnswerRecordProbeSelection,
  type AnswerRecordProbeTarget,
  type AnswerRecordProbeVerdict,
} from "./profile/answer-record-probe.js";
import {
  answerRecordLedger,
  answerRecordTypedLedger,
  hasPinnedContextGroupContinuation,
  ANSWER_RECORD_TYPED_CONTEXT_PARTIAL_EVIDENCE_SHA256,
} from "./doctor/answer-record-ledger.js";
export { answerRecordTypedLedger, ANSWER_RECORD_TYPED_CONTEXT_PARTIAL_EVIDENCE_SHA256 };
import {
  captureProxyRefusal,
  chatCompletionsProbeShape,
  createProbeFetch,
  EndpointCompatibilityError,
  notCheckedReport,
  probeEndpointCompatibility,
  type EndpointCompatibilityReport,
} from "./profile/endpoint-compatibility.js";
import { releaseModelCredential } from "./security/model-credential-release.js";
import { readCatalogSkillCrateLock, verifyCatalogSkill } from "./skills/catalog-crate.js";
import { QualityPackError, verifyQualityPack } from "./quality-pack/manifest.js";
import type { ResolvedResourceSetV1 } from "./records/contracts.js";
export {
  answerSubmissionLine,
  formatDoctorResult,
  modelProfileClampLines,
  reviewOverdueLines,
  retryCategoriesPinLine,
  retryEnvelopeLine,
  transportBudgetLine,
} from "./doctor/render.js";
export type { EffectiveDoctorAttempt } from "./doctor/render.js";

export interface LiveCheckResult {
  latencyMs: number;
  /** Observed before the connectivity turn by the default live check. */
  compatibility?: EndpointCompatibilityReport;
}

export interface LiveModelDependencies {
  readonly probeCompatibility?: (
    model: DocsFabConfig["model"],
  ) => Promise<EndpointCompatibilityReport>;
}

export type LiveChecker = (config: DocsFabConfig) => Promise<LiveCheckResult>;

/** What doctor readiness observed of the provider live check. */
export type LiveInferenceObservation = "not-requested" | "not-attempted" | "passed" | "failed";

export interface DiagnoseOptions {
  live?: boolean;
  liveChecker?: LiveChecker;
}

export interface DoctorResult {
  provider: string;
  endpoint: string;
  model: string;
  skills: string[];
  contextSources: DocsFabContextSource[];
  /** The resource set every run binds from the verified quality pack. */
  resolvedResources?: ResolvedResourceSetV1;
  profile: DocsFabConfig["model"]["profile"];
  requestPolicy: DocsFabConfig["model"]["requestPolicy"];
  /** Reasoning control an unmatched endpoint receives; absent when none applies. */
  reasoningControl?: MeasuredReasoningControl;
  /** `DOCSFAB_ANSWER_SUBMISSION` as loaded; absent reads as the default. */
  answerSubmissionOption?: AnswerSubmissionOption;
  /** The answer submission the policy model's bound route recorded, if any. */
  answerSubmission?: InstalledAnswerSubmission;
  /** Each effective policy-model setting with its source, as the binding resolved it. */
  modelSettings?: ModelSlotSettingsV1;
  retryPolicy: DocsFabConfig["retryPolicy"];
  judge?: {
    provider: string;
    endpoint: string;
    model: string;
    profile: NonNullable<DocsFabConfig["judge"]>["profile"];
    requestPolicy: NonNullable<DocsFabConfig["judge"]>["requestPolicy"];
    reasoningControl?: MeasuredReasoningControl;
    modelSettings?: ModelSlotSettingsV1;
  };
  live?: LiveCheckResult;
  /**
   * The live check readiness already ran for this invocation. The summary
   * reports it instead of probing the provider a second time.
   */
  liveObservation?: LiveInferenceObservation;
}

/**
 * Probe the configured endpoint with the request shape DocsFab sends: the
 * bound composition's request policy, or else the reasoning control measured
 * for an unmatched endpoint's model, and the effective output limit.
 */
export async function probeConfiguredEndpointCompatibility(
  model: DocsFabConfig["model"],
): Promise<EndpointCompatibilityReport> {
  const binding = await resolveOperatorExecutionBinding({ model });
  const maxOutputTokens = binding.profile.profile.maxOutputTokens;
  if (model.apiFormat !== "chat_completions") {
    return notCheckedReport(
      "Not checked: the endpoint probe speaks OpenAI-compatible chat completions only.",
      maxOutputTokens,
    );
  }
  const policy = binding.bound?.composition.requestPolicy;
  const reasoningControl = policy ? undefined : binding.profile.measuredReasoningControl?.control;
  const apiKey = binding.credential.apiKey;
  const profile = binding.profile.profile;
  return probeEndpointCompatibility({
    modelId: model.modelId,
    baseUrl: model.baseUrl,
    endpointSource: model.endpointSource,
    apiKey,
    maxOutputTokens,
    outputLimitSource: "configured",
    shape: chatCompletionsProbeShape({
      providerId: model.providerId,
      baseUrl: model.baseUrl,
      requestPolicy: policy !== undefined,
      reasoning: profile.reasoning,
      supportsDeveloperRole: profile.compatibility.supportsDeveloperRole,
    }),
    ...(policy
      ? {
          finalizeBody: (body: Record<string, unknown>) => ({
            ...finalizeNvidiaApiCatalogPayload({
              rawPayload: body,
              policy,
              exactCredential: apiKey,
              maxOutputTokens,
            }).payload,
          }),
        }
      : reasoningControl
        ? {
            finalizeBody: (body: Record<string, unknown>) => {
              const finalized = { ...body };
              applyReasoningControl(finalized, reasoningControl);
              return finalized;
            },
          }
        : {}),
  });
}

/**
 * The answer-submission qualification probe on the bound request path
 * (`docsfab doctor --live --answer-submission`): the same binding,
 * request policy, and effective output limit the endpoint compatibility probe
 * uses, so its evidence describes the requests production sends.
 */
export async function probeConfiguredAnswerSubmission(
  model: DocsFabConfig["model"],
  options: { readonly typedContingency?: boolean } = {},
): Promise<
  AnswerSubmissionProbeVerdict | { readonly decision: "not-checked"; readonly reason: string }
> {
  const target = await answerSubmissionProbeTarget(model, options);
  return "decision" in target ? target : probeAnswerSubmission(target);
}

/**
 * The probe's target on the bound request path: the binding's request
 * policy and effective output limit, V6 on the bound attempt timer, and the
 * transport retry limit. `not-checked` for a route the probe cannot speak to.
 */
export async function answerSubmissionProbeTarget(
  model: DocsFabConfig["model"],
  options: { readonly typedContingency?: boolean } = {},
): Promise<
  AnswerSubmissionProbeTarget | { readonly decision: "not-checked"; readonly reason: string }
> {
  const binding = await resolveOperatorExecutionBinding({ model });
  if (model.apiFormat !== "chat_completions") {
    return {
      decision: "not-checked",
      reason: "The answer-submission probe speaks OpenAI-compatible chat completions only.",
    };
  }
  await assertLocalhostEndpointResolvesToLoopback(model.baseUrl);
  const maxOutputTokens = binding.profile.profile.maxOutputTokens;
  const policy = binding.bound?.composition.requestPolicy;
  const reasoningControl = policy ? undefined : binding.profile.measuredReasoningControl?.control;
  const apiKey = binding.credential.apiKey;
  const profile = binding.profile.profile;
  return {
    modelId: model.modelId,
    provider: {
      baseUrl: model.baseUrl,
      credential: releaseModelCredential(
        { endpoint: model.baseUrl, endpointSource: model.endpointSource, apiKey },
        "endpoint-probe",
      ),
    },
    maxOutputTokens,
    samplesPerVariant: limit("endpointProbe.answerSubmissionSamples").value,
    systemPrompt: DOCSFAB_SYSTEM_PROMPT,
    shape: chatCompletionsProbeShape({
      providerId: model.providerId,
      baseUrl: model.baseUrl,
      requestPolicy: policy !== undefined,
      reasoning: profile.reasoning,
      supportsDeveloperRole: profile.compatibility.supportsDeveloperRole,
    }),
    fetch: createProbeFetch(model.baseUrl),
    timeoutMs: limit("endpointProbe.requestTimeoutMs").value,
    // V6 runs on the attempt timer a production submission turn has: the
    // bound composition's, or the request timeout on a lane without one.
    largeVariantTimeoutMs:
      binding.bound?.composition.compositionLimits.timeoutMs ??
      limit("endpointProbe.requestTimeoutMs").value,
    transportRetries: limit("endpointProbe.answerSubmissionTransportRetries").value,
    // The typed-shell contingency spends past the nominal plan, so it runs
    // only when the operator opts in.
    typedContingency: options.typedContingency === true,
    errorBodyMaxChars: limit("endpointProbe.providerMessageMaxChars").value,
    credentialEchoMinChars: limit("endpointProbe.credentialEchoMinChars").value,
    ...(policy
      ? {
          finalizeBody: (body: Record<string, unknown>) => ({
            ...finalizeNvidiaApiCatalogPayload({
              rawPayload: body,
              policy,
              exactCredential: apiKey,
              maxOutputTokens,
            }).payload,
          }),
        }
      : reasoningControl
        ? {
            finalizeBody: (body: Record<string, unknown>) => {
              const finalized = { ...body };
              applyReasoningControl(finalized, reasoningControl);
              return finalized;
            },
          }
        : {}),
  };
}

/**
 * The machine-readable probe result `docsfab doctor --live
 * --answer-submission --json` prints. An `inconclusive` result carries its
 * transport failures and no stop class.
 */
export function answerSubmissionProbeResult(
  verdict: Awaited<ReturnType<typeof probeConfiguredAnswerSubmission>>,
  observationPath?: string,
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: "docsfab-answer-submission-probe-result",
    decision: verdict.decision,
    ...(verdict.decision === "go"
      ? { capability: verdict.capability, notes: verdict.notes }
      : verdict.decision === "no-go"
        ? {
            stopClass: verdict.stopClass,
            cause: verdict.cause,
            reason: verdict.reason,
            nextAction: verdict.nextAction,
          }
        : verdict.decision === "inconclusive"
          ? {
              reason: verdict.reason,
              transportErrors: verdict.transportErrors,
              nextAction: verdict.nextAction,
            }
          : verdict.decision === "contingency-required"
            ? {
                reason: verdict.reason,
                contingencyRequests: verdict.contingencyRequests,
                rerunMaxRequests: verdict.rerunMaxRequests,
                nextAction: verdict.nextAction,
              }
            : { reason: verdict.reason }),
    ...(verdict.decision === "not-checked" || observationPath === undefined
      ? {}
      : { evidenceSha256: verdict.evidenceSha256, observationPath }),
  };
}

/**
 * GO is the only success. NO-GO and `inconclusive` exit 1;
 * `contingency-required` exits 2, because it asks for an operator decision
 * rather than reporting a finding. None of them records anything; the
 * result's `decision` tells them apart.
 */
export function answerSubmissionProbeExitCode(
  verdict: Awaited<ReturnType<typeof probeConfiguredAnswerSubmission>>,
): number {
  if (verdict.decision === "go") return 0;
  return verdict.decision === "contingency-required" ? 2 : 1;
}

/** Human lines for an answer-submission probe verdict, and where its observation was kept. */
export function formatAnswerSubmissionProbe(
  verdict: Awaited<ReturnType<typeof probeConfiguredAnswerSubmission>>,
  observationPath?: string,
): string[] {
  if (verdict.decision === "not-checked") {
    return [`Answer submission probe: not checked. ${verdict.reason}`];
  }
  const counted = `${String(verdict.observation.samples.length)} requests at an output limit of ${String(verdict.observation.maxOutputTokens)} tokens`;
  const kept = [
    `  Observation: ${observationPath ?? "not written"} (evidenceSha256 ${verdict.evidenceSha256})`,
  ];
  if (verdict.decision === "go") {
    const capability = verdict.capability;
    return [
      `Answer submission probe: GO (${counted})`,
      `  Capability: kind=${capability.kind}, argumentShell=${capability.argumentShell}, duplicateKeys=${capability.duplicateKeys}, reportTurnToolChoice=${capability.reportTurnToolChoice}, objectMembers=${capability.objectMembers ?? "unrecorded"}`,
      ...verdict.notes.map((note) => `  Note: ${note}`),
      ...kept,
    ];
  }
  if (verdict.decision === "contingency-required") {
    return [
      `Answer submission probe: CONTINGENCY REQUIRED (${counted})`,
      `  ${verdict.reason}`,
      `  The typed-shell contingency adds up to ${String(verdict.contingencyRequests)} requests; a rerun with --answer-submission-typed-contingency sends at most ${String(verdict.rerunMaxRequests)}.`,
      `  Next action: ${verdict.nextAction}`,
      ...kept,
    ];
  }
  if (verdict.decision === "inconclusive") {
    return [
      `Answer submission probe: INCONCLUSIVE (${counted})`,
      `  ${verdict.reason}`,
      ...verdict.transportErrors.map(
        (failure) =>
          `  Transport: ${failure.variant} ${failure.class} after ${String(failure.elapsedMs)} ms, ${String(failure.streamedBytes)} bytes streamed${failure.retried ? ", re-sent" : ""}`,
      ),
      `  Next action: ${verdict.nextAction}`,
      ...kept,
    ];
  }
  return [
    `Answer submission probe: NO-GO (${counted})`,
    `  Stop class: ${verdict.stopClass}; cause ${verdict.cause}. ${verdict.reason}`,
    `  Next action: ${verdict.nextAction}`,
    ...kept,
  ];
}

type NotChecked = {
  readonly decision: "not-checked";
  readonly reason: string;
  /** Set when the record-probe ledger or its lock refused the run. */
  readonly code?: AnswerRecordLedgerRefusal;
};

/** Why the small-group ledger refused a run: an unusable ledger, or a held lock. */
export type AnswerRecordLedgerRefusal =
  | "answer-record-ledger-invalid"
  | "answer-record-ledger-locked";

/** The lock file that keeps a second record-probe run out of `answer-record-probes/`. */
export const ANSWER_RECORD_LEDGER_LOCK = "ledger.lock";

/** A problem that did not change the record probe's verdict, shown beside it. */
export interface AnswerRecordProbeWarning {
  readonly code: "answer-record-ledger-lock-not-released";
  readonly message: string;
}

/** File operations `recordAnswerRecordProbe` uses; a test may replace them. */
export interface AnswerRecordProbeFiles {
  readonly writeFile: typeof writeFile;
  readonly rm: typeof rm;
}

/**
 * The record probe on the bound request path (`docsfab doctor --live
 * --answer-records`), keeping its observation in `observationDirectory`, named
 * by its evidenceSha256. The run holds an exclusive lock on that directory
 * from before the ledger read until the observation is kept, so two runs
 * cannot spend the same remainder. A small-group run first writes a
 * reservation of everything the ledger has left, and the observation replaces
 * it only after the observation is written, so an interrupted run stays
 * charged. The probe fetch is wrapped in `captureProxyRefusal`, so a proxy
 * that refuses a request stops the run with its own code.
 */
export async function recordAnswerRecordProbe(
  model: DocsFabConfig["model"],
  options: {
    readonly corpusPath: string;
    readonly selection?: AnswerRecordProbeSelection;
    readonly qualificationCells?: boolean;
    readonly expectedQualificationFingerprint?: string;
    readonly diagnosticCell?: true;
    readonly expectedDiagnosticFingerprint?: string;
    readonly typedContextMix?: boolean;
    readonly typedContextGroupOnly?: boolean;
    readonly observationDirectory: string;
    readonly onPlan?: (plan: AnswerRecordProbePlan) => void;
    readonly files?: AnswerRecordProbeFiles;
  },
): Promise<{
  readonly verdict: AnswerRecordProbeVerdict | NotChecked;
  readonly observationPath?: string;
  /** Problems that did not change the verdict, such as a lock that could not be removed. */
  readonly warnings?: readonly AnswerRecordProbeWarning[];
}> {
  const files = options.files ?? { writeFile, rm };
  const directory = options.observationDirectory;
  await mkdir(directory, { recursive: true });
  const lock = join(directory, ANSWER_RECORD_LEDGER_LOCK);
  try {
    await files.writeFile(
      lock,
      `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
      { flag: "wx", mode: 0o600 },
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return {
      verdict: {
        decision: "not-checked",
        code: "answer-record-ledger-locked",
        reason: `Another record-probe run holds ${lock}, so nothing was sent. Wait for it to finish. A run that died leaves the lock: confirm that no docsfab doctor --answer-records run is alive, then remove ${lock}; the lock is never broken automatically.`,
      },
    };
  }
  const release = async (): Promise<AnswerRecordProbeWarning | undefined> => {
    try {
      await files.rm(lock, { force: true });
      return undefined;
    } catch (error) {
      return {
        code: "answer-record-ledger-lock-not-released",
        message: `The run ended but ${lock} could not be removed (${error instanceof Error ? error.message : String(error)}), so the next run will be refused until it is. Confirm that no docsfab doctor --answer-records run is alive, then remove it.`,
      };
    }
  };
  let result: Awaited<ReturnType<typeof recordAnswerRecordProbe>>;
  try {
    result = await recordLocked();
  } catch (error) {
    // The run's own failure stays the failure; a lock that also stayed is added to it.
    const warning = await release();
    if (!warning) throw error;
    const failure = error instanceof Error ? error : new Error(String(error), { cause: error });
    failure.message = `${failure.message} Also ${warning.code}: ${warning.message}`;
    throw failure;
  }
  const warning = await release();
  return warning ? { ...result, warnings: [warning] } : result;

  async function recordLocked(): Promise<Awaited<ReturnType<typeof recordAnswerRecordProbe>>> {
    const target = await answerRecordProbeTarget(model, options);
    if ("decision" in target) return { verdict: target };
    const keep = async (text: string): Promise<string> => {
      const path = join(directory, `${createHash("sha256").update(text).digest("hex")}.json`);
      await files.writeFile(path, text, { mode: 0o600 });
      return path;
    };
    let reservationPath: string | undefined;
    const verdict = await probeAnswerRecords({
      ...target,
      onReserve: async (reservation) => {
        reservationPath = await keep(canonicalJson(reservation));
      },
    });
    // The observation first: a run whose observation was not written stays
    // charged by its reservation.
    const observationPath = await keep(canonicalJson(verdict.observation));
    if (reservationPath !== undefined) await files.rm(reservationPath, { force: true });
    return { verdict, observationPath };
  }
}

/**
 * The premise run (phases A, B and C) on the bound request path, keeping
 * nothing. The small-group run spends a ledger, so it runs only through
 * `recordAnswerRecordProbe`.
 */
export async function probeConfiguredAnswerRecords(
  model: DocsFabConfig["model"],
  options: {
    /** The record corpus file the operator names with `--answer-record-corpus`. */
    readonly corpusPath: string;
    readonly onPlan?: (plan: AnswerRecordProbePlan) => void;
  },
): Promise<AnswerRecordProbeVerdict | NotChecked> {
  const target = await answerRecordProbeTarget(model, { ...options, selection: "premise" });
  return "decision" in target ? target : probeAnswerRecords(target);
}

/**
 * The record probe's target: the binding's request policy and effective
 * output limit, every request on the bound attempt timer, the record probe's
 * own retry, request, and input-token limits, the named record corpus, and
 * Pi's argument validation. `not-checked` for a route the probe cannot speak
 * to, or when the corpus or Pi's validation is not available. The corpus is
 * internal evidence that the package does not ship, so the operator names it.
 */
async function answerRecordProbeTarget(
  model: DocsFabConfig["model"],
  options: {
    readonly corpusPath: string;
    readonly selection?: AnswerRecordProbeSelection;
    /** Provider-free planning must not perform endpoint DNS resolution. */
    readonly providerFreePlan?: true;
    readonly qualificationCells?: boolean;
    readonly expectedQualificationFingerprint?: string;
    readonly diagnosticCell?: true;
    readonly expectedDiagnosticFingerprint?: string;
    readonly typedContextMix?: boolean;
    readonly typedContextGroupOnly?: boolean;
    readonly observationDirectory?: string;
    readonly onPlan?: (plan: AnswerRecordProbePlan) => void;
  },
): Promise<AnswerRecordProbeTarget | NotChecked> {
  if (
    options.typedContextGroupOnly === true &&
    (options.selection !== "typed" || options.typedContextMix !== true)
  ) {
    return {
      decision: "not-checked",
      reason:
        "The one-request context continuation requires the typed context screen selection; nothing was sent.",
    };
  }
  if (
    options.diagnosticCell === true &&
    (options.selection !== "typed" ||
      options.qualificationCells === true ||
      options.typedContextMix === true ||
      options.typedContextGroupOnly === true)
  ) {
    return {
      decision: "not-checked",
      reason:
        "The one-cell B diagnostic is available only as its separate typed-shell plan; no request was sent.",
    };
  }
  const binding = options.providerFreePlan
    ? await resolveOperatorExecutionIdentity({ model })
    : await resolveOperatorExecutionBinding({ model });
  const selection = options.selection ?? "premise";
  if (model.apiFormat !== "chat_completions") {
    return {
      decision: "not-checked",
      reason: "The answer-record probe speaks OpenAI-compatible chat completions only.",
    };
  }
  const deploymentBinding: AnswerRecordProbeDeploymentBinding =
    binding.bound?.composition.deployment.transport === "openai-chat-completions"
      ? {
          status: "bound",
          routeId: binding.bound.composition.deployment.routeId,
          deploymentIdentitySha256: binding.bound.composition.deployment.identitySha256,
          transport: binding.bound.composition.deployment.transport,
        }
      : { status: "unavailable", reason: "unmatched-byo" };
  let corpusText: string;
  try {
    corpusText = await readFile(options.corpusPath, "utf8");
  } catch {
    return {
      decision: "not-checked",
      reason:
        "The answer-record corpus file named by --answer-record-corpus could not be read, so nothing was sent.",
    };
  }
  const corpusSha256 = createHash("sha256").update(corpusText).digest("hex");
  // The GO bound comes from the corpus, so only the committed corpus is sent.
  if (corpusSha256 !== ANSWER_RECORD_CORPUS_SHA256) {
    return {
      decision: "not-checked",
      reason: `The answer-record corpus has SHA-256 ${corpusSha256}, not the committed corpus's ${ANSWER_RECORD_CORPUS_SHA256}, so nothing was sent.`,
    };
  }
  let corpus: ReturnType<typeof decodeAnswerRecordCorpus>;
  try {
    corpus = decodeAnswerRecordCorpus(corpusText);
  } catch (error) {
    if (!(error instanceof AnswerRecordCorpusError)) throw error;
    return { decision: "not-checked", reason: error.message };
  }
  let ledger: AnswerRecordLedger | undefined;
  if (selection === "small-groups") {
    const read = await readAnswerRecordLedger(options.observationDirectory);
    if ("decision" in read) return read;
    ledger = read;
  } else if (selection === "typed") {
    const read = await readAnswerRecordTypedLedger(
      options.observationDirectory,
      options.typedContextGroupOnly === true,
    );
    if ("decision" in read) return read;
    ledger = read;
  }
  const pi = await loadPiToolArgumentValidation();
  if (!pi) {
    return {
      decision: "not-checked",
      reason:
        "Pi's tool-argument validation could not be loaded, so the probe cannot decide calls as production does.",
    };
  }
  if (!options.providerFreePlan) {
    await assertLocalhostEndpointResolvesToLoopback(model.baseUrl);
  }
  const maxOutputTokens = binding.profile.profile.maxOutputTokens;
  const profile = binding.profile.profile;
  const credential = options.providerFreePlan
    ? undefined
    : (binding as OperatorExecutionBinding).credential;
  const capture = credential ? captureProxyRefusal(createProbeFetch(model.baseUrl)) : undefined;
  const finalizeBody = credential
    ? boundRequestFinalizer(binding, credential.apiKey, maxOutputTokens)
    : undefined;
  return {
    modelId: model.modelId,
    deploymentBinding,
    ...(binding.bound?.composition
      ? {
          compositionBinding: {
            compositionId: binding.bound.composition.compositionId,
            compositionSha256: binding.bound.composition.compositionSha256,
            ...(binding.bound.composition.requestPolicy
              ? { requestPolicySha256: binding.bound.composition.requestPolicy.policySha256 }
              : {}),
          },
        }
      : {}),
    ...(credential
      ? {
          provider: {
            baseUrl: model.baseUrl,
            credential: releaseModelCredential(
              {
                endpoint: model.baseUrl,
                endpointSource: model.endpointSource,
                apiKey: credential.apiKey,
              },
              "endpoint-probe",
            ),
          },
        }
      : {}),
    maxOutputTokens,
    samplesPerRung: limit("endpointProbe.answerRecordSamples").value,
    selection,
    ...(options.qualificationCells ? { qualificationCells: true } : {}),
    ...(options.expectedQualificationFingerprint
      ? { expectedQualificationFingerprint: options.expectedQualificationFingerprint }
      : {}),
    ...(options.diagnosticCell ? { diagnosticCell: true as const } : {}),
    ...(options.expectedDiagnosticFingerprint
      ? { expectedDiagnosticFingerprint: options.expectedDiagnosticFingerprint }
      : {}),
    ...(options.typedContextMix === true ? { typedContextMix: true } : {}),
    ...(options.typedContextGroupOnly === true ? { typedContextGroupOnly: true } : {}),
    decodeWindowMinBasisPoints: limit("endpointProbe.answerRecordDecodeWindowMinBasisPoints").value,
    maxProviderTurns:
      binding.bound?.composition.compositionLimits.maxProviderTurns ??
      limit("compositionExecution.maxProviderTurns").value,
    answerNowShareBasisPoints: limit("compositionExecution.answerNowElapsedShareBasisPoints").value,
    systemPrompt: DOCSFAB_SYSTEM_PROMPT,
    shape: chatCompletionsProbeShape({
      providerId: model.providerId,
      baseUrl: model.baseUrl,
      requestPolicy: binding.bound?.composition.requestPolicy !== undefined,
      reasoning: profile.reasoning,
      supportsDeveloperRole: profile.compatibility.supportsDeveloperRole,
    }),
    fetch:
      capture?.fetch ??
      (async () => {
        throw new Error(
          "Provider-free answer-record plans cannot issue network requests during planning.",
        );
      }),
    ...(capture ? { throwIfRefused: () => capture.throwIfRefused() } : {}),
    // Every record turn runs on the attempt timer a production turn has: the
    // bound composition's, or the request timeout on a lane without one.
    timeoutMs:
      binding.bound?.composition.compositionLimits.timeoutMs ??
      limit("endpointProbe.requestTimeoutMs").value,
    transportRetries:
      options.qualificationCells || options.diagnosticCell
        ? 0
        : selection === "typed"
          ? remainderOf(
              limit("endpointProbe.answerRecordTransportRetries"),
              ledger?.transportRetriesUsed ?? 0,
            ).value
          : limit("endpointProbe.answerRecordTransportRetries").value,
    ...(ledger
      ? {
          // The typed slice has its own 1b request tranche but shares the
          // combined input-token and transport-retry ceilings with retained
          // 1a evidence. The untyped K selection keeps its existing ledger.
          requestBudget:
            selection === "typed"
              ? remainderOf(
                  limit("endpointProbe.answerRecordTypedRequestBudget"),
                  ledger.typedRequests ?? 0,
                )
              : remainderOf(limit("endpointProbe.answerRecordGroupRequestBudget"), ledger.requests),
          inputTokenBudget:
            selection === "typed"
              ? remainderOf(limit("endpointProbe.answerRecordInputTokenBudget"), ledger.inputTokens)
              : remainderOf(
                  limit("endpointProbe.answerRecordGroupInputTokenBudget"),
                  ledger.inputTokens,
                ),
          ledger,
        }
      : {
          requestBudget: limit("endpointProbe.answerRecordRequestBudget"),
          inputTokenBudget: limit("endpointProbe.answerRecordInputTokenBudget"),
        }),
    corpus,
    corpusSha256,
    pi,
    ...(options.onPlan ? { onPlan: options.onPlan } : {}),
    errorBodyMaxChars: limit("endpointProbe.providerMessageMaxChars").value,
    credentialEchoMinChars: limit("endpointProbe.credentialEchoMinChars").value,
    ...(finalizeBody ? { finalizeBody } : {}),
  };
}

/** Provider-free qualification planner; resolves the installed route and its exact request policy. */
export async function planAnswerRecordQualification(
  model: DocsFabConfig["model"],
  options: {
    readonly corpusPath: string;
    readonly selection: "typed" | "premise";
    readonly observationDirectory?: string;
  },
): Promise<ReturnType<typeof buildAnswerRecordQualificationPlan> | NotChecked> {
  const target = await answerRecordProbeTarget(model, {
    corpusPath: options.corpusPath,
    selection: options.selection,
    providerFreePlan: true,
    ...(options.observationDirectory ? { observationDirectory: options.observationDirectory } : {}),
  });
  if ("decision" in target) return target;
  const bindingIssue = qualificationBindingIssue(target);
  if (bindingIssue) return { decision: "not-checked", reason: bindingIssue };
  return buildAnswerRecordQualificationPlan(target);
}

/** Provider-free plan for the single pinned B/6,144/seed-1 diagnostic cell. */
export async function planAnswerRecordDiagnostic(
  model: DocsFabConfig["model"],
  options: {
    readonly corpusPath: string;
    readonly observationDirectory: string;
  },
): Promise<ReturnType<typeof buildAnswerRecordDiagnosticPlan> | NotChecked> {
  const target = await answerRecordProbeTarget(model, {
    corpusPath: options.corpusPath,
    selection: "typed",
    providerFreePlan: true,
    diagnosticCell: true,
    observationDirectory: options.observationDirectory,
  });
  if ("decision" in target) return target;
  try {
    return buildAnswerRecordDiagnosticPlan(target);
  } catch (error) {
    if (!(error instanceof AnswerRecordCorpusError)) throw error;
    return { decision: "not-checked", reason: error.message };
  }
}

/** Where `docsfab doctor --live --answer-records` keeps its observations, beside the run state. */
export function answerRecordObservationDirectory(stateDirectory: string): string {
  return resolve(dirname(stateDirectory), "answer-record-probes");
}

/** An approved total less what the ledger spent; the refusal names the remainder. */
function remainderOf(approved: ResolvedLimit, spent: number): ResolvedLimit {
  return { ...approved, value: Math.max(0, approved.value - spent) };
}

/** Read every retained observation in `directory` into the small-group ledger. */
async function readAnswerRecordLedger(
  directory: string | undefined,
): Promise<AnswerRecordLedger | NotChecked> {
  const refused = (detail: string): NotChecked => ({
    decision: "not-checked",
    code: "answer-record-ledger-invalid",
    reason: `The small-group run needs the retained answer-record observations to know what the approval has left, so nothing was sent: ${detail} Put the premise run's observation ${ANSWER_RECORD_PREMISE_EVIDENCE_SHA256}.json in ${directory ?? "the answer-record-probes directory beside the run state"}.`,
  });
  if (directory === undefined) return refused("no observation directory was given.");
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return refused("the observation directory could not be read.");
  }
  const named = entries
    .filter((entry) => entry.name.endsWith(".json"))
    .sort((left, right) => left.name.localeCompare(right.name));
  const odd = named.find((entry) => !entry.isFile());
  if (odd) return refused(`${odd.name} in the observation directory is not a file.`);
  let files: { name: string; text: string }[];
  try {
    files = await Promise.all(
      named.map(async (entry) => ({
        name: entry.name,
        text: await readFile(join(directory, entry.name), "utf8"),
      })),
    );
  } catch {
    return refused("a retained observation could not be read.");
  }
  try {
    return answerRecordLedger(files);
  } catch (error) {
    if (!(error instanceof AnswerRecordLedgerError)) throw error;
    return refused(error.message);
  }
}

/**
 * Read the retained 1a/1b evidence needed to prove combined input-token and
 * shared-retry headroom before slice 1b can send. Unlike the small-group
 * ledger, this counts every prior record-probe observation against the
 * design's combined 600,000-token ceiling.
 */
async function readAnswerRecordTypedLedger(
  directory: string | undefined,
  requireGroupContinuation = false,
): Promise<AnswerRecordLedger | NotChecked> {
  const refused = (detail: string): NotChecked => ({
    decision: "not-checked",
    code: "answer-record-ledger-invalid",
    reason: `The typed slice needs the retained probe ledger to prove combined input-token and shared-retry headroom, so nothing was sent: ${detail} Preserve the 1a premise observation ${ANSWER_RECORD_PREMISE_EVIDENCE_SHA256}.json and every later reservation or observation.`,
  });
  if (directory === undefined) return refused("no observation directory was given.");
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return refused("the observation directory could not be read.");
  }
  const named = entries
    .filter((entry) => entry.name.endsWith(".json"))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (named.some((entry) => !entry.isFile()))
    return refused("a retained JSON entry is not a file.");
  let files: { name: string; text: string }[];
  try {
    files = await Promise.all(
      named.map(async (entry) => ({
        name: entry.name,
        text: await readFile(join(directory, entry.name), "utf8"),
      })),
    );
  } catch {
    return refused("a retained observation could not be read.");
  }
  try {
    const ledger = answerRecordTypedLedger(files);
    if (
      requireGroupContinuation &&
      (ledger.reservations !== 0 || !hasPinnedContextGroupContinuation(files))
    ) {
      return refused(
        "the one-request continuation requires the exact retained six-singleton observation with its group unsent; it cannot replay a group or substitute another ledger.",
      );
    }
    return ledger;
  } catch (error) {
    if (!(error instanceof AnswerRecordLedgerError)) throw error;
    return refused(error.message);
  }
}

/**
 * The request body finalizer a bound route applies: the composition's
 * request policy, or else the reasoning control measured for an unmatched
 * endpoint's model; none when neither applies.
 */
function boundRequestFinalizer(
  binding: OperatorExecutionIdentityBinding,
  apiKey: string,
  maxOutputTokens: number,
): ((body: Record<string, unknown>) => Record<string, unknown>) | undefined {
  const policy = binding.bound?.composition.requestPolicy;
  if (policy) {
    return (body) => ({
      ...finalizeNvidiaApiCatalogPayload({
        rawPayload: body,
        policy,
        exactCredential: apiKey,
        maxOutputTokens,
      }).payload,
    });
  }
  const reasoningControl = binding.profile.measuredReasoningControl?.control;
  if (!reasoningControl) return undefined;
  return (body) => {
    const finalized = { ...body };
    applyReasoningControl(finalized, reasoningControl);
    return finalized;
  };
}

/** The plan line printed before the record probe sends anything. */
export function formatAnswerRecordProbePlan(plan: AnswerRecordProbePlan): string {
  if (plan.diagnosticFingerprint) {
    return `Answer record diagnostic plan: one B/6,144/seed-1 nine-call request; estimated input ${String(plan.plannedInputTokens)} tokens of ${String(plan.inputTokenBudget)} remaining; typed request remainder ${String(plan.requestBudget)}; shared retries 0; diagnostic fingerprint ${plan.diagnosticFingerprint}. Billing cost is not reported. This cell cannot qualify or activate answer records.`;
  }
  if (plan.selection === "typed") {
    if (plan.typedContextMix) {
      if (plan.typedContextGroupOnly) {
        return `Answer record typed context continuation plan: ${String(plan.requests)} request for the previously unsent two-record dimension+finding group, padded to P=${String(plan.paddingTargetTokens)}; no singleton re-runs. Shared retries remaining: ${String(plan.transportRetries)}; combined input ${String(plan.plannedInputTokens)} planned of ${String(plan.inputTokenBudget)} remaining tokens; ${String(plan.paddedRetriesThatFit)} padded retry fits.${plan.ledger === null ? "" : ` The ledger charges ${String(plan.ledger.inputTokens)} combined input tokens and ${String(plan.ledger.transportRetriesUsed ?? 0)} shared retries; typed tranche already charged ${String(plan.ledger.typedRequests ?? 0)} requests.`}`;
      }
      return `Answer record typed context screen plan: ${String(plan.requests)} requests (six P=${String(plan.paddingTargetTokens)} singleton maxima plus one two-record dimension+finding group); Phase G remains policy-blocked (0 requests). Shared retries remaining from retained observations: ${String(plan.transportRetries)}; combined input ${String(plan.plannedInputTokens)} planned of ${String(plan.inputTokenBudget)} remaining tokens; ${String(plan.paddedRetriesThatFit)} retry fits the complete screen.${plan.ledger === null ? "" : ` The ledger charges ${String(plan.ledger.inputTokens)} combined input tokens and ${String(plan.ledger.transportRetriesUsed ?? 0)} shared retries; typed tranche already charged ${String(plan.ledger.typedRequests ?? 0)} requests.`}`;
    }
    return `Answer record typed slice 1b plan: ${String(plan.requests)} A-t requests; phase G will not execute (0 requests, request-policy-blocked). Shared retries remaining from retained observations: ${String(plan.transportRetries)}; combined input ${String(plan.plannedInputTokens)} planned of ${String(plan.inputTokenBudget)} remaining tokens.${plan.ledger === null ? "" : ` The ledger charges ${String(plan.ledger.inputTokens)} combined input tokens and ${String(plan.ledger.transportRetriesUsed ?? 0)} shared retries; typed tranche already charged ${String(plan.ledger.typedRequests ?? 0)} requests.`}`;
  }
  if (plan.selection === "small-groups") {
    return `Answer record small-group plan: ${String(plan.requests)} requests (k = 2 and 3 records per message, each prompt padded to P=${String(plan.paddingTargetTokens)}), plus at most ${String(plan.paddedRetriesThatFit)} transport re-sends that fit, paid from that remainder and never from the shared transport retries; input ${String(plan.plannedInputTokens)} tokens planned, within what the approval has left${plan.ledger === null ? "" : ` after ${String(plan.ledger.observations)} recorded run(s) spent ${String(plan.ledger.requests)} requests and ${String(plan.ledger.inputTokens)} input tokens`}: ${String(plan.requestBudget)} requests and ${String(plan.inputTokenBudget)} input tokens.`;
  }
  return `Answer record probe plan: at most ${String(plan.requests)} requests plus ${String(plan.transportRetries)} transport retries; input ${String(plan.plannedInputTokens)} tokens planned (${String(plan.paddedRequests)} phase B prompts × P=${String(plan.paddingTargetTokens)}: ${String(plan.paddedInputTokens)}, plus ${String(plan.otherInputTokens)}) of ${String(plan.inputTokenBudget)} approved.${plan.paddedRetryFits ? "" : " A phase B transport failure cannot be re-sent within that budget and ends the run INCONCLUSIVE."}`;
}

/**
 * The machine-readable result `docsfab doctor --live --answer-records --json`
 * prints. Only NO-GO carries a stop class.
 */
export function answerRecordProbeResult(
  verdict: AnswerRecordProbeVerdict | NotChecked,
  observationPath?: string,
  warnings: readonly AnswerRecordProbeWarning[] = [],
): Record<string, unknown> {
  return {
    ...answerRecordVerdictResult(verdict, observationPath),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

function answerRecordVerdictResult(
  verdict: AnswerRecordProbeVerdict | NotChecked,
  observationPath?: string,
): Record<string, unknown> {
  if (verdict.decision === "not-checked") {
    return {
      schemaVersion: 1,
      kind: "docsfab-answer-record-probe-result",
      decision: verdict.decision,
      ...(verdict.code === undefined ? {} : { code: verdict.code }),
      reason: verdict.reason,
    };
  }
  return {
    schemaVersion: 1,
    kind: "docsfab-answer-record-probe-result",
    decision: verdict.decision,
    measurement: verdict.measurement,
    ...(verdict.decision === "no-go"
      ? { stopClass: verdict.stopClass, cause: verdict.cause, reason: verdict.reason }
      : {}),
    ...(verdict.decision === "inconclusive"
      ? { reason: verdict.reason, transportErrors: verdict.transportErrors }
      : {}),
    ...(verdict.observation.selection === "typed"
      ? { shell: verdict.observation.shell, phaseG: verdict.observation.phaseG }
      : {}),
    notes: verdict.notes,
    nextAction: verdict.nextAction,
    ...(observationPath === undefined
      ? {}
      : { evidenceSha256: verdict.evidenceSha256, observationPath }),
  };
}

/**
 * GO, and a small-group run that decided every group size it reached, exit 0;
 * NO-GO, `inconclusive`, and `not-checked` exit 1.
 */
export function answerRecordProbeExitCode(verdict: AnswerRecordProbeVerdict | NotChecked): number {
  return verdict.decision === "go" ||
    verdict.decision === "measured" ||
    verdict.decision === "diagnostic"
    ? 0
    : 1;
}

/** Human lines for an answer-record probe verdict, and where its observation was kept. */
export function formatAnswerRecordProbe(
  verdict: AnswerRecordProbeVerdict | NotChecked,
  observationPath?: string,
  warnings: readonly AnswerRecordProbeWarning[] = [],
): string[] {
  return [
    ...formatAnswerRecordVerdict(verdict, observationPath),
    ...warnings.map((warning) => `  Warning (${warning.code}): ${warning.message}`),
  ];
}

function formatAnswerRecordVerdict(
  verdict: AnswerRecordProbeVerdict | NotChecked,
  observationPath?: string,
): string[] {
  if (verdict.decision === "not-checked") {
    return [
      `Answer record probe: not checked${verdict.code === undefined ? "" : ` (${verdict.code})`}. ${verdict.reason}`,
    ];
  }
  if (verdict.decision === "diagnostic") {
    return [
      `Answer record diagnostic only: ${verdict.outcome}; one B-cell request, not a qualification result. Evidence ${verdict.evidenceSha256}${observationPath ? ` retained at ${observationPath}` : ""}. Billing cost not reported. ${verdict.nextAction}`,
    ];
  }
  const { measurement } = verdict;
  const bytes = (value: number | null) => (value === null ? "none" : `${String(value)} B`);
  const counted = `${String(measurement.requests)} requests at an output limit of ${String(verdict.observation.maxOutputTokens)} tokens`;
  const decision = {
    go: "GO",
    "no-go": "NO-GO",
    measured: "MEASURED",
    inconclusive: "INCONCLUSIVE",
  }[verdict.decision];
  const small = verdict.observation.selection === "small-groups";
  const typed = verdict.observation.selection === "typed";
  const ms = (value: number | null) => (value === null ? "none" : `${String(value)} ms`);
  const tokens = (value: number | null) => (value === null ? "unreported" : String(value));
  const typedCalls = typed
    ? verdict.observation.samples
        .filter(
          (sample) =>
            sample.phase === (verdict.observation.typedContextMix ? "A-t-context" : "A-t"),
        )
        .flatMap((sample) => sample.calls)
    : [];
  const contextSingletonCount = verdict.observation.samples.filter(
    (sample) =>
      sample.phase === "A-t-context" &&
      sample.expectedCalls === 1 &&
      sample.httpStatus >= 200 &&
      sample.httpStatus < 300 &&
      sample.ttftMs !== null,
  ).length;
  const rate =
    measurement.decodeTokensPerSecond === null
      ? "unmeasured"
      : `${String(measurement.decodeTokensPerSecond)} tokens/s (${measurement.decodeRateSource === "stream-window" ? `argument window, ${String(measurement.decodeRateSamples.streamWindow)} samples` : `end to end with prefill, a lower bound; no argument window in ${String(measurement.decodeRateSamples.endToEnd)} samples`})`;
  const lines = [
    `Answer record ${small ? "small-group probe" : typed ? (verdict.observation.typedContextMix ? "typed context screen" : "typed A-t probe") : "probe"}: ${decision} (${counted})`,
    ...(typed
      ? [
          `  Planned-envelope matches: ${String(typedCalls.filter((call) => call.deepEqual).length)}/${String(typedCalls.length)}; size/schema admission is separate and does not qualify exact copying or capability GO.`,
          "  Phase G: not executed (0 requests); the bound request policy blocks guided JSON.",
          ...(verdict.observation.typedContextMix
            ? [
                `  Singleton context timing: ${ms(measurement.typedContextSingletonTtftP90Ms)} p90 from ${String(contextSingletonCount)} completed singleton sample(s); two-call group TTFT: ${ms(measurement.typedContextGroupTtftMs)} (one exploratory sample).`,
                "  This measurement does not satisfy the #1967 live-probe GO prerequisite for #1970 or the 43-record turn-fit gate.",
              ]
            : []),
        ]
      : []),
    ...(verdict.decision === "no-go"
      ? [`  Stop class: ${verdict.stopClass}; cause ${verdict.cause}. ${verdict.reason}`]
      : verdict.decision === "inconclusive"
        ? [
            `  ${verdict.reason}`,
            ...verdict.transportErrors.map(
              (failure) =>
                `  Transport: phase ${failure.phase} ${String(failure.rungBytes)} B ${failure.class} after ${String(failure.elapsedMs)} ms, ${String(failure.streamedBytes)} bytes streamed${failure.retried ? ", re-sent" : failure.retryWithheld === "input-budget" ? ", not re-sent: the re-send does not fit the input-token budget" : failure.retryWithheld === "request-budget" ? ", not re-sent: the re-send does not fit the request budget" : failure.retryWithheld === "retries-exhausted" ? ", not re-sent: no transport retries left" : ""}`,
            ),
          ]
        : []),
    ...(small
      ? measurement.groups.flatMap((group) => [
          `  Group k=${String(group.recordsPerMessage)}: ${group.admitted ? `admitted ${String(group.admittedSeeds)}/${String(group.seeds)}` : group.state === "unsent" ? "not sent" : `not admitted (${String(group.admittedSeeds)} of ${String(group.seeds)} seeds admitted${group.failures.length > 0 ? `; ${group.failures.join(", ")}` : ""})`}; implied M ${String(group.impliedMessages)} (${Object.entries(
            group.impliedMessagesByFixture,
          )
            .map(([fixture, messages]) => `fixture ${fixture} ${String(messages)}`)
            .join(", ")})`,
          ...verdict.observation.samples
            .filter(
              (sample) => sample.phase === "K" && sample.expectedCalls === group.recordsPerMessage,
            )
            .map(
              (sample) =>
                `    seed ${String(sample.seed)}${sample.retryOf === null ? "" : " (re-send)"}: ${sample.admitted ? "admitted" : (sample.failure ?? sample.transportError ?? "not admitted")}; TTFT ${ms(sample.ttftMs)}, elapsed ${ms(sample.elapsedMs)}, arguments ${ms(sample.firstArgumentDeltaMs)} to ${ms(sample.lastArgumentDeltaMs)}, output ${tokens(sample.outputTokens)} tokens, prompt ${tokens(sample.promptTokens)} (cached ${tokens(sample.cachedPromptTokens)}) tokens`,
            ),
        ])
      : [
          `  Records: maxRecordBytes ${bytes(measurement.maxRecordBytes)} (GO needs ${String(measurement.requiredRecordBytes)} B); maxMessageBytes ${bytes(measurement.maxMessageBytes)} (budget term ${String(measurement.messageBudgetBytes)} B); escape mix ${measurement.escapeMix}; record members ${measurement.recordMembers ?? "none admitted"}`,
        ]),
    `  Timing: Lturn p90 TTFT ${measurement.ttftP90Ms === null ? "unmeasured" : `${String(measurement.ttftP90Ms)} ms`}; r ${rate}; end-to-end median ${measurement.endToEndTokensPerSecond === null ? "unmeasured" : `${String(measurement.endToEndTokensPerSecond)} tokens/s`}; retained per-turn upper bound ${String(measurement.turnUpperBoundMs)} ms`,
    ...measurement.projections.map(
      (projection) =>
        `  Projection (not measured), k=${String(projection.recordsPerMessage)}: M ${String(projection.messages)}; step 8 record-turn input ${String(projection.recordTurnInputTokens)} tokens (cached ${String(projection.cachedInputTokens)}); A ${String(projection.answerSeconds)} s; T* ${String(projection.timerSeconds)} s; turn fit ${String(projection.maxProviderTurns)} − (2M + 1) = ${String(projection.readingTurnsLeft)} reading turns`,
    ),
    ...verdict.notes.map((note) => `  Note: ${note}`),
    `  Next action: ${verdict.nextAction}`,
    `  Corpus: sha256 ${verdict.observation.corpusSha256}`,
    `  Observation: ${observationPath ?? "not written"} (evidenceSha256 ${verdict.evidenceSha256})`,
  ];
  return lines;
}

export async function checkLiveModel(
  config: DocsFabConfig,
  dependencies: LiveModelDependencies = {},
): Promise<LiveCheckResult> {
  const compatibility = await (
    dependencies.probeCompatibility ?? probeConfiguredEndpointCompatibility
  )(config.model);
  if (compatibility.verdict === "incompatible") throw new EndpointCompatibilityError(compatibility);
  const startedAt = Date.now();
  const resourceLoader = new DefaultResourceLoader({
    cwd: config.projectRoot,
    agentDir: getAgentDir(),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: "You are a connectivity probe. Follow the response instruction exactly.",
  });
  await resourceLoader.reload();
  const connection = await createModelConnection(config.model);
  // Pi states the session cwd in the system prompt, so the install root stays host-side.
  const { session } = await createAgentSession({
    cwd: VIRTUAL_WORKSPACE_CWD,
    modelRuntime: connection.runtime,
    model: connection.model,
    resourceLoader,
    sessionManager: SessionManager.inMemory(VIRTUAL_WORKSPACE_CWD),
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false },
      cacheWarming: "off",
      retry: { enabled: false, provider: { maxRetries: 0 } },
    }),
    noTools: "all",
  });

  let response = "";
  session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      response += event.assistantMessageEvent.delta;
    }
  });

  try {
    await session.prompt("Reply with exactly: DOCSFAB_OK");
    const modelError = session.agent.state.errorMessage;
    // Pi reports a proxy that failed the request as connection-error text; the
    // transport kept the refusal with its code. Any other error stays as is.
    if (modelError) throw connection.providerTransport?.lastProxyRefusal() ?? new Error(modelError);
    if (response.trim() !== "DOCSFAB_OK") {
      throw new Error("Model returned an unexpected connectivity response.");
    }
    return { latencyMs: Date.now() - startedAt, compatibility };
  } finally {
    session.dispose();
  }
}

/**
 * Profile doctor actually reports. A unique composition match applies the
 * `compositionExecutionProfile` reduction; unmatched BYO YAML stays as loaded
 * because that route returns normally. Binding refusals (ambiguous unique
 * match, retired or invalid selected composition, missing required request
 * policy) propagate so doctor cannot print an unbound profile as ready.
 */
export async function resolveDoctorModelProfile(
  model: DocsFabConfig["model"],
  environment?: NodeJS.ProcessEnv,
): Promise<DocsFabConfig["model"]["profile"]> {
  return (await resolveDoctorModelBinding(model, environment)).profile;
}

/** The profile doctor reports, plus the reasoning control the binding applies. */
export async function resolveDoctorModelBinding(
  model: DocsFabConfig["model"],
  environment?: NodeJS.ProcessEnv,
): Promise<{
  profile: DocsFabConfig["model"]["profile"];
  reasoningControl?: MeasuredReasoningControl;
  answerSubmission?: InstalledAnswerSubmission;
  modelSettings?: ModelSlotSettingsV1;
}> {
  const bound = await resolveOperatorExecutionBinding({
    model,
    ...(environment ? { environment } : {}),
  });
  return {
    profile: bound.profile.profile,
    ...(bound.profile.measuredReasoningControl
      ? { reasoningControl: bound.profile.measuredReasoningControl }
      : {}),
    ...(bound.profile.answerSubmission ? { answerSubmission: bound.profile.answerSubmission } : {}),
    ...(bound.modelSettings ? { modelSettings: bound.modelSettings } : {}),
  };
}

/**
 * Rethrow a `composition-retired` or `model-endpoint-insecure-transport`
 * refusal unchanged; each carries its own code and next action.
 */
function rethrowNamedStop(error: unknown): void {
  if (
    (error instanceof ModelCompositionError && error.code === "composition-retired") ||
    error instanceof InsecureModelEndpointError
  ) {
    // hygiene: envelope
    throw error;
  }
}

export async function diagnose(
  config: DocsFabConfig,
  options: DiagnoseOptions = {},
): Promise<DoctorResult> {
  validateRequestPolicy("Policy model", config.model);
  if (config.judge) validateRequestPolicy("Judge model", config.judge);
  let resourceLoader: ReturnType<typeof createDocsFabResourceLoader>;
  let resolvedResources: ResolvedResourceSetV1 | undefined;
  try {
    ({ resolvedResources } = await verifyQualityPack({
      skillCrateDirectory: config.skillCrateDirectory,
      qualityDirectory: config.qualityDirectory,
      qualityPackDirectory: config.qualityPackDirectory,
    }));
    const lock = await readCatalogSkillCrateLock(config.skillCrateDirectory);
    const skillDirectories = await Promise.all(
      lock.skills.map(
        async (skill) =>
          (
            await verifyCatalogSkill({
              skillCrateDirectory: config.skillCrateDirectory,
              skillId: skill.id,
              grantedTools: skill.toolPolicy.granted,
            })
          ).directory,
      ),
    );
    resourceLoader = createDocsFabResourceLoader({
      repositoryPath: config.projectRoot,
      mode: "read-only",
      additionalSkillDirectories: skillDirectories,
    });
    await resourceLoader.reload();
  } catch (error) {
    // A quality-pack refusal keeps its code and catalog remediation; its
    // message table names no host path, so the doctor can show it as is.
    if (error instanceof QualityPackError) {
      // hygiene: envelope — QualityPackError maps the stable code through its message table.
      throw new QualityPackError(error.code);
    }
    rejectSituation(
      "skill-loading-failed",
      "Skill loading failed without retaining host-path diagnostics.",
    );
  }
  let loaded: ReturnType<typeof resourceLoader.getSkills>;
  try {
    loaded = resourceLoader.getSkills();
  } catch {
    rejectSituation(
      "skill-inspection-failed",
      "Skill inspection failed without retaining host-path diagnostics.",
    );
  }
  if (loaded.diagnostics.length > 0) {
    rejectSituation(
      "skill-loading-diagnostics-reported",
      `Skill loading reported ${loaded.diagnostics.length} content-free diagnostic(s).`,
    );
  }
  if (loaded.skills.length === 0) {
    rejectSituation(
      "governed-skills-not-found",
      "No governed skills were found in the configured skills directory.",
    );
  }

  let connection: Awaited<ReturnType<typeof createModelConnection>>;
  let available: Awaited<ReturnType<typeof connection.runtime.getAvailable>>;
  try {
    connection = await createModelConnection(config.model);
    available = await connection.runtime.getAvailable(config.model.providerId);
  } catch (error) {
    rethrowNamedStop(error);
    rejectSituation(
      "policy-model-registration-failed",
      "Policy model registration failed without retaining endpoint diagnostics.",
    );
  }
  if (!available.some((model) => model.id === config.model.modelId)) {
    rejectSituation(
      "policy-model-not-available",
      `Model ${config.model.providerId}/${config.model.modelId} is not available after configuration.`,
    );
  }

  if (config.judge) {
    let judgeConnection: Awaited<ReturnType<typeof createModelConnection>>;
    let judgeAvailable: Awaited<ReturnType<typeof connection.runtime.getAvailable>>;
    try {
      judgeConnection = await createModelConnection(config.judge);
      judgeAvailable = await judgeConnection.runtime.getAvailable(config.judge.providerId);
    } catch (error) {
      rethrowNamedStop(error);
      rejectSituation(
        "judge-model-registration-failed",
        "Judge model registration failed without retaining endpoint diagnostics.",
      );
    }
    if (!judgeAvailable.some((model) => model.id === config.judge?.modelId)) {
      rejectSituation(
        "judge-model-not-available",
        `Judge model ${config.judge.providerId}/${config.judge.modelId} is not available after configuration.`,
      );
    }
  }

  let live: LiveCheckResult | undefined;
  if (options.live) {
    try {
      live = await (options.liveChecker ?? checkLiveModel)(config);
    } catch (error) {
      // These refusals are credential-free and name their own fix.
      if (
        error instanceof EndpointCompatibilityError ||
        error instanceof InsecureModelEndpointError ||
        error instanceof OutboundProxyRefusal
      ) {
        throw error;
      }
      rejectSituation(
        "live-model-check-failed",
        "Live model check failed without retaining provider diagnostics.",
      );
    }
  }

  return {
    provider: config.model.providerId,
    endpoint: config.model.baseUrl,
    model: config.model.modelId,
    skills: loaded.skills.map((skill) => skill.name).sort(),
    contextSources: safeContextSources(resourceLoader, config.projectRoot),
    ...(resolvedResources ? { resolvedResources } : {}),
    profile: config.model.profile,
    requestPolicy: config.model.requestPolicy,
    ...(config.answerSubmission ? { answerSubmissionOption: config.answerSubmission } : {}),
    retryPolicy: config.retryPolicy,
    ...(config.judge
      ? {
          judge: {
            provider: config.judge.providerId,
            endpoint: config.judge.baseUrl,
            model: config.judge.modelId,
            profile: config.judge.profile,
            requestPolicy: config.judge.requestPolicy,
          },
        }
      : {}),
    ...(live ? { live } : {}),
  };
}

function safeContextSources(
  resourceLoader: ReturnType<typeof createDocsFabResourceLoader>,
  projectRoot: string,
): DocsFabContextSource[] {
  try {
    return getDocsFabContextSources(resourceLoader, projectRoot);
  } catch {
    rejectSituation(
      "context-source-inspection-failed",
      "Context-source inspection failed without retaining host-path diagnostics.",
    );
  }
}

function validateRequestPolicy(label: string, endpoint: DocsFabConfig["model"]): void {
  const { profile, requestPolicy } = endpoint;
  if (
    requestPolicy.minimumOutputTokens > profile.maxOutputTokens ||
    requestPolicy.reservedContextTokens + requestPolicy.minimumOutputTokens > profile.contextWindow
  ) {
    rejectSituation(
      "model-request-policy-exceeds-limits",
      `${label} request policy cannot fit effective limits: effective-context=${profile.contextWindow} effective-output=${profile.maxOutputTokens} context-reserve=${requestPolicy.reservedContextTokens} required-minimum-output=${requestPolicy.minimumOutputTokens}.`,
    );
  }
}

/** Map doctor-boundary failures through the operator error envelope. */
export function mapDoctorFailure(error: unknown): OperatorErrorEnvelope {
  const envelope = toOperatorErrorEnvelope(error);
  if (envelope.nextAction) return envelope;
  return toOperatorErrorEnvelope(error, {
    nextAction: doctorFallbackRemediationText(),
  });
}

export function formatDoctorFailure(error: unknown): string {
  return formatOperatorErrorEnvelope(mapDoctorFailure(error));
}

export function serializeDoctorFailure(error: unknown): string {
  return serializeOperatorErrorEnvelope(mapDoctorFailure(error));
}
