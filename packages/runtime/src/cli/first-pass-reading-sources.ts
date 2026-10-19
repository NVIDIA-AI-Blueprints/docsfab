// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The sources an admitted request reading names, as a gathering first pass
 * binds them.
 *
 * The reading is model output, so no source it names stops a run. A tracked
 * regular file binds. A tracked directory binds its tracked regular files,
 * all of them or none: they bind when they fit in what the source budget
 * leaves, and otherwise none does. Every other path, and every file of a
 * named directory that first pass never binds, becomes one coded notice that
 * names the path and the reason, and first pass goes on with what it could
 * bind. Deciding reads only the revision's tracked set, never a file's bytes.
 * A path the revision does not track or the export excludes, and host state,
 * are never read at all; a tracked file left unbound is still one first pass
 * may rank and read like any other.
 *
 * Each rule here mirrors the knowledge provider's own check on a bound
 * source (`normalizeBoundSourcePaths`, `assertBoundSourcesPresent`), so a
 * source this host hands the provider never stops first pass there.
 */
import { createHash } from "node:crypto";
import { posix } from "node:path";

import { formatLimitObservation, type ResolvedLimit } from "../config/limits.js";
import type { TrackedSourceReaderV1 } from "../inputs/source-acquisition.js";
import { isRecordableEvidenceWarning } from "../records/evidence-warnings.js";
import {
  EXPORT_EXCLUSION_DESCRIPTION,
  isExportExcluded,
} from "../repository/workspace/export-exclusion.js";
import type { RequestIntentPathQuote } from "../request-intent/contract.js";
import { escapeUndisplayable } from "../shared/display-text.js";
import { compareText } from "../shared/primitives.js";

/** The code of every notice, and the prefix of its run-record warning line. */
export const READING_SOURCE_NOTICE_CODE = "first-pass-reading-source-unbound";

/** Why first pass did not bind a source the reading names. */
export const READING_SOURCE_NOTICE_REASONS = Object.freeze([
  "not-tracked",
  "glob",
  "export-excluded",
  "host-state",
  "unsafe-path",
  "over-budget",
  "files-left-out",
] as const);

export type ReadingSourceNoticeReason = (typeof READING_SOURCE_NOTICE_REASONS)[number];

export interface ReadingSourceNotice {
  /** The source as the reading names it. */
  readonly path: string;
  readonly reason: ReadingSourceNoticeReason;
  /** The coded line the run record keeps and LIMITATIONS prints. */
  readonly line: string;
}

export interface BoundReadingSources {
  /**
   * The tracked regular files first pass binds for the reading, each once and
   * with the quote of the source that named it: a named file, or a file of a
   * named directory.
   */
  readonly sources: readonly RequestIntentPathQuote[];
  /** One per source first pass did not bind whole, in reading order. */
  readonly notices: readonly ReadingSourceNotice[];
  /** Each named directory whose files bound, with how many bound. */
  readonly directories: readonly { readonly path: string; readonly files: number }[];
}

/** Host state first pass never reads, as the knowledge provider names it. */
const HOST_STATE_DIRECTORIES: ReadonlySet<string> = new Set([".git", ".docsfab"]);

/** A path the knowledge provider refuses as a bound source starts this way. */
const DRIVE_PREFIX = /^[A-Za-z]:/u;

/**
 * An untracked path holding one of these is a pattern, never a path first
 * pass binds. Brackets and braces are not counted: a site framework's page
 * names use them (`pages/[slug].md`), and a missing one is not-tracked.
 */
const GLOB_CHARACTER = /[*?]/u;

const READING = "the request's reading names it as a source";
const WENT_ON = "and went on with the evidence it could bind";

/**
 * Bind the reading's sources against the revision's tracked set and the
 * source budget. `sources` are the reading's own: neither a `--source`
 * selection nor a write target, each once. A reader failure passes through.
 */
