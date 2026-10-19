// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `docsfab sources`: the shell surface of the live terminal's source commands.
 *
 * It owns no verbs, selection state, listing text, or refusal sentences, so the
 * two surfaces cannot drift. Operands become the exact `/sources <verb>
 * <argument>` line and go to the same {@link LiveAgentSourceSelection.dispatch};
 * `--source` and `--pr`/`--mr` go through {@link admitCliSourceSelection}, the
 * admission `run`, `do`, and `live-agent` share. The selection lives in this
 * process and is written nowhere, so every successful verb prints
 * {@link SOURCES_PROCESS_SCOPE_NOTE} after the shared rendering.
 *
 * Where argv differs from a terminal line: a token beginning with `--` is
 * always an option and an unknown one is refused, and `-h`/`--help` are read as
 * help anywhere, so those names cannot be selected here; the live terminal
 * accepts them.
 * Operands after the verb are joined with one space, as the rest of a terminal
 * line is; DocsFab expands, unquotes, and globs nothing.
 */
import { stat } from "node:fs/promises";
import { resolve } from "node:path";

import {
  admitCliSourceSelection,
  assertLocalRepositoryPath,
  CHANGE_REQUEST_SELECTOR_OPTIONS,
} from "../run-arguments.js";
import {
  createLiveAgentSourcePorts,
  liveAgentSourceCommandRefusal,
} from "../../live-agent/host.js";
import {
  createLiveAgentSourceSelection,
  SOURCE_COMMAND_PREFIX,
  SOURCE_REVALIDATION_STATE_MESSAGES,
  type LiveAgentSourcePortsV1,
  type LiveAgentSourceSelection,
  type SourceCommandOutcomeV1,
} from "../../live-agent/source-commands.js";
import type { CommandRunner } from "../../init/types.js";
import { renderCliPresentation } from "../presentation.js";
import {
  projectSourceCommandOutcome,
  projectSourceCommandRefusal,
} from "../../live-agent/source-presentation.js";

const REPOSITORY_OPTION = "--repo";

const SOURCE_OPTION = "--source";

const HELP_OPTIONS = ["--help", "-h"] as const;

/**
 * Options that consume a following value, listed so the scan skips their
 * values. The shared admission validates `--source` and the merge-request
 * spellings; `--repo` is validated in this file.
 */
const VALUE_OPTIONS: readonly string[] = Object.freeze([
  REPOSITORY_OPTION,
  SOURCE_OPTION,
  ...CHANGE_REQUEST_SELECTOR_OPTIONS,
]);

/**
 * Stops for conditions a terminal line cannot express, so none overlaps
 * `SOURCE_COMMAND_REFUSALS`. Everything else is refused by the shared
 * dispatcher.
 */
export const SOURCES_CLI_REFUSAL_CODES = [
  "unknown-option",
  "repository-option-value-missing",
  "repository-option-repeated",
  "repository-not-local",
  "repository-unavailable",
  "help-not-combinable",
] as const;

export type SourcesCliRefusalCodeV1 = (typeof SOURCES_CLI_REFUSAL_CODES)[number];

/**
 * Condition, then the action that clears it. Content-free: refusals land in
 * transcripts and tickets, so none interpolates the typed token, the path it
 * named, or any byte read from the checkout.
 */
export const SOURCES_CLI_REFUSALS: Readonly<Record<SourcesCliRefusalCodeV1, string>> =
  Object.freeze({
    "unknown-option":
      "That is not an option this command accepts, and DocsFab refuses an option it does not recognize rather than ignoring it and acting on a selection you did not type. This command accepts --repo, --source, --pr or --mr, and --help; a verb and its argument are written without leading dashes. Retype the command with the accepted options, then run it again.",
    "repository-option-value-missing":
      "The repository option was passed without a local directory path, so no checkout was selected. Write the repository option followed by the path to the checkout you mean, then run the command again.",
    "repository-option-repeated":
      "The repository option was passed more than once, and this command reads exactly one checkout. Pass it once, naming the checkout the sources belong to.",
    "repository-not-local":
      "The repository option must name a local directory, not a Git URL. Clone the repository first, then pass the path to that clone.",
    "repository-unavailable":
      "The selected repository path is not an existing local directory, so there is no checkout for a source to be named relative to and nothing was read. Check the path, then run the command again.",
    "help-not-combinable":
      "Help for this command must be requested on its own, because printing help beside a verb would leave it unclear whether the verb ran. Run the command with only the help option to read it, then run the command you meant separately.",
  });

