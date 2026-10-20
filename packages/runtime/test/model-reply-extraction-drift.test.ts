// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { InferenceStepError, type HarnessStepInput } from "../src/execution/contracts.js";
import { jsonEnvelopeBody } from "../src/execution/json-envelope.js";
import { auditJudgmentRowKeys } from "../src/execution/judgment-row-key-audit.js";
import { fingerprintRejectedReply } from "../src/execution/rejected-reply-shape.js";
import { isDeclaredResponseContractKey } from "../src/execution/response-contract-vocabulary.js";
import { decodeEditorialAssessmentResponseV1 } from "../src/harness/editorial-response-contract.js";
import { decodeQualityArtifactResponse } from "../src/harness/quality-candidate-tool.js";
import type { ReplyAdmissionContext } from "../src/harness/reply-admission/context.js";
import { admitEditorialAssessmentReply } from "../src/harness/reply-admission/editorial-assessment.js";
import { admittedReplySpan } from "../src/harness/reply-admission/judgment.js";
import { admitPlannerReply } from "../src/harness/reply-admission/planner.js";
import { admitReviewResultReply } from "../src/harness/reply-admission/review-result.js";
import { isJsonEvidence } from "../src/json-evidence.js";
import type { SemanticJudgeRequest } from "../src/quality-evaluation/contracts.js";
import { ConfiguredEvaluationJudge } from "../src/quality-evaluation/semantic.js";
import { parseAdmissionModelResponse } from "../src/cli/admission-parse.js";
import { decodeSourceReadinessReply } from "../src/readiness/assessment.js";
import {
  decodeRepositoryBootstrapResponse,
  REPOSITORY_BOOTSTRAP_RESULT_KIND,
} from "../src/onboarding/bootstrap-result.js";
import { sealHostRuntimeSemanticComparisonChunk } from "../src/host-invoker/contracts.js";
import { decodeSemanticComparisonProposal } from "../src/host-invoker/reconcile-product-behavior.js";
import { decodeAuthoringRevisionAccounting } from "../src/workflow-execution/authoring-revision.js";
import type { AuthoringRevisionInputV1 } from "../src/workflow-execution/authoring-candidate.js";
import {
  CONTRACT_PLACEHOLDER_ROLES,
  findContractPlaceholderInReply,
} from "../src/workflow-execution/contract-placeholders.js";
import {
  decodeEditorialReviewResponse,
  parseTechnicalResponse,
} from "../src/workflow-execution/review-response.js";
import { decodeSourceObligationResponse } from "../src/workflow-execution/source-obligation.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import { validModelConfig } from "./helpers.js";
import { sourceObligationProposalFixture } from "./helpers/verification.js";

/**
 * Drift guard: every decoder that reads a model reply as JSON extracts the
 * candidate document with the one shared policy, `jsonEnvelopeBody`.
 *
 * Each row is a valid document for one decoder; each form wraps it the way a
 * model does. A decoder must admit a form exactly when the shared policy's span
 * parses, and then decode the same value as the bare document. A raw parser
 * fails on the fenced forms; a wider private unwrap fails on a refused form.
 */

const fence = (body: string, opener = "```json", closer = "```") => `${opener}\n${body}\n${closer}`;

