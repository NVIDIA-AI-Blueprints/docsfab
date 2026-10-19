// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  runRunsImport,
  runRunsQuery,
  parseRunsQueryArguments,
} from "../src/cli/commands/runs-index.js";
import { handleWhyCommand, parseWhyArguments } from "../src/cli/commands/why.js";
import { findPublicCommand } from "../src/cli/command-registry.js";
import { handleRunsCommand } from "../src/cli/commands/runs.js";
import { runHostedWorkflow } from "../src/host-invoker/workflow-runner.js";
import { deliverCliRunResult } from "../src/cli/run/delivery.js";
import type { CliRunInvocation } from "../src/cli/run/request.js";
import {
  DIAGNOSIS_CAUSE_OWNERS,
  DIAGNOSIS_OWNER_CLASSES,
  WHY_REPORT_KIND,
  type WhyReportV1,
} from "../src/diagnosis/contracts.js";
import { WhyOperatorError } from "../src/diagnosis/load.js";
import { formatRunSummary } from "../src/operator/run-summary.js";
import type { RunRecord } from "../src/records/contracts.js";
import { defaultRunIndexDirectory, RUN_INDEX_FILE_NAME } from "../src/records/run-index-store.js";
import { projectRunIndexRows } from "../src/records/run-index.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import { validModelConfig } from "./helpers.js";
import { limit } from "../src/config/limits.js";
import { interpretRequest } from "../src/request-intent/interpret.js";
import { resolveRequestIntentLimits } from "../src/request-intent/limits.js";
import {
  persistRequestIntentStop,
  requestInterpretationStep,
} from "../src/cli/run/request-intent-stop.js";
import { NIM_FIXTURE_EXPECTATIONS, nimFixtureRecords } from "./helpers/diagnosis-nim-fixture.js";
import { createReadinessFixture, readinessRequest } from "./helpers/readiness-fixture.js";
import {
  createHostedCreateFixture,
  controlledHostedCreateHarness,
} from "./helpers/hosted-create.js";
import { canonicalSourceObligationProposal } from "../src/workflow-execution/source-obligation.js";

const SUPER = "nvidia/nemotron-3-super-120b-a12b";
const BATCH_ID = "b".repeat(64);

const roots: string[] = [];
const savedHostLimits = process.env.DOCSFAB_SERVICE_ENV_FILE;

