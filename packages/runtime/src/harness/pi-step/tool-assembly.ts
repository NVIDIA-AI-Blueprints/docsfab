// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Assemble one step's confined tools before any provider connection opens. */
import {
  isRepositoryBootstrapGuidancePath,
  isRepositoryBootstrapStep,
  REPOSITORY_BOOTSTRAP_STEP,
} from "../../onboarding/bootstrap-result.js";
import { isSourceReadinessStep } from "../../readiness/assessment.js";
import type { HarnessStepInput } from "../../execution/contracts.js";
import type { BoundModelExecutionProfile } from "../../model/configuration.js";
import type { ResolveLimitsOptions } from "../../config/limits.js";
import { buildRepositoryDiscoveryInventory } from "../../repository/inventory.js";
import type { RepositoryWorkspace } from "../../repository/workspace/contracts.js";
import { documentationPlanWritePaths } from "../../workflow-execution/plan-binding.js";
import { createConfinedToolSet, type ConfinedReadTextRendering } from "../confined-tools.js";
import {
  createQualityAnswerRecordTool,
  createQualityCandidateValidationTool,
  createQualitySubmissionTool,
} from "../quality-candidate-tool.js";
import { createSourceObligationAnswerRecordTool } from "../source-obligation-answer-record-tool.js";
import { RawToolCallCapture } from "../answer-submission.js";
import {
  QUALITY_ANSWER_RECORD_TOOL_NAME,
  QUALITY_SUBMISSION_TOOL_NAME,
} from "../answer-submission.js";
import { QUALITY_CANDIDATE_VALIDATION_TOOL_NAME } from "../pi-tool-confine.js";
import { ReadEvidenceLedger, resolveReadLoopPolicy } from "../read-evidence.js";
import type { GitHistoryReader } from "../../repository/git-history.js";

const SOURCE_COORDINATE_REVIEW_SKILLS = new Set([
  "reconcile-product-behavior",
  "verify-technical-accuracy",
  "review-documentation",
  "evaluate-document-quality",
]);

/**
 * Source-coordinate rendering shows each read line's physical number. Review
 * skills cite by those numbers, and the two steps whose citations the host
 * mints (source readiness and repository bootstrap) may cite only lines a read
 * showed, so their reads also carry the coordinates their locators name.
 */
export function readTextRenderingForStep(
  input: Pick<HarnessStepInput, "workflow" | "step">,
): ConfinedReadTextRendering {
  const { step } = input;
  if (isSourceReadinessStep(input) || isRepositoryBootstrapStep(input)) return "source-coordinates";
  return step.mode === "read-only" && SOURCE_COORDINATE_REVIEW_SKILLS.has(step.skill)
    ? "source-coordinates"
    : "raw";
}

export interface PiStepToolAssemblyInput {
  readonly step: HarnessStepInput;
  readonly repositoryWorkspace?: RepositoryWorkspace;
  readonly historyReader?: GitHistoryReader;
  readonly grantedTools: readonly string[];
  readonly skill: { readonly name: string; readonly directory: string };
  readonly limits?: ResolveLimitsOptions;
  readonly qualityDirectory?: string;
  readonly toolOutputCapBytes?: number;
  readonly toolResultRecall?: boolean;
  readonly reviewReadMaxObjectBytes?: number;
  readonly technicalVerification?: HarnessStepInput["technicalVerification"];
  readonly answerSubmission?: BoundModelExecutionProfile["answerSubmission"];
  readonly toolPath: boolean;
  readonly rawToolCalls: RawToolCallCapture;
}

