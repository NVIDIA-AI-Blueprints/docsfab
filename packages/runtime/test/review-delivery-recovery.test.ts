// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nestedDeadlineMs, testTimeoutMs } from "./helpers/test-timeouts.js";
import { canonicalJson, sha256 } from "../src/content-ir/canonical.js";
import { DurableArtifactStore } from "../src/artifacts/store.js";
import { FileRunStore } from "../src/records/file-store.js";
import type { RunRecord } from "../src/records/contracts.js";
import {
  createChangeSource,
  type ChangeSourceSourceV1,
  type ChangeSourceV1,
} from "../src/inputs/change-source.js";
import {
  githubRepositoryIdentity,
  gitlabProjectIdentity,
} from "../src/inputs/change-source/revision.js";
import { digestGitlabMrReviewLocator } from "../src/inputs/gitlab-mr-locator.js";
import { createReviewResultV2, createReviewTargetV2 } from "../src/review/index.js";
import {
  createReviewDeliveryGrant,
  createReviewDeliveryPlan,
  type ReviewDeliveryPlanInput,
} from "../src/review-delivery/index.js";
import { FileScmDeliveryReceiptStore } from "../src/delivery/index.js";
import { canonicalizeJsonEvidence } from "../src/json-evidence.js";
import {
  executeReviewDelivery,
  reviewDeliveryBodySha256,
  reviewDeliveryEffectId,
  reviewDeliveryEffectNonce,
  reviewDeliveryOutboundBytesSha256,
  reviewDeliveryCurrentObservationSha256,
  reviewDeliveryGithubAnchorSha256,
  type ReviewDeliveryPreparedEffect,
  type ReviewDeliveryRemoteObservation,
  type ReviewDeliveryRecoveryPort,
  type OverviewRemainingV1,
  type RetainedIdentityV1,
} from "../src/review-delivery/execute.js";
import {
  createLocalReviewDeliveryOriginAdmission,
  createReviewDeliveryCorrelationAdmission,
  type ReviewDeliveryOriginAdmission,
} from "../src/review-delivery/custody.js";
import { createReviewDeliveryManifest } from "../src/review-delivery/receipt.js";
import {
  GitLabReviewDeliveryProvider,
  type GitLabReviewHttpRequest,
  type GitLabReviewHttpResponse,
} from "../src/review-delivery/providers/gitlab.js";
import {
  createGithubReviewAdapter,
  type GithubReviewFetchPort,
} from "../src/review-delivery/providers/github.js";
import { renderGitLabReviewSummary } from "../src/review-delivery/providers/gitlab-render.js";

const BASE = "a".repeat(40);
const START = "c".repeat(40);
const HEAD = "b".repeat(40);
const HASH = "d".repeat(64);
const AFTER = new TextEncoder().encode("after\n");
const roots: string[] = [];
type RetainedFixture = {
  readonly runStore: FileRunStore;
  readonly artifactStore: DurableArtifactStore;
  readonly runId: string;
  readonly artifactDigest: string;
};
const RECOVERY_TEST_TIMEOUT_MS = testTimeoutMs(120_000);
const CHILD_REOPEN_TIMEOUT_MS = nestedDeadlineMs(30_000, 120_000);

const remaining: OverviewRemainingV1 = {
  findingsTotal: 2,
  summarySelectedFindings: 1,
  nativeInlineFindings: 1,
  retainedUnpostedFindings: 0,
  unsupportedUnpostedFindings: 0,
  findingLimitations: 0,
  checks: 0,
  unansweredQuestions: 0,
  reviewScopePresent: 0,
  anchorPaths: 0,
  deferredPaths: 0,
  continuationLocatorPresent: 0,
  templateReportPresent: 0,
  templatePages: 0,
  templateRules: 0,
  templateSuggestionIds: 0,
  affectedPaths: 1,
  skippedPaths: 0,
  planLimitations: 0,
  hostedReportCandidatePresent: 0,
};

function retainedIdentityFor(plan: ReturnType<typeof fixture>): RetainedIdentityV1 {
  return {
    resultSha256: plan.result.originalResultSha256,
    sourceSha256: plan.target.changeSourceSha256,
    snapshotSha256: plan.snapshotSha256,
    runIdSha256: plan.result.runIdSha256,
    actionSetSha256: sha256(canonicalJson(plan.actions.map((action) => action.id).sort())),
  };
}

function historicalClassification(plan: ReturnType<typeof fixture>) {
  const summarySelectedFindings = plan.actions
    .filter((action) => action.kind === "publish-summary")
    .reduce((count, action) => count + action.findingIds.length, 0);
  const nativeInlineFindings = plan.actions.filter(
    (action) => action.kind === "publish-inline",
  ).length;
  return {
    kind: "presentation" as const,
    presentation: {
      kind: "historical-legacy" as const,
      remaining: {
        ...remaining,
        findingsTotal: plan.findings.length,
        summarySelectedFindings,
        nativeInlineFindings,
        retainedUnpostedFindings:
          plan.findings.length - summarySelectedFindings - nativeInlineFindings,
      },
      retained: retainedIdentityFor(plan),
    },
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "review-delivery-recovery-"));
  roots.push(root);
  return root;
}

function fixture(
  provider: "gitlab" | "github",
  options: {
    summary?: boolean;
    inline?: boolean;
    findings?: number;
    mixed?: boolean;
    requestedActions?: "overview" | "summary-only";
    actorId?: string;
  } = {},
) {
  const source = createChangeSource({
    source: (provider === "gitlab"
      ? {
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
        }
      : {
          kind: "github-pull-request",
          provenance: "forge-reported",
          host: "github.com",
          repositoryId: 100,
          fullName: "team/docs",
          number: 7,
          state: "open",
          headRepositoryId: 200,
        }) as ChangeSourceSourceV1,
    revision: {
      schemaVersion: 1,
      kind: "docsfab-pinned-repository-revision",
      repository:
        provider === "gitlab"
          ? gitlabProjectIdentity({ host: "gitlab.example.com", projectId: 42 })
          : githubRepositoryIdentity({ host: "github.com", repositoryId: 100 }),
      base: BASE,
      head: HEAD,
    },
    objectFormat: "sha1",
    rangeSemantics: provider === "gitlab" ? "two-dot" : "three-dot",
    mergeBase: provider === "gitlab" ? null : BASE,
    diffFrom: BASE,
    baseTree: null,
    headTree: null,
    commits: [{ id: HEAD, parents: [BASE], subject: "Change docs" }],
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
    protocol: { provider },
  });
  const common = {
    sourceBranch: "topic",
    targetBranch: "main",
    baseSha: BASE,
    headSha: HEAD,
    trigger: "api" as const,
    requestIdentitySha256: HASH,
    workflow: "review-documentation",
    deliveryIntent: "comment-existing-mr" as const,
    logicalRequestId: "request:7",
    changeSourceSha256: source.changeSourceSha256,
  };
  const target = createReviewTargetV2(
    provider === "gitlab"
      ? {
          ...common,
          scmProvider: "gitlab",
          host: "gitlab.example.com",
          projectId: 42,
          mergeRequestIid: 7,
          sourceFork: true,
        }
      : {
          ...common,
          scmProvider: "github",
          host: "github.com",
          repositoryId: 100,
          headRepositoryId: 200,
          pullRequestNumber: 7,
        },
    source,
  );
  const findingCount = options.findings ?? 1;
  const result = createReviewResultV2(target, source, {
    taskId: "task:7",
    runIdSha256: HASH,
    findings: Array.from({ length: findingCount }, (_, index) => ({
      id: `finding:${index + 1}`,
      severity: "warning" as const,
      code: "docs-gap",
      summary: `Explain new value ${index + 1}.`,
      path: options.mixed && index === 0 ? null : "docs/guide.md",
      ...(options.mixed && index === 0 ? {} : { line: 1 }),
    })),
    checks: [],
    unresolvedQuestions: [],
    affectedPaths: ["docs/guide.md"],
    patchLocator: { kind: "artifact-digest", digestSha256: HASH },
    locatorSha256:
      provider === "gitlab"
        ? digestGitlabMrReviewLocator({
            host: "gitlab.example.com",
            projectId: 42,
            mergeRequestIid: 7,
          })
        : null,
  });
  const input: ReviewDeliveryPlanInput<ChangeSourceV1> = {
    target,
    source,
    result,
    snapshot: {
      changeSourceSha256: source.changeSourceSha256,
      files: [
        {
          oldPath: null,
          newPath: "docs/guide.md",
          beforeBytes: null,
          afterBytes: AFTER,
          beforeSha256: null,
          afterSha256: sha256(AFTER),
          state: "complete",
          hunks: [{ lines: [{ kind: "added", text: "after", beforeLine: null, afterLine: 1 }] }],
        },
      ],
    },
    artifact: {
      kind: "retained-review-result",
      id: "artifact:7",
      resultSha256: result.resultSha256,
    },
    actor: { host: target.host, id: options.actorId ?? "user:42" },
    capabilities: {
      scmProvider: provider,
      host: target.host,
      summary: options.summary ?? false,
      inline: options.inline ?? true,
    },
    ...(options.requestedActions === undefined
      ? {}
      : { requestedActions: options.requestedActions }),
  };
  return createReviewDeliveryPlan(input);
}

async function retainedOrigin(
  root: string,
  plan: ReturnType<typeof fixture>,
  store = new FileScmDeliveryReceiptStore(root),
): Promise<{
  readonly store: FileScmDeliveryReceiptStore;
  readonly admission: ReviewDeliveryOriginAdmission;
  readonly retained: RetainedFixture;
}> {
  const state = await temporaryRoot();
  const runId = "review-run-1";
  const artifactDigest = plan.result.originalResultSha256;
  const artifactStore = new DurableArtifactStore(join(state, "artifacts"));
  await artifactStore.initialize();
  await artifactStore.putRecord(
    artifactDigest,
    JSON.parse(plan.result.originalResultCanonicalJson),
  );
  const runStore = new FileRunStore(join(state, "runs"));
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
          digest: artifactDigest,
          repositoryRevision: HEAD,
          repositoryContentDigest: HASH,
        },
      },
    ],
  } as unknown as RunRecord);
  const retained = { runStore, artifactStore, runId, artifactDigest };
  const admission = originAdmission(root, plan, store, retained);
  return { store, admission, retained };
}

