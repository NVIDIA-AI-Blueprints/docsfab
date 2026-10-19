// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Confined git history tools: show a file at a revision, diff two revisions,
 * walk commits, search commits for a string, and blame a line range.
 *
 * They exist only for the planner and writer skills, and only when the host
 * handed the step a repository workspace whose source checkout holds the
 * history; the hosted runtime's depth-1 private copy gets no reader. Every
 * revision must be the pinned head or one of its ancestors. A model never
 * names a ref, range expression, option or pathspec: revisions are hex ids
 * or `head`, paths are literal, and credential-bearing paths stay out of
 * arguments and output alike. Each served page is masked for this host's
 * roots and screened for configured credentials, and the host records what
 * it served, with a digest of the exact bytes, as a citation.
 */
import { createHash, randomUUID } from "node:crypto";

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import {
  limit,
  OperationalLimitError,
  refuseLimit,
  type ResolveLimitsOptions,
  type ResolvedLimit,
} from "../config/limits.js";
import type {
  HistoryReadCitationV1,
  HistoryReadLabel,
  HistoryReadRangeV1,
  HistoryToolName,
  ToolArgumentFillerKind,
  ToolFailureCategory,
  ToolRefusalArgumentKey,
  ToolRefusalCode,
  ToolRefusalDetailKind,
  ToolRefusalIdArgument,
  ToolRefusalIdMatch,
} from "../records/contracts.js";
import { TOOL_REFUSAL_ARGUMENT_KEYS } from "../records/contracts.js";
import {
  failGitHistory,
  GitHistoryError,
  GitHistoryReader,
  HEAD_REVISION_ALIAS,
  type HistoryBlameLine,
} from "../repository/git-history.js";
import type { RepositoryWorkspace } from "../repository/workspace/contracts.js";
import { isExportExcluded } from "../repository/workspace/export-exclusion.js";
import { CredentialBoundaryError } from "../security/credential-isolation.js";
import { egressText, type HostRootSet } from "../security/egress.js";
import { declaredToolArguments, fillerKind, processHostRoots } from "./source-tools.js";
import {
  idMatchEntries,
  isPlainRecord,
  toolArgumentKeys,
  type ToolArgumentFillerRecorder,
  type ToolRefusalRecorder,
} from "./tool-refusals.js";

type AnyToolDefinition = ToolDefinition<any, any, any>;

export const HISTORY_BLAME_TOOL_NAME = "docsfab_history_blame" as const;
export const HISTORY_SHOW_TOOL_NAME = "docsfab_history_show" as const;
export const HISTORY_DIFF_TOOL_NAME = "docsfab_history_diff" as const;
export const HISTORY_LOG_TOOL_NAME = "docsfab_history_log" as const;
export const HISTORY_SEARCH_TOOL_NAME = "docsfab_history_search" as const;
/** Granted together, only by a live history reader. */
export const HISTORY_TOOL_NAMES = [
  HISTORY_BLAME_TOOL_NAME,
  HISTORY_DIFF_TOOL_NAME,
  HISTORY_LOG_TOOL_NAME,
  HISTORY_SEARCH_TOOL_NAME,
  HISTORY_SHOW_TOOL_NAME,
] as const satisfies readonly HistoryToolName[];

const HISTORY_TOOL_NAME_SET: ReadonlySet<string> = new Set(HISTORY_TOOL_NAMES);

export function isHistoryToolName(name: string): name is HistoryToolName {
  return HISTORY_TOOL_NAME_SET.has(name);
}

/** The skills that research a change: the planner and the writer. */
export const HISTORY_READ_SKILLS: ReadonlySet<string> = new Set([
  "plan-documentation",
  "write-documentation",
]);

/** Declared in `config/limits/gitHistory.yaml`. */
export const GIT_HISTORY_LOG_MAX_ENTRIES_LIMIT = "gitHistory.logMaxEntries" as const;
export const GIT_HISTORY_RESPONSE_MAX_BYTES_LIMIT = "gitHistory.responseMaxBytes" as const;
export const GIT_HISTORY_PATHS_MAX_PER_CALL_LIMIT = "gitHistory.pathsMaxPerCall" as const;
export const GIT_HISTORY_CURSORS_MAX_PER_TOOL_SET_LIMIT =
  "gitHistory.cursorsMaxPerToolSet" as const;
export const GIT_HISTORY_BLAME_MAX_LINES_LIMIT = "gitHistory.blameMaxLines" as const;
export const GIT_HISTORY_PICKAXE_MAX_COMMITS_SCANNED_LIMIT =
  "gitHistory.pickaxeMaxCommitsScanned" as const;
export const GIT_HISTORY_SEARCH_NEEDLE_MAX_BYTES_LIMIT = "gitHistory.searchNeedleMaxBytes" as const;

const CURSOR_PREFIX = "hc-";

/**
 * The one grant predicate: a history reader for this step, or none. Both the
 * tool registration and the step's granted tool list read its answer. A sealed
 * tool ceiling that omits any of the tools, as a hosted composition's does,
 * builds no reader, so the tools are granted together or not at all and the
 * history bounds are never checked for tools no session sees.
 */
export function historyReaderForStep(
  step: { readonly skill: string },
  workspace: Pick<RepositoryWorkspace, "sourcePath" | "revision"> | undefined,
  toolCeiling?: readonly string[],
  limits?: ResolveLimitsOptions,
): GitHistoryReader | undefined {
  if (!workspace || !HISTORY_READ_SKILLS.has(step.skill)) return undefined;
  if (toolCeiling && !HISTORY_TOOL_NAMES.every((name) => toolCeiling.includes(name))) {
    return undefined;
  }
  return new GitHistoryReader({
    sourcePath: workspace.sourcePath,
    headRevision: workspace.revision,
    ...(limits ? { limits } : {}),
  });
}

export interface GitHistoryLimits {
  readonly logMaxEntries: ResolvedLimit;
  readonly responseMaxBytes: ResolvedLimit;
  readonly pathsMaxPerCall: ResolvedLimit;
  readonly cursorsMaxPerToolSet: ResolvedLimit;
  readonly blameMaxLines: ResolvedLimit;
  readonly pickaxeMaxCommitsScanned: ResolvedLimit;
  readonly searchNeedleMaxBytes: ResolvedLimit;
}

/** `gitHistory.responseMaxBytes` above the per-call tool output cap, refused when the tools are built. */
export class GitHistoryLimitConfigurationError extends Error {
  public readonly code: string;

  public constructor(response: ResolvedLimit, capBytes: number) {
    super(
      `${response.refusal}: ${response.name} is ${String(response.value)} ${response.unit}, above the per-call tool output cap of ${String(capBytes)} bytes. ${response.remediation}`,
    );
    this.name = "GitHistoryLimitConfigurationError";
    this.code = response.refusal;
  }
}

/**
 * Resolve the history bounds when the tool set is built, so an invalid host
 * override, or a page bound the tool output cap cannot carry, refuses before
 * any provider turn.
 */
