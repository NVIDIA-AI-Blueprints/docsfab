// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";

import {
  describeSkippedHostLimitFile,
  readConfigurationRootLimitOverrides,
  readHostLimitOverrides,
  resolveHostLimitFile,
  skippedHostLimitFile,
} from "./host-limit-file.js";
import { resolveDocsFabConfigurationRoot } from "./host-paths.js";
import {
  parseLimitOverride,
  resolveLimitDefinitions,
  RETIRED_LIMIT_NAME_WARNING,
  retiredEnvironmentLimitNames,
  retiredHostLimitNames,
  type SkippedHostLimitFile,
} from "./limit-resolution.js";
import {
  LIMIT_DEFINITION_BY_NAME,
  LIMIT_DEFINITIONS,
  type LimitDefinition,
} from "./limits.generated.js";
import {
  CONTRACT_DECODE_BOUND_AXES,
  DELEGATED_TASK_STATE_BYTE_LIMIT,
  installContractDecodeLimitSnapshot,
  type ContractDecodeLimitSnapshot,
} from "../contract-kit/decode-bounds.js";
import {
  installReviewRichFieldLimitSnapshot,
  type ReviewRichFieldLimitSnapshot,
} from "./limit-snapshot.js";
import { decodeHostConfig, projectHostConfigToEnvironment } from "./profile-projection.js";

import { readRunLimitObservations } from "./limits-observations.js";

export {
  persistHostedLimitObservations,
  projectRunLimitObservations,
  resolveHostedLimitObservationsDirectory,
  LimitObservationError,
} from "./limits-observations.js";
export type {
  PersistHostedLimitObservationsInput,
  ProjectRunLimitObservationsInput,
} from "./limits-observations.js";

export type { LimitDefinition, LimitScope } from "./limits.generated.js";
import { isRecord } from "../shared/primitives.js";
export { LIMIT_DEFINITION_BY_NAME, LIMIT_DEFINITIONS };
export { parseLimitOverride };

export type LimitSource = "config/limits.yaml" | "host" | "project";

export interface ResolvedLimit {
  readonly name: string;
  readonly value: number;
  readonly source: LimitSource;
  readonly unit: string;
  readonly warnAt: number;
  readonly refusal: string;
  readonly remediation: string;
}

export interface LimitDoctorRow {
  readonly name: string;
  readonly value: number;
  readonly unit: string;
  readonly source: LimitSource;
  readonly observedMaxSeen: number | null;
  readonly headroomPercent: number | null;
  readonly status: "unknown" | "ok" | "warn" | "over";
}

export interface LimitDoctorReport {
  readonly schemaVersion: 1;
  readonly kind: "docsfab-doctor-limits";
  readonly rows: readonly LimitDoctorRow[];
  readonly status: "unknown" | "ok" | "warn" | "over";
  readonly exitCode: 0 | 1 | 3;
  /** Composition-specific records-path fit projections, when requested by doctor. */
  readonly answerSubmissionRecordsFits?: readonly AnswerSubmissionRecordsLimitProjection[];
  /**
   * The installed host limits file skipped because this user cannot read it.
   * Present only then, so a service that reads its own file reports the same
   * keys as before.
   */
  readonly hostLimitsFile?: SkippedHostLimitFile;
}

export interface AnswerSubmissionRecordsLimitProjection {
  readonly compositionId: string;
  readonly qualification: "qualified" | "unqualified";
  readonly fitStatus: "fits" | "does-not-fit" | "unqualified";
  readonly reason?: string;
  readonly predictedTimerMs: number | null;
  readonly timerReviewLimitMs: number | null;
  readonly effectiveMaxOutputTokens: number;
  readonly effectiveTimeoutMs: number;
  readonly requiredReadingTurns: number | null;
  readonly effectiveMaxProviderTurns: number;
  readonly effectiveMessageBudgetBytes: number | null;
  readonly largestRecordEnvelopeBytes: number | null;
  readonly recordCallCeiling: number;
  readonly recordCallCeilingProvenance: string;
  readonly evidenceProvenance: string;
}

export interface ResolveLimitsOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly hostFile?: string | null;
  readonly projectFile?: string | null;
  readonly cwd?: string;
  /** Caller-resolved from credential-free installed metadata and canonical plans. */
  readonly answerSubmissionRecordsFits?: readonly AnswerSubmissionRecordsLimitProjection[];
}

/**
 * Load only limit-relevant host configuration into a cloned environment.
 * This follows the ordinary runtime precedence without importing provider
 * credentials into the doctor report path.
 */
