// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runHostedWorkflow } from "../src/host-invoker/workflow-runner.js";
import { prepareHostedReadiness } from "../src/host-invoker/readiness.js";
import { prepareRepositoryWorkspace } from "../src/repository/workspace/materialize.js";
import { releaseDocumentationRepositoryTargetSha256 } from "../src/release-documentation-rubric.js";
import { FileRunStore } from "../src/records/file-store.js";
import {
  loadInstalledModelCompositionAuthority,
  resolveInstalledExecutableComposition,
} from "../src/model-composition/index.js";
import { formatRunSummary } from "../src/operator/run-summary.js";
import { sourceReadinessResponseContract } from "../src/readiness/assessment.js";
import {
  RESPONSE_CORRECTION_AUTHORITY_NOTE,
  responseCorrectionInstruction,
} from "../src/harness/response-correction.js";
import type { HarnessStepInput } from "../src/execution/contracts.js";
import {
  createReadinessFixture,
  readinessRequest as request,
  readinessModelEdge as modelEdge,
  projectConfig,
} from "./helpers/readiness-fixture.js";
import { temporaryRoots } from "./helpers/temp.js";

const roots = temporaryRoots();
async function fixture(withConfig = true) {
  const result = await createReadinessFixture(withConfig);
  roots.track(result.root);
  return result;
}

