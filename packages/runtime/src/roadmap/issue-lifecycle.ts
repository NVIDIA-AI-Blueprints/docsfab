// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { roadmapDigest } from "./contracts/decode.js";
import {
  validateRoadmapLedger,
  type RoadmapLedger,
  type RoadmapProjectIdentity,
  type RoadmapTrackerObservation,
} from "./contracts/ledger.js";
import {
  assertRoadmapOperationStartableV2,
  createRoadmapMutationReceiptV2,
  roadmapProjectEffectProofDigestV2,
  validateRoadmapMutationAuthorizationV2,
  validateRoadmapMutationPlanV2,
  validateRoadmapMutationReceiptV2,
  type RoadmapEffectIdentity,
  type RoadmapMutationAttemptV2,
  type RoadmapMutationAuthorizationV2,
  type RoadmapMutationOperationV2,
  type RoadmapMutationPlanV2,
  type RoadmapMutationReceiptV2,
  type RoadmapMutationTargetV2,
} from "./execution-v2.js";
import {
  IssueLifecycleAdapterError,
  assertMaterialForOperation,
  issueEffectIdentity,
  issueTrackerObservation,
  localUserIssueAuthorityId,
  milestoneEffectIdentity,
  mutationMaterialBytes,
  mutationMaterialDigest,
  sanitizeFailureCode,
  validateIssueLifecycleMaterialBundle,
  type IssueLifecycleMaterialBundleV1,
  type IssueLifecycleMutationContext,
  type IssueLifecycleMutationMaterial,
  type IssueLifecycleProviderAdapter,
  type IssueTrackerIssue,
  type IssueTrackerMilestone,
} from "./issue-adapter.js";
import type { IssueLifecycleApplyLock } from "./issue-lock.js";
import { internalRecordIssueLifecycleExecution } from "./issue-lifecycle-authority-internal.js";
import { runtimeEgressRootSet } from "../config/egress-roots.js";
import { egressText } from "../security/egress.js";
import { compareText } from "../shared/primitives.js";

export interface IssueLifecyclePreflightV1 {
  schemaVersion: 1;
  kind: "docsfab-issue-lifecycle-preflight";
  provider: string;
  planDigest: string;
  ledgerDigest: string;
  project: RoadmapProjectIdentity;
  identity: { host: string; username: string; identityDigest: string; accessLevel: number };
  trackerObservedAt: string;
  observations: RoadmapTrackerObservation[];
  operations: Array<{
    operationKey: string;
    action: string;
    materialDigest: string;
    materialBytes: number;
  }>;
  status: "ready";
  digest: string;
}

export interface ApplyIssueLifecycleOptions {
  ledger: RoadmapLedger;
  plan: RoadmapMutationPlanV2;
  authorization: RoadmapMutationAuthorizationV2;
  materials: IssueLifecycleMaterialBundleV1;
  adapter: IssueLifecycleProviderAdapter;
  receipt?: RoadmapMutationReceiptV2;
  loadReceipt?: () => Promise<RoadmapMutationReceiptV2 | undefined>;
  exclusive: IssueLifecycleApplyLock;
  receiptId?: string;
  now?: () => Date;
  persistReceipt: (receipt: RoadmapMutationReceiptV2) => Promise<void>;
}

export interface IssueLifecycleApplicationResult {
  preflight: IssueLifecyclePreflightV1;
  receipt: RoadmapMutationReceiptV2;
  nextSafeAction: "none" | "retry-authorized-operation" | "reconcile-ambiguous-effect";
}

export async function preflightIssueLifecyclePlan(input: {
  ledger: RoadmapLedger;
  plan: RoadmapMutationPlanV2;
  materials: IssueLifecycleMaterialBundleV1;
  adapter: IssueLifecycleProviderAdapter;
}): Promise<IssueLifecyclePreflightV1> {
  return preflight(input, true);
}

