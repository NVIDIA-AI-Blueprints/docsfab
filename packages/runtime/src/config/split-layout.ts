// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, existsSync, readFileSync } from "node:fs";
import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  readlink,
  rename,
  rmdir,
  symlink,
  unlink,
  utimes,
} from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import {
  parseDotenvAssignmentLines,
  parseDotenvAssignments,
  parseDotenvLine,
  serializeDotenvAssignment,
} from "./dotenv.js";
import { currentCliModelSettings, type CliModelSettings } from "./cli-model-settings.js";
import {
  applyModelSlotSettings,
  type ModelSettingSlot,
  type ModelSlotBase,
  type ModelSlotFileLayer,
} from "./model-settings.js";
import {
  readConfigurationRootLimitOverrides,
  readHostLimitOverrides,
  resolveHostLimitFile,
} from "./host-limit-file.js";
import {
  HostLimitsFileError,
  resolveLimitDefinitions,
  type SharedResolvedLimit,
} from "./limit-resolution.js";
import { LIMIT_DEFINITION_BY_NAME } from "./limits.generated.js";
import {
  applyCompositionCredentialAlias,
  isExecutablePreset,
  presetSlotAssignments,
  projectPurposeQualification,
  selectPurposeCompositionId,
} from "./execution-profile.js";
import {
  decodeHostConfig,
  decodeModelProfile,
  defaultHostConfig,
  modelProfileFromAssignments,
  projectHostConfigToEnvironment,
  projectModelProfileToEnvironment,
  resolveHostJudgeSlot,
  resolveHostWritingSlot,
  resolveHostYamlJudgeProfile,
  resolveHostYamlPolicyProfile,
  SECRET_ENV_KEYS,
  type DocsFabHostConfigV1,
  type DocsFabModelProfileV1,
  type HostPurposeSlotV1,
} from "./profile-projection.js";
import { refreshConfiguredCredentials } from "../security/configured-credentials.js";

