// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { HOSTED_INPUT_CAPACITY, SEMANTIC_INPUT_CAPACITY } from "../live-agent/input-capacity.js";
import {
  HOST_RUNTIME_CAPSULE_EVIDENCE_ITEM_MAXIMUM_BYTES,
  HOST_RUNTIME_CAPSULE_EVIDENCE_JSON_MAXIMUM_BYTES,
  HOST_RUNTIME_CAPSULE_EVIDENCE_MAXIMUM_ITEMS,
  HOST_RUNTIME_REQUEST_STEP_IDS_MAXIMUM,
  REVIEW_SCOPE_CONTINUATION_TEXT_MAXIMUM_CHARS,
  REVIEW_SCOPE_MAXIMUM_TARGETS,
  REVIEW_SCOPE_PATH_MAXIMUM_CHARS,
} from "./bound-capacity.js";
/**
 * Hosted runtime request packet, including frozen inputs and review scope.
 *
 * `allowWrite` is derived from the grant; a serialized boolean cannot mint
 * write authority. Review-scope enums must stay in lockstep with
 * `packages/host/src/review-scope/contracts.ts`.
 */
import { documentShapeRuleIds } from "../security/credential-shape-findings.js";
import type { WorkflowName } from "../workflow-contracts/contracts.js";
import { parseHostRuntimeNativeTask, type HostRuntimeNativeTaskV1 } from "./native-task.js";
import {
  parseHostRuntimeNativeCustody,
  type HostRuntimeNativeCustodyV1,
} from "./native-custody.js";
import { parseHostRuntimeComposition, type HostRuntimeCompositionV1 } from "./composition.js";
import {
  parseCandidateReviewInput,
  type HostRuntimeCandidateReviewV1,
} from "./candidate-review-evidence.js";
import {
  parseHostRuntimeReaderEvidencePolicy,
  parseHostRuntimeReaderTask,
  type HostRuntimeReaderEvidencePolicy,
  type HostRuntimeReaderTaskV1,
} from "./reader-task.js";
import {
  parseHostRuntimeSemanticComparisonChunk,
  parseHostRuntimeSemanticComparisonChunkData,
  type HostRuntimeSemanticComparisonChunkV1,
} from "./semantic-comparison.js";
import {
  HOST_RUNTIME_WORKFLOWS,
  parseHostRuntimeWriteAuthority,
  type HostRuntimeWriteAuthorityV2,
} from "./write-authority.js";
import {
  absolutePath,
  bad,
  canonicalJson,
  containsCredentialDeep,
  digest,
  digestBytes,
  enumeration,
  freezeDeep,
  id,
  nonnegative,
  objectId,
  positive,
  record,
  recordWithOptional,
  segment,
  sha,
  timestamp,
} from "./wire-decode.js";

export const HOST_RUNTIME_REQUEST_KIND = "docsfab-host-runtime-request" as const;

