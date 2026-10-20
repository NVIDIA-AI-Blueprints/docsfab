// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type Dirent, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  HostLimitsFileError,
  readHostLimitFile,
  reportHostLimitFile,
  resolveHostLimitFilePath,
  resolveHostLimitOverrides,
} from "../config/limit-resolution.js";
import { LIMIT_DEFINITION_BY_NAME, type LimitDefinition } from "../config/limits.generated.js";

/**
 * DocsFab's own configured credentials, matched exactly.
 *
 * Owner decision on #1807: any string can be a password, so a credential shape
 * only flags repository content and never stops a run. The one credential
 * check that fails closed is an exact match against the credentials DocsFab
 * itself is configured with, such as the model key, SCM tokens, and other
 * configured secrets, so that none reaches a prompt, a run record, a log, or
 * published output.
 *
 * Sources, read again whenever the environment changes:
 * - environment variables whose name marks a credential (`*_API_KEY`,
 *   `*_TOKEN`, `*_SECRET`, `*_PASSWORD`, and similar), which covers every
 *   `SECRET_ENV_KEYS` name and the SCM token variables;
 * - files named by credential-file variables (`*_TOKEN_FILE`,
 *   `*_CREDENTIAL_FILE`, and similar), including a JSON credential map;
 * - every file in systemd's `$CREDENTIALS_DIRECTORY`;
 * - values and files a loader registers, which stay for the process lifetime.
 *
 * A match covers the value, its URL-encoded, JSON-escaped, and base64
 * (standard and URL-safe, at each byte alignment) forms, and any piece of at
 * least `secrets.configuredCredentialFragmentChars` characters, so a
 * truncated echo still matches. Pieces come only from secret material: a
 * value with whitespace (a PEM block) gives none, a URL gives pieces of its
 * password only, and a JWT gives pieces of its signature only. A value
 * shorter than `secrets.configuredCredentialMinChars`, or a value or piece
 * with fewer than `secrets.configuredCredentialMinDistinctChars` distinct
 * characters, such as a mask of one repeated letter, is not compared; the
 * inventory reports such a value.
 *
 * Nothing here returns, logs, or throws a credential value or a piece of one.
 * A match names only where the credential is configured and in which form it
 * appeared.
 *
 * The three matching bounds take the host overrides `limit()` applies, from
 * their override variables and the host limits file, and `docsfab doctor`
 * names each source with a value the minimums leave uncompared. A refresh
 * reads every credential file, the systemd credentials directory, and the
 * host limits file again, so a file rewritten in place, or added to the
 * directory, is matched from the next check. A value read from a file stays
 * matched after the file changes, until the process exits: a rotated-out
 * credential can still be valid, and it is still DocsFab's own (#1807).
 */

export type ConfiguredCredentialForm =
  | "value"
  | "fragment"
  | "url-encoded"
  | "json-escaped"
  | "base64"
  | "base64url";

export interface ConfiguredCredentialMatch {
  /** Where the credential is configured, such as `environment variable MODEL_API_KEY`. */
  readonly source: string;
  readonly form: ConfiguredCredentialForm;
  /** UTF-16 offset of the match in the screened text. */
  readonly index: number;
}

export type ConfiguredCredentialStatus =
  | "screened"
  | "empty"
  | "shorter-than-minimum"
  | "too-few-distinct-characters"
  | "unreadable"
  | "over-read-bound";

export interface ConfiguredCredentialInventoryEntry {
  readonly source: string;
  readonly status: ConfiguredCredentialStatus;
}

/** A minimum that leaves a configured value uncompared. */
export type ConfiguredCredentialUncomparedRule =
  | "shorter-than-minimum"
  | "too-few-distinct-characters";

/**
 * A configured source with a value a matching minimum leaves uncompared. It
 * names the source, the rule, and the setting that lowers the minimum, never
 * the value or its length.
 */
export interface UncomparedConfiguredCredential {
  /** Where the credential is configured, such as `environment variable X_PASSWORD`. */
  readonly source: string;
  readonly rule: ConfiguredCredentialUncomparedRule;
  /** The limit behind the rule, such as `secrets.configuredCredentialMinChars`. */
  readonly limit: string;
  /** The limit's effective value. */
  readonly limitValue: number;
  /** The host override that changes the limit. */
  readonly override: string;
  /** The lowest value the override accepts. */
  readonly lowestValue: number;
}

export interface ConfiguredCredentialRegistryOptions {
  /**
   * Environment to discover credentials in, read at every check. Without it
   * the registry reads `process.env` at most once per synchronous run of
   * checks, until the next microtask, and again after `refresh()`.
   */
  readonly environment?: () => NodeJS.ProcessEnv;
  /** Nonsecret host defaults for the three catalog-declared comparison limits. */
  readonly matchingDefaults?: () => ConfiguredCredentialMatchingDefaults | undefined;
  /**
   * Keep registrations in the one store every module instance in this process
   * shares, as the process registry does. Defaults to a private store.
   */
  readonly sharedRegistrations?: boolean;
}

export interface ConfiguredCredentialRegistry {
  /** Add a credential value a loader read. Returns its status; `screened` means it is compared. */
  register(value: string, source: string): ConfiguredCredentialStatus;
  /** Add the credential in a file: its trimmed text, or the values of a JSON credential map. */
  registerFile(path: string, source: string): ConfiguredCredentialStatus;
  find(text: string): ConfiguredCredentialMatch | null;
  /** Search every string, key or value, in a structured value. */
  findInValue(value: unknown): ConfiguredCredentialMatch | null;
  /** The text with every form and piece of a configured credential replaced by `[REDACTED]`. */
  redact(text: string): string;
  /** Sorted, merged `[start, end)` spans of every form and piece in the text. */
  spans(text: string): Array<[number, number]>;
  /** Every source with its status, never a value. */
  inventory(): readonly ConfiguredCredentialInventoryEntry[];
  /** Read the environment again at the next check, after code that changed it. */
  refresh(): void;
  /**
   * Every source with a value a matching minimum leaves uncompared, with the
   * rule and the setting that lowers it; never a value or its length.
   */
  uncompared(): readonly UncomparedConfiguredCredential[];
}

