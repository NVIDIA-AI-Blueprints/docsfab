// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { testTimeoutMs } from "./helpers/test-timeouts.js";

import { parseRetryPolicy } from "../src/config/retry-policy.js";
import {
  decodeSuccessfulPublicationRunRecord,
  PublicationRunRecordDecodeError,
} from "../src/delivery/run-record.js";
import { sealQualityValidationBinding } from "../src/evaluation-report/quality-artifact-staging.js";
import { executeRunRequest } from "../src/cli/run-request.js";
import { handleEvaluateCommand } from "../src/cli/commands/evaluate.js";
import { handleRunsCommand } from "../src/cli/commands/runs.js";
import { handleShipCommand } from "../src/cli/commands/ship.js";
import {
  loadSavedRunEditorialDecodeOptions,
  loadSavedRunPublicationDecodeOptions,
  publishInvocationDecodeOptions,
} from "../src/cli/run/editorial-replay.js";
import {
  DeterministicLocalGitPublisher,
  ExecFileGitPublisherCommandRunner,
  ExecFileReadOnlyCommandRunner,
  loadVerifiedPublicationRun,
  runLocalUserPublishCli,
  type GitLabMergeRequest,
  type GitLabPublisherAdapter,
  type GitPublisherCommandResult,
  type GitPublisherCommandRunner,
  type ReadOnlyCommandResult,
  type ReadOnlyCommandRunner,
} from "../src/delivery/index.js";
import { observeReaderTaskContextAdmissionV1 } from "../src/execution/reader-task-admission.js";
import { createReaderTaskContextSupplier } from "../src/execution/task-context.js";
import { verifyQualityPackContext } from "../src/quality-pack/manifest.js";
import { decodeRunRecordEditorialEvidence } from "../src/workflow-contracts/outcome.js";
import { projectRunEditorialOutcome } from "../src/operator/run-result.js";
import { buildRunHumanNextCommand } from "../src/operator/run-summary.js";
import {
  createLiveAgentToolDefinitions,
  loadLiveAgentCapabilities,
} from "../src/live-agent/capabilities.js";
import { createLiveReaderTaskContextPreparer, runBoundedWorkflow } from "../src/live-agent/host.js";
import { LiveWorkflowDelivery } from "../src/live-agent/workflow-delivery.js";
import { shipSucceededWrite } from "../src/operator/delivery-orchestrator.js";
import { refusalCode, runOrbitCli } from "./helpers/orbit-cli-fixture.js";
import { DocumentationScope } from "../src/live-agent/documentation-scope.js";
import {
  canonicalSourceObligationProposal,
  validateSourceObligationProposal,
} from "../src/workflow-execution/source-obligation.js";
import { sourceObligationProposalFixture } from "./helpers/verification.js";
import { EditorialProtocolHarness } from "./helpers/editorial-protocol-harness.js";
import { runAuthoringQualityProducerFixture } from "./support/authoring-quality-runner.js";
import { runAuthoringUpdateQualityProducerFixture } from "./support/authoring-update-quality-runner.js";
import {
  git,
  orbitOptionChangeRepository,
  orbitReaderContextInput,
} from "./helpers/orbit-option-change-fixture.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  process.exitCode = undefined;
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("editorial runtime integration", () => {
  it.each([false, true])(
    "corrects UPDATE citations or refuses persistent ones (persistent=%s)",
    {
      timeout: testTimeoutMs(20_000),
    },
    async (persistent) => {
      const fixture = await repositoryFixture();
      const delegate = new EditorialProtocolHarness({
        candidate: "update",
        impactSource: fixture.impactSource,
      });
      fixture.config.retryPolicy = { ...parseRetryPolicy({}), baseDelayMs: 0, maxDelayMs: 0 };
      const attempts: Parameters<typeof delegate.runStep>[0][] = [];
      const proposalFor = (locator: string) => {
        const proposal = sourceObligationProposalFixture(locator);
        const dimension = proposal.dimensions[1]!;
        proposal.dimensions[1] = {
          ...dimension,
          status: "applicable",
          sourceLocators: [],
          obligations: [
            {
              dimension: dimension.dimension,
              sourceLocators: [locator],
              statement: "The public option is --new.",
              evidenceClass: "source-observation",
              uncertainty: "Read from source; the command was not executed.",
            },
          ],
        };
        return proposal;
      };
      const harness = {
        async runStep(input: Parameters<typeof delegate.runStep>[0]) {
          const result = await delegate.runStep(input);
          if (input.step.id !== "derive-source-obligations") return result;
          attempts.push(input);
          const sourceObligationProposal = validateSourceObligationProposal(
            proposalFor(
              persistent || attempts.length === 1
                ? "Users/example-user/checkout/missing.ts:1"
                : "src/orbit.ts:1",
            ),
          );
          return {
            ...result,
            sourceObligationProposal,
            summary: canonicalSourceObligationProposal(sourceObligationProposal),
          };
        },
      };
      const capabilities = await loadLiveAgentCapabilities(fixture.config);
      let record: Awaited<ReturnType<typeof runBoundedWorkflow>> | undefined;
      const definitions = createLiveAgentToolDefinitions({
        capabilities,
        allowWrite: false,
        prepareReaderTaskContext: createLiveReaderTaskContextPreparer({
          capabilities,
          repositoryPath: fixture.repository,
        }),
        async runWorkflow(workflow, instruction, onProgress, signal, readerTaskContext) {
          record = await runBoundedWorkflow({
            workflow,
            instruction,
            repositoryPath: fixture.repository,
            config: fixture.config,
            allowWrite: false,
            executionHarness: harness,
            readerTaskContext,
            onProgress,
            signal,
          });
          return record;
        },
      });
      const tool = definitions.find((entry) => entry.name === "docsfab_run_workflow")!;
      const output = await tool.execute(
        "update-citation-admission",
        {
          workflow: "update-documentation",
          instruction:
            "Update docs/cli.md for the changed public option; preserve unrelated content.",
          readerComparison: {
            kind: "base-head",
            baseRevision: fixture.base,
            headRevision: fixture.head,
          },
          readerSources: [
            { role: "public-contract", path: "src/orbit.ts" },
            { role: "current-documentation", path: "docs/cli.md" },
          ],
        },
        undefined,
        undefined,
        {} as never,
      );
      expect(JSON.stringify(output)).not.toContain("example-user");
      const derived = record!.steps.find((step) => step.id === "derive-source-obligations")!;
      expect(attempts.length, JSON.stringify(derived)).toBeGreaterThan(1);
      expect(attempts[1]?.responseCorrection).toMatchObject({
        rejection: { code: "source-locator-unobservable" },
      });
      expect(derived.inference?.attempts[0]).toMatchObject({
        outcome: "malformed-response",
        rejection: {
          code: "source-locator-unobservable",
          location: "$.dimensions[].sourceLocators[]",
        },
        rejectionSubject: { kind: "source-path", withheld: "not-host-known" },
      });
      expect(JSON.stringify(derived)).not.toContain("example-user");
      if (persistent) {
        expect(derived.status).toBe("failed");
        expect(JSON.stringify(output)).toContain("source-locator-unobservable");
        expect(JSON.stringify(output)).not.toContain("No safe failure detail");
        expect(attempts).toHaveLength(fixture.config.retryPolicy.maxRetries + 1);
        expect(
          derived.inference?.attempts.every((attempt) => attempt.outcome === "malformed-response"),
        ).toBe(true);
        expect(derived.summary).toBeUndefined();
        expect(delegate.stepIds).not.toContain("write-documentation");
      } else {
        expect(derived.status, JSON.stringify(record!.error)).toBe("succeeded");
        expect(attempts).toHaveLength(2);
        const ledger = JSON.parse(derived.summary!);
        expect(ledger.identity.sources.map((source: { path: string }) => source.path)).toEqual([
          "src/orbit.ts",
        ]);
        expect(ledger.dimensions).toMatchObject(proposalFor("src/orbit.ts:1").dimensions);
        expect(ledger.dimensions[1].obligations).toHaveLength(1);
        expect(record!.steps.find((step) => step.id === "write-documentation")?.status).toBe(
          "needs-input",
        );
      }
      expect(await readFile(join(fixture.repository, "docs/cli.md"), "utf8")).toContain("--old");
    },
  );

  it("passes a long MR handoff through the live tool and workflow runner without granting writes", {
    timeout: testTimeoutMs(20_000),
  }, async () => {
    const fixture = await repositoryFixture();
    const capabilities = await loadLiveAgentCapabilities(fixture.config);
    const harness = new EditorialProtocolHarness({
      candidate: "update",
      impactSource: fixture.impactSource,
    });
    const instruction = [
      "Update docs/cli.md for the changed public option in the reviewed MRs.",
      "Untrusted retrieved evidence: the option changed from --old to --new. ".repeat(160),
      "Preserve unrelated content. MR !2 has a withheld diff page; its impact remains unverified. Remain read-only.",
    ].join("\n");
    let record: Awaited<ReturnType<typeof runBoundedWorkflow>> | undefined;
    const definitions = createLiveAgentToolDefinitions({
      capabilities,
      allowWrite: false,
      prepareReaderTaskContext: createLiveReaderTaskContextPreparer({
        capabilities,
        repositoryPath: fixture.repository,
      }),
      async runWorkflow(workflow, receivedInstruction, onProgress, signal, readerTaskContext) {
        expect(receivedInstruction).toBe(instruction);
        record = await runBoundedWorkflow({
          workflow,
          instruction: receivedInstruction,
          repositoryPath: fixture.repository,
          config: fixture.config,
          allowWrite: false,
          executionHarness: harness,
          readerTaskContext,
          onProgress,
          signal,
        });
        return record;
      },
    });
    const tool = definitions.find((entry) => entry.name === "docsfab_run_workflow")!;
    await tool.execute(
      "long-mr-handoff",
      {
        workflow: "update-documentation",
        instruction,
        readerComparison: {
          kind: "base-head",
          baseRevision: fixture.base,
          headRevision: fixture.head,
        },
        readerSources: [
          { role: "public-contract", path: "src/orbit.ts" },
          { role: "current-documentation", path: "docs/cli.md" },
        ],
      },
      undefined,
      undefined,
      {} as never,
    );

    expect(record?.steps[0]?.status, JSON.stringify(record?.error)).toBe("succeeded");
    expect(record?.workflowBranchCoverage?.selection?.branchId).toBe("author");
    expect(record?.status).toBe("needs-input");
    expect(record?.steps[1]).toMatchObject({
      id: "derive-source-obligations",
      status: "succeeded",
    });
    expect(record?.steps[2]).toMatchObject({ id: "write-documentation", status: "needs-input" });
    expect(harness.stepIds).toEqual(["plan-documentation", "derive-source-obligations"]);
    expect(harness.inputs[0]?.instruction).toBe(instruction);
    expect(harness.inputs[0]?.readerContextInput?.reader_job.length).toBeLessThanOrEqual(1_024);
    expect(record?.changes).toBeUndefined();
    expect(await readFile(join(fixture.repository, "docs/cli.md"), "utf8")).toContain("--old");
  });

  it("routes a single-target V2 assessment directly to the admitted reader planner", async () => {
    const fixture = await repositoryFixture();
    const harness = new EditorialProtocolHarness({
      candidate: "no-change",
      impactSource: fixture.impactSource,
    });
    const record = await executeRunRequest(
      {
        workflow: "update-documentation",
        repositoryPath: fixture.repository,
        revision: fixture.head,
        instruction: "Assess whether docs/cli.md needs an update based on current behavior.",
        comparisonRequest: {
          kind: "base-head",
          baseRevision: fixture.base,
          headRevision: fixture.head,
        },
        // No public contract is nominated, so this commit comparison cannot
        // support the planner's no-change candidate and the run stops before
        // selection. The conservative context itself does not rule no-change
        // out.
        allowWrite: true,
        releaseGate: false,
        verbose: false,
        json: false,
        showScan: false,
      },
      fixture.config,
      { silent: true, harness },
    );

    expect(record?.status, JSON.stringify(record?.error)).toBe("needs-input");
    expect(harness.stepIds).toEqual(["plan-documentation"]);
    expect(harness.inputs[0]?.readerTaskContext).toMatchObject({
      kind: "docsfab-reader-task-context-input",
    });
    expect(record?.workflowBranchCoverage).toMatchObject({
      selection: null,
      requiredStepIds: ["plan-documentation"],
    });
    expect(record?.changes).toBeUndefined();

    const replayOutput: string[] = [];
    const log = console.log;
    console.log = (message?: unknown): void => {
      replayOutput.push(String(message));
    };
    try {
      await handleRunsCommand([
        "show",
        record!.id,
        "--json",
        "--state-dir",
        fixture.config.stateDirectory,
      ]);
    } finally {
      console.log = log;
    }
    expect(JSON.parse(replayOutput.at(-1) ?? "{}")).toMatchObject({
      execution: { status: "needs-input", patchPath: null },
      product: { disposition: "needs-input" },
    });
    const preselectionOptions = await loadSavedRunEditorialDecodeOptions(
      record!,
      fixture.config.stateDirectory,
    );
    expect(() =>
      decodeRunRecordEditorialEvidence(
        { ...structuredClone(record!), status: "succeeded" },
        {
          ...preselectionOptions,
        },
      ),
    ).toThrow();
  });

  it("retains an insufficient candidate when the CLI comparison is unknown", {
    timeout: testTimeoutMs(15_000),
  }, async () => {
    const fixture = await repositoryFixture();
    const harness = new EditorialProtocolHarness({
      candidate: "insufficient-evidence",
      impactSource: fixture.impactSource,
    });
    const output: string[] = [];
    const log = console.log;
    console.log = (message?: unknown): void => {
      output.push(String(message));
    };
    let record;
    try {
      record = await executeRunRequest(
        {
          workflow: "update-documentation",
          repositoryPath: fixture.repository,
          revision: fixture.head,
          instruction: "Assess docs/cli.md without an admitted comparison.",
          readerSources: [{ role: "public-contract", path: "src/orbit.ts" }],
          canonSnapshotPath: fixture.canonSnapshotPath,
          allowWrite: false,
          releaseGate: false,
          verbose: false,
          json: true,
          showScan: false,
        },
        fixture.config,
        { harness },
      );
    } finally {
      console.log = log;
    }

    expect(record?.status, JSON.stringify(record?.error)).toBe("needs-input");
    expect(harness.stepIds).toEqual(["plan-documentation"]);
    expect(record?.changes).toBeUndefined();
    expect(record?.workflowBranchCoverage).toMatchObject({
      selection: null,
      requiredStepIds: ["plan-documentation"],
    });
    expect(
      record?.artifacts?.filter((use) => use.reference.kind === "editorial-decision"),
    ).toHaveLength(1);
    expect(JSON.parse(output.at(-1) ?? "{}")).toMatchObject({
      execution: { status: "needs-input", patchPath: null },
      product: {
        disposition: "inconclusive",
        limitations: ["comparison-unavailable"],
      },
    });

    const replayOutput: string[] = [];
    console.log = (message?: unknown): void => {
      replayOutput.push(String(message));
    };
    try {
      await handleRunsCommand([
        "show",
        record!.id,
        "--json",
        "--state-dir",
        fixture.config.stateDirectory,
      ]);
    } finally {
      console.log = log;
    }
    expect(JSON.parse(replayOutput.at(-1) ?? "{}")).toMatchObject({
      execution: { status: "needs-input", patchPath: null },
      product: { disposition: "inconclusive", limitations: ["comparison-unavailable"] },
    });
  });

  it("retains the actual missing-source limitation when a comparison is admitted", {
    timeout: testTimeoutMs(15_000),
  }, async () => {
    const fixture = await repositoryFixture();
    const harness = new EditorialProtocolHarness({
      candidate: "insufficient-evidence",
      impactSource: fixture.impactSource,
      insufficientLimitation: "current-documentation-unavailable",
    });
    const record = await executeRunRequest(
      {
        workflow: "update-documentation",
        repositoryPath: fixture.repository,
        revision: fixture.head,
        instruction: "Assess docs/cli.md using the admitted revision comparison.",
        comparisonRequest: {
          kind: "base-head",
          baseRevision: fixture.base,
          headRevision: fixture.head,
        },
        readerSources: [{ role: "public-contract", path: "src/orbit.ts" }],
        canonSnapshotPath: fixture.canonSnapshotPath,
        allowWrite: false,
        releaseGate: false,
        verbose: false,
        json: false,
        showScan: false,
      },
      fixture.config,
      { silent: true, harness },
    );

    expect(record?.status, JSON.stringify(record?.error)).toBe("needs-input");
    expect(record?.workflowOutcome).toMatchObject({
      disposition: "inconclusive",
      limitations: ["current-documentation-unavailable"],
      openDecisions: [],
    });
    expect(record?.workflowOutcome?.findings).toEqual([
      expect.objectContaining({
        kind: "evidence-limitation",
        code: "current-documentation-unavailable",
      }),
    ]);
  });

  it("executes verified no-change without granting a write step", {
    timeout: testTimeoutMs(20_000),
  }, async () => {
    const fixture = await repositoryFixture();
    const harness = new EditorialProtocolHarness({
      candidate: "no-change",
      impactSource: fixture.impactSource,
    });

    const record = await executeRunRequest(
      {
        workflow: "update-documentation",
        repositoryPath: fixture.repository,
        revision: fixture.head,
        instruction: "Assess whether docs/cli.md needs an update for the changed option source.",
        readerTaskContext: fixture.handoff,
        allowWrite: false,
        releaseGate: false,
        verbose: false,
        json: false,
        showScan: false,
      },
      fixture.config,
      { silent: true, harness },
    );

    expect(record?.status, JSON.stringify(record?.error)).toBe("succeeded");
    expect(harness.stepIds).toEqual([
      "plan-documentation",
      "verify-technical-accuracy",
      "review-documentation",
      "test-audience-understanding",
      "evaluate-document-quality",
    ]);
    expect(harness.inputs.every((input) => input.readerTaskContext !== undefined)).toBe(true);
    expect(harness.inputs[0]?.editorialEvidenceRefs).toHaveLength(1);
    for (const input of harness.inputs.slice(1)) {
      expect(input.editorialEvidenceRefs).toHaveLength(2);
      expect(input.readerTaskContext).toMatchObject({
        kind: "docsfab-reader-task-context-completed",
        readerContext: { impact_basis: { kind: "none" } },
      });
      expect(input.editorialCandidate).toMatchObject({
        proposal: {
          candidate: "no-change",
          rationale: "The admitted source comparison preserves the documented public behavior.",
        },
      });
    }
    expect(record?.changes).toBeUndefined();
    expect(record?.workflowBranchCoverage).toMatchObject({
      selection: { branchId: "assess-no-change" },
      excludedStepIds: ["derive-source-obligations", "write-documentation", "lint-documentation"],
    });
    expect(
      record?.artifacts?.filter(
        (use) => use.role === "output" && use.reference.kind === "editorial-decision",
      ),
    ).toHaveLength(2);

    const replayOutput: string[] = [];
    const log = console.log;
    console.log = (message?: unknown): void => {
      replayOutput.push(String(message));
    };
    try {
      await handleRunsCommand([
        "show",
        record!.id,
        "--json",
        "--state-dir",
        fixture.config.stateDirectory,
      ]);
    } finally {
      console.log = log;
    }
    expect(JSON.parse(replayOutput.at(-1) ?? "{}")).toMatchObject({
      execution: { status: "succeeded", patchPath: null },
      product: { disposition: "inconclusive" },
    });
    // The host decides the audience assessment, so the reply's
    // `audience-check-unavailable` is not kept: the outcome carries only the
    // standing authoring codes. The run verified that no change is needed, so
    // NEXT says so and names the basis, with no recorded limitation left.
    expect(record?.workflowOutcome?.findings.map((finding) => finding.code).sort()).toEqual([
      "experimental-quality-profile",
      "insufficient-evidence",
    ]);
    expect(
      buildRunHumanNextCommand({
        record: record!,
        recordPath: join(fixture.config.stateDirectory, `${record!.id}.json`),
        exitCode: 0,
        editorialDecodeOptions: await loadSavedRunEditorialDecodeOptions(
          record!,
          fixture.config.stateDirectory,
        ),
      })?.reason,
    ).toBe(
      "No documentation change needed; review the kept pages if you disagree: docs/cli.md. Basis: base and head commit comparison.",
    );

    const evaluationFixturePath = join(dirname(fixture.config.stateDirectory), "evaluation.json");
    await writeFile(
      evaluationFixturePath,
      JSON.stringify({
        version: 1,
        name: "cold editorial replay",
        assertions: [{ type: "status", equals: "succeeded" }],
      }),
    );
    const evaluationOutput: string[] = [];
    console.log = (message?: unknown): void => {
      evaluationOutput.push(String(message));
    };
    try {
      await handleEvaluateCommand([
        "--fixture",
        evaluationFixturePath,
        "--record",
        join(fixture.config.stateDirectory, `${record!.id}.json`),
      ]);
    } finally {
      console.log = log;
    }
    expect(evaluationOutput[0]).toContain("Evaluation: cold editorial replay");
    expect(evaluationOutput[0]).toContain("Verdict: PASS");
  });

  it("admits a single-page author branch without a snapshot and captures its patch", {
    timeout: testTimeoutMs(20_000),
  }, async () => {
    const fixture = await repositoryFixture();
    const harness = new EditorialProtocolHarness({
      candidate: "update",
      impactSource: fixture.impactSource,
    });

    const record = await executeRunRequest(
      {
        workflow: "update-documentation",
        repositoryPath: fixture.repository,
        revision: fixture.head,
        instruction: "Update docs/cli.md for the changed public option.",
        readerTaskContext: fixture.handoff,
        allowWrite: true,
        releaseGate: false,
        verbose: false,
        json: false,
        showScan: false,
      },
      fixture.config,
      { silent: true, harness },
    );

    expect(record?.status, JSON.stringify(record?.error)).toBe("succeeded");
    expect(harness.stepIds).toEqual([
      "plan-documentation",
      "derive-source-obligations",
      "write-documentation",
      "verify-technical-accuracy",
      "review-documentation",
      "test-audience-understanding",
      "evaluate-document-quality",
    ]);
    expect(record?.workflowBranchCoverage).toMatchObject({
      selection: { branchId: "author" },
      excludedStepIds: [],
    });
    expect(record?.workflowOutcome?.disposition).toBe("inconclusive");
    expect(record?.workflowOutcome?.findings).toContainEqual(
      expect.objectContaining({
        kind: "evidence-limitation",
        severity: "warning",
        code: "experimental-quality-profile",
      }),
    );
    expect(record?.changes?.files).toEqual([{ path: "docs/cli.md", status: "modified" }]);
    const patch = await readFile(record!.changes!.patch!.artifactPath, "utf8");
    expect(patch).toContain("The public option is now --new.");
    expect(await git(fixture.repository, "status", "--short")).toBe("");
    expect(await readFile(join(fixture.repository, "docs/cli.md"), "utf8")).toContain("--old");
    expect(record?.qualityArtifactValidation?.status).toBe("passed");
    const decodeOptions = await loadSavedRunEditorialDecodeOptions(
      record!,
      fixture.config.stateDirectory,
    );
    expect(decodeSuccessfulPublicationRunRecord(record!, decodeOptions)).toEqual(record);
    const qualityBinding = record!.qualityArtifactValidation!;
    const {
      schemaVersion: _schemaVersion,
      kind: _kind,
      bindingSha256: _bindingSha256,
      ...body
    } = qualityBinding;
    for (const mutated of [
      {
        ...record!,
        qualityProfileSelection: {
          ...record!.qualityProfileSelection!,
          selectionSha256: "0".repeat(64),
        },
      },
      {
        ...record!,
        qualityArtifactValidation: sealQualityValidationBinding({
          ...body,
          runId: "other-run",
        }),
      },
      {
        ...record!,
        qualityArtifactValidation: sealQualityValidationBinding({
          ...body,
          evaluatedCandidate: { ...body.evaluatedCandidate!, patchSha256: "0".repeat(64) },
        }),
      },
    ]) {
      expect(() => decodeSuccessfulPublicationRunRecord(mutated, decodeOptions)).toThrow(
        PublicationRunRecordDecodeError,
      );
    }
    // Host-declined quality remains explicit advisory evidence: its selected
    // profile must still be legal, but the saved authored patch stays usable.
    const advisory = { ...record!, qualityArtifactValidation: undefined };
    expect(decodeSuccessfulPublicationRunRecord(advisory, decodeOptions)).toEqual(advisory);
    const delivery = new LiveWorkflowDelivery({
      repositoryPath: fixture.repository,
      stateDirectory: fixture.config.stateDirectory,
      allowWrite: true,
      documentationScope: new DocumentationScope(),
      confirmPublication: async () => false,
    });
    const persisted = await delivery.persist(record!);
    expect(persisted, JSON.stringify(persisted)).toEqual({ status: "applied" });
    expect(await readFile(join(fixture.repository, "docs/cli.md"), "utf8")).toContain("--new");
    expect(await delivery.persist(record!)).toEqual({ status: "already-applied" });
  });

  it.each(["create", "update"] as const)(
    "applies the actual %s patch when the quality host declines its report",
    { timeout: testTimeoutMs(30_000) },
    async (workflow) => {
      const root = await mkdtemp(join(tmpdir(), "docsfab-declined-quality-delivery-"));
      temporaryDirectories.push(root);
      const fixture =
        workflow === "create"
          ? await runAuthoringQualityProducerFixture(root, {
              declineQuality: true,
              deliveryReady: true,
            })
          : await runAuthoringUpdateQualityProducerFixture(root, "update", {
              declineQuality: true,
            });
      const { record } = fixture;
      expect(record.status, JSON.stringify(record.error)).toBe("succeeded");
      expect(record.qualityProfileSelection).toBeDefined();
      expect(record.qualityArtifactValidation).toBeUndefined();
      const evaluator = record.steps.at(-1)!;
      expect(evaluator.qualityValidationRejection).toMatchObject({
        validator: "report-finalization",
        code: "report-limitation-section-count",
      });
      const options = await loadSavedRunEditorialDecodeOptions(record, fixture.stateDirectory);
      expect(decodeSuccessfulPublicationRunRecord(record, options)).toEqual(record);
      for (const rejection of [
        null,
        { ...evaluator.qualityValidationRejection, validator: "unknown-check" },
        { ...evaluator.qualityValidationRejection, code: "unknown-quality-code" },
        { ...evaluator.qualityValidationRejection, extra: "not-a-contract-field" },
      ]) {
        const mutated = structuredClone(record);
        mutated.steps.at(-1)!.qualityValidationRejection = rejection as never;
        expect(() => decodeSuccessfulPublicationRunRecord(mutated, options)).toThrow(
          PublicationRunRecordDecodeError,
        );
      }
      const misplaced = structuredClone(record);
      misplaced.steps[0]!.qualityValidationRejection = evaluator.qualityValidationRejection;
      expect(() => decodeSuccessfulPublicationRunRecord(misplaced, options)).toThrow(
        PublicationRunRecordDecodeError,
      );
      const delivery = new LiveWorkflowDelivery({
        repositoryPath: fixture.sourcePath,
        stateDirectory: fixture.stateDirectory,
        allowWrite: true,
        documentationScope: new DocumentationScope(),
        confirmPublication: async () => false,
      });
      const persisted = await delivery.persist(record);
      expect(persisted, JSON.stringify(persisted)).toEqual({ status: "applied" });
      expect(await delivery.persist(record)).toEqual({ status: "already-applied" });
      const target = workflow === "create" ? "docs/cli-reference.md" : "docs/cli.md";
      expect(await readFile(join(fixture.sourcePath, target), "utf8")).toContain(
        workflow === "create" ? "hello command prints a greeting" : "public option is now --new",
      );
    },
  );

  it("loads a saved update run for publication only with the options its record needs (#2366)", {
    timeout: testTimeoutMs(60_000),
  }, async () => {
    const { fixture, record } = await savedUpdateRun();
    expect(record.workflowBranchCoverage).toBeDefined();
    const recordPath = join(fixture.config.stateDirectory, `${record.id}.json`);
    // What `docsfab publish` and `docsfab ship` read before #2366: no options.
    await expect(loadVerifiedPublicationRun(recordPath, record.id)).rejects.toMatchObject({
      code: "run-record-contract-gap",
    });
    const options = await loadSavedRunPublicationDecodeOptions(
      fixture.config.stateDirectory,
      record.id,
    );
    expect(options?.decodeWorkflowBranchCoverage).toBeTypeOf("function");
    const run = await loadVerifiedPublicationRun(recordPath, record.id, options);
    expect(run.id).toBe(record.id);
    expect(run.changedFiles).toEqual([{ path: "docs/cli.md", status: "modified" }]);
    // `docsfab publish <run-id> --state-dir <dir>` derives the same options.
    const published = await publishInvocationDecodeOptions(
      [record.id, "--draft-mr", "--state-dir", fixture.config.stateDirectory],
      join(fixture.config.stateDirectory, "not-this-one"),
    );
    expect(published?.decodeWorkflowBranchCoverage).toBeTypeOf("function");
    // `docsfab ship --dry-run` reads the record with those options in its own
    // load and again in its real preflight, and plans the draft MR. Before #2366
    // it stopped at run-record-contract-gap; a dry run that lost the options only
    // in its preflight would stop there.
    const logs: string[] = [];
    await handleShipCommand([record.id, "--repo", fixture.repository, "--dry-run"], {
      cwd: fixture.repository,
      stateDirectory: fixture.config.stateDirectory,
      log: (message) => logs.push(message),
      commands: new OrbitGitLabCommands(fixture.head),
    });
    expect(logs).toEqual([
      `Ship dry run: succeeded write ${record.id} has 1 publishable documentation file; would open a draft merge request to main.`,
    ]);
  });

  it("ships a saved update run end to end through the ship path (#2366)", {
    timeout: testTimeoutMs(60_000),
  }, async () => {
    const { fixture, record } = await savedUpdateRun();
    const delivery = orbitDelivery(fixture);
    await handleShipCommand([record.id, "--repo", fixture.repository], {
      cwd: fixture.repository,
      stateDirectory: fixture.config.stateDirectory,
      log: delivery.dependencies.log,
      commands: delivery.glab,
      executeDependencies: delivery.dependencies,
    });
    await expectDraftDelivered(fixture, delivery);
  });

  it("publishes a live agent's saved update run with the options its record needs (#2366)", {
    timeout: testTimeoutMs(60_000),
  }, async () => {
    const { fixture, record } = await savedUpdateRun();
    let reachedPreflight = false;
    const delivery = new LiveWorkflowDelivery({
      repositoryPath: fixture.repository,
      stateDirectory: fixture.config.stateDirectory,
      allowWrite: true,
      documentationScope: new DocumentationScope(),
      confirmPublication: async () => true,
      // The real ship path, stopped at its preflight: before #2366 it refused
      // the record with run-record-contract-gap before getting there.
      ship: (input, dependencies) =>
        shipSucceededWrite(input, {
          ...dependencies,
          preflight: async () => {
            reachedPreflight = true;
            throw new Error("stop at preflight");
          },
        }),
    });
    await expect(
      delivery
        .publicationTool()
        .execute("call-1", { runId: record.id }, undefined, undefined, {} as never),
    ).rejects.toThrow();
    expect(reachedPreflight).toBe(true);
  });

  it("plans docsfab publish <run> through the CLI entry point with the options its record needs (#2366)", {
    timeout: testTimeoutMs(60_000),
  }, async () => {
    const { fixture, record } = await savedUpdateRun();
    // The router derives the options before it calls the publish CLI; the
    // preflight can plan the run only if they reach it.
    const output = await runOrbitCli(fixture, [
      "publish",
      record.id,
      "--repo",
      fixture.repository,
      "--draft-mr",
      "--preflight",
    ]);
    expect(JSON.parse(output.at(-1) ?? "null")).toMatchObject({
      run: { id: record.id },
      targetBranch: { name: "main" },
      mergeRequest: { draft: true },
    });
  });

  it("publishes a saved update run to its draft MR through the one-shot publish route (#2366)", {
    timeout: testTimeoutMs(60_000),
  }, async () => {
    const { fixture, record } = await savedUpdateRun();
    const delivery = orbitDelivery(fixture);
    const args = [record.id, "--repo", fixture.repository, "--draft-mr"];
    // The router derives these from the saved record before it calls the publish CLI.
    const editorialDecodeOptions = await publishInvocationDecodeOptions(
      args,
      fixture.config.stateDirectory,
    );
    expect(editorialDecodeOptions?.decodeWorkflowBranchCoverage).toBeTypeOf("function");
    await runLocalUserPublishCli(args, {
      ...delivery.dependencies,
      stderr: () => undefined,
      ...(editorialDecodeOptions ? { editorialDecodeOptions } : {}),
    });
    await expectDraftDelivered(fixture, delivery);
  });

  it("refuses a saved update run with its editorial evidence gone using the catalog code (#2366)", {
    timeout: testTimeoutMs(60_000),
  }, async () => {
    const { fixture, record } = await savedUpdateRun();
    const stateDirectory = fixture.config.stateDirectory;
    // Positive control: with the evidence store in place the helper derives options.
    expect(
      (await loadSavedRunPublicationDecodeOptions(stateDirectory, record.id))
        ?.decodeWorkflowBranchCoverage,
    ).toBeTypeOf("function");
    // The run's editorial decisions live in the host artifact store beside the run store.
    await rm(join(dirname(stateDirectory), "artifacts"), { recursive: true, force: true });
    // The helpers then derive no options and leave the refusal to the publication path.
    await expect(
      loadSavedRunPublicationDecodeOptions(stateDirectory, record.id),
    ).resolves.toBeUndefined();
    await expect(
      publishInvocationDecodeOptions(
        [record.id, "--draft-mr", "--state-dir", stateDirectory],
        join(stateDirectory, "not-this-one"),
      ),
    ).resolves.toBeUndefined();
    // That refusal is the catalog's code, not an uncoded operator error.
    const glab = new OrbitGitLabCommands(fixture.head);
    const ship = (flags: readonly string[]) =>
      handleShipCommand([record.id, "--repo", fixture.repository, ...flags], {
        cwd: fixture.repository,
        stateDirectory,
        log: () => undefined,
        commands: glab,
      });
    expect(await refusalCode(() => ship(["--dry-run"]))).toBe("run-record-contract-gap");
    expect(await refusalCode(() => ship([]))).toBe("run-record-contract-gap");
    expect(
      await refusalCode(() =>
        runOrbitCli(fixture, [
          "publish",
          record.id,
          "--repo",
          fixture.repository,
          "--draft-mr",
          "--preflight",
        ]),
      ),
    ).toBe("run-record-contract-gap");
  });

  it("keeps an executed update when the audience step rejects it for a protocol no run supplies", {
    timeout: testTimeoutMs(20_000),
  }, async () => {
    const fixture = await repositoryFixture();
    const harness = new EditorialProtocolHarness({
      candidate: "update",
      impactSource: fixture.impactSource,
      audienceRejectsForMissingPrerequisites: true,
    });

    const record = await executeRunRequest(
      {
        workflow: "update-documentation",
        repositoryPath: fixture.repository,
        revision: fixture.head,
        instruction: "Update docs/cli.md for the changed public option.",
        readerTaskContext: fixture.handoff,
        allowWrite: true,
        releaseGate: false,
        verbose: false,
        json: false,
        showScan: false,
      },
      fixture.config,
      { silent: true, harness },
    );

    expect(record?.status, JSON.stringify(record?.error)).toBe("succeeded");
    expect(record?.changes?.files).toEqual([{ path: "docs/cli.md", status: "modified" }]);
    const replayOptions = await loadSavedRunEditorialDecodeOptions(
      record!,
      fixture.config.stateDirectory,
    );
    expect(projectRunEditorialOutcome(record!, replayOptions)).toMatchObject({
      state: "validated",
      outcome: "executed-update",
      decision: "update",
      limitations: [],
    });
    // The missing audience protocol stays on the product outcome, bound to the
    // audience step, as a standing limitation rather than a wall.
    expect(record?.workflowOutcome?.disposition).toBe("inconclusive");
    expect(record?.workflowOutcome?.findings.map((finding) => finding.code).sort()).toEqual([
      "experimental-quality-profile",
      "insufficient-evidence",
    ]);
    expect(
      record?.workflowOutcome?.findings.find((finding) => finding.code === "insufficient-evidence")
        ?.evidenceIds,
    ).toEqual(["step:test-audience-understanding"]);
  });

  it("refuses the r3 evaluator's snake_case limitations before the outcome admission (#1268)", {
    timeout: testTimeoutMs(20_000),
  }, async () => {
    const fixture = await repositoryFixture();
    const harness = new EditorialProtocolHarness({
      candidate: "update",
      impactSource: fixture.impactSource,
      evaluatorLimitations: [
        "comparison_unknown",
        "no_audience_evidence",
        "no_runtime_observation",
      ],
    });

    const record = await executeRunRequest(
      {
        workflow: "update-documentation",
        repositoryPath: fixture.repository,
        revision: fixture.head,
        instruction: "Update docs/cli.md for the changed public option.",
        readerTaskContext: fixture.handoff,
        allowWrite: true,
        releaseGate: false,
        verbose: false,
        json: false,
        showScan: false,
      },
      fixture.config,
      { silent: true, harness },
    );

    expect(record?.status).toBe("failed");
    // The evaluator's assessment is refused at its own step, so nothing reaches
    // the outcome admission.
    expect(record?.workflowOutcome).toBeUndefined();
    expect(record?.workflowOutcomeRejection).toBeUndefined();
    expect(record?.failure?.code).not.toMatch(/^workflow-outcome-/u);
    expect(record?.steps.map((step) => [step.id, step.status])).toEqual([
      ["plan-documentation", "succeeded"],
      ["derive-source-obligations", "succeeded"],
      ["write-documentation", "succeeded"],
      ["lint-documentation", "succeeded"],
      ["verify-technical-accuracy", "succeeded"],
      ["review-documentation", "succeeded"],
      ["test-audience-understanding", "succeeded"],
      ["evaluate-document-quality", "failed"],
    ]);
  });

  it("projects an actual rejected author assessment as a retained product gap", {
    timeout: testTimeoutMs(15_000),
  }, async () => {
    const fixture = await repositoryFixture();
    const harness = new EditorialProtocolHarness({
      candidate: "update",
      impactSource: fixture.impactSource,
      rejectedAssessmentStep: "review-documentation",
      rejectedRecommendation: "update",
    });
    const record = await executeRunRequest(
      {
        workflow: "update-documentation",
        repositoryPath: fixture.repository,
        revision: fixture.head,
        instruction: "Update docs/cli.md for the changed public option.",
        readerTaskContext: fixture.handoff,
        canonSnapshotPath: fixture.canonSnapshotPath,
        allowWrite: true,
        releaseGate: false,
        verbose: false,
        json: false,
        showScan: false,
      },
      fixture.config,
      { silent: true, harness },
    );

    expect(record?.status, JSON.stringify(record?.error)).toBe("succeeded");
    expect(record?.changes?.files).toEqual([{ path: "docs/cli.md", status: "modified" }]);
    expect(record?.workflowOutcome).toMatchObject({
      disposition: "not-ready",
      findings: [
        expect.objectContaining({
          kind: "product-gap",
          code: "product-gap.public-option-documentation-mismatch",
        }),
      ],
    });
    const replayOptions = await loadSavedRunEditorialDecodeOptions(
      record!,
      fixture.config.stateDirectory,
    );
    expect(decodeRunRecordEditorialEvidence(record!, replayOptions)).toMatchObject({
      state: "current",
      candidate: { candidate: "update" },
      validated: {
        candidate: "update",
        limitations: ["product-gap.public-option-documentation-mismatch"],
      },
    });
  });

  it("retains a rejected no-change candidate as an insufficient final assessment", {
    timeout: testTimeoutMs(15_000),
  }, async () => {
    const fixture = await repositoryFixture();
    const harness = new EditorialProtocolHarness({
      candidate: "no-change",
      impactSource: fixture.impactSource,
      rejectedAssessmentStep: "review-documentation",
    });

    const record = await executeRunRequest(
      {
        workflow: "update-documentation",
        repositoryPath: fixture.repository,
        revision: fixture.head,
        instruction: "Assess whether docs/cli.md needs an update for the changed option source.",
        readerTaskContext: fixture.handoff,
        allowWrite: false,
        releaseGate: false,
        verbose: false,
        json: false,
        showScan: false,
      },
      fixture.config,
      { silent: true, harness },
    );

    expect(record?.status, JSON.stringify(record?.error)).toBe("succeeded");
    expect(record?.changes).toBeUndefined();
    expect(record?.workflowBranchCoverage?.selection?.branchId).toBe("assess-no-change");
    const decodeOptions = await loadSavedRunEditorialDecodeOptions(
      record!,
      fixture.config.stateDirectory,
    );
    const editorial = decodeRunRecordEditorialEvidence(record!, decodeOptions);
    expect(editorial).toMatchObject({
      state: "current",
      candidate: { candidate: "no-change" },
      validated: {
        candidate: "insufficient-evidence",
        limitations: ["evidence-limitation.independent-assessment-rejected"],
      },
    });
    expect(record?.workflowOutcome).toMatchObject({
      disposition: "inconclusive",
      limitations: ["evidence-limitation.independent-assessment-rejected"],
    });
    // A request-caused editorial limitation on an authoring job keeps the
    // capability-wall NEXT.
    expect(
      buildRunHumanNextCommand({
        record: record!,
        recordPath: join(fixture.config.stateDirectory, `${record!.id}.json`),
        exitCode: 0,
        editorialDecodeOptions: decodeOptions,
      })?.reason,
    ).toBe(
      "Product inconclusive at a wall: evidence-limitation evidence-limitation.independent-assessment-rejected (the admitted evidence cannot support a complete result). This is a capability or policy wall, not missing input. Change the request instead: narrow or retarget it, wait for the capability, or accept the outcome as incomplete. Do not retry the unchanged request.",
    );
  });

  it("projects a retained independent product gap without changing the selected no-change path", {
    timeout: testTimeoutMs(15_000),
  }, async () => {
    const fixture = await repositoryFixture();
    const harness = new EditorialProtocolHarness({
      candidate: "no-change",
      impactSource: fixture.impactSource,
      rejectedAssessmentStep: "review-documentation",
      rejectedRecommendation: "update",
    });
    const record = await executeRunRequest(
      {
        workflow: "update-documentation",
        repositoryPath: fixture.repository,
        revision: fixture.head,
        instruction: "Assess whether docs/cli.md needs an update for the changed option source.",
        readerTaskContext: fixture.handoff,
        allowWrite: false,
        releaseGate: false,
        verbose: false,
        json: false,
        showScan: false,
      },
      fixture.config,
      { silent: true, harness },
    );

    expect(record?.status, JSON.stringify(record?.error)).toBe("succeeded");
    expect(record?.changes).toBeUndefined();
    expect(record?.workflowBranchCoverage?.selection?.branchId).toBe("assess-no-change");
    const decodeOptions = await loadSavedRunEditorialDecodeOptions(
      record!,
      fixture.config.stateDirectory,
    );
    expect(decodeRunRecordEditorialEvidence(record!, decodeOptions)).toMatchObject({
      state: "current",
      candidate: { candidate: "no-change" },
      validated: {
        candidate: "update",
        limitations: ["product-gap.public-option-documentation-mismatch"],
      },
    });
    expect(record?.workflowOutcome).toMatchObject({
      disposition: "not-ready",
      findings: [
        expect.objectContaining({
          kind: "product-gap",
          severity: "blocking",
          code: "product-gap.public-option-documentation-mismatch",
        }),
      ],
    });

    const replayOutput: string[] = [];
    const log = console.log;
    console.log = (message?: unknown): void => {
      replayOutput.push(String(message));
    };
    try {
      await handleRunsCommand([
        "show",
        record!.id,
        "--json",
        "--state-dir",
        fixture.config.stateDirectory,
      ]);
    } finally {
      console.log = log;
    }
    expect(JSON.parse(replayOutput.at(-1) ?? "{}")).toMatchObject({
      execution: { status: "succeeded", patchPath: null },
      product: { disposition: "not-ready" },
    });
  });

  it("retains selected author coverage while waiting for a write grant", {
    timeout: testTimeoutMs(15_000),
  }, async () => {
    const fixture = await repositoryFixture();
    const harness = new EditorialProtocolHarness({
      candidate: "update",
      impactSource: fixture.impactSource,
    });

    const record = await executeRunRequest(
      {
        workflow: "update-documentation",
        repositoryPath: fixture.repository,
        revision: fixture.head,
        instruction: "Update docs/cli.md for the changed public option.",
        readerTaskContext: fixture.handoff,
        canonSnapshotPath: fixture.canonSnapshotPath,
        allowWrite: false,
        releaseGate: false,
        verbose: false,
        json: false,
        showScan: false,
      },
      fixture.config,
      { silent: true, harness },
    );

    expect(record?.status, JSON.stringify(record?.error)).toBe("needs-input");
    expect(harness.stepIds).toEqual(["plan-documentation", "derive-source-obligations"]);
    expect(record?.changes).toBeUndefined();
    expect(record?.workflowBranchCoverage).toMatchObject({
      selection: { branchId: "author" },
      requiredStepIds: [
        "plan-documentation",
        "derive-source-obligations",
        "write-documentation",
        "lint-documentation",
        "verify-technical-accuracy",
        "review-documentation",
        "test-audience-understanding",
        "evaluate-document-quality",
      ],
    });
    expect(record?.steps[1]).toMatchObject({
      id: "derive-source-obligations",
      status: "succeeded",
    });
    expect(record?.steps[2]).toMatchObject({
      id: "write-documentation",
      status: "needs-input",
    });
    expect(record?.steps.slice(3).every((step) => step.status === "pending")).toBe(true);

    const replayOutput: string[] = [];
    const log = console.log;
    console.log = (message?: unknown): void => {
      replayOutput.push(String(message));
    };
    try {
      await handleRunsCommand([
        "show",
        record!.id,
        "--json",
        "--state-dir",
        fixture.config.stateDirectory,
      ]);
    } finally {
      console.log = log;
    }
    expect(JSON.parse(replayOutput.at(-1) ?? "{}")).toMatchObject({
      execution: { status: "needs-input", patchPath: null },
      product: { disposition: "needs-input" },
    });
  });
});

