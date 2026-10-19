// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Recompute a scoped documentation patch and its evidence.
 *
 * The candidate tree `T` is written from the disposable workspace with
 * `git write-tree`, and every change is read back from `git diff-index` against
 * the frozen source tree `H`, so a worker cannot describe its way out of the
 * grant's ceiling. Only the disposable checkout's index is touched, and it is
 * restored to `H` before returning.
 */
import { HostRuntimeContractError } from "./contract-error.js";
import {
  HOST_RUNTIME_WRITE_FILE_MODE,
  HOST_RUNTIME_WRITE_MAXIMUM_TARGETS,
  HOST_RUNTIME_WRITE_OPERATIONS,
  type HostRuntimeWriteAuthorityV2,
  type HostRuntimeWriteOperation,
} from "./write-authority.js";
import {
  bad,
  counter,
  digest,
  digestBytes,
  enumeration,
  freezeDeep,
  objectId,
  record,
  sha,
  withinWriteCeiling,
  writePath,
} from "./wire-decode.js";
import { MAX_GIT_OUTPUT_BYTES, runTrustedGit } from "./trusted-git.js";

export const HOST_RUNTIME_PATCH_EVIDENCE_KIND = "docsfab-host-runtime-patch-evidence" as const;

/** One realized change, recomputed from the candidate tree rather than claimed. */
export interface HostRuntimePatchChangeV1 {
  readonly path: string;
  readonly operation: HostRuntimeWriteOperation;
  readonly preimageObjectId: string | null;
  readonly postimageObjectId: string | null;
  readonly fileMode: typeof HOST_RUNTIME_WRITE_FILE_MODE;
}

/**
 * Bounded patch evidence: the exact candidate tree `T` and the accounting that
 * makes it checkable without shipping the patch body to every consumer.
 */
export interface HostRuntimePatchEvidenceV1 {
  readonly schemaVersion: 1;
  readonly kind: typeof HOST_RUNTIME_PATCH_EVIDENCE_KIND;
  readonly authoritySha256: string;
  readonly sourceRevision: string;
  readonly sourceTreeObjectId: string;
  /** The candidate tree `T`: `H` with the granted patch applied. */
  readonly candidateTreeObjectId: string;
  readonly changes: readonly HostRuntimePatchChangeV1[];
  readonly addedCount: number;
  readonly modifiedCount: number;
  readonly deletedCount: number;
  readonly patchBytes: number;
  readonly patchSha256: string;
  readonly evidenceSha256: string;
}

/**
 * Seal recomputed patch evidence against the grant that permitted it.
 *
 * Every rejection here is a refusal to record a write the grant did not cover:
 * a path outside the ceiling, an operation the target did not carry, a
 * preimage that proves the run did not start from `H`, a forbidden file mode,
 * or a change set past the grant's finite limits.
 */