function originAdmission(
  root: string,
  plan: ReturnType<typeof fixture>,
  store: FileScmDeliveryReceiptStore,
  retained: RetainedFixture,
): ReviewDeliveryOriginAdmission {
  return createLocalReviewDeliveryOriginAdmission({
    store,
    configuredReceiptRoot: root,
    ...retained,
    artifactId: plan.artifact.id,
    originalResultSha256: plan.result.originalResultSha256,
    ...(plan.requestedActions === undefined ? {} : { requestedActions: plan.requestedActions }),
    loadSnapshot: async () => ({
      changeSourceSha256: plan.source.changeSourceSha256,
      files: [
        {
          oldPath: null,
          newPath: "docs/guide.md",
          beforeBytes: null,
          afterBytes: Uint8Array.from(AFTER),
          beforeSha256: null,
          afterSha256: sha256(AFTER),
          state: "complete",
          hunks: [{ lines: [{ kind: "added", text: "after", beforeLine: null, afterLine: 1 }] }],
        },
      ],
    }),
  });
}

function grantsFor(plan: ReturnType<typeof fixture>) {
  return new Map(
    plan.actions.map((action) => [
      action.id,
      createReviewDeliveryGrant({
        verifyCurrent: (current) => {
          if (current.id !== action.id) throw new Error("fixture grant does not admit this action");
          return { status: "admitted" as const, actionId: action.id, kind: action.kind };
        },
      }),
    ]),
  );
}

