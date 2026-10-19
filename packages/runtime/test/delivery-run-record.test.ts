// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { sourceObligationObserverFixture, verificationFixture } from "./helpers/verification.js";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createObservableWorkspaceWithoutRequiredChecks } from "./helpers/observable-workspace.js";

import type {
  AgentHarness,
  HostOperationExecutor,
  RunRequest,
} from "../src/execution/contracts.js";
import { limit, limitDefinition } from "../src/config/limits.js";
import { READER_SOURCE_NOMINATIONS_LIMIT } from "../src/execution/reader-task-admission.js";
import type { ChangeEvidence, ImpactPostflightResult } from "../src/impact/contracts.js";
import type {
  ModelEvidence,
  ModelProfileEvidence,
  RunRecord,
  StepRunRecord,
} from "../src/records/contracts.js";
import type { ArtifactReference } from "../src/artifacts/index.js";
import { buildContentIndex } from "../src/content-ir/index.js";
import { loadVerifiedPublicationRun } from "../src/delivery/preflight.js";
import {
  LiveWorkflowDelivery,
  LIVE_DELIVERY_FAILURES,
} from "../src/live-agent/workflow-delivery.js";
import { DocumentationScope } from "../src/live-agent/documentation-scope.js";
import { planLiveFirstPassChoice } from "../src/live-agent/first-pass-choice.js";
import { persistFirstPassContradictionStop } from "../src/cli/run/first-pass-contradiction-stop.js";
import { loadFirstPassChoiceContinuation } from "../src/cli/run/first-pass-choice-continuation.js";
import { createFirstPassChoice } from "../src/records/first-pass-choice.js";
import { FirstPassChoiceClaimStore } from "../src/records/first-pass-choice-store.js";
import { FileRunStore } from "../src/records/file-store.js";
import { recordedIntent } from "./helpers/first-pass-intent.js";
import { validModelConfig } from "./helpers.js";
import {
  decodeSuccessfulPublicationRunRecord as decodePublicationRunRecordStrict,
  decodeSuccessfulPublicationRunRecordSnapshot,
  PublicationRunRecordDecodeError,
  type PublicationRunRecordDecodeOptionsV1,
} from "../src/delivery/run-record.js";
import { LocalImpactPostflightService } from "../src/impact/postflight.js";
import { GitPatchEvidenceCollector } from "../src/repository/evidence.js";
import { prepareRepositoryWorkspace } from "../src/repository/workspace/materialize.js";
import { createHistoricalUnknownTaskLineage, projectTaskLineage } from "../src/lineage/index.js";
import { modelProfileEvidenceSha256 } from "../src/model/profile-evidence.js";
import {
  createAuthoringCandidate,
  selectAuthoringRevision,
  type AuthoringCandidateV1,
} from "../src/workflow-execution/authoring-candidate.js";
import {
  createAuthoringExecutionEvidenceV1,
  createAuthoringPhaseEvidenceV1,
  createAuthoringRevisionAdmissionBindingV1,
  authoringPhaseInvocationBindingV1,
  type AuthoringProducerSummaryBindingV1,
} from "../src/records/authoring-execution.js";
import type { AuthoringRevisionAccountingV1 } from "../src/workflow-execution/authoring-revision.js";
import { authoringSelectedPath } from "../src/workflow-contracts/authoring-schedule.js";
import { canonicalDigest, sha256 } from "../src/content-ir/canonical.js";
import {
  createKnowledgeContinuationReceipt,
  knowledgeContinuationAcceptanceSha256,
  type KnowledgeContinuationReceiptV1,
} from "../src/records/knowledge-continuation.js";
import type { TaskLineageRecoveryAuthorizationV1 } from "../src/lineage/contracts.js";
import {
  decodeContextPreflight,
  decodeInference,
  decodeSkillEvidence,
} from "../src/scorecard-record.js";
import { governProviderTurn } from "../src/model/turn-governor.js";
import { WorkflowRunner } from "../src/workflow-execution/runner.js";
import {
  WorkflowChecksHostOperation,
  type CheckCommandAuthority,
} from "../src/workflow-execution/workflow-checks.js";
import { recordingAuthority } from "./helpers/recording-check-authority.js";
import { LocalAuthoringCandidateLifecycle } from "../src/workflow-execution/authoring-runtime.js";
import { LocalSourceObligationSourceObserver } from "../src/workflow-execution/source-obligation-observer.js";
import {
  documentationPlanBindingDigest,
  type DocumentationPlanMode,
} from "../src/workflow-execution/plan-binding.js";
import {
  createDocumentationGapLedger,
  documentationGapLedgerFromStepFindings,
  negativeDocumentationEvidence,
  projectDocumentationSearchFindings,
} from "../src/search/index.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import { parseWorkflowManifestSnapshot } from "../src/workflow-registry/manifest.js";
import { documentationAuditSearch } from "../src/maturity/audit-search-plan.js";
import { documentationObservationSearch } from "../src/search/observation-search-plan.js";
import { DECLARATIVE_WORKFLOW_NAMES } from "../src/workflow-registry/manifest.js";
import { LocalWorkflowSearchCoordinator } from "../src/search/local-workflow-coordinator.js";
import { normalizeWorkflowSearchEvidence } from "../src/workflow-contracts/search.js";
import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../src/json-evidence.js";
import { scriptedEditorialProtocol } from "./helpers/editorial-protocol.js";
import { createReleaseFixture, runReleaseRecord } from "./support/release-run.js";
import { authoringManifestV3 } from "./helpers/authoring-manifest.js";
import { AuthoringQualityWorkflowOutcomeProjector } from "../src/evaluation-report/authoring-outcome-projector.js";
import { createWorkflowOutcome } from "../src/workflow-contracts/outcome.js";
import {
  createRealAuthoringEvidenceFixture,
  type RealAuthoringEvidenceFixture,
} from "./helpers/authoring-evidence.js";
import { initFixtureRepo } from "./helpers/git.js";
import {
  recordVerifierDisagreement,
  type VerifierDisagreementV1,
} from "../src/records/verifier-disagreement.js";
import type { VerificationResult } from "../src/workflow-execution/review-response.js";

const REVISION = "a".repeat(64);
const PAGE_PATH = "docs/guide.mdx";
const NAVIGATION_PATH = "fern/versions/nightly.yml";
const productionDecodeOptions = new Map<string, PublicationRunRecordDecodeOptionsV1>();
/** Runner-backed records and continuation fixtures need headroom on loaded hosts. */
const DELIVERY_RUN_RECORD_SUITE_TIMEOUT_MS = 180_000;

function decodeSuccessfulPublicationRunRecord(value: unknown): RunRecord {
  const id =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as { id?: unknown }).id
      : undefined;
  return decodePublicationRunRecordStrict(
    value,
    typeof id === "string" ? productionDecodeOptions.get(id) : undefined,
  );
}

