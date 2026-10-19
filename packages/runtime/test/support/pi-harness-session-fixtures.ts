// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Shared fixtures for the split pi-harness-session test files.

import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleRunsCommand } from "../../src/cli/commands/runs.js";
import { InferenceStepError, type HarnessStepInput } from "../../src/execution/contracts.js";
import { canonicalDigest } from "../../src/content-ir/canonical.js";
import {
  createReaderTaskContextSupplier,
  createStyleTaskContext,
  type StyleTaskContextV1,
} from "../../src/execution/task-context.js";
import {
  PiHarness,
  readTextRenderingForStep,
  type PiHarnessOptions,
} from "../../src/harness/pi.js";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  buildDocsFabStepPrompt,
  loadWriterSourceFactMethod,
  SKILL_EXPANSION_MISSING,
} from "../../src/harness/pi-session.js";
import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../../src/json-evidence.js";
import type { BoundModelExecutionProfile } from "../../src/model/configuration.js";
import {
  createModelConnection,
  createProviderConnectionFactory,
  type ProviderConnectionFactory,
} from "../../src/model/provider.js";
import type {
  InferenceAttemptEvidence,
  InferenceExecutionEvidence,
  RunRecord,
} from "../../src/records/contracts.js";
import { formatRunRetryDispositionLines } from "../../src/operator/retry-disposition.js";
import { formatRunFailureDiagnosticLines } from "../../src/operator/run-summary.js";
import { StudySession } from "../../src/records/study-store.js";
import { documentationAuditSearch } from "../../src/maturity/audit-search-plan.js";
import { documentationObservationSearch } from "../../src/search/observation-search-plan.js";
import { projectReviewFindingsFromRun } from "../../src/review/findings.js";
import { getWorkflow } from "../../src/workflow-registry/catalog.js";
import { parseWorkflowManifestSnapshot } from "../../src/workflow-registry/manifest.js";
import { TECHNICAL_FACT_DIMENSIONS } from "../../src/workflow-execution/review-response.js";
import {
  documentationPlanBindingDigest,
  DOCUMENTATION_PLAN_FAILURES,
  type DocumentationPlanMode,
} from "../../src/workflow-execution/plan-binding.js";
import { validModelConfig } from "../helpers.js";
import { nestedDeadlineMs, testTimeoutMs } from "../helpers/test-timeouts.js";
import { createPiExecutionLeaseController } from "../../src/harness/pi-offline.js";
// Aliased on purpose: an unaliased `limitDefinition` would collide with the
// separate `limitDefinition` import below. Two import statements from one
// module are legal; two bindings of one name are not.
import {
  limit as resolveNamedLimit,
  limitDefinition as namedLimitDefinition,
  type ResolveLimitsOptions,
} from "../../src/config/limits.js";
import { bindModelExecutionProfile } from "../../src/model/configuration.js";
import { EXECUTION_LEASE_DEFAULTS } from "../../src/execution/lease-contracts.js";
import { loadCompositionExecutionEnvelope } from "../../src/config/runtime-loader.js";
import { OUTPUT_AUTHORITY_FLOOR_TOKENS } from "../../src/model/turn-governor.js";
import { grantedTurnOutputTokens } from "../../src/model/context-budget.js";
import { decodeInference } from "../../src/scorecard-record.js";
import { verifyQualityPackContext } from "../../src/quality-pack/manifest.js";
import { limitDefinition } from "../../src/config/limits.js";
import type { ModelTurnGovernanceOptions } from "../../src/model/provider.js";

