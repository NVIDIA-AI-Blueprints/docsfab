// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Which Git configuration the host refuses to publish with (#2363).
 *
 * One policy, two callers. The host publisher applies it before every commit,
 * push, and merge request, and delivery preflight applies the same function to
 * the same listing before a run starts, so a setting the publisher would
 * refuse is refused, naming the key and where it is set, before the model is
 * called. The two cannot disagree because neither holds a rule of its own.
 *
 * A setting that can run a command, change how DocsFab pushes, or turn
 * signing on is refused, except where the setting is the operator's own or
 * inert:
 *
 * - `commit.gpgSign` and `tag.gpgSign` are accepted from any file when they are
 *   set to an explicit false: the host already forces signing off on its own
 *   Git commands, so a repository that turns it off asks for nothing.
 * - `core.sshCommand` and `core.askPass` are accepted from a trusted file,
 *   the operator's own global or system Git configuration. They are refused
 *   in the checkout's own configuration and in any file that is not trusted,
 *   which includes a file that a configuration file includes. A global file
 *   counts as the operator's own only when `HOME` is an absolute path that no
 *   repository directory contains: a relative `HOME` names a path in the
 *   directory Git runs in, and a `HOME` inside the checkout names a file the
 *   repository can track. The system files do not depend on `HOME`.
 * - Signing set to true, `gpg.*`, `user.signingKey`, and `url.*.insteadOf` are
 *   accepted only from a trusted file, as before.
 * - Everything else in the refused set is refused wherever it is set, except
 *   the two `-c` overrides the host passes to its own Git commands.
 *
 * This module imports only Node's `path` and `fs/promises`, so preflight and the
 * publisher can both import it without a cycle.
 */

import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

/** What Git prints as the origin of a `-c` setting. */
const COMMAND_LINE_ORIGIN = "command line:";

/**
 * The operational limit on the output of the listing below, in bytes. Delivery
 * preflight and the publisher both read the listing under this one bound, so a
 * listing that one admits is a listing the other admits. One that exceeds it
 * stops both with `git-checkout-unverified`: preflight names the limit in its
 * message, and the next action of that code names it for the publisher.
 */
export const GIT_CONFIGURATION_LISTING_LIMIT = "delivery.gitConfigurationListingMaxBytes";

/**
 * The arguments, after the host's `-c` overrides, that read the configuration
 * Git applies in a checkout, with the origin of every entry.
 */
export const GIT_CONFIGURATION_LIST_ARGS = [
  "config",
  "--includes",
  "--show-origin",
  "--null",
  "--list",
] as const;

/**
 * The `-c` overrides that every host Git invocation carries. The listing
 * shows them with the origin `command line:`, and the policy accepts exactly
 * the two among them that it would otherwise refuse (`core.hooksPath` set to
 * `/dev/null` and `core.fsmonitor` set to `false`).
 */
export const HOST_GIT_CONFIG_FLAGS = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "commit.gpgSign=false",
  "-c",
  "tag.gpgSign=false",
  "-c",
  "diff.trustExitCode=false",
  "-c",
  "protocol.allow=never",
  "-c",
  "protocol.ssh.allow=always",
  "-c",
  "protocol.https.allow=always",
] as const;

/** One entry of the listing that `GIT_CONFIGURATION_LIST_ARGS` prints. */
export interface GitConfigurationEntry {
  /** Git's origin label: `file:<path>`, `command line:`, `standard input:`, or `blob:<id>`. */
  readonly origin: string;
  /** The key as Git lists it: section and variable lower-cased, any subsection as written. */
  readonly key: string;
  readonly value: string;
}

