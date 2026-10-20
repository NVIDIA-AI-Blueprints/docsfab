// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { types as utilTypes } from "node:util";

import { containsConfiguredCredentialText } from "./contracts.js";
import {
  canonicalizeJsonEvidence,
  parseJsonEvidence,
  type JsonEvidenceValue,
} from "../json-evidence.js";
import { sha256 } from "../content-ir/canonical.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SAFE_BRANCH =
  /^(?![-.])(?!.*(?:\.\.|@\{|\\|[\x00-\x20~^:?*\[]))(?!.*\/$)(?!.*\.lock(?:\/|$))[A-Za-z0-9._/-]{1,200}$/u;
const SAFE_PATH =
  /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*[\x00-\x1f\\])[A-Za-z0-9._@+ -]+(?:\/[A-Za-z0-9._@+ -]+)*$/u;
const MAXIMUM_ACCEPTANCE_MANIFEST_BYTES = 1024 * 1024;
const MAXIMUM_ACCEPTANCE_JSON_DEPTH = 64;
const MAXIMUM_ACCEPTANCE_JSON_NODES = 100_000;

export const DELIVERY_ACCEPTANCE_IGNORED_NOT_OBSERVED_REASONS = Object.freeze([
  "directory-content",
  "file-size-limit",
  "aggregate-byte-limit",
  "not-owner-private",
  "unsupported-entry",
] as const);
export type DeliveryAcceptanceIgnoredNotObservedReason =
  (typeof DELIVERY_ACCEPTANCE_IGNORED_NOT_OBSERVED_REASONS)[number];

const IGNORED_STATE_POLICY_BODY = {
  schemaVersion: 1 as const,
  kind: "docsfab-delivery-ignored-state-policy" as const,
  maximumEntries: 1_000,
  maximumObservedFileBytes: 1024 * 1024,
  maximumTotalObservedBytes: 8 * 1024 * 1024,
  collapsedDirectoryDisposition: "content-not-observed" as const,
  unsafeLeafDisposition: "content-not-observed" as const,
  overflowDisposition: "fail-closed" as const,
};

export const DELIVERY_ACCEPTANCE_IGNORED_STATE_POLICY = Object.freeze({
  ...IGNORED_STATE_POLICY_BODY,
  sha256: sha256(
    canonicalizeJsonEvidence(IGNORED_STATE_POLICY_BODY as unknown as JsonEvidenceValue),
  ),
});

export interface DeliveryAcceptanceIgnoredStateSummaryV1 {
  policySha256: string;
  disposition: "fully-observed" | "policy-approved-not-observed";
  entryCount: number;
  observedFileCount: number;
  notObservedEntryCount: number;
  notObservedReasons: DeliveryAcceptanceIgnoredNotObservedReason[];
}

export const DELIVERY_ACCEPTANCE_EMPTY_IGNORED_STATE_SUMMARY = Object.freeze({
  policySha256: DELIVERY_ACCEPTANCE_IGNORED_STATE_POLICY.sha256,
  disposition: "fully-observed" as const,
  entryCount: 0,
  observedFileCount: 0,
  notObservedEntryCount: 0,
  notObservedReasons: Object.freeze([]) as unknown as DeliveryAcceptanceIgnoredNotObservedReason[],
});

export const DELIVERY_ACCEPTANCE_CASE_IDS = [
  "dirty-source",
  "stale-revision",
  "patch-conflict",
  "validation-failure",
  "missing-authorization",
  "denied-push",
  "protection-drift",
  "duplicate-invocation",
  "interruption-after-commit",
  "interruption-after-push",
  "interruption-after-merge-request",
] as const;

export type DeliveryAcceptanceCaseId = (typeof DELIVERY_ACCEPTANCE_CASE_IDS)[number];

export interface DeliveryAcceptanceRunBindingV1 {
  id: string;
  recordSha256: string;
  workflow: "readiness" | "review-documentation" | "update-documentation";
  status: "succeeded";
  outcome: string;
  changedPaths: string[];
}

/**
 * Private, portable input that binds the governed DocsFab chain before an SCM
 * publication is attempted. It contains identities only, never record bodies,
 * patch bytes, prompts, model output, credentials, or host paths.
 */
export interface DeliveryAcceptanceChainBindingV1 {
  schemaVersion: 1;
  kind: "docsfab-delivery-acceptance-chain-binding";
  testedRevision: string;
  sourceRevision: string;
  readiness: DeliveryAcceptanceRunBindingV1;
  audit: DeliveryAcceptanceRunBindingV1;
  write: DeliveryAcceptanceRunBindingV1;
  selection: {
    gapId: string;
    evidenceSha256: string;
    successCriterionSha256: string;
    intendedPaths: string[];
    approvedOutcomeSha256: string;
  };
  authorization: {
    sha256: string;
    digest: string;
    decision: "approved";
    reviewerId: string;
    policyDigest: string;
    decidedAt: string;
    expiresAt: string;
  };
  patch: {
    sha256: string;
    byteLength: number;
    lineCount: number;
    changedPaths: string[];
  };
  sha256: string;
}

export interface DeliveryAcceptanceCaseResult {
  id: DeliveryAcceptanceCaseId;
  status: "passed";
  expectedFailureCode: string;
  observedFailureCode: string;
  patchPreserved: true;
  nextAction: string;
  sourceCheckoutUnchanged: true;
  worktreeState: "absent" | "preserved";
  receiptState: "absent" | "planned" | "prepared" | "validated" | "committed" | "pushed" | "opened";
  remoteBranchState: "absent" | "present";
  mergeRequestState: "absent" | "opened";
  expectedExternalMutationCount: number;
  observedExternalMutationCount: number;
}

export interface DeliveryAcceptanceManifestV1 {
  schemaVersion: 1;
  kind: "docsfab-local-user-gitlab-delivery-acceptance";
  mode: "offline" | "live";
  status: "passed";
  testedRevision: string;
  sourceRevision: string;
  chain: DeliveryAcceptanceChainBindingV1;
  plan: {
    sha256: string;
    baseRevision: string;
    runRecordSha256: string;
    patchSha256: string;
  };
  publicationAuthorization: {
    decision: "authorized";
    command: "publish";
    planSha256: string;
  };
  validation: {
    commandSha256: string;
    summarySha256: string;
    status: "passed";
    checkCount: number;
  };
  commit: {
    revision: string;
    treeRevision: string;
    parentRevision: string;
    parentCount: 1;
    baseRevision: string;
  };
  remote: {
    identitySha256: string;
    name: string;
    transport: "ssh" | "https";
    sourceBranch: string;
    targetBranch: string;
    headRevision: string;
  };
  mergeRequest: {
    iid: number;
    draft: true;
    state: "opened";
    sourceBranch: string;
    targetBranch: string;
    headRevision: string;
    identitySha256: string;
  };
  receipt: {
    idempotencyKey: string;
    sha256: string;
    state: "opened";
    disposition: "succeeded";
    planSha256: string;
  };
  sourceCheckout: {
    status: "unchanged";
    beforeSha256: string;
    afterSha256: string;
    ignored: DeliveryAcceptanceIgnoredStateSummaryV1;
  };
  idempotency: {
    invocationCount: number;
    mergeRequestCreateCount: number;
    status: "reused";
  };
  failureMatrix: DeliveryAcceptanceCaseResult[];
  failureMatrixSummary: {
    expectedCaseCount: number;
    observedCaseCount: number;
    expectedExternalMutationCount: number;
    observedExternalMutationCount: number;
  };
  liveGate: {
    status: "not-run" | "approved-and-run";
    destinationSha256?: string;
    cleanup: "separately-gated";
  };
  dogfoodDisposition: "sufficient-for-complex-local-dogfood" | "insufficient";
  sha256: string;
}

export function deliveryAcceptanceChainBindingSha256(
  binding: Omit<DeliveryAcceptanceChainBindingV1, "sha256"> | DeliveryAcceptanceChainBindingV1,
): string {
  assertPassiveJsonGraph(binding);
  const { sha256: _sha256, ...content } = binding as DeliveryAcceptanceChainBindingV1;
  return sha256(canonicalizeJsonEvidence(content as unknown as JsonEvidenceValue));
}

export function finalizeDeliveryAcceptanceChainBinding(
  binding: Omit<DeliveryAcceptanceChainBindingV1, "sha256">,
): DeliveryAcceptanceChainBindingV1 {
  return decodeDeliveryAcceptanceChainBinding({
    ...binding,
    sha256: deliveryAcceptanceChainBindingSha256(binding),
  });
}

export function decodeDeliveryAcceptanceChainBinding(
  value: unknown,
): DeliveryAcceptanceChainBindingV1 {
  assertDeliveryAcceptanceChainBinding(value);
  return value;
}

export function parseDeliveryAcceptanceChainBinding(
  input: string | Uint8Array,
): DeliveryAcceptanceChainBindingV1 {
  return decodeDeliveryAcceptanceChainBinding(parseCanonicalAcceptanceJson(input));
}

export function assertDeliveryAcceptanceChainBinding(
  value: unknown,
): asserts value is DeliveryAcceptanceChainBindingV1 {
  assertPassiveJsonGraph(value);
  const root = closed(value, [
    "schemaVersion",
    "kind",
    "testedRevision",
    "sourceRevision",
    "readiness",
    "audit",
    "write",
    "selection",
    "authorization",
    "patch",
    "sha256",
  ]);
  if (
    root.schemaVersion !== 1 ||
    root.kind !== "docsfab-delivery-acceptance-chain-binding" ||
    !revision(root.testedRevision) ||
    !revision(root.sourceRevision) ||
    !digest(root.sha256)
  )
    invalid();
  const readiness = runBinding(root.readiness, "readiness", false);
  const audit = runBinding(root.audit, "review-documentation", false);
  const write = runBinding(root.write, "update-documentation", true);
  const selection = closed(root.selection, [
    "gapId",
    "evidenceSha256",
    "successCriterionSha256",
    "intendedPaths",
    "approvedOutcomeSha256",
  ]);
  if (
    !identifier(selection.gapId) ||
    !digest(selection.evidenceSha256) ||
    !digest(selection.successCriterionSha256) ||
    !digest(selection.approvedOutcomeSha256)
  )
    invalid();
  const intendedPaths = paths(selection.intendedPaths);
  const authorization = closed(root.authorization, [
    "sha256",
    "digest",
    "decision",
    "reviewerId",
    "policyDigest",
    "decidedAt",
    "expiresAt",
  ]);
  if (
    !digest(authorization.sha256) ||
    !digest(authorization.digest) ||
    authorization.decision !== "approved" ||
    !identifier(authorization.reviewerId) ||
    !digest(authorization.policyDigest)
  )
    invalid();
  const decidedAt = timestamp(authorization.decidedAt);
  const expiresAt = timestamp(authorization.expiresAt);
  if (decidedAt >= expiresAt) invalid();
  const patch = closed(root.patch, ["sha256", "byteLength", "lineCount", "changedPaths"]);
  if (!digest(patch.sha256) || !integer(patch.byteLength, 1) || !integer(patch.lineCount, 0))
    invalid();
  const patchPaths = paths(patch.changedPaths);
  if (
    !sameStrings(write.changedPaths, patchPaths) ||
    patchPaths.some((path) => !intendedPaths.includes(path)) ||
    root.sha256 !== deliveryAcceptanceChainBindingSha256(value as DeliveryAcceptanceChainBindingV1)
  )
    invalid();
  assertSharingBoundary(value);
  void readiness;
  void audit;
}

export function deliveryAcceptanceManifestSha256(
  manifest: Omit<DeliveryAcceptanceManifestV1, "sha256"> | DeliveryAcceptanceManifestV1,
): string {
  assertPassiveJsonGraph(manifest);
  const { sha256: _sha256, ...content } = manifest as DeliveryAcceptanceManifestV1;
  return sha256(canonicalizeJsonEvidence(content as unknown as JsonEvidenceValue));
}

export function finalizeDeliveryAcceptanceManifest(
  manifest: Omit<DeliveryAcceptanceManifestV1, "sha256">,
): DeliveryAcceptanceManifestV1 {
  return decodeDeliveryAcceptanceManifest({
    ...manifest,
    sha256: deliveryAcceptanceManifestSha256(manifest),
  });
}

/** The single strict decoder used for both offline and live acceptance manifests. */
export function decodeDeliveryAcceptanceManifest(value: unknown): DeliveryAcceptanceManifestV1 {
  assertDeliveryAcceptanceManifest(value);
  return value;
}

export function parseDeliveryAcceptanceManifest(
  input: string | Uint8Array,
): DeliveryAcceptanceManifestV1 {
  return decodeDeliveryAcceptanceManifest(parseCanonicalAcceptanceJson(input));
}

export function assertDeliveryAcceptanceManifest(
  value: unknown,
): asserts value is DeliveryAcceptanceManifestV1 {
  assertPassiveJsonGraph(value);
  const root = closed(value, [
    "schemaVersion",
    "kind",
    "mode",
    "status",
    "testedRevision",
    "sourceRevision",
    "chain",
    "plan",
    "publicationAuthorization",
    "validation",
    "commit",
    "remote",
    "mergeRequest",
    "receipt",
    "sourceCheckout",
    "idempotency",
    "failureMatrix",
    "failureMatrixSummary",
    "liveGate",
    "dogfoodDisposition",
    "sha256",
  ]);
  if (
    root.schemaVersion !== 1 ||
    root.kind !== "docsfab-local-user-gitlab-delivery-acceptance" ||
    (root.mode !== "offline" && root.mode !== "live") ||
    root.status !== "passed" ||
    !revision(root.testedRevision) ||
    !revision(root.sourceRevision) ||
    !digest(root.sha256)
  )
    invalid();
  const chain = decodeDeliveryAcceptanceChainBinding(root.chain);
  if (root.testedRevision !== chain.testedRevision || root.sourceRevision !== chain.sourceRevision)
    invalid();

  const plan = closed(root.plan, ["sha256", "baseRevision", "runRecordSha256", "patchSha256"]);
  if (
    !digest(plan.sha256) ||
    !revision(plan.baseRevision) ||
    !digest(plan.runRecordSha256) ||
    !digest(plan.patchSha256) ||
    plan.baseRevision !== root.sourceRevision ||
    plan.runRecordSha256 !== chain.write.recordSha256 ||
    plan.patchSha256 !== chain.patch.sha256
  )
    invalid();
  const publicationAuthorization = closed(root.publicationAuthorization, [
    "decision",
    "command",
    "planSha256",
  ]);
  if (
    publicationAuthorization.decision !== "authorized" ||
    publicationAuthorization.command !== "publish" ||
    publicationAuthorization.planSha256 !== plan.sha256
  )
    invalid();
  const validation = closed(root.validation, [
    "commandSha256",
    "summarySha256",
    "status",
    "checkCount",
  ]);
  if (
    !digest(validation.commandSha256) ||
    !digest(validation.summarySha256) ||
    validation.status !== "passed" ||
    !integer(validation.checkCount, 1)
  )
    invalid();
  const commit = closed(root.commit, [
    "revision",
    "treeRevision",
    "parentRevision",
    "parentCount",
    "baseRevision",
  ]);
  if (
    !revision(commit.revision) ||
    !revision(commit.treeRevision) ||
    !revision(commit.parentRevision) ||
    commit.parentCount !== 1 ||
    commit.baseRevision !== plan.baseRevision ||
    commit.parentRevision !== plan.baseRevision
  )
    invalid();
  const remote = closed(root.remote, [
    "identitySha256",
    "name",
    "transport",
    "sourceBranch",
    "targetBranch",
    "headRevision",
  ]);
  if (
    !digest(remote.identitySha256) ||
    !identifier(remote.name) ||
    (remote.transport !== "ssh" && remote.transport !== "https") ||
    !branch(remote.sourceBranch) ||
    !branch(remote.targetBranch) ||
    remote.sourceBranch === remote.targetBranch ||
    remote.headRevision !== commit.revision
  )
    invalid();
  const mergeRequest = closed(root.mergeRequest, [
    "iid",
    "draft",
    "state",
    "sourceBranch",
    "targetBranch",
    "headRevision",
    "identitySha256",
  ]);
  if (
    !integer(mergeRequest.iid, 1) ||
    mergeRequest.draft !== true ||
    mergeRequest.state !== "opened" ||
    !digest(mergeRequest.identitySha256) ||
    mergeRequest.sourceBranch !== remote.sourceBranch ||
    mergeRequest.targetBranch !== remote.targetBranch ||
    mergeRequest.headRevision !== remote.headRevision
  )
    invalid();
  const receipt = closed(root.receipt, [
    "idempotencyKey",
    "sha256",
    "state",
    "disposition",
    "planSha256",
  ]);
  if (
    !digest(receipt.idempotencyKey) ||
    !digest(receipt.sha256) ||
    receipt.state !== "opened" ||
    receipt.disposition !== "succeeded" ||
    receipt.planSha256 !== plan.sha256
  )
    invalid();
  const sourceCheckout = closed(root.sourceCheckout, [
    "status",
    "beforeSha256",
    "afterSha256",
    "ignored",
  ]);
  if (
    sourceCheckout.status !== "unchanged" ||
    !digest(sourceCheckout.beforeSha256) ||
    sourceCheckout.afterSha256 !== sourceCheckout.beforeSha256
  )
    invalid();
  ignoredStateSummary(sourceCheckout.ignored);
  const idempotency = closed(root.idempotency, [
    "invocationCount",
    "mergeRequestCreateCount",
    "status",
  ]);
  if (
    !integer(idempotency.invocationCount, 1) ||
    !integer(idempotency.mergeRequestCreateCount, 1) ||
    idempotency.status !== "reused" ||
    idempotency.mergeRequestCreateCount > idempotency.invocationCount
  )
    invalid();

  const failureMatrix = denseArray(root.failureMatrix, DELIVERY_ACCEPTANCE_CASE_IDS.length);
  let expectedMutations = 0;
  let observedMutations = 0;
  for (const [index, candidate] of failureMatrix.entries()) {
    const item = closed(candidate, [
      "id",
      "status",
      "expectedFailureCode",
      "observedFailureCode",
      "patchPreserved",
      "nextAction",
      "sourceCheckoutUnchanged",
      "worktreeState",
      "receiptState",
      "remoteBranchState",
      "mergeRequestState",
      "expectedExternalMutationCount",
      "observedExternalMutationCount",
    ]);
    if (
      item.id !== DELIVERY_ACCEPTANCE_CASE_IDS[index] ||
      item.status !== "passed" ||
      !safeLabel(item.expectedFailureCode) ||
      item.observedFailureCode !== item.expectedFailureCode ||
      item.patchPreserved !== true ||
      item.sourceCheckoutUnchanged !== true ||
      !safeLabel(item.nextAction) ||
      (item.worktreeState !== "absent" && item.worktreeState !== "preserved") ||
      !["absent", "planned", "prepared", "validated", "committed", "pushed", "opened"].includes(
        item.receiptState as string,
      ) ||
      (item.remoteBranchState !== "absent" && item.remoteBranchState !== "present") ||
      (item.mergeRequestState !== "absent" && item.mergeRequestState !== "opened") ||
      !integer(item.expectedExternalMutationCount, 0) ||
      item.observedExternalMutationCount !== item.expectedExternalMutationCount ||
      item.observedExternalMutationCount !==
        Number(item.remoteBranchState === "present") + Number(item.mergeRequestState === "opened")
    ) {
      invalid();
    }
    expectedMutations += item.expectedExternalMutationCount;
    observedMutations += item.observedExternalMutationCount;
  }
  if (failureMatrix.length !== DELIVERY_ACCEPTANCE_CASE_IDS.length) invalid();
  const matrixSummary = closed(root.failureMatrixSummary, [
    "expectedCaseCount",
    "observedCaseCount",
    "expectedExternalMutationCount",
    "observedExternalMutationCount",
  ]);
  if (
    matrixSummary.expectedCaseCount !== DELIVERY_ACCEPTANCE_CASE_IDS.length ||
    matrixSummary.observedCaseCount !== failureMatrix.length ||
    matrixSummary.expectedExternalMutationCount !== expectedMutations ||
    matrixSummary.observedExternalMutationCount !== observedMutations
  )
    invalid();
  const liveGate = closed(
    root.liveGate,
    root.mode === "live" ? ["status", "destinationSha256", "cleanup"] : ["status", "cleanup"],
  );
  if (
    liveGate.cleanup !== "separately-gated" ||
    (root.mode === "offline" && liveGate.status !== "not-run") ||
    (root.mode === "live" &&
      (liveGate.status !== "approved-and-run" || !digest(liveGate.destinationSha256)))
  )
    invalid();
  if (
    root.dogfoodDisposition !== "sufficient-for-complex-local-dogfood" ||
    root.sha256 !== deliveryAcceptanceManifestSha256(value as DeliveryAcceptanceManifestV1)
  )
    invalid();
  assertSharingBoundary(value);
}

function runBinding(
  value: unknown,
  workflow: DeliveryAcceptanceRunBindingV1["workflow"],
  write: boolean,
): DeliveryAcceptanceRunBindingV1 {
  const item = closed(value, [
    "id",
    "recordSha256",
    "workflow",
    "status",
    "outcome",
    "changedPaths",
  ]);
  if (
    !identifier(item.id) ||
    !digest(item.recordSha256) ||
    item.workflow !== workflow ||
    item.status !== "succeeded" ||
    !safeOutcome(item.outcome)
  )
    invalid();
  const changedPaths = paths(item.changedPaths);
  if ((write && changedPaths.length === 0) || (!write && changedPaths.length !== 0)) invalid();
  return item as unknown as DeliveryAcceptanceRunBindingV1;
}

function paths(value: unknown): string[] {
  const decoded = denseArray(value, 100);
  if (decoded.some((item) => !path(item))) invalid();
  const result = decoded as string[];
  if (
    new Set(result).size !== result.length ||
    result.some((item, index) => index > 0 && result[index - 1]!.localeCompare(item) >= 0)
  )
    invalid();
  return result;
}

function assertSharingBoundary(value: unknown): void {
  const serialized = canonicalizeJsonEvidence(value as JsonEvidenceValue);
  if (
    containsConfiguredCredentialText(serialized, "delivery-acceptance-manifest") ||
    /(?:\braw\b|\btranscript\b|\bprompt\b|repositoryPath|sourcePath|artifactPath|hostPath|\/Users\/|\/home\/|\/tmp\/)/iu.test(
      serialized,
    )
  ) {
    throw new Error("Delivery acceptance manifest crossed the sharing boundary.");
  }
}

function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    utilTypes.isProxy(value)
  )
    invalid();
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) invalid();
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => typeof key !== "string") ||
    ownKeys.map(String).sort().join(",") !== [...keys].sort().join(",")
  )
    invalid();
  for (const key of ownKeys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) invalid();
  }
  return value as Record<string, unknown>;
}

