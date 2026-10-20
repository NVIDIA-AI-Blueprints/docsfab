// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash, createHmac } from "node:crypto";

import { createContractKit } from "../contract-kit/index.js";
import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../json-evidence.js";
import {
  decodeReviewTargetV2,
  reviewTargetKeyV2,
  type ReviewTargetV2,
} from "../review/contracts.js";
import type { ReviewDeliveryAction, ReviewDeliveryActor, ReviewDeliveryPlan } from "./contracts.js";

export type ReviewDeliveryReceiptErrorCode =
  | "invalid-record"
  | "identity-mismatch"
  | "invalid-transition";

export class ReviewDeliveryReceiptContractError extends Error {
  public constructor(public readonly code: ReviewDeliveryReceiptErrorCode) {
    super(`Review delivery receipt refused (${code}).`);
    this.name = "ReviewDeliveryReceiptContractError";
  }
}

const kit = createContractKit<ReviewDeliveryReceiptErrorCode>({
  fail: (code) => {
    throw new ReviewDeliveryReceiptContractError(code);
  },
  codes: {
    invalidShape: "invalid-record",
    invalidValue: "invalid-record",
    digestMismatch: "invalid-record",
    credentialMaterial: "invalid-record",
    schemaMismatch: "invalid-record",
  },
  inertMode: "strict",
});

const RECORD_KIND = "docsfab-review-delivery-record";
const SHA = /^[a-f0-9]{64}$/u;
const EFFECT_STATES = [
  "pending",
  "intent",
  "not-dispatched",
  "accepted-pending",
  "uncertain",
  "confirmed",
] as const;
const STAGES = [
  "gitlab-note",
  "gitlab-discussion",
  "github-pending-review-create",
  "github-comment-submit",
] as const;
const STOP_CODES = [
  "position-unprovable",
  "diff-unavailable",
  "source-drift",
  "rate-limited",
  "cancelled",
  "provider-failure",
  "provider-unavailable",
  "transport-failure",
] as const;

export interface ReviewDeliveryManifestV1 {
  readonly logicalDeliveryId: string;
  readonly manifestSha256: string;
  readonly idempotencyKey: string;
  readonly target: ReviewTargetV2;
  readonly targetKeySha256: string;
  readonly sourceSha256: string;
  readonly snapshotSha256: string;
  readonly reviewedHeadSha: string;
  readonly startSha: string | null;
  readonly artifactId: string;
  readonly originalResultSha256: string;
  readonly actor: ReviewDeliveryActor;
  readonly actions: readonly {
    readonly actionId: string;
    readonly kind: ReviewDeliveryAction["kind"];
    readonly actionSha256: string;
  }[];
}

export interface ReviewDeliveryCommittedEffectV1 {
  readonly effectId: string;
  readonly stage: (typeof STAGES)[number];
  readonly coveredActionIds: readonly string[];
  readonly actionPayloads: readonly {
    readonly actionId: string;
    readonly bodySha256: string;
    readonly anchorSha256: string | null;
  }[];
  readonly outboundBytesSha256: string;
  readonly expectedBodySha256: string;
  readonly expectedGitLabPositionSha256: string | null;
  readonly marker: string;
}

export interface ReviewDeliveryEffectContextV1 {
  readonly kind: "docsfab-review-delivery-effect-context";
  readonly schemaVersion: 1;
  readonly logicalDeliveryId: string;
  readonly correlationSeed: string;
  readonly committedEffects: readonly ReviewDeliveryCommittedEffectV1[];
}

export interface ReviewDeliveryStopV1 {
  readonly code: (typeof STOP_CODES)[number];
  readonly retryAfterAt: string | null;
}

export interface ReviewDeliveryEffectReceiptV1 extends ReviewDeliveryCommittedEffectV1 {
  readonly state: (typeof EFFECT_STATES)[number];
  readonly attemptId: string;
  readonly providerReference: string | null;
  readonly observationSha256: string | null;
  readonly actionReferences: readonly {
    readonly actionId: string;
    readonly nativeReference: string;
  }[];
  readonly baseline: null | {
    readonly scopeSha256: string;
    readonly enumerationSha256: string;
    readonly bodySha256: string;
  };
  readonly stop: ReviewDeliveryStopV1 | null;
}

export interface ReviewDeliveryRecordV1 {
  readonly kind: typeof RECORD_KIND;
  readonly schemaVersion: 1;
  readonly idempotencyKey: string;
  readonly manifest: ReviewDeliveryManifestV1;
  readonly originStoreId: string;
  readonly ownerStoreId: string;
  readonly generation: number;
  readonly custody: {
    readonly state: "active" | "fenced-out" | "import-pending" | "transferred";
    readonly transferId: string | null;
    readonly otherStoreId: string | null;
  };
  readonly context: ReviewDeliveryEffectContextV1;
  readonly preparationStop:
    | null
    | (ReviewDeliveryStopV1 & {
        readonly actionId: string | null;
        readonly next: "retry" | "replan-required";
      });
  readonly effects: readonly ReviewDeliveryEffectReceiptV1[];
  readonly sha256: string;
}

