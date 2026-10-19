// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { basename, isAbsolute, resolve } from "node:path";

import { canonicalDigest } from "../contract-kit/index.js";
import {
  formatLimitRefusal,
  limit,
  type ResolvedLimit,
  type ResolveLimitsOptions,
} from "../config/limits.js";
import {
  detectCredentialRuleIds,
  detectCredentialRuleIdsInValue,
} from "../security/repository-scanner.js";
import {
  CLAUDE_PREFLIGHT_REPORTED_VERSION,
  CODEX_CATALOG_ARGUMENTS,
  CODEX_PREFLIGHT_REPORTED_VERSIONS,
  codexCatalogSourceForVersion,
  type CodexCatalogSource,
  NATIVE_PREFLIGHT_ADAPTER_VERSION,
  NATIVE_PREFLIGHT_ENVIRONMENT_NAMES,
  type NativeHarnessId,
  type NativePreflightAdapterId,
  type NativePreflightFailureCode,
  type NativePreflightInputV1,
  type NativePreflightObservationV1,
  type NativePreflightOperation,
  type NativePreflightLimitNoticeV1,
  type NativePreflightProcessEvidence,
  parseNativePreflightInputV1,
  sealNativePreflightObservationV1,
} from "./contracts.js";
import { isPlainRecord } from "../shared/primitives.js";

interface NativePreflightResolvedLimits {
  readonly timeout: ResolvedLimit;
  readonly versionStdout: ResolvedLimit;
  readonly authenticationStdout: ResolvedLimit;
  readonly catalogStdout: ResolvedLimit;
  readonly catalogModelCount: ResolvedLimit;
  readonly catalogSlugCharacters: ResolvedLimit;
  readonly maxStderr: ResolvedLimit;
  readonly recordedDuration: ResolvedLimit;
  readonly recordedStdout: ResolvedLimit;
  readonly recordedStderr: ResolvedLimit;
}

function resolveNativePreflightLimits(
  options: ResolveLimitsOptions = {},
): NativePreflightResolvedLimits {
  return {
    timeout: limit("nativePreflight.timeoutMs", options),
    versionStdout: limit("nativePreflight.versionStdoutBytes", options),
    authenticationStdout: limit("nativePreflight.authenticationStdoutBytes", options),
    catalogStdout: limit("nativePreflight.catalogStdoutBytes", options),
    catalogModelCount: limit("nativePreflight.catalogModelCount", options),
    catalogSlugCharacters: limit("nativePreflight.catalogSlugCharacters", options),
    maxStderr: limit("nativePreflight.maxStderrBytes", options),
    recordedDuration: limit("nativePreflight.recordedDurationMs", options),
    recordedStdout: limit("nativePreflight.recordedStdoutBytes", options),
    recordedStderr: limit("nativePreflight.recordedStderrBytes", options),
  };
}

const STARTUP_NATIVE_PREFLIGHT_LIMITS = resolveNativePreflightLimits();
const EMPTY_LIMIT_NOTICES: readonly NativePreflightLimitNoticeV1[] = Object.freeze([]);

export const NATIVE_PREFLIGHT_LIMITS = Object.freeze({
  timeoutMs: STARTUP_NATIVE_PREFLIGHT_LIMITS.timeout.value,
  versionStdoutBytes: STARTUP_NATIVE_PREFLIGHT_LIMITS.versionStdout.value,
  authenticationStdoutBytes: STARTUP_NATIVE_PREFLIGHT_LIMITS.authenticationStdout.value,
  catalogStdoutBytes: STARTUP_NATIVE_PREFLIGHT_LIMITS.catalogStdout.value,
  maxStderrBytes: STARTUP_NATIVE_PREFLIGHT_LIMITS.maxStderr.value,
});

export interface NativeExecutableObservation {
  readonly canonicalPath: string;
  readonly basename: string;
  readonly sha256: string;
  /** Digest of path, device, inode, size, mode, owner, and opened-file identity. */
  readonly identitySha256: string;
  readonly trusted: boolean;
}

export interface NativePreflightProcessRequest {
  readonly operation: NativePreflightOperation;
  readonly executablePath: string;
  readonly arguments: readonly string[];
  /** Complete child environment. There is deliberately no ambient merge. */
  readonly environment: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly maxStdoutBytes: number;
  readonly maxStderrBytes: number;
  readonly signal?: AbortSignal;
}