export function resolveGitHistoryLimits(
  capBytes: number,
  options?: ResolveLimitsOptions,
): GitHistoryLimits {
  const limits = {
    logMaxEntries: limit(GIT_HISTORY_LOG_MAX_ENTRIES_LIMIT, options),
    responseMaxBytes: limit(GIT_HISTORY_RESPONSE_MAX_BYTES_LIMIT, options),
    pathsMaxPerCall: limit(GIT_HISTORY_PATHS_MAX_PER_CALL_LIMIT, options),
    cursorsMaxPerToolSet: limit(GIT_HISTORY_CURSORS_MAX_PER_TOOL_SET_LIMIT, options),
    blameMaxLines: limit(GIT_HISTORY_BLAME_MAX_LINES_LIMIT, options),
    pickaxeMaxCommitsScanned: limit(GIT_HISTORY_PICKAXE_MAX_COMMITS_SCANNED_LIMIT, options),
    searchNeedleMaxBytes: limit(GIT_HISTORY_SEARCH_NEEDLE_MAX_BYTES_LIMIT, options),
  };
  if (limits.responseMaxBytes.value > capBytes) {
    throw new GitHistoryLimitConfigurationError(limits.responseMaxBytes, capBytes);
  }
  return limits;
}

export interface HistoryToolOptions {
  readonly reader: GitHistoryReader;
  readonly recordFailure: (category: ToolFailureCategory) => void;
  /** Receives one content-free row per refused call; see `harness/tool-refusals.ts`. */
  readonly recordRefusal?: ToolRefusalRecorder;
  /** Receives each argument a call sent as filler, content-free. */
  readonly recordFiller?: ToolArgumentFillerRecorder;
  /** The effective per-call tool output cap the page bound must fit under. */
  readonly toolOutputCapBytes: number;
  readonly limits?: ResolveLimitsOptions;
  /** This host's roots, replaced in every page; defaults to `processHostRoots(workspaceRoots)`. */
  readonly hostRoots?: HostRootSet;
  readonly workspaceRoots?: readonly string[];
}

export function createHistoryToolDefinitions(options: HistoryToolOptions): AnyToolDefinition[] {
  const limits = resolveGitHistoryLimits(options.toolOutputCapBytes, options.limits);
  const context: HistoryContext = {
    reader: options.reader,
    limits,
    cursors: new HistoryCursorStore(limits.cursorsMaxPerToolSet),
    hostRoots: options.hostRoots ?? processHostRoots(options.workspaceRoots),
  };
  return [
    blameTool(context),
    diffTool(context),
    logTool(context),
    searchTool(context),
    showTool(context),
  ].map((definition) =>
    wrapHistoryExecute(
      withoutHistoryFiller(definition, options.recordFiller),
      options.recordFailure,
      options.recordRefusal,
      options.reader,
    ),
  );
}

interface HistoryContext {
  readonly reader: GitHistoryReader;
  readonly limits: GitHistoryLimits;
  readonly cursors: HistoryCursorStore;
  readonly hostRoots: HostRootSet;
}

type CursorState =
  | {
      readonly tool: typeof HISTORY_BLAME_TOOL_NAME;
      readonly revision: string;
      readonly path: string;
      readonly startLine: number;
      readonly endLine: number;
      readonly nextLine: number;
    }
  | {
      readonly tool: typeof HISTORY_SHOW_TOOL_NAME;
      readonly revision: string;
      readonly path: string;
      readonly offset: number;
    }
  | {
      readonly tool: typeof HISTORY_DIFF_TOOL_NAME;
      readonly base: string;
      readonly head: string;
      readonly paths: readonly string[];
      readonly fileIndex: number;
      readonly offset: number;
    }
  | {
      readonly tool: typeof HISTORY_LOG_TOOL_NAME;
      readonly to: string;
      readonly from: string | null;
      readonly path: string | null;
      readonly offset: number;
    }
  | {
      readonly tool: typeof HISTORY_SEARCH_TOOL_NAME;
      /** Kept host-side only; no page, citation or refusal carries it. */
      readonly needle: string;
      readonly to: string;
      readonly from: string | null;
      readonly paths: readonly string[];
      /** Commits of the walk scanned by earlier windows. */
      readonly scanOffset: number;
      /** The window's next match to serve, after exclusion. */
      readonly matchIndex: number;
      /** That match's next path to serve. */
      readonly pathIndex: number;
    };

/**
 * Continuation state the host keeps for one tool set. A model sees only an
 * opaque random handle; the revisions, paths and offset it stands for never
 * leave the host, so a cursor cannot be edited into a read the arguments
 * would have refused.
 */
class HistoryCursorStore {
  private readonly byHandle = new Map<string, CursorState>();
  private readonly byState = new Map<string, string>();

  public constructor(private readonly bound: ResolvedLimit) {}

  /** The same page asked again gets the same handle. */
  public issue(state: CursorState): string {
    const key = JSON.stringify(state);
    const existing = this.byState.get(key);
    if (existing) return existing;
    if (this.byHandle.size >= this.bound.value) refuseLimit(this.bound, this.byHandle.size + 1);
    const handle = newCursorHandle();
    this.byHandle.set(handle, state);
    this.byState.set(key, handle);
    return handle;
  }

  public resolve<T extends CursorState["tool"]>(
    handle: unknown,
    tool: T,
  ): Extract<CursorState, { tool: T }> {
    const state = typeof handle === "string" ? this.byHandle.get(handle) : undefined;
    if (!state || state.tool !== tool) failGitHistory("history-cursor-invalid");
    return state as Extract<CursorState, { tool: T }>;
  }
}

function newCursorHandle(): string {
  return `${CURSOR_PREFIX}${randomUUID().replaceAll("-", "")}`;
}

/** What one served page cites, before the host digests the bytes the model received. */
type HistoryReadDraft = Omit<HistoryReadCitationV1, "sha256">;

/**
 * The attempt's history citations. It wraps each history tool outside the
 * result screen, so a result the screen refused is never cited, and digests
 * the exact text the model receives.
 */
export class HistoryReadLedger {
  private readonly entries: HistoryReadCitationV1[] = [];

  public observe<T extends AnyToolDefinition>(definition: T): T {
    const execute = definition.execute.bind(definition) as (...arguments_: any[]) => Promise<any>;
    const entries = this.entries;
    return {
      ...definition,
      async execute(...arguments_: any[]) {
        const result = await execute(...arguments_);
        const draft = (result as { details?: { historyRead?: HistoryReadDraft } } | undefined)
          ?.details?.historyRead;
        if (draft) {
          const text = (result.content as Array<{ type: string; text?: string }>)
            .map((part) => (part.type === "text" ? (part.text ?? "") : ""))
            .join("");
          entries.push({ ...structuredClone(draft), sha256: sha256Hex(text) });
        }
        return result;
      },
    };
  }

