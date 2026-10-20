// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { detectCredentialRuleIdsInValue } from "../security/repository-scanner.js";
import { canonicalDigest } from "../contract-kit/index.js";
import {
  NATIVE_PILOT_ENVIRONMENT_NAMES,
  NATIVE_PILOT_MAXIMA,
  type NativePilotFailureCode,
  type NativePilotHarnessId,
  type NativePilotStepId,
} from "./pilot-contracts.js";
import { sha256 } from "../content-ir/canonical.js";

export type NativePilotProcessStatus =
  | "settled"
  | "spawn-failed"
  | "process-failed"
  | "output-limit"
  | "timeout"
  | "cancelled";

export interface NativePilotProcessRequest {
  readonly harnessId: NativePilotHarnessId;
  readonly executablePath: string;
  readonly arguments: readonly string[];
  readonly workingDirectory: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly stdin: Buffer;
  readonly timeoutMs: number;
  readonly maxStdoutBytes: number;
  readonly maxStderrBytes: number;
  readonly streamPolicy:
    | { readonly kind: "terminal-capture-v1" }
    | {
        readonly kind: "claude-2.1.226-guard-v1";
        readonly requestedModel: "claude-opus-4-7";
        readonly stepId: NativePilotStepId;
        readonly workingDirectory: string;
      };
  readonly signal?: AbortSignal;
}

export interface NativePilotProcessObservation {
  readonly status: NativePilotProcessStatus;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly durationMs: number;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  /** Total bytes observed, including the byte that crossed a configured cap. */
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly stdoutOverflow: boolean;
  readonly stderrOverflow: boolean;
  readonly stdoutEof: boolean;
  readonly stderrEof: boolean;
  readonly stdinBytes: number;
  readonly stdinDelivered: boolean;
  readonly processGroupSettled: boolean;
  readonly lateBytesObserved: boolean;
  readonly streamDisposition: "terminal-capture" | "success" | "stopped";
  readonly streamFailureCode: NativePilotFailureCode | null;
  readonly providerRequests: number;
  readonly providerRequestLowerBound: number;
  readonly retryAttempt: number | null;
  readonly retryMaximum: number | null;
  readonly killIssued: boolean;
  readonly killIssuedBeforeRetryDeadline: boolean;
  readonly stopSettlementRequired: boolean;
  readonly fallbackAttempted: false;
  readonly descendantContainment: "unsupported";
  readonly requestSha256: string;
}

export type NativePilotProcessRunner = (
  request: NativePilotProcessRequest,
) => Promise<NativePilotProcessObservation>;

export class NativePilotProcessError extends Error {
  public constructor(public readonly code: NativePilotFailureCode) {
    super(`Native pilot process rejected (${code}).`);
    this.name = "NativePilotProcessError";
  }
}

export function failProcess(code: NativePilotFailureCode): never {
  throw new NativePilotProcessError(code);
}

const PROCESS_OBSERVATION_AUTHORITIES = new WeakMap<
  NativePilotProcessObservation,
  {
    readonly requestSha256: string;
    readonly planSha256: string;
    readonly observationSha256: string;
    consumed: boolean;
  }
>();
export const PROCESS_REQUEST_AUTHORITIES = new WeakMap<
  NativePilotProcessRequest,
  { readonly requestSha256: string; readonly planSha256: string; consumed: boolean }
>();
const SHA256 = /^[a-f0-9]{64}$/u;

export function authorizeNativePilotProcessRequest(
  request: NativePilotProcessRequest,
  planSha256: string,
): string {
  if (!SHA256.test(planSha256)) {
    failProcess("invocation-policy");
  }
  const requestSha256 = nativePilotProcessRequestSha256(request);
  if (PROCESS_REQUEST_AUTHORITIES.has(request)) {
    failProcess("invocation-policy");
  }
  PROCESS_REQUEST_AUTHORITIES.set(request, { requestSha256, planSha256, consumed: false });
  return requestSha256;
}

