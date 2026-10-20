// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { constants as fsConstants, type BigIntStats } from "node:fs";
import { access, lstat, open, readFile, realpath, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";

import {
  presetSlotAssignments,
  selectPurposeCompositionId,
} from "../../config/execution-profile.js";
import { resolveDocsFabProjectRoot } from "../../config/host-paths.js";
import {
  decodeHostConfig,
  decodeModelProfile,
  resolveHostJudgeSlot,
  resolveHostWritingSlot,
  resolveHostYamlJudgeProfile,
  resolveHostYamlPolicyProfile,
  SECRET_ENV_KEYS,
  type DocsFabHostConfigV1,
  type HostPurposeSlotV1,
} from "../../config/profile-projection.js";
import { resolveProfilePath, resolveProfilesDirectory } from "../../config/split-layout.js";
import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../../json-evidence.js";
import {
  presentInspection,
  type PresentationDocument,
  type PresentationField,
} from "../../operator/index.js";
import { renderCliPresentation } from "../presentation.js";

export interface ConfigInspectArguments {
  readonly json: boolean;
}

export type ConfigPathStatus = "ready" | "missing" | "unreadable" | "unwritable" | "invalid";

export interface ConfigPathInspection {
  readonly id: string;
  readonly role: string;
  readonly path: string;
  readonly source: string;
  readonly provenance: string;
  readonly precedence: number;
  readonly required: boolean;
  readonly exists: boolean;
  readonly readable: boolean;
  readonly writable: boolean;
  readonly status: ConfigPathStatus;
  readonly nextCommand: string;
}

export interface ConfigProfileSelectionInspection {
  readonly slot: "policy" | "judge";
  readonly kind: "installed-composition";
  readonly source: string;
  readonly provenance: string;
  readonly status: "ready" | "invalid" | "inactive";
  readonly compositionId?: string;
  readonly presetModelId?: string;
  readonly modelSource?: "installed composition preset";
  readonly policySource?: "installed composition preset";
  readonly nextCommand: string;
}

export interface ConfigInspectionReport {
  readonly schemaVersion: 1;
  readonly kind: "docsfab-config-inspection";
  readonly providerCalls: "not-run";
  readonly scmCalls: "not-run";
  readonly profileReadiness: "selection-only; endpoint and credentials not checked";
  readonly profileSelections: readonly ConfigProfileSelectionInspection[];
  readonly paths: readonly ConfigPathInspection[];
  readonly nextSteps: readonly string[];
}

interface InspectOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly homeDirectory?: string;
}

interface PathSelection {
  readonly path: string;
  readonly source: string;
  readonly provenance: string;
  readonly precedence: number;
  readonly invalid?: boolean;
}

interface ProbeOptions {
  readonly id: string;
  readonly role: string;
  readonly selection: PathSelection;
  readonly kind: "file" | "directory";
  readonly required?: boolean;
  readonly nextCommand: string;
}

const MAX_HOST_CONFIG_BYTES = 64 * 1024;

/**
 * Inspect host paths and non-secret profile selections without reading secret files.
 * This function performs no writes and makes no provider, SCM, or network call.
 */