export interface HostRuntimeRequestV1 {
  readonly schemaVersion: 1;
  readonly kind: typeof HOST_RUNTIME_REQUEST_KIND;
  readonly deploymentId: string;
  readonly projectId: string;
  readonly deploymentEpoch: string;
  readonly requestKey: string;
  readonly origin: { readonly principalId: string; readonly requestId: string };
  readonly runId: string;
  readonly fence: number;
  readonly workflow: WorkflowName;
  readonly revision: string;
  readonly sourceTreeObjectId: string;
  readonly packet: {
    readonly packetFingerprintSha256: string;
    readonly inputManifest: HostRuntimeFrozenInputV1 | null;
    readonly canon: HostRuntimeFrozenInputV1 | null;
    readonly reviewEvent: HostRuntimeReviewEventInputV1 | null;
    /** Named documentation pages this run is about; `null` is documentation-set scope. */
    readonly reviewScope: HostRuntimeReviewScopeV1 | null;
    /** Distinct source H and private review commit R/tree T for candidate review. */
    readonly candidateReview?: HostRuntimeCandidateReviewV1 | null;
    /** Inert host-minted reader intent and exact C..H evidence nominations. */
    readonly readerTask?: HostRuntimeReaderTaskV1;
    readonly semanticComparison?: HostRuntimeSemanticComparisonChunkV1;
    /** Inert host-minted native task selection; never an approval or write grant. */
    readonly nativeTask?: HostRuntimeNativeTaskV1;
  };
  readonly stepIds: readonly string[];
  readonly toolPolicySha256: string;
  readonly workspacePath: string;
  readonly stateDirectory: string;
  readonly capsule: {
    readonly sha256: string;
    readonly receiptSha256: string;
    readonly expiresAt: string;
    readonly selectedEvidence: readonly {
      readonly evidenceId: string;
      readonly content: string;
    }[];
  };
  readonly composition: HostRuntimeCompositionV1;
  /** Exact installed ceiling for the complete reader admission closure. */
  readonly readerEvidencePolicy?: HostRuntimeReaderEvidencePolicy;
  /** Host-resolved immutable custody for the selected native task inputs. */
  readonly nativeCustody?: HostRuntimeNativeCustodyV1;
  /**
   * Derived, never believed: the parser requires
   * `allowWrite === (writeAuthority !== null)`, refusing a bare boolean as
   * `write-authority-required`.
   */
  readonly allowWrite: boolean;
  /** `null` for every read-only request. */
  readonly writeAuthority: HostRuntimeWriteAuthorityV2 | null;
}

export interface HostRuntimeFrozenInputV1 {
  readonly kind: "input-manifest" | "canon";
  readonly sha256: string;
  readonly sourcePathSha256: string;
  readonly gitObjectId: string;
  readonly content: string;
}

export interface HostRuntimeReviewEventInputV1 {
  readonly kind: "review-event";
  readonly sha256: string;
  readonly content: string;
}

/**
 * Host-computed review scope, re-verified on arrival. The sealed fields mirror
 * the host's `ReviewScopeV1`; the runtime redeclares them because it does not
 * depend on the host package.
 */
export interface HostRuntimeReviewScopeV1 {
  readonly schemaVersion: 1;
  readonly kind: "docsfab-review-scope";
  readonly scope: "focused-set";
  readonly reason: HostRuntimeReviewScopeReason;
  readonly targets: readonly {
    readonly path: string;
    readonly reason: HostRuntimeReviewScopeTargetReason;
  }[];
  readonly deferred: readonly { readonly path: string; readonly reason: "over-budget" }[];
  readonly scopeSha256: string;
  readonly corpusFileCount: number;
  /**
   * Reference-model heads among the listed pages, carried outside the sealed
   * body like `corpusFileCount`. The continuation command names them first.
   */
  readonly anchorPaths: readonly string[];
  /** Host-derived full-radius accounting, outside the sealed scope body. */
  readonly accounting?: HostRuntimeReviewScopeAccountingV1;
}

export interface HostRuntimeReviewScopeAccountingV1 {
  readonly radiusSha256: string;
  readonly radiusPageCount: number;
  readonly listedPageCount: number;
  readonly unlistedPageCount: number;
  readonly unreviewableNeighbourCount: number;
  readonly changedPathCount: number | null;
  readonly continuationCharacterLimit: number;
}

/**
 * Why a run is scoped. `operator-named` is a Slack `target=` list.
 * `documentation-index` is a Slack question that named no page: its one
 * target is the project's landing page, and each turn approves the pages the
 * documentation index ranks for its question at the turn's revision
 * (`live-agent-pages.ts`, #2400). The rest come from the host-side
 * merge-request blast radius, computed from the diff and the link graph
 * before any model turn.
 */
export type HostRuntimeReviewScopeReason =
  | "operator-named"
  | "documentation-index"
  | "within-budget"
  | "navigation-changed"
  | "model-changed"
  | "config-changed"
  | "scan-unavailable";

