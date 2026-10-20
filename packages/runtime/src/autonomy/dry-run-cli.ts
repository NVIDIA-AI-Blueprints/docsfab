// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { resolve } from "node:path";
import {
  projectAutoDryRunPresentation,
  renderAdvancedPresentation,
} from "../cli/advanced-presentation.js";

import {
  createAutoDryRun,
  createAutoDryRunNeedsInput,
  serializeAutoDryRun,
  type AutoDryRunNeedsInputV1,
  type AutoDryRunResultV1,
  type AutoDryRunRoadmapPlanner,
  type AutoDryRunSourceV1,
} from "./dry-run.js";

export interface AutoDryRunCliArguments {
  mode: "dry-run";
  repositoryPath: string;
  revision: string;
  targetBranch?: string;
  json: boolean;
}

export type AutoDryRunHostAssessmentV1 =
  | { status: "ready"; source: AutoDryRunSourceV1; dispose(): Promise<void> }
  | { status: "needs-input"; input: AutoDryRunNeedsInputV1; dispose(): Promise<void> };

/**
 * Deliberately read-only dependency surface. It has no authorization, tracker
 * writer, repository writer, SCM publisher, or apply callback.
 */
export interface AutoDryRunCliDependencies {
  assess(arguments_: AutoDryRunCliArguments): Promise<AutoDryRunHostAssessmentV1>;
  roadmapPlanner?: AutoDryRunRoadmapPlanner;
  log(message: string): void;
  progress?(phase: "inspect" | "assess" | "plan" | "complete"): void;
}

export function parseAutoDryRunCliArguments(
  args: readonly string[],
  cwd = process.cwd(),
): AutoDryRunCliArguments {
  if (args[0] !== "--dry-run") {
    throw new Error("auto requires exactly --dry-run or --once.");
  }
  const values = new Map<string, string>();
  let json = false;
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--json") {
      if (json) throw new Error("Duplicated auto option --json.");
      json = true;
      continue;
    }
    if (!["--repo", "--revision", "--target-branch"].includes(argument)) {
      throw new Error(`Unknown auto dry-run option ${argument}.`);
    }
    if (values.has(argument)) throw new Error(`Duplicated auto option ${argument}.`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value.`);
    values.set(argument, value);
    index += 1;
  }
  const revision = values.get("--revision") ?? "HEAD";
  if (
    revision.includes("\0") ||
    revision.length === 0 ||
    revision.length > 512 ||
    revision.startsWith("-")
  )
    throw new Error("--revision is invalid.");
  const targetBranch = values.get("--target-branch");
  if (targetBranch !== undefined && !safeBranch(targetBranch)) {
    throw new Error("--target-branch is invalid.");
  }
  return {
    mode: "dry-run",
    repositoryPath: resolve(cwd, values.get("--repo") ?? "."),
    revision,
    ...(targetBranch === undefined ? {} : { targetBranch }),
    json,
  };
}

export async function runAutoDryRunCli(
  args: readonly string[],
  dependencies: AutoDryRunCliDependencies,
): Promise<AutoDryRunResultV1> {
  const arguments_ = parseAutoDryRunCliArguments(args);
  dependencies.progress?.("inspect");
  const assessment = await dependencies.assess(arguments_);
  try {
    dependencies.progress?.("assess");
    let result: AutoDryRunResultV1;
    if (assessment.status === "needs-input") {
      result = createAutoDryRunNeedsInput(assessment.input);
    } else {
      dependencies.progress?.("plan");
      result = await createAutoDryRun(assessment.source, dependencies.roadmapPlanner);
    }
    dependencies.progress?.("complete");
    dependencies.log(
      arguments_.json
        ? serializeAutoDryRun(result).trimEnd()
        : renderAdvancedPresentation(projectAutoDryRunPresentation(result)),
    );
    return result;
  } finally {
    await assessment.dispose();
  }
}

function safeBranch(value: string): boolean {
  return /^(?![-/.])(?!.*(?:\.\.|@\{|\/\/))[^\0-\x20\x7f~^:?*[\\]{1,200}$/u.test(value);
}