export function sealHostRuntimePatchEvidence(input: {
  authority: HostRuntimeWriteAuthorityV2;
  candidateTreeObjectId: string;
  changes: readonly HostRuntimePatchChangeV1[];
  patch: string | null;
}): HostRuntimePatchEvidenceV1 {
  const { authority } = input;
  const candidateTreeObjectId = objectId(input.candidateTreeObjectId);
  if (input.changes.length > authority.limits.maximumChangedPaths) bad("patch-limit-exceeded");
  const byPath = new Map(authority.targets.map((target) => [target.path, target]));
  const changes = input.changes.map((change) => {
    const path = writePath(change.path, false);
    if (!withinWriteCeiling(path, authority.pathCeiling)) bad("patch-scope-escape");
    if (change.fileMode !== HOST_RUNTIME_WRITE_FILE_MODE) bad("patch-forbidden-file-mode");
    const operation = enumeration(change.operation, HOST_RUNTIME_WRITE_OPERATIONS);
    const target = byPath.get(path);
    if (operation === "add") {
      // An `add` is permitted anywhere under the ceiling, but never over a
      // path the grant already bound to a preimage: that is a modify wearing
      // an add's label.
      if (target && target.preimageObjectId !== null) bad("patch-operation-mismatch");
      if (change.preimageObjectId !== null || change.postimageObjectId === null)
        bad("patch-preimage-mismatch");
    } else {
      if (!target) bad("patch-scope-escape");
      if (!target.operations.includes(operation)) bad("patch-operation-mismatch");
      if (change.preimageObjectId !== target.preimageObjectId) bad("patch-preimage-mismatch");
      if ((change.postimageObjectId === null) !== (operation === "delete"))
        bad("patch-preimage-mismatch");
    }
    return Object.freeze({
      path,
      operation,
      preimageObjectId: change.preimageObjectId === null ? null : objectId(change.preimageObjectId),
      postimageObjectId:
        change.postimageObjectId === null ? null : objectId(change.postimageObjectId),
      fileMode: HOST_RUNTIME_WRITE_FILE_MODE,
    });
  });
  if (new Set(changes.map((change) => change.path)).size !== changes.length)
    bad("patch-scope-escape");
  const patchBytes = input.patch === null ? 0 : Buffer.byteLength(input.patch);
  if (patchBytes > authority.limits.maximumPatchBytes) bad("patch-limit-exceeded");
  if ((patchBytes === 0) !== (changes.length === 0)) bad("patch-accounting-mismatch");
  const body = {
    schemaVersion: 1 as const,
    kind: HOST_RUNTIME_PATCH_EVIDENCE_KIND,
    authoritySha256: authority.authoritySha256,
    sourceRevision: authority.sourceRevision,
    sourceTreeObjectId: authority.sourceTreeObjectId,
    candidateTreeObjectId,
    changes: Object.freeze([...changes].sort((a, b) => (a.path < b.path ? -1 : 1))),
    addedCount: changes.filter((change) => change.operation === "add").length,
    modifiedCount: changes.filter((change) => change.operation === "modify").length,
    deletedCount: changes.filter((change) => change.operation === "delete").length,
    patchBytes,
    patchSha256: digestBytes(Buffer.from(input.patch ?? "")),
  };
  return freezeDeep({ ...body, evidenceSha256: digest(body) });
}

export function parseHostRuntimePatchEvidence(input: unknown): HostRuntimePatchEvidenceV1 {
  const root = record(input, [
    "schemaVersion",
    "kind",
    "authoritySha256",
    "sourceRevision",
    "sourceTreeObjectId",
    "candidateTreeObjectId",
    "changes",
    "addedCount",
    "modifiedCount",
    "deletedCount",
    "patchBytes",
    "patchSha256",
    "evidenceSha256",
  ]);
  if (root.schemaVersion !== 1 || root.kind !== HOST_RUNTIME_PATCH_EVIDENCE_KIND)
    bad("invalid-patch-evidence");
  if (!Array.isArray(root.changes) || root.changes.length > HOST_RUNTIME_WRITE_MAXIMUM_TARGETS)
    bad("invalid-patch-evidence");
  const changes = root.changes.map((value) => {
    const entry = record(value, [
      "path",
      "operation",
      "preimageObjectId",
      "postimageObjectId",
      "fileMode",
    ]);
    if (entry.fileMode !== HOST_RUNTIME_WRITE_FILE_MODE) bad("patch-forbidden-file-mode");
    return Object.freeze({
      path: writePath(entry.path, false),
      operation: enumeration(entry.operation, HOST_RUNTIME_WRITE_OPERATIONS),
      preimageObjectId: entry.preimageObjectId === null ? null : objectId(entry.preimageObjectId),
      postimageObjectId:
        entry.postimageObjectId === null ? null : objectId(entry.postimageObjectId),
      fileMode: HOST_RUNTIME_WRITE_FILE_MODE,
    });
  });
  const body = {
    schemaVersion: 1 as const,
    kind: HOST_RUNTIME_PATCH_EVIDENCE_KIND,
    authoritySha256: sha(root.authoritySha256),
    sourceRevision: objectId(root.sourceRevision),
    sourceTreeObjectId: objectId(root.sourceTreeObjectId),
    candidateTreeObjectId: objectId(root.candidateTreeObjectId),
    changes: Object.freeze(changes),
    addedCount: counter(root.addedCount),
    modifiedCount: counter(root.modifiedCount),
    deletedCount: counter(root.deletedCount),
    patchBytes: counter(root.patchBytes),
    patchSha256: sha(root.patchSha256),
  };
  if (
    body.addedCount !== changes.filter((change) => change.operation === "add").length ||
    body.modifiedCount !== changes.filter((change) => change.operation === "modify").length ||
    body.deletedCount !== changes.filter((change) => change.operation === "delete").length
  )
    bad("patch-accounting-mismatch");
  if (sha(root.evidenceSha256) !== digest(body)) bad("patch-evidence-digest-mismatch");
  return freezeDeep({ ...body, evidenceSha256: digest(body) });
}

