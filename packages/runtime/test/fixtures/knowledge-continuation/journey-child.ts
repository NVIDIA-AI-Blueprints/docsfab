// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { authoringFixtureCandidateForInput } from "../../support/authoring-quality-fixture.js";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { executeRunRequest } from "../../../src/cli/run-request.js";
import { parseRunArguments } from "../../../src/cli/run-arguments.js";
import { parseSetOptions } from "../../../src/cli/model-setting-options.js";
import { setCliModelSettings } from "../../../src/config/cli-model-settings.js";
import type { CliRunOptions } from "../../../src/cli/run/request.js";
import { scmDeliveryIdentityKey } from "../../../src/delivery/receipt.js";
import type { DocsFabConfig } from "../../../src/config/runtime-loader.js";
import type { AgentHarness, HarnessStepInput } from "../../../src/execution/contracts.js";
import { createModelEvidence } from "../../../src/model/profile-evidence.js";
import { canonicalDigest } from "../../../src/contract-kit/index.js";
import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../../../src/json-evidence.js";
import type { RequestIntentInterpreterPort } from "../../../src/request-intent/interpret.js";
import { createDocumentationPlanBinding } from "../../../src/workflow-execution/plan-binding.js";
import { validModelConfig, validModelEnvironment } from "../../helpers.js";
import { verificationFixture } from "../../helpers/verification.js";

const mode = process.argv[2];
const repositoryPath = process.env.DOCSFAB_FIXTURE_REPOSITORY!;
const stateDirectory = process.env.DOCSFAB_FIXTURE_STATE!;
const workflow = process.env.DOCSFAB_FIXTURE_WORKFLOW as
  | "create-documentation"
  | "update-documentation";
const targetPath = process.env.DOCSFAB_FIXTURE_TARGET!;
const targetPaths = (process.env.DOCSFAB_FIXTURE_TARGETS ?? targetPath)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const planPaths = process.env.DOCSFAB_FIXTURE_PLAN_TARGET
  ? [process.env.DOCSFAB_FIXTURE_PLAN_TARGET]
  : targetPaths;
const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const requestedStatement =
  process.env.DOCSFAB_FIXTURE_REQUESTED_STATEMENT ??
  "The fixture publishes one verified cafe\u0301 behavior page.";
const instruction =
  process.env.DOCSFAB_FIXTURE_INSTRUCTION ??
  `Write \`${targetPath}\` using only these repository-observed behavior claims:\n- ${requestedStatement}`;

const config: DocsFabConfig = {
  projectRoot: runtimeRoot,
  skillCrateDirectory: join(runtimeRoot, "skill-crate"),
  qualityDirectory: join(runtimeRoot, "quality"),
  qualityPackDirectory: join(runtimeRoot, "quality-pack"),
  stateDirectory,
  retryPolicy: {
    maxRetries: 0,
    baseDelayMs: 0,
    maxDelayMs: 0,
    retryableCategories: [],
  },
  model: validModelConfig,
};
// A preset selected with `--composition` for both the stop and the resume. Its
// steps run on the preset's route; the environment's model id overrides the
// preset's, as an operator's would.
const compositionId = process.env.DOCSFAB_FIXTURE_COMPOSITION;
const modelEvidence = createModelEvidence(
  compositionId ? { ...validModelConfig, providerId: "nvidia-inference-api" } : validModelConfig,
);