  public snapshot(): HistoryReadCitationV1[] | undefined {
    return this.entries.length === 0 ? undefined : structuredClone(this.entries);
  }
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

const REVISION_DESCRIPTION = `"${HEAD_REVISION_ALIAS}" for this run's pinned revision, or a lowercase hex commit id (full or abbreviated) that is the pinned revision or one of its ancestors`;
const PATH_DESCRIPTION =
  "Repository-relative file path, taken literally (no globs or pathspec magic)";
const CURSOR_DESCRIPTION =
  "nextCursor from this tool's previous page, to continue it; other arguments may be omitted, and any you send must match that page's";

function showTool(context: HistoryContext): AnyToolDefinition {
  return {
    name: HISTORY_SHOW_TOOL_NAME,
    label: "Show a file at a revision",
    description:
      "Return the text of one repository file as it was at a revision of this run's history, " +
      "such as the comparison base, to read the old behavior a change replaced. The page " +
      "names the full commit id and the byte range it returns; a larger file continues " +
      "with nextCursor. Labels report a partial clone. History tools never fetch, run " +
      "repository code, or read outside the pinned revision's history.",
    promptSnippet: "Show a repository file as it was at an earlier revision",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: [],
      properties: {
        path: { type: "string", description: PATH_DESCRIPTION },
        revision: { type: "string", description: REVISION_DESCRIPTION },
        cursor: { type: "string", description: CURSOR_DESCRIPTION },
      },
    },
    async execute(_id: unknown, rawParams: unknown) {
      const params = argumentRecord(rawParams, ["path", "revision", "cursor"]);
      let revision: string;
      let path: string;
      let offset = 0;
      if (params.cursor !== undefined) {
        const state = context.cursors.resolve(params.cursor, HISTORY_SHOW_TOOL_NAME);
        if (params.path !== undefined && historyPath(params.path) !== state.path) {
          failGitHistory("history-cursor-invalid");
        }
        if (
          params.revision !== undefined &&
          (await context.reader.resolveRevision(params.revision)) !== state.revision
        ) {
          failGitHistory("history-cursor-invalid");
        }
        await context.reader.assertInScope(state.revision);
        ({ revision, path, offset } = state);
      } else {
        if (params.path === undefined || params.revision === undefined) {
          failGitHistory("history-arguments-invalid");
        }
        path = historyPath(params.path);
        revision = await context.reader.resolveRevision(params.revision);
      }
      const blob = await context.reader.readFile(revision, path);
      const text = maskedText(utf8Text(blob.bytes), context.hostRoots);
      const labels = await baseLabels(context.reader);
      const totalBytes = Buffer.byteLength(text, "utf8");
      const startByte = Buffer.byteLength(text.slice(0, offset), "utf8");
      const render = (chunk: string, end: number, nextCursor: string | null) =>
        JSON.stringify({
          kind: "docsfab-history-show",
          revision,
          path,
          byteRange: { start: startByte, end },
          totalBytes,
          labels,
          nextCursor,
          text: chunk,
        });
      // The rest of the file in one page when it fits with no cursor; otherwise
      // the envelope is sized with a cursor, since one will be owed.
      const end =
        byteLength(render(text.slice(offset), totalBytes, null)) <=
        context.limits.responseMaxBytes.value
          ? text.length
          : pageEnd(
              text,
              offset,
              context.limits.responseMaxBytes,
              byteLength(render("", totalBytes, newCursorHandle())),
            );
      const chunk = text.slice(offset, end);
      const endByte = startByte + byteLength(chunk);
      const nextCursor =
        end < text.length
          ? context.cursors.issue({ tool: HISTORY_SHOW_TOOL_NAME, revision, path, offset: end })
          : null;
      return historyResult(context, render(chunk, endByte, nextCursor), {
        tool: HISTORY_SHOW_TOOL_NAME,
        revisions: [revision],
        paths: [path],
        ranges: [{ path, unit: "bytes", start: startByte, end: endByte }],
        labels,
        ...cursorFields(params.cursor, nextCursor),
      });
    },
  };
}

function diffTool(context: HistoryContext): AnyToolDefinition {
  const pathsBound = context.limits.pathsMaxPerCall;
  return {
    name: HISTORY_DIFF_TOOL_NAME,
    label: "Diff two revisions",
    description:
      "Return the unified diff between two revisions of this run's history, file by file, " +
      "such as the comparison base and head of the change being documented. A page lists " +
      "whole files while they fit and continues with nextCursor; a large file is split " +
      "across pages. Credential-bearing and generated paths are left out and counted " +
      "under the history-paths-excluded label, and a file whose patch holds a configured " +
      "credential is listed as withheld without its patch.",
    promptSnippet: "Diff two revisions of the repository, optionally only some paths",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: [],
      properties: {
        base: { type: "string", description: `Older revision: ${REVISION_DESCRIPTION}` },
        head: { type: "string", description: `Newer revision: ${REVISION_DESCRIPTION}` },
        paths: {
          type: "array",
          description: "Optional repository-relative files or directories to limit the diff to",
          items: { type: "string" },
          maxItems: pathsBound.value,
        },
        cursor: { type: "string", description: CURSOR_DESCRIPTION },
      },
    },
    async execute(_id: unknown, rawParams: unknown) {
      const params = argumentRecord(rawParams, ["base", "head", "paths", "cursor"]);
      const requested =
        params.paths === undefined ? undefined : historyPaths(params.paths, pathsBound);
      let base: string;
      let head: string;
      let paths: readonly string[];
      let fileIndex = 0;
      let offset = 0;
      if (params.cursor !== undefined) {
        const state = context.cursors.resolve(params.cursor, HISTORY_DIFF_TOOL_NAME);
        if (
          (params.base !== undefined &&
            (await context.reader.resolveRevision(params.base)) !== state.base) ||
          (params.head !== undefined &&
            (await context.reader.resolveRevision(params.head)) !== state.head) ||
          (requested !== undefined && JSON.stringify(requested) !== JSON.stringify(state.paths))
        ) {
          failGitHistory("history-cursor-invalid");
        }
        await context.reader.assertInScope(state.base);
        await context.reader.assertInScope(state.head);
        ({ base, head, paths, fileIndex, offset } = state);
      } else {
        if (params.base === undefined || params.head === undefined) {
          failGitHistory("history-arguments-invalid");
        }
        base = await context.reader.resolveRevision(params.base);
        head = await context.reader.resolveRevision(params.head);
        paths = requested ?? [];
      }
      // Enumerate first so credential-bearing paths never reach git's patch
      // output; literal pathspecs leave no exclude magic to lean on.
      const changed = await context.reader.changedPaths(base, head, paths);
      const admitted = changed.filter((path) => !isExportExcluded(path));
      const excludedFiles = changed.length - admitted.length;
      const labels: HistoryReadLabel[] = [
        ...(await baseLabels(context.reader)),
        ...(excludedFiles > 0 ? (["history-paths-excluded"] as const) : []),
      ];
      type DiffFile =
        | {
            path: string;
            byteRange: { start: number; end: number };
            totalBytes: number;
            patch: string;
          }
        | { path: string | null; withheld: true };
      const files: DiffFile[] = [];
      const ranges: HistoryReadRangeV1[] = [];
      const render = (pageFiles: readonly DiffFile[], end: number, nextCursor: string | null) =>
        JSON.stringify({
          kind: "docsfab-history-diff",
          base,
          head,
          changedFiles: admitted.length,
          excludedFiles,
          fileRange: { start: fileIndex, end },
          labels,
          nextCursor,
          files: pageFiles,
        });
      const placeholderCursor = newCursorHandle();
      let index = fileIndex;
      let next: { fileIndex: number; offset: number } | null = null;
      while (index < admitted.length) {
        if (files.length >= pathsBound.value) {
          next = { fileIndex: index, offset: 0 };
          break;
        }
        const path = admitted[index]!;
        const maskedPath = egressText(path, context.hostRoots);
        const patch = egressText(
          await context.reader.filePatch(base, head, path),
          context.hostRoots,
        );
        if (!maskedPath.ok || !patch.ok) {
          const withheld = {
            path: maskedPath.ok ? maskedPath.text : null,
            withheld: true as const,
          };
          if (
            byteLength(render([...files, withheld], admitted.length, placeholderCursor)) >
            context.limits.responseMaxBytes.value
          ) {
            if (files.length === 0) {
              refuseLimit(
                context.limits.responseMaxBytes,
                byteLength(render([withheld], admitted.length, placeholderCursor)),
              );
            }
            next = { fileIndex: index, offset: 0 };
            break;
          }
          files.push(withheld);
          index += 1;
          continue;
        }
        const start = files.length === 0 ? offset : 0;
        const totalBytes = byteLength(patch.text);
        const startByte = byteLength(patch.text.slice(0, start));
        const whole = {
          path: maskedPath.text,
          byteRange: { start: startByte, end: totalBytes },
          totalBytes,
          patch: patch.text.slice(start),
        };
        // The last file owes no cursor when it fits.
        const owed = index + 1 < admitted.length ? placeholderCursor : null;
        if (
          byteLength(render([...files, whole], admitted.length, owed)) <=
          context.limits.responseMaxBytes.value
        ) {
          files.push(whole);
          ranges.push({ path: whole.path, unit: "bytes", start: startByte, end: totalBytes });
          index += 1;
          continue;
        }
        if (files.length > 0) {
          next = { fileIndex: index, offset: 0 };
          break;
        }
        // One file larger than a page: serve the part that fits and continue it.
        const envelope = byteLength(
          render([{ ...whole, patch: "" }], admitted.length, placeholderCursor),
        );
        const end = pageEnd(patch.text, start, context.limits.responseMaxBytes, envelope);
        const chunk = patch.text.slice(start, end);
        const endByte = startByte + byteLength(chunk);
        files.push({ ...whole, byteRange: { start: startByte, end: endByte }, patch: chunk });
        ranges.push({ path: whole.path, unit: "bytes", start: startByte, end: endByte });
        if (end < patch.text.length) next = { fileIndex: index, offset: end };
        else if (index + 1 < admitted.length) next = { fileIndex: index + 1, offset: 0 };
        break;
      }
      const nextCursor = next
        ? context.cursors.issue({ tool: HISTORY_DIFF_TOOL_NAME, base, head, paths, ...next })
        : null;
      return historyResult(context, render(files, fileIndex + files.length, nextCursor), {
        tool: HISTORY_DIFF_TOOL_NAME,
        revisions: [base, head],
        paths: ranges.map((range) => range.path!),
        ranges,
        labels,
        ...(excludedFiles > 0 ? { excludedPathCount: excludedFiles } : {}),
        ...cursorFields(params.cursor, nextCursor),
      });
    },
  };
}

