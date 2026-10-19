// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../src/json-evidence.js";
import { canonicalDigest, sha256 } from "../src/content-ir/canonical.js";
import { documentationAuditSearch } from "../src/maturity/audit-search-plan.js";
import {
  createAuthoringExecutionEvidenceV1,
  createAuthoringPartialCandidateV1,
  createAuthoringPhaseEvidenceV1,
  createAuthoringRevisionAdmissionBindingV1,
  authoringPhaseInvocationBindingV1,
  validateAuthoringRunRecordV1,
  type AuthoringProducerSummaryBindingV1,
} from "../src/records/authoring-execution.js";
import type { RunRecord, StepRunRecord } from "../src/records/contracts.js";
import { projectReviewFindingsFromRun } from "../src/review/findings.js";
import { documentationObservationSearch } from "../src/search/observation-search-plan.js";
import { authoringSelectedPath } from "../src/workflow-contracts/authoring-schedule.js";
import { createAuthoringCandidate } from "../src/workflow-execution/authoring-candidate.js";
import { bindTechnicalCorrectionResponse } from "../src/workflow-execution/source-obligation.js";
import { parseWorkflowManifestSnapshot } from "../src/workflow-registry/manifest.js";
import {
  createRealAuthoringEvidenceFixture,
  type RealAuthoringEvidenceFixture,
} from "./helpers/authoring-evidence.js";
import { authoringManifestV3, legacyAuthoringManifestV3 } from "./helpers/authoring-manifest.js";

const workflow = parseWorkflowManifestSnapshot(authoringManifestV3(), "create-documentation", {
  "documentation-audit": documentationAuditSearch,
  "documentation-observation": documentationObservationSearch,
});
const legacyWorkflow = parseWorkflowManifestSnapshot(
  legacyAuthoringManifestV3(),
  "create-documentation",
  {
    "documentation-audit": documentationAuditSearch,
    "documentation-observation": documentationObservationSearch,
  },
);
let fixture: RealAuthoringEvidenceFixture;
let correctedFixture: RealAuthoringEvidenceFixture;
let legacyFixture: RealAuthoringEvidenceFixture;

beforeAll(async () => {
  [fixture, correctedFixture, legacyFixture] = await Promise.all([
    createRealAuthoringEvidenceFixture(workflow, { actionable: true }),
    createRealAuthoringEvidenceFixture(workflow, { actionable: false }),
    createRealAuthoringEvidenceFixture(legacyWorkflow, { actionable: true }),
  ]);
});

afterAll(async () => {
  await Promise.all([fixture?.dispose(), correctedFixture?.dispose(), legacyFixture?.dispose()]);
});

