// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PUBLIC_COMMAND_GROUPS,
  PUBLIC_COMMAND_REGISTRY,
  type PublicCommandName,
} from "../src/cli/command-registry.js";
import {
  referenceSynopses,
  renderCommandHelp,
  resolveHelpRequest,
  type HelpPath,
} from "../src/cli/help.js";
import { LIVE_AGENT_USAGE } from "../src/cli/commands/live-agent.js";
import { runsImportUsage, runsQueryUsage } from "../src/cli/commands/runs-index.js";
import { SETUP_USAGE } from "../src/cli/commands/setup.js";
import { SOURCES_COMMAND_USAGE } from "../src/cli/commands/sources.js";
import { whyUsage } from "../src/cli/commands/why.js";
import { main } from "../src/cli/router.js";
import { doHelp, generalHelp, initHelp, runHelp, usage } from "../src/cli/usage.js";
import { SOURCE_COMMAND_VERBS } from "../src/live-agent/source-commands.js";
import { toOperatorErrorEnvelope } from "../src/operator/error-envelope.js";

const originalArgv = process.argv;

afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

interface CliOutcome {
  readonly output: string;
  readonly error?: unknown;
  readonly exitCode: number;
}

async function runCli(args: readonly string[]): Promise<CliOutcome> {
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((value: unknown) => {
    lines.push(String(value));
  });
  vi.spyOn(console, "error").mockImplementation((value: unknown) => {
    lines.push(String(value));
  });
  process.argv = [originalArgv[0]!, originalArgv[1]!, ...args];
  process.exitCode = undefined;
  let error: unknown;
  try {
    await main();
  } catch (caught) {
    error = caught;
  }
  const exitCode = Number(process.exitCode ?? (error === undefined ? 0 : 1));
  vi.restoreAllMocks();
  return {
    output: lines.join("\n"),
    ...(error === undefined ? {} : { error }),
    exitCode,
  };
}

function commandPaths(): HelpPath[] {
  const paths: HelpPath[] = [];
  for (const command of PUBLIC_COMMAND_REGISTRY) {
    const name = command.name as PublicCommandName;
    paths.push([name]);
    for (const subcommand of PUBLIC_COMMAND_GROUPS[name]?.subcommands ?? []) {
      paths.push([name, subcommand.name]);
    }
  }
  return paths;
}

function helpForms(path: HelpPath): readonly (readonly string[])[] {
  return [
    [...path, "--help"],
    [...path, "-h"],
    ["help", ...path],
  ];
}

/** Help texts a command prints for itself; the router must print them unchanged. */
const OWNED_HELP: Readonly<Record<string, () => string>> = {
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
};

/**
 * The raw `usage()` synopsis blocks, sliced here rather than through the help
 * module's parser so that a parser regression cannot move the expectation with
 * the output. A block is a line `  docsfab ...` plus every following line
 * indented four or more spaces.
 */
function rawUsageBlocks(): string[][] {
  const reference = usage();
  const start = reference.indexOf("\nUsage:\n");
  const end = reference.indexOf("\n\nConfiguration:");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const blocks: string[][] = [];
  let block: string[] | undefined;
  for (const line of reference.slice(start + "\nUsage:\n".length, end).split("\n")) {
    if (line.startsWith("  docsfab ")) {
      block = [line];
      blocks.push(block);
    } else if (block && line.startsWith("    ")) {
      block.push(line);
    } else {
      block = undefined;
    }
  }
  return blocks;
}

function blockIsFor(block: readonly string[], path: readonly string[]): boolean {
  const head = `  docsfab ${path.join(" ")}`;
  return block[0] === head || block[0]!.startsWith(`${head} `);
}

/**
 * Problems with one path's printed help, judged against the help a command
 * owns or, for generated help, against that path's raw `usage()` blocks: every
 * non-empty line of its own blocks appears verbatim, and no sibling
 * subcommand's first line does.
 */