function logTool(context: HistoryContext): AnyToolDefinition {
  const entriesBound = context.limits.logMaxEntries;
  return {
    name: HISTORY_LOG_TOOL_NAME,
    label: "List commits",
    description:
      "List the commits of this run's history, newest first: full commit id, parent ids, " +
      "committer date and subject. Optionally only commits touching one path, or only those " +
      "in a range (reachable from range.to, default the pinned revision, and not from " +
      "range.from). A longer walk continues with nextCursor. A page that lists the cut of " +
      "a shallow clone, or ends a walk that reaches it, carries the history-shallow label: " +
      "older history exists but this checkout does not hold it.",
    promptSnippet: "List the commits that changed a path or a range of revisions",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: [],
      properties: {
        path: { type: "string", description: PATH_DESCRIPTION },
        range: {
          type: "object",
          additionalProperties: false,
          properties: {
            from: { type: "string", description: `Exclusive older end: ${REVISION_DESCRIPTION}` },
            to: { type: "string", description: `Inclusive newer end: ${REVISION_DESCRIPTION}` },
          },
        },
        cursor: { type: "string", description: CURSOR_DESCRIPTION },
      },
    },
    async execute(_id: unknown, rawParams: unknown) {
      const params = argumentRecord(rawParams, ["path", "range", "cursor"]);
      const range = params.range === undefined ? {} : argumentRecord(params.range, ["from", "to"]);
      const path = params.path === undefined ? null : historyPath(params.path);
      const to = await context.reader.resolveRevision(range.to ?? HEAD_REVISION_ALIAS);
      const from =
        range.from === undefined ? null : await context.reader.resolveRevision(range.from);
      let offset = 0;
      if (params.cursor !== undefined) {
        const state = context.cursors.resolve(params.cursor, HISTORY_LOG_TOOL_NAME);
        // An omitted argument takes the page's; a sent one must equal it.
        if (
          (range.to !== undefined && to !== state.to) ||
          (range.from !== undefined && from !== state.from) ||
          (params.path !== undefined && path !== state.path)
        ) {
          failGitHistory("history-cursor-invalid");
        }
        await context.reader.assertInScope(state.to);
        if (state.from) await context.reader.assertInScope(state.from);
        return logPage(context, state, params.cursor);
      }
      return logPage(context, { tool: HISTORY_LOG_TOOL_NAME, to, from, path, offset }, undefined);
    },
  };

  async function logPage(
    context: HistoryContext,
    state: Extract<CursorState, { tool: typeof HISTORY_LOG_TOOL_NAME }>,
    cursor: unknown,
  ) {
    // One more than a page says whether a cursor is owed, without a count walk.
    const fetched = await context.reader.log({
      to: state.to,
      ...(state.from ? { from: state.from } : {}),
      ...(state.path ? { path: state.path } : {}),
      skip: state.offset,
      count: entriesBound.value + 1,
    });
    const shallow = await context.reader.shallowCommits();
    // A path-limited walk can pass the cut without listing it, so the page
    // that ends the walk asks git whether the range reaches the cut at all.
    const endsAtCut =
      fetched.length <= entriesBound.value &&
      (await context.reader.reachesShallowCut(state.to, state.from ?? undefined));
    const entries = fetched.map((entry) => {
      const subject = egressText(entry.subject, context.hostRoots);
      return {
        commit: entry.commit,
        parents: entry.parents,
        committedAt: entry.committedAt,
        subject: subject.ok ? subject.text : null,
        ...(subject.ok ? {} : { subjectWithheld: true }),
      };
    });
    const labelsFor = (count: number): HistoryReadLabel[] => [
      ...((count === entries.length && endsAtCut) ||
      entries.slice(0, count).some((entry) => shallow.has(entry.commit))
        ? (["history-shallow"] as const)
        : []),
    ];
    const base = await baseLabels(context.reader);
    const render = (count: number, nextCursor: string | null) =>
      JSON.stringify({
        kind: "docsfab-history-log",
        range: { from: state.from, to: state.to },
        path: state.path,
        entryRange: { start: state.offset, end: state.offset + count },
        labels: [...labelsFor(count), ...base],
        nextCursor,
        entries: entries.slice(0, count),
      });
    let count = Math.min(entries.length, entriesBound.value);
    const placeholderCursor = newCursorHandle();
    const owed = (count: number) => (count < entries.length ? placeholderCursor : null);
    while (
      count > 0 &&
      byteLength(render(count, owed(count))) > context.limits.responseMaxBytes.value
    ) {
      count -= 1;
    }
    if (count === 0 && entries.length > 0) {
      refuseLimit(context.limits.responseMaxBytes, byteLength(render(1, owed(1))));
    }
    const nextCursor =
      count < entries.length
        ? context.cursors.issue({ ...state, offset: state.offset + count })
        : null;
    const labels = [...labelsFor(count), ...base];
    return historyResult(context, render(count, nextCursor), {
      tool: HISTORY_LOG_TOOL_NAME,
      revisions: state.from ? [state.from, state.to] : [state.to],
      paths: state.path ? [state.path] : [],
      ranges: [
        { path: state.path, unit: "entries", start: state.offset, end: state.offset + count },
      ],
      labels,
      ...cursorFields(cursor, nextCursor),
    });
  }
}