const CREDENTIAL_NAME =
  /(?:^|_)(?:API_?KEY|SECRET_ACCESS_KEY|SECRET_KEY|PRIVATE_KEY|SIGNING_KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|WEBHOOK_URL)$/iu;
/** A URL that is itself a bearer secret, such as `DOCSFAB_SLACK_WEBHOOK_URL`: its path is secret too. */
const SECRET_URL_NAME = /(?:^|_)WEBHOOK_URL$/iu;
/** Proxy variables, in either case, whose URL may carry a user name and password. */
const PROXY_URL_NAMES: ReadonlySet<string> = new Set([
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
]);
const CREDENTIAL_FILE_NAME =
  /(?:^|_)(?:API_?KEY|SECRET_ACCESS_KEY|SECRET_KEY|PRIVATE_KEY|SIGNING_KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|CREDENTIALS?)_FILE$/iu;
/** A JSON key, lowercased with separators removed, whose string values are credentials. */
const CREDENTIAL_KEY =
  /(?:credentials?|token|secret|password|passwd|passphrase|apikey|privatekey)$/u;
const KEY_SEPARATORS = /[^a-z0-9]/gu;
const SYSTEMD_CREDENTIALS_DIRECTORY = "CREDENTIALS_DIRECTORY";
/** A JWT's header and claims are shared or public; only its signature is secret. */
const JWT_SIGNATURE = /^eyJ[\w-]*\.[\w-]*\.([\w-]+)$/u;
const WHITESPACE = /\s/u;
/** Byte offsets at which a value can start inside a base64 group. */
const BASE64_ALIGNMENTS = 3;
const HASH_MULTIPLIER = 0x01000193;
const REDACTED = "[REDACTED]";
/** The matching bounds an operator may override, by their catalog limit. */
const MATCHING_BOUND_LIMITS = {
  minChars: "secrets.configuredCredentialMinChars",
  fragmentChars: "secrets.configuredCredentialFragmentChars",
  minDistinctChars: "secrets.configuredCredentialMinDistinctChars",
} as const;
const UNCOMPARED_RULES: readonly ConfiguredCredentialUncomparedRule[] = [
  "shorter-than-minimum",
  "too-few-distinct-characters",
];
const INVALID_BOUND_WARNING = "configured-credential-limit-invalid";
/** Invalid-setting messages this module instance has already written to stderr. */
const reportedInvalidBounds = new Set<string>();

/** Whether an environment variable with this name holds a credential value. */
export function isConfiguredCredentialName(name: string): boolean {
  return CREDENTIAL_NAME.test(name);
}

/** Whether an environment variable with this name holds the path of a credential file. */
export function isConfiguredCredentialFileName(name: string): boolean {
  return CREDENTIAL_FILE_NAME.test(name);
}

/** Operator-facing wording for a match: the source and the form, never the value. */
export function describeConfiguredCredentialMatch(match: ConfiguredCredentialMatch): string {
  const credential = `the configured credential from ${match.source}`;
  switch (match.form) {
    case "value":
      return credential;
    case "fragment":
      return `part of ${credential}`;
    case "url-encoded":
      return `${credential}, URL-encoded`;
    case "json-escaped":
      return `${credential}, JSON-escaped`;
    case "base64":
      return `${credential}, base64-encoded`;
    case "base64url":
      return `${credential}, URL-safe base64-encoded`;
  }
}

/**
 * The `docsfab doctor` line for a source with a value a minimum leaves
 * uncompared: the source, the rule, and the setting that compares such values,
 * never the value or its length.
 */
export function describeUncomparedConfiguredCredential(
  entry: UncomparedConfiguredCredential,
): string {
  const shorter = entry.rule === "shorter-than-minimum";
  const rule = shorter
    ? `has a value shorter than ${entry.limitValue} characters (${entry.limit})`
    : `has a value with fewer than ${entry.limitValue} distinct characters (${entry.limit})`;
  const configure = shorter
    ? "configure a longer credential"
    : "configure a credential with more distinct characters";
  const remedy =
    entry.limitValue > entry.lowestValue
      ? `Lower ${entry.override}, as far as ${entry.lowestValue}, to compare ${
          shorter ? "shorter values" : "values with fewer distinct characters"
        }, or ${configure}.`
      : `${entry.override} is already at its lowest value, so ${configure}.`;
  return `Configured credential not compared: ${entry.source} ${rule}. ${remedy}`;
}

interface CredentialCandidate {
  readonly value: string;
  readonly source: string;
}

interface Anchor {
  readonly needle: string;
  readonly form: ConfiguredCredentialForm;
  readonly source: string;
}

interface Compiled {
  /** Forms and pieces of at least the piece length, keyed by the hash of their first piece. */
  readonly anchors: ReadonlyMap<number, readonly Anchor[]>;
  /** Forms shorter than the piece length, found by plain search. */
  readonly shortForms: readonly Anchor[];
  readonly width: number;
  readonly power: number;
}

interface EnvironmentState {
  readonly key: string;
  readonly candidates: readonly CredentialCandidate[];
  readonly inventory: readonly ConfiguredCredentialInventoryEntry[];
  /** For a file of several values, the minimums any of them fails, by source. */
  readonly uncomparedInFiles?: ReadonlyMap<string, readonly ConfiguredCredentialUncomparedRule[]>;
}