function helpContentProblems(path: HelpPath, output: string): string[] {
  const key = path.join(" ");
  const owned = OWNED_HELP[key] ?? (path.length === 2 ? OWNED_HELP[path[0]] : undefined);
  if (owned) {
    return output.includes(owned().trimEnd()) ? [] : [`does not print the help ${key} owns`];
  }
  const printed = new Set(output.split("\n"));
  const blocks = rawUsageBlocks();
  const own = blocks.filter((block) => blockIsFor(block, path));
  if (own.length === 0) return [`has no usage() synopsis to compare with`];
  const problems = own
    .flat()
    .filter((line) => line.trim() !== "" && !printed.has(line))
    .map((line) => `is missing its usage line ${JSON.stringify(line.trim())}`);
  if (path.length === 2) {
    for (const block of blocks) {
      if (blockIsFor(block, [path[0]]) && !blockIsFor(block, path) && printed.has(block[0]!)) {
        problems.push(`prints sibling usage ${JSON.stringify(block[0]!.trim())}`);
      }
    }
  }
  return problems;
}

describe("help for every registered command and subcommand", () => {
  it("describes read-only review --change without widening source or PR selection", () => {
    const changeHelp = runHelp()
      .split("  --change <range-or-change-request>")[1]
      ?.split("\n\n--patch-only")[0];
    expect(changeHelp).toContain("read-only review-documentation");
    expect(changeHelp).toContain("Write workflows may combine it with --source; review cannot.");
    expect(changeHelp).toContain("Do not combine with --pr or --mr.");
  });
  it("documents provider-free answer-record planning and its exact live ledger selector", () => {
    const doctorHelp = renderCommandHelp(["doctor"]);
    expect(doctorHelp).toContain("--answer-record-qualification-plan");
    expect(doctorHelp).toContain("--answer-record-observation-dir <ledger-dir>");
    expect(doctorHelp).toContain("--answer-record-qualification-cells");
    expect(doctorHelp).toContain("--answer-record-qualification-fingerprint <sha256>");
    expect(doctorHelp).toContain("provider-free exact A/B/C cell plan");
  });

  it("answers --help, -h, and help <path> with that path's usage and exit 0", async () => {
    const failures: string[] = [];
    const paths = commandPaths();
    expect(paths.length).toBeGreaterThan(PUBLIC_COMMAND_REGISTRY.length);
    for (const path of paths) {
      const outputs = new Set<string>();
      for (const argv of helpForms(path)) {
        const outcome = await runCli(argv);
        const label = `docsfab ${argv.join(" ")}`;
        if (outcome.error !== undefined || outcome.exitCode !== 0) {
          failures.push(`${label}: exit ${outcome.exitCode}: ${String(outcome.error)}`);
          continue;
        }
        outputs.add(outcome.output);
        for (const problem of helpContentProblems(path, outcome.output)) {
          failures.push(`${label}: ${problem}`);
        }
      }
      if (outputs.size > 1) failures.push(`docsfab ${path.join(" ")}: help forms disagree`);
    }
    expect(failures).toEqual([]);
  });

  it("prints a subcommand's own usage and not its siblings'", async () => {
    const show = await runCli(["runs", "show", "--help"]);
    expect(show.exitCode).toBe(0);
    expect(show.output).toContain("docsfab runs show <run-id>");
    expect(show.output).not.toContain("docsfab runs list");
    expect(show.output).not.toContain("docsfab runs import");

    const probe = await runCli(["profile", "probe", "-h"]);
    expect(probe.exitCode).toBe(0);
    expect(probe.output).toContain("docsfab profile probe --route <id> --model <id>");
    expect(probe.output).not.toContain("docsfab profile draft");

    const inspect = await runCli(["help", "config", "inspect"]);
    expect(inspect.exitCode).toBe(0);
    expect(inspect.output).toMatch(/^Usage:\n {2}docsfab config inspect \[--json\]$/mu);

    const compare = await runCli(["composition", "compare", "--help"]);
    expect(compare.exitCode).toBe(0);
    expect(compare.output).toContain("docsfab composition compare --record");
    expect(compare.output).not.toContain("docsfab composition preflight");
  });

  it("keeps a subcommand's continuation lines in its usage", async () => {
    const approve = await runCli(["profile", "approve", "--help"]);
    expect(approve.exitCode).toBe(0);
    const approveLines = approve.output.split("\n");
    expect(approveLines).toContain("    --effective-date <YYYY-MM-DD> --review-after <YYYY-MM-DD>");
    expect(approveLines).toContain(
      "    --authority-id <id> --public-key <owner-only-pem> --private-key <owner-only-pem>",
    );
    expect(approveLines).toContain(
      "    --apply --confirm-bundle-sha256 <digest> --confirm-patch-sha256 <digest>",
    );

    const apply = await runCli(["roadmap-issues", "apply", "-h"]);
    expect(apply.exitCode).toBe(0);
    const applyLines = apply.output.split("\n");
    expect(applyLines).toContain("    --authorization <private-json> --receipt <private-json>");
    expect(applyLines).toContain(
      "    --confirm-plan-sha256 <digest> --confirm-authorization-sha256 <digest> [--json]",
    );

    const show = await runCli(["help", "runs", "show"]);
    expect(show.exitCode).toBe(0);
    expect(show.output.split("\n")).toContain(
      "    [--canon-snapshot <path> --accept-candidate-snapshot --authority-id <id>]",
    );
  });

  it("prints the catalog when help has only option tokens", async () => {
    for (const argv of [
      ["help", "--json"],
      ["--help", "--json"],
    ]) {
      const outcome = await runCli(argv);
      expect(outcome.error).toBeUndefined();
      expect(outcome.exitCode).toBe(0);
      expect(outcome.output).toBe(generalHelp().trimEnd());
    }
    const config = await runCli(["help", "config", "--json"]);
    expect(config.error).toBeUndefined();
    expect(config.output).toContain("docsfab config inspect [--json]");
  });

  it("lists the subcommands of a bare command group and exits 0", async () => {
    const bareGroups = Object.entries(PUBLIC_COMMAND_GROUPS).filter(
      ([, group]) => group.bare === "help",
    );
    expect(bareGroups.map(([name]) => name)).toEqual(
      expect.arrayContaining(["runs", "config", "profile", "composition"]),
    );
    for (const [name, group] of bareGroups) {
      const outcome = await runCli([name]);
      expect(outcome.error).toBeUndefined();
      expect(outcome.exitCode).toBe(0);
      expect(outcome.output).toBe(renderCommandHelp([name as PublicCommandName]));
      expect(outcome.output).toContain("Subcommands:");
      const lines = outcome.output.split("Subcommands:\n")[1]!.split("\n");
      for (const subcommand of group.subcommands) {
        const row = lines.find((line) => line.trim().startsWith(`${subcommand.name} `));
        expect(row).toContain(subcommand.description);
      }
    }
  });

  it("shows query and import usage with examples in runs help", () => {
    const help = renderCommandHelp(["runs"]);
    expect(help).toContain("docsfab runs query [--where <field>=<value>]");
    expect(help).toContain("docsfab runs import <harness-batch|state-dir|record>");
    expect(help).toContain("Examples:");
    expect(help).toMatch(/^ {4}docsfab runs query --where \S+=\S+ --group-by \S+$/mu);
    expect(help).toMatch(/^ {4}docsfab runs import <harness-batch-directory>$/mu);
  });
});

