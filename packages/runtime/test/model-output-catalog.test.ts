// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  OUTPUT_CONTRACTS,
  OUTPUT_RECORD_CONTRACTS,
  OUTPUT_GRAMMARS,
  OUTPUT_REPLAY_MODES,
  OUTPUT_RULE_FAMILIES,
  OUTPUT_RULES,
  isOutputRuleCode,
  outputRuleFor,
  outputRuleHintCatalog,
  rejectOutput,
  renderOutputText,
  renderResponseContract,
  type OutputCatalogTables,
  type OutputRuleDeclaration,
  type OutputRuleFamily,
} from "../src/contracts/model-output.js";
import { DurableArtifactStore } from "../src/artifacts/store.js";
import { canonicalDigest } from "../src/content-ir/canonical.js";
import {
  INFERENCE_REJECTION_CODE_GRAMMAR,
  INFERENCE_REJECTION_LOCATION_GRAMMAR,
} from "../src/config/inference-rejection-limits.js";
import { limit } from "../src/config/limits.js";
import { createDocumentationPlanBinding } from "../src/workflow-execution/plan-binding.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import { InferenceStepError, type HarnessStepInput } from "../src/execution/contracts.js";
import {
  admitAnswerRecordCall,
  createAnswerRecordLedger,
  planAnswerRecords,
  type AnswerRecordReceipt,
} from "../src/harness/answer-records.js";
import { createQualityAnswerRecordAdmission } from "../src/harness/quality-answer-record-admission.js";
import { admitEditorialAssessmentReply } from "../src/harness/reply-admission/editorial-assessment.js";
import { admitPlannerReply } from "../src/harness/reply-admission/planner.js";
import {
  admitQualityArtifactReply,
  admitQualitySubmissionReply,
  decodeQualitySubmissionCall,
  qualitySubmissionCutFailure,
} from "../src/harness/reply-admission/quality-artifact.js";
import type { QualitySubmissionMembers } from "../src/harness/quality-candidate-tool.js";
import { admitReviewResultReply } from "../src/harness/reply-admission/review-result.js";
import { recordedCodeGrammar, recordedLocationGrammar } from "../scripts/check-model-output.mjs";
import { ruleHintFor } from "../src/workflow-execution/rejection-rule-hints.js";
import type { AuthoringRevisionInputV1 } from "../src/workflow-execution/authoring-candidate.js";
import {
  decodeProvisionalVerificationJudgment,
  decodeSourceObligationResponse,
  assertObservableUpdateSourceLocators,
  sourceProposalRefusalError,
  type SourceObligationLedgerV2,
} from "../src/workflow-execution/source-obligation.js";
import {
  admitOriginalSourceAuthorityProposals,
  sealOriginalSourceAuthority,
} from "../src/workflow-execution/source-obligation-authority.js";
import {
  SourceReadinessAssessmentError,
  admitSourceReadinessReply,
  decodeSourceReadinessReply,
  sourceReadinessStepError,
  type SourceReadinessBinding,
} from "../src/readiness/assessment.js";
import {
  SourceCitationRefusal,
  type ObservedSourceLinesV1,
  type SourceCitationSource,
} from "../src/repository/source-citation.js";
import {
  admitRequestIntent,
  decodeRequestIntentProposal,
  resolveRequestIntentLimits,
  type RequestIntentAdmissionInput,
  type RequestIntentAdmissionResult,
} from "../src/request-intent/index.js";
import {
  decodeAuthoringRevisionAccounting,
  validateAuthoringRevisionMutation,
} from "../src/workflow-execution/authoring-revision.js";
import { detectCredentialRuleIds } from "../src/security/repository-scanner.js";
import { configureCredential } from "./helpers/configured-credential.js";
import { plantedCredentialValue } from "./helpers/planted-credential.js";

const repositoryRoot = resolve(import.meta.dirname, "../../..");

