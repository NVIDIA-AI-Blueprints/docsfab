// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Anonymous, bounded reads of the public GitHub REST API for `--change`.
 *
 * No request carries an Authorization header, and nothing here reads a token
 * from the environment, so no credential can reach GitHub or a redirect
 * target. Redirects are followed by hand, only within
 * `https://api.github.com` (GitHub answers a renamed or transferred
 * repository that way), and only up to `changeSourcesGithub.redirectsMax`.
 * Response bodies are counted while they stream and refused one byte past
 * `changeSourcesGithub.responseMaxBytes`; nothing is retried, so a
 * resolution's request count is fixed by the change, not by failures.
 */
import {
  limit,
  OperationalLimitError,
  refuseLimit,
  type ResolveLimitsOptions,
  type ResolvedLimit,
} from "../../config/limits.js";
import { ChangeSourceError, failChangeSource } from "../change-source.js";

export const GITHUB_API_ORIGIN = "https://api.github.com" as const;
/** The REST API version this reader was written against (GitHub REST API versioning). */
export const GITHUB_API_VERSION = "2022-11-28" as const;
/** Items per page: the GitHub REST maximum, so a listing costs the fewest requests. */
export const GITHUB_PAGE_SIZE = 100 as const;

/** HTTP statuses this reader distinguishes (RFC 9110, and 429 from RFC 6585). */
const HTTP_STATUS = Object.freeze({
  ok: 200,
  forbidden: 403,
  notFound: 404,
  tooManyRequests: 429,
});
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
/** `x-ratelimit-reset` is in epoch seconds. */
const MILLISECONDS_PER_SECOND = 1000;

export const CHANGE_SOURCES_GITHUB_PAGES_MAX_LIMIT = "changeSourcesGithub.pagesMax" as const;
export const CHANGE_SOURCES_GITHUB_RESPONSE_MAX_BYTES_LIMIT =
  "changeSourcesGithub.responseMaxBytes" as const;
export const CHANGE_SOURCES_GITHUB_REDIRECTS_MAX_LIMIT =
  "changeSourcesGithub.redirectsMax" as const;
export const CHANGE_SOURCES_GITHUB_REQUEST_TIMEOUT_MS_LIMIT =
  "changeSourcesGithub.requestTimeoutMs" as const;

export interface GithubApiLimitsV1 {
  readonly pages: ResolvedLimit;
  readonly responseBytes: ResolvedLimit;
  readonly redirects: ResolvedLimit;
  readonly timeoutMs: ResolvedLimit;
}

export function githubApiLimits(options?: ResolveLimitsOptions): GithubApiLimitsV1 {
  return {
    pages: limit(CHANGE_SOURCES_GITHUB_PAGES_MAX_LIMIT, options),
    responseBytes: limit(CHANGE_SOURCES_GITHUB_RESPONSE_MAX_BYTES_LIMIT, options),
    redirects: limit(CHANGE_SOURCES_GITHUB_REDIRECTS_MAX_LIMIT, options),
    timeoutMs: limit(CHANGE_SOURCES_GITHUB_REQUEST_TIMEOUT_MS_LIMIT, options),
  };
}

/** The fetch this reader calls: the shape of the global `fetch`, injectable for tests. */
export type GithubFetchPort = (url: string, init: RequestInit) => Promise<Response>;

export interface GithubApiPageV1 {
  readonly body: unknown;
  /** The `rel="next"` link GitHub sent, already checked to stay on the API origin. */
  readonly next: string | null;
}

export interface GithubApiClient {
  /** GET one API path (or a `next` link) and parse its JSON body. */
  readonly get: (pathOrUrl: string) => Promise<GithubApiPageV1>;
  /** Requests sent so far, redirects included. */
  readonly requests: () => number;
}

/** The headers every request carries; built here, never from the environment. */
function requestHeaders(): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
    "User-Agent": "docsfab-change-source",
  };
}

/** A URL on the API origin with no userinfo, or the cross-host refusal. */
function onApiOrigin(target: string, base: string): URL {
  if (!URL.canParse(target, base))
    failChangeSource("change-source-github-response-invalid", "redirect location");
  const url = new URL(target, base);
  if (url.origin !== GITHUB_API_ORIGIN || url.username !== "" || url.password !== "") {
    failChangeSource("change-source-github-redirect-cross-host");
  }
  return url;
}

/** The `rel="next"` target of a `Link` header, if any. */
function nextLink(header: string | null, base: string): string | null {
  if (header === null) return null;
  for (const part of header.split(",")) {
    const match = /^\s*<([^>]*)>\s*;(.*)$/u.exec(part);
    if (match && /(?:^|;)\s*rel="?next"?\s*(?:;|$)/u.test(match[2]!)) {
      return onApiOrigin(match[1]!, base).href;
    }
  }
  return null;
}