interface Bounds {
  readonly minChars: number;
  readonly fragmentChars: number;
  readonly minDistinctChars: number;
  readonly fileBytes: number;
}

export interface ConfiguredCredentialMatchingDefaults {
  readonly minChars: number;
  readonly fragmentChars: number;
  readonly minDistinctChars: number;
}

interface FileValues {
  readonly status: ConfiguredCredentialStatus;
  readonly values: readonly string[];
  /** The minimums any value fails, though `status` names the file's best value. */
  readonly uncompared?: readonly ConfiguredCredentialUncomparedRule[];
}

/**
 * Registered values and their sources' statuses. It exposes methods only, so
 * inspecting it never prints a value.
 */
interface RegistrationStore {
  /** Add a value; false when it is already registered. */
  add(value: string, source: string): boolean;
  record(source: string, status: ConfiguredCredentialStatus): void;
  candidates(): readonly CredentialCandidate[];
  inventory(): readonly ConfiguredCredentialInventoryEntry[];
  /** Changes whenever a value is added, so every reader knows to recompile. */
  version(): number;
  /** Changes on every refresh, so every reader rereads its environment. */
  environmentGeneration(): number;
  refreshEnvironment(): void;
}

function createRegistrationStore(): RegistrationStore {
  const values = new Map<string, string>();
  const statuses = new Map<string, ConfiguredCredentialStatus>();
  let version = 0;
  let environmentGeneration = 0;
  return Object.freeze({
    add(value: string, source: string) {
      if (values.has(value)) return false;
      values.set(value, source);
      version += 1;
      return true;
    },
    record(source: string, status: ConfiguredCredentialStatus) {
      statuses.set(source, status);
    },
    candidates: () => [...values].map(([value, source]) => ({ value, source })),
    inventory: () => [...statuses].map(([source, status]) => ({ source, status })),
    version: () => version,
    environmentGeneration: () => environmentGeneration,
    refreshEnvironment() {
      environmentGeneration += 1;
    },
  });
}

/**
 * The process-wide store. A host that loads this module both as ESM and
 * through a CommonJS loader gets two module instances; both find this one
 * store, so a value registered through either is matched by both.
 */
const SHARED_REGISTRATIONS = Symbol.for("docsfab.configured-credentials");

function sharedRegistrationStore(): RegistrationStore {
  const holder = globalThis as typeof globalThis & { [SHARED_REGISTRATIONS]?: RegistrationStore };
  const existing = holder[SHARED_REGISTRATIONS];
  if (existing && typeof existing.environmentGeneration === "function") return existing;
  const created = createRegistrationStore();
  Object.defineProperty(holder, SHARED_REGISTRATIONS, { value: created, configurable: false });
  return created;
}

export function createConfiguredCredentialRegistry(
  options: ConfiguredCredentialRegistryOptions = {},
): ConfiguredCredentialRegistry {
  return configuredCredentialRegistry(options, false);
}

/**
 * Screen direct environment credentials and an already-known registration
 * snapshot without discovering files or changing the process registry.
 * Matching uses active in-memory defaults and direct override variables;
 * diagnostic path formatting does not load the host limits file.
 */
export function redactDirectConfiguredCredentials(
  text: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return configuredCredentialRegistry(
    { environment: () => environment, matchingDefaults: matchingDefaultsForHost },
    true,
  ).redact(text);
}