describe("help drift against the flag-level reference", () => {
  it("documents every registered command and group subcommand with a synopsis", () => {
    const documented = new Set(
      referenceSynopses().flatMap((synopsis) =>
        synopsis.path.map((_, index) => synopsis.path.slice(0, index + 1).join(" ")),
      ),
    );
    const missing = commandPaths()
      .map((path) => path.join(" "))
      .filter((path) => !documented.has(path))
      // The live terminal owns the source verbs; `sources --help` documents each one.
      .filter((path) => !path.startsWith("sources "));
    expect(missing).toEqual([]);
  });

  it("names only registered commands and declared subcommands in the reference", () => {
    const registered = new Set(PUBLIC_COMMAND_REGISTRY.map((command) => command.name));
    const unknown: string[] = [];
    for (const synopsis of referenceSynopses()) {
      const [name, subcommand] = synopsis.path;
      if (name === undefined || !registered.has(name)) {
        unknown.push(synopsis.lines[0]!);
        continue;
      }
      const group = PUBLIC_COMMAND_GROUPS[name as PublicCommandName];
      if (group && subcommand !== undefined) {
        if (!group.subcommands.some((entry) => entry.name === subcommand)) {
          unknown.push(synopsis.lines[0]!);
        }
      }
    }
    expect(unknown).toEqual([]);
  });

  it("declares exactly the live terminal's source verbs as sources subcommands", () => {
    expect(PUBLIC_COMMAND_GROUPS.sources?.subcommands.map((entry) => entry.name)).toEqual([
      ...SOURCE_COMMAND_VERBS,
    ]);
  });
});

