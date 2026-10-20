// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Resolve `--change release:<base>..<head>` into its first-parent units: one
 * `ChangeSourceV1` per unit, read by the local resolver as a single commit
 * against its first parent, plus one sealed units index that lists every unit
 * in first-parent order. The index is an index over the one change-source
 * contract, not a second change contract.
 *
 * Host code enumerates, counts, re-hashes and pages the whole release before
 * any model call. A unit over the per-unit diff or changed-file bound stays
 * listed as an omission; every other refusal refuses the whole release. A
 * range longer than one run's page binds its first page and names the
 * continuation selector for the rest. The index is the release's one required
 * read, so a page also stops where the index would outgrow one step's
 * source-read budget. Commit subjects and tag names are repository text: they
 * stay inside the index observation.
 */
import { createHash } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";

import {
  limit,
  OperationalLimitError,
  refuseLimit,
  type ResolveLimitsOptions,
  type ResolvedLimit,
} from "../../config/limits.js";
import {
  SOURCE_EXTRACTION_MAX_DERIVATIVE_BYTES_LIMIT,
  SOURCE_EXTRACTION_MAX_SPANS_LIMIT,
} from "../../config/source-read-limits.js";
import { canonicalDigest, canonicalJson } from "../../content-ir/canonical.js";
import { createContractKit } from "../../contract-kit/index.js";
import { MAX_GIT_OUTPUT_BYTES, runTrustedGit } from "../../host-invoker/trusted-git.js";
import { findConfiguredCredentialInValue } from "../../security/configured-credentials.js";
import {
  acquireChangeSourceObservations,
  CHANGE_SOURCE_PRODUCER_IDS,
  CHANGE_SOURCE_PRODUCER_VERSION,
  changeSourceMemberProducerId,
  extractChangeSourceOriginalWhole,
  mintChangeSourceOriginalObservation,
  type AcquireChangeSourceObservationsInput,
  type AcquiredChangeSourceEntryV1,
  type AcquiredChangeSourceOriginalEntryV1,
  type AcquiredChangeSourceV1,
  type ChangeSourceOriginalV1,
} from "./acquisition.js";
import {
  CHANGE_SOURCE_CHANGED_FILES_MAX_LIMIT,
  CHANGE_SOURCE_DIFF_MAX_BYTES_LIMIT,
  changeSourceLimits,
  fileSize,
  hardening,
  resolveLocalChangeSource,
} from "./local.js";
import {
  CHANGE_SOURCE_OBJECT_FORMATS,
  failChangeSource,
  GIT_EMPTY_TREE_IDS,
  type ChangeSourceMemberV1,
  type ChangeSourceObjectFormat,
  type LocalRangeSelectorV1,
  type ResolvedChangeSourceV1,
} from "../change-source.js";
import {
  gitOrFail,
  lines,
  parseCommit,
  readObjects,
  verified,
  type ParsedCommit,
  type RawObjectReader,
} from "./objects.js";
import { RELEASE_SELECTOR_PREFIX, type ReleaseRangeSelectorV1 } from "./release-member.js";
import {
  createPinnedRepositoryRevision,
  decodePinnedRepositoryRevisionV1,
  isGitFullObjectId,
  type PinnedRepositoryRevisionV1,
} from "./revision.js";
import { gitlabMergedMrDiffExtractorAdapter } from "../merged-mr-evidence.js";
import { normalizeSourceReadScope } from "../source-acquisition.js";
import { MAX_OBSERVATIONS } from "../source-evidence.js";
import type { SourceReadBudgetV1 } from "../source-step-policy.js";
import {
  sourceExtractionLimits,
  type SourceExtractorAdapterV1,
  type SourceExtractionRequestV1,
} from "../source-extraction.js";

export const CHANGE_SOURCE_RELEASE_UNITS_MAX_LIMIT = "changeSourcesRelease.unitsMax" as const;
export const CHANGE_SOURCE_RELEASE_UNITS_PER_RUN_MAX_LIMIT =
  "changeSourcesRelease.unitsPerRunMax" as const;

export const RELEASE_UNITS_INDEX_KIND = "docsfab-change-source-release-units" as const;
export const RELEASE_UNITS_DIGEST_KEY = "releaseUnitsSha256" as const;
export const RELEASE_UNITS_MEDIA_TYPE =
  "application/vnd.docsfab.change-source-release-units+json" as const;
export const RELEASE_UNITS_ADAPTER_ID = "docsfab-change-source-release-units" as const;
export const RELEASE_UNITS_ADAPTER_VERSION = "1" as const;

/**
 * A unit's shape: `empty` when its tree equals its first parent's (or, for a
 * root, the empty tree); otherwise by its parent count.
 */
export const RELEASE_UNIT_KINDS = ["root", "plain", "merge", "octopus", "empty"] as const;
export type ReleaseUnitKind = (typeof RELEASE_UNIT_KINDS)[number];

export const RELEASE_INDEX_LABELS = [
  // Base is not on head's first-parent line, so the walk can list changes
  // the base release already carried through a merge.
  "base-off-first-parent-line",
  // A shallow checkout cannot prove a merge's introduced-commit list complete.
  "introduced-lists-unproven-shallow",
] as const;
export type ReleaseIndexLabel = (typeof RELEASE_INDEX_LABELS)[number];

