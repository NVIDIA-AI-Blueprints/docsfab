// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  AutoCyclePathClass,
  AutoCycleRunEvidenceV1,
  AutoCycleWorkflowAccess,
  AutoMaturityFindingReferenceV1,
  AutoRepositoryBindingV1,
  AutoValidationResultV1,
  AutoWorkflowPrerequisiteRequirementV1,
  AutoWorkflowPrerequisiteV1,
  AutoWorkflowTaskBindingV1,
} from "../contracts.js";
import type { WorkflowName } from "../../workflow-contracts/contracts.js";
import {
  array,
  canonicalJson,
  compare,
  enumeration,
  exact,
  fail,
  hash,
  identifier,
  normalizedHashes,
  normalizedIds,
  object,
  string,
  stringArray,
  unique,
} from "./codec-kit.js";

function prerequisite(value: unknown): AutoWorkflowPrerequisiteV1 {
  const root = object(value);
  exact(root, ["id", "state", "evidenceSha256s"]);
  const state = enumeration(root.state, [
    "satisfied",
    "missing",
    "conflicting",
    "blocked",
  ] as const);
  const evidenceSha256s = normalizedHashes(root.evidenceSha256s);
  if (state === "satisfied" && evidenceSha256s.length === 0) fail("invalid-value");
  return { id: identifier(root.id), state, evidenceSha256s };
}

function workflowPrerequisiteRequirement(
  value: unknown,
  workflows: AutoCycleWorkflowAccess,
): AutoWorkflowPrerequisiteRequirementV1 {
  const root = object(value);
  exact(root, ["workflow", "prerequisiteIds"]);
  return {
    workflow: workflowName(root.workflow, workflows),
    prerequisiteIds: normalizedIds(root.prerequisiteIds, false),
  };
}

function workflowTaskBinding(
  value: unknown,
  workflows: AutoCycleWorkflowAccess,
): AutoWorkflowTaskBindingV1 {
  const root = object(value);
  exact(root, ["workflow", "taskKind", "taskSha256"]);
  const workflow = workflowName(root.workflow, workflows);
  const taskKind = enumeration(root.taskKind, [
    "none",
    "ia-plan",
    "site-bootstrap",
    "bounded-doc-improvement",
  ] as const);
  if (
    ((workflow === "ia-analysis" || workflow === "ia-plan") && taskKind !== "ia-plan") ||
    (workflow === "site-bootstrap" && taskKind !== "site-bootstrap") ||
    (workflow === "update-documentation" &&
      taskKind !== "bounded-doc-improvement" &&
      taskKind !== "none") ||
    (!["update-documentation", "ia-analysis", "ia-plan", "site-bootstrap"].includes(workflow) &&
      taskKind !== "none")
  )
    fail("invalid-value");
  return {
    workflow,
    taskKind,
    taskSha256: hash(root.taskSha256),
  };
}

function maturityReference(value: unknown): AutoMaturityFindingReferenceV1 {
  const root = object(value);
  exact(root, ["fingerprint", "findingSha256", "confidence", "disposition"]);
  return {
    fingerprint: hash(root.fingerprint),
    findingSha256: hash(root.findingSha256),
    confidence: enumeration(root.confidence, ["confirmed", "bounded", "inconclusive"] as const),
    disposition: enumeration(root.disposition, [
      "observed-absence",
      "bounded-not-found",
      "unknown",
      "not-applicable",
      "blocked",
      "satisfied",
    ] as const),
  };
}

function validationResult(value: unknown): AutoValidationResultV1 {
  const root = object(value);
  exact(root, ["id", "status", "evidenceSha256"]);
  const status = enumeration(root.status, ["passed", "failed", "not-run"] as const);
  const evidenceSha256 = root.evidenceSha256 === null ? null : hash(root.evidenceSha256);
  if ((status === "not-run") !== (evidenceSha256 === null)) fail("invalid-value");
  return { id: identifier(root.id), status, evidenceSha256 };
}

function runEvidence(value: unknown, workflows: AutoCycleWorkflowAccess): AutoCycleRunEvidenceV1 {
  const root = object(value);
  exact(root, ["id", "recordSha256", "workflow", "repository", "taskSha256", "status"]);
  return {
    id: identifier(root.id),
    recordSha256: hash(root.recordSha256),
    workflow: workflowName(root.workflow, workflows),
    repository: repositoryBinding(root.repository),
    taskSha256: hash(root.taskSha256),
    status: enumeration(root.status, [
      "needs-input",
      "needs-human-decision",
      "succeeded",
      "failed",
    ] as const),
  };
}

function repositoryBinding(value: unknown): AutoRepositoryBindingV1 {
  const root = object(value);
  exact(root, ["identitySha256", "revision"]);
  return { identitySha256: hash(root.identitySha256), revision: revision(root.revision) };
}

function revision(value: unknown): string {
  const result = string(value);
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(result)) fail("invalid-value");
  return result;
}

function workflowName(value: unknown, workflows: AutoCycleWorkflowAccess): WorkflowName {
  const name = string(value);
  if (!workflows.isRunnableWorkflowName(name)) fail("workflow-not-registered");
  return name as WorkflowName;
}

function normalizedPaths(value: unknown, pathClass: AutoCyclePathClass): string[] {
  const paths = stringArray(value).map(relativePath).sort(compare);
  unique(paths);
  if (pathClass === "repository-read-only" && canonicalJson(paths) !== canonicalJson(["."])) {
    fail("invalid-value");
  }
  if (pathClass === "documentation-write" && paths.length === 0) fail("invalid-value");
  return paths;
}

function relativePath(value: string): string {
  if (value === ".") return value;
  if (
    value.length > 512 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("//") ||
    value.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    fail("invalid-value");
  }
  return value;
}

function branch(value: unknown): string {
  const result = string(value);
  if (
    result.length > 255 ||
    result.startsWith("-") ||
    result.startsWith("/") ||
    result.endsWith("/") ||
    result.includes("..") ||
    result.includes(" ") ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(result)
  )
    fail("invalid-value");
  return result;
}

export {
  branch,
  maturityReference,
  normalizedPaths,
  prerequisite,
  relativePath,
  repositoryBinding,
  revision,
  runEvidence,
  validationResult,
  workflowName,
  workflowPrerequisiteRequirement,
  workflowTaskBinding,
};