async function preflight(
  input: {
    ledger: RoadmapLedger;
    plan: RoadmapMutationPlanV2;
    materials: IssueLifecycleMaterialBundleV1;
    adapter: IssueLifecycleProviderAdapter;
  },
  enforceLedgerSnapshot: boolean,
  selectedOperationKeys?: ReadonlySet<string>,
): Promise<IssueLifecyclePreflightV1> {
  const ledger = validateRoadmapLedger(input.ledger);
  const plan = validateRoadmapMutationPlanV2(input.plan, ledger);
  const materials = validateIssueLifecycleMaterialBundle(input.materials);
  if (materials.planDigest !== plan.digest || input.adapter.provider !== plan.project.provider) {
    throw new IssueLifecycleAdapterError("material-invalid");
  }
  const byKey = materialMap(plan, materials);
  const host = await input.adapter.preflight(plan.project);
  if (
    host.identity.provider !== plan.project.provider ||
    host.identity.host !== plan.project.host ||
    host.project.project.projectId !== plan.project.projectId ||
    host.project.project.fullPath !== plan.project.fullPath
  )
    throw new IssueLifecycleAdapterError("project-drift");
  const observations = await readTracker(input.adapter, plan.project, ledger);
  if (enforceLedgerSnapshot) assertExactTracker(ledger.tracker, observations);
  const neededLabels = new Set<string>();
  const neededMilestones = new Set<number>();
  for (const material of byKey.values()) {
    if (selectedOperationKeys && !selectedOperationKeys.has(material.operationKey)) continue;
    if (
      material.action === "add-labels" ||
      material.action === "remove-labels" ||
      material.action === "create-issue" ||
      material.action === "create-saga"
    ) {
      for (const label of material.labels) neededLabels.add(label);
    }
    if (material.action === "assign-milestone") neededMilestones.add(material.milestoneIid);
    if (
      (material.action === "create-issue" || material.action === "create-saga") &&
      material.milestoneIid !== undefined
    )
      neededMilestones.add(material.milestoneIid);
  }
  if (neededLabels.size > 0) {
    const available = new Set(await input.adapter.listLabels(plan.project));
    for (const label of neededLabels)
      if (!available.has(label)) throw new IssueLifecycleAdapterError("missing-label");
  }
  for (const iid of neededMilestones) {
    if (!(await input.adapter.getMilestone(plan.project, iid)))
      throw new IssueLifecycleAdapterError("missing-target");
  }
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-issue-lifecycle-preflight" as const,
    provider: input.adapter.provider,
    planDigest: plan.digest,
    ledgerDigest: ledger.digest,
    project: plan.project,
    identity: {
      host: host.identity.host,
      username: host.identity.username,
      identityDigest: host.identity.identityDigest,
      accessLevel: host.project.accessLevel,
    },
    trackerObservedAt: plan.trackerObservedAt,
    observations,
    operations: plan.operations
      .filter((operation) => !selectedOperationKeys || selectedOperationKeys.has(operation.key))
      .map((operation) => {
        const material = byKey.get(operation.key)!;
        return {
          operationKey: operation.key,
          action: material.action,
          materialDigest: operation.materialDigest,
          materialBytes: operation.materialBytes,
        };
      }),
    status: "ready" as const,
  };
  return freeze({ ...body, digest: roadmapDigest(body) });
}

export async function applyIssueLifecyclePlan(
  options: ApplyIssueLifecycleOptions,
): Promise<IssueLifecycleApplicationResult> {
  const ledger = validateRoadmapLedger(options.ledger);
  const plan = validateRoadmapMutationPlanV2(options.plan, ledger);
  const lockKey = roadmapDigest({
    contract: "issue-lifecycle-apply-lock-v1",
    project: plan.project,
    planDigest: plan.digest,
  });
  return options.exclusive.runExclusive(lockKey, async () => {
    const loaded = options.loadReceipt ? await options.loadReceipt() : options.receipt;
    return applyIssueLifecyclePlanUnlocked({
      ...options,
      ...(loaded ? { receipt: loaded } : {}),
      loadReceipt: undefined,
    });
  });
}

