// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  describeDocsFabConfigurationSource,
  loadDocsFabEnvironment,
  type ModelSettingsLoadOptions,
} from "./host-paths.js";
import { parseDotenvAssignments } from "./dotenv.js";
import {
  isConfiguredCredentialFileName,
  isConfiguredCredentialName,
  registerConfiguredCredentialFileForEnvironment,
  registerConfiguredCredentialForEnvironment,
  resolveConfiguredCredentialMatchingDefaults,
  activateConfiguredCredentialMatchingDefaults,
  currentConfiguredCredentialMatchingPolicy,
  refreshConfiguredCredentials,
} from "../security/configured-credentials.js";

const MATCHING_OVERRIDE_NAMES = [
  "DOCSFAB_SECRETS_CONFIGURED_CREDENTIAL_MIN_CHARS",
  "DOCSFAB_SECRETS_CONFIGURED_CREDENTIAL_FRAGMENT_CHARS",
  "DOCSFAB_SECRETS_CONFIGURED_CREDENTIAL_MIN_DISTINCT_CHARS",
] as const;

const PROXY_VARIABLES = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
] as const;

/**
 * Load configuration and credentials into a private environment. An isolated
 * injected environment keeps its supplied entries and reads only an explicit
 * configuration root; it cannot inherit the host's exports or default files.
 * `writingPreset` and `cli` are this run's `--composition` and `--set` values,
 * resolved into the private environment like every other setting.
 */
export function loadPrivateDocsFabEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  options: { readonly isolated?: boolean } & ModelSettingsLoadOptions = {},
): NodeJS.ProcessEnv {
  const isHostEnvironment = environment === process.env;
  const effective: NodeJS.ProcessEnv = options.isolated
    ? { ...environment }
    : { ...process.env, ...environment };
  const ambientOverrides = new Map(
    MATCHING_OVERRIDE_NAMES.map((name) => [name, process.env[name]] as const),
  );
  // Capture file/catalog defaults without snapshotting current process exports;
  // those exports are restored as live, higher-precedence overrides below.
  if (isHostEnvironment) {
    for (const name of MATCHING_OVERRIDE_NAMES) delete effective[name];
  }
  const beforeLoad = { ...effective };
  const privateNames =
    options.isolated && effective.DOCSFAB_CONFIG_ROOT === undefined
      ? new Set<string>()
      : privateConfigurationNames(effective);
  if (!options.isolated || effective.DOCSFAB_CONFIG_ROOT !== undefined) {
    loadDocsFabEnvironment(effective, {
      ...(options.writingPreset !== undefined ? { writingPreset: options.writingPreset } : {}),
      ...(options.cli !== undefined ? { cli: options.cli } : {}),
    });
  }
  if (isHostEnvironment) {
    const defaults = resolveConfiguredCredentialMatchingDefaults(effective);
    for (const [name, value] of ambientOverrides) {
      if (value !== undefined) effective[name] = value;
    }
    // Exports outrank file defaults. Validate that complete effective policy
    // before activating shared state or registering any private credential.
    resolveConfiguredCredentialMatchingDefaults(effective);
    activateConfiguredCredentialMatchingDefaults(process.env, defaults);
  } else {
    const requested = resolveConfiguredCredentialMatchingDefaults(effective);
    const active = currentConfiguredCredentialMatchingPolicy();
    if (
      requested.minChars !== active.minChars ||
      requested.fragmentChars !== active.fragmentChars ||
      requested.minDistinctChars !== active.minDistinctChars
    ) {
      throw new Error(
        "Injected DocsFab configuration resolves different credential comparison limits; activate the host comparator policy before loading this environment.",
      );
    }
  }
  registerEffectiveCredentials(effective, beforeLoad, privateNames);
  refreshConfiguredCredentials();
  return effective;
}

function privateConfigurationNames(environment: NodeJS.ProcessEnv): ReadonlySet<string> {
  const { secretsFile } = describeDocsFabConfigurationSource(environment);
  if (secretsFile === null) return new Set();
  try {
    return new Set(parseDotenvAssignments(readFileSync(secretsFile, "utf8")).keys());
  } catch {
    return new Set();
  }
}

function registerEffectiveCredentials(
  environment: NodeJS.ProcessEnv,
  beforeLoad: NodeJS.ProcessEnv,
  privateNames: ReadonlySet<string>,
): void {
  for (const [name, value] of Object.entries(environment)) {
    if (!value?.trim()) continue;
    // The process registry already refreshes ambient exports. Permanently add
    // only a value introduced by a private caller/config load, never a clone
    // of the ambient process environment.
    const privateValue =
      value !== process.env[name] || value !== beforeLoad[name] || privateNames.has(name);
    if (!privateValue) continue;
    if (isConfiguredCredentialName(name)) {
      registerConfiguredCredentialForEnvironment(
        value,
        `environment variable ${name}`,
        environment,
      );
    } else if (isConfiguredCredentialFileName(name)) {
      registerConfiguredCredentialFileForEnvironment(
        value,
        `credential file named by ${name}`,
        environment,
      );
    }
  }

  const credentialsDirectory =
    environment.CREDENTIALS_DIRECTORY !== process.env.CREDENTIALS_DIRECTORY ||
    environment.CREDENTIALS_DIRECTORY !== beforeLoad.CREDENTIALS_DIRECTORY ||
    privateNames.has("CREDENTIALS_DIRECTORY")
      ? environment.CREDENTIALS_DIRECTORY?.trim()
      : undefined;
  if (credentialsDirectory) {
    try {
      for (const entry of readdirSync(credentialsDirectory, { withFileTypes: true })) {
        if (!entry.isFile() && !entry.isSymbolicLink()) continue;
        registerConfiguredCredentialFileForEnvironment(
          join(credentialsDirectory, entry.name),
          `systemd credential ${entry.name}`,
          environment,
        );
      }
    } catch {
      // Refresh records unreadable ambient sources; do not echo a private path here.
    }
  }

  for (const name of PROXY_VARIABLES) {
    const value = environment[name]?.trim();
    if (
      !value ||
      (value === process.env[name] && value === beforeLoad[name] && !privateNames.has(name))
    )
      continue;
    let proxy: URL;
    try {
      proxy = new URL(value);
    } catch {
      continue;
    }
    if (proxy.username) {
      registerConfiguredCredentialForEnvironment(
        decodeProxyPart(proxy.username),
        `the proxy user name in environment variable ${name}`,
        environment,
      );
    }
    if (proxy.password) {
      registerConfiguredCredentialForEnvironment(
        decodeProxyPart(proxy.password),
        `the proxy password in environment variable ${name}`,
        environment,
      );
    }
  }
}

function decodeProxyPart(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
