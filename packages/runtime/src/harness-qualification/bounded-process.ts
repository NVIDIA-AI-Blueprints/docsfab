// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isAbsolute } from "node:path";

export interface BoundedProcessRequest {
  readonly executablePath: string;
  readonly arguments: readonly string[];
  readonly workingDirectory: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly stdin: Buffer;
  readonly timeoutMs: number;
  readonly maxStdoutBytes: number;
  readonly maxStderrBytes: number;
  readonly signal?: AbortSignal;
}

export type BoundedProcessStatus =
  | "settled"
  | "unsupported-confinement"
  | "spawn-failed"
  | "output-limit"
  | "timeout"
  | "cancelled";

export interface BoundedProcessObservation {
  readonly status: BoundedProcessStatus;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly durationMs: number;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly stdoutOverflow: boolean;
  readonly stderrOverflow: boolean;
  readonly stdinBytes: number;
  readonly stdinDelivered: boolean;
  readonly descendantContainment: "verified" | "unsupported";
}

export type BoundedProcessRunner = (
  request: BoundedProcessRequest,
) => Promise<BoundedProcessObservation>;

/**
 * Fail closed until a platform runner can prove descendant containment.
 *
 * A detached POSIX process group is not containment: a grandchild can call
 * setsid(2), escape the group, and outlive the observed parent. This runner
 * therefore returns an unsupported observation before spawn. Linux PID-namespace
 * containment lives in `linux-containment.ts` and is selected only by
 * `createLinuxContainedHarnessQualificationHost`.
 */
export const runBoundedProcess: BoundedProcessRunner = async (request) => {
  validateRequest(request);
  if (request.signal?.aborted) return emptyObservation("cancelled");
  return emptyObservation("unsupported-confinement");
};

function validateRequest(request: BoundedProcessRequest): void {
  if (!isAbsolute(request.executablePath) || !isAbsolute(request.workingDirectory)) {
    throw new Error(
      "DocsFab requires absolute executable and working-directory paths for bounded processes.",
    );
  }
  if (
    request.arguments.some((value) => typeof value !== "string" || value.includes("\0")) ||
    Object.entries(request.environment).some(
      ([name, value]) =>
        !/^[A-Z][A-Z0-9_]*$/u.test(name) || typeof value !== "string" || value.includes("\0"),
    ) ||
    !Number.isSafeInteger(request.timeoutMs) ||
    request.timeoutMs < 1 ||
    !Number.isSafeInteger(request.maxStdoutBytes) ||
    request.maxStdoutBytes < 1 ||
    !Number.isSafeInteger(request.maxStderrBytes) ||
    request.maxStderrBytes < 1
  ) {
    throw new Error("DocsFab rejected a bounded process request with invalid values.");
  }
}

function emptyObservation(
  status: "cancelled" | "unsupported-confinement",
): BoundedProcessObservation {
  return {
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
    stdinBytes: 0,
    stdinDelivered: false,
    descendantContainment: "unsupported",
  };
}
