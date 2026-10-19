// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { OUTPUT_RULES, type OutputRuleDeclaration } from "../src/contracts/model-output.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { limit } from "../src/config/limits.js";
import { canonicalDigest } from "../src/content-ir/canonical.js";
import { CONTRACT_MAX_STRING_CHARS } from "../src/contract-kit/index.js";
import { InferenceStepError, type HarnessStepInput } from "../src/execution/contracts.js";
import type { JsonEvidenceErrorCode } from "../src/json-evidence.js";
import { admitAuthorizedTrackedWrites } from "../src/repository/workspace/tracked-read.js";
import { prepareRepositoryWorkspace } from "../src/repository/workspace/materialize.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import type { WorkflowDefinition, WorkflowStep } from "../src/workflow-contracts/contracts.js";
import { documentationPlanBindingDigest } from "../src/workflow-execution/plan-binding.js";
import { validateVerificationResult } from "../src/workflow-execution/review-response.js";
import {
  executeInferenceStep,
  type InferenceStepExecution,
} from "../src/workflow-execution/retry.js";
import { migrateLegacyInferenceAttemptEvidence } from "../src/execution/lease-contracts.js";
import {
  isRetainableInferenceRejection,
  MAX_INFERENCE_REJECTION_REASON_LENGTH,
  MAX_INFERENCE_REJECTION_SEGMENT_LENGTH,
  retainedInferenceRejection,
  UNRETAINABLE_INFERENCE_REJECTIONS,
} from "../src/config/inference-rejection-limits.js";
import { formatRunFailureDiagnosticLines } from "../src/operator/run-summary.js";
import { formatStepRejectionSentence } from "../src/operator/retry-disposition.js";
import {
  isLegacyHostPathDisclosure,
  type InferenceAttemptEvidence,
  type RunRecord,
} from "../src/records/contracts.js";
import { projectRunIndexRows } from "../src/records/run-index.js";
import { admitJudgmentReply } from "../src/harness/reply-admission/judgment.js";
import {
  assertSourceObligationPhaseContract,
  assertSourceObligationSourceAuthority,
  bindSourceObligationLedger,
  bindSourceObligationLedgerV2,
  bindSourceObligationResponseContract,
  bindTechnicalCorrectionResponse,
  bindTechnicalCorrectionResponseV2,
  canonicalSourceObligationProposal,
  decodeSourceObligationResponse,
  decodeTechnicalCorrectionResponse,
  decodeTechnicalCorrectionResponseV2,
  hasInventoryBeforeWrite,
  hasSourceObligationPhases,
  isCanonicalTechnicalAdmission,
  isProvisionalTechnicalVerification,
  projectSourceObligationRejection,
  rejectSourceObligationKit,
  requiresSourceObligationLedger,
  sourceObligationRejectionFromMessage,
  sourceObligationRejectionMessage,
  SOURCE_OBLIGATION_CATALOG_CODES,
  SOURCE_OBLIGATION_DIMENSION_KEYS,
  SOURCE_OBLIGATION_KEYS,
  SOURCE_OBLIGATION_PROPOSAL_KEYS,
  SOURCE_OBLIGATION_RESPONSE_CONTRACT,
  SOURCE_OBLIGATION_REJECTION_CODES,
  SOURCE_OBLIGATION_REJECTION_ERROR,
  SOURCE_OBLIGATION_REJECTION_LOCATIONS,
  type SourceObligationRejectionCode,
  type SourceObligationRecordedCode,
  type SourceObligationRejectionLocation,
  requiresTechnicalCorrection,
  sourceObligationLocatorPaths,
  wrapSourceObligationFailure,
  sourceObligationScopeSha256,
  validateSourceObligationLedger,
  validateSourceObligationProposal,
  validateTechnicalCorrectionEvidence,
  SourceObligationSourceReferenceError,
  type SourceObligationLedgerProposalV1,
} from "../src/workflow-execution/source-obligation.js";
import { LocalSourceObligationSourceObserver } from "../src/workflow-execution/source-obligation-observer.js";
import {
  issueOriginalSourceAuthorityAdmission,
  sealOriginalSourceAuthority,
} from "../src/workflow-execution/source-obligation-authority.js";
import {
  sourceObligationProposalFixture,
  verificationResultFixture,
} from "./helpers/verification.js";
import { initFixtureRepo } from "./helpers/git.js";
import { searchStepEvidence } from "./helpers/search-evidence-fixture.js";
import { configureCredentialsForEachTest } from "./helpers/configured-credential.js";

// Configured for every test: only a configured credential is refused (#1807).
configureCredentialsForEachTest(`glpat-${"x".repeat(24)}`, `glpat-${"A1b2C3d4E5f6G7h8J9k0"}`);

