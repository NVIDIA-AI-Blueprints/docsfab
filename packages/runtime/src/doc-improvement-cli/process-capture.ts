// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";

import type { CommandEvidence } from "../doc-improvement.js";
import { sha256 } from "../content-ir/canonical.js";

const MAX_COMMAND_OUTPUT = 8 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 120_000;

export interface RawCommandResult {
  exitCode: number;
  stdout: Buffer;
  output: Buffer;
}

export async function runRaw(
  file: string,
  args: string[],
  cwd = process.cwd(),
  environment: NodeJS.ProcessEnv = { PATH: process.env.PATH },
  stdin?: Uint8Array,
): Promise<RawCommandResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(file, args, {
      cwd,
      env: environment,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let forcedFailure = false;
    let settled = false;
    const terminateTree = (): void => {
      try {
        if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const collect = (target: Buffer[], chunk: Buffer): void => {
      outputBytes += chunk.byteLength;
      if (outputBytes > MAX_COMMAND_OUTPUT) {
        forcedFailure = true;
        terminateTree();
        return;
      }
      target.push(Buffer.from(chunk));
    };
    const timer = setTimeout(() => {
      forcedFailure = true;
      terminateTree();
    }, COMMAND_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.once("error", () => {
      forcedFailure = true;
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Kill any ordinary descendants that kept the process group alive. Ready
      // validation additionally requires bwrap's PID namespace for descendants
      // that deliberately escape this group.
      terminateTree();
      resolvePromise({
        exitCode: !forcedFailure && code === 0 ? 0 : 1,
        stdout: Buffer.concat(stdout),
        output: Buffer.concat([...stdout, ...stderr]),
      });
    });
    child.stdin.once("error", () => undefined);
    child.stdin.end(stdin ? Buffer.from(stdin) : undefined);
  });
}

export function text(result: RawCommandResult): string {
  return result.stdout.toString("utf8");
}

export function commandEvidence(
  id: CommandEvidence["id"],
  command: string[],
  result: RawCommandResult,
): CommandEvidence {
  return { id, command, exitCode: result.exitCode, outputSha256: sha256(result.output) };
}

export function emptyFailure(): RawCommandResult {
  return { exitCode: 1, stdout: Buffer.alloc(0), output: Buffer.alloc(0) };
}
