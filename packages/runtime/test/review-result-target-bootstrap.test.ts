// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DurableArtifactStore, opaqueRecordDigest } from "../src/artifacts/store.js";
import { canonicalJson, sha256 } from "../src/content-ir/canonical.js";
import { limit } from "../src/config/limits.js";
import { changeSourceAcquiredOriginalBytes } from "../src/inputs/change-source/acquisition.js";
import { createChangeSource, type ChangeSourceSourceV1 } from "../src/inputs/change-source.js";
import { gitlabProjectIdentity } from "../src/inputs/change-source/revision.js";
import { digestGitlabMrReviewLocator } from "../src/inputs/gitlab-mr-locator.js";
import { decodeSuccessfulReviewRunRecord } from "../src/delivery/run-record.js";
import type { RunRecord } from "../src/records/contracts.js";
import { FileRunStore } from "../src/records/file-store.js";
import { reviewDeliverySnapshotDigest } from "../src/review-delivery/plan.js";
import {
  loadRetainedReviewResult,
  loadRetainedReviewTargetBootstrap,
  retainOriginalReviewResult,
} from "../src/review-delivery/result-store.js";
import { retainSourceSnapshotParts } from "../src/review-delivery/source-snapshot-store.js";
import {
  createReviewResult,
  createReviewResultV2Record,
  createReviewTarget,
  sealReviewTargetV2,
  type ReviewResultInputV4,
} from "../src/review/contracts.js";
import {
  createReviewResultV2,
  createReviewResultV6,
  createReviewTargetV2,
} from "../src/review/target-migration.js";
import {
  createWorkflowOutcome,
  decodeWorkflowOutcome,
  resealWorkflowOutcomeAfterRetainedReviewResult,
  workflowOutcomeStepEvidence,
} from "../src/workflow-contracts/outcome.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";
import { runRichCandidateFixture } from "./helpers/rich-candidate-run.js";

const BASE = "a".repeat(40);
const requestIdentitySha256 = sha256("historical host request identity");

type Fixture = Awaited<ReturnType<typeof makeFixture>>;
let fixture: Fixture;

