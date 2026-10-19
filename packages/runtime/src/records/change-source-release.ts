// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The run record's `changeSourceRelease` contract: the sealed units index a
 * release-range run bound. `changeSources` cites each unit record the page
 * bound; the index lists units and is no change record, so it is cited here,
 * with the page it fixed: how many units it bound or omitted, how many remain,
 * and the selector that continues the release. The host derives every field
 * from the acquired index, never from the selector or request text.
 */
import { createContractKit, type ContractFail } from "../contract-kit/index.js";
import {
  CHANGE_SOURCE_OBJECT_FORMATS,
  failChangeSource,
  GIT_EMPTY_TREE_IDS,
  type ChangeSourceObjectFormat,
} from "../inputs/change-source.js";
import {
  releaseContinuationSelector,
  type AcquiredReleaseRangeV1,
} from "../inputs/change-source/release.js";
import {
  PINNED_REPOSITORY_IDENTITY_KINDS,
  type PinnedRepositoryIdentityV1,
} from "../inputs/change-source/revision.js";
import { SOURCE_AWARE_WORKFLOWS } from "../inputs/source-aware-workflows.js";
import {
  decodeRunChangeSources,
  runChangeSourceFromAcquired,
  type RunChangeSourcesV1,
  type RunChangeSourceV1,
} from "./change-sources.js";

export const RUN_CHANGE_SOURCE_RELEASE_KIND = "docsfab-run-change-source-release" as const;

/** The units index a release-range run bound, and the page it fixed. */
export interface RunChangeSourceReleaseV1 {
  readonly schemaVersion: 1;
  readonly kind: typeof RUN_CHANGE_SOURCE_RELEASE_KIND;
  readonly repository: PinnedRepositoryIdentityV1;
  readonly objectFormat: ChangeSourceObjectFormat;
  readonly base: string;
  readonly head: string;
  readonly releaseUnitsSha256: string;
  readonly observationId: string;
  /** Every first-parent unit the index lists: this page's and later pages'. */
  readonly units: number;
  /** Units on this page; each is cited in `changeSources` or listed as omitted. */
  readonly pageUnits: number;
  readonly omittedUnits: number;
  readonly remainingUnits: number;
  /** The selector that binds the next page; null when nothing remains. */
  readonly continuation: string | null;
}

/**
 * One `changeSources` entry per unit record the page bound, in index order.
 * The index and the acquired records must agree exactly, so a record the index
 * does not name as bound, or a bound unit without its record, refuses.
 * Undefined when every unit on the page was omitted.
 */
export function runChangeSourcesFromRelease(
  acquired: AcquiredReleaseRangeV1,
): RunChangeSourcesV1 | undefined {
  const records = new Map(
    acquired.units.map((unit) => [unit.changeSource.changeSourceSha256, unit] as const),
  );
  if (records.size !== acquired.units.length) failChangeSource("change-source-record-unbound");
  const cited = acquired.release.units.flatMap((unit): RunChangeSourceV1[] => {
    if (unit.evidence.state !== "bound") return [];
    const record = records.get(unit.evidence.changeSourceSha256);
    if (record === undefined) failChangeSource("change-source-record-unbound");
    records.delete(unit.evidence.changeSourceSha256);
    return [runChangeSourceFromAcquired(record)];
  });
  if (records.size !== 0) failChangeSource("change-source-record-unbound");
  const [first, ...rest] = cited;
  return first === undefined ? undefined : [first, ...rest];
}

/** Cite the units index the run bound, from the sealed index itself. */
export function runChangeSourceReleaseFromAcquired(
  acquired: AcquiredReleaseRangeV1,
): RunChangeSourceReleaseV1 {
  const { release: index } = acquired;
  const { base, head, repository } = index.revision;
  // A release selector names both endpoints, so its index always has a base.
  if (base === undefined) failChangeSource("change-source-record-unbound");
  return {
    schemaVersion: 1,
    kind: RUN_CHANGE_SOURCE_RELEASE_KIND,
    repository: {
      kind: repository.kind,
      identitySha256: repository.identitySha256,
    },
    objectFormat: index.objectFormat,
    base,
    head,
    releaseUnitsSha256: index.releaseUnitsSha256,
    observationId: acquired.index.observation.observationId,
    units: index.units.length,
    pageUnits: index.page.bound,
    omittedUnits: index.units.filter((unit) => unit.evidence.state === "omitted").length,
    remainingUnits: index.page.remaining,
    continuation: index.page.continuation,
  };
}

