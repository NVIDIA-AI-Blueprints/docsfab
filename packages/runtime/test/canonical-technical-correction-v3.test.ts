// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { canonicalDigest } from "../src/content-ir/canonical.js";
import type { HarnessStepInput } from "../src/execution/contracts.js";
import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../src/json-evidence.js";
import type { RunRecord } from "../src/records/contracts.js";
import { projectReviewFindingsFromRun } from "../src/review/findings.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import { createDocumentationPlanBinding } from "../src/workflow-execution/plan-binding.js";
import {
  TECHNICAL_FACT_DIMENSIONS,
  validateVerificationResult,
  type TechnicalFactInventory,
  type TechnicalSourceFact,
  type VerificationResult,
} from "../src/workflow-execution/review-response.js";
import {
  TECHNICAL_CORRECTION_PROPOSAL_KIND,
  bindSourceObligationLedger,
  bindSourceObligationLedgerV2,
  bindTechnicalCorrectionResponse,
  bindTechnicalCorrectionResponseV2,
  bindHostOwnedTechnicalCorrectionProposalV3,
  decodeTechnicalCorrectionResponseV3,
  decodeTechnicalCorrectionResponseV4,
  decodeProvisionalRichJudgment,
  sourceObligationScopeSha256,
  validateTechnicalCorrectionEvidence,
  validateTechnicalRichCandidateBinding,
  type SourceObligationLedgerProposalV1,
  type TechnicalCorrectionEvidenceV3,
  type TechnicalCorrectionIssueJudgmentV3,
  type TechnicalCorrectionProposalV3,
} from "../src/workflow-execution/source-obligation.js";
import {
  issueOriginalSourceAuthorityAdmission,
  sealOriginalSourceAuthority,
  type OriginalSourceAuthorityEvidenceV1,
} from "../src/workflow-execution/source-obligation-authority.js";
import { searchStepEvidence } from "./helpers/search-evidence-fixture.js";
import { recordedReviewJudgmentFixture } from "./helpers/recorded-review-judgment.js";
import * as judgmentByteBounds from "../src/workflow-execution/source-obligation/judgment-byte-bounds.js";

const REVISION = "a".repeat(40);
const SOURCE_SHA256 = "f".repeat(64);
const SEARCH_SHA256 = "b".repeat(64);
const SNAPSHOT_SHA256 = "c".repeat(64);
const RUN_ID = "canonical-correction-v3-run";
const TARGETS = ["docs/alpha.md", "docs/guide.md"] as const;

