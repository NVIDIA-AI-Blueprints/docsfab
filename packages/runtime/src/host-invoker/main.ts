#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  HOSTED_REQUEST_MAXIMUM_BYTES,
  hostedRequestMaximumBytes,
} from "../live-agent/input-capacity.js";
import {
  HOST_RUNTIME_CREDENTIAL_MAXIMUM_BYTES,
  HOST_RUNTIME_DESCRIPTOR_NUMBER_MAXIMUM,
} from "./bound-capacity.js";
import { readHostRuntimeRequestSources } from "./semantic-source-reader.js";
import { createHash } from "node:crypto";
import { fstatSync, read, realpathSync } from "node:fs";
import { Socket } from "node:net";
import { fileURLToPath } from "node:url";

import {
  digest,
  HOSTED_OUTPUT_LINE_FRAME,
  HOSTED_OUTPUT_LINE_MAXIMUM_BYTES,
  type HostedOutputLineAccountingV1,
  parseHostRuntimeRequestData,
  sealHostRuntimeTerminal,
  serializeHostedOutputLine,
  type HostRuntimeRequestV1,
} from "./contracts.js";
import { runHostedWorkflow } from "./workflow-runner.js";
import { projectQualityReportFromRun } from "../evaluation-report/contracts.js";
import { createCandidateReviewResult } from "../review/contracts.js";
import { reviewResultHostRoots } from "../review/run-result.js";
import { validateStartupPublicRoots } from "../security/host-roots.js";
import { projectReviewFindingsFromRun } from "../review/findings.js";
import type { RunRecord } from "../records/contracts.js";
import {
  failureClassification,
  isFailureCode,
  type FailureClass,
} from "../operator/failure-class.js";
import type { AgentHarness } from "../execution/contracts.js";
import { WorkflowRunnerBoundaryError } from "../workflow-execution/runner.js";
import { SemanticComparisonReplyError } from "./reconcile-product-behavior.js";
import { registerConfiguredCredential } from "../security/configured-credentials.js";
import { isInferenceRejectedReplyShape } from "../execution/rejected-reply-shape.js";
import { isRejectedReplyExcerptOf } from "../execution/rejected-reply-excerpt.js";

const MAX_REQUEST_BYTES = HOSTED_REQUEST_MAXIMUM_BYTES;
/**
 * The replay record is a subtree of a terminal the host already admitted, so
 * its maximum is that same carrier, not an independent worker allowance. The
 * host still refuses a record wider than its admitted capacity before replay.
 */
export const MAX_REPLAY_RECORD_BYTES = HOSTED_OUTPUT_LINE_MAXIMUM_BYTES;
const MAX_CREDENTIAL_BYTES = HOST_RUNTIME_CREDENTIAL_MAXIMUM_BYTES;
/** Not a bound: 0-2 are the standard streams, so 3 is the lowest private pipe slot. */
const LOWEST_INHERITED_DESCRIPTOR = 3;

/** The actual bounded worker input path, also usable by qualification tests without inference. */
export async function readHostRuntimeRequest(
  fd: number,
  signal?: AbortSignal,
): Promise<HostRuntimeRequestV1> {
  const requestBytes = await readBoundedFd(fd, MAX_REQUEST_BYTES, signal);
  const request = parseHostRuntimeRequestData(JSON.parse(requestBytes.toString("utf8")) as unknown);
  const maximumRequestBytes = hostedRequestMaximumBytes(request.workflow);
  if (requestBytes.byteLength > maximumRequestBytes) {
    throw new Error(
      `host-invoker-request-max-bytes-bound: ${requestBytes.byteLength} exceeds the ${request.workflow} serialized request capacity of ${maximumRequestBytes} bytes.`,
    );
  }
  return readHostRuntimeRequestSources(request, signal);
}

