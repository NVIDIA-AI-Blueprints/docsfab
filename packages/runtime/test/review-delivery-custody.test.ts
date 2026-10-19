// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256, canonicalJson } from "../src/content-ir/canonical.js";
import { LIMIT_DEFINITION_BY_NAME } from "../src/config/limits.generated.js";
import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../src/json-evidence.js";
import {
  createChangeSource,
  type ChangeSourceSourceV1,
  type ChangeSourceV1,
} from "../src/inputs/change-source.js";
import { gitlabProjectIdentity } from "../src/inputs/change-source/revision.js";
import { digestGitlabMrReviewLocator } from "../src/inputs/gitlab-mr-locator.js";
import {
  createReviewResultV2,
  createReviewTargetV2,
  type ReviewResultInputV1,
} from "../src/review/index.js";
import { DurableArtifactStore } from "../src/artifacts/store.js";
import { FileRunStore } from "../src/records/file-store.js";
import type { RunRecord } from "../src/records/contracts.js";
import type { ReviewDeliveryPlan, ReviewDeliveryAction } from "../src/review-delivery/contracts.js";
import {
  createReviewDeliveryGrant,
  createReviewDeliveryPlan,
} from "../src/review-delivery/plan.js";
import {
  createReviewDeliveryManifest,
  createReviewDeliveryRecord,
  createReviewDeliveryImportRecord,
  assertReviewDeliveryRecordShape,
  reviewDeliveryImportedLineageMatches,
  reviewDeliveryRecordSha256,
  updateReviewDeliveryRecord,
} from "../src/review-delivery/receipt.js";
import {
  acknowledgeReviewDeliveryCustody,
  admitReviewDeliveryCustody,
  createLocalReviewDeliveryCustodyAdmission,
  createReviewDeliveryCustodyAdmission,
  createReviewDeliveryCorrelationAdmission,
  createReviewDeliveryOriginAdmission,
  exportReviewDeliveryCustody,
  importReviewDeliveryCustody,
  identifyReviewDeliveryCustodyStore,
} from "../src/review-delivery/custody.js";
import {
  executeReviewDelivery,
  reviewDeliveryEffectId,
  reviewDeliveryEffectNonce,
  reviewDeliveryOutboundBytesSha256,
  reviewDeliveryCurrentObservationSha256,
  reviewDeliveryBodySha256,
  type ReviewDeliveryEffectContextV1,
  type ReviewDeliveryPreparedEffect,
} from "../src/review-delivery/execute.js";
import {
  FileScmDeliveryReceiptStore,
  authorizeLocalUserPublication,
  createScmDeliveryRecord,
  localUserGitIdentitySha256,
  localUserPublicationPlanSha256,
  type LocalUserPublicationPlanV1,
} from "../src/delivery/index.js";
import { MAX_RECEIPT_BYTES } from "../src/delivery/receipt-store/worker-publication.js";
import { nestedDeadlineMs, testTimeoutMs } from "./helpers/test-timeouts.js";

const BASE = "a".repeat(40);
const START = "c".repeat(40);
const HEAD = "b".repeat(40);
const HASH = "d".repeat(64);
const AFTER = new TextEncoder().encode("after\n");
const roots: string[] = [];
const CHILD_REOPEN_TIMEOUT_MS = nestedDeadlineMs(30_000, 120_000);
const CUSTODY_TEST_TIMEOUT_MS = testTimeoutMs(120_000);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const created = await mkdtemp(join(tmpdir(), "review-delivery-custody-"));
  roots.push(created);
  return created;
}

async function fileSnapshot(directory: string): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  const visit = async (parent: string): Promise<void> => {
    for (const entry of await readdir(parent, { withFileTypes: true })) {
      const path = join(parent, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.set(relative(directory, path), await readFile(path));
    }
  };
  await visit(directory);
  return files;
}

function legacyPlan(): LocalUserPublicationPlanV1 {
  const candidate = {
    schemaVersion: 1,
    kind: "docsfab-local-user-gitlab-publication-plan",
    deliveryMode: "local-user",
    authorityBasis: "interactive-once",
    run: { id: "run-store", recordSha256: HASH },
    project: { id: 42, host: "gitlab.example.test", path: "group/docs" },
    remote: { name: "origin", transport: "ssh" },
    identity: {
      git: "configured",
      gitIdentitySha256: localUserGitIdentitySha256("Maintainer", "maintainer@example.test"),
      gitlabUsername: "maintainer",
    },
    baseRevision: BASE,
    targetBranch: { name: "main", protected: true },
    proposedSourceBranch: "docsfab-run/run-store",
    patch: { format: "git-diff", sha256: "b".repeat(64), byteLength: 10, changedFileCount: 1 },
    validationCommand: "npm run check",
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
  } as const;
  return { ...candidate, sha256: localUserPublicationPlanSha256(candidate as never) };
}

function planFixture(): ReviewDeliveryPlan<ChangeSourceV1> {
  const source = createChangeSource({
    source: {
      kind: "gitlab-merge-request",
      provenance: "forge-reported",
      host: "gitlab.example.com",
      projectPath: "team/docs",
      projectId: 42,
      iid: 7,
      state: "opened",
      mergeMode: null,
      diffRefs: { base: BASE, start: START, head: HEAD },
      mergeCommit: null,
      squashCommit: null,
      fork: true,
    } as ChangeSourceSourceV1,
    revision: {
      schemaVersion: 1,
      kind: "docsfab-pinned-repository-revision",
      repository: gitlabProjectIdentity({ host: "gitlab.example.com", projectId: 42 }),
      base: BASE,
      head: HEAD,
    },
    objectFormat: "sha1",
    rangeSemantics: "two-dot",
    mergeBase: null,
    diffFrom: BASE,
    baseTree: null,
    headTree: null,
    commits: [{ id: HEAD, parents: [BASE], subject: "Docs" }],
    files: [
      {
        status: "A",
        similarity: null,
        oldPath: null,
        newPath: "docs/guide.md",
        oldMode: null,
        newMode: null,
        oldBlob: null,
        newBlob: null,
        binary: false,
        added: 1,
        removed: 0,
      },
    ],
    labels: [],
    protocol: { provider: "gitlab" },
  });
  const target = createReviewTargetV2(
    {
      sourceBranch: "topic",
      targetBranch: "main",
      baseSha: BASE,
      headSha: HEAD,
      trigger: "api",
      requestIdentitySha256: HASH,
      workflow: "review-documentation",
      deliveryIntent: "comment-existing-mr",
      logicalRequestId: "request:7",
      changeSourceSha256: source.changeSourceSha256,
      scmProvider: "gitlab",
      host: "gitlab.example.com",
      projectId: 42,
      mergeRequestIid: 7,
      sourceFork: true,
    },
    source,
  );
  const actor = { host: target.host, id: "user:42" };
  const artifact = {
    kind: "retained-review-result" as const,
    id: "artifact:7",
    resultSha256: HASH,
  };
  const binding = {
    target,
    sourceSha256: source.changeSourceSha256,
    snapshotSha256: HASH,
    artifact,
    actor,
    reviewedHeadSha: HEAD,
    startSha: START,
  };
  const actionBody = { kind: "publish-summary" as const, binding, findingIds: [] };
  const action: ReviewDeliveryAction = { ...actionBody, id: sha256(canonicalJson(actionBody)) };
  return {
    kind: "docsfab-review-delivery-plan",
    schemaVersion: 1,
    target,
    source,
    result: { originalResultSha256: HASH, reviewedHeadSha: HEAD } as ReviewDeliveryPlan["result"],
    snapshotSha256: HASH,
    artifact,
    actor,
    capabilities: { scmProvider: "gitlab", host: target.host, summary: true, inline: true },
    findings: [],
    actions: [action],
    checks: [],
    unresolvedQuestions: [],
    affectedPaths: [],
    limitations: [],
  };
}

function retainedFixture(
  includeInline = false,
  requestedActions?: "overview" | "summary-only",
  empty = false,
  extraInline = false,
) {
  const base = planFixture();
  const resultInput: ReviewResultInputV1 = {
    taskId: "task:7",
    runIdSha256: HASH,
    findings: empty
      ? []
      : [
          {
            id: "finding:1",
            severity: "warning",
            code: "docs-gap",
            summary: "Explain the new value.",
            path: null,
          },
          ...(includeInline
            ? [
                {
                  id: "finding:2",
                  severity: "warning" as const,
                  code: "inline-gap",
                  summary: "Fix this line.",
                  path: "docs/guide.md",
                  line: 1,
                },
              ]
            : []),
          ...(extraInline
            ? [
                {
                  id: "finding:3",
                  severity: "warning" as const,
                  code: "other-inline-gap",
                  summary: "Keep this other line actionable.",
                  path: "docs/guide.md",
                  line: 1,
                },
              ]
            : []),
        ],
    checks: [],
    unresolvedQuestions: [],
    affectedPaths: ["docs/guide.md"],
    patchLocator: { kind: "artifact-digest", digestSha256: HASH },
    locatorSha256: digestGitlabMrReviewLocator({
      host: "gitlab.example.com",
      projectId: 42,
      mergeRequestIid: 7,
    }),
  };
  const result = createReviewResultV2(base.target, base.source, resultInput);
  const snapshot = {
    changeSourceSha256: base.source.changeSourceSha256,
    files: [
      {
        oldPath: null,
        newPath: "docs/guide.md",
        beforeBytes: null,
        afterBytes: Uint8Array.from(AFTER),
        beforeSha256: null,
        afterSha256: sha256(AFTER),
        state: "complete" as const,
        hunks: [
          { lines: [{ kind: "added" as const, text: "after", beforeLine: null, afterLine: 1 }] },
        ],
      },
    ],
  };
  const plan = createReviewDeliveryPlan({
    target: base.target,
    source: base.source,
    result,
    snapshot,
    artifact: {
      kind: "retained-review-result",
      id: "artifact:7",
      resultSha256: result.resultSha256,
    },
    actor: base.actor,
    capabilities: {
      scmProvider: "gitlab",
      host: base.target.host,
      summary: true,
      inline: includeInline || extraInline,
    },
    requestedActions,
  });
  return { plan, snapshot };
}