export interface GitConfigurationContext {
  /** The operator's `HOME`, which locates the trusted global files. */
  readonly home: string | undefined;
  /** The GitLab host the publication targets; a credential helper applies by host. */
  readonly host: string;
  /**
   * The directories whose files the repository supplies: the checkout the
   * listing was read in and, for a delivery worktree, the checkout it was made
   * from. A `HOME` that is one of them or lies inside one is not the operator's
   * own, so its global files are not trusted for `core.sshCommand` and
   * `core.askPass`.
   */
  readonly repositoryRoots?: readonly string[];
  /**
   * `home` with symbolic links resolved, which `resolveGitConfigurationPaths`
   * fills in. A `HOME` that is a link into the checkout is inside it.
   */
  readonly homeResolved?: string;
}

/**
 * Add what the filesystem knows to a context, so that a path and a link to it
 * compare as one: the real path of `HOME`, and the real path of each repository
 * root beside the root as given. A path that does not resolve keeps only its own
 * form. Both callers do this before `assessGitConfigurationList`.
 */
export async function resolveGitConfigurationPaths(
  context: GitConfigurationContext,
): Promise<GitConfigurationContext> {
  const real = (path: string): Promise<string | undefined> =>
    realpath(path).then(
      (resolved) => resolved,
      () => undefined,
    );
  const roots = new Set<string>();
  for (const root of context.repositoryRoots ?? []) {
    if (root.length === 0) continue;
    roots.add(root);
    const resolved = await real(root);
    if (resolved !== undefined) roots.add(resolved);
  }
  const homeResolved =
    context.home && isAbsolute(context.home) ? await real(context.home) : undefined;
  return {
    ...context,
    repositoryRoots: [...roots],
    ...(homeResolved !== undefined ? { homeResolved } : {}),
  };
}

/**
 * Why a setting from a file DocsFab otherwise trusts was refused anyway: the
 * file is a global file, but `HOME` is not an absolute path outside the
 * repository, so it is not the operator's own.
 */
export type GitConfigurationRefusalReason = "home-not-operator-owned";

export type GitConfigurationVerdict =
  | { readonly accepted: true }
  | {
      readonly accepted: false;
      /** The refused setting, safe to show: its subsection never appears. */
      readonly setting: string;
      /** Git's origin label for the entry. */
      readonly origin: string;
      readonly reason?: GitConfigurationRefusalReason;
    };

export type GitConfigurationAssessment =
  | { readonly status: "ok" }
  /** The listing does not parse, so DocsFab cannot say what the configuration holds. */
  | { readonly status: "unreadable" }
  | {
      readonly status: "refused";
      readonly setting: string;
      readonly origin: string;
      readonly reason?: GitConfigurationRefusalReason;
    };

/**
 * The settings the host refuses, whatever their value, except where a rule in
 * `evaluateGitConfigurationEntry` accepts the entry. Matched against the
 * lower-cased key.
 *
 * Every pattern here that matches a subsection uses the `s` flag, so that `.`
 * matches any character. A subsection is free text, and without the flag a line
 * separator in it (U+2028, U+2029, or a carriage return) would carry the key past
 * the rule that names it.
 */
const REFUSED_KEYS =
  /^(?:core\.(?:hookspath|fsmonitor|sshcommand|gitproxy|askpass)|url\..*\.(?:insteadof|pushinsteadof)|remote\..*\.(?:receivepack|uploadpack|proxy|mirror|pushoption)|http\..*\.(?:extraheader|proxy)|commit\.gpgsign|tag\.gpgsign|gpg\..*|user\.signingkey|push\.pushoption)$/su;

/** The signing switches: accepted from any file when set to an explicit false. */
const SIGNING_SWITCH_KEYS = /^(?:commit|tag)\.gpgsign$/u;

/** The operator's own transport settings: accepted from a file the operator owns. */
const OPERATOR_TRANSPORT_KEYS = /^core\.(?:sshcommand|askpass)$/u;

/** Accepted from a trusted file, as they were before #2363: signing, signing keys, URL rewrites. */
const INERT_TRUSTED_KEYS =
  /^(?:commit\.gpgsign|tag\.gpgsign|gpg\..*|user\.signingkey|url\..*\.(?:insteadof|pushinsteadof))$/su;

