// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { canonicalJson } from "../src/contract-kit/index.js";
import { sha256 } from "../src/content-ir/canonical.js";
import type { HarnessStepInput } from "../src/execution/contracts.js";
import { canonicalizeJsonEvidence } from "../src/json-evidence.js";
import type { JsonEvidenceValue } from "../src/json-evidence.js";
import {
  AUTHORING_CANDIDATE_KIND,
  assertAdmittedFactLocators,
  createAuthoringCandidate,
  createAuthoringRevisionInput,
  decodeAuthoringCandidate,
  selectAuthoringRevision,
  type AuthoringRevisionValidationContextV1,
  type AuthoringActionableTechnicalFactV1,
} from "../src/workflow-execution/authoring-candidate.js";
import type {
  ReviewResult,
  TechnicalFactDimension,
  VerificationResult,
} from "../src/workflow-execution/review-response.js";
import {
  bindSourceObligationLedger,
  bindSourceObligationLedgerV2,
  bindTechnicalCorrectionResponse,
  bindTechnicalCorrectionResponseV2,
  sourceObligationScopeSha256,
  type SourceObligationLedgerV1,
  type SourceObligationLedgerProposalV1,
  type TechnicalCorrectionEvidence,
} from "../src/workflow-execution/source-obligation.js";
import { documentationPlanBindingDigest } from "../src/workflow-execution/plan-binding.js";
import {
  issueOriginalSourceAuthorityAdmission,
  sealOriginalSourceAuthority,
} from "../src/workflow-execution/source-obligation-authority.js";
import { configureCredentialsForEachTest } from "./helpers/configured-credential.js";
import { searchStepEvidence } from "./helpers/search-evidence-fixture.js";

const REVISION = "a".repeat(40);
const PLAN = "b".repeat(64);
const PATCH = "c".repeat(64);
const SNAPSHOT = "d".repeat(64);
const SOURCE_SNAPSHOT = "e".repeat(64);
const TECHNICAL = "verify-technical-accuracy";
const EDITORIAL = "review-documentation";
const TARGET = "docs/guide.md";

// One of DocsFab's own configured credentials, set for each test, and a value
// with the same shape that is not configured (#1807).
const CONFIGURED_RUN_ID = ["glpat", "Hb4Nq8Rz2Kw6Tj9Lx3Pc7Vm5"].join("-");
const SHAPED_RUN_ID = ["glpat", "Yd3Fs7Gk1Mv5Qp9Wn2Rb6Tc8"].join("-");

function createCandidateWith(change: Partial<Parameters<typeof createAuthoringCandidate>[0]>) {
  return createAuthoringCandidate({
    runId: "run-123",
    ordinal: 0,
    originalRevision: REVISION,
    planDigest: PLAN,
    writePaths: [TARGET],
    patchDigestSha256: PATCH,
    patchBytes: 12,
    workspaceSnapshotDigest: SNAPSHOT,
    ...change,
  });
}