export type NativePreflightProcessStatus =
  | "settled"
  | "spawn-failed"
  | "output-limit"
  | "timeout"
  | "cancelled";

export interface NativePreflightProcessObservation {
  readonly status: NativePreflightProcessStatus;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly durationMs: number;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly stdoutOverflow: boolean;
  readonly stderrOverflow: boolean;
}

export interface NativePreflightHost {
  readonly inspectExecutable: (
    absolutePath: string,
    signal?: AbortSignal,
  ) => Promise<NativeExecutableObservation>;
  readonly runProcess: (
    request: NativePreflightProcessRequest,
  ) => Promise<NativePreflightProcessObservation>;
}

export interface NativeCompositionPreflightAdapter {
  readonly id: NativePreflightAdapterId;
  readonly version: typeof NATIVE_PREFLIGHT_ADAPTER_VERSION;
  readonly harnessId: NativeHarnessId;
  readonly executionClass: "preflight-only";
  readonly capabilities: {
    readonly modelEgress: "unavailable";
    readonly workflowExecution: "unavailable";
  };
  preflight(input: unknown, signal?: AbortSignal): Promise<NativePreflightObservationV1>;
}

interface CommandSuccess {
  readonly status: "completed";
  readonly text: string;
  readonly evidence: NativePreflightProcessEvidence;
}

interface CommandFailure {
  readonly status: "failed";
  readonly code: NativePreflightFailureCode;
  readonly evidence: NativePreflightProcessEvidence;
}

type CommandOutcome = CommandSuccess | CommandFailure;

type AuthenticationEvidence = NativePreflightObservationV1["authentication"];
type CatalogEvidence = NativePreflightObservationV1["catalog"];

const EMPTY_AUTHENTICATION: AuthenticationEvidence = Object.freeze({
  status: "unavailable",
  mechanism: null,
  providerClass: null,
  subscriptionClass: null,
  projectionSha256: null,
});
/** An unobserved catalog, labelled with the source the pinned version uses. */
function codexUnobservedCatalog(source: CodexCatalogSource): CatalogEvidence {
  return Object.freeze({ source, availability: "not-observed", projectionSha256: null });
}

const CLAUDE_UNOBSERVED_CATALOG: CatalogEvidence = Object.freeze({
  source: "not-observed",
  availability: "not-observed",
  projectionSha256: null,
});

export function createCodexNativePreflightAdapter(
  host: NativePreflightHost,
  options: ResolveLimitsOptions = {},
): NativeCompositionPreflightAdapter {
  return Object.freeze({
    id: "codex-preflight",
    version: NATIVE_PREFLIGHT_ADAPTER_VERSION,
    harnessId: "codex",
    executionClass: "preflight-only",
    capabilities: Object.freeze({
      modelEgress: "unavailable",
      workflowExecution: "unavailable",
    }),
    preflight: (input: unknown, signal?: AbortSignal) =>
      runCodexPreflight(input, host, signal, options),
  });
}

export function createClaudeNativePreflightAdapter(
  host: NativePreflightHost,
  options: ResolveLimitsOptions = {},
): NativeCompositionPreflightAdapter {
  return Object.freeze({
    id: "claude-code-preflight",
    version: NATIVE_PREFLIGHT_ADAPTER_VERSION,
    harnessId: "claude-code",
    executionClass: "preflight-only",
    capabilities: Object.freeze({
      modelEgress: "unavailable",
      workflowExecution: "unavailable",
    }),
    preflight: (input: unknown, signal?: AbortSignal) =>
      runClaudePreflight(input, host, signal, options),
  });
}

