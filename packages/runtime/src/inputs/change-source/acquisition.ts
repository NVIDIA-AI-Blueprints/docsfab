// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The change-source producer: mints the manifest and diff observations for a
 * change a kind's resolver already resolved and bounded. It reads no
 * repository bytes itself, so everything it seals was checked before the
 * first model call.
 *
 * The diff original is `text/x-diff`, the unified shape git emits with `a/`
 * and `b/` prefixes, full blob ids and C-quoted paths, or a forge-reported diff
 * in the same shape. It extracts through the shared unified diff adapter, the
 * one `text/x-diff` extractor, into manifest, file, and hunk spans; the JSON
 * manifest original still splits into spans of whole lines.
 */
import { canonicalDigest } from "../../content-ir/canonical.js";
import { limit, refuseLimit, type ResolveLimitsOptions } from "../../config/limits.js";
import {
  SOURCE_EXTRACTION_MAX_DERIVATIVE_BYTES_LIMIT,
  SOURCE_EXTRACTION_MAX_SPANS_LIMIT,
} from "../../config/source-read-limits.js";
import { registerTrackedRepositorySourceInput } from "../access.js";
import { DIFF_SOURCE_MEDIA_TYPE, diffSourceExtractorAdapter } from "../adapters/diff.js";
import {
  changeSourceProvenance,
  failChangeSource,
  type ChangeSourceMemberV1,
  type ChangeSourceV1,
  type ResolvedChangeSourceV1,
} from "../change-source.js";
import type { ExternalInputHostCapability } from "../contracts.js";
import { gitlabMergedMrDiffExtractorAdapter } from "../merged-mr-evidence.js";
import { normalizeSourceReadScope } from "../source-acquisition.js";
import {
  createSourceObservation,
  type SourceObservationV1,
  type SourceRepositoryBindingV1,
  type SourceRepresentationV1,
} from "../source-evidence.js";
import {
  extractSourceRepresentation,
  sha256Bytes,
  type SourceExtractionLimitsV1,
  type SourceExtractorAdapterV1,
  type SourceExtractionRequestV1,
} from "../source-extraction.js";

export const CHANGE_SOURCE_PRODUCER_ID = "change-source-local" as const;
/**
 * The producer id per source kind, or per `<kind>:<provenance>` where one
 * kind has an arm per provenance. Each keeps its own id, so its scope digest
 * and observation ids never collide with another's.
 */
export const CHANGE_SOURCE_PRODUCER_IDS: Readonly<Record<string, string>> = Object.freeze({
  "local-range": CHANGE_SOURCE_PRODUCER_ID,
  "gitlab-merge-request": "change-source-gitlab-local",
  "gitlab-merge-request:forge-reported": "change-source-gitlab-forge",
  "github-pull-request": "change-source-github-pull-request",
  "github-commit": "change-source-github-commit",
  "github-compare": "change-source-github-compare",
  "release-range": "change-source-release",
});

/** The table key naming a source's kind and provenance together. */
function provenanceKey(source: ChangeSourceMemberV1): string {
  return `${source.kind}:${changeSourceProvenance(source)}`;
}

/**
 * The producer id of a source's kind and provenance, else of its kind; an
 * unmapped kind refuses rather than borrow one.
 */
export function changeSourceMemberProducerId(
  source: ChangeSourceMemberV1,
  producerIds: Readonly<Record<string, string>> = CHANGE_SOURCE_PRODUCER_IDS,
): string {
  const keyed = provenanceKey(source);
  // Own keys only, so an inherited name such as `constructor` maps to nothing.
  if (Object.hasOwn(producerIds, keyed)) return producerIds[keyed]!;
  if (!Object.hasOwn(producerIds, source.kind)) failChangeSource("change-source-kind-unsupported");
  return producerIds[source.kind]!;
}

/** The producer id of a record's source; see `changeSourceMemberProducerId`. */
export function changeSourceProducerId(
  changeSource: ChangeSourceV1<ChangeSourceMemberV1>,
  producerIds: Readonly<Record<string, string>> = CHANGE_SOURCE_PRODUCER_IDS,
): string {
  return changeSourceMemberProducerId(changeSource.source, producerIds);
}
export const CHANGE_SOURCE_PRODUCER_VERSION = "1" as const;
export const CHANGE_SOURCE_DIFF_MEDIA_TYPE = DIFF_SOURCE_MEDIA_TYPE;
export const CHANGE_SOURCE_MANIFEST_MEDIA_TYPE =
  "application/vnd.docsfab.change-source+json" as const;
export const CHANGE_SOURCE_MANIFEST_ADAPTER_ID = "docsfab-change-source-manifest" as const;
export const CHANGE_SOURCE_MANIFEST_ADAPTER_VERSION = "1" as const;

