// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `docsfab sessions`: list and delete local live-agent sessions.
 *
 * Deletion follows the `sources purge` shape: without `--confirm` it previews
 * and changes nothing; the preview prints a token minted over the exact files
 * it would remove, and only that token deletes them. A later, different set of
 * files needs a new preview.
 */
import { resolve } from "node:path";

import { resolveDocsFabLiveAgentSessionDirectory } from "../../config/host-paths.js";
import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../../json-evidence.js";
import {
  applyLocalSessionDeletion,
  formatBytes,
  inventoryLocalSessions,
  LocalSessionError,
  localSessionRepositoryLabel,
  planLocalSessionDeletion,
  resolveSessionMaxAgeDays,
  SESSION_MAX_AGE_DAYS_LIMIT,
  type LocalSessionDeletionPlanV1,
  type LocalSessionInventoryV1,
  type LocalSessionSelectorV1,
  type LocalSessionV1,
} from "../../live-agent/local-sessions.js";
import { assertLocalRepositoryPath } from "../run-arguments.js";

export interface SessionsCommandIoV1 {
  readonly environment?: NodeJS.ProcessEnv;
  readonly write?: (line: string) => void;
  readonly nowMs?: number;
}

export type SessionsArgumentsV1 =
  | { readonly command: "list"; readonly json: boolean; readonly repositoryPath?: string }
  | {
      readonly command: "delete";
      readonly json: boolean;
      readonly selector: LocalSessionSelectorV1;
      readonly confirmation?: string;
    };

const OLDER_THAN_DAYS = /^[1-9][0-9]*$/u;

const RETENTION_NOTE =
  "This removes only local live-agent transcripts and task-branch state. Your repository, its branches, and saved run records are not changed, and DocsFab claims no deletion by any model provider.";
const ACTIVE_SESSION_PREVIEW_NOTE =
  "Close any running docsfab live-agent before deletion. An open conversation can recreate its transcript on the next turn, without its original header.";
const ACTIVE_SESSION_COMPLETION_NOTE =
  "A still-running docsfab live-agent can recreate a deleted transcript on its next turn, without its original header. Close it before deleting again.";

function taskBranchResidual(
  inventory: LocalSessionInventoryV1,
  completed: boolean,
): string | undefined {
  if (inventory.taskBranchDirectoryLeftInPlace === null) return undefined;
  const kind =
    inventory.taskBranchDirectoryLeftInPlace === "symbolic-link" ? "symbolic link" : "unsafe entry";
  return completed
    ? `task-branches/ ${kind} remains. DocsFab did not follow it; any state behind it was not deleted.`
    : `task-branches/ is a ${kind} and will remain. DocsFab will not follow it; any state behind it will not be deleted.`;
}

function invalidArguments(message: string): LocalSessionError {
  return new LocalSessionError(
    message,
    "live-agent-session-arguments-invalid",
    "Run docsfab sessions --help for the accepted forms.",
  );
}

/** Parse `docsfab sessions <subcommand> ...`. */
export function parseSessionsArguments(args: readonly string[]): SessionsArgumentsV1 {
  const [command, ...rest] = args;
  if (command !== "list" && command !== "delete") {
    throw invalidArguments(
      "docsfab sessions takes the subcommand list or delete; nothing was read or deleted.",
    );
  }
  let json = false;
  let repositoryPath: string | undefined;
  let all = false;
  let olderThan: number | undefined;
  let confirmation: string | undefined;
  const operands: string[] = [];
  const value = (index: number, option: string): string => {
    const next = rest[index + 1];
    if (next === undefined || next.startsWith("--")) {
      throw invalidArguments(`The ${option} option needs a value.`);
    }
    return next;
  };
  const once = (seen: boolean, option: string): void => {
    if (seen) throw invalidArguments(`The ${option} option may be passed only once.`);
  };
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index] as string;
    if (token === "--json") {
      once(json, token);
      json = true;
    } else if (command === "list" && token === "--repo") {
      once(repositoryPath !== undefined, token);
      repositoryPath = value(index, token);
      assertLocalRepositoryPath(repositoryPath, "--repo");
      index += 1;
    } else if (command === "delete" && token === "--all") {
      once(all, token);
      all = true;
    } else if (command === "delete" && token === "--older-than") {
      once(olderThan !== undefined, token);
      const days = value(index, token);
      if (!OLDER_THAN_DAYS.test(days) || !Number.isSafeInteger(Number(days))) {
        throw invalidArguments("The --older-than option takes a whole number of days, 1 or more.");
      }
      olderThan = Number(days);
      index += 1;
    } else if (command === "delete" && token === "--confirm") {
      once(confirmation !== undefined, token);
      confirmation = value(index, token);
      index += 1;
    } else if (token.startsWith("-")) {
      throw invalidArguments(
        `docsfab sessions ${command} does not accept that option; nothing was read or deleted.`,
      );
    } else {
      operands.push(token);
    }
  }
  if (command === "list") {
    if (operands.length > 0) {
      throw invalidArguments("docsfab sessions list takes no operands.");
    }
    return { command, json, ...(repositoryPath === undefined ? {} : { repositoryPath }) };
  }
  if (operands.length > 1) {
    throw invalidArguments("docsfab sessions delete takes at most one session id.");
  }
  const selectors = [operands.length === 1, all, olderThan !== undefined].filter(Boolean).length;
  if (selectors !== 1) {
    throw invalidArguments(
      "docsfab sessions delete needs exactly one of: a session id, --all, or --older-than <days>.",
    );
  }
  const selector: LocalSessionSelectorV1 = all
    ? { kind: "all" }
    : olderThan !== undefined
      ? { kind: "older-than", days: olderThan }
      : { kind: "session", id: operands[0] as string };
  return {
    command,
    json,
    selector,
    ...(confirmation === undefined ? {} : { confirmation }),
  };
}

