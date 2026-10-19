// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Operator sentences for a checkout whose own git configuration would run a
 * program during a read; `prepareRepositoryWorkspace` refuses it before reading.
 *
 * - Every surface that reports this condition renders from
 *   {@link repositoryConfigurationRefusalMessage}.
 * - Messages use only frozen literals here. No configuration value, host path,
 *   repository content, or subsection name is interpolated, so the sentence set
 *   is finite and a shape test enumerates it.
 * - Remediation is non-destructive first and names the scope the entry was read
 *   from: `git config --unset` with no scope flag writes `--local` and exits 5
 *   against a worktree-only key.
 * - {@link classifyRepositoryConfigurationKey} is the only definition of what
 *   refuses. An unshipped code or scope raises instead of rendering empty text.
 */

export type RepositoryConfigurationRefusalCodeV1 =
  | "hooks-path"
  | "filesystem-monitor"
  | "attributes-file"
  | "excludes-file"
  | "content-filter"
  | "diff-external-driver"
  | "diff-named-driver"
  | "remote-transport-helper"
  | "archive-command"
  | "included-configuration"
  | "worktree-configuration-unreadable";

/**
 * `"local"` is `.git/config`, shared by every linked worktree. `"worktree"` is
 * `config.worktree`, which binds only where `extensions.worktreeConfig` is on.
 */
export type RepositoryConfigurationScopeV1 = "local" | "worktree";

export const REPOSITORY_CONFIGURATION_REFUSAL_CODES: readonly RepositoryConfigurationRefusalCodeV1[] =
  Object.freeze([
    "hooks-path",
    "filesystem-monitor",
    "attributes-file",
    "excludes-file",
    "content-filter",
    "diff-external-driver",
    "diff-named-driver",
    "remote-transport-helper",
    "archive-command",
    "included-configuration",
    "worktree-configuration-unreadable",
  ]);

export const REPOSITORY_CONFIGURATION_SCOPES: readonly RepositoryConfigurationScopeV1[] =
  Object.freeze(["local", "worktree"]);

const REPOSITORY_CONFIGURATION_CAUSES: Readonly<
  Record<RepositoryConfigurationRefusalCodeV1, string>
> = Object.freeze({
  "hooks-path":
    "The selected repository's own git configuration sets core.hooksPath, which would let the repository run its own programs while DocsFab reads it, so nothing was read and nothing was exported.",
  "filesystem-monitor":
    "The selected repository's own git configuration sets core.fsmonitor, which would let the repository run its own program while DocsFab reads it, so nothing was read and nothing was exported.",
  "attributes-file":
    "The selected repository's own git configuration sets core.attributesFile, which points attribute lookup at a file outside the repository and can select a program to run over file contents, so nothing was read and nothing was exported.",
  "excludes-file":
    "The selected repository's own git configuration sets core.excludesFile, which points ignore lookup at a file outside the repository and changes which files a read would see, so nothing was read and nothing was exported.",
  "content-filter":
    "The selected repository's own git configuration sets a content filter driver (a filter entry naming a clean, smudge, process or required program), which would run over file contents while DocsFab reads them, so nothing was read and nothing was exported.",
  "diff-external-driver":
    "The selected repository's own git configuration sets diff.external, which would run a program over file contents while DocsFab reads them, so nothing was read and nothing was exported.",
  "diff-named-driver":
    "The selected repository's own git configuration sets a named diff driver (a diff entry naming a command or a textconv program), which would run over file contents while DocsFab reads them, so nothing was read and nothing was exported.",
  "remote-transport-helper":
    "The selected repository's own git configuration sets a remote uploadpack or receivepack program, which would run while DocsFab reads the repository, so nothing was read and nothing was exported.",
  "archive-command":
    "The selected repository's own git configuration sets a tar archive command, which would run while DocsFab reads the repository, so nothing was read and nothing was exported.",
  "included-configuration":
    "The selected repository's own git configuration includes another configuration file through an include or includeIf entry, and DocsFab reads configuration without following includes, so it cannot see what that file would set and will not read the repository on the assumption that it is harmless; nothing was read and nothing was exported.",
  "worktree-configuration-unreadable":
    "The selected repository keeps per-worktree git configuration, and DocsFab could not read that scope, so it stopped rather than screen only the part of the configuration it could see; nothing was read and nothing was exported.",
});