function snapshotFor(plan: ReturnType<typeof fixture>) {
  return {
    changeSourceSha256: plan.source.changeSourceSha256,
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
}

class RetainedGitLabHttp {
  readonly calls: GitLabReviewHttpRequest[] = [];
  body: string | null = null;
  readonly request = async (
    request: GitLabReviewHttpRequest,
  ): Promise<GitLabReviewHttpResponse> => {
    this.calls.push(request);
    const mr = "/api/v4/projects/42/merge_requests/7";
    if (request.method === "POST" && request.path === `${mr}/notes`) {
      this.body = (
        JSON.parse(new TextDecoder().decode(request.bodyBytes)) as { body: string }
      ).body;
      return { status: 201, headers: {}, body: { id: 88 } };
    }
    if (request.path === "/api/v4/user") return { status: 200, headers: {}, body: { id: 42 } };
    if (request.path === mr)
      return {
        status: 200,
        headers: {},
        body: {
          id: 70,
          iid: 7,
          project_id: 42,
          source_project_id: 43,
          target_project_id: 42,
          source_branch: "topic",
          target_branch: "main",
          state: "opened",
          web_url: "https://gitlab.example.com/team/docs/-/merge_requests/7",
          diff_refs: { base_sha: BASE, start_sha: START, head_sha: HEAD },
        },
      };
    if (request.path === `${mr}/notes?per_page=100`)
      return { status: 200, headers: {}, body: this.body === null ? [] : [this.note()] };
    if (request.path === `${mr}/notes/88`) return { status: 200, headers: {}, body: this.note() };
    throw new Error(`Unexpected GitLab fake request: ${request.method} ${request.path}`);
  };
  note() {
    return {
      id: 88,
      project_id: 42,
      noteable_iid: 7,
      noteable_type: "MergeRequest",
      author: { id: 42 },
      body: this.body,
      system: false,
    };
  }
  postCount() {
    return this.calls.filter((call) => call.method === "POST").length;
  }
}

class RetainedGithubHttp {
  readonly calls: { method: string; path: string; body: unknown }[] = [];
  body: string | null = null;
  state: "PENDING" | "COMMENTED" | null = null;
  readbackReviewId = 700;
  readbackAuthorId = 42;
  readonly fetch: GithubReviewFetchPort = async (url, init) => {
    const parsed = new URL(url);
    const path = `${parsed.pathname}${parsed.search}`;
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(Buffer.from(init.body as Buffer).toString("utf8")) : null;
    this.calls.push({ method, path, body });
    if (parsed.origin !== "https://api.github.com" || init.redirect !== "manual")
      throw new Error("GitHub fake received a different origin or redirect policy");
    const base = "/repos/team/docs/pulls/7";
    if (path === "/user") return Response.json({ id: 42 });
    if (path === "/repos/team/docs") return Response.json({ id: 100, full_name: "team/docs" });
    if (path === base)
      return Response.json({
        number: 7,
        state: "open",
        changed_files: 1,
        head: { sha: HEAD, repo: { id: 200 } },
        base: { sha: BASE, repo: { id: 100 } },
      });
    if (method === "POST" && path === `${base}/reviews`) {
      this.body = (body as { body: string }).body;
      this.state = "PENDING";
      return Response.json({ id: 700 });
    }
    if (method === "POST" && path === `${base}/reviews/700/events`) {
      this.state = "COMMENTED";
      return Response.json({ id: 700 });
    }
    if (path === `${base}/reviews`)
      return Response.json(
        this.state === null
          ? []
          : [{ id: 700, body: this.body, user: { id: 42 }, commit_id: HEAD }],
      );
    if (path === `${base}/reviews/700`)
      return Response.json({
        id: this.readbackReviewId,
        user: { id: this.readbackAuthorId },
        body: this.body,
        state: this.state,
        commit_id: HEAD,
        pull_request_url: `https://api.github.com${base}`,
      });
    if (path === `${base}/reviews/700/comments`) return Response.json([]);
    throw new Error(`Unexpected GitHub fake request: ${method} ${path}`);
  };
  postCount() {
    return this.calls.filter((call) => call.method === "POST").length;
  }
}

function hash(value: unknown): string {
  return createHash("sha256")
    .update(canonicalizeJsonEvidence(value as never))
    .digest("hex");
}

function effectFor(
  plan: ReturnType<typeof fixture>,
  context: Parameters<typeof reviewDeliveryEffectNonce>[0],
  stage: ReviewDeliveryPreparedEffect["stage"],
  actionIds: readonly string[],
): ReviewDeliveryPreparedEffect {
  const actionPayloads = actionIds.map((actionId) => {
    const action = plan.actions.find((item) => item.id === actionId)!;
    return {
      actionId,
      bodySha256:
        stage.startsWith("github") && action.kind === "publish-summary"
          ? hash("")
          : hash(`native comment ${actionId}`),
      anchorSha256:
        action.kind === "publish-inline"
          ? reviewDeliveryGithubAnchorSha256({
              path: action.anchor.path,
              line: action.anchor.endLine,
              side: action.anchor.side === "after" ? "RIGHT" : "LEFT",
              ...(action.anchor.startLine === action.anchor.endLine
                ? {}
                : {
                    startLine: action.anchor.startLine,
                    startSide: action.anchor.side === "after" ? "RIGHT" : "LEFT",
                  }),
            })
          : null,
    };
  });
  const effectId = reviewDeliveryEffectId(context, stage, actionIds);
  const body =
    stage === "github-pending-review-create" || stage === "github-comment-submit"
      ? ""
      : `review body ${effectId}`;
  const path =
    stage === "gitlab-note"
      ? "/projects/42/merge_requests/7/notes"
      : stage === "gitlab-discussion"
        ? "/projects/42/merge_requests/7/discussions"
        : stage === "github-comment-submit"
          ? "/repos/team/docs/pulls/7/reviews/700/events"
          : "/repos/team/docs/pulls/7/reviews";
  const request = {
    method: "POST" as const,
    path,
    bodyBytes: new TextEncoder().encode(
      JSON.stringify({ body, marker: reviewDeliveryEffectNonce(context, effectId) }),
    ),
  };
  const expectedGitLabPosition =
    stage === "gitlab-discussion"
      ? {
          baseSha: BASE,
          startSha: START,
          headSha: HEAD,
          positionType: "text" as const,
          oldPath: "docs/guide.md",
          newPath: "docs/guide.md",
          oldLine: null,
          newLine: 1,
          lineRange: null,
        }
      : null;
  return {
    kind: "effect",
    effectId,
    coveredActionIds: [...actionIds],
    actionPayloads,
    stage,
    request,
    outboundBytesSha256: reviewDeliveryOutboundBytesSha256(request),
    expectedBodySha256: hash(body),
    expectedGitLabPosition,
    marker: reviewDeliveryEffectNonce(context, effectId),
    revisionProvenance:
      stage === "gitlab-note"
        ? {
            kind: "gitlab-summary-retained",
            intendedHeadSha: HEAD,
            freshTargetObservationSha256: reviewDeliveryCurrentObservationSha256({
              kind: "current",
              target: plan.actions[0]!.binding.target,
              sourceSha256: plan.actions[0]!.binding.sourceSha256,
              snapshotSha256: plan.actions[0]!.binding.snapshotSha256,
              actor: plan.actions[0]!.binding.actor,
              headSha: plan.actions[0]!.binding.reviewedHeadSha,
              startSha: plan.actions[0]!.binding.startSha,
            }),
            serverAtomicFence: false,
          }
        : stage === "gitlab-discussion"
          ? { kind: "gitlab-diff-position", baseSha: BASE, startSha: START, headSha: HEAD }
          : { kind: "github-review-commit", commitId: HEAD },
  };
}

function matchingGitLabNote(
  effect: ReviewDeliveryPreparedEffect,
  enumerationSha256: string,
): ReviewDeliveryRemoteObservation {
  return {
    kind: "matching",
    effectId: effect.effectId,
    providerReference: "9001",
    native: {
      kind: "gitlab-note",
      projectId: 42,
      mergeRequestIid: 7,
      noteId: 9001,
      author: { host: "gitlab.example.com", id: "user:42" },
      body: `review body ${effect.effectId}`,
    },
    actionReferences: effect.coveredActionIds.map((actionId) => ({
      actionId,
      nativeReference: "9001",
    })),
    discovery: {
      kind: "complete-enumeration",
      enumerationSha256,
      matchingCandidateCount: 1,
      directGetVerified: true,
    },
    lifecycle: "final-published",
  };
}

function matchingGitLabDiscussion(
  effect: ReviewDeliveryPreparedEffect,
  noteId = 8001,
): ReviewDeliveryRemoteObservation {
  return {
    kind: "matching",
    effectId: effect.effectId,
    providerReference: `discussion:${noteId}`,
    native: {
      kind: "gitlab-discussion",
      projectId: 42,
      mergeRequestIid: 7,
      discussionId: `discussion:${noteId}`,
      noteId,
      author: { host: "gitlab.example.com", id: "user:42" },
      body: `review body ${effect.effectId}`,
      position: effect.expectedGitLabPosition!,
    },
    actionReferences: effect.coveredActionIds.map((actionId) => ({
      actionId,
      nativeReference: String(noteId),
    })),
    discovery: {
      kind: "complete-enumeration",
      enumerationSha256: HASH,
      matchingCandidateCount: 1,
      directGetVerified: true,
    },
    lifecycle: "final-published",
  };
}

function matchingGitHubReview(
  effect: ReviewDeliveryPreparedEffect,
  state: "PENDING" | "COMMENTED",
): ReviewDeliveryRemoteObservation {
  return {
    kind: "matching",
    effectId: effect.effectId,
    providerReference: "700",
    native: {
      kind: "github-review",
      repositoryId: 100,
      pullRequestNumber: 7,
      reviewId: 700,
      author: { host: "github.com", id: "user:42" },
      body: "",
      commitId: HEAD,
      state,
      comments: effect.actionPayloads
        .filter((payload) => payload.anchorSha256 !== null)
        .map((payload, index) => ({
          commentId: 800 + index,
          commitId: HEAD,
          reviewId: 700,
          author: { host: "github.com", id: "user:42" },
          body: `native comment ${payload.actionId}`,
          path: "docs/guide.md",
          line: 1,
          side: "RIGHT" as const,
        })),
    },
    actionReferences: effect.actionPayloads.map((payload) => ({
      actionId: payload.actionId,
      nativeReference:
        payload.anchorSha256 === null
          ? "700"
          : String(
              800 +
                effect.actionPayloads.filter((item) => item.anchorSha256 !== null).indexOf(payload),
            ),
    })),
    discovery: { kind: "direct-reference" },
    lifecycle: state === "PENDING" ? "accepted-pending" : "final-published",
  };
}

describe("review-delivery recovery", () => {
  it(
    "returns current typed capacity evidence before any GitHub provider write without changing the receipt dialect",
    async () => {
      const plan = fixture("github", {
        summary: true,
        inline: true,
        findings: 2,
        mixed: true,
        requestedActions: "overview",
      });
      const retainedIdentity = retainedIdentityFor(plan);
      const root = await temporaryRoot();
      const { store, admission, retained } = await retainedOrigin(root, plan);
      const publish = vi.fn(async () => {
        throw new Error("A deterministic body capacity stop must not POST.");
      });
      const stop = (effectiveBytes: number) => ({
        kind: "capacity-stop" as const,
        code: "github-review-body-bytes-bound" as const,
        limitName: "githubReview.bodyMaxBytes" as const,
        observedBytes: 900,
        effectiveBytes,
        scope: "github-pending-review-create.body" as const,
        remaining,
        retained: retainedIdentity,
      });
      // A second, valid offline effect makes the zero-POST assertion sensitive to
      // removal of the capacity barrier, without any live transport.
      let preparations = 0;
      const prepare = vi.fn(
        async ({ context }: { context: Parameters<typeof reviewDeliveryEffectNonce>[0] }) =>
          preparations++ === 0
            ? stop(800)
            : effectFor(
                plan,
                context,
                "github-pending-review-create",
                plan.actions.map((a) => a.id).sort(),
              ),
      );
      const first = await executeReviewDelivery({
        plan,
        store,
        originAdmission: admission,
        grantsByActionId: grantsFor(plan),
        effects: { prepareNextEffect: prepare, publishEffect: publish },
        recovery: {
          observeCurrent: vi.fn(async (binding: (typeof plan.actions)[number]["binding"]) => ({
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
      expect(publish).not.toHaveBeenCalled();
      expect(first).toMatchObject({ kind: "stopped", reason: "capacity", capacity: stop(800) });
      expect(first.record?.effects).toEqual([]);
      expect(first.record?.preparationStop).toBeNull();
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(publish).not.toHaveBeenCalled();

      const reopened = new FileScmDeliveryReceiptStore(root);
      const second = await executeReviewDelivery({
        plan,
        store: reopened,
        originAdmission: originAdmission(root, plan, reopened, retained),
        grantsByActionId: grantsFor(plan),
        effects: { prepareNextEffect: vi.fn(async () => stop(700)), publishEffect: publish },
        recovery: {
          observeCurrent: vi.fn(async () => ({ kind: "unavailable" as const, reason: "unused" })),
          observeEffect: vi.fn(async () => ({
            kind: "unavailable" as const,
            effectId: HASH,
            reason: "unused",
          })),
        },
      });
      expect(second).toMatchObject({ kind: "stopped", reason: "capacity", capacity: stop(700) });
      expect(second.record?.sha256).toBe(first.record?.sha256);
      expect(publish).not.toHaveBeenCalled();
    },
    RECOVERY_TEST_TIMEOUT_MS,
  );

  it.each(["gitlab", "github"] as const)(
    "keeps a default zero-action %s delivery complete without preparing an empty provider effect",
    async (provider) => {
      const plan = fixture(provider, { summary: true, inline: true, findings: 0 });
      expect(plan.actions).toHaveLength(0);
      const root = await temporaryRoot();
      const { store, admission } = await retainedOrigin(root, plan);
      const prepare = vi.fn(async () => ({ kind: "complete" as const }));
      const publish = vi.fn(async () => {
        throw new Error("An empty default plan has no provider effect to publish.");
      });
      const result = await executeReviewDelivery({
        plan,
        store,
        originAdmission: admission,
        grantsByActionId: new Map(),
        effects: { prepareNextEffect: prepare, publishEffect: publish },
        recovery: {
          observeCurrent: vi.fn(async () => ({ kind: "unavailable" as const, reason: "unused" })),
          observeEffect: vi.fn(async () => ({
            kind: "unavailable" as const,
            effectId: HASH,
            reason: "unused",
          })),
        },
      });
      expect(result.kind).toBe("complete");
      expect(prepare).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
    },
    RECOVERY_TEST_TIMEOUT_MS,
  );

  it(
    "does not adopt a confirmed terse GitLab note as a same-key explicit overview",
    async () => {
      const defaultPlan = fixture("gitlab", { summary: true, inline: false, actorId: "42" });
      const explicitPlan = fixture("gitlab", {
        summary: true,
        inline: false,
        requestedActions: "summary-only",
        actorId: "42",
      });
      expect(createReviewDeliveryManifest(defaultPlan).idempotencyKey).toBe(
        createReviewDeliveryManifest(explicitPlan).idempotencyKey,
      );
      const root = await temporaryRoot();
      const { store, admission, retained } = await retainedOrigin(root, defaultPlan);
      const http = new RetainedGitLabHttp();
      const defaultProvider = new GitLabReviewDeliveryProvider(defaultPlan.target.host, http);
      const summary = defaultPlan.actions[0];
      if (summary?.kind !== "publish-summary") throw new Error("Expected one summary action.");
      const published = await executeReviewDelivery({
        plan: defaultPlan,
        store,
        originAdmission: admission,
        grantsByActionId: grantsFor(defaultPlan),
        effects: {
          prepareNextEffect: async (input) => {
            const prepared = await defaultProvider.prepareNextEffect(input);
            if (prepared.kind !== "effect") return prepared;
            const legacyBody = renderGitLabReviewSummary({
              findings: summary.findingIds.map(
                (id) => defaultPlan.findings.find((finding) => finding.inventoryId === id)!,
              ),
              inlineCount: 0,
              reviewedHeadSha: summary.binding.reviewedHeadSha,
              mrUrl: "https://gitlab.example.com/team/docs/-/merge_requests/7",
              reportUrl: null,
              threadUrls: [],
              marker: prepared.marker,
            });
            const request = {
              ...prepared.request,
              bodyBytes: new TextEncoder().encode(JSON.stringify({ body: legacyBody })),
            };
            const bodySha256 = reviewDeliveryBodySha256(legacyBody);
            return {
              ...prepared,
              request,
              outboundBytesSha256: reviewDeliveryOutboundBytesSha256(request),
              expectedBodySha256: bodySha256,
              actionPayloads: [{ ...prepared.actionPayloads[0]!, bodySha256 }],
            };
          },
          publishEffect: async ({ effect }) => {
            const response = await http.request(effect.request);
            return {
              kind: "confirmed" as const,
              providerReference: String((response.body as { id: number }).id),
            };
          },
        },
        recovery: defaultProvider,
      });
      expect(published.kind).toBe("complete");
      expect(http.postCount()).toBe(1);
      const before = await store.loadReview!(
        createReviewDeliveryManifest(defaultPlan).idempotencyKey,
      );
      const reopened = new FileScmDeliveryReceiptStore(root);
      const explicitProvider = new GitLabReviewDeliveryProvider(explicitPlan.target.host, http);
      const prepare = vi.spyOn(explicitProvider, "prepareNextEffect");
      const attempt = await executeReviewDelivery({
        plan: explicitPlan,
        store: reopened,
        originAdmission: originAdmission(root, explicitPlan, reopened, retained),
        grantsByActionId: grantsFor(explicitPlan),
        effects: explicitProvider,
        recovery: explicitProvider,
      });
      expect(attempt).toMatchObject({ kind: "stopped", reason: "remote-uncertain" });
      expect(attempt.record?.sha256).toBe(before?.sha256);
      expect(prepare).toHaveBeenCalled();
      expect(http.postCount()).toBe(1);
    },
    RECOVERY_TEST_TIMEOUT_MS,
  );

  it(
    "rechecks a confirmed explicit GitLab overview through the real provider after restart",
    async () => {
      const plan = fixture("gitlab", {
        summary: true,
        inline: false,
        requestedActions: "summary-only",
        actorId: "42",
      });
      const root = await temporaryRoot();
      const { store, admission, retained } = await retainedOrigin(root, plan);
      const http = new RetainedGitLabHttp();
      const provider = new GitLabReviewDeliveryProvider(plan.target.host, http);
      const first = await executeReviewDelivery({
        plan,
        store,
        originAdmission: admission,
        grantsByActionId: grantsFor(plan),
        effects: provider,
        recovery: provider,
      });
      expect(first.kind).toBe("complete");
      expect(http.postCount()).toBe(1);
      const reopened = new FileScmDeliveryReceiptStore(root);
      const coldProvider = new GitLabReviewDeliveryProvider(plan.target.host, http);
      const prepare = vi.spyOn(coldProvider, "prepareNextEffect");
      const replay = await executeReviewDelivery({
        plan,
        store: reopened,
        originAdmission: originAdmission(root, plan, reopened, retained),
        grantsByActionId: grantsFor(plan),
        effects: coldProvider,
        recovery: coldProvider,
      });
      expect(replay.kind).toBe("complete");
      expect(prepare).toHaveBeenCalled();
      expect(http.postCount()).toBe(1);
    },
    RECOVERY_TEST_TIMEOUT_MS,
  );

  it(
    "rechecks a confirmed explicit GitHub overview and its accepted-pending create against COMMENTED readback",
    async () => {
      const plan = fixture("github", {
        summary: true,
        inline: false,
        requestedActions: "summary-only",
        actorId: "42",
      });
      const root = await temporaryRoot();
      const { store, admission, retained } = await retainedOrigin(root, plan);
      const http = new RetainedGithubHttp();
      const adapter = createGithubReviewAdapter({
        plan,
        snapshot: snapshotFor(plan),
        fetch: http.fetch,
        authorization: () => "Bearer synthetic",
      });
      const first = await executeReviewDelivery({
        plan,
        store,
        originAdmission: admission,
        grantsByActionId: grantsFor(plan),
        effects: adapter,
        recovery: adapter,
      });
      expect(first).toMatchObject({ kind: "complete", overview: "full" });
      expect(first.record?.effects.map((effect) => effect.state).sort()).toEqual([
        "accepted-pending",
        "confirmed",
      ]);
      expect(http.postCount()).toBe(2);
      const reopened = new FileScmDeliveryReceiptStore(root);
      const coldAdapter = createGithubReviewAdapter({
        plan,
        snapshot: snapshotFor(plan),
        fetch: http.fetch,
        authorization: () => "Bearer synthetic",
      });
      const prepare = vi.spyOn(coldAdapter, "prepareNextEffect");
      const replay = await executeReviewDelivery({
        plan,
        store: reopened,
        originAdmission: originAdmission(root, plan, reopened, retained),
        grantsByActionId: grantsFor(plan),
        effects: coldAdapter,
        recovery: coldAdapter,
      });
      expect(replay).toMatchObject({ kind: "complete", overview: "full" });
      expect(prepare).toHaveBeenCalled();
      expect(http.postCount()).toBe(2);
    },
    RECOVERY_TEST_TIMEOUT_MS,
  );

  it.each(["foreign-review", "foreign-author"] as const)(
    "refuses a %s on confirmed GitHub restart without another POST",
    async (fault) => {
      const plan = fixture("github", {
        summary: true,
        inline: false,
        requestedActions: "summary-only",
        actorId: "42",
      });
      const root = await temporaryRoot();
      const { store, admission, retained } = await retainedOrigin(root, plan);
      const http = new RetainedGithubHttp();
      const adapter = createGithubReviewAdapter({
        plan,
        snapshot: snapshotFor(plan),
        fetch: http.fetch,
        authorization: () => "Bearer synthetic",
      });
      const published = await executeReviewDelivery({
        plan,
        store,
        originAdmission: admission,
        grantsByActionId: grantsFor(plan),
        effects: adapter,
        recovery: adapter,
      });
      expect(published.kind).toBe("complete");
      if (fault === "foreign-review") http.readbackReviewId = 701;
      else http.readbackAuthorId = 43;
      const reopened = new FileScmDeliveryReceiptStore(root);
      const coldAdapter = createGithubReviewAdapter({
        plan,
        snapshot: snapshotFor(plan),
        fetch: http.fetch,
        authorization: () => "Bearer synthetic",
      });
      const replay = await executeReviewDelivery({
        plan,
        store: reopened,
        originAdmission: originAdmission(root, plan, reopened, retained),
        grantsByActionId: grantsFor(plan),
        effects: coldAdapter,
        recovery: coldAdapter,
      });
      expect(replay).toMatchObject({ kind: "stopped", reason: "remote-uncertain" });
      expect(http.postCount()).toBe(2);
    },
    RECOVERY_TEST_TIMEOUT_MS,
  );

  it(
    "replays confirmed GitLab effects before an unresolved effect and completes a fresh fully-confirmed call",
    async () => {
      const plan = fixture("gitlab", { inline: true, findings: 2 });
      expect(plan.actions).toHaveLength(2);
      const [firstAction, secondAction] = plan.actions;
      const root = await temporaryRoot();
      const { store, admission, retained } = await retainedOrigin(root, plan);
      const prepare = async ({
        context,
        priorObservations,
      }: {
        context: Parameters<typeof reviewDeliveryEffectNonce>[0];
        priorObservations: readonly ReviewDeliveryRemoteObservation[];
      }) =>
        priorObservations.length === 0
          ? effectFor(plan, context, "gitlab-discussion", [firstAction!.id])
          : priorObservations.length === 1
            ? effectFor(plan, context, "gitlab-discussion", [secondAction!.id])
            : { kind: "complete" as const };
      const observeCurrent = vi.fn(async (binding: (typeof plan.actions)[number]["binding"]) => ({
        kind: "current" as const,
        target: binding.target,
        sourceSha256: binding.sourceSha256,
        snapshotSha256: binding.snapshotSha256,
        actor: binding.actor,
        headSha: binding.reviewedHeadSha,
        startSha: binding.startSha,
      }));
      let posts = 0;
      const first = await executeReviewDelivery({
        plan,
        store,
        originAdmission: admission,
        grantsByActionId: grantsFor(plan),
        effects: {
          prepareNextEffect: vi.fn(prepare),
          publishEffect: vi.fn(async ({ effect }) => {
            posts++;
            return effect.coveredActionIds[0] === firstAction!.id
              ? { kind: "confirmed" as const, providerReference: "discussion:8001" }
              : { kind: "uncertain" as const, providerReference: null, stop: null };
          }),
        },
        recovery: {
          observeCurrent,
          observeEffect: vi.fn(async ({ effect }) =>
            effect.coveredActionIds[0] === firstAction!.id
              ? {
                  ...matchingGitLabDiscussion(effect),
                  discovery: { kind: "direct-reference" as const },
                }
              : {
                  kind: "ambiguous" as const,
                  effectId: effect.effectId,
                  reason: "accepted without reply",
                },
          ),
        },
      });
      expect(first).toMatchObject({ kind: "stopped", reason: "remote-uncertain" });
      expect(first.record?.effects.map((item) => item.state).sort()).toEqual([
        "confirmed",
        "uncertain",
      ]);
      expect(posts).toBe(2);

      const reopened = new FileScmDeliveryReceiptStore(root);
      const restarted = await executeReviewDelivery({
        plan,
        store: reopened,
        originAdmission: originAdmission(root, plan, reopened, retained),
        grantsByActionId: grantsFor(plan),
        effects: {
          prepareNextEffect: vi.fn(prepare),
          publishEffect: vi.fn(async () => {
            posts++;
            throw new Error("Reopened review must reconcile without another POST.");
          }),
        },
        recovery: {
          observeCurrent,
          observeEffect: vi.fn(async ({ effect }) =>
            effect.coveredActionIds[0] === firstAction!.id
              ? {
                  ...matchingGitLabDiscussion(effect),
                  discovery: { kind: "direct-reference" as const },
                }
              : matchingGitLabDiscussion(effect, 8002),
          ),
        },
      });
      expect(restarted.kind).toBe("complete");
      expect(posts).toBe(2);
      expect(restarted.record?.effects.every((item) => item.state === "confirmed")).toBe(true);

      const completeStore = new FileScmDeliveryReceiptStore(root);
      const completePrepare = vi.fn(async () => ({ kind: "complete" as const }));
      const completeInput = {
        plan,
        store: completeStore,
        originAdmission: originAdmission(root, plan, completeStore, retained),
        effects: {
          prepareNextEffect: completePrepare,
          publishEffect: vi.fn(async () => {
            throw new Error("A confirmed action must not be posted again.");
          }),
        },
        recovery: {
          observeCurrent,
          observeEffect: vi.fn(async () => ({
            kind: "unavailable" as const,
            effectId: HASH,
            reason: "A complete receipt needs no further effect lookup.",
          })),
        },
      };
      const revoked = await executeReviewDelivery({
        ...completeInput,
        grantsByActionId: new Map(),
      });
      expect(revoked).toMatchObject({ kind: "stopped", reason: "authority" });
      const complete = await executeReviewDelivery({
        ...completeInput,
        grantsByActionId: grantsFor(plan),
      });
      expect(complete.kind).toBe("complete");
      expect(completePrepare).not.toHaveBeenCalled();
    },
    RECOVERY_TEST_TIMEOUT_MS,
  );

  it(
    "reconciles a lost GitHub submit receipt from actual COMMENTED readback without replaying POST",
    async () => {
      const plan = fixture("github", { summary: true, inline: true, findings: 2, mixed: true });
      const retainedIdentity = retainedIdentityFor(plan);
      expect(plan.actions.map((action) => action.kind).sort()).toEqual([
        "publish-inline",
        "publish-summary",
      ]);
      const actionIds = plan.actions.map((action) => action.id).sort();
      const root = await temporaryRoot();
      const { store, admission, retained } = await retainedOrigin(root, plan);
      const prepare = async ({
        context,
        priorObservations,
      }: {
        context: Parameters<typeof reviewDeliveryEffectNonce>[0];
        priorObservations: readonly ReviewDeliveryRemoteObservation[];
      }) =>
        priorObservations.length === 0
          ? effectFor(plan, context, "github-pending-review-create", actionIds)
          : priorObservations.length === 1
            ? effectFor(plan, context, "github-comment-submit", actionIds)
            : { kind: "complete" as const };
      const observeCurrent = vi.fn(async (binding: (typeof plan.actions)[number]["binding"]) => ({
        kind: "current" as const,
        target: binding.target,
        sourceSha256: binding.sourceSha256,
        snapshotSha256: binding.snapshotSha256,
        actor: binding.actor,
        headSha: binding.reviewedHeadSha,
        startSha: binding.startSha,
      }));
      let posts = 0;
      const first = await executeReviewDelivery({
        plan,
        store,
        originAdmission: admission,
        grantsByActionId: grantsFor(plan),
        effects: {
          prepareNextEffect: vi.fn(prepare),
          publishEffect: vi.fn(async ({ effect }) => {
            posts++;
            return effect.stage === "github-pending-review-create"
              ? { kind: "confirmed" as const, providerReference: "700" }
              : { kind: "uncertain" as const, providerReference: null, stop: null };
          }),
        },
        recovery: {
          observeCurrent,
          observeEffect: vi.fn(async ({ effect }) =>
            effect.stage === "github-pending-review-create"
              ? matchingGitHubReview(effect, "PENDING")
              : {
                  kind: "ambiguous" as const,
                  effectId: effect.effectId,
                  reason: "submit reply lost",
                },
          ),
        },
      });
      expect(first).toMatchObject({ kind: "stopped", reason: "remote-uncertain" });
      expect(
        first.record?.effects.find((item) => item.stage === "github-pending-review-create")?.state,
      ).toBe("accepted-pending");
      expect(
        first.record?.effects.find((item) => item.stage === "github-comment-submit")?.state,
      ).toBe("uncertain");
      expect(posts).toBe(2);

      const reopened = new FileScmDeliveryReceiptStore(root);
      const restartedPrepare = vi.fn(prepare);
      const restarted = await executeReviewDelivery({
        plan,
        store: reopened,
        originAdmission: originAdmission(root, plan, reopened, retained),
        grantsByActionId: grantsFor(plan),
        effects: {
          prepareNextEffect: restartedPrepare,
          classifyCommittedOverviewPresentation: ({ context }) => {
            expect(context.committedEffects.map((effect) => effect.stage).sort()).toEqual([
              "github-comment-submit",
              "github-pending-review-create",
            ]);
            return {
              kind: "presentation" as const,
              presentation: {
                kind: "compact-partial" as const,
                remaining,
                retained: retainedIdentity,
              },
            };
          },
          publishEffect: vi.fn(async () => {
            posts++;
            throw new Error("A submitted review must not be posted again.");
          }),
        },
        recovery: {
          observeCurrent,
          observeEffect: vi.fn(async ({ effect }) => matchingGitHubReview(effect, "COMMENTED")),
        },
      });
      expect(restarted).toMatchObject({
        kind: "partial",
        publication: "submitted",
        overview: "partial",
        remaining,
        retained: retainedIdentity,
      });
      expect(posts).toBe(2);
      const submitPreparation = restartedPrepare.mock.calls.find(
        (call) => call[0].priorObservations.length === 1,
      );
      expect(submitPreparation?.[0].priorObservations[0]).toMatchObject({
        kind: "matching",
        native: { state: "COMMENTED" },
        lifecycle: "final-published",
      });
      expect(
        restarted.record?.effects.find((item) => item.stage === "github-comment-submit")?.state,
      ).toBe("confirmed");

      const fullyReopened = new FileScmDeliveryReceiptStore(root);
      const noPrepare = vi.fn(async () => {
        throw new Error("A confirmed default delivery must not prepare again.");
      });
      const fast = await executeReviewDelivery({
        plan,
        store: fullyReopened,
        originAdmission: originAdmission(root, plan, fullyReopened, retained),
        grantsByActionId: grantsFor(plan),
        effects: {
          prepareNextEffect: noPrepare,
          classifyCommittedOverviewPresentation: () => ({
            kind: "presentation",
            presentation: { kind: "compact-partial", remaining, retained: retainedIdentity },
          }),
          publishEffect: vi.fn(async () => {
            throw new Error("A confirmed delivery must not POST again.");
          }),
        },
        recovery: {
          observeCurrent,
          observeEffect: vi.fn(async () => {
            throw new Error("The confirmed fast path needs no remote effect enumeration.");
          }),
        },
      });
      expect(fast).toMatchObject({ kind: "partial", overview: "partial", remaining });
      expect(noPrepare).not.toHaveBeenCalled();
      const hooklessStore = new FileScmDeliveryReceiptStore(root);
      const hookless = await executeReviewDelivery({
        plan,
        store: hooklessStore,
        originAdmission: originAdmission(root, plan, hooklessStore, retained),
        grantsByActionId: grantsFor(plan),
        effects: {
          prepareNextEffect: noPrepare,
          publishEffect: vi.fn(async () => {
            throw new Error("An unclassified committed review must not POST.");
          }),
        },
        recovery: {
          observeCurrent,
          observeEffect: vi.fn(async () => {
            throw new Error("The fast path needs no effect enumeration.");
          }),
        },
      });
      expect(hookless).toMatchObject({ kind: "stopped", reason: "remote-uncertain" });
      for (const kind of ["full", "historical-legacy"] as const) {
        const historicalStore = new FileScmDeliveryReceiptStore(root);
        const classified = await executeReviewDelivery({
          plan,
          store: historicalStore,
          originAdmission: originAdmission(root, plan, historicalStore, retained),
          grantsByActionId: grantsFor(plan),
          effects: {
            prepareNextEffect: noPrepare,
            classifyCommittedOverviewPresentation: () => ({
              kind: "presentation",
              presentation: { kind, remaining, retained: retainedIdentity },
            }),
            publishEffect: vi.fn(async () => {
              throw new Error("A committed review must not POST again.");
            }),
          },
          recovery: {
            observeCurrent,
            observeEffect: vi.fn(async () => {
              throw new Error("A committed review needs no effect enumeration.");
            }),
          },
        });
        expect(classified).toMatchObject({ kind: "complete", overview: kind });
      }
      for (const forgedRetained of [
        { ...retainedIdentity, resultSha256: HASH },
        { ...retainedIdentity, actionSetSha256: HASH },
      ]) {
        const mismatchedStore = new FileScmDeliveryReceiptStore(root);
        const mismatched = await executeReviewDelivery({
          plan,
          store: mismatchedStore,
          originAdmission: originAdmission(root, plan, mismatchedStore, retained),
          grantsByActionId: grantsFor(plan),
          effects: {
            prepareNextEffect: noPrepare,
            classifyCommittedOverviewPresentation: () => ({
              kind: "presentation",
              presentation: {
                kind: "compact-partial",
                remaining,
                retained: forgedRetained,
              },
            }),
            publishEffect: vi.fn(async () => {
              throw new Error("Mismatched retained evidence must not POST.");
            }),
          },
          recovery: {
            observeCurrent,
            observeEffect: vi.fn(async () => {
              throw new Error("Mismatched retained evidence needs no effect enumeration.");
            }),
          },
        });
        expect(mismatched).toMatchObject({ kind: "stopped", reason: "remote-uncertain" });
      }

      const noSubmitRoot = await temporaryRoot();
      const noSubmitOrigin = await retainedOrigin(noSubmitRoot, plan);
      const noSubmit = await executeReviewDelivery({
        plan,
        store: noSubmitOrigin.store,
        originAdmission: noSubmitOrigin.admission,
        grantsByActionId: grantsFor(plan),
        effects: {
          prepareNextEffect: vi.fn(async ({ context, priorObservations }) =>
            priorObservations.length === 0
              ? effectFor(plan, context, "github-pending-review-create", actionIds)
              : {
                  kind: "blocked" as const,
                  actionId: actionIds[0]!,
                  code: "provider-failure" as const,
                  next: "retry" as const,
                  retryAfterAt: null,
                },
          ),
          publishEffect: vi.fn(async () => ({
            kind: "confirmed" as const,
            providerReference: "700",
          })),
        },
        recovery: {
          observeCurrent,
          observeEffect: vi.fn(async ({ effect }) => matchingGitHubReview(effect, "PENDING")),
        },
      });
      expect(noSubmit).toMatchObject({ kind: "stopped", reason: "preparation" });
      expect(noSubmit.record?.effects).toHaveLength(1);
      const noSubmitReopened = new FileScmDeliveryReceiptStore(noSubmitRoot);
      const noSubmitPublish = vi.fn(async () => ({
        kind: "confirmed" as const,
        providerReference: "700",
      }));
      const refused = await executeReviewDelivery({
        plan,
        store: noSubmitReopened,
        originAdmission: originAdmission(
          noSubmitRoot,
          plan,
          noSubmitReopened,
          noSubmitOrigin.retained,
        ),
        grantsByActionId: grantsFor(plan),
        effects: { prepareNextEffect: vi.fn(prepare), publishEffect: noSubmitPublish },
        recovery: {
          observeCurrent,
          observeEffect: vi.fn(async ({ effect }) => matchingGitHubReview(effect, "COMMENTED")),
        },
      });
      expect(refused).toMatchObject({ kind: "stopped", reason: "remote-uncertain" });
      expect(noSubmitPublish).not.toHaveBeenCalled();
    },
    RECOVERY_TEST_TIMEOUT_MS,
  );

  it(
    "does not adopt a COMMENTED GitHub review without accepted-pending create lineage",
    async () => {
      const plan = fixture("github", { inline: true, findings: 2 });
      const actionIds = plan.actions.map((action) => action.id).sort();
      const root = await temporaryRoot();
      const { store, admission, retained } = await retainedOrigin(root, plan);
      const prepare = vi.fn(
        async ({ context }: { context: Parameters<typeof reviewDeliveryEffectNonce>[0] }) =>
          effectFor(plan, context, "github-pending-review-create", actionIds),
      );
      const observeCurrent = vi.fn(async (binding: (typeof plan.actions)[number]["binding"]) => ({
        kind: "current" as const,
        target: binding.target,
        sourceSha256: binding.sourceSha256,
        snapshotSha256: binding.snapshotSha256,
        actor: binding.actor,
        headSha: binding.reviewedHeadSha,
        startSha: binding.startSha,
      }));
      const first = await executeReviewDelivery({
        plan,
        store,
        originAdmission: admission,
        grantsByActionId: grantsFor(plan),
        effects: {
          prepareNextEffect: prepare,
          publishEffect: vi.fn(async () => ({
            kind: "uncertain" as const,
            providerReference: "700",
            stop: null,
          })),
        },
        recovery: {
          observeCurrent,
          observeEffect: vi.fn(async ({ effect }) => ({
            kind: "ambiguous" as const,
            effectId: effect.effectId,
            reason: "create accepted without a usable reply",
          })),
        },
      });
      expect(first).toMatchObject({ kind: "stopped", reason: "remote-uncertain" });
      expect(first.record?.effects[0]?.state).toBe("uncertain");

      const reopened = new FileScmDeliveryReceiptStore(root);
      const publish = vi.fn(async () => ({ kind: "confirmed" as const, providerReference: "700" }));
      const second = await executeReviewDelivery({
        plan,
        store: reopened,
        originAdmission: originAdmission(root, plan, reopened, retained),
        grantsByActionId: grantsFor(plan),
        effects: { prepareNextEffect: prepare, publishEffect: publish },
        recovery: {
          observeCurrent,
          observeEffect: vi.fn(async ({ effect }) => matchingGitHubReview(effect, "COMMENTED")),
        },
      });
      expect(second).toMatchObject({ kind: "stopped", reason: "remote-uncertain" });
      expect(publish).not.toHaveBeenCalled();
    },
    RECOVERY_TEST_TIMEOUT_MS,
  );

  it.each(["gitlab", "github"] as const)(
    "settles a native-accepted %s intent after the post-call receipt write fails without replaying create",
    async (provider) => {
      const plan = fixture(provider);
      const root = await temporaryRoot();
      const faultingStore = new FileScmDeliveryReceiptStore(root);
      const durableCas = faultingStore.compareAndSwapReview.bind(faultingStore);
      vi.spyOn(faultingStore, "compareAndSwapReview").mockImplementation(
        async (expected, next, authorize) => {
          if (next.effects.some((effect) => effect.state === "uncertain"))
            throw new Error("process died before post-call receipt CAS");
          return durableCas(expected, next, authorize);
        },
      );
      const { admission, retained } = await retainedOrigin(root, plan, faultingStore);
      const action = plan.actions[0]!;
      const createStage =
        provider === "gitlab" ? "gitlab-discussion" : "github-pending-review-create";
      let createPosts = 0;
      let submitPosts = 0;
      const current = async (binding: typeof action.binding) => ({
        kind: "current" as const,
        target: binding.target,
        sourceSha256: binding.sourceSha256,
        snapshotSha256: binding.snapshotSha256,
        actor: binding.actor,
        headSha: binding.reviewedHeadSha,
        startSha: binding.startSha,
      });
      const native = (effect: ReviewDeliveryPreparedEffect) =>
        effect.stage === "gitlab-discussion"
          ? matchingGitLabDiscussion(effect)
          : effect.stage === "github-pending-review-create"
            ? {
                ...matchingGitHubReview(effect, "PENDING"),
                discovery: {
                  kind: "complete-enumeration" as const,
                  enumerationSha256: HASH,
                  matchingCandidateCount: 1,
                  directGetVerified: true,
                },
              }
            : matchingGitHubReview(effect, "COMMENTED");
      const first = await executeReviewDelivery({
        plan,
        store: faultingStore,
        originAdmission: admission,
        grantsByActionId: grantsFor(plan),
        effects: {
          prepareNextEffect: async ({ context }) =>
            effectFor(plan, context, createStage, [action.id]),
          publishEffect: async () => {
            createPosts++;
            return {
              kind: "confirmed" as const,
              providerReference: provider === "gitlab" ? "discussion:8001" : "700",
            };
          },
        },
        recovery: {
          observeCurrent: current,
          observeEffect: async ({ effect }) => native(effect),
        },
      });
      expect(first).toMatchObject({ kind: "stopped", reason: "store-uncertain" });
      expect(first.record?.effects[0]?.state).toBe("intent");
      expect(createPosts).toBe(1);
      const freshStore = new FileScmDeliveryReceiptStore(root);
      const attemptedStates: string[] = [];
      const receiptFailures: string[] = [];
      const leaseFailures: string[] = [];
      const freshLease = freshStore.withReviewDeliveryLease.bind(freshStore);
      vi.spyOn(freshStore, "withReviewDeliveryLease").mockImplementation(async (...args) => {
        try {
          return await freshLease(...args);
        } catch (error) {
          leaseFailures.push(String(error));
          throw error;
        }
      });
      const freshCas = freshStore.compareAndSwapReview.bind(freshStore);
      vi.spyOn(freshStore, "compareAndSwapReview").mockImplementation(
        async (expected, next, authorize) => {
          attemptedStates.push(
            next.effects.find((effect) => effect.stage === createStage)?.state ?? "missing",
          );
          try {
            return await freshCas(expected, next, authorize);
          } catch (error) {
            receiptFailures.push(String(error));
            throw error;
          }
        },
      );
      const freshAdmission = originAdmission(root, plan, freshStore, retained);
      const restarted = await executeReviewDelivery({
        plan,
        store: freshStore,
        originAdmission: freshAdmission,
        grantsByActionId: grantsFor(plan),
        effects: {
          prepareNextEffect: async ({ context, priorObservations }) =>
            priorObservations.length === 0
              ? effectFor(plan, context, createStage, [action.id])
              : provider === "github" && priorObservations.length === 1
                ? effectFor(plan, context, "github-comment-submit", [action.id])
                : { kind: "complete" as const },
          classifyCommittedOverviewPresentation: () => historicalClassification(plan),
          publishEffect: async ({ effect }) => {
            if (effect.stage !== "github-comment-submit")
              throw new Error("native-accepted create must never be replayed");
            submitPosts++;
            return { kind: "confirmed" as const, providerReference: "700" };
          },
        },
        recovery: {
          observeCurrent: current,
          observeEffect: async ({ effect }) => native(effect),
        },
      });
      expect(
        restarted.kind,
        `${provider}: ${"reason" in restarted ? restarted.reason : "none"}; attempted ${attemptedStates.join(",")}; errors ${receiptFailures.join(" | ")}; lease ${leaseFailures.join(" | ")}`,
      ).toBe("complete");
      expect(attemptedStates.slice(0, 2)).toEqual([
        "uncertain",
        provider === "github" ? "accepted-pending" : "confirmed",
      ]);
      expect(createPosts).toBe(1);
      expect(submitPosts).toBe(provider === "github" ? 1 : 0);
      expect(restarted.record?.effects.find((item) => item.stage === createStage)?.state).toBe(
        provider === "github" ? "accepted-pending" : "confirmed",
      );
    },
    RECOVERY_TEST_TIMEOUT_MS,
  );

  it(
    "reopens an explicit summary-only request after null-reference acceptance without replaying the note",
    async () => {
      const plan = fixture("gitlab", {
        summary: true,
        inline: true,
        requestedActions: "summary-only",
      });
      expect(plan.actions).toHaveLength(1);
      const root = await temporaryRoot();
      const { store, admission, retained } = await retainedOrigin(root, plan);
      const action = plan.actions[0]!;
      let effect: ReviewDeliveryPreparedEffect | undefined;
      let postCount = 0;
      const recovery: ReviewDeliveryRecoveryPort = {
        observeCurrent: vi.fn(async (binding: typeof action.binding) => ({
          kind: "current" as const,
          target: binding.target,
          sourceSha256: binding.sourceSha256,
          snapshotSha256: binding.snapshotSha256,
          actor: binding.actor,
          headSha: binding.reviewedHeadSha,
          startSha: binding.startSha,
        })),
        observeEffect: vi.fn(
          async ({
            effect: prepared,
            phase,
          }: Parameters<
            ReviewDeliveryRecoveryPort["observeEffect"]
          >[0]): Promise<ReviewDeliveryRemoteObservation> => {
            const record = await new FileScmDeliveryReceiptStore(root).loadReview!(
              createReviewDeliveryManifest(plan).idempotencyKey,
            );
            expect(record?.context.correlationSeed).toMatch(/^[A-Za-z0-9_-]{43}$/u);
            if (phase === "pre-dispatch-baseline") {
              expect(record?.effects).toHaveLength(0);
              return {
                kind: "absent-proven" as const,
                effectId: prepared.effectId,
                completeForActorTargetAndEffect: true,
                enumerationSha256: "1".repeat(64),
              };
            }
            return {
              kind: "ambiguous" as const,
              effectId: prepared.effectId,
              reason: "acceptance response was lost",
            };
          },
        ),
      };
      const effects1 = {
        prepareNextEffect: vi.fn(
          async ({ context }: { context: Parameters<typeof reviewDeliveryEffectNonce>[0] }) => {
            const claimed = await store.loadReview!(
              createReviewDeliveryManifest(plan).idempotencyKey,
            );
            expect(claimed?.context.correlationSeed).toBe(context.correlationSeed);
            expect(claimed?.effects).toHaveLength(0);
            effect = effectFor(plan, context, "gitlab-note", [action.id]);
            return effect;
          },
        ),
        publishEffect: vi.fn(async () => {
          postCount += 1;
          return {
            kind: "uncertain" as const,
            providerReference: null,
            stop: { code: "transport-failure" as const, retryAfterAt: null },
          };
        }),
      };
      const correlationAdmission = createReviewDeliveryCorrelationAdmission({
        verifyCurrent: () => ({
          status: "supported",
          channel: "exclusive-actor-writer-complete-stable-notes",
        }),
      });
      const initial = await executeReviewDelivery({
        plan,
        store,
        originAdmission: admission,
        correlationAdmission,
        grantsByActionId: grantsFor(plan),
        effects: effects1,
        recovery,
      });
      expect(initial).toMatchObject({ kind: "stopped", reason: "remote-uncertain" });
      expect(initial.record?.effects[0]).toMatchObject({
        state: "uncertain",
        providerReference: null,
        baseline: { enumerationSha256: "1".repeat(64) },
      });
      expect(postCount).toBe(1);
      const seed = initial.record!.context.correlationSeed;

      // A separate Node process opens the durable journal after the simulated crash.
      const child = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "-e",
          `import { FileScmDeliveryReceiptStore } from './src/delivery/receipt-store.ts'; const s = new FileScmDeliveryReceiptStore(${JSON.stringify(root)}); const r = await s.loadReview(${JSON.stringify(createReviewDeliveryManifest(plan).idempotencyKey)}); process.stdout.write(r?.context.correlationSeed ?? 'missing');`,
        ],
        { cwd: process.cwd(), encoding: "utf8", timeout: CHILD_REOPEN_TIMEOUT_MS },
      );
      expect(child.status).toBe(0);
      expect(child.stdout).toBe(seed);

      const freshStore = new FileScmDeliveryReceiptStore(root);
      const observations = [] as ReviewDeliveryRemoteObservation[];
      let rebuilt: ReviewDeliveryPreparedEffect | undefined;
      let freshPreparations = 0;
      const freshEffects = {
        prepareNextEffect: vi.fn(
          async ({ context }: { context: Parameters<typeof reviewDeliveryEffectNonce>[0] }) => {
            freshPreparations++;
            if (freshPreparations > 1) return { kind: "complete" as const };
            rebuilt = effectFor(plan, context, "gitlab-note", [action.id]);
            return rebuilt;
          },
        ),
        publishEffect: vi.fn(async () => {
          postCount += 1;
          return {
            kind: "uncertain" as const,
            providerReference: null,
            stop: { code: "transport-failure" as const, retryAfterAt: null },
          };
        }),
      };
      const freshRecovery: ReviewDeliveryRecoveryPort = {
        ...recovery,
        observeEffect: vi.fn(
          async ({
            effect: prepared,
            phase,
          }: {
            effect: ReviewDeliveryPreparedEffect;
            phase: "pre-dispatch-baseline" | "recovery";
          }): Promise<ReviewDeliveryRemoteObservation> => {
            if (phase === "pre-dispatch-baseline")
              throw new Error("baseline must not repeat for an unresolved intent");
            observations.push(matchingGitLabNote(prepared, "2".repeat(64)));
            return observations.at(-1)!;
          },
        ),
      };
      const freshAdmission = originAdmission(root, plan, freshStore, retained);
      const restarted = await executeReviewDelivery({
        plan,
        store: freshStore,
        originAdmission: freshAdmission,
        correlationAdmission,
        grantsByActionId: grantsFor(plan),
        effects: freshEffects,
        recovery: freshRecovery,
      });
      expect(restarted.kind).toBe("complete");
      if (restarted.kind !== "complete")
        throw new Error("expected authenticated restart settlement");
      expect(rebuilt?.marker).toBe(effect?.marker);
      expect(rebuilt?.outboundBytesSha256).toBe(effect?.outboundBytesSha256);
      expect(postCount).toBe(1);
      expect(restarted.record.effects[0]?.providerReference).toBe("9001");
    },
    RECOVERY_TEST_TIMEOUT_MS,
  );

  it.each(["unsupported", "preexisting-identical", "incomplete-scan"] as const)(
    "retains null-reference note uncertainty for %s evidence and never reposts",
    async (control) => {
      const plan = fixture("gitlab", { summary: true, inline: false });
      const root = await temporaryRoot();
      const { store, admission, retained } = await retainedOrigin(root, plan);
      const action = plan.actions[0]!;
      let prepared: ReviewDeliveryPreparedEffect | undefined;
      let posts = 0;
      const effects = {
        prepareNextEffect: vi.fn(
          async ({ context }: { context: Parameters<typeof reviewDeliveryEffectNonce>[0] }) => {
            prepared = effectFor(plan, context, "gitlab-note", [action.id]);
            return prepared;
          },
        ),
        publishEffect: vi.fn(async () => {
          posts += 1;
          return {
            kind: "uncertain" as const,
            providerReference: null,
            stop: { code: "transport-failure" as const, retryAfterAt: null },
          };
        }),
      };
      const recovery: ReviewDeliveryRecoveryPort = {
        observeCurrent: vi.fn(async (binding: typeof action.binding) => ({
          kind: "current" as const,
          target: binding.target,
          sourceSha256: binding.sourceSha256,
          snapshotSha256: binding.snapshotSha256,
          actor: binding.actor,
          headSha: binding.reviewedHeadSha,
          startSha: binding.startSha,
        })),
        observeEffect: vi.fn(
          async ({
            effect: item,
            phase: observedPhase,
          }: Parameters<
            ReviewDeliveryRecoveryPort["observeEffect"]
          >[0]): Promise<ReviewDeliveryRemoteObservation> => {
            if (observedPhase === "pre-dispatch-baseline")
              return {
                kind: "absent-proven" as const,
                effectId: item.effectId,
                completeForActorTargetAndEffect: true,
                enumerationSha256: "3".repeat(64),
              };
            if (control === "preexisting-identical")
              return {
                kind: "ambiguous" as const,
                effectId: item.effectId,
                reason: "candidate predates baseline",
              };
            if (control === "incomplete-scan")
              return {
                kind: "unavailable" as const,
                effectId: item.effectId,
                reason: "enumeration incomplete",
              };
            return matchingGitLabNote(item, "4".repeat(64));
          },
        ),
      };
      const correlationAdmission = createReviewDeliveryCorrelationAdmission({
        verifyCurrent: () =>
          control === "unsupported"
            ? { status: "unsupported" }
            : { status: "supported", channel: "exclusive-actor-writer-complete-stable-notes" },
      });
      const first = await executeReviewDelivery({
        plan,
        store,
        originAdmission: admission,
        correlationAdmission,
        grantsByActionId: grantsFor(plan),
        effects,
        recovery,
      });
      const secondStore = new FileScmDeliveryReceiptStore(root);
      const secondAdmission = originAdmission(root, plan, secondStore, retained);
      const second = await executeReviewDelivery({
        plan,
        store: secondStore,
        originAdmission: secondAdmission,
        correlationAdmission,
        grantsByActionId: grantsFor(plan),
        effects,
        recovery,
      });
      expect(first).toMatchObject({ kind: "stopped", reason: "remote-uncertain" });
      expect(second).toMatchObject({ kind: "stopped", reason: "remote-uncertain" });
      expect(posts).toBe(1);
      expect(second.record?.effects[0]?.state).toBe("uncertain");
      expect(prepared?.marker).toBeTruthy();
    },
    RECOVERY_TEST_TIMEOUT_MS,
  );

  it(
    "records an invoked 429 with Retry-After as uncertain and refuses blind replay",
    async () => {
      const plan = fixture("gitlab", { summary: true, inline: false });
      const root = await temporaryRoot();
      const { store, admission } = await retainedOrigin(root, plan);
      const action = plan.actions[0]!;
      let posts = 0;
      let effect: ReviewDeliveryPreparedEffect | undefined;
      const effects = {
        prepareNextEffect: vi.fn(
          async ({ context }: { context: Parameters<typeof reviewDeliveryEffectNonce>[0] }) => {
            effect = effectFor(plan, context, "gitlab-note", [action.id]);
            return effect;
          },
        ),
        publishEffect: vi.fn(async () => {
          posts++;
          return {
            kind: "uncertain" as const,
            providerReference: null,
            stop: { code: "rate-limited" as const, retryAfterAt: "2026-10-15T13:00:00.000Z" },
          };
        }),
      };
      const recovery: ReviewDeliveryRecoveryPort = {
        observeCurrent: vi.fn(async (binding: typeof action.binding) => ({
          kind: "current" as const,
          target: binding.target,
          sourceSha256: binding.sourceSha256,
          snapshotSha256: binding.snapshotSha256,
          actor: binding.actor,
          headSha: binding.reviewedHeadSha,
          startSha: binding.startSha,
        })),
        observeEffect: vi.fn(
          async ({
            effect: item,
            phase,
          }: Parameters<
            ReviewDeliveryRecoveryPort["observeEffect"]
          >[0]): Promise<ReviewDeliveryRemoteObservation> =>
            phase === "pre-dispatch-baseline"
              ? {
                  kind: "absent-proven" as const,
                  effectId: item.effectId,
                  completeForActorTargetAndEffect: true,
                  enumerationSha256: "5".repeat(64),
                }
              : {
                  kind: "ambiguous" as const,
                  effectId: item.effectId,
                  reason: "429 followed an invoked request",
                },
        ),
      };
      const result = await executeReviewDelivery({
        plan,
        store,
        originAdmission: admission,
        grantsByActionId: grantsFor(plan),
        effects,
        recovery,
      });
      expect(result).toMatchObject({
        kind: "stopped",
        reason: "remote-uncertain",
        record: {
          effects: [
            {
              state: "uncertain",
              stop: { code: "rate-limited", retryAfterAt: "2026-10-15T13:00:00.000Z" },
            },
          ],
        },
      });
      expect(posts).toBe(1);
      expect(effect).toBeDefined();
    },
    RECOVERY_TEST_TIMEOUT_MS,
  );

  it(
    "stores typed preparation blocks without creating an effect intent or invoking HTTP",
    async () => {
      const plan = fixture("gitlab", { summary: false, inline: true });
      const root = await temporaryRoot();
      const { store, admission } = await retainedOrigin(root, plan);
      const action = plan.actions[0]!;
      const recovery = {
        observeCurrent: vi.fn(async (binding: typeof action.binding) => ({
          kind: "current" as const,
          target: binding.target,
          sourceSha256: binding.sourceSha256,
          snapshotSha256: binding.snapshotSha256,
          actor: binding.actor,
          headSha: binding.reviewedHeadSha,
          startSha: binding.startSha,
        })),
        observeEffect: vi.fn(),
      };
      const effects = {
        prepareNextEffect: vi.fn(async () => ({
          kind: "blocked" as const,
          actionId: action.id,
          code: "position-unprovable" as const,
          next: "replan-required" as const,
          retryAfterAt: null,
        })),
        publishEffect: vi.fn(),
      };
      const result = await executeReviewDelivery({
        plan,
        store,
        originAdmission: admission,
        grantsByActionId: grantsFor(plan),
        effects,
        recovery,
      });
      expect(result).toMatchObject({
        kind: "stopped",
        reason: "preparation",
        record: {
          effects: [],
          preparationStop: {
            actionId: action.id,
            code: "position-unprovable",
            next: "replan-required",
          },
        },
      });
      expect(effects.publishEffect).not.toHaveBeenCalled();
    },
    RECOVERY_TEST_TIMEOUT_MS,
  );

  it(
    "settles a GitLab discussion only after exact null-reference position readback",
    async () => {
      const plan = fixture("gitlab", { inline: true });
      const root = await temporaryRoot();
      const { store, admission, retained } = await retainedOrigin(root, plan);
      const action = plan.actions[0]!;
      let effect: ReviewDeliveryPreparedEffect | undefined;
      let preparations = 0;
      let invalidPosition = true;
      let posts = 0;
      const effects = {
        prepareNextEffect: vi.fn(
          async ({ context }: { context: Parameters<typeof reviewDeliveryEffectNonce>[0] }) => {
            preparations++;
            if (preparations > 2) return { kind: "complete" as const };
            effect = effectFor(plan, context, "gitlab-discussion", [action.id]);
            return effect;
          },
        ),
        publishEffect: vi.fn(async () => {
          posts++;
          return {
            kind: "uncertain" as const,
            providerReference: null,
            stop: { code: "transport-failure" as const, retryAfterAt: null },
          };
        }),
      };
      const recovery: ReviewDeliveryRecoveryPort = {
        observeCurrent: vi.fn(async (binding) => ({
          kind: "current" as const,
          target: binding.target,
          sourceSha256: binding.sourceSha256,
          snapshotSha256: binding.snapshotSha256,
          actor: binding.actor,
          headSha: binding.reviewedHeadSha,
          startSha: binding.startSha,
        })),
        observeEffect: vi.fn(
          async ({
            effect: prepared,
            phase,
          }: Parameters<
            ReviewDeliveryRecoveryPort["observeEffect"]
          >[0]): Promise<ReviewDeliveryRemoteObservation> => {
            if (phase === "pre-dispatch-baseline")
              throw new Error("discussions do not use a note baseline");
            if (invalidPosition)
              return { kind: "ambiguous", effectId: prepared.effectId, reason: "position differs" };
            const position = prepared.expectedGitLabPosition!;
            return {
              kind: "matching",
              effectId: prepared.effectId,
              providerReference: "discussion:41",
              native: {
                kind: "gitlab-discussion",
                projectId: 42,
                mergeRequestIid: 7,
                discussionId: "discussion:41",
                noteId: 904,
                author: { host: "gitlab.example.com", id: "user:42" },
                body: `review body ${prepared.effectId}`,
                position,
              },
              actionReferences: prepared.coveredActionIds.map((actionId) => ({
                actionId,
                nativeReference: "904",
              })),
              discovery: {
                kind: "complete-enumeration",
                enumerationSha256: "6".repeat(64),
                matchingCandidateCount: 1,
                directGetVerified: true,
              },
              lifecycle: "final-published",
            };
          },
        ),
      };
      const first = await executeReviewDelivery({
        plan,
        store,
        originAdmission: admission,
        grantsByActionId: grantsFor(plan),
        effects,
        recovery,
      });
      expect(first).toMatchObject({ kind: "stopped", reason: "remote-uncertain" });
      expect(first.record?.effects[0]?.state).toBe("uncertain");
      expect(posts).toBe(1);

      invalidPosition = false;
      const reopenedStore = new FileScmDeliveryReceiptStore(root);
      const reopenedAdmission = originAdmission(root, plan, reopenedStore, retained);
      const settled = await executeReviewDelivery({
        plan,
        store: reopenedStore,
        originAdmission: reopenedAdmission,
        grantsByActionId: grantsFor(plan),
        effects,
        recovery,
      });
      expect(settled.kind).toBe("complete");
      if (settled.kind !== "complete")
        throw new Error("expected exact discussion readback to settle");
      expect(settled.record.effects[0]).toMatchObject({
        state: "confirmed",
        providerReference: "discussion:41",
      });
      expect(settled.record.effects[0]?.expectedGitLabPositionSha256).toBeTruthy();
      expect(posts).toBe(1);
      expect(effect?.expectedGitLabPosition).toMatchObject({
        oldLine: null,
        newLine: 1,
        lineRange: null,
      });
    },
    RECOVERY_TEST_TIMEOUT_MS,
  );

  it.each(["exact", "missingMapping", "commitId", "reviewId", "author"] as const)(
    "settles or rejects GitHub native comments with %s evidence",
    async (wrongField) => {
      const plan = fixture("github", { inline: true, findings: 2 });
      expect(plan.actions).toHaveLength(2);
      const root = await temporaryRoot();
      const { store, admission } = await retainedOrigin(root, plan);
      const actionIds = plan.actions.map((action) => action.id).sort();
      let stage: "github-pending-review-create" | "github-comment-submit" | "complete" =
        "github-pending-review-create";
      let createdReferences: { actionId: string; nativeReference: string }[] = [];
      let submitCount = 0;
      const effects = {
        classifyCommittedOverviewPresentation: () => historicalClassification(plan),
        prepareNextEffect: vi.fn(
          async ({ context }: { context: Parameters<typeof reviewDeliveryEffectNonce>[0] }) =>
            stage === "complete"
              ? { kind: "complete" as const }
              : effectFor(plan, context, stage, actionIds),
        ),
        publishEffect: vi.fn(async ({ effect }: { effect: ReviewDeliveryPreparedEffect }) => {
          if (effect.stage === "github-pending-review-create") stage = "github-comment-submit";
          else {
            submitCount++;
            stage = "complete";
          }
          return { kind: "confirmed" as const, providerReference: "700" };
        }),
      };
      const recovery = {
        observeCurrent: vi.fn(async (binding: (typeof plan.actions)[number]["binding"]) => ({
          kind: "current" as const,
          target: binding.target,
          sourceSha256: binding.sourceSha256,
          snapshotSha256: binding.snapshotSha256,
          actor: binding.actor,
          headSha: binding.reviewedHeadSha,
          startSha: binding.startSha,
        })),
        observeEffect: vi.fn(
          async ({
            effect,
            phase,
          }: {
            effect: ReviewDeliveryPreparedEffect;
            phase: "pre-dispatch-baseline" | "recovery";
          }): Promise<ReviewDeliveryRemoteObservation> => {
            if (effect.stage === "github-pending-review-create") {
              createdReferences = effect.coveredActionIds.map((actionId, index) => ({
                actionId,
                nativeReference: String(800 + index),
              }));
              return {
                kind: "matching",
                effectId: effect.effectId,
                providerReference: "700",
                native: {
                  kind: "github-review",
                  repositoryId: 100,
                  pullRequestNumber: 7,
                  reviewId: 700,
                  author: { host: "github.com", id: "user:42" },
                  body: "",
                  commitId: HEAD,
                  state: "PENDING",
                  comments: effect.coveredActionIds.map((actionId, index) => ({
                    commentId: 800 + index,
                    commitId: HEAD,
                    reviewId: 700,
                    author: { host: "github.com", id: "user:42" },
                    body: `native comment ${actionId}`,
                    path: "docs/guide.md",
                    line: 1,
                    side: "RIGHT",
                  })),
                },
                actionReferences: createdReferences,
                discovery: { kind: "direct-reference" },
                lifecycle: "accepted-pending",
              };
            }
            const references =
              wrongField === "missingMapping" ? createdReferences.slice(0, -1) : createdReferences;
            const comments = effect.coveredActionIds.map((actionId, index) => ({
              commentId: 800 + index,
              commitId: wrongField === "commitId" ? BASE : HEAD,
              reviewId: wrongField === "reviewId" ? 701 : 700,
              author: { host: "github.com", id: wrongField === "author" ? "user:99" : "user:42" },
              body: `native comment ${actionId}`,
              path: "docs/guide.md",
              line: 1,
              side: "RIGHT" as const,
            }));
            return {
              kind: "matching",
              effectId: effect.effectId,
              providerReference: "700",
              native: {
                kind: "github-review",
                repositoryId: 100,
                pullRequestNumber: 7,
                reviewId: 700,
                author: { host: "github.com", id: "user:42" },
                body: "",
                commitId: HEAD,
                state: "COMMENTED",
                comments,
              },
              actionReferences: references,
              discovery: { kind: "direct-reference" },
              lifecycle: "final-published",
            };
          },
        ),
      };
      const result = await executeReviewDelivery({
        plan,
        store,
        originAdmission: admission,
        grantsByActionId: grantsFor(plan),
        effects,
        recovery,
      });
      if (wrongField === "exact") {
        expect(result.kind).toBe("complete");
        expect(
          result.record?.effects.find((item) => item.stage === "github-comment-submit")?.state,
        ).toBe("confirmed");
      } else {
        expect(result).toMatchObject({ kind: "stopped", reason: "remote-uncertain" });
        expect(
          result.record?.effects.find((item) => item.stage === "github-comment-submit")?.state,
        ).toBe("uncertain");
      }
      expect(
        result.record?.effects.find((item) => item.stage === "github-pending-review-create")?.state,
      ).toBe("accepted-pending");
      expect(submitCount).toBe(1);
      expect(recovery.observeEffect).toHaveBeenCalledTimes(2);
    },
    RECOVERY_TEST_TIMEOUT_MS,
  );
});