export async function inspectEffectiveConfiguration(
  options: InspectOptions = {},
): Promise<ConfigInspectionReport> {
  const environment = options.environment ?? process.env;
  const homeDirectory = options.homeDirectory ?? homedir();
  let configuration = selectConfigurationRoot(environment, homeDirectory);
  let configurationRootNextCommand = "docsfab setup";
  if (!configuration.invalid && (await isNonCanonicalRoot(configuration.path))) {
    configuration = { ...configuration, invalid: true };
    configurationRootNextCommand =
      "Set DOCSFAB_CONFIG_ROOT to its resolved canonical directory path, then rerun docsfab config inspect. For an existing root, run cd <configuration-root> && pwd -P to find that path.";
  }
  const paths: ConfigPathInspection[] = [];

  paths.push(
    await probePath({
      id: "configuration-root",
      role: "writable host configuration root",
      selection: configuration,
      kind: "directory",
      nextCommand: configurationRootNextCommand,
    }),
  );

  const hostConfigSelection: PathSelection = {
    path: join(configuration.path, "host.yaml"),
    source: "derived from configuration root",
    provenance: "host.yaml is the non-secret host layout manifest",
    precedence: 4,
    ...(configuration.invalid ? { invalid: true } : {}),
  };
  const hostConfig = configuration.invalid
    ? undefined
    : await readHostConfig(hostConfigSelection.path);
  let hostStatus = await probePath({
    id: "host-config",
    role: "host layout manifest",
    selection: hostConfigSelection,
    kind: "file",
    nextCommand: "docsfab setup",
  });
  if (!hostConfig && hostStatus.status === "ready") {
    hostStatus = { ...hostStatus, status: "invalid", nextCommand: "docsfab setup" };
  }
  paths.push(hostStatus);

  const writingSlot = hostConfig ? resolveHostWritingSlot(hostConfig) : undefined;
  const judgeSlot = hostConfig ? resolveHostJudgeSlot(hostConfig) : undefined;
  const profileSelections: ConfigProfileSelectionInspection[] = [];
  for (const [slot, selected] of [
    ["policy", writingSlot],
    ["judge", judgeSlot],
  ] as const) {
    if (selected?.compositionId) {
      profileSelections.push(inspectCompositionSelection(slot, selected));
    }
  }
  const policyProfile = writingSlot?.compositionId
    ? undefined
    : activeProfilePath(configuration.path, hostConfig, "policy");
  const judgeProfile = judgeSlot?.compositionId
    ? undefined
    : activeProfilePath(configuration.path, hostConfig, "judge");
  const profilesRequired = !hostConfig || Boolean(policyProfile || judgeProfile);
  const profilesSelection: PathSelection = {
    path: resolveProfilesDirectory(configuration.path),
    source: "derived from configuration root",
    provenance: profilesRequired
      ? "split-layout model profiles directory"
      : "optional legacy YAML profiles directory; installed compositions do not require it",
    precedence: 4,
    ...(configuration.invalid ? { invalid: true } : {}),
  };
  paths.push(
    await probePath({
      id: "profiles",
      role: "model profile directory",
      selection: profilesSelection,
      kind: "directory",
      required: profilesRequired,
      nextCommand: "docsfab setup",
    }),
  );

  const hostPaths = hostConfig?.paths;
  if (!writingSlot?.compositionId) {
    paths.push(
      await inspectYamlProfile(
        {
          id: "policy-profile",
          role: "active policy profile",
          selection: policyProfile ?? {
            path: profilesSelection.path,
            source: "host.yaml activePolicyProfile",
            provenance: "active policy profile is unavailable until host.yaml is valid",
            precedence: 2,
            invalid: true,
          },
          kind: "file",
          nextCommand: "docsfab setup",
        },
        "policy",
        configuration.path,
      ),
    );
  }
  if (judgeProfile) {
    paths.push(
      await inspectYamlProfile(
        {
          id: "judge-profile",
          role: "active judge profile",
          selection: judgeProfile,
          kind: "file",
          nextCommand: "docsfab setup",
        },
        "judge",
        configuration.path,
      ),
    );
  }

  const projectRoot = resolveDocsFabProjectRoot();
  const skillCrate = selectPath(
    environment.DOCSFAB_SKILL_CRATE_DIR,
    hostPaths?.skillCrateDir,
    resolve(projectRoot, "skill-crate"),
    "DOCSFAB_SKILL_CRATE_DIR",
    "host.yaml paths.skillCrateDir",
    "packaged runtime default",
    configuration.path,
  );
  const quality = selectPath(
    environment.DOCSFAB_QUALITY_DIR,
    hostPaths?.qualityDir,
    resolve(projectRoot, "quality"),
    "DOCSFAB_QUALITY_DIR",
    "host.yaml paths.qualityDir",
    "packaged runtime default",
    configuration.path,
  );
  const qualityPack = selectPath(
    environment.DOCSFAB_QUALITY_PACK_DIR,
    hostPaths?.qualityPackDir,
    resolve(projectRoot, "quality-pack"),
    "DOCSFAB_QUALITY_PACK_DIR",
    "host.yaml paths.qualityPackDir",
    "packaged runtime default",
    configuration.path,
  );
  for (const [id, role, selection] of [
    ["skill-crate", "installed catalog skill crate", skillCrate],
    ["quality", "portable quality policy", quality],
    ["quality-pack", "locked quality pack", qualityPack],
  ] as const) {
    paths.push(
      await probePath({
        id,
        role,
        selection,
        kind: "directory",
        nextCommand: "docsfab doctor",
      }),
    );
  }

  let state = selectPath(
    environment.DOCSFAB_STATE_DIR,
    hostPaths?.stateDir,
    resolve(configuration.path, ".docsfab", "runs"),
    "DOCSFAB_STATE_DIR",
    "host.yaml paths.stateDir",
    "default configuration state",
    configuration.path,
  );
  if (
    configuration.invalid &&
    environment.DOCSFAB_STATE_DIR === undefined &&
    !hostPaths?.stateDir
  ) {
    state = { ...state, invalid: true };
  }
  const stateInspection = await probePath({
    id: "state",
    role: "effective state directory",
    selection: state,
    kind: "directory",
    nextCommand: "docsfab setup",
  });
  paths.push(stateInspection);
  paths.push(
    await probePath({
      id: "run-records",
      role: "saved run records",
      selection: derivedSelection(state.path, "state/run records", state.invalid),
      kind: "directory",
      nextCommand: "docsfab setup",
    }),
  );
  const stateRoot = dirname(state.path);
  paths.push(
    await probePath({
      id: "receipts",
      role: "private operation receipts",
      selection: derivedSelection(
        resolve(stateRoot, "receipts"),
        "state root/receipts",
        state.invalid,
      ),
      kind: "directory",
      nextCommand: "docsfab setup",
    }),
    await probePath({
      id: "reports",
      role: "hosted review reports",
      selection: derivedSelection(resolve(state.path, "reports"), "state/reports", state.invalid),
      kind: "directory",
      nextCommand: "docsfab setup",
    }),
    await probePath({
      id: "logs",
      role: "runtime logs",
      selection: derivedSelection(resolve(stateRoot, "logs"), "state root/logs", state.invalid),
      kind: "directory",
      nextCommand: "docsfab setup",
    }),
    await probePath({
      id: "live-agent-sessions",
      role: "persistent live-agent sessions",
      selection: derivedSelection(
        resolve(configuration.path, ".docsfab", "live-agent", "sessions"),
        "configuration root/.docsfab/live-agent/sessions",
        configuration.invalid,
      ),
      kind: "directory",
      nextCommand: "docsfab setup",
    }),
  );

  const nextSteps = nextStepsFor(paths, profileSelections);
  return {
    schemaVersion: 1,
    kind: "docsfab-config-inspection",
    providerCalls: "not-run",
    scmCalls: "not-run",
    profileReadiness: "selection-only; endpoint and credentials not checked",
    profileSelections,
    paths,
    nextSteps,
  };
}

