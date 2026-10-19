// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { canonicalDigest, sha256 } from "../src/content-ir/canonical.js";
import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../src/json-evidence.js";
import {
  authoringArtifactReadbackRequirements,
  authoringPhaseInvocationBindingV1,
  createAuthoringExecutionEvidenceV1,
  createAuthoringPartialCandidateV1,
  createAuthoringPhaseEvidenceV1,
  createAuthoringRevisionAdmissionBindingV1,
  decodeAuthoringPhaseInvocationBindingV1,
  decodeRetainedAuthoringWorkflowV1,
  validateAuthoringRunRecordV1,
  type AuthoringProducerSummaryBindingV1,
} from "../src/records/authoring-execution.js";
import type { RunRecord, StepRunRecord } from "../src/records/contracts.js";
import { reconstructCompositionWorkflowPathV1 } from "../src/records/composition-execution.js";
import {
  decodeScorecardAuthoringExecutionEvidenceV1,
  decodeScorecardAuthoringPhaseEvidenceV1,
} from "../src/scorecard-record.js";
import { documentationAuditSearch } from "../src/maturity/audit-search-plan.js";
import { documentationObservationSearch } from "../src/search/observation-search-plan.js";
import {
  authoringPrefixPhaseForStep,
  authoringSelectedPath,
} from "../src/workflow-contracts/authoring-schedule.js";
import type {
  WorkflowAuthoringBranchIdV3,
  WorkflowAuthoringPhaseV3,
  WorkflowDefinition,
} from "../src/workflow-contracts/contracts.js";
import { createAuthoringCandidate } from "../src/workflow-execution/authoring-candidate.js";
import type { AuthoringRevisionAccountingV1 } from "../src/workflow-execution/authoring-revision.js";
import { sealDocumentationPlanBinding } from "../src/workflow-execution/plan-binding.js";
import {
  issueOriginalSourceAuthorityAdmission,
  sealOriginalSourceAuthority,
  type OriginalSourceAuthorityAdmission,
} from "../src/workflow-execution/source-obligation-authority.js";
import {
  TECHNICAL_CORRECTION_PROPOSAL_KIND,
  bindSourceObligationLedgerV2,
  bindTechnicalCorrectionResponseV2,
  bindHostOwnedTechnicalCorrectionProposalV3,
  sourceObligationScopeSha256,
  type SourceObligationLedgerV2,
  type TechnicalCorrectionEvidenceV2,
  type TechnicalCorrectionEvidenceV3,
} from "../src/workflow-execution/source-obligation.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import { parseWorkflowManifestSnapshot } from "../src/workflow-registry/manifest.js";
import { authoringManifestV3 } from "./helpers/authoring-manifest.js";
import {
  createRealAuthoringEvidenceFixture,
  type RealAuthoringEvidenceFixture,
} from "./helpers/authoring-evidence.js";

const HASH = (digit: string) => digit.repeat(64);
const RUN_ID = "authoring-run";
const REVISION = HASH("a");
const WRITE_PATHS = ["docs/guide.md"] as const;

const workflow = parseWorkflowManifestSnapshot(authoringManifestV3(), "create-documentation", {
  "documentation-audit": documentationAuditSearch,
  "documentation-observation": documentationObservationSearch,
});

let retainFixture: RealAuthoringEvidenceFixture;
let reviseFixture: RealAuthoringEvidenceFixture;
let candidate0: RealAuthoringEvidenceFixture["candidate0"];
let candidate1: RealAuthoringEvidenceFixture["candidate0"];
let REVISION_INPUT: string;
let v2Ledger: SourceObligationLedgerV2;
let v2Correction: TechnicalCorrectionEvidenceV2;
let v2Authority: ReturnType<typeof sealOriginalSourceAuthority>["evidence"];
let v2Admission: OriginalSourceAuthorityAdmission;
let v3Correction: TechnicalCorrectionEvidenceV3;
let v3TechnicalResult: RealAuthoringEvidenceFixture["technicalResult"];

beforeAll(async () => {
  [retainFixture, reviseFixture] = await Promise.all([
    createRealAuthoringEvidenceFixture(workflow, {
      actionable: false,
      runId: RUN_ID,
      revision: REVISION,
    }),
    createRealAuthoringEvidenceFixture(workflow, {
      actionable: true,
      runId: RUN_ID,
      revision: REVISION,
    }),
  ]);
  candidate0 = reviseFixture.candidate0;
  candidate1 = createAuthoringCandidate({
    runId: RUN_ID,
    ordinal: 1,
    originalRevision: REVISION,
    planDigest: reviseFixture.plan.digest,
    writePaths: WRITE_PATHS,
    patchDigestSha256: HASH("3"),
    patchBytes: 202,
    workspaceSnapshotDigest: HASH("4"),
  });
  if (reviseFixture.selection.kind !== "revise") throw new Error("revision fixture did not revise");
  REVISION_INPUT = reviseFixture.selection.input.digest;
  const scopeSha256 = sourceObligationScopeSha256({ workflow, planBinding: retainFixture.plan });
  const sealed = sealOriginalSourceAuthority({
    runId: RUN_ID,
    scope: "create-plan-sources",
    repositoryRevision: REVISION,
    scopeSha256,
    workspaceSnapshotSha256: retainFixture.searchEvidence.workspaceSnapshotSha256,
    members: retainFixture.ledger.identity.sources.map((source) => ({
      path: source.path,
      mode: 0o644,
      byteLength: 1,
      sourceSha256: source.sha256,
    })),
  });
  v2Authority = sealed.evidence;
  v2Ledger = bindSourceObligationLedgerV2(
    {
      completeness: retainFixture.ledger.completeness,
      dimensions: retainFixture.ledger.dimensions,
      limitations: retainFixture.ledger.limitations,
    },
    {
      workflow,
      evidenceIdentity: { repositoryRevision: REVISION },
      searchEvidence: retainFixture.searchEvidence,
      planBinding: retainFixture.plan,
    },
    retainFixture.ledger.identity.sources,
    v2Authority,
  );
  v2Admission = issueOriginalSourceAuthorityAdmission({
    capture: sealed.capture,
    observer: {
      observe: async (paths) =>
        paths.map((path) => ({
          path,
          sha256: retainFixture.ledger.identity.sources.find((source) => source.path === path)!
            .sha256,
        })),
    },
    runId: RUN_ID,
    repositoryRevision: REVISION,
    scopeSha256,
    workspaceSnapshotSha256: retainFixture.searchEvidence.workspaceSnapshotSha256,
  });
  v2Correction = (
    await bindTechnicalCorrectionResponseV2(
      { verificationResult: retainFixture.technicalResult, obligationAccounting: [] },
      v2Ledger,
      v2Admission,
      RUN_ID,
      (value) => value as typeof retainFixture.technicalResult,
    )
  ).evidence;
  const v3 = await bindHostOwnedTechnicalCorrectionProposalV3(
    {
      kind: TECHNICAL_CORRECTION_PROPOSAL_KIND,
      schemaVersion: 3,
      verdict: retainFixture.technicalResult.review.verdict,
      coverage: retainFixture.technicalResult.coverage,
      factInventory: retainFixture.technicalResult.factInventory,
      issueJudgments: [],
      obligationAccounting: [],
    },
    v2Ledger,
    v2Admission,
    RUN_ID,
    WRITE_PATHS,
  );
  v3Correction = v3.evidence;
  v3TechnicalResult = v3.verificationResult;
});

afterAll(async () => {
  await Promise.all([retainFixture?.dispose(), reviseFixture?.dispose()]);
});

