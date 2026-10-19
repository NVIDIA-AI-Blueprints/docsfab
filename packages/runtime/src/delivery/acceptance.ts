// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { generateKeyPairSync, randomUUID, sign as signBytes } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import {
  DELIVERY_ACCEPTANCE_CASE_IDS,
  finalizeDeliveryAcceptanceManifest,
  type DeliveryAcceptanceCaseResult,
  type DeliveryAcceptanceChainBindingV1,
  type DeliveryAcceptanceManifestV1,
  type DeliveryAcceptanceRunBindingV1,
} from "./acceptance-manifest.js";
import { assembleVerifiedDeliveryAcceptanceChain } from "./acceptance-chain.js";
import { runLocalUserPublishExecuteCli } from "./cli.js";
import type { LocalUserPublicationPlan } from "./contracts.js";
import {
  DeterministicLocalGitPublisher,
  type GitPublisherCommandResult,
  type GitPublisherCommandRunner,
} from "./git-publisher.js";
import {
  decodeLocalUserGitLabPublicationResult,
  type LocalUserGitLabPublicationResultV1,
} from "./publication-result.js";
import { LocalUserGitLabPublisherAdapter } from "./gitlab-adapter.js";
import {
  preflightLocalUserGitLabPublication,
  type ReadOnlyCommandResult,
  type ReadOnlyCommandRunner,
} from "./preflight.js";
import { FileScmDeliveryReceiptStore } from "./receipt-store.js";
import { scmDeliveryIdempotencyKey, type ScmDeliveryRecord } from "./receipt.js";
import {
  canonicalizeJsonEvidence,
  parseJsonEvidence,
  type JsonEvidenceValue,
} from "../json-evidence.js";
import type { AgentHarness, HarnessStepInput } from "../execution/contracts.js";
import { createReaderTaskContextSupplier } from "../execution/task-context.js";
import type { RunRecord } from "../records/contracts.js";
import type { ModelEndpointConfig } from "../model/configuration.js";
import { canonicalDigest, buildContentIndex, type ContentIndexV1 } from "../content-ir/index.js";
import {
  createArtifact,
  DurableArtifactStore,
  type ArtifactReference,
} from "../artifacts/index.js";
import { READER_CONTEXT_CHANGED_SOURCE_INAPPLICABLE_LIMITATION } from "../context/reader-context.js";
import { authorizeBoundedDocImprovementWrite } from "../doc-improvement.js";
import { LocalContextPreflightService } from "../context/preflight.js";
import { LocalImpactPostflightService } from "../impact/postflight.js";
import { iaPlanReviewerPolicyDigest, type IaPlanReviewerPolicy } from "../ia/plan-review.js";
import { createModelEvidence } from "../model/profile-evidence.js";
import { FileRunStore } from "../records/file-store.js";
import {
  documentationPlanBindingDigest,
  type DocumentationPlanMode,
} from "../workflow-execution/plan-binding.js";
import { GitPatchEvidenceCollector } from "../repository/evidence.js";
import { prepareRepositoryWorkspace } from "../repository/workspace/materialize.js";
import { LocalRepositorySecurityScanner } from "../security/repository-scanner.js";
import {
  findCatalogSkill,
  readCatalogSkillCrateLock,
  verifyCatalogSkill,
} from "../skills/catalog-crate.js";
import { catalogSkillToolsForStep } from "../skills/catalog-crate-selection.js";
import { getWorkflow } from "../workflow-registry/catalog.js";
import { LocalWorkflowSearchCoordinator } from "../search/local-workflow-coordinator.js";
import type {
  WorkflowSearchCoordinator,
  WorkflowSearchCoordinatorInput,
  WorkflowSearchCoordinatorResultV1,
} from "../workflow-contracts/contracts.js";
import { WorkflowRunner } from "../workflow-execution/runner.js";
import { createEditorialEvidenceHostV1 } from "../workflow-execution/editorial-evidence-host.js";
import { WorkflowChecksHostOperation } from "../workflow-execution/workflow-checks.js";
import {
  authoritativeReviewTargetPaths,
  TECHNICAL_FACT_DIMENSIONS,
  type VerificationResult,
} from "../workflow-execution/verification-result.js";
import { LocalSourceObligationSourceObserver } from "../workflow-execution/source-obligation-observer.js";
import {
  bindTechnicalCorrectionResponse,
  bindHostOwnedTechnicalCorrectionProposalV3,
  canonicalSourceObligationProposal,
  requiresSourceObligationLedger,
  requiresTechnicalCorrection,
  TECHNICAL_CORRECTION_PROPOSAL_KIND,
  type SourceObligationLedgerProposalV1,
} from "../workflow-execution/source-obligation.js";
import { AuthoringQualityWorkflowOutcomeProjector } from "../evaluation-report/authoring-outcome-projector.js";
import { loadSavedRunEditorialDecodeOptions } from "../cli/run/editorial-replay.js";
import { resolveDocsFabRuntimeAssetPaths } from "../config/runtime-loader.js";
import { verifyQualityPackContext } from "../quality-pack/manifest.js";
import { isPlainRecord } from "../shared/primitives.js";
import { sha256 } from "../content-ir/canonical.js";
import { command } from "./acceptance/process.js";
import {
  OfflineFakeGitLab,
  bareRevision,
  loadFakeGitLabState,
  saveFakeGitLabState,
  PROJECT_HOST,
  PROJECT_PATH,
  type AttemptMode,
  type OfflineFixture,
} from "./acceptance/fake-gitlab.js";
import { decodeAcceptanceRunRecord, parseAcceptanceJson } from "./acceptance/record-codec.js";
export { decodeAcceptanceRunRecord };
import {
  deliveryAcceptanceSourceCheckoutSha256,
  nested,
  observeDeliveryAcceptanceSourceCheckout,
} from "./acceptance/checkout-observation.js";
export { deliveryAcceptanceSourceCheckoutSha256, observeDeliveryAcceptanceSourceCheckout };
export type { DeliveryAcceptanceSourceCheckoutObservationV1 } from "./acceptance/checkout-observation.js";
const REMOTE_URL = `https://${PROJECT_HOST}/${PROJECT_PATH}.git`;
const RUN_ID = "delivery-acceptance-run";
const DOCSFAB_PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const TSX_IMPORT_PATH = createRequire(import.meta.url).resolve("tsx");
const OFFLINE_ISOLATION_CANARY = "offline-credential-and-network-canary";
export interface OfflineDeliveryAcceptanceOptions {
  stateRoot: string;
  evidenceRoot: string;
  testedRevision: string;
}

export interface OfflineDeliveryAcceptanceResult {
  manifest: DeliveryAcceptanceManifestV1;
  manifestPath: string;
  workspacePreserved: boolean;
  chainEvidencePaths: DeliveryAcceptanceChainEvidencePaths;
}

export interface DeliveryAcceptanceChainEvidencePaths {
  readinessRecordPath: string;
  declarationPath: string;
  analysisRecordPath: string;
  authorizationPath: string;
  reviewerPolicyPath: string;
  applicationRecordPath: string;
  patchPath: string;
}

type MatrixObservation = Pick<
  DeliveryAcceptanceCaseResult,
  | "patchPreserved"
  | "nextAction"
  | "sourceCheckoutUnchanged"
  | "worktreeState"
  | "receiptState"
  | "remoteBranchState"
  | "mergeRequestState"
  | "observedExternalMutationCount"
>;

/**
 * Deterministic end-to-end delivery proof. The only replaced boundary is glab;
 * Git repositories, worktrees, validation, commit objects, bare-remote pushes,
 * receipt journals, and restart processes are real.
 */
