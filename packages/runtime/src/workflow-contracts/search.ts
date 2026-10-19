// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { REPOSITORY_INVENTORY_MAX_ENTRIES_LIMIT } from "../config/repository-inventory-limit.js";
import { createContractKit, deepFreeze, type ContractFail } from "../contract-kit/index.js";
import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../json-evidence.js";
import type { RepositoryTarget } from "../repository/contracts.js";
import {
  createSearchTarget,
  decodeBoundedSearchEvidence,
  serializeBoundedSearchEvidence,
  type SearchRepositoryBindingV1,
  type SearchTargetV1,
} from "../search/bounded-search-contracts.js";
import {
  decodeSearchProgressEvidence,
  serializeSearchProgressEvidence,
} from "../search/progress-contracts.js";
import { findConfiguredCredentialInValue } from "../security/configured-credentials.js";
import type {
  WorkflowSearchCoordinatorResultV1,
  WorkflowSearchPlanV1,
  WorkflowSearchResultV1,
  WorkflowSearchStepEvidenceV1,
} from "./contracts.js";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

export class WorkflowSearchEvidenceError extends Error {
  public readonly code:
    | "invalid-plan"
    | "invalid-result"
    | "target-mismatch"
    | "evidence-mismatch"
    | "unfinished-search";
  public constructor(
    code:
      | "invalid-plan"
      | "invalid-result"
      | "target-mismatch"
      | "evidence-mismatch"
      | "unfinished-search",
  ) {
    super(`Workflow search evidence rejected: ${code}.`);
    this.code = code;
    this.name = "WorkflowSearchEvidenceError";
  }
}

function fail(code: WorkflowSearchEvidenceError["code"]): never {
  throw new WorkflowSearchEvidenceError(code);
}

type SearchInertCode = "invalid-plan" | "invalid-result";
type SearchContractKit = ReturnType<typeof createContractKit<SearchInertCode>>;
const searchKits = new Map<string, SearchContractKit>();

/**
 * `inventorySized` kits walk a value that embeds a whole repository
 * inventory, whose size `repository.inventoryMaxEntries` governs where it is
 * built: they keep the inertness, depth, and string checks and apply no node
 * or array ceiling (#1927). Every other walk keeps the generic ceilings.
 */
function kitFor(code: SearchInertCode, inventorySized = false): SearchContractKit {
  const key = `${code}:${inventorySized}`;
  const existing = searchKits.get(key);
  if (existing) return existing;
  const created = createContractKit({
    fail: fail as ContractFail<SearchInertCode>,
    inertMode: "strict",
    ...(inventorySized ? { sizeGovernedBy: REPOSITORY_INVENTORY_MAX_ENTRIES_LIMIT } : {}),
    codes: {
      invalidShape: code,
      invalidValue: code,
      digestMismatch: code,
      credentialMaterial: code,
      schemaMismatch: code,
    },
  });
  searchKits.set(key, created);
  return created;
}

const assertInertPlainData = (value: unknown, code: SearchInertCode): void => {
  kitFor(code).assertInert(value);
};

export function instantiateWorkflowSearchTargets(
  planValue: WorkflowSearchPlanV1,
  repositoryValue: SearchRepositoryBindingV1,
): readonly SearchTargetV1[] {
  assertInertPlainData(planValue, "invalid-plan");
  assertInertPlainData(repositoryValue, "invalid-result");
  const plan = validateWorkflowSearchPlan(planValue);
  const repository = repositoryBinding(repositoryValue);
  return Object.freeze(
    plan.targets.map((declaration) =>
      createSearchTarget(
        declaration.targetType === "artifact-existence"
          ? {
              id: declaration.id,
              targetKey: declaration.targetKey,
              targetType: declaration.targetType,
              repository,
              subjectSha256: digest(declaration.question),
              artifactClass: declaration.artifactClass,
              requiredProbes: declaration.requiredProbes,
            }
          : {
              id: declaration.id,
              targetKey: declaration.targetKey,
              targetType: declaration.targetType,
              repository,
              subjectSha256: digest(declaration.question),
              requiredProbes: declaration.requiredProbes,
              rubric: declaration.rubric,
            },
      ),
    ),
  );
}