const planMode = workflow === "create-documentation" ? "create" : "update";
// An update planner that finds nothing to change keeps every planned page and
// proposes no-change.
const noChange = process.env.DOCSFAB_FIXTURE_CANDIDATE === "no-change";
const planBinding = createDocumentationPlanBinding({
  mode: planMode,
  pages: planPaths.map((path) => ({ path, disposition: noChange ? "retain" : planMode })),
  sourceBindings: noChange
    ? []
    : planPaths.map((path) => ({ pagePath: path, sources: ["README.md:1"] })),
});
// The direct request delivers a draft merge request, as the parsed default does.
const draftMr = process.env.DOCSFAB_FIXTURE_DRAFT_MR === "1";
const harness: AgentHarness = {
  async runStep(input) {
    if (input.step.id === "write-documentation") {
      for (const path of targetPaths) {
        await mkdir(dirname(join(input.repositoryPath, path)), { recursive: true });
        await writeFile(
          join(input.repositoryPath, path),
          "# Product purpose\n\nThe accountable owner states that this fixture documents its purpose.\n",
        );
      }
    }
    const identity = {
      repositoryRevision: input.evidenceIdentity!.repositoryRevision,
      ...(input.evidenceIdentity!.contextPacketDigest
        ? { contextPacketDigest: input.evidenceIdentity!.contextPacketDigest }
        : {}),
      ...(input.evidenceIdentity!.consultedNodeIds
        ? { consultedNodeIds: [...new Set(input.evidenceIdentity!.consultedNodeIds)].sort() }
        : {}),
      ...(input.evidenceIdentity!.technicalVerificationSha256
        ? { technicalVerificationSha256: input.evidenceIdentity!.technicalVerificationSha256 }
        : {}),
      ...(input.evidenceIdentity!.authoringPhaseSha256
        ? { authoringPhaseSha256: input.evidenceIdentity!.authoringPhaseSha256 }
        : {}),
    };
    const summary = ["review-documentation", "review-revised-documentation"].includes(input.step.id)
      ? canonicalizeJsonEvidence({
          verdict: "pass",
          issues: [],
        } as unknown as JsonEvidenceValue).trimEnd()
      : `fixture completed ${input.step.id}`;
    return {
      ...(input.step.id === "evaluate-document-quality" && input.qualityProfileSelection
        ? { qualityArtifactCandidate: await authoringFixtureCandidateForInput(input) }
        : {}),
      summary,
      model: modelEvidence,
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        total: 2,
        turns: 1,
      },
      tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
      turns: [
        {
          contextBudgetSchemaVersion: 2,
          turn: 1,
          toolCalls: 0,
          toolResults: 0,
          maxProviderTurns: 8,
          maxToolCalls: 16,
          compactions: 0,
          maxCompactions: 1,
          configuredContextWindow: 128_000,
          effectiveContextWindow: 128_000,
          configuredMaxInputTokens: 128_000,
          effectiveMaxInputTokens: 128_000,
          availableInputTokens: 123_904,
          configuredMaxOutputTokens: 16_384,
          effectiveMaxOutputTokens: 16_384,
          reservedTokens: 4_096,
          estimatedInputTokens: 1,
          availableOutputTokens: 123_903,
          requiredMinimumOutputTokens: 16,
          outputTokens: 16_384,
          decision: "proceed",
          requestDigest: "a".repeat(64),
          evidenceDigest: canonicalDigest(identity),
        },
      ],
      ...(await verificationFixture(input)),
      ...(input.step.id === "plan-documentation" ? { planBinding } : {}),
      ...(await updateEditorialProposal(input)),
    };
  },
};

const common = {
  workflow,
  repositoryPath,
  ...(compositionId ? { compositionId } : {}),
  revision: "HEAD",
  allowWrite: true,
  releaseGate: false,
  verbose: false,
  json: false,
  showScan: false,
  ...(workflow === "update-documentation"
    ? {
        comparisonRequest: { kind: "workspace" as const },
        readerSources: [
          { role: "changed-source" as const, path: "README.md" },
          { role: "current-documentation" as const, path: "README.md" },
          { role: "public-contract" as const, path: "README.md" },
        ],
      }
    : {}),
} as const;
const directRequest =
  mode === "stop"
    ? { ...common, ...(draftMr ? { draftMr: true, remoteName: "origin" } : {}), instruction }
    : {
        ...common,
        ...(draftMr ? { draftMr: true, remoteName: "origin" } : {}),
        ...(process.env.DOCSFAB_FIXTURE_REVISION
          ? { revision: process.env.DOCSFAB_FIXTURE_REVISION, revisionExplicit: true }
          : {}),
        ...(process.env.DOCSFAB_FIXTURE_INSTRUCTION
          ? { instruction: process.env.DOCSFAB_FIXTURE_INSTRUCTION }
          : {}),
        resumeFrom: process.env.DOCSFAB_FIXTURE_STOPPED_RUN!,
        canonSnapshotPath: process.env.DOCSFAB_FIXTURE_SNAPSHOT!,
        acceptCandidateSnapshot: true,
        canonSnapshotAuthorityId: "fixture-product-owner",
        ...(process.env.DOCSFAB_FIXTURE_SERIALIZED_LINEAGE === "1"
          ? {
              taskLineage: JSON.parse(
                await readFile(
                  join(stateDirectory, `${process.env.DOCSFAB_FIXTURE_STOPPED_RUN!}.json`),
                  "utf8",
                ),
              ).taskLineage,
            }
          : {}),
      };
