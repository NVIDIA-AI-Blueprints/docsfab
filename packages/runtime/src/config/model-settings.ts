// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Model settings: the per-slot values an operator can set over a preset (an
 * installed composition) or a model profile, and where each effective value
 * came from.
 *
 * Precedence, highest first: `--set key=value` (CLI only), the environment
 * (the process environment, then secrets.env or a legacy .env), host.yaml
 * `active.<slot>.settings`, then the preset's or the profile file's value.
 * Every source is operator configuration. A value that differs from the preset
 * is labelled and warned about, never refused for differing.
 *
 * The loader writes the effective values into the slot's MODEL_* or JUDGE_*
 * variables and records each label in `DOCSFAB_SETTINGS_ORIGINS`. A later load
 * of the same configuration root, in this process or a child, reads a label
 * back only while the value's hash still matches, so a value DocsFab wrote is
 * never mistaken for one the operator exported.
 */
import { createHash } from "node:crypto";
import { findConfiguredCredential } from "../security/configured-credentials.js";
import { redactCredentialMaterial } from "../security/credential-material.js";
import { isAbsolute, relative } from "node:path";

import {
  InsecureModelEndpointError,
  isAdmittedModelEndpoint,
} from "../model/endpoint-transport.js";
import type { OperatorEndpointSource } from "../security/model-credential-release.js";
import type { DotenvAssignment } from "./dotenv.js";
import { assertCredentialEnvironmentName, parseProviderTransport } from "./model-providers.js";

/** The settings an operator can override on any preset or profile. */
export const MODEL_SETTING_KEYS = [
  "baseUrl",
  "modelId",
  "transport",
  "contextWindow",
  "maxInputTokens",
  "maxOutputTokens",
  "contextReserveTokens",
  "apiMinOutputTokens",
  "reasoning",
  "reasoningEffort",
  "credentialEnv",
] as const;

export type ModelSettingKey = (typeof MODEL_SETTING_KEYS)[number];
export type ModelSettingSlot = "writing" | "judge";
/** Every source is an operator source, so a model key may be released to its endpoint. */
export type ModelSettingSource = OperatorEndpointSource;
export type ModelSettingValue = string | number | boolean;
export type ModelSettingValues = Readonly<Partial<Record<ModelSettingKey, ModelSettingValue>>>;

export const MODEL_SETTINGS_ORIGINS_VARIABLE = "DOCSFAB_SETTINGS_ORIGINS";

const INTEGER_KEYS: ReadonlySet<ModelSettingKey> = new Set([
  "contextWindow",
  "maxInputTokens",
  "maxOutputTokens",
  "contextReserveTokens",
  "apiMinOutputTokens",
]);

const ENVIRONMENT_SUFFIX: Readonly<Record<ModelSettingKey, string>> = {
  baseUrl: "BASE_URL",
  modelId: "ID",
  transport: "TRANSPORT",
  contextWindow: "CONTEXT_WINDOW",
  maxInputTokens: "MAX_INPUT_TOKENS",
  maxOutputTokens: "MAX_OUTPUT_TOKENS",
  contextReserveTokens: "CONTEXT_RESERVE_TOKENS",
  apiMinOutputTokens: "API_MIN_OUTPUT_TOKENS",
  reasoning: "REASONING",
  reasoningEffort: "REASONING_EFFORT",
  credentialEnv: "CREDENTIAL_ENV",
};

/** Sources a later load keeps as they are; every other label is recomputed from its file. */
const KEPT_SOURCES: ReadonlySet<ModelSettingSource> = new Set(["environment", "cli-flag"]);
/** Sources that are a preset's or profile's own defaults, not an operator's setting. */
const PROFILE_SOURCES: ReadonlySet<ModelSettingSource> = new Set([
  "preset",
  "profile-file",
  "catalog",
]);

const SOURCES: ReadonlySet<string> = new Set<ModelSettingSource>([
  "preset",
  "host-config",
  "secrets-env",
  "legacy-env-file",
  "profile-file",
  "environment",
  "cli-flag",
  "catalog",
]);

/**
 * The reasoning effort names DocsFab sends: Pi's thinking levels other than
 * `off`. Set `reasoning: false` to turn reasoning off.
 */
export const REASONING_EFFORT_LEVELS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type ReasoningEffortLevel = (typeof REASONING_EFFORT_LEVELS)[number];

export function isReasoningEffortLevel(value: string): value is ReasoningEffortLevel {
  return (REASONING_EFFORT_LEVELS as readonly string[]).includes(value);
}

