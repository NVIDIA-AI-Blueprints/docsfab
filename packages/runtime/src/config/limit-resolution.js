// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Operational-limit resolution shared by the runtime loader and the
 * privileged install-time service-config validator. It imports only Node
 * built-ins, so either can load it alone.
 */

import { readFileSync } from "node:fs";

/** The installed host limits file, read when no other file is named. */
export const HOST_LIMITS_FILE = "/etc/docsfab/service.env";

/** The code of a host limits file that DocsFab cannot read. */
export const HOST_LIMITS_FILE_UNREADABLE = "host-limits-file-unreadable";

/**
 * What to do about a host limits file DocsFab cannot read. It never suggests
 * widening access to the service's own files.
 */
export const HOST_LIMITS_FILE_REMEDIATION =
  "Set DOCSFAB_SERVICE_ENV_FILE to a limits file you can read; the service's own limit overrides then do not apply to your runs.";

/**
 * @typedef {{ readonly path: string, readonly origin: "argument" | "variable" | "default" }} HostLimitFileSource
 * @typedef {{ readonly code: "host-limits-file-unreadable", readonly path: string, readonly reason: string, readonly remediation: string }} SkippedHostLimitFile
 */

/**
 * The host limits file a resolution reads and what named it: an explicit path
 * wins (`argument`), then DOCSFAB_SERVICE_ENV_FILE (`variable`), then the
 * installed service file (`default`). `null`, or a test runner with nothing
 * named, reads none. Pure, so a leaf module that cannot load the runtime
 * loader finds the same file `limit()` reads.
 *
 * @param {string | null | undefined} hostFile
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} environment
 * @returns {HostLimitFileSource | undefined}
 */
export function resolveHostLimitFileSource(hostFile, environment) {
  if (hostFile === null) return undefined;
  if (hostFile) return Object.freeze({ path: hostFile, origin: "argument" });
  const configured = environment.DOCSFAB_SERVICE_ENV_FILE?.trim();
  if (configured) return Object.freeze({ path: configured, origin: "variable" });
  if (environment.VITEST === "true" || environment.NODE_TEST_CONTEXT) return undefined;
  return Object.freeze({ path: HOST_LIMITS_FILE, origin: "default" });
}

/**
 * The path {@link resolveHostLimitFileSource} resolves.
 *
 * @param {string | null | undefined} hostFile
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} environment
 * @returns {string | undefined}
 */
export function resolveHostLimitFilePath(hostFile, environment) {
  return resolveHostLimitFileSource(hostFile, environment)?.path;
}

/**
 * A host limits file that DocsFab cannot read and does not skip. The message
 * names the file, the reason, and the remedy.
 */
export class HostLimitsFileError extends Error {
  /**
   * @param {HostLimitFileSource} source
   * @param {string} reason
   */
  constructor(source, reason) {
    const named = source.origin === "variable" ? " that DOCSFAB_SERVICE_ENV_FILE names" : "";
    super(
      `DocsFab cannot read the host limits file ${source.path}${named} (${reason}). ${HOST_LIMITS_FILE_REMEDIATION}`,
    );
    this.name = "HostLimitsFileError";
    this.code = HOST_LIMITS_FILE_UNREADABLE;
    this.path = source.path;
    this.origin = source.origin;
    this.reason = reason;
  }
}

/** Host limits files this process has already named, on stderr or in a refusal. */
const reportedHostLimitFiles = new Set();

/**
 * Say once per process, on stderr, that DocsFab cannot use a host limits
 * file. Every reader reports through here, as other `WARNING <code>:` signals
 * are reported, so no process skips a file without saying so and `--json`
 * stdout stays one record. A file that a refusal already names is not repeated.
 *
 * @param {string} path
 * @param {string} sentence
 */
export function reportHostLimitFile(path, sentence) {
  if (reportedHostLimitFiles.has(path)) return;
  reportedHostLimitFiles.add(path);
  process.stderr.write(`WARNING ${HOST_LIMITS_FILE_UNREADABLE}: ${sentence}\n`);
}

/**
 * Record that a refusal names this host limits file, so a reader that cannot
 * refuse, such as the configured-credential screens, does not repeat it.
 *
 * @param {string} path
 */
export function noteHostLimitFileRefused(path) {
  reportedHostLimitFiles.add(path);
}

