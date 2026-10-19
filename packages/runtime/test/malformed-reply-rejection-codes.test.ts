// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { retainedInferenceRejection } from "../src/config/inference-rejection-limits.js";
import { isOutputRuleCode } from "../src/contracts/model-output.js";
import {
  InferenceStepError,
  type HarnessStepInput,
  type InferenceRejectionReasonV1,
  type InferenceRetryPolicy,
} from "../src/execution/contracts.js";
import {
  resolveRejectedReplyShapePolicy,
  retainRejectedReplyShape,
} from "../src/execution/rejected-reply-retention.js";
import type { ReplyAdmissionContext } from "../src/harness/reply-admission/context.js";
import { jsonEnvelopeBody } from "../src/execution/json-envelope.js";
import { admitEditorialAssessmentReply } from "../src/harness/reply-admission/editorial-assessment.js";
import { admitPlannerReply } from "../src/harness/reply-admission/planner.js";
import { admitQualityArtifactReply } from "../src/harness/reply-admission/quality-artifact.js";
import { admitReviewResultReply } from "../src/harness/reply-admission/review-result.js";
import {
  responseCorrectionInstruction,
  UNCODED_RESPONSE_CORRECTION,
} from "../src/harness/response-correction.js";
import {
  classifyInferenceAttempt,
  inferenceRejectionFailureClass,
} from "../src/operator/failure-classification.js";
import { isJsonEvidence, parseJsonEvidence } from "../src/json-evidence.js";
import { formatRunFailureDiagnosticLines } from "../src/operator/run-summary.js";
import type { RunRecord } from "../src/records/contracts.js";
import { projectRunIndexRows } from "../src/records/run-index.js";
import { executeInferenceStep } from "../src/workflow-execution/retry.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import { configureCredentialsForEachTest } from "./helpers/configured-credential.js";

/**
 * Every refusal on the planner, editorial assessment envelope, and review
 * result admission paths names the closed rule it broke and where.
 */

const REVISION = "0bd6fa60ceefdf49d8b92fb760d446cda3434761";
const PAGE = "docs/cli-reference.md";
const RATIONALE =
  "The admitted public source changed while the guide still documents the old option.";
/** Built at run time so no credential-shaped literal sits in the repository. */
// Assembled so no complete key literal sits in the source; configured for
// every test, since only a configured credential refuses a reply (#1807).
const CREDENTIAL = `sk-${["Xq7L", "m2Rt", "9Wk4", "Hn3B", "vC8z", "Pd5G", "Jf6S", "Tw1Y"].join("")}`;
configureCredentialsForEachTest(CREDENTIAL);

const ADMITTED_REF = Object.freeze({
  kind: "context-packet" as const,
  schemaVersion: 1 as const,
  digest: "c".repeat(64),
  repositoryRevision: "d".repeat(40),
  repositoryContentDigest: "e".repeat(64),
});

function context(reply: string): ReplyAdmissionContext {
  return {
    decodedResponse: reply,
    collectAttemptEvidence: () => ({}),
    refuseContractPlaceholder: () => undefined,
  };
}

function refusal(run: () => unknown): InferenceStepError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(InferenceStepError);
    return error as InferenceStepError;
  }
  throw new Error("The reply was admitted.");
}

// ---------------------------------------------------------------- planner

function plannerInput(workflow = "create-documentation"): HarnessStepInput {
  return {
    workflow: { name: workflow, schemaVersion: 1, steps: [] },
    step: {
      id: "plan-documentation",
      skill: "plan-documentation",
      mode: "read-only",
    },
    evidenceIdentity: { repositoryRevision: REVISION },
  } as unknown as HarnessStepInput;
}

/** The update-documentation V2 planner, which also returns a decision judgment. */
function editorialPlannerInput(): HarnessStepInput {
  const workflow = getWorkflow("update-documentation");
  const readerContextInput = {
    schema_version: 1 as const,
    target_audience: "Orbit users",
    reader_job: "run an inspection",
    change_scope: ["docs/cli.md"],
    source_priority: ["public contract"],
    required_content: ["current command"],
    excluded_content: [],
    unresolved_questions: [],
  };
  const policy = {
    id: "docsfab-documentation-quality",
    version: "v0.1",
    sha256: "b".repeat(64),
  };
  return {
    repositoryPath: "/tmp/repository",
    workflow,
    step: workflow.steps.find((step) => step.skill === "plan-documentation")!,
    evidenceIdentity: { repositoryRevision: REVISION },
    readerContextInput,
    readerTaskContext: {
      schemaVersion: 1 as const,
      kind: "docsfab-reader-task-context-input" as const,
      inputOrigin: "explicit" as const,
      noChangeAssessment: "requires-evidence" as const,
      readerContextInput,
      baseline: {
        path: "profiles/docsfab-documentation-quality/reader-impact-baseline.md" as const,
        sha256: "a".repeat(64),
        content: "Use actual reader and source evidence.",
      },
      policy,
      prompt: "Verified reader task context.",
    },
    readerContextProvenance: {
      schema_version: 1,
      reader_context_sha256: "1".repeat(64),
      baseline_sha256: "a".repeat(64),
      admitted_revision: ADMITTED_REF.repositoryRevision,
      workspace_snapshot_sha256: "2".repeat(64),
      repository_identity_sha256: "3".repeat(64),
      policy,
      comparison: { kind: "unknown" },
      sources: [
        {
          uri: "repo://src/orbit.ts",
          sha256: "f".repeat(64),
          role: "public-contract",
        },
      ],
      observed_at: "2026-09-16T12:00:00.000Z",
      limitations: [],
    },
    editorialEvidenceRefs: [ADMITTED_REF],
  } as unknown as HarnessStepInput;
}

type Json = Record<string, unknown>;

function plan(overrides: Json = {}, mode = "create", disposition = "create"): Json {
  return {
    summary: "Plan one CLI reference page from the CLI source.",
    planBinding: {
      mode,
      pages: [{ path: PAGE, disposition }],
      sourceBindings: [{ pagePath: PAGE, sources: ["src/cli.ts"] }],
    },
    ...overrides,
  };
}

function binding(overrides: Json, mode = "create"): string {
  return JSON.stringify(
    plan({
      planBinding: {
        ...(plan({}, mode, mode).planBinding as Json),
        ...overrides,
      },
    }),
  );
}

interface Case {
  readonly name: string;
  readonly reply: string;
  readonly rejection: InferenceRejectionReasonV1;
  readonly workflow?: string;
  readonly retryable?: boolean;
}