describe("authoring candidate contracts", () => {
  configureCredentialsForEachTest(CONFIGURED_RUN_ID);

  it("seals an immutable candidate with sorted paths and only patch metadata", () => {
    const candidate = createAuthoringCandidate({
      runId: "run-123",
      ordinal: 0,
      originalRevision: REVISION,
      planDigest: PLAN,
      writePaths: [TARGET, "docs/api.md"],
      patchDigestSha256: PATCH,
      patchBytes: 1234,
      workspaceSnapshotDigest: SNAPSHOT,
    });

    expect(candidate).toMatchObject({
      schemaVersion: 1,
      kind: AUTHORING_CANDIDATE_KIND,
      writePaths: ["docs/api.md", TARGET],
      patchDigestSha256: PATCH,
      patchBytes: 1234,
    });
    expect(Object.isFrozen(candidate)).toBe(true);
    expect(() => decodeAuthoringCandidate(candidate)).not.toThrow();
    expect(canonicalJson(candidate)).not.toContain("patch text");
  });

  it.each([
    ["private host path", { writePaths: ["/Users/alice/docs.md"] }],
    ["configured-credential run id", { runId: CONFIGURED_RUN_ID }],
    ["negative byte count", { patchBytes: -1 }],
  ])("rejects %s", (_name, change) => {
    expect(() => createCandidateWith(change)).toThrow();
  });

  it("refuses only a configured credential, and admits a credential shape (#1807)", () => {
    // A run id holding one of DocsFab's own configured credentials keeps the
    // fixed credential code. A credential shape that is not configured is
    // just an identifier: the decoder admits it.
    expect(() => createCandidateWith({ runId: CONFIGURED_RUN_ID })).toThrow(
      expect.objectContaining({ code: "credential-material" }),
    );
    expect(createCandidateWith({ runId: SHAPED_RUN_ID }).runId).toBe(SHAPED_RUN_ID);
  });

  it("derives one revision input from every admitted omission or conflict", () => {
    const context = makeContext({ actionable: true });
    const selection = selectAuthoringRevision(context);
    expect(selection.kind).toBe("revise");
    if (selection.kind !== "revise") return;
    expect(selection.input.actionableFacts).toHaveLength(1);
    expect(selection.input.actionableFacts[0]).toMatchObject({
      id: "FACT-001",
      documentationDisposition: "omitted",
      statement: "The page omits the required source-backed behavior.",
      issueIds: ["TECH-001"],
    });
  });

  it("returns retain only for valid current evidence without actionable facts", () => {
    const result = makeTechnicalResult("documented");
    const context = makeContext({ technicalResult: result });
    expect(selectAuthoringRevision(context)).toEqual({ kind: "retain", reason: "no-actionable" });
  });

  it.each([
    "unsupported workaround",
    "style preference",
    "missing support policy",
    "product defect advice",
    "source-unbound proposal",
  ])("does not grant direct revision authority to editorial-only %s", (editorialText) => {
    const context = makeContext({
      technicalResult: makeTechnicalResult("documented"),
      editorialText,
    });

    expect(selectAuthoringRevision(context)).toEqual({ kind: "retain", reason: "no-actionable" });
  });

  it("accepts distinct original source and candidate workspace snapshots", () => {
    const context = makeContext({ actionable: true });
    expect(context.sourceObligationInput.searchEvidence?.workspaceSnapshotSha256).toBe(
      SOURCE_SNAPSHOT,
    );
    expect(context.candidate0.workspaceSnapshotDigest).toBe(SNAPSHOT);
    expect(() => selectAuthoringRevision(context)).not.toThrow();
  });

  it.each(["technical", "editorial"] as const)(
    "admits canonical %s summary JSON whose semantic text contains quotes and a newline",
    (producer) => {
      const text = 'The generic example calls setValue("")\nand then continues.';
      const context = makeContext({ actionable: true, [`${producer}Text`]: text });

      expect(context[producer].summary).toContain('\\"\\"');
      expect(context[producer].summary).toContain("\\n");
      expect(selectAuthoringRevision(context).kind).toBe("revise");
    },
  );

  it.each(
    (["technical", "editorial"] as const).flatMap((producer) =>
      [
        "/Users/alice/private.md",
        "file:///tmp/private.md",
        "C:\\private\\file.md",
        "value\\with-backslash",
      ].map((text) => [producer, text] as const),
    ),
  )("admits a path cited in decoded %s result text: %s", (producer, text) => {
    const context =
      producer === "technical"
        ? makeContext({ actionable: true, technicalText: text })
        : makeContext({ actionable: true, editorialText: text });

    expect(selectAuthoringRevision(context).kind).toBe("revise");
  });

  it.each(["technical", "editorial"] as const)(
    "rejects %s summary, result, and digest mismatches before selection",
    (producer) => {
      const context = makeContext({ actionable: true });
      expect(() =>
        selectAuthoringRevision({
          ...context,
          [producer]: { ...context[producer], summary: "{}" },
        }),
      ).toThrowError(expect.objectContaining({ code: "stale-evidence" }));

      const result = structuredClone(context[producer].result);
      if (producer === "technical") {
        result.coverage[0]!.reason = "A different safe coverage reason.";
      } else {
        result.verdict = "human-review";
      }
      expect(() =>
        selectAuthoringRevision({
          ...context,
          [producer]: { ...context[producer], result },
        }),
      ).toThrowError(expect.objectContaining({ code: "stale-evidence" }));

      expect(() =>
        selectAuthoringRevision({
          ...context,
          [producer]: { ...context[producer], summaryDigest: "f".repeat(64) },
        }),
      ).toThrowError(expect.objectContaining({ code: "stale-evidence" }));
    },
  );

  it.each(["technical", "editorial"] as const)(
    "keeps %s summary presence and inert-data checks",
    (producer) => {
      const context = makeContext({ actionable: true });
      const missing = structuredClone(context[producer]) as Record<string, unknown>;
      delete missing.summary;
      expect(() => selectAuthoringRevision({ ...context, [producer]: missing })).toThrow();

      let reads = 0;
      const accessor = { ...context[producer] };
      Object.defineProperty(accessor, "summary", {
        enumerable: true,
        get: () => {
          reads += 1;
          return context[producer].summary;
        },
      });
      expect(() => selectAuthoringRevision({ ...context, [producer]: accessor })).toThrow();
      expect(reads).toBe(0);
    },
  );

  it("rejects forged fact fields, stale bindings, and incomplete technical coverage", () => {
    const context = makeContext({ actionable: true });
    const selection = selectAuthoringRevision(context);
    expect(selection.kind).toBe("revise");
    if (selection.kind !== "revise") return;

    const forged = {
      ...selection.input,
      actionableFacts: [
        { ...selection.input.actionableFacts[0]!, statement: "A forged replacement statement." },
      ],
    };
    expect(() => createAuthoringRevisionInput(forged, context)).toThrow();

    const stale = { ...selection.input, planDigest: "e".repeat(64) };
    expect(() => createAuthoringRevisionInput(stale, context)).toThrow();

    const unverified = makeContext({
      technicalResult: makeTechnicalResult("omitted", "unverified"),
    });
    expect(() => selectAuthoringRevision(unverified)).toThrowError(
      expect.objectContaining({
        name: "AuthoringCandidateContractError",
        code: "unverified-coverage",
        message: "Authoring candidate contract rejected: unverified-coverage.",
      }),
    );
  });

  it("rejects a caller input that drops a qualifying fact", () => {
    const context = makeContext({ actionable: true });
    const selection = selectAuthoringRevision(context);
    if (selection.kind !== "revise") throw new Error("fixture did not qualify");
    const dropped = { ...selection.input, actionableFacts: [] };
    expect(() => selectAuthoringRevision(dropped, context)).toThrow();
  });

  it("rejects swapped or stale source evidence before selecting a revision", () => {
    const context = makeContext({ actionable: true });
    const swappedInput = {
      ...context.sourceObligationInput,
      searchEvidence: {
        ...context.sourceObligationInput.searchEvidence,
        evidenceSha256: "a".repeat(64),
      },
    } as AuthoringRevisionValidationContextV1["sourceObligationInput"];
    const swapped = {
      ...context,
      sourceObligationInput: swappedInput,
      sourceObligationLedger: makeLedger(swappedInput),
    };
    expect(() => selectAuthoringRevision(swapped)).toThrow();

    const staleInput = {
      ...context.sourceObligationInput,
      evidenceIdentity: { repositoryRevision: "e".repeat(40) },
    } as AuthoringRevisionValidationContextV1["sourceObligationInput"];
    const stale = { ...context, sourceObligationInput: staleInput };
    expect(() => selectAuthoringRevision(stale)).toThrow();

    const staleScopePlan = {
      ...context.sourceObligationInput.planBinding!,
      pages: [{ path: "docs/other.md", disposition: "create" as const }],
      sourceBindings: [{ pagePath: "docs/other.md", sources: ["src/contract.ts"] }],
    };
    const staleScope = {
      ...context,
      sourceObligationInput: {
        ...context.sourceObligationInput,
        planBinding: {
          ...staleScopePlan,
          digest: context.sourceObligationInput.planBinding!.digest,
        },
      },
    };
    expect(() => selectAuthoringRevision(staleScope)).toThrow();

    const forgedResult = makeTechnicalResult("omitted");
    forgedResult.factInventory.dimensions[0]!.facts[0]!.sourceLocators = ["src/other.ts:10-20"];
    const forged = {
      ...context,
      technical: { ...context.technical, result: forgedResult },
    };
    expect(() => selectAuthoringRevision(forged)).toThrow();
  });

  it("requires canonical producers and preserves a new admitted source-backed fact", () => {
    const wrongProducer = makeContext({ actionable: true });
    const wrongProducerContext = {
      ...wrongProducer,
      technical: {
        ...wrongProducer.technical,
        producerId: "verify-technical-accuracy:create:0",
      },
    };
    expect(() => selectAuthoringRevision(wrongProducerContext)).toThrow();

    const wrongCandidateSnapshot = {
      ...wrongProducer,
      editorial: {
        ...wrongProducer.editorial,
        workspaceSnapshotDigest: SOURCE_SNAPSHOT,
      },
    };
    expect(() => selectAuthoringRevision(wrongCandidateSnapshot)).toThrow();

    const context = makeContext({ actionable: true, additionalFact: true });
    const selection = selectAuthoringRevision(context);
    expect(selection.kind).toBe("revise");
    if (selection.kind === "revise") {
      expect(selection.input.actionableFacts.map((fact) => fact.id)).toEqual([
        "FACT-001",
        "FACT-002",
      ]);
    }
  });

  it("uses retained V2 authority through revision selection and rejects missing or mismatched evidence", async () => {
    const context = await makeV2Context();
    expect(selectAuthoringRevision(context).kind).toBe("revise");
    expect(() =>
      selectAuthoringRevision({ ...context, originalSourceAuthority: undefined }),
    ).toThrow();
    const mismatched = sealOriginalSourceAuthority({
      runId: "run-123",
      scope: "create-plan-sources",
      repositoryRevision: REVISION,
      scopeSha256: context.sourceObligationLedger.identity.scopeSha256,
      workspaceSnapshotSha256: SOURCE_SNAPSHOT,
      members: [
        { path: "src/contract.ts", mode: 0o644, byteLength: 1, sourceSha256: "f".repeat(64) },
      ],
    });
    expect(() =>
      selectAuthoringRevision({ ...context, originalSourceAuthority: mismatched.evidence }),
    ).toThrow();
  });

  it("requires V4 actionable fact locators in final source checks rather than ledger inventory", async () => {
    const context = await makeV2Context(true);
    const ledger = context.sourceObligationLedger;
    expect(ledger.schemaVersion).toBe(2);
    if (ledger.schemaVersion !== 2) throw new Error("The authority fixture requires a V2 ledger.");
    expect(ledger.identity.sources.map((source) => source.path)).toContain("src/extra.ts");
    expect(context.technical.result.factInventory.dimensions[0]?.facts[0]?.sourceLocators).toEqual([
      "src/extra.ts:1",
    ]);
    const checkedOnlyContract = {
      ...context.technicalCorrectionEvidence,
      sourceChecks: [{ path: "src/contract.ts", sourceSha256: "f".repeat(64) }],
    };
    const v4 = {
      ...checkedOnlyContract,
      schemaVersion: 4,
    } as unknown as TechnicalCorrectionEvidence;
    const v3 = {
      ...checkedOnlyContract,
      schemaVersion: 3,
    } as unknown as TechnicalCorrectionEvidence;
    expect(() => assertAdmittedFactLocators(context.technical.result, ledger, v4)).toThrow(
      expect.objectContaining({ code: "invalid-evidence" }),
    );
    expect(() => assertAdmittedFactLocators(context.technical.result, ledger, v3)).toThrow(
      expect.objectContaining({ code: "invalid-evidence" }),
    );
    expect(() =>
      assertAdmittedFactLocators(
        context.technical.result,
        ledger,
        context.technicalCorrectionEvidence,
      ),
    ).not.toThrow();
  });
});