/**
 * Read and parse the host limits file a resolution names. See
 * {@link readHostLimitFileAt}.
 *
 * @param {string | null | undefined} hostFile
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} environment
 */
export function readHostLimitFile(hostFile, environment) {
  return readHostLimitFileAt(resolveHostLimitFileSource(hostFile, environment));
}

/**
 * Read and parse one host limits file inertly. A missing file sets nothing.
 * The installed default file that this process may not read is skipped,
 * reported once on stderr, and named in `skipped`. Any other read failure,
 * and a file that a caller or DOCSFAB_SERVICE_ENV_FILE names, refuses with
 * {@link HostLimitsFileError}.
 *
 * @param {HostLimitFileSource | undefined} source
 * @returns {{ readonly path: string | undefined, readonly values: Map<string, string>, readonly skipped: SkippedHostLimitFile | undefined }}
 */
export function readHostLimitFileAt(source) {
  if (!source) return { path: undefined, values: new Map(), skipped: undefined };
  let text;
  try {
    text = readFileSync(source.path, "utf8");
  } catch (error) {
    const reason =
      error instanceof Error && "code" in error && typeof error.code === "string"
        ? error.code
        : "read failed";
    if (reason === "ENOENT" || reason === "ENOTDIR") {
      return { path: source.path, values: new Map(), skipped: undefined };
    }
    if (source.origin === "default" && (reason === "EACCES" || reason === "EPERM")) {
      const skipped = Object.freeze({
        code: HOST_LIMITS_FILE_UNREADABLE,
        path: source.path,
        reason,
        remediation: HOST_LIMITS_FILE_REMEDIATION,
      });
      reportHostLimitFile(
        source.path,
        `DocsFab cannot read the host limits file ${source.path} (${reason}), so it skips that file and the limit overrides it sets do not apply. ${HOST_LIMITS_FILE_REMEDIATION}`,
      );
      return { path: source.path, values: new Map(), skipped };
    }
    throw new HostLimitsFileError(source, reason);
  }
  return {
    path: source.path,
    values: parseHostLimitAssignments(text, source.path),
    skipped: undefined,
  };
}

/**
 * Parse a host configuration file inertly. Values are never evaluated.
 *
 * @param {string} text
 * @param {string} path
 * @returns {Map<string, string>}
 */
export function parseHostLimitAssignments(text, path) {
  const values = new Map();
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^([A-Za-z0-9_.]+)=(.*)$/u.exec(trimmed);
    if (!match) {
      throw new Error(
        `Host limits file ${path} contains a line that is not a safe KEY=value assignment.`,
      );
    }
    values.set(match[1], stripQuotes(match[2]));
  }
  return values;
}

/** The limits that now govern the steps the retired answer-now reserve governed. */
const ANSWER_NOW_RESERVE_REPLACEMENTS = Object.freeze([
  "compositionExecution.answerPlan.provisionalTechnicalVerificationTokens",
  "compositionExecution.answerPlan.verifyTechnicalAccuracyTokens",
]);

/**
 * Limit names and override variables an earlier release read from a host
 * limits file or the environment, each with the limits that replaced it. A
 * retired name is never read; callers report its presence with
 * {@link RETIRED_LIMIT_NAME_WARNING} so it is never dropped silently.
 */
export const RETIRED_LIMIT_NAMES = Object.freeze({
  "compositionExecution.answerNowMinimumRemainingMs": ANSWER_NOW_RESERVE_REPLACEMENTS,
  DOCSFAB_COMPOSITION_EXECUTION_ANSWER_NOW_MINIMUM_REMAINING_MS: ANSWER_NOW_RESERVE_REPLACEMENTS,
  "runs.indexRecordMaxBytes": Object.freeze(["runs.recordMaxBytes"]),
});

/** The warning code a retired host limit name is reported under. */
export const RETIRED_LIMIT_NAME_WARNING = "retired-limit-name";

/**
 * Retired limit names set in parsed host limits file assignments, each with
 * its replacement, in name order.
 *
 * @param {Map<string, string>} hostValues
 * @returns {readonly {readonly name: string, readonly replacements: readonly string[]}[]}
 */
export function retiredHostLimitNames(hostValues) {
  return Object.entries(RETIRED_LIMIT_NAMES)
    .filter(([name]) => hostValues.has(name))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, replacements]) => Object.freeze({ name, replacements }));
}