const PLANNER_CASES: readonly Case[] = [
  {
    name: "prose with no JSON document",
    reply: "I could not produce a documentation plan for this request.",
    rejection: { code: "invalid-json", location: "$" },
  },
  {
    // One fenced plan is the plan; two are an ambiguity the shared extraction
    // policy refuses rather than guess between.
    name: "two plans in two Markdown fences",
    reply: `\`\`\`json\n${JSON.stringify(plan())}\n\`\`\`\nor\n\`\`\`json\n${JSON.stringify(plan())}\n\`\`\``,
    rejection: { code: "reply-json-wrapped", location: "$" },
  },
  {
    // The fence is opened, so the refusal names the document inside it.
    name: "a Markdown fence around a broken plan",
    reply: `\`\`\`json\n${JSON.stringify(plan()).slice(0, -1)}\n\`\`\``,
    rejection: { code: "invalid-json", location: "$" },
  },
  {
    // The fence is opened, so a rule inside the document is named.
    name: "a Markdown fence around a plan with an empty summary",
    reply: `\`\`\`json\n${JSON.stringify(plan({ summary: "" }))}\n\`\`\``,
    rejection: { code: "invalid-value", location: "$.summary" },
  },
  {
    // A recorded shape: sourceBindings beside planBinding.
    name: "sourceBindings hoisted beside planBinding",
    reply: JSON.stringify({
      summary: "Plan one CLI reference page from the CLI source.",
      planBinding: {
        mode: "create",
        pages: [{ path: PAGE, disposition: "create" }],
      },
      sourceBindings: [{ pagePath: PAGE, sources: ["src/cli.ts"] }],
    }),
    rejection: { code: "invalid-shape", location: "$" },
  },
  {
    name: "an empty summary",
    reply: JSON.stringify(plan({ summary: "" })),
    rejection: { code: "invalid-value", location: "$.summary" },
  },
  {
    name: "a needs-input reply with another outcome",
    reply: JSON.stringify({
      summary: "Blocked.",
      outcome: "blocked",
      reason: "missing-source",
    }),
    rejection: { code: "invalid-value", location: "$.outcome" },
  },
  {
    name: "a needs-input reply without a string reason",
    reply: JSON.stringify({
      summary: "Blocked.",
      outcome: "needs-input",
      reason: 7,
    }),
    rejection: { code: "invalid-value", location: "$.reason" },
  },
  {
    name: "credential material in the plan",
    reply: JSON.stringify(plan({ summary: `Use the token ${CREDENTIAL} to read the API.` })),
    rejection: { code: "credential-material", location: "$" },
    retryable: false,
  },
  {
    name: "a planBinding that is not an object",
    reply: JSON.stringify(plan({ planBinding: "create one page" })),
    rejection: { code: "invalid-shape", location: "$.planBinding" },
  },
  {
    name: "another workflow's mode",
    reply: binding({ mode: "update" }),
    rejection: { code: "invalid-value", location: "$.planBinding.mode" },
  },
  {
    name: "no pages",
    reply: binding({ pages: [] }),
    rejection: {
      code: "empty-required-field",
      location: "$.planBinding.pages",
    },
  },
  {
    name: "a page entry that is not an object",
    reply: binding({ pages: [PAGE] }),
    rejection: { code: "invalid-shape", location: "$.planBinding.pages[]" },
  },
  {
    name: "an unsafe page path",
    reply: binding({
      pages: [{ path: "../outside.md", disposition: "create" }],
    }),
    rejection: {
      code: "invalid-value",
      location: "$.planBinding.pages[].path",
    },
  },
  {
    // A candidate recorded restructure shape: a six-letter disposition.
    name: "a disposition the workflow does not admit",
    workflow: "restructure-documentation",
    reply: binding({ pages: [{ path: PAGE, disposition: "create" }] }, "restructure"),
    rejection: {
      code: "invalid-value",
      location: "$.planBinding.pages[].disposition",
    },
  },
  {
    name: "the same page twice",
    reply: binding({
      pages: [
        { path: PAGE, disposition: "create" },
        { path: PAGE, disposition: "create" },
      ],
    }),
    rejection: {
      code: "duplicate-entry",
      location: "$.planBinding.pages[].path",
    },
  },
  {
    name: "a changed page with no sources",
    reply: binding({ sourceBindings: [] }),
    rejection: {
      code: "documentation-plan-source-binding-coverage",
      location: "$.planBinding.sourceBindings",
    },
  },
  {
    // The other candidate recorded restructure shape.
    name: "sources bound to an out-of-scope page",
    workflow: "restructure-documentation",
    reply: binding(
      {
        pages: [
          { path: PAGE, disposition: "restructure" },
          { path: "docs/guide.md", disposition: "out-of-scope" },
        ],
        sourceBindings: [
          { pagePath: PAGE, sources: ["src/cli.ts"] },
          { pagePath: "docs/guide.md", sources: ["src/cli.ts"] },
        ],
      },
      "restructure",
    ),
    rejection: {
      code: "documentation-plan-source-binding-coverage",
      location: "$.planBinding.sourceBindings[].pagePath",
    },
  },
  {
    name: "the same page bound twice",
    reply: binding({
      sourceBindings: [
        { pagePath: PAGE, sources: ["src/cli.ts"] },
        { pagePath: PAGE, sources: ["README.md"] },
      ],
    }),
    rejection: {
      code: "duplicate-entry",
      location: "$.planBinding.sourceBindings[].pagePath",
    },
  },
  {
    name: "a binding with no sources",
    reply: binding({ sourceBindings: [{ pagePath: PAGE, sources: [] }] }),
    rejection: {
      code: "invalid-value",
      location: "$.planBinding.sourceBindings[].sources",
    },
  },
  {
    name: "an unsafe binding page path",
    reply: binding({
      sourceBindings: [{ pagePath: "docs/cli reference.md", sources: ["src/cli.ts"] }],
    }),
    rejection: {
      code: "invalid-value",
      location: "$.planBinding.sourceBindings[].pagePath",
    },
  },
  {
    // A locator refusal keeps its own catalog rule.
    name: "an unresolvable source locator",
    reply: binding({
      sourceBindings: [{ pagePath: PAGE, sources: ["src/cli.ts@HEAD"] }],
    }),
    rejection: {
      code: "plan-source-locator-grammar",
      location: "$.planBinding.sourceBindings[].sources[]",
    },
  },
];

function editorialPlan(decision: unknown): string {
  return JSON.stringify({
    ...plan({}, "update", "update"),
    editorialDecisionProposal: decision,
  });
}

describe("planner reply refusals name their rule (#1423)", () => {
  it.each(PLANNER_CASES.map((entry) => [entry.name, entry] as const))(
    "a planner reply with %s records its rule and location",
    (_name, { reply, rejection, workflow, retryable }) => {
      const error = refusal(() => admitPlannerReply(plannerInput(workflow), reply, context(reply)));
      expect(error.category).toBe("malformed-response");
      expect(error.rejection).toEqual(rejection);
      // Only credential material is terminal here.
      expect(error.retryable).toBe(retryable ?? true);
      expect(inferenceRejectionFailureClass(rejection.code)).toBeDefined();
    },
  );

  it("names the editorial decision judgment the update planner returned", () => {
    const notObject = editorialPlan("update");
    expect(
      refusal(() => admitPlannerReply(editorialPlannerInput(), notObject, context(notObject)))
        .rejection,
    ).toEqual({
      code: "invalid-shape",
      location: "$.editorialDecisionProposal",
    });
    const offVocabulary = editorialPlan({
      candidate: "rewrite",
      rationale: RATIONALE,
      slotIds: [],
    });
    expect(
      refusal(() =>
        admitPlannerReply(editorialPlannerInput(), offVocabulary, context(offVocabulary)),
      ).rejection,
    ).toEqual({
      code: "invalid-value",
      location: "$.editorialDecisionProposal",
    });
    // The judgment the contract shows is admitted.
    const admitted = editorialPlan({
      candidate: "update",
      rationale: RATIONALE,
      slotIds: ["public-contract"],
    });
    expect(admitPlannerReply(editorialPlannerInput(), admitted, context(admitted))?.outcome).toBe(
      "completed",
    );
  });
});

// ------------------------------------------------ editorial assessment envelope

function editorialStepInput(skill: string): HarnessStepInput {
  const workflow = getWorkflow("update-documentation");
  if (workflow.schemaVersion !== 2) throw new Error("update-documentation is not V2");
  const step = workflow.branching.branches
    .flatMap((branch) => branch.steps)
    .find((candidate) => candidate.skill === skill && candidate.id !== "derive-source-obligations");
  if (!step) throw new Error(`no ${skill} step`);
  return {
    repositoryPath: "/tmp/repository",
    workflow,
    step,
    editorialEvidenceRefs: [ADMITTED_REF],
  } as unknown as HarnessStepInput;
}

function proposal(overrides: Json = {}): Json {
  return {
    schemaVersion: 1,
    kind: "docsfab-editorial-assessment-proposal",
    assessment: "accepted",
    rationale: "The admitted context packet supports the audience assessment.",
    evidenceRefs: [ADMITTED_REF],
    limitations: [],
    recommendation: null,
    ...overrides,
  };
}

function envelope(
  summary: unknown = "The audience exercise found no blocking gap.",
  overrides: Json = {},
): string {
  return JSON.stringify({
    summary,
    editorialAssessmentProposal: proposal(overrides),
  });
}

