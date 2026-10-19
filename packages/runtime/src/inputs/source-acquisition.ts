// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Tracked-repository acquisition producer: turns an explicit selection of
 * tracked files into a sealed `SourceBindingV1`.
 *
 * Every byte comes from the caller-supplied reader of the exact revision
 * export; this module never reaches a working tree. Identity is pure over
 * already-read bytes. There is no partial binding: if one selected path cannot
 * be bound soundly, the whole acquisition refuses.
 */
import { canonicalDigest } from "../content-ir/canonical.js";
import { registerTrackedRepositorySourceInput } from "./access.js";
import type { ExternalInputHostCapability } from "./contracts.js";
import {
  createSourceBinding,
  createSourceObservation,
  digestSourceProducerScopes,
  type SourceBindingV1,
  type SourceObservationV1,
  type SourceRepositoryBindingV1,
  type SourceRepresentationLimitation,
  type SourceRepresentationV1,
} from "./source-evidence.js";
import {
  classifySourceMediaType,
  createDefaultSourceExtractorRegistry,
  supportedSourceExtensions,
} from "./source-extractor-registry.js";
import {
  SourceExtractionError,
  extractSourceRepresentation,
  formatOriginalBudgetRefusal,
  formatTruncationRefusal,
  sha256Bytes,
  sourceExtractionLimits,
  type SourceExtractionErrorCode,
  type SourceExtractionLimitsV1,
  type SourceExtractorRegistryV1,
} from "./source-extraction.js";

export const TRACKED_SOURCE_PRODUCER_ID = "workspace-tracked-files" as const;
export const TRACKED_SOURCE_PRODUCER_VERSION = "1" as const;

/** Every refusal this producer can mint; each needs a remediation clause below. */
export const SOURCE_ACQUISITION_REFUSAL_CODES = [
  "empty-selection",
  "invalid-source-path",
  "duplicate-source-path",
  "path-outside-read-scope",
  "path-not-tracked",
  "unsupported-media-type",
  "input-over-limit",
  "extraction-timed-out",
  "extraction-cancelled",
  "extractor-limitation",
  "empty-read-scope",
] as const;

export type SourceAcquisitionRefusalCode = (typeof SOURCE_ACQUISITION_REFUSAL_CODES)[number];

/** A ceiling a refusal was measured against, in the unit the budget uses. */
export interface SourceAcquisitionRefusalLimitV1 {
  readonly amount: number;
  readonly unit: "bytes" | "spans";
}

/**
 * What an operator has to change to clear each refusal. `unsupported-media-type`
 * refusals raised before extraction list the effective registry's extensions,
 * so a narrower host does not name a format it would refuse.
 */
function refusalRemediation(
  code: SourceAcquisitionRefusalCode,
  limit: SourceAcquisitionRefusalLimitV1 | undefined,
  acceptedExtensions: readonly string[] | undefined,
): string {
  switch (code) {
    case "empty-selection":
      return "Name at least one tracked file with --source, or run without --source.";
    case "invalid-source-path":
      return "Pass a repository-relative path with no leading slash and no parent-directory segment, then run again.";
    case "duplicate-source-path":
      return "Name each file once, then run again.";
    case "path-outside-read-scope":
      return "Bind a file inside the granted read scope, or run without this selection.";
    case "path-not-tracked":
      return "Commit the file at the selected revision, or correct the path, then run again.";
    case "unsupported-media-type":
      return `No installed extractor claims this file's type. Bind a file whose extension is one of ${(acceptedExtensions ?? supportedSourceExtensions()).join(", ")}, or convert this one to a listed format, then run again.`;
    case "input-over-limit":
      return `The file or its extracted text exceeds the host's acquisition ceiling${limit === undefined ? "" : ` of ${limit.amount} ${limit.unit}`}. Split the document into smaller tracked files, or bind only the section you need, then run again.`;
    case "extraction-timed-out":
      return "Bind a smaller file, or split this one, then run again.";
    case "extraction-cancelled":
      return "Run the same command again and let acquisition finish.";
    case "extractor-limitation":
      return "Rebind a source whose text is machine-readable, for example a text-based export rather than a scan, then run again.";
    case "empty-read-scope":
      return "Grant a non-empty read scope to this run, then run again.";
  }
}

