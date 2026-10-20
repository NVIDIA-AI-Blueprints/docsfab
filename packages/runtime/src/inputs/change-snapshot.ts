// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Immutable code-change facts. Decoding this record confers no read authority. */
import { createContractKit, UNSAFE_PATH_CODE_POINT } from "../contract-kit/index.js";
import { decodeChangeRequestRef, type ChangeRequestRefV1 } from "./change-request.js";

export const CHANGE_SNAPSHOT_KIND = "docsfab-change-snapshot" as const;

export interface ChangeSnapshotGraphV1 {
  readonly B: string;
  readonly H: string;
  readonly M: string;
  readonly baseTree: string;
  readonly headTree: string;
  readonly mergeTree: string;
  readonly proposalCommits: number;
}

export interface ChangeSnapshotManifestRowV1 {
  readonly status: string;
  readonly oldPath: string | null;
  readonly newPath: string | null;
  readonly oldMode: string;
  readonly newMode: string;
  readonly oldId: string | null;
  readonly newId: string | null;
  readonly content: "regular" | "symlink" | "gitlink" | "unsupported";
}

/** Original side identity, including an honest absent derivative observation. */
export interface ChangeSnapshotSourceSideV1 {
  readonly side: "before" | "after";
  readonly path: string;
  readonly repositoryId: string;
  readonly blobId: string;
  readonly originalSha256: string;
  readonly originalByteLength: number;
  readonly observationId: string | null;
  readonly observationSha256: string | null;
}

export interface ChangeSnapshotLimitationV1 {
  readonly side: "before" | "after";
  readonly path: string;
  readonly reason: "unsupported-content" | "empty-extraction" | "partial-extraction";
}

export interface ChangeSnapshotV1 {
  readonly schemaVersion: 1;
  readonly kind: typeof CHANGE_SNAPSHOT_KIND;
  readonly ref: ChangeRequestRefV1;
  readonly sourceRepositoryId: string;
  readonly graph: ChangeSnapshotGraphV1;
  readonly manifest: ChangeSnapshotManifestRowV1[];
  readonly sourceSides: ChangeSnapshotSourceSideV1[];
  readonly sourceBindingSha256: string | null;
  readonly limitations: ChangeSnapshotLimitationV1[];
  readonly completeness: "complete";
  readonly snapshotSha256: string;
}

export type ChangeSnapshotErrorCode =
  | "change-snapshot-invalid-shape"
  | "change-snapshot-invalid-value"
  | "change-snapshot-credential-material"
  | "change-snapshot-schema-mismatch"
  | "change-snapshot-digest-mismatch";

export class ChangeSnapshotError extends Error {
  constructor(readonly code: ChangeSnapshotErrorCode) {
    super(code);
    this.name = "ChangeSnapshotError";
  }
}

function fail(code: ChangeSnapshotErrorCode): never {
  throw new ChangeSnapshotError(code);
}

const kit = createContractKit<ChangeSnapshotErrorCode>({
  fail,
  codes: {
    invalidShape: "change-snapshot-invalid-shape",
    invalidValue: "change-snapshot-invalid-value",
    credentialMaterial: "change-snapshot-credential-material",
    schemaMismatch: "change-snapshot-schema-mismatch",
    digestMismatch: "change-snapshot-digest-mismatch",
  },
});

const MODE = /^(?:0|[0-7]{6})$/u;
const STATUS = /^[A-Z][0-9]*$/u;
const POSITIVE_DECIMAL = /^[1-9][0-9]*$/u;

function repositoryId(value: unknown): string {
  const text = kit.string(value);
  if (!POSITIVE_DECIMAL.test(text) || !Number.isSafeInteger(Number(text)))
    fail("change-snapshot-invalid-value");
  return text;
}

function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    fail("change-snapshot-invalid-value");
  return value;
}

