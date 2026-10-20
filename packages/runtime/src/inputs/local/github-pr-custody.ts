// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Process-local PR bytes behind the released source authority and ledgers. */
import { createHash } from "node:crypto";
import { canonicalDigest } from "../../content-ir/canonical.js";
import type { SourceEvidenceRunnerBinding } from "../../execution/contracts/execution-services.js";
import {
  getRegisteredExternalInput,
  listExternalInputAccessObservations,
  openExternalInputAccessCapture,
  recordExternalInputAccess,
  registerTrackedRepositorySourceInput,
} from "../access.js";
import {
  citeExternalInput,
  createExternalInputCitationLedger,
  openExternalInputCitationCapture,
} from "../citation.js";
import type { ExternalInputHostCapability } from "../contracts.js";
import {
  readTrackedRepositoryFile,
  trackedRepositoryBlobObjectId,
  trackedRepositoryEntryKind,
} from "../../repository/workspace/tracked-read.js";
import { digestExternalInputLocator } from "../contracts.js";
import type { GithubPrHeadWorkspace } from "../../repository/workspace/contracts.js";
import {
  digestSourceReadScope,
  isWithinSourceReadScope,
  normalizeSourceReadScope,
  TRACKED_SOURCE_PRODUCER_ID,
  TRACKED_SOURCE_PRODUCER_VERSION,
  trackedSourceCanonicalLocator,
} from "../source-acquisition.js";
import {
  createSourceBinding,
  createSourceObservation,
  decodeSourceObservation,
  createSourceRepresentation,
  computeSourceSpanId,
  digestSourceProducerScopes,
  MAX_OBSERVATIONS,
  SOURCE_EXACT_ORIGINAL_FORM,
  type SourceBindingV1,
  type SourceObservationV1,
  type SourceRepositoryBindingV1,
  type SourceRepresentationV1,
} from "../source-evidence.js";
import {
  sourceExtractionMaxOriginalBytes,
  sourceExtractionMaxSpanBytes,
  sourceExtractionMaxSpans,
} from "../../config/source-read-limits.js";
import {
  DEFAULT_TOOL_OUTPUT_CAP_BYTES,
  assertValidToolOutputCapBytes,
} from "../../harness/tool-output-cap.js";
import {
  createSourceArtifactReference,
  type SourceArtifactReferenceV2,
} from "../source-evidence-artifacts.js";
import {
  SourceExtractionError,
  extractSourceRepresentation,
  sha256Bytes,
} from "../source-extraction.js";
import { createDefaultSourceExtractorRegistry } from "../source-extractor-registry.js";
import {
  createSourceEvidenceHostAuthority,
  createSourceEvidenceService,
  type SourceEvidenceHostVerifier,
} from "../source-resolver.js";
import type { SourceStepPolicyV1 } from "../source-step-policy.js";
import {
  createChangeSnapshot,
  type ChangeSnapshotLimitationV1,
  type ChangeSnapshotSourceSideV1,
  type ChangeSnapshotV1,
} from "../change-snapshot.js";
import {
  acquireGithubPrObjects,
  assertGithubPrReviewBasis,
  assertGithubPrObjectAcquisition,
  type AcquireGithubPrOptions,
  type GithubPrObjectAcquisition,
  type GithubPrObjectSide,
  type GithubPrReviewBasis,
} from "../adapters/github-pr-provider.js";

export const GITHUB_PR_SOURCE_PRODUCER_ID = "github-pr-immutable-source" as const;
export const GITHUB_PR_SOURCE_PRODUCER_VERSION = "1" as const;

export class GithubPrCustodyError extends Error {
  constructor(
    readonly code: string,
    readonly observed?: number,
    readonly bound?: number,
  ) {
    super(
      observed === undefined
        ? code
        : `${code}: observed ${observed}, bound ${bound}; narrow the PR or increase the declared source capacity.`,
    );
    this.name = "GithubPrCustodyError";
  }
}

