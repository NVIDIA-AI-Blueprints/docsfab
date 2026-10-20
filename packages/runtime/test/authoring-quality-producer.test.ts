// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { canonicalDigest } from "../src/content-ir/canonical.js";
import { verificationResultFixture } from "./helpers/verification.js";
import { createHash } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLocalWorkflowApplicationServices } from "../src/application/dependencies.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import { GitPatchEvidenceCollector } from "../src/repository/evidence.js";
import { prepareRepositoryWorkspace } from "../src/repository/workspace/materialize.js";
import { sealAuthoringCandidate } from "../src/workflow-execution/authoring-workspace-host.js";
import {
  assertAuthoringQualityValidationBinding,
  sealQualityValidationBinding,
  decodeQualityValidationBinding,
} from "../src/evaluation-report/quality-artifact-staging.js";
import { grantedToolsForStep } from "../src/harness/pi-tool-confine.js";
import {
  isQualityArtifactEvaluator,
  bindQualityArtifactResponseContract,
} from "../src/harness/editorial-response-contract.js";
import { resolveAnswerPath } from "../src/harness/answer-submission.js";
import type { RunRecord } from "../src/records/contracts.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";
import { temporaryRoots } from "./helpers/temp.js";
import { initFixtureRepo } from "./helpers/git.js";
import {
  editorialTechnicalStepInput,
  documentationPlanBinding,
  textTurn,
} from "./support/pi-harness-session-fixtures.js";
import { recordingProvider, toolPathHarness } from "./support/answer-submission-fixtures.js";
import { authoringFixtureCandidate } from "./support/authoring-quality-fixture.js";
const roots = temporaryRoots();
const disposals: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(disposals.splice(0).map((dispose) => dispose()));
  await roots.cleanup();
});
const runtimeRoot = fileURLToPath(new URL("..", import.meta.url));
async function producer(workflowName: "create-documentation" | "update-documentation") {
  const root = await roots.create("docsfab-real-authoring-quality-");
  const source = join(root, "source");
  const target = "docs/cli-reference.md";
  await initFixtureRepo(source, {
    "src/main.ts": "export const greeting = 'hello';\n",
    ...(workflowName === "update-documentation" ? { [target]: "# Old CLI reference\n" } : {}),
  });
  const workspace = await prepareRepositoryWorkspace(source, "HEAD");
  const collector = await GitPatchEvidenceCollector.create(workspace.path, join(root, "patches"));
  disposals.push(
    () => collector.dispose(),
    () => workspace.dispose(),
  );
  const workflow = getWorkflow(workflowName);
  const config = {
    projectRoot: runtimeRoot,
    stateDirectory: join(root, "runs"),
    skillCrateDirectory: join(runtimeRoot, "skill-crate"),
    qualityDirectory: join(runtimeRoot, "quality"),
    qualityPackDirectory: join(runtimeRoot, "quality-pack"),
  };
  const assembled = await createLocalWorkflowApplicationServices({
    config,
    request: { workflow: workflowName },
    workflow,
    workspace,
    repositoryEvidence: collector,
    baseHarness: {
      runStep: async () => {
        throw new Error("No model call is needed to prepare the admitted candidate.");
      },
    },
    hostOperations: {
      runStep: async () => ({ summary: "No repository-native check is declared." }),
    },
  } as never);
  await mkdir(join(workspace.path, "docs"), { recursive: true });
  await writeFile(join(workspace.path, target), "# CLI reference\n\nRun the hello command.\n");
  const record = {
    id: `quality-${workflowName}`,
    workflow: workflowName,
    repository: {
      sourcePath: workspace.sourcePath,
      requestedRevision: workspace.requestedRevision,
      revision: workspace.revision,
    },
    steps: [],
  } as unknown as RunRecord;
  const capture =
    workflowName === "create-documentation"
      ? await sealAuthoringCandidate({
          runId: record.id,
          ordinal: 0,
          originalRevision: workspace.revision,
          planDigest: "b".repeat(64),
          writePaths: [target],
          workspace,
          repository: record.repository,
          evidenceCollector: collector,
          sourceLedger: {
            schemaVersion: 1,
            kind: "docsfab-source-obligation-ledger",
            identity: {
              repositoryRevision: workspace.revision,
              scopeSha256: "b".repeat(64),
              sourceEvidenceSha256: "c".repeat(64),
              workspaceSnapshotSha256: "d".repeat(64),
              sources: [
                {
                  path: "src/main.ts",
                  sha256: createHash("sha256")
                    .update(await readFile(join(workspace.path, "src/main.ts")))
                    .digest("hex"),
                },
              ],
            },
            completeness: "bounded-not-proven",
            dimensions: [],
            limitations: [],
            digest: "e".repeat(64),
          },
        })
      : undefined;
  const prepare = assembled.services.prepareAuthoringQualityValidation!;
  const input = {
    workflow,
    record,
    workspacePath: workspace.path,
    targetPaths: [target],
    repositoryEvidence: collector,
    ...(capture ? { capture } : {}),
  };
  return { root, workspace, target, capture, input, prepare, record };
}
describe("real authoring quality producer", () => {
  it.each(["create-documentation", "update-documentation"] as const)(
    "mints locked %s validation for actual authored bytes without a score",
    async (name) => {
      const value = await producer(name);
      const quality = await value.prepare(value.input);
      expect(quality.selection.documentationPaths).toEqual([value.target]);
      const candidate = authoringFixtureCandidate(
        quality.selection.profile,
        value.workspace.revision,
      );
      candidate.selectionSha256 = quality.selection.receipt.selectionSha256;
      const validated = await quality.host.validate({
        runId: value.record.id,
        repositoryRevision: value.workspace.revision,
        evaluatorIdentitySha256: "f".repeat(64),
        evaluatorStepId: "evaluate-document-quality",
        evaluatorAttempt: 1,
        evaluatedAt: "2026-10-12T12:00:00Z",
        evaluatorProviderId: "scripted-producer-fixture",
        candidate,
      });
      expect(validated.binding.status).toBe("passed");
      expect(validated.binding.artifacts.qualityScore).toBeNull();
      expect(decodeQualityValidationBinding(validated.binding)).toEqual(validated.binding);
      expect(validated.binding.evaluatedCandidate).toMatchObject({
        workflow: name,
        targetPaths: [value.target],
        candidateOrdinal: name === "create-documentation" ? 0 : null,
        candidateDigest: value.capture?.candidate.digest ?? null,
      });
      expect(validated.reportMarkdown).toContain("v0.2");
    },
  );
  it("refuses CREATE bytes changed after admitted capture", async () => {
    const value = await producer("create-documentation");
    await writeFile(join(value.workspace.path, value.target), "# Changed after capture\n");
    await expect(value.prepare(value.input)).rejects.toThrow("changed after immutable capture");
  });
  it.each(["create-documentation", "update-documentation"] as const)(
    "keeps %s final evaluator read-only and text-only",
    (name) => {
      const workflow = getWorkflow(name),
        step = workflow.steps.find((step) => step.id === "evaluate-document-quality")!;
      const input = { workflow, step, qualityProfileSelection: {} } as never;
      expect(isQualityArtifactEvaluator(input)).toBe(true);
      expect(grantedToolsForStep(workflow, step, true)).not.toContain("validate_quality_candidate");
      expect(grantedToolsForStep(workflow, step, true)).not.toContain("submit_quality_evaluation");
      expect(
        resolveAnswerPath({
          workflow,
          step,
          qualityBound: true,
          option: "recorded",
          capability: undefined,
          toolCeiling: undefined,
        }),
      ).toBeUndefined();
    },
  );
});

