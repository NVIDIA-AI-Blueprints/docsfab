// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isAbsolute, relative } from "node:path";

import type { HostRoot, HostRootSet } from "../security/egress.js";
import {
  type ProcessHostRootOptions,
  processHomeRoots,
  processHostRootList,
  processHostRootSet,
} from "../security/host-roots.js";
import {
  resolveDocsFabConfigurationRoot,
  resolveDocsFabProjectRoot,
  resolveDocsFabPublicationRoots,
} from "./host-paths.js";

export interface RuntimeEgressRootOptions {
  /** This run's checkout; the working directory when omitted. */
  readonly workspace?: string;
  /** Further checkouts, such as a delivery worktree, ahead of `workspace`. */
  readonly checkouts?: readonly string[];
  readonly stateDirectory?: string;
  readonly environment?: NodeJS.ProcessEnv;
  /**
   * Declared public roots, left as written. Omitted, they are parsed from an
   * explicit `environment`, which throws `PublicRootsOperatorError` on an
   * invalid entry, and otherwise are the startup set.
   */
  readonly publicRoots?: ReadonlySet<string>;
}

/**
 * The tokens `egressText` writes in place of a non-workspace root. `~` counts
 * only as a whole path segment, so `~text~` emphasis is still screened.
 */
export const EGRESS_ROOT_PLACEHOLDER =
  /\$(?:DOCSFAB_STATE_DIR|DOCSFAB_CONFIG_ROOT|TMPDIR|HOST_PATH)(?![A-Za-z0-9_])|(?<![A-Za-z0-9_~@+%.\/\\-])~(?![A-Za-z0-9_~@+%.-])/gu;

/** Remove egress placeholders so a markup screen does not refuse projected text. */
export function withoutEgressPlaceholders(text: string): string {
  return text.replace(EGRESS_ROOT_PLACEHOLDER, "");
}

/** Apply `transform` to the text between egress placeholders; placeholders stay as written. */
export function outsideEgressPlaceholders(
  text: string,
  transform: (segment: string) => string,
): string {
  let output = "";
  let last = 0;
  for (const match of text.matchAll(EGRESS_ROOT_PLACEHOLDER)) {
    output += transform(text.slice(last, match.index)) + match[0];
    last = match.index + match[0].length;
  }
  return output + transform(text.slice(last));
}

/** This host's roots for one run, for every runtime publisher. */
export function runtimeEgressRoots(options: RuntimeEgressRootOptions = {}): HostRoot[] {
  return processHostRootList(runtimeRootOptions(options));
}

export function runtimeEgressRootSet(options: RuntimeEgressRootOptions = {}): HostRootSet {
  return processHostRootSet(runtimeRootOptions(options));
}

function runtimeRootOptions(options: RuntimeEgressRootOptions): ProcessHostRootOptions {
  const environment = options.environment ?? process.env;
  const homes = processHomeRoots(environment);
  const workspace = options.workspace ?? attempt(() => process.cwd());
  const roots: HostRoot[] = [];
  // An unresolvable root is left out; HOME and tmp still cover its default location.
  const publication = attempt(() =>
    resolveDocsFabPublicationRoots(environment, options.stateDirectory),
  );
  for (const path of [
    options.stateDirectory,
    publication?.stateDirectory,
    publication?.deliveryRoot,
    publication?.receiptRoot,
  ]) {
    if (path) roots.push({ kind: "state", path });
  }
  const config = attempt(() => resolveDocsFabConfigurationRoot(environment));
  if (config) roots.push({ kind: "config", path: config });
  const install = resolveDocsFabProjectRoot();
  if (!workspace || !contains(workspace, install)) roots.push({ kind: "other", path: install });
  return {
    // A checkout that contains HOME would turn every home path into a repo path.
    workspaceRoots: [
      ...(options.checkouts ?? []),
      ...(workspace && !homes.some((home) => contains(workspace, home)) ? [workspace] : []),
    ],
    roots,
    ...(options.environment ? { environment: options.environment } : {}),
    ...(options.publicRoots ? { publicRoots: options.publicRoots } : {}),
  };
}

function contains(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function attempt<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}
