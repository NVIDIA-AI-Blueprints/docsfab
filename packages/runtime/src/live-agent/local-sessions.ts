// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Local live-agent session storage: inventory, deletion, and the opt-in age
 * sweep.
 *
 * The session directory holds Pi transcripts (`<timestamp>_<id>.jsonl`) and,
 * under `task-branches/`, one task-branch state file per repository. Deletion
 * touches only those two kinds of regular file directly inside that directory.
 * It never follows a symbolic link, never resolves a path outside the
 * directory, and re-checks each file's identity before removing it, so a file
 * swapped after the inventory is refused instead of deleted.
 */
import { constants, type Stats } from "node:fs";
import { lstat, open, readdir, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { canonicalDigest } from "../content-ir/canonical.js";
import { limit, loadEffectiveLimitEnvironment, type ResolvedLimit } from "../config/limits.js";
import { repositoryVirtualCwd, VIRTUAL_WORKSPACE_CWD } from "../harness/pi-session.js";
import { SAFE_RECORD_ID } from "../records/file-store.js";
import { TASK_BRANCH_STATE_DIRECTORY, TASK_BRANCH_STATE_KIND } from "./branch-preparation.js";
import { shortIdentifier } from "./source-custody.js";

export const SESSION_MAX_AGE_DAYS_LIMIT = "liveAgent.sessionMaxAgeDays" as const;

const SESSION_FILE_SUFFIX = ".jsonl";
const TASK_BRANCH_STATE_SUFFIX = ".json";
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
/** Hex characters of the repository digest a label shows. A format, not a bound. */
const REPOSITORY_LABEL_HEX_CHARACTERS = 12;
const REPOSITORY_DIGEST = /^[0-9a-f]{64}$/u;

/** The label of a session or state file whose repository cannot be read. */
export const UNKNOWN_REPOSITORY_LABEL = "unknown";

export const LOCAL_SESSION_REFUSAL_CODES = [
  "live-agent-session-arguments-invalid",
  "live-agent-session-id-invalid",
  "live-agent-session-not-found",
  "live-agent-session-entry-unsafe",
  "live-agent-session-directory-unsafe",
  "live-agent-session-confirmation-mismatch",
  "live-agent-session-removal-incomplete",
] as const;

export type LocalSessionRefusalCodeV1 = (typeof LOCAL_SESSION_REFUSAL_CODES)[number];

/** A coded stop with its next action. Messages never quote a transcript. */
export class LocalSessionError extends Error {
  public constructor(
    message: string,
    public readonly code: LocalSessionRefusalCodeV1,
    public readonly nextAction: string,
  ) {
    super(message);
    this.name = "LocalSessionError";
  }
}

/** One Pi transcript in the session directory. */
export interface LocalSessionV1 {
  readonly id: string;
  readonly fileName: string;
  readonly bytes: number;
  readonly modifiedAt: string;
  /** Whole days since the last write. */
  readonly ageDays: number;
  /** `repo-<digest prefix>`; never the repository path. */
  readonly repository: string;
}

/** One task-branch state file. It records the repository's absolute path. */
export interface TaskBranchStateFileV1 {
  readonly fileName: string;
  readonly bytes: number;
  readonly modifiedAt: string;
  readonly ageDays: number;
  readonly repository: string;
}

interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly bytes: number;
  readonly mtimeMs: number;
}

export interface LocalSessionInventoryV1 {
  readonly directory: string;
  /** False when the session directory does not exist yet. */
  readonly present: boolean;
  /** Newest first. */
  readonly sessions: readonly LocalSessionV1[];
  readonly taskBranchStates: readonly TaskBranchStateFileV1[];
  /** Entries that are not managed session data, or are links; never deleted. */
  readonly leftInPlace: { readonly symbolicLinks: number; readonly other: number };
  /** The task-branches entry itself is a link or another unsafe entry. */
  readonly taskBranchDirectoryLeftInPlace: "symbolic-link" | "other" | null;
  readonly observedAtMs: number;
  /** Session ids whose entry is a link or not a regular file. */
  readonly refusedSessionIds: ReadonlySet<string>;
  readonly directoryIdentity: { readonly dev: number; readonly ino: number } | null;
  readonly taskBranchDirectoryIdentity: { readonly dev: number; readonly ino: number } | null;
  /** Keyed by path relative to the session directory. */
  readonly identities: ReadonlyMap<string, FileIdentity>;
}