afterEach(async () => {
  if (savedHostLimits === undefined) delete process.env.DOCSFAB_SERVICE_ENV_FILE;
  else process.env.DOCSFAB_SERVICE_ENV_FILE = savedHostLimits;
  process.exitCode = undefined;
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("public why for recorded stops", () => {
  async function stopState(index: boolean) {
    const root = await mkdtemp(join(tmpdir(), "docsfab why stop "));
    roots.push(root);
    const stateDirectory = join(root, "runs with spaces");
    await mkdir(stateDirectory, { recursive: true });
    const instruction = "Create one page about SENTINEL_PRIVATE_INSTRUCTION.";
    const outcome = await interpretRequest({
      port: {
        call: async () => ({
          text: JSON.stringify({
            operation: "create",
            targets: [],
            authorityPreference: {
              preference: "unspecified",
              quote: null,
            },
          }),
          usage: { inputTokens: 3, outputTokens: 2 },
        }),
      },
      workflow: "create-documentation",
      operation: "create",
      instruction,
      promptInventory: { entries: [], clippedTitles: 0 },
      admissionInventory: [],
      documentationRoots: [{ kind: "root", path: "docs" }],
      writeRoots: [{ kind: "root", path: "docs" }],
      navigationSet: [],
      existence: async () => [],
      limits: resolveRequestIntentLimits(),
      maxRetries: 0,
      window: {
        maxInputTokens: validModelConfig.profile!.maxInputTokens,
        maxOutputTokens: validModelConfig.profile!.maxOutputTokens,
      },
      deadlineMs: limit("requestIntent.interpretationTimeoutMs").value,
    });
    expect(outcome.outcome).toBe("question");
    const step = requestInterpretationStep(outcome, 0);
    expect(step).toMatchObject({ kind: "stop", status: "needs-input", exitCode: 2 });
    if (step.kind !== "stop") throw new Error("fixture did not stop");
    const admission = await persistRequestIntentStop({
      request: { workflow: "create-documentation", instruction, runId: "stop-question" } as never,
      config: { stateDirectory } as never,
      workspace: {
        sourcePath: join(root, "synthetic-source"),
        requestedRevision: "HEAD",
        revision: "a".repeat(40),
      } as never,
      step,
    });
    const saved = JSON.parse(
      await readFile(join(stateDirectory, `${admission.id}.json`), "utf8"),
    ) as Record<string, unknown>;
    const gate = (id: string, status: "needs-input" | "needs-human-decision") => ({
      ...saved,
      id,
      status,
      requestIntent: undefined,
      instruction: undefined,
      error: "SENTINEL_PRIVATE_ERROR",
      steps: [
        {
          id: "gate",
          skill: "gate",
          status,
          summary: "SENTINEL_MODEL_PROSE",
          inference: { attempts: [] },
        },
      ],
    });
    const failedAttempt = {
      attempt: 1,
      outcome: "malformed-response",
      retryable: false,
      durationMs: 10,
      model: { provider: "fixture-provider", model: "fixture-model" },
      rejectedReplyShape: {
        parse: { status: "failed", code: "malformed-json", detail: "unexpected-token" },
      },
    };
    const succeededAttempt = {
      attempt: 2,
      outcome: "succeeded",
      retryable: false,
      durationMs: 10,
      model: { provider: "fixture-provider", model: "fixture-model" },
    };
    const recoveredStep = (id: string, status: string) => ({
      id,
      skill: "gate",
      status,
      inference: { attempts: [failedAttempt, succeededAttempt] },
    });
    for (const record of [
      gate("stop-step-input", "needs-input"),
      gate("stop-human", "needs-human-decision"),
      {
        ...gate("stop-human-attempt", "needs-human-decision"),
        steps: [
          {
            id: "gate",
            skill: "gate",
            status: "needs-human-decision",
            inference: {
              attempts: [
                {
                  attempt: 1,
                  outcome: "malformed-response",
                  retryable: false,
                  durationMs: 10,
                  model: { provider: "fixture-provider", model: "fixture-model" },
                  rejectedReplyShape: {
                    parse: { status: "failed", code: "malformed-json", detail: "unexpected-token" },
                  },
                },
              ],
            },
          },
        ],
      },
      { ...saved, id: "stop-tampered", requestIntent: { invalid: "SENTINEL_PRIVATE_QUESTION" } },
      {
        ...gate("stop-ambiguous-recovery", "needs-human-decision"),
        steps: [
          recoveredStep("gate-one", "needs-human-decision"),
          {
            id: "gate-two",
            skill: "gate",
            status: "needs-human-decision",
            inference: { attempts: [] },
          },
        ],
      },
      {
        ...gate("stop-inconsistent-recovery", "needs-human-decision"),
        steps: [recoveredStep("gate-one", "needs-input")],
      },
      {
        ...gate("stop-succeeded-step", "needs-human-decision"),
        steps: [
          recoveredStep("completed", "succeeded"),
          {
            id: "gate",
            skill: "gate",
            status: "needs-human-decision",
            inference: { attempts: [] },
          },
        ],
      },
    ]) {
      await writeFile(join(stateDirectory, `${record.id}.json`), JSON.stringify(record));
    }
    if (index) {
      const imported = await runRunsImport({
        command: "import",
        help: false,
        json: true,
        indexDirectory: defaultRunIndexDirectory(stateDirectory),
        paths: [stateDirectory],
        docsfabRevision: null,
      });
      expect(imported.skipped ?? []).toHaveLength(0);
    } else {
      await rm(defaultRunIndexDirectory(stateDirectory), { recursive: true, force: true });
    }
    return stateDirectory;
  }

  it.each([true, false])(
    "explains sealed admission and step gates through indexed=%s projection",
    async (indexed) => {
      const stateDirectory = await stopState(indexed);
      for (const [id, status, admission] of [
        ["stop-question", "needs-input", "question"],
        ["stop-step-input", "needs-input", "unknown"],
        ["stop-human", "needs-human-decision", "unknown"],
        ["stop-tampered", "needs-input", "unknown"],
      ] as const) {
        const report = await whyJson([id, "--state-dir", stateDirectory]);
        const diagnosis = report.diagnoses[0]!;
        expect(diagnosis).toMatchObject({
          runStatus: status,
          verdict: "incomplete",
          stop: {
            status,
            admission,
          },
        });
        expect(diagnosis.findings).toEqual([]);
        expect(diagnosis.summary).not.toContain("without a failing step");
        expect(diagnosis.stop?.nextCommand).toBe(
          `docsfab runs show ${id} --state-dir '${stateDirectory}'`,
        );
        const text = await captureStdout(() =>
          handleWhyCommand([id, "--state-dir", stateDirectory]),
        );
        expect(text).toContain(`Stop: ${status}`);
        for (const sentinel of [
          "SENTINEL_PRIVATE_INSTRUCTION",
          "SENTINEL_PRIVATE_ERROR",
          "SENTINEL_PRIVATE_QUESTION",
          "SENTINEL_MODEL_PROSE",
        ]) {
          expect(JSON.stringify(diagnosis.stop)).not.toContain(sentinel);
          expect(text).not.toContain(sentinel);
        }
      }
      const all = await whyJson(["--all", "--state-dir", stateDirectory]);
      expect(all.diagnoses).toHaveLength(8);
      expect(
        all.diagnoses.find((diagnosis) => diagnosis.runId === "stop-human-attempt")?.findings,
      ).toMatchObject([{ role: "contributing" }]);
      expect(
        all.byModel.every(
          (model) =>
            model.failedRuns === 0 && model.causes.every((cause) => cause.role === "contributing"),
        ),
      ).toBe(true);
      const text = await captureStdout(() =>
        handleWhyCommand(["--all", "--state-dir", stateDirectory]),
      );
      expect(text).toContain("RUN stop-human");
      expect(text).toContain("Stop: needs-human-decision");
      expect(text).toContain("Also: step gate attempt 1");
      for (const id of ["stop-ambiguous-recovery", "stop-inconsistent-recovery"]) {
        const diagnosis = all.diagnoses.find((item) => item.runId === id)!;
        expect(diagnosis.stop?.stepId).toBeNull();
        expect(diagnosis.findings).toMatchObject([{ role: "contributing", recovered: true }]);
        const one = await captureStdout(() =>
          handleWhyCommand([id, "--state-dir", stateDirectory]),
        );
        expect(one).toContain("a later attempt succeeded, but the run then stopped");
        expect(one).not.toContain("the step later succeeded");
      }
      const succeeded = await captureStdout(() =>
        handleWhyCommand(["stop-succeeded-step", "--state-dir", stateDirectory]),
      );
      expect(succeeded).toContain("the step later succeeded");
      expect(
        all.diagnoses.find((item) => item.runId === "stop-succeeded-step")?.findings,
      ).toMatchObject([{ role: "contributing", recovered: true, stepSucceeded: true }]);
    },
  );

  it("withholds a default-store show command when only an index directory is known", async () => {
    const stateDirectory = await stopState(true);
    const indexDirectory = defaultRunIndexDirectory(stateDirectory);
    const report = await whyJson(["stop-question", "--index-dir", indexDirectory]);
    const stop = report.diagnoses[0]?.stop;
    expect(stop).toMatchObject({
      status: "needs-input",
      nextCommand: null,
      limitations: [
        "stop-detail-unavailable",
        "stop-step-unavailable",
        "stop-saved-location-unavailable",
      ],
    });
    expect(stop?.nextAction).toContain("does not establish");
    const text = await captureStdout(() =>
      handleWhyCommand(["stop-question", "--index-dir", indexDirectory]),
    );
    expect(text).toContain("Limitation: stop-saved-location-unavailable.");
    expect(text).not.toContain("Command: docsfab runs show stop-question");
  });
});

/** A state directory holding the fixture records, optionally indexed with runs import. */
async function fixtureStateDirectory(options: { readonly index: boolean }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "docsfab-why-"));
  roots.push(root);
  const stateDirectory = join(root, "runs");
  await mkdir(stateDirectory, { recursive: true });
  for (const record of nimFixtureRecords()) {
    await writeFile(join(stateDirectory, `${String(record.id)}.json`), JSON.stringify(record));
  }
  if (options.index) {
    const imported = await runRunsImport({
      command: "import",
      help: false,
      json: true,
      indexDirectory: defaultRunIndexDirectory(stateDirectory),
      paths: [stateDirectory],
      docsfabRevision: null,
    });
    expect(imported.imported).toHaveLength(13);
  }
  return stateDirectory;
}