type SearchCursor = Extract<CursorState, { tool: typeof HISTORY_SEARCH_TOOL_NAME }>;

/** A lone UTF-16 surrogate: a string git would receive as invalid UTF-8. */
const LONE_SURROGATE = /\p{Cs}/u;

function searchTool(context: HistoryContext): AnyToolDefinition {
  const pathsBound = context.limits.pathsMaxPerCall;
  const needleBound = context.limits.searchNeedleMaxBytes;
  return {
    name: HISTORY_SEARCH_TOOL_NAME,
    label: "Search commits for a string",
    description:
      "Find the commits of this run's history that added or removed a literal string, such " +
      "as a symbol, option or message: each commit whose change alters how many times the " +
      "string occurs in a file (git's pickaxe). Newest first, each with its full commit id, " +
      "parent ids, committer date, subject and the files whose count changed. Optionally only " +
      "some paths, or only a range (reachable from range.to, default the pinned revision, and " +
      "not from range.from). The walk is scanned in windows of commits; each page names the " +
      "window it scanned and continues with nextCursor, even when the window matched nothing. " +
      "Merges never match. A match only in a credential-bearing or generated file is not " +
      "shown, and a window whose commits change such a file carries the " +
      "history-paths-excluded label whatever the string. A page whose window holds the cut " +
      "of a shallow clone, or that ends a walk reaching it, carries the history-shallow " +
      "label, and a match at the cut is flagged atShallowCut: it stands for every older " +
      "change this checkout does not hold.",
    promptSnippet: "Find the commits that added or removed a string, such as a symbol",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: [],
      properties: {
        needle: {
          type: "string",
          description: `The literal, non-empty, case-sensitive string to look for, matched as plain text (no regular expression, glob or option); at most ${String(needleBound.value)} UTF-8 bytes. Required unless cursor is sent.`,
        },
        range: {
          type: "object",
          additionalProperties: false,
          properties: {
            from: { type: "string", description: `Exclusive older end: ${REVISION_DESCRIPTION}` },
            to: { type: "string", description: `Inclusive newer end: ${REVISION_DESCRIPTION}` },
          },
        },
        paths: {
          type: "array",
          description:
            "Optional repository-relative files or directories to limit the search to, taken literally",
          items: { type: "string" },
          maxItems: pathsBound.value,
        },
        cursor: { type: "string", description: CURSOR_DESCRIPTION },
      },
    },
    async execute(_id: unknown, rawParams: unknown) {
      // Every argument is checked before git runs.
      const params = argumentRecord(rawParams, ["needle", "range", "paths", "cursor"]);
      const range = params.range === undefined ? {} : argumentRecord(params.range, ["from", "to"]);
      const needle =
        params.needle === undefined ? undefined : searchNeedle(params.needle, needleBound);
      const requested =
        params.paths === undefined ? undefined : historyPaths(params.paths, pathsBound);
      let state: SearchCursor;
      if (params.cursor !== undefined) {
        const saved = context.cursors.resolve(params.cursor, HISTORY_SEARCH_TOOL_NAME);
        // An omitted argument takes the page's; a sent one must equal it.
        if (
          (needle !== undefined && needle !== saved.needle) ||
          (requested !== undefined && JSON.stringify(requested) !== JSON.stringify(saved.paths))
        ) {
          failGitHistory("history-cursor-invalid");
        }
        await refusePartialClone(context.reader);
        if (
          (range.to !== undefined &&
            (await context.reader.resolveRevision(range.to)) !== saved.to) ||
          (range.from !== undefined &&
            (await context.reader.resolveRevision(range.from)) !== saved.from)
        ) {
          failGitHistory("history-cursor-invalid");
        }
        await context.reader.assertInScope(saved.to);
        if (saved.from) await context.reader.assertInScope(saved.from);
        state = saved;
      } else {
        if (needle === undefined) failGitHistory("history-arguments-invalid");
        await refusePartialClone(context.reader);
        const to = await context.reader.resolveRevision(range.to ?? HEAD_REVISION_ALIAS);
        const from =
          range.from === undefined ? null : await context.reader.resolveRevision(range.from);
        state = {
          tool: HISTORY_SEARCH_TOOL_NAME,
          needle,
          to,
          from,
          paths: requested ?? [],
          scanOffset: 0,
          matchIndex: 0,
          pathIndex: 0,
        };
      }
      return searchPage(context, state, params.cursor);
    },
  };
}

/**
 * A search string: non-empty text with no NUL and no lone surrogate, at most
 * the needle bound in UTF-8 bytes. It reaches git as one `-S` argument only.
 */
function searchNeedle(value: unknown, bound: ResolvedLimit): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    LONE_SURROGATE.test(value)
  ) {
    failGitHistory("history-arguments-invalid");
  }
  const bytes = byteLength(value);
  if (bytes > bound.value) refuseLimit(bound, bytes);
  return value;
}

/** Search reads full and shallow clones only; a partial clone is refused before any walk. */
async function refusePartialClone(reader: GitHistoryReader): Promise<void> {
  if (await reader.isPartialClone()) {
    failGitHistory("history-object-unavailable", "Search does not yet read partial clones.");
  }
}

/** A name a search never serves or lets shape a page: credential-bearing, generated, or not UTF-8. */
function neverServed(name: string | null): boolean {
  return name === null || isExportExcluded(name);
}

/**
 * One page of a search: the window of commits after `scanOffset`, scanned
 * with the needle, then served from the cursor's match and path onward.
 */
