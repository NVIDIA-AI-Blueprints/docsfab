// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isAbsolute, resolve } from "node:path";

import { createContractKit, deepFreeze } from "../contract-kit/index.js";

export const NATIVE_PREFLIGHT_INPUT_KIND = "docsfab-native-composition-preflight-input" as const;
export const NATIVE_PREFLIGHT_OBSERVATION_KIND =
  "docsfab-native-composition-preflight-observation" as const;
export const NATIVE_PREFLIGHT_ADAPTER_VERSION = "1.0.0" as const;
/**
 * Codex CLI pinned by the adapter records at 1.0.0: the retired GPT-5.6 Codex
 * preflight record and the frozen cross-harness pilot. Unchanged so their
 * retained evidence keeps binding.
 */
export const CODEX_PREFLIGHT_REPORTED_VERSION = "codex-cli 0.147.0" as const;
/**
 * Codex CLI pinned by the adapter records at 1.1.0, which
 * `openai-gpt-6-sol-codex-preflight` binds (#1512). Each installed Codex
 * record selects its pin through its adapter record version.
 */
export const CODEX_GPT_6_PREFLIGHT_REPORTED_VERSION = "codex-cli 0.155.1" as const;
export const CODEX_PREFLIGHT_REPORTED_VERSIONS = [
  CODEX_PREFLIGHT_REPORTED_VERSION,
  CODEX_GPT_6_PREFLIGHT_REPORTED_VERSION,
] as const;

/**
 * Where a Codex preflight judges model availability. `codex-bundled` is the
 * catalog shipped inside the CLI (`codex debug models --bundled`);
 * `codex-account` is the authenticated account catalog (`codex debug models`),
 * which is what NVIDIA's Codex environment actually serves.
 */
export const CODEX_CATALOG_SOURCES = ["codex-bundled", "codex-account"] as const;
export type CodexCatalogSource = (typeof CODEX_CATALOG_SOURCES)[number];

/**
 * The fixed catalog command for each catalog source. The single source of the
 * catalog argv: the adapter builds it from here and the local host admits
 * exactly these lists before spawning.
 */
export const CODEX_CATALOG_ARGUMENTS: Readonly<Record<CodexCatalogSource, readonly string[]>> =
  deepFreeze({
    "codex-bundled": ["debug", "models", "--bundled"],
    "codex-account": ["debug", "models"],
  });

/**
 * The catalog each pinned Codex version is judged against. The 0.147.0 pin
 * keeps the bundled catalog unchanged. For the 0.155.1 pin the bundled list is
 * stale (it lacks gpt-6-sol), so availability comes from the account catalog
 * once authentication is ready (#1512).
 */
export function codexCatalogSourceForVersion(
  reportedVersion: string,
): CodexCatalogSource | undefined {
  if (reportedVersion === CODEX_PREFLIGHT_REPORTED_VERSION) return "codex-bundled";
  if (reportedVersion === CODEX_GPT_6_PREFLIGHT_REPORTED_VERSION) return "codex-account";
  return undefined;
}
export const CLAUDE_PREFLIGHT_REPORTED_VERSION = "2.1.226 (Claude Code)" as const;

export const NATIVE_PREFLIGHT_FAILURE_CODES = [
  "cancelled",
  "timeout",
  "host-operation-failed",
  "spawn-failed",
  "output-limit",
  "evidence-limit",
  "process-failed",
  "malformed-output",
  "credential-boundary",
  "executable-drift",
  "authentication-mismatch",
  "model-unavailable",
] as const;

export type NativeHarnessId = "codex" | "claude-code";
export type NativeRouteId = "codex-chatgpt-managed" | "claude-ai-managed";
export type NativePreflightAdapterId = "codex-preflight" | "claude-code-preflight";
export type NativeExecutableBasename = "codex" | "codex.exe" | "claude" | "claude.exe";
export type NativePreflightFailureCode = (typeof NATIVE_PREFLIGHT_FAILURE_CODES)[number];
export type NativePreflightTerminalCode = "preflight-ready" | NativePreflightFailureCode;

