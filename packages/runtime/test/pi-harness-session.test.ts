// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { SOURCE_OBLIGATION_CATALOG_RULES } from "../src/workflow-execution/source-obligation.js";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HarnessStepInput,
  InferenceAttemptEvidence,
  InferenceExecutionEvidence,
  JsonEvidenceValue,
  PiHarness,
  RunRecord,
  SourceObligationLedgerProposalV1,
  TECHNICAL_FACT_DIMENSIONS,
  bindSourceObligationLedger,
  bindSourceObligationLedgerV2,
  buildDocsFabStepPrompt,
  canonicalizeJsonEvidence,
  captureAuthoringRevisionFailure,
  captureInferenceFailure,
  createAuditHarness,
  createReaderTaskContextSupplier,
  createRepository,
  createReviewHarness,
  documentationPlanBindingDigest,
  editorialTechnicalStepInput,
  executeInferenceStep,
  formatRunFailureDiagnosticLines,
  formatRunRetryDispositionLines,
  getWorkflow,
  handleRunsCommand,
  issueOriginalSourceAuthorityAdmission,
  narratedToolTurn,
  projectReviewFindingsFromRun,
  projectRoot,
  projectSourceObligationRejection,
  readTextRenderingForStep,
  reviewSourcePhaseInput,
  reviewStepInput,
  runAuthoringRevisionSession,
  scriptedProvider,
  sealOriginalSourceAuthority,
  skillCrateDirectory,
  sourceObligationRejectionMessage,
  sourceObligationScopeSha256,
  stepInput,
  technicalStepInput,
  temporaryDirectories,
  testTimeoutMs,
  textTurn,
  thinkingAndTextTurn,
  thinkingTurn,
  validModelConfig,
  verifyQualityPackContext,
} from "./support/pi-harness-session-fixtures.js";
import { internalOnly } from "./helpers/internal-path.js";
import { searchStepEvidence } from "./helpers/search-evidence-fixture.js";
import {
  configureCredential,
  configureCredentialsForEachTest,
} from "./helpers/configured-credential.js";
import { plantedCredentialValue } from "./helpers/planted-credential.js";

// These tests plant credential fixtures to prove a boundary refuses them; under
// the owner decision on #1807 only a configured credential is refused, so
// each fixture is configured for every test in this file.
configureCredentialsForEachTest(
  `glpat-${"A1b2C3d4E5f6G7h8J9k0"}`,
  "glpat-xxxxxxxxxxxxxxxxxxxxxxxx",
  `nvapi-${"Q7w8E9r0".repeat(5)}`,
  `nvapi-${"Zx4Y".repeat(6)}`,
  `ghp_${"Rk7Q".repeat(9)}`,
  `ghp_${"Aa11".repeat(9)}`,
  "ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD",
);

const localWorkflowsReport = internalOnly(
  "benchmarks/local-workflows/lib/report.mjs",
  "it renders the root local-workflows report, which is not exported",
);
const stagedSchema = vi.hoisted(() => ({ unavailable: false }));
vi.mock("../src/evaluation-report/quality-schema-validation.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/evaluation-report/quality-schema-validation.js")>();
  return {
    ...actual,
    validateStagedQualityArtifact: (
      ...args: Parameters<typeof actual.validateStagedQualityArtifact>
    ) =>
      stagedSchema.unavailable
        ? "schema-unavailable"
        : actual.validateStagedQualityArtifact(...args),
  };
});

