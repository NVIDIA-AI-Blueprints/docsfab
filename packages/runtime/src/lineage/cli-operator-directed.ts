// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Operator-directed task lineage for write-capable `docsfab run --instruction`.
 *
 * Mints host-authenticated lineage at the CLI boundary so directed runs carry
 * digest-bound provenance without the autonomy cycle host. Instruction bodies
 * never enter the lineage record; only bounded request and task digests do.
 */

import { createHash } from "node:crypto";

import type { WorkflowName, WorkflowTaskInput } from "../workflow-contracts/contracts.js";
import { canonicalDigest } from "../content-ir/canonical.js";
import * as workflowCatalog from "../workflow-registry/catalog.js";
import { getWorkflow } from "../workflow-registry/catalog.js";
import { internalCreateTaskLineageHostAuthority } from "./authority-internal.js";
import {
  createBoundedInstructionRequestIdentity,
  createTaskLineageArtifacts,
  createWorkflowLineageCandidate,
  mintTaskLineageHostCapability,
  type DecisionAttributionInputV1,
  type DecisionLineageInputV1,
  type OperatorTaskApprovalV1,
  type TaskLineageArtifactsV1,
  type TaskLineageRepositoryBindingV1,
  type TaskOriginInputV1,
} from "./contracts.js";

export interface CliOperatorDirectedLineageInput {
  instruction: string;
  task: WorkflowTaskInput | null;
  workflow: WorkflowName;
  repository: TaskLineageRepositoryBindingV1;
  authorityId: string;
  runId?: string;
}

export interface CliOperatorDirectedLineageMintInput extends CliOperatorDirectedLineageInput {
  now?: () => Date;
}

const DEFAULT_AUTHORITY_ID = "local-operator";

export function resolveCliOperatorAuthorityId(): string {
  const fromEnv = process.env.DOCSFAB_OPERATOR_AUTHORITY_ID?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : DEFAULT_AUTHORITY_ID;
}

/**
 * Build authentic operator-directed lineage inputs for a bounded CLI instruction.
 * `--allow-write` on a write-capable workflow is the operator approval anchor.
 */
