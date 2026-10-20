// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { resolve } from "node:path";

import {
  CHANGE_REQUEST_SELECTOR_OPTIONS,
  admitCliSourceSelection,
  assertLocalRepositoryPath,
  isAttachedCliSourceOption,
} from "../run-arguments.js";
import { runLiveAgent } from "../../live-agent/host.js";
import { runLiveAgentTask } from "../../live-agent/task-runner.js";
import { DocumentationScope } from "../../live-agent/documentation-scope.js";
import type { ChangeRequestSelectorV1 } from "../../inputs/change-request-selector.js";
import {
  parseLiveAgentChangeReviewReference,
  type LiveAgentChangeReviewSelectorV1,
} from "../../live-agent/change-review.js";

export interface LiveAgentArguments {
  repositoryPath: string;
  newSession: boolean;
  allowWrite: boolean;
  documentationDirectories?: string[];
  /**
   * `--source` paths the operator attached at the terminal. Every bounded
   * workflow the conversation starts binds them; a source binding is a host
   * grant, so the model selects neither the files nor whether they are bound.
   */
  sourcePaths?: readonly string[];
  /** Parsed only; nothing is resolved or opened. */
  changeRequestSelector?: ChangeRequestSelectorV1;
  /** Parsed PR review basis; acquisition remains inside the shared runner. */
  changeSource?: LiveAgentChangeReviewSelectorV1;
}

export const LIVE_AGENT_USAGE = `Usage:
  docsfab live-agent [--repo <path>] [--new] [--read-only | --allow-write]
    [--source <repository-relative-path>]... [--pr | --mr <url-or-reference>]
  docsfab live-agent --task-file <absolute-path> --result-dir <absolute-path>
    [--repo <path>] [--docs-dir <host-granted-directory>]...
    [--docs-file <host-granted-file>]... [--allow-write] --json

Starts or resumes the persistent local Pi agent. If model configuration is
incomplete, DocsFab asks for a provider, model, applicable endpoint/API,
and hidden API key before starting the agent.
Documentation edits are enabled by default. Host commands still require
terminal approval. Use --read-only to disable edits and host commands.
Before a documentation file change, the host prepares a unique task branch
when the checkout is on main, the repository default branch, or detached
HEAD, and reuses that branch for later writes. Branch setup does not grant
commit, push, merge-request, or merge, and it is not worktree isolation.

Attached sources are host-selected evidence for this session: every bounded
workflow the conversation runs binds the same tracked files and merged change
that docsfab run would bind for the same selection. Conversation text is not
evidence and cannot add, replace, or drop an attached source.

Options:
  --repo <path>    Repository available to the live agent (default: current directory)
  --new            Start a new conversation without deleting previous sessions
                   (docsfab sessions list and docsfab sessions delete manage them)
  --read-only      Disable documentation edits, workflow writes, and host commands
  --allow-write    Enable writes explicitly (compatibility flag; already the default)
  --docs-dir <path> Add a repository-relative documentation directory (repeatable)
  --docs-file <path> Grant one tracked documentation file in task mode (repeatable)
  --source <path>  Attach one tracked repository path as bound evidence (repeatable)
  --pr, --mr <url-or-reference>
                   Attach one merged merge request as bound evidence. Two spellings
                   of one option; pass either, once. Accepts its URL,
                   host/group/project!number, or the number for this checkout
`;

class LiveAgentTaskArgumentsContractError extends Error {
  readonly code = "live-agent-task-arguments-invalid";
}

class LiveAgentArgumentsContractError extends Error {
  readonly code = "live-agent-arguments-invalid";
}