async function retainedTwoStore(
  includeInline = false,
  requestedActions?: "overview" | "summary-only",
  empty = false,
  extraInline = false,
) {
  const { plan, snapshot } = retainedFixture(includeInline, requestedActions, empty, extraInline);
  const sourceRoot = await root();
  const destinationRoot = await root();
  const retainedRoot = await root();
  const sourceBytesPath = join(retainedRoot, "docs-guide.bin");
  await writeFile(sourceBytesPath, AFTER);
  const source = new FileScmDeliveryReceiptStore(sourceRoot);
  const destination = new FileScmDeliveryReceiptStore(destinationRoot);
  const artifactStore = new DurableArtifactStore(join(retainedRoot, "artifacts"));
  await artifactStore.initialize();
  await artifactStore.putRecord(
    plan.result.originalResultSha256,
    JSON.parse(plan.result.originalResultCanonicalJson),
  );
  const runId = "review-run-1";
  const runStore = new FileRunStore(join(retainedRoot, "runs"));
  await runStore.save({
    schemaVersion: 2,
    id: runId,
    workflow: "review-documentation",
    repository: { sourcePath: "/fixture/repository", requestedRevision: "HEAD", revision: HEAD },
    workspace: { strategy: "tracked-export", disposable: true },
    status: "succeeded",
    createdAt: "2026-10-15T12:00:00.000Z",
    models: [],
    skills: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0 },
    tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
    artifacts: [
      {
        role: "output",
        reference: {
          kind: "ia-plan",
          schemaVersion: 1,
          digest: plan.result.originalResultSha256,
          repositoryRevision: HEAD,
          repositoryContentDigest: HASH,
        },
      },
    ],
  } as unknown as RunRecord);
  const runRecordSha256 = (await runStore.getWithDigest(runId, { readOnly: true })).sha256;
  const origin = {
    store: source,
    configuredReceiptRoot: sourceRoot,
    runStore,
    artifactStore,
    runId,
    artifactDigest: plan.result.originalResultSha256,
    artifactId: plan.artifact.id,
    originalResultSha256: plan.result.originalResultSha256,
    runRecordSha256,
    requestedActions,
    loadSnapshot: async () => {
      const bytes = Uint8Array.from(await readFile(sourceBytesPath));
      return {
        ...structuredClone(snapshot),
        files: snapshot.files.map((file) => ({ ...file, afterBytes: bytes })),
      };
    },
  };
  const admission = createLocalReviewDeliveryCustodyAdmission({
    configuredActor: plan.actor,
    origin,
    destination: { store: destination, configuredReceiptRoot: destinationRoot },
  });
  return {
    plan,
    source,
    destination,
    admission,
    origin,
    sourceRoot,
    destinationRoot,
    retainedRoot,
    sourceBytesPath,
  };
}

function grants(plan: ReviewDeliveryPlan<ChangeSourceV1>, accepted: () => boolean = () => true) {
  return new Map(
    plan.actions.map((action) => [
      action.id,
      createReviewDeliveryGrant({
        verifyCurrent(current) {
          if (!accepted() || current.id !== action.id) throw new Error("grant revoked");
          return { status: "admitted" as const, actionId: action.id, kind: action.kind };
        },
      }),
    ]),
  );
}

function currentRecovery(plan: ReviewDeliveryPlan<ChangeSourceV1>) {
  return {
    observeCurrent: vi.fn(async () => ({
      kind: "current" as const,
      target: plan.target,
      sourceSha256: plan.source.changeSourceSha256,
      snapshotSha256: plan.snapshotSha256,
      actor: plan.actor,
      headSha: HEAD,
      startSha: START,
    })),
    observeEffect: vi.fn(async () => ({
      kind: "unavailable" as const,
      effectId: HASH,
      reason: "none",
    })),
  };
}

function preparedNote(
  plan: ReviewDeliveryPlan<ChangeSourceV1>,
  context: ReviewDeliveryEffectContextV1,
) {
  const action = plan.actions[0]!;
  const coveredActionIds = [action.id];
  const effectId = reviewDeliveryEffectId(context, "gitlab-note", coveredActionIds);
  const body = `review body ${effectId}`;
  const request = {
    method: "POST" as const,
    path: "/projects/42/merge_requests/7/notes",
    bodyBytes: new TextEncoder().encode(
      JSON.stringify({ body, marker: reviewDeliveryEffectNonce(context, effectId) }),
    ),
  };
  return {
    kind: "effect" as const,
    effectId,
    coveredActionIds,
    actionPayloads: [
      { actionId: action.id, bodySha256: reviewDeliveryBodySha256(body), anchorSha256: null },
    ],
    stage: "gitlab-note" as const,
    request,
    outboundBytesSha256: reviewDeliveryOutboundBytesSha256(request),
    expectedBodySha256: reviewDeliveryBodySha256(body),
    expectedGitLabPosition: null,
    marker: reviewDeliveryEffectNonce(context, effectId),
    revisionProvenance: {
      kind: "gitlab-summary-retained" as const,
      intendedHeadSha: HEAD,
      freshTargetObservationSha256: reviewDeliveryCurrentObservationSha256({
        kind: "current",
        target: action.binding.target,
        sourceSha256: action.binding.sourceSha256,
        snapshotSha256: action.binding.snapshotSha256,
        actor: action.binding.actor,
        headSha: action.binding.reviewedHeadSha,
        startSha: action.binding.startSha,
      }),
      serverAtomicFence: false as const,
    },
  } satisfies ReviewDeliveryPreparedEffect;
}

function notePorts(plan: ReviewDeliveryPlan<ChangeSourceV1>, noteId = 9001) {
  const recovery = {
    observeCurrent: currentRecovery(plan).observeCurrent,
    observeEffect: vi.fn(
      async ({
        effect,
        phase,
        providerReference,
      }: {
        effect: ReviewDeliveryPreparedEffect;
        phase: string;
        providerReference: string | null;
      }) =>
        phase === "pre-dispatch-baseline"
          ? {
              kind: "absent-proven" as const,
              effectId: effect.effectId,
              completeForActorTargetAndEffect: true as const,
              enumerationSha256: HASH,
            }
          : {
              kind: "matching" as const,
              effectId: effect.effectId,
              providerReference: String(noteId),
              native: {
                kind: "gitlab-note" as const,
                projectId: 42,
                mergeRequestIid: 7,
                noteId,
                author: plan.actor,
                body: `review body ${effect.effectId}`,
              },
              actionReferences: effect.coveredActionIds.map((actionId) => ({
                actionId,
                nativeReference: String(noteId),
              })),
              discovery:
                providerReference === null
                  ? {
                      kind: "complete-enumeration" as const,
                      enumerationSha256: "e".repeat(64),
                      matchingCandidateCount: 1 as const,
                      directGetVerified: true as const,
                    }
                  : { kind: "direct-reference" as const },
              lifecycle: "final-published" as const,
            },
    ),
  };
  const effects = {
    prepareNextEffect: vi.fn(
      async ({
        context,
        priorObservations,
      }: {
        context: ReviewDeliveryEffectContextV1;
        priorObservations: readonly unknown[];
      }) =>
        priorObservations.length > 0 ? { kind: "complete" as const } : preparedNote(plan, context),
    ),
    publishEffect: vi.fn(async () => ({ kind: "confirmed" as const, providerReference: "9001" })),
  };
  return { recovery, effects };
}

function reopenedReceipt(receiptRoot: string, plan: ReviewDeliveryPlan) {
  const key = createReviewDeliveryManifest(plan).idempotencyKey;
  const script = `import { FileScmDeliveryReceiptStore } from './src/delivery/receipt-store.ts';
const store = new FileScmDeliveryReceiptStore(${JSON.stringify(receiptRoot)});
const record = await store.loadReview(${JSON.stringify(key)});
process.stdout.write(JSON.stringify(record === null || record === undefined ? null : {
  sha256: record.sha256,
  generation: record.generation,
  ownerStoreId: record.ownerStoreId,
  custody: record.custody,
  effects: record.effects.map(effect => ({ state: effect.state, providerReference: effect.providerReference }))
}));`;
  const child = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", script],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: CHILD_REOPEN_TIMEOUT_MS,
    },
  );
  expect(child.status, child.stderr).toBe(0);
  return JSON.parse(child.stdout) as {
    sha256: string;
    generation: number;
    ownerStoreId: string;
    custody: { state: string; transferId: string | null; otherStoreId: string | null };
    effects: { state: string; providerReference: string | null }[];
  } | null;
}