describe("fixed rich final technical assessment", () => {
  it("normalizes supported grounding and withholds contradictory or changed qualifications", async () => {
    const fixture = recordedReviewJudgmentFixture("/workspace");
    const issue = (
      fixture.judgment.issueJudgments as Array<{ id: string; obligationIds: string[] }>
    )[0]!;
    const candidate = {
      issueId: issue.id,
      obligationIds: issue.obligationIds,
      title: "Correct the bounded source behavior",
      readerConsequence: "Readers can choose the wrong mode.",
      proposedEdit: {
        kind: "advice",
        text: "Document the bounded behavior and its qualification.\r\n",
      },
    };
    const provisional = decodeProvisionalRichJudgment(
      JSON.stringify({
        kind: "docsfab-provisional-rich-judgment",
        schemaVersion: 1,
        judgment: fixture.judgment,
        richCandidates: [candidate],
      }),
      fixture.ledger,
      fixture.targets,
    );
    const obligations = new Map(
      fixture.ledger.dimensions.flatMap((dimension) =>
        dimension.obligations.map((row) => [row.id, row] as const),
      ),
    );
    const grounds = issue.obligationIds.map((obligationId) => {
      const obligation = obligations.get(obligationId)!;
      return {
        obligationId,
        status: "supported",
        rationale: "The source supports this complete edit.",
        sourceLocators: obligation.sourceLocators,
        uncertainty: obligation.uncertainty,
      };
    });
    const reply = {
      kind: "docsfab-technical-rich-judgment",
      schemaVersion: 1,
      ...fixture.judgment,
      richAssessments: [
        {
          issueId: issue.id,
          candidateSha256: provisional.evidence.candidates[0]!.candidateSha256,
          grounds,
        },
      ],
    };
    const decode = (value: unknown) =>
      decodeTechnicalCorrectionResponseV4(
        JSON.stringify(value),
        fixture.ledger,
        fixture.correction.originalSourceAuthorityAdmission!,
        fixture.correction.runId!,
        fixture.targets,
        provisional.evidence,
      );
    const admitted = await decode(reply);
    expect(admitted.evidence.schemaVersion).toBe(4);
    expect(admitted.evidence.richIssues[0]).toMatchObject({
      issueId: issue.id,
      status: "admitted",
      title: candidate.title,
      proposedEdit: candidate.proposedEdit,
    });
    validateTechnicalRichCandidateBinding(admitted.evidence, provisional.evidence, fixture.ledger);
    const evidenceScopes: Array<judgmentByteBounds.TechnicalCorrectionByteBoundScope> = [];
    const originalBound = judgmentByteBounds.assertCanonicalJsonByteBound;
    const boundSpy = vi
      .spyOn(judgmentByteBounds, "assertCanonicalJsonByteBound")
      .mockImplementation((value, bound, scope) => {
        if (bound === "evidence") evidenceScopes.push(scope);
        return originalBound(value, bound, scope);
      });
    try {
      await decode(reply);
      expect(evidenceScopes.at(-1)).toMatchObject({
        origin: "reply",
        hostFillsCoverage: false,
      });
      await decodeTechnicalCorrectionResponseV4(
        JSON.stringify(reply),
        fixture.ledger,
        fixture.correction.originalSourceAuthorityAdmission!,
        fixture.correction.runId!,
        fixture.targets,
        provisional.evidence,
        undefined,
        { degradeCoverage: true },
      );
    } finally {
      boundSpy.mockRestore();
    }
    expect(evidenceScopes.length).toBeGreaterThanOrEqual(2);
    expect(evidenceScopes.at(-1)).toMatchObject({
      origin: "reply",
      hostFillsCoverage: true,
    });
    expect(
      validateTechnicalCorrectionEvidence(
        admitted.evidence,
        fixture.ledger,
        admitted.verificationResult,
        fixture.sealedEvidence,
        fixture.targets,
      ).digest,
    ).toBe(admitted.evidence.digest);
    const contradicted = structuredClone(reply);
    contradicted.richAssessments[0]!.grounds[0]!.status = "contradicted";
    expect((await decode(contradicted)).evidence.richIssues[0]).toEqual({
      issueId: issue.id,
      status: "unavailable",
      reason: "contradicted",
    });
    const changedQualifier = structuredClone(reply);
    changedQualifier.richAssessments[0]!.grounds[0]!.uncertainty = "The condition was erased.";
    expect((await decode(changedQualifier)).evidence.richIssues[0]).toEqual({
      issueId: issue.id,
      status: "unavailable",
      reason: "qualification-unproven",
    });
    const wrongSet = structuredClone(reply);
    wrongSet.richAssessments[0]!.candidateSha256 = "0".repeat(64);
    await expect(decode(wrongSet)).rejects.toThrow();
    const forgedLocator = structuredClone(reply);
    forgedLocator.richAssessments[0]!.grounds[0]!.sourceLocators = ["src/unissued.ts:1"];
    await expect(decode(forgedLocator)).rejects.toThrow();
  });

  it("retains distinct fixed actions on issues that share one admitted source fact", async () => {
    const fixture = recordedReviewJudgmentFixture("/workspace");
    const judgment = structuredClone(fixture.judgment);
    const issues = judgment.issueJudgments as Array<{
      id: string;
      obligationIds: string[];
    }>;
    const first = issues[0]!;
    const second = issues.find((issue) => issue.id === "TECH-005")!;
    second.obligationIds.push(first.obligationIds[0]!);
    const candidates = [
      {
        issueId: first.id,
        obligationIds: first.obligationIds,
        title: "Correct the default",
        readerConsequence: "Readers choose an unsafe default.",
        proposedEdit: { kind: "advice", text: "State the qualified default exactly.\n" },
      },
      {
        issueId: second.id,
        obligationIds: second.obligationIds,
        title: "Correct the complete workflow",
        readerConsequence: "Readers miss a later step.",
        proposedEdit: { kind: "advice", text: "State the later step separately.\n" },
      },
    ];
    const provisional = decodeProvisionalRichJudgment(
      JSON.stringify({
        kind: "docsfab-provisional-rich-judgment",
        schemaVersion: 1,
        judgment,
        richCandidates: candidates,
      }),
      fixture.ledger,
      fixture.targets,
    );
    const obligations = new Map(
      fixture.ledger.dimensions.flatMap((dimension) =>
        dimension.obligations.map((row) => [row.id, row] as const),
      ),
    );
    const reply = {
      kind: "docsfab-technical-rich-judgment",
      schemaVersion: 1,
      ...judgment,
      richAssessments: provisional.evidence.candidates.map((candidate) => ({
        issueId: candidate.issueId,
        candidateSha256: candidate.candidateSha256,
        grounds: candidate.obligationIds.map((obligationId) => {
          const obligation = obligations.get(obligationId)!;
          return {
            obligationId,
            status: "supported",
            rationale: "The complete source span supports this action.",
            sourceLocators: obligation.sourceLocators,
            uncertainty: obligation.uncertainty,
          };
        }),
      })),
    };
    const decode = (value: unknown) =>
      decodeTechnicalCorrectionResponseV4(
        JSON.stringify(value),
        fixture.ledger,
        fixture.correction.originalSourceAuthorityAdmission!,
        fixture.correction.runId!,
        fixture.targets,
        provisional.evidence,
      );
    const admitted = await decode(reply);
    const firstRich = admitted.evidence.richIssues.find((issue) => issue.issueId === first.id);
    const secondRich = admitted.evidence.richIssues.find((issue) => issue.issueId === second.id);
    expect(firstRich?.status).toBe("admitted");
    expect(secondRich?.status).toBe("admitted");
    if (firstRich?.status !== "admitted" || secondRich?.status !== "admitted")
      throw new Error("Both shared-fact rich issues must be admitted.");
    expect(firstRich.proposedEdit.text).toBe(candidates[0]?.proposedEdit.text);
    expect(secondRich.proposedEdit.text).toBe(candidates[1]?.proposedEdit.text);
    expect(firstRich.proposedEdit.text).not.toBe(secondRich.proposedEdit.text);
    expect(
      secondRich.grounding.some((ground) =>
        firstRich.grounding.some((firstGround) => firstGround.factId === ground.factId),
      ),
    ).toBe(true);
    const contradicted = structuredClone(reply);
    contradicted.richAssessments[1]!.grounds[0]!.status = "contradicted";
    const separated = await decode(contradicted);
    expect(separated.evidence.richIssues.find((issue) => issue.issueId === first.id)?.status).toBe(
      "admitted",
    );
    expect(separated.evidence.richIssues.find((issue) => issue.issueId === second.id)).toEqual({
      issueId: second.id,
      status: "unavailable",
      reason: "contradicted",
    });
    const incompleteLocators = structuredClone(reply);
    const multiLocatorGround = incompleteLocators.richAssessments[1]!.grounds.find(
      (ground) => ground.sourceLocators.length > 1,
    );
    expect(multiLocatorGround).toBeDefined();
    multiLocatorGround!.sourceLocators = multiLocatorGround!.sourceLocators.slice(0, -1);
    await expect(decode(incompleteLocators)).rejects.toThrow();
  });
});

function fact(
  id: string,
  dimension: (typeof TECHNICAL_FACT_DIMENSIONS)[number],
  documentationDisposition: TechnicalSourceFact["documentationDisposition"],
  issueIds: string[],
  sourceLocators = ["src/api.ts:10"],
): TechnicalSourceFact {
  return {
    id,
    dimension,
    sourceLocators,
    statement: `Statement copied exactly for ${id}.`,
    documentationDisposition,
    uncertainty: `Qualification copied exactly for ${id}.`,
    issueIds,
  };
}