async function applyIssueLifecyclePlanUnlocked(
  options: ApplyIssueLifecycleOptions,
): Promise<IssueLifecycleApplicationResult> {
  const ledger = validateRoadmapLedger(options.ledger);
  const plan = validateRoadmapMutationPlanV2(options.plan, ledger);
  const authorization = validateRoadmapMutationAuthorizationV2(options.authorization, plan, ledger);
  const byKey = materialMap(plan, validateIssueLifecycleMaterialBundle(options.materials));
  let receipt =
    options.receipt === undefined
      ? undefined
      : validateRoadmapMutationReceiptV2(options.receipt, ledger, plan, authorization);
  const preflightRecord = await preflight(
    { ledger, plan, materials: options.materials, adapter: options.adapter },
    receipt === undefined || receipt.attempts.length === 0,
    new Set(authorization.authorizedOperationKeys),
  );
  if (
    authorization.authority.kind !== "local-user" ||
    authorization.authority.id !== `local-user:${preflightRecord.identity.identityDigest}`
  ) {
    throw new IssueLifecycleAdapterError("authorization-invalid");
  }
  const clock = options.now ?? (() => new Date());
  let attempts = [...(receipt?.attempts ?? [])];
  const createdAt = receipt?.createdAt ?? iso(clock());
  const completed = completedEffects(attempts);

  for (;;) {
    const operation = nextOperation(plan, authorization, completed);
    if (!operation) break;
    const currentOperator = await options.adapter.preflight(plan.project);
    if (
      localUserIssueAuthorityId(currentOperator.identity) !== authorization.authority.id ||
      currentOperator.project.project.projectId !== plan.project.projectId ||
      currentOperator.project.project.fullPath !== plan.project.fullPath ||
      currentOperator.project.accessLevel !== preflightRecord.identity.accessLevel
    ) {
      throw new IssueLifecycleAdapterError("authentication-revoked");
    }
    const material = byKey.get(operation.key)!;
    const prior = attempts.filter((item) => item.operationKey === operation.key).at(-1);
    const recoveringAmbiguous = prior?.disposition === "ambiguous";
    const contextState = await resolveContext(
      options.adapter,
      plan.project,
      operation,
      material,
      completed,
      ledger,
      recoveringAmbiguous ? prior.before : undefined,
      recoveringAmbiguous,
    );
    const currentTracker = await currentTrackerForStart(
      options.adapter,
      plan.project,
      ledger,
      operation,
      attempts.length === 0,
    );
    const currentDependencyEffects = await readDependencyEffects(
      options.adapter,
      plan.project,
      operation,
      completed,
    );
    const materialEvidence = {
      operationKey: operation.key,
      proposalDigest: operation.proposalDigest,
      materialDigest: mutationMaterialDigest(material),
      materialBytes: mutationMaterialBytes(material),
    };

    if (prior?.disposition === "ambiguous") {
      assertAuthority(plan, authorization, operation, material, clock());
      await assertUnrelatedPreconditionsCurrent(
        options.adapter,
        plan.project,
        operation,
        completed,
        ledger,
      );
      const startedAt = iso(clock());
      const reconciliation = await options.adapter.reconcile(
        context(
          plan.project,
          operation,
          material,
          contextState,
          preflightRecord.identity.identityDigest,
          preflightRecord.identity.accessLevel,
        ),
      );
      const completedAt = iso(clock());
      if (reconciliation.disposition === "ambiguous") {
        return result(preflightRecord, receipt!, ledger, plan, authorization);
      }
      const expectedAfter = ambiguousExpectedDigest(prior.failureCode);
      if (
        reconciliation.disposition === "found" &&
        expectedAfter &&
        (!contextState.targetIssue ||
          targetMaterialStateDigest(contextState.targetIssue) !== expectedAfter)
      ) {
        throw new IssueLifecycleAdapterError("tracker-drift");
      }
      if (reconciliation.disposition === "absent" && !sameAsBefore(contextState, prior.before)) {
        throw new IssueLifecycleAdapterError("tracker-drift");
      }
      attempts.push({
        operationKey: operation.key,
        attempt: prior.attempt + 1,
        idempotencyKey: operation.idempotencyKey,
        phase: "reconciliation",
        disposition: reconciliation.disposition === "found" ? "reused" : "failed",
        startedAt,
        completedAt,
        ...(contextState.before ? { before: contextState.before } : {}),
        ...(reconciliation.disposition === "found"
          ? { effect: reconciliation.effect }
          : { failureCode: "effect-confirmed-absent" }),
        reconcilesAttempt: prior.attempt,
      });
      receipt = buildReceipt(
        options,
        ledger,
        plan,
        authorization,
        attempts,
        createdAt,
        completedAt,
      );
      await options.persistReceipt(receipt);
      if (reconciliation.disposition === "found") {
        completed.set(operation.key, reconciliation.effect);
        continue;
      }
    }

    assertRoadmapOperationStartableV2({
      ledger,
      plan,
      authorization,
      operationKey: operation.key,
      now: clock(),
      currentTracker,
      currentDependencyEffects,
      material: materialEvidence,
      ...(receipt ? { receipt } : {}),
    });
    const startedAt = iso(clock());
    let attempt: RoadmapMutationAttemptV2;
    let writeAheadStarted = false;
    try {
      const reconciliation = await options.adapter.reconcile(
        context(
          plan.project,
          operation,
          material,
          contextState,
          preflightRecord.identity.identityDigest,
          preflightRecord.identity.accessLevel,
        ),
      );
      if (reconciliation.disposition === "found") {
        attempt = mutationAttempt(
          operation,
          attempts,
          startedAt,
          iso(clock()),
          contextState.before,
          "reused",
          reconciliation.effect,
        );
      } else if (reconciliation.disposition === "ambiguous") {
        attempt = mutationAttempt(
          operation,
          attempts,
          startedAt,
          iso(clock()),
          contextState.before,
          "ambiguous",
          undefined,
          reconciliation.failureCode,
        );
      } else {
        const expectedAfter = contextState.targetIssue
          ? expectedTargetMaterialStateDigest(contextState.targetIssue, material)
          : undefined;
        const pending = mutationAttempt(
          operation,
          attempts,
          startedAt,
          iso(clock()),
          contextState.before,
          "ambiguous",
          undefined,
          expectedAfter ? `ambiguous-effect:${expectedAfter}` : "ambiguous-effect",
        );
        attempts.push(pending);
        writeAheadStarted = true;
        receipt = buildReceipt(
          options,
          ledger,
          plan,
          authorization,
          attempts,
          createdAt,
          pending.completedAt,
        );
        await options.persistReceipt(receipt);
        let effect: RoadmapEffectIdentity;
        try {
          effect = await options.adapter.mutate(
            context(
              plan.project,
              operation,
              material,
              contextState,
              preflightRecord.identity.identityDigest,
              preflightRecord.identity.accessLevel,
              () => {
                assertAuthority(plan, authorization, operation, material, clock());
              },
            ),
          );
        } catch {
          return result(preflightRecord, receipt, ledger, plan, authorization);
        }
        const confirmation: RoadmapMutationAttemptV2 = {
          operationKey: operation.key,
          attempt: pending.attempt + 1,
          idempotencyKey: operation.idempotencyKey,
          phase: "reconciliation",
          disposition: "reused",
          startedAt: iso(clock()),
          completedAt: iso(clock()),
          ...(contextState.before ? { before: contextState.before } : {}),
          effect,
          reconcilesAttempt: pending.attempt,
        };
        attempts.push(confirmation);
        receipt = buildReceipt(
          options,
          ledger,
          plan,
          authorization,
          attempts,
          createdAt,
          confirmation.completedAt,
        );
        await options.persistReceipt(receipt);
        completed.set(operation.key, effect);
        continue;
      }
    } catch (error) {
      if (writeAheadStarted) throw error;
      const code = sanitizeFailureCode(error);
      const failureCode =
        code === "ambiguous-effect" && contextState.targetIssue
          ? `ambiguous-effect:${expectedTargetMaterialStateDigest(contextState.targetIssue, material)}`
          : code;
      attempt = mutationAttempt(
        operation,
        attempts,
        startedAt,
        iso(clock()),
        contextState.before,
        code === "ambiguous-effect" ? "ambiguous" : "failed",
        undefined,
        failureCode,
      );
    }
    attempts.push(attempt);
    receipt = buildReceipt(
      options,
      ledger,
      plan,
      authorization,
      attempts,
      createdAt,
      attempt.completedAt,
    );
    await options.persistReceipt(receipt);
    if (attempt.disposition === "succeeded" || attempt.disposition === "reused") {
      completed.set(operation.key, attempt.effect!);
      continue;
    }
    return result(preflightRecord, receipt, ledger, plan, authorization);
  }
  if (!receipt) throw new IssueLifecycleAdapterError("authorization-invalid");
  return result(preflightRecord, receipt, ledger, plan, authorization);
}