export type LocalSessionSelectorV1 =
  | { readonly kind: "session"; readonly id: string }
  | { readonly kind: "all" }
  | { readonly kind: "older-than"; readonly days: number };

export interface LocalSessionDeletionPlanV1 {
  readonly selector: LocalSessionSelectorV1;
  readonly sessions: readonly LocalSessionV1[];
  readonly taskBranchStates: readonly TaskBranchStateFileV1[];
  readonly bytes: number;
  /** Token that authorizes exactly this set; null when nothing would be deleted. */
  readonly confirmation: string | null;
}

export interface LocalSessionDeletionResultV1 {
  readonly sessionsRemoved: number;
  readonly taskBranchStatesRemoved: number;
  readonly bytesRemoved: number;
  /** Files already gone when deletion reached them. */
  readonly alreadyAbsent: number;
}

/** Storage summary `docsfab doctor` reports. */
export interface LocalSessionStorageSummaryV1 {
  readonly state: "absent" | "present" | "unreadable";
  readonly sessions: number;
  readonly bytes: number;
  readonly oldestAgeDays: number | null;
  readonly taskBranchStates: number;
  /** Effective `liveAgent.sessionMaxAgeDays`; 0 is off, null when it is invalid. */
  readonly maxAgeDays: number | null;
  /** Refusal code when the directory or the bound could not be read. */
  readonly code?: string;
}

/** `repo-<digest prefix>` for one checkout, matching what its sessions list as. */
export function localSessionRepositoryLabel(repositoryPath: string): string {
  return labelOfVirtualCwd(repositoryVirtualCwd(repositoryPath));
}

function labelOfVirtualCwd(cwd: string): string {
  const prefix = `${VIRTUAL_WORKSPACE_CWD}/`;
  if (!cwd.startsWith(prefix)) return UNKNOWN_REPOSITORY_LABEL;
  const digest = cwd.slice(prefix.length);
  if (!REPOSITORY_DIGEST.test(digest)) return UNKNOWN_REPOSITORY_LABEL;
  return `repo-${digest.slice(0, REPOSITORY_LABEL_HEX_CHARACTERS)}`;
}

/**
 * Label from a transcript header cwd. Transcripts recorded before virtual cwds
 * hold the absolute repository path, which is hashed the same way.
 */
function labelOfHeaderCwd(cwd: unknown): string {
  if (typeof cwd !== "string" || cwd.length === 0 || cwd.includes("\0")) {
    return UNKNOWN_REPOSITORY_LABEL;
  }
  if (cwd.startsWith(`${VIRTUAL_WORKSPACE_CWD}/`)) return labelOfVirtualCwd(cwd);
  return isAbsolute(cwd) ? localSessionRepositoryLabel(cwd) : UNKNOWN_REPOSITORY_LABEL;
}

/** The session id in a Pi transcript name, or undefined when the name is not one. */
export function localSessionIdOfFileName(fileName: string): string | undefined {
  if (!fileName.endsWith(SESSION_FILE_SUFFIX)) return undefined;
  const stem = fileName.slice(0, -SESSION_FILE_SUFFIX.length);
  const separator = stem.indexOf("_");
  const id = separator < 0 ? stem : stem.slice(separator + 1);
  return SAFE_RECORD_ID.test(id) ? id : undefined;
}

function ageDaysOf(mtimeMs: number, nowMs: number): number {
  return Math.max(0, Math.floor((nowMs - mtimeMs) / MILLISECONDS_PER_DAY));
}

function olderThan(identity: FileIdentity, days: number, nowMs: number): boolean {
  return nowMs - identity.mtimeMs > days * MILLISECONDS_PER_DAY;
}

function identityOf(stat: Stats): FileIdentity {
  return { dev: stat.dev, ino: stat.ino, bytes: stat.size, mtimeMs: stat.mtimeMs };
}

async function lstatOrUndefined(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  }
}

function directoryUnsafe(): LocalSessionError {
  return new LocalSessionError(
    "The live-agent session directory, or its task-branch subdirectory, is a symbolic link or not a directory, so DocsFab read and deleted nothing there.",
    "live-agent-session-directory-unsafe",
    "Replace the link with an owner-private directory, or remove it yourself, then run the command again.",
  );
}

