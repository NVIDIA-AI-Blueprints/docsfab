// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { streamObject } from "./pilot-process/stream-values.js";
import {
  CLAUDE_INTERNAL_MAX_RETRIES,
  claudeRawModelKeyCount,
  parseClaudeStreamLine,
  rawRetryAttempt,
  rawRetryDelay,
  retrySignature,
  validateClaudeAssistant,
  validateClaudeInit,
  validateClaudeRateLimit,
  validateClaudeResult,
  validateClaudeRetry,
  validateClaudeStructuredOutputAcknowledgement,
} from "./pilot-process/claude-stream-codecs.js";

import { NATIVE_PILOT_MAXIMA, type NativePilotFailureCode } from "./pilot-contracts.js";
import { detectCredentialRuleIdsInValue } from "../security/repository-scanner.js";
import {
  PROCESS_REQUEST_AUTHORITIES,
  NativePilotProcessError,
  authorizeObservation,
  failProcess,
  nativePilotProcessRequestSha256,
  validateNativePilotProcessRequest,
  type NativePilotProcessObservation,
  type NativePilotProcessRequest,
  type NativePilotProcessRunner,
  type NativePilotProcessStatus,
} from "./pilot-process-contracts.js";

export {
  NativePilotProcessError,
  authorizeNativePilotProcessRequest,
  consumeNativePilotProcessObservationAuthority,
  nativePilotProcessRequestSha256,
  validateNativePilotProcessRequest,
  type NativePilotProcessObservation,
  type NativePilotProcessRequest,
  type NativePilotProcessRunner,
  type NativePilotProcessStatus,
} from "./pilot-process-contracts.js";

interface ClaudeStreamGuardState {
  buffer: Buffer;
  readonly events: Array<Record<string, unknown>>;
  sessionId: string | null;
  rateLimitSeen: boolean;
  assistantSeen: boolean;
  assistantToolUseId: string | null;
  assistantOutputInput: unknown | null;
  assistantOutputSha256: string | null;
  acknowledgementSeen: boolean;
  successSeen: boolean;
  failureCode: NativePilotFailureCode | null;
  providerRequestLowerBound: number;
  retryAttempt: number | null;
  retryMaximum: number | null;
  killIssued: boolean;
  killIssuedAtMs: number | null;
  retryDeadlineMs: number | null;
  lateBytesObserved: boolean;
}

function createClaudeStreamGuardState(): ClaudeStreamGuardState {
  return {
    buffer: Buffer.alloc(0),
    events: [],
    sessionId: null,
    rateLimitSeen: false,
    assistantSeen: false,
    assistantToolUseId: null,
    assistantOutputInput: null,
    assistantOutputSha256: null,
    acknowledgementSeen: false,
    successSeen: false,
    failureCode: null,
    providerRequestLowerBound: 0,
    retryAttempt: null,
    retryMaximum: null,
    killIssued: false,
    killIssuedAtMs: null,
    retryDeadlineMs: null,
    lateBytesObserved: false,
  };
}

