// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";

export interface BoundedChildInput {
  executable: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  /** Bytes read per stream before the spawn is stopped (`qualityValidator.maxOutputBytes`). */
  maxOutputBytes: number;
  /** Optional bounded JSON input; never passed on argv or through an inherited descriptor. */
  stdin?: Buffer;
}

export interface BoundedChildResult {
  outcome: "passed" | "failed" | "unavailable";
  exitCode: number | null;
  timedOut: boolean;
  stdout: Buffer;
  stderr: Buffer;
}

export async function runBoundedChild(input: BoundedChildInput): Promise<BoundedChildResult> {
  return await new Promise((resolvePromise) => {
    const child = spawn(input.executable, input.args, {
      cwd: input.cwd,
      shell: false,
      stdio: [input.stdin ? "pipe" : "ignore", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        PYTHONDONTWRITEBYTECODE: "1",
        PYTHONNOUSERSITE: "1",
      },
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let unavailable = false;
    let limited = false;
    child.stdin?.on("error", () => {
      unavailable = true;
    });
    if (input.stdin) child.stdin?.end(input.stdin);
    const append = (target: Buffer[], chunk: Buffer, kind: "stdout" | "stderr") => {
      const current = kind === "stdout" ? stdoutBytes : stderrBytes;
      const remaining = Math.max(0, input.maxOutputBytes - current);
      if (remaining > 0) target.push(chunk.subarray(0, remaining));
      if (kind === "stdout") stdoutBytes += chunk.length;
      else stderrBytes += chunk.length;
      if (current + chunk.length > input.maxOutputBytes && !limited) {
        limited = true;
        child.kill("SIGKILL");
      }
    };
    child.stdout?.on("data", (chunk: Buffer) => append(stdout, chunk, "stdout"));
    child.stderr?.on("data", (chunk: Buffer) => append(stderr, chunk, "stderr"));
    child.once("error", () => {
      unavailable = true;
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      limited = true;
      timedOut = true;
      child.kill("SIGKILL");
    }, input.timeoutMs);
    child.once("close", (code) => {
      clearTimeout(timer);
      resolvePromise({
        outcome: unavailable ? "unavailable" : code === 0 && !limited ? "passed" : "failed",
        exitCode: typeof code === "number" ? code : null,
        timedOut,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      });
    });
  });
}