describe("retained findings for the selected CREATE candidate", () => {
  it("projects revised facts with the current producer locator even when issue IDs are reused", () => {
    const record = retainedRun("test-audience-understanding");
    const projection = projectReviewFindingsFromRun(record);

    expect(projection.availability).not.toBe("invalid");
    expect(projection.findings).toHaveLength(1);
    expect(projection.findings[0]).toMatchObject({
      code: "FACT-001",
      summary: "The revised draft still omits the source-backed behavior.",
      path: "docs/guide.md",
    });
    expect(projection.limitations).toContain(
      "review-finding-fact-metadata-omitted:FACT-001:uncertainty:retained=run-step:verify-revised-technical-accuracy:summary:fact:FACT-001",
    );
    expect(projection.findings[0]?.evidence).toContain("source-locator=src/contract.ts:1-3");
    expect(projection.findings[0]?.evidence).toContain("technical-issue=TECH-001");
  });

  it("does not carry corrected candidate-zero issues into a completed candidate-one assessment", () => {
    const record = retainedRun("test-audience-understanding", { corrected: true });
    const projection = projectReviewFindingsFromRun(record);

    expect(projection.availability).not.toBe("invalid");
    expect(projection.findings).toEqual([]);
    expect(projection.limitations).not.toContain(
      "review-findings-selected-candidate-assessment-incomplete",
    );
  });

  it("retains candidate-zero findings when the revision writer fails with a partial artifact", () => {
    const record = retainedRun("revise-documentation");
    const projection = projectReviewFindingsFromRun(record);

    expect(record.authoringExecution?.partialCandidate1?.disposition).toBe("non-deliverable");
    expect(record.authoringExecution?.selectedCandidate?.ordinal).toBe(0);
    expect(
      (
        record.steps.find((step) => step.id === "revise-documentation") as unknown as Record<
          string,
          unknown
        >
      ).authoringRevisionAccounting,
    ).toBeUndefined();
    expect(projection.findings).toHaveLength(1);
    expect(projection.findings[0]?.summary).toBe(
      "The page omits the required source-backed behavior.",
    );
    expect(projection.limitations).not.toContain(
      "review-findings-selected-candidate-assessment-incomplete",
    );
  });

  it("retains admitted candidate-zero technical facts when the retained legacy prefix editorial review fails", () => {
    const projection = projectReviewFindingsFromRun(
      retainedRun("review-documentation", { layout: "legacy" }),
    );

    expect(projection.findings[0]?.code).toBe("FACT-001");
    expect(projection.limitations).toContain(
      "review-findings-selected-candidate-assessment-incomplete",
    );
  });

  it("reports an incomplete assessment without a canonical fact when corrected prefix editorial review fails", () => {
    const projection = projectReviewFindingsFromRun(retainedRun("review-documentation"));

    expect(projection.findings).toEqual([]);
    expect(projection.limitations).toContain(
      "review-findings-selected-candidate-assessment-incomplete",
    );
  });

  it("reports an incomplete selected-candidate assessment without substituting old findings", () => {
    const record = retainedRun("verify-revised-technical-accuracy");
    const projection = projectReviewFindingsFromRun(record);

    expect(record.authoringExecution?.selectedCandidate?.ordinal).toBe(1);
    expect(projection.findings).toEqual([]);
    expect(projection.limitations).toContain(
      "review-findings-selected-candidate-assessment-incomplete",
    );
  });

  it.each([
    "missing execution",
    "wrong final patch",
    "wrong phase",
    "orphan accounting",
    "failed initial writer",
  ])("refuses %s rather than falling back to candidate-zero findings", (mutation) => {
    const record = structuredClone(retainedRun("test-audience-understanding"));
    if (mutation === "missing execution") delete record.authoringExecution;
    else if (mutation === "wrong final patch") record.changes!.patch!.sha256 = "f".repeat(64);
    else if (mutation === "orphan accounting") {
      delete record.authoringExecution;
      for (const step of record.steps) delete step.authoringPhase;
      (record.steps[0] as unknown as Record<string, unknown>).authoringRevisionAccounting = {};
    } else if (mutation === "failed initial writer") {
      const writer = record.steps.find((step) => step.id === "write-documentation")!;
      writer.status = "failed";
      writer.error = "The initial writer failed before candidate admission.";
      delete writer.inference;
      writer.authoringPhase = createAuthoringPhaseEvidenceV1({
        workflow,
        branchId: null,
        stepId: writer.id,
        candidates: [fixture.candidate0],
        outputAdmitted: false,
        summary: writer.summary ?? null,
      });
    } else {
      const technical = record.steps.find(
        (step) => step.id === "verify-revised-technical-accuracy",
      )!;
      technical.summary = fixture.technicalSummary;
    }
    const projection = projectReviewFindingsFromRun(record);
    expect(projection.availability).toBe("invalid");
    expect(projection.findings).toEqual([]);
    expect(projection.limitations).toContain("review-findings-invalid:authoring-candidate");
  });
});