export async function runOfflineDeliveryAcceptance(
  options: OfflineDeliveryAcceptanceOptions,
): Promise<OfflineDeliveryAcceptanceResult> {
  assertRevision(options.testedRevision);
  const [stateRoot, evidenceRoot] = await Promise.all([
    secureExternalRoot(options.stateRoot),
    secureExternalRoot(options.evidenceRoot),
  ]);
  const projectRoot = await realpath(DOCSFAB_PROJECT_ROOT);
  const currentRevision = await gitText(projectRoot, ["rev-parse", "HEAD"]);
  if (currentRevision !== options.testedRevision) {
    throw new Error(
      "Delivery acceptance tested revision is not the exact DocsFab checkout revision.",
    );
  }
  if (
    stateRoot === evidenceRoot ||
    nested(stateRoot, evidenceRoot) ||
    nested(evidenceRoot, stateRoot)
  ) {
    throw new Error("Delivery acceptance state and evidence roots must be disjoint.");
  }
  if (
    stateRoot === projectRoot ||
    evidenceRoot === projectRoot ||
    nested(projectRoot, stateRoot) ||
    nested(projectRoot, evidenceRoot) ||
    nested(stateRoot, projectRoot) ||
    nested(evidenceRoot, projectRoot)
  ) {
    throw new Error("Delivery acceptance roots must be outside the DocsFab checkout.");
  }
  const invocation = `${options.testedRevision.slice(0, 12)}-${randomUUID()}`;
  const workspaceRoot = await mkdtemp(join(stateRoot, `delivery-${invocation}-`));
  await chmod(workspaceRoot, 0o700);
  const fixture = await createOfflineFixture(workspaceRoot);
  const sourceBefore = await observeDeliveryAcceptanceSourceCheckout(fixture.source);
  const plan = await preflight(fixture);
  const first = await executeAttempt(fixture, plan, {});
  const second = await executeAttempt(fixture, plan, {});
  const receipt = await loadReceipt(fixture, plan);
  const sourceAfter = await observeDeliveryAcceptanceSourceCheckout(fixture.source);
  if (
    sourceAfter.sha256 !== sourceBefore.sha256 ||
    canonicalizeJsonEvidence(sourceAfter.ignored as unknown as JsonEvidenceValue) !==
      canonicalizeJsonEvidence(sourceBefore.ignored as unknown as JsonEvidenceValue)
  ) {
    throw new Error("Offline delivery acceptance mutated the source checkout.");
  }
  const fakeState = await loadFakeGitLabState(fixture.fakeGitLabStatePath);
  if (fakeState.createCount !== 1 || first.mergeRequest.iid !== second.mergeRequest.iid) {
    throw new Error("Offline delivery acceptance did not prove idempotent MR reuse.");
  }
  const caseContract = await loadAcceptanceCaseContract();
  const duplicateObservation = await observeMatrixState(fixture, plan, sourceBefore.sha256);
  const failureMatrix = await runFailureMatrix(
    stateRoot,
    options.testedRevision,
    duplicateObservation,
  );
  if (
    failureMatrix.some(
      (item, index) =>
        item.id !== caseContract[index]?.id ||
        item.expectedFailureCode !== caseContract[index]?.expected,
    )
  ) {
    throw new Error("Delivery acceptance results do not match the versioned case contract.");
  }
  const commit = receipt.evidence.commit?.sha;
  const pushed = receipt.evidence.push?.remoteRevision;
  const mergeRequest = receipt.evidence.mergeRequest;
  const validation = receipt.evidence.validation;
  if (
    !commit ||
    pushed !== commit ||
    !mergeRequest ||
    mergeRequest.headRevision !== commit ||
    !validation ||
    receipt.state !== "opened" ||
    receipt.disposition !== "succeeded"
  ) {
    throw new Error("Offline delivery receipt is not terminal and internally consistent.");
  }
  const commitParts = (
    await gitText(fixture.bareRemote, [
      "--git-dir",
      fixture.bareRemote,
      "show",
      "--quiet",
      "--format=%T%n%P",
      commit,
    ])
  ).split("\n");
  const treeRevision = commitParts[0];
  const parents = (commitParts[1] ?? "").split(" ").filter(Boolean);
  if (!treeRevision || parents.length !== 1 || parents[0] !== fixture.sourceRevision) {
    throw new Error("Offline delivery commit is not a single-parent child of the exact base.");
  }
  const chain = assembleVerifiedDeliveryAcceptanceChain(
    {
      testedRevision: options.testedRevision,
      readinessRecordBytes: await readFile(fixture.chainEvidencePaths.readinessRecordPath),
      declarationBytes: await readFile(fixture.chainEvidencePaths.declarationPath),
      analysisRecordBytes: await readFile(fixture.chainEvidencePaths.analysisRecordPath),
      authorizationBytes: await readFile(fixture.chainEvidencePaths.authorizationPath),
      reviewerPolicyBytes: await readFile(fixture.chainEvidencePaths.reviewerPolicyPath),
      applicationRecordBytes: await readFile(fixture.chainEvidencePaths.applicationRecordPath),
      patchBytes: await readFile(fixture.chainEvidencePaths.patchPath),
    },
    await acceptanceEditorialDecodeOptions(fixture),
  );
  const expectedExternalMutationCount = failureMatrix.reduce(
    (sum, item) => sum + item.expectedExternalMutationCount,
    0,
  );
  const observedExternalMutationCount = failureMatrix.reduce(
    (sum, item) => sum + item.observedExternalMutationCount,
    0,
  );
  const manifest = finalizeDeliveryAcceptanceManifest({
    schemaVersion: 1,
    kind: "docsfab-local-user-gitlab-delivery-acceptance",
    mode: "offline",
    status: "passed",
    testedRevision: options.testedRevision,
    sourceRevision: fixture.sourceRevision,
    chain,
    plan: {
      sha256: plan.sha256,
      baseRevision: plan.baseRevision,
      runRecordSha256: plan.run.recordSha256,
      patchSha256: plan.patch.sha256,
    },
    publicationAuthorization: {
      decision: "authorized",
      command: "publish",
      planSha256: plan.sha256,
    },
    validation: {
      commandSha256: validation.commandSha256,
      summarySha256: validation.summarySha256,
      status: "passed",
      checkCount: validation.checkCount,
    },
    commit: {
      revision: commit,
      treeRevision,
      parentRevision: parents[0],
      parentCount: 1,
      baseRevision: receipt.baseRevision,
    },
    remote: {
      identitySha256: sha256(`${plan.project.host}:${plan.project.path}:${plan.remote.name}`),
      name: plan.remote.name,
      transport: plan.remote.transport,
      sourceBranch: plan.proposedSourceBranch,
      targetBranch: plan.targetBranch.name,
      headRevision: pushed,
    },
    mergeRequest: {
      iid: mergeRequest.iid,
      draft: true,
      state: "opened",
      sourceBranch: mergeRequest.sourceBranch,
      targetBranch: mergeRequest.targetBranch,
      headRevision: mergeRequest.headRevision,
      identitySha256: sha256(
        `${plan.project.id}:${mergeRequest.iid}:${plan.proposedSourceBranch}:${commit}`,
      ),
    },
    receipt: {
      idempotencyKey: receipt.idempotencyKey,
      sha256: receipt.sha256,
      state: "opened",
      disposition: "succeeded",
      planSha256: receipt.planSha256,
    },
    sourceCheckout: {
      status: "unchanged",
      beforeSha256: sourceBefore.sha256,
      afterSha256: sourceAfter.sha256,
      ignored: sourceAfter.ignored,
    },
    idempotency: {
      invocationCount: 2,
      mergeRequestCreateCount: fakeState.createCount,
      status: "reused",
    },
    failureMatrix,
    failureMatrixSummary: {
      expectedCaseCount: DELIVERY_ACCEPTANCE_CASE_IDS.length,
      observedCaseCount: failureMatrix.length,
      expectedExternalMutationCount,
      observedExternalMutationCount,
    },
    liveGate: { status: "not-run", cleanup: "separately-gated" },
    dogfoodDisposition: "sufficient-for-complex-local-dogfood",
  });
  const manifestDirectory = await mkdtemp(join(evidenceRoot, `delivery-${invocation}-`));
  await chmod(manifestDirectory, 0o700);
  const manifestPath = join(manifestDirectory, "manifest.json");
  await writePrivateExclusive(
    manifestPath,
    Buffer.from(canonicalizeJsonEvidence(manifest as unknown as JsonEvidenceValue)),
  );
  return {
    manifest,
    manifestPath,
    workspacePreserved: true,
    chainEvidencePaths: { ...fixture.chainEvidencePaths },
  };
}