describe("source-obligation unit contracts", () => {
  it("recognizes only complete ordered CREATE and REVIEW phase sets", () => {
    const create = createWorkflow();
    const review = reviewWorkflow();
    for (const workflow of [create, review]) {
      expect(assertSourceObligationPhaseContract(workflow)).toBe(true);
      expect(hasSourceObligationPhases(workflow)).toBe(true);
      const derive = workflow.steps.find((step) => step.id === "derive-source-obligations")!;
      const provisional = workflow.steps.find(
        (step) => step.id === "provisional-technical-verification",
      )!;
      const final = workflow.steps.find((step) => step.id === "verify-technical-accuracy")!;
      expect(derive.skill).toBe("verify-technical-accuracy");
      expect(requiresSourceObligationLedger({ workflow, step: derive })).toBe(true);
      expect(isProvisionalTechnicalVerification({ workflow, step: derive })).toBe(false);
      expect(isCanonicalTechnicalAdmission({ workflow, step: derive })).toBe(false);
      expect(isProvisionalTechnicalVerification({ workflow, step: provisional })).toBe(true);
      expect(isCanonicalTechnicalAdmission({ workflow, step: final })).toBe(true);
      expect(requiresTechnicalCorrection({ workflow, step: final })).toBe(true);
      expect(
        bindSourceObligationResponseContract({
          repositoryPath: "/workspace",
          workflow,
          step: derive,
        }).step.prompt,
      ).toContain("Runtime source-obligation response contract");
      expect(
        bindSourceObligationResponseContract({
          repositoryPath: "/workspace",
          workflow,
          step: final,
        }).step.prompt,
      ).toContain("Runtime semantic technical-correction response contract");
    }

    const historical = historicalCreateWorkflow();
    expect(assertSourceObligationPhaseContract(historical)).toBe(false);
    expect(
      assertSourceObligationPhaseContract(historicalCreateWorkflowWithRetiredCatalogDerive()),
    ).toBe(false);
    const historicalFinal = historical.steps.find(
      (step) => step.id === "verify-technical-accuracy",
    )!;
    expect(requiresTechnicalCorrection({ workflow: historical, step: historicalFinal })).toBe(
      false,
    );
    expect(
      bindSourceObligationResponseContract({
        repositoryPath: "/workspace",
        workflow: historical,
        step: historicalFinal,
      }),
    ).toEqual({ repositoryPath: "/workspace", workflow: historical, step: historicalFinal });

    const retiredCatalogDerive = {
      ...create,
      steps: create.steps.map((step) =>
        step.id === "derive-source-obligations"
          ? { ...step, skill: "derive-source-obligations" }
          : step,
      ),
    } satisfies WorkflowDefinition;
    expect(assertSourceObligationPhaseContract(retiredCatalogDerive)).toBe(false);

    const partial = {
      ...create,
      steps: create.steps.filter((step) => step.id !== "provisional-technical-verification"),
    } satisfies WorkflowDefinition;
    const writer = create.steps.find((step) => step.id === "write-documentation")!;
    const malformed = [
      partial,
      { ...create, steps: [...create.steps.filter((step) => step !== writer), writer] },
      { ...create, steps: [...create.steps, writer] },
      {
        ...create,
        steps: create.steps.map((step) =>
          step.id === "derive-source-obligations" ? { ...step, mode: "write" as const } : step,
        ),
      },
      {
        ...create,
        steps: create.steps.map((step) =>
          step.id === "provisional-technical-verification"
            ? { ...step, kind: "inference" as const }
            : step,
        ),
      },
      {
        ...create,
        steps: [
          ...create.steps,
          phase("post-verification-write", "write-documentation", "inference", "write"),
        ],
      },
      {
        ...review,
        steps: review.steps.map((step) =>
          step.id === "audit-documentation" ? { ...step, mode: "write" as const } : step,
        ),
      },
    ] satisfies WorkflowDefinition[];
    for (const workflow of malformed) {
      expect(() => assertSourceObligationPhaseContract(workflow)).toThrow(
        "incomplete or misordered source-obligation phase set",
      );
    }
  });

  it("binds inventory-only verify before write on update and restructure without the create dual-verify pair", () => {
    const update = getWorkflow("update-documentation");
    const restructure = getWorkflow("restructure-documentation");
    for (const workflow of [update, restructure]) {
      const derive = workflow.steps.find((step) => step.id === "derive-source-obligations")!;
      const writer = workflow.steps.find((step) => step.id === "write-documentation")!;
      const verify = workflow.steps.find((step) => step.id === "verify-technical-accuracy")!;
      expect(assertSourceObligationPhaseContract(workflow)).toBe(false);
      expect(hasSourceObligationPhases(workflow)).toBe(false);
      expect(hasInventoryBeforeWrite(workflow)).toBe(true);
      expect(workflow.steps.indexOf(derive)).toBeLessThan(workflow.steps.indexOf(writer));
      expect(derive.skill).toBe("verify-technical-accuracy");
      expect(requiresSourceObligationLedger({ workflow, step: derive })).toBe(true);
      expect(isProvisionalTechnicalVerification({ workflow, step: derive })).toBe(false);
      expect(requiresTechnicalCorrection({ workflow, step: verify })).toBe(false);
      expect(
        bindSourceObligationResponseContract({
          repositoryPath: "/workspace",
          workflow,
          step: derive,
        }).step.prompt,
      ).toContain("Runtime source-obligation response contract");
    }
    expect(
      update.branching?.branches
        .find((branch) => branch.id === "assess-no-change")
        ?.steps.some((step) => step.id === "derive-source-obligations"),
    ).toBe(false);
  });

  it("recognizes both closed CREATE V3 technical topologies without parser activation", () => {
    const legacy = createWorkflowV3(false);
    const corrected = createWorkflowV3(true);
    for (const workflow of [legacy, corrected]) {
      expect(assertSourceObligationPhaseContract(workflow)).toBe(true);
      const initial = workflow.steps.find(
        (step) => step.id === "provisional-technical-verification",
      )!;
      const revised = workflow.steps.find(
        (step) => step.id === "provisional-revised-technical-verification",
      )!;
      const revisedFinal = workflow.steps.find(
        (step) => step.id === "verify-revised-technical-accuracy",
      )!;
      expect(isProvisionalTechnicalVerification({ workflow, step: initial })).toBe(true);
      expect(isProvisionalTechnicalVerification({ workflow, step: revised })).toBe(true);
      expect(isCanonicalTechnicalAdmission({ workflow, step: revisedFinal })).toBe(true);
      expect(requiresTechnicalCorrection({ workflow, step: revisedFinal })).toBe(true);
    }

    const revised = legacy.steps.find((step) => step.id === "verify-revised-technical-accuracy")!;
    for (const malformed of [
      {
        ...legacy,
        steps: legacy.steps.filter(
          (step) => step.id !== "provisional-revised-technical-verification",
        ),
      },
      {
        ...legacy,
        steps: legacy.steps.map((step) =>
          step.id === "revise-documentation" ? { ...step, mode: "read-only" as const } : step,
        ),
      },
      {
        ...legacy,
        steps: [...legacy.steps, { ...revised, id: "late-write", mode: "write" as const }],
      },
    ] satisfies WorkflowDefinition[]) {
      expect(() => assertSourceObligationPhaseContract(malformed)).toThrow(
        "incomplete or misordered source-obligation phase set",
      );
    }
  });

  it("keeps proposals strict and inside CREATE plan source authority", () => {
    const input = deriveInput();
    const proposal = sourceObligationProposalFixture();
    expect(validateSourceObligationProposal(proposal, input)).toEqual(proposal);
    expect(decodeSourceObligationResponse(JSON.stringify(proposal))).toEqual(proposal);
    expect(canonicalSourceObligationProposal(proposal)).toBe(
      canonicalSourceObligationProposal(decodeSourceObligationResponse(JSON.stringify(proposal))),
    );
    expect(sourceObligationLocatorPaths(proposal)).toEqual(["src/api.ts"]);
    // The strict-JSON sub-code rides in the coded pair, so it reaches a record
    // instead of only a sentence.
    expect(() => decodeSourceObligationResponse("```json\n{oops}\n```")).toThrow(
      sourceObligationRejectionMessage("malformed-json", "$response"),
    );
    let decodeError: unknown;
    try {
      decodeSourceObligationResponse("```json\n{oops}\n```");
    } catch (error) {
      decodeError = error;
    }
    expect(decodeError).toBeInstanceOf(InferenceStepError);
    expect(decodeError).toMatchObject({
      // A fenced response never reaches structural validation, so the reason
      // is the parser's own refusal and the location is the whole response --
      // no finer contract position was admitted.
      message: sourceObligationRejectionMessage("malformed-json", "$response"),
      category: "malformed-response",
      retryable: true,
      rejection: { code: "malformed-json", location: "$response" },
    });
    expect(() =>
      validateSourceObligationProposal({ ...proposal, inventedAuthority: true }, input),
    ).toThrow();
    const outside = sourceObligationProposalFixture();
    outside.dimensions[0]!.sourceLocators = ["src/unapproved.ts:1"];
    let authorityError: unknown;
    try {
      validateSourceObligationProposal(outside, input);
    } catch (error) {
      authorityError = error;
    }
    expect(authorityError).toBeInstanceOf(InferenceStepError);
    expect(authorityError).toMatchObject({
      category: "malformed-response",
      retryable: true,
      message: sourceObligationRejectionMessage(
        "source-proposal-required",
        "$.dimensions[].sourceLocators[]",
      ),
      rejection: {
        code: "source-proposal-required",
        location: "$.dimensions[].sourceLocators[]",
      },
    });

    // Preserve the real whole-file boundary: an out-of-plan locator is
    // correctable by proposing its path even without a line span.
    const outsideWholeFile = sourceObligationProposalFixture();
    outsideWholeFile.dimensions[0]!.sourceLocators = ["src/unapproved.ts"];
    expect(() => validateSourceObligationProposal(outsideWholeFile, input)).toThrow(
      sourceObligationRejectionMessage(
        "source-proposal-required",
        "$.dimensions[].sourceLocators[]",
      ),
    );
    const declared = {
      ...outsideWholeFile,
      dimensions: [
        {
          ...outsideWholeFile.dimensions[0]!,
          sourceLocators: ["src/unapproved.ts:1"],
        },
        ...outsideWholeFile.dimensions.slice(1),
      ],
      sourceProposals: [{ path: "src/unapproved.ts", reason: "It defines the public API." }],
    };
    expect(validateSourceObligationProposal(declared, input)).toMatchObject({
      sourceProposals: [{ path: "src/unapproved.ts", reason: "It defines the public API." }],
    });
    expect(() =>
      validateSourceObligationProposal(
        {
          ...proposal,
          sourceProposals: [
            {
              path: "src/unapproved.ts",
              reason: `It mentions glpat-${"x".repeat(24)} and the public API.`,
            },
          ],
        },
        input,
      ),
    ).toThrow(sourceObligationRejectionMessage("credential-material", "$"));
    expect(() =>
      validateSourceObligationProposal(
        {
          ...proposal,
          sourceProposals: [
            {
              path: "src/unapproved.ts",
              reason: "It defines the public API.",
              sourceSha256: "a".repeat(64),
            },
          ],
        },
        input,
      ),
    ).toThrow(sourceObligationRejectionMessage("unexpected-key-set", "$.sourceProposals[]"));
    // Adjacent: the same span-less citation of an admitted source is re-asked.
    const insideWholeFile = sourceObligationProposalFixture();
    insideWholeFile.dimensions[0]!.sourceLocators = ["src/api.ts"];
    expect(() => validateSourceObligationProposal(insideWholeFile, input)).toThrow(
      sourceObligationRejectionMessage(
        "source-locator-span-missing",
        "$.dimensions[].sourceLocators[]",
      ),
    );

    const sourceWriteIntersection = createPlanBinding("src/api.ts");
    expect(() =>
      validateSourceObligationProposal(sourceObligationProposalFixture("src/api.ts:1"), {
        ...input,
        planBinding: sourceWriteIntersection,
      }),
    ).toThrow(SourceObligationSourceReferenceError);
    expect(() =>
      validateSourceObligationProposal(sourceObligationProposalFixture("src/api.ts:1"), {
        ...input,
        planBinding: sourceWriteIntersection,
      }),
    ).toThrow("cannot use an authorized write target as original source evidence");

    const revision = input.evidenceIdentity!.repositoryRevision;
    const revisionBound = {
      ...input,
      planBinding: createPlanBinding("docs/new-guide.md", [
        `src/api.ts:1-20@${revision}`,
        `src/api.ts#public-api@${revision}`,
        `git:${revision}:src/api.ts:1-20`,
        `git:${revision}:src/api.ts#public-api`,
      ]),
    };
    expect(assertSourceObligationSourceAuthority(revisionBound)).toEqual(["src/api.ts"]);
    expect(validateSourceObligationProposal(proposal, revisionBound)).toEqual(proposal);
    // A suffix naming this run's revision is identity the host binds
    // separately, so the locator is repaired to its ordinary spelling and the
    // proposal is byte-identical to the one that never carried the suffix.
    expect(
      validateSourceObligationProposal(
        sourceObligationProposalFixture(`src/api.ts:1@${revision}`),
        revisionBound,
      ),
    ).toEqual(
      validateSourceObligationProposal(
        sourceObligationProposalFixture("src/api.ts:1"),
        revisionBound,
      ),
    );
    // The adjacent condition: another revision is content the host cannot bind.
    // It is removed rather than repaired, so the dimension that cited it loses
    // its only locator and is demoted -- still no refusal, and the authority
    // rule below is untouched.
    const foreign = validateSourceObligationProposal(
      sourceObligationProposalFixture(`src/api.ts:1@${"b".repeat(40)}`),
      revisionBound,
    );
    expect(foreign.dimensions.map(({ status }) => status)).toEqual(
      foreign.dimensions.map(() => "unverified"),
    );
    expect(foreign.limitations.every((entry) => entry.startsWith("Host degradation:"))).toBe(true);
    expect(JSON.stringify(foreign)).not.toContain("b".repeat(40));
    expect(() =>
      assertSourceObligationSourceAuthority({
        ...revisionBound,
        planBinding: createPlanBinding("docs/new-guide.md", [`src/api.ts@${"b".repeat(40)}`]),
      }),
    ).toThrow("another repository revision");
    expect(() =>
      assertSourceObligationSourceAuthority({
        ...revisionBound,
        planBinding: createPlanBinding("docs/new-guide.md", ["../private.ts@not-a-revision"]),
      }),
    ).toThrow("invalid repository source reference");
    for (const source of [
      `git:${"b".repeat(40)}:src/api.ts`,
      `git:${revision}:../private.ts`,
      `git:${revision}:/private/api.ts`,
      `git:${revision}:src/api.ts@${revision}`,
      "git:HEAD:src/api.ts",
    ]) {
      expect(() =>
        assertSourceObligationSourceAuthority({
          ...revisionBound,
          planBinding: createPlanBinding("docs/new-guide.md", [source]),
        }),
      ).toThrow(SourceObligationSourceReferenceError);
    }
  });

  it("retains safe source-inventory validation reasons without retaining the response", () => {
    const missingDimension = sourceObligationProposalFixture();
    missingDimension.dimensions.pop();
    const invalidStatus = sourceObligationProposalFixture();
    (invalidStatus.dimensions[0] as { status: string }).status = "invented";
    // Each of these reads as a coded pair. The first three are different
    // producer bugs -- a truncated object, a repeated key, a number outside the
    // safe range -- and keep different reasons, because an operator fixes each
    // of them differently.
    const cases = [
      ["{private-response", sourceObligationRejectionMessage("malformed-json", "$response")],
      [
        '{"dimensions":[],"dimensions":[]}',
        sourceObligationRejectionMessage("duplicate-key", "$response"),
      ],
      [
        '{"value":9007199254740993}',
        sourceObligationRejectionMessage("unsafe-number", "$response"),
      ],
      [
        JSON.stringify(missingDimension),
        sourceObligationRejectionMessage("incomplete-required-set", "$.dimensions"),
      ],
      [
        JSON.stringify(invalidStatus),
        sourceObligationRejectionMessage("invalid-value", "$.dimensions[].status"),
      ],
    ];
    for (const [response, expected] of cases) {
      let failure: unknown;
      try {
        decodeSourceObligationResponse(response!);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(InferenceStepError);
      expect(failure).toMatchObject({ message: expected, category: "malformed-response" });
      expect(JSON.stringify(failure)).not.toContain("private-response");
    }
  });

  it("distinguishes absent obligations from misplaced dimension citations", () => {
    const proposal = sourceObligationProposalFixture();
    proposal.dimensions[0] = {
      dimension: "input-representations",
      status: "applicable",
      reason: "The source defines the input accepted by the public operation.",
      sourceLocators: [],
      obligations: [],
    };
    expect(() => decodeSourceObligationResponse(JSON.stringify(proposal))).toThrow(
      sourceObligationRejectionMessage(
        "dimension-applicable-without-obligations",
        "$.dimensions[].obligations",
      ),
    );
    proposal.dimensions[0].obligations = [
      {
        id: "OBL-001",
        dimension: "input-representations",
        sourceLocators: ["src/api.ts:1"],
        statement: "The public operation accepts the declared input.",
        evidenceClass: "source-observation",
        uncertainty: "The implementation was inspected but not executed.",
      },
    ];
    const decoded = decodeSourceObligationResponse(JSON.stringify(proposal));
    proposal.dimensions[0]!.obligations[0]!.id = "OBL-IGNORED";
    expect(decoded).toEqual(proposal);
    proposal.dimensions[0].sourceLocators = ["src/api.ts:1"];
    // The two mistakes stay distinguishable: each is its own catalog rule.
    expect(() => decodeSourceObligationResponse(JSON.stringify(proposal))).toThrow(
      sourceObligationRejectionMessage(
        "dimension-applicable-with-locators",
        "$.dimensions[].sourceLocators",
      ),
    );
  });

  it("retries malformed and unproposed CREATE source-obligation responses", async () => {
    const policy = {
      maxRetries: 1,
      baseDelayMs: 1,
      maxDelayMs: 1,
      retryableCategories: ["malformed-response"],
    };
    let malformedCalls = 0;
    const malformed = await executeInferenceStep({
      mode: "read-only",
      policy,
      sleep: async () => undefined,
      execute: async () => {
        malformedCalls += 1;
        decodeSourceObligationResponse("```json\n{oops}\n```");
        return { summary: "unreachable" };
      },
    });
    expect(malformed.status).toBe("failed");
    if (malformed.status !== "failed") throw new Error("expected failed decode");
    expect(malformed.error).toMatchObject({
      message: sourceObligationRejectionMessage("malformed-json", "$response"),
      category: "malformed-response",
      retryable: true,
      rejection: { code: "malformed-json", location: "$response" },
    });
    expect(malformedCalls).toBe(2);
    expect(malformed.evidence.attempts).toMatchObject([
      {
        attempt: 1,
        outcome: "malformed-response",
        retryable: true,
        retryScheduled: true,
      },
      {
        attempt: 2,
        outcome: "malformed-response",
        retryable: true,
        retryScheduled: false,
      },
    ]);

    const outside = sourceObligationProposalFixture();
    outside.dimensions[0]!.sourceLocators = ["src/unapproved.ts:1"];
    let authorityCalls = 0;
    const authority = await executeInferenceStep({
      mode: "read-only",
      policy,
      sleep: async () => undefined,
      execute: async () => {
        authorityCalls += 1;
        validateSourceObligationProposal(outside, deriveInput());
        return { summary: "unreachable" };
      },
    });
    expect(authority.status).toBe("failed");
    if (authority.status !== "failed") throw new Error("expected failed authority rejection");
    expect(authority.error).toMatchObject({
      category: "malformed-response",
      retryable: true,
    });
    expect(authorityCalls).toBe(2);
    expect(authority.evidence.attempts).toMatchObject([
      {
        attempt: 1,
        outcome: "malformed-response",
        retryable: true,
        retryScheduled: true,
      },
      {
        attempt: 2,
        outcome: "malformed-response",
        retryable: true,
        retryScheduled: false,
      },
    ]);

    let revisionCalls = 0;
    const revision = await executeInferenceStep({
      mode: "read-only",
      policy,
      sleep: async () => {
        throw new Error("revision-binding rejection must not schedule sleep");
      },
      execute: async () => {
        revisionCalls += 1;
        assertSourceObligationSourceAuthority({
          ...deriveInput(),
          planBinding: createPlanBinding("docs/new-guide.md", [`src/api.ts@${"b".repeat(40)}`]),
        });
        return { summary: "unreachable" };
      },
    });
    expect(revision.status).toBe("failed");
    expect(revisionCalls).toBe(1);
    if (revision.status !== "failed") throw new Error("expected failed revision rejection");
    expect(revision.error).toBeInstanceOf(InferenceStepError);
    expect(revision.evidence.attempts).toMatchObject([
      { attempt: 1, retryable: false, retryScheduled: false },
    ]);
  });

  /**
   * Run one rejection through the shipped retry loop with budget left,
   * counting model calls. A terminal rejection must stop after the first call.
   */
  async function executeWithBudget(
    run: () => unknown,
  ): Promise<{ execution: InferenceStepExecution; calls: number }> {
    let calls = 0;
    const execution = await executeInferenceStep({
      mode: "read-only",
      policy: {
        maxRetries: 2,
        baseDelayMs: 1,
        maxDelayMs: 1,
        retryableCategories: ["malformed-response"],
      },
      sleep: async () => {
        throw new Error("a terminal rejection must not schedule a retry");
      },
      execute: async () => {
        calls += 1;
        run();
        return { summary: "unreachable" };
      },
    });
    return { execution, calls };
  }

  it("stops a credential-bearing source-obligation reply after one model call", async () => {
    const proposal = sourceObligationProposalFixture();
    proposal.dimensions[0]!.reason = `The source sets glpat-${"A1b2C3d4E5f6G7h8J9k0"} here.`;
    const { execution, calls } = await executeWithBudget(() =>
      decodeSourceObligationResponse(JSON.stringify(proposal)),
    );
    expect(calls).toBe(1);
    expect(execution.status).toBe("failed");
    if (execution.status !== "failed") throw new Error("expected a failed step");
    expect(execution.error).toMatchObject({
      category: "malformed-response",
      retryable: false,
      rejection: { code: "credential-material", location: "$" },
    });
    expect(execution.evidence.attempts).toMatchObject([
      {
        attempt: 1,
        outcome: "malformed-response",
        retryable: false,
        retryScheduled: false,
        rejection: { code: "credential-material", location: "$" },
      },
    ]);
  });

  it("stops a digest mismatch after one model call on both rejection paths", async () => {
    const input = deriveInput();
    const tampered = structuredClone(
      bindSourceObligationLedger(sourceObligationProposalFixture(), input, [
        { path: "src/api.ts", sha256: "f".repeat(64) },
      ]),
    );
    tampered.digest = "0".repeat(64);
    const paths = [
      { run: () => validateSourceObligationLedger(tampered, input), location: "$.digest" },
      { run: () => rejectSourceObligationKit("kit-digest-mismatch"), location: "$" },
    ] as const;
    for (const { run, location } of paths) {
      const { execution, calls } = await executeWithBudget(run);
      expect(calls, location).toBe(1);
      expect(execution.status, location).toBe("failed");
      if (execution.status !== "failed") throw new Error("expected a failed step");
      expect(execution.error, location).toMatchObject({
        retryable: false,
        rejection: { code: "digest-mismatch", location },
      });
      expect(execution.evidence.attempts, location).toMatchObject([
        { attempt: 1, retryable: false, retryScheduled: false },
      ]);
    }
  });

  it("mints stable obligation ids at seal and ignores model ids", () => {
    const input = deriveInput();
    const proposal = proposalWithObligation();
    const first = proposal.dimensions[0]!.obligations[0]!;
    proposal.dimensions[0]!.obligations.push({
      ...first,
      id: "not-an-obligation-id",
      statement: "A second admitted source behavior.",
    });
    const sources = [{ path: "src/api.ts", sha256: "f".repeat(64) }];
    const ledger = bindSourceObligationLedger(proposal, input, sources);
    const sealed = ledger.dimensions.find(
      (dimension) => dimension.dimension === "input-representations",
    );
    expect(sealed?.obligations.map((obligation) => obligation.id)).toEqual([
      "OBL-INPUT-REPRESENTATIONS-1",
      "OBL-INPUT-REPRESENTATIONS-2",
    ]);
    expect(sealed?.obligations.map((obligation) => obligation.statement)).toEqual([
      "A second admitted source behavior.",
      "The operation accepts the source-defined object input.",
    ]);

    const reversed = structuredClone(proposal);
    const obligations = reversed.dimensions[0]!.obligations;
    reversed.dimensions[0]!.obligations = [obligations[1]!, obligations[0]!];
    reversed.dimensions[0]!.obligations[0]!.id = "OBL-FAKE";
    reversed.dimensions[0]!.obligations[1]!.id = "";
    const omitted = JSON.parse(JSON.stringify(proposalWithObligation())) as {
      dimensions: Array<{ obligations: Array<Record<string, unknown>> }>;
    };
    delete omitted.dimensions[0]!.obligations[0]!.id;
    expect(() => decodeSourceObligationResponse(JSON.stringify(omitted))).not.toThrow();
    omitted.dimensions[0]!.obligations.push({
      ...omitted.dimensions[0]!.obligations[0]!,
      statement: "A second admitted source behavior.",
    });
    expect(() => decodeSourceObligationResponse(JSON.stringify(omitted))).not.toThrow();

    const again = bindSourceObligationLedger(reversed, input, sources);
    expect(
      again.dimensions.find((dimension) => dimension.dimension === "input-representations"),
    ).toMatchObject({
      obligations: sealed?.obligations.map((obligation) => ({
        id: obligation.id,
        statement: obligation.statement,
      })),
    });
  });

  it("discards model obligation ids without a silent length boundary", () => {
    const atBoundary = proposalWithObligation();
    atBoundary.dimensions[0]!.obligations[0]!.id = "M".repeat(64);
    const overBoundary = proposalWithObligation();
    overBoundary.dimensions[0]!.obligations[0]!.id = "M".repeat(65);
    const decodedAt = decodeSourceObligationResponse(JSON.stringify(atBoundary));
    const decodedOver = decodeSourceObligationResponse(JSON.stringify(overBoundary));
    expect(decodedAt.dimensions[0]!.obligations[0]!.id).toBe("OBL-IGNORED");
    expect(decodedOver).toEqual(decodedAt);
  });

  it("rejects malformed proposal, identity, and ledger boundaries", () => {
    const input = deriveInput();
    const proposal = sourceObligationProposalFixture();

    expectInvalidProposal(
      (candidate) => {
        candidate.completeness = "complete" as typeof candidate.completeness;
      },
      { code: "invalid-value", location: "$.completeness" },
    );
    expectInvalidProposal(
      (candidate) => {
        candidate.dimensions.pop();
      },
      { code: "incomplete-required-set", location: "$.dimensions" },
    );
    expectInvalidProposal(
      (candidate) => {
        candidate.dimensions[1]!.dimension = candidate.dimensions[0]!.dimension;
      },
      { code: "duplicate-entry", location: "$.dimensions[].dimension" },
    );
    expectInvalidProposal(
      (candidate) => {
        candidate.dimensions[0]!.status = "unknown" as (typeof candidate.dimensions)[0]["status"];
      },
      { code: "invalid-value", location: "$.dimensions[].status" },
    );
    expectInvalidProposal(
      (candidate) => {
        candidate.dimensions[0] = {
          ...candidate.dimensions[0]!,
          status: "applicable",
          sourceLocators: [],
          obligations: [],
        };
      },
      { code: "dimension-applicable-without-obligations", location: "$.dimensions[].obligations" },
    );
    expectInvalidProposal(
      (candidate) => {
        candidate.dimensions[0] = {
          ...candidate.dimensions[0]!,
          sourceLocators: [],
        };
      },
      { code: "dimension-not-applicable-unsourced", location: "$.dimensions[].sourceLocators" },
    );
    expectInvalidProposal(
      (candidate) => {
        candidate.dimensions[0] = {
          ...candidate.dimensions[0]!,
          status: "unverified",
          reason: "The source leaves this dimension unverified.",
        };
      },
      { code: "dimension-unverified-reason-unlisted", location: "$.dimensions[].reason" },
    );

    const malformedObligation = proposalWithObligation();
    malformedObligation.dimensions[0]!.obligations[0]!.evidenceClass =
      "assertion" as (typeof malformedObligation.dimensions)[0]["obligations"][number]["evidenceClass"];
    expect(() => validateSourceObligationProposal(malformedObligation, input)).toThrow(
      sourceObligationRejectionMessage(
        "invalid-value",
        "$.dimensions[].obligations[].evidenceClass",
      ),
    );

    const twoObligations = proposalWithObligation();
    twoObligations.dimensions[0]!.obligations.push({
      ...twoObligations.dimensions[0]!.obligations[0]!,
      id: "OBL-INPUT-0",
    });
    expect(sourceObligationLocatorPaths(twoObligations)).toEqual(["src/api.ts"]);
    expect(
      validateSourceObligationProposal(twoObligations, input).dimensions[0]!.obligations.map(
        ({ id }) => id,
      ),
    ).toEqual(["OBL-IGNORED", "OBL-IGNORED"]);

    const nonspecific = proposalWithObligation();
    nonspecific.dimensions[0]!.obligations[0]!.sourceLocators = ["../private.ts"];
    expect(() => sourceObligationLocatorPaths(nonspecific)).toThrow(
      "requires specific repository locators",
    );

    const ledger = bindSourceObligationLedger(proposal, input, [
      { path: "src/zeta.ts", sha256: "e".repeat(64) },
      { path: "src/api.ts", sha256: "f".repeat(64) },
    ]);
    expect(ledger.identity.sources.map(({ path }) => path)).toEqual(["src/api.ts", "src/zeta.ts"]);

    const stale = structuredClone(ledger);
    stale.identity.scopeSha256 = "0".repeat(64);
    expect(() => validateSourceObligationLedger(stale, input)).toThrow(
      sourceObligationRejectionMessage("stale-evidence", "$.identity"),
    );
    const invalidDigest = structuredClone(ledger);
    invalidDigest.digest = "0".repeat(64);
    expect(() => validateSourceObligationLedger(invalidDigest, input)).toThrow(
      sourceObligationRejectionMessage("digest-mismatch", "$.digest"),
    );
    expect(() => bindSourceObligationLedger(proposal, input, [])).toThrow(
      "requires a bounded source identity set",
    );
    expect(() =>
      bindSourceObligationLedger(proposal, input, [
        { path: "src/api.ts", sha256: "f".repeat(64) },
        { path: "src/api.ts", sha256: "e".repeat(64) },
      ]),
    ).toThrow("invalid source identity");
  });

  it("distinguishes strict JSON transport from nested verification rejection", () => {
    const input = deriveInput();
    const ledger = bindSourceObligationLedger(sourceObligationProposalFixture(), input, [
      { path: "src/api.ts", sha256: "f".repeat(64) },
    ]);
    expect(validateSourceObligationLedger(ledger, input)).toEqual(ledger);
    expect(() =>
      decodeTechnicalCorrectionResponse("```json\n{oops}\n```", ledger, (value) => value as never),
    ).toThrow("Strict JSON: malformed-json; response format: fenced.");
    expect(() =>
      decodeTechnicalCorrectionResponse(
        JSON.stringify({ verificationResult: {}, obligationAccounting: [] }),
        ledger,
        (value) => validateVerificationResult(value, ["docs/guide.md"]),
      ),
    ).toThrow("Technical correction response rejected: invalid-shape.");

    for (const sensitiveValue of [`glpat-${"x".repeat(24)}`, "/Users/alice/private/source.ts"]) {
      const sensitive = verificationResultFixture(["docs/guide.md"]);
      sensitive.factInventory.dimensions[0]!.facts[0]!.statement = sensitiveValue;
      let message = "";
      try {
        decodeTechnicalCorrectionResponse(
          JSON.stringify({ verificationResult: sensitive, obligationAccounting: [] }),
          ledger,
          (value) => validateVerificationResult(value, ["docs/guide.md"]),
        );
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).not.toContain(sensitiveValue);
    }
  });

  it("refuses, by name and without retry, accounting whose rejections overflow the limitation bound (#1254)", () => {
    const maximum = limit("factInventory.maxLimitations").value;
    const proposal = proposalWithObligation();
    const template = proposal.dimensions[0]!.obligations[0]!;
    const accountFor = (count: number) => {
      proposal.dimensions[0]!.obligations = Array.from({ length: count }, (_, index) => ({
        ...template,
        id: `OBL-INPUT-${index + 1}`,
        statement: `The operation accepts source-defined object input variant ${index + 1}.`,
      }));
      const ledger = bindSourceObligationLedger(proposal, deriveInput(), [
        { path: "src/api.ts", sha256: "f".repeat(64) },
      ]);
      const verification = verificationResultFixture(["docs/guide.md"]);
      const rows = ledger.dimensions
        .flatMap(({ obligations }) => obligations)
        .map(({ id }) => ({
          obligationId: id,
          disposition: "rejected" as const,
          factIds: [],
          reason: "The fresh source read does not establish this input variant.",
          sourceLocators: ["src/api.ts:1"],
        }));
      return () =>
        decodeTechnicalCorrectionResponse(
          JSON.stringify({ verificationResult: verification, obligationAccounting: rows }),
          ledger,
          (value) => validateVerificationResult(value, ["docs/guide.md"]),
        );
    };
    const existing = verificationResultFixture(["docs/guide.md"]).factInventory.limitations.length;
    expect(() => accountFor(maximum - existing)()).not.toThrow();
    let error: unknown;
    try {
      accountFor(maximum - existing + 1)();
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({
      retryable: false,
      rejection: {
        code: "fact-inventory-limitations-exceeded",
        location: "$.obligationAccounting",
      },
    });
    expect((error as Error).message).toContain(
      `fact-inventory-max-limitations-bound: ${maximum + 1} limitations exceed factInventory.maxLimitations = ${maximum} count`,
    );
  });

  it("binds total retained refined and rejected accounting to ledger and result", () => {
    const input = deriveInput();
    const proposal = proposalWithObligation();
    const ledger = bindSourceObligationLedger(proposal, input, [
      { path: "src/api.ts", sha256: "f".repeat(64) },
    ]);
    const obligationId = ledger.dimensions[0]!.obligations[0]!.id;
    expect(obligationId).toBe("OBL-INPUT-REPRESENTATIONS-1");
    const verification = verificationResultFixture(["docs/guide.md"]);
    const fact = verification.factInventory.dimensions[0]!.facts[0]!;
    fact.statement = proposal.dimensions[0]!.obligations[0]!.statement;
    fact.sourceLocators = [...proposal.dimensions[0]!.obligations[0]!.sourceLocators];
    fact.uncertainty = proposal.dimensions[0]!.obligations[0]!.uncertainty;

    const retained = bindTechnicalCorrectionResponse(
      {
        verificationResult: verification,
        obligationAccounting: [
          { obligationId: obligationId, disposition: "retained", factIds: [fact.id] },
        ],
      },
      ledger,
      (value) => value as typeof verification,
    );
    expect(
      validateTechnicalCorrectionEvidence(retained.evidence, ledger, verification)
        .obligationAccounting,
    ).toEqual([{ obligationId: obligationId, disposition: "retained", factIds: [fact.id] }]);

    const refinedVerification = structuredClone(verification);
    const refinedFact = refinedVerification.factInventory.dimensions[0]!.facts[0]!;
    refinedFact.statement =
      "The fixture source accepts a narrower structured input representation.";
    const refinedResponse = {
      verificationResult: refinedVerification,
      obligationAccounting: [
        {
          obligationId: obligationId,
          disposition: "refined" as const,
          factIds: [refinedFact.id],
          reason: "The fresh source read narrows the accepted input representation.",
          sourceLocators: ["src/api.ts:1"],
        },
      ],
    };
    const refined = decodeTechnicalCorrectionResponse(
      JSON.stringify(refinedResponse),
      ledger,
      (value) => validateVerificationResult(value, ["docs/guide.md"]),
    );
    expect(refined.evidence.obligationAccounting[0]?.disposition).toBe("refined");

    // Adjacent: the technical-correction caller of `validateLocators` is not
    // degraded. It validates a different response contract, whose positions
    // are outside the source-obligation rejection vocabulary, so a revision
    // suffix and a nonspecific locator both keep that caller's uncoded
    // messages.
    const correctionLocator = (sourceLocators: readonly string[]) =>
      decodeTechnicalCorrectionResponse(
        JSON.stringify({
          ...refinedResponse,
          obligationAccounting: [
            { ...refinedResponse.obligationAccounting[0], sourceLocators: [...sourceLocators] },
          ],
        }),
        ledger,
        (value) => validateVerificationResult(value, ["docs/guide.md"]),
      );
    // `technicalCorrectionBoundary` re-raises both under this response mode's
    // own coded refusal, which is the message an operator reads; the inner
    // rules are `SOURCE_OBLIGATION_FAILURES.revisionSuffix` and
    // `.nonspecificLocator`, neither of which degrades here.
    expect(() => correctionLocator([`src/api.ts:1@${"a".repeat(40)}`])).toThrow(
      "Technical correction response rejected: source-authority.",
    );
    expect(() => correctionLocator(["src/api.ts"])).toThrow(
      "Technical correction response rejected: source-authority.",
    );
    expect(() => correctionLocator(["src/api.ts:1"])).not.toThrow();

    const otherDimensionFact = refinedVerification.factInventory.dimensions[1]!.facts[0]!;
    let crossDimensionError: unknown;
    try {
      decodeTechnicalCorrectionResponse(
        JSON.stringify({
          ...refinedResponse,
          obligationAccounting: [
            { ...refinedResponse.obligationAccounting[0], factIds: [otherDimensionFact.id] },
          ],
        }),
        ledger,
        (value) => validateVerificationResult(value, ["docs/guide.md"]),
      );
    } catch (error) {
      crossDimensionError = error;
    }
    expect(crossDimensionError).toBeInstanceOf(InferenceStepError);
    // A cross-dimension fact link is an accounting defect in the
    // model's own reply, so a bounded retry may repair it.
    expect(crossDimensionError).toMatchObject({
      category: "malformed-response",
      retryable: true,
      message: "Technical correction response rejected: invalid-accounting.",
    });
    expect((crossDimensionError as Error).message).not.toContain(
      refinedResponse.obligationAccounting[0].reason,
    );

    expect(() =>
      decodeTechnicalCorrectionResponse(
        JSON.stringify({
          ...refinedResponse,
          obligationAccounting: [
            { ...refinedResponse.obligationAccounting[0], sourceLocators: ["src/outside.ts:1"] },
          ],
        }),
        ledger,
        (value) => validateVerificationResult(value, ["docs/guide.md"]),
      ),
    ).toThrow("Technical correction response rejected: source-authority.");

    const withoutInputFact = structuredClone(verification);
    withoutInputFact.factInventory.dimensions[0] = {
      dimension: "input-representations",
      status: "not-applicable",
      reason: "The fresh source read disproves the proposed structured input representation.",
      sourceLocators: ["src/api.ts:1"],
      facts: [],
    };
    const rejected = bindTechnicalCorrectionResponse(
      {
        verificationResult: withoutInputFact,
        obligationAccounting: [
          {
            obligationId: obligationId,
            disposition: "rejected",
            factIds: [],
            reason: "The establishing source contradicts the provisional obligation.",
            sourceLocators: ["src/api.ts:1"],
          },
        ],
      },
      ledger,
      (value) => value as typeof withoutInputFact,
    );
    expect(rejected.verificationResult.factInventory.limitations).toContain(
      `Rejected source obligation ${obligationId}: The establishing source contradicts the provisional obligation. Source locators: src/api.ts:1`,
    );
    expect(() =>
      validateTechnicalCorrectionEvidence(rejected.evidence, ledger, withoutInputFact),
    ).toThrow("final limitations omit rejected source-obligation evidence");
    expect(
      validateTechnicalCorrectionEvidence(rejected.evidence, ledger, rejected.verificationResult),
    ).toEqual(rejected.evidence);

    expect(() =>
      bindTechnicalCorrectionResponse(
        { verificationResult: verification, obligationAccounting: [] },
        ledger,
        (value) => value as typeof verification,
      ),
    ).toThrow("Technical correction response rejected: invalid-accounting.");
    expect(() =>
      bindTechnicalCorrectionResponse(
        {
          verificationResult: verification,
          obligationAccounting: [
            { obligationId: "OBL-UNKNOWN", disposition: "retained", factIds: [fact.id] },
          ],
        },
        ledger,
        (value) => value as typeof verification,
      ),
    ).toThrow("Technical correction response rejected: invalid-accounting.");

    expectAccountingFailure(
      ledger,
      verification,
      { obligationId: obligationId, disposition: "retained", factIds: [] },
      "Technical correction response rejected: invalid-accounting.",
    );
    const changedVerification = structuredClone(verification);
    changedVerification.factInventory.dimensions[0]!.facts[0]!.statement =
      "A changed statement cannot retain the provisional obligation.";
    expectAccountingFailure(
      ledger,
      changedVerification,
      { obligationId: obligationId, disposition: "retained", factIds: [fact.id] },
      "Technical correction response rejected: invalid-accounting.",
    );
    expectAccountingFailure(
      ledger,
      verification,
      { obligationId: obligationId, disposition: "unknown", factIds: [] },
      "Technical correction response rejected: invalid-accounting.",
    );
    expectAccountingFailure(
      ledger,
      verification,
      {
        obligationId: obligationId,
        disposition: "refined",
        factIds: [],
        reason: "The original source narrows the provisional obligation.",
        sourceLocators: ["src/api.ts:1"],
      },
      "Technical correction response rejected: invalid-accounting.",
    );
    expectAccountingFailure(
      ledger,
      verification,
      {
        obligationId: obligationId,
        disposition: "rejected",
        factIds: [fact.id],
        reason: "The original source contradicts the provisional obligation.",
        sourceLocators: ["src/api.ts:1"],
      },
      "Technical correction response rejected: invalid-accounting.",
    );
    expectAccountingFailure(
      ledger,
      verification,
      { obligationId: obligationId, disposition: "retained", factIds: [fact.id, fact.id] },
      "Technical correction response rejected: invalid-accounting.",
    );
    expectAccountingFailure(
      ledger,
      verification,
      { obligationId: obligationId, disposition: "retained", factIds: ["UNKNOWN_FACT"] },
      "Technical correction response rejected: invalid-fact-link.",
    );
  });

  it("permits candidate writes while rejecting original-source drift", async () => {
    const fixture = await repositoryFixture();
    const workspace = await prepareRepositoryWorkspace(fixture.source, "HEAD");
    try {
      const observer = new LocalSourceObligationSourceObserver(workspace);
      const identities = await observer.observe(["src/api.ts", "docs/guide.md", "src/api.ts"]);
      expect(identities.map(({ path }) => path)).toEqual(["docs/guide.md", "src/api.ts"]);
      await writeFile(join(workspace.path, "docs", "guide.md"), "# Revised guide\n");
      await admitAuthorizedTrackedWrites(workspace, ["docs/guide.md"]);
      await expect(
        observer.assertUnchanged(identities, ["docs/guide.md"]),
      ).resolves.toBeUndefined();
      await expect(
        observer.assertUnchanged(identities, ["docs/guide.md", "src/api.ts"]),
      ).resolves.toBeUndefined();
      await expect(
        observer.captureOriginalSourceAuthority({
          runId: "run-invalid-create-authority",
          workflow: createWorkflow(),
          repositoryRevision: workspace.revision,
          scopeSha256: "a".repeat(64),
          workspaceSnapshotSha256: "b".repeat(64),
          authorizedPaths: ["src/missing.ts"],
        }),
      ).rejects.toMatchObject({
        name: "SourceObligationSourceReferenceError",
        code: "source-untracked",
      });

      await writeFile(join(workspace.path, "src", "api.ts"), "export const value = 2;\n");
      await expect(observer.assertUnchanged(identities, ["docs/guide.md"])).rejects.toThrow(
        "Tracked repository file read failed: changed",
      );
      await expect(observer.observe([])).rejects.toThrow("no readable source path");
    } finally {
      await workspace.dispose();
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("admits REVIEW correction facts from original tracked files and rechecks bytes", async () => {
    const fixture = await repositoryFixture();
    const workspace = await prepareRepositoryWorkspace(fixture.source, "HEAD");
    try {
      const workflow = reviewWorkflow();
      const observer = new LocalSourceObligationSourceObserver(workspace);
      const input = {
        runId: "run-review-original-source-authority",
        repositoryPath: workspace.path,
        workflow,
        step: workflow.steps.find((step) => step.id === "derive-source-obligations")!,
        contextTarget: { sourcePath: "docs/guide.md" },
        evidenceIdentity: { repositoryRevision: workspace.revision },
        searchEvidence: searchStepEvidence({
          evidenceSha256: "b".repeat(64),
          workspaceSnapshotSha256: "c".repeat(64),
        }),
      } satisfies HarnessStepInput;
      const scopeSha256 = sourceObligationScopeSha256(input);
      const sealed = await observer.captureOriginalSourceAuthority({
        runId: input.runId,
        workflow,
        repositoryRevision: workspace.revision,
        scopeSha256,
        workspaceSnapshotSha256: input.searchEvidence.workspaceSnapshotSha256,
      });
      const proposal = proposalWithObligation();
      const observed = await observer.observe(["src/api.ts"]);
      const ledger = bindSourceObligationLedgerV2(proposal, input, observed, sealed.evidence);
      expect(validateSourceObligationLedger(ledger, input, sealed.evidence)).toEqual(ledger);
      const admission = issueOriginalSourceAuthorityAdmission({
        capture: sealed.capture,
        observer,
        runId: input.runId,
        repositoryRevision: workspace.revision,
        scopeSha256,
        workspaceSnapshotSha256: input.searchEvidence.workspaceSnapshotSha256,
      });
      const verification = verificationResultFixture(["docs/guide.md"]);
      verification.factInventory.dimensions[0]!.facts[0]!.statement =
        "The tracked extra source narrows the accepted input representation.";
      verification.factInventory.dimensions[0]!.facts[0]!.sourceLocators = ["src/extra.ts:1"];
      verification.factInventory.dimensions[1]!.facts[0]!.sourceLocators = ["src/Alpha.ts:1"];
      const response = {
        verificationResult: verification,
        obligationAccounting: [
          {
            obligationId: ledger.dimensions[0]!.obligations[0]!.id,
            disposition: "refined",
            factIds: ["FIXTURE_FACT_1"],
            reason: "The second original tracked source refines the provisional fact.",
            sourceLocators: ["src/extra.ts:1"],
          },
        ],
      };
      const correction = await decodeTechnicalCorrectionResponseV2(
        JSON.stringify(response),
        ledger,
        admission,
        input.runId,
        (value) => validateVerificationResult(value, ["docs/guide.md"]),
      );
      expect(ledger.identity.sources.map((source) => source.path)).toEqual(["src/api.ts"]);
      expect(correction.evidence.sourceChecks.map((check) => check.path)).toEqual([
        "src/Alpha.ts",
        "src/api.ts",
        "src/extra.ts",
      ]);
      expect(
        validateTechnicalCorrectionEvidence(
          correction.evidence,
          ledger,
          correction.verificationResult,
          sealed.evidence,
        ),
      ).toEqual(correction.evidence);

      await writeFile(join(workspace.path, "src", "extra.ts"), "export const extra = 2;\n");
      await expect(
        decodeTechnicalCorrectionResponseV2(
          JSON.stringify(response),
          ledger,
          admission,
          input.runId,
          (value) => validateVerificationResult(value, ["docs/guide.md"]),
        ),
      ).rejects.toThrow("Technical correction response rejected: source-authority.");
      await expect(
        bindTechnicalCorrectionResponseV2(response, ledger, admission, input.runId, (value) =>
          validateVerificationResult(value, ["docs/guide.md"]),
        ),
      ).rejects.toThrow("Technical correction response rejected: source-authority.");
    } finally {
      await workspace.dispose();
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});

describe("catalogued source-obligation ledger capacities", () => {
  const obligationsBound = limit("sourceObligation.maxObligations");
  const perDimensionBound = limit("sourceObligation.maxPerDimension");
  const locatorsBound = limit("sourceObligation.maxLocators");

  const sources = [{ path: "src/api.ts", sha256: "f".repeat(64) }];

  function sourceAuthority(input: HarnessStepInput) {
    return sealOriginalSourceAuthority({
      runId: "run-catalogued-ledger-caps",
      scope: "create-plan-sources",
      repositoryRevision: input.evidenceIdentity!.repositoryRevision,
      scopeSha256: sourceObligationScopeSha256(input),
      workspaceSnapshotSha256: input.searchEvidence!.workspaceSnapshotSha256,
      members: [
        { path: sources[0]!.path, mode: 0o644, byteLength: 1, sourceSha256: sources[0]!.sha256 },
      ],
    }).evidence;
  }

  function withObligationCounts(counts: readonly number[]): SourceObligationLedgerProposalV1 {
    const proposal = sourceObligationProposalFixture("src/api.ts:1");
    for (const [index, count] of counts.entries()) {
      const dimension = proposal.dimensions[index]!;
      dimension.status = "applicable";
      dimension.sourceLocators = [];
      dimension.obligations = Array.from({ length: count }, (_, ordinal) => ({
        id: `OBL-${index}-${ordinal}`,
        dimension: dimension.dimension,
        sourceLocators: ["src/api.ts:1"],
        statement: `The source establishes obligation ${ordinal} in dimension ${index}.`,
        evidenceClass: "source-observation" as const,
        uncertainty: "This assertion is bounded to the admitted source span.",
      }));
    }
    return proposal;
  }

  it("preserves the provisional capacities as sealed record readback limits", () => {
    expect([obligationsBound.value, perDimensionBound.value, locatorsBound.value]).toEqual([
      256, 128, 64,
    ]);
    expect(
      limit("sourceObligation.maxObligations", {
        environment: { DOCSFAB_SOURCE_OBLIGATION_MAX_OBLIGATIONS: "1" },
      }).value,
    ).toBe(obligationsBound.value);
  });

  it("admits the obligation and per-dimension ceilings, then refuses one more", () => {
    const atBoth = withObligationCounts([
      perDimensionBound.value,
      obligationsBound.value - perDimensionBound.value,
    ]);
    const input = deriveInput();
    expect(validateSourceObligationProposal(atBoth, input).dimensions[0]!.obligations).toHaveLength(
      perDimensionBound.value,
    );
    const sealed = bindSourceObligationLedger(atBoth, input, sources);
    expect(validateSourceObligationLedger(JSON.parse(JSON.stringify(sealed)), input)).toEqual(
      sealed,
    );
    expect(sealed.dimensions.flatMap(({ obligations }) => obligations)).toHaveLength(
      obligationsBound.value,
    );
    const authority = sourceAuthority(input);
    const sealedV2 = bindSourceObligationLedgerV2(atBoth, input, sources, authority);
    expect(
      validateSourceObligationLedger(JSON.parse(JSON.stringify(sealedV2)), input, authority),
    ).toEqual(sealedV2);

    const overDimension = withObligationCounts([perDimensionBound.value + 1]);
    expect(() => validateSourceObligationProposal(overDimension, input)).toThrow(
      sourceObligationRejectionMessage("bounds-exceeded", "$.dimensions[].obligations"),
    );
    const overTotal = withObligationCounts([
      perDimensionBound.value,
      obligationsBound.value - perDimensionBound.value,
      1,
    ]);
    expect(() => validateSourceObligationProposal(overTotal, input)).toThrow(
      sourceObligationRejectionMessage("bounds-exceeded", "$.dimensions[].obligations"),
    );
  });

  it("mints the same host IDs and ledger digests from reordered model rows and model IDs", () => {
    const input = deriveInput();
    const proposal = withObligationCounts([12]);
    const reordered = structuredClone(proposal);
    reordered.dimensions[0]!.obligations.reverse();
    reordered.dimensions[0]!.obligations.forEach((obligation, index) => {
      obligation.id = `OBL-MODEL-${index}`;
    });
    const statementIds = (ledger: ReturnType<typeof bindSourceObligationLedger>) =>
      new Map(ledger.dimensions[0]!.obligations.map(({ statement, id }) => [statement, id]));
    const first = bindSourceObligationLedger(proposal, input, sources);
    const second = bindSourceObligationLedger(reordered, input, sources);
    expect(statementIds(second)).toEqual(statementIds(first));
    expect(second.digest).toBe(first.digest);
    const authority = sourceAuthority(input);
    const firstV2 = bindSourceObligationLedgerV2(proposal, input, sources, authority);
    const secondV2 = bindSourceObligationLedgerV2(reordered, input, sources, authority);
    expect(statementIds(secondV2)).toEqual(statementIds(firstV2));
    expect(secondV2.digest).toBe(firstV2.digest);
  });

  it("keeps old valid V1/V2 readback in lexical host-ID order even when content ranks differently", () => {
    const fixture = JSON.parse(
      readFileSync(
        new URL("./fixtures/source-obligation/old-valid-lexical-ledgers.json", import.meta.url),
        "utf8",
      ),
    );
    for (const oldValid of [fixture.v1, fixture.v2]) {
      const authority = oldValid.schemaVersion === 2 ? fixture.originalSourceAuthority : undefined;
      expect(
        oldValid.dimensions[0].obligations.map(({ statement }: { statement: string }) => statement),
      ).toEqual([
        "Zulu source statement establishes the first behavior.",
        "Alpha source statement establishes the second behavior.",
      ]);
      expect(
        validateSourceObligationLedger(JSON.parse(JSON.stringify(oldValid)), undefined, authority),
      ).toEqual(oldValid);
      expect(() =>
        validateSourceObligationLedger(
          { ...oldValid, digest: "0".repeat(64) },
          undefined,
          authority,
        ),
      ).toThrow(sourceObligationRejectionMessage("digest-mismatch", "$.digest"));
    }
  });

  it("admits the locator ceiling and refuses an oversized sealed source set", () => {
    const input = deriveInput();
    const proposal = withObligationCounts([1]);
    const locators = Array.from(
      { length: locatorsBound.value },
      (_, index) => `src/api.ts:${index + 1}`,
    );
    proposal.dimensions[0]!.obligations[0]!.sourceLocators = locators;
    expect(
      new Set(
        validateSourceObligationProposal(proposal, input).dimensions[0]!.obligations[0]!
          .sourceLocators,
      ),
    ).toEqual(new Set(locators));
    proposal.dimensions[0]!.obligations[0]!.sourceLocators.push("src/api.ts:65");
    expect(() => validateSourceObligationProposal(proposal, input)).toThrow(
      sourceObligationRejectionMessage(
        "bounds-exceeded",
        "$.dimensions[].obligations[].sourceLocators",
      ),
    );

    const sources = Array.from({ length: locatorsBound.value + 1 }, (_, index) => ({
      path: `src/source-${index}.ts`,
      sha256: "f".repeat(64),
    }));
    expect(() => bindSourceObligationLedger(withObligationCounts([1]), input, sources)).toThrow(
      "requires a bounded source identity set",
    );
  });
});

/**
 * A `malformed-response` alone does not say which part of the contract a
 * response missed. These tests pin the reason to the evidence an operator
 * actually reads: the per-attempt record and the step message.
 */
/**
 * Step 2 has no catalog contract file, so the catalog generator's stated-rule
 * check never reaches it; this is that check for the source-obligation family.
 */
describe("source-obligation catalog rules in the step-2 contract", () => {
  it("states every rule of the family, and each key set the key rule names", () => {
    const family = (Object.values(OUTPUT_RULES) as OutputRuleDeclaration[]).filter(
      (rule) => rule.family === "source-obligation",
    );
    expect(family.map((rule) => rule.code).sort()).toEqual(
      [...SOURCE_OBLIGATION_CATALOG_CODES].sort(),
    );
    for (const rule of family) {
      expect(SOURCE_OBLIGATION_RESPONSE_CONTRACT, rule.code).toContain(rule.statement);
      // Every location is in the decoder's own closed location vocabulary.
      for (const location of rule.locations) {
        expect(SOURCE_OBLIGATION_REJECTION_LOCATIONS, `${rule.code} ${location}`).toContain(
          location,
        );
      }
    }
    // The missing-key rule is raised at each required key's own path, so its
    // locations are exactly the decoder's required key sets.
    expect([...OUTPUT_RULES["ledger-key-missing"].locations].sort()).toEqual(
      [
        ...SOURCE_OBLIGATION_PROPOSAL_KEYS.map((key) => `$.${key}`),
        ...SOURCE_OBLIGATION_DIMENSION_KEYS.map((key) => `$.dimensions[].${key}`),
        // An obligation id is optional in a model reply; the host mints it.
        ...SOURCE_OBLIGATION_KEYS.filter((key) => key !== "id").map(
          (key) => `$.dimensions[].obligations[].${key}`,
        ),
      ].sort(),
    );
  });
});

describe("source-obligation rejection reasons", () => {
  /**
   * Each case is a response a model could really return, paired with the
   * reason an operator should be able to read back afterwards. Distinct
   * defects must land on distinct pairs; collapsing any two fails here.
   */
  const rejectionCases: ReadonlyArray<{
    readonly title: string;
    readonly response: () => string;
    readonly code: SourceObligationRecordedCode;
    readonly location: SourceObligationRejectionLocation;
  }> = [
    {
      title: "a fenced response that is not strict JSON",
      response: () => "```json\n{oops}\n```",
      code: "malformed-json",
      location: "$response",
    },
    {
      title: "an object that repeats a key",
      response: () => '{"dimensions":[],"dimensions":[]}',
      code: "duplicate-key",
      location: "$response",
    },
    {
      title: "a number outside the safe-integer range",
      response: () => '{"value":9007199254740993}',
      code: "unsafe-number",
      location: "$response",
    },
    {
      title: "prose instead of an object",
      response: () => JSON.stringify("the sources did not support an inventory"),
      code: "invalid-shape",
      location: "$",
    },
    {
      title: "an unexpected key alongside the contract's own",
      response: () => JSON.stringify({ ...sourceObligationProposalFixture(), confidence: "high" }),
      code: "unexpected-key-set",
      location: "$",
    },
    {
      title: "a required key omitted entirely",
      response: () => {
        const { limitations: _omitted, ...rest } = sourceObligationProposalFixture();
        return JSON.stringify(rest);
      },
      // The location names the key, so a retry can say which one.
      code: "ledger-key-missing",
      location: "$.limitations",
    },
    {
      title: "an unverified dimension that leaves out its obligations key",
      response: () => {
        const proposal = sourceObligationProposalFixture();
        const reason = "The source does not establish this dimension.";
        const { obligations: _omitted, ...rest } = {
          ...proposal.dimensions[0]!,
          status: "unverified" as const,
          reason,
          sourceLocators: [],
        };
        return JSON.stringify({
          ...proposal,
          dimensions: [rest, ...proposal.dimensions.slice(1)],
          limitations: [reason],
        });
      },
      code: "ledger-key-missing",
      location: "$.dimensions[].obligations",
    },
    {
      title: "an obligation that leaves out its uncertainty key",
      response: () => {
        const proposal = proposalWithObligation();
        const { uncertainty: _omitted, ...rest } = proposal.dimensions[0]!.obligations[0]!;
        proposal.dimensions[0]!.obligations[0] = rest as never;
        return JSON.stringify(proposal);
      },
      code: "ledger-key-missing",
      location: "$.dimensions[].obligations[].uncertainty",
    },
    {
      // A model reply usually carries no id, which comes first in the key set
      // and is optional; the missing required key is still the one named.
      title: "an id-less obligation that leaves out its uncertainty key",
      response: () => {
        const proposal = proposalWithObligation();
        const {
          id: _id,
          uncertainty: _omitted,
          ...rest
        } = proposal.dimensions[0]!.obligations[0]! as Record<string, unknown>;
        proposal.dimensions[0]!.obligations[0] = rest as never;
        return JSON.stringify(proposal);
      },
      code: "ledger-key-missing",
      location: "$.dimensions[].obligations[].uncertainty",
    },
    {
      // Missing and undeclared at once: the missing key is the one to name.
      title: "a dimension that misspells obligations as obligation",
      response: () => {
        const proposal = sourceObligationProposalFixture();
        const { obligations, ...rest } = proposal.dimensions[0]!;
        return JSON.stringify({
          ...proposal,
          dimensions: [{ ...rest, obligation: obligations }, ...proposal.dimensions.slice(1)],
        });
      },
      code: "ledger-key-missing",
      location: "$.dimensions[].obligations",
    },
    {
      title: "a dimension entry with an undeclared key",
      response: () => {
        const proposal = sourceObligationProposalFixture();
        return JSON.stringify({
          ...proposal,
          dimensions: [{ ...proposal.dimensions[0]!, facts: [] }, ...proposal.dimensions.slice(1)],
        });
      },
      code: "unexpected-key-set",
      location: "$.dimensions[]",
    },
    {
      title: "a completeness value outside its enumeration",
      response: () =>
        JSON.stringify({ ...sourceObligationProposalFixture(), completeness: "complete" }),
      code: "invalid-value",
      location: "$.completeness",
    },
    {
      title: "a dimension status outside its enumeration",
      response: () => {
        const proposal = sourceObligationProposalFixture();
        proposal.dimensions[0]!.status =
          "partial" as (typeof proposal.dimensions)[number]["status"];
        return JSON.stringify(proposal);
      },
      code: "invalid-value",
      location: "$.dimensions[].status",
    },
    {
      title: "a required dimension left out",
      response: () => {
        const proposal = sourceObligationProposalFixture();
        proposal.dimensions.pop();
        return JSON.stringify(proposal);
      },
      // Not bounds-exceeded: an operator reading "bound exceeded" would go
      // looking for something too large, which is the opposite of the defect.
      code: "incomplete-required-set",
      location: "$.dimensions",
    },
    {
      // The shared contract kit's own decode bound, reached through the
      // shipped decoder: proves this guarded path is not dead code.
      title: "a string past the shared contract decode bound",
      response: () => {
        const proposal = sourceObligationProposalFixture();
        proposal.dimensions[0]!.reason = "a".repeat(CONTRACT_MAX_STRING_CHARS + 1);
        return JSON.stringify(proposal);
      },
      code: "bounds-exceeded",
      location: "$",
    },
    {
      title: "one dimension too many",
      response: () => {
        const proposal = sourceObligationProposalFixture();
        proposal.dimensions.push({ ...proposal.dimensions[0]! });
        return JSON.stringify(proposal);
      },
      code: "bounds-exceeded",
      location: "$.dimensions",
    },
    {
      title: "the same dimension assessed twice",
      response: () => {
        const proposal = sourceObligationProposalFixture();
        proposal.dimensions[1]!.dimension = proposal.dimensions[0]!.dimension;
        return JSON.stringify(proposal);
      },
      code: "duplicate-entry",
      location: "$.dimensions[].dimension",
    },
    {
      title: "a reason of the wrong type",
      response: () => {
        const proposal = sourceObligationProposalFixture();
        proposal.dimensions[0]!.reason = 12 as unknown as string;
        return JSON.stringify(proposal);
      },
      code: "invalid-value",
      location: "$.dimensions[].reason",
    },
    // A locator that is not physically specific, or that carries a repository
    // revision suffix, is degraded rather than refused;
    // `source-obligation-locator-degradation.test.ts` covers those replies.
    {
      title: "a dimension that omits the locators its own status requires",
      response: () => {
        const proposal = sourceObligationProposalFixture();
        proposal.dimensions[0]!.sourceLocators = [];
        return JSON.stringify(proposal);
      },
      code: "dimension-not-applicable-unsourced",
      location: "$.dimensions[].sourceLocators",
    },
    {
      title: "a status that disagrees with the obligations carried",
      response: () => {
        const proposal = sourceObligationProposalFixture();
        proposal.dimensions[0] = {
          ...proposal.dimensions[0]!,
          status: "applicable",
          sourceLocators: [],
          obligations: [],
        };
        return JSON.stringify(proposal);
      },
      code: "dimension-applicable-without-obligations",
      location: "$.dimensions[].obligations",
    },
    {
      title: "a not-applicable dimension that carries obligations",
      response: () => {
        const proposal = proposalWithObligation();
        proposal.dimensions[0]!.status = "not-applicable";
        proposal.dimensions[0]!.sourceLocators = ["src/api.ts:1"];
        return JSON.stringify(proposal);
      },
      code: "dimension-not-applicable-with-obligations",
      location: "$.dimensions[].obligations",
    },
    {
      title: "an unverified dimension that carries obligations",
      response: () => {
        const proposal = proposalWithObligation();
        const reason = "The source does not establish this dimension.";
        proposal.dimensions[0]!.status = "unverified";
        proposal.dimensions[0]!.reason = reason;
        proposal.limitations = [reason];
        return JSON.stringify(proposal);
      },
      code: "dimension-unverified-with-obligations",
      location: "$.dimensions[].obligations",
    },
    {
      title: "an evidence class outside its enumeration",
      response: () => {
        const proposal = proposalWithObligation();
        proposal.dimensions[0]!.obligations[0]!.evidenceClass =
          "assertion" as (typeof proposal.dimensions)[number]["obligations"][number]["evidenceClass"];
        return JSON.stringify(proposal);
      },
      code: "invalid-value",
      location: "$.dimensions[].obligations[].evidenceClass",
    },
    {
      title: "more limitations than the contract bounds",
      response: () => {
        const proposal = sourceObligationProposalFixture();
        proposal.limitations = Array.from(
          { length: 65 },
          (_entry, index) => `Limitation ${index}.`,
        );
        return JSON.stringify(proposal);
      },
      code: "bounds-exceeded",
      location: "$.limitations",
    },
    {
      title: "the same limitation repeated",
      response: () => {
        const proposal = sourceObligationProposalFixture();
        proposal.limitations = ["The fixture bounds this run.", "The fixture bounds this run."];
        return JSON.stringify(proposal);
      },
      code: "duplicate-entry",
      location: "$.limitations",
    },
  ];

  /**
   * Run one response through the shipped step, not the decoder alone: the
   * attempt evidence it returns is the record an operator reads back.
   */
  async function executeSourceObligationStep(
    response: string,
    maxRetries = 0,
  ): Promise<InferenceStepExecution> {
    return executeInferenceStep({
      mode: "read-only",
      policy: {
        maxRetries,
        baseDelayMs: 1,
        maxDelayMs: 1,
        retryableCategories: ["malformed-response"],
      },
      sleep: async () => undefined,
      execute: async () => {
        decodeSourceObligationResponse(response);
        return { summary: "unreachable" };
      },
    });
  }

  it.each(rejectionCases)(
    "records a distinct reason through the shipped step for $title",
    async ({ response, code, location }) => {
      const execution = await executeSourceObligationStep(response());
      expect(execution.status).toBe("failed");
      if (execution.status !== "failed") throw new Error("expected a failed step");

      // The message an operator sees, derived from the same pair a tool reads.
      expect(execution.error.message).toBe(sourceObligationRejectionMessage(code, location));
      expect(projectSourceObligationRejection(execution.error)).toEqual({ code, location });

      // The retained per-attempt record carries the same pair.
      expect(execution.evidence.attempts).toHaveLength(1);
      expect(execution.evidence.attempts[0]).toMatchObject({
        outcome: "malformed-response",
        rejection: { code, location },
      });
    },
  );

  it("continues the shipped step when the model leaves a dimension reason empty", async () => {
    const proposal = sourceObligationProposalFixture();
    proposal.dimensions[0]!.reason = "";
    const execution = await executeSourceObligationStep(JSON.stringify(proposal));
    expect(execution.status).toBe("succeeded");
    expect(execution.evidence.attempts).toHaveLength(1);
    expect(
      decodeSourceObligationResponse(JSON.stringify(proposal)).dimensions[0]!.reason,
    ).toContain("Host degradation:");
  });

  it("accepts the fenced ledger the real model returns, through the shipped step", async () => {
    // Control for the rejection suite above: a conforming ledger in a Markdown
    // fence is not refused for the fence alone. Dropping the `jsonEnvelopeBody`
    // call in `decodeSourceObligationResponse` fails this step with
    // `malformed-json at $response`.
    const proposal = sourceObligationProposalFixture();
    const fenced = `Here is the source-obligation ledger:\n\n\`\`\`json\n${JSON.stringify(
      proposal,
      null,
      2,
    )}\n\`\`\`\n\nLet me know if you need the reasoning.`;
    const execution = await executeSourceObligationStep(fenced);
    expect(execution.status).toBe("succeeded");
    // The document reached the decoder unchanged: the same ledger the unfenced
    // reply decodes to, not a repaired one.
    expect(decodeSourceObligationResponse(fenced)).toEqual(
      decodeSourceObligationResponse(JSON.stringify(proposal)),
    );
  });

  it("gives every case its own reason, so no two defects read alike", async () => {
    const observed = new Map<string, string[]>();
    for (const testCase of rejectionCases) {
      const execution = await executeSourceObligationStep(testCase.response());
      if (execution.status !== "failed") throw new Error("expected a failed step");
      const rejection = execution.evidence.attempts[0]?.rejection;
      const key = `${rejection?.code} ${rejection?.location}`;
      observed.set(key, [...(observed.get(key) ?? []), testCase.title]);
    }
    // Cases that intentionally share a pair are grouped; every distinct defect
    // class still has a pair no other class uses. Collapsing two reasons into
    // one merges two of these groups and fails the count.
    expect(observed.size).toBe(
      new Set(rejectionCases.map(({ code, location }) => `${code} ${location}`)).size,
    );
    expect(observed.size).toBeGreaterThan(1);
    for (const [key, titles] of observed) {
      const expected = rejectionCases.filter(({ code, location }) => `${code} ${location}` === key);
      expect(titles).toHaveLength(expected.length);
    }
  });

  it("records the reason on every retained attempt, not only the last", async () => {
    const execution = await executeSourceObligationStep("```json\n{oops}\n```", 1);
    expect(execution.status).toBe("failed");
    if (execution.status !== "failed") throw new Error("expected a failed step");
    // Both attempts carry a reason.
    expect(execution.evidence.attempts).toHaveLength(2);
    for (const attempt of execution.evidence.attempts) {
      expect(attempt).toMatchObject({
        outcome: "malformed-response",
        rejection: { code: "malformed-json", location: "$response" },
      });
    }
    expect(execution.evidence.attempts[0]).toMatchObject({ retryScheduled: true });
    expect(execution.evidence.attempts[1]).toMatchObject({ retryScheduled: false });
  });

  it("keeps the reason when the harness attaches this attempt's evidence", () => {
    let thrown: unknown;
    try {
      decodeSourceObligationResponse("```json\n{oops}\n```");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(InferenceStepError);
    // The harness seam rebuilds the error, and the reason must survive it on
    // the way to the record.
    const wrapped = wrapSourceObligationFailure(thrown as InferenceStepError, {
      usage: { input: 1, output: 1, total: 2, turns: 1 } as never,
    });
    expect(wrapped.evidence?.usage).toBeDefined();
    expect(projectSourceObligationRejection(wrapped)).toEqual({
      code: "malformed-json",
      location: "$response",
    });
  });

  it("survives the closed-key attempt record validators", async () => {
    const execution = await executeSourceObligationStep("```json\n{oops}\n```");
    if (execution.status !== "failed") throw new Error("expected a failed step");
    const attempt = {
      ...execution.evidence.attempts[0]!,
      identity: { repositoryRevision: "a".repeat(40) },
      turns: [],
    };
    // A record decoder that had not admitted the key would refuse the attempt
    // outright, so this is what proves the reason can be written and read back.
    expect(() => migrateLegacyInferenceAttemptEvidence(attempt)).not.toThrow();

    // And the key must stay optional. Admitting it as a required one refuses
    // every attempt that carries no coded reason, including every succeeded
    // attempt and every record that predates the key.
    const { rejection: _absent, ...withoutReason } = attempt;
    expect(withoutReason).not.toHaveProperty("rejection");
    expect(() => migrateLegacyInferenceAttemptEvidence(withoutReason)).not.toThrow();
    expect(() =>
      migrateLegacyInferenceAttemptEvidence({
        ...attempt,
        rejection: { code: "invalid-json" } as never,
      }),
    ).toThrow();
    expect(() =>
      migrateLegacyInferenceAttemptEvidence({
        ...attempt,
        rejection: { code: "invalid-json", location: "$response", note: "extra" } as never,
      }),
    ).toThrow();
    // The 256-character bound, at the limit and at the limit plus one. Exercised
    // on `location` because that is the field whose grammar admits a value that
    // long; the `code` grammar caps far shorter on its own.
    const segment = (length: number): string => `.${"a".repeat(length)}`;
    const atLimitLocation = `$${segment(63)}${segment(63)}${segment(63)}${segment(62)}`;
    expect(atLimitLocation).toHaveLength(MAX_INFERENCE_REJECTION_REASON_LENGTH);
    expect(() =>
      migrateLegacyInferenceAttemptEvidence({
        ...attempt,
        rejection: { code: "invalid-json", location: atLimitLocation },
      }),
    ).not.toThrow();
    expect(() =>
      migrateLegacyInferenceAttemptEvidence({
        ...attempt,
        rejection: { code: "invalid-json", location: `${atLimitLocation}a` } as never,
      }),
    ).toThrow();

    // Grammar, not vocabulary: free prose and an indexed location are refused.
    expect(() =>
      migrateLegacyInferenceAttemptEvidence({
        ...attempt,
        rejection: {
          code: "the model said the token is hunter2 and the path is /srv/docsfab",
          location: "$response",
        } as never,
      }),
    ).toThrow();
    expect(() =>
      migrateLegacyInferenceAttemptEvidence({
        ...attempt,
        rejection: {
          code: "invalid-value",
          location: "$.dimensions[3].obligations[7].statement",
        } as never,
      }),
    ).toThrow();
  });

  it("keeps every placeholder reason inside the grammar it stands in for", () => {
    // A placeholder that did not satisfy the grammar would be refused by the
    // same decoders it exists to keep readable -- the write boundary would then
    // turn one unreadable reason into an unreadable record, which is the exact
    // failure it is there to prevent.
    for (const placeholder of Object.values(UNRETAINABLE_INFERENCE_REJECTIONS)) {
      expect(isRetainableInferenceRejection(placeholder)).toBe(true);
      expect(retainedInferenceRejection(placeholder)).toEqual(placeholder);
      // Not a decoder's vocabulary: reading one back means the writer refused a
      // reason, never that a response failed this way.
      expect(SOURCE_OBLIGATION_REJECTION_CODES).not.toContain(placeholder.code);
    }
    // A conforming reason is returned unchanged -- the control that stops the
    // assertions above passing because everything becomes a placeholder.
    expect(retainedInferenceRejection({ code: "invalid-json", location: "$response" })).toEqual({
      code: "invalid-json",
      location: "$response",
    });
  });

  it("admits an identifier segment at the catalog cap and refuses one character more", async () => {
    // `inference.rejectionSegmentLength` is one entry in config/limits.yaml and
    // both grammars are generated from it, so the code cap and the location
    // member cap are proved together and cannot drift apart. The value is
    // pinned literally: fixtures built from the grammar's own constant would
    // pass at any value while the bound drifted.
    expect(MAX_INFERENCE_REJECTION_SEGMENT_LENGTH).toBe(64);
    const atLimit = "a".repeat(64);
    const overLimit = "a".repeat(65);
    expect(isRetainableInferenceRejection({ code: atLimit, location: `$.${atLimit}` })).toBe(true);
    expect(isRetainableInferenceRejection({ code: overLimit, location: "$response" })).toBe(false);
    expect(
      isRetainableInferenceRejection({ code: "invalid-value", location: `$.${overLimit}` }),
    ).toBe(false);

    // And through a real record decoder, so the cap is a decode rule rather
    // than a predicate no shipped reader consults.
    const execution = await executeSourceObligationStep("```json\n{oops}\n```");
    if (execution.status !== "failed") throw new Error("expected a failed step");
    const attempt = {
      ...execution.evidence.attempts[0]!,
      identity: { repositoryRevision: "a".repeat(40) },
      turns: [],
    };
    expect(() =>
      migrateLegacyInferenceAttemptEvidence({
        ...attempt,
        rejection: { code: atLimit, location: `$.${atLimit}` },
      }),
    ).not.toThrow();
    expect(() =>
      migrateLegacyInferenceAttemptEvidence({
        ...attempt,
        rejection: { code: overLimit, location: "$response" } as never,
      }),
    ).toThrow();
    expect(() =>
      migrateLegacyInferenceAttemptEvidence({
        ...attempt,
        rejection: { code: "invalid-value", location: `$.${overLimit}` } as never,
      }),
    ).toThrow();
  });

  it("records why a reason could not be retained instead of dropping it", async () => {
    // The write boundary is the one place a non-conforming decoder could put an
    // undecodable value into a record. Persisting a 4096-character location
    // would not merely record a bad reason -- it would produce a run record all
    // three closed-key decoders refuse, losing the whole record rather than one
    // field. Dropping it silently is not the answer either: absence already
    // means "no reason was recorded", so a reader could not tell that from
    // "a reason was raised and thrown away". A placeholder says which happened.
    const execution = await executeInferenceStep({
      mode: "read-only",
      policy: {
        maxRetries: 0,
        baseDelayMs: 1,
        maxDelayMs: 1,
        retryableCategories: ["malformed-response"],
      },
      sleep: async () => undefined,
      execute: async () => {
        throw new InferenceStepError("Forged.", "malformed-response", true, undefined, {
          code: "invalid-value",
          location: "x".repeat(4096),
        });
      },
    });
    expect(execution.status).toBe("failed");
    if (execution.status !== "failed") throw new Error("expected a failed step");
    const overLong = execution.evidence.attempts[0]?.rejection;
    expect(overLong).toEqual({ code: "unretainable-reason-too-long", location: "$response" });
    // The offending value itself reaches nothing.
    expect(JSON.stringify(execution.evidence.attempts)).not.toContain("xxxx");
    // The step's own outcome is untouched by what the diagnostic could retain.
    expect(execution.evidence.attempts[0]?.outcome).toBe("malformed-response");
    // ...and the placeholder is readable back: the record still decodes.
    expect(() =>
      migrateLegacyInferenceAttemptEvidence({
        ...execution.evidence.attempts[0]!,
        identity: { repositoryRevision: "a".repeat(40) },
        turns: [],
      }),
    ).not.toThrow();

    // An indexed location is refused at the write boundary for the same reason.
    const indexed = await executeInferenceStep({
      mode: "read-only",
      policy: {
        maxRetries: 0,
        baseDelayMs: 1,
        maxDelayMs: 1,
        retryableCategories: ["malformed-response"],
      },
      sleep: async () => undefined,
      execute: async () => {
        throw new InferenceStepError("Forged.", "malformed-response", true, undefined, {
          code: "invalid-value",
          location: "$.dimensions[3].obligations[7].statement",
        });
      },
    });
    if (indexed.status !== "failed") throw new Error("expected a failed step");
    // Off-grammar rather than over-long, and the record says which.
    expect(indexed.evidence.attempts[0]?.rejection).toEqual({
      code: "unretainable-reason-off-grammar",
      location: "$response",
    });
    expect(JSON.stringify(indexed.evidence.attempts)).not.toContain("obligations[7]");
    expect(() =>
      migrateLegacyInferenceAttemptEvidence({
        ...indexed.evidence.attempts[0]!,
        identity: { repositoryRevision: "a".repeat(40) },
        turns: [],
      }),
    ).not.toThrow();

    // A conforming reason is still persisted -- the control that stops the
    // two assertions above passing because nothing is ever written.
    const conforming = await executeSourceObligationStep("```json\n{oops}\n```");
    if (conforming.status !== "failed") throw new Error("expected a failed step");
    expect(conforming.evidence.attempts[0]?.rejection).toEqual({
      code: "malformed-json",
      location: "$response",
    });
  });

  it("names the reason in the operator run summary for a failed step", async () => {
    const execution = await executeSourceObligationStep("```json\n{oops}\n```");
    if (execution.status !== "failed") throw new Error("expected a failed step");
    const record = {
      steps: [
        {
          id: "derive-source-obligations",
          status: "failed",
          error: execution.error.message,
        },
      ],
      error: execution.error.message,
    } as unknown as RunRecord;
    const lines = formatRunFailureDiagnosticLines(record);
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line).toContain("malformed-json");
      expect(line).toContain("$response");
    }
    // The operator text does not stop at the stem alone.
    expect(lines.some((line) => line.trim().endsWith(SOURCE_OBLIGATION_REJECTION_ERROR))).toBe(
      false,
    );
  });

  it("attaches no reason when a response satisfies the contract", async () => {
    const proposal = sourceObligationProposalFixture();
    const execution = await executeInferenceStep({
      mode: "read-only",
      policy: {
        maxRetries: 1,
        baseDelayMs: 1,
        maxDelayMs: 1,
        retryableCategories: ["malformed-response"],
      },
      sleep: async () => undefined,
      execute: async () => ({
        summary: canonicalSourceObligationProposal(
          decodeSourceObligationResponse(JSON.stringify(proposal)),
        ),
      }),
    });
    expect(execution.status).toBe("succeeded");
    if (execution.status !== "succeeded") throw new Error("expected a succeeded step");
    expect(execution.evidence.attempts).toHaveLength(1);
    // Absence is the reading: a succeeded attempt has no rejection to record.
    expect(execution.evidence.attempts[0]).toMatchObject({ outcome: "succeeded" });
    expect(execution.evidence.attempts[0]?.rejection).toBeUndefined();
    expect("rejection" in execution.evidence.attempts[0]!).toBe(false);
  });

  it("retains no response content, not even when the response is credential-shaped", async () => {
    // A token-shaped value in a field the decoder refuses. Nothing about it may
    // reach the message or the attempt record: the reason is content-free by
    // construction, so the whole response body stays out of retained evidence.
    const secret = `glpat-${"A1b2C3d4E5f6G7h8J9k0".slice(0, 20)}`;
    const proposal = sourceObligationProposalFixture();
    proposal.dimensions[0]!.reason = secret;
    const execution = await executeSourceObligationStep(JSON.stringify(proposal));
    expect(execution.status).toBe("failed");
    if (execution.status !== "failed") throw new Error("expected a failed step");
    const serialized = JSON.stringify({
      message: execution.error.message,
      attempts: execution.evidence.attempts,
    });
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("glpat-");
    // The credential scan runs over the whole response before any field is
    // admitted, so the reason names that refusal rather than a field position.
    // It is still a reason, and it is still content-free.
    expect(execution.evidence.attempts[0]?.rejection).toEqual({
      code: "credential-material",
      location: "$",
    });
  });

  it("keeps the message and the coded pair from drifting apart", () => {
    for (const code of SOURCE_OBLIGATION_REJECTION_CODES) {
      for (const location of SOURCE_OBLIGATION_REJECTION_LOCATIONS) {
        const message = sourceObligationRejectionMessage(code, location);
        expect(message.startsWith(SOURCE_OBLIGATION_REJECTION_ERROR.slice(0, -1))).toBe(true);
        expect(sourceObligationRejectionFromMessage(message)).toEqual({ code, location });
        // A credential-shaped `<word>: <token>` reading must never be produced.
        expect(message).not.toMatch(/:\s*\S+$/u);
      }
    }
    // Older records carry the bare stem and read back as historical-generic.
    expect(sourceObligationRejectionFromMessage(SOURCE_OBLIGATION_REJECTION_ERROR)).toBe(
      "historical-generic",
    );
    expect(sourceObligationRejectionFromMessage("Some other failure.")).toBeUndefined();
  });

  it("gives every strict-JSON parser code its own rejection code", () => {
    // The parser's union is closed and host-owned. This table is exhaustive
    // over it by type -- a sixth `JsonEvidenceErrorCode` fails to compile here
    // and in `JSON_REJECTION_CODES` beside the decoder -- so a later parser
    // addition cannot quietly fall back into one shared reason.
    const parserCodes = {
      "invalid-utf8": "invalid-utf8",
      "malformed-json": "malformed-json",
      "duplicate-key": "duplicate-key",
      "unsafe-number": "unsafe-number",
      "noncanonical-json": "noncanonical-json",
    } satisfies Record<JsonEvidenceErrorCode, SourceObligationRejectionCode>;
    const codes = Object.values(parserCodes);
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) {
      expect(SOURCE_OBLIGATION_REJECTION_CODES).toContain(code);
      // Already inside the retained grammar, so none of them needs a bound or a
      // catalog change to reach a record.
      expect(isRetainableInferenceRejection({ code, location: "$response" })).toBe(true);
    }
    // `invalid-json` stays, as the fail-closed answer for a parse that failed
    // without the host parser naming a reason. It is not one of the five.
    expect(SOURCE_OBLIGATION_REJECTION_CODES).toContain("invalid-json");
    expect(codes).not.toContain("invalid-json");
  });

  it("refuses a reason forged with a vocabulary this module does not own", () => {
    const forged = new InferenceStepError("Forged.", "malformed-response", true, undefined, {
      code: "definitely-not-a-source-obligation-code",
      location: "$response",
    });
    expect(projectSourceObligationRejection(forged)).toBeUndefined();
    expect(
      projectSourceObligationRejection(
        new InferenceStepError("Forged.", "malformed-response", true, undefined, {
          code: "invalid-json",
          location: "/etc/passwd",
        }),
      ),
    ).toBeUndefined();
    expect(
      projectSourceObligationRejection(new Error("not an inference step error")),
    ).toBeUndefined();
  });
});

describe("paths in model content", () => {
  const PROSE = "The CLI runs under /usr/bin/env as /home/node, logs file:42, and writes /tmp/x.";

  it("derive-source-obligations admits a reply that cites paths in prose and seals it as written", async () => {
    const proposal = sourceObligationProposalFixture("src/api.ts:1");
    proposal.dimensions[0]!.reason = PROSE;
    proposal.limitations = [PROSE];
    const input = deriveInput();
    const reply = JSON.stringify(proposal);

    const admitted = await admitJudgmentReply(input, reply, {
      decodedResponse: reply,
      collectAttemptEvidence: () => ({}),
      refuseContractPlaceholder: () => undefined,
    });

    expect(admitted.sourceObligationProposal).toEqual(proposal);
    const ledger = bindSourceObligationLedger(admitted.sourceObligationProposal!, input, [
      { path: "src/api.ts", sha256: "f".repeat(64) },
    ]);
    expect(ledger.limitations).toEqual([PROSE]);
    expect(Object.hasOwn(ledger, "repositoryPathTokenSha256")).toBe(false);
    expect(validateSourceObligationLedger(ledger, input)).toEqual(ledger);
  });
});

describe("records written while host paths were refused", () => {
  const legacy = (name: string) =>
    JSON.parse(
      readFileSync(new URL(`./fixtures/legacy-host-path/${name}`, import.meta.url), "utf8"),
    );

  it("validates a sealed V2 ledger carrying repositoryPathTokenSha256 with its stored digest", () => {
    const { ledger, originalSourceAuthority } = legacy("sealed-ledger-v2.json");
    expect(ledger.repositoryPathTokenSha256).toHaveLength(1);

    const validated = validateSourceObligationLedger(ledger, undefined, originalSourceAuthority);

    expect(validated).toEqual(ledger);
    expect(validated.digest).toBe(ledger.digest);
  });

  it.each([
    ["an empty list", []],
    ["a value that is not a digest", ["/usr/bin/env"]],
    ["an unsorted list", ["b".repeat(64), "a".repeat(64)]],
    ["a repeated digest", ["a".repeat(64), "a".repeat(64)]],
  ])("refuses a retained token list that is %s", (_label, tokens) => {
    const { ledger, originalSourceAuthority } = legacy("sealed-ledger-v2.json");
    const { digest: _digest, ...content } = { ...ledger, repositoryPathTokenSha256: tokens };
    const resealed = { ...content, digest: canonicalDigest(content) };
    expect(() =>
      validateSourceObligationLedger(resealed, undefined, originalSourceAuthority),
    ).toThrow(
      "Source-obligation V2 repository path tokens are not a sorted list of distinct digests.",
    );
  });

  it("decodes, indexes, and summarizes an attempt that recorded hostPathDisclosure", () => {
    const attempt = legacy("refused-attempt.json") as InferenceAttemptEvidence;
    expect(attempt.hostPathDisclosure).toEqual({ root: "usr", inAdmittedSource: "no" });
    const inference = {
      configuredMaxRetries: 1,
      effectiveMaxRetries: 1,
      baseDelayMs: 1,
      maxDelayMs: 1,
      retryableCategories: ["malformed-response"],
      replay: "read-only",
      attempts: [attempt],
    };
    // The one closed-shape check every attempt reader applies.
    expect(isLegacyHostPathDisclosure(attempt.hostPathDisclosure)).toBe(true);
    for (const altered of [
      { root: "usr" },
      { root: "usr", inAdmittedSource: "yes" },
      { root: "/usr/bin/env", inAdmittedSource: "no" },
      { root: "usr", inAdmittedSource: "no", path: "/usr/bin/env" },
    ]) {
      expect(isLegacyHostPathDisclosure(altered)).toBe(false);
    }
    expect(() => migrateLegacyInferenceAttemptEvidence(attempt)).not.toThrow();
    expect(() =>
      migrateLegacyInferenceAttemptEvidence({
        ...attempt,
        hostPathDisclosure: { root: "/usr/bin/env", inAdmittedSource: "no" },
      } as unknown as InferenceAttemptEvidence),
    ).toThrow();

    const step = {
      id: "derive-source-obligations",
      title: "Derive source obligations",
      kind: "evaluate",
      skill: "verify-technical-accuracy",
      mode: "read-only",
      status: "failed",
      inference,
    } as unknown as RunRecord["steps"][number];
    expect(formatStepRejectionSentence(step)).toBe("Rejected by host-path-disclosure at $.");
    const projection = projectRunIndexRows(
      {
        schemaVersion: 2,
        id: "run-legacy-host-path",
        workflow: "review-documentation",
        status: "failed",
        createdAt: "2026-09-24T16:50:01.678Z",
        repository: { sourcePath: "/fixture/repository", revision: "b".repeat(40) },
        steps: [step],
      },
      {
        origin: "import",
        snapshotId: "snapshot-1",
        indexedAt: "2026-09-24T17:00:00.000Z",
        recordSha256: "a".repeat(64),
        fieldMaxChars: 512,
      },
    );
    if (!projection.ok) throw new Error(projection.reason);
    expect(projection.rows.find((row) => row.rowKind === "attempt")).toMatchObject({
      rejectionCode: "host-path-disclosure",
      hostPathRoot: "usr",
      hostPathInAdmittedSource: "no",
      omittedFields: [],
    });
  });
});

function phase(
  id: string,
  skill = id,
  kind: WorkflowStep["kind"] = "evaluate",
  mode: WorkflowStep["mode"] = "read-only",
): WorkflowStep {
  return { id, title: id, kind, skill, mode, prompt: `${id} fixture` };
}

function createWorkflow(): WorkflowDefinition {
  const steps = [
    phase("plan-documentation"),
    phase("derive-source-obligations", "verify-technical-accuracy"),
    phase("write-documentation", "write-documentation", "inference", "write"),
    phase("lint-documentation", "lint-documentation", "host-operation"),
    phase("provisional-technical-verification", "verify-technical-accuracy"),
    phase("verify-technical-accuracy"),
    phase("review-documentation"),
  ];
  return workflow("create-documentation", steps);
}

function historicalCreateWorkflow(): WorkflowDefinition {
  return workflow("create-documentation", [
    phase("plan-documentation"),
    phase("write-documentation", "write-documentation", "inference", "write"),
    phase("lint-documentation", "lint-documentation", "host-operation"),
    phase("verify-technical-accuracy"),
    phase("review-documentation"),
    phase("evaluate-document-quality"),
  ]);
}

function historicalCreateWorkflowWithRetiredCatalogDerive(): WorkflowDefinition {
  return workflow("create-documentation", [
    phase("plan-documentation"),
    phase("derive-source-obligations", "derive-source-obligations"),
    phase("write-documentation", "write-documentation", "inference", "write"),
    phase("lint-documentation", "lint-documentation", "host-operation"),
    phase("provisional-technical-verification", "verify-technical-accuracy"),
    phase("verify-technical-accuracy"),
    phase("review-documentation"),
    phase("test-audience-understanding"),
    phase("evaluate-document-quality"),
  ]);
}

function reviewWorkflow(): WorkflowDefinition {
  return workflow("review-documentation", [
    phase("audit-documentation"),
    phase("derive-source-obligations", "verify-technical-accuracy"),
    phase("lint-documentation", "lint-documentation", "host-operation"),
    phase("provisional-technical-verification", "verify-technical-accuracy"),
    phase("verify-technical-accuracy"),
    phase("review-documentation"),
  ]);
}

function createWorkflowV3(corrected: boolean): WorkflowDefinition {
  const beforeFinal = [
    phase("plan-documentation"),
    phase("derive-source-obligations", "verify-technical-accuracy"),
    phase("write-documentation", "write-documentation", "inference", "write"),
    phase("lint-documentation", "lint-documentation", "host-operation"),
    phase("provisional-technical-verification", "verify-technical-accuracy"),
  ];
  const finalAndReview = corrected
    ? [phase("review-documentation"), phase("verify-technical-accuracy")]
    : [phase("verify-technical-accuracy"), phase("review-documentation")];
  const steps = [
    ...beforeFinal,
    ...finalAndReview,
    phase("revise-documentation", "write-documentation", "inference", "write"),
    phase("lint-revised-documentation", "lint-documentation", "host-operation"),
    phase("provisional-revised-technical-verification", "verify-technical-accuracy"),
    phase("verify-revised-technical-accuracy", "verify-technical-accuracy"),
    phase("review-revised-documentation", "review-documentation"),
    phase("test-audience-understanding"),
    phase("evaluate-document-quality"),
  ];
  return {
    ...workflow("create-documentation", steps),
    schemaVersion: 3,
    // The source-obligation contract detects retained V3 schedules by this
    // host-owned marker.
    authoringSchedule: {} as NonNullable<WorkflowDefinition["authoringSchedule"]>,
  };
}

function workflow(name: WorkflowDefinition["name"], steps: WorkflowStep[]): WorkflowDefinition {
  return {
    schemaVersion: 1,
    name,
    title: `${name} source-obligation fixture`,
    outcome: "Exercise the exact source-obligation phase boundary.",
    steps,
    contextPolicy: {
      schemaVersion: 1,
      steps: steps.map((step) => ({
        stepId: step.id,
        required: true,
        level: "corpus",
        query: "expand",
        allowReadOnlyDegraded: step.mode === "read-only",
      })),
    },
  };
}

function deriveInput(): HarnessStepInput {
  const workflow = createWorkflow();
  const step = workflow.steps.find((candidate) => candidate.id === "derive-source-obligations")!;
  return {
    repositoryPath: "/workspace",
    workflow,
    step,
    planBinding: createPlanBinding("docs/guide.md"),
    evidenceIdentity: {
      repositoryRevision: "a".repeat(40),
    } as HarnessStepInput["evidenceIdentity"],
    searchEvidence: searchStepEvidence({
      evidenceSha256: "b".repeat(64),
      workspaceSnapshotSha256: "c".repeat(64),
    }),
  };
}

function createPlanBinding(pagePath = "docs/new-guide.md", sources = ["src/api.ts:1"]) {
  const pages = [{ path: pagePath, disposition: "create" as const }];
  const sourceBindings = [{ pagePath, sources }];
  return {
    kind: "docsfab-documentation-plan" as const,
    schemaVersion: 1 as const,
    mode: "create" as const,
    pages,
    sourceBindings,
    digest: documentationPlanBindingDigest({ mode: "create", pages, sourceBindings }),
  };
}

function proposalWithObligation(): SourceObligationLedgerProposalV1 {
  const proposal = sourceObligationProposalFixture();
  proposal.dimensions[0] = {
    dimension: "input-representations",
    status: "applicable",
    reason: "The accepted operation has one structured input representation.",
    sourceLocators: [],
    obligations: [
      {
        id: "OBL-INPUT-1",
        dimension: "input-representations",
        sourceLocators: ["src/api.ts:1"],
        statement: "The operation accepts the source-defined object input.",
        evidenceClass: "source-observation",
        uncertainty: "The observation is bounded to the accepted source span.",
      },
    ],
  };
  return proposal;
}

/**
 * Assert the rejection's coded pair rather than its prose.
 *
 * The pair is what a retained record carries, so asserting it is what
 * proves an operator can tell these rejections apart from evidence alone. The
 * message is checked too, because it is derived from the same pair and must
 * not drift from it.
 */
function expectInvalidProposal(
  mutate: (candidate: SourceObligationLedgerProposalV1) => void,
  expected: { code: SourceObligationRejectionCode; location: SourceObligationRejectionLocation },
): void {
  const candidate = sourceObligationProposalFixture();
  mutate(candidate);
  let thrown: unknown;
  try {
    validateSourceObligationProposal(candidate, deriveInput());
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(InferenceStepError);
  expect(projectSourceObligationRejection(thrown)).toEqual(expected);
  expect((thrown as InferenceStepError).message).toBe(
    sourceObligationRejectionMessage(expected.code, expected.location),
  );
}

function expectAccountingFailure(
  ledger: Parameters<typeof bindTechnicalCorrectionResponse>[1],
  verification: ReturnType<typeof verificationResultFixture>,
  row: unknown,
  expectedMessage: string,
): void {
  expect(() =>
    bindTechnicalCorrectionResponse(
      { verificationResult: verification, obligationAccounting: [row] },
      ledger,
      (value) => value as typeof verification,
    ),
  ).toThrow(expectedMessage);
}

async function repositoryFixture(): Promise<{ root: string; source: string }> {
  const root = await mkdtemp(join(tmpdir(), "docsfab-source-obligation-contracts-"));
  const source = join(root, "source");
  await initFixtureRepo(
    source,
    {
      "src/api.ts": "export const value = 1;\n",
      "src/Alpha.ts": "export const alpha = 1;\n",
      "src/extra.ts": "export const extra = 1;\n",
      "docs/guide.md": "# Guide\n\nBounded fixture.\n",
    },
    { branch: "main" },
  );
  return { root, source };
}