export function nativePilotProcessRequestSha256(request: NativePilotProcessRequest): string {
  validateNativePilotProcessRequest(request);
  return canonicalDigest({
    harnessId: request.harnessId,
    executablePathSha256: sha256(request.executablePath),
    arguments: request.arguments,
    workingDirectorySha256: sha256(request.workingDirectory),
    environment: Object.fromEntries(
      Object.entries(request.environment)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, value]) => [name, sha256(value)]),
    ),
    stdinSha256: createHash("sha256").update(request.stdin).digest("hex"),
    timeoutMs: request.timeoutMs,
    maxStdoutBytes: request.maxStdoutBytes,
    maxStderrBytes: request.maxStderrBytes,
    streamPolicy: request.streamPolicy,
  });
}

export function consumeNativePilotProcessObservationAuthority(
  observation: NativePilotProcessObservation,
  expectedRequestSha256: string,
  expectedPlanSha256: string,
): void {
  const authority = PROCESS_OBSERVATION_AUTHORITIES.get(observation);
  if (
    !SHA256.test(expectedPlanSha256) ||
    !authority ||
    authority.consumed ||
    authority.requestSha256 !== expectedRequestSha256 ||
    authority.planSha256 !== expectedPlanSha256 ||
    observation.requestSha256 !== expectedRequestSha256 ||
    authority.observationSha256 !== nativePilotProcessObservationSha256(observation)
  ) {
    failProcess("invocation-policy");
  }
  authority.consumed = true;
}

export function validateNativePilotProcessRequest(request: NativePilotProcessRequest): void {
  if (
    !canonicalAbsolutePath(request.executablePath) ||
    !canonicalAbsolutePath(request.workingDirectory) ||
    !Buffer.isBuffer(request.stdin) ||
    request.stdin.byteLength < 1 ||
    request.stdin.byteLength > NATIVE_PILOT_MAXIMA.maxStdinBytes ||
    !Number.isSafeInteger(request.timeoutMs) ||
    request.timeoutMs < 1 ||
    request.timeoutMs > NATIVE_PILOT_MAXIMA.timeoutMs ||
    !Number.isSafeInteger(request.maxStdoutBytes) ||
    request.maxStdoutBytes < 1 ||
    request.maxStdoutBytes > NATIVE_PILOT_MAXIMA.maxStdoutBytes ||
    !Number.isSafeInteger(request.maxStderrBytes) ||
    request.maxStderrBytes < 1 ||
    request.maxStderrBytes > NATIVE_PILOT_MAXIMA.maxStderrBytes ||
    !Array.isArray(request.arguments) ||
    request.arguments.length < 1 ||
    request.arguments.length > 256 ||
    request.arguments.some(
      (argument) =>
        typeof argument !== "string" || argument.length > 65_536 || argument.includes("\0"),
    )
  ) {
    failProcess("invalid-value");
  }
  if (
    !request.streamPolicy ||
    (request.harnessId !== "codex" && request.harnessId !== "claude-code") ||
    (request.harnessId === "codex" && request.streamPolicy.kind !== "terminal-capture-v1") ||
    (request.harnessId === "claude-code" &&
      request.streamPolicy.kind !== "claude-2.1.226-guard-v1") ||
    (request.streamPolicy.kind !== "terminal-capture-v1" &&
      (request.streamPolicy.kind !== "claude-2.1.226-guard-v1" ||
        request.streamPolicy.requestedModel !== "claude-opus-4-7" ||
        ![
          "plan-documentation",
          "write-documentation",
          "lint-documentation",
          "verify-technical-accuracy",
          "review-documentation",
          "evaluate-document-quality",
        ].includes(request.streamPolicy.stepId) ||
        request.streamPolicy.workingDirectory !== request.workingDirectory))
  ) {
    failProcess("invocation-policy");
  }
  const environmentNames = Object.keys(request.environment).sort();
  const expectedEnvironmentNames = NATIVE_PILOT_ENVIRONMENT_NAMES;
  if (
    environmentNames.length !== expectedEnvironmentNames.length ||
    environmentNames.some((name, index) => name !== expectedEnvironmentNames[index])
  ) {
    failProcess("environment-policy");
  }
  const home = request.environment.HOME;
  const temporaryRoot = request.environment.TMPDIR;
  if (
    !canonicalAbsolutePath(home) ||
    !canonicalAbsolutePath(temporaryRoot) ||
    !trustedDirectory(home, false) ||
    !trustedDirectory(temporaryRoot, true) ||
    !trustedDirectory(request.workingDirectory, true) ||
    !inside(temporaryRoot, request.workingDirectory) ||
    !locale(request.environment.LANG) ||
    !locale(request.environment.LC_ALL) ||
    !username(request.environment.USER)
  ) {
    failProcess("environment-policy");
  }
  const stdinUtf8 = strictUtf8(request.stdin);
  if (
    detectCredentialRuleIdsInValue({
      arguments: request.arguments,
      environment: request.environment,
      stdinUtf8,
      streamPolicy: request.streamPolicy,
    }).length > 0
  ) {
    failProcess("credential-material");
  }
}