/** No forge identity ships for a local checkout, so no unit links to its merge request. */
export const RELEASE_UNIT_LINK_REASON = "forge-identity-unavailable" as const;

/** The source every unit record carries, and the key its producer id is read under. */
const RELEASE_UNIT_SOURCE: ChangeSourceMemberV1 = Object.freeze({ kind: "release-range" });

/**
 * The only refusals a unit turns into a listed omission: its own diff or
 * changed-file count over the per-range bound, or its records over a size
 * bound when they are extracted whole. Every other refusal stops the whole
 * release.
 */
export const RELEASE_UNIT_OMITTABLE_LIMITS: readonly string[] = Object.freeze([
  CHANGE_SOURCE_DIFF_MAX_BYTES_LIMIT,
  CHANGE_SOURCE_CHANGED_FILES_MAX_LIMIT,
  SOURCE_EXTRACTION_MAX_SPANS_LIMIT,
  SOURCE_EXTRACTION_MAX_DERIVATIVE_BYTES_LIMIT,
]);

/** Protocol constants of the binding layout: one index, and each unit's record plus its diff. */
const INDEX_OBSERVATIONS = 1;
const OBSERVATIONS_PER_UNIT = 2;

export interface ReleaseIntroducedCommitV1 {
  readonly id: string;
  readonly subject: string;
}

/** A limit that left something out, with the measured value. */
export interface ReleaseOmissionV1 {
  readonly state: "omitted";
  readonly code: string;
  readonly limitName: string;
  readonly observed: number;
  readonly limit: number;
}

/** What a merge brought onto the first-parent line (`<unit>^1..<unit>`, the unit itself excluded). */
export type ReleaseUnitIntroducedV1 =
  | { readonly state: "listed"; readonly commits: readonly ReleaseIntroducedCommitV1[] }
  | ReleaseOmissionV1
  | { readonly state: "next-page" };

export type ReleaseUnitEvidenceV1 =
  | { readonly state: "bound"; readonly changeSourceSha256: string }
  | ReleaseOmissionV1
  | { readonly state: "next-page" };

export interface ReleaseUnitV1 {
  /** 1-based, oldest first along head's first-parent line. */
  readonly position: number;
  readonly id: string;
  readonly parents: readonly string[];
  readonly subject: string;
  readonly kind: ReleaseUnitKind;
  readonly evidence: ReleaseUnitEvidenceV1;
  readonly introduced: ReleaseUnitIntroducedV1;
  readonly link: null;
  readonly linkReason: typeof RELEASE_UNIT_LINK_REASON;
}

export interface ReleaseUnitsPageV1 {
  readonly unitsPerRun: number;
  /** The step source-read budget the whole index was sized to fit. */
  readonly readBudgetBytes: number;
  readonly bound: number;
  readonly remaining: number;
  /** `release:<last unit of this page>..<head>`; null when nothing remains. */
  readonly continuation: string | null;
}

export interface ReleaseUnitsIndexBodyV1 {
  readonly revision: PinnedRepositoryRevisionV1;
  readonly objectFormat: ChangeSourceObjectFormat;
  /** Annotated tag object an endpoint named, re-hashed; null for a commit or branch. */
  readonly tags: { readonly base: string | null; readonly head: string | null };
  readonly labels: readonly ReleaseIndexLabel[];
  readonly units: readonly ReleaseUnitV1[];
  readonly page: ReleaseUnitsPageV1;
}

export type ReleaseUnitsIndexV1 = ReleaseUnitsIndexBodyV1 & {
  readonly schemaVersion: 1;
  readonly kind: typeof RELEASE_UNITS_INDEX_KIND;
  readonly releaseUnitsSha256: string;
};

/** What the release kind's resolver returns: the sealed index and the bound units. */
export interface ResolvedReleaseRangeV1 {
  readonly kind: "docsfab-resolved-release-range";
  readonly index: ReleaseUnitsIndexV1;
  /** Pretty-printed canonical JSON of `index`. */
  readonly indexBytes: Uint8Array;
  /** The page's bound units, in index order. */
  readonly units: readonly ResolvedChangeSourceV1<ChangeSourceMemberV1>[];
}

export function isResolvedReleaseRange(value: unknown): value is ResolvedReleaseRangeV1 {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === "docsfab-resolved-release-range"
  );
}

const CONTRACT_ERROR_CODES = [
  "release-units-contract-invalid-shape",
  "release-units-contract-invalid-value",
  "release-units-contract-digest-mismatch",
  "release-units-contract-credential-material",
  "release-units-contract-schema-mismatch",
] as const;
type ReleaseUnitsContractErrorCode = (typeof CONTRACT_ERROR_CODES)[number];

export class ReleaseUnitsContractError extends Error {
  public constructor(public readonly code: ReleaseUnitsContractErrorCode) {
    super(
      `The release units index is not valid (${code}). It is host-built; rebuild it from the repository rather than editing it.`,
    );
    this.name = "ReleaseUnitsContractError";
  }
}

function failContract(code: ReleaseUnitsContractErrorCode): never {
  throw new ReleaseUnitsContractError(code);
}

