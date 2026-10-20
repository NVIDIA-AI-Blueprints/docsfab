// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import {
  RepositoryWorkspaceReadError,
  type RepositoryWorkspace,
} from "../repository/workspace/contracts.js";
import { readTrackedRepositoryFile } from "../repository/workspace/tracked-read.js";
import {
  listTrackedRepositoryEntries,
  listTrackedRepositoryFileSnapshotMetadata,
} from "../repository/workspace/tracked-read.js";
import {
  admitOriginalSourceAuthorityProposals,
  sealOriginalSourceAuthority,
  type OriginalSourceAuthorityCapture,
  type OriginalSourceAuthorityEvidenceV1,
  type SourceAuthorityProposalAdmissionV1,
  type SourceAuthorityProposalV1,
  type SourceAuthorityTrackedEntryV1,
} from "./source-obligation-authority.js";
import {
  failSourceReference,
  reviewDocumentationTargetPaths,
  type AdmittedSourceLineCountV1,
  type PreservationBaseEvidence,
  type PreservationSourceReadV1,
  type PreservationSourceReaderV1,
  type PreservationSourceReferenceV1,
  type SourceObligationSourceIdentityV1,
  type SourceObligationSourceObserver,
} from "./source-obligation.js";
import { containsConfiguredCredential } from "../security/configured-credentials.js";

export const MAX_SOURCE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;

/**
 * Whether {@link LocalSourceObligationSourceObserver.observe} reads `path`: a
 * member of the sealed authority (a tracked regular file) of at most
 * `MAX_SOURCE_BYTES`. It refuses any other path as `not-tracked`,
 * `unsafe-kind` or `oversize`.
 */
export function observableSourcePath(
  authority: Pick<OriginalSourceAuthorityEvidenceV1, "members">,
): (path: string) => boolean {
  const byteLengths = new Map(authority.members.map(({ path, byteLength }) => [path, byteLength]));
  return (path) => {
    const byteLength = byteLengths.get(path);
    return byteLength !== undefined && byteLength <= MAX_SOURCE_BYTES;
  };
}

/**
 * The number of lines a locator can cite in these bytes. Each line feed ends a
 * line; a final line without one still counts; empty content has none. Counted
 * on bytes, so no decoding choice changes it.
 */
export function countSourceLines(bytes: Uint8Array): number {
  let lines = 0;
  for (const byte of bytes) if (byte === 0x0a) lines += 1;
  return bytes.length > 0 && bytes[bytes.length - 1] !== 0x0a ? lines + 1 : lines;
}

/** Host-side exact-byte observer over the existing materialized workspace capability. */
export class LocalSourceObligationSourceObserver implements SourceObligationSourceObserver {
  private readonly authoritySnapshots = new WeakMap<
    OriginalSourceAuthorityCapture,
    {
      readonly trackedEntries: readonly SourceAuthorityTrackedEntryV1[];
      readonly runId: string;
      readonly repositoryRevision: string;
      readonly authorityDigest: string;
    }
  >();

  public constructor(private readonly workspace: RepositoryWorkspace) {}

