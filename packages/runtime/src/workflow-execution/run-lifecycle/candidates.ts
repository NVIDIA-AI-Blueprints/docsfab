// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Candidate and revision state for one CREATE V3 run. The runner reads live fields. */

import { verifyRetainedRstCandidate } from "../../rst-authoring/workflow.js";
import type { RunRequest } from "../../execution/contracts.js";
import type { HarnessStepResult } from "../../execution/contracts.js";
import type { RunRecord } from "../../records/contracts.js";
import type { WorkflowDefinition } from "../../workflow-contracts/contracts.js";
import {
  createAuthoringExecutionEvidenceV1,
  createAuthoringPartialCandidateV1,
  createAuthoringRevisionAdmissionBindingV1,
  type AuthoringPathSelectionV1,
  type AuthoringRevisionAdmissionBindingV1,
  type AuthoringSelectedProducerSetV1,
} from "../../records/authoring-execution.js";
import type { AuthoringCandidateCaptureV1 } from "../authoring-workspace-host.js";
import type { AuthoringRevisionSessionV1 } from "../authoring-runtime.js";
import { authoringRevisionChangedPaths } from "../authoring-runtime.js";
import { validateAuthoringRevisionMutation } from "../authoring-revision.js";
import type {
  AuthoringProducerBindingV1,
  AuthoringRevisionInputV1,
  AuthoringRevisionValidationContextV1,
} from "../authoring-candidate.js";
import type { ReviewResult } from "../review-response.js";
import {
  documentationPlanPagePaths,
  type AdmittedDocumentationPlanBinding,
} from "../plan-binding.js";
import type { SourceObligationLedger } from "../source-obligation.js";
import type { WorkflowRunnerOptions } from "../runner-ports.js";

export interface RunCandidatePort {
  readonly options: Pick<
    WorkflowRunnerOptions,
    "authoringCandidateLifecycle" | "rstCaptureBinding"
  >;
  readonly request: RunRequest;
  readonly record: RunRecord;
  readonly workflow: WorkflowDefinition;
  readonly isV3: boolean;
  readonly planBindings: ReadonlyMap<string, AdmittedDocumentationPlanBinding>;
  readonly sourceLedger: () => SourceObligationLedger | undefined;
  readonly sourceInput: () =>
    | AuthoringRevisionValidationContextV1["sourceObligationInput"]
    | undefined;
  readonly workspacePath: () => string;
  readonly resetActiveWorkspace: () => void;
  readonly activateRevisionSession: (session: AuthoringRevisionSessionV1) => void;
  readonly noteMaterialization: (captured: boolean) => void;
}

export class RunCandidateLifecycle {
  readonly captures: AuthoringCandidateCaptureV1[] = [];
  branchId: "retain" | "revise" | null = null;
  revisionInput: AuthoringRevisionInputV1 | undefined;
  selection:
    | (Omit<AuthoringPathSelectionV1, "inputSha256" | "requiredStepIds" | "excludedStepIds"> & {
        input: AuthoringPathSelectionV1["input"];
      })
    | null = null;
  selectedOrdinal: 0 | 1 | null = null;
  selectedProducers: AuthoringSelectedProducerSetV1 | null = null;
  partial: ReturnType<typeof createAuthoringPartialCandidateV1> | null = null;
  revisionAdmission: AuthoringRevisionAdmissionBindingV1 | null = null;
  admittedCandidate0Editorial: AuthoringProducerBindingV1<ReviewResult> | undefined;
  revisionSession: AuthoringRevisionSessionV1 | undefined;
  originalSourceSearchSnapshotSha256: string | null = null;
  private revisionDisposed = false;

  constructor(private readonly port: RunCandidatePort) {}

  candidates(): AuthoringCandidateCaptureV1["candidate"][] {
    return this.captures.map((capture) => capture.candidate);
  }

  async disposeRevision(): Promise<void> {
    if (
      !this.revisionDisposed &&
      this.revisionSession &&
      this.port.options.authoringCandidateLifecycle
    ) {
      this.revisionDisposed = true;
      await this.port.options.authoringCandidateLifecycle.dispose(this.revisionSession);
    }
  }

  refreshExecution(includeFinalPatch = false): void {
    if (!this.port.isV3) return;
    const { record, workflow, planBindings } = this.port;
    const plan = planBindings.get("plan-documentation");
    if (!plan) return;
    record.authoringExecution = createAuthoringExecutionEvidenceV1(
      {
        runId: record.id,
        repositoryRevision: record.repository.revision,
        planDigest: plan.digest,
        writePaths: documentationPlanPagePaths(plan),
        sourceSearchSnapshotSha256: this.originalSourceSearchSnapshotSha256,
        sourceObligationLedgerSha256: this.port.sourceLedger()?.digest ?? null,
        technicalCorrectionEvidenceSha256:
          record.steps.find((item) => item.id === "verify-technical-accuracy")
            ?.technicalCorrectionEvidence?.digest ?? null,
        selection: this.selection,
        candidates: this.captures.map((capture) => ({
          candidate: capture.candidate,
          revisionInputDigest: capture.candidate.ordinal === 1 ? this.revisionInput!.digest : null,
        })),
        revisionAdmission: this.revisionAdmission,
        partialCandidate1: this.partial,
        selectedCandidateOrdinal: this.selectedOrdinal,
        selectedProducers: this.selectedProducers,
        includeFinalPatch,
      },
      workflow,
    );
  }