/** Why one page is in the reviewed set. */
export type HostRuntimeReviewScopeTargetReason =
  | "operator-named"
  | "changed-document"
  | "anchor-index"
  | "inbound-link"
  | "outbound-link"
  | "navigation-sibling"
  | "snippet-sibling"
  | "source-drift"
  | "anchor-model";

const MAX_FROZEN_INPUT_BYTES = HOSTED_INPUT_CAPACITY.ordinaryFrozenInputBytes;

export function parseHostRuntimeRequest(input: unknown): HostRuntimeRequestV1 {
  return parseHostRuntimeRequestInternal(input, false);
}
/** Inert closed envelope for independent source reads; not an execution admission. */
export function parseHostRuntimeRequestData(input: unknown): HostRuntimeRequestV1 {
  return parseHostRuntimeRequestInternal(input, true);
}
function parseHostRuntimeRequestInternal(input: unknown, dataOnly: boolean): HostRuntimeRequestV1 {
  const root = recordWithOptional(
    input,
    [
      "schemaVersion",
      "kind",
      "deploymentId",
      "projectId",
      "deploymentEpoch",
      "requestKey",
      "origin",
      "runId",
      "fence",
      "workflow",
      "revision",
      "sourceTreeObjectId",
      "packet",
      "stepIds",
      "toolPolicySha256",
      "workspacePath",
      "stateDirectory",
      "capsule",
      "composition",
      "allowWrite",
    ],
    // Optional so a read-only request parses as V1.
    ["writeAuthority", "readerEvidencePolicy", "nativeCustody"],
  );
  if (
    root.schemaVersion !== 1 ||
    root.kind !== HOST_RUNTIME_REQUEST_KIND ||
    typeof root.allowWrite !== "boolean"
  )
    bad("invalid-request");
  const writeAuthority =
    root.writeAuthority === undefined || root.writeAuthority === null
      ? null
      : parseHostRuntimeWriteAuthority(root.writeAuthority);
  // The boolean follows the grant. `allowWrite: true` without one is refused
  // rather than downgraded.
  if (root.allowWrite !== (writeAuthority !== null)) bad("write-authority-required");
  const capsule = record(root.capsule, [
    "sha256",
    "receiptSha256",
    "expiresAt",
    "selectedEvidence",
  ]);
  const composition = parseHostRuntimeComposition(root.composition);
  const origin = record(root.origin, ["principalId", "requestId"]);
  const workflow = enumeration(root.workflow, HOST_RUNTIME_WORKFLOWS);
  const packet = parseFrozenPacket(root.packet, workflow, dataOnly);
  // A typed native task and its custody arrive together or not at all; neither
  // is an ordinary hosted request.
  if ((packet.nativeTask === undefined) !== (root.nativeCustody === undefined))
    bad("native-custody-required");
  const nativeCustody = packet.nativeTask
    ? parseHostRuntimeNativeCustody(root.nativeCustody, packet.nativeTask)
    : undefined;
  // Custody sealed for another deployment, project or epoch is refused, not
  // re-bound.
  if (
    nativeCustody &&
    canonicalJson(nativeCustody.binding) !==
      canonicalJson({
        deploymentId: segment(root.deploymentId),
        projectId: segment(root.projectId),
        deploymentEpoch: segment(root.deploymentEpoch),
      })
  )
    bad("native-custody-project-binding");
  const readerEvidencePolicy =
    root.readerEvidencePolicy === undefined
      ? undefined
      : parseHostRuntimeReaderEvidencePolicy(root.readerEvidencePolicy);
  if (
    !Array.isArray(root.stepIds) ||
    root.stepIds.length < 1 ||
    root.stepIds.length > HOST_RUNTIME_REQUEST_STEP_IDS_MAXIMUM
  )
    bad("invalid-step-catalog");
  const stepIds = root.stepIds.map((value) => id(value));
  if (new Set(stepIds).size !== stepIds.length) bad("invalid-step-catalog");
  if (
    !Array.isArray(capsule.selectedEvidence) ||
    capsule.selectedEvidence.length > HOST_RUNTIME_CAPSULE_EVIDENCE_MAXIMUM_ITEMS
  )
    bad("invalid-capsule");
  const selectedEvidence = capsule.selectedEvidence.map((value) => {
    const item = record(value, ["evidenceId", "content"]);
    if (
      typeof item.content !== "string" ||
      Buffer.byteLength(item.content) > HOST_RUNTIME_CAPSULE_EVIDENCE_ITEM_MAXIMUM_BYTES
    )
      bad("invalid-capsule");
    return Object.freeze({ evidenceId: id(item.evidenceId), content: item.content });
  });
  if (containsCredentialDeep(selectedEvidence, "hosted-request:selectedEvidence"))
    bad("credential-material");
  if (
    Buffer.byteLength(JSON.stringify(selectedEvidence)) >
    HOST_RUNTIME_CAPSULE_EVIDENCE_JSON_MAXIMUM_BYTES
  )
    bad("invalid-capsule");
  const expiresAt = timestamp(capsule.expiresAt);
  if (Date.parse(expiresAt) <= Date.now()) bad("expired-capsule");
  const capsuleSha256 = sha(capsule.sha256);
  const receiptSha256 = sha(capsule.receiptSha256);
  if (capsuleSha256 !== digest({ receiptSha256, expiresAt, selectedEvidence }))
    bad("capsule-digest-mismatch");
  const semantic = packet.semanticComparison;
  if (workflow === "reconcile-product-behavior") {
    if (
      !semantic ||
      semantic.projectId !== root.projectId ||
      packet.canon === null ||
      packet.canon.sha256 !== semantic.canonSha256 ||
      semantic.canonSha256 !== semantic.modelSha256 ||
      packet.inputManifest !== null ||
      packet.reviewEvent !== null ||
      packet.reviewScope !== null ||
      packet.candidateReview ||
      packet.readerTask ||
      writeAuthority !== null
    )
      bad("semantic-workflow-binding");
  } else if (semantic) bad("semantic-workflow-binding");
  if (
    packet.readerTask !== undefined &&
    (workflow !== "update-documentation" ||
      packet.readerTask.comparison.headRevision !== root.revision)
  )
    bad("reader-task-binding-mismatch");
  if ((packet.readerTask === undefined) !== (readerEvidencePolicy === undefined))
    bad("reader-evidence-policy-binding-mismatch");
  if (
    packet.reviewScope !== null &&
    !REVIEW_SCOPE_WORKFLOWS.includes(workflow as (typeof REVIEW_SCOPE_WORKFLOWS)[number])
  )
    bad("invalid-review-scope-workflow");
  const toolPolicySha256 = sha(root.toolPolicySha256);
  if (toolPolicySha256 !== digest({ workflow, stepIds, declaredTools: composition.declaredTools }))
    bad("tool-policy-digest-mismatch");
  const requestKey = id(root.requestKey);
  const principalId = id(origin.principalId);
  const originRequestId = id(origin.requestId);
  // Every selected input must come from the requesting principal. The one
  // exception is a `site-bootstrap` row with a registered
  // `site-bootstrap-approval` import: a reviewer and importing operator, not
  // the requester, signed and registered that plan. The custody parser has
  // already re-derived the proof and refused imports under other tasks.
  if (
    nativeCustody?.inputs.some(
      (input) =>
        input.source.principalId !== principalId &&
        !(
          workflow === "site-bootstrap" && input.approvedImport?.kind === "site-bootstrap-approval"
        ),
    )
  )
    bad("native-custody-actor-binding");
  const candidateReview = packet.candidateReview;
  if (
    candidateReview &&
    (workflow !== "review-documentation" ||
      writeAuthority !== null ||
      packet.inputManifest !== null ||
      packet.canon !== null ||
      packet.reviewEvent !== null ||
      candidateReview.requestKey !== requestKey ||
      candidateReview.reviewCommitObjectId !== objectId(root.revision) ||
      candidateReview.candidateTreeObjectId !== objectId(root.sourceTreeObjectId) ||
      candidateReview.requestIdentitySha256 !==
        digest({
          requestKey,
          mappedIdentity: principalId,
          requestId: originRequestId,
        }))
  )
    bad("candidate-review-binding-mismatch");
  return freezeDeep({
    schemaVersion: 1,
    kind: HOST_RUNTIME_REQUEST_KIND,
    deploymentId: segment(root.deploymentId),
    projectId: segment(root.projectId),
    deploymentEpoch: segment(root.deploymentEpoch),
    requestKey,
    origin: Object.freeze({ principalId, requestId: originRequestId }),
    runId: segment(root.runId),
    fence: positive(root.fence),
    workflow,
    revision: objectId(root.revision),
    sourceTreeObjectId: objectId(root.sourceTreeObjectId),
    packet,
    stepIds: Object.freeze(stepIds),
    toolPolicySha256,
    workspacePath: absolutePath(root.workspacePath),
    stateDirectory: absolutePath(root.stateDirectory),
    capsule: Object.freeze({
      sha256: capsuleSha256,
      receiptSha256,
      expiresAt,
      selectedEvidence: Object.freeze(selectedEvidence),
    }),
    composition,
    ...(readerEvidencePolicy ? { readerEvidencePolicy } : {}),
    ...(nativeCustody ? { nativeCustody } : {}),
    allowWrite: writeAuthority !== null,
    writeAuthority,
  });
}

