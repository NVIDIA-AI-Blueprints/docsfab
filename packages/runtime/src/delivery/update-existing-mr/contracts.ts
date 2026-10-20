// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Sealed, destination-neutral contracts for policy-gated updates of an existing
 * merge request. The request is data; the authority is an opaque host capability.
 * No credential or transport detail crosses this boundary.
 *
 * Host may import this module; runtime must not import host. This module mints
 * `docsfab-update-existing-mr-authority`, and host mints its own
 * `docsfab-update-existing-mr-host-authority`; the handles are not interchangeable.
 */
import {
  createContractKit,
  createHostAuthorityFactory,
  type ContractFail,
} from "../../contract-kit/index.js";

export const UPDATE_EXISTING_MR_KIND = "docsfab-update-existing-mr-request" as const;
export const UPDATE_EXISTING_MR_AUTHORITY_KIND = "docsfab-update-existing-mr-authority" as const;
export const UPDATE_EXISTING_MR_EVALUATION_KIND = "docsfab-update-existing-mr-evaluation" as const;
export const UPDATE_EXISTING_MR_POLICY_VERSION = "A+1" as const;

export type UpdateExistingMrErrorCode =
  | "invalid-shape"
  | "invalid-value"
  | "digest-mismatch"
  | "credential-material"
  | "migration-required"
  | "authority-required"
  | "authority-mismatch"
  | "grant-required"
  | "project-mismatch"
  | "merge-request-mismatch"
  | "source-branch-mismatch"
  | "target-branch-mismatch"
  | "protected-branch"
  | "default-branch"
  | "fork-not-allowed"
  | "owner-not-allowed"
  | "stale-head"
  | "force-push-forbidden"
  | "policy-mismatch"
  | "requester-mismatch"
  | "fallback-required";

export class UpdateExistingMrError extends Error {
  public constructor(public readonly code: UpdateExistingMrErrorCode) {
    super(`Update-existing-MR contract rejected: ${code}.`);
    this.name = "UpdateExistingMrError";
  }
}

export function fail(code: UpdateExistingMrErrorCode): never {
  throw new UpdateExistingMrError(code);
}

const kit = createContractKit({
  fail: fail as ContractFail<UpdateExistingMrErrorCode>,
  inertMode: "strict",
  codes: {
    invalidShape: "invalid-shape",
    invalidValue: "invalid-value",
    digestMismatch: "digest-mismatch",
    credentialMaterial: "credential-material",
    schemaMismatch: "migration-required",
  },
});

export interface UpdateExistingMrRequestInputV1 {
  project: { host: string; projectId: number; repository: string };
  mergeRequest: {
    iid: number;
    sourceProjectId: number;
    sourceBranch: string;
    targetBranch: string;
    expectedHeadSha: string;
    sourceOwnerIdentity: string;
  };
  patch: { sha256: string; changedPaths: readonly string[] };
  policyVersion: typeof UPDATE_EXISTING_MR_POLICY_VERSION;
  requesterIdentitySha256: string;
  logicalRequestId: string;
  forcePush: false;
}

export interface UpdateExistingMrRequestV1 extends UpdateExistingMrRequestInputV1 {
  schemaVersion: 1;
  kind: typeof UPDATE_EXISTING_MR_KIND;
  requestSha256: string;
}

export interface UpdateExistingMrAuthorityPolicyV1 {
  host: string;
  projectId: number;
  mergeRequestIid: number;
  sourceProjectId: number;
  sourceBranch: string;
  targetBranch: string;
  expectedHeadSha: string;
  sourceOwnerIdentity: string;
  requesterIdentitySha256: string;
  policyVersion: typeof UPDATE_EXISTING_MR_POLICY_VERSION;
}

export interface UpdateExistingMrAuthorityV1 {
  readonly kind: typeof UPDATE_EXISTING_MR_AUTHORITY_KIND;
}

export interface UpdateExistingMrScmObservationV1 {
  host: string;
  projectId: number;
  sourceProjectId: number;
  mergeRequestIid: number;
  sourceBranch: string;
  targetBranch: string;
  headSha: string;
  defaultBranch: string;
  sourceProtected: boolean;
  sourceIsDefault: boolean;
  sourceOwnerIdentity: string;
}

export interface UpdateExistingMrGrantV1 {
  host: string;
  projectId: number;
  mergeRequestIid: number;
  sourceBranch: string;
  targetBranch: string;
  expectedHeadSha: string;
  requesterIdentitySha256: string;
  policyVersion: typeof UPDATE_EXISTING_MR_POLICY_VERSION;
  grantVersion: number;
  enabled: true;
  operation: "update-existing-mr-source-branch";
}

export type UpdateExistingMrDecision = "allow" | "deny";

export interface UpdateExistingMrFallbackV1 {
  mode: "comment-only-evaluation";
  patchLocator: { kind: "artifact-digest"; digestSha256: string };
  reportLocator: { kind: "evaluation-report"; keySha256: string };
  visible: true;
}