class ConfigUsageError extends Error {
  readonly code = "cli-usage";
  readonly nextAction = "Run `docsfab config --help` for the accepted forms.";

  constructor(message: string) {
    super(message);
    this.name = "ConfigUsageError";
  }
}

export function parseConfigInspectArguments(args: string[]): ConfigInspectArguments {
  const seen = new Set<string>();
  for (const argument of args) {
    if (argument !== "inspect" && argument !== "--json") {
      throw new ConfigUsageError(`Unknown config inspect option "${argument}" is not supported.`);
    }
    if (seen.has(argument)) {
      throw new ConfigUsageError(`Config inspect option "${argument}" must not be duplicated.`);
    }
    seen.add(argument);
  }
  if (!seen.has("inspect")) {
    throw new ConfigUsageError('The docsfab config command requires the "inspect" subcommand.');
  }
  return { json: seen.has("--json") };
}

export async function handleConfigCommand(args: string[]): Promise<void> {
  const parsed = parseConfigInspectArguments(args);
  const report = await inspectEffectiveConfiguration();
  const output = parsed.json
    ? canonicalizeJsonEvidence(report as unknown as JsonEvidenceValue).trimEnd()
    : formatConfigInspection(report);
  assertNoSecretValues(output, process.env);
  console.log(output);
}

export function formatConfigInspection(report: ConfigInspectionReport): string {
  return renderCliPresentation(projectConfigInspection(report)).stdout.trimEnd();
}

