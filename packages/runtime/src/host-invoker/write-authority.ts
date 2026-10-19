// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Host-minted scoped-write grant.
 *
 * Sealing is integrity, not authorization. A grant is honoured only when the
 * trusted host descriptor delivered it, every shared field equals the request
 * it rode on, and its declared write steps are exactly the write steps of the
 * workflow installed in this release.
 */
import type { WorkflowName } from "../workflow-contracts/contracts.js";
import { hostedBoundCapacity } from "./bound-capacity.js";
import type { HostRuntimeRequestV1 } from "./request.js";
import {
  bad,
  canonicalJson,
  digest,
  enumeration,
  freezeDeep,
  id,
  objectId,
  positive,
  record,
  segment,
  sha,
  timestamp,
  withinWriteCeiling,
  writePath,
} from "./wire-decode.js";

export const HOST_RUNTIME_WRITE_AUTHORITY_KIND = "docsfab-host-runtime-write-authority" as const;
/**
 * The hosted request contract stays read-only at schema version 1; only this
 * separate v2 grant, re-verified on arrival, can authorize a bounded write.
 * `authoritySha256` is an integrity binding, not a capability: a serialized
 * `allowWrite: true`, a self-consistent digest, prompt text, or a
 * caller-supplied receipt is refused.
 */
export const HOST_RUNTIME_WRITE_AUTHORITY_SCHEMA_VERSION = 2 as const;

export const HOST_RUNTIME_WRITE_OPERATIONS = ["add", "modify", "delete"] as const;
export type HostRuntimeWriteOperation = (typeof HOST_RUNTIME_WRITE_OPERATIONS)[number];

/**
 * The only Git file mode a documentation write may produce or replace. An
 * executable bit, symlink, or gitlink escapes a documentation ceiling, so any
 * other mode is refused rather than trimmed.
 */
export const HOST_RUNTIME_WRITE_FILE_MODE = "100644" as const;

/** Hard ceilings a request cannot raise from the inside. */
export const HOST_RUNTIME_WRITE_MAXIMUM_TARGETS = hostedBoundCapacity("writeAuthority.maxTargets");
export const HOST_RUNTIME_WRITE_MAXIMUM_PATCH_BYTES = hostedBoundCapacity(
  "writeAuthority.maxPatchBytes",
);
export const HOST_RUNTIME_WRITE_MAXIMUM_CEILING_ENTRIES = hostedBoundCapacity(
  "writeAuthority.maxCeilingEntries",
);
export const HOST_RUNTIME_WRITE_MAXIMUM_STEP_IDS = hostedBoundCapacity(
  "writeAuthority.maxWriteStepIds",
);

export const HOST_RUNTIME_WORKFLOWS = [
  "readiness",
  "release-documentation-readiness",
  "foundation",
  "bootstrap",
  "ia-analysis",
  "ia-plan",
  "site-bootstrap",
  "foundation-to-patch",
  "review-documentation",
  "create-documentation",
  "update-documentation",
  "restructure-documentation",
  "live-agent-turn",
  "reconcile-product-behavior",
] as const satisfies readonly WorkflowName[];

/**
 * One exactly bound target of a granted documentation write. `preimageObjectId`
 * is the blob the host measured at the frozen source tree `H`; a `modify` or
 * `delete` with a different observed preimage is refused.
 */
export interface HostRuntimeWriteTargetV2 {
  readonly path: string;
  readonly operations: readonly HostRuntimeWriteOperation[];
  readonly preimageObjectId: string | null;
  readonly fileMode: typeof HOST_RUNTIME_WRITE_FILE_MODE;
}

