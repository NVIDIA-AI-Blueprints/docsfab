// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * A judgment that rejects every obligation of an applicable ledger dimension,
 * each with a substantive rejection, demotes that dimension to unverified and
 * the host records "human-review". A lazy all-reject, without a closed
 * rejection code and admitted evidence locators on every rejection, is still
 * the emptied-dimension refusal.
 *
 * The fixture is a recorded ledger shape: six applicable dimensions of
 * 3/3/3/3/5/3 obligations over one admitted source. Gaming probes (one line
 * cited on every row, a line the source does not have, every dimension at
 * once) must still be refused.
 */

import { describe, expect, it } from "vitest";

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { limit } from "../src/config/limits.js";
import { InferenceStepError, type HarnessStepInput } from "../src/execution/contracts.js";
import { TECHNICAL_CORRECTION_OBLIGATION_JUDGMENT_KEYS } from "../src/execution/response-contract-keys.js";
import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../src/json-evidence.js";
import type { RunRecord } from "../src/records/contracts.js";
import { prepareRepositoryWorkspace } from "../src/repository/workspace/materialize.js";
import { projectReviewFindingsFromRun } from "../src/review/findings.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import { createDocumentationPlanBinding } from "../src/workflow-execution/plan-binding.js";
import {
  APPLICABLE_DIMENSION_JUDGMENT_RULE,
  DIMENSION_DEMOTION_REASONS,
  DIMENSION_DEMOTION_REJECTIONS,
  OBLIGATION_REJECTION_CODES,
  TECHNICAL_FACT_DIMENSIONS,
  technicalResponseCorrection,
  type TechnicalFactDimension,
} from "../src/workflow-execution/review-response.js";
import {
  applicableDimensionContract,
  bindHostOwnedTechnicalCorrectionProposalV3,
  bindSourceObligationLedgerV2,
  decodeProvisionalVerificationJudgment,
  decodeTechnicalCorrectionResponseV3,
  demotionEvidenceLimitation,
  dimensionDemotionReason,
  sourceObligationScopeSha256,
  validateTechnicalCorrectionEvidence,
  type AdmittedSourceLineCountV1,
  type SourceObligationLedgerProposalV1,
} from "../src/workflow-execution/source-obligation.js";
import {
  countSourceLines,
  LocalSourceObligationSourceObserver,
} from "../src/workflow-execution/source-obligation-observer.js";
import {
  issueOriginalSourceAuthorityAdmission,
  sealOriginalSourceAuthority,
} from "../src/workflow-execution/source-obligation-authority.js";
import { commitFixture, initFixtureRepo } from "./helpers/git.js";
import { searchStepEvidence } from "./helpers/search-evidence-fixture.js";

const REVISION = "a".repeat(40);
const SOURCE_SHA256 = "f".repeat(64);
const SEARCH_SHA256 = "b".repeat(64);
const SNAPSHOT_SHA256 = "c".repeat(64);
const RUN_ID = "judgment-dimension-demotion-run";
const TARGET = "docs/cli-reference.md";
const SOURCE = "src/sprout.mjs";
const OTHER_SOURCE = "README.md";
const DEMOTED: TechnicalFactDimension = "mutable-state";
const MODEL_PROSE = "CANARY model rejection prose that must not become host vocabulary.";
/** The host-observed line count of the admitted source in these fixtures. */
const SOURCE_LINES = 120;

function lineCounts(lineCount = SOURCE_LINES): AdmittedSourceLineCountV1[] {
  return [{ path: SOURCE, sha256: SOURCE_SHA256, lineCount }];
}

const R3_OBLIGATION_COUNTS: Readonly<Record<TechnicalFactDimension, number>> = {
  "input-representations": 3,
  "defaults-and-overrides": 3,
  "mutable-state": 3,
  "destination-and-trust": 3,
  "error-status-retry": 5,
  "environment-prerequisite": 3,
};

function ledgerProposal(
  demotedCount: number,
  limitations: readonly string[] = [],
): SourceObligationLedgerProposalV1 {
  return {
    completeness: "bounded-not-proven",
    dimensions: TECHNICAL_FACT_DIMENSIONS.map((dimension) => ({
      dimension,
      status: "applicable" as const,
      reason: `The fixture source establishes ${dimension} behavior.`,
      sourceLocators: [],
      obligations: Array.from(
        { length: dimension === DEMOTED ? demotedCount : R3_OBLIGATION_COUNTS[dimension] },
        (_, index) => ({
          dimension,
          sourceLocators: [`${SOURCE}:${index + 1}`],
          statement: `The fixture source establishes ${dimension} consequence number ${index + 1}.`,
          evidenceClass: "source-observation" as const,
          uncertainty: "The source was inspected but the command was not executed.",
        }),
      ),
    })),
    limitations: [...limitations],
  };
}