export interface NativePreflightInputV1 {
  readonly schemaVersion: 1;
  readonly kind: typeof NATIVE_PREFLIGHT_INPUT_KIND;
  readonly harnessId: NativeHarnessId;
  readonly routeId: NativeRouteId;
  readonly executionClass: "preflight-only";
  readonly requestedModel: string;
  readonly executablePath: string;
  readonly expectedExecutable: {
    /** Basename of the canonical executable target, not its launcher symlink. */
    readonly basename: NativeExecutableBasename;
    readonly sha256: string;
    readonly identitySha256: string;
    /** Exact, single-line output expected from the version command. */
    readonly reportedVersion: string;
  };
  /** Complete child environment. Adapters never read process.env. */
  readonly environment: Readonly<Record<string, string>>;
}

export type NativePreflightOperation = "version" | "authentication" | "catalog";

export interface NativePreflightLimitNoticeV1 {
  readonly name: string;
  readonly observed: number;
  readonly value: number;
  readonly unit: string;
  readonly refusal: string;
  readonly message: string;
  /** Persisted process that produced the measurement, not a synthetic count. */
  readonly source: string;
}

export interface NativePreflightProcessEvidence {
  readonly operation: NativePreflightOperation;
  readonly argumentsSha256: string;
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly stdoutOverflow: boolean;
  readonly stderrOverflow: boolean;
  readonly limitNotices: readonly NativePreflightLimitNoticeV1[];
  /** Digest of the minimized safe projection, never raw stdout or stderr. */
  readonly projectionSha256: string | null;
}

export interface NativePreflightObservationV1 {
  readonly schemaVersion: 1;
  readonly kind: typeof NATIVE_PREFLIGHT_OBSERVATION_KIND;
  readonly adapterVersion: typeof NATIVE_PREFLIGHT_ADAPTER_VERSION;
  readonly adapterId: NativePreflightAdapterId;
  readonly harnessId: NativeHarnessId;
  readonly routeId: NativeRouteId;
  readonly executionClass: "preflight-only";
  readonly capabilities: {
    readonly modelEgress: "unavailable";
    readonly workflowExecution: "unavailable";
  };
  readonly requestedModel: string;
  readonly observedModel: null;
  readonly executable: {
    readonly basename: NativeExecutableBasename;
    /** Digest of the canonical absolute path; the host path is not retained. */
    readonly pathSha256: string;
    readonly sha256: string;
    readonly identitySha256: string;
    readonly reportedVersion: string;
  };
  readonly environment: {
    readonly variableNames: readonly string[];
    readonly policySha256: string;
  };
  readonly authentication: {
    readonly status: "ready" | "unavailable";
    readonly mechanism: "chatgpt" | "claude.ai" | null;
    readonly providerClass: "openai-first-party" | "anthropic-first-party" | null;
    readonly subscriptionClass: "enterprise" | "not-observed" | null;
    readonly projectionSha256: string | null;
  };
  readonly catalog: {
    readonly source: CodexCatalogSource | "not-observed";
    readonly availability: "available" | "unavailable" | "not-observed";
    readonly projectionSha256: string | null;
  };
  readonly processes: readonly NativePreflightProcessEvidence[];
  readonly terminalCode: NativePreflightTerminalCode;
  readonly reasonCodes: readonly NativePreflightFailureCode[];
  readonly preflightSha256: string;
}

export type NativePreflightContractErrorCode =
  | "invalid-shape"
  | "invalid-value"
  | "credential-material"
  | "environment-policy"
  | "executable-policy"
  | "migration-required";

export class NativePreflightContractError extends Error {
  public constructor(public readonly code: NativePreflightContractErrorCode) {
    super(`Native composition preflight contract rejected (${code}).`);
    this.name = "NativePreflightContractError";
  }
}

function fail(code: NativePreflightContractErrorCode): never {
  throw new NativePreflightContractError(code);
}

const kit = createContractKit<NativePreflightContractErrorCode>({
  fail,
  inertMode: "strict",
  codes: {
    invalidShape: "invalid-shape",
    invalidValue: "invalid-value",
    digestMismatch: "invalid-value",
    credentialMaterial: "credential-material",
    schemaMismatch: "migration-required",
  },
});

export const NATIVE_PREFLIGHT_ENVIRONMENT_NAMES = Object.freeze([
  "HOME",
  "LANG",
  "LC_ALL",
  "LOGNAME",
  "TMPDIR",
  "USER",
  "USERNAME",
] as const);