/** `git diff-index -z` status letters this seam accepts at all. */
const DIFF_STATUS: Readonly<Record<string, HostRuntimePatchChangeV1["operation"]>> = {
  A: "add",
  M: "modify",
  D: "delete",
};

const NULL_OBJECT = /^0+$/u;

export async function recomputeHostedPatchEvidence(input: {
  workspacePath: string;
  authority: HostRuntimeWriteAuthorityV2;
  signal?: AbortSignal;
}): Promise<{ patch: string | null; evidence: HostRuntimePatchEvidenceV1 }> {
  const { workspacePath, authority, signal } = input;
  // Stage untracked additions and removals too; a worktree-only patch would
  // silently drop new files.
  await runTrustedGit(workspacePath, ["add", "-A", "--", "."], signal);
  const candidateTreeObjectId = (await runTrustedGit(workspacePath, ["write-tree"], signal))
    .toString("utf8")
    .trim();
  const raw = (
    await runTrustedGit(
      workspacePath,
      ["diff-index", "--cached", "--no-renames", "--raw", "-z", authority.sourceTreeObjectId, "--"],
      signal,
      MAX_GIT_OUTPUT_BYTES,
    )
  ).toString("utf8");
  const patchBuffer = await runTrustedGit(
    workspacePath,
    [
      "diff",
      "--binary",
      "--no-ext-diff",
      "--no-renames",
      "--cached",
      authority.sourceTreeObjectId,
      "--",
    ],
    signal,
    MAX_GIT_OUTPUT_BYTES,
  );
  // Restore the index as the run found it; patch and tree are already captured.
  await runTrustedGit(workspacePath, ["read-tree", authority.sourceTreeObjectId], signal);
  const patch = patchBuffer.length > 0 ? patchBuffer.toString("utf8") : null;
  const evidence = sealHostRuntimePatchEvidence({
    authority,
    candidateTreeObjectId,
    changes: parseRawDiff(raw),
    patch,
  });
  return { patch, evidence };
}

/**
 * Decode `git diff-index --raw -z`.
 *
 * Each entry is `:<srcmode> <dstmode> <srcsha> <dstsha> <status>\0<path>\0`.
 * A mode outside `100644` on either side is refused here rather than carried
 * into the evidence: that is the executable-bit, symlink and gitlink escape,
 * and it must fail before anything records a "documentation" change.
 */
export function parseRawDiff(raw: string): readonly HostRuntimePatchChangeV1[] {
  const fields = raw.split("\0");
  const changes: HostRuntimePatchChangeV1[] = [];
  let index = 0;
  while (index < fields.length) {
    const header = fields[index];
    if (header === undefined || header === "") break;
    if (!header.startsWith(":")) throw refuse("patch-raw-diff-shape");
    const parts = header.slice(1).split(" ");
    const path = fields[index + 1];
    if (parts.length !== 5 || path === undefined || path === "")
      throw refuse("patch-raw-diff-shape");
    const [sourceMode, targetMode, sourceObject, targetObject, status] = parts as [
      string,
      string,
      string,
      string,
      string,
    ];
    const operation = DIFF_STATUS[status];
    if (!operation) throw refuse("patch-operation-mismatch");
    const modes = [sourceMode, targetMode].filter((mode) => !NULL_OBJECT.test(mode));
    if (modes.some((mode) => mode !== HOST_RUNTIME_WRITE_FILE_MODE))
      throw refuse("patch-forbidden-file-mode");
    changes.push({
      path,
      operation,
      preimageObjectId: NULL_OBJECT.test(sourceObject) ? null : sourceObject,
      postimageObjectId: NULL_OBJECT.test(targetObject) ? null : targetObject,
      fileMode: HOST_RUNTIME_WRITE_FILE_MODE,
    });
    index += 2;
  }
  return changes;
}

function refuse(code: string): HostRuntimeContractError {
  return new HostRuntimeContractError(code);
}