const kit = createContractKit<ReleaseUnitsContractErrorCode>({
  fail: failContract,
  codes: {
    invalidShape: "release-units-contract-invalid-shape",
    invalidValue: "release-units-contract-invalid-value",
    digestMismatch: "release-units-contract-digest-mismatch",
    credentialMaterial: "release-units-contract-credential-material",
    schemaMismatch: "release-units-contract-schema-mismatch",
  },
  // The enumeration bound caps the unit list where the index is built.
  sizeGovernedBy: CHANGE_SOURCE_RELEASE_UNITS_MAX_LIMIT,
});

function text(value: unknown): string {
  if (typeof value !== "string" || value.includes("\0")) {
    failContract("release-units-contract-invalid-value");
  }
  return value;
}

function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    failContract("release-units-contract-invalid-value");
  }
  return value;
}

function nullableRevision(value: unknown): string | null {
  return value === null ? null : kit.revision(value);
}

function omission(root: Record<string, unknown>): ReleaseOmissionV1 {
  kit.exact(root, ["state", "code", "limitName", "observed", "limit"]);
  return {
    state: "omitted",
    code: kit.identifier(root.code),
    limitName: kit.identifier(root.limitName),
    observed: count(root.observed),
    limit: count(root.limit),
  };
}

function evidence(value: unknown): ReleaseUnitEvidenceV1 {
  const root = kit.object(value);
  const state = kit.enumeration(root.state, ["bound", "omitted", "next-page"] as const);
  if (state === "omitted") return omission(root);
  if (state === "next-page") {
    kit.exact(root, ["state"]);
    return { state };
  }
  kit.exact(root, ["state", "changeSourceSha256"]);
  return { state, changeSourceSha256: kit.hash(root.changeSourceSha256) };
}

function introduced(value: unknown): ReleaseUnitIntroducedV1 {
  const root = kit.object(value);
  const state = kit.enumeration(root.state, ["listed", "omitted", "next-page"] as const);
  if (state === "omitted") return omission(root);
  if (state === "next-page") {
    kit.exact(root, ["state"]);
    return { state };
  }
  kit.exact(root, ["state", "commits"]);
  return {
    state,
    commits: kit.array(root.commits).map((entry) => {
      const commit = kit.object(entry);
      kit.exact(commit, ["id", "subject"]);
      return { id: kit.revision(commit.id), subject: text(commit.subject) };
    }),
  };
}

function unit(value: unknown): ReleaseUnitV1 {
  const root = kit.object(value);
  kit.exact(root, [
    "position",
    "id",
    "parents",
    "subject",
    "kind",
    "evidence",
    "introduced",
    "link",
    "linkReason",
  ]);
  if (root.link !== null) failContract("release-units-contract-invalid-value");
  return {
    position: count(root.position),
    id: kit.revision(root.id),
    parents: kit.array(root.parents).map((parent) => kit.revision(parent)),
    subject: text(root.subject),
    kind: kit.enumeration(root.kind, RELEASE_UNIT_KINDS),
    evidence: evidence(root.evidence),
    introduced: introduced(root.introduced),
    link: null,
    linkReason: kit.enumeration(root.linkReason, [RELEASE_UNIT_LINK_REASON] as const),
  };
}

export function releaseContinuationSelector(lastBound: string, head: string): string {
  return `${RELEASE_SELECTOR_PREFIX}${lastBound}..${head}`;
}

/**
 * Units run oldest first from position 1; the page binds or omits a prefix of
 * them and defers the rest, and the continuation resumes after the prefix.
 */
function assertPage(body: ReleaseUnitsIndexBodyV1): void {
  const { units, page } = body;
  const consistent =
    units.length > 0 &&
    page.bound + page.remaining === units.length &&
    page.bound >= 1 &&
    page.bound <= page.unitsPerRun &&
    units.every(
      (entry, index) =>
        entry.position === index + 1 &&
        index < page.bound === (entry.evidence.state !== "next-page") &&
        (entry.evidence.state === "next-page") === (entry.introduced.state === "next-page"),
    ) &&
    units.at(-1)!.id === body.revision.head &&
    page.continuation ===
      (page.remaining === 0
        ? null
        : releaseContinuationSelector(units[page.bound - 1]!.id, body.revision.head));
  if (!consistent) failContract("release-units-contract-invalid-value");
}

const BODY_KEYS = ["revision", "objectFormat", "tags", "labels", "units", "page"];

function normalizeBody(root: Record<string, unknown>): ReleaseUnitsIndexBodyV1 {
  const tags = kit.object(root.tags);
  kit.exact(tags, ["base", "head"]);
  const page = kit.object(root.page);
  kit.exact(page, ["unitsPerRun", "readBudgetBytes", "bound", "remaining", "continuation"]);
  const labels = kit
    .array(root.labels)
    .map((label) => kit.enumeration(label, RELEASE_INDEX_LABELS));
  kit.unique(labels);
  const revision = decodePinnedRepositoryRevisionV1(root.revision);
  if (revision.base === undefined) failContract("release-units-contract-invalid-value");
  const body: ReleaseUnitsIndexBodyV1 = {
    revision,
    objectFormat: kit.enumeration(root.objectFormat, CHANGE_SOURCE_OBJECT_FORMATS),
    tags: { base: nullableRevision(tags.base), head: nullableRevision(tags.head) },
    labels: [...labels].sort(),
    units: kit.array(root.units).map(unit),
    page: {
      unitsPerRun: count(page.unitsPerRun),
      readBudgetBytes: count(page.readBudgetBytes),
      bound: count(page.bound),
      remaining: count(page.remaining),
      continuation: page.continuation === null ? null : kit.identifier(page.continuation),
    },
  };
  assertPage(body);
  return body;
}

