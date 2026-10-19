// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runRunsImport } from "../src/cli/commands/runs-index.js";
import { handleRunsCommand } from "../src/cli/commands/runs.js";
import { handleWhyCommand } from "../src/cli/commands/why.js";
import { markRunEditorialFinalizationRejection } from "../src/operator/failure-classification.js";
import { buildRunHumanNextCommand } from "../src/operator/run-summary.js";
import type { RunRecord } from "../src/records/contracts.js";
import { FileRunStore } from "../src/records/file-store.js";
import {
  EDITORIAL_FINALIZATION_REJECTION_CODES,
  editorialFinalizationRejection,
} from "../src/workflow-execution/editorial-finalization-rejection.js";

const modelContentCodes = [
  "editorial-finalization-host-conflicting-assessment",
  "editorial-finalization-decision-independent-rejection",
];
const uncoded = "editorial-finalization-uncoded-error";
const contractCodes = EDITORIAL_FINALIZATION_REJECTION_CODES.filter(
  (code) => !modelContentCodes.includes(code) && code !== uncoded,
);
const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function completedRun(id: string): RunRecord {
  return {
    schemaVersion: 2,
    id,
    workflow: "update-documentation",
    repository: {
      sourcePath: "/repository",
      requestedRevision: "HEAD",
      revision: "a".repeat(40),
    },
    workspace: { strategy: "tracked-export", disposable: true },
    status: "failed",
    createdAt: "2026-10-07T12:00:00.000Z",
    models: [],
    skills: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0 },
    tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
    steps: [
      { id: "plan-documentation", title: "Plan documentation", status: "succeeded" },
      { id: "verify-technical-accuracy", title: "Verify technical accuracy", status: "succeeded" },
      { id: "evaluate-document-quality", title: "Evaluate document quality", status: "succeeded" },
    ],
  } as RunRecord;
}

async function capture(action: () => Promise<unknown>): Promise<string> {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((message?: unknown) => {
    lines.push(String(message ?? ""));
  });
  try {
    await action();
  } finally {
    spy.mockRestore();
  }
  return lines.join("\n");
}