async function createOfflineFixture(
  root: string,
  variant: "normal" | "patch-conflict" = "normal",
): Promise<OfflineFixture> {
  const source = join(root, "source");
  const bareRemote = join(root, "remote.git");
  const stateDirectory = join(root, "runs");
  const deliveryRoot = join(root, "deliveries");
  const receiptRoot = join(root, "receipts");
  const fakeGitLabStatePath = join(root, "fake-glab-state.json");
  await Promise.all([
    mkdir(source, { mode: 0o700 }),
    mkdir(stateDirectory, { mode: 0o700 }),
    mkdir(deliveryRoot, { mode: 0o700 }),
    mkdir(receiptRoot, { mode: 0o700 }),
  ]);
  await git(root, ["init", "--bare", bareRemote]);
  await git(source, ["init", "-b", "main"]);
  await git(source, ["config", "user.name", "Maintainer"]);
  await git(source, ["config", "user.email", "maintainer@example.test"]);
  await mkdir(join(source, "docs"));
  await writeFile(join(source, "README.md"), "DocsFab acceptance fixture\n");
  await writeFile(join(source, "docs", "guide.md"), "# Guide\n\nOriginal guidance.\n");
  await writeFile(
    join(source, "_toc.yml"),
    "root: README.md\nchapters:\n  - file: docs/guide.md\n",
  );
  await writeFile(
    join(source, "validate.cjs"),
    [
      "const fs=require('node:fs');",
      "const text=fs.readFileSync('docs/guide.md','utf8');",
      "process.exit(text.includes('Governed delivery evidence.')?0:9);",
      "",
    ].join("\n"),
  );
  await writeFile(join(source, "fail.cjs"), "process.exit(9);\n");
  await git(source, ["add", "-A"]);
  await git(source, ["-c", "commit.gpgsign=false", "commit", "-m", "fixture base"], {
    GIT_AUTHOR_DATE: "2026-08-04T00:00:00Z",
    GIT_COMMITTER_DATE: "2026-08-04T00:00:00Z",
  });
  const sourceRevision = await gitText(source, ["rev-parse", "HEAD"]);
  await git(source, ["push", bareRemote, `HEAD:refs/heads/main`]);
  await git(source, ["remote", "add", "origin", REMOTE_URL]);
  await git(source, ["update-ref", "refs/remotes/origin/main", sourceRevision]);
  await writeFile(join(source, "operator-note.txt"), "untracked source sentinel\n");

  const governed = await runGovernedDeliveryChain({
    root,
    source,
    revision: sourceRevision,
    stateDirectory,
  });
  let patch = governed.patchBytes;
  let applicationRecord = governed.applicationRecord;
  if (variant === "patch-conflict") {
    patch = Buffer.from(
      patch.toString("utf8").replace("-Original guidance.", "-Different base guidance."),
    );
    applicationRecord = structuredClone(applicationRecord);
    if (!applicationRecord.changes?.patch) {
      throw new Error("Governed application record did not retain its patch.");
    }
    applicationRecord.changes.patch.sha256 = sha256(patch);
    applicationRecord.changes.patch.byteLength = patch.byteLength;
    applicationRecord.changes.patch.lineCount = patch.toString("utf8").split("\n").length - 1;
  }
  const governedPatch = applicationRecord.changes?.patch;
  if (!governedPatch) throw new Error("Governed application patch evidence is missing.");
  const patchPath = governedPatch.artifactPath;
  const patchSha256 = sha256(patch);
  const recordPath = join(stateDirectory, `${RUN_ID}.json`);
  let recordBytes = await readFile(recordPath);
  if (variant === "patch-conflict") {
    applicationRecord.changes!.patch = {
      ...governedPatch,
      sha256: patchSha256,
      byteLength: patch.byteLength,
      lineCount: patch.toString("utf8").split("\n").length - 1,
    };
    recordBytes = Buffer.from(`${JSON.stringify(applicationRecord)}\n`);
    await writeFile(patchPath, patch, { mode: 0o600 });
    await writeFile(recordPath, recordBytes, { mode: 0o600 });
  }
  await writePrivateExclusive(
    fakeGitLabStatePath,
    Buffer.from(`${JSON.stringify({ schemaVersion: 1, createCount: 0 })}\n`),
  );
  return {
    root,
    source,
    bareRemote,
    stateDirectory,
    deliveryRoot,
    receiptRoot,
    patchPath,
    recordPath,
    fakeGitLabStatePath,
    sourceRevision,
    patchSha256,
    patchByteLength: patch.byteLength,
    patchLineCount: patch.toString("utf8").split("\n").length - 1,
    recordSha256: sha256(recordBytes),
    governedRuns: governed.governedRuns,
    chainEvidencePaths: governed.chainEvidencePaths,
    authorization: governed.authorization,
  };
}

interface GovernedDeliveryChain {
  governedRuns: OfflineFixture["governedRuns"];
  chainEvidencePaths: DeliveryAcceptanceChainEvidencePaths;
  authorization: OfflineFixture["authorization"];
  applicationRecord: RunRecord;
  patchBytes: Buffer;
}

const OFFLINE_MODEL_CONFIG: ModelEndpointConfig = {
  providerId: "offline-acceptance",
  baseUrl: "https://inference.example.test/v1",
  modelId: "deterministic-governed",
  apiFormat: "chat_completions",
  api: "openai-completions",
  apiKey: "offline-boundary-not-a-credential",
  requestPolicy: { minimumOutputTokens: 16, reservedContextTokens: 4_096 },
  profile: {
    configuredLimits: {
      contextWindow: 128_000,
      maxInputTokens: 128_000,
      maxOutputTokens: 16_384,
    },
    contextWindow: 128_000,
    maxInputTokens: 128_000,
    maxOutputTokens: 16_384,
    effectiveLimitReason: "none",
    reasoning: false,
    input: ["text"],
    compatibility: {
      supportsDeveloperRole: true,
      supportsReasoningEffort: false,
      apiFormats: ["chat_completions"],
    },
    costPerMillionTokens: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: null,
    },
    metadata: {
      approvedSource: "https://example.test/offline-acceptance-model-profile",
      effectiveDate: "2026-08-04",
      reviewAfter: "2099-12-31",
      status: "current",
    },
  },
};

class OfflineGovernedHarness implements AgentHarness {
  public constructor(private readonly impactSource: { uri: string; sha256: string }) {}

  public async inspectSkill(input: HarnessStepInput) {
    const skillCrateDirectory = join(DOCSFAB_PROJECT_ROOT, "skill-crate");
    const skill = findCatalogSkill(
      await readCatalogSkillCrateLock(skillCrateDirectory),
      input.step.skill,
    );
    if (!skill) return { id: input.step.skill, contentSha256: "a".repeat(64) };
    return (
      await verifyCatalogSkill({
        skillCrateDirectory,
        skillId: input.step.skill,
        grantedTools: catalogSkillToolsForStep(input.step),
      })
    ).evidence;
  }

  public async runStep(input: HarnessStepInput) {
    if (input.step.id === "write-documentation") {
      await writeFile(
        join(input.repositoryPath, "docs", "guide.md"),
        "# Guide\n\nGoverned delivery evidence.\n",
      );
    }
    const model = createModelEvidence(OFFLINE_MODEL_CONFIG);
    const skill = await this.inspectSkill(input);
    if (!skill) throw new Error(`Governed skill ${input.step.skill} is unavailable.`);
    const usage = {
      input: 64,
      output: 32,
      cacheRead: 0,
      cacheWrite: 0,
      total: 96,
      turns: 1,
    };
    const toolName = input.step.mode === "write" ? "write" : "read";
    const tools = {
      totalCalls: 1,
      failedCalls: 0,
      byTool: [{ name: toolName, calls: 1, failures: 0 }],
      failureCategories: [],
    };
    const identity = input.evidenceIdentity;
    if (!identity) throw new Error("Governed inference identity is missing.");
    const identityDigest = canonicalDigest({
      repositoryRevision: identity.repositoryRevision,
      ...(identity.contextPacketDigest
        ? { contextPacketDigest: identity.contextPacketDigest }
        : {}),
      ...(identity.consultedNodeIds
        ? { consultedNodeIds: [...new Set(identity.consultedNodeIds)].sort() }
        : {}),
      ...(identity.technicalVerificationSha256
        ? { technicalVerificationSha256: identity.technicalVerificationSha256 }
        : {}),
      ...(identity.authoringPhaseSha256
        ? { authoringPhaseSha256: identity.authoringPhaseSha256 }
        : {}),
    });
    const turns = [
      {
        contextBudgetSchemaVersion: 2 as const,
        turn: 1,
        toolCalls: 1,
        toolResults: 1,
        maxProviderTurns: 8,
        maxToolCalls: 16,
        compactions: 0,
        maxCompactions: 1,
        configuredContextWindow: 128_000,
        effectiveContextWindow: 128_000,
        configuredMaxInputTokens: 128_000,
        effectiveMaxInputTokens: 128_000,
        configuredMaxOutputTokens: 16_384,
        effectiveMaxOutputTokens: 16_384,
        reservedTokens: 4_096,
        estimatedInputTokens: 64,
        availableInputTokens: 123_904,
        availableOutputTokens: 123_840,
        requiredMinimumOutputTokens: 16,
        outputTokens: 16_384,
        decision: "proceed" as const,
        requestDigest: canonicalDigest({
          runId: input.runId,
          stepId: input.step.id,
          identity,
        }),
        evidenceDigest: identityDigest,
      },
    ];
    if (requiresSourceObligationLedger(input)) {
      const sourcePath = input.planBinding?.sourceBindings[0]?.sources[0] ?? "README.md";
      const sourceLocator = /:\d+(?:-\d+)?$/u.test(sourcePath) ? sourcePath : `${sourcePath}:1`;
      const sourceObligationProposal: SourceObligationLedgerProposalV1 = {
        completeness: "bounded-not-proven",
        dimensions: TECHNICAL_FACT_DIMENSIONS.map((dimension) => ({
          dimension,
          status: "not-applicable",
          reason: `The bounded acceptance fixture defines no ${dimension} behavior.`,
          sourceLocators: [sourceLocator],
          obligations: [],
        })),
        limitations: [],
      };
      return {
        summary: canonicalSourceObligationProposal(sourceObligationProposal),
        sourceObligationProposal,
        model,
        skill,
        usage,
        tools,
        turns,
      };
    }
    let verificationResult: VerificationResult | undefined;
    if (input.step.skill === "verify-technical-accuracy") {
      const pages = input.planBinding
        ? [input.planBinding.pages[0]!.path]
        : ["README.md", "docs/guide.md"];
      const [readme, guide, toc] = await Promise.all([
        readFile(join(input.repositoryPath, "README.md"), "utf8"),
        readFile(join(input.repositoryPath, "docs/guide.md"), "utf8"),
        readFile(join(input.repositoryPath, "_toc.yml"), "utf8"),
      ] as const);
      const validFixtureContract =
        readme.trim() === "DocsFab acceptance fixture" &&
        guide.startsWith("# Guide\n") &&
        toc.includes("root: README.md") &&
        toc.includes("- file: docs/guide.md") &&
        guide.includes(
          input.workflow.name === "review-documentation"
            ? "Original guidance."
            : "Governed delivery evidence.",
        );
      if (!validFixtureContract) {
        throw new Error(
          "Offline acceptance verification found documentation content inconsistent with fixture source.",
        );
      }
      verificationResult = {
        review: { verdict: "pass" as const, issues: [] },
        coverage: pages.map((path) => ({
          path,
          status: "verified" as const,
          evidence: [`${path}:1`, "_toc.yml:1"],
          reason:
            "The offline acceptance fixture checked the page bytes, navigation entry, and expected governed wording contract.",
        })),
        factInventory: {
          completeness: "bounded-not-proven" as const,
          dimensions: TECHNICAL_FACT_DIMENSIONS.map((dimension) => ({
            dimension,
            status: "not-applicable" as const,
            reason: `The bounded acceptance fixture defines no ${dimension} behavior.`,
            sourceLocators: ["README.md:1", "docs/guide.md:1", "_toc.yml:1"],
            facts: [],
          })),
          limitations: [
            "The deterministic acceptance inventory is bounded to the fixture documentation and navigation contract.",
          ],
        },
      };
    }
    const correction =
      verificationResult && requiresTechnicalCorrection(input) && input.sourceObligationLedger
        ? input.sourceObligationLedger.schemaVersion === 2
          ? await bindHostOwnedTechnicalCorrectionProposalV3(
              {
                kind: TECHNICAL_CORRECTION_PROPOSAL_KIND,
                schemaVersion: 3,
                verdict: verificationResult.review.verdict,
                coverage: verificationResult.coverage,
                factInventory: verificationResult.factInventory,
                issueJudgments: [],
                obligationAccounting: [],
              },
              input.sourceObligationLedger,
              input.originalSourceAuthorityAdmission ??
                (() => {
                  throw new Error(
                    "Offline fixture requires a valid original source authority admission.",
                  );
                })(),
              input.runId ?? "",
              authoritativeReviewTargetPaths(input) ??
                verificationResult.coverage.map(({ path }) => path),
            )
          : bindTechnicalCorrectionResponse(
              { verificationResult, obligationAccounting: [] },
              input.sourceObligationLedger,
              (value) => value as VerificationResult,
            )
        : undefined;
    verificationResult = correction?.verificationResult ?? verificationResult;
    return {
      summary: verificationResult
        ? canonicalizeJsonEvidence(verificationResult as unknown as JsonEvidenceValue).trimEnd()
        : input.step.id === "audit-documentation"
          ? "Replace the vague guide sentence with one explicit governed-delivery evidence statement."
          : input.step.id === "assess-readiness"
            ? "The tracked guide is readable and has one bounded evidence-clarity gap."
            : input.step.id === "plan-documentation"
              ? "Apply the approved clarification only to docs/guide.md."
              : "Applied the exact approved clarification to docs/guide.md.",
      ...(input.step.id === "plan-documentation"
        ? {
            planBinding: documentationPlanBinding(
              input.workflow.name === "update-documentation"
                ? "update"
                : input.workflow.name === "restructure-documentation"
                  ? "restructure"
                  : "create",
              "docs/guide.md",
            ),
            editorialDecisionProposal: {
              schemaVersion: 1 as const,
              kind: "docsfab-editorial-decision-proposal" as const,
              candidate: "update" as const,
              rationale:
                "The admitted public contract and current guide require the bounded governed clarification.",
              evidenceRefs: [requiredEditorialEvidenceReference(input)],
              limitations: [],
              impactBasis: {
                kind: "public-behavior-change" as const,
                rationale:
                  "The governed acceptance declaration requires one source-bound reader clarification.",
                evidence_refs: [this.impactSource],
              },
            },
          }
        : {}),
      ...(input.editorialCandidate &&
      (input.step.id === "verify-technical-accuracy" ||
        input.step.id === "review-documentation" ||
        input.step.id === "test-audience-understanding" ||
        input.step.id === "evaluate-document-quality")
        ? {
            editorialAssessmentProposal: {
              schemaVersion: 1 as const,
              kind: "docsfab-editorial-assessment-proposal" as const,
              assessment:
                input.step.id === "test-audience-understanding"
                  ? ("not-applicable" as const)
                  : ("accepted" as const),
              rationale:
                input.step.id === "test-audience-understanding"
                  ? "The offline fixture has no authorized representative audience observation."
                  : "The offline fixture independently checked the candidate against the retained governed evidence.",
              evidenceRefs: [requiredEditorialEvidenceReference(input)],
              limitations:
                input.step.id === "test-audience-understanding"
                  ? ["audience-check-unavailable"]
                  : [],
              recommendation: null,
            },
          }
        : {}),
      ...(verificationResult ? { verificationResult } : {}),
      ...(correction ? { technicalCorrectionEvidence: correction.evidence } : {}),
      model,
      skill,
      usage,
      tools,
      turns,
    };
  }
}