/** Closed-key decoder; any key outside the contract, or a stale digest, refuses. */
export function decodeReleaseUnitsIndexV1(value: unknown): ReleaseUnitsIndexV1 {
  return kit.decodeSealed(
    value,
    RELEASE_UNITS_INDEX_KIND,
    RELEASE_UNITS_DIGEST_KEY,
    BODY_KEYS,
    normalizeBody,
  ) as ReleaseUnitsIndexV1;
}

function createReleaseUnitsIndex(body: ReleaseUnitsIndexBodyV1): ReleaseUnitsIndexV1 {
  return decodeReleaseUnitsIndexV1(
    kit.seal(RELEASE_UNITS_INDEX_KIND, RELEASE_UNITS_DIGEST_KEY, normalizeBody({ ...body })),
  );
}

/** Whole-line spans, the split the change-source manifest uses. */
function wholeLineExtract(request: SourceExtractionRequestV1) {
  return gitlabMergedMrDiffExtractorAdapter.extract(request);
}

export const releaseUnitsExtractorAdapter: SourceExtractorAdapterV1 = Object.freeze({
  id: RELEASE_UNITS_ADAPTER_ID,
  version: RELEASE_UNITS_ADAPTER_VERSION,
  locatorKind: "text",
  mediaTypes: Object.freeze([RELEASE_UNITS_MEDIA_TYPE]),
  defaultOptions: Object.freeze({}),
  extract: wholeLineExtract,
});

function indexOriginal(indexBytes: Uint8Array): ChangeSourceOriginalV1<"release-units"> {
  return {
    role: "release-units",
    bytes: indexBytes,
    mediaType: RELEASE_UNITS_MEDIA_TYPE,
    adapter: releaseUnitsExtractorAdapter,
  };
}

export function releaseUnitsRepositoryPath(base: string, head: string): string {
  return `change-source/release-${base}-${head}/units.json`;
}

export interface ReleaseRangeLimitsV1 {
  readonly units: ResolvedLimit;
  readonly unitsPerRun: ResolvedLimit;
}

export function releaseRangeLimits(options?: ResolveLimitsOptions): ReleaseRangeLimitsV1 {
  return {
    units: limit(CHANGE_SOURCE_RELEASE_UNITS_MAX_LIMIT, options),
    unitsPerRun: limit(CHANGE_SOURCE_RELEASE_UNITS_PER_RUN_MAX_LIMIT, options),
  };
}

export interface ResolveReleaseRangeChangeSourceInput {
  /** The checkout's top level, as the workspace recorded it. */
  readonly sourcePath: string;
  readonly selector: ReleaseRangeSelectorV1;
  /** The workspace's resolved revision; each unit compares its head to it for a label. */
  readonly workspaceRevision: string;
  /** Observations bound beside the release in the same run: its `--source` files. */
  readonly besideObservations?: number;
  /** One step's source-read budget for the model the run binds; the index must fit it whole. */
  readonly readBudget: SourceReadBudgetV1;
  readonly signal?: AbortSignal;
  readonly limits?: ResolveLimitsOptions;
  /** Test seam over the trusted runner for the enumeration reads. */
  readonly observeGit?: (args: readonly string[]) => void;
}

/** Succeeds with the id git prints; any runner failure is the probe's negative answer. */
async function revParse(reader: RawObjectReader, name: string): Promise<string | null> {
  try {
    const [id] = lines(await reader.run(["rev-parse", "--verify", "--end-of-options", name]));
    return id !== undefined && isGitFullObjectId(id)
      ? id
      : failChangeSource("change-source-git-failed");
  } catch (error) {
    // Handles only the trusted runner's own failure for this name; a coded
    // refusal raised above and a caller abort pass through.
    if (error instanceof Error && error.name === "AbortError") throw error;
    if (!(error instanceof Error) || "code" in error) throw error;
    return null;
  }
}

/** The `object` a raw tag names; the loop reads its type from the object itself. */
function parseTagTarget(body: Buffer): { object: string } {
  const separator = body.indexOf("\n\n");
  const headers = body.subarray(0, separator < 0 ? body.length : separator).toString("latin1");
  const object = headers
    .split("\n")
    .find((header) => header.startsWith("object "))
    ?.slice("object ".length);
  if (object === undefined || !isGitFullObjectId(object)) {
    failChangeSource("change-source-revision-unresolved");
  }
  return { object };
}

/**
 * Resolve one endpoint to its commit, re-hashing every annotated tag object
 * the name passes through from its raw bytes first, so a tampered tag refuses
 * naming the endpoint's role rather than as an unknown name when git's own
 * peel rejects it.
 */
