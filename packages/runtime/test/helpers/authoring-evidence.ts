// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { sha256 } from "../../src/content-ir/canonical.js";
import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../../src/json-evidence.js";
import { LocalWorkflowSearchCoordinator } from "../../src/search/local-workflow-coordinator.js";
import {
  createAuthoringCandidate,
  selectAuthoringRevision,
  type AuthoringCandidateV1,
  type AuthoringRevisionSelection,
} from "../../src/workflow-execution/authoring-candidate.js";
import { sealDocumentationPlanBinding } from "../../src/workflow-execution/plan-binding.js";
import type {
  ReviewResult,
  TechnicalFactDimension,
  VerificationResult,
} from "../../src/workflow-execution/review-response.js";
import {
  bindSourceObligationLedger,
  bindTechnicalCorrectionResponse,
  type SourceObligationLedgerProposalV1,
  type SourceObligationLedgerV1,
  type TechnicalCorrectionEvidenceV1,
} from "../../src/workflow-execution/source-obligation.js";
import type {
  WorkflowDefinition,
  WorkflowSearchStepEvidenceV1,
} from "../../src/workflow-contracts/contracts.js";
import { normalizeWorkflowSearchEvidence } from "../../src/workflow-contracts/search.js";

const SOURCE_PATH = "src/contract.ts";
const TARGET_PATH = "docs/guide.md";
const SOURCE_LOCATOR = `${SOURCE_PATH}:1-3`;
const DIMENSIONS = [
  "input-representations",
  "defaults-and-overrides",
  "mutable-state",
  "destination-and-trust",
  "error-status-retry",
  "environment-prerequisite",
] as const satisfies readonly TechnicalFactDimension[];

export interface RealAuthoringEvidenceFixture {
  readonly root: string;
  readonly runId: string;
  readonly revision: string;
  readonly repository: {
    readonly sourcePath: string;
    readonly requestedRevision: string;
    readonly revision: string;
  };
  readonly plan: ReturnType<typeof sealDocumentationPlanBinding>;
  readonly writePaths: readonly string[];
  readonly searchEvidence: WorkflowSearchStepEvidenceV1;
  readonly ledger: SourceObligationLedgerV1;
  readonly ledgerSummary: string;
  readonly technicalResult: VerificationResult;
  readonly technicalSummary: string;
  readonly correction: TechnicalCorrectionEvidenceV1;
  readonly editorialResult: ReviewResult;
  readonly editorialSummary: string;
  readonly candidate0: AuthoringCandidateV1;
  readonly selection: AuthoringRevisionSelection;
  readonly dispose: () => Promise<void>;
}

