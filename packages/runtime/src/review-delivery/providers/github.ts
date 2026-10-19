// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Native, caller-authenticated github.com review effects. No credential source lives here. */
import { canonicalJson, sha256 } from "../../content-ir/canonical.js";
import type { ChangeSourceV1 } from "../../inputs/change-source.js";
import { GITHUB_API_VERSION } from "../../inputs/change-source/github-transport.js";
import type { ReviewTargetV2 } from "../../review/contracts.js";
import type { ReviewDiffFile } from "../anchors.js";
import type {
  ReviewDeliveryAction,
  ReviewDeliveryActionBinding,
  ReviewDeliveryPlan,
  ReviewDeliverySnapshot,
} from "../contracts.js";
import type {
  ReviewDeliveryEffectContextV1,
  ReviewDeliveryNativeEvidence,
  ReviewDeliveryPreparation,
  ReviewDeliveryPreparedEffect,
  ReviewDeliveryPublishOutcome,
  ReviewDeliveryRecoverableEffectPort,
  ReviewDeliveryRecoveryPort,
  ReviewDeliveryRemoteObservation,
} from "../execute.js";
import {
  reviewDeliveryBodySha256,
  reviewDeliveryEffectId,
  reviewDeliveryEffectNonce,
  reviewDeliveryGithubAnchorSha256,
  reviewDeliveryOutboundBytesSha256,
} from "../execute.js";
import { reviewDeliverySnapshotDigest } from "../plan.js";
import type { ReviewDeliveryCommittedEffectV1 } from "../receipt.js";
import {
  renderGithubInlineBody,
  renderGithubOverviewBody,
  renderGithubReviewBody,
} from "./github-render.js";

const ORIGIN = "https://api.github.com";
const OWNER_REPO = /^[A-Za-z0-9](?:-?[A-Za-z0-9])*\/[A-Za-z0-9._-]+$/u;

type GithubPlan = ReviewDeliveryPlan<ChangeSourceV1>;
type GithubTarget = Extract<ReviewTargetV2, { scmProvider: "github" }>;
type GithubSource = Extract<ChangeSourceV1["source"], { kind: "github-pull-request" }>;
type NativeComment = Extract<
  ReviewDeliveryNativeEvidence,
  { kind: "github-review" }
>["comments"][number];
type GithubAnchor = Pick<NativeComment, "path" | "line" | "side" | "startLine" | "startSide">;

export type GithubReviewFetchPort = (url: string, init: RequestInit) => Promise<Response>;

export interface GithubReviewAdapterInput {
  readonly plan: GithubPlan;
  readonly snapshot: ReviewDeliverySnapshot;
  readonly fetch: GithubReviewFetchPort;
  /** Caller-owned current user credential. Never persisted or read from environment. */
  readonly authorization: () => string | null;
  readonly cancelled?: () => boolean;
  /** Optional caller-owned local throttle; false means no HTTP mutation was handed off. */
  readonly mayPublish?: () => boolean;
}

interface GithubOverviewRemaining {
  readonly findingsTotal: number;
  readonly summarySelectedFindings: number;
  readonly nativeInlineFindings: number;
  readonly retainedUnpostedFindings: number;
  readonly unsupportedUnpostedFindings: number;
  readonly findingLimitations: number;
  readonly checks: number;
  readonly unansweredQuestions: number;
  readonly reviewScopePresent: 0 | 1;
  readonly anchorPaths: number;
  readonly deferredPaths: number;
  readonly continuationLocatorPresent: 0 | 1;
  readonly templateReportPresent: 0 | 1;
  readonly templatePages: number;
  readonly templateRules: number;
  readonly templateSuggestionIds: number;
  readonly affectedPaths: number;
  readonly skippedPaths: number;
  readonly planLimitations: number;
  readonly hostedReportCandidatePresent: 0 | 1;
}

interface GithubRetainedIdentity {
  readonly resultSha256: string;
  readonly sourceSha256: string;
  readonly snapshotSha256: string;
  readonly runIdSha256: string;
  readonly actionSetSha256: string;
}

type GithubCommittedPresentation =
  | {
      readonly kind: "presentation";
      readonly presentation: {
        readonly kind: "full" | "compact-partial" | "historical-legacy";
        readonly remaining: GithubOverviewRemaining;
        readonly retained: GithubRetainedIdentity;
      };
    }
  | { readonly kind: "not-applicable" }
  | { readonly kind: "unavailable" };

export interface GithubReviewAdapter
  extends ReviewDeliveryRecoverableEffectPort<ChangeSourceV1>,
    ReviewDeliveryRecoveryPort {
  /** Pure whole-descriptor classification for a sealed pending-create effect. */
  classifyCommittedOverviewPresentation(input: {
    readonly plan: GithubPlan;
    readonly context: ReviewDeliveryEffectContextV1;
  }): GithubCommittedPresentation;
}