export function projectConfigInspection(report: ConfigInspectionReport): PresentationDocument {
  const findings: PresentationField[] = [
    { label: "Provider calls", evidence: { state: "known", value: report.providerCalls } },
    { label: "SCM calls", evidence: { state: "known", value: report.scmCalls } },
    { label: "Profile readiness", evidence: { state: "known", value: report.profileReadiness } },
    ...report.profileSelections.map((selection) => ({
      label: `active ${selection.slot} profile`,
      evidence: {
        state: "known" as const,
        value: [
          selection.compositionId ?? "unresolved installed composition",
          `source=${selection.source}`,
          `provenance=${selection.provenance}`,
          `status=${selection.status}`,
          ...(selection.presetModelId ? [`preset model=${selection.presetModelId}`] : []),
          ...(selection.modelSource ? [`preset model source=${selection.modelSource}`] : []),
          ...(selection.policySource ? [`preset policy source=${selection.policySource}`] : []),
          `next=${selection.nextCommand}`,
        ].join("; "),
      },
      ...(selection.status === "invalid" ? { importance: "material" as const } : {}),
    })),
    ...report.paths.map((path) => ({
      label: path.role,
      evidence: {
        state: "known" as const,
        value: [
          path.path,
          `source=${path.source}`,
          `provenance=${path.provenance}`,
          `precedence=${path.precedence}`,
          `status=${path.status}`,
          `required=${path.required ? "yes" : "no"}`,
          `exists=${path.exists ? "yes" : "no"}`,
          `readable=${path.readable ? "yes" : "no"}`,
          `writable=${path.writable ? "yes" : "no"}`,
          `next=${path.nextCommand}`,
        ].join("; "),
      },
      ...(path.status === "ready" || !path.required ? {} : { importance: "material" as const }),
    })),
  ];
  return presentInspection({
    title: "Effective configuration",
    subject: { state: "known", value: "Host paths and their effective sources" },
    findings,
    attention:
      report.paths.some((path) => path.required && path.status !== "ready") ||
      report.profileSelections.some((selection) => selection.status === "invalid")
        ? { message: "One or more effective paths or profile selections need attention." }
        : null,
    actions:
      report.nextSteps.length > 0
        ? report.nextSteps.map((text) => ({ kind: "instruction" as const, text }))
        : [{ kind: "instruction", text: "No action is required." }],
  });
}

function selectConfigurationRoot(
  environment: NodeJS.ProcessEnv,
  homeDirectory: string,
): PathSelection {
  const configured = environment.DOCSFAB_CONFIG_ROOT;
  if (configured !== undefined) {
    return {
      path: configured,
      source: "DOCSFAB_CONFIG_ROOT",
      provenance: "explicit environment override",
      precedence: 1,
      invalid: !isNormalizedAbsolute(configured),
    };
  }
  const xdg = environment.XDG_CONFIG_HOME;
  if (xdg && isNormalizedAbsolute(xdg)) {
    return {
      path: resolve(xdg, "docsfab"),
      source: "XDG_CONFIG_HOME",
      provenance: "user configuration base",
      precedence: 2,
    };
  }
  return {
    path: resolve(homeDirectory, ".config", "docsfab"),
    source: "default",
    provenance: "$HOME/.config/docsfab fallback",
    precedence: 3,
  };
}

function selectPath(
  environmentValue: string | undefined,
  hostValue: string | undefined,
  fallback: string,
  environmentName: string,
  hostName: string,
  fallbackName: string,
  relativeBase: string,
): PathSelection {
  if (environmentValue !== undefined) {
    return {
      path: environmentValue,
      source: environmentName,
      provenance: "explicit environment override",
      precedence: 1,
      invalid: !isNormalizedAbsolute(environmentValue),
    };
  }
  if (hostValue !== undefined) {
    return {
      path: isAbsolute(hostValue) ? hostValue : resolve(relativeBase, hostValue),
      source: hostName,
      provenance: "host.yaml allowlisted path override",
      precedence: 2,
      invalid: hostValue.includes("\0"),
    };
  }
  return { path: fallback, source: "default", provenance: fallbackName, precedence: 3 };
}

function derivedSelection(path: string, provenance: string, invalid = false): PathSelection {
  return {
    path,
    source: "derived",
    provenance,
    precedence: 4,
    ...(invalid ? { invalid: true } : {}),
  };
}

function activeProfilePath(
  configurationRoot: string,
  host: DocsFabHostConfigV1 | undefined,
  slot: "policy" | "judge",
): PathSelection | undefined {
  const relative = host
    ? slot === "policy"
      ? resolveHostYamlPolicyProfile(host)
      : resolveHostYamlJudgeProfile(host)
    : undefined;
  if (!relative) return undefined;
  try {
    return {
      path: resolveProfilePath(configurationRoot, relative),
      source: `host.yaml active${slot === "policy" ? "Policy" : "Judge"}Profile`,
      provenance: "active split-layout profile selection",
      precedence: 2,
    };
  } catch {
    return {
      path: join(resolveProfilesDirectory(configurationRoot), relative),
      source: `host.yaml active${slot === "policy" ? "Policy" : "Judge"}Profile`,
      provenance: "invalid profile path; must remain under profiles/",
      precedence: 2,
      invalid: true,
    };
  }
}