async function resolveEndpoint(
  reader: RawObjectReader,
  name: string,
  role: "base" | "head",
): Promise<{ commit: string; tag: string | null }> {
  const named = await revParse(reader, name);
  if (named === null) return failChangeSource("change-source-revision-unresolved");
  const seen = new Set<string>();
  let id = named;
  for (;;) {
    // Object ids are content hashes, so a repeat means a damaged object database.
    if (seen.has(id)) return failChangeSource("change-source-git-failed");
    seen.add(id);
    const objects = await readObjects(reader, [id]);
    if (objects.get(id)?.type !== "tag") break;
    id = parseTagTarget(verified(reader, objects, id, "tag", `${role} tag`).body).object;
  }
  // Git's own peel must land on the commit the re-hashed chain ends at.
  const commit = await revParse(reader, `${name}^{commit}`);
  if (commit === null) return failChangeSource("change-source-revision-unresolved");
  if (commit !== id) return failChangeSource("change-source-git-failed");
  return { commit, tag: named === commit ? null : named };
}

function unitKind(parsed: ParsedCommit, parentTree: string): ReleaseUnitKind {
  if (parsed.tree === parentTree) return "empty";
  const parents = parsed.parents.length;
  // Git's own shape names: no parent, one, two, or more (an octopus merge).
  if (parents === 0) return "root";
  if (parents === 1) return "plain";
  return parents === 2 ? "merge" : "octopus";
}

/** The single-commit selector the local resolver reads one unit through. */
function unitSelector(id: string): LocalRangeSelectorV1 {
  return Object.freeze({
    schemaVersion: 1 as const,
    kind: "docsfab-change-source-selector" as const,
    source: "local-range" as const,
    form: "single-commit" as const,
    base: null,
    head: id,
  });
}

/** The commits a merge unit brought onto the line, bounded per unit by `changeSources.commitsMax`. */
async function introducedCommits(
  reader: RawObjectReader,
  unitId: string,
  firstParent: string,
  position: number,
  commits: ResolvedLimit,
): Promise<ReleaseUnitIntroducedV1> {
  const range = ["--end-of-options", unitId, `^${firstParent}`];
  const [countText] = lines(await gitOrFail(() => reader.run(["rev-list", "--count", ...range])));
  const total = Number(countText);
  if (!Number.isSafeInteger(total) || total < 1) failChangeSource("change-source-git-failed");
  // The walk counts the merge itself.
  const brought = total - 1;
  if (brought > commits.value) {
    return {
      state: "omitted",
      code: commits.refusal,
      limitName: commits.name,
      observed: brought,
      limit: commits.value,
    };
  }
  const ids = lines(
    await gitOrFail(() => reader.run(["rev-list", "--reverse", "--topo-order", ...range])),
  ).filter((id) => id !== unitId);
  if (ids.length !== brought || !ids.every(isGitFullObjectId)) {
    failChangeSource("change-source-git-failed");
  }
  const objects = await readObjects(reader, ids);
  return {
    state: "listed",
    commits: ids.map((id, index) => ({
      id,
      subject: parseCommit(
        verified(reader, objects, id, "commit", `unit ${position} introduced commit ${index + 1}`)
          .body,
      ).subject,
    })),
  };
}

/**
 * Resolve, enumerate, re-hash, bound and page a release range. Refuses with a
 * coded `ChangeSourceError` or `OperationalLimitError`; never truncates.
 */