function parseFrozenPacket(
  input: unknown,
  workflow: string,
  dataOnly = false,
): HostRuntimeRequestV1["packet"] {
  // Without `reviewScope` a packet parses as a documentation-set request.
  const root = recordWithOptional(
    input,
    ["packetFingerprintSha256", "inputManifest", "canon", "reviewEvent"],
    ["reviewScope", "candidateReview", "readerTask", "semanticComparison", "nativeTask"],
  );
  const inputManifest =
    root.inputManifest === null ? null : parseFrozenInput(root.inputManifest, "input-manifest");
  const canon = root.canon === null ? null : parseFrozenInput(root.canon, "canon");
  const reviewEvent =
    root.reviewEvent === null
      ? null
      : parseReviewEventInput(
          root.reviewEvent,
          workflow === "live-agent-turn"
            ? HOSTED_INPUT_CAPACITY.eventBytes
            : MAX_FROZEN_INPUT_BYTES,
        );
  const reviewScope =
    root.reviewScope === undefined || root.reviewScope === null
      ? null
      : parseReviewScopeInput(root.reviewScope);
  const candidateReview =
    root.candidateReview === undefined || root.candidateReview === null
      ? null
      : parseCandidateReviewInput(root.candidateReview);
  const readerTask =
    root.readerTask === undefined || root.readerTask === null
      ? undefined
      : parseHostRuntimeReaderTask(root.readerTask);
  const nativeTask =
    root.nativeTask === undefined ? undefined : parseHostRuntimeNativeTask(root.nativeTask);
  // A task for another workflow is refused, not coerced.
  if (nativeTask && nativeTask.workflow !== workflow) bad("native-task-workflow-binding");
  const semanticComparison =
    root.semanticComparison === undefined
      ? undefined
      : dataOnly
        ? parseHostRuntimeSemanticComparisonChunkData(root.semanticComparison)
        : parseHostRuntimeSemanticComparisonChunk(root.semanticComparison);
  if (
    !inputManifest &&
    !canon &&
    !reviewEvent &&
    !candidateReview &&
    !readerTask &&
    !semanticComparison
  )
    bad("missing-frozen-input");
  if (
    Buffer.byteLength(inputManifest?.content ?? "") +
      Buffer.byteLength(canon?.content ?? "") +
      Buffer.byteLength(reviewEvent?.content ?? "") +
      Buffer.byteLength(candidateReview === null ? "" : canonicalJson(candidateReview)) +
      Buffer.byteLength(nativeTask === undefined ? "" : canonicalJson(nativeTask)) +
      Buffer.byteLength(semanticComparison === undefined ? "" : canonicalJson(semanticComparison)) +
      Buffer.byteLength(reviewScope === null ? "" : canonicalJson(reviewScope)) >
    (workflow === "reconcile-product-behavior"
      ? SEMANTIC_INPUT_CAPACITY.frozenInputsBytes
      : workflow === "live-agent-turn"
        ? HOSTED_INPUT_CAPACITY.frozenInputsBytes
        : HOSTED_INPUT_CAPACITY.ordinaryFrozenInputsBytes)
  )
    bad("frozen-input-size");
  return Object.freeze({
    packetFingerprintSha256: sha(root.packetFingerprintSha256),
    inputManifest,
    canon,
    reviewEvent,
    reviewScope,
    ...(candidateReview === null ? {} : { candidateReview }),
    ...(readerTask === undefined ? {} : { readerTask }),
    ...(semanticComparison === undefined ? {} : { semanticComparison }),
    ...(nativeTask === undefined ? {} : { nativeTask }),
  });
}