/** How a model wraps one JSON document, in both directions of the policy. */
const FORMS: ReadonlyArray<readonly [string, (document: string) => string]> = [
  ["the bare document", (document) => document],
  ["surrounding whitespace", (document) => `\n  ${document}\n\n`],
  ["a json-tagged backtick fence", (document) => fence(document)],
  ["an untagged backtick fence", (document) => fence(document, "```")],
  ["a tilde fence", (document) => fence(document, "~~~json", "~~~")],
  ["a longer fence run", (document) => fence(document, "````json", "````")],
  ["an indented fence", (document) => fence(document, "  ```json", "  ```")],
  ["prose before the fence", (document) => `Here is the reply:\n\n${fence(document)}`],
  [
    "prose on both sides of the fence",
    (document) => `Here is the reply:\n\n${fence(document)}\n\nLet me know if you need more.`,
  ],
  ["prose before a bare document", (document) => `Here is the reply:\n\n${document}`],
  ["prose after a bare document", (document) => `${document}\n\nThat is the whole reply.`],
  ["an unterminated fence", (document) => `\`\`\`json\n${document}`],
  [
    "a prose fence beside the document fence",
    (document) => `${fence("not json at all", "```text")}\n${fence(document)}`,
  ],
  // Forms the shared policy refuses: the decoder must refuse them too.
  ["two fenced documents", (document) => `${fence(document)}\nor\n${fence(document)}`],
  ["two bare documents", (document) => `${document}\n${document}`],
  ["prose braces before the document", (document) => `The shape is {key: value}.\n${document}`],
  ["one fence around a broken document", (document) => fence(document.slice(0, -1))],
  ["prose with no document", () => "I could not produce the reply."],
];

/** Whether the shared policy's span of `reply` is a JSON document. */
function sharedPolicyAdmits(reply: string): boolean {
  return isJsonEvidence(jsonEnvelopeBody(reply));
}

// ------------------------------------------------------------------ inputs

const REVISION = "0bd6fa60ceefdf49d8b92fb760d446cda3434761";
const PAGE = "docs/cli-reference.md";
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

function plannerInput(): HarnessStepInput {
  return {
    workflow: { name: "create-documentation", schemaVersion: 1, steps: [] },
    step: { id: "plan-documentation", skill: "plan-documentation", mode: "read-only" },
    evidenceIdentity: { repositoryRevision: REVISION },
  } as unknown as HarnessStepInput;
}

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

function reviewInput(): HarnessStepInput {
  return {
    workflow: { name: "create-documentation", schemaVersion: 1, steps: [] },
    step: { id: "review-documentation", skill: "review-documentation", mode: "read-only" },
  } as unknown as HarnessStepInput;
}

const PLAN = {
  summary: "Plan one CLI reference page from the CLI source.",
  planBinding: {
    mode: "create",
    pages: [{ path: PAGE, disposition: "create" }],
    sourceBindings: [{ pagePath: PAGE, sources: ["src/cli.ts"] }],
  },
};

const ASSESSMENT = {
  summary: "The audience exercise found no blocking gap.",
  editorialAssessmentProposal: {
    schemaVersion: 1,
    kind: "docsfab-editorial-assessment-proposal",
    assessment: "accepted",
    rationale: "The admitted context packet supports the audience assessment.",
    evidenceRefs: [ADMITTED_REF],
    limitations: [],
    recommendation: null,
  },
};

const REVISION_INPUT = {
  writePaths: ["docs/guide.md"],
  actionableFacts: [
    { id: "FACT_A", issueIds: ["TECH-001"], sourceLocators: ["src/contract.ts:1-3"] },
  ],
} as unknown as AuthoringRevisionInputV1;

const ACCOUNTING = {
  issueAccounting: [
    {
      issueId: "TECH-001",
      disposition: "applied",
      reason: "The admitted source establishes the bounded correction.",
      sourceLocators: ["src/contract.ts:1-3"],
    },
  ],
  changedPaths: ["docs/guide.md"],
  unresolvedFacts: [],
};

const READINESS_BINDING = {
  runId: "run:source-readiness",
  repositoryRevision: REVISION,
  searchEvidenceSha256: "1".repeat(64),
  contextPacketSha256: "2".repeat(64),
};

const READINESS = {
  schemaVersion: 1,
  kind: "docsfab-source-readiness-assessment",
  ...READINESS_BINDING,
  summary: "The tracked setup source states the exact operation.",
  criteria: ["source-completeness", "source-usability"].map((criterionId) => ({
    criterionId,
    status: "met",
    reason: "The tracked setup source states the exact operation.",
    citations: [{ path: "docs/guide.md", startLine: 3, endLine: 3 }],
  })),
};