function sha(value: unknown): string {
  return createHash("sha256")
    .update(canonicalizeJsonEvidence(value as JsonEvidenceValue))
    .digest("hex");
}

function orderedUnique(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || values[index - 1]! < value);
}

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const object = kit.object(value);
  kit.exact(object, keys);
  return object;
}

function nullableString(value: unknown): string | null {
  return value === null ? null : kit.string(value);
}

function stop(value: unknown): ReviewDeliveryStopV1 {
  const root = exact(value, ["code", "retryAfterAt"]);
  return {
    code: kit.enumeration(root.code, STOP_CODES),
    retryAfterAt: kit.nullableTimestamp(root.retryAfterAt),
  };
}

/** Original result identity stays stable when historical projection changes. */
export function createReviewDeliveryManifest(plan: ReviewDeliveryPlan): ReviewDeliveryManifestV1 {
  const target = decodeReviewTargetV2(plan.target);
  if (plan.actions.some((action) => action.binding.target.targetSha256 !== target.targetSha256))
    throw new ReviewDeliveryReceiptContractError("identity-mismatch");
  const actions = plan.actions
    .map((action) => ({
      actionId: kit.hash(action.id),
      kind: action.kind,
      actionSha256: sha(action),
    }))
    .sort((left, right) => kit.compare(left.actionId, right.actionId));
  if (!orderedUnique(actions.map((action) => action.actionId)))
    throw new ReviewDeliveryReceiptContractError("identity-mismatch");
  const first = plan.actions[0]?.binding;
  const sourceSha256 =
    first?.sourceSha256 ?? (plan.source as { changeSourceSha256?: string }).changeSourceSha256;
  const snapshotSha256 = plan.snapshotSha256;
  const reviewedHeadSha = first?.reviewedHeadSha ?? plan.result.reviewedHeadSha;
  const startSha = first?.startSha ?? null;
  if (!sourceSha256 || !SHA.test(sourceSha256) || !SHA.test(snapshotSha256))
    throw new ReviewDeliveryReceiptContractError("identity-mismatch");
  for (const action of plan.actions) {
    const binding = action.binding;
    if (
      binding.sourceSha256 !== sourceSha256 ||
      binding.snapshotSha256 !== snapshotSha256 ||
      binding.reviewedHeadSha !== reviewedHeadSha ||
      binding.startSha !== startSha ||
      binding.artifact.id !== plan.artifact.id ||
      binding.artifact.resultSha256 !== plan.artifact.resultSha256 ||
      binding.actor.host !== plan.actor.host ||
      binding.actor.id !== plan.actor.id
    )
      throw new ReviewDeliveryReceiptContractError("identity-mismatch");
  }
  if (plan.result.originalResultSha256 !== plan.artifact.resultSha256)
    throw new ReviewDeliveryReceiptContractError("identity-mismatch");
  const targetKeySha256 = sha(reviewTargetKeyV2(target));
  const identity = {
    domain: "docsfab-review-delivery-logical-v1",
    artifactId: plan.artifact.id,
    originalResultSha256: plan.result.originalResultSha256,
    targetSha256: target.targetSha256,
    targetKeySha256,
    sourceSha256,
    snapshotSha256,
    reviewedHeadSha,
    startSha,
    actor: plan.actor,
  };
  const logicalDeliveryId = sha(identity);
  const body = {
    logicalDeliveryId,
    idempotencyKey: sha({ domain: "docsfab-review-delivery-journal-v1", logicalDeliveryId }),
    target,
    targetKeySha256,
    sourceSha256,
    snapshotSha256,
    reviewedHeadSha,
    startSha,
    artifactId: plan.artifact.id,
    originalResultSha256: plan.result.originalResultSha256,
    actor: { ...plan.actor },
    actions,
  };
  return { ...body, manifestSha256: sha(body) };
}

/** The V1 null-start alias exists only for a GitLab request with no retained findings. */
export function createReviewDeliveryLegacyEmptyManifest(
  plan: ReviewDeliveryPlan,
): ReviewDeliveryManifestV1 | null {
  if (
    plan.target.scmProvider !== "gitlab" ||
    plan.findings.length !== 0 ||
    (plan.requestedActions !== "overview" && plan.requestedActions !== "summary-only") ||
    plan.actions.length !== 1 ||
    plan.actions[0]?.kind !== "publish-summary" ||
    plan.actions[0].findingIds.length !== 0
  )
    return null;
  // Preserve the original V1 identity formula: no action means null startSha.
  return createReviewDeliveryManifest({ ...plan, actions: [] });
}