export function loadEffectiveLimitEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const configurationRoot = resolveDocsFabConfigurationRoot(environment);
  const effective = readConfigurationRootLimitOverrides(environment, configurationRoot).environment;
  const hostPath = resolve(configurationRoot, "host.yaml");
  if (existsSync(hostPath)) {
    const host = decodeHostConfig(parseYaml(readFileSync(hostPath, "utf8")));
    projectHostConfigToEnvironment(host, effective, configurationRoot);
    // The run-record directory resolves as resolveDocsFabStateDirectory orders
    // it: an exported DOCSFAB_STATE_DIR, then host.yaml, so the projection
    // above must not replace the caller's value.
    if (environment.DOCSFAB_STATE_DIR === undefined) delete effective.DOCSFAB_STATE_DIR;
    else effective.DOCSFAB_STATE_DIR = environment.DOCSFAB_STATE_DIR;
  }
  return effective;
}

export function limitDefinition(name: string): LimitDefinition {
  const definition = LIMIT_DEFINITION_BY_NAME[name];
  if (!definition) {
    throw new Error(`Unknown operational limit ${name} is not declared in config/limits.yaml.`);
  }
  return definition;
}

/** Closed axis plus the actual observation that crossed it. */
export interface LimitOverflowObservationV1 {
  readonly limitName: string;
  readonly observed?: number;
}

/** Recover-class operator line for a named limit that has been exceeded. */
export function formatLimitObservation(
  limit: Pick<ResolvedLimit, "refusal" | "name" | "value" | "unit" | "remediation">,
  observed: number,
): string {
  return `${limit.refusal}: ${observed} exceeds ${limit.name} = ${limit.value} ${limit.unit}. ${limit.remediation} Follow the named remediation.`;
}

export function formatLimitRefusal(limit: ResolvedLimit, observed: number): string {
  return formatLimitObservation(limit, observed);
}

/**
 * Recover-class operator line when the closed axis is known but the exact
 * pre-truncation observation was not persisted. Does not invent bound plus one.
 */
export function formatLimitExceeded(limit: ResolvedLimit): string {
  return `${limit.refusal}: exceeded ${limit.name} = ${limit.value} ${limit.unit}. ${limit.remediation} Follow the named remediation.`;
}

export function formatLimitOverflow(
  limit: ResolvedLimit,
  overflow?: LimitOverflowObservationV1,
): string {
  return typeof overflow?.observed === "number"
    ? formatLimitObservation(limit, overflow.observed)
    : formatLimitExceeded(limit);
}

/**
 * A refusal at a catalogued limit. `code` is the limit's own catalog refusal,
 * so the run records the bound by name instead of an uncoded error.
 */
export class OperationalLimitError extends Error {
  public readonly code: string;
  public readonly limitName: string;
  public readonly configured: number;
  public readonly observed: number;
  public readonly unit: string;

  public constructor(limit: ResolvedLimit, observed: number) {
    // `name` stays "Error": operator text that renders the error keeps its shape.
    super(formatLimitObservation(limit, observed));
    this.code = limit.refusal;
    this.limitName = limit.name;
    this.configured = limit.value;
    this.observed = observed;
    this.unit = limit.unit;
  }
}

export function refuseLimit(limit: ResolvedLimit, observed: number): never {
  throw new OperationalLimitError(limit, observed);
}

export function enforceLimit(limit: ResolvedLimit, observed: number): void {
  if (observed > limit.value) refuseLimit(limit, observed);
}

/** Host file or environment, and retired name, pairs this process has already reported. */
const reportedRetiredLimitNames = new Set<string>();

/**
 * Report, once per process for each host file or the environment and each
 * retired name, a limit name or override variable still set there though
 * DocsFab no longer reads it, naming the limit that replaced it. Written to
 * stderr, as other `WARNING <code>:` signals are, so it reaches the operator
 * and stays out of `--json` stdout.
 */
function reportRetiredHostLimitNames(
  hostValues: Map<string, string>,
  hostFile: string | undefined,
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>,
): void {
  const sources = [
    ...retiredHostLimitNames(hostValues).map((entry) => ({
      ...entry,
      key: hostFile ?? "",
      setter: `the host limits file ${hostFile ?? "in use"}`,
    })),
    ...retiredEnvironmentLimitNames(environment).map((entry) => ({
      ...entry,
      key: "\0environment",
      setter: "the environment",
    })),
  ];
  for (const { name, replacements, key: setterKey, setter } of sources) {
    const key = `${setterKey}\0${name}`;
    if (reportedRetiredLimitNames.has(key)) continue;
    reportedRetiredLimitNames.add(key);
    const named = replacements.map((replacement) => {
      const override = LIMIT_DEFINITION_BY_NAME[replacement]?.override;
      return `${replacement}${override ? ` or ${override}` : ""}`;
    });
    process.stderr.write(
      `WARNING ${RETIRED_LIMIT_NAME_WARNING}: ${setter} sets ${name}, which DocsFab no longer reads, so its value is ignored. ${named.length === 1 ? `Set ${named[0]} instead.` : `Set the limits that replaced it instead: ${named.join("; ")}.`}\n`,
    );
  }
}

