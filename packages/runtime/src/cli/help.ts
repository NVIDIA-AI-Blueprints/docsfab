// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * One help router for every public command and subcommand.
 *
 * `docsfab help <command> [<subcommand>]`, `docsfab <command> --help` or `-h`,
 * `docsfab <command> <subcommand> --help` or `-h`, and a bare command group all
 * resolve here from the public command registry, so a command added to the
 * registry has help without its own parser. Synopses come from the flag-level
 * reference in `usage()`; a command that already owns a longer help text keeps
 * it through {@link COMMAND_HELP_TEXT}.
 */
import {
  findPublicCommand,
  PUBLIC_COMMAND_GROUPS,
  type PublicCommandDefinition,
  type PublicCommandGroup,
  type PublicCommandName,
  type PublicSubcommandDefinition,
} from "./command-registry.js";
import { LIVE_AGENT_USAGE } from "./commands/live-agent.js";
import { runsImportUsage, runsQueryUsage } from "./commands/runs-index.js";
import { SETUP_USAGE } from "./commands/setup.js";
import { SOURCES_COMMAND_USAGE } from "./commands/sources.js";
import { whyUsage } from "./commands/why.js";
import { doHelp, generalHelp, initHelp, runHelp, usage } from "./usage.js";

const HELP_FLAGS: ReadonlySet<string> = new Set(["--help", "-h"]);

/** A help request that names a command or subcommand the registry does not have. */
export class HelpTopicOperatorError extends Error {
  readonly code = "cli-usage";
  readonly nextAction: string;

  constructor(message: string, nextAction: string) {
    super(message);
    this.name = "HelpTopicOperatorError";
    this.nextAction = nextAction;
  }
}

/**
 * Help texts that commands already print for their own `--help`, keyed by the
 * command path. Reusing them keeps `docsfab help <path>` and the command's own
 * help byte-identical.
 */
const COMMAND_HELP_TEXT: Readonly<Record<string, () => string>> = Object.freeze({
  help: generalHelp,
  init: initHelp,
  run: runHelp,
  do: doHelp,
  setup: () => SETUP_USAGE,
  "live-agent": () => LIVE_AGENT_USAGE,
  sources: () => SOURCES_COMMAND_USAGE,
  "runs query": runsQueryUsage,
  "runs import": runsImportUsage,
  why: whyUsage,
});

/** Worked examples a command's generated help appends, keyed by command path. */
const COMMAND_HELP_EXAMPLES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  runs: [
    "Count runs by status across the run index:",
    "  docsfab runs query --where rowKind=run --group-by runStatus",
    "Find the steps and models whose replies were rejected as malformed:",
    "  docsfab runs query --where outcome=malformed-response --group-by stepId,model",
    "Index a local-workflows harness batch, then count its attempt outcomes per case:",
    "  docsfab runs import <harness-batch-directory>",
    "  docsfab runs query --where batchId=<batch-id> --group-by caseKey,outcome",
    "Show one run's steps, failure class, and next action:",
    "  docsfab runs show <run-id>",
    "Preview a saved run's local deletion, then confirm its exact token:",
    "  docsfab runs delete <run-id> --state-dir <path>",
  ],
});

/** A help request resolved to the command path whose help to print. */
export type HelpPath = readonly [PublicCommandName] | readonly [PublicCommandName, string];

/**
 * Returns the command path to print help for, or `undefined` when argv is not a
 * help request. Only the exact help forms are claimed; a help flag mixed with
 * other operands stays with the command, which may print its own help or refuse
 * the combination.
 */
export function resolveHelpRequest(argv: readonly string[]): HelpPath | undefined {
  const [first, ...rest] = argv;
  if (first === undefined) return undefined;
  const command = findPublicCommand(first);
  if (command === undefined) return undefined;
  const name = command.name as PublicCommandName;
  // Help takes no options, so an option token such as `--json` is ignored
  // instead of being read as a topic.
  if (name === "help") return resolveHelpTopic(rest.filter((token) => !token.startsWith("-")));
  const group = PUBLIC_COMMAND_GROUPS[name];
  if (rest.length === 0) return group?.bare === "help" ? [name] : undefined;
  if (rest.length === 1 && HELP_FLAGS.has(rest[0]!)) return [name];
  if (rest.length === 2 && HELP_FLAGS.has(rest[1]!) && findSubcommand(group, rest[0]!)) {
    return [name, rest[0]!];
  }
  return undefined;
}