describe("portable CREATE authoring execution evidence", () => {
  it.each([
    ["retain", 9, 0],
    ["revise", 14, 1],
  ] as const)("reconstructs the exact %s path", (branchId, count, selectedOrdinal) => {
    const record = successfulRecord(branchId);
    const decoded = validateAuthoringRunRecordV1(record, workflow, {
      requireTerminalSuccess: true,
    });

    expect(record.steps).toHaveLength(count);
    expect(record.steps.map((step) => step.id)).toEqual(decoded.selection?.requiredStepIds);
    expect(decoded.selectedCandidate?.ordinal).toBe(selectedOrdinal);
    expect(
      reconstructCompositionWorkflowPathV1(record, workflow).steps.map((step) => step.id),
    ).toEqual(decoded.selection?.requiredStepIds);
    expect(authoringArtifactReadbackRequirements(decoded).map((artifact) => artifact.name)).toEqual(
      selectedOrdinal === 0 ? ["candidate-0.patch"] : ["candidate-0.patch", "candidate-1.patch"],
    );
  });

  it("reconstructs a canonical producer summary containing quoted multiline text", () => {
    const record = successfulRecord("retain");
    const editorialResult = {
      verdict: "needs-revision" as const,
      issues: [
        {
          id: "STYLE-001",
          severity: "minor",
          category: "style_compliance",
          location: WRITE_PATHS[0],
          finding: 'The generic example calls setValue("")\nand then continues.',
          evidence: { source_id: "source", locator: "src/contract.ts:1-3" },
          required_change: "Clarify the generic example.",
        },
      ],
    };
    const summary = canonicalizeJsonEvidence(
      editorialResult as unknown as JsonEvidenceValue,
    ).trimEnd();
    const editorialStep = record.steps.find((step) => step.id === "review-documentation")!;
    editorialStep.summary = summary;
    editorialStep.authoringPhase = createAuthoringPhaseEvidenceV1({
      workflow,
      branchId: null,
      stepId: editorialStep.id,
      candidates: [candidate0],
      outputAdmitted: false,
      summary,
    });
    const execution = mutableExecution(record);
    execution.selection.input.editorial.summarySha256 = sha256(summary);
    execution.selection.inputSha256 = canonicalDigest(execution.selection.input);
    execution.selectedProducers.editorial.summarySha256 = sha256(summary);
    reseal(execution, "executionSha256");

    expect(summary).toContain('\\"\\"');
    expect(summary).toContain("\\n");
    expect(() =>
      validateAuthoringRunRecordV1(record, workflow, { requireTerminalSuccess: true }),
    ).not.toThrow();
  });

  it("records host-derived phase roles and candidate input/output/assessment identity", () => {
    const record = successfulRecord("revise");
    const phases = new Map(record.steps.map((step) => [step.id, step.authoringPhase]));

    expect(phases.get("write-documentation")).toMatchObject({
      branchId: null,
      role: "writer",
      inputCandidateOrdinal: null,
      outputCandidateOrdinal: 0,
      outputCandidateDigest: candidate0.digest,
    });
    expect(phases.get("revise-documentation")).toMatchObject({
      branchId: "revise",
      role: "writer",
      inputCandidateOrdinal: 0,
      inputCandidateDigest: candidate0.digest,
      outputCandidateOrdinal: 1,
      outputCandidateDigest: candidate1.digest,
    });
    expect(phases.get("verify-revised-technical-accuracy")).toMatchObject({
      role: "canonical-technical",
      assessedCandidateOrdinal: 1,
      assessedCandidateDigest: candidate1.digest,
    });
  });

  it("exposes strict scorecard readback for the new execution and phase fields", () => {
    const record = successfulRecord("retain");
    const execution = decodeScorecardAuthoringExecutionEvidenceV1(
      record.authoringExecution,
      workflow,
    );
    const writer = record.steps.find((step) => step.id === "write-documentation")!;
    const phase = decodeScorecardAuthoringPhaseEvidenceV1(writer.authoringPhase, {
      workflow,
      branchId: null,
      candidates: [candidate0],
    });

    expect(execution.executionSha256).toBe(record.authoringExecution?.executionSha256);
    expect(phase.outputCandidateDigest).toBe(candidate0.digest);
    expect(
      decodeRetainedAuthoringWorkflowV1(record.authoringExecution).authoringSchedule?.manifest,
    ).toEqual(workflow.authoringSchedule?.manifest);
  });

  it("derives stable pre-inference bindings without future output or summary identity", () => {
    const initial = authoringPhaseInvocationBindingV1({
      workflow,
      branchId: null,
      stepId: "write-documentation",
      candidates: [],
      revisionInputDigest: null,
    });
    const revision = authoringPhaseInvocationBindingV1({
      workflow,
      branchId: "revise",
      stepId: "revise-documentation",
      candidates: [candidate0],
      revisionInputDigest: REVISION_INPUT,
    });
    const review = authoringPhaseInvocationBindingV1({
      workflow,
      branchId: "revise",
      stepId: "review-revised-documentation",
      candidates: [candidate0, candidate1],
      revisionInputDigest: null,
    });

    expect(initial).toMatchObject({ role: "writer", inputCandidateDigest: null });
    expect(revision).toMatchObject({
      role: "writer",
      inputCandidateDigest: candidate0.digest,
      workspaceSnapshotDigest: candidate0.workspaceSnapshotDigest,
      revisionInputDigest: REVISION_INPUT,
    });
    expect(review).toMatchObject({
      role: "editorial",
      assessedCandidateDigest: candidate1.digest,
      workspaceSnapshotDigest: candidate1.workspaceSnapshotDigest,
    });
    expect(
      decodeAuthoringPhaseInvocationBindingV1(revision, {
        workflow,
        candidates: [candidate0],
      }),
    ).toEqual(revision);
    expect(initial).not.toHaveProperty("outputCandidateDigest");
    expect(revision).not.toHaveProperty("summarySha256");

    const forged = structuredClone(revision) as Record<string, unknown>;
    forged.role = "editorial";
    expect(() =>
      decodeAuthoringPhaseInvocationBindingV1(forged, {
        workflow,
        candidates: [candidate0],
      }),
    ).toThrow("phase-mismatch");
  });

  it("selects candidate zero immediately after writer admission before branch selection", () => {
    const prefix = workflow.authoringSchedule!.prefix.steps.slice(0, 3);
    const steps = prefix.map((definition) => {
      const summary = `summary:${definition.id}`;
      const status = "succeeded" as const;
      const phase = authoringPrefixPhaseForStep(workflow, definition.id);
      return {
        id: definition.id,
        title: definition.title,
        kind: definition.kind,
        skill: definition.skill,
        mode: definition.mode,
        status,
        summary,
        ...phaseInference(definition, phase, null, [candidate0], status),
        ...(definition.id === "write-documentation"
          ? {
              authoringPhase: createAuthoringPhaseEvidenceV1({
                workflow,
                branchId: null,
                stepId: definition.id,
                candidates: [candidate0],
                outputAdmitted: true,
                summary,
              }),
            }
          : {}),
      };
    });
    const evidence = createAuthoringExecutionEvidenceV1(
      {
        runId: RUN_ID,
        repositoryRevision: REVISION,
        planDigest: reviseFixture.plan.digest,
        writePaths: WRITE_PATHS,
        sourceSearchSnapshotSha256: null,
        sourceObligationLedgerSha256: null,
        technicalCorrectionEvidenceSha256: null,
        selection: null,
        candidates: [{ candidate: candidate0, revisionInputDigest: null }],
        revisionAdmission: null,
        partialCandidate1: null,
        selectedCandidateOrdinal: 0,
        selectedProducers: null,
        includeFinalPatch: true,
      },
      workflow,
    );
    const record = minimalRecord(steps, evidence, "running");
    attachPatch(record, candidate0);

    expect(validateAuthoringRunRecordV1(record, workflow)).toMatchObject({
      candidates: [{ candidate: { ordinal: 0 } }],
      selection: null,
      selectedCandidate: { ordinal: 0 },
      finalPatch: { candidateOrdinal: 0 },
      sourceSearchSnapshotSha256: null,
      sourceObligationLedgerSha256: null,
      technicalCorrectionEvidenceSha256: null,
    });
  });

  it("preserves candidate zero and its final patch when a prefix review fails", () => {
    const record = prefixFailureRecord("lint-documentation");
    const decoded = validateAuthoringRunRecordV1(record, workflow);
    const writer = record.steps.find((step) => step.id === "write-documentation")!;

    expect(decoded.selection).toBeNull();
    expect(decoded.selectedCandidate?.ordinal).toBe(0);
    expect(writer).toMatchObject({
      status: "succeeded",
      authoringPhase: {
        outputCandidateOrdinal: 0,
        outputCandidateDigest: candidate0.digest,
      },
    });
    expect(decoded.finalPatch).toMatchObject({
      candidateOrdinal: 0,
      sha256: candidate0.patchDigestSha256,
    });
  });

  it("admits an honest pending revision with no future candidate evidence", () => {
    const record = recordFixture("revise", {
      candidates: [candidate0],
      selectedOrdinal: 0,
      terminal: false,
      stopAfter: "revise-documentation",
      stopStatus: "pending",
      includeFinalPatch: true,
    });
    const decoded = validateAuthoringRunRecordV1(record, workflow);

    expect(decoded.selection?.branchId).toBe("revise");
    expect(decoded.selectedCandidate?.ordinal).toBe(0);
    expect(decoded.candidates).toHaveLength(1);
    expect(decoded.partialCandidate1).toBeNull();
  });

  it("preserves selected candidate zero and a non-deliverable partial revision after failure", () => {
    const partial = createAuthoringPartialCandidateV1({
      runId: RUN_ID,
      inputCandidateDigest: candidate0.digest,
      revisionInputDigest: REVISION_INPUT,
      originalRevision: REVISION,
      planDigest: reviseFixture.plan.digest,
      writePaths: WRITE_PATHS,
      artifact: { sha256: HASH("6"), byteLength: 17 },
      workspaceSnapshotDigest: HASH("7"),
      failureCode: "writer-failed",
    });
    const record = recordFixture("revise", {
      candidates: [candidate0],
      partial,
      selectedOrdinal: 0,
      terminal: false,
      stopAfter: "revise-documentation",
    });
    const decoded = validateAuthoringRunRecordV1(record, workflow);

    expect(decoded.selectedCandidate?.ordinal).toBe(0);
    expect(decoded.partialCandidate1?.disposition).toBe("non-deliverable");
    expect(authoringArtifactReadbackRequirements(decoded).at(-1)?.name).toBe(
      "candidate-1.partial.patch",
    );
  });

  it("preserves selected candidate one after a later read-only review failure", () => {
    const record = recordFixture("revise", {
      candidates: [candidate0, candidate1],
      selectedOrdinal: 1,
      terminal: false,
      stopAfter: "review-revised-documentation",
    });
    expect(validateAuthoringRunRecordV1(record, workflow).selectedCandidate?.ordinal).toBe(1);
  });

  it.each([
    ["failed", "review-revised-documentation"],
    ["running", "revise-documentation"],
  ] as const)("admits a %s frontier followed by an untouched pending tail", (status, stopAfter) => {
    const record = recordFixture("revise", {
      candidates: status === "running" ? [candidate0] : [candidate0, candidate1],
      selectedOrdinal: status === "running" ? 0 : 1,
      terminal: false,
      stopAfter,
      stopStatus: status,
      includeFinalPatch: true,
    });
    record.status = status === "running" ? "running" : "failed";
    appendPendingTail(record, "revise");

    expect(() => validateAuthoringRunRecordV1(record, workflow)).not.toThrow();
    const frontier = record.steps.findIndex((step) => step.status === status);
    expect(record.steps.slice(frontier + 1).every((step) => step.status === "pending")).toBe(true);
  });

  it.each(["failed", "pending"] as const)(
    "rejects a succeeded step after a %s execution gap",
    (gapStatus) => {
      const record = successfulRecord("retain");
      record.status = gapStatus === "failed" ? "failed" : "running";
      const gap = record.steps.find((step) => step.id === "lint-documentation")!;
      gap.status = gapStatus;
      if (gapStatus === "pending") {
        delete gap.authoringPhase;
        delete gap.inference;
        delete gap.summary;
      }

      expect(() => validateAuthoringRunRecordV1(record, workflow)).toThrow("phase-mismatch");
    },
  );

  it("rejects a second nonterminal frontier before the pending tail", () => {
    const record = recordFixture("revise", {
      candidates: [candidate0],
      selectedOrdinal: 0,
      terminal: false,
      stopAfter: "revise-documentation",
      stopStatus: "running",
      includeFinalPatch: true,
    });
    record.status = "failed";
    appendPendingTail(record, "revise");
    record.steps.find((step) => step.id === "lint-revised-documentation")!.status = "failed";

    expect(() => validateAuthoringRunRecordV1(record, workflow)).toThrow("phase-mismatch");
  });

  it("rejects correction evidence before a retained V2 ledger exists", () => {
    const record = v2AuthorityOnlyFailureRecord();
    expect(() => validateAuthoringRunRecordV1(record, workflow)).not.toThrow();

    for (const stepId of [
      "derive-source-obligations",
      "verify-technical-accuracy",
      "review-documentation",
    ]) {
      const forged = structuredClone(record);
      const prefix = workflow.authoringSchedule!.prefix.steps;
      const targetIndex = prefix.findIndex((step) => step.id === stepId);
      for (const definition of prefix.slice(forged.steps.length, targetIndex + 1)) {
        forged.steps.push({
          id: definition.id,
          title: definition.title,
          kind: definition.kind,
          skill: definition.skill,
          mode: definition.mode,
          status: "pending",
        });
      }
      const target = forged.steps.find((step) => step.id === stepId);
      target!.technicalCorrectionEvidence = retainFixture.correction;
      expect(() => validateAuthoringRunRecordV1(forged, workflow)).toThrow("selection-mismatch");
    }
  });

  it("rejects pre-derive and non-succeeded V2 correction placement", () => {
    const preDerive = prefixFailureRecord("plan-documentation");
    preDerive.steps[0]!.technicalCorrectionEvidence = v2Correction;
    expect(() => validateAuthoringRunRecordV1(preDerive, workflow)).toThrow("selection-mismatch");

    const admitted = v2RetainRecord();
    expect(() => validateAuthoringRunRecordV1(admitted, workflow)).not.toThrow();
    for (const status of ["pending", "failed"] as const) {
      const forged = structuredClone(admitted);
      forged.status = status === "pending" ? "running" : "failed";
      forged.steps.find((step) => step.id === "verify-technical-accuracy")!.status = status;
      expect(() => validateAuthoringRunRecordV1(forged, workflow)).toThrow("phase-mismatch");
    }

    const missing = v2RetainRecord();
    delete missing.steps.find((step) => step.id === "verify-technical-accuracy")!
      .technicalCorrectionEvidence;
    expect(() => validateAuthoringRunRecordV1(missing, workflow)).toThrow("selection-mismatch");
  });

  it("requires a source-proposal receipt to match its inference and sealed authority", async () => {
    const record = v2RetainRecord();
    const derive = record.steps.find((step) => step.id === "derive-source-obligations")!;
    const attemptTemplate = structuredClone(
      record.steps.find((step) => step.id === "review-documentation")!.inference!.attempts[0]!,
    );
    const transportAttempt = {
      ...attemptTemplate,
      attempt: 1,
      outcome: "provider-transient" as const,
      retryable: true,
      retryScheduled: true,
    };
    const producingAttempt = {
      ...attemptTemplate,
      attempt: 2,
      outcome: "succeeded" as const,
    };
    delete transportAttempt.identity;
    delete producingAttempt.identity;
    derive.inference = {
      ...structuredClone(
        record.steps.find((step) => step.id === "review-documentation")!.inference!,
      ),
      attempts: [transportAttempt, producingAttempt],
    };
    derive.sourceProposalAdmissions = [
      {
        schemaVersion: 1,
        kind: "docsfab-source-proposal-admission",
        attempt: 2,
        path: "docs/new-guide.md",
        reason: "This proposal targets a planned documentation output.",
        status: "refused",
        refusalCode: "write-target-source",
      },
    ];

    expect(() => validateAuthoringRunRecordV1(record, workflow)).not.toThrow();

    const resealedAdmission = v2RetainRecord();
    const admittedDerive = resealedAdmission.steps.find(
      (step) => step.id === "derive-source-obligations",
    )!;
    const addedSource = { path: "src/extra.ts", sha256: HASH("e") };
    const extendedSealed = sealOriginalSourceAuthority({
      runId: RUN_ID,
      scope: "create-plan-sources",
      repositoryRevision: REVISION,
      scopeSha256: v2Authority.descriptor.scopeSha256,
      workspaceSnapshotSha256: v2Authority.descriptor.workspaceSnapshotSha256,
      members: [
        ...v2Authority.members,
        { path: addedSource.path, mode: 0o644, byteLength: 1, sourceSha256: addedSource.sha256 },
      ],
    });
    const extendedAuthority = extendedSealed.evidence;
    const extendedLedger = bindSourceObligationLedgerV2(
      {
        completeness: v2Ledger.completeness,
        dimensions: v2Ledger.dimensions,
        limitations: v2Ledger.limitations,
      },
      {
        workflow,
        evidenceIdentity: { repositoryRevision: REVISION },
        searchEvidence: retainFixture.searchEvidence,
        planBinding: retainFixture.plan,
      },
      [...v2Ledger.identity.sources, addedSource],
      extendedAuthority,
    );
    const extendedAdmission = issueOriginalSourceAuthorityAdmission({
      capture: extendedSealed.capture,
      observer: {
        observe: async (paths) =>
          paths.map((path) => ({
            path,
            sha256:
              extendedLedger.identity.sources.find((source) => source.path === path)?.sha256 ??
              HASH("e"),
          })),
      },
      runId: RUN_ID,
      repositoryRevision: REVISION,
      scopeSha256: extendedAuthority.descriptor.scopeSha256,
      workspaceSnapshotSha256: extendedAuthority.descriptor.workspaceSnapshotSha256,
    });
    const extendedCorrection = (
      await bindTechnicalCorrectionResponseV2(
        { verificationResult: retainFixture.technicalResult, obligationAccounting: [] },
        extendedLedger,
        extendedAdmission,
        RUN_ID,
        (value) => value as typeof retainFixture.technicalResult,
      )
    ).evidence;
    admittedDerive.summary = canonicalizeJsonEvidence(
      extendedLedger as unknown as JsonEvidenceValue,
    ).trimEnd();
    admittedDerive.originalSourceAuthority = extendedAuthority;
    admittedDerive.sourceProposalAdmissions = [
      {
        schemaVersion: 1,
        kind: "docsfab-source-proposal-admission",
        attempt: 2,
        path: addedSource.path,
        reason: "This tracked source supports the documentation claim.",
        status: "admitted",
      },
    ];
    const admittedInference = structuredClone(
      record.steps.find((step) => step.id === "derive-source-obligations")!.inference!,
    );
    admittedDerive.inference = admittedInference;
    resealedAdmission.steps.find(
      (step) => step.id === "verify-technical-accuracy",
    )!.technicalCorrectionEvidence = extendedCorrection;
    const execution = mutableExecution(resealedAdmission);
    execution.sourceObligationLedgerSha256 = extendedLedger.digest;
    execution.technicalCorrectionEvidenceSha256 = extendedCorrection.digest;
    execution.selection!.input.sourceObligationLedgerSha256 = extendedLedger.digest;
    execution.selection!.input.technicalCorrectionEvidenceSha256 = extendedCorrection.digest;
    execution.selection!.inputSha256 = canonicalDigest(execution.selection!.input);
    reseal(execution, "executionSha256");
    expect(() => validateAuthoringRunRecordV1(resealedAdmission, workflow)).not.toThrow();

    const transportAttemptForgery = structuredClone(record);
    transportAttemptForgery.steps.find((step) => step.id === "derive-source-obligations")!
      .sourceProposalAdmissions![0]!.attempt = 1;
    expect(() => validateAuthoringRunRecordV1(transportAttemptForgery, workflow)).toThrow(
      "selection-mismatch",
    );

    const admittedWithoutReceipt = structuredClone(resealedAdmission);
    delete admittedWithoutReceipt.steps.find((step) => step.id === "derive-source-obligations")!
      .sourceProposalAdmissions;
    expect(() => validateAuthoringRunRecordV1(admittedWithoutReceipt, workflow)).toThrow(
      "selection-mismatch",
    );

    const authorityNotResealed = structuredClone(record);
    authorityNotResealed.steps.find((step) => step.id === "derive-source-obligations")!
      .sourceProposalAdmissions![0] = {
      schemaVersion: 1,
      kind: "docsfab-source-proposal-admission",
      attempt: 2,
      path: "src/extra.ts",
      reason: "This tracked source supports the documentation claim.",
      status: "admitted",
    };
    expect(() => validateAuthoringRunRecordV1(authorityNotResealed, workflow)).toThrow(
      "selection-mismatch",
    );
  });

  it("cold-reconstructs V3 evidence and rejects a fully resealed result outside the retained plan", async () => {
    const admitted = v3RetainRecord();
    expect(() =>
      validateAuthoringRunRecordV1(admitted, workflow, { requireTerminalSuccess: true }),
    ).not.toThrow();
    expect(
      admitted.steps.find((step) => step.id === "verify-technical-accuracy")!
        .technicalCorrectionEvidence,
    ).toEqual(v3Correction);

    const outsideResult = structuredClone(v3TechnicalResult);
    outsideResult.coverage = outsideResult.coverage.map((entry) => ({
      ...entry,
      path: "docs/outside.md",
    }));
    const outside = await bindHostOwnedTechnicalCorrectionProposalV3(
      {
        kind: TECHNICAL_CORRECTION_PROPOSAL_KIND,
        schemaVersion: 3,
        verdict: outsideResult.review.verdict,
        coverage: outsideResult.coverage,
        factInventory: outsideResult.factInventory,
        issueJudgments: [],
        obligationAccounting: [],
      },
      v2Ledger,
      v2Admission,
      RUN_ID,
      ["docs/outside.md"],
    );
    const forgedFixture = {
      ...retainFixture,
      ledger: v2Ledger,
      ledgerSummary: canonicalizeJsonEvidence(v2Ledger as unknown as JsonEvidenceValue).trimEnd(),
      technicalResult: outside.verificationResult,
      technicalSummary: canonicalizeJsonEvidence(
        outside.verificationResult as unknown as JsonEvidenceValue,
      ).trimEnd(),
      correction: outside.evidence,
    } as unknown as RealAuthoringEvidenceFixture;
    const forged = recordFixture("retain", {
      candidates: [candidate0],
      selectedOrdinal: 0,
      terminal: true,
      retainedEvidence: forgedFixture,
    });
    forged.steps.find((step) => step.id === "derive-source-obligations")!.originalSourceAuthority =
      v2Authority;

    expect(() => validateAuthoringRunRecordV1(forged, workflow)).toThrow("selection-mismatch");
  });

  it("requires exact retained revision accounting only on the admitted revision writer", () => {
    const admitted = successfulRecord("revise");
    expect(validateAuthoringRunRecordV1(admitted, workflow).revisionAdmission).toMatchObject({
      candidate0Digest: candidate0.digest,
      candidate1Digest: candidate1.digest,
      changedPaths: WRITE_PATHS,
    });

    const missing = successfulRecord("revise");
    delete missing.steps.find((step) => step.id === "revise-documentation")!
      .authoringRevisionAccounting;
    expect(() => validateAuthoringRunRecordV1(missing, workflow)).toThrow("selection-mismatch");

    const wrongStep = successfulRecord("revise");
    wrongStep.steps.find(
      (step) => step.id === "lint-revised-documentation",
    )!.authoringRevisionAccounting = revisionAccounting();
    expect(() => validateAuthoringRunRecordV1(wrongStep, workflow)).toThrow("phase-mismatch");

    const forged = successfulRecord("revise");
    const accounting = structuredClone(
      forged.steps.find((step) => step.id === "revise-documentation")!.authoringRevisionAccounting!,
    ) as unknown as Record<string, any>;
    accounting.issueAccounting[0]!.issueId = "TECH-999";
    forged.steps.find((step) => step.id === "revise-documentation")!.authoringRevisionAccounting =
      accounting as AuthoringRevisionAccountingV1;
    expect(() => validateAuthoringRunRecordV1(forged, workflow)).toThrow("selection-mismatch");

    const alteredDisposition = successfulRecord("revise");
    const alteredAccounting = structuredClone(
      alteredDisposition.steps.find((step) => step.id === "revise-documentation")!
        .authoringRevisionAccounting!,
    );
    alteredAccounting.issueAccounting[0]!.disposition = "rejected";
    alteredAccounting.issueAccounting[0]!.reason =
      "The source evidence now supports a different valid disposition.";
    alteredDisposition.steps.find(
      (step) => step.id === "revise-documentation",
    )!.authoringRevisionAccounting = alteredAccounting;
    expect(() => validateAuthoringRunRecordV1(alteredDisposition, workflow)).toThrow(
      "selection-mismatch",
    );
  });

  it("binds every retained inference attempt to its pre-inference authoring phase", () => {
    const wrong = successfulRecord("revise");
    wrong.steps.find((step) => step.id === "review-revised-documentation")!.inference!.attempts[0]!
      .identity!.authoringPhaseSha256 = HASH("9");
    expect(() => validateAuthoringRunRecordV1(wrong, workflow)).toThrow("phase-mismatch");

    const missing = successfulRecord("retain");
    delete missing.steps.find((step) => step.id === "verify-technical-accuracy")!.inference!
      .attempts[0]!.identity!.authoringPhaseSha256;
    expect(() => validateAuthoringRunRecordV1(missing, workflow)).toThrow("phase-mismatch");

    const failedAttempt = recordFixture("revise", {
      candidates: [candidate0, candidate1],
      selectedOrdinal: 1,
      terminal: false,
      stopAfter: "provisional-revised-technical-verification",
    });
    expect(() => validateAuthoringRunRecordV1(failedAttempt, workflow)).not.toThrow();
    failedAttempt.steps.find((step) => step.id === "provisional-revised-technical-verification")!
      .inference!.attempts[0]!.identity!.authoringPhaseSha256 = HASH("8");
    expect(() => validateAuthoringRunRecordV1(failedAttempt, workflow)).toThrow("phase-mismatch");
  });

  it("revalidates the selected revised technical result against the frozen ledger", () => {
    const missing = successfulRecord("revise");
    delete missing.steps.find((step) => step.id === "verify-revised-technical-accuracy")!
      .technicalCorrectionEvidence;
    expect(() => validateAuthoringRunRecordV1(missing, workflow)).toThrow("selection-mismatch");

    const stale = successfulRecord("revise");
    stale.steps.find(
      (step) => step.id === "verify-revised-technical-accuracy",
    )!.technicalCorrectionEvidence = retainFixture.correction;
    expect(() => validateAuthoringRunRecordV1(stale, workflow)).toThrow("selection-mismatch");
  });

  it("rejects stale rehashed selection bindings and old candidate producers", () => {
    const stale = successfulRecord("revise");
    const execution = mutableExecution(stale);
    const input = execution.selection.input as Record<string, unknown>;
    (input.technical as Record<string, unknown>).summarySha256 = HASH("9");
    execution.selection.inputSha256 = canonicalDigest(input);
    reseal(execution, "executionSha256");
    expect(() => validateAuthoringRunRecordV1(stale, workflow)).toThrow("selection-mismatch");

    const oldProducer = successfulRecord("revise");
    const oldExecution = mutableExecution(oldProducer);
    oldExecution.selectedProducers = selectedProducerSet(candidate0, "retain") as unknown as Record<
      string,
      unknown
    >;
    reseal(oldExecution, "executionSha256");
    expect(() => validateAuthoringRunRecordV1(oldProducer, workflow)).toThrow("candidate-mismatch");

    const substitutedProducer = successfulRecord("revise");
    const substitutedExecution = mutableExecution(substitutedProducer);
    substitutedExecution.selection.input.technical.stepId = "review-documentation";
    substitutedExecution.selection.inputSha256 = canonicalDigest(
      substitutedExecution.selection.input,
    );
    reseal(substitutedExecution, "executionSha256");
    expect(() => validateAuthoringRunRecordV1(substitutedProducer, workflow)).toThrow(
      "selection-mismatch",
    );
  });

  it("recomputes retain or revise from real retained evidence", () => {
    const rehashedWrongBranch = recordFixture("revise", {
      candidates: [candidate0],
      selectedOrdinal: 0,
      terminal: false,
      stopAfter: "revise-documentation",
      stopStatus: "pending",
      includeFinalPatch: true,
      retainedEvidence: retainFixture,
    });
    expect(() => validateAuthoringRunRecordV1(rehashedWrongBranch, workflow)).toThrow(
      "selection-mismatch",
    );

    const swappedCorrection = successfulRecord("revise");
    const correctionStep = swappedCorrection.steps.find(
      (step) => step.id === "verify-technical-accuracy",
    )!;
    correctionStep.technicalCorrectionEvidence = retainFixture.correction;
    const correctionExecution = mutableExecution(swappedCorrection);
    correctionExecution.technicalCorrectionEvidenceSha256 = retainFixture.correction.digest;
    correctionExecution.selection.input.technicalCorrectionEvidenceSha256 =
      retainFixture.correction.digest;
    correctionExecution.selection.inputSha256 = canonicalDigest(
      correctionExecution.selection.input,
    );
    reseal(correctionExecution, "executionSha256");
    expect(() => validateAuthoringRunRecordV1(swappedCorrection, workflow)).toThrow(
      "selection-mismatch",
    );

    const swappedLedger = successfulRecord("revise");
    const ledger = structuredClone(reviseFixture.ledger) as unknown as Record<string, unknown>;
    ledger.limitations = ["A different bounded retained ledger was supplied."];
    reseal(ledger, "digest");
    const ledgerSummary = canonicalizeJsonEvidence(ledger as JsonEvidenceValue).trimEnd();
    const derive = swappedLedger.steps.find((step) => step.id === "derive-source-obligations")!;
    derive.summary = ledgerSummary;
    const ledgerExecution = mutableExecution(swappedLedger);
    ledgerExecution.sourceObligationLedgerSha256 = ledger.digest;
    ledgerExecution.selection.input.sourceObligationLedgerSha256 = ledger.digest;
    ledgerExecution.selection.inputSha256 = canonicalDigest(ledgerExecution.selection.input);
    reseal(ledgerExecution, "executionSha256");
    expect(() => validateAuthoringRunRecordV1(swappedLedger, workflow)).toThrow(
      "selection-mismatch",
    );

    const swappedSearch = successfulRecord("revise");
    const search = structuredClone(reviseFixture.searchEvidence) as unknown as Record<
      string,
      unknown
    >;
    search.workspaceSnapshotSha256 = HASH("9");
    reseal(search, "evidenceSha256");
    swappedSearch.steps.find((step) => step.id === "derive-source-obligations")!.searchEvidence =
      search as unknown as NonNullable<StepRunRecord["searchEvidence"]>;
    const searchExecution = mutableExecution(swappedSearch);
    searchExecution.sourceSearchSnapshotSha256 = HASH("9");
    searchExecution.selection.input.sourceSearchSnapshotSha256 = HASH("9");
    searchExecution.selection.inputSha256 = canonicalDigest(searchExecution.selection.input);
    reseal(searchExecution, "executionSha256");
    expect(() => validateAuthoringRunRecordV1(swappedSearch, workflow)).toThrow(
      "selection-mismatch",
    );

    const swappedPlan = successfulRecord("revise");
    swappedPlan.steps.find((step) => step.id === "plan-documentation")!.planBinding =
      sealDocumentationPlanBinding(
        {
          mode: "create",
          pages: [{ path: "docs/other.md", disposition: "create" }],
          sourceBindings: [{ pagePath: "docs/other.md", sources: ["src/other.ts"] }],
        },
        { expectedMode: "create" },
      );
    expect(() => validateAuthoringRunRecordV1(swappedPlan, workflow)).toThrow("selection-mismatch");

    const failedPrefix = successfulRecord("revise");
    failedPrefix.steps.find((step) => step.id === "derive-source-obligations")!.status = "failed";
    expect(() => validateAuthoringRunRecordV1(failedPrefix, workflow)).toThrow("phase-mismatch");
  });

  it("rejects wrong candidate identity, selected patch, and partial promotion", () => {
    const wrongCandidates = [
      createAuthoringCandidate({ ...candidateInput(0), runId: "another-run" }),
      createAuthoringCandidate({ ...candidateInput(0), originalRevision: HASH("f") }),
      createAuthoringCandidate({ ...candidateInput(0), planDigest: HASH("f") }),
      createAuthoringCandidate({ ...candidateInput(1), ordinal: 1 }),
    ];
    for (const candidate of wrongCandidates) {
      const wrongCandidate = successfulRecord("retain");
      const execution = mutableExecution(wrongCandidate);
      (execution.candidates as Record<string, unknown>[])[0]!.candidate = candidate;
      reseal(execution, "executionSha256");
      expect(() => validateAuthoringRunRecordV1(wrongCandidate, workflow)).toThrow(
        "candidate-mismatch",
      );
    }

    const unknownOutput = successfulRecord("retain");
    const writer = unknownOutput.steps.find((step) => step.id === "write-documentation")!;
    const phase = structuredClone(writer.authoringPhase) as unknown as Record<string, unknown>;
    phase.outputCandidateDigest = HASH("9");
    reseal(phase, "phaseSha256");
    writer.authoringPhase = phase as unknown as NonNullable<StepRunRecord["authoringPhase"]>;
    expect(() => validateAuthoringRunRecordV1(unknownOutput, workflow)).toThrow("phase-mismatch");

    const wrongPatch = successfulRecord("revise");
    wrongPatch.changes!.patch!.sha256 = candidate0.patchDigestSha256;
    expect(() => validateAuthoringRunRecordV1(wrongPatch, workflow)).toThrow("patch-mismatch");

    const promotedPartial = successfulRecord("revise");
    const promoted = mutableExecution(promotedPartial);
    promoted.selectedCandidate = {
      ordinal: 1,
      digest: HASH("6"),
      artifactName: "candidate-1.partial.patch",
    };
    reseal(promoted, "executionSha256");
    expect(() => validateAuthoringRunRecordV1(promotedPartial, workflow)).toThrow(
      "candidate-mismatch",
    );
  });

  it("admits copied write effects but rejects an out-of-scope rename source", () => {
    const copied = successfulRecord("retain");
    copied.changes!.files = [{ path: WRITE_PATHS[0], status: "copied", previousPath: "README.md" }];
    expect(() => validateAuthoringRunRecordV1(copied, workflow)).not.toThrow();

    const renamed = successfulRecord("retain");
    renamed.changes!.files = [
      { path: WRITE_PATHS[0], status: "renamed", previousPath: "README.md" },
    ];
    expect(() => validateAuthoringRunRecordV1(renamed, workflow)).toThrow("patch-mismatch");
  });

  it("rejects terminal success with a missing required phase", () => {
    const record = successfulRecord("retain");
    record.steps.splice(4, 1);
    expect(() =>
      validateAuthoringRunRecordV1(record, workflow, { requireTerminalSuccess: true }),
    ).toThrow("phase-mismatch");
  });

  it("leaves legacy V1 and UPDATE V2 path reconstruction unchanged", () => {
    const v1 = {
      schemaVersion: 1,
      name: "create-documentation",
      steps: [],
    } as unknown as WorkflowDefinition;
    expect(reconstructCompositionWorkflowPathV1({} as RunRecord, v1)).toBe(v1);

    const update = getWorkflow("update-documentation");
    const updateRecord = {
      workflowBranchCoverage: { selection: { branchId: "author" } },
    } as unknown as RunRecord;
    expect(
      reconstructCompositionWorkflowPathV1(updateRecord, update).steps.map((step) => step.id),
    ).toEqual(
      update
        .branching!.prefix.steps.concat(update.branching!.branches[0]!.steps)
        .map((step) => step.id),
    );
  });
});