const ENVELOPE_CASES: ReadonlyArray<Case & { readonly skill: string }> = [
  {
    // A recorded refusal on both nested steps.
    name: "a technical verification reply that is not JSON",
    skill: "verify-technical-accuracy",
    reply: "I verified the page against the source. Here is what I found: the option is current.",
    rejection: { code: "invalid-json", location: "$" },
  },
  {
    name: "an editorial review reply that is not JSON",
    skill: "review-documentation",
    reply: "Review complete: the page reads well.",
    rejection: { code: "invalid-json", location: "$" },
  },
  {
    // One fenced envelope is the envelope; two are an ambiguity.
    name: "two envelopes in two Markdown fences",
    skill: "review-documentation",
    reply: `\`\`\`json\n${envelope({ verdict: "pass", issues: [] })}\n\`\`\`\n\`\`\`json\n${envelope({ verdict: "pass", issues: [] })}\n\`\`\``,
    rejection: { code: "reply-json-wrapped", location: "$" },
  },
  {
    name: "a Markdown fence around a broken envelope",
    skill: "review-documentation",
    reply: `\`\`\`json\n${envelope({ verdict: "pass", issues: [] }).slice(0, -1)}\n\`\`\``,
    rejection: { code: "invalid-json", location: "$" },
  },
  {
    name: "a Markdown fence around an envelope with the result's fields at the top level",
    skill: "review-documentation",
    reply: `\`\`\`json\n${JSON.stringify({ verdict: "pass", issues: [] })}\n\`\`\``,
    rejection: { code: "editorial-envelope-shape", location: "$" },
  },
  {
    name: "the result's fields at the top level",
    skill: "review-documentation",
    reply: JSON.stringify({ verdict: "pass", issues: [] }),
    rejection: { code: "editorial-envelope-shape", location: "$" },
  },
  {
    name: "credential material in a text summary",
    skill: "test-audience-understanding",
    reply: envelope(`Readers need the token ${CREDENTIAL}.`),
    rejection: { code: "credential-material", location: "$.summary" },
    retryable: false,
  },
  {
    name: "a proposal with an undeclared key",
    skill: "test-audience-understanding",
    reply: envelope(undefined, { confidence: "high" }),
    rejection: {
      code: "invalid-shape",
      location: "$.editorialAssessmentProposal",
    },
  },
  {
    name: "a proposal assessment outside the vocabulary",
    skill: "test-audience-understanding",
    reply: envelope(undefined, { assessment: "approved" }),
    rejection: {
      code: "invalid-value",
      location: "$.editorialAssessmentProposal",
    },
  },
  {
    name: "an unadmitted evidence reference",
    skill: "test-audience-understanding",
    reply: envelope(undefined, {
      evidenceRefs: [{ ...ADMITTED_REF, digest: "9".repeat(64) }],
    }),
    rejection: {
      code: "editorial-assessment-evidence-unavailable",
      location: "$.editorialAssessmentProposal.evidenceRefs[]",
    },
  },
  {
    name: "an evidence reference outside the reference grammar",
    skill: "test-audience-understanding",
    reply: envelope(undefined, {
      evidenceRefs: [{ ...ADMITTED_REF, digest: "not-a-digest" }],
    }),
    rejection: {
      code: "invalid-value",
      location: "$.editorialAssessmentProposal.evidenceRefs[]",
    },
  },
  {
    // A limitation code keeps its own rule.
    name: "a limitation code off the outcome grammar",
    skill: "test-audience-understanding",
    reply: envelope(undefined, { limitations: ["audience_gap"] }),
    rejection: {
      code: "editorial-limitation-code-off-grammar",
      location: "$.editorialAssessmentProposal.limitations[]",
    },
  },
];

describe("editorial assessment envelope refusals name their rule (#1423)", () => {
  it.each(ENVELOPE_CASES.map((entry) => [entry.name, entry] as const))(
    "an assessment envelope with %s records its rule and location",
    (_name, { skill, reply, rejection, retryable }) => {
      const error = refusal(() =>
        admitEditorialAssessmentReply(editorialStepInput(skill), reply, context(reply)),
      );
      expect(error.category).toBe("malformed-response");
      expect(error.rejection).toEqual(rejection);
      expect(error.retryable).toBe(retryable ?? true);
      expect(inferenceRejectionFailureClass(rejection.code)).toBeDefined();
    },
  );
});

// ------------------------------------------------------- fenced valid replies

/** Wrapped shapes recorded from model replies. */
function wrappings(reply: string): ReadonlyArray<readonly [string, string]> {
  return [
    ["a json-tagged Markdown fence", `\`\`\`json\n${reply}\n\`\`\``],
    ["prose before a Markdown fence", `Here is the result.\n\n\`\`\`json\n${reply}\n\`\`\``],
    ["prose after the object", `${reply}\n\nTell me if anything needs another pass.`],
  ];
}

describe("the planner and the envelope admit a fenced valid reply (#1426)", () => {
  const planners: ReadonlyArray<readonly [string, HarnessStepInput, string]> = [
    ["create planner", plannerInput(), JSON.stringify(plan())],
    [
      "update editorial planner",
      editorialPlannerInput(),
      editorialPlan({ candidate: "update", rationale: RATIONALE, slotIds: ["public-contract"] }),
    ],
  ];
  describe.each(planners)("the %s", (_name, input, reply) => {
    // The reply digest names each reply's own bytes, so it differs by wrapping.
    const sameBinding = (raw: string) => {
      const admitted = admitPlannerReply(input, raw, context(raw));
      if (admitted?.outcome !== "completed") return admitted;
      const { planResponseSha256, ...binding } = admitted;
      expect(planResponseSha256).toMatch(/^[a-f0-9]{64}$/u);
      return binding;
    };
    const bare = sameBinding(reply);
    it.each(wrappings(reply))("admits the plan inside %s", (_shape, wrapped) => {
      expect(bare?.outcome).toBe("completed");
      // The same plan, bound the same way, as the bare reply.
      expect(sameBinding(wrapped)).toEqual(bare);
    });
  });

  const envelopes: ReadonlyArray<readonly [string, string]> = [
    ["test-audience-understanding", envelope()],
    ["review-documentation", envelope({ verdict: "pass", issues: [] })],
  ];
  describe.each(envelopes)("the %s assessment envelope", (skill, reply) => {
    const bare = admitEditorialAssessmentReply(editorialStepInput(skill), reply, context(reply));
    it.each(wrappings(reply))("admits the envelope inside %s", (_shape, wrapped) => {
      expect(bare.editorialAssessmentProposal).toBeDefined();
      expect(
        admitEditorialAssessmentReply(editorialStepInput(skill), wrapped, context(wrapped)),
      ).toEqual(bare);
    });
  });

  it("keeps a content refusal inside a fence at the document's own location", () => {
    // The credential screen refuses, terminally, what it refuses as a bare
    // reply.
    const credential = envelope(`Readers need the token ${CREDENTIAL}.`);
    const fenced = `\`\`\`json\n${credential}\n\`\`\``;
    const error = refusal(() =>
      admitEditorialAssessmentReply(
        editorialStepInput("test-audience-understanding"),
        fenced,
        context(fenced),
      ),
    );
    expect(error.rejection).toEqual({ code: "credential-material", location: "$.summary" });
    expect(error.retryable).toBe(false);
  });
});

// ------------------------------------------------------------ review result

function reviewInput(): HarnessStepInput {
  return {
    workflow: { name: "create-documentation", schemaVersion: 1, steps: [] },
    step: {
      id: "review-documentation",
      skill: "review-documentation",
      mode: "read-only",
    },
  } as unknown as HarnessStepInput;
}

const REVIEW_CASES: readonly Case[] = [
  {
    name: "a review that is not JSON",
    reply: "The page is ready to publish.",
    rejection: { code: "invalid-json", location: "$" },
  },
  {
    name: "a verdict its issues contradict",
    reply: JSON.stringify({ verdict: "needs-revision", issues: [] }),
    rejection: { code: "review-result-verdict-issues", location: "$.verdict" },
  },
  {
    name: "a verdict outside the schema",
    reply: JSON.stringify({ verdict: "approved", issues: [] }),
    rejection: { code: "review-schema-enum", location: "$.verdict" },
  },
  {
    name: "credential material in a finding",
    reply: JSON.stringify({
      verdict: "needs-revision",
      issues: [{ finding: CREDENTIAL }],
    }),
    rejection: { code: "credential-material", location: "$" },
    retryable: false,
  },
];

describe("review result refusals name their rule (#1423)", () => {
  it.each(REVIEW_CASES.map((entry) => [entry.name, entry] as const))(
    "a review result with %s records its rule and location",
    (_name, { reply, rejection, retryable }) => {
      const error = refusal(() => admitReviewResultReply(reviewInput(), reply, context(reply)));
      expect(error.category).toBe("malformed-response");
      expect(error.rejection).toEqual(rejection);
      expect(error.retryable).toBe(retryable ?? true);
      expect(inferenceRejectionFailureClass(rejection.code)).toBeDefined();
    },
  );

  it("names the location under the envelope summary for the nested review result", () => {
    const summary = JSON.stringify({
      verdict: "pass",
      issues: [{ id: "EDIT-001" }],
    });
    const error = refusal(() =>
      admitReviewResultReply(editorialStepInput("review-documentation"), summary, context(summary)),
    );
    expect(error.rejection?.location.startsWith("$.summary")).toBe(true);
    const contradicted = JSON.stringify({
      verdict: "needs-revision",
      issues: [],
    });
    expect(
      refusal(() =>
        admitReviewResultReply(
          editorialStepInput("review-documentation"),
          contradicted,
          context(contradicted),
        ),
      ).rejection,
    ).toEqual({
      code: "review-result-verdict-issues",
      location: "$.summary.verdict",
    });
  });
});

// ------------------------------------------------ quality artifact envelope

function qualityInput(): HarnessStepInput {
  return {
    workflow: { name: "review-documentation", schemaVersion: 1, steps: [] },
    step: {
      id: "evaluate-document-quality",
      skill: "evaluate-document-quality",
      kind: "evaluate",
      mode: "read-only",
    },
    qualityProfileSelection: { selectionSha256: "a".repeat(64) },
  } as unknown as HarnessStepInput;
}

const QUALITY_EVALUATION: Json = {
  evaluation_id: "evaluation-1",
  overall_decision: "insufficient-evidence",
  target: { paths: ["docs/index.md"], intended_outcome_classes: ["task-completion"] },
};

function qualityEnvelope(overrides: Json = {}): Json {
  return {
    evaluation: QUALITY_EVALUATION,
    qualityScore: null,
    reportMarkdown: "# Documentation quality evaluation report\n\n## Findings\n\n- None.\n",
    ...overrides,
  };
}

