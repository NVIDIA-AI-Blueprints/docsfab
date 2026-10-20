// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { types as nodeUtilTypes } from "node:util";

import { createContractKit, deepFreeze } from "../contract-kit/index.js";
import type { ContextPreflightTarget } from "../context/contracts.js";
import type { RunRequest } from "../execution/contracts.js";
import type { WorkflowName, WorkflowTaskInput } from "./contracts.js";
import type { ArtifactReference } from "../artifacts/contracts.js";
import { validateArtifactReference } from "../artifacts/validate.js";
import { canonicalDigest } from "../content-ir/canonical.js";

export interface WorkflowTaskRepositoryBinding {
  identitySha256: string;
  revision: string;
}

export interface WorkflowTaskNormalizationInput {
  runId?: string;
  workflow: WorkflowName;
  task: WorkflowTaskInput | null | undefined;
  repository: WorkflowTaskRepositoryBinding;
  allowWrite: boolean;
  instruction?: string;
  contextTarget?: ContextPreflightTarget;
}

type TaskInertCode = "shape" | "migration-required";
function rejectWorkflowTaskContract(code: TaskInertCode): never {
  invalid(code);
}
const taskKit = createContractKit({
  fail: rejectWorkflowTaskContract,
  codes: {
    invalidShape: "shape",
    invalidValue: "shape",
    digestMismatch: "shape",
    credentialMaterial: "shape",
    schemaMismatch: "migration-required",
  },
});

/**
 * The one canonical Task validator shared by WorkflowRunner and autonomous-cycle
 * bindings. It validates runner policy and returns a detached normalized value.
 */
