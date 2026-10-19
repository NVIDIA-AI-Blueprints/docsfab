// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `docsfab why` answers what failed, why, whose problem it is, and what to do
 * next for one saved run or a set of runs, from the run index. Read-only.
 */
import { lstat } from "node:fs/promises";
import { resolve } from "node:path";

import { resolveDocsFabStateDirectory } from "../../config/host-paths.js";
import {
  DIAGNOSIS_OWNER_CLASSES,
  DIAGNOSIS_OWNER_LABELS,
  type WhyReportV1,
} from "../../diagnosis/contracts.js";
import { shellArgument, type DiagnosisLocation } from "../../diagnosis/engine.js";
import { buildWhyReport, WhyOperatorError, type WhyRequest } from "../../diagnosis/load.js";
import { formatWhyReport } from "../../diagnosis/render.js";
import { SAFE_RECORD_ID } from "../../records/file-store.js";
import { defaultRunIndexDirectory } from "../../records/run-index-store.js";

const HELP_COMMAND = "docsfab why --help";

export interface WhyArguments {
  readonly help: boolean;
  readonly json: boolean;
  readonly request: WhyRequest;
}

export function whyUsage(): string {
  return [
    "Usage: docsfab why [<run-id> | <state-dir>] [--last | --all] [--batch <id>] [--model <id>]",
    "         [--state-dir <path> | --index-dir <path>] [--json]",
    "",
    "Diagnoses saved runs from the run index: what failed, why, whose problem it is, the next",
    "action, the evidence, and the docsfab runs query command that reproduces each line, with",
    "recurrence across recent runs of the same provider and model.",
    "",
    `Owners: ${DIAGNOSIS_OWNER_CLASSES.map((owner) => DIAGNOSIS_OWNER_LABELS[owner]).join(", ")}.`,
    "",
    "  <run-id>          One run, by full ID or unique prefix.",
    "  <state-dir>       Every run in that state directory (same as --state-dir <path> --all).",
    "  --last            The newest run (the default when no run is named).",
    "  --all             Every matching run, newest first, up to diagnosis.maxRuns.",
    "  --batch <id>      Runs of one local-workflows harness batch.",
    "  --model <id>      Only runs that used this model.",
    "  --state-dir       Read this state directory and the run index beside it.",
    "  --index-dir       Read this run index directory only.",
    "  --json            Print the docsfab-why schema version 1 envelope.",
    "",
    "Saved records the index does not hold yet are read from the state directory and",
    "diagnosed the same way; the answer says so.",
  ].join("\n");
}

export async function parseWhyArguments(args: readonly string[]): Promise<WhyArguments> {
  const flags = new Set<string>();
  const single = new Map<string, string>();
  const positionals: string[] = [];
  const known = new Set(["--json", "--help", "-h", "--last", "--all"]);
  const valued = new Set(["--state-dir", "--index-dir", "--batch", "--model"]);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (known.has(argument)) {
      if (flags.has(argument)) throw usageError(`The ${argument} option must not be duplicated.`);
      flags.add(argument);
      continue;
    }
    if (valued.has(argument)) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("-")) {
        throw usageError(`The ${argument} option requires a value.`);
      }
      if (single.has(argument)) throw usageError(`The ${argument} option must not be duplicated.`);
      single.set(argument, value);
      index += 1;
      continue;
    }
    if (argument.startsWith("-")) {
      throw usageError(`Unknown docsfab why option "${argument}" is not supported.`);
    }
    positionals.push(argument);
  }
  const help = flags.has("--help") || flags.has("-h");
  if (positionals.length > 1) {
    throw usageError("The docsfab why command accepts one run ID or one state directory.");
  }
  if (single.has("--state-dir") && single.has("--index-dir")) {
    throw usageError("The --state-dir and --index-dir options cannot be combined.");
  }
  if (flags.has("--last") && flags.has("--all")) {
    throw usageError("The --last and --all options cannot be combined.");
  }
  const positional = positionals[0];
  let positionalDirectory: string | undefined;
  let runId: string | null = null;
  if (positional !== undefined) {
    const entry = await lstat(positional).catch(() => undefined);
    if (entry?.isDirectory()) {
      if (single.has("--state-dir") || single.has("--index-dir")) {
        throw usageError(
          "Name the state directory either as the argument or with --state-dir, not both.",
        );
      }
      positionalDirectory = resolve(positional);
    } else if (SAFE_RECORD_ID.test(positional)) {
      if (flags.has("--last") || flags.has("--all")) {
        throw usageError("A run ID cannot be combined with --last or --all.");
      }
      runId = positional;
    } else {
      throw usageError(
        `The argument "${positional}" is neither a run ID nor an existing state directory.`,
      );
    }
  }
  const batchId = single.get("--batch") ?? null;
  const mode: WhyReportV1["selection"]["mode"] =
    runId !== null
      ? "run"
      : flags.has("--last")
        ? "last"
        : batchId !== null
          ? "batch"
          : flags.has("--all") || positionalDirectory !== undefined
            ? "all"
            : "last";
  const indexDirectoryFlag = single.get("--index-dir");
  const stateDirectory =
    indexDirectoryFlag !== undefined
      ? null
      : (positionalDirectory ??
        resolve(single.get("--state-dir") ?? resolveDocsFabStateDirectory()));
  const explicitState = positionalDirectory ?? single.get("--state-dir");
  const location: DiagnosisLocation =
    indexDirectoryFlag !== undefined
      ? { indexArgs: ` --index-dir ${shellArgument(resolve(indexDirectoryFlag))}`, showArgs: "" }
      : explicitState !== undefined
        ? {
            indexArgs: ` --state-dir ${shellArgument(resolve(explicitState))}`,
            showArgs: ` --state-dir ${shellArgument(resolve(explicitState))}`,
          }
        : { indexArgs: "", showArgs: "" };
  return {
    help,
    json: flags.has("--json"),
    request: {
      selection: {
        mode,
        runId,
        batchId,
        model: single.get("--model") ?? null,
      },
      indexDirectory:
        indexDirectoryFlag !== undefined
          ? resolve(indexDirectoryFlag)
          : defaultRunIndexDirectory(stateDirectory as string),
      stateDirectory,
      stateDirectoryExplicit: explicitState !== undefined,
      location,
    },
  };
}

export async function handleWhyCommand(args: readonly string[]): Promise<void> {
  const parsed = await parseWhyArguments(args);
  if (parsed.help) {
    console.log(whyUsage());
    return;
  }
  const report = await buildWhyReport(parsed.request);
  if (parsed.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  for (const line of formatWhyReport(report, parsed.request.location)) console.log(line);
}

function usageError(message: string): WhyOperatorError {
  return new WhyOperatorError("why-invalid-arguments", message, HELP_COMMAND);
}