export interface HostRuntimeWriteAuthorityV2 {
  readonly schemaVersion: typeof HOST_RUNTIME_WRITE_AUTHORITY_SCHEMA_VERSION;
  readonly kind: typeof HOST_RUNTIME_WRITE_AUTHORITY_KIND;
  readonly deploymentId: string;
  readonly projectId: string;
  readonly deploymentEpoch: string;
  readonly requestKey: string;
  readonly runId: string;
  readonly fence: number;
  readonly workflow: WorkflowName;
  /** Source provenance `H`: the exact commit and its exact tree. */
  readonly sourceRevision: string;
  readonly sourceTreeObjectId: string;
  /** Repository-relative prefixes and exact files a new path may appear under. */
  readonly pathCeiling: readonly string[];
  readonly targets: readonly HostRuntimeWriteTargetV2[];
  /** The workflow's write steps. Must equal the installed workflow's exactly. */
  readonly writeStepIds: readonly string[];
  readonly capsuleSha256: string;
  readonly compositionSha256: string;
  readonly toolPolicySha256: string;
  readonly expiresAt: string;
  readonly limits: {
    readonly maximumChangedPaths: number;
    readonly maximumPatchBytes: number;
  };
  readonly authoritySha256: string;
}

/**
 * Seal a grant: the host supplies the body, this recomputes the binding digest.
 * Sealing is not authorizing; see `assertHostRuntimeWriteAuthorityBinding`.
 */
export function sealHostRuntimeWriteAuthority(
  input: Omit<HostRuntimeWriteAuthorityV2, "authoritySha256">,
): HostRuntimeWriteAuthorityV2 {
  return parseHostRuntimeWriteAuthority({ ...input, authoritySha256: digest(input) });
}

export function parseHostRuntimeWriteAuthority(input: unknown): HostRuntimeWriteAuthorityV2 {
  const root = record(input, [
    "schemaVersion",
    "kind",
    "deploymentId",
    "projectId",
    "deploymentEpoch",
    "requestKey",
    "runId",
    "fence",
    "workflow",
    "sourceRevision",
    "sourceTreeObjectId",
    "pathCeiling",
    "targets",
    "writeStepIds",
    "capsuleSha256",
    "compositionSha256",
    "toolPolicySha256",
    "expiresAt",
    "limits",
    "authoritySha256",
  ]);
  if (
    root.schemaVersion !== HOST_RUNTIME_WRITE_AUTHORITY_SCHEMA_VERSION ||
    root.kind !== HOST_RUNTIME_WRITE_AUTHORITY_KIND
  )
    bad("write-authority-version");
  if (
    !Array.isArray(root.pathCeiling) ||
    root.pathCeiling.length < 1 ||
    root.pathCeiling.length > HOST_RUNTIME_WRITE_MAXIMUM_CEILING_ENTRIES
  )
    bad("write-authority-ceiling");
  const pathCeiling = root.pathCeiling.map((value) => writePath(value, true));
  if (new Set(pathCeiling).size !== pathCeiling.length) bad("write-authority-ceiling");
  if (!Array.isArray(root.targets) || root.targets.length > HOST_RUNTIME_WRITE_MAXIMUM_TARGETS)
    bad("write-authority-limits");
  const targets = root.targets.map((value) => {
    const entry = record(value, ["path", "operations", "preimageObjectId", "fileMode"]);
    const path = writePath(entry.path, false);
    if (!withinWriteCeiling(path, pathCeiling)) bad("write-authority-target-outside-ceiling");
    if (entry.fileMode !== HOST_RUNTIME_WRITE_FILE_MODE) bad("write-authority-forbidden-file-mode");
    if (
      !Array.isArray(entry.operations) ||
      entry.operations.length < 1 ||
      entry.operations.length > HOST_RUNTIME_WRITE_OPERATIONS.length
    )
      bad("write-authority-target-shape");
    const operations = entry.operations.map((operation) =>
      enumeration(operation, HOST_RUNTIME_WRITE_OPERATIONS),
    );
    if (new Set(operations).size !== operations.length) bad("write-authority-target-shape");
    // A tracked target carries the blob the host measured at `H`; an `add`
    // target has no preimage. Anything else is an unbound target.
    const preimageObjectId =
      entry.preimageObjectId === null ? null : objectId(entry.preimageObjectId);
    if ((preimageObjectId === null) !== (operations.length === 1 && operations[0] === "add"))
      bad("write-authority-target-shape");
    return Object.freeze({
      path,
      operations: Object.freeze(operations),
      preimageObjectId,
      fileMode: HOST_RUNTIME_WRITE_FILE_MODE,
    });
  });
  if (new Set(targets.map((target) => target.path)).size !== targets.length)
    bad("write-authority-target-shape");
  if (
    !Array.isArray(root.writeStepIds) ||
    root.writeStepIds.length < 1 ||
    root.writeStepIds.length > HOST_RUNTIME_WRITE_MAXIMUM_STEP_IDS
  )
    bad("write-authority-step-catalog");
  const writeStepIds = root.writeStepIds.map((value) => id(value));
  if (new Set(writeStepIds).size !== writeStepIds.length) bad("write-authority-step-catalog");
  const limitsRoot = record(root.limits, ["maximumChangedPaths", "maximumPatchBytes"]);
  const maximumChangedPaths = positive(limitsRoot.maximumChangedPaths);
  const maximumPatchBytes = positive(limitsRoot.maximumPatchBytes);
  if (
    maximumChangedPaths > HOST_RUNTIME_WRITE_MAXIMUM_TARGETS ||
    maximumPatchBytes > HOST_RUNTIME_WRITE_MAXIMUM_PATCH_BYTES
  )
    bad("write-authority-limits");
  const body = {
    schemaVersion: HOST_RUNTIME_WRITE_AUTHORITY_SCHEMA_VERSION,
    kind: HOST_RUNTIME_WRITE_AUTHORITY_KIND,
    deploymentId: segment(root.deploymentId),
    projectId: segment(root.projectId),
    deploymentEpoch: segment(root.deploymentEpoch),
    requestKey: id(root.requestKey),
    runId: segment(root.runId),
    fence: positive(root.fence),
    workflow: enumeration(root.workflow, HOST_RUNTIME_WORKFLOWS),
    sourceRevision: objectId(root.sourceRevision),
    sourceTreeObjectId: objectId(root.sourceTreeObjectId),
    pathCeiling: Object.freeze(pathCeiling),
    targets: Object.freeze(targets),
    writeStepIds: Object.freeze(writeStepIds),
    capsuleSha256: sha(root.capsuleSha256),
    compositionSha256: sha(root.compositionSha256),
    toolPolicySha256: sha(root.toolPolicySha256),
    expiresAt: timestamp(root.expiresAt),
    limits: Object.freeze({ maximumChangedPaths, maximumPatchBytes }),
  };
  if (sha(root.authoritySha256) !== digest(body)) bad("write-authority-digest-mismatch");
  return freezeDeep({ ...body, authoritySha256: digest(body) });
}