export async function hostInvokerMain(
  argv = process.argv.slice(2),
  dependencies: { executionHarness?: AgentHarness } = {},
): Promise<void> {
  const controller = new AbortController();
  process.once("SIGTERM", () => controller.abort("sigterm"));
  process.once("SIGINT", () => controller.abort("sigint"));
  const requestFd = fdOption(argv, "--request-fd");
  const credentialFd = fdOption(argv, "--credential-fd", true);
  const request = await readHostRuntimeRequest(requestFd!, controller.signal);
  try {
    // Before any work, so an invalid declaration stops the run with its own code.
    validateStartupPublicRoots();
  } catch (error) {
    writeLine(
      sealHostRuntimeTerminal({
        request,
        status: "failed",
        runtimeRecord: buildHostRuntimeFailureRecord(request, error, "workflow-execution"),
        patch: null,
      }),
    );
    process.exitCode = 1;
    await flushHostedOutput();
    return;
  }
  const replayRecordFd = fdOption(argv, "--replay-record-fd", true);
  if (replayRecordFd !== null) {
    const recordBytes = await readBoundedFd(
      replayRecordFd,
      MAX_REPLAY_RECORD_BYTES,
      controller.signal,
    );
    const record = JSON.parse(recordBytes.toString("utf8")) as RunRecord;
    if (!request.packet.readerTask)
      throw new Error("Hosted editorial replay requires a bound reader task.");
    const replay = await import("../workflow-execution/editorial-evidence-assembly.js").then(
      ({ replayEditorialWorkflowEvidenceV1 }) =>
        replayEditorialWorkflowEvidenceV1({
          repositoryPath: request.workspacePath,
          revision: request.revision,
          stateDirectory: request.stateDirectory,
          readerTask: request.packet.readerTask!,
          readerEvidencePolicy: request.readerEvidencePolicy!,
          record,
        }),
    );
    writeLine({
      schemaVersion: 1,
      kind: "docsfab-host-editorial-replay",
      runtimeRecordSha256: digest(record),
      outcome: replay.outcome,
    });
    await flushHostedOutput();
    return;
  }
  const credentialBytes =
    credentialFd === null
      ? null
      : await readBoundedFd(credentialFd, MAX_CREDENTIAL_BYTES, controller.signal);
  const credential = credentialBytes === null ? null : credentialBytes.toString("utf8").trim();
  if (credentialBytes) credentialBytes.fill(0);
  // The hosted model key arrives on a descriptor, not in the environment, so
  // the exact-match screens learn it here (#1807).
  if (credential) registerConfiguredCredential(credential, "the hosted model credential");
  let outcome: Awaited<ReturnType<typeof runHostedWorkflow>>;
  let terminal;
  try {
    outcome = await runHostedWorkflow({
      request,
      credential,
      signal: controller.signal,
      emit: writeLine,
      ...(dependencies.executionHarness ? { executionHarness: dependencies.executionHarness } : {}),
    });
  } catch (error) {
    writeLine(
      sealHostRuntimeTerminal({
        request,
        status: "failed",
        runtimeRecord: buildHostRuntimeFailureRecord(request, error, "workflow-execution"),
        patch: null,
      }),
    );
    process.exitCode = 1;
    await flushHostedOutput();
    return;
  }
  try {
    const status =
      outcome.record.status === "succeeded"
        ? "succeeded"
        : outcome.record.status === "needs-input" ||
            outcome.record.status === "needs-human-decision"
          ? outcome.record.status
          : "failed";
    const candidateReviewResult =
      status === "succeeded" ? projectCandidateReviewResult(request, outcome.record) : undefined;
    terminal = sealHostRuntimeTerminal({
      request,
      status,
      runtimeRecord: outcome.record,
      patch: outcome.patch,
      patchEvidence: outcome.patchEvidence,
      ...(candidateReviewResult ? { candidateReviewResult } : {}),
      editorialOutcome: outcome.editorialOutcome,
      ...(outcome.editorialAuthority ? { editorialAuthority: outcome.editorialAuthority } : {}),
    });
  } catch (error) {
    terminal = sealHostRuntimeTerminal({
      request,
      status: "failed",
      runtimeRecord: buildHostRuntimeFailureRecord(request, error, "terminal-sealing"),
      patch: null,
    });
    process.exitCode = 1;
  }
  // Transport failure is deliberately outside outcome projection/sealing.
  writeLine(terminal);
  // Delivery is claimed here and nowhere earlier: an unflushed terminal that
  // the host never read is a failed attempt, not a silent success.
  await flushHostedOutput();
}