export function resolveLimits(options: ResolveLimitsOptions = {}): readonly ResolvedLimit[] {
  const environment = options.environment ?? process.env;
  const hostValues = readHostLimitOverrides(options.hostFile, environment);
  reportRetiredHostLimitNames(
    hostValues,
    resolveHostLimitFile(options.hostFile, environment),
    environment,
  );
  const projectValues = readProjectOverrides(options.projectFile, environment, options.cwd);
  return resolveLimitDefinitions(LIMIT_DEFINITIONS, {
    environment,
    hostValues,
    projectValues,
  }) as readonly ResolvedLimit[];
}

export function limit(name: string, options: ResolveLimitsOptions = {}): ResolvedLimit {
  const resolved = resolveLimits(options).find((entry) => entry.name === name);
  if (!resolved) {
    throw new Error(`Unknown operational limit ${name} is not declared in config/limits.yaml.`);
  }
  return resolved;
}

function requiredResolvedLimit(resolved: readonly ResolvedLimit[], name: string): number {
  const entry = resolved.find((candidate) => candidate.name === name);
  if (!entry) {
    throw new Error(`Contract decode limit ${name} is missing from the resolved catalog.`);
  }
  return entry.value;
}

function contractDecodeSnapshotFromResolved(
  resolved: readonly ResolvedLimit[],
): ContractDecodeLimitSnapshot {
  return {
    maxNodes: requiredResolvedLimit(resolved, CONTRACT_DECODE_BOUND_AXES.maxNodes),
    maxDepth: requiredResolvedLimit(resolved, CONTRACT_DECODE_BOUND_AXES.maxDepth),
    maxArrayLength: requiredResolvedLimit(resolved, CONTRACT_DECODE_BOUND_AXES.maxArrayLength),
    maxStringChars: requiredResolvedLimit(resolved, CONTRACT_DECODE_BOUND_AXES.maxStringChars),
    stateMaxBytes: requiredResolvedLimit(resolved, DELEGATED_TASK_STATE_BYTE_LIMIT),
  };
}

/**
 * Validate host and project overrides, then publish the contract-kit decode
 * ceilings and the delegated-task record byte bound to the decoder snapshot,
 * so a permitted shrink is the bound the inert walk enforces, not a leftover
 * catalog constant.
 */
export function activateContractDecodeLimits(
  options: ResolveLimitsOptions = {},
): readonly ResolvedLimit[] {
  const resolved = resolveLimits(options);
  const decodeSnapshot = contractDecodeSnapshotFromResolved(resolved);
  const richSnapshot: ReviewRichFieldLimitSnapshot = {
    "technicalCorrection.fieldMaxChars": requiredResolvedLimit(
      resolved,
      "technicalCorrection.fieldMaxChars",
    ),
    "technicalCorrection.proseMaxChars": requiredResolvedLimit(
      resolved,
      "technicalCorrection.proseMaxChars",
    ),
  };
  installContractDecodeLimitSnapshot(decodeSnapshot);
  installReviewRichFieldLimitSnapshot(richSnapshot);
  return resolved;
}

function readProjectOverrides(
  projectFile: string | null | undefined,
  environment: NodeJS.ProcessEnv,
  cwd = process.cwd(),
): Map<string, number> {
  const values = new Map<string, number>();
  const path = resolveProjectFile(projectFile, environment, cwd);
  if (!path || !existsSync(path)) return values;
  const parsed = parseYaml(readFileSync(path, "utf8"));
  const root = isRecord(parsed) && isRecord(parsed.limits) ? parsed.limits : parsed;
  if (!isRecord(root)) {
    throw new Error(`Project limits file ${path} must be a mapping of limit names to numbers.`);
  }
  for (const [name, value] of Object.entries(root)) {
    if (!LIMIT_DEFINITION_BY_NAME[name]) {
      throw new Error(`Project limits file ${path} contains unknown operational limit ${name}.`);
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`Project limits file ${path} has a non-numeric override for ${name}.`);
    }
    values.set(name, value);
  }
  return values;
}

function resolveProjectFile(
  projectFile: string | null | undefined,
  environment: NodeJS.ProcessEnv,
  cwd: string,
): string | undefined {
  if (projectFile === null) return undefined;
  if (projectFile) return projectFile;
  const configured = environment.DOCSFAB_PROJECT_LIMITS_FILE?.trim();
  if (configured) return configured;
  const candidate = resolve(cwd, ".docsfab/limits.yaml");
  return existsSync(candidate) ? candidate : undefined;
}

