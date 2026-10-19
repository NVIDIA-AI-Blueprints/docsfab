// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fixture as retainedFixture } from "./fixtures/review-delivery/presentation/synthetic.js";
import { canonicalJson, sha256 } from "../src/content-ir/canonical.js";
import { limit } from "../src/config/limits.js";
import { createReviewResultV2 } from "../src/review/index.js";
import type { ReviewDeliveryPlan } from "../src/review-delivery/contracts.js";
import type {
  ReviewDeliveryEffectContextV1,
  ReviewDeliveryPreparedEffect,
} from "../src/review-delivery/execute.js";
import {
  reviewDeliveryBodySha256,
  reviewDeliveryOutboundBytesSha256,
} from "../src/review-delivery/execute.js";
import {
  GitLabReviewDeliveryProvider,
  type GitLabReviewHttpRequest,
  type GitLabReviewHttpResponse,
} from "../src/review-delivery/providers/gitlab.js";
import {
  renderGitLabReviewSummary,
  renderGitLabReviewFinding,
} from "../src/review-delivery/providers/gitlab-render.js";
import {
  admitReviewDeliveryAction,
  createReviewDeliveryGrant,
  createReviewDeliveryPlan,
} from "../src/review-delivery/plan.js";

const BASE = "a".repeat(40);
const START = "b".repeat(40);
const HEAD = "c".repeat(40);
const MR_PATH = "/api/v4/projects/42/merge_requests/7";
const MR_URL = "https://gitlab.example.test/team/docs/-/merge_requests/7";
const DIFF =
  "@@ -8,4 +8,5 @@\n context before\n-old line one\n-old line two\n+new line one\n+new line two\n+new line three\n context after\n";
const VERSION = {
  id: 301,
  merge_request_id: 70,
  base_commit_sha: BASE,
  start_commit_sha: START,
  head_commit_sha: HEAD,
  state: "collected",
  real_size: "1",
  diffs: [{ old_path: "docs/old-name.md", new_path: "docs/new-name.md", diff: DIFF }],
};
const CONTEXT: ReviewDeliveryEffectContextV1 = {
  kind: "docsfab-review-delivery-effect-context",
  schemaVersion: 1,
  logicalDeliveryId: "delivery:7",
  correlationSeed: Buffer.from("synthetic-nonce-seed").toString("base64url"),
  committedEffects: [],
};

function plan(
  kind: "publish-summary" | "publish-inline",
  options: {
    fork?: boolean;
    line?: number;
    endLine?: number;
    side?: "before" | "after";
    reportUrl?: string;
  } = {},
): ReviewDeliveryPlan {
  const target = {
    scmProvider: "gitlab" as const,
    host: "gitlab.example.test",
    projectId: 42,
    mergeRequestIid: 7,
    sourceFork: options.fork ?? false,
    sourceBranch: "topic",
    targetBranch: "main",
    baseSha: BASE,
    headSha: HEAD,
    targetSha256: "d".repeat(64),
  };
  const binding = {
    target,
    sourceSha256: "e".repeat(64),
    snapshotSha256: "f".repeat(64),
    artifact: {
      kind: "retained-review-result" as const,
      id: "artifact:7",
      resultSha256: "0".repeat(64),
    },
    actor: { host: target.host, id: "42" },
    reviewedHeadSha: HEAD,
    startSha: START,
  };
  const finding = {
    inventoryId: "finding:0:review",
    severity: "warning" as const,
    text: "Explain the renamed passage.",
    path: "docs/new-name.md",
    limitations: [],
    disposition: { kind: "summary-candidate", reason: "no-location" },
  };
  const draft =
    kind === "publish-summary"
      ? { kind, binding, findingIds: [finding.inventoryId] }
      : {
          kind,
          binding,
          findingId: finding.inventoryId,
          logicalIssueId: "issue:7",
          anchor: {
            status: "anchored",
            side: options.side ?? "after",
            path: options.side === "before" ? "docs/old-name.md" : "docs/new-name.md",
            startLine: options.line ?? 10,
            endLine: options.endLine ?? options.line ?? 10,
            oldPath: "docs/old-name.md",
            newPath: "docs/new-name.md",
            sourceSha256: "1".repeat(64),
          },
        };
  const action = { ...draft, id: sha256(canonicalJson(draft)) };
  return {
    kind: "docsfab-review-delivery-plan",
    schemaVersion: 1,
    target,
    actor: binding.actor,
    result: { reviewedHeadSha: HEAD, hostedReportUrl: options.reportUrl },
    findings: [finding],
    actions: [action],
    checks: [],
    unresolvedQuestions: [],
    affectedPaths: [],
    limitations: [],
    capabilities: { scmProvider: "gitlab", host: target.host, summary: true, inline: true },
  } as unknown as ReviewDeliveryPlan;
}

class FakeHttp {
  readonly calls: GitLabReviewHttpRequest[] = [];
  version = structuredClone(VERSION);
  mr = {
    id: 70,
    iid: 7,
    project_id: 42,
    source_project_id: 42,
    target_project_id: 42,
    source_branch: "topic",
    target_branch: "main",
    state: "opened",
    web_url: MR_URL,
    diff_refs: { base_sha: BASE, start_sha: START, head_sha: HEAD },
  };
  notes: unknown[] = [];
  notesSecond: unknown[] = [];
  notesThird: unknown[] = [];
  noteLink: string | undefined;
  noteSecondLink: string | undefined;
  noteNextPage: string | undefined;
  noteSecondNextPage: string | undefined;
  noteId = 88;
  postBody: Record<string, unknown> | null = null;
  failPost: "timeout" | "rate" | null = null;
  noteActorId = 42;
  redirectPath: string | null = null;

