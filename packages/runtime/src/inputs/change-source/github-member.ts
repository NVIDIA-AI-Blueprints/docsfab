// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The `source` members of the GitHub kinds and their closed decoders.
 * Each is always `forge-reported`: the host records what the GitHub REST API
 * reported and does not hold the objects to verify it.
 *
 * `change-source.ts` registers the decoders and hands them the contract's
 * refusal, so this module imports nothing from it but types and stays a leaf.
 */
import type { ChangeSourceDecodeKit, ChangeSourceSourceDecoder } from "../change-source.js";

/** The member keys besides `kind`; the decoders and the resolver share them. */
interface GithubSourceBaseV1 {
  readonly provenance: "forge-reported";
  /** Always `github.com` in this release. */
  readonly host: string;
  /** GitHub's numeric repository id: the identity, unlike the name, survives a rename. */
  readonly repositoryId: number;
  /** `owner/name` as GitHub reported it, for display only. */
  readonly fullName: string;
}

export interface GithubPullRequestSourceV1 extends GithubSourceBaseV1 {
  readonly kind: "github-pull-request";
  readonly number: number;
  /** `open` diffs from the target branch's current tip; `merged` from the pull request's own recorded base. */
  readonly state: "open" | "merged";
  /** The repository the head branch lives in; null when GitHub no longer reports it (a deleted fork). */
  readonly headRepositoryId: number | null;
}

export interface GithubCommitSourceV1 extends GithubSourceBaseV1 {
  readonly kind: "github-commit";
}

/**
 * A compare between two commits of one repository. A cross-fork compare is
 * refused at the URL, so both sides live in `repositoryId` and the member
 * names no head repository. The pinned commits live in the record's
 * `revision`, not here.
 */
export interface GithubCompareSourceV1 extends GithubSourceBaseV1 {
  readonly kind: "github-compare";
}

const FULL_NAME = /^[A-Za-z0-9](?:-?[A-Za-z0-9])*\/[A-Za-z0-9._-]+$/u;

/** The decoders of the GitHub members, refusing through the contract's own `invalid`. */
export function githubSourceDecoders(invalid: () => never): {
  readonly "github-pull-request": ChangeSourceSourceDecoder<GithubPullRequestSourceV1>;
  readonly "github-commit": ChangeSourceSourceDecoder<GithubCommitSourceV1>;
  readonly "github-compare": ChangeSourceSourceDecoder<GithubCompareSourceV1>;
} {
  const positiveId = (value: unknown): number => {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) invalid();
    return value;
  };
  const base = (
    root: Record<string, unknown>,
    decode: ChangeSourceDecodeKit,
  ): GithubSourceBaseV1 => {
    if (typeof root.fullName !== "string" || !FULL_NAME.test(root.fullName)) invalid();
    return {
      provenance: decode.enumeration(root.provenance, ["forge-reported"] as const),
      host: decode.enumeration(root.host, ["github.com"] as const),
      repositoryId: positiveId(root.repositoryId),
      fullName: root.fullName,
    };
  };
  return Object.freeze({
    "github-pull-request": (root: Record<string, unknown>, decode: ChangeSourceDecodeKit) => {
      decode.exact(root, [
        "kind",
        "provenance",
        "host",
        "repositoryId",
        "fullName",
        "number",
        "state",
        "headRepositoryId",
      ]);
      return {
        kind: "github-pull-request" as const,
        ...base(root, decode),
        number: positiveId(root.number),
        state: decode.enumeration(root.state, ["open", "merged"] as const),
        headRepositoryId: root.headRepositoryId === null ? null : positiveId(root.headRepositoryId),
      };
    },
    "github-commit": (root: Record<string, unknown>, decode: ChangeSourceDecodeKit) => {
      decode.exact(root, ["kind", "provenance", "host", "repositoryId", "fullName"]);
      return { kind: "github-commit" as const, ...base(root, decode) };
    },
    "github-compare": (root: Record<string, unknown>, decode: ChangeSourceDecodeKit) => {
      decode.exact(root, ["kind", "provenance", "host", "repositoryId", "fullName"]);
      return { kind: "github-compare" as const, ...base(root, decode) };
    },
  });
}
