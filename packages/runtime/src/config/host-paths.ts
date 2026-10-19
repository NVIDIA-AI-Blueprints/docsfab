// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

import { currentCliModelSettings } from "./cli-model-settings.js";
import { parseDotenvAssignments } from "./dotenv.js";
import { isExecutablePreset, presetSlotAssignments } from "./execution-profile.js";
import { applyModelSlotSettings, type ModelSettingSlot } from "./model-settings.js";
import { decodeHostConfig } from "./profile-projection.js";
import {
  loadEnvFileIntoEnvironment,
  loadSplitLayoutIntoEnvironment,
  readModelSettingsFileLayer,
  resolveSecretsEnvPath,
  type ModelSettingsLoadOptions,
} from "./split-layout.js";

export type { ModelSettingsLoadOptions } from "./split-layout.js";

const moduleProjectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PRIVATE_CONFIGURATION_ROOT_MODE = 0o700;

/** Immutable root for DocsFab's installed skills and governed runtime assets. */
export function resolveDocsFabProjectRoot(): string {
  return moduleProjectRoot;
}

function configuredXdgConfigHome(environment: NodeJS.ProcessEnv): string | undefined {
  const configured = environment.XDG_CONFIG_HOME?.trim();
  return configured && isAbsolute(configured) && resolve(configured) === configured
    ? configured
    : undefined;
}

function defaultUserConfigurationRoot(environment: NodeJS.ProcessEnv): string {
  return resolve(configuredXdgConfigHome(environment) ?? resolve(homedir(), ".config"), "docsfab");
}

/**
 * The default root as the operator types it, with the shell word for a command.
 * Operator output replaces the absolute root with `$DOCSFAB_CONFIG_ROOT`, which
 * names nothing while that variable is unset, so a refusal uses this form.
 */
function defaultConfigurationRootDisplay(environment: NodeJS.ProcessEnv): {
  readonly text: string;
  readonly shellWord: string;
} {
  return configuredXdgConfigHome(environment) === undefined
    ? { text: "~/.config/docsfab", shellWord: "~/.config/docsfab" }
    : { text: "$XDG_CONFIG_HOME/docsfab", shellWord: '"$XDG_CONFIG_HOME/docsfab"' };
}

/** The default configuration root is not an owner-private directory; names the chmod that fixes it. */
export class ConfigurationRootPermissionError extends Error {
  readonly code = "configuration-root-not-private";
  readonly nextAction: string;

  constructor(root: string, mode: number | undefined, environment: NodeJS.ProcessEnv) {
    const isDefault = environment.DOCSFAB_CONFIG_ROOT === undefined;
    const display = isDefault
      ? defaultConfigurationRootDisplay(environment)
      : { text: `selected by DOCSFAB_CONFIG_ROOT (${root})`, shellWord: '"$DOCSFAB_CONFIG_ROOT"' };
    const condition = isDefault
      ? mode === undefined
        ? `The DocsFab configuration root ${display.text} could not be verified as an owner-private directory.`
        : `The DocsFab configuration root ${display.text} must be owner-private with mode 0700 before DocsFab stores configuration in it.`
      : mode === undefined
        ? `The DocsFab configuration root ${display.text} could not be verified as owner-private with mode 0700.`
        : `The DocsFab configuration root ${display.text} has mode ${formatDirectoryMode(mode)}; it must be owner-private with mode 0700 before DocsFab reads or stores configuration in it.`;
    super(
      isDefault
        ? `${condition} DOCSFAB_CONFIG_ROOT is not set, so this is the default location.`
        : condition,
    );
    this.name = "ConfigurationRootPermissionError";
    this.nextAction = `Run \`chmod 700 ${display.shellWord}\`, then run the command again.`;
  }
}

function formatDirectoryMode(mode: number): string {
  return (mode & 0o777).toString(8).padStart(4, "0");
}

export function assertDocsFabConfigurationRootPrivate(
  root: string,
  environment: NodeJS.ProcessEnv = process.env,
): void {
  let mode: number;
  try {
    mode = statSync(root).mode & 0o777;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw new ConfigurationRootPermissionError(root, undefined, environment);
  }
  if (mode !== PRIVATE_CONFIGURATION_ROOT_MODE) {
    throw new ConfigurationRootPermissionError(root, mode, environment);
  }
}

function validateConfiguredRoot(configured: string): string {
  if (
    !configured ||
    configured.includes("\0") ||
    !isAbsolute(configured) ||
    resolve(configured) !== configured
  ) {
    throw new Error("DOCSFAB_CONFIG_ROOT must be one normalized absolute directory path.");
  }
  return configured;
}