const BOOTSTRAP = {
  schemaVersion: 1,
  kind: REPOSITORY_BOOTSTRAP_RESULT_KIND,
  binding: {
    runId: "run-repository-bootstrap",
    repositoryRevision: REVISION,
    contextSha256: "3".repeat(64),
  },
  decision: "needs-input",
  summary: "The release owner is not named in tracked guidance.",
  changedPaths: [],
  evidence: [{ path: "README.md", startLine: 1, endLine: 2 }],
  assumptions: [],
  missingEvidence: [],
  questions: ["Who owns the release step?"],
};

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const COMPARISON_STATEMENT = "Ordinary messages require a mention before a reply.";
const COMPARISON_SOURCE = "export const requiresMention = true;\n";
const COMPARISON_CHUNK = sealHostRuntimeSemanticComparisonChunk({
  schemaVersion: 1,
  kind: "docsfab-semantic-comparison-chunk",
  projectId: "project-fixture",
  caseKind: "merge",
  caseSha256: "5".repeat(64),
  comparisonSha256: "6".repeat(64),
  baselineGeneration: 1,
  baselineSha256: "7".repeat(64),
  approvalReceiptSha256: "8".repeat(64),
  modelSha256: "9".repeat(64),
  canonSha256: "a".repeat(64),
  sourceInventorySha256: "b".repeat(64),
  ordinal: 1,
  chunkCount: 1,
  claims: [
    {
      claimId: "CLAIM-MENTION",
      statement: COMPARISON_STATEMENT,
      statementSha256: sha256(COMPARISON_STATEMENT),
      scope: "ordinary messages",
      recordSha256: "d".repeat(64),
    },
  ],
  evidence: [
    {
      evidenceId: "source-after",
      kind: "repository-after",
      version: REVISION,
      sourcePath: "src/router.ts",
      change: "modified",
      content: COMPARISON_SOURCE,
      contentSha256: sha256(COMPARISON_SOURCE),
      sourceContentSha256: sha256(COMPARISON_SOURCE),
      startByte: 0,
      endByte: Buffer.byteLength(COMPARISON_SOURCE),
      totalBytes: Buffer.byteLength(COMPARISON_SOURCE),
      sourceVersionSha256: null,
    },
  ],
});

const COMPARISON = {
  schemaVersion: 1,
  kind: "docsfab-semantic-comparison-proposal",
  inputSha256: COMPARISON_CHUNK.inputSha256,
  assessments: [
    {
      evidenceId: "source-after",
      claimId: "CLAIM-MENTION",
      relationship: "compatible",
      assertion: "observed-implementation",
      explanation: "The after source keeps the mention requirement.",
      scope: "ordinary messages",
      confidence: "high",
      modelCitation: { evidenceId: "CLAIM-MENTION", quote: COMPARISON_STATEMENT },
      sourceCitations: [{ evidenceId: "source-after", quote: COMPARISON_SOURCE }],
    },
  ],
  missingEvidence: [],
};

const PLAN_SUMMARY = CONTRACT_PLACEHOLDER_ROLES.planSummary;

/** A decoder's value for a reply; it throws, or returns undefined, to refuse. */
type Decoder = (reply: string) => unknown;

/**
 * Every model-reply JSON decoder, with one valid document for it. A decoder
 * without a row here is not guarded, so a new model-reply decoder adds its row.
 */
