// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** The run's single owner for change capture and mutation postflight attempts. */

import { verifyRetainedRstCandidate } from "../../rst-authoring/workflow.js";
import { RstRegionError } from "../../rst-authoring/contracts.js";
import type { RunRequest } from "../../execution/contracts.js";
import type { RunRecord } from "../../records/contracts.js";
import type { ChangedFileEvidence } from "../../impact/contracts.js";
import {
  appendEvidenceWarnings,
  captureChanges,
  normalizeImpactPostflight,
} from "../runner-evidence.js";
import type { WorkflowRunnerOptions } from "../runner-ports.js";

export interface RunFinalizationPort {
  readonly request: RunRequest;
  readonly record: RunRecord;
  readonly options: Pick<WorkflowRunnerOptions, "rstCaptureBinding" | "impactPostflight">;
  readonly workspacePath: () => string;
  readonly repositoryEvidence: () => WorkflowRunnerOptions["repositoryEvidence"];
  readonly writeExecutionStarted: () => boolean;
  readonly selectedHasWriteStep: () => boolean;
  readonly assessNoChange: () => boolean;
}

export function createRunFinalization(port: RunFinalizationPort) {
  const { request, record, options } = port;
  let impactPostflightAttempted = false;
  let impactPostflightSucceeded = true;
  let evidenceCaptureAttempted = false;
  let evidenceCaptureSucceeded = false;
  let evidenceCaptureProvenanceRejected = false;
  let rstCaptureFailureMessage: string | undefined;
  let changedFiles: readonly ChangedFileEvidence[] = [];
  let changedFilesCaptured = false;

  const captureChangedFilesOnce = async (): Promise<boolean> => {
    if (changedFilesCaptured) return true;
    changedFilesCaptured = true;
    const repositoryEvidence = port.repositoryEvidence();
    if (!repositoryEvidence) return true;
    if (record.changes) {
      changedFiles = structuredClone(record.changes.files);
      return true;
    }
    try {
      const changes = await repositoryEvidence.capture({
        runId: record.id,
        repository: record.repository,
        workspacePath: port.workspacePath(),
        persistPatch: false,
      });
      changedFiles = changes.files;
      record.changes = { files: [...changes.files] };
      return true;
    } catch {
      return false;
    }
  };

  const captureChangesOnce = async (): Promise<boolean> => {
    if (evidenceCaptureAttempted) return evidenceCaptureSucceeded;
    evidenceCaptureAttempted = true;
    if (options.rstCaptureBinding?.receipt) {
      try {
        await verifyRetainedRstCandidate(port.workspacePath(), options.rstCaptureBinding);
      } catch (error) {
        if (!(error instanceof RstRegionError)) throw error;
        rstCaptureFailureMessage = error.message;
        record.evidenceWarnings = [...(record.evidenceWarnings ?? []), error.message];
        return false;
      }
    }
    if (port.assessNoChange()) {
      evidenceCaptureSucceeded = true;
      return true;
    }
    const captureResult = await captureChanges({
      repositoryEvidence: port.repositoryEvidence(),
      record,
      workspacePath: port.workspacePath(),
      persistPatch: port.selectedHasWriteStep(),
    });
    evidenceCaptureSucceeded = captureResult.captured;
    evidenceCaptureProvenanceRejected = captureResult.provenanceRejected;
    return evidenceCaptureSucceeded;
  };

  const captureAuthorizedWritePaths = async (): Promise<void> => {
    const repositoryEvidence = port.repositoryEvidence();
    if (!repositoryEvidence) return;
    try {
      const changes = await repositoryEvidence.capture({
        runId: record.id,
        repository: record.repository,
        workspacePath: port.workspacePath(),
        persistPatch: false,
      });
      record.changes = { files: changes.files };
    } catch {
      // Later search quarantines unnamed dirty paths instead of admitting them.
    }
  };

  const runImpactPostflightOnce = async (): Promise<boolean> => {
    if (request.signal?.aborted) return true;
    if (!port.writeExecutionStarted() || !options.impactPostflight) return true;
    if (impactPostflightAttempted) return impactPostflightSucceeded;
    impactPostflightAttempted = true;
    try {
      if (!(await captureChangedFilesOnce())) {
        throw new Error("Repository change evidence could not be captured for impact postflight.");
      }
      const warnings: string[] = [];
      record.impactPostflight = normalizeImpactPostflight(
        await options.impactPostflight.postflight({
          runId: record.id,
          workflow: record.workflow,
          repository: record.repository,
          workspacePath: port.workspacePath(),
          changedFiles,
          recordWarning: (warning) => warnings.push(warning),
        }),
      );
      appendEvidenceWarnings(record, warnings);
      impactPostflightSucceeded = true;
    } catch {
      record.impactPostflight = {
        schemaVersion: 1,
        status: "failed",
        reason: "analysis-failed",
      };
      impactPostflightSucceeded = false;
    }
    return impactPostflightSucceeded;
  };

  return {
    captureChangedFilesOnce,
    captureChangesOnce,
    captureAuthorizedWritePaths,
    runImpactPostflightOnce,
    captureCleanPlannerProbe: () =>
      captureChanges({
        repositoryEvidence: port.repositoryEvidence(),
        record,
        workspacePath: port.workspacePath(),
        persistPatch: false,
      }),
    noteCandidateMaterialization(captured: boolean): void {
      if (captured) {
        changedFiles = structuredClone(record.changes!.files);
        changedFilesCaptured = true;
      }
      evidenceCaptureAttempted = true;
      evidenceCaptureSucceeded = captured;
    },
    async finalizeMutationOnce(): Promise<{
      impactSucceeded: boolean;
      evidenceCaptured: boolean;
      provenanceRejected: boolean;
    }> {
      const impactSucceeded = await runImpactPostflightOnce();
      const evidenceCaptured = await captureChangesOnce();
      return {
        impactSucceeded,
        evidenceCaptured,
        provenanceRejected: evidenceCaptureProvenanceRejected,
      };
    },
    get rstCaptureFailureMessage() {
      return rstCaptureFailureMessage;
    },
  };
}