const REPOSITORY_CONFIGURATION_LOCATIONS: Readonly<Record<RepositoryConfigurationScopeV1, string>> =
  Object.freeze({
    local:
      "The entry is in the repository's own .git/config, which every linked worktree of this checkout shares.",
    worktree:
      "The entry is in this checkout's own config.worktree, not in the .git/config that the rest of the repository shares.",
  });

const REPOSITORY_CONFIGURATION_SCOPE_FLAGS: Readonly<
  Record<RepositoryConfigurationScopeV1, string>
> = Object.freeze({ local: "--local", worktree: "--worktree" });

/**
 * `<name>` and `<format>` are placeholders, not the observed subsection, so
 * operator text never reaches a sentence every surface prints verbatim.
 */
const REPOSITORY_CONFIGURATION_CLEAR_ARGUMENTS: Readonly<
  Record<RepositoryConfigurationRefusalCodeV1, string | null>
> = Object.freeze({
  "hooks-path": "--unset core.hooksPath",
  "filesystem-monitor": "--unset core.fsmonitor",
  "attributes-file": "--unset core.attributesFile",
  "excludes-file": "--unset core.excludesFile",
  "content-filter": "--remove-section filter.<name>",
  "diff-external-driver": "--unset diff.external",
  "diff-named-driver": "--remove-section diff.<name>",
  "remote-transport-helper": "--unset remote.<name>.uploadpack",
  "archive-command": "--unset tar.<format>.command",
  "included-configuration": "--remove-section include",
  // Nothing to clear: this code reports a scope DocsFab could not read at all.
  "worktree-configuration-unreadable": null,
});

const REPOSITORY_CONFIGURATION_NOTES: Readonly<
  Partial<Record<RepositoryConfigurationRefusalCodeV1, string>>
> = Object.freeze({
  "content-filter":
    "DocsFab reads a repository with global and system git configuration switched off, so a Git LFS filter installed for your whole account is invisible to it and never stops it; only git lfs install --local writes one into a checkout. If you clear the section rather than switching checkouts, install the filter for your account with git lfs install first, because removing the section alone leaves Git LFS pointer files in the working tree where file content should be.",
  "remote-transport-helper":
    "Name the receivepack key instead if that is the one that is set, and clear every remote that sets one.",
  "included-configuration":
    "An includeIf section is named includeIf.<condition> rather than include, so clear that section too if this repository has one.",
  "worktree-configuration-unreadable":
    "Check that git config --worktree --list succeeds in this checkout, or select a checkout that does not keep per-worktree configuration, then retry.",
});

/** Codes whose note carries the whole remediation, so no command is offered. */
const REPOSITORY_CONFIGURATION_SELF_REMEDIED: ReadonlySet<RepositoryConfigurationRefusalCodeV1> =
  new Set<RepositoryConfigurationRefusalCodeV1>(["worktree-configuration-unreadable"]);

function assertShipped(
  code: RepositoryConfigurationRefusalCodeV1,
  scope: RepositoryConfigurationScopeV1,
): void {
  if (!REPOSITORY_CONFIGURATION_REFUSAL_CODES.includes(code)) {
    throw new Error(
      `A repository configuration refusal requires one shipped refusal code. Received ${JSON.stringify(code)}.`,
    );
  }
  if (!REPOSITORY_CONFIGURATION_SCOPES.includes(scope)) {
    throw new Error(
      `A repository configuration refusal requires one shipped configuration scope. Received ${JSON.stringify(scope)}.`,
    );
  }
}