async function repositoryFixture() {
  const fixture = await orbitOptionChangeRepository(
    "docsfab-editorial-runtime",
    temporaryDirectories,
  );
  const { repository, base, head, config } = fixture;
  const verifiedPack = await verifyQualityPackContext({
    skillCrateDirectory: config.skillCrateDirectory,
    qualityDirectory: config.qualityDirectory,
    qualityPackDirectory: config.qualityPackDirectory,
  });
  const supplier = await createReaderTaskContextSupplier(verifiedPack);
  const readerContextInput = orbitReaderContextInput();
  const observation = await observeReaderTaskContextAdmissionV1({
    repositoryPath: repository,
    revision: head,
    observationMode: "workflow-export",
    readerContextInput,
    comparisonRequest: { kind: "base-head", baseRevision: base, headRevision: head },
    sourceHints: [{ role: "public-contract", path: "src/orbit.ts" }],
  });
  const publicContract = observation.admission.sources.find(
    (source) => source.role === "public-contract",
  );
  if (!publicContract) throw new Error("fixture public contract was not admitted");
  return {
    ...fixture,
    impactSource: { uri: publicContract.uri, sha256: publicContract.sha256 },
    handoff: supplier.createHandoff({
      readerContextInput,
      admission: observation.admission,
      inputOrigin: "explicit",
      sourceBinding: observation.sourceBinding,
    }),
  };
}

