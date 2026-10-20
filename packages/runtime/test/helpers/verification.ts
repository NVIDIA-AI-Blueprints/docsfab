// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { HarnessStepInput, HarnessStepResult } from "../../src/execution/contracts.js";
import { LocalWorkflowSearchCoordinator } from "../../src/search/local-workflow-coordinator.js";
import type { WorkflowSearchCoordinator } from "../../src/workflow-contracts/contracts.js";
import {
  authoritativeReviewTargetPaths,
  TECHNICAL_FACT_DIMENSIONS,
  type VerificationResult,
} from "../../src/workflow-execution/verification-result.js";
import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../../src/json-evidence.js";
import {
  TECHNICAL_CORRECTION_PROPOSAL_KIND,
  bindTechnicalCorrectionResponse,
  bindHostOwnedTechnicalCorrectionProposalV3,
  canonicalSourceObligationProposal,
  requiresSourceObligationLedger,
  requiresTechnicalCorrection,
  type SourceObligationLedgerProposalV1,
} from "../../src/workflow-execution/source-obligation.js";
import { sealOriginalSourceAuthority } from "../../src/workflow-execution/source-obligation-authority.js";

export function sourceObligationProposalFixture(
  sourceLocator = "src/api.ts:42",
): SourceObligationLedgerProposalV1 {
  return {
    completeness: "bounded-not-proven",
    dimensions: TECHNICAL_FACT_DIMENSIONS.map((dimension) => ({
      dimension,
      status: "not-applicable",
      reason: `The bounded fixture establishes no ${dimension} obligation.`,
      sourceLocators: [sourceLocator],
      obligations: [],
    })),
    limitations: [],
  };
}

