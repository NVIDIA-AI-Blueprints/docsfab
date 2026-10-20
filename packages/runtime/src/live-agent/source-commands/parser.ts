// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { SOURCE_COMMAND_VERBS, failSourceCommand, type SourceCommandVerbV1 } from "./contracts.js";

/** One parsed `/sources` line. The argument is the operator's literal text. */
export interface SourceCommandInvocationV1 {
  readonly verb: SourceCommandVerbV1;
  /** Everything after the verb, surrounding spaces removed and nothing else. */
  readonly argument: string | null;
}

const REQUIRES_ARGUMENT: ReadonlySet<SourceCommandVerbV1> = new Set([
  "add",
  "show",
  "remove",
  // A purge with no argument is not "purge everything": it names its sessions
  // or does nothing.
  "purge",
  "review",
]);

const FORBIDS_ARGUMENT: ReadonlySet<SourceCommandVerbV1> = new Set(["list"]);

/** Control characters and the separators a literal argument may never carry. */
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f]/u;

/**
 * Parse one terminal line.
 *
 * Returns `undefined` when the line is not addressed to this family, so it
 * goes to the model unchanged; throws when a `/sources` line cannot be
 * honoured, because silently ignoring an unknown verb would imply success.
 * The prefix must be followed by a space or end of line. The verb is the first
 * run of non-space characters; the argument is literally the rest.
 */
export function parseSourceCommand(
  line: unknown,
  prefix: string,
  lineLimit: number,
): SourceCommandInvocationV1 | undefined {
  if (typeof line !== "string") return undefined;
  if (line !== prefix && !line.startsWith(`${prefix} `)) {
    return undefined;
  }
  if (line.length > lineLimit) failSourceCommand("malformed-command");
  if (CONTROL_CHARACTERS.test(line) || line !== line.normalize("NFC")) {
    failSourceCommand("malformed-command");
  }
  const rest = line.slice(prefix.length).trim();
  if (rest.length === 0) return Object.freeze({ verb: "list" as const, argument: null });
  const boundary = rest.indexOf(" ");
  const verb = boundary === -1 ? rest : rest.slice(0, boundary);
  // One literal argument: not split, unquoted, expanded, or globbed.
  const argument = boundary === -1 ? null : rest.slice(boundary + 1).trim();
  if (!(SOURCE_COMMAND_VERBS as readonly string[]).includes(verb)) {
    failSourceCommand("unknown-verb");
  }
  const named = verb as SourceCommandVerbV1;
  if (argument !== null && argument.length === 0) failSourceCommand("malformed-command");
  if (argument === null && REQUIRES_ARGUMENT.has(named)) failSourceCommand("missing-argument");
  if (argument !== null && FORBIDS_ARGUMENT.has(named)) failSourceCommand("unexpected-argument");
  return Object.freeze({ verb: named, argument });
}

/** True when the line addresses this family, whatever the rest of it says. */
export function isSourceCommandLine(line: unknown, prefix: string): boolean {
  return typeof line === "string" && (line === prefix || line.startsWith(`${prefix} `));
}
