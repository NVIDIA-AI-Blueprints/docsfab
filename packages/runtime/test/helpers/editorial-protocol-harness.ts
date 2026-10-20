// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Deterministic editorial-protocol harness for update-documentation runs
 * through the real runner: the planner proposes one `docs/cli.md` candidate,
 * and each assessor accepts or rejects it. No model is called.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  AgentHarness,
  HarnessStepInput,
  HarnessStepResult,
} from "../../src/execution/contracts.js";
import type { ToolActivitySummary } from "../../src/records/contracts.js";
import { editorialAssessmentEvidenceRefsV1 } from "../../src/harness/pi.js";
import { admitEditorialPlannerProposalV1 } from "../../src/harness/reply-admission/planner.js";
import { createModelEvidence } from "../../src/model/profile-evidence.js";
import { governProviderTurn } from "../../src/model/turn-governor.js";
import { bindDocumentationPlanProposal } from "../../src/workflow-execution/plan-binding.js";
import { validModelConfig } from "../helpers.js";
import { verificationFixture, verificationResultFixture } from "./verification.js";
import { authoringFixtureCandidateForInput } from "../support/authoring-quality-fixture.js";

export class EditorialProtocolHarness implements AgentHarness {
  public readonly inputs: HarnessStepInput[] = [];

  public constructor(
    private readonly options: {
      candidate: "update" | "no-change" | "insufficient-evidence";
      impactSource: { uri: string; sha256: string };
      rejectedAssessmentStep?:
        | "verify-technical-accuracy"
        | "review-documentation"
        | "evaluate-document-quality";
      rejectedRecommendation?: "update" | "insufficient-evidence";
      /**
       * A core assessor that answers `not-applicable`, as an evaluator does
       * when no page changed.
       */
      notApplicableAssessmentStep?:
        | "verify-technical-accuracy"
        | "review-documentation"
        | "evaluate-document-quality";
      insufficientLimitation?: string;
      /** Limitations the evaluator's assessment proposal carries. */
      evaluatorLimitations?: string[];
      /** Limitations the technical verification and review proposals carry. */
      assessorLimitations?: Partial<
        Record<"verify-technical-accuracy" | "review-documentation", string[]>
      >;
      /** The evaluator's rationale, when a test needs it to repeat another step's. */
      evaluatorRationale?: string;
      /**
       * The audience step rejects the candidate for its missing protocol, as a
       * model that follows the step's "return insufficient-evidence" does.
       */
      audienceRejectsForMissingPrerequisites?: boolean;
      /**
       * Tool activity a step reports, such as calls made through the real
       * confined tools before the step's own write; its turn ledger counts the
       * same calls.
       */
      stepTools?: (input: HarnessStepInput) => Promise<ToolActivitySummary | undefined>;
      /**
       * The planned pages. By default the planner updates `docs/cli.md` for an
       * update candidate and keeps it unchanged otherwise.
       */
      plannerPages?: ReadonlyArray<{
        path: string;
        disposition: "update" | "retain" | "out-of-scope";
      }>;
      /**
       * Write every planned `update` page, appending a line to its current
       * bytes, instead of rewriting `docs/cli.md` alone.
       */
      writePlannedPages?: boolean;
      /**
       * Reply with the judgment a model returns (candidate, rationale, slot
       * ids) and host-fill it through the production planner reply admission,
       * as the Pi harness does, instead of a complete fixture proposal.
       */
      plannerJudgment?: boolean;
    },
  ) {}

  private plannedPages(): ReadonlyArray<{
    path: string;
    disposition: "update" | "retain" | "out-of-scope";
  }> {
    return (
      this.options.plannerPages ?? [
        {
          path: "docs/cli.md",
          disposition: this.options.candidate === "update" ? "update" : "retain",
        },
      ]
    );
  }

  public get stepIds(): string[] {
    return this.inputs.map((input) => input.step.id);
  }