export async function bindReadingSources(input: {
  readonly reader: TrackedSourceReaderV1;
  /**
   * The revision's tracked regular files, when the reader lists them. Without
   * them a directory cannot be told from a missing path, so only files bind.
   */
  readonly trackedFiles: readonly string[] | undefined;
  readonly sources: readonly RequestIntentPathQuote[];
  /** The operator's `--source` selections, which take the budget first. */
  readonly selected: readonly string[];
  /** The run's write targets: a target under a named directory is not a source. */
  readonly writeTargets: readonly string[];
  /** `firstPass.maxSourceFiles` as resolved for this run. */
  readonly sourceBudget: ResolvedLimit;
}): Promise<BoundReadingSources> {
  const writeTargets = new Set(input.writeTargets);
  // Every source first pass binds: the selections, then the reading's, in
  // the one budget the provider counts them under.
  const bound = new Set(input.selected);
  const sources: RequestIntentPathQuote[] = [];
  const notices: ReadingSourceNotice[] = [];
  const directories: { path: string; files: number }[] = [];
  for (const source of input.sources) {
    const path = source.path;
    const notify = (reason: ReadingSourceNoticeReason, sentence: string) =>
      notices.push(readingSourceNotice(path, reason, sentence));
    const hostState = hostStateAncestor(path);
    if (hostState !== undefined) {
      notify("host-state", hostStateSentence(hostState));
      continue;
    }
    if (await input.reader.isTrackedRegularFile(path)) {
      // A directory named earlier in the reading may already hold it.
      if (bound.has(path)) continue;
      if (!isBindableSourcePath(path)) {
        notify(
          "unsafe-path",
          `${READING}, but first pass binds only a path in Unicode NFC form with no backslash or drive prefix, so it did not bind it ${WENT_ON}. Rename the file, or name another file that carries the evidence.`,
        );
        continue;
      }
      if (bound.size + 1 > input.sourceBudget.value) {
        notify(
          "over-budget",
          `${READING}, but binding it would bring first pass to ${String(bound.size + 1)} sources, so first pass did not bind it ${WENT_ON}. ${formatLimitObservation(input.sourceBudget, bound.size + 1)}`,
        );
        continue;
      }
      bound.add(path);
      sources.push(source);
      continue;
    }
    if (isExportExcluded(path)) {
      notify(
        "export-excluded",
        `${READING}, but the source export never materializes ${EXPORT_EXCLUSION_DESCRIPTION}, so first pass did not read it ${WENT_ON}. Bind a different file that carries the evidence.`,
      );
      continue;
    }
    const prefix = `${path}/`;
    const under = input.trackedFiles?.filter((file) => file.startsWith(prefix)) ?? [];
    if (under.length > 0) {
      const directoryHostState = path
        .split("/")
        .find((segment) => HOST_STATE_DIRECTORIES.has(segment.toLowerCase()));
      if (directoryHostState !== undefined) {
        notify("host-state", hostStateSentence(directoryHostState));
        continue;
      }
      const fresh = under.filter((file) => !bound.has(file) && !writeTargets.has(file));
      const inHostState = fresh.filter((file) => hostStateAncestor(file) !== undefined);
      const unsafe = fresh.filter(
        (file) => hostStateAncestor(file) === undefined && !isBindableSourcePath(file),
      );
      const leftOut = new Set([...inHostState, ...unsafe]);
      const eligible = fresh.filter((file) => !leftOut.has(file)).sort(compareText);
      const leftOutSentence = leftOutFilesSentence(inHostState.length, unsafe.length);
      if (eligible.length > 0 && bound.size + eligible.length > input.sourceBudget.value) {
        const observed = bound.size + eligible.length;
        notify(
          "over-budget",
          `the request's reading names this directory as a source, but binding its ${String(eligible.length)} tracked file${eligible.length === 1 ? "" : "s"} would bring first pass to ${String(observed)} sources, so first pass bound none of them ${WENT_ON}.${leftOutSentence ? ` ${leftOutSentence}` : ""} ${formatLimitObservation(input.sourceBudget, observed)}`,
        );
        continue;
      }
      for (const file of eligible) {
        bound.add(file);
        sources.push({ path: file, quote: source.quote });
      }
      if (eligible.length > 0) directories.push({ path, files: eligible.length });
      if (leftOutSentence) {
        notify(
          "files-left-out",
          `the request's reading names this directory as a source, and first pass bound ${String(eligible.length)} of its tracked files. ${leftOutSentence} It went on with the evidence it could bind.`,
        );
      }
      continue;
    }
    if (GLOB_CHARACTER.test(path)) {
      notify(
        "glob",
        `${READING}, but it is a pattern, and first pass binds a source only by its exact path, so it read nothing for it ${WENT_ON}. Name the files, or the directory that holds them, in the request, or pass the files with --source.`,
      );
      continue;
    }
    notify(
      "not-tracked",
      `${READING}, but ${input.trackedFiles ? "the selected revision tracks no regular file at that path or under it" : "it is not a tracked regular file at the selected revision"}, so first pass did not read it ${WENT_ON}. To use it as evidence, check the path or commit it, then run again, or pass a tracked file with --source.`,
    );
  }
  return Object.freeze({
    sources: Object.freeze(sources),
    notices: Object.freeze(notices),
    directories: Object.freeze(directories),
  });
}

