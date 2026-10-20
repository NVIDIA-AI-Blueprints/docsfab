// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { sourceObligationObserverFixture, verificationFixture } from "./helpers/verification.js";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { testTimeoutMs } from "./helpers/test-timeouts.js";

import type { AgentHarness, HarnessStepInput } from "../src/execution/contracts.js";
import type { RunRecord, RunStore } from "../src/records/contracts.js";
import type { WorkflowName } from "../src/workflow-contracts/contracts.js";
import { evaluateRuns, loadEvaluationFixture } from "../src/quality-evaluation/structural.js";
import { LocalRepositorySecurityScanner } from "../src/security/repository-scanner.js";
import { CatalogSkillCrateResolver } from "../src/skills/catalog-crate-resolver.js";
import { WorkflowRunner } from "../src/workflow-execution/runner.js";
import { readyContextPreflight } from "./helpers.js";
import { documentationPlanBindingDigest } from "../src/workflow-execution/plan-binding.js";
import { LocalWorkflowSearchCoordinator } from "../src/search/local-workflow-coordinator.js";
import { scriptedEditorialProtocol } from "./helpers/editorial-protocol.js";
import { AuthoringQualityWorkflowOutcomeProjector } from "../src/evaluation-report/authoring-outcome-projector.js";
import type { WorkflowOutcomeDecodeOptionsV1 } from "../src/workflow-contracts/outcome.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skillCrateDirectory = resolve(projectRoot, "skill-crate");
const repositories = resolve(projectRoot, "test", "fixtures", "runtime-evaluation", "repositories");
const fixtures = resolve(projectRoot, "test", "fixtures", "runtime-evaluation", "fixtures");
const FIXTURE_REVISION = "f".repeat(40);
const UPDATE_PAGE_PATH = "docs/guide.md";

