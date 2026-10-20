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

const HASH = "a".repeat(64);
const roots = temporaryRoots();
afterEach(async () => {
  await resetSharedTestState();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  process.exitCode = undefined;
});

function intent(): ReviewInspectionIntentV1 {
  return {
    kind: "docsfab-review-delivery-inspection-intent",
    schemaVersion: 1,
    runId: "saved-review",
    logicalDeliveryId: HASH,
    idempotencyKey: HASH,
    manifestSha256: HASH,
    targetSha256: HASH,
    resultSha256: HASH,
    sourceSha256: HASH,
    snapshotSha256: HASH,
    artifactId: "artifact:saved-review",
    actor: { host: "gitlab.example.test", id: "user:42" },
    requestedActions: null,
    capabilities: {
      scmProvider: "gitlab",
      host: "gitlab.example.test",
      summary: true,
      inline: true,
    },
    selections: [{ inventoryId: "issue:0:one", presentation: "inline" }],
    actions: [{ actionId: HASH, kind: "publish-inline", actionSha256: HASH }],
  };
}

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

describe("saved review inspection intent", () => {
  it.each([
    {
      name: "retains the original source-bound inventory after readback faults and opens it cold",
      mode: "retention-cold",
    },
    {
      name: "holds the receipt gate from final scan through intent unlink against a real import",
      mode: "gate",
    },
    {
      name: "opens the imported source-bound inventory without provider calls",
      mode: "imported-inventory",
    },
    {
      name: "preserves attached review custody through late import and mixed Git cleanup",
      mode: "deletion-attached",
    },
    {
      name: "preserves orphan and interrupted review custody through deletion resume",
      mode: "deletion-resume",
    },
    {
      name: "rejects malformed and wrong-kind review receipt journal slots",
      mode: "receipt-decoder",
    },
    {
      name: "retains one matching terminal step and root intent use from the authentic saved review",
      mode: "projection",
    },
    {
      name: "refuses a concurrent saved-run change before binding the inspection intent",
      mode: "cas",
    },
    {
      name: "resumes an unrelated saved-run deletion after its record is removed beside a real review receipt",
      mode: "unrelated-resume",
    },
    {
      name: "refuses changed or unauthorised review receipt evidence after unrelated run removal",
      mode: "unrelated-changes",
    },
  ])(
    "$name",
    async ({ mode }) => {
      const startedAt = performance.now();
      const markStage = (stage: string) =>
        console.info(
          `saved-inspection-stage ${mode} ${stage} ${Math.round(performance.now() - startedAt)}ms`,
        );
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
        actor: { host, id: "user:42" },
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
      const receiptStore = new FileScmDeliveryReceiptStore(receiptRoot);
      const receipt = createReviewDeliveryRecord(
        manifest,
        sha256("inspection-store"),
        randomBytes(32).toString("base64url"),
      );
      await receiptStore.claimReview(receipt, () => undefined);
      markStage("review-receipt-claimed");
      const selectionChoices = plan.findings
        .map((finding) => ({ inventoryId: finding.inventoryId, presentation: "summary" as const }))
        .sort((a, b) => a.inventoryId.localeCompare(b.inventoryId));
      if (mode === "unrelated-resume" || mode === "unrelated-changes") {
        const unrelatedRootName = resolve(fixture.root, "unrelated-imported-custody");
        await mkdir(unrelatedRootName);
        const unrelatedRoot = await realpath(unrelatedRootName);
        const unrelatedState = resolve(unrelatedRoot, "runs");
        const destinationStoreId = sha256("unrelated-inspection-imported-store");
        const fenced = updateReviewDeliveryRecord(receipt, {
          custody: {
            state: "fenced-out",
            transferId: "transfer:unrelated-inspection",
            otherStoreId: destinationStoreId,
          },
        });
        await receiptStore.compareAndSwapReview(receipt.sha256, fenced, () => undefined);
        const importedReceipt = createReviewDeliveryImportRecord(fenced, destinationStoreId);
        const importedStore = new FileScmDeliveryReceiptStore(resolve(unrelatedRoot, "receipts"));
        await importedStore.claimReviewImport(importedReceipt, () => undefined);
        expect(await importedStore.loadReview(importedReceipt.idempotencyKey)).toEqual(
          importedReceipt,
        );
        if (mode === "unrelated-changes") {
          const staleRootName = resolve(fixture.root, "unrelated-receipt-stale-preview");
          await mkdir(staleRootName);
          const staleRoot = await realpath(staleRootName);
          const staleState = resolve(staleRoot, "runs");
          const staleStore = new FileScmDeliveryReceiptStore(resolve(staleRoot, "receipts"));
          await staleStore.claimReviewImport(importedReceipt, () => undefined);
          const staleRun = { ...authoringReviewFindingsRecord(), id: "unrelated-stale-preview" };
          await new FileRunStore(staleState).save(staleRun);
          const stalePreview = await previewRunDeletion(staleState, staleRun.id);
          expect(stalePreview.unresolved).toBe(0);
          const advancedReceipt = updateReviewDeliveryRecord(importedReceipt, {
            custody: { ...importedReceipt.custody, state: "active" },
          });
          const staleApply = await applyRunDeletion(
            staleState,
            staleRun.id,
            stalePreview.confirmation,
            {
              async beforeFinalReceiptGate() {
                await staleStore.compareAndSwapReview(
                  importedReceipt.sha256,
                  advancedReceipt,
                  () => undefined,
                );
              },
            },
          );
          if (staleApply.complete) {
            const remainingJournals = await readdir(
              resolve(staleState, ".docsfab-run-delete-journals"),
            ).catch((error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return [];
              throw error;
            });
            const savedRunPresent = await new FileRunStore(staleState).get(staleRun.id).then(
              () => true,
              (error: { code?: string }) => {
                if (error.code === "record-not-found") return false;
                throw error;
              },
            );
            const advancedReceiptPreserved =
              (await staleStore.loadReview(importedReceipt.idempotencyKey))?.sha256 ===
              advancedReceipt.sha256;
            throw new Error(
              `stale-preview-certificate-accepted complete=${staleApply.complete} unresolved=${staleApply.unresolved} privateJournals=${remainingJournals.length} savedRunPresent=${savedRunPresent} advancedReceiptPreserved=${advancedReceiptPreserved}`,
            );
          }
          expect(staleApply).toMatchObject({ complete: false, removed: 0 });
          expect(staleApply.nextAction).toContain("Review receipt evidence changed");
          expect(await new FileRunStore(staleState).get(staleRun.id)).toBeDefined();
          expect(await staleStore.loadReview(importedReceipt.idempotencyKey)).toEqual(
            advancedReceipt,
          );
          const staleJournalNames = await readdir(
            resolve(staleState, ".docsfab-run-delete-journals"),
          ).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return [];
            throw error;
          });
          expect(staleJournalNames).toEqual([]);

          const prepareInterrupted = async (name: string) => {
            const scenarioRootName = resolve(fixture.root, `unrelated-receipt-${name}`);
            await mkdir(scenarioRootName);
            const scenarioRoot = await realpath(scenarioRootName);
            const state = resolve(scenarioRoot, "runs");
            const store = new FileScmDeliveryReceiptStore(resolve(scenarioRoot, "receipts"));
            await store.claimReviewImport(importedReceipt, () => undefined);
            const run = { ...authoringReviewFindingsRecord(), id: `unrelated-${name}` };
            await new FileRunStore(state).save(run);
            const preview = await previewRunDeletion(state, run.id);
            expect(preview.unresolved).toBe(0);
            const first = await applyRunDeletion(state, run.id, preview.confirmation, {
              afterRemove(path) {
                if (path === resolve(state, `${run.id}.json`))
                  throw new Error(`injected interruption after ${name} run removal`);
              },
            });
            expect(first.complete).toBe(false);
            expect(first.nextAction).toContain(`injected interruption after ${name} run removal`);
            await expect(new FileRunStore(state).get(run.id)).rejects.toMatchObject({
              code: "record-not-found",
            });
            expect(await store.loadReview(importedReceipt.idempotencyKey)).toEqual(importedReceipt);
            return { scenarioRoot, state, store, run, preview };
          };
          const expectPreserved = async (
            scenario: Awaited<ReturnType<typeof prepareInterrupted>>,
          ) => {
            await expect(
              new FileRunStore(scenario.state).get(scenario.run.id),
            ).rejects.toMatchObject({
              code: "record-not-found",
            });
            expect(
              await readdir(resolve(scenario.state, ".docsfab-run-delete-journals")),
            ).toHaveLength(1);
          };
          const forgedCertificate = await prepareInterrupted("matching-forged-certificate");
          const forgedSlot = resolve(
            forgedCertificate.scenarioRoot,
            "receipts",
            importedReceipt.idempotencyKey,
            "000000.json",
          );
          const forgedReplacement = `${forgedSlot}.replacement`;
          await writeFile(forgedReplacement, await readFile(forgedSlot), { mode: 0o600 });
          await rename(forgedReplacement, forgedSlot);
          const forgedDirectory = resolve(forgedCertificate.state, ".docsfab-run-delete-journals");
          const forgedNames = await readdir(forgedDirectory);
          expect(forgedNames).toHaveLength(1);
          const forgedPath = resolve(forgedDirectory, forgedNames[0]!);
          const forgedJournal = JSON.parse(await readFile(forgedPath, "utf8")) as {
            approved: { delivery: RunDeliveryDeletionInventory };
          };
          const forgedEntry =
            forgedJournal.approved.delivery.unrelatedReviewReceipts?.[0]?.entries.find(
              (entry) => entry.path === forgedSlot,
            ) as { dev: number; ino: number; size: number; mtimeMs: number } | undefined;
          expect(forgedEntry).toBeDefined();
          const forgedStat = await lstat(forgedSlot);
          forgedEntry!.dev = forgedStat.dev;
          forgedEntry!.ino = forgedStat.ino;
          forgedEntry!.size = forgedStat.size;
          forgedEntry!.mtimeMs = forgedStat.mtimeMs;
          const { digest: _forgedPriorDigest, ...forgedBody } = forgedJournal.approved.delivery;
          (forgedJournal.approved.delivery as { digest: string }).digest =
            runDeliveryInventoryDigest(forgedBody);
          await writeFile(forgedPath, JSON.stringify(forgedJournal), { mode: 0o600 });
          const forgedOutcome = await applyRunDeletion(
            forgedCertificate.state,
            forgedCertificate.run.id,
            forgedCertificate.preview.confirmation,
          ).then(
            (result) => ({ kind: "resolved" as const, result }),
            (error: unknown) => ({ kind: "rejected" as const, error }),
          );
          if (forgedOutcome.kind === "resolved") {
            const remainingJournals = await readdir(forgedDirectory).catch(
              (error: NodeJS.ErrnoException) => {
                if (error.code === "ENOENT") return [];
                throw error;
              },
            );
            const survivingReceipt = await forgedCertificate.store.loadReview(
              importedReceipt.idempotencyKey,
            );
            throw new Error(
              `forged-certificate-resolved complete=${forgedOutcome.result.complete} unresolved=${forgedOutcome.result.unresolved} privateJournals=${remainingJournals.length} unrelatedReceiptPreserved=${survivingReceipt?.sha256 === importedReceipt.sha256}`,
            );
          }
          expect(forgedOutcome.error).toMatchObject({ code: "journal-invalid" });
          await expectPreserved(forgedCertificate);
          expect(await forgedCertificate.store.loadReview(importedReceipt.idempotencyKey)).toEqual(
            importedReceipt,
          );

          const changedSlot = await prepareInterrupted("changed-slot");
          const slot = resolve(
            changedSlot.scenarioRoot,
            "receipts",
            importedReceipt.idempotencyKey,
            "000000.json",
          );
          const replacement = `${slot}.replacement`;
          await writeFile(replacement, await readFile(slot), { mode: 0o600 });
          await rename(replacement, slot);
          const changedSlotResume = await applyRunDeletion(
            changedSlot.state,
            changedSlot.run.id,
            changedSlot.preview.confirmation,
          );
          expect(changedSlotResume).toMatchObject({ complete: false });
          expect(changedSlotResume.nextAction).toContain("Review receipt");
          await expectPreserved(changedSlot);
          expect(await changedSlot.store.loadReview(importedReceipt.idempotencyKey)).toEqual(
            importedReceipt,
          );

          const addedSlot = await prepareInterrupted("added-slot");
          const activeReceipt = updateReviewDeliveryRecord(importedReceipt, {
            custody: { ...importedReceipt.custody, state: "active" },
          });
          await addedSlot.store.compareAndSwapReview(
            importedReceipt.sha256,
            activeReceipt,
            () => undefined,
          );
          const addedSlotResume = await applyRunDeletion(
            addedSlot.state,
            addedSlot.run.id,
            addedSlot.preview.confirmation,
          );
          expect(addedSlotResume).toMatchObject({ complete: false });
          expect(addedSlotResume.nextAction).toContain("Review receipt");
          await expectPreserved(addedSlot);
          expect(await addedSlot.store.loadReview(importedReceipt.idempotencyKey)).toEqual(
            activeReceipt,
          );

          const replacedRoot = await prepareInterrupted("replaced-root");
          const receiptRoot = resolve(replacedRoot.scenarioRoot, "receipts");
          const priorRoot = resolve(replacedRoot.scenarioRoot, "prior-receipts");
          await rename(receiptRoot, priorRoot);
          await mkdir(receiptRoot, { mode: 0o700 });
          await cp(
            resolve(priorRoot, importedReceipt.idempotencyKey),
            resolve(receiptRoot, importedReceipt.idempotencyKey),
            { recursive: true },
          );
          const replacedRootResume = await applyRunDeletion(
            replacedRoot.state,
            replacedRoot.run.id,
            replacedRoot.preview.confirmation,
          );
          expect(replacedRootResume).toMatchObject({ complete: false });
          expect(replacedRootResume.nextAction).toContain("Review receipt");
          await expectPreserved(replacedRoot);
          expect(await replacedRoot.store.loadReview(importedReceipt.idempotencyKey)).toEqual(
            importedReceipt,
          );

          const missingTombstone = await prepareInterrupted("missing-tombstone");
          const tombstoneDirectory = resolve(
            missingTombstone.state,
            ".docsfab-run-delete-tombstones",
          );
          const tombstoneNames = await readdir(tombstoneDirectory);
          expect(tombstoneNames).toHaveLength(1);
          await unlink(resolve(tombstoneDirectory, tombstoneNames[0]!));
          const missingTombstoneOutcome = await applyRunDeletion(
            missingTombstone.state,
            missingTombstone.run.id,
            missingTombstone.preview.confirmation,
          ).then(
            (result) => ({ kind: "resolved" as const, result }),
            (error: unknown) => ({ kind: "rejected" as const, error }),
          );
          if (missingTombstoneOutcome.kind === "resolved") {
            const remainingJournals = await readdir(
              resolve(missingTombstone.state, ".docsfab-run-delete-journals"),
            ).catch((error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return [];
              throw error;
            });
            const unrelatedReceiptPreserved =
              (await missingTombstone.store.loadReview(importedReceipt.idempotencyKey))?.sha256 ===
              importedReceipt.sha256;
            throw new Error(
              `missing-tombstone-resolved complete=${missingTombstoneOutcome.result.complete} unresolved=${missingTombstoneOutcome.result.unresolved} privateJournals=${remainingJournals.length} unrelatedReceiptPreserved=${unrelatedReceiptPreserved}`,
            );
          }
          await expect(Promise.reject(missingTombstoneOutcome.error)).rejects.toThrow();
          await expectPreserved(missingTombstone);
          expect(await missingTombstone.store.loadReview(importedReceipt.idempotencyKey)).toEqual(
            importedReceipt,
          );

          const changedJournal = await prepareInterrupted("changed-journal");
          const journalDirectory = resolve(changedJournal.state, ".docsfab-run-delete-journals");
          const journalNames = await readdir(journalDirectory);
          expect(journalNames).toHaveLength(1);
          const journalPath = resolve(journalDirectory, journalNames[0]!);
          const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
            approved: { confirmation: string };
          };
          journal.approved.confirmation = HASH;
          await writeFile(journalPath, JSON.stringify(journal), { mode: 0o600 });
          await expect(
            applyRunDeletion(
              changedJournal.state,
              changedJournal.run.id,
              changedJournal.preview.confirmation,
            ),
          ).rejects.toMatchObject({ code: "journal-invalid" });
          await expectPreserved(changedJournal);
          expect(await changedJournal.store.loadReview(importedReceipt.idempotencyKey)).toEqual(
            importedReceipt,
          );

          const changedCertificate = await prepareInterrupted("changed-certificate");
          const certificateDirectory = resolve(
            changedCertificate.state,
            ".docsfab-run-delete-journals",
          );
          const certificateNames = await readdir(certificateDirectory);
          expect(certificateNames).toHaveLength(1);
          const certificatePath = resolve(certificateDirectory, certificateNames[0]!);
          const certificateJournal = JSON.parse(await readFile(certificatePath, "utf8")) as {
            approved: {
              delivery: {
                unrelatedReviewReceipts: Array<{ entries: Array<{ ino: number }> }>;
              };
            };
          };
          const certificateEntry =
            certificateJournal.approved.delivery.unrelatedReviewReceipts[0]?.entries[0];
          expect(certificateEntry).toBeDefined();
          certificateEntry!.ino += 1;
          await writeFile(certificatePath, JSON.stringify(certificateJournal), { mode: 0o600 });
          await expect(
            applyRunDeletion(
              changedCertificate.state,
              changedCertificate.run.id,
              changedCertificate.preview.confirmation,
            ),
          ).rejects.toMatchObject({ code: "journal-invalid" });
          await expectPreserved(changedCertificate);
          expect(await changedCertificate.store.loadReview(importedReceipt.idempotencyKey)).toEqual(
            importedReceipt,
          );

          const staleConfirmation = await prepareInterrupted("stale-confirmation");
          await expect(
            applyRunDeletion(staleConfirmation.state, staleConfirmation.run.id, HASH),
          ).rejects.toMatchObject({ code: "confirmation-changed" });
          await expectPreserved(staleConfirmation);
          expect(await staleConfirmation.store.loadReview(importedReceipt.idempotencyKey)).toEqual(
            importedReceipt,
          );

          const malformedReceipt = await prepareInterrupted("malformed-receipt");
          const malformedSlot = resolve(
            malformedReceipt.scenarioRoot,
            "receipts",
            importedReceipt.idempotencyKey,
            "000000.json",
          );
          const malformedEnvelope = JSON.parse(await readFile(malformedSlot, "utf8")) as Record<
            string,
            unknown
          >;
          const malformedBytes = JSON.stringify({ ...malformedEnvelope, kind: "invalid-slot" });
          await writeFile(malformedSlot, malformedBytes, { mode: 0o600 });
          const malformedResume = await applyRunDeletion(
            malformedReceipt.state,
            malformedReceipt.run.id,
            malformedReceipt.preview.confirmation,
          );
          expect(malformedResume).toMatchObject({ complete: false });
          await expectPreserved(malformedReceipt);
          expect(await readFile(malformedSlot, "utf8")).toBe(malformedBytes);

          const missingJournal = await prepareInterrupted("missing-journal");
          const missingJournalDirectory = resolve(
            missingJournal.state,
            ".docsfab-run-delete-journals",
          );
          const missingJournalNames = await readdir(missingJournalDirectory);
          expect(missingJournalNames).toHaveLength(1);
          await unlink(resolve(missingJournalDirectory, missingJournalNames[0]!));
          await expect(
            applyRunDeletion(
              missingJournal.state,
              missingJournal.run.id,
              missingJournal.preview.confirmation,
            ),
          ).rejects.toMatchObject({ code: "record-not-found" });
          expect(await missingJournal.store.loadReview(importedReceipt.idempotencyKey)).toEqual(
            importedReceipt,
          );

          const legacyJournal = await prepareInterrupted("legacy-journal");
          const legacyJournalDirectory = resolve(
            legacyJournal.state,
            ".docsfab-run-delete-journals",
          );
          const legacyJournalNames = await readdir(legacyJournalDirectory);
          expect(legacyJournalNames).toHaveLength(1);
          const legacyJournalPath = resolve(legacyJournalDirectory, legacyJournalNames[0]!);
          const legacyValue = JSON.parse(await readFile(legacyJournalPath, "utf8")) as {
            approved: Record<string, unknown> & {
              confirmation: string;
              delivery: Record<string, unknown> & {
                digest: string;
                unrelatedReviewReceipts?: unknown;
              };
            };
          };
          const legacyApproved = legacyValue.approved;
          delete legacyApproved.delivery.unrelatedReviewReceipts;
          const { digest: _priorDigest, ...legacyDeliveryBody } = legacyApproved.delivery;
          legacyApproved.delivery.digest = sha256(
            JSON.stringify({
              domain: "docsfab-run-delivery-deletion-inventory-v1",
              inventory: legacyDeliveryBody,
            }),
          );
          const legacyStable = {
            runId: legacyApproved.runId,
            stateDirectory: legacyApproved.stateDirectory,
            roots: legacyApproved.roots,
            entries: legacyApproved.entries,
            artifacts: legacyApproved.artifacts,
            residuals: legacyApproved.residuals,
            sharedCaches: legacyApproved.sharedCaches,
            patchRoots: legacyApproved.patchRoots,
            indexRows: legacyApproved.indexRows,
            indexOverflow: legacyApproved.indexOverflow,
            indexFile: legacyApproved.indexFile,
            overflowFile: legacyApproved.overflowFile,
            delivery: legacyApproved.delivery,
            gitCleanups: legacyApproved.gitCleanups,
            gitBranches: legacyApproved.gitBranches,
            keptBranches: legacyApproved.keptBranches,
          };
          legacyApproved.confirmation = sha256(
            `docsfab-run-deletion-preview-v1\0${JSON.stringify(legacyStable)}`,
          );
          await writeFile(legacyJournalPath, JSON.stringify(legacyValue), { mode: 0o600 });
          expect(
            (await previewRunDeletion(legacyJournal.state, legacyJournal.run.id)).confirmation,
          ).toBe(legacyApproved.confirmation);
          const legacyResume = await applyRunDeletion(
            legacyJournal.state,
            legacyJournal.run.id,
            legacyApproved.confirmation,
          );
          expect(legacyResume).toMatchObject({ complete: false });
          expect(legacyResume.nextAction).toContain("Review receipt");
          await expectPreserved(legacyJournal);
          expect(await legacyJournal.store.loadReview(importedReceipt.idempotencyKey)).toEqual(
            importedReceipt,
          );

          const newReceipt = await prepareInterrupted("new-receipt");
          const foreignActor = { ...plan.actor, id: "user:unrelated-review" };
          const foreignPlan = {
            ...plan,
            actor: foreignActor,
            actions: plan.actions.map((action) => {
              const { id: _id, ...withoutId } = action;
              const body = {
                ...withoutId,
                binding: { ...action.binding, actor: foreignActor },
              };
              return { ...body, id: sha256(canonicalJson(body)) };
            }),
          };
          const foreignReceipt = createReviewDeliveryRecord(
            createReviewDeliveryManifest(foreignPlan),
            destinationStoreId,
            randomBytes(32).toString("base64url"),
          );
          await newReceipt.store.claimReview(foreignReceipt, () => undefined);
          expect(await newReceipt.store.loadReview(foreignReceipt.idempotencyKey)).toEqual(
            foreignReceipt,
          );
          const newReceiptResume = await applyRunDeletion(
            newReceipt.state,
            newReceipt.run.id,
            newReceipt.preview.confirmation,
          );
          if (newReceiptResume.complete) {
            const remainingJournals = await readdir(
              resolve(newReceipt.state, ".docsfab-run-delete-journals"),
            ).catch((error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return [];
              throw error;
            });
            const originalStillPresent =
              (await newReceipt.store.loadReview(importedReceipt.idempotencyKey))?.sha256 ===
              importedReceipt.sha256;
            const newStillPresent =
              (await newReceipt.store.loadReview(foreignReceipt.idempotencyKey))?.sha256 ===
              foreignReceipt.sha256;
            throw new Error(
              `unknown-review-receipt-accepted complete=${newReceiptResume.complete} unresolved=${newReceiptResume.unresolved} privateJournals=${remainingJournals.length} originalReceiptPreserved=${originalStillPresent} newReceiptPreserved=${newStillPresent}`,
            );
          }
          expect(newReceiptResume).toMatchObject({ complete: false });
          expect(newReceiptResume.nextAction).toContain("Review receipt");
          await expectPreserved(newReceipt);
          expect(await newReceipt.store.loadReview(importedReceipt.idempotencyKey)).toEqual(
            importedReceipt,
          );
          expect(await newReceipt.store.loadReview(foreignReceipt.idempotencyKey)).toEqual(
            foreignReceipt,
          );

          const partialRootName = resolve(fixture.root, "unrelated-receipt-partial-source");
          await mkdir(partialRootName);
          const partialRoot = await realpath(partialRootName);
          const partialState = resolve(partialRoot, "runs");
          const partialRun = {
            ...authoringReviewFindingsRecord(),
            id: "unrelated-partial-source-run",
          };
          await new FileRunStore(partialState).save(partialRun);
          const partialStore = new FileScmDeliveryReceiptStore(resolve(partialRoot, "receipts"));
          await partialStore.claimReviewImport(importedReceipt, () => undefined);
          const partialArtifactRoot = resolve(partialRoot, "artifacts");
          const partialArtifacts = new DurableArtifactStore(partialArtifactRoot);
          const partialSource = await retainSourceSnapshotParts(partialArtifacts, {
            runId: partialRun.id,
            sourceSha256: source.changeSourceSha256,
            repositoryIdentitySha256: source.revision.repository.identitySha256,
            reviewedHeadSha: head,
            snapshotSha256,
            manifest: {
              observationId: "fixture:unrelated-manifest",
              bytes: new TextEncoder().encode("manifest\n"),
            },
            diff: {
              observationId: "fixture:unrelated-diff",
              bytes: new TextEncoder().encode("diff\n"),
            },
            rows: [],
          });
          const partialSourceRoot = decodeSourceSnapshotRoot(
            await partialArtifacts.getRecord(partialSource.rootObjectSha256, { readOnly: true }),
          );
          expect(partialSourceRoot.partDigests).toHaveLength(1);
          const partDigest = partialSourceRoot.partDigests[0]!;
          const partPath = resolve(partialArtifactRoot, "objects", "sha256", `${partDigest}.json`);
          const markerDirectory = resolve(partialState, "reports", partialRun.id);
          await mkdir(markerDirectory, { recursive: true, mode: 0o700 });
          const marker = resolve(markerDirectory, "interrupt.txt");
          await writeFile(marker, "interrupt before source part cleanup\n", { mode: 0o600 });
          const partialPreview = await previewRunDeletion(partialState, partialRun.id);
          expect(partialPreview.unresolved).toBe(0);
          const partialFirst = await applyRunDeletion(
            partialState,
            partialRun.id,
            partialPreview.confirmation,
            {
              async afterRemove(path) {
                if (path !== marker) return;
                await markArtifactObjectForDeletion(partialArtifactRoot, partDigest);
                await unlink(partPath);
                throw new Error("injected interruption after approved source part removal");
              },
            },
          );
          expect(partialFirst.complete).toBe(false);
          expect(partialFirst.nextAction).toContain("injected interruption");
          expect(await readdir(resolve(partialArtifactRoot, "objects", "sha256"))).toContain(
            `${partialSource.rootObjectSha256}.json`,
          );
          expect(await readdir(resolve(partialArtifactRoot, "objects", "sha256"))).not.toContain(
            `${partDigest}.json`,
          );
          const foreignReference = {
            kind: "foreign-artifact-reference",
            reference: {
              kind: "review-result",
              digest: partDigest,
              repositoryRevision: "foreign-revision",
              repositoryContentDigest: "foreign-content",
            },
          };
          const foreignDigest = opaqueRecordDigest(foreignReference);
          await partialArtifacts.putRecord(foreignDigest, foreignReference);
          const sharedResumed = await applyRunDeletion(
            partialState,
            partialRun.id,
            partialPreview.confirmation,
          );
          expect(sharedResumed).toMatchObject({ complete: false });
          expect(sharedResumed.nextAction).toContain("newly shared review source part");
          expect(await partialStore.loadReview(importedReceipt.idempotencyKey)).toEqual(
            importedReceipt,
          );
          expect(await readdir(resolve(partialState, ".docsfab-run-delete-journals"))).toHaveLength(
            1,
          );
          expect(await new FileRunStore(partialState).get(partialRun.id)).toBeDefined();
          await markArtifactObjectForDeletion(partialArtifactRoot, foreignDigest);
          await unlink(resolve(partialArtifactRoot, "objects", "sha256", `${foreignDigest}.json`));
          const partialResumed = await applyRunDeletion(
            partialState,
            partialRun.id,
            partialPreview.confirmation,
          );
          expect(partialResumed.complete, partialResumed.nextAction).toBe(true);
          expect(await partialStore.loadReview(importedReceipt.idempotencyKey)).toEqual(
            importedReceipt,
          );
          expect(await readdir(resolve(partialArtifactRoot, "objects", "sha256"))).not.toContain(
            `${partialSource.rootObjectSha256}.json`,
          );
          return;
        }
        const unrelated = {
          ...authoringReviewFindingsRecord(),
          id: "unrelated-saved-run-beside-review-receipt",
        };
        await new FileRunStore(unrelatedState).save(unrelated);
        const unrelatedPreview = await previewRunDeletion(unrelatedState, unrelated.id);
        expect(unrelatedPreview.unresolved).toBe(0);
        expect(
          (await applyRunDeletion(unrelatedState, unrelated.id, unrelatedPreview.confirmation))
            .complete,
        ).toBe(true);
        expect(await importedStore.loadReview(importedReceipt.idempotencyKey)).toEqual(
          importedReceipt,
        );
        const interruptedUnrelated = {
          ...authoringReviewFindingsRecord(),
          id: "unrelated-saved-run-removed-before-resume",
        };
        await new FileRunStore(unrelatedState).save(interruptedUnrelated);
        const interruptedPreview = await previewRunDeletion(
          unrelatedState,
          interruptedUnrelated.id,
        );
        expect(interruptedPreview.unresolved).toBe(0);
        const interruptedRecordPath = resolve(unrelatedState, `${interruptedUnrelated.id}.json`);
        const receiptJournalPath = resolve(
          unrelatedRoot,
          "receipts",
          importedReceipt.idempotencyKey,
        );
        const receiptSlotNames = await readdir(receiptJournalPath);
        const receiptBytesBefore = await Promise.all(
          receiptSlotNames.map((name) => readFile(resolve(receiptJournalPath, name))),
        );
        const interruptedUnrelatedDeletion = await applyRunDeletion(
          unrelatedState,
          interruptedUnrelated.id,
          interruptedPreview.confirmation,
          {
            afterRemove(path) {
              if (path === interruptedRecordPath)
                throw new Error("injected interruption after unrelated run record removal");
            },
          },
        );
        expect(interruptedUnrelatedDeletion.complete).toBe(false);
        expect(interruptedUnrelatedDeletion.nextAction).toContain(
          "injected interruption after unrelated run record removal",
        );
        await expect(
          new FileRunStore(unrelatedState).get(interruptedUnrelated.id),
        ).rejects.toMatchObject({ code: "record-not-found" });
        expect(await importedStore.loadReview(importedReceipt.idempotencyKey)).toEqual(
          importedReceipt,
        );
        const deleteOutput: string[] = [];
        const log = vi.spyOn(console, "log").mockImplementation((value: string) => {
          deleteOutput.push(value);
        });
        await handleRunsCommand([
          "delete",
          interruptedUnrelated.id,
          "--state-dir",
          unrelatedState,
          "--confirm",
          interruptedPreview.confirmation,
          "--json",
        ]);
        log.mockRestore();
        const unrelatedResume: unknown = JSON.parse(deleteOutput.at(-1) ?? "null");
        expect(unrelatedResume).toMatchObject({ complete: true, unresolved: 0 });
        expect(await readdir(resolve(unrelatedState, ".docsfab-run-delete-journals"))).toEqual([]);
        expect(await importedStore.loadReview(importedReceipt.idempotencyKey)).toEqual(
          importedReceipt,
        );
        expect(await readdir(receiptJournalPath)).toEqual(receiptSlotNames);
        expect(
          await Promise.all(
            receiptSlotNames.map((name) => readFile(resolve(receiptJournalPath, name))),
          ),
        ).toEqual(receiptBytesBefore);
        return;
      }
      if (mode === "projection") {
        const retainedProjection = await retainSavedReviewInspectionIntent({
          runStore,
          artifacts,
          receiptStore,
          runId: request.runId,
          plan,
          selections: selectionChoices,
        });
        expect(retainedProjection.kind).toBe("saved-review-inventory");
        const savedProjection = decodeSuccessfulReviewRunRecord(
          (await runStore.getWithDigest(request.runId, { readOnly: true })).record,
        );
        const stepUse = savedProjection.steps
          .at(-1)
          ?.artifacts?.filter((use) => use.reference.kind === "review-delivery-intent");
        const rootUse = savedProjection.artifacts?.filter(
          (use) => use.reference.kind === "review-delivery-intent",
        );
        expect(stepUse).toHaveLength(1);
        expect(rootUse).toEqual(stepUse);
        expect(rootUse?.[0]?.reference.digest).toBe(retainedProjection.intentObjectSha256);
        return;
      }
      if (mode === "cas") {
        const actualPut = artifacts.putRecord.bind(artifacts);
        let concurrentDigest: string | undefined;
        vi.spyOn(artifacts, "putRecord").mockImplementationOnce(async (...args) => {
          const result = await actualPut(...args);
          const concurrent = { ...before, instruction: "Concurrent saved review update" };
          await runStore.replaceIfDigest(
            request.runId,
            beforeDigest,
            concurrent,
            runRecordMaxBytes().value,
          );
          concurrentDigest = (await runStore.getWithDigest(request.runId)).sha256;
          return result;
        });
        const publicationAttempt = vi.fn();
        await expect(
          (async () => {
            const inventory = await retainSavedReviewInspectionIntent({
              runStore,
              artifacts,
              receiptStore,
              runId: request.runId,
              plan,
              selections: selectionChoices,
            });
            publicationAttempt(inventory);
          })(),
        ).rejects.toThrow();
        expect(concurrentDigest).toBeDefined();
        expect(concurrentDigest).not.toBe(beforeDigest);
        const afterConcurrent = await runStore.getWithDigest(request.runId, { readOnly: true });
        expect(afterConcurrent.sha256).toBe(concurrentDigest);
        const preserved = decodeSuccessfulReviewRunRecord(afterConcurrent.record);
        expect(preserved.instruction).toBe("Concurrent saved review update");
        expect(
          preserved.artifacts?.some((use) => use.reference.kind === "review-delivery-intent"),
        ).toBe(false);
        expect(publicationAttempt).not.toHaveBeenCalled();
        return;
      }
      const cas =
        mode === "retention-cold"
          ? vi.spyOn(runStore, "replaceIfDigest").mockRejectedValueOnce(new Error("CAS conflict"))
          : undefined;
      if (mode === "retention-cold") {
        const readbackState = resolve(fixture.root, "drifted-readback-runs");
        await cp(fixture.stateDirectory, readbackState, { recursive: true });
        const readbackStore = new FileRunStore(readbackState);
        const actualReadbackReplace = readbackStore.replaceIfDigest.bind(readbackStore);
        const actualReadbackGet = readbackStore.getWithDigest.bind(readbackStore);
        let replaced = false;
        let driftReturned = false;
        vi.spyOn(readbackStore, "replaceIfDigest").mockImplementation(async (...args) => {
          const result = await actualReadbackReplace(...args);
          replaced = true;
          return result;
        });
        vi.spyOn(readbackStore, "getWithDigest").mockImplementation(async (...args) => {
          const value = await actualReadbackGet(...args);
          if (!replaced || driftReturned) return value;
          driftReturned = true;
          return {
            ...value,
            record: {
              ...decodeSuccessfulReviewRunRecord(value.record),
              instruction: "readback drift",
            },
          };
        });
        await expect(
          retainSavedReviewInspectionIntent({
            runStore: readbackStore,
            artifacts,
            receiptStore,
            runId: request.runId,
            plan,
            selections: selectionChoices,
          }),
        ).rejects.toThrow("saved-run-readback-mismatch");
        expect(driftReturned).toBe(true);
        const uncertainState = resolve(fixture.root, "uncertain-runs");
        await cp(fixture.stateDirectory, uncertainState, { recursive: true });
        const uncertainRunStore = new FileRunStore(uncertainState);
        const actualReplace = uncertainRunStore.replaceIfDigest.bind(uncertainRunStore);
        vi.spyOn(uncertainRunStore, "replaceIfDigest").mockImplementationOnce(async (...args) => {
          await actualReplace(...args);
          throw new Error("uncertain after CAS");
        });
        const publicationAttempt = vi.fn();
        await expect(
          (async () => {
            const inventory = await retainSavedReviewInspectionIntent({
              runStore: uncertainRunStore,
              artifacts,
              receiptStore,
              runId: request.runId,
              plan,
              selections: selectionChoices,
            });
            publicationAttempt(inventory);
          })(),
        ).rejects.toThrow("uncertain after CAS");
        expect(publicationAttempt).not.toHaveBeenCalled();
        expect(
          decodeSuccessfulReviewRunRecord(
            (await uncertainRunStore.getWithDigest(request.runId)).record,
          ).artifacts?.some((use) => use.reference.kind === "review-delivery-intent"),
        ).toBe(true);
        await expect(
          (async () => {
            const inventory = await retainSavedReviewInspectionIntent({
              runStore,
              artifacts,
              receiptStore,
              runId: request.runId,
              plan,
              selections: selectionChoices,
            });
            publicationAttempt(inventory);
          })(),
        ).rejects.toThrow("CAS conflict");
        expect(publicationAttempt).not.toHaveBeenCalled();
        expect((await runStore.getWithDigest(request.runId)).sha256).toBe(beforeDigest);
      }
      const retained = await retainSavedReviewInspectionIntent({
        runStore,
        artifacts,
        receiptStore,
        runId: request.runId,
        plan,
        selections: selectionChoices,
      });
      markStage("inspection-intent-retained");
      const storedIntent = decodeReviewInspectionIntent(
        await artifacts.getRecord(retained.intentObjectSha256, { readOnly: true }),
      );
      expect(storedIntent.requestedActions).toBe("overview");
      expect(Buffer.byteLength(canonicalJson(storedIntent), "utf8")).toBeLessThan(
        limit("artifacts.maxObjectBytes").value,
      );
      expect(Object.keys(storedIntent)).not.toContain("originalResult");
      expect(Object.keys(storedIntent)).not.toContain("snapshot");
      expect(Object.keys(storedIntent)).not.toContain("source");
      if (cas) {
        expect(cas).toHaveBeenNthCalledWith(
          1,
          request.runId,
          beforeDigest,
          expect.any(Object),
          runRecordMaxBytes().value,
        );
        expect(cas).toHaveBeenNthCalledWith(
          2,
          request.runId,
          beforeDigest,
          expect.any(Object),
          runRecordMaxBytes().value,
        );
      }
      expect(retained.kind).toBe("saved-review-inventory");
      expect(canonicalJson(retained.originalResult)).toBe(canonicalJson(originalResult));
      expect(retained.plan.findings).toEqual(plan.findings);
      expect(retained.plan.checks).toEqual(plan.checks);
      expect(retained.plan.unresolvedQuestions).toEqual(plan.unresolvedQuestions);
      expect(retained.plan.reviewScope).toEqual(plan.reviewScope);
      expect(retained.plan.limitations).toEqual(plan.limitations);
      const after = decodeSuccessfulReviewRunRecord(
        (await runStore.getWithDigest(request.runId)).record,
      );
      expect(
        (await readFile(resolve(fixture.stateDirectory, `${request.runId}.json`))).byteLength,
      ).toBeLessThan(runRecordMaxBytes().value);
      expect(
        after.steps
          .at(-1)
          ?.artifacts?.find((use) => use.reference.kind === "review-delivery-intent"),
      ).toEqual(after.artifacts?.find((use) => use.reference.kind === "review-delivery-intent"));
      expect(
        after.artifacts?.filter((use) => use.reference.kind !== "review-delivery-intent"),
      ).toEqual(before.artifacts);
      const callsBefore = forgeCalls;
      vi.stubGlobal("fetch", () => {
        throw new Error("Inspection must not call the model.");
      });
      const logs: string[] = [];
      if (mode === "retention-cold" || mode === "imported-inventory") {
        vi.spyOn(console, "log").mockImplementation((value: string) => logs.push(value));
      }
      if (mode === "retention-cold") {
        const cold = await inspectInstalled({
          stateDirectory: fixture.stateDirectory,
          runId: request.runId,
          intentObjectSha256: retained.intentObjectSha256,
        });
        expect(cold.kind).toBe("saved-review-inventory");
        expect(forgeCalls).toBe(callsBefore);
        if (cold.kind !== "saved-review-inventory") throw new Error(cold.code);
        expect(canonicalJson(cold.originalResult)).toBe(canonicalJson(retained.originalResult));
        await handleRunsCommand([
          "show",
          request.runId,
          "--state-dir",
          fixture.stateDirectory,
          "--review-delivery-inventory",
          retained.intentObjectSha256,
          "--json",
        ]);
        expect(JSON.parse(logs.at(-1) ?? "null")).toEqual(cold);
        expect(forgeCalls).toBe(callsBefore);
        const unavailable = await inspectInstalled({
          stateDirectory: fixture.stateDirectory,
          runId: request.runId,
          intentObjectSha256: HASH,
        });
        expect(unavailable).toMatchObject({ kind: "inspection-unavailable", runId: request.runId });
        markStage("cold-inventory-complete");
        return;
      }
      const destinationRootName = resolve(fixture.root, "imported-custody");
      await mkdir(destinationRootName);
      const destinationRoot = await realpath(destinationRootName);
      const importedState = resolve(destinationRoot, "runs");
      await cp(fixture.stateDirectory, importedState, { recursive: true });
      await cp(
        resolve(fixture.stateDirectory, "..", "artifacts"),
        resolve(destinationRoot, "artifacts"),
        { recursive: true },
      );
      if (mode === "imported-inventory") {
        const missingReceipt = await inspectInstalled({
          stateDirectory: importedState,
          runId: request.runId,
          intentObjectSha256: retained.intentObjectSha256,
        });
        if (missingReceipt.kind !== "inspection-unavailable")
          throw new Error(`Missing receipt was admitted: ${JSON.stringify(missingReceipt)}`);
        expect(missingReceipt.code).toBe("unsafe-root");
        expect(missingReceipt.nextAction).toContain("private");
      }
      const destinationStoreId = sha256("inspection-imported-store");
      const fenced = updateReviewDeliveryRecord(receipt, {
        custody: {
          state: "fenced-out",
          transferId: "transfer:inspection",
          otherStoreId: destinationStoreId,
        },
      });
      await receiptStore.compareAndSwapReview(receipt.sha256, fenced, () => undefined);
      const importedReceipt = createReviewDeliveryImportRecord(fenced, destinationStoreId);
      expect(reviewDeliveryImportedLineageMatches(fenced, importedReceipt)).toBe(true);
      const importedStore = new FileScmDeliveryReceiptStore(resolve(destinationRoot, "receipts"));
      await importedStore.claimReviewImport(importedReceipt, () => undefined);
      markStage("imported-receipt-claimed");
      expect(await importedStore.loadEither(importedReceipt.idempotencyKey)).toEqual({
        kind: "review",
        record: importedReceipt,
      });
      if (mode === "imported-inventory") {
        const imported = await inspectInstalled({
          stateDirectory: importedState,
          runId: request.runId,
          intentObjectSha256: retained.intentObjectSha256,
        });
        expect(imported.kind).toBe("saved-review-inventory");
        if (imported.kind !== "saved-review-inventory") throw new Error(imported.code);
        expect(canonicalJson(imported.originalResult)).toBe(canonicalJson(retained.originalResult));
        expect(canonicalJson(imported.plan)).toBe(canonicalJson(retained.plan));
        expect(forgeCalls).toBe(callsBefore);
        await handleRunsCommand([
          "show",
          request.runId,
          "--state-dir",
          importedState,
          "--review-delivery-inventory",
          retained.intentObjectSha256,
          "--json",
        ]);
        expect(JSON.parse(logs.at(-1) ?? "null")).toEqual(imported);
        expect(
          await inspectInstalled({
            stateDirectory: importedState,
            runId: "foreign-saved-run",
            intentObjectSha256: retained.intentObjectSha256,
          }),
        ).toMatchObject({ kind: "inspection-unavailable" });
        const exactSaved = await runStore.getWithDigest(request.runId, { readOnly: true });
        const malformedRun = vi.spyOn(runStore, "getWithDigest");
        const rootOnly = structuredClone(after);
        rootOnly.steps.at(-1)!.artifacts = rootOnly.steps
          .at(-1)!
          .artifacts!.filter((use) => use.reference.kind !== "review-delivery-intent");
        malformedRun.mockResolvedValueOnce({ ...exactSaved, record: rootOnly });
        expect(
          await inspectFromStores({
            runStore,
            artifacts,
            receiptStore,
            runId: request.runId,
            intentObjectSha256: retained.intentObjectSha256,
          }),
        ).toMatchObject({ kind: "inspection-unavailable" });
        const duplicated = structuredClone(after);
        const intentUse = duplicated.artifacts!.find(
          (use) => use.reference.kind === "review-delivery-intent",
        )!;
        duplicated.steps.at(-1)!.artifacts!.push(intentUse);
        duplicated.artifacts!.push(intentUse);
        malformedRun.mockResolvedValueOnce({ ...exactSaved, record: duplicated });
        expect(
          await inspectFromStores({
            runStore,
            artifacts,
            receiptStore,
            runId: request.runId,
            intentObjectSha256: retained.intentObjectSha256,
          }),
        ).toMatchObject({ kind: "inspection-unavailable" });
        malformedRun.mockRestore();
        const readObject = artifacts.getRecord.bind(artifacts);
        vi.spyOn(artifacts, "getRecord").mockImplementation(async (requestedDigest, options) => {
          const value = await readObject(requestedDigest, options);
          if (requestedDigest !== retained.intentObjectSha256) return value;
          const savedIntent = decodeReviewInspectionIntent(value);
          return {
            ...savedIntent,
            requestedActions: null,
          };
        });
        const wrongAddress = await inspectFromStores({
          runStore,
          artifacts,
          receiptStore,
          runId: request.runId,
          intentObjectSha256: retained.intentObjectSha256,
        });
        if (wrongAddress.kind !== "inspection-unavailable")
          throw new Error(`Wrong address was admitted: ${JSON.stringify(wrongAddress)}`);
        expect(wrongAddress.code).toBe("intent-address-mismatch");
        const foreignIntent = { ...storedIntent, runId: "foreign-saved-run" };
        const foreignDigest = opaqueRecordDigest(foreignIntent);
        await artifacts.putRecord(foreignDigest, foreignIntent);
        const foreignRunState = resolve(fixture.root, "foreign-intent-unattached-runs");
        const foreignRunStore = new FileRunStore(foreignRunState);
        await foreignRunStore.save(before);
        await expect(
          inspectReviewIntentForDeletion({
            runStore: foreignRunStore,
            artifacts,
            runId: request.runId,
            intentObjectSha256: foreignDigest,
          }),
        ).rejects.toMatchObject({ code: "intent-run-binding-mismatch" });
        markStage("imported-inventory-complete");
        return;
      }
      const proveGateSpan = async () => {
        markStage("gate-setup-start");
        const gatedRootName = resolve(fixture.root, "gated-imported-custody");
        await mkdir(gatedRootName);
        const gatedRoot = await realpath(gatedRootName);
        const gatedState = resolve(gatedRoot, "runs");
        await cp(importedState, gatedState, { recursive: true });
        await cp(resolve(destinationRoot, "artifacts"), resolve(gatedRoot, "artifacts"), {
          recursive: true,
        });
        const gatedPreview = await previewRunDeletion(gatedState, request.runId);
        markStage("gate-preview-complete");
        expect(gatedPreview.unresolved).toBe(0);
        expect(await readdir(gatedRoot)).not.toContain("receipts");
        let observedLiveGateContention = false;
        let signalGateContention: () => void = () => undefined;
        const gateContention = new Promise<void>((resolveContention) => {
          signalGateContention = resolveContention;
        });
        const gatedStore = new FileScmDeliveryReceiptStore(resolve(gatedRoot, "receipts"), {
          afterReviewImportGateContention() {
            observedLiveGateContention = true;
            signalGateContention();
          },
        });
        let gatedClaim: Promise<unknown> | undefined;
        let writerWhileHeld: "contended" | "claimed" | "failed" | undefined;
        const gatedDeletion = await applyRunDeletion(
          gatedState,
          request.runId,
          gatedPreview.confirmation,
          {
            afterRemove: async (path) => {
              if (!path.endsWith(`${retained.intentObjectSha256}.json`)) return;
              gatedClaim = gatedStore.claimReviewImport(importedReceipt, () => undefined);
              writerWhileHeld = await Promise.race([
                gateContention.then(() => "contended" as const),
                gatedClaim.then(
                  () => "claimed" as const,
                  () => "failed" as const,
                ),
              ]);
              expect(await gatedStore.loadReview(importedReceipt.idempotencyKey)).toBeUndefined();
            },
          },
        );
        markStage("gate-deletion-complete");
        expect(
          writerWhileHeld,
          JSON.stringify({ deletion: gatedDeletion, observedLiveGateContention }),
        ).toBe("contended");
        expect(observedLiveGateContention).toBe(true);
        expect(gatedDeletion.complete).toBe(true);
        expect(gatedClaim).toBeDefined();
        await gatedClaim;
        markStage("gate-writer-complete");
        expect(await gatedStore.loadReview(importedReceipt.idempotencyKey)).toEqual(
          importedReceipt,
        );
      };
      if (mode === "gate") {
        await proveGateSpan();
        markStage("gate-case-complete");
        return;
      }
      if (mode === "deletion-attached") {
        const importedPreview = await previewRunDeletion(importedState, request.runId);
        expect(importedPreview.unresolved).toBeGreaterThan(0);
        const importedDeletion = await applyRunDeletion(
          importedState,
          request.runId,
          importedPreview.confirmation,
        );
        expect(importedDeletion).toMatchObject({ complete: false, removed: 0 });
        expect(importedDeletion.nextAction).toContain("Review receipt");
        expect(
          await new DurableArtifactStore(resolve(destinationRoot, "artifacts")).has(
            retained.intentObjectSha256,
          ),
        ).toBe(true);
        expect(await new FileRunStore(importedState).get(request.runId)).toBeDefined();
        expect(await importedStore.loadReview(importedReceipt.idempotencyKey)).toEqual(
          importedReceipt,
        );
        const lateRootName = resolve(fixture.root, "late-imported-custody");
        await mkdir(lateRootName);
        const lateRoot = await realpath(lateRootName);
        const lateState = resolve(lateRoot, "runs");
        await cp(importedState, lateState, { recursive: true });
        await cp(resolve(destinationRoot, "artifacts"), resolve(lateRoot, "artifacts"), {
          recursive: true,
        });
        const beforeImportPreview = await previewRunDeletion(lateState, request.runId);
        expect(beforeImportPreview.unresolved).toBe(0);
        const lateStore = new FileScmDeliveryReceiptStore(resolve(lateRoot, "receipts"));
        await lateStore.claimReviewImport(importedReceipt, () => undefined);
        await expect(
          applyRunDeletion(lateState, request.runId, beforeImportPreview.confirmation),
        ).rejects.toMatchObject({ code: "confirmation-changed" });
        expect(await lateStore.loadReview(importedReceipt.idempotencyKey)).toEqual(importedReceipt);
        expect(await new FileRunStore(lateState).get(request.runId)).toBeDefined();
        expect(
          await new DurableArtifactStore(resolve(lateRoot, "artifacts")).has(
            retained.intentObjectSha256,
          ),
        ).toBe(true);
        const finalGateRootName = resolve(fixture.root, "final-gate-imported-custody");
        await mkdir(finalGateRootName);
        const finalGateRoot = await realpath(finalGateRootName);
        const finalGateState = resolve(finalGateRoot, "runs");
        await cp(importedState, finalGateState, { recursive: true });
        await cp(resolve(destinationRoot, "artifacts"), resolve(finalGateRoot, "artifacts"), {
          recursive: true,
        });
        const finalGatePreview = await previewRunDeletion(finalGateState, request.runId);
        expect(finalGatePreview.unresolved).toBe(0);
        const finalGateStore = new FileScmDeliveryReceiptStore(resolve(finalGateRoot, "receipts"));
        const finalGateDeletion = await applyRunDeletion(
          finalGateState,
          request.runId,
          finalGatePreview.confirmation,
          {
            beforeFinalReceiptGate: () =>
              finalGateStore
                .claimReviewImport(importedReceipt, () => undefined)
                .then(() => undefined),
          },
        );
        expect(finalGateDeletion).toMatchObject({ complete: false, removed: 0 });
        expect(finalGateDeletion.nextAction).toContain("Review receipt");
        expect(await finalGateStore.loadReview(importedReceipt.idempotencyKey)).toEqual(
          importedReceipt,
        );
        expect(await new FileRunStore(finalGateState).get(request.runId)).toBeDefined();
        expect(
          await new DurableArtifactStore(resolve(finalGateRoot, "artifacts")).has(
            retained.intentObjectSha256,
          ),
        ).toBe(true);
        // A real legacy delivery worktree can be cleaned before the final review
        // receipt gate. Importing at that boundary must retain the saved review
        // and report the already completed Git work honestly.
        await fixtureGit(fixture.repository, [
          "remote",
          "add",
          "origin",
          "https://gitlab.example.test/team/docs-project.git",
        ]);
        const patchWriter = resolve(fixture.root, "review-legacy-patch-writer");
        await fixtureGit(fixture.repository, ["worktree", "add", "--detach", patchWriter, head]);
        await writeFile(resolve(patchWriter, "README.md"), "# Reviewed head plus legacy patch\n");
        await fixtureGit(patchWriter, ["add", "README.md"]);
        const legacyPatch = `${await fixtureGit(patchWriter, ["diff", "--cached", "--binary", "--full-index", "--find-renames", "--find-copies", "--find-copies-harder", "--"])}\n`;
        await fixtureGit(fixture.repository, ["worktree", "remove", "--force", patchWriter]);
        const mixedRootName = resolve(fixture.root, "mixed-git-review-custody");
        await mkdir(mixedRootName);
        const mixedRoot = await realpath(mixedRootName);
        const mixedState = resolve(mixedRoot, "runs");
        await cp(importedState, mixedState, { recursive: true });
        await cp(resolve(destinationRoot, "artifacts"), resolve(mixedRoot, "artifacts"), {
          recursive: true,
        });
        const mixedPatchRoot = resolve(mixedRoot, "patches");
        await mkdir(mixedPatchRoot, { mode: 0o700 });
        const mixedPatchPath = resolve(mixedPatchRoot, `${request.runId}.patch`);
        await writeFile(mixedPatchPath, legacyPatch, { mode: 0o600 });
        const mixedRecordSha256 = (await new FileRunStore(mixedState).getWithDigest(request.runId))
          .sha256;
        const patchSha256 = sha256(legacyPatch);
        const legacyPlanBody = {
          schemaVersion: 2,
          kind: "docsfab-local-user-gitlab-publication-plan",
          deliveryMode: "local-user",
          authorityBasis: "interactive-once",
          run: { id: request.runId, recordSha256: mixedRecordSha256 },
          project: { id: 4242, host, path: "team/docs-project" },
          remote: { name: "origin", transport: "https" },
          identity: {
            git: "configured",
            gitIdentitySha256: localUserGitIdentitySha256(
              FIXTURE_GIT_IDENTITY.name,
              FIXTURE_GIT_IDENTITY.email,
            ),
            gitlabUsername: "maintainer",
          },
          baseRevision: head,
          targetBranch: { name: "main", protected: true },
          proposedSourceBranch: deterministicLocalUserSourceBranch(
            request.runId,
            head,
            mixedRecordSha256,
            patchSha256,
          ),
          patch: {
            format: "git-diff",
            sha256: patchSha256,
            byteLength: Buffer.byteLength(legacyPatch),
            changedFileCount: 1,
          },
          validationCommand: "node validate.cjs",
          mergeRequest: { draft: true },
          fallback: { mode: "patch-only", preserved: true },
          checks: {
            repository: "passed",
            remote: "passed",
            revision: "current",
            gitIdentity: "configured",
            gitlabAuthentication: "authenticated",
            pushAccess: "allowed",
            sourceBranch: "unprotected",
          },
        } as const satisfies Omit<LocalUserPublicationPlanV2, "sha256">;
        const legacyPlan: LocalUserPublicationPlanV2 = {
          ...legacyPlanBody,
          sha256: localUserPublicationPlanSha256(legacyPlanBody),
        };
        const legacyAuthorization = authorizeLocalUserPublication({
          plan: legacyPlan,
          confirmedPlanSha256: legacyPlan.sha256,
          command: "publish",
        });
        const legacyReceipt = createScmDeliveryRecord({
          plan: legacyPlan,
          authorization: legacyAuthorization,
          createdAt: "2026-10-18T00:00:00.000Z",
        });
        const legacyReceiptRoot = resolve(mixedRoot, "legacy-receipts");
        const legacyStore = new FileScmDeliveryReceiptStore(legacyReceiptRoot);
        await legacyStore.claim(legacyReceipt, legacyPlan);
        await legacyStore.compareAndSwap(
          legacyReceipt.sha256,
          failScmDeliveryRecord(
            legacyReceipt,
            { code: "prepare-failed", at: "2026-10-18T00:00:01.000Z" },
            legacyPlan,
          ),
        );
        const mixedDeliveryRoot = resolve(mixedRoot, "legacy-delivery");
        const mixedAttempt = resolve(mixedDeliveryRoot, "attempts", "zz-legacy-review");
        const mixedCapsule = resolve(mixedAttempt, deliveryCapsuleName(legacyPlan));
        const mixedWorktree = resolve(mixedCapsule, "repository");
        await mkdir(mixedCapsule, { recursive: true, mode: 0o700 });
        await writeFile(resolve(mixedCapsule, "verified.patch"), legacyPatch, { mode: 0o600 });
        await fixtureGit(fixture.repository, ["worktree", "add", "--detach", mixedWorktree, head]);
        await fixtureGit(mixedWorktree, [
          "apply",
          "--index",
          resolve(mixedCapsule, "verified.patch"),
        ]);
        await recordRunDeliveryAttemptLocation({
          schemaVersion: 1,
          kind: "docsfab-run-delivery-attempt-location",
          stateDirectory: mixedState,
          runId: request.runId,
          recordSha256: mixedRecordSha256,
          deliveryRoot: mixedDeliveryRoot,
          attemptPath: mixedAttempt,
          planSha256: legacyPlan.sha256,
        });
        const mixedRoots = {
          deliveryRoots: [mixedDeliveryRoot],
          receiptRoots: [legacyReceiptRoot],
        };
        const mixedPreview = await previewRunDeletion(mixedState, request.runId, mixedRoots);
        expect(mixedPreview.unresolved).toBe(0);
        expect(mixedPreview.worktrees).toBe(1);
        const mixedReviewStore = new FileScmDeliveryReceiptStore(resolve(mixedRoot, "receipts"));
        const mixedDeletion = await applyRunDeletion(
          mixedState,
          request.runId,
          mixedPreview.confirmation,
          {
            async beforeFinalReceiptGate() {
              expect(
                await fixtureGit(fixture.repository, ["worktree", "list", "--porcelain"]),
              ).not.toContain(mixedWorktree);
              await mixedReviewStore.claimReviewImport(importedReceipt, () => undefined);
            },
          },
          mixedRoots,
        );
        expect(mixedDeletion.complete).toBe(false);
        expect(mixedDeletion.removed).toBeGreaterThan(0);
        expect(mixedDeletion.nextAction).toContain("Review receipt");
        expect(await mixedReviewStore.loadReview(importedReceipt.idempotencyKey)).toEqual(
          importedReceipt,
        );
        expect(await new FileRunStore(mixedState).get(request.runId)).toBeDefined();
        expect(
          await new DurableArtifactStore(resolve(mixedRoot, "artifacts")).has(
            retained.intentObjectSha256,
          ),
        ).toBe(true);
        markStage("attached-deletion-complete");
        return;
      }
      if (mode === "deletion-resume") {
        const orphanRootName = resolve(fixture.root, "orphan-imported-custody");
        await mkdir(orphanRootName);
        const orphanRoot = await realpath(orphanRootName);
        const orphanState = resolve(orphanRoot, "runs");
        await new FileRunStore(orphanState).save(before);
        await cp(resolve(destinationRoot, "artifacts"), resolve(orphanRoot, "artifacts"), {
          recursive: true,
        });
        const orphanStore = new FileScmDeliveryReceiptStore(resolve(orphanRoot, "receipts"));
        await orphanStore.claimReviewImport(importedReceipt, () => undefined);
        const orphanPreview = await previewRunDeletion(orphanState, request.runId);
        expect(orphanPreview.unresolved).toBeGreaterThan(0);
        const orphanDeletion = await applyRunDeletion(
          orphanState,
          request.runId,
          orphanPreview.confirmation,
        );
        expect(orphanDeletion).toMatchObject({ complete: false, removed: 0 });
        expect(await new FileRunStore(orphanState).get(request.runId)).toBeDefined();
        expect(
          await new DurableArtifactStore(resolve(orphanRoot, "artifacts")).has(
            retained.intentObjectSha256,
          ),
        ).toBe(true);
        for (const attached of [true, false]) {
          const resumeRootName = resolve(
            fixture.root,
            attached ? "attached-resume-custody" : "orphan-resume-custody",
          );
          await mkdir(resumeRootName);
          const resumeRoot = await realpath(resumeRootName);
          const resumeState = resolve(resumeRoot, "runs");
          await new FileRunStore(resumeState).save(attached ? after : before);
          await cp(resolve(destinationRoot, "artifacts"), resolve(resumeRoot, "artifacts"), {
            recursive: true,
          });
          const reportDirectory = resolve(resumeState, "reports", request.runId);
          await mkdir(reportDirectory, { recursive: true, mode: 0o700 });
          const marker = resolve(reportDirectory, "interrupted.txt");
          await writeFile(marker, "interrupt before retained objects are removed\n", {
            mode: 0o600,
          });
          const resumePreview = await previewRunDeletion(resumeState, request.runId);
          expect(resumePreview.unresolved).toBe(0);
          const interrupted = await applyRunDeletion(
            resumeState,
            request.runId,
            resumePreview.confirmation,
            {
              afterRemove(path) {
                if (path === marker) throw new Error("injected interruption before object cleanup");
              },
            },
          );
          expect(interrupted).toMatchObject({ complete: false });
          expect(interrupted.removed).toBeGreaterThan(0);
          const resumeStore = new FileScmDeliveryReceiptStore(resolve(resumeRoot, "receipts"));
          await resumeStore.claimReviewImport(importedReceipt, () => undefined);
          const resumed = await applyRunDeletion(
            resumeState,
            request.runId,
            resumePreview.confirmation,
          );
          expect(resumed).toMatchObject({ complete: false });
          expect(resumed.removed).toBeGreaterThan(0);
          expect(resumed.nextAction).toContain("Review receipt");
          expect(await resumeStore.loadReview(importedReceipt.idempotencyKey)).toEqual(
            importedReceipt,
          );
          expect(await new FileRunStore(resumeState).get(request.runId)).toBeDefined();
          expect(
            await new DurableArtifactStore(resolve(resumeRoot, "artifacts")).has(
              retained.intentObjectSha256,
            ),
          ).toBe(true);
        }
        for (const missingEvidence of ["intent", "run"] as const) {
          const missingRootName = resolve(fixture.root, `${missingEvidence}-removed-before-resume`);
          await mkdir(missingRootName);
          const missingRoot = await realpath(missingRootName);
          const missingState = resolve(missingRoot, "runs");
          await cp(importedState, missingState, { recursive: true });
          await cp(resolve(destinationRoot, "artifacts"), resolve(missingRoot, "artifacts"), {
            recursive: true,
          });
          const missingArtifactRoot = resolve(missingRoot, "artifacts");
          const missingObjectDirectory = resolve(missingArtifactRoot, "objects", "sha256");
          const sourceRoot = decodeSourceSnapshotRoot(
            await new DurableArtifactStore(missingArtifactRoot).getRecord(
              retainedSource.rootObjectSha256,
              { readOnly: true },
            ),
          );
          const sourcePartDigest = sourceRoot.partDigests[0]!;
          const sourcePartPath = resolve(missingObjectDirectory, `${sourcePartDigest}.json`);
          const intentPath = resolve(missingObjectDirectory, `${retained.intentObjectSha256}.json`);
          const interruptionMarker = resolve(
            missingState,
            "reports",
            request.runId,
            "interrupt.txt",
          );
          if (missingEvidence === "intent") {
            await mkdir(resolve(missingState, "reports", request.runId), {
              recursive: true,
              mode: 0o700,
            });
            await writeFile(interruptionMarker, "interrupt before object cleanup\n", {
              mode: 0o600,
            });
          }
          const missingPreview = await previewRunDeletion(missingState, request.runId);
          expect(missingPreview.unresolved).toBe(0);
          const first = await applyRunDeletion(
            missingState,
            request.runId,
            missingPreview.confirmation,
            {
              async afterRemove(path) {
                if (missingEvidence === "intent" && path === interruptionMarker) {
                  for (const [digest, objectPath] of [
                    [sourcePartDigest, sourcePartPath],
                    [retained.intentObjectSha256, intentPath],
                  ] as const) {
                    await markArtifactObjectForDeletion(missingArtifactRoot, digest);
                    await unlink(objectPath);
                  }
                  throw new Error("injected intent evidence loss");
                }
                if (missingEvidence === "run" && path.endsWith(`${request.runId}.json`)) {
                  throw new Error("injected run evidence loss");
                }
              },
            },
          );
          expect(first).toMatchObject({ complete: false });
          expect(first.nextAction).toContain(`injected ${missingEvidence} evidence loss`);
          if (missingEvidence === "intent") {
            expect(await readdir(missingObjectDirectory)).not.toContain(`${sourcePartDigest}.json`);
            expect(await readdir(missingObjectDirectory)).not.toContain(
              `${retained.intentObjectSha256}.json`,
            );
            expect(await readdir(missingObjectDirectory)).toContain(
              `${retainedSource.rootObjectSha256}.json`,
            );
            expect(await new FileRunStore(missingState).get(request.runId)).toBeDefined();
          }
          const missingStore = new FileScmDeliveryReceiptStore(resolve(missingRoot, "receipts"));
          await missingStore.claimReviewImport(importedReceipt, () => undefined);
          const resumed = await applyRunDeletion(
            missingState,
            request.runId,
            missingPreview.confirmation,
          );
          expect(resumed.complete).toBe(false);
          expect(resumed.removed).toBeGreaterThan(0);
          expect(resumed.nextAction).toContain("Review receipt");
          expect(await missingStore.loadReview(importedReceipt.idempotencyKey)).toEqual(
            importedReceipt,
          );
          if (missingEvidence === "intent") {
            expect(await new FileRunStore(missingState).get(request.runId)).toBeDefined();
          }
        }
        const cleanOrphanRootName = resolve(fixture.root, "orphan-no-journal-custody");
        await mkdir(cleanOrphanRootName);
        const cleanOrphanRoot = await realpath(cleanOrphanRootName);
        const cleanOrphanState = resolve(cleanOrphanRoot, "runs");
        await new FileRunStore(cleanOrphanState).save(before);
        await cp(resolve(destinationRoot, "artifacts"), resolve(cleanOrphanRoot, "artifacts"), {
          recursive: true,
        });
        const cleanOrphanPreview = await previewRunDeletion(cleanOrphanState, request.runId);
        expect(cleanOrphanPreview.unresolved).toBe(0);
        expect(
          (await applyRunDeletion(cleanOrphanState, request.runId, cleanOrphanPreview.confirmation))
            .complete,
        ).toBe(true);
        expect(
          await new DurableArtifactStore(resolve(cleanOrphanRoot, "artifacts")).has(
            retained.intentObjectSha256,
          ),
        ).toBe(false);
        markStage("resume-deletion-complete");
        return;
      }
      const malformedRoot = resolve(fixture.root, "malformed-review-receipts");
      await mkdir(malformedRoot, { mode: 0o700 });
      const malformedJournal = resolve(malformedRoot, importedReceipt.idempotencyKey);
      await cp(
        resolve(destinationRoot, "receipts", importedReceipt.idempotencyKey),
        malformedJournal,
        {
          recursive: true,
        },
      );
      const firstSlot = resolve(malformedJournal, "000000.json");
      const firstEnvelope = JSON.parse(await readFile(firstSlot, "utf8"));
      await writeFile(
        firstSlot,
        JSON.stringify({ ...firstEnvelope, kind: "unsupported-slot" }, null, 2) + "\n",
      );
      await expect(
        new FileScmDeliveryReceiptStore(malformedRoot).loadEither(importedReceipt.idempotencyKey),
      ).rejects.toMatchObject({ code: "receipt-invalid" });
      const mixedChainRoot = resolve(fixture.root, "mixed-review-receipts");
      await mkdir(mixedChainRoot, { mode: 0o700 });
      const mixedJournal = resolve(mixedChainRoot, importedReceipt.idempotencyKey);
      await cp(
        resolve(fixture.stateDirectory, "..", "receipts", importedReceipt.idempotencyKey),
        mixedJournal,
        {
          recursive: true,
        },
      );
      const secondSlot = resolve(mixedJournal, "000001.json");
      const secondEnvelope = JSON.parse(await readFile(secondSlot, "utf8"));
      await writeFile(
        secondSlot,
        JSON.stringify({ ...secondEnvelope, kind: "docsfab-scm-delivery-receipt-slot" }, null, 2) +
          "\n",
      );
      await expect(
        new FileScmDeliveryReceiptStore(mixedChainRoot).loadEither(importedReceipt.idempotencyKey),
      ).rejects.toMatchObject({ code: "receipt-invalid" });
      const intermediateRoot = resolve(fixture.root, "wrong-intermediate-record-kind");
      await mkdir(intermediateRoot, { mode: 0o700 });
      const intermediateJournal = resolve(intermediateRoot, importedReceipt.idempotencyKey);
      await cp(
        resolve(fixture.stateDirectory, "..", "receipts", importedReceipt.idempotencyKey),
        intermediateJournal,
        { recursive: true },
      );
      const intermediateSlot = resolve(intermediateJournal, "000001.json");
      const authenticIntermediate = JSON.parse(await readFile(intermediateSlot, "utf8"));
      const { sha256: _authenticSlotDigest, ...authenticSlotBody } = authenticIntermediate;
      const terminalSlot = {
        ...authenticSlotBody,
        sequence: 2,
        previousRecordSha256: authenticIntermediate.record.sha256,
      };
      const terminalPath = resolve(intermediateJournal, "000002.json");
      await writeFile(
        terminalPath,
        `${JSON.stringify(
          {
            ...terminalSlot,
            sha256: sha256(canonicalizeJsonEvidence(terminalSlot as JsonEvidenceValue)),
          },
          null,
          2,
        )}\n`,
        { mode: 0o600 },
      );
      const intermediateStore = new FileScmDeliveryReceiptStore(intermediateRoot);
      expect(await intermediateStore.loadEither(importedReceipt.idempotencyKey)).toMatchObject({
        kind: "review",
      });
      const { sha256: _authenticRecordDigest, ...recordBody } = authenticIntermediate.record;
      const wrongRecordBody = { ...recordBody, kind: "docsfab-scm-delivery-record" };
      const wrongRecord = {
        ...wrongRecordBody,
        sha256: sha256(canonicalizeJsonEvidence(wrongRecordBody as JsonEvidenceValue)),
      };
      const wrongIntermediateBody = { ...authenticSlotBody, record: wrongRecord };
      await writeFile(
        intermediateSlot,
        `${JSON.stringify(
          {
            ...wrongIntermediateBody,
            sha256: sha256(canonicalizeJsonEvidence(wrongIntermediateBody as JsonEvidenceValue)),
          },
          null,
          2,
        )}\n`,
      );
      const repairedTerminalBody = {
        ...terminalSlot,
        previousRecordSha256: wrongRecord.sha256,
      };
      await writeFile(
        terminalPath,
        `${JSON.stringify(
          {
            ...repairedTerminalBody,
            sha256: sha256(canonicalizeJsonEvidence(repairedTerminalBody as JsonEvidenceValue)),
          },
          null,
          2,
        )}\n`,
      );
      await expect(
        intermediateStore.loadEither(importedReceipt.idempotencyKey),
      ).rejects.toMatchObject({ code: "receipt-invalid" });
    },
    testTimeoutMs(limit("test.ciTimeoutMs").value),
  );

  it("admits only immutable choice and binding fields, including the absent action default", () => {
    expect(decodeReviewInspectionIntent(intent())).toEqual(intent());
    expect(() =>
      decodeReviewInspectionIntent({ ...intent(), requestedActions: "overview" }),
    ).not.toThrow();
  });

  it.each([
    ["unknown body field", { ...intent(), originalResult: { findings: [] } }],
    ["wrong schema", { ...intent(), schemaVersion: 2 }],
    ["wrong digest", { ...intent(), sourceSha256: "bad" }],
    [
      "duplicate choice",
      { ...intent(), selections: [intent().selections[0], intent().selections[0]] },
    ],
    [
      "unsorted actions",
      {
        ...intent(),
        actions: [
          { actionId: "b".repeat(64), kind: "publish-inline", actionSha256: HASH },
          { actionId: HASH, kind: "publish-summary", actionSha256: HASH },
        ],
      },
    ],
  ])("refuses %s", (_name, value) => {
    expect(() => decodeReviewInspectionIntent(value)).toThrow(
      "Saved review inspection unavailable",
    );
  });
});