export interface UpdateExistingMrEvaluationV1 {
  schemaVersion: 1;
  kind: typeof UPDATE_EXISTING_MR_EVALUATION_KIND;
  requestSha256: string;
  decision: UpdateExistingMrDecision;
  reason: UpdateExistingMrErrorCode | "allowed";
  projectId: number;
  mergeRequestIid: number;
  expectedHeadSha: string;
  observedHeadSha: string | null;
  grantVersion: number | null;
  fallback: UpdateExistingMrFallbackV1;
  evaluationSha256: string;
}

const authorities = createHostAuthorityFactory<
  typeof UPDATE_EXISTING_MR_AUTHORITY_KIND,
  { policy: UpdateExistingMrAuthorityPolicyV1; verifyCurrent(): void }
>({
  kind: UPDATE_EXISTING_MR_AUTHORITY_KIND,
  invalidMessage: "Update-existing-MR authority policy is invalid.",
});

export function createUpdateExistingMrAuthority(
  policy: UpdateExistingMrAuthorityPolicyV1,
): UpdateExistingMrAuthorityV1 {
  kit.assertInert(policy);
  kit.rejectCredentials(policy);
  const normalized = normalizePolicy(policy);
  return authorities.create({
    policy: normalized,
    verifyCurrent() {},
  }) as UpdateExistingMrAuthorityV1;
}

export function authorityPolicy(
  authority: UpdateExistingMrAuthorityV1,
): UpdateExistingMrAuthorityPolicyV1 | undefined {
  if (!authority || authority.kind !== UPDATE_EXISTING_MR_AUTHORITY_KIND) return undefined;
  return authorities.lookup(authority)?.policy;
}

export function createUpdateExistingMrRequest(
  input: UpdateExistingMrRequestInputV1,
): UpdateExistingMrRequestV1 {
  kit.assertInert(input);
  kit.rejectCredentials(input);
  return kit.seal(UPDATE_EXISTING_MR_KIND, "requestSha256", normalizeRequest(input));
}

export function decodeUpdateExistingMrRequest(value: unknown): UpdateExistingMrRequestV1 {
  return kit.decodeSealed(
    value,
    UPDATE_EXISTING_MR_KIND,
    "requestSha256",
    [
      "project",
      "mergeRequest",
      "patch",
      "policyVersion",
      "requesterIdentitySha256",
      "logicalRequestId",
      "forcePush",
    ],
    (root) => normalizeRequest(root as unknown as UpdateExistingMrRequestInputV1),
  );
}

export function createFallback(request: UpdateExistingMrRequestV1): UpdateExistingMrFallbackV1 {
  const bound = decodeUpdateExistingMrRequest(request);
  return Object.freeze({
    mode: "comment-only-evaluation" as const,
    patchLocator: { kind: "artifact-digest" as const, digestSha256: bound.patch.sha256 },
    reportLocator: {
      kind: "evaluation-report" as const,
      keySha256: kit.canonicalDigest({
        host: bound.project.host,
        projectId: bound.project.projectId,
        mergeRequestIid: bound.mergeRequest.iid,
        logicalRequestId: bound.logicalRequestId,
      }),
    },
    visible: true as const,
  });
}

export function sealEvaluation(
  input: Omit<UpdateExistingMrEvaluationV1, "schemaVersion" | "kind" | "evaluationSha256">,
): UpdateExistingMrEvaluationV1 {
  return kit.seal(UPDATE_EXISTING_MR_EVALUATION_KIND, "evaluationSha256", input);
}

function normalizeRequest(input: UpdateExistingMrRequestInputV1): UpdateExistingMrRequestInputV1 {
  const root = kit.object(input);
  kit.exact(root, [
    "project",
    "mergeRequest",
    "patch",
    "policyVersion",
    "requesterIdentitySha256",
    "logicalRequestId",
    "forcePush",
  ]);
  const project = kit.object(root.project);
  kit.exact(project, ["host", "projectId", "repository"]);
  const mr = kit.object(root.mergeRequest);
  kit.exact(mr, [
    "iid",
    "sourceProjectId",
    "sourceBranch",
    "targetBranch",
    "expectedHeadSha",
    "sourceOwnerIdentity",
  ]);
  const patch = kit.object(root.patch);
  kit.exact(patch, ["sha256", "changedPaths"]);
  const changedPaths = kit
    .array(patch.changedPaths)
    .map((path) => relativePath(path))
    .sort(kit.compare);
  kit.unique(changedPaths);
  if (changedPaths.length === 0) fail("invalid-value");
  const sourceBranch = kit.identifier(mr.sourceBranch);
  const targetBranch = kit.identifier(mr.targetBranch);
  if (sourceBranch === targetBranch) fail("invalid-value");
  if (root.forcePush !== false) fail("force-push-forbidden");
  return {
    project: {
      host: kit.identifier(project.host),
      projectId: positive(project.projectId),
      repository: kit.identifier(project.repository),
    },
    mergeRequest: {
      iid: positive(mr.iid),
      sourceProjectId: positive(mr.sourceProjectId),
      sourceBranch,
      targetBranch,
      expectedHeadSha: kit.revision(mr.expectedHeadSha),
      sourceOwnerIdentity: kit.identifier(mr.sourceOwnerIdentity),
    },
    patch: { sha256: kit.hash(patch.sha256), changedPaths },
    policyVersion: kit.enumeration(root.policyVersion, [
      UPDATE_EXISTING_MR_POLICY_VERSION,
    ] as const),
    requesterIdentitySha256: kit.hash(root.requesterIdentitySha256),
    logicalRequestId: kit.identifier(root.logicalRequestId),
    forcePush: false,
  };
}

