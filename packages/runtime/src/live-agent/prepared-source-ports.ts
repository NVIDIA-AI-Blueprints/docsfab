// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Bind task-selected prepared snapshots to the live-agent tracked-source port. */
import { createContractKit, deepFreeze } from "../contract-kit/index.js";
import { decodePreparedLocalSourceRefV1, type PreparedLocalSourceRefV1 } from "./task-contract.js";
import type { LiveAgentSourcePortsV1 } from "./source-commands.js";
import {
  createPreparedLocalSourceReader,
  refusePreparedLocalSourceRead,
} from "../inputs/prepared-source-reader.js";
import type { TrackedSourceReaderV1 } from "../inputs/source-acquisition.js";
import {
  createPreparedLocalSourceManifest as createManifest,
  PREPARED_LOCAL_SOURCES_KIND,
  preparedLocalSourceContentSha256,
  type PreparedLocalSourceFileMetadataV1,
  type PreparedLocalSourceManifestV1,
  type PreparedLocalSourceSnapshotV1,
} from "../inputs/prepared-source.js";

export type { PreparedLocalSourceRefV1 } from "./task-contract.js";
export {
  preparedLocalSourceContentSha256,
  type PreparedLocalSourceFileMetadataV1,
  type PreparedLocalSourceManifestEntryV1,
  type PreparedLocalSourceManifestV1,
  type PreparedLocalSourceSnapshotV1,
} from "../inputs/prepared-source.js";
export { prepareLocalSourceSnapshot } from "../inputs/prepared-source-reader.js";

export type PreparedLocalSourceManifestErrorCode =
  | "invalid-manifest-shape"
  | "invalid-manifest-value"
  | "manifest-digest-mismatch"
  | "manifest-source-mismatch";

export class PreparedLocalSourceManifestError extends Error {
  public constructor(public readonly code: PreparedLocalSourceManifestErrorCode) {
    super(`Prepared local source manifest rejected (${code}).`);
    this.name = "PreparedLocalSourceManifestError";
  }
}

function fail(code: PreparedLocalSourceManifestErrorCode): never {
  throw new PreparedLocalSourceManifestError(code);
}

function failAmbiguousSourcePath(): never {
  return refusePreparedLocalSourceRead("invalid-scope");
}

const kit = createContractKit<PreparedLocalSourceManifestErrorCode>({
  fail,
  inertMode: "strict",
  codes: {
    invalidShape: "invalid-manifest-shape",
    invalidValue: "invalid-manifest-value",
    digestMismatch: "manifest-digest-mismatch",
    credentialMaterial: "invalid-manifest-value",
    schemaMismatch: "invalid-manifest-value",
  },
});

function decodeFileMetadata(value: unknown): PreparedLocalSourceFileMetadataV1 {
  const file = kit.object(value);
  kit.exact(file, ["path", "byteLength", "sha256"]);
  const path = kit.string(file.path);
  const byteLength = file.byteLength;
  if (
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((segment) => segment === "" || segment === "." || segment === "..") ||
    typeof byteLength !== "number" ||
    !Number.isSafeInteger(byteLength) ||
    byteLength < 0
  ) {
    fail("invalid-manifest-value");
  }
  return deepFreeze({ path, byteLength, sha256: kit.hash(file.sha256) });
}

/** Parse one immutable host-mounted manifest with the #2518 task-ref decoder. */
export function decodePreparedLocalSourceManifestV1(value: unknown): PreparedLocalSourceManifestV1 {
  kit.assertInert(value);
  kit.rejectCredentials(value);
  const manifest = kit.object(value);
  kit.exact(manifest, ["schemaVersion", "kind", "sources"]);
  if (manifest.schemaVersion !== 1 || manifest.kind !== PREPARED_LOCAL_SOURCES_KIND) {
    fail("invalid-manifest-value");
  }
  const sources = kit.array(manifest.sources).map((rawEntry) => {
    const entry = kit.object(rawEntry);
    kit.exact(entry, ["ref", "files"]);
    const ref = decodePreparedLocalSourceRefV1(entry.ref);
    const files = kit.array(entry.files).map(decodeFileMetadata);
    if (
      files.length === 0 ||
      files.length !== ref.paths.length ||
      files.some((file, index) => file.path !== ref.paths[index])
    ) {
      fail("manifest-source-mismatch");
    }
    if (
      preparedLocalSourceContentSha256({
        sourceId: ref.sourceId,
        repositoryRevision: ref.repositoryRevision,
        files,
      }) !== ref.contentSha256
    ) {
      fail("manifest-digest-mismatch");
    }
    return deepFreeze({ ref, files: Object.freeze(files) });
  });
  const ids = sources.map((entry) => entry.ref.sourceId);
  if (
    new Set(ids).size !== ids.length ||
    ids.some((id, index) => index > 0 && ids[index - 1]! >= id)
  ) {
    fail("invalid-manifest-value");
  }
  return deepFreeze({
    schemaVersion: 1 as const,
    kind: PREPARED_LOCAL_SOURCES_KIND,
    sources: Object.freeze(sources),
  });
}