async function readHeaderCwd(path: string): Promise<unknown> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    for await (const line of handle.readLines({ autoClose: false })) {
      if (line.trim().length === 0) continue;
      try {
        const header = JSON.parse(line) as { type?: unknown; cwd?: unknown };
        return header?.type === "session" ? header.cwd : undefined;
      } catch {
        return undefined;
      }
    }
    return undefined;
  } finally {
    await handle.close();
  }
}

async function readTaskBranchRepository(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const raw = JSON.parse(await handle.readFile("utf8")) as {
      kind?: unknown;
      repositoryPath?: unknown;
    };
    return raw?.kind === TASK_BRANCH_STATE_KIND &&
      typeof raw.repositoryPath === "string" &&
      isAbsolute(raw.repositoryPath)
      ? localSessionRepositoryLabel(raw.repositoryPath)
      : UNKNOWN_REPOSITORY_LABEL;
  } catch {
    return UNKNOWN_REPOSITORY_LABEL;
  } finally {
    await handle.close();
  }
}

/** Read the session directory without changing anything. */
export async function inventoryLocalSessions(input: {
  readonly directory: string;
  readonly nowMs?: number;
}): Promise<LocalSessionInventoryV1> {
  const directory = resolve(input.directory);
  const nowMs = input.nowMs ?? Date.now();
  const sessions: LocalSessionV1[] = [];
  const states: TaskBranchStateFileV1[] = [];
  const identities = new Map<string, FileIdentity>();
  const refusedSessionIds = new Set<string>();
  let symbolicLinks = 0;
  let other = 0;
  let taskBranchDirectoryLeftInPlace: "symbolic-link" | "other" | null = null;
  const root = await lstatOrUndefined(directory);
  if (!root) {
    return {
      directory,
      present: false,
      sessions,
      taskBranchStates: states,
      leftInPlace: { symbolicLinks, other },
      taskBranchDirectoryLeftInPlace,
      observedAtMs: nowMs,
      refusedSessionIds,
      directoryIdentity: null,
      taskBranchDirectoryIdentity: null,
      identities,
    };
  }
  if (root.isSymbolicLink() || !root.isDirectory()) throw directoryUnsafe();
  let taskBranchDirectoryIdentity: { dev: number; ino: number } | null = null;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.name === TASK_BRANCH_STATE_DIRECTORY) {
      const stat = await lstat(path);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        if (stat.isSymbolicLink()) {
          symbolicLinks += 1;
          taskBranchDirectoryLeftInPlace = "symbolic-link";
        } else {
          other += 1;
          taskBranchDirectoryLeftInPlace = "other";
        }
        continue;
      }
      taskBranchDirectoryIdentity = { dev: stat.dev, ino: stat.ino };
      for (const state of await readdir(path, { withFileTypes: true })) {
        const statePath = join(path, state.name);
        const stateStat = await lstat(statePath);
        if (stateStat.isSymbolicLink()) {
          symbolicLinks += 1;
          continue;
        }
        if (!stateStat.isFile() || !state.name.endsWith(TASK_BRANCH_STATE_SUFFIX)) {
          other += 1;
          continue;
        }
        const identity = identityOf(stateStat);
        identities.set(join(TASK_BRANCH_STATE_DIRECTORY, state.name), identity);
        states.push({
          fileName: state.name,
          bytes: identity.bytes,
          modifiedAt: new Date(identity.mtimeMs).toISOString(),
          ageDays: ageDaysOf(identity.mtimeMs, nowMs),
          repository: await readTaskBranchRepository(statePath),
        });
      }
      continue;
    }
    const id = localSessionIdOfFileName(entry.name);
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || (id !== undefined && !stat.isFile())) {
      if (stat.isSymbolicLink()) symbolicLinks += 1;
      else other += 1;
      if (id !== undefined) refusedSessionIds.add(id);
      continue;
    }
    if (id === undefined) {
      other += 1;
      continue;
    }
    const identity = identityOf(stat);
    identities.set(entry.name, identity);
    sessions.push({
      id,
      fileName: entry.name,
      bytes: identity.bytes,
      modifiedAt: new Date(identity.mtimeMs).toISOString(),
      ageDays: ageDaysOf(identity.mtimeMs, nowMs),
      repository: labelOfHeaderCwd(await readHeaderCwd(path).catch(() => undefined)),
    });
  }
  sessions.sort(
    (left, right) =>
      right.modifiedAt.localeCompare(left.modifiedAt) ||
      left.fileName.localeCompare(right.fileName),
  );
  states.sort((left, right) => left.fileName.localeCompare(right.fileName));
  return {
    directory,
    present: true,
    sessions,
    taskBranchStates: states,
    leftInPlace: { symbolicLinks, other },
    taskBranchDirectoryLeftInPlace,
    observedAtMs: nowMs,
    refusedSessionIds,
    directoryIdentity: { dev: root.dev, ino: root.ino },
    taskBranchDirectoryIdentity,
    identities,
  };
}