  /**
   * Mint a fresh step reader over only host-selected, sealed source members.
   * The reader carries no path input; each range call re-reads the immutable
   * export and verifies its revision, byte length, and digest.
   */
  public createPreservationSourceReader(input: {
    runId: string;
    stepId: string;
    repositoryRevision: string;
    capture: OriginalSourceAuthorityCapture;
    authority: OriginalSourceAuthorityEvidenceV1;
    authorizedPaths: readonly string[];
  }): PreservationSourceReaderV1 {
    const capture = this.authoritySnapshots.get(input.capture);
    if (
      !capture ||
      input.stepId.length === 0 ||
      capture.runId !== input.runId ||
      capture.repositoryRevision !== input.repositoryRevision ||
      capture.authorityDigest !== input.authority.digest ||
      input.authority.descriptor.repositoryRevision !== input.repositoryRevision ||
      this.workspace.revision !== input.repositoryRevision
    ) {
      throw new Error("Preservation source reader authority is stale or invalid.");
    }
    const authorityMembers = new Map(
      input.authority.members.map((member) => [member.path, member]),
    );
    const references = [...new Set(input.authorizedPaths)].sort().map((path) => {
      const member = authorityMembers.get(path);
      if (!member) throw new Error("Preservation source is outside the sealed source authority.");
      if (member.byteLength > MAX_SOURCE_BYTES) {
        // hygiene: ok -- the typed code is expanded with observed bytes, scope, and remediation.
        throw new RepositoryWorkspaceReadError("oversize", {
          path,
          observedBytes: member.byteLength,
          limitBytes: MAX_SOURCE_BYTES,
          remediation: "Select a smaller original source before restructuring.",
        });
      }
      const sourceId = createHash("sha256")
        .update(`${input.runId}\0${input.repositoryRevision}\0${path}\0${member.sourceSha256}`)
        .digest("hex");
      return Object.freeze({
        sourceId,
        path,
        sha256: member.sourceSha256,
        byteLength: member.byteLength,
      });
    });
    if (references.length === 0) {
      throw new Error("Preservation source reader requires an admitted source path.");
    }
    const state: PreservationSourceReaderState = {
      workspace: this.workspace,
      runId: input.runId,
      stepId: input.stepId,
      repositoryRevision: input.repositoryRevision,
      workspaceSnapshotSha256: input.authority.descriptor.workspaceSnapshotSha256,
      authorityDigest: input.authority.digest,
      references,
      revoked: false,
    };
    const reader = Object.freeze({ kind: "docsfab-preservation-source-reader" as const });
    preservationSourceReaders.set(reader, state);
    return reader;
  }

  public async capturePreservationBase(
    paths: readonly string[],
  ): Promise<PreservationBaseEvidence> {
    const sources: PreservationBaseEvidence["sources"][number][] = [];
    let totalBytes = 0;
    for (const path of [...new Set(paths)].sort()) {
      const bytes = await readTrackedRepositoryFile(this.workspace, path, MAX_SOURCE_BYTES);
      totalBytes += bytes.byteLength;
      if (totalBytes > MAX_TOTAL_BYTES) {
        throw new Error("Preservation base exceeds the admitted total source byte limit.");
      }
      const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      // Only a configured credential stops here (#1807); credential-like
      // repository content is presented and reported as a finding.
      if (containsConfiguredCredential(content)) {
        throw new Error(
          "Preservation base contains a configured credential and cannot be presented.",
        );
      }
      sources.push(
        Object.freeze({
          path,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          content,
        }),
      );
    }
    return Object.freeze({
      repositoryRevision: this.workspace.revision,
      sources: Object.freeze(sources),
    });
  }

  /** Line count of each sealed source; refused when its bytes no longer match the sealed digest. */
  public async lineCounts(
    sources: readonly SourceObligationSourceIdentityV1[],
  ): Promise<AdmittedSourceLineCountV1[]> {
    const counts: AdmittedSourceLineCountV1[] = [];
    let totalBytes = 0;
    for (const source of sources) {
      const bytes = await readTrackedRepositoryFile(this.workspace, source.path, MAX_SOURCE_BYTES);
      totalBytes += bytes.byteLength;
      if (totalBytes > MAX_TOTAL_BYTES) {
        throw new Error("Source-obligation evidence exceeds the admitted total source byte limit.");
      }
      if (createHash("sha256").update(bytes).digest("hex") !== source.sha256) {
        throw new Error(
          "Source-obligation source content changed after the derivation evidence was sealed.",
        );
      }
      counts.push({ path: source.path, sha256: source.sha256, lineCount: countSourceLines(bytes) });
    }
    return counts;
  }