const DECODERS: ReadonlyArray<readonly [string, unknown, Decoder]> = [
  [
    "planner admission",
    PLAN,
    (reply) => {
      // The reply digest names each reply's own bytes; the bound plan is what must match.
      const admitted = admitPlannerReply(plannerInput(), reply, context(reply));
      if (admitted?.outcome !== "completed") return admitted;
      const { planResponseSha256: _digest, ...binding } = admitted;
      return binding;
    },
  ],
  [
    "editorial assessment envelope admission",
    ASSESSMENT,
    (reply) =>
      admitEditorialAssessmentReply(
        editorialStepInput("test-audience-understanding"),
        reply,
        context(reply),
      ),
  ],
  ["editorial assessment envelope decoder", ASSESSMENT, decodeEditorialAssessmentResponseV1],
  [
    "source-obligation ledger",
    sourceObligationProposalFixture(),
    (reply) => decodeSourceObligationResponse(reply),
  ],
  [
    "technical verification, correction, and provisional judgment",
    { review: { verdict: "pass", issues: [] } },
    (reply) => parseTechnicalResponse(reply, "review"),
  ],
  ["editorial review result", { verdict: "pass", issues: [] }, decodeEditorialReviewResponse],
  [
    "review result admission",
    { verdict: "pass", issues: [] },
    (reply) => admitReviewResultReply(reviewInput(), reply, context(reply)),
  ],
  [
    "quality artifact",
    { evaluation: { decision: "pass" }, qualityScore: null, reportMarkdown: "# Report" },
    (reply) =>
      decodeQualityArtifactResponse(reply, {
        selectionSha256: "4".repeat(64),
      } as unknown as Parameters<typeof decodeQualityArtifactResponse>[1]),
  ],
  [
    "contract placeholder scan",
    { summary: PLAN_SUMMARY.placeholder },
    (reply) =>
      findContractPlaceholderInReply(
        reply,
        new Set(["planSummary"]),
        isDeclaredResponseContractKey,
      ),
  ],
  [
    "judgment row key audit",
    { issueJudgments: [{ issueId: "TECH-001" }], obligationJudgments: [] },
    (reply) => auditJudgmentRowKeys(reply, isDeclaredResponseContractKey),
  ],
  // These three decode outside the harness, which hands each only the final
  // settled assistant message, so the shared policy cannot reach an earlier
  // turn's document (`final-turn-reply-decoding.test.ts`).
  [
    "source readiness assessment",
    READINESS,
    (reply) => decodeSourceReadinessReply(reply, READINESS_BINDING),
  ],
  ["repository bootstrap result", BOOTSTRAP, decodeRepositoryBootstrapResponse],
  [
    "semantic comparison proposal",
    COMPARISON,
    (reply) => decodeSemanticComparisonProposal(reply, COMPARISON_CHUNK),
  ],
  [
    "rejected reply fingerprint",
    { verdict: "pass", issues: [] },
    (reply) => {
      const shape = fingerprintRejectedReply(
        admittedReplySpan(reviewInput(), reply)!,
        isDeclaredResponseContractKey,
      );
      return shape.parse.status === "parsed" ? shape : undefined;
    },
  ],
];

/**
 * Decoders that deliberately differ from the shared policy; this table asserts
 * that each still diverges, and the change that aligns one moves its row into
 * {@link DECODERS}.
 *
 * - Authoring revision accounting refuses a fenced or prose-wrapped accounting
 *   as `revision-accounting-invalid-json`, a rule its contract states to the
 *   model.
 * - The workflow admission router takes the first balanced object anywhere in
 *   the reply, which is wider than the shared policy.
 */
const DIVERGENT: ReadonlyArray<readonly [string, unknown, Decoder]> = [
  [
    "authoring revision accounting",
    ACCOUNTING,
    (reply) => decodeAuthoringRevisionAccounting(reply, REVISION_INPUT),
  ],
  ["workflow admission router", { workflow: "review-documentation" }, parseAdmissionModelResponse],
];

/** The semantic judge decodes a provider completion, so it is awaited. */
async function judgeDecision(reply: string): Promise<unknown> {
  return new ConfiguredEvaluationJudge(validModelConfig, async () => reply).grade(
    {} as SemanticJudgeRequest,
  );
}

function decoded(decode: Decoder, reply: string): { admitted: boolean; value?: unknown } {
  try {
    const value = decode(reply);
    return value === undefined ? { admitted: false } : { admitted: true, value };
  } catch {
    return { admitted: false };
  }
}