function successfulRecord(branchId: WorkflowAuthoringBranchIdV3): RunRecord {
  return recordFixture(branchId, {
    candidates: branchId === "retain" ? [candidate0] : [candidate0, candidate1],
    selectedOrdinal: branchId === "retain" ? 0 : 1,
    terminal: true,
  });
}

function recordFixture(
  branchId: WorkflowAuthoringBranchIdV3,
  options: {
    candidates: readonly (typeof candidate0)[];
    selectedOrdinal: 0 | 1;
    terminal: boolean;
    partial?: ReturnType<typeof createAuthoringPartialCandidateV1>;
    stopAfter?: string;
    stopStatus?: StepRunRecord["status"];
    includeFinalPatch?: boolean;
    retainedEvidence?: RealAuthoringEvidenceFixture;
  },
): RunRecord {
  const retained = options.retainedEvidence ?? fixtureFor(branchId);
  const path = authoringSelectedPath(workflow, branchId);
  const selected = options.candidates[options.selectedOrdinal]!;
  const steps: StepRunRecord[] = [];
  for (const definition of path.steps) {
    const status =
      definition.id === options.stopAfter ? (options.stopStatus ?? "failed") : "succeeded";
    const summary = retainedSummary(definition.id, retained);
    const phase = path.phases.find((candidate) => candidate.stepId === definition.id);
    steps.push({
      id: definition.id,
      title: definition.title,
      kind: definition.kind,
      skill: definition.skill,
      mode: definition.mode,
      status,
      summary,
      ...phaseInference(definition, phase, branchId, options.candidates, status),
      ...(definition.id === "plan-documentation" ? { planBinding: retained.plan } : {}),
      ...(definition.id === "derive-source-obligations"
        ? { searchEvidence: retained.searchEvidence }
        : {}),
      ...(definition.id === "verify-technical-accuracy" ||
      definition.id === "verify-revised-technical-accuracy"
        ? { technicalCorrectionEvidence: retained.correction }
        : {}),
      ...(definition.id === "revise-documentation" && status === "succeeded"
        ? { authoringRevisionAccounting: revisionAccounting() }
        : {}),
      ...(phase
        ? status === "pending"
          ? {}
          : {
              authoringPhase: createAuthoringPhaseEvidenceV1({
                workflow,
                branchId: phase.ordinal <= 7 ? null : branchId,
                stepId: definition.id,
                candidates: options.candidates,
                outputAdmitted:
                  status === "succeeded" &&
                  (definition.id === "write-documentation" ||
                    definition.id === "revise-documentation"),
                summary,
              }),
            }
        : {}),
    });
    if (definition.id === options.stopAfter) break;
  }
  const selectionInput = {
    candidate0Digest: candidate0.digest,
    candidate0WorkspaceSnapshotDigest: candidate0.workspaceSnapshotDigest,
    originalRevision: REVISION,
    planDigest: retained.plan.digest,
    writePaths: WRITE_PATHS,
    sourceSearchSnapshotSha256: retained.searchEvidence.workspaceSnapshotSha256,
    sourceObligationLedgerSha256: retained.ledger.digest,
    technicalCorrectionEvidenceSha256: retained.correction.digest,
    technical: producer(candidate0, "verify-technical-accuracy", retained.technicalSummary),
    editorial: producer(candidate0, "review-documentation", retained.editorialSummary),
  };
  const evidence = createAuthoringExecutionEvidenceV1(
    {
      runId: RUN_ID,
      repositoryRevision: REVISION,
      planDigest: retained.plan.digest,
      writePaths: WRITE_PATHS,
      sourceSearchSnapshotSha256: retained.searchEvidence.workspaceSnapshotSha256,
      sourceObligationLedgerSha256: retained.ledger.digest,
      technicalCorrectionEvidenceSha256: retained.correction.digest,
      selection: {
        branchId,
        input: selectionInput,
        revisionInputDigest: branchId === "revise" ? REVISION_INPUT : null,
      },
      candidates: options.candidates.map((candidate) => ({
        candidate,
        revisionInputDigest: candidate.ordinal === 0 ? null : REVISION_INPUT,
      })),
      revisionAdmission:
        options.candidates.length === 2
          ? createAuthoringRevisionAdmissionBindingV1({
              candidate0,
              candidate1,
              actualChangedPaths: revisionAccounting().changedPaths,
              accounting: revisionAccounting(),
            })
          : null,
      partialCandidate1: options.partial ?? null,
      selectedCandidateOrdinal: options.selectedOrdinal,
      selectedProducers: options.terminal ? selectedProducerSet(selected, branchId) : null,
      includeFinalPatch: options.includeFinalPatch ?? options.terminal,
    },
    workflow,
  );
  const record = minimalRecord(
    steps,
    evidence,
    options.stopStatus === "pending" ? "running" : options.terminal ? "succeeded" : "failed",
  );
  if (options.includeFinalPatch ?? options.terminal) attachPatch(record, selected);
  return record;
}