export function parseLiveAgentTaskArguments(args: string[]): {
  repositoryPath: string;
  taskFile: string;
  resultDirectory: string;
  allowWrite: boolean;
  documentationDirectories: string[];
  taskGrantedFiles: string[];
} {
  const values = new Map<string, string>();
  let allowWrite = false;
  let json = false;
  const documentationDirectories: string[] = [];
  const taskGrantedFiles: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (name === "--allow-write" || name === "--json") {
      if (name === "--allow-write" && allowWrite)
        throw new LiveAgentTaskArgumentsContractError(
          "The --allow-write option may be provided only once per task.",
        );
      if (name === "--json" && json)
        throw new LiveAgentTaskArgumentsContractError(
          "The --json option may be provided only once per task.",
        );
      if (name === "--allow-write") allowWrite = true;
      else json = true;
      continue;
    }
    if (name === "--docs-dir") {
      const value = args[++index];
      if (!value || value.startsWith("--"))
        throw new LiveAgentTaskArgumentsContractError(
          "The --docs-dir option requires one host-granted directory path.",
        );
      new DocumentationScope([value]);
      documentationDirectories.push(value);
      continue;
    }
    if (name === "--docs-file") {
      const value = args[++index];
      if (!value || value.startsWith("--"))
        throw new LiveAgentTaskArgumentsContractError(
          "The --docs-file option requires one host-granted file path.",
        );
      new DocumentationScope([], [], [value]);
      taskGrantedFiles.push(value);
      continue;
    }
    if (name !== "--task-file" && name !== "--result-dir" && name !== "--repo")
      throw new LiveAgentTaskArgumentsContractError(
        `Noninteractive live-agent does not recognize the option: ${name}.`,
      );
    const value = args[++index];
    if (!value || value.startsWith("--") || values.has(name))
      throw new LiveAgentTaskArgumentsContractError(
        `The ${name} option requires one absolute path value.`,
      );
    values.set(name, value);
  }
  if (!json || !values.has("--task-file") || !values.has("--result-dir"))
    throw new LiveAgentTaskArgumentsContractError(
      "Task mode requires --task-file, --result-dir, and --json together.",
    );
  const repository = values.get("--repo") ?? process.cwd();
  assertLocalRepositoryPath(repository, "--repo");
  return {
    repositoryPath: resolve(repository),
    taskFile: values.get("--task-file")!,
    resultDirectory: values.get("--result-dir")!,
    allowWrite,
    documentationDirectories,
    taskGrantedFiles,
  };
}

