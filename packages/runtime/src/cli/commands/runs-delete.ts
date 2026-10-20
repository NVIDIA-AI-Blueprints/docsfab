// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { resolve } from "node:path";

import { resolveDocsFabStateDirectory } from "../../config/host-paths.js";
import {
  applyRunDeletion,
  previewRunDeletion,
  RunDeletionError,
} from "../../records/run-deletion.js";

export async function handleRunsDeleteCommand(args: readonly string[]): Promise<void> {
  let stateDirectory: string | undefined;
  let confirmation: string | undefined;
  let json = false;
  let runId: string | undefined;
  const receiptRoots: string[] = [];
  const deliveryRoots: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--json" && !json) json = true;
    else if (token === "--state-dir" && stateDirectory === undefined) {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw invalidArguments("Provide --state-dir <path>.");
      stateDirectory = resolve(value);
    } else if (token === "--confirm" && confirmation === undefined) {
      const value = args[++index];
      if (!value || value.startsWith("--"))
        throw invalidArguments("Provide the exact preview token after --confirm.");
      confirmation = value;
    } else if (token === "--receipt-root" || token === "--delivery-root") {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw invalidArguments(`Provide ${token} <path>.`);
      (token === "--receipt-root" ? receiptRoots : deliveryRoots).push(resolve(value));
    } else if (token?.startsWith("-") || runId !== undefined) {
      throw invalidArguments(
        "Use docsfab runs delete <run-id> [--state-dir <path>] [--delivery-root <path>] [--receipt-root <path>] [--confirm <token>] [--json].",
      );
    } else runId = token;
  }
  if (!runId) throw invalidArguments("Provide one saved run ID.");
  const root = stateDirectory ?? resolveDocsFabStateDirectory(process.env);
  const suppliedRoots = { receiptRoots, deliveryRoots };
  if (confirmation === undefined) {
    const preview = await previewRunDeletion(root, runId, suppliedRoots);
    if (json) console.log(JSON.stringify(preview));
    else {
      console.log(
        `Run ${preview.runId}: ${preview.files} file(s), ${preview.directories} directory(ies) would be removed.`,
      );
      console.log(
        `${preview.indexRows} run-index row(s) would be purged${preview.indexOverflow ? "; the target-only overflow signal would be removed" : ""}. ${preview.sharedRetained} shared local entr(ies) would be retained.`,
      );
      console.log(`${preview.deliveryIndexRows} derived delivery-index slot(s) would be purged.`);
      if (preview.worktrees > 0 || preview.branches.length > 0) {
        const named = preview.branches.length > 0 ? ` (${preview.branches.join(", ")})` : "";
        console.log(
          `Git cleanup: ${preview.worktrees} delivery worktree(s) and ${preview.branches.length} delivery branch(es)${named} would be removed.`,
        );
      }
      for (const line of preview.keptBranches) console.log(line);
      if (preview.unresolved > 0) {
        console.log(
          `${preview.unresolved} unattributed local entry(ies) require ownership review before deletion can complete.`,
        );
      }
      console.log(
        `No files changed. Confirm with: docsfab runs delete ${shellArgument(preview.runId)} --state-dir ${shellArgument(preview.stateDirectory)}${deliveryRoots.map((path) => ` --delivery-root ${shellArgument(path)}`).join("")}${receiptRoots.map((path) => ` --receipt-root ${shellArgument(path)}`).join("")} --confirm ${shellArgument(preview.confirmation)}`,
      );
    }
    return;
  }
  const result = await applyRunDeletion(root, runId, confirmation, {}, suppliedRoots);
  if (json) console.log(JSON.stringify(result));
  else if (result.complete) console.log(`Run ${runId}: removed ${result.removed} local entr(ies).`);
  else {
    console.log(`Run ${runId}: deletion incomplete after ${result.removed} removal(s).`);
    console.log(`NEXT ${result.nextAction}`);
  }
  if (!result.complete) process.exitCode = 1;
}

function invalidArguments(message: string): RunDeletionError {
  return new RunDeletionError("invalid-arguments", message);
}

function shellArgument(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