function inventory(facts: readonly TechnicalSourceFact[] = []): TechnicalFactInventory {
  return {
    completeness: "bounded-not-proven",
    dimensions: TECHNICAL_FACT_DIMENSIONS.map((dimension) => {
      const dimensionFacts = facts.filter((candidate) => candidate.dimension === dimension);
      return dimensionFacts.length > 0
        ? {
            dimension,
            status: "applicable" as const,
            reason: `The fixture source establishes ${dimension} behavior.`,
            sourceLocators: [],
            facts: dimensionFacts,
          }
        : {
            dimension,
            status: "not-applicable" as const,
            reason: `The fixture source establishes no ${dimension} behavior in scope.`,
            sourceLocators: ["src/api.ts:1"],
            facts: [],
          };
    }),
    limitations: [],
  };
}

function proposal(
  input: {
    verdict?: TechnicalCorrectionProposalV3["verdict"];
    facts?: readonly TechnicalSourceFact[];
    judgments?: readonly TechnicalCorrectionIssueJudgmentV3[];
    targets?: readonly string[];
    limitations?: readonly string[];
  } = {},
): TechnicalCorrectionProposalV3 {
  const targets = input.targets ?? TARGETS;
  const factInventory = inventory(input.facts);
  if (input.limitations) factInventory.limitations = [...input.limitations];
  return {
    kind: TECHNICAL_CORRECTION_PROPOSAL_KIND,
    schemaVersion: 3,
    verdict: input.verdict ?? (input.judgments?.length ? "needs-revision" : "pass"),
    coverage: targets.map((path) => ({
      path,
      status: "verified",
      evidence: ["src/api.ts:10"],
      reason: `Checked ${path} against the bounded fixture source.`,
    })),
    factInventory,
    issueJudgments: [...(input.judgments ?? [])],
    obligationAccounting: [],
  };
}

function ledgerProposal(): SourceObligationLedgerProposalV1 {
  return {
    completeness: "bounded-not-proven",
    dimensions: TECHNICAL_FACT_DIMENSIONS.map((dimension) => ({
      dimension,
      status: "not-applicable",
      reason: `The bounded fixture establishes no ${dimension} source obligation.`,
      sourceLocators: ["src/api.ts:1"],
      obligations: [],
    })),
    limitations: [],
  };
}

async function context(
  sourcePaths: readonly string[] = ["src/api.ts"],
  sourceProposal: SourceObligationLedgerProposalV1 = ledgerProposal(),
): Promise<{
  input: HarnessStepInput;
  ledger: ReturnType<typeof bindSourceObligationLedgerV2>;
  admission: ReturnType<typeof issueOriginalSourceAuthorityAdmission>;
  authorityEvidence: OriginalSourceAuthorityEvidenceV1;
}> {
  const workflow = getWorkflow("create-documentation");
  const planBinding = createDocumentationPlanBinding({
    mode: "create",
    pages: TARGETS.map((path) => ({ path, disposition: "create" as const })),
    sourceBindings: TARGETS.map((pagePath) => ({ pagePath, sources: [...sourcePaths] })),
  });
  const input = {
    runId: RUN_ID,
    repositoryPath: "/workspace",
    workflow,
    step: workflow.steps.find((candidate) => candidate.id === "derive-source-obligations")!,
    planBinding,
    evidenceIdentity: { repositoryRevision: REVISION },
    searchEvidence: searchStepEvidence({
      evidenceSha256: SEARCH_SHA256,
      workspaceSnapshotSha256: SNAPSHOT_SHA256,
    }),
  } satisfies HarnessStepInput;
  const scopeSha256 = sourceObligationScopeSha256(input);
  const sealed = sealOriginalSourceAuthority({
    runId: RUN_ID,
    scope: "create-plan-sources",
    repositoryRevision: REVISION,
    scopeSha256,
    workspaceSnapshotSha256: SNAPSHOT_SHA256,
    members: [...new Set(sourcePaths)].sort().map((path) => ({
      path,
      mode: 0o644,
      byteLength: 1,
      sourceSha256: SOURCE_SHA256,
    })),
  });
  const observer = {
    observe: async (paths: readonly string[]) =>
      [...new Set(paths)].sort().map((path) => ({ path, sha256: SOURCE_SHA256 })),
  };
  return {
    input,
    ledger: bindSourceObligationLedgerV2(
      sourceProposal,
      input,
      [{ path: "src/api.ts", sha256: SOURCE_SHA256 }],
      sealed.evidence,
    ),
    admission: issueOriginalSourceAuthorityAdmission({
      capture: sealed.capture,
      observer,
      runId: RUN_ID,
      repositoryRevision: REVISION,
      scopeSha256,
      workspaceSnapshotSha256: SNAPSHOT_SHA256,
    }),
    authorityEvidence: sealed.evidence,
  };
}

async function reviewContext(
  sourcePaths: readonly string[],
  targetPaths: readonly string[],
): Promise<Awaited<ReturnType<typeof context>>> {
  const workflow = getWorkflow("review-documentation");
  const input = {
    runId: RUN_ID,
    repositoryPath: "/workspace",
    workflow,
    step: workflow.steps.find((candidate) => candidate.id === "derive-source-obligations")!,
    contextTarget: { sourcePath: targetPaths[0]! },
    evidenceIdentity: { repositoryRevision: REVISION },
    searchEvidence: searchStepEvidence({
      evidenceSha256: SEARCH_SHA256,
      workspaceSnapshotSha256: SNAPSHOT_SHA256,
    }),
  } satisfies HarnessStepInput;
  const scopeSha256 = sourceObligationScopeSha256(input);
  const sealed = sealOriginalSourceAuthority({
    runId: RUN_ID,
    scope: "review-tracked-workspace",
    repositoryRevision: REVISION,
    scopeSha256,
    workspaceSnapshotSha256: SNAPSHOT_SHA256,
    members: [...new Set(sourcePaths)].sort().map((path) => ({
      path,
      mode: 0o644,
      byteLength: 1,
      sourceSha256: SOURCE_SHA256,
    })),
  });
  const observer = {
    observe: async (paths: readonly string[]) =>
      [...new Set(paths)].sort().map((path) => ({ path, sha256: SOURCE_SHA256 })),
  };
  return {
    input,
    ledger: bindSourceObligationLedgerV2(
      ledgerProposal(),
      input,
      [{ path: "src/api.ts", sha256: SOURCE_SHA256 }],
      sealed.evidence,
    ),
    admission: issueOriginalSourceAuthorityAdmission({
      capture: sealed.capture,
      observer,
      runId: RUN_ID,
      repositoryRevision: REVISION,
      scopeSha256,
      workspaceSnapshotSha256: SNAPSHOT_SHA256,
    }),
    authorityEvidence: sealed.evidence,
  };
}