function materialMap(
  plan: RoadmapMutationPlanV2,
  bundle: IssueLifecycleMaterialBundleV1,
): Map<string, IssueLifecycleMutationMaterial> {
  if (bundle.planDigest !== plan.digest || bundle.operations.length !== plan.operations.length) {
    throw new IssueLifecycleAdapterError("material-invalid");
  }
  const result = new Map(bundle.operations.map((item) => [item.operationKey, item]));
  for (const operation of plan.operations) {
    const material = result.get(operation.key);
    if (!material) throw new IssueLifecycleAdapterError("material-invalid");
    assertMaterialForOperation(operation, material);
  }
  return result;
}

async function readTracker(
  adapter: IssueLifecycleProviderAdapter,
  project: RoadmapProjectIdentity,
  ledger: RoadmapLedger,
): Promise<RoadmapTrackerObservation[]> {
  const result: RoadmapTrackerObservation[] = [];
  for (const observed of ledger.tracker) {
    const current = await adapter.getIssue(project, observed.issueIid);
    if (!current) throw new IssueLifecycleAdapterError("missing-target");
    result.push(issueTrackerObservation(current));
  }
  return result.sort((a, b) => a.issueIid - b.issueIid);
}

function assertExactTracker(
  expected: RoadmapTrackerObservation[],
  current: RoadmapTrackerObservation[],
): void {
  const left = [...expected].sort((a, b) => a.issueIid - b.issueIid);
  if (roadmapDigest(left) !== roadmapDigest(current))
    throw new IssueLifecycleAdapterError("tracker-drift");
}