import {
  bindSourceObligationLedger,
  bindSourceObligationLedgerV2,
  projectSourceObligationRejection,
  sourceObligationRejectionMessage,
  sourceObligationScopeSha256,
  type SourceObligationLedgerProposalV1,
} from "../../src/workflow-execution/source-obligation.js";
import {
  issueOriginalSourceAuthorityAdmission,
  sealOriginalSourceAuthority,
} from "../../src/workflow-execution/source-obligation-authority.js";
import { verificationResultFixture } from "../helpers/verification.js";
import {
  sourceReadinessBinding,
  wrapSourceReadinessHarness,
} from "../../src/readiness/assessment.js";
import { sourceReadinessSearch } from "../../src/readiness/workflow.js";
import type { RepositoryWorkspace } from "../../src/repository/workspace/contracts.js";
import {
  instantiateWorkflowSearchTargets,
  normalizeWorkflowSearchEvidence,
} from "../../src/workflow-contracts/search.js";
import { searchEvidenceFixture } from "../helpers/search-evidence-fixture.js";
import {
  preflightQualityArtifactCandidateContent,
  QualityArtifactStagingError,
} from "../../src/evaluation-report/quality-artifact-staging.js";
import { authoringManifestV3 } from "../helpers/authoring-manifest.js";
import { createRealAuthoringEvidenceFixture } from "../helpers/authoring-evidence.js";
import { executeInferenceStep } from "../../src/workflow-execution/retry.js";
import { searchStepEvidence } from "../helpers/search-evidence-fixture.js";

// Re-export every raw import above so split files that reference it
// directly (not only through a helper below) can import it from here.
export {
  AgentSession,
  DOCUMENTATION_PLAN_FAILURES,
  EXECUTION_LEASE_DEFAULTS,
  InferenceStepError,
  OUTPUT_AUTHORITY_FLOOR_TOKENS,
  PiHarness,
  QualityArtifactStagingError,
  SKILL_EXPANSION_MISSING,
  StudySession,
  TECHNICAL_FACT_DIMENSIONS,
  authoringManifestV3,
  bindModelExecutionProfile,
  bindSourceObligationLedger,
  bindSourceObligationLedgerV2,
  buildDocsFabStepPrompt,
  canonicalDigest,
  canonicalizeJsonEvidence,
  createModelConnection,
  createPiExecutionLeaseController,
  createProviderConnectionFactory,
  createReaderTaskContextSupplier,
  createRealAuthoringEvidenceFixture,
  decodeInference,
  documentationAuditSearch,
  documentationObservationSearch,
  documentationPlanBindingDigest,
  executeInferenceStep,
  formatRunFailureDiagnosticLines,
  formatRunRetryDispositionLines,
  getWorkflow,
  grantedTurnOutputTokens,
  handleRunsCommand,
  instantiateWorkflowSearchTargets,
  issueOriginalSourceAuthorityAdmission,
  limitDefinition,
  loadCompositionExecutionEnvelope,
  loadWriterSourceFactMethod,
  namedLimitDefinition,
  nestedDeadlineMs,
  normalizeWorkflowSearchEvidence,
  parseWorkflowManifestSnapshot,
  preflightQualityArtifactCandidateContent,
  projectReviewFindingsFromRun,
  projectSourceObligationRejection,
  readTextRenderingForStep,
  resolveNamedLimit,
  sealOriginalSourceAuthority,
  searchEvidenceFixture,
  sourceObligationRejectionMessage,
  sourceObligationScopeSha256,
  sourceReadinessBinding,
  sourceReadinessSearch,
  testTimeoutMs,
  validModelConfig,
  verificationResultFixture,
  verifyQualityPackContext,
  wrapSourceReadinessHarness,
};
export type {
  BoundModelExecutionProfile,
  DocumentationPlanMode,
  HarnessStepInput,
  InferenceAttemptEvidence,
  InferenceExecutionEvidence,
  JsonEvidenceValue,
  ModelTurnGovernanceOptions,
  PiHarnessOptions,
  ProviderConnectionFactory,
  RepositoryWorkspace,
  ResolveLimitsOptions,
  RunRecord,
  SourceObligationLedgerProposalV1,
};

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const skillCrateDirectory = resolve(projectRoot, "skill-crate");
/** The generated Pin C payload; a style-bound step reads its bound profile here. */
export const qualityDirectory = resolve(projectRoot, "quality");
export const temporaryDirectories: string[] = [];
/** Sorted tool names a default read-only step presents, as recorded in tool evidence. */
export const PRESENTED_READ_ONLY_TOOLS = [
  "canon_affected_docs",
  "canon_conflict_gap",
  "canon_propose_claim",
  "canon_query",
  "canon_submit_artifact",
  "canon_validate_citations",
  "find",
  "grep",
  "ls",
  "read",
];