async function makeFixture() {
  const runner = await runRichCandidateFixture();
  const head = runner.saved.repository.revision;
  const source = createChangeSource({
    source: {
      kind: "gitlab-merge-request",
      provenance: "forge-reported",
      host: "gitlab.example.test",
      projectPath: "team/docs",
      projectId: 42,
      iid: 7,
      state: "opened",
      mergeMode: null,
      diffRefs: { base: BASE, start: BASE, head },
      mergeCommit: null,
      squashCommit: null,
      fork: false,
    } as ChangeSourceSourceV1,
    revision: {
      schemaVersion: 1,
      kind: "docsfab-pinned-repository-revision",
      repository: gitlabProjectIdentity({ host: "gitlab.example.test", projectId: 42 }),
      base: BASE,
      head,
    },
    objectFormat: "sha1",
    rangeSemantics: "two-dot",
    mergeBase: null,
    diffFrom: BASE,
    baseTree: null,
    headTree: null,
    commits: [{ id: head, parents: [BASE], subject: "Review documentation" }],
    files: [],
    labels: [],
    protocol: { provider: "gitlab" },
  });
  const snapshot = { changeSourceSha256: source.changeSourceSha256, files: [] };
  const snapshotSha256 = reviewDeliverySnapshotDigest(snapshot, source);
  const root = await mkdtemp(join(tmpdir(), "docsfab-review-target-bootstrap-"));
  const artifactRoot = join(root, "artifacts");
  const artifacts = new DurableArtifactStore(artifactRoot);
  const manifestId = "manifest-observation";
  const diffId = "diff-observation";
  const parts = await retainSourceSnapshotParts(artifacts, {
    runId: runner.saved.id,
    sourceSha256: source.changeSourceSha256,
    repositoryIdentitySha256: source.revision.repository.identitySha256,
    reviewedHeadSha: head,
    snapshotSha256,
    manifest: { observationId: manifestId, bytes: new TextEncoder().encode(canonicalJson(source)) },
    diff: {
      observationId: diffId,
      bytes: changeSourceAcquiredOriginalBytes(new Uint8Array(0)),
    },
    rows: [],
  });
  const reference = {
    kind: "docsfab-review-delivery-snapshot-reference" as const,
    schemaVersion: 1 as const,
    runId: runner.saved.id,
    rootObjectSha256: parts.rootObjectSha256,
    snapshotSha256,
    changeSourceSha256: source.changeSourceSha256,
    reviewedHeadSha: head,
    repositoryIdentitySha256: source.revision.repository.identitySha256,
  };
  const citation = {
    schemaVersion: 1 as const,
    kind: "docsfab-run-change-source" as const,
    sourceKind: source.source.kind,
    provenance: "forge-reported" as const,
    repository: {
      kind: source.revision.repository.kind,
      identitySha256: source.revision.repository.identitySha256,
    },
    objectFormat: source.objectFormat,
    rangeSemantics: source.rangeSemantics,
    base: source.revision.base ?? null,
    head,
    mergeBase: source.mergeBase,
    diffFrom: source.diffFrom,
    labels: source.labels,
    fileCount: source.files.length,
    commitCount: source.commits.length,
    changeSourceSha256: source.changeSourceSha256,
    observations: [
      { role: "manifest" as const, observationId: manifestId },
      { role: "diff" as const, observationId: diffId },
    ],
  };
  const prestate = structuredClone(runner.saved);
  prestate.changeSources = [citation];
  prestate.reviewDeliverySnapshot = reference;
  const target = createReviewTargetV2(
    {
      scmProvider: "gitlab",
      host: "gitlab.example.test",
      projectId: 42,
      mergeRequestIid: 7,
      sourceFork: false,
      sourceBranch: "historical-topic",
      targetBranch: "main",
      baseSha: BASE,
      headSha: head,
      trigger: "api",
      requestIdentitySha256,
      workflow: "review-documentation",
      deliveryIntent: "comment-existing-mr",
      logicalRequestId: "historical-request:7",
      changeSourceSha256: source.changeSourceSha256,
    },
    source,
  );
  if (target.scmProvider !== "gitlab") throw new Error("Expected GitLab target fixture.");
  const resultInput: ReviewResultInputV4 = {
    taskId: "historical-review-task",
    runIdSha256: sha256(prestate.id),
    findings: [],
    checks: [{ id: "check:historical", name: "Historical review", status: "passed" }],
    unresolvedQuestions: [],
    affectedPaths: [],
    patchLocator: { kind: "artifact-digest", digestSha256: sha256("historical patch") },
    locatorSha256: digestGitlabMrReviewLocator({
      host: target.host,
      projectId: target.projectId,
      mergeRequestIid: target.mergeRequestIid,
    }),
    qualityReport: null,
    issues: [],
    sourceContexts: [],
  };
  const v4 = createReviewResultV2(target, source, resultInput);
  if (v4.schemaVersion !== 4) throw new Error("Expected a provider-original V4 result.");
  const {
    schemaVersion: _schemaVersion,
    kind: _kind,
    target: _target,
    targetSha256: _targetSha256,
    reviewedHeadSha: _reviewedHeadSha,
    resultSha256: _resultSha256,
    ...baseResult
  } = v4;
  const v6 = createReviewResultV6(target, source, {
    ...baseResult,
    issues: (v4.issues ?? []).map((issue) => ({
      ...issue,
      rich: { status: "unavailable", reason: "candidate-absent" },
    })),
    sourceContexts: v4.sourceContexts ?? [],
  } as never);
  const stores = [] as { runStore: FileRunStore; run: RunRecord; result: typeof v4 | typeof v6 }[];
  for (const [index, result] of [v4, v6].entries()) {
    const run = structuredClone(prestate);
    run.changeSources = [citation];
    run.reviewDeliverySnapshot = reference;
    const use = await retainOriginalReviewResult({ run, artifacts, result });
    run.workflowOutcome = resealWorkflowOutcomeAfterRetainedReviewResult({
      before: prestate,
      after: run,
      sourceReference: reference,
      resultUse: use,
    });
    const runStore = new FileRunStore(join(root, `state-${index}`));
    await runStore.save(run);
    stores.push({ runStore, run, result });
  }
  return {
    runner,
    root,
    artifacts,
    artifactRoot,
    source,
    snapshot,
    reference,
    target,
    prestate,
    resultInput,
    stores,
  };
}