async function searchPage(context: HistoryContext, state: SearchCursor, cursor: unknown) {
  const reader = context.reader;
  const windowBound = context.limits.pickaxeMaxCommitsScanned.value;
  // One more than a window says whether the walk goes on; it is never scanned.
  const fetched = await reader.searchWindow({
    to: state.to,
    ...(state.from ? { from: state.from } : {}),
    paths: state.paths,
    skip: state.scanOffset,
    count: windowBound + 1,
  });
  const window = fetched.slice(0, windowBound);
  const walkContinues = fetched.length > window.length;
  // Read without the needle, so the label is the same for every needle.
  const excludedChanged = (await reader.searchChangedNames(window, state.paths)).some((names) =>
    names.some(neverServed),
  );
  const found = await reader.pickaxe({
    commits: window,
    needle: state.needle,
    paths: state.paths,
  });
  const shallow = await reader.shallowCommits();
  const cutInWindow = window.some((commit) => shallow.has(commit));
  // A path-limited walk can pass the cut without listing it, as the log's can.
  const endsAtCut =
    !walkContinues && (await reader.reachesShallowCut(state.to, state.from ?? undefined));
  // Names never served are dropped first, and a commit left with none is
  // dropped whole, so a match only there changes nothing on the page.
  const matches = found.flatMap((match) => {
    const names = match.paths.filter((name): name is string => !neverServed(name));
    if (names.length === 0) return [];
    const subject = egressText(match.subject, context.hostRoots);
    return [
      {
        commit: match.commit,
        parents: match.parents,
        committedAt: match.committedAt,
        subject: subject.ok ? subject.text : null,
        ...(subject.ok ? {} : { subjectWithheld: true as const }),
        // A name holding a configured credential is listed as null.
        paths: names.map((name) => {
          const masked = egressText(name, context.hostRoots);
          return masked.ok ? masked.text : null;
        }),
        ...(shallow.has(match.commit) ? { atShallowCut: true as const } : {}),
      },
    ];
  });
  type SearchMatch = (typeof matches)[number];
  // Only the page that ends the walk asks whether the walk reached the cut.
  const labelsFor = (endsWalk: boolean): HistoryReadLabel[] => [
    ...(excludedChanged ? (["history-paths-excluded"] as const) : []),
    ...(cutInWindow || (endsWalk && endsAtCut) ? (["history-shallow"] as const) : []),
  ];
  const render = (served: readonly SearchMatch[], nextCursor: string | null) =>
    JSON.stringify({
      kind: "docsfab-history-search",
      range: { from: state.from, to: state.to },
      paths: state.paths,
      scanRange: { start: state.scanOffset, end: state.scanOffset + window.length },
      labels: labelsFor(nextCursor === null),
      nextCursor,
      matches: served,
    });
  const bound = context.limits.responseMaxBytes;
  const placeholderCursor = newCursorHandle();
  const served: SearchMatch[] = [];
  let matchIndex = state.matchIndex;
  let pathIndex = state.pathIndex;
  let next: { matchIndex: number; pathIndex: number } | null = null;
  while (matchIndex < matches.length) {
    const rest = { ...matches[matchIndex]!, paths: matches[matchIndex]!.paths.slice(pathIndex) };
    // The last match of the walk's last window owes no cursor when it fits.
    const owed = matchIndex + 1 < matches.length || walkContinues ? placeholderCursor : null;
    if (byteLength(render([...served, rest], owed)) <= bound.value) {
      served.push(rest);
      matchIndex += 1;
      pathIndex = 0;
      continue;
    }
    // A match whose paths do not all fit serves those that do and continues
    // on the next page; one path that does not fit an empty page is refused.
    const partial = (count: number) => [...served, { ...rest, paths: rest.paths.slice(0, count) }];
    const fits = (count: number) =>
      byteLength(render(partial(count), placeholderCursor)) <= bound.value;
    if (!fits(1)) {
      if (served.length === 0) {
        refuseLimit(bound, byteLength(render(partial(1), placeholderCursor)));
      }
      next = { matchIndex, pathIndex };
      break;
    }
    let low = 1;
    let high = rest.paths.length - 1;
    while (low < high) {
      const middle = high - Math.floor((high - low) / 2);
      if (fits(middle)) low = middle;
      else high = middle - 1;
    }
    served.push({ ...rest, paths: rest.paths.slice(0, low) });
    next = { matchIndex, pathIndex: pathIndex + low };
    break;
  }
  const nextState: SearchCursor | null = next
    ? { ...state, ...next }
    : walkContinues
      ? { ...state, scanOffset: state.scanOffset + window.length, matchIndex: 0, pathIndex: 0 }
      : null;
  const nextCursor = nextState ? context.cursors.issue(nextState) : null;
  return historyResult(context, render(served, nextCursor), {
    tool: HISTORY_SEARCH_TOOL_NAME,
    revisions: state.from ? [state.from, state.to] : [state.to],
    paths: [...state.paths],
    ranges: [
      {
        path: null,
        unit: "entries",
        start: state.scanOffset,
        end: state.scanOffset + window.length,
      },
    ],
    labels: labelsFor(nextCursor === null),
    matchedCommits: served.map((match) => match.commit),
    ...cursorFields(cursor, nextCursor),
  });
}

/** Line numbers count from 1, as git's `-L` and the page's line ranges do. */
const FIRST_LINE = 1;

type BlameCursor = Extract<CursorState, { tool: typeof HISTORY_BLAME_TOOL_NAME }>;