function documentationPlanBinding(mode: DocumentationPlanMode, pagePath: string) {
  const pages = [{ path: pagePath, disposition: mode }];
  const sourceBindings = [{ pagePath, sources: ["docs/guide.md"] }];
  return {
    kind: "docsfab-documentation-plan" as const,
    schemaVersion: 1 as const,
    mode,
    pages,
    sourceBindings,
    digest: documentationPlanBindingDigest({ mode, pages, sourceBindings }),
  };
}

function requiredEditorialEvidenceReference(input: HarnessStepInput): ArtifactReference {
  const reference = input.editorialEvidenceRefs?.[0];
  if (!reference) {
    throw new Error("Offline delivery acceptance reader evidence is unavailable for admission.");
  }
  return reference;
}

function acceptanceReaderContextInput() {
  return {
    schema_version: 1 as const,
    target_audience: "DocsFab operator",
    reader_job: "Apply the authorized governed documentation clarification.",
    change_scope: ["docs/guide.md"],
    source_priority: ["repository"],
    required_content: ["Governed delivery evidence"],
    excluded_content: [],
    unresolved_questions: [],
  };
}

function acceptanceReaderContextArtifact(index: ContentIndexV1) {
  const node = index.nodes.find(
    (candidate) => candidate.kind === "document" && candidate.sourcePath === "docs/guide.md",
  );
  if (!node) {
    throw new Error("Offline delivery acceptance documentation node is unavailable for admission.");
  }
  return createArtifact(
    "context-packet",
    {
      targetNodeId: node.id,
      pageRole: {
        contentType: "reference",
        readerJob: "reader:delivery-acceptance",
        organizingAxis: "reader-job",
      },
      ancestors: [],
      siblings: [],
      relatedCanonicalPages: [],
      placementRules: { belongsHere: ["reader:delivery-acceptance"], belongsElsewhere: [] },
      activeDecisionIds: [],
      structuralPressure: "healthy",
      evidence: [{ path: node.sourcePath, nodeId: node.id }],
    },
    { index },
  );
}

function acceptanceArtifactReference(
  artifact: ReturnType<typeof acceptanceReaderContextArtifact>,
): ArtifactReference {
  return {
    kind: artifact.kind,
    schemaVersion: 1,
    digest: artifact.digest,
    repositoryRevision: artifact.repository.revision,
    repositoryContentDigest: artifact.repository.contentDigest,
  };
}

/**
 * Observation search is revision-bound. Later verify steps revalidate at the
 * post-write workspace snapshot; reuse attaches sealed evidence without a
 * second probe.
 */
class FrozenRevisionSearchCoordinator implements WorkflowSearchCoordinator {
  public constructor(private readonly inner: LocalWorkflowSearchCoordinator) {}

  public async search(
    input: WorkflowSearchCoordinatorInput,
  ): Promise<WorkflowSearchCoordinatorResultV1> {
    return this.inner.search(input);
  }
}