async function runCodexPreflight(
  value: unknown,
  host: NativePreflightHost,
  signal: AbortSignal | undefined,
  options: ResolveLimitsOptions = {},
): Promise<NativePreflightObservationV1> {
  const bounds = resolveNativePreflightLimits(options);
  const input = parseNativePreflightInputV1(value, "codex");
  const catalogSource =
    codexCatalogSourceForVersion(input.expectedExecutable.reportedVersion) ?? "codex-bundled";
  const CODEX_UNOBSERVED_CATALOG = codexUnobservedCatalog(catalogSource);
  const before = await inspectExecutable(host, input, signal);
  const processes: NativePreflightProcessEvidence[] = [];
  if (!matchesExecutablePolicy(before, input)) {
    return failure(input, "codex-preflight", before, processes, {
      code: "executable-drift",
      catalog: CODEX_UNOBSERVED_CATALOG,
    });
  }
  // The installed record selects its pinned Codex version; only admitted pins
  // are accepted, and the observed CLI must report exactly the selected one.
  if (
    !(CODEX_PREFLIGHT_REPORTED_VERSIONS as readonly string[]).includes(
      input.expectedExecutable.reportedVersion,
    )
  ) {
    return failure(input, "codex-preflight", before, processes, {
      code: "executable-drift",
      catalog: CODEX_UNOBSERVED_CATALOG,
    });
  }

  const version = await runFixedCommand(
    host,
    input,
    "version",
    ["--version"],
    bounds.versionStdout.value,
    signal,
    "stdout",
    bounds,
  );
  processes.push(version.evidence);
  if (version.status === "failed") {
    return failure(input, "codex-preflight", before, processes, {
      code: version.code,
      catalog: CODEX_UNOBSERVED_CATALOG,
    });
  }
  const reportedVersion = parseSingleLine(version.text);
  if (reportedVersion !== input.expectedExecutable.reportedVersion) {
    return failure(input, "codex-preflight", before, processes, {
      code: "executable-drift",
      catalog: CODEX_UNOBSERVED_CATALOG,
    });
  }
  processes[0] = withProjection(version.evidence, { reportedVersion });

  const auth = await runFixedCommand(
    host,
    input,
    "authentication",
    ["login", "status"],
    bounds.authenticationStdout.value,
    signal,
    "stderr",
    bounds,
  );
  processes.push(auth.evidence);
  if (auth.status === "failed") {
    return failure(input, "codex-preflight", before, processes, {
      code: auth.code,
      reportedVersion,
      catalog: CODEX_UNOBSERVED_CATALOG,
    });
  }
  const loginStatus = parseSingleLine(auth.text);
  if (loginStatus !== "Logged in using ChatGPT") {
    return failure(input, "codex-preflight", before, processes, {
      code: "authentication-mismatch",
      reportedVersion,
      catalog: CODEX_UNOBSERVED_CATALOG,
    });
  }
  const authentication: AuthenticationEvidence = {
    status: "ready",
    mechanism: "chatgpt",
    providerClass: "openai-first-party",
    subscriptionClass: "not-observed",
    projectionSha256: canonicalDigest({
      mechanism: "chatgpt",
      providerClass: "openai-first-party",
    }),
  };
  processes[1] = withProjection(auth.evidence, {
    mechanism: authentication.mechanism,
    providerClass: authentication.providerClass,
  });

  const catalogCommand = await runFixedCommand(
    host,
    input,
    "catalog",
    // Runs only after authentication is ready; an unready login stops above
    // and never falls back to another catalog.
    CODEX_CATALOG_ARGUMENTS[catalogSource],
    bounds.catalogStdout.value,
    signal,
    "stdout",
    bounds,
  );
  processes.push(catalogCommand.evidence);
  if (catalogCommand.status === "failed") {
    return failure(input, "codex-preflight", before, processes, {
      code: catalogCommand.code,
      reportedVersion,
      authentication,
      catalog: CODEX_UNOBSERVED_CATALOG,
    });
  }
  const parsedCatalog = parseCodexModelSlugs(catalogCommand.text, bounds);
  if (parsedCatalog.status === "limit") {
    // A provider-controlled catalog outgrew a declared ceiling: a named
    // evidence-limit stop, not a malformed-output guess.
    processes[2] = Object.freeze({
      ...catalogCommand.evidence,
      limitNotices: Object.freeze([
        ...catalogCommand.evidence.limitNotices,
        limitNotice("catalog", parsedCatalog.bound, parsedCatalog.observed),
      ]),
    });
    return failure(input, "codex-preflight", before, processes, {
      code: "evidence-limit",
      reportedVersion,
      authentication,
      catalog: CODEX_UNOBSERVED_CATALOG,
    });
  }
  const modelSlugs = parsedCatalog.status === "parsed" ? parsedCatalog.modelSlugs : null;
  if (modelSlugs === null) {
    return failure(input, "codex-preflight", before, processes, {
      code: "malformed-output",
      reportedVersion,
      authentication,
      catalog: CODEX_UNOBSERVED_CATALOG,
    });
  }
  const available = modelSlugs.includes(input.requestedModel);
  const catalog: CatalogEvidence = {
    source: catalogSource,
    availability: available ? "available" : "unavailable",
    projectionSha256: canonicalDigest({ source: catalogSource, modelSlugs }),
  };
  processes[2] = withProjection(catalogCommand.evidence, {
    source: catalog.source,
    modelSlugs,
  });
  if (!available) {
    return failure(input, "codex-preflight", before, processes, {
      code: "model-unavailable",
      reportedVersion,
      authentication,
      catalog,
    });
  }

  const after = await inspectExecutable(host, input, signal);
  if (!sameExecutable(before, after) || !matchesExecutablePolicy(after, input)) {
    return failure(input, "codex-preflight", after, processes, {
      code: "executable-drift",
      reportedVersion,
      authentication,
      catalog,
    });
  }
  return success(
    input,
    "codex-preflight",
    after,
    reportedVersion,
    processes,
    authentication,
    catalog,
  );
}