export function reviewDeliveryRecordSha256(record: Omit<ReviewDeliveryRecordV1, "sha256">): string {
  return sha(record);
}

export function createReviewDeliveryRecord(
  manifest: ReviewDeliveryManifestV1,
  originStoreId: string,
  correlationSeed: string,
): ReviewDeliveryRecordV1 {
  kit.hash(originStoreId);
  kit.string(correlationSeed);
  const body = {
    kind: RECORD_KIND,
    schemaVersion: 1 as const,
    idempotencyKey: manifest.idempotencyKey,
    manifest,
    originStoreId,
    ownerStoreId: originStoreId,
    generation: 0,
    custody: { state: "active" as const, transferId: null, otherStoreId: null },
    context: {
      kind: "docsfab-review-delivery-effect-context" as const,
      schemaVersion: 1 as const,
      logicalDeliveryId: manifest.logicalDeliveryId,
      correlationSeed,
      committedEffects: [] as ReviewDeliveryCommittedEffectV1[],
    },
    preparationStop: null,
    effects: [] as ReviewDeliveryEffectReceiptV1[],
  };
  return assertReviewDeliveryRecordShape({ ...body, sha256: sha(body) });
}

/** A fenced source supplies the complete immutable context and known effects. */
export function createReviewDeliveryImportRecord(
  sourceValue: ReviewDeliveryRecordV1,
  destinationStoreId: string,
): ReviewDeliveryRecordV1 {
  const source = assertReviewDeliveryRecordShape(sourceValue);
  kit.hash(destinationStoreId);
  if (
    (source.custody.state !== "fenced-out" && source.custody.state !== "transferred") ||
    source.custody.otherStoreId !== destinationStoreId ||
    source.custody.transferId === null ||
    source.generation >= Number.MAX_SAFE_INTEGER
  )
    throw new ReviewDeliveryReceiptContractError("invalid-transition");
  const body = {
    ...source,
    ownerStoreId: destinationStoreId,
    generation: source.generation + 1,
    custody: {
      state: "import-pending" as const,
      transferId: source.custody.transferId,
      otherStoreId: source.ownerStoreId,
    },
  };
  const { sha256: _oldSha, ...withoutSha } = body;
  return assertReviewDeliveryRecordShape({ ...withoutSha, sha256: sha(withoutSha) });
}

/** Imported effects may advance, but source evidence and native references remain. */
export function reviewDeliveryImportedLineageMatches(
  source: ReviewDeliveryRecordV1,
  successor: ReviewDeliveryRecordV1,
): boolean {
  // An import-pending slot may settle known remote effects before activation,
  // but it cannot erase the fenced source's preparation stop, add effects, or
  // change recovery fields outside the journal's normal transition rules.
  if (successor.custody.state === "import-pending") {
    try {
      const imported = createReviewDeliveryImportRecord(source, successor.ownerStoreId);
      if (
        sha(imported.preparationStop) !== sha(successor.preparationStop) ||
        sha(imported.context.committedEffects) !== sha(successor.context.committedEffects) ||
        imported.effects.length !== successor.effects.length
      )
        return false;
      try {
        assertReviewDeliveryTransition(imported, successor);
      } catch {
        // A receipt-lost POST is journaled as intent → uncertain → settled.
        // Compare the descendant through that one actual recovery stage; each
        // leg still uses the same transition validator as a durable CAS.
        const intermediate = updateReviewDeliveryRecord(imported, {
          effects: imported.effects.map((effect) => {
            const next = successor.effects.find(
              (candidate) => candidate.effectId === effect.effectId,
            );
            return effect.state === "intent" &&
              (next?.state === "confirmed" || next?.state === "accepted-pending")
              ? { ...effect, state: "uncertain" as const }
              : effect;
          }),
        });
        if (intermediate.sha256 === imported.sha256) return false;
        assertReviewDeliveryTransition(intermediate, successor);
      }
      return true;
    } catch {
      return false;
    }
  }
  return (
    source.originStoreId === successor.originStoreId &&
    source.manifest.manifestSha256 === successor.manifest.manifestSha256 &&
    source.context.correlationSeed === successor.context.correlationSeed &&
    source.generation + 1 === successor.generation &&
    source.ownerStoreId === successor.custody.otherStoreId &&
    source.custody.otherStoreId === successor.ownerStoreId &&
    (source.custody.transferId === successor.custody.transferId ||
      successor.custody.state === "fenced-out" ||
      successor.custody.state === "transferred") &&
    source.context.committedEffects.every((effect) =>
      successor.context.committedEffects.some((candidate) => sha(candidate) === sha(effect)),
    ) &&
    source.effects.every((effect) => {
      const candidate = successor.effects.find((item) => item.effectId === effect.effectId);
      return (
        candidate !== undefined &&
        candidate.stage === effect.stage &&
        sha(candidate.coveredActionIds) === sha(effect.coveredActionIds) &&
        sha(candidate.actionPayloads) === sha(effect.actionPayloads) &&
        candidate.outboundBytesSha256 === effect.outboundBytesSha256 &&
        candidate.expectedBodySha256 === effect.expectedBodySha256 &&
        candidate.expectedGitLabPositionSha256 === effect.expectedGitLabPositionSha256 &&
        candidate.marker === effect.marker &&
        (effect.providerReference === null ||
          candidate.providerReference === effect.providerReference) &&
        (effect.observationSha256 === null ||
          candidate.observationSha256 === effect.observationSha256) &&
        (effect.actionReferences.length === 0 ||
          sha(candidate.actionReferences) === sha(effect.actionReferences)) &&
        (effect.state !== "confirmed" || sha(candidate) === sha(effect))
      );
    })
  );
}