async function runGovernedDeliveryChain(input: {
  root: string;
  source: string;
  revision: string;
  stateDirectory: string;
}): Promise<GovernedDeliveryChain> {
  const canonicalSource = await realpath(input.source);
  const sourceGuideBytes = await readFile(join(canonicalSource, "docs/guide.md"));
  const sourceGuideSha256 = sha256(sourceGuideBytes);
  const harness = new OfflineGovernedHarness({
    uri: "docs/guide.md",
    sha256: sourceGuideSha256,
  });
  const scanner = new LocalRepositorySecurityScanner();
  const contextPreflight = new LocalContextPreflightService({
    cacheRoot: join(input.root, "context-cache"),
  });
  const store = new FileRunStore(input.stateDirectory);
  const repository = {
    sourcePath: canonicalSource,
    requestedRevision: "HEAD",
    revision: input.revision,
  };
  const runReadOnly = async (
    workflow: "readiness" | "review-documentation",
    runId: string,
    base: string,
  ): Promise<{ record: RunRecord; bytes: Buffer }> => {
    const workspace = await prepareRepositoryWorkspace(canonicalSource, input.revision);
    let tick = 0;
    try {
      const record = await new WorkflowRunner({
        harness,
        store,
        repositoryScanner: scanner,
        contextPreflight,
        hostOperations: new WorkflowChecksHostOperation(workspace),
        workflowSearch: new LocalWorkflowSearchCoordinator({ workspace }),
        sourceObligationObserver: new LocalSourceObligationSourceObserver(workspace),
        now: () => new Date(Date.parse(base) + tick++ * 1_000),
      }).run({
        runId,
        workflow,
        workspacePath: workspace.path,
        repository,
        allowWrite: false,
      });
      if (record.status !== "succeeded") {
        throw new Error(`Governed ${workflow} acceptance run failed.`);
      }
      const bytes = await readFile(join(input.stateDirectory, `${runId}.json`));
      return { record: decodeAcceptanceRunRecord(bytes), bytes };
    } finally {
      await workspace.dispose();
    }
  };

  const readiness = await runReadOnly(
    "readiness",
    "delivery-acceptance-readiness",
    "2026-08-04T00:00:00.000Z",
  );
  const audit = await runReadOnly(
    "review-documentation",
    "delivery-acceptance-audit",
    "2026-08-04T00:10:00.000Z",
  );
  const guideBytes = await readFile(join(canonicalSource, "docs", "guide.md"));
  const gapEvidence = [{ path: "docs/guide.md", sha256: sha256(guideBytes) }];
  const successCriterion =
    "Clarify the governed delivery evidence statement without changing runtime behavior.";
  const authority = generateKeyPairSync("ed25519");
  const policyValue = {
    id: "docsfab:delivery-acceptance-reviewers",
    version: "1",
    reviewers: [
      {
        id: "maintainer.delivery",
        role: "maintainer" as const,
        publicKey: authority.publicKey.export({ type: "spki", format: "pem" }).toString(),
      },
    ],
  };
  const reviewerPolicy: IaPlanReviewerPolicy = {
    ...policyValue,
    digest: iaPlanReviewerPolicyDigest(policyValue),
  };
  const approvedProposal = audit.record.steps.at(-1)?.summary;
  if (!approvedProposal) throw new Error("Governed audit did not produce a proposal.");
  const authorizationStatement = {
    schemaVersion: 1 as const,
    kind: "bounded-doc-improvement-authorization" as const,
    campaignId: "delivery-acceptance-campaign",
    repository: {
      id: "group/docs",
      identitySha256: sha256(canonicalSource),
      revision: input.revision,
    },
    analysis: {
      runId: audit.record.id,
      recordSha256: sha256(audit.bytes),
    },
    gap: {
      id: "governed-delivery-evidence-gap",
      evidenceSha256: canonicalDigest(gapEvidence),
      successCriterionSha256: canonicalDigest(successCriterion),
    },
    intendedPaths: ["docs/guide.md"],
    approvedOutcomeSha256: canonicalDigest(approvedProposal),
    decision: "approved" as const,
    reviewer: { id: "maintainer.delivery", role: "maintainer" as const },
    policy: {
      id: reviewerPolicy.id,
      version: reviewerPolicy.version,
      digest: reviewerPolicy.digest,
    },
    decidedAt: "2026-08-04T00:30:00.000Z",
    expiresAt: "2026-08-04T02:00:00.000Z",
  };
  const signature = signBytes(
    null,
    Buffer.from(canonicalDigest(authorizationStatement), "hex"),
    authority.privateKey,
  ).toString("base64url");
  const authorizationWithoutDigest = { ...authorizationStatement, signature };
  const authorization = {
    ...authorizationWithoutDigest,
    digest: canonicalDigest(authorizationWithoutDigest),
  };
  const authorizationBytes = jsonBytes(authorization);
  const provisionalDeclarationWithoutDigest = {
    schemaVersion: 1 as const,
    kind: "bounded-doc-improvement-campaign" as const,
    campaignId: authorization.campaignId,
    repositoryId: authorization.repository.id,
    testedCommit: input.revision,
    repositoryIdentitySha256: authorization.repository.identitySha256,
    gap: {
      id: authorization.gap.id,
      evidence: gapEvidence,
      successCriterion,
    },
    inputs: {
      analysisRecord: { file: "audit.json", sha256: sha256(audit.bytes) },
      authorization: {
        file: "authorization.json",
        sha256: sha256(authorizationBytes),
      },
      applicationRecord: { file: "application.json", sha256: "0".repeat(64) },
      patch: {
        file: "application.patch",
        sha256: "0".repeat(64),
        byteLength: 1,
      },
      independentReview: { file: "review.json", sha256: "0".repeat(64) },
    },
    validationProfile: "default" as const,
    generatedAt: "2026-08-04T00:30:30.000Z",
  };
  const declaration = {
    ...provisionalDeclarationWithoutDigest,
    digest: canonicalDigest(provisionalDeclarationWithoutDigest),
  };
  const declarationBytes = jsonBytes(declaration);
  const reviewerPolicyBytes = jsonBytes(reviewerPolicy);
  const task = authorizeBoundedDocImprovementWrite({
    declaration,
    declarationBytes,
    analysisRecord: audit.record,
    analysisRecordBytes: audit.bytes,
    authorization,
    authorizationBytes,
    reviewerPolicy,
    evaluatedAt: "2026-08-04T00:31:00.000Z",
  });

  const privateChainRoot = join(input.root, "governed-chain");
  await mkdir(privateChainRoot, { mode: 0o700 });
  await Promise.all([
    writePrivateExclusive(
      join(privateChainRoot, "write-authorization-declaration.json"),
      declarationBytes,
    ),
    writePrivateExclusive(join(privateChainRoot, "authorization.json"), authorizationBytes),
    writePrivateExclusive(join(privateChainRoot, "reviewer-policy.json"), reviewerPolicyBytes),
    writePrivateExclusive(join(privateChainRoot, "readiness.json"), readiness.bytes),
    writePrivateExclusive(join(privateChainRoot, "audit.json"), audit.bytes),
  ]);

  const workspace = await prepareRepositoryWorkspace(canonicalSource, input.revision);
  const evidence = await GitPatchEvidenceCollector.create(
    workspace.path,
    join(input.root, "patches"),
  );
  let applicationRecord: RunRecord;
  let patchBytes: Buffer;
  let writeTick = 0;
  try {
    const index = await buildContentIndex({
      repositoryPath: workspace.path,
      repositoryRevision: input.revision,
    });
    const guideBytes = await readFile(join(workspace.path, "docs/guide.md"));
    const guideSha256 = sha256(guideBytes);
    const readerContextInput = acceptanceReaderContextInput();
    const verifiedQualityPack = await verifyQualityPackContext(resolveDocsFabRuntimeAssetPaths());
    const readerTaskContextSupplier = await createReaderTaskContextSupplier(verifiedQualityPack);
    const readerTaskContext = readerTaskContextSupplier.projectInput(readerContextInput, {
      inputOrigin: "explicit",
    });
    const readerEvidenceArtifact = acceptanceReaderContextArtifact(index);
    const readerEvidenceReference = acceptanceArtifactReference(readerEvidenceArtifact);
    const workspaceSnapshotSha256 = index.repository.contentDigest;
    const repositoryIdentitySha256 = canonicalDigest({
      sourcePath: canonicalSource,
      revision: input.revision,
    });
    const policy = readerTaskContext.policy;
    const baselineSha256 = readerTaskContext.baseline.sha256;
    const comparison = {
      kind: "base-head" as const,
      base_revision: input.revision,
      head_revision: input.revision,
    };
    const provenanceLimitations = [READER_CONTEXT_CHANGED_SOURCE_INAPPLICABLE_LIMITATION];
    const sourceBytes = [
      {
        source: {
          uri: "docs/guide.md",
          role: "current-documentation" as const,
          sha256: guideSha256,
        },
        bytes: guideBytes,
      },
      {
        source: {
          uri: "docs/guide.md",
          role: "public-contract" as const,
          sha256: guideSha256,
        },
        bytes: guideBytes,
      },
    ];
    const workflowBranchEvidence = await createEditorialEvidenceHostV1({
      store: new DurableArtifactStore(join(dirname(input.stateDirectory), "artifacts")),
      index,
      readerContextInput,
      baselineSha256,
      policy,
      comparison,
      repositoryIdentitySha256,
      workspaceSnapshotSha256,
      observedAt: "2026-08-04T00:39:00.000Z",
      provenanceLimitations,
      sources: sourceBytes,
      admittedArtifacts: [readerEvidenceArtifact],
      audienceProtocol: "not-supplied",
      projectCompletedReaderTaskContext: ({ readerContext, provenance, admission }) =>
        readerTaskContextSupplier.projectCompleted({
          readerContext,
          provenance,
          admission,
          inputOrigin: "explicit",
        }),
    });
    const impactPostflight = new LocalImpactPostflightService(index);
    applicationRecord = await new WorkflowRunner({
      harness,
      store,
      repositoryScanner: scanner,
      contextPreflight,
      hostOperations: new WorkflowChecksHostOperation(workspace),
      workflowSearch: new FrozenRevisionSearchCoordinator(
        new LocalWorkflowSearchCoordinator({ workspace }),
      ),
      sourceObligationObserver: new LocalSourceObligationSourceObserver(workspace),
      impactPostflight,
      repositoryEvidence: evidence,
      workflowBranchEvidence,
      outcomeProjector: new AuthoringQualityWorkflowOutcomeProjector(),
      now: () => new Date(Date.parse("2026-08-04T00:40:00.000Z") + writeTick++ * 1_000),
    }).run({
      runId: RUN_ID,
      workflow: "update-documentation",
      workspacePath: workspace.path,
      repository,
      task,
      allowWrite: true,
      readerTaskContext,
      editorialEvidenceRefs: [readerEvidenceReference],
    });
    if (applicationRecord.status !== "succeeded" || !applicationRecord.changes?.patch) {
      throw new Error(
        `Governed authorized write did not succeed with a patch: ${applicationRecord.error ?? applicationRecord.status}.`,
      );
    }
    patchBytes = await readFile(applicationRecord.changes.patch.artifactPath);
  } finally {
    await evidence.dispose();
    await workspace.dispose();
  }
  const applicationBytes = await readFile(join(input.stateDirectory, `${RUN_ID}.json`));
  const finalDeclarationWithoutDigest = {
    ...provisionalDeclarationWithoutDigest,
    inputs: {
      ...provisionalDeclarationWithoutDigest.inputs,
      applicationRecord: {
        file: "application.json",
        sha256: sha256(applicationBytes),
      },
      patch: {
        file: "application.patch",
        sha256: sha256(patchBytes),
        byteLength: patchBytes.byteLength,
      },
    },
  };
  const finalDeclaration = {
    ...finalDeclarationWithoutDigest,
    digest: canonicalDigest(finalDeclarationWithoutDigest),
  };
  const finalDeclarationBytes = jsonBytes(finalDeclaration);
  await writePrivateExclusive(join(privateChainRoot, "application.json"), applicationBytes);
  await writePrivateExclusive(join(privateChainRoot, "application.patch"), patchBytes);
  await writePrivateExclusive(join(privateChainRoot, "declaration.json"), finalDeclarationBytes);
  return {
    governedRuns: {
      readiness: runBinding(readiness.record, readiness.bytes),
      audit: runBinding(audit.record, audit.bytes),
      write: runBinding(applicationRecord, applicationBytes),
    },
    chainEvidencePaths: {
      readinessRecordPath: join(privateChainRoot, "readiness.json"),
      declarationPath: join(privateChainRoot, "declaration.json"),
      analysisRecordPath: join(privateChainRoot, "audit.json"),
      authorizationPath: join(privateChainRoot, "authorization.json"),
      reviewerPolicyPath: join(privateChainRoot, "reviewer-policy.json"),
      applicationRecordPath: join(privateChainRoot, "application.json"),
      patchPath: join(privateChainRoot, "application.patch"),
    },
    authorization: {
      sha256: sha256(authorizationBytes),
      digest: authorization.digest,
      reviewerId: authorization.reviewer.id,
      policyDigest: authorization.policy.digest,
      decidedAt: authorization.decidedAt,
      expiresAt: authorization.expiresAt,
      gapId: authorization.gap.id,
      evidenceSha256: authorization.gap.evidenceSha256,
      successCriterionSha256: authorization.gap.successCriterionSha256,
      approvedOutcomeSha256: authorization.approvedOutcomeSha256,
      intendedPaths: [...authorization.intendedPaths],
    },
    applicationRecord,
    patchBytes,
  };
}

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`);
}

function runBinding(record: RunRecord, bytes: Uint8Array): DeliveryAcceptanceRunBindingV1 {
  if (
    record.status !== "succeeded" ||
    (record.workflow !== "readiness" &&
      record.workflow !== "review-documentation" &&
      record.workflow !== "update-documentation")
  ) {
    throw new Error("Delivery acceptance cannot bind a non-terminal governed run.");
  }
  return {
    id: record.id,
    recordSha256: sha256(bytes),
    workflow: record.workflow,
    status: "succeeded",
    outcome: getWorkflow(record.workflow).outcome,
    changedPaths: [...new Set((record.changes?.files ?? []).map((file) => file.path))].sort(),
  };
}

async function preflight(
  fixture: OfflineFixture,
  mode: AttemptMode = {},
  validationCommand = "node validate.cjs",
): Promise<LocalUserPublicationPlan> {
  const fake = new OfflineFakeGitLab(fixture, undefined, mode);
  const editorialDecodeOptions = await acceptanceEditorialDecodeOptions(fixture);
  return preflightLocalUserGitLabPublication(
    {
      runId: RUN_ID,
      runRecordPath: fixture.recordPath,
      repositoryPath: fixture.source,
      validationCommand,
      draftMergeRequest: true,
    },
    new OfflinePreflightRunner(fake),
    editorialDecodeOptions,
  );
}

async function executeAttempt(
  fixture: OfflineFixture,
  plan: LocalUserPublicationPlan,
  mode: AttemptMode,
): Promise<LocalUserGitLabPublicationResultV1> {
  const logs: string[] = [];
  const fake = new OfflineFakeGitLab(fixture, plan, mode);
  const editorialDecodeOptions = await acceptanceEditorialDecodeOptions(fixture);
  const gitPublisher = new DeterministicLocalGitPublisher(
    new BareRemoteGitRunner(fixture.bareRemote, mode.denyPush === true),
    {
      ...process.env,
      DOCSFAB_ACCEPTANCE_CREDENTIAL_CANARY: OFFLINE_ISOLATION_CANARY,
      GLAB_TOKEN: OFFLINE_ISOLATION_CANARY,
      GITLAB_TOKEN: OFFLINE_ISOLATION_CANARY,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "url.https://network-canary.invalid/.insteadOf",
      GIT_CONFIG_VALUE_0: REMOTE_URL,
      HTTPS_PROXY: "http://network-canary.invalid",
    },
  );
  const hooks = mode.crashAfter
    ? {
        ...(mode.crashAfter === "commit"
          ? {
              afterCommit: async (revision: string) =>
                crashAfterBoundary(fixture, "commit", { revision }),
            }
          : {}),
        ...(mode.crashAfter === "push"
          ? {
              afterPush: async (revision: string) =>
                crashAfterBoundary(fixture, "push", { revision }),
            }
          : {}),
        ...(mode.crashAfter === "merge-request"
          ? {
              afterMergeRequest: async (mergeRequest: { iid: number; headRevision: string }) =>
                crashAfterBoundary(fixture, "merge-request", {
                  revision: mergeRequest.headRevision,
                  mergeRequestIid: mergeRequest.iid,
                }),
            }
          : {}),
      }
    : undefined;
  await runLocalUserPublishExecuteCli(
    [
      RUN_ID,
      "--repo",
      fixture.source,
      "--draft-mr",
      "--execute",
      "--confirm-plan-sha256",
      plan.sha256,
      "--delivery-root",
      fixture.deliveryRoot,
      "--receipt-root",
      fixture.receiptRoot,
      "--state-dir",
      fixture.stateDirectory,
      "--validation-command",
      plan.validationCommand,
    ],
    {
      cwd: fixture.root,
      stateDirectory: fixture.stateDirectory,
      log: (message) => logs.push(message),
      commands: new OfflinePreflightRunner(fake),
      preflight: async () => plan,
      isolateValidation: async () => ({ commandPrefix: [] }),
      publisher: {
        git: gitPublisher,
        gitlab: new LocalUserGitLabPublisherAdapter(fake, {}),
        ...(hooks ? { hooks } : {}),
      },
      ...(editorialDecodeOptions ? { editorialDecodeOptions } : {}),
    },
  );
  return decodeLocalUserGitLabPublicationResult(parseJsonEvidence(logs.at(-1) ?? "{}"));
}

async function acceptanceEditorialDecodeOptions(fixture: OfflineFixture) {
  const record = parseJsonEvidence(await readFile(fixture.recordPath)) as unknown as RunRecord;
  return loadSavedRunEditorialDecodeOptions(record, fixture.stateDirectory);
}

async function loadReceipt(
  fixture: OfflineFixture,
  plan: LocalUserPublicationPlan,
): Promise<ScmDeliveryRecord> {
  const receipt = await new FileScmDeliveryReceiptStore(fixture.receiptRoot).load(
    scmDeliveryIdempotencyKey(plan),
  );
  if (!receipt) throw new Error("Offline delivery receipt is missing.");
  return receipt;
}

async function runFailureMatrix(
  stateRoot: string,
  testedRevision: string,
  duplicateObservation: MatrixObservation,
): Promise<DeliveryAcceptanceCaseResult[]> {
  const results = new Map<string, DeliveryAcceptanceCaseResult>();
  const pass = (
    id: DeliveryAcceptanceCaseResult["id"],
    expectedFailureCode: string,
    observation: MatrixObservation,
    observedFailureCode = expectedFailureCode,
    expectedExternalMutationCount = 0,
  ): void => {
    results.set(id, {
      id,
      status: "passed",
      expectedFailureCode,
      observedFailureCode,
      ...observation,
      expectedExternalMutationCount,
    });
  };

  await withFailureFixture(stateRoot, "dirty", async (fixture) => {
    await writeFile(join(fixture.source, "README.md"), "dirty tracked source\n");
    const before = await deliveryAcceptanceSourceCheckoutSha256(fixture.source);
    const plan = await preflight(fixture);
    await executeAttempt(fixture, plan, {});
    pass(
      "dirty-source",
      "published",
      await observeMatrixState(fixture, plan, before),
      "published",
      2,
    );
  });
  await withFailureFixture(stateRoot, "stale", async (fixture) => {
    const tree = await gitText(fixture.source, ["rev-parse", `${fixture.sourceRevision}^{tree}`]);
    const stale = await gitText(fixture.source, [
      "-c",
      "commit.gpgsign=false",
      "commit-tree",
      tree,
      "-p",
      fixture.sourceRevision,
      "-m",
      "stale GitLab target",
    ]);
    const fake = await loadFakeGitLabState(fixture.fakeGitLabStatePath);
    await saveFakeGitLabState(fixture.fakeGitLabStatePath, {
      ...fake,
      targetRevision: stale,
    });
    const before = await deliveryAcceptanceSourceCheckoutSha256(fixture.source);
    await expectFailure(() => preflight(fixture), "stale-revision");
    pass("stale-revision", "stale-revision", await observeMatrixState(fixture, undefined, before));
  });
  await withFailureFixture(
    stateRoot,
    "conflict",
    async (fixture) => {
      const plan = await preflight(fixture);
      const before = await deliveryAcceptanceSourceCheckoutSha256(fixture.source);
      await expectFailure(() => executeAttempt(fixture, plan, {}), "patch-conflict");
      pass("patch-conflict", "patch-conflict", await observeMatrixState(fixture, plan, before));
    },
    "patch-conflict",
  );
  await withFailureFixture(stateRoot, "validation", async (fixture) => {
    const plan = await preflight(fixture, {}, "node fail.cjs");
    const before = await deliveryAcceptanceSourceCheckoutSha256(fixture.source);
    await expectFailure(() => executeAttempt(fixture, plan, {}), "validation-failed");
    pass(
      "validation-failure",
      "validation-failed",
      await observeMatrixState(fixture, plan, before),
    );
  });
  await withFailureFixture(stateRoot, "authorization", async (fixture) => {
    const before = await deliveryAcceptanceSourceCheckoutSha256(fixture.source);
    await expectFailure(
      () =>
        runLocalUserPublishExecuteCli(
          [
            RUN_ID,
            "--repo",
            fixture.source,
            "--draft-mr",
            "--execute",
            "--delivery-root",
            fixture.deliveryRoot,
            "--receipt-root",
            fixture.receiptRoot,
          ],
          {
            cwd: fixture.root,
            stateDirectory: fixture.stateDirectory,
            log: () => undefined,
          },
        ),
      "confirm-plan-sha256",
    );
    pass(
      "missing-authorization",
      "invalid-input",
      await observeMatrixState(fixture, undefined, before),
      "invalid-input",
    );
  });
  await withFailureFixture(stateRoot, "push", async (fixture) => {
    const plan = await preflight(fixture);
    const before = await deliveryAcceptanceSourceCheckoutSha256(fixture.source);
    await expectFailure(() => executeAttempt(fixture, plan, { denyPush: true }), "push-failed");
    pass("denied-push", "push-failed", await observeMatrixState(fixture, plan, before));
  });
  await withFailureFixture(stateRoot, "protection", async (fixture) => {
    const plan = await preflight(fixture);
    const before = await deliveryAcceptanceSourceCheckoutSha256(fixture.source);
    await expectFailure(
      () => executeAttempt(fixture, plan, { protectionDrift: true }),
      "remote-drift",
    );
    pass("protection-drift", "remote-drift", await observeMatrixState(fixture, plan, before));
  });

  // The successful primary scenario proves duplicate reuse. Restart cases use
  // independent OS processes so no in-memory adapter state can bridge a crash.
  pass("duplicate-invocation", "reused", duplicateObservation, "reused", 2);
  for (const boundary of ["commit", "push", "merge-request"] as const) {
    const id = `interruption-after-${boundary}` as DeliveryAcceptanceCaseResult["id"];
    await withFailureFixture(stateRoot, `restart-${boundary}`, async (fixture) => {
      const plan = await preflight(fixture);
      const before = await deliveryAcceptanceSourceCheckoutSha256(fixture.source);
      await runCrashWorker(fixture, plan, boundary);
      const interrupted = await observeInterruptedBoundary(fixture, plan, boundary);
      await executeAttempt(fixture, plan, {});
      const receipt = await loadReceipt(fixture, plan);
      if (receipt.state !== "opened" || receipt.disposition !== "succeeded") {
        throw new Error(`Restart after ${boundary} did not reach terminal success.`);
      }
      const fake = await loadFakeGitLabState(fixture.fakeGitLabStatePath);
      if (fake.createCount !== 1) throw new Error(`Restart after ${boundary} duplicated the MR.`);
      const remote = await bareRevision(fixture.bareRemote, plan.proposedSourceBranch);
      if (
        receipt.evidence.commit?.sha !== interrupted.commitRevision ||
        remote !== interrupted.commitRevision ||
        receipt.evidence.mergeRequest?.headRevision !== interrupted.commitRevision
      ) {
        throw new Error(`Restart after ${boundary} did not reuse the exact interrupted effects.`);
      }
      pass(id, "resumed", await observeMatrixState(fixture, plan, before), "resumed", 2);
    });
  }
  if (results.size !== DELIVERY_ACCEPTANCE_CASE_IDS.length) {
    throw new Error(`Incomplete delivery acceptance failure matrix at ${testedRevision}.`);
  }
  return DELIVERY_ACCEPTANCE_CASE_IDS.map((id) => results.get(id)!);
}

async function observeInterruptedBoundary(
  fixture: OfflineFixture,
  plan: LocalUserPublicationPlan,
  boundary: "commit" | "push" | "merge-request",
): Promise<{ commitRevision: string }> {
  const receipt = await loadReceipt(fixture, plan);
  const expectedState =
    boundary === "commit" ? "committed" : boundary === "push" ? "pushed" : "opened";
  const expectedDisposition = boundary === "merge-request" ? "succeeded" : "active";
  if (receipt.state !== expectedState || receipt.disposition !== expectedDisposition) {
    throw new Error(`Interrupted ${boundary} receipt did not durably preserve its prior boundary.`);
  }
  const local = await gitText(fixture.source, [
    "rev-parse",
    `refs/heads/${plan.proposedSourceBranch}`,
  ]);
  if (local === plan.baseRevision) {
    throw new Error(`Interrupted ${boundary} did not durably create its local commit.`);
  }
  const remote = await bareRevision(fixture.bareRemote, plan.proposedSourceBranch);
  const fake = await loadFakeGitLabState(fixture.fakeGitLabStatePath);
  if (boundary === "commit") {
    if (
      receipt.evidence.commit?.sha !== local ||
      receipt.evidence.push !== undefined ||
      receipt.evidence.mergeRequest !== undefined ||
      remote !== undefined ||
      fake.createCount !== 0 ||
      fake.mergeRequest !== undefined
    ) {
      throw new Error("Commit interruption crossed a later mutation boundary.");
    }
  } else if (boundary === "push") {
    if (
      receipt.evidence.commit?.sha !== local ||
      receipt.evidence.push?.remoteRevision !== local ||
      remote !== local ||
      receipt.evidence.mergeRequest !== undefined ||
      fake.createCount !== 0 ||
      fake.mergeRequest !== undefined
    ) {
      throw new Error("Push interruption did not leave exactly one observable remote effect.");
    }
  } else if (
    receipt.evidence.commit?.sha !== local ||
    receipt.evidence.push?.remoteRevision !== local ||
    remote !== local ||
    fake.createCount !== 1 ||
    fake.mergeRequest?.sha !== local
  ) {
    throw new Error("Merge-request interruption did not leave exactly one observable MR effect.");
  }
  return { commitRevision: local };
}

async function loadAcceptanceCaseContract(): Promise<
  Array<{
    id: DeliveryAcceptanceCaseResult["id"];
    expected: string;
  }>
> {
  const path = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../test/fixtures/runtime-evaluation/delivery/acceptance-cases.json",
  );
  const value = parseAcceptanceJson(await readFile(path), 1024 * 1024, "case contract");
  if (
    !isPlainRecord(value) ||
    Object.keys(value).sort().join(",") !== "cases,schemaVersion" ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.cases) ||
    value.cases.length !== DELIVERY_ACCEPTANCE_CASE_IDS.length
  ) {
    throw new Error("Invalid delivery acceptance case contract.");
  }
  return value.cases.map((entry, index) => {
    if (
      !isPlainRecord(entry) ||
      Object.keys(entry).sort().join(",") !== "expected,id" ||
      entry.id !== DELIVERY_ACCEPTANCE_CASE_IDS[index] ||
      typeof entry.expected !== "string" ||
      !/^[a-z0-9][a-z0-9-]{0,127}$/u.test(entry.expected)
    ) {
      throw new Error("Invalid delivery acceptance case contract.");
    }
    return {
      id: entry.id as DeliveryAcceptanceCaseResult["id"],
      expected: entry.expected,
    };
  });
}

async function withFailureFixture(
  stateRoot: string,
  name: string,
  action: (fixture: OfflineFixture) => Promise<void>,
  variant: "normal" | "patch-conflict" = "normal",
): Promise<void> {
  const root = await mkdtemp(join(stateRoot, `delivery-case-${name}-`));
  await chmod(root, 0o700);
  await action(await createOfflineFixture(root, variant));
}

async function observeMatrixState(
  fixture: OfflineFixture,
  plan: LocalUserPublicationPlan | undefined,
  sourceBeforeSha256: string,
): Promise<MatrixObservation> {
  const [sourceAfterSha256, patchBytes, worktreeEntries, fake] = await Promise.all([
    deliveryAcceptanceSourceCheckoutSha256(fixture.source),
    readFile(fixture.patchPath),
    readdir(fixture.deliveryRoot),
    loadFakeGitLabState(fixture.fakeGitLabStatePath),
  ]);
  const receipt = plan
    ? await new FileScmDeliveryReceiptStore(fixture.receiptRoot).load(
        scmDeliveryIdempotencyKey(plan),
      )
    : undefined;
  const remote = plan
    ? await bareRevision(fixture.bareRemote, plan.proposedSourceBranch)
    : undefined;
  const patchPreserved = sha256(patchBytes) === fixture.patchSha256;
  const sourceCheckoutUnchanged = sourceAfterSha256 === sourceBeforeSha256;
  if (!patchPreserved || !sourceCheckoutUnchanged) {
    throw new Error("Delivery acceptance case did not preserve its patch and source checkout.");
  }
  const nextAction =
    receipt?.failure?.nextAction ??
    receipt?.recovery?.nextAction ??
    (receipt?.state === "opened" ? "none" : "review-preserved-patch");
  return {
    patchPreserved: true,
    nextAction,
    sourceCheckoutUnchanged: true,
    worktreeState: worktreeEntries.length === 0 ? "absent" : "preserved",
    receiptState: receipt?.state ?? "absent",
    remoteBranchState: remote === undefined ? "absent" : "present",
    mergeRequestState: fake.mergeRequest === undefined ? "absent" : "opened",
    observedExternalMutationCount: Number(remote !== undefined) + fake.createCount,
  };
}

async function expectFailure(action: () => Promise<unknown>, fragment: string): Promise<void> {
  try {
    await action();
  } catch (error) {
    const message = error instanceof Error ? `${error.name}:${error.message}` : String(error);
    if (message.includes(fragment) || normalizeFailure(message) === fragment) return;
    throw new Error(`Expected ${fragment}; observed ${message}`);
  }
  throw new Error(`Expected ${fragment}; operation succeeded.`);
}

function normalizeFailure(message: string): string {
  const match = /\(([a-z0-9-]+)\)/u.exec(message);
  return match?.[1] ?? message;
}

async function runCrashWorker(
  fixture: OfflineFixture,
  plan: LocalUserPublicationPlan,
  boundary: "commit" | "push" | "merge-request",
): Promise<void> {
  const configPath = join(fixture.root, `worker-${boundary}.json`);
  await writeFile(configPath, `${JSON.stringify({ fixture, plan, boundary })}\n`, { mode: 0o600 });
  const worker = resolve(dirname(fileURLToPath(import.meta.url)), "acceptance-worker.ts");
  const result = await command(
    process.execPath,
    ["--import", TSX_IMPORT_PATH, worker, configPath],
    fixture.root,
    process.env,
  );
  if (result.exitCode === 0) throw new Error(`Crash worker did not stop after ${boundary}.`);
  let marker: unknown;
  try {
    marker = parseAcceptanceJson(
      await readFile(join(fixture.root, `crash-boundary-${boundary}.json`)),
      64 * 1024,
      "crash marker",
    );
  } catch {
    const failure = await readFile(
      join(fixture.root, `crash-worker-error-${boundary}.json`),
      "utf8",
    ).catch(() => Buffer.from("unrecorded-worker-failure"));
    throw new Error(`Crash worker failed before ${boundary}: ${failure.toString("utf8").trim()}`);
  }
  if (
    !isPlainRecord(marker) ||
    marker.schemaVersion !== 1 ||
    marker.boundary !== boundary ||
    typeof marker.revision !== "string" ||
    !/^[a-f0-9]{40}$/u.test(marker.revision) ||
    (boundary === "merge-request") !== Number.isSafeInteger(marker.mergeRequestIid)
  ) {
    throw new Error(`Crash worker did not durably reach the injected ${boundary} boundary.`);
  }
}

export async function runOfflineDeliveryAcceptanceWorker(configPath: string): Promise<void> {
  const value = parseAcceptanceJson(
    await readFile(configPath),
    4 * 1024 * 1024,
    "worker config",
  ) as unknown as {
    fixture: OfflineFixture;
    plan: LocalUserPublicationPlan;
    boundary: "commit" | "push" | "merge-request";
  };
  try {
    await executeAttempt(value.fixture, value.plan, {
      crashAfter: value.boundary,
    });
  } catch (error) {
    await writePrivateExclusive(
      join(value.fixture.root, `crash-worker-error-${value.boundary}.json`),
      Buffer.from(
        `${JSON.stringify({
          schemaVersion: 1,
          boundary: value.boundary,
          error: error instanceof Error ? `${error.name}:${error.message}` : "unknown",
        })}\n`,
      ),
    );
    throw error;
  }
}

class OfflinePreflightRunner implements ReadOnlyCommandRunner {
  public constructor(private readonly fake: OfflineFakeGitLab) {}

  public async run(
    commandName: "git" | "glab" | "gh",
    args: readonly string[],
    cwd: string,
    options?: { env?: NodeJS.ProcessEnv },
  ): Promise<ReadOnlyCommandResult> {
    if (commandName === "glab") {
      const result = await this.fake.execute(args);
      return {
        exitCode: result.exitCode,
        stdout: result.stdout.toString("utf8"),
      };
    }
    if (commandName === "gh") {
      throw new Error(
        "Offline GitLab preflight refuses gh because this runner only supports Git and glab.",
      );
    }
    const result = await command("git", [...args], cwd, options?.env ?? process.env);
    return {
      exitCode: result.exitCode,
      stdout: result.stdout.toString("utf8"),
    };
  }
}

class BareRemoteGitRunner implements GitPublisherCommandRunner {
  public constructor(
    private readonly bareRemote: string,
    private readonly denyPush: boolean,
  ) {}

  public async run(
    _commandName: "git",
    args: readonly string[],
    cwd: string,
    options: {
      env: NodeJS.ProcessEnv;
      stdin?: Uint8Array;
      timeoutMs: number;
      maxOutputBytes: number;
    },
  ): Promise<GitPublisherCommandResult> {
    if (
      Object.values(options.env).includes(OFFLINE_ISOLATION_CANARY) ||
      options.env.GIT_CONFIG_COUNT !== undefined ||
      options.env.HTTPS_PROXY !== undefined
    ) {
      throw new Error("Offline Git runner received an ambient credential or network canary.");
    }
    const operation = stripGitConfig(args);
    if (this.denyPush && operation[0] === "push") return { exitCode: 1, stdout: Buffer.alloc(0) };
    const rewritten = args.map((argument) =>
      argument === REMOTE_URL
        ? this.bareRemote
        : argument === "protocol.https.allow=always"
          ? "protocol.file.allow=always"
          : argument,
    );
    if (
      rewritten.some(
        (argument) =>
          argument.includes(PROJECT_HOST) || argument.includes("network-canary.invalid"),
      )
    ) {
      throw new Error("Offline Git runner retained a network destination.");
    }
    const result = await command("git", rewritten, cwd, options.env, options.stdin);
    return { exitCode: result.exitCode, stdout: result.stdout };
  }
}

async function secureExternalRoot(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error("Delivery acceptance roots must be absolute.");
  let details;
  try {
    details = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = await realpath(dirname(path));
    if (join(parent, basename(path)) !== path) {
      throw new Error("Delivery acceptance roots cannot traverse symlinked ancestors.");
    }
    await mkdir(path, { mode: 0o700 });
    details = await lstat(path);
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (
    details.isSymbolicLink() ||
    !details.isDirectory() ||
    uid === undefined ||
    details.uid !== uid
  ) {
    throw new Error("Delivery acceptance roots must be owner-controlled real directories.");
  }
  await chmod(path, 0o700);
  const tightened = await lstat(path);
  if (
    tightened.dev !== details.dev ||
    tightened.ino !== details.ino ||
    (tightened.mode & 0o777) !== 0o700
  ) {
    throw new Error("Delivery acceptance roots must be owner-private.");
  }
  return realpath(path);
}

async function writePrivateExclusive(path: string, bytes: Buffer): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function git(
  cwd: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const result = await command("git", args, cwd, {
    ...process.env,
    ...environment,
  });
  if (result.exitCode !== 0)
    throw new Error(`Fixture git command failed (${args[0] ?? "unknown"}).`);
}

async function gitText(cwd: string, args: readonly string[]): Promise<string> {
  return (await gitBuffer(cwd, args)).toString("utf8").trim();
}

async function gitBuffer(cwd: string, args: readonly string[]): Promise<Buffer> {
  const result = await command("git", args, cwd, process.env);
  if (result.exitCode !== 0) throw new Error(`Fixture git read failed (${args[0] ?? "unknown"}).`);
  return result.stdout;
}

function stripGitConfig(args: readonly string[]): readonly string[] {
  let index = 0;
  while (args[index] === "-c" && args[index + 1] !== undefined) index += 2;
  return args.slice(index);
}

function assertRevision(value: string): void {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value)) throw new Error("Invalid tested revision.");
}

function crashProcess(): never {
  process.kill(process.pid, "SIGKILL");
  throw new Error("Crash injection failed.");
}

async function crashAfterBoundary(
  fixture: OfflineFixture,
  boundary: "commit" | "push" | "merge-request",
  evidence: { revision: string; mergeRequestIid?: number },
): Promise<never> {
  await writePrivateExclusive(
    join(fixture.root, `crash-boundary-${boundary}.json`),
    Buffer.from(`${JSON.stringify({ schemaVersion: 1, boundary, ...evidence })}\n`),
  );
  return crashProcess();
}
