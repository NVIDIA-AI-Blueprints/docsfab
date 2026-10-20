// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { handleRunsCommand } from "../src/cli/commands/runs.js";
import { inspectQualityReportFromRun } from "../src/evaluation-report/index.js";
import { parseJsonEvidence } from "../src/json-evidence.js";
import { decodeRunResultV1 } from "../src/operator/index.js";
import type { RunRecord } from "../src/records/contracts.js";
import { resolveSecurityScanEffectiveDisposition } from "../src/security/scan-disposition.js";
import { authorizeSecurityScan } from "../src/security/scan-override.js";
import {
  createWorkflowOutcome,
  interactiveWorkflowOutcomePolicy,
  workflowOutcomeExitCode,
  workflowOutcomeState,
  workflowOutcomeStepEvidence,
} from "../src/workflow-contracts/outcome.js";

const roots: string[] = [];
const SYNTHETIC_STEP_SUMMARY = "Synthetic verification requires a governed source.";

afterEach(async () => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("saved execution input-stop exit codes", () => {
  it.each([false, true])(
    "reports an admitted verification input stop as two (json=%s) without changing product policy or saved bytes",
    async (json) => {
      const record = verificationInputRecord();
      expect(workflowOutcomeState(record).state).toBe("current");
      expect(workflowOutcomeExitCode(record, interactiveWorkflowOutcomePolicy())).toBe(0);
      const saved = await saveRecord(record);
      const original = await readFile(saved.recordPath);

      const result = await inspectRecord(record, saved.stateDirectory, json);

      if (json) {
        expect(decodeRunResultV1(parseJsonEvidence(result.stdout)).execution).toMatchObject({
          status: "needs-input",
          exitCode: 2,
        });
      } else {
        expect(result.stdout).toContain("Exit code: 2");
      }
      // Invocation status is a separate existing CLI contract from the saved projection.
      expect(result.invocationExitCode).toBe(2);
      expect(await readFile(saved.recordPath)).toEqual(original);
    },
  );

  it.each([false, true])(
    "admits saved verification stops with their required host evidence decoders (json=%s)",
    async (json) => {
      const record = verificationInputRecord();
      record.securityScan = {
        ruleSet: "docsfab-v1",
        status: "passed",
        scannedFiles: 1,
        binaryFiles: 0,
        findings: [],
      };
      record.securityScanEffectiveDisposition = { status: "passed" };
      expect(() => workflowOutcomeState(record)).toThrow();
      expect(
        workflowOutcomeState(record, {
          authorizeSecurityScan,
          resolveSecurityScanEffectiveDisposition,
        }).state,
      ).toBe("current");
      const { stateDirectory } = await saveRecord(record);

      const result = await inspectRecord(record, stateDirectory, json);

      expectDisplayedCode(result.stdout, json, 2);
      expect(result.invocationExitCode).toBe(2);
    },
  );

  it.each([false, true])(
    "keeps successful execution with a needs-input product result at zero (json=%s)",
    async (json) => {
      const record = verificationInputRecord("succeeded");
      expect(workflowOutcomeState(record)).toMatchObject({
        state: "current",
        outcome: { disposition: "needs-input" },
      });
      const { stateDirectory } = await saveRecord(record);

      const result = await inspectRecord(record, stateDirectory, json);

      expectDisplayedCode(result.stdout, json, 0);
      expect(result.invocationExitCode).toBe(0);
    },
  );

  it.each(["legacy empty", "legacy verification", "ordinary success", "failed execution"])(
    "preserves the established code for %s",
    async (name) => {
      const record = verificationInputRecord();
      delete record.workflowOutcome;
      if (name === "legacy empty") record.steps = [];
      if (name === "ordinary success") {
        record.status = "succeeded";
        record.steps.forEach((step) => {
          step.status = "succeeded";
        });
      }
      if (name === "failed execution") record.status = "failed";
      const expected = name === "failed execution" ? 1 : 0;
      const { stateDirectory } = await saveRecord(record);

      for (const json of [false, true]) {
        const result = await inspectRecord(record, stateDirectory, json);
        expectDisplayedCode(result.stdout, json, expected);
        expect(result.invocationExitCode).toBe(expected);
      }
    },
  );

  it.each(["checkout", "quality"])(
    "keeps %s failure ahead of an admitted verification input stop",
    async (failure) => {
      const record = verificationInputRecord(
        "needs-input",
        failure === "quality" ? "review-documentation" : "create-documentation",
      );
      if (failure === "checkout") {
        record.checkoutPersistence = {
          schemaVersion: 1,
          kind: "checkout-persistence",
          outcome: "failed",
          errorCode: "patch-conflict",
        };
      } else {
        record.steps.push({
          id: "evaluate-document-quality",
          title: "Evaluate document quality",
          kind: "evaluate",
          skill: "evaluate-document-quality",
          mode: "read-only",
          status: "succeeded",
          summary: "Unadmitted synthetic quality report.",
        });
        expect(inspectQualityReportFromRun(record).error).toBeDefined();
      }
      expect(workflowOutcomeState(record).state).toBe("current");
      const { stateDirectory } = await saveRecord(record);

      for (const json of [false, true]) {
        const result = await inspectRecord(record, stateDirectory, json);
        expectDisplayedCode(result.stdout, json, 1);
        expect(result.invocationExitCode).toBe(1);
      }
    },
  );

  it.each(["tampered digest", "missing verification step", "missing terminal input evidence"])(
    "does not admit %s as an execution input stop",
    async (name) => {
      const record = verificationInputRecord();
      if (name === "tampered digest") {
        record.workflowOutcome = { ...record.workflowOutcome!, outcomeSha256: "0".repeat(64) };
      } else if (name === "missing verification step") {
        record.steps.pop();
      } else {
        record.steps.at(-1)!.status = "succeeded";
      }
      expect(() => workflowOutcomeState(record)).toThrow();
      const { stateDirectory } = await saveRecord(record);

      for (const json of [false, true]) {
        await expect(inspectRecord(record, stateDirectory, json)).rejects.toThrow();
        expect(process.exitCode ?? 0).toBe(0);
      }
    },
  );
});

/** Synthetic typed evidence for a post-planner stop, independent of any live QA payload. */
function verificationInputRecord(
  status: "needs-input" | "succeeded" = "needs-input",
  workflow: RunRecord["workflow"] = "create-documentation",
): RunRecord {
  const record: RunRecord = {
    schemaVersion: 2,
    id: `saved-verification-${status}`,
    workflow,
    repository: {
      sourcePath: "/synthetic/documentation-repository",
      requestedRevision: "HEAD",
      revision: "a".repeat(40),
    },
    workspace: { strategy: "tracked-export", disposable: true },
    status,
    createdAt: "2026-10-19T00:00:00.000Z",
    models: [],
    skills: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0 },
    tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
    steps: [
      {
        id: "plan-documentation",
        title: "Plan documentation",
        kind: "evaluate",
        skill: "plan-documentation",
        mode: "read-only",
        status: "succeeded",
      },
      {
        id: "verify-technical-accuracy",
        title: "Verify technical accuracy",
        kind: "evaluate",
        skill: "verify-technical-accuracy",
        mode: "read-only",
        status,
        summary: SYNTHETIC_STEP_SUMMARY,
      },
    ],
  };
  const evidence = workflowOutcomeStepEvidence(record, "verify-technical-accuracy");
  record.workflowOutcome = createWorkflowOutcome(
    {
      disposition: "needs-input",
      findings: [
        {
          id: "finding:verification-source-required",
          kind: "missing-governed-input",
          severity: "blocking",
          code: "verification-source-required",
          inputId: "input:verification-source",
          evidenceIds: [evidence.id],
        },
      ],
      evidence: [evidence],
      limitations: [],
      openDecisions: [
        {
          id: "decision:verification-source",
          kind: "governed-input",
          inputId: "input:verification-source",
          evidenceIds: [evidence.id],
        },
      ],
      producedArtifacts: [],
    },
    record,
  );
  return record;
}

async function saveRecord(record: RunRecord) {
  const stateDirectory = await mkdtemp(join(tmpdir(), "docsfab-saved-exit-code-"));
  roots.push(stateDirectory);
  const recordPath = join(stateDirectory, `${record.id}.json`);
  await writeFile(recordPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  return { stateDirectory, recordPath };
}

async function inspectRecord(record: RunRecord, stateDirectory: string, json: boolean) {
  const lines: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((message: unknown) => {
    lines.push(String(message));
  });
  process.exitCode = undefined;
  try {
    await handleRunsCommand([
      "show",
      record.id,
      "--state-dir",
      stateDirectory,
      ...(json ? ["--json"] : []),
    ]);
    return { stdout: lines.join("\n"), invocationExitCode: process.exitCode ?? 0 };
  } finally {
    log.mockRestore();
  }
}

function expectDisplayedCode(stdout: string, json: boolean, expected: number) {
  if (json) {
    expect(decodeRunResultV1(parseJsonEvidence(stdout)).execution.exitCode).toBe(expected);
  } else {
    expect(stdout).toContain(`Exit code: ${expected}`);
  }
}