function minimalRecord(
  steps: StepRunRecord[],
  evidence: NonNullable<RunRecord["authoringExecution"]>,
  status: RunRecord["status"],
): RunRecord {
  return {
    schemaVersion: 2,
    id: RUN_ID,
    workflow: "create-documentation",
    repository: { sourcePath: "source", requestedRevision: REVISION, revision: REVISION },
    workspace: { strategy: "tracked-export", disposable: true },
    status,
    createdAt: "2026-09-15T00:00:00.000Z",
    models: [],
    skills: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0 },
    tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
    steps,
    authoringExecution: evidence,
  };
}

function prefixFailureRecord(stopAfter: string): RunRecord {
  const definitions = workflow.authoringSchedule!.prefix.steps;
  const steps: StepRunRecord[] = [];
  for (const definition of definitions) {
    const status = definition.id === stopAfter ? "failed" : "succeeded";
    const summary = `summary:${definition.id}`;
    const phase = authoringPrefixPhaseForStep(workflow, definition.id);
    steps.push({
      id: definition.id,
      title: definition.title,
      kind: definition.kind,
      skill: definition.skill,
      mode: definition.mode,
      status,
      summary,
      ...phaseInference(definition, phase, null, [candidate0], status),
      ...(phase
        ? {
            authoringPhase: createAuthoringPhaseEvidenceV1({
              workflow,
              branchId: null,
              stepId: definition.id,
              candidates: [candidate0],
              outputAdmitted: definition.id === "write-documentation",
              summary,
            }),
          }
        : {}),
    });
    if (definition.id === stopAfter) break;
  }
  const writerAdmitted = steps.some(
    (step) => step.id === "write-documentation" && step.status === "succeeded",
  );
  const evidence = createAuthoringExecutionEvidenceV1(
    {
      runId: RUN_ID,
      repositoryRevision: REVISION,
      planDigest: reviseFixture.plan.digest,
      writePaths: WRITE_PATHS,
      sourceSearchSnapshotSha256: null,
      sourceObligationLedgerSha256: null,
      technicalCorrectionEvidenceSha256: null,
      selection: null,
      candidates: writerAdmitted ? [{ candidate: candidate0, revisionInputDigest: null }] : [],
      revisionAdmission: null,
      partialCandidate1: null,
      selectedCandidateOrdinal: writerAdmitted ? 0 : null,
      selectedProducers: null,
      includeFinalPatch: writerAdmitted,
    },
    workflow,
  );
  const record = minimalRecord(steps, evidence, "failed");
  if (writerAdmitted) attachPatch(record, candidate0);
  return record;
}