/**
 * The admission check for a grant. `installedWriteStepIds` comes from the
 * workflow compiled into this release, so a grant that agrees with its request
 * but names write steps this release does not have is refused.
 */
export function assertHostRuntimeWriteAuthorityBinding(input: {
  authority: HostRuntimeWriteAuthorityV2;
  request: HostRuntimeRequestV1;
  installedWriteStepIds?: readonly string[];
  now?: Date;
}): void {
  const { authority, request } = input;
  if (
    authority.deploymentId !== request.deploymentId ||
    authority.projectId !== request.projectId ||
    authority.deploymentEpoch !== request.deploymentEpoch ||
    authority.requestKey !== request.requestKey ||
    authority.runId !== request.runId ||
    authority.fence !== request.fence ||
    authority.workflow !== request.workflow ||
    authority.sourceRevision !== request.revision ||
    authority.sourceTreeObjectId !== request.sourceTreeObjectId ||
    authority.capsuleSha256 !== request.capsule.sha256 ||
    authority.compositionSha256 !== request.composition.compositionSha256 ||
    authority.toolPolicySha256 !== request.toolPolicySha256
  )
    bad("write-authority-binding-mismatch");
  if (authority.writeStepIds.some((stepId) => !request.stepIds.includes(stepId)))
    bad("write-authority-step-substitution");
  if (Date.parse(authority.expiresAt) <= (input.now ?? new Date()).valueOf())
    bad("write-authority-expired");
  if (Date.parse(authority.expiresAt) > Date.parse(request.capsule.expiresAt))
    bad("write-authority-outlives-context");
  if (input.installedWriteStepIds !== undefined) {
    const granted = [...authority.writeStepIds].sort();
    const installed = [...input.installedWriteStepIds].sort();
    if (canonicalJson(granted) !== canonicalJson(installed))
      bad("write-authority-step-substitution");
  }
}
