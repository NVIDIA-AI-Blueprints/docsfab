// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Cold wire imports do not load the complete runtime validation graph.
 * A validation call still uses the installed canonical implementation, never
 * a registered callback, retained substitute manifest, or reduced decoder.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { contractDecodeLimits } from "../contract-kit/decode-bounds.js";
import type { WorkflowDefinition, WorkflowName } from "../workflow-contracts/contracts.js";
import type { RunRecord } from "../records/contracts.js";
import { bad } from "./wire-decode.js";

type CanonicalValidation = typeof import("./terminal-validation-runtime.js");
let canonical: CanonicalValidation | undefined;

function loadCanonicalValidation(): CanonicalValidation {
  if (canonical) return canonical;
  const runtimeRequire = createRequire(new URL("../../package.json", import.meta.url));
  try {
    // Source releases need the runtime's own TypeScript resolver. Compiled
    // packages have native JavaScript and must not require the dev-only tsx.
    const api = existsSync(new URL("./terminal-validation-runtime.ts", import.meta.url))
      ? (
          runtimeRequire("tsx/cjs/api") as {
            require(id: string, fromFile: string | URL): CanonicalValidation;
          }
        ).require("./terminal-validation-runtime.js", import.meta.url)
      : (createRequire(import.meta.url)("./terminal-validation-runtime.js") as CanonicalValidation);
    for (const name of [
      "getDeclarativeWorkflow",
      "isWorkflowManifestV3",
      "validateAuthoringRunRecordV1",
      "contractDecodeLimits",
      "installContractDecodeLimitSnapshot",
    ] as const) {
      if (typeof api[name] !== "function") bad("terminal-validation-unavailable");
    }
    canonical = api;
    return api;
  } catch {
    // Neither loader diagnostics nor absence can become a non-V3/default path.
    bad("terminal-validation-unavailable");
  }
}

function withCurrentDecodeLimits<T>(action: (api: CanonicalValidation) => T): T {
  const current = contractDecodeLimits();
  const api = loadCanonicalValidation();
  const previous = api.contractDecodeLimits();
  api.installContractDecodeLimitSnapshot(current);
  try {
    return action(api);
  } finally {
    // All canonical operations here are synchronous. Restore even on rejection,
    // including when source/compiled loading happens to share the same realm.
    api.installContractDecodeLimitSnapshot(previous);
  }
}

export function getDeclarativeWorkflow(name: WorkflowName): WorkflowDefinition | undefined {
  return withCurrentDecodeLimits((api) => api.getDeclarativeWorkflow(name));
}

export function isWorkflowManifestV3(workflow: WorkflowDefinition): boolean {
  return withCurrentDecodeLimits((api) => api.isWorkflowManifestV3(workflow));
}

export function validateAuthoringRunRecordV1(
  record: Readonly<RunRecord>,
  workflow: WorkflowDefinition,
  options: { requireTerminalSuccess?: boolean } = {},
) {
  return withCurrentDecodeLimits((api) =>
    api.validateAuthoringRunRecordV1(record, workflow, options),
  );
}