function blameTool(context: HistoryContext): AnyToolDefinition {
  const linesBound = context.limits.blameMaxLines;
  return {
    name: HISTORY_BLAME_TOOL_NAME,
    label: "Blame lines at a revision",
    description:
      "For each line in a range of one repository file at a revision of this run's history, " +
      "return the full id of the commit that last changed it, the line's number in that " +
      "commit's version of the file, and the line's text: who changed a documented line, " +
      "and in which commit. Lines count from 1 and the range includes both ends; a long " +
      "range continues with nextCursor. A line older than a shallow clone's cut is " +
      "attributed to the cut and labelled history-shallow. A line that came from a " +
      "credential-bearing or generated file under another name is served without that " +
      "name and labelled history-paths-excluded.",
    promptSnippet: "Find the commit that last changed each line of a file range",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: [],
      properties: {
        path: { type: "string", description: PATH_DESCRIPTION },
        revision: { type: "string", description: REVISION_DESCRIPTION },
        startLine: {
          type: "integer",
          minimum: FIRST_LINE,
          description: "First line to blame, counted from 1",
        },
        endLine: {
          type: "integer",
          minimum: FIRST_LINE,
          description: `Last line to blame, included; one call covers at most ${String(linesBound.value)} lines`,
        },
        cursor: { type: "string", description: CURSOR_DESCRIPTION },
      },
    },
    async execute(_id: unknown, rawParams: unknown) {
      const params = argumentRecord(rawParams, [
        "path",
        "revision",
        "startLine",
        "endLine",
        "cursor",
      ]);
      let state: BlameCursor;
      if (params.cursor !== undefined) {
        state = context.cursors.resolve(params.cursor, HISTORY_BLAME_TOOL_NAME);
        // An omitted argument takes the page's; a sent one must equal it.
        if (
          (params.path !== undefined && historyPath(params.path) !== state.path) ||
          (params.startLine !== undefined && lineNumber(params.startLine) !== state.startLine) ||
          (params.endLine !== undefined && lineNumber(params.endLine) !== state.endLine) ||
          (params.revision !== undefined &&
            (await context.reader.resolveRevision(params.revision)) !== state.revision)
        ) {
          failGitHistory("history-cursor-invalid");
        }
        await context.reader.assertInScope(state.revision);
      } else {
        if (
          params.path === undefined ||
          params.revision === undefined ||
          params.startLine === undefined ||
          params.endLine === undefined
        ) {
          failGitHistory("history-arguments-invalid");
        }
        const path = historyPath(params.path);
        const startLine = lineNumber(params.startLine);
        const endLine = lineNumber(params.endLine);
        if (startLine > endLine) failGitHistory("history-line-range-invalid");
        // A bound on git's work, checked before git runs: blame traces every
        // asked line back through history. Served lines page by bytes.
        const asked = endLine - startLine + 1;
        if (asked > linesBound.value) refuseLimit(linesBound, asked);
        const revision = await context.reader.resolveRevision(params.revision);
        state = {
          tool: HISTORY_BLAME_TOOL_NAME,
          revision,
          path,
          startLine,
          endLine,
          nextLine: startLine,
        };
      }
      // The file at the blamed revision, not at head: a regular file the
      // checkout holds, as text, whose line count bounds the range.
      const blob = await context.reader.readFile(state.revision, state.path);
      const fileLines = textLines(utf8Text(blob.bytes));
      if (state.endLine > fileLines.length) {
        failGitHistory(
          "history-line-range-invalid",
          `The file has ${String(fileLines.length)} lines at that revision.`,
        );
      }
      const blamed = await context.reader.blame(
        state.revision,
        state.path,
        state.nextLine,
        state.endLine,
      );
      // The rest of the range is masked whole, so no page carries part of a refused value.
      const texts = maskedText(
        fileLines.slice(state.nextLine - FIRST_LINE, state.endLine).join("\n"),
        context.hostRoots,
      ).split("\n");
      if (texts.length !== blamed.length) failGitHistory("history-git-failed");
      const entries = blamed.map((entry, index) =>
        blameEntry(entry, texts[index]!, state.path, context.hostRoots),
      );
      const shallow = await context.reader.shallowCommits();
      const base = await baseLabels(context.reader);
      // Labels describe the served lines only: a cut commit or an excluded name on this page.
      const labelsFor = (count: number): HistoryReadLabel[] => {
        const served = entries.slice(0, count);
        return [
          ...base,
          ...(served.some((entry) => entry.excludedName)
            ? (["history-paths-excluded"] as const)
            : []),
          ...(served.some((entry) => shallow.has(entry.line.commit))
            ? (["history-shallow"] as const)
            : []),
        ].sort();
      };
      const render = (count: number, nextCursor: string | null) =>
        JSON.stringify({
          kind: "docsfab-history-blame",
          revision: state.revision,
          path: state.path,
          lineRange: { start: state.nextLine, end: state.nextLine + count - 1 },
          requestedRange: { start: state.startLine, end: state.endLine },
          totalLines: fileLines.length,
          labels: labelsFor(count),
          nextCursor,
          lines: entries.slice(0, count).map((entry) => entry.line),
        });
      const count = blamePageCount(entries.length, render, context.limits.responseMaxBytes);
      const nextCursor =
        count < entries.length
          ? context.cursors.issue({
              ...state,
              nextLine: state.nextLine + count,
            })
          : null;
      return historyResult(context, render(count, nextCursor), {
        tool: HISTORY_BLAME_TOOL_NAME,
        revisions: [state.revision],
        paths: [state.path],
        ranges: [
          {
            path: state.path,
            unit: "lines",
            start: state.nextLine,
            end: state.nextLine + count - 1,
          },
        ],
        labels: labelsFor(count),
        ...cursorFields(params.cursor, nextCursor),
      });
    },
  };
}

/** A line number argument: a whole number, counted from 1. */
function lineNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    failGitHistory("history-arguments-invalid");
  }
  if (value < FIRST_LINE) failGitHistory("history-line-range-invalid");
  return value;
}

/**
 * A text's lines: one per line break, plus a last line without a break. An
 * empty text has none, so every range of it is refused.
 */
function textLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  return lines;
}

/**
 * One served line. A name the file had in an older commit is served only
 * when it differs from the asked path and is neither credential-bearing nor
 * generated nor undecodable; any such name, served or not, sets the label.
 */
function blameEntry(entry: HistoryBlameLine, text: string, path: string, hostRoots: HostRootSet) {
  const excluded = (name: string | null) => name === null || isExportExcluded(name);
  const renamed = entry.sourcePath !== path;
  const sourceExcluded = renamed && excluded(entry.sourcePath);
  const masked = renamed && !sourceExcluded ? egressText(entry.sourcePath!, hostRoots) : undefined;
  return {
    excludedName: sourceExcluded || entry.previousPaths.some(excluded),
    line: {
      line: entry.line,
      commit: entry.commit,
      sourceLine: entry.sourceLine,
      ...(renamed
        ? masked?.ok
          ? { sourcePath: masked.text }
          : { sourcePathWithheld: true as const }
        : {}),
      text,
    },
  };
}

/**
 * How many of `total` lines one page serves: all when they fit with no
 * cursor, else the most that fit beside a cursor. A page's size grows with
 * its line count, so the count is found by halving. One line that does not
 * fit alone is refused by the page bound, never cut.
 */
function blamePageCount(
  total: number,
  render: (count: number, nextCursor: string | null) => string,
  bound: ResolvedLimit,
): number {
  if (byteLength(render(total, null)) <= bound.value) return total;
  const placeholder = newCursorHandle();
  const fits = (count: number) => byteLength(render(count, placeholder)) <= bound.value;
  if (!fits(1)) refuseLimit(bound, byteLength(render(1, placeholder)));
  let low = 1;
  let high = total - 1;
  while (low < high) {
    const middle = high - Math.floor((high - low) / 2);
    if (fits(middle)) low = middle;
    else high = middle - 1;
  }
  return low;
}

function cursorFields(cursor: unknown, nextCursor: string | null) {
  return {
    ...(typeof cursor === "string" ? { cursor } : {}),
    ...(nextCursor ? { nextCursor } : {}),
  };
}

async function baseLabels(reader: GitHistoryReader): Promise<HistoryReadLabel[]> {
  return (await reader.isPartialClone()) ? ["history-partial-clone"] : [];
}

function historyResult(context: HistoryContext, text: string, draft: HistoryReadDraft) {
  // The envelope was sized before the page was cut; this is the host's own check.
  if (byteLength(text) > context.limits.responseMaxBytes.value) {
    refuseLimit(context.limits.responseMaxBytes, byteLength(text));
  }
  return {
    content: [{ type: "text" as const, text }],
    // Host-built citation for the ledger; it is never shown to the model.
    details: { historyRead: { ...draft, labels: [...draft.labels].sort() } },
  };
}

/**
 * The end index of the page that starts at `start`: as many whole code points
 * as fit in the bytes left after the envelope, once JSON-escaped, cut back to
 * the last line break when the page holds one and does not reach the end.
 */