export function normalizeWorkflowTaskInput(
  input: WorkflowTaskNormalizationInput,
): WorkflowTaskInput | null {
  taskKit.assertInert(input.task);
  if (input.runId !== undefined && !ID.test(input.runId)) invalid("run-id");
  const task = input.task ?? null;
  if (input.workflow === "ia-analysis" || input.workflow === "ia-plan") {
    if (!task || task.kind !== "ia-plan" || input.allowWrite) invalid("ia-plan");
    const root = closed(task, ["kind", "scope", "mode"], ["target"]);
    const scope = choice(root.scope, ["site", "section", "page"] as const);
    const mode = choice(root.mode, ["create", "reevaluate"] as const);
    if ((scope === "site") === (root.target !== undefined)) invalid("ia-plan-target");
    const target = root.target === undefined ? undefined : normalizeContextTarget(root.target);
    if (
      input.contextTarget !== undefined &&
      canonicalDigest(normalizeContextTarget(input.contextTarget)) !== canonicalDigest(target)
    ) {
      invalid("ia-plan-context");
    }
    return deepFreeze({ kind: "ia-plan" as const, scope, mode, ...(target ? { target } : {}) });
  }
  if (input.workflow === "site-bootstrap") {
    if (!task || task.kind !== "site-bootstrap") invalid("site-bootstrap");
    closed(task, ["kind", "plan"]);
    const plan = (() => {
      try {
        return validateArtifactReference(task.plan, {
          expectedKind: "ia-plan",
        }) as ArtifactReference<"ia-plan">;
      } catch {
        return invalid("site-bootstrap-plan");
      }
    })();
    if (plan.repositoryRevision !== input.repository.revision) invalid("site-bootstrap-revision");
    return deepFreeze({ kind: "site-bootstrap" as const, plan });
  }
  if (input.workflow === "update-documentation" && task?.kind === "bounded-doc-improvement") {
    if (input.instruction !== undefined || input.contextTarget !== undefined || !input.allowWrite) {
      invalid("bounded-doc-policy");
    }
    const root = closed(task, [
      "kind",
      "campaignId",
      "repositoryId",
      "testedCommit",
      "repositoryIdentitySha256",
      "contextSourcePath",
      "gap",
      "analysis",
      "authorization",
      "intendedPaths",
    ]);
    const gap = closed(root.gap, ["id", "evidenceSha256", "successCriterionSha256"]);
    const analysis = closed(root.analysis, [
      "runId",
      "recordSha256",
      "approvedOutcomeSha256",
      "approvedProposal",
    ]);
    const authorization = closed(root.authorization, ["sha256", "digest"]);
    const repositoryId = text(root.repositoryId);
    const proposal = text(analysis.approvedProposal);
    const testedCommit = revision(root.testedCommit);
    const repositoryIdentitySha256 = digest(root.repositoryIdentitySha256);
    if (
      !REPOSITORY_ID.test(repositoryId) ||
      testedCommit !== input.repository.revision ||
      repositoryIdentitySha256 !== input.repository.identitySha256 ||
      proposal.length === 0 ||
      proposal.length > 16_384 ||
      proposal.includes("\0") ||
      canonicalDigest(proposal) !== digest(analysis.approvedOutcomeSha256)
    ) {
      invalid("bounded-doc-binding");
    }
    const intendedPaths = denseArray(root.intendedPaths).map(safePath);
    if (intendedPaths.length === 0 || new Set(intendedPaths).size !== intendedPaths.length) {
      invalid("bounded-doc-paths");
    }
    return deepFreeze({
      kind: "bounded-doc-improvement" as const,
      campaignId: id(root.campaignId),
      repositoryId,
      testedCommit,
      repositoryIdentitySha256,
      contextSourcePath: safePath(root.contextSourcePath),
      gap: {
        id: id(gap.id),
        evidenceSha256: digest(gap.evidenceSha256),
        successCriterionSha256: digest(gap.successCriterionSha256),
      },
      analysis: {
        runId: id(analysis.runId),
        recordSha256: digest(analysis.recordSha256),
        approvedOutcomeSha256: digest(analysis.approvedOutcomeSha256),
        approvedProposal: proposal,
      },
      authorization: {
        sha256: digest(authorization.sha256),
        digest: digest(authorization.digest),
      },
      intendedPaths: [...intendedPaths].sort(compare),
    });
  }
  if (input.workflow === "foundation-to-patch") {
    if (task === null) return null;
    if (task.kind !== "foundation-to-patch") invalid("foundation-to-patch");
    const root = closed(task, ["kind", "intendedPaths"], ["authorization", "canonSha256"]);
    const intendedPaths = denseArray(root.intendedPaths).map(safePath);
    if (intendedPaths.length === 0 || new Set(intendedPaths).size !== intendedPaths.length) {
      invalid("foundation-to-patch-paths");
    }
    const authorization =
      root.authorization === undefined
        ? undefined
        : (() => {
            const auth = closed(root.authorization, ["sha256", "digest", "expiresAt"]);
            return deepFreeze({
              sha256: digest(auth.sha256),
              digest: digest(auth.digest),
              expiresAt: text(auth.expiresAt),
            });
          })();
    return deepFreeze({
      kind: "foundation-to-patch" as const,
      intendedPaths: [...intendedPaths].sort(compare),
      ...(authorization ? { authorization } : {}),
      ...(root.canonSha256 === undefined ? {} : { canonSha256: digest(root.canonSha256) }),
    });
  }
  if (input.workflow === "create-documentation" || input.workflow === "update-documentation") {
    if (task === null) return null;
    if (task.kind !== input.workflow) invalid("unexpected-task");
    const root = closed(task, ["kind", "canonSha256"]);
    return deepFreeze({
      kind: input.workflow,
      canonSha256: digest(root.canonSha256),
    });
  }
  if (task !== null) invalid("unexpected-task");
  return null;
}

/** Exact adapter used by WorkflowRunner; tests may call it to prove parity. */
export function validateWorkflowRunRequestTask(request: RunRequest): WorkflowTaskInput | null {
  return normalizeWorkflowTaskInput({
    ...(request.runId === undefined ? {} : { runId: request.runId }),
    workflow: request.workflow,
    task: request.task,
    repository: {
      identitySha256: createHash("sha256").update(request.repository.sourcePath).digest("hex"),
      revision: request.repository.revision,
    },
    allowWrite: request.allowWrite,
    ...(request.instruction === undefined ? {} : { instruction: request.instruction }),
    ...(request.contextTarget === undefined ? {} : { contextTarget: request.contextTarget }),
  });
}

export type WorkflowTaskValidationCode =
  | "run-id"
  | "ia-plan"
  | "ia-plan-target"
  | "ia-plan-context"
  | "site-bootstrap"
  | "site-bootstrap-plan"
  | "site-bootstrap-revision"
  | "bounded-doc-policy"
  | "bounded-doc-binding"
  | "bounded-doc-paths"
  | "foundation-to-patch"
  | "foundation-to-patch-paths"
  | "unexpected-task"
  | "shape"
  | "path"
  | "label"
  | "context-path"
  | "id"
  | "digest"
  | "revision"
  | "text"
  | "array"
  | "choice"
  | "migration-required";

