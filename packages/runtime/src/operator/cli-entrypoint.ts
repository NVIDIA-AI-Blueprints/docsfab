// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { ensureBuiltInProxy } from "../model/outbound-http-policy.js";
import { reportOperatorFailure, wantsJsonFailureOutput } from "./error-envelope.js";

/**
 * True when `process.argv[1]` is the module at `moduleUrl`. Both sides are
 * realpathed, so a symlinked bin or checkout still counts as a direct run.
 */
export function isProcessEntrypoint(moduleUrl: string): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    // A missing or unreadable path is not this module.
    return false;
  }
}

/**
 * Runs a CLI module's entry function only when that module is the process
 * entrypoint (`process.argv[1]` resolves to `moduleUrl`), after turning on
 * Node's built-in proxy support when a proxy variable is set.
 *
 * A resolved `{ exitCode }` becomes `process.exitCode` (`undefined` leaves it
 * unchanged); a rejection is reported through the operator failure envelope
 * and sets exit code 1. A synchronous throw from `run` propagates unchanged.
 */
export function runCliEntrypoint(
  moduleUrl: string,
  run: () => Promise<{ exitCode: number } | undefined>,
): void {
  if (!isProcessEntrypoint(moduleUrl)) return;
  ensureBuiltInProxy();
  run()
    .then((result) => {
      if (result) process.exitCode = result.exitCode;
    })
    .catch((error: unknown) => {
      reportOperatorFailure(error, { json: wantsJsonFailureOutput() });
      process.exitCode = 1;
    });
}