/**
 * GitLab for the Orbit fixture's `origin` remote, as the publication preflight
 * reads it. Git runs for real; only the GitLab API answers are fixed.
 */
class OrbitGitLabCommands implements ReadOnlyCommandRunner {
  private readonly git = new ExecFileReadOnlyCommandRunner();

  public constructor(private readonly targetRevision: string) {}

  public async run(
    command: "git" | "glab" | "gh",
    args: readonly string[],
    cwd: string,
    options?: { env?: NodeJS.ProcessEnv },
  ): Promise<ReadOnlyCommandResult> {
    if (command === "gh") throw new Error("GitLab fixture does not support gh.");
    if (command === "git") return this.git.run(command, args, cwd, options);
    const key = args.join(" ");
    const host = "gitlab.example.invalid";
    const json = (value: unknown): ReadOnlyCommandResult => ({
      exitCode: 0,
      stdout: `${JSON.stringify(value)}\n`,
    });
    if (key === "version") return { exitCode: 0, stdout: "glab 1.0\n" };
    if (key === `auth status --hostname ${host}`) return { exitCode: 0, stdout: "" };
    if (key === `config get token --host ${host}`) return { exitCode: 0, stdout: "" };
    if (key === `api --hostname ${host} user`) {
      return json({
        username: "maintainer",
        name: "Maintainer",
        email: "maintainer@example.invalid",
      });
    }
    if (args[0] === "api" && args[3] === "graphql") {
      return json({ data: { project: { id: "gid://gitlab/Project/7", fullPath: "docs/orbit" } } });
    }
    if (key === `api --hostname ${host} projects/7`) {
      return json({
        id: 7,
        path_with_namespace: "docs/orbit",
        default_branch: "main",
        permissions: { project_access: { access_level: 40 }, group_access: null },
      });
    }
    if (key === `api --hostname ${host} projects/7/repository/branches/main`) {
      return json({ name: "main", protected: true, commit: { id: this.targetRevision } });
    }
    if (key.startsWith(`api --hostname ${host} projects/7/protected_branches?per_page=100`)) {
      return json([{ name: "main" }]);
    }
    return { exitCode: 1, stdout: "", stderr: "" };
  }
}