export type ConfiguredModelPiHarnessOptions = Extract<PiHarnessOptions, { model: unknown }>;
export type AuditHarnessOverrides = Omit<
  ConfiguredModelPiHarnessOptions,
  "skillCrateDirectory" | "model" | "createConnection"
> & { model?: ConfiguredModelPiHarnessOptions["model"] };

let installedStyleContext: Promise<StyleTaskContextV1> | undefined;

/** The style profile run admission resolves from the generated pack, read once per test file. */
export function boundStyleContext(): Promise<StyleTaskContextV1> {
  installedStyleContext ??= verifyQualityPackContext({
    qualityDirectory,
    qualityPackDirectory: resolve(projectRoot, "quality-pack"),
    skillCrateDirectory,
  }).then((pack) => createStyleTaskContext(pack));
  return installedStyleContext;
}

export async function createAuditHarness(overrides: AuditHarnessOverrides = {}) {
  const { model = validModelConfig, ...rest } = overrides;
  return new PiHarness({
    skillCrateDirectory,
    qualityDirectory,
    styleContext: await boundStyleContext(),
    model,
    createConnection: createModelConnection,
    ...rest,
  });
}

export async function createReviewHarness(withComposition: boolean): Promise<PiHarness> {
  if (!withComposition) return createAuditHarness();
  const executionProfile = fixtureCompositionExecutionProfile({
    maxProviderTurns: 4,
    timeoutMs: 30_000,
    maxResponseBytes: 65_536,
  });
  return new PiHarness({
    skillCrateDirectory,
    qualityDirectory,
    styleContext: await boundStyleContext(),
    executionProfile,
    credential: { family: "nvidia-inference-api", apiKey: validModelConfig.apiKey },
    providerConnectionFactory: createProviderConnectionFactory({
      routeId: executionProfile.routeId,
      transport: executionProfile.transport,
    }),
  });
}

export async function runAuthoringRevisionSession(
  responsesFor: (responseText: string) => readonly Response[],
) {
  const workflow = parseWorkflowManifestSnapshot(authoringManifestV3(), "create-documentation", {
    "documentation-audit": documentationAuditSearch,
    "documentation-observation": documentationObservationSearch,
  });
  const fixture = await createRealAuthoringEvidenceFixture(workflow, {
    actionable: true,
    runId: "pi-authoring-revision",
  });
  try {
    if (fixture.selection.kind !== "revise") throw new Error("fixture must select revision");
    const revision = fixture.selection.input;
    const issueId = revision.actionableFacts[0]!.issueIds[0]!;
    const locator = revision.actionableFacts[0]!.sourceLocators[0]!;
    const response = {
      issueAccounting: [
        {
          issueId,
          disposition: "applied" as const,
          reason: "The admitted source establishes this bounded correction.",
          sourceLocators: [locator],
        },
      ],
      changedPaths: [...revision.writePaths],
      unresolvedFacts: [],
    };
    const responseText = canonicalizeJsonEvidence(
      response as unknown as JsonEvidenceValue,
    ).trimEnd();
    const requests: Array<{
      messages?: Array<{ content?: string | Array<{ text?: string }> }>;
    }> = [];
    const provider = scriptedProvider(responsesFor(responseText));
    vi.stubGlobal("fetch", async (request: RequestInfo | URL, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)));
      return provider(request, init);
    });
    const step = workflow
      .authoringSchedule!.branches.find((branch) => branch.id === "revise")!
      .steps.find((candidate) => candidate.id === "revise-documentation")!;
    const onText = vi.fn();
    const result = await (await createAuditHarness()).runStep({
      runId: fixture.runId,
      repositoryPath: fixture.root,
      workflow,
      step,
      evidenceIdentity: {
        repositoryRevision: fixture.revision,
        authoringPhaseSha256: "7".repeat(64),
      },
      planBinding: fixture.plan,
      sourceObligationLedger: fixture.ledger,
      authoringRevisionInput: revision,
      onText,
    });
    return { result, response, responseText, requests, onText, revision };
  } finally {
    await fixture.dispose();
  }
}