  async sealCandidateZero(): Promise<void> {
    if (this.captures[0]) return;
    const { options, request, record, planBindings } = this.port;
    if (options.rstCaptureBinding?.receipt) {
      await verifyRetainedRstCandidate(this.port.workspacePath(), options.rstCaptureBinding);
    }
    const plan = planBindings.get("plan-documentation");
    const sourceLedger = this.port.sourceLedger();
    if (!plan || !sourceLedger || !options.authoringCandidateLifecycle) {
      throw new Error("CREATE V3 candidate zero requires its admitted plan and source ledger.");
    }
    const capture = await options.authoringCandidateLifecycle.sealCandidate0({
      runId: record.id,
      repository: record.repository,
      planDigest: plan.digest,
      writePaths: documentationPlanPagePaths(plan),
      sourceLedger,
      signal: request.signal,
    });
    this.captures.push(capture);
    this.selectedOrdinal = 0;
    this.originalSourceSearchSnapshotSha256 =
      this.port.sourceInput()?.searchEvidence?.workspaceSnapshotSha256 ?? null;
    this.refreshExecution();
  }

  async captureFailedRevision(failureCode: string): Promise<void> {
    const { options, request, record, planBindings } = this.port;
    if (
      this.partial ||
      !this.revisionSession ||
      !this.revisionInput ||
      !this.captures[0] ||
      !options.authoringCandidateLifecycle
    )
      return;
    let artifact: { sha256: string; byteLength: number } | null = null;
    let workspaceSnapshotDigest: string | null = null;
    try {
      const partial = await options.authoringCandidateLifecycle.captureFailedPartial({
        session: this.revisionSession,
        repository: record.repository,
        signal: request.signal,
      });
      if (partial.evidence.patch && partial.workspaceSnapshotDigest) {
        artifact = {
          sha256: partial.evidence.patch.sha256,
          byteLength: partial.evidence.patch.byteLength,
        };
        workspaceSnapshotDigest = partial.workspaceSnapshotDigest;
      }
    } catch {
      // Failure evidence is optional when the host cannot authenticate the partial child.
    }
    const plan = planBindings.get("plan-documentation");
    if (!plan) return;
    this.partial = createAuthoringPartialCandidateV1({
      runId: record.id,
      inputCandidateDigest: this.captures[0].candidate.digest,
      revisionInputDigest: this.revisionInput.digest,
      originalRevision: record.repository.revision,
      planDigest: plan.digest,
      writePaths: documentationPlanPagePaths(plan),
      artifact,
      workspaceSnapshotDigest,
      failureCode,
    });
  }

  async sealCandidateOne(input: {
    readonly plan: AdmittedDocumentationPlanBinding;
    readonly accounting: NonNullable<HarnessStepResult["authoringRevisionAccounting"]>;
    readonly stepRecord: RunRecord["steps"][number];
  }): Promise<void> {
    const { options, request, record } = this.port;
    const sourceLedger = this.port.sourceLedger();
    if (
      !this.revisionSession ||
      !sourceLedger ||
      !this.revisionInput ||
      !options.authoringCandidateLifecycle
    ) {
      throw new Error("CREATE V3 candidate one requires its sealed revision input and workspace.");
    }
    const capture = await options.authoringCandidateLifecycle.sealCandidate1({
      session: this.revisionSession,
      runId: record.id,
      repository: record.repository,
      planDigest: input.plan.digest,
      writePaths: documentationPlanPagePaths(input.plan),
      sourceLedger,
      signal: request.signal,
    });
    const actualChangedPaths = authoringRevisionChangedPaths(
      this.captures[0]!.snapshot,
      capture.snapshot,
    );
    validateAuthoringRevisionMutation({
      accounting: input.accounting,
      actualChangedPaths,
      candidate0PatchSha256: this.captures[0]!.candidate.patchDigestSha256,
      candidate1PatchSha256: capture.candidate.patchDigestSha256,
    });
    this.revisionAdmission = createAuthoringRevisionAdmissionBindingV1({
      candidate0: this.captures[0]!.candidate,
      candidate1: capture.candidate,
      actualChangedPaths,
      accounting: input.accounting,
    });
    this.captures.push(capture);
    input.stepRecord.authoringRevisionAccounting = input.accounting;
    this.selectedOrdinal = 1;
    this.refreshExecution();
  }

  async prepareRevision(sourceLedger: SourceObligationLedger): Promise<void> {
    const { options, request, record, planBindings } = this.port;
    const createConvertedToUpdate = planBindings.get("plan-documentation")?.createConvertedToUpdate;
    this.revisionSession = await options.authoringCandidateLifecycle!.prepareRevision({
      runId: record.id,
      repository: record.repository,
      candidate0: this.captures[0]!,
      ...(createConvertedToUpdate ? { createConvertedToUpdate } : {}),
      sourceLedger,
      signal: request.signal,
    });
    this.port.activateRevisionSession(this.revisionSession);
  }

  async materializeSelected(): Promise<boolean> {
    const { options, request, record } = this.port;
    if (this.selectedOrdinal === null || !options.authoringCandidateLifecycle) return false;
    const selected = this.captures[this.selectedOrdinal];
    if (!selected) return false;
    if (this.selectedOrdinal === 0) this.port.resetActiveWorkspace();
    if (options.rstCaptureBinding?.receipt) {
      await verifyRetainedRstCandidate(this.port.workspacePath(), options.rstCaptureBinding);
    }
    try {
      record.changes = await options.authoringCandidateLifecycle.materializeSelected({
        capture: selected,
        repository: record.repository,
        ...(this.selectedOrdinal === 1 && this.revisionSession
          ? { revisionSession: this.revisionSession }
          : {}),
      });
      this.port.noteMaterialization(true);
      this.refreshExecution(true);
      return true;
    } catch {
      this.port.noteMaterialization(false);
      this.refreshExecution();
      return false;
    }
  }
}