/** The template's summary block, as a model copies it into reportMarkdown. */
const SUMMARY_BLOCK =
  '## Validated result summary\n\n```json\n{"report_contract": "docsfab-quality-report-v0.2", "evaluation": {"decision": "insufficient-evidence"}}\n```';

/** Sanitized shapes of refused final evaluator replies from a hosted Nemotron model. */
const QUALITY_ENVELOPE_CASES: ReadonlyArray<{
  readonly name: string;
  readonly reply: string;
  readonly rejection: InferenceRejectionReasonV1;
}> = [
  {
    name: "the evaluation's own fields at the top level",
    reply: JSON.stringify(QUALITY_EVALUATION),
    rejection: { code: "quality-envelope-shape", location: "$" },
  },
  {
    name: "an extra top-level wrapper key",
    reply: JSON.stringify({ ...qualityEnvelope(), summary: "Evaluated one page." }),
    rejection: { code: "quality-envelope-shape", location: "$" },
  },
  {
    name: "a string qualityScore",
    reply: JSON.stringify(qualityEnvelope({ qualityScore: "not rubric eligible" })),
    rejection: { code: "quality-envelope-shape", location: "$.qualityScore" },
  },
  {
    name: "an empty reportMarkdown",
    reply: JSON.stringify(qualityEnvelope({ reportMarkdown: " " })),
    rejection: { code: "quality-envelope-shape", location: "$.reportMarkdown" },
  },
  {
    // The copied block's quotes are left unescaped, so the string ends early.
    name: "an unescaped JSON summary block inside reportMarkdown",
    reply: `{"evaluation":${JSON.stringify(QUALITY_EVALUATION)},"qualityScore":null,"reportMarkdown":"# Report\\n\\n${SUMMARY_BLOCK.replaceAll("\n", "\\n")}"}`,
    rejection: { code: "quality-envelope-json", location: "$.reportMarkdown" },
  },
  {
    // Raw line breaks let the shared extraction policy find the fenced block
    // inside the string and parse it as the whole reply.
    name: "raw line breaks around a JSON summary block inside reportMarkdown",
    reply: `{"evaluation":${JSON.stringify(QUALITY_EVALUATION)},"qualityScore":null,"reportMarkdown":"# Report\n\n${SUMMARY_BLOCK}\n"}`,
    rejection: { code: "quality-envelope-json", location: "$.reportMarkdown" },
  },
  {
    name: "a reply cut inside the evaluation",
    reply: JSON.stringify(qualityEnvelope()).slice(0, 60),
    rejection: { code: "quality-envelope-json", location: "$.evaluation" },
  },
  {
    name: "prose with no JSON document",
    reply: "The evaluation is complete; the page needs one more example.",
    rejection: { code: "quality-envelope-json", location: "$" },
  },
  {
    // Adjacent to the "right after a member" location: once the envelope
    // object has closed, the break is outside every member.
    name: "an extra closing brace after a whole envelope",
    reply: `${JSON.stringify(qualityEnvelope())}}`,
    rejection: { code: "quality-envelope-json", location: "$" },
  },
  {
    name: "a reply that ends right after the reportMarkdown string",
    reply: JSON.stringify(qualityEnvelope()).slice(0, -1),
    rejection: { code: "quality-envelope-json", location: "$.reportMarkdown" },
  },
  {
    // A nested key that spells a member name is not that member.
    name: "a break after a nested key named reportMarkdown",
    reply: '{"evaluation":{"reportMarkdown": "a" "b"}}',
    rejection: { code: "quality-envelope-json", location: "$.evaluation" },
  },
  // A reply that does not open as an object keeps the refusal of the span the
  // shared extraction policy read; only an object-shaped reply is re-read.
  {
    name: "a fenced envelope with a string qualityScore",
    reply: `\`\`\`json\n${JSON.stringify(qualityEnvelope({ qualityScore: "n/a" }))}\n\`\`\``,
    rejection: { code: "quality-envelope-shape", location: "$.qualityScore" },
  },
  {
    name: "a sentence before a fenced envelope cut inside the evaluation",
    reply: `Here is the envelope.\n\`\`\`json\n${JSON.stringify(qualityEnvelope()).slice(0, 60)}\n\`\`\``,
    rejection: { code: "quality-envelope-json", location: "$.evaluation" },
  },
  {
    // Not the shared reply-json rule, whose "only the JSON object" would
    // contradict the report the answer form writes after its object.
    name: "two fenced JSON blocks",
    reply: `\`\`\`json\n${JSON.stringify(qualityEnvelope())}\n\`\`\`\n\n\`\`\`json\n{"note": 1}\n\`\`\``,
    rejection: { code: "quality-envelope-shape", location: "$" },
  },
  {
    // The shape three step 8 attempts in a row returned on the Inference Hub route.
    name: "qualityScore repeated after reportMarkdown",
    reply: `${JSON.stringify(qualityEnvelope()).slice(0, -1)},"qualityScore":null}`,
    rejection: { code: "quality-envelope-duplicate-key", location: "$.qualityScore" },
  },
  {
    name: "a key repeated inside the evaluation",
    reply: `{"evaluation":{"evaluation_id":"e","overall_decision":"fail","overall_decision":"pass"},"qualityScore":null,"reportMarkdown":"# R"}`,
    rejection: { code: "quality-envelope-duplicate-key", location: "$.evaluation" },
  },
  {
    name: "an undeclared top-level key repeated",
    reply: '{"summary": "a", "summary": "b"}',
    rejection: { code: "quality-envelope-duplicate-key", location: "$" },
  },
  {
    name: "a break inside an undeclared top-level key",
    reply: '{"summary": "a" "b", "evaluation": {}}',
    rejection: { code: "quality-envelope-json", location: "$" },
  },
];

/** The answer form: the JSON object, then the report as plain Markdown. */
function qualityAnswer(head: Json, report: string): string {
  return `${JSON.stringify(head)}\n\n${report}`;
}

/** A report that JSON would have to escape: quotes, a fenced JSON block, braces. */
const MARKDOWN_REPORT =
  '# Documentation quality evaluation report\n\nThe page calls `new Client("http://localhost", 5000)`.\n\n```json\n{"evaluation": {"decision": "fail"}, "qualityScore": null}\n```\n\nOptions use `{}`.';

describe("the quality answer form carries the report as Markdown after the JSON object (#1697)", () => {
  it("admits the JSON object and keeps the Markdown after it as the report", () => {
    const reply = qualityAnswer(
      { evaluation: QUALITY_EVALUATION, qualityScore: null },
      MARKDOWN_REPORT,
    );
    expect(
      admitQualityArtifactReply(qualityInput(), reply, context(reply)).qualityArtifactCandidate,
    ).toEqual({
      evaluation: QUALITY_EVALUATION,
      qualityScore: null,
      reportMarkdown: MARKDOWN_REPORT,
      selectionSha256: "a".repeat(64),
      answerPath: "text",
    });
  });

  it("reads the object's end past braces and escaped quotes inside its strings", () => {
    const evaluation = { ...QUALITY_EVALUATION, note: 'a "} ] {" b \\' };
    const reply = qualityAnswer({ evaluation, qualityScore: null }, "# Report");
    expect(
      admitQualityArtifactReply(qualityInput(), reply, context(reply)).qualityArtifactCandidate
        ?.evaluation,
    ).toEqual(evaluation);
  });

  it("keeps the JSON report of a three-member envelope that trailing text follows", () => {
    // Adjacent to the answer form: only an object with exactly evaluation and
    // qualityScore takes its report from the Markdown after it.
    const reply = `${JSON.stringify(qualityEnvelope())}\n\n# A second report`;
    expect(
      admitQualityArtifactReply(qualityInput(), reply, context(reply)).qualityArtifactCandidate
        ?.reportMarkdown,
    ).toBe(qualityEnvelope().reportMarkdown);
  });

  it.each([
    [
      "a trailing comma inside the evaluation, before a report with two JSON blocks",
      `{"evaluation":{"evaluation_id":"e",},"qualityScore":null}\n\n# Report\n\n\`\`\`json\n{"a": 1}\n\`\`\`\n\n\`\`\`json\n{"b": 2}\n\`\`\``,
      { code: "quality-envelope-json", location: "$.evaluation" },
    ],
    [
      "qualityScore repeated inside the object",
      `{"evaluation":${JSON.stringify(QUALITY_EVALUATION)},"qualityScore":null,"qualityScore":null}\n\n# Report`,
      { code: "quality-envelope-duplicate-key", location: "$.qualityScore" },
    ],
    [
      "a string qualityScore",
      qualityAnswer({ evaluation: QUALITY_EVALUATION, qualityScore: "none" }, "# Report"),
      { code: "quality-envelope-shape", location: "$.qualityScore" },
    ],
    [
      "no report after the object",
      `${JSON.stringify({ evaluation: QUALITY_EVALUATION, qualityScore: null })}\n\n   \n`,
      { code: "quality-envelope-report", location: "$.reportMarkdown" },
    ],
    [
      "a sentence before the object",
      `Here is the evaluation.\n${qualityAnswer({ evaluation: QUALITY_EVALUATION, qualityScore: null }, "# Report")}`,
      { code: "quality-envelope-shape", location: "$" },
    ],
  ] as const)("refuses an answer with %s at its rule and location", (_name, reply, rejection) => {
    const error = refusal(() => admitQualityArtifactReply(qualityInput(), reply, context(reply)));
    expect(error.category).toBe("malformed-response");
    expect(error.retryable).toBe(true);
    expect(error.rejection).toEqual(rejection);
  });
});

