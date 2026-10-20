// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CREATE names the source its bound evidence lacks instead of stopping at a
 * dead end: an unverified ledger dimension (here the Node.js prerequisite that
 * only README states) becomes a named InputAsk slot, and selection keeps its
 * strict `unverified-coverage` refusal.
 */
import { describe, expect, it } from "vitest";

import { sha256 } from "../src/content-ir/canonical.js";
import {
  editorialInputAskPresentationV1,
  parseSourceSupportInputIdV1,
  sourceSupportInputIdV1,
} from "../src/artifacts/editorial-input-ask.js";
import type { HarnessStepInput } from "../src/execution/contracts.js";
import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../src/json-evidence.js";
import {
  AUTHORING_SOURCE_SUPPORT_CODES,
  authoringSourceSupportGaps,
  createAuthoringCandidate,
  selectAuthoringRevision,
  type AuthoringRevisionValidationContextV1,
} from "../src/workflow-execution/authoring-candidate.js";
import { documentationPlanBindingDigest } from "../src/workflow-execution/plan-binding.js";
import {
  TECHNICAL_FACT_DIMENSIONS,
  type TechnicalFactDimension,
  type VerificationResult,
} from "../src/workflow-execution/review-response.js";
import {
  bindSourceObligationLedger,
  bindTechnicalCorrectionResponse,
  type SourceObligationLedgerProposalV1,
} from "../src/workflow-execution/source-obligation.js";
import { searchStepEvidence } from "./helpers/search-evidence-fixture.js";

const REVISION = "a".repeat(40);
const PATCH = "c".repeat(64);
const SNAPSHOT = "d".repeat(64);
const PAGE = "docs/cli-reference.md";
const SOURCE = "src/sprout.mjs";
const LOCATOR = `${SOURCE}:1-20`;
const ENVIRONMENT = "environment-prerequisite";

describe("CREATE source-support InputAsk slots (#1297)", () => {
  it("names the missing environment-prerequisite source for docs/cli-reference.md (b658bdb shape)", () => {
    const context = createContext({ unverifiedDimension: ENVIRONMENT, coverage: "unverified" });

    const gaps = authoringSourceSupportGaps(context);

    expect(gaps).toEqual([
      {
        inputId: `source-support:${ENVIRONMENT}:${PAGE}`,
        code: "authoring-candidate-unverified-coverage",
        pagePath: PAGE,
        dimension: ENVIRONMENT,
      },
    ]);
    const presentation = editorialInputAskPresentationV1(gaps[0]!.inputId);
    expect(presentation).toEqual({
      label: `Source for environment prerequisite on ${PAGE}`,
      why: expect.stringContaining("a paragraph cannot certify source support"),
      fillKind: "path",
    });
    // Selection still refuses the same context.
    expect(() => selectAuthoringRevision(context)).toThrowError(
      expect.objectContaining({ code: "unverified-coverage" }),
    );
  });

  it("routes a host-owned unverified dimension the same way when coverage reads verified", () => {
    const context = createContext({ unverifiedDimension: ENVIRONMENT, coverage: "verified" });

    expect(authoringSourceSupportGaps(context)).toEqual([
      {
        inputId: `source-support:${ENVIRONMENT}:${PAGE}`,
        code: AUTHORING_SOURCE_SUPPORT_CODES.dimension,
        pagePath: PAGE,
        dimension: ENVIRONMENT,
      },
    ]);
  });

  it("names the page when coverage is unverified with no dimension gap", () => {
    const context = createContext({ coverage: "unverified" });

    expect(authoringSourceSupportGaps(context)).toEqual([
      {
        inputId: `source-support:documented-behavior:${PAGE}`,
        code: AUTHORING_SOURCE_SUPPORT_CODES.coverage,
        pagePath: PAGE,
        dimension: "documented-behavior",
      },
    ]);
  });

  it("finds no gap in fully supported evidence and leaves selection unchanged", () => {
    const context = createContext({ coverage: "verified" });

    expect(authoringSourceSupportGaps(context)).toEqual([]);
    expect(selectAuthoringRevision(context)).toEqual({ kind: "retain", reason: "no-actionable" });
  });

  it("still refuses a stale binding instead of turning it into an InputAsk", () => {
    const context = createContext({ unverifiedDimension: ENVIRONMENT, coverage: "unverified" });
    const stale = {
      ...context,
      technical: { ...context.technical, candidateDigest: "e".repeat(64) },
    };

    expect(() => authoringSourceSupportGaps(stale)).toThrowError(
      expect.objectContaining({ code: "stale-evidence" }),
    );
  });

  it("reads source-support slot ids strictly", () => {
    expect(sourceSupportInputIdV1({ dimension: ENVIRONMENT, pagePath: PAGE })).toBe(
      `source-support:${ENVIRONMENT}:${PAGE}`,
    );
    expect(parseSourceSupportInputIdV1(`source-support:${ENVIRONMENT}:${PAGE}`)).toEqual({
      dimension: ENVIRONMENT,
      pagePath: PAGE,
    });
    for (const inputId of [
      "source-support:environment-prerequisite",
      "source-support:Environment:docs/a.md",
      "source-support:environment-prerequisite:../secret.md",
      "source-support:environment-prerequisite:/etc/passwd",
      "source-support:environment-prerequisite:docs/a.md:extra",
      "sourcesupport:environment-prerequisite:docs/a.md",
    ]) {
      expect(parseSourceSupportInputIdV1(inputId)).toBeUndefined();
      expect(editorialInputAskPresentationV1(inputId)).toBeUndefined();
    }
    expect(editorialInputAskPresentationV1("toString")).toBeUndefined();
  });
});