export function defaultWorkspaceSnapshotSha256(revision: string): string {
  return digest({
    kind: "docsfab-default-workspace-snapshot",
    revision,
  });
}

export function normalizeWorkflowSearchEvidence(input: {
  plan: WorkflowSearchPlanV1;
  repository: RepositoryTarget;
  repositoryIdentitySha256: string;
  searches: readonly WorkflowSearchResultV1[];
  workspaceSnapshotSha256?: string;
}): WorkflowSearchStepEvidenceV1 {
  assertInertPlainData(input, "invalid-result");
  const plan = validateWorkflowSearchPlan(input.plan);
  const targets = instantiateWorkflowSearchTargets(plan, {
    identitySha256: input.repositoryIdentitySha256,
    revision: input.repository.revision,
  });
  if (!Array.isArray(input.searches) || input.searches.length !== targets.length) {
    fail("invalid-result");
  }
  const supplied = new Map<string, WorkflowSearchResultV1>();
  for (const raw of input.searches) {
    if (
      !plainObject(raw) ||
      Object.keys(raw).sort().join(",") !== "bounded,progress,targetId" ||
      typeof raw.targetId !== "string" ||
      supplied.has(raw.targetId)
    ) {
      fail("invalid-result");
    }
    supplied.set(raw.targetId, raw as unknown as WorkflowSearchResultV1);
  }
  const searches = targets.map((target) => {
    const raw = supplied.get(target.id);
    if (!raw) fail("invalid-result");
    const bounded = decodeBoundedSearchEvidence(raw.bounded);
    const progress = decodeSearchProgressEvidence(raw.progress);
    if (
      canonical(bounded.target) !== canonical(target) ||
      canonical(progress.target) !== canonical(target)
    ) {
      fail("target-mismatch");
    }
    if (
      serializeBoundedSearchEvidence(bounded) === "" ||
      serializeSearchProgressEvidence(progress) === "" ||
      canonical(bounded.probes) !== canonical(progress.probes) ||
      canonical(bounded.limitations) !== canonical(progress.limitations) ||
      bounded.confidence.disposition !== progress.recommendation.disposition ||
      canonical(bounded.confidence.saturation) !== canonical(progress.recommendation.saturation)
    ) {
      fail("evidence-mismatch");
    }
    // A productive checkpoint is a request for another bounded lease, not a
    // final workflow result. Resume remains entirely inside the coordinator.
    if (
      progress.recommendation.recommendation !== "stop" ||
      progress.recommendation.disposition === "search-still-productive"
    ) {
      fail("unfinished-search");
    }
    return { targetId: target.id, bounded, progress };
  });
  const workspaceSnapshotSha256 =
    input.workspaceSnapshotSha256 ?? defaultWorkspaceSnapshotSha256(input.repository.revision);
  if (!SHA256.test(workspaceSnapshotSha256)) fail("invalid-result");
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-workflow-search-evidence" as const,
    planId: plan.id,
    planVersion: plan.version,
    workspaceSnapshotSha256,
    searches,
  };
  return deepFreeze({ ...body, evidenceSha256: digest(body) });
}