/** Whole-line spans, the same split merged-MR diffs use. */
function wholeLineExtract(request: SourceExtractionRequestV1) {
  return gitlabMergedMrDiffExtractorAdapter.extract(request);
}

export const changeSourceManifestExtractorAdapter: SourceExtractorAdapterV1 = Object.freeze({
  id: CHANGE_SOURCE_MANIFEST_ADAPTER_ID,
  version: CHANGE_SOURCE_MANIFEST_ADAPTER_VERSION,
  locatorKind: "text",
  mediaTypes: Object.freeze([CHANGE_SOURCE_MANIFEST_MEDIA_TYPE]),
  defaultOptions: Object.freeze({}),
  extract: wholeLineExtract,
});

/** One sealed original a change-source producer minted, in the role it plays. */
export interface AcquiredChangeSourceOriginalEntryV1<Role extends string> {
  readonly observation: SourceObservationV1;
  readonly representation: SourceRepresentationV1;
  readonly derivative: Uint8Array;
  readonly repositoryPath: string;
  readonly role: Role;
}

/**
 * A sealed change-source record's own observations. A release's units index
 * is not a change record, so it has its own entry type and never widens this.
 */
export type AcquiredChangeSourceEntryV1 = AcquiredChangeSourceOriginalEntryV1<"manifest" | "diff">;

export interface AcquiredChangeSourceV1 {
  readonly changeSource: ChangeSourceV1<ChangeSourceMemberV1>;
  readonly acquired: readonly AcquiredChangeSourceEntryV1[];
  readonly producerScopes: ReadonlyArray<{ producerId: string; scopeSha256: string }>;
}

type AnyChangeSourceV1 = ChangeSourceV1<ChangeSourceMemberV1>;

/** The selector-free identity of the range: what was diffed, never how it was typed. */
function rangeIdentity(changeSource: AnyChangeSourceV1) {
  return {
    repositoryIdentitySha256: changeSource.revision.repository.identitySha256,
    rangeSemantics: changeSource.rangeSemantics,
    diffFrom: changeSource.diffFrom,
    head: changeSource.revision.head,
  };
}

/** Producer scope: the read grant and the exact range. Another range is another scope. */
export function digestChangeSourceProducerScope(input: {
  readonly changeSource: AnyChangeSourceV1;
  readonly readScope: readonly string[];
  readonly producerIds?: Readonly<Record<string, string>>;
}): string {
  return canonicalDigest({
    schemaVersion: 1 as const,
    kind: "docsfab-change-source-read-scope" as const,
    producerId: changeSourceProducerId(input.changeSource, input.producerIds),
    producerVersion: CHANGE_SOURCE_PRODUCER_VERSION,
    readScope: [...normalizeSourceReadScope(input.readScope)],
    range: rangeIdentity(input.changeSource),
    changeSourceSha256: input.changeSource.changeSourceSha256,
  });
}

export function changeSourceRepositoryPath(head: string, role: "manifest" | "diff"): string {
  return role === "manifest"
    ? `change-source/${head}/manifest.json`
    : `change-source/${head}/range.diff`;
}

function canonicalLocator(changeSource: AnyChangeSourceV1, role: "manifest" | "diff"): string {
  return `change-source:v1:${changeSource.source.kind}:${changeSource.rangeSemantics}:${
    changeSource.diffFrom ?? "empty-tree"
  }:${changeSource.revision.head}:${role}`;
}

type ChangeSourceOriginals = Pick<ResolvedChangeSourceV1, "manifestBytes" | "diffBytes">;

/** One original byte string a change-source producer binds, with its extractor. */
export interface ChangeSourceOriginalV1<Role extends string = AcquiredChangeSourceEntryV1["role"]> {
  readonly role: Role;
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly adapter: SourceExtractorAdapterV1;
}

/**
 * The kinds and provenances whose originals are a version of their own bytes:
 * a GitLab merge request's forge diff is what GitLab rendered, not bytes
 * verified at the pinned revision. Every other record keeps the revision.
 */
const CONTENT_DIGEST_ORIGINALS: ReadonlySet<string> = new Set([
  "gitlab-merge-request:forge-reported",
]);

/** What an original's bytes are a version of: the pinned revision, or the bytes' own digest. */
function originalVersion(changeSource: AnyChangeSourceV1, originalSha256: string) {
  return CONTENT_DIGEST_ORIGINALS.has(provenanceKey(changeSource.source))
    ? { kind: "content-digest" as const, contentDigestSha256: originalSha256 }
    : { kind: "repository-revision" as const, revision: changeSource.revision.head };
}