async function runClaudePreflight(
  value: unknown,
  host: NativePreflightHost,
  signal: AbortSignal | undefined,
  options: ResolveLimitsOptions = {},
): Promise<NativePreflightObservationV1> {
  const bounds = resolveNativePreflightLimits(options);
  const input = parseNativePreflightInputV1(value, "claude-code");
  const before = await inspectExecutable(host, input, signal);
  const processes: NativePreflightProcessEvidence[] = [];
  if (!matchesExecutablePolicy(before, input)) {
    return failure(input, "claude-code-preflight", before, processes, {
      code: "executable-drift",
      catalog: CLAUDE_UNOBSERVED_CATALOG,
    });
  }
  if (input.expectedExecutable.reportedVersion !== CLAUDE_PREFLIGHT_REPORTED_VERSION) {
    return failure(input, "claude-code-preflight", before, processes, {
      code: "executable-drift",
      catalog: CLAUDE_UNOBSERVED_CATALOG,
    });
  }

  const version = await runFixedCommand(
    host,
    input,
    "version",
    ["--version"],
    bounds.versionStdout.value,
    signal,
    "stdout",
    bounds,
  );
  processes.push(version.evidence);
  if (version.status === "failed") {
    return failure(input, "claude-code-preflight", before, processes, {
      code: version.code,
      catalog: CLAUDE_UNOBSERVED_CATALOG,
    });
  }
  const reportedVersion = parseSingleLine(version.text);
  if (reportedVersion !== CLAUDE_PREFLIGHT_REPORTED_VERSION) {
    return failure(input, "claude-code-preflight", before, processes, {
      code: "executable-drift",
      catalog: CLAUDE_UNOBSERVED_CATALOG,
    });
  }
  processes[0] = withProjection(version.evidence, { reportedVersion });

  const auth = await runFixedCommand(
    host,
    input,
    "authentication",
    ["auth", "status", "--json"],
    bounds.authenticationStdout.value,
    signal,
    "stdout",
    bounds,
  );
  processes.push(auth.evidence);
  if (auth.status === "failed") {
    return failure(input, "claude-code-preflight", before, processes, {
      code: auth.code,
      reportedVersion,
      catalog: CLAUDE_UNOBSERVED_CATALOG,
    });
  }
  const authProjection = parseClaudeEnterpriseAuthProjection(auth.text);
  if (authProjection === null) {
    return failure(input, "claude-code-preflight", before, processes, {
      code: "authentication-mismatch",
      reportedVersion,
      catalog: CLAUDE_UNOBSERVED_CATALOG,
    });
  }
  const authentication: AuthenticationEvidence = {
    status: "ready",
    mechanism: "claude.ai",
    providerClass: "anthropic-first-party",
    subscriptionClass: "enterprise",
    projectionSha256: canonicalDigest(authProjection),
  };
  processes[1] = withProjection(auth.evidence, authProjection);

  const after = await inspectExecutable(host, input, signal);
  if (!sameExecutable(before, after) || !matchesExecutablePolicy(after, input)) {
    return failure(input, "claude-code-preflight", after, processes, {
      code: "executable-drift",
      reportedVersion,
      authentication,
      catalog: CLAUDE_UNOBSERVED_CATALOG,
    });
  }
  return success(
    input,
    "claude-code-preflight",
    after,
    reportedVersion,
    processes,
    authentication,
    CLAUDE_UNOBSERVED_CATALOG,
  );
}