describe("editorial finalization public diagnosis", () => {
  it("agrees with NEXT for every closed refusal and preserves adjacent causes", async () => {
    expect(contractCodes).toHaveLength(19);
    const stateDirectory = await mkdtemp(join(tmpdir(), "docsfab-editorial-why-"));
    roots.push(stateDirectory);
    const store = new FileRunStore(stateDirectory);
    const cases: { id: string; code: string; expectedCause: string; expectedOwner: string }[] = [];
    for (const [index, code] of EDITORIAL_FINALIZATION_REJECTION_CODES.entries()) {
      const id = `editorial-finalization-${index}`;
      const record = completedRun(id);
      const [contract, contractCode] = code.startsWith("editorial-finalization-branch-coverage-")
        ? ["branch-coverage", code.slice("editorial-finalization-branch-coverage-".length)]
        : code.startsWith("editorial-finalization-host-")
          ? ["host", code.slice("editorial-finalization-host-".length)]
          : ["decision", code.slice("editorial-finalization-decision-".length)];
      const rejection =
        code === uncoded
          ? editorialFinalizationRejection("host", "outside-closed-contract")
          : editorialFinalizationRejection(
              contract as "branch-coverage" | "host" | "decision",
              contractCode,
              "$.evidenceRefs[].producers[].assessment",
            );
      expect(rejection.code).toBe(code);
      expect(markRunEditorialFinalizationRejection(record, rejection)).toBe(true);
      await store.save(record);
      cases.push({
        id,
        code,
        expectedCause: contractCodes.includes(code)
          ? "host-built-value-refused"
          : code === uncoded
            ? "uncatalogued-failure"
            : "reply-content-rejected",
        expectedOwner:
          contractCodes.includes(code) || code === uncoded ? "docsfab-defect" : "model-content",
      });
      const next = buildRunHumanNextCommand({
        record,
        stateDirArg: ` --state-dir ${stateDirectory}`,
      });
      expect(next?.reason).toContain(code);
      expect(next?.reason).toContain(rejection.location);
      expect(next?.reason).toContain("do not retry unchanged inference");
      if (contractCodes.includes(code)) expect(next?.reason).toContain("DocsFab defect");
    }
    const adjacent = [
      [
        "unrelated-contract-shape",
        "contract-shape",
        "task-lineage-incompatible",
        "reply-shape-rejected",
      ],
      [
        "uncatalogued-editorial-prefix",
        "contract-shape",
        "editorial-finalization-host-future-contract",
        "reply-shape-rejected",
      ],
      [
        "unrelated-model-content",
        "model-content",
        "task-lineage-incompatible",
        "reply-content-rejected",
      ],
      ["unrelated-unknown", "unknown", "task-lineage-incompatible", "uncatalogued-failure"],
    ] as const;
    for (const [id, failureClass, code] of adjacent) {
      const record = completedRun(id);
      record.failure = { class: failureClass, layer: "workflow", code };
      await store.save(record);
    }
    const importedIndexDirectory = join(stateDirectory, "imported-index");
    const imported = await runRunsImport({
      command: "import",
      help: false,
      json: true,
      indexDirectory: importedIndexDirectory,
      paths: [stateDirectory],
      docsfabRevision: null,
    });
    expect(imported.imported).toHaveLength(cases.length + adjacent.length);
    for (const { id, code, expectedCause, expectedOwner } of cases) {
      for (const source of ["--index-dir", "--state-dir"] as const) {
        const path = source === "--index-dir" ? importedIndexDirectory : stateDirectory;
        const report = JSON.parse(
          await capture(() => handleWhyCommand([id, source, path, "--json"])),
        );
        const finding = report.diagnoses[0].findings[0];
        expect(report.diagnoses[0].runStatus).toBe("failed");
        expect(finding).toMatchObject({ cause: expectedCause, ownerClass: expectedOwner });
        expect(finding.evidence).toMatchObject({ rowKind: "run", failureLayer: "workflow" });
        expect(finding.signature.failureCode).toBe(code);
        expect(finding.why).toContain(code);
        if (contractCodes.includes(code)) {
          expect(finding.nextAction).toContain("Report this DocsFab defect");
          expect(finding.nextCommand).toContain(`docsfab why ${id}`);
          expect(finding.nextCommand).toContain("--json");
          expect(`${finding.why} ${finding.nextAction}`).not.toMatch(
            /endpoint|structured output|profile inspect|use a model|rerun unchanged/iu,
          );
          expect(finding.why).not.toContain("$.evidenceRefs");
        }
      }
      const whyText = await capture(() => handleWhyCommand([id, "--state-dir", stateDirectory]));
      expect(whyText).toContain(expectedCause);
      const shown = await capture(() =>
        handleRunsCommand(["show", id, "--state-dir", stateDirectory]),
      );
      expect(shown).toContain("DIAGNOSIS");
      expect(shown).toContain(expectedCause);
      expect(shown).toContain(code);
      expect(shown).toContain(
        code === uncoded ? "at $." : "$.evidenceRefs[].producers[].assessment",
      );
    }
    for (const [id, , code, cause] of adjacent) {
      const generic = JSON.parse(
        await capture(() =>
          handleWhyCommand([id, "--index-dir", importedIndexDirectory, "--json"]),
        ),
      );
      expect(generic.diagnoses[0].findings[0].cause).toBe(cause);
      expect(generic.diagnoses[0].findings[0].why).toContain(code);
    }
  });

  it("keeps an editorial-looking failed step with no attempts on the generic path", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "docsfab-editorial-step-"));
    roots.push(stateDirectory);
    const record = completedRun("editorial-step-guard");
    record.steps = [
      {
        id: "evaluate-document-quality",
        title: "Evaluate document quality",
        status: "failed",
        failure: {
          class: "contract-shape",
          layer: "workflow",
          code: "editorial-finalization-decision-identity-mismatch",
        },
        inference: { attempts: [] },
      },
    ] as RunRecord["steps"];
    await new FileRunStore(stateDirectory).save(record);
    const importedIndexDirectory = join(stateDirectory, "imported-index");
    const imported = await runRunsImport({
      command: "import",
      help: false,
      json: true,
      indexDirectory: importedIndexDirectory,
      paths: [stateDirectory],
      docsfabRevision: null,
    });
    expect(imported.imported).toHaveLength(1);
    const report = JSON.parse(
      await capture(() =>
        handleWhyCommand([record.id, "--index-dir", importedIndexDirectory, "--json"]),
      ),
    );
    expect(report.diagnoses[0].findings[0]).toMatchObject({
      cause: "reply-shape-rejected",
      evidence: {
        rowKind: "step",
        failureClass: "contract-shape",
        failureLayer: "workflow",
      },
    });
    expect(report.diagnoses[0].findings[0].why).toContain(
      "editorial-finalization-decision-identity-mismatch",
    );
  });
});