async function makeV2Context(
  ledgerIncludesExtra = false,
): Promise<AuthoringRevisionValidationContextV1> {
  const base = makeContext({ actionable: true });
  const pages = [{ path: TARGET, disposition: "create" as const }];
  const sourceBindings = [{ pagePath: TARGET, sources: ["src/contract.ts", "src/extra.ts"] }];
  const planBinding = {
    kind: "docsfab-documentation-plan" as const,
    schemaVersion: 1 as const,
    mode: "create" as const,
    pages,
    sourceBindings,
    digest: documentationPlanBindingDigest({ mode: "create", pages, sourceBindings }),
  };
  const input = { ...base.sourceObligationInput, planBinding };
  const technicalResult = makeTechnicalResult("omitted");
  technicalResult.factInventory.dimensions[0]!.facts[0]!.sourceLocators = ["src/extra.ts:1"];
  const proposal = makeLedgerProposal();
  const scopeSha256 = sourceObligationScopeSha256(input);
  const sealed = sealOriginalSourceAuthority({
    runId: "run-123",
    scope: "create-plan-sources",
    repositoryRevision: REVISION,
    scopeSha256,
    workspaceSnapshotSha256: SOURCE_SNAPSHOT,
    members: [
      { path: "src/contract.ts", mode: 0o644, byteLength: 1, sourceSha256: "f".repeat(64) },
      { path: "src/extra.ts", mode: 0o644, byteLength: 1, sourceSha256: "a".repeat(64) },
    ],
  });
  const ledger = bindSourceObligationLedgerV2(
    proposal,
    input,
    [
      { path: "src/contract.ts", sha256: "f".repeat(64) },
      ...(ledgerIncludesExtra ? [{ path: "src/extra.ts", sha256: "a".repeat(64) }] : []),
    ],
    sealed.evidence,
  );
  const observer = {
    observe: async (paths: readonly string[]) =>
      paths.map((path) => ({
        path,
        sha256: path === "src/extra.ts" ? "a".repeat(64) : "f".repeat(64),
      })),
  };
  const admission = issueOriginalSourceAuthorityAdmission({
    capture: sealed.capture,
    observer,
    runId: "run-123",
    repositoryRevision: REVISION,
    scopeSha256,
    workspaceSnapshotSha256: SOURCE_SNAPSHOT,
  });
  const correction = await bindTechnicalCorrectionResponseV2(
    { verificationResult: technicalResult, obligationAccounting: [] },
    ledger,
    admission,
    "run-123",
    (value) => value as VerificationResult,
  );
  const candidate0 = createAuthoringCandidate({
    runId: "run-123",
    ordinal: 0,
    originalRevision: REVISION,
    planDigest: planBinding.digest,
    writePaths: [TARGET],
    patchDigestSha256: PATCH,
    patchBytes: 12,
    workspaceSnapshotDigest: SNAPSHOT,
  });
  const technicalSummary = canonicalizeJsonEvidence(
    correction.verificationResult as unknown as JsonEvidenceValue,
  ).trimEnd();
  return {
    ...base,
    candidate0,
    planDigest: planBinding.digest,
    sourceObligationInput: input,
    sourceObligationLedger: ledger,
    technicalCorrectionEvidence: correction.evidence,
    originalSourceAuthority: sealed.evidence,
    technical: {
      ...base.technical,
      summary: technicalSummary,
      summaryDigest: sha256(technicalSummary),
      candidateDigest: candidate0.digest,
      result: correction.verificationResult,
    },
    editorial: { ...base.editorial, candidateDigest: candidate0.digest },
  };
}