async function inspectExecutable(
  host: NativePreflightHost,
  input: NativePreflightInputV1,
  signal?: AbortSignal,
): Promise<NativeExecutableObservation> {
  try {
    const observation = await host.inspectExecutable(input.executablePath, signal);
    if (!validExecutableObservation(observation)) {
      throw new NativePreflightHostError("host-operation-failed");
    }
    return Object.freeze({ ...observation });
  } catch (error) {
    if (error instanceof NativePreflightHostError) throw error;
    throw new NativePreflightHostError(signal?.aborted ? "cancelled" : "host-operation-failed");
  }
}

async function runFixedCommand(
  host: NativePreflightHost,
  input: NativePreflightInputV1,
  operation: NativePreflightOperation,
  argumentsValue: readonly string[],
  maxStdoutBytes: number,
  signal: AbortSignal | undefined,
  expectedOutput: "stdout" | "stderr",
  bounds: NativePreflightResolvedLimits,
): Promise<CommandOutcome> {
  const argumentsSha256 = canonicalDigest({
    operation,
    arguments: argumentsValue,
  });
  let observation: NativePreflightProcessObservation;
  try {
    observation = await host.runProcess(
      Object.freeze({
        operation,
        executablePath: input.executablePath,
        arguments: Object.freeze([...argumentsValue]),
        environment: input.environment,
        timeoutMs: bounds.timeout.value,
        maxStdoutBytes,
        maxStderrBytes: bounds.maxStderr.value,
        ...(signal ? { signal } : {}),
      }),
    );
  } catch {
    return commandFailure("host-operation-failed", operation, argumentsSha256);
  }

  const evidence = processEvidence(operation, argumentsSha256, observation, bounds);
  if (observation.stdoutOverflow || observation.stderrOverflow) {
    return { status: "failed", code: "output-limit", evidence };
  }
  const invalidEnvelope = validateProcessObservation(observation, maxStdoutBytes, bounds);
  if (invalidEnvelope !== null) return { status: "failed", code: invalidEnvelope, evidence };
  const statusCode = processStatusCode(observation.status);
  if (statusCode !== null) return { status: "failed", code: statusCode, evidence };
  if (evidence.limitNotices.length > 0) {
    return { status: "failed", code: "evidence-limit", evidence };
  }
  if (observation.exitCode !== 0 || observation.signal !== null) {
    return { status: "failed", code: "process-failed", evidence };
  }
  const credentialText = Buffer.concat([observation.stdout, observation.stderr]).toString("latin1");
  if (detectCredentialRuleIds(credentialText).length > 0) {
    return { status: "failed", code: "credential-boundary", evidence };
  }
  const selected = expectedOutput === "stdout" ? observation.stdout : observation.stderr;
  const unselected = expectedOutput === "stdout" ? observation.stderr : observation.stdout;
  if (unselected.byteLength !== 0) {
    return { status: "failed", code: "malformed-output", evidence };
  }
  const text = strictUtf8(selected);
  if (text === null) return { status: "failed", code: "malformed-output", evidence };
  return { status: "completed", text, evidence };
}

function commandFailure(
  code: NativePreflightFailureCode,
  operation: NativePreflightOperation,
  argumentsSha256: string,
): CommandFailure {
  return {
    status: "failed",
    code,
    evidence: {
      operation,
      argumentsSha256,
      exitCode: null,
      durationMs: 0,
      stdoutBytes: 0,
      stderrBytes: 0,
      stdoutOverflow: false,
      stderrOverflow: false,
      limitNotices: EMPTY_LIMIT_NOTICES,
      projectionSha256: null,
    },
  };
}

