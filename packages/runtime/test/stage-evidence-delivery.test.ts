// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { prepareRepositoryWorkspace } from "../src/repository/workspace/materialize.js";
import { RepositoryWorkspaceReadError } from "../src/repository/workspace/contracts.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import {
  LocalSourceObligationSourceObserver,
  MAX_SOURCE_BYTES,
  listPreservationSources,
  readPreservationSourceRange,
  revokePreservationSourceReader,
} from "../src/workflow-execution/source-obligation-observer.js";
import { shouldDeliverPreservationBaseEvidence } from "../src/workflow-execution/source-obligation.js";
import { SOURCE_READ_RESPONSE_CEILING_BYTES } from "../src/inputs/source-step-policy.js";
import type { HarnessStepInput } from "../src/execution/contracts.js";
import { buildDocsFabStepPrompt } from "../src/harness/pi-session.js";
import { createConfinedToolSet } from "../src/harness/confined-tools.js";
import { grantedToolsForStep } from "../src/harness/pi-tool-confine.js";
import {
  assertHostedWorkflowCatalog,
  inspectHostedWorkflowCatalog,
} from "../src/host-invoker/workflow-catalog.js";
import {
  EXPERIMENTAL_STAGE_SPECIFIC_PRESERVATION_BASE_ENV,
  preservationBaseDeliveryForHostWorkflow,
  runHostedWorkflow,
} from "../src/host-invoker/workflow-runner.js";
import type { AgentHarness } from "../src/execution/contracts.js";
import { sealDocumentationPlanBinding } from "../src/workflow-execution/plan-binding.js";
import {
  controlledHostedCreateHarness,
  createHostedCreateFixture,
  HOSTED_CREATE_TARGET,
} from "./helpers/hosted-create.js";
import { commitFixture, initFixtureRepo } from "./helpers/git.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";

