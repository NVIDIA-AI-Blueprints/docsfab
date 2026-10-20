// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The `--change` grammar for github.com pull request, commit and compare URLs. It
 * claims only an `http:` or `https:` URL whose host is `github.com` or
 * `www.github.com`; every other host, and every scheme-less forge path, is left
 * to the foreign-form refusal, so a GitLab or Gitea link of the same shape is
 * never read as GitHub. Refusals never echo the operator's value.
 *
 * `change-source.ts` registers the arm and hands it the contract's refusal
 * function, so this module imports nothing from it but types and stays a leaf.
 */
import type {
  ChangeSourceRefusalCode,
  ChangeSourceSelectorArm,
  ChangeSourceSelectorMemberV1,
} from "../change-source.js";

/** The one forge host this kind reads; the record carries it as written here. */
export const GITHUB_HOST = "github.com" as const;
/** The web hosts that name github.com; `www.` serves the same repositories. */
const GITHUB_WEB_HOSTS: ReadonlySet<string> = new Set([GITHUB_HOST, `www.${GITHUB_HOST}`]);
/** Git's shortest abbreviated object name (`core.abbrev` minimum). */
const GIT_MIN_ABBREVIATED_ID_LENGTH = 4;
/** A full SHA-1 object id in hex: GitHub repositories use SHA-1. */
const SHA1_HEX_LENGTH = 40;

/** The contract's refusal, injected by the registry so this module stays a leaf. */
export type GithubSelectorRefusal = (code: ChangeSourceRefusalCode, detail?: string) => never;

/** A GitHub account name: letters, digits, and inner single hyphens. */
const OWNER = /^[A-Za-z0-9](?:-?[A-Za-z0-9])*$/u;
/** A GitHub repository name: letters, digits, `.`, `_`, `-`; never `.` or `..`. */
const REPOSITORY = /^[A-Za-z0-9._-]+$/u;
const PULL_NUMBER = /^[1-9][0-9]*$/u;
const HEX = /^[0-9a-f]+$/u;
/** Whole-pull-request views: each lists the same change. */
const PULL_VIEWS: ReadonlySet<string> = new Set(["files", "commits", "changes"]);
/** Download forms of the same change. */
const DOWNLOAD_SUFFIXES = [".diff", ".patch"] as const;
/**
 * The one query a compare page admits: GitHub adds it when it opens the
 * pull request form, and it does not change the diff. Any other query, such
 * as `?w=1`, changes what the page shows, so it refuses.
 */
const COMPARE_QUERY = "?expand=1";
/**
 * What the URL parser trims from the end of a value: C0 controls and the
 * space. It trims the start too, but that only touches the scheme.
 */