export function decodeWorkflowSearchEvidence(
  value: unknown,
  plan: WorkflowSearchPlanV1,
  repository: RepositoryTarget,
): WorkflowSearchStepEvidenceV1 {
  assertInertPlainData(value, "invalid-result");
  assertInertPlainData(plan, "invalid-plan");
  assertInertPlainData(repository, "invalid-result");
  if (
    !plainObject(value) ||
    Object.keys(value).sort().join(",") !==
      "evidenceSha256,kind,planId,planVersion,schemaVersion,searches,workspaceSnapshotSha256" ||
    value.schemaVersion !== 1 ||
    value.kind !== "docsfab-workflow-search-evidence" ||
    value.planId !== plan.id ||
    value.planVersion !== plan.version ||
    !Array.isArray(value.searches) ||
    value.searches.length === 0
  ) {
    fail("invalid-result");
  }
  const first = value.searches[0];
  if (
    !plainObject(first) ||
    !plainObject(first.bounded) ||
    !plainObject(first.bounded.target) ||
    !plainObject(first.bounded.target.repository) ||
    typeof first.bounded.target.repository.identitySha256 !== "string"
  ) {
    fail("invalid-result");
  }
  const normalized = normalizeWorkflowSearchEvidence({
    plan,
    repository,
    repositoryIdentitySha256: first.bounded.target.repository.identitySha256,
    searches: value.searches as unknown as WorkflowSearchResultV1[],
    ...(typeof value.workspaceSnapshotSha256 === "string"
      ? { workspaceSnapshotSha256: value.workspaceSnapshotSha256 }
      : {}),
  });
  if (canonical(value) !== canonical(normalized)) fail("invalid-result");
  return normalized;
}

export function validateWorkflowSearchPlan(value: WorkflowSearchPlanV1): WorkflowSearchPlanV1 {
  assertInertPlainData(value, "invalid-plan");
  if (
    findConfiguredCredentialInValue(value) !== null ||
    !plainObject(value) ||
    Object.keys(value).sort().join(",") !== "id,schemaVersion,targets,version" ||
    value.schemaVersion !== 1 ||
    !safeId(value.id) ||
    !safeVersion(value.version) ||
    !Array.isArray(value.targets) ||
    value.targets.length === 0
  ) {
    fail("invalid-plan");
  }
  const ids = new Set<string>();
  const keys = new Set<string>();
  for (const target of value.targets) {
    if (
      !plainObject(target) ||
      Object.keys(target).sort().join(",") !==
        (target.targetType === "artifact-existence"
          ? "artifactClass,id,question,requiredProbes,targetKey,targetType"
          : "id,question,requiredProbes,rubric,targetKey,targetType") ||
      !safeId(target.id) ||
      !safeId(target.targetKey) ||
      ids.has(target.id) ||
      keys.has(target.targetKey) ||
      typeof target.question !== "string" ||
      target.question.length === 0 ||
      target.question.length > 2_000 ||
      target.question.trim() !== target.question ||
      target.question.includes("\n") ||
      !Array.isArray(target.requiredProbes)
    ) {
      fail("invalid-plan");
    }
    ids.add(target.id);
    keys.add(target.targetKey);
    // createSearchTarget is the authoritative probe/rubric validator.
    instantiateDeclarationForValidation(
      target as unknown as WorkflowSearchPlanV1["targets"][number],
    );
  }
  return deepFreeze(structuredClone(value));
}

/** A fresh immutable plan identity for one coordinator invocation. */
export function snapshotWorkflowSearchPlan(value: WorkflowSearchPlanV1): WorkflowSearchPlanV1 {
  assertInertPlainData(value, "invalid-plan");
  return validateWorkflowSearchPlan(value);
}

