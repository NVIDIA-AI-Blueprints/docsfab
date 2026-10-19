// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Current task scope for shared execution.
 *
 * One host-issued identity, current repository/revision, write class, and
 * grant fingerprint. Session lifetime is not grant lifetime. Children may
 * only narrow this scope. Source and CI writes are never a granted class.
 * Generic scope state is separate from reader-context semantics.
 */
import {
  createContractKit,
  createHostAuthorityFactory,
  deepFreeze,
} from "../contract-kit/index.js";
import { assertWorkflowActive } from "./cancellation.js";

export const TASK_SCOPE_KIND = "docsfab-task-scope" as const;

export const TASK_WRITE_CLASSES = ["none", "documentation"] as const;
export type TaskWriteClass = (typeof TASK_WRITE_CLASSES)[number];

export const TASK_WORKSPACE_OBSERVATION_MODES = ["workflow-export", "selected-checkout"] as const;
export type TaskWorkspaceObservationMode = (typeof TASK_WORKSPACE_OBSERVATION_MODES)[number];

export const TASK_WRITE_PATH_CLASSES = ["ci", "source", "documentation", "other"] as const;
export type TaskWritePathClass = (typeof TASK_WRITE_PATH_CLASSES)[number];

export type TaskScopeErrorCode =
  | "invalid-shape"
  | "invalid-value"
  | "cancelled"
  | "grant-revoked"
  | "grant-widened"
  | "stale-artifact"
  | "source-write-denied"
  | "ci-write-denied"
  | "session-is-not-grant"
  | "source-reference-cannot-widen";

const ERROR_MESSAGES: Readonly<Record<TaskScopeErrorCode, string>> = {
  "invalid-shape": "Task scope rejected an unauthenticated or malformed host identity.",
  "invalid-value": "Task scope rejected an invalid identity, revision, or write class.",
  cancelled: "Task scope refused work after cancellation.",
  "grant-revoked": "Task scope refused work because the current grant is no longer active.",
  "grant-widened": "Task scope refused a child grant that was wider than the parent grant.",
  "stale-artifact": "Task scope refused a stale artifact that does not match the current revision.",
  "source-write-denied":
    "Task scope denied a source-path write; documentation is the granted class.",
  "ci-write-denied": "Task scope denied a CI-path write; documentation is the granted class.",
  "session-is-not-grant":
    "Task scope refused to treat session lifetime as a grant; the current grant is required.",
  "source-reference-cannot-widen":
    "Task scope refused an optional source reference that would widen the child grant.",
};

export class TaskScopeError extends Error {
  public readonly code: TaskScopeErrorCode;

  public constructor(code: TaskScopeErrorCode, message?: string) {
    super(message ?? ERROR_MESSAGES[code]);
    this.name = "TaskScopeError";
    this.code = code;
  }
}