/** The reset time GitHub named, as an ISO instant, or a plain statement that it named none. */
function resetDetail(headers: Headers): string {
  const reset = Number(headers.get("x-ratelimit-reset"));
  if (Number.isSafeInteger(reset) && reset > 0) {
    return `resets at ${new Date(reset * MILLISECONDS_PER_SECOND).toISOString()}`;
  }
  const retryAfter = Number(headers.get("retry-after"));
  if (Number.isSafeInteger(retryAfter) && retryAfter >= 0) return `retry after ${retryAfter} s`;
  return "GitHub named no reset time";
}

/**
 * Refuse a non-success status with its own code. A 429, or a 403 that says
 * the limit is used up (`x-ratelimit-remaining: 0`) or asks for a wait
 * (`retry-after`), is the rate limit; any other 403 is a refusal of access.
 */
function refuseStatus(response: Response): never {
  const { status, headers } = response;
  const limited =
    status === HTTP_STATUS.tooManyRequests ||
    (status === HTTP_STATUS.forbidden &&
      (headers.get("x-ratelimit-remaining") === "0" || headers.get("retry-after") !== null));
  if (limited) failChangeSource("change-source-github-rate-limited", resetDetail(headers));
  if (status === HTTP_STATUS.forbidden) failChangeSource("change-source-github-forbidden");
  if (status === HTTP_STATUS.notFound) failChangeSource("change-source-github-not-found");
  return failChangeSource("change-source-github-request-failed", `HTTP ${status}`);
}

/**
 * Create a client over `fetchPort`. The default calls the global `fetch` at
 * request time, so a test that replaces it reaches the shipped path.
 */
export function createGithubApiClient(input: {
  readonly limits: GithubApiLimitsV1;
  readonly signal?: AbortSignal;
  readonly fetch?: GithubFetchPort;
}): GithubApiClient {
  const { limits, signal } = input;
  const fetchPort: GithubFetchPort = input.fetch ?? ((url, init) => globalThis.fetch(url, init));
  let requests = 0;

  /**
   * Run one fetch step (the request or its body) under the per-request
   * timeout. A DocsFab refusal raised inside the step passes through, and the
   * caller's own abort is rethrown untouched. Of the rest, this request's
   * timeout refuses at its bound, and any other fetch failure (DNS, TLS, a
   * reset connection, a proxy the global fetch cannot use) is GitHub being
   * unreachable.
   */
  async function timed<T>(
    timeout: AbortSignal,
    started: number,
    step: () => Promise<T>,
  ): Promise<T> {
    try {
      return await step();
    } catch (error) {
      if (error instanceof ChangeSourceError || error instanceof OperationalLimitError) throw error;
      if (signal?.aborted) throw error;
      if (timeout.aborted) {
        refuseLimit(limits.timeoutMs, Math.ceil(performance.now() - started));
      }
      return failChangeSource("change-source-github-unreachable");
    }
  }

  async function readBody(
    response: Response,
    timeout: AbortSignal,
    started: number,
  ): Promise<Buffer> {
    const max = limits.responseBytes.value;
    const declared = Number(response.headers.get("content-length"));
    if (Number.isSafeInteger(declared) && declared > max) {
      await response.body?.cancel();
      refuseLimit(limits.responseBytes, declared);
    }
    if (response.body === null) return Buffer.alloc(0);
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    return timed(timeout, started, async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return Buffer.concat(chunks);
        total += value.byteLength;
        if (total > max) {
          await reader.cancel();
          refuseLimit(limits.responseBytes, total);
        }
        chunks.push(Buffer.from(value));
      }
    });
  }

  async function get(pathOrUrl: string): Promise<GithubApiPageV1> {
    let url = onApiOrigin(pathOrUrl, GITHUB_API_ORIGIN);
    for (let redirects = 0; ; ) {
      const timeout = AbortSignal.timeout(limits.timeoutMs.value);
      const started = performance.now();
      requests += 1;
      const response = await timed(timeout, started, () =>
        fetchPort(url.href, {
          method: "GET",
          headers: requestHeaders(),
          redirect: "manual",
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        }),
      );
      if (REDIRECT_STATUSES.has(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get("location");
        if (location === null) {
          failChangeSource("change-source-github-response-invalid", "redirect location");
        }
        url = onApiOrigin(location, url.href);
        redirects += 1;
        if (redirects > limits.redirects.value) refuseLimit(limits.redirects, redirects);
        continue;
      }
      if (response.status !== HTTP_STATUS.ok) {
        await response.body?.cancel();
        refuseStatus(response);
      }
      const bytes = await readBody(response, timeout, started);
      let body: unknown;
      try {
        body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      } catch {
        // Handles only a body that is not UTF-8 JSON; both decoders throw nothing else.
        failChangeSource("change-source-github-response-invalid", "response body");
      }
      return { body, next: nextLink(response.headers.get("link"), url.href) };
    }
  }

  return Object.freeze({ get, requests: () => requests });
}
