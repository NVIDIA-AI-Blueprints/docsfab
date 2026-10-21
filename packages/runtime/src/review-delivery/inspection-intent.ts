// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Private choices and bindings for opening a saved original review offline. */
import { canonicalJson } from "../content-ir/canonical.js";
import { createContractKit } from "../contract-kit/index.js";
import { DurableArtifactStore, opaqueRecordDigest } from "../artifacts/store.js";
import { validateArtifactUse } from "../artifacts/validate.js";
import type { ArtifactUse } from "../artifacts/contracts.js";
import { decodeSuccessfulReviewRunRecord } from "../delivery/run-record.js";
import type { FileRunStore } from "../records/file-store.js";
import { runRecordMaxBytes } from "../records/run-record-limit.js";
import type { RunRecord } from "../records/contracts.js";
import {
  createWorkflowOutcome,
  decodeWorkflowOutcome,
  workflowOutcomeStepEvidence,
} from "../workflow-contracts/outcome.js";
import type { WorkflowOutcomeCandidateV1 } from "../workflow-contracts/contracts.js";
import type { ReviewResult } from "../review/contracts.js";
import type {
  ReviewDeliveryPlan,
  ReviewDeliveryProviderCapabilities,
  ReviewDeliveryRequestedActions,
} from "./contracts.js";
import {
  assertReviewDeliveryRecordShape,
  createReviewDeliveryManifest,
  type ReviewDeliveryRecordV1,
} from "./receipt.js";
import { loadRetainedReviewResult } from "./result-store.js";
import { planRetainedReviewDelivery } from "./retained-plan.js";

type ReviewReceiptReader = {
  loadReview(idempotencyKey: string): Promise<ReviewDeliveryRecordV1 | undefined>;
};

export class ReviewInspectionUnavailable extends Error {
  public constructor(
    public readonly code: string,
    public readonly nextAction = "Inspect the saved run, receipt, and retained review objects before retrying.",
  ) {
    super(`Saved review inspection unavailable (${code}). ${nextAction}`);
    this.name = "ReviewInspectionUnavailable";
  }
}

const fail = (code: string): never => {
  throw new ReviewInspectionUnavailable(code);
};
const kit = createContractKit<"intent-invalid">({
  fail: () => fail("intent-invalid"),
  inertMode: "strict",
  codes: {
    invalidShape: "intent-invalid",
    invalidValue: "intent-invalid",
    digestMismatch: "intent-invalid",
    credentialMaterial: "intent-invalid",
    schemaMismatch: "intent-invalid",
  },
});

export interface ReviewInspectionIntentV1 {
  readonly kind: "docsfab-review-delivery-inspection-intent";
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly logicalDeliveryId: string;
  readonly idempotencyKey: string;
  readonly manifestSha256: string;
  readonly targetSha256: string;
  readonly resultSha256: string;
  readonly sourceSha256: string;
  readonly snapshotSha256: string;
  readonly artifactId: string;
  readonly actor: { readonly host: string; readonly id: string };
  /** Null means the caller omitted the option, retaining D1's default. */
  readonly requestedActions: ReviewDeliveryRequestedActions | null;
  readonly capabilities: ReviewDeliveryProviderCapabilities;
  readonly selections: readonly {
    readonly inventoryId: string;
    readonly presentation: "inline" | "summary" | "retained";
  }[];
  readonly actions: readonly {
    readonly actionId: string;
    readonly kind: "publish-summary" | "publish-inline";
    readonly actionSha256: string;
  }[];
}

export interface ReviewInspectionInventoryV1 {
  readonly kind: "saved-review-inventory";
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly intentObjectSha256: string;
  readonly logicalDeliveryId: string;
  readonly resultSha256: string;
  readonly sourceSha256: string;
  readonly snapshotSha256: string;
  readonly originalResult: ReviewResult;
  readonly plan: ReviewDeliveryPlan;
}

