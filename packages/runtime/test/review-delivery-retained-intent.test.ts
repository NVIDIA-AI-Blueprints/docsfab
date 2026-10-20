// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import {
  readFile,
  lstat,
  mkdir,
  cp,
  realpath,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeRunRequest } from "../src/cli/run-request.js";
import { parseRunArguments } from "../src/cli/run-arguments.js";
import { handleRunsCommand } from "../src/cli/commands/runs.js";
import { DurableArtifactStore, opaqueRecordDigest } from "../src/artifacts/store.js";
import { FileRunStore } from "../src/records/file-store.js";
import { runRecordMaxBytes } from "../src/records/run-record-limit.js";
import { applyRunDeletion, previewRunDeletion } from "../src/records/run-deletion.js";
import { markArtifactObjectForDeletion } from "../src/records/run-maintenance-gate.js";
import { FileScmDeliveryReceiptStore } from "../src/delivery/receipt-store.js";
import {
  authorizeLocalUserPublication,
  createScmDeliveryRecord,
  deterministicLocalUserSourceBranch,
  failScmDeliveryRecord,
  localUserGitIdentitySha256,
  localUserPublicationPlanSha256,
  type LocalUserPublicationPlanV2,
} from "../src/delivery/index.js";
import {
  recordRunDeliveryAttemptLocation,
  runDeliveryInventoryDigest,
  type RunDeliveryDeletionInventory,
} from "../src/delivery/run-deletion-adapter.js";
import { deliveryCapsuleName } from "../src/delivery/worktree/materialize.js";
import { decodeSuccessfulReviewRunRecord } from "../src/delivery/run-record.js";
import { canonicalJson, sha256 } from "../src/content-ir/canonical.js";
import { limit } from "../src/config/limits.js";
import { createReviewTargetV2 } from "../src/review/index.js";
import { reviewResultFromRun } from "../src/review/run-result.js";
import {
  createReviewDeliveryImportRecord,
  createReviewDeliveryManifest,
  createReviewDeliveryRecord,
  reviewDeliveryImportedLineageMatches,
  updateReviewDeliveryRecord,
} from "../src/review-delivery/receipt.js";
import {
  planRetainedReviewDelivery,
  reviewDeliverySnapshotDigest,
} from "../src/review-delivery/index.js";
import {
  decodeSourceSnapshotRoot,
  retainSourceSnapshotParts,
} from "../src/review-delivery/source-snapshot-store.js";
import { inspectSavedReviewInventory as inspectInstalled } from "../src/review-delivery/public.js";
import {
  GitLabReviewDeliveryProvider,
  type GitLabReviewHttpRequest,
  type GitLabReviewHttpResponse,
} from "../src/review-delivery/providers/gitlab.js";
import {
  decodeChangeSourceV1,
  parseChangeSourceSelector,
  type GitLabMergeRequestSelectorV1,
} from "../src/inputs/change-source.js";
import { resolveGitLabMergeRequestChangeSource } from "../src/inputs/change-source/gitlab.js";
import { acquireChangeSourceObservations } from "../src/inputs/change-source/acquisition.js";
import { openExternalInputAccessCapture } from "../src/inputs/access.js";
import {
  CLI_SOURCE_READ_SCOPE,
  cliSourceExtractionLimits,
} from "../src/cli/run/source-acquisition.js";
import type {
  AgentHarness,
  HarnessStepInput,
  HarnessStepResult,
} from "../src/execution/contracts.js";
import type { RunRecord } from "../src/records/contracts.js";
import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../src/json-evidence.js";
import {
  canonicalSourceObligationProposal,
  requiresSourceObligationLedger,
} from "../src/workflow-execution/source-obligation.js";
import { createModelEvidence } from "../src/model/profile-evidence.js";
import { governProviderTurn } from "../src/model/turn-governor.js";
import { TECHNICAL_FACT_DIMENSIONS } from "../src/workflow-execution/verification-result.js";
import { authoringFixtureCandidateForInput } from "./support/authoring-quality-fixture.js";
import {
  createAuditHarness,
  resetSharedTestState,
  textTurn,
  toolTurn,
} from "./support/pi-harness-session-fixtures.js";
import { sourceObligationProposalFixture, verificationFixture } from "./helpers/verification.js";
import { validModelConfig } from "./helpers.js";
import { runtimeConfig } from "./support/execution-convergence.js";
import { createSourceFixture } from "./support/source-acquisition-cli.js";
import { commitFiles, fixtureGit } from "./support/change-source-fixture.js";
import { temporaryRoots } from "./helpers/temp.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";
import { authoringReviewFindingsRecord } from "./helpers/authoring-review-record.js";
import { FIXTURE_GIT_IDENTITY } from "./helpers/git.js";
import {
  decodeReviewInspectionIntent,
  inspectReviewIntentForDeletion,
  inspectSavedReviewInventory as inspectFromStores,
  retainSavedReviewInspectionIntent,
  type ReviewInspectionIntentV1,
} from "../src/review-delivery/inspection-intent.js";

import { executeReviewDelivery } from "../src/review-delivery/execute.js";
import {
  createLocalReviewDeliveryOriginAdmission,
  createLocalReviewDeliveryCustodyAdmission,
  exportReviewDeliveryCustody,
  importReviewDeliveryCustody,
} from "../src/review-delivery/custody.js";
import { createReviewDeliveryGrant } from "../src/review-delivery/index.js";

const HASH = "a".repeat(64);
const roots = temporaryRoots();
afterEach(async () => {
  await resetSharedTestState();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  process.exitCode = undefined;
});

