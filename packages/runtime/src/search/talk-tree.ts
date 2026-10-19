// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Closed talk-tree projection of Content IR documents + headings.
 *
 * Observation only: never selects a workflow, never grants write, never
 * leaves the selected workspace. Fail closed when the index cannot be built.
 */

import { createContractKit, type ContractFail } from "../contract-kit/index.js";
import { buildContentIndex } from "../content-ir/indexer.js";
import type { ContentIndex, DocumentNode, SectionNode } from "../content-ir/contracts.js";
import { ContentIndexError } from "../content-ir/contracts.js";

export const TALK_TREE_SCHEMA_VERSION = 1 as const;
export const TALK_TREE_KIND = "docsfab-talk-tree" as const;

export type TalkTreeErrorCode =
  | "invalid-shape"
  | "invalid-value"
  | "digest-mismatch"
  | "credential-material"
  | "migration-required"
  | "schema-mismatch"
  | "index-unavailable";

export class TalkTreeError extends Error {
  public constructor(public readonly code: TalkTreeErrorCode) {
    super(`Talk tree rejected: ${code}.`);
    this.name = "TalkTreeError";
  }
}

function fail(code: TalkTreeErrorCode): never {
  throw new TalkTreeError(code);
}

const { assertInert, rejectCredentials, object, exact, string, hash, revision, seal } =
  createContractKit({
    fail: fail as ContractFail<TalkTreeErrorCode>,
    codes: {
      invalidShape: "invalid-shape",
      invalidValue: "invalid-value",
      digestMismatch: "digest-mismatch",
      credentialMaterial: "credential-material",
      schemaMismatch: "migration-required",
    },
  });

function isRepositoryRelativePath(value: string): boolean {
  return (
    value === value.normalize("NFC") &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    !value.startsWith("/") &&
    value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..")
  );
}

export interface TalkTreeHeadingV1 {
  headingId: string;
  sectionId: string;
  depth: number;
}

export interface TalkTreePageV1 {
  path: string;
  documentId: string;
  headings: TalkTreeHeadingV1[];
}

export interface TalkTreeV1 {
  schemaVersion: 1;
  kind: typeof TALK_TREE_KIND;
  repositoryRevision: string;
  /** Existing host workspace/inventory identity; null marks legacy unbound diagnostics. */
  workspaceSnapshotSha256: string | null;
  treeSha256: string;
  pages: TalkTreePageV1[];
}

export interface BuildTalkTreeInput {
  repositoryPath: string;
  repositoryRevision: string;
  workspaceSnapshotSha256?: string;
  includePaths?: readonly string[];
}

export function projectTalkTree(index: ContentIndex, workspaceSnapshotSha256?: string): TalkTreeV1 {
  assertInert(index);
  const documents = index.nodes.filter((node): node is DocumentNode => node.kind === "document");
  const sections = index.nodes.filter((node): node is SectionNode => node.kind === "section");
  const byDocument = new Map<string, SectionNode[]>();
  for (const section of sections) {
    const group = byDocument.get(section.documentId) ?? [];
    group.push(section);
    byDocument.set(section.documentId, group);
  }
  const pages = documents
    .map((document) => {
      if (!isRepositoryRelativePath(document.sourcePath)) fail("invalid-value");
      const headings = (byDocument.get(document.id) ?? [])
        .slice()
        .sort((left, right) => left.startLine - right.startLine)
        .map((section) => ({
          headingId: section.anchor,
          sectionId: section.id,
          depth: section.depth,
        }));
      return {
        path: document.sourcePath,
        documentId: document.id,
        headings,
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
  const body = {
    repositoryRevision: index.repository.revision,
    workspaceSnapshotSha256: workspaceSnapshotSha256 ?? null,
    pages,
  };
  // Scan the closed projection, not the raw Content IR. Walking the index as
  // one object exceeds the credential-metadata node cap on a mid-size docs set
  // and fail-closes as credential-material even when no secret is present.
  rejectCredentials(body);
  return seal(TALK_TREE_KIND, "treeSha256", body) as TalkTreeV1;
}

export async function buildTalkTree(input: BuildTalkTreeInput): Promise<TalkTreeV1> {
  assertInert(input);
  rejectCredentials(input);
  const root = object(input as unknown);
  exact(
    root,
    ["repositoryPath", "repositoryRevision", "workspaceSnapshotSha256", "includePaths"],
    ["workspaceSnapshotSha256", "includePaths"],
  );
  string(root.repositoryPath);
  revision(root.repositoryRevision);
  if (root.workspaceSnapshotSha256 !== undefined) hash(root.workspaceSnapshotSha256);
  try {
    const index = await buildContentIndex({
      repositoryPath: input.repositoryPath,
      repositoryRevision: input.repositoryRevision,
      ...(input.includePaths ? { includePaths: [...input.includePaths] } : {}),
    });
    return projectTalkTree(index, input.workspaceSnapshotSha256);
  } catch (error) {
    if (error instanceof TalkTreeError) throw error;
    if (error instanceof ContentIndexError) fail("index-unavailable");
    fail("index-unavailable");
  }
}

export function talkTreeConsultedNodes(tree: TalkTreeV1): string[] {
  return tree.pages.flatMap((page) => [
    page.documentId,
    ...page.headings.map((heading) => heading.sectionId),
  ]);
}
