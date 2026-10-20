// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Real runner, Pi, host checks and private file-store fixture for candidate replay. */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  AgentHarness,
  HarnessStepInput,
  HarnessStepResult,
} from "../../src/execution/contracts.js";
import type { RunRecord } from "../../src/records/contracts.js";
import { canonicalDigest } from "../../src/content-ir/canonical.js";
import { PiHarness } from "../../src/harness/pi.js";
import { createProviderConnectionFactory } from "../../src/model/provider.js";
import type { BoundModelExecutionProfile } from "../../src/model/configuration.js";
import { verifyQualityPackContext } from "../../src/quality-pack/manifest.js";
import { createStyleTaskContext } from "../../src/execution/task-context.js";
import { FileRunStore } from "../../src/records/file-store.js";
import { GitPatchEvidenceCollector } from "../../src/repository/evidence.js";
import { prepareRepositoryWorkspace } from "../../src/repository/workspace/materialize.js";
import { LocalRepositorySecurityScanner } from "../../src/security/repository-scanner.js";
import { LocalWorkflowSearchCoordinator } from "../../src/search/local-workflow-coordinator.js";
import { WorkflowRunner } from "../../src/workflow-execution/runner.js";
import { LocalSourceObligationSourceObserver } from "../../src/workflow-execution/source-obligation-observer.js";
import { WorkflowChecksHostOperation } from "../../src/workflow-execution/workflow-checks.js";
import { LocalAuthoringCandidateLifecycle } from "../../src/workflow-execution/authoring-runtime.js";
import { sealDocumentationPlanBinding } from "../../src/workflow-execution/plan-binding.js";
import { TECHNICAL_FACT_DIMENSIONS } from "../../src/workflow-execution/review-response.js";
import { initFixtureRepo } from "./git.js";
import { sourceObligationProposalFixture } from "./verification.js";
import { validModelConfig } from "../helpers.js";

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const skillCrateDirectory = join(runtimeRoot, "skill-crate");
const qualityDirectory = join(runtimeRoot, "quality");

export function richCandidateFixtureProfile(): BoundModelExecutionProfile {
  return {
    routeId: "nvidia-inference-api",
    providerId: "nvidia-inference-api",
    baseUrl: validModelConfig.baseUrl,
    modelId: validModelConfig.modelId,
    transport: "openai-chat-completions",
    apiFormat: "chat_completions",
    profile: {
      ...validModelConfig.profile,
      effectiveLimitReason: "composition-candidate",
      costPerMillionTokens: { input: null, output: null, cacheRead: null, cacheWrite: null },
    },
    requestPolicy: validModelConfig.requestPolicy,
    compositionPolicy: { maxProviderTurns: 4, timeoutMs: 30_000, maxResponseBytes: 65_536 },
  };
}

async function createReviewHarness(providerFetch: typeof globalThis.fetch): Promise<PiHarness> {
  const pack = await verifyQualityPackContext({
    qualityDirectory,
    qualityPackDirectory: join(runtimeRoot, "quality-pack"),
    skillCrateDirectory,
  });
  const executionProfile = richCandidateFixtureProfile();
  return new PiHarness({
    skillCrateDirectory,
    qualityDirectory,
    styleContext: await createStyleTaskContext(pack),
    executionProfile,
    credential: { family: "nvidia-inference-api", apiKey: validModelConfig.apiKey },
    providerConnectionFactory: createProviderConnectionFactory({
      routeId: executionProfile.routeId,
      transport: executionProfile.transport,
      fetch: providerFetch,
    }),
  });
}