export async function resolveReleaseRangeChangeSource(
  input: ResolveReleaseRangeChangeSourceInput,
): Promise<ResolvedReleaseRangeV1> {
  const limits = releaseRangeLimits(input.limits);
  // The per-unit bounds and their relations, checked before any git read.
  const unitLimits = changeSourceLimits(input.limits);
  const discovered = lines(
    await gitOrFail(() =>
      runTrustedGit(
        input.sourcePath,
        ["rev-parse", "--is-shallow-repository", "--show-object-format", "--git-common-dir"],
        input.signal,
      ),
    ),
  );
  const [shallowText, formatText, commonDirText] = discovered;
  if (commonDirText === undefined || !(formatText === "sha1" || formatText === "sha256")) {
    return failChangeSource("change-source-git-failed");
  }
  const objectFormat: ChangeSourceObjectFormat = formatText;
  const shallow = shallowText === "true";
  // Grafts rewrite parents, so they would change which units the walk lists.
  const commonDir = isAbsolute(commonDirText)
    ? commonDirText
    : resolve(input.sourcePath, commonDirText);
  if ((await fileSize(join(commonDir, "info", "grafts"))) > 0) {
    failChangeSource("change-source-grafts-present");
  }
  const reader: RawObjectReader = {
    run: (args, options) => {
      input.observeGit?.(args);
      return runTrustedGit(
        input.sourcePath,
        [...hardening(objectFormat), ...args],
        input.signal,
        MAX_GIT_OUTPUT_BYTES,
        options?.input,
      );
    },
    objectFormat,
    shallow,
  };

  const base = await resolveEndpoint(reader, input.selector.base, "base");
  const head = await resolveEndpoint(reader, input.selector.head, "head");
  if (base.commit === head.commit) failChangeSource("change-source-empty-range");

  const walk = ["--first-parent", "--end-of-options", head.commit, `^${base.commit}`];
  // Counted before listing, so the refusal reports the real number.
  const [countText] = lines(await gitOrFail(() => reader.run(["rev-list", "--count", ...walk])));
  const unitCount = Number(countText);
  if (!Number.isSafeInteger(unitCount)) failChangeSource("change-source-git-failed");
  if (unitCount > limits.units.value) refuseLimit(limits.units, unitCount);
  if (unitCount === 0) failChangeSource("change-source-release-no-units");
  const ids = lines(await gitOrFail(() => reader.run(["rev-list", "--reverse", ...walk])));
  if (ids.length !== unitCount || !ids.every(isGitFullObjectId)) {
    failChangeSource("change-source-git-failed");
  }

  const bound = Math.min(unitCount, limits.unitsPerRun.value);
  const beside = input.besideObservations ?? 0;
  const observations = INDEX_OBSERVATIONS + OBSERVATIONS_PER_UNIT * bound + beside;
  if (observations > MAX_OBSERVATIONS) {
    failChangeSource(
      "change-source-release-observations-exceeded",
      `${observations} observations: ${INDEX_OBSERVATIONS} units index, ${OBSERVATIONS_PER_UNIT} for each of ${bound} units, ` +
        `and ${beside} --source files, over the ${MAX_OBSERVATIONS} one source binding holds`,
    );
  }

  // Every unit and both endpoints are re-hashed from raw bytes.
  const roles = new Map<string, string>();
  ids.forEach((id, index) => roles.set(id, `unit ${index + 1}`));
  if (!roles.has(base.commit)) roles.set(base.commit, "base");
  const objects = await readObjects(reader, [...roles.keys()]);
  const parsed = new Map<string, ParsedCommit>();
  for (const [id, role] of roles) {
    parsed.set(id, parseCommit(verified(reader, objects, id, "commit", role).body));
  }
  // The walk follows first parents, so each unit's first parent is the one before it.
  ids.forEach((id, index) => {
    if (index > 0 && parsed.get(id)!.parents[0] !== ids[index - 1]) {
      failChangeSource("change-source-git-failed");
    }
  });
  const oldestParent = parsed.get(ids[0]!)!.parents[0];
  const emptyTree = GIT_EMPTY_TREE_IDS[objectFormat];
  let oldestParentTree = emptyTree;
  if (oldestParent !== undefined) {
    const parent =
      parsed.get(oldestParent) ??
      parseCommit(
        verified(
          reader,
          await readObjects(reader, [oldestParent]),
          oldestParent,
          "commit",
          "unit 1 first parent",
        ).body,
      );
    oldestParentTree = parent.tree;
  }
  const baseOffLine = oldestParent !== base.commit;

  const kinds = ids.map((id, index) =>
    unitKind(parsed.get(id)!, index === 0 ? oldestParentTree : parsed.get(ids[index - 1]!)!.tree),
  );
  const revision = createPinnedRepositoryRevision({
    repository: {
      kind: "local-checkout",
      identitySha256: createHash("sha256").update(input.sourcePath).digest("hex"),
    },
    base: base.commit,
    head: head.commit,
  });
  // The page's units, oldest first, each resolved once.
  const resolvedPage: ResolvedPageUnit[] = [];
  // The index over the units resolved so far, as this run's page.
  const pageBody = (): ReleaseUnitsIndexBodyV1 => {
    const pageUnits = resolvedPage.length;
    const labels = new Set<ReleaseIndexLabel>();
    if (baseOffLine) labels.add("base-off-first-parent-line");
    const units = ids.map((id, index): ReleaseUnitV1 => {
      const commit = parsed.get(id)!;
      const onPage = resolvedPage[index];
      if (onPage !== undefined && commit.parents.length > 1 && shallow) {
        labels.add("introduced-lists-unproven-shallow");
      }
      return {
        position: index + 1,
        id,
        parents: commit.parents,
        subject: commit.subject,
        kind: kinds[index]!,
        evidence: onPage?.evidence ?? { state: "next-page" },
        introduced: onPage?.introduced ?? { state: "next-page" },
        link: null,
        linkReason: RELEASE_UNIT_LINK_REASON,
      };
    });
    const remaining = unitCount - pageUnits;
    return {
      revision,
      objectFormat,
      tags: { base: base.tag, head: head.tag },
      labels: [...labels].sort(),
      units,
      page: {
        unitsPerRun: limits.unitsPerRun.value,
        readBudgetBytes: input.readBudget.budgetBytes,
        bound: pageUnits,
        remaining,
        continuation:
          remaining === 0 ? null : releaseContinuationSelector(ids[pageUnits - 1]!, head.commit),
      },
    };
  };

  // The index is the release's one required read, and a write step must read
  // it whole, so the page grows a unit at a time, up to the page the
  // observation cap admits, while the index fits one step's read budget.
  let sealed: SealedReleaseUnitsIndex | undefined;
  while (resolvedPage.length < bound) {
    const position = resolvedPage.length + 1;
    const id = ids[position - 1]!;
    const commit = parsed.get(id)!;
    const firstParent = commit.parents[0];
    const introduced =
      commit.parents.length > 1 && firstParent !== undefined
        ? await introducedCommits(reader, id, firstParent, position, unitLimits.commits)
        : ({ state: "listed", commits: [] } as const);
    resolvedPage.push({ ...(await resolveUnit(input, id)), introduced });
    const candidate = sealIndex(pageBody());
    if (candidate.indexBytes.byteLength > input.readBudget.budgetBytes) {
      if (sealed === undefined) {
        failChangeSource(
          "change-source-release-index-over-read-budget",
          `${candidate.indexBytes.byteLength}-byte units index for ${unitCount} unit(s) with a one-unit page, ` +
            `over the ${input.readBudget.budgetBytes}-byte source-read budget of one step (${budgetBasis(input.readBudget)})`,
        );
      }
      resolvedPage.pop();
      break;
    }
    sealed = candidate;
  }
  // The page holds at least one unit, so the loop sealed an index or refused.
  const page = sealed!;
  // Subjects have no count bound, so the index is extracted whole here, under
  // the run's extraction limits, before any model call.
  await extractChangeSourceOriginalWhole(
    indexOriginal(page.indexBytes),
    sourceExtractionLimits(input.limits),
    input.limits,
  );
  return Object.freeze({
    kind: "docsfab-resolved-release-range" as const,
    index: page.index,
    indexBytes: page.indexBytes,
    units: Object.freeze(resolvedPage.flatMap((entry) => entry.resolved ?? [])),
  });
}