export type ReviewInspectionOutcome =
  | ReviewInspectionInventoryV1
  | {
      readonly kind: "inspection-unavailable";
      readonly schemaVersion: 1;
      readonly runId: string;
      readonly intentObjectSha256: string;
      readonly code: string;
      readonly nextAction: string;
    };

function orderedUnique(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || values[index - 1]! < value);
}

/** Strict private decoder; reference validation alone cannot authenticate this body. */
export function decodeReviewInspectionIntent(value: unknown): ReviewInspectionIntentV1 {
  kit.assertInert(value);
  const root = kit.object(value);
  kit.exact(root, [
    "kind",
    "schemaVersion",
    "runId",
    "logicalDeliveryId",
    "idempotencyKey",
    "manifestSha256",
    "targetSha256",
    "resultSha256",
    "sourceSha256",
    "snapshotSha256",
    "artifactId",
    "actor",
    "requestedActions",
    "capabilities",
    "selections",
    "actions",
  ]);
  if (root.kind !== "docsfab-review-delivery-inspection-intent" || root.schemaVersion !== 1)
    fail("intent-invalid");
  const actor = kit.object(root.actor);
  kit.exact(actor, ["host", "id"]);
  const capabilities = kit.object(root.capabilities);
  kit.exact(capabilities, ["scmProvider", "host", "summary", "inline"]);
  const requestedActions = root.requestedActions;
  if (
    requestedActions !== null &&
    requestedActions !== "overview" &&
    requestedActions !== "summary-only"
  )
    fail("intent-invalid");
  if (typeof capabilities.summary !== "boolean" || typeof capabilities.inline !== "boolean")
    fail("intent-invalid");
  const selections = kit.array(root.selections).map((value) => {
    const item = kit.object(value);
    kit.exact(item, ["inventoryId", "presentation"]);
    const inventoryId = kit.string(item.inventoryId);
    if (inventoryId.length === 0) fail("intent-invalid");
    return {
      inventoryId,
      presentation: kit.enumeration(item.presentation, ["inline", "summary", "retained"] as const),
    };
  });
  const actions = kit.array(root.actions).map((value) => {
    const item = kit.object(value);
    kit.exact(item, ["actionId", "kind", "actionSha256"]);
    return {
      actionId: kit.hash(item.actionId),
      kind: kit.enumeration(item.kind, ["publish-summary", "publish-inline"] as const),
      actionSha256: kit.hash(item.actionSha256),
    };
  });
  if (
    !orderedUnique(selections.map((item) => item.inventoryId)) ||
    !orderedUnique(actions.map((item) => item.actionId))
  )
    fail("intent-order-invalid");
  return {
    kind: "docsfab-review-delivery-inspection-intent",
    schemaVersion: 1,
    runId: kit.identifier(root.runId),
    logicalDeliveryId: kit.hash(root.logicalDeliveryId),
    idempotencyKey: kit.hash(root.idempotencyKey),
    manifestSha256: kit.hash(root.manifestSha256),
    targetSha256: kit.hash(root.targetSha256),
    resultSha256: kit.hash(root.resultSha256),
    sourceSha256: kit.hash(root.sourceSha256),
    snapshotSha256: kit.hash(root.snapshotSha256),
    artifactId: kit.identifier(root.artifactId),
    actor: { host: kit.identifier(actor.host), id: kit.identifier(actor.id) },
    requestedActions: requestedActions as ReviewDeliveryRequestedActions | null,
    capabilities: {
      scmProvider: kit.enumeration(capabilities.scmProvider, ["gitlab", "github"] as const),
      host: kit.identifier(capabilities.host),
      summary: capabilities.summary as boolean,
      inline: capabilities.inline as boolean,
    },
    selections,
    actions,
  };
}

function terminalEvaluator(run: RunRecord) {
  const matches = run.steps.filter((step) => step.id === "evaluate-document-quality");
  const step = matches[0];
  if (
    matches.length !== 1 ||
    run.steps.at(-1) !== step ||
    step?.skill !== "evaluate-document-quality" ||
    step.kind !== "evaluate" ||
    step.mode !== "read-only" ||
    step.status !== "succeeded"
  )
    fail("terminal-evaluator-missing");
  return step!;
}