export async function captureAuthoringRevisionFailure(
  responsesFor: Parameters<typeof runAuthoringRevisionSession>[0],
): Promise<InferenceStepError> {
  try {
    await runAuthoringRevisionSession(responsesFor);
  } catch (error) {
    if (error instanceof InferenceStepError) return error;
    throw error;
  }
  throw new Error("Expected the authoring revision session to fail.");
}

/**
 * The same real session, with the in-turn replay backoff collapsed. The attempt
 * bound is deliberately left at the runtime default: these tests are about how
 * many provider requests one governed turn may make, not about how long the
 * suite waits between them.
 */
export async function createInstantReplayAuditHarness() {
  return new PiHarness({
    skillCrateDirectory,
    model: validModelConfig,
    createConnection: (model, options) =>
      createModelConnection(
        model,
        options ? { ...options, providerTurnRetry: { baseDelayMs: 0, maxDelayMs: 0 } } : options,
      ),
  });
}

/** The usage block of a recorded cut turn; fixture data. */
export const LIVE_CUT_USAGE = {
  prompt_tokens: 52_486,
  completion_tokens: 8_192,
  total_tokens: 60_678,
};

/** Cumulative input authority is `maxInputTokens * 64`; this clears it. */
export const OVER_CUMULATIVE_INPUT_TOKENS = validModelConfig.profile.maxInputTokens * 64 + 1;

/**
 * Inject a `turn_end` for a batch the host never authorized. `at` selects the
 * coordinator phase under test: `turn_start` fires before any batch exists
 * (`active`); `batch-pending` fires from the chained host preflight hook, which
 * the adapter calls after it has already granted the real batch.
 */
export async function forgedTurnEndFailure(
  at: "turn_start" | "batch-pending",
  toolResults: readonly { toolCallId: string; isError: boolean }[],
): Promise<InferenceStepError> {
  const repositoryPath = await createRepository();
  vi.stubGlobal(
    "fetch",
    scriptedProvider([
      toolTurn([{ id: "call-0", name: "ls", arguments: { path: "." } }], 1),
      textTurn("The documentation audit is complete."),
    ]),
  );
  let forged = false;
  let session: { _emit(value: unknown): void } | undefined;
  const forge = (): void => {
    if (forged || !session) return;
    forged = true;
    session._emit({
      type: "turn_end",
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", id: "forged-0", name: "read", arguments: { path: "README.md" } },
          { type: "toolCall", id: "forged-1", name: "ls", arguments: { path: "." } },
        ],
        usage: { input: 1, output: 1 },
      },
      toolResults,
    });
  };
  const harness = await createAuditHarness({
    configureSession: (value) => {
      session = value as unknown as { _emit(value: unknown): void };
      value.subscribe((event) => {
        if (at === "turn_start" && event.type === "turn_start") forge();
      });
    },
    ...(at === "batch-pending"
      ? {
          beforeToolCall: async () => {
            forge();
            return undefined;
          },
        }
      : {}),
  });

  const error = await captureInferenceFailure(harness, stepInput(repositoryPath));
  expect(forged).toBe(true);
  return error;
}