/** Resolve the writable host configuration root without creating directories. */
export function resolveDocsFabConfigurationRoot(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const configured = environment.DOCSFAB_CONFIG_ROOT;
  const root =
    configured !== undefined
      ? validateConfiguredRoot(configured)
      : defaultUserConfigurationRoot(environment);
  assertDocsFabConfigurationRootPrivate(root, environment);
  return root;
}

/** Ensure the selected configuration root exists as an owner-private directory. */
export async function ensureDocsFabConfigurationRoot(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const root = resolveDocsFabConfigurationRoot(environment);
  await mkdir(root, { recursive: true, mode: 0o700 });
  assertDocsFabConfigurationRootPrivate(root, environment);
  return root;
}

/**
 * Run-record store used by `docsfab run` and `docsfab publish`.
 *
 * A relative `DOCSFAB_STATE_DIR` is anchored to the configuration root, as
 * `host.yaml` `paths.stateDir` is, not the working directory, so `runs show`
 * reads the same store the writer used. For the same reason a value from the
 * configuration's env file applies, in the precedence `loadDocsFabEnvironment`
 * gives it, even when the caller has not loaded that file.
 */
export function resolveDocsFabStateDirectory(environment: NodeJS.ProcessEnv = process.env): string {
  const configurationRoot = resolveDocsFabConfigurationRoot(environment);
  const explicit = environment.DOCSFAB_STATE_DIR;
  if (explicit !== undefined) return anchorStateDirectory(configurationRoot, explicit);
  const hostStateDirectory = readHostStateDirectory(configurationRoot);
  if (hostStateDirectory !== undefined) return resolve(hostStateDirectory);
  const fileStateDirectory = readEnvFileStateDirectory(environment);
  if (fileStateDirectory !== undefined) {
    return anchorStateDirectory(configurationRoot, fileStateDirectory);
  }
  return resolve(configurationRoot, ".docsfab", "runs");
}

function anchorStateDirectory(configurationRoot: string, configured: string): string {
  if (!configured || configured.includes("\0")) {
    throw new Error("DOCSFAB_STATE_DIR must be one directory path without NUL bytes.");
  }
  return isAbsolute(configured) ? resolve(configured) : resolve(configurationRoot, configured);
}

/** `DOCSFAB_STATE_DIR` from the env file `loadDocsFabEnvironment` would load. */
function readEnvFileStateDirectory(environment: NodeJS.ProcessEnv): string | undefined {
  const { secretsFile } = describeDocsFabConfigurationSource(environment);
  if (secretsFile === null || !existsSync(secretsFile)) return undefined;
  return parseDotenvAssignments(readFileSync(secretsFile, "utf8")).get("DOCSFAB_STATE_DIR");
}

export interface DocsFabPublicationRoots {
  readonly stateDirectory: string;
  readonly deliveryRoot: string;
  readonly receiptRoot: string;
}

/**
 * Resolve host-owned private roots for draft-MR publication without creating
 * them. An explicit host override wins; omitted delivery and receipt roots are
 * siblings of the effective run-record directory.
 */
export function resolveDocsFabPublicationRoots(
  environment: NodeJS.ProcessEnv = process.env,
  stateDirectory?: string,
): DocsFabPublicationRoots {
  const effectiveStateDirectory = resolve(
    stateDirectory ?? resolveDocsFabStateDirectory(environment),
  );
  const root = dirname(effectiveStateDirectory);
  return {
    stateDirectory: effectiveStateDirectory,
    deliveryRoot: resolvePrivateRootOverride(
      environment.DOCSFAB_DELIVERY_ROOT,
      resolve(root, "delivery"),
      "DOCSFAB_DELIVERY_ROOT",
    ),
    receiptRoot: resolvePrivateRootOverride(
      environment.DOCSFAB_RECEIPT_ROOT,
      resolve(root, "receipts"),
      "DOCSFAB_RECEIPT_ROOT",
    ),
  };
}

function resolvePrivateRootOverride(
  configured: string | undefined,
  fallback: string,
  name: string,
): string {
  if (configured === undefined) return fallback;
  if (!configured || configured.includes("\0") || !isAbsolute(configured)) {
    throw new Error(`${name} must be one normalized absolute directory path.`);
  }
  if (resolve(configured) !== configured) {
    throw new Error(`${name} must be one normalized absolute directory path.`);
  }
  return configured;
}

function readHostStateDirectory(configurationRoot: string): string | undefined {
  const hostConfigPath = resolve(configurationRoot, "host.yaml");
  if (!existsSync(hostConfigPath)) return undefined;
  const host = decodeHostConfig(parseYaml(readFileSync(hostConfigPath, "utf8")));
  const configured = host.paths?.stateDir;
  if (configured === undefined) return undefined;
  return isAbsolute(configured) ? configured : resolve(configurationRoot, configured);
}