function createContext(options: {
  readonly unverifiedDimension?: TechnicalFactDimension;
  readonly coverage: "verified" | "unverified";
}): AuthoringRevisionValidationContextV1 {
  const pages = [{ path: PAGE, disposition: "create" as const }];
  const sourceBindings = [{ pagePath: PAGE, sources: [SOURCE] }];
  const planBinding = {
    kind: "docsfab-documentation-plan" as const,
    schemaVersion: 1 as const,
    mode: "create" as const,
    pages,
    sourceBindings,
    digest: documentationPlanBindingDigest({ mode: "create", pages, sourceBindings }),
  };
  const sourceObligationInput = {
    workflow: {
      name: "create-documentation",
      steps: [],
    } as unknown as HarnessStepInput["workflow"],
    evidenceIdentity: { repositoryRevision: REVISION } as HarnessStepInput["evidenceIdentity"],
    searchEvidence: searchStepEvidence({
      evidenceSha256: "e".repeat(64),
      workspaceSnapshotSha256: "f".repeat(64),
    }),
    planBinding,
  };
  const unverified = (dimension: TechnicalFactDimension): boolean =>
    dimension === options.unverifiedDimension;
  const gapReason = "The bound source does not establish this dimension.";
  const proposal: SourceObligationLedgerProposalV1 = {
    completeness: "bounded-not-proven",
    dimensions: TECHNICAL_FACT_DIMENSIONS.map((dimension) => ({
      dimension,
      status: unverified(dimension) ? "unverified" : "not-applicable",
      reason: unverified(dimension)
        ? gapReason
        : "The bound source has no obligation in this dimension.",
      sourceLocators: unverified(dimension) ? [] : [LOCATOR],
      obligations: [],
    })),
    limitations: options.unverifiedDimension ? [gapReason] : [],
  };
  const ledger = bindSourceObligationLedger(proposal, sourceObligationInput, [
    { path: SOURCE, sha256: "f".repeat(64) },
  ]);
  const unsupported =
    options.unverifiedDimension !== undefined || options.coverage === "unverified";
  const technicalResult: VerificationResult = {
    review: { verdict: unsupported ? "human-review" : "pass", issues: [] },
    coverage: [
      {
        path: PAGE,
        status: options.coverage,
        evidence: [LOCATOR],
        reason: "The planned page was compared with the bound source.",
      },
    ],
    factInventory: {
      completeness: "bounded-not-proven",
      dimensions: TECHNICAL_FACT_DIMENSIONS.map((dimension) => ({
        dimension,
        status: unverified(dimension) ? "unverified" : "not-applicable",
        reason: unverified(dimension)
          ? gapReason
          : "The bound source has no claim in this dimension.",
        sourceLocators: unverified(dimension) ? [] : [LOCATOR],
        facts: [],
      })),
      limitations: [
        ...(options.unverifiedDimension ? [gapReason] : []),
        ...(options.coverage === "unverified"
          ? ["The bound source does not establish every claim."]
          : []),
      ],
    },
  };
  const correction = bindTechnicalCorrectionResponse(
    { verificationResult: technicalResult, obligationAccounting: [] },
    ledger,
    (value) => value as VerificationResult,
  );
  const technicalSummary = canonicalizeJsonEvidence(
    correction.verificationResult as unknown as JsonEvidenceValue,
  ).trimEnd();
  const editorialResult = { verdict: "pass" as const, issues: [] };
  const editorialSummary = canonicalizeJsonEvidence(
    editorialResult as unknown as JsonEvidenceValue,
  ).trimEnd();
  const candidate0 = createAuthoringCandidate({
    runId: "run-1297",
    ordinal: 0,
    originalRevision: REVISION,
    planDigest: planBinding.digest,
    writePaths: [PAGE],
    patchDigestSha256: PATCH,
    patchBytes: 12,
    workspaceSnapshotDigest: SNAPSHOT,
  });
  return {
    candidate0,
    originalRevision: REVISION,
    planDigest: planBinding.digest,
    writePaths: [PAGE],
    technical: {
      summary: technicalSummary,
      summaryDigest: sha256(technicalSummary),
      producerId: "verify-technical-accuracy",
      candidateDigest: candidate0.digest,
      candidateOrdinal: 0,
      workspaceSnapshotDigest: SNAPSHOT,
      result: correction.verificationResult,
    },
    editorial: {
      summary: editorialSummary,
      summaryDigest: sha256(editorialSummary),
      producerId: "review-documentation",
      candidateDigest: candidate0.digest,
      candidateOrdinal: 0,
      workspaceSnapshotDigest: SNAPSHOT,
      result: editorialResult,
    },
    sourceObligationInput,
    sourceObligationLedger: ledger,
    technicalCorrectionEvidence: correction.evidence,
  };
}
