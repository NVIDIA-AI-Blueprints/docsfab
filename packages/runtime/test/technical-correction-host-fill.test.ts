// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { limit } from "../src/config/limits.js";
import { InferenceStepError, type HarnessStepInput } from "../src/execution/contracts.js";
import { buildHostStepPrompt } from "../src/harness/pi.js";
import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../src/json-evidence.js";
import { getWorkflow, listCatalogWorkflows } from "../src/workflow-registry/catalog.js";
import { createDocumentationPlanBinding } from "../src/workflow-execution/plan-binding.js";
import {
  decodeVerificationResponse,
  TECHNICAL_FACT_DIMENSIONS,
  VERIFICATION_RESPONSE_CONTRACT,
} from "../src/workflow-execution/review-response.js";
import {
  bindProvisionalVerificationJudgmentContract,
  bindSourceObligationLedger,
  bindSourceObligationLedgerV2,
  decodeProvisionalVerificationJudgment,
  decodeTechnicalCorrectionResponseV3,
  hostFillTechnicalCorrectionProposalFromJudgmentV3,
  isProvisionalTechnicalVerification,
  PROVISIONAL_VERIFICATION_JUDGMENT_CONTRACT,
  sourceObligationScopeSha256,
  TECHNICAL_CORRECTION_RESPONSE_CONTRACT_V3,
  usesProvisionalVerificationJudgment,
  type SourceObligationLedgerProposalV1,
} from "../src/workflow-execution/source-obligation.js";
import {
  issueOriginalSourceAuthorityAdmission,
  sealOriginalSourceAuthority,
} from "../src/workflow-execution/source-obligation-authority.js";
import { searchStepEvidence } from "./helpers/search-evidence-fixture.js";

const REVISION = "a".repeat(40);
const SOURCE_SHA256 = "f".repeat(64);
const SEARCH_SHA256 = "b".repeat(64);
const SNAPSHOT_SHA256 = "c".repeat(64);
const RUN_ID = "host-fill-correction-run";
const TARGETS = ["docs/alpha.md", "docs/guide.md"] as const;
const MODEL_OBLIGATION_ID = "OBL-INPUT-1";
const STATEMENT = "The fixture source accepts a structured input representation.";
const UNCERTAINTY = "The source was inspected but the operation was not executed.";

function ledgerProposal(modelObligationId = MODEL_OBLIGATION_ID): SourceObligationLedgerProposalV1 {
  return {
    completeness: "bounded-not-proven",
    dimensions: TECHNICAL_FACT_DIMENSIONS.map((dimension) =>
      dimension === "input-representations"
        ? {
            dimension,
            status: "applicable" as const,
            reason: "The fixture source establishes structured input behavior.",
            sourceLocators: [],
            obligations: [
              {
                id: modelObligationId,
                dimension,
                sourceLocators: ["src/api.ts:10"],
                statement: STATEMENT,
                evidenceClass: "source-observation" as const,
                uncertainty: UNCERTAINTY,
              },
            ],
          }
        : {
            dimension,
            status: "not-applicable" as const,
            reason: `The bounded fixture establishes no ${dimension} source obligation.`,
            sourceLocators: ["src/api.ts:1"],
            obligations: [],
          },
    ),
    limitations: [],
  };
}

async function fixture(modelObligationId = MODEL_OBLIGATION_ID): Promise<{
  ledger: ReturnType<typeof bindSourceObligationLedgerV2>;
  admission: ReturnType<typeof issueOriginalSourceAuthorityAdmission>;
  obligationId: string;
}> {
  const workflow = getWorkflow("create-documentation");
  const planBinding = createDocumentationPlanBinding({
    mode: "create",
    pages: TARGETS.map((path) => ({ path, disposition: "create" as const })),
    sourceBindings: TARGETS.map((pagePath) => ({ pagePath, sources: ["src/api.ts"] })),
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
    members: [{ path: "src/api.ts", mode: 0o644, byteLength: 1, sourceSha256: SOURCE_SHA256 }],
  });
  const observer = {
    observe: async (paths: readonly string[]) =>
      [...new Set(paths)].sort().map((path) => ({ path, sha256: SOURCE_SHA256 })),
  };
  const ledger = bindSourceObligationLedgerV2(
    ledgerProposal(modelObligationId),
    input,
    [{ path: "src/api.ts", sha256: SOURCE_SHA256 }],
    sealed.evidence,
  );
  const obligationId = ledger.dimensions.find(
    (dimension) => dimension.dimension === "input-representations",
  )!.obligations[0]!.id;
  return {
    ledger,
    admission: issueOriginalSourceAuthorityAdmission({
      capture: sealed.capture,
      observer,
      runId: RUN_ID,
      repositoryRevision: REVISION,
      scopeSha256,
      workspaceSnapshotSha256: SNAPSHOT_SHA256,
    }),
    obligationId,
  };
}