export async function createRepository(): Promise<string> {
  const repositoryPath = await mkdtemp(resolve(tmpdir(), "docsfab-pi-session-"));
  temporaryDirectories.push(repositoryPath);
  await writeFile(resolve(repositoryPath, "README.md"), "# Fixture\n");
  return repositoryPath;
}

export function stepInput(repositoryPath: string): HarnessStepInput {
  const workflow = getWorkflow("review-documentation");
  return {
    runId: "real-pi-session-run",
    repositoryPath,
    workflow,
    step: workflow.steps[0]!,
    evidenceIdentity: { repositoryRevision: "a".repeat(40) },
  };
}

export function reviewStepInput(
  repositoryPath: string,
  skill: "verify-technical-accuracy" | "review-documentation",
): HarnessStepInput {
  const workflow = getWorkflow("review-documentation");
  return {
    runId: "real-pi-review-response-run",
    repositoryPath,
    workflow,
    step: workflow.steps.find((step) =>
      skill === "verify-technical-accuracy"
        ? step.id === "provisional-technical-verification"
        : step.skill === skill,
    )!,
    evidenceIdentity: { repositoryRevision: "a".repeat(40) },
    reviewScope: {
      scope: "focused-set",
      reason: "operator-named",
      targetPaths: ["README.md"],
      deferredPaths: [],
      scopeSha256: "b".repeat(64),
      corpusFileCount: 1,
    },
  };
}

export function reviewSourcePhaseInput(
  repositoryPath: string,
  stepId:
    | "derive-source-obligations"
    | "provisional-technical-verification"
    | "verify-technical-accuracy",
): HarnessStepInput {
  const workflow = getWorkflow("review-documentation");
  return {
    runId: `real-pi-${stepId}`,
    repositoryPath,
    workflow,
    step: workflow.steps.find((step) => step.id === stepId)!,
    evidenceIdentity: { repositoryRevision: "a".repeat(40) },
    searchEvidence: searchStepEvidence({
      planId: "documentation-audit-discovery",
      searches: [],
      evidenceSha256: "b".repeat(64),
      workspaceSnapshotSha256: "c".repeat(64),
    }),
    reviewScope: {
      scope: "focused-set",
      reason: "operator-named",
      targetPaths: ["README.md"],
      deferredPaths: [],
      scopeSha256: "d".repeat(64),
      corpusFileCount: 1,
    },
  };
}

export function technicalStepInput(repositoryPath: string): HarnessStepInput {
  const input = stepInput(repositoryPath);
  return {
    ...input,
    step: input.workflow.steps.find((step) => step.id === "provisional-technical-verification")!,
  };
}