function configuredCredentialRegistry(
  options: ConfiguredCredentialRegistryOptions,
  directEnvironmentOnly: boolean,
): ConfiguredCredentialRegistry {
  const environment = options.environment ?? (() => process.env);
  // Enumerating `process.env` costs tens of microseconds, and a screen can run
  // once per path in a synchronous loop of a hundred thousand. The process
  // registry reuses one reading until the next microtask; `refresh()` and the
  // environment loaders end it early. A microtask, unlike a timer, is never
  // faked by test clocks, so a reading cannot outlive its run of checks.
  const turnCached = options.environment === undefined;
  let environmentCurrent = false;
  let readGeneration = -1;
  const registrations = options.sharedRegistrations
    ? sharedRegistrationStore()
    : createRegistrationStore();
  if (directEnvironmentOnly) {
    for (const { value, source } of sharedRegistrationStore().candidates()) {
      registrations.add(value, source);
    }
  }
  let bounds: Bounds | undefined;
  const matchingDefaults = options.matchingDefaults ?? (() => undefined);
  /** The override settings `bounds` was resolved from. */
  let boundsKey: string | undefined;
  /** The refresh generation at which credential files were last read. */
  let filesGeneration = -1;
  let environmentState: EnvironmentState | undefined;
  let compiled: Compiled | undefined;
  let compiledVersion = -1;

  const currentBounds = (): Bounds => {
    bounds ??= resolveBounds(environment(), matchingDefaults(), !directEnvironmentOnly);
    return bounds;
  };

  const valueStatus = (value: string): ConfiguredCredentialStatus => {
    if (value.length === 0) return "empty";
    if (value.length < currentBounds().minChars) return "shorter-than-minimum";
    if (distinctCharacters(value) < currentBounds().minDistinctChars) {
      return "too-few-distinct-characters";
    }
    return "screened";
  };

  const readFileValues = (path: string): FileValues => {
    let text: string;
    try {
      const stats = statSync(path);
      if (!stats.isFile()) return { status: "unreadable", values: [] };
      if (stats.size > currentBounds().fileBytes) return { status: "over-read-bound", values: [] };
      text = readFileSync(path, "utf8");
    } catch {
      return { status: "unreadable", values: [] };
    }
    const values = credentialValuesInFile(text);
    const statuses = values.map(valueStatus);
    const status =
      (["screened", "shorter-than-minimum", "too-few-distinct-characters"] as const).find(
        (candidate) => statuses.includes(candidate),
      ) ?? "empty";
    const uncompared = UNCOMPARED_RULES.filter((rule) => statuses.includes(rule));
    return { status, values, uncompared };
  };

  const readEnvironment = (): EnvironmentState => {
    // A refresh through any module instance ends every instance's reading.
    const generation = registrations.environmentGeneration();
    if (environmentCurrent && environmentState && readGeneration === generation) {
      return environmentState;
    }
    readGeneration = generation;
    // A refresh through any module instance also reads every credential file,
    // the systemd credentials directory, and the host limits file again, and a
    // changed override setting resolves the matching bounds again (#1807).
    const overrides = boundOverridesKey(environment(), matchingDefaults());
    if (filesGeneration !== generation || overrides !== boundsKey) {
      filesGeneration = generation;
      boundsKey = overrides;
      bounds = undefined;
      environmentState = undefined;
    }
    if (turnCached) {
      environmentCurrent = true;
      queueMicrotask(() => {
        environmentCurrent = false;
      });
    }
    const variables = environment();
    const values: Array<[string, string]> = [];
    const files: Array<[string, string]> = [];
    const proxies: Array<[string, string]> = [];
    for (const name of Object.keys(variables)) {
      if (isConfiguredCredentialName(name)) {
        const value = variables[name]?.trim();
        if (value !== undefined) values.push([name, value]);
      } else if (!directEnvironmentOnly && isConfiguredCredentialFileName(name)) {
        const value = variables[name]?.trim();
        if (value) files.push([name, value]);
      } else if (PROXY_URL_NAMES.has(name)) {
        const value = variables[name]?.trim();
        if (value) proxies.push([name, value]);
      }
    }
    values.sort(([left], [right]) => compareNames(left, right));
    files.sort(([left], [right]) => compareNames(left, right));
    proxies.sort(([left], [right]) => compareNames(left, right));
    const directory = directEnvironmentOnly
      ? ""
      : (variables[SYSTEMD_CREDENTIALS_DIRECTORY]?.trim() ?? "");
    const key = JSON.stringify([values, files, proxies, directory]);
    if (environmentState?.key === key) return environmentState;
    const candidates: CredentialCandidate[] = [];
    const inventory: ConfiguredCredentialInventoryEntry[] = [];
    for (const [name, value] of values) {
      const source = `environment variable ${name}`;
      inventory.push({ source, status: valueStatus(value) });
      candidates.push({ value, source });
      // A webhook URL's last path segment is its secret, so a copy of that
      // segment is found alone too, and pieces of it. The segments before it,
      // such as a Slack workspace and bot ID, are shared by every webhook of
      // the workspace, so they give no pieces (#1807).
      const lastSegment = SECRET_URL_NAME.test(name) ? secretUrlSegment(value) : undefined;
      if (lastSegment) candidates.push({ value: lastSegment, source });
    }
    // A proxy URL is a setting, not a secret. Its password is the credential
    // when it is compared. Otherwise its user name is, as in a token-only
    // proxy URL or one whose password is a placeholder such as `x`; beside a
    // compared password, the user name is a name others write (#1807).
    for (const [name, value] of proxies) {
      const { username, password } = proxyUrlUserinfo(value);
      const part =
        password && (valueStatus(password) === "screened" || !username) ? "password" : "user name";
      const secret = part === "password" ? password : username;
      if (!secret) continue;
      const source = `the proxy ${part} in environment variable ${name}`;
      inventory.push({ source, status: valueStatus(secret) });
      candidates.push({ value: secret, source });
    }
    const uncomparedInFiles = new Map<string, readonly ConfiguredCredentialUncomparedRule[]>();
    const addFile = (path: string, source: string) => {
      const loaded = readFileValues(path);
      inventory.push({ source, status: loaded.status });
      for (const value of loaded.values) {
        candidates.push({ value, source });
        // Kept for the process, as a loader's registration is, so a value
        // rotated out of the file still matches after a refresh (#1807).
        registerValue(value, source);
      }
      if (loaded.uncompared?.length) uncomparedInFiles.set(source, loaded.uncompared);
    };
    for (const [name, path] of files) addFile(path, `credential file named by ${name}`);
    if (directory) {
      let entries: Dirent[] = [];
      try {
        entries = readdirSync(directory, { withFileTypes: true });
      } catch {
        inventory.push({ source: "systemd credentials directory", status: "unreadable" });
      }
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        if (!entry.isFile() && !entry.isSymbolicLink()) continue;
        addFile(join(directory, entry.name), `systemd credential ${entry.name}`);
      }
    }
    compiled = undefined;
    environmentState = { key, candidates, inventory, uncomparedInFiles };
    return environmentState;
  };

  const compile = (): Compiled => {
    const state = readEnvironment();
    if (compiled && compiledVersion === registrations.version()) return compiled;
    compiledVersion = registrations.version();
    const { fragmentChars, minDistinctChars } = currentBounds();
    const seen = new Set<string>();
    const wholeForms: Anchor[] = [];
    const pieces: Anchor[] = [];
    const pieceNeedles = new Set<string>();
    const candidates = [...registrations.candidates(), ...state.candidates];
    for (const { value, source } of candidates.flatMap(withUrlSecret)) {
      const status = valueStatus(value);
      // A local path echo also screens whole uncompared values; fragment policy
      // and the process registry keep their existing matching minimums.
      const wholeFallback = directEnvironmentOnly && status !== "screened" && value.length > 0;
      if ((!wholeFallback && status !== "screened") || seen.has(value)) continue;
      seen.add(value);
      wholeForms.push({ needle: value, form: "value", source });
      for (const [form, needle] of encodedForms(value, wholeFallback)) {
        if (wholeFallback || valueStatus(needle) === "screened") {
          wholeForms.push({ needle, form, source });
        }
      }
      if (wholeFallback) continue;
      const secret = pieceSource(value);
      if (secret === null) continue;
      for (let start = 0; start + fragmentChars <= secret.length; start += 1) {
        const needle = secret.slice(start, start + fragmentChars);
        // A piece of too few distinct characters, such as a repeated letter, is not secret material.
        if (pieceNeedles.has(needle) || distinctCharacters(needle) < minDistinctChars) continue;
        pieceNeedles.add(needle);
        pieces.push({ needle, form: "fragment", source });
      }
    }
    const anchors = new Map<number, Anchor[]>();
    const shortForms: Anchor[] = [];
    const addAnchor = (anchor: Anchor) => {
      const hash = hashRange(anchor.needle, 0, fragmentChars);
      const existing = anchors.get(hash);
      if (existing) existing.push(anchor);
      else anchors.set(hash, [anchor]);
    };
    // Whole forms go first, so a complete value reports as itself, not as a piece.
    for (const whole of wholeForms) {
      if (whole.needle.length < fragmentChars) shortForms.push(whole);
      else addAnchor(whole);
    }
    for (const piece of pieces) addAnchor(piece);
    compiled = { anchors, shortForms, width: fragmentChars, power: leadingPower(fragmentChars) };
    return compiled;
  };

  const registerValue = (value: string, source: string) => {
    if (value.trim()) registrations.add(value.trim(), source);
  };

  return {
    register(value, source) {
      // Judged by the bounds the current environment sets, after a refresh too.
      readEnvironment();
      const trimmed = value.trim();
      const status = valueStatus(trimmed);
      registrations.record(source, status);
      registerValue(trimmed, source);
      return status;
    },
    registerFile(path, source) {
      readEnvironment();
      const loaded = readFileValues(path);
      registrations.record(source, loaded.status);
      for (const value of loaded.values) registerValue(value, source);
      return loaded.status;
    },
    find(text) {
      return scan(text, compile());
    },
    spans(text) {
      return matchSpans(text, compile());
    },
    redact(text) {
      const spans = matchSpans(text, compile());
      if (spans.length === 0) return text;
      let output = "";
      let cursor = 0;
      for (const [start, end] of spans) {
        output += `${text.slice(cursor, start)}${REDACTED}`;
        cursor = end;
      }
      return output + text.slice(cursor);
    },
    findInValue(value) {
      const current = compile();
      let found = null as ConfiguredCredentialMatch | null;
      visitStrings(value, (text) => {
        found = scan(text, current);
        return found !== null;
      });
      return found;
    },
    inventory() {
      const fromEnvironment = readEnvironment().inventory;
      return [...registrations.inventory(), ...fromEnvironment];
    },
    refresh() {
      environmentCurrent = false;
      registrations.refreshEnvironment();
    },
    uncompared() {
      const state = readEnvironment();
      const current = currentBounds();
      const found: UncomparedConfiguredCredential[] = [];
      const reported = new Set<string>();
      const candidateSources = new Set<string>();
      const rulesBySource = new Map<string, Set<ConfiguredCredentialUncomparedRule>>();
      for (const { value, source } of registrations.candidates()) {
        candidateSources.add(source);
        const status = valueStatus(value);
        if (status === "shorter-than-minimum" || status === "too-few-distinct-characters") {
          const rules = rulesBySource.get(source) ?? new Set<ConfiguredCredentialUncomparedRule>();
          rules.add(status);
          rulesBySource.set(source, rules);
        }
      }
      for (const { source, status } of [...registrations.inventory(), ...state.inventory]) {
        if (
          !candidateSources.has(source) &&
          (status === "shorter-than-minimum" || status === "too-few-distinct-characters")
        ) {
          const rules = rulesBySource.get(source) ?? new Set<ConfiguredCredentialUncomparedRule>();
          rules.add(status);
          rulesBySource.set(source, rules);
        }
        for (const rule of rulesBySource.get(source) ?? []) {
          const key = JSON.stringify([source, rule]);
          if (reported.has(key)) continue;
          reported.add(key);
          found.push(uncomparedEntry(source, rule, current));
        }
      }
      return found;
    },
  };
}