describe("publication RunRecord decoder", { timeout: DELIVERY_RUN_RECORD_SUITE_TIMEOUT_MS }, () => {
  it("accepts legacy skill evidence without a governed payload", () => {
    const evidence = { id: "doc-audit", contentSha256: "a".repeat(64) };
    expect(decodeSkillEvidence(evidence)).toEqual(evidence);
  });

  it.each(["update-documentation", "bootstrap"] as const)(
    "accepts an actual WorkflowRunner %s record",
    async (workflow) => {
      const record = await productionRecord(
        workflow,
        workflow === "update-documentation" ? { polishTask: "bounded" } : {},
      );

      expect(record.status, JSON.stringify(record.error)).toBe("succeeded");
      expect(decodeSuccessfulPublicationRunRecord(record)).toEqual(record);
      for (const step of record.steps) {
        if (step.kind === "host-operation") {
          expect(step.inference).toBeUndefined();
          continue;
        }
        expect(step.inference?.replay).toBe(
          step.mode === "write" ? "disabled-write-step" : "read-only",
        );
      }
    },
  );

  it("admits an actual update whose required check could not run, with its recorded limitation (#1918)", async () => {
    const authority = recordingAuthority({ status: "passed", exitCode: 0, output: "OK\n" });
    const record = await productionRecord("update-documentation", {
      polishTask: "bounded",
      seedFiles: {
        "AGENTS.md": "Run `ruff format .` before proposing a documentation change.\n",
      },
      requiredCheckAuthority: authority,
    });

    expect(record.status, JSON.stringify(record.error)).toBe("succeeded");
    // The unsupported form never reached the executor.
    expect(authority.calls).toEqual([]);
    expect(record.evidenceWarnings).toEqual([
      "required check could not run: `ruff format .` (unsupported check form). Next action: run this command from the repository root, as `AGENTS.md` requires, before you merge this change.",
    ]);
    // The publication gate admits the delivered record, limitation and all.
    expect(decodeSuccessfulPublicationRunRecord(record)).toEqual(record);
  });

  it("rejects forged model-tool activity on a documentation host step", async () => {
    const record = await productionRecord("update-documentation", { polishTask: "bounded" });
    const host = record.steps.find((step) => step.kind === "host-operation");
    expect(host).toBeDefined();
    host!.tools = { totalCalls: 1, failedCalls: 0, byTool: [] };
    expect(() => decodeSuccessfulPublicationRunRecord(record)).toThrow();

    const presented = await productionRecord("update-documentation", { polishTask: "bounded" });
    const presentedHost = presented.steps.find((step) => step.kind === "host-operation");
    expect(presentedHost).toBeDefined();
    presentedHost!.tools = {
      totalCalls: 0,
      failedCalls: 0,
      byTool: [],
      presented: ["bash"],
    };
    expect(() => decodeSuccessfulPublicationRunRecord(presented)).toThrow();
  });

  it("accepts an actual WorkflowRunner site-bootstrap record", async () => {
    const record = await productionRecord("site-bootstrap");

    expect(decodeSuccessfulPublicationRunRecord(record)).toEqual(record);
  });

  // Coverage gap: the delivery decoder's `presented` exclusion
  // (canonicalTools in src/delivery/run-record.ts) is reachable only when a
  // step's `failureCategories` is non-empty, and this file's harness fixture
  // cannot produce that state: it emits no tool failures and takes no option
  // to. Hand-building such a record means satisfying the whole scorecard
  // ledger web (execution-lease executed counts, turn toolCalls,
  // governance-stop accounting), and a partial one fails for reasons
  // unrelated to the exclusion. The equivalent scorecard-side seam is covered
  // in scorecard-record.test.ts ("decodes a whole run record whose step and
  // attempt tools carry presented"), and both decoders apply the same
  // exclusion.
  // TODO: teach the harness fixture to emit a tool failure, then cover this
  // seam here.

  it("accepts a create-documentation record with canon task and instruction", async () => {
    const record = await productionRecord("create-documentation");

    expect(record.status, JSON.stringify(record.error)).toBe("succeeded");
    expect(record.workflow).toBe("create-documentation");
    expect(record.task).toEqual({
      kind: "create-documentation",
      canonSha256: "e".repeat(64),
    });
    expect(record.instruction).toBe("Create a documentation page for this feature");
    expect(decodeSuccessfulPublicationRunRecord(record)).toEqual(record);
  });

  it("applies a privately admitted choice patch locally while publication stays blocked", async () => {
    const root = await mkdtemp(join(tmpdir(), "docsfab-choice-checkout-"));
    const stateDirectory = join(root, "runs");
    await mkdir(stateDirectory, { mode: 0o700 });
    const store = new FileRunStore(stateDirectory);
    const instruction = "Create docs/port.md with the listening port for operators.";
    const projectRoot = fileURLToPath(new URL("../", import.meta.url));
    const config = {
      projectRoot,
      skillCrateDirectory: join(projectRoot, "skill-crate"),
      qualityDirectory: join(projectRoot, "quality"),
      qualityPackDirectory: join(projectRoot, "quality-pack"),
      stateDirectory,
      retryPolicy: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0, retryableCategories: [] },
      model: validModelConfig,
    };
    let parent: RunRecord;
    let parentSha256: string;
    let claimPath: string;
    let exactOption: string;
    try {
      await productionRecord("create-documentation", {
        planPagePath: "docs/port.md",
        artifactDirectory: stateDirectory,
        instruction,
        runStore: store,
        seedFiles: {
          "deploy.yaml": "port: 9090\n",
          "src/server.ts": "export const port = 8088;\n",
        },
        beforeRun: async (fixture) => {
          const request = {
            workflow: "create-documentation" as const,
            repositoryPath: fixture.repository.sourcePath,
            revision: fixture.repository.revision,
            instruction,
            allowWrite: true,
            releaseGate: false,
            patchOnly: true,
            verbose: false,
            json: false,
            showScan: false,
            requestIntent: recordedIntent(instruction, {
              operation: "create",
              targets: [{ path: "docs/port.md", quote: "docs/port.md" }],
            }),
          };
          parent = await persistFirstPassContradictionStop({
            request,
            config,
            workspace: fixture.workspace,
            contradictions: [
              {
                obligationId: "listening-port",
                targetPaths: ["docs/port.md"],
                condition: "The listening port is documented.",
                sides: [
                  { path: "deploy.yaml", lineStart: 1, lineEnd: 1, value: null },
                  { path: "src/server.ts", lineStart: 1, lineEnd: 1, value: null },
                ],
              },
            ],
          });
          parentSha256 = (await store.getWithDigest(parent.id)).sha256;
          exactOption = parent.firstPassContradiction!.question.options.find((option) =>
            option.includes("src/server.ts"),
          )!;
          const planned = await planLiveFirstPassChoice({
            stateDirectory,
            repositoryPath: fixture.repository.sourcePath,
            pendingRunId: parent.id,
            replyText: exactOption,
          });
          if (planned.kind !== "choice") throw new Error("Fixture source option did not bind.");
          const choice = createFirstPassChoice({
            ...planned.plan.choices[0]!,
            successorRunId: "run-create-documentation",
          });
          await new FirstPassChoiceClaimStore(stateDirectory).claim({
            choice,
            childExists: async () => false,
          });
          claimPath = join(root, "first-pass-choice-claims", `${sha256(parent.id)}.0.json`);
          await loadFirstPassChoiceContinuation({
            request: { ...request, runId: choice.successorRunId, firstPassChoices: [choice] },
            config,
          });
          return { firstPassChoices: [choice], requestIntent: request.requestIntent };
        },
        inspectRun: async (record, fixture) => {
          expect(record.status, JSON.stringify(record.error)).toBe("succeeded");
          expect(record.firstPassChoices).toHaveLength(1);
          const ordinary = structuredClone(record);
          delete ordinary.firstPassChoices;
          expect(() => decodeSuccessfulPublicationRunRecord(ordinary)).not.toThrow();
          expect(() => decodeSuccessfulPublicationRunRecord(record)).toThrow(
            PublicationRunRecordDecodeError,
          );
          const confirmPublication = vi.fn(async () => true);
          const ship = vi.fn(async () => {
            throw new Error("This control must not invoke publication.");
          });
          const beforeMutation = vi.fn(async () => undefined);
          const delivery = new LiveWorkflowDelivery({
            repositoryPath: fixture.repository.sourcePath,
            stateDirectory,
            allowWrite: true,
            documentationScope: new DocumentationScope(["docs"]),
            confirmPublication,
            ship,
            beforeMutation,
          });
          const page = join(fixture.repository.sourcePath, "docs/port.md");
          const originalClaim = await readFile(claimPath, "utf8");
          const expectNoMutation = async () => {
            expect(beforeMutation).not.toHaveBeenCalled();
            await expect(readFile(page)).rejects.toMatchObject({ code: "ENOENT" });
            expect((await store.getWithDigest(parent.id)).sha256).toBe(parentSha256);
          };
          await rename(claimPath, `${claimPath}.retained`);
          try {
            expect(await delivery.persist(record)).toMatchObject({ status: "failed" });
            await expectNoMutation();
          } finally {
            await rename(`${claimPath}.retained`, claimPath);
          }
          const wrongOwner = JSON.parse(originalClaim);
          wrongOwner.ownerBirthIdentity = sha256("another process birth");
          await writeFile(claimPath, JSON.stringify(wrongOwner));
          try {
            expect(await delivery.persist(record)).toMatchObject({ status: "failed" });
            await expectNoMutation();
          } finally {
            await writeFile(claimPath, originalClaim);
          }
          const wrongJournal = JSON.parse(originalClaim);
          wrongJournal.choice = createFirstPassChoice({
            ...wrongJournal.choice,
            successorRunId: "another-child",
          });
          await writeFile(claimPath, JSON.stringify(wrongJournal));
          try {
            expect(await delivery.persist(record)).toMatchObject({ status: "failed" });
            await expectNoMutation();
          } finally {
            await writeFile(claimPath, originalClaim);
          }
          const parentPath = join(stateDirectory, `${parent.id}.json`);
          const parentBytes = await readFile(parentPath, "utf8");
          await writeFile(parentPath, `${parentBytes}\n`);
          try {
            expect(await delivery.persist(record)).toMatchObject({ status: "failed" });
            expect(beforeMutation).not.toHaveBeenCalled();
            await expect(readFile(page)).rejects.toMatchObject({ code: "ENOENT" });
          } finally {
            await writeFile(parentPath, parentBytes);
          }
          const foreignRepository = join(root, "foreign");
          await initFixtureRepo(foreignRepository, { "README.md": "Foreign sentinel.\n" });
          const foreignDelivery = new LiveWorkflowDelivery({
            repositoryPath: foreignRepository,
            stateDirectory,
            allowWrite: true,
            beforeMutation,
            confirmPublication,
            ship,
          });
          expect(await foreignDelivery.persist(record)).toMatchObject({ status: "failed" });
          await expectNoMutation();
          expect(await readFile(join(foreignRepository, "README.md"), "utf8")).toBe(
            "Foreign sentinel.\n",
          );
          const controller = new AbortController();
          controller.abort();
          expect(await delivery.persist(record, controller.signal)).toEqual({
            status: "failed",
            error: "Workflow cancelled by user.",
          });
          await expectNoMutation();
          expect(await delivery.persist({ ...record, firstPassChoices: [] })).toEqual({
            status: "failed",
            error: LIVE_DELIVERY_FAILURES.retention,
          });
          await expectNoMutation();
          expect(await delivery.persist(record)).toEqual({ status: "applied" });
          expect(beforeMutation).toHaveBeenCalledTimes(1);
          expect(await readFile(page, "utf8")).toContain("Completed governed documentation work");
          expect((await store.getWithDigest(parent.id)).sha256).toBe(parentSha256);
          expect((await store.get(record.id)).firstPassChoices).toEqual(record.firstPassChoices);
          expect(await readFile(claimPath, "utf8")).not.toContain(exactOption);
          await expect(
            delivery
              .publicationTool()
              .execute(
                "publication-refused",
                { runId: record.id },
                undefined,
                undefined,
                {} as never,
              ),
          ).rejects.toThrow();
          expect(confirmPublication).not.toHaveBeenCalled();
          expect(ship).not.toHaveBeenCalled();
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects authoring phase metadata without its sealed execution envelope", async () => {
    const record = await productionRecord("create-documentation");
    record.steps[0]!.authoringPhase = {} as NonNullable<
      (typeof record.steps)[number]["authoringPhase"]
    >;
    expect(() => decodeSuccessfulPublicationRunRecord(record)).toThrow(
      PublicationRunRecordDecodeError,
    );

    const orphanAccounting = await productionRecord("create-documentation");
    (orphanAccounting.steps[0] as unknown as Record<string, unknown>).authoringRevisionAccounting =
      {};
    expect(() => decodeSuccessfulPublicationRunRecord(orphanAccounting)).toThrow(
      PublicationRunRecordDecodeError,
    );
  });

  it.each([
    ["retain", 9, 0],
    ["revise", 14, 1],
  ] as const)(
    "accepts a sealed CREATE V3 %s delivery path",
    async (branchId, count, selectedOrdinal) => {
      const record = await sealedAuthoringDeliveryRecord(branchId);

      expect(record.steps).toHaveLength(count);
      expect(decodeV3DeliveryRecord(record).authoringExecution?.selectedCandidate).toEqual({
        ordinal: selectedOrdinal,
        digest: decodeV3DeliveryCandidateDigest(record, selectedOrdinal),
        artifactName: selectedOrdinal === 0 ? "candidate-0.patch" : "candidate-1.patch",
      });
    },
  );

  it("rejects cold revision accounting changes against the retained host delta", async () => {
    const record = await sealedAuthoringDeliveryRecord("revise", {
      additionalWritePaths: ["docs/reference.md"],
      revisionChangedPaths: ["docs/guide.md"],
    });

    expect(record.authoringExecution?.writePaths).toEqual(["docs/guide.md", "docs/reference.md"]);
    expect(record.authoringExecution?.revisionAdmission?.changedPaths).toEqual(["docs/guide.md"]);
    expect(() => decodeV3DeliveryRecord(record)).not.toThrow();

    const changedPath = structuredClone(record);
    Object.assign(
      changedPath.steps.find((step) => step.id === "revise-documentation")!
        .authoringRevisionAccounting!,
      { changedPaths: ["docs/reference.md"] },
    );
    expect(() => decodeV3DeliveryRecord(changedPath)).toThrow(PublicationRunRecordDecodeError);

    const changedDisposition = structuredClone(record);
    const changedRow = changedDisposition.steps.find((step) => step.id === "revise-documentation")!
      .authoringRevisionAccounting!.issueAccounting[0]!;
    Object.assign(changedRow, {
      disposition: "rejected",
      reason: "The admitted source now supports a different valid disposition.",
    });
    expect(() => decodeV3DeliveryRecord(changedDisposition)).toThrow(
      PublicationRunRecordDecodeError,
    );
  });

  it("rejects forged selected candidate and final patch bindings in a sealed V3 record", async () => {
    const record = await sealedAuthoringDeliveryRecord("revise");

    const forgedSelection = structuredClone(record);
    (
      forgedSelection.authoringExecution!.selectedCandidate as unknown as Record<string, unknown>
    ).digest = "9".repeat(64);
    expect(() => decodeV3DeliveryRecord(forgedSelection)).toThrow(PublicationRunRecordDecodeError);

    const forgedPatch = structuredClone(record);
    forgedPatch.changes!.patch!.sha256 = "8".repeat(64);
    expect(() => decodeV3DeliveryRecord(forgedPatch)).toThrow(PublicationRunRecordDecodeError);
  });

  it("rejects missing correction evidence and self-consistent wrong final targets on replay", async () => {
    const record = await productionRecord("create-documentation");
    const final = record.steps.find((step) => step.id === "verify-technical-accuracy")!;

    const missingCorrection = structuredClone(record);
    delete missingCorrection.steps.find((step) => step.id === final.id)!
      .technicalCorrectionEvidence;
    expect(() => decodeSuccessfulPublicationRunRecord(missingCorrection)).toThrow(
      PublicationRunRecordDecodeError,
    );

    const wrongTarget = structuredClone(record);
    const wrongFinal = wrongTarget.steps.find((step) => step.id === final.id)!;
    const verification = JSON.parse(wrongFinal.summary!) as {
      coverage: Array<{ path: string }>;
    };
    verification.coverage[0]!.path = "docs/unrelated.md";
    wrongFinal.summary = canonicalizeJsonEvidence(
      verification as unknown as JsonEvidenceValue,
    ).trimEnd();
    const evidence = wrongFinal.technicalCorrectionEvidence!;
    evidence.verificationResultSha256 = canonicalDigest(verification);
    const { digest: _digest, ...evidenceContent } = evidence;
    evidence.digest = canonicalDigest(evidenceContent);
    expect(() => decodeSuccessfulPublicationRunRecord(wrongTarget)).toThrow(
      PublicationRunRecordDecodeError,
    );
  });

  it("admits verifier disagreement only beside a canonical step's correction evidence (#1439)", async () => {
    const record = await productionRecord("create-documentation");
    const field = verifierDisagreementBetween(
      record,
      "provisional-technical-verification",
      "verify-technical-accuracy",
    );
    expect(field.status).toBe("compared");

    // Positive control: the field on the canonical step decodes with the record.
    const admitted = structuredClone(record);
    admitted.steps.find((step) => step.id === "verify-technical-accuracy")!.verifierDisagreement =
      field;
    expect(decodeSuccessfulPublicationRunRecord(admitted)).toEqual(admitted);

    // The same field on the provisional step it names is refused.
    const onProvisional = structuredClone(record);
    onProvisional.steps.find(
      (step) => step.id === "provisional-technical-verification",
    )!.verifierDisagreement = field;
    expectPublicationRefusal(onProvisional, "invalid-shape");

    // On the canonical step, but naming another step's provisional pass.
    const wrongPair = structuredClone(record);
    wrongPair.steps.find((step) => step.id === "verify-technical-accuracy")!.verifierDisagreement =
      { ...field, provisionalStepId: "provisional-revised-technical-verification" };
    expectPublicationRefusal(wrongPair, "invalid-shape");

    // On the canonical step, but outside the closed shape.
    const malformed = structuredClone(record);
    malformed.steps.find((step) => step.id === "verify-technical-accuracy")!.verifierDisagreement =
      { ...field, status: "agreed" } as never;
    expectPublicationRefusal(malformed, "invalid-shape");
  });

  it("refuses verifier disagreement on a canonical step that carries no correction evidence (#1439)", async () => {
    // update-documentation takes its inventory before the write: its canonical
    // step has no provisional pass and no correction evidence.
    const record = await productionRecord("update-documentation");
    const canonical = record.steps.find((step) => step.id === "verify-technical-accuracy")!;
    expect(canonical.technicalCorrectionEvidence).toBeUndefined();
    expect(decodeSuccessfulPublicationRunRecord(record)).toEqual(record);
    const withField = structuredClone(record);
    withField.steps.find((step) => step.id === canonical.id)!.verifierDisagreement =
      recordVerifierDisagreement({
        provisionalStepId: "provisional-technical-verification",
        provisional: undefined,
        canonical: JSON.parse(canonical.summary!) as VerificationResult,
      });
    expectPublicationRefusal(withField, "invalid-shape");
  });

  it("admits verifier disagreement on the sealed CREATE V3 revised canonical step (#1439)", async () => {
    const record = await sealedAuthoringDeliveryRecord("revise");
    const field = verifierDisagreementBetween(
      record,
      "provisional-revised-technical-verification",
      "verify-revised-technical-accuracy",
    );
    const admitted = structuredClone(record);
    admitted.steps.find(
      (step) => step.id === "verify-revised-technical-accuracy",
    )!.verifierDisagreement = field;
    expect(() => decodeV3DeliveryRecord(admitted)).not.toThrow();

    // The revised canonical step pairs with the revised provisional pass only.
    const firstPair = structuredClone(record);
    firstPair.steps.find(
      (step) => step.id === "verify-revised-technical-accuracy",
    )!.verifierDisagreement = { ...field, provisionalStepId: "provisional-technical-verification" };
    let refusal: unknown;
    try {
      decodeV3DeliveryRecord(firstPair);
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(PublicationRunRecordDecodeError);
    expect((refusal as PublicationRunRecordDecodeError).code).toBe("invalid-shape");
  });

  it("rejects missing, misplaced, or tampered retained V2 source authority on replay", async () => {
    const record = await productionRecord("create-documentation");
    const derive = record.steps.find((step) => step.id === "derive-source-obligations")!;
    expect(derive.originalSourceAuthority).toBeDefined();

    const missing = structuredClone(record);
    delete missing.steps.find((step) => step.id === derive.id)!.originalSourceAuthority;
    expect(() => decodeSuccessfulPublicationRunRecord(missing)).toThrow(
      PublicationRunRecordDecodeError,
    );

    const misplaced = structuredClone(record);
    const moved = misplaced.steps.find((step) => step.id === derive.id)!.originalSourceAuthority;
    delete misplaced.steps.find((step) => step.id === derive.id)!.originalSourceAuthority;
    misplaced.steps.find((step) => step.id === "plan-documentation")!.originalSourceAuthority =
      moved;
    expect(() => decodeSuccessfulPublicationRunRecord(misplaced)).toThrow(
      PublicationRunRecordDecodeError,
    );

    const tampered = structuredClone(record);
    (
      tampered.steps.find((step) => step.id === derive.id)!.originalSourceAuthority!
        .descriptor as unknown as { scopeSha256: string }
    ).scopeSha256 = "9".repeat(64);
    expect(() => decodeSuccessfulPublicationRunRecord(tampered)).toThrow(
      PublicationRunRecordDecodeError,
    );
  });

  it("applies the full successful-record contract to a supplied historical workflow snapshot", async () => {
    const record = await productionRecord("create-documentation");
    const snapshot = {
      workflow: getWorkflow("create-documentation"),
      workflowIdentity: {
        id: "create-documentation",
        sourceSha256: "f".repeat(64),
      },
    } as const;
    expect(decodeSuccessfulPublicationRunRecordSnapshot(record, snapshot)).toEqual(record);

    const invalidSecurity = structuredClone(record) as unknown as Record<string, unknown>;
    invalidSecurity.securityScanEffectiveDisposition = "forged";
    expect(() => decodeSuccessfulPublicationRunRecordSnapshot(invalidSecurity, snapshot)).toThrow(
      PublicationRunRecordDecodeError,
    );

    const invalidChanges = structuredClone(record);
    Object.assign(invalidChanges.changes!.files[0]!, { status: "forged" });
    expect(() => decodeSuccessfulPublicationRunRecordSnapshot(invalidChanges, snapshot)).toThrow(
      PublicationRunRecordDecodeError,
    );
  });

  it("accepts an update-documentation record with canon task and instruction", async () => {
    const record = await productionRecord("update-documentation");

    expect(record.status, JSON.stringify(record.error)).toBe("succeeded");
    expect(record.workflow).toBe("update-documentation");
    expect(record.task).toEqual({
      kind: "update-documentation",
      canonSha256: "e".repeat(64),
    });
    expect(decodeSuccessfulPublicationRunRecord(record)).toEqual(record);
  });

  it.each(["update-documentation", "restructure-documentation"] as const)(
    "rejects unauthentic inventory-only source evidence (%s)",
    async (workflow) => {
      const record = await productionRecord(workflow);
      const derive = record.steps.find((step) => step.id === "derive-source-obligations")!;
      expect(derive.originalSourceAuthority).toBeDefined();

      const resealLedger = (
        target: RunRecord,
        mutate: (ledger: {
          identity: {
            repositoryRevision: string;
            sourceEvidenceSha256: string;
            workspaceSnapshotSha256: string;
            scopeSha256: string;
          };
          digest: string;
        }) => void,
      ) => {
        const targetDerive = target.steps.find((step) => step.id === derive.id)!;
        const ledger = JSON.parse(targetDerive.summary!) as Parameters<typeof mutate>[0];
        mutate(ledger);
        const { digest: _digest, ...content } = ledger;
        ledger.digest = canonicalDigest(content);
        targetDerive.summary = canonicalizeJsonEvidence(
          ledger as unknown as JsonEvidenceValue,
        ).trimEnd();
      };

      const mutations: Array<[string, (target: RunRecord) => void]> = [
        [
          "missing ledger",
          (target) => {
            delete target.steps.find((step) => step.id === derive.id)!.summary;
          },
        ],
        [
          "missing authority",
          (target) => {
            delete target.steps.find((step) => step.id === derive.id)!.originalSourceAuthority;
          },
        ],
        [
          "duplicate authority",
          (target) => {
            target.steps.find(
              (step) => step.id === "write-documentation",
            )!.originalSourceAuthority = structuredClone(derive.originalSourceAuthority);
          },
        ],
        [
          "missing derive plan",
          (target) => {
            delete target.steps.find((step) => step.id === derive.id)!.planBinding;
          },
        ],
        [
          "forged derive plan",
          (target) => {
            target.steps.find((step) => step.id === derive.id)!.planBinding =
              documentationPlanBinding(
                workflow === "update-documentation" ? "update" : "restructure",
                "other.md",
              );
          },
        ],
        [
          "stale revision identity",
          (target) => {
            resealLedger(target, (ledger) => {
              ledger.identity.repositoryRevision = "b".repeat(record.repository.revision.length);
            });
          },
        ],
        [
          "stale search identity",
          (target) => {
            resealLedger(target, (ledger) => {
              ledger.identity.sourceEvidenceSha256 = "b".repeat(64);
            });
          },
        ],
        [
          "stale snapshot identity",
          (target) => {
            resealLedger(target, (ledger) => {
              ledger.identity.workspaceSnapshotSha256 = "b".repeat(64);
            });
          },
        ],
        [
          "stale scope identity",
          (target) => {
            resealLedger(target, (ledger) => {
              ledger.identity.scopeSha256 = "b".repeat(64);
            });
          },
        ],
        [
          "tampered authority scope",
          (target) => {
            (
              target.steps.find((step) => step.id === derive.id)!.originalSourceAuthority!
                .descriptor as unknown as { scopeSha256: string }
            ).scopeSha256 = "b".repeat(64);
          },
        ],
      ];

      for (const [name, mutate] of mutations) {
        expect(
          decodeSuccessfulPublicationRunRecord(record),
          `${workflow}: ${name} baseline`,
        ).toEqual(record);
        const mutated = structuredClone(record);
        mutate(mutated);
        expect(() => decodeSuccessfulPublicationRunRecord(mutated), `${workflow}: ${name}`).toThrow(
          PublicationRunRecordDecodeError,
        );
      }
    },
  );

  it("accepts a restructure-documentation record with instruction and no task", async () => {
    const record = await productionRecord("restructure-documentation");

    expect(record.status, JSON.stringify(record.error)).toBe("succeeded");
    expect(record.task).toBeUndefined();
    expect(record.instruction).toBeTruthy();
    expect(decodeSuccessfulPublicationRunRecord(record)).toEqual(record);
  });

  it("accepts instruction-only polish without a bounded-doc task", async () => {
    const record = await productionRecord("update-documentation", { polishTask: "none" });

    expect(record.status, JSON.stringify(record.error)).toBe("succeeded");
    expect(record.task).toBeUndefined();
    expect(record.instruction).toBeTruthy();
    expect(decodeSuccessfulPublicationRunRecord(record)).toEqual(record);
  });

  it("accepts runner records for every declarative write workflow", async () => {
    const writeWorkflows = DECLARATIVE_WORKFLOW_NAMES.filter(
      (
        name,
      ): name is
        | "bootstrap"
        | "create-documentation"
        | "update-documentation"
        | "restructure-documentation"
        | "foundation-to-patch"
        | "site-bootstrap" => getWorkflow(name).steps.some((step) => step.mode === "write"),
    );
    // Exact declarative write-workflow inventory. bootstrap joins it because
    // its single step is mode "write"; the publication decoder must therefore
    // accept a real bootstrap runner record, not just the authoring three.
    // `foundation-to-patch` joins it as a declarative manifest whose one
    // host-operation step is mode "write", and `site-bootstrap` joins it the
    // same way as a declarative manifest.
    expect(writeWorkflows).toEqual([
      "bootstrap",
      "create-documentation",
      "update-documentation",
      "restructure-documentation",
      "foundation-to-patch",
      "site-bootstrap",
    ]);
    for (const workflow of writeWorkflows) {
      const record = await productionRecord(workflow);
      expect(record.status, `${workflow}: ${JSON.stringify(record.error)}`).toBe("succeeded");
      expect(decodeSuccessfulPublicationRunRecord(record)).toEqual(record);
    }
  });

  it("accepts first-pass hydrate files omitted from documentation impact", async () => {
    const { record, snapshot } = await historicalCreatePublicationFixture();
    if (!record.changes) throw new Error("fixture is missing change evidence");
    record.changes.files = [
      ...record.changes.files,
      { path: ".docsfab.json", status: "added" },
      {
        path: ".docsfab/reference-model/knowledge-accepted-snapshot.json",
        status: "added",
      },
    ];
    expect(decodeSuccessfulPublicationRunRecordSnapshot(record, snapshot)).toEqual(record);
  });

  it("accepts no-change impact when the write is first-pass hydrate only", async () => {
    const { record, snapshot } = await historicalCreatePublicationFixture();
    if (!record.changes) throw new Error("fixture is missing change evidence");
    record.changes.files = [
      { path: ".docsfab.json", status: "added" },
      {
        path: ".docsfab/reference-model/knowledge-accepted-snapshot.json",
        status: "added",
      },
    ];
    record.impactPostflight = { schemaVersion: 1, status: "no-change" };
    expect(decodeSuccessfulPublicationRunRecordSnapshot(record, snapshot)).toEqual(record);
  });

  it("rejects out-of-plan hydrate paths added after current V3 candidate admission", async () => {
    const record = await productionRecord("create-documentation");
    if (!record.changes) throw new Error("fixture is missing change evidence");
    record.changes.files.push({ path: ".docsfab.json", status: "added" });

    expect(() => decodeSuccessfulPublicationRunRecord(record)).toThrow(
      PublicationRunRecordDecodeError,
    );
  });

  it("accepts repository gitlab target snapshot fields sealed at run start", async () => {
    const record = await productionRecord("create-documentation");
    record.repository = {
      ...record.repository,
      gitlabTargetBranch: "main",
      gitlabTargetRevision: record.repository.revision,
    };
    expect(decodeSuccessfulPublicationRunRecord(record)).toEqual(record);
  });

  it("preserves the runner task-validation code when the persisted task is illegal", async () => {
    const record = await productionRecord("update-documentation", { polishTask: "none" });
    expect(() =>
      decodeSuccessfulPublicationRunRecord({
        ...record,
        task: { kind: "create-documentation", canonSha256: "e".repeat(64) },
      }),
    ).toThrow(
      expect.objectContaining({
        name: "PublicationRunRecordDecodeError",
        code: "unexpected-task",
      }),
    );
  });

  it("accepts mutually bound search projections on an actual polish publication record", async () => {
    const root = await mkdtemp(join(tmpdir(), "docsfab-publication-search-"));
    try {
      await mkdir(join(root, "src"), { recursive: true });
      await writeFile(
        join(root, "src/api.ts"),
        Array.from({ length: 48 }, (_, index) => `export const fixture${index} = ${index};`).join(
          "\n",
        ) + "\n",
      );
      await writeFile(join(root, "README.md"), "Before governed authoring for README.md.\n");
      const record = await productionRecord("update-documentation", { polishTask: "bounded" });
      const deriveStep = record.steps.find((step) => step.id === "derive-source-obligations")!;
      const workflow = getWorkflow("update-documentation");
      const stepDefinition = workflow.steps[0]!;
      const result = await new LocalWorkflowSearchCoordinator({
        workspaceSnapshotSha256: deriveStep.searchEvidence!.workspaceSnapshotSha256,
      }).search({
        runId: record.id,
        repositoryPath: root,
        repository: record.repository,
        workflow,
        step: stepDefinition,
        plan: stepDefinition.search!,
      });
      const searchEvidence = normalizeWorkflowSearchEvidence({
        plan: stepDefinition.search!,
        repository: record.repository,
        repositoryIdentitySha256: result.repositoryIdentitySha256,
        searches: result.searches,
        workspaceSnapshotSha256: result.workspaceSnapshotSha256,
      });
      const searchFindings = projectDocumentationSearchFindings({
        workflow: "update-documentation",
        stepId: stepDefinition.id,
        evidence: searchEvidence,
      });
      const negativeEvidence = negativeDocumentationEvidence(searchFindings);
      const gapLedger = createDocumentationGapLedger({
        currentRevision: record.repository.revision,
        findings: searchFindings,
      });
      Object.assign(record.steps[0]!, {
        searchEvidence,
        searchFindings,
        negativeEvidence,
        gapLedger,
      });
      const rebuilt = documentationGapLedgerFromStepFindings({
        currentRevision: record.repository.revision,
        steps: record.steps,
      });
      expect(rebuilt).toBeDefined();
      Object.assign(record, rebuilt);
      const decodeOptions = productionDecodeOptions.get(record.id)!;
      record.workflowOutcome = createWorkflowOutcome(
        await new AuthoringQualityWorkflowOutcomeProjector().project(record, decodeOptions),
        record,
        decodeOptions,
      );

      expect(decodeSuccessfulPublicationRunRecord(record)).toEqual(record);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a successful write record when planner and writer bindings diverge", async () => {
    const record = await productionRecord("update-documentation", { polishTask: "bounded" });
    const planner = record.steps.find((step) => step.skill === "plan-documentation")!;
    const writer = record.steps.find((step) => step.skill === "write-documentation")!;
    expect(planner.planBinding).toBeDefined();
    expect(writer.planBinding).toBeDefined();

    writer.planBinding = documentationPlanBinding("update", "docs/other.md");
    expect(() => decodeSuccessfulPublicationRunRecord(record)).toThrow(
      PublicationRunRecordDecodeError,
    );
  });

  it("round-trips a runner receipt and rejects persisted plan-target disagreement", async () => {
    const receipt = knowledgeResumeReceipt();
    const record = await productionRecord("create-documentation", {
      planPagePath: receipt.selectedTargetPath,
    });
    record.knowledgeResumeReceipt = receipt;

    expect(decodeSuccessfulPublicationRunRecord(record)).toEqual(record);

    const mismatched = structuredClone(record);
    const mismatchedPlanner = mismatched.steps.find((step) => step.skill === "plan-documentation")!;
    const mismatchedWriter = mismatched.steps.find((step) => step.skill === "write-documentation")!;
    mismatchedPlanner.planBinding = documentationPlanBinding("create", "docs/about/product.md");
    mismatchedWriter.planBinding = mismatchedPlanner.planBinding;
    expect(() => decodeSuccessfulPublicationRunRecord(mismatched)).toThrow(
      PublicationRunRecordDecodeError,
    );
  });

  it("round-trips a successful knowledge continuation publication record", async () => {
    const record = await knowledgeContinuationPublicationRecord();
    expect(decodeSuccessfulPublicationRunRecord(record)).toEqual(record);

    const withTargetConflict = await knowledgeContinuationPublicationRecord(true);
    expect(decodeSuccessfulPublicationRunRecord(withTargetConflict)).toEqual(withTargetConflict);
  });

  it.each([
    ["repository identity", { repositoryIdentitySha256: "1".repeat(64) }],
    ["repository revision", { repositoryRevision: "2".repeat(40) }],
    ["workflow", { workflow: "update-documentation" as const }],
    ["instruction digest", { instructionSha256: "3".repeat(64) }],
    ["task-lineage projection", { taskLineageProjectionSha256: "4".repeat(64) }],
  ] as const)("rejects continuation receipt %s substitution after resealing", async (_, patch) => {
    const record = await knowledgeContinuationPublicationRecord();
    record.knowledgeContinuationReceipt = resealContinuationReceipt(
      record.knowledgeContinuationReceipt!,
      patch,
    );
    refreshContinuationAcceptance(record);

    expect(() => decodeSuccessfulPublicationRunRecord(record)).toThrow(
      PublicationRunRecordDecodeError,
    );
  });

  it.each([
    ["the original origin", { originalOriginSha256: "5".repeat(64) }],
    ["the original lineage", { originalLineageSha256: "6".repeat(64) }],
  ] as const)("rejects continuation recovery authorization %s substitution", async (_, patch) => {
    const record = await knowledgeContinuationPublicationRecord();
    record.knowledgeContinuationRecoveryAuthorization = resealRecoveryAuthorization(
      record.knowledgeContinuationRecoveryAuthorization!,
      patch,
    );
    refreshContinuationAcceptance(record);

    expect(() => decodeSuccessfulPublicationRunRecord(record)).toThrow(
      PublicationRunRecordDecodeError,
    );
  });

  it("binds the recovery authorization digest and accepted snapshot to the continuation seal", async () => {
    const authorizationMutation = await knowledgeContinuationPublicationRecord();
    authorizationMutation.knowledgeContinuationRecoveryAuthorization = resealRecoveryAuthorization(
      authorizationMutation.knowledgeContinuationRecoveryAuthorization!,
      { authorityReceiptSha256: "7".repeat(64) },
    );
    expect(() => decodeSuccessfulPublicationRunRecord(authorizationMutation)).toThrow(
      PublicationRunRecordDecodeError,
    );

    const snapshotMutation = await knowledgeContinuationPublicationRecord();
    snapshotMutation.knowledgeContinuationSnapshotSha256 = "8".repeat(64);
    expect(() => decodeSuccessfulPublicationRunRecord(snapshotMutation)).toThrow(
      PublicationRunRecordDecodeError,
    );
  });

  it("rejects a substituted optional target-conflict receipt", async () => {
    const record = await knowledgeContinuationPublicationRecord(true);
    const receipt = structuredClone(record.knowledgeResumeReceipt!);
    receipt.advisoryConflicts[0]!.resolutionOwner = "different-owner";
    record.knowledgeResumeReceipt = receipt;

    expect(() => decodeSuccessfulPublicationRunRecord(record)).toThrow(
      PublicationRunRecordDecodeError,
    );
  });

  describe("persisted knowledge receipt rejection fixture", () => {
    let baseline: RunRecord | undefined;

    beforeAll(async () => {
      const record = await productionRecord("create-documentation");
      const receipt = knowledgeResumeReceipt();
      record.knowledgeResumeReceipt = receipt;
      const planner = record.steps.find((step) => step.skill === "plan-documentation")!;
      const writer = record.steps.find((step) => step.skill === "write-documentation")!;
      planner.planBinding = documentationPlanBinding("create", receipt.selectedTargetPath);
      writer.planBinding = planner.planBinding;
      baseline = record;
    });

    it("rejects malformed, unsafe, and credential-bearing persisted receipts", () => {
      if (!baseline) throw new Error("Missing persisted knowledge receipt rejection fixture.");
      const record = structuredClone(baseline);
      const receipt = knowledgeResumeReceipt();
      for (const invalid of [
        { ...receipt, selectedTargetPath: "../docs/escape.md" },
        { ...receipt, extra: true },
        {
          ...receipt,
          advisoryConflicts: [
            {
              ...receipt.advisoryConflicts[0]!,
              resolutionOwner: "glpat-abcdefghijklmnopqrstuvwxyz0123",
            },
          ],
        },
      ]) {
        expect(() =>
          decodeSuccessfulPublicationRunRecord({ ...record, knowledgeResumeReceipt: invalid }),
        ).toThrow(PublicationRunRecordDecodeError);
      }
    });
  });

  it("round-trips a saved runner record with source seeding and request diagnostics", async () => {
    const savedRecords: RunRecord[] = [];
    const record = await productionRecord("restructure-documentation", {
      preservationObservationReuse: true,
      runtimeDiagnostics: true,
      savedRecords,
    });
    expect(record.status, JSON.stringify(record.error)).toBe("succeeded");
    const saved = savedRecords.at(-1)!;
    expect(saved.status).toBe("succeeded");
    const audience = saved.steps.find((step) => step.id === "test-audience-understanding")!;
    expect(audience.preservationSourceObservationSeed).toMatchObject({
      schemaVersion: 1,
      outcome: "succeeded",
    });
    expect(audience.preservationSourceObservationSeed?.counters.seededRanges).toBeGreaterThan(0);
    expect(audience.inference?.attempts[0]?.efficiency).toMatchObject({
      schemaVersion: 1,
      requests: [{ requestSequence: 1, turn: 1 }],
    });
    expect(audience.inference?.attempts[0]?.providerResponses).toMatchObject({
      schemaVersion: 1,
      state: "complete",
    });
    expect(decodeSuccessfulPublicationRunRecord(saved)).toEqual(saved);

    const extraKey = structuredClone(saved);
    Object.assign(
      extraKey.steps.find((step) => step.id === audience.id)!.preservationSourceObservationSeed!,
      { rawText: "untrusted source text" },
    );
    expect(() => decodeSuccessfulPublicationRunRecord(extraKey)).toThrow(
      PublicationRunRecordDecodeError,
    );
    const extraCounter = structuredClone(saved);
    Object.assign(
      extraCounter.steps.find((step) => step.id === audience.id)!.preservationSourceObservationSeed!
        .counters,
      { rawText: "untrusted source text" },
    );
    expect(() => decodeSuccessfulPublicationRunRecord(extraCounter)).toThrow(
      PublicationRunRecordDecodeError,
    );
    const failedSeed = structuredClone(saved);
    failedSeed.steps.find((step) => step.id === audience.id)!
      .preservationSourceObservationSeed!.outcome = "failed";
    expect(() => decodeSuccessfulPublicationRunRecord(failedSeed)).toThrow(
      PublicationRunRecordDecodeError,
    );
  });

  it("rejects write retry forgery, overlapping steps, and invalid write context", async () => {
    const retry = await productionRecord("bootstrap");
    retry.steps[0]!.inference!.configuredMaxRetries = 1;
    retry.steps[0]!.inference!.effectiveMaxRetries = 1;
    expect(() => decodeSuccessfulPublicationRunRecord(retry)).toThrow();

    const overlap = await productionRecord("update-documentation", { polishTask: "bounded" });
    overlap.steps[1]!.startedAt = overlap.steps[0]!.startedAt;
    overlap.steps[1]!.durationMs =
      Date.parse(overlap.steps[1]!.completedAt!) - Date.parse(overlap.steps[1]!.startedAt!);
    expect(() => decodeSuccessfulPublicationRunRecord(overlap)).toThrow();

    const degradedWrite = await productionRecord("bootstrap");
    degradedWrite.steps[0]!.contextPreflight = {
      status: "degraded",
      reason: "semantic-state-unavailable",
    };
    expect(() => decodeSuccessfulPublicationRunRecord(degradedWrite)).toThrow();

    const missingPatchedImpact = await productionRecord("bootstrap");
    missingPatchedImpact.impactPostflight = {
      schemaVersion: 1,
      status: "completed",
      analysisDigest: "a".repeat(64),
      changedPaths: ["docs/affected-neighbor.md"],
    };
    expect(() => decodeSuccessfulPublicationRunRecord(missingPatchedImpact)).toThrow();
  });

  describe("page plus nightly publication fixture", () => {
    let fixture: Awaited<ReturnType<typeof pagePlusNightlyPublicationFixture>> | undefined;
    let fixturePromise: ReturnType<typeof pagePlusNightlyPublicationFixture> | undefined;

    beforeAll(async () => {
      fixturePromise = pagePlusNightlyPublicationFixture();
      fixture = await fixturePromise;
    });

    afterAll(async () => {
      await fixturePromise?.then(
        ({ root }) => rm(root, { recursive: true, force: true }),
        () => undefined,
      );
    });

    it("accepts a page plus fern/versions/nightly.yml record through publication preflight", async () => {
      if (!fixture) throw new Error("Missing page plus nightly publication fixture.");
      const record = structuredClone(fixture.record);
      expect(record.status, JSON.stringify(record.error)).toBe("succeeded");
      expect(record.impactPostflight).toMatchObject({
        status: "completed",
        changedPaths: [PAGE_PATH, NAVIGATION_PATH],
      });
      expect(decodeSuccessfulPublicationRunRecord(record)).toEqual(record);
      const verified = await loadVerifiedPublicationRun(fixture.recordPath, record.id);
      expect(verified.changedFiles.map((file) => file.path).sort()).toEqual([
        PAGE_PATH,
        NAVIGATION_PATH,
      ]);
    });

    it("carries the run's required-check lines through publication preflight (#1918)", async () => {
      if (!fixture) throw new Error("Missing page plus nightly publication fixture.");
      const line =
        "required check could not run: `ruff format .` (unsupported check form). Next action: run this command from the repository root, as `AGENTS.md` requires, before you merge this change.";
      const limited = structuredClone(fixture.record);
      limited.evidenceWarnings = [...(limited.evidenceWarnings ?? []), line];
      const limitedPath = join(fixture.root, "required-check-limited.json");
      await writeFile(limitedPath, `${JSON.stringify(limited)}\n`, { mode: 0o600 });
      // Only the required-check lines travel to the draft MR's Notes.
      const verified = await loadVerifiedPublicationRun(limitedPath, limited.id);
      expect(verified.requiredCheckLimitations).toEqual([line]);
      // A run whose required checks all ran carries none.
      const ran = await loadVerifiedPublicationRun(fixture.recordPath, fixture.record.id);
      expect(ran).not.toHaveProperty("requiredCheckLimitations");
    });

    it("fails publication preflight with run-record-contract-gap when impact omits patched navigation", async () => {
      if (!fixture) throw new Error("Missing page plus nightly publication fixture.");
      const omitted = structuredClone(fixture.record);
      expect(omitted.impactPostflight?.status).toBe("completed");
      if (omitted.impactPostflight?.status === "completed") {
        omitted.impactPostflight = {
          ...omitted.impactPostflight,
          changedPaths: [PAGE_PATH],
        };
      }
      expect(() => decodeSuccessfulPublicationRunRecord(omitted)).toThrow(
        PublicationRunRecordDecodeError,
      );
      const negativePath = join(fixture.root, "omitted-navigation.json");
      await writeFile(negativePath, `${JSON.stringify(omitted)}\n`, { mode: 0o600 });
      await expect(loadVerifiedPublicationRun(negativePath, omitted.id)).rejects.toMatchObject({
        name: "LocalUserPublicationPreflightError",
        code: "run-record-contract-gap",
      });
    });
  });

  it("converts a CREATE plan onto the one page the revision holds into an UPDATE through the real authoring lifecycle", async () => {
    // Imported here so the reviewed secret-fixture line above keeps its number.
    const { buildRunResultV1, decodeRunResultV1, serializeRunResultV1 } = await import(
      "../src/operator/run-result.js"
    );
    const { formatRunSummary } = await import("../src/operator/run-summary.js");
    const record = await productionRecord("create-documentation", { seedCreateTarget: true });

    expect(record.status, JSON.stringify(record.error)).toBe("succeeded");
    const conversion = {
      reason: "create-target-exists",
      path: "README.md",
      baseSha256: createHash("sha256")
        .update("Before governed authoring for README.md.\n")
        .digest("hex"),
    };
    const planner = record.steps.find((step) => step.id === "plan-documentation");
    expect(planner?.planBinding?.createConvertedToUpdate).toEqual(conversion);
    expect(planner?.planBinding?.pages).toEqual([{ path: "README.md", disposition: "update" }]);
    // The writer received the same converted plan, and the delivered patch
    // modifies the existing page instead of adding one.
    expect(record.steps.find((step) => step.id === "write-documentation")?.planBinding).toEqual(
      planner?.planBinding,
    );
    expect(record.changes?.files).toEqual([
      expect.objectContaining({ path: "README.md", status: "modified" }),
    ]);
    expect(decodeSuccessfulPublicationRunRecord(record)).toEqual(record);

    // Never silent: the quiet summary's PATCH row and the JSON result name it.
    const quiet = formatRunSummary({
      record,
      recordPath: "/tmp/state/run.json",
      exitCode: 0,
      repositoryPath: "/tmp/repository",
      tty: false,
      quiet: true,
    }).join("\n");
    expect(quiet).toContain(
      "README.md  (CREATE converted to UPDATE: README.md existed at the run's revision)",
    );
    const result = buildRunResultV1({
      record,
      recordPath: "/tmp/state/run.json",
      exitCode: 0,
      repositoryPath: "/tmp/repository",
    });
    expect(result.createConvertedToUpdate).toEqual({
      path: "README.md",
      reason: "create-target-exists",
    });
    expect(decodeRunResultV1(JSON.parse(serializeRunResultV1(result)))).toEqual(result);
    expect(() =>
      decodeRunResultV1({
        ...result,
        createConvertedToUpdate: { path: "../README.md", reason: "create-target-exists" },
      }),
    ).toThrow("invalid CREATE conversion");

    // The run index names the conversion by its closed reason on the run row
    // only, and `docsfab why` reads it from there.
    const { decodeRunIndexRow } = await import("../src/records/run-index.js");
    const { diagnoseRunRecord } = await import("../src/diagnosis/record.js");
    const { formatRunDiagnosisLines } = await import("../src/diagnosis/render.js");
    const { recordDiagnosisLocation } = await import("../src/diagnosis/record.js");
    const diagnosis = diagnoseRunRecord(record, "/tmp/state/run.json");
    expect(diagnosis?.planConversion).toBe("create-target-exists");
    expect(
      formatRunDiagnosisLines(diagnosis!, {
        location: recordDiagnosisLocation("/tmp/state/run.json"),
      }),
    ).toContain(
      "Plan: the host converted the CREATE of a page that already existed into an UPDATE of that page, reason create-target-exists; docsfab runs show names the page.",
    );
    const { projectRunIndexRows } = await import("../src/records/run-index.js");
    const projection = projectRunIndexRows(record, {
      origin: "run-store",
      snapshotId: "snapshot-conversion",
      indexedAt: record.completedAt!,
      recordSha256: "a".repeat(64),
      fieldMaxChars: 4096,
    });
    if (!projection.ok) throw new Error("The converted record did not project.");
    const rows = projection.rows.map((row) => decodeRunIndexRow(JSON.parse(JSON.stringify(row))));
    expect(rows.filter((row) => row?.planConversion !== null).map((row) => row?.rowKind)).toEqual([
      "run",
    ]);
    expect(rows[0]).toMatchObject({ rowKind: "run", planConversion: "create-target-exists" });
    // A stored step row cannot claim a run's conversion.
    const stepRow = rows.find((row) => row?.rowKind === "step" || row?.rowKind === "attempt")!;
    expect(decodeRunIndexRow({ ...stepRow, planConversion: "create-target-exists" })).toMatchObject(
      { planConversion: null },
    );
  });

  it("still refuses a CREATE target the revision holds in a form no UPDATE can start from", async () => {
    // A case variant: the exact path is not the tracked page, so it cannot be its base.
    const record = await productionRecord("create-documentation", {
      seedFiles: { "readme.md": "Lowercase page.\n" },
    });

    expect(record.status).toBe("failed");
    const planner = record.steps.find((step) => step.id === "plan-documentation");
    expect(planner?.failure).toEqual({
      class: "planning-refusal",
      layer: "workflow",
      code: "create-target-exists",
    });
    expect(planner?.error).toContain("(README.md exists under another letter case");
    expect(record.steps.find((step) => step.id === "write-documentation")?.status).toBe("pending");
    expect(record.authoringExecution?.candidates ?? []).toEqual([]);
  });

  it("asks which page a CREATE plan means when several pages it targets already exist", async () => {
    // Imported here so the reviewed secret-fixture line above keeps its number.
    const { buildRunResultV1, decodeRunResultV1, serializeRunResultV1 } = await import(
      "../src/operator/run-result.js"
    );
    const { formatRunSummary } = await import("../src/operator/run-summary.js");
    const record = await productionRecord("create-documentation", {
      seedCreateTarget: true,
      changes: {
        files: [
          { path: "README.md", status: "modified" },
          { path: "docs/guide.md", status: "modified" },
        ],
      },
    });

    expect(record.status).toBe("needs-input");
    expect(record.failure).toBeUndefined();
    const planner = record.steps.find((step) => step.id === "plan-documentation");
    expect(planner?.status).toBe("needs-input");
    expect(planner?.planBinding).toBeUndefined();
    expect(planner?.planDiagnostic).toEqual({
      schemaVersion: 1,
      kind: "docsfab-documentation-plan-diagnostic",
      code: "ambiguous-create-targets",
      responseSha256: PLAN_RESPONSE_SHA256,
      responseShape: "json-object",
    });
    expect(planner?.summary).toContain("(README.md, docs/guide.md)");
    // The question reaches the quiet summary, in NEXT.
    const quiet = formatRunSummary({
      record,
      recordPath: "/tmp/state/run.json",
      exitCode: 0,
      repositoryPath: "/tmp/repository",
      tty: false,
      quiet: true,
    }).join("\n");
    expect(quiet).toContain("Question: ambiguous-create-targets: the CREATE plan targets 2 pages");
    expect(
      buildRunResultV1({
        record,
        recordPath: "/tmp/state/run.json",
        exitCode: 0,
        repositoryPath: "/tmp/repository",
      }).createConvertedToUpdate,
    ).toBeUndefined();
    expect(record.steps.find((step) => step.id === "write-documentation")?.status).toBe("pending");
    expect(record.authoringExecution?.candidates ?? []).toEqual([]);
    // The stopped record is a valid saved record, not a half-written one.
    // Imported here so the reviewed secret-fixture line above keeps its number.
    const { decodeSavedRunRecord } = await import("../src/cli/commands/runs.js");
    const saved = JSON.parse(JSON.stringify(record)) as Parameters<typeof decodeSavedRunRecord>[0];
    expect(decodeSavedRunRecord(saved, record.id)).toMatchObject({
      id: record.id,
      status: "needs-input",
    });
  });

  it("carries an update's retained comparison and nominations through the publication gate", async () => {
    const record = await productionRecord("update-documentation");
    const readerEvidenceRequest = {
      comparisonRequest: {
        kind: "base-head" as const,
        baseRevision: "1".repeat(40),
        headRevision: "2".repeat(40),
      },
      readerSources: [{ role: "public-contract" as const, path: "src/orbit.ts" }],
    };
    const decoded = decodeSuccessfulPublicationRunRecord({ ...record, readerEvidenceRequest });
    // Carried through, not dropped after the key check.
    expect(decoded.readerEvidenceRequest).toEqual(readerEvidenceRequest);
    for (const malformed of [
      {},
      { readerSources: [] },
      { comparisonRequest: { kind: "workspace", snapshot: "x" } },
      {
        comparisonRequest: {
          kind: "base-head",
          baseRevision: "HEAD",
          headRevision: "2".repeat(40),
        },
      },
      { readerSources: [{ role: "public-contract", path: "/etc/passwd" }] },
      {
        readerSources: [
          { role: "public-contract", path: "src/orbit.ts" },
          { role: "public-contract", path: "src/orbit.ts" },
        ],
      },
    ]) {
      expect(() =>
        decodeSuccessfulPublicationRunRecord({ ...record, readerEvidenceRequest: malformed }),
      ).toThrow(PublicationRunRecordDecodeError);
    }
  });

  it("admits retained nominations at the reader-source bound and refuses one past it", async () => {
    const record = await productionRecord("update-documentation");
    // The decoder reads the catalog value; with no override it is what admission enforces.
    expect(limitDefinition(READER_SOURCE_NOMINATIONS_LIMIT).override).toBeNull();
    const bound = limit(READER_SOURCE_NOMINATIONS_LIMIT).value;
    const nominations = (count: number) => ({
      readerSources: Array.from({ length: count }, (_, index) => ({
        role: "current-documentation" as const,
        path: `docs/page-${String(index)}.md`,
      })),
    });
    const atBound = nominations(bound);
    expect(
      decodeSuccessfulPublicationRunRecord({ ...record, readerEvidenceRequest: atBound })
        .readerEvidenceRequest,
    ).toEqual(atBound);
    expect(() =>
      decodeSuccessfulPublicationRunRecord({
        ...record,
        readerEvidenceRequest: nominations(bound + 1),
      }),
    ).toThrow(PublicationRunRecordDecodeError);
  });

  it.each(["create-documentation", "update-documentation"] as const)(
    "admits a %s record's change-source citation, labelled or not",
    async (workflow) => {
      const record = await productionRecord(workflow);
      const citation = {
        schemaVersion: 1,
        kind: "docsfab-run-change-source",
        sourceKind: "local-range",
        provenance: "local-verified",
        repository: { kind: "local-checkout", identitySha256: "e".repeat(64) },
        objectFormat: "sha1",
        rangeSemantics: "two-dot",
        base: "1".repeat(40),
        head: "2".repeat(40),
        mergeBase: "1".repeat(40),
        diffFrom: "1".repeat(40),
        labels: [] as string[],
        fileCount: 1,
        commitCount: 1,
        changeSourceSha256: "f".repeat(64),
        observations: [
          { role: "diff", observationId: "obs-change-diff" },
          { role: "manifest", observationId: "obs-change-manifest" },
        ],
      };
      // A label never blocks: the labelled twin decodes exactly as the unlabelled one.
      for (const labels of [[], ["commit-list-incomplete-shallow"]]) {
        const cited = { ...record, changeSources: [{ ...citation, labels }] };
        expect(decodeSuccessfulPublicationRunRecord(cited), labels.join()).toEqual(cited);
      }
      // Adjacent: a label outside the contract's list refuses on the same record.
      expect(() =>
        decodeSuccessfulPublicationRunRecord({
          ...record,
          changeSources: [{ ...citation, labels: ["not-a-change-source-label"] }],
        }),
      ).toThrow(PublicationRunRecordDecodeError);
    },
  );

  describe("a release run's citations", () => {
    type ReleaseCitations = Pick<RunRecord, "changeSources" | "changeSourceRelease">;
    const persisted = (saved: Record<string, unknown>): ReleaseCitations => {
      const { changeSources, changeSourceRelease } = saved as ReleaseCitations;
      return changeSources === undefined
        ? { changeSourceRelease }
        : { changeSources, changeSourceRelease };
    };
    let bound: ReleaseCitations;
    let allOmitted: ReleaseCitations;

    // The citations are the bytes two real release runs persisted, not hand-built twins.
    beforeAll(async () => {
      const release = await createReleaseFixture();
      const variable = "DOCSFAB_CHANGE_SOURCES_CHANGED_FILES_MAX";
      const previous = process.env[variable];
      try {
        bound = persisted((await runReleaseRecord(release.fixture, "release:v1.0..v1.1")).saved);
        // The merge unit alone: it changes two files, over a bound of one.
        process.env[variable] = "1";
        allOmitted = persisted(
          (await runReleaseRecord(release.fixture, `release:${release.plain}..v1.1`)).saved,
        );
      } finally {
        if (previous === undefined) delete process.env[variable];
        else process.env[variable] = previous;
        await rm(release.fixture.root, { recursive: true, force: true });
      }
    }, DELIVERY_RUN_RECORD_SUITE_TIMEOUT_MS);

    it.each(["create-documentation", "update-documentation"] as const)(
      "admits a %s record carrying a release run's unit citations and units index, and refuses tampered twins",
      async (workflow) => {
        const record = await productionRecord(workflow);
        expect(record).not.toHaveProperty("changeSources");
        expect(record).not.toHaveProperty("changeSourceRelease");
        const release = bound.changeSourceRelease!;
        const entries = bound.changeSources!;
        const omitted = allOmitted.changeSourceRelease!;
        // The two shapes the runs produced: every unit cited, and the index alone.
        expect(entries.map((entry) => entry.sourceKind)).toEqual([
          "release-range",
          "release-range",
        ]);
        expect(release).toMatchObject({ pageUnits: 2, omittedUnits: 0 });
        expect(allOmitted).not.toHaveProperty("changeSources");
        expect(omitted).toMatchObject({ pageUnits: 1, omittedUnits: 1 });

        for (const shape of [bound, allOmitted]) {
          const cited = { ...record, ...shape };
          expect(decodeSuccessfulPublicationRunRecord(cited)).toEqual(cited);
        }

        const twins: Record<string, ReleaseCitations> = {
          "one more omitted unit": {
            changeSources: entries,
            changeSourceRelease: {
              ...release,
              omittedUnits: release.omittedUnits + 1,
            },
          },
          "one more page unit": {
            changeSources: entries,
            changeSourceRelease: {
              ...release,
              pageUnits: release.pageUnits + 1,
              units: release.units + 1,
            },
          },
          "another object format": {
            changeSources: entries,
            changeSourceRelease: { ...release, objectFormat: "sha256" },
          },
          "another repository kind": {
            changeSources: entries,
            changeSourceRelease: {
              ...release,
              repository: { ...release.repository, kind: "gitlab-project" },
            },
          },
          "the units index citation dropped": { changeSources: entries },
          "a unit cited twice": {
            changeSources: [...entries, entries[0]!],
            changeSourceRelease: release,
          },
          "units relabelled as local ranges": {
            changeSources: entries.map((entry) => ({
              ...entry,
              sourceKind: "local-range",
            })),
            changeSourceRelease: release,
          },
          "the index alone with one omitted unit fewer": {
            changeSourceRelease: {
              ...omitted,
              omittedUnits: omitted.omittedUnits - 1,
            },
          },
        };
        for (const [name, twin] of Object.entries(twins)) {
          expect(() => decodeSuccessfulPublicationRunRecord({ ...record, ...twin }), name).toThrow(
            PublicationRunRecordDecodeError,
          );
        }
      },
    );
  });

  it("refuses a retained comparison on a workflow whose arguments cannot carry one", async () => {
    const record = await productionRecord("create-documentation");
    expect(decodeSuccessfulPublicationRunRecord(record)).toEqual(record);
    expect(() =>
      decodeSuccessfulPublicationRunRecord({
        ...record,
        readerEvidenceRequest: { comparisonRequest: { kind: "workspace" } },
      }),
    ).toThrow(PublicationRunRecordDecodeError);
  });

  it("admits planner history citations its attempts served and refuses ones they did not", async () => {
    const record = await productionRecord("update-documentation");
    const citation = {
      tool: "docsfab_history_show" as const,
      revisions: ["c".repeat(40)],
      paths: ["src/app.ts"],
      ranges: [{ path: "src/app.ts", unit: "bytes" as const, start: 0, end: 25 }],
      labels: [],
      sha256: "d".repeat(64),
    };
    // Served history pages on the planner's final attempt, plus `failed`
    // refused history calls, counted in the attempt, the step and the run alike.
    const withHistory = (citations: (typeof citation)[], stepCitations = citations, failed = 0) => {
      const copy = structuredClone(record);
      const planner = copy.steps.find((step) => step.id === "plan-documentation")!;
      const attempt = planner.inference!.attempts.at(-1)!;
      const calls = citations.length + failed;
      for (const tools of [planner.tools!, attempt.tools!, copy.tools]) {
        tools.totalCalls += calls;
        tools.failedCalls += failed;
        tools.byTool = [
          ...tools.byTool,
          { name: "docsfab_history_show", calls, failures: failed },
        ].sort((left, right) => left.name.localeCompare(right.name));
        if (failed > 0) {
          tools.failureCategories = [
            ...(tools.failureCategories ?? []),
            { category: "recoverable-miss" as const, count: failed },
          ];
        }
      }
      // The turn ledger counts the same calls.
      const finalTurn = attempt.turns!.at(-1)!;
      finalTurn.toolCalls += calls;
      finalTurn.toolResults += calls;
      attempt.tools!.historyReads = structuredClone(citations);
      planner.tools!.historyReads = structuredClone(stepCitations);
      return copy;
    };

    const admitted = withHistory([citation]);
    expect(decodeSuccessfulPublicationRunRecord(admitted)).toEqual(admitted);
    // With a recorded failure category the step's tools are compared field by
    // field, so the citations must stay out of the summed comparison.
    const withMiss = withHistory([citation], [citation], 1);
    expect(decodeSuccessfulPublicationRunRecord(withMiss)).toEqual(withMiss);
    // A step citation no attempt served, within the step's call count.
    expectPublicationRefusal(
      withHistory([citation], [{ ...citation, sha256: "e".repeat(64) }]),
      "invalid-shape",
    );
    // More citations than the tool's successful calls.
    const overCited = withHistory([citation]);
    overCited.steps
      .find((step) => step.id === "plan-documentation")!
      .inference!.attempts.at(-1)!
      .tools!.historyReads!.push(citation);
    overCited.steps
      .find((step) => step.id === "plan-documentation")!
      .tools!.historyReads!.push(citation);
    expectPublicationRefusal(overCited, "invalid-scorecard-run-record");
    // A revision that is not a full object id.
    expectPublicationRefusal(
      withHistory([{ ...citation, revisions: ["head"] }]),
      "invalid-scorecard-run-record",
    );
  });

  it("admits a planner blame citation by its line range and refuses one in another unit or from line 0", async () => {
    const record = await productionRecord("update-documentation");
    const citation = {
      tool: "docsfab_history_blame" as const,
      revisions: ["c".repeat(40)],
      paths: ["docs/guide.md"],
      ranges: [{ path: "docs/guide.md", unit: "lines" as const, start: 1, end: 3 }],
      labels: [],
      sha256: "d".repeat(64),
    };
    // One served blame page on the planner's final attempt, counted in the
    // attempt, the step and the run alike, as the turn ledger counts it.
    const withBlame = (served: unknown) => {
      const copy = structuredClone(record);
      const planner = copy.steps.find((step) => step.id === "plan-documentation")!;
      const attempt = planner.inference!.attempts.at(-1)!;
      for (const tools of [planner.tools!, attempt.tools!, copy.tools]) {
        tools.totalCalls += 1;
        tools.byTool = [
          ...tools.byTool,
          { name: "docsfab_history_blame", calls: 1, failures: 0 },
        ].sort((left, right) => left.name.localeCompare(right.name));
      }
      const finalTurn = attempt.turns!.at(-1)!;
      finalTurn.toolCalls += 1;
      finalTurn.toolResults += 1;
      attempt.tools!.historyReads = [structuredClone(served)] as never;
      planner.tools!.historyReads = [structuredClone(served)] as never;
      return copy;
    };

    const admitted = withBlame(citation);
    expect(decodeSuccessfulPublicationRunRecord(admitted)).toEqual(admitted);
    // Lines count from 1: a range starting at 0 is not a served line range.
    expectPublicationRefusal(
      withBlame({ ...citation, ranges: [{ ...citation.ranges[0]!, start: 0 }] }),
      "invalid-scorecard-run-record",
    );
    // Blame serves lines, never bytes; and only blame serves lines.
    expectPublicationRefusal(
      withBlame({ ...citation, ranges: [{ ...citation.ranges[0]!, unit: "bytes" }] }),
      "invalid-scorecard-run-record",
    );
    // One file at one revision per page.
    expectPublicationRefusal(
      withBlame({ ...citation, revisions: ["c".repeat(40), "e".repeat(40)] }),
      "invalid-scorecard-run-record",
    );
  });

  it("admits a planner search citation with its served commits and refuses one without them", async () => {
    const record = await productionRecord("update-documentation");
    const citation = {
      tool: "docsfab_history_search" as const,
      revisions: ["c".repeat(40)],
      paths: [],
      ranges: [{ path: null, unit: "entries" as const, start: 0, end: 2 }],
      labels: ["history-paths-excluded" as const],
      matchedCommits: ["e".repeat(40)],
      sha256: "d".repeat(64),
    };
    // One served search page on the planner's final attempt, counted in the
    // attempt, the step and the run alike, as the turn ledger counts it.
    const withSearch = (served: unknown) => {
      const copy = structuredClone(record);
      const planner = copy.steps.find((step) => step.id === "plan-documentation")!;
      const attempt = planner.inference!.attempts.at(-1)!;
      for (const tools of [planner.tools!, attempt.tools!, copy.tools]) {
        tools.totalCalls += 1;
        tools.byTool = [
          ...tools.byTool,
          { name: "docsfab_history_search", calls: 1, failures: 0 },
        ].sort((left, right) => left.name.localeCompare(right.name));
      }
      const finalTurn = attempt.turns!.at(-1)!;
      finalTurn.toolCalls += 1;
      finalTurn.toolResults += 1;
      attempt.tools!.historyReads = [structuredClone(served)] as never;
      planner.tools!.historyReads = [structuredClone(served)] as never;
      return copy;
    };

    const admitted = withSearch(citation);
    expect(decodeSuccessfulPublicationRunRecord(admitted)).toEqual(admitted);
    const { matchedCommits: _served, ...withoutServed } = citation;
    expectPublicationRefusal(withSearch(withoutServed), "invalid-scorecard-run-record");
    expectPublicationRefusal(
      withSearch({ ...citation, matchedCommits: ["e".repeat(40), "e".repeat(40)] }),
      "invalid-scorecard-run-record",
    );
  });

  it("accepts impact evidence containing additional structurally affected paths", async () => {
    const record = await productionRecord("bootstrap");
    record.impactPostflight = {
      schemaVersion: 1,
      status: "completed",
      analysisDigest: "a".repeat(64),
      changedPaths: ["README.md", "docs/affected-neighbor.md"],
    };

    expect(decodeSuccessfulPublicationRunRecord(record)).toEqual(record);
  });

  it("accepts degraded context only for the catalog-authorized read-only polish step", async () => {
    const record = await productionRecord("update-documentation", { polishTask: "bounded" });
    const step = record.steps[0]!;
    const identity = {
      repositoryRevision: record.repository.revision,
      contextPacketDigest: "e".repeat(64),
      consultedNodeIds: ["node-a"],
    };
    step.contextPreflight = {
      status: "degraded",
      packetDigest: identity.contextPacketDigest,
      consultedNodeIds: identity.consultedNodeIds,
      ontologyVersion: "ontology-v1",
      effectiveDecisionIds: [],
      measurements: {
        byteLength: 1,
        estimatedTokens: 1,
        latencyMs: 0,
        nodeCount: 1,
        edgeCount: 0,
        pathCount: 1,
      },
      cache: { disposition: "disabled", rebuildAttempted: false },
    };
    for (const attempt of step.inference!.attempts) {
      attempt.identity = structuredClone(identity);
      const digest = createHash("sha256")
        .update(
          JSON.stringify({
            consultedNodeIds: identity.consultedNodeIds,
            contextPacketDigest: identity.contextPacketDigest,
            repositoryRevision: identity.repositoryRevision,
          }),
        )
        .digest("hex");
      for (const turn of attempt.turns!) turn.evidenceDigest = digest;
    }

    expect(decodeContextPreflight(step.contextPreflight)).toEqual(step.contextPreflight);
    expect(decodeInference(step.inference, "read-only")).toEqual(step.inference);
    expect(decodeSuccessfulPublicationRunRecord(record)).toEqual(record);
  });

  it("accepts a step without a packet only when it is read-only and names the budget no packet fit (#1932)", async () => {
    const withheld = {
      status: "degraded" as const,
      reason: "preflight-budget-exceeded" as const,
      limit: {
        name: "context.localPacketInputShareBasisPoints",
        unit: "tokens" as const,
        configured: 2_051,
        observed: 4_006,
      },
      ontologyVersion: "ontology-v1",
      measurements: {
        byteLength: 16_024,
        estimatedTokens: 4_006,
        latencyMs: 0,
        nodeCount: 1,
        edgeCount: 0,
        pathCount: 1,
      },
      cache: { disposition: "disabled" as const, rebuildAttempted: false },
    };
    const recordWith = recordWithStepContext;

    // The read-only polish step ran without a packet and names the bound.
    const readOnly = await recordWith(undefined, withheld);
    expect(readOnly.steps[0]!.mode).toBe("read-only");
    expect(decodeContextPreflight(withheld)).toEqual(withheld);
    expect(decodeSuccessfulPublicationRunRecord(readOnly)).toEqual(readOnly);

    // The same step without a bound, or naming node IDs of a packet it never
    // received, is refused; each differs from the accepted record in that alone.
    const { limit: _limit, ...unbounded } = withheld;
    const noBound = { ...unbounded, reason: "navigation-coverage-incomplete" as const };
    expect(decodeContextPreflight(noBound)).toEqual(noBound);
    await expect(
      recordWith(undefined, noBound).then(decodeSuccessfulPublicationRunRecord),
    ).rejects.toThrow(PublicationRunRecordDecodeError);
    const strayNodes = { ...withheld, consultedNodeIds: ["node-a"] };
    expect(decodeContextPreflight(strayNodes)).toEqual(strayNodes);
    await expect(
      recordWith(undefined, strayNodes).then(decodeSuccessfulPublicationRunRecord),
    ).rejects.toThrow(PublicationRunRecordDecodeError);

    // A write step needs its packet: with one it is admitted, without one
    // it is refused, bound or not.
    const writeStep = "write-documentation";
    const trimmed = {
      ...withheld,
      packetDigest: "f".repeat(64),
      consultedNodeIds: ["node-write"],
    };
    const withPacket = await recordWith(writeStep, trimmed);
    expect(decodeSuccessfulPublicationRunRecord(withPacket)).toEqual(withPacket);
    await expect(
      recordWith(writeStep, withheld).then(decodeSuccessfulPublicationRunRecord),
    ).rejects.toThrow(PublicationRunRecordDecodeError);

    // A host-operation step has no model turns whose identity binds node IDs,
    // so on its packet-less record only the step's own check refuses them.
    const lintStep = "lint-documentation";
    const lint = await recordWith(lintStep, withheld);
    const lintRecord = lint.steps.find((candidate) => candidate.id === lintStep)!;
    expect(lintRecord.kind).toBe("host-operation");
    expect(lintRecord.inference).toBeUndefined();
    expect(decodeSuccessfulPublicationRunRecord(lint)).toEqual(lint);
    await expect(
      recordWith(lintStep, strayNodes).then(decodeSuccessfulPublicationRunRecord),
    ).rejects.toThrow(PublicationRunRecordDecodeError);
  });

  it("accepts a read-only step without a packet that names its preflight cause, and refuses a write step (#1924)", async () => {
    const indexRefused = {
      status: "degraded" as const,
      reason: "content-index-refused" as const,
      cause: {
        code: "duplicate-node-identity",
        message:
          'Content index contains a duplicate document identity: "docs/one.md" and "docs/two.md" share one. Give each page its own frontmatter id.',
      },
    };
    expect(decodeContextPreflight(indexRefused)).toEqual(indexRefused);
    const readOnly = await recordWithStepContext(undefined, indexRefused);
    expect(readOnly.steps[0]!.mode).toBe("read-only");
    expect(decodeSuccessfulPublicationRunRecord(readOnly)).toEqual(readOnly);
    // The same step with its cause taken away says nothing about why it had
    // no packet, so it is refused.
    const { cause: _cause, ...silent } = indexRefused;
    await expect(
      recordWithStepContext(undefined, {
        ...silent,
        reason: "navigation-coverage-incomplete",
      }).then(decodeSuccessfulPublicationRunRecord),
    ).rejects.toThrow(PublicationRunRecordDecodeError);
    // A write step needs its packet whatever the cause.
    await expect(
      recordWithStepContext("write-documentation", indexRefused).then(
        decodeSuccessfulPublicationRunRecord,
      ),
    ).rejects.toThrow(PublicationRunRecordDecodeError);
  });

  it("accepts a bounded degraded packet for the authorized polish write step", async () => {
    const record = await productionRecord("update-documentation", { polishTask: "bounded" });
    const step = record.steps.find((candidate) => candidate.id === "write-documentation")!;
    const identity = {
      repositoryRevision: record.repository.revision,
      contextPacketDigest: "f".repeat(64),
      consultedNodeIds: ["node-write"],
    };
    step.contextPreflight = {
      status: "degraded",
      packetDigest: identity.contextPacketDigest,
      consultedNodeIds: identity.consultedNodeIds,
      ontologyVersion: "ontology-v1",
      effectiveDecisionIds: [],
      measurements: {
        byteLength: 1,
        estimatedTokens: 1,
        latencyMs: 0,
        nodeCount: 1,
        edgeCount: 0,
        pathCount: 1,
      },
      cache: { disposition: "disabled", rebuildAttempted: false },
    };
    for (const attempt of step.inference!.attempts) {
      attempt.identity = structuredClone(identity);
      const digest = createHash("sha256")
        .update(
          JSON.stringify({
            consultedNodeIds: identity.consultedNodeIds,
            contextPacketDigest: identity.contextPacketDigest,
            repositoryRevision: identity.repositoryRevision,
          }),
        )
        .digest("hex");
      for (const turn of attempt.turns!) turn.evidenceDigest = digest;
    }

    expect(decodeInference(step.inference, "disabled-write-step")).toEqual(step.inference);
    expect(decodeSuccessfulPublicationRunRecord(record)).toEqual(record);
  });

  it("accepts an optional sealed taskLineage on a succeeded write run", async () => {
    const record = await productionRecord("update-documentation", { polishTask: "bounded" });
    expect(record.taskLineage).toBeUndefined();
    expect(decodeSuccessfulPublicationRunRecord(record)).toEqual(record);

    const historical = createHistoricalUnknownTaskLineage({
      lineageId: "lineage:publication-decode",
      repository: {
        identitySha256: "1".repeat(64),
        revision: REVISION.slice(0, 40),
      },
    });
    record.taskLineage = projectTaskLineage(historical.origin, historical.lineage);
    expect(decodeSuccessfulPublicationRunRecord(record)).toEqual(record);
  });

  it("fails closed on malformed or tampered taskLineage", async () => {
    const record = await productionRecord("bootstrap");
    const historical = createHistoricalUnknownTaskLineage({
      lineageId: "lineage:publication-decode-reject",
      repository: {
        identitySha256: "2".repeat(64),
        revision: REVISION.slice(0, 40),
      },
    });
    const valid = projectTaskLineage(historical.origin, historical.lineage);

    expect(() =>
      decodeSuccessfulPublicationRunRecord({
        ...record,
        taskLineage: { ...valid, unknownKey: true },
      }),
    ).toThrow(/Publication run record rejected/);

    expect(() =>
      decodeSuccessfulPublicationRunRecord({
        ...record,
        taskLineage: { ...valid, projectionSha256: "0".repeat(64) },
      }),
    ).toThrow(/Publication run record rejected/);

    expect(() =>
      decodeSuccessfulPublicationRunRecord({
        ...record,
        taskLineage: { kind: "not-a-lineage-projection", schemaVersion: 1 },
      }),
    ).toThrow(/Publication run record rejected/);
  });

  it("exposes a nested contract error's kebab-case code", async () => {
    const record = await productionRecord("bootstrap");
    expect(() => decodeSuccessfulPublicationRunRecord(null)).toThrow(
      expect.objectContaining({
        name: "PublicationRunRecordDecodeError",
        code: "invalid-shape",
      }),
    );

    try {
      decodeSuccessfulPublicationRunRecord({
        ...record,
        taskLineage: { kind: "not-a-lineage-projection", schemaVersion: 1 },
      });
      expect.unreachable("nested lineage contract error must reject");
    } catch (error) {
      expect(error).toBeInstanceOf(PublicationRunRecordDecodeError);
      expect(error).toMatchObject({ code: "migration-required" });
      expect(/^([a-z](?:[a-z0-9-]{0,62}[a-z0-9])?)$/u.test((error as { code: string }).code)).toBe(
        true,
      );
      expect((error as Error).cause).toMatchObject({
        name: "TaskLineageContractError",
        code: "migration-required",
      });
    }
  });

  it("admits the host-reset replay only on the CREATE revision writer (#1266)", async () => {
    const record = await sealedAuthoringDeliveryRecord("revise");
    const reset = structuredClone(record);
    const reviser = reset.steps.find((step) => step.id === "revise-documentation")!.inference!;
    expect(reviser.replay).toBe("disabled-write-step");
    reviser.replay = "reset-write-step";
    reviser.effectiveMaxRetries = reviser.configuredMaxRetries;
    expect(() => decodeV3DeliveryRecord(reset)).not.toThrow();

    const firstWriter = structuredClone(reset);
    const writer = firstWriter.steps.find((step) => step.id === "write-documentation")!.inference!;
    writer.replay = "reset-write-step";
    writer.effectiveMaxRetries = writer.configuredMaxRetries;
    expect(() => decodeV3DeliveryRecord(firstWriter)).toThrow(PublicationRunRecordDecodeError);
  });
  it.each([false, true])(
    "retains a runner-produced pre-execution rejection through strict publication decode (governance-stop=%s)",
    async (governanceStop) => {
      const record = await productionRecord("update-documentation", {
        polishTask: "bounded",
        preExecutionRejection: true,
        governanceStop,
      });
      expect(record.status, JSON.stringify(record.error)).toBe("succeeded");
      expect(record.tools.preExecutionRejections?.count).toBeGreaterThan(0);
      expect(decodeSuccessfulPublicationRunRecord(record)).toEqual(record);

      const missingAtRoot = structuredClone(record);
      delete missingAtRoot.tools.preExecutionRejections;
      expect(() => decodeSuccessfulPublicationRunRecord(missingAtRoot)).toThrow(
        PublicationRunRecordDecodeError,
      );
    },
  );
});

async function historicalCreatePublicationFixture(): Promise<{
  record: RunRecord;
  snapshot: {
    workflow: ReturnType<typeof parseWorkflowManifestSnapshot>;
    workflowIdentity: { id: "create-documentation"; sourceSha256: string };
  };
}> {
  const [recordBytes, workflowBytes] = await Promise.all([
    readFile(
      new URL(
        "./fixtures/delivery-run-record/create-documentation-c021009e-record.json.gz",
        import.meta.url,
      ),
    ),
    readFile(
      new URL(
        "./fixtures/delivery-run-record/create-documentation-c021009e-workflow.json.gz",
        import.meta.url,
      ),
    ),
  ]);
  const recordSource = gunzipSync(recordBytes).toString("utf8");
  const workflowSource = gunzipSync(workflowBytes).toString("utf8");
  const record = JSON.parse(recordSource) as RunRecord;
  const workflow = parseWorkflowManifestSnapshot(
    JSON.parse(workflowSource),
    "create-documentation",
    {
      "documentation-audit": documentationAuditSearch,
      "documentation-observation": documentationObservationSearch,
    },
  );
  return {
    record,
    snapshot: {
      workflow,
      workflowIdentity: {
        id: "create-documentation",
        sourceSha256: createHash("sha256").update(workflowSource).digest("hex"),
      },
    },
  };
}

async function pagePlusNightlyPublicationFixture(): Promise<{
  root: string;
  record: RunRecord;
  recordPath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "docsfab-nav-publication-"));
  try {
    const workspace = join(root, "workspace");
    const artifacts = join(root, "artifacts");
    await mkdir(join(workspace, "docs"), { recursive: true });
    await mkdir(join(workspace, "fern/versions"), { recursive: true });
    await writeFile(join(workspace, PAGE_PATH), "# Before\n\nIntro.\n");
    await writeFile(join(workspace, NAVIGATION_PATH), "versions:\n  - docs/guide.mdx\n");
    const collector = await GitPatchEvidenceCollector.create(workspace, artifacts);
    try {
      const before = await buildContentIndex({
        repositoryPath: workspace,
        repositoryRevision: REVISION,
      });
      await writeFile(join(workspace, PAGE_PATH), "# After\n\nUpdated body.\n");
      await writeFile(
        join(workspace, NAVIGATION_PATH),
        "versions:\n  - docs/guide.mdx\n  - docs/extra.mdx\n",
      );
      const changes = await collector.capture({
        runId: "run-create-documentation",
        workspacePath: workspace,
        repository: {
          sourcePath: "/private/source",
          requestedRevision: "HEAD",
          revision: REVISION,
        },
        persistPatch: true,
      });
      const impactPostflight = await new LocalImpactPostflightService(before).postflight({
        runId: "run-create-documentation",
        workflow: "create-documentation",
        workspacePath: workspace,
        repository: {
          sourcePath: "/private/source",
          requestedRevision: "HEAD",
          revision: REVISION,
        },
        changedFiles: changes.files,
      });
      const record = await productionRecord("create-documentation", {
        changes,
        impactPostflight,
        artifactDirectory: join(root, "production-artifacts"),
      });
      const recordPath = join(root, "run-create-documentation.json");
      await writeFile(recordPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
      return { root, record, recordPath };
    } finally {
      await collector.dispose();
    }
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

/** #1439: the comparator's field for one pair of a record's own step summaries. */
function verifierDisagreementBetween(
  record: RunRecord,
  provisionalStepId: string,
  canonicalStepId: string,
): VerifierDisagreementV1 {
  const summaryOf = (id: string) =>
    JSON.parse(record.steps.find((step) => step.id === id)!.summary!) as VerificationResult;
  return recordVerifierDisagreement({
    provisionalStepId,
    provisional: summaryOf(provisionalStepId),
    canonical: summaryOf(canonicalStepId),
  });
}

function expectPublicationRefusal(record: RunRecord, code: string): void {
  let refusal: unknown;
  try {
    decodeSuccessfulPublicationRunRecord(record);
  } catch (error) {
    refusal = error;
  }
  expect(refusal).toBeInstanceOf(PublicationRunRecordDecodeError);
  expect((refusal as PublicationRunRecordDecodeError).code).toBe(code);
}

function decodeV3DeliveryRecord(value: unknown): RunRecord {
  const workflow = parseWorkflowManifestSnapshot(authoringManifestV3(), "create-documentation", {
    "documentation-audit": documentationAuditSearch,
    "documentation-observation": documentationObservationSearch,
  });
  return decodeSuccessfulPublicationRunRecordSnapshot(value, {
    workflow,
    workflowIdentity: { id: "create-documentation", sourceSha256: "f".repeat(64) },
  });
}

function decodeV3DeliveryCandidateDigest(record: RunRecord, ordinal: 0 | 1): string {
  return record.authoringExecution!.candidates[ordinal]!.candidate.digest;
}

async function sealedAuthoringDeliveryRecord(
  branchId: "retain" | "revise",
  options: {
    additionalWritePaths?: readonly string[];
    revisionChangedPaths?: readonly string[];
  } = {},
): Promise<RunRecord> {
  const fixtureWorkflow = parseWorkflowManifestSnapshot(
    authoringManifestV3(),
    "create-documentation",
    {
      "documentation-audit": documentationAuditSearch,
      "documentation-observation": documentationObservationSearch,
    },
  );
  const base = await productionRecord("create-documentation");
  const fixture = await createRealAuthoringEvidenceFixture(fixtureWorkflow, {
    actionable: branchId === "revise",
    runId: "run-create-documentation",
    revision: base.repository.revision,
    additionalWritePaths: options.additionalWritePaths,
  });
  let revisedFixture: RealAuthoringEvidenceFixture | null = null;
  try {
    revisedFixture =
      branchId === "revise"
        ? await createRealAuthoringEvidenceFixture(fixtureWorkflow, {
            actionable: false,
            runId: "run-create-documentation",
            revision: base.repository.revision,
            additionalWritePaths: options.additionalWritePaths,
          })
        : null;
    const stepById = new Map(base.steps.map((step) => [step.id, step]));
    const sourceSearchEvidence = stepById.get("derive-source-obligations")?.searchEvidence;
    if (!sourceSearchEvidence) throw new Error("Missing production source search evidence.");
    const workflow = fixtureWorkflow;
    const path = authoringSelectedPath(workflow, branchId);
    const candidate0 = fixture.candidate0;
    const candidate1 =
      branchId === "revise"
        ? createAuthoringCandidate({
            runId: candidate0.runId,
            ordinal: 1,
            originalRevision: candidate0.originalRevision,
            planDigest: candidate0.planDigest,
            writePaths: candidate0.writePaths,
            patchDigestSha256: "3".repeat(64),
            patchBytes: 202,
            workspaceSnapshotDigest: "4".repeat(64),
          })
        : undefined;
    const candidates = candidate1 ? [candidate0, candidate1] : [candidate0];
    const sourceTechnicalSummary = fixture.technicalSummary;
    const revisedTechnicalSummary = revisedFixture?.technicalSummary ?? sourceTechnicalSummary;
    const sourceEditorialSummary = fixture.editorialSummary;
    const searchEvidence = structuredClone(sourceSearchEvidence);
    const ledgerContent = structuredClone(fixture.ledger) as unknown as Record<string, any>;
    ledgerContent.identity.sourceEvidenceSha256 = searchEvidence.evidenceSha256;
    ledgerContent.identity.workspaceSnapshotSha256 = searchEvidence.workspaceSnapshotSha256;
    delete ledgerContent.digest;
    const ledger = {
      ...ledgerContent,
      digest: canonicalDigest(ledgerContent),
    } as typeof fixture.ledger;
    const correctionContent = structuredClone(fixture.correction) as unknown as Record<string, any>;
    correctionContent.sourceObligationLedgerSha256 = ledger.digest;
    correctionContent.verificationResultSha256 = canonicalDigest(fixture.technicalResult);
    delete correctionContent.digest;
    const correction = {
      ...correctionContent,
      digest: canonicalDigest(correctionContent),
    } as typeof fixture.correction;
    const revisedCorrection = revisedFixture
      ? (() => {
          const content = structuredClone(revisedFixture.correction) as unknown as Record<
            string,
            any
          >;
          content.sourceObligationLedgerSha256 = ledger.digest;
          content.verificationResultSha256 = canonicalDigest(revisedFixture.technicalResult);
          delete content.digest;
          return { ...content, digest: canonicalDigest(content) } as typeof fixture.correction;
        })()
      : correction;
    const ledgerSummary = canonicalizeJsonEvidence(
      ledger as unknown as JsonEvidenceValue,
    ).trimEnd();
    const projectedFindings = projectDocumentationSearchFindings({
      workflow: "create-documentation",
      stepId: "derive-source-obligations",
      evidence: searchEvidence,
    });
    const projectedNegative = negativeDocumentationEvidence(projectedFindings);
    const projectedGapLedger = createDocumentationGapLedger({
      currentRevision: base.repository.revision,
      findings: projectedFindings,
    });
    const selectionInput = {
      candidate0Digest: candidate0.digest,
      candidate0WorkspaceSnapshotDigest: candidate0.workspaceSnapshotDigest,
      originalRevision: base.repository.revision,
      planDigest: fixture.plan.digest,
      writePaths: fixture.writePaths,
      sourceSearchSnapshotSha256: searchEvidence.workspaceSnapshotSha256,
      sourceObligationLedgerSha256: ledger.digest,
      technicalCorrectionEvidenceSha256: correction.digest,
      technical: producerBinding(candidate0, "verify-technical-accuracy", sourceTechnicalSummary),
      editorial: producerBinding(candidate0, "review-documentation", sourceEditorialSummary),
    };
    const recomputedSelection = selectAuthoringRevision({
      candidate0,
      originalRevision: base.repository.revision,
      planDigest: fixture.plan.digest,
      writePaths: fixture.writePaths,
      technical: {
        summary: sourceTechnicalSummary,
        summaryDigest: sha256(sourceTechnicalSummary),
        producerId: "verify-technical-accuracy",
        candidateDigest: candidate0.digest,
        candidateOrdinal: 0,
        workspaceSnapshotDigest: candidate0.workspaceSnapshotDigest,
        result: fixture.technicalResult,
      },
      editorial: {
        summary: sourceEditorialSummary,
        summaryDigest: sha256(sourceEditorialSummary),
        producerId: "review-documentation",
        candidateDigest: candidate0.digest,
        candidateOrdinal: 0,
        workspaceSnapshotDigest: candidate0.workspaceSnapshotDigest,
        result: fixture.editorialResult,
      },
      sourceObligationInput: {
        workflow,
        evidenceIdentity: { repositoryRevision: base.repository.revision },
        searchEvidence,
        planBinding: fixture.plan,
      },
      sourceObligationLedger: ledger,
      technicalCorrectionEvidence: correction,
    });
    const revisionInputDigest =
      recomputedSelection.kind === "revise" ? recomputedSelection.input.digest : null;
    if ((branchId === "revise") !== (recomputedSelection.kind === "revise")) {
      throw new Error("Fixture selection did not match the requested branch.");
    }
    const evidence = createAuthoringExecutionEvidenceV1(
      {
        runId: "run-create-documentation",
        repositoryRevision: base.repository.revision,
        planDigest: fixture.plan.digest,
        writePaths: fixture.writePaths,
        sourceSearchSnapshotSha256: searchEvidence.workspaceSnapshotSha256,
        sourceObligationLedgerSha256: ledger.digest,
        technicalCorrectionEvidenceSha256: correction.digest,
        selection: { branchId, input: selectionInput, revisionInputDigest },
        candidates: candidates.map((candidate) => ({
          candidate,
          revisionInputDigest: candidate.ordinal === 0 ? null : revisionInputDigest,
        })),
        revisionAdmission:
          branchId === "revise"
            ? createAuthoringRevisionAdmissionBindingV1({
                candidate0,
                candidate1: candidate1!,
                actualChangedPaths: revisionAccounting(fixture, options.revisionChangedPaths)
                  .changedPaths,
                accounting: revisionAccounting(fixture, options.revisionChangedPaths),
              })
            : null,
        partialCandidate1: null,
        selectedCandidateOrdinal: branchId === "retain" ? 0 : 1,
        selectedProducers: null,
        includeFinalPatch: true,
      },
      workflow,
    );
    const steps = path.steps.map((definition) => {
      const templateId = {
        "revise-documentation": "write-documentation",
        "lint-revised-documentation": "lint-documentation",
        "provisional-revised-technical-verification": "provisional-technical-verification",
        "verify-revised-technical-accuracy": "verify-technical-accuracy",
        "review-revised-documentation": "review-documentation",
      }[definition.id];
      const sourceStep =
        stepById.get(definition.id) ?? (templateId ? stepById.get(templateId) : undefined);
      const step = structuredClone(sourceStep);
      if (!step) throw new Error(`Missing production step ${definition.id}.`);
      step.id = definition.id;
      step.title = definition.title;
      step.kind = definition.kind;
      step.skill = definition.skill;
      step.mode = definition.mode;
      delete step.technicalCorrectionEvidence;
      delete step.originalSourceAuthority;
      delete step.searchEvidence;
      delete step.searchFindings;
      delete step.negativeEvidence;
      delete step.gapLedger;
      if (definition.id === "plan-documentation" || definition.id === "write-documentation") {
        step.planBinding = structuredClone(fixture.plan);
      }
      if (definition.id === "derive-source-obligations") {
        step.summary = ledgerSummary;
        step.searchEvidence = structuredClone(searchEvidence);
        step.searchFindings = structuredClone(projectedFindings);
        step.negativeEvidence = structuredClone(projectedNegative);
        step.gapLedger = structuredClone(projectedGapLedger);
      }
      if (definition.id === "verify-technical-accuracy") {
        step.summary = sourceTechnicalSummary;
        step.technicalCorrectionEvidence = structuredClone(correction);
      }
      if (definition.id === "verify-revised-technical-accuracy") {
        step.summary = revisedTechnicalSummary;
        step.technicalCorrectionEvidence = structuredClone(revisedCorrection);
      }
      if (definition.id === "review-documentation") step.summary = sourceEditorialSummary;
      const phase = path.phases.find((candidate) => candidate.stepId === definition.id);
      if (phase) {
        step.authoringPhase = createAuthoringPhaseEvidenceV1({
          workflow,
          branchId: phase.ordinal <= 7 ? null : branchId,
          stepId: definition.id,
          candidates,
          outputAdmitted:
            definition.id === "write-documentation" || definition.id === "revise-documentation",
          summary: step.summary ?? null,
        });
      }
      if (definition.id === "revise-documentation" && branchId === "revise") {
        (step as unknown as Record<string, unknown>).authoringRevisionAccounting =
          revisionAccounting(fixture, options.revisionChangedPaths);
      }
      return step;
    });
    bindPhaseInvocations(steps, path, branchId, candidates, revisionInputDigest);
    let scheduleCursor = Date.parse(base.startedAt!);
    steps.forEach((step) => {
      const inferenceDuration = (step.inference?.attempts ?? []).reduce(
        (sum, attempt) => sum + attempt.durationMs + (attempt.backoffMs ?? 0),
        0,
      );
      const durationMs = Math.max(step.durationMs ?? 0, inferenceDuration);
      step.startedAt = new Date(scheduleCursor).toISOString();
      scheduleCursor += durationMs;
      step.completedAt = new Date(scheduleCursor).toISOString();
      step.durationMs = durationMs;
    });
    base.completedAt = new Date(scheduleCursor).toISOString();
    base.durationMs = scheduleCursor - Date.parse(base.startedAt!);
    const selected = candidates[branchId === "retain" ? 0 : 1]!;
    const selectedProducers = {
      lint: producerBinding(
        selected,
        branchId === "retain" ? "lint-documentation" : "lint-revised-documentation",
        steps.find(
          (step) =>
            step.id ===
            (branchId === "retain" ? "lint-documentation" : "lint-revised-documentation"),
        )!.summary!,
      ),
      technical: producerBinding(
        selected,
        branchId === "retain" ? "verify-technical-accuracy" : "verify-revised-technical-accuracy",
        steps.find(
          (step) =>
            step.id ===
            (branchId === "retain"
              ? "verify-technical-accuracy"
              : "verify-revised-technical-accuracy"),
        )!.summary!,
      ),
      editorial: producerBinding(
        selected,
        branchId === "retain" ? "review-documentation" : "review-revised-documentation",
        steps.find(
          (step) =>
            step.id ===
            (branchId === "retain" ? "review-documentation" : "review-revised-documentation"),
        )!.summary!,
      ),
    };
    const finalEvidence = createAuthoringExecutionEvidenceV1(
      {
        runId: evidence.runId,
        repositoryRevision: evidence.repositoryRevision,
        planDigest: evidence.planDigest,
        writePaths: evidence.writePaths,
        sourceSearchSnapshotSha256: evidence.sourceSearchSnapshotSha256,
        sourceObligationLedgerSha256: evidence.sourceObligationLedgerSha256,
        technicalCorrectionEvidenceSha256: evidence.technicalCorrectionEvidenceSha256,
        selection: { branchId, input: selectionInput, revisionInputDigest },
        candidates: candidates.map((candidate) => ({
          candidate,
          revisionInputDigest: candidate.ordinal === 0 ? null : revisionInputDigest,
        })),
        revisionAdmission:
          branchId === "revise"
            ? createAuthoringRevisionAdmissionBindingV1({
                candidate0,
                candidate1: candidate1!,
                actualChangedPaths: revisionAccounting(fixture, options.revisionChangedPaths)
                  .changedPaths,
                accounting: revisionAccounting(fixture, options.revisionChangedPaths),
              })
            : null,
        partialCandidate1: null,
        selectedCandidateOrdinal: selected.ordinal,
        selectedProducers,
        includeFinalPatch: true,
      },
      workflow,
    );
    base.steps = steps;
    delete base.workflowOutcome;
    base.authoringExecution = finalEvidence;
    base.changes = {
      files: evidence.writePaths.map((path) => ({ path, status: "modified" as const })),
      patch: {
        sha256: selected.patchDigestSha256,
        byteLength: selected.patchBytes,
        lineCount: 1,
        artifactPath: "/private/state/run-create-documentation.patch",
        format: "git-diff",
      },
    };
    base.impactPostflight = {
      schemaVersion: 1,
      status: "completed",
      analysisDigest: "7".repeat(64),
      changedPaths: [...evidence.writePaths],
    };
    base.searchFindings = structuredClone(projectedFindings);
    base.negativeEvidence = structuredClone(projectedNegative);
    base.gapLedger = structuredClone(projectedGapLedger);
    base.models = uniqueByJson(steps.flatMap((step) => (step.model ? [step.model] : [])));
    base.skills = uniqueByJson(
      steps.flatMap((step) => (step.skillEvidence ? [step.skillEvidence] : [])),
    );
    base.usage = sumTestUsage(steps);
    base.tools = sumTestTools(steps);
    base.artifacts = uniqueByJson(steps.flatMap((step) => step.artifacts ?? []));
    return base;
  } finally {
    await fixture.dispose();
    await revisedFixture?.dispose();
  }
}

function producerBinding(
  candidate: AuthoringCandidateV1,
  stepId: string,
  summary: string,
): AuthoringProducerSummaryBindingV1 {
  return {
    stepId,
    summarySha256: sha256(summary),
    candidateOrdinal: candidate.ordinal,
    candidateDigest: candidate.digest,
    workspaceSnapshotDigest: candidate.workspaceSnapshotDigest,
  };
}

function revisionAccounting(
  fixture: RealAuthoringEvidenceFixture,
  changedPaths: readonly string[] = fixture.writePaths,
): AuthoringRevisionAccountingV1 {
  if (fixture.selection.kind !== "revise") throw new Error("Expected revision input.");
  const issueIds = [
    ...new Set(fixture.selection.input.actionableFacts.flatMap((fact) => fact.issueIds)),
  ].sort();
  return {
    issueAccounting: issueIds.map((issueId) => {
      const fact = fixture.selection.input.actionableFacts.find((candidate) =>
        candidate.issueIds.includes(issueId),
      );
      if (!fact) throw new Error(`Missing admitted fact for ${issueId}.`);
      return {
        issueId,
        disposition: "applied",
        reason: "The admitted source evidence supports this bounded correction.",
        sourceLocators: [fact.sourceLocators[0]],
      };
    }),
    changedPaths: [...changedPaths],
    unresolvedFacts: [],
  };
}

function bindPhaseInvocations(
  steps: StepRunRecord[],
  path: ReturnType<typeof authoringSelectedPath>,
  branchId: "retain" | "revise",
  candidates: readonly AuthoringCandidateV1[],
  revisionInputDigest: string | null,
): void {
  for (const step of steps) {
    const phase = path.phases.find((candidate) => candidate.stepId === step.id);
    if (!phase || !step.inference || (step.kind ?? "inference") === "host-operation") continue;
    const invocation = authoringPhaseInvocationBindingV1({
      workflow: parseWorkflowManifestSnapshot(authoringManifestV3(), "create-documentation", {
        "documentation-audit": documentationAuditSearch,
        "documentation-observation": documentationObservationSearch,
      }),
      branchId: phase.ordinal <= 7 ? null : branchId,
      stepId: step.id,
      candidates:
        phase.role === "writer"
          ? phase.stepId === "write-documentation"
            ? []
            : candidates.slice(0, 1)
          : candidates.slice(0, phase.candidateOrdinal + 1),
      revisionInputDigest: phase.stepId === "revise-documentation" ? revisionInputDigest : null,
    });
    for (const attempt of step.inference.attempts) {
      attempt.identity = {
        ...(attempt.identity ?? { repositoryRevision: REVISION }),
        authoringPhaseSha256: canonicalDigest(invocation),
      };
      const identity = attempt.identity;
      const digest = canonicalDigest({
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
      for (const turn of attempt.turns ?? []) turn.evidenceDigest = digest;
    }
  }
}

function uniqueByJson<T>(values: readonly T[]): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = JSON.stringify(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sumTestUsage(steps: readonly StepRunRecord[]): NonNullable<RunRecord["usage"]> {
  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0 };
  for (const usage of steps.flatMap((step) => (step.usage ? [step.usage] : []))) {
    total.input += usage.input;
    total.output += usage.output;
    total.cacheRead += usage.cacheRead;
    total.cacheWrite += usage.cacheWrite;
    total.total += usage.total;
    total.turns += usage.turns;
  }
  return total;
}

function sumTestTools(steps: readonly StepRunRecord[]): NonNullable<RunRecord["tools"]> {
  const byTool = new Map<string, { name: string; calls: number; failures: number }>();
  let totalCalls = 0;
  let failedCalls = 0;
  for (const tools of steps.flatMap((step) => (step.tools ? [step.tools] : []))) {
    totalCalls += tools.totalCalls;
    failedCalls += tools.failedCalls;
    for (const item of tools.byTool) {
      const existing = byTool.get(item.name) ?? { name: item.name, calls: 0, failures: 0 };
      existing.calls += item.calls;
      existing.failures += item.failures;
      byTool.set(item.name, existing);
    }
  }
  return { totalCalls, failedCalls, byTool: [...byTool.values()] };
}

async function knowledgeContinuationPublicationRecord(
  withTargetConflict = false,
): Promise<RunRecord> {
  const targetConflictReceipt = withTargetConflict ? knowledgeResumeReceipt() : null;
  const record = await productionRecord("create-documentation", {
    ...(targetConflictReceipt ? { planPagePath: targetConflictReceipt.selectedTargetPath } : {}),
  });
  const historical = createHistoricalUnknownTaskLineage({
    lineageId: "lineage:publication-continuation",
    repository: {
      identitySha256: createHash("sha256").update(record.repository.sourcePath).digest("hex"),
      revision: record.repository.revision,
    },
  });
  record.taskLineage = projectTaskLineage(historical.origin, historical.lineage);

  if (targetConflictReceipt) {
    record.knowledgeResumeReceipt = {
      ...targetConflictReceipt,
      snapshotSha256: "5".repeat(64),
    };
  }

  const receipt = createKnowledgeContinuationReceipt({
    schemaVersion: 1,
    kind: "docsfab-knowledge-continuation-receipt",
    originalRunId: record.id,
    repositoryIdentitySha256: createHash("sha256")
      .update(record.repository.sourcePath)
      .digest("hex"),
    repositoryRevision: record.repository.revision,
    workflow: "create-documentation",
    instructionSha256: createHash("sha256")
      .update(record.instruction!.normalize("NFC"))
      .digest("hex"),
    candidateSnapshotSha256: targetConflictReceipt?.snapshotSha256 ?? "a".repeat(64),
    candidateArtifactSha256: "b".repeat(64),
    candidateBytesSha256: "c".repeat(64),
    originalTaskArtifactSha256: "d".repeat(64),
    originalTaskBindingArtifactSha256: "e".repeat(64),
    originalTaskBindingBytesSha256: "f".repeat(64),
    originArtifactSha256: "1".repeat(64),
    lineageArtifactSha256: "2".repeat(64),
    taskLineageProjectionSha256: record.taskLineage.projectionSha256,
    targetConflictReceipt,
    targetConflictReceiptSha256: targetConflictReceipt
      ? canonicalDigest(targetConflictReceipt)
      : null,
  });
  const authorizationBody = {
    schemaVersion: 1 as const,
    kind: "docsfab-task-lineage-recovery-authorization" as const,
    originalOriginSha256: record.taskLineage.originSha256,
    originalLineageSha256: record.taskLineage.lineageSha256,
    challengeSha256: "3".repeat(64),
    authorizedAt: "2026-08-04T00:01:00.000Z",
    authorityReceiptSha256: "4".repeat(64),
  };
  const recoveryAuthorization: TaskLineageRecoveryAuthorizationV1 = {
    ...authorizationBody,
    authorizationSha256: canonicalDigest(authorizationBody),
  };
  record.knowledgeContinuationReceipt = receipt;
  record.knowledgeContinuationRecoveryAuthorization = recoveryAuthorization;
  record.knowledgeContinuationSnapshotSha256 = "5".repeat(64);
  refreshContinuationAcceptance(record);
  return record;
}

function resealContinuationReceipt(
  receipt: KnowledgeContinuationReceiptV1,
  patch: Partial<Omit<KnowledgeContinuationReceiptV1, "receiptSha256">>,
): KnowledgeContinuationReceiptV1 {
  const { receiptSha256: _receiptSha256, ...body } = { ...receipt, ...patch };
  return createKnowledgeContinuationReceipt(body);
}

function resealRecoveryAuthorization(
  authorization: TaskLineageRecoveryAuthorizationV1,
  patch: Partial<Omit<TaskLineageRecoveryAuthorizationV1, "authorizationSha256">>,
): TaskLineageRecoveryAuthorizationV1 {
  const { authorizationSha256: _authorizationSha256, ...body } = { ...authorization, ...patch };
  return { ...body, authorizationSha256: canonicalDigest(body) };
}

function refreshContinuationAcceptance(record: RunRecord): void {
  const receipt = record.knowledgeContinuationReceipt!;
  const authorization = record.knowledgeContinuationRecoveryAuthorization!;
  const targetConflictReceiptSha256 = receipt.targetConflictReceiptSha256;
  record.knowledgeContinuationAcceptanceSha256 = knowledgeContinuationAcceptanceSha256({
    receiptSha256: receipt.receiptSha256,
    recoveryAuthorizationSha256: authorization.authorizationSha256,
    snapshotSha256: record.knowledgeContinuationSnapshotSha256!,
    targetConflictReceiptSha256,
  });
}

async function createProductionAuthoringFixture(
  writePaths: readonly string[],
  artifactDirectory?: string,
  /** CREATE plans new pages, so its targets are absent from the revision. */
  seedWritePaths = true,
  seedFiles: Record<string, string> = {},
) {
  const root = await mkdtemp(join(tmpdir(), "docsfab-delivery-authoring-"));
  const sourcePath = join(root, "source");
  const artifacts = artifactDirectory ?? join(root, "artifacts");
  try {
    const files: Record<string, string> = {
      "src/api.ts":
        Array.from({ length: 48 }, (_, index) => `export const fixture${index} = ${index};`).join(
          "\n",
        ) + "\n",
    };
    if (seedWritePaths) {
      for (const path of writePaths) files[path] = `Before governed authoring for ${path}.\n`;
    }
    Object.assign(files, seedFiles);
    const revision = await initFixtureRepo(sourcePath, files, {
      branch: "main",
      message: "delivery fixture",
    });
    const workspace = await prepareRepositoryWorkspace(sourcePath, revision);
    await mkdir(artifacts, { recursive: true, mode: 0o700 });
    const collector = await GitPatchEvidenceCollector.create(workspace.path, artifacts);
    const sourceObserver = new LocalSourceObligationSourceObserver(workspace);
    const search = new LocalWorkflowSearchCoordinator();
    const operationHost = hostOperations();
    const lifecycle = new LocalAuthoringCandidateLifecycle({
      workspace,
      evidenceCollector: collector,
      search,
      sourceObserver,
      hostOperations: operationHost,
      artifactDirectory: artifacts,
    });
    return {
      workspace,
      collector,
      sourceObserver,
      search,
      lifecycle,
      hostOperations: operationHost,
      repository: { sourcePath, requestedRevision: revision, revision },
      dispose: async () => {
        await collector.dispose();
        await workspace.dispose();
        await rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function productionRecord(
  workflow:
    | "bootstrap"
    | "site-bootstrap"
    | "foundation-to-patch"
    | "create-documentation"
    | "update-documentation"
    | "restructure-documentation",
  options: {
    polishTask?: "bounded" | "none";
    changes?: ChangeEvidence;
    impactPostflight?: ImpactPostflightResult;
    planPagePath?: string;
    artifactDirectory?: string;
    instruction?: string;
    runStore?: FileRunStore;
    beforeRun?: (
      fixture: Awaited<ReturnType<typeof createProductionAuthoringFixture>>,
    ) => Promise<Pick<RunRequest, "firstPassChoices" | "requestIntent">>;
    inspectRun?: (
      record: RunRecord,
      fixture: Awaited<ReturnType<typeof createProductionAuthoringFixture>>,
    ) => Promise<void>;
    /** Seed the CREATE target in the revision, the shape plan admission converts. */
    seedCreateTarget?: boolean;
    /** Extra files the revision holds. */
    seedFiles?: Record<string, string>;
    /** Runs the real lint operation, whose required checks use this authority. */
    requiredCheckAuthority?: CheckCommandAuthority;
    /** Exercise the runner's supplemental rejection aggregation and strict publication reader. */
    preExecutionRejection?: boolean;
    governanceStop?: boolean;
    /** Exercise runner-owned source seeding and retained request diagnostics. */
    preservationObservationReuse?: boolean;
    runtimeDiagnostics?: boolean;
    savedRecords?: RunRecord[];
  } = {},
): Promise<RunRecord> {
  const model = modelEvidence();
  let clock = Date.parse("2026-08-04T00:00:00.000Z");
  const authoringPaths = [
    ...new Set(
      options.changes?.files.map((file) => file.path) ?? [options.planPagePath ?? "README.md"],
    ),
  ].sort();
  const authoringFixture =
    workflow === "create-documentation" ||
    workflow === "update-documentation" ||
    workflow === "restructure-documentation"
      ? await createProductionAuthoringFixture(
          authoringPaths,
          options.artifactDirectory,
          workflow !== "create-documentation" || options.seedCreateTarget === true,
          options.seedFiles,
        )
      : null;
  const fixtureHarness = harness(
    model,
    authoringPaths,
    options.preExecutionRejection === true,
    options.governanceStop === true,
    options.runtimeDiagnostics === true,
  );
  const protocol =
    workflow === "update-documentation"
      ? scriptedEditorialProtocol(fixtureHarness)
      : { harness: fixtureHarness };
  const requiredCheckAuthority = options.requiredCheckAuthority;
  const operationHost =
    requiredCheckAuthority && authoringFixture
      ? new WorkflowChecksHostOperation(authoringFixture.workspace, "lint-documentation", {
          prepareAuthority: async () => requiredCheckAuthority,
        })
      : (authoringFixture?.hostOperations ?? hostOperations());
  const runner = new WorkflowRunner({
    ...protocol,
    hostOperations: operationHost,
    store: options.savedRecords
      ? {
          save: async (record) => {
            await options.runStore?.save(record);
            options.savedRecords?.push(structuredClone(record));
          },
        }
      : (options.runStore ?? { save: async () => undefined }),
    ...(options.preservationObservationReuse === true
      ? {
          preservationBaseDelivery: "stage-specific" as const,
          preservationObservationReuse: true,
        }
      : {}),
    repositoryScanner: {
      scan: async () => ({
        ruleSet: "credential-rules-v1",
        status: "passed",
        scannedFiles: 1,
        binaryFiles: 0,
        findings: [],
      }),
    },
    contextPreflight: {
      preflight: async () => ({
        status: "unnecessary",
        reason: "policy-marked-unnecessary",
      }),
    },
    ...(workflow === "create-documentation" ||
    workflow === "update-documentation" ||
    workflow === "restructure-documentation"
      ? {
          workflowSearch: authoringFixture!.search,
          sourceObligationObserver: authoringFixture!.sourceObserver,
          ...(workflow === "create-documentation"
            ? { authoringCandidateLifecycle: authoringFixture!.lifecycle }
            : {}),
        }
      : {}),
    repositoryEvidence:
      workflow === "create-documentation"
        ? authoringFixture!.collector
        : ({
            capture: async (context) => {
              if (options.changes) {
                return context.persistPatch
                  ? structuredClone(options.changes)
                  : { files: structuredClone(options.changes.files) };
              }
              return {
                files: [{ path: "README.md", status: "modified" }],
                patch: {
                  sha256: "f".repeat(64),
                  byteLength: 42,
                  lineCount: 1,
                  artifactPath: "/private/state/run.patch",
                  format: "git-diff",
                },
              };
            },
          } as const),
    impactPostflight: {
      postflight: async () =>
        options.impactPostflight
          ? structuredClone(options.impactPostflight)
          : {
              schemaVersion: 1,
              status: "completed" as const,
              analysisDigest: "7".repeat(64),
              changedPaths: authoringPaths,
            },
    },
    ...(workflow === "update-documentation"
      ? { outcomeProjector: new AuthoringQualityWorkflowOutcomeProjector() }
      : {}),
    retryPolicy: {
      maxRetries: 2,
      baseDelayMs: 100,
      maxDelayMs: 1_000,
      retryableCategories: ["timeout"],
    },
    id: () => `run-${workflow}`,
    now: () => new Date((clock += 100)),
  });
  const disposableWorkspace = authoringFixture
    ? null
    : await createObservableWorkspaceWithoutRequiredChecks();
  try {
    const boundRequest = options.beforeRun ? await options.beforeRun(authoringFixture!) : {};
    const plan = planReference();
    const polishTask = options.polishTask;
    const record = await runner.run({
      workflow,
      ...boundRequest,
      workspacePath: authoringFixture?.workspace.path ?? disposableWorkspace!.path,
      repository: authoringFixture?.repository ?? {
        sourcePath: "/private/source",
        requestedRevision: "HEAD",
        revision: REVISION,
      },
      allowWrite: true,
      ...(workflow === "site-bootstrap"
        ? { task: { kind: "site-bootstrap" as const, plan } }
        : workflow === "foundation-to-patch"
          ? {
              task: {
                kind: "foundation-to-patch" as const,
                intendedPaths: authoringPaths,
                canonSha256: "e".repeat(64),
              },
            }
          : workflow === "update-documentation" && polishTask === "bounded"
            ? { task: boundedTask(authoringFixture!.repository) }
            : workflow === "create-documentation"
              ? {
                  instruction:
                    options.instruction ?? "Create a documentation page for this feature",
                  task: { kind: "create-documentation" as const, canonSha256: "e".repeat(64) },
                }
              : workflow === "update-documentation" && polishTask === "none"
                ? {
                    instruction: "Polish the documentation with a concrete page-level change.",
                  }
                : workflow === "update-documentation"
                  ? {
                      instruction: "Update docs for this API change",
                      task: { kind: "update-documentation" as const, canonSha256: "e".repeat(64) },
                    }
                  : workflow === "restructure-documentation"
                    ? {
                        instruction: "Polish the documentation with a concrete page-level change.",
                      }
                    : {}),
    });
    if ("decodeOptions" in protocol) productionDecodeOptions.set(record.id, protocol.decodeOptions);
    if (options.inspectRun) await options.inspectRun(record, authoringFixture!);
    return record;
  } finally {
    await disposableWorkspace?.dispose();
    await authoringFixture?.dispose();
  }
}

function boundedTask(repository: { sourcePath: string; revision: string }) {
  const approvedProposal = "Completed governed documentation work.";
  return {
    kind: "bounded-doc-improvement" as const,
    campaignId: "campaign-1",
    repositoryId: "group/repository-1",
    testedCommit: repository.revision,
    repositoryIdentitySha256: createHash("sha256").update(repository.sourcePath).digest("hex"),
    contextSourcePath: "docs/gap-evidence.json",
    gap: {
      id: "gap-1",
      evidenceSha256: "2".repeat(64),
      successCriterionSha256: "3".repeat(64),
    },
    analysis: {
      runId: "analysis-1",
      recordSha256: "4".repeat(64),
      approvedOutcomeSha256: canonicalDigest(approvedProposal),
      approvedProposal,
    },
    authorization: { sha256: "5".repeat(64), digest: "6".repeat(64) },
    intendedPaths: ["README.md"],
  };
}

/** The fixture planner's reply digest, as the harness reports a completed plan. */
const PLAN_RESPONSE_SHA256 = "c".repeat(64);

function harness(
  model: ModelEvidence & { profile: ModelProfileEvidence },
  planPagePaths: readonly string[] = ["README.md"],
  preExecutionRejection = false,
  governanceStop = false,
  runtimeDiagnostics = false,
): AgentHarness {
  return {
    inspectSkill: async ({ step }) => skill(step.skill),
    runStep: async (input) => {
      if (
        runtimeDiagnostics &&
        input.workflow.name === "restructure-documentation" &&
        input.step.id === "verify-technical-accuracy"
      ) {
        const reader = input.preservationSourceReader!;
        const cache = input.preservationSourceObservationCache!;
        const { listPreservationSources } = await import(
          "../src/workflow-execution/source-obligation-observer.js"
        );
        const { readPreservationSourceObservation } = await import(
          "../src/workflow-execution/preservation-source-observation-cache.js"
        );
        const sourceId = listPreservationSources(reader)[0]!.sourceId;
        await readPreservationSourceObservation({
          cache,
          reader,
          sourceId,
          fromByte: 0,
          maxBytes: 12,
        });
      }
      if (
        input.workflow.name === "create-documentation" &&
        input.step.id === "write-documentation"
      ) {
        for (const path of planPagePaths) {
          await mkdir(dirname(join(input.repositoryPath, path)), { recursive: true });
          await writeFile(
            join(input.repositoryPath, path),
            `Completed governed documentation work for ${path}.\n`,
          );
        }
      }
      const governed = governProviderTurn({
        context: { messages: [{ role: "user", content: "Perform governed documentation work." }] },
        policy: {
          budget: {
            configuredContextWindow: model.profile.configuredContextWindow,
            effectiveContextWindow: model.profile.effectiveContextWindow,
            configuredMaxInputTokens: 128_000,
            effectiveMaxInputTokens: 128_000,
            configuredMaxOutputTokens: model.profile.configuredMaxOutputTokens,
            effectiveMaxOutputTokens: model.profile.effectiveMaxOutputTokens,
            reservedTokens: model.profile.requestPolicy.reservedContextTokens,
            requiredMinimumOutputTokens: model.profile.requestPolicy.minimumOutputTokens,
          },
          maxProviderTurns: 12,
          maxToolCalls: 12,
          maxCompactions: 8,
          minRecentToolTurns: 1,
        },
        state: { providerTurns: 0, toolCalls: 0, toolResults: 0, compactions: 0 },
        evidenceIdentity: input.evidenceIdentity!,
        pinnedMessageCount: 0,
      });
      const summary =
        input.step.skill === "review-documentation"
          ? canonicalizeJsonEvidence({ verdict: "pass", issues: [] }).trimEnd()
          : "Completed governed documentation work.";
      return {
        summary,
        ...(await verificationFixture(input)),
        ...(input.step.skill === "plan-documentation" && input.workflow.name
          ? {
              planResponseSha256: PLAN_RESPONSE_SHA256,
              planBinding: documentationPlanBindingForPaths(
                input.workflow.name === "create-documentation"
                  ? "create"
                  : input.workflow.name === "update-documentation"
                    ? "update"
                    : "restructure",
                planPagePaths,
              ),
            }
          : {}),
        model: structuredClone(model),
        skill: skill(input.step.skill),
        usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, total: 3, turns: 1 },
        ...(runtimeDiagnostics
          ? {
              providerResponses: {
                schemaVersion: 1 as const,
                state: "complete" as const,
                observations: [
                  {
                    requestSequence: 1,
                    disposition: "complete" as const,
                    observedBytes: 12,
                    httpStatus: 200,
                  },
                ],
                pendingRequestSequences: [],
              },
              efficiency: {
                schemaVersion: 1 as const,
                requests: [
                  { requestSequence: 1, turn: 1, bodyBytes: 123, bodySha256: "e".repeat(64) },
                ],
                sourceReuse: null,
              },
            }
          : {}),
        tools: {
          totalCalls: 0,
          failedCalls: 0,
          byTool: [],
          ...(governanceStop
            ? { failureCategories: [{ category: "governance-stop" as const, count: 1 }] }
            : {}),
          ...(preExecutionRejection
            ? {
                preExecutionRejections: {
                  schemaVersion: 1 as const,
                  kind: "tool-pre-execution-rejections" as const,
                  count: 1,
                },
              }
            : {}),
        },
        turns: [
          preExecutionRejection
            ? { ...governed.evidence, toolCalls: 1 + Number(governanceStop), toolResults: 0 }
            : governed.evidence,
        ],
      };
    },
  };
}

function documentationPlanBinding(mode: DocumentationPlanMode, pagePath = "README.md") {
  return documentationPlanBindingForPaths(mode, [pagePath]);
}

function documentationPlanBindingForPaths(
  mode: DocumentationPlanMode,
  pagePaths: readonly string[],
) {
  const pages = pagePaths.map((path) => ({ path, disposition: mode }));
  const sourceBindings = pagePaths.map((pagePath) => ({
    pagePath,
    sources: [mode === "create" ? "src/api.ts:42" : "README.md"],
  }));
  return {
    kind: "docsfab-documentation-plan" as const,
    schemaVersion: 1 as const,
    mode,
    pages,
    sourceBindings,
    digest: documentationPlanBindingDigest({ mode, pages, sourceBindings }),
  };
}

function knowledgeResumeReceipt() {
  return {
    schemaVersion: 1 as const,
    kind: "docsfab-knowledge-resume-receipt" as const,
    snapshotSha256: "c".repeat(64),
    selectedTargetPath: "docs/reference/cli.mdx",
    advisoryConflicts: [
      {
        conflictId: "CF-ABOUT",
        claimIds: ["CL-ABOUT-1", "CL-ABOUT-2"],
        impact: "load-bearing" as const,
        impactBasisSha256: "d".repeat(64),
        blockingDocumentationPaths: ["docs/about/product.md"],
        resolutionOwner: "product-owner",
        authorityKind: "product-decision-owner" as const,
      },
    ],
  };
}

function hostOperations(): HostOperationExecutor {
  return {
    runStep: async (input) => {
      if (input.step.id === "lint-documentation")
        return { summary: "Fixture native checks passed" };
      if (input.workflow.name === "foundation-to-patch") {
        if (input.task?.kind !== "foundation-to-patch")
          throw new Error("Missing Foundation-to-patch task.");
        return { summary: "Fixture host operation captured the scoped Foundation patch." };
      }
      if (input.task?.kind !== "site-bootstrap") throw new Error("Missing site-bootstrap task.");
      return {
        summary: "Applied the approved plan.",
        artifacts: [{ role: "input", reference: input.task.plan }],
      };
    },
  };
}

function planReference(): ArtifactReference<"ia-plan"> {
  return {
    kind: "ia-plan",
    schemaVersion: 1,
    digest: "b".repeat(64),
    repositoryRevision: REVISION,
    repositoryContentDigest: "c".repeat(64),
  };
}

function skill(id: string) {
  return {
    id,
    contentSha256: createHash("sha256").update(id).digest("hex"),
    bundleSha256: createHash("sha256").update(`bundle:${id}`).digest("hex"),
    version: "1.0.0",
    license: "Apache-2.0",
    source: { repository: "skill-catalog", revision: REVISION, path: `skills/${id}/SKILL.md` },
    toolPolicy: { declared: [], granted: [], withheld: [] },
  };
}

function modelEvidence(): ModelEvidence & { profile: ModelProfileEvidence } {
  const provider = "policy-provider";
  const model = "policy/model";
  const profile: Omit<ModelProfileEvidence, "sha256"> = {
    schemaVersion: 2,
    status: "current",
    configuredContextWindow: 128_000,
    effectiveContextWindow: 128_000,
    configuredMaxInputTokens: 128_000,
    effectiveMaxInputTokens: 128_000,
    configuredMaxOutputTokens: 16_384,
    effectiveMaxOutputTokens: 16_384,
    effectiveLimitReason: "none",
    apiFormat: "chat_completions",
    reasoning: false,
    input: ["text"],
    compatibility: {
      supportsDeveloperRole: true,
      supportsReasoningEffort: false,
      apiFormats: ["chat_completions"],
    },
    requestPolicy: { minimumOutputTokens: 16, reservedContextTokens: 128 },
    costPerMillionTokens: { input: null, output: null, cacheRead: null, cacheWrite: null },
    pricing: "unknown",
    approvedSourceSha256: "d".repeat(64),
    effectiveDate: "2026-08-01",
    reviewAfter: "2026-09-01",
  };
  return {
    provider,
    model,
    profile: {
      ...profile,
      sha256: modelProfileEvidenceSha256({ provider, model, profile }),
    },
  };
}

describe("publication RunRecord navigation labels", {
  timeout: DELIVERY_RUN_RECORD_SUITE_TIMEOUT_MS,
}, () => {
  it("admits navigation labels on the restructure planner and writer only", async () => {
    const record = await productionRecord("restructure-documentation");
    expect(record.status, JSON.stringify(record.error)).toBe("succeeded");
    const labeled = structuredClone(record);
    const stepOf = (target: RunRecord, id: string) =>
      target.steps.find((candidate) => candidate.id === id)!;
    stepOf(labeled, "plan-documentation").navigationLabels = [
      { code: "navigation-companion-not-granted", path: "mkdocs.yml", grant: ["docs/", "fern/"] },
    ];
    stepOf(labeled, "write-documentation").navigationLabels = [
      {
        code: "navigation-unreachable-page",
        path: "docs/client.md",
        navigation: null,
        index: "docs/index.md",
      },
    ];
    expect(decodeSuccessfulPublicationRunRecord(labeled)).toEqual(labeled);

    const malformed = structuredClone(labeled);
    stepOf(malformed, "write-documentation").navigationLabels = [
      { code: "navigation-unreachable-page", path: "docs/client.md" } as never,
    ];
    expect(() => decodeSuccessfulPublicationRunRecord(malformed)).toThrow(
      PublicationRunRecordDecodeError,
    );
    const elsewhere = structuredClone(labeled);
    stepOf(elsewhere, "review-documentation").navigationLabels = stepOf(
      labeled,
      "write-documentation",
    ).navigationLabels;
    expect(() => decodeSuccessfulPublicationRunRecord(elsewhere)).toThrow(
      PublicationRunRecordDecodeError,
    );
  });
});

/** A production record whose step `stepId` (the first by default) ran on `context`, its model turns bound to it. */
async function recordWithStepContext(
  stepId: string | undefined,
  context: Record<string, unknown>,
): Promise<RunRecord> {
  const record = await productionRecord("update-documentation", { polishTask: "bounded" });
  const step = stepId
    ? record.steps.find((candidate) => candidate.id === stepId)!
    : record.steps[0]!;
  step.contextPreflight = context as unknown as NonNullable<typeof step.contextPreflight>;
  const identity = {
    repositoryRevision: record.repository.revision,
    ...(context.packetDigest ? { contextPacketDigest: context.packetDigest as string } : {}),
    ...(context.consultedNodeIds ? { consultedNodeIds: context.consultedNodeIds as string[] } : {}),
  };
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        ...(identity.consultedNodeIds ? { consultedNodeIds: identity.consultedNodeIds } : {}),
        ...(identity.contextPacketDigest
          ? { contextPacketDigest: identity.contextPacketDigest }
          : {}),
        repositoryRevision: identity.repositoryRevision,
      }),
    )
    .digest("hex");
  for (const attempt of step.inference?.attempts ?? []) {
    attempt.identity = structuredClone(identity);
    for (const turn of attempt.turns!) turn.evidenceDigest = digest;
  }
  return record;
}

it("disposes the allocated authoring fixture when beforeRun throws", async () => {
  let workspacePath = "";
  let repositoryPath = "";
  const failure = new Error("fixture beforeRun stopped");
  await expect(
    productionRecord("create-documentation", {
      beforeRun: async (fixture) => {
        workspacePath = fixture.workspace.path;
        repositoryPath = fixture.repository.sourcePath;
        expect((await lstat(workspacePath)).isDirectory()).toBe(true);
        throw failure;
      },
    }),
  ).rejects.toBe(failure);
  expect(workspacePath).not.toBe("");
  expect(repositoryPath).not.toBe("");
  await expect(lstat(workspacePath)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(lstat(repositoryPath)).rejects.toMatchObject({ code: "ENOENT" });
});

describe("rich candidate cold transport", () => {
  it(
    "rejects dropped V3 candidate evidence while final attempts retain its identity",
    async () => {
      const { runRichCandidateV3Fixture } = await import("./helpers/rich-candidate-run.js");
      const fixture = await runRichCandidateV3Fixture();
      try {
        expect(decodeSuccessfulPublicationRunRecord(fixture.saved).id).toBe(fixture.saved.id);
        const dropped = structuredClone(fixture.saved);
        for (const [provisionalId, finalId] of [
          ["provisional-technical-verification", "verify-technical-accuracy"],
          ["provisional-revised-technical-verification", "verify-revised-technical-accuracy"],
        ]) {
          const provisional = dropped.steps.find((step) => step.id === provisionalId)!;
          const final = dropped.steps.find((step) => step.id === finalId)!;
          expect(provisional.provisionalRichCandidateEvidence).toBeDefined();
          expect(
            final.inference?.attempts[0]?.identity?.provisionalRichCandidateSha256,
          ).toBeDefined();
          delete provisional.provisionalRichCandidateEvidence;
        }
        expect(() => decodeSuccessfulPublicationRunRecord(dropped)).toThrow(
          PublicationRunRecordDecodeError,
        );
      } finally {
        await fixture.dispose();
      }
    },
    DELIVERY_RUN_RECORD_SUITE_TIMEOUT_MS,
  );
  it(
    "cold-imports real Pi candidate evidence and refuses altered placement, seal, and final lease",
    async () => {
      const { runRichCandidateFixture } = await import("./helpers/rich-candidate-run.js");
      const { decodeSuccessfulReviewRunRecord } = await import("../src/delivery/run-record.js");
      const { decodeSavedRunRecord } = await import("../src/records/saved-run-record.js");
      const fixture = await runRichCandidateFixture();
      try {
        const saved = fixture.saved;
        expect(saved.status).toBe("succeeded");
        expect(decodeSavedRunRecord(saved as never, saved.id).id).toBe(saved.id);
        const decoded = decodeSuccessfulReviewRunRecord(saved);
        const provisional = decoded.steps.find(
          (step) => step.id === "provisional-technical-verification",
        )!;
        expect(provisional.provisionalRichCandidateEvidence?.candidates[0]?.proposedEdit.text).toBe(
          fixture.candidate.proposedEdit.text,
        );

        const mutate = (change: (record: RunRecord) => void): RunRecord => {
          const copy = structuredClone(saved);
          change(copy);
          return copy;
        };
        expect(() =>
          decodeSuccessfulReviewRunRecord(
            mutate((record) => {
              const evidence = record.steps.find((step) => step.id === provisional.id)!
                .provisionalRichCandidateEvidence!;
              (evidence as unknown as Record<string, unknown>).extra = true;
            }),
          ),
        ).toThrow();
        expect(() =>
          decodeSuccessfulReviewRunRecord(
            mutate((record) => {
              const evidence = record.steps.find((step) => step.id === provisional.id)!
                .provisionalRichCandidateEvidence!;
              (evidence as unknown as { digest: string }).digest = "0".repeat(64);
            }),
          ),
        ).toThrow();
        expect(() =>
          decodeSuccessfulReviewRunRecord(
            mutate((record) => {
              const misplaced = record.steps.find((step) => step.id === "review-documentation")!;
              (
                misplaced as unknown as { provisionalRichCandidateEvidence: unknown }
              ).provisionalRichCandidateEvidence = provisional.provisionalRichCandidateEvidence;
            }),
          ),
        ).toThrow();
        expect(() =>
          decodeSuccessfulReviewRunRecord(
            mutate((record) => {
              const final = record.steps.find((step) => step.id === "verify-technical-accuracy")!;
              const identity = final.inference!.attempts[0]!.identity!;
              (
                identity as unknown as { provisionalRichCandidateSha256: string }
              ).provisionalRichCandidateSha256 = "0".repeat(64);
            }),
          ),
        ).toThrow();
      } finally {
        await fixture.dispose();
      }

      const legacy = await runRichCandidateFixture(false);
      try {
        expect(legacy.saved.status).toBe("succeeded");
        expect(
          legacy.saved.steps.find((step) => step.id === "provisional-technical-verification")
            ?.provisionalRichCandidateEvidence,
        ).toBeUndefined();
        expect(decodeSuccessfulReviewRunRecord(legacy.saved).id).toBe(legacy.saved.id);
      } finally {
        await legacy.dispose();
      }
    },
    DELIVERY_RUN_RECORD_SUITE_TIMEOUT_MS,
  );
});