/** `demotedCount` sizes the `DEMOTED` dimension; the recorded shape by default. */
async function fixture(
  demotedCount = R3_OBLIGATION_COUNTS[DEMOTED],
  ledgerLimitations: readonly string[] = [],
) {
  const workflow = getWorkflow("create-documentation");
  const planBinding = createDocumentationPlanBinding({
    mode: "create",
    pages: [{ path: TARGET, disposition: "create" as const }],
    sourceBindings: [{ pagePath: TARGET, sources: [SOURCE, OTHER_SOURCE] }],
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
    members: [OTHER_SOURCE, SOURCE].map((path) => ({
      path,
      mode: 0o644,
      byteLength: 1,
      sourceSha256: SOURCE_SHA256,
    })),
  });
  // Only SOURCE was observed at seal, so only it is admitted evidence, even
  // though OTHER_SOURCE is inside the original source authority.
  const ledger = bindSourceObligationLedgerV2(
    ledgerProposal(demotedCount, ledgerLimitations),
    input,
    [{ path: SOURCE, sha256: SOURCE_SHA256 }],
    sealed.evidence,
  );
  const admission = issueOriginalSourceAuthorityAdmission({
    capture: sealed.capture,
    observer: {
      observe: async (paths: readonly string[]) =>
        [...new Set(paths)].sort().map((path) => ({ path, sha256: SOURCE_SHA256 })),
    },
    runId: RUN_ID,
    repositoryRevision: REVISION,
    scopeSha256,
    workspaceSnapshotSha256: SNAPSHOT_SHA256,
  });
  return { ledger, admission, authorityEvidence: sealed.evidence, planBinding };
}

type Ledger = Awaited<ReturnType<typeof fixture>>["ledger"];
type Row = Record<string, unknown>;

function obligationIdsOf(ledger: Ledger, dimension: TechnicalFactDimension): string[] {
  return ledger.dimensions
    .find((entry) => entry.dimension === dimension)!
    .obligations.map(({ id }) => id);
}

/** A rejection the demotion rule counts as substantive. */
function substantive(obligationId: string, index: number): Row {
  return {
    obligationId,
    disposition: "rejected",
    reason: MODEL_PROSE,
    rejectionCode: "not-established-by-source",
    evidenceLocators: [`${SOURCE}:${index + 10}-${index + 12}`],
  };
}

/**
 * Every obligation retained as documented, except those of `DEMOTED`, whose
 * rows `rejectRow` builds. The model says "pass".
 */
function judgment(ledger: Ledger, rejectRow: (id: string, index: number) => Row = substantive) {
  return {
    verdict: "pass",
    coverage: [
      {
        path: TARGET,
        status: "verified",
        evidence: [`${SOURCE}:1`],
        reason: "Compared the candidate with the cited frozen source.",
      },
    ],
    issueJudgments: [],
    obligationJudgments: ledger.dimensions.flatMap(({ dimension, obligations }) =>
      obligations.map(({ id }, index) =>
        dimension === DEMOTED
          ? rejectRow(id, index)
          : {
              obligationId: id,
              disposition: "retained",
              documentationDisposition: "documented",
              issueIds: [],
            },
      ),
    ),
  };
}

/** `lines: null` decodes with no host line evidence at all. */
function provisional(
  ledger: Ledger,
  value: unknown,
  lines: readonly AdmittedSourceLineCountV1[] | null = lineCounts(),
) {
  return decodeProvisionalVerificationJudgment(
    canonicalizeJsonEvidence(value as JsonEvidenceValue),
    ledger,
    [TARGET],
    lines ?? undefined,
  );
}

function refusal(run: () => unknown): Promise<InferenceStepError> {
  return Promise.resolve()
    .then(run)
    .then(
      () => {
        throw new Error("expected the judgment to be refused");
      },
      (error: unknown) => {
        expect(error).toBeInstanceOf(InferenceStepError);
        return error as InferenceStepError;
      },
    );
}

const EXPECTED_REASON = dimensionDemotionReason(DEMOTED, "all-obligations-rejected-with-evidence", [
  "not-established-by-source",
]);