function coldActivate(
  fixture: Awaited<ReturnType<typeof retainedTwoStore>>,
  destination: "source" | "destination",
  replayConfirmed = false,
) {
  const config = {
    plan: fixture.plan,
    sourceRoot: fixture.sourceRoot,
    destinationRoot: fixture.destinationRoot,
    retainedRoot: fixture.retainedRoot,
    sourceBytesPath: fixture.sourceBytesPath,
    runId: fixture.origin.runId,
    runRecordSha256: fixture.origin.runRecordSha256,
    requestedActions: fixture.origin.requestedActions,
    destination,
    replayConfirmed,
  };
  const script = `
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256, canonicalJson } from './src/content-ir/canonical.ts';
import { DurableArtifactStore } from './src/artifacts/store.ts';
import { FileRunStore } from './src/records/file-store.ts';
import { FileScmDeliveryReceiptStore } from './src/delivery/receipt-store.ts';
import { createLocalReviewDeliveryCustodyAdmission } from './src/review-delivery/custody.ts';
import { createReviewDeliveryGrant } from './src/review-delivery/plan.ts';
import { executeReviewDelivery, reviewDeliveryEffectId, reviewDeliveryEffectNonce,
  reviewDeliveryOutboundBytesSha256, reviewDeliveryCurrentObservationSha256, reviewDeliveryBodySha256
} from './src/review-delivery/execute.ts';
const input = ${JSON.stringify(config)};
const source = new FileScmDeliveryReceiptStore(input.sourceRoot);
const destination = new FileScmDeliveryReceiptStore(input.destinationRoot);
const runStore = new FileRunStore(join(input.retainedRoot, 'runs'));
const artifactStore = new DurableArtifactStore(join(input.retainedRoot, 'artifacts'));
const admission = createLocalReviewDeliveryCustodyAdmission({
  configuredActor: input.plan.actor,
  origin: {
    store: source, configuredReceiptRoot: input.sourceRoot, runStore, artifactStore,
    runId: input.runId, artifactDigest: input.plan.result.originalResultSha256,
    artifactId: input.plan.artifact.id,
    originalResultSha256: input.plan.result.originalResultSha256,
    runRecordSha256: input.runRecordSha256,
    requestedActions: input.requestedActions,
    loadSnapshot: async ({ source: changeSource }) => {
      const afterBytes = Uint8Array.from(await readFile(input.sourceBytesPath));
      return { changeSourceSha256: changeSource.changeSourceSha256, files: [{
        oldPath: null, newPath: 'docs/guide.md', beforeBytes: null, afterBytes,
        beforeSha256: null, afterSha256: sha256(afterBytes), state: 'complete',
        hunks: [{ lines: [{ kind: 'added', text: 'after', beforeLine: null, afterLine: 1 }] }],
      }] };
    },
  },
  destination: { store: destination, configuredReceiptRoot: input.destinationRoot },
});
const grantsByActionId = new Map(input.plan.actions.map(action => [action.id,
  createReviewDeliveryGrant({ verifyCurrent: () => ({ status: 'admitted', actionId: action.id, kind: action.kind }) })
]));
const makeEffect = context => {
  const action = input.plan.actions[0];
  const coveredActionIds = [action.id];
  const effectId = reviewDeliveryEffectId(context, 'gitlab-note', coveredActionIds);
  const body = 'review body ' + effectId;
  const request = { method: 'POST', path: '/projects/42/merge_requests/7/notes',
    bodyBytes: new TextEncoder().encode(JSON.stringify({ body, marker: reviewDeliveryEffectNonce(context, effectId) })) };
  return { kind: 'effect', effectId, coveredActionIds,
    actionPayloads: [{ actionId: action.id, bodySha256: reviewDeliveryBodySha256(body), anchorSha256: null }],
    stage: 'gitlab-note', request, outboundBytesSha256: reviewDeliveryOutboundBytesSha256(request),
    expectedBodySha256: reviewDeliveryBodySha256(body), expectedGitLabPosition: null,
    marker: reviewDeliveryEffectNonce(context, effectId),
    revisionProvenance: { kind: 'gitlab-summary-retained', intendedHeadSha: action.binding.reviewedHeadSha,
      freshTargetObservationSha256: reviewDeliveryCurrentObservationSha256({
        kind: 'current', target: action.binding.target, sourceSha256: action.binding.sourceSha256,
        snapshotSha256: action.binding.snapshotSha256, actor: action.binding.actor,
        headSha: action.binding.reviewedHeadSha, startSha: action.binding.startSha,
      }), serverAtomicFence: false } };
};
const result = await executeReviewDelivery({
  plan: input.plan,
  store: input.destination === 'source' ? source : destination,
  originAdmission: admission,
  grantsByActionId,
  effects: {
    prepareNextEffect: async ({ context, priorObservations }) =>
      (input.destination === 'source' || input.replayConfirmed) && priorObservations.length === 0
        ? makeEffect(context) : { kind: 'complete' },
    publishEffect: async () => { throw new Error('Unexpected publication in cold activation.'); },
  },
  recovery: {
    observeCurrent: async binding => ({
      kind: 'current', target: binding.target, sourceSha256: binding.sourceSha256,
      snapshotSha256: binding.snapshotSha256, actor: binding.actor,
      headSha: binding.reviewedHeadSha, startSha: binding.startSha,
    }),
    observeEffect: async ({ effect }) => input.destination === 'source' || input.replayConfirmed
      ? { kind: 'matching', effectId: effect.effectId, providerReference: '9001',
          native: { kind: 'gitlab-note', projectId: 42, mergeRequestIid: 7,
            noteId: 9001, author: input.plan.actor, body: 'review body ' + effect.effectId },
          actionReferences: effect.coveredActionIds.map(actionId => ({ actionId, nativeReference: '9001' })),
          discovery: { kind: 'direct-reference' }, lifecycle: 'final-published' }
      : { kind: 'unavailable', effectId: effect.effectId, reason: 'unexpected' },
  },
});
process.stdout.write(JSON.stringify({ kind: result.kind, reason: result.kind === 'stopped' ? result.reason : null,
  state: result.record?.custody.state ?? null, generation: result.record?.generation ?? null }));
`;
  const child = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", script],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: CHILD_REOPEN_TIMEOUT_MS,
    },
  );
  expect(child.status, child.stderr).toBe(0);
  return JSON.parse(child.stdout) as {
    kind: string;
    reason: string | null;
    state: string | null;
    generation: number | null;
  };
}

