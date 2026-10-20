// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalJson, sha256 } from "../src/content-ir/canonical.js";
import { LIMIT_DEFINITION_BY_NAME } from "../src/config/limits.generated.js";
import {
  createChangeSource,
  type ChangeSourceSourceV1,
  type ChangeSourceV1,
} from "../src/inputs/change-source.js";
import { githubRepositoryIdentity } from "../src/inputs/change-source/revision.js";
import { createReviewResultV2, createReviewTargetV2 } from "../src/review/index.js";
import {
  createReviewDeliveryPlan,
  createReviewDeliveryGrant,
} from "../src/review-delivery/plan.js";
import type {
  ReviewDeliveryPlan,
  ReviewDeliveryRequestedActions,
  ReviewDeliverySnapshot,
} from "../src/review-delivery/contracts.js";
import {
  executeReviewDelivery,
  reviewDeliveryBodySha256,
  reviewDeliveryOutboundBytesSha256,
  type ReviewDeliveryEffectContextV1,
  type ReviewDeliveryPreparedEffect,
} from "../src/review-delivery/execute.js";
import type { ReviewDeliveryCommittedEffectV1 } from "../src/review-delivery/receipt.js";
import { createLocalReviewDeliveryOriginAdmission } from "../src/review-delivery/custody.js";
import { FileScmDeliveryReceiptStore } from "../src/delivery/receipt-store.js";
import { DurableArtifactStore } from "../src/artifacts/store.js";
import { FileRunStore } from "../src/records/file-store.js";
import type { RunRecord } from "../src/records/contracts.js";
import {
  createGithubReviewAdapter,
  type GithubReviewFetchPort,
} from "../src/review-delivery/providers/github.js";
import { renderGithubReviewBody } from "../src/review-delivery/providers/github-render.js";
import { hookTimeoutMs, testTimeoutMs } from "./helpers/test-timeouts.js";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const HASH = "d".repeat(64);
const AFTER = new TextEncoder().encode("first\nsecond\n");
const roots: string[] = [];
const fixtures = new URL("./fixtures/review-delivery/github/", import.meta.url);

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(name: "pending-review" | "submitted-review") {
  return JSON.parse(await readFile(new URL(`${name}.json`, fixtures), "utf8")) as Record<
    string,
    unknown
  >;
}

function planFixture(
  options: {
    summary?: boolean;
    hostile?: boolean;
    inline?: boolean;
    change?: "addition" | "deletion" | "rename";
    hostedReportUrl?: string;
    fullName?: string;
    requestedActions?: "overview" | "summary-only";
    zeroFindings?: boolean;
    overviewContent?: boolean;
    largeQuestions?: boolean;
    questionCharacter?: "x" | "é";
  } = {},
): {
  plan: ReviewDeliveryPlan<ChangeSourceV1>;
  snapshot: ReviewDeliverySnapshot;
} {
  const source = createChangeSource({
    source: {
      kind: "github-pull-request",
      provenance: "forge-reported",
      host: "github.com",
      repositoryId: 100,
      fullName: options.fullName ?? "team/docs",
      number: 7,
      state: "open",
      headRepositoryId: 200,
    } as ChangeSourceSourceV1,
    revision: {
      schemaVersion: 1,
      kind: "docsfab-pinned-repository-revision",
      repository: githubRepositoryIdentity({ host: "github.com", repositoryId: 100 }),
      base: BASE,
      head: HEAD,
    },
    objectFormat: "sha1",
    rangeSemantics: "three-dot",
    mergeBase: BASE,
    diffFrom: BASE,
    baseTree: null,
    headTree: null,
    commits: [{ id: HEAD, parents: [BASE], subject: "Update docs" }],
    files: [
      {
        status: options.change === "deletion" ? "D" : options.change === "rename" ? "R" : "A",
        similarity: options.change === "rename" ? 100 : null,
        oldPath:
          options.change === "rename"
            ? "docs/old.md"
            : options.change === "deletion"
              ? "docs/guide.md"
              : null,
        newPath: options.change === "deletion" ? null : "docs/guide.md",
        oldMode: null,
        newMode: null,
        oldBlob: null,
        newBlob: null,
        binary: false,
        added: options.change === "deletion" ? 0 : options.change === "rename" ? 0 : 2,
        removed: options.change === "deletion" ? 2 : 0,
      },
    ],
    labels: [],
    protocol: { provider: "github" },
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
      scmProvider: "github",
      host: "github.com",
      repositoryId: 100,
      headRepositoryId: 200,
      pullRequestNumber: 7,
    },
    source,
  );
  const result = createReviewResultV2(target, source, {
    taskId: "task:7",
    runIdSha256: HASH,
    findings: options.zeroFindings
      ? []
      : [
          {
            id: "finding:1",
            severity: "warning",
            code: options.overviewContent ? "template:missing-required-heading" : "docs-gap",
            summary: "Explain first value.",
            path: options.change === "rename" ? "docs/old.md" : "docs/guide.md",
            line: 1,
            ...(options.overviewContent
              ? {
                  evidence: "Template audit found the heading gap.",
                  recommendation: "Add one title.",
                }
              : {}),
          },
          {
            id: "finding:2",
            severity: "warning",
            code: "docs-gap",
            summary: "Explain second value.",
            path: "docs/guide.md",
            line: 2,
          },
          ...(options.summary === false
            ? []
            : [
                {
                  id: "finding:3",
                  severity: "warning" as const,
                  code: "summary-gap",
                  summary: options.hostile
                    ? "@attacker <script> [link](https://evil.test) ~~~suggestion"
                    : "Add a migration note.",
                  path: null,
                },
              ]),
        ],
    checks: options.overviewContent
      ? [{ id: "check:source", name: "@reviewer <script> source check", status: "passed" }]
      : [],
    unresolvedQuestions: options.largeQuestions
      ? Array.from(
          {
            length:
              Math.ceil(
                LIMIT_DEFINITION_BY_NAME["githubReview.bodyMaxBytes"]!.value /
                  LIMIT_DEFINITION_BY_NAME["reviewFindings.resultSummaryMaxChars"]!.value,
              ) + 1,
          },
          (_, index) => ({
            id: `question:${String(index).padStart(4, "0")}`,
            summary: `Question ${index}: ${(options.questionCharacter ?? "x").repeat(LIMIT_DEFINITION_BY_NAME["reviewFindings.resultSummaryMaxChars"]!.value - String(index).length - 11)}`,
          }),
        )
      : options.overviewContent
        ? [
            {
              id: "question:current",
              summary: `Is [the example](https://evil.test) current?${options.questionCharacter === "é" ? " é" : ""}`,
            },
          ]
        : [],
    affectedPaths: ["docs/guide.md"],
    ...(options.overviewContent
      ? {
          reviewScope: {
            scope: "focused-docs",
            reviewedCount: 1,
            corpusFileCount: 2,
            deferredPaths: ["docs/later.md"],
            anchorPaths: [],
            scopeSha256: HASH,
            reviewRevision: HEAD,
            accounting: {
              radiusSha256: HASH,
              radiusPageCount: 2,
              listedPageCount: 2,
              unlistedPageCount: 0,
              unreviewableNeighbourCount: 0,
              changedPathCount: 1,
              continuationCharacterLimit:
                LIMIT_DEFINITION_BY_NAME["reviewFindings.coverageContinuationMinChars"]!.value,
            },
            canonSha256: HASH,
            templateCoverage: {
              reportDigest: HASH,
              pages: [
                {
                  path: "docs/guide.md",
                  mapping: "mapped",
                  applicability: "applicable",
                  reason: "template source checked",
                  templateId: "template:guide",
                  conformance: "passed",
                  rules: [
                    {
                      rule: "missing-required-heading",
                      severity: "warning",
                      expected: "One title",
                      line: 1,
                    },
                  ],
                  suggestionIds: options.zeroFindings ? [] : ["finding:1"],
                  rubric: { status: "unknown", reason: "selected rubric unavailable" },
                },
              ],
            },
          },
          skippedPaths: [{ path: "docs/skipped.md", reason: "not reviewed <script>" }],
        }
      : {}),
    patchLocator: { kind: "artifact-digest", digestSha256: HASH },
    locatorSha256: null,
    ...(options.hostedReportUrl ? { hostedReportUrl: options.hostedReportUrl } : {}),
  });
  const snapshot: ReviewDeliverySnapshot = {
    changeSourceSha256: source.changeSourceSha256,
    files: [
      {
        oldPath:
          options.change === "rename"
            ? "docs/old.md"
            : options.change === "deletion"
              ? "docs/guide.md"
              : null,
        newPath: options.change === "deletion" ? null : "docs/guide.md",
        beforeBytes: options.change === "addition" || options.change === undefined ? null : AFTER,
        afterBytes: options.change === "deletion" ? null : AFTER,
        beforeSha256:
          options.change === "addition" || options.change === undefined ? null : sha256(AFTER),
        afterSha256: options.change === "deletion" ? null : sha256(AFTER),
        state: "complete",
        hunks: [
          {
            lines: [
              {
                kind:
                  options.change === "deletion"
                    ? "removed"
                    : options.change === "rename"
                      ? "context"
                      : "added",
                text: "first",
                beforeLine:
                  options.change === "addition" || options.change === undefined ? null : 1,
                afterLine: options.change === "deletion" ? null : 1,
              },
              {
                kind:
                  options.change === "deletion"
                    ? "removed"
                    : options.change === "rename"
                      ? "context"
                      : "added",
                text: "second",
                beforeLine:
                  options.change === "addition" || options.change === undefined ? null : 2,
                afterLine: options.change === "deletion" ? null : 2,
              },
            ],
          },
        ],
      },
    ],
  };
  return {
    plan: createReviewDeliveryPlan({
      target,
      source,
      result,
      snapshot,
      artifact: {
        kind: "retained-review-result",
        id: "artifact:7",
        resultSha256: result.resultSha256,
      },
      actor: { host: "github.com", id: "user:42" },
      capabilities: {
        scmProvider: "github",
        host: "github.com",
        summary: true,
        inline: options.inline !== false,
      },
      ...(options.requestedActions ? { requestedActions: options.requestedActions } : {}),
    }),
    snapshot,
  };
}