it("admits an UPDATE artifact through the real Pi outer editorial and inner quality decoders", async () => {
  const value = await producer("update-documentation");
  const quality = await value.prepare(value.input);
  const workflow = getWorkflow("update-documentation");
  const technicalVerification = verificationResultFixture([value.target], "src/main.ts:1");
  const input = {
    ...editorialTechnicalStepInput(value.workspace.path),
    workflow,
    step: workflow.steps.find((step) => step.id === "evaluate-document-quality")!,
    technicalVerification,
    evidenceIdentity: {
      repositoryRevision: value.workspace.revision,
      technicalVerificationSha256: canonicalDigest(technicalVerification),
    },
    verificationTargetPaths: [value.target],
    planBinding: documentationPlanBinding("update", value.target),
    qualityProfileSelection: quality.selection.receipt,
    qualityEvaluationTarget: quality.selection.evaluationTarget,
    answerSubmission: undefined,
  };
  const candidate = authoringFixtureCandidate(quality.selection.profile, value.workspace.revision);
  candidate.selectionSha256 = quality.selection.receipt.selectionSha256;
  const proposal = {
    schemaVersion: 1,
    kind: "docsfab-editorial-assessment-proposal",
    assessment: "accepted",
    rationale: "The actual evaluated evidence preserves the admitted editorial candidate.",
    evidenceRefs: input.editorialEvidenceRefs,
    limitations: [],
    recommendation: null,
  };
  const calls = recordingProvider([
    textTurn(
      JSON.stringify({
        summary:
          JSON.stringify({
            evaluation: candidate.evaluation,
            qualityScore: candidate.qualityScore,
          }) +
          "\n" +
          candidate.reportMarkdown,
        editorialAssessmentProposal: proposal,
      }),
    ),
  ]);
  const harness = toolPathHarness({ composition: false });
  const result = await harness.runStep(input);
  expect(result.qualityArtifactCandidate).toMatchObject({
    selectionSha256: quality.selection.receipt.selectionSha256,
    qualityScore: null,
  });
  expect(result.editorialAssessmentProposal).toMatchObject({
    assessment: "accepted",
    recommendation: null,
  });
  expect(calls).toHaveLength(1);
  const contract = bindQualityArtifactResponseContract(input);
  expect(contract.step.prompt).toContain(
    "Encode the complete quality answer described above (the two-key JSON object followed by report Markdown) as a JSON string in summary",
  );
  const body = JSON.stringify(calls);
  expect(body).not.toContain('"name":"validate_quality_candidate"');
  expect(body).not.toContain('"name":"submit_quality_evaluation"');
});