/** Freeze an inert coordinator result before any caller reads its fields. */
export function snapshotWorkflowSearchCoordinatorResult(
  value: WorkflowSearchCoordinatorResultV1,
): WorkflowSearchCoordinatorResultV1 {
  // The release batch authority and trusted inventory embed a whole
  // repository inventory, so the whole result is first proven inert without
  // node or array ceilings; the search evidence then keeps the generic ones.
  kitFor("invalid-result", true).assertInert(value);
  const expectedKeys = ["repositoryIdentitySha256", "searches"];
  if (value.repositoryBatchAuthority !== undefined) expectedKeys.push("repositoryBatchAuthority");
  if (value.trustedRepositoryInventory !== undefined)
    expectedKeys.push("trustedRepositoryInventory");
  if (value.workspaceSnapshotSha256 !== undefined) expectedKeys.push("workspaceSnapshotSha256");
  if (value.evidenceWarnings !== undefined) expectedKeys.push("evidenceWarnings");
  if (
    !plainObject(value) ||
    Object.keys(value).sort().join(",") !== expectedKeys.sort().join(",") ||
    typeof value.repositoryIdentitySha256 !== "string" ||
    !SHA256.test(value.repositoryIdentitySha256) ||
    (value.workspaceSnapshotSha256 !== undefined &&
      (typeof value.workspaceSnapshotSha256 !== "string" ||
        !SHA256.test(value.workspaceSnapshotSha256))) ||
    (value.evidenceWarnings !== undefined &&
      (!Array.isArray(value.evidenceWarnings) ||
        value.evidenceWarnings.some((warning) => typeof warning !== "string"))) ||
    !Array.isArray(value.searches)
  ) {
    fail("invalid-result");
  }
  assertInertPlainData(
    {
      repositoryIdentitySha256: value.repositoryIdentitySha256,
      searches: value.searches,
      ...(value.workspaceSnapshotSha256
        ? { workspaceSnapshotSha256: value.workspaceSnapshotSha256 }
        : {}),
      ...(value.evidenceWarnings ? { evidenceWarnings: value.evidenceWarnings } : {}),
    },
    "invalid-result",
  );
  const serializable = structuredClone({
    repositoryIdentitySha256: value.repositoryIdentitySha256,
    searches: value.searches,
    ...(value.workspaceSnapshotSha256
      ? { workspaceSnapshotSha256: value.workspaceSnapshotSha256 }
      : {}),
    ...(value.repositoryBatchAuthority
      ? { repositoryBatchAuthority: value.repositoryBatchAuthority }
      : {}),
    ...(value.evidenceWarnings ? { evidenceWarnings: value.evidenceWarnings } : {}),
  });
  return deepFreeze({
    ...serializable,
    ...(value.trustedRepositoryInventory
      ? { trustedRepositoryInventory: value.trustedRepositoryInventory }
      : {}),
  });
}

function instantiateDeclarationForValidation(
  declaration: WorkflowSearchPlanV1["targets"][number],
): void {
  const repository = { identitySha256: "0".repeat(64), revision: "0".repeat(40) };
  createSearchTarget(
    declaration.targetType === "artifact-existence"
      ? {
          id: declaration.id,
          targetKey: declaration.targetKey,
          targetType: declaration.targetType,
          repository,
          subjectSha256: digest(declaration.question),
          artifactClass: declaration.artifactClass,
          requiredProbes: declaration.requiredProbes,
        }
      : {
          id: declaration.id,
          targetKey: declaration.targetKey,
          targetType: declaration.targetType,
          repository,
          subjectSha256: digest(declaration.question),
          requiredProbes: declaration.requiredProbes,
          rubric: declaration.rubric,
        },
  );
}

function repositoryBinding(value: SearchRepositoryBindingV1): SearchRepositoryBindingV1 {
  assertInertPlainData(value, "invalid-result");
  if (
    !plainObject(value) ||
    Object.keys(value).sort().join(",") !== "identitySha256,revision" ||
    !SHA256.test(value.identitySha256) ||
    !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(value.revision)
  ) {
    fail("invalid-result");
  }
  return { identitySha256: value.identitySha256, revision: value.revision };
}

function canonical(value: unknown): string {
  return canonicalizeJsonEvidence(value as JsonEvidenceValue);
}

function digest(value: unknown): string {
  return createHash("sha256")
    .update(typeof value === "string" ? value : canonical(value))
    .digest("hex");
}

function safeId(value: unknown): value is string {
  return typeof value === "string" && SAFE_ID.test(value);
}

function safeVersion(value: unknown): value is string {
  return typeof value === "string" && /^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/u.test(value);
}

function plainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