  async request(request: GitLabReviewHttpRequest): Promise<GitLabReviewHttpResponse> {
    this.calls.push(request);
    if (request.path === this.redirectPath)
      return { status: 302, headers: { Location: MR_URL }, body: {} };
    if (request.method === "POST") {
      this.postBody = JSON.parse(new TextDecoder().decode(request.bodyBytes)) as Record<
        string,
        unknown
      >;
      if (this.failPost === "timeout") throw new Error("synthetic accepted-then-timeout");
      if (this.failPost === "rate")
        return { status: 429, headers: { "Retry-After": "12" }, body: {} };
      return {
        status: 201,
        headers: {},
        body: request.path.endsWith("/notes") ? { id: 88 } : { id: "thread-88" },
      };
    }
    if (request.path === "/api/v4/user") return { status: 200, headers: {}, body: { id: 42 } };
    if (request.path === MR_PATH) return { status: 200, headers: {}, body: this.mr };
    if (request.path === `${MR_PATH}/versions`)
      return { status: 200, headers: {}, body: [{ ...this.version, diffs: undefined }] };
    if (request.path === `${MR_PATH}/versions/301`)
      return { status: 200, headers: {}, body: this.version };
    if (request.path === `${MR_PATH}/notes?per_page=100`)
      return {
        status: 200,
        headers: {
          ...(this.noteLink === undefined ? {} : { Link: this.noteLink }),
          ...(this.noteNextPage === undefined ? {} : { "X-Next-Page": this.noteNextPage }),
        },
        body: this.notes,
      };
    if (request.path === `${MR_PATH}/notes?per_page=100&page=2`)
      return {
        status: 200,
        headers: {
          ...(this.noteSecondLink === undefined ? {} : { Link: this.noteSecondLink }),
          ...(this.noteSecondNextPage === undefined
            ? {}
            : { "X-Next-Page": this.noteSecondNextPage }),
        },
        body: this.notesSecond,
      };
    if (request.path === `${MR_PATH}/notes?per_page=100&page=3`)
      return { status: 200, headers: {}, body: this.notesThird };
    if (request.path === `${MR_PATH}/notes/${this.noteId}`)
      return { status: 200, headers: {}, body: this.note() };
    if (request.path === `${MR_PATH}/discussions/thread-88`)
      return {
        status: 200,
        headers: {},
        body: {
          id: "thread-88",
          individual_note: false,
          notes: [
            {
              id: 88,
              body: this.postBody?.body,
              author: { id: 42 },
              system: false,
              position: this.postBody?.position,
            },
          ],
        },
      };
    throw new Error(`Unexpected fake request ${request.method} ${request.path}`);
  }

  note() {
    return {
      id: this.noteId,
      project_id: 42,
      noteable_iid: 7,
      noteable_type: "MergeRequest",
      author: { id: this.noteActorId },
      body: this.postBody?.body,
      system: false,
    };
  }
}

async function prepare(
  provider: GitLabReviewDeliveryProvider,
  value: ReviewDeliveryPlan,
): Promise<ReviewDeliveryPreparedEffect> {
  const result = await provider.prepareNextEffect({
    plan: value,
    priorObservations: [],
    context: CONTEXT,
  });
  expect(result.kind).toBe("effect");
  if (result.kind !== "effect") throw new Error("expected prepared effect");
  return result;
}

function retainedPlan(
  requestedActions: "overview" | "summary-only",
  inventory: "empty" | "paired" = "paired",
): ReviewDeliveryPlan {
  const input = retainedFixture("gitlab", "addition", {
    sameRepository: true,
    ...(inventory === "empty" ? { issues: [], findings: [], contexts: [] } : {}),
  });
  return createReviewDeliveryPlan({
    ...input,
    actor: { host: input.capabilities.host, id: "42" },
    requestedActions,
  });
}

function httpForRetainedPlan(value: ReviewDeliveryPlan): FakeHttp {
  if (value.target.scmProvider !== "gitlab") throw new Error("expected GitLab plan");
  const http = new FakeHttp();
  http.mr.web_url = `https://${value.target.host}/team/docs/-/merge_requests/7`;
  http.mr.diff_refs = {
    base_sha: value.target.baseSha,
    start_sha: value.actions[0]!.binding.startSha!,
    head_sha: value.target.headSha,
  };
  http.version = {
    ...http.version,
    base_commit_sha: value.target.baseSha,
    start_commit_sha: value.actions[0]!.binding.startSha!,
    head_commit_sha: value.target.headSha,
    diffs: [
      {
        old_path: "docs/guide.md",
        new_path: "docs/guide.md",
        diff: "@@ -0,0 +1 @@\n+after\n",
      },
    ],
  };
  return http;
}

function committed(effect: ReviewDeliveryPreparedEffect) {
  return {
    effectId: effect.effectId,
    stage: effect.stage,
    coveredActionIds: [...effect.coveredActionIds],
    actionPayloads: [...effect.actionPayloads],
    outboundBytesSha256: effect.outboundBytesSha256,
    expectedBodySha256: effect.expectedBodySha256,
    expectedGitLabPositionSha256: null,
    marker: effect.marker,
  };
}

function withLegacyBody(
  effect: ReviewDeliveryPreparedEffect,
  body: string,
): ReviewDeliveryPreparedEffect {
  const request = {
    ...effect.request,
    bodyBytes: new TextEncoder().encode(JSON.stringify({ body })),
  };
  const bodySha256 = reviewDeliveryBodySha256(body);
  return {
    ...effect,
    request,
    outboundBytesSha256: reviewDeliveryOutboundBytesSha256(request),
    expectedBodySha256: bodySha256,
    actionPayloads: [{ ...effect.actionPayloads[0]!, bodySha256 }],
  };
}

