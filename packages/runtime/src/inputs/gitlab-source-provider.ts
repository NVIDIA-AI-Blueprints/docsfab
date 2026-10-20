// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The shared GitLab source provider: project identity and scope, plus the one
 * merge-request read that `src/live-agent/gitlab-read.ts` and the merged-MR
 * acquisition producer both use.
 *
 * The numeric project id is canonical; a path-only reference is resolved once
 * through an injected identity port. Upstream error text is never retained,
 * because it can carry repository evidence or credential-shaped bytes.
 */

import { classifyGlabCommandFailure } from "../delivery/glab-auth-diagnosis.js";
import type { CommandRunner } from "../init/types.js";
import { assertConfinedToolResultCredentialFree } from "../security/credential-isolation.js";
import {
  MERGED_MR_FAILURE_CODES,
  type MergedMrFailureCodeV1,
  type MergedMrPagePortV1,
} from "./merged-mr-discovery.js";
import {
  failSourceDiscovery,
  requireSourceDiscoveryScope,
  type SourceDiscoveryScopeV1,
} from "./source-discovery.js";

/**
 * Operator-facing GitLab failure messages, keyed exactly by
 * `MERGED_MR_FAILURE_CODES`; callers name a code and never write their own message.
 */
export const GITLAB_READ_FAILURES = {
  repository:
    "GitLab evidence requires one supported repository remote. Check the selected repository and its tracking remote.",
  authentication:
    "GitLab authentication failed. Run glab auth login --hostname <host from the selected remote>, then retry.",
  access:
    "GitLab denied access to the selected project or merge request. Check your local glab account permissions.",
  network: "GitLab could not be reached. Check your network or VPN, then retry.",
  timeout: "The GitLab read exceeded its local time limit. Retry a smaller page.",
  request:
    "GitLab evidence request failed. Check that glab is installed, the MR exists, and the server supports the requested API (merged-date ordering requires GitLab 17.2 or later).",
  response: "GitLab returned invalid or oversized evidence. Narrow the request and retry.",
  credentials:
    "Blocked by DocsFab runtime credential screening (confined-tool-result).\nGitLab returned data, but a credential-like pattern was detected. This response was withheld from the model and session log; this is not an authentication failure.",
} as const;

/**
 * Equals `GITLAB_MERGED_MR_PRODUCER_ID` in `./merged-mr-evidence.js`; duplicated
 * rather than imported to keep this module out of the source-binding graph.
 */
export const GITLAB_SOURCE_PROVIDER_ID = "gitlab-merged-mr" as const;

/**
 * GitLab namespace path: one or more `/`-separated segments, each starting
 * alphanumeric. No scheme, no userinfo, no leading slash, no `..`, no query.
 */
const PROJECT_PATH = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)+$/u;
const PROJECT_PATH_LIMIT = 256;

export type GitLabProjectReferenceV1 =
  | {
      readonly kind: "project-id";
      readonly host: string;
      readonly projectId: number;
      readonly projectPath: string | null;
    }
  | { readonly kind: "project-path"; readonly host: string; readonly projectPath: string };

/**
 * Resolves a project path to its numeric id; the shipped adapter is
 * `createGitLabCheckoutIdentityPort` in `./merged-mr-gitlab.js`.
 *
 * `projectPath` in the answer is required: `resolveGitLabSourceScope` refuses an
 * answer it cannot match against the requested project.
 */
export interface GitLabProjectIdentityPortV1 {
  resolveProjectIdentity(reference: {
    readonly host: string;
    readonly projectPath: string;
  }): Promise<{
    readonly host: string;
    readonly projectId: number;
    readonly projectPath: string;
  }>;
}

/** A GitLab-side failure carrying one shared code and no upstream text. */
export class GitLabSourceProviderError extends Error {
  public constructor(public readonly code: MergedMrFailureCodeV1) {
    super(GITLAB_READ_FAILURES[code]);
    this.name = "GitLabSourceProviderError";
  }
}

/** Raise one GitLab-side failure with its message from `GITLAB_READ_FAILURES`. */
export function failGitLabSourceProvider(code: MergedMrFailureCodeV1): never {
  throw new GitLabSourceProviderError(code);
}