export class SourcesCliOptionError extends Error {
  public constructor(public readonly code: SourcesCliRefusalCodeV1) {
    super(SOURCES_CLI_REFUSALS[code]);
    this.name = "SourcesCliOptionError";
  }
}

export function failSourcesCliOption(code: SourcesCliRefusalCodeV1): never {
  throw new SourcesCliOptionError(code);
}

/**
 * The one note this surface adds to the shared rendering, so a one-shot
 * selection never reads as affecting another process.
 */
export const SOURCES_PROCESS_SCOPE_NOTE =
  "This selection is held for this one command and is written nowhere: no other DocsFab process, saved run, or live-agent conversation can read it. Pass the same --source and --pr options to the command that does the work, or manage a conversation's evidence with the source command inside docsfab live-agent. A purge is the one exception: what it deletes and the custody record it appends are durable and outlive this command.\n";

export const SOURCES_COMMAND_USAGE = `Inspect and manage the sources one DocsFab invocation binds

Usage:
  docsfab sources [list] [--repo <path>]
    [--source <repository-relative-path>]... [--pr | --mr <url-or-reference>]
  docsfab sources add <repository-relative-path-or-merge-request> [options]
  docsfab sources show <label> [options]
  docsfab sources refresh [<label>] [options]
  docsfab sources revalidate [<label>] [options]
  docsfab sources review <pull-or-merge-request-reference> [options]
  docsfab sources remove <label> [options]
  docsfab sources search [<count>] [options]
  docsfab sources purge <session>[,<session>...] [<confirmation>] [options]

Verbs:
  list              List every selected source with its format, status, version,
                    limitations, and how this invocation has used it.
  add               Select one tracked repository path, or one already-merged
                    merge request by URL, host/group/project!number, or number.
  show              Show one selected source, with a bounded preview of a
                    tracked file read at the selected revision.
  refresh           Re-read the selected tracked files and report version drift,
                    adopting the version each file has now.
  revalidate        Re-check each selected source against the live repository or
                    forge and report one coded state: fresh, stale, missing,
                    unreadable, or identity-changed. It adopts nothing and
                    detaches nothing, so a source it reports as stale stays stale
                    until you refresh or remove it. A source that is present and
                    could not be read is unreadable, never missing, and the other
                    sources are still re-checked.
  review            Select one supported pull or merge request as the review
                    basis for this command. This one-shot selection is not saved;
                    pass --pr to the command that performs the bounded work.
  remove            Deselect exactly one source. It deletes nothing anywhere and
                    writes no custody record; only this invocation stops binding
                    the source.
  search            Discover merged changes, when this release wires a searcher.
  purge             Delete the owned local copies a custody store holds for the
                    named sessions, and append a custody record saying what was
                    deleted, when, why and from which entry point. Run without a
                    confirmation it previews only: which copies would go, which
                    runs referenced them, and what stays retained. Deleting needs
                    the confirmation that preview prints, which covers that exact
                    set of copies. Removing an attachment, invalidating a cache
                    and purging a session are three different operations and the
                    preview names all three. Your own files and independently
                    retained run evidence are outside the deletion, and no
                    erasure by an external model provider is claimed.

Options:
  --repo <path>     Checkout the sources are named relative to (default: current directory)
  --source <path>   Select one tracked repository path before the verb runs (repeatable)
  --pr, --mr <url-or-reference>
                    Select one already-merged merge request before the verb runs.
                    Two spellings of one option; pass either, once.
  --help, -h        Print this help and exit successfully.

This command answers with the same verbs, the same listing, and the same coded
refusals the live terminal's source command answers with, over the same
selection state. Every verb but purge only reads: the selection it assembles
lives in this process only, so use --source and --pr on docsfab run, docsfab do,
or docsfab live-agent to bind the same evidence to work. Purge is the one verb
that changes something outside this process, and it does so only against the
confirmation its own preview printed.

A label is exactly what the listing printed, matched byte for byte. An argument
is read literally: DocsFab performs no shell expansion, no command substitution,
and no globbing on it. An option this command does not accept stops it instead
of being ignored, so a source named -h, --help, or anything beginning with two
dashes cannot be named here; name it inside docsfab live-agent instead.
`;