function rehashEvidence(value: TechnicalCorrectionEvidenceV3): void {
  const mutable = value as unknown as Record<string, unknown>;
  const { digest: _digest, ...content } = mutable;
  mutable.digest = canonicalDigest(content);
}

describe("canonical technical correction V3", () => {
  it("derives every factual sentence, qualification, action, and source locator in stable order", async () => {
    const shared = fact(
      "FACT_INPUT",
      "input-representations",
      "omitted",
      ["TECH-002", "TECH-001"],
      ["src/api.ts:30", "src/api.ts:10"],
    );
    const conflicting = fact(
      "FACT_DEFAULT",
      "defaults-and-overrides",
      "conflicting",
      ["TECH-002"],
      ["src/api.ts:20"],
    );
    const policy = fact(
      "FACT_POLICY",
      "mutable-state",
      "unverified-policy",
      ["TECH-002"],
      ["src/api.ts:40"],
    );
    const defect = fact(
      "FACT_DEFECT",
      "destination-and-trust",
      "product-defect",
      ["TECH-003"],
      ["src/api.ts:50"],
    );
    const documented = fact(
      "FACT_DOCUMENTED",
      "error-status-retry",
      "documented",
      [],
      ["src/api.ts:60"],
    );
    const judgments: TechnicalCorrectionIssueJudgmentV3[] = [
      {
        id: "TECH-003",
        severity: "critical",
        category: "task_success",
        location: "docs/guide.md:30",
        factIds: [defect.id],
      },
      {
        id: "TECH-002",
        severity: "major",
        category: "technical_accuracy",
        location: "docs/guide.md:20",
        factIds: [policy.id, conflicting.id, shared.id],
      },
      {
        id: "TECH-001",
        severity: "minor",
        category: "completeness",
        location: "docs/alpha.md:10",
        factIds: [shared.id],
      },
    ];
    const raw = proposal({
      facts: [documented, defect, policy, conflicting, shared],
      judgments,
      targets: [...TARGETS].reverse(),
      limitations: ["Z fixture limitation.", "A fixture limitation."],
    });
    const fixture = await context();
    const bound = await bindHostOwnedTechnicalCorrectionProposalV3(
      raw,
      fixture.ledger,
      fixture.admission,
      RUN_ID,
      TARGETS,
    );

    expect(bound.evidence.proposal).toEqual(raw);
    expect(bound.evidence.proposal.issueJudgments.map(({ id }) => id)).toEqual([
      "TECH-003",
      "TECH-002",
      "TECH-001",
    ]);
    expect(bound.verificationResult.review.issues.map((issue) => issue.id)).toEqual([
      "TECH-001",
      "TECH-002",
      "TECH-003",
    ]);
    expect(bound.verificationResult.review.issues).toEqual([
      {
        id: "TECH-001",
        severity: "minor",
        category: "completeness",
        location: "docs/alpha.md:10",
        finding:
          "Fact FACT_INPUT (omitted): Statement copied exactly for FACT_INPUT.\nQualification: Qualification copied exactly for FACT_INPUT.",
        evidence: {
          source_id: REVISION,
          locator: "src/api.ts:10; src/api.ts:30",
        },
        required_change:
          "Document this source-supported behavior and preserve its qualifications.\nFact FACT_INPUT (omitted): Statement copied exactly for FACT_INPUT.\nQualification: Qualification copied exactly for FACT_INPUT.",
      },
      {
        id: "TECH-002",
        severity: "major",
        category: "technical_accuracy",
        location: "docs/guide.md:20",
        finding: [
          "Fact FACT_INPUT (omitted): Statement copied exactly for FACT_INPUT.\nQualification: Qualification copied exactly for FACT_INPUT.",
          "Fact FACT_DEFAULT (conflicting): Statement copied exactly for FACT_DEFAULT.\nQualification: Qualification copied exactly for FACT_DEFAULT.",
          "Fact FACT_POLICY (unverified-policy): Statement copied exactly for FACT_POLICY.\nQualification: Qualification copied exactly for FACT_POLICY.",
        ].join("\n\n"),
        evidence: {
          source_id: REVISION,
          locator: "src/api.ts:10; src/api.ts:20; src/api.ts:30; src/api.ts:40",
        },
        required_change: [
          "Document this source-supported behavior and preserve its qualifications.\nFact FACT_INPUT (omitted): Statement copied exactly for FACT_INPUT.\nQualification: Qualification copied exactly for FACT_INPUT.",
          "Correct the documentation to this source-supported behavior and preserve its qualifications.\nFact FACT_DEFAULT (conflicting): Statement copied exactly for FACT_DEFAULT.\nQualification: Qualification copied exactly for FACT_DEFAULT.",
          "Obtain approved governing authority for this assertion before presenting it as established policy; preserve the stated uncertainty.\nFact FACT_POLICY (unverified-policy): Statement copied exactly for FACT_POLICY.\nQualification: Qualification copied exactly for FACT_POLICY.",
        ].join("\n\n"),
      },
      {
        id: "TECH-003",
        severity: "critical",
        category: "task_success",
        location: "docs/guide.md:30",
        finding:
          "Fact FACT_DEFECT (product-defect): Statement copied exactly for FACT_DEFECT.\nQualification: Qualification copied exactly for FACT_DEFECT.",
        evidence: { source_id: REVISION, locator: "src/api.ts:50" },
        required_change:
          "Document this source-observed product defect and its qualification as a limitation; request a product-owner decision; do not present a product fix as completed.\nFact FACT_DEFECT (product-defect): Statement copied exactly for FACT_DEFECT.\nQualification: Qualification copied exactly for FACT_DEFECT.",
      },
    ]);
    expect(bound.verificationResult.coverage.map(({ path }) => path)).toEqual(TARGETS);
    expect(bound.verificationResult.factInventory.limitations).toEqual([
      "A fixture limitation.",
      "Z fixture limitation.",
    ]);
    expect(bound.evidence.sourceChecks.map(({ path }) => path)).toEqual(["src/api.ts"]);
    expect(
      validateTechnicalCorrectionEvidence(
        bound.evidence,
        fixture.ledger,
        bound.verificationResult,
        fixture.authorityEvidence,
      ),
    ).toEqual(bound.evidence);
  });

  it("produces identical canonical results for permutations while retaining each raw proposal", async () => {
    const one = fact("FACT_A", "input-representations", "omitted", ["TECH-001"]);
    const two = fact("FACT_B", "defaults-and-overrides", "conflicting", ["TECH-001"]);
    const judgment: TechnicalCorrectionIssueJudgmentV3 = {
      id: "TECH-001",
      severity: "major",
      category: "technical_accuracy",
      location: "docs/guide.md:10",
      factIds: [two.id, one.id],
    };
    const first = proposal({
      facts: [two, one],
      judgments: [judgment],
      targets: [...TARGETS].reverse(),
      limitations: ["Z limitation.", "A limitation."],
    });
    const second = structuredClone(first);
    second.coverage.reverse();
    second.factInventory.dimensions.reverse();
    for (const dimension of second.factInventory.dimensions) {
      dimension.facts.reverse();
      for (const item of dimension.facts) {
        item.issueIds.reverse();
        item.sourceLocators.reverse();
      }
    }
    second.factInventory.limitations.reverse();
    second.issueJudgments.reverse();
    second.issueJudgments[0]!.factIds.reverse();
    const fixture = await context();
    const a = await bindHostOwnedTechnicalCorrectionProposalV3(
      first,
      fixture.ledger,
      fixture.admission,
      RUN_ID,
      TARGETS,
    );
    const b = await bindHostOwnedTechnicalCorrectionProposalV3(
      second,
      fixture.ledger,
      fixture.admission,
      RUN_ID,
      TARGETS,
    );

    expect(b.verificationResult).toEqual(a.verificationResult);
    expect(a.evidence.proposal).toEqual(first);
    expect(b.evidence.proposal).toEqual(second);
    expect(b.evidence.proposalSha256).not.toBe(a.evidence.proposalSha256);
  });

  it("sorts Unicode semantic sets by scalar code point rather than UTF-16 code unit", async () => {
    const bmp = "\uE000";
    const astral = "\u{10000}";
    const raw = proposal({ limitations: [astral, bmp] });
    raw.coverage = raw.coverage.map((entry) => ({
      ...entry,
      evidence: [astral, bmp],
    }));
    const fixture = await context();
    const bound = await bindHostOwnedTechnicalCorrectionProposalV3(
      raw,
      fixture.ledger,
      fixture.admission,
      RUN_ID,
      TARGETS,
    );

    expect(bound.verificationResult.factInventory.limitations).toEqual([bmp, astral]);
    expect(bound.verificationResult.coverage[0]!.evidence).toEqual([bmp, astral]);
  });

  it("retains V3 accounting row and nested-array order while historical V2 stays normalized", async () => {
    const sourceProposal = ledgerProposal();
    sourceProposal.dimensions[0] = {
      dimension: "input-representations",
      status: "applicable",
      reason: "The fixture contains one input obligation that is refined.",
      sourceLocators: [],
      obligations: [
        {
          id: "OBL-REFINE",
          dimension: "input-representations",
          sourceLocators: ["src/api.ts:1"],
          statement: "The original input statement is intentionally replaced.",
          evidenceClass: "source-observation",
          uncertainty: "The replacement remains bounded to the fixture source.",
        },
      ],
    };
    sourceProposal.dimensions[1] = {
      dimension: "defaults-and-overrides",
      status: "applicable",
      reason: "The fixture contains one default obligation that is rejected.",
      sourceLocators: [],
      obligations: [
        {
          id: "OBL-REJECT",
          dimension: "defaults-and-overrides",
          sourceLocators: ["src/extra.ts:1"],
          statement: "The original default statement is intentionally rejected.",
          evidenceClass: "source-inference",
          uncertainty: "The rejection remains bounded to the fixture source.",
        },
      ],
    };
    const replacementZ = fact(
      "FACT_Z",
      "input-representations",
      "documented",
      [],
      ["src/extra.ts:20", "src/api.ts:20"],
    );
    const replacementA = fact(
      "FACT_A",
      "input-representations",
      "documented",
      [],
      ["src/api.ts:10"],
    );
    const raw = proposal({ facts: [replacementZ, replacementA] });
    raw.obligationAccounting = [
      {
        obligationId: "OBL-REJECT",
        disposition: "rejected",
        factIds: [],
        reason: "Fresh source evidence disproves the provisional default statement.",
        sourceLocators: ["src/extra.ts:30", "src/api.ts:30"],
      },
      {
        obligationId: "OBL-REFINE",
        disposition: "refined",
        factIds: [replacementZ.id, replacementA.id],
        reason: "Fresh source evidence splits the provisional input statement.",
        sourceLocators: ["src/extra.ts:40", "src/api.ts:40"],
      },
    ];
    const fixture = await context(["src/api.ts", "src/extra.ts"], sourceProposal);
    const rejectId = fixture.ledger.dimensions.find(
      (dimension) => dimension.dimension === "defaults-and-overrides",
    )!.obligations[0]!.id;
    const refineId = fixture.ledger.dimensions.find(
      (dimension) => dimension.dimension === "input-representations",
    )!.obligations[0]!.id;
    raw.obligationAccounting[0]!.obligationId = rejectId;
    raw.obligationAccounting[1]!.obligationId = refineId;
    const v3 = await bindHostOwnedTechnicalCorrectionProposalV3(
      raw,
      fixture.ledger,
      fixture.admission,
      RUN_ID,
      TARGETS,
    );
    expect(v3.evidence.proposal.obligationAccounting).toEqual(raw.obligationAccounting);
    expect(v3.evidence.proposal.obligationAccounting[1]).toMatchObject({
      factIds: ["FACT_Z", "FACT_A"],
      sourceLocators: ["src/extra.ts:40", "src/api.ts:40"],
    });
    expect(v3.verificationResult.factInventory.dimensions[0]!.facts.map(({ id }) => id)).toEqual([
      "FACT_A",
      "FACT_Z",
    ]);

    const historicalResult: VerificationResult = {
      review: { verdict: "pass", issues: [] },
      coverage: raw.coverage,
      factInventory: raw.factInventory,
    };
    const v2 = await bindTechnicalCorrectionResponseV2(
      { verificationResult: historicalResult, obligationAccounting: raw.obligationAccounting },
      fixture.ledger,
      fixture.admission,
      RUN_ID,
      (value) => validateVerificationResult(value, TARGETS),
    );
    expect(v2.obligationAccounting.map(({ obligationId }) => obligationId)).toEqual([
      rejectId,
      refineId,
    ]);
    expect(v2.obligationAccounting[1]).toMatchObject({
      factIds: ["FACT_A", "FACT_Z"],
      sourceLocators: ["src/api.ts:40", "src/extra.ts:40"],
    });
  });

  it("rejects cardinality and canonical-byte overflow at each named V3 boundary", async () => {
    const fixture = await context();
    const one = fact("FACT_ONE", "input-representations", "omitted", ["TECH-000"]);
    const tooManyJudgments = proposal({
      facts: [one],
      judgments: Array.from({ length: 257 }, (_, index) => ({
        id: `TECH-${index.toString().padStart(3, "0")}`,
        severity: "major" as const,
        category: "technical_accuracy" as const,
        location: "docs/guide.md:10",
        factIds: [one.id],
      })),
    });
    await expect(
      bindHostOwnedTechnicalCorrectionProposalV3(
        tooManyJudgments,
        fixture.ledger,
        fixture.admission,
        RUN_ID,
        TARGETS,
      ),
    ).rejects.toThrow("Technical correction response rejected: bounds-exceeded.");

    const thirtyThree = Array.from({ length: 33 }, (_, index) =>
      fact(`FACT_${index.toString().padStart(3, "0")}`, "input-representations", "omitted", [
        "TECH-001",
      ]),
    );
    await expect(
      bindHostOwnedTechnicalCorrectionProposalV3(
        proposal({
          facts: thirtyThree,
          judgments: [
            {
              id: "TECH-001",
              severity: "major",
              category: "technical_accuracy",
              location: "docs/guide.md:10",
              factIds: thirtyThree.map(({ id }) => id),
            },
          ],
        }),
        fixture.ledger,
        fixture.admission,
        RUN_ID,
        TARGETS,
      ),
    ).rejects.toThrow(
      "technical-correction-max-judgment-fact-ids-bound: 33 exceeds technicalCorrection.maxJudgmentFactIds = 32 count.",
    );

    const oversizedFacts = Array.from({ length: 80 }, (_, index) => ({
      ...fact(
        `FACT_${index.toString().padStart(3, "0")}`,
        "input-representations",
        "documented",
        [],
      ),
      statement: `${index.toString().padStart(3, "0")}:${"x".repeat(4_092)}`,
    }));
    await expect(
      bindHostOwnedTechnicalCorrectionProposalV3(
        proposal({ facts: oversizedFacts }),
        fixture.ledger,
        fixture.admission,
        RUN_ID,
        TARGETS,
      ),
    ).rejects.toThrow("Technical correction response rejected: bounds-exceeded.");

    const issueIds = Array.from(
      { length: 96 },
      (_, index) => `TECH-${index.toString().padStart(3, "0")}`,
    );
    const expandedFacts = Array.from({ length: 96 }, (_, factIndex) => {
      const linkedIssues = Array.from(
        { length: 32 },
        (_, offset) => issueIds[(factIndex - offset + issueIds.length) % issueIds.length]!,
      );
      return {
        ...fact(
          `FACT_${factIndex.toString().padStart(3, "0")}`,
          "input-representations",
          "omitted",
          linkedIssues,
        ),
        statement: `Expanded canonical fact ${factIndex}: ${"s".repeat(120)}`,
        uncertainty: `Expanded qualification ${factIndex}: ${"u".repeat(60)}`,
      };
    });
    const expandedJudgments = issueIds.map((id, issueIndex) => ({
      id,
      severity: "major" as const,
      category: "technical_accuracy" as const,
      location: "docs/guide.md:10",
      factIds: Array.from(
        { length: 32 },
        (_, offset) => expandedFacts[(issueIndex + offset) % expandedFacts.length]!.id,
      ),
    }));
    await expect(
      bindHostOwnedTechnicalCorrectionProposalV3(
        proposal({ facts: expandedFacts, judgments: expandedJudgments }),
        fixture.ledger,
        fixture.admission,
        RUN_ID,
        TARGETS,
      ),
    ).rejects.toThrow("Technical correction response rejected: bounds-exceeded.");
  });

  it("rejects retained-evidence byte overflow without truncating source checks", async () => {
    const sourcePaths = [
      "src/api.ts",
      ...Array.from({ length: 5_000 }, (_, index) => `s/${index.toString().padStart(4, "0")}.ts`),
    ];
    const facts = Array.from({ length: 79 }, (_, factIndex) => {
      const paths = sourcePaths.slice(1 + factIndex * 64, 1 + (factIndex + 1) * 64);
      return fact(
        `FACT_${factIndex.toString().padStart(3, "0")}`,
        "input-representations",
        "documented",
        [],
        paths.map((path) => `${path}:1`),
      );
    });
    const fixture = await reviewContext(sourcePaths, ["docs/guide.md"]);
    await expect(
      bindHostOwnedTechnicalCorrectionProposalV3(
        proposal({ facts, targets: ["docs/guide.md"] }),
        fixture.ledger,
        fixture.admission,
        RUN_ID,
        ["docs/guide.md"],
      ),
    ).rejects.toThrow("Technical correction response rejected: bounds-exceeded.");
  });

  it("rejects orphaned, inconsistent, duplicate, documented, mixed, and out-of-target judgments", async () => {
    const fixture = await context();
    const actionable = fact("FACT_ACTION", "input-representations", "omitted", ["TECH-001"]);
    const documented = fact("FACT_DOCUMENTED", "defaults-and-overrides", "documented", []);
    const baseJudgment: TechnicalCorrectionIssueJudgmentV3 = {
      id: "TECH-001",
      severity: "major",
      category: "technical_accuracy",
      location: "docs/guide.md:10",
      factIds: [actionable.id],
    };
    const invalid = [
      proposal({
        facts: [actionable],
        judgments: [{ ...baseJudgment, factIds: ["FACT_MISSING"] }],
      }),
      proposal({ facts: [{ ...actionable, issueIds: [] }], judgments: [baseJudgment] }),
      proposal({
        facts: [{ ...actionable, issueIds: ["TECH-001", "TECH-002"] }],
        judgments: [baseJudgment],
      }),
      proposal({
        facts: [actionable],
        judgments: [baseJudgment, { ...baseJudgment }],
      }),
      proposal({
        facts: [documented],
        judgments: [{ ...baseJudgment, factIds: [documented.id] }],
      }),
      proposal({
        facts: [actionable, documented],
        judgments: [{ ...baseJudgment, factIds: [actionable.id, documented.id] }],
      }),
      proposal({ facts: [actionable], judgments: [{ ...baseJudgment, factIds: [] }] }),
      proposal({
        facts: [actionable],
        judgments: [{ ...baseJudgment, factIds: [actionable.id, actionable.id] }],
      }),
      proposal({
        facts: [actionable],
        judgments: [{ ...baseJudgment, location: "docs/outside.md:10" }],
      }),
    ];
    for (const candidate of invalid) {
      await expect(
        bindHostOwnedTechnicalCorrectionProposalV3(
          candidate,
          fixture.ledger,
          fixture.admission,
          RUN_ID,
          TARGETS,
        ),
      ).rejects.toThrow();
    }

    const ordinary = validateVerificationResult({
      review: {
        verdict: "needs-revision",
        issues: [
          {
            id: "TECH-001",
            severity: "major",
            category: "technical_accuracy",
            location: "docs/outside.md:10",
            finding: "Ordinary review location remains governed by its existing syntax rule.",
            evidence: { source_id: REVISION, locator: "src/api.ts:10" },
            required_change: "Correct the ordinary review finding.",
          },
        ],
      },
      coverage: proposal().coverage,
      factInventory: inventory([
        fact("FACT_ORDINARY", "input-representations", "omitted", ["TECH-001"]),
      ]),
    });
    expect(ordinary.review.issues[0]!.location).toBe("docs/outside.md:10");
  });

  it("omits unlinked empty-factId judgments and still rejects empty factIds with inverse facts", async () => {
    const fixture = await context();
    const actionable = fact("FACT_ACTION", "input-representations", "omitted", ["TECH-001"]);
    const linked: TechnicalCorrectionIssueJudgmentV3 = {
      id: "TECH-001",
      severity: "major",
      category: "technical_accuracy",
      location: "docs/guide.md:10",
      factIds: [actionable.id],
    };
    const unlinkedEmpty: TechnicalCorrectionIssueJudgmentV3 = {
      id: "TECH-009",
      severity: "minor",
      category: "completeness",
      location: "docs/guide.md:3",
      factIds: [],
    };
    const bound = await bindHostOwnedTechnicalCorrectionProposalV3(
      proposal({ facts: [actionable], judgments: [linked, unlinkedEmpty] }),
      fixture.ledger,
      fixture.admission,
      RUN_ID,
      TARGETS,
    );
    expect(
      bound.evidence.proposal.issueJudgments.map(({ id, factIds }) => ({ id, factIds })),
    ).toEqual([{ id: "TECH-001", factIds: [actionable.id] }]);
    expect(bound.verificationResult.review.issues.map((issue) => issue.id)).toEqual(["TECH-001"]);

    await expect(
      bindHostOwnedTechnicalCorrectionProposalV3(
        proposal({ facts: [actionable], judgments: [{ ...linked, factIds: [] }] }),
        fixture.ledger,
        fixture.admission,
        RUN_ID,
        TARGETS,
      ),
    ).rejects.toThrow("Technical correction response rejected: invalid-fact-link.");
    await expect(
      bindHostOwnedTechnicalCorrectionProposalV3(
        proposal({ facts: [actionable], judgments: [{ ...linked, factIds: ["fact-1"] }] }),
        fixture.ledger,
        fixture.admission,
        RUN_ID,
        TARGETS,
      ),
    ).rejects.toThrow("Technical correction response rejected: invalid-fact-link.");
    await expect(
      bindHostOwnedTechnicalCorrectionProposalV3(
        proposal({ facts: [actionable], judgments: [{ ...linked, factIds: ["FACT_MISSING"] }] }),
        fixture.ledger,
        fixture.admission,
        RUN_ID,
        TARGETS,
      ),
    ).rejects.toThrow("Technical correction response rejected: invalid-fact-link.");
  });

  it("admits empty pass and missing-evidence human review without inventing issues", async () => {
    const fixture = await context();
    const passing = await bindHostOwnedTechnicalCorrectionProposalV3(
      proposal(),
      fixture.ledger,
      fixture.admission,
      RUN_ID,
      TARGETS,
    );
    expect(passing.verificationResult.review).toEqual({ verdict: "pass", issues: [] });

    const human = proposal({ verdict: "human-review" });
    const reason = "The fixture source needed for this dimension was unavailable.";
    human.coverage = human.coverage.map((entry) => ({
      ...entry,
      status: "unverified",
      evidence: [],
      reason,
    }));
    human.factInventory.dimensions[0] = {
      dimension: TECHNICAL_FACT_DIMENSIONS[0],
      status: "unverified",
      reason,
      sourceLocators: [],
      facts: [],
    };
    human.factInventory.limitations = [reason];
    const admitted = await bindHostOwnedTechnicalCorrectionProposalV3(
      human,
      fixture.ledger,
      fixture.admission,
      RUN_ID,
      TARGETS,
    );
    expect(admitted.verificationResult.review).toEqual({ verdict: "human-review", issues: [] });
    expect(admitted.verificationResult.factInventory.limitations).toEqual([reason]);
  });

  it("rejects extra prose, free-prose fields, legacy envelopes, and unknown or mixed versions", async () => {
    const fixture = await context();
    const valid = proposal();
    await expect(
      decodeTechnicalCorrectionResponseV3(
        `${JSON.stringify(valid)}\nextra prose`,
        fixture.ledger,
        fixture.admission,
        RUN_ID,
        TARGETS,
      ),
    ).rejects.toThrow();
    for (const candidate of [
      { ...valid, finding: "A second factual copy." },
      { ...valid, schemaVersion: 2 },
      { ...valid, schemaVersion: 4 },
      { ...valid, verificationResult: { review: { verdict: "pass", issues: [] } } },
      { verificationResult: {}, obligationAccounting: [] },
    ]) {
      await expect(
        decodeTechnicalCorrectionResponseV3(
          JSON.stringify(candidate),
          fixture.ledger,
          fixture.admission,
          RUN_ID,
          TARGETS,
        ),
      ).rejects.toThrow();
    }
  });

  it("fails closed for proposal, canonical-result, source-check, and evidence tampering", async () => {
    const linked = fact("FACT_ACTION", "input-representations", "omitted", ["TECH-001"]);
    const raw = proposal({
      facts: [linked],
      judgments: [
        {
          id: "TECH-001",
          severity: "major",
          category: "technical_accuracy",
          location: "docs/guide.md:10",
          factIds: [linked.id],
        },
      ],
    });
    const fixture = await context();
    const bound = await bindHostOwnedTechnicalCorrectionProposalV3(
      raw,
      fixture.ledger,
      fixture.admission,
      RUN_ID,
      TARGETS,
    );
    const validate = (evidence: unknown, result: VerificationResult = bound.verificationResult) =>
      validateTechnicalCorrectionEvidence(
        evidence,
        fixture.ledger,
        result,
        fixture.authorityEvidence,
      );

    const proposalText = structuredClone(bound.evidence);
    proposalText.proposal.factInventory.dimensions[0]!.facts[0]!.statement = "Tampered statement.";
    proposalText.proposalSha256 = canonicalDigest(proposalText.proposal);
    rehashEvidence(proposalText);
    expect(() => validate(proposalText)).toThrow();

    const proposalDigest = structuredClone(bound.evidence);
    proposalDigest.proposalSha256 = "0".repeat(64);
    rehashEvidence(proposalDigest);
    expect(() => validate(proposalDigest)).toThrow();

    const canonicalDigestTamper = structuredClone(bound.evidence);
    canonicalDigestTamper.verificationResultSha256 = "0".repeat(64);
    rehashEvidence(canonicalDigestTamper);
    expect(() => validate(canonicalDigestTamper)).toThrow();

    const check = structuredClone(bound.evidence);
    check.sourceChecks[0]!.sourceSha256 = "0".repeat(64);
    rehashEvidence(check);
    expect(() => validate(check)).toThrow();

    const authority = structuredClone(bound.evidence);
    authority.originalSourceAuthoritySha256 = "0".repeat(64);
    rehashEvidence(authority);
    expect(() => validate(authority)).toThrow();

    const outerDigest = structuredClone(bound.evidence);
    outerDigest.digest = "0".repeat(64);
    expect(() => validate(outerDigest)).toThrow();

    const changedResult = structuredClone(bound.verificationResult);
    changedResult.review.issues[0]!.finding = "A noncanonical factual copy.";
    expect(() => validate(bound.evidence, changedResult)).toThrow();
  });

  it("preserves explicit historical V1 and V2 evidence validation", async () => {
    const fixture = await context();
    const current = proposal();
    const verificationResult: VerificationResult = {
      review: { verdict: current.verdict, issues: [] },
      coverage: current.coverage,
      factInventory: current.factInventory,
    };
    const v1Ledger = bindSourceObligationLedger(ledgerProposal(), fixture.input, [
      { path: "src/api.ts", sha256: SOURCE_SHA256 },
    ]);
    const v1 = bindTechnicalCorrectionResponse(
      { verificationResult, obligationAccounting: [] },
      v1Ledger,
      (value) => validateVerificationResult(value, TARGETS),
    );
    expect(validateTechnicalCorrectionEvidence(v1.evidence, v1Ledger, verificationResult)).toEqual(
      v1.evidence,
    );

    const v2 = await bindTechnicalCorrectionResponseV2(
      { verificationResult, obligationAccounting: [] },
      fixture.ledger,
      fixture.admission,
      RUN_ID,
      (value) => validateVerificationResult(value, TARGETS),
    );
    expect(
      validateTechnicalCorrectionEvidence(
        v2.evidence,
        fixture.ledger,
        verificationResult,
        fixture.authorityEvidence,
      ),
    ).toEqual(v2.evidence);
  });

  it("feeds downstream finding projection only the host-derived canonical result", async () => {
    const linked = fact("FACT_ACTION", "input-representations", "omitted", ["TECH-001"]);
    const fixture = await context();
    const bound = await bindHostOwnedTechnicalCorrectionProposalV3(
      proposal({
        facts: [linked],
        judgments: [
          {
            id: "TECH-001",
            severity: "major",
            category: "technical_accuracy",
            location: "docs/guide.md:10",
            factIds: [linked.id],
          },
        ],
      }),
      fixture.ledger,
      fixture.admission,
      RUN_ID,
      TARGETS,
    );
    const summary = canonicalizeJsonEvidence(
      bound.verificationResult as unknown as JsonEvidenceValue,
    ).trimEnd();
    const projected = projectReviewFindingsFromRun({
      steps: [
        {
          id: "verify-technical-accuracy",
          title: "Verify technical accuracy",
          skill: "verify-technical-accuracy",
          mode: "read-only",
          status: "succeeded",
          summary,
          technicalCorrectionEvidence: bound.evidence,
        } as RunRecord["steps"][number],
      ],
    });
    expect(projected.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "FACT_ACTION",
          summary: linked.statement,
          path: "docs/guide.md",
          line: 10,
          evidence: expect.stringContaining("source-locator=src/api.ts:10"),
          recommendation: expect.stringContaining(linked.statement),
        }),
      ]),
    );
    expect(JSON.stringify(projected)).not.toContain("independently generated factual copy");
  });
});