function nextOperation(
  plan: RoadmapMutationPlanV2,
  authorization: RoadmapMutationAuthorizationV2,
  completed: Map<string, RoadmapEffectIdentity>,
): RoadmapMutationOperationV2 | undefined {
  return plan.operations.find(
    (item) =>
      authorization.authorizedOperationKeys.includes(item.key) &&
      !completed.has(item.key) &&
      item.dependsOnOperationKeys.every((key) => completed.has(key)),
  );
}

function completedEffects(
  attempts: RoadmapMutationAttemptV2[],
): Map<string, RoadmapEffectIdentity> {
  const result = new Map<string, RoadmapEffectIdentity>();
  for (const item of attempts)
    if ((item.disposition === "succeeded" || item.disposition === "reused") && item.effect) {
      result.set(item.operationKey, item.effect);
    }
  return result;
}

interface ResolvedContext {
  targetIssue?: IssueTrackerIssue;
  relatedIssue?: IssueTrackerIssue;
  targetMilestone?: IssueTrackerMilestone;
  before?: RoadmapEffectIdentity;
  operationProofDigest?: string;
}

async function resolveContext(
  adapter: IssueLifecycleProviderAdapter,
  project: RoadmapProjectIdentity,
  operation: RoadmapMutationOperationV2,
  material: IssueLifecycleMutationMaterial,
  completed: Map<string, RoadmapEffectIdentity>,
  ledger: RoadmapLedger,
  receiptBefore?: RoadmapEffectIdentity,
  allowTargetDrift = false,
): Promise<ResolvedContext> {
  const target = await resolveTarget(adapter, project, operation.target, completed);
  const related = operation.relatedTarget
    ? await resolveTarget(adapter, project, operation.relatedTarget, completed)
    : undefined;
  const targetIssue = target?.kind === "issue" ? target.value : undefined;
  const relatedIssue = related?.kind === "issue" ? related.value : undefined;
  const targetMilestone = related?.kind === "milestone" ? related.value : undefined;
  const materialMilestone =
    (material.action === "create-issue" || material.action === "create-saga") &&
    material.milestoneIid !== undefined
      ? await adapter.getMilestone(project, material.milestoneIid)
      : undefined;
  if (operation.target.source !== "project" && !targetIssue)
    throw new IssueLifecycleAdapterError("missing-target");
  if (operation.kind === "link" && !relatedIssue)
    throw new IssueLifecycleAdapterError("missing-target");
  if (material.action === "assign-milestone" && targetMilestone?.iid !== material.milestoneIid) {
    throw new IssueLifecycleAdapterError("material-invalid");
  }
  const currentBefore = targetIssue
    ? issueEffectIdentity(
        targetIssue,
        operation.target.source === "dependency-result"
          ? completed.get(operation.target.operationKey)?.operationProofDigest
          : undefined,
      )
    : undefined;
  const before = allowTargetDrift ? receiptBefore : currentBefore;
  if (operation.target.source === "ledger-observation") {
    const targetKey = operation.target.targetKey;
    const observed = ledger.tracker.find((item) => `issue:${item.issueIid}` === targetKey);
    if (
      !observed ||
      (!allowTargetDrift &&
        (before?.identityDigest !== observed.identityDigest ||
          before.updatedAt !== observed.updatedAt ||
          before.state !== observed.state))
    ) {
      throw new IssueLifecycleAdapterError("tracker-drift");
    }
  }
  return {
    ...(targetIssue ? { targetIssue } : {}),
    ...(relatedIssue ? { relatedIssue } : {}),
    ...((targetMilestone ?? materialMilestone)
      ? { targetMilestone: targetMilestone ?? materialMilestone }
      : {}),
    ...(before ? { before } : {}),
    ...(operation.target.source === "project"
      ? { operationProofDigest: roadmapProjectEffectProofDigestV2(operation) }
      : {}),
  };
}