export class WorkflowTaskValidationError extends Error {
  public readonly code: WorkflowTaskValidationCode;

  public constructor(public readonly reason: WorkflowTaskValidationCode) {
    super(taskErrorMessage(reason));
    this.name = "WorkflowTaskValidationError";
    this.code = reason;
  }
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const REPOSITORY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

function normalizeContextTarget(value: unknown): ContextPreflightTarget {
  const root = closed(
    value,
    ["sourcePath"],
    ["anchor", "candidateParentPath", "candidateParentAnchor"],
  );
  return {
    sourcePath: contextPath(root.sourcePath),
    ...(root.anchor === undefined ? {} : { anchor: safeLabel(root.anchor) }),
    ...(root.candidateParentPath === undefined
      ? {}
      : { candidateParentPath: contextPath(root.candidateParentPath) }),
    ...(root.candidateParentAnchor === undefined
      ? {}
      : { candidateParentAnchor: safeLabel(root.candidateParentAnchor) }),
  };
}

function closed(
  value: unknown,
  required: string[],
  optional: string[] = [],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    nodeUtilTypes.isProxy(value)
  )
    invalid("shape");
  const root = value as Record<string, unknown>;
  const keys = Object.keys(root);
  if (
    required.some((key) => !keys.includes(key)) ||
    keys.some((key) => !required.includes(key) && !optional.includes(key))
  )
    invalid("shape");
  return root;
}

function safePath(value: unknown): string {
  const path = text(value);
  if (
    path !== path.normalize("NFC") ||
    path.length === 0 ||
    path.length > 512 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    !path
      .split("/")
      .every((part) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(part) && part !== "." && part !== "..")
  ) {
    invalid("path");
  }
  return path;
}

function safeLabel(value: unknown): string {
  const label = text(value);
  if (label !== label.normalize("NFC") || label.length === 0 || label.includes("\0"))
    invalid("label");
  return label;
}

function contextPath(value: unknown): string {
  const path = safeLabel(value);
  if (
    path.startsWith("/") ||
    path.includes("\\") ||
    /^[A-Za-z]:/u.test(path) ||
    !path.split("/").every((part) => part.length > 0 && part !== "." && part !== "..")
  ) {
    invalid("context-path");
  }
  return path;
}

function id(value: unknown): string {
  const result = text(value);
  if (!ID.test(result)) invalid("id");
  return result;
}
function digest(value: unknown): string {
  const result = text(value);
  if (!DIGEST.test(result)) invalid("digest");
  return result;
}
function revision(value: unknown): string {
  const result = text(value);
  if (!REVISION.test(result)) invalid("revision");
  return result;
}
function text(value: unknown): string {
  if (typeof value !== "string") invalid("text");
  return value;
}
function denseArray(value: unknown): unknown[] {
  if (!Array.isArray(value) || Object.keys(value).length !== value.length) invalid("array");
  return value;
}
function choice<const T extends readonly string[]>(value: unknown, choices: T): T[number] {
  const result = text(value);
  if (!choices.includes(result)) invalid("choice");
  return result as T[number];
}
function compare(left: string, right: string): number {
  return left.localeCompare(right);
}
function invalid(reason: WorkflowTaskValidationCode): never {
  throw new WorkflowTaskValidationError(reason);
}
function taskErrorMessage(reason: WorkflowTaskValidationCode): string {
  if (reason.startsWith("ia-plan")) return "Workflow requires a structured ia-plan task.";
  if (reason === "site-bootstrap-revision") {
    return "Site-bootstrap plan revision does not match the run repository.";
  }
  if (reason.startsWith("site-bootstrap")) {
    return "Workflow requires a structured site-bootstrap task.";
  }
  if (reason.startsWith("foundation-to-patch")) {
    return "Workflow requires a structured foundation-to-patch task.";
  }
  if (reason === "run-id") return "Run identity must be a preallocated content-free identifier.";
  if (reason.startsWith("bounded-doc") || reason === "path") {
    return "Invalid bounded documentation improvement task.";
  }
  return "Workflow task input is invalid.";
}