function textTurn(value: string): Response {
  const chunks = [
    {
      id: "rich-fixture-turn",
      object: "chat.completion.chunk",
      created: 1,
      model: validModelConfig.modelId,
      choices: [{ index: 0, delta: { role: "assistant", content: value }, finish_reason: null }],
    },
    {
      id: "rich-fixture-turn",
      object: "chat.completion.chunk",
      created: 1,
      model: validModelConfig.modelId,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    },
  ];
  return new Response(
    [...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`), "data: [DONE]\n\n"].join(""),
    {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    },
  );
}

function richFinalJudgment(input: HarnessStepInput, judgment: object): object {
  const evidence = input.provisionalRichCandidateEvidence;
  if (!evidence)
    throw new Error("The rich final fixture requires its retained provisional candidate.");
  const obligations = new Map(
    input.sourceObligationLedger?.dimensions.flatMap((dimension) =>
      dimension.obligations.map((obligation) => [obligation.id, obligation] as const),
    ) ?? [],
  );
  return {
    kind: "docsfab-technical-rich-judgment",
    schemaVersion: 1,
    ...judgment,
    richAssessments: evidence.candidates.map((candidate) => ({
      issueId: candidate.issueId,
      candidateSha256: candidate.candidateSha256,
      grounds: candidate.obligationIds.map((obligationId) => {
        const obligation = obligations.get(obligationId);
        if (!obligation) throw new Error("The rich final fixture lost its sealed obligation.");
        return {
          obligationId,
          status: "supported",
          rationale: "The cited source supports the fixed advice and its qualification.",
          sourceLocators: obligation.sourceLocators,
          uncertainty: obligation.uncertainty,
        };
      }),
    })),
  };
}

export async function runRichCandidateFixture(
  rich = true,
  finalRich = false,
  sharedFinalFact = false,
  afterPiResult?: (input: HarnessStepInput, result: HarnessStepResult) => HarnessStepResult,
): Promise<{
  record: RunRecord;
  saved: RunRecord;
  store: FileRunStore;
  observed: HarnessStepInput[];
  candidate: {
    issueId: string;
    title: string;
    readerConsequence: string;
    proposedEdit: { kind: string; text: string };
  };
  secondCandidate: {
    issueId: string;
    title: string;
    readerConsequence: string;
    proposedEdit: { kind: string; text: string };
  } | null;
  providerCalls: number;
  dispose: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "docsfab-rich-candidate-runner-"));
  const source = join(root, "source");
  const revision = await initFixtureRepo(source, {
    "README.md": "# Fixture\n",
    "docs/guide.md": "# Guide\n\nThe old input guidance.\n",
    "src/api.ts": "export const acceptsStructuredInput = true;\n",
  });
  const workspace = await prepareRepositoryWorkspace(source, revision);
  const evidenceCollector = await GitPatchEvidenceCollector.create(
    workspace.path,
    join(root, "artifacts"),
  );
  const dispose = async (): Promise<void> => {
    await evidenceCollector.dispose();
    await workspace.dispose();
    await rm(root, { recursive: true, force: true });
  };
  try {
    const proposal = sourceObligationProposalFixture("src/api.ts:1");
    proposal.dimensions[0] = {
      ...proposal.dimensions[0]!,
      status: "applicable",
      reason: "The fixture source establishes structured input behavior.",
      sourceLocators: [],
      obligations: [
        {
          id: "OBL-INPUT-1",
          dimension: TECHNICAL_FACT_DIMENSIONS[0]!,
          sourceLocators: ["src/api.ts:1"],
          statement: "The API accepts structured input.",
          evidenceClass: "source-observation",
          uncertainty: "The fixture covers one input shape.",
        },
      ],
    };
    const candidate = {
      issueId: "TECH-001",
      title: "Structured input is undocumented",
      readerConsequence: "Readers can supply the wrong input shape.",
      proposedEdit: {
        kind: "advice",
        text: "Document the structured input and its qualification.\r\n",
      },
    };
    const secondCandidate = {
      issueId: "TECH-002",
      title: "The second reader task needs the same source fact",
      readerConsequence: "Readers miss the later documented step.",
      proposedEdit: {
        kind: "advice",
        text: "State the second repair action separately.\n",
      },
    };
    let reply = "";
    let providerCalls = 0;
    const provider = async () => {
      providerCalls += 1;
      return textTurn(reply).clone();
    };
    const pi = await createReviewHarness(provider as typeof fetch);
    const observed: HarnessStepInput[] = [];
    const harness: AgentHarness = {
      inspectSkill: (input) => pi.inspectSkill(input),
      runStep: async (input) => {
        observed.push(input);
        const obligationId = input.sourceObligationLedger?.dimensions[0]?.obligations[0]?.id;
        const judgment = {
          verdict: "needs-revision",
          coverage: [
            {
              path: "docs/guide.md",
              status: "verified",
              evidence: ["src/api.ts:1"],
              reason: "Compared the guide with the fixture source.",
            },
          ],
          issueJudgments: [
            {
              id: candidate.issueId,
              severity: "major",
              category: "completeness",
              location: "docs/guide.md:1",
              obligationIds: [obligationId],
            },
            ...(sharedFinalFact
              ? [
                  {
                    id: secondCandidate.issueId,
                    severity: "major" as const,
                    category: "completeness",
                    location: "docs/guide.md:2",
                    obligationIds: [obligationId],
                  },
                ]
              : []),
          ],
          obligationJudgments: [
            { obligationId, disposition: "retained", documentationDisposition: "omitted" },
          ],
        };
        reply =
          input.step.id === "derive-source-obligations"
            ? JSON.stringify(proposal)
            : input.step.id === "provisional-technical-verification"
              ? rich
                ? JSON.stringify({
                    kind: "docsfab-provisional-rich-judgment",
                    schemaVersion: 1,
                    judgment,
                    richCandidates: [
                      { ...candidate, obligationIds: [obligationId] },
                      ...(sharedFinalFact
                        ? [{ ...secondCandidate, obligationIds: [obligationId] }]
                        : []),
                    ],
                  })
                : JSON.stringify(judgment)
              : input.step.id === "verify-technical-accuracy"
                ? JSON.stringify(finalRich ? richFinalJudgment(input, judgment) : judgment)
                : input.step.id === "review-documentation"
                  ? JSON.stringify({ verdict: "pass", issues: [] })
                  : `Completed ${input.step.id}.`;
        const result = await pi.runStep(input);
        return afterPiResult ? afterPiResult(input, result) : result;
      },
    };
    const store = new FileRunStore(join(root, "state"));
    const reviewScopeBody = {
      scope: "focused-set" as const,
      reason: "operator-named" as const,
      targetPaths: ["docs/guide.md"],
      deferredPaths: [],
      corpusFileCount: 1,
      anchorPaths: [],
    };
    const reviewScopeSealedBody = {
      schemaVersion: 1,
      kind: "docsfab-review-scope",
      scope: reviewScopeBody.scope,
      reason: reviewScopeBody.reason,
      targets: [{ path: "docs/guide.md", reason: "operator-named" }],
      deferred: [],
    };
    const record = await new WorkflowRunner({
      harness,
      hostOperations: new WorkflowChecksHostOperation(workspace),
      store,
      repositoryScanner: new LocalRepositorySecurityScanner(),
      contextPreflight: {
        preflight: async () => ({
          status: "unnecessary" as const,
          reason: "target-not-applicable" as const,
        }),
      },
      workflowSearch: new LocalWorkflowSearchCoordinator({ workspace }),
      sourceObligationObserver: new LocalSourceObligationSourceObserver(workspace),
      repositoryEvidence: evidenceCollector,
      id: () => "rich-candidate-runner-fixture",
    }).run({
      workflow: "review-documentation",
      workspacePath: workspace.path,
      repository: { sourcePath: source, requestedRevision: "HEAD", revision },
      contextTarget: { sourcePath: "docs/guide.md" },
      reviewScope: { ...reviewScopeBody, scopeSha256: canonicalDigest(reviewScopeSealedBody) },
      allowWrite: false,
    });
    const saved = (await store.get(record.id)) as RunRecord;
    return {
      record,
      saved,
      store,
      observed,
      candidate,
      secondCandidate: sharedFinalFact ? secondCandidate : null,
      providerCalls,
      dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}

/** Actual CREATE V3 schedule, including candidate-zero prefix and optional revision. */
export async function runRichCandidateV3Fixture(
  rich = true,
  finalRich = false,
): Promise<{
  record: RunRecord;
  saved: RunRecord;
  observed: HarnessStepInput[];
  providerCalls: number;
  dispose: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "docsfab-rich-candidate-v3-"));
  const source = join(root, "source");
  const revision = await initFixtureRepo(source, {
    "README.md": "# Fixture\n",
    "src/api.ts": "export const acceptsStructuredInput = true;\n",
  });
  const workspace = await prepareRepositoryWorkspace(source, revision);
  const evidenceCollector = await GitPatchEvidenceCollector.create(
    workspace.path,
    join(root, "artifacts"),
  );
  const hostOperations = new WorkflowChecksHostOperation(workspace);
  const workflowSearch = new LocalWorkflowSearchCoordinator({ workspace });
  const sourceObligationObserver = new LocalSourceObligationSourceObserver(workspace);
  const dispose = async (): Promise<void> => {
    await evidenceCollector.dispose();
    await workspace.dispose();
    await rm(root, { recursive: true, force: true });
  };
  try {
    const plan = sealDocumentationPlanBinding(
      {
        mode: "create",
        pages: [{ path: "docs/guide.md", disposition: "create" }],
        sourceBindings: [{ pagePath: "docs/guide.md", sources: ["src/api.ts"] }],
      },
      { expectedMode: "create" },
    );
    const proposal = sourceObligationProposalFixture("src/api.ts:1");
    proposal.dimensions[0] = {
      ...proposal.dimensions[0]!,
      status: "applicable",
      reason: "The fixture source establishes structured input behavior.",
      sourceLocators: [],
      obligations: [
        {
          id: "OBL-INPUT-1",
          dimension: TECHNICAL_FACT_DIMENSIONS[0]!,
          sourceLocators: ["src/api.ts:1"],
          statement: "The API accepts structured input.",
          evidenceClass: "source-observation",
          uncertainty: "The fixture covers one input shape.",
        },
      ],
    };
    const candidate = {
      issueId: "TECH-001",
      title: "Structured input is undocumented",
      readerConsequence: "Readers can supply the wrong input shape.",
      proposedEdit: {
        kind: "advice",
        text: "Document the structured input and its qualification.\r\n",
      },
    };
    let reply = "";
    let activeInput: HarnessStepInput | undefined;
    let providerCalls = 0;
    const provider = async () => {
      providerCalls += 1;
      if (activeInput?.step.id === "write-documentation") {
        await mkdir(join(activeInput.repositoryPath, "docs"), { recursive: true });
        await writeFile(
          join(activeInput.repositoryPath, "docs/guide.md"),
          "# Guide\n\nThe old input guidance.\n",
        );
      }
      if (activeInput?.step.id === "revise-documentation") {
        await writeFile(
          join(activeInput.repositoryPath, "docs/guide.md"),
          "# Guide\n\nThe API accepts structured input.\n",
        );
      }
      return textTurn(reply).clone();
    };
    const pi = await createReviewHarness(provider as typeof fetch);
    const observed: HarnessStepInput[] = [];
    const harness: AgentHarness = {
      inspectSkill: (input) => pi.inspectSkill(input),
      runStep: async (input) => {
        observed.push(input);
        activeInput = input;
        const obligationId = input.sourceObligationLedger?.dimensions[0]?.obligations[0]?.id;
        const judgment = {
          verdict: "needs-revision",
          coverage: [
            {
              path: "docs/guide.md",
              status: "verified",
              evidence: ["src/api.ts:1"],
              reason: "Compared the guide with the fixture source.",
            },
          ],
          issueJudgments: [
            {
              id: candidate.issueId,
              severity: "major",
              category: "completeness",
              location: "docs/guide.md:1",
              obligationIds: [obligationId],
            },
          ],
          obligationJudgments: [
            { obligationId, disposition: "retained", documentationDisposition: "omitted" },
          ],
        };
        reply =
          input.step.id === "plan-documentation"
            ? JSON.stringify({
                summary: "The source-grounded create plan is ready.",
                planBinding: plan,
              })
            : input.step.id === "derive-source-obligations"
              ? JSON.stringify(proposal)
              : input.step.id === "revise-documentation"
                ? JSON.stringify({
                    issueAccounting: input.authoringRevisionInput?.actionableFacts.map((fact) => ({
                      issueId: fact.issueIds[0],
                      disposition: "applied",
                      reason: "The admitted source establishes this bounded correction.",
                      sourceLocators: [fact.sourceLocators[0]],
                    })),
                    changedPaths: input.authoringRevisionInput?.writePaths,
                    unresolvedFacts: [],
                  })
                : input.step.id === "provisional-technical-verification" ||
                    input.step.id === "provisional-revised-technical-verification"
                  ? rich
                    ? JSON.stringify({
                        kind: "docsfab-provisional-rich-judgment",
                        schemaVersion: 1,
                        judgment,
                        richCandidates: [
                          {
                            ...candidate,
                            obligationIds: [obligationId],
                            ...(input.step.id === "provisional-revised-technical-verification"
                              ? {
                                  proposedEdit: {
                                    kind: "advice",
                                    text: "Preserve the revised guide's structured input qualification.\r\n",
                                  },
                                }
                              : {}),
                          },
                        ],
                      })
                    : JSON.stringify(judgment)
                  : input.step.id === "verify-technical-accuracy" ||
                      input.step.id === "verify-revised-technical-accuracy"
                    ? JSON.stringify(finalRich ? richFinalJudgment(input, judgment) : judgment)
                    : input.step.skill === "review-documentation"
                      ? JSON.stringify({ verdict: "pass", issues: [] })
                      : `Completed ${input.step.id}.`;
        return pi.runStep(input);
      },
    };
    const store = new FileRunStore(join(root, "state"));
    const record = await new WorkflowRunner({
      harness,
      hostOperations,
      store,
      repositoryScanner: new LocalRepositorySecurityScanner(),
      contextPreflight: {
        preflight: async () => ({
          status: "unnecessary" as const,
          reason: "target-not-applicable" as const,
        }),
      },
      workflowSearch,
      sourceObligationObserver,
      repositoryEvidence: evidenceCollector,
      authoringCandidateLifecycle: new LocalAuthoringCandidateLifecycle({
        workspace,
        evidenceCollector,
        search: workflowSearch,
        sourceObserver: sourceObligationObserver,
        hostOperations,
        artifactDirectory: join(root, "artifacts"),
      }),
      id: () => "rich-candidate-v3-fixture",
    }).run({
      workflow: "create-documentation",
      workspacePath: workspace.path,
      repository: { sourcePath: source, requestedRevision: "HEAD", revision },
      instruction: "Create a source-grounded guide for structured input.",
      task: { kind: "create-documentation", canonSha256: "e".repeat(64) },
      allowWrite: true,
    });
    const saved = (await store.get(record.id)) as RunRecord;
    return { record, saved, observed, providerCalls, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}
