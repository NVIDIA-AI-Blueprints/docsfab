// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  AgentHarness,
  HarnessStepInput,
  HarnessStepResult,
} from "../../src/execution/contracts.js";
import type {
  EditorialDecisionArtifactReferenceV3,
  EditorialDecisionPayloadV1,
} from "../../src/artifacts/contracts.js";
import type { WorkflowBranchEvidenceHost } from "../../src/workflow-contracts/contracts.js";
import type { WorkflowOutcomeDecodeOptionsV1 } from "../../src/workflow-contracts/outcome.js";
import { decodeWorkflowBranchCoverageV1 } from "../../src/workflow-contracts/branch-coverage.js";
import { workflowBranchCoverageDecodeOptionsV1 } from "../../src/records/composition-execution.js";
import { getWorkflow } from "../../src/workflow-registry/catalog.js";

type ScriptedCandidate = "update" | "insufficient-evidence";

/**
 * Supplies only deterministic protocol mechanics for runner fixtures. It does
 * not represent model-quality or source-validation evidence.
 */
export function scriptedEditorialProtocol(
  harness: AgentHarness,
  candidate: ScriptedCandidate = "update",
  validatedDecision: ScriptedValidatedDecision = {},
): {
  harness: AgentHarness;
  workflowBranchEvidence: WorkflowBranchEvidenceHost;
  decodeOptions: WorkflowOutcomeDecodeOptionsV1;
} {
  const workflowBranchEvidence = scriptedBranchEvidence(candidate, validatedDecision);
  return {
    harness: withScriptedEditorialProposals(harness),
    workflowBranchEvidence,
    decodeOptions: {
      decodeEditorialDecision: (reference, stepId) =>
        workflowBranchEvidence.decodeEditorialDecision(reference, stepId),
      decodeWorkflowBranchCoverage: (value, record) =>
        decodeWorkflowBranchCoverageV1(
          value,
          workflowBranchCoverageDecodeOptionsV1({
            workflow: getWorkflow(record.workflow),
            record,
            requireComplete: record.status === "succeeded",
          }),
        ),
    },
  };
}

function withScriptedEditorialProposals(harness: AgentHarness): AgentHarness {
  return {
    ...(harness.inspectSkill ? { inspectSkill: harness.inspectSkill.bind(harness) } : {}),
    runStep: async (input: HarnessStepInput): Promise<HarnessStepResult> => {
      const result = await harness.runStep(input);
      if (input.step.id === "plan-documentation") {
        return { ...result, editorialDecisionProposal: {} };
      }
      if (
        input.step.id === "verify-technical-accuracy" ||
        input.step.id === "review-documentation" ||
        input.step.id === "test-audience-understanding" ||
        input.step.id === "evaluate-document-quality"
      ) {
        return { ...result, editorialAssessmentProposal: {} };
      }
      return result;
    },
  };
}

/**
 * What the validated decision says when it differs from the candidate: a
 * reversed candidate, or model-authored limitation codes.
 */
export interface ScriptedValidatedDecision {
  readonly candidate?: ScriptedCandidate;
  readonly limitations?: readonly string[];
}

function scriptedBranchEvidence(
  candidate: ScriptedCandidate,
  validatedDecision: ScriptedValidatedDecision,
): WorkflowBranchEvidenceHost {
  let candidateReference: EditorialDecisionArtifactReferenceV3 | undefined;
  let repositoryRevision = "0".repeat(40);
  let planBindingSha256 = "0".repeat(64);
  let coverageSha256: string | undefined;
  const workspaceSnapshotSha256 = "9".repeat(64);
  return {
    select: async ({ record }) => {
      repositoryRevision = record.repository.revision;
      planBindingSha256 = record.steps[0]?.planBinding?.digest ?? planBindingSha256;
      candidateReference = reference("7", repositoryRevision);
      return {
        candidate,
        branchId: candidate === "update" ? "author" : null,
        workspaceSnapshotSha256,
        candidateArtifact: candidateReference,
      };
    },
    observeAssessment: async () => undefined,
    finalize: async ({ record, coverageSha256: admittedCoverageSha256 }) => {
      repositoryRevision = record.repository.revision;
      coverageSha256 = admittedCoverageSha256;
      return reference("6", repositoryRevision);
    },
    decodeEditorialDecision: (artifact, stepId) =>
      decision({
        artifact,
        candidate,
        candidateReference: candidateReference!,
        planBindingSha256,
        workspaceSnapshotSha256,
        validated: stepId === "evaluate-document-quality",
        coverageSha256,
        validatedDecision,
      }),
  };
}

function reference(
  digestCharacter: string,
  repositoryRevision: string,
): EditorialDecisionArtifactReferenceV3 {
  return {
    kind: "editorial-decision",
    schemaVersion: 3,
    digest: digestCharacter.repeat(64),
    repositoryRevision,
    repositoryContentDigest: "8".repeat(64),
  };
}

function decision(input: {
  artifact: EditorialDecisionArtifactReferenceV3;
  candidate: ScriptedCandidate;
  candidateReference: EditorialDecisionArtifactReferenceV3;
  planBindingSha256: string;
  workspaceSnapshotSha256: string;
  validated: boolean;
  coverageSha256: string | undefined;
  validatedDecision: ScriptedValidatedDecision;
}): EditorialDecisionPayloadV1 {
  return {
    schemaVersion: 1,
    kind: "docsfab-editorial-decision",
    phase: input.validated ? "validated" : "candidate",
    candidateArtifact: input.validated ? input.candidateReference : null,
    branchCoverage:
      input.validated && input.coverageSha256
        ? {
            schemaVersion: 1,
            kind: "docsfab-workflow-branch-coverage-reference",
            coverageSha256: input.coverageSha256,
          }
        : null,
    candidate: input.validated
      ? (input.validatedDecision.candidate ?? input.candidate)
      : input.candidate,
    repositoryRevision: input.artifact.repositoryRevision,
    workspaceSnapshotSha256: input.workspaceSnapshotSha256,
    readerProvenanceSha256: "1".repeat(64),
    planBindingSha256: input.planBindingSha256,
    policySha256: "2".repeat(64),
    comparison: { kind: "workspace", snapshot_sha256: input.workspaceSnapshotSha256 },
    rationaleSha256: "3".repeat(64),
    evidenceRefs: input.validated
      ? [input.candidateReference]
      : [
          {
            kind: "context-packet",
            schemaVersion: 1,
            digest: "e".repeat(64),
            repositoryRevision: input.artifact.repositoryRevision,
            repositoryContentDigest: "f".repeat(64),
          },
        ],
    limitations: input.validated ? [...(input.validatedDecision.limitations ?? [])] : [],
    decisionSha256: input.artifact.digest,
  };
}