function inspectCompositionSelection(
  slot: "policy" | "judge",
  selected: HostPurposeSlotV1,
): ConfigProfileSelectionInspection {
  const source =
    slot === "policy" ? "host.yaml writing profile selection" : "host.yaml judge profile selection";
  const base = { slot, kind: "installed-composition" as const, source };
  try {
    const compositionId = selectPurposeCompositionId(
      selected,
      slot === "policy" ? "writing" : "judge",
    );
    if (!compositionId) {
      return {
        ...base,
        status: "inactive",
        provenance: "retired judge selection is inactive; no executable fallback is selected",
        nextCommand: "docsfab setup",
      };
    }
    const assignments = presetSlotAssignments(compositionId);
    return {
      ...base,
      compositionId,
      status: "ready",
      provenance: "installed composition registry; no physical YAML profile file is required",
      presetModelId: assignments.get("MODEL_ID"),
      modelSource: "installed composition preset",
      policySource: "installed composition preset",
      nextCommand:
        slot === "policy" ? "docsfab profile inspect" : "docsfab profile inspect --judge",
    };
  } catch {
    return {
      ...base,
      status: "invalid",
      provenance:
        "installed composition selection could not be resolved; no YAML path was inferred",
      nextCommand: "docsfab setup",
    };
  }
}