function selectorArguments(selector: LocalSessionSelectorV1): string {
  if (selector.kind === "all") return "--all";
  if (selector.kind === "older-than") return `--older-than ${selector.days}`;
  return selector.id;
}

/** Aligned rows: a header, then one row per session. */
function sessionTable(sessions: readonly LocalSessionV1[]): string[] {
  const rows = [
    ["ID", "AGE", "SIZE", "REPOSITORY"],
    ...sessions.map((session) => [
      session.id,
      `${session.ageDays} day(s)`,
      formatBytes(session.bytes),
      session.repository,
    ]),
  ];
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)));
  return rows.map(
    (row) =>
      `  ${row
        .map((cell, column) => cell.padEnd(widths[column]!))
        .join("  ")
        .trimEnd()}`,
  );
}

function sessionJson(session: LocalSessionV1): JsonEvidenceValue {
  return {
    id: session.id,
    ageDays: session.ageDays,
    bytes: session.bytes,
    modifiedAt: session.modifiedAt,
    repository: session.repository,
  };
}

function boundText(environment: NodeJS.ProcessEnv): string {
  const bound = resolveSessionMaxAgeDays(environment);
  return bound.value === 0
    ? `Automatic removal: off (${SESSION_MAX_AGE_DAYS_LIMIT} = 0). Set DOCSFAB_LIVE_AGENT_SESSION_MAX_AGE_DAYS to remove sessions older than that many days when docsfab live-agent starts.`
    : `Automatic removal: sessions last written more than ${bound.value} days ago are removed when docsfab live-agent starts (${SESSION_MAX_AGE_DAYS_LIMIT}, from ${bound.source}).`;
}

function renderList(
  inventory: LocalSessionInventoryV1,
  sessions: readonly LocalSessionV1[],
  environment: NodeJS.ProcessEnv,
  repositoryLabel: string | undefined,
): string[] {
  const bytes = sessions.reduce((total, session) => total + session.bytes, 0);
  const scope = repositoryLabel === undefined ? "" : ` for ${repositoryLabel}`;
  const lines = [`Session directory: ${inventory.directory}`];
  if (sessions.length === 0) {
    lines.push(`No local live-agent sessions${scope}.`);
  } else {
    const oldest = Math.max(...sessions.map((session) => session.ageDays));
    lines.push(
      `${sessions.length} local live-agent session(s)${scope}, ${formatBytes(bytes)}, oldest ${oldest} day(s). Age counts from the last write.`,
      ...sessionTable(sessions),
    );
  }
  if (inventory.taskBranchStates.length > 0) {
    lines.push(
      `Task-branch state: ${inventory.taskBranchStates.length} file(s); each records one repository's path and is removed with that repository's last session.`,
    );
  }
  const { symbolicLinks, other } = inventory.leftInPlace;
  if (symbolicLinks + other > 0) {
    lines.push(
      `Left in place: ${symbolicLinks} symbolic link(s) and ${other} other entr(ies) that are not session files; DocsFab never follows or deletes them.`,
    );
  }
  lines.push(boundText(environment));
  if (sessions.length > 0) lines.push("NEXT docsfab sessions delete <id>");
  return lines;
}

function renderPlan(
  plan: LocalSessionDeletionPlanV1,
  inventory: LocalSessionInventoryV1,
): string[] {
  const residual = taskBranchResidual(inventory, false);
  if (plan.confirmation === null) {
    return [
      "No local live-agent session or task-branch state matches, so nothing would be deleted.",
      ...(residual === undefined ? [] : [residual]),
    ];
  }
  return [
    `Preview: this would delete ${plan.sessions.length} session(s) and ${plan.taskBranchStates.length} task-branch state file(s), ${formatBytes(plan.bytes)}, from ${inventory.directory}.`,
    ...(plan.sessions.length > 0 ? sessionTable(plan.sessions) : []),
    ...plan.taskBranchStates.map(
      (state) => `  task-branch state for ${state.repository}  ${formatBytes(state.bytes)}`,
    ),
    RETENTION_NOTE,
    ACTIVE_SESSION_PREVIEW_NOTE,
    ...(residual === undefined ? [] : [residual]),
    "Nothing was deleted. To delete exactly this set, run:",
    `  docsfab sessions delete ${selectorArguments(plan.selector)} --confirm ${plan.confirmation}`,
  ];
}