function profileRelativePathFromModelId(modelId: string): string {
  const slug = modelId
    .trim()
    .replace(/\//gu, "-")
    .replace(/[^a-zA-Z0-9.-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  if (!slug) throw new Error("Model profile filenames require a non-empty model id.");
  return `${PROFILES_DIRECTORY}/${slug}.yaml`;
}

export const HOST_CONFIG_FILE = "host.yaml";
export const SECRETS_ENV_FILE = "secrets.env";
/** Exclusive-create lock that serializes every secrets.env read-merge-write. */
export const SECRETS_ENV_LOCK_FILE = "secrets.env.lock";
export const PROFILES_DIRECTORY = "profiles";
export const LEGACY_ENV_BACKUP = ".env.legacy";

export function resolveHostConfigPath(configurationRoot: string): string {
  return resolve(configurationRoot, HOST_CONFIG_FILE);
}

export function resolveSecretsEnvPath(configurationRoot: string): string {
  return resolve(configurationRoot, SECRETS_ENV_FILE);
}

export function resolveProfilesDirectory(configurationRoot: string): string {
  return resolve(configurationRoot, PROFILES_DIRECTORY);
}

export function usesSplitLayout(configurationRoot: string): boolean {
  return existsSync(resolveHostConfigPath(configurationRoot));
}

export function resolveProfilePath(configurationRoot: string, relativePath: string): string {
  const normalized = relativePath.trim();
  if (!normalized || normalized.includes("\0") || isAbsolute(normalized)) {
    throw new Error("Profile paths must be relative paths under the configuration root.");
  }
  const absolute = resolve(configurationRoot, normalized);
  const profilesRoot = resolveProfilesDirectory(configurationRoot);
  if (absolute !== profilesRoot && !absolute.startsWith(`${profilesRoot}/`)) {
    throw new Error("Profile paths must resolve to a location under the profiles/ directory.");
  }
  return absolute;
}

function readYamlFile(path: string): unknown {
  const source = readFileSync(path, "utf8");
  return parseYaml(source);
}

/** How a configuration load applies this invocation's model selections. */
export interface ModelSettingsLoadOptions {
  /** The preset `--composition` selected for the writing slot, for this run only. */
  readonly writingPreset?: string;
  /** `--set` values; defaults to the values this invocation's flags registered. */
  readonly cli?: CliModelSettings;
}

/** A dotenv file's assignments with their lines, or undefined when it is absent. */
export function readModelSettingsFileLayer(
  path: string | null,
  source: ModelSlotFileLayer["source"],
): ModelSlotFileLayer | undefined {
  if (path === null || !existsSync(path)) return undefined;
  return {
    source,
    path,
    assignments: parseDotenvAssignmentLines(readFileSync(path, "utf8")),
  };
}

/** The profile file's projected variables, as a slot base. */
function profileBase(path: string, profile: DocsFabModelProfileV1): ModelSlotBase {
  const assignments: NodeJS.ProcessEnv = {};
  projectModelProfileToEnvironment(profile, assignments);
  return {
    kind: "profile-file",
    id: path,
    source: "profile-file",
    assignments: new Map(
      Object.entries(assignments).flatMap(([name, value]) =>
        value === undefined ? [] : [[name, value] as const],
      ),
    ),
  };
}

function presetBase(
  presetId: string,
  slot: ModelSettingSlot,
  source: "cli-flag" | "host-config",
): ModelSlotBase {
  return {
    kind: "preset",
    id: presetId,
    source,
    assignments: presetSlotAssignments(presetId, slot === "writing" ? "policy" : "judge"),
  };
}

function hostSlotSettings(
  slot: HostPurposeSlotV1,
  hostPath: string,
):
  | {
      readonly path: string;
      readonly values: NonNullable<HostPurposeSlotV1["settings"]>;
    }
  | undefined {
  return slot.settings ? { path: hostPath, values: slot.settings } : undefined;
}

export function loadSplitLayoutIntoEnvironment(
  configurationRoot: string,
  target: NodeJS.ProcessEnv = process.env,
  options: ModelSettingsLoadOptions = {},
): DocsFabHostConfigV1 {
  const hostPath = resolveHostConfigPath(configurationRoot);
  const host = decodeHostConfig(readYamlFile(hostPath));
  projectHostConfigToEnvironment(host, target, configurationRoot);
  const cli = options.cli ?? currentCliModelSettings();

  const writingSlot = resolveHostWritingSlot(host);
  const judgeSlot = resolveHostJudgeSlot(host);
  // `--composition` selects this run's preset by id; an id that is not an
  // executable installed preset is left to the composition runtime's own refusal.
  const cliPreset =
    options.writingPreset !== undefined && isExecutablePreset(options.writingPreset)
      ? options.writingPreset
      : undefined;
  const writingCompositionId = cliPreset ?? selectPurposeCompositionId(writingSlot, "writing");
  const judgeCompositionId = selectPurposeCompositionId(judgeSlot, "judge");
  const yamlPolicyProfile = resolveHostYamlPolicyProfile(host);
  const yamlJudgeProfile = resolveHostYamlJudgeProfile(host);
  const secretsPath = resolveSecretsEnvPath(configurationRoot);
  const secrets = readModelSettingsFileLayer(secretsPath, "secrets-env");
  const files = secrets ? [secrets] : [];
  const common = { target, root: configurationRoot, files };
  if (writingCompositionId) {
    applyModelSlotSettings({
      ...common,
      slot: "writing",
      base: presetBase(writingCompositionId, "writing", cliPreset ? "cli-flag" : "host-config"),
      ...optionalHostSettings(writingSlot, hostPath),
      ...(cli ? { cli: cli.writing } : {}),
    });
  } else if (yamlPolicyProfile) {
    const policyPath = resolveProfilePath(configurationRoot, yamlPolicyProfile);
    const policyProfile = decodeModelProfile(readYamlFile(policyPath));
    if (policyProfile.slot !== "policy") {
      throw new Error(`The active policy profile ${yamlPolicyProfile} must declare slot: policy.`);
    }
    applyModelSlotSettings({
      ...common,
      slot: "writing",
      base: profileBase(policyPath, policyProfile),
      ...optionalHostSettings(writingSlot, hostPath),
      ...(cli ? { cli: cli.writing } : {}),
    });
  } else {
    throw new Error(
      "The host.yaml configuration file must name an installed execution profile or a YAML policy profile.",
    );
  }
  projectPurposeQualification("writing", writingSlot.qualification, target);
  projectPurposeQualification("judge", judgeSlot.qualification, target);

  if (judgeCompositionId) {
    applyModelSlotSettings({
      ...common,
      slot: "judge",
      base: presetBase(judgeCompositionId, "judge", "host-config"),
      ...optionalHostSettings(judgeSlot, hostPath),
      ...(cli ? { cli: cli.judge } : {}),
    });
    target.JUDGE_ENABLED = "true";
  } else if (yamlJudgeProfile) {
    const judgePath = resolveProfilePath(configurationRoot, yamlJudgeProfile);
    const judgeProfile = decodeModelProfile(readYamlFile(judgePath));
    if (judgeProfile.slot !== "judge") {
      throw new Error(`The active judge profile ${yamlJudgeProfile} must declare slot: judge.`);
    }
    applyModelSlotSettings({
      ...common,
      slot: "judge",
      base: profileBase(judgePath, judgeProfile),
      ...optionalHostSettings(judgeSlot, hostPath),
      ...(cli ? { cli: cli.judge } : {}),
    });
    target.JUDGE_ENABLED = "true";
  } else if (
    target.JUDGE_ENABLED?.trim().toLowerCase() === "true" ||
    secrets?.assignments.get("JUDGE_ENABLED")?.value.trim().toLowerCase() === "true"
  ) {
    // A judge configured by the environment or secrets.env still takes the
    // judge settings host.yaml holds, above its JUDGE_* defaults.
    applyModelSlotSettings({
      ...common,
      slot: "judge",
      ...optionalHostSettings(judgeSlot, hostPath),
    });
  }

  if (existsSync(secretsPath)) loadEnvFileIntoEnvironment(secretsPath, target);
  if (writingCompositionId) {
    applyCompositionCredentialAlias(writingCompositionId, target, "policy");
  }
  if (judgeCompositionId) applyCompositionCredentialAlias(judgeCompositionId, target, "judge");
  refreshConfiguredCredentials();
  return host;
}

function optionalHostSettings(
  slot: HostPurposeSlotV1,
  hostPath: string,
): { readonly hostSettings?: ReturnType<typeof hostSlotSettings> & object } {
  const settings = hostSlotSettings(slot, hostPath);
  return settings ? { hostSettings: settings } : {};
}

export async function writeHostConfigFile(
  configurationRoot: string,
  host: DocsFabHostConfigV1,
): Promise<void> {
  await replaceFileAtomically(resolveHostConfigPath(configurationRoot), `${stringifyYaml(host)}\n`);
}

export interface SecretsEnvWriteOptions {
  /** Environment that resolves the declared secrets lock bounds. */
  readonly environment?: NodeJS.ProcessEnv;
  /**
   * Fault-injection seam: runs after each complete temporary file is flushed
   * and before it replaces its target. A throw abandons the change.
   */
  readonly onTemporaryWritten?: (temporaryPath: string) => void | Promise<void>;
}

export type SecretsEnvWriteOutcome = "written" | "unchanged";

/** The secrets.env part of a configuration-root change. */
export interface SecretsEnvChange {
  /** Proposed assignments, computed under the lock from the stored values. */
  readonly merge: (stored: ReadonlyMap<string, string>) => ReadonlyArray<readonly [string, string]>;
  /**
   * Secret names the caller explicitly clears. Only these names may replace a
   * stored non-empty value with an empty one; every other empty assignment
   * keeps the stored value.
   */
  readonly clear?: readonly string[];
  /** Create secrets.env only when it is missing; an existing file is kept as is. */
  readonly onlyWhenAbsent?: boolean;
}

/** Configuration-root files that one setup action replaces together. */
export interface ConfigurationRootChange {
  /** Model profiles, keyed by a path relative to the configuration root. */
  readonly profiles?: ReadonlyArray<
    readonly [relativePath: string, profile: DocsFabModelProfileV1]
  >;
  /**
   * The new host.yaml. A function receives host.yaml as read under the lock
   * (undefined when missing or unreadable), so concurrent setups merge into
   * the latest file.
   */
  readonly host?:
    | DocsFabHostConfigV1
    | ((current: DocsFabHostConfigV1 | undefined) => DocsFabHostConfigV1);
  readonly secrets?: SecretsEnvChange;
  /** Renames applied after every file is written, such as the legacy .env backup. */
  readonly moves?: ReadonlyArray<readonly [from: string, to: string]>;
}

/**
 * Merge assignments into secrets.env. Stored names that the assignments omit
 * are kept, and an empty assignment never blanks a stored value unless the
 * caller lists it in `clear`.
 */
export async function writeSecretsEnvFile(
  configurationRoot: string,
  assignments: ReadonlyArray<readonly [string, string]>,
  options: SecretsEnvWriteOptions & { readonly clear?: readonly string[] } = {},
): Promise<SecretsEnvWriteOutcome> {
  const { clear, ...commitOptions } = options;
  return commitConfigurationRootChange(
    configurationRoot,
    { secrets: { merge: () => assignments, ...(clear ? { clear } : {}) } },
    commitOptions,
  );
}

/**
 * Apply one configuration-root change as a unit, under the secrets.env lock.
 *
 * Every refusal (lock wait, invalid lock, secret name, unrepresentable value,
 * multi-line replacement) happens before the first write, so a refused change
 * leaves the root as it was. Files are then replaced one at a time through a
 * flushed 0600 temporary file, secrets.env first. The lock is rechecked before
 * every rename; a lost lock stops the change with secrets-env-lock-lost.
 *
 * Each replaced file is first kept under a hard-linked backup name (a symlink
 * keeps its link text), so a failed change renames the originals back with
 * their mode and without needing free space. A file that another writer
 * replaced in the meantime is left alone. When any original cannot be put
 * back, the change stops with setup-commit-incomplete naming those paths.
 * A crash partway through is not undone.
 *
 * Identical content is not rewritten. In secrets.env, only the assignment
 * lines of keys whose value changes are replaced and new keys are appended;
 * every other line (comments, unknown or lower-case keys, multi-line values,
 * formatting) is kept byte for byte. A symlinked secrets.env is replaced by a
 * regular file; the link target is never written.
 *
 * Returns whether secrets.env was rewritten.
 */
export async function commitConfigurationRootChange(
  configurationRoot: string,
  change: ConfigurationRootChange,
  options: SecretsEnvWriteOptions = {},
): Promise<SecretsEnvWriteOutcome> {
  const profileFiles = (change.profiles ?? []).map(([relativePath, profile]) => ({
    path: resolveProfilePath(configurationRoot, relativePath),
    contents: `${stringifyYaml(profile)}\n`,
  }));
  if (!profileFiles.length && !change.host && !change.secrets && !change.moves?.length) {
    return "unchanged";
  }

  const secretsPath = resolveSecretsEnvPath(configurationRoot);
  const hostPath = resolveHostConfigPath(configurationRoot);
  const lease = await acquireSecretsEnvLock(configurationRoot, options.environment);
  try {
    const currentSecrets = await readOptionalFile(secretsPath);
    const nextSecrets = change.secrets
      ? planSecretsEnvText(currentSecrets, change.secrets)
      : undefined;
    const currentHost = change.host ? await readOptionalFile(hostPath) : undefined;
    const host =
      typeof change.host === "function"
        ? change.host(decodeOptionalHost(currentHost))
        : change.host;
    const writes: PlannedFileWrite[] = [];
    if (nextSecrets !== undefined && nextSecrets !== currentSecrets) {
      writes.push({ path: secretsPath, contents: nextSecrets });
    }
    for (const file of profileFiles) {
      if ((await readOptionalFile(file.path)) !== file.contents) writes.push(file);
    }
    if (host) {
      const contents = `${stringifyYaml(host)}\n`;
      if (currentHost !== contents) writes.push({ path: hostPath, contents });
    }

    await removeOrphanedCommitFiles(configurationRoot);
    if (writes.length === 0 && !change.moves?.length) return "unchanged";
    await applyPlannedWrites(configurationRoot, writes, change.moves ?? [], async (tmp) => {
      if (tmp !== undefined) await options.onTemporaryWritten?.(tmp);
      await lease.assertHeld();
    });
    return writes.some((write) => write.path === secretsPath) ? "written" : "unchanged";
  } finally {
    await lease.release();
  }
}

function decodeOptionalHost(source: string | undefined): DocsFabHostConfigV1 | undefined {
  if (source === undefined) return undefined;
  try {
    return decodeHostConfig(parseYaml(source));
  } catch {
    return undefined;
  }
}

interface PlannedFileWrite {
  readonly path: string;
  readonly contents: string;
}

/**
 * The next secrets.env text, or undefined when this change leaves it alone.
 * Throws the coded refusal when the update cannot be written losslessly.
 */
function planSecretsEnvText(
  current: string | undefined,
  change: SecretsEnvChange,
): string | undefined {
  if (change.onlyWhenAbsent && current !== undefined) return undefined;
  const stored =
    current === undefined ? new Map<string, string>() : parseDotenvAssignments(current);
  const changes = secretChanges(stored, change.merge(stored), new Set(change.clear ?? []));
  if (changes.size === 0) return undefined;
  return applySecretChanges(current, changes);
}

/** What a path held before this change replaced it. */
type PreservedEntry =
  | { readonly kind: "absent" }
  | { readonly kind: "unkept" }
  | { readonly kind: "file"; readonly backup: string }
  | { readonly kind: "symlink"; readonly target: string };

/** link() errors from a filesystem that cannot hard-link, where a copy is kept instead. */
const HARD_LINK_UNSUPPORTED = ["ENOTSUP", "EOPNOTSUPP", "EPERM", "EXDEV", "ENOSYS", "EMLINK"];

/**
 * Keep the entry at path so an undo can put it back unchanged. Without
 * keepBackup, only check that the path can be replaced.
 */
async function preserveEntry(
  configurationRoot: string,
  path: string,
  keepBackup: boolean,
): Promise<PreservedEntry> {
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return { kind: "absent" };
    throw error;
  }
  if (metadata.isSymbolicLink()) return { kind: "symlink", target: await readlink(path) };
  if (!metadata.isFile()) {
    throw new Error(`${path} is not a regular file, so setup cannot replace it.`);
  }
  if (!keepBackup) return { kind: "unkept" };
  const backup = `${path}.${process.pid}.${randomUUID()}.bak`;
  try {
    await link(path, backup);
  } catch (error) {
    if (!HARD_LINK_UNSUPPORTED.some((code) => hasErrorCode(error, code))) throw error;
    await copyBackup(configurationRoot, path, backup, metadata);
  }
  return { kind: "file", backup };
}

/**
 * Keep a copy of path at backup, with the original mode and timestamps where
 * the filesystem stores them, for a root that cannot hard-link.
 */
async function copyBackup(
  configurationRoot: string,
  path: string,
  backup: string,
  metadata: Awaited<ReturnType<typeof lstat>>,
): Promise<void> {
  try {
    await copyFile(path, backup, fsConstants.COPYFILE_EXCL);
  } catch (error) {
    await unlink(backup).catch(() => undefined);
    throw new ConfigurationBackupError(configurationRoot, path, error);
  }
  // Best effort: some filesystems (for example FAT) keep neither.
  await chmod(backup, Number(metadata.mode) & 0o7777).catch(() => undefined);
  await utimes(backup, metadata.atime, metadata.mtime).catch(() => undefined);
}

/** Setup could not keep a copy of a file before replacing it. */
export class ConfigurationBackupError extends Error {
  readonly code = "setup-backup-failed";

  constructor(configurationRoot: string, path: string, cause: unknown) {
    super(
      `setup-backup-failed: Setup could not keep a copy of ${path} before replacing it (${cause instanceof Error ? cause.message : String(cause)}), so it stopped and put back anything it had already replaced. Make room on the filesystem that holds ${configurationRoot}, or set DOCSFAB_CONFIG_ROOT to a directory on a local disk, then rerun docsfab setup.`,
      { cause },
    );
    this.name = "ConfigurationBackupError";
  }
}

/** Put a preserved entry back at path. */
async function restoreEntry(path: string, preserved: PreservedEntry): Promise<void> {
  if (preserved.kind === "unkept") {
    throw new Error(`No original of ${path} was kept, so setup cannot put it back.`);
  } else if (preserved.kind === "absent") {
    await unlink(path);
  } else if (preserved.kind === "file") {
    await rename(preserved.backup, path);
  } else {
    const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await symlink(preserved.target, temporaryPath);
    await rename(temporaryPath, path).catch(async (error: unknown) => {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    });
  }
}

/** The entry a change left at a path, as an undo compares it. */
interface PlacedEntry {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly ctimeNs: bigint;
  /** SHA-256 of the file bytes, or of the link text for a symbolic link. */
  readonly digest: string;
}

/**
 * Read the entry at path. The inode alone cannot show another writer: one
 * that writes in place keeps it, and a filesystem can give a deleted file's
 * inode number to its replacement. The digest catches changed bytes, and the
 * change time catches a rewrite with the same bytes.
 */
async function readPlacedEntry(path: string): Promise<PlacedEntry> {
  const metadata = await lstat(path, { bigint: true });
  if (!metadata.isFile() && !metadata.isSymbolicLink()) {
    throw new Error(`${path} is not a regular file or a symbolic link.`);
  }
  const bytes = metadata.isSymbolicLink() ? await readlink(path) : await readFile(path);
  return {
    dev: metadata.dev,
    ino: metadata.ino,
    ctimeNs: metadata.ctimeNs,
    digest: createHash("sha256").update(bytes).digest("hex"),
  };
}

/** Refuse to undo over a path unless it still holds exactly what this change placed. */
async function assertStillPlaced(path: string, placed: PlacedEntry | undefined): Promise<void> {
  if (placed === undefined) {
    throw new Error(
      `Setup could not read back ${path} after replacing it, so it leaves that file.`,
    );
  }
  const current = await readPlacedEntry(path).catch(() => undefined);
  if (
    current?.dev !== placed.dev ||
    current.ino !== placed.ino ||
    current.ctimeNs !== placed.ctimeNs ||
    current.digest !== placed.digest
  ) {
    throw new Error(`${path} was changed by another writer, so setup leaves that file as it is.`);
  }
}

/**
 * Describe what an undo could not put back, keeping any original under a
 * name that orphan cleanup never removes.
 */
async function describeUnrestored(
  path: string,
  preserved: PreservedEntry | undefined,
): Promise<string> {
  if (preserved?.kind === "file") {
    const kept = `${path}.setup-incomplete.${randomUUID()}.bak`;
    const moved = await rename(preserved.backup, kept).then(
      () => true,
      () => false,
    );
    return moved
      ? `${path} (original kept at ${kept})`
      : `${path} (no copy of the original remains)`;
  }
  if (preserved?.kind === "absent") return `${path} (it did not exist before)`;
  if (preserved?.kind === "symlink") {
    return `${path} (it was a symbolic link to ${preserved.target})`;
  }
  return path;
}

/**
 * Replace each planned file, then apply the renames. On a failure, undo the
 * completed steps in reverse order and rethrow; a step that cannot be undone
 * turns the failure into setup-commit-incomplete naming the affected paths
 * and where each original is kept. Backups are removed once the change is
 * complete or fully undone.
 */
async function applyPlannedWrites(
  configurationRoot: string,
  writes: readonly PlannedFileWrite[],
  moves: ReadonlyArray<readonly [from: string, to: string]>,
  beforeRename: (temporaryPath: string | undefined) => Promise<void>,
): Promise<void> {
  const undo: Array<{ path: string; preserved?: PreservedEntry; run: () => Promise<void> }> = [];
  const backups: string[] = [];
  // The last step's rename completes the change, so nothing can undo it and
  // it needs no backup.
  const lastStep = writes.length + moves.length - 1;
  let step = 0;
  const preserve = async (path: string): Promise<PreservedEntry> => {
    const preserved = await preserveEntry(configurationRoot, path, step++ !== lastStep);
    if (preserved.kind === "file") backups.push(preserved.backup);
    return preserved;
  };
  // Runs right after each rename. The undo is registered before anything else
  // can fail, so a failed read-back still reports the path. The entry is read
  // after the rename because some filesystems (for example FAT) number an
  // entry by its directory slot.
  const placed = async (
    path: string,
    preserved: PreservedEntry,
    restore: () => Promise<void>,
  ): Promise<void> => {
    let entry: PlacedEntry | undefined;
    undo.push({
      path,
      preserved,
      run: async () => {
        await assertStillPlaced(path, entry);
        await restore();
      },
    });
    entry = await readPlacedEntry(path);
  };
  const profilesDirectory = resolveProfilesDirectory(configurationRoot);
  try {
    for (const write of writes) {
      if (dirname(write.path) === profilesDirectory) {
        const created = await mkdir(profilesDirectory, { recursive: true, mode: 0o700 });
        if (created !== undefined) {
          undo.push({ path: profilesDirectory, run: () => rmdir(profilesDirectory) });
        }
      }
      const preserved = await preserve(write.path);
      await replaceFileAtomically(write.path, write.contents, beforeRename, () =>
        placed(write.path, preserved, () => restoreEntry(write.path, preserved)),
      );
    }
    for (const [from, to] of moves) {
      const preserved = await preserve(to);
      await beforeRename(undefined);
      await rename(from, to);
      await placed(to, preserved, async () => {
        await rename(to, from);
        if (preserved.kind !== "absent") await restoreEntry(to, preserved);
      });
    }
  } catch (error) {
    const unrestored: string[] = [];
    for (const entry of undo.reverse()) {
      const restored = await entry.run().then(
        () => true,
        () => false,
      );
      if (!restored) unrestored.push(await describeUnrestored(entry.path, entry.preserved));
    }
    await removeFiles(backups);
    if (unrestored.length === 0) throw error;
    throw new ConfigurationCommitError(
      `Setup stopped partway through writing the configuration root (${error instanceof Error ? error.message : String(error)}) and could not restore ${unrestored.join("; ")}. Copy each kept original back over its path or delete it, then rerun docsfab setup.`,
      { cause: error },
    );
  }
  await removeFiles(backups);
}

async function removeFiles(paths: readonly string[]): Promise<void> {
  for (const path of paths) await unlink(path).catch(() => undefined);
}

/** A configuration-root change failed partway and could not be fully undone. */
export class ConfigurationCommitError extends Error {
  readonly code = "setup-commit-incomplete";

  constructor(message: string, options: { cause: unknown }) {
    super(`setup-commit-incomplete: ${message}`, options);
    this.name = "ConfigurationCommitError";
  }
}

/**
 * Names replaceFileAtomically, symlink restores, stale-lock recovery, and
 * change backups give their own files. Originals an incomplete change kept
 * (`*.setup-incomplete.*.bak`) never match.
 */
const ORPHANED_ROOT_FILE =
  /^(?:secrets\.env\.lock\.(\d+)\.[0-9a-f-]{36}\.stale|(?:secrets\.env|host\.yaml|\.env\.legacy)\.(\d+)\.[0-9a-f-]{36}\.(?:tmp|bak))$/u;
const ORPHANED_PROFILE_FILE = /^[^/]+\.yaml\.(\d+)\.[0-9a-f-]{36}\.(?:tmp|bak)$/u;

/**
 * Remove temporary copies, set-aside locks, and change backups that a
 * crashed writer left behind. Runs under the lock and removes only this
 * module's own name patterns, only regular files and symbolic links, and only
 * when the process that created the entry is no longer running.
 */
async function removeOrphanedCommitFiles(configurationRoot: string): Promise<void> {
  const profilesDirectory = resolveProfilesDirectory(configurationRoot);
  const profileEntries = await readdir(profilesDirectory).catch(() => [] as string[]);
  const candidates = [
    ...(await readdir(configurationRoot)).map((entry) => {
      const match = ORPHANED_ROOT_FILE.exec(entry);
      return { path: resolve(configurationRoot, entry), pid: match?.[1] ?? match?.[2] };
    }),
    ...profileEntries.map((entry) => ({
      path: resolve(profilesDirectory, entry),
      pid: ORPHANED_PROFILE_FILE.exec(entry)?.[1],
    })),
  ];
  for (const { path, pid } of candidates) {
    if (pid === undefined || processIsRunning(Number(pid))) continue;
    const metadata = await lstat(path).catch(() => undefined);
    if (metadata?.isFile() || metadata?.isSymbolicLink()) {
      await unlink(path).catch(() => undefined);
    }
  }
}

const SECRET_NAME = /^[A-Z][A-Z0-9_]*$/u;

const SECRETS_ENV_HEADER = "# DocsFab host secrets. Keep this file owner-private (0600).";

/** A secrets.env update that could not be written without losing or altering data. */
export class SecretsEnvValueError extends Error {
  readonly code: "secrets-env-value-unrepresentable" | "secrets-env-line-unsupported";

  constructor(
    message: string,
    code: "secrets-env-value-unrepresentable" | "secrets-env-line-unsupported",
  ) {
    super(`${code}: ${message}`);
    this.code = code;
    this.name = "SecretsEnvValueError";
  }
}

/**
 * The keys whose stored value this update changes, with their new values.
 * An empty proposal never blanks a stored non-empty value unless the key is
 * explicitly cleared; a key that is not stored yet is added even when empty.
 */
function secretChanges(
  stored: ReadonlyMap<string, string>,
  proposed: ReadonlyArray<readonly [string, string]>,
  cleared: ReadonlySet<string>,
): Map<string, string> {
  const changes = new Map<string, string>();
  for (const [key, value] of proposed) {
    if (!SECRET_NAME.test(key)) {
      throw new Error(
        `Secret names must be upper-case environment names; refusing to write ${key}.`,
      );
    }
    const previous = stored.get(key);
    const keepStored = !value.trim() && Boolean(previous?.trim()) && !cleared.has(key);
    const next = keepStored ? previous! : value;
    if (previous !== next) changes.set(key, next);
  }
  for (const key of cleared) {
    if (!changes.has(key) && stored.get(key)) changes.set(key, "");
  }
  return changes;
}

/**
 * Apply changes to secrets.env text line by line. Each changed key's
 * assignment lines are replaced (keeping an 'export' prefix), keys not yet in
 * the file are appended, and every other line is kept byte for byte.
 */
function applySecretChanges(
  current: string | undefined,
  changes: ReadonlyMap<string, string>,
): string {
  const serialized = new Map<string, string>();
  for (const [key, value] of changes) {
    const line = serializeDotenvAssignment(key, value);
    if (line === undefined) {
      throw new SecretsEnvValueError(
        `The value for ${key} contains a line break or another character that one secrets.env line cannot hold, so DocsFab did not write it. Supply a single-line value, then rerun the command.`,
        "secrets-env-value-unrepresentable",
      );
    }
    serialized.set(key, line);
  }
  if (current === undefined) {
    return [SECRETS_ENV_HEADER, ...serialized.values(), ""].join("\n");
  }
  const lineEnding = current.includes("\r\n") ? "\r\n" : "\n";
  const replaced = new Set<string>();
  const lines = current.split(/(?<=\r\n|\n|\r(?!\n))/u).map((line, index) => {
    const body = line.replace(/(?:\r\n|\n|\r)$/u, "");
    const parsed = parseDotenvLine(body);
    const replacement = parsed ? serialized.get(parsed.key) : undefined;
    if (!parsed || replacement === undefined) return line;
    if (parsed.unterminated) {
      throw new SecretsEnvValueError(
        `The ${parsed.key} assignment on line ${index + 1} of secrets.env continues onto later lines, so DocsFab cannot replace it without losing data. Put that value on one line, then rerun the command.`,
        "secrets-env-line-unsupported",
      );
    }
    replaced.add(parsed.key);
    const exportPrefix = /^\s*export\s+/u.test(body) ? "export " : "";
    return `${exportPrefix}${replacement}${line.slice(body.length)}`;
  });
  const appended = [...serialized].filter(([key]) => !replaced.has(key)).map(([, line]) => line);
  let text = lines.join("");
  if (appended.length === 0) return text;
  if (text !== "" && !/(?:\r\n|\n|\r)$/u.test(text)) text += lineEnding;
  return text + appended.map((line) => line + lineEnding).join("");
}

async function readOptionalFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === code;
}

/**
 * Replace a configuration file without ever exposing a partial one: write a
 * 0600 temporary file in the same directory, flush it, then rename it over
 * the target. onReplaced runs right after the rename, before the directory
 * is flushed.
 */
async function replaceFileAtomically(
  path: string,
  contents: string,
  onTemporaryWritten?: (temporaryPath: string) => void | Promise<void>,
  onReplaced?: () => Promise<void>,
): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(contents, "utf8");
      await handle.chmod(0o600);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await onTemporaryWritten?.(temporaryPath);
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
  await onReplaced?.();
  await syncDirectory(dirname(path));
}