/** The exact acquired original for an empty resolved original is a no-file witness. */
export function changeSourceAcquiredOriginalBytes(bytes: Uint8Array): Uint8Array {
  return bytes.byteLength === 0
    ? new TextEncoder().encode("# no file diffs in this range\n")
    : bytes;
}

/** The two originals in binding order, as the bytes they bind. */
function changeSourceOriginals(resolved: ChangeSourceOriginals) {
  return [
    // The diff first: it is the evidence a step reads and cites; the manifest
    // indexes it.
    {
      role: "diff" as const,
      bytes: resolved.diffBytes,
      mediaType: CHANGE_SOURCE_DIFF_MEDIA_TYPE,
      adapter: diffSourceExtractorAdapter,
    },
    {
      role: "manifest" as const,
      bytes: resolved.manifestBytes,
      mediaType: CHANGE_SOURCE_MANIFEST_MEDIA_TYPE,
      adapter: changeSourceManifestExtractorAdapter,
    },
  ].map((original) => ({
    ...original,
    // A diff with no surviving file (an empty-tree range, or every file
    // omitted) still binds: it is the verified no-change evidence.
    bytes: changeSourceAcquiredOriginalBytes(original.bytes),
  }));
}

/**
 * The extraction field each budget overflow ran under. A caller may pass
 * limits narrower than the catalog's, so a refusal quotes this field rather
 * than the catalog or host value.
 */
const OVERFLOW_LIMIT_FIELDS: ReadonlyMap<string, "maxSpans" | "maxDerivativeBytes"> = new Map([
  [SOURCE_EXTRACTION_MAX_SPANS_LIMIT, "maxSpans"],
  [SOURCE_EXTRACTION_MAX_DERIVATIVE_BYTES_LIMIT, "maxDerivativeBytes"],
]);

/**
 * Extract one original whole. Extraction itself refuses an original over
 * `sources.extractionMaxOriginalBytes`; a clipped representation refuses here
 * at the limit it hit, with the bound it ran under and the observed size,
 * rather than bind part of the change.
 */
export async function extractChangeSourceOriginalWhole(
  original: ChangeSourceOriginalV1<string>,
  limits: SourceExtractionLimitsV1,
  options?: ResolveLimitsOptions,
) {
  const extracted = await extractSourceRepresentation({
    adapter: original.adapter,
    bytes: original.bytes,
    mediaType: original.mediaType,
    limits,
  });
  const overflow = extracted.representation.overflows?.[0];
  if (overflow) {
    const resolved = limit(overflow.limitName, options);
    const field = OVERFLOW_LIMIT_FIELDS.get(overflow.limitName);
    // An overflow with no extraction field, such as a page ceiling, ran under
    // the resolved limit itself.
    refuseLimit(
      field === undefined ? resolved : { ...resolved, value: limits[field] },
      overflow.observed,
    );
  }
  return extracted;
}

/**
 * Refuse a resolved range whose manifest or diff would not extract whole
 * under these limits. The resolver runs it before any model call.
 */
export async function assertChangeSourceExtractable(
  resolved: ChangeSourceOriginals,
  limits: SourceExtractionLimitsV1,
  options?: ResolveLimitsOptions,
): Promise<void> {
  for (const original of changeSourceOriginals(resolved)) {
    await extractChangeSourceOriginalWhole(original, limits, options);
  }
}

export interface AcquireChangeSourceObservationsInput {
  readonly resolved: ResolvedChangeSourceV1<ChangeSourceMemberV1>;
  readonly externalInputs: ExternalInputHostCapability;
  readonly readScope: readonly string[];
  readonly runIdSha256: string;
  readonly repository: SourceRepositoryBindingV1;
  readonly requestSha256: string;
  readonly observedAt: string;
  readonly limits: SourceExtractionLimitsV1;
  /** Defaults to `CHANGE_SOURCE_PRODUCER_IDS`. */
  readonly producerIds?: Readonly<Record<string, string>>;
  /**
   * The producer scope to seal instead of this range's own: a kind that binds
   * several records under one producer scopes them all once.
   */
  readonly producerScopeSha256?: string;
}

/** Where one original is recorded: its identity, locator and tracked path. */
export interface ChangeSourceOriginalPlacementV1 {
  readonly canonicalLocator: string;
  readonly originIdSha256: string;
  /** The revision the observation id and registration name. */
  readonly revision: string;
  /** What the original's bytes, named by their digest, are a version of. */
  readonly version: (originalSha256: string) => ReturnType<typeof originalVersion>;
  readonly repositoryPath: string;
}

export type MintChangeSourceOriginalContext = Pick<
  AcquireChangeSourceObservationsInput,
  "externalInputs" | "runIdSha256" | "repository" | "requestSha256" | "observedAt" | "limits"