function planJson(plan: LocalSessionDeletionPlanV1): JsonEvidenceValue {
  return {
    sessions: plan.sessions.map(sessionJson),
    taskBranchStates: plan.taskBranchStates.map((state) => ({
      repository: state.repository,
      bytes: state.bytes,
      modifiedAt: state.modifiedAt,
    })),
    bytes: plan.bytes,
    confirmation: plan.confirmation,
  };
}

/** Run one `docsfab sessions` invocation. Stops are thrown as {@link LocalSessionError}. */
export async function handleSessionsCommand(
  args: readonly string[],
  io: SessionsCommandIoV1 = {},
): Promise<void> {
  const environment = io.environment ?? process.env;
  const write = io.write ?? ((line: string) => console.log(line));
  const parsed = parseSessionsArguments(args);
  const directory = resolveDocsFabLiveAgentSessionDirectory(environment);
  const inventory = await inventoryLocalSessions({
    directory,
    ...(io.nowMs === undefined ? {} : { nowMs: io.nowMs }),
  });
  if (parsed.command === "list") {
    const repositoryLabel =
      parsed.repositoryPath === undefined
        ? undefined
        : localSessionRepositoryLabel(resolve(parsed.repositoryPath));
    const sessions =
      repositoryLabel === undefined
        ? inventory.sessions
        : inventory.sessions.filter((session) => session.repository === repositoryLabel);
    if (parsed.json) {
      write(
        canonicalizeJsonEvidence({
          schemaVersion: 1,
          kind: "docsfab-live-agent-session-list",
          directory: inventory.directory,
          sessions: sessions.map(sessionJson),
          taskBranchStates: inventory.taskBranchStates.length,
          leftInPlace: { ...inventory.leftInPlace },
          taskBranchDirectoryLeftInPlace: inventory.taskBranchDirectoryLeftInPlace,
          maxAgeDays: resolveSessionMaxAgeDays(environment).value,
        }).trimEnd(),
      );
      return;
    }
    for (const line of renderList(inventory, sessions, environment, repositoryLabel)) write(line);
    return;
  }
  const plan = planLocalSessionDeletion(inventory, parsed.selector);
  if (parsed.confirmation === undefined || plan.confirmation === null) {
    if (parsed.json) {
      write(
        canonicalizeJsonEvidence({
          schemaVersion: 1,
          kind: "docsfab-live-agent-session-deletion-preview",
          directory: inventory.directory,
          ...(planJson(plan) as Record<string, JsonEvidenceValue>),
          deleted: false,
          activeSessionMayRecreate: true,
          taskBranchDirectoryLeftInPlace: inventory.taskBranchDirectoryLeftInPlace,
        }).trimEnd(),
      );
      return;
    }
    for (const line of renderPlan(plan, inventory)) write(line);
    return;
  }
  if (parsed.confirmation !== plan.confirmation) {
    throw new LocalSessionError(
      "That confirmation does not match what this command would delete now, so nothing was deleted. The sessions changed since the preview, or the confirmation belongs to another preview.",
      "live-agent-session-confirmation-mismatch",
      `Run docsfab sessions delete ${selectorArguments(parsed.selector)} without --confirm to preview again.`,
    );
  }
  const result = await applyLocalSessionDeletion(inventory, plan);
  if (parsed.json) {
    write(
      canonicalizeJsonEvidence({
        schemaVersion: 1,
        kind: "docsfab-live-agent-session-deletion",
        directory: inventory.directory,
        deleted: true,
        activeSessionMayRecreate: true,
        sessionsRemoved: result.sessionsRemoved,
        taskBranchStatesRemoved: result.taskBranchStatesRemoved,
        bytesRemoved: result.bytesRemoved,
        alreadyAbsent: result.alreadyAbsent,
        taskBranchDirectoryLeftInPlace: inventory.taskBranchDirectoryLeftInPlace,
      }).trimEnd(),
    );
    return;
  }
  write(
    `Deleted ${result.sessionsRemoved} session(s) and ${result.taskBranchStatesRemoved} task-branch state file(s), ${formatBytes(result.bytesRemoved)}.`,
  );
  if (result.alreadyAbsent > 0) {
    write(`${result.alreadyAbsent} file(s) in the preview were already gone.`);
  }
  const residual = taskBranchResidual(inventory, true);
  if (residual) write(residual);
  write(ACTIVE_SESSION_COMPLETION_NOTE);
  write(RETENTION_NOTE);
}