async function syncDirectory(directory: string): Promise<void> {
  // Persist the rename where the platform supports directory fsync. Platforms
  // that refuse it (for example EISDIR or EINVAL) still completed the rename.
  const handle = await open(directory, "r").catch(() => undefined);
  if (!handle) return;
  try {
    await handle.sync();
  } catch {
    // Directory fsync is unsupported here; the atomic rename already landed.
  } finally {
    await handle.close();
  }
}

interface SecretsEnvLockOwner {
  readonly pid?: unknown;
  readonly host?: unknown;
  readonly token?: unknown;
}

/** A secrets.env write could not use the configuration-root lock. */
export class SecretsEnvLockError extends Error {
  readonly code:
    | "secrets-env-lock-lost"
    | "secrets-env-lock-invalid"
    | "secrets-lock-override-invalid";

  constructor(
    message: string,
    code: "secrets-env-lock-lost" | "secrets-env-lock-invalid" | "secrets-lock-override-invalid",
  ) {
    super(`${code}: ${message}`);
    this.code = code;
    this.name = "SecretsEnvLockError";
  }
}

/** A secrets.env write waited past its declared lock bound and was refused. */
export class SecretsEnvLockTimeoutError extends Error {
  readonly code: string;

  constructor(limit: SharedResolvedLimit, waitedMs: number, lockPath: string) {
    super(
      `${limit.refusal}: ${waitedMs} exceeds ${limit.name} = ${limit.value} ${limit.unit}. ${limit.remediation} Lock file: ${lockPath}. Follow the named remediation.`,
    );
    this.name = "SecretsEnvLockTimeoutError";
    this.code = limit.refusal;
  }
}

