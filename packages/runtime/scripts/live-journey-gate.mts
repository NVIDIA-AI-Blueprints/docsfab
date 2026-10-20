// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Real-model journey gate.
 *
 * Runs one `review-documentation` review and one `live-agent-turn` ask through
 * the shipped hosted path (`runHostedWorkflow`) against a real provider, and
 * exits non-zero unless both records settle `succeeded`. The hosted path, not
 * the CLI, because the host invoker is where the guards under test run.
 *
 * Usage (MODEL_API_KEY in the environment or in the configuration root's
 * secrets.env, which is where CI's configuration preparation writes it):
 *   node --import tsx scripts/live-journey-gate.mts --repo <dir> --out <dir> --state <dir>
 *     --review-target <path[,path...]> --ask-target <path> --question <text>
 *     [--label <label>]
 *
 * A gate, not a benchmark: it asserts terminal status, not answer quality. Its
 * output carries statuses, step ids, durations, digests, and error messages,
 * never the credential or the answer.
 *
 * No operational limit is written here: the evidence capsule expires at the
 * job's own ceiling (`ci.liveJourney.jobTimeoutMs`). Evidence is rewritten
 * after each journey, so a job stopped at its ceiling still leaves the
 * completed journey's record.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { limit } from "../src/config/limits.js";
import { canonicalJson, sha256 } from "../src/content-ir/canonical.js";
import { loadDocsFabEnvironment } from "../src/config/host-paths.js";
import { loadConfig } from "../src/config/runtime-loader.js";
import {
  parseHostRuntimeRequest,
  sealHostRuntimeComposition,
  type HostRuntimeRequestV1,
} from "../src/host-invoker/contracts.js";
import { runHostedWorkflow } from "../src/host-invoker/workflow-runner.js";
import { grantedTools } from "../src/harness/pi-tool-confine.js";
import { resolveOperatorExecutionBinding } from "../src/model/operator-execution-binding.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import type { AgentHarness } from "../src/execution/contracts.js";
import type { RunRecord } from "../src/records/contracts.js";
import { LIVE_MODEL_CI_COMPOSITION_ID } from "./prepare-live-model-ci-config.js";

/**
 * A Slack message timestamp is `<unix seconds>.<six-digit counter>`. These are
 * that wire format, not operational bounds; the gate mints one synthetic
 * message per journey.
 */
const MILLISECONDS_PER_SECOND = 1000;
const SYNTHETIC_MESSAGE_COUNTER = "000100";

export interface LiveJourneyResult {
  readonly journey: "review" | "ask";
  readonly workflow: string;
  readonly runId: string;
  readonly status: string;
  readonly durationMs: number;
  readonly steps: readonly { readonly id: string; readonly status: string }[];
  readonly recordSha256: string;
  readonly failure?: string;
}

function toSha(value: string): string {
  return sha256(value);
}

/** Documentation page suffixes, as the review corpus counts them. */
const DOCUMENTATION_SUFFIXES = [".md", ".mdx"] as const;

/**
 * The "reviewed N of M pages" denominator, counted from the tree at the exact
 * revision. The suffix filter runs here because `git ls-tree` does not match
 * wildcard pathspecs. An oversized tree exceeds the default child-process
 * buffer and fails loudly rather than truncating the count.
 */
function trackedDocumentationCount(repository: string, revision: string): number {
  const listed = execFileSync(
    "git",
    ["-C", repository, "ls-tree", "-r", "--name-only", revision],
    { encoding: "utf8" },
  );
  return listed
    .split("\n")
    .filter((path) => DOCUMENTATION_SUFFIXES.some((suffix) => path.endsWith(suffix))).length;
}

function sealedScope(targets: readonly string[], corpusFileCount: number) {
  const canonical = {
    schemaVersion: 1,
    kind: "docsfab-review-scope",
    scope: "focused-set",
    reason: "operator-named",
    targets: targets.map((path) => ({ path, reason: "operator-named" })),
    deferred: [] as { path: string; reason: string }[],
  };
  return {
    ...canonical,
    scopeSha256: toSha(canonicalJson(canonical)),
    corpusFileCount,
  };
}

export interface LiveJourneyInput {
  readonly repository: string;
  readonly revision: string;
  readonly reviewTargets: readonly string[];
  readonly askTarget: string;
  readonly question: string;
  readonly stateDirectory: string;
  readonly credential: string;
  readonly label: string;
}

/** The installed workflow each journey dispatches. */
export function journeyWorkflow(journey: "review" | "ask"): string {
  return journey === "ask" ? "live-agent-turn" : "review-documentation";
}

/**
 * The hosted request for one journey. Exported so an executing test proves
 * the review shape dispatchable before a provider job pays for it.
 */
export function buildRequest(
  input: LiveJourneyInput,
  journey: "review" | "ask",
  executionProfile: unknown,
  startedAt: number,
): HostRuntimeRequestV1 {
  const workflow = journeyWorkflow(journey);
  const definition = getWorkflow(workflow);
  const stepIds = definition.steps.map((step) => step.id);
  const declaredTools = [
    ...new Set(
      definition.steps.flatMap((step) => grantedTools(step.mode, step.kind, step.search)),
    ),
  ].sort();
  const targets = journey === "ask" ? [input.askTarget] : [...input.reviewTargets];
  const reviewScope = sealedScope(
    targets,
    trackedDocumentationCount(input.repository, input.revision),
  );
  const content =
    journey === "ask"
      ? canonicalJson({
          turnKind: "docsfab-live-agent-turn",
          sessionId: `live-agent-session-${toSha(`${input.label}:session`)}`,
          threadBindingSha256: toSha(`${input.label}:thread`),
          messageTs: `${Math.floor(startedAt / MILLISECONDS_PER_SECOND)}.${SYNTHETIC_MESSAGE_COUNTER}`,
          text: input.question,
          scopeSha256: reviewScope.scopeSha256,
          priorSessionStateSha256: null,
          priorSessionState: null,
        })
      : `Review ${targets.join(", ")} and report the problems. Do not edit files.`;
  const receiptSha256 = toSha(`${input.label}:receipt`);
  // The capsule expires at this job's platform ceiling, so it cannot outlive
  // the job that minted it.
  const expiresAt = new Date(startedAt + limit("ci.liveJourney.jobTimeoutMs").value).toISOString();
  const selectedEvidence: { evidenceId: string; content: string }[] = [];
  return parseHostRuntimeRequest({
    schemaVersion: 1,
    kind: "docsfab-host-runtime-request",
    deploymentId: "live-journey-gate",
    projectId: "docsfab-live-journey",
    deploymentEpoch: "20260924T000000Z",
    requestKey: `ci:journey:${input.label}:${journey}`,
    origin: { principalId: "docsfab-ci", requestId: `${input.label}-${journey}` },
    runId: `run-${input.label}-${journey}`,
    fence: 1,
    workflow,
    revision: input.revision,
    sourceTreeObjectId: execFileSync(
      "git",
      ["-C", input.repository, "rev-parse", `${input.revision}^{tree}`],
      { encoding: "utf8" },
    ).trim(),
    packet: {
      packetFingerprintSha256: toSha(`${input.label}:packet:${journey}`),
      inputManifest: null,
      canon: null,
      reviewEvent: { kind: "review-event", sha256: toSha(content), content },
      reviewScope,
    },
    stepIds,
    toolPolicySha256: toSha(canonicalJson({ workflow, stepIds, declaredTools })),
    workspacePath: input.repository,
    stateDirectory: input.stateDirectory,
    capsule: {
      sha256: toSha(canonicalJson({ receiptSha256, expiresAt, selectedEvidence })),
      receiptSha256,
      expiresAt,
      selectedEvidence,
    },
    composition: sealHostRuntimeComposition({
      // The id CI prepared the configuration root for, not a second literal.
      compositionId: LIVE_MODEL_CI_COMPOSITION_ID,
      route: "nvidia-inference-api",
      credentialFamily: "nvidia-inference-api",
      executionProfile,
      declaredTools,
    } as Parameters<typeof sealHostRuntimeComposition>[0]),
    allowWrite: false,
  });
}

/**
 * Seams a test may supply. CI supplies neither: the job runs the default path
 * against the installed composition and the real provider.
 */
export interface LiveJourneyOptions {
  /** `runHostedWorkflow`'s in-process model-edge seam, forwarded unchanged. */
  readonly executionHarness?: AgentHarness;
  /** Called with the results settled so far, after each journey. */
  readonly onJourneySettled?: (results: readonly LiveJourneyResult[]) => void;
}

/**
 * The installed composition binding for one workflow, projected onto the wire
 * fields a hosted request carries. Exported so a test uses the binding CI
 * binds rather than a hand-written profile.
 */
export async function resolveJourneyExecutionProfile(
  workflowId: string,
): Promise<Record<string, unknown>> {
  // Load the installed layout into the environment as the CLI does, so the
  // gate binds the composition CI prepared.
  loadDocsFabEnvironment();
  const config = loadConfig(process.env);
  const binding = await resolveOperatorExecutionBinding({ model: config.model, workflowId });
  if (!binding) {
    throw new Error("live-journey-gate: the MODEL_* configuration did not bind an execution route.");
  }
  const profile = binding.profile as Record<string, unknown>;
  return {
    routeId: profile.routeId,
    providerId: profile.providerId,
    baseUrl: profile.baseUrl,
    modelId: profile.modelId,
    transport: profile.transport,
    apiFormat: profile.apiFormat,
    profile: profile.profile,
    requestPolicy: profile.requestPolicy,
  };
}

/** Run both journeys. Resolves with one result per journey, in run order. */
export async function runLiveJourneys(
  input: LiveJourneyInput,
  options: LiveJourneyOptions = {},
): Promise<readonly LiveJourneyResult[]> {
  const results: LiveJourneyResult[] = [];
  // The cheap ask runs first, so the expensive review cannot starve it of the
  // job's ceiling.
  for (const journey of ["ask", "review"] as const) {
    const startedAt = Date.now();
    // Bind per journey with its own workflow id; the resolver takes the
    // workflow as an input.
    const executionProfile = await resolveJourneyExecutionProfile(journeyWorkflow(journey));
    const request = buildRequest(input, journey, executionProfile, startedAt);
    mkdirSync(request.stateDirectory, { recursive: true });
    let record: RunRecord | undefined;
    let failure: string | undefined;
    try {
      ({ record } = await runHostedWorkflow({
        request,
        credential: input.credential,
        emit: () => undefined,
        ...(options.executionHarness ? { executionHarness: options.executionHarness } : {}),
      }));
    } catch (error) {
      // A guard that refuses the projection lands here: the workflow ran, but
      // no record is returned.
      failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    }
    results.push({
      journey,
      workflow: request.workflow,
      runId: request.runId,
      status: record?.status ?? "refused-before-record",
      durationMs: Date.now() - startedAt,
      steps: (record?.steps ?? []).map((step) => ({ id: step.id, status: step.status })),
      recordSha256: record ? toSha(canonicalJson(record)) : "",
      ...(failure ? { failure } : {}),
    });
    options.onJourneySettled?.(results);
  }
  return results;
}

function option(argv: readonly string[], name: string, fallback?: string): string {
  const index = argv.indexOf(`--${name}`);
  if (index < 0) {
    if (fallback !== undefined) return fallback;
    throw new Error(`live-journey-gate: --${name} is required.`);
  }
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`live-journey-gate: --${name} is required.`);
  }
  return value;
}