function graph(value: unknown): ChangeSnapshotGraphV1 {
  const root = kit.object(value);
  kit.exact(root, ["B", "H", "M", "baseTree", "headTree", "mergeTree", "proposalCommits"]);
  const ids = [
    kit.revision(root.B),
    kit.revision(root.H),
    kit.revision(root.M),
    kit.revision(root.baseTree),
    kit.revision(root.headTree),
    kit.revision(root.mergeTree),
  ];
  if (new Set(ids.map((id) => id.length)).size !== 1) fail("change-snapshot-invalid-value");
  return {
    B: ids[0]!,
    H: ids[1]!,
    M: ids[2]!,
    baseTree: ids[3]!,
    headTree: ids[4]!,
    mergeTree: ids[5]!,
    proposalCommits: count(root.proposalCommits),
  };
}

function nullablePath(value: unknown): string | null {
  return value === null ? null : exactPath(value);
}

/** Git tree paths are byte identities: NFC conversion can name a different blob. */
function exactPath(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.startsWith("/") ||
    /^[A-Za-z]:/u.test(value) ||
    value.includes("\\") ||
    UNSAFE_PATH_CODE_POINT.test(value) ||
    value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  )
    fail("change-snapshot-invalid-value");
  return value;
}

function nullableRevision(value: unknown): string | null {
  return value === null ? null : kit.revision(value);
}

function mode(value: unknown): string {
  const result = kit.string(value);
  if (!MODE.test(result)) fail("change-snapshot-invalid-value");
  return result;
}

function manifestRow(value: unknown): ChangeSnapshotManifestRowV1 {
  const root = kit.object(value);
  kit.exact(root, [
    "status",
    "oldPath",
    "newPath",
    "oldMode",
    "newMode",
    "oldId",
    "newId",
    "content",
  ]);
  const status = kit.string(root.status);
  if (!STATUS.test(status)) fail("change-snapshot-invalid-value");
  const oldPath = nullablePath(root.oldPath);
  const newPath = nullablePath(root.newPath);
  const oldId = nullableRevision(root.oldId);
  const newId = nullableRevision(root.newId);
  const oldMode = mode(root.oldMode);
  const newMode = mode(root.newMode);
  if ((oldPath === null) !== (oldId === null) || (newPath === null) !== (newId === null))
    fail("change-snapshot-invalid-value");
  if (oldId === null && newId === null) fail("change-snapshot-invalid-value");
  const absentMode = (value: string) => value === "0" || value === "000000";
  if ((oldPath === null) !== absentMode(oldMode) || (newPath === null) !== absentMode(newMode))
    fail("change-snapshot-invalid-value");
  return {
    status,
    oldPath,
    newPath,
    oldMode,
    newMode,
    oldId,
    newId,
    content: kit.enumeration(root.content, [
      "regular",
      "symlink",
      "gitlink",
      "unsupported",
    ] as const),
  };
}

function sourceSide(value: unknown): ChangeSnapshotSourceSideV1 {
  const root = kit.object(value);
  kit.exact(root, [
    "side",
    "path",
    "repositoryId",
    "blobId",
    "originalSha256",
    "originalByteLength",
    "observationId",
    "observationSha256",
  ]);
  const observationId = root.observationId === null ? null : kit.identifier(root.observationId);
  const observationSha256 =
    root.observationSha256 === null ? null : kit.hash(root.observationSha256);
  if ((observationId === null) !== (observationSha256 === null))
    fail("change-snapshot-invalid-value");
  return {
    side: kit.enumeration(root.side, ["before", "after"] as const),
    path: exactPath(root.path),
    repositoryId: repositoryId(root.repositoryId),
    blobId: kit.revision(root.blobId),
    originalSha256: kit.hash(root.originalSha256),
    originalByteLength: count(root.originalByteLength),
    observationId,
    observationSha256,
  };
}