function v2AuthorityOnlyFailureRecord(): RunRecord {
  const record = prefixFailureRecord("derive-source-obligations");
  const planStep = record.steps.find((step) => step.id === "plan-documentation")!;
  planStep.planBinding = reviseFixture.plan;
  const derive = record.steps.find((step) => step.id === "derive-source-obligations")!;
  derive.summary = undefined;
  derive.searchEvidence = reviseFixture.searchEvidence;
  const scopeSha256 = sourceObligationScopeSha256({
    workflow,
    planBinding: reviseFixture.plan,
  });
  derive.originalSourceAuthority = sealOriginalSourceAuthority({
    runId: RUN_ID,
    scope: "create-plan-sources",
    repositoryRevision: REVISION,
    scopeSha256,
    workspaceSnapshotSha256: reviseFixture.searchEvidence.workspaceSnapshotSha256,
    members: reviseFixture.ledger.identity.sources.map((source) => ({
      path: source.path,
      mode: 0o644,
      byteLength: 1,
      sourceSha256: source.sha256,
    })),
  }).evidence;
  const phase = authoringPrefixPhaseForStep(workflow, derive.id);
  if (phase) {
    derive.authoringPhase = createAuthoringPhaseEvidenceV1({
      workflow,
      branchId: null,
      stepId: derive.id,
      candidates: [candidate0],
      outputAdmitted: false,
      summary: undefined,
    });
  }
  return record;
}