function requireIdentity(inventory: LocalSessionInventoryV1, relativePath: string): FileIdentity {
  const identity = inventory.identities.get(relativePath);
  if (!identity) {
    throw new Error(
      `The session inventory holds no file identity for ${relativePath}, which is a DocsFab defect.`,
    );
  }
  return identity;
}

/**
 * Choose what one selector deletes. A repository's task-branch state goes
 * when no session for that repository would remain and the deletion removed
 * one of its sessions, removes everything, or finds the state itself past the
 * age bound.
 */
export function planLocalSessionDeletion(
  inventory: LocalSessionInventoryV1,
  selector: LocalSessionSelectorV1,
): LocalSessionDeletionPlanV1 {
  const nowMs = inventory.observedAtMs;
  let selected: LocalSessionV1[];
  if (selector.kind === "session") {
    if (!SAFE_RECORD_ID.test(selector.id)) {
      throw new LocalSessionError(
        "That is not a live-agent session id. A session id is the ID column docsfab sessions list prints; it has no path separators.",
        "live-agent-session-id-invalid",
        "Run docsfab sessions list, then pass one id exactly as it is printed.",
      );
    }
    selected = inventory.sessions.filter((session) => session.id === selector.id);
    if (selected.length === 0) {
      if (inventory.refusedSessionIds.has(selector.id)) {
        throw new LocalSessionError(
          "That session's entry is a symbolic link or not a regular file, so DocsFab does not follow or delete it.",
          "live-agent-session-entry-unsafe",
          "Inspect the session directory yourself and remove the link, then run docsfab sessions list.",
        );
      }
      throw new LocalSessionError(
        "No local live-agent session has that id, so nothing was deleted.",
        "live-agent-session-not-found",
        "Run docsfab sessions list to see the session ids on this host.",
      );
    }
  } else if (selector.kind === "all") {
    selected = [...inventory.sessions];
  } else {
    selected = inventory.sessions.filter((session) =>
      olderThan(requireIdentity(inventory, session.fileName), selector.days, nowMs),
    );
  }
  const chosen = new Set(selected.map((session) => session.fileName));
  const remaining = new Set(
    inventory.sessions
      .filter((session) => !chosen.has(session.fileName))
      .map((session) => session.repository),
  );
  const touched = new Set(selected.map((session) => session.repository));
  const taskBranchStates = inventory.taskBranchStates.filter((state) => {
    if (selector.kind === "all") return true;
    const known = state.repository !== UNKNOWN_REPOSITORY_LABEL;
    if (known && remaining.has(state.repository)) return false;
    if (known && touched.has(state.repository)) return true;
    return (
      selector.kind === "older-than" &&
      olderThan(
        requireIdentity(inventory, join(TASK_BRANCH_STATE_DIRECTORY, state.fileName)),
        selector.days,
        nowMs,
      )
    );
  });
  const bytes =
    selected.reduce((total, session) => total + session.bytes, 0) +
    taskBranchStates.reduce((total, state) => total + state.bytes, 0);
  const files = [
    ...selected.map((session) => session.fileName),
    ...taskBranchStates.map((state) => join(TASK_BRANCH_STATE_DIRECTORY, state.fileName)),
  ];
  const confirmation =
    files.length === 0
      ? null
      : shortIdentifier(
          "delete",
          canonicalDigest({
            schemaVersion: 1 as const,
            kind: "docsfab-live-agent-session-deletion" as const,
            directory: inventory.directory,
            selector,
            files: files.map((path) => {
              const identity = requireIdentity(inventory, path);
              return {
                path,
                dev: identity.dev,
                ino: identity.ino,
                bytes: identity.bytes,
                mtimeMs: identity.mtimeMs,
              };
            }),
          }),
        );
  return { selector, sessions: selected, taskBranchStates, bytes, confirmation };
}

