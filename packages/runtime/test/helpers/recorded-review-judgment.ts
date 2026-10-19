// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";

import type { WorkflowName } from "../../src/workflow-contracts/contracts.js";

import {
  bindSourceObligationLedgerV2,
  getWorkflow,
  issueOriginalSourceAuthorityAdmission,
  reviewSourcePhaseInput,
  sealOriginalSourceAuthority,
  sourceObligationScopeSha256,
  type HarnessStepInput,
  type SourceObligationLedgerProposalV1,
} from "../support/pi-harness-session-fixtures.js";

/** The one page the recorded judgment was written against. */
export const RECORDED_JUDGMENT_TARGET = "docs/quickstart.md";

const RUN_ID = "review-cli-1219";

function read(name: string): string {
  return readFileSync(
    new URL(`../fixtures/review-cli-correction/${name}`, import.meta.url),
    "utf8",
  );
}

/**
 * The recorded ledger (18 obligations over six applicable dimensions), sealed
 * for `repositoryPath` over `targets`, the recorded judgment a real model wrote
 * against it, and the two `review-documentation` judgment steps' inputs.
 *
 * `widenLedger` keeps the recorded obligations but has each cite
 * `locatorsPerObligation` distinct lines of one admitted source at
 * `sourcePath`, so the ledger's own size can be raised without more targets.
 */
export function recordedReviewJudgmentFixture(
  repositoryPath: string,
  options: {
    workflowName?: WorkflowName;
    targets?: readonly string[];
    widenLedger?: { readonly sourcePath: string; readonly locatorsPerObligation: number };
  } = {},
) {
  const workflowName = options.workflowName ?? "review-documentation";
  const targets = [...(options.targets ?? [RECORDED_JUDGMENT_TARGET])];
  const ledgerFixture = JSON.parse(read("recorded-ledger.json")) as {
    ledgerProposal: SourceObligationLedgerProposalV1;
    repositoryRevision: string;
    sources: Array<{ path: string; sha256: string }>;
  };
  const widen = options.widenLedger;
  if (widen) {
    ledgerFixture.sources = [{ ...ledgerFixture.sources[0]!, path: widen.sourcePath }];
    for (const dimension of ledgerFixture.ledgerProposal.dimensions) {
      for (const obligation of dimension.obligations) {
        obligation.sourceLocators = Array.from(
          { length: widen.locatorsPerObligation },
          (_, index) => `${widen.sourcePath}:${index + 1}`,
        );
      }
    }
  }
  const judgment = JSON.parse(read("recorded-judgment.json")) as Record<string, unknown>;
  const workflow = getWorkflow(workflowName);
  const base = reviewSourcePhaseInput(repositoryPath, "derive-source-obligations");
  const reviewScope = { ...base.reviewScope!, targetPaths: targets };
  const evidenceIdentity = { repositoryRevision: ledgerFixture.repositoryRevision };
  const deriveInput: HarnessStepInput = {
    ...base,
    workflow,
    runId: RUN_ID,
    evidenceIdentity,
    reviewScope,
  };
  const scopeSha256 = sourceObligationScopeSha256(deriveInput);
  const sourceSha256 = ledgerFixture.sources[0]!.sha256;
  const sealed = sealOriginalSourceAuthority({
    runId: RUN_ID,
    scope:
      workflowName === "create-documentation" ? "create-plan-sources" : "review-tracked-workspace",
    repositoryRevision: ledgerFixture.repositoryRevision,
    scopeSha256,
    workspaceSnapshotSha256: deriveInput.searchEvidence!.workspaceSnapshotSha256,
    members: [
      { path: widen?.sourcePath ?? "src/sprout.mjs", mode: 0o755, byteLength: 1, sourceSha256 },
    ],
  });
  const ledger = bindSourceObligationLedgerV2(
    ledgerFixture.ledgerProposal,
    deriveInput,
    ledgerFixture.sources,
    sealed.evidence,
  );
  const admission = issueOriginalSourceAuthorityAdmission({
    capture: sealed.capture,
    observer: { observe: async (paths) => paths.map((path) => ({ path, sha256: sourceSha256 })) },
    runId: RUN_ID,
    repositoryRevision: ledgerFixture.repositoryRevision,
    scopeSha256,
    workspaceSnapshotSha256: deriveInput.searchEvidence!.workspaceSnapshotSha256,
  });
  const stepInput = (stepId: string): HarnessStepInput => ({
    ...reviewSourcePhaseInput(repositoryPath, "provisional-technical-verification"),
    workflow,
    step: workflow.steps.find((step) => step.id === stepId)!,
    runId: RUN_ID,
    evidenceIdentity,
    reviewScope,
    sourceObligationLedger: ledger,
  });
  return {
    targets,
    ledger,
    judgment,
    /** The real reply, in the member order the model wrote it. */
    answer: JSON.stringify(judgment),
    sealedEvidence: sealed.evidence,
    provisional: stepInput("provisional-technical-verification"),
    correction: {
      ...stepInput("verify-technical-accuracy"),
      originalSourceAuthorityAdmission: admission,
    } satisfies HarnessStepInput,
  };
}

/** The recorded attempts 1-3: every row reduced to `{obligationId, disposition: "retained"}`. */
export function probe7AttemptRows(judgment: Record<string, unknown>): string {
  return JSON.stringify({
    ...judgment,
    obligationJudgments: (judgment.obligationJudgments as Array<Record<string, unknown>>).map(
      (row) => ({ obligationId: row.obligationId, disposition: "retained" }),
    ),
  });
}

/** The recorded judgment with one issue judgment's members overridden. */
export function withIssueJudgment(
  judgment: Record<string, unknown>,
  id: string,
  patch: Record<string, unknown>,
): string {
  const issues = (judgment.issueJudgments as Array<Record<string, unknown>>).map((issue) =>
    issue.id === id ? { ...issue, ...patch } : issue,
  );
  return JSON.stringify({ ...judgment, issueJudgments: issues });
}
