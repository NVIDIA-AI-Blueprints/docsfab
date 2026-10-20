// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The run record's `changeSources` contract: which sealed change-source
 * records a run bound, cited by their digest, pinned revision and observation
 * ids. The host derives every field from the acquired change, never from the
 * selector or request text, so the citation cannot disagree with the binding
 * the run read. The writer and every strict reader share this module.
 *
 * It records no commit subject, path or diff text; those stay inside the
 * manifest and diff observations it names.
 */
import { createContractKit, type ContractFail } from "../contract-kit/index.js";
import {
  CHANGE_SOURCE_KINDS,
  CHANGE_SOURCE_LABELS,
  CHANGE_SOURCE_OBJECT_FORMATS,
  CHANGE_SOURCE_PROVENANCES,
  CHANGE_SOURCE_RANGE_SEMANTICS,
  changeSourceProvenance,
  GIT_EMPTY_TREE_IDS,
  type ChangeSourceLabel,
  type ChangeSourceObjectFormat,
  type ChangeSourceProvenance,
  type ChangeSourceRangeSemantics,
} from "../inputs/change-source.js";
import type {
  AcquiredChangeSourceEntryV1,
  AcquiredChangeSourceV1,
} from "../inputs/change-source/acquisition.js";
import { SOURCE_AWARE_WORKFLOWS } from "../inputs/source-aware-workflows.js";
import {
  PINNED_REPOSITORY_IDENTITY_KINDS,
  type PinnedRepositoryIdentityV1,
} from "../inputs/change-source/revision.js";

export const RUN_CHANGE_SOURCE_KIND = "docsfab-run-change-source" as const;

/** Every observation role an acquired change carries; each entry names each exactly once. */
export const RUN_CHANGE_SOURCE_OBSERVATION_ROLES = [
  "manifest",
  "diff",
] as const satisfies readonly AcquiredChangeSourceEntryV1["role"][];
export type RunChangeSourceObservationRole = (typeof RUN_CHANGE_SOURCE_OBSERVATION_ROLES)[number];

/** Fails to typecheck while acquisition can emit a role the list above does not name. */
export const EVERY_ACQUIRED_ROLE_IS_CITED: [
  Exclude<AcquiredChangeSourceEntryV1["role"], RunChangeSourceObservationRole>,
] extends [never]
  ? true
  : never = true;

export interface RunChangeSourceObservationV1 {
  readonly role: RunChangeSourceObservationRole;
  readonly observationId: string;
}

/** One sealed change-source record the run bound. */
export interface RunChangeSourceV1 {
  readonly schemaVersion: 1;
  readonly kind: typeof RUN_CHANGE_SOURCE_KIND;
  /** The sealed record's `source.kind`; a reader admits `CHANGE_SOURCE_KINDS` only. */
  readonly sourceKind: string;
  readonly provenance: ChangeSourceProvenance;
  readonly repository: PinnedRepositoryIdentityV1;
  readonly objectFormat: ChangeSourceObjectFormat;
  readonly rangeSemantics: ChangeSourceRangeSemantics;
  /** Null when the pinned revision has no base, such as a root commit. */
  readonly base: string | null;
  readonly head: string;
  readonly mergeBase: string | null;
  readonly diffFrom: string | null;
  readonly labels: readonly ChangeSourceLabel[];
  readonly fileCount: number;
  readonly commitCount: number;
  readonly changeSourceSha256: string;
  /** One per acquired observation, in acquisition order. */
  readonly observations: readonly RunChangeSourceObservationV1[];
}

/** What the runner carries: present only with at least one bound change. */
export type RunChangeSourcesV1 = readonly [RunChangeSourceV1, ...RunChangeSourceV1[]];

/** Cite one acquired change. Generic over kinds: every field comes from the sealed record. */
export function runChangeSourceFromAcquired(acquired: AcquiredChangeSourceV1): RunChangeSourceV1 {
  const { changeSource } = acquired;
  return {
    schemaVersion: 1,
    kind: RUN_CHANGE_SOURCE_KIND,
    sourceKind: changeSource.source.kind,
    provenance: changeSourceProvenance(changeSource.source),
    repository: {
      kind: changeSource.revision.repository.kind,
      identitySha256: changeSource.revision.repository.identitySha256,
    },
    objectFormat: changeSource.objectFormat,
    rangeSemantics: changeSource.rangeSemantics,
    base: changeSource.revision.base ?? null,
    head: changeSource.revision.head,
    mergeBase: changeSource.mergeBase,
    diffFrom: changeSource.diffFrom,
    labels: [...changeSource.labels],
    fileCount: changeSource.files.length,
    commitCount: changeSource.commits.length,
    changeSourceSha256: changeSource.changeSourceSha256,
    observations: acquired.acquired.map((entry) => ({
      role: entry.role,
      observationId: entry.observation.observationId,
    })),
  };
}

export class RunChangeSourcesError extends Error {
  constructor() {
    super("Run record changeSources does not match the run change-source contract.");
    this.name = "RunChangeSourcesError";
  }
}