export async function assemblePiStepTools({
  step: input,
  repositoryWorkspace,
  historyReader,
  grantedTools,
  skill,
  limits,
  qualityDirectory,
  toolOutputCapBytes,
  toolResultRecall,
  reviewReadMaxObjectBytes,
  technicalVerification,
  answerSubmission,
  toolPath,
  rawToolCalls,
}: PiStepToolAssemblyInput) {
  const signedPaths =
    input.task?.kind === "bounded-doc-improvement" ? input.task.intendedPaths : undefined;
  const planPaths = input.planBinding ? documentationPlanWritePaths(input.planBinding) : undefined;
  const allowedWritePaths =
    signedPaths && planPaths
      ? signedPaths.filter((path) => planPaths.includes(path))
      : (planPaths ?? signedPaths);
  const observationInventory =
    repositoryWorkspace && input.step.search && input.searchEvidence
      ? await buildRepositoryDiscoveryInventory({ workspace: repositoryWorkspace })
      : undefined;
  if (
    observationInventory &&
    observationInventory.inventorySha256 !== input.searchEvidence?.workspaceSnapshotSha256
  ) {
    throw new Error("Observation workspace snapshot no longer matches search evidence.");
  }
  // The ledger is attempt-scoped: a new call ID cannot masquerade as new read progress.
  const readEvidence = new ReadEvidenceLedger(resolveReadLoopPolicy(limits));
  const confinedTools = await createConfinedToolSet({
    workspacePath: input.repositoryPath,
    readEvidence,
    allowWrite:
      input.step.mode === "write" && input.step.kind !== "evaluate" && !input.rstAuthoring,
    ...(input.workflow.name === "bootstrap" && input.step.id === REPOSITORY_BOOTSTRAP_STEP
      ? { isWritePathAllowed: isRepositoryBootstrapGuidancePath }
      : {}),
    readTextRendering: readTextRenderingForStep(input),
    ...(input.workflow.name === "review-documentation" &&
    input.step.id === "verify-technical-accuracy" &&
    input.step.skill === "verify-technical-accuracy" &&
    input.step.mode === "read-only" &&
    reviewReadMaxObjectBytes !== undefined
      ? { reviewReadMaxObjectBytes }
      : {}),
    ...(input.workflow.name === "review-documentation" &&
    input.step.id === "verify-technical-accuracy" &&
    input.step.skill === "verify-technical-accuracy" &&
    input.step.mode === "read-only" &&
    input.reviewChangeSource &&
    reviewReadMaxObjectBytes !== undefined
      ? {
          reviewChangeSource: input.reviewChangeSource,
          reviewChangeRunId: input.runId,
          reviewChangeStepId: input.step.id,
        }
      : {}),
    ...(input.evidenceIdentity?.repositoryRevision
      ? { repositoryRevision: input.evidenceIdentity.repositoryRevision }
      : {}),
    ...(input.step.search ? { search: input.step.search } : {}),
    ...(observationInventory && repositoryWorkspace
      ? {
          workspaceSnapshotSha256: observationInventory.inventorySha256,
          repositoryWorkspace,
          repositoryInventory: observationInventory,
        }
      : {}),
    ...(input.sourceReader ? { sourceReader: input.sourceReader } : {}),
    ...(input.preservationSourceReader
      ? { preservationSourceReader: input.preservationSourceReader }
      : {}),
    ...(input.preservationSourceObservationCache
      ? { preservationSourceObservationCache: input.preservationSourceObservationCache }
      : {}),
    ...(input.sourceSearcher ? { sourceSearcher: input.sourceSearcher } : {}),
    ...(input.sourceCiter ? { sourceCiter: input.sourceCiter } : {}),
    ...(historyReader ? { historyReader } : {}),
    ...(allowedWritePaths && input.step.mode === "write" && input.step.kind !== "evaluate"
      ? { allowedWritePaths }
      : {}),
    governedSkill: { id: skill.name, directory: skill.directory },
    ...(qualityDirectory ? { governedQualityDirectory: qualityDirectory } : {}),
    ...(toolOutputCapBytes === undefined ? {} : { toolOutputCapBytes }),
    ...(toolResultRecall === true ? { toolResultRecall: true } : {}),
    ...(limits ? { limits } : {}),
    ...(!input.qualityAnswerRecords &&
    technicalVerification &&
    grantedTools.includes(QUALITY_CANDIDATE_VALIDATION_TOOL_NAME)
      ? {
          qualityCandidateValidationTool: createQualityCandidateValidationTool({
            selection: input.qualityProfileSelection!,
            technicalVerification,
            ...(toolPath && answerSubmission
              ? {
                  submission: {
                    argumentShell: answerSubmission.argumentShell,
                    rawArguments: (toolCallId: string) => rawToolCalls.textOfCall(toolCallId),
                  },
                }
              : {}),
          }),
        }
      : {}),
    ...(toolPath && answerSubmission && grantedTools.includes(QUALITY_SUBMISSION_TOOL_NAME)
      ? {
          qualitySubmissionTool: createQualitySubmissionTool({
            selection: input.qualityProfileSelection!,
            argumentShell: answerSubmission.argumentShell,
          }),
        }
      : {}),
    ...(input.qualityAnswerRecords && grantedTools.includes(QUALITY_ANSWER_RECORD_TOOL_NAME)
      ? {
          qualityAnswerRecordTool: createQualityAnswerRecordTool(
            input.qualityAnswerRecords,
            input.qualityAnswerRecordGuidance,
          ),
        }
      : {}),
    ...(input.sourceObligationAnswerRecords &&
    grantedTools.includes(QUALITY_ANSWER_RECORD_TOOL_NAME)
      ? {
          qualityAnswerRecordTool: createSourceObligationAnswerRecordTool(
            input.sourceObligationAnswerRecords,
            input.sourceObligationAnswerRecordGuidance ??
              "Submit separate per-dimension and per-obligation records.",
          ),
        }
      : {}),
  });
  const confinedToolDefinitions =
    input.toolCeiling === undefined && input.qualityAnswerRecords === undefined
      ? confinedTools.definitions
      : confinedTools.definitions.filter((definition) => grantedTools.includes(definition.name));
  return { readEvidence, confinedTools, confinedToolDefinitions };
}