function v2RetainRecord(): RunRecord {
  const record = successfulRecord("retain");
  const derive = record.steps.find((step) => step.id === "derive-source-obligations")!;
  derive.summary = canonicalizeJsonEvidence(v2Ledger as unknown as JsonEvidenceValue).trimEnd();
  derive.originalSourceAuthority = v2Authority;
  record.steps.find(
    (step) => step.id === "verify-technical-accuracy",
  )!.technicalCorrectionEvidence = v2Correction;
  const execution = mutableExecution(record);
  execution.sourceObligationLedgerSha256 = v2Ledger.digest;
  execution.technicalCorrectionEvidenceSha256 = v2Correction.digest;
  execution.selection.input.sourceObligationLedgerSha256 = v2Ledger.digest;
  execution.selection.input.technicalCorrectionEvidenceSha256 = v2Correction.digest;
  execution.selection.inputSha256 = canonicalDigest(execution.selection.input);
  reseal(execution, "executionSha256");
  return record;
}

function v3RetainRecord(): RunRecord {
  const retained = {
    ...retainFixture,
    ledger: v2Ledger,
    ledgerSummary: canonicalizeJsonEvidence(v2Ledger as unknown as JsonEvidenceValue).trimEnd(),
    technicalResult: v3TechnicalResult,
    technicalSummary: canonicalizeJsonEvidence(
      v3TechnicalResult as unknown as JsonEvidenceValue,
    ).trimEnd(),
    correction: v3Correction,
  } as unknown as RealAuthoringEvidenceFixture;
  const record = recordFixture("retain", {
    candidates: [candidate0],
    selectedOrdinal: 0,
    terminal: true,
    retainedEvidence: retained,
  });
  record.steps.find((step) => step.id === "derive-source-obligations")!.originalSourceAuthority =
    v2Authority;
  return record;
}