function normalizePolicy(
  value: UpdateExistingMrAuthorityPolicyV1,
): UpdateExistingMrAuthorityPolicyV1 {
  const root = kit.object(value);
  kit.exact(root, [
    "host",
    "projectId",
    "mergeRequestIid",
    "sourceProjectId",
    "sourceBranch",
    "targetBranch",
    "expectedHeadSha",
    "sourceOwnerIdentity",
    "requesterIdentitySha256",
    "policyVersion",
  ]);
  return {
    host: kit.identifier(root.host),
    projectId: positive(root.projectId),
    mergeRequestIid: positive(root.mergeRequestIid),
    sourceProjectId: positive(root.sourceProjectId),
    sourceBranch: kit.identifier(root.sourceBranch),
    targetBranch: kit.identifier(root.targetBranch),
    expectedHeadSha: kit.revision(root.expectedHeadSha),
    sourceOwnerIdentity: kit.identifier(root.sourceOwnerIdentity),
    requesterIdentitySha256: kit.hash(root.requesterIdentitySha256),
    policyVersion: kit.enumeration(root.policyVersion, [
      UPDATE_EXISTING_MR_POLICY_VERSION,
    ] as const),
  };
}

function normalizeObservation(
  value: UpdateExistingMrScmObservationV1,
): UpdateExistingMrScmObservationV1 {
  const root = kit.object(value);
  kit.exact(root, [
    "host",
    "projectId",
    "sourceProjectId",
    "mergeRequestIid",
    "sourceBranch",
    "targetBranch",
    "headSha",
    "defaultBranch",
    "sourceProtected",
    "sourceIsDefault",
    "sourceOwnerIdentity",
  ]);
  return {
    host: kit.identifier(root.host),
    projectId: positive(root.projectId),
    sourceProjectId: positive(root.sourceProjectId),
    mergeRequestIid: positive(root.mergeRequestIid),
    sourceBranch: kit.identifier(root.sourceBranch),
    targetBranch: kit.identifier(root.targetBranch),
    headSha: kit.revision(root.headSha),
    defaultBranch: kit.identifier(root.defaultBranch),
    sourceProtected: bool(root.sourceProtected),
    sourceIsDefault: bool(root.sourceIsDefault),
    sourceOwnerIdentity: kit.identifier(root.sourceOwnerIdentity),
  };
}

export function normalizeUpdateExistingMrObservation(
  value: UpdateExistingMrScmObservationV1,
): UpdateExistingMrScmObservationV1 {
  kit.assertInert(value);
  kit.rejectCredentials(value);
  return normalizeObservation(value);
}

export function normalizeUpdateExistingMrGrant(
  value: UpdateExistingMrGrantV1,
): UpdateExistingMrGrantV1 {
  kit.assertInert(value);
  kit.rejectCredentials(value);
  const root = kit.object(value);
  kit.exact(root, [
    "host",
    "projectId",
    "mergeRequestIid",
    "sourceBranch",
    "targetBranch",
    "expectedHeadSha",
    "requesterIdentitySha256",
    "policyVersion",
    "grantVersion",
    "enabled",
    "operation",
  ]);
  if (root.enabled !== true || root.operation !== "update-existing-mr-source-branch")
    fail("policy-mismatch");
  return {
    host: kit.identifier(root.host),
    projectId: positive(root.projectId),
    mergeRequestIid: positive(root.mergeRequestIid),
    sourceBranch: kit.identifier(root.sourceBranch),
    targetBranch: kit.identifier(root.targetBranch),
    expectedHeadSha: kit.revision(root.expectedHeadSha),
    requesterIdentitySha256: kit.hash(root.requesterIdentitySha256),
    policyVersion: kit.enumeration(root.policyVersion, [
      UPDATE_EXISTING_MR_POLICY_VERSION,
    ] as const),
    grantVersion: positive(root.grantVersion),
    enabled: true,
    operation: "update-existing-mr-source-branch",
  };
}

function relativePath(value: unknown): string {
  const path = kit.string(value);
  if (
    !path ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  )
    fail("invalid-value");
  return path;
}

function positive(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    fail("invalid-value");
  return value;
}

function bool(value: unknown): boolean {
  if (typeof value !== "boolean") fail("invalid-value");
  return value;
}
