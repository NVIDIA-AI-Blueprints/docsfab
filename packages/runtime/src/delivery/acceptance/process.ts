// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";

const MAX_OUTPUT = 4 * 1024 * 1024;

export async function command(
  commandName: string,
  args: readonly string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
  stdin?: Uint8Array,
): Promise<{ exitCode: number; stdout: Buffer }> {
  return new Promise((resolveResult) => {
    const child = spawn(commandName, [...args], {
      cwd,
      env: environment,
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    const chunks: Buffer[] = [];
    let size = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size <= MAX_OUTPUT) chunks.push(Buffer.from(chunk));
      else child.kill("SIGKILL");
    });
    child.once("error", () => resolveResult({ exitCode: 1, stdout: Buffer.concat(chunks) }));
    child.once("close", (code) =>
      resolveResult({
        exitCode: code === 0 && size <= MAX_OUTPUT ? 0 : 1,
        stdout: Buffer.concat(chunks),
      }),
    );
    child.stdin.end(stdin ? Buffer.from(stdin) : undefined);
  });
}