const fail: ContractFail<"invalid"> = () => {
  throw new RunChangeSourcesError();
};

const kit = createContractKit<"invalid">({
  fail,
  inertMode: "strict",
  codes: {
    invalidShape: "invalid",
    invalidValue: "invalid",
    digestMismatch: "invalid",
    credentialMaterial: "invalid",
    schemaMismatch: "invalid",
  },
});

const ENTRY_KEYS = [
  "schemaVersion",
  "kind",
  "sourceKind",
  "provenance",
  "repository",
  "objectFormat",
  "rangeSemantics",
  "base",
  "head",
  "mergeBase",
  "diffFrom",
  "labels",
  "fileCount",
  "commitCount",
  "changeSourceSha256",
  "observations",
] as const satisfies readonly (keyof RunChangeSourceV1)[];

/**
 * Admit only what the writer produces, on the workflows that bind a change:
 * a non-empty list of closed entries, unique by `changeSourceSha256`.
 */
export function decodeRunChangeSources(
  value: unknown,
  workflow: unknown,
): readonly RunChangeSourceV1[] {
  if (
    !(SOURCE_AWARE_WORKFLOWS as readonly unknown[]).includes(workflow) &&
    workflow !== "review-documentation"
  )
    fail("invalid");
  kit.assertInert(value);
  const entries = kit.array(value).map(decodeEntry);
  if (entries.length === 0) fail("invalid");
  kit.unique(entries.map((entry) => entry.changeSourceSha256));
  return entries;
}

function decodeEntry(value: unknown): RunChangeSourceV1 {
  const root = kit.object(value);
  kit.exact(root, ENTRY_KEYS);
  if (root.schemaVersion !== 1 || root.kind !== RUN_CHANGE_SOURCE_KIND) fail("invalid");
  const objectFormat = kit.enumeration(root.objectFormat, CHANGE_SOURCE_OBJECT_FORMATS);
  // The empty tree id fixes the width per format, so a SHA-1 id in a SHA-256
  // record refuses.
  const width = GIT_EMPTY_TREE_IDS[objectFormat].length;
  const objectId = (id: unknown): string => {
    const result = kit.revision(id);
    if (result.length !== width) fail("invalid");
    return result;
  };
  const nullableObjectId = (id: unknown): string | null => (id === null ? null : objectId(id));
  return {
    schemaVersion: 1,
    kind: RUN_CHANGE_SOURCE_KIND,
    sourceKind: kit.enumeration(root.sourceKind, CHANGE_SOURCE_KINDS),
    provenance: kit.enumeration(root.provenance, CHANGE_SOURCE_PROVENANCES),
    repository: decodeRepository(root.repository),
    objectFormat,
    rangeSemantics: kit.enumeration(root.rangeSemantics, CHANGE_SOURCE_RANGE_SEMANTICS),
    base: nullableObjectId(root.base),
    head: objectId(root.head),
    mergeBase: nullableObjectId(root.mergeBase),
    diffFrom: nullableObjectId(root.diffFrom),
    labels: decodeLabels(root.labels),
    fileCount: decodeCount(root.fileCount),
    commitCount: decodeCount(root.commitCount),
    changeSourceSha256: kit.hash(root.changeSourceSha256),
    observations: decodeObservations(root.observations),
  };
}

function decodeRepository(value: unknown): PinnedRepositoryIdentityV1 {
  const root = kit.object(value);
  kit.exact(root, ["kind", "identitySha256"]);
  return {
    kind: kit.enumeration(root.kind, PINNED_REPOSITORY_IDENTITY_KINDS),
    identitySha256: kit.hash(root.identitySha256),
  };
}

/** Strictly ascending, as the sealed record keeps them, so also unique. */
function decodeLabels(value: unknown): ChangeSourceLabel[] {
  const labels = kit.array(value).map((label) => kit.enumeration(label, CHANGE_SOURCE_LABELS));
  if (labels.some((label, index) => index > 0 && !(labels[index - 1]! < label))) fail("invalid");
  return labels;
}

/** A list length from the sealed record; zero is a real count. */
function decodeCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) fail("invalid");
  return value;
}

function decodeObservations(value: unknown): RunChangeSourceObservationV1[] {
  const observations = kit.array(value).map((item) => {
    const root = kit.object(item);
    kit.exact(root, ["role", "observationId"]);
    return {
      role: kit.enumeration(root.role, RUN_CHANGE_SOURCE_OBSERVATION_ROLES),
      observationId: kit.identifier(root.observationId),
    };
  });
  // Every role exactly once; with roles drawn from the list, that fixes the length too.
  for (const role of RUN_CHANGE_SOURCE_OBSERVATION_ROLES) {
    if (observations.filter((observation) => observation.role === role).length !== 1) {
      fail("invalid");
    }
  }
  kit.unique(observations.map((observation) => observation.observationId));
  return observations;
}