async function assertDirectoryIdentity(
  path: string,
  expected: { readonly dev: number; readonly ino: number } | null,
): Promise<void> {
  const stat = await lstatOrUndefined(path);
  if (
    !expected ||
    !stat ||
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    stat.dev !== expected.dev ||
    stat.ino !== expected.ino
  ) {
    throw directoryUnsafe();
  }
}

/** Delete exactly the planned files, re-checking each one first. */
export async function applyLocalSessionDeletion(
  inventory: LocalSessionInventoryV1,
  plan: LocalSessionDeletionPlanV1,
): Promise<LocalSessionDeletionResultV1> {
  let sessionsRemoved = 0;
  let taskBranchStatesRemoved = 0;
  let bytesRemoved = 0;
  let alreadyAbsent = 0;
  const incomplete = (reason: string): LocalSessionError =>
    new LocalSessionError(
      `${reason} Removed so far: ${sessionsRemoved} session(s) and ${taskBranchStatesRemoved} task-branch state file(s). Nothing else was deleted.`,
      "live-agent-session-removal-incomplete",
      "Run docsfab sessions list to see what remains, then preview the deletion again.",
    );
  const remove = async (relativePath: string): Promise<boolean> => {
    const identity = requireIdentity(inventory, relativePath);
    const path = join(inventory.directory, relativePath);
    const stat = await lstatOrUndefined(path);
    if (!stat) {
      alreadyAbsent += 1;
      return false;
    }
    if (
      stat.isSymbolicLink() ||
      !stat.isFile() ||
      stat.dev !== identity.dev ||
      stat.ino !== identity.ino ||
      stat.size !== identity.bytes ||
      stat.mtimeMs !== identity.mtimeMs
    ) {
      throw incomplete(
        "A file changed into a link or was replaced after the preview, so DocsFab stopped before deleting it.",
      );
    }
    await unlink(path);
    bytesRemoved += identity.bytes;
    return true;
  };
  if (plan.sessions.length > 0 || plan.taskBranchStates.length > 0) {
    await assertDirectoryIdentity(inventory.directory, inventory.directoryIdentity);
  }
  if (plan.taskBranchStates.length > 0) {
    await assertDirectoryIdentity(
      join(inventory.directory, TASK_BRANCH_STATE_DIRECTORY),
      inventory.taskBranchDirectoryIdentity,
    );
  }
  for (const session of plan.sessions) {
    if (await remove(session.fileName)) sessionsRemoved += 1;
  }
  if (plan.taskBranchStates.length > 0) {
    try {
      await assertDirectoryIdentity(
        join(inventory.directory, TASK_BRANCH_STATE_DIRECTORY),
        inventory.taskBranchDirectoryIdentity,
      );
    } catch {
      throw incomplete(
        "The task-branch directory changed during deletion, so DocsFab stopped before deleting a file there.",
      );
    }
  }
  for (const state of plan.taskBranchStates) {
    if (await remove(join(TASK_BRANCH_STATE_DIRECTORY, state.fileName))) {
      taskBranchStatesRemoved += 1;
    }
  }
  return { sessionsRemoved, taskBranchStatesRemoved, bytesRemoved, alreadyAbsent };
}

/** The effective `liveAgent.sessionMaxAgeDays`, including configuration-root overrides. */
export function resolveSessionMaxAgeDays(environment: NodeJS.ProcessEnv): ResolvedLimit {
  return limit(SESSION_MAX_AGE_DAYS_LIMIT, {
    environment: loadEffectiveLimitEnvironment(environment),
  });
}

export interface LocalSessionSweepResultV1 extends LocalSessionDeletionResultV1 {
  readonly maxAgeDays: number;
}