export async function inspectLimits(
  options: ResolveLimitsOptions = {},
): Promise<LimitDoctorReport> {
  const environment = options.environment ?? process.env;
  const resolved = activateContractDecodeLimits(options);
  const hostLimitsFile = skippedHostLimitFile(options.hostFile, environment);
  const observed = await readRunLimitObservations({
    environment,
    cwd: options.cwd ?? process.cwd(),
  });
  const rows = resolved.map((limitRow) => formatDoctorRow(limitRow, observed[limitRow.name]));
  const status = rows.some((row) => row.status === "over")
    ? "over"
    : options.answerSubmissionRecordsFits?.some((entry) => entry.fitStatus === "does-not-fit")
      ? "over"
      : rows.some((row) => row.status === "warn")
        ? "warn"
        : rows.some((row) => row.status === "unknown") ||
            options.answerSubmissionRecordsFits?.some((entry) => entry.fitStatus === "unqualified")
          ? "unknown"
          : "ok";
  return Object.freeze({
    schemaVersion: 1,
    kind: "docsfab-doctor-limits",
    rows,
    status,
    exitCode: status === "over" ? 1 : status === "warn" ? 3 : 0,
    ...(options.answerSubmissionRecordsFits && options.answerSubmissionRecordsFits.length > 0
      ? { answerSubmissionRecordsFits: options.answerSubmissionRecordsFits }
      : {}),
    ...(hostLimitsFile ? { hostLimitsFile } : {}),
  });
}

function formatDoctorRow(limitRow: ResolvedLimit, observed: number | undefined): LimitDoctorRow {
  const observedMaxSeen = observed === undefined ? null : observed;
  // This named setting is a delivery mode: zero means retain every chunk,
  // unlike a zero retry budget, which still permits no retries.
  const completeSlackAnswer =
    limitRow.name === "host.slack.liveAgentAnswerMaxChunks" && limitRow.value === 0;
  const headroomPercent =
    observedMaxSeen === null || completeSlackAnswer
      ? null
      : limitRow.value === 0
        ? observedMaxSeen === 0
          ? 100
          : 0
        : Math.max(0, Math.round((1 - observedMaxSeen / limitRow.value) * 100));
  const status =
    observedMaxSeen === null
      ? "unknown"
      : completeSlackAnswer
        ? "ok"
        : observedMaxSeen > limitRow.value
          ? "over"
          : limitRow.value > 0 && observedMaxSeen >= limitRow.value * limitRow.warnAt
            ? "warn"
            : "ok";
  return Object.freeze({
    name: limitRow.name,
    value: limitRow.value,
    unit: limitRow.unit,
    source: limitRow.source,
    observedMaxSeen,
    headroomPercent,
    status,
  });
}

export function formatLimitsTable(report: LimitDoctorReport): string {
  const header = "name | value | unit | source | observed-max-seen | headroom% | status";
  const rows = report.rows.map((row) =>
    [
      row.name,
      String(row.value),
      row.unit,
      row.source,
      row.observedMaxSeen === null ? "n/a" : String(row.observedMaxSeen),
      row.headroomPercent === null ? "n/a" : String(row.headroomPercent),
      row.status,
    ].join(" | "),
  );
  const notice = report.hostLimitsFile ? [describeSkippedHostLimitFile(report.hostLimitsFile)] : [];
  const records = report.answerSubmissionRecordsFits ?? [];
  const recordsLines =
    records.length === 0
      ? []
      : [
          "",
          "composition records | predicted-T* | review-threshold-ms | effective-output-tokens | effective-timeout-ms | reading-turns-required/effective | message-budget/largest-record-bytes | record-call-ceiling | qualification | fit | provenance",
          ...records.map((entry) =>
            [
              entry.compositionId,
              entry.predictedTimerMs === null ? "unqualified" : String(entry.predictedTimerMs),
              entry.timerReviewLimitMs === null ? "n/a" : String(entry.timerReviewLimitMs),
              String(entry.effectiveMaxOutputTokens),
              String(entry.effectiveTimeoutMs),
              `${entry.requiredReadingTurns ?? "n/a"}/${entry.effectiveMaxProviderTurns}`,
              `${entry.effectiveMessageBudgetBytes ?? "n/a"}/${entry.largestRecordEnvelopeBytes ?? "n/a"}`,
              String(entry.recordCallCeiling),
              entry.qualification,
              entry.fitStatus,
              [
                ...(entry.reason ? [entry.reason] : []),
                entry.recordCallCeilingProvenance,
                entry.evidenceProvenance,
              ].join("; "),
            ].join(" | "),
          ),
        ];
  return [...notice, header, ...rows, ...recordsLines].join("\n");
}
