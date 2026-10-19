// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { limit, refuseLimit } from "../../config/limits.js";
import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../../json-evidence.js";
import type { ReviewTargetV2 } from "../../review/contracts.js";
import type {
  ReviewDeliveryAction,
  ReviewDeliveryActionBinding,
  ReviewDeliveryPlan,
} from "../contracts.js";
import { admitReviewDeliveryAction } from "../plan.js";
import {
  reviewDeliveryBodySha256,
  reviewDeliveryCurrentObservationSha256,
  reviewDeliveryEffectId,
  reviewDeliveryEffectNonce,
  reviewDeliveryGitLabPositionSha256,
  reviewDeliveryOutboundBytesSha256,
  type ReviewDeliveryEffectContextV1,
  type ReviewDeliveryGitLabTextPosition,
  type ReviewDeliveryNativeEvidence,
  type ReviewDeliveryPreparation,
  type ReviewDeliveryPreparedEffect,
  type ReviewDeliveryPublishOutcome,
  type ReviewDeliveryRecoverableEffectPort,
  type ReviewDeliveryRecoveryPort,
  type ReviewDeliveryRemoteObservation,
} from "../execute.js";
import {
  renderGitLabReviewFinding,
  renderGitLabReviewOverview,
  renderGitLabReviewSummary,
} from "./gitlab-render.js";

const PAGE_SIZE = 100; // GitLab REST protocol maximum, not a total-page ceiling.
const encoder = new TextEncoder();

export interface GitLabReviewHttpRequest {
  readonly method: "GET" | "POST";
  /** Canonical path on the configured authenticated HTTPS origin. */
  readonly path: string;
  readonly bodyBytes?: Uint8Array;
}

export interface GitLabReviewHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: unknown;
  /** Authenticated transports must disable redirect following and report attempts. */
  readonly redirected?: boolean;
}

export interface GitLabReviewHttpTransport {
  request(request: GitLabReviewHttpRequest): Promise<GitLabReviewHttpResponse>;
}

type GitLabTarget = Extract<ReviewTargetV2, { scmProvider: "gitlab" }>;
type JsonObject = Record<string, unknown>;

class ProviderFault extends Error {
  constructor(
    readonly kind:
      | "unavailable"
      | "conflict"
      | "rate-limited"
      | "diff-unavailable"
      | "position-unprovable",
    readonly retryAfterAt: string | null = null,
  ) {
    super(`GitLab review provider ${kind}.`);
  }
}

/** Keep the machine-readable refusal kind separate from the public error message. */
function providerFault(
  kind: ProviderFault["kind"],
  retryAfterAt: string | null = null,
): ProviderFault {
  return new ProviderFault(kind, retryAfterAt);
}

function object(value: unknown): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw providerFault("conflict");
  return value as JsonObject;
}

function positiveInt(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw providerFault("conflict");
  return value as number;
}

function string(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw providerFault("conflict");
  return value;
}

/** Reconstruct source-bound discussion links already sealed into the retained request. */
function retainedThreadUrls(effect: ReviewDeliveryPreparedEffect, mrUrl: string): string[] {
  let body: string;
  try {
    body = string(object(JSON.parse(new TextDecoder().decode(effect.request.bodyBytes))).body);
  } catch {
    throw providerFault("conflict");
  }
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const match of body.matchAll(/^Discussion ([1-9]\d*): \[open thread\]\(([^)\r\n]+)\)$/gmu)) {
    const expectedIndex = String(urls.length + 1);
    const noteId = match[2]!.slice(`${mrUrl}#note_`.length);
    if (
      match[1] !== expectedIndex ||
      !match[2]!.startsWith(`${mrUrl}#note_`) ||
      !/^[1-9]\d*$/u.test(noteId) ||
      seen.has(noteId)
    )
      throw providerFault("conflict");
    seen.add(noteId);
    urls.push(match[2]!);
  }
  return urls;
}

function summaryBodies(
  plan: ReviewDeliveryPlan,
  action: Extract<ReviewDeliveryAction, { kind: "publish-summary" }>,
  mrUrl: string,
  threadUrls: readonly string[],
  marker: string,
  allowLegacy: boolean,
): readonly string[] {
  const findings = action.findingIds.map((id) => {
    const finding = plan.findings.find((item) => item.inventoryId === id);
    if (!finding) throw providerFault("conflict");
    return finding;
  });
  const common = {
    inlineCount: plan.actions.filter((item) => item.kind === "publish-inline").length,
    reviewedHeadSha: action.binding.reviewedHeadSha,
    mrUrl,
    reportUrl: plan.result.hostedReportUrl ?? null,
    threadUrls,
    marker,
  };
  // A bad rich-only value must not veto a valid, already committed default-mode legacy effect.
  const bodies: string[] = [];
  try {
    bodies.push(
      renderGitLabReviewOverview({ ...common, plan, selectedFindingIds: action.findingIds }),
    );
  } catch (error) {
    if (!allowLegacy) throw error;
    // The caller tests each independently and refuses when none matches.
  }
  if (allowLegacy && plan.requestedActions === undefined) {
    try {
      bodies.push(renderGitLabReviewSummary({ ...common, findings }));
    } catch {
      // The caller tests each independently and refuses when none matches.
    }
  }
  return bodies;
}