export class SourceAcquisitionError extends Error {
  public constructor(
    public readonly code: SourceAcquisitionRefusalCode,
    public readonly repositoryPath?: string,
    /**
     * The extraction-seam code this refusal was translated from, kept out of the
     * message. Both codes are fixed enumerations and cannot carry document bytes.
     */
    public readonly extractionCode?: SourceExtractionErrorCode,
    public readonly limit?: SourceAcquisitionRefusalLimitV1,
    public readonly acceptedExtensions?: readonly string[],
    /**
     * A catalogued bound's line, which names the limit's refusal code, the
     * observed value, the bound in force, and the remediation with its
     * override. It stands in for the generic remediation. Host text only.
     */
    public readonly limitRefusal?: string,
  ) {
    super(
      `Source acquisition refused: ${code}${repositoryPath ? ` (${repositoryPath})` : ""}. ${limitRefusal ?? refusalRemediation(code, limit, acceptedExtensions)}`,
    );
    this.name = "SourceAcquisitionError";
  }
}

function refuse(
  code: SourceAcquisitionRefusalCode,
  repositoryPath?: string,
  extractionCode?: SourceExtractionErrorCode,
  limit?: SourceAcquisitionRefusalLimitV1,
  acceptedExtensions?: readonly string[],
  limitRefusal?: string,
): never {
  throw new SourceAcquisitionError(
    code,
    repositoryPath,
    extractionCode,
    limit,
    acceptedExtensions,
    limitRefusal,
  );
}

/**
 * Seam refusals about the host's budget, the caller giving up, or an
 * unsupported type rather than the document's content, so they are not
 * reported as `extractor-limitation`. They still refuse the whole binding.
 */
const SEAM_REFUSAL_CODES: Readonly<
  Partial<Record<SourceExtractionErrorCode, SourceAcquisitionRefusalCode>>
> = Object.freeze({
  "extraction-deadline-exceeded": "extraction-timed-out",
  "extraction-cancelled": "extraction-cancelled",
  "original-budget-exceeded": "input-over-limit",
  "unsupported-media-type": "unsupported-media-type",
});

/**
 * Limitations that make the sealed binding unsound: an undecodable or
 * unwalkable derivative could let a citation point at text the original lacks.
 */
export const UNSOUND_REPRESENTATION_LIMITATIONS: readonly SourceRepresentationLimitation[] =
  Object.freeze(["unsupported-encoding", "unsupported-structure"]);

/** Limitations meaning the derivative stops short of the original; acquisition refuses. */
export const TRUNCATING_REPRESENTATION_LIMITATIONS: readonly SourceRepresentationLimitation[] =
  Object.freeze(["byte-budget-truncated", "span-budget-truncated"]);

/** Trusted byte source and the only I/O seam in this module. */
export interface TrackedSourceReaderV1 {
  isTrackedRegularFile(repositoryPath: string): Promise<boolean>;
  /**
   * Every tracked regular file of the selected revision, when the reader can
   * list them. First-pass evidence acquisition ranks these instead of walking
   * the exported tree.
   */
  listTrackedRegularFiles?(): Promise<readonly string[]>;
  /**
   * Implementations read the immutable revision export, never a working tree,
   * and reject over-limit inputs with `TrackedSourceOversizeError`.
   */
  readTrackedBytes(repositoryPath: string, maxBytes: number): Promise<Uint8Array>;
}

export class TrackedSourceOversizeError extends Error {
  public constructor(
    public readonly repositoryPath: string,
    /** The file's byte length at the selected revision, when the reader knows it. */
    public readonly observedBytes?: number,
  ) {
    super("Tracked source file exceeds the admitted acquisition ceiling.");
    this.name = "TrackedSourceOversizeError";
  }
}

const REPOSITORY_PATH_CHARACTERS = /^[A-Za-z0-9._/-]{1,1024}$/u;

/**
 * Validate one repository-relative source path.
 *
 * Stricter than the `SourceOriginalV1.repositoryPath` shape, which admits a
 * leading `/`, empty segments, and `.` segments; every path reaching a
 * repository probe passes through here.
 */
export function normalizeSourcePath(value: unknown): string {
  if (
    typeof value !== "string" ||
    value !== value.normalize("NFC") ||
    value.includes("\\") ||
    value.includes("\0") ||
    !REPOSITORY_PATH_CHARACTERS.test(value)
  ) {
    refuse("invalid-source-path", typeof value === "string" ? value : undefined);
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    refuse("invalid-source-path", value);
  }
  return value;
}