/** Owner-private persistent Pi sessions for `docsfab live-agent`. */
export function resolveDocsFabLiveAgentSessionDirectory(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return resolve(
    resolveDocsFabConfigurationRoot(environment),
    ".docsfab",
    "live-agent",
    "sessions",
  );
}

/** Which configuration files are in effect for one environment. */
export interface DocsFabConfigurationSource {
  readonly configurationRoot: string;
  /**
   * `split`: host.yaml plus secrets.env; `legacy`: one .env in the
   * configuration root; `checkout-legacy`: the installed package .env used
   * because DOCSFAB_CONFIG_ROOT is unset and the root has neither; `none`.
   */
  readonly layout: "split" | "legacy" | "checkout-legacy" | "none";
  /** File whose stored credentials apply, or null when no file supplies them. */
  readonly secretsFile: string | null;
}

/** Resolve the effective configuration files without reading any credential. */
export function describeDocsFabConfigurationSource(
  environment: NodeJS.ProcessEnv = process.env,
): DocsFabConfigurationSource {
  const configurationRoot = resolveDocsFabConfigurationRoot(environment);
  if (existsSync(resolve(configurationRoot, "host.yaml"))) {
    return {
      configurationRoot,
      layout: "split",
      secretsFile: resolveSecretsEnvPath(configurationRoot),
    };
  }
  const dotenvPath = resolve(configurationRoot, ".env");
  if (existsSync(dotenvPath)) {
    return { configurationRoot, layout: "legacy", secretsFile: dotenvPath };
  }
  const checkoutLegacyEnv = resolve(moduleProjectRoot, ".env");
  if (
    environment.DOCSFAB_CONFIG_ROOT === undefined &&
    existsSync(checkoutLegacyEnv) &&
    configurationRoot !== moduleProjectRoot
  ) {
    return { configurationRoot, layout: "checkout-legacy", secretsFile: checkoutLegacyEnv };
  }
  return { configurationRoot, layout: "none", secretsFile: null };
}

/** One operator line naming the configuration root and the secrets file in effect. */
export function formatDocsFabConfigurationSource(source: DocsFabConfigurationSource): string {
  const secrets =
    source.secretsFile === null
      ? "none configured"
      : source.layout === "checkout-legacy"
        ? `${source.secretsFile} (installed-package fallback)`
        : source.secretsFile;
  return `Configuration: ${source.configurationRoot} (secrets: ${secrets}; environment variables take precedence)`;
}

/**
 * Load the selected host configuration without exposing its credential values.
 * Model settings follow the precedence in `model-settings.ts` in every layout:
 * a legacy `.env` sits just below the process environment, and `--composition`
 * selects the writing preset for this run.
 */
export function loadDocsFabEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  options: ModelSettingsLoadOptions = {},
): void {
  const source = describeDocsFabConfigurationSource(environment);
  if (source.layout === "split") {
    const explicitStateDirectory = environment.DOCSFAB_STATE_DIR;
    loadSplitLayoutIntoEnvironment(source.configurationRoot, environment, options);
    if (explicitStateDirectory !== undefined) {
      environment.DOCSFAB_STATE_DIR = explicitStateDirectory;
    }
    return;
  }
  const cli = options.cli ?? currentCliModelSettings();
  const layer = readModelSettingsFileLayer(source.secretsFile, "legacy-env-file");
  const files = layer ? [layer] : [];
  const preset =
    options.writingPreset !== undefined && isExecutablePreset(options.writingPreset)
      ? options.writingPreset
      : undefined;
  const slots: ModelSettingSlot[] = ["writing"];
  if (
    Object.keys(cli?.judge ?? {}).length > 0 ||
    environment.JUDGE_ENABLED?.trim().toLowerCase() === "true" ||
    layer?.assignments.get("JUDGE_ENABLED")?.value.trim().toLowerCase() === "true"
  ) {
    slots.push("judge");
  }
  for (const slot of slots) {
    applyModelSlotSettings({
      target: environment,
      slot,
      root: source.configurationRoot,
      files,
      ...(slot === "writing" && preset
        ? {
            base: {
              kind: "preset" as const,
              id: preset,
              source: "cli-flag" as const,
              assignments: presetSlotAssignments(preset, "policy"),
            },
          }
        : {}),
      ...(cli ? { cli: slot === "writing" ? cli.writing : cli.judge } : {}),
    });
  }
  if (source.secretsFile !== null) loadEnvFileIntoEnvironment(source.secretsFile, environment);
}