const ANSWER_HEAD = JSON.stringify({
  evaluation: QUALITY_EVALUATION,
  qualityScore: null,
});
const REPORT = qualityEnvelope().reportMarkdown as string;
const JSON_AFTER_OBJECT = {
  code: "quality-envelope-json-after-object",
  location: "$",
} as const;
const NO_HEADING = {
  code: "quality-envelope-report",
  location: "$.reportMarkdown",
} as const;
const OPEN_FENCE = {
  code: "quality-envelope-report-fence",
  location: "$.reportMarkdown",
} as const;
const UNFENCED_MEMBER = {
  code: "quality-envelope-report-member",
  location: "$.reportMarkdown",
} as const;
const ENVELOPE_IN_REPORT = {
  code: "quality-envelope-report-envelope",
  location: "$.reportMarkdown",
} as const;

/**
 * The decoder on origin/main before the answer form: the shared extraction
 * policy's span, strict JSON, exactly the three envelope members, and the same
 * member checks. The oracle for "the envelope is admitted exactly as before".
 */
function envelopeOnlyDecode(reply: string): Json | undefined {
  const body = jsonEnvelopeBody(reply);
  if (!isJsonEvidence(body)) return undefined;
  const root = parseJsonEvidence(body) as Json;
  if (!root || typeof root !== "object" || Array.isArray(root)) return undefined;
  if (Object.keys(root).sort().join(",") !== "evaluation,qualityScore,reportMarkdown") {
    return undefined;
  }
  const { evaluation, qualityScore, reportMarkdown } = root as Record<string, unknown>;
  if (!evaluation || typeof evaluation !== "object" || Array.isArray(evaluation)) return undefined;
  if (qualityScore !== null && (typeof qualityScore !== "object" || Array.isArray(qualityScore))) {
    return undefined;
  }
  if (typeof reportMarkdown !== "string" || !reportMarkdown.trim()) return undefined;
  return root;
}

/** Replies whose JSON residue the answer form must never store as the report. */
const JSON_RESIDUE_CASES: ReadonlyArray<
  readonly [string, string, { readonly code: string; readonly location: string }]
> = [
  // A three-member envelope closed one brace early, so its reportMarkdown
  // member lands after the answer's object.
  [
    "an envelope closed early, with raw line breaks in reportMarkdown",
    `${ANSWER_HEAD}, "reportMarkdown": "${REPORT}"}`,
    JSON_AFTER_OBJECT,
  ],
  [
    "an envelope closed early, with reportMarkdown escaped",
    `${ANSWER_HEAD}, "reportMarkdown": ${JSON.stringify(REPORT)}}`,
    JSON_AFTER_OBJECT,
  ],
  [
    "evaluation members after an early close",
    `{"qualityScore":null,"evaluation":{"evaluation_id":"e1"}}, "overall_decision":"fail"}\n\n${REPORT}`,
    JSON_AFTER_OBJECT,
  ],
  ["an extra closing brace before the report", `${ANSWER_HEAD}}\n\n${REPORT}`, JSON_AFTER_OBJECT],
  ["a closing bracket before the report", `${ANSWER_HEAD}]\n\n${REPORT}`, JSON_AFTER_OBJECT],
  ["a string after the object", `${ANSWER_HEAD}\n"${REPORT}"`, JSON_AFTER_OBJECT],
  ["a colon after the object", `${ANSWER_HEAD}: ${JSON.stringify(REPORT)}`, JSON_AFTER_OBJECT],
  [
    "a second object right after the first",
    `${ANSWER_HEAD}\n${ANSWER_HEAD}\n\n${REPORT}`,
    JSON_AFTER_OBJECT,
  ],
  // The shape hosted Super returned three attempts in a row.
  [
    "qualityScore repeated after the report",
    `${ANSWER_HEAD}\n\n${REPORT}\n{"qualityScore": null}`,
    UNFENCED_MEMBER,
  ],
  [
    "a pretty-printed member after the report",
    `${ANSWER_HEAD}\n\n${REPORT}\n  "reportMarkdown": "again"`,
    UNFENCED_MEMBER,
  ],
  // A length-stop continuation that restarted the whole answer.
  [
    "a restarted answer after a partial report",
    `${ANSWER_HEAD}\n\n# Documentation quality evaluation report\n\n## Find\n\n${ANSWER_HEAD}\n\n${REPORT}`,
    UNFENCED_MEMBER,
  ],
  [
    "a restarted answer on the partial report's last line",
    `${ANSWER_HEAD}\n\n# Documentation quality evaluation report\n\nThe page lac${ANSWER_HEAD}\n\n${REPORT}`,
    UNFENCED_MEMBER,
  ],
  // A cut inside an inline code span, then a restart on the same line: the
  // open backtick pairs with one in the restarted head.
  [
    "a restarted answer, qualityScore first, inside the partial report's inline code",
    `${ANSWER_HEAD}\n\n# Report\n\nRun \`docsfab ru${JSON.stringify({
      qualityScore: null,
      evaluation: { ...QUALITY_EVALUATION, note: "Edits `README.md`." },
    })}\n\n${REPORT}`,
    UNFENCED_MEMBER,
  ],
  [
    "a restarted answer, evaluation first, inside the partial report's inline code",
    `${ANSWER_HEAD}\n\n# Report\n\nRun \`docsfab ru${JSON.stringify({
      evaluation: { ...QUALITY_EVALUATION, note: "Edits `README.md`." },
      qualityScore: { rationale: "Scored from the `docs/` pages." },
    })}\n\n${REPORT}`,
    UNFENCED_MEMBER,
  ],
  [
    "a restarted answer inside a fence the partial report left open",
    `${ANSWER_HEAD}\n\n# Report\n\n\`\`\`json\n{"report_contract": "docsfab-quality${ANSWER_HEAD}\n\n${REPORT}`,
    OPEN_FENCE,
  ],
  [
    "a restarted answer hidden behind a fence the partial report left open",
    `${ANSWER_HEAD}\n\n# Report\n\n\`\`\`json\n{"a": 1\n${ANSWER_HEAD}\n\n${REPORT}\n\`\`\`text\nexample\n\`\`\``,
    OPEN_FENCE,
  ],
  ["no heading line opening the report", `${ANSWER_HEAD}\n\nThe page needs work.`, NO_HEADING],
  ["a hash with no space opening the report", `${ANSWER_HEAD}\n\n#Report\n\nBody.`, NO_HEADING],
  [
    "a fenced block opening the report",
    `${ANSWER_HEAD}\n\n\`\`\`markdown\n${REPORT}\n\`\`\``,
    NO_HEADING,
  ],
  ["only whitespace after the object", `${ANSWER_HEAD}\n \t\n`, NO_HEADING],
  [
    "a member after a line of inline code that looks like a fence",
    `${ANSWER_HEAD}\n\n# Report\n\n\`\`\`x\`\`\` is inline.\n{"evaluation": {}}\n\`\`\``,
    UNFENCED_MEMBER,
  ],
  [
    "a same-kind fence opener inside an open fence",
    `${ANSWER_HEAD}\n\n# Report\n\n\`\`\`json\n{"a": 1}\n\`\`\`text\nplain\n\`\`\`\n\nText.\n\`\`\``,
    OPEN_FENCE,
  ],
  [
    "a fence left open at the end of the report",
    `${ANSWER_HEAD}\n\n# Report\n\n\`\`\`json\n{"a": 1}`,
    OPEN_FENCE,
  ],
  // Adjacent to a stray closing fence: a bare fence line hides what follows it.
  [
    "a bare fence left open with report text after it",
    `${ANSWER_HEAD}\n\n# Report\n\nText.\n\`\`\`\n\n${ANSWER_HEAD}`,
    OPEN_FENCE,
  ],
  [
    "a bare tilde fence left open with report text after it",
    `${ANSWER_HEAD}\r\n\r\n# Report\r\n\r\nText.\r\n~~~\r\n \r\nMore text.`,
    OPEN_FENCE,
  ],
  [
    "a fence opener with an info string ending the report",
    `${ANSWER_HEAD}\n\n# Report\n\nText.\n\`\`\`json\n`,
    OPEN_FENCE,
  ],
  [
    "a member after an unclosed backtick",
    `${ANSWER_HEAD}\n\n# Report\n\nThe key \`"evaluation": {}\n`,
    UNFENCED_MEMBER,
  ],
  [
    "a member between backtick runs of different lengths",
    `${ANSWER_HEAD}\n\n# Report\n\nThe key \`\`"qualityScore": null\` is set.`,
    UNFENCED_MEMBER,
  ],
];