export function gitlabSourceDiscoveryFailureMessage(code: MergedMrFailureCodeV1): string {
  if (!(MERGED_MR_FAILURE_CODES as readonly string[]).includes(code)) {
    throw new Error(
      `A GitLab discovery failure message requires one of the shared merged-MR failure codes. Received: ${JSON.stringify(code)}.`,
    );
  }
  return GITLAB_READ_FAILURES[code];
}

/** Map a port rejection to one shared code; never retain its message. */
function failureCodeOf(error: unknown): MergedMrFailureCodeV1 {
  const tagged = (error as { code?: unknown } | null)?.code;
  return (MERGED_MR_FAILURE_CODES as readonly string[]).includes(tagged as string)
    ? (tagged as MergedMrFailureCodeV1)
    : "request";
}

function requireProjectPath(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > PROJECT_PATH_LIMIT ||
    value !== value.normalize("NFC") ||
    value.includes("..") ||
    !PROJECT_PATH.test(value)
  ) {
    // A host path, a `file:` URL, a credential-bearing URL and a line of prose
    // all land here; none of them may become a project reference.
    failSourceDiscovery("local-path");
  }
  return value;
}

/** Validate an operator-supplied project reference; nothing is read, resolved, or granted. */
export function parseGitLabProjectReference(value: unknown): GitLabProjectReferenceV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    failSourceDiscovery("unsupported-locator");
  }
  const root = value as Record<string, unknown>;
  if (Object.keys(root).some((key) => !["host", "projectId", "projectPath"].includes(key))) {
    failSourceDiscovery("unsupported-locator");
  }
  const host = root.host;
  if (typeof host !== "string" || host.length === 0) {
    failSourceDiscovery("unsupported-locator");
  }
  const hasId = root.projectId !== undefined;
  const hasPath = root.projectPath !== undefined;
  if (!hasId && !hasPath) failSourceDiscovery("unsupported-locator");
  if (hasId) {
    const projectId = root.projectId;
    if (typeof projectId !== "number" || !Number.isSafeInteger(projectId) || projectId <= 0) {
      failSourceDiscovery("scope-identity");
    }
    return Object.freeze({
      kind: "project-id" as const,
      host,
      projectId,
      projectPath: hasPath ? requireProjectPath(root.projectPath) : null,
    });
  }
  return Object.freeze({
    kind: "project-path" as const,
    host,
    projectPath: requireProjectPath(root.projectPath),
  });
}

/**
 * Resolve a reference into the scope the discovery service accepts.
 *
 * A reference carrying the numeric id is authoritative and needs no read. A
 * path-only reference is resolved once through the identity port, which must
 * answer about the same project with a usable id.
 */
export async function resolveGitLabSourceScope(input: {
  readonly reference: unknown;
  readonly identityPort?: GitLabProjectIdentityPortV1;
}): Promise<SourceDiscoveryScopeV1> {
  const reference = parseGitLabProjectReference(input?.reference);
  if (reference.kind === "project-id") {
    return requireSourceDiscoveryScope(
      Object.freeze({
        schemaVersion: 1 as const,
        kind: "docsfab-source-discovery-scope" as const,
        providerId: GITLAB_SOURCE_PROVIDER_ID,
        host: reference.host,
        projectId: reference.projectId,
        projectPath: reference.projectPath,
      }),
    );
  }
  const port = input?.identityPort;
  if (!port || typeof port.resolveProjectIdentity !== "function") {
    // A path alone is not an identity; the numeric id stays the canonical key.
    failSourceDiscovery("scope-identity");
  }
  let identity: Awaited<ReturnType<GitLabProjectIdentityPortV1["resolveProjectIdentity"]>>;
  try {
    identity = await port.resolveProjectIdentity({
      host: reference.host,
      projectPath: reference.projectPath,
    });
  } catch (error) {
    failGitLabSourceProvider(failureCodeOf(error));
  }
  if (!identity || typeof identity !== "object") {
    failGitLabSourceProvider("response");
  }
  if (identity.host !== reference.host || identity.projectPath !== reference.projectPath) {
    // An omitted or different path is refused: the id would otherwise become
    // the key every later locator is minted from, silently widening scope.
    failSourceDiscovery("out-of-scope-locator");
  }
  if (
    typeof identity.projectId !== "number" ||
    !Number.isSafeInteger(identity.projectId) ||
    identity.projectId <= 0
  ) {
    // `requireSourceDiscoveryScope` would also refuse this, but only as a side
    // effect of minting a locator, so the boundary checks it itself.
    failSourceDiscovery("scope-identity");
  }
  return requireSourceDiscoveryScope(
    Object.freeze({
      schemaVersion: 1 as const,
      kind: "docsfab-source-discovery-scope" as const,
      providerId: GITLAB_SOURCE_PROVIDER_ID,
      host: reference.host,
      projectId: identity.projectId,
      projectPath: reference.projectPath,
    }),
  );
}