function pageEnd(text: string, start: number, bound: ResolvedLimit, envelope: number): number {
  const budget = bound.value - envelope;
  let used = 0;
  let end = start;
  for (const character of text.slice(start)) {
    const cost = byteLength(JSON.stringify(character)) - 2;
    if (used + cost > budget) break;
    used += cost;
    end += character.length;
  }
  if (end === start && start < text.length) {
    refuseLimit(
      bound,
      envelope + byteLength(JSON.stringify(String.fromCodePoint(text.codePointAt(start)!))) - 2,
    );
  }
  if (end < text.length) {
    const lineEnd = text.lastIndexOf("\n", end - 1);
    if (lineEnd >= start) end = lineEnd + 1;
  }
  return end;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** Text only: invalid UTF-8 or a NUL byte is binary. */
function utf8Text(bytes: Buffer): string {
  if (bytes.includes(0)) failGitHistory("history-object-binary");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    failGitHistory("history-object-binary");
  }
}

/**
 * Mask this host's roots across the whole text before it is paged, so a root
 * can never be split across two pages, and refuse it whole when it holds a
 * configured credential, so no page carries part of one.
 */
function maskedText(text: string, hostRoots: HostRootSet): string {
  const masked = egressText(text, hostRoots);
  // hygiene: ok -- the argument names the boundary; the error carries its own fixed message.
  if (!masked.ok) throw new CredentialBoundaryError("confined-tool-result");
  return masked.text;
}

function argumentRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    failGitHistory("history-arguments-invalid");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !keys.includes(key))) {
    failGitHistory("history-arguments-invalid");
  }
  return record;
}

/** A literal repository-relative path, outside credential-bearing and generated paths. */
function historyPath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    failGitHistory("history-arguments-invalid");
  }
  const segments = value.split("/");
  if (
    value.includes("\0") ||
    value.startsWith("/") ||
    value.startsWith("~") ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..") ||
    isExportExcluded(value)
  ) {
    failGitHistory("history-path-refused");
  }
  return value;
}

function historyPaths(value: unknown, bound: ResolvedLimit): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    failGitHistory("history-arguments-invalid");
  }
  if (value.length > bound.value) refuseLimit(bound, value.length);
  return value.map(historyPath);
}

/**
 * How each revision argument of a refused history call relates to the run's
 * pinned revision, the one id a history step is issued: the `head` alias, the
 * full id, an abbreviation of it, or anything else. Another commit is
 * `unknown` here; the refusal code says whether it was out of scope.
 */
function classifyHistoryRevisions(
  params: unknown,
  headRevision: string,
): Array<readonly [ToolRefusalIdArgument, ToolRefusalIdMatch]> {
  if (!isPlainRecord(params)) return [];
  const classify = (value: unknown): ToolRefusalIdMatch => {
    if (typeof value !== "string" || value.length === 0) return "malformed";
    if (value === HEAD_REVISION_ALIAS) return "handle";
    if (value === headRevision) return "exact";
    if (headRevision.startsWith(value)) return "unique-prefix";
    return "unknown";
  };
  const classes: Array<readonly [ToolRefusalIdArgument, ToolRefusalIdMatch]> = [];
  for (const argument of ["revision", "base", "head"] as const) {
    if (params[argument] !== undefined) classes.push([argument, classify(params[argument])]);
  }
  if (isPlainRecord(params.range)) {
    if (params.range.from !== undefined) classes.push(["range.from", classify(params.range.from)]);
    if (params.range.to !== undefined) classes.push(["range.to", classify(params.range.to)]);
  }
  return classes;
}

/**
 * Drops arguments sent as filler before a history tool reads them: `null`, an
 * empty string, or an empty list, at the top level or inside `range`. A model
 * that fills every declared argument sends an unused `cursor` or `range.from`
 * as `""`, which would otherwise be read as a cursor or revision to resolve.
 */
function withoutHistoryFiller(
  definition: AnyToolDefinition,
  recordFiller: ToolArgumentFillerRecorder | undefined,
): AnyToolDefinition {
  const execute = definition.execute.bind(definition) as (...arguments_: any[]) => Promise<any>;
  const tool = definition.name as HistoryToolName;
  const setAside = (argument: ToolRefusalArgumentKey, kind: ToolArgumentFillerKind) =>
    recordFiller?.({ tool, argument, kind });
  const strip = (value: Record<string, unknown>, prefix: string) => {
    const kept: Record<string, unknown> = { ...value };
    for (const [name, entry] of Object.entries(value)) {
      const argument = `${prefix}${name}`;
      const kind = fillerKind(entry, false);
      if (kind === undefined || !isArgumentKey(argument)) continue;
      delete kept[name];
      setAside(argument, kind);
    }
    return kept;
  };
  return {
    ...definition,
    async execute(...arguments_: any[]) {
      const raw: unknown = arguments_[1];
      if (!isPlainRecord(raw)) return execute(...arguments_);
      const params = strip(raw, "");
      if (isPlainRecord(params.range)) params.range = strip(params.range, "range.");
      return execute(arguments_[0], params, ...arguments_.slice(2));
    },
  };
}

const HISTORY_ARGUMENT_KEYS: ReadonlySet<string> = new Set(TOOL_REFUSAL_ARGUMENT_KEYS);

function isArgumentKey(name: string): name is ToolRefusalArgumentKey {
  return HISTORY_ARGUMENT_KEYS.has(name);
}

/**
 * Keep refusals content-free and attributed to their category. A configured
 * credential keeps the confined result screen's own boundary message.
 */
function wrapHistoryExecute(
  definition: AnyToolDefinition,
  recordFailure: (category: ToolFailureCategory) => void,
  recordRefusal: ToolRefusalRecorder | undefined,
  reader: Pick<GitHistoryReader, "headRevision">,
): AnyToolDefinition {
  const execute = definition.execute.bind(definition) as (...arguments_: any[]) => Promise<any>;
  const declared = declaredToolArguments(definition);
  const tool = definition.name as HistoryToolName;
  const record = (params: unknown, code: ToolRefusalCode, detailKind: ToolRefusalDetailKind) =>
    recordRefusal?.({
      tool,
      code,
      detailKind,
      ...toolArgumentKeys(params, declared),
      idMatches: idMatchEntries(classifyHistoryRevisions(params, reader.headRevision)),
    });
  return {
    ...definition,
    async execute(...arguments_: any[]) {
      try {
        return await execute(...arguments_);
      } catch (error) {
        const params: unknown = arguments_[1];
        if (error instanceof CredentialBoundaryError) {
          record(params, "credential-withheld", "credential");
          throw error;
        }
        if (error instanceof GitHistoryError) {
          record(params, error.code, "history");
          recordFailure(error.category);
          throw new Error(error.message);
        }
        // A catalogued bound: the message names its code, observed value and remediation.
        if (error instanceof OperationalLimitError) {
          record(params, "operational-limit", "operational-limit");
          recordFailure("recoverable-miss");
          throw new Error(error.message);
        }
        record(params, "tool-defect", "tool-defect");
        recordFailure("tool-defect");
        throw new Error("DocsFab could not complete this history read and recorded a tool defect.");
      }
    },
  };
}