export function isModelSettingKey(value: string): value is ModelSettingKey {
  return (MODEL_SETTING_KEYS as readonly string[]).includes(value);
}

function slotPrefix(slot: ModelSettingSlot): "MODEL" | "JUDGE" {
  return slot === "writing" ? "MODEL" : "JUDGE";
}

/** The environment variable that carries one setting for one slot. */
export function modelSettingEnvName(slot: ModelSettingSlot, key: ModelSettingKey): string {
  if (key === "modelId") return slot === "writing" ? "MODEL_ID" : "JUDGE_MODEL_ID";
  return `${slotPrefix(slot)}_${ENVIRONMENT_SUFFIX[key]}`;
}

/** A setting value the named field cannot hold. */
export class ModelSettingValueError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = "ModelSettingValueError";
    this.field = field;
  }
}

/**
 * A model setting holds one of DocsFab's own configured credentials, such as
 * the model key given as the model id. The message names the slot, the
 * setting, its source, and where the credential is configured; never the value.
 */
export class ModelSettingCredentialError extends Error {
  readonly code = "credential-material" as const;
  readonly nextAction: string;

  constructor(input: {
    readonly slot: ModelSettingSlot;
    readonly key: ModelSettingKey;
    readonly from: string;
    readonly credential: string;
  }) {
    super(
      `The ${input.slot} model setting ${input.key} from ${input.from} holds one of DocsFab's own configured credentials (${input.credential}), so DocsFab stopped before recording or sending it.`,
    );
    this.name = "ModelSettingCredentialError";
    this.nextAction = `Set ${input.key} to its real value. A credential belongs only in its credential variable, such as MODEL_API_KEY.`;
  }
}

/**
 * Stop a load whose model setting holds one of DocsFab's own configured
 * credentials, on either slot and from any source, before any record,
 * summary, or request exists (#1807). It matches the configured credentials
 * the way the request screen does; a value that only looks like a credential
 * passes. Call it after the load registered the configuration's credentials.
 */
export function assertModelSettingsCredentialFree(environment: NodeJS.ProcessEnv): void {
  for (const slot of ["writing", "judge"] as const) {
    for (const key of MODEL_SETTING_KEYS) {
      const name = modelSettingEnvName(slot, key);
      const value = environment[name];
      if (value === undefined || value.trim() === "") continue;
      const match = findConfiguredCredential(value);
      if (match === null) continue;
      const entry = readModelSlotSettings(environment, slot)?.settings[key];
      throw new ModelSettingCredentialError({
        slot,
        key,
        from: entry ? describeSource(entry.source, entry.origin) : `the environment (${name})`,
        credential: match.source,
      });
    }
  }
}

/**
 * Parse one setting from a flag, host.yaml, or the environment. `field` names
 * where the value was written, for the refusal. A base URL must be HTTPS, or
 * plain HTTP to this machine, and carry no user name or password.
 */
export function parseModelSettingValue(
  key: ModelSettingKey,
  raw: unknown,
  field: string,
): ModelSettingValue {
  if (raw === undefined || raw === null) {
    throw new ModelSettingValueError(field, `${field} needs a value.`);
  }
  if (INTEGER_KEYS.has(key)) {
    const parsed = typeof raw === "number" ? raw : Number(String(raw).trim());
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      throw new ModelSettingValueError(field, `${field} must be a positive integer.`);
    }
    return parsed;
  }
  if (key === "reasoning") {
    if (typeof raw === "boolean") return raw;
    const text = String(raw).trim().toLowerCase();
    if (text === "true") return true;
    if (text === "false") return false;
    throw new ModelSettingValueError(field, `${field} must be true or false.`);
  }
  const text = String(raw).trim();
  if (!text) throw new ModelSettingValueError(field, `${field} must not be empty.`);
  switch (key) {
    case "baseUrl":
      return parseBaseUrl(text, field);
    case "modelId":
      if (/[\s\u0000-\u001f\u007f]/u.test(text)) {
        throw new ModelSettingValueError(field, `${field} must not contain spaces or controls.`);
      }
      return text;
    case "transport":
      try {
        return parseProviderTransport(text);
      } catch (error) {
        throw new ModelSettingValueError(field, `${field}: ${(error as Error).message}`);
      }
    case "reasoningEffort": {
      const level = text.toLowerCase();
      if (!isReasoningEffortLevel(level)) {
        throw new ModelSettingValueError(
          field,
          `${field} must be one of ${REASONING_EFFORT_LEVELS.join(", ")}; set reasoning to false to turn reasoning off.`,
        );
      }
      return level;
    }
    case "credentialEnv":
      try {
        assertCredentialEnvironmentName(text);
      } catch {
        throw new ModelSettingValueError(
          field,
          `${field} must name an upper-case environment variable, such as MODEL_API_KEY.`,
        );
      }
      return text;
    default:
      throw new ModelSettingValueError(field, `${field} is not a model setting.`);
  }
}

