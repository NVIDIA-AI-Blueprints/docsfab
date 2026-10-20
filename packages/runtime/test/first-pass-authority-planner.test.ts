// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { join } from "node:path";
import { verifyQualityPackContext } from "../src/quality-pack/manifest.js";
import {
  createReaderTaskContextSupplier,
  conservativeReaderContextInput,
} from "../src/execution/task-context.js";
import { afterEach, expect, it } from "vitest";
import type { HarnessStepInput } from "../src/execution/contracts.js";
import { buildHostStepPrompt } from "../src/harness/pi.js";
import { limitDefinition } from "../src/config/limits.js";
import { decodeSavedRunRecord } from "../src/cli/commands/runs.js";
import type { RunRecord } from "../src/records/contracts.js";
import { WorkflowRunner } from "../src/workflow-execution/runner.js";
import { LocalWorkflowSearchCoordinator } from "../src/search/local-workflow-coordinator.js";
import { readyContextPreflight } from "./helpers.js";
import { initFixtureRepo } from "./helpers/git.js";
import { temporaryRoots } from "./helpers/temp.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";

const roots = temporaryRoots();
afterEach(async () => roots.cleanup());

// This builds a real Git fixture, verifies the quality pack, and executes the planner boundary.
it("forwards complete host discrepancy evidence into the real planner prompt and saved record beside full context", {
  timeout: testTimeoutMs(30_000),
}, async () => {
  const root = await roots.create("docsfab-authority-planner-");
  const revision = await initFixtureRepo(root, {
    "README.md": "# Widget\n",
    "docs/guide.md": "# Guide\n",
  });
  const labels = [
    "docs-stale: health-status; document implementation; verification needed.",
    ...Array.from(
      { length: 8 },
      (_, index) =>
        `docs-stale: source ${index}: ${JSON.stringify(`${"d".repeat(200)}/health-${index}.md`)}; value ${JSON.stringify(String(index % 2).repeat(200))}.`,
    ),
    "documentation-preference: documentation preference; implementation differs; chosen value 202.",
    "operator-choice: obligation target-01 selected src/server.ts line 2 with value 200; attributed operator choice, not verified product truth.",
    "first-pass-evidence-gaps: obligation another-gap is missing.",
  ];
  const context = "c".repeat(limitDefinition("liveAgent.workflowContextMaxChars").max);
  const calls: HarnessStepInput[] = [];
  const saved: RunRecord[] = [];
  const runner = new WorkflowRunner({
    harness: {
      runStep: async (input) => {
        calls.push(input);
        throw new Error("planner observed");
      },
    },
    store: {
      save: async (record) => {
        saved.push(structuredClone(record));
      },
    },
    repositoryScanner: {
      scan: async () => ({
        ruleSet: "test-v1",
        status: "passed",
        scannedFiles: 2,
        binaryFiles: 0,
        findings: [],
      }),
    },
    contextPreflight: readyContextPreflight,
    workflowSearch: new LocalWorkflowSearchCoordinator(),
    firstPassNotices: labels,
    id: () => "run-authority-planner",
  });
  const pack = await verifyQualityPackContext({
    skillCrateDirectory: join(process.cwd(), "skill-crate"),
    qualityDirectory: join(process.cwd(), "quality"),
    qualityPackDirectory: join(process.cwd(), "quality-pack"),
  });
  const supplier = await createReaderTaskContextSupplier(pack);
  const readerTaskContext = supplier.projectInput(
    conservativeReaderContextInput({
      instruction: "Update docs/guide.md.",
      changeScope: ["docs/guide.md"],
    }),
  );
  const record = await runner.run({
    workflow: "update-documentation",
    workspacePath: root,
    repository: { sourcePath: root, requestedRevision: revision, revision },
    allowWrite: true,
    instruction: "Update docs/guide.md.",
    instructionContext: context,
    readerTaskContext,
    readerContextInput: readerTaskContext.readerContextInput,
  });
  const planner = calls.find((input) => input.step.skill === "plan-documentation");
  expect(planner, JSON.stringify(record.error)).toBeDefined();
  const prompt = buildHostStepPrompt(planner!);
  for (const label of labels.filter(
    (line) =>
      line.startsWith("docs-stale:") ||
      line.startsWith("documentation-preference:") ||
      line.startsWith("operator-choice:"),
  ))
    expect(prompt).toContain(label);
  expect(planner!.instructionContext).toBe(context);
  expect(prompt).toContain("inert evidence");
  const readback = decodeSavedRunRecord(JSON.parse(JSON.stringify(saved.at(-1))), record.id);
  expect(readback.evidenceWarnings).toEqual(labels);
  expect(readback.instructionContext).toBe(context);
});