describe("a substantive all-reject demotes the dimension (#1254)", () => {
  it("provisional verification: unverified dimension, closed reason, and human-review", async () => {
    const { ledger } = await fixture();
    const result = provisional(ledger, judgment(ledger));
    const demoted = result.factInventory.dimensions.find(({ dimension }) => dimension === DEMOTED)!;
    expect(demoted).toEqual({
      dimension: DEMOTED,
      status: "unverified",
      reason: EXPECTED_REASON,
      sourceLocators: [`${SOURCE}:10-12`, `${SOURCE}:11-13`, `${SOURCE}:12-14`],
      facts: [],
    });
    expect(result.factInventory.limitations).toContain(EXPECTED_REASON);
    expect(result.review.verdict).toBe("human-review");
    // Each rejection's own code and evidence, per obligation, not only the union.
    const perRow = obligationIdsOf(ledger, DEMOTED).map(
      (obligationId, index) =>
        `Host demotion evidence for rejected source obligation ${obligationId} (${DEMOTED}): not-established-by-source at ${SOURCE}:${index + 10}-${index + 12}.`,
    );
    expect(result.factInventory.limitations).toEqual(expect.arrayContaining(perRow));
    for (const limitation of perRow) expect(limitation).not.toContain("CANARY");
    // One limitation per rejected obligation: the host evidence stands in for
    // the generic rejected-obligation entry, so the model's reason is not kept.
    for (const obligationId of obligationIdsOf(ledger, DEMOTED)) {
      expect(
        result.factInventory.limitations.filter((limitation) => limitation.includes(obligationId)),
      ).toHaveLength(1);
    }
    expect(result.factInventory.limitations).toHaveLength(1 + perRow.length);
    for (const other of result.factInventory.dimensions) {
      if (other.dimension !== DEMOTED) expect(other.status).toBe("applicable");
    }
  });

  it("the reason is host vocabulary only: dimension, demotion reason, and rejection codes", async () => {
    expect(EXPECTED_REASON).toBe(
      "Host demotion all-obligations-rejected-with-evidence: every obligation of the applicable ledger dimension mutable-state was rejected with admitted source evidence (rejection codes: not-established-by-source), so no source-verified fact remains for it and human review is required.",
    );
    const { ledger } = await fixture();
    const mixed = judgment(ledger, (id, index) => ({
      ...substantive(id, index),
      rejectionCode: OBLIGATION_REJECTION_CODES[index % 2],
    }));
    const demoted = provisional(ledger, mixed).factInventory.dimensions.find(
      ({ dimension }) => dimension === DEMOTED,
    )!;
    expect(demoted.reason).toBe(
      dimensionDemotionReason(DEMOTED, DIMENSION_DEMOTION_REASONS[0], [
        "contradicted-by-source",
        "not-established-by-source",
      ]),
    );
    expect(JSON.stringify(demoted)).not.toContain("CANARY");
  });

  it("final correction: the retained V3 evidence carries the demotion and revalidates", async () => {
    const { ledger, admission, authorityEvidence } = await fixture();
    const correction = await decodeTechnicalCorrectionResponseV3(
      canonicalizeJsonEvidence(judgment(ledger) as JsonEvidenceValue),
      ledger,
      admission,
      RUN_ID,
      [TARGET],
      lineCounts(),
    );
    expect(correction.verificationResult.review.verdict).toBe("human-review");
    expect(correction.proposal.verdict).toBe("human-review");
    const demoted = correction.proposal.factInventory.dimensions.find(
      ({ dimension }) => dimension === DEMOTED,
    )!;
    expect(demoted).toMatchObject({
      status: "unverified",
      reason: EXPECTED_REASON,
      facts: [],
    });
    expect(
      correction.proposal.obligationAccounting
        .filter(({ obligationId }) => obligationIdsOf(ledger, DEMOTED).includes(obligationId))
        .map(({ disposition }) => disposition),
    ).toEqual(["rejected", "rejected", "rejected"]);
    expect(correction.evidence.sourceChecks.map(({ path }) => path)).toEqual([SOURCE]);
    expect(
      validateTechnicalCorrectionEvidence(
        correction.evidence,
        ledger,
        correction.verificationResult,
        authorityEvidence,
        [TARGET],
      ),
    ).toEqual(correction.evidence);
  });

  it("the operator's review findings show the demoted dimension and human-review", async () => {
    const { ledger, planBinding } = await fixture();
    const result = provisional(ledger, judgment(ledger));
    const projection = projectReviewFindingsFromRun({
      workflow: "create-documentation",
      steps: [
        {
          id: "plan-documentation",
          title: "Plan documentation",
          skill: "plan-documentation",
          mode: "read-only",
          status: "succeeded",
          summary: "planned",
          planBinding,
        },
        {
          id: "verify-technical-accuracy",
          title: "Verify technical accuracy",
          skill: "verify-technical-accuracy",
          mode: "read-only",
          status: "succeeded",
          summary: canonicalizeJsonEvidence(result as unknown as JsonEvidenceValue).trimEnd(),
        },
      ] as RunRecord["steps"],
    });
    expect(projection.limitations).toEqual(
      expect.arrayContaining([
        "review-findings-human-review:verify-technical-accuracy",
        `review-findings-fact-inventory-unverified:${DEMOTED}:${EXPECTED_REASON}:retained=run-step:verify-technical-accuracy:summary`,
      ]),
    );
    // The reviewer sees each rejection's code and evidence, per obligation.
    const [first] = obligationIdsOf(ledger, DEMOTED);
    expect(
      projection.limitations.some((limitation) =>
        limitation.includes(
          `Host demotion evidence for rejected source obligation ${first} (${DEMOTED}): not-established-by-source at ${SOURCE}:10-12.`,
        ),
      ),
    ).toBe(true);
  });
});