/** The registry entry for a source with a value `rule` leaves uncompared. */
function uncomparedEntry(
  source: string,
  rule: ConfiguredCredentialUncomparedRule,
  bounds: Bounds,
): UncomparedConfiguredCredential {
  const shorter = rule === "shorter-than-minimum";
  const limit = shorter ? MATCHING_BOUND_LIMITS.minChars : MATCHING_BOUND_LIMITS.minDistinctChars;
  const definition = limitDefinitionNamed(limit);
  return Object.freeze({
    source,
    rule,
    limit,
    limitValue: shorter ? bounds.minChars : bounds.minDistinctChars,
    override: definition.override ?? limit,
    lowestValue: definition.min,
  });
}

/**
 * Call `onHit` for each form or piece found at each offset, left to right,
 * until it returns true. Forms shorter than the piece length are not visited.
 */
function forEachAnchorHit(
  text: string,
  compiled: Compiled,
  onHit: (anchor: Anchor, start: number) => boolean,
): void {
  const { anchors, width, power } = compiled;
  if (anchors.size === 0 || text.length < width) return;
  let hash = hashRange(text, 0, width);
  for (let start = 0; ; start += 1) {
    for (const anchor of anchors.get(hash) ?? []) {
      if (text.startsWith(anchor.needle, start) && onHit(anchor, start)) return;
    }
    const next = start + width;
    if (next >= text.length) return;
    hash =
      (Math.imul((hash - Math.imul(text.charCodeAt(start), power)) | 0, HASH_MULTIPLIER) +
        text.charCodeAt(next)) |
      0;
  }
}