/** A read-scope entry is `"."` for the whole exported tree or a directory prefix. */
export function normalizeSourceReadScope(scope: readonly string[]): readonly string[] {
  if (scope.length === 0) refuse("empty-read-scope");
  const normalized = scope.map((entry) => (entry === "." ? "." : normalizeSourcePath(entry)));
  return Object.freeze([...new Set(normalized)].sort());
}

/** A scope prefix matches only on a path separator boundary. */
export function isWithinSourceReadScope(
  repositoryPath: string,
  readScope: readonly string[],
): boolean {
  return readScope.some(
    (entry) => entry === "." || repositoryPath === entry || repositoryPath.startsWith(`${entry}/`),
  );
}

/**
 * Digest the host-granted read scope the binding commits to. It is independent
 * of the selection: widening the grant changes it, selecting fewer files does not.
 */
export function digestSourceReadScope(input: {
  repository: SourceRepositoryBindingV1;
  readScope: readonly string[];
}): string {
  return canonicalDigest({
    schemaVersion: 1 as const,
    kind: "docsfab-source-read-scope" as const,
    producerId: TRACKED_SOURCE_PRODUCER_ID,
    producerVersion: TRACKED_SOURCE_PRODUCER_VERSION,
    repositoryIdentitySha256: input.repository.identitySha256,
    readScope: [...normalizeSourceReadScope(input.readScope)],
  });
}

/** Revision-independent identity for one repository origin. */
export function computeSourceOriginId(input: {
  repository: SourceRepositoryBindingV1;
  repositoryPath: string;
}): string {
  return canonicalDigest({
    schemaVersion: 1 as const,
    kind: "docsfab-source-repository-origin" as const,
    repositoryIdentitySha256: input.repository.identitySha256,
    repositoryPath: input.repositoryPath,
  });
}

export function trackedSourceCanonicalLocator(repositoryPath: string): string {
  return `repository-document:${repositoryPath}`;
}

/** Content-free receipt for one acquisition. */
export function computeAcquisitionReceiptSha256(input: {
  repository: SourceRepositoryBindingV1;
  repositoryPath: string;
  originalSha256: string;
  byteLength: number;
  mediaType: string;
  readScopeSha256: string;
  representationSha256: string;
  observedAt: string;
}): string {
  return canonicalDigest({
    schemaVersion: 1 as const,
    kind: "docsfab-source-acquisition-receipt" as const,
    producerId: TRACKED_SOURCE_PRODUCER_ID,
    producerVersion: TRACKED_SOURCE_PRODUCER_VERSION,
    repository: { ...input.repository },
    repositoryPath: input.repositoryPath,
    originalSha256: input.originalSha256,
    byteLength: input.byteLength,
    mediaType: input.mediaType,
    readScopeSha256: input.readScopeSha256,
    representationSha256: input.representationSha256,
    observedAt: input.observedAt,
  });
}

/** Host-computed observation identity, bound to the origin and the exact bytes. */
export function computeSourceObservationId(input: {
  originIdSha256: string;
  revision: string;
  originalSha256: string;
  representationSha256: string;
}): string {
  return `obs-${canonicalDigest({
    schemaVersion: 1 as const,
    kind: "docsfab-source-observation-id" as const,
    originIdSha256: input.originIdSha256,
    revision: input.revision,
    originalSha256: input.originalSha256,
    representationSha256: input.representationSha256,
  })}`;
}

export function computeSourceInputId(observationId: string): string {
  return `input-${canonicalDigest({
    schemaVersion: 1 as const,
    kind: "docsfab-source-input-id" as const,
    observationId,
  })}`;
}

/** Reject a representation whose limitations make the sealed binding unsound. */
export function assertSoundRepresentation(
  representation: SourceRepresentationV1,
  repositoryPath: string,
  /** When supplied, a truncation refusal names the ceiling that fired. */
  limits?: Pick<SourceExtractionLimitsV1, "maxDerivativeBytes" | "maxSpans">,
): void {
  for (const limitation of representation.limitations) {
    if (TRUNCATING_REPRESENTATION_LIMITATIONS.includes(limitation)) {
      const limit: SourceAcquisitionRefusalLimitV1 | undefined =
        limitation === "byte-budget-truncated" && limits?.maxDerivativeBytes !== undefined
          ? { amount: limits.maxDerivativeBytes, unit: "bytes" }
          : limitation === "span-budget-truncated" && limits?.maxSpans !== undefined
            ? { amount: limits.maxSpans, unit: "spans" }
            : undefined;
      refuse(
        "input-over-limit",
        repositoryPath,
        undefined,
        limit,
        undefined,
        // The catalog line names the limit, the size the adapter produced, and
        // the bound in force, so a raisable ceiling says how to raise it.
        formatTruncationRefusal(
          representation,
          limitation as "byte-budget-truncated" | "span-budget-truncated",
          limit?.amount,
        ),
      );
    }
    if (UNSOUND_REPRESENTATION_LIMITATIONS.includes(limitation)) {
      refuse("extractor-limitation", repositoryPath);
    }
  }
}