const INPUT_KEYS = [
  "schemaVersion",
  "kind",
  "harnessId",
  "routeId",
  "executionClass",
  "requestedModel",
  "executablePath",
  "expectedExecutable",
  "environment",
] as const;

const OBSERVATION_BODY_KEYS = [
  "adapterVersion",
  "adapterId",
  "harnessId",
  "routeId",
  "executionClass",
  "capabilities",
  "requestedModel",
  "observedModel",
  "executable",
  "environment",
  "authentication",
  "catalog",
  "processes",
  "terminalCode",
  "reasonCodes",
] as const;

export function parseNativePreflightInputV1(
  value: unknown,
  expectedHarness: NativeHarnessId,
): NativePreflightInputV1 {
  kit.assertInert(value);
  kit.rejectCredentials(value);
  const root = kit.object(value);
  kit.exact(root, INPUT_KEYS);
  if (
    root.schemaVersion !== 1 ||
    root.kind !== NATIVE_PREFLIGHT_INPUT_KIND ||
    root.executionClass !== "preflight-only"
  ) {
    fail("invalid-value");
  }

  const harnessId = kit.enumeration(root.harnessId, ["codex", "claude-code"] as const);
  if (harnessId !== expectedHarness) fail("invalid-value");
  const routeId = kit.enumeration(root.routeId, [
    "codex-chatgpt-managed",
    "claude-ai-managed",
  ] as const);
  if (
    (harnessId === "codex" && routeId !== "codex-chatgpt-managed") ||
    (harnessId === "claude-code" && routeId !== "claude-ai-managed")
  ) {
    fail("invalid-value");
  }

  const executablePath = boundedText(root.executablePath, 4096);
  if (!canonicalAbsolutePath(executablePath)) fail("executable-policy");
  const expectedExecutable = kit.object(root.expectedExecutable);
  kit.exact(expectedExecutable, ["basename", "sha256", "identitySha256", "reportedVersion"]);
  const executableBasename = kit.enumeration(expectedExecutable.basename, [
    "codex",
    "codex.exe",
    "claude",
    "claude.exe",
  ] as const);
  if (
    (harnessId === "codex" && !["codex", "codex.exe"].includes(executableBasename)) ||
    (harnessId === "claude-code" && !["claude", "claude.exe"].includes(executableBasename))
  ) {
    fail("executable-policy");
  }

  const environment = parseEnvironment(root.environment);
  return deepFreeze({
    schemaVersion: 1,
    kind: NATIVE_PREFLIGHT_INPUT_KIND,
    harnessId,
    routeId,
    executionClass: "preflight-only",
    requestedModel: boundedIdentifier(root.requestedModel),
    executablePath,
    expectedExecutable: {
      basename: executableBasename,
      sha256: kit.hash(expectedExecutable.sha256),
      identitySha256: kit.hash(expectedExecutable.identitySha256),
      reportedVersion: boundedSingleLine(expectedExecutable.reportedVersion, 128),
    },
    environment,
  });
}

export function sealNativePreflightObservationV1(
  body: Omit<NativePreflightObservationV1, "schemaVersion" | "kind" | "preflightSha256">,
): NativePreflightObservationV1 {
  return parseNativePreflightObservationV1(
    kit.seal(NATIVE_PREFLIGHT_OBSERVATION_KIND, "preflightSha256", body),
  );
}

export function parseNativePreflightObservationV1(value: unknown): NativePreflightObservationV1 {
  return kit.decodeSealed(
    value,
    NATIVE_PREFLIGHT_OBSERVATION_KIND,
    "preflightSha256",
    [...OBSERVATION_BODY_KEYS],
    normalizeObservationBody,
  ) as NativePreflightObservationV1;
}

