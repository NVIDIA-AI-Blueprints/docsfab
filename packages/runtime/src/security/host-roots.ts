// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { homedir, tmpdir } from "node:os";
import { posix, win32 } from "node:path";

import { type HostRoot, type HostRootSet, hostRootSet } from "./egress.js";
import { declaredPublicRoots, publicRootPredicate } from "./public-roots.js";

let startupPublicRoots: ReadonlySet<string> | undefined;

/**
 * Validate `DOCSFAB_PUBLIC_ROOTS` at process start and keep the set for every
 * later root set this process builds. Throws `PublicRootsOperatorError`.
 */
export function validateStartupPublicRoots(
  environment: NodeJS.ProcessEnv = process.env,
): ReadonlySet<string> {
  startupPublicRoots = declaredPublicRoots(environment);
  return startupPublicRoots;
}

/**
 * Test-only: forget the startup set, so the next test starts as a process that
 * has not validated its declaration. Call it from `afterEach` in any suite that
 * validates.
 */
export function resetStartupPublicRootsForTest(): void {
  startupPublicRoots = undefined;
}

/**
 * Declared public roots: parsed from `environment` when one is given, and
 * otherwise the startup set. A process that skipped startup validation parses
 * its own environment on each call. Throws `PublicRootsOperatorError`.
 */
export function processPublicRoots(environment?: NodeJS.ProcessEnv): ReadonlySet<string> {
  if (environment) return declaredPublicRoots(environment);
  return startupPublicRoots ?? declaredPublicRoots();
}

export interface ProcessHostRootOptions {
  /** Checkouts, whose paths reach a reader repository-relative. */
  readonly workspaceRoots?: readonly string[];
  /** Further roots, after the workspaces and before HOME and the tmpdir. */
  readonly roots?: readonly HostRoot[];
  /** Another process's environment; this process's when omitted. */
  readonly environment?: NodeJS.ProcessEnv;
  /**
   * Declared public roots. Omitted, they are parsed from `environment` when one
   * is given, and otherwise are the startup set.
   */
  readonly publicRoots?: ReadonlySet<string>;
  /** The platform whose path rules and variable names apply; this one when omitted. */
  readonly platform?: NodeJS.Platform;
}

/**
 * HOME, from the environment first so another process's environment is
 * honoured. Windows names the same directory `USERPROFILE`, and a shell such as
 * Git Bash can set HOME elsewhere, so each distinct spelling is a root there.
 */
export function processHomeRoots(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const names = platform === "win32" ? ["HOME", "USERPROFILE"] : ["HOME"];
  return spellings(environment, names, platform, homedir);
}

/**
 * This process's roots in replacement order: a path named by two roots takes
 * the first one's kind. Public roots are not applied here.
 */
export function processHostRootList(options: ProcessHostRootOptions = {}): HostRoot[] {
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  // `os.tmpdir()` on Windows reads TEMP then TMP; Windows tools read TMP first.
  const tmpNames = platform === "win32" ? ["TMPDIR", "TEMP", "TMP"] : ["TMPDIR"];
  return [
    ...(options.workspaceRoots ?? []).map((path) => ({ kind: "workspace" as const, path })),
    ...(options.roots ?? []),
    ...processHomeRoots(environment, platform).map((path) => ({ kind: "home" as const, path })),
    ...spellings(environment, tmpNames, platform, tmpdir).map((path) => ({
      kind: "tmp" as const,
      path,
    })),
  ];
}

/** The roots every publisher and model-facing result from this process replaces. */
export function processHostRootSet(options: ProcessHostRootOptions = {}): HostRootSet {
  const publicRoots = options.publicRoots ?? processPublicRoots(options.environment);
  return hostRootSet(processHostRootList(options), {
    isPublic: publicRootPredicate(publicRoots),
    ...(options.platform ? { platform: options.platform } : {}),
  });
}

/** Each distinct absolute value of `names`, or this process's `fallback` when none is set. */
function spellings(
  environment: NodeJS.ProcessEnv,
  names: readonly string[],
  platform: NodeJS.Platform,
  fallback: () => string,
): string[] {
  const pathApi = platform === "win32" ? win32 : posix;
  const values = new Set<string>();
  for (const name of names) {
    const value = environment[name];
    if (value && pathApi.isAbsolute(value)) values.add(value);
  }
  if (values.size > 0) return [...values];
  const value = attempt(fallback);
  return value ? [value] : [];
}

function attempt<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}
