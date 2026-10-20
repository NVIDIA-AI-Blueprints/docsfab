// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { resolve } from "node:path";

import {
  shipSucceededWrite,
  type ShipSucceededWriteDependencies,
} from "../operator/delivery-orchestrator.js";
import {
  preflightLocalUserGitLabPublication,
  rejectStateDirectoryParentOfRunStore,
  serializeLocalUserPublicationPlan,
} from "./preflight.js";
import {
  runLocalUserPublishExecuteCli,
  type LocalUserPublishCliDependencies as LocalUserPublishExecuteDependencies,
  type LocalUserPublishExecuteCliResult,
} from "./publish-execute.js";

export {
  localUserPublishExecuteArgv,
  parseLocalUserPublishExecuteCliOptions,
  runLocalUserPublishExecuteCli,
} from "./publish-execute.js";
export type { LocalUserPublishExecuteCliResult } from "./publish-execute.js";

export interface LocalUserPublishCliDependencies extends LocalUserPublishExecuteDependencies {
  submit?: ShipSucceededWriteDependencies["submit"];
}

interface PublishCliOptions {
  runId: string;
  repositoryPath: string;
  stateDirectory: string;
  remoteName?: string;
  targetBranch?: string;
  proposedSourceBranch?: string;
  validationCommand?: string;
}

export async function runLocalUserPublishCli(
  args: readonly string[],
  dependencies: LocalUserPublishCliDependencies,
): Promise<LocalUserPublishExecuteCliResult | undefined> {
  if (args.includes("--execute") && args.includes("--preflight")) {
    throw new Error("Publication execution requires --execute and cannot include --preflight.");
  }
  if (args.includes("--execute")) {
    return await runLocalUserPublishExecuteCli(args, dependencies);
  }
  if (args.includes("--preflight")) {
    await runLocalUserPublishPreflightCli(args, dependencies);
    return undefined;
  }
  return await runLocalUserPublishOneShotCli(args, dependencies);
}

/**
 * `--draft-mr` without `--preflight` or `--execute` is the product path:
 * preflight internally, bind the exact plan digest, then execute. The
 * operator does not paste `--confirm-plan-sha256`.
 */
export async function runLocalUserPublishOneShotCli(
  args: readonly string[],
  dependencies: LocalUserPublishCliDependencies,
): Promise<LocalUserPublishExecuteCliResult | undefined> {
  if (args.includes("--execute") || args.includes("--preflight")) {
    throw new Error("One-shot publish cannot include --preflight or --execute together.");
  }
  const options = parseLocalUserPublishCliOptions(args, dependencies);
  (dependencies.stderr ?? console.error)("Note: prefer docsfab ship for interactive use.");
  return await shipSucceededWrite(
    {
      runId: options.runId,
      repositoryPath: options.repositoryPath,
      stateDirectory: options.stateDirectory,
      cwd: dependencies.cwd,
      dryRun: false,
      ...(options.remoteName ? { remoteName: options.remoteName } : {}),
      ...(options.targetBranch ? { targetBranch: options.targetBranch } : {}),
      ...(options.proposedSourceBranch
        ? { proposedSourceBranch: options.proposedSourceBranch }
        : {}),
      ...(options.validationCommand ? { validationCommand: options.validationCommand } : {}),
    },
    {
      log: dependencies.log,
      ...(dependencies.loadRun ? { loadRun: dependencies.loadRun } : {}),
      ...(dependencies.preflight ? { preflight: dependencies.preflight } : {}),
      ...(dependencies.submit ? { submit: dependencies.submit } : {}),
      ...(dependencies.commands ? { commands: dependencies.commands } : {}),
      ...(dependencies.editorialDecodeOptions
        ? { editorialDecodeOptions: dependencies.editorialDecodeOptions }
        : {}),
      executeDependencies: dependencies,
      execute: dependencies.execute ?? runLocalUserPublishExecuteCli,
    },
  );
}

export async function runLocalUserPublishPreflightCli(
  args: readonly string[],
  dependencies: LocalUserPublishCliDependencies,
): Promise<void> {
  const options = parseLocalUserPublishCliOptions(args, dependencies);
  await rejectStateDirectoryParentOfRunStore(
    options.stateDirectory,
    options.runId,
    dependencies.editorialDecodeOptions,
  );
  const plan = await preflightLocalUserGitLabPublication(
    {
      runId: options.runId,
      runRecordPath: resolve(options.stateDirectory, `${options.runId}.json`),
      repositoryPath: options.repositoryPath,
      ...(options.remoteName ? { remoteName: options.remoteName } : {}),
      ...(options.targetBranch ? { targetBranch: options.targetBranch } : {}),
      ...(options.proposedSourceBranch
        ? { proposedSourceBranch: options.proposedSourceBranch }
        : {}),
      ...(options.validationCommand ? { validationCommand: options.validationCommand } : {}),
      draftMergeRequest: true,
    },
    dependencies.commands,
    ...(dependencies.editorialDecodeOptions ? [dependencies.editorialDecodeOptions] : []),
  );
  dependencies.log(serializeLocalUserPublicationPlan(plan).trimEnd());
}

export function parseLocalUserPublishCliOptions(
  args: readonly string[],
  dependencies: Pick<LocalUserPublishCliDependencies, "cwd" | "stateDirectory">,
): PublishCliOptions {
  const runId = args[0];
  if (!runId || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(runId)) {
    throw new Error("publish requires a safe <run-id>.");
  }
  let draft = false;
  let preflight = false;
  let json = false;
  const values = new Map<string, string>();
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--draft-mr" || argument === "--preflight" || argument === "--json") {
      if (
        (argument === "--draft-mr" && draft) ||
        (argument === "--preflight" && preflight) ||
        (argument === "--json" && json)
      ) {
        throw new Error("Duplicate publish option.");
      }
      if (argument === "--draft-mr") draft = true;
      else if (argument === "--preflight") preflight = true;
      else json = true;
      continue;
    }
    if (
      ![
        "--repo",
        "--state-dir",
        "--remote",
        "--target-branch",
        "--source-branch",
        "--validation-command",
      ].includes(argument)
    ) {
      throw new Error("Unknown publish option.");
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--") || values.has(argument)) {
      throw new Error(`${argument} requires one value.`);
    }
    values.set(argument, value);
    index += 1;
  }
  const repository = values.get("--repo") ?? ".";
  return {
    runId,
    repositoryPath: resolve(dependencies.cwd, repository),
    stateDirectory: resolve(values.get("--state-dir") ?? dependencies.stateDirectory),
    remoteName: values.get("--remote") ?? "origin",
    ...(values.get("--target-branch") ? { targetBranch: values.get("--target-branch") } : {}),
    ...(values.get("--source-branch")
      ? { proposedSourceBranch: values.get("--source-branch") }
      : {}),
    ...(values.get("--validation-command")
      ? { validationCommand: values.get("--validation-command") }
      : {}),
  };
}