function scan(text: string, compiled: Compiled): ConfiguredCredentialMatch | null {
  // Typed by assertion: the callback assigns it, which narrowing does not follow.
  let found = null as ConfiguredCredentialMatch | null;
  forEachAnchorHit(text, compiled, (anchor, index) => {
    found = { source: anchor.source, form: anchor.form, index };
    return true;
  });
  for (const whole of compiled.shortForms) {
    const index = text.indexOf(whole.needle);
    if (index >= 0 && (found === null || index < found.index)) {
      found = { source: whole.source, form: whole.form, index };
    }
  }
  return found;
}

/** Sorted, merged spans of every form and piece in the text. */
function matchSpans(text: string, compiled: Compiled): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  forEachAnchorHit(text, compiled, (anchor, start) => {
    spans.push([start, start + anchor.needle.length]);
    return false;
  });
  for (const whole of compiled.shortForms) {
    let index = text.indexOf(whole.needle);
    while (index >= 0) {
      spans.push([index, index + whole.needle.length]);
      index = text.indexOf(whole.needle, index + 1);
    }
  }
  spans.sort((left, right) => left[0] - right[0]);
  const merged: Array<[number, number]> = [];
  for (const [start, end] of spans) {
    const previous = merged.at(-1);
    if (previous && start <= previous[1]) previous[1] = Math.max(previous[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

/** The last non-empty path segment of a secret URL, its secret, or undefined when it has none. */
function secretUrlSegment(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  return url.pathname
    .split("/")
    .filter((segment) => segment.length > 0)
    .at(-1);
}

/** A URL's decoded user name and password, each empty when absent or unparsable. */
function proxyUrlUserinfo(value: string): { username: string; password: string } {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { username: "", password: "" };
  }
  return { username: decodedUserinfo(url.username), password: decodedUserinfo(url.password) };
}

function decodedUserinfo(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    // A malformed escape is kept as written.
    return raw;
  }
}

/** A URL value also yields its password, or a username that carries the token alone. */
function withUrlSecret(candidate: CredentialCandidate): CredentialCandidate[] {
  if (!candidate.value.includes("://")) return [candidate];
  let url: URL;
  try {
    url = new URL(candidate.value);
  } catch {
    return [candidate];
  }
  const secret = url.password || url.username;
  if (!secret) return [candidate];
  let decoded = secret;
  try {
    decoded = decodeURIComponent(secret);
  } catch {
    // A malformed escape is kept as written.
  }
  return [candidate, { value: decoded, source: candidate.source }];
}

/**
 * The matching bounds this environment sets, resolved as `limit()` resolves a
 * host limit: the override variable, then the host limits file by override or
 * limit name. This module is a leaf that the contract kit imports and the host
 * loads under strip-types, so it cannot load the limit resolver, which reaches
 * the contract kit; it uses the same dependency-free resolution instead.
 *
 * Startup refuses an invalid override (#1807). A process that skipped startup
 * validation keeps the catalog value for that bound and says so once on
 * stderr, so a screen never stops on a setting.
 */
function resolveBounds(
  variables: NodeJS.ProcessEnv,
  defaults?: ConfiguredCredentialMatchingDefaults,
  discoverHostLimits = true,
): Bounds {
  let hostValues = new Map<string, string>();
  if (discoverHostLimits) {
    try {
      hostValues = readHostLimitFile(undefined, variables).values;
    } catch (error) {
      if (error instanceof HostLimitsFileError) {
        reportHostLimitFile(
          error.path,
          `${error.message} The configured-credential screens use the override variables alone until it is corrected.`,
        );
      } else reportInvalidBound(error, "the override variables alone");
    }
  }
  const bound = (key: keyof ConfiguredCredentialMatchingDefaults): number => {
    const name = MATCHING_BOUND_LIMITS[key];
    const catalog = limitDefinitionNamed(name);
    const definition = defaults ? { ...catalog, value: defaults[key] } : catalog;
    try {
      const resolved = resolveHostLimitOverrides([definition], variables, hostValues).resolved;
      return resolved.get(name) ?? definition.value;
    } catch (error) {
      reportInvalidBound(error, `${name} = ${definition.value}`);
      return definition.value;
    }
  };
  return {
    minChars: bound("minChars"),
    fragmentChars: bound("fragmentChars"),
    minDistinctChars: bound("minDistinctChars"),
    fileBytes: limitDefinitionNamed("authority.credentialFileBytes").value,
  };
}

/** Strictly resolve a prospective host policy before any shared state is changed. */
export function resolveConfiguredCredentialMatchingDefaults(
  variables: NodeJS.ProcessEnv,
): ConfiguredCredentialMatchingDefaults {
  let hostValues = new Map<string, string>();
  try {
    hostValues = readHostLimitFile(undefined, variables).values;
  } catch (error) {
    if (!(error instanceof HostLimitsFileError) || error.origin !== "default") throw error;
    reportHostLimitFile(error.path, error.message);
  }
  const names = Object.values(MATCHING_BOUND_LIMITS);
  const definitions = names.map(limitDefinitionNamed);
  const resolved = resolveHostLimitOverrides(definitions, variables, hostValues).resolved;
  return Object.freeze({
    minChars:
      resolved.get(MATCHING_BOUND_LIMITS.minChars) ??
      limitDefinitionNamed(MATCHING_BOUND_LIMITS.minChars).value,
    fragmentChars:
      resolved.get(MATCHING_BOUND_LIMITS.fragmentChars) ??
      limitDefinitionNamed(MATCHING_BOUND_LIMITS.fragmentChars).value,
    minDistinctChars:
      resolved.get(MATCHING_BOUND_LIMITS.minDistinctChars) ??
      limitDefinitionNamed(MATCHING_BOUND_LIMITS.minDistinctChars).value,
  });
}

/** The settings the matching bounds read, plus their active defaults. */
function boundOverridesKey(
  variables: NodeJS.ProcessEnv,
  defaults?: ConfiguredCredentialMatchingDefaults,
): string {
  return JSON.stringify([
    resolveHostLimitFilePath(undefined, variables) ?? null,
    defaults ?? null,
    ...Object.values(MATCHING_BOUND_LIMITS).map((name) => {
      const override = limitDefinitionNamed(name).override;
      return override === null ? null : (variables[override] ?? null);
    }),
  ]);
}

/** Write an invalid matching-bound setting to stderr once; the message names a setting, never a value. */
function reportInvalidBound(error: unknown, kept: string): void {
  const message = error instanceof Error ? error.message : String(error);
  if (reportedInvalidBounds.has(message)) return;
  reportedInvalidBounds.add(message);
  process.stderr.write(
    `WARNING ${INVALID_BOUND_WARNING}: ${message} The configured-credential screens use ${kept} until it is corrected; docsfab doctor --limits refuses it by name.\n`,
  );
}

/** A limit's catalog definition from the generated mirror. */
function limitDefinitionNamed(name: string): LimitDefinition {
  const definition = LIMIT_DEFINITION_BY_NAME[name];
  if (!definition) {
    throw new Error(`Unknown operational limit ${name} is not declared in config/limits.yaml.`);
  }
  return definition;
}

/** The credential values a file holds: its trimmed text, or the values of a JSON credential map. */
function credentialValuesInFile(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (!trimmed.startsWith("{")) return [trimmed];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [trimmed];
  }
  const values: string[] = [];
  collectCredentialLeaves(parsed, false, values);
  return values;
}

