// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handleRunsCommand } from "../../src/cli/commands/runs.js";
import { deliverCliRunResult } from "../../src/cli/run/delivery.js";
import type { ExecutedCliRun } from "../../src/cli/run/execution.js";
import type { CliRunOutput } from "../../src/cli/run/request.js";
import type { DocsFabConfig } from "../../src/config/runtime-loader.js";
import { parseJsonEvidence } from "../../src/json-evidence.js";
import { decodeRunResultV1, type RunResultV1 } from "../../src/operator/run-result.js";
import type { RunLimitOverflowEvidenceV1 } from "../../src/operator/run-limit-overflow.js";
import type { RunRecord } from "../../src/records/contracts.js";
import type { RepositoryDiscoveryInventoryV1 } from "../../src/repository/inventory.js";
import { getWorkflow } from "../../src/workflow-registry/catalog.js";
import { validModelConfig } from "../helpers.js";

const DIGEST = "a".repeat(64);

export function attachSealedInventory(
  record: RunRecord,
  inventory: RepositoryDiscoveryInventoryV1,
): RunRecord {
  return {
    ...record,
    steps: [
      ...record.steps,
      {
        id: "audit-documentation",
        title: "Audit documentation",
        kind: "inference",
        skill: "audit-documentation",
        mode: "read-only",
        status: "succeeded",
        startedAt: record.createdAt,
        completedAt: record.createdAt,
        durationMs: 1,
        summary: "sealed inventory overflow fixture",
        repositoryBatchAuthority: {
          schemaVersion: 1,
          kind: "docsfab-repository-batch-replay-authority",
          repositoryIdentitySha256: DIGEST,
          repositoryRevision: record.repository.revision,
          inventory,
          targets: [],
          authoritySha256: DIGEST,
        },
      },
    ],
  };
}

export async function captureProductionLimitOverflow(input: {
  record: RunRecord;
  limitOverflowEvidence?: RunLimitOverflowEvidenceV1;
  roots: string[];
}): Promise<{
  runHuman: string;
  runJson: string;
  showHuman: string;
  showJson: string;
  envelope: RunResultV1;
}> {
  const root = await mkdtemp(join(tmpdir(), "docsfab-limit-overflow-cli-"));
  input.roots.push(root);
  const stateDirectory = join(root, "runs");
  await Promise.all([
    mkdir(stateDirectory, { recursive: true }),
    mkdir(join(root, "artifacts"), { recursive: true }),
  ]);
  await writeFile(
    join(stateDirectory, `${input.record.id}.json`),
    `${JSON.stringify(input.record, null, 2)}\n`,
    { mode: 0o600 },
  );
  const execution: ExecutedCliRun = {
    record: input.record,
    exitCode: 0,
    ...(input.limitOverflowEvidence ? { limitOverflowEvidence: input.limitOverflowEvidence } : {}),
  };
  const runHuman = await captureDelivery(stateDirectory, input.record, execution, false);
  const runJson = await captureDelivery(stateDirectory, input.record, execution, true);
  const showHuman = await captureShow(stateDirectory, input.record.id, false);
  const showJson = await captureShow(stateDirectory, input.record.id, true);
  return {
    runHuman,
    runJson,
    showHuman,
    showJson,
    envelope: decodeRunResultV1(parseJsonEvidence(showJson)),
  };
}

function stubConfig(stateDirectory: string): DocsFabConfig {
  return {
    projectRoot: "/tmp/does-not-matter",
    skillCrateDirectory: "/tmp/does-not-matter/skill-crate",
    qualityDirectory: "/tmp/does-not-matter/quality",
    qualityPackDirectory: "/tmp/does-not-matter/quality-pack",
    stateDirectory,
    retryPolicy: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0, retryableCategories: [] },
    model: validModelConfig,
  };
}

async function captureDelivery(
  stateDirectory: string,
  record: RunRecord,
  execution: ExecutedCliRun,
  json: boolean,
): Promise<string> {
  const logs: string[] = [];
  const output: CliRunOutput = {
    log: (message: string) => logs.push(message),
    error: () => undefined,
  };
  await deliverCliRunResult(
    {
      request: {
        workflow: "review-documentation",
        repositoryPath: record.repository.sourcePath,
        revision: "HEAD",
        allowWrite: false,
        releaseGate: false,
        verbose: false,
        json,
        showScan: false,
        quiet: false,
      },
      config: stubConfig(stateDirectory),
      options: { json },
      output,
    },
    {
      path: "/tmp/example-workspace",
      sourcePath: record.repository.sourcePath,
      requestedRevision: "HEAD",
      revision: record.repository.revision,
      dispose: async () => undefined,
    },
    { workflow: getWorkflow("review-documentation") },
    execution,
  );
  return logs.join("\n");
}

async function captureShow(stateDirectory: string, runId: string, json: boolean): Promise<string> {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (message?: unknown) => {
    logs.push(String(message ?? ""));
  };
  try {
    await handleRunsCommand([
      "show",
      runId,
      "--state-dir",
      stateDirectory,
      ...(json ? ["--json"] : []),
    ]);
  } finally {
    console.log = originalLog;
  }
  return logs.join("\n");
}