/** Project a successful private-candidate run inside the installed runtime. */
export function projectCandidateReviewResult(
  request: HostRuntimeRequestV1,
  record: RunRecord,
): unknown | undefined {
  const candidate = request.packet.candidateReview;
  if (!candidate) return undefined;
  const qualityReport = projectQualityReportFromRun(record);
  if (
    !qualityReport ||
    qualityReport.repositoryRevision !== candidate.reviewCommitObjectId ||
    qualityReport.patchSha256 !== null
  )
    throw new Error("Candidate review did not produce an exact read-only quality report.");
  return createCandidateReviewResult(
    {
      bindingSha256: candidate.bindingSha256,
      reviewCommitObjectId: candidate.reviewCommitObjectId,
    },
    {
      taskId: `task:${record.id}`,
      runIdSha256: createHash("sha256").update(record.id).digest("hex"),
      findings: projectReviewFindingsFromRun(record).findings,
      checks: record.steps.map((step) => ({
        id: step.id,
        name: step.title,
        status:
          step.status === "succeeded" ? "passed" : step.status === "failed" ? "failed" : "skipped",
      })),
      unresolvedQuestions: (record.workflowOutcome?.openDecisions ?? []).map((decision, index) => ({
        id: `question:${index + 1}`,
        summary: `Open decision: ${decision.id}.`,
      })),
      affectedPaths: candidate.targets.map((target) => target.path),
      patchLocator: { kind: "artifact-digest", digestSha256: candidate.patchSha256 },
      locatorSha256: null,
      qualityReport,
    },
    { hostRoots: reviewResultHostRoots(record, [request.workspacePath]) },
  );
}

/** The record sealed when a hosted run throws; exported so tests seal the real shape. */
export function buildHostRuntimeFailureRecord(
  request: HostRuntimeRequestV1,
  error: unknown,
  failurePhase: HostRuntimeFailurePhase = "workflow-execution",
): Record<string, unknown> {
  const code = refusalCode(error, failurePhase);
  return {
    schemaVersion: 1,
    kind: "docsfab-host-runtime-failure",
    id: request.runId,
    workflow: request.workflow,
    repository: { revision: request.revision },
    status: "failed",
    steps: [],
    tools: { totalCalls: 0, failedCalls: 0, byTool: [], failureCategories: [] },
    models: [],
    ...semanticReplyFailureEvidence(error, code, failurePhase),
    // A failure record must satisfy the terminal's review-scope assertion too;
    // otherwise a scoped request's failure seal throws inside the catch and no
    // terminal line is written.
    ...(request.packet.reviewScope
      ? {
          reviewScope: {
            scope: request.packet.reviewScope.scope,
            reason: request.packet.reviewScope.reason,
            targetPaths: request.packet.reviewScope.targets.map((target) => target.path),
            deferredPaths: request.packet.reviewScope.deferred.map((entry) => entry.path),
            anchorPaths: request.packet.reviewScope.anchorPaths,
            scopeSha256: request.packet.reviewScope.scopeSha256,
            corpusFileCount: request.packet.reviewScope.corpusFileCount,
            ...(request.packet.canon
              ? {
                  continuationIdentity: {
                    canonSha256: request.packet.canon.sha256,
                    reviewRevision: request.revision,
                  },
                }
              : {}),
            ...(request.packet.reviewScope.accounting
              ? { accounting: request.packet.reviewScope.accounting }
              : {}),
          },
        }
      : {}),
    // Closed refusal codes are credential-free and make a refused turn legible.
    failurePhase,
    code,
    // The class is read from the sealed closed code, never from the arbitrary
    // error, so no unvetted value crosses this boundary.
    failure: failureClassification(
      HOSTED_RUNTIME_FAILURE_CODE_CLASSES[code] ??
        (code.startsWith(SEMANTIC_REPLY_CODE_PREFIX) ? "model-content" : "unknown"),
      "workflow",
      code,
    ),
  };
}

export type HostRuntimeFailurePhase = "workflow-execution" | "terminal-sealing";
/** Codes of refused comparison replies; each is `model-content`. */
const SEMANTIC_REPLY_CODE_PREFIX = "semantic-reply-";

/** Only the already classed semantic refusal may carry its validated own-value diagnostics. */
function semanticReplyFailureEvidence(
  error: unknown,
  code: string,
  phase: HostRuntimeFailurePhase,
): Record<string, unknown> {
  if (phase !== "workflow-execution" || !code.startsWith(SEMANTIC_REPLY_CODE_PREFIX)) return {};
  try {
    const shapeDescriptor = Object.getOwnPropertyDescriptor(error, "rejectedReplyShape");
    const shape = shapeDescriptor && "value" in shapeDescriptor ? shapeDescriptor.value : undefined;
    if (!isInferenceRejectedReplyShape(shape)) return {};
    const excerptDescriptor = Object.getOwnPropertyDescriptor(error, "rejectedReplyExcerpt");
    const excerpt =
      excerptDescriptor && "value" in excerptDescriptor ? excerptDescriptor.value : undefined;
    return {
      rejectedReplyShape: structuredClone(shape),
      ...(isRejectedReplyExcerptOf(excerpt, shape)
        ? { rejectedReplyExcerpt: structuredClone(excerpt) }
        : {}),
    };
  } catch {
    return {};
  }
}
/**
 * Each closed hosted-runtime failure code with its failure class, so a code
 * cannot be added to either phase without one. The phase fallbacks name no
 * cause and are `unknown`.
 */