/** Three fixture runs imported as one harness batch, the other ten from a state directory. */
async function batchStateDirectory(): Promise<{
  readonly stateDirectory: string;
  readonly batchRunIds: readonly string[];
}> {
  const root = await mkdtemp(join(tmpdir(), "docsfab-why-batch-"));
  roots.push(root);
  const stateDirectory = join(root, "runs");
  const batch = join(root, "batch");
  await mkdir(stateDirectory, { recursive: true });
  const batchRunIds = ["nim-omni-content", "nim-super-not-json", "nim-ultra-truncated"];
  for (const record of nimFixtureRecords()) {
    const id = String(record.id);
    const directory = batchRunIds.includes(id) ? join(batch, id, "runs") : stateDirectory;
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `${id}.json`), JSON.stringify(record));
  }
  await writeFile(
    join(batch, "report.json"),
    JSON.stringify({
      schemaVersion: 1,
      kind: "docsfab-local-e2e-report",
      batchId: BATCH_ID,
      entries: batchRunIds.map((key) => ({ key, outcome: "fail" })),
    }),
  );
  const imported = await runRunsImport({
    command: "import",
    help: false,
    json: true,
    indexDirectory: defaultRunIndexDirectory(stateDirectory),
    paths: [stateDirectory, batch],
    docsfabRevision: null,
  });
  expect(imported.imported).toHaveLength(13);
  return { stateDirectory, batchRunIds };
}