function uniqueUse(run: RunRecord, kind: "review-result" | "review-delivery-intent"): ArtifactUse {
  const step = terminalEvaluator(run);
  const all = run.steps.flatMap((item) =>
    (item.artifacts ?? []).filter((use) => use.reference.kind === kind),
  );
  const root = (run.artifacts ?? []).filter((use) => use.reference.kind === kind);
  if (
    all.length !== 1 ||
    root.length !== 1 ||
    all[0] !== step.artifacts?.find((use) => use.reference.kind === kind)
  )
    fail(`${kind}-reference-not-unique`);
  const use = validateArtifactUse(all[0]);
  if (
    use.role !== "output" ||
    use.stepId !== step.id ||
    canonicalJson(use) !== canonicalJson(validateArtifactUse(root[0])) ||
    use.reference.repositoryRevision !== run.repository.revision ||
    use.reference.repositoryContentDigest !== run.reviewDeliverySnapshot?.snapshotSha256
  )
    fail(`${kind}-reference-binding-mismatch`);
  return use;
}

async function checkedReceipt(
  store: ReviewReceiptReader,
  intent: ReviewInspectionIntentV1,
): Promise<ReviewDeliveryRecordV1> {
  const rawReceipt = await store.loadReview(intent.idempotencyKey);
  const receipt =
    rawReceipt === undefined ? undefined : assertReviewDeliveryRecordShape(rawReceipt);
  if (!receipt) return fail("receipt-missing");
  assertIntentReceiptMatch(intent, receipt);
  return receipt;
}

function assertIntentReceiptMatch(
  intent: ReviewInspectionIntentV1,
  receipt: ReviewDeliveryRecordV1,
): void {
  if (
    receipt.idempotencyKey !== intent.idempotencyKey ||
    receipt.manifest.manifestSha256 !== intent.manifestSha256 ||
    receipt.manifest.logicalDeliveryId !== intent.logicalDeliveryId ||
    receipt.manifest.target.targetSha256 !== intent.targetSha256 ||
    receipt.manifest.originalResultSha256 !== intent.resultSha256 ||
    receipt.manifest.sourceSha256 !== intent.sourceSha256 ||
    receipt.manifest.snapshotSha256 !== intent.snapshotSha256 ||
    receipt.manifest.artifactId !== intent.artifactId ||
    canonicalJson(receipt.manifest.actor) !== canonicalJson(intent.actor) ||
    canonicalJson(receipt.manifest.actions) !== canonicalJson(intent.actions)
  )
    fail("receipt-binding-mismatch");
}

/** Bind one already discovered owned intent without replanning or publication authority. */
export async function inspectReviewIntentForDeletion(input: {
  readonly runStore: FileRunStore;
  readonly artifacts: DurableArtifactStore;
  readonly runId: string;
  readonly intentObjectSha256: string;
  readonly receipt?: ReviewDeliveryRecordV1;
}): Promise<ReviewInspectionIntentV1> {
  const saved = await input.runStore.getWithDigest(input.runId, { readOnly: true });
  const run = decodeSuccessfulReviewRunRecord(saved.record);
  if (run.id !== input.runId) fail("run-binding-mismatch");
  uniqueUse(run, "review-result");
  const attached =
    run.steps.some((step) =>
      (step.artifacts ?? []).some((use) => use.reference.kind === "review-delivery-intent"),
    ) || (run.artifacts ?? []).some((use) => use.reference.kind === "review-delivery-intent");
  if (
    attached &&
    uniqueUse(run, "review-delivery-intent").reference.digest !== input.intentObjectSha256
  )
    fail("intent-address-mismatch");
  const value = await input.artifacts.getRecord(input.intentObjectSha256, { readOnly: true });
  if (opaqueRecordDigest(value) !== input.intentObjectSha256) fail("intent-address-mismatch");
  const intent = decodeReviewInspectionIntent(value);
  if (
    intent.runId !== run.id ||
    intent.snapshotSha256 !== run.reviewDeliverySnapshot?.snapshotSha256 ||
    !run.changeSources?.some((source) => source.changeSourceSha256 === intent.sourceSha256)
  )
    fail("intent-run-binding-mismatch");
  if (input.receipt) {
    assertIntentReceiptMatch(intent, assertReviewDeliveryRecordShape(input.receipt));
    const loaded = await loadRetainedReviewResult({
      runStore: input.runStore,
      artifacts: input.artifacts,
      runId: run.id,
      target: input.receipt.manifest.target,
      readOnly: true,
    });
    if (
      loaded.runRecordSha256 !== saved.sha256 ||
      loaded.result.resultSha256 !== intent.resultSha256 ||
      loaded.source.source.changeSourceSha256 !== intent.sourceSha256 ||
      loaded.source.root.snapshotSha256 !== intent.snapshotSha256
    )
      fail("original-evidence-mismatch");
  }
  return intent;
}