async function assertUnrelatedPreconditionsCurrent(
  adapter: IssueLifecycleProviderAdapter,
  project: RoadmapProjectIdentity,
  operation: RoadmapMutationOperationV2,
  completed: Map<string, RoadmapEffectIdentity>,
  ledger: RoadmapLedger,
): Promise<void> {
  for (const precondition of operation.preconditions) {
    const isTarget =
      operation.target.source === "ledger-observation" &&
      precondition.source === "ledger-observation"
        ? operation.target.targetKey === precondition.targetKey
        : operation.target.source === "dependency-result" &&
          precondition.source === "dependency-result" &&
          operation.target.operationKey === precondition.operationKey;
    if (isTarget) continue;
    if (precondition.source === "ledger-observation") {
      const iid = Number(precondition.targetKey.slice("issue:".length));
      const expected = ledger.tracker.find((item) => item.issueIid === iid);
      const current = await adapter.getIssue(project, iid);
      if (
        !expected ||
        !current ||
        current.state !== expected.state ||
        current.updatedAt !== expected.updatedAt ||
        current.identityDigest !== expected.identityDigest
      )
        throw new IssueLifecycleAdapterError("tracker-drift");
    } else {
      const expected = completed.get(precondition.operationKey);
      if (!expected) throw new IssueLifecycleAdapterError("tracker-drift");
      const current = await currentEffect(adapter, project, expected);
      if (roadmapDigest(current) !== roadmapDigest(expected))
        throw new IssueLifecycleAdapterError("tracker-drift");
    }
  }
}

async function currentEffect(
  adapter: IssueLifecycleProviderAdapter,
  project: RoadmapProjectIdentity,
  expected: RoadmapEffectIdentity,
): Promise<RoadmapEffectIdentity> {
  if (expected.kind === "issue") {
    const value = await adapter.getIssue(
      project,
      Number(expected.targetKey.slice("issue:".length)),
    );
    if (!value) throw new IssueLifecycleAdapterError("missing-target");
    return issueEffectIdentity(value, expected.operationProofDigest);
  }
  if (expected.kind === "milestone") {
    const value = await adapter.getMilestone(
      project,
      Number(expected.targetKey.slice("milestone:".length)),
    );
    if (!value) throw new IssueLifecycleAdapterError("missing-target");
    return milestoneEffectIdentity(value, expected.operationProofDigest);
  }
  throw new IssueLifecycleAdapterError("tracker-drift");
}

function sameAsBefore(state: ResolvedContext, before: RoadmapEffectIdentity | undefined): boolean {
  if (before === undefined) return state.targetIssue === undefined;
  if (before.kind !== "issue" || !state.targetIssue) return false;
  return (
    roadmapDigest(issueEffectIdentity(state.targetIssue, before.operationProofDigest)) ===
    roadmapDigest(before)
  );
}

function ambiguousExpectedDigest(failureCode: string | undefined): string | undefined {
  const match = /^ambiguous-effect:([a-f0-9]{64})$/u.exec(failureCode ?? "");
  return match?.[1];
}

