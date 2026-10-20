// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { resolve } from "node:path";

import {
  shipSucceededWrite,
  type ShipSucceededWriteDependencies,
} from "../../operator/delivery-orchestrator.js";
import { loadSavedRunPublicationDecodeOptions } from "../run/editorial-replay.js";

export interface ShipCliDependencies extends ShipSucceededWriteDependencies {
  readonly cwd: string;
  readonly stateDirectory: string;
}

/** Handle the intentionally small, run-id-only L0 ship surface. */
export async function handleShipCommand(
  args: readonly string[],
  dependencies: ShipCliDependencies,
): Promise<void> {
  const options = parseShipArguments(args, dependencies.cwd);
  // The saved run's record decodes only with the options `runs show` uses (#2366).
  const editorialDecodeOptions =
    dependencies.editorialDecodeOptions ??
    (await loadSavedRunPublicationDecodeOptions(dependencies.stateDirectory, options.runId));
  await shipSucceededWrite(
    {
      runId: options.runId,
      repositoryPath: options.repositoryPath,
      stateDirectory: dependencies.stateDirectory,
      cwd: dependencies.cwd,
      dryRun: options.dryRun,
    },
    { ...dependencies, ...(editorialDecodeOptions ? { editorialDecodeOptions } : {}) },
  );
}

interface ShipOptions {
  readonly runId: string;
  readonly repositoryPath: string;
  readonly dryRun: boolean;
}

function parseShipArguments(args: readonly string[], cwd: string): ShipOptions {
  let runId: string | undefined;
  let repositoryPath: string | undefined;
  let dryRun = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) continue;
    if (argument === "--dry-run") {
      if (dryRun) throw new Error("The ship command received a duplicated --dry-run option.");
      dryRun = true;
      continue;
    }
    if (argument === "--repo") {
      if (repositoryPath !== undefined)
        throw new Error("The ship command received a duplicated --repo option.");
      const value = args[index + 1];
      if (!value || value.startsWith("-"))
        throw new Error("The ship command requires a path after --repo.");
      repositoryPath = resolve(cwd, value);
      index += 1;
      continue;
    }
    if (argument.startsWith("-"))
      throw new Error(`The ship command does not recognize option "${argument}".`);
    if (runId !== undefined) throw new Error("The ship command accepts exactly one run id.");
    runId = argument;
  }
  if (!runId) throw new Error("The ship command requires a succeeded write run id.");
  if (!repositoryPath)
    throw new Error("The ship command requires an explicit --repo <path> option.");
  return { runId, repositoryPath, dryRun };
}
