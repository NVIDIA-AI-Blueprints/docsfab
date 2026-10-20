// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Section fetch over the talk tree / Content IR. Returns one heading span,
 * as one byte-bounded section. Confined to the selected workspace.
 */

import { constants as fsConstants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

import { createContractKit, type ContractFail } from "../contract-kit/index.js";
import { buildContentIndex, buildContentIndexV2 } from "../content-ir/indexer.js";
import { canonicalDigest, sha256 } from "../content-ir/canonical.js";
import type { SectionNode } from "../content-ir/contracts.js";
import type { PathRefusalReason } from "../records/contracts.js";
import { ContentIndexError } from "../content-ir/contracts.js";
import {
  type RepositoryDiscoveryInventoryV1,
  validateRepositoryDiscoveryInventoryAuthority,
} from "../repository/inventory.js";
import {
  RepositoryWorkspaceReadError,
  type RepositoryWorkspace,
} from "../repository/workspace/contracts.js";
import {
  readTrackedRepositoryFile,
  verifyTrackedRepositoryEntries,
} from "../repository/workspace/tracked-read.js";

export const SECTION_FETCH_KIND = "docsfab-section-fetch" as const;

export type SectionFetchErrorCode =
  | "invalid-shape"
  | "invalid-value"
  | "digest-mismatch"
  | "credential-material"
  | "migration-required"
  | "schema-mismatch"
  | "index-unavailable"
  | "not-found"
  | "denied-path"
  | "size-limit-exceeded"
  | "snapshot-changed";

export class SectionFetchError extends Error {
  /** On `index-unavailable`, the content index's own closed refusal code. */
  public readonly indexRefusal: ContentIndexError["code"] | undefined;
  /** On `denied-path`, the confinement rule that refused the path, when one did. */
  public readonly pathRefusal: PathRefusalReason | undefined;

  public constructor(
    public readonly code: SectionFetchErrorCode,
    detail: {
      readonly indexRefusal?: ContentIndexError["code"];
      readonly pathRefusal?: PathRefusalReason;
    } = {},
  ) {
    super(`Section fetch rejected: ${code}.`);
    this.name = "SectionFetchError";
    this.indexRefusal = detail.indexRefusal;
    this.pathRefusal = detail.pathRefusal;
  }
}

function fail(code: SectionFetchErrorCode): never {
  throw new SectionFetchError(code);
}

const { assertInert, rejectCredentials, object, exact, string, hash, revision } = createContractKit(
  {
    fail: fail as ContractFail<SectionFetchErrorCode>,
    codes: {
      invalidShape: "invalid-shape",
      invalidValue: "invalid-value",
      digestMismatch: "digest-mismatch",
      credentialMaterial: "credential-material",
      schemaMismatch: "migration-required",
    },
  },
);

function isRepositoryRelativePath(value: string): boolean {
  return (
    value === value.normalize("NFC") &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    !value.startsWith("/") &&
    value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..")
  );
}

function isHeadingId(value: string): boolean {
  return (
    value === value.normalize("NFC") &&
    value.length > 0 &&
    value.length <= 256 &&
    !value.includes("\0") &&
    !value.includes("\\")
  );
}

export interface FetchSectionInput {
  repositoryPath: string;
  repositoryRevision: string;
  path: string;
  headingId: string;
  /** Host-resolved absolute file path inside the workspace. */
  resolvedPath: string;
  /** Existing host workspace/inventory identity. Omit only for legacy diagnostics. */
  workspaceSnapshotSha256?: string;
  /** Revalidation binding for a section previously observed in this snapshot. */
  expectedEvidence?: Pick<
    SectionFetchResultV1,
    "repositoryRevision" | "workspaceSnapshotSha256" | "evidenceSha256"
  >;
}

export interface SectionFetchResultV1 {
  kind: typeof SECTION_FETCH_KIND;
  repositoryRevision: string;
  workspaceSnapshotSha256: string | null;
  path: string;
  headingId: string;
  sectionId: string;
  depth: number;
  startLine: number;
  endLine: number;
  byteLength: number;
  digest: string;
  bytes: string;
  evidenceSha256: string;
}

export interface SectionFetchAuthority {
  readonly workspace: RepositoryWorkspace;
  readonly inventory: RepositoryDiscoveryInventoryV1;
}

export const MAX_SECTION_SOURCE_BYTES = 1024 * 1024;
export const MAX_RETURNED_SECTION_BYTES = 64 * 1024;

export async function fetchDocumentationSection(
  input: FetchSectionInput,
  authority?: SectionFetchAuthority,
): Promise<SectionFetchResultV1> {
  assertInert(input);
  rejectCredentials(input);
  const root = object(input as unknown);
  exact(
    root,
    [
      "repositoryPath",
      "repositoryRevision",
      "path",
      "headingId",
      "resolvedPath",
      "workspaceSnapshotSha256",
      "expectedEvidence",
    ],
    ["workspaceSnapshotSha256", "expectedEvidence"],
  );
  const repositoryPath = string(root.repositoryPath);
  const repositoryRevision = revision(root.repositoryRevision);
  const path = string(root.path);
  const headingId = string(root.headingId);
  const resolvedPath = string(root.resolvedPath);
  if (!isRepositoryRelativePath(path)) fail("denied-path");
  if (!isHeadingId(headingId)) fail("invalid-value");
  if (resolve(resolvedPath) !== resolvedPath) fail("denied-path");
  const workspaceSnapshotSha256 =
    root.workspaceSnapshotSha256 === undefined ? null : hash(root.workspaceSnapshotSha256);
  const expected = decodeExpectedEvidence(root.expectedEvidence);
  if (
    expected &&
    (expected.repositoryRevision !== repositoryRevision ||
      expected.workspaceSnapshotSha256 !== workspaceSnapshotSha256)
  ) {
    fail("snapshot-changed");
  }

  const canonicalRoot = await realpath(repositoryPath);
  const canonicalTarget = await realpath(resolvedPath).catch(() => fail("denied-path"));
  const relativeTarget = relative(canonicalRoot, canonicalTarget);
  const logicalTarget = relativeTarget.split(sep).join("/");
  if (
    !relativeTarget ||
    relativeTarget === ".." ||
    relativeTarget.startsWith(`..${sep}`) ||
    resolve(canonicalRoot, relativeTarget) !== canonicalTarget ||
    logicalTarget !== path
  ) {
    fail("denied-path");
  }

  let sections: SectionNode[];
  let trackedBytes: Buffer | undefined;
  try {
    const index = authority
      ? await authenticatedContentIndex(authority, {
          canonicalRoot,
          repositoryRevision,
          workspaceSnapshotSha256,
        })
      : await legacyContentIndex(input, workspaceSnapshotSha256);
    sections = index.nodes.filter((node): node is SectionNode => node.kind === "section");
    if (authority) {
      trackedBytes = await readTrackedRepositoryFile(
        authority.workspace,
        path,
        MAX_SECTION_SOURCE_BYTES,
      );
    }
  } catch (error) {
    if (error instanceof SectionFetchError) throw error;
    if (
      (error instanceof ContentIndexError && error.code === "tracked-file-changed") ||
      (error instanceof RepositoryWorkspaceReadError && error.code === "changed")
    ) {
      fail("snapshot-changed");
    }
    if (
      (error instanceof ContentIndexError && error.code === "source-too-large") ||
      (error instanceof RepositoryWorkspaceReadError && error.code === "oversize")
    ) {
      fail("size-limit-exceeded");
    }
    // A directory or an untracked file is not a tracked page with sections.
    if (
      error instanceof RepositoryWorkspaceReadError &&
      (error.code === "not-tracked" || error.code === "unsafe-kind")
    ) {
      fail("not-found");
    }
    if (error instanceof ContentIndexError) {
      throw new SectionFetchError("index-unavailable", { indexRefusal: error.code }); // hygiene: ok -- stable typed code; the constructor supplies the message.
    }
    fail("index-unavailable");
  }

  const section = sections.find(
    (candidate) =>
      candidate.sourcePath === path &&
      (candidate.anchor === headingId || candidate.id === headingId),
  );
  if (!section) fail("not-found");

  let contents: string;
  if (trackedBytes) {
    contents = strictUtf8(trackedBytes).replace(/\r\n?/gu, "\n");
  } else {
    const handle = await open(canonicalTarget, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW).catch(
      () => fail("denied-path"),
    );
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size > MAX_SECTION_SOURCE_BYTES) {
        fail("size-limit-exceeded");
      }
      const raw = await handle.readFile();
      const after = await handle.stat();
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        raw.byteLength !== before.size
      ) {
        fail("snapshot-changed");
      }
      contents = strictUtf8(raw).replace(/\r\n?/gu, "\n");
    } finally {
      await handle.close();
    }
  }
  const lines = contents.split("\n");
  const slice = lines.slice(section.startLine - 1, section.endLine).join("\n");
  const bytes = slice.endsWith("\n") ? slice : `${slice}\n`;
  if (Buffer.byteLength(bytes, "utf8") > MAX_RETURNED_SECTION_BYTES) {
    fail("size-limit-exceeded");
  }
  if (
    authority &&
    (await verifyTrackedRepositoryEntries(authority.workspace)).some(
      (entry) => entry.status === "changed",
    )
  ) {
    fail("snapshot-changed");
  }
  const body = {
    kind: SECTION_FETCH_KIND,
    repositoryRevision,
    workspaceSnapshotSha256,
    path,
    headingId: section.anchor,
    sectionId: section.id,
    depth: section.depth,
    startLine: section.startLine,
    endLine: section.endLine,
    byteLength: Buffer.byteLength(bytes, "utf8"),
    digest: sha256(bytes),
    bytes,
  };
  const result = { ...body, evidenceSha256: canonicalDigest(body) };
  if (expected && expected.evidenceSha256 !== result.evidenceSha256) {
    fail("snapshot-changed");
  }
  return result;
}