/** Rebuild a record without allowing callers to supply a self-asserted digest. */
export function updateReviewDeliveryRecord(
  previous: ReviewDeliveryRecordV1,
  changes: Partial<
    Omit<
      ReviewDeliveryRecordV1,
      "kind" | "schemaVersion" | "idempotencyKey" | "manifest" | "sha256"
    >
  >,
): ReviewDeliveryRecordV1 {
  const body = {
    kind: previous.kind,
    schemaVersion: previous.schemaVersion,
    idempotencyKey: previous.idempotencyKey,
    manifest: previous.manifest,
    originStoreId: changes.originStoreId ?? previous.originStoreId,
    ownerStoreId: changes.ownerStoreId ?? previous.ownerStoreId,
    generation: changes.generation ?? previous.generation,
    custody: changes.custody ?? previous.custody,
    context: changes.context ?? previous.context,
    preparationStop:
      changes.preparationStop === undefined ? previous.preparationStop : changes.preparationStop,
    effects: changes.effects ?? previous.effects,
  };
  const next = assertReviewDeliveryRecordShape({ ...body, sha256: sha(body) });
  assertReviewDeliveryTransition(previous, next);
  return next;
}

export function assertReviewDeliveryRecordShape(value: unknown): ReviewDeliveryRecordV1 {
  kit.assertInert(value);
  const root = exact(value, [
    "kind",
    "schemaVersion",
    "idempotencyKey",
    "manifest",
    "originStoreId",
    "ownerStoreId",
    "generation",
    "custody",
    "context",
    "preparationStop",
    "effects",
    "sha256",
  ]);
  if (root.kind !== RECORD_KIND || root.schemaVersion !== 1)
    throw new ReviewDeliveryReceiptContractError("invalid-record");
  const idempotencyKey = kit.hash(root.idempotencyKey);
  const manifestRoot = exact(root.manifest, [
    "logicalDeliveryId",
    "manifestSha256",
    "idempotencyKey",
    "target",
    "targetKeySha256",
    "sourceSha256",
    "snapshotSha256",
    "reviewedHeadSha",
    "startSha",
    "artifactId",
    "originalResultSha256",
    "actor",
    "actions",
  ]);
  const manifestSha256 = kit.hash(manifestRoot.manifestSha256);
  const { manifestSha256: _manifestSha256, ...manifestBody } = manifestRoot;
  if (sha(manifestBody) !== manifestSha256 || manifestRoot.idempotencyKey !== idempotencyKey)
    throw new ReviewDeliveryReceiptContractError("invalid-record");
  const target = decodeReviewTargetV2(manifestRoot.target);
  if (kit.hash(manifestRoot.targetKeySha256) !== sha(reviewTargetKeyV2(target)))
    throw new ReviewDeliveryReceiptContractError("invalid-record");
  const actions = kit.array(manifestRoot.actions).map((candidate) => {
    const action = exact(candidate, ["actionId", "kind", "actionSha256"]);
    return {
      actionId: kit.hash(action.actionId),
      kind: kit.enumeration(action.kind, ["publish-summary", "publish-inline"] as const),
      actionSha256: kit.hash(action.actionSha256),
    };
  });
  if (!orderedUnique(actions.map((action) => action.actionId)))
    throw new ReviewDeliveryReceiptContractError("invalid-record");
  const actorRoot = exact(manifestRoot.actor, ["host", "id"]);
  const actor = { host: kit.string(actorRoot.host), id: kit.string(actorRoot.id) };
  const manifest: ReviewDeliveryManifestV1 = {
    logicalDeliveryId: kit.hash(manifestRoot.logicalDeliveryId),
    manifestSha256,
    idempotencyKey,
    target,
    targetKeySha256: kit.hash(manifestRoot.targetKeySha256),
    sourceSha256: kit.hash(manifestRoot.sourceSha256),
    snapshotSha256: kit.hash(manifestRoot.snapshotSha256),
    reviewedHeadSha: kit.revision(manifestRoot.reviewedHeadSha),
    startSha: manifestRoot.startSha === null ? null : kit.revision(manifestRoot.startSha),
    artifactId: kit.string(manifestRoot.artifactId),
    originalResultSha256: kit.hash(manifestRoot.originalResultSha256),
    actor,
    actions,
  };
  const identity = {
    domain: "docsfab-review-delivery-logical-v1",
    artifactId: manifest.artifactId,
    originalResultSha256: manifest.originalResultSha256,
    targetSha256: target.targetSha256,
    targetKeySha256: manifest.targetKeySha256,
    sourceSha256: manifest.sourceSha256,
    snapshotSha256: manifest.snapshotSha256,
    reviewedHeadSha: manifest.reviewedHeadSha,
    startSha: manifest.startSha,
    actor,
  };
  if (
    manifest.logicalDeliveryId !== sha(identity) ||
    idempotencyKey !==
      sha({
        domain: "docsfab-review-delivery-journal-v1",
        logicalDeliveryId: manifest.logicalDeliveryId,
      })
  )
    throw new ReviewDeliveryReceiptContractError("invalid-record");
  const custodyRoot = exact(root.custody, ["state", "transferId", "otherStoreId"]);
  const custody = {
    state: kit.enumeration(custodyRoot.state, [
      "active",
      "fenced-out",
      "import-pending",
      "transferred",
    ] as const),
    transferId: nullableString(custodyRoot.transferId),
    otherStoreId: custodyRoot.otherStoreId === null ? null : kit.hash(custodyRoot.otherStoreId),
  };
  const generation = root.generation as number;
  if (
    !Number.isSafeInteger(generation) ||
    generation < 0 ||
    (generation === 0 &&
      (root.ownerStoreId !== root.originStoreId || custody.state === "import-pending")) ||
    (generation > 0 && custody.transferId === null) ||
    (custody.state !== "active" &&
      (custody.transferId === null || custody.otherStoreId === null)) ||
    (custody.otherStoreId !== null && custody.otherStoreId === root.ownerStoreId) ||
    (custody.state === "active" &&
      ((generation === 0) !== (custody.transferId === null && custody.otherStoreId === null) ||
        (generation > 0 && custody.otherStoreId === null)))
  ) {
    throw new ReviewDeliveryReceiptContractError("invalid-record");
  }
  const contextRoot = exact(root.context, [
    "kind",
    "schemaVersion",
    "logicalDeliveryId",
    "correlationSeed",
    "committedEffects",
  ]);
  if (
    contextRoot.kind !== "docsfab-review-delivery-effect-context" ||
    contextRoot.schemaVersion !== 1 ||
    contextRoot.logicalDeliveryId !== manifest.logicalDeliveryId
  )
    throw new ReviewDeliveryReceiptContractError("invalid-record");
  const committedEffects = kit.array(contextRoot.committedEffects).map(committedEffect);
  if (!orderedUnique(committedEffects.map((effect) => effect.effectId)))
    throw new ReviewDeliveryReceiptContractError("invalid-record");
  const correlationSeed = kit.string(contextRoot.correlationSeed);
  const seedBytes = Buffer.from(correlationSeed, "base64url");
  if (seedBytes.length !== 32 || seedBytes.toString("base64url") !== correlationSeed)
    throw new ReviewDeliveryReceiptContractError("invalid-record");
  for (const effect of committedEffects) {
    const expectedId = sha({
      domain: "docsfab-review-effect-v1",
      logicalDeliveryId: manifest.logicalDeliveryId,
      stage: effect.stage,
      coveredActionIds: effect.coveredActionIds,
    });
    const expectedMarker = createHmac("sha256", seedBytes)
      .update(
        canonicalizeJsonEvidence([
          "docsfab-review-effect-nonce-v1",
          manifest.logicalDeliveryId,
          effect.effectId,
        ]),
      )
      .digest("base64url");
    if (effect.effectId !== expectedId || effect.marker !== expectedMarker)
      throw new ReviewDeliveryReceiptContractError("invalid-record");
  }
  const context: ReviewDeliveryEffectContextV1 = {
    kind: "docsfab-review-delivery-effect-context",
    schemaVersion: 1,
    logicalDeliveryId: manifest.logicalDeliveryId,
    correlationSeed,
    committedEffects,
  };
  const effects = kit.array(root.effects).map((candidate) => effectReceipt(candidate, manifest));
  if (!orderedUnique(effects.map((effect) => effect.effectId)))
    throw new ReviewDeliveryReceiptContractError("invalid-record");
  if (
    effects.length !== committedEffects.length ||
    effects.some((effect, index) => {
      const committed = committedEffects[index]!;
      return (
        effect.effectId !== committed.effectId ||
        effect.stage !== committed.stage ||
        sha(effect.coveredActionIds) !== sha(committed.coveredActionIds) ||
        sha(effect.actionPayloads) !== sha(committed.actionPayloads) ||
        effect.outboundBytesSha256 !== committed.outboundBytesSha256 ||
        effect.expectedBodySha256 !== committed.expectedBodySha256 ||
        effect.expectedGitLabPositionSha256 !== committed.expectedGitLabPositionSha256 ||
        effect.marker !== committed.marker
      );
    })
  )
    throw new ReviewDeliveryReceiptContractError("invalid-record");
  let preparationStop: ReviewDeliveryRecordV1["preparationStop"] = null;
  if (root.preparationStop !== null) {
    const candidate = exact(root.preparationStop, ["actionId", "code", "next", "retryAfterAt"]);
    const actionId = candidate.actionId === null ? null : kit.hash(candidate.actionId);
    if (actionId !== null && !actions.some((action) => action.actionId === actionId))
      throw new ReviewDeliveryReceiptContractError("invalid-record");
    preparationStop = {
      ...stop({ code: candidate.code, retryAfterAt: candidate.retryAfterAt }),
      actionId,
      next: kit.enumeration(candidate.next, ["retry", "replan-required"] as const),
    };
  }
  const record: ReviewDeliveryRecordV1 = {
    kind: RECORD_KIND,
    schemaVersion: 1,
    idempotencyKey,
    manifest,
    originStoreId: kit.hash(root.originStoreId),
    ownerStoreId: kit.hash(root.ownerStoreId),
    generation,
    custody,
    context,
    preparationStop,
    effects,
    sha256: kit.hash(root.sha256),
  };
  const { sha256: _recordSha256, ...body } = record;
  if (record.sha256 !== sha(body)) throw new ReviewDeliveryReceiptContractError("invalid-record");
  if (kit.canonicalJson(record) !== kit.canonicalJson(value))
    throw new ReviewDeliveryReceiptContractError("invalid-record");
  return record;
}