function makeContext(
  options: {
    actionable?: boolean;
    additionalFact?: boolean;
    technicalResult?: VerificationResult;
    technicalText?: string;
    editorialText?: string;
  } = {},
): AuthoringRevisionValidationContextV1 {
  const technicalResult =
    options.technicalResult ?? makeTechnicalResult(options.actionable ? "omitted" : "documented");
  if (options.additionalFact) addAdditionalFact(technicalResult);
  if (options.technicalText) {
    technicalResult.factInventory.dimensions[0]!.facts[0]!.uncertainty = options.technicalText;
  }
  const editorialResult: ReviewResult = options.editorialText
    ? {
        verdict: "needs-revision",
        issues: [
          {
            id: "STYLE-001",
            severity: "minor",
            category: "style_compliance",
            location: TARGET,
            finding: options.editorialText,
            evidence: { source_id: "source", locator: "src/contract.ts:10-20" },
            required_change: "Clarify the generic example.",
          },
        ],
      }
    : { verdict: "pass", issues: [] };
  const sourceObligationInput = makeSourceObligationInput();
  const planDigest = sourceObligationInput.planBinding!.digest;
  const candidate0 = createAuthoringCandidate({
    runId: "run-123",
    ordinal: 0,
    originalRevision: REVISION,
    planDigest,
    writePaths: [TARGET],
    patchDigestSha256: PATCH,
    patchBytes: 12,
    workspaceSnapshotDigest: SNAPSHOT,
  });
  const ledger = makeLedger(sourceObligationInput);
  const correction = bindTechnicalCorrectionResponse(
    { verificationResult: technicalResult, obligationAccounting: [] },
    ledger,
    (value) => value as VerificationResult,
  );
  const admittedTechnicalResult = correction.verificationResult;
  const technicalSummary = canonicalizeJsonEvidence(
    admittedTechnicalResult as unknown as JsonEvidenceValue,
  ).trimEnd();
  const editorialSummary = canonicalizeJsonEvidence(
    editorialResult as unknown as JsonEvidenceValue,
  ).trimEnd();
  return {
    candidate0,
    originalRevision: REVISION,
    planDigest,
    writePaths: [TARGET],
    technical: {
      summary: technicalSummary,
      summaryDigest: sha256(technicalSummary),
      producerId: TECHNICAL,
      candidateDigest: candidate0.digest,
      candidateOrdinal: 0,
      workspaceSnapshotDigest: SNAPSHOT,
      result: admittedTechnicalResult,
    },
    editorial: {
      summary: editorialSummary,
      summaryDigest: sha256(editorialSummary),
      producerId: EDITORIAL,
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

function addAdditionalFact(result: VerificationResult): void {
  const input = result.factInventory.dimensions.find(
    (dimension) => dimension.dimension === "input-representations",
  )!;
  input.facts.push({
    id: "FACT-002",
    dimension: "input-representations",
    sourceLocators: ["src/contract.ts:30-40"],
    statement: "A second source-backed prerequisite is omitted.",
    documentationDisposition: "omitted",
    uncertainty: "The supplied source snapshot bounds this observation.",
    issueIds: ["TECH-002"],
  });
  input.facts.sort((left, right) => left.id.localeCompare(right.id));
  input.facts[0]!.issueIds.push("TECH-002");
  result.review.issues.push({
    id: "TECH-002",
    severity: "major",
    category: "technical_accuracy",
    location: TARGET,
    finding: "A second required behavior is omitted.",
    evidence: { source_id: "source", locator: "src/contract.ts:30-40" },
    required_change: "Document the second source-backed behavior.",
  });
}

function makeSourceObligationInput(): AuthoringRevisionValidationContextV1["sourceObligationInput"] {
  const pages = [{ path: TARGET, disposition: "create" as const }];
  const sourceBindings = [{ pagePath: TARGET, sources: ["src/contract.ts"] }];
  const planBinding = {
    kind: "docsfab-documentation-plan" as const,
    schemaVersion: 1 as const,
    mode: "create" as const,
    pages,
    sourceBindings,
    digest: documentationPlanBindingDigest({ mode: "create", pages, sourceBindings }),
  };
  return {
    workflow: {
      name: "create-documentation",
      steps: [],
    } as unknown as HarnessStepInput["workflow"],
    evidenceIdentity: { repositoryRevision: REVISION } as HarnessStepInput["evidenceIdentity"],
    searchEvidence: searchStepEvidence({
      evidenceSha256: "e".repeat(64),
      workspaceSnapshotSha256: SOURCE_SNAPSHOT,
    }),
    planBinding,
  };
}

function makeLedger(
  input: AuthoringRevisionValidationContextV1["sourceObligationInput"],
): SourceObligationLedgerV1 {
  const proposal = makeLedgerProposal();
  return bindSourceObligationLedger(proposal, input, [
    { path: "src/contract.ts", sha256: "f".repeat(64) },
  ]);
}

function makeLedgerProposal(): SourceObligationLedgerProposalV1 {
  const dimensions = [
    "input-representations",
    "defaults-and-overrides",
    "mutable-state",
    "destination-and-trust",
    "error-status-retry",
    "environment-prerequisite",
  ] as const;
  const proposal: SourceObligationLedgerProposalV1 = {
    completeness: "bounded-not-proven",
    dimensions: dimensions.map((dimension) => ({
      dimension,
      status: "not-applicable",
      reason: "The source fixture has no obligation in this dimension.",
      sourceLocators: ["src/contract.ts:10-20"],
      obligations: [],
    })),
    limitations: [],
  };
  return proposal;
}

function makeTechnicalResult(
  disposition: "documented" | "omitted",
  coverageStatus: "verified" | "unverified" = "verified",
): VerificationResult {
  const fact: AuthoringActionableTechnicalFactV1 = {
    id: "FACT-001",
    dimension: "input-representations",
    sourceLocators: ["src/contract.ts:10-20"],
    statement:
      disposition === "omitted"
        ? "The page omits the required source-backed behavior."
        : "The page documents the required source-backed behavior.",
    documentationDisposition: disposition,
    uncertainty: "The supplied source snapshot bounds this observation.",
    issueIds: disposition === "omitted" ? ["TECH-001"] : [],
  };
  const dimensions: VerificationResult["factInventory"]["dimensions"] = [
    {
      dimension: "input-representations",
      status: "applicable",
      reason: "Inputs are in scope.",
      sourceLocators: [],
      facts: [fact],
    },
    ...(
      [
        "defaults-and-overrides",
        "mutable-state",
        "destination-and-trust",
        "error-status-retry",
        "environment-prerequisite",
      ] as TechnicalFactDimension[]
    ).map((dimension) => ({
      dimension,
      status: "not-applicable" as const,
      reason: "The source contract has no claim in this dimension.",
      sourceLocators: ["src/contract.ts:10-20"],
      facts: [],
    })),
  ];
  return {
    review: {
      verdict:
        coverageStatus === "unverified"
          ? "human-review"
          : disposition === "omitted"
            ? "needs-revision"
            : "pass",
      issues:
        disposition === "omitted"
          ? [
              {
                id: "TECH-001",
                severity: "major",
                category: "technical_accuracy",
                location: TARGET,
                finding: "The required behavior is omitted.",
                evidence: { source_id: "source", locator: "src/contract.ts:10-20" },
                required_change: "Document the source-backed behavior.",
              },
            ]
          : [],
    },
    coverage: [
      {
        path: TARGET,
        status: coverageStatus,
        evidence: ["src/contract.ts:10-20"],
        reason: "The planned page was checked.",
      },
    ],
    factInventory: {
      completeness: "bounded-not-proven",
      dimensions,
      limitations: coverageStatus === "unverified" ? ["Evidence is unavailable."] : [],
    },
  };
}