class HttpFailure extends Error {
  constructor(
    readonly status: number,
    readonly headers: Headers,
    readonly invoked: boolean,
  ) {
    super("GitHub review HTTP request did not succeed.");
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function positive(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function nonnegative(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function nativeFileStatus(status: string): string | null {
  switch (status) {
    case "A":
      return "added";
    case "D":
      return "removed";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "T":
      return "changed";
    case "M":
      return "modified";
    default:
      return null;
  }
}

function numericActor(id: string): number | null {
  const match = /^(?:user:)?([1-9][0-9]*)$/u.exec(id);
  return match ? positive(Number(match[1])) : null;
}

function retryAfterAt(headers: Headers): string | null {
  const raw = headers.get("retry-after");
  if (raw !== null) {
    const seconds = Number(raw);
    if (Number.isSafeInteger(seconds) && seconds >= 0) {
      const at = Date.now() + seconds * 1000;
      if (Number.isFinite(at) && !Number.isNaN(new Date(at).valueOf()))
        return new Date(at).toISOString();
    }
    const date = Date.parse(raw);
    if (Number.isFinite(date) && date >= Date.now()) return new Date(date).toISOString();
  }
  if (headers.get("x-ratelimit-remaining") === "0") {
    const reset = Number(headers.get("x-ratelimit-reset"));
    if (Number.isSafeInteger(reset) && reset > 0) return new Date(reset * 1000).toISOString();
  }
  return null;
}

function rateLimited(failure: HttpFailure): boolean {
  return (
    failure.status === 429 ||
    (failure.status === 403 &&
      (failure.headers.has("retry-after") || failure.headers.get("x-ratelimit-remaining") === "0"))
  );
}

function blocked(
  actionId: string | null,
  code:
    | "position-unprovable"
    | "diff-unavailable"
    | "source-drift"
    | "rate-limited"
    | "cancelled"
    | "provider-failure",
  next: "retry" | "replan-required",
  retry: string | null = null,
): ReviewDeliveryPreparation {
  return { kind: "blocked", actionId, code, next, retryAfterAt: retry };
}

function pageNext(header: string | null, exactPath: string): string | null {
  if (header === null) return null;
  const links = header.split(",").filter((part) => /(?:^|;)\s*rel="?next"?\s*(?:;|$)/u.test(part));
  if (links.length !== 1) {
    if (links.length === 0) return null;
    throw new Error("GitHub pagination returned more than one next-page link for this review.");
  }
  const match = /^\s*<([^>]*)>/u.exec(links[0]!);
  if (!match)
    throw new Error("GitHub pagination returned a malformed next-page link for this review.");
  const url = new URL(match[1]!, ORIGIN);
  if (
    url.origin !== ORIGIN ||
    url.username ||
    url.password ||
    url.pathname !== exactPath ||
    url.hash
  )
    throw new Error("GitHub pagination would leave the selected review resource or API origin.");
  const keys = [...url.searchParams.keys()];
  if (
    keys.some((key) => key !== "page") ||
    new Set(keys).size !== keys.length ||
    !/^[1-9][0-9]*$/u.test(url.searchParams.get("page") ?? "")
  )
    throw new Error("GitHub pagination changed query filters beyond the selected page number.");
  return `${url.pathname}${url.search}`;
}

function validAnchor(
  action: Extract<ReviewDeliveryAction, { kind: "publish-inline" }>,
  files: readonly ReviewDiffFile[],
): GithubAnchor | null {
  const anchor = action.anchor;
  const candidates = files.filter(
    (file) =>
      file.state === "complete" &&
      file.oldPath === anchor.oldPath &&
      file.newPath === anchor.newPath &&
      (anchor.side === "after" ? file.afterSha256 : file.beforeSha256) === anchor.sourceSha256,
  );
  if (candidates.length !== 1 || anchor.startLine > anchor.endLine) return null;
  const file = candidates[0]!;
  const path = file.newPath ?? file.oldPath;
  if (path === null || !path || path.startsWith("/") || path.split("/").includes("..")) return null;
  const side = anchor.side === "after" ? "RIGHT" : "LEFT";
  const key = anchor.side === "after" ? "afterLine" : "beforeLine";
  const hunks = file.hunks.filter((hunk) =>
    hunk.lines.some((line) => line[key] === anchor.startLine),
  );
  if (hunks.length !== 1) return null;
  for (let lineNumber = anchor.startLine; lineNumber <= anchor.endLine; lineNumber++) {
    const matched = hunks[0]!.lines.filter((line) => line[key] === lineNumber);
    if (
      matched.length !== 1 ||
      (side === "RIGHT" && matched[0]!.kind === "removed") ||
      (side === "LEFT" && matched[0]!.kind === "added")
    )
      return null;
  }
  return {
    path,
    line: anchor.endLine,
    side,
    ...(anchor.startLine === anchor.endLine
      ? {}
      : { startLine: anchor.startLine, startSide: side }),
  };
}

function effectDescriptor(effect: ReviewDeliveryPreparedEffect): ReviewDeliveryCommittedEffectV1 {
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

function sameDescriptor(
  effect: ReviewDeliveryPreparedEffect,
  committed: ReviewDeliveryCommittedEffectV1,
): boolean {
  return canonicalJson(effectDescriptor(effect)) === canonicalJson(committed);
}

function overviewInventory(plan: GithubPlan): {
  remaining: GithubOverviewRemaining;
  retained: GithubRetainedIdentity;
} {
  const summaryIds = new Set(
    plan.actions.flatMap((action) => (action.kind === "publish-summary" ? action.findingIds : [])),
  );
  const inlineIds = new Set(
    plan.actions.flatMap((action) => (action.kind === "publish-inline" ? [action.findingId] : [])),
  );
  const unposted = plan.findings.filter(
    (finding) => !summaryIds.has(finding.inventoryId) && !inlineIds.has(finding.inventoryId),
  );
  const coverage = plan.reviewScope?.templateCoverage;
  return {
    remaining: {
      findingsTotal: plan.findings.length,
      summarySelectedFindings: summaryIds.size,
      nativeInlineFindings: inlineIds.size,
      retainedUnpostedFindings: unposted.length,
      unsupportedUnpostedFindings: unposted.filter(
        (finding) => finding.disposition.kind === "unsupported",
      ).length,
      findingLimitations: plan.findings.reduce(
        (count, finding) => count + finding.limitations.length,
        0,
      ),
      checks: plan.checks.length,
      unansweredQuestions: plan.unresolvedQuestions.length,
      reviewScopePresent: plan.reviewScope === undefined ? 0 : 1,
      anchorPaths: plan.reviewScope?.anchorPaths.length ?? 0,
      deferredPaths: plan.reviewScope?.deferredPaths.length ?? 0,
      continuationLocatorPresent: plan.reviewScope?.continuationLocator === undefined ? 0 : 1,
      templateReportPresent: coverage?.reportDigest == null ? 0 : 1,
      templatePages: coverage?.pages.length ?? 0,
      templateRules: coverage?.pages.reduce((count, page) => count + page.rules.length, 0) ?? 0,
      templateSuggestionIds:
        coverage?.pages.reduce((count, page) => count + page.suggestionIds.length, 0) ?? 0,
      affectedPaths: plan.affectedPaths.length,
      skippedPaths: plan.result.skippedPaths?.length ?? 0,
      planLimitations: plan.limitations.length,
      hostedReportCandidatePresent: plan.result.hostedReportUrl === undefined ? 0 : 1,
    },
    retained: {
      resultSha256: plan.result.originalResultSha256,
      sourceSha256: plan.target.changeSourceSha256,
      snapshotSha256: plan.snapshotSha256,
      runIdSha256: plan.result.runIdSha256,
      actionSetSha256: sha256(canonicalJson(plan.actions.map((action) => action.id).sort())),
    },
  };
}

export function createGithubReviewAdapter(input: GithubReviewAdapterInput): GithubReviewAdapter {
  const { plan, snapshot } = input;
  const target = plan.target;
  const source = plan.source.source;
  if (
    target.scmProvider !== "github" ||
    target.host !== "github.com" ||
    source.kind !== "github-pull-request" ||
    source.host !== target.host ||
    source.repositoryId !== target.repositoryId ||
    source.number !== target.pullRequestNumber ||
    source.headRepositoryId !== target.headRepositoryId ||
    !OWNER_REPO.test(source.fullName) ||
    snapshot.changeSourceSha256 !== plan.source.changeSourceSha256 ||
    reviewDeliverySnapshotDigest(snapshot, plan.source) !== plan.snapshotSha256
  )
    throw new Error("GitHub review adapter requires one authenticated, sealed PR snapshot.");
  const githubTarget: GithubTarget = target;
  const githubSource: GithubSource = source;
  const base = `/repos/${githubSource.fullName}/pulls/${githubTarget.pullRequestNumber}`;
  // One adapter execution authenticates reads and writes with the same credential.
  const suppliedAuthorization = input.authorization();
  if (suppliedAuthorization === null || !/^Bearer [^\r\n]+$/u.test(suppliedAuthorization))
    throw new Error(
      "The caller did not supply a supported GitHub user credential for this review.",
    );
  const authorization: string = suppliedAuthorization;
  const capturedPlanSha256 = sha256(canonicalJson(plan));

  async function request(
    method: "GET" | "POST",
    path: string,
    bodyBytes?: Uint8Array,
  ): Promise<{ body: unknown; headers: Headers }> {
    const unsafeSegment = path
      .split(/[/?]/u)
      .some((segment) => segment === "." || segment === "..");
    if (!path.startsWith("/") || path.startsWith("//") || unsafeSegment || path.includes("#"))
      throw new Error("The prepared GitHub API path is not safe for the selected origin.");
    const response = await input.fetch(`${ORIGIN}${path}`, {
      method,
      redirect: "manual",
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
        Authorization: authorization,
        ...(bodyBytes === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(bodyBytes === undefined ? {} : { body: Buffer.from(bodyBytes) }),
    });
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new HttpFailure(response.status, response.headers, true);
    }
    return { body: await response.json(), headers: response.headers };
  }

  async function list(path: string): Promise<{ rows: readonly unknown[]; digest: string }> {
    const all: unknown[] = [];
    const visited = new Set<string>();
    let next: string | null = path;
    while (next !== null) {
      if (visited.has(next))
        throw new Error("GitHub pagination repeated a page already read for this review.");
      visited.add(next);
      const page = await request("GET", next);
      if (!Array.isArray(page.body))
        throw new Error("GitHub returned a review listing without the required row array.");
      all.push(...page.body);
      next = pageNext(page.headers.get("link"), path);
    }
    return { rows: all, digest: sha256(canonicalJson({ path, rows: all })) };
  }

  async function observeCurrent(
    binding: ReviewDeliveryActionBinding,
  ): ReturnType<ReviewDeliveryRecoveryPort["observeCurrent"]> {
    if (
      binding.target.targetSha256 !== githubTarget.targetSha256 ||
      binding.sourceSha256 !== plan.source.changeSourceSha256 ||
      binding.snapshotSha256 !== plan.snapshotSha256 ||
      binding.actor.host !== "github.com" ||
      binding.actor.id !== plan.actor.id
    )
      return { kind: "drift", reason: "selected review binding changed" };
    try {
      const [userResponse, repoResponse, prResponse] = await Promise.all([
        request("GET", "/user"),
        request("GET", `/repos/${githubSource.fullName}`),
        request("GET", base),
      ]);
      const user = record(userResponse.body);
      const repo = record(repoResponse.body);
      const pr = record(prResponse.body);
      const head = record(pr?.head);
      const prBase = record(pr?.base);
      if (
        positive(user?.id) !== numericActor(binding.actor.id) ||
        positive(repo?.id) !== githubTarget.repositoryId ||
        repo?.full_name !== githubSource.fullName ||
        positive(pr?.number) !== githubTarget.pullRequestNumber ||
        pr?.state !== "open" ||
        nonnegative(pr?.changed_files) !== plan.source.files.length ||
        head?.sha !== binding.reviewedHeadSha ||
        prBase?.sha !== githubTarget.baseSha ||
        positive(record(prBase?.repo)?.id) !== githubTarget.repositoryId ||
        (githubTarget.headRepositoryId === null
          ? record(head?.repo) !== null
          : positive(record(head?.repo)?.id) !== githubTarget.headRepositoryId)
      )
        return { kind: "drift", reason: "GitHub actor, repository, PR, fork or revision changed" };
      return {
        kind: "current",
        target: binding.target,
        sourceSha256: plan.source.changeSourceSha256,
        snapshotSha256: plan.snapshotSha256,
        actor: binding.actor,
        headSha: binding.reviewedHeadSha,
        startSha: binding.startSha,
      };
    } catch (error) {
      if (error instanceof HttpFailure && error.status === 404)
        return { kind: "unavailable", reason: "github-private-or-not-found" };
      if (error instanceof HttpFailure && error.status === 403)
        return {
          kind: "unavailable",
          reason: rateLimited(error) ? "github-rate-limited" : "github-forbidden",
        };
      return { kind: "unavailable", reason: "github-current-unavailable" };
    }
  }

  /** Exact local candidates; caller decides whether network admission is needed. */
  function projectCreateCandidates(context: ReviewDeliveryEffectContextV1) {
    const actions = [...plan.actions].sort((a, b) => a.id.localeCompare(b.id));
    if (actions.length === 0) return null;
    const ids = actions.map((action) => action.id);
    const createId = reviewDeliveryEffectId(context, "github-pending-review-create", ids);
    const createMarker = reviewDeliveryEffectNonce(context, createId);
    const summary = actions.find((action) => action.kind === "publish-summary") as
      | Extract<ReviewDeliveryAction, { kind: "publish-summary" }>
      | undefined;
    const comments: {
      path: string;
      body: string;
      line: number;
      side: "LEFT" | "RIGHT";
      start_line?: number;
      start_side?: "LEFT" | "RIGHT";
    }[] = [];
    const inlinePayloads = new Map<
      string,
      ReviewDeliveryPreparedEffect["actionPayloads"][number]
    >();
    for (const action of actions) {
      if (action.kind === "publish-summary") continue;
      const anchor = validAnchor(action, snapshot.files);
      if (anchor === null) return null;
      const body = renderGithubInlineBody(plan, action, createMarker);
      comments.push({
        path: anchor.path,
        body,
        line: anchor.line,
        side: anchor.side,
        ...(anchor.startLine === undefined
          ? {}
          : { start_line: anchor.startLine, start_side: anchor.startSide }),
      });
      inlinePayloads.set(action.id, {
        actionId: action.id,
        bodySha256: reviewDeliveryBodySha256(body),
        anchorSha256: reviewDeliveryGithubAnchorSha256(anchor),
      });
    }
    const makeCandidate = (
      bodyText: string,
      selectedStage: "github-pending-review-create" | "github-comment-submit",
      reviewId?: number,
    ): ReviewDeliveryPreparedEffect => {
      const effectId = reviewDeliveryEffectId(context, selectedStage, ids);
      const requestValue = {
        method: "POST" as const,
        path:
          selectedStage === "github-pending-review-create"
            ? `${base}/reviews`
            : `${base}/reviews/${reviewId}/events`,
        bodyBytes: new TextEncoder().encode(
          JSON.stringify(
            selectedStage === "github-pending-review-create"
              ? { commit_id: plan.result.reviewedHeadSha, body: bodyText, comments }
              : { event: "COMMENT" },
          ),
        ),
      };
      return {
        kind: "effect",
        effectId,
        coveredActionIds: ids,
        actionPayloads: actions.map((action) =>
          action.kind === "publish-summary"
            ? {
                actionId: action.id,
                bodySha256: reviewDeliveryBodySha256(bodyText),
                anchorSha256: null,
              }
            : inlinePayloads.get(action.id)!,
        ),
        stage: selectedStage,
        request: requestValue,
        outboundBytesSha256: reviewDeliveryOutboundBytesSha256(requestValue),
        expectedBodySha256: reviewDeliveryBodySha256(bodyText),
        expectedGitLabPosition: null,
        marker: reviewDeliveryEffectNonce(context, effectId),
        revisionProvenance: {
          kind: "github-review-commit",
          commitId: plan.result.reviewedHeadSha,
        },
      };
    };
    const legacyBody = renderGithubReviewBody(plan, summary, createMarker);
    const legacyCreate = makeCandidate(legacyBody, "github-pending-review-create");
    let richBody: string | null = null;
    try {
      richBody = renderGithubOverviewBody(plan, summary, createMarker);
    } catch {
      // A historical default descriptor can remain recoverable without rich rendering.
    }
    const richCreate =
      richBody === null ? null : makeCandidate(richBody, "github-pending-review-create");
    return { actions, ids, legacyBody, legacyCreate, richBody, richCreate, makeCandidate };
  }

  async function makeEffect(
    context: ReviewDeliveryEffectContextV1,
    stage: "github-pending-review-create" | "github-comment-submit",
    reviewId?: number,
  ): Promise<ReviewDeliveryPreparedEffect | ReviewDeliveryPreparation> {
    const actions = [...plan.actions].sort((a, b) => a.id.localeCompare(b.id));
    if (actions.length === 0) return { kind: "complete" };
    const ids = actions.map((action) => action.id);
    let remoteFiles: readonly unknown[] = [];
    if (actions.some((action) => action.kind === "publish-inline")) {
      try {
        remoteFiles = (await list(`${base}/files`)).rows;
      } catch (error) {
        if (error instanceof HttpFailure && rateLimited(error))
          return blocked(null, "rate-limited", "retry", retryAfterAt(error.headers));
        return blocked(null, "diff-unavailable", "retry");
      }
      // GitHub's files API can stop at its documented result ceiling even when
      // pagination has no next link. Compare the entire inventory to the
      // authenticated PR count and sealed source before preparing any POST.
      if (remoteFiles.length !== plan.source.files.length)
        return blocked(null, "diff-unavailable", "retry");
      const matchedPaths = new Set<string>();
      for (const file of plan.source.files) {
        const filename = file.newPath ?? file.oldPath;
        const matches = remoteFiles.filter((row) => record(row)?.filename === filename);
        const remote = record(matches[0]);
        if (
          filename === null ||
          matches.length !== 1 ||
          matchedPaths.has(filename) ||
          remote?.status !== nativeFileStatus(file.status) ||
          (file.status === "R" || file.status === "C"
            ? remote.previous_filename !== file.oldPath
            : remote.previous_filename !== undefined)
        )
          return blocked(null, "source-drift", "replan-required");
        matchedPaths.add(filename);
      }
    }
    for (const action of actions) {
      if (action.kind === "publish-summary") continue;
      const anchor = validAnchor(action, snapshot.files);
      if (anchor === null) return blocked(action.id, "position-unprovable", "replan-required");
      const remotePath = action.anchor.newPath ?? action.anchor.oldPath;
      const remoteMatches = remoteFiles.filter((row) => record(row)?.filename === remotePath);
      const remote = record(remoteMatches[0]);
      const sourceMatches = plan.source.files.filter(
        (file) => file.oldPath === action.anchor.oldPath && file.newPath === action.anchor.newPath,
      );
      const sourceFile = sourceMatches[0];
      if (
        sourceMatches.length !== 1 ||
        remoteMatches.length !== 1 ||
        remote?.status !== nativeFileStatus(sourceFile?.status ?? "") ||
        (sourceFile?.status === "R" || sourceFile?.status === "C"
          ? remote.previous_filename !== action.anchor.oldPath
          : remote.previous_filename !== undefined)
      )
        return blocked(action.id, "source-drift", "replan-required");
    }
    const projected = projectCreateCandidates(context);
    if (projected === null) return blocked(ids[0]!, "provider-failure", "retry");
    const { legacyBody, legacyCreate, richBody, richCreate, makeCandidate } = projected;
    const committedCreate = context.committedEffects.filter(
      (item) => item.stage === "github-pending-review-create",
    );
    const committedSubmit = context.committedEffects.filter(
      (item) => item.stage === "github-comment-submit",
    );
    if (
      committedCreate.length > 1 ||
      committedSubmit.length > 1 ||
      (committedCreate.length === 0 && committedSubmit.length > 0)
    )
      return blocked(ids[0]!, "provider-failure", "retry");
    if (richBody === null && (committedCreate.length === 0 || plan.requestedActions !== undefined))
      return blocked(ids[0]!, "provider-failure", "retry");
    let selectedBody: string;
    if (committedCreate.length > 0) {
      const sealed = committedCreate[0]!;
      if (richCreate && sameDescriptor(richCreate, sealed)) selectedBody = richBody!;
      else if (plan.requestedActions === undefined && sameDescriptor(legacyCreate, sealed))
        selectedBody = legacyBody;
      else return blocked(ids[0]!, "provider-failure", "retry");
    } else {
      if (
        plan.requestedActions !== undefined ||
        actions.some((action) => action.kind === "publish-summary")
      ) {
        if (richBody === null) return blocked(ids[0]!, "provider-failure", "retry");
        selectedBody = richBody;
      } else selectedBody = legacyBody;
    }
    if (stage === "github-comment-submit" && reviewId === undefined)
      return blocked(ids[0]!, "provider-failure", "retry");
    const selected = makeCandidate(selectedBody, stage, reviewId);
    if (
      committedSubmit.length > 0 &&
      stage === "github-comment-submit" &&
      !sameDescriptor(selected, committedSubmit[0]!)
    )
      return blocked(ids[0]!, "provider-failure", "retry");
    return selected;
  }

  async function prepareNextEffect({
    context,
    priorObservations,
  }: Parameters<
    ReviewDeliveryRecoverableEffectPort<ChangeSourceV1>["prepareNextEffect"]
  >[0]): Promise<ReviewDeliveryPreparation> {
    if (input.cancelled?.()) return blocked(null, "cancelled", "retry");
    if (priorObservations.length === 0) return makeEffect(context, "github-pending-review-create");
    const first = priorObservations[0];
    if (
      first?.kind !== "matching" ||
      first.native.kind !== "github-review" ||
      first.native.reviewId !== positive(Number(first.providerReference))
    )
      return blocked(null, "provider-failure", "retry");
    if (priorObservations.length === 1) {
      if (
        first.native.state === "COMMENTED" &&
        !context.committedEffects.some((item) => item.stage === "github-comment-submit")
      )
        return blocked(null, "provider-failure", "retry");
      return makeEffect(context, "github-comment-submit", first.native.reviewId);
    }
    const second = priorObservations[1];
    return second?.kind === "matching" &&
      second.native.kind === "github-review" &&
      second.native.reviewId === first.native.reviewId &&
      second.native.state === "COMMENTED"
      ? { kind: "complete" }
      : blocked(null, "provider-failure", "retry");
  }

  async function publishEffect({
    effect,
  }: Parameters<
    ReviewDeliveryRecoverableEffectPort<ChangeSourceV1>["publishEffect"]
  >[0]): Promise<ReviewDeliveryPublishOutcome> {
    if (input.cancelled?.())
      return {
        kind: "not-dispatched",
        providerReference: null,
        stop: { code: "cancelled", retryAfterAt: null },
      };
    if (input.mayPublish?.() === false)
      return {
        kind: "not-dispatched",
        providerReference: null,
        stop: { code: "rate-limited", retryAfterAt: null },
      };
    if (
      effect.outboundBytesSha256 !== reviewDeliveryOutboundBytesSha256(effect.request) ||
      (effect.stage !== "github-pending-review-create" &&
        effect.stage !== "github-comment-submit") ||
      (effect.stage === "github-pending-review-create"
        ? effect.request.path !== `${base}/reviews`
        : !new RegExp(
            `^${base.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}/reviews/[1-9][0-9]*/events$`,
            "u",
          ).test(effect.request.path))
    )
      return {
        kind: "not-dispatched",
        providerReference: null,
        stop: { code: "provider-unavailable", retryAfterAt: null },
      };
    try {
      const reply = await request("POST", effect.request.path, effect.request.bodyBytes);
      const reviewId = positive(record(reply.body)?.id);
      return { kind: "confirmed", providerReference: reviewId === null ? null : String(reviewId) };
    } catch (error) {
      return {
        kind: "uncertain",
        providerReference: null,
        stop:
          error instanceof HttpFailure
            ? {
                code: rateLimited(error) ? "rate-limited" : "provider-failure",
                retryAfterAt: retryAfterAt(error.headers),
              }
            : { code: "transport-failure", retryAfterAt: null },
      };
    }
  }

  async function readReview(reviewId: number): Promise<{
    native: Extract<ReviewDeliveryNativeEvidence, { kind: "github-review" }>;
    digest: string;
  } | null> {
    const reply = record((await request("GET", `${base}/reviews/${reviewId}`)).body);
    if (
      !reply ||
      positive(reply.id) !== reviewId ||
      reply.pull_request_url !== `${ORIGIN}${base}` ||
      typeof reply.body !== "string" ||
      typeof reply.commit_id !== "string" ||
      (reply.state !== "PENDING" && reply.state !== "COMMENTED")
    )
      return null;
    const author = record(reply.user);
    if (positive(author?.id) !== numericActor(plan.actor.id)) return null;
    const commentList = await list(`${base}/reviews/${reviewId}/comments`);
    const comments: NativeComment[] = [];
    for (const row of commentList.rows) {
      const comment = record(row);
      const user = record(comment?.user);
      if (
        !comment ||
        positive(comment.id) === null ||
        positive(comment.pull_request_review_id) !== reviewId ||
        positive(user?.id) !== numericActor(plan.actor.id) ||
        typeof comment.commit_id !== "string" ||
        typeof comment.body !== "string" ||
        typeof comment.path !== "string" ||
        positive(comment.line) === null ||
        (comment.side !== "LEFT" && comment.side !== "RIGHT")
      )
        return null;
      const startLine = comment.start_line;
      const startSide = comment.start_side;
      if (
        (startLine === null || startLine === undefined) !==
          (startSide === null || startSide === undefined) ||
        (startLine !== null &&
          startLine !== undefined &&
          (positive(startLine) === null || (startSide !== "LEFT" && startSide !== "RIGHT")))
      )
        return null;
      comments.push({
        commentId: positive(comment.id)!,
        commitId: comment.commit_id,
        reviewId,
        author: { host: "github.com", id: plan.actor.id },
        body: comment.body,
        path: comment.path,
        line: positive(comment.line)!,
        side: comment.side,
        ...(startLine === null || startLine === undefined
          ? {}
          : { startLine: positive(startLine)!, startSide: startSide as "LEFT" | "RIGHT" }),
      });
    }
    return {
      native: {
        kind: "github-review",
        repositoryId: githubTarget.repositoryId,
        pullRequestNumber: githubTarget.pullRequestNumber,
        reviewId,
        author: { host: "github.com", id: plan.actor.id },
        body: reply.body,
        commitId: reply.commit_id,
        state: reply.state,
        comments,
      },
      digest: commentList.digest,
    };
  }

  async function observeEffect({
    effect,
    phase,
    providerReference,
  }: Parameters<
    ReviewDeliveryRecoveryPort["observeEffect"]
  >[0]): Promise<ReviewDeliveryRemoteObservation> {
    if (effect.stage !== "github-pending-review-create" && effect.stage !== "github-comment-submit")
      return { kind: "conflict", effectId: effect.effectId, reason: "wrong provider stage" };
    try {
      let reviewId = positive(Number(providerReference));
      let enumerationSha256: string | null = null;
      if (providerReference === null && effect.stage === "github-comment-submit") {
        const match = new RegExp(
          `^${base.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}/reviews/([1-9][0-9]*)/events$`,
          "u",
        ).exec(effect.request.path);
        reviewId = match ? positive(Number(match[1])) : null;
      }
      if (providerReference === null && effect.stage === "github-pending-review-create") {
        const listed = await list(`${base}/reviews`);
        enumerationSha256 = listed.digest;
        const candidates = listed.rows.filter((row) => {
          const item = record(row);
          return (
            typeof item?.body === "string" &&
            item.body.includes(`<!-- docsfab-review:${effect.marker} -->`) &&
            positive(record(item.user)?.id) === numericActor(plan.actor.id) &&
            item.commit_id === plan.result.reviewedHeadSha
          );
        });
        if (candidates.length !== 1) {
          return {
            kind: candidates.length === 0 ? "unavailable" : "ambiguous",
            effectId: effect.effectId,
            reason: "GitHub review correlation is not unique and complete",
          };
        }
        reviewId = positive(record(candidates[0])?.id);
      }
      if (reviewId === null)
        return { kind: "unavailable", effectId: effect.effectId, reason: "No native review ID" };
      const found = await readReview(reviewId);
      if (!found)
        return {
          kind: "conflict",
          effectId: effect.effectId,
          reason: "Native review or comment shape/identity differs",
        };
      const { native } = found;
      if (
        reviewDeliveryBodySha256(native.body) !== effect.expectedBodySha256 ||
        native.commitId !== plan.result.reviewedHeadSha ||
        (effect.stage === "github-comment-submit" && native.state !== "COMMENTED")
      )
        return {
          kind: "conflict",
          effectId: effect.effectId,
          reason: "Native review body, commit or lifecycle differs",
        };
      const references: { actionId: string; nativeReference: string }[] = [];
      const used = new Set<number>();
      for (const payload of effect.actionPayloads) {
        if (payload.anchorSha256 === null) {
          if (reviewDeliveryBodySha256(native.body) !== payload.bodySha256)
            return { kind: "conflict", effectId: effect.effectId, reason: "Summary body differs" };
          references.push({ actionId: payload.actionId, nativeReference: String(reviewId) });
          continue;
        }
        const matches = native.comments.filter(
          (comment) =>
            reviewDeliveryBodySha256(comment.body) === payload.bodySha256 &&
            reviewDeliveryGithubAnchorSha256(comment) === payload.anchorSha256 &&
            comment.commitId === plan.result.reviewedHeadSha &&
            comment.reviewId === reviewId &&
            comment.author.id === plan.actor.id,
        );
        if (matches.length !== 1 || used.has(matches[0]!.commentId))
          return {
            kind: "ambiguous",
            effectId: effect.effectId,
            reason: "Native inline action mapping is missing or duplicated",
          };
        used.add(matches[0]!.commentId);
        references.push({
          actionId: payload.actionId,
          nativeReference: String(matches[0]!.commentId),
        });
      }
      if (used.size !== native.comments.length)
        return {
          kind: "conflict",
          effectId: effect.effectId,
          reason: "Native review contains unplanned comments",
        };
      return {
        kind: "matching",
        effectId: effect.effectId,
        providerReference: String(reviewId),
        native,
        actionReferences: references,
        discovery:
          enumerationSha256 === null
            ? { kind: "direct-reference" }
            : {
                kind: "complete-enumeration",
                enumerationSha256,
                matchingCandidateCount: 1,
                directGetVerified: true,
              },
        lifecycle: native.state === "PENDING" ? "accepted-pending" : "final-published",
      };
    } catch (error) {
      return {
        kind: "unavailable",
        effectId: effect.effectId,
        reason:
          error instanceof HttpFailure && rateLimited(error)
            ? "github-rate-limited"
            : phase === "recovery"
              ? "github-recovery-unavailable"
              : "github-baseline-unavailable",
      };
    }
  }

  function classifyCommittedOverviewPresentation({
    plan: presentedPlan,
    context,
  }: {
    readonly plan: GithubPlan;
    readonly context: ReviewDeliveryEffectContextV1;
  }): GithubCommittedPresentation {
    try {
      if (sha256(canonicalJson(presentedPlan)) !== capturedPlanSha256)
        return { kind: "unavailable" };
      const create = context.committedEffects.filter(
        (item) => item.stage === "github-pending-review-create",
      );
      if (plan.actions.length === 0 && context.committedEffects.length === 0)
        return { kind: "not-applicable" };
      if (
        create.length !== 1 ||
        context.committedEffects.filter((item) => item.stage === "github-comment-submit").length >
          1 ||
        context.committedEffects.some(
          (item) =>
            item.stage !== "github-pending-review-create" && item.stage !== "github-comment-submit",
        )
      )
        return { kind: "unavailable" };
      const candidates = projectCreateCandidates(context);
      if (candidates === null) return { kind: "unavailable" };
      const kind =
        candidates.richCreate && sameDescriptor(candidates.richCreate, create[0]!)
          ? "full"
          : plan.requestedActions === undefined &&
              sameDescriptor(candidates.legacyCreate, create[0]!)
            ? "historical-legacy"
            : null;
      return kind === null
        ? { kind: "unavailable" }
        : { kind: "presentation", presentation: { kind, ...overviewInventory(plan) } };
    } catch {
      return { kind: "unavailable" };
    }
  }

  return {
    classifyCommittedOverviewPresentation,
    prepareNextEffect,
    publishEffect,
    observeCurrent,
    observeEffect,
  };
}
