// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `docsfab auto --publish` argument parser. Like `auto --once`, plus the
 * candidate manifest naming ready `docsfab-roadmap::managed` issues. Resume is
 * automatic through the per-cycle publication record; `--resume` only affirms
 * that a re-run should adopt any prior draft MR.
 */

import { resolve } from "node:path";

export interface AutoPublishCliArguments {
  repositoryPath: string;
  candidatesPath: string;
  revision: string;
  targetBranch?: string;
  confirmCycle: boolean;
  resume: boolean;
  authorityId: string;
  json: boolean;
}

const SAFE_AUTHORITY = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/u;

export function parseAutoPublishCliArguments(
  args: readonly string[],
  cwd: string,
): AutoPublishCliArguments {
  if (args[0] !== "--publish") {
    throw new Error(
      "The auto --publish command requires the --publish mode selector as its first argument.",
    );
  }
  const values = new Map<string, string>();
  let json = false;
  let confirmCycle = false;
  let resume = false;
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--json") {
      if (json)
        throw new Error(
          "The auto --publish command received a duplicated --json option flag argument.",
        );
      json = true;
      continue;
    }
    if (argument === "--confirm-cycle") {
      if (confirmCycle)
        throw new Error(
          "The auto --publish command received a duplicated --confirm-cycle option flag argument.",
        );
      confirmCycle = true;
      continue;
    }
    if (argument === "--resume") {
      if (resume)
        throw new Error(
          "The auto --publish command received a duplicated --resume option flag argument.",
        );
      resume = true;
      continue;
    }
    if (
      !["--repo", "--candidates", "--revision", "--target-branch", "--authority-id"].includes(
        argument,
      )
    ) {
      throw new Error(
        "The auto --publish command received an unrecognized command line option named " +
          argument +
          ".",
      );
    }
    if (values.has(argument))
      throw new Error(
        "The auto --publish command received a duplicated command line option named " +
          argument +
          ".",
      );
    const value = args[index + 1];
    if (!value || value.startsWith("--"))
      throw new Error(
        "The auto --publish option " +
          argument +
          " requires an adjacent non-option value argument.",
      );
    values.set(argument, value);
    index += 1;
  }
  const candidates = values.get("--candidates");
  if (!candidates) {
    throw new Error(
      "The auto --publish command requires a --candidates managed selection manifest path argument.",
    );
  }
  const revision = values.get("--revision") ?? "HEAD";
  if (
    revision.includes("\0") ||
    revision.length === 0 ||
    revision.length > 512 ||
    revision.startsWith("-")
  ) {
    throw new Error(
      "The auto --publish command received an invalid or unsafe --revision value argument.",
    );
  }
  const authorityId =
    values.get("--authority-id") ?? process.env.DOCSFAB_OPERATOR_AUTHORITY_ID ?? "local-operator";
  if (!SAFE_AUTHORITY.test(authorityId)) {
    throw new Error(
      "The auto --publish command received an unsafe operator --authority-id value argument.",
    );
  }
  const targetBranch = values.get("--target-branch");
  return {
    repositoryPath: resolve(cwd, values.get("--repo") ?? "."),
    candidatesPath: resolve(cwd, candidates),
    revision,
    ...(targetBranch === undefined ? {} : { targetBranch }),
    confirmCycle,
    resume,
    authorityId,
    json,
  };
}