/**
 * The publication remote for the real host Git publisher: every Git command
 * runs for real except `ls-remote` and `push`, which this records.
 */
class SimulatedRemoteGit implements GitPublisherCommandRunner {
  private readonly git = new ExecFileGitPublisherCommandRunner();
  public readonly branches = new Map<string, string>();

  public async run(
    command: "git",
    args: readonly string[],
    cwd: string,
    options: Parameters<GitPublisherCommandRunner["run"]>[3],
  ): Promise<GitPublisherCommandResult> {
    let index = 0;
    while (args[index] === "-c") index += 2;
    const call = args.slice(index);
    if (call[0] === "ls-remote") {
      const ref = call.at(-1)!;
      const sha = this.branches.get(ref);
      return { exitCode: 0, stdout: Buffer.from(sha ? `${sha}\t${ref}\n` : "") };
    }
    if (call[0] === "push") {
      const [sha, ref] = call.at(-1)!.split(":");
      this.branches.set(ref!, sha!);
      return { exitCode: 0, stdout: Buffer.from("") };
    }
    return this.git.run(command, args, cwd, options);
  }
}

/** GitLab's publication side for the Orbit fixture project. */
function orbitGitLabPublisher(requests: GitLabMergeRequest[]): GitLabPublisherAdapter {
  return {
    inspectPolicy: async (plan) => ({
      username: "maintainer",
      projectId: plan.project.id,
      projectPath: plan.project.path,
      accessLevel: 40,
      defaultBranch: "main",
      targetBranch: { name: "main", protected: true, revision: plan.baseRevision },
      sourceBranchProtected: false,
    }),
    findMergeRequests: async () => [...requests],
    openDraftMergeRequest: async (input) => {
      const request: GitLabMergeRequest = {
        iid: requests.length + 1,
        url: `https://gitlab.example.invalid/docs/orbit/-/merge_requests/${requests.length + 1}`,
        state: "opened",
        draft: true,
        sourceBranch: input.plan.proposedSourceBranch,
        targetBranch: input.plan.targetBranch.name,
        headRevision: input.headRevision,
        sourceProjectId: input.plan.project.id,
        targetProjectId: input.plan.project.id,
        title: input.title,
        description: input.description,
      };
      requests.push(request);
      return request;
    },
  };
}

