// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { parentPort, workerData } from "node:worker_threads";
const parserPath = import.meta.url.endsWith(".ts") ? "./github-pr-pack.ts" : "./github-pr-pack.js";
const { preflightGithubPackSync } = await import(parserPath);

try {
  const { pack, limits } = workerData as {
    pack: Uint8Array;
    limits: Parameters<typeof preflightGithubPackSync>[1];
  };
  parentPort?.postMessage({ ok: true, result: preflightGithubPackSync(pack, limits) });
} catch (error) {
  const isPreflightFailure =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string";
  const code = isPreflightFailure ? error.code : "worker-failed";
  const observed =
    isPreflightFailure && "observed" in error && typeof error.observed === "number"
      ? error.observed
      : undefined;
  parentPort?.postMessage({ ok: false, code, observed });
}