const workflowSearchFixture = {
  async search(input: Parameters<LocalWorkflowSearchCoordinator["search"]>[0]) {
    const repositoryPath = await mkdtemp(join(tmpdir(), "docsfab-governed-skill-search-"));
    try {
      await mkdir(repositoryPath, { recursive: true });
      await writeFile(join(repositoryPath, "README.md"), "deterministic search evidence\n");
      return await new LocalWorkflowSearchCoordinator().search({ ...input, repositoryPath });
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  },
};
const governedSourceObserverFixture = {
  ...sourceObligationObserverFixture,
  captureOriginalSourceAuthority: (
    input: Parameters<typeof sourceObligationObserverFixture.captureOriginalSourceAuthority>[0],
  ) =>
    sourceObligationObserverFixture.captureOriginalSourceAuthority({
      ...input,
      ...(input.workflow.name === "update-documentation"
        ? { authorizedPaths: [UPDATE_PAGE_PATH] }
        : {}),
    }),
};
const fixtureDecodeOptions = new Map<string, WorkflowOutcomeDecodeOptionsV1>();

class MemoryStore implements RunStore {
  public records: RunRecord[] = [];

  public async save(record: RunRecord): Promise<void> {
    this.records.push(structuredClone(record));
  }
}

class GovernedFixtureHarness implements AgentHarness {
  public async inspectSkill(input: HarnessStepInput) {
    return new CatalogSkillCrateResolver(skillCrateDirectory).resolveSkill(input);
  }

  public async runStep(input: HarnessStepInput) {
    if (input.repositoryPath.endsWith("controlled-failure")) {
      throw new Error("Controlled fixture model failure.");
    }
    const skill = await this.inspectSkill(input);
    const findings = input.repositoryPath.endsWith("findings");
    const summary = findings
      ? "Expected findings: README.md names missing npm script publish-docs, links to missing docs/operator-guide.md, and no AGENTS.md is present."
      : `Fixture completed ${input.step.skill} with tracked file evidence.`;
    const toolName = input.step.mode === "write" ? "edit" : "read";
    return {
      summary,
      ...(await verificationFixture(input)),
      ...(input.step.id === "plan-documentation"
        ? {
            planBinding: documentationPlanBinding(
              input.workflow.name === "create-documentation" ? "create" : "update",
            ),
          }
        : {}),
      model: { provider: "fixture", model: "deterministic" },
      skill,
      usage: {
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        total: 15,
        turns: 1,
      },
      tools: {
        totalCalls: 1,
        failedCalls: 0,
        byTool: [{ name: toolName, calls: 1, failures: 0 }],
      },
    };
  }
}

function documentationPlanBinding(mode: "create" | "update") {
  const pages = [{ path: "docs/guide.md", disposition: mode }];
  const sourceBindings = [{ pagePath: "docs/guide.md", sources: ["docs/guide.md"] }];
  return {
    kind: "docsfab-documentation-plan" as const,
    schemaVersion: 1 as const,
    mode,
    pages,
    sourceBindings,
    digest: documentationPlanBindingDigest({ mode, pages, sourceBindings }),
  };
}

afterEach(async () => {
  fixtureDecodeOptions.clear();
});

async function fixtureRecords(
  workflow: WorkflowName,
  repository: string,
  count: number,
  allowWrite = false,
): Promise<RunRecord[]> {
  const records: RunRecord[] = [];
  for (let index = 0; index < count; index += 1) {
    const fixtureHarness = new GovernedFixtureHarness();
    const protocol =
      workflow === "update-documentation"
        ? scriptedEditorialProtocol(fixtureHarness)
        : { harness: fixtureHarness };
    const runner = new WorkflowRunner({
      ...protocol,
      hostOperations: new GovernedFixtureHarness(),
      store: new MemoryStore(),
      repositoryScanner: new LocalRepositorySecurityScanner(),
      contextPreflight: readyContextPreflight,
      workflowSearch: workflowSearchFixture,
      sourceObligationObserver: governedSourceObserverFixture,
      repositoryEvidence: {
        // A write-mode fixture must report a changed file: an empty change set
        // with a 0-byte patch is rejected as `emptyWriteResultError`.
        capture: async (context) => ({
          files: allowWrite ? [{ path: "docs/guide.md", status: "modified" as const }] : [],
          ...(context.persistPatch
            ? {
                patch: {
                  sha256: "f".repeat(64),
                  byteLength: allowWrite ? 128 : 0,
                  lineCount: allowWrite ? 6 : 0,
                  artifactPath: "/tmp/docsfab-fixture.patch",
                  format: "git-diff" as const,
                },
              }
            : {}),
        }),
      },
      ...(workflow === "update-documentation"
        ? { outcomeProjector: new AuthoringQualityWorkflowOutcomeProjector() }
        : {}),
      id: () => `${workflow}-${index + 1}`,
      now: () => new Date("2026-08-03T12:00:00.000Z"),
    });
    const record = await runner.run({
      workflow,
      workspacePath: resolve(repositories, repository),
      repository: {
        sourcePath: `/fixtures/${repository}`,
        requestedRevision: "HEAD",
        revision: FIXTURE_REVISION,
      },
      allowWrite,
    });
    records.push(record);
    if ("decodeOptions" in protocol) fixtureDecodeOptions.set(record.id, protocol.decodeOptions);
  }
  return records;
}

describe("governed workflow fixtures", () => {
  it.each([
    ["review-documentation", "findings", "governed-audit-findings.json", false],
    ["update-documentation", "polish", "governed-polish.json", true],
  ] as const)(
    "runs repeatable %s evidence through the harness contract",
    async (workflow, repository, fixtureName, allowWrite) => {
      const records = await fixtureRecords(workflow, repository, 2, allowWrite);
      const fixture = await loadEvaluationFixture(resolve(fixtures, fixtureName));
      const result = await evaluateRuns({
        fixture,
        records,
        workflowOutcomeDecodeOptions: (record) => fixtureDecodeOptions.get(record.id),
      } as Parameters<typeof evaluateRuns>[0] & {
        workflowOutcomeDecodeOptions: (
          record: RunRecord,
        ) => WorkflowOutcomeDecodeOptionsV1 | undefined;
      });

      expect(result.passed).toBe(true);
      expect(records.every((record) => record.skills.length > 0)).toBe(true);
      if (workflow === "review-documentation") {
        expect(records[0]?.steps[0]?.summary).toContain("publish-docs");
      }
    },
    testTimeoutMs(30_000),
  );

  it("records governed provenance on a controlled model failure", async () => {
    const records = await fixtureRecords("review-documentation", "controlled-failure", 1);
    const fixture = await loadEvaluationFixture(
      resolve(fixtures, "governed-controlled-failure.json"),
    );
    const result = await evaluateRuns({ fixture, records });

    expect(result.passed).toBe(true);
    expect(records[0]?.status).toBe("failed");
    expect(records[0]?.skills[0]?.source?.repository).toBe(
      "https://github.com/NVIDIA-AI-Blueprints/docsfab.git",
    );
    expect(records[0]?.steps[0]?.error).toBe("Controlled fixture model failure.");
  });
});