function coverage() {
  return TARGETS.map((path) => ({
    path,
    status: "verified" as const,
    evidence: ["src/api.ts:10"],
    reason: `Checked ${path} against the bounded fixture source.`,
  }));
}

function omittedJudgment(obligationId: string) {
  return {
    verdict: "needs-revision" as const,
    coverage: coverage(),
    issueJudgments: [
      {
        id: "TECH-001",
        severity: "major" as const,
        category: "completeness" as const,
        location: "docs/guide.md:10",
        obligationIds: [obligationId],
      },
    ],
    obligationJudgments: [
      {
        obligationId: obligationId,
        disposition: "retained" as const,
        documentationDisposition: "omitted" as const,
      },
    ],
  };
}

describe("technical correction host-fill", () => {
  it("host-decodes completed verify JSON without minted ledger identity", async () => {
    const shared = await fixture();
    const bound = await decodeTechnicalCorrectionResponseV3(
      canonicalizeJsonEvidence(
        omittedJudgment(shared.obligationId) as unknown as JsonEvidenceValue,
      ),
      shared.ledger,
      shared.admission,
      RUN_ID,
      TARGETS,
    );
    expect(bound.proposal.kind).toBe("docsfab-technical-correction-proposal");
    expect(bound.proposal.schemaVersion).toBe(3);
    expect(bound.proposal.obligationAccounting).toEqual([
      { obligationId: shared.obligationId, disposition: "retained", factIds: ["FACT-1"] },
    ]);
    const fact = bound.proposal.factInventory.dimensions[0]!.facts[0]!;
    expect(fact).toMatchObject({
      id: "FACT-1",
      dimension: "input-representations",
      sourceLocators: ["src/api.ts:10"],
      statement: STATEMENT,
      documentationDisposition: "omitted",
      uncertainty: UNCERTAINTY,
      issueIds: ["TECH-001"],
    });
    expect(bound.proposal.issueJudgments[0]!.factIds).toEqual(["FACT-1"]);
    expect(bound.verificationResult.review.issues[0]!.finding).toContain("FACT-1");
  });

  it("ignores model-minted obligation IDs, accounting rows, and fact-inventory identity", async () => {
    const shared = await fixture();
    const minted = {
      ...omittedJudgment(shared.obligationId),
      kind: "minted-kind",
      schemaVersion: 99,
      obligationAccounting: [
        {
          obligationId: "OBL-FAKE",
          disposition: "retained",
          factIds: ["MINTED-FACT"],
        },
      ],
      factInventory: {
        completeness: "bounded-not-proven",
        dimensions: [],
        limitations: ["minted-limitation"],
      },
    };
    const proposal = hostFillTechnicalCorrectionProposalFromJudgmentV3(
      minted,
      shared.ledger,
      TARGETS,
    );
    expect(proposal.kind).toBe("docsfab-technical-correction-proposal");
    expect(proposal.schemaVersion).toBe(3);
    expect(proposal.obligationAccounting).toEqual([
      { obligationId: shared.obligationId, disposition: "retained", factIds: ["FACT-1"] },
    ]);
    expect(proposal.factInventory.dimensions[0]!.facts[0]!.id).toBe("FACT-1");
    expect(proposal.factInventory.limitations).toEqual([]);
    expect(JSON.stringify(proposal)).not.toContain("OBL-FAKE");
    expect(JSON.stringify(proposal)).not.toContain("MINTED-FACT");
  });

  it("rejects unknown IDs, skipped obligations, and retained statement mismatch", async () => {
    const shared = await fixture();
    const decode = (value: unknown) =>
      decodeTechnicalCorrectionResponseV3(
        canonicalizeJsonEvidence(value as JsonEvidenceValue),
        shared.ledger,
        shared.admission,
        RUN_ID,
        TARGETS,
      );

    await expect(
      decode({ ...omittedJudgment(shared.obligationId), obligationJudgments: [] }),
    ).rejects.toThrow("Technical correction response rejected: invalid-accounting.");
    await expect(
      decode({
        ...omittedJudgment(shared.obligationId),
        obligationJudgments: [
          {
            obligationId: "OBL-UNKNOWN",
            disposition: "retained",
            documentationDisposition: "omitted",
            issueIds: ["TECH-001"],
          },
        ],
      }),
    ).rejects.toThrow("Technical correction response rejected: invalid-accounting.");
    await expect(
      decode({
        ...omittedJudgment(shared.obligationId),
        obligationJudgments: [
          {
            obligationId: shared.obligationId,
            disposition: "retained",
            documentationDisposition: "omitted",
            issueIds: ["TECH-001"],
            statement: "A changed statement cannot retain the provisional obligation.",
          },
        ],
      }),
    ).rejects.toThrow("Technical correction response rejected: invalid-accounting.");
    await expect(
      decode({
        ...omittedJudgment(shared.obligationId),
        issueJudgments: [
          {
            ...omittedJudgment(shared.obligationId).issueJudgments[0],
            obligationIds: ["OBL-UNKNOWN"],
          },
        ],
      }),
    ).rejects.toThrow("Technical correction response rejected: invalid-fact-link.");
  });

  it("asks the model for judgment only and keeps independent source re-read", () => {
    expect(TECHNICAL_CORRECTION_RESPONSE_CONTRACT_V3).toContain("Return judgment only");
    expect(TECHNICAL_CORRECTION_RESPONSE_CONTRACT_V3).toContain("obligationJudgments");
    expect(TECHNICAL_CORRECTION_RESPONSE_CONTRACT_V3).toContain("Independently reread");
    expect(TECHNICAL_CORRECTION_RESPONSE_CONTRACT_V3).toContain("untrusted evidence");
    expect(PROVISIONAL_VERIFICATION_JUDGMENT_CONTRACT).toContain("Return judgment only");
    expect(PROVISIONAL_VERIFICATION_JUDGMENT_CONTRACT).toContain("obligationJudgments");
    expect(PROVISIONAL_VERIFICATION_JUDGMENT_CONTRACT).toContain(
      "Do not return review, factInventory, or obligationAccounting.",
    );
  });

  it("host-fills provisional verify from the same judgment schema", async () => {
    const shared = await fixture();
    const admitted = decodeProvisionalVerificationJudgment(
      canonicalizeJsonEvidence(
        omittedJudgment(shared.obligationId) as unknown as JsonEvidenceValue,
      ),
      shared.ledger,
      TARGETS,
    );
    expect(admitted.review.verdict).toBe("needs-revision");
    expect(admitted.factInventory.dimensions[0]!.facts[0]).toMatchObject({
      id: "FACT-1",
      sourceLocators: ["src/api.ts:10"],
      statement: STATEMENT,
      documentationDisposition: "omitted",
    });
    expect(admitted.review.issues[0]!.finding).toContain("FACT-1");
    expect(() =>
      decodeProvisionalVerificationJudgment(
        canonicalizeJsonEvidence({
          review: { verdict: "pass", issues: [] },
          coverage: [],
          factInventory: { completeness: "bounded-not-proven", dimensions: [], limitations: [] },
        } as unknown as JsonEvidenceValue),
        shared.ledger,
        TARGETS,
      ),
    ).toThrow("Technical correction response rejected: invalid-shape.");
  });

  it("rejects a sealed proposal that omits obligation judgments", async () => {
    const shared = await fixture();
    const sealed = {
      kind: "docsfab-technical-correction-proposal",
      schemaVersion: 3,
      verdict: "needs-revision",
      coverage: coverage(),
      factInventory: {
        completeness: "bounded-not-proven",
        dimensions: [],
        limitations: [],
      },
      issueJudgments: [],
      obligationAccounting: [],
    };
    expect(() =>
      hostFillTechnicalCorrectionProposalFromJudgmentV3(sealed, shared.ledger, TARGETS),
    ).toThrow("Technical correction response rejected: invalid-shape.");
  });

  it("rejects an applicable dimension that ends with zero admitted facts", async () => {
    const shared = await fixture();
    await expect(
      decodeTechnicalCorrectionResponseV3(
        canonicalizeJsonEvidence({
          verdict: "needs-revision",
          coverage: coverage(),
          issueJudgments: [],
          obligationJudgments: [
            {
              obligationId: shared.obligationId,
              disposition: "rejected",
              reason: "The source does not establish this claim.",
            },
          ],
        } as unknown as JsonEvidenceValue),
        shared.ledger,
        shared.admission,
        RUN_ID,
        TARGETS,
      ),
    ).rejects.toThrow("Technical correction response rejected: invalid-fact-inventory.");
  });

  it("holds judgment text at the catalog ceiling and refuses one more character", async () => {
    const shared = await fixture();
    const fieldMax = limit("technicalCorrection.fieldMaxChars").value;
    const proseMax = limit("technicalCorrection.proseMaxChars").value;
    const refined = (statement: string, uncertainty: string) => ({
      verdict: "needs-revision" as const,
      coverage: coverage(),
      issueJudgments: [
        {
          id: "TECH-001",
          severity: "major" as const,
          category: "completeness" as const,
          location: "docs/guide.md:10",
          obligationIds: [shared.obligationId],
        },
      ],
      obligationJudgments: [
        {
          obligationId: shared.obligationId,
          disposition: "refined" as const,
          reason: "The source states a narrower input contract.",
          replacements: [
            {
              statement,
              documentationDisposition: "conflicting" as const,
              uncertainty,
              issueIds: ["TECH-001"],
            },
          ],
        },
      ],
    });
    const held = hostFillTechnicalCorrectionProposalFromJudgmentV3(
      refined("s".repeat(fieldMax), "u".repeat(proseMax)),
      shared.ledger,
      TARGETS,
    );
    expect(held.factInventory.dimensions[0]!.facts[0]!.statement).toHaveLength(fieldMax);
    expect(held.factInventory.dimensions[0]!.facts[0]!.uncertainty).toHaveLength(proseMax);
    expect(() =>
      hostFillTechnicalCorrectionProposalFromJudgmentV3(
        refined("s".repeat(fieldMax + 1), UNCERTAINTY),
        shared.ledger,
        TARGETS,
      ),
    ).toThrow(
      "technical-correction-field-max-chars-bound: 4097 exceeds technicalCorrection.fieldMaxChars = 4096 characters.",
    );
    expect(() =>
      hostFillTechnicalCorrectionProposalFromJudgmentV3(
        refined("s".repeat(8), "u".repeat(proseMax + 1)),
        shared.ledger,
        TARGETS,
      ),
    ).toThrow(
      "technical-correction-prose-max-chars-bound: 2049 exceeds technicalCorrection.proseMaxChars = 2048 characters.",
    );
  });

  it("holds judgment identifier lists at the catalog count and refuses one more", async () => {
    const shared = await fixture();
    const maxIds = limit("technicalCorrection.maxJudgmentFactIds").value;
    const maxJudgments = limit("technicalCorrection.maxIssueJudgments").value;
    const ids = (count: number) =>
      Array.from({ length: count }, (_, index) => `TECH-${String(index + 1).padStart(3, "0")}`);
    const judgments = (count: number) =>
      ids(count).map((id) => ({
        id,
        severity: "major" as const,
        category: "completeness" as const,
        location: "docs/guide.md:10",
        obligationIds: [shared.obligationId],
      }));
    // The fact's issueIds are derived from the judgments that link its
    // obligation, and the derived list keeps the bound the reply's list had.
    const withIds = (count: number) => ({
      ...omittedJudgment(shared.obligationId),
      issueJudgments: judgments(count),
    });
    const held = hostFillTechnicalCorrectionProposalFromJudgmentV3(
      withIds(maxIds),
      shared.ledger,
      TARGETS,
    );
    expect(held.factInventory.dimensions[0]!.facts[0]!.issueIds).toHaveLength(maxIds);
    expect(() =>
      hostFillTechnicalCorrectionProposalFromJudgmentV3(
        withIds(maxIds + 1),
        shared.ledger,
        TARGETS,
      ),
    ).toThrow(
      "technical-correction-max-judgment-fact-ids-bound: 33 exceeds technicalCorrection.maxJudgmentFactIds = 32 count.",
    );

    const atJudgmentLimit = {
      ...omittedJudgment(shared.obligationId),
      issueJudgments: [
        omittedJudgment(shared.obligationId).issueJudgments[0]!,
        ...Array.from({ length: maxJudgments - 1 }, (_, index) => ({
          id: `TECH-${String(index + 2).padStart(3, "0")}`,
          severity: "major" as const,
          category: "completeness" as const,
          location: "docs/guide.md:10",
          obligationIds: [] as string[],
        })),
      ],
    };
    // At the count limit the reply passes the count bound and reaches the next
    // rule, which refuses its judgments that link no obligation rather than
    // omitting them silently.
    let heldCount: unknown;
    try {
      hostFillTechnicalCorrectionProposalFromJudgmentV3(atJudgmentLimit, shared.ledger, TARGETS);
    } catch (error) {
      heldCount = error;
    }
    expect(heldCount).toMatchObject({
      rejection: { code: "judgment-links-no-open-fact", location: "$.issueJudgments[]" },
    });
    expect(() =>
      hostFillTechnicalCorrectionProposalFromJudgmentV3(
        {
          ...atJudgmentLimit,
          issueJudgments: [
            ...atJudgmentLimit.issueJudgments,
            {
              id: `TECH-${String(maxJudgments + 1).padStart(3, "0")}`,
              severity: "major" as const,
              category: "completeness" as const,
              location: "docs/guide.md:10",
              obligationIds: [] as string[],
            },
          ],
        },
        shared.ledger,
        TARGETS,
      ),
    ).toThrow(
      "technical-correction-max-issue-judgments-bound: 257 exceeds technicalCorrection.maxIssueJudgments = 256 count.",
    );
  });

  it("rejects duplicate issue judgment ids before fact linkage", async () => {
    const shared = await fixture();
    const row = omittedJudgment(shared.obligationId).issueJudgments[0]!;
    expect(() =>
      hostFillTechnicalCorrectionProposalFromJudgmentV3(
        {
          ...omittedJudgment(shared.obligationId),
          issueJudgments: [row, { ...row }],
        },
        shared.ledger,
        TARGETS,
      ),
    ).toThrow("Technical correction response rejected: invalid-shape.");
  });

  it("holds an obligation id at the identifier ceiling and refuses one more character", async () => {
    const shared = await fixture();
    const max = limit("technicalCorrection.identifierMaxChars").value;
    const judgment = (obligationId: string) => ({
      ...omittedJudgment(shared.obligationId),
      obligationJudgments: [
        {
          ...omittedJudgment(shared.obligationId).obligationJudgments[0]!,
          obligationId,
        },
      ],
    });
    expect(shared.obligationId.length).toBeLessThanOrEqual(max);
    const held = hostFillTechnicalCorrectionProposalFromJudgmentV3(
      omittedJudgment(shared.obligationId),
      shared.ledger,
      TARGETS,
    );
    expect(held.obligationAccounting[0]!.obligationId).toBe(shared.obligationId);
    expect(() =>
      hostFillTechnicalCorrectionProposalFromJudgmentV3(
        {
          ...omittedJudgment(shared.obligationId),
          issueJudgments: [
            {
              ...omittedJudgment(shared.obligationId).issueJudgments[0]!,
              obligationIds: ["O".repeat(max + 1)],
            },
          ],
        },
        shared.ledger,
        TARGETS,
      ),
    ).toThrow(
      `technical-correction-identifier-max-chars-bound: ${max + 1} exceeds technicalCorrection.identifierMaxChars = ${max} characters.`,
    );
    expect(() =>
      hostFillTechnicalCorrectionProposalFromJudgmentV3(
        judgment("O".repeat(max + 1)),
        shared.ledger,
        TARGETS,
      ),
    ).toThrow(
      `technical-correction-identifier-max-chars-bound: ${max + 1} exceeds technicalCorrection.identifierMaxChars = ${max} characters.`,
    );
  });

  /**
   * Correction keeps the provisional classification of a shared fact-inventory
   * defect, so the retry policy may repair it. Correction-only refusals follow
   * the retryability table.
   */
  async function correctionFailure(build: (obligationId: string) => unknown): Promise<unknown> {
    const shared = await fixture();
    try {
      await decodeTechnicalCorrectionResponseV3(
        canonicalizeJsonEvidence(build(shared.obligationId) as JsonEvidenceValue),
        shared.ledger,
        shared.admission,
        RUN_ID,
        TARGETS,
      );
    } catch (error) {
      return error;
    }
    throw new Error("expected the correction response to be rejected");
  }

  // A judgment's fact issue links are host-derived, so an obligation naming an
  // unknown issue is admitted; test/review-cli-obligation-links.test.ts covers it.
  it.each([
    [
      "fact-disposition",
      (obligationId: string) => ({
        ...omittedJudgment(obligationId),
        obligationJudgments: [
          {
            ...omittedJudgment(obligationId).obligationJudgments[0]!,
            documentationDisposition: "undecided",
          },
        ],
      }),
    ],
    [
      "dimension-facts",
      (obligationId: string) => ({
        verdict: "needs-revision",
        coverage: coverage(),
        issueJudgments: [],
        obligationJudgments: [
          {
            obligationId,
            disposition: "rejected",
            reason: "The source does not establish this claim.",
          },
        ],
      }),
    ],
  ] as const)("keeps the recoverable %s rejection retryable", async (detail, value) => {
    const error = await correctionFailure(value);
    expect(error).toBeInstanceOf(InferenceStepError);
    expect(error).toMatchObject({
      message: "Technical correction response rejected: invalid-fact-inventory.",
      category: "malformed-response",
      retryable: true,
      // The judgment path records an emptied dimension where the reply broke
      // it; the reply never carries factInventory. An off-vocabulary
      // disposition is the catalog rule, at the row member.
      rejection:
        detail === "dimension-facts"
          ? { code: "inventory-dimension-facts", location: "$.obligationJudgments" }
          : {
              code: "judgment-documentation-disposition-invalid",
              location: "$.obligationJudgments[].documentationDisposition",
            },
    });
  });

  it("classifies a fact-finding-link defect the same way in provisional verification", () => {
    let error: unknown;
    try {
      decodeVerificationResponse(
        canonicalizeJsonEvidence({
          review: {
            verdict: "needs-revision",
            issues: [
              {
                id: "TECH-001",
                severity: "major",
                category: "completeness",
                location: "docs/guide.md:10",
                finding: "The guide omits the structured input representation.",
                evidence: { source_id: REVISION, locator: "src/api.ts:10" },
                required_change: "Document the structured input representation.",
              },
            ],
          },
          coverage: coverage(),
          factInventory: {
            completeness: "bounded-not-proven",
            dimensions: TECHNICAL_FACT_DIMENSIONS.map((dimension) =>
              dimension === "input-representations"
                ? {
                    dimension,
                    status: "applicable",
                    reason: "The fixture source establishes structured input behavior.",
                    sourceLocators: [],
                    facts: [
                      {
                        id: "FACT-1",
                        dimension,
                        sourceLocators: ["src/api.ts:10"],
                        statement: STATEMENT,
                        documentationDisposition: "omitted",
                        uncertainty: UNCERTAINTY,
                        issueIds: ["TECH-999"],
                      },
                    ],
                  }
                : {
                    dimension,
                    status: "not-applicable",
                    reason: `The bounded fixture establishes no ${dimension} source obligation.`,
                    sourceLocators: ["src/api.ts:1"],
                    facts: [],
                  },
            ),
            limitations: [],
          },
        } as unknown as JsonEvidenceValue),
        TARGETS,
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({
      retryable: true,
      rejection: { code: "inventory-fact-finding-link", location: "$.factInventory" },
    });
  });

  const CORRECTION_ONLY_REJECTIONS = {
    "invalid-accounting": { code: "invalid-accounting", location: "$response" },
    "invalid-fact-link": {
      code: "fact-link-unknown-obligation",
      location: "$.issueJudgments[].obligationIds[]",
    },
    "target-authority": { code: "target-authority", location: "$response" },
    "invalid-shape": { code: "invalid-shape", location: "$response" },
  } as const;

  it.each([
    [
      "invalid-accounting",
      (obligationId: string) => ({ ...omittedJudgment(obligationId), obligationJudgments: [] }),
    ],
    // An unissued obligation link is correctable with a named-ID hint;
    // see review-cli-obligation-links.test.ts.
    [
      "target-authority",
      (obligationId: string) => ({
        ...omittedJudgment(obligationId),
        issueJudgments: [
          { ...omittedJudgment(obligationId).issueJudgments[0]!, location: "docs/unapproved.md:1" },
        ],
      }),
    ],
    [
      "invalid-shape",
      (obligationId: string) => ({
        ...omittedJudgment(obligationId),
        issueJudgments: [
          omittedJudgment(obligationId).issueJudgments[0]!,
          omittedJudgment(obligationId).issueJudgments[0]!,
        ],
      }),
    ],
  ] as const)(
    "classifies the correction-only %s refusal from the #1238 table",
    async (code, value) => {
      const error = await correctionFailure(value);
      expect(error).toBeInstanceOf(InferenceStepError);
      // An accounting or shape defect in the model's own reply is
      // model-correctable; an issue located outside the approved targets is an
      // authority refusal and stays terminal.
      expect(error).toMatchObject({
        message: `Technical correction response rejected: ${code}.`,
        category: "malformed-response",
        retryable: code !== "target-authority",
      });
      // Every correction refusal names a code and location; the
      // fact-link rule names which link failed and where.
      expect((error as InferenceStepError).rejection).toEqual(CORRECTION_ONLY_REJECTIONS[code]);
    },
  );
});

describe("provisional verification contract selection", () => {
  /**
   * The Pi harness binds the judgment-only prompt and selects the judgment
   * decoder from one predicate. Every provisional step in every
   * catalogued manifest must bind the judgment contract exactly when that
   * predicate selects the judgment decoder, for every ledger the step can carry.
   */
  it("binds the judgment contract only where the judgment decoder is selected", async () => {
    const { ledger: v2 } = await fixture();
    const deriveWorkflow = getWorkflow("create-documentation");
    const v1 = bindSourceObligationLedger(
      ledgerProposal(),
      {
        workflow: deriveWorkflow,
        planBinding: createDocumentationPlanBinding({
          mode: "create",
          pages: TARGETS.map((path) => ({ path, disposition: "create" as const })),
          sourceBindings: TARGETS.map((pagePath) => ({ pagePath, sources: ["src/api.ts"] })),
        }),
        evidenceIdentity: { repositoryRevision: REVISION },
        searchEvidence: searchStepEvidence({
          evidenceSha256: SEARCH_SHA256,
          workspaceSnapshotSha256: SNAPSHOT_SHA256,
        }),
      },
      [{ path: "src/api.ts", sha256: SOURCE_SHA256 }],
    );
    const provisional = listCatalogWorkflows().flatMap((workflow) =>
      workflow.steps
        .filter((step) => isProvisionalTechnicalVerification({ workflow, step }))
        .map((step) => ({ workflow, step })),
    );
    expect(provisional.map(({ workflow, step }) => `${workflow.name}/${step.id}`).sort()).toEqual([
      "create-documentation/provisional-revised-technical-verification",
      "create-documentation/provisional-technical-verification",
      "review-documentation/provisional-technical-verification",
    ]);
    for (const { workflow, step } of provisional) {
      for (const ledger of [undefined, v1, v2]) {
        const input: HarnessStepInput = {
          repositoryPath: "/workspace",
          workflow,
          step,
          ...(ledger ? { sourceObligationLedger: ledger } : {}),
        };
        const judgment = usesProvisionalVerificationJudgment(input);
        expect(judgment).toBe(ledger?.schemaVersion === 2);
        expect(
          bindProvisionalVerificationJudgmentContract(input).step.prompt.includes(
            PROVISIONAL_VERIFICATION_JUDGMENT_CONTRACT,
          ),
        ).toBe(judgment);
        // The prompt the host actually sends selects on the same predicate
        // and states exactly one outer shape.
        const prompt = buildHostStepPrompt(input);
        expect(prompt.includes(PROVISIONAL_VERIFICATION_JUDGMENT_CONTRACT)).toBe(judgment);
        expect(prompt.includes(VERIFICATION_RESPONSE_CONTRACT)).toBe(!judgment);
        expect(prompt.match(/\bone JSON object\b/giu)?.length ?? 0).toBe(1);
      }
    }
  });
});