function normalizeObservationBody(
  body: Record<string, unknown>,
): Omit<NativePreflightObservationV1, "schemaVersion" | "kind" | "preflightSha256"> {
  if (body.adapterVersion !== NATIVE_PREFLIGHT_ADAPTER_VERSION) fail("invalid-value");
  const adapterId = kit.enumeration(body.adapterId, [
    "codex-preflight",
    "claude-code-preflight",
  ] as const);
  const harnessId = kit.enumeration(body.harnessId, ["codex", "claude-code"] as const);
  const routeId = kit.enumeration(body.routeId, [
    "codex-chatgpt-managed",
    "claude-ai-managed",
  ] as const);
  if (
    body.executionClass !== "preflight-only" ||
    (adapterId === "codex-preflight" &&
      (harnessId !== "codex" || routeId !== "codex-chatgpt-managed")) ||
    (adapterId === "claude-code-preflight" &&
      (harnessId !== "claude-code" || routeId !== "claude-ai-managed"))
  ) {
    fail("invalid-value");
  }

  const capabilities = exactObject(body.capabilities, ["modelEgress", "workflowExecution"]);
  if (
    capabilities.modelEgress !== "unavailable" ||
    capabilities.workflowExecution !== "unavailable"
  ) {
    fail("invalid-value");
  }
  if (body.observedModel !== null) fail("invalid-value");

  const executable = exactObject(body.executable, [
    "basename",
    "pathSha256",
    "sha256",
    "identitySha256",
    "reportedVersion",
  ]);
  const executableBasename = kit.enumeration(executable.basename, [
    "codex",
    "codex.exe",
    "claude",
    "claude.exe",
  ] as const);
  if (
    (harnessId === "codex" && !["codex", "codex.exe"].includes(executableBasename)) ||
    (harnessId === "claude-code" && !["claude", "claude.exe"].includes(executableBasename))
  ) {
    fail("invalid-value");
  }
  const environment = exactObject(body.environment, ["variableNames", "policySha256"]);
  const variableNames = kit
    .array(environment.variableNames)
    .map((entry) => kit.enumeration(entry, NATIVE_PREFLIGHT_ENVIRONMENT_NAMES));
  if (
    variableNames.length === 0 ||
    variableNames[0] !== "HOME" ||
    new Set(variableNames).size !== variableNames.length ||
    [...variableNames].sort().some((name, index) => name !== variableNames[index])
  ) {
    fail("invalid-value");
  }

  const authentication = exactObject(body.authentication, [
    "status",
    "mechanism",
    "providerClass",
    "subscriptionClass",
    "projectionSha256",
  ]);
  const normalizedAuthentication: NativePreflightObservationV1["authentication"] = {
    status: kit.enumeration(authentication.status, ["ready", "unavailable"] as const),
    mechanism:
      authentication.mechanism === null
        ? null
        : kit.enumeration(authentication.mechanism, ["chatgpt", "claude.ai"] as const),
    providerClass:
      authentication.providerClass === null
        ? null
        : kit.enumeration(authentication.providerClass, [
            "openai-first-party",
            "anthropic-first-party",
          ] as const),
    subscriptionClass:
      authentication.subscriptionClass === null
        ? null
        : kit.enumeration(authentication.subscriptionClass, [
            "enterprise",
            "not-observed",
          ] as const),
    projectionSha256: kit.nullableHash(authentication.projectionSha256),
  };

  const catalog = exactObject(body.catalog, ["source", "availability", "projectionSha256"]);
  const normalizedCatalog: NativePreflightObservationV1["catalog"] = {
    source: kit.enumeration(catalog.source, [...CODEX_CATALOG_SOURCES, "not-observed"] as const),
    availability: kit.enumeration(catalog.availability, [
      "available",
      "unavailable",
      "not-observed",
    ] as const),
    projectionSha256: kit.nullableHash(catalog.projectionSha256),
  };

  const processes = kit.array(body.processes).map(normalizeProcessEvidence);
  if (processes.length > 3) fail("invalid-value");
  const terminalCode = kit.enumeration(body.terminalCode, [
    "preflight-ready",
    ...NATIVE_PREFLIGHT_FAILURE_CODES,
  ] as const);
  const reasonCodes = kit
    .array(body.reasonCodes)
    .map((entry) => kit.enumeration(entry, NATIVE_PREFLIGHT_FAILURE_CODES));
  if (
    new Set(reasonCodes).size !== reasonCodes.length ||
    (terminalCode === "preflight-ready" && reasonCodes.length !== 0) ||
    (terminalCode !== "preflight-ready" &&
      (reasonCodes.length !== 1 || reasonCodes[0] !== terminalCode))
  ) {
    fail("invalid-value");
  }
  validateObservationSemantics({
    adapterId,
    terminalCode,
    reportedVersion: boundedSingleLine(executable.reportedVersion, 128),
    authentication: normalizedAuthentication,
    catalog: normalizedCatalog,
    processes,
  });

  return {
    adapterVersion: NATIVE_PREFLIGHT_ADAPTER_VERSION,
    adapterId,
    harnessId,
    routeId,
    executionClass: "preflight-only",
    capabilities: { modelEgress: "unavailable", workflowExecution: "unavailable" },
    requestedModel: boundedIdentifier(body.requestedModel),
    observedModel: null,
    executable: {
      basename: executableBasename,
      pathSha256: kit.hash(executable.pathSha256),
      sha256: kit.hash(executable.sha256),
      identitySha256: kit.hash(executable.identitySha256),
      reportedVersion: boundedSingleLine(executable.reportedVersion, 128),
    },
    environment: {
      variableNames,
      policySha256: kit.hash(environment.policySha256),
    },
    authentication: normalizedAuthentication,
    catalog: normalizedCatalog,
    processes,
    terminalCode,
    reasonCodes,
  };
}