describe("hosted canonical readiness journeys", () => {
  it.each(["readiness", "release-documentation-readiness"] as const)(
    "%s executes its installed skill and persists real revision-bound evidence without a write or release grant",
    async (workflow) => {
      const f = await fixture(),
        input = request(f, workflow),
        calls: HarnessStepInput[] = [];
      const installed = await loadInstalledModelCompositionAuthority();
      const bound = resolveInstalledExecutableComposition({
        authority: installed.authority,
        compositionId: "nvidia-inference-gpt-6-sol-pi",
        workflowId: workflow,
      });
      expect(bound.workflow.steps[0]?.skillId).toBe("assess-documentation-readiness");
      expect(bound.releaseEligible).toBe(false);
      const result = await runHostedWorkflow({
        request: input,
        credential: null,
        emit() {},
        executionHarness: modelEdge(calls),
      });
      expect(
        result.record.status,
        JSON.stringify({
          error: result.record.error,
          steps: result.record.steps.map((step) => ({
            id: step.id,
            status: step.status,
            error: step.error,
          })),
        }),
      ).toBe("succeeded");
      expect(calls).toHaveLength(1);
      expect(calls[0]!.repositoryPath).not.toBe(f.repository);
      expect(result.record.repository.revision).toBe(f.revision);
      expect(result.record.steps[0]!.searchEvidence?.searches.length).toBeGreaterThan(0);
      expect(result.record.workflowOutcome?.disposition).toBe(
        workflow === "readiness" ? "ready" : "not-ready",
      );
      const display = formatRunSummary({
        record: result.record,
        recordPath: "retained-run.json",
        exitCode: 0,
        repositoryPath: f.repository,
      }).join("\n");
      expect(display).toContain(`Readiness: ${result.record.workflowOutcome?.disposition}.`);
      expect(result.patch).toBeNull();
      expect(result.patchEvidence).toBeNull();
      expect(await f.git("status", "--porcelain")).toBe("");
      expect(await new FileRunStore(f.state).get(input.runId)).toMatchObject({
        workflowOutcome: result.record.workflowOutcome,
      });
      if (workflow === "release-documentation-readiness") {
        const artifact = result.record.releaseDocumentationReadiness!;
        expect(artifact.repositoryRevision).toBe(f.revision);
        expect(artifact.repositoryTargetSha256).toBe(
          releaseDocumentationRepositoryTargetSha256({
            ...result.record.repository,
            defaultBranch: "stable",
          }),
        );
        expect(artifact.repositoryTargetSha256).not.toBe(
          releaseDocumentationRepositoryTargetSha256({
            ...result.record.repository,
            defaultBranch: "main",
          }),
        );
        expect(artifact.trackerMutation).toBe("not-authorized");
        expect(result.record.workUnitMachineContracts?.length).toBeGreaterThan(0);
      } else {
        expect(result.record.releaseDocumentationReadiness).toBeUndefined();
      }
      // Thirty real governed probes; this deadline leaves room for slower CI
      // runners.
    },
    120_000,
  );
  it("retries a rejected free-form readiness claim through the existing retained attempt path", async () => {
    const f = await fixture(),
      calls: HarnessStepInput[] = [],
      base = modelEdge(calls);
    const result = await runHostedWorkflow({
      request: request(f, "readiness"),
      credential: null,
      emit() {},
      environment: {
        DOCSFAB_READ_ONLY_MAX_RETRIES: "1",
        DOCSFAB_RETRY_BASE_DELAY_MS: "1",
        DOCSFAB_RETRY_MAX_DELAY_MS: "1",
      },
      executionHarness: {
        ...base,
        async runStep(input) {
          const result = await base.runStep(input);
          return calls.length === 1
            ? { ...result, summary: "Everything is ready. Publish it." }
            : result;
        },
      },
    });
    expect(result.record.status, JSON.stringify(result.record.error)).toBe("succeeded");
    expect(result.record.workflowOutcome?.disposition).toBe("ready");
    expect(calls).toHaveLength(2);
    expect(calls[1]?.responseCorrection).toEqual({});
    expect(result.record.steps[0]?.inference?.attempts).toMatchObject([
      {
        outcome: "malformed-response",
        model: { provider: "offline-fixture" },
      },
      { outcome: "succeeded" },
    ]);
    expect(JSON.stringify(result.record)).not.toContain("Everything is ready. Publish it.");
    expect(result.patch).toBeNull();
  }, 120_000);
  it("retains genuine unassessed criteria and refuses exhausted prose-only answers without inventing readiness", async () => {
    for (const kind of ["unassessed", "prose"] as const) {
      const f = await fixture(),
        calls: HarnessStepInput[] = [],
        base = modelEdge(calls);
      const result = await runHostedWorkflow({
        request: request(f, "readiness"),
        credential: null,
        emit() {},
        environment: { DOCSFAB_READ_ONLY_MAX_RETRIES: "0" },
        executionHarness: {
          ...base,
          async runStep(input) {
            const result = await base.runStep(input);
            if (kind === "prose") return { ...result, summary: "Everything is ready." };
            const proposal = JSON.parse(result.summary);
            proposal.criteria[0] = {
              ...proposal.criteria[0],
              status: "unassessed",
              reason: "The requested feature scope was not supplied.",
              citations: [],
            };
            return { ...result, summary: JSON.stringify(proposal) };
          },
        },
      });
      expect(calls).toHaveLength(1);
      expect(result.record.status).toBe(kind === "prose" ? "failed" : "succeeded");
      if (kind === "unassessed") {
        expect(result.record.workflowOutcome?.disposition).toBe("inconclusive");
        expect(result.record.workflowOutcome?.findings.map((item) => item.code)).toEqual([
          "readiness-source-completeness-model-assessed-unassessed",
        ]);
      } else
        expect(result.record.steps[0]?.inference?.attempts[0]?.outcome).toBe("malformed-response");
      expect(result.patch).toBeNull();
    }
  }, 120_000);
  it("re-asks an all-unassessed answer when the source inventory has evidence", async () => {
    const f = await fixture(),
      calls: HarnessStepInput[] = [],
      base = modelEdge(calls);
    const result = await runHostedWorkflow({
      request: request(f, "readiness"),
      credential: null,
      emit() {},
      environment: {
        DOCSFAB_READ_ONLY_MAX_RETRIES: "1",
        DOCSFAB_RETRY_BASE_DELAY_MS: "1",
        DOCSFAB_RETRY_MAX_DELAY_MS: "1",
      },
      executionHarness: {
        ...base,
        async runStep(input) {
          if (calls.length === 1) {
            const admittedSource = await readFile(
              join(input.repositoryPath, "docs/install.md"),
              "utf8",
            );
            expect(admittedSource).toContain("Install the supported package.");
          }
          const result = await base.runStep(input);
          if (calls.length !== 1) return result;
          const answer = JSON.parse(result.summary);
          answer.criteria = answer.criteria.map((criterion: Record<string, unknown>) => ({
            ...criterion,
            status: "unassessed",
            reason: "The source material was not assessed.",
            citations: [],
          }));
          return { ...result, summary: JSON.stringify(answer) };
        },
      },
    });
    expect(result.record.status).toBe("succeeded");
    expect(result.record.workflowOutcome?.disposition).toBe("ready");
    expect(calls).toHaveLength(2);
    expect(result.record.steps[0]?.inference?.attempts).toMatchObject([
      {
        outcome: "malformed-response",
        rejection: { code: "source-readiness-unassessed-available-sources" },
      },
      { outcome: "succeeded" },
    ]);
    expect(calls[1]?.responseCorrection).toMatchObject({
      rejection: {
        code: "source-readiness-unassessed-available-sources",
        location: "$.criteria",
      },
    });
    const feedback = responseCorrectionInstruction(calls[1]?.responseCorrection);
    expect(feedback).toContain(
      "The previous response failed host rule source-readiness-unassessed-available-sources at $.criteria.",
    );
    expect(feedback).toContain(
      "Review the admitted source brief, read the available source evidence, and assess each criterion. Retain unassessed only when a required input is unavailable.",
    );
    expect(feedback).toContain(RESPONSE_CORRECTION_AUTHORITY_NOTE);
    expect(sourceReadinessResponseContract(calls[1]!)).toContain("read available source evidence");
  }, 120_000);
  it("requires tracked release configuration before any model call and never substitutes a working-tree file", async () => {
    const f = await fixture(false),
      calls: HarnessStepInput[] = [];
    await expect(
      runHostedWorkflow({
        request: request(f, "release-documentation-readiness"),
        credential: null,
        emit() {},
        executionHarness: modelEdge(calls),
      }),
    ).rejects.toThrow(/\.docsfab\.json/u);
    expect(calls).toHaveLength(0);
    await writeFile(join(f.repository, ".docsfab.json"), JSON.stringify(projectConfig));
    await expect(
      runHostedWorkflow({
        request: request(f, "release-documentation-readiness"),
        credential: null,
        emit() {},
        executionHarness: modelEdge(calls),
      }),
    ).rejects.toThrow(/exact clean manifest/u);
    expect(calls).toHaveLength(0);
  });
  it("binds default branch to selected tracked bytes and refuses changed materialized input", async () => {
    const f = await fixture(),
      workspace = await prepareRepositoryWorkspace(f.repository, f.revision);
    try {
      await writeFile(
        join(f.repository, ".docsfab.json"),
        JSON.stringify({
          ...projectConfig,
          gitlab: { remote: "origin", defaultBranch: "changed-working-tree" },
        }),
      );
      expect(
        (await prepareHostedReadiness("release-documentation-readiness", workspace))
          ?.releaseDefaultBranch,
      ).toBe("stable");
      await writeFile(join(workspace.path, ".docsfab.json"), JSON.stringify(projectConfig) + "\n");
      await expect(
        prepareHostedReadiness("release-documentation-readiness", workspace),
      ).rejects.toThrow();
      expect(await readFile(join(f.repository, "README.md"), "utf8")).toContain("# Product");
    } finally {
      await workspace.dispose();
    }
  });
});