/**
 * The only workflows a frozen review scope may ride. A scope is authoritative
 * prompt text, so a workflow that would ignore it fails closed rather than
 * running wide while the record claims it ran narrow. `live-agent-turn` also
 * refuses to run without a scope.
 */
const REVIEW_SCOPE_WORKFLOWS = [
  "review-documentation",
  "live-agent-turn",
] as const satisfies readonly WorkflowName[];

// Lockstep with `packages/host/src/review-scope/contracts.ts`; a code the
// runtime does not know yet fails the attempt closed.
const REVIEW_SCOPE_KINDS = ["focused-set"] as const;
const REVIEW_SCOPE_REASON_CODES = [
  "operator-named",
  "documentation-index",
  "within-budget",
  "navigation-changed",
  "model-changed",
  "config-changed",
  "scan-unavailable",
] as const;
const REVIEW_SCOPE_TARGET_REASON_CODES = [
  "operator-named",
  "changed-document",
  "anchor-index",
  "inbound-link",
  "outbound-link",
  "navigation-sibling",
  "snippet-sibling",
  "source-drift",
  "anchor-model",
] as const;
const REVIEW_SCOPE_DEFERRAL_REASON_CODES = ["over-budget"] as const;
const REVIEW_SCOPE_CONTINUATION_TEXT_LIMIT = REVIEW_SCOPE_CONTINUATION_TEXT_MAXIMUM_CHARS;
const REVIEW_SCOPE_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;