export function editorialTechnicalStepInput(repositoryPath: string): HarnessStepInput {
  const workflow = getWorkflow("update-documentation");
  const readerContextInput = {
    schema_version: 1 as const,
    target_audience: "DocsFab operators",
    reader_job: "Assess the approved documentation candidate.",
    change_scope: ["README.md"],
    source_priority: ["repository"],
    required_content: ["documented behavior"],
    excluded_content: [],
    unresolved_questions: [],
  };
  const impactBasis = {
    kind: "documentation-defect" as const,
    rationale: "The approved candidate documents the bounded source behavior.",
    evidence_refs: [],
  };
  const readerContext = { ...readerContextInput, impact_basis: impactBasis };
  const policy = { id: "update-documentation", version: "1", sha256: "c".repeat(64) };
  const provenance = {
    schema_version: 1 as const,
    reader_context_sha256: "d".repeat(64),
    baseline_sha256: "e".repeat(64),
    admitted_revision: "a".repeat(40),
    workspace_snapshot_sha256: "f".repeat(64),
    repository_identity_sha256: "1".repeat(64),
    policy,
    comparison: { kind: "unknown" as const },
    sources: [{ uri: "README.md", sha256: "2".repeat(64), role: "current-documentation" as const }],
    observed_at: "2026-09-15T00:00:00.000Z",
    limitations: [],
  };
  const readerTaskContext = {
    schemaVersion: 1 as const,
    kind: "docsfab-reader-task-context-completed" as const,
    inputOrigin: "explicit" as const,
    noChangeAssessment: "requires-evidence" as const,
    readerContextInput,
    baseline: {
      path: "profiles/docsfab-documentation-quality/reader-impact-baseline.md" as const,
      sha256: provenance.baseline_sha256,
      content: "Verified reader-impact baseline.",
    },
    policy,
    readerContext,
    provenance,
    prompt: "[reader-task-context] Completed host projection.",
  };
  const reference = {
    kind: "editorial-decision" as const,
    schemaVersion: 3 as const,
    digest: "3".repeat(64),
    repositoryRevision: "a".repeat(40),
    repositoryContentDigest: "4".repeat(64),
  };
  return {
    ...stepInput(repositoryPath),
    workflow,
    step: workflow.steps.find((step) => step.id === "verify-technical-accuracy")!,
    readerContextInput,
    readerTaskContext,
    readerContext,
    readerContextProvenance: provenance,
    editorialEvidenceRefs: [{ ...reference, kind: "context-packet", schemaVersion: 1 }],
    editorialCandidate: {
      reference,
      proposal: {
        schemaVersion: 1,
        kind: "docsfab-editorial-decision-proposal",
        candidate: "update",
        rationale: "The approved candidate documents the bounded source behavior.",
        evidenceRefs: [],
        limitations: [],
        impactBasis,
      },
    },
    planBinding: documentationPlanBinding("update", "README.md"),
  };
}

export function documentationPlanBinding(mode: DocumentationPlanMode, pagePath: string) {
  const pages = [{ path: pagePath, disposition: mode }];
  const sourceBindings = [{ pagePath, sources: ["README.md"] }];
  return {
    kind: "docsfab-documentation-plan" as const,
    schemaVersion: 1 as const,
    mode,
    pages,
    sourceBindings,
    digest: documentationPlanBindingDigest({ mode, pages, sourceBindings }),
  };
}

export async function captureInferenceFailure(
  harness: PiHarness,
  input: HarnessStepInput,
): Promise<InferenceStepError> {
  try {
    await harness.runStep(input);
  } catch (error) {
    expect(error, `unexpected failure type: ${String(error)}`).toBeInstanceOf(InferenceStepError);
    return error as InferenceStepError;
  }
  throw new Error("Expected the real Pi session to fail closed.");
}

export function expectDecodedAttemptEvidence(
  evidence: {
    model?: unknown;
    usage?: unknown;
    tools?: unknown;
    turns?: unknown;
  },
  outcome: "succeeded" | "provider-transient" | "provider-terminal",
  retryable: boolean,
): void {
  const identity = {
    repositoryRevision: "a".repeat(40),
    contextPacketDigest: "b".repeat(64),
    consultedNodeIds: ["node-a"],
  };
  const evidenceDigest = createHash("sha256").update(canonicalJson(identity)).digest("hex");
  const turns = ((evidence.turns ?? []) as Array<Record<string, unknown>>).map((turn) => ({
    ...turn,
    evidenceDigest,
  }));
  expect(
    decodeInference({
      configuredMaxRetries: 0,
      effectiveMaxRetries: 0,
      baseDelayMs: 100,
      maxDelayMs: 1_000,
      retryableCategories: ["timeout"],
      replay: "read-only",
      attempts: [
        {
          attempt: 1,
          outcome,
          retryable,
          retryScheduled: false,
          durationMs: 1,
          model: evidence.model,
          usage: evidence.usage,
          tools: evidence.tools,
          identity,
          turns,
        },
      ],
    }).attempts[0]?.turns,
  ).toEqual(turns);
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

export function expectLeaseToolConsistency(error: InferenceStepError): void {
  const tools = error.evidence?.tools;
  const lease = error.evidence?.executionLease;
  expect(tools).toBeDefined();
  expect(lease).toBeDefined();
  expect(lease!.toolCalls.executed).toBe(tools!.totalCalls);
  expect(lease!.toolCalls.failed).toBe(tools!.failedCalls);
  expect(lease!.toolCalls.succeeded).toBe(tools!.totalCalls - tools!.failedCalls);
  expect(lease!.binding.toolsSha256).toBe(
    createHash("sha256")
      .update(canonicalizeJsonEvidence(tools as unknown as JsonEvidenceValue))
      .digest("hex"),
  );
}

export interface ScriptedToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export function narratedToolTurn(value: string, calls: readonly ScriptedToolCall[]): Response {
  return sseResponse([
    {
      id: "completion-narrated-tool-turn",
      object: "chat.completion.chunk",
      created: 1,
      model: validModelConfig.modelId,
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            content: value,
            tool_calls: calls.map((call, index) => ({
              index,
              id: call.id,
              type: "function",
              function: {
                name: call.name,
                arguments: JSON.stringify(call.arguments),
              },
            })),
          },
          finish_reason: null,
        },
      ],
    },
    {
      id: "completion-narrated-tool-turn",
      object: "chat.completion.chunk",
      created: 1,
      model: validModelConfig.modelId,
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    },
  ]);
}