type OrbitFixture = Awaited<ReturnType<typeof repositoryFixture>>;

/**
 * A real scripted update-documentation run over the Orbit fixture, saved with
 * its editorial evidence: the record `docsfab publish` and `docsfab ship` must
 * decode (#2366). The checkout carries one identity, read the same way by every
 * delivery step.
 */
async function savedUpdateRun() {
  const fixture = await repositoryFixture();
  await git(fixture.repository, "config", "user.name", "Fixture Maintainer");
  await git(fixture.repository, "config", "user.email", "maintainer@example.invalid");
  const harness = new EditorialProtocolHarness({
    candidate: "update",
    impactSource: fixture.impactSource,
  });
  const record = await executeRunRequest(
    {
      workflow: "update-documentation",
      repositoryPath: fixture.repository,
      revision: fixture.head,
      instruction: "Update docs/cli.md for the changed public option.",
      readerTaskContext: fixture.handoff,
      allowWrite: true,
      releaseGate: false,
      verbose: false,
      json: false,
      showScan: false,
    },
    fixture.config,
    { silent: true, harness },
  );
  expect(record?.status, JSON.stringify(record?.error)).toBe("succeeded");
  return { fixture, record: record! };
}

/**
 * The in-process seams for delivering the Orbit fixture's run: GitLab's answers,
 * a simulated remote, and no validation sandbox. Everything else runs for real.
 */