/**
 * Normalize the operator's selection into sorted order. A duplicate is refused
 * rather than collapsed, because it usually means the caller meant another file.
 */
export function normalizeSourceSelection(
  selection: readonly string[],
  readScope: readonly string[],
): readonly string[] {
  if (selection.length === 0) refuse("empty-selection");
  const scope = normalizeSourceReadScope(readScope);
  const seen = new Set<string>();
  const normalized = selection.map((entry) => {
    const path = normalizeSourcePath(entry);
    if (seen.has(path)) refuse("duplicate-source-path", path);
    seen.add(path);
    if (!isWithinSourceReadScope(path, scope)) refuse("path-outside-read-scope", path);
    return path;
  });
  return Object.freeze([...normalized].sort());
}

export interface AcquireTrackedSourceBindingInput {
  reader: TrackedSourceReaderV1;
  externalInputs: ExternalInputHostCapability;
  /** Defaults to the shipped registry; tests inject a narrower one. */
  registry?: SourceExtractorRegistryV1;
  selection: readonly string[];
  /** Host-granted read scope: `["."]` for the whole exported tree. */
  readScope: readonly string[];
  runIdSha256: string;
  repository: SourceRepositoryBindingV1;
  requestSha256: string;
  hostPolicySha256: string;
  observedAt: string;
  limits?: Partial<SourceExtractionLimitsV1>;
  signal?: AbortSignal;
}

export interface AcquiredSourceV1 {
  observation: SourceObservationV1;
  representation: SourceRepresentationV1;
  /** The retained derivative bytes the reader will later serve. */
  derivative: Uint8Array;
  repositoryPath: string;
}

export interface AcquiredSourceBindingV1 {
  binding: SourceBindingV1;
  acquired: readonly AcquiredSourceV1[];
  producerScopes: ReadonlyArray<{ producerId: string; scopeSha256: string }>;
  readScope: readonly string[];
}

/**
 * Acquire the selected tracked files and mint the run's source binding.
 *
 * Refusal order per path is scope, tracking, media type, then bytes, so a path
 * outside the grant never reaches the repository.
 */