/** String leaves under a credential-named key, such as every value of a `credentials` map. */
function collectCredentialLeaves(value: unknown, underCredential: boolean, values: string[]): void {
  if (typeof value === "string") {
    if (underCredential && value.trim()) values.push(value.trim());
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectCredentialLeaves(item, underCredential, values);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    const credentialKey = CREDENTIAL_KEY.test(key.toLowerCase().replace(KEY_SEPARATORS, ""));
    collectCredentialLeaves(item, underCredential || credentialKey, values);
  }
}

function encodedForms(
  value: string,
  wholeValueOnly = false,
): Array<[ConfiguredCredentialForm, string]> {
  const forms: Array<[ConfiguredCredentialForm, string]> = [];
  const add = (form: ConfiguredCredentialForm, text: string) => {
    if (text && text !== value && !forms.some(([, existing]) => existing === text)) {
      forms.push([form, text]);
    }
  };
  try {
    const encoded = encodeURIComponent(value);
    add("url-encoded", encoded);
    add(
      "url-encoded",
      encoded.replace(/%[0-9A-F]{2}/gu, (hex) => hex.toLowerCase()),
    );
  } catch {
    // A lone surrogate has no URL encoding; the other forms still apply.
  }
  add("json-escaped", JSON.stringify(value).slice(1, -1));
  const bytes = Buffer.from(value, "utf8");
  const addBase64 = (part: Buffer) => {
    add("base64", part.toString("base64"));
    add("base64url", part.toString("base64url"));
  };
  if (wholeValueOnly) {
    addBase64(bytes);
  } else {
    for (let offset = 0; offset < BASE64_ALIGNMENTS; offset += 1) {
      const groups = Math.floor((bytes.length - offset) / BASE64_ALIGNMENTS);
      if (groups < 1) continue;
      addBase64(bytes.subarray(offset, offset + groups * BASE64_ALIGNMENTS));
    }
  }
  return forms;
}

/** The part of a value its pieces come from, or null when no piece is secret on its own. */
function pieceSource(value: string): string | null {
  if (WHITESPACE.test(value) || value.includes("://")) return null;
  const jwt = JWT_SIGNATURE.exec(value);
  return jwt ? (jwt[1] ?? null) : value;
}

function distinctCharacters(text: string): number {
  return new Set(text).size;
}

function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function hashRange(text: string, start: number, length: number): number {
  let hash = 0;
  for (let index = start; index < start + length; index += 1) {
    hash = (Math.imul(hash, HASH_MULTIPLIER) + text.charCodeAt(index)) | 0;
  }
  return hash;
}

/** HASH_MULTIPLIER to the power `length - 1`, in 32-bit arithmetic, to roll a hash forward. */
function leadingPower(length: number): number {
  let power = 1;
  for (let step = 1; step < length; step += 1) power = Math.imul(power, HASH_MULTIPLIER);
  return power;
}

/** Call `visit` on every string key and value until it returns true. A cycle is visited once. */
function visitStrings(value: unknown, visit: (text: string) => boolean): void {
  const seen = new WeakSet<object>();
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === "string") {
      if (visit(current)) return;
      continue;
    }
    if (current === null || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    if (ArrayBuffer.isView(current)) {
      const bytes = Buffer.from(current.buffer, current.byteOffset, current.byteLength);
      if (visit(bytes.toString("utf8"))) return;
      continue;
    }
    if (Array.isArray(current)) {
      for (const item of current) pending.push(item);
      continue;
    }
    for (const [key, item] of Object.entries(current)) {
      if (visit(key)) return;
      pending.push(item);
    }
  }
}

const SHARED_MATCHING_POLICY = Symbol.for("docsfab.configured-credentials.matching-defaults");
interface SharedMatchingPolicy {
  defaults?: ConfiguredCredentialMatchingDefaults;
  generation: number;
}

function sharedMatchingPolicy(): SharedMatchingPolicy {
  const holder = globalThis as typeof globalThis & {
    [SHARED_MATCHING_POLICY]?: SharedMatchingPolicy;
  };
  const existing = holder[SHARED_MATCHING_POLICY];
  if (existing && typeof existing.generation === "number") return existing;
  const created: SharedMatchingPolicy = { generation: 0 };
  Object.defineProperty(holder, SHARED_MATCHING_POLICY, { value: created, configurable: false });
  return created;
}