// ---------------------------------------------------------------------------
// Merge-request reads: endpoint, failure classification, projection, and
// credential screen. `src/live-agent/gitlab-read.ts` owns argument admission
// and the result envelope; `./source-acquisition-gitlab.js` owns binding.
// ---------------------------------------------------------------------------

/** Host cap on items per page. The tool admits up to 100 and clamps to this. */
export const GITLAB_READ_PAGE_SIZE = 20;
/** Longest retained MR text field. Anything longer is clipped and flagged. */
export const GITLAB_READ_TEXT_LIMIT = 32_000;
/** Largest `glab api` body this provider will parse at all. */
const GITLAB_READ_BODY_LIMIT_BYTES = 2 * 1024 * 1024;

export type GitLabMrReadOperationV1 = "list_merged" | "get" | "diffs";

/** One projected merge request, in the shipped `get` shape. */
export interface GitLabMrProjectionV1 {
  readonly iid: number;
  readonly url: string;
  readonly title: string | null;
  readonly description: string | null;
  readonly state: string | null;
  readonly mergedAt: string | null;
  readonly targetBranch: string | null;
  readonly sourceBranch: string | null;
  readonly mergeCommitSha: string | null;
  readonly squashCommitSha: string | null;
  /**
   * True when this provider clipped any text field. A consumer cannot recover
   * this from the clipped text itself, so every reader must set it.
   */
  readonly textTruncated: boolean;
}

/** The provider's read seam for one merge request; the producer stays pure over projections. */
export interface GitLabMrSourceReaderV1 {
  /** Undefined when the merge request is absent. */
  readMergeRequest(mergeRequestIid: number): Promise<GitLabMrProjectionV1 | undefined>;
}

function integer(value: unknown, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= max;
}

/** The exact `glab api` path this provider is allowed to request. */
export function gitlabMrReadEndpoint(input: {
  readonly operation: GitLabMrReadOperationV1;
  readonly projectPath: string;
  readonly mergeRequestIid?: number;
  readonly limit: number;
  readonly page: number;
}): string {
  const base = `projects/${encodeURIComponent(input.projectPath)}/merge_requests`;
  return input.operation === "list_merged"
    ? `${base}?state=merged&scope=all&order_by=merged_at&sort=desc&per_page=${input.limit}&page=${input.page}`
    : input.operation === "get"
      ? `${base}/${input.mergeRequestIid}`
      : `${base}/${input.mergeRequestIid}/diffs?per_page=${input.limit}&page=${input.page}`;
}

/**
 * Classify a non-zero `glab` exit into one shared code.
 *
 * Partial API response bodies are repository evidence, not transport
 * diagnostics. MR text can contain words such as ECONNREFUSED or 401.
 */
export function classifyGitLabReadFailure(result: {
  readonly exitCode: number;
  readonly stderr?: string;
  readonly failure?: string;
}): MergedMrFailureCodeV1 {
  if (result.failure === "output-limit") return "response";
  if (result.failure === "timeout") return "timeout";
  const category = classifyGlabCommandFailure({
    exitCode: result.exitCode,
    stderr: result.stderr,
    kind: "api",
  });
  if (category === "unauthenticated") return "authentication";
  if (category === "unreachable") return "network";
  if (/\b403\b/u.test(result.stderr ?? "")) return "access";
  return "request";
}

