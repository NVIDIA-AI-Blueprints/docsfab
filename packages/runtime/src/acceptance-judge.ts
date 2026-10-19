#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";

import {
  acceptanceJsonLeafForPath,
  pinAcceptanceEvidenceDirectory,
  readAcceptanceJsonLeaves,
  writeAcceptanceJsonExclusive,
} from "./acceptance-evidence.js";
import { loadConfig } from "./config/runtime-loader.js";
import { reportOperatorFailure, wantsJsonFailureOutput } from "./operator/error-envelope.js";
import type { RunRecord } from "./records/contracts.js";
import { ConfiguredEvaluationJudge } from "./quality-evaluation/semantic.js";
import {
  evaluateRuns,
  isAcceptedEvaluationWorkflow,
  loadEvaluationFixture,
} from "./quality-evaluation/structural.js";
import { authorizeSecurityScan } from "./security/scan-override.js";
import { resolveSecurityScanEffectiveDisposition } from "./security/scan-disposition.js";

const SECURITY_SCAN_POLICY = {
  authorizeSecurityScan,
  resolveSecurityScanEffectiveDisposition,
} as const;

function option(args: string[], name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const stateDirectory = resolve(option(args, "--state-dir"));
  const resultPath = resolve(option(args, "--result"));
  const acceptanceId = option(args, "--acceptance-id");
  const testedCommit = option(args, "--commit");
  const profileStatus = option(args, "--profile-status");
  const state = await pinAcceptanceEvidenceDirectory(stateDirectory);
  const recordLeaves = await readAcceptanceJsonLeaves(state);
  if (recordLeaves.length !== 2) {
    throw new Error("Judge acceptance requires exactly two live readiness records.");
  }
  const resultDirectory = await pinAcceptanceEvidenceDirectory(dirname(resultPath));
  const resultFile = acceptanceJsonLeafForPath(resultDirectory, resultPath);
  const config = loadConfig();
  if (!config.judge) throw new Error("Judge acceptance requires JUDGE_ENABLED=true.");
  const fixture = await loadEvaluationFixture(
    resolve("test/fixtures/runtime-evaluation/fixtures/mvp-live-readiness.json"),
  );
  const records = recordLeaves.map((leaf) => parseRunRecord(leaf.value));
  if (!records.some((record) => record.repository.revision === testedCommit)) {
    throw new Error("Judge acceptance records are not bound to the tested commit.");
  }
  const inputRecords = recordLeaves.map((leaf, index) => ({
    id: records[index]!.id,
    sha256: createHash("sha256").update(leaf.bytes).digest("hex"),
  }));
  const result = await evaluateRuns({
    fixture,
    records,
    judge: new ConfiguredEvaluationJudge(config.judge),
    workflowOutcomeDecodeOptions: () => SECURITY_SCAN_POLICY,
  });
  const judge = result.judge;
  await writeAcceptanceJsonExclusive(resultDirectory, resultFile, {
    schemaVersion: 1,
    acceptanceId,
    testedCommit,
    judgeProfileStatus: profileStatus,
    inputRecords,
    fixture: { name: fixture.name, version: fixture.version },
    structural: {
      passed: result.structural.passed,
      recordCount: result.structural.recordCount,
    },
    judge: judge
      ? {
          status: judge.status,
          rubric: judge.rubric,
          ...(judge.model ? { model: judge.model } : {}),
          ...(judge.status === "passed" || judge.status === "disagreed"
            ? { score: judge.score }
            : {}),
        }
      : undefined,
  });
  if (!result.structural.passed || judge?.status === "error" || !judge) {
    process.exitCode = 1;
  }
}

function parseRunRecord(value: unknown): RunRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Judge acceptance found an invalid run record.");
  }
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== 2 ||
    typeof record.id !== "string" ||
    !isAcceptedEvaluationWorkflow(record.workflow) ||
    !record.repository ||
    typeof record.repository !== "object" ||
    Array.isArray(record.repository) ||
    !Array.isArray(record.steps)
  ) {
    throw new Error("Judge acceptance found an invalid run record.");
  }
  return record as unknown as RunRecord;
}

main().catch((error: unknown) => {
  reportOperatorFailure(error, { json: wantsJsonFailureOutput() });
  process.exitCode = 1;
});