function processEvidence(
  operation: NativePreflightOperation,
  argumentsSha256: string,
  observation: NativePreflightProcessObservation,
  bounds: NativePreflightResolvedLimits,
): NativePreflightProcessEvidence {
  const durationMs = measuredCount(observation.durationMs);
  const stdoutBytes = measuredCount(observation.stdoutBytes);
  const stderrBytes = measuredCount(observation.stderrBytes);
  return {
    operation,
    argumentsSha256,
    exitCode:
      Number.isSafeInteger(observation.exitCode) &&
      observation.exitCode !== null &&
      observation.exitCode >= 0 &&
      observation.exitCode <= 255
        ? observation.exitCode
        : null,
    durationMs,
    stdoutBytes,
    stderrBytes,
    stdoutOverflow: observation.stdoutOverflow === true,
    stderrOverflow: observation.stderrOverflow === true,
    limitNotices: recordingNotices(operation, { durationMs, stdoutBytes, stderrBytes }, bounds),
    projectionSha256: null,
  };
}

function measuredCount(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function recordingNotices(
  operation: NativePreflightOperation,
  counts: {
    readonly durationMs: number;
    readonly stdoutBytes: number;
    readonly stderrBytes: number;
  },
  bounds: NativePreflightResolvedLimits,
): readonly NativePreflightLimitNoticeV1[] {
  const notices: NativePreflightLimitNoticeV1[] = [];
  maybeNotice(notices, operation, bounds.recordedDuration, counts.durationMs);
  maybeNotice(notices, operation, bounds.recordedStdout, counts.stdoutBytes);
  maybeNotice(notices, operation, bounds.recordedStderr, counts.stderrBytes);
  return notices.length === 0 ? EMPTY_LIMIT_NOTICES : Object.freeze(notices);
}

function maybeNotice(
  notices: NativePreflightLimitNoticeV1[],
  operation: NativePreflightOperation,
  bound: ResolvedLimit,
  observed: number,
): void {
  if (observed <= bound.value) return;
  notices.push(limitNotice(operation, bound, observed));
}

/** One named limit notice, attributed to the process that produced the count. */
function limitNotice(
  operation: NativePreflightOperation,
  bound: ResolvedLimit,
  observed: number,
): NativePreflightLimitNoticeV1 {
  return Object.freeze({
    name: bound.name,
    observed,
    value: bound.value,
    unit: bound.unit,
    refusal: bound.refusal,
    message: formatLimitRefusal(bound, observed),
    source: `native-preflight:${operation}`,
  });
}

function validateProcessObservation(
  observation: NativePreflightProcessObservation,
  maxStdoutBytes: number,
  bounds: NativePreflightResolvedLimits,
): NativePreflightFailureCode | null {
  if (
    !observation ||
    typeof observation !== "object" ||
    !Buffer.isBuffer(observation.stdout) ||
    !Buffer.isBuffer(observation.stderr) ||
    !Number.isSafeInteger(observation.durationMs) ||
    observation.durationMs < 0 ||
    !Number.isSafeInteger(observation.stdoutBytes) ||
    !Number.isSafeInteger(observation.stderrBytes) ||
    observation.stdoutBytes !== observation.stdout.byteLength ||
    observation.stderrBytes !== observation.stderr.byteLength ||
    !["settled", "spawn-failed", "output-limit", "timeout", "cancelled"].includes(
      observation.status,
    )
  ) {
    return "malformed-output";
  }
  if (observation.stdoutOverflow || observation.stderrOverflow) return "output-limit";
  if (
    observation.stdoutBytes > maxStdoutBytes ||
    observation.stderrBytes > bounds.maxStderr.value
  ) {
    return "malformed-output";
  }
  return null;
}

function processStatusCode(
  status: NativePreflightProcessStatus,
): NativePreflightFailureCode | null {
  if (status === "settled") return null;
  if (status === "spawn-failed") return "spawn-failed";
  if (status === "output-limit") return "output-limit";
  return status;
}

function parseSingleLine(value: string): string | null {
  const normalized = value.endsWith("\n") ? value.slice(0, -1) : value;
  if (
    normalized.length === 0 ||
    normalized.length > 256 ||
    /\r|\n|\0/u.test(normalized) ||
    normalized.trim() !== normalized
  ) {
    return null;
  }
  return normalized;
}

type ParsedCodexCatalog =
  | { readonly status: "parsed"; readonly modelSlugs: readonly string[] }
  | { readonly status: "malformed" }
  | { readonly status: "limit"; readonly bound: ResolvedLimit; readonly observed: number };

/**
 * Parses either Codex catalog (bundled or account); only slugs are projected.
 * The model count and slug length are declared limits because the account
 * catalog is provider-controlled; exceeding one is a named limit, not
 * malformed output.
 */
function parseCodexModelSlugs(
  value: string,
  bounds: NativePreflightResolvedLimits,
): ParsedCodexCatalog {
  const malformed = { status: "malformed" } as const;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return malformed;
  }
  if (
    detectCredentialRuleIdsInValue(parsed).length > 0 ||
    !isPlainRecord(parsed) ||
    Object.keys(parsed).length !== 1 ||
    !Array.isArray(parsed.models) ||
    parsed.models.length === 0
  ) {
    return malformed;
  }
  if (parsed.models.length > bounds.catalogModelCount.value) {
    return { status: "limit", bound: bounds.catalogModelCount, observed: parsed.models.length };
  }
  const slugs: string[] = [];
  for (const model of parsed.models) {
    if (
      !isPlainRecord(model) ||
      typeof model.slug !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(model.slug)
    ) {
      return malformed;
    }
    if (model.slug.length > bounds.catalogSlugCharacters.value) {
      return {
        status: "limit",
        bound: bounds.catalogSlugCharacters,
        observed: model.slug.length,
      };
    }
    slugs.push(model.slug);
  }
  slugs.sort();
  return new Set(slugs).size === slugs.length
    ? { status: "parsed", modelSlugs: Object.freeze(slugs) }
    : malformed;
}