it(
  "binds a full real CREATE runner's quality to its retained final selected candidate",
  async () => {
    const { runAuthoringQualityProducerFixture } = await import(
      "./support/authoring-quality-runner.js"
    );
    const root = await roots.create("docsfab-full-authoring-quality-");
    const { record } = await runAuthoringQualityProducerFixture(root, { quotedDecline: true });
    expect(
      record.status,
      JSON.stringify({
        error: record.error,
        steps: record.steps.map((step) => ({
          id: step.id,
          status: step.status,
          error: step.error,
        })),
      }),
    ).toBe("succeeded");
    expect(record.authoringExecution?.selectedCandidate?.ordinal).toBe(0);
    expect(record.qualityArtifactValidation?.status, JSON.stringify(record.steps.at(-1))).toBe(
      "passed",
    );
    expect(record.qualityArtifactValidation?.evaluatedCandidate?.candidateDigest).toBe(
      record.authoringExecution?.selectedCandidate?.digest,
    );
    expect(record.qualityArtifactValidation?.evaluatedCandidate?.patchSha256).toBe(
      record.changes?.patch?.sha256,
    );
    expect(() =>
      assertAuthoringQualityValidationBinding(
        record,
        record.qualityArtifactValidation!,
        record.qualityProfileSelection!,
      ),
    ).not.toThrow();
    for (const patch of [
      { candidateDigest: "a".repeat(64) },
      { candidateOrdinal: 1 as const },
      { workspaceSnapshotSha256: "a".repeat(64) },
      { patchSha256: "a".repeat(64) },
      { targetPaths: ["README.md"] },
    ]) {
      const { schemaVersion, kind, bindingSha256, ...body } = record.qualityArtifactValidation!;
      const forged = sealQualityValidationBinding({
        ...body,
        evaluatedCandidate: { ...body.evaluatedCandidate!, ...patch },
      });
      expect(() =>
        assertAuthoringQualityValidationBinding(record, forged, record.qualityProfileSelection!),
      ).toThrow();
    }
    expect(() =>
      assertAuthoringQualityValidationBinding(record, record.qualityArtifactValidation!, {
        ...record.qualityProfileSelection!,
        workflow: "review-documentation",
      }),
    ).toThrow();
  },
  testTimeoutMs(120_000),
);

it(
  "binds revised CREATE quality to candidate one and the actually retained revised patch",
  async () => {
    const { runAuthoringQualityProducerFixture } = await import(
      "./support/authoring-quality-runner.js"
    );
    const root = await roots.create("docsfab-revised-authoring-quality-");
    const { record } = await runAuthoringQualityProducerFixture(root, { branch: "revise" });
    expect(record.status, JSON.stringify(record.error)).toBe("succeeded");
    expect(record.authoringExecution?.selectedCandidate?.ordinal).toBe(1);
    expect(record.qualityArtifactValidation?.status).toBe("passed");
    expect(record.qualityArtifactValidation?.evaluatedCandidate?.candidateOrdinal).toBe(1);
    expect(record.qualityArtifactValidation?.evaluatedCandidate?.candidateDigest).toBe(
      record.authoringExecution?.selectedCandidate?.digest,
    );
    expect(record.qualityArtifactValidation?.evaluatedCandidate?.patchSha256).toBe(
      record.changes?.patch?.sha256,
    );
    expect(() =>
      assertAuthoringQualityValidationBinding(
        record,
        record.qualityArtifactValidation!,
        record.qualityProfileSelection!,
      ),
    ).not.toThrow();
  },
  testTimeoutMs(120_000),
);