export class RunChangeSourceReleaseError extends Error {
  constructor() {
    super("Run record changeSourceRelease does not match the run release citation contract.");
    this.name = "RunChangeSourceReleaseError";
  }
}

const fail: ContractFail<"invalid"> = () => {
  throw new RunChangeSourceReleaseError();
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

const RELEASE_KEYS = [
  "schemaVersion",
  "kind",
  "repository",
  "objectFormat",
  "base",
  "head",
  "releaseUnitsSha256",
  "observationId",
  "units",
  "pageUnits",
  "omittedUnits",
  "remainingUnits",
  "continuation",
] as const satisfies readonly (keyof RunChangeSourceReleaseV1)[];

/**
 * Admit the release citation together with the `changeSources` beside it: a
 * release-range entry needs this citation, and this citation needs exactly
 * one release-range entry per unit its page bound, from the same repository.
 * Undefined when the record carries no release citation.
 */
export function decodeRunChangeSourceRelease(
  value: unknown,
  workflow: unknown,
  changeSources: unknown,
): RunChangeSourceReleaseV1 | undefined {
  const cited = changeSources === undefined ? [] : decodeRunChangeSources(changeSources, workflow);
  const releaseUnits = cited.filter((entry) => entry.sourceKind === "release-range");
  if (value === undefined) {
    if (releaseUnits.length > 0) fail("invalid");
    return undefined;
  }
  if (!(SOURCE_AWARE_WORKFLOWS as readonly unknown[]).includes(workflow)) fail("invalid");
  kit.assertInert(value);
  const release = decodeRelease(value);
  if (
    releaseUnits.length !== cited.length ||
    cited.length !== release.pageUnits - release.omittedUnits ||
    cited.some(
      (entry) =>
        entry.objectFormat !== release.objectFormat ||
        entry.repository.kind !== release.repository.kind ||
        entry.repository.identitySha256 !== release.repository.identitySha256,
    )
  ) {
    fail("invalid");
  }
  return release;
}

function decodeRelease(value: unknown): RunChangeSourceReleaseV1 {
  const root = kit.object(value);
  kit.exact(root, RELEASE_KEYS);
  if (root.schemaVersion !== 1 || root.kind !== RUN_CHANGE_SOURCE_RELEASE_KIND) fail("invalid");
  const objectFormat = kit.enumeration(root.objectFormat, CHANGE_SOURCE_OBJECT_FORMATS);
  // The empty tree id fixes the width per format, as in `changeSources`.
  const width = GIT_EMPTY_TREE_IDS[objectFormat].length;
  const objectId = (id: unknown): string => {
    const result = kit.revision(id);
    if (result.length !== width) fail("invalid");
    return result;
  };
  const head = objectId(root.head);
  const units = decodeCount(root.units);
  const pageUnits = decodeCount(root.pageUnits);
  const omittedUnits = decodeCount(root.omittedUnits);
  const remainingUnits = decodeCount(root.remainingUnits);
  // A page holds at least one unit, and the index lists the page and every later unit.
  if (pageUnits === 0 || omittedUnits > pageUnits || units !== pageUnits + remainingUnits) {
    fail("invalid");
  }
  return {
    schemaVersion: 1,
    kind: RUN_CHANGE_SOURCE_RELEASE_KIND,
    repository: decodeRepository(root.repository),
    objectFormat,
    base: objectId(root.base),
    head,
    releaseUnitsSha256: kit.hash(root.releaseUnitsSha256),
    observationId: kit.identifier(root.observationId),
    units,
    pageUnits,
    omittedUnits,
    remainingUnits,
    continuation: decodeContinuation(root.continuation, remainingUnits, head, objectId),
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

/** Null exactly when nothing remains; otherwise the selector from a unit id to head. */
function decodeContinuation(
  value: unknown,
  remainingUnits: number,
  head: string,
  objectId: (id: unknown) => string,
): string | null {
  if (remainingUnits === 0) {
    if (value !== null) fail("invalid");
    return null;
  }
  const selector = kit.string(value);
  const lastBound = objectId(selector.slice(selector.indexOf(":") + 1, selector.indexOf("..")));
  if (selector !== releaseContinuationSelector(lastBound, head)) fail("invalid");
  return selector;
}

/** A unit count from the sealed index; zero is a real count. */
function decodeCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) fail("invalid");
  return value;
}