/** Resolved bounds for the secrets.env lock. */
export interface SecretsEnvLockLimits {
  readonly wait: SharedResolvedLimit;
  readonly stale: SharedResolvedLimit;
  readonly retry: SharedResolvedLimit;
}

const SECRETS_LOCK_LIMIT_NAMES = {
  wait: "secrets.lockWaitMs",
  stale: "secrets.lockStaleMs",
  retry: "secrets.lockRetryMs",
} as const;

/**
 * Resolve the secrets.env lock bounds from config/limits.yaml plus the same
 * override tiers doctor --limits reports: the environment, the override keys
 * stored in the configuration root, and the host limits file. Overrides may
 * only lower a bound. An invalid override refuses with
 * secrets-lock-override-invalid; setup calls this before touching any file.
 */
export function resolveSecretsEnvLockLimits(
  environment: NodeJS.ProcessEnv,
  configurationRoot: string,
): SecretsEnvLockLimits {
  const definitions = Object.values(SECRETS_LOCK_LIMIT_NAMES).map((name) => {
    const definition = LIMIT_DEFINITION_BY_NAME[name];
    if (!definition) {
      throw new Error(`Unknown operational limit ${name} is not declared in config/limits.yaml.`);
    }
    return definition;
  });
  const root = readConfigurationRootLimitOverrides(environment, configurationRoot);
  let hostValues = new Map<string, string>();
  let resolved: readonly SharedResolvedLimit[];
  try {
    hostValues = readHostLimitOverrides(undefined, root.environment);
    resolved = resolveLimitDefinitions(definitions, {
      environment: root.environment,
      hostValues,
    });
  } catch (error) {
    // An unreadable host limits file is not a lock override; it keeps its own code.
    if (error instanceof HostLimitsFileError) throw error;
    // Name where each lock override came from, never its value.
    const hostFile = resolveHostLimitFile(undefined, root.environment);
    const sources = definitions.flatMap((definition) => {
      const key = definition.override;
      if (!key) return [];
      if (environment[key]?.trim()) return [`${key} from the environment`];
      const origin = root.origins.get(key);
      if (origin) return [`${key} from the ${origin}`];
      if (hostValues.has(key) || hostValues.has(definition.name)) {
        return [`${key} from the host limits file (${hostFile})`];
      }
      return [];
    });
    throw new SecretsEnvLockError(
      [
        error instanceof Error ? error.message : String(error),
        ...(sources.length ? [`Set: ${sources.join("; ")}.`] : []),
        "Correct or unset that override, then rerun the command.",
      ].join(" "),
      "secrets-lock-override-invalid",
    );
  }
  const byName = (name: string) => resolved.find((limit) => limit.name === name)!;
  return {
    wait: byName(SECRETS_LOCK_LIMIT_NAMES.wait),
    stale: byName(SECRETS_LOCK_LIMIT_NAMES.stale),
    retry: byName(SECRETS_LOCK_LIMIT_NAMES.retry),
  };
}