const request =
  process.env.DOCSFAB_FIXTURE_PARSED === "1"
    ? parseRunArguments(
        mode === "stop"
          ? [workflow, "--repo", repositoryPath, "--instruction", instruction]
          : [
              workflow,
              "--repo",
              repositoryPath,
              "--resume-from",
              process.env.DOCSFAB_FIXTURE_STOPPED_RUN!,
              "--canon-snapshot",
              process.env.DOCSFAB_FIXTURE_SNAPSHOT!,
              "--accept-candidate-snapshot",
              "--authority-id",
              "fixture-product-owner",
            ],
      )
    : directRequest;
const outputMode = process.env.DOCSFAB_FIXTURE_OUTPUT ?? "record";
const useDefaultConfig = process.env.DOCSFAB_FIXTURE_DEFAULT_CONFIG === "1";
if (useDefaultConfig) {
  Object.assign(process.env, validModelEnvironment, { DOCSFAB_STATE_DIR: stateDirectory });
}
const deliveryStatePath = process.env.DOCSFAB_FIXTURE_DELIVERY_STATE;
const deliveryAction = process.env.DOCSFAB_FIXTURE_DELIVERY_ACTION;
const deliveryReadyPath = process.env.DOCSFAB_FIXTURE_DELIVERY_READY;
const waitForParentKill = async (phase: string): Promise<never> => {
  await writeFile(deliveryReadyPath!, `${phase}\n`, { mode: 0o600 });
  return new Promise(() => {
    setInterval(() => undefined, 1_000);
  });
};
// An interpretation that admits these write targets for the stopping run; a
// resumed run is a continuation the interpretation does not read. Another
// operation than the declared one makes the reading an advisory.
const intentTargets = process.env.DOCSFAB_FIXTURE_INTENT_TARGETS?.split(",").filter(Boolean);
const intentOperation = process.env.DOCSFAB_FIXTURE_INTENT_OPERATION ?? planMode;
const requestInterpreter: RequestIntentInterpreterPort | undefined =
  mode === "stop" && intentTargets
    ? {
        async call() {
          const calls = process.env.DOCSFAB_FIXTURE_INTENT_CALLS;
          if (calls) await appendFile(calls, "call\n");
          return {
            text: JSON.stringify({
              operation: intentOperation,
              targets: intentTargets.map((path) => ({
                path,
                role: "write",
                chosenFrom: planMode === "create" ? "proposed-new" : "named",
                quote: path,
              })),
              authorityPreference: { preference: "unspecified", quote: null },
            }),
            usage: { inputTokens: 3, outputTokens: 2 },
          };
        },
      }
    : undefined;