function attachPatch(record: RunRecord, candidate: typeof candidate0): void {
  record.changes = {
    files: WRITE_PATHS.map((path) => ({ path, status: "modified" as const })),
    patch: {
      sha256: candidate.patchDigestSha256,
      byteLength: candidate.patchBytes,
      lineCount: 1,
      artifactPath: `.docsfab/${candidate.ordinal}.patch`,
      format: "git-diff",
    },
  };
}

function fixtureFor(branchId: WorkflowAuthoringBranchIdV3): RealAuthoringEvidenceFixture {
  return branchId === "retain" ? retainFixture : reviseFixture;
}

function retainedSummary(stepId: string, fixture: RealAuthoringEvidenceFixture): string {
  if (stepId === "derive-source-obligations") {
    return fixture.ledgerSummary;
  }
  if (stepId === "verify-technical-accuracy") return fixture.technicalSummary;
  if (stepId === "verify-revised-technical-accuracy") return fixture.technicalSummary;
  if (stepId === "review-documentation") return fixture.editorialSummary;
  return `summary:${stepId}`;
}

function selectedProducerSet(candidate: typeof candidate0, branchId: WorkflowAuthoringBranchIdV3) {
  const retained = fixtureFor(branchId);
  return {
    lint: producer(
      candidate,
      branchId === "retain" ? "lint-documentation" : "lint-revised-documentation",
    ),
    technical: producer(
      candidate,
      branchId === "retain" ? "verify-technical-accuracy" : "verify-revised-technical-accuracy",
      retained.technicalSummary,
    ),
    editorial: producer(
      candidate,
      branchId === "retain" ? "review-documentation" : "review-revised-documentation",
      branchId === "retain" ? retained.editorialSummary : undefined,
    ),
  };
}