async function inspectStrict(input: {
  readonly runStore: FileRunStore;
  readonly artifacts: DurableArtifactStore;
  readonly receiptStore: ReviewReceiptReader;
  readonly runId: string;
  readonly intentObjectSha256: string;
}): Promise<ReviewInspectionInventoryV1> {
  const saved = await input.runStore.getWithDigest(input.runId, { readOnly: true });
  const run = decodeSuccessfulReviewRunRecord(saved.record);
  if (run.id !== input.runId) fail("run-binding-mismatch");
  const use = uniqueUse(run, "review-delivery-intent");
  if (use.reference.digest !== input.intentObjectSha256) fail("intent-address-mismatch");
  const value = await input.artifacts.getRecord(input.intentObjectSha256, { readOnly: true });
  if (opaqueRecordDigest(value) !== input.intentObjectSha256) fail("intent-address-mismatch");
  const intent = decodeReviewInspectionIntent(value);
  if (
    intent.runId !== run.id ||
    intent.snapshotSha256 !== run.reviewDeliverySnapshot?.snapshotSha256
  )
    fail("intent-run-binding-mismatch");
  const receipt = await checkedReceipt(input.receiptStore, intent);
  const target = receipt.manifest.target;
  const loaded = await loadRetainedReviewResult({
    runStore: input.runStore,
    artifacts: input.artifacts,
    runId: run.id,
    target,
    readOnly: true,
  });
  if (
    loaded.runRecordSha256 !== saved.sha256 ||
    loaded.result.resultSha256 !== intent.resultSha256 ||
    loaded.source.source.changeSourceSha256 !== intent.sourceSha256
  )
    fail("original-evidence-mismatch");
  const selectionMap = new Map(
    intent.selections.map((item) => [item.inventoryId, item.presentation]),
  );
  const plan = await planRetainedReviewDelivery({
    runStore: input.runStore,
    artifacts: input.artifacts,
    runId: run.id,
    readOnly: true,
    binding: { target, source: loaded.source.source },
    delivery: {
      snapshot: loaded.source.snapshot,
      artifact: {
        kind: "retained-review-result",
        id: intent.artifactId,
        resultSha256: intent.resultSha256,
      },
      actor: intent.actor,
      capabilities: intent.capabilities,
      ...(intent.requestedActions === null ? {} : { requestedActions: intent.requestedActions }),
      extensions: {
        presentation: {
          select: (finding) => selectionMap.get(finding.inventoryId) ?? fail("selection-missing"),
        },
      },
    },
  });
  if (
    canonicalJson(plan.findings.map((item) => item.inventoryId).sort()) !==
      canonicalJson(intent.selections.map((item) => item.inventoryId)) ||
    canonicalJson(createReviewDeliveryManifest(plan)) !== canonicalJson(receipt.manifest) ||
    canonicalJson(plan.actions.map((action) => action.id).sort()) !==
      canonicalJson(intent.actions.map((action) => action.actionId))
  )
    fail("inspection-plan-mismatch");
  return {
    kind: "saved-review-inventory",
    schemaVersion: 1,
    runId: run.id,
    intentObjectSha256: input.intentObjectSha256,
    logicalDeliveryId: intent.logicalDeliveryId,
    resultSha256: intent.resultSha256,
    sourceSha256: intent.sourceSha256,
    snapshotSha256: intent.snapshotSha256,
    originalResult: loaded.result,
    plan,
  };
}