/**
 * The first host-state directory `path` lies under, as the knowledge provider
 * reads it: a directory segment, so not the last one, compared in lower case.
 */
export function hostStateAncestor(path: string): string | undefined {
  return path
    .split("/")
    .slice(0, -1)
    .find((segment) => HOST_STATE_DIRECTORIES.has(segment.toLowerCase()));
}

/**
 * Whether the knowledge provider binds `path` as a source: a repository-
 * relative path in NFC form, with no NUL, backslash, leading slash, drive
 * prefix, or empty, `.`, or `..` segment.
 */
export function isBindableSourcePath(path: string): boolean {
  return (
    path.length > 0 &&
    path === path.normalize("NFC") &&
    !path.includes("\0") &&
    !path.includes("\\") &&
    !path.startsWith("/") &&
    !DRIVE_PREFIX.test(path) &&
    posix.normalize(path) === path &&
    path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

/** The status line for a named directory whose files bound. */
export function boundDirectoryStatus(directory: {
  readonly path: string;
  readonly files: number;
}): string {
  return `first pass binds the ${String(directory.files)} tracked file${directory.files === 1 ? "" : "s"} under ${quotedPath(directory.path)}, which the request's reading names as a source`;
}

function hostStateSentence(segment: string): string {
  return `${READING}, but it is host state in ${segment}/, which first pass never reads, so first pass did not read it ${WENT_ON}. Name a tracked product file outside that directory.`;
}

function leftOutFilesSentence(hostState: number, unsafe: number): string {
  const causes = [
    ...(hostState > 0 ? [`${String(hostState)} in host state under .docsfab/ or .git/`] : []),
    ...(unsafe > 0
      ? [
          `${String(unsafe)} whose path is not in Unicode NFC form or holds a backslash or drive prefix`,
        ]
      : []),
  ];
  if (causes.length === 0) return "";
  return `It left out ${String(hostState + unsafe)} of its tracked files, which first pass never binds as sources: ${causes.join(", and ")}.`;
}

/**
 * One notice. The run record keeps a warning of at most 1,024 characters, so
 * a line whose path would pass that names the path by the SHA-256 of its text
 * instead; the full path stays on the record's request intent.
 */
function readingSourceNotice(
  path: string,
  reason: ReadingSourceNoticeReason,
  sentence: string,
): ReadingSourceNotice {
  const full = `${READING_SOURCE_NOTICE_CODE}: ${quotedPath(path)} (${reason}): ${sentence}`;
  const line = isRecordableEvidenceWarning(full)
    ? full
    : `${READING_SOURCE_NOTICE_CODE}: a path too long to show here, with path SHA-256 ${createHash("sha256").update(path, "utf8").digest("hex")} (${reason}): ${sentence}`;
  return Object.freeze({ path, reason, line });
}

/** The path as quoted repository text, every undisplayable code point escaped. */
function quotedPath(path: string): string {
  return escapeUndisplayable(JSON.stringify(path));
}