/** The projected read result, in the exact envelope the confined tool returns. */
export interface GitLabMrEvidenceV1 {
  readonly project: string;
  readonly operation: GitLabMrReadOperationV1;
  readonly pageSize?: number;
  readonly iid?: number;
  readonly items: readonly Record<string, unknown>[];
  readonly truncated: boolean;
  readonly nextPage: number | null;
}

/**
 * Read one page of merge-request evidence and project it.
 *
 * Admission is the caller's job. This fails closed on every unusable answer,
 * retains no upstream error text, and screens the result for credential-shaped
 * bytes before returning it.
 */
export async function readGitLabMrEvidence(input: {
  readonly operation: GitLabMrReadOperationV1;
  readonly host: string;
  readonly projectPath: string;
  readonly mergeRequestIid?: number;
  readonly limit: number;
  readonly page: number;
  readonly repositoryPath: string;
  readonly commands: CommandRunner;
  readonly environment: NodeJS.ProcessEnv;
}): Promise<GitLabMrEvidenceV1> {
  const { operation, limit, page } = input;
  const endpoint = gitlabMrReadEndpoint({
    operation,
    projectPath: input.projectPath,
    ...(input.mergeRequestIid === undefined ? {} : { mergeRequestIid: input.mergeRequestIid }),
    limit,
    page,
  });
  // glab reads its own login. Never inspect a token/config file or echo command stderr.
  const result = await input.commands
    .run(
      "glab",
      ["api", "--hostname", input.host, "--method", "GET", endpoint],
      input.repositoryPath,
      { env: input.environment },
    )
    .catch(() => failGitLabSourceProvider("request"));
  if (result.exitCode !== 0) failGitLabSourceProvider(classifyGitLabReadFailure(result));
  let parsed: unknown;
  try {
    if (Buffer.byteLength(result.stdout) > GITLAB_READ_BODY_LIMIT_BYTES) throw new Error();
    parsed = JSON.parse(result.stdout);
  } catch {
    failGitLabSourceProvider("response");
  }
  const records = operation === "get" ? [parsed] : parsed;
  if (!Array.isArray(records) || records.length > (operation === "get" ? 1 : limit)) {
    failGitLabSourceProvider("response");
  }
  let truncated = false;
  const text = (value: unknown) => {
    if (value === null || value === undefined) return null;
    if (typeof value !== "string") failGitLabSourceProvider("response");
    truncated ||= value.length > GITLAB_READ_TEXT_LIMIT;
    return value.slice(0, GITLAB_READ_TEXT_LIMIT);
  };
  const items = records.map((record) => {
    if (!record || typeof record !== "object" || Array.isArray(record))
      failGitLabSourceProvider("response");
    const item = record as Record<string, unknown>;
    if (operation === "diffs") {
      return {
        oldPath: text(item.old_path),
        newPath: text(item.new_path),
        diff: text(item.diff),
        collapsed: item.collapsed === true,
        tooLarge: item.too_large === true,
        newFile: item.new_file === true,
        deletedFile: item.deleted_file === true,
        renamedFile: item.renamed_file === true,
      };
    }
    if (
      !integer(item.iid, Number.MAX_SAFE_INTEGER) ||
      (operation === "get" && item.iid !== input.mergeRequestIid) ||
      (operation === "list_merged" &&
        (item.state !== "merged" ||
          typeof item.merged_at !== "string" ||
          !Number.isFinite(Date.parse(item.merged_at))))
    ) {
      failGitLabSourceProvider("response");
    }
    return {
      iid: item.iid,
      url: `https://${input.host}/${input.projectPath}/-/merge_requests/${item.iid}`,
      title: text(item.title),
      ...(operation === "get" ? { description: text(item.description) } : {}),
      state: text(item.state),
      mergedAt: text(item.merged_at),
      targetBranch: text(item.target_branch),
      sourceBranch: text(item.source_branch),
      mergeCommitSha: text(item.merge_commit_sha),
      squashCommitSha: text(item.squash_commit_sha),
    };
  });
  const evidence: GitLabMrEvidenceV1 = {
    project: `${input.host}/${input.projectPath}`,
    operation,
    ...(operation !== "get" ? { pageSize: limit } : {}),
    ...(operation !== "list_merged" ? { iid: input.mergeRequestIid } : {}),
    items,
    truncated,
    nextPage: operation !== "get" && records.length === limit ? Number(page) + 1 : null,
  };
  try {
    assertConfinedToolResultCredentialFree(evidence);
  } catch {
    failGitLabSourceProvider("credentials");
  }
  return evidence;
}