export interface SourcesCommandResultV1 {
  /**
   * Present even when the verb was refused, so a caller can prove the refusal
   * changed nothing; absent when the invocation stopped before a selection
   * existed, or on a help request.
   */
  readonly selection?: LiveAgentSourceSelection;
  readonly outcome?: SourceCommandOutcomeV1;
  /** Exactly the bytes written, to stdout on success or stderr on a stop. */
  readonly text: string;
  readonly refused: boolean;
}

export interface SourcesCommandIoV1 {
  readonly cwd?: string;
  readonly write?: (text: string) => void;
  readonly writeError?: (text: string) => void;
  readonly environment?: NodeJS.ProcessEnv;
  /** Forge transport; defaults to the host `glab`. Tests substitute a fake forge. */
  readonly commands?: CommandRunner;
  /** Test seam; the shipped command builds the ports from the selected repository. */
  readonly ports?: LiveAgentSourcePortsV1;
}

/** Assemble the exact terminal line these operands describe, for the one shared parser. */
export function sourcesCommandLine(operands: readonly string[]): string {
  const [verb, ...rest] = operands;
  const argument = rest.join(" ");
  return [
    SOURCE_COMMAND_PREFIX,
    ...(verb === undefined ? [] : [verb]),
    ...(argument.length === 0 ? [] : [argument]),
  ].join(" ");
}

function scanSourcesArguments(args: readonly string[]): {
  repository: string | null;
  operands: readonly string[];
} {
  const operands: string[] = [];
  let repository: string | null = null;
  const selectRepository = (value: string | undefined): void => {
    if (value === undefined || value.length === 0 || value.startsWith("--")) {
      failSourcesCliOption("repository-option-value-missing");
    }
    if (repository !== null) failSourcesCliOption("repository-option-repeated");
    repository = value;
  };
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index] as string;
    if (!token.startsWith("--")) {
      operands.push(token);
      continue;
    }
    const attached = VALUE_OPTIONS.find((option) => token.startsWith(`${option}=`));
    if (attached !== undefined) {
      // One token, so no following argument is consumed. The shared admission
      // has already validated the source and selector forms.
      if (attached === REPOSITORY_OPTION) selectRepository(token.slice(attached.length + 1));
      continue;
    }
    if (VALUE_OPTIONS.includes(token)) {
      if (token === REPOSITORY_OPTION) selectRepository(args[index + 1]);
      index += 1;
      continue;
    }
    failSourcesCliOption("unknown-option");
  }
  return { repository, operands };
}

async function resolveSelectedRepository(value: string): Promise<string> {
  try {
    assertLocalRepositoryPath(value, REPOSITORY_OPTION);
  } catch {
    failSourcesCliOption("repository-not-local");
  }
  const repositoryPath = resolve(value);
  try {
    if ((await stat(repositoryPath)).isDirectory()) return repositoryPath;
  } catch {
    failSourcesCliOption("repository-unavailable");
  }
  failSourcesCliOption("repository-unavailable");
}

/**
 * Render a stop raised while reading argv. Relayed as written, as the other
 * entrypoints do for the same admission: those sentences are DocsFab's own and
 * content-free, and `contextPath` names the option, not the refused path. A
 * non-`Error` throw falls back to the shared withheld-diagnostic line.
 */