function committedDescriptorMatches(
  effect: ReviewDeliveryPreparedEffect,
  committed: ReviewDeliveryEffectContextV1["committedEffects"][number],
): boolean {
  return (
    digest({
      effectId: effect.effectId,
      stage: effect.stage,
      coveredActionIds: [...effect.coveredActionIds],
      actionPayloads: [...effect.actionPayloads],
      outboundBytesSha256: effect.outboundBytesSha256,
      expectedBodySha256: effect.expectedBodySha256,
      expectedGitLabPositionSha256:
        effect.expectedGitLabPosition === null
          ? null
          : reviewDeliveryGitLabPositionSha256(effect.expectedGitLabPosition),
      marker: effect.marker,
    }) === digest(committed)
  );
}

function digest(value: unknown): string {
  return createHash("sha256")
    .update(canonicalizeJsonEvidence(value as JsonEvidenceValue))
    .digest("hex");
}

function header(headers: GitLabReviewHttpResponse["headers"], name: string): string | undefined {
  return Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
}

function retryAfter(response: GitLabReviewHttpResponse): string | null {
  const value = header(response.headers, "retry-after");
  if (value === undefined) return null;
  const seconds = Number(value);
  if (Number.isSafeInteger(seconds) && seconds >= 0) {
    try {
      return new Date(Date.now() + seconds * 1000).toISOString();
    } catch {
      return null;
    }
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed >= Date.now() ? new Date(parsed).toISOString() : null;
}

function targetOf(binding: ReviewDeliveryActionBinding): GitLabTarget {
  if (
    binding.target.scmProvider !== "gitlab" ||
    binding.actor.host !== binding.target.host ||
    !/^\d+$/u.test(binding.actor.id)
  )
    throw providerFault("conflict");
  positiveInt(binding.target.projectId);
  positiveInt(binding.target.mergeRequestIid);
  return binding.target;
}

function mrPath(target: GitLabTarget): string {
  return `/api/v4/projects/${target.projectId}/merge_requests/${target.mergeRequestIid}`;
}

function canonicalWebUrl(raw: unknown, target: GitLabTarget): string {
  const value = string(raw);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw providerFault("conflict");
  }
  if (
    url.protocol !== "https:" ||
    url.origin !== `https://${target.host}` ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.pathname.endsWith(`/-/merge_requests/${target.mergeRequestIid}`) ||
    /[\\()]/u.test(value)
  )
    throw providerFault("conflict");
  return value;
}

function nativeActor(value: unknown, target: GitLabTarget): { host: string; id: string } {
  const actor = object(value);
  return { host: target.host, id: String(positiveInt(actor.id)) };
}

function positionJson(position: ReviewDeliveryGitLabTextPosition): JsonObject {
  const endpoint = (
    point: NonNullable<ReviewDeliveryGitLabTextPosition["lineRange"]>["start"],
  ) => ({
    line_code: point.lineCode,
    type: point.type,
    ...(point.oldLine === null ? {} : { old_line: point.oldLine }),
    ...(point.newLine === null ? {} : { new_line: point.newLine }),
  });
  return {
    position_type: "text",
    base_sha: position.baseSha,
    start_sha: position.startSha,
    head_sha: position.headSha,
    old_path: position.oldPath,
    new_path: position.newPath,
    ...(position.oldLine === null ? {} : { old_line: position.oldLine }),
    ...(position.newLine === null ? {} : { new_line: position.newLine }),
    ...(position.lineRange === null
      ? {}
      : {
          line_range: {
            start: endpoint(position.lineRange.start),
            end: endpoint(position.lineRange.end),
          },
        }),
  };
}

function parsePosition(value: unknown): ReviewDeliveryGitLabTextPosition {
  const root = object(value);
  if (root.position_type !== "text") throw providerFault("conflict");
  const endpoint = (value: unknown) => {
    const point = object(value);
    if (point.type !== "old" && point.type !== "new") throw providerFault("conflict");
    return {
      type: point.type as "old" | "new",
      lineCode: string(point.line_code),
      oldLine:
        point.old_line === null || point.old_line === undefined
          ? null
          : positiveInt(point.old_line),
      newLine:
        point.new_line === null || point.new_line === undefined
          ? null
          : positiveInt(point.new_line),
    };
  };
  const range =
    root.line_range === null || root.line_range === undefined ? null : object(root.line_range);
  return {
    positionType: "text",
    baseSha: string(root.base_sha),
    startSha: string(root.start_sha),
    headSha: string(root.head_sha),
    oldPath: string(root.old_path),
    newPath: string(root.new_path),
    oldLine:
      root.old_line === null || root.old_line === undefined ? null : positiveInt(root.old_line),
    newLine:
      root.new_line === null || root.new_line === undefined ? null : positiveInt(root.new_line),
    lineRange: range === null ? null : { start: endpoint(range.start), end: endpoint(range.end) },
  };
}