function fail(code: TaskScopeErrorCode, message?: string): never {
  throw new TaskScopeError(code, message);
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;

function scopedId(value: unknown): string {
  const result = kit.string(value);
  if (!SAFE_ID.test(result)) fail("invalid-value");
  return result;
}

const kit = createContractKit<TaskScopeErrorCode>({
  fail: (code) => fail(code),
  inertMode: "strict",
  codes: {
    invalidShape: "invalid-shape",
    invalidValue: "invalid-value",
    digestMismatch: "invalid-value",
    credentialMaterial: "invalid-value",
    schemaMismatch: "invalid-value",
  },
});

const WRITE_RANK: Readonly<Record<TaskWriteClass, number>> = {
  none: 0,
  documentation: 1,
};

const CI_PREFIXES = [".github/", ".gitlab/"] as const;
const PROTECTED_PATH_SEGMENTS = new Set([
  ".git",
  ".github",
  ".gitlab",
  "node_modules",
  ".venv",
  "vendor",
  ".docsfab-governed-assets",
]);
const SOURCE_PREFIXES = ["src/", "lib/", "app/", "scripts/", "bin/", "deploy/"] as const;
const SOURCE_FILES = new Set([
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
]);
const DOCUMENTATION_PREFIXES = ["docs/", "doc/", "documentation/", "fern/"] as const;

export interface TaskGrantVerifier {
  verifyCurrent(): boolean;
  readonly fingerprintSha256: string;
}

export interface TaskScopeWriteBoundary {
  allows(path: string): boolean;
}

export interface TaskSourceBindingRefV1 {
  readonly digest: string;
  readonly repositoryRevision: string;
  readonly repositoryContentDigest: string;
}

export interface TaskScopeSnapshotV1 {
  readonly schemaVersion: 1;
  readonly kind: typeof TASK_SCOPE_KIND;
  readonly taskId: string;
  readonly repositoryIdentitySha256: string;
  readonly repositoryRevision: string;
  readonly repositoryContentDigest: string;
  readonly observationMode: TaskWorkspaceObservationMode;
  readonly writeClass: TaskWriteClass;
  readonly grantFingerprintSha256: string;
  readonly sourceBinding: TaskSourceBindingRefV1 | null;
  readonly scopeFingerprintSha256: string;
}

export type TaskScope = {
  readonly kind: typeof TASK_SCOPE_KIND;
};

interface TaskScopeState {
  verifyCurrent(): boolean;
  snapshot: TaskScopeSnapshotV1;
  writeBoundary: TaskScopeWriteBoundary;
  grant: TaskGrantVerifier;
  signal?: AbortSignal;
  parent?: TaskScope;
}

const scopeAuthority = createHostAuthorityFactory<"docsfab-task-scope", TaskScopeState>({
  kind: "docsfab-task-scope",
  invalidMessage: "A task scope requires a host grant verifier.",
});

function requireState(scope: TaskScope): TaskScopeState {
  const state = scopeAuthority.lookup(scope);
  if (!state) fail("invalid-shape");
  return state;
}

function decodeSourceBinding(value: unknown): TaskSourceBindingRefV1 | null {
  if (value === null || value === undefined) return null;
  const record = kit.object(value);
  kit.exact(record, ["digest", "repositoryRevision", "repositoryContentDigest"]);
  return deepFreeze({
    digest: kit.hash(record.digest),
    repositoryRevision: kit.revision(record.repositoryRevision),
    repositoryContentDigest: kit.hash(record.repositoryContentDigest),
  });
}

function fingerprintScope(
  input: Omit<TaskScopeSnapshotV1, "kind" | "schemaVersion" | "scopeFingerprintSha256">,
): string {
  return kit.canonicalDigest({
    schemaVersion: 1,
    kind: TASK_SCOPE_KIND,
    ...input,
  });
}

function sameSourceBinding(
  left: TaskSourceBindingRefV1 | null,
  right: TaskSourceBindingRefV1 | null,
): boolean {
  if (left === null && right === null) return true;
  if (left === null || right === null) return false;
  return (
    left.digest === right.digest &&
    left.repositoryRevision === right.repositoryRevision &&
    left.repositoryContentDigest === right.repositoryContentDigest
  );
}

export function classifyTaskWritePath(path: string): TaskWritePathClass {
  if (!isCanonicalTaskPath(path)) return "other";
  const normalized = path;
  const parts = normalized.split("/");
  if (
    parts.includes(".gitlab-ci.yml") ||
    CI_PREFIXES.some((prefix) => normalized.startsWith(prefix))
  ) {
    return "ci";
  }
  if (parts[0] === "packages" && parts.length >= 3 && [".github", ".gitlab"].includes(parts[2]!)) {
    return "ci";
  }
  if (parts.some((part) => PROTECTED_PATH_SEGMENTS.has(part))) return "other";
  if (
    SOURCE_FILES.has(normalized) ||
    (parts[0] === "packages" && SOURCE_FILES.has(parts.at(-1)!)) ||
    SOURCE_PREFIXES.some((prefix) => normalized.startsWith(prefix)) ||
    (parts[0] === "packages" &&
      parts.length >= 3 &&
      ["src", "lib", "app", "scripts", "bin", "deploy"].includes(parts[2]!))
  ) {
    return "source";
  }
  if (
    DOCUMENTATION_PREFIXES.some((prefix) => normalized.startsWith(prefix)) ||
    parts.slice(0, -1).some((part) => ["docs", "doc", "documentation", "fern"].includes(part)) ||
    normalized.startsWith(".docsfab/reference-model/") ||
    (parts.length === 1 &&
      /^(?:readme|changelog|contributing|authors|code_of_conduct|support)(?:\.(?:md|mdx|rst|txt))?$/iu.test(
        parts[0]!,
      ))
  ) {
    return "documentation";
  }
  return "other";
}

function isCanonicalTaskPath(path: unknown): path is string {
  if (typeof path !== "string" || path.length === 0 || path.includes("\\")) return false;
  if (/^[A-Za-z]:|^\//u.test(path) || /[\u0000-\u001f\u007f]/u.test(path)) return false;
  return path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

export interface CreateTaskScopeInput {
  readonly taskId: string;
  readonly repositoryIdentitySha256: string;
  readonly repositoryRevision: string;
  readonly repositoryContentDigest: string;
  readonly observationMode: TaskWorkspaceObservationMode;
  readonly writeClass: TaskWriteClass;
  readonly grant: TaskGrantVerifier;
  readonly writeBoundary: TaskScopeWriteBoundary;
  readonly sourceBinding?: TaskSourceBindingRefV1 | null;
  readonly signal?: AbortSignal;
  /** Optional conversation identity. It is never treated as a grant. */
  readonly sessionId?: string;
}

export function createTaskScope(input: CreateTaskScopeInput): TaskScope {
  if (!input.grant || typeof input.grant.verifyCurrent !== "function") {
    fail("invalid-shape");
  }
  kit.hash(input.grant.fingerprintSha256);
  if (typeof input.writeBoundary?.allows !== "function") fail("invalid-shape");
  const sourceBinding = decodeSourceBinding(input.sourceBinding ?? null);
  const body = {
    taskId: scopedId(input.taskId),
    repositoryIdentitySha256: kit.hash(input.repositoryIdentitySha256),
    repositoryRevision: kit.revision(input.repositoryRevision),
    repositoryContentDigest: kit.hash(input.repositoryContentDigest),
    observationMode: kit.enumeration(input.observationMode, TASK_WORKSPACE_OBSERVATION_MODES),
    writeClass: kit.enumeration(input.writeClass, TASK_WRITE_CLASSES),
    grantFingerprintSha256: input.grant.fingerprintSha256,
    sourceBinding,
  };
  const snapshot: TaskScopeSnapshotV1 = deepFreeze({
    schemaVersion: 1,
    kind: TASK_SCOPE_KIND,
    ...body,
    scopeFingerprintSha256: fingerprintScope(body),
  });
  if (input.sessionId !== undefined) scopedId(input.sessionId);
  return scopeAuthority.create({
    verifyCurrent: () => input.grant.verifyCurrent(),
    snapshot,
    writeBoundary: input.writeBoundary,
    grant: input.grant,
    signal: input.signal,
  }) as TaskScope;
}

export interface NarrowTaskScopeInput {
  readonly writeClass?: TaskWriteClass;
  readonly sourceBinding?: TaskSourceBindingRefV1 | null;
  readonly grant?: TaskGrantVerifier;
  readonly signal?: AbortSignal;
}

export function narrowTaskScope(
  parent: TaskScope,
  narrowing: NarrowTaskScopeInput = {},
): TaskScope {
  const state = requireState(parent);
  assertTaskScopeActive(parent, narrowing.signal ?? state.signal);
  const writeClass = narrowing.writeClass ?? state.snapshot.writeClass;
  kit.enumeration(writeClass, TASK_WRITE_CLASSES);
  if (WRITE_RANK[writeClass] > WRITE_RANK[state.snapshot.writeClass]) fail("grant-widened");
  const sourceBinding =
    narrowing.sourceBinding === undefined
      ? state.snapshot.sourceBinding
      : decodeSourceBinding(narrowing.sourceBinding);
  if (sourceBinding && !state.snapshot.sourceBinding) fail("source-reference-cannot-widen");
  if (
    sourceBinding &&
    state.snapshot.sourceBinding &&
    !sameSourceBinding(sourceBinding, state.snapshot.sourceBinding)
  ) {
    fail("source-reference-cannot-widen");
  }
  const grant = narrowing.grant ?? state.grant;
  if (!grant || typeof grant.verifyCurrent !== "function") fail("invalid-shape");
  kit.hash(grant.fingerprintSha256);
  const child = createTaskScope({
    taskId: state.snapshot.taskId,
    repositoryIdentitySha256: state.snapshot.repositoryIdentitySha256,
    repositoryRevision: state.snapshot.repositoryRevision,
    repositoryContentDigest: state.snapshot.repositoryContentDigest,
    observationMode: state.snapshot.observationMode,
    writeClass,
    grant,
    writeBoundary: state.writeBoundary,
    sourceBinding,
    signal: narrowing.signal ?? state.signal,
  });
  requireState(child).parent = parent;
  return child;
}

export function projectTaskScope(scope: TaskScope): {
  readonly availability: "available";
  readonly snapshot: TaskScopeSnapshotV1;
} {
  const state = requireState(scope);
  return deepFreeze({
    availability: "available" as const,
    snapshot: state.snapshot,
  });
}

export function assertTaskScopeActive(scope: TaskScope, signal?: AbortSignal): void {
  const state = requireState(scope);
  const activeSignal = signal ?? state.signal;
  if (activeSignal?.aborted) fail("cancelled");
  try {
    assertWorkflowActive(activeSignal);
  } catch {
    fail("cancelled");
  }
  if (!state.grant.verifyCurrent() || !state.verifyCurrent()) fail("grant-revoked");
}

export function assertSessionIsNotGrant(scope: TaskScope, sessionId?: string): void {
  const state = requireState(scope);
  if (sessionId !== undefined) scopedId(sessionId);
  if (!state.grant.verifyCurrent()) fail("session-is-not-grant");
}

export function assertWritePathAllowed(scope: TaskScope, path: string): void {
  const state = requireState(scope);
  assertTaskScopeActive(scope);
  if (!isCanonicalTaskPath(path)) fail("invalid-value");
  if (state.snapshot.writeClass === "none") fail("source-write-denied");
  const classified = classifyTaskWritePath(path);
  if (classified === "other") fail("source-write-denied");
  if (classified === "ci") fail("ci-write-denied");
  if (classified === "source") fail("source-write-denied");
  if (!state.writeBoundary.allows(path)) {
    fail("source-write-denied");
  }
}

export function assertArtifactCurrent(
  scope: TaskScope,
  artifact: {
    readonly repositoryRevision: string;
    readonly repositoryContentDigest?: string;
  },
): void {
  const state = requireState(scope);
  assertTaskScopeActive(scope);
  const revision = kit.revision(artifact.repositoryRevision);
  if (revision !== state.snapshot.repositoryRevision) fail("stale-artifact");
  if (artifact.repositoryContentDigest !== undefined) {
    const digest = kit.hash(artifact.repositoryContentDigest);
    if (digest !== state.snapshot.repositoryContentDigest) fail("stale-artifact");
  }
}

export function assertChildScopeDoesNotWiden(parent: TaskScope, child: TaskScope): void {
  const parentState = requireState(parent);
  const childState = requireState(child);
  assertTaskScopeActive(parent);
  assertTaskScopeActive(child);
  if (childState.parent !== parent) fail("grant-widened");
  if (childState.snapshot.taskId !== parentState.snapshot.taskId) fail("grant-widened");
  if (
    childState.snapshot.repositoryIdentitySha256 !== parentState.snapshot.repositoryIdentitySha256
  ) {
    fail("grant-widened");
  }
  if (childState.snapshot.repositoryRevision !== parentState.snapshot.repositoryRevision) {
    fail("stale-artifact");
  }
  if (childState.snapshot.observationMode !== parentState.snapshot.observationMode) {
    fail("grant-widened");
  }
  if (WRITE_RANK[childState.snapshot.writeClass] > WRITE_RANK[parentState.snapshot.writeClass]) {
    fail("grant-widened");
  }
  if (childState.snapshot.sourceBinding && !parentState.snapshot.sourceBinding) {
    fail("source-reference-cannot-widen");
  }
  if (
    childState.snapshot.sourceBinding &&
    parentState.snapshot.sourceBinding &&
    !sameSourceBinding(childState.snapshot.sourceBinding, parentState.snapshot.sourceBinding)
  ) {
    fail("source-reference-cannot-widen");
  }
}