function committedEffect(value: unknown): ReviewDeliveryCommittedEffectV1 {
  const root = exact(value, [
    "effectId",
    "stage",
    "coveredActionIds",
    "actionPayloads",
    "outboundBytesSha256",
    "expectedBodySha256",
    "expectedGitLabPositionSha256",
    "marker",
  ]);
  const coveredActionIds = kit.array(root.coveredActionIds).map((value) => kit.hash(value));
  if (coveredActionIds.length === 0 || !orderedUnique(coveredActionIds))
    throw new ReviewDeliveryReceiptContractError("invalid-record");
  const actionPayloads = kit.array(root.actionPayloads).map((value) => {
    const payload = exact(value, ["actionId", "bodySha256", "anchorSha256"]);
    return {
      actionId: kit.hash(payload.actionId),
      bodySha256: kit.hash(payload.bodySha256),
      anchorSha256: payload.anchorSha256 === null ? null : kit.hash(payload.anchorSha256),
    };
  });
  if (sha(actionPayloads.map((payload) => payload.actionId)) !== sha(coveredActionIds))
    throw new ReviewDeliveryReceiptContractError("invalid-record");
  const stage = kit.enumeration(root.stage, STAGES);
  const expectedGitLabPositionSha256 =
    root.expectedGitLabPositionSha256 === null ? null : kit.hash(root.expectedGitLabPositionSha256);
  if ((stage === "gitlab-discussion") !== (expectedGitLabPositionSha256 !== null))
    throw new ReviewDeliveryReceiptContractError("invalid-record");
  return {
    effectId: kit.hash(root.effectId),
    stage,
    coveredActionIds,
    actionPayloads,
    outboundBytesSha256: kit.hash(root.outboundBytesSha256),
    expectedBodySha256: kit.hash(root.expectedBodySha256),
    expectedGitLabPositionSha256,
    marker: kit.string(root.marker),
  };
}

