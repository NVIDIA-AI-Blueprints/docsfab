// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";

import { canonicalDigest } from "../../src/content-ir/canonical.js";
import { buildContentIndexV2 } from "../../src/content-ir/indexer.js";
import {
  assessDocumentationMaturityCascade,
  observeDocumentationMaturityCascadeTracker,
  selectDocumentationMaturityWorkUnit,
} from "../../src/maturity/cascade.js";
import { mapRepositoryDocumentationQuality } from "../../src/maturity/evaluators.js";
import { prepareRepositoryWorkspace } from "../../src/repository/workspace/materialize.js";
import {
  createAutoAssessment,
  createAutoCycleRequest,
  createAutoWorkflowTaskBinding,
  createWorkflowDecision,
  planAutoRoadmapCycleV1,
} from "../support/autonomy-contracts.js";
import {
  createManagedIssueStateLookupV1,
  observeManagedIssueTrackerV1,
  roadmapDigest,
} from "../../src/roadmap/index.js";
import { internalIssueManagedIssueObservationCapability } from "../../src/roadmap/managed-issue-observer-authority-internal.js";
import { bindableCycleWorkflow, getWorkflow } from "../../src/workflow-registry/catalog.js";
import type { WorkflowTaskInput } from "../../src/workflow-contracts/contracts.js";

const root = process.argv[2];
if (!root) throw new Error("fixture repository is required");
const project = {
  provider: "gitlab",
  host: "127.0.0.1",
  fullPath: "docs/fixture",
  projectId: 101,
};

