// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { limit } from "../src/config/limits.js";
import { execFile } from "node:child_process";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import { executeWorkflowApplication } from "../src/application/index.js";
import { executeRunRequest } from "../src/cli/run-request.js";
import { withLocalWorkflowRun } from "../src/cli/run/local-workflow.js";
import { parseModelEndpoint } from "../src/model/configuration.js";
import { createModelEvidence } from "../src/model/profile-evidence.js";
import { formatRunSummary } from "../src/operator/run-summary.js";
import type { AgentHarness, HarnessStepInput, RunRequest } from "../src/execution/contracts.js";
import { runBoundedWorkflow } from "../src/live-agent/host.js";
import type { RunRecord, RunStore } from "../src/records/contracts.js";
import type { RepositorySecurityScanner } from "../src/security/contracts.js";
import { createFixtureRepository, runtimeConfig } from "./support/execution-convergence.js";
import { readyContextPreflight, validModelEnvironment } from "./helpers.js";
import { verificationFixture } from "./helpers/verification.js";
import { documentationPlanBindingDigest } from "../src/workflow-execution/plan-binding.js";
import {
  listPreservationSources,
  readPreservationSourceRange,
} from "../src/workflow-execution/source-obligation-observer.js";
import { temporaryRoots } from "./helpers/temp.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";

const roots = temporaryRoots();
const exec = promisify(execFile);
const applicationExecutionTimeoutMs = testTimeoutMs(
  limit("test.applicationExecutionTimeoutMs").value,
);

afterEach(async () => {
  process.exitCode = undefined;
  vi.unstubAllEnvs();
});

class MemoryStore implements RunStore {
  readonly records: RunRecord[] = [];

  async save(record: RunRecord): Promise<void> {
    this.records.push(structuredClone(record));
  }
}

class ReadinessHarness implements AgentHarness {
  readonly inputs: HarnessStepInput[] = [];

  async inspectSkill(input: HarnessStepInput) {
    return { id: input.step.skill, contentSha256: "a".repeat(64) };
  }

  async runStep(input: HarnessStepInput) {
    this.inputs.push(input);
    return {
      summary: "The fixture has bounded documentation evidence.",
      ...(await verificationFixture(input)),
      model: { provider: "fixture", model: "fixture-model" },
      skill: { id: input.step.skill, contentSha256: "a".repeat(64) },
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
        turns: 0,
      },
      tools: {
        totalCalls: 0,
        failedCalls: 0,
        byTool: [],
        failureCategories: [],
      },
    };
  }
}

const passingScanner: RepositorySecurityScanner = {
  scan: async () => ({
    ruleSet: "application-execution-fixture-v1",
    status: "passed",
    scannedFiles: 1,
    binaryFiles: 0,
    findings: [],
  }),
};

class RestructureHarness implements AgentHarness {
  readonly inputs: HarnessStepInput[] = [];

  async inspectSkill(input: HarnessStepInput) {
    return { id: input.step.skill, contentSha256: "a".repeat(64) };
  }

  async runStep(input: HarnessStepInput) {
    this.inputs.push(input);
    if (input.step.id === "write-documentation") {
      await writeFile(
        join(input.repositoryPath, "docs", "guide.md"),
        "# Restructured fixture guide\n\nRun `fixture --version` for the version.\n",
      );
    }
    const mode = "restructure" as const;
    const pages = [{ path: "docs/guide.md", disposition: mode }];
    const sourceBindings = [{ pagePath: "docs/guide.md", sources: ["docs/guide.md"] }];
    return {
      summary: `Completed ${input.step.id}.`,
      ...(input.step.id === "plan-documentation"
        ? {
            planBinding: {
              kind: "docsfab-documentation-plan" as const,
              schemaVersion: 1 as const,
              mode,
              pages,
              sourceBindings,
              digest: documentationPlanBindingDigest({
                mode,
                pages,
                sourceBindings,
              }),
            },
          }
        : {}),
      ...(await verificationFixture(input)),
      model: { provider: "fixture", model: "fixture-model" },
      skill: { id: input.step.skill, contentSha256: "a".repeat(64) },
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
        turns: 0,
      },
      tools: {
        totalCalls: 0,
        failedCalls: 0,
        byTool: [],
        failureCategories: [],
      },
    };
  }
}