const options: CliRunOptions = {
  ...(requestInterpreter ? { requestInterpreter } : {}),
  silent: outputMode === "record" || outputMode === "silent",
  quiet: outputMode === "quiet",
  json: outputMode === "json",
  executionHarness: harness,
  ...(process.env.DOCSFAB_FIXTURE_PARSED === "1" || draftMr
    ? {
        ensurePublicationFreshness: async () => ({
          branch: process.env.DOCSFAB_FIXTURE_TARGET_BRANCH ?? "main",
          revision: process.env.DOCSFAB_FIXTURE_TARGET_REVISION!,
        }),
      }
    : {}),
  ...(deliveryStatePath
    ? {
        submitAfterSucceededRun: (async (publishedRecord, _envelope, context) => {
          if (deliveryAction === "no-publication")
            throw new Error("A verified no-change reached the publisher.");
          const log = context.log;
          if (!log) throw new Error("fixture publication logger is required");
          if (deliveryAction === "crash-before-delivery")
            await waitForParentKill("before-delivery");
          const recordBytes = await readFile(join(stateDirectory, `${publishedRecord.id}.json`));
          const recordSha256 = createHash("sha256").update(recordBytes).digest("hex");
          const key = scmDeliveryIdentityKey({
            provider: "gitlab",
            run: { id: publishedRecord.id, recordSha256 },
            repository: { projectId: 761, host: "gitlab.fixture.test", path: "docs/fixture" },
            baseRevision: process.env.DOCSFAB_FIXTURE_TARGET_REVISION!,
            targetBranch: context.targetBranch!,
            patchSha256: publishedRecord.changes!.patch!.sha256,
          });
          const existing = await readFile(deliveryStatePath, "utf8")
            .then((text) => JSON.parse(text) as { key: string; physicalCount: number; url: string })
            .catch(() => undefined);
          if (deliveryAction === "fail-if-called") throw new Error("publisher was repeated");
          if (existing && existing.key !== key) throw new Error("publisher key drifted");
          if (deliveryAction === "fail") throw new Error("fixture publication failed");
          const state = existing ?? {
            key,
            physicalCount: 1,
            url: "https://gitlab.fixture.test/docs/fixture/-/merge_requests/761",
          };
          if (!existing)
            await writeFile(deliveryStatePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
          if (deliveryAction === "crash-during-delivery")
            await waitForParentKill("during-delivery");
          const commitRevision = "e".repeat(40);
          const publicationResult = {
            schemaVersion: 1,
            kind: "docsfab-local-user-gitlab-publication-result",
            status: "opened",
            planSha256: "a".repeat(64),
            idempotencyKey: key,
            receiptSha256: "b".repeat(64),
            state: "opened",
            disposition: "succeeded",
            sourceBranch: "docsfab/continuation-fixture",
            targetBranch: context.targetBranch,
            commitRevision,
            mergeRequest: {
              iid: 761,
              url: state.url,
              draft: true,
              headRevision: commitRevision,
            },
          };
          log(JSON.stringify(publicationResult));
          return {
            mergeRequest: { url: state.url },
            publicationResult,
          } as never;
        }) as NonNullable<CliRunOptions["submitAfterSucceededRun"]>,
      }
    : {}),
};
// `--set key=value` pairs, as the command line would give them.
if (process.env.DOCSFAB_FIXTURE_SET) {
  setCliModelSettings(parseSetOptions(["--set", process.env.DOCSFAB_FIXTURE_SET]));
}
const record = await executeRunRequest(request, useDefaultConfig ? undefined : config, options);
if (outputMode === "record") {
  process.exitCode = 0;
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

async function updateEditorialProposal(input: HarnessStepInput): Promise<Record<string, unknown>> {
  if (workflow !== "update-documentation") return {};
  const readerEvidence = input.editorialEvidenceRefs?.[0];
  const impactSource = {
    uri: "README.md",
    sha256: createHash("sha256")
      .update(await readFile(join(input.repositoryPath, "README.md")))
      .digest("hex"),
  };
  if (input.step.id === "plan-documentation" && noChange) {
    return {
      editorialDecisionProposal: {
        schemaVersion: 1,
        kind: "docsfab-editorial-decision-proposal",
        candidate: "no-change",
        rationale:
          "The admitted nominated sources show the current documentation pages already describe the behavior.",
        evidenceRefs: readerEvidence ? [readerEvidence] : [],
        limitations: [],
        impactBasis: {
          kind: "none",
          rationale: "The nominated public contract leaves the documented behavior unchanged.",
          evidence_refs: [impactSource],
        },
      },
    };
  }
  if (input.step.id === "plan-documentation") {
    return {
      editorialDecisionProposal: {
        schemaVersion: 1,
        kind: "docsfab-editorial-decision-proposal",
        candidate: "update",
        rationale:
          "The admitted finite request identifies the current documentation pages that require bounded updates.",
        evidenceRefs: readerEvidence ? [readerEvidence] : [],
        limitations: [],
        impactBasis: {
          kind: "documentation-defect",
          rationale:
            "The admitted request and current documentation establish the source-bound update targets.",
          evidence_refs: [impactSource],
        },
      },
    };
  }
  if (
    input.step.id === "verify-technical-accuracy" ||
    input.step.id === "review-documentation" ||
    input.step.id === "evaluate-document-quality"
  ) {
    return {
      editorialAssessmentProposal: {
        schemaVersion: 1,
        kind: "docsfab-editorial-assessment-proposal",
        assessment: "accepted",
        rationale: `${input.step.id} independently checked the retained documentation targets.`,
        evidenceRefs: readerEvidence ? [readerEvidence] : [],
        limitations: [],
        recommendation: null,
      },
    };
  }
  if (input.step.id === "test-audience-understanding") {
    return {
      editorialAssessmentProposal: {
        schemaVersion: 1,
        kind: "docsfab-editorial-assessment-proposal",
        assessment: "not-applicable",
        rationale:
          "No authorized representative audience fixture is available in this deterministic transport test.",
        evidenceRefs: readerEvidence ? [readerEvidence] : [],
        limitations: ["audience-check-unavailable"],
        recommendation: null,
      },
    };
  }
  return {};
}