export const inventorySearchCoordinatorFixture: WorkflowSearchCoordinator = {
  async search(input) {
    const repositoryPath = await mkdtemp(join(tmpdir(), "docsfab-inventory-search-"));
    try {
      await writeFile(join(repositoryPath, "README.md"), "inventory search evidence\n");
      return await new LocalWorkflowSearchCoordinator().search({ ...input, repositoryPath });
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  },
};

export const sourceObligationObserverFixture = {
  observe: async (paths: readonly string[]) =>
    [...new Set(paths)].sort().map((path) => ({ path, sha256: "f".repeat(64) })),
  assertUnchanged: async () => undefined,
  captureOriginalSourceAuthority: async (input: {
    runId: string;
    workflow: HarnessStepInput["workflow"];
    repositoryRevision: string;
    scopeSha256: string;
    workspaceSnapshotSha256: string;
    authorizedPaths?: readonly string[];
  }) =>
    sealOriginalSourceAuthority({
      ...input,
      scope:
        input.workflow.name === "create-documentation"
          ? "create-plan-sources"
          : "review-tracked-workspace",
      members: [
        ...new Set(
          input.authorizedPaths?.length
            ? input.authorizedPaths
            : ["README.md", "src/api.ts", "src/cli.ts", "src/contract.ts"],
        ),
      ]
        .sort()
        .map((path) => ({
          path,
          mode: 0o644,
          byteLength: 1,
          sourceSha256: "f".repeat(64),
        })),
    }),
};

/** Supply immutable original text for runner fixtures without a real workspace. */
export function preservationSourceObserverFixture(repositoryRevision: string) {
  return {
    ...sourceObligationObserverFixture,
    createPreservationSourceReader: ({ runId, stepId }: { runId: string; stepId: string }) =>
      Object.freeze({
        kind: "docsfab-preservation-source-reader",
        runId,
        stepId,
      }) as import("../../src/workflow-execution/source-obligation.js").PreservationSourceReaderV1,
    capturePreservationBase: async (paths: readonly string[]) =>
      Object.freeze({
        repositoryRevision,
        sources: Object.freeze(
          [...new Set(paths)].sort().map((path) => {
            const content = `# Original fixture document: ${path}\n`;
            return Object.freeze({
              path,
              content,
              sha256: createHash("sha256").update(content).digest("hex"),
            });
          }),
        ),
      }),
  };
}

export function verificationResultFixture(
  paths: readonly string[],
  sourceLocator = "src/api.ts:42",
): VerificationResult {
  return {
    review: { verdict: "pass", issues: [] },
    coverage: paths.map((path) => ({
      path,
      status: "verified",
      evidence: [sourceLocator],
      reason: "Checked the documented API against fixture source evidence.",
    })),
    factInventory: {
      completeness: "bounded-not-proven",
      dimensions: TECHNICAL_FACT_DIMENSIONS.map((dimension, index) => ({
        dimension,
        status: "applicable",
        reason: `Fixture source evidence covers ${dimension} behavior.`,
        sourceLocators: [],
        facts: [
          {
            id: `FIXTURE_FACT_${index + 1}`,
            dimension,
            sourceLocators: [sourceLocator],
            statement: `The fixture defines ${dimension} behavior for the admitted test scope.`,
            documentationDisposition: "documented",
            uncertainty: "The fixture evidence is bounded to this deterministic test.",
            issueIds: [],
          },
        ],
      })),
      limitations: [],
    },
  };
}

export function unverifiedVerificationResultFixture(
  paths: readonly string[],
  reason = "The deterministic fixture does not perform executable technical inspection.",
): VerificationResult {
  return {
    review: { verdict: "human-review", issues: [] },
    coverage: paths.map((path) => ({
      path,
      status: "unverified",
      evidence: [],
      reason,
    })),
    factInventory: {
      completeness: "bounded-not-proven",
      dimensions: TECHNICAL_FACT_DIMENSIONS.map((dimension) => {
        const dimensionReason = `${reason} Missing dimension: ${dimension}.`;
        return {
          dimension,
          status: "unverified",
          reason: dimensionReason,
          sourceLocators: [],
          facts: [],
        };
      }),
      limitations: TECHNICAL_FACT_DIMENSIONS.map(
        (dimension) => `${reason} Missing dimension: ${dimension}.`,
      ),
    },
  };
}

export async function verificationFixture(
  input: HarnessStepInput,
): Promise<
  | Pick<
      HarnessStepResult,
      "summary" | "verificationResult" | "sourceObligationProposal" | "technicalCorrectionEvidence"
    >
  | Record<string, never>
> {
  if (requiresSourceObligationLedger(input)) {
    const sourcePath = input.planBinding?.sourceBindings[0]?.sources[0];
    const specificLocator =
      typeof sourcePath === "string" &&
      /:\d+(?:-\d+)?$/u.test(sourcePath) &&
      !sourcePath.startsWith("git:") &&
      !sourcePath.includes("://");
    const repositoryPathLocator =
      typeof sourcePath === "string" &&
      !sourcePath.includes(":") &&
      !sourcePath.startsWith("artifact:");
    const sourceLocator = specificLocator
      ? sourcePath
      : repositoryPathLocator
        ? `${sourcePath}:1`
        : "src/api.ts:42";
    const sourceObligationProposal = sourceObligationProposalFixture(sourceLocator);
    return {
      summary: canonicalSourceObligationProposal(sourceObligationProposal),
      sourceObligationProposal,
    };
  }
  if (input.step.skill !== "verify-technical-accuracy") return {};
  const paths = authoritativeReviewTargetPaths(input) ?? ["README.md"];
  const sourceLocator = `${input.sourceObligationLedger?.identity.sources[0]?.path ?? "src/api.ts"}:1`;
  const verificationResult = verificationResultFixture(paths, sourceLocator);
  if (requiresTechnicalCorrection(input)) {
    if (!input.sourceObligationLedger) throw new Error("Fixture correction requires a ledger.");
    const correction =
      input.sourceObligationLedger.schemaVersion === 2
        ? await bindHostOwnedTechnicalCorrectionProposalV3(
            {
              kind: TECHNICAL_CORRECTION_PROPOSAL_KIND,
              schemaVersion: 3,
              verdict: verificationResult.review.verdict,
              coverage: verificationResult.coverage,
              factInventory: verificationResult.factInventory,
              issueJudgments: [],
              obligationAccounting: [],
            },
            input.sourceObligationLedger,
            input.originalSourceAuthorityAdmission ??
              (() => {
                throw new Error("Fixture correction requires original source authority.");
              })(),
            input.runId ?? "",
            paths,
          )
        : bindTechnicalCorrectionResponse(
            { verificationResult, obligationAccounting: [] },
            input.sourceObligationLedger,
            (value) => value as VerificationResult,
          );
    return {
      summary: canonicalizeJsonEvidence(
        correction.verificationResult as unknown as JsonEvidenceValue,
      ).trimEnd(),
      verificationResult: correction.verificationResult,
      technicalCorrectionEvidence: correction.evidence,
    };
  }
  return {
    summary: canonicalizeJsonEvidence(verificationResult as unknown as JsonEvidenceValue).trimEnd(),
    verificationResult,
  };
}