function bindResultAddress(digest: string): RunRecord {
  const run = structuredClone(fixture.prestate);
  const step = run.steps.at(-1)!;
  const use = structuredClone(
    fixture.stores[0]!.run.steps.at(-1)!.artifacts!.find(
      (entry) => entry.reference.kind === "review-result",
    )!,
  );
  use.reference.digest = digest;
  step.artifacts ??= [];
  step.artifacts.push(use);
  run.artifacts ??= [];
  run.artifacts.push(use);
  run.workflowOutcome = resealWorkflowOutcomeAfterRetainedReviewResult({
    before: fixture.prestate,
    after: run,
    sourceReference: fixture.reference,
    resultUse: use,
  });
  return run;
}

async function variantStore(label: string, run: RunRecord): Promise<FileRunStore> {
  const store = new FileRunStore(join(fixture.root, label));
  await store.save(run);
  return store;
}

beforeAll(
  async () => {
    fixture = await makeFixture();
  },
  testTimeoutMs(limit("test.applicationExecutionTimeoutMs").value),
);

afterAll(async () => {
  if (fixture) {
    await fixture.runner.dispose();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

describe("retained original review target bootstrap", () => {
  it.each([4, 6] as const)(
    "recovers historical target and exact V%s result without caller target",
    async (version) => {
      const { runStore, run, result } = fixture.stores[version === 4 ? 0 : 1]!;
      const resultWrite = vi.spyOn(fixture.artifacts, "putRecord");
      const runWrite = vi.spyOn(runStore, "save");
      const loaded = await loadRetainedReviewTargetBootstrap({
        runStore,
        artifacts: fixture.artifacts,
        runId: run.id,
        readOnly: true,
      });
      expect(loaded.historicalTarget).toEqual(fixture.target);
      expect(loaded.historicalTarget).toMatchObject({
        requestIdentitySha256,
        logicalRequestId: "historical-request:7",
        trigger: "api",
        workflow: "review-documentation",
        deliveryIntent: "comment-existing-mr",
        sourceBranch: "historical-topic",
      });
      expect(loaded.originalResult.schemaVersion).toBe(version);
      expect(canonicalJson(loaded.originalResult)).toBe(canonicalJson(result));
      expect(loaded.resultObjectSha256).toBe(opaqueRecordDigest(result));
      expect(loaded.originalResultSha256).toBe(result.resultSha256);
      expect(loaded.sourceSha256).toBe(fixture.source.changeSourceSha256);
      expect(loaded.snapshotSha256).toBe(fixture.reference.snapshotSha256);
      expect(loaded.reviewedHeadSha).toBe(fixture.source.revision.head);
      expect(loaded.runRecordSha256).toBe((await runStore.getWithDigest(run.id)).sha256);
      const targetDependent = await loadRetainedReviewResult({
        runStore,
        artifacts: fixture.artifacts,
        runId: run.id,
        target: loaded.historicalTarget,
        readOnly: true,
      });
      expect(targetDependent.runRecordSha256).toBe(loaded.runRecordSha256);
      expect(canonicalJson(targetDependent.result)).toBe(canonicalJson(loaded.originalResult));
      expect(resultWrite).not.toHaveBeenCalled();
      expect(runWrite).not.toHaveBeenCalled();
      resultWrite.mockRestore();
      runWrite.mockRestore();
    },
  );

  it("refuses an addressed object containing another canonical original", async () => {
    const wrongAddress = sha256("another canonical address");
    await fixture.artifacts.putRecord(wrongAddress, fixture.stores[0]!.result);
    const run = bindResultAddress(wrongAddress);
    const runStore = await variantStore("wrong-address", run);
    await expect(
      loadRetainedReviewTargetBootstrap({ runStore, artifacts: fixture.artifacts, runId: run.id }),
    ).rejects.toMatchObject({ code: "result-object-address-mismatch" });
  });

  it("refuses altered sealed bytes, a legacy schema, and a different result run ID", async () => {
    const original = fixture.stores[0]!.result;
    const badSeal = { ...original, resultSha256: sha256("changed seal") };
    const legacyTarget = createReviewTarget({
      scmProvider: "gitlab",
      host: fixture.target.host,
      projectId: 42,
      mergeRequestIid: 7,
      sourceBranch: "historical-topic",
      targetBranch: "main",
      headSha: fixture.target.headSha,
      trigger: "api",
      requestIdentitySha256,
      workflow: "review-documentation",
      deliveryIntent: "comment-existing-mr",
      logicalRequestId: "historical-request:7",
    });
    const legacy = createReviewResult(legacyTarget, fixture.resultInput);
    const foreignRun = createReviewResultV2(fixture.target, fixture.source, {
      ...fixture.resultInput,
      runIdSha256: sha256("another run"),
    });
    for (const [label, result, reason] of [
      ["changed-seal", badSeal, "digest-mismatch"],
      ["legacy-schema", legacy, "provider-original-schema-required"],
      ["foreign-run", foreignRun, "result-source-binding-mismatch"],
    ] as const) {
      const digest = opaqueRecordDigest(result);
      await fixture.artifacts.putRecord(digest, result);
      const run = bindResultAddress(digest);
      const runStore = await variantStore(label, run);
      await expect(
        loadRetainedReviewTargetBootstrap({
          runStore,
          artifacts: fixture.artifacts,
          runId: run.id,
        }),
      ).rejects.toThrow(reason);
    }
  });

  it.each([
    ["project", { projectId: 43 }],
    ["base", { baseSha: "b".repeat(40) }],
    ["head", { headSha: "c".repeat(40) }],
    ["source", { changeSourceSha256: sha256("another source") }],
  ] as const)("refuses sealed provider target substitution: %s", async (label, change) => {
    if (fixture.target.scmProvider !== "gitlab") throw new Error("Expected GitLab target.");
    const {
      schemaVersion: _version,
      kind: _kind,
      targetSha256: _seal,
      ...targetInput
    } = fixture.target;
    const target = sealReviewTargetV2({ ...targetInput, ...change });
    if (target.scmProvider !== "gitlab") throw new Error("Expected GitLab target.");
    const result = createReviewResultV2Record(target, {
      ...fixture.resultInput,
      locatorSha256: digestGitlabMrReviewLocator({
        host: target.host,
        projectId: target.projectId,
        mergeRequestIid: target.mergeRequestIid,
      }),
    });
    const digest = opaqueRecordDigest(result);
    await fixture.artifacts.putRecord(digest, result);
    const run = bindResultAddress(digest);
    const runStore = await variantStore(`wrong-target-${label}`, run);
    await expect(
      loadRetainedReviewTargetBootstrap({
        runStore,
        artifacts: fixture.artifacts,
        runId: run.id,
      }),
    ).rejects.toThrow();
  });

  it("refuses absent, duplicate, or mismatched terminal and root result uses", async () => {
    const base = fixture.stores[0]!.run;
    const cases: readonly [string, (run: RunRecord) => void][] = [
      [
        "root-absent",
        (run) =>
          (run.artifacts = run.artifacts!.filter((use) => use.reference.kind !== "review-result")),
      ],
      ["root-duplicate", (run) => run.artifacts!.push(structuredClone(run.artifacts!.at(-1)!))],
      [
        "root-mismatch",
        (run) => {
          const use = run.artifacts!.find((entry) => entry.reference.kind === "review-result")!;
          use.reference.digest = sha256("wrong root use");
        },
      ],
      [
        "step-duplicate",
        (run) => {
          const step = run.steps.at(-1)!;
          step.artifacts!.push(structuredClone(step.artifacts!.at(-1)!));
        },
      ],
    ];
    for (const [label, mutate] of cases) {
      const run = structuredClone(base);
      mutate(run);
      const runStore = await variantStore(label, run);
      await expect(
        loadRetainedReviewTargetBootstrap({
          runStore,
          artifacts: fixture.artifacts,
          runId: run.id,
        }),
      ).rejects.toThrow();
    }
  });

  it("refuses a second result use on another step in a strictly admitted saved run", async () => {
    const run = structuredClone(fixture.stores[0]!.run);
    const earlier = run.steps.at(-2)!;
    const terminalUse = run.steps
      .at(-1)!
      .artifacts!.find((entry) => entry.reference.kind === "review-result")!;
    const extra = structuredClone(terminalUse);
    extra.stepId = earlier.id;
    extra.reference.digest = sha256("another step's result use");
    earlier.artifacts ??= [];
    earlier.artifacts.push(extra);
    const terminalIndex = run.artifacts!.findIndex((use) => use.reference.kind === "review-result");
    run.artifacts!.splice(terminalIndex, 0, extra);
    const prior = decodeWorkflowOutcome(
      fixture.stores[0]!.run.workflowOutcome,
      fixture.stores[0]!.run,
    );
    run.workflowOutcome = createWorkflowOutcome(
      {
        disposition: prior.disposition,
        findings: prior.findings,
        evidence: prior.evidence.map((item) =>
          item.kind === "step" ? workflowOutcomeStepEvidence(run, item.stepId) : item,
        ),
        limitations: prior.limitations,
        openDecisions: prior.openDecisions,
        producedArtifacts: [...prior.producedArtifacts, extra.reference],
      },
      run,
    );
    expect(decodeSuccessfulReviewRunRecord(run)).toBeDefined();
    const runStore = await variantStore("extra-step-result-use", run);
    await expect(
      loadRetainedReviewTargetBootstrap({ runStore, artifacts: fixture.artifacts, runId: run.id }),
    ).rejects.toThrow("result-reference-not-unique");
  });

  it("refuses a changed source root and a run changed between run and source reads", async () => {
    const rootRun = structuredClone(fixture.stores[0]!.run);
    rootRun.reviewDeliverySnapshot = {
      ...fixture.reference,
      rootObjectSha256: sha256("another root"),
    };
    const rootStore = await variantStore("wrong-source-root", rootRun);
    await expect(
      loadRetainedReviewTargetBootstrap({
        runStore: rootStore,
        artifacts: fixture.artifacts,
        runId: rootRun.id,
      }),
    ).rejects.toThrow();

    const run = structuredClone(fixture.stores[0]!.run);
    const changing = await variantStore("changed-during-read", run);
    const originalRead = changing.getWithDigest.bind(changing);
    let reads = 0;
    const read = vi.spyOn(changing, "getWithDigest").mockImplementation(async (...args) => {
      const saved = await originalRead(...args);
      if (++reads === 1) await changing.save({ ...run, instruction: "Changed after first read." });
      return saved;
    });
    try {
      await expect(
        loadRetainedReviewTargetBootstrap({
          runStore: changing,
          artifacts: fixture.artifacts,
          runId: run.id,
        }),
      ).rejects.toThrow("saved-run-record-mismatch");
    } finally {
      read.mockRestore();
    }
  });
});