const EXECUTION_CODE_CLASSES = {
  "turn-input-missing": "contract-shape",
  "turn-input-shape": "contract-shape",
  "turn-scope-missing": "contract-shape",
  "turn-scope-mismatch": "contract-shape",
  "turn-state-digest-mismatch": "contract-shape",
  "turn-state-session-mismatch": "contract-shape",
  "turn-answer-credential-material": "model-content",
  "turn-answer-write-grant": "model-content",
  "turn-answer-unsafe-projection": "model-content",
  "public-roots-invalid": "operator-input",
  "run-store-invalid-root": "operator-input",
  "run-store-unsupported-platform": "infrastructure",
  "run-store-unsafe-root": "operator-input",
  "run-store-owner-mismatch": "operator-input",
  "run-store-insecure-permissions": "operator-input",
  "run-store-unsafe-record-id": "contract-shape",
  "run-store-serialization-failed": "contract-shape",
  "run-store-record-exists": "contract-shape",
  "run-store-unsafe-entry": "infrastructure",
  "run-store-record-not-found": "infrastructure",
  "run-store-invalid-record": "contract-shape",
  "run-store-write-failed": "infrastructure",
} as const satisfies Readonly<Record<string, FailureClass>>;
const TERMINAL_CODE_CLASSES = {
  "credential-material": "operator-input",
  "terminal-record-shape": "contract-shape",
  "terminal-evidence-mismatch": "contract-shape",
  "terminal-status-mismatch": "contract-shape",
  "terminal-binding-mismatch": "contract-shape",
  "terminal-review-scope-substitution": "contract-shape",
} as const satisfies Readonly<Record<string, FailureClass>>;
const FALLBACK_CODE_CLASSES = {
  "execution-failed": "unknown",
  "terminal-sealing-failed": "unknown",
} as const satisfies Readonly<Record<string, FailureClass>>;
const EXECUTION_CODES: ReadonlySet<string> = new Set(Object.keys(EXECUTION_CODE_CLASSES));
const TERMINAL_CODES: ReadonlySet<string> = new Set(Object.keys(TERMINAL_CODE_CLASSES));

/** Every hosted-runtime failure code and its class, for the record and the drift test. */
export const HOSTED_RUNTIME_FAILURE_CODE_CLASSES: Readonly<Record<string, FailureClass>> =
  Object.freeze({
    ...EXECUTION_CODE_CLASSES,
    ...TERMINAL_CODE_CLASSES,
    ...FALLBACK_CODE_CLASSES,
  });

/**
 * The closed refusal code of a hosted live-agent turn, when there is one.
 *
 * Only phase-specific closed code membership crosses this boundary. Everything
 * else becomes the fixed phase fallback without inspecting arbitrary error data.
 */
function refusalCode(error: unknown, phase: HostRuntimeFailurePhase): string {
  const fallback = phase === "workflow-execution" ? "execution-failed" : "terminal-sealing-failed";
  try {
    if (!error || typeof error !== "object") return fallback;
    const descriptor = Object.getOwnPropertyDescriptor(error, "code");
    const code = descriptor && "value" in descriptor ? descriptor.value : undefined;
    // A refused comparison reply names its closed decoder code; an error of any other
    // type that claims such a code is the adjacent condition and stays the fallback.
    if (
      phase === "workflow-execution" &&
      error instanceof SemanticComparisonReplyError &&
      typeof code === "string" &&
      code.startsWith(SEMANTIC_REPLY_CODE_PREFIX) &&
      isFailureCode(code)
    )
      return code;
    if (
      typeof code === "string" &&
      (phase === "workflow-execution" ? EXECUTION_CODES : TERMINAL_CODES).has(code) &&
      (!code.startsWith("run-store-") || error instanceof WorkflowRunnerBoundaryError)
    )
      return code;
  } catch {
    // Arbitrary getters and proxy traps cannot prevent a fixed terminal failure.
  }
  return fallback;
}

/**
 * Ordered, awaited hosted output.
 *
 * The host checks a strict progress sequence, so lines go through one serial
 * queue. Only `flushHostedOutput` claims delivery, once every queued line has
 * been accepted without a write error. The queue never rejects, so an early
 * exit cannot turn a transport failure into an unhandled rejection.
 */