/** Failed runs deliberately stop at a real boundary; no evaluator output is fabricated. */
function retainedRun(
  stopAfter: string,
  options: { corrected?: boolean; layout?: "corrected" | "legacy" } = {},
): RunRecord {
  const currentWorkflow = options.layout === "legacy" ? legacyWorkflow : workflow;
  const currentFixture = options.layout === "legacy" ? legacyFixture : fixture;
  if (currentFixture.selection.kind !== "revise") {
    throw new Error("Expected actionable initial draft.");
  }
  const candidate0 = currentFixture.candidate0;
  const branchSelected = stopAfter !== "review-documentation";
  const candidate1Admitted = branchSelected && stopAfter !== "revise-documentation";
  const candidate1 = createAuthoringCandidate({
    runId: currentFixture.runId,
    ordinal: 1,
    originalRevision: currentFixture.revision,
    planDigest: currentFixture.plan.digest,
    writePaths: currentFixture.writePaths,
    patchDigestSha256: "3".repeat(64),
    patchBytes: 202,
    workspaceSnapshotDigest: "4".repeat(64),
  });
  const candidates = candidate1Admitted ? [candidate0, candidate1] : [candidate0];
  const selected = candidates.at(-1)!;
  const revisedTechnical = structuredClone(
    options.corrected ? correctedFixture.technicalResult : currentFixture.technicalResult,
  );
  if (!options.corrected) {
    const fact = revisedTechnical.factInventory.dimensions.flatMap(
      (dimension) => dimension.facts,
    )[0]!;
    fact.statement = "The revised draft still omits the source-backed behavior.";
    fact.uncertainty = "U".repeat(2_048);
  }
  const revisedCorrection = bindTechnicalCorrectionResponse(
    { verificationResult: revisedTechnical, obligationAccounting: [] },
    currentFixture.ledger,
    (value) => value as typeof revisedTechnical,
  );
  const summaries: Record<string, string> = {
    "plan-documentation": canonical(currentFixture.plan),
    "derive-source-obligations": currentFixture.ledgerSummary,
    "provisional-technical-verification": currentFixture.technicalSummary,
    "verify-technical-accuracy": currentFixture.technicalSummary,
    "review-documentation": currentFixture.editorialSummary,
    "provisional-revised-technical-verification": canonical(revisedTechnical),
    "verify-revised-technical-accuracy": canonical(revisedCorrection.verificationResult),
    "review-revised-documentation": currentFixture.editorialSummary,
  };
  const path = authoringSelectedPath(currentWorkflow, "revise");
  const steps: StepRunRecord[] = [];
  for (const definition of path.steps) {
    const status = definition.id === stopAfter ? "failed" : "succeeded";
    const summary = summaries[definition.id] ?? `Completed ${definition.id}.`;
    const phase = path.phases.find((item) => item.stepId === definition.id);
    steps.push({
      id: definition.id,
      title: definition.title,
      kind: definition.kind,
      skill: definition.skill,
      mode: definition.mode,
      status,
      summary,
      ...(definition.id === "plan-documentation" ? { planBinding: currentFixture.plan } : {}),
      ...(definition.id === "derive-source-obligations"
        ? { searchEvidence: currentFixture.searchEvidence }
        : {}),
      ...(definition.id === "verify-technical-accuracy"
        ? { technicalCorrectionEvidence: currentFixture.correction }
        : {}),
      ...(definition.id === "verify-revised-technical-accuracy"
        ? { technicalCorrectionEvidence: revisedCorrection.evidence }
        : {}),
      ...(phase
        ? {
            authoringPhase: createAuthoringPhaseEvidenceV1({
              workflow: currentWorkflow,
              branchId: phase.ordinal <= 7 ? null : "revise",
              stepId: definition.id,
              candidates,
              outputAdmitted: status === "succeeded" && phase.role === "writer",
              summary,
            }),
          }
        : {}),
      ...(definition.id === "revise-documentation" && status === "succeeded" && branchSelected
        ? { authoringRevisionAccounting: revisionAccounting(currentFixture) }
        : {}),
    });
    if (definition.id === stopAfter) break;
  }
  bindPhaseInvocations(
    steps,
    path,
    currentWorkflow,
    currentFixture,
    branchSelected ? "revise" : "retain",
    candidates,
    branchSelected ? currentFixture.selection.input.digest : null,
  );
  const revisionInputDigest = currentFixture.selection.input.digest;
  const evidence = createAuthoringExecutionEvidenceV1(
    {
      runId: currentFixture.runId,
      repositoryRevision: currentFixture.revision,
      planDigest: currentFixture.plan.digest,
      writePaths: currentFixture.writePaths,
      sourceSearchSnapshotSha256: currentFixture.searchEvidence.workspaceSnapshotSha256,
      sourceObligationLedgerSha256: currentFixture.ledger.digest,
      technicalCorrectionEvidenceSha256: currentFixture.correction.digest,
      selection: branchSelected
        ? {
            branchId: "revise",
            input: {
              candidate0Digest: candidate0.digest,
              candidate0WorkspaceSnapshotDigest: candidate0.workspaceSnapshotDigest,
              originalRevision: currentFixture.revision,
              planDigest: currentFixture.plan.digest,
              writePaths: currentFixture.writePaths,
              sourceSearchSnapshotSha256: currentFixture.searchEvidence.workspaceSnapshotSha256,
              sourceObligationLedgerSha256: currentFixture.ledger.digest,
              technicalCorrectionEvidenceSha256: currentFixture.correction.digest,
              technical: producer(
                candidate0,
                "verify-technical-accuracy",
                currentFixture.technicalSummary,
              ),
              editorial: producer(
                candidate0,
                "review-documentation",
                currentFixture.editorialSummary,
              ),
            },
            revisionInputDigest,
          }
        : null,
      candidates: candidates.map((candidate) => ({
        candidate,
        revisionInputDigest: candidate.ordinal === 0 ? null : revisionInputDigest,
      })),
      revisionAdmission: candidate1Admitted
        ? createAuthoringRevisionAdmissionBindingV1({
            candidate0,
            candidate1,
            actualChangedPaths: revisionAccounting(currentFixture).changedPaths,
            accounting: revisionAccounting(currentFixture),
          })
        : null,
      partialCandidate1:
        stopAfter === "revise-documentation"
          ? createAuthoringPartialCandidateV1({
              runId: currentFixture.runId,
              inputCandidateDigest: candidate0.digest,
              revisionInputDigest,
              originalRevision: currentFixture.revision,
              planDigest: currentFixture.plan.digest,
              writePaths: currentFixture.writePaths,
              artifact: { sha256: "6".repeat(64), byteLength: 17 },
              workspaceSnapshotDigest: "7".repeat(64),
              failureCode: "writer-failed",
            })
          : null,
      selectedCandidateOrdinal: selected.ordinal,
      selectedProducers: null,
      includeFinalPatch: true,
    },
    currentWorkflow,
  );
  const record: RunRecord = {
    schemaVersion: 2,
    id: currentFixture.runId,
    workflow: "create-documentation",
    repository: currentFixture.repository,
    workspace: { strategy: "tracked-export", disposable: true },
    status: "failed",
    createdAt: "2026-09-15T00:00:00.000Z",
    models: [],
    skills: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0 },
    tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
    steps,
    authoringExecution: evidence,
    changes: {
      files: currentFixture.writePaths.map((path) => ({ path, status: "added" })),
      patch: {
        sha256: selected.patchDigestSha256,
        byteLength: selected.patchBytes,
        lineCount: 1,
        artifactPath: ".docsfab/authoring-run.patch",
        format: "git-diff",
      },
    },
  };
  validateAuthoringRunRecordV1(record, currentWorkflow);
  return record;
}