function normalizeProcessEvidence(value: unknown): NativePreflightProcessEvidence {
  const process = exactObject(value, [
    "operation",
    "argumentsSha256",
    "exitCode",
    "durationMs",
    "stdoutBytes",
    "stderrBytes",
    "stdoutOverflow",
    "stderrOverflow",
    "limitNotices",
    "projectionSha256",
  ]);
  const operation = kit.enumeration(process.operation, [
    "version",
    "authentication",
    "catalog",
  ] as const);
  const notices = kit
    .array(process.limitNotices)
    .map((entry) => normalizeLimitNotice(entry, operation));
  if (notices.length > 3) fail("invalid-value");
  return {
    operation,
    argumentsSha256: kit.hash(process.argumentsSha256),
    exitCode: process.exitCode === null ? null : boundedInteger(process.exitCode, 0, 255),
    durationMs: measuredNonnegativeInteger(process.durationMs),
    stdoutBytes: measuredNonnegativeInteger(process.stdoutBytes),
    stderrBytes: measuredNonnegativeInteger(process.stderrBytes),
    stdoutOverflow: booleanFlag(process.stdoutOverflow),
    stderrOverflow: booleanFlag(process.stderrOverflow),
    limitNotices: Object.freeze(notices),
    projectionSha256: kit.nullableHash(process.projectionSha256),
  };
}

function normalizeLimitNotice(
  value: unknown,
  operation: NativePreflightOperation,
): NativePreflightLimitNoticeV1 {
  const notice = exactObject(value, [
    "name",
    "observed",
    "value",
    "unit",
    "refusal",
    "message",
    "source",
  ]);
  const source = boundedText(notice.source, 64);
  if (source !== `native-preflight:${operation}`) fail("invalid-value");
  const observed = measuredNonnegativeInteger(notice.observed);
  const limitValue = measuredNonnegativeInteger(notice.value);
  if (observed <= limitValue) fail("invalid-value");
  return Object.freeze({
    name: boundedText(notice.name, 128),
    observed,
    value: limitValue,
    unit: boundedText(notice.unit, 32),
    refusal: boundedText(notice.refusal, 128),
    message: boundedText(notice.message, 1024),
    source,
  });
}

function measuredNonnegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail("invalid-value");
  return value as number;
}

function booleanFlag(value: unknown): boolean {
  if (value !== true && value !== false) fail("invalid-value");
  return value;
}