async function captureStdout(action: () => Promise<unknown>): Promise<string> {
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

async function whyJson(args: readonly string[]): Promise<WhyReportV1> {
  return JSON.parse(
    await captureStdout(() => handleWhyCommand([...args, "--json"])),
  ) as WhyReportV1;
}

function terminalCauses(report: WhyReportV1): Record<string, unknown> {
  return Object.fromEntries(
    report.diagnoses.map((diagnosis) => {
      const finding = diagnosis.findings.find((candidate) => candidate.role === "terminal");
      return [diagnosis.runId, { ownerClass: finding?.ownerClass, cause: finding?.cause }];
    }),
  );
}

describe("docsfab why", () => {
  it("is a registered read-only command", () => {
    expect(findPublicCommand("why")).toMatchObject({ name: "why", readOnly: true });
  });

  it("reads finish=length before bounds-exceeded and does not prescribe output tokens for a separate bound", async () => {
    const root = await mkdtemp(join(tmpdir(), "docsfab-why-bounds-"));
    roots.push(root);
    const stateDirectory = join(root, "runs");
    await mkdir(stateDirectory);
    for (const [id, code, finishReason] of [
      ["why-length-bound", "bounds-exceeded", "length"],
      ["why-limit-under-allowance", "fact-inventory-limitations-exceeded", "stop"],
    ] as const) {
      await writeFile(
        join(stateDirectory, `${id}.json`),
        JSON.stringify({
          schemaVersion: 2,
          id,
          workflow: "review-documentation",
          status: "failed",
          createdAt: "2026-10-10T12:00:00.000Z",
          steps: [
            {
              id: "verify-technical-accuracy",
              skill: "verify-technical-accuracy",
              status: "failed",
              inference: {
                attempts: [
                  {
                    attempt: 1,
                    outcome: "malformed-response",
                    retryable: false,
                    durationMs: 10,
                    model: { provider: "fixture-provider", model: "fixture-model" },
                    modelTelemetry: {
                      schemaVersion: 1,
                      providerLatencyMs: 1_000,
                      finishReason,
                      outputTokens: 392,
                      outputAllowance: 16_384,
                    },
                    rejection: { code, location: "$response" },
                    rejectedReplyShape: { parse: { status: "parsed" } },
                  },
                ],
              },
            },
          ],
        }),
      );
    }
    const length = await whyJson(["why-length-bound", "--state-dir", stateDirectory]);
    expect(
      length.diagnoses[0]?.findings,
      JSON.stringify(length.diagnoses[0]?.findings),
    ).toMatchObject([{ ownerClass: "output-limit", cause: "output-allowance-reached" }]);
    const bounded = await whyJson(["why-limit-under-allowance", "--state-dir", stateDirectory]);
    expect(bounded.diagnoses[0]?.findings).toMatchObject([
      { ownerClass: "operator-configuration", cause: "operational-limit-reached" },
    ]);
    expect(bounded.diagnoses[0]?.findings[0]?.nextAction).not.toMatch(/maxOutputTokens/u);
  });

  it("diagnoses every fixture run from the index with the expected owners", async () => {
    const stateDirectory = await fixtureStateDirectory({ index: true });
    const report = await whyJson([stateDirectory]);
    expect(report).toMatchObject({
      schemaVersion: 1,
      kind: WHY_REPORT_KIND,
      selection: { mode: "all", runId: null, batchId: null, model: null },
      runs: { matched: 13, diagnosed: 13, clipped: false, limit: { name: "diagnosis.maxRuns" } },
      limitations: [],
    });
    expect(report.diagnoses.every((diagnosis) => diagnosis.source === "run-index")).toBe(true);
    expect(terminalCauses(report)).toEqual(NIM_FIXTURE_EXPECTATIONS);
  });

  it("carries sealed readiness disposition and reasons through query, why, and saved-record fallback", async () => {
    const fixture = await createReadinessFixture();
    roots.push(fixture.root);
    const result = await runHostedWorkflow({
      request: readinessRequest(fixture, "readiness"),
      credential: null,
      emit() {},
    });
    expect(result.record.status).toBe("succeeded");
    expect(result.record.workflowOutcome?.disposition).toBe("inconclusive");
    const expectedReasons =
      '[{"criterionId":"source-completeness","code":"model-assessed-unassessed"},{"criterionId":"source-usability","code":"model-assessed-unassessed"}]';
    expect(result.record.workflowOutcome?.findings.map((finding) => finding.code)).toEqual([
      "readiness-source-completeness-model-assessed-unassessed",
      "readiness-source-usability-model-assessed-unassessed",
    ]);
    await runRunsImport({
      command: "import",
      help: false,
      json: true,
      indexDirectory: defaultRunIndexDirectory(fixture.state),
      paths: [fixture.state],
      docsfabRevision: null,
    });

    const indexed = await whyJson([result.record.id, "--state-dir", fixture.state]);
    expect(indexed.diagnoses[0]).toMatchObject({
      source: "run-index",
      workflow: "readiness",
      runStatus: "succeeded",
      verdict: "succeeded",
      readinessDisposition: "inconclusive",
      readinessReasonCodes: expectedReasons,
    });
    const query = JSON.parse(
      await captureStdout(() =>
        handleRunsCommand([
          "query",
          "--where",
          `runId=${result.record.id}`,
          "--where",
          "rowKind=run",
          "--group-by",
          "readinessDisposition,readinessReasonCodes,runStatus",
          "--state-dir",
          fixture.state,
          "--json",
        ]),
      ),
    ) as { population: { runs: number }; groups: { key: Record<string, unknown> }[] };
    expect(query.population.runs).toBe(1);
    expect(query.groups).toHaveLength(1);
    expect(query.groups[0]).toMatchObject({
      key: {
        readinessDisposition: "inconclusive",
        readinessReasonCodes: expectedReasons,
        runStatus: "succeeded",
      },
      runs: 1,
    });
    const text = await captureStdout(() =>
      handleWhyCommand([result.record.id, "--state-dir", fixture.state]),
    );
    expect(text).toContain(`Readiness: inconclusive; criterion reasons ${expectedReasons}.`);

    await rm(join(defaultRunIndexDirectory(fixture.state), RUN_INDEX_FILE_NAME));
    const fallback = await whyJson([result.record.id, "--state-dir", fixture.state]);
    expect(fallback.diagnoses[0]).toMatchObject({
      source: "record",
      runStatus: "succeeded",
      verdict: "succeeded",
      readinessDisposition: "inconclusive",
      readinessReasonCodes: expectedReasons,
    });
  }, 120_000);

  it("projects validated source proposal outcomes through indexed and saved-record why", async () => {
    const fixture = await createHostedCreateFixture({
      sourceFiles: { "src/extra.ts": "export const extra = true;\n" },
    });
    roots.push(fixture.root);
    const base = controlledHostedCreateHarness(fixture.request);
    const originalRunStep = base.harness.runStep.bind(base.harness);
    const reason = "This tracked source is needed to verify the requested technical claim.";
    const harness = {
      ...base.harness,
      async runStep(input: Parameters<typeof originalRunStep>[0]) {
        const result = await originalRunStep(input);
        if (input.step.id !== "derive-source-obligations" || !result.sourceObligationProposal) {
          return result;
        }
        const sourceObligationProposal = {
          ...result.sourceObligationProposal,
          sourceProposals:
            input.inferenceAttempt === 1
              ? [
                  { path: "src/not-tracked.ts", reason },
                  { path: "docs/new-guide.md", reason },
                ]
              : [{ path: "src/extra.ts", reason }],
        };
        return {
          ...result,
          sourceObligationProposal,
          summary: canonicalSourceObligationProposal(sourceObligationProposal),
        };
      },
    };
    const result = await runHostedWorkflow({
      request: fixture.request,
      credential: null,
      emit() {},
      executionHarness: harness,
    });
    expect(result.record.status).toBe("succeeded");
    const derive = result.record.steps.find((step) => step.id === "derive-source-obligations");
    expect(derive?.sourceProposalAdmissions).toMatchObject([
      {
        attempt: 1,
        path: "src/not-tracked.ts",
        status: "refused",
        refusalCode: "source-untracked",
      },
      {
        attempt: 1,
        path: "docs/new-guide.md",
        status: "refused",
        refusalCode: "write-target-source",
      },
      { attempt: 2, path: "src/extra.ts", status: "admitted" },
    ]);
    expect(derive?.sourceProposalAdmissions?.every((entry) => entry.reason === reason)).toBe(true);
    const unboundAttemptRecord = structuredClone(result.record);
    const unboundDerive = unboundAttemptRecord.steps.find(
      (step) => step.id === "derive-source-obligations",
    );
    if (!unboundDerive?.sourceProposalAdmissions?.[0]) {
      throw new Error("hosted CREATE fixture did not retain its source proposal receipt");
    }
    Object.assign(unboundDerive.sourceProposalAdmissions[0], { attempt: 999_999 });
    const unboundProjection = projectRunIndexRows(unboundAttemptRecord, {
      origin: "import",
      snapshotId: "unbound-source-proposals",
      indexedAt: "2026-10-12T12:00:00.000Z",
      recordSha256: "b".repeat(64),
      fieldMaxChars: 512,
    });
    expect(unboundProjection.ok).toBe(true);
    if (!unboundProjection.ok) throw new Error("unbound fixture projection unexpectedly failed");
    expect(unboundProjection.rows[0]?.sourceProposalOutcomes).toBeNull();
    expect(unboundProjection.rows[0]?.omittedFields).toContain("sourceProposalOutcomes");
    const boundedProjection = projectRunIndexRows(result.record, {
      origin: "import",
      snapshotId: "bounded-source-proposals",
      indexedAt: "2026-10-12T12:00:00.000Z",
      recordSha256: "a".repeat(64),
      fieldMaxChars: 32,
    });
    expect(boundedProjection.ok).toBe(true);
    if (!boundedProjection.ok) throw new Error("valid hosted fixture did not project");
    expect(boundedProjection.rows[0]?.sourceProposalOutcomes).toBeNull();
    expect(boundedProjection.rows[0]?.omittedFields).toContain("sourceProposalOutcomes");
    await runRunsImport({
      command: "import",
      help: false,
      json: true,
      indexDirectory: defaultRunIndexDirectory(fixture.state),
      paths: [fixture.state],
      docsfabRevision: null,
    });

    const expected = [
      {
        attempt: 1,
        path: "src/not-tracked.ts",
        status: "refused",
        refusalCode: "source-untracked",
      },
      {
        attempt: 1,
        path: "docs/new-guide.md",
        status: "refused",
        refusalCode: "write-target-source",
      },
      { attempt: 2, path: "src/extra.ts", status: "admitted" },
    ];
    const indexed = await whyJson([result.record.id, "--state-dir", fixture.state]);
    expect(indexed.diagnoses[0]).toMatchObject({
      source: "run-index",
      sourceProposalOutcomes: expected,
      sourceProposalOutcomesOmitted: false,
    });
    expect(JSON.stringify(indexed)).not.toContain(reason);
    const indexedText = await captureStdout(() =>
      handleWhyCommand([result.record.id, "--state-dir", fixture.state]),
    );
    expect(indexedText).toContain("Source proposals:");
    expect(indexedText).toContain("Attempt 1: refused src/not-tracked.ts (source-untracked).");
    expect(indexedText).toContain("Attempt 2: admitted src/extra.ts.");
    expect(indexedText).not.toContain(reason);

    await rm(join(defaultRunIndexDirectory(fixture.state), RUN_INDEX_FILE_NAME));
    const fallback = await whyJson([result.record.id, "--state-dir", fixture.state]);
    expect(fallback.diagnoses[0]).toMatchObject({
      source: "record",
      sourceProposalOutcomes: expected,
      sourceProposalOutcomesOmitted: false,
    });
    expect(JSON.stringify(fallback)).not.toContain(reason);
  }, 120_000);

  it("keeps the docsfab-why schema version 1 key set stable", async () => {
    const stateDirectory = await fixtureStateDirectory({ index: true });
    const report = await whyJson(["nim-omni-content", "--state-dir", stateDirectory]);
    expect(Object.keys(report).sort()).toEqual([
      "byModel",
      "diagnoses",
      "index",
      "kind",
      "limitations",
      "runs",
      "schemaVersion",
      "selection",
    ]);
    const diagnosis = report.diagnoses[0]!;
    expect(Object.keys(diagnosis).sort()).toEqual([
      "batchId",
      "caseKey",
      "docsfabRevision",
      "findings",
      // Nullable, so schema version 1 still holds.
      "model",
      // Nullable, so schema version 1 still holds.
      "planConversion",
      "provider",
      "readinessDisposition",
      "readinessReasonCodes",
      "runCreatedAt",
      "runId",
      "runStatus",
      "showCommand",
      "source",
      // Nullable, so schema version 1 still holds.
      "sourceEvidence",
      "sourceProposalOutcomes",
      "sourceProposalOutcomesOmitted",
      "stop",
      "summary",
      // Nullable, so schema version 1 still holds.
      "unverifiedDimensions",
      "verdict",
      "whyCommand",
      "workflow",
    ]);
    const finding = diagnosis.findings[0]!;
    expect(Object.keys(finding).sort()).toEqual([
      "alsoCause",
      "attempts",
      "cause",
      "evidence",
      "limitations",
      "nextAction",
      "nextCommand",
      "ownerClass",
      "recovered",
      "recurrence",
      "reproduce",
      "role",
      "signature",
      "stepAttempts",
      "stepId",
      "stepIndex",
      "stepSucceeded",
      "what",
      "why",
    ]);
    for (const candidate of diagnosis.findings) {
      expect(DIAGNOSIS_CAUSE_OWNERS[candidate.cause]).toBe(candidate.ownerClass);
    }
  });

  it("answers --last with the newest run and a finding whose query reproduces its rows", async () => {
    const stateDirectory = await fixtureStateDirectory({ index: true });
    const report = await whyJson(["--last", "--state-dir", stateDirectory]);
    expect(report.diagnoses.map((diagnosis) => diagnosis.runId)).toEqual(["nim-ultra-composition"]);
    const finding = report.diagnoses[0]!.findings[0]!;
    expect(finding.reproduce).toContain(`--state-dir ${stateDirectory}`);
    const recurrence = finding.recurrence!;
    // Run the printed recurrence command through the real query parser.
    const args = recurrence.query.replace(/^docsfab runs query /u, "").split(" ");
    const envelope = await runRunsQuery(parseRunsQueryArguments(args));
    expect(envelope.population.runs).toBe(recurrence.runs);
  });

  it("resolves a unique run ID prefix and refuses an unknown run by code", async () => {
    const stateDirectory = await fixtureStateDirectory({ index: true });
    const report = await whyJson(["nim-nano", "--state-dir", stateDirectory]);
    expect(report.diagnoses[0]?.findings[0]).toMatchObject({
      cause: "provider-model-retired",
      evidence: { httpStatus: 410 },
    });
    await expect(
      handleWhyCommand(["nim-super-stream", "--state-dir", stateDirectory]),
    ).rejects.toMatchObject({
      code: "why-run-ambiguous",
    });
    await expect(
      handleWhyCommand(["no-such-run", "--state-dir", stateDirectory]),
    ).rejects.toMatchObject({
      code: "why-run-not-found",
    });
  });

  it("reads saved records the index lacks and says so", async () => {
    const stateDirectory = await fixtureStateDirectory({ index: false });
    const report = await whyJson(["--all", "--state-dir", stateDirectory]);
    expect(report.index.exists).toBe(false);
    expect(report.limitations).toContain("runs-not-indexed:13");
    expect(report.diagnoses.every((diagnosis) => diagnosis.source === "record")).toBe(true);
    expect(terminalCauses(report)).toEqual(NIM_FIXTURE_EXPECTATIONS);
    const text = await captureStdout(() =>
      handleWhyCommand(["--all", "--state-dir", stateDirectory]),
    );
    expect(text).toContain("Not indexed: 13 runs were diagnosed from their saved records");
    expect(text).toContain(
      `docsfab runs import ${stateDirectory} --state-dir ${stateDirectory} adds them`,
    );
  });

  it("states clipping at diagnosis.maxRuns instead of dropping runs silently", async () => {
    const stateDirectory = await fixtureStateDirectory({ index: true });
    const hostLimits = join(stateDirectory, "..", "service.env");
    await writeFile(hostLimits, "diagnosis.maxRuns=2\n");
    process.env.DOCSFAB_SERVICE_ENV_FILE = hostLimits;
    const report = await whyJson([stateDirectory]);
    expect(report.runs).toEqual({
      matched: 13,
      diagnosed: 2,
      clipped: true,
      limit: { name: "diagnosis.maxRuns", value: 2 },
    });
    const text = await captureStdout(() => handleWhyCommand([stateDirectory]));
    expect(text).toContain(
      "Clipped: the newest 2 of 13 runs were diagnosed (diagnosis.maxRuns = 2).",
    );
  });

  it("diagnoses every run without clipping when the match equals diagnosis.maxRuns", async () => {
    const stateDirectory = await fixtureStateDirectory({ index: true });
    const hostLimits = join(stateDirectory, "..", "service.env");
    await writeFile(hostLimits, "diagnosis.maxRuns=13\n");
    process.env.DOCSFAB_SERVICE_ENV_FILE = hostLimits;
    const report = await whyJson([stateDirectory]);
    expect(report.runs).toEqual({
      matched: 13,
      diagnosed: 13,
      clipped: false,
      limit: { name: "diagnosis.maxRuns", value: 13 },
    });
    const text = await captureStdout(() => handleWhyCommand([stateDirectory]));
    expect(text).not.toContain("Clipped:");
  });

  it("filters by model and prints a per-model summary", async () => {
    const stateDirectory = await fixtureStateDirectory({ index: true });
    const report = await whyJson([stateDirectory, "--model", SUPER]);
    expect(report.selection.model).toBe(SUPER);
    expect(report.runs).toMatchObject({ matched: 7, diagnosed: 7, clipped: false });
    expect(report.diagnoses.map((diagnosis) => diagnosis.runId).sort()).toEqual([
      "nim-super-composition",
      "nim-super-not-json",
      "nim-super-stream-a",
      "nim-super-stream-audit",
      "nim-super-stream-b",
      "nim-super-stream-c",
      "nim-super-stream-verify",
    ]);
    expect(report.diagnoses.every((diagnosis) => diagnosis.model === SUPER)).toBe(true);
    expect(report.byModel.every((group) => group.model === SUPER)).toBe(true);
    const text = await captureStdout(() => handleWhyCommand([stateDirectory, "--model", SUPER]));
    for (const excluded of [
      "nvidia/nemotron-3-nano-30b-a3b",
      "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
      "nvidia/nemotron-3-ultra-550b-a55b",
    ]) {
      expect(text).not.toContain(excluded);
    }
    expect(text).toContain("BY MODEL");
    expect(text).toContain(
      "operator-configured-openai-compatible nvidia/nemotron-3-super-120b-a12b: 6 runs; 6 ended by a failure on this model",
    );
    expect(text).toContain("ended by provider capacity (provider-stream-error) in 5 runs");
    expect(text).toContain(
      "ended by DocsFab defect (boundary-refusal) in 1 run at audit-documentation",
    );
  });

  it("selects only the runs of one harness batch with --batch", async () => {
    const { stateDirectory, batchRunIds } = await batchStateDirectory();
    const report = await whyJson(["--batch", BATCH_ID, "--state-dir", stateDirectory]);
    expect(report.selection).toMatchObject({ mode: "batch", batchId: BATCH_ID });
    expect(report.runs).toMatchObject({ matched: 3, diagnosed: 3, clipped: false });
    expect(report.diagnoses.map((diagnosis) => diagnosis.runId).sort()).toEqual(batchRunIds);
    expect(report.diagnoses.every((diagnosis) => diagnosis.batchId === BATCH_ID)).toBe(true);
    const combined = await whyJson([
      "--batch",
      BATCH_ID,
      "--model",
      SUPER,
      "--state-dir",
      stateDirectory,
    ]);
    expect(combined.diagnoses.map((diagnosis) => diagnosis.runId)).toEqual(["nim-super-not-json"]);
  });

  it("refuses a --batch that matches no indexed run", async () => {
    const { stateDirectory } = await batchStateDirectory();
    await expect(
      handleWhyCommand(["--batch", "c".repeat(64), "--state-dir", stateDirectory]),
    ).rejects.toMatchObject({ code: "why-no-runs" });
  });

  it("documents every owner class and cause in the reference page", async () => {
    const page = await readFile(
      new URL(
        "../../../docs/reference/status-and-configuration/diagnose-failed-runs.md",
        import.meta.url,
      ),
      "utf8",
    );
    for (const owner of DIAGNOSIS_OWNER_CLASSES) expect(page).toContain(`| \`${owner}\` |`);
    for (const [cause, owner] of Object.entries(DIAGNOSIS_CAUSE_OWNERS)) {
      expect(page).toContain(`| \`${cause}\` | \`${owner}\` |`);
    }
  });

  it("refuses a named state directory that does not exist", async () => {
    await expect(
      handleWhyCommand(["--last", "--state-dir", join(tmpdir(), "docsfab-why-missing-state")]),
    ).rejects.toMatchObject({ code: "why-state-dir-missing" });
  });

  it("reads the continued reply's output total from the index row alone", async () => {
    const stateDirectory = await fixtureStateDirectory({ index: true });
    const indexDirectory = join(stateDirectory, "..", "run-index");
    const continued = {
      ownerClass: "output-limit",
      cause: "reply-continued-over-allowance",
      alsoCause: { ownerClass: "contract-shape" },
      evidence: { attemptTotals: { outputTokens: 7062, allowance: 4096, continuations: 1 } },
    };
    for (const location of [
      ["--state-dir", stateDirectory],
      ["--index-dir", indexDirectory],
    ]) {
      const answer = await whyJson(["nim-super-not-json", ...location]);
      expect(answer.diagnoses[0]?.findings[0]).toMatchObject(continued);
    }
    // Rows an earlier DocsFab indexed carry no total: both owners are named.
    const indexFile = join(indexDirectory, "runs.jsonl");
    const earlier = (await readFile(indexFile, "utf8"))
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => {
        const row = JSON.parse(line) as Record<string, unknown>;
        for (const field of ["attemptOutputTokens", "continuations", "answerOutputTokens"]) {
          delete row[field];
        }
        return `${JSON.stringify(row)}\n`;
      })
      .join("");
    await writeFile(indexFile, earlier);
    const stale = await whyJson(["nim-super-not-json", "--index-dir", indexDirectory]);
    expect(stale.diagnoses[0]?.findings[0]).toMatchObject({
      cause: "reply-not-json",
      alsoCause: { ownerClass: "output-limit" },
      limitations: ["attempt-output-total-not-recorded"],
    });
  });

  /** Rewrite the index beside `stateDirectory` as revision 7 wrote it, without the newer fields. */
  async function indexAsRevision7(
    stateDirectory: string,
    patch: Record<string, unknown> = {},
  ): Promise<string> {
    const indexDirectory = join(stateDirectory, "..", "run-index");
    const indexFile = join(indexDirectory, "runs.jsonl");
    const earlier = (await readFile(indexFile, "utf8"))
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => {
        const row = JSON.parse(line) as Record<string, unknown>;
        for (const field of [
          "attemptOutputTokens",
          "continuations",
          "firstFinishReason",
          "answerOutputTokens",
          "terminalStepId",
          "failureCode",
          "retryDecisionRule",
        ]) {
          delete row[field];
        }
        return `${JSON.stringify({ ...row, ...patch, projectionRevision: 7 })}\n`;
      })
      .join("");
    await writeFile(indexFile, earlier);
    return indexDirectory;
  }

  it("re-reads a run an earlier DocsFab indexed from its saved record, as runs import would", async () => {
    const stateDirectory = await fixtureStateDirectory({ index: true });
    await indexAsRevision7(stateDirectory);
    const report = await whyJson(["nim-super-not-json", "--state-dir", stateDirectory]);
    expect(report.diagnoses[0]).toMatchObject({ source: "record" });
    expect(report.diagnoses[0]?.findings[0]).toMatchObject({
      ownerClass: "output-limit",
      cause: "reply-continued-over-allowance",
      evidence: { attemptTotals: { outputTokens: 7062, allowance: 4096, continuations: 1 } },
      limitations: [],
    });
    expect(report.limitations).toEqual(["runs-reprojected:1"]);
    const text = await captureStdout(() =>
      handleWhyCommand(["nim-super-not-json", "--state-dir", stateDirectory]),
    );
    expect(text).toContain(
      `Re-read: 1 run was indexed by an earlier DocsFab, so it was diagnosed from its saved record; docsfab runs import ${stateDirectory} --state-dir ${stateDirectory} indexes it again.`,
    );
    expect(text).not.toContain("attempt-output-total-not-recorded");
  });

  it("keeps the batch, case, and build revision import would keep when it re-reads a run", async () => {
    const { stateDirectory } = await batchStateDirectory();
    const revision = "3".repeat(40);
    await indexAsRevision7(stateDirectory, { docsfabRevision: revision });
    // The batch run's record, beside the state directory with its indexed bytes.
    const record = nimFixtureRecords().find((value) => value.id === "nim-super-not-json");
    const path = join(stateDirectory, "nim-super-not-json.json");
    await writeFile(path, JSON.stringify(record));
    const sameBytes = await whyJson(["--batch", BATCH_ID, "--state-dir", stateDirectory]);
    const reRead = sameBytes.diagnoses.find((value) => value.runId === "nim-super-not-json");
    expect(reRead).toMatchObject({
      source: "record",
      batchId: BATCH_ID,
      caseKey: "nim-super-not-json",
      docsfabRevision: revision,
    });
    expect(reRead?.findings[0]).toMatchObject({ cause: "reply-continued-over-allowance" });
    // Different bytes: the batch and case stay, and the build revision is not claimed.
    await writeFile(path, JSON.stringify(record, null, 2));
    const otherBytes = await whyJson(["--batch", BATCH_ID, "--state-dir", stateDirectory]);
    expect(
      otherBytes.diagnoses.find((value) => value.runId === "nim-super-not-json"),
    ).toMatchObject({
      source: "record",
      batchId: BATCH_ID,
      caseKey: "nim-super-not-json",
      docsfabRevision: null,
    });
  });

  it("never diagnoses another run's record filed under this run's name", async () => {
    const stateDirectory = await fixtureStateDirectory({ index: true });
    await indexAsRevision7(stateDirectory);
    const other = nimFixtureRecords().find((value) => value.id === "nim-omni-content");
    await writeFile(join(stateDirectory, "nim-super-not-json.json"), JSON.stringify(other));
    const report = await whyJson(["nim-super-not-json", "--state-dir", stateDirectory]);
    expect(report.diagnoses[0]).toMatchObject({ runId: "nim-super-not-json", source: "run-index" });
    expect(report.limitations).toEqual(["runs-index-earlier:1"]);
  });

  it("says an earlier DocsFab indexed a run whose record it cannot read, and names the import", async () => {
    const stateDirectory = await fixtureStateDirectory({ index: true });
    const indexDirectory = await indexAsRevision7(stateDirectory);
    await rm(join(stateDirectory, "nim-super-not-json.json"));
    const report = await whyJson(["nim-super-not-json", "--state-dir", stateDirectory]);
    expect(report.diagnoses[0]).toMatchObject({ source: "run-index" });
    expect(report.diagnoses[0]?.findings[0]).toMatchObject({
      cause: "reply-not-json",
      alsoCause: { ownerClass: "output-limit" },
      limitations: ["attempt-output-total-not-recorded"],
    });
    expect(report.limitations).toEqual(["runs-index-earlier:1"]);
    const text = await captureStdout(() =>
      handleWhyCommand(["nim-super-not-json", "--state-dir", stateDirectory]),
    );
    expect(text).toContain(
      `Earlier index: 1 run was indexed by an earlier DocsFab and its saved record was missing, unreadable, or not that run's terminal record, so fields added since read unavailable; docsfab runs import ${stateDirectory} --state-dir ${stateDirectory} indexes it again.`,
    );
    expect(text).toContain(
      "Limitation: attempt-output-total-not-recorded: The run index row carries no total output tokens and continuations for this attempt",
    );
    expect(text).not.toContain("The saved record gives no total");
    // With only the index named, the import names the state directory to supply.
    const indexOnly = await captureStdout(() =>
      handleWhyCommand(["nim-super-not-json", "--index-dir", indexDirectory]),
    );
    expect(indexOnly).toContain(
      `Earlier index: 1 run was indexed by an earlier DocsFab and not read again, because no state directory was named, so fields added since read unavailable; docsfab runs import <state-directory> --index-dir ${indexDirectory} indexes it again.`,
    );
  });

  it("refuses conflicting selectors with a usage code", async () => {
    await expect(parseWhyArguments(["run-a", "--last"])).rejects.toBeInstanceOf(WhyOperatorError);
    await expect(parseWhyArguments(["--last", "--all"])).rejects.toMatchObject({
      code: "why-invalid-arguments",
    });
    await expect(
      parseWhyArguments(["--state-dir", "/a", "--index-dir", "/b"]),
    ).rejects.toMatchObject({ code: "why-invalid-arguments" });
  });
});