async function authenticatedContentIndex(
  authority: SectionFetchAuthority,
  expected: {
    canonicalRoot: string;
    repositoryRevision: string;
    workspaceSnapshotSha256: string | null;
  },
) {
  const workspaceRoot = await realpath(authority.workspace.path).catch(() => fail("denied-path"));
  if (
    workspaceRoot !== expected.canonicalRoot ||
    authority.workspace.revision !== expected.repositoryRevision ||
    expected.workspaceSnapshotSha256 !== authority.inventory.inventorySha256
  ) {
    fail("snapshot-changed");
  }
  validateRepositoryDiscoveryInventoryAuthority(authority.inventory, {
    sourcePath: authority.workspace.sourcePath,
    requestedRevision: authority.workspace.requestedRevision,
    revision: authority.workspace.revision,
  });
  return buildContentIndexV2({ workspace: authority.workspace });
}

async function legacyContentIndex(
  input: FetchSectionInput,
  workspaceSnapshotSha256: string | null,
) {
  if (workspaceSnapshotSha256 !== null) fail("snapshot-changed");
  return buildContentIndex({
    repositoryPath: input.repositoryPath,
    repositoryRevision: input.repositoryRevision,
    includePaths: [input.path],
  });
}

function strictUtf8(bytes: Uint8Array): string {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.includes("\0")) fail("index-unavailable");
    return text;
  } catch (error) {
    if (error instanceof SectionFetchError) throw error;
    fail("index-unavailable");
  }
}

function decodeExpectedEvidence(
  value: unknown,
): Pick<
  SectionFetchResultV1,
  "repositoryRevision" | "workspaceSnapshotSha256" | "evidenceSha256"
> | null {
  if (value === undefined) return null;
  const root = object(value);
  exact(root, ["repositoryRevision", "workspaceSnapshotSha256", "evidenceSha256"]);
  return {
    repositoryRevision: revision(root.repositoryRevision),
    workspaceSnapshotSha256:
      root.workspaceSnapshotSha256 === null ? null : hash(root.workspaceSnapshotSha256),
    evidenceSha256: hash(root.evidenceSha256),
  };
}