/**
 * Checked segment by segment to match the host's `normalizeReviewScopePath`
 * rule for rule. Rejecting an empty segment also stops URL-shaped values.
 */
function reviewScopePath(value: unknown): string {
  // Shape refusal is kept here, unlike the other wire screens (#1807): the host
  // spine and review-scope contract still refuse a shape-matching scope path,
  // and the two sides must agree. A configured credential refuses as well.
  if (
    typeof value === "string" &&
    (documentShapeRuleIds(value).length > 0 || containsCredentialDeep(value))
  )
    bad("credential-material");
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > REVIEW_SCOPE_PATH_MAXIMUM_CHARS ||
    value.normalize("NFC") !== value ||
    value.startsWith("/") ||
    value.startsWith("~") ||
    value.includes("\\") ||
    REVIEW_SCOPE_CONTROL_CHARACTERS.test(value) ||
    // Whitespace and commas separate Slack `run` grammar tokens, so they would
    // break the rendered continuation command.
    /[\s,]/u.test(value) ||
    value.split("/").some((part) => part === "" || part === "." || part === "..") ||
    !value.endsWith(".md")
  )
    bad("invalid-review-scope");
  return value;
}

/**
 * Whether a review scope could carry `path`. The live-agent documentation
 * index approves only such pages, because it renders them in the same
 * authoritative approved-path list a scope fills (#2400).
 */