function validateObservationSemantics(input: {
  adapterId: NativePreflightAdapterId;
  terminalCode: NativePreflightTerminalCode;
  reportedVersion: string;
  authentication: NativePreflightObservationV1["authentication"];
  catalog: NativePreflightObservationV1["catalog"];
  processes: readonly NativePreflightProcessEvidence[];
}): void {
  const operations = input.processes.map((process) => process.operation);
  if (new Set(operations).size !== operations.length) fail("invalid-value");
  const expectedOrder =
    input.adapterId === "codex-preflight"
      ? (["version", "authentication", "catalog"] as const)
      : (["version", "authentication"] as const);
  if (operations.some((operation, index) => operation !== expectedOrder[index])) {
    fail("invalid-value");
  }
  if (input.adapterId === "codex-preflight") {
    if (
      !(CODEX_CATALOG_SOURCES as readonly string[]).includes(input.catalog.source) ||
      // Once a pinned version is attested, the catalog source is that pin's.
      (codexCatalogSourceForVersion(input.reportedVersion) !== undefined &&
        input.catalog.source !== codexCatalogSourceForVersion(input.reportedVersion)) ||
      (input.catalog.availability === "not-observed" && input.catalog.projectionSha256 !== null) ||
      (input.authentication.status === "ready" &&
        (input.authentication.mechanism !== "chatgpt" ||
          input.authentication.providerClass !== "openai-first-party" ||
          input.authentication.subscriptionClass !== "not-observed"))
    ) {
      fail("invalid-value");
    }
  } else if (
    input.catalog.source !== "not-observed" ||
    input.catalog.availability !== "not-observed" ||
    input.catalog.projectionSha256 !== null ||
    (input.authentication.status === "ready" &&
      (input.authentication.mechanism !== "claude.ai" ||
        input.authentication.providerClass !== "anthropic-first-party" ||
        input.authentication.subscriptionClass !== "enterprise"))
  ) {
    fail("invalid-value");
  }
  if (
    (input.authentication.status === "unavailable" &&
      (input.authentication.mechanism !== null ||
        input.authentication.providerClass !== null ||
        input.authentication.subscriptionClass !== null ||
        input.authentication.projectionSha256 !== null)) ||
    (input.catalog.availability !== "not-observed" && input.catalog.projectionSha256 === null)
  ) {
    fail("invalid-value");
  }
  if (input.terminalCode === "preflight-ready") {
    if (
      input.processes.length !== expectedOrder.length ||
      input.processes.some(
        (process) => process.exitCode !== 0 || process.projectionSha256 === null,
      ) ||
      input.authentication.status !== "ready" ||
      input.authentication.projectionSha256 === null ||
      (input.adapterId === "codex-preflight" &&
        (input.catalog.availability !== "available" ||
          !(CODEX_PREFLIGHT_REPORTED_VERSIONS as readonly string[]).includes(
            input.reportedVersion,
          ))) ||
      (input.adapterId === "claude-code-preflight" &&
        input.reportedVersion !== CLAUDE_PREFLIGHT_REPORTED_VERSION)
    ) {
      fail("invalid-value");
    }
  }
}

function parseEnvironment(value: unknown): Readonly<Record<string, string>> {
  const environment = kit.object(value);
  const names = Object.keys(environment).sort();
  if (
    names.length === 0 ||
    names[0] !== "HOME" ||
    names.some((name) => !(NATIVE_PREFLIGHT_ENVIRONMENT_NAMES as readonly string[]).includes(name))
  ) {
    fail("environment-policy");
  }
  const normalized: Record<string, string> = {};
  for (const name of names) {
    const entry = boundedText(environment[name], 4096);
    if (
      ((name === "HOME" || name === "TMPDIR") && !canonicalAbsolutePath(entry)) ||
      ((name === "LANG" || name === "LC_ALL") &&
        !/^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/u.test(entry)) ||
      ((name === "LOGNAME" || name === "USER" || name === "USERNAME") &&
        !/^[A-Za-z0-9][A-Za-z0-9._@+\\-]{0,127}$/u.test(entry))
    ) {
      fail("environment-policy");
    }
    normalized[name] = entry;
  }
  return deepFreeze(normalized);
}

function exactObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const result = kit.object(value);
  kit.exact(result, keys);
  return result;
}

function boundedIdentifier(value: unknown): string {
  const result = kit.identifier(value);
  if (result.length > 128) fail("invalid-value");
  return result;
}

function boundedText(value: unknown, maxLength: number): string {
  const result = kit.string(value);
  if (result.length === 0 || result.length > maxLength) fail("invalid-value");
  return result;
}

function boundedSingleLine(value: unknown, maxLength: number): string {
  const result = boundedText(value, maxLength);
  if (/\r|\n/u.test(result) || result.trim() !== result) fail("invalid-value");
  return result;
}

function boundedInteger(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    fail("invalid-value");
  }
  return value as number;
}

function canonicalAbsolutePath(value: string): boolean {
  return isAbsolute(value) && resolve(value) === value;
}