/** Render the operator sentence for one family read from one scope. */
export function repositoryConfigurationRefusalMessage(
  code: RepositoryConfigurationRefusalCodeV1,
  scope: RepositoryConfigurationScopeV1,
): string {
  assertShipped(code, scope);
  const parts: string[] = [REPOSITORY_CONFIGURATION_CAUSES[code]];
  const clear = REPOSITORY_CONFIGURATION_CLEAR_ARGUMENTS[code];
  if (!REPOSITORY_CONFIGURATION_SELF_REMEDIED.has(code) && clear !== null) {
    parts.push(REPOSITORY_CONFIGURATION_LOCATIONS[scope]);
    parts.push(
      `Select a checkout that does not carry it, or clear it where it is with git config ${REPOSITORY_CONFIGURATION_SCOPE_FLAGS[scope]} ${clear}, then retry.`,
    );
  }
  const note = REPOSITORY_CONFIGURATION_NOTES[code];
  if (note !== undefined) parts.push(note);
  return parts.join(" ");
}

/**
 * Read in order, so include families win over key-specific ones. Include
 * patterns are prefixes because keys arrive as `include.path` and
 * `includeif.gitdir:….path`; the rest are exact git keys.
 */
const REPOSITORY_CONFIGURATION_REFUSAL_RULES: readonly {
  readonly code: RepositoryConfigurationRefusalCodeV1;
  readonly pattern: RegExp;
}[] = Object.freeze([
  { code: "included-configuration", pattern: /^include\./u },
  { code: "included-configuration", pattern: /^includeif\./u },
  { code: "hooks-path", pattern: /^core\.hookspath$/u },
  { code: "filesystem-monitor", pattern: /^core\.fsmonitor$/u },
  { code: "attributes-file", pattern: /^core\.attributesfile$/u },
  { code: "excludes-file", pattern: /^core\.excludesfile$/u },
  { code: "diff-external-driver", pattern: /^diff\.external$/u },
  { code: "diff-named-driver", pattern: /^diff\..*\.(?:command|textconv)$/u },
  { code: "content-filter", pattern: /^filter\..*\.(?:clean|smudge|process|required)$/u },
  { code: "remote-transport-helper", pattern: /^remote\..*\.(?:uploadpack|receivepack)$/u },
  { code: "archive-command", pattern: /^tar\..*\.command$/u },
]);

/**
 * Name the refusing family for one key, or `undefined` when it is admitted.
 * The caller lowercases the whole key, since `git config --list` does not
 * lowercase subsection names.
 */
export function classifyRepositoryConfigurationKey(
  key: string,
): RepositoryConfigurationRefusalCodeV1 | undefined {
  for (const rule of REPOSITORY_CONFIGURATION_REFUSAL_RULES) {
    if (rule.pattern.test(key)) return rule.code;
  }
  return undefined;
}

/** Git's false spellings. A key present with no value is true to git. */
const GIT_FALSE_VALUES: ReadonlySet<string> = new Set(["false", "no", "off", "0", ""]);

/**
 * Whether `extensions.worktreeConfig` is on, given the `--local` listing. An
 * unrecognized value counts as enabled so worktree scope is screened.
 */
export function worktreeConfigurationEnabled(
  entries: readonly { readonly key: string; readonly value: string | undefined }[],
): boolean {
  for (const entry of entries) {
    if (entry.key !== "extensions.worktreeconfig") continue;
    if (entry.value === undefined) return true;
    if (!GIT_FALSE_VALUES.has(entry.value.trim().toLowerCase())) return true;
  }
  return false;
}

/**
 * A repository refused for its own executable or included git configuration.
 * Separate from `RepositoryWorkspaceMaterializationError` because the read was
 * declined before it began and the fix is a git configuration change.
 */
export class RepositoryConfigurationRefusalError extends Error {
  public readonly code: RepositoryConfigurationRefusalCodeV1;
  public readonly scope: RepositoryConfigurationScopeV1;

  public constructor(
    code: RepositoryConfigurationRefusalCodeV1,
    scope: RepositoryConfigurationScopeV1,
  ) {
    super(repositoryConfigurationRefusalMessage(code, scope));
    this.name = "RepositoryConfigurationRefusalError";
    this.code = code;
    this.scope = scope;
  }
}

export function failRepositoryConfiguration(
  code: RepositoryConfigurationRefusalCodeV1,
  scope: RepositoryConfigurationScopeV1,
): never {
  throw new RepositoryConfigurationRefusalError(code, scope);
}