function sourcesAdmissionRefusalText(caught: unknown): string {
  return caught instanceof Error ? caught.message : liveAgentSourceCommandRefusal(caught);
}

/**
 * Render a stop raised while the verb ran, with the live terminal's formatter:
 * coded families are relayed and any other diagnostic, which can carry a host
 * path or file fragment, is withheld.
 */
function sourcesDispatchRefusalText(caught: unknown): string {
  return liveAgentSourceCommandRefusal(caught);
}

/** Run one `docsfab sources` invocation. Refusals are written with exit code 1, not thrown. */
export async function handleSourcesCommand(
  args: string[],
  io: SourcesCommandIoV1 = {},
): Promise<SourcesCommandResultV1> {
  const write = io.write ?? ((text: string) => process.stdout.write(text));
  const writeError = io.writeError ?? ((text: string) => process.stderr.write(text));
  const stop = (text: string, selection?: LiveAgentSourceSelection): SourcesCommandResultV1 => {
    const rendered = renderCliPresentation(projectSourceCommandRefusal(text));
    const stdout = rendered.stdout === "\n" ? "" : rendered.stdout;
    if (stdout.length > 0) write(stdout);
    if (rendered.stderr.length > 0) writeError(rendered.stderr);
    process.exitCode = 1;
    return {
      ...(selection ? { selection } : {}),
      text: `${stdout}${rendered.stderr}`,
      refused: true,
    };
  };
  let selection: LiveAgentSourceSelection;
  let line: string;
  try {
    if (args.some((argument) => (HELP_OPTIONS as readonly string[]).includes(argument))) {
      if (args.length !== 1) failSourcesCliOption("help-not-combinable");
      write(SOURCES_COMMAND_USAGE);
      return { text: SOURCES_COMMAND_USAGE, refused: false };
    }
    const admitted = admitCliSourceSelection(args);
    const { repository, operands } = scanSourcesArguments(args);
    const repositoryPath = await resolveSelectedRepository(repository ?? io.cwd ?? process.cwd());
    line = sourcesCommandLine(operands);
    selection = createLiveAgentSourceSelection({
      ...(admitted.sourcePaths.length > 0 ? { sourcePaths: admitted.sourcePaths } : {}),
      ...(admitted.changeRequestSelector
        ? { changeRequestSelector: admitted.changeRequestSelector }
        : {}),
      ports:
        io.ports ??
        createLiveAgentSourcePorts({
          repositoryPath,
          environment: io.environment ?? process.env,
          ...(io.commands ? { commands: io.commands } : {}),
          // Recorded in custody records but not rendered, so both surfaces
          // still print the same bytes.
          entryPoint: "cli",
        }),
    });
  } catch (caught) {
    return stop(sourcesAdmissionRefusalText(caught));
  }
  try {
    const outcome = await selection.dispatch(line);
    if (!outcome) {
      // Unreachable while the line carries the family's prefix. Fail closed:
      // printing nothing with success would read as "no sources attached".
      throw new Error("The assembled source command line was not claimed by the dispatcher.");
    }
    const document = projectSourceCommandOutcome(outcome, SOURCE_REVALIDATION_STATE_MESSAGES);
    const rendered = renderCliPresentation(document);
    // This process-scope note is a contract suffix, not a row in the shared
    // semantic document. Keeping it byte-exact preserves the CLI/live
    // rendering differential while making the one-shot authority boundary
    // explicit after the common result.
    const stdout = `${rendered.stdout}${SOURCES_PROCESS_SCOPE_NOTE}`;
    if (stdout.length > 0) write(stdout);
    if (rendered.stderr.length > 0) writeError(rendered.stderr);
    const text = `${stdout}${rendered.stderr}`;
    return { selection, outcome, text, refused: false };
  } catch (caught) {
    return stop(sourcesDispatchRefusalText(caught), selection);
  }
}