describe("help request resolution", () => {
  it("leaves a help flag combined with other operands to the command", () => {
    expect(resolveHelpRequest(["setup", "--json", "--help"])).toBeUndefined();
    expect(resolveHelpRequest(["run", "review-documentation", "--help"])).toBeUndefined();
    expect(resolveHelpRequest(["runs", "query", "--json", "--help"])).toBeUndefined();
    expect(resolveHelpRequest(["doctor"])).toBeUndefined();
    expect(resolveHelpRequest(["sources"])).toBeUndefined();
    expect(resolveHelpRequest(["not-a-command", "--help"])).toBeUndefined();
  });

  it("reads help for a non-group command's operand as that command's help", () => {
    expect(resolveHelpRequest(["help", "run", "review-documentation"])).toEqual(["run"]);
    expect(resolveHelpRequest(["help", "runs", "--help"])).toEqual(["runs"]);
    expect(resolveHelpRequest(["-h", "runs", "query"])).toEqual(["runs", "query"]);
  });

  it("refuses help for an unknown command with a usage stop", async () => {
    const outcome = await runCli(["help", "no-such-command"]);
    expect(outcome.output).toBe("");
    const envelope = toOperatorErrorEnvelope(outcome.error);
    expect(envelope.code).toBe("cli-usage");
    expect(envelope.message).toContain('Unknown command "no-such-command"');
    expect(envelope.nextAction).toBe("Run `docsfab help` to list the commands.");
  });

  it("refuses help for an unknown subcommand and names the real ones", async () => {
    const outcome = await runCli(["help", "runs", "index"]);
    const envelope = toOperatorErrorEnvelope(outcome.error);
    expect(envelope.code).toBe("cli-usage");
    expect(envelope.message).toContain("list, show, query, import, and delete");
    expect(envelope.nextAction).toContain("`docsfab runs --help`");
  });

  it("keeps command and argument errors concise and points to the relevant help", async () => {
    const unknown = await runCli(["no-such-command"]);
    const unknownEnvelope = toOperatorErrorEnvelope(unknown.error);
    expect(unknownEnvelope.code).toBe("cli-usage");
    expect(unknownEnvelope.message).toContain('Unknown command "no-such-command"');
    expect(unknownEnvelope.message).toContain("docsfab --help");
    expect(unknownEnvelope.message).not.toContain("Commands:");

    const plan = await runCli(["plan"]);
    const planEnvelope = toOperatorErrorEnvelope(plan.error);
    expect(planEnvelope.code).toBe("cli-usage");
    expect(planEnvelope.message).toContain("docsfab plan --help");

    const unknownWorkflow = await runCli(["plan", "not-a-workflow"]);
    const workflowEnvelope = toOperatorErrorEnvelope(unknownWorkflow.error);
    expect(workflowEnvelope.code).toBe("cli-usage");
    expect(workflowEnvelope.message).toContain("docsfab list");
    expect(workflowEnvelope.message).toContain("docsfab plan --help");

    const list = await runCli(["list", "--unknown"]);
    expect(toOperatorErrorEnvelope(list.error).message).toContain("docsfab list --help");

    const test = await runCli(["test", "--unknown"]);
    expect(toOperatorErrorEnvelope(test.error).message).toContain("docsfab test --help");
  });
});