afterEach(async () => {
  stagedSchema.unavailable = false;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

/**
 * `docsfab runs show` output without its reply-excerpt lines, which are the one
 * place a rejected reply's text may appear.
 */
function withoutExcerptLines(output: string): string {
  return output
    .split("\n")
    .filter((line) => !/^\s*(?:Reply excerpt: |(?:head|parse-position|tail) \d+-\d+: )/u.test(line))
    .join("\n");
}

/** A JSON surface without any `rejectedReplyExcerpt` member. */
function withoutExcerptMembers(json: string): string {
  return JSON.stringify(
    JSON.parse(json, (key, member: unknown) =>
      key === "rejectedReplyExcerpt" ? undefined : member,
    ),
  );
}

describe("PiHarness review response admission", () => {
  const issue = {
    id: "TECH-001",
    severity: "major",
    category: "technical_accuracy",
    location: "README.md:12",
    finding: "The command omits a required flag.",
    evidence: { source_id: "source-1", locator: "src/cli.ts:42" },
    required_change: "Add the required flag.",
  };
  const responses = {
    technical: {
      coverage: [
        {
          reason: "Compared the documented command with the option parser.",
          evidence: ["src/cli.ts:42"],
          status: "verified",
          path: "README.md",
        },
      ],
      review: { issues: [issue], verdict: "needs-revision" },
      factInventory: {
        completeness: "bounded-not-proven",
        dimensions: TECHNICAL_FACT_DIMENSIONS.map((dimension) =>
          dimension === "input-representations"
            ? {
                dimension,
                status: "applicable",
                reason: "The command input is material to this focused review.",
                sourceLocators: [],
                facts: [
                  {
                    id: "FACT-INPUT-001",
                    dimension,
                    sourceLocators: ["src/cli.ts:42"],
                    statement: "The command input requires a flag defined by the option parser.",
                    documentationDisposition: "omitted",
                    uncertainty: "The focused source fixture defines the required flag.",
                    issueIds: ["TECH-001"],
                  },
                ],
              }
            : {
                dimension,
                status: "not-applicable",
                reason: `The focused source fixture defines no ${dimension} behavior.`,
                sourceLocators: ["src/cli.ts:42"],
                facts: [],
              },
        ),
        limitations: ["The bounded fixture inventory does not establish repository-wide coverage."],
      },
    },
    editorial: { issues: [issue], verdict: "needs-revision" },
  } as const;

  it.each([
    ["audit-only", "verify-technical-accuracy", responses.technical, false],
    ["audit-only", "review-documentation", responses.editorial, false],
    ["composition", "verify-technical-accuracy", responses.technical, true],
    ["composition", "review-documentation", responses.editorial, true],
  ] as const)(
    "admits and emits only canonical %s %s output from a real mocked session",
    async (_mode, skill, response, withComposition) => {
      const repositoryPath = await createRepository();
      const prettyResponse = JSON.stringify(response, null, 2);
      const onText = vi.fn();
      vi.stubGlobal("fetch", scriptedProvider([textTurn(prettyResponse)]));

      const result = await (await createReviewHarness(withComposition)).runStep({
        ...reviewStepInput(repositoryPath, skill),
        onText,
      });

      expect(result.summary).toBe(
        canonicalizeJsonEvidence(response as unknown as JsonEvidenceValue).trimEnd(),
      );
      expect(onText).toHaveBeenCalledOnce();
      expect(onText).toHaveBeenCalledWith(result.summary);
      expect(onText).not.toHaveBeenCalledWith(prettyResponse);
      expect(result.turns).toHaveLength(1);
      expect(result.executionLease?.terminalDisposition).toBe("completed");
      const projected = projectReviewFindingsFromRun({
        steps: [
          {
            id: skill,
            title: skill,
            skill,
            mode: "read-only",
            status: "succeeded",
            summary: result.summary,
          },
        ],
        ...(skill === "verify-technical-accuracy"
          ? { reviewScope: reviewStepInput(repositoryPath, skill).reviewScope }
          : {}),
      });
      expect(projected.findings).toEqual([
        expect.objectContaining({
          id:
            skill === "verify-technical-accuracy"
              ? "finding:verify-technical-accuracy:TECH-001:1:fact:1"
              : "finding:review-documentation:TECH-001:1",
          code: skill === "verify-technical-accuracy" ? "FACT-INPUT-001" : "TECH-001",
          path: "README.md",
          line: 12,
        }),
      ]);
    },
  );

  it("validates the completed assistant message when its final streamed delta is incomplete", async () => {
    const repositoryPath = await createRepository();
    vi.stubGlobal("fetch", scriptedProvider([textTurn(JSON.stringify(responses.technical))]));
    const harness = await createAuditHarness({
      configureSession: (session) => {
        type Event = Parameters<Parameters<typeof session.subscribe>[0]>[0];
        const seam = session as unknown as { _emit(event: Event): void };
        const emit = seam._emit.bind(seam);
        seam._emit = (event) => {
          if (
            event.type === "message_update" &&
            event.assistantMessageEvent.type === "text_delta"
          ) {
            emit({
              ...event,
              assistantMessageEvent: {
                ...event.assistantMessageEvent,
                delta: event.assistantMessageEvent.delta.slice(0, -1),
              },
            });
          } else emit(event);
        };
      },
    });
    const result = await harness.runStep(
      reviewStepInput(repositoryPath, "verify-technical-accuracy"),
    );
    expect(result.summary).toBe(
      canonicalizeJsonEvidence(responses.technical as unknown as JsonEvidenceValue).trimEnd(),
    );
  });

  it.each([false, true])(
    "admits one bounded CREATE revision response through the real Pi session (narrated tool=%s)",
    async (narrated) => {
      const narration = "I will inspect the bounded documentation source.";
      const { result, response, responseText, requests, onText, revision } =
        await runAuthoringRevisionSession((terminalResponse) => {
          const split = Math.floor(terminalResponse.length / 2);
          const finalTurn = thinkingAndTextTurn("Private scratchpad.", [
            terminalResponse.slice(0, split),
            terminalResponse.slice(split),
          ]);
          return narrated
            ? [
                narratedToolTurn(narration, [
                  {
                    id: "revision-read-1",
                    name: "read",
                    arguments: { path: "docs/guide.md" },
                  },
                ]),
                finalTurn,
              ]
            : [finalTurn];
        });

      expect(result.authoringRevisionAccounting).toEqual(response);
      expect(result.summary).toBe(responseText);
      const streamed = onText.mock.calls.map(([text]) => text as string);
      expect(streamed.slice(narrated ? 1 : 0).join("")).toBe(responseText);
      if (narrated) expect(streamed[0]).toBe(narration);
      expect(result.tools).toMatchObject({ totalCalls: narrated ? 1 : 0, failedCalls: 0 });
      expect(result.turns).toHaveLength(narrated ? 2 : 1);
      const content = requests[0]?.messages?.at(-1)?.content;
      const prompt = Array.isArray(content)
        ? content.map((part) => part.text ?? "").join("")
        : (content ?? "");
      expect(
        prompt.split("Runtime authoring-revision response contract (host-owned):"),
      ).toHaveLength(2);
      expect(prompt).toContain(revision.digest);
      // The unchanged-applied rule's catalog statement.
      expect(prompt).toContain(
        'A revision that leaves every planned page identical to candidate 0 cannot mark any issue "applied".',
      );
    },
  );

  it("rejects prose wrapped around same-turn revision accounting JSON", async () => {
    const failure = await captureAuthoringRevisionFailure((responseText) => [
      textTurn(`I completed the revision.\n${responseText}`),
    ]);
    // The attempt carries the coded rejection, and the retryability table makes
    // strict JSON model-correctable for the host-reset revision writer.
    expect(failure).toMatchObject({
      category: "malformed-response",
      retryable: true,
      rejection: { code: "revision-accounting-invalid-json", location: "$" },
    });
    expect(failure.message).toMatch(/^Authoring revision accounting/);
  });

  it("rejects an invalid terminal response after valid-looking tool-turn text", async () => {
    const failure = await captureAuthoringRevisionFailure((responseText) => [
      narratedToolTurn(responseText, [
        { id: "revision-read-2", name: "read", arguments: { path: "docs/guide.md" } },
      ]),
      textTurn("{}"),
    ]);
    expect(failure).toMatchObject({
      category: "malformed-response",
      retryable: true,
      rejection: { code: "revision-accounting-invalid-root-shape", location: "$" },
    });
    expect(failure.message).toMatch(/^Authoring revision accounting/);
  });

  it("does not admit earlier JSON when the terminal assistant turn contains only thinking", async () => {
    await expect(
      runAuthoringRevisionSession((responseText) => [
        narratedToolTurn(responseText, [
          { id: "revision-read-3", name: "read", arguments: { path: "docs/guide.md" } },
        ]),
        thinkingTurn("The accounting is complete."),
      ]),
    ).rejects.toMatchObject({
      category: "blank-response",
      retryable: true,
      message: "Model returned a blank response.",
    });
  });

  it("presents one strict verification contract and target with the reader baseline", async () => {
    const repositoryPath = await createRepository();
    const readerContextInput = {
      schema_version: 1 as const,
      target_audience: "operators",
      reader_job: "verify the named documentation",
      change_scope: ["README.md"],
      source_priority: ["current implementation", "current documentation"],
      required_content: ["verified behavior"],
      excluded_content: [],
      unresolved_questions: [],
    };
    const supplier = await createReaderTaskContextSupplier(
      await verifyQualityPackContext({
        qualityPackDirectory: resolve(projectRoot, "quality-pack"),
        qualityDirectory: resolve(projectRoot, "quality"),
        skillCrateDirectory,
      }),
    );
    const requests: Array<{
      messages?: Array<{ content?: string | Array<{ text?: string }> }>;
    }> = [];
    const provider = scriptedProvider([textTurn(JSON.stringify(responses.technical))]);
    vi.stubGlobal("fetch", async (request: RequestInfo | URL, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)));
      return provider(request, init);
    });

    await (await createAuditHarness()).runStep({
      ...reviewStepInput(repositoryPath, "verify-technical-accuracy"),
      reviewScope: undefined,
      contextTarget: { sourcePath: "README.md" },
      readerContextInput,
      readerTaskContext: supplier.projectInput(readerContextInput),
    });

    expect(requests).toHaveLength(1);
    const content = requests[0]?.messages?.at(-1)?.content;
    const prompt = Array.isArray(content)
      ? content.map((part) => part.text ?? "").join("")
      : (content ?? "");
    for (const marker of [
      "Runtime technical verification response contract (host-owned):",
      'Authoritative verification target: ["README.md"]',
      "# Reader Impact Baseline",
    ]) {
      expect(prompt.split(marker)).toHaveLength(2);
    }
    expect(prompt).toContain("factInventory");
  });

  /**
   * The provisional prompt and decoder select the judgment mode from one
   * predicate. Without a V2 ledger the decoder admits the full verification
   * shape, so the prompt must not ask for judgment only; with a V2 ledger the
   * host fills a judgment-only reply.
   */
  it.each(["none", "v1", "v2"] as const)(
    "binds the provisional contract its decoder admits (ledger %s)",
    async (ledgerVersion) => {
      const repositoryPath = await createRepository();
      const deriveInput = reviewSourcePhaseInput(repositoryPath, "derive-source-obligations");
      const proposal: SourceObligationLedgerProposalV1 = {
        completeness: "bounded-not-proven",
        dimensions: TECHNICAL_FACT_DIMENSIONS.map((dimension) =>
          dimension === "input-representations"
            ? {
                dimension,
                status: "applicable" as const,
                reason: "The focused source establishes one input obligation.",
                sourceLocators: [],
                obligations: [
                  {
                    id: "OBL-INPUT-1",
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
      };
      const sources = [{ path: "README.md", sha256: "f".repeat(64) }];
      const ledger =
        ledgerVersion === "v1"
          ? bindSourceObligationLedger(proposal, deriveInput, sources)
          : ledgerVersion === "v2"
            ? bindSourceObligationLedgerV2(
                proposal,
                deriveInput,
                sources,
                sealOriginalSourceAuthority({
                  runId: deriveInput.runId!,
                  scope: "review-tracked-workspace",
                  repositoryRevision: deriveInput.evidenceIdentity!.repositoryRevision,
                  scopeSha256: sourceObligationScopeSha256(deriveInput),
                  workspaceSnapshotSha256: deriveInput.searchEvidence!.workspaceSnapshotSha256,
                  members: [
                    {
                      path: "README.md",
                      mode: 0o644,
                      byteLength: 10,
                      sourceSha256: "f".repeat(64),
                    },
                  ],
                }).evidence,
              )
            : undefined;
      const judgmentMode = ledger?.schemaVersion === 2;
      const obligationId = ledger?.dimensions.find(
        (dimension) => dimension.dimension === "input-representations",
      )?.obligations[0]?.id;
      const reply = judgmentMode
        ? {
            verdict: "needs-revision",
            coverage: responses.technical.coverage,
            issueJudgments: [
              {
                id: issue.id,
                severity: issue.severity,
                category: issue.category,
                location: issue.location,
                obligationIds: [obligationId],
              },
            ],
            obligationJudgments: [
              {
                obligationId,
                disposition: "retained",
                documentationDisposition: "omitted",
                issueIds: [issue.id],
              },
            ],
          }
        : responses.technical;
      const requests: Array<{
        messages?: Array<{ content?: string | Array<{ text?: string }> }>;
      }> = [];
      const provider = scriptedProvider([textTurn(JSON.stringify(reply))]);
      vi.stubGlobal("fetch", async (request: RequestInfo | URL, init?: RequestInit) => {
        requests.push(JSON.parse(String(init?.body)));
        return provider(request, init);
      });

      const result = await (await createAuditHarness()).runStep({
        ...reviewSourcePhaseInput(repositoryPath, "provisional-technical-verification"),
        ...(ledger ? { sourceObligationLedger: ledger } : {}),
      });

      const content = requests[0]?.messages?.at(-1)?.content;
      const prompt = Array.isArray(content)
        ? content.map((part) => part.text ?? "").join("")
        : (content ?? "");
      expect(
        prompt.includes(
          "Runtime provisional technical verification judgment contract (host-owned):",
        ),
      ).toBe(judgmentMode);
      expect(
        prompt.includes("Runtime technical verification response contract (host-owned):"),
      ).toBe(!judgmentMode);
      expect(result.verificationResult?.review.verdict).toBe("needs-revision");
      expect(result.verificationResult?.review.issues.map(({ id }) => id)).toEqual([issue.id]);
    },
  );

  it("checks a dimension demotion against the host's line counts at the real Pi boundary (#1254)", async () => {
    const repositoryPath = await createRepository();
    const deriveInput = reviewSourcePhaseInput(repositoryPath, "derive-source-obligations");
    const applicable = ["input-representations", "defaults-and-overrides"] as const;
    const proposal: SourceObligationLedgerProposalV1 = {
      completeness: "bounded-not-proven",
      dimensions: TECHNICAL_FACT_DIMENSIONS.map((dimension) =>
        (applicable as readonly string[]).includes(dimension)
          ? {
              dimension,
              status: "applicable" as const,
              reason: `The focused source establishes one ${dimension} obligation.`,
              sourceLocators: [],
              obligations: [
                {
                  dimension,
                  sourceLocators: ["README.md:1"],
                  statement: `The focused source establishes a ${dimension} statement.`,
                  evidenceClass: "source-observation" as const,
                  uncertainty: "The focused source fixture was read, not executed.",
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
    };
    const sha256 = "f".repeat(64);
    const ledger = bindSourceObligationLedgerV2(
      proposal,
      deriveInput,
      [{ path: "README.md", sha256 }],
      sealOriginalSourceAuthority({
        runId: deriveInput.runId!,
        scope: "review-tracked-workspace",
        repositoryRevision: deriveInput.evidenceIdentity!.repositoryRevision,
        scopeSha256: sourceObligationScopeSha256(deriveInput),
        workspaceSnapshotSha256: deriveInput.searchEvidence!.workspaceSnapshotSha256,
        members: [{ path: "README.md", mode: 0o644, byteLength: 10, sourceSha256: sha256 }],
      }).evidence,
    );
    const idOf = (dimension: string) =>
      ledger.dimensions.find((entry) => entry.dimension === dimension)!.obligations[0]!.id;
    const reply = {
      verdict: "pass",
      coverage: responses.technical.coverage,
      issueJudgments: [],
      obligationJudgments: [
        {
          obligationId: idOf("input-representations"),
          disposition: "retained",
          documentationDisposition: "documented",
          issueIds: [],
        },
        {
          obligationId: idOf("defaults-and-overrides"),
          disposition: "rejected",
          reason: "The cited source lines establish no default or override.",
          rejectionCode: "not-established-by-source",
          evidenceLocators: ["README.md:1", "README.md:2"],
        },
      ],
    };
    const run = async (lineCount: number) => {
      vi.stubGlobal("fetch", scriptedProvider([textTurn(JSON.stringify(reply))]));
      return (await createAuditHarness()).runStep({
        ...reviewSourcePhaseInput(repositoryPath, "provisional-technical-verification"),
        sourceObligationLedger: ledger,
        admittedSourceLineCounts: [{ path: "README.md", sha256, lineCount }],
      });
    };

    const admitted = await run(2);
    expect(admitted.verificationResult?.review.verdict).toBe("human-review");
    expect(
      admitted.verificationResult?.factInventory.dimensions.find(
        ({ dimension }) => dimension === "defaults-and-overrides",
      )?.status,
    ).toBe("unverified");
    await expect(run(1)).rejects.toMatchObject({
      rejection: { code: "demotion-evidence-unresolved" },
    });
  });

  it("preserves attempt evidence when structured review admission rejects the response", async () => {
    const repositoryPath = await createRepository();
    const onText = vi.fn();
    // The fence is unwrapped, so admission rejects this: a verdict that
    // disagrees with its issues is refused by `validateEditorialReviewResult`
    // after the parser accepts the document.
    vi.stubGlobal(
      "fetch",
      scriptedProvider([
        textTurn(
          `\`\`\`json\n${JSON.stringify({ ...responses.editorial, verdict: "approve" })}\n\`\`\``,
        ),
      ]),
    );

    const error = await captureInferenceFailure(await createAuditHarness(), {
      ...reviewStepInput(repositoryPath, "review-documentation"),
      onText,
    });

    expect(error).toMatchObject({ category: "malformed-response", retryable: true });
    expect(error.evidence?.model?.model).toBe(validModelConfig.modelId);
    expect(error.evidence?.turns).toHaveLength(1);
    expect(error.evidence?.executionLease?.terminalDisposition).toBe("completed");
    expect(onText).not.toHaveBeenCalled();
  });

  it("preserves the coded rejection reason when source-obligation decode fails at the real Pi boundary", async () => {
    // The harness attaches this attempt's evidence by rebuilding the error,
    // which can drop the decoder's reason. This drives the real PiHarness
    // because calling the wrap helper directly would not prove this call site.
    const repositoryPath = await createRepository();
    const onText = vi.fn();
    // The fence is unwrapped, so its body must be malformed for the parser's
    // own `malformed-json` reason to be recorded.
    vi.stubGlobal("fetch", scriptedProvider([textTurn("```json\n{oops}\n```")]));

    const error = await captureInferenceFailure(await createAuditHarness(), {
      ...reviewSourcePhaseInput(repositoryPath, "derive-source-obligations"),
      reviewScope: undefined,
      contextTarget: { sourcePath: "README.md" },
      onText,
    });

    // Attempt evidence is attached.
    expect(error).toMatchObject({ category: "malformed-response", retryable: true });
    expect(error.evidence?.turns).toHaveLength(1);
    expect(error.evidence?.model?.model).toBe(validModelConfig.modelId);

    // The coded reason survived the same wrap, on the same thrown error.
    expect(projectSourceObligationRejection(error)).toEqual({
      code: "malformed-json",
      location: "$response",
    });
    expect(error.message).toBe(sourceObligationRejectionMessage("malformed-json", "$response"));
    expect(onText).not.toHaveBeenCalled();
  });

  it("stops a credential-bearing source-obligation reply after one model call at the real Pi boundary", async () => {
    // Credential material is a disclosure rejection. With retry budget left and
    // a provider scripted to answer again, the step makes one model call and
    // fails terminally.
    const repositoryPath = await createRepository();
    const reply = JSON.stringify({
      completeness: "bounded-not-proven",
      dimensions: TECHNICAL_FACT_DIMENSIONS.map((dimension) => ({
        dimension,
        status: "not-applicable",
        reason: `The focused source sets glpat-${"A1b2C3d4E5f6G7h8J9k0"} for ${dimension}.`,
        sourceLocators: ["README.md:1"],
        obligations: [],
      })),
      limitations: [],
    });
    const provider = scriptedProvider([textTurn(reply), textTurn(reply), textTurn(reply)]);
    let modelCalls = 0;
    vi.stubGlobal("fetch", async (request: RequestInfo | URL, init?: RequestInit) => {
      modelCalls += 1;
      return provider(request, init);
    });
    const harness = await createAuditHarness();
    const input = {
      ...reviewSourcePhaseInput(repositoryPath, "derive-source-obligations"),
      reviewScope: undefined,
      contextTarget: { sourcePath: "README.md" },
    };

    const execution = await executeInferenceStep({
      mode: "read-only",
      policy: {
        maxRetries: 2,
        baseDelayMs: 0,
        maxDelayMs: 0,
        retryableCategories: ["malformed-response"],
      },
      execute: () => harness.runStep(input),
    });

    expect(modelCalls).toBe(1);
    expect(execution.status).toBe("failed");
    if (execution.status !== "failed") throw new Error("expected a failed step");
    expect(execution.error).toMatchObject({ category: "malformed-response", retryable: false });
    expect(projectSourceObligationRejection(execution.error)).toEqual({
      code: "credential-material",
      location: "$",
    });
    expect(execution.evidence.attempts).toMatchObject([
      { attempt: 1, outcome: "malformed-response", retryable: false, retryScheduled: false },
    ]);
    expect(JSON.stringify(execution.evidence.attempts)).not.toContain("glpat-");
  });

  /**
   * Runs one step through the real harness and retry loop with retry budget
   * left and the provider scripted to answer three times, counting calls.
   */
  async function runWithRetryBudget(input: HarnessStepInput, reply: string) {
    const provider = scriptedProvider([textTurn(reply), textTurn(reply), textTurn(reply)]);
    let modelCalls = 0;
    vi.stubGlobal("fetch", async (request: RequestInfo | URL, init?: RequestInit) => {
      modelCalls += 1;
      return provider(request, init);
    });
    const harness = await createAuditHarness();
    const execution = await executeInferenceStep({
      mode: "read-only",
      policy: {
        maxRetries: 2,
        baseDelayMs: 0,
        maxDelayMs: 0,
        retryableCategories: ["malformed-response"],
      },
      execute: () => harness.runStep(input),
    });
    return { execution, modelCalls };
  }

  const DISCLOSURES = [["a credential", `glpat-${"A1b2C3d4E5f6G7h8J9k0"}`]] as const;

  it("admits a review-documentation review result that cites a host path in its finding", async () => {
    const repositoryPath = await createRepository();
    const finding = "The command reads /Users/alice/private/cli.ts and /tmp/x before it runs.";
    const reply = JSON.stringify({ ...responses.editorial, issues: [{ ...issue, finding }] });

    const { execution, modelCalls } = await runWithRetryBudget(
      reviewStepInput(repositoryPath, "review-documentation"),
      reply,
    );

    expect(modelCalls).toBe(1);
    expect(execution.status).toBe("succeeded");
    if (execution.status !== "succeeded") throw new Error("expected an admitted step");
    expect(execution.result.summary).toContain(finding);
  });

  it.each(DISCLOSURES)(
    "stops a review-documentation review result carrying %s after one model call",
    async (_label, disclosed) => {
      const repositoryPath = await createRepository();
      const reply = JSON.stringify({
        ...responses.editorial,
        issues: [{ ...issue, finding: `The command reads ${disclosed} before it runs.` }],
      });

      const { execution, modelCalls } = await runWithRetryBudget(
        reviewStepInput(repositoryPath, "review-documentation"),
        reply,
      );

      expect(modelCalls).toBe(1);
      expect(execution.status).toBe("failed");
      if (execution.status !== "failed") throw new Error("expected a failed step");
      expect(execution.error).toMatchObject({ category: "malformed-response", retryable: false });
      expect(execution.evidence.attempts).toMatchObject([
        { attempt: 1, outcome: "malformed-response", retryable: false, retryScheduled: false },
      ]);
      expect(JSON.stringify(execution.evidence.attempts)).not.toContain(disclosed);
    },
  );

  it.each(DISCLOSURES)(
    "stops an update-documentation editorial review result carrying %s after one model call",
    async (_label, disclosed) => {
      const repositoryPath = await createRepository();
      const input = editorialTechnicalStepInput(repositoryPath);
      input.step = input.workflow.steps.find((step) => step.skill === "review-documentation")!;
      const reply = JSON.stringify({
        summary: {
          verdict: "needs-revision",
          issues: [
            {
              id: "REV-001",
              severity: "major",
              category: "completeness",
              location: "README.md:4",
              finding: `Readers cannot run the command without ${disclosed}.`,
              evidence: { source_id: "repository", locator: "README.md:4" },
              required_change: "Document the source-supported prerequisite.",
            },
          ],
        },
        editorialAssessmentProposal: {
          schemaVersion: 1,
          kind: "docsfab-editorial-assessment-proposal",
          assessment: "rejected",
          rationale: "The documentation candidate omits a required reader prerequisite.",
          evidenceRefs: input.editorialEvidenceRefs,
          limitations: ["product-gap.prerequisite"],
          recommendation: {
            candidate: "update",
            kind: "product-gap",
            code: "product-gap.prerequisite",
          },
        },
      });

      const { execution, modelCalls } = await runWithRetryBudget(input, reply);

      expect(modelCalls).toBe(1);
      expect(execution.status).toBe("failed");
      if (execution.status !== "failed") throw new Error("expected a failed step");
      expect(execution.error).toMatchObject({ category: "malformed-response", retryable: false });
      expect(execution.evidence.attempts).toMatchObject([
        { attempt: 1, outcome: "malformed-response", retryable: false, retryScheduled: false },
      ]);
      expect(JSON.stringify(execution.evidence.attempts)).not.toContain(disclosed);
    },
  );

  it("stops an update-documentation audience assessment with a credential in its text summary after one model call", async () => {
    const repositoryPath = await createRepository();
    const input = editorialTechnicalStepInput(repositoryPath);
    input.step = input.workflow.steps.find((step) => step.skill === "test-audience-understanding")!;
    const token = `glpat-${"A1b2C3d4E5f6G7h8J9k0"}`;
    const reply = JSON.stringify({
      summary: `Readers need ${token} before the first command.`,
      editorialAssessmentProposal: {
        schemaVersion: 1,
        kind: "docsfab-editorial-assessment-proposal",
        assessment: "accepted",
        rationale: "The documentation candidate supports the reader task.",
        evidenceRefs: input.editorialEvidenceRefs,
        limitations: [],
        recommendation: { candidate: "update" },
      },
    });

    const { execution, modelCalls } = await runWithRetryBudget(input, reply);

    expect(modelCalls).toBe(1);
    expect(execution.status).toBe("failed");
    if (execution.status !== "failed") throw new Error("expected a failed step");
    expect(execution.error).toMatchObject({
      category: "malformed-response",
      retryable: false,
      message: "Editorial assessment response rejected: credential-material.",
    });
    expect(JSON.stringify(execution.evidence.attempts)).not.toContain(token);
  });

  it("preserves a nonretryable unavailable-schema failure at the real Pi boundary", async () => {
    const repositoryPath = await createRepository();
    const onText = vi.fn();
    const proposal: SourceObligationLedgerProposalV1 = {
      completeness: "bounded-not-proven",
      dimensions: TECHNICAL_FACT_DIMENSIONS.map((dimension) => ({
        dimension,
        status: "not-applicable",
        reason: `The focused source establishes no ${dimension} obligation.`,
        sourceLocators: ["README.md:1"],
        obligations: [],
      })),
      limitations: [],
    };
    const deriveInput = reviewSourcePhaseInput(repositoryPath, "derive-source-obligations");
    const ledger = bindSourceObligationLedger(proposal, deriveInput, [
      { path: "README.md", sha256: "f".repeat(64) },
    ]);
    stagedSchema.unavailable = true;
    vi.stubGlobal(
      "fetch",
      scriptedProvider([
        textTurn(
          JSON.stringify({
            verificationResult: responses.technical,
            obligationAccounting: [],
          }),
        ),
      ]),
    );

    const error = await captureInferenceFailure(await createAuditHarness(), {
      ...reviewSourcePhaseInput(repositoryPath, "verify-technical-accuracy"),
      sourceObligationLedger: ledger,
      onText,
    });

    expect(error).toMatchObject({ category: "malformed-response", retryable: false });
    expect(error.message).toContain("Technical correction response rejected: invalid-review.");
    expect(error.evidence?.turns).toHaveLength(1);
    expect(error.evidence?.executionLease?.terminalDisposition).toBe("completed");
    expect(onText).not.toHaveBeenCalled();
  });

  it("admits derivation and canonical correction through separate real Pi transports", async () => {
    const repositoryPath = await createRepository();
    const proposal: SourceObligationLedgerProposalV1 = {
      completeness: "bounded-not-proven",
      dimensions: TECHNICAL_FACT_DIMENSIONS.map((dimension) => ({
        dimension,
        status: "not-applicable",
        reason: `The focused source establishes no ${dimension} obligation.`,
        sourceLocators: ["README.md:1"],
        obligations: [],
      })),
      limitations: [],
    };
    const deriveInput = {
      ...reviewSourcePhaseInput(repositoryPath, "derive-source-obligations"),
      reviewScope: undefined,
      contextTarget: { sourcePath: "README.md" },
    };
    expect(readTextRenderingForStep(deriveInput)).toBe("source-coordinates");
    vi.stubGlobal("fetch", scriptedProvider([textTurn(JSON.stringify(proposal, null, 2))]));
    const derived = await (await createAuditHarness()).runStep(deriveInput);
    expect(derived.sourceObligationProposal).toEqual(proposal);
    expect(derived.verificationResult).toBeUndefined();

    const ledger = bindSourceObligationLedger(proposal, deriveInput, [
      { path: "README.md", sha256: "f".repeat(64) },
    ]);
    const finalInput = {
      ...reviewSourcePhaseInput(repositoryPath, "verify-technical-accuracy"),
      reviewScope: undefined,
      contextTarget: { sourcePath: "README.md" },
      sourceObligationLedger: ledger,
    };
    const onText = vi.fn();
    const requests: Array<{
      messages?: Array<{ content?: string | Array<{ text?: string }> }>;
    }> = [];
    const provider = scriptedProvider([
      textTurn(
        JSON.stringify({
          verificationResult: responses.technical,
          obligationAccounting: [],
        }),
      ),
    ]);
    vi.stubGlobal("fetch", async (request: RequestInfo | URL, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)));
      return provider(request, init);
    });
    const corrected = await (await createAuditHarness()).runStep({ ...finalInput, onText });
    expect(corrected.verificationResult).toEqual(responses.technical);
    expect(corrected.technicalCorrectionEvidence).toMatchObject({
      kind: "docsfab-technical-correction-evidence",
      sourceObligationLedgerSha256: ledger.digest,
      obligationAccounting: [],
    });
    expect(corrected.summary).toBe(
      canonicalizeJsonEvidence(responses.technical as unknown as JsonEvidenceValue).trimEnd(),
    );
    expect(onText).toHaveBeenCalledOnce();
    expect(onText).toHaveBeenCalledWith(corrected.summary);
    const finalContent = requests[0]?.messages?.at(-1)?.content;
    const prompt = Array.isArray(finalContent)
      ? finalContent.map((part) => part.text ?? "").join("")
      : (finalContent ?? "");
    expect(prompt).toContain(
      "Return one JSON object with exactly verificationResult and obligationAccounting",
    );
    expect(prompt).toContain("do not return review, coverage, or factInventory at the top level");
    expect(prompt).toContain(
      "Nest that exact ordinary three-field object only under verificationResult",
    );
    expect(prompt).toContain("Nested technical verificationResult contract (host-owned):");
    expect(prompt).toContain('Shape: {"review":{"verdict":"pass","issues":[]}');
    expect(prompt).toContain("Include each target page exactly once in coverage");
    expect(prompt).toContain("Every fact needs a stable ID");
    expect(prompt).toContain('Authoritative verification target: ["README.md"]');
    expect(prompt).not.toContain(
      "Return one JSON object with exactly review, coverage, and factInventory",
    );
  });

  it("preflights opaque V2 authority before provider work and keeps complete members out of prompts", async () => {
    const repositoryPath = await createRepository();
    const deriveInput = reviewSourcePhaseInput(repositoryPath, "derive-source-obligations");
    const proposal: SourceObligationLedgerProposalV1 = {
      completeness: "bounded-not-proven",
      dimensions: TECHNICAL_FACT_DIMENSIONS.map((dimension, index) =>
        index === 0
          ? {
              dimension,
              status: "applicable" as const,
              reason: "The focused source establishes one input obligation.",
              sourceLocators: [],
              obligations: [
                {
                  id: "OBL-INPUT-1",
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
    };
    const scopeSha256 = sourceObligationScopeSha256(deriveInput);
    const sealed = sealOriginalSourceAuthority({
      runId: deriveInput.runId!,
      scope: "review-tracked-workspace",
      repositoryRevision: deriveInput.evidenceIdentity!.repositoryRevision,
      scopeSha256,
      workspaceSnapshotSha256: deriveInput.searchEvidence!.workspaceSnapshotSha256,
      members: [
        { path: "README.md", mode: 0o644, byteLength: 10, sourceSha256: "f".repeat(64) },
        { path: "src/cli.ts", mode: 0o644, byteLength: 14, sourceSha256: "f".repeat(64) },
        {
          path: "src/private-context.ts",
          mode: 0o644,
          byteLength: 12,
          sourceSha256: "e".repeat(64),
        },
      ],
    });
    const ledger = bindSourceObligationLedgerV2(
      proposal,
      deriveInput,
      [{ path: "README.md", sha256: "f".repeat(64) }],
      sealed.evidence,
    );
    const obligationId = ledger.dimensions.find(
      (dimension) => dimension.dimension === "input-representations",
    )!.obligations[0]!.id;
    const finalInput = {
      ...reviewSourcePhaseInput(repositoryPath, "verify-technical-accuracy"),
      runId: deriveInput.runId,
      sourceObligationLedger: ledger,
    };
    let providerCalls = 0;
    vi.stubGlobal("fetch", async () => {
      providerCalls += 1;
      throw new Error("provider should not run");
    });
    await expect((await createAuditHarness()).runStep(finalInput)).rejects.toThrow(
      "original source authority",
    );
    expect(providerCalls).toBe(0);

    const admission = issueOriginalSourceAuthorityAdmission({
      capture: sealed.capture,
      observer: {
        observe: async (paths) => paths.map((path) => ({ path, sha256: "f".repeat(64) })),
      },
      runId: deriveInput.runId!,
      repositoryRevision: deriveInput.evidenceIdentity!.repositoryRevision,
      scopeSha256,
      workspaceSnapshotSha256: deriveInput.searchEvidence!.workspaceSnapshotSha256,
    });
    const requests: Array<{ messages?: Array<{ content?: string | Array<{ text?: string }> }> }> =
      [];
    const provider = scriptedProvider([
      textTurn(
        JSON.stringify({
          verdict: "needs-revision",
          coverage: responses.technical.coverage,
          issueJudgments: [
            {
              id: issue.id,
              severity: issue.severity,
              category: issue.category,
              location: issue.location,
              obligationIds: [obligationId],
            },
          ],
          obligationJudgments: [
            {
              obligationId,
              disposition: "retained",
              documentationDisposition: "omitted",
              issueIds: ["TECH-001"],
            },
          ],
        }),
      ),
    ]);
    vi.stubGlobal("fetch", async (request: RequestInfo | URL, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)));
      return provider(request, init);
    });
    const result = await (await createAuditHarness()).runStep({
      ...finalInput,
      originalSourceAuthorityAdmission: admission,
    });
    expect(result.technicalCorrectionEvidence?.schemaVersion).toBe(3);
    expect(result.verificationResult?.review.issues[0]?.finding).toBe(
      "Fact FACT-1 (omitted): The command input requires a flag defined by the option parser.\n" +
        "Qualification: The focused source fixture defines the required flag.",
    );
    const content = requests[0]?.messages?.at(-1)?.content;
    const prompt = Array.isArray(content)
      ? content.map((part) => part.text ?? "").join("")
      : (content ?? "");
    expect(prompt).not.toContain("src/private-context.ts");
    expect(prompt).not.toContain("e".repeat(64));
    expect(prompt).toContain("docsfab-technical-correction-proposal");
    expect(prompt).toContain("issueJudgments");
    expect(prompt).not.toContain("verificationResult");
  });

  it("tells CREATE derivation to separate revision-bound identities from proposal locators", async () => {
    const repositoryPath = await createRepository();
    const revision = "a".repeat(40);
    const workflow = getWorkflow("create-documentation");
    const pagePath = "docs/getting-started.md";
    const pages = [{ path: pagePath, disposition: "create" as const }];
    const sourceBindings = [{ pagePath, sources: [`README.md#consumer-guide@${revision}`] }];
    const planBinding = {
      kind: "docsfab-documentation-plan" as const,
      schemaVersion: 1 as const,
      mode: "create" as const,
      pages,
      sourceBindings,
      digest: documentationPlanBindingDigest({ mode: "create", pages, sourceBindings }),
    };
    const proposal: SourceObligationLedgerProposalV1 = {
      completeness: "bounded-not-proven",
      dimensions: TECHNICAL_FACT_DIMENSIONS.map((dimension) => ({
        dimension,
        status: "not-applicable",
        reason: `The focused source establishes no ${dimension} obligation.`,
        sourceLocators: ["README.md#consumer-guide"],
        obligations: [],
      })),
      limitations: [],
    };
    const requests: Array<{
      messages?: Array<{ content?: string | Array<{ text?: string }> }>;
    }> = [];
    const provider = scriptedProvider([textTurn(JSON.stringify(proposal))]);
    vi.stubGlobal("fetch", async (request: RequestInfo | URL, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)));
      return provider(request, init);
    });

    const result = await (await createAuditHarness()).runStep({
      runId: "real-pi-create-source-derivation",
      repositoryPath,
      workflow,
      step: workflow.steps.find((step) => step.id === "derive-source-obligations")!,
      planBinding,
      evidenceIdentity: { repositoryRevision: revision },
      searchEvidence: searchStepEvidence({
        evidenceSha256: "b".repeat(64),
        workspaceSnapshotSha256: "c".repeat(64),
      }),
    });

    expect(result.sourceObligationProposal).toEqual(proposal);
    const content = requests[0]?.messages?.at(-1)?.content;
    const prompt = Array.isArray(content)
      ? content.map((part) => part.text ?? "").join("")
      : (content ?? "");
    expect(prompt).toContain(`README.md#consumer-guide@${revision}`);
    expect(prompt).toContain("remove that @revision identity suffix from every sourceLocator");
    expect(prompt).toContain("host binds repository identity separately");
    // The status pairings are stated from the model-output catalog.
    expect(prompt).toContain(SOURCE_OBLIGATION_CATALOG_RULES);
    expect(prompt).toContain('An "applicable" dimension sets its own sourceLocators to [].');
    expect(prompt).toContain("inability to execute commands does not prevent source observation");
  });

  it("keeps source inventory scope free of candidate review output instructions", () => {
    const input = reviewSourcePhaseInput("/workspace", "derive-source-obligations");
    const prompt = buildDocsFabStepPrompt(input);
    expect(prompt).toContain('Documentation targets for later comparison: ["README.md"]');
    expect(prompt).toContain("Inspect relevant admitted implementation sources");
    expect(prompt).not.toContain("State in your output that this run reviewed");
    expect(prompt).not.toContain("Review only the approved pages");
    const comparison = buildDocsFabStepPrompt({
      ...input,
      step: input.workflow.steps.find((step) => step.id === "provisional-technical-verification")!,
    });
    expect(comparison).toContain("State in your output that this run reviewed");
  });

  it.each([
    [
      // The fence is unwrapped; the body is what must be malformed.
      "strict JSON",
      "```json\n{oops}\n```",
      "Strict JSON: malformed-json; response format: fenced.",
      true,
    ],
    [
      // The nested result fails the shared verification envelope, which
      // provisional verification also retries.
      "nested verification",
      JSON.stringify({ verificationResult: {}, obligationAccounting: [] }),
      "Technical correction response rejected: invalid-shape.",
      true,
    ],
  ])(
    "reports the canonical correction %s failure phase without response content",
    async (_name, response, expectedMessage, retryable) => {
      const repositoryPath = await createRepository();
      const proposal: SourceObligationLedgerProposalV1 = {
        completeness: "bounded-not-proven",
        dimensions: TECHNICAL_FACT_DIMENSIONS.map((dimension) => ({
          dimension,
          status: "not-applicable",
          reason: `The focused source establishes no ${dimension} obligation.`,
          sourceLocators: ["README.md:1"],
          obligations: [],
        })),
        limitations: [],
      };
      const deriveInput = reviewSourcePhaseInput(repositoryPath, "derive-source-obligations");
      const ledger = bindSourceObligationLedger(proposal, deriveInput, [
        { path: "README.md", sha256: "f".repeat(64) },
      ]);
      const onText = vi.fn();
      vi.stubGlobal("fetch", scriptedProvider([textTurn(response)]));

      const error = await captureInferenceFailure(await createAuditHarness(), {
        ...reviewSourcePhaseInput(repositoryPath, "verify-technical-accuracy"),
        sourceObligationLedger: ledger,
        onText,
      });

      expect(error).toMatchObject({ category: "malformed-response", retryable });
      expect(error.message).toContain(expectedMessage);
      expect(error.message).not.toContain(response.slice(0, 12));
      expect(error.evidence?.turns).toHaveLength(1);
      expect(onText).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      "syntax",
      '{"private":"/Users/alice/private.md",',
      "invalid-json. Strict JSON: malformed-json; response format: object-like. Output allowance 16384; observed output tokens 5; finish reason stop.",
      true,
    ],
    [
      "duplicate",
      '{"private":"glpat-xxxxxxxxxxxxxxxxxxxxxxxx","private":0}',
      "invalid-json. Strict JSON: duplicate-key; response format: object-like. Output allowance 16384; observed output tokens 5; finish reason stop.",
      true,
    ],
    [
      "number",
      '{"number":9007199254740993}',
      "invalid-json. Strict JSON: unsafe-number; response format: object-like. Output allowance 16384; observed output tokens 5; finish reason stop.",
      true,
    ],
    [
      // The fence is unwrapped; the body is what must be malformed.
      "fence",
      "```json\n{oops}\n```",
      "invalid-json. Strict JSON: malformed-json; response format: fenced. Output allowance 16384; observed output tokens 5; finish reason stop.",
      true,
    ],
    ["envelope", '{"private":"not-the-governed-envelope"}', "invalid-shape.", false],
  ] as const)(
    "preserves %s technical diagnostics through Pi, retry policy, and saved CLI replay",
    async (_label, response, suffix, retryable) => {
      for (const kind of ["review", "correction", "inventory"] as const) {
        const correction = kind === "correction";
        const inventory = kind === "inventory";
        // A wrong envelope key set is model-correctable in review and in
        // correction alike.
        const expectedRetryable = inventory || retryable || _label === "envelope";
        const repositoryPath = await createRepository();
        const beforeSource = await readFile(resolve(repositoryPath, "README.md"));
        const artifactPath = resolve(repositoryPath, "artifact-sentinel.json");
        await writeFile(artifactPath, "immutable artifact bytes");
        let input = inventory
          ? reviewSourcePhaseInput(repositoryPath, "derive-source-obligations")
          : technicalStepInput(repositoryPath);
        if (correction) {
          const proposal: SourceObligationLedgerProposalV1 = {
            completeness: "bounded-not-proven",
            dimensions: TECHNICAL_FACT_DIMENSIONS.map((dimension) => ({
              dimension,
              status: "not-applicable",
              reason: `No ${dimension} obligation in the bounded fixture.`,
              sourceLocators: ["README.md:1"],
              obligations: [],
            })),
            limitations: [],
          };
          const ledger = bindSourceObligationLedger(
            proposal,
            reviewSourcePhaseInput(repositoryPath, "derive-source-obligations"),
            [{ path: "README.md", sha256: "f".repeat(64) }],
          );
          input = {
            ...reviewSourcePhaseInput(repositoryPath, "verify-technical-accuracy"),
            sourceObligationLedger: ledger,
          };
        }
        const scriptedTurns = Array.from({ length: expectedRetryable ? 3 : 1 }, () =>
          textTurn(response),
        );
        const fetch = vi.fn(scriptedProvider(scriptedTurns));
        vi.stubGlobal("fetch", fetch);
        const onText = vi.fn();
        const harness = await createAuditHarness();
        const execution = await executeInferenceStep({
          mode: "read-only",
          policy: {
            maxRetries: 2,
            baseDelayMs: 0,
            maxDelayMs: 0,
            retryableCategories: ["malformed-response"],
          },
          execute: () => harness.runStep({ ...input, onText }),
        });
        // The inventory decoder names the host-owned rule and the contract
        // position it refused at. The strict-JSON labels keep distinct parser
        // sub-codes, and the envelope label, which parses and then lacks every
        // proposal key, names the first missing key.
        const message = inventory
          ? _label === "envelope"
            ? sourceObligationRejectionMessage("ledger-key-missing", "$.completeness")
            : sourceObligationRejectionMessage(
                _label === "duplicate"
                  ? "duplicate-key"
                  : _label === "number"
                    ? "unsafe-number"
                    : "malformed-json",
                "$response",
              )
          : `Technical ${correction ? "correction" : "review"} response rejected: ${suffix}`;
        expect(execution).toMatchObject({
          status: "failed",
          error: { message, retryable: expectedRetryable },
          evidence: {
            attempts: expectedRetryable
              ? [
                  {
                    outcome: "malformed-response",
                    retryable: true,
                    retryScheduled: true,
                  },
                  {
                    outcome: "malformed-response",
                    retryable: true,
                    retryScheduled: true,
                  },
                  {
                    outcome: "malformed-response",
                    retryable: true,
                    retryScheduled: false,
                  },
                ]
              : [{ outcome: "malformed-response", retryable: false, retryScheduled: false }],
          },
        });
        expect(
          execution.evidence.attempts.at(-1)?.turns?.find((turn) => turn.decision !== "stop")
            ?.rawStopReason,
        ).toBe("stop");
        expect(fetch).toHaveBeenCalledTimes(expectedRetryable ? 3 : 1);
        expect(onText).not.toHaveBeenCalled();
        const stateDirectory = await mkdtemp(resolve(tmpdir(), "docsfab-diagnostic-replay-"));
        temporaryDirectories.push(stateDirectory);
        const recordPath = resolve(stateDirectory, "diagnostic-run.json");
        const saved = {
          schemaVersion: 2,
          id: "diagnostic-run",
          workflow: "review-documentation",
          repository: {
            sourcePath: repositoryPath,
            requestedRevision: "HEAD",
            revision: "a".repeat(40),
          },
          workspace: { strategy: "tracked-export", disposable: true },
          status: "failed",
          createdAt: "2026-09-16T12:00:00.000Z",
          models: [],
          skills: [],
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0 },
          tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
          error: message,
          steps: [
            {
              id: input.step.id,
              title: "Technical verification",
              skill: "verify-technical-accuracy",
              mode: "read-only",
              status: "failed",
              error: message,
              inference: execution.evidence,
            },
          ],
        };
        await writeFile(recordPath, JSON.stringify(saved), { mode: 0o600 });
        const beforeRecord = await readFile(recordPath);
        for (const json of [false, true]) {
          const lines: string[] = [];
          const log = vi.spyOn(console, "log").mockImplementation((value) => {
            lines.push(String(value));
          });
          try {
            await handleRunsCommand([
              "show",
              saved.id,
              "--state-dir",
              stateDirectory,
              ...(json ? ["--json"] : []),
            ]);
          } finally {
            log.mockRestore();
          }
          const output = lines.join("\n");
          if (inventory || !json || !expectedRetryable) expect(output).toContain(message);
          expect(output).toContain(
            inventory
              ? "Correct the inventory producer or response contract"
              : expectedRetryable
                ? "The bounded malformed-response correction policy ended"
                : "do not retry the same inference unchanged",
          );
          if (!inventory && !expectedRetryable) {
            expect(output).toContain("not admitted as evidence");
            expect(output).not.toContain("producer or response contract");
          }
          // Reply text appears only in the redacted excerpt, which drops the
          // home-directory path and the token.
          expect(output).not.toContain("/Users/alice/private.md");
          expect(output).not.toContain("glpat-xxxxxxxxxxxxxxxxxxxxxxxx");
          expect(json ? withoutExcerptMembers(output) : withoutExcerptLines(output)).not.toContain(
            "not-the-governed-envelope",
          );
        }
        expect(await readFile(recordPath)).toEqual(beforeRecord);
        expect(await readFile(resolve(repositoryPath, "README.md"))).toEqual(beforeSource);
        expect(await readFile(artifactPath, "utf8")).toBe("immutable artifact bytes");
        expect(fetch).toHaveBeenCalledTimes(expectedRetryable ? 3 : 1);
      }
    },
    testTimeoutMs(20_000),
  );

  /**
   * The retryability table decides each V3 correction refusal once. A shape,
   * accounting, or bound defect in the model's reply retries within the budget
   * and, when every attempt repeats it, reports the last rejection. An
   * authority refusal stops on the first attempt. These runs mark no attempt
   * final, so every retryable row ends as the last rejection rather than the
   * final-attempt floor (`pi-harness-final-attempt-floor.test.ts`).
   */
  it.each([
    ["invalid-shape", true],
    ["invalid-accounting", true],
    ["bounds-exceeded", true],
    ["source-authority", false],
  ] as const)(
    "retains V3 correction %s across the real adapter and runner (retried: %s)",
    async (code, retried) => {
      const repositoryPath = await createRepository();
      const deriveInput = reviewSourcePhaseInput(repositoryPath, "derive-source-obligations");
      const sourceProposal: SourceObligationLedgerProposalV1 = {
        completeness: "bounded-not-proven",
        dimensions: TECHNICAL_FACT_DIMENSIONS.map((dimension, index) => ({
          dimension,
          status: "not-applicable",
          reason: `No ${dimension} obligation in this bounded fixture.`,
          sourceLocators: [
            code === "source-authority" && index === 0 ? "src/outside.ts:1" : "README.md:1",
          ],
          obligations: [],
        })),
        limitations: [],
      };
      const scopeSha256 = sourceObligationScopeSha256(deriveInput);
      const sealed = sealOriginalSourceAuthority({
        runId: deriveInput.runId!,
        scope: "review-tracked-workspace",
        repositoryRevision: deriveInput.evidenceIdentity!.repositoryRevision,
        scopeSha256,
        workspaceSnapshotSha256: deriveInput.searchEvidence!.workspaceSnapshotSha256,
        members: ["README.md", "src/cli.ts"].map((path) => ({
          path,
          mode: 0o644,
          byteLength: 10,
          sourceSha256: "f".repeat(64),
        })),
      });
      const ledger = bindSourceObligationLedgerV2(
        sourceProposal,
        deriveInput,
        [{ path: "README.md", sha256: "f".repeat(64) }],
        sealed.evidence,
      );
      const admission = issueOriginalSourceAuthorityAdmission({
        capture: sealed.capture,
        observer: {
          observe: async (paths) => paths.map((path) => ({ path, sha256: "f".repeat(64) })),
        },
        runId: deriveInput.runId!,
        repositoryRevision: deriveInput.evidenceIdentity!.repositoryRevision,
        scopeSha256,
        workspaceSnapshotSha256: deriveInput.searchEvidence!.workspaceSnapshotSha256,
      });
      const response: {
        verdict: "pass" | "human-review" | "needs-revision";
        coverage: typeof responses.technical.coverage;
        issueJudgments: Array<{
          id: string;
          severity: typeof issue.severity;
          category: typeof issue.category;
          location: string;
          obligationIds: string[];
        }>;
        obligationJudgments: unknown[];
        schemaVersion?: number;
      } = {
        verdict: responses.technical.review.verdict,
        coverage: responses.technical.coverage,
        issueJudgments: [
          {
            id: issue.id,
            severity: issue.severity,
            category: issue.category,
            location: code === "target-authority" ? "docs/unapproved.md:1" : issue.location,
            obligationIds: [],
          },
        ],
        obligationJudgments: code === "invalid-accounting" ? [{}] : [],
      };
      if (code === "invalid-shape") {
        delete (response as { obligationJudgments?: unknown[] }).obligationJudgments;
      }
      if (code === "bounds-exceeded") {
        response.issueJudgments = Array.from({ length: 257 }, (_, index) => ({
          ...response.issueJudgments[0]!,
          id: `TECH-${String(index + 1).padStart(3, "0")}`,
        }));
      }
      if (code === "source-authority") {
        response.verdict = "human-review";
        response.issueJudgments = [];
      }
      const maxRetries = 2;
      const attempts = retried ? maxRetries + 1 : 1;
      const fetch = vi.fn(
        scriptedProvider(
          Array.from({ length: attempts }, () => textTurn(JSON.stringify(response))),
        ),
      );
      vi.stubGlobal("fetch", fetch);
      const onText = vi.fn();
      const harness = await createAuditHarness();
      const execution = await executeInferenceStep({
        mode: "read-only",
        policy: {
          maxRetries,
          baseDelayMs: 0,
          maxDelayMs: 0,
          retryableCategories: ["malformed-response"],
        },
        execute: () =>
          harness.runStep({
            ...reviewSourcePhaseInput(repositoryPath, "verify-technical-accuracy"),
            runId: deriveInput.runId,
            sourceObligationLedger: ledger,
            originalSourceAuthorityAdmission: admission,
            onText,
          }),
      });
      const expectedMessage =
        code === "bounds-exceeded"
          ? "Technical correction response rejected: bounds-exceeded. technical-correction-max-issue-judgments-bound: 257 exceeds technicalCorrection.maxIssueJudgments = 256 count. Return fewer issue judgments, or lower technicalCorrection.maxIssueJudgments in config/limits/technicalCorrection.yaml. Follow the named remediation."
          : `Technical correction response rejected: ${code}.`;
      expect(execution).toMatchObject({
        status: "failed",
        error: { message: expectedMessage, retryable: retried },
        evidence: {
          attempts: Array.from({ length: attempts }, (_, index) => ({
            outcome: "malformed-response",
            retryable: retried,
            retryScheduled: index < attempts - 1,
            conditionRetryability: "eligible",
            retryDecision: !retried ? "declined" : index < attempts - 1 ? "retried" : "exhausted",
          })),
        },
      });
      expect(execution.evidence.attempts).toHaveLength(attempts);
      expect(fetch).toHaveBeenCalledTimes(attempts);
      expect(onText).not.toHaveBeenCalled();
      expect(await readFile(resolve(repositoryPath, "README.md"), "utf8")).toBe("# Fixture\n");
    },
  );

  /**
   * A V3 correction whose fact inventory fails the shared verification contract
   * keeps the provisional step classification. The fixture ledger has one
   * applicable obligation so a retained fact can link to a finding.
   */
  async function recoverableCorrectionFixture() {
    const repositoryPath = await createRepository();
    const deriveInput = reviewSourcePhaseInput(repositoryPath, "derive-source-obligations");
    const sourceProposal: SourceObligationLedgerProposalV1 = {
      completeness: "bounded-not-proven",
      dimensions: TECHNICAL_FACT_DIMENSIONS.map((dimension) =>
        dimension === "input-representations"
          ? {
              dimension,
              status: "applicable" as const,
              reason: "The fixture source establishes command input behavior.",
              sourceLocators: [],
              obligations: [
                {
                  id: "OBL-INPUT-1",
                  dimension,
                  sourceLocators: ["README.md:1"],
                  statement: "The fixture command accepts a structured input representation.",
                  evidenceClass: "source-observation" as const,
                  uncertainty: "The source was inspected but the command was not executed.",
                },
              ],
            }
          : {
              dimension,
              status: "not-applicable" as const,
              reason: `No ${dimension} obligation in this bounded fixture.`,
              sourceLocators: ["README.md:1"],
              obligations: [],
            },
      ),
      limitations: [],
    };
    const scopeSha256 = sourceObligationScopeSha256(deriveInput);
    const sealed = sealOriginalSourceAuthority({
      runId: deriveInput.runId!,
      scope: "review-tracked-workspace",
      repositoryRevision: deriveInput.evidenceIdentity!.repositoryRevision,
      scopeSha256,
      workspaceSnapshotSha256: deriveInput.searchEvidence!.workspaceSnapshotSha256,
      members: ["README.md", "src/cli.ts"].map((path) => ({
        path,
        mode: 0o644,
        byteLength: 10,
        sourceSha256: "f".repeat(64),
      })),
    });
    const ledger = bindSourceObligationLedgerV2(
      sourceProposal,
      deriveInput,
      [{ path: "README.md", sha256: "f".repeat(64) }],
      sealed.evidence,
    );
    const obligationId = ledger.dimensions.find(
      (dimension) => dimension.dimension === "input-representations",
    )!.obligations[0]!.id;
    const admission = issueOriginalSourceAuthorityAdmission({
      capture: sealed.capture,
      observer: {
        observe: async (paths) => paths.map((path) => ({ path, sha256: "f".repeat(64) })),
      },
      runId: deriveInput.runId!,
      repositoryRevision: deriveInput.evidenceIdentity!.repositoryRevision,
      scopeSha256,
      workspaceSnapshotSha256: deriveInput.searchEvidence!.workspaceSnapshotSha256,
    });
    // The issue judgment's obligationIds is the one link direction; the host
    // derives the retained fact's issueIds from it.
    const judgment = (linkedObligationIds: readonly string[] = [obligationId]) =>
      JSON.stringify({
        verdict: "needs-revision",
        coverage: responses.technical.coverage,
        // No linked obligation means no issue judgment: one that linked none
        // would be refused as judgment-links-no-open-fact first.
        issueJudgments:
          linkedObligationIds.length === 0
            ? []
            : [
                {
                  id: issue.id,
                  severity: issue.severity,
                  category: issue.category,
                  location: issue.location,
                  obligationIds: [...linkedObligationIds],
                },
              ],
        obligationJudgments: [
          {
            obligationId,
            disposition: "retained",
            documentationDisposition: "omitted",
          },
        ],
      });
    const onText = vi.fn();
    const correctionInput = {
      ...reviewSourcePhaseInput(repositoryPath, "verify-technical-accuracy"),
      runId: deriveInput.runId,
      sourceObligationLedger: ledger,
      originalSourceAuthorityAdmission: admission,
      onText,
    };
    const harness = await createAuditHarness();
    return {
      repositoryPath,
      onText,
      obligationId,
      // The retained fact is omitted from the page, but no issue judgment
      // links it, so the judgment fill refuses it as `judgment-fact-unlinked`.
      unlinked: judgment([]),
      // The finding links the provisional result's fact identity, which the
      // sealed ledger never issued as an obligation ID.
      mislinked: judgment(["FACT-1"]),
      corrected: judgment(),
      execute: (attempt: number, correction?: HarnessStepInput["responseCorrection"]) =>
        harness.runStep({
          ...correctionInput,
          inferenceAttempt: attempt,
          retriesConsumed: attempt - 1,
          responseCorrection: correction,
        }),
    };
  }

  const correctionRetryPolicy = (maxRetries: number) => ({
    maxRetries,
    baseDelayMs: 0,
    maxDelayMs: 0,
    retryableCategories: ["malformed-response" as const],
  });

  it("retries a V3 correction that leaves an open fact unlinked with host feedback", async () => {
    const fixture = await recoverableCorrectionFixture();
    const fetch = vi.fn(
      scriptedProvider([textTurn(fixture.unlinked), textTurn(fixture.corrected)]),
    );
    vi.stubGlobal("fetch", fetch);

    const execution = await executeInferenceStep({
      mode: "read-only",
      policy: correctionRetryPolicy(3),
      execute: fixture.execute,
    });

    expect(execution.status).toBe("succeeded");
    expect(execution.evidence.attempts).toMatchObject([
      {
        attempt: 1,
        outcome: "malformed-response",
        retryable: true,
        retryScheduled: true,
        conditionRetryability: "eligible",
        retryDecision: "retried",
        rejection: {
          code: "judgment-fact-unlinked",
          location: "$.issueJudgments[].obligationIds",
        },
      },
      { attempt: 2, outcome: "succeeded" },
    ]);
    expect(fetch).toHaveBeenCalledTimes(2);
    // The feedback is the host rule the rejection names, from the model-output
    // catalog, not the rejected response.
    const retryRequest = String(fetch.mock.calls[1]![1]?.body);
    expect(retryRequest).toContain("Host validation feedback for this bounded retry");
    expect(retryRequest).toContain(
      "The previous response failed host rule judgment-fact-unlinked at $.issueJudgments[].obligationIds.",
    );
    expect(retryRequest).toContain(
      "Link issues to facts only through issueJudgments[].obligationIds",
    );
    expect(String(fetch.mock.calls[0]![1]?.body)).not.toContain("Host validation feedback");
    if (execution.status !== "succeeded") throw new Error("expected an admitted correction");
    expect(execution.result.technicalCorrectionEvidence).toBeDefined();
    expect(execution.result.verificationResult?.review.issues.map((item) => item.id)).toEqual([
      issue.id,
    ]);
    expect(await readFile(resolve(fixture.repositoryPath, "README.md"), "utf8")).toBe(
      "# Fixture\n",
    );
  });

  it("retries a V3 correction that links an unissued obligation ID with that ID and the valid set", async () => {
    const fixture = await recoverableCorrectionFixture();
    const fetch = vi.fn(
      scriptedProvider([textTurn(fixture.mislinked), textTurn(fixture.corrected)]),
    );
    vi.stubGlobal("fetch", fetch);

    const execution = await executeInferenceStep({
      mode: "read-only",
      policy: correctionRetryPolicy(3),
      execute: fixture.execute,
    });

    expect(execution.status).toBe("succeeded");
    expect(execution.evidence.attempts).toMatchObject([
      {
        attempt: 1,
        outcome: "malformed-response",
        retryable: true,
        retryScheduled: true,
        retryDecision: "retried",
        rejection: {
          code: "fact-link-unknown-obligation",
          location: "$.issueJudgments[].obligationIds[]",
        },
      },
      { attempt: 2, outcome: "succeeded" },
    ]);
    // Decoded request text: every string the provider request carries.
    const requestText = (index: number): string => {
      const strings: string[] = [];
      const collect = (value: unknown): void => {
        if (typeof value === "string") strings.push(value);
        else if (value && typeof value === "object") Object.values(value).forEach(collect);
      };
      collect(JSON.parse(String(fetch.mock.calls[index]![1]?.body)));
      return strings.join("\n");
    };
    const validSet = `Host-issued obligation IDs in the sealed ledger: ${JSON.stringify([fixture.obligationId])}.`;
    expect(requestText(0)).toContain(validSet);
    expect(requestText(0)).not.toContain("Host validation feedback");
    const retryRequest = requestText(1);
    const feedback = retryRequest.slice(retryRequest.indexOf("Host validation feedback"));
    expect(feedback).toContain(
      'linked obligation IDs the host never issued in issueJudgments[].obligationIds: ["FACT-1"].',
    );
    expect(feedback).toContain(validSet);
    if (execution.status !== "succeeded") throw new Error("expected an admitted correction");
    expect(execution.result.technicalCorrectionEvidence).toBeDefined();
  });

  it("schedules an eligible recoverable correction retry exactly as provisional verification does", async () => {
    // The same recoverable fact-inventory defect gets the same attempt
    // disposition in both steps.
    const disposition = (attempt: InferenceAttemptEvidence) => ({
      outcome: attempt.outcome,
      conditionRetryability: attempt.conditionRetryability,
      retryable: attempt.retryable,
      retryScheduled: attempt.retryScheduled,
      retryDecision: attempt.retryDecision,
      rejection: attempt.rejection,
    });
    const provisionalRepository = await createRepository();
    const unlinkedTechnical = structuredClone(responses.technical);
    unlinkedTechnical.factInventory.dimensions[0]!.facts[0]!.issueIds = ["TECH-999"];
    vi.stubGlobal(
      "fetch",
      vi.fn(
        scriptedProvider([
          textTurn(JSON.stringify(unlinkedTechnical)),
          textTurn(JSON.stringify(responses.technical)),
        ]),
      ),
    );
    const provisionalHarness = await createAuditHarness();
    const provisional = await executeInferenceStep({
      mode: "read-only",
      policy: correctionRetryPolicy(3),
      execute: (attempt, correction) =>
        provisionalHarness.runStep({
          ...technicalStepInput(provisionalRepository),
          inferenceAttempt: attempt,
          retriesConsumed: attempt - 1,
          responseCorrection: correction,
        }),
    });

    const fixture = await recoverableCorrectionFixture();
    vi.stubGlobal(
      "fetch",
      vi.fn(scriptedProvider([textTurn(fixture.unlinked), textTurn(fixture.corrected)])),
    );
    const correction = await executeInferenceStep({
      mode: "read-only",
      policy: correctionRetryPolicy(3),
      execute: fixture.execute,
    });

    expect(provisional.status).toBe("succeeded");
    expect(correction.status).toBe("succeeded");
    const eligible = {
      outcome: "malformed-response",
      conditionRetryability: "eligible",
      retryable: true,
      retryScheduled: true,
      retryDecision: "retried",
    };
    expect(disposition(provisional.evidence.attempts[0]!)).toEqual({
      ...eligible,
      rejection: { code: "inventory-fact-finding-link", location: "$.factInventory" },
    });
    // The judgment reply states the link only on its issue judgments, so the
    // same missing link is named there, with the same disposition.
    expect(disposition(correction.evidence.attempts[0]!)).toEqual({
      ...eligible,
      rejection: {
        code: "judgment-fact-unlinked",
        location: "$.issueJudgments[].obligationIds",
      },
    });
  });

  it("reports the last V3 correction rejection code when the retry budget is exhausted", async () => {
    const fixture = await recoverableCorrectionFixture();
    const fetch = vi.fn(
      scriptedProvider([
        textTurn(fixture.unlinked),
        textTurn(fixture.unlinked),
        textTurn(fixture.unlinked),
      ]),
    );
    vi.stubGlobal("fetch", fetch);

    const execution = await executeInferenceStep({
      mode: "read-only",
      policy: correctionRetryPolicy(2),
      execute: fixture.execute,
    });

    const unlinked = {
      code: "judgment-fact-unlinked",
      location: "$.issueJudgments[].obligationIds",
    };
    const rejected = { outcome: "malformed-response", retryable: true, rejection: unlinked };
    expect(execution).toMatchObject({
      status: "failed",
      error: {
        message: "Technical correction response rejected: invalid-fact-link.",
        retryable: true,
        rejection: unlinked,
      },
      evidence: {
        configuredMaxRetries: 2,
        effectiveMaxRetries: 2,
        attempts: [
          { ...rejected, attempt: 1, retryScheduled: true, retryDecision: "retried" },
          { ...rejected, attempt: 2, retryScheduled: true, retryDecision: "retried" },
          { ...rejected, attempt: 3, retryScheduled: false, retryDecision: "exhausted" },
        ],
      },
    });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fixture.onText).not.toHaveBeenCalled();
  });

  describe("rejected reply diagnostics (#1178, #1180)", () => {
    // Synthetic values only; neither is, or resembles, a real credential.
    const SENTINEL_PROSE = "SENTINEL-1178 rejected reply prose that must stay unretained";
    const SYNTHETIC_SECRET = `nvapi-${"Q7w8E9r0".repeat(5)}`;

    function failedRecord(stepId: string, evidence: InferenceExecutionEvidence, error: Error) {
      return {
        error: error.message,
        steps: [{ id: stepId, status: "failed", error: error.message, inference: evidence }],
      } as unknown as RunRecord;
    }

    it("keeps the review path's inner schema rule and the reply shape, with reply text only in the excerpt", async () => {
      const repositoryPath = await createRepository();
      const rejected = structuredClone(responses.technical) as unknown as {
        review: { issues: Array<Record<string, unknown>> };
      };
      rejected.review.issues[0]!.severity = "severe";
      rejected.review.issues[0]!.finding = SENTINEL_PROSE;
      const onText = vi.fn();
      vi.stubGlobal("fetch", scriptedProvider([textTurn(JSON.stringify(rejected))]));
      const harness = await createReviewHarness(false);

      const execution = await executeInferenceStep({
        mode: "read-only",
        policy: correctionRetryPolicy(0),
        execute: () =>
          harness.runStep({
            ...reviewStepInput(repositoryPath, "verify-technical-accuracy"),
            onText,
          }),
      });

      if (execution.status !== "failed") throw new Error("expected a rejected review");
      expect(execution.error.message).toBe("Technical review response rejected: invalid-review.");
      const [attempt] = execution.evidence.attempts;
      expect(attempt).toMatchObject({
        outcome: "malformed-response",
        rejection: { code: "review-schema-enum", location: "$.review.issues[].severity" },
        rejectedReplyShape: {
          parse: { status: "parsed" },
          root: "object",
          topLevelKeys: ["coverage", "review", "factInventory"],
        },
      });
      const record = failedRecord("verify-technical-accuracy", execution.evidence, execution.error);
      const terminal = [
        ...formatRunFailureDiagnosticLines(record),
        ...formatRunRetryDispositionLines(record),
      ].join("\n");
      expect(terminal).toContain(
        "Rejected by review-schema-enum at $.review.issues[].severity; reply keys coverage, review, factInventory.",
      );
      // One rejection line per failed step: the `Rejected by` citation and the
      // reply shape share a line.
      expect(
        formatRunFailureDiagnosticLines(record).filter((line) => line.startsWith("Rejected by")),
      ).toHaveLength(1);
      for (const surface of [
        withoutExcerptMembers(JSON.stringify(execution.evidence)),
        withoutExcerptLines(terminal),
      ]) {
        expect(surface).not.toContain("SENTINEL");
      }
      expect(onText).not.toHaveBeenCalled();
    });

    it("keeps a configured credential out of a rejected reply's excerpt without a composition policy (#1807)", async () => {
      // A configured value that does not look like a credential: only the
      // exact match can find it, and nothing but the excerpt keeps reply text.
      const credential = configureCredential(["meadow", plantedCredentialValue(85, 22)].join("-"));
      const schemaRejected = structuredClone(responses.technical) as unknown as {
        review: { issues: Array<Record<string, unknown>> };
      };
      schemaRejected.review.issues[0]!.severity = "severe";
      schemaRejected.review.issues[0]!.finding = `The guide quotes ${credential} as an example.`;
      const malformed =
        `Let me reason first. The configuration sets ${credential} as its key. ` +
        '\n\nFinal answer:\n{"review":{"verdict":"pass","issues":[';
      for (const reply of [JSON.stringify(schemaRejected), malformed]) {
        const repositoryPath = await createRepository();
        vi.stubGlobal("fetch", scriptedProvider([textTurn(reply)]));
        const harness = await createReviewHarness(false);
        const execution = await executeInferenceStep({
          mode: "read-only",
          policy: correctionRetryPolicy(0),
          execute: () =>
            harness.runStep(reviewStepInput(repositoryPath, "verify-technical-accuracy")),
        });
        if (execution.status !== "failed") throw new Error("expected a rejected review");
        const excerpt = execution.evidence.attempts[0]?.rejectedReplyExcerpt;
        expect(excerpt?.redactions).toBeGreaterThan(0);
        const record = failedRecord(
          "verify-technical-accuracy",
          execution.evidence,
          execution.error,
        );
        expect(JSON.stringify(execution.evidence)).not.toContain(credential);
        expect(JSON.stringify(record)).not.toContain(credential);
      }
    });

    it("shows a reasoning-first reply's redacted excerpt and parse position in runs show (#1690)", async () => {
      const repositoryPath = await createRepository();
      // Synthetic credential shapes; neither is, or resembles, a real credential.
      const nvidiaKey = `nvapi-${"Zx4Y".repeat(6)}`;
      const githubToken = `ghp_${"Rk7Q".repeat(9)}`;
      // Reasoning prose before an answer cut off mid-object: with no closing
      // brace there is no envelope to open, so the parser stops at character 0.
      const reply =
        "Let me reason about the review before answering. The configuration example " +
        `sets api_key=${nvidiaKey} and mentions ${githubToken} in /Users/alice/notes.md. ` +
        "The verdict needs care. ".repeat(60) +
        '\n\nFinal answer:\n{"review":{"verdict":"pass","issues":[';
      vi.stubGlobal("fetch", scriptedProvider([textTurn(reply)]));
      const harness = await createReviewHarness(false);
      const execution = await executeInferenceStep({
        mode: "read-only",
        policy: correctionRetryPolicy(0),
        execute: () =>
          harness.runStep(reviewStepInput(repositoryPath, "verify-technical-accuracy")),
      });
      if (execution.status !== "failed") throw new Error("expected a rejected review");
      expect(execution.evidence.attempts[0]).toMatchObject({
        outcome: "malformed-response",
        rejectedReplyShape: { replyChars: reply.length, parse: { status: "failed", offset: 0 } },
        rejectedReplyExcerpt: {
          replyChars: reply.length,
          parseOffset: 0,
          omittedChars: reply.length - 1024,
          limit: "inference.rejectedReplyExcerptChars",
          bound: 512,
          redactions: 3,
        },
      });

      const stateDirectory = await mkdtemp(resolve(tmpdir(), "docsfab-reply-excerpt-"));
      temporaryDirectories.push(stateDirectory);
      const record = {
        schemaVersion: 2,
        id: "reply-excerpt-run",
        workflow: "review-documentation",
        repository: {
          sourcePath: repositoryPath,
          requestedRevision: "HEAD",
          revision: "a".repeat(40),
        },
        workspace: { strategy: "tracked-export", disposable: true },
        status: "failed",
        createdAt: "2026-09-30T12:00:00.000Z",
        models: [],
        skills: [],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0 },
        tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
        error: execution.error.message,
        steps: [
          {
            id: "verify-technical-accuracy",
            title: "Technical verification",
            skill: "verify-technical-accuracy",
            mode: "read-only",
            status: "failed",
            error: execution.error.message,
            inference: execution.evidence,
          },
        ],
      };
      await writeFile(resolve(stateDirectory, `${record.id}.json`), JSON.stringify(record), {
        mode: 0o600,
      });
      const show = async (json: boolean): Promise<string> => {
        const lines: string[] = [];
        const log = vi.spyOn(console, "log").mockImplementation((value) => {
          lines.push(String(value));
        });
        try {
          await handleRunsCommand([
            "show",
            record.id,
            "--state-dir",
            stateDirectory,
            ...(json ? ["--json"] : []),
          ]);
        } finally {
          log.mockRestore();
        }
        return lines.join("\n");
      };

      const text = await show(false);
      expect(text).toContain(
        `reply not JSON (malformed-json unexpected-token at character 0 of ${reply.length})`,
      );
      expect(text).toContain(
        `Reply excerpt: 1024 of ${reply.length} characters retained; ` +
          `${reply.length - 1024} not retained past inference.rejectedReplyExcerptChars = 512 per segment; ` +
          "parse stopped at character 0 (in head); 3 spans redacted.",
      );
      const head = text.split("\n").find((line) => line.trimStart().startsWith("head 0-512: "));
      expect(head).toContain(
        '"Let me reason about the review before answering. The configuration example sets [REDACTED] and mentions [REDACTED] in [REDACTED] The verdict',
      );
      const tail = text
        .split("\n")
        .find((line) =>
          line.trimStart().startsWith(`tail ${reply.length - 512}-${reply.length}: `),
        );
      expect(tail).toContain(
        String.raw`\n\nFinal answer:\n{\"review\":{\"verdict\":\"pass\",\"issues\":["`,
      );

      const json = await show(true);
      const excerpt = (
        JSON.parse(json) as {
          retryDispositions: Array<{
            rejectedReplyExcerpt?: { segments: Array<{ text: string }> };
          }>;
        }
      ).retryDispositions[0]?.rejectedReplyExcerpt;
      expect(excerpt?.segments.map((segment) => segment.text.slice(0, 13))).toEqual([
        "Let me reason",
        ". The verdict",
      ]);
      for (const surface of [JSON.stringify(record), text, json]) {
        expect(surface).not.toContain(nvidiaKey);
        expect(surface).not.toContain("nvapi-");
        expect(surface).not.toContain(githubToken);
        expect(surface).not.toContain("/Users/alice");
      }
    });

    it("keeps a synthetic secret in a rejected reply out of the record and the terminal", async () => {
      const repositoryPath = await createRepository();
      const leaking = {
        ...structuredClone(responses.technical),
        review: { verdict: "needs-revision", issues: [{ ...issue, finding: SYNTHETIC_SECRET }] },
        [SYNTHETIC_SECRET]: SENTINEL_PROSE,
      };
      const onText = vi.fn();
      vi.stubGlobal("fetch", scriptedProvider([textTurn(JSON.stringify(leaking))]));
      const harness = await createReviewHarness(false);

      const execution = await executeInferenceStep({
        mode: "read-only",
        policy: correctionRetryPolicy(0),
        execute: () =>
          harness.runStep({
            ...reviewStepInput(repositoryPath, "verify-technical-accuracy"),
            onText,
          }),
      });

      if (execution.status !== "failed") throw new Error("expected a rejected review");
      const shape = execution.evidence.attempts[0]?.rejectedReplyShape;
      expect(shape).toMatchObject({ topLevelKeyCount: 4, undeclaredKeys: 1 });
      const record = failedRecord("verify-technical-accuracy", execution.evidence, execution.error);
      const terminal = [
        ...formatRunFailureDiagnosticLines(record),
        ...formatRunRetryDispositionLines(record),
      ].join("\n");
      expect(terminal).toContain("reply keys coverage, review, factInventory (+1 undeclared)");
      expect(execution.evidence.attempts[0]?.rejectedReplyExcerpt?.redactions).toBeGreaterThan(0);
      for (const surface of [JSON.stringify(execution.evidence), terminal]) {
        expect(surface).not.toContain(SYNTHETIC_SECRET);
        expect(surface).not.toContain("nvapi-");
      }
      for (const surface of [
        withoutExcerptMembers(JSON.stringify(execution.evidence)),
        withoutExcerptLines(terminal),
      ]) {
        expect(surface).not.toContain("SENTINEL");
      }
      expect(onText).not.toHaveBeenCalled();
    });

    it.skipIf(localWorkflowsReport.skip)(
      localWorkflowsReport.title(
        "never prints identifier-shaped undeclared reply keys outside the private reply excerpt",
      ),
      async () => {
        // Synthetic, identifier-shaped keys a model could use to carry content:
        // a 40-character hex digest, a 32-character base62 token, and prose.
        const privateKeys = [
          "a123456789abcdef0123456789abcdef01234567",
          "Q9vX2mLp7RtK4wZs8NbY3cHd6FgJ1eUa",
          "the_customer_password_is_Tr0ub4dor3",
        ];
        // String array members (identifier-shaped, including the declared key
        // `review`, prose, and credential-shaped), flat, nested, and inside arrays
        // of objects. None may reach any surface.
        const arrayMembers = [
          "customer_password_Tr0ub4dor3",
          "SyntheticPrivateNote",
          "DeepNote_1178",
          "SENTINEL-1178 array member prose",
          `ghp_${"Aa11".repeat(9)}`,
        ];
        const repositoryPath = await createRepository();
        const technical = structuredClone(responses.technical) as unknown as {
          coverage: Array<Record<string, unknown>>;
          factInventory: Record<string, unknown> & {
            dimensions: Array<{ facts: Array<Record<string, unknown>> }>;
          };
        };
        technical.coverage[0]!.evidence = [arrayMembers[0], "review", arrayMembers[3]];
        technical.factInventory.limitations = [
          [arrayMembers[2], ["review", arrayMembers[3]]],
          arrayMembers[4],
        ];
        technical.factInventory.dimensions[0]!.facts[0]!.issueIds = [
          arrayMembers[1],
          arrayMembers[4],
        ];
        const leaking = {
          ...technical,
          ...Object.fromEntries(privateKeys.map((key) => [key, 1])),
        };
        vi.stubGlobal("fetch", scriptedProvider([textTurn(JSON.stringify(leaking))]));
        const harness = await createReviewHarness(false);
        const execution = await executeInferenceStep({
          mode: "read-only",
          policy: correctionRetryPolicy(0),
          execute: () =>
            harness.runStep(reviewStepInput(repositoryPath, "verify-technical-accuracy")),
        });
        if (execution.status !== "failed") throw new Error("expected a rejected review");
        const recordedPaths = (execution.evidence.attempts[0]?.rejectedReplyShape?.paths ?? []).map(
          (entry) => entry.path,
        );
        expect(recordedPaths).toContain("$.factInventory.limitations[][][]");
        expect(recordedPaths.filter((path) => path.includes(".review"))).toEqual(
          recordedPaths.filter((path) => path.startsWith("$.review")),
        );
        expect(execution.evidence.attempts[0]?.rejectedReplyShape).toMatchObject({
          topLevelKeys: ["coverage", "review", "factInventory"],
          topLevelKeyCount: 6,
          undeclaredKeys: 3,
        });

        const stateDirectory = await mkdtemp(resolve(tmpdir(), "docsfab-private-keys-"));
        temporaryDirectories.push(stateDirectory);
        const record = {
          schemaVersion: 2,
          id: "private-keys-run",
          workflow: "review-documentation",
          repository: {
            sourcePath: repositoryPath,
            requestedRevision: "HEAD",
            revision: "a".repeat(40),
          },
          workspace: { strategy: "tracked-export", disposable: true },
          status: "failed",
          createdAt: "2026-09-23T12:00:00.000Z",
          models: [],
          skills: [],
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0 },
          tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
          error: execution.error.message,
          steps: [
            {
              id: "verify-technical-accuracy",
              title: "Technical verification",
              skill: "verify-technical-accuracy",
              mode: "read-only",
              status: "failed",
              error: execution.error.message,
              inference: execution.evidence,
            },
          ],
        };
        await writeFile(resolve(stateDirectory, `${record.id}.json`), JSON.stringify(record), {
          mode: 0o600,
        });
        // The excerpt keeps reply text in the private record and on `runs show`;
        // the footer and the shareable report surfaces never carry it.
        const surfaces: Record<string, string> = {
          record: withoutExcerptMembers(JSON.stringify(record)),
          footer: formatRunFailureDiagnosticLines(record as unknown as RunRecord).join("\n"),
        };
        for (const json of [false, true]) {
          const lines: string[] = [];
          const log = vi.spyOn(console, "log").mockImplementation((value) => {
            lines.push(String(value));
          });
          try {
            await handleRunsCommand([
              "show",
              record.id,
              "--state-dir",
              stateDirectory,
              ...(json ? ["--json"] : []),
            ]);
          } finally {
            log.mockRestore();
          }
          surfaces[json ? "runsShowJson" : "runsShow"] = json
            ? withoutExcerptMembers(lines.join("\n"))
            : withoutExcerptLines(lines.join("\n"));
        }
        // The local-workflows report is JavaScript without declarations.
        const { buildBatch, renderJUnitXml, renderReportMarkdown, stepRejectionOf } = await import(
          // @ts-expect-error -- untyped benchmarks module
          "../../../benchmarks/local-workflows/lib/report.mjs"
        );
        const batch = buildBatch(
          [
            {
              key: "review-cli",
              name: "review",
              outcome: "fail",
              durationMs: 1,
              steps: record.steps.map((step) => ({
                id: step.id,
                status: step.status,
                detail: step.error,
                rejection: stepRejectionOf(step),
              })),
            },
          ],
          { generatedAt: "2026-09-23T00:00:00.000Z" },
        );
        surfaces.reportJson = JSON.stringify(batch);
        surfaces.reportMarkdown = renderReportMarkdown(batch);
        surfaces.junit = renderJUnitXml(batch);

        expect(surfaces.footer).toContain(
          "reply keys coverage, review, factInventory (+3 undeclared)",
        );
        expect(surfaces.runsShow).toContain("(+3 undeclared)");
        expect(surfaces.reportMarkdown).toContain("(+3 undeclared)");
        for (const [name, surface] of Object.entries(surfaces)) {
          for (const key of privateKeys) {
            expect(surface, `${name} must not name ${key}`).not.toContain(key);
          }
          expect(surface, name).not.toContain("Tr0ub4dor3");
          for (const member of arrayMembers) {
            expect(surface, `${name} must not name array member ${member}`).not.toContain(member);
          }
        }
      },
    );

    it("accepts a judgment with undeclared row keys and records only their counts", async () => {
      const hexKey = "a123456789abcdef0123456789abcdef01234567";
      const fixture = await recoverableCorrectionFixture();
      const extra = JSON.parse(fixture.corrected) as {
        issueJudgments: Array<Record<string, unknown>>;
        obligationJudgments: Array<Record<string, unknown>>;
      };
      // A ledger echo the prompt invites, a key another contract declares,
      // and a model-chosen identifier.
      extra.obligationJudgments[0]!.locators = ["README.md:1"];
      extra.issueJudgments[0]!.sourceLocators = ["README.md:1"];
      extra.issueJudgments[0]![hexKey] = 1;
      vi.stubGlobal("fetch", scriptedProvider([textTurn(JSON.stringify(extra))]));

      const execution = await executeInferenceStep({
        mode: "read-only",
        policy: correctionRetryPolicy(3),
        execute: fixture.execute,
      });

      expect(execution.status).toBe("succeeded");
      expect(execution.evidence.attempts).toHaveLength(1);
      expect(execution.evidence.attempts[0]!.judgmentRowKeyAudit).toEqual({
        schemaVersion: 1,
        issueJudgments: { rows: 1, undeclaredKeys: 2, namedUndeclaredKeys: ["sourceLocators"] },
        obligationJudgments: { rows: 1, undeclaredKeys: 1, namedUndeclaredKeys: [] },
        replacements: { rows: 0, undeclaredKeys: 0, namedUndeclaredKeys: [] },
      });
      expect(JSON.stringify(execution.evidence)).not.toContain(hexKey);
    });

    it("names the correction path's inner fact-link rule and location in the record and terminal", async () => {
      const fixture = await recoverableCorrectionFixture();
      const unknownObligation = JSON.parse(fixture.corrected) as {
        issueJudgments: Array<{ obligationIds: string[] }>;
      };
      unknownObligation.issueJudgments[0]!.obligationIds = ["OBL-NOT-IN-LEDGER"];
      vi.stubGlobal("fetch", scriptedProvider([textTurn(JSON.stringify(unknownObligation))]));

      // This rejection is retryable; a zero-retry policy isolates the one
      // attempt whose record and terminal line this test reads.
      const execution = await executeInferenceStep({
        mode: "read-only",
        policy: correctionRetryPolicy(0),
        execute: fixture.execute,
      });

      if (execution.status !== "failed") throw new Error("expected a rejected correction");
      expect(execution.error.message).toContain(
        "Technical correction response rejected: invalid-fact-link.",
      );
      expect(execution.evidence.attempts).toHaveLength(1);
      expect(execution.evidence.attempts[0]).toMatchObject({
        outcome: "malformed-response",
        retryScheduled: false,
        rejection: {
          code: "fact-link-unknown-obligation",
          location: "$.issueJudgments[].obligationIds[]",
        },
        rejectedReplyShape: { root: "object", parse: { status: "parsed" } },
      });
      const terminal = formatRunFailureDiagnosticLines(
        failedRecord("verify-technical-accuracy", execution.evidence, execution.error),
      );
      expect(terminal.join("\n")).toContain(
        "Technical correction response rejected: invalid-fact-link.",
      );
      expect(terminal.join("\n")).toContain(
        "Rejected by fact-link-unknown-obligation at $.issueJudgments[].obligationIds[]",
      );
    });
  });

  it("retries a canonical correction outside its envelope as invalid-shape and emits no text", async () => {
    const repositoryPath = await createRepository();
    const proposal: SourceObligationLedgerProposalV1 = {
      completeness: "bounded-not-proven",
      dimensions: TECHNICAL_FACT_DIMENSIONS.map((dimension) => ({
        dimension,
        status: "not-applicable",
        reason: `The focused source establishes no ${dimension} obligation.`,
        sourceLocators: ["README.md:1"],
        obligations: [],
      })),
      limitations: [],
    };
    const deriveInput = reviewSourcePhaseInput(repositoryPath, "derive-source-obligations");
    const ledger = bindSourceObligationLedger(proposal, deriveInput, [
      { path: "README.md", sha256: "f".repeat(64) },
    ]);
    const onText = vi.fn();
    vi.stubGlobal("fetch", scriptedProvider([textTurn(JSON.stringify(responses.technical))]));

    const error = await captureInferenceFailure(await createAuditHarness(), {
      ...reviewSourcePhaseInput(repositoryPath, "verify-technical-accuracy"),
      sourceObligationLedger: ledger,
      onText,
    });

    // A verification result without the correction envelope breaks the
    // declared key set, which the model can repair.
    expect(error).toMatchObject({
      message: "Technical correction response rejected: invalid-shape.",
      category: "malformed-response",
      retryable: true,
    });
    expect(error.evidence?.turns).toHaveLength(1);
    expect(onText).not.toHaveBeenCalled();
  });

  it.each([
    [
      "credential-bearing technical",
      "verify-technical-accuracy",
      JSON.stringify({
        ...responses.technical,
        review: {
          verdict: "needs-revision",
          issues: [
            {
              ...issue,
              finding: "Found ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD in the example.",
            },
          ],
        },
      }),
      false,
    ],
    [
      "credential-bearing editorial",
      "review-documentation",
      JSON.stringify({
        verdict: "needs-revision",
        issues: [
          {
            ...issue,
            finding: "Found ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD in the example.",
          },
        ],
      }),
      false,
    ],
    [
      // The fence is unwrapped, so the body carries the defect: a verdict that
      // disagrees with its issues is refused by the contract, not the parser.
      "fenced composition technical",
      "verify-technical-accuracy",
      `\`\`\`json\n${JSON.stringify({ ...responses.technical, review: { verdict: "approve", issues: [issue] } })}\n\`\`\``,
      true,
    ],
  ] as const)(
    "emits no text for rejected %s output",
    async (_name, skill, response, withComposition) => {
      const repositoryPath = await createRepository();
      const onText = vi.fn();
      vi.stubGlobal("fetch", scriptedProvider([textTurn(response)]));

      const error = await captureInferenceFailure(await createReviewHarness(withComposition), {
        ...reviewStepInput(repositoryPath, skill),
        onText,
      });

      expect(error.category).toBe("malformed-response");
      expect(onText).not.toHaveBeenCalled();
    },
  );

  it("preserves ordinary non-review streaming callbacks", async () => {
    const repositoryPath = await createRepository();
    const onText = vi.fn();
    vi.stubGlobal("fetch", scriptedProvider([textTurn("The documentation audit is complete.")]));

    const result = await (await createAuditHarness()).runStep({
      ...stepInput(repositoryPath),
      onText,
    });

    expect(result.summary).toBe("The documentation audit is complete.");
    expect(onText).toHaveBeenCalledWith("The documentation audit is complete.");
  });

  it("delays composition output and emits only the admitted terminal text", async () => {
    const repositoryPath = await createRepository();
    const onText = vi.fn();
    vi.stubGlobal(
      "fetch",
      scriptedProvider([
        narratedToolTurn("I will inspect the bounded repository.", [
          { id: "composition-ls-1", name: "ls", arguments: { path: "." } },
        ]),
        textTurn("The documentation audit is complete."),
      ]),
    );

    const result = await (await createReviewHarness(true)).runStep({
      ...stepInput(repositoryPath),
      onText,
    });

    expect(result.summary).toBe("The documentation audit is complete.");
    expect(onText).toHaveBeenCalledOnce();
    expect(onText).toHaveBeenCalledWith("The documentation audit is complete.");
    expect(result.executionLease).toMatchObject({
      providerTurns: 2,
      toolCalls: { requested: 1, executed: 1, succeeded: 1, failed: 0 },
    });
  });
});
