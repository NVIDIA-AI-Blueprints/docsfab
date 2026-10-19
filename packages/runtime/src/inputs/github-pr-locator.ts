// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Strict public GitHub PR URL; the path names a target, not a network grant. */
import { createChangeRequestRef, type ChangeRequestRefV1 } from "./change-request.js";

const OWNER = /^[A-Za-z0-9](?:-?[A-Za-z0-9])*$/u;
const REPOSITORY = /^[A-Za-z0-9._-]+$/u;
const NUMBER = /^[1-9][0-9]*$/u;
const WEB_HOSTS = new Set(["github.com", "www.github.com"]);

export class GithubPrLocatorError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "GithubPrLocatorError";
  }
}

function fail(code: string): never {
  throw new GithubPrLocatorError(code);
}

export interface GithubPrLocatorV1 {
  readonly host: "github.com";
  readonly owner: string;
  readonly repository: string;
  readonly number: number;
  readonly canonicalUrl: string;
}

/** Rejects partial, encoded, credential-bearing, or ambiguous URL forms. */
export function parseGithubPrLocator(input: string): GithubPrLocatorV1 {
  if (
    typeof input !== "string" ||
    input.trim() !== input ||
    input.includes("\\") ||
    input.includes("?") ||
    input.includes("#") ||
    !URL.canParse(input)
  )
    fail("github-pr-url-invalid");
  // WHATWG URL parsing collapses dot segments before pathname can reject them.
  const pathStart = input.indexOf("/", input.indexOf("://") + 3);
  if (pathStart < 0) fail("github-pr-url-grammar");
  if (
    input
      .slice(pathStart)
      .split("/")
      .some((segment) => segment === "." || segment === ".." || segment.includes("%"))
  )
    fail("github-pr-url-encoding-unsupported");
  const url = new URL(input);
  if (url.username !== "" || url.password !== "") fail("github-pr-url-credentials");
  if (
    url.protocol !== "https:" ||
    !WEB_HOSTS.has(url.hostname) ||
    url.port !== "" ||
    url.origin !== `https://${url.hostname}`
  )
    fail("github-pr-url-host-unsupported");
  if (url.pathname.includes("%")) fail("github-pr-url-encoding-unsupported");
  const segments = url.pathname.split("/").slice(1);
  if (segments.at(-1) === "") segments.pop();
  if (
    (segments.length !== 4 && segments.length !== 5) ||
    segments[2] !== "pull" ||
    (segments.length === 5 && segments[4] !== "files" && segments[4] !== "changes")
  )
    fail("github-pr-url-grammar");
  const [owner, repository, , numberText] = segments;
  if (
    !owner ||
    !repository ||
    !OWNER.test(owner) ||
    !REPOSITORY.test(repository) ||
    repository.toLowerCase().endsWith(".git") ||
    repository === "." ||
    repository === ".." ||
    !numberText ||
    !NUMBER.test(numberText)
  )
    fail("github-pr-url-grammar");
  const number = Number(numberText);
  if (!Number.isSafeInteger(number)) fail("github-pr-url-grammar");
  return Object.freeze({
    host: "github.com",
    owner,
    repository,
    number,
    canonicalUrl: `https://github.com/${owner}/${repository}/pull/${number}`,
  });
}

/** Stable identity is minted only after trusted metadata verifies target ID. */
export function githubPrReference(
  locator: GithubPrLocatorV1,
  targetRepositoryId: number,
): ChangeRequestRefV1 {
  if (!Number.isSafeInteger(targetRepositoryId) || targetRepositoryId <= 0)
    fail("github-pr-target-id-invalid");
  return createChangeRequestRef({
    provider: "github",
    canonicalHost: locator.host,
    targetRepositoryId: String(targetRepositoryId),
    objectKind: "pull-request",
    nativeChangeId: String(locator.number),
  });
}