describe("GitLab review delivery provider", () => {
  it("includes sealed per-page template coverage in a real D1 summary-only note", async () => {
    const seed = retainedFixture("gitlab", "addition", { sameRepository: true });
    const original = seed.result;
    const result = createReviewResultV2(seed.target, seed.source, {
      taskId: original.taskId,
      runIdSha256: original.runIdSha256,
      findings: original.findings,
      checks: original.checks,
      unresolvedQuestions: original.unresolvedQuestions,
      affectedPaths: original.affectedPaths,
      patchLocator: original.patchLocator,
      locatorSha256: original.locatorSha256,
      reviewScope: {
        ...original.reviewScope!,
        templateCoverage: {
          reportDigest: "e".repeat(64),
          pages: [
            {
              path: "docs/guide.md",
              mapping: "mapped",
              applicability: "applicable",
              reason: "Matched page template.",
              templateId: "beginner-tutorial-gfm",
              conformance: "failed",
              rules: [
                {
                  rule: "missing-required-heading",
                  severity: "error",
                  expected: "h2:Prerequisites",
                  line: 1,
                },
              ],
              suggestionIds: [],
              rubric: { status: "unknown", reason: "Selected rubric evidence unavailable." },
            },
          ],
        },
      },
    });
    const value = createReviewDeliveryPlan({
      ...seed,
      result,
      artifact: { ...seed.artifact, resultSha256: result.resultSha256 },
      actor: { host: seed.capabilities.host, id: "42" },
      requestedActions: "summary-only",
    });
    const provider = new GitLabReviewDeliveryProvider(
      value.target.host,
      httpForRetainedPlan(value),
    );
    const effect = await prepare(provider, value);
    const body = JSON.parse(new TextDecoder().decode(effect.request.bodyBytes)).body as string;
    expect(body).toContain("Template coverage:");
    expect(body).toContain("docs/guide\\.md");
    expect(body).toContain("missing\\-required\\-heading");
    expect(body).toContain("h2:Prerequisites");
    expect(body).toContain("Selected rubric evidence unavailable");
  });

  it("reconstructs only the exact committed rich descriptor for an explicit overview", async () => {
    const value = retainedPlan("overview", "empty");
    const http = httpForRetainedPlan(value);
    const provider = new GitLabReviewDeliveryProvider(value.target.host, http);
    const fresh = await prepare(provider, value);
    const context = { ...CONTEXT, committedEffects: [committed(fresh)] };
    expect(
      await provider.prepareNextEffect({ plan: value, priorObservations: [], context }),
    ).toEqual(fresh);
    const tampered = {
      ...CONTEXT,
      committedEffects: [{ ...committed(fresh), outboundBytesSha256: "f".repeat(64) }],
    };
    expect(
      (await provider.prepareNextEffect({ plan: value, priorObservations: [], context: tampered }))
        .kind,
    ).toBe("blocked");
    expect(http.calls.filter((call) => call.method === "POST")).toHaveLength(0);
  });

  it("renders real summary-only retained omissions and inert producer prose", async () => {
    const input = retainedFixture("gitlab", "addition", { sameRepository: true });
    const value = createReviewDeliveryPlan({
      ...input,
      actor: { host: input.capabilities.host, id: "42" },
      requestedActions: "summary-only",
      extensions: {
        presentation: {
          select(finding) {
            return finding.source === "finding" ? "retained" : "summary";
          },
        },
      },
    });
    const provider = new GitLabReviewDeliveryProvider(
      value.target.host,
      httpForRetainedPlan(value),
    );
    const effect = await prepare(provider, value);
    const body = JSON.parse(new TextDecoder().decode(effect.request.bodyBytes)).body as string;
    expect(body).toContain("1 summary finding; 0 inline findings");
    expect(body).toContain("not published: 1");
    expect(body).toContain("presentation\\-unsupported");
    expect(body).toContain("Is the example current?");
    expect(body).not.toContain("https://evil.example/attack");
    expect(body).not.toContain("@maintainer");
  });

  it.each(["all-inline", "mixed"] as const)(
    "delivers real D1 %s overview after an authenticated inline readback",
    async (shape) => {
      const input = retainedFixture("gitlab", "addition", {
        sameRepository: true,
        ...(shape === "all-inline" ? { findings: [] } : {}),
      });
      const value = createReviewDeliveryPlan({
        ...input,
        actor: { host: input.capabilities.host, id: "42" },
        requestedActions: "overview",
        ...(shape === "mixed"
          ? {
              extensions: {
                presentation: {
                  select: (finding: { source: string }) =>
                    finding.source === "finding" ? ("summary" as const) : ("inline" as const),
                },
              },
            }
          : {}),
      });
      const http = httpForRetainedPlan(value);
      const provider = new GitLabReviewDeliveryProvider(value.target.host, http);
      const grant = createReviewDeliveryGrant({
        verifyCurrent(action) {
          return { status: "admitted", actionId: action.id, kind: action.kind };
        },
      });
      const inlineEffect = await prepare(provider, value);
      expect(inlineEffect.stage).toBe("gitlab-discussion");
      const inlineAction = value.actions.find(
        (item) => item.id === inlineEffect.coveredActionIds[0],
      )!;
      const published = await provider.publishEffect({
        plan: value,
        effect: inlineEffect,
        grantsByActionId: new Map([[inlineAction.id, grant]]),
      });
      expect(published).toMatchObject({ kind: "confirmed", providerReference: "thread-88" });
      const observed = await provider.observeEffect({
        action: inlineAction,
        effect: inlineEffect,
        context: CONTEXT,
        phase: "recovery",
        providerReference: "thread-88",
      });
      expect(observed.kind).toBe("matching");
      if (observed.kind !== "matching") throw new Error("expected authenticated inline readback");
      const prepared = await provider.prepareNextEffect({
        plan: value,
        priorObservations: [observed],
        context: CONTEXT,
      });
      expect(prepared.kind).toBe("effect");
      if (prepared.kind !== "effect") throw new Error("expected summary effect");
      expect(prepared.stage).toBe("gitlab-note");
      const body = JSON.parse(new TextDecoder().decode(prepared.request.bodyBytes)).body as string;
      expect(body).toContain("Discussion 1: [open thread]");
      expect(body).toContain("Source check");
      expect(body).toContain("Total:");
      expect(body).toContain(
        shape === "mixed"
          ? "1 summary finding; 1 inline finding"
          : "0 summary findings; 1 inline finding",
      );
      const summaryAction = value.actions.find((item) => item.id === prepared.coveredActionIds[0])!;
      expect(
        await provider.publishEffect({
          plan: value,
          effect: prepared,
          grantsByActionId: new Map([[summaryAction.id, grant]]),
        }),
      ).toMatchObject({ kind: "confirmed", providerReference: "88" });
      expect(
        (
          await provider.observeEffect({
            action: summaryAction,
            effect: prepared,
            context: CONTEXT,
            phase: "recovery",
            providerReference: "88",
          })
        ).kind,
      ).toBe("matching");
      expect(http.calls.filter((call) => call.method === "POST")).toHaveLength(2);
    },
  );

  it("resumes exact committed legacy default bytes but refuses them under explicit intent", async () => {
    const input = retainedFixture("gitlab", "addition", { sameRepository: true, inline: false });
    const actor = { host: input.capabilities.host, id: "42" };
    const oldPlan = createReviewDeliveryPlan({ ...input, actor });
    const explicitPlan = createReviewDeliveryPlan({
      ...input,
      actor,
      requestedActions: "summary-only",
    });
    expect(oldPlan.actions.map((item) => item.id)).toEqual(
      explicitPlan.actions.map((item) => item.id),
    );
    const http = httpForRetainedPlan(oldPlan);
    const provider = new GitLabReviewDeliveryProvider(oldPlan.target.host, http);
    const fresh = await prepare(provider, oldPlan);
    const richBody = JSON.parse(new TextDecoder().decode(fresh.request.bodyBytes)).body as string;
    expect(richBody).toContain("&#64;&#8203;maintainer");
    expect(richBody).not.toContain("https://evil.example/attack");
    const summary = oldPlan.actions[0]!;
    if (summary.kind !== "publish-summary") throw new Error("expected summary");
    const legacyBody = renderGitLabReviewSummary({
      findings: summary.findingIds.map(
        (id) => oldPlan.findings.find((item) => item.inventoryId === id)!,
      ),
      inlineCount: 0,
      reviewedHeadSha: summary.binding.reviewedHeadSha,
      mrUrl: http.mr.web_url,
      reportUrl: oldPlan.result.hostedReportUrl ?? null,
      threadUrls: [],
      marker: fresh.marker,
    });
    const legacy = withLegacyBody(fresh, legacyBody);
    const grant = createReviewDeliveryGrant({
      verifyCurrent(action) {
        return { status: "admitted", actionId: action.id, kind: action.kind };
      },
    });
    // The fresh default selection was rich. A caller cannot substitute valid
    // historical bytes merely because both variants share an action ID.
    expect(
      await provider.publishEffect({
        plan: oldPlan,
        effect: legacy,
        grantsByActionId: new Map([[summary.id, grant]]),
      }),
    ).toMatchObject({ kind: "not-dispatched" });
    expect(http.calls.filter((call) => call.method === "POST")).toHaveLength(0);
    Object.assign(fresh, legacy);
    expect(
      await provider.publishEffect({
        plan: oldPlan,
        effect: fresh,
        grantsByActionId: new Map([[summary.id, grant]]),
      }),
    ).toMatchObject({ kind: "not-dispatched" });
    expect(http.calls.filter((call) => call.method === "POST")).toHaveLength(0);
    const context = { ...CONTEXT, committedEffects: [committed(legacy)] };
    const restarted = new GitLabReviewDeliveryProvider(oldPlan.target.host, http);
    const resumed = await restarted.prepareNextEffect({
      plan: oldPlan,
      priorObservations: [],
      context,
    });
    expect(resumed).toEqual(legacy);
    expect(
      await restarted.publishEffect({
        plan: oldPlan,
        effect: resumed,
        grantsByActionId: new Map([[summary.id, grant]]),
      }),
    ).toMatchObject({ kind: "confirmed", providerReference: "88" });
    const refused = await restarted.prepareNextEffect({
      plan: explicitPlan,
      priorObservations: [],
      context,
    });
    expect(refused.kind).toBe("blocked");
    expect(
      await restarted.publishEffect({
        plan: explicitPlan,
        effect: legacy,
        grantsByActionId: new Map([[summary.id, grant]]),
      }),
    ).toMatchObject({ kind: "not-dispatched" });
    expect(http.calls.filter((call) => call.method === "POST")).toHaveLength(1);
  });

  it("refuses a complete oversized rich body while preserving an exact legacy candidate", async () => {
    const base = plan("publish-summary");
    const oversized = {
      ...base,
      checks: [
        {
          id: "check:oversized",
          name: "x".repeat(limit("host.gitlab.noteBodyMaxChars").value + 1),
          status: "passed" as const,
        },
      ],
    };
    const http = new FakeHttp();
    const provider = new GitLabReviewDeliveryProvider("gitlab.example.test", http);
    const fresh = await provider.prepareNextEffect({
      plan: oversized,
      priorObservations: [],
      context: CONTEXT,
    });
    expect(fresh.kind).toBe("blocked");
    expect(http.calls.filter((call) => call.method === "POST")).toHaveLength(0);

    const normal = await prepare(provider, base);
    const action = base.actions[0]!;
    if (action.kind !== "publish-summary") throw new Error("expected summary");
    const legacyBody = renderGitLabReviewSummary({
      findings: action.findingIds.map(
        (id) => base.findings.find((item) => item.inventoryId === id)!,
      ),
      inlineCount: 0,
      reviewedHeadSha: action.binding.reviewedHeadSha,
      mrUrl: MR_URL,
      reportUrl: null,
      threadUrls: [],
      marker: normal.marker,
    });
    const legacy = withLegacyBody(normal, legacyBody);
    const resumed = await provider.prepareNextEffect({
      plan: oversized,
      priorObservations: [],
      context: { ...CONTEXT, committedEffects: [committed(legacy)] },
    });
    expect(resumed).toEqual(legacy);
    expect(http.calls.filter((call) => call.method === "POST")).toHaveLength(0);
  });
  it.each(["overview", "summary-only"] as const)(
    "publishes a useful real D1 %s zero-finding overview",
    async (requestedActions) => {
      const value = retainedPlan(requestedActions, "empty");
      const http = httpForRetainedPlan(value);
      const provider = new GitLabReviewDeliveryProvider(value.target.host, http);
      expect(value.actions).toMatchObject([{ kind: "publish-summary", findingIds: [] }]);
      const effect = await prepare(provider, value);
      const outbound = JSON.parse(new TextDecoder().decode(effect.request.bodyBytes)) as {
        body: string;
      };
      expect(outbound.body).toContain("0 summary findings");
      expect(outbound.body).toContain("0 inline findings");
      expect(outbound.body).toContain("Source check");
      expect(outbound.body).toContain("Is the example current?");
      expect(outbound.body).toContain("focused\\-set");
      expect(outbound.body).toContain("docs/later\\.md");
      const grant = createReviewDeliveryGrant({
        verifyCurrent(action) {
          return { status: "admitted", actionId: action.id, kind: action.kind };
        },
      });
      const published = await provider.publishEffect({
        plan: value,
        effect,
        grantsByActionId: new Map([[value.actions[0]!.id, grant]]),
      });
      expect(published).toMatchObject({ kind: "confirmed", providerReference: "88" });
      const observed = await provider.observeEffect({
        action: value.actions[0]!,
        effect,
        context: CONTEXT,
        phase: "recovery",
        providerReference: "88",
      });
      expect(observed.kind).toBe("matching");
      expect(http.calls.filter((call) => call.method === "POST")).toHaveLength(1);
    },
  );

  it.each(["timeout", "rate"] as const)("makes only one POST after %s", async (failure) => {
    const http = new FakeHttp();
    const provider = new GitLabReviewDeliveryProvider("gitlab.example.test", http);
    const value = plan("publish-summary");
    const effect = await prepare(provider, value);
    const grant = createReviewDeliveryGrant({
      verifyCurrent(action) {
        return { status: "admitted", actionId: action.id, kind: action.kind };
      },
    });
    http.failPost = failure;
    const outcome = await provider.publishEffect({
      plan: value,
      effect,
      grantsByActionId: new Map([[value.actions[0]!.id, grant]]),
    });
    expect(outcome.kind).toBe("uncertain");
    if (outcome.kind === "uncertain") {
      expect(outcome.stop?.code).toBe(failure === "rate" ? "rate-limited" : "transport-failure");
      if (failure === "rate") expect(outcome.stop?.retryAfterAt).toMatch(/^\d{4}-/u);
    }
    expect(http.calls.filter((call) => call.method === "POST")).toHaveLength(1);
  });

  it("prepares a summary note with retained report link and authenticates direct readback", async () => {
    const http = new FakeHttp();
    const provider = new GitLabReviewDeliveryProvider("gitlab.example.test", http);
    const value = plan("publish-summary", {
      reportUrl: "https://reports.example.test/reports/run-7/",
    });
    const effect = await prepare(provider, value);
    const outbound = JSON.parse(new TextDecoder().decode(effect.request.bodyBytes)) as {
      body: string;
    };
    expect(effect.request.path).toBe(`${MR_PATH}/notes`);
    expect(effect.outboundBytesSha256).toBe(reviewDeliveryOutboundBytesSha256(effect.request));
    expect(outbound.body).toContain("https://reports.example.test/reports/run-7/");
    http.postBody = outbound;
    const baseline = await provider.observeEffect({
      action: value.actions[0]!,
      effect,
      context: CONTEXT,
      phase: "pre-dispatch-baseline",
      providerReference: null,
    });
    expect(baseline.kind).toBe("absent-proven");
    const observed = await provider.observeEffect({
      action: value.actions[0]!,
      effect,
      context: CONTEXT,
      phase: "recovery",
      providerReference: "88",
    });
    expect(observed.kind).toBe("matching");
    if (observed.kind === "matching")
      expect(observed.native).toMatchObject({
        kind: "gitlab-note",
        noteId: 88,
        body: outbound.body,
      });
    http.notes = [http.note()];
    const preexisting = await provider.observeEffect({
      action: value.actions[0]!,
      effect,
      context: CONTEXT,
      phase: "pre-dispatch-baseline",
      providerReference: null,
    });
    expect(preexisting.kind).toBe("conflict");
  });

  it("states when the retained result has no report URL", async () => {
    const effect = await prepare(
      new GitLabReviewDeliveryProvider("gitlab.example.test", new FakeHttp()),
      plan("publish-summary"),
    );
    expect(new TextDecoder().decode(effect.request.bodyBytes)).toContain("Report link unavailable");
    expect(new TextDecoder().decode(effect.request.bodyBytes)).not.toContain("artifact:7");
  });

  it("reconstructs an authenticated prior discussion link before publishing the summary", async () => {
    const http = new FakeHttp();
    const provider = new GitLabReviewDeliveryProvider("gitlab.example.test", http);
    const inline = plan("publish-inline");
    const summary = plan("publish-summary");
    const composed = { ...summary, actions: [summary.actions[0]!, inline.actions[0]!] };
    const inlineEffect = await prepare(provider, composed);
    expect(inlineEffect.coveredActionIds).toEqual([inline.actions[0]!.id]);
    const grant = createReviewDeliveryGrant({
      verifyCurrent(action) {
        return { status: "admitted", actionId: action.id, kind: action.kind };
      },
    });
    const inlinePublished = await provider.publishEffect({
      plan: composed,
      effect: inlineEffect,
      grantsByActionId: new Map([[inline.actions[0]!.id, grant]]),
    });
    expect(inlinePublished).toMatchObject({ kind: "confirmed", providerReference: "thread-88" });
    const observed = await provider.observeEffect({
      action: inline.actions[0]!,
      effect: inlineEffect,
      context: CONTEXT,
      phase: "recovery",
      providerReference: "thread-88",
    });
    expect(observed.kind).toBe("matching");
    const restarted = new GitLabReviewDeliveryProvider("gitlab.example.test", http);
    const preparation = await provider.prepareNextEffect({
      plan: composed,
      priorObservations: [observed],
      context: CONTEXT,
    });
    expect(preparation.kind).toBe("effect");
    if (preparation.kind !== "effect") return;
    const reconstructed = await restarted.prepareNextEffect({
      plan: composed,
      priorObservations: [observed],
      context: CONTEXT,
    });
    expect(reconstructed.kind).toBe("effect");
    if (reconstructed.kind !== "effect") return;
    expect(reconstructed.outboundBytesSha256).toBe(preparation.outboundBytesSha256);
    expect(reconstructed.request.bodyBytes).toEqual(preparation.request.bodyBytes);
    expect(new TextDecoder().decode(preparation.request.bodyBytes)).toContain(`${MR_URL}#note_88`);
    const published = await restarted.publishEffect({
      plan: composed,
      effect: reconstructed,
      grantsByActionId: new Map([[summary.actions[0]!.id, grant]]),
    });
    expect(published).toMatchObject({ kind: "confirmed", providerReference: "88" });
    expect(http.calls.filter((call) => call.method === "POST").map((call) => call.path)).toEqual([
      `${MR_PATH}/discussions`,
      `${MR_PATH}/notes`,
    ]);
  });

  it.each([
    ["wrong MR", "https://gitlab.example.test/other/docs/-/merge_requests/8#note_88"],
    ["appended query", `${MR_URL}#note_88?mode=edit`],
  ])("refuses a retained %s discussion link with zero POST", async (_name, badLink) => {
    const http = new FakeHttp();
    const provider = new GitLabReviewDeliveryProvider("gitlab.example.test", http);
    const inline = plan("publish-inline");
    const summary = plan("publish-summary");
    const composed = { ...summary, actions: [summary.actions[0]!, inline.actions[0]!] };
    const inlineEffect = await prepare(provider, composed);
    http.postBody = JSON.parse(new TextDecoder().decode(inlineEffect.request.bodyBytes)) as Record<
      string,
      unknown
    >;
    const observed = await provider.observeEffect({
      action: inline.actions[0]!,
      effect: inlineEffect,
      context: CONTEXT,
      phase: "recovery",
      providerReference: "thread-88",
    });
    expect(observed.kind).toBe("matching");
    const prepared = await provider.prepareNextEffect({
      plan: composed,
      priorObservations: [observed],
      context: CONTEXT,
    });
    expect(prepared.kind).toBe("effect");
    if (prepared.kind !== "effect") return;
    const requestBody = JSON.parse(new TextDecoder().decode(prepared.request.bodyBytes)) as {
      body: string;
    };
    requestBody.body = requestBody.body.replace(`${MR_URL}#note_88`, badLink);
    const request = {
      ...prepared.request,
      bodyBytes: new TextEncoder().encode(JSON.stringify(requestBody)),
    };
    const tampered = {
      ...prepared,
      request,
      outboundBytesSha256: reviewDeliveryOutboundBytesSha256(request),
    };
    const grant = createReviewDeliveryGrant({
      verifyCurrent(action) {
        return { status: "admitted", actionId: action.id, kind: action.kind };
      },
    });
    const outcome = await provider.publishEffect({
      plan: composed,
      effect: tampered,
      grantsByActionId: new Map([[summary.actions[0]!.id, grant]]),
    });
    expect(outcome.kind).toBe("not-dispatched");
    expect(http.calls.filter((call) => call.method === "POST")).toHaveLength(0);
  });

  it("refuses a host redirect before preparing any effect", async () => {
    const http = new FakeHttp();
    http.redirectPath = MR_PATH;
    const value = plan("publish-summary");
    const prepared = await new GitLabReviewDeliveryProvider(
      "gitlab.example.test",
      http,
    ).prepareNextEffect({ plan: value, priorObservations: [], context: CONTEXT });
    expect(prepared).toMatchObject({
      kind: "blocked",
      actionId: value.actions[0]!.id,
      code: "provider-failure",
      next: "retry",
    });
    expect(http.calls.filter((call) => call.method === "POST")).toHaveLength(0);
  });

  it("returns authenticated null-reference candidates only after complete enumeration and direct GET", async () => {
    const http = new FakeHttp();
    const provider = new GitLabReviewDeliveryProvider("gitlab.example.test", http);
    const value = plan("publish-summary");
    const effect = await prepare(provider, value);
    http.postBody = JSON.parse(new TextDecoder().decode(effect.request.bodyBytes)) as Record<
      string,
      unknown
    >;
    http.notes = [http.note()];
    const observed = await provider.observeEffect({
      action: value.actions[0]!,
      effect,
      context: CONTEXT,
      phase: "recovery",
      providerReference: null,
    });
    expect(observed.kind).toBe("matching");
    if (observed.kind === "matching")
      expect(observed.discovery).toMatchObject({
        kind: "complete-enumeration",
        matchingCandidateCount: 1,
        directGetVerified: true,
      });
    expect(http.calls.some((call) => call.path === `${MR_PATH}/notes/88`)).toBe(true);
    http.notes = [http.note(), http.note()];
    const duplicate = await provider.observeEffect({
      action: value.actions[0]!,
      effect,
      context: CONTEXT,
      phase: "recovery",
      providerReference: null,
    });
    expect(duplicate.kind).toBe("conflict");
    http.notes = [{ ...http.note(), body: `${effect.marker} changed by another writer` }];
    const changed = await provider.observeEffect({
      action: value.actions[0]!,
      effect,
      context: CONTEXT,
      phase: "recovery",
      providerReference: null,
    });
    expect(changed.kind).toBe("conflict");
  });

  it("refuses wrong authenticated actor and wrong note author", async () => {
    const http = new FakeHttp();
    const provider = new GitLabReviewDeliveryProvider("gitlab.example.test", http);
    const value = plan("publish-summary");
    const effect = await prepare(provider, value);
    http.postBody = JSON.parse(new TextDecoder().decode(effect.request.bodyBytes)) as Record<
      string,
      unknown
    >;
    http.noteActorId = 99;
    const observed = await provider.observeEffect({
      action: value.actions[0]!,
      effect,
      context: CONTEXT,
      phase: "recovery",
      providerReference: "88",
    });
    expect(observed.kind).toBe("conflict");
  });

  it.each([
    ["added", "after", 10, 10, null, 10, null],
    ["context", "after", 12, 12, 11, 12, null],
    ["removed", "before", 9, 9, 9, null, null],
    ["multiline-added", "after", 10, 11, null, 11, "new"],
    ["mixed-added-context", "after", 11, 12, 11, 12, "new"],
    ["multiline-removed", "before", 9, 10, 10, null, "old"],
  ] as const)(
    "maps %s through authenticated hunk rows",
    async (_name, side, line, endLine, oldLine, newLine, rangeType) => {
      const http = new FakeHttp();
      http.mr.source_project_id = 84;
      const provider = new GitLabReviewDeliveryProvider("gitlab.example.test", http);
      const value = plan("publish-inline", { side, line, endLine, fork: true });
      const effect = await prepare(provider, value);
      expect(effect.request.path).toBe(`${MR_PATH}/discussions`);
      expect(effect.outboundBytesSha256).toBe(reviewDeliveryOutboundBytesSha256(effect.request));
      expect(effect.expectedGitLabPosition).toMatchObject({
        baseSha: BASE,
        startSha: START,
        headSha: HEAD,
        oldPath: "docs/old-name.md",
        newPath: "docs/new-name.md",
        oldLine,
        newLine,
      });
      expect(effect.expectedGitLabPosition?.lineRange?.start.type ?? null).toBe(rangeType);
      if (_name === "multiline-added") {
        const pathHash = createHash("sha1").update("docs/new-name.md").digest("hex");
        expect(effect.expectedGitLabPosition?.lineRange).toMatchObject({
          start: { lineCode: `${pathHash}_10_10`, type: "new" },
          end: { lineCode: `${pathHash}_10_11`, type: "new" },
        });
      }
      if (_name === "mixed-added-context") {
        expect(effect.expectedGitLabPosition?.lineRange).toMatchObject({
          start: { type: "new", oldLine: null, newLine: 11 },
          end: { type: "old", oldLine: 11, newLine: 12 },
        });
      }
      http.postBody = JSON.parse(new TextDecoder().decode(effect.request.bodyBytes)) as Record<
        string,
        unknown
      >;
      const observed = await provider.observeEffect({
        action: value.actions[0]!,
        effect,
        context: CONTEXT,
        phase: "recovery",
        providerReference: "thread-88",
      });
      expect(observed.kind).toBe("matching");
      const unreferenced = await provider.observeEffect({
        action: value.actions[0]!,
        effect,
        context: CONTEXT,
        phase: "recovery",
        providerReference: null,
      });
      expect(unreferenced.kind).toBe("ambiguous");
    },
  );

  it("retains an unprovable inline action with zero POSTs", async () => {
    const http = new FakeHttp();
    const provider = new GitLabReviewDeliveryProvider("gitlab.example.test", http);
    const value = plan("publish-inline", { line: 900 });
    const result = await provider.prepareNextEffect({
      plan: value,
      priorObservations: [],
      context: CONTEXT,
    });
    expect(result).toEqual({
      kind: "blocked",
      actionId: value.actions[0]!.id,
      code: "position-unprovable",
      next: "replan-required",
      retryAfterAt: null,
    });
    expect(http.calls.filter((call) => call.method === "POST")).toHaveLength(0);
  });

  it("uses zero as the GitLab old cursor for a new file at line one", async () => {
    const http = new FakeHttp();
    http.version.diffs[0]!.diff = "@@ -0,0 +1,2 @@\n+first\n+second\n";
    const effect = await prepare(
      new GitLabReviewDeliveryProvider("gitlab.example.test", http),
      plan("publish-inline", { line: 1, endLine: 2 }),
    );
    const pathHash = createHash("sha1").update("docs/new-name.md").digest("hex");
    expect(effect.expectedGitLabPosition?.lineRange).toMatchObject({
      start: { lineCode: `${pathHash}_0_1`, type: "new" },
      end: { lineCode: `${pathHash}_0_2`, type: "new" },
    });
  });

  it("requires a distinct action grant for a separately planned summary fallback", () => {
    const inline = plan("publish-inline");
    const summary = plan("publish-summary");
    expect(summary.actions[0]!.id).not.toBe(inline.actions[0]!.id);
    const inlineGrant = createReviewDeliveryGrant({
      verifyCurrent(action) {
        return { status: "admitted", actionId: inline.actions[0]!.id, kind: action.kind };
      },
    });
    const summaryGrant = createReviewDeliveryGrant({
      verifyCurrent(action) {
        return { status: "admitted", actionId: action.id, kind: action.kind };
      },
    });
    expect(admitReviewDeliveryAction(summary, summary.actions[0]!, inlineGrant).status).toBe(
      "blocked",
    );
    expect(admitReviewDeliveryAction(summary, summary.actions[0]!, summaryGrant).status).toBe(
      "admitted",
    );
  });

  it.each([
    [
      "unknown renamed path",
      "position-unprovable",
      (http: FakeHttp) => {
        http.version.diffs[0]!.new_path = "docs/other.md";
      },
    ],
    [
      "overflow version",
      "diff-unavailable",
      (http: FakeHttp) => {
        http.version.state = "overflow";
      },
    ],
    [
      "truncated hunk",
      "diff-unavailable",
      (http: FakeHttp) => {
        http.version.diffs[0]!.diff = DIFF.replace(" context after\n", "");
      },
    ],
    [
      "shifted line",
      "position-unprovable",
      (http: FakeHttp) => {
        http.version.diffs[0]!.diff = DIFF.replace("@@ -8,4 +8,5 @@", "@@ -18,4 +18,5 @@");
      },
    ],
  ] as const)("blocks %s before dispatch", async (_name, code, alter) => {
    const http = new FakeHttp();
    alter(http);
    const provider = new GitLabReviewDeliveryProvider("gitlab.example.test", http);
    const value = plan("publish-inline");
    const prepared = await provider.prepareNextEffect({
      plan: value,
      priorObservations: [],
      context: CONTEXT,
    });
    expect(prepared).toMatchObject({
      kind: "blocked",
      actionId: value.actions[0]!.id,
      code,
      next: "replan-required",
    });
    expect(http.calls.filter((call) => call.method === "POST")).toHaveLength(0);
  });

  it("rejects a same-origin link to another project before sending it", async () => {
    const http = new FakeHttp();
    const provider = new GitLabReviewDeliveryProvider("gitlab.example.test", http);
    const value = plan("publish-summary");
    const effect = await prepare(provider, value);
    http.notes = Array.from({ length: 100 }, (_, id) => ({ id }));
    http.noteLink =
      '<https://gitlab.example.test/api/v4/projects/43/merge_requests/7/notes?page=2&per_page=100>; rel="next"';
    const observed = await provider.observeEffect({
      action: value.actions[0]!,
      effect,
      context: CONTEXT,
      phase: "pre-dispatch-baseline",
      providerReference: null,
    });
    expect(observed.kind).toBe("unavailable");
    expect(http.calls.some((call) => call.path.includes("projects/43"))).toBe(false);
  });

  it.each([
    ["skipped page", "3"],
    ["conflicting X-Next-Page", "2"],
  ])("rejects a %s pagination link before a second GET", async (_name, next) => {
    const http = new FakeHttp();
    const provider = new GitLabReviewDeliveryProvider("gitlab.example.test", http);
    const value = plan("publish-summary");
    const effect = await prepare(provider, value);
    http.notes = Array.from({ length: 100 }, (_, id) => ({ id }));
    http.noteLink = `<https://gitlab.example.test${MR_PATH}/notes?per_page=100&page=${next}>; rel="next"`;
    if (_name === "conflicting X-Next-Page") http.noteNextPage = "3";
    const observed = await provider.observeEffect({
      action: value.actions[0]!,
      effect,
      context: CONTEXT,
      phase: "pre-dispatch-baseline",
      providerReference: null,
    });
    expect(observed.kind).toBe("unavailable");
    expect(http.calls.filter((call) => /[?&]page=/u.test(call.path))).toHaveLength(0);
  });

  it("does not prove absence from a full page without trustworthy continuation", async () => {
    const http = new FakeHttp();
    const provider = new GitLabReviewDeliveryProvider("gitlab.example.test", http);
    const value = plan("publish-summary");
    const effect = await prepare(provider, value);
    http.notes = Array.from({ length: 100 }, (_, id) => ({ id }));
    const observed = await provider.observeEffect({
      action: value.actions[0]!,
      effect,
      context: CONTEXT,
      phase: "pre-dispatch-baseline",
      providerReference: null,
    });
    expect(observed.kind).toBe("unavailable");
  });

  it("enumerates all authorized note pages before proving absence", async () => {
    const http = new FakeHttp();
    const provider = new GitLabReviewDeliveryProvider("gitlab.example.test", http);
    const value = plan("publish-summary");
    const effect = await prepare(provider, value);
    http.notes = Array.from({ length: 100 }, (_, id) => ({ id: id + 1, body: "other" }));
    http.notesSecond = [{ id: 101, body: "other" }];
    http.noteLink = `<https://gitlab.example.test${MR_PATH}/notes?per_page=100&page=2>; rel="next"`;
    const observed = await provider.observeEffect({
      action: value.actions[0]!,
      effect,
      context: CONTEXT,
      phase: "pre-dispatch-baseline",
      providerReference: null,
    });
    expect(observed.kind).toBe("absent-proven");
    expect(http.calls.some((call) => call.path === `${MR_PATH}/notes?per_page=100&page=2`)).toBe(
      true,
    );
  });

  it.each(["Link", "X-Next-Page"] as const)(
    "enumerates three %s pages before absence and direct-GET recovery",
    async (mode) => {
      const http = new FakeHttp();
      const provider = new GitLabReviewDeliveryProvider("gitlab.example.test", http);
      const value = plan("publish-summary");
      const effect = await prepare(provider, value);
      const page = (number: number) => `${MR_PATH}/notes?per_page=100&page=${number}`;
      http.notes = Array.from({ length: 100 }, (_, id) => ({ id: id + 1, body: "other" }));
      http.notesSecond = Array.from({ length: 100 }, (_, id) => ({
        id: id + 101,
        body: "other",
      }));
      http.notesThird = [{ id: 201, body: "other" }];
      if (mode === "Link") {
        http.noteLink = `<https://gitlab.example.test${page(2)}>; rel="next"`;
        http.noteSecondLink = `<https://gitlab.example.test${page(3)}>; rel="next"`;
      } else {
        http.noteNextPage = "2";
        http.noteSecondNextPage = "3";
      }
      const baseline = await provider.observeEffect({
        action: value.actions[0]!,
        effect,
        context: CONTEXT,
        phase: "pre-dispatch-baseline",
        providerReference: null,
      });
      expect(baseline.kind).toBe("absent-proven");
      http.noteId = 888;
      http.postBody = JSON.parse(new TextDecoder().decode(effect.request.bodyBytes)) as Record<
        string,
        unknown
      >;
      http.notesThird = [http.note()];
      const recovered = await provider.observeEffect({
        action: value.actions[0]!,
        effect,
        context: CONTEXT,
        phase: "recovery",
        providerReference: null,
      });
      expect(recovered.kind).toBe("matching");
      if (recovered.kind === "matching") {
        expect(recovered.discovery).toMatchObject({
          kind: "complete-enumeration",
          matchingCandidateCount: 1,
          directGetVerified: true,
        });
        expect(recovered.native).toMatchObject({ noteId: 888, body: http.postBody.body });
      }
      expect(http.calls.filter((call) => call.path === page(2))).toHaveLength(2);
      expect(http.calls.filter((call) => call.path === page(3))).toHaveLength(2);
      expect(http.calls.filter((call) => call.path === `${MR_PATH}/notes/888`)).toHaveLength(1);
      expect(http.calls.filter((call) => call.method === "POST")).toHaveLength(0);
    },
  );

  it.each([
    ["skipped page", `${MR_PATH}/notes?per_page=100&page=4`, undefined],
    ["cycled page", `${MR_PATH}/notes?per_page=100&page=1`, undefined],
    ["conflicting header", `${MR_PATH}/notes?per_page=100&page=3`, "4"],
    ["wrong project", "/api/v4/projects/43/merge_requests/7/notes?per_page=100&page=3", undefined],
  ] as const)("refuses a later %s before another GET", async (_name, nextPath, nextHeader) => {
    const http = new FakeHttp();
    const provider = new GitLabReviewDeliveryProvider("gitlab.example.test", http);
    const value = plan("publish-summary");
    const effect = await prepare(provider, value);
    http.notes = Array.from({ length: 100 }, (_, id) => ({ id: id + 1, body: "other" }));
    http.notesSecond = Array.from({ length: 100 }, (_, id) => ({
      id: id + 101,
      body: "other",
    }));
    http.noteLink = `<https://gitlab.example.test${MR_PATH}/notes?per_page=100&page=2>; rel="next"`;
    http.noteSecondLink = `<https://gitlab.example.test${nextPath}>; rel="next"`;
    http.noteSecondNextPage = nextHeader;
    const observed = await provider.observeEffect({
      action: value.actions[0]!,
      effect,
      context: CONTEXT,
      phase: "pre-dispatch-baseline",
      providerReference: null,
    });
    expect(observed.kind).toBe("unavailable");
    const enumerated = http.calls.filter((call) => call.path.includes("/notes?"));
    expect(enumerated.map((call) => call.path)).toEqual([
      `${MR_PATH}/notes?per_page=100`,
      `${MR_PATH}/notes?per_page=100&page=2`,
    ]);
    expect(http.calls.filter((call) => call.method === "POST")).toHaveLength(0);
  });
});