function parseClaudeEnterpriseAuthProjection(value: string): {
  readonly loggedIn: true;
  readonly authMethod: "claude.ai";
  readonly apiProvider: "firstParty";
  readonly subscriptionType: "enterprise";
} | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return null;
  }
  const expectedKeys = [
    "loggedIn",
    "authMethod",
    "apiProvider",
    "email",
    "orgId",
    "orgName",
    "subscriptionType",
  ];
  if (
    detectCredentialRuleIdsInValue(parsed).length > 0 ||
    !isPlainRecord(parsed) ||
    Object.keys(parsed)
      .sort()
      .some((key, index) => key !== [...expectedKeys].sort()[index]) ||
    Object.keys(parsed).length !== expectedKeys.length ||
    parsed.loggedIn !== true ||
    parsed.authMethod !== "claude.ai" ||
    parsed.apiProvider !== "firstParty" ||
    parsed.subscriptionType !== "enterprise" ||
    !boundedPrivateText(parsed.email, 320) ||
    !boundedPrivateText(parsed.orgId, 128) ||
    !boundedPrivateText(parsed.orgName, 256)
  ) {
    return null;
  }
  return Object.freeze({
    loggedIn: true,
    authMethod: "claude.ai",
    apiProvider: "firstParty",
    subscriptionType: "enterprise",
  });
}

function withProjection(
  evidence: NativePreflightProcessEvidence,
  projection: unknown,
): NativePreflightProcessEvidence {
  return { ...evidence, projectionSha256: canonicalDigest(projection) };
}

function success(
  input: NativePreflightInputV1,
  adapterId: NativePreflightAdapterId,
  executable: NativeExecutableObservation,
  reportedVersion: string,
  processes: readonly NativePreflightProcessEvidence[],
  authentication: AuthenticationEvidence,
  catalog: CatalogEvidence,
): NativePreflightObservationV1 {
  return buildObservation({
    input,
    adapterId,
    executable,
    reportedVersion,
    processes,
    authentication,
    catalog,
    terminalCode: "preflight-ready",
    reasonCodes: [],
  });
}