/** Read-only installed route. Missing or inconsistent evidence is a typed outcome. */
export async function inspectSavedReviewInventory(
  input: Parameters<typeof inspectStrict>[0],
): Promise<ReviewInspectionOutcome> {
  try {
    return await inspectStrict(input);
  } catch (error) {
    const unavailable =
      error instanceof ReviewInspectionUnavailable
        ? error
        : new ReviewInspectionUnavailable(
            error instanceof Error && "code" in error && typeof error.code === "string"
              ? error.code
              : "evidence-invalid",
            error instanceof Error && "code" in error && error.code === "unsafe-root"
              ? "Restore the missing or unsafe private run, artifact, or receipt store, then retry."
              : undefined,
          );
    return {
      kind: "inspection-unavailable",
      schemaVersion: 1,
      runId: input.runId,
      intentObjectSha256: input.intentObjectSha256,
      code: unavailable.code,
      nextAction: unavailable.nextAction,
    };
  }
}

/** Persist only intent; reread the object and exact saved step/root projection before returning. */
export async function retainSavedReviewInspectionIntent(input: {
  readonly runStore: FileRunStore;
  readonly artifacts: DurableArtifactStore;
  readonly receiptStore: ReviewReceiptReader;
  readonly runId: string;
  readonly plan: ReviewDeliveryPlan;
  /** Complete caller-supplied choices, including choices that did not alter a disposition. */
  readonly selections: ReviewInspectionIntentV1["selections"];
}): Promise<ReviewInspectionInventoryV1> {
  const saved = await input.runStore.getWithDigest(input.runId, { readOnly: true });
  const run = decodeSuccessfulReviewRunRecord(saved.record);
  if (run.id !== input.runId || run.reviewDeliverySnapshot === undefined)
    fail("run-binding-mismatch");
  const step = terminalEvaluator(run);
  const resultUse = uniqueUse(run, "review-result");
  if (
    run.steps.some((item) =>
      (item.artifacts ?? []).some((use) => use.reference.kind === "review-delivery-intent"),
    ) ||
    (run.artifacts ?? []).some((use) => use.reference.kind === "review-delivery-intent")
  )
    fail("intent-already-attached");
  const manifest = createReviewDeliveryManifest(input.plan);
  const intent = decodeReviewInspectionIntent({
    kind: "docsfab-review-delivery-inspection-intent",
    schemaVersion: 1,
    runId: run.id,
    logicalDeliveryId: manifest.logicalDeliveryId,
    idempotencyKey: manifest.idempotencyKey,
    manifestSha256: manifest.manifestSha256,
    targetSha256: manifest.target.targetSha256,
    resultSha256: manifest.originalResultSha256,
    sourceSha256: manifest.sourceSha256,
    snapshotSha256: manifest.snapshotSha256,
    artifactId: manifest.artifactId,
    actor: manifest.actor,
    requestedActions: input.plan.requestedActions ?? null,
    capabilities: input.plan.capabilities,
    selections: input.selections,
    actions: manifest.actions,
  });
  await checkedReceipt(input.receiptStore, intent);
  if (
    canonicalJson(input.plan.findings.map((item) => item.inventoryId).sort()) !==
    canonicalJson(intent.selections.map((item) => item.inventoryId))
  )
    fail("selection-inventory-mismatch");
  const loaded = await loadRetainedReviewResult({
    runStore: input.runStore,
    artifacts: input.artifacts,
    runId: run.id,
    target: manifest.target,
    readOnly: true,
  });
  if (
    loaded.runRecordSha256 !== saved.sha256 ||
    loaded.result.resultSha256 !== intent.resultSha256 ||
    loaded.source.source.changeSourceSha256 !== intent.sourceSha256 ||
    loaded.source.root.snapshotSha256 !== intent.snapshotSha256
  )
    fail("original-evidence-mismatch");
  const baseline = await planRetainedReviewDelivery({
    runStore: input.runStore,
    artifacts: input.artifacts,
    runId: run.id,
    binding: { target: manifest.target, source: loaded.source.source },
    delivery: {
      snapshot: loaded.source.snapshot,
      artifact: input.plan.artifact,
      actor: input.plan.actor,
      capabilities: input.plan.capabilities,
      ...(input.plan.requestedActions === undefined
        ? {}
        : { requestedActions: input.plan.requestedActions }),
      extensions: {
        presentation: {
          select: (finding) =>
            intent.selections.find((item) => item.inventoryId === finding.inventoryId)
              ?.presentation ?? fail("selection-missing"),
        },
      },
    },
    readOnly: true,
  });
  if (
    canonicalJson(baseline) !== canonicalJson(input.plan) ||
    canonicalJson(createReviewDeliveryManifest(baseline)) !== canonicalJson(manifest)
  )
    fail("original-plan-mismatch");
  const digest = opaqueRecordDigest(intent);
  await input.artifacts.putRecord(digest, intent);
  const stored = await input.artifacts.getRecord(digest, { readOnly: true });
  if (
    opaqueRecordDigest(stored) !== digest ||
    canonicalJson(decodeReviewInspectionIntent(stored)) !== canonicalJson(intent)
  )
    fail("intent-address-mismatch");
  const use = validateArtifactUse({
    role: "output",
    stepId: step.id,
    reference: {
      kind: "review-delivery-intent",
      schemaVersion: 1,
      digest,
      repositoryRevision: run.repository.revision,
      repositoryContentDigest: resultUse.reference.repositoryContentDigest,
    },
  });
  const replacement = structuredClone(run);
  const replacementStep = terminalEvaluator(replacement);
  const stepUses = replacementStep.artifacts ?? (replacementStep.artifacts = []);
  stepUses.push(use);
  const rootUses = replacement.artifacts ?? (replacement.artifacts = []);
  rootUses.push(use);
  if (run.workflowOutcome !== undefined) {
    const previous = decodeWorkflowOutcome(run.workflowOutcome, run);
    const candidate: WorkflowOutcomeCandidateV1 = {
      disposition: previous.disposition,
      findings: previous.findings,
      evidence: previous.evidence.map((item) =>
        item.kind === "step" && item.stepId === step.id
          ? workflowOutcomeStepEvidence(replacement, step.id)
          : item,
      ),
      limitations: previous.limitations,
      openDecisions: previous.openDecisions,
      producedArtifacts: [...previous.producedArtifacts, use.reference],
    };
    replacement.workflowOutcome = createWorkflowOutcome(candidate, replacement);
    decodeWorkflowOutcome(replacement.workflowOutcome, replacement);
  }
  decodeSuccessfulReviewRunRecord(replacement);
  await input.runStore.replaceIfDigest(
    run.id,
    saved.sha256,
    replacement,
    runRecordMaxBytes().value,
  );
  const reread = await input.runStore.getWithDigest(run.id, { readOnly: true });
  const verified = decodeSuccessfulReviewRunRecord(reread.record);
  if (
    canonicalJson(verified) !== canonicalJson(replacement) ||
    uniqueUse(verified, "review-delivery-intent").reference.digest !== digest
  )
    fail("saved-run-readback-mismatch");
  const inventory = await inspectStrict({ ...input, intentObjectSha256: digest });
  if (canonicalJson(inventory.plan) !== canonicalJson(input.plan))
    fail("saved-plan-readback-mismatch");
  return inventory;
}