interface SecretsEnvLockLease {
  /** Refuse with secrets-env-lock-lost when another writer now owns the lock. */
  assertHeld(): Promise<void>;
  release(): Promise<void>;
}

async function acquireSecretsEnvLock(
  configurationRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<SecretsEnvLockLease> {
  const lockPath = resolve(configurationRoot, SECRETS_ENV_LOCK_FILE);
  const { wait, stale, retry } = resolveSecretsEnvLockLimits(environment, configurationRoot);
  const token = randomUUID();
  const owner = JSON.stringify({
    pid: process.pid,
    host: hostname(),
    token,
    acquiredAt: new Date().toISOString(),
  });
  const started = Date.now();
  for (;;) {
    if (await tryCreateSecretsEnvLock(lockPath, owner)) {
      return {
        async assertHeld() {
          const current = await readOptionalFile(lockPath);
          if (current === undefined || parseSecretsEnvLockOwner(current)?.token !== token) {
            throw new SecretsEnvLockError(
              `Another writer took ${lockPath} before this change finished, so setup stopped and put back the files it had already replaced. Rerun docsfab setup.`,
              "secrets-env-lock-lost",
            );
          }
        },
        release: () => releaseSecretsEnvLock(lockPath, token),
      };
    }
    const waited = Date.now() - started;
    if (waited >= wait.value) throw new SecretsEnvLockTimeoutError(wait, waited, lockPath);
    if (await recoverStaleSecretsEnvLock(lockPath, stale.value)) continue;
    await delay(Math.min(retry.value, wait.value - waited));
  }
}

async function tryCreateSecretsEnvLock(lockPath: string, owner: string): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if (hasErrorCode(error, "EEXIST")) return false;
    throw error;
  }
  try {
    await handle.writeFile(owner, "utf8");
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(lockPath).catch(() => undefined);
    throw error;
  }
  await handle.close();
  return true;
}