function committedFields(value: Record<string, unknown>): Record<string, unknown> {
  return kit.pick(value, [
    "effectId",
    "stage",
    "coveredActionIds",
    "actionPayloads",
    "outboundBytesSha256",
    "expectedBodySha256",
    "expectedGitLabPositionSha256",
    "marker",
  ]);
}

function effectReceipt(
  value: unknown,
  manifest: ReviewDeliveryManifestV1,
): ReviewDeliveryEffectReceiptV1 {
  const root = exact(value, [
    "effectId",
    "stage",
    "coveredActionIds",
    "actionPayloads",
    "outboundBytesSha256",
    "expectedBodySha256",
    "expectedGitLabPositionSha256",
    "marker",
    "state",
    "attemptId",
    "providerReference",
    "observationSha256",
    "actionReferences",
    "baseline",
    "stop",
  ]);
  const committed = committedEffect(committedFields(root));
  if (
    committed.coveredActionIds.some(
      (id) => !manifest.actions.some((action) => action.actionId === id),
    )
  )
    throw new ReviewDeliveryReceiptContractError("invalid-record");
  const actionReferences = kit.array(root.actionReferences).map((candidate) => {
    const item = exact(candidate, ["actionId", "nativeReference"]);
    return { actionId: kit.hash(item.actionId), nativeReference: kit.string(item.nativeReference) };
  });
  if (
    !orderedUnique(actionReferences.map((item) => item.actionId)) ||
    actionReferences.some((item) => !committed.coveredActionIds.includes(item.actionId))
  )
    throw new ReviewDeliveryReceiptContractError("invalid-record");
  let baseline: ReviewDeliveryEffectReceiptV1["baseline"] = null;
  if (root.baseline !== null) {
    const value = exact(root.baseline, ["scopeSha256", "enumerationSha256", "bodySha256"]);
    baseline = {
      scopeSha256: kit.hash(value.scopeSha256),
      enumerationSha256: kit.hash(value.enumerationSha256),
      bodySha256: kit.hash(value.bodySha256),
    };
    if (
      committed.stage !== "gitlab-note" ||
      baseline.bodySha256 !== committed.expectedBodySha256 ||
      baseline.scopeSha256 !==
        sha({
          target: manifest.target,
          actor: manifest.actor,
          effectId: committed.effectId,
          marker: committed.marker,
        })
    )
      throw new ReviewDeliveryReceiptContractError("invalid-record");
  }
  const state = kit.enumeration(root.state, EFFECT_STATES);
  if (
    (state === "accepted-pending" && committed.stage !== "github-pending-review-create") ||
    (state === "confirmed" && committed.stage === "github-pending-review-create")
  )
    throw new ReviewDeliveryReceiptContractError("invalid-record");
  const providerReference = nullableString(root.providerReference);
  const observationSha256 =
    root.observationSha256 === null ? null : kit.hash(root.observationSha256);
  if (
    (state === "confirmed" || state === "accepted-pending") &&
    (providerReference === null || observationSha256 === null)
  )
    throw new ReviewDeliveryReceiptContractError("invalid-record");
  if (state === "not-dispatched" && (providerReference !== null || observationSha256 !== null))
    throw new ReviewDeliveryReceiptContractError("invalid-record");
  if (
    ["pending", "intent"].includes(state) &&
    (providerReference !== null ||
      observationSha256 !== null ||
      actionReferences.length > 0 ||
      root.stop !== null)
  )
    throw new ReviewDeliveryReceiptContractError("invalid-record");
  if (state === "not-dispatched" && root.stop === null)
    throw new ReviewDeliveryReceiptContractError("invalid-record");
  if (["confirmed", "accepted-pending"].includes(state) && root.stop !== null)
    throw new ReviewDeliveryReceiptContractError("invalid-record");
  return {
    ...committed,
    state,
    attemptId: kit.string(root.attemptId),
    providerReference,
    observationSha256,
    actionReferences,
    baseline,
    stop: root.stop === null ? null : stop(root.stop),
  };
}