  public async runStep(input: HarnessStepInput): Promise<HarnessStepResult> {
    const tools = (await this.options.stepTools?.(input)) ?? {
      totalCalls: 0,
      failedCalls: 0,
      byTool: [],
    };
    const result = await this.runEditorialStep(input);
    const qualityCandidate =
      input.workflow.name === "update-documentation" &&
      input.step.id === "evaluate-document-quality" &&
      input.qualityProfileSelection
        ? await authoringFixtureCandidateForInput(input)
        : undefined;
    const model = createModelEvidence(validModelConfig);
    const profile = validModelConfig.profile;
    const governed = governProviderTurn({
      context: { messages: [{ role: "user", content: "Perform the fixture editorial step." }] },
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
        maxToolCalls: Math.max(1, tools.totalCalls),
        maxCompactions: 1,
        minRecentToolTurns: 1,
      },
      state: {
        providerTurns: 0,
        toolCalls: tools.totalCalls,
        toolResults: tools.totalCalls,
        compactions: 0,
      },
      evidenceIdentity: input.evidenceIdentity!,
      pinnedMessageCount: 0,
    });
    // Deterministic harness telemetry exercises saved-record delivery admission;
    // it represents this fixture turn, not an external model invocation.
    return {
      ...result,
      ...(qualityCandidate
        ? { summary: qualityCandidate.reportMarkdown, qualityArtifactCandidate: qualityCandidate }
        : {}),
      model,
      usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, total: 3, turns: 1 },
      tools,
      turns: [governed.evidence],
    };
  }

  private async runEditorialStep(input: HarnessStepInput): Promise<HarnessStepResult> {
    this.inputs.push(input);
    if (input.step.id === "derive-source-obligations") {
      return verificationFixture(input);
    }
    const reference =
      input.step.id === "plan-documentation"
        ? input.editorialEvidenceRefs?.[0]
        : editorialAssessmentEvidenceRefsV1(input)[0];
    if (!reference) throw new Error("missing admitted reader evidence");
    if (input.step.id === "plan-documentation") {
      const update = this.options.candidate === "update";
      const insufficient = this.options.candidate === "insufficient-evidence";
      return {
        summary: update
          ? "The changed public option requires one documentation update."
          : insufficient
            ? "The comparison needed to determine reader impact is unavailable."
            : "The admitted comparison shows no reader-visible documentation change.",
        planBinding: bindDocumentationPlanProposal(
          {
            mode: "update",
            pages: this.plannedPages().map((page) => ({ ...page })),
            sourceBindings: this.plannedPages()
              .filter((page) => page.disposition === "update")
              .map((page) => ({ pagePath: page.path, sources: ["src/orbit.ts"] })),
          },
          { expectedMode: "update" },
        ),
        editorialDecisionProposal: this.options.plannerJudgment
          ? admitEditorialPlannerProposalV1(
              {
                candidate: this.options.candidate,
                rationale: update
                  ? "The admitted public source changed from --old to --new while the guide still says --old."
                  : insufficient
                    ? "The admitted evidence does not establish whether the reader-facing behavior changed."
                    : "The Orbit CLI page already documents --new, the option the change ships, so no kept page needs an edit.",
                slotIds: ["current-documentation", "request"],
              },
              input,
            )
          : {
              schemaVersion: 1,
              kind: "docsfab-editorial-decision-proposal",
              candidate: this.options.candidate,
              rationale: update
                ? "The admitted public source changed from --old to --new while the guide still says --old."
                : insufficient
                  ? "No admitted base/head or workspace comparison establishes the current reader impact."
                  : "The admitted source comparison preserves the documented public behavior.",
              evidenceRefs: [reference],
              limitations: insufficient
                ? [this.options.insufficientLimitation ?? "comparison-unavailable"]
                : [],
              impactBasis: {
                kind: update ? "public-behavior-change" : insufficient ? "unknown" : "none",
                rationale: update
                  ? "The public option source and current documentation disagree."
                  : insufficient
                    ? "The current source was observed, but no comparison was admitted."
                    : "The changed implementation preserves the current documented behavior.",
                evidence_refs: [this.options.impactSource],
              },
            },
      };
    }
    if (input.step.id === "write-documentation") {
      if (this.options.writePlannedPages) {
        const updated = this.plannedPages().filter((page) => page.disposition === "update");
        for (const page of updated) {
          const path = join(input.repositoryPath, page.path);
          await writeFile(
            path,
            `${await readFile(path, "utf8")}\nThe public option is now --new.\n`,
          );
        }
        return { summary: `Updated ${String(updated.length)} source-bound documentation pages.` };
      }
      await writeFile(
        join(input.repositoryPath, "docs/cli.md"),
        "# Orbit CLI\n\nThe public option is now --new.\n",
      );
      return { summary: "Updated the one source-bound documentation page." };
    }
    if (
      input.step.id === "test-audience-understanding" &&
      this.options.audienceRejectsForMissingPrerequisites
    ) {
      return {
        summary: "The audience prerequisites were not supplied, so no participant was tested.",
        editorialAssessmentProposal: {
          schemaVersion: 1,
          kind: "docsfab-editorial-assessment-proposal",
          assessment: "rejected",
          rationale:
            "No scenario corpus, oracle, or representative participant was supplied for this candidate.",
          evidenceRefs: [reference],
          limitations: ["evidence-limitation.missing-audience-prerequisites"],
          recommendation: {
            candidate: "insufficient-evidence",
            kind: "evidence-limitation",
            code: "evidence-limitation.missing-audience-prerequisites",
          },
        },
      };
    }
    if (input.step.id === "test-audience-understanding") {
      return {
        summary: "No authorized representative audience fixture was available.",
        editorialAssessmentProposal: {
          schemaVersion: 1,
          kind: "docsfab-editorial-assessment-proposal",
          assessment: "not-applicable",
          rationale:
            "The candidate was retained, but the run had no authorized representative audience fixture.",
          evidenceRefs: [reference],
          limitations: ["audience-check-unavailable"],
          recommendation: null,
        },
      };
    }
    if (
      input.step.id === "verify-technical-accuracy" ||
      input.step.id === "review-documentation" ||
      input.step.id === "evaluate-document-quality"
    ) {
      const rejected = this.options.rejectedAssessmentStep === input.step.id;
      const assessment = rejected
        ? "rejected"
        : this.options.notApplicableAssessmentStep === input.step.id
          ? "not-applicable"
          : "accepted";
      const rationale =
        input.step.id === "evaluate-document-quality" && this.options.evaluatorRationale
          ? this.options.evaluatorRationale
          : assessment === "rejected"
            ? `${input.step.id} found that the retained source does not support the no-change rationale.`
            : assessment === "not-applicable"
              ? `${input.step.id} found no changed page to assess; this does not convert the no-change candidate into a pass.`
              : `${input.step.id} independently inspected the retained source and candidate evidence.`;
      return {
        summary:
          input.step.id === "review-documentation"
            ? JSON.stringify({ verdict: "pass", issues: [] })
            : `${input.step.id} ${assessment} the source-bound candidate.`,
        ...(input.step.id === "verify-technical-accuracy"
          ? {
              verificationResult: verificationResultFixture(
                this.plannedPages()
                  .filter((page) => page.disposition !== "out-of-scope")
                  .map((page) => page.path),
              ),
            }
          : {}),
        editorialAssessmentProposal: {
          schemaVersion: 1,
          kind: "docsfab-editorial-assessment-proposal",
          assessment,
          rationale,
          evidenceRefs: [reference],
          limitations:
            input.step.id === "evaluate-document-quality"
              ? (this.options.evaluatorLimitations ?? [])
              : (this.options.assessorLimitations?.[input.step.id] ?? []),
          recommendation: rejected
            ? this.options.rejectedRecommendation === "update"
              ? {
                  candidate: "update",
                  kind: "product-gap",
                  code: "product-gap.public-option-documentation-mismatch",
                }
              : {
                  candidate: "insufficient-evidence",
                  kind: "evidence-limitation",
                  code: "evidence-limitation.independent-assessment-rejected",
                }
            : null,
        },
      };
    }
    return { summary: `${input.step.id} completed its deterministic check.` };
  }
}