function failure(
  input: NativePreflightInputV1,
  adapterId: NativePreflightAdapterId,
  executable: NativeExecutableObservation,
  processes: readonly NativePreflightProcessEvidence[],
  options: {
    code: NativePreflightFailureCode;
    reportedVersion?: string;
    authentication?: AuthenticationEvidence;
    catalog: CatalogEvidence;
  },
): NativePreflightObservationV1 {
  return buildObservation({
    input,
    adapterId,
    executable,
    reportedVersion: options.reportedVersion ?? "not-attested",
    processes,
    authentication: options.authentication ?? EMPTY_AUTHENTICATION,
    catalog: options.catalog,
    terminalCode: options.code,
    reasonCodes: [options.code],
  });
}

function buildObservation(input: {
  input: NativePreflightInputV1;
  adapterId: NativePreflightAdapterId;
  executable: NativeExecutableObservation;
  reportedVersion: string;
  processes: readonly NativePreflightProcessEvidence[];
  authentication: AuthenticationEvidence;
  catalog: CatalogEvidence;
  terminalCode: NativePreflightObservationV1["terminalCode"];
  reasonCodes: readonly NativePreflightFailureCode[];
}): NativePreflightObservationV1 {
  return sealNativePreflightObservationV1({
    adapterVersion: NATIVE_PREFLIGHT_ADAPTER_VERSION,
    adapterId: input.adapterId,
    harnessId: input.input.harnessId,
    routeId: input.input.routeId,
    executionClass: "preflight-only",
    capabilities: { modelEgress: "unavailable", workflowExecution: "unavailable" },
    requestedModel: input.input.requestedModel,
    observedModel: null,
    executable: {
      basename: input.input.expectedExecutable.basename,
      pathSha256: canonicalDigest({ canonicalPath: input.executable.canonicalPath }),
      sha256: input.executable.sha256,
      identitySha256: input.executable.identitySha256,
      reportedVersion: input.reportedVersion,
    },
    environment: {
      variableNames: Object.keys(input.input.environment).sort(),
      policySha256: canonicalDigest({
        version: 1,
        completeChildEnvironment: true,
        allowedNames: NATIVE_PREFLIGHT_ENVIRONMENT_NAMES,
        suppliedNames: Object.keys(input.input.environment).sort(),
        absolutePathNames: ["HOME", "TMPDIR"],
        ambientMerge: false,
      }),
    },
    authentication: input.authentication,
    catalog: input.catalog,
    processes: input.processes,
    terminalCode: input.terminalCode,
    reasonCodes: input.reasonCodes,
  });
}

function validExecutableObservation(value: NativeExecutableObservation): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    canonicalAbsolutePath(value.canonicalPath) &&
    ["codex", "codex.exe", "claude", "claude.exe"].includes(value.basename) &&
    basename(value.canonicalPath) === value.basename &&
    /^[a-f0-9]{64}$/u.test(value.sha256) &&
    /^[a-f0-9]{64}$/u.test(value.identitySha256) &&
    typeof value.trusted === "boolean"
  );
}

function matchesExecutablePolicy(
  observed: NativeExecutableObservation,
  input: NativePreflightInputV1,
): boolean {
  return (
    observed.trusted &&
    observed.canonicalPath === input.executablePath &&
    observed.basename === input.expectedExecutable.basename &&
    observed.sha256 === input.expectedExecutable.sha256 &&
    observed.identitySha256 === input.expectedExecutable.identitySha256
  );
}

function sameExecutable(
  before: NativeExecutableObservation,
  after: NativeExecutableObservation,
): boolean {
  return (
    before.canonicalPath === after.canonicalPath &&
    before.basename === after.basename &&
    before.sha256 === after.sha256 &&
    before.identitySha256 === after.identitySha256 &&
    before.trusted === after.trusted
  );
}

function strictUtf8(value: Uint8Array): string | null {
  try {
    const result = new TextDecoder("utf-8", { fatal: true }).decode(value);
    return result.includes("\0") || result !== result.normalize("NFC") ? null : result;
  } catch {
    return null;
  }
}

function boundedPrivateText(value: unknown, maximum: number): boolean {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    !/[\r\n\0]/u.test(value) &&
    value === value.normalize("NFC")
  );
}

function canonicalAbsolutePath(value: string): boolean {
  return isAbsolute(value) && resolve(value) === value;
}

export class NativePreflightHostError extends Error {
  public constructor(public readonly code: "cancelled" | "host-operation-failed") {
    super(`Native composition preflight host failed (${code}).`);
    this.name = "NativePreflightHostError";
  }
}