/** History-sensitive checks supplement the closed single-record shape. */
export function assertReviewDeliveryTransition(
  before: ReviewDeliveryRecordV1,
  after: ReviewDeliveryRecordV1,
): void {
  assertReviewDeliveryRecordShape(before);
  assertReviewDeliveryRecordShape(after);
  if (
    before.idempotencyKey !== after.idempotencyKey ||
    before.manifest.manifestSha256 !== after.manifest.manifestSha256 ||
    before.originStoreId !== after.originStoreId ||
    before.context.correlationSeed !== after.context.correlationSeed
  )
    throw new ReviewDeliveryReceiptContractError("identity-mismatch");
  const sameCustody =
    before.generation === after.generation &&
    before.ownerStoreId === after.ownerStoreId &&
    sha(before.custody) === sha(after.custody);
  const fenced =
    before.custody.state === "active" &&
    after.custody.state === "fenced-out" &&
    before.ownerStoreId === after.ownerStoreId &&
    before.generation === after.generation &&
    after.custody.otherStoreId !== null &&
    after.custody.transferId !== null &&
    after.custody.transferId !== before.custody.transferId;
  const acknowledged =
    before.custody.state === "fenced-out" &&
    after.custody.state === "transferred" &&
    before.ownerStoreId === after.ownerStoreId &&
    before.generation === after.generation &&
    before.custody.transferId === after.custody.transferId &&
    before.custody.otherStoreId === after.custody.otherStoreId;
  const activated =
    before.custody.state === "import-pending" &&
    after.custody.state === "active" &&
    before.ownerStoreId === after.ownerStoreId &&
    before.generation === after.generation &&
    before.custody.transferId === after.custody.transferId &&
    before.custody.otherStoreId === after.custody.otherStoreId;
  const returned =
    (before.custody.state === "fenced-out" || before.custody.state === "transferred") &&
    after.custody.state === "import-pending" &&
    before.ownerStoreId === after.ownerStoreId &&
    before.custody.otherStoreId === after.custody.otherStoreId &&
    after.custody.transferId !== before.custody.transferId &&
    before.generation <= Number.MAX_SAFE_INTEGER - 2 &&
    after.generation === before.generation + 2;
  if (!sameCustody && !fenced && !acknowledged && !activated && !returned)
    throw new ReviewDeliveryReceiptContractError("invalid-transition");
  if (
    sameCustody &&
    (before.custody.state === "fenced-out" || before.custody.state === "transferred") &&
    before.sha256 !== after.sha256
  )
    throw new ReviewDeliveryReceiptContractError("invalid-transition");
  if (
    (fenced || acknowledged || activated) &&
    (sha(before.context) !== sha(after.context) ||
      sha(before.effects) !== sha(after.effects) ||
      sha(before.preparationStop) !== sha(after.preparationStop))
  )
    throw new ReviewDeliveryReceiptContractError("invalid-transition");
  if (
    after.effects.length < before.effects.length ||
    after.effects.some((effect) => {
      if (before.effects.some((earlier) => earlier.effectId === effect.effectId)) return false;
      // The return CAS copies a later source generation. Its newly committed
      // effects may already have native references, validated by custody's
      // direct configured-source read and exact imported-lineage check.
      if (returned) return false;
      return (
        effect.state !== "intent" ||
        effect.providerReference !== null ||
        effect.observationSha256 !== null ||
        effect.actionReferences.length !== 0
      );
    }) ||
    before.effects.some((effect) => {
      const next = after.effects.find((candidate) => candidate.effectId === effect.effectId);
      if (!next) return true;
      const allowed: Record<
        ReviewDeliveryEffectReceiptV1["state"],
        readonly ReviewDeliveryEffectReceiptV1["state"][]
      > = {
        pending: ["pending", "intent"],
        intent: ["intent", "not-dispatched", "uncertain"],
        "not-dispatched": ["not-dispatched", "intent"],
        uncertain: ["uncertain", "accepted-pending", "confirmed"],
        "accepted-pending": ["accepted-pending", "confirmed"],
        confirmed: ["confirmed"],
      };
      const returnProgression: Record<
        ReviewDeliveryEffectReceiptV1["state"],
        readonly ReviewDeliveryEffectReceiptV1["state"][]
      > = {
        pending: [
          "pending",
          "intent",
          "not-dispatched",
          "uncertain",
          "accepted-pending",
          "confirmed",
        ],
        intent: ["intent", "not-dispatched", "uncertain", "accepted-pending", "confirmed"],
        "not-dispatched": [
          "not-dispatched",
          "intent",
          "uncertain",
          "accepted-pending",
          "confirmed",
        ],
        uncertain: ["uncertain", "accepted-pending", "confirmed"],
        "accepted-pending": ["accepted-pending", "confirmed"],
        confirmed: ["confirmed"],
      };
      const progressed = returned && returnProgression[effect.state].includes(next.state);
      return (
        !(
          (effect.state === "not-dispatched" && (next.state === "intent" || returned)) ||
          effect.attemptId === next.attemptId
        ) ||
        (!allowed[effect.state].includes(next.state) && !progressed) ||
        sha(committedFields(effect as unknown as Record<string, unknown>)) !==
          sha(committedFields(next as unknown as Record<string, unknown>)) ||
        (effect.baseline !== null &&
          !(effect.state === "not-dispatched" && (next.state === "intent" || returned)) &&
          sha(effect.baseline) !== sha(next.baseline)) ||
        (effect.providerReference !== null &&
          effect.providerReference !== next.providerReference) ||
        (effect.observationSha256 !== null &&
          effect.observationSha256 !== next.observationSha256) ||
        (effect.actionReferences.length > 0 &&
          sha(effect.actionReferences) !== sha(next.actionReferences)) ||
        ((effect.state === "uncertain" || effect.state === "not-dispatched") &&
          effect.state === next.state &&
          sha(effect.stop) !== sha(next.stop)) ||
        (effect.state === "confirmed" && sha(effect) !== sha(next))
      );
    })
  )
    throw new ReviewDeliveryReceiptContractError("invalid-transition");
  if (
    after.context.committedEffects.length !== after.effects.length ||
    before.context.committedEffects.some(
      (effect) =>
        sha(effect) !==
        sha(
          after.context.committedEffects.find(
            (candidate) => candidate.effectId === effect.effectId,
          ),
        ),
    )
  )
    throw new ReviewDeliveryReceiptContractError("invalid-transition");
}