function canonicalAbsolutePath(value: unknown): value is string {
  return typeof value === "string" && isAbsolute(value) && resolve(value) === value;
}

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function locale(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/u.test(value) &&
    !value.includes("\0")
  );
}

function strictUtf8(value: Buffer): string {
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    failProcess("invalid-value");
  }
  if (decoded.includes("\0") || decoded !== decoded.normalize("NFC")) {
    failProcess("invalid-value");
  }
  return decoded;
}

function trustedDirectory(path: string, ownerOnly: boolean): boolean {
  try {
    if (realpathSync(path) !== path) return false;
    const status = lstatSync(path);
    if (!status.isDirectory() || status.isSymbolicLink()) return false;
    const owner = typeof process.getuid === "function" ? process.getuid() : -1;
    if (status.uid !== 0 && status.uid !== owner) return false;
    return !ownerOnly || (status.mode & 0o077) === 0;
  } catch {
    return false;
  }
}

function username(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,127}$/u.test(value);
}

export function authorizeObservation(
  value: NativePilotProcessObservation,
  requestSha256: string,
  planSha256: string,
  authorizeLiveObservations: boolean,
): NativePilotProcessObservation {
  const observation = Object.freeze(value);
  if (authorizeLiveObservations) {
    PROCESS_OBSERVATION_AUTHORITIES.set(observation, {
      requestSha256,
      planSha256,
      observationSha256: nativePilotProcessObservationSha256(observation),
      consumed: false,
    });
  }
  return observation;
}

function nativePilotProcessObservationSha256(observation: NativePilotProcessObservation): string {
  return canonicalDigest({
    status: observation.status,
    exitCode: observation.exitCode,
    signal: observation.signal,
    durationMs: observation.durationMs,
    stdoutSha256: createHash("sha256").update(observation.stdout).digest("hex"),
    stderrSha256: createHash("sha256").update(observation.stderr).digest("hex"),
    stdoutBytes: observation.stdoutBytes,
    stderrBytes: observation.stderrBytes,
    stdoutOverflow: observation.stdoutOverflow,
    stderrOverflow: observation.stderrOverflow,
    stdoutEof: observation.stdoutEof,
    stderrEof: observation.stderrEof,
    stdinBytes: observation.stdinBytes,
    stdinDelivered: observation.stdinDelivered,
    processGroupSettled: observation.processGroupSettled,
    lateBytesObserved: observation.lateBytesObserved,
    streamDisposition: observation.streamDisposition,
    streamFailureCode: observation.streamFailureCode,
    providerRequests: observation.providerRequests,
    providerRequestLowerBound: observation.providerRequestLowerBound,
    retryAttempt: observation.retryAttempt,
    retryMaximum: observation.retryMaximum,
    killIssued: observation.killIssued,
    killIssuedBeforeRetryDeadline: observation.killIssuedBeforeRetryDeadline,
    stopSettlementRequired: observation.stopSettlementRequired,
    fallbackAttempted: observation.fallbackAttempted,
    descendantContainment: observation.descendantContainment,
    requestSha256: observation.requestSha256,
  });
}
