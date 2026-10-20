// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HarnessStepInput,
  SourceObligationLedgerProposalV1,
  TECHNICAL_FACT_DIMENSIONS,
  bindSourceObligationLedgerV2,
  createAuditHarness,
  createRepository,
  getWorkflow,
  issueOriginalSourceAuthorityAdmission,
  resetSharedTestState,
  reviewSourcePhaseInput,
  scriptedProvider,
  sealOriginalSourceAuthority,
  sourceObligationScopeSha256,
  textTurn,
  validModelConfig,
} from "./support/pi-harness-session-fixtures.js";
import { HOST_COVERAGE_DEGRADATION_STEM } from "../src/workflow-execution/judgment-coverage.js";
import { bindModelExecutionProfile } from "../src/model/configuration.js";
import { createModelEvidence } from "../src/model/profile-evidence.js";

afterEach(resetSharedTestState);

/**
 * When the sealed ledger admitted no source, the host marks the model's
 * coverage `unverified` regardless, so sending the judgment step to the model
 * spends attempts and output budget for nothing. These drive the real
 * `PiHarness.runStep` with a scripted provider that must never be called.
 */
describe("host-determined judgment for a sealed ledger that admitted no source", () => {
  const SOURCE_SHA256 = "f".repeat(64);

  /**
   * The sealed V2 ledger of a review that cited no source, as `runner.test.ts`
   * produces it: a whole directory cited as a locator, which the host cannot
   * read, so every dimension degrades to `unverified`, no obligation is issued,
   * and `identity.sources` is empty.
   */
  function zeroSourceProposal(): SourceObligationLedgerProposalV1 {
    return {
      completeness: "bounded-not-proven",
      dimensions: TECHNICAL_FACT_DIMENSIONS.map((dimension) => ({
        dimension,
        status: "not-applicable" as const,
        reason: `The changed page establishes no ${dimension} obligation.`,
        sourceLocators: ["docs"],
        obligations: [],
      })),
      limitations: [],
    };
  }

  /** One admitted source and no obligation: the adjacent ledger the short circuit must not handle. */
  function oneSourceProposal(): SourceObligationLedgerProposalV1 {
    return {
      completeness: "bounded-not-proven",
      dimensions: TECHNICAL_FACT_DIMENSIONS.map((dimension) => ({
        dimension,
        status: "not-applicable" as const,
        reason: `The focused source establishes no ${dimension} obligation.`,
        sourceLocators: ["README.md:1"],
        obligations: [],
      })),
      limitations: [],
    };
  }

  async function sealedLedger(
    repositoryPath: string,
    proposal: SourceObligationLedgerProposalV1,
    sources: ReadonlyArray<{ path: string; sha256: string }>,
    workflowName: "review-documentation" | "create-documentation" = "review-documentation",
  ) {
    const base = reviewSourcePhaseInput(repositoryPath, "derive-source-obligations");
    const deriveInput: HarnessStepInput =
      workflowName === "review-documentation"
        ? base
        : { ...base, workflow: getWorkflow("create-documentation") };
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
      // The authority seals the tracked workspace the run may read. It is not
      // the cited-source list: a run can seal a workspace and still cite
      // nothing, which is the case under test.
      members: [{ path: "README.md", mode: 0o644, byteLength: 10, sourceSha256: SOURCE_SHA256 }],
    });
    const ledger = bindSourceObligationLedgerV2(proposal, deriveInput, sources, sealed.evidence);
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
    return { deriveInput, ledger, admission };
  }

  /** A provider that fails the test if the step ever reaches it. */
  function forbiddenProvider() {
    const fetchMock = vi.fn(async () => {
      throw new Error("The zero-source judgment step opened a provider connection.");
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  function scripted(reply: string) {
    const provider = scriptedProvider([textTurn(reply)]);
    const fetchMock = vi.fn(provider);
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  /**
   * The model evidence the harness is bound to, exactly as
   * `PiHarness.runStep`'s session path projects it from the same profile.
   * A zero-turn step still records it: see the aggregate proof below.
   */
  const boundModelEvidence = () =>
    createModelEvidence(bindModelExecutionProfile(validModelConfig).profile);

  it("answers step 4 without a provider turn and records the host limitation", async () => {
    const repositoryPath = await createRepository();
    const { deriveInput, ledger } = await sealedLedger(repositoryPath, zeroSourceProposal(), []);
    expect(ledger.identity.sources).toEqual([]);
    const emitted: string[] = [];
    const input: HarnessStepInput = {
      ...reviewSourcePhaseInput(repositoryPath, "provisional-technical-verification"),
      runId: deriveInput.runId,
      sourceObligationLedger: ledger,
      onText: (text) => emitted.push(text),
    };
    const fetchMock = forbiddenProvider();

    const result = await (await createAuditHarness()).runStep(input);

    expect(fetchMock).not.toHaveBeenCalled();
    // The step ran under the run's bound model profile even though it spent no
    // provider turn, and the record says so: without this field the composition
    // execution aggregate fails `subject-mismatch` and the whole run dies at
    // the terminal seal (see the zero-source judgment aggregate test).
    expect(result.model).toEqual(boundModelEvidence());
    // The admitted answer is emitted once, as the session path emits it.
    expect(emitted).toEqual([result.summary]);
    expect(result.verificationResult?.review.verdict).toBe("human-review");
    expect(result.verificationResult?.coverage).toEqual([
      {
        path: "README.md",
        status: "unverified",
        evidence: [],
        reason: expect.stringContaining("admitted no source"),
      },
    ]);
    expect(
      result.verificationResult?.factInventory.limitations.filter((entry) =>
        entry.startsWith(HOST_COVERAGE_DEGRADATION_STEM),
      ),
    ).toHaveLength(1);
    // The step still records the governed skill it was verified against.
    expect(result.skill?.id).toBe("verify-technical-accuracy");
  });

  it("answers step 5 on the same ledger without a provider turn", async () => {
    const repositoryPath = await createRepository();
    const { deriveInput, ledger, admission } = await sealedLedger(
      repositoryPath,
      zeroSourceProposal(),
      [],
    );
    const emitted: string[] = [];
    const input: HarnessStepInput = {
      ...reviewSourcePhaseInput(repositoryPath, "verify-technical-accuracy"),
      runId: deriveInput.runId,
      sourceObligationLedger: ledger,
      originalSourceAuthorityAdmission: admission,
      onText: (text) => emitted.push(text),
    };
    const fetchMock = forbiddenProvider();

    const result = await (await createAuditHarness()).runStep(input);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.verificationResult?.review.verdict).toBe("human-review");
    expect(result.verificationResult?.coverage.map(({ status }) => status)).toEqual(["unverified"]);
    expect(result.technicalCorrectionEvidence?.schemaVersion).toBe(3);
    expect(result.model).toEqual(boundModelEvidence());
    // Both judgment steps emit the admitted answer, as the session path does.
    expect(emitted).toEqual([result.summary]);
  });

  it("still asks the model when the ledger admitted one source and issued no obligation", async () => {
    // The adjacent condition the short circuit must not handle: an admitted
    // source makes a coverage claim legitimately checkable, whatever the
    // obligation count. A short circuit keyed on zero obligations would cut
    // this run off from the model.
    const repositoryPath = await createRepository();
    const { deriveInput, ledger } = await sealedLedger(repositoryPath, oneSourceProposal(), [
      { path: "README.md", sha256: SOURCE_SHA256 },
    ]);
    expect(ledger.identity.sources).toHaveLength(1);
    expect(ledger.dimensions.flatMap(({ obligations }) => obligations)).toEqual([]);
    const emitted: string[] = [];
    const input: HarnessStepInput = {
      ...reviewSourcePhaseInput(repositoryPath, "provisional-technical-verification"),
      runId: deriveInput.runId,
      sourceObligationLedger: ledger,
      onText: (text) => emitted.push(text),
    };
    const fetchMock = scripted(
      JSON.stringify({
        verdict: "human-review",
        coverage: [
          {
            path: "README.md",
            status: "unverified",
            evidence: [],
            reason: "The page cites a behaviour the admitted source does not state.",
          },
        ],
        issueJudgments: [],
        obligationJudgments: [],
      }),
    );

    const result = await (await createAuditHarness()).runStep(input);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.verificationResult?.coverage[0]?.reason).toContain(
      "the admitted source does not state",
    );
    // Positive control for the emission: the session path still emits the
    // model-answered summary once, so the short circuit above adds no second
    // emission path and removes none.
    expect(emitted).toEqual([result.summary]);
  });

  it("still asks the model on create-documentation with the same zero-source ledger", async () => {
    // The adjacent workflow: create-documentation's coverage policy refuses
    // rather than degrades, so the short circuit, which authors unverified
    // coverage, must not fire there.
    const repositoryPath = await createRepository();
    const { deriveInput, ledger } = await sealedLedger(
      repositoryPath,
      zeroSourceProposal(),
      [],
      "create-documentation",
    );
    const createWorkflow = getWorkflow("create-documentation");
    const input: HarnessStepInput = {
      ...reviewSourcePhaseInput(repositoryPath, "provisional-technical-verification"),
      workflow: createWorkflow,
      step: createWorkflow.steps.find((step) => step.id === "provisional-technical-verification")!,
      runId: deriveInput.runId,
      sourceObligationLedger: ledger,
    };
    const fetchMock = scripted("{}");

    await expect((await createAuditHarness()).runStep(input)).rejects.toThrow();

    expect(fetchMock).toHaveBeenCalled();
  });
});
