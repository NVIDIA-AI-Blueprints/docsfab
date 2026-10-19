// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalWorkflowApplicationServices } from "../../src/application/dependencies.js";
import { WorkflowRunner } from "../../src/workflow-execution/runner.js";
import { getWorkflow } from "../../src/workflow-registry/catalog.js";
import { prepareRepositoryWorkspace } from "../../src/repository/workspace/materialize.js";
import { GitPatchEvidenceCollector } from "../../src/repository/evidence.js";
import {
  sealDocumentationPlanBinding,
  documentationPlanPagePaths,
} from "../../src/workflow-execution/plan-binding.js";
import {
  requiresSourceObligationLedger,
  requiresTechnicalCorrection,
  bindHostOwnedTechnicalCorrectionProposalV3,
  TECHNICAL_CORRECTION_PROPOSAL_KIND,
} from "../../src/workflow-execution/source-obligation.js";
import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../../src/json-evidence.js";
import { canonicalDigest } from "../../src/content-ir/canonical.js";
import type {
  HarnessStepInput,
  HarnessStepResult,
  InferenceRetryPolicy,
  AgentHarness,
} from "../../src/execution/contracts.js";
import { initFixtureRepo } from "../helpers/git.js";
import {
  sourceObligationProposalFixture,
  verificationResultFixture,
} from "../helpers/verification.js";
import { authoringFixtureCandidate } from "./authoring-quality-fixture.js";
import { readyContextPreflight, validModelConfig } from "../helpers.js";
import { createModelEvidence } from "../../src/model/profile-evidence.js";
import { governProviderTurn } from "../../src/model/turn-governor.js";
const runtimeRoot = fileURLToPath(new URL("../..", import.meta.url));
/** Real constructor, runner, immutable captures, patch collector and quality validators; scripted model replies only. */
export async function runAuthoringQualityProducerFixture(
  root: string,
  options: {
    quotedDecline?: boolean;
    branch?: "retain" | "revise";
    declineQuality?: boolean;
    /** Real factory context and deterministic governed-turn telemetry for saved delivery. */
    deliveryReady?: boolean;
    retryPolicy?: InferenceRetryPolicy;
    runStep?: (input: HarnessStepInput, result: HarnessStepResult) => Promise<HarnessStepResult>;
  } = {},
) {
  const target = "docs/cli-reference.md",
    sourcePath = "src/main.ts",
    source = join(root, "source");
  await initFixtureRepo(source, {
    "README.md": "# Fixture\n\nFixture source is src/main.ts.\n",
    [sourcePath]:
      "export const greeting = 'hello';\nif (process.argv[2] === 'hello') process.stdout.write(greeting + '\\n');\n",
  });
  const workspace = await prepareRepositoryWorkspace(source, "HEAD");
  const collector = await GitPatchEvidenceCollector.create(workspace.path, join(root, "patches"));
  const workflow = getWorkflow("create-documentation");
  const plan = sealDocumentationPlanBinding(
    {
      mode: "create",
      pages: [{ path: target, disposition: "create" }],
      sourceBindings: [{ pagePath: target, sources: [`${sourcePath}:1`] }],
    },
    { expectedMode: "create" },
  );
  let selectedProfile: Readonly<Record<string, unknown>> | undefined;
  const harness: AgentHarness = {
    runStep: async (input: HarnessStepInput) => {
      const skill = { id: input.step.skill, contentSha256: "f".repeat(64) };
      if (input.step.id === "plan-documentation")
        return {
          summary: "Create the single requested reference page.",
          planBinding: plan,
          planResponseSha256: canonicalDigest(plan),
          skill,
        };
      if (requiresSourceObligationLedger(input)) {
        const proposal = sourceObligationProposalFixture(`${sourcePath}:1`);
        return {
          summary: canonicalizeJsonEvidence(proposal as unknown as JsonEvidenceValue).trimEnd(),
          sourceObligationProposal: proposal,
          skill,
        };
      }
      if (input.step.id === "write-documentation") {
        await mkdir(join(input.repositoryPath, "docs"), { recursive: true });
        await writeFile(
          join(input.repositoryPath, target),
          options.branch === "revise"
            ? "# CLI reference\n\nThe hello command is available.\n"
            : "# CLI reference\n\nThe hello command prints a greeting.\n",
        );
        return { summary: "Created the requested reference page.", skill };
      }
      if (input.step.id === "revise-documentation") {
        await writeFile(
          join(input.repositoryPath, target),
          "# CLI reference\n\nThe hello command prints hello to stdout.\n",
        );
        const issueAccounting = input.authoringRevisionInput!.actionableFacts.flatMap((fact) =>
          fact.issueIds.map((issueId) => ({
            issueId,
            disposition: "applied" as const,
            reason: "The command source explicitly writes this greeting to stdout.",
            sourceLocators: [...fact.sourceLocators],
          })),
        );
        const accounting = { issueAccounting, changedPaths: [target], unresolvedFacts: [] };
        return {
          summary: canonicalizeJsonEvidence(accounting as unknown as JsonEvidenceValue).trimEnd(),
          authoringRevisionAccounting: accounting,
          skill,
        };
      }
      if (input.step.skill === "verify-technical-accuracy") {
        const result = verificationResultFixture([target], `${sourcePath}:1-2`);
        const needsRevision = options.branch === "revise" && !input.step.id.includes("revised");
        if (needsRevision) {
          result.review = {
            verdict: "needs-revision",
            issues: [
              {
                id: "TECH-001",
                severity: "major",
                category: "technical_accuracy",
                location: target,
                finding: "The documented command omits its observable output.",
                evidence: { source_id: "source", locator: `${sourcePath}:1-2` },
                required_change: "Document that the hello command prints hello.",
              },
            ],
          };
          const fact = result.factInventory.dimensions[0]!.facts[0]!;
          fact.statement = "The hello command writes the exported hello greeting to stdout.";
          fact.documentationDisposition = "omitted";
          fact.issueIds = ["TECH-001"];
        }
        if (requiresTechnicalCorrection(input)) {
          const ledger = input.sourceObligationLedger;
          if (ledger?.schemaVersion !== 2)
            throw new Error("The CREATE V3 fixture requires the admitted V2 source ledger.");
          const correction = await bindHostOwnedTechnicalCorrectionProposalV3(
            {
              kind: TECHNICAL_CORRECTION_PROPOSAL_KIND,
              schemaVersion: 3,
              verdict: result.review.verdict,
              coverage: result.coverage,
              factInventory: result.factInventory,
              issueJudgments: needsRevision
                ? [
                    {
                      id: "TECH-001",
                      severity: "major",
                      category: "technical_accuracy",
                      location: target,
                      factIds: [result.factInventory.dimensions[0]!.facts[0]!.id],
                    },
                  ]
                : [],
              obligationAccounting: [],
            },
            ledger,
            input.originalSourceAuthorityAdmission!,
            input.runId!,
            [target],
          );
          return {
            summary: canonicalizeJsonEvidence(
              correction.verificationResult as unknown as JsonEvidenceValue,
            ).trimEnd(),
            verificationResult: correction.verificationResult,
            technicalCorrectionEvidence: correction.evidence,
            skill,
          };
        }
        return {
          summary: canonicalizeJsonEvidence(result as unknown as JsonEvidenceValue).trimEnd(),
          verificationResult: result,
          skill,
        };
      }
      if (input.step.skill === "review-documentation")
        return {
          summary: canonicalizeJsonEvidence({ verdict: "pass", issues: [] }).trimEnd(),
          skill,
        };
      if (input.step.id === "evaluate-document-quality") {
        if (!selectedProfile)
          throw new Error("The runner did not prepare the final candidate's profile.");
        const candidate = authoringFixtureCandidate(selectedProfile, workspace.revision);
        candidate.selectionSha256 = input.qualityProfileSelection!.selectionSha256;
        if (options.quotedDecline)
          candidate.reportMarkdown = candidate.reportMarkdown.replace(
            "## Evidence gaps and limitations",
            "The phrase Host report decline: is quoted narrative, not a validation result.\n\n## Evidence gaps and limitations",
          );
        if (options.declineQuality)
          candidate.reportMarkdown +=
            "\n\n## Evidence gaps and limitations\n\n- Limitation: Second unavailable evidence.";
        return { summary: candidate.reportMarkdown, qualityArtifactCandidate: candidate, skill };
      }
      return { summary: `Completed ${input.step.id}.`, skill };
    },
  };
  const deliveryHarness: AgentHarness = {
    runStep: async (input) => {
      const result = await harness.runStep(input);
      const profile = validModelConfig.profile;
      const governed = governProviderTurn({
        context: { messages: [{ role: "user", content: "Perform the fixture authoring step." }] },
        policy: {
          budget: {
            configuredContextWindow: profile.configuredLimits.contextWindow,
            effectiveContextWindow: profile.contextWindow,
            configuredMaxInputTokens: profile.configuredLimits.maxInputTokens,
            effectiveMaxInputTokens: profile.maxInputTokens,
            configuredMaxOutputTokens: profile.configuredLimits.maxOutputTokens,
            effectiveMaxOutputTokens: profile.maxOutputTokens,
            reservedTokens: validModelConfig.requestPolicy.reservedContextTokens,
            requiredMinimumOutputTokens: validModelConfig.requestPolicy.minimumOutputTokens,
          },
          maxProviderTurns: 1,
          maxToolCalls: 1,
          maxCompactions: 1,
          minRecentToolTurns: 1,
        },
        state: { providerTurns: 0, toolCalls: 0, toolResults: 0, compactions: 0 },
        evidenceIdentity: input.evidenceIdentity!,
        pinnedMessageCount: 0,
      });
      // Fixture turn telemetry, not an external provider invocation.
      return {
        ...result,
        model: createModelEvidence(validModelConfig),
        usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, total: 3, turns: 1 },
        tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
        turns: [governed.evidence],
      };
    },
  };
  const config = {
    projectRoot: runtimeRoot,
    ...(options.deliveryReady ? { model: validModelConfig } : {}),
    ...(options.retryPolicy ? { retryPolicy: options.retryPolicy } : {}),
    stateDirectory: join(root, "runs"),
    skillCrateDirectory: join(runtimeRoot, "skill-crate"),
    qualityDirectory: join(runtimeRoot, "quality"),
    qualityPackDirectory: join(runtimeRoot, "quality-pack"),
  };
  const hostOperations = {
    runStep: async () => ({
      summary: JSON.stringify({
        status: "unavailable",
        checks: [],
        limitations: ["No repository-native documentation check is declared."],
      }),
    }),
  };
  try {
    const assembled = await createLocalWorkflowApplicationServices({
      config,
      request: { workflow: "create-documentation" },
      workflow,
      workspace,
      repositoryEvidence: collector,
      baseHarness: {
        runStep: async (input: HarnessStepInput) => {
          const scripted = await (options.deliveryReady ? deliveryHarness : harness).runStep(input);
          return options.runStep ? options.runStep(input, scripted) : scripted;
        },
      },
      hostOperations,
    } as never);
    const prepare = assembled.services.prepareAuthoringQualityValidation!;
    assembled.services.prepareAuthoringQualityValidation = async (input) => {
      const prepared = await prepare(input);
      selectedProfile = prepared.selection.profile;
      return prepared;
    };
    const record = await new WorkflowRunner({
      ...assembled.services,
      ...(options.deliveryReady ? {} : { contextPreflight: readyContextPreflight }),
      id: () => "genuine-quality-create",
    }).run({
      workflow: "create-documentation",
      workspacePath: workspace.path,
      repository: {
        sourcePath: workspace.sourcePath,
        requestedRevision: workspace.requestedRevision,
        revision: workspace.revision,
      },
      allowWrite: true,
      instruction: `Create ${target} from ${sourcePath}. Keep the result local; do not commit, push, or open an MR.`,
    });
    return {
      record,
      stateDirectory: config.stateDirectory,
      sourcePath: source,
      workspacePath: workspace.path,
    };
  } finally {
    await collector.dispose();
    await workspace.dispose();
  }
}