export function thinkingTurn(value: string): Response {
  return sseResponse([
    {
      id: "completion-thinking-turn",
      object: "chat.completion.chunk",
      created: 2,
      model: validModelConfig.modelId,
      choices: [
        {
          index: 0,
          delta: { role: "assistant", reasoning_content: value },
          finish_reason: null,
        },
      ],
    },
    {
      id: "completion-thinking-turn",
      object: "chat.completion.chunk",
      created: 2,
      model: validModelConfig.modelId,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    },
  ]);
}

export function thinkingAndTextTurn(thinking: string, fragments: readonly string[]): Response {
  return sseResponse([
    {
      id: "completion-thinking-and-text-turn",
      object: "chat.completion.chunk",
      created: 2,
      model: validModelConfig.modelId,
      choices: [
        {
          index: 0,
          delta: { role: "assistant", reasoning_content: thinking },
          finish_reason: null,
        },
      ],
    },
    ...fragments.map((content) => ({
      id: "completion-thinking-and-text-turn",
      object: "chat.completion.chunk",
      created: 2,
      model: validModelConfig.modelId,
      choices: [
        {
          index: 0,
          delta: { content },
          finish_reason: null,
        },
      ],
    })),
    {
      id: "completion-thinking-and-text-turn",
      object: "chat.completion.chunk",
      created: 2,
      model: validModelConfig.modelId,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    },
  ]);
}

export function toolTurn(
  calls: readonly ScriptedToolCall[],
  created = 1,
  finishReason: "tool_calls" | "length" = "tool_calls",
  usage: Record<string, number> = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
): Response {
  return sseResponse([
    {
      id: "completion-tool-turn",
      object: "chat.completion.chunk",
      created,
      model: validModelConfig.modelId,
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: calls.map((call, index) => ({
              index,
              id: call.id,
              type: "function",
              function: {
                name: call.name,
                arguments: JSON.stringify(call.arguments),
              },
            })),
          },
          finish_reason: null,
        },
      ],
    },
    {
      id: "completion-tool-turn",
      object: "chat.completion.chunk",
      created,
      model: validModelConfig.modelId,
      choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
      usage,
    },
  ]);
}

export function toolTurnWithPreamble(
  preamble: string,
  calls: readonly ScriptedToolCall[],
  created = 1,
): Response {
  return sseResponse([
    {
      id: "completion-tool-turn-with-preamble",
      object: "chat.completion.chunk",
      created,
      model: validModelConfig.modelId,
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            content: preamble,
            tool_calls: calls.map((call, index) => ({
              index,
              id: call.id,
              type: "function",
              function: {
                name: call.name,
                arguments: JSON.stringify(call.arguments),
              },
            })),
          },
          finish_reason: null,
        },
      ],
    },
    {
      id: "completion-tool-turn-with-preamble",
      object: "chat.completion.chunk",
      created,
      model: validModelConfig.modelId,
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    },
  ]);
}