function resolveHelpTopic(topic: readonly string[]): HelpPath {
  const [commandToken, subcommandToken] = topic;
  if (commandToken === undefined) return ["help"];
  const command = findPublicCommand(commandToken);
  if (command === undefined) {
    throw new HelpTopicOperatorError(
      `Unknown command "${commandToken}"; DocsFab has no help for it.`,
      "Run `docsfab help` to list the commands.",
    );
  }
  const name = command.name as PublicCommandName;
  const group = PUBLIC_COMMAND_GROUPS[name];
  // A non-group command reads its next operand as a workflow, run ID, or
  // sentence, so `help run review-documentation` is the run help.
  if (subcommandToken === undefined || group === undefined) return [name];
  if (!findSubcommand(group, subcommandToken)) {
    throw new HelpTopicOperatorError(
      `Unknown command "${name} ${subcommandToken}"; the docsfab ${name} subcommands are ${subcommandList(group)}.`,
      `Run \`docsfab ${name} --help\` to see each subcommand's purpose.`,
    );
  }
  return [name, subcommandToken];
}

function findSubcommand(
  group: PublicCommandGroup | undefined,
  name: string,
): PublicSubcommandDefinition | undefined {
  return group?.subcommands.find((subcommand) => subcommand.name === name);
}

function subcommandList(group: PublicCommandGroup): string {
  const names = group.subcommands.map((subcommand) => subcommand.name);
  return names.length === 1
    ? names[0]!
    : `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]!}`;
}

/** The help text for one command path, without a trailing newline. */
export function renderCommandHelp(path: HelpPath): string {
  const key = path.join(" ");
  const owned = COMMAND_HELP_TEXT[key];
  if (owned) return withoutTrailingNewlines(owned());
  const [name, subcommandName] = path;
  const command = findPublicCommand(name) as PublicCommandDefinition;
  const group = PUBLIC_COMMAND_GROUPS[name];
  const subcommand =
    subcommandName === undefined ? undefined : findSubcommand(group, subcommandName);
  const commandOwned = COMMAND_HELP_TEXT[name];
  // A subcommand the reference documents only inside its command's own help
  // (the `sources` verbs) prints that help under its one-line purpose.
  if (subcommand && commandOwned && commandSynopses(path).length === 0) {
    return `docsfab ${key}: ${subcommand.description}\n\n${withoutTrailingNewlines(commandOwned())}`;
  }
  const lines = [
    `docsfab ${key}: ${(subcommand ?? command).description}`,
    "",
    "Usage:",
    ...commandSynopses(path).flatMap((synopsis) => synopsis.lines),
  ];
  if (group && !subcommand) {
    const width = Math.max(...group.subcommands.map((entry) => entry.name.length));
    lines.push(
      "",
      "Subcommands:",
      ...group.subcommands.map((entry) => `  ${entry.name.padEnd(width)}  ${entry.description}`),
    );
  }
  const examples = COMMAND_HELP_EXAMPLES[key];
  if (examples) lines.push("", "Examples:", ...examples.map((line) => `  ${line}`));
  if (group && !subcommand) {
    lines.push(
      "",
      `Run "docsfab ${name} <subcommand> --help" or "docsfab help ${name} <subcommand>" for one subcommand.`,
    );
  } else if (subcommand) {
    lines.push("", `Run "docsfab ${name} --help" to list every ${name} subcommand.`);
  }
  return lines.join("\n");
}

function withoutTrailingNewlines(text: string): string {
  return text.replace(/\n+$/u, "");
}

/** One `docsfab ...` synopsis from the reference usage, with its continuation lines. */
export interface CommandSynopsis {
  /** Operands before the first option or placeholder, for example `["runs", "query"]`. */
  readonly path: readonly string[];
  readonly lines: readonly string[];
}

/**
 * Splits the `Usage:` section of `usage()` into synopses. A synopsis starts at a
 * line indented two spaces that begins with `docsfab `; a line indented four or
 * more spaces continues it; any other line ends it.
 */
export function referenceSynopses(reference: string = usage()): readonly CommandSynopsis[] {
  const section = reference.split("\n\nConfiguration:")[0]!.split("\nUsage:\n")[1] ?? "";
  const synopses: { path: string[]; lines: string[] }[] = [];
  let current: { path: string[]; lines: string[] } | undefined;
  for (const line of section.split("\n")) {
    if (line.startsWith("  docsfab ")) {
      current = { path: synopsisPath(line), lines: [line] };
      synopses.push(current);
    } else if (current && line.startsWith("    ")) {
      current.lines.push(line);
    } else {
      current = undefined;
    }
  }
  return synopses;
}

function synopsisPath(line: string): string[] {
  const path: string[] = [];
  for (const token of line.trim().split(/\s+/u).slice(1)) {
    if (!/^[a-z][a-z0-9-]*$/u.test(token)) break;
    path.push(token);
  }
  return path;
}

function commandSynopses(path: HelpPath): readonly CommandSynopsis[] {
  return referenceSynopses().filter((synopsis) =>
    path.every((segment, index) => synopsis.path[index] === segment),
  );
}