class PreservationRestructureHarness extends RestructureHarness {
  readonly originalReads: string[] = [];

  override async runStep(input: HarnessStepInput) {
    if (
      input.step.id === "verify-technical-accuracy" ||
      input.step.id === "test-audience-understanding"
    ) {
      const reader = input.preservationSourceReader;
      expect(reader).toBeDefined();
      const reference = listPreservationSources(reader!).find(
        (source) => source.path === "docs/guide.md",
      );
      expect(reference).toBeDefined();
      const observed = await readPreservationSourceRange({
        reader: reader!,
        sourceId: reference!.sourceId,
        fromByte: 0,
        maxBytes: reference!.byteLength,
      });
      this.originalReads.push(observed.text);
    }
    return super.runStep(input);
  }
}

async function configureWriteFixture(repository: string): Promise<string> {
  await writeFile(
    join(repository, ".docsfab.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        gitlab: { remote: "origin", defaultBranch: "main" },
        provider: { configuration: "host" },
        storage: { scope: "user-private" },
      },
      null,
      2,
    )}\n`,
  );
  await exec("git", ["add", ".docsfab.json"], { cwd: repository });
  await exec("git", ["-c", "commit.gpgsign=false", "commit", "-qm", "configure fixture"], {
    cwd: repository,
  });
  return (await exec("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout.trim();
}

describe("shared workflow application", () => {
  it("keeps the application service free of CLI, live-agent, renderer, and process effects", async () => {
    const sources = await Promise.all(
      ["contracts.ts", "dependencies.ts", "execute-workflow.ts", "index.ts"].map((name) =>
        readFile(new URL(`../src/application/${name}`, import.meta.url), "utf8"),
      ),
    );
    const combined = sources.join("\n");
    expect(combined).not.toMatch(/(?:console\.|process\.|\/cli\/|\/live-agent\/|renderer)/u);
    const localExecutionPath = await Promise.all(
      ["../src/cli/run/local-workflow.ts", "../src/cli/run/execution.ts"].map((path) =>
        readFile(new URL(path, import.meta.url), "utf8"),
      ),
    );
    expect(localExecutionPath.join("\n")).not.toMatch(
      /(?:console\.|process\.(?:exitCode|stdout|stderr)|createPrintProgressHandler|from\s+["']\.\/delivery\.js["'])/u,
    );
  });

  it("returns the canonical runner record for the existing admitted request", async () => {
    const fixture = await createFixtureRepository("documented");
    roots.track(fixture.root);
    const store = new MemoryStore();
    const harness = new ReadinessHarness();
    const request: RunRequest = {
      runId: "application-execution-fixture",
      workflow: "readiness",
      workspacePath: fixture.repository,
      repository: {
        sourcePath: fixture.repository,
        requestedRevision: fixture.revision,
        revision: fixture.revision,
      },
      allowWrite: false,
    };

    const record = await executeWorkflowApplication({
      request,
      services: {
        harness,
        store,
        repositoryScanner: passingScanner,
        contextPreflight: readyContextPreflight,
      },
    });

    expect(record).toStrictEqual(store.records.at(-1));
    expect(record.error).toBeUndefined();
    expect(record).toMatchObject({
      id: request.runId,
      workflow: request.workflow,
      status: "succeeded",
      repository: { revision: fixture.revision },
    });
    expect(harness.inputs).toHaveLength(1);
    expect(harness.inputs[0]).not.toHaveProperty("sourceBinding");
    expect(harness.inputs[0]).not.toHaveProperty("sourceReader");
  });

  it("routes CLI and live-agent callers through the same real local admission", async () => {
    const cliFixture = await createFixtureRepository("documented");
    const liveFixture = await createFixtureRepository("documented");
    roots.track(cliFixture.root);
    roots.track(liveFixture.root);
    const cliHarness = new ReadinessHarness();
    const liveHarness = new ReadinessHarness();
    const skillResolver = {
      resolveSkill: async (input: HarnessStepInput) => ({
        id: input.step.skill,
        contentSha256: "a".repeat(64),
      }),
    };
    const cliRecord = await executeRunRequest(
      {
        workflow: "review-documentation",
        instruction: "Review the committed fixture documentation.",
        repositoryPath: cliFixture.repository,
        revision: "HEAD",
        allowWrite: false,
        releaseGate: false,
        verbose: false,
        json: false,
        showScan: false,
      },
      runtimeConfig(cliFixture.stateDirectory),
      { silent: true, executionHarness: cliHarness, skillResolver },
    );
    process.exitCode = 23;
    const liveRecord = await runBoundedWorkflow({
      workflow: "review-documentation",
      instruction: "Assess this fixture.",
      repositoryPath: liveFixture.repository,
      allowWrite: false,
      config: runtimeConfig(liveFixture.stateDirectory),
      executionHarness: liveHarness,
      skillResolver,
    });

    expect(cliRecord).toMatchObject({
      workflow: "review-documentation",
      status: "failed",
      repository: { revision: cliFixture.revision },
    });
    expect(liveRecord).toMatchObject({
      workflow: "review-documentation",
      status: "failed",
      repository: { revision: liveFixture.revision },
    });
    expect(cliHarness.inputs.length).toBeGreaterThan(1);
    expect(liveHarness.inputs.length).toBeGreaterThan(1);
    expect(process.exitCode).toBe(23);
  }, 60_000);

  it(
    "retains successful bounded write evidence from both callers after workspace disposal",
    async () => {
      const cliFixture = await createFixtureRepository("documented");
      const liveFixture = await createFixtureRepository("documented");
      roots.track(cliFixture.root);
      roots.track(liveFixture.root);
      const cliRevision = await configureWriteFixture(cliFixture.repository);
      const liveRevision = await configureWriteFixture(liveFixture.repository);
      const cliHarness = new RestructureHarness();
      const liveHarness = new RestructureHarness();
      const skillResolver = {
        resolveSkill: async (input: HarnessStepInput) => ({
          id: input.step.skill,
          contentSha256: "a".repeat(64),
        }),
      };

      const cliRecord = await executeRunRequest(
        {
          runId: "shared-write-cli",
          workflow: "restructure-documentation",
          instruction: "Restructure docs/guide.md without changing its behavior.",
          repositoryPath: cliFixture.repository,
          revision: "HEAD",
          allowWrite: true,
          releaseGate: false,
          verbose: false,
          json: false,
          showScan: false,
        },
        runtimeConfig(cliFixture.stateDirectory),
        { silent: true, executionHarness: cliHarness, skillResolver },
      );
      const liveRecord = await runBoundedWorkflow({
        workflow: "restructure-documentation",
        instruction: "Restructure docs/guide.md without changing its behavior.",
        repositoryPath: liveFixture.repository,
        allowWrite: true,
        config: runtimeConfig(liveFixture.stateDirectory),
        executionHarness: liveHarness,
        skillResolver,
      });

      for (const [record, fixture, revision] of [
        [cliRecord, cliFixture, cliRevision],
        [liveRecord, liveFixture, liveRevision],
      ] as const) {
        expect(record).toMatchObject({
          workflow: "restructure-documentation",
          status: "succeeded",
          repository: { revision },
          changes: {
            files: expect.arrayContaining([
              expect.objectContaining({
                path: "docs/guide.md",
                status: "modified",
              }),
            ]),
            patch: expect.objectContaining({ artifactPath: expect.any(String) }),
          },
        });
        const saved = JSON.parse(
          await readFile(join(fixture.stateDirectory, `${record!.id}.json`), "utf8"),
        ) as RunRecord;
        expect(saved).toStrictEqual(record);
        expect(await readFile(record!.changes!.patch!.artifactPath, "utf8")).toContain(
          "Restructured fixture guide",
        );
        expect(await readFile(join(fixture.repository, "docs", "guide.md"), "utf8")).not.toContain(
          "Restructured fixture guide",
        );
      }
      expect(cliHarness.inputs.some((input) => input.step.mode === "write")).toBe(true);
      expect(liveHarness.inputs.some((input) => input.step.mode === "write")).toBe(true);
    },
    applicationExecutionTimeoutMs,
  );

  it(
    "passes the opted-in preservation policy and exact original source through the CLI",
    async () => {
      const fixture = await createFixtureRepository("documented");
      roots.track(fixture.root);
      await configureWriteFixture(fixture.repository);
      const original = await readFile(join(fixture.repository, "docs", "guide.md"), "utf8");
      vi.stubEnv("DOCSFAB_EXPERIMENTAL_STAGE_SPECIFIC_PRESERVATION_BASE", "1");
      vi.stubEnv("DOCSFAB_EXPERIMENTAL_PRESERVATION_OBSERVATION_REUSE", "1");
      const harness = new PreservationRestructureHarness();
      const record = await executeRunRequest(
        {
          runId: "application-preservation-cli",
          workflow: "restructure-documentation",
          instruction: "Restructure docs/guide.md while preserving its original facts.",
          repositoryPath: fixture.repository,
          revision: "HEAD",
          allowWrite: true,
          releaseGate: false,
          verbose: false,
          json: false,
          showScan: false,
        },
        runtimeConfig(fixture.stateDirectory),
        {
          silent: true,
          executionHarness: harness,
          skillResolver: {
            resolveSkill: async (input) => ({
              id: input.step.skill,
              contentSha256: "a".repeat(64),
            }),
          },
        },
      );
      expect(record?.status).toBe("succeeded");
      expect(harness.originalReads).toEqual([original, original]);
      expect(await readFile(join(fixture.repository, "docs", "guide.md"), "utf8")).toBe(original);
    },
    applicationExecutionTimeoutMs,
  );

  it("persists a real zero-step knowledge stop through both callers", async () => {
    const cliFixture = await createFixtureRepository("intent-gap");
    const liveFixture = await createFixtureRepository("intent-gap");
    roots.track(cliFixture.root);
    roots.track(liveFixture.root);
    const request = {
      workflow: "create-documentation" as const,
      instruction: "Create an About page that states the product purpose.",
      allowWrite: true,
    };
    const cliRecord = await executeRunRequest(
      {
        ...request,
        runId: "shared-stop-cli",
        repositoryPath: cliFixture.repository,
        revision: "HEAD",
        releaseGate: false,
        verbose: false,
        json: false,
        showScan: false,
      },
      runtimeConfig(cliFixture.stateDirectory),
      { silent: true },
    );
    process.exitCode = 47;
    const liveRecord = await runBoundedWorkflow({
      ...request,
      repositoryPath: liveFixture.repository,
      config: runtimeConfig(liveFixture.stateDirectory),
    });

    for (const [record, fixture] of [
      [cliRecord, cliFixture],
      [liveRecord, liveFixture],
    ] as const) {
      expect(record).toMatchObject({
        workflow: "create-documentation",
        status: "needs-input",
        repository: { revision: fixture.revision },
        workspace: { disposable: true },
        steps: [],
        knowledgeContinuationReceipt: expect.objectContaining({
          originalRunId: record!.id,
        }),
      });
      const saved = JSON.parse(
        await readFile(join(fixture.stateDirectory, `${record!.id}.json`), "utf8"),
      ) as RunRecord;
      expect(saved).toStrictEqual(record);
    }
    expect(process.exitCode).toBe(47);
  });

  it("awaits one consumer before disposing evidence and workspace after an exception", async () => {
    const fixture = await createFixtureRepository("documented");
    roots.track(fixture.root);
    let calls = 0;
    let workspacePath = "";

    await expect(
      withLocalWorkflowRun(
        {
          workflow: "readiness",
          repositoryPath: fixture.repository,
          revision: "HEAD",
          allowWrite: false,
          releaseGate: false,
          verbose: false,
          json: false,
          showScan: false,
        },
        runtimeConfig(fixture.stateDirectory),
        {
          silent: true,
          output: { log: () => undefined, error: () => undefined },
          executionHarness: new ReadinessHarness(),
          skillResolver: {
            resolveSkill: async (input) => ({
              id: input.step.skill,
              contentSha256: "a".repeat(64),
            }),
          },
        },
        async ({ workspace }) => {
          calls += 1;
          workspacePath = workspace.path;
          expect((await stat(workspace.path)).isDirectory()).toBe(true);
          throw new Error("consumer-fixture-failure");
        },
      ),
    ).rejects.toThrow("consumer-fixture-failure");

    expect(calls).toBe(1);
    await expect(stat(workspacePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("admits a local run past its profile review date and the record shows the advisory", async () => {
    // `withLocalWorkflowRun` asserts policy-profile readiness before
    // admission; a passed review date alone must not refuse the run.
    const fixture = await createFixtureRepository("documented");
    roots.track(fixture.root);
    const reviewAfter = "2020-02-01";
    expect(reviewAfter < new Date().toISOString().slice(0, 10)).toBe(true);
    const model = parseModelEndpoint({
      ...validModelEnvironment,
      MODEL_PROFILE_EFFECTIVE_DATE: "2020-01-01",
      MODEL_PROFILE_REVIEW_AFTER: reviewAfter,
    });
    expect(model.profile).toMatchObject({
      effectiveLimitReason: "none",
      reasoning: true,
      metadata: { status: "current", reviewAfter },
    });
    // Production harnesses record `createModelEvidence(config)`; so does this one.
    class ProfiledHarness extends ReadinessHarness {
      override async runStep(input: HarnessStepInput) {
        return { ...(await super.runStep(input)), model: createModelEvidence(model) };
      }
    }
    const harness = new ProfiledHarness();
    const record = await withLocalWorkflowRun(
      {
        workflow: "readiness",
        repositoryPath: fixture.repository,
        revision: fixture.revision,
        allowWrite: false,
        releaseGate: false,
        verbose: false,
        json: false,
        showScan: false,
      },
      { ...runtimeConfig(fixture.stateDirectory), model },
      {
        silent: true,
        output: { log: () => undefined, error: () => undefined },
        executionHarness: harness,
      },
      async ({ execution }) => ({ value: execution.record }),
    );

    expect(harness.inputs.length).toBeGreaterThan(0);
    expect(record!.models.map((item) => item.profile?.reviewAfter)).toContain(reviewAfter);
    const summary = formatRunSummary({
      record: record!,
      recordPath: "run.json",
      exitCode: 0,
      repositoryPath: fixture.repository,
    }).join("\n");
    expect(summary).toContain(
      `Review overdue: ${model.providerId}/${model.modelId} review date ${reviewAfter} had passed when the run started (reminder only; the configured profile was used).`,
    );

    // Adjacent condition: the same record read as of a run that started
    // before the review date carries no advisory.
    const earlier = formatRunSummary({
      record: { ...record!, startedAt: "2020-01-15T00:00:00.000Z" },
      recordPath: "run.json",
      exitCode: 0,
      repositoryPath: fixture.repository,
    }).join("\n");
    expect(earlier).not.toContain("Review overdue");
  });

  it("rejects cancellation before local admission without invoking model work or the consumer", async () => {
    const fixture = await createFixtureRepository("documented");
    roots.track(fixture.root);
    const controller = new AbortController();
    const harness = new ReadinessHarness();
    let consumed = 0;
    controller.abort();

    await expect(
      withLocalWorkflowRun(
        {
          workflow: "readiness",
          repositoryPath: fixture.repository,
          revision: fixture.revision,
          allowWrite: false,
          releaseGate: false,
          verbose: false,
          json: false,
          showScan: false,
        },
        runtimeConfig(fixture.stateDirectory),
        {
          silent: true,
          output: { log: () => undefined, error: () => undefined },
          signal: controller.signal,
          executionHarness: harness,
        },
        async ({ execution }) => {
          consumed += 1;
          return { value: execution.record };
        },
      ),
    ).rejects.toThrow("Workflow cancelled by user.");
    expect(harness.inputs).toHaveLength(0);
    expect(consumed).toBe(0);
  });
});