function expectedTargetMaterialStateDigest(
  issue: IssueTrackerIssue,
  material: IssueLifecycleMutationMaterial,
): string {
  const next: IssueTrackerIssue = {
    ...issue,
    ...(material.action === "update-title"
      ? { titleDigest: trackerTextDigest(publishedTrackerText(material.title)) }
      : {}),
    ...(material.action === "update-description"
      ? { descriptionDigest: trackerTextDigest(publishedTrackerText(material.description)) }
      : {}),
    ...(material.action === "add-labels"
      ? { labels: [...new Set([...issue.labels, ...material.labels])].sort(compareText) }
      : {}),
    ...(material.action === "remove-labels"
      ? {
          labels: issue.labels
            .filter((label) => !material.labels.includes(label))
            .sort(compareText),
        }
      : {}),
    ...(material.action === "assign-milestone" ? { milestoneIid: material.milestoneIid } : {}),
    ...(material.action === "close" ? { state: "closed" as const } : {}),
    ...(material.action === "reopen" ? { state: "opened" as const } : {}),
  };
  return targetMaterialStateDigest(next);
}

function targetMaterialStateDigest(issue: IssueTrackerIssue): string {
  return roadmapDigest({
    contract: "issue-lifecycle-target-material-state-v1",
    iid: issue.iid,
    titleDigest: issue.titleDigest,
    descriptionDigest: issue.descriptionDigest,
    state: issue.state,
    labels: [...issue.labels].sort(compareText),
    ...(issue.milestoneIid === undefined ? {} : { milestoneIid: issue.milestoneIid }),
  });
}

/**
 * The text as the tracker stores it: the provider adapter publishes through
 * egress, so the expected state digests the same projection. A refusal keeps the
 * raw text, since the adapter then refuses before any write.
 */
function publishedTrackerText(value: string): string {
  const projected = egressText(value, runtimeEgressRootSet());
  return projected.ok ? projected.text : value;
}

function trackerTextDigest(value: string): string {
  return roadmapDigest({ contract: "issue-tracker-text-v1", value });
}

async function resolveTarget(
  adapter: IssueLifecycleProviderAdapter,
  project: RoadmapProjectIdentity,
  target: RoadmapMutationTargetV2,
  completed: Map<string, RoadmapEffectIdentity>,
): Promise<
  | { kind: "issue"; value: IssueTrackerIssue }
  | { kind: "milestone"; value: IssueTrackerMilestone }
  | undefined
> {
  if (target.source === "project") return undefined;
  const effect =
    target.source === "ledger-observation" ? undefined : completed.get(target.operationKey);
  const targetKey = target.source === "ledger-observation" ? target.targetKey : effect?.targetKey;
  if (!targetKey) throw new IssueLifecycleAdapterError("missing-target");
  const issueMatch = /^issue:(\d+)$/u.exec(targetKey);
  if (issueMatch) {
    const value = await adapter.getIssue(project, Number(issueMatch[1]));
    return value ? { kind: "issue", value } : undefined;
  }
  const milestoneMatch = /^milestone:(\d+)$/u.exec(targetKey);
  if (milestoneMatch) {
    const value = await adapter.getMilestone(project, Number(milestoneMatch[1]));
    return value ? { kind: "milestone", value } : undefined;
  }
  throw new IssueLifecycleAdapterError("missing-target");
}

async function currentTrackerForStart(
  adapter: IssueLifecycleProviderAdapter,
  project: RoadmapProjectIdentity,
  ledger: RoadmapLedger,
  operation: RoadmapMutationOperationV2,
  first: boolean,
): Promise<RoadmapTrackerObservation[]> {
  if (first) return readTracker(adapter, project, ledger);
  const iids = operation.preconditions
    .filter((item) => item.source === "ledger-observation")
    .map((item) => Number(item.targetKey.slice("issue:".length)));
  const result: RoadmapTrackerObservation[] = [];
  for (const iid of iids) {
    const issue = await adapter.getIssue(project, iid);
    if (!issue) throw new IssueLifecycleAdapterError("missing-target");
    result.push(issueTrackerObservation(issue));
  }
  return result;
}