/** Git's boolean false spellings, which are not case sensitive. */
const GIT_FALSE = /^(?:false|no|off|0)$/iu;

/**
 * Whether Git reads a file as the operator's own: the global files under
 * `HOME`, and the fixed system paths. Any other file is not trusted,
 * including the checkout's own configuration and a file that one includes.
 */
export function trustedConfigurationOrigin(origin: string, home: string | undefined): boolean {
  if (!origin.startsWith("file:")) return false;
  const path = origin.slice("file:".length);
  return homeConfigurationPath(path, home) || systemConfigurationPath(path);
}

/**
 * Whether a trusted file is one the operator owns, which is what the settings
 * that run a command need. A system file always is. A global file is only when
 * `HOME` is an absolute path that no repository directory contains: Git reads a
 * relative `HOME` as a path in the directory it runs in, and a `HOME` inside the
 * checkout names a file the repository can track. Neither is trusted for
 * `core.sshCommand` or `core.askPass`, though both stay trusted for the inert
 * settings, as before.
 */
export function operatorConfigurationOrigin(
  origin: string,
  context: Pick<GitConfigurationContext, "home" | "homeResolved" | "repositoryRoots">,
): boolean {
  if (!trustedConfigurationOrigin(origin, context.home)) return false;
  if (!homeConfigurationPath(origin.slice("file:".length), context.home)) return true;
  return operatorHome(context);
}

function homeConfigurationPath(path: string, home: string | undefined): boolean {
  return Boolean(home) && (path === `${home}/.gitconfig` || path === `${home}/.config/git/config`);
}

function systemConfigurationPath(path: string): boolean {
  return (
    path === "/etc/gitconfig" ||
    path === "/usr/local/etc/gitconfig" ||
    path === "/usr/share/git-core/gitconfig" ||
    /^\/(?:Library\/Developer\/CommandLineTools|Applications\/Xcode\.app\/Contents\/Developer)\/usr\/share\/git-core\/gitconfig$/u.test(
      path,
    ) ||
    /^[A-Za-z]:\/Program Files(?: \(x86\))?\/Git\/etc\/gitconfig$/u.test(path)
  );
}

function operatorHome(
  context: Pick<GitConfigurationContext, "home" | "homeResolved" | "repositoryRoots">,
): boolean {
  const { home, homeResolved } = context;
  if (!home || !isAbsolute(home)) return false;
  return !(context.repositoryRoots ?? []).some(
    (root) =>
      root.length > 0 &&
      (insideDirectory(home, root) ||
        (homeResolved !== undefined && insideDirectory(homeResolved, root))),
  );
}

/** Whether `path` is `directory` or lies inside it, comparing the resolved paths. */
function insideDirectory(path: string, directory: string): boolean {
  // `relative` is "" for the directory itself, which none of the three tests below rejects.
  const from = relative(resolve(directory), resolve(path));
  return from !== ".." && !from.startsWith(`..${sep}`) && !isAbsolute(from);
}

/**
 * The per-key decision: accept one configuration entry or refuse it. The
 * publisher and delivery preflight both call this and nothing else.
 */