/**
 * Real Nemotron Super answer-form reports end with a lone fence line after a
 * balanced summary block. Nothing follows that line, so it hides nothing; the
 * stored report drops it and stays well-formed.
 */
const STRAY_FENCE_REPORTS: ReadonlyArray<readonly [string, string, string]> = [
  [
    "a bare backtick fence after a balanced JSON summary block",
    `# Documentation quality evaluation report\n\n${SUMMARY_BLOCK}\n\n## Separate evidence views\n\n- None.\n\`\`\`\n`,
    `# Documentation quality evaluation report\n\n${SUMMARY_BLOCK}\n\n## Separate evidence views\n\n- None.`,
  ],
  [
    "a bare fence followed by whitespace-only CRLF lines",
    "# Report\r\n\r\nText.\r\n```\r\n \r\n\t\r\n",
    "# Report\r\n\r\nText.",
  ],
  [
    "a bare tilde fence",
    "# Report\n\n~~~json\n{}\n~~~\n\nText.\n~~~~",
    "# Report\n\n~~~json\n{}\n~~~\n\nText.",
  ],
];

/** Reports whose JSON and braces are the report's own content. */
const REPORTS_WITH_JSON_CONTENT: ReadonlyArray<readonly [string, string]> = [
  ["a fenced JSON example with answer member names", MARKDOWN_REPORT],
  [
    "the template's summary block, fenced",
    `# Documentation quality evaluation report\n\n${SUMMARY_BLOCK}\n\n## Findings\n\n- None.`,
  ],
  [
    "braces and quotes in prose",
    '# Report\n\nThe option takes `{"retries": 3}` and a map like {a: 1}; the "evaluation" step ran.',
  ],
  [
    "fences nested by length and by character",
    '# Report\n\n````markdown\n```json\n{"evaluation": {}}\n```\n````\n\n~~~markdown\n```json\n{"qualityScore": null}\n```\n~~~',
  ],
  [
    "answer member names in inline code",
    '# Report\n\nThe API returns `"evaluation": {}` and ``"qualityScore": null`` per call.',
  ],
  [
    "a tilde fence, and a backtick fence closed by a longer run",
    '## Report\n\n~~~json\n{"qualityScore": null}\n~~~\n\n```\n"evaluation": {}\n````\n\nDone.',
  ],
];

describe("the answer form stores only a report after its JSON object", () => {
  it.each(JSON_RESIDUE_CASES)("refuses %s", (_name, reply, rejection) => {
    const error = refusal(() => admitQualityArtifactReply(qualityInput(), reply, context(reply)));
    expect(error.category).toBe("malformed-response");
    expect(error.retryable).toBe(true);
    expect(error.rejection).toEqual(rejection);
  });

  it.each([
    [
      "a misspelled member",
      `{"evaluation":${JSON.stringify(QUALITY_EVALUATION)},"quality_score":null}\n\n${REPORT}`,
    ],
    ["only the evaluation", `{"evaluation":${JSON.stringify(QUALITY_EVALUATION)}}\n\n${REPORT}`],
    [
      "the report summary's keys, before a report with its summary block",
      `{"report_contract":"docsfab-quality-report-v0.2","evaluation":{"decision":"fail"},"rubric":{}}\n\n# Report\n\n${SUMMARY_BLOCK}`,
    ],
  ])("refuses a leading object with %s as a shape refusal at $", (_name, reply) => {
    expect(envelopeOnlyDecode(reply)).toBeUndefined();
    expect(
      refusal(() => admitQualityArtifactReply(qualityInput(), reply, context(reply))).rejection,
    ).toEqual({ code: "quality-envelope-shape", location: "$" });
  });

  it("refuses only replies the envelope-only decoder refused too", () => {
    for (const [name, reply] of JSON_RESIDUE_CASES) {
      expect(envelopeOnlyDecode(reply), name).toBeUndefined();
    }
  });

  it("refuses a reply both forms read, which the envelope-only decoder admitted", () => {
    // Its answer object and the whole envelope in its one fence each read as
    // a complete answer; which one the model meant is a guess.
    const reply = `${ANSWER_HEAD}\n\n# Report\n\n\`\`\`json\n${JSON.stringify(qualityEnvelope())}\n\`\`\``;
    expect(envelopeOnlyDecode(reply)).toEqual(qualityEnvelope());
    expect(
      refusal(() => admitQualityArtifactReply(qualityInput(), reply, context(reply))).rejection,
    ).toEqual(ENVELOPE_IN_REPORT);
  });

  it.each(STRAY_FENCE_REPORTS)(
    "admits a report ending in %s and stores it without that line",
    (_name, report, stored) => {
      const reply = `${ANSWER_HEAD}\n\n${report}`;
      expect(
        admitQualityArtifactReply(qualityInput(), reply, context(reply)).qualityArtifactCandidate
          ?.reportMarkdown,
      ).toBe(stored);
    },
  );

  it.each(REPORTS_WITH_JSON_CONTENT)("admits a report holding %s", (_name, report) => {
    const reply = `${ANSWER_HEAD}\n\n${report}`;
    expect(
      admitQualityArtifactReply(qualityInput(), reply, context(reply)).qualityArtifactCandidate
        ?.reportMarkdown,
    ).toBe(report);
  });

  it("admits a whole envelope exactly as the envelope-only decoder does", () => {
    const replies = [
      JSON.stringify(qualityEnvelope()),
      `\`\`\`json\n${JSON.stringify(qualityEnvelope())}\n\`\`\``,
      `${JSON.stringify(qualityEnvelope())}\n\n# A second report`,
      `Here it is: ${JSON.stringify(qualityEnvelope())}`,
      // A leading object with other keys is no answer; the envelope in its one fence is.
      `{"note": "draft"}\n\n\`\`\`json\n${JSON.stringify(qualityEnvelope())}\n\`\`\``,
      // A broken leading object is no answer; the envelope in its one fence is.
      `{"evaluation": {"evaluation_id": "e",}, "qualityScore": null}\n\n\`\`\`json\n${JSON.stringify(qualityEnvelope())}\n\`\`\``,
    ];
    for (const reply of replies) {
      const admitted = admitQualityArtifactReply(qualityInput(), reply, context(reply))
        .qualityArtifactCandidate!;
      expect(admitted.answerPath, reply).toBe("text");
      const { selectionSha256: _selection, answerPath: _answerPath, ...members } = admitted;
      expect(members, reply).toEqual(envelopeOnlyDecode(reply));
    }
  });
});

describe("quality artifact envelope refusals name their rule and member (#1697)", () => {
  it("admits the valid envelope the cases below mutate", () => {
    expect(
      admitQualityArtifactReply(
        qualityInput(),
        JSON.stringify(qualityEnvelope()),
        context(JSON.stringify(qualityEnvelope())),
      ).qualityArtifactCandidate?.evaluation,
    ).toEqual(QUALITY_EVALUATION);
  });

  // The reply-syntax fallback fires only after the shared extraction policy's
  // span was refused, so a wrapped envelope that policy admits stays admitted.
  it.each([
    ["a fenced envelope", `\`\`\`json\n${JSON.stringify(qualityEnvelope())}\n\`\`\``],
    ["an envelope followed by a sentence", `${JSON.stringify(qualityEnvelope())}\nDone.`],
  ])("still admits %s", (_name, reply) => {
    expect(
      admitQualityArtifactReply(qualityInput(), reply, context(reply)).qualityArtifactCandidate
        ?.evaluation,
    ).toEqual(QUALITY_EVALUATION);
  });

  it("admits one key name used once in each of two objects", () => {
    // Adjacent to a repeated key: the same name in sibling objects is not one.
    const evaluation = {
      ...QUALITY_EVALUATION,
      profile: { id: "p", version: "v" },
      extra: { id: "x" },
    };
    const reply = JSON.stringify(qualityEnvelope({ evaluation }));
    expect(
      admitQualityArtifactReply(qualityInput(), reply, context(reply)).qualityArtifactCandidate
        ?.evaluation,
    ).toEqual(evaluation);
  });

  it.each(QUALITY_ENVELOPE_CASES.map((entry) => [entry.name, entry] as const))(
    "a quality envelope with %s records its rule and location",
    (_name, { reply, rejection }) => {
      const error = refusal(() => admitQualityArtifactReply(qualityInput(), reply, context(reply)));
      expect(error.category).toBe("malformed-response");
      expect(error.retryable).toBe(true);
      expect(error.rejection).toEqual(rejection);
      expect(inferenceRejectionFailureClass(rejection.code)).toBe("contract-shape");
    },
  );
});