export function parseLiveAgentArguments(args: string[]): LiveAgentArguments {
  const allowedFlags = new Set(["--new", "--allow-write", "--read-only"]);
  const values = new Map<string, string>();
  const documentationDirectories: string[] = [];
  const consumed = new Set<number>();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument) throw new Error("DocsFab live-agent received an empty CLI option value.");
    if (argument === "--docs-dir") {
      const path = args[index + 1];
      if (!path || path.startsWith("--"))
        throw new Error(
          "The --docs-dir option requires one repository-relative documentation directory path.",
        );
      new DocumentationScope([path]);
      documentationDirectories.push(path);
      consumed.add(index);
      consumed.add(index + 1);
      index += 1;
      continue;
    }
    if (allowedFlags.has(argument)) {
      if (args.indexOf(argument) !== index) {
        throw new Error(`The ${argument} option may be provided only once per invocation.`);
      }
      consumed.add(index);
      continue;
    }
    if (isAttachedCliSourceOption(argument)) {
      // One token, validated by the shared admission; consumed here only so the
      // later unknown-option guard does not reject it.
      consumed.add(index);
      continue;
    }
    if (
      argument === "--source" ||
      (CHANGE_REQUEST_SELECTOR_OPTIONS as readonly string[]).includes(argument)
    ) {
      // Validated by the shared admission below; consumed here only so the
      // later unknown-option guard does not reject it.
      consumed.add(index);
      const value = args[index + 1];
      if (value && !value.startsWith("--")) {
        consumed.add(index + 1);
        index += 1;
      }
      continue;
    }
    if (argument === "--repo") {
      if (values.has(argument)) {
        throw new Error("The --repo option may be provided only once per invocation.");
      }
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("The --repo option requires a local directory path.");
      }
      values.set(argument, value);
      consumed.add(index);
      consumed.add(index + 1);
      index += 1;
    }
    // Unknown `--` tokens wait until after the shared admission, matching `do`,
    // so a near miss (`--sourcex`, `--mr813`) gets the coded stop rather than
    // this surface's generic unrecognized-option text.
  }
  if (args.includes("--read-only") && args.includes("--allow-write")) {
    throw new Error("The --read-only and --allow-write options cannot be combined.");
  }
  const repository = values.get("--repo") ?? process.cwd();
  assertLocalRepositoryPath(repository, "--repo");
  // No workflow is named: the conversation chooses one per turn, so the
  // source-aware workflow refusal is raised when a bounded workflow starts.
  const reviewReferences: string[] = [];
  const sourceAdmissionArgs: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--pr" || argument === "--mr") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new LiveAgentArgumentsContractError(
          "The --pr option requires a GitHub pull-request URL or GitLab merge-request reference.",
        );
      }
      if (/^https:\/\/(?:www\.)?github\.com(?:\/|$)/iu.test(value)) {
        reviewReferences.push(value);
      } else {
        sourceAdmissionArgs.push(argument, value);
      }
      index += 1;
      continue;
    }
    if (argument.startsWith("--pr=") || argument.startsWith("--mr=")) {
      const value = argument.slice(argument.indexOf("=") + 1);
      if (value.length === 0) {
        throw new LiveAgentArgumentsContractError(
          "The --pr option requires a GitHub pull-request URL or GitLab merge-request reference.",
        );
      }
      if (/^https:\/\/(?:www\.)?github\.com(?:\/|$)/iu.test(value)) {
        reviewReferences.push(value);
      } else {
        sourceAdmissionArgs.push(argument);
      }
      continue;
    }
    sourceAdmissionArgs.push(argument);
  }
  if (reviewReferences.length > 1) {
    throw new LiveAgentArgumentsContractError(
      "The --pr option may be provided only once per invocation.",
    );
  }
  const { sourcePaths, changeRequestSelector } = admitCliSourceSelection(sourceAdmissionArgs);
  if (reviewReferences.length > 0 && changeRequestSelector) {
    throw new LiveAgentArgumentsContractError(
      "Use one pull or merge request reference per live-agent invocation.",
    );
  }
  const changeSource =
    reviewReferences.length === 1
      ? parseLiveAgentChangeReviewReference(reviewReferences[0]!)
      : undefined;
  for (let index = 0; index < args.length; index += 1) {
    if (consumed.has(index)) continue;
    throw new Error(`DocsFab live-agent does not recognize the option: ${args[index]}.`);
  }
  return {
    repositoryPath: resolve(repository),
    newSession: args.includes("--new"),
    allowWrite: !args.includes("--read-only"),
    ...(documentationDirectories.length ? { documentationDirectories } : {}),
    ...(sourcePaths.length > 0 ? { sourcePaths } : {}),
    ...(changeRequestSelector ? { changeRequestSelector } : {}),
    ...(changeSource ? { changeSource } : {}),
  };
}

export async function handleLiveAgentCommand(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    if (args.length !== 1) {
      throw new Error("DocsFab live-agent help must be requested without any other options.");
    }
    console.log(LIVE_AGENT_USAGE);
    return;
  }
  if (args.includes("--task-file") || args.includes("--result-dir")) {
    const options = parseLiveAgentTaskArguments(args);
    const controller = new AbortController();
    const abort = () => controller.abort();
    process.once("SIGINT", abort);
    process.once("SIGTERM", abort);
    try {
      const summary = await runLiveAgentTask({ ...options, signal: controller.signal });
      console.log(JSON.stringify(summary));
    } finally {
      process.removeListener("SIGINT", abort);
      process.removeListener("SIGTERM", abort);
    }
    return;
  }
  await runLiveAgent(parseLiveAgentArguments(args));
}