/**
 * Retired override variables set, non-empty, in the process environment, each
 * with its replacement, in name order.
 *
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} environment
 * @returns {readonly {readonly name: string, readonly replacements: readonly string[]}[]}
 */
export function retiredEnvironmentLimitNames(environment) {
  return Object.entries(RETIRED_LIMIT_NAMES)
    .filter(([name]) => (environment[name]?.trim() ?? "") !== "")
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, replacements]) => Object.freeze({ name, replacements }));
}

/**
 * @param {{name: string, override: string | null, unit: string, min: number, max: number}} definition
 * @param {string} raw
 */
export function parseLimitOverride(definition, raw) {
  const value = Number(raw);
  if (definition.name === "host.slack.liveAgentAnswerMaxChunks" && value > 0) {
    throw new Error(
      "DOCSFAB_HOST_SLACK_LIVE_AGENT_ANSWER_MAX_CHUNKS no longer truncates answers. Remove the positive override or set it to 0 for complete delivery; use DOCSFAB_HOST_SLACK_LIVE_AGENT_ANSWER_CHUNK_BUDGET for shorter messages.",
    );
  }
  const numeric =
    definition.unit === "ratio" ? Number.isFinite(value) : Number.isSafeInteger(value);
  if (!numeric || value < definition.min || value > definition.max) {
    const name = definition.override ?? definition.name;
    const kind = definition.unit === "ratio" ? "a number" : "an integer";
    if (definition.min === 0 && Number.isInteger(definition.max)) {
      throw new Error(`${name} must be ${kind} from ${definition.min} through ${definition.max}.`);
    }
    throw new Error(`${name} must be ${kind} between ${definition.min} and ${definition.max}.`);
  }
  return value;
}

/**
 * Resolve only the host tier. This is also the install-time validation seam:
 * it returns the known override keys present in the proposed service.env so
 * the shell schema check can exclude exactly those generated names.
 *
 * @param {readonly {name: string, override: string | null, scope: string, unit: string, min: number, max: number}[]} definitions
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} environment
 * @param {Map<string, string>} hostValues
 */
export function resolveHostLimitOverrides(definitions, environment, hostValues) {
  const resolved = new Map();
  const presentKeys = new Set();
  for (const definition of definitions) {
    const namedFileValue = hostValues.get(definition.name);
    const overrideFileValue = definition.override ? hostValues.get(definition.override) : undefined;
    const fromFile = overrideFileValue ?? namedFileValue;
    if (overrideFileValue !== undefined && definition.override)
      presentKeys.add(definition.override);
    if (namedFileValue !== undefined) presentKeys.add(definition.name);
    const fromEnvironment = definition.override
      ? environment[definition.override]?.trim()
      : undefined;
    const raw = fromEnvironment || fromFile?.trim();
    if (raw === undefined || raw === "") continue;
    if (definition.scope === "sealed") {
      throw new Error(`${definition.name}: sealed limits reject every host override.`);
    }
    resolved.set(definition.name, parseLimitOverride(definition, raw));
  }
  return { resolved, presentKeys };
}

/**
 * @param {readonly {name: string, value: number, override: string | null, scope: string, unit: string, warnAt: number, min: number, max: number, refusal: string, remediation: string}[]} definitions
 * @param {{environment?: NodeJS.ProcessEnv | Record<string, string | undefined>, hostValues?: Map<string, string>, projectValues?: Map<string, number>}} [options]
 */