describe("review-delivery custody transfer", () => {
  it(
    "publishes a host-requested empty overview once from an authentic retained result",
    async () => {
      const { plan, source, admission } = await retainedTwoStore(false, "overview", true);
      expect(plan).toMatchObject({ requestedActions: "overview", findings: [] });
      expect(plan.actions).toMatchObject([{ kind: "publish-summary", findingIds: [] }]);
      const ports = notePorts(plan);
      const denied = await executeReviewDelivery({
        plan,
        store: source,
        originAdmission: admission,
        grantsByActionId: new Map(),
        ...ports,
      });
      expect(denied).toMatchObject({ kind: "stopped", reason: "authority" });
      expect(ports.effects.publishEffect).not.toHaveBeenCalled();
      const first = await executeReviewDelivery({
        plan,
        store: source,
        originAdmission: admission,
        grantsByActionId: grants(plan),
        ...ports,
      });
      expect(first.kind).toBe("complete");
      expect(ports.effects.publishEffect).toHaveBeenCalledTimes(1);
      const retried = await executeReviewDelivery({
        plan,
        store: source,
        originAdmission: admission,
        grantsByActionId: grants(plan),
        ...ports,
      });
      expect(retried.kind).toBe("complete");
      expect(ports.effects.publishEffect).toHaveBeenCalledTimes(1);
    },
    CUSTODY_TEST_TIMEOUT_MS,
  );

  it("does not take requested overview authority from a submitted plan", async () => {
    const fixture = await retainedTwoStore(false, "overview");
    const unrequested = createLocalReviewDeliveryCustodyAdmission({
      configuredActor: fixture.plan.actor,
      origin: { ...fixture.origin, requestedActions: undefined },
      destination: {
        store: fixture.destination,
        configuredReceiptRoot: fixture.destinationRoot,
      },
    });
    const ports = notePorts(fixture.plan);
    expect(
      await executeReviewDelivery({
        plan: fixture.plan,
        store: fixture.source,
        originAdmission: unrequested,
        grantsByActionId: grants(fixture.plan),
        ...ports,
      }),
    ).toMatchObject({ kind: "stopped", reason: "custody" });
    expect(ports.effects.publishEffect).not.toHaveBeenCalled();
  });

  it("refuses a substituted summary-only plan under an overview admission", async () => {
    const fixture = await retainedTwoStore(true, "overview");
    const baseline = fixture.plan;
    const substituted = createReviewDeliveryPlan({
      target: baseline.target,
      source: baseline.source,
      result: JSON.parse(baseline.result.originalResultCanonicalJson) as never,
      snapshot: retainedFixture(true, "overview").snapshot,
      artifact: baseline.artifact,
      actor: baseline.actor,
      capabilities: baseline.capabilities,
      requestedActions: "summary-only",
    });
    const ports = notePorts(substituted);
    expect(
      await executeReviewDelivery({
        plan: substituted,
        store: fixture.source,
        originAdmission: fixture.admission,
        grantsByActionId: grants(substituted),
        ...ports,
      }),
    ).toMatchObject({ kind: "stopped", reason: "custody" });
    expect(ports.effects.publishEffect).not.toHaveBeenCalled();
    expect(
      await fixture.source.loadReview(createReviewDeliveryManifest(substituted).idempotencyKey),
    ).toBeUndefined();
  });

  it(
    "publishes an explicit GitLab overview beside an unchanged inert legacy empty alias",
    async () => {
      const fixture = await retainedTwoStore(false, "overview", true);
      const { plan, source, admission } = fixture;
      const legacy = createReviewDeliveryPlan({
        target: plan.target,
        source: plan.source,
        result: JSON.parse(plan.result.originalResultCanonicalJson) as never,
        snapshot: retainedFixture(false, "overview", true).snapshot,
        artifact: plan.artifact,
        actor: plan.actor,
        capabilities: plan.capabilities,
      });
      expect(legacy.actions).toEqual([]);
      const oldManifest = createReviewDeliveryManifest(legacy);
      expect(oldManifest.idempotencyKey).not.toBe(
        createReviewDeliveryManifest(plan).idempotencyKey,
      );
      const defaultAdmission = createLocalReviewDeliveryCustodyAdmission({
        configuredActor: plan.actor,
        origin: { ...fixture.origin, requestedActions: undefined },
        destination: {
          store: fixture.destination,
          configuredReceiptRoot: fixture.destinationRoot,
        },
      });
      const oldPorts = {
        effects: {
          prepareNextEffect: vi.fn(async () => ({ kind: "complete" as const })),
          publishEffect: vi.fn(),
        },
        recovery: currentRecovery(legacy),
      };
      expect(
        (
          await executeReviewDelivery({
            plan: legacy,
            store: source,
            originAdmission: defaultAdmission,
            grantsByActionId: grants(legacy),
            ...oldPorts,
          })
        ).kind,
      ).toBe("complete");
      const oldRecord = await source.loadReview(oldManifest.idempotencyKey);
      if (!oldRecord) throw new Error("Historical empty receipt missing.");
      const oldBytes = await fileSnapshot(fixture.sourceRoot);
      const ports = notePorts(plan);
      const concurrentLegacyPorts = {
        effects: {
          prepareNextEffect: vi.fn(async () => ({ kind: "complete" as const })),
          publishEffect: vi.fn(),
        },
        recovery: currentRecovery(legacy),
      };
      let concurrentLegacy: ReturnType<typeof executeReviewDelivery> | undefined;
      ports.effects.publishEffect.mockImplementation(async () => {
        concurrentLegacy = executeReviewDelivery({
          plan: legacy,
          store: source,
          originAdmission: defaultAdmission,
          grantsByActionId: grants(legacy),
          ...concurrentLegacyPorts,
        });
        return { kind: "confirmed", providerReference: "9001" };
      });
      const result = await executeReviewDelivery({
        plan,
        store: source,
        originAdmission: admission,
        grantsByActionId: grants(plan),
        ...ports,
      });
      expect(result.kind).toBe("complete");
      expect(ports.effects.publishEffect).toHaveBeenCalledTimes(1);
      expect((await concurrentLegacy)?.kind).toBe("complete");
      expect(concurrentLegacyPorts.effects.prepareNextEffect).not.toHaveBeenCalled();
      expect(concurrentLegacyPorts.effects.publishEffect).not.toHaveBeenCalled();
      expect(oldPorts.effects.publishEffect).not.toHaveBeenCalled();
      expect(await source.loadReview(oldManifest.idempotencyKey)).toEqual(oldRecord);
      const afterBytes = await fileSnapshot(fixture.sourceRoot);
      for (const [path, bytes] of oldBytes) expect(afterBytes.get(path)).toEqual(bytes);
      expect(
        (
          await executeReviewDelivery({
            plan: legacy,
            store: source,
            originAdmission: defaultAdmission,
            grantsByActionId: grants(legacy),
            ...oldPorts,
          })
        ).kind,
      ).toBe("complete");
      expect(oldPorts.effects.publishEffect).not.toHaveBeenCalled();
      expect(await source.loadReview(oldManifest.idempotencyKey)).toEqual(oldRecord);
    },
    CUSTODY_TEST_TIMEOUT_MS,
  );

  it(
    "publishes summary-only after importing custody and completes a cold retry without another POST",
    async () => {
      const fixture = await retainedTwoStore(true, "summary-only");
      const { plan, source, destination, admission } = fixture;
      expect(plan.actions).toMatchObject([{ kind: "publish-summary" }]);
      expect(plan.actions).toHaveLength(1);
      expect(plan.findings.some((finding) => finding.disposition.kind === "inline-candidate")).toBe(
        false,
      );
      const noEffect = {
        prepareNextEffect: vi.fn(async () => ({ kind: "complete" as const })),
        publishEffect: vi.fn(),
      };
      await executeReviewDelivery({
        plan,
        store: source,
        originAdmission: admission,
        grantsByActionId: grants(plan),
        effects: noEffect,
        recovery: currentRecovery(plan),
      });
      const exported = await exportReviewDeliveryCustody({
        plan,
        store: source,
        destinationStore: destination,
        custodyAdmission: admission,
      });
      if (exported.kind !== "fenced") throw new Error("Expected source fence.");
      expect(
        await importReviewDeliveryCustody({
          plan,
          store: destination,
          custodyAdmission: admission,
          pointer: exported.pointer,
        }),
      ).toMatchObject({ kind: "import-pending" });
      const ports = notePorts(plan);
      const delivered = await executeReviewDelivery({
        plan,
        store: destination,
        originAdmission: admission,
        grantsByActionId: grants(plan),
        ...ports,
      });
      expect(delivered.kind).toBe("complete");
      expect(ports.effects.publishEffect).toHaveBeenCalledTimes(1);
      // Explicit mode rechecks the retained confirmed effect in the cold process.
      expect(coldActivate(fixture, "destination", true)).toMatchObject({
        kind: "complete",
        state: "active",
        generation: 1,
      });
      expect(ports.effects.publishEffect).toHaveBeenCalledTimes(1);
    },
    CUSTODY_TEST_TIMEOUT_MS,
  );

  it("keeps the captured overview request after its input object is mutated", async () => {
    const fixture = await retainedTwoStore(false, "overview", true);
    fixture.origin.requestedActions = "summary-only";
    const ports = notePorts(fixture.plan);
    expect(
      (
        await executeReviewDelivery({
          plan: fixture.plan,
          store: fixture.source,
          originAdmission: fixture.admission,
          grantsByActionId: grants(fixture.plan),
          ...ports,
        })
      ).kind,
    ).toBe("complete");
    expect(ports.effects.publishEffect).toHaveBeenCalledTimes(1);
  });

  it("keeps a locator-limited retained finding out of summary-only publication", async () => {
    const fixture = await retainedTwoStore(true, "summary-only");
    const { plan: baseline, source, admission } = fixture;
    const plan = createReviewDeliveryPlan({
      target: baseline.target,
      source: baseline.source,
      result: JSON.parse(baseline.result.originalResultCanonicalJson) as never,
      snapshot: retainedFixture(true, "summary-only").snapshot,
      artifact: baseline.artifact,
      actor: baseline.actor,
      capabilities: baseline.capabilities,
      requestedActions: "summary-only",
      locatorEvidence: { kind: "unavailable", reason: "read-unobserved" },
      extensions: {
        presentation: {
          select: (finding) => (finding.originalId === "finding:2" ? "retained" : "inline"),
        },
      },
    });
    expect(plan.findings[1]).toMatchObject({
      limitations: ["legacy-finding-lineage-unavailable", "review-locator:read-unobserved"],
      disposition: { kind: "unsupported", reason: "presentation-unsupported" },
    });
    expect(plan.actions).toMatchObject([
      { kind: "publish-summary", findingIds: ["finding:0:finding:1"] },
    ]);
    const ports = notePorts(plan);
    expect(
      (
        await executeReviewDelivery({
          plan,
          store: source,
          originAdmission: admission,
          grantsByActionId: grants(plan),
          ...ports,
        })
      ).kind,
    ).toBe("complete");
    expect(ports.effects.publishEffect).toHaveBeenCalledTimes(1);
  });

  it("admits a selected inline-to-unsupported fallback without losing another inline action", async () => {
    const fixture = await retainedTwoStore(true, undefined, false, true);
    const { plan: baseline, source, admission } = fixture;
    const result = JSON.parse(baseline.result.originalResultCanonicalJson) as never;
    const snapshot = await fixture.origin.loadSnapshot();
    const makePlan = (summary: boolean, selection: "summary" | "retained") =>
      createReviewDeliveryPlan({
        target: baseline.target,
        source: baseline.source,
        result,
        snapshot,
        artifact: baseline.artifact,
        actor: baseline.actor,
        capabilities: { ...baseline.capabilities, summary },
        extensions: {
          presentation: {
            select: (finding) => (finding.originalId === "finding:2" ? selection : "inline"),
          },
        },
      });
    const decision = (plan: ReviewDeliveryPlan) =>
      admitReviewDeliveryCustody(admission, {
        plan,
        manifest: createReviewDeliveryManifest(plan),
        requestedStore: source,
        phase: "execute",
        expectedGeneration: null,
        transferId: null,
        sourceStoreId: null,
        sourceGeneration: null,
        destinationStoreId: null,
        fencedRecordSha256: null,
      });
    const selected = makePlan(false, "summary");
    const selectedFallback = selected.findings.find(
      (finding) => finding.originalId === "finding:2",
    );
    const selectedOtherInline = selected.findings.find(
      (finding) => finding.originalId === "finding:3",
    );
    if (!selectedFallback || !selectedOtherInline)
      throw new Error("Expected both retained inline findings in the planner result.");
    expect(selectedFallback.disposition).toEqual({
      kind: "unsupported",
      reason: "provider-unsupported",
    });
    expect(selectedOtherInline.disposition.kind).toBe("inline-candidate");
    expect(selected.actions).toMatchObject([
      { kind: "publish-inline", findingId: selectedOtherInline.inventoryId },
    ]);
    expect(await decision(selected)).toMatchObject({ status: "admitted" });

    const malformed = {
      ...selected,
      findings: selected.findings.map((finding) =>
        finding.originalId === "finding:2"
          ? {
              ...finding,
              disposition: {
                kind: "unsupported",
                reason: "presentation-unsupported-fake",
              } as never,
            }
          : finding,
      ),
    };
    expect(await decision(malformed)).toEqual({ status: "blocked" });

    const supported = makePlan(true, "retained");
    const forged = {
      ...supported,
      findings: supported.findings.map((finding) =>
        finding.originalId === "finding:2"
          ? {
              ...finding,
              disposition: {
                kind: "unsupported" as const,
                reason: "provider-unsupported" as const,
              },
            }
          : finding,
      ),
    };
    expect(await decision(forged)).toEqual({ status: "blocked" });
    expect(await decision(supported)).toMatchObject({ status: "admitted" });
  });

  it.each(["foreign", "fenced"] as const)(
    "refuses a %s historical empty alias without claiming the explicit effect",
    async (caseName) => {
      const fixture = await retainedTwoStore(false, "overview", true);
      const { plan, source, admission } = fixture;
      const legacy = createReviewDeliveryPlan({
        target: plan.target,
        source: plan.source,
        result: JSON.parse(plan.result.originalResultCanonicalJson) as never,
        snapshot: retainedFixture(false, "overview", true).snapshot,
        artifact: plan.artifact,
        actor: plan.actor,
        capabilities: plan.capabilities,
      });
      const oldManifest = createReviewDeliveryManifest(legacy);
      const ownerId = identifyReviewDeliveryCustodyStore(admission, source);
      const destinationId = identifyReviewDeliveryCustodyStore(admission, fixture.destination);
      if (!ownerId || !destinationId) throw new Error("Configured store identity missing.");
      const initial = createReviewDeliveryRecord(
        oldManifest,
        caseName === "foreign" ? "e".repeat(64) : ownerId,
        randomBytes(32).toString("base64url"),
      );
      await source.claimReview(initial, () => undefined);
      if (caseName === "fenced") {
        const fenced = updateReviewDeliveryRecord(initial, {
          custody: {
            state: "fenced-out",
            transferId: "transfer:legacy",
            otherStoreId: destinationId,
          },
        });
        await source.compareAndSwapReview!(initial.sha256, fenced, () => undefined);
      }
      const ports = notePorts(plan);
      expect(
        await executeReviewDelivery({
          plan,
          store: source,
          originAdmission: admission,
          grantsByActionId: grants(plan),
          ...ports,
        }),
      ).toMatchObject({ kind: "stopped", reason: "custody" });
      expect(ports.effects.publishEffect).not.toHaveBeenCalled();
      expect(
        await source.loadReview(createReviewDeliveryManifest(plan).idempotencyKey),
      ).toBeUndefined();
    },
    CUSTODY_TEST_TIMEOUT_MS,
  );

  it(
    "rechecks a current-key winner that appears after the initial empty observation",
    async () => {
      const fixture = await retainedTwoStore(false, "overview", true);
      const { plan, source, admission } = fixture;
      const summary = plan.actions[0];
      if (summary?.kind !== "publish-summary") throw new Error("Expected empty overview.");
      const conflictingBody = {
        kind: "publish-summary" as const,
        binding: summary.binding,
        findingIds: ["forged:coverage"],
      };
      const conflictingAction = {
        ...conflictingBody,
        id: sha256(canonicalJson(conflictingBody)),
      };
      const currentManifest = createReviewDeliveryManifest(plan);
      const conflictingManifest = createReviewDeliveryManifest({
        ...plan,
        actions: [conflictingAction],
      });
      expect(conflictingManifest.idempotencyKey).toBe(currentManifest.idempotencyKey);
      expect(conflictingManifest.manifestSha256).not.toBe(currentManifest.manifestSha256);
      const ownerId = identifyReviewDeliveryCustodyStore(admission, source);
      if (!ownerId) throw new Error("Configured origin identity missing.");
      const originalLease = source.withReviewDeliveryLease.bind(source);
      let winnerClaimed = false;
      vi.spyOn(source, "withReviewDeliveryLease").mockImplementation(
        async (key, authorized, action) => {
          if (key !== currentManifest.idempotencyKey && !winnerClaimed) {
            winnerClaimed = true;
            await source.claimReview(
              createReviewDeliveryRecord(
                conflictingManifest,
                ownerId,
                randomBytes(32).toString("base64url"),
              ),
              () => undefined,
            );
          }
          return originalLease(key, authorized, action);
        },
      );
      const ports = notePorts(plan);
      expect(
        await executeReviewDelivery({
          plan,
          store: source,
          originAdmission: admission,
          grantsByActionId: grants(plan),
          ...ports,
        }),
      ).toMatchObject({ kind: "stopped", reason: "custody" });
      expect(winnerClaimed).toBe(true);
      expect(ports.effects.publishEffect).not.toHaveBeenCalled();
      expect((await source.loadReview(currentManifest.idempotencyKey))?.manifest).toEqual(
        conflictingManifest,
      );
    },
    CUSTODY_TEST_TIMEOUT_MS,
  );

  it("requires an active imported receipt to retain its configured source link", () => {
    const initial = createReviewDeliveryRecord(
      createReviewDeliveryManifest(planFixture()),
      HASH,
      randomBytes(32).toString("base64url"),
    );
    const other = "e".repeat(64);
    const fenced = updateReviewDeliveryRecord(initial, {
      custody: { state: "fenced-out", transferId: "transfer:1", otherStoreId: other },
    });
    const pending = createReviewDeliveryImportRecord(fenced, other);
    const { sha256: _old, ...body } = pending;
    const missingLink = {
      ...body,
      custody: { state: "active" as const, transferId: "transfer:1", otherStoreId: null },
    };
    expect(() =>
      assertReviewDeliveryRecordShape({
        ...missingLink,
        sha256: reviewDeliveryRecordSha256(missingLink),
      }),
    ).toThrow(/invalid-record/);
  });

  it("binds every import-pending recovery field to the fenced source", () => {
    const plan = planFixture();
    const manifest = createReviewDeliveryManifest(plan);
    const initial = createReviewDeliveryRecord(
      manifest,
      HASH,
      randomBytes(32).toString("base64url"),
    );
    const prepared = preparedNote(plan, initial.context);
    const descriptor = {
      effectId: prepared.effectId,
      stage: prepared.stage,
      coveredActionIds: prepared.coveredActionIds,
      actionPayloads: prepared.actionPayloads,
      outboundBytesSha256: prepared.outboundBytesSha256,
      expectedBodySha256: prepared.expectedBodySha256,
      expectedGitLabPositionSha256: null,
      marker: prepared.marker,
    };
    const baseline = {
      scopeSha256: sha256(
        canonicalizeJsonEvidence({
          target: manifest.target,
          actor: manifest.actor,
          effectId: descriptor.effectId,
          marker: descriptor.marker,
        } as unknown as JsonEvidenceValue),
      ),
      enumerationSha256: HASH,
      bodySha256: descriptor.expectedBodySha256,
    };
    const effect = {
      ...descriptor,
      state: "uncertain" as const,
      attemptId: "attempt:1",
      providerReference: null,
      observationSha256: null,
      actionReferences: [],
      baseline,
      stop: { code: "rate-limited" as const, retryAfterAt: "2026-10-15T13:00:00.000Z" },
    };
    const { sha256: _initialSha, ...sourceBody } = {
      ...initial,
      context: { ...initial.context, committedEffects: [descriptor] },
      effects: [effect],
      preparationStop: {
        actionId: initial.manifest.actions[0]?.actionId ?? null,
        code: "position-unprovable" as const,
        next: "replan-required" as const,
        retryAfterAt: null,
      },
    };
    const stopped = assertReviewDeliveryRecordShape({
      ...sourceBody,
      sha256: reviewDeliveryRecordSha256(sourceBody),
    });
    const other = "e".repeat(64);
    const fenced = updateReviewDeliveryRecord(stopped, {
      custody: { state: "fenced-out", transferId: "transfer:1", otherStoreId: other },
    });
    const pending = createReviewDeliveryImportRecord(fenced, other);
    expect(reviewDeliveryImportedLineageMatches(fenced, pending)).toBe(true);
    const rehash = (changes: Partial<typeof pending>) => {
      const { sha256: _old, ...body } = { ...pending, ...changes };
      return assertReviewDeliveryRecordShape({
        ...body,
        sha256: reviewDeliveryRecordSha256(body),
      });
    };
    const altered = [
      rehash({ preparationStop: null }),
      rehash({ effects: [{ ...effect, baseline: null }] }),
      rehash({ effects: [{ ...effect, stop: { code: "transport-failure", retryAfterAt: null } }] }),
    ];
    for (const candidate of altered)
      expect(reviewDeliveryImportedLineageMatches(fenced, candidate)).toBe(false);
    const settled = rehash({
      effects: [
        {
          ...effect,
          state: "confirmed",
          providerReference: "9001",
          observationSha256: HASH,
          actionReferences: [{ actionId: manifest.actions[0]!.actionId, nativeReference: "9001" }],
          stop: null,
        },
      ],
    });
    expect(reviewDeliveryImportedLineageMatches(fenced, settled)).toBe(true);
  });

  it(
    "refuses a conflicting destination import slot even with the authentic fence pointer",
    async () => {
      const fixture = await retainedTwoStore();
      const { plan, source, destination, admission } = fixture;
      const noEffect = {
        prepareNextEffect: vi.fn(async () => ({ kind: "complete" as const })),
        publishEffect: vi.fn(async () => ({
          kind: "confirmed" as const,
          providerReference: "9001",
        })),
      };
      await executeReviewDelivery({
        plan,
        store: source,
        originAdmission: admission,
        grantsByActionId: grants(plan),
        effects: noEffect,
        recovery: currentRecovery(plan),
      });
      const exported = await exportReviewDeliveryCustody({
        plan,
        store: source,
        destinationStore: destination,
        custodyAdmission: admission,
      });
      if (exported.kind !== "fenced") throw new Error("Expected A fence.");
      const expected = createReviewDeliveryImportRecord(
        exported.record,
        exported.pointer.destinationStoreId,
      );
      const { sha256: _sha, ...body } = expected;
      const foreignBody = {
        ...body,
        context: { ...body.context, correlationSeed: randomBytes(32).toString("base64url") },
      };
      const foreign = assertReviewDeliveryRecordShape({
        ...foreignBody,
        sha256: reviewDeliveryRecordSha256(foreignBody),
      });
      expect((await destination.claimReviewImport!(foreign, () => undefined)).created).toBe(true);
      expect(
        await importReviewDeliveryCustody({
          plan,
          store: destination,
          custodyAdmission: admission,
          pointer: exported.pointer,
        }),
      ).toMatchObject({ kind: "stopped", reason: "custody" });
      expect(noEffect.publishEffect).not.toHaveBeenCalled();
    },
    CUSTODY_TEST_TIMEOUT_MS,
  );

  it(
    "refuses a claimed import slot that cleared a fenced preparation stop",
    async () => {
      const { plan, source, destination, admission } = await retainedTwoStore();
      const manifest = createReviewDeliveryManifest(plan);
      await executeReviewDelivery({
        plan,
        store: source,
        originAdmission: admission,
        grantsByActionId: grants(plan),
        effects: {
          prepareNextEffect: vi.fn(async () => ({ kind: "complete" as const })),
          publishEffect: vi.fn(),
        },
        recovery: currentRecovery(plan),
      });
      const active = await source.loadReview(manifest.idempotencyKey);
      if (!active) throw new Error("Initial source receipt missing.");
      const stopped = updateReviewDeliveryRecord(active, {
        preparationStop: {
          actionId: plan.actions[0]?.id ?? null,
          code: "position-unprovable",
          next: "replan-required",
          retryAfterAt: null,
        },
      });
      await source.compareAndSwapReview!(active.sha256, stopped, () => undefined);
      const exported = await exportReviewDeliveryCustody({
        plan,
        store: source,
        destinationStore: destination,
        custodyAdmission: admission,
      });
      if (exported.kind !== "fenced") throw new Error("Expected durable source fence.");
      const pending = createReviewDeliveryImportRecord(
        exported.record,
        exported.pointer.destinationStoreId,
      );
      const { sha256: _old, ...body } = { ...pending, preparationStop: null };
      const cleared = assertReviewDeliveryRecordShape({
        ...body,
        sha256: reviewDeliveryRecordSha256(body),
      });
      expect((await destination.claimReviewImport!(cleared, () => undefined)).created).toBe(true);
      expect(
        await importReviewDeliveryCustody({
          plan,
          store: destination,
          custodyAdmission: admission,
          pointer: exported.pointer,
        }),
      ).toMatchObject({ kind: "stopped", reason: "custody" });
      expect((await destination.loadReview(manifest.idempotencyKey))?.custody.state).toBe(
        "import-pending",
      );
    },
    CUSTODY_TEST_TIMEOUT_MS,
  );

  it(
    "reports missing destination journal capabilities without fencing or adopting a slot",
    async () => {
      const { plan, source, destination, admission } = await retainedTwoStore();
      const manifest = createReviewDeliveryManifest(plan);
      const noEffect = {
        prepareNextEffect: vi.fn(async () => ({ kind: "complete" as const })),
        publishEffect: vi.fn(),
      };
      await executeReviewDelivery({
        plan,
        store: source,
        originAdmission: admission,
        grantsByActionId: grants(plan),
        effects: noEffect,
        recovery: currentRecovery(plan),
      });
      const transfer = () =>
        exportReviewDeliveryCustody({
          plan,
          store: source,
          destinationStore: destination,
          custodyAdmission: admission,
        });
      const originalLoad = destination.loadReview;
      const originalClaim = destination.claimReviewImport;
      Object.defineProperty(destination, "loadReview", { value: undefined, configurable: true });
      expect(await transfer()).toMatchObject({ kind: "stopped", reason: "store-uncertain" });
      Object.defineProperty(destination, "loadReview", {
        value: originalLoad,
        configurable: true,
      });
      Object.defineProperty(destination, "claimReviewImport", {
        value: undefined,
        configurable: true,
      });
      expect(await transfer()).toMatchObject({ kind: "stopped", reason: "store-uncertain" });
      expect((await source.loadReview(manifest.idempotencyKey))?.custody.state).toBe("active");
      Object.defineProperty(destination, "claimReviewImport", {
        value: originalClaim,
        configurable: true,
      });
      const exported = await transfer();
      if (exported.kind !== "fenced") throw new Error("Expected durable source fence.");
      Object.defineProperty(destination, "claimReviewImport", {
        value: undefined,
        configurable: true,
      });
      expect(
        await importReviewDeliveryCustody({
          plan,
          store: destination,
          custodyAdmission: admission,
          pointer: exported.pointer,
        }),
      ).toMatchObject({ kind: "stopped", reason: "store-uncertain" });
      expect(await destination.loadReview(manifest.idempotencyKey)).toBeUndefined();
      Object.defineProperty(destination, "claimReviewImport", {
        value: originalClaim,
        configurable: true,
      });
      expect(
        await importReviewDeliveryCustody({
          plan,
          store: destination,
          custodyAdmission: admission,
          pointer: exported.pointer,
        }),
      ).toMatchObject({ kind: "import-pending" });
      await executeReviewDelivery({
        plan,
        store: destination,
        originAdmission: admission,
        grantsByActionId: grants(plan),
        effects: noEffect,
        recovery: currentRecovery(plan),
      });
      Object.defineProperty(destination, "loadReview", { value: undefined, configurable: true });
      expect(
        await acknowledgeReviewDeliveryCustody({
          plan,
          store: source,
          destinationStore: destination,
          custodyAdmission: admission,
          pointer: exported.pointer,
        }),
      ).toMatchObject({ kind: "stopped", reason: "store-uncertain" });
      expect((await source.loadReview(manifest.idempotencyKey))?.custody.state).toBe("fenced-out");
      Object.defineProperty(destination, "loadReview", {
        value: originalLoad,
        configurable: true,
      });
      expect(
        await acknowledgeReviewDeliveryCustody({
          plan,
          store: source,
          destinationStore: destination,
          custodyAdmission: admission,
          pointer: exported.pointer,
        }),
      ).toMatchObject({ kind: "transferred" });
      expect(noEffect.publishEffect).not.toHaveBeenCalled();
    },
    CUSTODY_TEST_TIMEOUT_MS,
  );

  it(
    "carries a receipt-lost accepted intent through B→A and settles native readback without another POST",
    async () => {
      const fixture = await retainedTwoStore();
      const { plan, source, destination, admission } = fixture;
      const noEffect = {
        prepareNextEffect: vi.fn(async () => ({ kind: "complete" as const })),
        publishEffect: vi.fn(async () => ({
          kind: "confirmed" as const,
          providerReference: "9001",
        })),
      };
      await executeReviewDelivery({
        plan,
        store: source,
        originAdmission: admission,
        grantsByActionId: grants(plan),
        effects: noEffect,
        recovery: currentRecovery(plan),
      });
      const outbound = await exportReviewDeliveryCustody({
        plan,
        store: source,
        destinationStore: destination,
        custodyAdmission: admission,
      });
      if (outbound.kind !== "fenced") throw new Error("Expected A fence.");
      expect(
        (
          await importReviewDeliveryCustody({
            plan,
            store: destination,
            custodyAdmission: admission,
            pointer: outbound.pointer,
          })
        ).kind,
      ).toBe("import-pending");
      expect(coldActivate(fixture, "destination")).toMatchObject({ state: "active" });
      const durableCas = destination.compareAndSwapReview!.bind(destination);
      const failPostCall = vi
        .spyOn(destination, "compareAndSwapReview")
        .mockImplementation(async (expected, next, authorize) => {
          if (next.effects.some((effect) => effect.state === "uncertain"))
            throw new Error("post-call receipt persistence failed");
          return durableCas(expected, next, authorize);
        });
      const attempted = notePorts(plan);
      const accepted = await executeReviewDelivery({
        plan,
        store: destination,
        originAdmission: admission,
        grantsByActionId: grants(plan),
        ...attempted,
      });
      expect(accepted).toMatchObject({ kind: "stopped", reason: "store-uncertain" });
      expect(accepted.record?.effects[0]?.state).toBe("intent");
      expect(attempted.effects.publishEffect).toHaveBeenCalledTimes(1);
      failPostCall.mockRestore();
      const back = await exportReviewDeliveryCustody({
        plan,
        store: destination,
        destinationStore: source,
        custodyAdmission: admission,
      });
      if (back.kind !== "fenced") throw new Error("Expected B fence.");
      expect(
        (
          await importReviewDeliveryCustody({
            plan,
            store: source,
            custodyAdmission: admission,
            pointer: back.pointer,
          })
        ).kind,
      ).toBe("import-pending");
      const pending = await source.loadReview(createReviewDeliveryManifest(plan).idempotencyKey);
      if (!pending) throw new Error("Return receipt missing.");
      const correlationAdmission = createReviewDeliveryCorrelationAdmission({
        verifyCurrent(candidate) {
          return candidate.actor.id === plan.actor.id &&
            candidate.requestedStore === pending.ownerStoreId
            ? {
                status: "supported" as const,
                channel: "exclusive-actor-writer-complete-stable-notes" as const,
              }
            : { status: "unsupported" as const };
        },
      });
      const recoveredPorts = notePorts(plan);
      const recovered = await executeReviewDelivery({
        plan,
        store: source,
        originAdmission: admission,
        correlationAdmission,
        grantsByActionId: grants(plan),
        ...recoveredPorts,
      });
      expect(
        recovered.kind,
        JSON.stringify({
          reason: recovered.kind === "stopped" ? recovered.reason : null,
          record: recovered.record,
        }),
      ).toBe("complete");
      expect(recovered.record?.effects[0]).toMatchObject({
        state: "confirmed",
        providerReference: "9001",
      });
      expect(recoveredPorts.effects.publishEffect).not.toHaveBeenCalled();
    },
    CUSTODY_TEST_TIMEOUT_MS,
  );

  it(
    "keeps a two-action import pending until every action has a live grant",
    async () => {
      const fixture = await retainedTwoStore(true);
      const { plan, source, destination, admission } = fixture;
      expect(plan.actions).toHaveLength(2);
      const noEffect = {
        prepareNextEffect: vi.fn(async () => ({ kind: "complete" as const })),
        publishEffect: vi.fn(async () => ({
          kind: "confirmed" as const,
          providerReference: "9001",
        })),
      };
      await executeReviewDelivery({
        plan,
        store: source,
        originAdmission: admission,
        grantsByActionId: grants(plan),
        effects: noEffect,
        recovery: currentRecovery(plan),
      });
      const exported = await exportReviewDeliveryCustody({
        plan,
        store: source,
        destinationStore: destination,
        custodyAdmission: admission,
      });
      if (exported.kind !== "fenced") throw new Error("Expected source fence.");
      expect(
        (
          await importReviewDeliveryCustody({
            plan,
            store: destination,
            custodyAdmission: admission,
            pointer: exported.pointer,
          })
        ).kind,
      ).toBe("import-pending");
      const oneGrant = grants(plan);
      oneGrant.delete(plan.actions[1]!.id);
      expect(
        await executeReviewDelivery({
          plan,
          store: destination,
          originAdmission: admission,
          grantsByActionId: oneGrant,
          effects: noEffect,
          recovery: currentRecovery(plan),
        }),
      ).toMatchObject({ kind: "stopped", reason: "authority" });
      expect(
        (await destination.loadReview(createReviewDeliveryManifest(plan).idempotencyKey))?.custody
          .state,
      ).toBe("import-pending");
      await executeReviewDelivery({
        plan,
        store: destination,
        originAdmission: admission,
        grantsByActionId: grants(plan),
        effects: noEffect,
        recovery: currentRecovery(plan),
      });
      expect(
        (await destination.loadReview(createReviewDeliveryManifest(plan).idempotencyKey))?.custody
          .state,
      ).toBe("active");
      expect(noEffect.publishEffect).not.toHaveBeenCalled();
    },
    CUSTODY_TEST_TIMEOUT_MS,
  );

  it("refuses a different configured actor before creating either initial owner", async () => {
    const fixture = await retainedTwoStore();
    const snapshot = retainedFixture().snapshot;
    const foreign = createReviewDeliveryPlan({
      target: fixture.plan.target,
      source: fixture.plan.source,
      result: JSON.parse(fixture.plan.result.originalResultCanonicalJson) as never,
      snapshot,
      artifact: fixture.plan.artifact,
      actor: { ...fixture.plan.actor, id: "user:foreign" },
      capabilities: fixture.plan.capabilities,
    });
    const ports = notePorts(foreign);
    const result = await executeReviewDelivery({
      plan: foreign,
      store: fixture.source,
      originAdmission: fixture.admission,
      grantsByActionId: grants(foreign),
      ...ports,
    });
    expect(result).toMatchObject({ kind: "stopped", reason: "custody" });
    expect(ports.effects.publishEffect).not.toHaveBeenCalled();
    expect(
      await fixture.source.loadReview(createReviewDeliveryManifest(foreign).idempotencyKey),
    ).toBeUndefined();
  });

  it(
    "fences A, imports at B, activates after grants, and returns into A's old tombstone",
    async () => {
      const fixture = await retainedTwoStore();
      const { plan, source, destination, admission } = fixture;
      const oldPlan = legacyPlan();
      const oldAuthorization = authorizeLocalUserPublication({
        plan: oldPlan,
        confirmedPlanSha256: oldPlan.sha256,
        command: "publish",
      });
      const oldRecord = createScmDeliveryRecord({
        plan: oldPlan,
        authorization: oldAuthorization,
        createdAt: "2026-10-15T12:00:00.000Z",
      });
      await source.claim(oldRecord, oldPlan);
      const oldBytes = await fileSnapshot(fixture.sourceRoot);
      const noEffect = {
        prepareNextEffect: vi.fn(async () => ({ kind: "complete" as const })),
        publishEffect: vi.fn(async () => ({
          kind: "confirmed" as const,
          providerReference: "9001",
        })),
      };
      const deniedEmptyB = await executeReviewDelivery({
        plan,
        store: destination,
        originAdmission: admission,
        grantsByActionId: grants(plan),
        effects: noEffect,
        recovery: currentRecovery(plan),
      });
      expect(deniedEmptyB).toMatchObject({ kind: "stopped", reason: "custody" });
      expect(
        await destination.loadReview(createReviewDeliveryManifest(plan).idempotencyKey),
      ).toBeUndefined();
      await executeReviewDelivery({
        plan,
        store: source,
        originAdmission: admission,
        grantsByActionId: grants(plan),
        effects: noEffect,
        recovery: currentRecovery(plan),
      });
      const first = await source.loadReview(createReviewDeliveryManifest(plan).idempotencyKey);
      expect(first).toMatchObject({ generation: 0, custody: { state: "active" } });
      if (!first) throw new Error("Initial review receipt missing before transfer refusal checks.");
      const destinationId = identifyReviewDeliveryCustodyStore(admission, destination);
      if (!destinationId) throw new Error("Configured destination identity missing.");
      expect(
        await importReviewDeliveryCustody({
          plan,
          store: destination,
          custodyAdmission: admission,
          pointer: {
            kind: "docsfab-review-delivery-transfer",
            schemaVersion: 1,
            logicalDeliveryId: first.manifest.logicalDeliveryId,
            manifestSha256: first.manifest.manifestSha256,
            sourceStoreId: first.ownerStoreId,
            destinationStoreId: destinationId,
            sourceGeneration: 0,
            successorGeneration: 1,
            transferId: "forged-unfenced-transfer",
            fencedSourceRecordSha256: first.sha256,
          },
        }),
      ).toMatchObject({ kind: "stopped", reason: "custody" });
      expect(
        await destination.loadReview(createReviewDeliveryManifest(plan).idempotencyKey),
      ).toBeUndefined();
      const copiedRoot = join(await root(), "copied-journal");
      await cp(fixture.sourceRoot, copiedRoot, { recursive: true });
      const copied = new FileScmDeliveryReceiptStore(copiedRoot);
      expect(
        (
          await executeReviewDelivery({
            plan,
            store: copied,
            originAdmission: admission,
            grantsByActionId: grants(plan),
            effects: noEffect,
            recovery: currentRecovery(plan),
          })
        ).kind,
      ).toBe("stopped");
      expect(
        (
          await executeReviewDelivery({
            plan,
            store: source,
            originAdmission: JSON.parse(JSON.stringify(admission)),
            grantsByActionId: grants(plan),
            effects: noEffect,
            recovery: currentRecovery(plan),
          })
        ).kind,
      ).toBe("stopped");
      const exported = await exportReviewDeliveryCustody({
        plan,
        store: source,
        destinationStore: destination,
        custodyAdmission: admission,
      });
      expect(exported.kind).toBe("fenced");
      if (exported.kind !== "fenced") throw new Error("Source fence missing.");
      const wrongPointer = {
        ...exported.pointer,
        fencedSourceRecordSha256: "e".repeat(64),
      };
      expect(
        (
          await importReviewDeliveryCustody({
            plan,
            store: destination,
            custodyAdmission: admission,
            pointer: wrongPointer,
          })
        ).kind,
      ).toBe("stopped");
      const displaced = `${fixture.sourceRoot}-offline`;
      roots.push(displaced);
      await rename(fixture.sourceRoot, displaced);
      expect(
        (
          await importReviewDeliveryCustody({
            plan,
            store: destination,
            custodyAdmission: admission,
            pointer: exported.pointer,
          })
        ).kind,
      ).toBe("stopped");
      await rm(fixture.sourceRoot, { recursive: true, force: true });
      await rename(displaced, fixture.sourceRoot);
      expect(reopenedReceipt(fixture.sourceRoot, plan)?.custody.state).toBe("fenced-out");
      const staleSourcePorts = notePorts(plan);
      expect(
        (
          await executeReviewDelivery({
            plan,
            store: source,
            originAdmission: admission,
            grantsByActionId: grants(plan),
            ...staleSourcePorts,
          })
        ).kind,
      ).toBe("stopped");
      expect(staleSourcePorts.effects.publishEffect).not.toHaveBeenCalled();
      const imported = await importReviewDeliveryCustody({
        plan,
        store: destination,
        custodyAdmission: admission,
        pointer: exported.pointer,
      });
      expect(imported.kind).toBe("import-pending");
      expect(reopenedReceipt(fixture.destinationRoot, plan)?.custody.state).toBe("import-pending");
      const revoked = await executeReviewDelivery({
        plan,
        store: destination,
        originAdmission: admission,
        grantsByActionId: grants(plan, () => false),
        ...notePorts(plan),
      });
      expect(revoked).toMatchObject({ kind: "stopped", reason: "authority" });
      const cancelledPorts = notePorts(plan);
      const cancelled = await executeReviewDelivery({
        plan,
        store: destination,
        originAdmission: admission,
        grantsByActionId: grants(plan),
        cancelled: () => true,
        ...cancelledPorts,
      });
      expect(cancelled).toMatchObject({ kind: "stopped", reason: "authority" });
      expect(cancelledPorts.effects.publishEffect).not.toHaveBeenCalled();
      expect(
        (await destination.loadReview(createReviewDeliveryManifest(plan).idempotencyKey))?.custody
          .state,
      ).toBe("import-pending");
      expect(coldActivate(fixture, "destination")).toMatchObject({
        state: "active",
        generation: 1,
      });
      const ports = notePorts(plan);
      const delivered = await executeReviewDelivery({
        plan,
        store: destination,
        originAdmission: admission,
        grantsByActionId: grants(plan),
        ...ports,
      });
      expect(
        delivered.kind,
        JSON.stringify({
          reason: delivered.kind === "stopped" ? delivered.reason : null,
          record: delivered.record,
        }),
      ).toBe("complete");
      expect(reopenedReceipt(fixture.destinationRoot, plan)?.custody.state).toBe("active");
      expect(ports.effects.publishEffect).toHaveBeenCalledTimes(1);
      const acknowledged = await acknowledgeReviewDeliveryCustody({
        plan,
        store: source,
        destinationStore: destination,
        custodyAdmission: admission,
        pointer: exported.pointer,
      });
      expect(acknowledged.kind).toBe("transferred");
      expect(reopenedReceipt(fixture.sourceRoot, plan)?.custody.state).toBe("transferred");
      const reversed = await exportReviewDeliveryCustody({
        plan,
        store: destination,
        destinationStore: source,
        custodyAdmission: admission,
      });
      expect(reversed.kind).toBe("fenced");
      if (reversed.kind !== "fenced") throw new Error("Return fence missing.");
      expect(
        await importReviewDeliveryCustody({
          plan,
          store: source,
          custodyAdmission: admission,
          pointer: { ...reversed.pointer, fencedSourceRecordSha256: "e".repeat(64) },
        }),
      ).toMatchObject({ kind: "stopped", reason: "custody" });
      expect(
        (await source.loadReview(createReviewDeliveryManifest(plan).idempotencyKey))?.custody.state,
      ).toBe("transferred");
      const returned = await importReviewDeliveryCustody({
        plan,
        store: source,
        custodyAdmission: admission,
        pointer: reversed.pointer,
      });
      expect(returned).toMatchObject({ kind: "import-pending", record: { generation: 2 } });
      expect(reopenedReceipt(fixture.sourceRoot, plan)?.generation).toBe(2);
      const foreignPorts = notePorts(plan, 9002);
      const foreign = await executeReviewDelivery({
        plan,
        store: source,
        originAdmission: admission,
        grantsByActionId: grants(plan),
        ...foreignPorts,
      });
      expect(foreign).toMatchObject({ kind: "stopped", reason: "remote-uncertain" });
      expect(foreignPorts.effects.publishEffect).not.toHaveBeenCalled();
      expect(
        (await source.loadReview(createReviewDeliveryManifest(plan).idempotencyKey))?.custody.state,
      ).toBe("import-pending");
      expect(coldActivate(fixture, "source")).toMatchObject({ state: "active", generation: 2 });
      const returnPorts = notePorts(plan);
      const completed = await executeReviewDelivery({
        plan,
        store: source,
        originAdmission: admission,
        grantsByActionId: grants(plan),
        ...returnPorts,
      });
      expect(
        completed.kind,
        JSON.stringify({
          reason: completed.kind === "stopped" ? completed.reason : null,
          record: completed.record,
        }),
      ).toBe("complete");
      expect(returnPorts.effects.publishEffect).not.toHaveBeenCalled();
      expect(
        (
          await importReviewDeliveryCustody({
            plan,
            store: destination,
            custodyAdmission: admission,
            pointer: exported.pointer,
          })
        ).kind,
      ).toBe("stopped");
      const afterBytes = await fileSnapshot(fixture.sourceRoot);
      for (const [path, bytes] of oldBytes) expect(afterBytes.get(path)).toEqual(bytes);
      expect(await source.load(oldRecord.idempotencyKey)).toEqual(oldRecord);
      expect(await source.loadPlan(oldPlan.sha256)).toEqual(oldPlan);
    },
    CUSTODY_TEST_TIMEOUT_MS,
  );

  it(
    "roundtrips a full-ceiling accumulated record within the inherited receipt bound",
    async () => {
      const plan = planFixture();
      const summary = plan.actions[0]!;
      if (summary.kind !== "publish-summary") throw new Error("Expected summary fixture.");
      const actionCount = LIMIT_DEFINITION_BY_NAME["reviewFindings.summaryTopN"]!.max;
      const actions = Array.from({ length: actionCount }, (_, index) => {
        const body = {
          kind: "publish-summary" as const,
          binding: summary.binding,
          findingIds: [sha256(canonicalJson(index))],
        };
        return { ...body, id: sha256(canonicalJson(body)) };
      });
      const manifest = createReviewDeliveryManifest({ ...plan, actions });
      const initial = createReviewDeliveryRecord(
        manifest,
        HASH,
        randomBytes(32).toString("base64url"),
      );
      const descriptors = manifest.actions
        .map((action) => {
          const coveredActionIds = [action.actionId];
          const effectId = reviewDeliveryEffectId(
            initial.context,
            "gitlab-discussion",
            coveredActionIds,
          );
          return {
            effectId,
            stage: "gitlab-discussion" as const,
            coveredActionIds,
            actionPayloads: [{ actionId: action.actionId, bodySha256: HASH, anchorSha256: HASH }],
            outboundBytesSha256: HASH,
            expectedBodySha256: HASH,
            expectedGitLabPositionSha256: HASH,
            marker: reviewDeliveryEffectNonce(initial.context, effectId),
          };
        })
        .sort((left, right) => left.effectId.localeCompare(right.effectId));
      const effects = descriptors.map((descriptor, index) => ({
        ...descriptor,
        state: "confirmed" as const,
        attemptId: `attempt:${index}`,
        providerReference: String(index + 1),
        observationSha256: HASH,
        actionReferences: [
          { actionId: descriptor.coveredActionIds[0]!, nativeReference: String(index + 1) },
        ],
        baseline: null,
        stop: null,
      }));
      const { sha256: _initialSha, ...body } = {
        ...initial,
        context: { ...initial.context, committedEffects: descriptors },
        effects,
      };
      const accumulated = assertReviewDeliveryRecordShape({
        ...body,
        sha256: reviewDeliveryRecordSha256(body),
      });
      const fullSlotBytes = Buffer.byteLength(
        canonicalizeJsonEvidence({
          schemaVersion: 1,
          kind: "docsfab-review-delivery-receipt-slot",
          sequence: actionCount,
          previousRecordSha256: HASH,
          record: accumulated,
          sha256: HASH,
        } as unknown as JsonEvidenceValue),
      );
      expect(accumulated.effects).toHaveLength(actionCount);
      expect(fullSlotBytes).toBeGreaterThan(
        Buffer.byteLength(canonicalizeJsonEvidence(initial as unknown as JsonEvidenceValue)),
      );
      expect(fullSlotBytes).toBeLessThan(MAX_RECEIPT_BYTES);
      const store = new FileScmDeliveryReceiptStore(await root());
      expect((await store.claimReview(initial, () => undefined)).created).toBe(true);
      const intents = updateReviewDeliveryRecord(initial, {
        context: accumulated.context,
        effects: accumulated.effects.map((effect) => ({
          ...effect,
          state: "intent" as const,
          providerReference: null,
          observationSha256: null,
          actionReferences: [],
        })),
      });
      await store.compareAndSwapReview(initial.sha256, intents, () => undefined);
      const uncertain = updateReviewDeliveryRecord(intents, {
        effects: intents.effects.map((effect) => ({ ...effect, state: "uncertain" as const })),
      });
      await store.compareAndSwapReview(intents.sha256, uncertain, () => undefined);
      const confirmed = updateReviewDeliveryRecord(uncertain, { effects: accumulated.effects });
      await store.compareAndSwapReview(uncertain.sha256, confirmed, () => undefined);
      expect(await store.loadReview(accumulated.idempotencyKey)).toEqual(confirmed);
      console.info(`review-delivery full-ceiling receipt bytes: ${fullSlotBytes}`);
    },
    CUSTODY_TEST_TIMEOUT_MS,
  );

  it("fences a source, imports a complete successor, and advances an old tombstone on return", () => {
    const record = createReviewDeliveryRecord(
      createReviewDeliveryManifest(planFixture()),
      HASH,
      randomBytes(32).toString("base64url"),
    );
    const other = "e".repeat(64);
    const fenced = updateReviewDeliveryRecord(record, {
      custody: { state: "fenced-out", transferId: "transfer:1", otherStoreId: other },
    });
    const pending = createReviewDeliveryImportRecord(fenced, other);
    const active = updateReviewDeliveryRecord(pending, {
      custody: { ...pending.custody, state: "active" },
    });
    const secondFence = updateReviewDeliveryRecord(active, {
      custody: { state: "fenced-out", transferId: "transfer:2", otherStoreId: record.ownerStoreId },
    });
    const returned = createReviewDeliveryImportRecord(secondFence, record.ownerStoreId);
    expect(returned.generation).toBe(2);
    expect(returned.ownerStoreId).toBe(record.ownerStoreId);
    expect(returned.context.correlationSeed).toBe(record.context.correlationSeed);
    expect(() =>
      updateReviewDeliveryRecord(fenced, {
        generation: 2,
        custody: {
          state: "import-pending",
          transferId: "transfer:foreign",
          otherStoreId: "f".repeat(64),
        },
      }),
    ).toThrow(/invalid-transition/);
    expect(() =>
      updateReviewDeliveryRecord(fenced, {
        ownerStoreId: other,
        generation: 1,
        custody: {
          state: "import-pending",
          transferId: "transfer:1",
          otherStoreId: record.ownerStoreId,
        },
      }),
    ).toThrow(/invalid-transition/);
  });

  it("does not dispatch from a copied or transferred slot at the configured origin", async () => {
    const plan = planFixture();
    const manifest = createReviewDeliveryManifest(plan);
    const store = new FileScmDeliveryReceiptStore(await root());
    const admission = createReviewDeliveryOriginAdmission({
      async verifyCurrent(input) {
        return input.requestedStore === store &&
          input.manifest.manifestSha256 === manifest.manifestSha256
          ? { status: "admitted" as const, storeId: HASH }
          : { status: "blocked" as const };
      },
    });
    const initial = createReviewDeliveryRecord(
      manifest,
      HASH,
      randomBytes(32).toString("base64url"),
    );
    const body = {
      ...initial,
      ownerStoreId: "e".repeat(64),
      generation: 1,
      custody: {
        state: "transferred" as const,
        transferId: "transfer:1",
        otherStoreId: "e".repeat(64),
      },
    };
    const { sha256: _old, ...withoutDigest } = body;
    const transferred = { ...withoutDigest, sha256: reviewDeliveryRecordSha256(withoutDigest) };
    await expect(store.claimReview(transferred, () => undefined)).rejects.toThrow(
      /receipt-invalid/,
    );
    await store.claimReview(initial, () => undefined);
    await expect(
      store.compareAndSwapReview(initial.sha256, transferred, () => undefined),
    ).rejects.toThrow(/SCM delivery receipt store failed/);
    expect(await store.loadReview(initial.idempotencyKey)).toEqual(initial);
    const copiedStore = new FileScmDeliveryReceiptStore(await root());
    const effects = {
      prepareNextEffect: vi.fn(async () => ({ kind: "complete" as const })),
      publishEffect: vi.fn(async () => ({ kind: "confirmed" as const, providerReference: null })),
    };
    const recovery = {
      observeCurrent: vi.fn(async () => ({ kind: "unavailable" as const, reason: "unexpected" })),
      observeEffect: vi.fn(async () => ({
        kind: "unavailable" as const,
        effectId: HASH,
        reason: "unexpected",
      })),
    };
    const result = await executeReviewDelivery({
      plan,
      store: copiedStore,
      originAdmission: admission,
      grantsByActionId: new Map(),
      effects,
      recovery,
    });
    expect(result).toMatchObject({ kind: "stopped", reason: "custody" });
    expect(effects.prepareNextEffect).not.toHaveBeenCalled();
    expect(effects.publishEffect).not.toHaveBeenCalled();
  });

  it(
    "stops a fenced owner at the executor record guard even if a host admission misreports it",
    async () => {
      const fixture = await retainedTwoStore();
      const { plan, source, destination, admission } = fixture;
      const noEffect = {
        prepareNextEffect: vi.fn(async () => ({ kind: "complete" as const })),
        publishEffect: vi.fn(async () => ({
          kind: "confirmed" as const,
          providerReference: "9001",
        })),
      };
      await executeReviewDelivery({
        plan,
        store: source,
        originAdmission: admission,
        grantsByActionId: grants(plan),
        effects: noEffect,
        recovery: currentRecovery(plan),
      });
      const exported = await exportReviewDeliveryCustody({
        plan,
        store: source,
        destinationStore: destination,
        custodyAdmission: admission,
      });
      if (exported.kind !== "fenced") throw new Error("Expected durable source fence.");
      const sourceId = identifyReviewDeliveryCustodyStore(admission, source);
      if (!sourceId) throw new Error("Configured source identity missing.");
      const hostMisreport = createReviewDeliveryCustodyAdmission({
        identifyConfiguredStore: (store) => (store === source ? sourceId : null),
        loadFencedTransfer: async () => null,
        verifyCurrent: async (candidate) =>
          candidate.phase === "execute" &&
          candidate.requestedStore === source &&
          candidate.manifest.manifestSha256 === exported.record.manifest.manifestSha256
            ? {
                status: "admitted" as const,
                originStoreId: sourceId,
                storeId: sourceId,
                generation: exported.record.generation,
                state: "fenced-out" as const,
                transferId: exported.record.custody.transferId,
              }
            : { status: "blocked" as const },
      });
      const ports = notePorts(plan);
      expect(
        await executeReviewDelivery({
          plan,
          store: source,
          originAdmission: hostMisreport,
          grantsByActionId: grants(plan),
          ...ports,
        }),
      ).toMatchObject({ kind: "stopped", reason: "custody" });
      expect(ports.effects.prepareNextEffect).not.toHaveBeenCalled();
      expect(ports.effects.publishEffect).not.toHaveBeenCalled();
    },
    CUSTODY_TEST_TIMEOUT_MS,
  );

  it.each(["grant revocation", "cancellation"])(
    "keeps an imported receipt pending when %s occurs at activation CAS",
    async (race) => {
      const fixture = await retainedTwoStore();
      const { plan, source, destination, admission } = fixture;
      const noEffect = {
        prepareNextEffect: vi.fn(async () => ({ kind: "complete" as const })),
        publishEffect: vi.fn(async () => ({
          kind: "confirmed" as const,
          providerReference: "9001",
        })),
      };
      await executeReviewDelivery({
        plan,
        store: source,
        originAdmission: admission,
        grantsByActionId: grants(plan),
        effects: noEffect,
        recovery: currentRecovery(plan),
      });
      const exported = await exportReviewDeliveryCustody({
        plan,
        store: source,
        destinationStore: destination,
        custodyAdmission: admission,
      });
      if (exported.kind !== "fenced") throw new Error("Expected durable source fence.");
      expect(
        await importReviewDeliveryCustody({
          plan,
          store: destination,
          custodyAdmission: admission,
          pointer: exported.pointer,
        }),
      ).toMatchObject({ kind: "import-pending" });
      let grantAllowed = true;
      let cancelled = false;
      let activationAttempted = false;
      const durableCas = destination.compareAndSwapReview!.bind(destination);
      vi.spyOn(destination, "compareAndSwapReview").mockImplementation(
        async (before, next, authorize) => {
          if (next.custody.state === "active" && !activationAttempted) {
            activationAttempted = true;
            if (race === "grant revocation") grantAllowed = false;
            else cancelled = true;
          }
          return durableCas(before, next, authorize);
        },
      );
      const ports = notePorts(plan);
      const result = await executeReviewDelivery({
        plan,
        store: destination,
        originAdmission: admission,
        grantsByActionId: grants(plan, () => grantAllowed),
        cancelled: () => cancelled,
        ...ports,
      });
      expect(activationAttempted).toBe(true);
      expect(result.kind).toBe("stopped");
      expect(
        (await destination.loadReview(createReviewDeliveryManifest(plan).idempotencyKey))?.custody
          .state,
      ).toBe("import-pending");
      expect(ports.effects.publishEffect).not.toHaveBeenCalled();
    },
    CUSTODY_TEST_TIMEOUT_MS,
  );
});