function parseBaseUrl(text: string, field: string): string {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new ModelSettingValueError(
      field,
      `${field} must be an absolute HTTPS URL, or plain HTTP to localhost, 127.0.0.1, or [::1].`,
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ModelSettingValueError(field, `${field} must use HTTPS.`);
  }
  const problem = modelEndpointShapeProblem(url);
  if (problem) throw new ModelSettingValueError(field, `${field} ${problem}.`);
  if (!isAdmittedModelEndpoint(url)) throw InsecureModelEndpointError.remoteHost(field);
  return text.replace(/\/+$/u, "");
}

/**
 * The one shape rule for a model endpoint at every entry: the environment,
 * a configuration file, host.yaml `settings.baseUrl`, and `--set baseUrl`.
 * A user name, password, query, or fragment never reaches a request, a
 * record, or doctor output. Undefined when the shape is plain.
 */
export function modelEndpointShapeProblem(url: URL): string | undefined {
  if (url.username !== "" || url.password !== "") {
    return "must not carry a user name or password; DocsFab sends the model key in a request header";
  }
  // `search` and `hash` read empty for a bare `?` or `#`; the URL text keeps it.
  if (url.search !== "" || url.href.includes("?")) return "must not carry a query string";
  if (url.hash !== "" || url.href.includes("#")) return "must not carry a fragment";
  return undefined;
}

/** The text a setting takes in its environment variable. */
export function modelSettingText(value: ModelSettingValue): string {
  return typeof value === "boolean" ? (value ? "true" : "false") : String(value);
}

function typedSettingValue(key: ModelSettingKey, text: string): ModelSettingValue {
  const trimmed = text.trim();
  if (INTEGER_KEYS.has(key)) {
    const parsed = Number(trimmed);
    return Number.isSafeInteger(parsed) ? parsed : trimmed;
  }
  if (key === "reasoning") {
    const lower = trimmed.toLowerCase();
    return lower === "true" ? true : lower === "false" ? false : trimmed;
  }
  if (key === "reasoningEffort") return trimmed.toLowerCase();
  return key === "baseUrl" ? trimmed.replace(/\/+$/u, "") : trimmed;
}

/** One effective setting: its value (null when unset), the source, and where. */
export interface ModelSettingEntry {
  readonly value: ModelSettingValue | null;
  readonly source: ModelSettingSource;
  /** The variable, file and line, flag, or preset that supplied the value. */
  readonly origin: string;
  /** The preset's own value, present only when the slot has a preset. */
  readonly presetValue?: ModelSettingValue | null;
}

/** A slot's effective model settings, as the run record keeps them. */
export interface ModelSlotSettingsV1 {
  readonly schemaVersion: 1;
  readonly slot: ModelSettingSlot;
  readonly presetId: string | null;
  readonly presetSource: ModelSettingSource | null;
  readonly settings: Readonly<Record<ModelSettingKey, ModelSettingEntry>>;
  /** Warnings: values that differ from the preset, a conflicting route, a dropped effort. */
  readonly notes: readonly string[];
}

interface SidecarKey {
  readonly source: ModelSettingSource;
  readonly origin: string;
  /** Hash of the value written; null when the loader left the variable unset. */
  readonly sha256: string | null;
  readonly preset?: string | null;
}

interface SidecarSlot {
  readonly presetId: string | null;
  readonly presetSource: ModelSettingSource | null;
  readonly notes: readonly string[];
}