export function resolveLimitDefinitions(definitions, options = {}) {
  const environment = options.environment ?? {};
  const hostValues = options.hostValues ?? new Map();
  const projectValues = options.projectValues ?? new Map();
  const names = new Set(definitions.map((definition) => definition.name));
  for (const name of projectValues.keys()) {
    if (!names.has(name)) throw new Error(`Unknown project operational limit ${name}.`);
  }
  const host = resolveHostLimitOverrides(definitions, environment, hostValues).resolved;
  const resolved = definitions.map((definition) => {
    let value = definition.value;
    let source = "config/limits.yaml";
    const hostValue = host.get(definition.name);
    if (hostValue !== undefined) {
      value = hostValue;
      source = "host";
    }
    const projectValue = projectValues.get(definition.name);
    if (projectValue !== undefined) {
      if (definition.scope !== "per-project") {
        throw new Error(
          definition.scope === "sealed"
            ? `${definition.name}: sealed limits reject every project override.`
            : `${definition.name}: project policy may only override per-project limits.`,
        );
      }
      if (projectValue < definition.min || projectValue > value) {
        throw new Error(
          `${definition.name}: project override ${projectValue} must stay within [${definition.min}, ${value}].`,
        );
      }
      value = projectValue;
      source = "project";
    }
    return Object.freeze({
      name: definition.name,
      value,
      source,
      unit: definition.unit,
      warnAt: definition.warnAt,
      refusal: definition.refusal,
      remediation: definition.remediation,
    });
  });
  assertAuthorizationWindowOrder(definitions, resolved);
  assertDiskHeadroomOrder(definitions, resolved);
  assertSecretsLockOrder(definitions, resolved);
  assertReviewDeliverySnapshotOrder(definitions, resolved);
  return resolved;
}

function assertReviewDeliverySnapshotOrder(definitions, resolved) {
  const names = new Set(definitions.map((definition) => definition.name));
  if (!names.has("reviewDelivery.snapshotUniqueOriginalBytesMax")) return;
  const values = new Map(resolved.map((entry) => [entry.name, entry.value]));
  if (
    values.get("changeSourcesGithub.objectMaterializedMaxBytes") >
    values.get("reviewDelivery.snapshotUniqueOriginalBytesMax")
  ) {
    throw new Error(
      "changeSourcesGithub.objectMaterializedMaxBytes must not exceed reviewDelivery.snapshotUniqueOriginalBytesMax; raise the retention capacity or lower the source-acquisition bound before a review run.",
    );
  }
}

/**
 * @param {readonly {name: string, override: string | null}[]} definitions
 * @param {readonly {name: string, value: number}[]} resolved
 */
function assertAuthorizationWindowOrder(definitions, resolved) {
  const maximum = resolved.find((entry) => entry.name === "autonomy.authorizationWindowMs");
  const fallback = resolved.find((entry) => entry.name === "autonomy.authorizationWindowDefaultMs");
  if (!maximum || !fallback || fallback.value <= maximum.value) return;
  const maximumDefinition = definitions.find((entry) => entry.name === maximum.name);
  const fallbackDefinition = definitions.find((entry) => entry.name === fallback.name);
  const maximumName = maximumDefinition?.override ?? maximum.name;
  const fallbackName = fallbackDefinition?.override ?? fallback.name;
  throw new Error(`${fallbackName} ${fallback.value} must be <= ${maximumName} ${maximum.value}.`);
}

/**
 * @param {readonly {name: string, override: string | null}[]} definitions
 * @param {readonly {name: string, value: number}[]} resolved
 */
export function assertDiskHeadroomOrder(definitions, resolved) {
  const over = resolved.find((entry) => entry.name === "deploy.diskHeadroomOverBytes");
  const warn = resolved.find((entry) => entry.name === "deploy.diskHeadroomWarnBytes");
  if (!over || !warn || warn.value > over.value) return;
  const overDefinition = definitions.find((entry) => entry.name === over.name);
  const warnDefinition = definitions.find((entry) => entry.name === warn.name);
  const overName = overDefinition?.override ?? over.name;
  const warnName = warnDefinition?.override ?? warn.name;
  throw new Error(`${warnName} ${warn.value} must be > ${overName} ${over.value}.`);
}

/**
 * @param {readonly {name: string, override: string | null}[]} definitions
 * @param {readonly {name: string, value: number}[]} resolved
 */
export function assertSecretsLockOrder(definitions, resolved) {
  const wait = resolved.find((entry) => entry.name === "secrets.lockWaitMs");
  const stale = resolved.find((entry) => entry.name === "secrets.lockStaleMs");
  if (!wait || !stale || stale.value < wait.value) return;
  const waitDefinition = definitions.find((entry) => entry.name === wait.name);
  const staleDefinition = definitions.find((entry) => entry.name === stale.name);
  const waitName = waitDefinition?.override ?? wait.name;
  const staleName = staleDefinition?.override ?? stale.name;
  throw new Error(`${staleName} ${stale.value} must be < ${waitName} ${wait.value}.`);
}

/** @param {string} value */
function stripQuotes(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}