interface ResolvedPageUnit {
  readonly evidence: ReleaseUnitEvidenceV1;
  readonly introduced: ReleaseUnitIntroducedV1;
  readonly resolved?: ResolvedChangeSourceV1<ChangeSourceMemberV1>;
}

interface SealedReleaseUnitsIndex {
  readonly index: ReleaseUnitsIndexV1;
  readonly indexBytes: Uint8Array;
}

function sealIndex(body: ReleaseUnitsIndexBodyV1): SealedReleaseUnitsIndex {
  // A configured credential in a subject stops here, before sealing, whose
  // own screen would refuse it as a malformed record.
  if (findConfiguredCredentialInValue(body)) failChangeSource("change-source-credential-present");
  const index = createReleaseUnitsIndex(body);
  return {
    index,
    indexBytes: new TextEncoder().encode(
      `${JSON.stringify(JSON.parse(canonicalJson(index)), null, 2)}\n`,
    ),
  };
}

/** The limit that set a step's read budget, as an operator reads it. */
function budgetBasis(budget: SourceReadBudgetV1): string {
  return budget.basis.kind === "input-window-share"
    ? `sources.readInputWindowShare = ${budget.basis.share} of the model's ${budget.basis.inputWindowTokens}-token input window`
    : "sources.readResponseCeilingBytes";
}

/**
 * Resolve one bound unit through the local resolver as a single commit
 * against its first parent. Handles exactly a refusal at one of
 * `RELEASE_UNIT_OMITTABLE_LIMITS`, which becomes a listed omission; every
 * other refusal, integrity, credential and abort included, propagates and
 * refuses the release.
 */
async function resolveUnit(
  input: ResolveReleaseRangeChangeSourceInput,
  id: string,
): Promise<Omit<ResolvedPageUnit, "introduced">> {
  try {
    const resolved = await resolveLocalChangeSource({
      sourcePath: input.sourcePath,
      selector: unitSelector(id),
      source: RELEASE_UNIT_SOURCE,
      workspaceRevision: input.workspaceRevision,
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.limits ? { limits: input.limits } : {}),
    });
    return {
      evidence: {
        state: "bound",
        changeSourceSha256: resolved.changeSource.changeSourceSha256,
      },
      resolved,
    };
  } catch (error) {
    if (
      !(error instanceof OperationalLimitError) ||
      !RELEASE_UNIT_OMITTABLE_LIMITS.includes(error.limitName)
    ) {
      throw error;
    }
    return {
      evidence: {
        state: "omitted",
        code: error.code,
        limitName: error.limitName,
        observed: error.observed,
        limit: error.configured,
      },
    };
  }
}

/** The lines the operator sees before any model call: counts, omissions, labels, and every deferred unit. */
export function releaseRangeStatusLines(index: ReleaseUnitsIndexV1): string[] {
  const { units, page } = index;
  const omitted = units.filter((entry) => entry.evidence.state === "omitted");
  const result = [
    `release range: ${units.length} first-parent unit(s) to ${index.revision.head}; ` +
      `${page.bound - omitted.length} bound and ${omitted.length} omitted in this run, ` +
      `${page.remaining} on later pages`,
  ];
  // Only a page the read budget cut short; the page bound and the range's
  // own end both stop a page without it.
  if (page.bound < Math.min(page.unitsPerRun, units.length)) {
    result.push(
      `release range page: ${page.bound} of at most ${page.unitsPerRun} unit(s), the most whose ` +
        `units index fits one step's ${page.readBudgetBytes}-byte source-read budget`,
    );
  }
  for (const entry of units) {
    if (entry.evidence.state === "omitted") {
      result.push(
        `${entry.evidence.code}: release unit ${entry.position} (${entry.id}) is ` +
          `${entry.evidence.observed}, over ${entry.evidence.limitName} = ${entry.evidence.limit}; ` +
          "it stays listed in the units index without its change record or diff",
      );
    }
    if (entry.introduced.state === "omitted") {
      result.push(
        `${entry.introduced.code}: release unit ${entry.position} (${entry.id}) brought in ` +
          `${entry.introduced.observed} commits, over ${entry.introduced.limitName} = ` +
          `${entry.introduced.limit}; the units index lists the merge without them`,
      );
    }
  }
  for (const label of index.labels) result.push(`release range label: ${label}`);
  if (page.continuation !== null) {
    result.push(
      `release range continues: ${page.remaining} unit(s) after this page; ` +
        `run again with --change ${page.continuation} to bind them`,
    );
    for (const entry of units) {
      if (entry.evidence.state === "next-page") {
        result.push(`release unit ${entry.position} (${entry.id}) is on a later page`);
      }
    }
  }
  return result;
}