function committed(effect: ReviewDeliveryPreparedEffect): ReviewDeliveryCommittedEffectV1 {
  return {
    effectId: effect.effectId,
    stage: effect.stage,
    coveredActionIds: effect.coveredActionIds,
    actionPayloads: effect.actionPayloads,
    outboundBytesSha256: effect.outboundBytesSha256,
    expectedBodySha256: effect.expectedBodySha256,
    expectedGitLabPositionSha256: null,
    marker: effect.marker,
  };
}

function legacyCreateEffect(
  prepared: ReviewDeliveryPreparedEffect,
  plan: ReviewDeliveryPlan<ChangeSourceV1>,
): ReviewDeliveryPreparedEffect {
  const summary = plan.actions.find((action) => action.kind === "publish-summary") as
    | Extract<(typeof plan.actions)[number], { kind: "publish-summary" }>
    | undefined;
  const terseBody = renderGithubReviewBody(plan, summary, prepared.marker);
  const request = {
    ...prepared.request,
    bodyBytes: new TextEncoder().encode(
      JSON.stringify({
        ...JSON.parse(Buffer.from(prepared.request.bodyBytes).toString("utf8")),
        body: terseBody,
      }),
    ),
  };
  return {
    ...prepared,
    request,
    ...(prepared.overviewPresentation === undefined
      ? {}
      : {
          overviewPresentation: {
            ...prepared.overviewPresentation,
            kind: "historical-legacy" as const,
          },
        }),
    outboundBytesSha256: reviewDeliveryOutboundBytesSha256(request),
    expectedBodySha256: reviewDeliveryBodySha256(terseBody),
    actionPayloads: prepared.actionPayloads.map((payload) =>
      payload.anchorSha256 === null
        ? { ...payload, bodySha256: reviewDeliveryBodySha256(terseBody) }
        : payload,
    ),
  };
}

class FakeGithub {
  readonly calls: {
    method: string;
    path: string;
    redirect: RequestRedirect;
    authorized: boolean;
    body: unknown;
  }[] = [];
  readonly fetch: GithubReviewFetchPort = async (url, init) => {
    const parsed = new URL(url);
    const path = `${parsed.pathname}${parsed.search}`;
    const method = init.method ?? "GET";
    const headers = new Headers(init.headers);
    const body = init.body ? JSON.parse(Buffer.from(init.body as Buffer).toString("utf8")) : null;
    const reviewBase = `/repos/${this.repositoryFullName}/pulls/7`;
    this.calls.push({
      method,
      path,
      redirect: init.redirect!,
      authorized: headers.has("authorization"),
      body,
    });
    if (
      parsed.origin !== "https://api.github.com" ||
      init.redirect !== "manual" ||
      !headers.has("authorization")
    )
      throw new Error("Credential escaped selected GitHub API origin.");
    if (path === "/user") return Response.json({ id: this.userId, login: "docs-reviewer" });
    if (path === `/repos/${this.repositoryFullName}`)
      return this.privateStatus === null
        ? Response.json({ id: 100, full_name: this.repositoryFullName })
        : Response.json({ message: "not available" }, { status: this.privateStatus });
    if (path === reviewBase)
      return Response.json({
        number: 7,
        state: "open",
        changed_files: this.changedFiles,
        head: { sha: this.movedHead ? BASE : HEAD, repo: { id: this.wrongFork ? 201 : 200 } },
        base: { sha: BASE, repo: { id: 100 } },
      });
    if (path === `${reviewBase}/files`) {
      if (this.moveHeadAfterFiles) this.movedHead = true;
      this.filePage2Rows = this.fileListRows ?? [
        {
          filename: "docs/guide.md",
          status:
            this.change === "deletion" ? "removed" : this.change === "rename" ? "renamed" : "added",
          ...(this.change === "rename" ? { previous_filename: "docs/old.md" } : {}),
          ...this.filePatch,
        },
      ];
      return this.paginateFiles
        ? Response.json([], {
            headers: {
              Link: `<https://api.github.com${reviewBase}/files?page=2>; rel="next"`,
            },
          })
        : Response.json(this.filePage2Rows);
    }
    if (path === `${reviewBase}/files?page=2` && this.paginateFiles)
      return Response.json(this.filePage2Rows);
    if (method === "POST" && path === `${reviewBase}/reviews`) {
      this.posts++;
      if (this.createResponse) return this.createResponse();
      this.reviewBody = (body as { body: string }).body;
      this.comments = (body as { comments: Record<string, unknown>[] }).comments.map(
        (item, index) => ({
          id: 800 + index,
          pull_request_review_id: 700,
          user: { id: 42 },
          commit_id: HEAD,
          body: item.body,
          path: item.path,
          line: item.line,
          side: item.side,
          start_line: item.start_line ?? null,
          start_side: item.start_side ?? null,
          ...(index === 0 ? this.commentPatch : {}),
        }),
      );
      if (this.duplicateComment) this.comments.push({ ...this.comments[0], id: 899 });
      this.state = this.autoSubmittedOnCreate ? "COMMENTED" : "PENDING";
      if (this.timeoutCreate) throw new Error("connection lost after GitHub accepted create");
      return Response.json({ id: 700 }, { status: 200 });
    }
    if (method === "POST" && path === `${reviewBase}/reviews/700/events`) {
      this.posts++;
      if (this.submitResponse) return this.submitResponse();
      this.state = "COMMENTED";
      if (this.timeoutSubmit) throw new Error("connection lost after GitHub accepted submit");
      return Response.json({ id: 700 }, { status: 200 });
    }
    if (method === "GET" && path === `${reviewBase}/reviews`) {
      if (this.failReviewList) return Response.json({ message: "wait" }, { status: 429 });
      const rows = [
        { id: 701, body: "Someone else's pending review", user: { id: 42 }, commit_id: HEAD },
      ];
      if (this.state && !this.omitCreatedReview)
        rows.push({ id: 700, body: this.reviewBody, user: { id: 42 }, commit_id: HEAD });
      if (this.duplicateReview && this.state)
        rows.push({ id: 702, body: this.reviewBody, user: { id: 42 }, commit_id: HEAD });
      return Response.json(rows, {
        headers: this.reviewListLink ? { Link: this.reviewListLink } : {},
      });
    }
    if (method === "GET" && path === `${reviewBase}/reviews/700`) {
      const data = await fixture(
        this.state === "COMMENTED" ? "submitted-review" : "pending-review",
      );
      return Response.json({
        ...data,
        body: this.reviewBody,
        pull_request_url: `https://api.github.com${reviewBase}`,
      });
    }
    if (method === "GET" && path === `${reviewBase}/reviews/700/comments`) {
      return Response.json(this.paginateComments ? this.comments.slice(0, 1) : this.comments, {
        headers: this.commentListLink
          ? { Link: this.commentListLink }
          : this.paginateComments
            ? {
                Link: `<https://api.github.com${reviewBase}/reviews/700/comments?page=2>; rel="next"`,
              }
            : {},
      });
    }
    if (
      method === "GET" &&
      path === `${reviewBase}/reviews/700/comments?page=2` &&
      this.paginateComments
    )
      return Response.json(this.comments.slice(1));
    return Response.json({ message: "not found" }, { status: 404 });
  };
  userId = 42;
  repositoryFullName = "team/docs";
  failReviewList = false;
  posts = 0;
  state: "PENDING" | "COMMENTED" | null = null;
  reviewBody = "";
  comments: Record<string, unknown>[] = [];
  timeoutCreate = false;
  timeoutSubmit = false;
  movedHead = false;
  moveHeadAfterFiles = false;
  wrongFork = false;
  changedFiles = 1;
  fileListRows: readonly Record<string, unknown>[] | null = null;
  filePage2Rows: readonly Record<string, unknown>[] = [];
  filePatch: Record<string, unknown> = {};
  paginateFiles = false;
  privateStatus: 403 | 404 | null = null;
  change: "addition" | "deletion" | "rename" = "addition";
  commentPatch: Record<string, unknown> = {};
  duplicateComment = false;
  omitCreatedReview = false;
  duplicateReview = false;
  reviewListLink: string | null = null;
  commentListLink: string | null = null;
  paginateComments = false;
  createResponse: (() => Response) | null = null;
  submitResponse: (() => Response) | null = null;
  autoSubmittedOnCreate = false;
}