function fail(code: string): never {
  throw new GithubPrCustodyError(code);
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function gitBlobId(bytes: Buffer): string {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

function sideKey(
  side: Pick<GithubPrObjectSide, "side" | "path" | "repositoryId" | "blobId">,
): string {
  return `${side.side}\0${side.repositoryId}\0${side.path}\0${side.blobId}`;
}

interface RetainedSide {
  readonly descriptor: ChangeSnapshotSourceSideV1;
  readonly original: Buffer;
  readonly derivative: Buffer | null;
  readonly observation: SourceObservationV1 | null;
}

interface RetainedHSource {
  readonly observation: SourceObservationV1;
  readonly original: Buffer;
  readonly derivatives: ReadonlyMap<string, Buffer>;
  readonly blobId: string;
}

function registrationDigest(input: ReturnType<typeof getRegisteredExternalInput>): string {
  const { initialLifecycle, ...rest } = input;
  return canonicalDigest({ ...rest, lifecycleState: initialLifecycle });
}

/** Partition a valid UTF-8 original without changing a code point or byte offset. */
function originalRepresentation(original: Buffer, outputCapBytes: number): SourceRepresentationV1 {
  const maxSpanBytes = sourceExtractionMaxSpanBytes();
  const maxSpans = sourceExtractionMaxSpans();
  if (original.length > sourceExtractionMaxOriginalBytes())
    // hygiene: envelope - GithubPrCustodyError renders the code with observed, bound and remedy.
    throw new GithubPrCustodyError(
      "github-pr-source-original-capacity",
      original.length,
      sourceExtractionMaxOriginalBytes(),
    );
  const decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(original);
  const spans: Array<{ startByte: number; endByte: number }> = [];
  let startByte = 0;
  let endByte = 0;
  for (const codePoint of decoded) {
    const size = Buffer.byteLength(codePoint, "utf8");
    if (endByte > startByte && endByte + size - startByte > maxSpanBytes) {
      spans.push({ startByte, endByte });
      startByte = endByte;
    }
    endByte += size;
  }
  if (endByte !== original.length) fail("github-pr-source-utf8-roundtrip");
  spans.push({ startByte, endByte });
  if (spans.length > maxSpans)
    // hygiene: envelope - GithubPrCustodyError renders the code with observed, bound and remedy.
    throw new GithubPrCustodyError("github-pr-source-span-capacity", spans.length, maxSpans);
  const originalSha256 = sha256(original);
  const extractor = {
    id: "github-pr-exact-original-utf8",
    version: "1",
    optionsSha256: canonicalDigest({
      kind: "docsfab-github-pr-exact-original-options",
      maxSpanBytes,
      maxSpans,
      outputCapBytes,
    }),
  };
  return createSourceRepresentation({
    form: SOURCE_EXACT_ORIGINAL_FORM,
    sha256: originalSha256,
    byteLength: original.length,
    extractor,
    originalSha256,
    spans: spans.map(({ startByte, endByte }) => ({
      spanId: computeSourceSpanId({
        originalSha256,
        derivativeSha256: originalSha256,
        extractor,
        startByte,
        endByte,
        locator: { kind: "text", startByte, endByte },
        ...(original.length === 0 ? { allowEmptyOriginalWitness: true } : {}),
      }),
      startByte,
      endByte,
      locator: { kind: "text", startByte, endByte },
    })),
    completeness: "complete",
    limitations: [],
  });
}

/** The paired exact UTF-8 view used by a callback-local H source provider. */
export function createGithubPrHOriginalRepresentation(
  original: Uint8Array,
  outputCapBytes = DEFAULT_TOOL_OUTPUT_CAP_BYTES,
): SourceRepresentationV1 {
  assertValidToolOutputCapBytes(outputCapBytes);
  return originalRepresentation(Buffer.from(original), outputCapBytes);
}

function verifyRetained(side: RetainedSide): void {
  const original = side.original;
  if (
    gitBlobId(original) !== side.descriptor.blobId ||
    sha256(original) !== side.descriptor.originalSha256 ||
    original.length !== side.descriptor.originalByteLength
  )
    fail("github-pr-original-changed");
  const observation = side.observation;
  if (observation === null) {
    if (side.derivative !== null) fail("github-pr-derivative-substituted");
    return;
  }
  if (
    observation.original.sha256 !== side.descriptor.originalSha256 ||
    observation.original.byteLength !== original.length ||
    observation.original.repositoryPath !== side.descriptor.path ||
    (!observation.primaryContentForm && side.derivative === null)
  )
    fail("github-pr-source-substituted");
  for (const representation of observation.representations) {
    if (representation.form === SOURCE_EXACT_ORIGINAL_FORM) {
      if (
        representation.sha256 !== sha256(original) ||
        representation.byteLength !== original.length
      )
        fail("github-pr-original-changed");
      continue;
    }
    if (!side.derivative || sha256(side.derivative) !== representation.sha256)
      fail("github-pr-derivative-changed");
    for (const span of representation.spans) {
      if (span.locator.kind !== "text") fail("github-pr-source-locator-unsupported");
      const fromOriginal = original.subarray(span.locator.startByte, span.locator.endByte);
      const fromDerivative = side.derivative.subarray(span.startByte, span.endByte);
      if (!fromOriginal.equals(fromDerivative)) fail("github-pr-source-range-mismatch");
    }
  }
}

export interface GithubPrCustodyContext {
  readonly runId: string;
  readonly requestSha256: string;
  /** The selected local workspace, deliberately distinct from target/fork IDs. */
  readonly repository: SourceRepositoryBindingV1;
  readonly workspaceIdentitySha256: string;
  readonly repositoryContentDigest: string;
  readonly policy: SourceStepPolicyV1;
  readonly observedAt: string;
  /** The admitted source-tool cap; the current runner cap is checked again at read time. */
  readonly toolOutputCapBytes?: number;
}

/** A callback-local source supplier may return observations, never another binding. */
export interface GithubPrHSourceHostContext extends GithubPrCustodyContext {
  readonly externalInputs: ExternalInputHostCapability;
  readonly headWorkspace: GithubPrHeadWorkspace;
  readonly runIdSha256: string;
  readonly signal: AbortSignal;
}

export interface GithubPrHSourcePrivateHandlers {
  resolveDerivative: SourceEvidenceHostVerifier["resolveDerivative"];
  resolveOriginal: NonNullable<SourceEvidenceHostVerifier["resolveOriginal"]>;
  recordAccess: SourceEvidenceHostVerifier["recordAccess"];
  recordCitation: NonNullable<SourceEvidenceHostVerifier["recordCitation"]>;
  dispose(): void;
}

export interface GithubPrHSourceObservations {
  readonly observations: readonly SourceObservationV1[];
  readonly producerScopes: ReadonlyArray<{ producerId: string; scopeSha256: string }>;
  readonly readScope: readonly string[];
  readonly handlers: GithubPrHSourcePrivateHandlers;
}

export interface GithubPrCustodyOptions {
  readonly basis: GithubPrReviewBasis;
  readonly acquireHSourceObservations: (
    host: GithubPrHSourceHostContext,
  ) => Promise<GithubPrHSourceObservations>;
}

export interface GithubPrCustody {
  readonly snapshot: ChangeSnapshotV1;
  readonly binding: SourceBindingV1 | null;
  readonly observations: readonly SourceObservationV1[];
  readonly sourceEvidence: SourceEvidenceRunnerBinding | null;
  readonly sourceReference: SourceArtifactReferenceV2<"source-binding"> | null;
  readonly externalInputs: ExternalInputHostCapability;
  readonly retainedOriginalBytes: number;
  readonly retainedDerivativeBytes: number;
  /** Host-only read: every supplied identity member must match a sealed side. */
  readonly readOriginal: (identity: {
    side: "before" | "after";
    path: string;
    repositoryId: number;
    blobId: string;
  }) => Buffer;
  readonly dispose: () => void;
}

/** Consume only a genuine producer result; returned bytes are fresh copies. */
export async function createGithubPrCustody(
  acquired: GithubPrObjectAcquisition,
  context: GithubPrCustodyContext,
  options?: GithubPrCustodyOptions,
): Promise<GithubPrCustody> {
  assertGithubPrObjectAcquisition(acquired);
  function assertLiveHSourceBasis(): void {
    if (options === undefined) return;
    assertGithubPrReviewBasis(options.basis);
    if (options.basis.signal.aborted) fail("github-pr-source-basis-aborted");
  }
  if (options !== undefined) {
    assertLiveHSourceBasis();
    if (options.basis.acquisition !== acquired) fail("github-pr-source-basis-substituted");
    const head = options.basis.headWorkspace;
    // The graph identity authenticates H's bytes and tree. The run's repository
    // and workspace identities use the admitted source-path projection instead.
    const repositoryIdentitySha256 = sha256(head.sourcePath);
    const workspaceIdentitySha256 = canonicalDigest({
      schemaVersion: 1 as const,
      kind: "docsfab-source-workspace-identity" as const,
      workspacePathSha256: sha256(head.path),
      repositoryIdentitySha256,
      revision: head.revision,
    });
    if (
      head.H !== acquired.graph.H ||
      head.headTree !== acquired.graph.headTree ||
      head.headRepositoryId !== acquired.headRepositoryId ||
      head.revision !== acquired.graph.H ||
      context.repository.revision !== acquired.graph.H ||
      context.repository.identitySha256 !== repositoryIdentitySha256 ||
      context.workspaceIdentitySha256 !== workspaceIdentitySha256
    )
      fail("github-pr-source-head-substituted");
  }
  const runIdSha256 = sha256(context.runId);
  const scopeSha256 = canonicalDigest({
    kind: "docsfab-github-pr-source-scope",
    ref: acquired.ref.referenceSha256,
    B: acquired.graph.B,
    H: acquired.graph.H,
    M: acquired.graph.M,
    manifestSha256: canonicalDigest(acquired.manifest),
  });
  const producerScopes: Array<{ producerId: string; scopeSha256: string }> = [
    { producerId: GITHUB_PR_SOURCE_PRODUCER_ID, scopeSha256 },
  ];
  const registry = createDefaultSourceExtractorRegistry();
  const admittedOutputCapBytes = context.toolOutputCapBytes ?? DEFAULT_TOOL_OUTPUT_CAP_BYTES;
  assertValidToolOutputCapBytes(admittedOutputCapBytes);
  const prepared: Array<{
    side: GithubPrObjectSide;
    original: Buffer;
    derivative: Buffer | null;
    representation: SourceRepresentationV1 | null;
    rawRepresentation: SourceRepresentationV1 | null;
    limitation: ChangeSnapshotLimitationV1 | null;
  }> = [];
  let hSource: GithubPrHSourceObservations | undefined;
  const retainedH = new Map<string, RetainedHSource>();
  try {
    for (const side of acquired.sides) {
      const original = Buffer.from(side.bytes);
      if (gitBlobId(original) !== side.blobId || sha256(original) !== side.originalSha256)
        fail("github-pr-original-changed");
      // The released text adapter maps a decoding failure to the generic
      // adapter-failed host refusal. Identify that one known content limitation
      // before invoking it; other adapter failures remain hard refusals.
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(original);
      } catch {
        prepared.push({
          side,
          original,
          derivative: null,
          representation: null,
          rawRepresentation: null,
          limitation: { side: side.side, path: side.path, reason: "unsupported-content" },
        });
        continue;
      }
      const adapter = registry.resolve(side.mediaType);
      if (!adapter) fail("github-pr-source-adapter-unavailable");
      try {
        const extracted = await extractSourceRepresentation({
          adapter,
          bytes: original,
          mediaType: side.mediaType,
        });
        if (extracted.originalSha256 !== side.originalSha256) fail("github-pr-original-changed");
        const representation = extracted.representation;
        const unsupported = representation.limitations.some(
          (entry) => entry === "unsupported-encoding" || entry === "unsupported-structure",
        );
        const limitation: ChangeSnapshotLimitationV1 | null = unsupported
          ? { side: side.side, path: side.path, reason: "unsupported-content" }
          : representation.completeness === "partial"
            ? { side: side.side, path: side.path, reason: "partial-extraction" }
            : null;
        prepared.push({
          side,
          original,
          derivative: unsupported ? null : Buffer.from(extracted.derivative),
          representation: unsupported ? null : representation,
          rawRepresentation: unsupported
            ? null
            : originalRepresentation(original, admittedOutputCapBytes),
          limitation,
        });
      } catch (error) {
        if (error instanceof SourceExtractionError && error.code === "empty-extraction") {
          prepared.push({
            side,
            original,
            derivative: null,
            representation: null,
            rawRepresentation: originalRepresentation(original, admittedOutputCapBytes),
            limitation: {
              side: side.side,
              path: side.path,
              reason: "empty-extraction",
            },
          });
        } else {
          throw error;
        }
      }
    }
    const count = prepared.filter((row) => row.rawRepresentation !== null).length;
    if (count > MAX_OBSERVATIONS) {
      const code = "github-pr-source-observation-capacity";
      throw new GithubPrCustodyError(code, count, MAX_OBSERVATIONS);
    }

    const externalInputs = openExternalInputAccessCapture({
      runIdSha256,
      repository: context.repository,
    });
    openExternalInputCitationCapture(externalInputs);
    const observations: SourceObservationV1[] = [];
    const retained = new Map<string, RetainedSide>();
    const sourceSides: ChangeSnapshotSourceSideV1[] = [];
    const limitations: ChangeSnapshotLimitationV1[] = [];
    const acquiredSideKeys = new Set(acquired.sides.map(sideKey));
    // The NUL manifest is complete, including binary, symlink and gitlink
    // sides. Name every present side the Markdown/MDX producer cannot expose as
    // text; an absent add/delete side is not an unsupported empty document.
    for (const row of acquired.manifest) {
      for (const side of ["before", "after"] as const) {
        const path = side === "before" ? row.oldPath : row.newPath;
        const blobId = side === "before" ? row.oldId : row.newId;
        if (path === null || blobId === null) continue;
        const repositoryId =
          side === "before" ? Number(acquired.ref.targetRepositoryId) : acquired.headRepositoryId;
        if (!acquiredSideKeys.has(sideKey({ side, path, repositoryId, blobId }))) {
          limitations.push({ side, path, reason: "unsupported-content" });
        }
      }
    }
    for (const row of prepared) {
      const { side, original, derivative, representation, rawRepresentation, limitation } = row;
      if (limitation) limitations.push(limitation);
      const exactLocatorPath =
        side.path === side.path.normalize("NFC")
          ? side.path
          : `utf8-base64url:${Buffer.from(side.path, "utf8").toString("base64url")}`;
      const canonicalLocator =
        `repository-document:github-pr:${acquired.ref.referenceSha256}:${side.side}:` +
        `${side.repositoryId}:${side.blobId}:${exactLocatorPath}`;
      let observation: SourceObservationV1 | null = null;
      if (rawRepresentation !== null) {
        const originIdSha256 = canonicalDigest({
          kind: "docsfab-github-pr-source-origin",
          referenceSha256: acquired.ref.referenceSha256,
          side: side.side,
          repositoryId: side.repositoryId,
          path: side.path,
          blobId: side.blobId,
        });
        const observationId = `obs-${canonicalDigest({
          kind: "docsfab-github-pr-observation-id",
          originIdSha256,
          originalSha256: side.originalSha256,
          representationSha256: rawRepresentation.representationSha256,
          revision: context.repository.revision,
        })}`;
        const primaryInputId = `input-${canonicalDigest({
          kind: "docsfab-github-pr-input-id",
          observationId,
        })}`;
        const originalInputId =
          representation === null
            ? primaryInputId
            : `input-${canonicalDigest({ kind: "docsfab-github-pr-original-input-id", observationId })}`;
        const originalRegistration = registerTrackedRepositorySourceInput(externalInputs, {
          inputId: originalInputId,
          canonicalLocator,
          safeTitle: `${side.side}: ${side.path.normalize("NFC")}`,
          contentDigestSha256: side.originalSha256,
          revision: context.repository.revision,
          producerId: GITHUB_PR_SOURCE_PRODUCER_ID,
          producerVersion: GITHUB_PR_SOURCE_PRODUCER_VERSION,
        });
        const derivativeRegistration =
          representation !== null && derivative !== null
            ? registerTrackedRepositorySourceInput(externalInputs, {
                inputId: primaryInputId,
                canonicalLocator,
                safeTitle: `${side.side}: ${side.path.normalize("NFC")}`,
                contentDigestSha256: sha256Bytes(derivative),
                revision: context.repository.revision,
                producerId: GITHUB_PR_SOURCE_PRODUCER_ID,
                producerVersion: GITHUB_PR_SOURCE_PRODUCER_VERSION,
              })
            : null;
        observation = createSourceObservation({
          observationId,
          originIdSha256,
          inputId: primaryInputId,
          registrationSha256:
            derivativeRegistration?.entrySha256 ?? originalRegistration.entrySha256,
          ...(derivativeRegistration
            ? {
                originalInputId,
                originalRegistrationSha256: originalRegistration.entrySha256,
              }
            : { primaryContentForm: SOURCE_EXACT_ORIGINAL_FORM }),
          runIdSha256,
          repository: context.repository,
          requestSha256: context.requestSha256,
          producerId: GITHUB_PR_SOURCE_PRODUCER_ID,
          producerVersion: GITHUB_PR_SOURCE_PRODUCER_VERSION,
          producerScopeSha256: scopeSha256,
          acquisitionReceiptSha256: canonicalDigest({
            kind: "docsfab-github-pr-source-acquisition-receipt",
            referenceSha256: acquired.ref.referenceSha256,
            graph: { B: acquired.graph.B, H: acquired.graph.H, M: acquired.graph.M },
            canonicalLocator,
            originalSha256: side.originalSha256,
            derivativeSha256: representation?.sha256 ?? null,
            observedAt: context.observedAt,
          }),
          observedAt: context.observedAt,
          original: {
            sha256: side.originalSha256,
            byteLength: original.length,
            mediaType: side.mediaType,
            locatorSha256: canonicalDigest({
              schemaVersion: 1,
              kind: "docsfab-source-repository-locator",
              canonicalLocator,
            }),
            version: { kind: "content-digest", contentDigestSha256: side.originalSha256 },
            repositoryPath: side.path,
          },
          representations: representation
            ? [representation, rawRepresentation]
            : [rawRepresentation],
        });
        observations.push(observation);
      }
      const descriptor: ChangeSnapshotSourceSideV1 = {
        side: side.side,
        path: side.path,
        repositoryId: String(side.repositoryId),
        blobId: side.blobId,
        originalSha256: side.originalSha256,
        originalByteLength: original.length,
        observationId: observation?.observationId ?? null,
        observationSha256: observation?.observationSha256 ?? null,
      };
      const key = sideKey(side);
      if (retained.has(key)) fail("github-pr-side-duplicate");
      const saved = { descriptor, original, derivative, observation };
      verifyRetained(saved);
      retained.set(key, saved);
      sourceSides.push(descriptor);
    }
    if (options !== undefined) {
      const { basis } = options;
      assertLiveHSourceBasis();
      const headWorkspace = basis.headWorkspace;
      hSource = await options.acquireHSourceObservations({
        externalInputs,
        headWorkspace,
        runIdSha256,
        runId: context.runId,
        requestSha256: context.requestSha256,
        repository: context.repository,
        workspaceIdentitySha256: context.workspaceIdentitySha256,
        repositoryContentDigest: context.repositoryContentDigest,
        policy: context.policy,
        observedAt: context.observedAt,
        signal: basis.signal,
        ...(context.toolOutputCapBytes === undefined
          ? {}
          : { toolOutputCapBytes: context.toolOutputCapBytes }),
      });
      assertLiveHSourceBasis();
      const readScope = normalizeSourceReadScope(hSource.readScope);
      const expectedScope = digestSourceReadScope({
        repository: context.repository,
        readScope,
      });
      if (
        hSource.producerScopes.length !== 1 ||
        hSource.producerScopes[0]?.producerId !== TRACKED_SOURCE_PRODUCER_ID ||
        hSource.producerScopes[0]?.scopeSha256 !== expectedScope
      )
        fail("github-pr-h-source-scope-substituted");
      if (observations.length + hSource.observations.length > MAX_OBSERVATIONS)
        // hygiene: envelope - GithubPrCustodyError renders the code with observed, bound and remedy.
        throw new GithubPrCustodyError(
          "github-pr-source-observation-capacity",
          observations.length + hSource.observations.length,
          MAX_OBSERVATIONS,
        );
      const knownObservationIds = new Set(observations.map((row) => row.observationId));
      const knownInputIds = new Set(
        observations.flatMap((row) => [row.inputId, row.originalInputId ?? row.inputId]),
      );
      const knownPaths = new Set<string>();
      for (const candidate of hSource.observations) {
        const observation = decodeSourceObservation(candidate);
        const path = observation.original.repositoryPath;
        if (
          path === null ||
          knownPaths.has(path) ||
          !isWithinSourceReadScope(path, readScope) ||
          knownObservationIds.has(observation.observationId) ||
          knownInputIds.has(observation.inputId) ||
          (observation.originalInputId !== undefined &&
            knownInputIds.has(observation.originalInputId)) ||
          observation.runIdSha256 !== runIdSha256 ||
          observation.requestSha256 !== context.requestSha256 ||
          observation.repository.identitySha256 !== context.repository.identitySha256 ||
          observation.repository.revision !== headWorkspace.H ||
          observation.producerId !== TRACKED_SOURCE_PRODUCER_ID ||
          observation.producerVersion !== TRACKED_SOURCE_PRODUCER_VERSION ||
          observation.producerScopeSha256 !== expectedScope ||
          observation.observedAt !== context.observedAt ||
          observation.original.version.kind !== "repository-revision" ||
          observation.original.version.revision !== headWorkspace.H
        )
          fail("github-pr-h-source-substituted");
        knownPaths.add(path);
        knownObservationIds.add(observation.observationId);
        knownInputIds.add(observation.inputId);
        if (observation.originalInputId !== undefined)
          knownInputIds.add(observation.originalInputId);
        const entryKind = await trackedRepositoryEntryKind(headWorkspace, path);
        assertLiveHSourceBasis();
        if (entryKind !== "regular") fail("github-pr-h-source-not-regular");
        const blobId = await trackedRepositoryBlobObjectId(headWorkspace, path);
        assertLiveHSourceBasis();
        if (blobId === undefined) fail("github-pr-h-source-blob-unavailable");
        const original = await readTrackedRepositoryFile(
          headWorkspace,
          path,
          sourceExtractionMaxOriginalBytes(),
        );
        assertLiveHSourceBasis();
        if (
          sha256(original) !== observation.original.sha256 ||
          original.length !== observation.original.byteLength ||
          observation.original.locatorSha256 !==
            canonicalDigest({
              schemaVersion: 1,
              kind: "docsfab-source-repository-locator",
              canonicalLocator: trackedSourceCanonicalLocator(path),
            })
        )
          fail("github-pr-h-source-original-substituted");
        const raw = observation.representations.find(
          (representation) => representation.form === SOURCE_EXACT_ORIGINAL_FORM,
        );
        if (
          raw === undefined ||
          raw.sha256 !== observation.original.sha256 ||
          raw.byteLength !== original.length ||
          !Buffer.from(
            hSource.handlers.resolveOriginal({
              observationId: observation.observationId,
              representationId: raw.representationId,
            }) ?? [],
          ).equals(original)
        )
          fail("github-pr-h-source-original-substituted");
        const derivatives = new Map<string, Buffer>();
        for (const representation of observation.representations) {
          if (representation.form === SOURCE_EXACT_ORIGINAL_FORM) continue;
          const candidateBytes = hSource.handlers.resolveDerivative({
            observationId: observation.observationId,
            representationId: representation.representationId,
          });
          if (candidateBytes === undefined) fail("github-pr-h-source-derivative-missing");
          const derivative = Buffer.from(candidateBytes);
          if (
            sha256(derivative) !== representation.sha256 ||
            derivative.length !== representation.byteLength
          )
            fail("github-pr-h-source-derivative-substituted");
          for (const span of representation.spans) {
            if (
              span.locator.kind !== "text" ||
              !original
                .subarray(span.locator.startByte, span.locator.endByte)
                .equals(derivative.subarray(span.startByte, span.endByte))
            )
              fail("github-pr-h-source-range-substituted");
          }
          derivatives.set(representation.representationId, derivative);
        }
        const primary =
          observation.representations.find(
            (representation) => representation.form === observation.primaryContentForm,
          ) ??
          observation.representations.find(
            (representation) => representation.form !== SOURCE_EXACT_ORIGINAL_FORM,
          ) ??
          raw;
        if (
          observation.representations.some(
            (representation) =>
              representation.form !== SOURCE_EXACT_ORIGINAL_FORM &&
              (representation.sha256 !== primary.sha256 ||
                representation.byteLength !== primary.byteLength),
          )
        )
          fail("github-pr-h-source-registration-substituted");
        const rawInputId = observation.originalInputId ?? observation.inputId;
        const inputDigests = [
          [observation.inputId, primary.sha256, observation.registrationSha256],
          [
            rawInputId,
            raw.sha256,
            observation.originalRegistrationSha256 ?? observation.registrationSha256,
          ],
        ] as const;
        for (const [inputId, contentSha256, registrationSha256] of inputDigests) {
          const registration = getRegisteredExternalInput(externalInputs, inputId);
          if (
            registration.contentDigestSha256 !== contentSha256 ||
            registrationDigest(registration) !== registrationSha256 ||
            registration.locator.locatorSha256 !==
              digestExternalInputLocator(trackedSourceCanonicalLocator(path)) ||
            registration.version.kind !== "repository-revision" ||
            registration.version.revision !== headWorkspace.H ||
            registration.supplier.identitySha256 !==
              canonicalDigest({
                kind: "docsfab-source-acquisition-producer",
                producerId: TRACKED_SOURCE_PRODUCER_ID,
                producerVersion: TRACKED_SOURCE_PRODUCER_VERSION,
              })
          )
            fail("github-pr-h-source-registration-substituted");
        }
        retainedH.set(observation.observationId, {
          observation,
          original,
          derivatives,
          blobId,
        });
        observations.push(observation);
      }
      if (retainedH.size > 0) producerScopes.push(...hSource.producerScopes);
    }
    assertLiveHSourceBasis();
    const binding =
      observations.length === 0
        ? null
        : createSourceBinding({
            runIdSha256,
            repository: context.repository,
            requestSha256: context.requestSha256,
            hostPolicySha256: context.policy.policySha256,
            producerScopeSha256: digestSourceProducerScopes(producerScopes),
            parentBindingSha256: null,
            observations: observations.map((observation) => ({
              observationId: observation.observationId,
              observationSha256: observation.observationSha256,
            })),
            requiredObservationIds: observations.map((observation) => observation.observationId),
          });
    const snapshot = createChangeSnapshot({
      ref: acquired.ref,
      sourceRepositoryId: String(acquired.headRepositoryId),
      graph: {
        B: acquired.graph.B,
        H: acquired.graph.H,
        M: acquired.graph.M,
        baseTree: acquired.graph.baseTree,
        headTree: acquired.graph.headTree,
        mergeTree: acquired.graph.mergeTree,
        proposalCommits: acquired.graph.proposalCommits,
      },
      manifest: acquired.manifest.map((row) => ({ ...row })),
      sourceSides,
      sourceBindingSha256: binding?.bindingSha256 ?? null,
      limitations,
      completeness: "complete",
    });
    let disposed = false;
    function active(): void {
      if (disposed) fail("github-pr-custody-disposed");
    }
    const byObservation = new Map(
      [...retained.values()]
        .filter(
          (row): row is RetainedSide & { observation: SourceObservationV1 } =>
            row.observation !== null,
        )
        .map((row) => [row.observation.observationId, row]),
    );
    function verifiedH(
      observationId: string,
      representationId: string,
    ): { row: RetainedHSource; representation: SourceRepresentationV1; inputId: string } | null {
      active();
      const row = retainedH.get(observationId);
      if (row === undefined) return null;
      const representation = row.observation.representations.find(
        (item) => item.representationId === representationId,
      );
      if (representation === undefined) fail("github-pr-h-source-representation-substituted");
      const inputId =
        representation.form === SOURCE_EXACT_ORIGINAL_FORM
          ? (row.observation.originalInputId ?? row.observation.inputId)
          : row.observation.inputId;
      const registration = getRegisteredExternalInput(externalInputs, inputId);
      if (registration.contentDigestSha256 !== representation.sha256)
        fail("github-pr-h-source-registration-substituted");
      return { row, representation, inputId };
    }
    function verifiedObservation(
      observationId: string,
      representationId: string,
    ): RetainedSide & {
      observation: SourceObservationV1;
    } {
      active();
      const row = byObservation.get(observationId);
      if (
        !row ||
        !row.observation.representations.some(
          (entry) => entry.representationId === representationId,
        ) ||
        row.descriptor.observationSha256 !== row.observation.observationSha256
      )
        fail("github-pr-source-substituted");
      verifyRetained(row);
      return row;
    }
    const verifier: SourceEvidenceHostVerifier = {
      verifyCurrent: active,
      hostPolicySha256: context.policy.policySha256,
      producerScopes,
      resolveBinding(digest) {
        active();
        if (binding?.bindingSha256 !== digest) fail("github-pr-binding-unavailable");
        return binding;
      },
      resolveObservation(observationId) {
        active();
        const hRow = retainedH.get(observationId);
        if (hRow !== undefined) return hRow.observation;
        const row = byObservation.get(observationId);
        if (!row) fail("github-pr-observation-unavailable");
        verifyRetained(row);
        return row.observation;
      },
      resolveDerivative({ observationId, representationId }) {
        const h = verifiedH(observationId, representationId);
        if (h !== null) {
          if (h.representation.form === SOURCE_EXACT_ORIGINAL_FORM) return undefined;
          const expected = h.row.derivatives.get(representationId);
          const current = hSource!.handlers.resolveDerivative({ observationId, representationId });
          if (
            expected === undefined ||
            current === undefined ||
            !Buffer.from(current).equals(expected)
          )
            fail("github-pr-h-source-derivative-substituted");
          return Buffer.from(expected);
        }
        const row = verifiedObservation(observationId, representationId);
        const representation = row.observation.representations.find(
          (entry) => entry.representationId === representationId,
        )!;
        if (representation.form === SOURCE_EXACT_ORIGINAL_FORM) return undefined;
        return row.derivative === null ? undefined : Buffer.from(row.derivative);
      },
      resolveOriginal({ observationId, representationId }) {
        const h = verifiedH(observationId, representationId);
        if (h !== null) {
          if (h.representation.form !== SOURCE_EXACT_ORIGINAL_FORM)
            fail("github-pr-h-source-original-representation-missing");
          const current = hSource!.handlers.resolveOriginal({ observationId, representationId });
          if (current === undefined || !Buffer.from(current).equals(h.row.original))
            fail("github-pr-h-source-original-substituted");
          return Buffer.from(h.row.original);
        }
        const row = verifiedObservation(observationId, representationId);
        const representation = row.observation.representations.find(
          (entry) => entry.representationId === representationId,
        )!;
        if (representation.form !== SOURCE_EXACT_ORIGINAL_FORM)
          fail("github-pr-original-representation-missing");
        return Buffer.from(row.original);
      },
      describeOriginal({ observationId, representationId }) {
        const h = verifiedH(observationId, representationId);
        if (h !== null) {
          if (h.representation.form !== SOURCE_EXACT_ORIGINAL_FORM)
            fail("github-pr-h-source-original-representation-missing");
          return {
            side: "after" as const,
            repositoryId: String(acquired.headRepositoryId),
            blobId: h.row.blobId,
            originalSha256: h.row.observation.original.sha256,
          };
        }
        const row = verifiedObservation(observationId, representationId);
        const representation = row.observation.representations.find(
          (entry) => entry.representationId === representationId,
        )!;
        if (representation.form !== SOURCE_EXACT_ORIGINAL_FORM)
          fail("github-pr-original-representation-missing");
        return {
          side: row.descriptor.side,
          repositoryId: row.descriptor.repositoryId,
          blobId: row.descriptor.blobId,
          originalSha256: row.descriptor.originalSha256,
        };
      },
      recordAccess({ observationId, representationId, stepId, spanIds }) {
        const h = verifiedH(observationId, representationId);
        if (h !== null) {
          const known = new Set(h.representation.spans.map((span) => span.spanId));
          if (spanIds.length === 0 || spanIds.some((id) => !known.has(id)))
            fail("github-pr-h-source-span-substituted");
          const digest = hSource!.handlers.recordAccess({
            observationId,
            representationId,
            stepId,
            spanIds,
          });
          if (
            !listExternalInputAccessObservations(externalInputs, h.inputId).some(
              (entry) =>
                entry.observationSha256 === digest &&
                entry.stepId === stepId &&
                entry.outcome === "opened" &&
                entry.observedContentDigestSha256 === h.representation.sha256,
            )
          )
            fail("github-pr-h-source-access-detached");
          return digest;
        }
        const row = verifiedObservation(observationId, representationId);
        const representation = row.observation.representations.find(
          (entry) => entry.representationId === representationId,
        )!;
        const known = new Set(representation.spans.map((span) => span.spanId));
        if (spanIds.length === 0 || spanIds.some((id) => !known.has(id)))
          fail("github-pr-span-substituted");
        const inputId =
          representation.form === SOURCE_EXACT_ORIGINAL_FORM
            ? (row.observation.originalInputId ?? row.observation.inputId)
            : row.observation.inputId;
        const registration = getRegisteredExternalInput(externalInputs, inputId);
        if (registration.contentDigestSha256 !== representation.sha256)
          fail("github-pr-source-substituted");
        return recordExternalInputAccess(externalInputs, {
          inputId,
          stepId,
          outcome: "opened",
          observedContentDigestSha256: representation.sha256,
          accessorId: "docsfab-source-evidence",
          evidenceSha256s: [row.observation.observationSha256],
        }).observationSha256;
      },
      recordCitation({
        observationId,
        representationId,
        stepId,
        spanIds,
        accessObservationSha256s,
        supportedClaimSha256,
      }) {
        const h = verifiedH(observationId, representationId);
        if (h !== null) {
          const known = new Set(h.representation.spans.map((span) => span.spanId));
          if (spanIds.length === 0 || spanIds.some((id) => !known.has(id)))
            fail("github-pr-h-source-span-substituted");
          const accesses = listExternalInputAccessObservations(externalInputs, h.inputId);
          if (
            accessObservationSha256s.length === 0 ||
            accessObservationSha256s.some(
              (digest) =>
                !accesses.some(
                  (entry) =>
                    entry.observationSha256 === digest &&
                    entry.outcome === "opened" &&
                    entry.stepId === stepId,
                ),
            )
          )
            fail("github-pr-h-source-citation-access-missing");
          const digest = hSource!.handlers.recordCitation({
            observationId,
            representationId,
            stepId,
            spanIds,
            accessObservationSha256s,
            supportedClaimSha256,
          });
          if (
            !createExternalInputCitationLedger(externalInputs).citations.some(
              (entry) =>
                entry.citationSha256 === digest &&
                entry.inputId === h.inputId &&
                entry.stepId === stepId &&
                entry.role === "evidence" &&
                entry.accessObservationSha256 !== null &&
                accessObservationSha256s.includes(entry.accessObservationSha256) &&
                entry.supportedClaimSha256 === supportedClaimSha256,
            )
          )
            fail("github-pr-h-source-citation-detached");
          return digest;
        }
        const row = verifiedObservation(observationId, representationId);
        const representation = row.observation.representations.find(
          (entry) => entry.representationId === representationId,
        )!;
        const inputId =
          representation.form === SOURCE_EXACT_ORIGINAL_FORM
            ? (row.observation.originalInputId ?? row.observation.inputId)
            : row.observation.inputId;
        const accesses = listExternalInputAccessObservations(externalInputs, inputId);
        if (
          accessObservationSha256s.length === 0 ||
          accessObservationSha256s.some(
            (digest) =>
              !accesses.some(
                (access) => access.observationSha256 === digest && access.outcome === "opened",
              ),
          )
        )
          fail("github-pr-citation-access-missing");
        const registration = getRegisteredExternalInput(externalInputs, inputId);
        if (registration.contentDigestSha256 !== representation.sha256)
          fail("github-pr-source-substituted");
        const citation = citeExternalInput(externalInputs, {
          inputId,
          stepId,
          role: "evidence",
          supportedClaimSha256,
          accessObservationSha256: accessObservationSha256s[0]!,
          unsupported: false,
        });
        if (citation.kind !== "docsfab-external-input-citation") fail("github-pr-citation-refused");
        return citation.citationSha256;
      },
      now: () => new Date(),
    };
    const service =
      binding === null
        ? null
        : createSourceEvidenceService(createSourceEvidenceHostAuthority(verifier));
    const sourceEvidence: SourceEvidenceRunnerBinding | null =
      service === null
        ? null
        : {
            service,
            workspaceIdentitySha256: context.workspaceIdentitySha256,
            repositoryContentDigest: context.repositoryContentDigest,
            policy: context.policy,
          };
    const sourceReference =
      binding === null
        ? null
        : createSourceArtifactReference({
            kind: "source-binding",
            digest: binding.bindingSha256,
            repositoryRevision: context.repository.revision,
            repositoryContentDigest: context.repositoryContentDigest,
          });
    return Object.freeze({
      snapshot,
      binding,
      observations: Object.freeze([...observations]),
      sourceEvidence,
      sourceReference,
      externalInputs,
      retainedOriginalBytes: [...retained.values()].reduce(
        (total, side) => total + side.original.length,
        [...retainedH.values()].reduce((total, source) => total + source.original.length, 0),
      ),
      retainedDerivativeBytes: [...retained.values()].reduce(
        (total, side) => total + (side.derivative?.length ?? 0),
        [...retainedH.values()].reduce(
          (total, source) =>
            total +
            [...source.derivatives.values()].reduce(
              (subTotal, derivative) => subTotal + derivative.length,
              0,
            ),
          0,
        ),
      ),
      readOriginal(identity: {
        side: "before" | "after";
        path: string;
        repositoryId: number;
        blobId: string;
      }) {
        active();
        const row = retained.get(sideKey(identity));
        if (!row) fail("github-pr-original-unavailable");
        verifyRetained(row);
        return Buffer.from(row.original);
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        for (const row of retained.values()) {
          row.original.fill(0);
          row.derivative?.fill(0);
        }
        retained.clear();
        for (const row of retainedH.values()) {
          row.original.fill(0);
          for (const derivative of row.derivatives.values()) derivative.fill(0);
        }
        retainedH.clear();
        hSource?.handlers.dispose();
      },
    });
  } catch (error) {
    let failure = error;
    try {
      hSource?.handlers.dispose();
    } catch (cleanupError) {
      failure = new AggregateError([error, cleanupError], "GitHub source custody cleanup failed.");
    }
    for (const row of retainedH.values()) {
      row.original.fill(0);
      for (const derivative of row.derivatives.values()) derivative.fill(0);
    }
    for (const row of prepared) {
      row.original.fill(0);
      row.derivative?.fill(0);
    }
    throw failure;
  }
}

/** The production seam: public metadata to bounded Git to sealed source service. */
export async function acquireGithubPrSource(
  url: string,
  options: AcquireGithubPrOptions,
  context: GithubPrCustodyContext,
): Promise<{
  ref: GithubPrObjectAcquisition["ref"];
  graph: GithubPrObjectAcquisition["graph"];
  manifest: GithubPrObjectAcquisition["manifest"];
  metrics: GithubPrObjectAcquisition["metrics"];
  metadataRequests: number;
  custody: GithubPrCustody;
}> {
  const acquired = await acquireGithubPrObjects(url, options);
  try {
    const custody = await createGithubPrCustody(acquired, context);
    return {
      ref: acquired.ref,
      graph: acquired.graph,
      manifest: acquired.manifest,
      metrics: acquired.metrics,
      metadataRequests: acquired.metadataRequests,
      custody,
    };
  } finally {
    for (const side of acquired.sides) side.bytes.fill(0);
  }
}