function orbitDelivery(fixture: OrbitFixture) {
  const glab = new OrbitGitLabCommands(fixture.head);
  const remote = new SimulatedRemoteGit();
  const requests: GitLabMergeRequest[] = [];
  const logs: string[] = [];
  const dependencies = {
    cwd: fixture.repository,
    stateDirectory: fixture.config.stateDirectory,
    environment: {
      ...process.env,
      XDG_STATE_HOME: join(dirname(fixture.config.stateDirectory), "xdg-state"),
    },
    log: (message: string): void => {
      logs.push(message);
    },
    commands: glab,
    isolateValidation: async () => ({ commandPrefix: [] }),
    publisher: {
      git: new DeterministicLocalGitPublisher(remote, process.env),
      gitlab: orbitGitLabPublisher(requests),
    },
  };
  return { glab, remote, requests, logs, dependencies };
}

/** The delivery opened one Draft MR whose pushed head carries the new option. */
async function expectDraftDelivered(
  fixture: OrbitFixture,
  delivery: ReturnType<typeof orbitDelivery>,
): Promise<void> {
  const { requests, remote, logs } = delivery;
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ draft: true, targetBranch: "main" });
  const head = remote.branches.get(`refs/heads/${requests[0]!.sourceBranch}`);
  expect(head).toBe(requests[0]!.headRevision);
  expect(await git(fixture.repository, "show", `${head}:docs/cli.md`)).toContain("--new");
  expect(logs).toContain(`Draft merge request: ${requests[0]!.url}`);
}
