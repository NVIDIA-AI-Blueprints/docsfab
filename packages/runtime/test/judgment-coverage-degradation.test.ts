// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HarnessStepInput,
  InferenceStepError,
  SourceObligationLedgerProposalV1,
  TECHNICAL_FACT_DIMENSIONS,
  bindSourceObligationLedgerV2,
  canonicalizeJsonEvidence,
  captureInferenceFailure,
  createAuditHarness,
  createRepository,
  getWorkflow,
  issueOriginalSourceAuthorityAdmission,
  limitDefinition,
  resetSharedTestState,
  reviewSourcePhaseInput,
  scriptedProvider,
  sealOriginalSourceAuthority,
  sourceObligationScopeSha256,
  textTurn,
  type JsonEvidenceValue,
} from "./support/pi-harness-session-fixtures.js";
import { buildHostStepPrompt } from "../src/harness/pi.js";
import { HOST_COVERAGE_DEGRADATION_STEM } from "../src/workflow-execution/judgment-coverage.js";
import {
  decodeProvisionalVerificationJudgment,
  judgmentAnswerCharBudget,
  judgmentCoveragePolicy,
} from "../src/workflow-execution/source-obligation.js";
import { searchStepEvidence } from "./helpers/search-evidence-fixture.js";

afterEach(resetSharedTestState);

/** The bound composition's per-turn output limit. */
const BOUND_OUTPUT_TOKENS = 32_768;

/**
 * On `review-documentation` judgment steps, model-content coverage defects degrade and
 * continue rather than refuse. Cases drive `PiHarness.runStep` with a scripted
 * provider, so the workflow gate, reply admission, the shared host fill and the
 * coverage validator all run.
 */