describe("a malformed all-reject is still refused (#1248, #1254)", () => {
  const lazy: readonly [string, (id: string, index: number) => Row][] = [
    [
      "no rejection code or evidence",
      (id) => ({
        obligationId: id,
        disposition: "rejected",
        reason: MODEL_PROSE,
      }),
    ],
    [
      "no rejection code",
      (id, index) => {
        const { rejectionCode: _omitted, ...row } = substantive(id, index);
        return row;
      },
    ],
    [
      "no evidence locators",
      (id, index) => {
        const { evidenceLocators: _omitted, ...row } = substantive(id, index);
        return row;
      },
    ],
    [
      "an off-vocabulary code",
      (id, index) => ({ ...substantive(id, index), rejectionCode: "lazy" }),
    ],
    ["an empty locator list", (id, index) => ({ ...substantive(id, index), evidenceLocators: [] })],
    [
      "a locator outside the admitted sources",
      (id, index) => ({
        ...substantive(id, index),
        evidenceLocators: [`${OTHER_SOURCE}:1`],
      }),
    ],
    [
      "a locator that names no specific position",
      (id, index) => ({
        ...substantive(id, index),
        evidenceLocators: [SOURCE],
      }),
    ],
    [
      "a revision-suffixed line locator",
      (id, index) => ({
        ...substantive(id, index),
        evidenceLocators: [`${SOURCE}:1@${REVISION}`],
      }),
    ],
    [
      "a revision-suffixed section locator",
      (id, index) => ({
        ...substantive(id, index),
        evidenceLocators: [`${SOURCE}: main@${REVISION}`],
      }),
    ],
    [
      "a repeated locator",
      (id, index) => ({
        ...substantive(id, index),
        evidenceLocators: [`${SOURCE}:1`, `${SOURCE}:1`],
      }),
    ],
    [
      "an untrimmed locator",
      (id, index) => ({
        ...substantive(id, index),
        evidenceLocators: [` ${SOURCE}:1`],
      }),
    ],
    ["a non-string locator", (id, index) => ({ ...substantive(id, index), evidenceLocators: [1] })],
    [
      "an admitted locator beside one outside the admitted sources",
      (id, index) => ({
        ...substantive(id, index),
        evidenceLocators: [`${SOURCE}:1`, `${OTHER_SOURCE}:1`],
      }),
    ],
    [
      "one lazy rejection among substantive ones",
      (id, index) =>
        index === 0
          ? { obligationId: id, disposition: "rejected", reason: MODEL_PROSE }
          : substantive(id, index),
    ],
  ];

  it.each(lazy)("refuses %s as the emptied-dimension rule", async (_label, rejectRow) => {
    const { ledger } = await fixture();
    const error = await refusal(() => provisional(ledger, judgment(ledger, rejectRow)));
    expect(error).toMatchObject({
      retryable: true,
      rejection: {
        code: "inventory-dimension-facts",
        location: "$.obligationJudgments",
      },
    });
    expect(technicalResponseCorrection(error)).toEqual({
      kind: "emptied-applicable-dimensions",
      dimensions: [DEMOTED],
    });
  });

  it("refuses the lazy all-reject in the final correction too", async () => {
    const { ledger, admission } = await fixture();
    const error = await refusal(() =>
      decodeTechnicalCorrectionResponseV3(
        canonicalizeJsonEvidence(judgment(ledger, lazy[0]![1]) as JsonEvidenceValue),
        ledger,
        admission,
        RUN_ID,
        [TARGET],
        lineCounts(),
      ),
    );
    expect(error.rejection).toEqual({
      code: "inventory-dimension-facts",
      location: "$.obligationJudgments",
    });
  });

  it("does not demote a dimension that keeps an obligation, whatever its rejections carry", async () => {
    const { ledger } = await fixture();
    const [kept] = obligationIdsOf(ledger, DEMOTED);
    const result = provisional(
      ledger,
      judgment(ledger, (id, index) =>
        id === kept
          ? {
              obligationId: id,
              disposition: "retained",
              documentationDisposition: "documented",
              issueIds: [],
            }
          : substantive(id, index),
      ),
    );
    const dimension = result.factInventory.dimensions.find(
      ({ dimension: name }) => name === DEMOTED,
    )!;
    expect(dimension.status).toBe("applicable");
    expect(dimension.facts).toHaveLength(1);
    expect(result.review.verdict).toBe("pass");
  });
});

/** Every row of `DEMOTED` rejected with a well-formed but lazy citation. */
function citing(...locators: string[]) {
  return (id: string, index: number): Row => ({
    ...substantive(id, index),
    evidenceLocators: locators,
  });
}