function createNativePilotProcessRunner(
  spawnProcess: typeof spawn,
  authorizeLiveObservations: boolean,
): NativePilotProcessRunner {
  return async (request) => {
    validateNativePilotProcessRequest(request);
    const requestAuthority = PROCESS_REQUEST_AUTHORITIES.get(request);
    const requestSha256 = nativePilotProcessRequestSha256(request);
    if (
      !requestAuthority ||
      requestAuthority.consumed ||
      requestAuthority.requestSha256 !== requestSha256
    ) {
      failProcess("invocation-policy");
    }
    requestAuthority.consumed = true;
    if (request.signal?.aborted) {
      return emptyObservation(
        "cancelled",
        request,
        requestSha256,
        requestAuthority.planSha256,
        authorizeLiveObservations,
      );
    }
    const startedAt = performance.now();

    return await new Promise<NativePilotProcessObservation>((resolvePromise, rejectPromise) => {
      let terminalStatus: NativePilotProcessStatus = "settled";
      let exitCode: number | null = null;
      let exitSignal: string | null = null;
      let closeSeen = false;
      let stdoutEof = false;
      let stderrEof = false;
      let stdoutSettled = false;
      let stderrSettled = false;
      let stdinDelivered = false;
      let stdinSettled = false;
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let stdoutOverflow = false;
      let stderrOverflow = false;
      let lateBytesObserved = false;
      let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      let resolved = false;
      let settlementStarted = false;
      let processGroupSettled = false;
      const claudeGuard =
        request.streamPolicy.kind === "claude-2.1.226-guard-v1"
          ? createClaudeStreamGuardState()
          : null;
      const codexRequestCounter =
        request.harnessId === "codex" ? createCodexRequestCounterState() : null;

      const finish = (): void => {
        if (
          resolved ||
          settlementStarted ||
          !closeSeen ||
          !stdoutSettled ||
          !stderrSettled ||
          !stdinSettled
        ) {
          return;
        }
        settlementStarted = true;
        void settleProcessGroup(child.pid).then((settlement) => {
          processGroupSettled = settlement.settled;
          if (settlement.residualActivity && terminalStatus === "settled") {
            terminalStatus = "process-failed";
          }
          if (claudeGuard && settlement.residualActivity) {
            claudeGuard.failureCode ??= "process-failed";
            if (!claudeGuard.killIssued) {
              const now = performance.now();
              claudeGuard.killIssued = true;
              claudeGuard.killIssuedAtMs = now;
              claudeGuard.retryDeadlineMs = now + 1;
            }
          }
          resolved = true;
          clearTimeout(timer);
          request.signal?.removeEventListener("abort", onAbort);
          if (claudeGuard && !processGroupSettled) {
            rejectPromise(new NativePilotProcessError("process-not-settled"));
            return;
          }
          if (claudeGuard && (!stdoutEof || !stderrEof)) {
            rejectPromise(new NativePilotProcessError("process-not-settled"));
            return;
          }
          const terminalCapture = claudeGuard === null;
          const providerRequestLowerBound = terminalCapture
            ? (codexRequestCounter?.providerRequests ?? 0)
            : claudeGuard.providerRequestLowerBound;
          const streamFailureCode =
            claudeGuard?.failureCode ??
            (terminalCapture && providerRequestLowerBound > 1 ? "retry-policy-mismatch" : null);
          if (streamFailureCode !== null && terminalStatus === "settled") {
            terminalStatus = "process-failed";
          }
          resolvePromise(
            authorizeObservation(
              {
                status: terminalStatus,
                exitCode,
                signal: exitSignal,
                durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
                stdout,
                stderr,
                stdoutBytes,
                stderrBytes,
                stdoutOverflow,
                stderrOverflow,
                stdoutEof,
                stderrEof,
                stdinBytes: request.stdin.byteLength,
                stdinDelivered,
                processGroupSettled,
                lateBytesObserved: lateBytesObserved || (claudeGuard?.lateBytesObserved ?? false),
                streamDisposition: terminalCapture
                  ? "terminal-capture"
                  : streamFailureCode === null && claudeGuard.successSeen
                    ? "success"
                    : "stopped",
                streamFailureCode,
                providerRequests: providerRequestLowerBound,
                providerRequestLowerBound,
                retryAttempt: claudeGuard?.retryAttempt ?? null,
                retryMaximum: claudeGuard?.retryMaximum ?? null,
                killIssued: claudeGuard?.killIssued ?? false,
                killIssuedBeforeRetryDeadline:
                  claudeGuard?.killIssued === true &&
                  claudeGuard.killIssuedAtMs !== null &&
                  claudeGuard.retryDeadlineMs !== null &&
                  claudeGuard.killIssuedAtMs < claudeGuard.retryDeadlineMs,
                stopSettlementRequired: streamFailureCode !== null,
                fallbackAttempted: false,
                descendantContainment: "unsupported",
                requestSha256,
              },
              requestSha256,
              requestAuthority.planSha256,
              authorizeLiveObservations,
            ),
          );
        });
      };
      const append = (current: Buffer, chunk: Buffer, maximum: number): Buffer => {
        const remaining = Math.max(0, maximum - current.byteLength);
        return remaining === 0 ? current : Buffer.concat([current, chunk.subarray(0, remaining)]);
      };

      let child: ReturnType<typeof spawn>;
      try {
        child = spawnProcess(request.executablePath, request.arguments, {
          cwd: request.workingDirectory,
          env: { ...request.environment },
          shell: false,
          detached: process.platform !== "win32",
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch {
        resolvePromise(
          emptyObservation(
            "spawn-failed",
            request,
            requestSha256,
            requestAuthority.planSha256,
            authorizeLiveObservations,
          ),
        );
        return;
      }
      const childStdin = child.stdin!;
      const childStdout = child.stdout!;
      const childStderr = child.stderr!;

      const killGroup = (): void => {
        try {
          if (child.pid !== undefined && process.platform !== "win32") {
            process.kill(-child.pid, "SIGKILL");
            return;
          }
          child.kill("SIGKILL");
        } catch {
          try {
            child.kill("SIGKILL");
          } catch {
            // The close event may have won the race; settlement remains observable.
          }
        }
      };
      const armClaudeStop = (
        code: NativePilotFailureCode,
        retryDelayMs = 1,
        replace = false,
      ): void => {
        if (!claudeGuard) return;
        if (claudeGuard.failureCode === null || replace) claudeGuard.failureCode = code;
        if (!claudeGuard.killIssued) {
          const now = performance.now();
          claudeGuard.killIssued = true;
          claudeGuard.killIssuedAtMs = now;
          claudeGuard.retryDeadlineMs = now + Math.max(1, retryDelayMs);
        }
        if (terminalStatus === "settled") terminalStatus = "process-failed";
        killGroup();
      };
      const processClaudeLine = (line: Buffer): void => {
        if (!claudeGuard) return;
        let event: Record<string, unknown>;
        try {
          event = parseClaudeStreamLine(line);
        } catch (error) {
          if (claudeGuard.successSeen) {
            claudeGuard.lateBytesObserved = true;
            armClaudeStop("late-stream-event", 1, true);
            return;
          }
          if (claudeGuard.failureCode !== null) {
            claudeGuard.lateBytesObserved = true;
            armClaudeStop(claudeGuard.failureCode);
            return;
          }
          armClaudeStop(
            error instanceof NativePilotProcessError ? error.code : "malformed-stream",
            1,
            true,
          );
          return;
        }
        const retryEvent = retrySignature(event);
        const rawAttempt = retryEvent ? rawRetryAttempt(event) : null;
        const rawDelay = retryEvent ? rawRetryDelay(event) : 1;
        if (rawAttempt !== null) {
          claudeGuard.providerRequestLowerBound = Math.max(
            claudeGuard.providerRequestLowerBound,
            rawAttempt,
          );
          claudeGuard.retryAttempt = Math.max(claudeGuard.retryAttempt ?? 0, rawAttempt);
          claudeGuard.retryMaximum = Number.isSafeInteger(event.max_retries)
            ? (event.max_retries as number)
            : null;
        }
        if (retryEvent && rawAttempt !== null) {
          if (claudeGuard.successSeen) {
            claudeGuard.lateBytesObserved = true;
            armClaudeStop("late-stream-event", rawDelay, true);
            return;
          }
          if (claudeGuard.failureCode !== null) {
            claudeGuard.lateBytesObserved = true;
            if (rawAttempt > 1) armClaudeStop("retry-policy-mismatch", rawDelay, true);
            else armClaudeStop(claudeGuard.failureCode, rawDelay);
            return;
          }
          if (detectCredentialRuleIdsInValue(event).length > 0) {
            armClaudeStop("credential-material", rawDelay, true);
            return;
          }
          armClaudeStop("provider-retry-blocked", rawDelay);
          if (claudeGuard.sessionId === null) {
            armClaudeStop("retry-event-mismatch", rawDelay, true);
            return;
          }
          try {
            const retry = validateClaudeRetry(event, claudeGuard.sessionId);
            claudeGuard.retryAttempt = retry.attempt;
            claudeGuard.retryMaximum = CLAUDE_INTERNAL_MAX_RETRIES;
            if (retry.attempt > 1) {
              armClaudeStop("retry-policy-mismatch", retry.delayMs, true);
            }
            claudeGuard.events.push(event);
          } catch (error) {
            armClaudeStop(
              error instanceof NativePilotProcessError ? error.code : "retry-event-mismatch",
              rawDelay,
              true,
            );
          }
          return;
        }
        if (claudeGuard.successSeen) {
          claudeGuard.lateBytesObserved = true;
          armClaudeStop("late-stream-event", 1, true);
          return;
        }
        if (claudeGuard.failureCode !== null) {
          claudeGuard.lateBytesObserved = true;
          armClaudeStop(claudeGuard.failureCode);
          return;
        }
        if (detectCredentialRuleIdsInValue(event).length > 0) {
          armClaudeStop("credential-material", rawDelay, true);
          return;
        }
        try {
          if (claudeGuard.sessionId === null) {
            claudeGuard.sessionId = validateClaudeInit(event, request);
            claudeGuard.events.push(event);
            return;
          }
          if (event.type === "rate_limit_event") {
            if (claudeGuard.rateLimitSeen || claudeGuard.assistantSeen) {
              failProcess("rate-limit-event-mismatch");
            }
            validateClaudeRateLimit(event, claudeGuard.sessionId);
            claudeGuard.rateLimitSeen = true;
            claudeGuard.events.push(event);
            return;
          }
          if (event.type === "assistant" && !claudeGuard.assistantSeen) {
            const assistant = validateClaudeAssistant(event, claudeGuard.sessionId, request);
            claudeGuard.assistantSeen = true;
            claudeGuard.assistantToolUseId = assistant.toolUseId;
            claudeGuard.assistantOutputInput = assistant.input;
            claudeGuard.assistantOutputSha256 = assistant.outputSha256;
            claudeGuard.providerRequestLowerBound = Math.max(
              claudeGuard.providerRequestLowerBound,
              1,
            );
            claudeGuard.events.push(event);
            return;
          }
          if (
            event.type === "user" &&
            claudeGuard.assistantSeen &&
            !claudeGuard.acknowledgementSeen &&
            claudeGuard.assistantToolUseId !== null
          ) {
            validateClaudeStructuredOutputAcknowledgement(
              event,
              claudeGuard.sessionId,
              claudeGuard.assistantToolUseId,
            );
            claudeGuard.acknowledgementSeen = true;
            claudeGuard.events.push(event);
            return;
          }
          if (
            event.type === "result" &&
            claudeGuard.assistantSeen &&
            claudeGuard.acknowledgementSeen
          ) {
            if (
              claudeGuard.assistantOutputInput === null ||
              claudeGuard.assistantOutputSha256 === null
            ) {
              failProcess("claude-stream-success-invalid");
            }
            // Project the raw model-key count before strict decoding so a malformed
            // auxiliary entry cannot understate the retained request lower bound.
            claudeGuard.providerRequestLowerBound = Math.max(
              claudeGuard.providerRequestLowerBound,
              1,
              claudeRawModelKeyCount(event.modelUsage),
            );
            validateClaudeResult(
              event,
              claudeGuard.sessionId,
              request,
              claudeGuard.assistantOutputInput,
              claudeGuard.assistantOutputSha256,
            );
            claudeGuard.successSeen = true;
            claudeGuard.events.push(event);
            return;
          }
          failProcess("unexpected-tool-activity");
        } catch (error) {
          armClaudeStop(
            error instanceof NativePilotProcessError ? error.code : "malformed-stream",
            1,
            true,
          );
        }
      };
      const consumeClaudeChunk = (chunk: Buffer): void => {
        if (!claudeGuard) return;
        if ((claudeGuard.failureCode !== null || claudeGuard.successSeen) && chunk.byteLength > 0) {
          claudeGuard.lateBytesObserved = true;
          armClaudeStop(
            claudeGuard.successSeen
              ? "late-stream-event"
              : (claudeGuard.failureCode ?? "late-stream-event"),
            1,
            claudeGuard.successSeen,
          );
        }
        claudeGuard.buffer = Buffer.concat([claudeGuard.buffer, chunk]);
        for (;;) {
          const newline = claudeGuard.buffer.indexOf(0x0a);
          if (newline < 0) break;
          const line = claudeGuard.buffer.subarray(0, newline);
          claudeGuard.buffer = claudeGuard.buffer.subarray(newline + 1);
          processClaudeLine(line);
        }
        if (
          (claudeGuard.failureCode !== null || claudeGuard.successSeen) &&
          claudeGuard.buffer.byteLength > 0
        ) {
          claudeGuard.lateBytesObserved = true;
          armClaudeStop(
            claudeGuard.successSeen
              ? "late-stream-event"
              : (claudeGuard.failureCode ?? "late-stream-event"),
            1,
            claudeGuard.successSeen,
          );
        }
      };
      const stop = (
        status: Exclude<NativePilotProcessStatus, "settled" | "spawn-failed">,
      ): void => {
        if (terminalStatus === "settled") terminalStatus = status;
        if (claudeGuard) {
          const code: NativePilotFailureCode =
            status === "timeout"
              ? "timeout"
              : status === "cancelled"
                ? "cancelled"
                : status === "output-limit"
                  ? "output-limit"
                  : "process-failed";
          armClaudeStop(code);
        }
        killGroup();
      };
      const onAbort = (): void => stop("cancelled");
      const timer = setTimeout(() => stop("timeout"), request.timeoutMs);
      request.signal?.addEventListener("abort", onAbort, { once: true });

      childStdout.on("data", (chunk: Buffer) => {
        if (closeSeen) {
          lateBytesObserved = true;
          if (claudeGuard) {
            claudeGuard.lateBytesObserved = true;
            armClaudeStop("late-stream-event", 1, true);
          }
        }
        stdoutBytes += chunk.byteLength;
        if (codexRequestCounter) consumeCodexRequestChunk(codexRequestCounter, chunk);
        if (stdoutBytes > request.maxStdoutBytes) {
          stdoutOverflow = true;
          stop("output-limit");
        }
        stdout = append(stdout, chunk, request.maxStdoutBytes);
        consumeClaudeChunk(chunk);
      });
      childStderr.on("data", (chunk: Buffer) => {
        if (closeSeen) lateBytesObserved = true;
        stderrBytes += chunk.byteLength;
        if (stderrBytes > request.maxStderrBytes) {
          stderrOverflow = true;
          stop("output-limit");
        }
        stderr = append(stderr, chunk, request.maxStderrBytes);
      });
      childStdout.once("end", () => {
        if (codexRequestCounter) finalizeCodexRequestCounter(codexRequestCounter);
        if (claudeGuard) {
          if (claudeGuard.buffer.byteLength > 0 && claudeGuard.failureCode === null) {
            armClaudeStop("claude-stream-success-invalid", 1, true);
          } else if (!claudeGuard.successSeen && claudeGuard.failureCode === null) {
            armClaudeStop("claude-stream-success-invalid", 1, true);
          }
        }
        stdoutEof = true;
        stdoutSettled = true;
        finish();
      });
      childStderr.once("end", () => {
        stderrEof = true;
        stderrSettled = true;
        finish();
      });
      childStdout.once("error", () => {
        if (codexRequestCounter) finalizeCodexRequestCounter(codexRequestCounter);
        if (terminalStatus === "settled") terminalStatus = "process-failed";
        armClaudeStop("process-not-settled", 1, true);
        stdoutSettled = true;
        killGroup();
        finish();
      });
      childStderr.once("error", () => {
        if (terminalStatus === "settled") terminalStatus = "process-failed";
        armClaudeStop("process-not-settled", 1, true);
        stderrSettled = true;
        killGroup();
        finish();
      });
      child.once("error", () => {
        if (terminalStatus === "settled") terminalStatus = "spawn-failed";
        armClaudeStop("spawn-failed", 1, true);
        closeSeen = true;
        stdoutEof = true;
        stderrEof = true;
        stdoutSettled = true;
        stderrSettled = true;
        stdinSettled = true;
        finish();
      });
      child.once("close", (code, signal) => {
        closeSeen = true;
        exitCode = code;
        exitSignal = signal;
        if (claudeGuard && code !== 0 && claudeGuard.failureCode === null) {
          armClaudeStop("process-failed", 1, true);
        }
        finish();
      });
      childStdin.once("error", () => {
        if (stdinSettled) return;
        stdinDelivered = false;
        stdinSettled = true;
        stop("process-failed");
        finish();
      });
      childStdin.end(request.stdin, () => {
        if (stdinSettled) return;
        stdinDelivered = true;
        stdinSettled = true;
        finish();
      });
      if (request.signal?.aborted) onAbort();
    });
  };
}

export const runNativePilotProcess = createNativePilotProcessRunner(spawn, true);

/** Trusted test seam. Observations from this runner are never live-authorized. */
export function createNativePilotSimulationProcessRunner(
  spawnProcess: typeof spawn,
): NativePilotProcessRunner {
  return createNativePilotProcessRunner(spawnProcess, false);
}

function emptyObservation(
  status: "spawn-failed" | "cancelled",
  request: NativePilotProcessRequest,
  requestSha256: string,
  planSha256: string,
  authorizeLiveObservations: boolean,
): NativePilotProcessObservation {
  return authorizeObservation(
    {
      status,
      exitCode: null,
      signal: null,
      durationMs: 0,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      stdoutBytes: 0,
      stderrBytes: 0,
      stdoutOverflow: false,
      stderrOverflow: false,
      stdoutEof: true,
      stderrEof: true,
      stdinBytes: request.stdin.byteLength,
      stdinDelivered: false,
      processGroupSettled: true,
      lateBytesObserved: false,
      streamDisposition:
        request.streamPolicy.kind === "terminal-capture-v1" ? "terminal-capture" : "stopped",
      streamFailureCode: status,
      providerRequests: 0,
      providerRequestLowerBound: 0,
      retryAttempt: null,
      retryMaximum: null,
      killIssued: false,
      killIssuedBeforeRetryDeadline: false,
      stopSettlementRequired: false,
      fallbackAttempted: false,
      descendantContainment: "unsupported",
      requestSha256,
    },
    requestSha256,
    planSha256,
    authorizeLiveObservations,
  );
}

async function settleProcessGroup(
  processGroupId: number | undefined,
): Promise<{ settled: boolean; residualActivity: boolean }> {
  if (processGroupId === undefined) return { settled: true, residualActivity: false };
  if (process.platform === "win32") return { settled: false, residualActivity: false };
  const residualActivity = processGroupExists(processGroupId);
  if (!residualActivity) return { settled: true, residualActivity: false };
  try {
    process.kill(-processGroupId, "SIGKILL");
  } catch {
    // A concurrent exit is verified by the bounded poll below.
  }
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (!processGroupExists(processGroupId)) return { settled: true, residualActivity: true };
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  return { settled: false, residualActivity: true };
}

function processGroupExists(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

interface CodexRequestCounterState {
  buffer: Buffer;
  discardingOversizeLine: boolean;
  providerRequests: number;
}

function createCodexRequestCounterState(): CodexRequestCounterState {
  return { buffer: Buffer.alloc(0), discardingOversizeLine: false, providerRequests: 0 };
}

function consumeCodexRequestChunk(state: CodexRequestCounterState, chunk: Buffer): void {
  let cursor = 0;
  while (cursor < chunk.byteLength) {
    const newline = chunk.indexOf(0x0a, cursor);
    const end = newline < 0 ? chunk.byteLength : newline;
    if (!state.discardingOversizeLine) {
      const segment = chunk.subarray(cursor, end);
      if (state.buffer.byteLength + segment.byteLength > NATIVE_PILOT_MAXIMA.maxStdoutBytes) {
        state.buffer = Buffer.alloc(0);
        state.discardingOversizeLine = true;
      } else {
        state.buffer = Buffer.concat([state.buffer, segment]);
      }
    }
    if (newline < 0) break;
    if (!state.discardingOversizeLine) countCodexRequestLine(state, state.buffer);
    state.buffer = Buffer.alloc(0);
    state.discardingOversizeLine = false;
    cursor = newline + 1;
  }
}

function finalizeCodexRequestCounter(state: CodexRequestCounterState): void {
  if (!state.discardingOversizeLine && state.buffer.byteLength > 0) {
    countCodexRequestLine(state, state.buffer);
  }
  state.buffer = Buffer.alloc(0);
  state.discardingOversizeLine = false;
}

function countCodexRequestLine(state: CodexRequestCounterState, bytes: Buffer): void {
  let line = bytes;
  if (line.at(-1) === 0x0d) line = line.subarray(0, -1);
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(line);
    const event = streamObject(JSON.parse(decoded), "malformed-stream");
    if (event.type === "turn.started") state.providerRequests += 1;
  } catch {
    return;
  }
}