export function evaluateGitConfigurationEntry(
  entry: GitConfigurationEntry,
  context: GitConfigurationContext,
): GitConfigurationVerdict {
  const key = entry.key.toLowerCase();
  const trusted = trustedConfigurationOrigin(entry.origin, context.home);
  const refused = (reason?: GitConfigurationRefusalReason): GitConfigurationVerdict => ({
    accepted: false,
    setting: displayGitConfigurationKey(key),
    origin: entry.origin,
    ...(reason ? { reason } : {}),
  });

  if ((key === "include.path" || /^includeif\..*\.path$/su.test(key)) && !trusted) {
    return refused();
  }
  if (REFUSED_KEYS.test(key)) {
    if (SIGNING_SWITCH_KEYS.test(key) && GIT_FALSE.test(entry.value)) return ACCEPTED;
    if (
      entry.origin === COMMAND_LINE_ORIGIN &&
      ((key === "core.hookspath" && entry.value === "/dev/null") ||
        (key === "core.fsmonitor" && entry.value === "false"))
    ) {
      return ACCEPTED;
    }
    if (OPERATOR_TRANSPORT_KEYS.test(key)) {
      if (operatorConfigurationOrigin(entry.origin, context)) return ACCEPTED;
      // A global file under a HOME that is not the operator's own: only a global file is
      // trusted without being the operator's, because a system file always is.
      if (trusted) return refused("home-not-operator-owned");
    }
    if (trusted && INERT_TRUSTED_KEYS.test(key)) return ACCEPTED;
    return refused();
  }
  if (/^credential\..*helper$/su.test(key)) {
    const executable = entry.value.trimStart().startsWith("!");
    if (credentialHelperAppliesToHost(key, context.host) && (executable || !trusted)) {
      return refused();
    }
  }
  return ACCEPTED;
}

/**
 * Parse the listing and evaluate each entry in order; the first entry that
 * does not parse or is refused decides. A listing that does not parse is
 * `unreadable`, never silently accepted.
 */
export function assessGitConfigurationList(
  listing: string | Uint8Array,
  context: GitConfigurationContext,
): GitConfigurationAssessment {
  const text = typeof listing === "string" ? listing : new TextDecoder("utf-8").decode(listing);
  const fields = text.split("\0");
  if (fields.at(-1) === "") fields.pop();
  if (fields.length % 2 !== 0) return UNREADABLE;
  for (let index = 0; index < fields.length; index += 2) {
    const origin = fields[index]!;
    const keyValue = fields[index + 1]!;
    const newline = keyValue.indexOf("\n");
    if (!origin || origin.includes("\n") || newline <= 0) return UNREADABLE;
    const verdict = evaluateGitConfigurationEntry(
      { origin, key: keyValue.slice(0, newline), value: keyValue.slice(newline + 1) },
      context,
    );
    if (!verdict.accepted) {
      return {
        status: "refused",
        setting: verdict.setting,
        origin: verdict.origin,
        ...(verdict.reason ? { reason: verdict.reason } : {}),
      };
    }
  }
  return OK;
}

/**
 * A setting's key for an operator message. A subsection can hold anything,
 * including a URL with a credential (`url.<base>.insteadOf` and
 * `http.<url>.extraHeader` carry one), so it is replaced and never shown.
 * Section and variable names are limited to letters, digits, and `-` by Git.
 */
export function displayGitConfigurationKey(key: string): string {
  const first = key.indexOf(".");
  const last = key.lastIndexOf(".");
  return first === last ? key : `${key.slice(0, first)}.*.${key.slice(last + 1)}`;
}

/**
 * An origin for an operator message: the operator's home directory is
 * abbreviated to `~`. `command line:` and the other non-file origins are
 * returned unchanged.
 */
export function displayGitConfigurationOrigin(origin: string, home: string | undefined): string {
  if (!origin.startsWith("file:") || !home) return origin;
  const path = origin.slice("file:".length);
  return path === home || path.startsWith(`${home}/`) ? `file:~${path.slice(home.length)}` : origin;
}

function credentialHelperAppliesToHost(key: string, selectedHost: string): boolean {
  if (key === "credential.helper") return true;
  const scope = key.slice("credential.".length, -".helper".length);
  try {
    return new URL(scope).hostname.toLowerCase() === selectedHost.toLowerCase();
  } catch {
    return true;
  }
}

const ACCEPTED: GitConfigurationVerdict = Object.freeze({ accepted: true });
const OK: GitConfigurationAssessment = Object.freeze({ status: "ok" });
const UNREADABLE: GitConfigurationAssessment = Object.freeze({ status: "unreadable" });