function denseArray(value: unknown, maximum: number): unknown[] {
  if (
    !Array.isArray(value) ||
    utilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  )
    invalid();
  const length = Object.getOwnPropertyDescriptor(value, "length");
  if (
    !length ||
    !Object.hasOwn(length, "value") ||
    !Number.isSafeInteger(length.value) ||
    length.value < 0 ||
    length.value > maximum
  )
    invalid();
  const result: unknown[] = [];
  for (let index = 0; index < length.value; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) invalid();
    result.push(descriptor.value);
  }
  if (Reflect.ownKeys(value).length !== result.length + 1) invalid();
  return result;
}

function ignoredStateSummary(value: unknown): DeliveryAcceptanceIgnoredStateSummaryV1 {
  const root = closed(value, [
    "policySha256",
    "disposition",
    "entryCount",
    "observedFileCount",
    "notObservedEntryCount",
    "notObservedReasons",
  ]);
  const reasons = denseArray(
    root.notObservedReasons,
    DELIVERY_ACCEPTANCE_IGNORED_NOT_OBSERVED_REASONS.length,
  );
  if (
    root.policySha256 !== DELIVERY_ACCEPTANCE_IGNORED_STATE_POLICY.sha256 ||
    (root.disposition !== "fully-observed" &&
      root.disposition !== "policy-approved-not-observed") ||
    !integer(root.entryCount, 0) ||
    !integer(root.observedFileCount, 0) ||
    !integer(root.notObservedEntryCount, 0) ||
    root.observedFileCount + root.notObservedEntryCount !== root.entryCount ||
    reasons.some(
      (reason) =>
        !DELIVERY_ACCEPTANCE_IGNORED_NOT_OBSERVED_REASONS.includes(
          reason as DeliveryAcceptanceIgnoredNotObservedReason,
        ),
    ) ||
    new Set(reasons).size !== reasons.length ||
    reasons.some((reason, index) => index > 0 && String(reasons[index - 1]) >= String(reason)) ||
    (root.notObservedEntryCount === 0) !== (root.disposition === "fully-observed") ||
    (root.notObservedEntryCount === 0) !== (reasons.length === 0)
  )
    invalid();
  return root as unknown as DeliveryAcceptanceIgnoredStateSummaryV1;
}