describe("GitLab review delivery rendering", () => {
  it("keeps hostile finding text inert while retaining the finding", () => {
    const hostile = JSON.parse(
      readFileSync(
        new URL("./fixtures/review-delivery/gitlab/hostile-finding-content.json", import.meta.url),
        "utf8",
      ),
    ) as {
      evidence: string;
      detail: string;
      title: string;
      suggestion: string;
    };
    const body = renderGitLabReviewFinding({
      text: [hostile.title, hostile.detail, hostile.evidence, hostile.suggestion].join("\n"),
      severity: "warning",
      path: "docs/guide.md",
      inventoryId: "finding:0:hostile",
      marker: "nonce",
    });
    expect(body).toContain("attack");
    expect(body).not.toMatch(
      /\]\(https:\/\/evil|^\s*\/(?:approve|merge|close)|@[A-Za-z]|```suggestion/mu,
    );
  });

  it("renders only the summary action inventory and source-bound links", () => {
    const body = renderGitLabReviewSummary({
      findings: [
        { inventoryId: "finding:0:summary", severity: "warning", text: "summary text", path: null },
      ],
      inlineCount: 1,
      reviewedHeadSha: "a".repeat(40),
      mrUrl: "https://gitlab.example.test/team/docs/-/merge_requests/7",
      reportUrl: "https://reports.example.test/reports/run-7/",
      threadUrls: [],
      marker: "nonce",
    });
    expect(body).toBe(
      [
        "DocsFab review summary",
        "",
        `Reviewed head: ${"a".repeat(40)}`,
        "1 summary finding; 1 inline finding.",
        "",
        "Merge request: [open review](https://gitlab.example.test/team/docs/-/merge_requests/7)",
        "Report: [review report](https://reports.example.test/reports/run-7/)",
        "",
        "- warning: summary text",
        "",
        "Review effect: nonce",
      ].join("\n"),
    );
  });
});