// ------------------------------------------------ attempt row, index, summary

const POLICY: InferenceRetryPolicy = {
  maxRetries: 1,
  baseDelayMs: 0,
  maxDelayMs: 0,
  retryableCategories: ["malformed-response"],
};

/** A failed read-only step, refused on every attempt by one real admission. */
async function refusedStep(stepId: string, skill: string, admit: () => unknown, reply: string) {
  const corrections: string[] = [];
  const execution = await executeInferenceStep({
    mode: "read-only",
    policy: POLICY,
    sleep: async () => undefined,
    execute: async (_attempt, correction) => {
      corrections.push(responseCorrectionInstruction(correction));
      try {
        admit();
      } catch (error) {
        // The harness fingerprints every refused reply before it leaves.
        throw retainRejectedReplyShape(error, reply, resolveRejectedReplyShapePolicy());
      }
      return { summary: "unreachable" } as never;
    },
  });
  expect(execution.status).toBe("failed");
  const step = {
    id: stepId,
    title: stepId,
    kind: "evaluate",
    skill,
    mode: "read-only",
    status: "failed",
    inference: execution.evidence,
  } as unknown as RunRecord["steps"][number];
  const record = {
    schemaVersion: 2,
    id: "0f1e2d3c-4b5a-4968-8776-655443322110",
    workflow: "create-documentation",
    repository: {
      sourcePath: "/fixture/repository",
      requestedRevision: "HEAD",
      revision: REVISION,
    },
    workspace: { strategy: "tracked-export", disposable: true },
    status: "failed",
    createdAt: "2026-09-25T04:00:00.000Z",
    models: [],
    skills: [],
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      total: 2,
      turns: 1,
    },
    tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
    steps: [step],
  } as unknown as RunRecord;
  const projection = projectRunIndexRows(record, {
    origin: "import",
    snapshotId: "snapshot-1423",
    indexedAt: "2026-09-25T05:00:00.000Z",
    recordSha256: "a".repeat(64),
    fieldMaxChars: 512,
  });
  if (!projection.ok) throw new Error(projection.reason);
  return {
    attempts: execution.evidence.attempts,
    corrections,
    lines: formatRunFailureDiagnosticLines(record),
    rows: projection.rows.filter((row) => row.rowKind === "attempt"),
  };
}

describe("coded refusals reach the attempt row, run index, retry, and FAILURE summary (#1423)", () => {
  it("records the #1046 hoisted-sourceBindings planner reply with its rule and keys", async () => {
    const reply = PLANNER_CASES.find((entry) => entry.name.startsWith("sourceBindings"))!.reply;
    const { attempts, corrections, lines, rows } = await refusedStep(
      "plan-documentation",
      "plan-documentation",
      () => admitPlannerReply(plannerInput(), reply, context(reply)),
      reply,
    );
    for (const attempt of attempts) {
      expect(attempt.rejection).toEqual({
        code: "invalid-shape",
        location: "$",
      });
      // The planner's keys are host-declared, so the fingerprint names them.
      expect(attempt.rejectedReplyShape?.topLevelKeys).toEqual([
        "summary",
        "planBinding",
        "sourceBindings",
      ]);
      expect(classifyInferenceAttempt(attempt)).toMatchObject({
        class: "contract-shape",
        code: "invalid-shape",
      });
    }
    expect(corrections[1]).toContain("failed host rule invalid-shape at $.");
    expect(corrections[1]).not.toContain(UNCODED_RESPONSE_CORRECTION);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toMatchObject({
        stepId: "plan-documentation",
        outcome: "malformed-response",
        rejectionSource: "inference-attempt",
        rejectionCode: "invalid-shape",
        rejectionLocation: "$",
        rejectedReplyParseCode: "parsed",
      });
    }
    expect(lines).toContain("Failure class: contract-shape (layer inference, code invalid-shape).");
    expect(lines).toContain(
      "Rejected by invalid-shape at $; reply keys summary, planBinding, sourceBindings.",
    );
  });

  it("records the #1046 non-JSON verification reply to the envelope", async () => {
    const reply = "I verified the page against the source. The option is current.";
    const { attempts, lines, rows } = await refusedStep(
      "verify-technical-accuracy",
      "verify-technical-accuracy",
      () =>
        admitEditorialAssessmentReply(
          editorialStepInput("verify-technical-accuracy"),
          reply,
          context(reply),
        ),
      reply,
    );
    expect(attempts.map((attempt) => attempt.rejection)).toEqual([
      { code: "invalid-json", location: "$" },
      { code: "invalid-json", location: "$" },
    ]);
    expect(rows.map((row) => [row.rejectionCode, row.rejectedReplyParseCode])).toEqual([
      ["invalid-json", "json-unexpected-token"],
      ["invalid-json", "json-unexpected-token"],
    ]);
    expect(lines).toContain("Failure class: contract-shape (layer inference, code invalid-json).");
    expect(lines.some((line) => line.startsWith("Rejected by invalid-json at $;"))).toBe(true);
  });

  it("records an ambiguously wrapped reply and states the unwrap rule in the retry", async () => {
    const fenced = `\`\`\`json\n${JSON.stringify(plan())}\n\`\`\``;
    const reply = `Here is the plan.\n\n${fenced}\n\nOr this one:\n\n${fenced}`;
    const { attempts, corrections, lines } = await refusedStep(
      "plan-documentation",
      "plan-documentation",
      () => admitPlannerReply(plannerInput(), reply, context(reply)),
      reply,
    );
    expect(attempts[0]!.rejection).toEqual({
      code: "reply-json-wrapped",
      location: "$",
    });
    expect(corrections[1]).toContain("Do not put it in a Markdown code fence");
    expect(lines).toContain(
      "Failure class: contract-shape (layer inference, code reply-json-wrapped).",
    );
  });

  it("records a quality envelope JSON break at its member and says to move the report out of JSON in the retry", async () => {
    const reply = QUALITY_ENVELOPE_CASES.find((entry) =>
      entry.name.startsWith("raw line breaks"),
    )!.reply;
    const { attempts, corrections, lines, rows } = await refusedStep(
      "evaluate-document-quality",
      "evaluate-document-quality",
      () => admitQualityArtifactReply(qualityInput(), reply, context(reply)),
      reply,
    );
    for (const attempt of attempts) {
      expect(attempt.rejection).toEqual({
        code: "quality-envelope-json",
        location: "$.reportMarkdown",
      });
    }
    // Queryable: the index groups these refusals by code, not as unavailable.
    expect(rows.map((row) => [row.rejectionCode, row.rejectionLocation])).toEqual([
      ["quality-envelope-json", "$.reportMarkdown"],
      ["quality-envelope-json", "$.reportMarkdown"],
    ]);
    expect(corrections[1]).toContain(
      "The previous response failed host rule quality-envelope-json at $.reportMarkdown.",
    );
    expect(corrections[1]).toContain(
      "Do not put the report inside JSON: close the JSON object after qualityScore, then write the report as plain Markdown after it.",
    );
    expect(corrections[1]).not.toContain(UNCODED_RESPONSE_CORRECTION);
    expect(lines).toContain(
      "Failure class: contract-shape (layer inference, code quality-envelope-json).",
    );
  });

  it("records a repeated qualityScore as its own rule and says to write it once in the retry", async () => {
    const reply = QUALITY_ENVELOPE_CASES.find((entry) =>
      entry.name.startsWith("qualityScore repeated"),
    )!.reply;
    const { corrections, rows } = await refusedStep(
      "evaluate-document-quality",
      "evaluate-document-quality",
      () => admitQualityArtifactReply(qualityInput(), reply, context(reply)),
      reply,
    );
    expect(rows[0]).toMatchObject({
      rejectionCode: "quality-envelope-duplicate-key",
      rejectionLocation: "$.qualityScore",
      rejectedReplyParseCode: "json-duplicate-key",
    });
    expect(corrections[1]).toContain(
      "The previous response failed host rule quality-envelope-duplicate-key at $.qualityScore.",
    );
    expect(corrections[1]).toContain("never repeat qualityScore after it");
    expect(corrections[1]).not.toContain("Check every comma, bracket, brace");
  });

  it("records a quality envelope with the evaluation at the top level as a shape refusal at $", async () => {
    const reply = JSON.stringify(QUALITY_EVALUATION);
    const { corrections, rows } = await refusedStep(
      "evaluate-document-quality",
      "evaluate-document-quality",
      () => admitQualityArtifactReply(qualityInput(), reply, context(reply)),
      reply,
    );
    expect(rows[0]).toMatchObject({
      rejectionCode: "quality-envelope-shape",
      rejectionLocation: "$",
      rejectedReplyParseCode: "parsed",
    });
    expect(corrections[1]).toContain(
      "Start the response with a bare JSON object whose only keys are evaluation and qualityScore, with no Markdown fence, heading, or other text before it, then write the report as plain Markdown after it.",
    );
  });

  it("records a long answer wrapped in fences as a shape refusal whose retry keeps the report", async () => {
    // The shape of two hosted Super attempts: the answer object in a fence,
    // then a long report holding another fenced JSON block.
    const reply = `\`\`\`json\n${ANSWER_HEAD}\n\`\`\`\n\n${REPORT}\n${"- Finding.\n".repeat(3000)}\n${SUMMARY_BLOCK}\n`;
    const { corrections, rows } = await refusedStep(
      "evaluate-document-quality",
      "evaluate-document-quality",
      () => admitQualityArtifactReply(qualityInput(), reply, context(reply)),
      reply,
    );
    expect(rows[0]).toMatchObject({
      rejectionCode: "quality-envelope-shape",
      rejectionLocation: "$",
    });
    expect(corrections[1]).toContain("with no Markdown fence, heading, or other text before it");
    expect(corrections[1]).not.toContain("Return the JSON object itself as the whole response");
  });

  // Each way the text after the answer's object is not only a report has its
  // own rule, so the retry names that problem and no other one.
  const REPORT_TAIL_RETRIES = [
    [
      "more JSON after the object",
      `${ANSWER_HEAD}, "reportMarkdown": ${JSON.stringify(REPORT)}}`,
      JSON_AFTER_OBJECT,
      "The JSON object closed, and more JSON followed it instead of the report",
    ],
    [
      "no heading line",
      `${ANSWER_HEAD}\n\nThe page needs work.`,
      NO_HEADING,
      "The text after the JSON object was empty or did not start with a Markdown heading line.",
    ],
    [
      "a code block left open before more text",
      `${ANSWER_HEAD}\n\n# Report\n\n\`\`\`json\n{"a": 1}\n\nMore text.`,
      OPEN_FENCE,
      "A code block in the report was still open when more report text followed it",
    ],
    [
      "an answer member outside code",
      `${ANSWER_HEAD}\n\n${REPORT}\n{"qualityScore": null}`,
      UNFENCED_MEMBER,
      "The report's text names an evaluation, qualityScore, or reportMarkdown JSON member outside a fenced code block or inline code.",
    ],
    [
      "a whole envelope in the report",
      `${ANSWER_HEAD}\n\n# Report\n\n\`\`\`json\n${JSON.stringify(qualityEnvelope())}\n\`\`\``,
      ENVELOPE_IN_REPORT,
      "so the response reads as two answers.",
    ],
  ] as const;

  it.each(REPORT_TAIL_RETRIES)(
    "records an answer with %s under its own rule and retries with only that rule's hint",
    async (_name, reply, rejection, hint) => {
      const { corrections, rows } = await refusedStep(
        "evaluate-document-quality",
        "evaluate-document-quality",
        () => admitQualityArtifactReply(qualityInput(), reply, context(reply)),
        reply,
      );
      expect(rows[0]).toMatchObject({
        rejectionCode: rejection.code,
        rejectionLocation: rejection.location,
      });
      expect(corrections[1]).toContain(
        `The previous response failed host rule ${rejection.code} at ${rejection.location}.`,
      );
      expect(corrections[1]).toContain(hint);
      for (const [, , other, otherHint] of REPORT_TAIL_RETRIES) {
        if (other !== rejection) expect(corrections[1]).not.toContain(otherHint);
      }
      // No hint asks for a fence the model may believe it already closed.
      expect(corrections[1]).not.toContain("Close every code fence");
    },
  );

  it("records a terminal credential review refusal with its code and no host-path metadata", async () => {
    const reply = REVIEW_CASES.find(
      (entry) => entry.name === "credential material in a finding",
    )!.reply;
    const { attempts, rows, lines } = await refusedStep(
      "review-documentation",
      "review-documentation",
      () => admitReviewResultReply(reviewInput(), reply, context(reply)),
      reply,
    );
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.rejection).toEqual({ code: "credential-material", location: "$" });
    expect(Object.hasOwn(attempts[0]!, "hostPathDisclosure")).toBe(false);
    expect(rows[0]).toMatchObject({
      rejectionCode: "credential-material",
      hostPathRoot: null,
      hostPathInAdmittedSource: null,
    });
    expect(lines.some((line) => line.startsWith("Rejected by credential-material at $"))).toBe(
      true,
    );
    expect(lines.join("\n")).not.toContain("host path root");
  });
});