function parseSecretsEnvLockOwner(source: string): SecretsEnvLockOwner | undefined {
  try {
    const parsed: unknown = JSON.parse(source);
    return parsed && typeof parsed === "object" ? (parsed as SecretsEnvLockOwner) : undefined;
  } catch {
    // An owner that has created the lock but not yet written its identity.
    return undefined;
  }
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return hasErrorCode(error, "EPERM");
  }
}

/**
 * A lock whose owner runs on this host is stale only when that process is
 * gone, however long it has been held. The age bound applies only when the
 * owner cannot be checked: another host, or an owner record that is missing
 * or unreadable.
 */
function secretsEnvLockIsStale(
  owner: SecretsEnvLockOwner | undefined,
  ageMs: number,
  staleMs: number,
): boolean {
  if (owner?.host === hostname() && typeof owner.pid === "number") {
    return !processIsRunning(owner.pid);
  }
  return ageMs >= staleMs;
}

/**
 * Remove an abandoned lock. The lock is moved aside first and removed only when
 * it is still the lock that was judged stale; a lock another writer acquired in
 * the meantime is linked back without replacing any newer lock.
 */
async function recoverStaleSecretsEnvLock(lockPath: string, staleMs: number): Promise<boolean> {
  let observed: string;
  let modifiedAtMs: number;
  try {
    const metadata = await lstat(lockPath);
    if (!metadata.isFile()) {
      throw new SecretsEnvLockError(
        `The lock path ${lockPath} is not a regular file, so no writer can take the secrets.env lock. Remove it, then rerun docsfab setup.`,
        "secrets-env-lock-invalid",
      );
    }
    modifiedAtMs = metadata.mtimeMs;
    observed = await readFile(lockPath, "utf8");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return true;
    throw error;
  }
  const owner = parseSecretsEnvLockOwner(observed);
  if (!secretsEnvLockIsStale(owner, Date.now() - modifiedAtMs, staleMs)) return false;
  const aside = `${lockPath}.${process.pid}.${randomUUID()}.stale`;
  try {
    await rename(lockPath, aside);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return true;
    throw error;
  }
  const moved = await readOptionalFile(aside);
  const recovered = moved === observed;
  if (!recovered) await link(aside, lockPath).catch(() => undefined);
  await unlink(aside).catch(() => undefined);
  return recovered;
}