export async function acquireTrackedSourceBinding(
  input: AcquireTrackedSourceBindingInput,
): Promise<AcquiredSourceBindingV1> {
  const readScope = normalizeSourceReadScope(input.readScope);
  const selection = normalizeSourceSelection(input.selection, readScope);
  const registry = input.registry ?? createDefaultSourceExtractorRegistry();
  // Resolved per call, after the host has loaded its configuration root, so an
  // override there applies; a module-load snapshot would miss it.
  const limits: SourceExtractionLimitsV1 = {
    ...sourceExtractionLimits(),
    ...(input.limits ?? {}),
  };
  const readScopeSha256 = digestSourceReadScope({
    repository: input.repository,
    readScope,
  });

  const acquired: AcquiredSourceV1[] = [];
  for (const repositoryPath of selection) {
    if (!(await input.reader.isTrackedRegularFile(repositoryPath))) {
      refuse("path-not-tracked", repositoryPath);
    }
    const mediaType = classifySourceMediaType(repositoryPath);
    const accepted = supportedSourceExtensions(registry.list());
    if (mediaType === undefined) {
      refuse("unsupported-media-type", repositoryPath, undefined, undefined, accepted);
    }
    const adapter = registry.resolve(mediaType);
    if (adapter === undefined) {
      refuse("unsupported-media-type", repositoryPath, undefined, undefined, accepted);
    }

    let bytes: Uint8Array;
    try {
      bytes = await input.reader.readTrackedBytes(repositoryPath, limits.maxOriginalBytes);
    } catch (error) {
      if (error instanceof TrackedSourceOversizeError) {
        refuse(
          "input-over-limit",
          repositoryPath,
          undefined,
          { amount: limits.maxOriginalBytes, unit: "bytes" },
          undefined,
          formatOriginalBudgetRefusal(error.observedBytes, limits.maxOriginalBytes),
        );
      }
      throw error;
    }

    const extracted = await extractOne({
      adapter,
      bytes,
      mediaType,
      limits,
      repositoryPath,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    assertSoundRepresentation(extracted.representation, repositoryPath, limits);

    const originIdSha256 = computeSourceOriginId({
      repository: input.repository,
      repositoryPath,
    });
    const observationId = computeSourceObservationId({
      originIdSha256,
      revision: input.repository.revision,
      originalSha256: extracted.originalSha256,
      representationSha256: extracted.representation.representationSha256,
    });
    const inputId = computeSourceInputId(observationId);
    const { entrySha256 } = registerTrackedRepositorySourceInput(input.externalInputs, {
      inputId,
      canonicalLocator: trackedSourceCanonicalLocator(repositoryPath),
      safeTitle: repositoryPath,
      contentDigestSha256: sha256Bytes(extracted.derivative),
      revision: input.repository.revision,
      producerId: TRACKED_SOURCE_PRODUCER_ID,
      producerVersion: TRACKED_SOURCE_PRODUCER_VERSION,
    });

    const observation = createSourceObservation({
      observationId,
      originIdSha256,
      inputId,
      registrationSha256: entrySha256,
      runIdSha256: input.runIdSha256,
      repository: input.repository,
      requestSha256: input.requestSha256,
      producerId: TRACKED_SOURCE_PRODUCER_ID,
      producerVersion: TRACKED_SOURCE_PRODUCER_VERSION,
      producerScopeSha256: readScopeSha256,
      acquisitionReceiptSha256: computeAcquisitionReceiptSha256({
        repository: input.repository,
        repositoryPath,
        originalSha256: extracted.originalSha256,
        byteLength: bytes.byteLength,
        mediaType,
        readScopeSha256,
        representationSha256: extracted.representation.representationSha256,
        observedAt: input.observedAt,
      }),
      observedAt: input.observedAt,
      original: {
        sha256: extracted.originalSha256,
        byteLength: bytes.byteLength,
        mediaType,
        locatorSha256: canonicalDigest({
          schemaVersion: 1 as const,
          kind: "docsfab-source-repository-locator" as const,
          canonicalLocator: trackedSourceCanonicalLocator(repositoryPath),
        }),
        version: { kind: "repository-revision", revision: input.repository.revision },
        repositoryPath,
      },
      representations: [extracted.representation],
    });
    acquired.push({
      observation,
      representation: extracted.representation,
      derivative: extracted.derivative,
      repositoryPath,
    });
  }

  const producerScopes = Object.freeze([
    { producerId: TRACKED_SOURCE_PRODUCER_ID, scopeSha256: readScopeSha256 },
  ]);
  const binding = createSourceBinding({
    runIdSha256: input.runIdSha256,
    repository: input.repository,
    requestSha256: input.requestSha256,
    hostPolicySha256: input.hostPolicySha256,
    producerScopeSha256: digestSourceProducerScopes(producerScopes),
    parentBindingSha256: null,
    observations: acquired.map((entry) => ({
      observationId: entry.observation.observationId,
      observationSha256: entry.observation.observationSha256,
    })),
    // A run that never read a selected source may not write.
    requiredObservationIds: acquired.map((entry) => entry.observation.observationId),
  });
  return { binding, acquired: Object.freeze(acquired), producerScopes, readScope };
}

/**
 * Run one adapter through the host seam and translate its refusals; an
 * untranslated seam code becomes `extractor-limitation` and keeps its seam code.
 */
async function extractOne(input: {
  adapter: Parameters<typeof extractSourceRepresentation>[0]["adapter"];
  bytes: Uint8Array;
  mediaType: string;
  limits: SourceExtractionLimitsV1;
  repositoryPath: string;
  signal?: AbortSignal;
}): Promise<Awaited<ReturnType<typeof extractSourceRepresentation>>> {
  try {
    return await extractSourceRepresentation({
      adapter: input.adapter,
      bytes: input.bytes,
      mediaType: input.mediaType,
      limits: input.limits,
      ...(input.signal ? { signal: input.signal } : {}),
    });
  } catch (error) {
    if (error instanceof SourceExtractionError) {
      refuse(
        SEAM_REFUSAL_CODES[error.code] ?? "extractor-limitation",
        input.repositoryPath,
        error.code,
        undefined,
        undefined,
        // A budget refusal keeps its catalog line through the re-wrap.
        error.limitRefusal,
      );
    }
    throw error;
  }
}