/**
 * The gate's verdict: the failure message, or `undefined` when every journey
 * settled `succeeded`. Separate from {@link main} so the one assertion the job
 * makes is directly testable. `refused-before-record` fails like any other
 * non-`succeeded` status.
 */
export function journeyVerdictFailure(
  results: readonly LiveJourneyResult[],
): string | undefined {
  const failed = results.filter((result) => result.status !== "succeeded");
  if (failed.length === 0) return undefined;
  return `live-journey-gate: ${failed.map((result) => `${result.journey}=${result.status}`).join(", ")}`;
}

export async function main(
  argv: readonly string[],
  options: LiveJourneyOptions = {},
): Promise<void> {
  // runtime-run.sh hands MODEL_API_KEY only to prepare-live-model-ci-config.ts,
  // which writes it to the configuration root's secrets.env. Load that installed
  // layout before reading the credential, as the CLI does; an exported value
  // still takes precedence.
  loadDocsFabEnvironment();
  const credential = process.env.MODEL_API_KEY?.trim();
  if (!credential) {
    throw new Error("live-journey-gate: MODEL_API_KEY was not supplied by the CI credential.");
  }
  const repository = realpathSync(resolve(option(argv, "repo")));
  const revision = execFileSync("git", ["-C", repository, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  // Refuse a dirty workspace up front: the hosted runner re-derives the same
  // manifest and refuses it after the model work is paid for. Ignored
  // build output is not listed by git, so an `npm ci` first is fine.
  const dirty = execFileSync(
    "git",
    ["-C", repository, "status", "--porcelain=v1", "--untracked-files=all"],
    { encoding: "utf8" },
  );
  if (dirty.trim().length > 0) {
    throw new Error(
      "live-journey-gate: the review workspace is not clean; the hosted runner refuses a workspace that does not match its exact clean manifest.",
    );
  }
  const outputDirectory = resolve(option(argv, "out"));
  mkdirSync(outputDirectory, { recursive: true });
  const evidencePath = resolve(outputDirectory, "live-journey-gate.json");
  const writeEvidence = (results: readonly LiveJourneyResult[]): void => {
    writeFileSync(evidencePath, `${JSON.stringify({ revision, results }, null, 2)}\n`);
  };
  const results = await runLiveJourneys(
    {
      repository,
      revision,
      reviewTargets: option(argv, "review-target").split(","),
      askTarget: option(argv, "ask-target"),
      question: option(argv, "question"),
      stateDirectory: resolve(option(argv, "state")),
      credential,
      label: option(argv, "label", "live-journey"),
    },
    { ...options, onJourneySettled: writeEvidence },
  );
  writeEvidence(results);
  for (const result of results) {
    console.log(
      `live-journey-gate: ${result.journey} (${result.workflow}) ${result.status} in ${result.durationMs} ms` +
        (result.failure ? ` -- ${result.failure}` : ""),
    );
  }
  const verdict = journeyVerdictFailure(results);
  if (verdict !== undefined) throw new Error(verdict);
}

// Both sides realpathed, so a symlinked invocation still runs main.
const invokedPath = process.argv[1] ? realpathSync(resolve(process.argv[1])) : undefined;
if (invokedPath === realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