export function buildCliOperatorDirectedLineageInputs(input: CliOperatorDirectedLineageInput): {
  origin: TaskOriginInputV1;
  lineage: Omit<DecisionLineageInputV1, "originSha256">;
} {
  const { instruction, task, workflow, repository, authorityId, runId } = input;
  const requestIdentity = createBoundedInstructionRequestIdentity(
    instruction,
    task,
    workflow,
    repository,
    workflowCatalog,
  );
  const operatorIdentitySha256 = createHash("sha256").update(authorityId).digest("hex");
  const approvalSha256 = canonicalDigest({
    kind: "docsfab-cli-run-operator-approval",
    authorityId,
    operatorIdentitySha256,
    approvedRequestSha256: requestIdentity.requestSha256,
    approvedTaskSha256: requestIdentity.taskSha256,
    workflow,
    repository,
    allowWrite: true,
  });
  const approval: OperatorTaskApprovalV1 = {
    authorityId,
    operatorIdentitySha256,
    approvalSha256,
    approvedRequestSha256: requestIdentity.requestSha256,
    approvedTaskSha256: requestIdentity.taskSha256,
    approvedRecommendationSha256: null,
  };
  const lineageId = runId
    ? `cli-run:${runId}`
    : `cli-run:${requestIdentity.requestSha256.slice(0, 16)}`;
  const origin: TaskOriginInputV1 = {
    lineageId,
    repository,
    origin: "operator-directed",
    selectedBy: "operator",
    request: requestIdentity,
    approval,
    recommendation: null,
    autonomousSelection: null,
  };

  const stepIds = getWorkflow(workflow).steps.map((step) => step.id);
  const workflowContractSha256 = canonicalDigest({
    kind: "docsfab-workflow-contract",
    workflow,
    stepIds,
  });
  const lineageCandidate = createWorkflowLineageCandidate(
    {
      id: `cli-run-candidate:${workflow}`,
      workflow,
      taskSha256: requestIdentity.taskSha256,
      prerequisiteIds: ["cli-run-write-authorization"],
      prerequisiteEvidenceSha256s: [approvalSha256],
      eligibility: "eligible",
      reasonCode: "operator-directed",
    },
    workflowCatalog,
  );

  const hostDigest = (label: string): string =>
    canonicalDigest({
      kind: "docsfab-cli-run-host-policy-ceiling",
      label,
      approvalSha256,
      workflow,
      repository,
    });

  const taskDecision: DecisionAttributionInputV1 = {
    id: "decision:task",
    domain: "task",
    actor: "operator",
    effect: "authoritative",
    outcomeSha256: requestIdentity.taskSha256,
    authoritySource: "operator-approval",
    authoritySha256: approvalSha256,
    evidenceSha256s: [requestIdentity.requestSha256],
    boundedByDecisionIds: [],
    reasonCode: "operator-directed",
  };
  const repositoryDecision: DecisionAttributionInputV1 = {
    id: "decision:repository",
    domain: "repository",
    actor: "host-policy",
    effect: "authoritative",
    outcomeSha256: repository.identitySha256,
    authoritySource: "host-policy",
    authoritySha256: hostDigest("repository"),
    evidenceSha256s: [repository.identitySha256],
    boundedByDecisionIds: [],
    reasonCode: "workspace-ceiling",
  };
  const workflowDecision: DecisionAttributionInputV1 = {
    id: "decision:workflow",
    domain: "workflow",
    actor: "deterministic-workflow",
    effect: "authoritative",
    outcomeSha256: lineageCandidate.candidateSha256,
    authoritySource: "workflow-contract",
    authoritySha256: workflowContractSha256,
    evidenceSha256s: [approvalSha256],
    boundedByDecisionIds: [],
    reasonCode: "eligible-candidate-selected",
  };

  const hostPolicyDecision = (
    id: string,
    domain: DecisionAttributionInputV1["domain"],
    reasonCode: string,
  ): DecisionAttributionInputV1 => ({
    id,
    domain,
    actor: "host-policy",
    effect: "authoritative",
    outcomeSha256: hostDigest(`${domain}:outcome`),
    authoritySource: "host-policy",
    authoritySha256: hostDigest(`${domain}:authority`),
    evidenceSha256s: [approvalSha256],
    boundedByDecisionIds: [],
    reasonCode,
  });

  const lineage: Omit<DecisionLineageInputV1, "originSha256"> = {
    lineageId,
    candidates: [
      {
        id: lineageCandidate.id,
        workflow: lineageCandidate.workflow,
        taskSha256: lineageCandidate.taskSha256,
        prerequisiteIds: lineageCandidate.prerequisiteIds,
        prerequisiteEvidenceSha256s: lineageCandidate.prerequisiteEvidenceSha256s,
        eligibility: lineageCandidate.eligibility,
        reasonCode: lineageCandidate.reasonCode,
      },
    ],
    selectedCandidateSha256: lineageCandidate.candidateSha256,
    selectedSourceAutoCandidateSha256: null,
    rejectedAlternatives: [],
    decisions: [
      taskDecision,
      repositoryDecision,
      workflowDecision,
      hostPolicyDecision("decision:scope", "scope", "workflow-scope-ceiling"),
      hostPolicyDecision("decision:path", "path", "documentation-path-ceiling"),
      hostPolicyDecision("decision:write", "write", "single-write-ceiling"),
      hostPolicyDecision("decision:validation", "validation", "required-validation-ceiling"),
      hostPolicyDecision("decision:tracker", "tracker", "tracker-observe-only-ceiling"),
      hostPolicyDecision("decision:publication", "publication", "single-draft-mr-ceiling"),
    ],
  };
  return { origin, lineage };
}

/** Mint host-authenticated operator-directed lineage for a CLI bounded instruction. */
export async function mintCliOperatorDirectedLineage(
  input: CliOperatorDirectedLineageMintInput,
): Promise<TaskLineageArtifactsV1> {
  const now = input.now ?? (() => new Date());
  const lineageInputs = buildCliOperatorDirectedLineageInputs(input);
  const authority = internalCreateTaskLineageHostAuthority({
    async verifyCurrent(challenge) {
      return {
        status: "current" as const,
        challengeSha256: challenge.challengeSha256,
        observedAt: now().toISOString(),
        authorityReceiptSha256: canonicalDigest({
          kind: "docsfab-cli-run-lineage-receipt",
          challengeSha256: challenge.challengeSha256,
        }),
      };
    },
  });
  const capability = await mintTaskLineageHostCapability(
    lineageInputs as never,
    authority,
    workflowCatalog,
  );
  return createTaskLineageArtifacts(capability);
}