async function inspectYamlProfile(
  options: ProbeOptions,
  slot: "policy" | "judge",
  configurationRoot: string,
): Promise<ConfigPathInspection> {
  const inspected = await probePath(options);
  if (inspected.status !== "ready") return inspected;
  const invalidPath = (): ConfigPathInspection => ({
    ...inspected,
    status: "invalid",
    provenance:
      "profile must remain in the canonical profiles/ directory with a stable file identity",
    nextCommand: "docsfab setup",
  });
  let handle: FileHandle | undefined;
  try {
    const original = await lstat(options.selection.path, { bigint: true });
    if (!original.isFile()) return invalidPath();
    const profilesRoot = resolveProfilesDirectory(configurationRoot);
    const canonicalRoot = await realpath(profilesRoot);
    const canonicalPath = await realpath(options.selection.path);
    if (canonicalRoot !== profilesRoot || !canonicalPath.startsWith(`${profilesRoot}${sep}`)) {
      return invalidPath();
    }
    const parents: Array<{ path: string; state: BigIntStats }> = [];
    for (let path = dirname(canonicalPath); ; path = dirname(path)) {
      const state = await lstat(path, { bigint: true });
      if (!state.isDirectory()) return invalidPath();
      parents.push({ path, state });
      if (path === profilesRoot) break;
    }

    // Pin a regular descriptor before consuming bytes. A substituted link or
    // FIFO must neither redirect nor stall the content read.
    handle = await open(
      canonicalPath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
    const opened = handle;
    const stable = async (): Promise<boolean> => {
      if (
        !sameProfileFile(original, await opened.stat({ bigint: true })) ||
        !sameProfileFile(original, await lstat(canonicalPath, { bigint: true }))
      )
        return false;
      for (const parent of parents) {
        const current = await lstat(parent.path, { bigint: true });
        if (
          !current.isDirectory() ||
          current.dev !== parent.state.dev ||
          current.ino !== parent.state.ino ||
          current.ctimeNs !== parent.state.ctimeNs
        )
          return false;
      }
      return (
        (await realpath(profilesRoot)) === canonicalRoot &&
        (await realpath(options.selection.path)) === canonicalPath
      );
    };
    if (!(await stable())) return invalidPath();
    const bytes = await opened.readFile();
    if (!(await stable())) return invalidPath();
    try {
      const profile = decodeModelProfile(parseYaml(bytes.toString("utf8")));
      return profile.slot === slot ? inspected : { ...inspected, status: "invalid" };
    } catch {
      return { ...inspected, status: "invalid" };
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP") return invalidPath();
    const missing = code === "ENOENT" || code === "ENOTDIR";
    return {
      ...inspected,
      status: missing ? "missing" : "unreadable",
      exists: !missing,
      readable: false,
      nextCommand: missing ? "docsfab setup" : "docsfab doctor",
    };
  } finally {
    await handle?.close();
  }
}

function sameProfileFile(expected: BigIntStats, observed: BigIntStats): boolean {
  return (
    observed.isFile() &&
    expected.dev === observed.dev &&
    expected.ino === observed.ino &&
    expected.size === observed.size &&
    expected.mtimeNs === observed.mtimeNs &&
    expected.ctimeNs === observed.ctimeNs
  );
}

async function readHostConfig(path: string): Promise<DocsFabHostConfigV1 | undefined> {
  try {
    const bytes = await readFile(path);
    if (bytes.byteLength > MAX_HOST_CONFIG_BYTES) return undefined;
    return decodeHostConfig(parseYaml(bytes.toString("utf8")));
  } catch {
    return undefined;
  }
}

async function probePath(options: ProbeOptions): Promise<ConfigPathInspection> {
  const { selection } = options;
  if (selection.invalid || !selection.path || selection.path.includes("\0")) {
    return pathInspection(options, "invalid", false, false, false);
  }
  try {
    const metadata = await lstat(selection.path);
    const typeMatches = options.kind === "file" ? metadata.isFile() : metadata.isDirectory();
    if (!typeMatches) return pathInspection(options, "invalid", true, false, false);
    const readable = await canAccess(selection.path, fsConstants.R_OK);
    const writable = await canAccess(selection.path, fsConstants.W_OK);
    const status: ConfigPathStatus = !readable
      ? "unreadable"
      : !writable && options.kind === "directory"
        ? "unwritable"
        : "ready";
    return pathInspection(options, status, true, readable, writable);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    return pathInspection(
      options,
      code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unreadable",
      false,
      false,
      false,
    );
  }
}

function pathInspection(
  options: ProbeOptions,
  status: ConfigPathStatus,
  exists: boolean,
  readable: boolean,
  writable: boolean,
): ConfigPathInspection {
  return {
    id: options.id,
    role: options.role,
    path: options.selection.path,
    source: options.selection.source,
    provenance: options.selection.provenance,
    precedence: options.selection.precedence,
    required: options.required ?? true,
    exists,
    readable,
    writable,
    status,
    nextCommand:
      options.required === false
        ? "No action is required for an unused legacy profiles directory."
        : status === "unreadable" || status === "unwritable"
          ? "docsfab doctor"
          : options.nextCommand,
  };
}

async function canAccess(path: string, mode: number): Promise<boolean> {
  try {
    await access(path, mode);
    return true;
  } catch {
    return false;
  }
}

function nextStepsFor(
  paths: readonly ConfigPathInspection[],
  selections: readonly ConfigProfileSelectionInspection[],
): readonly string[] {
  const requiredPaths = paths.filter((path) => path.required);
  const steps: string[] = [];
  const root = paths.find((path) => path.id === "configuration-root");
  if (root?.status === "invalid" && root.nextCommand !== "docsfab setup") {
    steps.push(root.nextCommand);
  }
  if (requiredPaths.some((path) => path.status === "unreadable" || path.status === "unwritable")) {
    steps.push("docsfab doctor");
  }
  if (
    root?.nextCommand === "docsfab setup" &&
    (requiredPaths.some((path) => path.status === "invalid" || path.status === "missing") ||
      selections.some((selection) => selection.status === "invalid"))
  ) {
    steps.push("docsfab setup");
  }
  return [...new Set(steps)];
}

function isNormalizedAbsolute(value: string): boolean {
  return Boolean(value) && !value.includes("\0") && isAbsolute(value) && resolve(value) === value;
}

/** Compare the selected path with its nearest existing ancestor's real path. */
async function isNonCanonicalRoot(path: string): Promise<boolean> {
  const suffix: string[] = [];
  let cursor = path;
  for (;;) {
    try {
      const canonical = await realpath(cursor);
      return resolve(canonical, ...suffix.reverse()) !== path;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
      const parent = dirname(cursor);
      if (parent === cursor) return false;
      suffix.push(basename(cursor));
      cursor = parent;
    }
  }
}

function assertNoSecretValues(output: string, environment: NodeJS.ProcessEnv): void {
  for (const key of SECRET_ENV_KEYS) {
    const value = environment[key];
    if (value && output.includes(value)) {
      throw new Error(
        "Configuration inspection output contained credential material and was withheld.",
      );
    }
  }
}