> & {
  readonly producerId: string;
  readonly producerScopeSha256: string;
};

/** Extract one original whole, register it, and seal its observation. */
export async function mintChangeSourceOriginalObservation<Role extends string>(
  context: MintChangeSourceOriginalContext,
  original: ChangeSourceOriginalV1<Role>,
  placement: ChangeSourceOriginalPlacementV1,
): Promise<AcquiredChangeSourceOriginalEntryV1<Role>> {
  const { bytes } = original;
  const { producerId, producerScopeSha256: readScopeSha256 } = context;
  // The resolver already extracted the original under the run's limits;
  // this refuses only when an embedding host narrowed them since.
  const extracted = await extractChangeSourceOriginalWhole(original, context.limits);
  const locator = placement.canonicalLocator;
  const { originIdSha256, repositoryPath } = placement;
  const observationId = `obs-${canonicalDigest({
    schemaVersion: 1 as const,
    kind: "docsfab-source-observation-id" as const,
    originIdSha256,
    revision: placement.revision,
    originalSha256: extracted.originalSha256,
    representationSha256: extracted.representation.representationSha256,
  })}`;
  const inputId = `input-${canonicalDigest({
    schemaVersion: 1 as const,
    kind: "docsfab-source-input-id" as const,
    observationId,
  })}`;
  const { entrySha256 } = registerTrackedRepositorySourceInput(context.externalInputs, {
    inputId,
    canonicalLocator: locator,
    safeTitle: repositoryPath,
    contentDigestSha256: sha256Bytes(extracted.derivative),
    revision: placement.revision,
    producerId,
    producerVersion: CHANGE_SOURCE_PRODUCER_VERSION,
  });
  const observation = createSourceObservation({
    observationId,
    originIdSha256,
    inputId,
    registrationSha256: entrySha256,
    runIdSha256: context.runIdSha256,
    repository: context.repository,
    requestSha256: context.requestSha256,
    producerId,
    producerVersion: CHANGE_SOURCE_PRODUCER_VERSION,
    producerScopeSha256: readScopeSha256,
    acquisitionReceiptSha256: canonicalDigest({
      schemaVersion: 1 as const,
      kind: "docsfab-change-source-acquisition-receipt" as const,
      producerId,
      producerVersion: CHANGE_SOURCE_PRODUCER_VERSION,
      canonicalLocator: locator,
      originalSha256: extracted.originalSha256,
      byteLength: bytes.byteLength,
      readScopeSha256,
      representationSha256: extracted.representation.representationSha256,
      observedAt: context.observedAt,
    }),
    observedAt: context.observedAt,
    original: {
      sha256: extracted.originalSha256,
      byteLength: bytes.byteLength,
      mediaType: original.mediaType,
      locatorSha256: canonicalDigest({
        schemaVersion: 1 as const,
        kind: "docsfab-change-source-locator" as const,
        canonicalLocator: locator,
      }),
      version: placement.version(extracted.originalSha256),
      repositoryPath,
    },
    representations: [extracted.representation],
  });
  return {
    observation,
    representation: extracted.representation,
    derivative: extracted.derivative,
    repositoryPath,
    role: original.role,
  };
}

/** Mint the diff and manifest observations. */
export async function acquireChangeSourceObservations(
  input: AcquireChangeSourceObservationsInput,
): Promise<AcquiredChangeSourceV1> {
  const { changeSource } = input.resolved;
  const producerId = changeSourceProducerId(changeSource, input.producerIds);
  const readScopeSha256 =
    input.producerScopeSha256 ??
    digestChangeSourceProducerScope({
      changeSource,
      readScope: input.readScope,
      ...(input.producerIds ? { producerIds: input.producerIds } : {}),
    });
  const acquired: AcquiredChangeSourceEntryV1[] = [];
  for (const original of changeSourceOriginals(input.resolved)) {
    acquired.push(
      await mintChangeSourceOriginalObservation(
        { ...input, producerId, producerScopeSha256: readScopeSha256 },
        original,
        {
          canonicalLocator: canonicalLocator(changeSource, original.role),
          originIdSha256: canonicalDigest({
            schemaVersion: 1 as const,
            kind: "docsfab-change-source-origin" as const,
            ...rangeIdentity(changeSource),
            role: original.role,
          }),
          revision: changeSource.revision.head,
          version: (originalSha256) => originalVersion(changeSource, originalSha256),
          repositoryPath: changeSourceRepositoryPath(changeSource.revision.head, original.role),
        },
      ),
    );
  }
  return {
    changeSource,
    acquired: Object.freeze(acquired),
    producerScopes: Object.freeze([{ producerId, scopeSha256: readScopeSha256 }]),
  };
}