export function isHostRuntimeReviewScopePath(path: string): boolean {
  try {
    return reviewScopePath(path) === path;
  } catch {
    return false;
  }
}

function reviewScopeEntries<const T extends readonly string[]>(
  value: unknown,
  reasons: T,
  seen: Set<string>,
): readonly { readonly path: string; readonly reason: T[number] }[] {
  if (!Array.isArray(value) || value.length > REVIEW_SCOPE_MAXIMUM_TARGETS)
    bad("invalid-review-scope");
  return Object.freeze(
    value.map((item) => {
      const entry = record(item, ["path", "reason"]);
      const path = reviewScopePath(entry.path);
      if (typeof entry.reason !== "string" || !reasons.includes(entry.reason))
        bad("invalid-review-scope");
      if (seen.has(path)) bad("invalid-review-scope");
      seen.add(path);
      return Object.freeze({ path, reason: entry.reason as T[number] });
    }),
  );
}

/**
 * Re-verify a focused review scope on arrival. It becomes authoritative prompt
 * text, so it is validated in full: closed enums, repository-relative Markdown
 * paths, no duplicate across reviewed and deferred lists, and the recomputed
 * self-digest.
 */
function parseReviewScopeInput(input: unknown): HostRuntimeReviewScopeV1 {
  // Absent `anchorPaths` reads as empty.
  const root = recordWithOptional(
    input,
    [
      "schemaVersion",
      "kind",
      "scope",
      "reason",
      "targets",
      "deferred",
      "scopeSha256",
      "corpusFileCount",
    ],
    ["anchorPaths", "accounting"],
  );
  if (
    root.schemaVersion !== 1 ||
    root.kind !== "docsfab-review-scope" ||
    typeof root.scope !== "string" ||
    !REVIEW_SCOPE_KINDS.includes(root.scope as (typeof REVIEW_SCOPE_KINDS)[number]) ||
    typeof root.reason !== "string" ||
    !REVIEW_SCOPE_REASON_CODES.includes(root.reason as (typeof REVIEW_SCOPE_REASON_CODES)[number])
  )
    bad("invalid-review-scope");
  const seen = new Set<string>();
  const targets = reviewScopeEntries(root.targets, REVIEW_SCOPE_TARGET_REASON_CODES, seen);
  const deferred = reviewScopeEntries(root.deferred, REVIEW_SCOPE_DEFERRAL_REASON_CODES, seen);
  if (targets.length === 0) bad("invalid-review-scope");
  const corpusFileCount = positive(root.corpusFileCount);
  const body = {
    schemaVersion: 1,
    kind: "docsfab-review-scope",
    scope: root.scope,
    reason: root.reason,
    targets: targets.map((target) => ({ path: target.path, reason: target.reason })),
    deferred: deferred.map((entry) => ({ path: entry.path, reason: entry.reason })),
  };
  if (sha(root.scopeSha256) !== digest(body)) bad("invalid-review-scope");
  // Every anchor must be a valid page path, named once, and present among the
  // reviewed or deferred pages.
  const anchorPaths =
    root.anchorPaths === undefined
      ? []
      : (() => {
          if (
            !Array.isArray(root.anchorPaths) ||
            root.anchorPaths.length > REVIEW_SCOPE_MAXIMUM_TARGETS
          )
            bad("invalid-review-scope");
          const anchors: string[] = [];
          for (const item of root.anchorPaths as readonly unknown[]) {
            const path = reviewScopePath(item);
            if (!seen.has(path) || anchors.includes(path)) bad("invalid-review-scope");
            anchors.push(path);
          }
          return anchors;
        })();
  const accounting =
    root.accounting === undefined
      ? undefined
      : (() => {
          const value = record(root.accounting, [
            "radiusSha256",
            "radiusPageCount",
            "listedPageCount",
            "unlistedPageCount",
            "unreviewableNeighbourCount",
            "changedPathCount",
            "continuationCharacterLimit",
          ]);
          const radiusPageCount = nonnegative(value.radiusPageCount);
          const listedPageCount = nonnegative(value.listedPageCount);
          const unlistedPageCount = nonnegative(value.unlistedPageCount);
          const unreviewableNeighbourCount = nonnegative(value.unreviewableNeighbourCount);
          const changedPathCount =
            value.changedPathCount === null ? null : nonnegative(value.changedPathCount);
          const continuationCharacterLimit = positive(value.continuationCharacterLimit);
          if (
            listedPageCount !== targets.length + deferred.length ||
            radiusPageCount !== listedPageCount + unlistedPageCount ||
            radiusPageCount > corpusFileCount ||
            continuationCharacterLimit > REVIEW_SCOPE_CONTINUATION_TEXT_LIMIT
          )
            bad("invalid-review-scope");
          return Object.freeze({
            radiusSha256: sha(value.radiusSha256),
            radiusPageCount,
            listedPageCount,
            unlistedPageCount,
            unreviewableNeighbourCount,
            changedPathCount,
            continuationCharacterLimit,
          });
        })();
  return Object.freeze({
    schemaVersion: 1 as const,
    kind: "docsfab-review-scope" as const,
    scope: root.scope as (typeof REVIEW_SCOPE_KINDS)[number],
    reason: root.reason as (typeof REVIEW_SCOPE_REASON_CODES)[number],
    targets,
    deferred,
    scopeSha256: sha(root.scopeSha256),
    corpusFileCount,
    anchorPaths: Object.freeze(anchorPaths),
    ...(accounting ? { accounting } : {}),
  });
}