/** Build canonical metadata from snapshots produced by `prepareLocalSourceSnapshot`. */
export function createPreparedLocalSourceManifest(
  snapshots: readonly PreparedLocalSourceSnapshotV1[],
): PreparedLocalSourceManifestV1 {
  return decodePreparedLocalSourceManifestV1(createManifest(snapshots));
}

/**
 * Adapt a host-declared snapshot mount into the existing live-agent source
 * port. Only task refs choose entries; the mount path comes from the caller.
 */
export async function createPreparedLocalSourcePorts(input: {
  readonly basePorts?: LiveAgentSourcePortsV1;
  readonly manifest: unknown;
  readonly refs: readonly unknown[];
  readonly sourcesRoot: string;
}): Promise<LiveAgentSourcePortsV1> {
  const manifest = decodePreparedLocalSourceManifestV1(input.manifest);
  const refs = input.refs.map(decodePreparedLocalSourceRefV1);
  const reader = await createPreparedLocalSourceReader({
    manifest,
    refs,
    sourcesRoot: input.sourcesRoot,
  });
  const baseReader = input.basePorts?.withTrackedSourceReader;
  return {
    ...input.basePorts,
    withTrackedSourceReader: async (use) => {
      if (baseReader === undefined) return use(reader);
      return baseReader(async (base) => {
        await assertNoAmbiguousPaths(base, reader);
        return use(combineReaders(base, reader));
      });
    },
  };
}

async function assertNoAmbiguousPaths(
  base: TrackedSourceReaderV1,
  prepared: TrackedSourceReaderV1,
): Promise<void> {
  const preparedPaths = (await prepared.listTrackedRegularFiles?.()) ?? [];
  for (const path of preparedPaths) {
    if (await base.isTrackedRegularFile(path)) {
      failAmbiguousSourcePath();
    }
  }
}

function combineReaders(
  base: TrackedSourceReaderV1,
  prepared: TrackedSourceReaderV1,
): TrackedSourceReaderV1 {
  return {
    async isTrackedRegularFile(repositoryPath) {
      const [inBase, inPrepared] = await Promise.all([
        base.isTrackedRegularFile(repositoryPath),
        prepared.isTrackedRegularFile(repositoryPath),
      ]);
      if (inBase && inPrepared) failAmbiguousSourcePath();
      return inBase || inPrepared;
    },
    async listTrackedRegularFiles() {
      const [basePaths, preparedPaths] = await Promise.all([
        base.listTrackedRegularFiles?.() ?? Promise.resolve([]),
        prepared.listTrackedRegularFiles?.() ?? Promise.resolve([]),
      ]);
      const baseSet = new Set(basePaths);
      if (preparedPaths.some((path) => baseSet.has(path))) {
        failAmbiguousSourcePath();
      }
      return Object.freeze([...new Set([...basePaths, ...preparedPaths])].sort());
    },
    async readTrackedBytes(repositoryPath, maxBytes) {
      const [inBase, inPrepared] = await Promise.all([
        base.isTrackedRegularFile(repositoryPath),
        prepared.isTrackedRegularFile(repositoryPath),
      ]);
      if (inBase && inPrepared) failAmbiguousSourcePath();
      if (inBase) return base.readTrackedBytes(repositoryPath, maxBytes);
      if (inPrepared) return prepared.readTrackedBytes(repositoryPath, maxBytes);
      return prepared.readTrackedBytes(repositoryPath, maxBytes);
    },
  };
}