async function releaseSecretsEnvLock(lockPath: string, token: string): Promise<void> {
  const current = await readOptionalFile(lockPath);
  if (current !== undefined && parseSecretsEnvLockOwner(current)?.token === token) {
    await unlink(lockPath).catch((error: unknown) => {
      if (!hasErrorCode(error, "ENOENT")) throw error;
    });
  }
}

/** Load dotenv assignments into the requested environment without replacing ambient values. */
export function loadEnvFileIntoEnvironment(
  path: string,
  target: NodeJS.ProcessEnv = process.env,
): void {
  const assignments = parseDotenvAssignments(readFileSync(path, "utf8"));
  for (const [key, value] of assignments) {
    if (target[key] === undefined) target[key] = value;
  }
  // The exact-match screens read credentials loaded here at their next check (#1807).
  refreshConfiguredCredentials();
}

function extractModelAssignments(
  assignments: Map<string, string>,
  prefix: "MODEL" | "JUDGE",
): Array<[string, string]> {
  const pattern = new RegExp(`^${prefix}_`, "u");
  return [...assignments.entries()]
    .filter(([key]) => pattern.test(key) && !key.endsWith("_API_KEY"))
    .sort(([left], [right]) => left.localeCompare(right));
}

/**
 * Convert a monolithic .env into host.yaml, profiles, and secrets.env, then
 * keep the .env as .env.legacy. The whole conversion is one
 * configuration-root change, so a refusal leaves the .env root unchanged.
 */