describe("a well-formed lazy all-reject is refused (#1254 critic probes)", () => {
  const rejection = (reason: keyof typeof DIMENSION_DEMOTION_REJECTIONS) => ({
    retryable: true,
    rejection: { ...DIMENSION_DEMOTION_REJECTIONS[reason] },
  });

  it.each([
    ["one obligation's own ledger line", `${SOURCE}:1`],
    ["a line no obligation cites", `${SOURCE}:50`],
    ["one line spelled as a one-line range", `${SOURCE}:50-50`],
  ])("refuses the same citation on every row: %s", async (_label, locator) => {
    const { ledger } = await fixture();
    const error = await refusal(() => provisional(ledger, judgment(ledger, citing(locator))));
    expect(error).toMatchObject(rejection("singleLine"));
  });

  it("refuses one line spelled two ways on every row", async () => {
    const { ledger } = await fixture();
    const error = await refusal(() =>
      provisional(ledger, judgment(ledger, citing(`${SOURCE}:7`, `${SOURCE}:7-7`))),
    );
    expect(error).toMatchObject(rejection("singleLine"));
  });

  it("admits two distinct lines across the dimension, or one multi-line range", async () => {
    const { ledger } = await fixture();
    for (const cite of [citing(`${SOURCE}:7`, `${SOURCE}:8`), citing(`${SOURCE}:7-8`)]) {
      const result = provisional(ledger, judgment(ledger, cite));
      expect(result.review.verdict).toBe("human-review");
    }
  });

  it.each([
    ["a line past the end of a 1-line source", `${SOURCE}:99999`, 1],
    ["a range that ends past the last line", `${SOURCE}:1-2`, 1],
    ["a line of an empty source", `${SOURCE}:5`, 0],
    ["a section locator, which names no line", `${SOURCE}: main`, SOURCE_LINES],
    ["an anchor locator, which names no line", `${SOURCE}#main`, SOURCE_LINES],
  ])("refuses %s as unresolved evidence", async (_label, locator, lineCount) => {
    const { ledger } = await fixture();
    const error = await refusal(() =>
      provisional(
        ledger,
        judgment(ledger, (id, index) => ({
          ...substantive(id, index),
          // Every other citation resolves, so only the probe can refuse.
          evidenceLocators: [`${SOURCE}:1`, locator],
        })),
        lineCounts(lineCount),
      ),
    );
    expect(error).toMatchObject(rejection("unresolvedEvidence"));
  });

  it("admits a range that ends on the last line", async () => {
    const { ledger } = await fixture();
    const result = provisional(
      ledger,
      judgment(ledger, citing(`${SOURCE}:1-${SOURCE_LINES}`)),
      lineCounts(SOURCE_LINES),
    );
    expect(result.review.verdict).toBe("human-review");
  });

  it("refuses a judgment that would demote every applicable dimension", async () => {
    const { ledger } = await fixture();
    const everything = {
      ...judgment(ledger),
      obligationJudgments: ledger.dimensions.flatMap(({ obligations }) =>
        obligations.map(({ id }, index) => substantive(id, index)),
      ),
    };
    const error = await refusal(() => provisional(ledger, everything));
    expect(error).toMatchObject(rejection("everyApplicableDimension"));
    const { admission } = await fixture();
    const final = await refusal(() =>
      decodeTechnicalCorrectionResponseV3(
        canonicalizeJsonEvidence(everything as JsonEvidenceValue),
        ledger,
        admission,
        RUN_ID,
        [TARGET],
        lineCounts(),
      ),
    );
    expect(final).toMatchObject(rejection("everyApplicableDimension"));
  });

  it("admits demoting every applicable dimension but one", async () => {
    const { ledger } = await fixture();
    const [kept] = ledger.dimensions[0]!.obligations;
    const result = provisional(ledger, {
      ...judgment(ledger),
      obligationJudgments: ledger.dimensions.flatMap(({ obligations }) =>
        obligations.map(({ id }, index) =>
          id === kept!.id
            ? {
                obligationId: id,
                disposition: "retained",
                documentationDisposition: "documented",
                issueIds: [],
              }
            : substantive(id, index),
        ),
      ),
    });
    expect(
      result.factInventory.dimensions.filter(({ status }) => status === "unverified"),
    ).toHaveLength(TECHNICAL_FACT_DIMENSIONS.length - 1);
  });

  it("refuses by authority, without retry, when the host has no line evidence", async () => {
    const { ledger } = await fixture();
    for (const lines of [
      null,
      [{ path: SOURCE, sha256: "e".repeat(64), lineCount: SOURCE_LINES }],
      [...lineCounts(), { path: OTHER_SOURCE, sha256: SOURCE_SHA256, lineCount: 1 }],
      [...lineCounts(), ...lineCounts()],
      [],
      [{ path: SOURCE, sha256: SOURCE_SHA256, lineCount: -1 }],
    ]) {
      const error = await refusal(() => provisional(ledger, judgment(ledger), lines));
      expect(error).toMatchObject({ retryable: false, rejection: { code: "source-authority" } });
    }
  });

  it("never asks for line evidence when nothing is demoted", async () => {
    const { ledger } = await fixture();
    const [kept] = obligationIdsOf(ledger, DEMOTED);
    const result = provisional(
      ledger,
      judgment(ledger, (id, index) =>
        id === kept
          ? {
              obligationId: id,
              disposition: "retained",
              documentationDisposition: "documented",
              issueIds: [],
            }
          : substantive(id, index),
      ),
      null,
    );
    expect(result.review.verdict).toBe("pass");
  });

  it("bounds one rejection's evidence limitation by name", () => {
    const maximum = limit("technicalCorrection.fieldMaxChars").value;
    const long = `${"a".repeat(500)}.mjs`;
    const row = {
      obligationId: "OBL-MUTABLE-STATE-1",
      rejectionCode: "not-established-by-source" as const,
      evidenceLocators: Array.from({ length: 16 }, (_, line) => `${long}:${line + 1}`),
    };
    expect(demotionEvidenceLimitation(DEMOTED, { ...row, evidenceLocators: [`${SOURCE}:1`] })).toBe(
      `Host demotion evidence for rejected source obligation OBL-MUTABLE-STATE-1 (${DEMOTED}): not-established-by-source at ${SOURCE}:1.`,
    );
    expect(row.evidenceLocators.join("; ").length).toBeGreaterThan(maximum);
    let error: unknown;
    try {
      demotionEvidenceLimitation(DEMOTED, row);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(InferenceStepError);
    expect((error as InferenceStepError).rejection?.code).toBe("bounds-exceeded");
  });
});

describe("the final limitation count is bounded by name (#1254)", () => {
  const maximum = limit("factInventory.maxLimitations").value;

  /** The bound refusal: named, with the observed count, and never retried. */
  function expectNamedBound(error: InferenceStepError, observed: number) {
    expect(error).toMatchObject({
      retryable: false,
      rejection: { code: "fact-inventory-limitations-exceeded", location: "$.obligationJudgments" },
    });
    expect(error.message).toContain("bounds-exceeded");
    expect(error.message).toContain(
      `fact-inventory-max-limitations-bound: ${observed} limitations exceed factInventory.maxLimitations = ${maximum} count`,
    );
    expect(error.message).toContain("Retaining obligations the source does not establish");
  }

  // A demoted dimension of N obligations adds its reason plus one evidence
  // limitation per obligation: N + 1 in all, with no ledger limitations.
  it.each([
    ["limit - 1", maximum - 2],
    ["limit", maximum - 1],
  ])(
    "admits a demotion whose limitations reach %s, on both paths",
    async (_label, demotedCount) => {
      const { ledger, admission } = await fixture(demotedCount);
      const result = provisional(ledger, judgment(ledger));
      expect(result.review.verdict).toBe("human-review");
      expect(result.factInventory.limitations).toHaveLength(demotedCount + 1);
      const correction = await decodeTechnicalCorrectionResponseV3(
        canonicalizeJsonEvidence(judgment(ledger) as JsonEvidenceValue),
        ledger,
        admission,
        RUN_ID,
        [TARGET],
        lineCounts(),
      );
      expect(correction.verificationResult.factInventory.limitations).toHaveLength(
        demotedCount + 1,
      );
    },
  );

  it("refuses a demotion at limit + 1 by name, without retry, on both paths", async () => {
    const demotedCount = maximum;
    const { ledger, admission } = await fixture(demotedCount);
    expectNamedBound(await refusal(() => provisional(ledger, judgment(ledger))), demotedCount + 1);
    expectNamedBound(
      await refusal(() =>
        decodeTechnicalCorrectionResponseV3(
          canonicalizeJsonEvidence(judgment(ledger) as JsonEvidenceValue),
          ledger,
          admission,
          RUN_ID,
          [TARGET],
          lineCounts(),
        ),
      ),
      demotedCount + 1,
    );
  });

  // Without demotion, each rejected obligation adds its generic limitation.
  const keepFirstRejectRest = (ledger: Ledger) =>
    judgment(ledger, (id, index) =>
      index === 0
        ? {
            obligationId: id,
            disposition: "retained",
            documentationDisposition: "documented",
            issueIds: [],
          }
        : { obligationId: id, disposition: "rejected", reason: MODEL_PROSE },
    );

  it("admits exactly the limit of ordinary rejections", async () => {
    const { ledger } = await fixture(maximum + 1);
    const result = provisional(ledger, keepFirstRejectRest(ledger));
    expect(result.factInventory.limitations).toHaveLength(maximum);
  });

  it("keeps the generic limitation for a rejection outside the demoted dimension", async () => {
    const { ledger } = await fixture();
    const other = ledger.dimensions.find(({ dimension }) => dimension !== DEMOTED)!;
    const [rejected] = other.obligations;
    const base = judgment(ledger);
    const result = provisional(ledger, {
      ...base,
      obligationJudgments: base.obligationJudgments.map((row) =>
        row.obligationId === rejected!.id
          ? { obligationId: rejected!.id, disposition: "rejected", reason: MODEL_PROSE }
          : row,
      ),
    });
    const mentions = result.factInventory.limitations.filter((limitation) =>
      limitation.includes(rejected!.id),
    );
    expect(mentions).toHaveLength(1);
    expect(mentions[0]).toMatch(new RegExp(`^Rejected source obligation ${rejected!.id}: `, "u"));
    expect(result.factInventory.limitations).toHaveLength(
      2 + obligationIdsOf(ledger, DEMOTED).length,
    );
  });

  it("keeps the generic limitation when a ledger limitation spoofs the host evidence marker", async () => {
    // Ledger limitations are model text and obligation IDs are predictable, so
    // the marker proves nothing.
    const other = TECHNICAL_FACT_DIMENSIONS.find((dimension) => dimension !== DEMOTED)!;
    const target = `OBL-${other.toUpperCase()}-2`;
    const spoof = `Host demotion evidence for rejected source obligation ${target} (${other}): not-established-by-source at ${SOURCE}:1.`;
    const { ledger, admission, authorityEvidence } = await fixture(undefined, [spoof]);
    expect(ledger.dimensions.find(({ dimension }) => dimension === other)!.obligations[1]!.id).toBe(
      target,
    );
    // No dimension is demoted: one ordinary rejection in a dimension that
    // keeps its other obligations.
    const ordinary = judgment(ledger, (id) => ({
      obligationId: id,
      disposition: "retained",
      documentationDisposition: "documented",
      issueIds: [],
    }));
    const value = {
      ...ordinary,
      obligationJudgments: ordinary.obligationJudgments.map((row) =>
        row.obligationId === target
          ? { obligationId: target, disposition: "rejected", reason: MODEL_PROSE }
          : row,
      ),
    };
    const generic = new RegExp(`^Rejected source obligation ${target}: `, "u");
    const result = provisional(ledger, value);
    expect(result.factInventory.dimensions.every(({ status }) => status === "applicable")).toBe(
      true,
    );
    expect(result.factInventory.limitations.filter((entry) => generic.test(entry))).toHaveLength(1);
    const correction = await decodeTechnicalCorrectionResponseV3(
      canonicalizeJsonEvidence(value as JsonEvidenceValue),
      ledger,
      admission,
      RUN_ID,
      [TARGET],
      lineCounts(),
    );
    expect(
      correction.verificationResult.factInventory.limitations.filter((entry) =>
        generic.test(entry),
      ),
    ).toHaveLength(1);
    expect(
      validateTechnicalCorrectionEvidence(
        correction.evidence,
        ledger,
        correction.verificationResult,
        authorityEvidence,
        [TARGET],
      ),
    ).toEqual(correction.evidence);
  });

  it("refuses a host proposal whose demoted rejection lacks its evidence limitation", async () => {
    const { ledger, admission } = await fixture();
    const { proposal } = await decodeTechnicalCorrectionResponseV3(
      canonicalizeJsonEvidence(judgment(ledger) as JsonEvidenceValue),
      ledger,
      admission,
      RUN_ID,
      [TARGET],
      lineCounts(),
    );
    const stripped = {
      ...proposal,
      factInventory: {
        ...proposal.factInventory,
        limitations: proposal.factInventory.limitations.filter(
          (entry) => !entry.startsWith("Host demotion evidence for rejected source obligation "),
        ),
      },
    };
    await expect(
      bindHostOwnedTechnicalCorrectionProposalV3(stripped, ledger, admission, RUN_ID, [TARGET]),
    ).rejects.toThrow("has no host evidence limitation");
  });

  it("refuses one ordinary rejection over the limit by name, without retry", async () => {
    const { ledger } = await fixture(maximum + 2);
    expectNamedBound(
      await refusal(() => provisional(ledger, keepFirstRejectRest(ledger))),
      maximum + 1,
    );
  });
});

describe("the host counts the sealed sources' lines (#1254)", () => {
  it.each([
    ["", 0],
    ["x", 1],
    ["x\n", 1],
    ["x\ny", 2],
    ["x\n\n", 2],
    ["\n", 1],
    ["a\r\nb\r\n", 2],
  ])("counts %j as %i lines", (content, expected) => {
    expect(countSourceLines(new TextEncoder().encode(content))).toBe(expected);
  });

  it("reads the tracked source and refuses bytes that no longer match the seal", async () => {
    const root = await mkdtemp(join(tmpdir(), "docsfab-demotion-lines-"));
    const source = join(root, "source");
    let workspace: Awaited<ReturnType<typeof prepareRepositoryWorkspace>> | undefined;
    try {
      await mkdir(join(source, "src"), { recursive: true });
      await writeFile(join(source, "src", "cli.mjs"), "one\ntwo\nthree\n");
      await initFixtureRepo(source, undefined, { branch: "main" });
      await commitFixture(source, "line count fixture");
      workspace = await prepareRepositoryWorkspace(source, "HEAD");
      const observer = new LocalSourceObligationSourceObserver(workspace);
      const [identity] = await observer.observe(["src/cli.mjs"]);
      expect(await observer.lineCounts([identity!])).toEqual([
        { path: "src/cli.mjs", sha256: identity!.sha256, lineCount: 3 },
      ]);
      await expect(
        observer.lineCounts([{ path: "src/cli.mjs", sha256: "e".repeat(64) }]),
      ).rejects.toThrow("changed after the derivation evidence was sealed");
    } finally {
      await workspace?.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("evidence locators are bounded by name (#1254)", () => {
  const maximum = limit("technicalCorrection.maxDemotionEvidenceLocators").value;

  it("refuses one rejection that cites more locators than the limit, before reading them", async () => {
    const { ledger } = await fixture();
    // The last locator is not admitted: the count is refused by name first.
    const error = await refusal(() =>
      provisional(
        ledger,
        judgment(ledger, (id, index) => ({
          ...substantive(id, index),
          evidenceLocators: [
            ...Array.from({ length: maximum }, (_, line) => `${SOURCE}:${line + 1}`),
            `${OTHER_SOURCE}:1`,
          ],
        })),
      ),
    );
    expect(error.rejection?.code).toBe("bounds-exceeded");
    expect(error.retryable).toBe(true);
  });

  it("refuses a dimension whose rejections together cite more locators than the limit", async () => {
    const { ledger } = await fixture();
    const perRow = Math.ceil((maximum + 1) / R3_OBLIGATION_COUNTS[DEMOTED]);
    expect(perRow).toBeLessThanOrEqual(maximum);
    const error = await refusal(() =>
      provisional(
        ledger,
        judgment(ledger, (id, index) => ({
          ...substantive(id, index),
          evidenceLocators: Array.from(
            { length: perRow },
            (_, line) => `${SOURCE}:${index * perRow + line + 1}`,
          ),
        })),
      ),
    );
    expect(error.rejection?.code).toBe("bounds-exceeded");
  });

  it("admits exactly the limit across the dimension", async () => {
    const { ledger } = await fixture();
    const result = provisional(
      ledger,
      judgment(ledger, (id, index) => ({
        ...substantive(id, index),
        evidenceLocators: Array.from({ length: maximum }, (_, line) => `${SOURCE}:${line + 1}`),
      })),
    );
    const demoted = result.factInventory.dimensions.find(({ dimension }) => dimension === DEMOTED)!;
    expect(demoted.sourceLocators).toHaveLength(maximum);
  });
});

describe("the contracts state the demotion rule once (#1254)", () => {
  it("declares the two judgment-row fields", () => {
    expect(TECHNICAL_CORRECTION_OBLIGATION_JUDGMENT_KEYS).toEqual(
      expect.arrayContaining(["rejectionCode", "evidenceLocators"]),
    );
  });

  it("the rule names both closed codes and no longer forbids every all-reject", () => {
    for (const code of OBLIGATION_REJECTION_CODES) {
      expect(APPLICABLE_DIMENSION_JUDGMENT_RULE).toContain(`"${code}"`);
    }
    expect(APPLICABLE_DIMENSION_JUDGMENT_RULE).not.toContain("Never reject all");
  });

  it("lists the admitted source paths, and their line counts, beside the applicable dimensions", async () => {
    const { ledger } = await fixture();
    expect(applicableDimensionContract({ sourceObligationLedger: ledger })).toContain(
      `Admitted source paths for evidenceLocators: ${JSON.stringify([SOURCE])}.`,
    );
    expect(
      applicableDimensionContract({
        sourceObligationLedger: ledger,
        admittedSourceLineCounts: lineCounts(),
      }),
    ).toContain(`Their line counts: ${JSON.stringify({ [SOURCE]: SOURCE_LINES })}.`);
  });

  it("states the line, distinct-line, and keep-one rules", () => {
    expect(APPLICABLE_DIMENSION_JUDGMENT_RULE).toContain(
      "citing only lines that exist in that source",
    );
    expect(APPLICABLE_DIMENSION_JUDGMENT_RULE).toContain(
      "must together cite at least two distinct source lines",
    );
    expect(APPLICABLE_DIMENSION_JUDGMENT_RULE).toContain(
      "at least one applicable dimension must keep a retained or refined obligation",
    );
  });
});