describe("every model-reply decoder reads the one shared extraction policy (#1426)", () => {
  it("covers wrappings the policy admits and wrappings it refuses", () => {
    const document = JSON.stringify(PLAN);
    const admitted = FORMS.filter(([, wrap]) => sharedPolicyAdmits(wrap(document)));
    // A raw parser refuses every admitted form that is not already bare JSON,
    // so these forms are what fails a decoder that skips the shared policy.
    expect(admitted.filter(([, wrap]) => !isJsonEvidence(wrap(document).trim()))).not.toHaveLength(
      0,
    );
    expect(admitted.length).toBeLessThan(FORMS.length);
  });

  describe.each(DECODERS)("the %s", (_name, valid, decode) => {
    const document = JSON.stringify(valid);
    const bare = decoded(decode, document);

    it("admits its bare valid document", () => {
      expect(bare.admitted).toBe(true);
    });

    it.each(FORMS)("admits or refuses as the shared policy does on %s", (_form, wrap) => {
      const reply = wrap(document);
      const actual = decoded(decode, reply);
      expect(actual.admitted).toBe(sharedPolicyAdmits(reply));
      // Admitted means the same document, not some other span of the reply.
      if (actual.admitted) expect(actual.value).toEqual(bare.value);
    });
  });

  it.each(DIVERGENT)(
    "still records the %s as a divergence #1426 reported",
    (_name, valid, decode) => {
      const document = JSON.stringify(valid);
      expect(decoded(decode, document).admitted).toBe(true);
      const disagreements = FORMS.filter(
        ([, wrap]) =>
          decoded(decode, wrap(document)).admitted !== sharedPolicyAdmits(wrap(document)),
      );
      expect(disagreements).not.toHaveLength(0);
    },
  );

  describe("the semantic evaluation judge", () => {
    const document = JSON.stringify({ passed: true, score: 0.75, rationale: "Supported." });

    it.each(FORMS)(
      "decides a judge completion as the shared policy does on %s",
      async (_form, wrap) => {
        const reply = wrap(document);
        const bare = await judgeDecision(document);
        if (sharedPolicyAdmits(reply)) {
          await expect(judgeDecision(reply)).resolves.toEqual(bare);
        } else {
          await expect(judgeDecision(reply)).rejects.toThrow();
        }
      },
    );
  });

  it("refuses a non-JSON reply at the planner and envelope with invalid-json at $", () => {
    const broken = fence(JSON.stringify(PLAN).slice(0, -1));
    const planner = refusal(() => admitPlannerReply(plannerInput(), broken, context(broken)));
    expect(planner.rejection).toEqual({ code: "invalid-json", location: "$" });
    const envelope = fence(JSON.stringify(ASSESSMENT).slice(0, -1));
    const assessment = refusal(() =>
      admitEditorialAssessmentReply(
        editorialStepInput("test-audience-understanding"),
        envelope,
        context(envelope),
      ),
    );
    expect(assessment.rejection).toEqual({ code: "invalid-json", location: "$" });
  });

  it("makes the planner judge a broken json answer instead of a valid text illustration", () => {
    const reply = `${fence(JSON.stringify(PLAN), "```text")}\n${fence("{oops}")}`;
    const planner = refusal(() => admitPlannerReply(plannerInput(), reply, context(reply)));
    expect(planner.rejection).toEqual({ code: "invalid-json", location: "$" });
    expect(jsonEnvelopeBody(reply)).toBe("{oops}");
  });

  it("names two eligible fences as wrapped even when only the first parses", () => {
    const reply = `${fence(JSON.stringify(PLAN))}\n${fence("{oops}")}`;
    const planner = refusal(() => admitPlannerReply(plannerInput(), reply, context(reply)));
    expect(planner.rejection).toEqual({ code: "reply-json-wrapped", location: "$" });
    expect(jsonEnvelopeBody(reply)).toBe(reply);
  });
});

function refusal(run: () => unknown): InferenceStepError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(InferenceStepError);
    return error as InferenceStepError;
  }
  throw new Error("The reply was admitted.");
}