function parseReviewEventInput(
  input: unknown,
  maximumBytes: number,
): HostRuntimeReviewEventInputV1 {
  const root = record(input, ["kind", "sha256", "content"]);
  if (root.kind !== "review-event" || typeof root.content !== "string") bad("invalid-frozen-input");
  if (
    Buffer.byteLength(root.content) > maximumBytes ||
    root.content.includes("\0") ||
    root.content.normalize("NFC") !== root.content ||
    containsCredentialDeep(root.content, "hosted-request:reviewEvent")
  )
    bad("invalid-frozen-input");
  const sha256 = digestBytes(Buffer.from(root.content));
  if (sha(root.sha256) !== sha256) bad("frozen-input-digest-mismatch");
  return Object.freeze({ kind: "review-event", sha256, content: root.content });
}

function parseFrozenInput(
  input: unknown,
  expectedKind: HostRuntimeFrozenInputV1["kind"],
): HostRuntimeFrozenInputV1 {
  const root = record(input, ["kind", "sha256", "sourcePathSha256", "gitObjectId", "content"]);
  if (root.kind !== expectedKind || typeof root.content !== "string") bad("invalid-frozen-input");
  if (
    Buffer.byteLength(root.content) > MAX_FROZEN_INPUT_BYTES ||
    root.content.includes("\0") ||
    root.content.normalize("NFC") !== root.content ||
    containsCredentialDeep(root.content, `hosted-request:${expectedKind}`)
  )
    bad("invalid-frozen-input");
  const contentSha256 = digestBytes(Buffer.from(root.content));
  if (sha(root.sha256) !== contentSha256) bad("frozen-input-digest-mismatch");
  return Object.freeze({
    kind: expectedKind,
    sha256: contentSha256,
    sourcePathSha256: sha(root.sourcePathSha256),
    gitObjectId: objectId(root.gitObjectId),
    content: root.content,
  });
}