/** An empty assistant turn: a finish_reason and usage but no content and no tool call. */
export function blankTurn(
  finishReason: "stop" | "length" = "stop",
  usage: Record<string, number> = { prompt_tokens: 700, completion_tokens: 0, total_tokens: 700 },
): Response {
  return sseResponse([
    {
      id: "completion-blank-turn",
      object: "chat.completion.chunk",
      created: 1,
      model: validModelConfig.modelId,
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
    },
    {
      id: "completion-blank-turn",
      object: "chat.completion.chunk",
      created: 1,
      model: validModelConfig.modelId,
      choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
      usage,
    },
  ]);
}

/**
 * A recorded Inference Hub failure: a LiteLLM front door reporting an
 * unavailable Bedrock backend. The body carries no credential; the transient
 * words sit inside the body while 503 is the real status.
 */
export function hubUnavailableResponse(): Response {
  return new Response(
    JSON.stringify({
      error: {
        message:
          'litellm.ServiceUnavailableError: BedrockException - {"message":"Bedrock is unable to process your request."}',
        type: "None",
        param: "None",
        code: "503",
      },
    }),
    {
      status: 503,
      statusText: "Service Unavailable",
      headers: { "content-type": "application/json" },
    },
  );
}

export function textTurn(
  value: string,
  model = validModelConfig.modelId,
  finishReason: "stop" | "length" = "stop",
  usage: Record<string, number> = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
): Response {
  return sseResponse([
    {
      id: "completion-text-turn",
      object: "chat.completion.chunk",
      created: 1,
      model,
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: value },
          finish_reason: null,
        },
      ],
    },
    {
      id: "completion-text-turn",
      object: "chat.completion.chunk",
      created: 1,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
      usage,
    },
  ]);
}

export function sseResponse(chunks: readonly object[]): Response {
  const body = [
    ...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`),
    "data: [DONE]\n\n",
  ].join("");
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/** The text of the first user message in one serialized provider request. */
export function firstUserMessageText(requestBody: string): string {
  const { messages } = JSON.parse(requestBody) as {
    messages: Array<{ role: string; content: string | Array<{ text?: string }> }>;
  };
  const content = messages.find((message) => message.role === "user")?.content ?? "";
  return typeof content === "string" ? content : content.map((part) => part.text ?? "").join("");
}

export function scriptedProvider(responses: readonly Response[]): typeof fetch {
  let index = 0;
  return async () => {
    const response = responses[index];
    index += 1;
    if (!response) throw new Error("Unexpected provider request.");
    return response.clone();
  };
}

export function fixtureCompositionExecutionProfile(
  compositionPolicy: NonNullable<BoundModelExecutionProfile["compositionPolicy"]>,
): BoundModelExecutionProfile {
  return {
    routeId: "composition-test-route",
    providerId: "composition-test-route",
    baseUrl: validModelConfig.baseUrl,
    modelId: validModelConfig.modelId,
    transport: "openai-chat-completions",
    apiFormat: "chat_completions",
    profile: {
      ...validModelConfig.profile,
      effectiveLimitReason: "composition-candidate",
      costPerMillionTokens: {
        input: null,
        output: null,
        cacheRead: null,
        cacheWrite: null,
      },
    },
    requestPolicy: validModelConfig.requestPolicy,
    compositionPolicy,
  };
}

/**
 * Per-file shared-state reset. Every split file that creates temp dirs via
 * `createRepository`/`mkdtemp` calls this from its own `afterEach`.
 */
export async function resetSharedTestState(): Promise<void> {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
}