  public async observe(paths: readonly string[]): Promise<SourceObligationSourceIdentityV1[]> {
    const identities: SourceObligationSourceIdentityV1[] = [];
    let totalBytes = 0;
    for (const path of [...new Set(paths)].sort()) {
      const bytes = await readTrackedRepositoryFile(this.workspace, path, MAX_SOURCE_BYTES);
      totalBytes += bytes.byteLength;
      if (totalBytes > MAX_TOTAL_BYTES) {
        throw new Error("Source-obligation evidence exceeds the admitted total source byte limit.");
      }
      identities.push({
        path,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
    if (identities.length === 0) {
      throw new Error("Source-obligation evidence contains no readable source path to observe.");
    }
    return identities;
  }

  public async assertUnchanged(
    sources: readonly SourceObligationSourceIdentityV1[],
    allowedChangedPaths: readonly string[] = [],
  ): Promise<void> {
    const allowed = new Set(allowedChangedPaths);
    const protectedSources = sources.filter(({ path }) => !allowed.has(path));
    if (protectedSources.length === 0) return;
    const current = new Map(
      (await this.observe(protectedSources.map(({ path }) => path))).map((item) => [
        item.path,
        item.sha256,
      ]),
    );
    for (const source of protectedSources) {
      if (current.get(source.path) !== source.sha256) {
        throw new Error(
          "Source-obligation source content changed after the derivation evidence was sealed.",
        );
      }
    }
  }

  /** The revision's tracked regular files as captured at export: no file is read or stat'ed. */
  public async trackedRegularPaths(): Promise<ReadonlySet<string>> {
    const entries = await listTrackedRepositoryEntries(this.workspace);
    return new Set(
      entries.flatMap((entry) =>
        entry.kind === "regular" && entry.path !== undefined ? [entry.path] : [],
      ),
    );
  }

  public async reviewDocumentationTargetPaths(): Promise<readonly string[]> {
    return reviewDocumentationTargetPaths(
      (await this.admittableRegularEntries()).map((entry) => entry.path),
    );
  }

  /** Tracked regular files with the mode, size, and digest an authority member records. */
  private async admittableRegularEntries() {
    const metadata = await listTrackedRepositoryFileSnapshotMetadata(this.workspace);
    return metadata.filter(
      (
        entry,
      ): entry is typeof entry & {
        kind: "regular";
        mode: number;
        byteLength: number;
        sha256: string;
      } =>
        entry.kind === "regular" &&
        entry.mode !== null &&
        entry.byteLength !== null &&
        entry.sha256 !== null,
    );
  }

  public async captureOriginalSourceAuthority(input: {
    runId: string;
    workflow: import("../workflow-contracts/contracts.js").WorkflowDefinition;
    repositoryRevision: string;
    scopeSha256: string;
    workspaceSnapshotSha256: string;
    authorizedPaths?: readonly string[];
  }): Promise<{
    capture: OriginalSourceAuthorityCapture;
    evidence: OriginalSourceAuthorityEvidenceV1;
  }> {
    const metadata = await listTrackedRepositoryFileSnapshotMetadata(this.workspace);
    const regular = metadata.filter(
      (
        entry,
      ): entry is typeof entry & {
        kind: "regular";
        mode: number;
        byteLength: number;
        sha256: string;
      } =>
        entry.kind === "regular" &&
        entry.mode !== null &&
        entry.byteLength !== null &&
        entry.sha256 !== null,
    );
    const requested =
      input.workflow.name === "create-documentation"
        ? [...new Set(input.authorizedPaths ?? [])].sort()
        : regular.map((entry) => entry.path).sort();
    const byPath = new Map(regular.map((entry) => [entry.path, entry]));
    if (requested.length === 0) {
      throw new Error("Original source authority could not admit every required tracked file.");
    }
    // A plan source must be a regular tracked file the observer admits: bound
    // evidence such as a change diff has no bytes in the revision to seal, and
    // a link or submodule is not original source.
    if (requested.some((path) => !byPath.has(path))) failSourceReference("source-untracked");
    const sealed = sealOriginalSourceAuthority({
      runId: input.runId,
      scope:
        input.workflow.name === "create-documentation"
          ? "create-plan-sources"
          : "review-tracked-workspace",
      repositoryRevision: input.repositoryRevision,
      scopeSha256: input.scopeSha256,
      workspaceSnapshotSha256: input.workspaceSnapshotSha256,
      members: requested.map((path) => {
        const entry = byPath.get(path)!;
        return {
          path,
          mode: entry.mode,
          byteLength: entry.byteLength,
          sourceSha256: entry.sha256,
        };
      }),
    });
    this.authoritySnapshots.set(sealed.capture, {
      trackedEntries: metadata.map((entry) => ({
        path: entry.path,
        kind: entry.kind,
        mode: entry.mode,
        byteLength: entry.byteLength,
        sha256: entry.sha256,
      })),
      runId: input.runId,
      repositoryRevision: input.repositoryRevision,
      authorityDigest: sealed.evidence.digest,
    });
    return sealed;
  }

  public async admitOriginalSourceAuthorityProposals(input: {
    runId: string;
    repositoryRevision: string;
    capture: OriginalSourceAuthorityCapture;
    authority: OriginalSourceAuthorityEvidenceV1;
    originalPaths: readonly string[];
    writePaths: readonly string[];
    proposals: readonly SourceAuthorityProposalV1[];
    attempt: number;
  }): Promise<{
    capture?: OriginalSourceAuthorityCapture;
    evidence: OriginalSourceAuthorityEvidenceV1;
    admissions: readonly SourceAuthorityProposalAdmissionV1[];
  }> {
    const snapshot = this.authoritySnapshots.get(input.capture);
    if (
      !snapshot ||
      this.workspace.revision !== input.repositoryRevision ||
      input.authority.descriptor.repositoryRevision !== input.repositoryRevision
    ) {
      throw new Error("Source proposal cannot extend authority from another run revision.");
    }
    await this.assertUnchanged(
      input.authority.members.map(({ path, sourceSha256 }) => ({ path, sha256: sourceSha256 })),
    );
    const result = admitOriginalSourceAuthorityProposals({
      runId: input.runId,
      authority: input.authority,
      originalPaths: input.originalPaths,
      writePaths: input.writePaths,
      trackedEntries: snapshot.trackedEntries,
      proposals: input.proposals,
      attempt: input.attempt,
    });
    const newlyAdmitted = result.evidence.members.filter(
      (member) => !input.authority.members.some(({ path }) => path === member.path),
    );
    if (newlyAdmitted.length > 0) {
      const current = await this.observe(newlyAdmitted.map(({ path }) => path));
      const byPath = new Map(current.map((entry) => [entry.path, entry.sha256]));
      if (newlyAdmitted.some((member) => byPath.get(member.path) !== member.sourceSha256)) {
        throw new Error("Source proposal changed after the run's tracked snapshot was captured.");
      }
      if (!result.capture) {
        throw new Error("Source proposal reseal did not issue its host capture authority.");
      }
      this.authoritySnapshots.set(result.capture, {
        ...snapshot,
        authorityDigest: result.evidence.digest,
      });
    }
    return result;
  }
}

interface PreservationSourceReaderState {
  readonly workspace: RepositoryWorkspace;
  readonly runId: string;
  readonly stepId: string;
  readonly repositoryRevision: string;
  readonly workspaceSnapshotSha256: string;
  readonly authorityDigest: string;
  readonly references: readonly PreservationSourceReferenceV1[];
  revoked: boolean;
}

const preservationSourceReaders = new WeakMap<
  PreservationSourceReaderV1,
  PreservationSourceReaderState
>();

export function listPreservationSources(
  reader: PreservationSourceReaderV1,
): readonly PreservationSourceReferenceV1[] {
  const state = preservationSourceReaders.get(reader);
  if (!state || state.revoked || state.workspace.revision !== state.repositoryRevision) {
    throw new Error("Preservation source reader authority is stale or invalid.");
  }
  return state.references;
}

/** Safe authority identity for exact observation caches; contains no source text or paths. */
export function preservationSourceReaderIdentity(reader: PreservationSourceReaderV1): {
  readonly runId: string;
  readonly stepId: string;
  readonly repositoryRevision: string;
  readonly workspaceSnapshotSha256: string;
  readonly authorityDigest: string;
} {
  const state = preservationSourceReaders.get(reader);
  if (!state || state.revoked || state.workspace.revision !== state.repositoryRevision) {
    throw new Error("Preservation source reader authority is stale or invalid.");
  }
  return Object.freeze({
    runId: state.runId,
    stepId: state.stepId,
    repositoryRevision: state.repositoryRevision,
    workspaceSnapshotSha256: state.workspaceSnapshotSha256,
    authorityDigest: state.authorityDigest,
  });
}

/** Revoke the opaque capability as soon as its workflow step completes. */
export function revokePreservationSourceReader(reader: PreservationSourceReaderV1): void {
  const state = preservationSourceReaders.get(reader);
  if (state) state.revoked = true;
}

export async function readPreservationSourceRange(input: {
  readonly reader: PreservationSourceReaderV1;
  readonly sourceId: string;
  readonly fromByte: number;
  readonly maxBytes: number;
}): Promise<PreservationSourceReadV1> {
  const state = preservationSourceReaders.get(input.reader);
  if (!state || state.revoked || state.workspace.revision !== state.repositoryRevision) {
    throw new Error("Preservation source reader authority is stale or invalid.");
  }
  if (
    !Number.isSafeInteger(input.fromByte) ||
    input.fromByte < 0 ||
    !Number.isSafeInteger(input.maxBytes) ||
    input.maxBytes <= 0
  ) {
    throw new Error("Preservation source range request or authority is invalid.");
  }
  const reference = state.references.find(({ sourceId }) => sourceId === input.sourceId);
  if (!reference) throw new Error("Preservation source reference is unavailable to this step.");
  const bytes = await readTrackedRepositoryFile(state.workspace, reference.path, MAX_SOURCE_BYTES);
  if (state.revoked || state.workspace.revision !== state.repositoryRevision) {
    throw new Error("Preservation source reader authority is stale or invalid.");
  }
  if (
    bytes.byteLength !== reference.byteLength ||
    createHash("sha256").update(bytes).digest("hex") !== reference.sha256
  ) {
    throw new Error("Preservation source changed after the source authority was sealed.");
  }
  const completeText = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  if (containsConfiguredCredential(completeText)) {
    throw new Error("Preservation source contains a configured credential and was withheld.");
  }
  if (input.fromByte > bytes.byteLength || isUtf8Continuation(bytes[input.fromByte])) {
    throw new Error("Preservation source range does not start at an admitted UTF-8 boundary.");
  }
  const requestedEnd = Math.min(bytes.byteLength, input.fromByte + input.maxBytes);
  let endByte = requestedEnd;
  while (endByte > input.fromByte && isUtf8Continuation(bytes[endByte])) endByte -= 1;
  if (endByte === input.fromByte && input.fromByte < bytes.byteLength) {
    throw new Error("Preservation source read is too small for the next UTF-8 code point.");
  }
  const readBytes = endByte - input.fromByte;
  const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
    bytes.subarray(input.fromByte, endByte),
  );
  return Object.freeze({
    sourceId: reference.sourceId,
    path: reference.path,
    sha256: reference.sha256,
    fromByte: input.fromByte,
    endByte,
    nextFromByte: endByte < bytes.byteLength ? endByte : null,
    text: content,
  });
}

function isUtf8Continuation(value: number | undefined): boolean {
  return value !== undefined && (value & 0xc0) === 0x80;
}
