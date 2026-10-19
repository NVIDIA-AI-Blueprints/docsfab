// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Integrity of an existing approved baseline transport; never an approval grant. */
import { createHash } from "node:crypto";
import { LIMIT_DEFINITION_BY_NAME } from "../config/limits.generated.js";
import { createContractKit, deepFreeze } from "../contract-kit/index.js";
import { HostRuntimeContractError } from "./contract-error.js";

function fail(): never {
  throw new HostRuntimeContractError("approved-model-binding");
}
const kit = createContractKit({
  fail,
  inertMode: "strict",
  codes: {
    invalidShape: "invalid-shape",
    invalidValue: "invalid-value",
    digestMismatch: "digest-mismatch",
    credentialMaterial: "credential-material",
    schemaMismatch: "schema-version",
  },
});

/** A protocol constant, not an operational limit: any other value is a migration. */
const APPROVED_MODEL_ENVELOPE_SCHEMA_VERSION = 1;

/** Catalog name of the staged-baseline byte capacity both sides declare. */
export const HOST_RUNTIME_APPROVED_MODEL_BASELINE_BYTES_LIMIT =
  "hostInvoker.approvedModelBaselineMaxBytes" as const;

/**
 * Admitted size of the private file this reference names, checked before the
 * loader allocates it. Read from the generated catalog, not `limit()`: the host
 * staging producer declares the same sealed entry, so neither side may shrink
 * it alone.
 */
export const HOST_RUNTIME_APPROVED_MODEL_BASELINE_MAXIMUM_BYTES = (() => {
  const definition = LIMIT_DEFINITION_BY_NAME[HOST_RUNTIME_APPROVED_MODEL_BASELINE_BYTES_LIMIT];
  if (!definition) {
    throw new Error(
      `Approved-model baseline limit ${HOST_RUNTIME_APPROVED_MODEL_BASELINE_BYTES_LIMIT} is missing from config/limits.yaml.`,
    );
  }
  return definition.max;
})();

/** The private file contains the exact baseline returned by the trusted reader. */
export interface HostRuntimeApprovedModelReferenceV1 {
  readonly contentSha256: string;
  readonly bytes: number;
  readonly baselineSha256: string;
  readonly snapshotSha256: string;
  readonly generation: number;
  readonly streamVersion: number;
}

export function parseHostRuntimeApprovedModelReference(
  value: unknown,
): HostRuntimeApprovedModelReferenceV1 {
  kit.assertInert(value);
  const row = kit.object(value);
  kit.exact(row, [
    "contentSha256",
    "bytes",
    "baselineSha256",
    "snapshotSha256",
    "generation",
    "streamVersion",
  ]);
  for (const key of ["bytes", "generation", "streamVersion"]) {
    if (!Number.isSafeInteger(row[key]) || (row[key] as number) < (key === "bytes" ? 1 : 0)) fail();
  }
  // The loader trusts this number for its own buffer.
  if ((row.bytes as number) > HOST_RUNTIME_APPROVED_MODEL_BASELINE_MAXIMUM_BYTES) fail();
  return deepFreeze({
    contentSha256: kit.hash(row.contentSha256),
    bytes: row.bytes as number,
    baselineSha256: kit.hash(row.baselineSha256),
    snapshotSha256: kit.hash(row.snapshotSha256),
    generation: row.generation as number,
    streamVersion: row.streamVersion as number,
  });
}

/**
 * Canonical JSON exactly as the approved-model producers emit it, byte for byte:
 * keys sorted lexicographically in the emitted bytes (`feedbackJson` in the
 * knowledge admission, `json.dumps(sort_keys=True, separators=(",", ":"),
 * ensure_ascii=False)` in the model projector).
 *
 * The shared content-IR canonicalization rebuilds the object, and JavaScript
 * moves integer-like keys ahead numerically (`{"10":..,"2":..}` becomes
 * `{"2":..,"10":..}`), which would refuse an already admitted record. Emit the
 * bytes directly.
 */
function producerCanonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (Array.isArray(value)) return `[${value.map(producerCanonicalJson).join(",")}]`;
  // A value a producer's canonicalizer would have thrown on cannot match any
  // producer digest; refuse instead of inventing bytes.
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype)
    fail();
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${producerCanonicalJson(row[key])}`)
    .join(",")}}`;
}

/** SHA-256 over the producer's canonical bytes: the seal this parser re-checks. */
function producerDigest(value: unknown): string {
  return createHash("sha256").update(producerCanonicalJson(value)).digest("hex");
}

/**
 * Re-verify one producer-sealed envelope against the producer's own bytes.
 *
 * Not the shared `decodeSealed`, which re-seals through the runtime's own
 * canonicalization. Its other checks are kept: inert shape, credential
 * screening, an exact key set, and the declared schema version and kind.
 */
function sealed(
  value: unknown,
  kind: string,
  digestKey: string,
  keys: string[],
): Record<string, unknown> {
  kit.assertInert(value);
  kit.rejectCredentials(value);
  const root = kit.object(value);
  kit.exact(root, ["schemaVersion", "kind", ...keys, digestKey]);
  // A later producer version is migrated, never guessed at.
  if (root.schemaVersion !== APPROVED_MODEL_ENVELOPE_SCHEMA_VERSION || root.kind !== kind) fail();
  const body: Record<string, unknown> = { schemaVersion: root.schemaVersion, kind: root.kind };
  for (const key of keys) body[key] = root[key];
  // The producer seals the body without its own digest field; its
  // canonicalization sorts at emit time, so insertion order is irrelevant.
  if (producerDigest(body) !== kit.hash(root[digestKey])) fail();
  return root;
}
function path(value: unknown): string {
  const result = kit.string(value);
  if (
    !result ||
    /[\\\0\r\n]/u.test(result) ||
    result.split("/").some((part) => !part || part === "." || part === "..")
  )
    fail();
  return result;
}

export interface HostRuntimeApprovedModelData {
  readonly modelId: string;
  readonly version: string;
  readonly revision: string;
  readonly tree: string;
  readonly sourceClosureSha256: string;
  readonly files: readonly { path: string; sha256: string }[];
  readonly claims: readonly { id: string; sourcePath: string; record: Record<string, unknown> }[];
  readonly openConflicts: readonly {
    id: string;
    sourcePath: string;
    record: Record<string, unknown>;
  }[];
}

/**
 * Decode bytes already authenticated by native custody. This verifies the full
 * retained source closure and generation association, not currentness or approval.
 * The host's existing approved-model reader supplies those before staging.
 */