class RealReadReviewHarness implements AgentHarness {
  private readonly pi: Awaited<ReturnType<typeof createAuditHarness>>;
  public constructor(
    pi: Awaited<ReturnType<typeof createAuditHarness>>,
    private readonly readPaths: readonly string[] = ["README.md"],
    private readonly technicalIssue = true,
  ) {
    this.pi = pi;
  }
  public async inspectSkill(input: HarnessStepInput) {
    return this.pi.inspectSkill(input);
  }
  public async runStep(input: HarnessStepInput): Promise<HarnessStepResult> {
    if (input.step.id === "verify-technical-accuracy") {
      const responses = [
        toolTurn(
          this.readPaths.map((path, index) => ({
            id: `retained-read-${index}`,
            name: "read",
            arguments: { path },
          })),
        ),
        textTurn(
          JSON.stringify({
            verdict: this.technicalIssue ? "needs-revision" : "pass",
            coverage: this.readPaths.map((path) => ({
              path,
              status: "verified",
              evidence: [`${path}:1`],
              reason: "The opening line was checked.",
            })),
            issueJudgments: this.technicalIssue
              ? [
                  {
                    id: "TECH-001",
                    severity: "major",
                    category: "technical_accuracy",
                    location: "README.md:1",
                    obligationIds: ["OBL-INPUT-REPRESENTATIONS-1"],
                  },
                ]
              : [],
            obligationJudgments: [
              {
                obligationId: "OBL-INPUT-REPRESENTATIONS-1",
                disposition: "retained",
                documentationDisposition: this.technicalIssue ? "conflicting" : "documented",
                issueIds: this.technicalIssue ? ["TECH-001"] : [],
              },
            ],
          }),
        ),
      ];
      let index = 0;
      vi.stubGlobal("fetch", async () => {
        const response = responses[index++];
        if (!response) throw new Error("Unexpected provider request.");
        return response.clone();
      });
      return this.pi.runStep(input);
    }
    const profile = validModelConfig.profile;
    const governed = governProviderTurn({
      context: { messages: [{ role: "user", content: "Perform the fixture review step." }] },
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
    const evidence = {
      model: createModelEvidence(validModelConfig),
      skill: await this.inspectSkill(input),
      usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, total: 3, turns: 1 },
      tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
      turns: [governed.evidence],
    };
    if (requiresSourceObligationLedger(input)) {
      const proposal = sourceObligationProposalFixture("README.md:1");
      proposal.dimensions[0] = {
        dimension: TECHNICAL_FACT_DIMENSIONS[0]!,
        status: "applicable",
        reason: "The reviewed opening line states one source-backed claim.",
        sourceLocators: [],
        obligations: [
          {
            id: "OBL-IGNORED",
            dimension: TECHNICAL_FACT_DIMENSIONS[0]!,
            sourceLocators: ["README.md:1"],
            statement: "The opening line names the reviewed head.",
            evidenceClass: "source-observation",
            uncertainty: "none",
          },
        ],
      };
      return {
        summary: canonicalSourceObligationProposal(proposal),
        sourceObligationProposal: proposal,
        ...evidence,
      };
    }
    if (input.step.id === "review-documentation") {
      return {
        summary: canonicalizeJsonEvidence({
          verdict: "pass",
          issues: [],
        } as JsonEvidenceValue).trimEnd(),
        ...evidence,
      };
    }
    if (input.step.id === "evaluate-document-quality") {
      const candidate = await authoringFixtureCandidateForInput(input);
      const target = candidate.evaluation.target as {
        documentation_family_evidence: Array<{ paths: string[] }>;
        paths: string[];
      };
      target.documentation_family_evidence[0]!.paths = [...this.readPaths];
      target.paths = [...this.readPaths];
      const limitations = candidate.evaluation.limitations as string[];
      for (const limitation of input.technicalVerification?.factInventory.limitations ?? []) {
        if (!limitations.includes(limitation)) limitations.push(limitation);
      }
      for (const dimension of input.technicalVerification?.factInventory.dimensions ?? []) {
        if (dimension.status === "unverified")
          limitations.push(`${dimension.dimension}: ${dimension.reason}`);
      }
      candidate.evaluation.findings = [
        {
          id: "DQ-TRACE-001",
          severity: "major",
          dimension_id: "factual-accuracy",
          description:
            "FACT-1 links the reviewed head difference to TECH-001 with uncertainty none.",
          evidence: [
            {
              evidence_class: "grounded-judgment",
              strength: "direct",
              provider_id: "fixture-evaluator",
              locator: "README.md:1",
              description: "The opening line was read under the registered confined tool.",
            },
          ],
          owner: "documentation owner",
          acceptance_condition:
            "Resolve FACT-1 and TECH-001 against the retained source line; uncertainty none.",
          status: "open",
        },
      ];
      return {
        summary: candidate.reportMarkdown,
        qualityArtifactCandidate: candidate,
        ...evidence,
      };
    }
    return {
      summary: `Completed ${input.step.id}.`,
      ...(await verificationFixture(input)),
      ...evidence,
    };
  }
}

describe("post-claim saved review intent", () => {
  it.each(["ordinary-transfer", "deletion-gate", "artifact-faults", "identity-faults"] as const)(
    "attaches and cold-verifies an authentic run after the executor claims its receipt: %s",
    async (mode) => {
      const markStage = (_stage: string) => undefined;
      markStage("fixture-start");
      const fixture = await createSourceFixture({ "README.md": "# Before\n" });
      roots.track(fixture.root);
      const base = await fixtureGit(fixture.repository, ["rev-parse", "HEAD"]);
      const head = await commitFiles(
        fixture.repository,
        { "README.md": "# Reviewed head\n" },
        "Modify reviewed page",
      );
      const host = "gitlab.example.test";
      const url = `https://${host}/team/docs-project/-/merge_requests/813`;
      const template = readFileSync(
        new URL("./fixtures/change-source-gitlab/merge-request-get.json", import.meta.url),
        "utf8",
      );
      const answer = JSON.parse(template, (_key, value: unknown) =>
        typeof value === "string" && value.startsWith("@")
          ? ({ base, start: base, head, merge: null } as Record<string, unknown>)[value.slice(1)]
          : value,
      ) as Record<string, unknown>;
      answer.state = "opened";
      answer.merge_commit_sha = null;
      answer.squash_commit_sha = null;
      let forgeCalls = 0;
      const commands = {
        async run(_command: string, args: readonly string[]) {
          forgeCalls += 1;
          return {
            stdout: JSON.stringify(
              String(args.at(-1)).includes("/merge_requests/")
                ? answer
                : { id: 4242, path_with_namespace: "team/docs-project" },
            ),
            stderr: "",
            exitCode: 0,
          };
        },
      };
      const request = {
        ...parseRunArguments([
          "review-documentation",
          "--repo",
          fixture.repository,
          "--instruction",
          "Review README.md for technical accuracy.",
          "--change",
          url,
        ]),
        runId: "saved-review-inspection-positive",
      };
      const resolved = await resolveGitLabMergeRequestChangeSource({
        selector: parseChangeSourceSelector(url) as GitLabMergeRequestSelectorV1,
        sourcePath: fixture.repository,
        repositoryPath: fixture.repository,
        workspaceRevision: head,
        forge: { commands, environment: {} },
      });
      markStage("source-resolved");
      const source = decodeChangeSourceV1(resolved.changeSource);
      const target = createReviewTargetV2(
        {
          scmProvider: "gitlab",
          host,
          projectId: 4242,
          mergeRequestIid: 813,
          sourceFork: false,
          sourceBranch: "topic",
          targetBranch: "main",
          baseSha: base,
          headSha: head,
          trigger: "api",
          requestIdentitySha256: sha256("review:inspection"),
          workflow: "review-documentation",
          deliveryIntent: "comment-existing-mr",
          logicalRequestId: "request:inspection",
          changeSourceSha256: source.changeSourceSha256,
        },
        source,
      );
      const beforeBytes = new TextEncoder().encode(
        `${await fixtureGit(fixture.repository, ["show", `${base}:README.md`])}\n`,
      );
      const afterBytes = new Uint8Array(await readFile(resolve(fixture.repository, "README.md")));
      const snapshot = {
        changeSourceSha256: source.changeSourceSha256,
        files: [
          {
            oldPath: "README.md",
            newPath: "README.md",
            beforeBytes,
            afterBytes,
            beforeSha256: sha256(beforeBytes),
            afterSha256: sha256(afterBytes),
            state: "complete" as const,
            hunks: [
              {
                lines: [
                  { kind: "removed" as const, text: "# Before", beforeLine: 1, afterLine: null },
                  {
                    kind: "added" as const,
                    text: "# Reviewed head",
                    beforeLine: null,
                    afterLine: 1,
                  },
                ],
              },
            ],
          },
        ],
      };
      const artifacts = new DurableArtifactStore(
        resolve(fixture.stateDirectory, "..", "artifacts"),
      );
      const acquired = await acquireChangeSourceObservations({
        resolved,
        externalInputs: openExternalInputAccessCapture({
          runIdSha256: sha256(request.runId),
          repository: { identitySha256: sha256(fixture.repository), revision: head },
        }),
        readScope: CLI_SOURCE_READ_SCOPE,
        runIdSha256: sha256(request.runId),
        repository: { identitySha256: sha256(fixture.repository), revision: head },
        requestSha256: sha256("inspection-request"),
        observedAt: "2026-10-17T12:00:00.000Z",
        limits: cliSourceExtractionLimits(),
      });
      markStage("source-acquired");
      const observationIdFor = (role: "manifest" | "diff") =>
        acquired.acquired.find((entry) => entry.role === role)!.observation.observationId;
      const file = source.files[0]!;
      const snapshotSha256 = reviewDeliverySnapshotDigest(snapshot, source);
      const retainedSource = await retainSourceSnapshotParts(artifacts, {
        runId: request.runId,
        sourceSha256: source.changeSourceSha256,
        repositoryIdentitySha256: source.revision.repository.identitySha256,
        reviewedHeadSha: head,
        snapshotSha256,
        manifest: { observationId: observationIdFor("manifest"), bytes: resolved.manifestBytes },
        diff: { observationId: observationIdFor("diff"), bytes: resolved.diffBytes },
        rows: [
          {
            state: "complete",
            sections: 1,
            before: {
              objectId: file.oldBlob!,
              bytes: beforeBytes,
              statedSha256: sha256(beforeBytes),
            },
            after: { objectId: file.newBlob!, bytes: afterBytes, statedSha256: sha256(afterBytes) },
          },
        ],
      });
      const pi = await createAuditHarness({
        reviewReadMaxObjectBytes: limit("artifacts.maxObjectBytes").value,
      });
      markStage("review-run-start");
      const record = await executeRunRequest(request, runtimeConfig(fixture.stateDirectory), {
        silent: true,
        executionHarness: new RealReadReviewHarness(pi, ["README.md"], false),
        changeRequestCommands: commands,
        changeRequestEnvironment: {},
        reviewResultRetention: {
          artifacts,
          async prepare(run) {
            return {
              originalResult: reviewResultFromRun(run, { target, source }),
              sourceReference: {
                kind: "docsfab-review-delivery-snapshot-reference",
                schemaVersion: 1,
                runId: run.id,
                rootObjectSha256: retainedSource.rootObjectSha256,
                snapshotSha256,
                changeSourceSha256: source.changeSourceSha256,
                reviewedHeadSha: head,
                repositoryIdentitySha256: source.revision.repository.identitySha256,
              },
            };
          },
        },
      });
      markStage("review-run-complete");
      expect(record?.status, JSON.stringify(record?.error)).toBe("succeeded");
      const runStore = new FileRunStore(fixture.stateDirectory);
      const before = decodeSuccessfulReviewRunRecord(
        (await runStore.getWithDigest(request.runId)).record,
      );
      const beforeDigest = (await runStore.getWithDigest(request.runId)).sha256;
      const resultUse = before.steps
        .at(-1)
        ?.artifacts?.find((use) => use.reference.kind === "review-result");
      expect(resultUse).toBeDefined();
      const delivery = {
        snapshot,
        artifact: {
          kind: "retained-review-result" as const,
          id: "artifact:inspection",
          resultSha256: "",
        },
        actor: { host, id: "42" },
        capabilities: { scmProvider: "gitlab" as const, host, summary: true, inline: true },
        requestedActions: "overview" as const,
      };
      const originalResult = (await artifacts.getRecord(resultUse!.reference.digest, {
        readOnly: true,
      })) as { resultSha256: string };
      const plan = await planRetainedReviewDelivery({
        runStore,
        artifacts,
        runId: request.runId,
        binding: { target, source },
        delivery: {
          ...delivery,
          artifact: { ...delivery.artifact, resultSha256: originalResult.resultSha256 },
          extensions: { presentation: { select: () => "summary" as const } },
        },
        readOnly: true,
      });
      expect(plan.findings.length).toBeGreaterThan(0);
      const manifest = createReviewDeliveryManifest(plan);
      const receiptRoot = resolve(fixture.stateDirectory, "..", "receipts");
      await mkdir(receiptRoot, { mode: 0o700 });
      const receiptStore = new FileScmDeliveryReceiptStore(receiptRoot);
      expect(await receiptStore.loadReview(manifest.idempotencyKey)).toBeUndefined();
      const deletedRoot = resolve(fixture.root, "deletion-before-claim");
      await mkdir(deletedRoot);
      const deletedState = resolve(deletedRoot, "runs");
      const deletedArtifacts = resolve(deletedRoot, "artifacts");
      const deletedReceipts = resolve(deletedRoot, "receipts");
      await cp(fixture.stateDirectory, deletedState, { recursive: true });
      await cp(resolve(fixture.stateDirectory, "..", "artifacts"), deletedArtifacts, {
        recursive: true,
      });
      await mkdir(deletedReceipts, { mode: 0o700 });
      const selectionChoices = plan.findings
        .map((finding) => ({ inventoryId: finding.inventoryId, presentation: "summary" as const }))
        .sort((a, b) => a.inventoryId.localeCompare(b.inventoryId));

      const admission = createLocalReviewDeliveryOriginAdmission({
        store: receiptStore,
        configuredReceiptRoot: receiptRoot,
        runStore,
        artifactStore: artifacts,
        runId: request.runId,
        artifactDigest: resultUse!.reference.digest,
        artifactId: plan.artifact.id,
        originalResultSha256: plan.result.originalResultSha256,
        requestedActions: "overview",
        loadSnapshot: async () => snapshot,
      });
      const grants = new Map(
        plan.actions.map((action) => [
          action.id,
          createReviewDeliveryGrant({
            verifyCurrent: (candidate) => {
              if (candidate.id !== action.id) throw new Error("Unexpected review action.");
              return { status: "admitted" as const, actionId: action.id, kind: action.kind };
            },
          }),
        ]),
      );
      if (mode === "artifact-faults" || mode === "identity-faults") {
        const blockedPrepare = vi.fn(async () => ({
          kind: "blocked" as const,
          actionId: plan.actions[0]!.id,
          code: "provider-failure" as const,
          next: "retry" as const,
          retryAfterAt: null,
        }));
        const blockedPublish = vi.fn(async () => {
          throw new Error("A failed intent attachment must not publish.");
        });
        const attempt = async (
          retainedIntent: () => Promise<
            | { kind: "verified" }
            | { kind: "blocked"; code: "intent-conflict" | "readback-unproved" }
          >,
          submittedPlan: typeof plan = plan,
        ) =>
          executeReviewDelivery({
            plan: submittedPlan,
            store: receiptStore,
            originAdmission: admission,
            grantsByActionId: grants,
            retainedIntent,
            effects: { prepareNextEffect: blockedPrepare, publishEffect: blockedPublish },
            recovery: {
              observeCurrent: vi.fn(async () => ({
                kind: "unavailable" as const,
                reason: "unused",
              })),
              observeEffect: vi.fn(async () => ({
                kind: "unavailable" as const,
                effectId: HASH,
                reason: "unused",
              })),
            },
          });
        const retain = (
          candidatePlan: typeof plan = plan,
          selections: Parameters<
            typeof retainSavedReviewInspectionIntent
          >[0]["selections"] = selectionChoices,
        ) =>
          retainSavedReviewInspectionIntent({
            runStore,
            artifacts,
            receiptStore,
            runId: request.runId,
            plan: candidatePlan,
            selections,
          });
        if (mode === "artifact-faults") {
          const originalPut = artifacts.putRecord.bind(artifacts);
          const refusedPut = vi.spyOn(artifacts, "putRecord").mockImplementationOnce(async () => {
            throw new Error("Injected artifact object write failure.");
          });
          expect(
            await attempt(async () => {
              await retain();
              return { kind: "verified" };
            }),
          ).toMatchObject({
            kind: "stopped",
            reason: "retention",
            retentionCode: "readback-unproved",
          });
          expect(refusedPut).toHaveBeenCalledOnce();
          refusedPut.mockRestore();
          let objectWritten = false;
          const put = vi.spyOn(artifacts, "putRecord").mockImplementation(async (...args) => {
            const value = await originalPut(...args);
            objectWritten = true;
            return value;
          });
          const originalGet = artifacts.getRecord.bind(artifacts);
          let readbackFailed = false;
          const get = vi.spyOn(artifacts, "getRecord").mockImplementation(async (...args) => {
            if (objectWritten && !readbackFailed) {
              readbackFailed = true;
              throw new Error("Injected artifact readback failure.");
            }
            return originalGet(...args);
          });
          expect(
            await attempt(async () => {
              await retain();
              return { kind: "verified" };
            }),
          ).toMatchObject({
            kind: "stopped",
            reason: "retention",
            retentionCode: "readback-unproved",
          });
          expect(objectWritten).toBe(true);
          expect(readbackFailed).toBe(true);
          put.mockRestore();
          get.mockRestore();
        } else {
          const wrongActor = { ...plan, actor: { ...plan.actor, id: "user:foreign" } };
          const wrongTarget = {
            ...plan,
            target: { ...plan.target, headSha: "b".repeat(40) },
          };
          const wrongRequest = { ...plan, requestedActions: "summary-only" as const };
          const wrongSelections = selectionChoices.map((choice, index) =>
            index === 0 ? { ...choice, presentation: "retained" as const } : choice,
          );
          for (const [label, candidate] of [
            ["actor", wrongActor],
            ["target", wrongTarget],
          ] as const) {
            markStage(`malformed-${label}-start`);
            const forgedRetention = vi.fn(async () => ({ kind: "verified" as const }));
            await expect(attempt(forgedRetention, candidate), label).rejects.toMatchObject({
              name: label === "actor" ? "ReviewDeliveryReceiptContractError" : "ReviewTargetError",
              code: label === "actor" ? "identity-mismatch" : "digest-mismatch",
            });
            markStage(`malformed-${label}-rejected`);
            expect(forgedRetention, label).not.toHaveBeenCalled();
          }
          const forgedRequestRetention = vi.fn(async () => ({ kind: "verified" as const }));
          markStage("wrong-request-start");
          const wrongRequestResult = await attempt(forgedRequestRetention, wrongRequest);
          markStage(
            `wrong-request-${wrongRequestResult.kind === "stopped" ? wrongRequestResult.reason : wrongRequestResult.kind}`,
          );
          expect(wrongRequestResult).toMatchObject({ kind: "stopped", reason: "custody" });
          expect(forgedRequestRetention).not.toHaveBeenCalled();
          const wrongSelectionAttempt = await attempt(async () => {
            await expect(retain(plan, wrongSelections)).rejects.toMatchObject({
              name: "ReviewInspectionUnavailable",
              code: "original-plan-mismatch",
            });
            return { kind: "blocked", code: "intent-conflict" };
          });
          markStage(
            `wrong-selection-${wrongSelectionAttempt.kind === "stopped" ? wrongSelectionAttempt.reason : wrongSelectionAttempt.kind}`,
          );
          expect(wrongSelectionAttempt).toMatchObject({
            kind: "stopped",
            reason: "retention",
            retentionCode: "intent-conflict",
          });
        }
        expect(blockedPrepare).not.toHaveBeenCalled();
        expect(blockedPublish).not.toHaveBeenCalled();
        const attached = await attempt(async () => {
          await retain();
          return { kind: "verified" };
        });
        markStage(
          `identity-positive-${attached.kind === "stopped" ? attached.reason : attached.kind}`,
        );
        expect(attached).toMatchObject({ kind: "stopped", reason: "preparation" });
        expect(blockedPrepare).toHaveBeenCalled();
        expect(blockedPublish).not.toHaveBeenCalled();
        return;
      }
      let retainedIntentDigest: string | undefined;
      const prepare = vi.fn(async () => {
        expect(retainedIntentDigest).toBeDefined();
        return {
          kind: "blocked" as const,
          actionId: plan.actions[0]!.id,
          code: "provider-failure" as const,
          next: "retry" as const,
          retryAfterAt: null,
        };
      });
      const publish = vi.fn(async () => {
        throw new Error("The staged provider refusal must not publish.");
      });
      const sourceRecovery = {
        observeCurrent: vi.fn(async () => ({ kind: "unavailable" as const, reason: "unused" })),
        observeEffect: vi.fn(async () => ({
          kind: "unavailable" as const,
          effectId: HASH,
          reason: "unused",
        })),
      };
      const durableReplace = runStore.replaceIfDigest.bind(runStore);
      const lostResponse = vi
        .spyOn(runStore, "replaceIfDigest")
        .mockImplementationOnce(async (...args) => {
          await durableReplace(...args);
          throw new Error("The retained run CAS succeeded but its response was lost.");
        });
      let signalClaimed!: () => void;
      let continueRetention!: () => void;
      const claimed = new Promise<void>((resolveClaimed) => {
        signalClaimed = resolveClaimed;
      });
      const retentionMayContinue = new Promise<void>((resolveContinue) => {
        continueRetention = resolveContinue;
      });
      const ambiguousAttempt = executeReviewDelivery({
        plan,
        store: receiptStore,
        originAdmission: admission,
        grantsByActionId: grants,
        retainedIntent: async () => {
          markStage("retention-hook-entered");
          signalClaimed();
          await retentionMayContinue;
          markStage("retention-hook-resumed");
          await retainSavedReviewInspectionIntent({
            runStore,
            artifacts,
            receiptStore,
            runId: request.runId,
            plan,
            selections: selectionChoices,
          });
          return { kind: "verified" as const };
        },
        effects: { prepareNextEffect: prepare, publishEffect: publish },
        recovery: sourceRecovery,
      });
      markStage("ambiguous-attempt-started");
      const settledAttempt = ambiguousAttempt.then(
        (result) => ({ kind: "resolved" as const, result }),
        (error: unknown) => ({ kind: "rejected" as const, error }),
      );
      let ambiguousOutcome!: Awaited<typeof settledAttempt>;
      try {
        const first = await Promise.race([
          claimed.then(() => ({ kind: "claimed" as const })),
          settledAttempt,
        ]);
        if (first.kind !== "claimed")
          throw new Error(
            `Review attempt settled before retained intent: ${first.kind === "resolved" ? first.result.kind : first.error instanceof Error ? first.error.name : "non-error"}`,
          );
        markStage("claimed-signal-observed");
        markStage("deletion-preview-start");
        const racingPreview = await previewRunDeletion(fixture.stateDirectory, request.runId);
        markStage("deletion-preview-complete");
        expect(racingPreview.unresolved).toBeGreaterThan(0);
        markStage("deletion-apply-start");
        const racingDeletion = await applyRunDeletion(
          fixture.stateDirectory,
          request.runId,
          racingPreview.confirmation,
        );
        markStage("deletion-apply-complete");
        expect(racingDeletion).toMatchObject({ complete: false, removed: 0 });
        expect(await receiptStore.loadReview(manifest.idempotencyKey)).toBeDefined();
      } finally {
        continueRetention();
        markStage("retention-hook-released");
        ambiguousOutcome = await settledAttempt;
        markStage(`ambiguous-attempt-${ambiguousOutcome.kind}`);
      }
      if (ambiguousOutcome.kind === "rejected") throw ambiguousOutcome.error;
      const ambiguous = ambiguousOutcome.result;
      expect(ambiguous).toMatchObject({
        kind: "stopped",
        reason: "retention",
        retentionCode: "readback-unproved",
      });
      expect(lostResponse).toHaveBeenCalledOnce();
      expect(prepare).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
      lostResponse.mockRestore();
      const persistedRun = decodeSuccessfulReviewRunRecord(
        (await runStore.getWithDigest(request.runId)).record,
      );
      const persistedIntentUse = persistedRun.artifacts?.find(
        (use) => use.reference.kind === "review-delivery-intent",
      );
      expect(persistedIntentUse).toBeDefined();
      retainedIntentDigest = persistedIntentUse!.reference.digest;
      const result = await executeReviewDelivery({
        plan,
        store: receiptStore,
        originAdmission: admission,
        grantsByActionId: grants,
        retainedIntent: async ({ claimedRecord }) => {
          expect((await receiptStore.loadReview(claimedRecord.idempotencyKey))?.sha256).toBe(
            claimedRecord.sha256,
          );
          const inventory = await inspectFromStores({
            runStore,
            artifacts,
            receiptStore,
            runId: request.runId,
            intentObjectSha256: retainedIntentDigest!,
          });
          expect(inventory).toMatchObject({ kind: "saved-review-inventory" });
          return inventory.kind === "saved-review-inventory"
            ? { kind: "verified" as const }
            : { kind: "blocked" as const, code: "readback-unproved" as const };
        },
        effects: { prepareNextEffect: prepare, publishEffect: publish },
        recovery: sourceRecovery,
      });
      markStage(`cold-retry-${result.kind}`);
      expect(result).toMatchObject({ kind: "stopped", reason: "preparation" });
      expect(prepare).toHaveBeenCalledOnce();
      expect(publish).not.toHaveBeenCalled();
      expect(retainedIntentDigest).toBeDefined();
      const reopened = await inspectFromStores({
        runStore: new FileRunStore(fixture.stateDirectory),
        artifacts: new DurableArtifactStore(resolve(fixture.stateDirectory, "..", "artifacts")),
        receiptStore: new FileScmDeliveryReceiptStore(receiptRoot),
        runId: request.runId,
        intentObjectSha256: retainedIntentDigest!,
      });
      expect(reopened).toMatchObject({ kind: "saved-review-inventory", runId: request.runId });
      expect(reopened.kind === "saved-review-inventory" ? canonicalJson(reopened.plan) : null).toBe(
        canonicalJson(plan),
      );
      const deletionPreview = await previewRunDeletion(fixture.stateDirectory, request.runId);
      expect(deletionPreview.unresolved).toBeGreaterThan(0);
      const blockedDeletion = await applyRunDeletion(
        fixture.stateDirectory,
        request.runId,
        deletionPreview.confirmation,
      );
      expect(blockedDeletion).toMatchObject({ complete: false, removed: 0 });
      expect(await runStore.get(request.runId)).toBeDefined();
      expect(await artifacts.has(retainedIntentDigest!)).toBe(true);

      const destinationRoot = resolve(fixture.root, "imported-review-custody");
      await mkdir(destinationRoot);
      const destinationState = resolve(destinationRoot, "runs");
      await cp(fixture.stateDirectory, destinationState, { recursive: true });
      await cp(
        resolve(fixture.stateDirectory, "..", "artifacts"),
        resolve(destinationRoot, "artifacts"),
        {
          recursive: true,
        },
      );
      const destinationReceipts = resolve(destinationRoot, "receipts");
      await mkdir(destinationReceipts, { mode: 0o700 });
      let observedImportContention!: () => void;
      const importContention = new Promise<void>((resolveContention) => {
        observedImportContention = resolveContention;
      });
      const destinationStore = new FileScmDeliveryReceiptStore(destinationReceipts, {
        afterReviewImportGateContention: () => observedImportContention(),
      });
      const custodyAdmission = createLocalReviewDeliveryCustodyAdmission({
        configuredActor: plan.actor,
        origin: {
          store: receiptStore,
          configuredReceiptRoot: receiptRoot,
          runStore,
          artifactStore: artifacts,
          runId: request.runId,
          artifactDigest: resultUse!.reference.digest,
          artifactId: plan.artifact.id,
          originalResultSha256: plan.result.originalResultSha256,
          runRecordSha256: (await runStore.getWithDigest(request.runId)).sha256,
          requestedActions: "overview",
          loadSnapshot: async () => snapshot,
        },
        destination: { store: destinationStore, configuredReceiptRoot: destinationReceipts },
      });
      const exported = await exportReviewDeliveryCustody({
        plan,
        store: receiptStore,
        destinationStore,
        custodyAdmission,
      });
      markStage(`custody-export-${exported.kind}`);
      expect(exported.kind, JSON.stringify(exported)).toBe("fenced");
      if (exported.kind !== "fenced")
        throw new Error(`Source transfer refused: ${exported.reason}`);
      if (mode === "deletion-gate") {
        const gatedPreview = await previewRunDeletion(destinationState, request.runId);
        expect(gatedPreview.unresolved).toBe(0);
        let importedWhileDeleting: ReturnType<typeof importReviewDeliveryCustody> | undefined;
        let sawContention = false;
        const deletedWhileImporting = await applyRunDeletion(
          destinationState,
          request.runId,
          gatedPreview.confirmation,
          {
            afterRemove: async () => {
              if (importedWhileDeleting) return;
              importedWhileDeleting = importReviewDeliveryCustody({
                plan,
                store: destinationStore,
                custodyAdmission,
                pointer: exported.pointer,
              });
              const first = await Promise.race([
                importContention.then(() => ({ kind: "contention" as const })),
                importedWhileDeleting!.then(
                  (result) => ({ kind: "settled" as const, result }),
                  (error: unknown) => ({ kind: "rejected" as const, error }),
                ),
              ]);
              if (first.kind !== "contention")
                throw new Error(
                  `Imported claim settled before gate contention: ${first.kind === "settled" ? first.result.kind : first.error instanceof Error ? first.error.name : "non-error"}`,
                );
              markStage("import-contention-observed");
              sawContention = true;
              expect(await destinationStore.loadReview(manifest.idempotencyKey)).toBeUndefined();
            },
          },
        );
        markStage(`deletion-gate-${deletedWhileImporting.complete ? "complete" : "blocked"}`);
        expect(sawContention).toBe(true);
        expect(deletedWhileImporting).toMatchObject({ complete: true });
        expect(importedWhileDeleting).toBeDefined();
        const importedAfterDeletion = await importedWhileDeleting!;
        expect(importedAfterDeletion).toMatchObject({ kind: "import-pending" });
        const gatedPrepare = vi.fn(async () => ({ kind: "complete" as const }));
        const gatedPublish = vi.fn(async () => {
          throw new Error("A deleted imported run must not publish.");
        });
        const gatedRetention = vi.fn(async () => {
          const checked = await inspectFromStores({
            runStore: new FileRunStore(destinationState),
            artifacts: new DurableArtifactStore(resolve(destinationRoot, "artifacts")),
            receiptStore: destinationStore,
            runId: request.runId,
            intentObjectSha256: retainedIntentDigest!,
          });
          expect(checked.kind).toBe("inspection-unavailable");
          return { kind: "blocked" as const, code: "intent-unavailable" as const };
        });
        const afterDeletion = await executeReviewDelivery({
          plan,
          store: destinationStore,
          originAdmission: custodyAdmission,
          grantsByActionId: grants,
          retainedIntent: gatedRetention,
          effects: { prepareNextEffect: gatedPrepare, publishEffect: gatedPublish },
          recovery: {
            observeCurrent: vi.fn(async (binding) => ({
              kind: "current" as const,
              target: binding.target,
              sourceSha256: binding.sourceSha256,
              snapshotSha256: binding.snapshotSha256,
              actor: binding.actor,
              headSha: binding.reviewedHeadSha,
              startSha: binding.startSha,
            })),
            observeEffect: vi.fn(async () => ({
              kind: "unavailable" as const,
              effectId: HASH,
              reason: "unused",
            })),
          },
        });
        expect(afterDeletion.kind).toBe("stopped");
        expect(gatedPrepare).not.toHaveBeenCalled();
        expect(gatedPublish).not.toHaveBeenCalled();
        return;
      }
      const imported = await importReviewDeliveryCustody({
        plan,
        store: destinationStore,
        custodyAdmission,
        pointer: exported.pointer,
      });
      markStage(`custody-import-${imported.kind}`);
      expect(imported.kind).toBe("import-pending");
      const importedInventory = await inspectFromStores({
        runStore: new FileRunStore(destinationState),
        artifacts: new DurableArtifactStore(resolve(destinationRoot, "artifacts")),
        receiptStore: destinationStore,
        runId: request.runId,
        intentObjectSha256: retainedIntentDigest!,
      });
      expect(importedInventory).toMatchObject({
        kind: "saved-review-inventory",
        runId: request.runId,
      });
      const importedRunDigest = (
        await new FileRunStore(destinationState).getWithDigest(request.runId)
      ).sha256;
      const wrongIntentPrepare = vi.fn(async () => ({ kind: "complete" as const }));
      const wrongIntentPublish = vi.fn(async () => {
        throw new Error("A missing imported intent must never publish.");
      });
      const wrongIntentAttempt = await executeReviewDelivery({
        plan,
        store: destinationStore,
        originAdmission: custodyAdmission,
        grantsByActionId: grants,
        retainedIntent: async () => {
          const inspected = await inspectFromStores({
            runStore: new FileRunStore(destinationState),
            artifacts: new DurableArtifactStore(resolve(destinationRoot, "artifacts")),
            receiptStore: destinationStore,
            runId: request.runId,
            intentObjectSha256: HASH,
          });
          expect(inspected.kind).toBe("inspection-unavailable");
          return { kind: "blocked" as const, code: "intent-conflict" as const };
        },
        effects: { prepareNextEffect: wrongIntentPrepare, publishEffect: wrongIntentPublish },
        recovery: {
          observeCurrent: vi.fn(async (binding) => ({
            kind: "current" as const,
            target: binding.target,
            sourceSha256: binding.sourceSha256,
            snapshotSha256: binding.snapshotSha256,
            actor: binding.actor,
            headSha: binding.reviewedHeadSha,
            startSha: binding.startSha,
          })),
          observeEffect: vi.fn(async () => ({
            kind: "unavailable" as const,
            effectId: HASH,
            reason: "unused",
          })),
        },
      });
      expect(wrongIntentAttempt).toMatchObject({
        kind: "stopped",
        reason: "retention",
        retentionCode: "intent-conflict",
      });
      expect(wrongIntentPrepare).not.toHaveBeenCalled();
      expect(wrongIntentPublish).not.toHaveBeenCalled();
      let importedVerified = false;
      const importedPrepare = vi.fn(async () => {
        expect(importedVerified).toBe(true);
        return {
          kind: "blocked" as const,
          actionId: plan.actions[0]!.id,
          code: "provider-failure" as const,
          next: "retry" as const,
          retryAfterAt: null,
        };
      });
      const importedPublish = vi.fn(publish);
      const verifyImportedIntent = vi.fn(async ({ claimedRecord }) => {
        expect(claimedRecord.generation).toBe(1);
        const inspected = await inspectFromStores({
          runStore: new FileRunStore(destinationState),
          artifacts: new DurableArtifactStore(resolve(destinationRoot, "artifacts")),
          receiptStore: destinationStore,
          runId: request.runId,
          intentObjectSha256: retainedIntentDigest!,
        });
        importedVerified = inspected.kind === "saved-review-inventory";
        return inspected.kind === "saved-review-inventory"
          ? { kind: "verified" as const }
          : { kind: "blocked" as const, code: "intent-conflict" as const };
      });
      const resumed = await executeReviewDelivery({
        plan,
        store: destinationStore,
        originAdmission: custodyAdmission,
        grantsByActionId: grants,
        retainedIntent: verifyImportedIntent,
        effects: { prepareNextEffect: importedPrepare, publishEffect: importedPublish },
        recovery: {
          observeCurrent: vi.fn(async (binding) => ({
            kind: "current" as const,
            target: binding.target,
            sourceSha256: binding.sourceSha256,
            snapshotSha256: binding.snapshotSha256,
            actor: binding.actor,
            headSha: binding.reviewedHeadSha,
            startSha: binding.startSha,
          })),
          observeEffect: vi.fn(async () => ({
            kind: "unavailable" as const,
            effectId: HASH,
            reason: "unused",
          })),
        },
      });
      expect(resumed, JSON.stringify(resumed)).toMatchObject({
        kind: "stopped",
        reason: "preparation",
      });
      expect(verifyImportedIntent).toHaveBeenCalledOnce();
      expect(importedPrepare).toHaveBeenCalledOnce();
      expect(importedPublish).not.toHaveBeenCalled();
      expect((await new FileRunStore(destinationState).getWithDigest(request.runId)).sha256).toBe(
        importedRunDigest,
      );

      let nativeBody: string | null = null;
      const nativeCalls: GitLabReviewHttpRequest[] = [];
      const nativePath = "/api/v4/projects/4242/merge_requests/813";
      const nativeNote = () => ({
        id: 88,
        project_id: 4242,
        noteable_iid: 813,
        noteable_type: "MergeRequest",
        author: { id: 42 },
        body: nativeBody,
        system: false,
      });
      const transport = {
        request: async (
          nativeRequest: GitLabReviewHttpRequest,
        ): Promise<GitLabReviewHttpResponse> => {
          nativeCalls.push(nativeRequest);
          if (nativeRequest.path === "/api/v4/user")
            return { status: 200, headers: {}, body: { id: 42 } };
          if (nativeRequest.path === nativePath)
            return {
              status: 200,
              headers: {},
              body: { ...answer, source_branch: "topic" },
            };
          if (nativeRequest.method === "POST" && nativeRequest.path === `${nativePath}/notes`) {
            nativeBody = (
              JSON.parse(new TextDecoder().decode(nativeRequest.bodyBytes)) as { body: string }
            ).body;
            return { status: 201, headers: {}, body: { id: 88 } };
          }
          if (nativeRequest.path === `${nativePath}/notes?per_page=100`)
            return {
              status: 200,
              headers: {},
              body: nativeBody === null ? [] : [nativeNote()],
            };
          if (nativeRequest.path === `${nativePath}/notes/88`)
            return { status: 200, headers: {}, body: nativeNote() };
          throw new Error(
            `Unexpected fake GitLab route: ${nativeRequest.method} ${nativeRequest.path}`,
          );
        },
      };
      const nativeProvider = new GitLabReviewDeliveryProvider(host, transport);
      const nativePrepare = nativeProvider.prepareNextEffect.bind(nativeProvider);
      const nativePublish = nativeProvider.publishEffect.bind(nativeProvider);
      let nativeRetentionVerified = false;
      vi.spyOn(nativeProvider, "prepareNextEffect").mockImplementation(async (input) => {
        expect(nativeRetentionVerified).toBe(true);
        return nativePrepare(input);
      });
      vi.spyOn(nativeProvider, "publishEffect").mockImplementation(async (input) => {
        expect(nativeRetentionVerified).toBe(true);
        return nativePublish(input);
      });
      const nativeResult = await executeReviewDelivery({
        plan,
        store: destinationStore,
        originAdmission: custodyAdmission,
        grantsByActionId: grants,
        retainedIntent: async ({ claimedRecord }) => {
          expect((await destinationStore.loadReview(claimedRecord.idempotencyKey))?.sha256).toBe(
            claimedRecord.sha256,
          );
          const inspected = await inspectFromStores({
            runStore: new FileRunStore(destinationState),
            artifacts: new DurableArtifactStore(resolve(destinationRoot, "artifacts")),
            receiptStore: destinationStore,
            runId: request.runId,
            intentObjectSha256: retainedIntentDigest!,
          });
          nativeRetentionVerified = inspected.kind === "saved-review-inventory";
          return nativeRetentionVerified
            ? { kind: "verified" as const }
            : { kind: "blocked" as const, code: "intent-conflict" as const };
        },
        effects: nativeProvider,
        recovery: nativeProvider,
      });
      expect(nativeResult, JSON.stringify({ kind: nativeResult.kind })).toMatchObject({
        kind: "complete",
      });
      expect(nativeCalls.filter((call) => call.method === "POST")).toHaveLength(1);
      expect(nativeBody).not.toBeNull();
      expect(nativeResult.record?.effects).toMatchObject([{ state: "confirmed" }]);
      expect((await new FileRunStore(destinationState).getWithDigest(request.runId)).sha256).toBe(
        importedRunDigest,
      );

      const beforeClaimPreview = await previewRunDeletion(deletedState, request.runId);
      expect(beforeClaimPreview.unresolved).toBe(0);
      const deletedStore = new FileScmDeliveryReceiptStore(deletedReceipts);
      const actualDeletedLoad = deletedStore.loadReview.bind(deletedStore);
      const deletionLoadEvents: string[] = [];
      let signalDeletionLoad!: () => void;
      const deletionLoadEntered = new Promise<void>((resolveLoad) => {
        signalDeletionLoad = resolveLoad;
      });
      vi.spyOn(deletedStore, "loadReview").mockImplementation(async (...args) => {
        deletionLoadEvents.push("entered");
        signalDeletionLoad();
        try {
          const loaded = await actualDeletedLoad(...args);
          deletionLoadEvents.push(loaded ? "returned:present" : "returned:missing");
          return loaded;
        } catch (error) {
          deletionLoadEvents.push(
            `threw:${error && typeof error === "object" && "code" in error ? String(error.code) : "unknown"}`,
          );
          throw error;
        }
      });
      const actualDeletedClaim = deletedStore.claimReview.bind(deletedStore);
      vi.spyOn(deletedStore, "claimReview").mockImplementation(async (...args) => {
        deletionLoadEvents.push("claim-entered");
        try {
          const claimed = await actualDeletedClaim(...args);
          deletionLoadEvents.push("claim-returned");
          return claimed;
        } catch (error) {
          deletionLoadEvents.push(
            `claim-threw:${error && typeof error === "object" && "code" in error ? String(error.code) : error instanceof Error ? error.name : "unknown"}`,
          );
          throw error;
        }
      });
      const deletedAdmission = createLocalReviewDeliveryOriginAdmission({
        store: deletedStore,
        configuredReceiptRoot: deletedReceipts,
        runStore: new FileRunStore(deletedState),
        artifactStore: new DurableArtifactStore(deletedArtifacts),
        runId: request.runId,
        artifactDigest: resultUse!.reference.digest,
        artifactId: plan.artifact.id,
        originalResultSha256: plan.result.originalResultSha256,
        requestedActions: "overview",
        loadSnapshot: async () => snapshot,
      });
      const stalePrepare = vi.fn(async () => ({ kind: "complete" as const }));
      const stalePublish = vi.fn(async () => {
        throw new Error("A deleted run must not publish.");
      });
      const staleRetention = vi.fn(async () => ({ kind: "verified" as const }));
      const attemptStale = () =>
        executeReviewDelivery({
          plan,
          store: deletedStore,
          originAdmission: deletedAdmission,
          grantsByActionId: grants,
          retainedIntent: staleRetention,
          effects: { prepareNextEffect: stalePrepare, publishEffect: stalePublish },
          recovery: {
            observeCurrent: vi.fn(async () => ({
              kind: "unavailable" as const,
              reason: "unused",
            })),
            observeEffect: vi.fn(async () => ({
              kind: "unavailable" as const,
              effectId: HASH,
              reason: "unused",
            })),
          },
        });
      let staleAttemptDuringDeletion: ReturnType<typeof executeReviewDelivery> | undefined;
      const deletionWins = await applyRunDeletion(
        deletedState,
        request.runId,
        beforeClaimPreview.confirmation,
        {
          afterRemove: async () => {
            staleAttemptDuringDeletion ??= attemptStale();
            const first = await Promise.race([
              deletionLoadEntered.then(() => "load-entered" as const),
              staleAttemptDuringDeletion.then(
                () => "settled-before-load" as const,
                () => "rejected-before-load" as const,
              ),
            ]);
            expect(first).toBe("load-entered");
          },
        },
      );
      expect(deletionWins).toMatchObject({ complete: true });
      expect(staleAttemptDuringDeletion).toBeDefined();
      const staleAttempt = await staleAttemptDuringDeletion!;
      const concurrentLoadEvents = [...deletionLoadEvents];
      expect(concurrentLoadEvents).toContain("entered");
      expect(concurrentLoadEvents, JSON.stringify(concurrentLoadEvents)).not.toContain(
        "returned:present",
      );
      expect(concurrentLoadEvents).not.toContain("claim-returned");
      const outcomes = concurrentLoadEvents.filter(
        (event) => event !== "entered" && event !== "claim-entered",
      );
      expect(outcomes.length).toBeGreaterThan(0);
      expect(
        outcomes.every(
          (event) =>
            event === "returned:missing" ||
            event.startsWith("threw:") ||
            event.startsWith("claim-threw:"),
        ),
      ).toBe(true);
      const concurrentReason = outcomes.some(
        (event) => event.startsWith("threw:") || event.startsWith("claim-threw:"),
      )
        ? "store-uncertain"
        : "custody";
      expect(
        staleAttempt,
        JSON.stringify({
          kind: staleAttempt.kind,
          reason: staleAttempt.kind === "stopped" ? staleAttempt.reason : null,
          loadEvents: concurrentLoadEvents,
        }),
      ).toMatchObject({ kind: "stopped", reason: concurrentReason });
      const coldStaleAttempt = await attemptStale();
      await expect(new FileRunStore(deletedState).get(request.runId)).rejects.toMatchObject({
        code: "record-not-found",
      });
      expect(
        coldStaleAttempt,
        JSON.stringify({
          kind: coldStaleAttempt.kind,
          reason: coldStaleAttempt.kind === "stopped" ? coldStaleAttempt.reason : null,
        }),
      ).toMatchObject({ kind: "stopped", reason: "custody" });
      expect(staleRetention).not.toHaveBeenCalled();
      expect(stalePrepare).not.toHaveBeenCalled();
      expect(stalePublish).not.toHaveBeenCalled();
      expect(await deletedStore.loadReview(manifest.idempotencyKey)).toBeUndefined();
    },
    testTimeoutMs(120_000),
  );
});