/**
 * Narrow a projected row to the producer's projection contract.
 *
 * `textTruncated` is required so a new reader cannot omit it; passing `false`
 * after a clip would make partial evidence look whole.
 */
function asProjection(row: Record<string, unknown>, textTruncated: boolean): GitLabMrProjectionV1 {
  if (!integer(row.iid, Number.MAX_SAFE_INTEGER) || typeof row.url !== "string") {
    failGitLabSourceProvider("response");
  }
  const optional = (value: unknown): string | null =>
    value === null || value === undefined
      ? null
      : typeof value === "string"
        ? value
        : failGitLabSourceProvider("response");
  return Object.freeze({
    iid: row.iid,
    url: row.url,
    title: optional(row.title),
    description: optional(row.description),
    state: optional(row.state),
    mergedAt: optional(row.mergedAt),
    targetBranch: optional(row.targetBranch),
    sourceBranch: optional(row.sourceBranch),
    mergeCommitSha: optional(row.mergeCommitSha),
    squashCommitSha: optional(row.squashCommitSha),
    textTruncated,
  });
}

/**
 * The shipped reader: one `get` read per selected merge request, because `get`
 * is the only operation whose projection carries the description the producer binds.
 */
export function createGitLabMrReadSourceReader(input: {
  readonly host: string;
  readonly projectPath: string;
  readonly repositoryPath: string;
  readonly commands: CommandRunner;
  readonly environment: NodeJS.ProcessEnv;
}): GitLabMrSourceReaderV1 {
  return {
    async readMergeRequest(mergeRequestIid: number): Promise<GitLabMrProjectionV1 | undefined> {
      if (!integer(mergeRequestIid, Number.MAX_SAFE_INTEGER)) failGitLabSourceProvider("request");
      const evidence = await readGitLabMrEvidence({
        operation: "get",
        host: input.host,
        projectPath: input.projectPath,
        mergeRequestIid,
        limit: 1,
        page: 1,
        repositoryPath: input.repositoryPath,
        commands: input.commands,
        environment: input.environment,
      });
      const row = evidence.items[0];
      // The only record that a field was clipped; dropping it would bind an
      // over-limit description as if it were complete.
      return row === undefined ? undefined : asProjection(row, evidence.truncated);
    },
  };
}

/**
 * A reader that walks an injected `list_merged` page port, bounded by
 * `maxPages`, and stops at the first page carrying the requested number.
 *
 * A port rejection keeps its shared code and loses its message. `list_merged`
 * need not carry `description`, so this can yield `description: null`; CLI
 * runs use `createGitLabMrReadSourceReader` instead.
 */