export function parseHostRuntimeApprovedModelData(input: {
  value: unknown;
  reference: HostRuntimeApprovedModelReferenceV1;
  projectId: string;
  canon: { sha256: string; sourcePathSha256: string; gitObjectId: string };
}): HostRuntimeApprovedModelData {
  const { value, canon } = input,
    reference = parseHostRuntimeApprovedModelReference(input.reference);
  kit.assertInert(value);
  kit.rejectCredentials(value);
  const baseline = sealed(value, "docsfab-approved-model-baseline", "baselineSha256", [
    "projectId",
    "generation",
    "streamVersion",
    "snapshot",
    "canon",
    "approval",
  ]);
  const snapshot = sealed(baseline.snapshot, "docsfab-reference-model-snapshot", "snapshotSha256", [
    "projectId",
    "modelId",
    "version",
    "state",
    "revision",
    "tree",
    "modelPath",
    "modelSha256",
    "modelGitObjectId",
    "files",
    "sourceClosureSha256",
    "claims",
    "openConflicts",
  ]);
  const authority = kit.object(baseline.approval),
    selected = kit.object(baseline.canon);
  kit.exact(authority, [
    "projectId",
    "modelId",
    "version",
    "streamVersion",
    "modelSha256",
    "snapshotSha256",
    "principalId",
    "authorityReceiptSha256",
    "approvalEvidenceSha256",
    "scope",
  ]);
  kit.exact(selected, ["sha256", "sourcePath", "gitObjectId"]);
  kit.identifier(authority.principalId);
  kit.hash(authority.authorityReceiptSha256);
  kit.hash(authority.approvalEvidenceSha256);
  const modelId = kit.identifier(snapshot.modelId),
    version = kit.string(snapshot.version);
  const modelPath = path(snapshot.modelPath);
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(modelId) ||
    !/^v\d+\.\d+$/u.test(version) ||
    modelPath !== `.docsfab/reference-model/shared/${modelId}/${version}/model.md` ||
    snapshot.state !== "candidate" ||
    baseline.projectId !== input.projectId ||
    snapshot.projectId !== input.projectId ||
    authority.projectId !== input.projectId ||
    baseline.generation !== reference.generation ||
    baseline.streamVersion !== reference.streamVersion ||
    baseline.baselineSha256 !== reference.baselineSha256 ||
    snapshot.snapshotSha256 !== reference.snapshotSha256 ||
    authority.scope !== "model-version" ||
    authority.modelId !== modelId ||
    authority.version !== version ||
    authority.streamVersion !== reference.streamVersion ||
    authority.modelSha256 !== canon.sha256 ||
    authority.snapshotSha256 !== reference.snapshotSha256 ||
    selected.sha256 !== canon.sha256 ||
    snapshot.modelSha256 !== canon.sha256 ||
    selected.sourcePath !== modelPath ||
    selected.gitObjectId !== canon.gitObjectId ||
    snapshot.modelGitObjectId !== canon.gitObjectId ||
    createHash("sha256").update(modelPath).digest("hex") !== canon.sourcePathSha256
  )
    fail();
  // Path hash uses SHA-256 of the literal path, unlike canonical JSON hashes.
  const files = kit.array(snapshot.files).map((value) => {
    const row = kit.object(value);
    kit.exact(row, ["path", "sha256"]);
    return { path: path(row.path), sha256: kit.hash(row.sha256) };
  });
  const paths = new Set(files.map((file) => file.path));
  if (
    paths.size !== files.length ||
    !files.some((file) => file.path === modelPath && file.sha256 === canon.sha256)
  )
    fail();
  const sourceFiles = Object.fromEntries(
    files
      .filter((file) => file.path.startsWith(".docsfab/reference-model/source-threads/"))
      .map((file) => [file.path, file.sha256]),
  );
  if (producerDigest(sourceFiles) !== kit.hash(snapshot.sourceClosureSha256)) fail();
  function records(name: "claims" | "openConflicts", idKey: "claim_id" | "conflict_id") {
    const ids = new Set<string>();
    return kit.array(snapshot[name]).map((value) => {
      const row = kit.object(value);
      kit.exact(row, ["id", "sourcePath", "record", "recordSha256"]);
      const id = kit.identifier(row.id),
        sourcePath = path(row.sourcePath),
        record = kit.object(row.record);
      if (
        ids.has(id) ||
        !paths.has(sourcePath) ||
        record[idKey] !== id ||
        producerDigest(record) !== kit.hash(row.recordSha256) ||
        (name === "openConflicts" && record.status !== "open")
      )
        fail();
      ids.add(id);
      return { id, sourcePath, record };
    });
  }
  const claims = records("claims", "claim_id");
  if (!claims.length) fail();
  return deepFreeze({
    modelId,
    version,
    revision: kit.revision(snapshot.revision),
    tree: kit.revision(snapshot.tree),
    sourceClosureSha256: kit.hash(snapshot.sourceClosureSha256),
    files,
    claims,
    openConflicts: records("openConflicts", "conflict_id"),
  });
}