function producer(
  candidate: typeof candidate0,
  stepId: string,
  summary = `summary:${stepId}`,
): AuthoringProducerSummaryBindingV1 {
  return {
    stepId,
    summarySha256: sha256(summary),
    candidateOrdinal: candidate.ordinal,
    candidateDigest: candidate.digest,
    workspaceSnapshotDigest: candidate.workspaceSnapshotDigest,
  };
}

function phaseInference(
  definition: WorkflowDefinition["steps"][number],
  phase: WorkflowAuthoringPhaseV3 | undefined,
  branchId: WorkflowAuthoringBranchIdV3 | null,
  candidates: readonly (typeof candidate0)[],
  status: StepRunRecord["status"],
): Pick<StepRunRecord, "inference"> {
  if (!phase || definition.kind === "host-operation" || status === "pending") return {};
  const invocationCandidates =
    phase.role === "writer"
      ? phase.stepId === "write-documentation"
        ? []
        : candidates.slice(0, 1)
      : candidates.slice(0, phase.candidateOrdinal + 1);
  const invocation = authoringPhaseInvocationBindingV1({
    workflow,
    branchId: phase.ordinal <= 7 ? null : branchId,
    stepId: definition.id,
    candidates: invocationCandidates,
    revisionInputDigest: phase.stepId === "revise-documentation" ? REVISION_INPUT : null,
  });
  return {
    inference: {
      configuredMaxRetries: 0,
      effectiveMaxRetries: 0,
      baseDelayMs: 0,
      maxDelayMs: 0,
      retryableCategories: [],
      replay: definition.mode === "write" ? "disabled-write-step" : "read-only",
      attempts: [
        {
          attempt: 1,
          outcome: status === "succeeded" ? "succeeded" : "provider-terminal",
          retryable: false,
          retryScheduled: false,
          durationMs: 1,
          backoffMs: 0,
          identity: {
            repositoryRevision: REVISION,
            authoringPhaseSha256: canonicalDigest(invocation),
          },
        },
      ],
    },
  };
}

function revisionAccounting(): AuthoringRevisionAccountingV1 {
  if (reviseFixture.selection.kind !== "revise") {
    throw new Error("The authoring revision fixture must select the revision branch.");
  }
  const issueIds = [
    ...new Set(reviseFixture.selection.input.actionableFacts.flatMap((fact) => fact.issueIds)),
  ].sort();
  return {
    issueAccounting: issueIds.map((issueId) => {
      const fact = reviseFixture.selection.input.actionableFacts.find((candidate) =>
        candidate.issueIds.includes(issueId),
      )!;
      return {
        issueId,
        disposition: "applied" as const,
        reason: "The admitted source evidence supports this bounded correction.",
        sourceLocators: [fact.sourceLocators[0]!],
      };
    }),
    changedPaths: [...WRITE_PATHS],
    unresolvedFacts: [],
  };
}

function candidateInput(ordinal: 0 | 1) {
  return {
    runId: RUN_ID,
    ordinal,
    originalRevision: REVISION,
    planDigest: reviseFixture.plan.digest,
    writePaths: WRITE_PATHS,
    patchDigestSha256: ordinal === 0 ? HASH("1") : HASH("3"),
    patchBytes: ordinal === 0 ? 101 : 202,
    workspaceSnapshotDigest: ordinal === 0 ? HASH("2") : HASH("4"),
  } as const;
}

function mutableExecution(record: RunRecord): Record<string, any> {
  const mutable = structuredClone(record.authoringExecution) as unknown as Record<string, any>;
  record.authoringExecution = mutable as unknown as NonNullable<RunRecord["authoringExecution"]>;
  return mutable;
}

function reseal(value: Record<string, unknown>, digestField: string): void {
  const body = structuredClone(value);
  delete body[digestField];
  value[digestField] = canonicalDigest(body);
}

it.each(["failed", "missing"] as const)(
  "rejects a selected candidate when its initial writer is %s",
  (disposition) => {
    const record = successfulRecord("retain");
    record.status = "failed";
    record.error = "The initial writer failed before candidate admission.";
    const writerIndex = record.steps.findIndex((step) => step.id === "write-documentation");
    const writer = record.steps[writerIndex]!;
    if (disposition === "failed") {
      writer.status = "failed";
      writer.error = record.error;
      delete writer.inference;
      writer.authoringPhase = createAuthoringPhaseEvidenceV1({
        workflow,
        branchId: null,
        stepId: writer.id,
        candidates: [candidate0],
        outputAdmitted: false,
        summary: writer.summary ?? null,
      });
      record.steps.splice(writerIndex + 1);
    } else {
      record.steps.splice(writerIndex);
    }

    expect(() => validateAuthoringRunRecordV1(record, workflow)).toThrow("candidate-mismatch");
  },
);

function appendPendingTail(record: RunRecord, branchId: WorkflowAuthoringBranchIdV3): void {
  const path = authoringSelectedPath(workflow, branchId).steps;
  for (const definition of path.slice(record.steps.length)) {
    record.steps.push({
      id: definition.id,
      title: definition.title,
      kind: definition.kind,
      skill: definition.skill,
      mode: definition.mode,
      status: "pending",
    });
  }
}