export function createGitLabMrPageSourceReader(input: {
  readonly port: MergedMrPagePortV1;
  readonly maxPages?: number;
}): GitLabMrSourceReaderV1 {
  const maxPages = input.maxPages ?? 50;
  if (!Number.isSafeInteger(maxPages) || maxPages <= 0) {
    throw new Error(
      `A GitLab merge-request page reader requires a positive integer page ceiling before it reads any page. Received: ${JSON.stringify(input.maxPages)}.`,
    );
  }
  return {
    async readMergeRequest(mergeRequestIid: number): Promise<GitLabMrProjectionV1 | undefined> {
      if (!integer(mergeRequestIid, Number.MAX_SAFE_INTEGER)) failGitLabSourceProvider("request");
      let page: number | null = 1;
      let pagesRead = 0;
      while (page !== null && pagesRead < maxPages) {
        const requested: number = page;
        let fetched: Awaited<ReturnType<MergedMrPagePortV1["fetchPage"]>>;
        try {
          fetched = await input.port.fetchPage(requested);
        } catch (error) {
          failGitLabSourceProvider(failureCodeOf(error));
        }
        if (!fetched || !Array.isArray(fetched.items)) failGitLabSourceProvider("response");
        pagesRead += 1;
        // The port reports truncation per page, so this can flag an unclipped
        // row. Over-reporting a gap is acceptable; under-reporting is not.
        const pageTruncated = fetched.truncated === true;
        for (const item of fetched.items) {
          if (item?.iid !== mergeRequestIid) continue;
          return asProjection(
            {
              iid: item.iid,
              url: item.url ?? "",
              title: item.title ?? null,
              description: item.description ?? null,
              state: item.state ?? null,
              mergedAt: item.mergedAt ?? null,
              targetBranch: item.targetBranch ?? null,
              sourceBranch: item.sourceBranch ?? null,
              mergeCommitSha: item.mergeCommitSha ?? null,
              squashCommitSha: item.squashCommitSha ?? null,
            },
            pageTruncated,
          );
        }
        const next = fetched.nextPage ?? null;
        if (next !== null && (!Number.isSafeInteger(next) || next <= requested)) {
          failGitLabSourceProvider("response");
        }
        page = next;
      }
      return undefined;
    },
  };
}

// ---------------------------------------------------------------------------
// Acquisition scope. The read dereferences `projectPath` while the sealed
// locator is keyed on `projectId`, so an unchecked `{projectId: A, projectPath:
// B}` would read B and cite it under A, undetectably. An acquisition scope must
// have its pair proved, and its reader is built from that proved scope.
// ---------------------------------------------------------------------------

/**
 * Runtime proof that a scope's id and path were checked against each other.
 *
 * Membership rather than a symbol property, because a proved scope escapes on
 * `AcquiredGitLabMrSourceBindingV1.scope` and a symbol key could be copied onto
 * another scope. A cloned or deserialized scope is refused and must be resolved again.
 */
const PROVED_ACQUISITION_SCOPES = new WeakSet<object>();

/**
 * A discovery scope whose two identities were proved to name one project.
 *
 * The `provedAcquisitionScope` brand rejects a plain discovery scope at compile
 * time; `PROVED_ACQUISITION_SCOPES` membership rejects a cast, literal, or clone
 * at runtime. Only `resolveGitLabAcquisitionScope` mints one.
 */
export interface GitLabAcquisitionScopeV1 extends SourceDiscoveryScopeV1 {
  readonly projectPath: string;
  readonly provedAcquisitionScope: true;
}

/** The only place the brand and runtime proof are applied. */
function brandAcquisitionScope(scope: SourceDiscoveryScopeV1): GitLabAcquisitionScopeV1 {
  if (typeof scope.projectPath !== "string" || scope.projectPath.length === 0) {
    // No id-to-path lookup exists here, and defaulting a path would allow the
    // project substitution this module prevents.
    failSourceDiscovery("scope-identity");
  }
  const proved = Object.freeze({
    ...scope,
    projectPath: scope.projectPath,
    provedAcquisitionScope: true as const,
  }) as GitLabAcquisitionScopeV1;
  PROVED_ACQUISITION_SCOPES.add(proved);
  return proved;
}

/**
 * Re-check a proved scope's shape and runtime proof at an acquisition entry
 * point. It upgrades nothing; an unproved or cast scope is refused.
 */
export function assertGitLabAcquisitionScope(
  scope: GitLabAcquisitionScopeV1,
): GitLabAcquisitionScopeV1 {
  const checked = requireSourceDiscoveryScope(scope);
  if (typeof checked.projectPath !== "string" || checked.projectPath.length === 0) {
    failSourceDiscovery("scope-identity");
  }
  if (!PROVED_ACQUISITION_SCOPES.has(scope)) {
    // Not the object this module proved; its id and path may name two projects.
    failSourceDiscovery("scope-identity");
  }
  return scope;
}