async function readDependencyEffects(
  adapter: IssueLifecycleProviderAdapter,
  project: RoadmapProjectIdentity,
  operation: RoadmapMutationOperationV2,
  completed: Map<string, RoadmapEffectIdentity>,
): Promise<RoadmapEffectIdentity[]> {
  const result: RoadmapEffectIdentity[] = [];
  for (const precondition of operation.preconditions) {
    if (precondition.source !== "dependency-result") continue;
    const effect = completed.get(precondition.operationKey);
    if (!effect) throw new IssueLifecycleAdapterError("missing-target");
    if (effect.kind === "issue") {
      const value = await adapter.getIssue(project, Number(effect.externalId));
      if (!value) throw new IssueLifecycleAdapterError("missing-target");
      result.push(issueEffectIdentity(value, effect.operationProofDigest));
    } else if (effect.kind === "milestone") {
      const iid = Number(effect.targetKey.slice("milestone:".length));
      const value = await adapter.getMilestone(project, iid);
      if (!value) throw new IssueLifecycleAdapterError("missing-target");
      result.push(milestoneEffectIdentity(value, effect.operationProofDigest));
    }
  }
  return result;
}

function context(
  project: RoadmapProjectIdentity,
  operation: RoadmapMutationOperationV2,
  material: IssueLifecycleMutationMaterial,
  state: ResolvedContext,
  operatorIdentityDigest: string,
  expectedAccessLevel: number,
  assertAuthorized = (): void => {},
): IssueLifecycleMutationContext {
  return {
    project,
    operation,
    material,
    ...state,
    operatorIdentityDigest,
    expectedAccessLevel,
    assertAuthorized,
  };
}

function assertAuthority(
  plan: RoadmapMutationPlanV2,
  authorization: RoadmapMutationAuthorizationV2,
  operation: RoadmapMutationOperationV2,
  material: IssueLifecycleMutationMaterial,
  now: Date,
): void {
  if (
    authorization.planDigest !== plan.digest ||
    !authorization.authorizedOperationKeys.includes(operation.key) ||
    now.valueOf() < Date.parse(authorization.issuedAt) ||
    now.valueOf() > Date.parse(authorization.expiresAt)
  ) {
    throw new IssueLifecycleAdapterError(
      now.valueOf() > Date.parse(authorization.expiresAt)
        ? "authorization-expired"
        : "authorization-invalid",
    );
  }
  assertMaterialForOperation(operation, material);
}

function mutationAttempt(
  operation: RoadmapMutationOperationV2,
  attempts: RoadmapMutationAttemptV2[],
  startedAt: string,
  completedAt: string,
  before: RoadmapEffectIdentity | undefined,
  disposition: RoadmapMutationAttemptV2["disposition"],
  effect?: RoadmapEffectIdentity,
  failureCode?: string,
): RoadmapMutationAttemptV2 {
  return {
    operationKey: operation.key,
    attempt: attempts.filter((item) => item.operationKey === operation.key).length + 1,
    idempotencyKey: operation.idempotencyKey,
    phase: "mutation",
    disposition,
    startedAt,
    completedAt,
    ...(before ? { before } : {}),
    ...(effect ? { effect } : {}),
    ...(failureCode ? { failureCode } : {}),
  };
}

function buildReceipt(
  options: ApplyIssueLifecycleOptions,
  ledger: RoadmapLedger,
  plan: RoadmapMutationPlanV2,
  authorization: RoadmapMutationAuthorizationV2,
  attempts: RoadmapMutationAttemptV2[],
  createdAt: string,
  updatedAt: string,
): RoadmapMutationReceiptV2 {
  return createRoadmapMutationReceiptV2(
    {
      id: options.receiptId ?? options.receipt?.id ?? `${plan.id}-gitlab`,
      attempts,
      createdAt,
      updatedAt,
    },
    ledger,
    plan,
    authorization,
  );
}

function result(
  preflight: IssueLifecyclePreflightV1,
  receipt: RoadmapMutationReceiptV2,
  ledger: RoadmapLedger,
  plan: RoadmapMutationPlanV2,
  authorization: RoadmapMutationAuthorizationV2,
): IssueLifecycleApplicationResult {
  internalRecordIssueLifecycleExecution(preflight, ledger, plan, authorization, receipt);
  return {
    preflight,
    receipt,
    nextSafeAction:
      receipt.terminal === "complete"
        ? "none"
        : receipt.terminal === "ambiguous"
          ? "reconcile-ambiguous-effect"
          : "retry-authorized-operation",
  };
}

function iso(value: Date): string {
  if (Number.isNaN(value.valueOf())) throw new IssueLifecycleAdapterError("authorization-invalid");
  return value.toISOString();
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
  }
  return value;
}