interface RuleFixture {
  readonly schemaVersion: 1;
  readonly kind: "docsfab-output-rule-fixture";
  readonly code: string;
  readonly location: string;
  readonly input: Record<string, unknown>;
  readonly reply: string;
}

/** Runs one rejected reply through a family's real decoder and returns what it raised. */
type FixtureRunner = (fixture: RuleFixture) => unknown;

/**
 * One runner per catalog family. Keyed by the generated family union, so a new
 * family does not typecheck until its fixtures run through its real decoder.
 */
const FIXTURE_RUNNERS: Record<OutputRuleFamily, FixtureRunner> = {
  "revision-accounting": (fixture) => {
    const revision = fixture.input.revision as AuthoringRevisionInputV1;
    const mutation = fixture.input.mutation as
      | { actualChangedPaths: string[]; unchanged: boolean }
      | undefined;
    try {
      const accounting = decodeAuthoringRevisionAccounting(fixture.reply, revision);
      if (mutation) {
        validateAuthoringRevisionMutation({
          accounting,
          actualChangedPaths: mutation.actualChangedPaths,
          candidate0PatchSha256: "1".repeat(64),
          candidate1PatchSha256: (mutation.unchanged ? "1" : "2").repeat(64),
        });
      }
    } catch (error) {
      return error;
    }
    return undefined;
  },
  // The planner's own reply admission, which binds the plan.
  "plan-source-locator": (fixture) => runPlannerAdmission(fixture),
  // The same planner admission, for the rules no shared code states.
  "documentation-plan": (fixture) => runPlannerAdmission(fixture),
  // The planner parses the whole reply, so a wrapped plan fires here.
  "reply-json": (fixture) => runPlannerAdmission(fixture),
  // The update-documentation editorial assessment envelope admission.
  "editorial-assessment": (fixture) => {
    const input = {
      workflow: { name: "update-documentation", schemaVersion: 2, steps: [] },
      step: {
        id: fixture.input.step as string,
        skill: fixture.input.step as string,
        mode: "read-only",
      },
      editorialEvidenceRefs: fixture.input.admittedEvidenceRefs,
    } as unknown as HarnessStepInput;
    try {
      admitEditorialAssessmentReply(input, fixture.reply, admissionContext(fixture.reply));
    } catch (error) {
      return error;
    }
    return undefined;
  },
  // The review-documentation step's review result admission.
  "review-result": (fixture) => {
    const input = {
      workflow: { name: fixture.input.workflow as string, schemaVersion: 1, steps: [] },
      step: { id: "review-documentation", skill: "review-documentation", mode: "read-only" },
    } as unknown as HarnessStepInput;
    try {
      admitReviewResultReply(input, fixture.reply, admissionContext(fixture.reply));
    } catch (error) {
      return error;
    }
    return undefined;
  },
  // The review-documentation final quality evaluator's envelope admission.
  "quality-envelope": (fixture) => {
    const input = {
      workflow: { name: fixture.input.workflow as string, schemaVersion: 1, steps: [] },
      step: {
        id: "evaluate-document-quality",
        skill: "evaluate-document-quality",
        kind: "evaluate",
        mode: "read-only",
      },
      qualityProfileSelection: { selectionSha256: "a".repeat(64) },
    } as unknown as HarnessStepInput;
    try {
      admitQualityArtifactReply(input, fixture.reply, admissionContext(fixture.reply));
    } catch (error) {
      return error;
    }
    return undefined;
  },
  // The final quality evaluator's answer submitted through the tool call
  // (#1707): the settlement decode of the raw arguments, the cut rule, and the
  // report admission, as the harness runs them.
  "quality-submission": (fixture) => {
    const input = {
      workflow: { name: fixture.input.workflow as string, schemaVersion: 1, steps: [] },
      step: {
        id: "evaluate-document-quality",
        skill: "evaluate-document-quality",
        kind: "evaluate",
        mode: "read-only",
      },
      qualityProfileSelection: { selectionSha256: "a".repeat(64) },
      answerSubmission: { path: "tool-call", reason: "recorded-route" },
    } as unknown as HarnessStepInput;
    if (fixture.input.lengthStopped === true) return qualitySubmissionCutFailure(16_384);
    const submission = fixture.input.submission as string | undefined;
    let members: QualitySubmissionMembers | undefined;
    if (submission !== undefined) {
      const decoded = decodeQualitySubmissionCall(submission);
      if ("failure" in decoded) return decoded.failure;
      members = decoded.members;
    }
    try {
      admitQualitySubmissionReply(input, members, fixture.reply, admissionContext(fixture.reply));
    } catch (error) {
      return error;
    }
    return undefined;
  },
  // The judgment fill that provisional verification and the V3 correction
  // share.
  "technical-judgment": (fixture) => {
    try {
      decodeProvisionalVerificationJudgment(
        fixture.reply,
        fixture.input.ledger as SourceObligationLedgerV2,
        fixture.input.targetPaths as string[],
      );
    } catch (error) {
      return error;
    }
    return undefined;
  },
  // The derive-source-obligations reply decoder the harness runs on step 2.
  "source-obligation": (fixture) => {
    try {
      const proposal = decodeSourceObligationResponse(
        fixture.reply,
        fixture.input.runRevision as string | undefined,
        // A fixture that names a plan decodes as that CREATE step would.
        fixture.input.plan ? { input: sourceObligationFixtureInput(fixture.input) } : {},
      );
      if (Array.isArray(fixture.input.observablePaths)) {
        const observable = (path: string) => fixture.input.observablePaths.includes(path);
        assertObservableUpdateSourceLocators(
          proposal,
          { workflow: getWorkflow("update-documentation") },
          observable,
          observable,
        );
      }
      // CREATE proposal refusals are emitted after decoding, at the host
      // authority-admission boundary. Exercise that production boundary for
      // this catalog rule instead of pretending the decoder emits it.
      if (fixture.code === "source-proposal-refused") {
        const authority = sealOriginalSourceAuthority({
          runId: "catalog-source-proposal-fixture",
          scope: "create-plan-sources",
          repositoryRevision: fixture.input.runRevision as string,
          scopeSha256: "a".repeat(64),
          workspaceSnapshotSha256: "b".repeat(64),
          members: [
            {
              path: "src/cli.py",
              mode: 0o644,
              byteLength: 1,
              sourceSha256: "c".repeat(64),
            },
          ],
        }).evidence;
        const admission = admitOriginalSourceAuthorityProposals({
          runId: "catalog-source-proposal-fixture",
          authority,
          originalPaths: ["src/cli.py"],
          writePaths: ["docs/routing/guide.md"],
          trackedEntries: [],
          proposals: proposal.sourceProposals ?? [],
          attempt: 1,
        });
        const refusal = admission.admissions.find((row) => row.status === "refused");
        if (refusal) throw sourceProposalRefusalError(refusal.path);
      }
    } catch (error) {
      return error;
    }
    return undefined;
  },
  // The source readiness reply decoder and the shared citation minter, the
  // same synchronous path the readiness harness wrapper runs.
  "source-citation": (fixture) => {
    const input = fixture.input as {
      binding: SourceReadinessBinding;
      files: Record<string, string>;
      unreadable?: string[];
      overBoundFiles?: string[];
      observed: ObservedSourceLinesV1;
    };
    const sources = new Map<string, SourceCitationSource>(
      Object.entries(input.files).map(([path, text]) => [path, Buffer.from(text, "utf8")]),
    );
    for (const path of input.unreadable ?? []) sources.set(path, Buffer.from([0xff, 0xfe, 0x00]));
    for (const path of input.overBoundFiles ?? [])
      sources.set(
        path,
        Buffer.from(`${"x".repeat(limit("sourceCitation.mintedMaxChars").value + 1)}\n`),
      );
    try {
      admitSourceReadinessReply(
        decodeSourceReadinessReply(fixture.reply, input.binding),
        sources,
        input.observed,
      );
    } catch (error) {
      if (error instanceof SourceCitationRefusal || error instanceof SourceReadinessAssessmentError)
        return sourceReadinessStepError(error);
      return error;
    }
    return undefined;
  },
  // Request-intent admission returns a result arm instead of throwing; the
  // runner returns that arm. Decode and admission run as the caller will, and
  // every host input comes from the fixture: none is defaulted here.
  "request-intent": (fixture) => {
    // readFixture has already filled and configured any synthetic credential.
    const input = fixture.input as Omit<RequestIntentAdmissionInput, "instruction" | "limits"> & {
      instruction: string;
    };
    const instruction = input.instruction;
    const limits = resolveRequestIntentLimits();
    const decoded = decodeRequestIntentProposal(JSON.parse(fixture.reply), {
      instruction,
      limits,
    });
    if (decoded.outcome !== "decoded") return decoded;
    const admitted = admitRequestIntent(decoded, {
      instruction,
      limits,
      inventory: input.inventory,
      declaredOperation: input.declaredOperation,
      docsRoot: input.docsRoot,
      grantedWriteScope: input.grantedWriteScope,
      navigationSet: input.navigationSet,
      existence: input.existence,
    });
    return admitted.outcome === "admitted" ? undefined : admitted;
  },
  // One submit_answer_record call through the records core's decoder and
  // ledger, after the fixture's earlier calls, on a small skeleton of the real
  // step 8 declaration. A fixture may lower a limit to reach its bound.
  "answer-record": (fixture) => {
    if (fixture.code === "answer-record-target-path") {
      return runTargetPathAdmissionFixture(fixture);
    }
    const overrides = (fixture.input.limits ?? {}) as Record<string, number>;
    const plan = planAnswerRecords({
      declaration:
        OUTPUT_RECORD_CONTRACTS[fixture.input.contract as keyof typeof OUTPUT_RECORD_CONTRACTS],
      skeletons: ANSWER_RECORD_FIXTURE_SKELETONS,
      selectors: {
        dimensionKey: ANSWER_RECORD_FIXTURE_SKELETONS.dimensions.map((entry) => entry.key),
      },
      limitValue: (name) => overrides[name] ?? limit(name).value,
    });
    let ledger = createAnswerRecordLedger(plan);
    for (const raw of (fixture.input.prior ?? []) as string[]) {
      ledger = admitAnswerRecordCall(ledger, raw).ledger;
    }
    const { receipt } = admitAnswerRecordCall(ledger, fixture.reply);
    return receipt.status === "refused" ? receipt : undefined;
  },
};