let hostedOutput: Promise<void> = Promise.resolve();
let hostedOutputFailure: unknown = null;
let hostedOutputWatched = false;

function writeLine(value: unknown): void {
  const accounted = serializeHostedOutputLine(value);
  if (!hostedOutputWatched) {
    hostedOutputWatched = true;
    // A closed host read end also raises `error` on the descriptor; unhandled,
    // Node would abort the worker before the failure is reported.
    process.stdout.on("error", (error: unknown) => {
      hostedOutputFailure ??= error;
    });
  }
  hostedOutput = hostedOutput
    .then(() => deliverHostedOutputLine(accounted))
    .catch((error) => {
      hostedOutputFailure ??= error;
    });
}

async function deliverHostedOutputLine(accounted: HostedOutputLineAccountingV1): Promise<void> {
  // Framing is written separately: concatenating it would exceed the carrier
  // when the line is at its supported maximum.
  await writeHostedOutput(accounted.json);
  await writeHostedOutput(HOSTED_OUTPUT_LINE_FRAME);
}

function writeHostedOutput(text: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    process.stdout.write(text, "utf8", (error) => (error ? reject(error) : resolve()));
  });
}

/** Awaits serialized delivery and backpressure, then re-raises the first transport failure. */
export async function flushHostedOutput(): Promise<void> {
  await hostedOutput;
  if (hostedOutputFailure !== null) {
    const failure = hostedOutputFailure;
    hostedOutputFailure = null;
    throw failure;
  }
}

async function readBoundedFd(fd: number, maximum: number, signal?: AbortSignal): Promise<Buffer> {
  if (fstatSync(fd).isFile()) return readBorrowedFile(fd, maximum, signal);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    // Owned pipes/sockets need libuv's cancellable stream handle: fs.ReadStream
    // can leave a thread blocked in read(2) after abort while the host owns the writer.
    const stream = new Socket({ fd, readable: true, writable: false, signal });
    stream.on("data", (value: string | Buffer) => {
      const chunk = typeof value === "string" ? Buffer.from(value) : value;
      length += chunk.byteLength;
      if (length > maximum) {
        stream.destroy(
          new Error("Hosted runtime file-descriptor input exceeded its configured byte bound."),
        );
        return;
      }
      chunks.push(chunk);
    });
    stream.once("error", reject);
    stream.once("end", () => {
      if (length === 0)
        reject(new Error("Hosted runtime file-descriptor input was unexpectedly empty."));
      else resolve(Buffer.concat(chunks));
    });
  });
}

/** Await native reads on the borrowed descriptor. Abort never closes it or
 * races an unfinished read; completed reads keep their normal position updates. */
async function readBorrowedFile(
  fd: number,
  maximum: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;
  for (;;) {
    assertFileReadActive(signal);
    const chunk = await new Promise<Buffer>((resolve, reject) => {
      read(fd, (error, bytesRead, buffer) => {
        if (error) reject(error);
        else resolve(buffer.subarray(0, bytesRead));
      });
    });
    assertFileReadActive(signal);
    if (chunk.byteLength === 0) {
      if (length === 0)
        throw new Error("Hosted runtime file-descriptor input was unexpectedly empty at EOF.");
      return Buffer.concat(chunks, length);
    }
    length += chunk.byteLength;
    if (length > maximum)
      throw new Error("Hosted runtime file-descriptor input exceeded its configured byte bound.");
    chunks.push(chunk);
  }
}

function assertFileReadActive(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const error = new Error("Hosted runtime file-descriptor input was aborted during the read.");
    error.name = "AbortError";
    throw Object.assign(error, { code: "ABORT_ERR" });
  }
}

function fdOption(argv: readonly string[], name: string, optional = false): number | null {
  const index = argv.indexOf(name);
  if (index < 0) {
    if (optional) return null;
    throw new Error(`Hosted runtime invocation is missing the required ${name} argument.`);
  }
  const value = Number(argv[index + 1]);
  if (
    !Number.isSafeInteger(value) ||
    value < LOWEST_INHERITED_DESCRIPTOR ||
    value > HOST_RUNTIME_DESCRIPTOR_NUMBER_MAXIMUM
  )
    throw new Error(`Hosted runtime invocation received an invalid ${name} descriptor number.`);
  return value;
}

/**
 * Resolve both sides through `realpath` so a symlinked installed entry point,
 * which is how the release tree actually invokes this worker, still runs it.
 */
function isEntryPoint(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  hostInvokerMain().catch(() => {
    process.exitCode = 1;
  });
}