export async function migrateMonolithicEnvToSplitLayout(
  configurationRoot: string,
  options: Pick<SecretsEnvWriteOptions, "environment"> = {},
): Promise<{
  hostPath: string;
  secretsPath: string;
  policyProfilePath: string;
  policyRelative: string;
  legacyBackupPath: string;
}> {
  const envPath = resolve(configurationRoot, ".env");
  if (!existsSync(envPath)) {
    throw new Error(
      `No monolithic .env file exists at ${envPath}, so there is nothing to migrate.`,
    );
  }
  if (usesSplitLayout(configurationRoot)) {
    throw new Error("Split layout already exists; migration is not required.");
  }
  const source = await readFile(envPath, "utf8");
  const assignments = parseDotenvAssignments(source);
  const policyAssignments = extractModelAssignments(assignments, "MODEL");
  if (policyAssignments.length === 0) {
    throw new Error("Monolithic .env does not contain a MODEL profile to migrate.");
  }
  const policyProfile = modelProfileFromAssignments("policy", policyAssignments);
  const policyRelative = profileRelativePathFromModelId(policyProfile.modelId);
  const host = defaultHostConfig(policyRelative);

  const profiles: Array<readonly [string, DocsFabModelProfileV1]> = [];
  const judgeAssignments = extractModelAssignments(assignments, "JUDGE");
  if (judgeAssignments.length > 0) {
    const judgeProfile = modelProfileFromAssignments("judge", judgeAssignments);
    const judgeRelative = `${PROFILES_DIRECTORY}/evaluation-judge.yaml`;
    host.activeJudgeProfile = judgeRelative;
    profiles.push([judgeRelative, judgeProfile]);
  }
  profiles.push([policyRelative, policyProfile]);

  const secrets = SECRET_ENV_KEYS.map((key) => [key, assignments.get(key) ?? ""] as const);
  const legacyBackupPath = resolve(configurationRoot, LEGACY_ENV_BACKUP);
  await commitConfigurationRootChange(
    configurationRoot,
    { profiles, host, secrets: { merge: () => secrets }, moves: [[envPath, legacyBackupPath]] },
    options,
  );

  return {
    hostPath: resolveHostConfigPath(configurationRoot),
    secretsPath: resolveSecretsEnvPath(configurationRoot),
    policyProfilePath: resolveProfilePath(configurationRoot, policyRelative),
    policyRelative,
    legacyBackupPath,
  };
}