function producer(
  candidate: RealAuthoringEvidenceFixture["candidate0"],
  stepId: string,
  summary: string,
): AuthoringProducerSummaryBindingV1 {
  return {
    stepId,
    summarySha256: sha256(summary),
    candidateOrdinal: candidate.ordinal,
    candidateDigest: candidate.digest,
    workspaceSnapshotDigest: candidate.workspaceSnapshotDigest,
  };
}

function revisionAccounting(fixture: RealAuthoringEvidenceFixture): Record<string, unknown> {
  if (fixture.selection.kind !== "revise") throw new Error("Expected revision input.");
  const issueIds = [
    ...new Set(fixture.selection.input.actionableFacts.flatMap((fact) => fact.issueIds)),
  ].sort();
  return {
    issueAccounting: issueIds.map((issueId) => {
      const fact = fixture.selection.input.actionableFacts.find((candidate) =>
        candidate.issueIds.includes(issueId),
      );
      if (!fact) throw new Error(`Missing admitted fact for ${issueId}.`);
      return {
        issueId,
        disposition: "applied",
        reason: "The admitted source evidence supports this bounded correction.",
        sourceLocators: [fact.sourceLocators[0]],
      };
    }),
    changedPaths: [...fixture.writePaths],
    unresolvedFacts: [],
  };
}

function bindPhaseInvocations(
  steps: StepRunRecord[],
  path: ReturnType<typeof authoringSelectedPath>,
  currentWorkflow: typeof workflow,
  currentFixture: RealAuthoringEvidenceFixture,
  branchId: "retain" | "revise",
  candidates: readonly RealAuthoringEvidenceFixture["candidate0"][],
  revisionInputDigest: string | null,
): void {
  for (const step of steps) {
    const phase = path.phases.find((candidate) => candidate.stepId === step.id);
    if (!phase || (step.kind ?? "inference") === "host-operation") continue;
    const invocation = authoringPhaseInvocationBindingV1({
      workflow: currentWorkflow,
      branchId: phase.ordinal <= 7 ? null : branchId,
      stepId: step.id,
      candidates:
        phase.role === "writer"
          ? phase.stepId === "write-documentation"
            ? []
            : candidates.slice(0, 1)
          : candidates.slice(0, phase.candidateOrdinal + 1),
      revisionInputDigest: phase.stepId === "revise-documentation" ? revisionInputDigest : null,
    });
    const inference =
      step.inference ??
      ({
        attempts: [
          {
            identity: { repositoryRevision: currentFixture.revision },
          },
        ],
      } as unknown as NonNullable<StepRunRecord["inference"]>);
    step.inference = inference;
    for (const attempt of inference.attempts) {
      attempt.identity = {
        ...(attempt.identity ?? { repositoryRevision: currentFixture.revision }),
        authoringPhaseSha256: canonicalDigest(invocation),
      };
    }
  }
}

function canonical(value: unknown): string {
  return canonicalizeJsonEvidence(value as JsonEvidenceValue).trimEnd();
}