async function runTargetPathAdmissionFixture(fixture: RuleFixture): Promise<unknown> {
  if (fixture.input.contract !== "quality-evaluation") {
    throw new Error(
      "Target-path catalog fixtures require the complete quality-evaluation contract.",
    );
  }
  const declaration = OUTPUT_RECORD_CONTRACTS["quality-evaluation"];
  const skeletons = ANSWER_RECORD_FIXTURE_SKELETONS;
  const plan = planAnswerRecords({
    declaration,
    skeletons,
    selectors: { dimensionKey: skeletons.dimensions.map((entry) => entry.key) },
    limitValue: (name) => limit(name).value,
  });
  const root = await mkdtemp(join(tmpdir(), "answer-record-catalog-admission-"));
  try {
    const store = new DurableArtifactStore(root);
    await store.initialize();
    const digest = "a".repeat(64);
    const namespaces = declaration.references.map((reference) => reference.namespace);
    const session = createQualityAnswerRecordAdmission({
      store,
      declaration,
      plan,
      bindings: {
        runId: "catalog-fixture-run",
        stepId: "evaluate-document-quality",
        attempt: 1,
        declarationSha256: canonicalDigest(declaration),
        schemaSha256s: Object.fromEntries(
          Object.keys(declaration.canonical.members).map((name) => [name, digest]),
        ),
        profilePayloadSha256: "b".repeat(64),
        selectionSha256: "c".repeat(64),
        referenceSourceSha256s: Object.fromEntries(namespaces.map((name) => [name, digest])),
        evaluatorIdentitySha256: "d".repeat(64),
        compositionSha256: "e".repeat(64),
        answerPathCapabilitySha256: "f".repeat(64),
      },
      hostMinted: {} as never,
      references: { "audience-attempt": [] },
      referenceIds: Object.fromEntries(namespaces.map((name) => [name, []])),
      renderReference: () => [],
      derive: async () => ({ status: "open", open: ["fixture"] }),
      recordNarrowing: {
        profilePayloadSha256: "b".repeat(64),
        selectionSha256: "c".repeat(64),
        qualityPolicySha256: digest,
        requiredDimensionIds: ["factual-accuracy"],
        hardGateIds: ["fixture-gate"],
        confidenceAnchors: [0.25, 0.5, 0.75],
        d3ResidualDecisions: ["no-shortfall"],
        qualityEvaluationTargetPaths: fixture.input.allowedTargetPaths as string[],
      },
      validateRecords: async (records) =>
        records.map(({ toolCallId }) => ({ toolCallId, status: "valid" as const })),
      validateCompletion: async () => ({ status: "valid" }),
    });
    const toolCallId = "catalog-target-path-fixture";
    await session.capability.prepareBatch({
      batchId: toolCallId,
      toolCalls: [{ toolCallId, rawArguments: fixture.reply }],
      authorizedToolCallIds: [toolCallId],
    });
    return session.capability.receipt(toolCallId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** A two-dimension, one-constraint skeleton for the answer-record fixtures. */
const ANSWER_RECORD_FIXTURE_SKELETONS = {
  dimensions: [
    { key: "factual-accuracy", slot: "trustworthy_information" },
    { key: "audience-fit", slot: "transferable_understanding" },
  ],
  constraints: [{ key: "accessibility-and-inclusion", slot: "accessibility_and_inclusion" }],
  layers: [
    { key: "trustworthy_information", slot: "trustworthy_information" },
    { key: "transferable_understanding", slot: "transferable_understanding" },
  ],
};

/**
 * What a runner raised, as code, location and retryability: a thrown
 * InferenceStepError, or a request-intent result arm, an advisory included:
 * it records its code at its location while the run goes on.
 */
function observedRejection(
  raised: unknown,
): { code: string; location: string; retryable: boolean } | undefined {
  if (raised instanceof InferenceStepError) {
    expect(raised.category).toBe("malformed-response");
    return raised.rejection ? { ...raised.rejection, retryable: raised.retryable } : undefined;
  }
  if (
    raised &&
    typeof raised === "object" &&
    (raised as { status?: unknown }).status === "refused"
  ) {
    // An answer-record receipt: content-free, with the catalog's disposition.
    const receipt = raised as AnswerRecordReceipt;
    return {
      code: receipt.code!,
      location: receipt.location!,
      retryable: receipt.retry === "model-correctable",
    };
  }
  if (
    raised &&
    typeof raised === "object" &&
    "outcome" in raised &&
    ["rejected", "refused", "question", "advisory"].includes(
      (raised as { outcome: string }).outcome,
    )
  ) {
    const arm = raised as RequestIntentAdmissionResult & { code: string; location: string };
    return {
      code: arm.code,
      location: arm.location,
      retryable: arm.outcome === "rejected" && arm.retry === "model-correctable",
    };
  }
  return undefined;
}

function admissionContext(reply: string) {
  return {
    decodedResponse: reply,
    collectAttemptEvidence: () => ({}),
    refuseContractPlaceholder: () => undefined,
  };
}

function runPlannerAdmission(fixture: RuleFixture): unknown {
  const input = {
    workflow: { name: fixture.input.workflow as string, schemaVersion: 1, steps: [] },
    step: { id: "plan-documentation", skill: "plan-documentation", mode: "read-only" },
    evidenceIdentity: { repositoryRevision: fixture.input.repositoryRevision as string },
  } as unknown as HarnessStepInput;
  try {
    admitPlannerReply(input, fixture.reply, admissionContext(fixture.reply));
  } catch (error) {
    return error;
  }
  return undefined;
}

/**
 * A fixture that names `input.syntheticCredential` quotes that placeholder
 * where a credential would be. It is filled here with a value that does not
 * look like a credential, so no credential-shaped literal sits in a committed
 * file, and the value becomes one of DocsFab's own configured credentials for
 * the test: only a configured credential is a disclosure, so the rule fires by
 * exact match and never by shape (#1807).
 */
function readFixture(path: string): RuleFixture {
  const fixture = JSON.parse(readFileSync(resolve(repositoryRoot, path), "utf8")) as RuleFixture;
  const placeholder = fixture.input.syntheticCredential;
  if (typeof placeholder !== "string") return fixture;
  const credential = configureCredential(["meadow", plantedCredentialValue(99, 24)].join("-"));
  const fill = (value: unknown): unknown =>
    typeof value === "string"
      ? value.replaceAll(placeholder, credential)
      : Array.isArray(value)
        ? value.map(fill)
        : value;
  const filled = {
    ...fixture,
    input: Object.fromEntries(
      Object.entries(fixture.input)
        .filter(([key]) => key !== "syntheticCredential")
        .map(([key, value]) => [key, fill(value)]),
    ),
    reply: fill(fixture.reply) as string,
  };
  // The filled fixture holds no credential shape, so only the exact match can fire.
  expect(detectCredentialRuleIds(JSON.stringify(filled)), path).toEqual([]);
  return filled;
}

describe("model-output catalog fixtures (#1130 coverage)", () => {
  const rules = Object.values(OUTPUT_RULES) as OutputRuleDeclaration[];
  // These rules need their later host admission seams. The quality residual
  // fixture runs through QualityValidatorHost; the target-path fixture runs
  // through the quality answer-record session, where target narrowing exists.
  const admissionFixtures = rules.flatMap((rule) =>
    rule.fixtures
      .filter(
        () =>
          rule.code !== "evaluation-layer-residual-invalid" &&
          rule.code !== "answer-record-target-path",
      )
      .map((path) => [rule.code, path] as const),
  );

  it.each(admissionFixtures)(
    "%s fires at a declared location through its production admission path (%s)",
    async (code, path) => {
      const rule = outputRuleFor(code)!;
      const fixture = readFixture(path);
      const raised = await FIXTURE_RUNNERS[rule.family as OutputRuleFamily](fixture);

      const observed = observedRejection(raised);
      expect(observed, String(raised)).toBeDefined();
      expect({ code: observed!.code, location: observed!.location }).toEqual({
        code: fixture.code,
        location: fixture.location,
      });
      expect(rule.locations).toContain(observed!.location);
      // Every code a validator raises is declared, and its retry follows the catalog.
      expect(isOutputRuleCode(observed!.code)).toBe(true);
      expect(observed!.retryable).toBe(rule.retry === "model-correctable");
    },
  );

  it("gives every rule at least one fixture and every family a replay mode it declares", () => {
    for (const rule of rules) expect(rule.fixtures.length, rule.code).toBeGreaterThan(0);
    expect(
      outputRuleFor("evaluation-layer-residual-invalid")?.fixtures,
      "the host-derivation replay consumes this single declared fixture",
    ).toEqual([
      "packages/runtime/test/fixtures/model-output/quality-envelope/layer-residual-invalid.json",
    ]);
    expect(
      outputRuleFor("answer-record-target-path")?.fixtures,
      "the quality-session replay consumes this single declared fixture",
    ).toEqual([
      "packages/runtime/test/fixtures/model-output/answer-record/target-path-outside.json",
    ]);
    for (const family of Object.values(OUTPUT_RULE_FAMILIES)) {
      if (family.replay) expect(Object.keys(OUTPUT_REPLAY_MODES)).toContain(family.replay);
    }
  });
});

describe("model-output catalog runtime reader", () => {
  it("names a rule only through a declared code and location", () => {
    expect(rejectOutput("revision-accounting-invalid-json", "$")).toEqual({
      code: "revision-accounting-invalid-json",
      location: "$",
    });
    expect(Object.isFrozen(rejectOutput("revision-accounting-invalid-json", "$"))).toBe(true);
    for (const code of ["invalid-json", "revision-accounting-", "constructor", undefined, 7]) {
      expect(isOutputRuleCode(code), String(code)).toBe(false);
    }
  });

  it("renders the authoring-revision contract from the rules it lists, in order", () => {
    const text = renderResponseContract("authoring-revision", {
      "selected-issue-ids": '["TECH-001"]',
      "admitted-source-locators": "[]",
      "sealed-revision-input": "{}",
    });
    const lines = text.split("\n");
    expect(lines[0]).toBe(OUTPUT_CONTRACTS["authoring-revision"].title);
    for (const entry of OUTPUT_CONTRACTS["authoring-revision"].render) {
      if ("rule" in entry) expect(lines).toContain(OUTPUT_RULES[entry.rule].statement);
    }
    expect(lines.indexOf("Selected issue ids:") + 1).toBe(lines.indexOf('["TECH-001"]'));
    expect(text).not.toMatch(/\{(limit|grammar):/u);
  });
});

/**
 * Fields the pilot family does not use: a location-specific sentence, a host
 * detail, a pattern member, a used code, the catch-all, and placeholders. The
 * rules below are test data only.
 */
describe("model-output catalog fields beyond the pilot", () => {
  const rule = (overrides: Partial<OutputRuleDeclaration>): OutputRuleDeclaration => ({
    code: "inventory-dimension-facts",
    family: "technical-review",
    pattern: null,
    locations: ["$.factInventory", "$.obligationJudgments"],
    kind: "content",
    retry: "model-correctable",
    reason: "Whether a dimension lists facts follows from its status.",
    failureClass: "model-content",
    failureClassReason: null,
    statement:
      "An applicable dimension needs at least one fact; a not-applicable or unverified dimension lists none.",
    atLocation: {
      "$.obligationJudgments":
        "Each applicable ledger dimension must keep at least one retained or refined obligation.",
    },
    hostDetail: "emptied-dimensions",
    outer: null,
    catchAll: false,
    aliases: [],
    operator: { kind: "correct", meaning: "m", next: "n" },
    fixtures: [],
    docs: "inventory-dimension-facts",
    ...overrides,
  });
  const tables: OutputCatalogTables = {
    rules: {
      "inventory-dimension-facts": rule({}),
      "review-schema-enum": rule({
        code: "review-schema-enum",
        pattern: "review-schema-",
        locations: ["$"],
        kind: "shape",
        failureClass: "contract-shape",
        statement: "Follow the review-result schema; keep at most {limit:retry.maxRetries} tries.",
        atLocation: {},
        hostDetail: null,
      }),
      "source-locator-membership": rule({
        code: "source-locator-membership",
        kind: "authority",
        retry: "terminal",
        atLocation: {},
        hostDetail: null,
      }),
      "invalid-json": rule({
        code: "invalid-json",
        family: "common",
        locations: ["$"],
        kind: "syntax",
        statement: "Return one strict JSON object; it follows {grammar:issued-id}.",
        atLocation: {},
        hostDetail: null,
      }),
      unknown: rule({
        code: "unknown",
        family: "common",
        locations: ["$"],
        failureClass: "unknown",
        failureClassReason: "The code names no cause.",
        statement: null,
        atLocation: {},
        hostDetail: null,
        catchAll: true,
      }),
    },
    families: {
      "technical-review": {
        replay: null,
        recordedPrefix: null,
        codes: [
          "inventory-dimension-facts",
          "review-schema-enum",
          "source-locator-membership",
          "invalid-json",
        ],
      },
      common: { replay: "read-only", recordedPrefix: null, codes: ["invalid-json", "unknown"] },
    },
    replayModes: {
      "read-only": { statement: null },
      "disabled-write-step": { statement: null },
      "reset-write-step": { statement: "Restored." },
    },
    grammars: {
      "issued-id": {
        form: "token",
        statement: "the issued-id grammar",
        pattern: "^[A-Z][A-Z0-9-]*$",
        maxLength: null,
        illustrative: [],
        flowsInto: [],
      },
    },
    limitValue: (name) => (name === "retry.maxRetries" ? 3 : Number.NaN),
  };

  it("states a location-specific sentence at that location and the statement elsewhere", () => {
    const hints = outputRuleHintCatalog(tables);
    const at = (location: string) =>
      ruleHintFor(hints, { code: "inventory-dimension-facts", location });
    expect(at("$.obligationJudgments")).toBe(
      "Each applicable ledger dimension must keep at least one retained or refined obligation.",
    );
    expect(at("$.factInventory")).toBe(tables.rules["inventory-dimension-facts"]!.statement);
  });

  it("keys a pattern member by its recorded code and renders limit and grammar placeholders", () => {
    const hints = outputRuleHintCatalog(tables);
    expect(Object.keys(hints)).toContain("review-schema-enum");
    expect(ruleHintFor(hints, { code: "review-schema-enum", location: "$" })).toBe(
      "Follow the review-result schema; keep at most 3 tries.",
    );
    expect(ruleHintFor(hints, { code: "invalid-json", location: "$" })).toBe(
      "Return one strict JSON object; it follows the issued-id grammar.",
    );
    expect(renderOutputText("{grammar:unknown} {limit:retry.maxRetries}", tables)).toBe(
      "{grammar:unknown} 3",
    );
  });

  it("never gives a terminal rule or the unstated catch-all a retry hint", () => {
    const codes = Object.keys(outputRuleHintCatalog(tables));
    expect(codes).not.toContain("source-locator-membership");
    expect(codes).not.toContain("unknown");
  });

  it("closes a hint with its family's replay-mode statement only", () => {
    const withReplay: OutputCatalogTables = {
      ...tables,
      families: {
        ...tables.families,
        "technical-review": { ...tables.families["technical-review"]!, replay: "reset-write-step" },
      },
    };
    const hints = outputRuleHintCatalog(withReplay);
    expect(hints["inventory-dimension-facts"]!.rule.endsWith(" Restored.")).toBe(true);
    expect(hints["inventory-dimension-facts"]!.atLocation!["$.obligationJudgments"]).toMatch(
      / Restored\.$/u,
    );
    // The shared code keeps its own family's replay mode, which has no statement.
    expect(hints["invalid-json"]!.rule.endsWith("Restored.")).toBe(false);
  });

  it("declares no grammar yet; #1290 migrates them", () => {
    expect(OUTPUT_GRAMMARS).toEqual({});
  });

  it("builds the recorded code and location grammars exactly as the writer does (until #1290)", () => {
    const segment = limit("inference.rejectionSegmentLength").value;
    expect(recordedCodeGrammar(segment).source).toBe(INFERENCE_REJECTION_CODE_GRAMMAR.source);
    expect(recordedLocationGrammar(segment).source).toBe(
      INFERENCE_REJECTION_LOCATION_GRAMMAR.source,
    );
  });
});

/** The CREATE step-2 input a source-obligation fixture's `plan` describes. */
function sourceObligationFixtureInput(input: Record<string, unknown>) {
  const plan = input.plan as { writePage: string; sources: string[] };
  const workflow = getWorkflow("create-documentation");
  return {
    workflow,
    planBinding: createDocumentationPlanBinding({
      mode: "create",
      pages: [{ path: plan.writePage, disposition: "create" }],
      sourceBindings: [{ pagePath: plan.writePage, sources: plan.sources }],
    }),
    evidenceIdentity: { repositoryRevision: input.runRevision as string },
  };
}