/** The units index's one observation; it lists units, so it is no change record. */
export type AcquiredReleaseUnitsEntryV1 = AcquiredChangeSourceOriginalEntryV1<"release-units">;

export interface AcquiredReleaseRangeV1 {
  readonly release: ReleaseUnitsIndexV1;
  readonly index: AcquiredReleaseUnitsEntryV1;
  /** Each record the page bound, in index order: what the run record cites. */
  readonly units: readonly AcquiredChangeSourceV1[];
  /** The index first, then each unit's own entries, in binding order. */
  readonly acquired: readonly (AcquiredReleaseUnitsEntryV1 | AcquiredChangeSourceEntryV1)[];
  readonly producerScopes: ReadonlyArray<{
    producerId: string;
    scopeSha256: string;
  }>;
  /** The units index alone; unit records and diffs are bound but optional. */
  readonly requiredObservationIds: readonly string[];
}

/** Whether an acquired change is a release's index and units rather than one record. */
export function isAcquiredReleaseRange(
  acquired: AcquiredChangeSourceV1 | AcquiredReleaseRangeV1,
): acquired is AcquiredReleaseRangeV1 {
  return "release" in acquired;
}

/** The release's one producer scope: the read grant and the exact sealed index. */
export function digestReleaseRangeProducerScope(input: {
  readonly index: ReleaseUnitsIndexV1;
  readonly producerId: string;
  readonly readScope: readonly string[];
}): string {
  return canonicalDigest({
    schemaVersion: 1 as const,
    kind: "docsfab-change-source-release-read-scope" as const,
    producerId: input.producerId,
    producerVersion: CHANGE_SOURCE_PRODUCER_VERSION,
    readScope: [...normalizeSourceReadScope(input.readScope)],
    release: {
      repositoryIdentitySha256: input.index.revision.repository.identitySha256,
      base: input.index.revision.base,
      head: input.index.revision.head,
    },
    releaseUnitsSha256: input.index.releaseUnitsSha256,
  });
}

/**
 * Mint the units index and each bound unit's record and diff under the
 * release's one producer scope.
 */
export async function acquireReleaseRangeObservations(
  input: Omit<AcquireChangeSourceObservationsInput, "resolved" | "producerScopeSha256"> & {
    readonly resolved: ResolvedReleaseRangeV1;
  },
): Promise<AcquiredReleaseRangeV1> {
  const { index, indexBytes } = input.resolved;
  const producerIds = input.producerIds ?? CHANGE_SOURCE_PRODUCER_IDS;
  // The same lookup each unit's record takes, so the index and the units
  // share one producer.
  const producerId = changeSourceMemberProducerId(RELEASE_UNIT_SOURCE, producerIds);
  const producerScopeSha256 = digestReleaseRangeProducerScope({
    index,
    producerId,
    readScope: input.readScope,
  });
  const { base, head } = index.revision;
  const indexEntry = await mintChangeSourceOriginalObservation(
    { ...input, producerId, producerScopeSha256 },
    indexOriginal(indexBytes),
    {
      canonicalLocator: `change-source:v1:release-range:${base}:${head}:release-units`,
      originIdSha256: canonicalDigest({
        schemaVersion: 1 as const,
        kind: "docsfab-change-source-release-origin" as const,
        repositoryIdentitySha256: index.revision.repository.identitySha256,
        base,
        head,
        role: "release-units",
      }),
      revision: head,
      version: () => ({ kind: "repository-revision", revision: head }),
      repositoryPath: releaseUnitsRepositoryPath(base!, head),
    },
  );
  const units: AcquiredChangeSourceV1[] = [];
  for (const resolved of input.resolved.units) {
    units.push(
      await acquireChangeSourceObservations({
        ...input,
        resolved,
        producerIds,
        producerScopeSha256,
      }),
    );
  }
  return {
    release: index,
    index: indexEntry,
    units: Object.freeze(units),
    acquired: Object.freeze([indexEntry, ...units.flatMap((unit) => unit.acquired)]),
    producerScopes: Object.freeze([{ producerId, scopeSha256: producerScopeSha256 }]),
    // The units index alone. Unit records and diffs are bound and readable,
    // but requiring them would share one step's read budget across hundreds
    // of sources and leave each a fragment.
    requiredObservationIds: Object.freeze([indexEntry.observation.observationId]),
  };
}