interface VerifiedMr {
  readonly id: number;
  readonly webUrl: string;
  readonly sourceProjectId: number;
}
interface DiffRow {
  readonly kind: "context" | "added" | "removed";
  readonly oldLine: number | null;
  readonly newLine: number | null;
  readonly codeOld: number;
  readonly codeNew: number;
}
interface VersionDiff {
  readonly oldPath: string;
  readonly newPath: string;
  readonly hunks: readonly (readonly DiffRow[])[];
}
interface VerifiedVersion {
  readonly baseSha: string;
  readonly startSha: string;
  readonly headSha: string;
  readonly diffs: readonly VersionDiff[];
}

function parseDiff(diff: string): readonly (readonly DiffRow[])[] {
  const hunks: DiffRow[][] = [];
  const expected: { old: number; next: number }[] = [];
  let oldLine = 0;
  let newLine = 0;
  for (const line of diff.split("\n")) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(line);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[3]);
      if (!Number.isSafeInteger(oldLine) || !Number.isSafeInteger(newLine))
        throw providerFault("diff-unavailable");
      hunks.push([]);
      expected.push({ old: Number(header[2] ?? 1), next: Number(header[4] ?? 1) });
      continue;
    }
    const rows = hunks.at(-1);
    if (!rows || line === "" || line.startsWith("\\ No newline")) continue;
    if (line.startsWith("+"))
      rows.push({
        kind: "added",
        oldLine: null,
        newLine: newLine++,
        codeOld: Math.max(0, oldLine - 1),
        codeNew: Math.max(0, newLine - 1),
      });
    else if (line.startsWith("-"))
      rows.push({
        kind: "removed",
        oldLine: oldLine++,
        newLine: null,
        codeOld: oldLine - 1,
        codeNew: newLine - 1,
      });
    else if (line.startsWith(" "))
      rows.push({
        kind: "context",
        oldLine: oldLine++,
        newLine: newLine++,
        codeOld: oldLine - 1,
        codeNew: newLine - 1,
      });
    else throw providerFault("diff-unavailable");
  }
  if (hunks.length === 0 || hunks.some((hunk) => hunk.length === 0))
    throw providerFault("diff-unavailable");
  if (
    hunks.some(
      (hunk, index) =>
        hunk.filter((row) => row.oldLine !== null).length !== expected[index]!.old ||
        hunk.filter((row) => row.newLine !== null).length !== expected[index]!.next,
    )
  )
    throw providerFault("diff-unavailable");
  return hunks;
}

function positionFor(
  action: Extract<ReviewDeliveryAction, { kind: "publish-inline" }>,
  version: VerifiedVersion,
): ReviewDeliveryGitLabTextPosition {
  const anchor = action.anchor;
  if (anchor.side !== "before" && anchor.side !== "after")
    throw providerFault("position-unprovable");
  if (anchor.path !== (anchor.side === "before" ? anchor.oldPath : anchor.newPath))
    throw providerFault("position-unprovable");
  const file = version.diffs.find(
    (item) =>
      item.oldPath === (anchor.oldPath ?? anchor.newPath) &&
      item.newPath === (anchor.newPath ?? anchor.oldPath),
  );
  if (!file || anchor.status !== "anchored" || anchor.endLine < anchor.startLine)
    throw providerFault("position-unprovable");
  const matches = file.hunks
    .flatMap((rows) => rows.map((row, index) => ({ rows, row, index })))
    .filter(
      ({ row }) => (anchor.side === "before" ? row.oldLine : row.newLine) === anchor.startLine,
    );
  if (matches.length !== 1) throw providerFault("position-unprovable");
  const start = matches[0]!;
  const count = anchor.endLine - anchor.startLine + 1;
  const selected = start.rows.slice(start.index, start.index + count);
  if (
    selected.length !== count ||
    selected.some(
      (row, index) =>
        (anchor.side === "before" ? row.oldLine : row.newLine) !== anchor.startLine + index,
    )
  )
    throw providerFault("position-unprovable");
  const lineCode = (row: DiffRow) => {
    const sha = createHash("sha1").update(file.newPath).digest("hex");
    return `${sha}_${row.codeOld}_${row.codeNew}`;
  };
  const endpoint = (row: DiffRow) => ({
    type: row.kind === "added" ? ("new" as const) : ("old" as const),
    lineCode: lineCode(row),
    oldLine: row.oldLine,
    newLine: row.newLine,
  });
  const last = selected.at(-1)!;
  return {
    positionType: "text",
    baseSha: version.baseSha,
    startSha: version.startSha,
    headSha: version.headSha,
    oldPath: file.oldPath,
    newPath: file.newPath,
    oldLine: last.oldLine,
    newLine: last.newLine,
    lineRange: count === 1 ? null : { start: endpoint(selected[0]!), end: endpoint(last) },
  };
}