// --------------------------------------------------------------- invariant

/** Every structural mutation of a reply: wrappers, then each key's removal and retyping. */
function mutations(valid: Json): string[] {
  const text = JSON.stringify(valid);
  const out = [
    "",
    "null",
    "[]",
    '"text"',
    "7",
    text.slice(0, Math.floor(text.length / 2)),
    `Here it is:\n${text}`,
    `\`\`\`json\n${text}\n\`\`\``,
    `${text}\n${text}`,
  ];
  const replacements: unknown[] = [undefined, null, 7, "x", [], {}, [null], true];
  const visit = (value: unknown, set: (next: unknown) => void, depth: number): void => {
    if (depth > 4 || !value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        visit(
          item,
          (next) => set(value.map((entry, at) => (at === index ? next : entry))),
          depth + 1,
        );
      });
      if (value.length > 0) set([...value, value[0]]);
      return;
    }
    const object = value as Json;
    set({ ...object, undeclared: 1 });
    for (const key of Object.keys(object)) {
      for (const replacement of replacements) {
        const next: Json = { ...object };
        if (replacement === undefined) delete next[key];
        else next[key] = replacement;
        set(next);
      }
      visit(object[key], (child) => set({ ...object, [key]: child }), depth + 1);
    }
  };
  visit(valid, (next) => out.push(JSON.stringify(next)), 0);
  return out;
}

function expectCodedOrAdmitted(admit: () => unknown): void {
  let error: unknown;
  try {
    admit();
    return;
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(InferenceStepError);
  const failure = error as InferenceStepError;
  expect(failure.category).toBe("malformed-response");
  // No malformed-response leaves these admissions without a closed code...
  expect(failure.rejection).toBeDefined();
  // ...that the record keeps as written...
  expect(retainedInferenceRejection(failure.rejection!)).toEqual(failure.rejection);
  // ...and that a failure class names.
  expect(
    isOutputRuleCode(failure.rejection!.code) ||
      inferenceRejectionFailureClass(failure.rejection!.code) !== undefined,
  ).toBe(true);
}

describe("no malformed reply on these paths is recorded without a code (#1423)", () => {
  const paths: ReadonlyArray<readonly [string, Json, (reply: string) => unknown]> = [
    ["create planner", plan(), (reply) => admitPlannerReply(plannerInput(), reply, context(reply))],
    [
      "restructure planner",
      plan({}, "restructure", "restructure"),
      (reply) =>
        admitPlannerReply(plannerInput("restructure-documentation"), reply, context(reply)),
    ],
    [
      "update editorial planner",
      JSON.parse(
        editorialPlan({
          candidate: "update",
          rationale: RATIONALE,
          slotIds: ["public-contract"],
        }),
      ) as Json,
      (reply) => admitPlannerReply(editorialPlannerInput(), reply, context(reply)),
    ],
    [
      "audience assessment envelope",
      JSON.parse(envelope()) as Json,
      (reply) =>
        admitEditorialAssessmentReply(
          editorialStepInput("test-audience-understanding"),
          reply,
          context(reply),
        ),
    ],
    [
      "review assessment envelope",
      JSON.parse(envelope({ verdict: "pass", issues: [] })) as Json,
      (reply) =>
        admitEditorialAssessmentReply(
          editorialStepInput("review-documentation"),
          reply,
          context(reply),
        ),
    ],
    [
      "review result",
      { verdict: "pass", issues: [] },
      (reply) => admitReviewResultReply(reviewInput(), reply, context(reply)),
    ],
    [
      "nested review result",
      { verdict: "pass", issues: [] },
      (reply) =>
        admitReviewResultReply(editorialStepInput("review-documentation"), reply, context(reply)),
    ],
    [
      "quality artifact envelope",
      qualityEnvelope(),
      (reply) => admitQualityArtifactReply(qualityInput(), reply, context(reply)),
    ],
  ];

  it.each(paths)(
    "every refused mutation of a valid %s reply carries a code",
    (_name, valid, admit) => {
      // The unmutated reply is admitted, so the corpus exercises refusals only.
      expect(() => admit(JSON.stringify(valid))).not.toThrow();
      const corpus = mutations(valid);
      expect(corpus.length).toBeGreaterThan(20);
      for (const reply of corpus) expectCodedOrAdmitted(() => admit(reply));
    },
  );
});