/** Build real, byte-canonical retained selection evidence for CREATE V3 tests. */
export async function createRealAuthoringEvidenceFixture(
  workflow: WorkflowDefinition,
  options: {
    actionable: boolean;
    runId?: string;
    revision?: string;
    additionalWritePaths?: readonly string[];
  },
): Promise<RealAuthoringEvidenceFixture> {
  const runId = options.runId ?? "authoring-run";
  const revision = options.revision ?? "a".repeat(64);
  const root = await mkdtemp(join(tmpdir(), "docsfab-authoring-evidence-"));
  const source = "export const requiredBehavior = true;\nexport const defaultMode = 'safe';\n";
  const writePaths = [TARGET_PATH, ...(options.additionalWritePaths ?? [])].sort();
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "docs"), { recursive: true });
  await writeFile(join(root, SOURCE_PATH), source, "utf8");
  await writeFile(join(root, TARGET_PATH), "# Guide\n\nCurrent behavior.\n", "utf8");
  await Promise.all(
    writePaths
      .filter((path) => path !== TARGET_PATH)
      .map(async (path) => {
        await mkdir(dirname(join(root, path)), { recursive: true });
        await writeFile(join(root, path), "# Additional page\n", "utf8");
      }),
  );

  try {
    const repository = {
      sourcePath: "source",
      requestedRevision: revision,
      revision,
    };
    const deriveStep = workflow.authoringSchedule?.prefix.steps.find(
      (step) => step.id === "derive-source-obligations",
    );
    if (!deriveStep?.search) throw new Error("CREATE V3 derive search plan is unavailable.");
    const rawSearch = await new LocalWorkflowSearchCoordinator().search({
      runId,
      repositoryPath: root,
      repository,
      workflow,
      step: deriveStep,
      plan: deriveStep.search,
    });
    const searchEvidence = normalizeWorkflowSearchEvidence({
      plan: deriveStep.search,
      repository,
      repositoryIdentitySha256: rawSearch.repositoryIdentitySha256,
      searches: rawSearch.searches,
      workspaceSnapshotSha256: rawSearch.workspaceSnapshotSha256,
    });
    const plan = sealDocumentationPlanBinding(
      {
        mode: "create",
        pages: writePaths.map((path) => ({ path, disposition: "create" as const })),
        sourceBindings: writePaths.map((pagePath) => ({ pagePath, sources: [SOURCE_PATH] })),
      },
      { expectedMode: "create" },
    );
    const sourceObligationInput = {
      workflow,
      evidenceIdentity: { repositoryRevision: revision },
      searchEvidence,
      planBinding: plan,
    };
    const ledgerProposal: SourceObligationLedgerProposalV1 = {
      completeness: "bounded-not-proven",
      dimensions: DIMENSIONS.map((dimension) => ({
        dimension,
        status: "not-applicable" as const,
        reason: "The bounded fixture declares no source obligation in this dimension.",
        sourceLocators: [SOURCE_LOCATOR],
        obligations: [],
      })),
      limitations: [],
    };
    const ledger = bindSourceObligationLedger(ledgerProposal, sourceObligationInput, [
      { path: SOURCE_PATH, sha256: sha256(source) },
    ]);
    const ledgerSummary = canonicalizeJsonEvidence(
      ledger as unknown as JsonEvidenceValue,
    ).trimEnd();
    const technicalResult = technicalResultFor(options.actionable, writePaths);
    const correction = bindTechnicalCorrectionResponse(
      { verificationResult: technicalResult, obligationAccounting: [] },
      ledger,
      (value) => value as VerificationResult,
    );
    const admittedTechnical = correction.verificationResult;
    const editorialResult: ReviewResult = { verdict: "pass", issues: [] };
    const technicalSummary = canonicalizeJsonEvidence(
      admittedTechnical as unknown as JsonEvidenceValue,
    ).trimEnd();
    const editorialSummary = canonicalizeJsonEvidence(
      editorialResult as unknown as JsonEvidenceValue,
    ).trimEnd();
    const candidate0 = createAuthoringCandidate({
      runId,
      ordinal: 0,
      originalRevision: revision,
      planDigest: plan.digest,
      writePaths,
      patchDigestSha256: "1".repeat(64),
      patchBytes: 101,
      workspaceSnapshotDigest: "2".repeat(64),
    });
    const selection = selectAuthoringRevision({
      candidate0,
      originalRevision: revision,
      planDigest: plan.digest,
      writePaths,
      technical: {
        summary: technicalSummary,
        summaryDigest: sha256(technicalSummary),
        producerId: "verify-technical-accuracy",
        candidateDigest: candidate0.digest,
        candidateOrdinal: 0,
        workspaceSnapshotDigest: candidate0.workspaceSnapshotDigest,
        result: admittedTechnical,
      },
      editorial: {
        summary: editorialSummary,
        summaryDigest: sha256(editorialSummary),
        producerId: "review-documentation",
        candidateDigest: candidate0.digest,
        candidateOrdinal: 0,
        workspaceSnapshotDigest: candidate0.workspaceSnapshotDigest,
        result: editorialResult,
      },
      sourceObligationInput,
      sourceObligationLedger: ledger,
      technicalCorrectionEvidence: correction.evidence,
    });
    return {
      root,
      runId,
      revision,
      repository,
      plan,
      writePaths,
      searchEvidence,
      ledger,
      ledgerSummary,
      technicalResult: admittedTechnical,
      technicalSummary,
      correction: correction.evidence,
      editorialResult,
      editorialSummary,
      candidate0,
      selection,
      dispose: () => rm(root, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

function technicalResultFor(
  actionable: boolean,
  writePaths: readonly string[],
): VerificationResult {
  const issueId = actionable ? "TECH-001" : undefined;
  return {
    review: {
      verdict: actionable ? "needs-revision" : "pass",
      issues: issueId
        ? [
            {
              id: issueId,
              severity: "major",
              category: "technical_accuracy",
              location: TARGET_PATH,
              finding: "The required behavior is omitted.",
              evidence: { source_id: "source", locator: SOURCE_LOCATOR },
              required_change: "Document the source-backed behavior.",
            },
          ]
        : [],
    },
    coverage: writePaths.map((path) => ({
      path,
      status: "verified",
      evidence: [SOURCE_LOCATOR],
      reason: "The planned page was checked against the bounded source snapshot.",
    })),
    factInventory: {
      completeness: "bounded-not-proven",
      dimensions: DIMENSIONS.map((dimension) =>
        dimension === "input-representations"
          ? {
              dimension,
              status: "applicable" as const,
              reason: "The source exposes an input behavior.",
              sourceLocators: [],
              facts: [
                {
                  id: "FACT-001",
                  dimension,
                  sourceLocators: [SOURCE_LOCATOR],
                  statement: actionable
                    ? "The page omits the required source-backed behavior."
                    : "The page documents the required source-backed behavior.",
                  documentationDisposition: actionable
                    ? ("omitted" as const)
                    : ("documented" as const),
                  uncertainty: "The retained source search bounds this observation.",
                  issueIds: issueId ? [issueId] : [],
                },
              ],
            }
          : {
              dimension,
              status: "not-applicable" as const,
              reason: "The source fixture has no claim in this dimension.",
              sourceLocators: [SOURCE_LOCATOR],
              facts: [],
            },
      ),
      limitations: [],
    },
  };
}
