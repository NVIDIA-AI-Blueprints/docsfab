// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CLI argv for the multi-unit campaign. Dry-run is the default; `--allow-write`
 * is recognized and fails closed.
 */

import { resolve } from "node:path";
import {
  projectCampaignPresentation,
  renderAdvancedPresentation,
} from "../cli/advanced-presentation.js";

import {
  runMultiUnitCampaignDryRun,
  serializeMultiUnitCampaignDryRunResult,
  type MultiUnitCampaignDryRunDependencies,
  type MultiUnitCampaignDryRunResultV1,
  MultiUnitCampaignRunError,
  type MultiUnitCampaignRunErrorCode,
} from "./multi-unit-campaign-run.js";

function fail(code: MultiUnitCampaignRunErrorCode): never {
  throw new MultiUnitCampaignRunError(code);
}

export interface MultiUnitCampaignCliArguments {
  readonly repositoryPath: string;
  readonly campaignDirectory: string;
  readonly revision: string;
  readonly allowWrite: boolean;
  readonly json: boolean;
}

export interface MultiUnitCampaignCliDependencies extends MultiUnitCampaignDryRunDependencies {
  readonly cwd?: string;
  readonly log?: (message: string) => void;
  readonly now?: () => string;
}

export function parseMultiUnitCampaignCliArguments(
  args: readonly string[],
  cwd = process.cwd(),
): MultiUnitCampaignCliArguments {
  const known = new Set([
    "--repo",
    "--campaign-dir",
    "--revision",
    "--allow-write",
    "--json",
    "--dry-run",
  ]);
  const values = new Map<string, string>();
  let allowWrite = false;
  let json = false;
  let dryRunFlag = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (!known.has(argument)) {
      fail("invalid-option");
    }
    if (argument === "--allow-write") {
      if (allowWrite) fail("invalid-option");
      allowWrite = true;
      continue;
    }
    if (argument === "--json") {
      if (json) fail("invalid-option");
      json = true;
      continue;
    }
    if (argument === "--dry-run") {
      if (dryRunFlag) fail("invalid-option");
      dryRunFlag = true;
      continue;
    }
    if (values.has(argument)) fail("invalid-option");
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      fail("invalid-option");
    }
    values.set(argument, value);
    index += 1;
  }

  const repository = values.get("--repo");
  const campaignDirectory = values.get("--campaign-dir");
  if (!repository || !campaignDirectory) {
    fail("invalid-option");
  }
  const revision = values.get("--revision") ?? "HEAD";
  if (
    revision.includes("\0") ||
    revision.length === 0 ||
    revision.length > 512 ||
    revision.startsWith("-")
  ) {
    fail("invalid-option");
  }

  return {
    repositoryPath: resolve(cwd, repository),
    campaignDirectory: resolve(cwd, campaignDirectory),
    revision,
    allowWrite,
    json,
  };
}

export async function runMultiUnitCampaignCli(
  args: readonly string[],
  dependencies: MultiUnitCampaignCliDependencies = {},
): Promise<MultiUnitCampaignDryRunResultV1> {
  const cwd = dependencies.cwd ?? process.cwd();
  const parsed = parseMultiUnitCampaignCliArguments(args, cwd);
  const log = dependencies.log ?? ((message: string) => console.log(message));
  const result = await runMultiUnitCampaignDryRun(
    {
      repositoryPath: parsed.repositoryPath,
      campaignDirectory: parsed.campaignDirectory,
      revision: parsed.revision,
      allowWrite: parsed.allowWrite,
      ...(dependencies.now ? { now: dependencies.now } : {}),
    },
    {
      inspectSource: dependencies.inspectSource,
      assertSourceUnchanged: dependencies.assertSourceUnchanged,
    },
  );
  log(
    parsed.json
      ? serializeMultiUnitCampaignDryRunResult(result).trimEnd()
      : renderAdvancedPresentation(projectCampaignPresentation(result)),
  );
  return result;
}