describe("failed-run DIAGNOSIS block", () => {
  function failedRecord(): RunRecord {
    const fixture = nimFixtureRecords().find((record) => record.id === "nim-ultra-truncated")!;
    return {
      schemaVersion: 2,
      id: "nim-ultra-truncated",
      workflow: "review-documentation",
      repository: {
        sourcePath: "/tmp/example",
        requestedRevision: "HEAD",
        revision: "a".repeat(40),
      },
      workspace: { strategy: "tracked-export", disposable: true },
      status: "failed",
      createdAt: "2026-09-30T16:06:30.775Z",
      models: [],
      skills: [],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0 },
      tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
      steps: fixture.steps as RunRecord["steps"],
    };
  }

  it("reports a length-ended bounds rejection as an output limit through docsfab why", async () => {
    const stateDirectory = await fixtureStateDirectory({ index: false });
    const record = failedRecord();
    const originalStep = record.steps[0]!;
    const originalInference = originalStep.inference;
    if (!originalInference) throw new Error("fixture step has no inference record");
    const originalAttempt = originalInference.attempts[0]!;
    const lengthBoundRecord: RunRecord = {
      ...record,
      id: "length-bound-rejection",
      steps: [
        {
          ...originalStep,
          inference: {
            ...originalInference,
            attempts: [
              {
                ...originalAttempt,
                rejection: { code: "bounds-exceeded", location: "$response" },
                modelTelemetry: {
                  ...(originalAttempt.modelTelemetry ?? {
                    schemaVersion: 1 as const,
                    providerLatencyMs: 0,
                  }),
                  finishReason: "length",
                  outputTokens: 392,
                  outputAllowance: 16384,
                },
              },
            ],
          },
        },
      ],
    };
    await writeFile(
      join(stateDirectory, `${lengthBoundRecord.id}.json`),
      JSON.stringify(lengthBoundRecord),
    );
    const report = await whyJson([lengthBoundRecord.id, "--state-dir", stateDirectory]);
    expect(report.diagnoses[0]?.findings[0]).toMatchObject({
      ownerClass: "output-limit",
      cause: "output-allowance-reached",
    });
  });

  it("ends a failed run with DIAGNOSIS and a docsfab why line that answers the same", async () => {
    const stateDirectory = await fixtureStateDirectory({ index: true });
    const record = failedRecord();
    const lines = formatRunSummary({
      record,
      recordPath: join(stateDirectory, `${record.id}.json`),
      exitCode: 1,
      repositoryPath: "/tmp/example",
      tty: false,
    });
    const text = lines.join("\n");
    const diagnosisAt = lines.indexOf("DIAGNOSIS");
    expect(diagnosisAt).toBeGreaterThan(lines.indexOf("FAILURE"));
    expect(text).toContain(
      "Run nim-ultra-truncated failed at step audit-documentation: output limit (output-allowance-reached).",
    );
    const whyLine = lines.find((line) => line.trim().startsWith("Why: docsfab why "));
    expect(whyLine?.trim()).toBe(
      `Why: docsfab why nim-ultra-truncated --state-dir ${stateDirectory}`,
    );
    const args = whyLine!
      .trim()
      .replace(/^Why: docsfab why /u, "")
      .split(" ");
    const report = await whyJson(args);
    expect(report.diagnoses[0]?.findings[0]).toMatchObject({
      ownerClass: "output-limit",
      cause: "output-allowance-reached",
    });
  });

  it("replays a failed run with recurrence read from the index beside its state directory", async () => {
    const stateDirectory = await fixtureStateDirectory({ index: true });
    const record = failedRecord();
    await writeFile(join(stateDirectory, `${record.id}.json`), JSON.stringify(record));
    const text = await captureStdout(() =>
      handleRunsCommand(["show", record.id, "--state-dir", stateDirectory]),
    );
    const diagnosis = text.slice(text.indexOf("\nDIAGNOSIS"));
    expect(diagnosis).toContain(
      "Recurrence: 1 of the 1 most recent run of operator-configured-openai-compatible nvidia/nemotron-3-ultra-550b-a55b had this signature at audit-documentation",
    );
    expect(diagnosis).not.toContain("recurrence-index-unread");
  });

  it("ends docsfab run output with recurrence read from the index beside its state directory", async () => {
    const stateDirectory = await fixtureStateDirectory({ index: true });
    const record = failedRecord();
    const logs: string[] = [];
    const invocation: CliRunInvocation = {
      request: {
        workflow: "review-documentation",
        repositoryPath: "/tmp/example",
        revision: "HEAD",
        allowWrite: false,
        releaseGate: false,
        verbose: false,
        json: false,
        showScan: false,
        quiet: false,
      },
      config: {
        projectRoot: "/tmp/does-not-matter",
        skillCrateDirectory: "/tmp/does-not-matter/skill-crate",
        qualityDirectory: "/tmp/does-not-matter/quality",
        qualityPackDirectory: "/tmp/does-not-matter/quality-pack",
        stateDirectory,
        retryPolicy: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0, retryableCategories: [] },
        model: validModelConfig,
      },
      options: { quiet: false },
      output: { log: (message) => logs.push(message), error: () => undefined },
    };
    const workspace = {
      path: "/tmp/example-workspace",
      sourcePath: "/tmp/example",
      requestedRevision: "HEAD",
      revision: "a".repeat(40),
      dispose: async () => undefined,
    };
    await deliverCliRunResult(
      invocation,
      workspace,
      { workflow: getWorkflow("review-documentation") },
      { record, exitCode: 1 },
    );
    const text = logs.join("\n");
    const diagnosis = text.slice(text.indexOf("\nDIAGNOSIS"));
    expect(diagnosis).toContain(
      "Recurrence: 1 of the 1 most recent run of operator-configured-openai-compatible nvidia/nemotron-3-ultra-550b-a55b had this signature at audit-documentation",
    );
    expect(diagnosis).not.toContain("recurrence-index-unread");
  });

  it("keeps DIAGNOSIS out of a succeeded run", () => {
    const record = { ...failedRecord(), status: "succeeded" as const, steps: [] };
    const lines = formatRunSummary({
      record,
      recordPath: "/state/runs/nim-ultra-truncated.json",
      exitCode: 0,
      repositoryPath: "/tmp/example",
      tty: false,
    });
    expect(lines).not.toContain("DIAGNOSIS");
    expect(lines.join("\n")).not.toContain("docsfab why");
  });
});
