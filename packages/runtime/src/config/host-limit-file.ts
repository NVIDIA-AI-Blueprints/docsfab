// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseDotenvAssignmentLines } from "./dotenv.js";
import {
  HostLimitsFileError,
  noteHostLimitFileRefused,
  readHostLimitFile,
  resolveHostLimitFilePath,
  type SkippedHostLimitFile,
} from "./limit-resolution.js";
import { LIMIT_DEFINITIONS } from "./limits.generated.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const LIMIT_OVERRIDE_KEYS: ReadonlySet<string> = new Set(
  LIMIT_DEFINITIONS.flatMap((definition) => (definition.override ? [definition.override] : [])),
);

export interface ConfigurationRootLimitOverrides {
  /** A clone of the environment plus the override keys the root stores. */
  readonly environment: NodeJS.ProcessEnv;
  /** For each key taken from the root: its file kind, path, and line. Never a value. */
  readonly origins: ReadonlyMap<string, string>;
}

/**
 * Read the limit-override keys stored in the configuration root: secrets.env
 * for the split layout, the root .env for the legacy layout, or the installed
 * package .env when DOCSFAB_CONFIG_ROOT is unset and the root holds neither.
 *
 * These are ordinary dotenv files, so they use the runtime dotenv grammar, not
 * the strict host-limits-file grammar. Every line that is not a declared
 * limit-override key, credentials included, is ignored, and values already set
 * in the environment win. doctor --limits and the secrets.env lock both read
 * this tier.
 */
export function readConfigurationRootLimitOverrides(
  environment: NodeJS.ProcessEnv,
  configurationRoot: string,
): ConfigurationRootLimitOverrides {
  const effective = { ...environment };
  const origins = new Map<string, string>();
  const source = configurationRootLimitSource(environment, configurationRoot);
  if (!source || !existsSync(source.path)) return { environment: effective, origins };
  const assignments = parseDotenvAssignmentLines(readFileSync(source.path, "utf8"));
  for (const [key, assignment] of assignments) {
    if (!LIMIT_OVERRIDE_KEYS.has(key) || effective[key] !== undefined) continue;
    effective[key] = assignment.value;
    origins.set(key, `${source.kind} (${source.path}, line ${assignment.line})`);
  }
  return { environment: effective, origins };
}

function configurationRootLimitSource(
  environment: NodeJS.ProcessEnv,
  configurationRoot: string,
): { readonly path: string; readonly kind: string } | undefined {
  if (existsSync(resolve(configurationRoot, "host.yaml"))) {
    return {
      path: resolve(configurationRoot, "secrets.env"),
      kind: "configuration root secrets.env",
    };
  }
  if (existsSync(resolve(configurationRoot, ".env"))) {
    return { path: resolve(configurationRoot, ".env"), kind: "configuration root .env" };
  }
  if (environment.DOCSFAB_CONFIG_ROOT === undefined) {
    return { path: resolve(packageRoot, ".env"), kind: "installed package .env" };
  }
  return undefined;
}

/**
 * Read the host limit-override file inertly. An explicit path wins, then
 * DOCSFAB_SERVICE_ENV_FILE, then the installed service file; test runners read
 * no default file. When this process may not read the installed file, the
 * reader skips it and reports it once on stderr; any other read failure, and
 * a named file that cannot be read, refuses with `host-limits-file-unreadable`.
 * Kept free of other configuration imports so any module that resolves a
 * limit can use it without an import cycle.
 */
export function readHostLimitOverrides(
  hostFile: string | null | undefined,
  environment: NodeJS.ProcessEnv,
): Map<string, string> {
  try {
    return readHostLimitFile(hostFile, environment).values;
  } catch (error) {
    // The caller refuses with this error, so no notice needs to repeat it.
    if (error instanceof HostLimitsFileError) noteHostLimitFileRefused(error.path);
    throw error;
  }
}

/** The installed host limits file this resolution skips because it cannot read it, if any. */
export function skippedHostLimitFile(
  hostFile: string | null | undefined,
  environment: NodeJS.ProcessEnv,
): SkippedHostLimitFile | undefined {
  return readHostLimitFile(hostFile, environment).skipped;
}

/** The doctor line for a skipped host limits file: the file, the code, the reason, and the remedy. */
export function describeSkippedHostLimitFile(skipped: SkippedHostLimitFile): string {
  return `Host limits file: skipped ${skipped.path} (${skipped.code}, ${skipped.reason}). The limit overrides it sets do not apply. ${skipped.remediation}`;
}

export function resolveHostLimitFile(
  hostFile: string | null | undefined,
  environment: NodeJS.ProcessEnv,
): string | undefined {
  return resolveHostLimitFilePath(hostFile, environment);
}
