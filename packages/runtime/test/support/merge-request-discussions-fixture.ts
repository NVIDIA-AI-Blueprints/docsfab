// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * A recorded GitLab for the merge request discussions reader. Bodies follow
 * GitLab's own `/discussions` and merge request `get` shapes (the templates
 * in `test/fixtures/merge-request-discussions/`, taken from a live read of
 * this project's merge requests with text replaced), and the endpoints are
 * spelled out here rather than taken from the reader. No test reaches GitLab.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export { LOGIN_EXPIRED, RecordedGitLab } from "./gitlab-forge-fixture.js";

export const HOST = "gitlab.example.test";
export const PROJECT_PATH = "team/docs-project";
export const PROJECT_ID = 4242;
export const IID = 813;
/** The merge request's global id, which every note names as `noteable_id`. */
export const MR_ID = 9100813;
/** GitLab's own page maximum, which the reader asks for. */
export const PAGE_SIZE = 100;

export const BASE = "1b2c3d4e5f60718293a4b5c6d7e8f90112233445";
export const HEAD = "9f8e7d6c5b4a39281706f5e4d3c2b1a099887766";
export const OLDER_HEAD = "5a5b5c5d5e5f50515253545556575859aabbccdd";

export const ENDPOINTS = Object.freeze({
  mergeRequest: `projects/${PROJECT_ID}/merge_requests/${IID}`,
  discussions: (page: number) =>
    `projects/${PROJECT_ID}/merge_requests/${IID}/discussions?per_page=${PAGE_SIZE}&page=${page}`,
});

const FIXTURES = join(import.meta.dirname, "..", "fixtures", "merge-request-discussions");

function template(name: string): string {
  return readFileSync(join(FIXTURES, name), "utf8");
}

/** A template with every `"@key"` value replaced by `values[key]`, of any JSON type. */
function filled(
  source: string,
  values: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return JSON.parse(source, (_key, value: unknown) => {
    if (typeof value !== "string" || !value.startsWith("@")) return value;
    const key = value.slice(1);
    return Object.hasOwn(values, key) ? values[key] : value;
  }) as Record<string, unknown>;
}

/** The merge request `get`, open at `head` unless fields say otherwise. */
export function mergeRequestGet(
  options: {
    readonly head?: string | null;
    readonly diffHead?: string;
    readonly userNotesCount?: number;
    readonly state?: string;
    readonly sourceProjectId?: number;
  } = {},
  fields: Record<string, unknown> = {},
): Record<string, unknown> {
  const head = options.head === undefined ? HEAD : options.head;
  return {
    ...filled(template("merge-request-get.json"), {
      mr_id: MR_ID,
      state: options.state ?? "opened",
      user_notes_count: options.userNotesCount ?? 0,
      source_project_id: options.sourceProjectId ?? PROJECT_ID,
      head,
      diff_head: options.diffHead ?? head ?? HEAD,
      base: BASE,
    }),
    ...fields,
  };
}

/** A diff note's `position`, a text line on the pinned head unless fields say otherwise. */
export function positionOf(
  fields: {
    readonly oldPath?: string | null;
    readonly newPath?: string | null;
    readonly oldLine?: number | null;
    readonly newLine?: number | null;
    readonly positionType?: string;
    readonly head?: string;
    readonly lineRange?: unknown;
  } = {},
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const path = "docs/export.md";
  return {
    ...filled(template("position.json"), {
      base: BASE,
      head: fields.head ?? HEAD,
      old_path: fields.oldPath === undefined ? path : fields.oldPath,
      new_path: fields.newPath === undefined ? path : fields.newPath,
      position_type: fields.positionType ?? "text",
      old_line: fields.oldLine === undefined ? null : fields.oldLine,
      new_line: fields.newLine === undefined ? 12 : fields.newLine,
      line_range: fields.lineRange === undefined ? null : fields.lineRange,
    }),
    ...extra,
  };
}

let nextNoteId = 71_000_000;

/** A note id no other note in the file shares. */
export function freshNoteId(): number {
  nextNoteId += 1;
  return nextNoteId;
}

export interface NoteFields {
  readonly id?: number;
  readonly body?: string;
  readonly username?: string;
  readonly authorId?: number;
  readonly system?: boolean;
  readonly resolvable?: boolean;
  readonly resolved?: boolean;
  readonly type?: string | null;
  /** A diff note's position; absent means a note with no `position` key at all. */
  readonly position?: Record<string, unknown> | null;
}

/**
 * One note as GitLab lists it. A resolvable note carries `resolved`,
 * `resolved_by` and `resolved_at`; a note that is not resolvable has none of
 * them, as GitLab sends it. A diff note carries `commit_id` and `position`.
 */
export function noteOf(
  fields: NoteFields = {},
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const resolvable = fields.resolvable ?? false;
  const note: Record<string, unknown> = filled(template("note.json"), {
    id: fields.id ?? freshNoteId(),
    type:
      fields.type !== undefined
        ? fields.type
        : fields.position !== undefined
          ? "DiffNote"
          : resolvable
            ? "DiscussionNote"
            : null,
    body: fields.body ?? "Please say which flag sets the output path.",
    author_id: fields.authorId ?? 31,
    username: fields.username ?? "reviewer",
    system: fields.system ?? false,
    resolvable,
  });
  if (resolvable) {
    const resolved = fields.resolved ?? false;
    note.resolved = resolved;
    note.resolved_by = resolved ? { id: 31, username: "reviewer" } : null;
    note.resolved_at = resolved ? "2026-10-02T10:00:00.000Z" : null;
  }
  if (fields.position !== undefined) {
    note.commit_id = null;
    note.position = fields.position;
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete note[key];
    else note[key] = value;
  }
  return note;
}

/** A discussion id as GitLab mints it: 40 lowercase hex digits, here from a seed. */
export function discussionIdOf(seed: string): string {
  return createHash("sha1").update(seed).digest("hex");
}

export function discussionOf(
  seed: string,
  notes: readonly Record<string, unknown>[],
  individualNote = notes.length === 1 && notes[0]!.resolvable === false,
): Record<string, unknown> {
  return { id: discussionIdOf(seed), individual_note: individualNote, notes };
}

/** The page bodies a paged read of `items` returns, an empty one after an exact multiple. */
export function pages<T>(items: readonly T[]): T[][] {
  const result: T[][] = [];
  for (let start = 0; ; start += PAGE_SIZE) {
    const page = items.slice(start, start + PAGE_SIZE);
    result.push(page);
    if (page.length < PAGE_SIZE) return result;
  }
}

/** Non-system notes, which is what GitLab's `user_notes_count` counts. */
export function userNotesCount(discussions: readonly Record<string, unknown>[]): number {
  return discussions
    .flatMap((discussion) => discussion.notes as Record<string, unknown>[])
    .filter((note) => note.system === false).length;
}