describe("review-documentation judgment coverage degradation", () => {
  const SOURCE_SHA256 = "f".repeat(64);
  const APPLICABLE_DIMENSION = "input-representations";
  const TARGET = "README.md";
  const OTHER_TARGET = "docs/other.md";

  /**
   * The model's own ledger proposal: obligations carry no host-issued id yet,
   * so it is not a `SourceObligationDimensionV1` until `bindSourceObligationLedgerV2`
   * mints them. One cast, at that boundary.
   */
  function proposal(): SourceObligationLedgerProposalV1 {
    return {
      completeness: "bounded-not-proven",
      dimensions: TECHNICAL_FACT_DIMENSIONS.map((dimension) =>
        dimension === APPLICABLE_DIMENSION
          ? {
              dimension,
              status: "applicable" as const,
              reason: "The focused source establishes one input obligation.",
              sourceLocators: [],
              obligations: [
                {
                  dimension,
                  sourceLocators: ["README.md:1"],
                  statement: "The command input requires a flag defined by the option parser.",
                  evidenceClass: "source-observation" as const,
                  uncertainty: "The focused source fixture defines the required flag.",
                },
              ],
            }
          : {
              dimension,
              status: "not-applicable" as const,
              reason: `The focused source establishes no ${dimension} obligation.`,
              sourceLocators: ["README.md:1"],
              obligations: [],
            },
      ),
      limitations: [],
    } as unknown as SourceObligationLedgerProposalV1;
  }

  /** A sealed V2 ledger for `targets`, and the step-4 input that judges it. */
  async function sealedFixture(
    repositoryPath: string,
    targets: readonly string[] = [TARGET],
    workflowName: "review-documentation" | "create-documentation" = "review-documentation",
  ) {
    const workflow = getWorkflow(workflowName);
    const base = reviewSourcePhaseInput(repositoryPath, "derive-source-obligations");
    const reviewScope = { ...base.reviewScope!, targetPaths: [...targets] };
    const deriveInput: HarnessStepInput = { ...base, workflow, reviewScope };
    const scopeSha256 = sourceObligationScopeSha256(deriveInput);
    const sealed = sealOriginalSourceAuthority({
      runId: deriveInput.runId!,
      scope:
        workflowName === "create-documentation"
          ? "create-plan-sources"
          : "review-tracked-workspace",
      repositoryRevision: deriveInput.evidenceIdentity!.repositoryRevision,
      scopeSha256,
      workspaceSnapshotSha256: deriveInput.searchEvidence!.workspaceSnapshotSha256,
      members: [{ path: TARGET, mode: 0o644, byteLength: 10, sourceSha256: SOURCE_SHA256 }],
    });
    const ledger = bindSourceObligationLedgerV2(
      proposal(),
      deriveInput,
      [{ path: TARGET, sha256: SOURCE_SHA256 }],
      sealed.evidence,
    );
    const admission = issueOriginalSourceAuthorityAdmission({
      capture: sealed.capture,
      observer: {
        observe: async (paths) => paths.map((path) => ({ path, sha256: SOURCE_SHA256 })),
      },
      runId: deriveInput.runId!,
      repositoryRevision: deriveInput.evidenceIdentity!.repositoryRevision,
      scopeSha256,
      workspaceSnapshotSha256: deriveInput.searchEvidence!.workspaceSnapshotSha256,
    });
    const obligationId = ledger.dimensions.find(
      (dimension) => dimension.dimension === APPLICABLE_DIMENSION,
    )!.obligations[0]!.id;
    const provisionalStep = workflow.steps.find(
      (step) => step.id === "provisional-technical-verification",
    )!;
    const input: HarnessStepInput = {
      ...reviewSourcePhaseInput(repositoryPath, "provisional-technical-verification"),
      workflow,
      step: provisionalStep,
      reviewScope,
      runId: deriveInput.runId,
      sourceObligationLedger: ledger,
    };
    return { input, ledger, admission, obligationId, deriveInput };
  }

  /** The judgment answer over that ledger, with `coverage` under test. */
  function reply(obligationId: string, coverage: unknown): string {
    return JSON.stringify({
      verdict: "human-review",
      coverage,
      issueJudgments: [],
      obligationJudgments: [
        {
          obligationId,
          disposition: "retained",
          documentationDisposition: "documented",
          issueIds: [],
        },
      ],
    });
  }

  function verifiedEntry(path: string, overrides: Record<string, unknown> = {}) {
    return {
      path,
      status: "verified",
      evidence: ["README.md:1"],
      reason: "Compared the documented command with the option parser.",
      ...overrides,
    };
  }

  function scripted(answer: string) {
    const fetchMock = vi.fn(scriptedProvider([textTurn(answer)]));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  async function admit(coverage: unknown, targets: readonly string[] = [TARGET]) {
    const repositoryPath = await createRepository();
    const { input, obligationId } = await sealedFixture(repositoryPath, targets);
    scripted(reply(obligationId, coverage));
    return (await createAuditHarness()).runStep(input);
  }

  function hostNotes(result: {
    verificationResult?: { factInventory: { limitations: string[] } };
  }) {
    return (result.verificationResult?.factInventory.limitations ?? []).filter((entry) =>
      entry.startsWith(HOST_COVERAGE_DEGRADATION_STEM),
    );
  }

  it("drops a page outside the approved target set and names it in one host limitation", async () => {
    const result = await admit([verifiedEntry(TARGET), verifiedEntry("docs/unrelated.md")]);

    expect(result.verificationResult?.coverage).toHaveLength(1);
    expect(result.verificationResult?.coverage[0]?.path).toBe(TARGET);
    const notes = hostNotes(result);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("docs/unrelated.md");
    expect(notes[0]).toContain("were removed");
  });

  it("degrades the same coverage on step 5, at the correction call site", async () => {
    // Each judgment step has its own call line in
    // `reply-admission/judgment.ts`, so step 5 is driven on its own.
    const repositoryPath = await createRepository();
    const { input, admission, obligationId, deriveInput } = await sealedFixture(repositoryPath);
    const correctionInput: HarnessStepInput = {
      ...input,
      step: getWorkflow("review-documentation").steps.find(
        (step) => step.id === "verify-technical-accuracy",
      )!,
      runId: deriveInput.runId,
      originalSourceAuthorityAdmission: admission,
    };
    scripted(reply(obligationId, [verifiedEntry(TARGET), verifiedEntry("docs/unrelated.md")]));

    const result = await (await createAuditHarness()).runStep(correctionInput);

    expect(result.verificationResult?.coverage).toHaveLength(1);
    expect(result.verificationResult?.coverage[0]?.path).toBe(TARGET);
    expect(hostNotes(result)[0]).toContain("docs/unrelated.md");
    expect(result.technicalCorrectionEvidence?.schemaVersion).toBe(3);
  });

  it("refuses the same answer with the unchanged message on create-documentation (#1293)", async () => {
    // `REVIEW_WORKFLOWS` contains `create-documentation`, so membership of that
    // set is not the gate; the workflow name is.
    const repositoryPath = await createRepository();
    const { input, obligationId } = await sealedFixture(
      repositoryPath,
      [TARGET],
      "create-documentation",
    );
    scripted(reply(obligationId, [verifiedEntry(TARGET), verifiedEntry("docs/unrelated.md")]));

    const error = await captureInferenceFailure(await createAuditHarness(), input);

    // `runner.test.ts` sees the same code through the runner's re-validation,
    // which words it "Technical review response rejected".
    expect(error.message).toContain("Technical correction response rejected: invalid-coverage.");
  });

  it("host-fills an approved target the reply never covered", async () => {
    const result = await admit([verifiedEntry("docs/unrelated.md")]);

    expect(result.verificationResult?.coverage).toEqual([
      {
        path: TARGET,
        status: "unverified",
        evidence: [],
        reason: expect.stringContaining("returned no coverage entry"),
      },
    ]);
    expect(result.verificationResult?.review.verdict).toBe("human-review");
    expect(hostNotes(result)).toHaveLength(2);
  });

  it("host-fills every target when the reply returns an empty coverage array", async () => {
    const result = await admit([]);

    expect(result.verificationResult?.coverage.map(({ status }) => status)).toEqual(["unverified"]);
    expect(hostNotes(result)).toHaveLength(1);
  });

  it("keeps a target named as a locator or with a leading ./", async () => {
    // A page that is the approved target, written in a form the locator
    // grammar reads, is not dropped.
    const locator = await admit([verifiedEntry(`${TARGET}:1-40`)]);
    expect(locator.verificationResult?.coverage[0]?.path).toBe(TARGET);
    expect(hostNotes(locator).filter((note) => note.includes("were removed"))).toEqual([]);

    const dotted = await admit([verifiedEntry(`./${TARGET}`)]);
    expect(dotted.verificationResult?.coverage[0]?.path).toBe(TARGET);

    const traversal = await admit([verifiedEntry(`../${TARGET}`)]);
    expect(traversal.verificationResult?.coverage[0]?.reason).toContain(
      "returned no coverage entry",
    );
  });

  it("keeps an approved target the repository locator grammar cannot read", async () => {
    // The coverage validator admits any path without an absolute prefix, a
    // backslash or a `.`/`..` segment, while `normalizeRepositoryLocator`
    // refuses a space and a bare basename with no dot. Normalizing before
    // comparing would drop an exact match and host-fill it `unverified`.
    for (const target of ["docs/getting started.md", "CODEOWNERS"]) {
      const kept = await admit([verifiedEntry(target)], [target]);
      expect(kept.verificationResult?.coverage[0]?.path).toBe(target);
      expect(kept.verificationResult?.coverage[0]?.status).toBe("verified");
      expect(hostNotes(kept)).toEqual([]);
    }

    // The same comparison trims, so surrounding whitespace is a path rewrite
    // rather than a removal.
    const padded = await admit([verifiedEntry(`  ${TARGET}  `)]);
    expect(padded.verificationResult?.coverage[0]?.path).toBe(TARGET);
    expect(hostNotes(padded).filter((note) => note.includes("were removed"))).toEqual([]);

    // A page that is not a target in any form is still removed.
    const unrelated = await admit([verifiedEntry("docs/other page.md")], ["CODEOWNERS"]);
    expect(unrelated.verificationResult?.coverage[0]?.path).toBe("CODEOWNERS");
    expect(unrelated.verificationResult?.coverage[0]?.reason).toContain(
      "returned no coverage entry",
    );
  });

  it("truncates a reason at the bound without splitting a surrogate pair", async () => {
    // `slice` counts UTF-16 code units, so a cut between the halves of an
    // astral character leaves a lone surrogate, which would reach the record
    // escaped as `\udXXX`.
    const bound = limitDefinition("technicalCorrection.coverageReasonMaxChars").value;
    const astral = "\u{1f600}";
    const overBound = `${"r".repeat(bound - 1)}${astral}`;
    expect(overBound.length).toBe(bound + 1);

    const result = await admit([verifiedEntry(TARGET, { reason: overBound })]);

    const reason = result.verificationResult?.coverage[0]?.reason ?? "";
    expect(reason).toBe("r".repeat(bound - 1));
    expect(JSON.stringify(reason)).not.toMatch(/\\ud[89ab][0-9a-f]{2}/iu);
    expect(hostNotes(result)).toHaveLength(1);
  });

  it("names the path rewrite in the host note when a target is named as a locator", async () => {
    const result = await admit([verifiedEntry(`${TARGET}:1-40`)]);

    expect(result.verificationResult?.coverage[0]?.path).toBe(TARGET);
    expect(hostNotes(result)).toHaveLength(1);
    expect(hostNotes(result)[0]).toContain("carried a path, status, reason");
    expect(hostNotes(result)[0]).toContain("A path is rewritten when");
  });

  it("records an off-vocabulary status as unverified and leaves a valid one alone", async () => {
    const offVocabulary = await admit([verifiedEntry(TARGET, { status: "partial" })]);
    expect(offVocabulary.verificationResult?.coverage[0]?.status).toBe("unverified");
    expect(offVocabulary.verificationResult?.review.verdict).toBe("human-review");

    const valid = await admit([verifiedEntry(TARGET)]);
    expect(valid.verificationResult?.coverage[0]?.status).toBe("verified");
    expect(hostNotes(valid)).toEqual([]);
  });

  it("records verified with no admitted evidence as unverified", async () => {
    const result = await admit([verifiedEntry(TARGET, { evidence: [] })]);

    expect(result.verificationResult?.coverage[0]?.status).toBe("unverified");
    expect(hostNotes(result)).toHaveLength(1);
  });

  it("keeps a reason at the bound and truncates one past it", async () => {
    const bound = limitDefinition("technicalCorrection.coverageReasonMaxChars").value;
    const atBound = "r".repeat(bound);
    const overBound = "r".repeat(bound + 1);

    const kept = await admit([verifiedEntry(TARGET, { reason: atBound })]);
    expect(kept.verificationResult?.coverage[0]?.reason).toBe(atBound);
    expect(hostNotes(kept)).toEqual([]);

    const truncated = await admit([verifiedEntry(TARGET, { reason: overBound })]);
    expect(truncated.verificationResult?.coverage[0]?.reason).toHaveLength(bound);
    expect(hostNotes(truncated)).toHaveLength(1);
    expect(hostNotes(truncated)[0]).toContain("the host rewrote the offending member");
  });

  it("host-authors an empty reason instead of refusing it", async () => {
    const result = await admit([verifiedEntry(TARGET, { reason: "   " })]);

    expect(result.verificationResult?.coverage[0]?.reason).toContain("no usable reason");
    expect(hostNotes(result)).toHaveLength(1);
  });

  it("keeps an evidence list at the bound and drops the entry past it", async () => {
    const bound = limitDefinition("technicalCorrection.coverageEvidenceMaxEntries").value;
    const atBound = Array.from({ length: bound }, (_, index) => `README.md:${index + 1}`);
    const overBound = [...atBound, `README.md:${bound + 1}`];

    const kept = await admit([verifiedEntry(TARGET, { evidence: atBound })]);
    expect(kept.verificationResult?.coverage[0]?.evidence).toEqual(atBound);
    expect(hostNotes(kept)).toEqual([]);

    const trimmed = await admit([verifiedEntry(TARGET, { evidence: overBound })]);
    expect(trimmed.verificationResult?.coverage[0]?.evidence).toEqual(atBound);
    expect(hostNotes(trimmed)).toHaveLength(1);
  });

  it("truncates an evidence entry past its own bound and removes empties and duplicates", async () => {
    const bound = limitDefinition("technicalCorrection.coverageEvidenceEntryMaxChars").value;
    const long = `README.md:${"1".repeat(bound)}`;

    const result = await admit([
      verifiedEntry(TARGET, { evidence: [long, "README.md:1", "README.md:1", "  "] }),
    ]);

    // The derived result sorts each evidence list by code point.
    expect(result.verificationResult?.coverage[0]?.evidence).toEqual([
      "README.md:1",
      long.slice(0, bound),
    ]);
    expect(hostNotes(result)).toHaveLength(1);
  });

  it("keeps the first of two entries for the same page", async () => {
    const result = await admit([
      verifiedEntry(TARGET, { reason: "The first entry the reply wrote." }),
      verifiedEntry(TARGET, { reason: "The second entry the reply wrote." }),
    ]);

    expect(result.verificationResult?.coverage).toHaveLength(1);
    expect(result.verificationResult?.coverage[0]?.reason).toBe("The first entry the reply wrote.");
    expect(hostNotes(result)[0]).toContain(TARGET);
  });

  it("drops an unknown key and host-fills a missing required member", async () => {
    const result = await admit([
      { path: TARGET, status: "verified", evidence: ["README.md:1"], confidence: 0.9 },
    ]);

    expect(Object.keys(result.verificationResult!.coverage[0]!).sort()).toEqual([
      "evidence",
      "path",
      "reason",
      "status",
    ]);
    expect(result.verificationResult?.coverage[0]?.reason).toContain("no usable reason");
    expect(hostNotes(result)).toHaveLength(1);
  });

  it("refuses by name when the host notes overflow the limitations bound", async () => {
    // Bound and bound+1 on the catalog entry the host's own notes count against.
    // Three notes at once need two approved targets: one entry is removed, one
    // is rewritten, and one target is host-filled.
    const coverage = [
      verifiedEntry("docs/unrelated.md"),
      verifiedEntry(TARGET, { status: "partial" }),
    ];
    vi.stubEnv("DOCSFAB_FACT_INVENTORY_MAX_LIMITATIONS", "3");
    const atBound = await admit(coverage, [TARGET, OTHER_TARGET]);
    expect(hostNotes(atBound)).toHaveLength(3);

    // The step's decoder refuses the reply by name. Through the harness that
    // refusal is not retried, so step 4 tries the host floor, which carries its
    // own notes against the same bound.
    vi.stubEnv("DOCSFAB_FACT_INVENTORY_MAX_LIMITATIONS", "2");
    const repositoryPath = await createRepository();
    const { input, ledger, obligationId } = await sealedFixture(repositoryPath, [
      TARGET,
      OTHER_TARGET,
    ]);
    let error: unknown;
    try {
      decodeProvisionalVerificationJudgment(
        reply(obligationId, coverage),
        ledger,
        [TARGET, OTHER_TARGET],
        undefined,
        judgmentCoveragePolicy(input),
      );
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(InferenceStepError);
    expect((error as InferenceStepError).message).toContain(
      "Technical correction response rejected: bounds-exceeded.",
    );
    expect((error as InferenceStepError).message).toContain(
      "fact-inventory-max-limitations-bound: 3 limitations exceed factInventory.maxLimitations = 2",
    );
  });

  it("states the coverage ceilings and the whole-answer budget in both judgment contracts", async () => {
    const repositoryPath = await createRepository();
    const { input, admission, deriveInput } = await sealedFixture(repositoryPath);
    const correctionStep = getWorkflow("review-documentation").steps.find(
      (step) => step.id === "verify-technical-accuracy",
    )!;
    const correctionInput: HarnessStepInput = {
      ...input,
      step: correctionStep,
      runId: deriveInput.runId,
      originalSourceAuthorityAdmission: admission,
    };
    const expected = [
      `one coverage entry's reason is at most ${limitDefinition("technicalCorrection.coverageReasonMaxChars").value} characters`,
      `one coverage entry names at most ${limitDefinition("technicalCorrection.coverageEvidenceMaxEntries").value} evidence locators, each at most ${limitDefinition("technicalCorrection.coverageEvidenceEntryMaxChars").value} characters`,
      `the whole answer is at most ${judgmentAnswerCharBudget(BOUND_OUTPUT_TOKENS)} characters`,
    ];

    for (const prompt of [
      buildHostStepPrompt(input, "", BOUND_OUTPUT_TOKENS),
      buildHostStepPrompt(correctionInput, "", BOUND_OUTPUT_TOKENS),
    ]) {
      for (const line of expected) expect(prompt).toContain(line);
    }
    expect(judgmentAnswerCharBudget(BOUND_OUTPUT_TOKENS)).toBe(
      BOUND_OUTPUT_TOKENS *
        (1 + limitDefinition("inference.maxLengthStopContinuations").value) *
        limitDefinition("technicalCorrection.answerCharsPerOutputToken").value,
    );
  });

  it("moves the stated whole-answer budget with a catalog override", async () => {
    const repositoryPath = await createRepository();
    const { input } = await sealedFixture(repositoryPath);
    vi.stubEnv("DOCSFAB_TECHNICAL_CORRECTION_ANSWER_CHARS_PER_OUTPUT_TOKEN", "1");
    vi.stubEnv("DOCSFAB_INFERENCE_MAX_LENGTH_STOP_CONTINUATIONS", "0");

    expect(judgmentAnswerCharBudget(BOUND_OUTPUT_TOKENS)).toBe(BOUND_OUTPUT_TOKENS);
    expect(buildHostStepPrompt(input, "", BOUND_OUTPUT_TOKENS)).toContain(
      `the whole answer is at most ${BOUND_OUTPUT_TOKENS} characters`,
    );
  });

  it("states the bound composition's output limit, not the sealed registry ceiling", async () => {
    // `sealed.compositionLimits.maxOutputTokens` is the ceiling across registry
    // records and moves when any composition is registered, so a budget stated
    // from it would promise more characters than the bound composition allows.
    const repositoryPath = await createRepository();
    const { input } = await sealedFixture(repositoryPath);
    const ceiling = limitDefinition("sealed.compositionLimits.maxOutputTokens").value;
    // The two sources must differ, or this case proves nothing.
    expect(ceiling).not.toBe(BOUND_OUTPUT_TOKENS);

    expect(judgmentAnswerCharBudget(BOUND_OUTPUT_TOKENS)).toBe(131_072);
    const bound = buildHostStepPrompt(input, "", BOUND_OUTPUT_TOKENS);
    expect(bound).toContain("the whole answer is at most 131072 characters");
    expect(bound).not.toContain(
      `the whole answer is at most ${judgmentAnswerCharBudget(ceiling)} characters`,
    );
    // With no bound limit, the sentence is omitted rather than stated from the
    // ceiling.
    expect(buildHostStepPrompt(input)).not.toContain("the whole answer is at most");
  });

  it("decodes the recorded pilot judgment identically under both policies", async () => {
    // Real-reply positive control: a recorded, admitted judgment decodes byte
    // for byte the same with the degradation on as with it off.
    const recorded = recordedJudgmentFixture();
    const before = await recorded.decode(false);
    const after = await recorded.decode(true);

    expect(canonicalizeJsonEvidence(after as unknown as JsonEvidenceValue)).toBe(
      canonicalizeJsonEvidence(before as unknown as JsonEvidenceValue),
    );
    expect(
      after.factInventory.limitations.filter((entry) =>
        entry.startsWith(HOST_COVERAGE_DEGRADATION_STEM),
      ),
    ).toEqual([]);
  });

  it("resolves the degrading policy only for review-documentation", () => {
    expect(judgmentCoveragePolicy({ workflow: getWorkflow("review-documentation") })).toEqual({
      degradeCoverage: true,
    });
    for (const name of ["create-documentation", "update-documentation"] as const) {
      expect(judgmentCoveragePolicy({ workflow: getWorkflow(name) }).degradeCoverage).toBe(false);
    }
  });

  /** The recorded judgment and the ledger it was recorded against. */
  function recordedJudgmentFixture() {
    const read = (name: string): unknown =>
      JSON.parse(
        readFileSync(new URL(`./fixtures/review-cli-correction/${name}`, import.meta.url), "utf8"),
      );
    const ledgerFixture = read("recorded-ledger.json") as {
      ledgerProposal: SourceObligationLedgerProposalV1;
      repositoryRevision: string;
      sources: Array<{ path: string; sha256: string }>;
    };
    const judgment = read("recorded-judgment.json");
    const runId = "review-cli-1219";
    const targets = ["docs/quickstart.md"];
    const workflow = getWorkflow("review-documentation");
    const deriveInput: HarnessStepInput = {
      runId,
      repositoryPath: "/workspace",
      workflow,
      step: workflow.steps.find((step) => step.id === "derive-source-obligations")!,
      evidenceIdentity: { repositoryRevision: ledgerFixture.repositoryRevision },
      searchEvidence: searchStepEvidence({
        evidenceSha256: "b".repeat(64),
        workspaceSnapshotSha256: "c".repeat(64),
      }),
      reviewScope: {
        scope: "focused-set",
        reason: "operator-named",
        targetPaths: targets,
        deferredPaths: [],
        scopeSha256: "d".repeat(64),
        corpusFileCount: 3,
      },
    };
    const scopeSha256 = sourceObligationScopeSha256(deriveInput);
    const sealed = sealOriginalSourceAuthority({
      runId,
      scope: "review-tracked-workspace",
      repositoryRevision: ledgerFixture.repositoryRevision,
      scopeSha256,
      workspaceSnapshotSha256: "c".repeat(64),
      members: [
        {
          path: "src/sprout.mjs",
          mode: 0o755,
          byteLength: 1,
          sourceSha256: ledgerFixture.sources[0]!.sha256,
        },
      ],
    });
    const ledger = bindSourceObligationLedgerV2(
      ledgerFixture.ledgerProposal,
      deriveInput,
      ledgerFixture.sources,
      sealed.evidence,
    );
    return {
      decode: async (degradeCoverage: boolean) =>
        decodeProvisionalVerificationJudgment(
          canonicalizeJsonEvidence(judgment as JsonEvidenceValue),
          ledger,
          targets,
          undefined,
          { degradeCoverage },
        ),
    };
  }
});