export class GitLabReviewDeliveryProvider
  implements ReviewDeliveryRecoverableEffectPort, ReviewDeliveryRecoveryPort
{
  /** The executor publishes the exact effect returned by preparation, including after recovery. */
  private readonly selectedSummaryBodies = new WeakMap<ReviewDeliveryPreparedEffect, string>();

  constructor(
    private readonly host: string,
    private readonly transport: GitLabReviewHttpTransport,
  ) {
    if (!/^[A-Za-z0-9.-]+$/u.test(host)) throw providerFault("conflict");
  }

  private async request(request: GitLabReviewHttpRequest): Promise<GitLabReviewHttpResponse> {
    const response = await this.transport.request(request);
    if (response.redirected === true) throw providerFault("unavailable");
    if (response.status >= 300 && response.status < 400) throw providerFault("unavailable");
    if (response.status === 429) throw providerFault("rate-limited", retryAfter(response));
    if (response.status < 200 || response.status >= 300) throw providerFault("unavailable");
    return response;
  }

  private async identity(
    binding: ReviewDeliveryActionBinding,
  ): Promise<{ target: GitLabTarget; mr: VerifiedMr }> {
    const target = targetOf(binding);
    if (target.host !== this.host) throw providerFault("conflict");
    const user = object((await this.request({ method: "GET", path: "/api/v4/user" })).body);
    if (String(positiveInt(user.id)) !== binding.actor.id) throw providerFault("conflict");
    const mr = object((await this.request({ method: "GET", path: mrPath(target) })).body);
    const sourceProjectId = positiveInt(mr.source_project_id);
    if (
      positiveInt(mr.project_id) !== target.projectId ||
      positiveInt(mr.target_project_id) !== target.projectId ||
      positiveInt(mr.iid) !== target.mergeRequestIid ||
      (sourceProjectId !== target.projectId) !== target.sourceFork ||
      mr.source_branch !== target.sourceBranch ||
      mr.target_branch !== target.targetBranch ||
      object(mr.diff_refs).head_sha !== target.headSha ||
      object(mr.diff_refs).base_sha !== target.baseSha ||
      object(mr.diff_refs).start_sha !== binding.startSha ||
      mr.state !== "opened"
    )
      throw providerFault("conflict");
    return {
      target,
      mr: { id: positiveInt(mr.id), sourceProjectId, webUrl: canonicalWebUrl(mr.web_url, target) },
    };
  }

  private async version(
    target: GitLabTarget,
    mr: VerifiedMr,
    binding: ReviewDeliveryActionBinding,
  ): Promise<VerifiedVersion> {
    const list = (await this.request({ method: "GET", path: `${mrPath(target)}/versions` })).body;
    if (!Array.isArray(list) || list.length === 0) throw providerFault("diff-unavailable");
    const latest = object(list[0]);
    if (positiveInt(latest.merge_request_id) !== mr.id || latest.state !== "collected")
      throw providerFault("diff-unavailable");
    const id = positiveInt(latest.id);
    const value = object(
      (await this.request({ method: "GET", path: `${mrPath(target)}/versions/${id}` })).body,
    );
    if (
      positiveInt(value.id) !== id ||
      positiveInt(value.merge_request_id) !== mr.id ||
      value.state !== "collected" ||
      value.base_commit_sha !== binding.target.baseSha ||
      value.start_commit_sha !== binding.startSha ||
      value.head_commit_sha !== binding.reviewedHeadSha ||
      latest.base_commit_sha !== value.base_commit_sha ||
      latest.start_commit_sha !== value.start_commit_sha ||
      latest.head_commit_sha !== value.head_commit_sha ||
      !Array.isArray(value.diffs)
    )
      throw providerFault("diff-unavailable");
    if (value.real_size !== undefined && Number(value.real_size) !== value.diffs.length)
      throw providerFault("diff-unavailable");
    const diffs = value.diffs.map((raw: unknown) => {
      const file = object(raw);
      if (
        file.too_large === true ||
        file.collapsed === true ||
        typeof file.diff !== "string" ||
        file.diff === ""
      )
        throw providerFault("diff-unavailable");
      return {
        oldPath: string(file.old_path),
        newPath: string(file.new_path),
        hunks: parseDiff(file.diff),
      };
    });
    return {
      baseSha: string(value.base_commit_sha),
      startSha: string(value.start_commit_sha),
      headSha: string(value.head_commit_sha),
      diffs,
    };
  }

  async observeCurrent(
    binding: ReviewDeliveryActionBinding,
  ): ReturnType<ReviewDeliveryRecoveryPort["observeCurrent"]> {
    try {
      await this.identity(binding);
      const current = {
        kind: "current" as const,
        target: binding.target,
        sourceSha256: binding.sourceSha256,
        snapshotSha256: binding.snapshotSha256,
        actor: binding.actor,
        headSha: binding.reviewedHeadSha,
        startSha: binding.startSha,
      };
      return current;
    } catch (error) {
      return {
        kind: error instanceof ProviderFault && error.kind === "conflict" ? "drift" : "unavailable",
        reason: error instanceof ProviderFault ? error.kind : "transport-failure",
      };
    }
  }

  async prepareNextEffect(input: {
    readonly plan: ReviewDeliveryPlan;
    readonly priorObservations: readonly ReviewDeliveryRemoteObservation[];
    readonly context: ReviewDeliveryEffectContextV1;
  }): Promise<ReviewDeliveryPreparation> {
    const { plan, priorObservations, context } = input;
    const completed = new Set(
      priorObservations.flatMap((item) =>
        item.kind === "matching"
          ? item.actionReferences.map((reference) => reference.actionId)
          : [],
      ),
    );
    // The overview can link to authenticated inline readbacks only after they settle.
    const action =
      plan.actions.find((item) => item.kind === "publish-inline" && !completed.has(item.id)) ??
      plan.actions.find((item) => !completed.has(item.id));
    if (!action) return { kind: "complete" };
    try {
      const { target, mr } = await this.identity(action.binding);
      const stage = action.kind === "publish-summary" ? "gitlab-note" : "gitlab-discussion";
      const effectId = reviewDeliveryEffectId(context, stage, [action.id]);
      const marker = reviewDeliveryEffectNonce(context, effectId);
      const position =
        action.kind === "publish-inline"
          ? positionFor(action, await this.version(target, mr, action.binding))
          : null;
      const committed = context.committedEffects.find((item) => item.effectId === effectId);
      const bodies =
        action.kind === "publish-inline"
          ? (() => {
              const finding = plan.findings.find((item) => item.inventoryId === action.findingId);
              if (!finding) throw providerFault("conflict");
              return [renderGitLabReviewFinding({ ...finding, marker })];
            })()
          : summaryBodies(
              plan,
              action,
              mr.webUrl,
              priorObservations.flatMap((item) =>
                item.kind === "matching" && item.native.kind === "gitlab-discussion"
                  ? [`${mr.webUrl}#note_${item.native.noteId}`]
                  : [],
              ),
              marker,
              committed !== undefined,
            );
      const bound = limit("host.gitlab.noteBodyMaxChars");
      const path = `${mrPath(target)}/${position === null ? "notes" : "discussions"}`;
      for (const body of bodies) {
        if (body.length > bound.value) {
          if (committed === undefined) refuseLimit(bound, body.length);
          continue;
        }
        const request = {
          method: "POST" as const,
          path,
          bodyBytes: encoder.encode(
            JSON.stringify(
              position === null ? { body } : { body, position: positionJson(position) },
            ),
          ),
        };
        const effect: ReviewDeliveryPreparedEffect = {
          kind: "effect",
          effectId,
          coveredActionIds: [action.id],
          actionPayloads: [
            {
              actionId: action.id,
              bodySha256: reviewDeliveryBodySha256(body),
              anchorSha256: position === null ? null : reviewDeliveryGitLabPositionSha256(position),
            },
          ],
          stage,
          request,
          outboundBytesSha256: reviewDeliveryOutboundBytesSha256(request),
          expectedBodySha256: reviewDeliveryBodySha256(body),
          expectedGitLabPosition: position,
          marker,
          revisionProvenance:
            position === null
              ? {
                  kind: "gitlab-summary-retained",
                  intendedHeadSha: action.binding.reviewedHeadSha,
                  freshTargetObservationSha256: reviewDeliveryCurrentObservationSha256({
                    kind: "current",
                    target,
                    sourceSha256: action.binding.sourceSha256,
                    snapshotSha256: action.binding.snapshotSha256,
                    actor: action.binding.actor,
                    headSha: action.binding.reviewedHeadSha,
                    startSha: action.binding.startSha,
                  }),
                  serverAtomicFence: false,
                }
              : {
                  kind: "gitlab-diff-position",
                  baseSha: position.baseSha,
                  startSha: position.startSha,
                  headSha: position.headSha,
                },
        };
        if (committed === undefined || committedDescriptorMatches(effect, committed)) {
          if (action.kind === "publish-summary") this.selectedSummaryBodies.set(effect, body);
          return effect;
        }
      }
      throw providerFault("conflict");
    } catch (error) {
      const fault = error instanceof ProviderFault ? error : providerFault("unavailable");
      return {
        kind: "blocked",
        actionId: action.id,
        code:
          fault.kind === "position-unprovable" || fault.kind === "diff-unavailable"
            ? fault.kind
            : fault.kind === "rate-limited"
              ? "rate-limited"
              : fault.kind === "conflict"
                ? "source-drift"
                : "provider-failure",
        next:
          fault.kind === "position-unprovable" ||
          fault.kind === "diff-unavailable" ||
          fault.kind === "conflict"
            ? "replan-required"
            : "retry",
        retryAfterAt: fault.retryAfterAt,
      };
    }
  }

  async publishEffect(input: {
    readonly plan: ReviewDeliveryPlan;
    readonly effect: ReviewDeliveryPreparedEffect;
    readonly grantsByActionId: ReadonlyMap<string, import("../contracts.js").ReviewDeliveryGrant>;
  }): Promise<ReviewDeliveryPublishOutcome> {
    const { plan, effect, grantsByActionId } = input;
    const action = plan.actions.find((item) => item.id === effect.coveredActionIds[0]);
    try {
      if (
        !action ||
        effect.coveredActionIds.length !== 1 ||
        (action.kind === "publish-summary") !== (effect.stage === "gitlab-note") ||
        !grantsByActionId.has(action.id) ||
        admitReviewDeliveryAction(plan, action, grantsByActionId.get(action.id)!).status !==
          "admitted" ||
        effect.outboundBytesSha256 !== reviewDeliveryOutboundBytesSha256(effect.request)
      )
        throw providerFault("conflict");
      const { target, mr } = await this.identity(action.binding);
      const position =
        action.kind === "publish-inline"
          ? positionFor(action, await this.version(target, mr, action.binding))
          : null;
      const bodies =
        action.kind === "publish-inline"
          ? (() => {
              const finding = plan.findings.find((item) => item.inventoryId === action.findingId);
              if (!finding) throw providerFault("conflict");
              return [renderGitLabReviewFinding({ ...finding, marker: effect.marker })];
            })()
          : (() => {
              const selected = this.selectedSummaryBodies.get(effect);
              if (selected === undefined) throw providerFault("conflict");
              return summaryBodies(
                plan,
                action,
                mr.webUrl,
                retainedThreadUrls(effect, mr.webUrl),
                effect.marker,
                true,
              ).filter((body) => body === selected);
            })();
      const bound = limit("host.gitlab.noteBodyMaxChars");
      const path = `${mrPath(target)}/${position === null ? "notes" : "discussions"}`;
      const exact = bodies.some((body) => {
        if (body.length > bound.value) return false;
        const bytes = encoder.encode(
          JSON.stringify(position === null ? { body } : { body, position: positionJson(position) }),
        );
        return (
          effect.request.method === "POST" &&
          effect.request.path === path &&
          Buffer.compare(Buffer.from(bytes), Buffer.from(effect.request.bodyBytes)) === 0 &&
          effect.expectedBodySha256 === reviewDeliveryBodySha256(body) &&
          effect.actionPayloads.length === 1 &&
          effect.actionPayloads[0]?.actionId === action.id &&
          effect.actionPayloads[0]?.bodySha256 === reviewDeliveryBodySha256(body) &&
          effect.actionPayloads[0]?.anchorSha256 ===
            (position === null ? null : reviewDeliveryGitLabPositionSha256(position)) &&
          (position === null
            ? effect.expectedGitLabPosition === null
            : effect.expectedGitLabPosition !== null &&
              reviewDeliveryGitLabPositionSha256(position) ===
                reviewDeliveryGitLabPositionSha256(effect.expectedGitLabPosition))
        );
      });
      if (!exact) throw providerFault("conflict");
    } catch (error) {
      const fault = error instanceof ProviderFault ? error : providerFault("unavailable");
      return {
        kind: "not-dispatched",
        providerReference: null,
        stop: {
          code: fault.kind === "rate-limited" ? "rate-limited" : "provider-unavailable",
          retryAfterAt: fault.retryAfterAt,
        },
      };
    }
    try {
      const response = await this.request(effect.request);
      const body = object(response.body);
      const reference =
        effect.stage === "gitlab-note" ? String(positiveInt(body.id)) : string(body.id);
      return { kind: "confirmed", providerReference: reference };
    } catch (error) {
      const fault = error instanceof ProviderFault ? error : providerFault("unavailable");
      return {
        kind: "uncertain",
        providerReference: null,
        stop: {
          code: fault.kind === "rate-limited" ? "rate-limited" : "transport-failure",
          retryAfterAt: fault.retryAfterAt,
        },
      };
    }
  }

  private note(
    value: unknown,
    target: GitLabTarget,
    body: string,
    actorId: string,
  ): ReviewDeliveryNativeEvidence {
    const note = object(value);
    if (
      positiveInt(note.project_id) !== target.projectId ||
      positiveInt(note.noteable_iid) !== target.mergeRequestIid ||
      note.noteable_type !== "MergeRequest" ||
      note.system === true ||
      note.body !== body ||
      nativeActor(note.author, target).id !== actorId
    )
      throw providerFault("conflict");
    return {
      kind: "gitlab-note",
      projectId: target.projectId,
      mergeRequestIid: target.mergeRequestIid,
      noteId: positiveInt(note.id),
      author: nativeActor(note.author, target),
      body,
    };
  }

  private discussion(
    value: unknown,
    target: GitLabTarget,
    effect: ReviewDeliveryPreparedEffect,
    actorId: string,
  ): ReviewDeliveryNativeEvidence {
    const discussion = object(value);
    if (!Array.isArray(discussion.notes) || discussion.notes.length === 0)
      throw providerFault("conflict");
    const note = object(discussion.notes[0]);
    const position = parsePosition(note.position);
    if (
      note.system === true ||
      note.body === undefined ||
      reviewDeliveryBodySha256(note.body as string) !== effect.expectedBodySha256 ||
      nativeActor(note.author, target).id !== actorId ||
      effect.expectedGitLabPosition === null ||
      reviewDeliveryGitLabPositionSha256(position) !==
        reviewDeliveryGitLabPositionSha256(effect.expectedGitLabPosition)
    )
      throw providerFault("conflict");
    return {
      kind: "gitlab-discussion",
      projectId: target.projectId,
      mergeRequestIid: target.mergeRequestIid,
      discussionId: string(discussion.id),
      noteId: positiveInt(note.id),
      author: nativeActor(note.author, target),
      body: string(note.body),
      position,
    };
  }

  private nextPath(
    response: GitLabReviewHttpResponse,
    original: string,
    visited: ReadonlySet<string>,
  ): string | null {
    const link = header(response.headers, "link");
    const nextHeader = header(response.headers, "x-next-page");
    if (nextHeader !== undefined && nextHeader !== "" && !/^[1-9]\d*$/u.test(nextHeader))
      throw providerFault("unavailable");
    let raw: string | null = null;
    if (link) {
      const matches = [...link.matchAll(/<([^>]+)>;\s*rel="?next"?/gu)];
      if (matches.length > 1) throw providerFault("unavailable");
      raw = matches[0]?.[1] ?? null;
      if (raw === null && /rel\s*=\s*"?next/iu.test(link)) throw providerFault("unavailable");
    }
    if (raw === null && nextHeader && /^\d+$/u.test(nextHeader)) {
      const url = new URL(original, `https://${this.host}`);
      url.searchParams.set("page", nextHeader);
      raw = url.href;
    }
    if (raw === null) return null;
    let next: URL;
    try {
      next = new URL(raw);
    } catch {
      throw providerFault("unavailable");
    }
    const base = new URL(original, `https://${this.host}`);
    if (
      next.origin !== `https://${this.host}` ||
      next.pathname !== base.pathname ||
      next.username ||
      next.password ||
      next.hash ||
      !/^[1-9]\d*$/u.test(next.searchParams.get("page") ?? "") ||
      next.searchParams.getAll("page").length !== 1 ||
      next.searchParams.getAll("per_page").length !== 1 ||
      [...next.searchParams.keys()].some((key) => !["page", "per_page"].includes(key)) ||
      next.searchParams.get("per_page") !== String(PAGE_SIZE)
    )
      throw providerFault("unavailable");
    const currentPage = Number(base.searchParams.get("page") ?? "1");
    const requestedPage = Number(next.searchParams.get("page"));
    if (
      !Number.isSafeInteger(requestedPage) ||
      requestedPage !== currentPage + 1 ||
      (nextHeader !== undefined && nextHeader !== String(requestedPage))
    )
      throw providerFault("unavailable");
    const path = `${next.pathname}${next.search}`;
    if (visited.has(path)) throw providerFault("unavailable");
    return path;
  }

  private async enumerate(endpoint: string): Promise<{ items: readonly unknown[]; sha: string }> {
    const original = `${endpoint}?per_page=${PAGE_SIZE}`;
    const visited = new Set<string>();
    const items: unknown[] = [];
    let path: string | null = original;
    while (path !== null) {
      if (visited.has(path)) throw providerFault("unavailable");
      visited.add(path);
      const response = await this.request({ method: "GET", path });
      if (!Array.isArray(response.body)) throw providerFault("unavailable");
      items.push(...response.body);
      const next = this.nextPath(response, path, visited);
      const totalPages = header(response.headers, "x-total-pages");
      const page = header(response.headers, "x-page");
      if (
        totalPages !== undefined &&
        (!/^[1-9]\d*$/u.test(totalPages) ||
          !/^[1-9]\d*$/u.test(page ?? "") ||
          (next === null && page !== totalPages) ||
          (next !== null && Number(page) >= Number(totalPages)))
      )
        throw providerFault("unavailable");
      if (
        next === null &&
        response.body.length === PAGE_SIZE &&
        header(response.headers, "x-next-page") === undefined &&
        totalPages === undefined
      )
        throw providerFault("unavailable");
      path = next;
    }
    return { items, sha: digest(items) };
  }

  async observeEffect(
    input: Parameters<ReviewDeliveryRecoveryPort["observeEffect"]>[0],
  ): Promise<ReviewDeliveryRemoteObservation> {
    const { action, effect, phase, providerReference } = input;
    try {
      const { target } = await this.identity(action.binding);
      if (
        effect.coveredActionIds.length !== 1 ||
        effect.coveredActionIds[0] !== action.id ||
        (action.kind === "publish-summary") !== (effect.stage === "gitlab-note") ||
        effect.outboundBytesSha256 !== reviewDeliveryOutboundBytesSha256(effect.request) ||
        effect.effectId !==
          reviewDeliveryEffectId(input.context, effect.stage, effect.coveredActionIds) ||
        effect.marker !== reviewDeliveryEffectNonce(input.context, effect.effectId)
      )
        throw providerFault("conflict");
      let body: JsonObject;
      try {
        body = object(JSON.parse(new TextDecoder().decode(effect.request.bodyBytes)));
      } catch {
        throw providerFault("conflict");
      }
      if (
        reviewDeliveryBodySha256(string(body.body)) !== effect.expectedBodySha256 ||
        !string(body.body).includes(effect.marker)
      )
        throw providerFault("conflict");
      const collection = `${mrPath(target)}/${effect.stage === "gitlab-note" ? "notes" : "discussions"}`;
      const makeMatching = (
        native: ReviewDeliveryNativeEvidence,
        discovery: Extract<ReviewDeliveryRemoteObservation, { kind: "matching" }>["discovery"],
      ): ReviewDeliveryRemoteObservation => ({
        kind: "matching",
        effectId: effect.effectId,
        providerReference:
          native.kind === "gitlab-note"
            ? String(native.noteId)
            : native.kind === "gitlab-discussion"
              ? native.discussionId
              : "",
        native,
        actionReferences: [
          {
            actionId: action.id,
            nativeReference: String(
              native.kind === "gitlab-note" || native.kind === "gitlab-discussion"
                ? native.noteId
                : "",
            ),
          },
        ],
        discovery,
        lifecycle: "final-published",
      });
      if (providerReference !== null && phase === "recovery") {
        const suffix =
          effect.stage === "gitlab-note"
            ? String(positiveInt(Number(providerReference)))
            : encodeURIComponent(providerReference);
        const response = await this.request({ method: "GET", path: `${collection}/${suffix}` });
        const native =
          effect.stage === "gitlab-note"
            ? this.note(response.body, target, string(body.body), action.binding.actor.id)
            : this.discussion(response.body, target, effect, action.binding.actor.id);
        if (
          (native.kind === "gitlab-note" && String(native.noteId) !== providerReference) ||
          (native.kind === "gitlab-discussion" && native.discussionId !== providerReference)
        )
          throw providerFault("conflict");
        return makeMatching(native, { kind: "direct-reference" });
      }
      if (effect.stage === "gitlab-discussion" && phase === "recovery")
        return {
          kind: "ambiguous",
          effectId: effect.effectId,
          reason: "discussion-reference-unavailable",
        };
      const enumeration = await this.enumerate(collection);
      const candidates: ReviewDeliveryNativeEvidence[] = [];
      let unmatchedMarker = false;
      for (const item of enumeration.items) {
        try {
          const native =
            effect.stage === "gitlab-note"
              ? this.note(item, target, string(body.body), action.binding.actor.id)
              : this.discussion(item, target, effect, action.binding.actor.id);
          candidates.push(native);
        } catch (error) {
          if (!(error instanceof ProviderFault) || error.kind !== "conflict") throw error;
          const raw = object(item);
          const observedBody =
            effect.stage === "gitlab-note"
              ? raw.body
              : Array.isArray(raw.notes)
                ? object(raw.notes[0]).body
                : null;
          if (typeof observedBody === "string" && observedBody.includes(effect.marker))
            unmatchedMarker = true;
        }
      }
      if (unmatchedMarker) throw providerFault("conflict");
      if (candidates.length > 1) throw providerFault("conflict");
      if (candidates.length === 0)
        return {
          kind: "absent-proven",
          effectId: effect.effectId,
          completeForActorTargetAndEffect: true,
          enumerationSha256: enumeration.sha,
        };
      if (phase === "pre-dispatch-baseline") throw providerFault("conflict");
      const candidate = candidates[0]!;
      const id =
        candidate.kind === "gitlab-note"
          ? String(candidate.noteId)
          : candidate.kind === "gitlab-discussion"
            ? candidate.discussionId
            : "";
      const direct = await this.request({
        method: "GET",
        path: `${collection}/${encodeURIComponent(id)}`,
      });
      const native =
        effect.stage === "gitlab-note"
          ? this.note(direct.body, target, string(body.body), action.binding.actor.id)
          : this.discussion(direct.body, target, effect, action.binding.actor.id);
      if (digest(native) !== digest(candidate)) throw providerFault("conflict");
      return makeMatching(native, {
        kind: "complete-enumeration",
        enumerationSha256: enumeration.sha,
        matchingCandidateCount: 1,
        directGetVerified: true,
      });
    } catch (error) {
      return {
        kind:
          error instanceof ProviderFault && error.kind === "conflict" ? "conflict" : "unavailable",
        effectId: effect.effectId,
        reason: error instanceof ProviderFault ? error.kind : "transport-failure",
      };
    }
  }
}