function limitation(value: unknown): ChangeSnapshotLimitationV1 {
  const root = kit.object(value);
  kit.exact(root, ["side", "path", "reason"]);
  return {
    side: kit.enumeration(root.side, ["before", "after"] as const),
    path: exactPath(root.path),
    reason: kit.enumeration(root.reason, [
      "unsupported-content",
      "empty-extraction",
      "partial-extraction",
    ] as const),
  };
}

function body(root: Record<string, unknown>) {
  const ref = decodeChangeRequestRef(root.ref);
  const sourceRepositoryId = repositoryId(root.sourceRepositoryId);
  const checkedGraph = graph(root.graph);
  const manifest = kit.array(root.manifest).map(manifestRow);
  const sourceSides = kit.array(root.sourceSides).map(sourceSide);
  const limitations = kit.array(root.limitations).map(limitation);
  const sourceBindingSha256 =
    root.sourceBindingSha256 === null ? null : kit.hash(root.sourceBindingSha256);
  if (root.completeness !== "complete") fail("change-snapshot-invalid-value");
  if (sourceSides.some((side) => side.observationId !== null) && sourceBindingSha256 === null)
    fail("change-snapshot-invalid-value");
  const seen = new Set<string>();
  for (const side of sourceSides) {
    const key = `${side.side}\0${side.path}`;
    if (seen.has(key)) fail("change-snapshot-invalid-value");
    seen.add(key);
    const matching = manifest.some((row) =>
      side.side === "before"
        ? row.oldPath === side.path && row.oldId === side.blobId && /^100/u.test(row.oldMode)
        : row.newPath === side.path && row.newId === side.blobId && /^100/u.test(row.newMode),
    );
    if (
      !matching ||
      (side.side === "before" && side.repositoryId !== ref.targetRepositoryId) ||
      (side.side === "after" && side.repositoryId !== sourceRepositoryId)
    )
      fail("change-snapshot-invalid-value");
  }
  const limited = new Set<string>();
  for (const entry of limitations) {
    const key = `${entry.side}\0${entry.path}`;
    if (limited.has(key)) fail("change-snapshot-invalid-value");
    limited.add(key);
    if (
      !manifest.some((row) =>
        entry.side === "before" ? row.oldPath === entry.path : row.newPath === entry.path,
      )
    )
      fail("change-snapshot-invalid-value");
    const hasObservation = sourceSides.some(
      (side) => side.side === entry.side && side.path === entry.path && side.observationId !== null,
    );
    if (entry.reason === "partial-extraction" && !hasObservation)
      fail("change-snapshot-invalid-value");
    // Empty normalized extraction can still have an exact-original UTF-8
    // representation (including the zero-byte witness). Its sealed side is
    // independently checked against live custody before a source read.
    if (
      entry.reason !== "partial-extraction" &&
      entry.reason !== "empty-extraction" &&
      hasObservation
    )
      fail("change-snapshot-invalid-value");
  }
  return {
    ref,
    sourceRepositoryId,
    graph: checkedGraph,
    manifest,
    sourceSides,
    sourceBindingSha256,
    limitations,
    completeness: "complete" as const,
  };
}

const BODY_KEYS = [
  "ref",
  "sourceRepositoryId",
  "graph",
  "manifest",
  "sourceSides",
  "sourceBindingSha256",
  "limitations",
  "completeness",
];

export function createChangeSnapshot(
  input: Omit<ChangeSnapshotV1, "schemaVersion" | "kind" | "snapshotSha256">,
): ChangeSnapshotV1 {
  kit.assertInert(input);
  kit.rejectCredentials(input);
  const root = kit.object(input);
  kit.exact(root, BODY_KEYS);
  return kit.seal(CHANGE_SNAPSHOT_KIND, "snapshotSha256", body(root));
}

export function decodeChangeSnapshot(value: unknown): ChangeSnapshotV1 {
  return kit.decodeSealed(value, CHANGE_SNAPSHOT_KIND, "snapshotSha256", BODY_KEYS, body);
}