/**
 * Resolve an operator reference into a scope whose id and path are proved to
 * name the same project.
 *
 * Unlike discovery, the path is always resolved through the identity port, and
 * a supplied id must match the resolved one (`out-of-scope-locator` otherwise).
 * An id-only reference is refused because there is no path to read.
 */
export async function resolveGitLabAcquisitionScope(input: {
  readonly reference: unknown;
  readonly identityPort?: GitLabProjectIdentityPortV1;
}): Promise<GitLabAcquisitionScopeV1> {
  const reference = parseGitLabProjectReference(input?.reference);
  if (reference.kind === "project-id" && reference.projectPath === null) {
    failSourceDiscovery("scope-identity");
  }
  const projectPath =
    reference.kind === "project-path" ? reference.projectPath : (reference.projectPath as string);
  const resolved = await resolveGitLabSourceScope({
    reference: { host: reference.host, projectPath },
    ...(input?.identityPort ? { identityPort: input.identityPort } : {}),
  });
  if (reference.kind === "project-id" && resolved.projectId !== reference.projectId) {
    // Preferring either id would silently rewrite half of the operator's request.
    failSourceDiscovery("out-of-scope-locator");
  }
  return brandAcquisitionScope(resolved);
}

/**
 * Build a merge-request reader for one proved acquisition scope; taking the
 * scope, not a host/path pair, keeps the reader on the scope's project.
 */
export type GitLabMrSourceReaderFactoryV1 = (
  scope: GitLabAcquisitionScopeV1,
) => GitLabMrSourceReaderV1;

/** The shipped factory: a `get`-backed reader bound to the scope's project. */
export function gitlabMrSourceReaderFactory(transport: {
  readonly repositoryPath: string;
  readonly commands: CommandRunner;
  readonly environment: NodeJS.ProcessEnv;
}): GitLabMrSourceReaderFactoryV1 {
  return (scope: GitLabAcquisitionScopeV1) =>
    createGitLabMrReadSourceReader({
      host: scope.host,
      projectPath: scope.projectPath,
      repositoryPath: transport.repositoryPath,
      commands: transport.commands,
      environment: transport.environment,
    });
}

/**
 * Identity port for any GitLab project on any host, unlike
 * `createGitLabCheckoutIdentityPort`, which answers only for the checkout's own remote.
 */
export function createGitLabProjectIdentityPort(transport: {
  readonly repositoryPath: string;
  readonly commands: CommandRunner;
  readonly environment: NodeJS.ProcessEnv;
}): GitLabProjectIdentityPortV1 {
  return {
    async resolveProjectIdentity(reference) {
      const result = await transport.commands
        .run(
          "glab",
          [
            "api",
            "--hostname",
            reference.host,
            "--method",
            "GET",
            `projects/${encodeURIComponent(reference.projectPath)}`,
          ],
          transport.repositoryPath,
          { env: transport.environment },
        )
        .catch(() => failGitLabSourceProvider("request"));
      if (result.exitCode !== 0) failGitLabSourceProvider(classifyGitLabReadFailure(result));
      let parsed: unknown;
      try {
        if (Buffer.byteLength(result.stdout) > GITLAB_READ_BODY_LIMIT_BYTES) throw new Error();
        parsed = JSON.parse(result.stdout);
      } catch {
        failGitLabSourceProvider("response");
      }
      const body = parsed as { id?: unknown; path_with_namespace?: unknown } | null;
      const id = body?.id;
      if (!integer(id, Number.MAX_SAFE_INTEGER)) failGitLabSourceProvider("response");
      // GitLab matches paths case-insensitively but stores one canonical
      // spelling; returning it keeps two spellings of one project from becoming
      // two producer scopes. Any difference beyond case means another project.
      const canonical = body?.path_with_namespace;
      if (canonical !== undefined && typeof canonical !== "string") {
        failGitLabSourceProvider("response");
      }
      if (
        typeof canonical === "string" &&
        canonical.toLowerCase() !== reference.projectPath.toLowerCase()
      ) {
        failGitLabSourceProvider("response");
      }
      return {
        host: reference.host,
        projectId: id,
        projectPath: typeof canonical === "string" ? canonical : reference.projectPath,
      };
    },
  };
}