/** Remove sessions past a positive age bound. Returns null when the bound is 0 (off). */
export async function sweepExpiredLocalSessions(input: {
  readonly directory: string;
  readonly maxAgeDays: number;
  readonly nowMs?: number;
}): Promise<LocalSessionSweepResultV1 | null> {
  if (input.maxAgeDays <= 0) return null;
  const inventory = await inventoryLocalSessions(input);
  const plan = planLocalSessionDeletion(inventory, {
    kind: "older-than",
    days: input.maxAgeDays,
  });
  const result = await applyLocalSessionDeletion(inventory, plan);
  return { ...result, maxAgeDays: input.maxAgeDays };
}

/** The line `docsfab live-agent` prints after a sweep removed something. */
export function formatSessionSweepNotice(result: LocalSessionSweepResultV1): string | undefined {
  if (result.sessionsRemoved === 0 && result.taskBranchStatesRemoved === 0) return undefined;
  return `Removed ${result.sessionsRemoved} local live-agent session(s) and ${result.taskBranchStatesRemoved} task-branch state file(s) last written more than ${result.maxAgeDays} days ago (${formatBytes(result.bytesRemoved)}), as ${SESSION_MAX_AGE_DAYS_LIMIT} configures.`;
}

/**
 * Apply the configured age bound before a live-agent session opens. Off by
 * default; a positive bound is the user's standing consent to remove.
 */
export async function enforceLocalSessionRetention(input: {
  readonly directory: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly nowMs?: number;
  readonly notice: (line: string) => void;
}): Promise<LocalSessionSweepResultV1 | null> {
  const bound = resolveSessionMaxAgeDays(input.environment);
  const result = await sweepExpiredLocalSessions({
    directory: input.directory,
    maxAgeDays: bound.value,
    ...(input.nowMs === undefined ? {} : { nowMs: input.nowMs }),
  });
  const line = result ? formatSessionSweepNotice(result) : undefined;
  if (line) input.notice(line);
  return result;
}

/** Count, size, and oldest age for `docsfab doctor`. Never throws. */
export async function summarizeLocalSessionStorage(input: {
  readonly directory: () => string;
  readonly environment: NodeJS.ProcessEnv;
  readonly nowMs?: number;
}): Promise<LocalSessionStorageSummaryV1> {
  let maxAgeDays: number | null;
  try {
    maxAgeDays = resolveSessionMaxAgeDays(input.environment).value;
  } catch {
    maxAgeDays = null;
  }
  try {
    const inventory = await inventoryLocalSessions({
      directory: input.directory(),
      ...(input.nowMs === undefined ? {} : { nowMs: input.nowMs }),
    });
    const sessions = inventory.sessions;
    return {
      state: inventory.present ? "present" : "absent",
      sessions: sessions.length,
      bytes:
        sessions.reduce((total, session) => total + session.bytes, 0) +
        inventory.taskBranchStates.reduce((total, state) => total + state.bytes, 0),
      oldestAgeDays:
        sessions.length === 0 ? null : Math.max(...sessions.map((session) => session.ageDays)),
      taskBranchStates: inventory.taskBranchStates.length,
      maxAgeDays,
    };
  } catch (error) {
    return {
      state: "unreadable",
      sessions: 0,
      bytes: 0,
      oldestAgeDays: null,
      taskBranchStates: 0,
      maxAgeDays,
      code: error instanceof LocalSessionError ? error.code : "live-agent-session-directory-unsafe",
    };
  }
}

/** Doctor line for the session storage summary. */
export function formatLocalSessionStorageSummary(summary: LocalSessionStorageSummaryV1): string {
  const bound =
    summary.maxAgeDays === null
      ? `automatic removal: invalid ${SESSION_MAX_AGE_DAYS_LIMIT} override`
      : summary.maxAgeDays === 0
        ? `automatic removal: off (${SESSION_MAX_AGE_DAYS_LIMIT} = 0)`
        : `automatic removal: after ${summary.maxAgeDays} days (${SESSION_MAX_AGE_DAYS_LIMIT})`;
  if (summary.state === "unreadable") {
    return `Live-agent sessions: unreadable (${summary.code}); ${bound}`;
  }
  const oldest = summary.oldestAgeDays === null ? "" : `, oldest ${summary.oldestAgeDays} day(s)`;
  return `Live-agent sessions: ${summary.sessions} (${formatBytes(summary.bytes)})${oldest}; ${bound}`;
}

export function formatBytes(bytes: number): string {
  return `${bytes.toLocaleString("en-US")} bytes`;
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