const URL_TRIMMED_END = /[\u0000-\u0020]+$/u;
/** Characters git never admits in a ref name (`git check-ref-format`). */
const REF_FORBIDDEN = /[\u0000-\u0020\u007f~^:?*[\\]/u;

export interface GithubPullRequestSelectorV1 extends ChangeSourceSelectorMemberV1 {
  readonly source: "github-pull-request";
  readonly host: typeof GITHUB_HOST;
  readonly owner: string;
  readonly repository: string;
  readonly number: number;
}

export interface GithubCommitSelectorV1 extends ChangeSourceSelectorMemberV1 {
  readonly source: "github-commit";
  readonly host: typeof GITHUB_HOST;
  readonly owner: string;
  readonly repository: string;
  /** Lowercase hex; abbreviated when the URL was, pinned to the full id at resolution. */
  readonly commit: string;
}

/**
 * A compare page between two refs of one repository. `three-dot` diffs from
 * their merge base; `two-dot` diffs from `base` itself. Both refs are names
 * as written (branch, tag, or commit id), pinned to commit ids at resolution.
 */
export interface GithubCompareSelectorV1 extends ChangeSourceSelectorMemberV1 {
  readonly source: "github-compare";
  readonly host: typeof GITHUB_HOST;
  readonly owner: string;
  readonly repository: string;
  readonly form: "two-dot" | "three-dot";
  readonly base: string;
  readonly head: string;
}

export type GithubChangeSourceSelectorV1 =
  | GithubPullRequestSelectorV1
  | GithubCommitSelectorV1
  | GithubCompareSelectorV1;

function withoutDownloadSuffix(segment: string): string {
  const suffix = DOWNLOAD_SUFFIXES.find((candidate) => segment.endsWith(candidate));
  return suffix === undefined ? segment : segment.slice(0, -suffix.length);
}

function pullNumber(text: string, fail: GithubSelectorRefusal): number {
  const number = Number(text);
  if (!PULL_NUMBER.test(text) || !Number.isSafeInteger(number)) {
    fail("change-source-github-url-grammar", "pull request number");
  }
  return number;
}

function commitId(text: string, fail: GithubSelectorRefusal): string {
  const id = text.toLowerCase();
  if (!HEX.test(id) || id.length < GIT_MIN_ABBREVIATED_ID_LENGTH || id.length > SHA1_HEX_LENGTH) {
    fail("change-source-github-url-grammar", "commit id");
  }
  return id;
}

/**
 * Whether the value, as typed, holds a `.` or `..` path segment. The URL
 * parser removes them (`%2e` and `\\` included) before the path is read, so
 * `compare/a/../b...c` would otherwise be read as `compare/b...c`.
 */
function hasDotSegment(value: string): boolean {
  // Read the value as the URL parser does: it trims trailing C0 controls and
  // spaces, so `x/.. ` ends in `..`, then drops tabs and newlines anywhere,
  // so `.\t.` is `..` to it.
  const typed = value
    .replace(URL_TRIMMED_END, "")
    .replace(/[\t\n\r]/gu, "")
    .split(/[?#]/u)[0]!;
  return typed.split(/[/\\]/u).some((segment) => {
    const dots = segment.toLowerCase().replaceAll("%2e", ".");
    return dots === "." || dots === "..";
  });
}

/** One compare side, refused unless git could name a ref by it. */
function compareRef(text: string, fail: GithubSelectorRefusal): string {
  // A cross-fork side (`owner:branch`) or a reflog date names a commit this
  // reader cannot pin within the one repository it reads.
  if (text.includes(":") || text.includes("@{")) fail("change-source-github-compare-unsupported");
  if (
    text === "" ||
    text === "@" ||
    REF_FORBIDDEN.test(text) ||
    text.includes("..") ||
    text.includes("//") ||
    text.startsWith("-") ||
    text.startsWith("/") ||
    text.endsWith("/") ||
    text.endsWith(".") ||
    text.split("/").some((part) => part.startsWith(".") || part.endsWith(".lock"))
  ) {
    fail("change-source-github-url-grammar", "compare range");
  }
  return text;
}

/**
 * The range of a compare page: everything after `compare/`, refs holding
 * `/` included. Percent-encoding is decoded once, so `feature%2Fx` names
 * `feature/x`. `...` is split before `..`; a ref never holds `..`.
 */
function compareRange(
  rest: readonly string[],
  fail: GithubSelectorRefusal,
): Pick<GithubCompareSelectorV1, "form" | "base" | "head"> {
  const encoded = withoutDownloadSuffix(rest.join("/"));
  let range = "";
  try {
    range = decodeURIComponent(encoded);
  } catch {
    // Handles only a malformed percent escape; decodeURIComponent throws nothing else.
    fail("change-source-github-url-grammar", "compare range");
  }
  const threeDot = range.indexOf("...");
  const twoDot = range.indexOf("..");
  // One ref, or the bare compare page, names no range to read.
  if (twoDot < 0) fail("change-source-github-compare-unsupported");
  const [form, split, width] =
    threeDot >= 0
      ? (["three-dot", threeDot, "...".length] as const)
      : (["two-dot", twoDot, "..".length] as const);
  return {
    form,
    base: compareRef(range.slice(0, split), fail),
    head: compareRef(range.slice(split + width), fail),
  };
}

/**
 * Parse a value as a URL only to decide whether it is a GitHub web URL. A
 * value that is not a URL is not this arm's, so the range grammar reads it.
 */
function parsedUrl(value: string): URL | undefined {
  // Handles only URL syntax failure; `URL.canParse` decides it, so no other
  // error can reach this branch.
  return URL.canParse(value) ? new URL(value) : undefined;
}

/** Whether the value is an `https:` URL on github.com, whatever its path. */
export function isGithubHttpsUrl(value: string): boolean {
  const url = parsedUrl(value);
  return url?.protocol === "https:" && GITHUB_WEB_HOSTS.has(url.hostname);
}

/**
 * The selector arm: a `github-pull-request`, `github-commit` or
 * `github-compare` member for a github.com URL, a coded refusal through `fail` for any other github.com
 * URL, and `undefined` for anything not on github.com.
 */
export function githubChangeSourceSelectorArm(
  fail: GithubSelectorRefusal,
): ChangeSourceSelectorArm<GithubChangeSourceSelectorV1> {
  return (value) => parseGithubChangeUrl(value, fail);
}

function parseGithubChangeUrl(
  value: string,
  fail: GithubSelectorRefusal,
): GithubChangeSourceSelectorV1 | undefined {
  const url = parsedUrl(value);
  if (url === undefined) return undefined;
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  if (!GITHUB_WEB_HOSTS.has(url.hostname)) return undefined;
  // Userinfo first: a credential in the URL refuses before anything else is judged.
  if (url.username !== "" || url.password !== "") {
    fail("change-source-github-url-credentials");
  }
  if (url.protocol !== "https:") fail("change-source-github-url-insecure");
  if (url.port !== "") fail("change-source-github-url-grammar", "port");
  const segments = url.pathname.split("/").slice(1);
  if (segments.length > 0 && segments.at(-1) === "") segments.pop();
  const [owner, repository, route, ...rest] = segments;
  // A query can change what the page shows (`?w=1` hides whitespace changes),
  // so it is refused rather than dropped; only a compare page's `?expand=1`
  // is admitted. A fragment only scrolls the page.
  if (url.search !== "" && !(route === "compare" && url.search === COMPARE_QUERY)) {
    fail("change-source-github-url-grammar", "query string");
  }
  if (hasDotSegment(value)) fail("change-source-github-url-grammar", "path");
  if (
    owner === undefined ||
    repository === undefined ||
    !OWNER.test(owner) ||
    !REPOSITORY.test(repository) ||
    repository === "." ||
    repository === ".."
  ) {
    fail("change-source-github-url-grammar", "owner or repository");
  }
  const named = {
    schemaVersion: 1 as const,
    kind: "docsfab-change-source-selector" as const,
  };
  if (route === "compare") {
    return {
      ...named,
      source: "github-compare",
      host: GITHUB_HOST,
      owner,
      repository,
      ...compareRange(rest, fail),
    };
  }
  if (route === "pull" && rest.length >= 1) {
    const [numberText, view, ...more] = rest;
    if (view !== undefined && PULL_VIEWS.has(view) && more.length > 0) {
      // A single commit or a commit range inside the pull request names part
      // of it; binding the whole pull request would widen the change.
      fail("change-source-github-url-partial");
    }
    if (view !== undefined && !PULL_VIEWS.has(view)) {
      fail("change-source-github-url-grammar", "pull request view");
    }
    return {
      ...named,
      source: "github-pull-request",
      host: GITHUB_HOST,
      owner,
      repository,
      number: pullNumber(
        view === undefined ? withoutDownloadSuffix(numberText!) : numberText!,
        fail,
      ),
    };
  }
  if (route === "commit" && rest.length === 1) {
    return {
      ...named,
      source: "github-commit",
      host: GITHUB_HOST,
      owner,
      repository,
      commit: commitId(withoutDownloadSuffix(rest[0]!), fail),
    };
  }
  return fail("change-source-github-url-grammar", "path");
}