const workspace = await prepareRepositoryWorkspace(root, "HEAD");
try {
  const repositoryTarget = {
    sourcePath: workspace.sourcePath,
    requestedRevision: workspace.requestedRevision,
    revision: workspace.revision,
  };
  const gateIds = ["G0", "G1", "G2", "G3", "G4", "G5"] as const;
  const mappings = new Map(
    await Promise.all(
      gateIds.map(
        async (gateId) =>
          [
            gateId,
            await mapRepositoryDocumentationQuality({
              gateId,
              repository: repositoryTarget,
              workspace,
            }),
          ] as const,
      ),
    ),
  );
  const assessment = await assessDocumentationMaturityCascade({
    gateInputs: gateIds.map((gateId) => ({
      gateId,
      repository: repositoryTarget,
      policyWorkspace: gateId === "G0" ? null : workspace,
      mappings: mappings.get(gateId)!,
    })),
  });
  const trackerObservation = await observeDocumentationMaturityCascadeTracker({
    assessment,
    workspace,
  });
  const selection = await selectDocumentationMaturityWorkUnit({
    assessment,
    trackerObservation,
    policyWorkspace: workspace,
  });
  const repository = await buildContentIndexV2({ workspace }).then((index) => index.repository);
  const observedAt = trackerObservation.observedAt;
  const managedSourceDigest = roadmapDigest({ project, observedAt, issues: [] });
  const managedTrackerObservation = observeManagedIssueTrackerV1({
    project,
    observedAt,
    issues: [],
    sourceCapability: internalIssueManagedIssueObservationCapability(managedSourceDigest),
    stateLookup: createManagedIssueStateLookupV1([]),
  });

  const selected = selection.outcome.state === "selected" ? selection.outcome.workUnit : null;
  const selectedFinding =
    selected === null
      ? null
      : (assessment.gates
          .flatMap((gate) => gate.findings)
          .find((finding) => finding.fingerprint === selected.findingFingerprint) ?? null);
  const workflow = bindableCycleWorkflow(selected?.workflow.name ?? "review-documentation");
  const definition = getWorkflow(workflow);
  const writes = definition.steps.some((step) => step.mode === "write");
  const task =
    writes && selected ? await boundedTask(selected.affectedPaths, assessment.repository) : null;
  const taskBinding = createAutoWorkflowTaskBinding(workflow, task, assessment.repository);
  const request = createAutoCycleRequest({
    cycleId: `cycle:real-${selection.outcome.state}`,
    repository: assessment.repository,
    tracker: {
      projectIdentitySha256: canonicalDigest(project),
      observationSha256: trackerObservation.observationSha256,
      observedAt,
      authority: "observe-only",
    },
    maturityFindingSha256s: selectedFinding ? [selectedFinding.findingSha256] : [],
    bounds: {
      workflowNames: [workflow],
      pathClass: writes ? "documentation-write" : "repository-read-only",
      pathPrefixes: writes && selected ? selected.affectedPaths : ["."],
      targetBranch: "codex/real-cascade",
      deliveryMode: writes ? "local-patch" : "none",
      requiredValidationIds: ["real-cascade-validation"],
      workflowPrerequisites: [{ workflow, prerequisiteIds: [] }],
      workflowTasks: [taskBinding],
    },
  });
  const autoAssessment = createAutoAssessment(
    {
      requestSha256: request.requestSha256,
      repository: request.repository,
      trackerObservationSha256: request.tracker.observationSha256,
      evidenceState: "sufficient",
      maturityFindings: selectedFinding
        ? [
            {
              fingerprint: selectedFinding.fingerprint,
              findingSha256: selectedFinding.findingSha256,
              confidence: selectedFinding.confidence,
              disposition: selectedFinding.disposition,
            },
          ]
        : [],
      candidates:
        selected && selectedFinding
          ? [
              {
                id: `candidate:${workflow}`,
                taskSha256: taskBinding.taskSha256,
                workflow,
                stepIds: definition.steps.map((step) => step.id),
                prerequisites: [],
                maturityFindingFingerprints: [selectedFinding.fingerprint],
                pathClass: writes ? "documentation-write" : "repository-read-only",
                pathPrefixes: writes ? selected.affectedPaths : ["."],
                deliveryMode: writes ? "local-patch" : "none",
                validationIds: ["real-cascade-validation"],
              },
            ]
          : [],
      openInputIds: [],
    },
    request,
  );
  const decision = createWorkflowDecision(
    selected
      ? {
          disposition: "execute",
          candidateSha256: autoAssessment.candidates[0]!.candidateSha256,
          reasonCode: "eligible-candidate-selected",
        }
      : {
          disposition: "no-action",
          reasonCode: "no-eligible-candidates",
        },
    request,
    autoAssessment,
  );
  const planningInput = {
    request,
    assessment: autoAssessment,
    decision,
    maturityAssessment: assessment,
    maturityTrackerObservation: trackerObservation,
    maturitySelection: selection,
    policyWorkspace: workspace,
    repository,
    project,
    managedTrackerObservation,
    operationCap: 4,
  };
  const result = await planAutoRoadmapCycleV1(planningInput);
  let copiedSelectionCode: string | null = null;
  try {
    await planAutoRoadmapCycleV1({
      ...planningInput,
      maturitySelection: structuredClone(selection),
    });
  } catch (error) {
    copiedSelectionCode =
      error && typeof error === "object" && "code" in error ? String(error.code) : "unknown";
  }
  process.stdout.write(
    `${JSON.stringify({
      cascadeState: selection.outcome.state,
      gateId: selection.outcome.gateId,
      workflow: selected?.workflow.name ?? null,
      planReadOnly: result.readOnly,
      authorization: result.authorization,
      operationKinds: result.mutationPlan?.operations.map((operation) => operation.kind) ?? [],
      mutationPlan: result.mutationPlan,
      materials: result.materials,
      execution: result.execution,
      copiedSelectionCode,
    })}\n`,
  );
} finally {
  await workspace.dispose();
}

async function boundedTask(
  intendedPaths: string[],
  repository: { identitySha256: string; revision: string },
): Promise<WorkflowTaskInput> {
  const fixture = JSON.parse(
    await readFile(new URL("./auto-cycle-v1.json", import.meta.url), "utf8"),
  ) as {
    task: WorkflowTaskInput;
  };
  if (fixture.task.kind !== "bounded-doc-improvement") throw new Error("invalid task fixture");
  return {
    ...fixture.task,
    repositoryId: project.fullPath,
    testedCommit: repository.revision,
    repositoryIdentitySha256: repository.identitySha256,
    intendedPaths,
  };
}