interface Sidecar {
  readonly root: string;
  readonly keys: Readonly<Record<string, SidecarKey>>;
  readonly slots: Readonly<Partial<Record<ModelSettingSlot, SidecarSlot>>>;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Read the label sidecar; anything malformed or from another root reads as empty. */
function readSidecar(environment: NodeJS.ProcessEnv, root: string | undefined): Sidecar {
  const empty: Sidecar = { root: root ?? "", keys: {}, slots: {} };
  const raw = environment[MODEL_SETTINGS_ORIGINS_VARIABLE];
  if (!raw) return empty;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return empty;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return empty;
  const value = parsed as { root?: unknown; keys?: unknown; slots?: unknown };
  if (root !== undefined && value.root !== root) return empty;
  const keys: Record<string, SidecarKey> = {};
  if (value.keys && typeof value.keys === "object" && !Array.isArray(value.keys)) {
    for (const [name, entry] of Object.entries(value.keys as Record<string, unknown>)) {
      const key = entry as Partial<SidecarKey> | null;
      if (
        !key ||
        typeof key !== "object" ||
        typeof key.source !== "string" ||
        !SOURCES.has(key.source) ||
        typeof key.origin !== "string" ||
        (key.sha256 !== null && typeof key.sha256 !== "string")
      ) {
        continue;
      }
      keys[name] = {
        source: key.source,
        origin: key.origin,
        sha256: key.sha256,
        ...(key.preset === null || typeof key.preset === "string" ? { preset: key.preset } : {}),
      };
    }
  }
  const slots: Partial<Record<ModelSettingSlot, SidecarSlot>> = {};
  if (value.slots && typeof value.slots === "object" && !Array.isArray(value.slots)) {
    for (const slot of ["writing", "judge"] as const) {
      const entry = (value.slots as Record<string, unknown>)[slot] as Partial<SidecarSlot> | null;
      if (!entry || typeof entry !== "object") continue;
      slots[slot] = {
        presetId: typeof entry.presetId === "string" ? entry.presetId : null,
        presetSource:
          typeof entry.presetSource === "string" && SOURCES.has(entry.presetSource)
            ? entry.presetSource
            : null,
        notes: Array.isArray(entry.notes)
          ? entry.notes.filter((note): note is string => typeof note === "string")
          : [],
      };
    }
  }
  return {
    root: typeof value.root === "string" ? value.root : "",
    keys,
    slots,
  };
}

function writeSidecar(environment: NodeJS.ProcessEnv, sidecar: Sidecar): void {
  environment[MODEL_SETTINGS_ORIGINS_VARIABLE] = JSON.stringify(sidecar);
}

/** The preset or profile file a slot starts from. */
export interface ModelSlotBase {
  readonly kind: "preset" | "profile-file";
  /** The preset id, or the profile file path. */
  readonly id: string;
  /** Where the preset was selected; for a profile file, `profile-file`. */
  readonly source: ModelSettingSource;
  /** Every variable the preset or profile projects for this slot. */
  readonly assignments: ReadonlyMap<string, string>;
}

/** A dotenv file whose values sit just below the process environment. */
export interface ModelSlotFileLayer {
  readonly source: "secrets-env" | "legacy-env-file";
  readonly path: string;
  readonly assignments: ReadonlyMap<string, DotenvAssignment>;
}

export interface ApplyModelSlotSettingsInput {
  readonly target: NodeJS.ProcessEnv;
  readonly slot: ModelSettingSlot;
  /** The configuration root the labels belong to. */
  readonly root: string;
  /** The preset or profile; absent when the slot is configured only by variables. */
  readonly base?: ModelSlotBase;
  readonly hostSettings?: {
    readonly path: string;
    readonly values: ModelSettingValues;
  };
  readonly files?: readonly ModelSlotFileLayer[];
  readonly cli?: ModelSettingValues;
}

interface Candidate {
  readonly value: string;
  readonly source: ModelSettingSource;
  readonly origin: string;
}

const API_FORMAT_FOR_TRANSPORT: Readonly<Record<string, string>> = {
  "openai-chat-completions": "chat_completions",
  "openai-responses": "chat_completions",
  "anthropic-messages": "messages",
};

/**
 * Resolve one slot's settings and write them, with their labels, into
 * `target`. Other profile fields come from the preset or profile as before,
 * except the API format, which follows the effective transport. A preset's
 * route stays the preset's own: a conflicting `MODEL_PROVIDER` is recorded and
 * warned about.
 */
export function applyModelSlotSettings(input: ApplyModelSlotSettingsInput): void {
  const { target, slot, base } = input;
  const prefix = slotPrefix(slot);
  // Any earlier load's labels tell a value DocsFab wrote from one the operator
  // exported, whichever root it loaded; only this root's labels carry forward.
  const previous = readSidecar(target, undefined);
  const sidecar: Sidecar =
    previous.root === input.root ? previous : { root: input.root, keys: {}, slots: {} };
  const keys: Record<string, SidecarKey> = { ...sidecar.keys };
  const notes: string[] = [];
  const preset = base?.kind === "preset" ? base : undefined;
  // Origins name configuration files relative to the root, never the host path above it.
  const baseOrigin = base
    ? base.kind === "profile-file"
      ? rootRelative(input.root, base.id)
      : base.id
    : undefined;

  const fromEnvironment = (name: string): Candidate | undefined => {
    const value = target[name];
    if (value === undefined) return undefined;
    const entry = previous.keys[name];
    if (entry && entry.sha256 !== null && entry.sha256 === digest(value)) {
      return KEPT_SOURCES.has(entry.source)
        ? { value, source: entry.source, origin: entry.origin }
        : undefined;
    }
    return { value, source: "environment", origin: name };
  };
  const fromFiles = (name: string): Candidate | undefined => {
    for (const layer of input.files ?? []) {
      const assignment = layer.assignments.get(name);
      if (assignment !== undefined) {
        return {
          value: assignment.value,
          source: layer.source,
          origin: `${rootRelative(input.root, layer.path)}:${String(assignment.line)}`,
        };
      }
    }
    return undefined;
  };

  if (base) {
    for (const [name, value] of base.assignments) {
      if (SETTING_NAMES[slot].has(name)) continue;
      if (preset && name === `${prefix}_PROVIDER`) {
        const configured = fromEnvironment(name) ?? fromFiles(name);
        if (configured && configured.value.trim() && configured.value.trim() !== value) {
          notes.push(
            `${name}=${configured.value.trim()} from ${describeSource(configured.source, configured.origin)} names another route; preset ${preset.id} runs on its own route ${value}. Select a preset for that route to change it.`,
          );
        }
      }
      target[name] = value;
      keys[name] = {
        source: baseSource(base),
        origin: baseOrigin!,
        sha256: digest(value),
      };
    }
  }

  let transportOverridden = false;
  let chosenAny = false;
  for (const key of MODEL_SETTING_KEYS) {
    const name = modelSettingEnvName(slot, key);
    const baseValue = base?.assignments.get(name);
    const cliValue = input.cli?.[key];
    const hostValue = input.hostSettings?.values[key];
    const chosen: Candidate | undefined =
      (cliValue !== undefined
        ? {
            value: modelSettingText(cliValue),
            source: "cli-flag",
            origin: `--set ${slot === "judge" ? "judge." : ""}${key}`,
          }
        : undefined) ??
      fromEnvironment(name) ??
      fromFiles(name) ??
      (hostValue !== undefined
        ? {
            value: modelSettingText(hostValue),
            source: "host-config",
            origin: `${rootRelative(input.root, input.hostSettings!.path)} active.${slot}.settings.${key}`,
          }
        : undefined) ??
      (baseValue !== undefined && base
        ? { value: baseValue, source: baseSource(base), origin: baseOrigin! }
        : undefined);
    const presetField = preset ? { preset: baseValue ?? null } : {};
    // A host.yaml setting a higher layer overrides is named, never ignored silently.
    if (
      hostValue !== undefined &&
      chosen !== undefined &&
      chosen.source !== "host-config" &&
      !sameSettingValue(typedSettingValue(key, chosen.value), hostValue)
    ) {
      notes.push(
        `${slot === "judge" ? "judge." : ""}${key} = ${displaySettingValue(key, hostValue)} in host.yaml active.${slot}.settings is overridden by ${describeSource(chosen.source, chosen.origin)}.`,
      );
    }
    if (chosen === undefined) {
      delete target[name];
      if (base) {
        keys[name] = {
          source: baseSource(base),
          origin: baseOrigin!,
          sha256: null,
          ...presetField,
        };
      } else {
        delete keys[name];
      }
      continue;
    }
    // Without a preset or profile, the variables are the profile: only a flag
    // changes its transport.
    if (key === "transport") {
      transportOverridden = base
        ? chosen.source !== baseSource(base) && chosen.value.trim() !== (baseValue ?? "")
        : chosen.source === "cli-flag";
    }
    chosenAny = true;
    target[name] = chosen.value;
    keys[name] = {
      source: chosen.source,
      origin: chosen.origin,
      sha256: digest(chosen.value),
      ...presetField,
    };
  }
  // A slot set by nothing but absent variables records nothing.
  if (!base && !chosenAny && sidecar.slots[slot] === undefined) return;
  if (base) fitBaseWindowsToOperatorWindow(target, slot, base, keys);

  // An operator's reasoning: false wins over reasoning-effort support that the
  // preset, profile, or file declares: that support is bound off and named,
  // so the profile stays valid instead of refusing the operator's value.
  const reasoningName = modelSettingEnvName(slot, "reasoning");
  const reasoningLabel = keys[reasoningName];
  const supportsName = `${prefix}_SUPPORTS_REASONING_EFFORT`;
  const supportsBoundOff =
    sidecar.keys[supportsName]?.sha256 === digest("false") && target[supportsName] === "false";
  const supportsDeclared =
    (target[supportsName] ?? fromFiles(supportsName)?.value)?.trim().toLowerCase() === "true";
  if (
    reasoningLabel !== undefined &&
    !PROFILE_SOURCES.has(reasoningLabel.source) &&
    target[reasoningName]?.trim().toLowerCase() === "false" &&
    (supportsDeclared || supportsBoundOff)
  ) {
    target[supportsName] = "false";
    keys[supportsName] = {
      source: reasoningLabel.source,
      origin: reasoningLabel.origin,
      sha256: digest("false"),
    };
    notes.push(
      `${slot === "judge" ? "judge." : ""}reasoning = false from ${describeSource(reasoningLabel.source, reasoningLabel.origin)} also turns off the reasoning-effort support that ${supportsName} declares.`,
    );
  }

  const transport = target[modelSettingEnvName(slot, "transport")]?.trim();
  const apiFormat = transport ? API_FORMAT_FOR_TRANSPORT[transport] : undefined;
  if (apiFormat && (preset || transportOverridden)) {
    for (const name of [`${prefix}_API_FORMAT`, `${prefix}_COMPATIBLE_API_FORMATS`]) {
      target[name] = apiFormat;
      keys[name] = {
        source: base ? baseSource(base) : "cli-flag",
        origin: baseOrigin ?? `--set ${slot === "judge" ? "judge." : ""}transport`,
        sha256: digest(apiFormat),
      };
    }
  }

  const marker =
    slot === "writing"
      ? "DOCSFAB_ACTIVE_EXECUTION_PROFILE"
      : "DOCSFAB_ACTIVE_JUDGE_EXECUTION_PROFILE";
  if (preset) target[marker] = preset.id;
  else if (base) delete target[marker];

  writeSidecar(target, {
    root: input.root,
    keys,
    slots: {
      ...sidecar.slots,
      [slot]: {
        presetId: preset?.id ?? null,
        presetSource: preset?.source ?? null,
        notes,
      },
    },
  });
}

/** A configuration file inside the root, named relative to it; any other path as given. */
function rootRelative(root: string, path: string): string {
  const inside = relative(root, path);
  return inside !== "" && !inside.startsWith("..") && !isAbsolute(inside) ? inside : path;
}

/**
 * When an operator sets the context window, a preset or profile input or
 * output default larger than it follows that window, so the operator's value
 * never turns the preset's defaults into an invalid profile.
 */
function fitBaseWindowsToOperatorWindow(
  target: NodeJS.ProcessEnv,
  slot: ModelSettingSlot,
  base: ModelSlotBase,
  keys: Record<string, SidecarKey>,
): void {
  const windowName = modelSettingEnvName(slot, "contextWindow");
  const windowEntry = keys[windowName];
  const window = Number(target[windowName]);
  if (!windowEntry || windowEntry.source === baseSource(base) || !Number.isSafeInteger(window)) {
    return;
  }
  for (const key of ["maxInputTokens", "maxOutputTokens"] as const) {
    const name = modelSettingEnvName(slot, key);
    const entry = keys[name];
    const value = Number(target[name]);
    if (!entry || entry.source !== baseSource(base) || !(value > window)) continue;
    const text = String(window);
    target[name] = text;
    keys[name] = {
      source: windowEntry.source,
      origin: windowEntry.origin,
      sha256: digest(text),
      ...(entry.preset !== undefined ? { preset: entry.preset } : {}),
    };
  }
}

function baseSource(base: ModelSlotBase): ModelSettingSource {
  return base.kind === "preset" ? "preset" : "profile-file";
}

const SETTING_NAMES: Readonly<Record<ModelSettingSlot, ReadonlySet<string>>> = {
  writing: new Set(MODEL_SETTING_KEYS.map((key) => modelSettingEnvName("writing", key))),
  judge: new Set(MODEL_SETTING_KEYS.map((key) => modelSettingEnvName("judge", key))),
};

/**
 * The slot's effective settings, read back from its variables and labels. A
 * value without a matching label is the environment's. Labels written for
 * another configuration root are ignored when `root` is known. Returns
 * undefined when the slot was never resolved and holds no setting at all.
 */
export function readModelSlotSettings(
  environment: NodeJS.ProcessEnv,
  slot: ModelSettingSlot,
  root?: string,
): ModelSlotSettingsV1 | undefined {
  const sidecar = readSidecar(environment, root);
  const slotInfo = sidecar.slots[slot];
  const presetId = slotInfo?.presetId ?? null;
  const settings = {} as Record<ModelSettingKey, ModelSettingEntry>;
  let anyValue = false;
  for (const key of MODEL_SETTING_KEYS) {
    const name = modelSettingEnvName(slot, key);
    const value = environment[name];
    const entry = sidecar.keys[name];
    const presetValue =
      presetId !== null && entry && "preset" in entry
        ? {
            presetValue:
              entry.preset === null || entry.preset === undefined
                ? null
                : typedSettingValue(key, entry.preset),
          }
        : {};
    if (value !== undefined && value.trim() !== "") {
      anyValue = true;
      const labelled = entry && entry.sha256 !== null && entry.sha256 === digest(value);
      settings[key] = {
        value: typedSettingValue(key, value),
        source: labelled ? entry.source : "environment",
        origin: labelled ? entry.origin : name,
        ...presetValue,
      };
      continue;
    }
    settings[key] = {
      value: null,
      source:
        entry && entry.sha256 === null
          ? entry.source
          : presetId !== null
            ? "preset"
            : "environment",
      origin: entry && entry.sha256 === null ? entry.origin : (presetId ?? name),
      ...presetValue,
    };
  }
  if (!slotInfo && !anyValue) return undefined;
  // An effort turns reasoning on unless reasoning is explicitly false: the
  // record shows the value the run uses and the setting that decided it.
  const effort = settings.reasoningEffort;
  const reasoning = settings.reasoning;
  if (
    typeof effort.value === "string" &&
    effort.value !== "" &&
    reasoning.value !== true &&
    !(isOperatorOverride(reasoning) && reasoning.value === false)
  ) {
    settings.reasoning = {
      value: true,
      source: effort.source,
      origin: `${effort.origin}, as reasoningEffort turns reasoning on`,
      ...(reasoning.presetValue !== undefined ? { presetValue: reasoning.presetValue } : {}),
    };
  }
  const record: Omit<ModelSlotSettingsV1, "notes"> = {
    schemaVersion: 1,
    slot,
    presetId,
    presetSource: slotInfo?.presetSource ?? null,
    settings,
  };
  return {
    ...record,
    // A note names a setting's value. Screened here, after the load registered
    // every configured credential, credential material in it never reaches a
    // warning or a record, whichever path records this slot.
    notes: [...(slotInfo?.notes ?? []), ...modelSettingsDriftNotes(record)].map(
      redactCredentialMaterial,
    ),
  };
}

/** One warning per setting whose value differs from the preset's. */
export function modelSettingsDriftNotes(record: Omit<ModelSlotSettingsV1, "notes">): string[] {
  if (record.presetId === null) return [];
  const notes: string[] = [];
  for (const key of MODEL_SETTING_KEYS) {
    const entry = record.settings[key];
    if (entry.source === "preset" || entry.presetValue === undefined) continue;
    if (sameSettingValue(entry.value, entry.presetValue)) continue;
    notes.push(
      `${record.slot === "judge" ? "judge." : ""}${key} = ${displaySettingValue(key, entry.value)} from ${describeSource(entry.source, entry.origin)} differs from preset ${record.presetId} (${displaySettingValue(key, entry.presetValue)}).`,
    );
  }
  const effort = reasoningEffortDecision(record);
  if (effort.dropped) {
    notes.push(
      `${record.slot === "judge" ? "judge." : ""}reasoningEffort = ${String(record.settings.reasoningEffort.value)} is not sent: reasoning is set to false (${describeSource(record.settings.reasoning.source, record.settings.reasoning.origin)}), so thinking stays off.`,
    );
  }
  return notes;
}

function sameSettingValue(
  left: ModelSettingValue | null | undefined,
  right: ModelSettingValue | null | undefined,
): boolean {
  if (left === null || left === undefined) return right === null || right === undefined;
  if (right === null || right === undefined) return false;
  return modelSettingText(left) === modelSettingText(right);
}

/**
 * Whether reasoning is on and which effort, if any, the request sends. A
 * reasoning effort implies reasoning unless an operator source sets reasoning
 * to false, in which case thinking stays off and the effort is dropped.
 */
export function reasoningEffortDecision(record: Pick<ModelSlotSettingsV1, "settings">): {
  readonly reasoning?: boolean;
  readonly effort?: string;
  readonly dropped: boolean;
} {
  const effort = record.settings.reasoningEffort.value;
  const reasoning = record.settings.reasoning;
  // Only an operator's `reasoning: false` drops an effort; a preset's or a
  // profile file's is a default the effort overrides.
  const explicit = isOperatorOverride(reasoning) && typeof reasoning.value === "boolean";
  if (typeof effort === "string" && effort) {
    if (explicit && reasoning.value === false) return { reasoning: false, dropped: true };
    return { reasoning: true, effort, dropped: false };
  }
  return {
    ...(typeof reasoning.value === "boolean" ? { reasoning: reasoning.value } : {}),
    dropped: false,
  };
}

/**
 * Whether an operator source set any key to a value that differs from the
 * preset's: the run is then not the preset's own.
 */
export function hasOperatorDifference(record: Pick<ModelSlotSettingsV1, "settings">): boolean {
  return MODEL_SETTING_KEYS.some((key) => {
    const entry = record.settings[key];
    return (
      isOperatorOverride(entry) &&
      entry.presetValue !== undefined &&
      !sameSettingValue(entry.value, entry.presetValue)
    );
  });
}

/**
 * The `--composition` preset and `--set` pairs a command line gave a run, so a
 * resume command repeats them and binds what the stopped run bound. A shown
 * next step names the endpoint with a placeholder, since status output shows
 * an endpoint's host only; `exactEndpoint` keeps the recorded endpoint for
 * the exact command `docsfab runs` projects.
 */
export function commandLineSettings(
  record: ModelSlotSettingsV1 | undefined,
  options: { readonly exactEndpoint?: boolean } = {},
): {
  readonly compositionId?: string;
  readonly sets: readonly string[];
} {
  if (!record) return { sets: [] };
  const sets = MODEL_SETTING_KEYS.flatMap((key) => {
    const entry = record.settings[key];
    if (entry.source !== "cli-flag" || entry.origin !== `--set ${key}` || entry.value === null) {
      return [];
    }
    return [
      key === "baseUrl" && options.exactEndpoint !== true
        ? "baseUrl=<the endpoint the stopped run used>"
        : `${key}=${modelSettingText(entry.value)}`,
    ];
  });
  return {
    ...(record.presetSource === "cli-flag" && record.presetId !== null
      ? { compositionId: record.presetId }
      : {}),
    sets,
  };
}

/** Whether an operator source, not the preset or a profile file, set this key. */
export function isOperatorOverride(entry: ModelSettingEntry | undefined): boolean {
  return entry !== undefined && !PROFILE_SOURCES.has(entry.source);
}

/** An endpoint as operator output shows it: the scheme and host only, never the path. */
export function endpointOriginDisplay(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`;
  } catch {
    return "(not a URL)";
  }
}

export function displaySettingValue(
  key: ModelSettingKey,
  value: ModelSettingValue | null | undefined,
): string {
  if (value === null || value === undefined) return "not set";
  if (key === "baseUrl") return endpointOriginDisplay(String(value));
  return modelSettingText(value);
}

const SOURCE_WORDS: Readonly<Record<ModelSettingSource, string>> = {
  "cli-flag": "the command line",
  environment: "the environment",
  "secrets-env": "secrets.env",
  "legacy-env-file": "the configuration .env",
  "host-config": "host.yaml",
  "profile-file": "the model profile",
  preset: "the preset",
  catalog: "the limits catalog",
};

export function describeSource(source: ModelSettingSource, origin: string): string {
  const words = SOURCE_WORDS[source];
  // An origin that already names its file, such as `host.yaml active.…`, stands alone.
  return origin.startsWith(words) ? origin : `${words} (${origin})`;
}

/**
 * Operator lines for one slot: the preset, each setting with its source, and
 * the warnings. The endpoint shows its scheme and host only.
 */
export function formatModelSlotSettingsLines(record: ModelSlotSettingsV1, indent = "  "): string[] {
  const lines = [
    `${indent}Preset: ${record.presetId ?? "none (model profile)"}${record.presetSource ? ` (selected in ${SOURCE_WORDS[record.presetSource]})` : ""}`,
  ];
  for (const key of MODEL_SETTING_KEYS) {
    const entry = record.settings[key];
    const preset =
      entry.presetValue !== undefined &&
      entry.source !== "preset" &&
      !sameSettingValue(entry.value, entry.presetValue)
        ? `; preset ${displaySettingValue(key, entry.presetValue)}`
        : "";
    lines.push(
      `${indent}  ${key}: ${displaySettingValue(key, entry.value)} (${describeSource(entry.source, entry.origin)}${preset})`,
    );
  }
  for (const note of record.notes) lines.push(`${indent}Warning: ${note}`);
  // A shown value never carries credential material, whatever key holds it.
  return lines.map(redactCredentialMaterial);
}