describe("stage-specific preservation evidence delivery", () => {
  it("keeps hosted delivery eager unless the explicit experimental restructure toggle is true", () => {
    expect(
      preservationBaseDeliveryForHostWorkflow({
        workflow: "restructure-documentation",
        environment: {},
      }),
    ).toBe("eager");
    expect(
      preservationBaseDeliveryForHostWorkflow({
        workflow: "restructure-documentation",
        environment: { [EXPERIMENTAL_STAGE_SPECIFIC_PRESERVATION_BASE_ENV]: "0" },
      }),
    ).toBe("eager");
    expect(
      preservationBaseDeliveryForHostWorkflow({
        workflow: "restructure-documentation",
        environment: { [EXPERIMENTAL_STAGE_SPECIFIC_PRESERVATION_BASE_ENV]: "1" },
      }),
    ).toBe("stage-specific");
    expect(
      preservationBaseDeliveryForHostWorkflow({
        workflow: "review-documentation",
        environment: { [EXPERIMENTAL_STAGE_SPECIFIC_PRESERVATION_BASE_ENV]: "1" },
      }),
    ).toBe("eager");
    expect(() =>
      preservationBaseDeliveryForHostWorkflow({
        workflow: "restructure-documentation",
        environment: { [EXPERIMENTAL_STAGE_SPECIFIC_PRESERVATION_BASE_ENV]: "yes" },
      }),
    ).toThrow(/must be 0 or 1/u);
  });

  it("withholds only the eager base from restructure audience assessment when opted in", () => {
    expect(
      shouldDeliverPreservationBaseEvidence({
        deliveryMode: "stage-specific",
        workflowName: "restructure-documentation",
        stepId: "test-audience-understanding",
      }),
    ).toBe(false);

    for (const stepId of [
      "write-documentation",
      "verify-technical-accuracy",
      "review-documentation",
    ]) {
      expect(
        shouldDeliverPreservationBaseEvidence({
          deliveryMode: "stage-specific",
          workflowName: "restructure-documentation",
          stepId,
        }),
      ).toBe(true);
    }
  });

  it("keeps eager delivery as the default and leaves other workflows unchanged", () => {
    expect(
      shouldDeliverPreservationBaseEvidence({
        deliveryMode: undefined,
        workflowName: "restructure-documentation",
        stepId: "test-audience-understanding",
      }),
    ).toBe(true);
    expect(
      shouldDeliverPreservationBaseEvidence({
        deliveryMode: "stage-specific",
        workflowName: "update-documentation",
        stepId: "test-audience-understanding",
      }),
    ).toBe(true);
  });

  it("reads exact UTF-8 ranges from sealed originals with continuation and fresh authority", async () => {
    const root = await mkdtemp(join(tmpdir(), "docsfab-stage-evidence-"));
    const source = join(root, "source");
    const original =
      "# Original résumé — preserve this paragraph.\n" +
      "é".repeat(SOURCE_READ_RESPONSE_CEILING_BYTES);
    let workspace: Awaited<ReturnType<typeof prepareRepositoryWorkspace>> | undefined;
    try {
      await mkdir(join(source, "docs"), { recursive: true });
      await writeFile(join(source, "docs", "guide.md"), original);
      await initFixtureRepo(source, undefined, { branch: "main" });
      await commitFixture(source, "original source fixture");
      workspace = await prepareRepositoryWorkspace(source, "HEAD");
      const observer = new LocalSourceObligationSourceObserver(workspace);
      const workflow = getWorkflow("restructure-documentation");
      const { capture, evidence } = await observer.captureOriginalSourceAuthority({
        runId: "stage-evidence-run",
        workflow,
        repositoryRevision: workspace.revision,
        scopeSha256: "b".repeat(64),
        workspaceSnapshotSha256: "c".repeat(64),
      });
      const reader = observer.createPreservationSourceReader({
        runId: "stage-evidence-run",
        stepId: "test-audience-understanding",
        repositoryRevision: workspace.revision,
        capture,
        authority: evidence,
        authorizedPaths: ["docs/guide.md"],
      });
      const [reference] = listPreservationSources(reader);
      expect(reference).toMatchObject({
        path: "docs/guide.md",
        byteLength: Buffer.byteLength(original),
      });

      const candidate = join(source, "docs", "guide.md");
      await writeFile(candidate, "# Candidate revision differs.\n");
      const audienceStep = workflow.steps.find(
        (step) => step.id === "test-audience-understanding",
      )!;
      const audienceInput = {
        workflow,
        step: audienceStep,
        repositoryPath: source,
        preservationSourceReader: reader,
      } as HarnessStepInput;
      const hostedCatalog = inspectHostedWorkflowCatalog("restructure-documentation", {
        preservationSourceRead: true,
      });
      const toolName = "docsfab_read_preservation_source";
      expect(hostedCatalog.declaredTools).toContain(toolName);
      expect(() =>
        assertHostedWorkflowCatalog(
          {
            workflow: hostedCatalog.workflow,
            stepIds: hostedCatalog.stepIds,
            composition: hostedCatalog,
          },
          { preservationSourceRead: true },
        ),
      ).not.toThrow();
      expect(
        grantedToolsForStep(
          workflow,
          audienceStep,
          false,
          false,
          false,
          false,
          false,
          hostedCatalog.declaredTools,
          undefined,
          false,
          false,
          false,
          true,
        ),
      ).toContain(toolName);
      expect(grantedToolsForStep(workflow, audienceStep)).not.toContain(toolName);
      expect(audienceInput.preservationBaseEvidence).toBeUndefined();
      const prompt = buildDocsFabStepPrompt(audienceInput);
      expect(prompt).toContain(reference!.sourceId);
      expect(prompt).toContain("Exact original-source references");
      expect(prompt).not.toContain(original);
      expect(await readFile(candidate, "utf8")).not.toBe(original);

      const confined = await createConfinedToolSet({
        workspacePath: source,
        allowWrite: false,
        preservationSourceReader: reader,
      });
      const preservationTool = confined.definitions.find(
        (definition) => definition.name === "docsfab_read_preservation_source",
      );
      expect(preservationTool).toBeDefined();
      const firstToolPage = await preservationTool!.execute("preservation-read-1", {
        sourceId: reference!.sourceId,
        fromByte: 0,
        maxBytes: SOURCE_READ_RESPONSE_CEILING_BYTES,
      });
      const firstPayload = JSON.parse(firstToolPage.content[0]!.text) as {
        sourceId: string;
        text: string;
        nextFromByte: number | null;
      };
      expect(firstPayload.sourceId).toBe(reference!.sourceId);
      expect(firstPayload.text).toBe(original.slice(0, firstPayload.text.length));
      expect(firstPayload.nextFromByte).not.toBeNull();

      const first = await readPreservationSourceRange({
        reader,
        sourceId: reference!.sourceId,
        fromByte: 0,
        maxBytes: SOURCE_READ_RESPONSE_CEILING_BYTES,
      });
      expect(first.endByte).toBeLessThan(Buffer.byteLength(original));
      expect(first.nextFromByte).not.toBeNull();
      const chunks = [first.text];
      let nextFromByte = first.nextFromByte;
      while (nextFromByte !== null) {
        const page = await readPreservationSourceRange({
          reader,
          sourceId: reference!.sourceId,
          fromByte: nextFromByte,
          maxBytes: SOURCE_READ_RESPONSE_CEILING_BYTES,
        });
        chunks.push(page.text);
        nextFromByte = page.nextFromByte;
      }
      expect(chunks.join("")).toBe(original);
      const reread = await readPreservationSourceRange({
        reader,
        sourceId: reference!.sourceId,
        fromByte: 0,
        maxBytes: 16,
      });
      expect(reread.text).toBe(original.slice(0, reread.text.length));
      expect(Buffer.byteLength(reread.text)).toBeLessThanOrEqual(16);
      expect(first.sha256).toBe(reference!.sha256);
      await expect(
        readPreservationSourceRange({
          reader,
          sourceId: "f".repeat(64),
          fromByte: 0,
          maxBytes: 8,
        }),
      ).rejects.toThrow("unavailable to this step");
      revokePreservationSourceReader(reader);
      expect(() => listPreservationSources(reader)).toThrow(/stale or invalid/u);

      await expect(
        readPreservationSourceRange({
          reader,
          sourceId: reference!.sourceId,
          fromByte: 0,
          maxBytes: 8,
        }),
      ).rejects.toThrow("stale or invalid");
    } finally {
      await workspace?.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses an oversize sealed source before advertising its unreadable reference", async () => {
    const source = await mkdtemp(join(tmpdir(), "docsfab-preservation-oversize-"));
    let workspace: Awaited<ReturnType<typeof prepareRepositoryWorkspace>> | undefined;
    try {
      await mkdir(join(source, "docs"), { recursive: true });
      await writeFile(join(source, "docs", "large.md"), Buffer.alloc(MAX_SOURCE_BYTES + 1, 0x61));
      await initFixtureRepo(source, undefined, { branch: "main" });
      await commitFixture(source, "oversize original fixture");
      workspace = await prepareRepositoryWorkspace(source, "HEAD");
      const observer = new LocalSourceObligationSourceObserver(workspace);
      const { capture, evidence } = await observer.captureOriginalSourceAuthority({
        runId: "oversize-run",
        workflow: getWorkflow("restructure-documentation"),
        repositoryRevision: workspace.revision,
        scopeSha256: "b".repeat(64),
        workspaceSnapshotSha256: "c".repeat(64),
      });
      try {
        observer.createPreservationSourceReader({
          runId: "oversize-run",
          stepId: "test-audience-understanding",
          repositoryRevision: workspace.revision,
          capture,
          authority: evidence,
          authorizedPaths: ["docs/large.md"],
        });
        throw new Error("Expected an oversize refusal.");
      } catch (error) {
        expect(error).toBeInstanceOf(RepositoryWorkspaceReadError);
        expect(error).toMatchObject({ code: "oversize" });
        expect(String(error)).toContain(String(MAX_SOURCE_BYTES + 1));
        expect(String(error)).toContain("Select a smaller original source");
      }
    } finally {
      await workspace?.dispose();
      await rm(source, { recursive: true, force: true });
    }
  });
});

describe("hosted restructure catalog follows the stage-specific preservation toggle", () => {
  const fixtures: Awaited<ReturnType<typeof createHostedCreateFixture>>[] = [];
  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
  });

  /** A restructure run whose audience step records whether it was handed the exact reader. */
  async function runRestructure(input: {
    sealedWithReader: boolean;
    environment: NodeJS.ProcessEnv;
  }) {
    const f = await createHostedCreateFixture({
      workflow: "restructure-documentation",
      sourceFiles: { "docs/overview.md": "# Overview\n" },
      grantTargets: [{ path: "docs/overview.md", operations: ["modify"] }],
      maximumChangedPaths: 2,
      preservationSourceRead: input.sealedWithReader,
    });
    fixtures.push(f);
    const inner = controlledHostedCreateHarness(f.request);
    const audienceReaders: (boolean | undefined)[] = [];
    const harness: AgentHarness = {
      inspectSkill: inner.harness.inspectSkill!,
      async runStep(step) {
        const answer = await inner.harness.runStep(step);
        if (step.step.id === "test-audience-understanding")
          audienceReaders.push(Boolean(step.preservationSourceReader));
        if (step.step.id !== "plan-documentation") return answer;
        return {
          ...answer,
          planBinding: sealDocumentationPlanBinding(
            {
              mode: "restructure",
              pages: [{ path: HOSTED_CREATE_TARGET, disposition: "move" }],
              sourceBindings: [
                {
                  pagePath: HOSTED_CREATE_TARGET,
                  sources: [`src/api.ts:1@${f.request.revision}`],
                },
              ],
            },
            { expectedMode: "restructure" },
          ),
        };
      },
    };
    const run = () =>
      runHostedWorkflow({
        request: f.request,
        credential: null,
        emit() {},
        executionHarness: harness,
        environment: input.environment,
        instruction: "Restructure the guides and add docs/new-guide.md.",
      });
    return { f, run, audienceReaders };
  }

  it("runs a restructure request sealed without the reader while the toggle is off", {
    timeout: testTimeoutMs(120_000),
  }, async () => {
    for (const environment of [{}, { [EXPERIMENTAL_STAGE_SPECIFIC_PRESERVATION_BASE_ENV]: "0" }]) {
      const { f, run, audienceReaders } = await runRestructure({
        sealedWithReader: false,
        environment,
      });
      expect(f.request.composition.declaredTools).not.toContain("docsfab_read_preservation_source");
      const result = await run();
      expect(result.record.status, result.record.error).toBe("succeeded");
      expect(audienceReaders).toEqual([false]);
    }
  });

  it("declares and hands the reader to the audience step only when the toggle is on", {
    timeout: testTimeoutMs(120_000),
  }, async () => {
    const environment = { [EXPERIMENTAL_STAGE_SPECIFIC_PRESERVATION_BASE_ENV]: "1" };
    const { f, run, audienceReaders } = await runRestructure({
      sealedWithReader: true,
      environment,
    });
    expect(f.request.composition.declaredTools).toContain("docsfab_read_preservation_source");
    const result = await run();
    expect(result.record.status, result.record.error).toBe("succeeded");
    expect(audienceReaders).toEqual([true]);
  });

  it("refuses an opted-in run whose installed policy was sealed without the reader", {
    timeout: testTimeoutMs(120_000),
  }, async () => {
    const { run } = await runRestructure({
      sealedWithReader: false,
      environment: { [EXPERIMENTAL_STAGE_SPECIFIC_PRESERVATION_BASE_ENV]: "1" },
    });
    await expect(run()).rejects.toThrow(
      "The installed composition tool set differs from the selected workflow declaration.",
    );
  });
});