/** Activate validated defaults only for the actual host process environment. */
export function activateConfiguredCredentialMatchingDefaults(
  hostEnvironment: NodeJS.ProcessEnv,
  defaults: ConfiguredCredentialMatchingDefaults,
): void {
  if (hostEnvironment !== process.env)
    throw new Error(
      "Only the host process environment can activate credential comparison defaults.",
    );
  const policy = sharedMatchingPolicy();
  policy.defaults = Object.freeze({ ...defaults });
  policy.generation += 1;
  processRegistry.refresh();
}

/** Resolve the current process policy using active defaults and live host overrides. */
export function currentConfiguredCredentialMatchingPolicy(): ConfiguredCredentialMatchingDefaults {
  const bounds = resolveBounds(process.env, sharedMatchingPolicy().defaults);
  return {
    minChars: bounds.minChars,
    fragmentChars: bounds.fragmentChars,
    minDistinctChars: bounds.minDistinctChars,
  };
}

/** Active validated host defaults for registries that inspect a child environment. */
export function matchingDefaultsForHost(): ConfiguredCredentialMatchingDefaults | undefined {
  return sharedMatchingPolicy().defaults;
}

const processRegistry = createConfiguredCredentialRegistry({
  sharedRegistrations: true,
  matchingDefaults: matchingDefaultsForHost,
});

/** Add a credential value a loader read to the process registry. */
export function registerConfiguredCredential(
  value: string,
  source: string,
): ConfiguredCredentialStatus {
  return processRegistry.register(value, source);
}

/** Add a loader-read credential using the effective environment's screening limits. */
export function registerConfiguredCredentialForEnvironment(
  value: string,
  source: string,
  environment: NodeJS.ProcessEnv,
): ConfiguredCredentialStatus {
  return createConfiguredCredentialRegistry({
    environment: () => environment,
    sharedRegistrations: true,
    matchingDefaults: matchingDefaultsForHost,
  }).register(value, source);
}

/** Add the credential in a file to the process registry. */
export function registerConfiguredCredentialFile(
  path: string,
  source: string,
): ConfiguredCredentialStatus {
  return processRegistry.registerFile(path, source);
}

/** Add a loader-read credential file using the effective environment's screening limits. */
export function registerConfiguredCredentialFileForEnvironment(
  path: string,
  source: string,
  environment: NodeJS.ProcessEnv,
): ConfiguredCredentialStatus {
  return createConfiguredCredentialRegistry({
    environment: () => environment,
    sharedRegistrations: true,
    matchingDefaults: matchingDefaultsForHost,
  }).registerFile(path, source);
}

/** The first configured credential in the text, from the process registry. */
export function findConfiguredCredential(text: string): ConfiguredCredentialMatch | null {
  return processRegistry.find(text);
}

/** The first configured credential in any string of a structured value. */
export function findConfiguredCredentialInValue(value: unknown): ConfiguredCredentialMatch | null {
  return processRegistry.findInValue(value);
}

/** The text with every configured credential, in any form or piece, replaced by `[REDACTED]`. */
export function redactConfiguredCredentials(text: string): string {
  return processRegistry.redact(text);
}

/**
 * Sorted, merged `[start, end)` spans of every configured credential in the
 * text, in any form or piece, for a redaction that keeps the rest of the text.
 */
export function configuredCredentialSpans(text: string): Array<[number, number]> {
  return processRegistry.spans(text);
}

/**
 * Read the environment again at the next check. Code that loads credentials
 * into `process.env`, such as the secrets.env loader, calls this, so a check
 * later in the same synchronous run sees them.
 *
 * The next check also reads every credential file, the systemd credentials
 * directory, and the host limits file again, so a file rewritten in place or
 * added to the directory is matched. A value an earlier read found stays
 * matched until the process exits (#1807).
 */
export function refreshConfiguredCredentials(): void {
  processRegistry.refresh();
}

export function containsConfiguredCredential(text: string): boolean {
  return processRegistry.find(text) !== null;
}

/**
 * Whether a configured credential appears in the bytes as UTF-8 text, or as
 * UTF-16 text of either byte order at either alignment. A file stored as
 * UTF-16, or a binary that embeds UTF-16 text, hides a value from a screen
 * that reads only UTF-8 (#1807).
 */
export function containsConfiguredCredentialInBytes(bytes: Uint8Array): boolean {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (containsConfiguredCredential(buffer.toString("utf8"))) return true;
  for (const offset of [0, 1]) {
    const length = buffer.byteLength - offset;
    const aligned = buffer.subarray(offset, offset + length - (length % 2));
    if (aligned.byteLength === 0) continue;
    if (containsConfiguredCredential(aligned.toString("utf16le"))) return true;
    if (containsConfiguredCredential(Buffer.from(aligned).swap16().toString("utf16le"))) {
      return true;
    }
  }
  return false;
}

export function configuredCredentialInventory(): readonly ConfiguredCredentialInventoryEntry[] {
  return processRegistry.inventory();
}

/**
 * Every configured source with a value a matching minimum leaves uncompared,
 * for `docsfab doctor`: the credentials this environment names, the files it
 * names, and the values loaders registered in this process. Never a value or
 * its length.
 */
export function uncomparedConfiguredCredentials(
  environment: NodeJS.ProcessEnv = process.env,
): readonly UncomparedConfiguredCredential[] {
  return createConfiguredCredentialRegistry({
    environment: () => environment,
    sharedRegistrations: true,
    matchingDefaults: matchingDefaultsForHost,
  }).uncompared();
}