async function retainedOrigin(
  root: string,
  plan: ReviewDeliveryPlan<ChangeSourceV1>,
  snapshot: ReviewDeliverySnapshot,
  requestedActions?: ReviewDeliveryRequestedActions,
) {
  const state = await mkdtemp(join(tmpdir(), "github-review-retained-"));
  roots.push(state);
  const artifactStore = new DurableArtifactStore(join(state, "artifacts"));
  await artifactStore.initialize();
  await artifactStore.putRecord(
    plan.result.originalResultSha256,
    JSON.parse(plan.result.originalResultCanonicalJson),
  );
  const runStore = new FileRunStore(join(state, "runs"));
  const runId = "review-run-1";
  await runStore.save({
    schemaVersion: 2,
    id: runId,
    workflow: "review-documentation",
    repository: { sourcePath: "/fixture/repository", requestedRevision: "HEAD", revision: HEAD },
    workspace: { strategy: "tracked-export", disposable: true },
    status: "succeeded",
    createdAt: "2026-10-16T12:00:00.000Z",
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
  const store = new FileScmDeliveryReceiptStore(root);
  const admission = createLocalReviewDeliveryOriginAdmission({
    store,
    configuredReceiptRoot: root,
    runStore,
    artifactStore,
    runId,
    artifactDigest: plan.result.originalResultSha256,
    artifactId: plan.artifact.id,
    originalResultSha256: plan.result.originalResultSha256,
    requestedActions,
    loadSnapshot: async () => snapshot,
  });
  return { store, admission };
}

function grants(plan: ReviewDeliveryPlan<ChangeSourceV1>) {
  return new Map(
    plan.actions.map((action) => [
      action.id,
      createReviewDeliveryGrant({
        verifyCurrent: (given) => {
          if (given.id !== action.id) throw new Error("Wrong action grant");
          return { status: "admitted" as const, actionId: action.id, kind: action.kind };
        },
      }),
    ]),
  );
}

describe("native GitHub review adapter", () => {
  vi.setConfig({ testTimeout: testTimeoutMs(30_000), hookTimeout: hookTimeoutMs(30_000) });
  it.each([
    ["zero", { zeroFindings: true, requestedActions: "overview" as const }, 0],
    ["all-inline", { summary: false, requestedActions: "overview" as const }, 2],
    ["mixed", { requestedActions: "overview" as const }, 2],
    ["summary-only", { requestedActions: "summary-only" as const }, 0],
  ])(
    "prepares a useful real-D1 %s overview in one pending batch",
    async (_name, options, inlineCount) => {
      const { plan, snapshot } = planFixture({ ...options, overviewContent: true });
      const fake = new FakeGithub();
      const adapter = createGithubReviewAdapter({
        plan,
        snapshot,
        fetch: fake.fetch,
        authorization: () => "Bearer synthetic",
      });
      const context: ReviewDeliveryEffectContextV1 = {
        kind: "docsfab-review-delivery-effect-context",
        schemaVersion: 1,
        logicalDeliveryId: `overview-${_name}`,
        correlationSeed: randomBytes(32).toString("base64url"),
        committedEffects: [],
      };
      const prepared = await adapter.prepareNextEffect({ plan, priorObservations: [], context });
      expect(prepared.kind).toBe("effect");
      if (prepared.kind !== "effect") return;
      const request = JSON.parse(Buffer.from(prepared.request.bodyBytes).toString("utf8")) as {
        body: string;
        comments: unknown[];
      };
      expect(request.comments).toHaveLength(inlineCount);
      expect(request.body).toContain(`Retained findings: ${plan.findings.length}`);
      expect(request.body).toContain("Checks");
      expect(request.body).toContain("@reviewer <script> source check");
      expect(request.body).toContain("Is [the example](https://evil.test) current?");
      expect(request.body).toContain("focused-docs");
      expect(request.body).toContain("docs/later.md");
      expect(request.body).toContain("docs/skipped.md");
      expect(request.body).toContain("not reviewed <script>");
      expect(request.body).toContain("Template coverage report:");
      expect(request.body).toContain("template:guide");
      expect(request.body).toContain("selected rubric unavailable");
      expect(request.body).toContain("missing-required-heading");
      if (!options.zeroFindings) {
        expect(request.body).toContain("Retained template suggestion ID:");
        expect(request.body).toContain("finding:1");
      }
      expect(request.body).toContain("One title");
      expect(request.body).toContain("~~~text\n@reviewer <script> source check");
      expect(request.body).toContain("~~~text\nIs [the example](https://evil.test) current?");
      expect(plan.actions.some((action) => action.kind === "publish-summary")).toBe(true);
      expect(fake.posts).toBe(0);
    },
  );

  it.each([
    ["mixed", { requestedActions: "overview" as const }],
    ["summary-only", { requestedActions: "summary-only" as const }],
  ])(
    "delivers a real-D1 %s overview through one pending review and same-ID submit",
    async (_name, options) => {
      const { plan, snapshot } = planFixture({ ...options, overviewContent: true });
      const root = await mkdtemp(join(tmpdir(), "github-overview-store-"));
      roots.push(root);
      const { store, admission } = await retainedOrigin(
        root,
        plan,
        snapshot,
        options.requestedActions,
      );
      const fake = new FakeGithub();
      const adapter = createGithubReviewAdapter({
        plan,
        snapshot,
        fetch: fake.fetch,
        authorization: () => "Bearer synthetic",
      });
      const result = await executeReviewDelivery({
        plan,
        store,
        originAdmission: admission,
        grantsByActionId: grants(plan),
        effects: adapter,
        recovery: adapter,
      });
      expect(result.kind).toBe("complete");
      expect(fake.posts).toBe(2);
      expect(fake.calls.filter((call) => call.method === "POST").map((call) => call.path)).toEqual([
        "/repos/team/docs/pulls/7/reviews",
        "/repos/team/docs/pulls/7/reviews/700/events",
      ]);
      expect(fake.reviewBody).toContain(`Retained findings: ${plan.findings.length}`);
      expect(fake.state).toBe("COMMENTED");
    },
  );

  it("keeps a complete inline batch while an oversized default overview becomes submitted partial", async () => {
    const { plan, snapshot } = planFixture({ overviewContent: true, largeQuestions: true });
    const fake = new FakeGithub();
    const adapter = createGithubReviewAdapter({
      plan,
      snapshot,
      fetch: fake.fetch,
      authorization: () => "Bearer synthetic",
    });
    const context: ReviewDeliveryEffectContextV1 = {
      kind: "docsfab-review-delivery-effect-context",
      schemaVersion: 1,
      logicalDeliveryId: "large-default-mixed",
      correlationSeed: randomBytes(32).toString("base64url"),
      committedEffects: [],
    };
    vi.stubEnv("DOCSFAB_GITHUB_REVIEW_BODY_MAX_BYTES", "131072");
    const full = await adapter.prepareNextEffect({ plan, priorObservations: [], context });
    expect(full.kind).toBe("effect");
    if (full.kind !== "effect") return;
    const fullRequest = JSON.parse(Buffer.from(full.request.bodyBytes).toString("utf8")) as {
      body: string;
      comments: unknown[];
    };
    expect(Buffer.byteLength(fullRequest.body, "utf8")).toBeGreaterThan(
      LIMIT_DEFINITION_BY_NAME["githubReview.bodyMaxBytes"]!.value,
    );
    expect(fullRequest.comments).toHaveLength(2);
    vi.stubEnv("DOCSFAB_GITHUB_REVIEW_BODY_MAX_BYTES", "65000");
    const compact = await adapter.prepareNextEffect({ plan, priorObservations: [], context });
    expect(compact.kind).toBe("effect");
    if (compact.kind !== "effect") return;
    const compactRequest = JSON.parse(Buffer.from(compact.request.bodyBytes).toString("utf8")) as {
      body: string;
      comments: unknown[];
    };
    expect(compactRequest.comments).toEqual(fullRequest.comments);
    expect(compactRequest.body).toContain("Overview presentation: partial");
    expect(compactRequest.body).toContain(
      `unanswered questions ${plan.unresolvedQuestions.length}`,
    );
    expect(compactRequest.body).not.toContain(plan.unresolvedQuestions[0]!.summary);
    expect(compact.overviewPresentation?.kind).toBe("compact-partial");
    expect(fake.posts).toBe(0);

    const root = await mkdtemp(join(tmpdir(), "github-capacity-store-"));
    roots.push(root);
    const { store, admission } = await retainedOrigin(root, plan, snapshot);
    const result = await executeReviewDelivery({
      plan,
      store,
      originAdmission: admission,
      grantsByActionId: grants(plan),
      effects: adapter,
      recovery: adapter,
    });
    expect(result).toMatchObject({
      kind: "partial",
      publication: "submitted",
      overview: "partial",
      remaining: { unansweredQuestions: plan.unresolvedQuestions.length, nativeInlineFindings: 2 },
    });
    expect(fake.posts).toBe(2);
    expect(fake.state).toBe("COMMENTED");
    expect(fake.comments).toHaveLength(2);
    const repeated = await executeReviewDelivery({
      plan,
      store,
      originAdmission: admission,
      grantsByActionId: grants(plan),
      effects: adapter,
      recovery: adapter,
    });
    expect(repeated).toMatchObject({
      kind: "partial",
      publication: "submitted",
      overview: "partial",
    });
    expect(fake.posts).toBe(2);
  });

  it.each(["overview", "summary-only"] as const)(
    "stops oversized explicit %s before a GitHub POST without compact fallback",
    async (requestedActions) => {
      const { plan, snapshot } = planFixture({
        overviewContent: true,
        largeQuestions: true,
        requestedActions,
      });
      const fake = new FakeGithub();
      const adapter = createGithubReviewAdapter({
        plan,
        snapshot,
        fetch: fake.fetch,
        authorization: () => "Bearer synthetic",
      });
      const root = await mkdtemp(join(tmpdir(), "github-capacity-stop-"));
      roots.push(root);
      const { store, admission } = await retainedOrigin(root, plan, snapshot, requestedActions);
      const result = await executeReviewDelivery({
        plan,
        store,
        originAdmission: admission,
        grantsByActionId: grants(plan),
        effects: adapter,
        recovery: adapter,
      });
      expect(fake.posts).toBe(0);
      expect(result).toMatchObject({
        kind: "stopped",
        reason: "capacity",
        capacity: {
          code: "github-review-body-bytes-bound",
          limitName: "githubReview.bodyMaxBytes",
          effectiveBytes: LIMIT_DEFINITION_BY_NAME["githubReview.bodyMaxBytes"]!.value,
          scope: "github-pending-review-create.body",
        },
      });
    },
  );

  it("refuses before POST when even the fixed compact body exceeds a valid host policy", async () => {
    const { plan, snapshot } = planFixture({ overviewContent: true, largeQuestions: true });
    vi.stubEnv("DOCSFAB_GITHUB_REVIEW_BODY_MAX_BYTES", "256");
    const fake = new FakeGithub();
    const adapter = createGithubReviewAdapter({
      plan,
      snapshot,
      fetch: fake.fetch,
      authorization: () => "Bearer synthetic",
    });
    const context: ReviewDeliveryEffectContextV1 = {
      kind: "docsfab-review-delivery-effect-context",
      schemaVersion: 1,
      logicalDeliveryId: "compact-too-large",
      correlationSeed: randomBytes(32).toString("base64url"),
      committedEffects: [],
    };
    const prepared = await adapter.prepareNextEffect({ plan, priorObservations: [], context });
    expect(prepared).toMatchObject({
      kind: "capacity-stop",
      code: "github-review-body-bytes-bound",
      effectiveBytes: 256,
    });
    expect(fake.posts).toBe(0);
  });

  it("uses UTF-8 bytes at the exact rich-body boundary and keeps default all-inline legacy bytes", async () => {
    const { plan, snapshot } = planFixture({ overviewContent: true, questionCharacter: "é" });
    const fake = new FakeGithub();
    const adapter = createGithubReviewAdapter({
      plan,
      snapshot,
      fetch: fake.fetch,
      authorization: () => "Bearer synthetic",
    });
    const context: ReviewDeliveryEffectContextV1 = {
      kind: "docsfab-review-delivery-effect-context",
      schemaVersion: 1,
      logicalDeliveryId: "utf8-boundary",
      correlationSeed: randomBytes(32).toString("base64url"),
      committedEffects: [],
    };
    const initial = await adapter.prepareNextEffect({ plan, priorObservations: [], context });
    expect(initial.kind).toBe("effect");
    if (initial.kind !== "effect") return;
    const richBody = (
      JSON.parse(Buffer.from(initial.request.bodyBytes).toString("utf8")) as {
        body: string;
      }
    ).body;
    expect(richBody).toContain("selected rubric unavailable");
    const bytes = Buffer.byteLength(richBody, "utf8");
    expect(bytes).toBeGreaterThan(richBody.length);
    vi.stubEnv("DOCSFAB_GITHUB_REVIEW_BODY_MAX_BYTES", String(bytes));
    const exact = await adapter.prepareNextEffect({ plan, priorObservations: [], context });
    expect(exact.kind).toBe("effect");
    if (exact.kind !== "effect") return;
    expect(exact.expectedBodySha256).toBe(initial.expectedBodySha256);
    expect(exact.overviewPresentation?.kind).toBe("full");
    vi.stubEnv("DOCSFAB_GITHUB_REVIEW_BODY_MAX_BYTES", String(bytes - 1));
    const over = await adapter.prepareNextEffect({ plan, priorObservations: [], context });
    expect(over.kind).toBe("effect");
    if (over.kind !== "effect") return;
    expect(over.overviewPresentation?.kind).toBe("compact-partial");
    expect(over.expectedBodySha256).not.toBe(initial.expectedBodySha256);

    const allInline = planFixture({ summary: false });
    const allInlineAdapter = createGithubReviewAdapter({
      plan: allInline.plan,
      snapshot: allInline.snapshot,
      fetch: new FakeGithub().fetch,
      authorization: () => "Bearer synthetic",
    });
    vi.stubEnv("DOCSFAB_GITHUB_REVIEW_BODY_MAX_BYTES", "256");
    const legacy = await allInlineAdapter.prepareNextEffect({
      plan: allInline.plan,
      priorObservations: [],
      context,
    });
    expect(legacy.kind).toBe("effect");
    if (legacy.kind !== "effect") return;
    const legacyBody = (
      JSON.parse(Buffer.from(legacy.request.bodyBytes).toString("utf8")) as {
        body: string;
      }
    ).body;
    expect(legacyBody).toBe(renderGithubReviewBody(allInline.plan, undefined, legacy.marker));
  });

  it("classifies committed full or compact descriptors without HTTP and resumes with authenticated reads", async () => {
    const { plan, snapshot } = planFixture({ overviewContent: true, largeQuestions: true });
    const fake = new FakeGithub();
    const adapter = createGithubReviewAdapter({
      plan,
      snapshot,
      fetch: fake.fetch,
      authorization: () => "Bearer synthetic",
    });
    const context: ReviewDeliveryEffectContextV1 = {
      kind: "docsfab-review-delivery-effect-context",
      schemaVersion: 1,
      logicalDeliveryId: "committed-variant-policy",
      correlationSeed: randomBytes(32).toString("base64url"),
      committedEffects: [],
    };
    vi.stubEnv("DOCSFAB_GITHUB_REVIEW_BODY_MAX_BYTES", "131072");
    const full = await adapter.prepareNextEffect({ plan, priorObservations: [], context });
    expect(full.kind).toBe("effect");
    if (full.kind !== "effect") return;
    vi.stubEnv("DOCSFAB_GITHUB_REVIEW_BODY_MAX_BYTES", "65000");
    const compact = await adapter.prepareNextEffect({ plan, priorObservations: [], context });
    expect(compact.kind).toBe("effect");
    if (compact.kind !== "effect") return;
    for (const [effect, currentPolicy, kind] of [
      [full, "256", "full"],
      [compact, "131072", "compact-partial"],
    ] as const) {
      vi.stubEnv("DOCSFAB_GITHUB_REVIEW_BODY_MAX_BYTES", currentPolicy);
      const committedContext = { ...context, committedEffects: [committed(effect)] };
      const callsBeforeClassification = fake.calls.length;
      expect(
        adapter.classifyCommittedOverviewPresentation({ plan, context: committedContext }),
      ).toMatchObject({ kind: "presentation", presentation: { kind } });
      expect(fake.calls).toHaveLength(callsBeforeClassification);
      const resumed = await adapter.prepareNextEffect({
        plan,
        priorObservations: [],
        context: committedContext,
      });
      expect(resumed).toEqual(effect);
    }
    const callsBeforeRejectedClassification = fake.calls.length;
    expect(
      adapter.classifyCommittedOverviewPresentation({
        plan,
        context: {
          ...context,
          committedEffects: [{ ...committed(compact), expectedBodySha256: HASH }],
        },
      }),
    ).toEqual({ kind: "unavailable" });
    expect(fake.calls).toHaveLength(callsBeforeRejectedClassification);
    expect(fake.posts).toBe(0);
  });

  it("rejects a committed terse default body under a same-manifest explicit overview", async () => {
    const prior = planFixture({ overviewContent: true });
    const current = planFixture({ overviewContent: true, requestedActions: "overview" });
    expect(prior.plan.actions.map((action) => action.id)).toEqual(
      current.plan.actions.map((action) => action.id),
    );
    const context: ReviewDeliveryEffectContextV1 = {
      kind: "docsfab-review-delivery-effect-context",
      schemaVersion: 1,
      logicalDeliveryId: "same-manifest-overview",
      correlationSeed: randomBytes(32).toString("base64url"),
      committedEffects: [],
    };
    const oldAdapter = createGithubReviewAdapter({
      plan: prior.plan,
      snapshot: prior.snapshot,
      fetch: new FakeGithub().fetch,
      authorization: () => "Bearer synthetic",
    });
    const prepared = await oldAdapter.prepareNextEffect({
      plan: prior.plan,
      priorObservations: [],
      context,
    });
    expect(prepared.kind).toBe("effect");
    if (prepared.kind !== "effect") return;
    const old = legacyCreateEffect(prepared, prior.plan);
    const fake = new FakeGithub();
    const adapter = createGithubReviewAdapter({
      plan: current.plan,
      snapshot: current.snapshot,
      fetch: fake.fetch,
      authorization: () => "Bearer synthetic",
    });
    const selected = await adapter.prepareNextEffect({
      plan: current.plan,
      priorObservations: [],
      context: { ...context, committedEffects: [committed(old)] },
    });
    expect(selected.kind).toBe("blocked");
    expect(fake.posts).toBe(0);
  });

  it.each(["legacy", "rich"] as const)(
    "recovers a committed %s create descriptor and carries its body into same-ID submit",
    async (variant) => {
      const { plan, snapshot } = planFixture({ overviewContent: true });
      const fake = new FakeGithub();
      const adapter = createGithubReviewAdapter({
        plan,
        snapshot,
        fetch: fake.fetch,
        authorization: () => "Bearer synthetic",
      });
      const baseContext: ReviewDeliveryEffectContextV1 = {
        kind: "docsfab-review-delivery-effect-context",
        schemaVersion: 1,
        logicalDeliveryId: `recover-${variant}`,
        correlationSeed: randomBytes(32).toString("base64url"),
        committedEffects: [],
      };
      const fresh = await adapter.prepareNextEffect({
        plan,
        priorObservations: [],
        context: baseContext,
      });
      expect(fresh.kind).toBe("effect");
      if (fresh.kind !== "effect") return;
      const create = variant === "legacy" ? legacyCreateEffect(fresh, plan) : fresh;
      const context = { ...baseContext, committedEffects: [committed(create)] };
      const recovered = await adapter.prepareNextEffect({ plan, priorObservations: [], context });
      expect(recovered).toEqual(create);
      const outcome = await adapter.publishEffect({
        action: plan.actions[0]!,
        effect: create,
        context,
      });
      expect(outcome.kind).toBe("confirmed");
      const observed = await adapter.observeEffect({
        action: plan.actions[0]!,
        effect: create,
        context,
        phase: "recovery",
        providerReference: "700",
      });
      expect(observed.kind).toBe("matching");
      if (observed.kind !== "matching") return;
      const submit = await adapter.prepareNextEffect({
        plan,
        priorObservations: [observed],
        context,
      });
      expect(submit.kind).toBe("effect");
      if (submit.kind !== "effect") return;
      expect(submit.request.path).toBe("/repos/team/docs/pulls/7/reviews/700/events");
      expect(submit.expectedBodySha256).toBe(create.expectedBodySha256);
      expect(submit.actionPayloads).toEqual(create.actionPayloads);
      const sealedContext = {
        ...context,
        committedEffects: [committed(create), committed(submit)],
      };
      expect(
        await adapter.prepareNextEffect({
          plan,
          priorObservations: [observed],
          context: sealedContext,
        }),
      ).toEqual(submit);
      const mismatchedSubmit = {
        ...committed(submit),
        expectedBodySha256: HASH,
      };
      expect(
        (
          await adapter.prepareNextEffect({
            plan,
            priorObservations: [observed],
            context: { ...context, committedEffects: [committed(create), mismatchedSubmit] },
          })
        ).kind,
      ).toBe("blocked");
      expect(fake.posts).toBe(1);
    },
  );

  it.each(["legacy", "rich"] as const)(
    "classifies the exact committed %s create without provider reads or preparation",
    async (variant) => {
      const { plan, snapshot } = planFixture({ overviewContent: true });
      const fake = new FakeGithub();
      const adapter = createGithubReviewAdapter({
        plan,
        snapshot,
        fetch: fake.fetch,
        authorization: () => "Bearer synthetic",
      });
      const context: ReviewDeliveryEffectContextV1 = {
        kind: "docsfab-review-delivery-effect-context",
        schemaVersion: 1,
        logicalDeliveryId: `classify-${variant}`,
        correlationSeed: randomBytes(32).toString("base64url"),
        committedEffects: [],
      };
      const prepared = await adapter.prepareNextEffect({ plan, priorObservations: [], context });
      expect(prepared.kind).toBe("effect");
      if (prepared.kind !== "effect") return;
      const create = variant === "legacy" ? legacyCreateEffect(prepared, plan) : prepared;
      const callsBefore = fake.calls.length;
      const selected = adapter.classifyCommittedOverviewPresentation({
        plan,
        context: { ...context, committedEffects: [committed(create)] },
      });
      expect(selected.kind).toBe("presentation");
      if (selected.kind !== "presentation") return;
      expect(selected.presentation.kind).toBe(variant === "legacy" ? "historical-legacy" : "full");
      expect(selected.presentation.retained).toEqual({
        resultSha256: plan.result.originalResultSha256,
        sourceSha256: plan.target.changeSourceSha256,
        snapshotSha256: plan.snapshotSha256,
        runIdSha256: plan.result.runIdSha256,
        actionSetSha256: sha256(canonicalJson(plan.actions.map((action) => action.id).sort())),
      });
      expect(selected.presentation.remaining.findingsTotal).toBe(plan.findings.length);
      expect(selected.presentation.remaining.nativeInlineFindings).toBe(2);
      expect(selected.presentation.remaining.summarySelectedFindings).toBe(1);
      expect(selected.presentation.remaining.templateReportPresent).toBe(1);
      expect(selected.presentation.remaining.templatePages).toBe(1);
      expect(selected.presentation.remaining.templateRules).toBe(1);
      expect(selected.presentation.remaining.templateSuggestionIds).toBe(1);
      expect(fake.calls).toHaveLength(callsBefore);
    },
  );

  it("refuses explicit legacy, descriptor tampering, unknown bodies and changed sealed plans", async () => {
    const { plan, snapshot } = planFixture({ overviewContent: true });
    const fake = new FakeGithub();
    const adapter = createGithubReviewAdapter({
      plan,
      snapshot,
      fetch: fake.fetch,
      authorization: () => "Bearer synthetic",
    });
    const context: ReviewDeliveryEffectContextV1 = {
      kind: "docsfab-review-delivery-effect-context",
      schemaVersion: 1,
      logicalDeliveryId: "classify-refusals",
      correlationSeed: randomBytes(32).toString("base64url"),
      committedEffects: [],
    };
    const prepared = await adapter.prepareNextEffect({ plan, priorObservations: [], context });
    expect(prepared.kind).toBe("effect");
    if (prepared.kind !== "effect") return;
    const descriptor = committed(prepared);
    const callsBefore = fake.calls.length;
    const classify = (
      sealed: ReviewDeliveryCommittedEffectV1,
      selectedPlan: ReviewDeliveryPlan<ChangeSourceV1> = plan,
      selectedContext: ReviewDeliveryEffectContextV1 = context,
    ) =>
      adapter.classifyCommittedOverviewPresentation({
        plan: selectedPlan,
        context: { ...selectedContext, committedEffects: [sealed] },
      });
    const legacy = committed(legacyCreateEffect(prepared, plan));
    const explicit = planFixture({ overviewContent: true, requestedActions: "overview" });
    const explicitFake = new FakeGithub();
    const explicitAdapter = createGithubReviewAdapter({
      plan: explicit.plan,
      snapshot: explicit.snapshot,
      fetch: explicitFake.fetch,
      authorization: () => "Bearer synthetic",
    });
    const explicitPrepared = await explicitAdapter.prepareNextEffect({
      plan: explicit.plan,
      priorObservations: [],
      context,
    });
    expect(explicitPrepared.kind).toBe("effect");
    if (explicitPrepared.kind !== "effect") return;
    const explicitCalls = explicitFake.calls.length;
    expect(
      explicitAdapter.classifyCommittedOverviewPresentation({
        plan: explicit.plan,
        context: { ...context, committedEffects: [committed(explicitPrepared)] },
      }),
    ).toMatchObject({ kind: "presentation", presentation: { kind: "full" } });
    expect(
      explicitAdapter.classifyCommittedOverviewPresentation({
        plan: explicit.plan,
        context: {
          ...context,
          committedEffects: [committed(legacyCreateEffect(explicitPrepared, explicit.plan))],
        },
      }),
    ).toEqual({ kind: "unavailable" });
    expect(explicitFake.calls).toHaveLength(explicitCalls);
    expect(classify({ ...descriptor, effectId: `${descriptor.effectId}-other` })).toEqual({
      kind: "unavailable",
    });
    expect(classify({ ...descriptor, stage: "github-comment-submit" })).toEqual({
      kind: "unavailable",
    });
    expect(classify({ ...descriptor, coveredActionIds: [] })).toEqual({ kind: "unavailable" });
    expect(classify({ ...descriptor, actionPayloads: [] })).toEqual({ kind: "unavailable" });
    expect(classify({ ...descriptor, outboundBytesSha256: HASH })).toEqual({ kind: "unavailable" });
    expect(classify({ ...descriptor, expectedBodySha256: HASH })).toEqual({ kind: "unavailable" });
    expect(classify({ ...descriptor, expectedGitLabPositionSha256: HASH })).toEqual({
      kind: "unavailable",
    });
    expect(classify({ ...descriptor, marker: `${descriptor.marker}-other` })).toEqual({
      kind: "unavailable",
    });
    const compactBody = "DocsFab partial overview: retained details require local inspection.";
    const compactRequest = {
      ...prepared.request,
      bodyBytes: new TextEncoder().encode(
        JSON.stringify({
          ...JSON.parse(Buffer.from(prepared.request.bodyBytes).toString("utf8")),
          body: compactBody,
        }),
      ),
    };
    const compact = committed({
      ...prepared,
      request: compactRequest,
      outboundBytesSha256: reviewDeliveryOutboundBytesSha256(compactRequest),
      expectedBodySha256: reviewDeliveryBodySha256(compactBody),
      actionPayloads: prepared.actionPayloads.map((payload) =>
        payload.anchorSha256 === null
          ? { ...payload, bodySha256: reviewDeliveryBodySha256(compactBody) }
          : payload,
      ),
    });
    expect(classify(compact)).toEqual({ kind: "unavailable" });
    expect(classify(descriptor, { ...plan, limitations: [...plan.limitations, "new"] })).toEqual({
      kind: "unavailable",
    });
    expect(
      classify(descriptor, plan, {
        ...context,
        correlationSeed: randomBytes(32).toString("base64url"),
      }),
    ).toEqual({ kind: "unavailable" });
    expect(fake.calls).toHaveLength(callsBefore);
  });

  it("preserves the exact legacy body for a default all-inline plan", async () => {
    const { plan, snapshot } = planFixture({ summary: false, overviewContent: true });
    expect(plan.actions.every((action) => action.kind === "publish-inline")).toBe(true);
    const adapter = createGithubReviewAdapter({
      plan,
      snapshot,
      fetch: new FakeGithub().fetch,
      authorization: () => "Bearer synthetic",
    });
    const context: ReviewDeliveryEffectContextV1 = {
      kind: "docsfab-review-delivery-effect-context",
      schemaVersion: 1,
      logicalDeliveryId: "legacy-all-inline",
      correlationSeed: randomBytes(32).toString("base64url"),
      committedEffects: [],
    };
    const effect = await adapter.prepareNextEffect({ plan, priorObservations: [], context });
    expect(effect.kind).toBe("effect");
    if (effect.kind !== "effect") return;
    const body = (
      JSON.parse(Buffer.from(effect.request.bodyBytes).toString("utf8")) as { body: string }
    ).body;
    expect(body).toBe(renderGithubReviewBody(plan, undefined, effect.marker));
    expect(body).not.toContain("Retained findings:");
  });

  it("executes one complete pending review and submits the same review with native mapping", async () => {
    const { plan, snapshot } = planFixture();
    const root = await mkdtemp(join(tmpdir(), "github-review-store-"));
    roots.push(root);
    const { store, admission } = await retainedOrigin(root, plan, snapshot);
    const fake = new FakeGithub();
    let credentialReads = 0;
    const adapter = createGithubReviewAdapter({
      plan,
      snapshot,
      fetch: fake.fetch,
      authorization: () => {
        credentialReads++;
        return credentialReads === 1 ? "Bearer synthetic" : "Bearer changed";
      },
    });
    const result = await executeReviewDelivery({
      plan,
      store,
      originAdmission: admission,
      grantsByActionId: grants(plan),
      effects: adapter,
      recovery: adapter,
    });
    expect(result.kind).toBe("complete");
    expect(fake.posts).toBe(2);
    const posts = fake.calls.filter((call) => call.method === "POST");
    expect(posts.map((call) => call.path)).toEqual([
      "/repos/team/docs/pulls/7/reviews",
      "/repos/team/docs/pulls/7/reviews/700/events",
    ]);
    expect(posts[0]?.body).toMatchObject({ commit_id: HEAD });
    expect((posts[0]!.body as { event?: string }).event).toBeUndefined();
    expect((posts[0]!.body as { comments: unknown[] }).comments).toHaveLength(2);
    expect(posts[1]?.body).toEqual({ event: "COMMENT" });
    expect(result.record?.effects.map((item) => item.state).sort()).toEqual([
      "accepted-pending",
      "confirmed",
    ]);
    expect(
      result.record?.effects.find((item) => item.stage === "github-comment-submit")
        ?.actionReferences,
    ).toHaveLength(plan.actions.length);
    expect(fake.calls.every((call) => call.redirect === "manual" && call.authorized)).toBe(true);
    expect(credentialReads).toBe(1);
    const replay = await executeReviewDelivery({
      plan,
      store,
      originAdmission: admission,
      grantsByActionId: grants(plan),
      effects: adapter,
      recovery: adapter,
    });
    expect(replay.kind).toBe("complete");
    expect(fake.posts).toBe(2);
  });

  it("retains the documented 200 create response ID without review enumeration", async () => {
    const { plan, snapshot } = planFixture();
    const root = await mkdtemp(join(tmpdir(), "github-review-store-"));
    roots.push(root);
    const { store, admission } = await retainedOrigin(root, plan, snapshot);
    const fake = new FakeGithub();
    fake.failReviewList = true;
    const adapter = createGithubReviewAdapter({
      plan,
      snapshot,
      fetch: fake.fetch,
      authorization: () => "Bearer synthetic",
    });
    const result = await executeReviewDelivery({
      plan,
      store,
      originAdmission: admission,
      grantsByActionId: grants(plan),
      effects: adapter,
      recovery: adapter,
    });
    expect(result.kind).toBe("complete");
    expect(fake.posts).toBe(2);
    expect(fake.calls.some((call) => call.method === "GET" && call.path.endsWith("/reviews"))).toBe(
      false,
    );
    expect(
      fake.calls.some((call) => call.method === "GET" && call.path.endsWith("/reviews/700")),
    ).toBe(true);
  });

  it("publishes for a repository name with consecutive dots", async () => {
    const { plan, snapshot } = planFixture({ fullName: "team/docs..site" });
    const root = await mkdtemp(join(tmpdir(), "github-review-store-"));
    roots.push(root);
    const { store, admission } = await retainedOrigin(root, plan, snapshot);
    const fake = new FakeGithub();
    fake.repositoryFullName = "team/docs..site";
    const adapter = createGithubReviewAdapter({
      plan,
      snapshot,
      fetch: fake.fetch,
      authorization: () => "Bearer synthetic",
    });
    const result = await executeReviewDelivery({
      plan,
      store,
      originAdmission: admission,
      grantsByActionId: grants(plan),
      effects: adapter,
      recovery: adapter,
    });
    expect(result.kind).toBe("complete");
    expect(fake.posts).toBe(2);
    expect(fake.calls.some((call) => call.path === "/repos/team/docs..site/pulls/7/reviews")).toBe(
      true,
    );
  });

  it.each([".", ".."] as const)(
    "refuses a repository path with an exact %s segment",
    async (segment) => {
      const { plan, snapshot } = planFixture({ fullName: `team/${segment}` });
      const root = await mkdtemp(join(tmpdir(), "github-review-store-"));
      roots.push(root);
      const { store, admission } = await retainedOrigin(root, plan, snapshot);
      const fake = new FakeGithub();
      const adapter = createGithubReviewAdapter({
        plan,
        snapshot,
        fetch: fake.fetch,
        authorization: () => "Bearer synthetic",
      });
      const result = await executeReviewDelivery({
        plan,
        store,
        originAdmission: admission,
        grantsByActionId: grants(plan),
        effects: adapter,
        recovery: adapter,
      });
      expect(result.kind).toBe("stopped");
      expect(fake.posts).toBe(0);
      expect(fake.calls.every((call) => !call.path.startsWith("/repos/"))).toBe(true);
    },
  );

  it.each(["timeoutCreate", "timeoutSubmit"] as const)(
    "reconciles %s after native acceptance without replay",
    async (fault) => {
      const { plan, snapshot } = planFixture();
      const root = await mkdtemp(join(tmpdir(), "github-review-store-"));
      roots.push(root);
      const { store, admission } = await retainedOrigin(root, plan, snapshot);
      const fake = new FakeGithub();
      fake[fault] = true;
      const adapter = createGithubReviewAdapter({
        plan,
        snapshot,
        fetch: fake.fetch,
        authorization: () => "Bearer synthetic",
      });
      const first = await executeReviewDelivery({
        plan,
        store,
        originAdmission: admission,
        grantsByActionId: grants(plan),
        effects: adapter,
        recovery: adapter,
      });
      expect(first.kind).toBe("complete");
      expect(fake.posts).toBe(2);
    },
  );

  it("refuses a different authenticated user before any mutation", async () => {
    const { plan, snapshot } = planFixture();
    const root = await mkdtemp(join(tmpdir(), "github-review-store-"));
    roots.push(root);
    const { store, admission } = await retainedOrigin(root, plan, snapshot);
    const fake = new FakeGithub();
    fake.userId = 99;
    const adapter = createGithubReviewAdapter({
      plan,
      snapshot,
      fetch: fake.fetch,
      authorization: () => "Bearer synthetic",
    });
    const result = await executeReviewDelivery({
      plan,
      store,
      originAdmission: admission,
      grantsByActionId: grants(plan),
      effects: adapter,
      recovery: adapter,
    });
    expect(result).toMatchObject({ kind: "stopped", reason: "drift" });
    expect(fake.posts).toBe(0);
  });

  it.each([403, 404] as const)(
    "treats private GitHub %s as unavailable before publication",
    async (status) => {
      const { plan, snapshot } = planFixture();
      const root = await mkdtemp(join(tmpdir(), "github-review-store-"));
      roots.push(root);
      const { store, admission } = await retainedOrigin(root, plan, snapshot);
      const fake = new FakeGithub();
      fake.privateStatus = status;
      const adapter = createGithubReviewAdapter({
        plan,
        snapshot,
        fetch: fake.fetch,
        authorization: () => "Bearer synthetic",
      });
      const result = await executeReviewDelivery({
        plan,
        store,
        originAdmission: admission,
        grantsByActionId: grants(plan),
        effects: adapter,
        recovery: adapter,
      });
      expect(result.kind).toBe("stopped");
      expect(fake.posts).toBe(0);
    },
  );

  it("seals exact request bytes and leaves hostile summary text inert", async () => {
    const { plan, snapshot } = planFixture({
      hostile: true,
      hostedReportUrl: "https://docs.example.com/reports/run-7/index.html",
    });
    const fake = new FakeGithub();
    const adapter = createGithubReviewAdapter({
      plan,
      snapshot,
      fetch: fake.fetch,
      authorization: () => "Bearer synthetic",
    });
    const context: ReviewDeliveryEffectContextV1 = {
      kind: "docsfab-review-delivery-effect-context",
      schemaVersion: 1,
      logicalDeliveryId: "test-delivery",
      correlationSeed: randomBytes(32).toString("base64url"),
      committedEffects: [],
    };
    const effect = await adapter.prepareNextEffect({ plan, priorObservations: [], context });
    expect(effect.kind).toBe("effect");
    if (effect.kind !== "effect") return;
    expect(effect.outboundBytesSha256).toBe(reviewDeliveryOutboundBytesSha256(effect.request));
    const restarted = createGithubReviewAdapter({
      plan,
      snapshot,
      fetch: fake.fetch,
      authorization: () => "Bearer synthetic",
    });
    expect(await restarted.prepareNextEffect({ plan, priorObservations: [], context })).toEqual(
      effect,
    );
    const summary = renderGithubReviewBody(
      plan,
      plan.actions.find((action) => action.kind === "publish-summary") as Extract<
        (typeof plan.actions)[number],
        { kind: "publish-summary" }
      >,
      effect.marker,
    );
    expect(summary).toContain("~~~~text");
    expect(summary).toContain("@attacker <script> [link](https://evil.test)");
    expect(summary).toContain(
      "[Hosted report](<https://docs.example.com/reports/run-7/index.html>)",
    );
    expect(effect.request.path).toBe("/repos/team/docs/pulls/7/reviews");
  });

  it("maps a synthetic future multiline anchor to GitHub line and start_line fields", async () => {
    // D1 currently emits single-line actions; this tests only the D4 prepared-effect mapping.
    const { plan, snapshot } = planFixture();
    const shapedPlan = {
      ...plan,
      actions: plan.actions.map((action) =>
        action.kind === "publish-inline" && action.anchor.startLine === 1
          ? { ...action, anchor: { ...action.anchor, endLine: 2 } }
          : action,
      ),
    } as ReviewDeliveryPlan<ChangeSourceV1>;
    const fake = new FakeGithub();
    const adapter = createGithubReviewAdapter({
      plan: shapedPlan,
      snapshot,
      fetch: fake.fetch,
      authorization: () => "Bearer synthetic",
    });
    const context: ReviewDeliveryEffectContextV1 = {
      kind: "docsfab-review-delivery-effect-context",
      schemaVersion: 1,
      logicalDeliveryId: "multiline-mapping",
      correlationSeed: randomBytes(32).toString("base64url"),
      committedEffects: [],
    };
    const effect = await adapter.prepareNextEffect({
      plan: shapedPlan,
      priorObservations: [],
      context,
    });
    expect(effect.kind).toBe("effect");
    if (effect.kind !== "effect") return;
    const body = JSON.parse(Buffer.from(effect.request.bodyBytes).toString("utf8")) as {
      comments: { line: number; side: string; start_line?: number; start_side?: string }[];
    };
    expect(body.comments).toContainEqual(
      expect.objectContaining({
        line: 2,
        side: "RIGHT",
        start_line: 1,
        start_side: "RIGHT",
      }),
    );
    expect(fake.posts).toBe(0);
  });

  it("refuses an unsupported GHES target before any provider request", () => {
    const { plan, snapshot } = planFixture();
    const fake = new FakeGithub();
    const unsupported = {
      ...plan,
      target: { ...plan.target, host: "github.enterprise.example" },
    } as ReviewDeliveryPlan<ChangeSourceV1>;
    expect(() =>
      createGithubReviewAdapter({
        plan: unsupported,
        snapshot,
        fetch: fake.fetch,
        authorization: () => "Bearer synthetic",
      }),
    ).toThrow();
    expect(fake.calls).toHaveLength(0);
  });

  it("publishes a separately planned summary-only review with its distinct action grant", async () => {
    const ordinary = planFixture();
    const { plan, snapshot } = planFixture({ inline: false });
    expect(plan.actions.map((action) => action.kind)).toEqual(["publish-summary"]);
    expect(plan.actions[0]?.id).not.toBe(
      ordinary.plan.actions.find((action) => action.kind === "publish-summary")?.id,
    );
    const root = await mkdtemp(join(tmpdir(), "github-review-store-"));
    roots.push(root);
    const { store, admission } = await retainedOrigin(root, plan, snapshot);
    const fake = new FakeGithub();
    const adapter = createGithubReviewAdapter({
      plan,
      snapshot,
      fetch: fake.fetch,
      authorization: () => "Bearer synthetic",
    });
    const result = await executeReviewDelivery({
      plan,
      store,
      originAdmission: admission,
      grantsByActionId: grants(plan),
      effects: adapter,
      recovery: adapter,
    });
    expect(result.kind).toBe("complete");
    expect(fake.posts).toBe(2);
    const create = fake.calls.find((call) => call.method === "POST")?.body as {
      body: string;
      comments: unknown[];
    };
    expect(create.comments).toEqual([]);
    expect(create.body).toContain("Explain first value.");
    expect(create.body).toContain("Explain second value.");
  });

  it.each([
    ["deletion", ["LEFT", "LEFT"]],
    ["rename", ["LEFT", "RIGHT"]],
  ] as const)("publishes %s anchors on their authenticated diff side", async (change, sides) => {
    const { plan, snapshot } = planFixture({ change });
    const root = await mkdtemp(join(tmpdir(), "github-review-store-"));
    roots.push(root);
    const { store, admission } = await retainedOrigin(root, plan, snapshot);
    const fake = new FakeGithub();
    fake.change = change;
    const adapter = createGithubReviewAdapter({
      plan,
      snapshot,
      fetch: fake.fetch,
      authorization: () => "Bearer synthetic",
    });
    const result = await executeReviewDelivery({
      plan,
      store,
      originAdmission: admission,
      grantsByActionId: grants(plan),
      effects: adapter,
      recovery: adapter,
    });
    expect(result.kind).toBe("complete");
    const create = fake.calls.find((call) => call.method === "POST")?.body as {
      comments: { path: string; side: string; line: number; start_line?: number }[];
    };
    expect(create.comments.map((comment) => comment.side).sort()).toEqual([...sides].sort());
    expect(create.comments.map((comment) => comment.path)).toEqual([
      "docs/guide.md",
      "docs/guide.md",
    ]);
    expect(create.comments.map((comment) => comment.line).sort()).toEqual([1, 2]);
    expect(create.comments.every((comment) => comment.start_line === undefined)).toBe(true);
  });

  it("reads a later authenticated PR files page before preparing the inline batch", async () => {
    const { plan, snapshot } = planFixture();
    const root = await mkdtemp(join(tmpdir(), "github-review-store-"));
    roots.push(root);
    const { store, admission } = await retainedOrigin(root, plan, snapshot);
    const fake = new FakeGithub();
    fake.paginateFiles = true;
    const adapter = createGithubReviewAdapter({
      plan,
      snapshot,
      fetch: fake.fetch,
      authorization: () => "Bearer synthetic",
    });
    const result = await executeReviewDelivery({
      plan,
      store,
      originAdmission: admission,
      grantsByActionId: grants(plan),
      effects: adapter,
      recovery: adapter,
    });
    expect(result.kind).toBe("complete");
    expect(fake.calls.some((call) => call.path.endsWith("/files?page=2"))).toBe(true);
    expect(fake.posts).toBe(2);
  });

  it.each(["movedHead", "wrongFork"] as const)("refuses %s before publication", async (fault) => {
    const { plan, snapshot } = planFixture();
    const root = await mkdtemp(join(tmpdir(), "github-review-store-"));
    roots.push(root);
    const { store, admission } = await retainedOrigin(root, plan, snapshot);
    const fake = new FakeGithub();
    fake[fault] = true;
    const adapter = createGithubReviewAdapter({
      plan,
      snapshot,
      fetch: fake.fetch,
      authorization: () => "Bearer synthetic",
    });
    const result = await executeReviewDelivery({
      plan,
      store,
      originAdmission: admission,
      grantsByActionId: grants(plan),
      effects: adapter,
      recovery: adapter,
    });
    expect(result.kind).toBe("stopped");
    expect(fake.posts).toBe(0);
  });

  it("refuses a head change after file inventory and before POST", async () => {
    const { plan, snapshot } = planFixture();
    const root = await mkdtemp(join(tmpdir(), "github-review-store-"));
    roots.push(root);
    const { store, admission } = await retainedOrigin(root, plan, snapshot);
    const fake = new FakeGithub();
    fake.moveHeadAfterFiles = true;
    const adapter = createGithubReviewAdapter({
      plan,
      snapshot,
      fetch: fake.fetch,
      authorization: () => "Bearer synthetic",
    });
    const result = await executeReviewDelivery({
      plan,
      store,
      originAdmission: admission,
      grantsByActionId: grants(plan),
      effects: adapter,
      recovery: adapter,
    });
    expect(result.kind).toBe("stopped");
    expect(fake.calls.some((call) => call.path.endsWith("/files"))).toBe(true);
    expect(fake.posts).toBe(0);
  });

  it("refuses a changed authenticated PR diff path before committing an effect", async () => {
    const { plan, snapshot } = planFixture();
    const root = await mkdtemp(join(tmpdir(), "github-review-store-"));
    roots.push(root);
    const { store, admission } = await retainedOrigin(root, plan, snapshot);
    const fake = new FakeGithub();
    fake.change = "deletion";
    const adapter = createGithubReviewAdapter({
      plan,
      snapshot,
      fetch: fake.fetch,
      authorization: () => "Bearer synthetic",
    });
    const result = await executeReviewDelivery({
      plan,
      store,
      originAdmission: admission,
      grantsByActionId: grants(plan),
      effects: adapter,
      recovery: adapter,
    });
    expect(result.kind).toBe("stopped");
    expect(fake.posts).toBe(0);
    expect(fake.calls.some((call) => call.path.endsWith("/files"))).toBe(true);
  });

  it.each([
    [
      "renamed file missing native previous filename",
      "rename",
      { previous_filename: undefined },
      null,
      1,
    ],
    ["renamed file with wrong native status", "rename", { status: "modified" }, null, 1],
    ["deleted file with wrong native filename", "deletion", { filename: "docs/other.md" }, null, 1],
    [
      "deleted file with unexpected previous filename",
      "deletion",
      { previous_filename: "docs/old.md" },
      null,
      1,
    ],
    ["terminal file listing omitting the sealed file", "addition", {}, [], 1],
    ["authenticated changed_files count disagreement", "addition", {}, null, 2],
  ] as const)(
    "refuses %s before HTTP mutation",
    async (_label, change, filePatch, fileListRows, changedFiles) => {
      const { plan, snapshot } = planFixture({ change });
      const root = await mkdtemp(join(tmpdir(), "github-review-store-"));
      roots.push(root);
      const { store, admission } = await retainedOrigin(root, plan, snapshot);
      const fake = new FakeGithub();
      fake.change = change;
      fake.filePatch = filePatch;
      fake.fileListRows = fileListRows;
      fake.changedFiles = changedFiles;
      const adapter = createGithubReviewAdapter({
        plan,
        snapshot,
        fetch: fake.fetch,
        authorization: () => "Bearer synthetic",
      });
      const result = await executeReviewDelivery({
        plan,
        store,
        originAdmission: admission,
        grantsByActionId: grants(plan),
        effects: adapter,
        recovery: adapter,
      });
      expect(result.kind).toBe("stopped");
      expect(fake.posts).toBe(0);
    },
  );

  it.each([
    ["commit", { commit_id: BASE }],
    ["parent review", { pull_request_review_id: 701 }],
    ["author", { user: { id: 99 } }],
    ["path", { path: "docs/other.md" }],
    ["side", { side: "LEFT" }],
    ["body", { body: "Not the sealed finding" }],
  ] as const)("refuses a %s mismatch in native inline readback", async (_label, patch) => {
    const { plan, snapshot } = planFixture();
    const root = await mkdtemp(join(tmpdir(), "github-review-store-"));
    roots.push(root);
    const { store, admission } = await retainedOrigin(root, plan, snapshot);
    const fake = new FakeGithub();
    fake.commentPatch = patch;
    const adapter = createGithubReviewAdapter({
      plan,
      snapshot,
      fetch: fake.fetch,
      authorization: () => "Bearer synthetic",
    });
    const result = await executeReviewDelivery({
      plan,
      store,
      originAdmission: admission,
      grantsByActionId: grants(plan),
      effects: adapter,
      recovery: adapter,
    });
    expect(result.kind).toBe("stopped");
    expect(fake.posts).toBe(1);
    const context = result.record?.context;
    expect(context).toBeDefined();
    if (!context) throw new Error("Stopped delivery did not retain its effect context.");
    const effect = await adapter.prepareNextEffect({ plan, priorObservations: [], context });
    expect(effect.kind).toBe("effect");
    if (effect.kind !== "effect") throw new Error("Expected the retained GitHub review effect.");
    const providerObservation = await adapter.observeEffect({
      action: plan.actions[0]!,
      effect,
      context,
      phase: "recovery",
      providerReference: "700",
    });
    expect(providerObservation.kind).not.toBe("matching");
  });

  it.each([
    [
      "same-origin other PR",
      "https://api.github.com/repos/team/docs/pulls/8/reviews/700/comments?page=2",
    ],
    ["cross-origin", "https://evil.test/repos/team/docs/pulls/7/reviews/700/comments?page=2"],
  ] as const)("refuses %s pagination without following it", async (_label, next) => {
    const { plan, snapshot } = planFixture();
    const root = await mkdtemp(join(tmpdir(), "github-review-store-"));
    roots.push(root);
    const { store, admission } = await retainedOrigin(root, plan, snapshot);
    const fake = new FakeGithub();
    fake.commentListLink = `<${next}>; rel="next"`;
    const adapter = createGithubReviewAdapter({
      plan,
      snapshot,
      fetch: fake.fetch,
      authorization: () => "Bearer synthetic",
    });
    const result = await executeReviewDelivery({
      plan,
      store,
      originAdmission: admission,
      grantsByActionId: grants(plan),
      effects: adapter,
      recovery: adapter,
    });
    expect(result.kind).toBe("stopped");
    expect(fake.posts).toBe(1);
    expect(fake.calls.some((call) => call.path.includes("page=2"))).toBe(false);
  });

  it("reads every review-specific comments page before confirming native mapping", async () => {
    const { plan, snapshot } = planFixture();
    const root = await mkdtemp(join(tmpdir(), "github-review-store-"));
    roots.push(root);
    const { store, admission } = await retainedOrigin(root, plan, snapshot);
    const fake = new FakeGithub();
    fake.paginateComments = true;
    const adapter = createGithubReviewAdapter({
      plan,
      snapshot,
      fetch: fake.fetch,
      authorization: () => "Bearer synthetic",
    });
    const result = await executeReviewDelivery({
      plan,
      store,
      originAdmission: admission,
      grantsByActionId: grants(plan),
      effects: adapter,
      recovery: adapter,
    });
    expect(result.kind).toBe("complete");
    expect(fake.calls.some((call) => call.path.endsWith("comments?page=2"))).toBe(true);
  });

  it.each([
    [
      "redirect",
      () => new Response(null, { status: 302, headers: { Location: "https://evil.test/receive" } }),
    ],
    [
      "rate limit",
      () => Response.json({ message: "wait" }, { status: 429, headers: { "Retry-After": "60" } }),
    ],
  ] as const)("keeps invoked %s uncertain with no re-POST", async (_label, reply) => {
    const { plan, snapshot } = planFixture();
    const root = await mkdtemp(join(tmpdir(), "github-review-store-"));
    roots.push(root);
    const { store, admission } = await retainedOrigin(root, plan, snapshot);
    const fake = new FakeGithub();
    fake.createResponse = reply;
    const adapter = createGithubReviewAdapter({
      plan,
      snapshot,
      fetch: fake.fetch,
      authorization: () => "Bearer synthetic",
    });
    const result = await executeReviewDelivery({
      plan,
      store,
      originAdmission: admission,
      grantsByActionId: grants(plan),
      effects: adapter,
      recovery: adapter,
    });
    expect(result.kind).toBe("stopped");
    expect(fake.posts).toBe(1);
    expect(fake.calls.every((call) => call.redirect === "manual")).toBe(true);
    expect(result.record?.effects.at(-1)?.state).toBe("uncertain");
    if (_label === "rate limit")
      expect(result.record?.effects.at(-1)?.stop?.retryAfterAt).toBeTruthy();
  });

  it.each(["omitCreatedReview", "duplicateReview", "autoSubmittedOnCreate"] as const)(
    "keeps %s creation uncertainty without replay or adoption",
    async (fault) => {
      const { plan, snapshot } = planFixture();
      const root = await mkdtemp(join(tmpdir(), "github-review-store-"));
      roots.push(root);
      const { store, admission } = await retainedOrigin(root, plan, snapshot);
      const fake = new FakeGithub();
      fake.timeoutCreate = true;
      fake[fault] = true;
      const adapter = createGithubReviewAdapter({
        plan,
        snapshot,
        fetch: fake.fetch,
        authorization: () => "Bearer synthetic",
      });
      const result = await executeReviewDelivery({
        plan,
        store,
        originAdmission: admission,
        grantsByActionId: grants(plan),
        effects: adapter,
        recovery: adapter,
      });
      expect(result.kind).toBe("stopped");
      expect(fake.posts).toBe(1);
    },
  );

  it("does not dispatch when caller-owned throttle refuses the HTTP handoff", async () => {
    const { plan, snapshot } = planFixture();
    const root = await mkdtemp(join(tmpdir(), "github-review-store-"));
    roots.push(root);
    const { store, admission } = await retainedOrigin(root, plan, snapshot);
    const fake = new FakeGithub();
    const adapter = createGithubReviewAdapter({
      plan,
      snapshot,
      fetch: fake.fetch,
      authorization: () => "Bearer synthetic",
      mayPublish: () => false,
    });
    const result = await executeReviewDelivery({
      plan,
      store,
      originAdmission: admission,
      grantsByActionId: grants(plan),
      effects: adapter,
      recovery: adapter,
    });
    expect(result.kind).toBe("stopped");
    expect(fake.posts).toBe(0);
  });
});