function parseCanonicalAcceptanceJson(input: string | Uint8Array): unknown {
  const byteLength =
    typeof input === "string" ? Buffer.byteLength(input, "utf8") : input.byteLength;
  if (byteLength < 2 || byteLength > MAXIMUM_ACCEPTANCE_MANIFEST_BYTES) invalid();
  try {
    return parseJsonEvidence(input, { requireCanonical: true });
  } catch {
    invalid();
  }
}

function assertPassiveJsonGraph(value: unknown): void {
  let nodes = 0;
  const seen = new Set<object>();
  const visit = (candidate: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > MAXIMUM_ACCEPTANCE_JSON_NODES || depth > MAXIMUM_ACCEPTANCE_JSON_DEPTH) invalid();
    if (candidate === null || typeof candidate === "string" || typeof candidate === "boolean")
      return;
    if (typeof candidate === "number") {
      if (
        !Number.isFinite(candidate) ||
        Object.is(candidate, -0) ||
        (Number.isInteger(candidate) && !Number.isSafeInteger(candidate))
      )
        invalid();
      return;
    }
    if (typeof candidate !== "object" || utilTypes.isProxy(candidate) || seen.has(candidate))
      invalid();
    const proto = Object.getPrototypeOf(candidate);
    const array = Array.isArray(candidate);
    if (
      (array && proto !== Array.prototype) ||
      (!array && proto !== Object.prototype && proto !== null)
    )
      invalid();
    seen.add(candidate);
    const keys = Reflect.ownKeys(candidate);
    if (keys.some((key) => typeof key !== "string")) invalid();
    if (array) {
      const length = Object.getOwnPropertyDescriptor(candidate, "length");
      if (
        !length ||
        !Object.hasOwn(length, "value") ||
        !Number.isSafeInteger(length.value) ||
        length.value < 0 ||
        keys.length !== length.value + 1
      )
        invalid();
      for (let index = 0; index < length.value; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(candidate, String(index));
        if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) invalid();
        visit(descriptor.value, depth + 1);
      }
    } else {
      for (const key of keys as string[]) {
        const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
        if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) invalid();
        visit(descriptor.value, depth + 1);
      }
    }
  };
  visit(value, 0);
}

function digest(value: unknown): value is string {
  return typeof value === "string" && SHA256.test(value);
}

function revision(value: unknown): value is string {
  return typeof value === "string" && REVISION.test(value);
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER.test(value);
}

function branch(value: unknown): value is string {
  return typeof value === "string" && SAFE_BRANCH.test(value);
}

function path(value: unknown): value is string {
  return typeof value === "string" && value.length <= 512 && SAFE_PATH.test(value);
}

function safeLabel(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,127}$/u.test(value);
}

function safeOutcome(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    !/[\x00-\x1f]/u.test(value)
  );
}

function integer(value: unknown, minimum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

function timestamp(value: unknown): number {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value))
    invalid();
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) invalid();
  return parsed;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function invalid(): never {
  throw new Error("Invalid delivery acceptance manifest.");
}
