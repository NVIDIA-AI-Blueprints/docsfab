// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * TypeScript sources load the lease decoder through tsx. When that load fails,
 * as in a source checkout installed without devDependencies, run limit
 * observations report `internal-error` with the cause and the record path,
 * never `invalid-record`. The compiled package imports its own decoder; see
 * `doctor-limits-built-cli.test.ts`.
 */
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  projectRunLimitObservations,
  readRunLimitObservations,
} from "../src/config/limits-observations.js";
import { createExecutionLeaseCoordinatorPolicy } from "../src/execution/index.js";
import { PiExecutionLeaseController } from "../src/harness/pi-lease.js";
import type { InferenceAttemptEvidence, RunRecord } from "../src/records/contracts.js";
import { FileRunStore } from "../src/records/file-store.js";
import { temporaryRoots } from "./helpers/temp.js";

vi.mock("node:module", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:module")>();
  return {
    ...actual,
    createRequire: (from: string | URL) => {
      const real = actual.createRequire(from);
      return Object.assign((id: string) => {
        if (id === "tsx/cjs/api") {
          throw Object.assign(new Error(`Cannot find module '${id}'`), {
            code: "MODULE_NOT_FOUND",
          });
        }
        return real(id);
      }, real);
    },
  };
});

const roots = temporaryRoots();

describe("run limit observations when the TypeScript decoder cannot load", () => {
  it("reports the failed load as internal-error at the record, never invalid-record", async () => {
    const stateDirectory = await store("unloaded-run", attempt(12, true));
    const recordPath = join(stateDirectory, "unloaded-run.json");

    await expect(
      readRunLimitObservations({ environment: { DOCSFAB_STATE_DIR: stateDirectory } }),
    ).rejects.toMatchObject({
      name: "LimitObservationError",
      code: "internal-error",
      path: recordPath,
      message: `Run limit observations failed (internal-error) at ${recordPath}: Error: Cannot find module 'tsx/cjs/api'`,
      nextAction: expect.stringMatching(/^Report this message to the DocsFab maintainers\./u),
    });
    await expect(
      projectRunLimitObservations({ stateDirectory, recordId: "unloaded-run" }),
    ).rejects.toMatchObject({ code: "internal-error", path: recordPath });
  });

  it("still projects an attempt without lease evidence, which needs no decoder", async () => {
    const stateDirectory = await store("unleased-run", attempt(13, false));

    await expect(
      readRunLimitObservations({ environment: { DOCSFAB_STATE_DIR: stateDirectory } }),
    ).resolves.toEqual({ "retry.maxRetries": 0 });
  });
});

async function store(id: string, onlyAttempt: InferenceAttemptEvidence): Promise<string> {
  const stateDirectory = await roots.create("docsfab-limit-decoder-load-", { mode: 0o700 });
  const record: RunRecord = {
    schemaVersion: 2,
    id,
    workflow: "readiness",
    repository: {
      sourcePath: "/operator/source",
      requestedRevision: "HEAD",
      revision: "a".repeat(40),
    },
    workspace: { strategy: "tracked-export", disposable: true },
    status: "succeeded",
    createdAt: "2026-10-07T12:00:00.000Z",
    models: [],
    skills: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0 },
    tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
    steps: [
      {
        id: "observe",
        title: "Observe",
        skill: "observe",
        mode: "read-only",
        status: "succeeded",
        inference: {
          configuredMaxRetries: 0,
          effectiveMaxRetries: 0,
          baseDelayMs: 0,
          maxDelayMs: 0,
          retryableCategories: [],
          replay: "read-only",
          attempts: [onlyAttempt],
        },
      },
    ],
  };
  await new FileRunStore(stateDirectory).save(record);
  return stateDirectory;
}

function attempt(durationMs: number, leased: boolean): InferenceAttemptEvidence {
  return {
    attempt: 1,
    outcome: "succeeded",
    retryable: false,
    retryScheduled: false,
    durationMs,
    ...(leased ? { executionLease: completedLease() } : {}),
  };
}

function completedLease() {
  const context = {
    status: "ready" as const,
    availableInputTokens: 10_000,
    requiredInputTokens: 1,
    authoritySha256: "9".repeat(64),
  };
  const controller = new PiExecutionLeaseController({
    policy: createExecutionLeaseCoordinatorPolicy({
      maxCompactions: 1,
      providerLimits: { maxProviderTurns: 16, maxCompactions: 1 },
      cumulative: { maxInputTokens: 10_000, maxOutputTokens: 10_000, maxElapsedMs: 10_000 },
    }),
    identity: {
      inferenceAttempt: 1,
      retriesConsumed: 0,
      authorizationSha256: "1".repeat(64),
      repositoryRevision: "a".repeat(40),
      contextPacketSha256: "2".repeat(64),
      evidenceSha256: "3".repeat(64),
      toolPolicySha256: "4".repeat(64),
      contextAuthoritySha256: context.authoritySha256,
    },
    pricing: {
      status: "known",
      inputMicrousdPerMillionTokens: 100,
      outputMicrousdPerMillionTokens: 200,
      authoritySha256: "5".repeat(64),
    },
    context,
  });
  controller.complete();
  return controller.evidence({
    inferenceAttempt: 1,
    retriesConsumed: 0,
    repositoryRevision: "a".repeat(40),
    providerTurnLedgerSha256: "6".repeat(64),
    usageSha256: "7".repeat(64),
    toolsSha256: "8".repeat(64),
  });
}
