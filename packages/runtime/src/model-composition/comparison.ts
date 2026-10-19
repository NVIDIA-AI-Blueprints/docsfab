// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { constants, type Stats } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, parse, resolve, sep } from "node:path";

import { deepFreeze } from "../contract-kit/index.js";
import { canonicalDigest } from "../content-ir/canonical.js";
import { decodeSuccessfulPublicationRunRecord } from "../delivery/run-record.js";
import { parseJsonEvidence } from "../json-evidence.js";
import type { RunRecord } from "../records/contracts.js";
import type { WorkflowOutcomeDecodeOptionsV1 } from "../workflow-contracts/outcome.js";
import {
  parseCompositionExecutionAggregate,
  parseCompositionExecutionEvidence,
} from "../records/composition-execution.js";
import { detectCredentialRuleIdsInValue } from "../security/repository-scanner.js";
import {
  loadInstalledModelCompositionAuthority,
  resolveInstalledExecutableComposition,
} from "./installed.js";
import type { BoundExecutableComposition, InstalledModelCompositionAuthority } from "./types.js";

export const COMPOSITION_COMPARISON_KIND = "docsfab-composition-comparison/v1" as const;
export const MAX_COMPOSITION_COMPARISON_RECORDS = 8;
export const MAX_COMPOSITION_COMPARISON_RECORD_BYTES = 16 * 1024 * 1024;

export type CompositionComparisonMismatchCode =
  | "duplicate-composition"
  | "workflow-mismatch"
  | "repository-mismatch"
  | "task-mismatch"
  | "quality-pack-mismatch"
  | "skill-set-mismatch"
  | "context-input-mismatch"
  | "experiment-budget-mismatch";

export type CompositionComparisonErrorCode =
  | "invalid-record-count"
  | "invalid-record-path"
  | "unsafe-record-file"
  | "record-too-large"
  | "credential-material"
  | "invalid-run-record";

export class CompositionComparisonError extends Error {
  public constructor(public readonly code: CompositionComparisonErrorCode) {
    super(`Composition comparison rejected (${code}).`);
    this.name = "CompositionComparisonError";
  }
}

export interface CompositionComparisonRunMetricsV1 {
  readonly compositionId: string;
  readonly compositionEvidenceSha256: string;
  readonly aggregateSha256: string;
  readonly runIdSha256: string;
  readonly fixtureBindingSha256: string;
  readonly providerPayloadLedgerSha256: string;
  readonly durationMs: number;
  readonly usage: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
    readonly total: number;
    readonly turns: number;
  };
  readonly tools: {
    readonly totalCalls: number;
    readonly failedCalls: number;
  };
  readonly attempts: number;
  readonly productDisposition:
    | "ready"
    | "not-ready"
    | "needs-input"
    | "inconclusive"
    | "blocked"
    | "unavailable";
  readonly quality: {
    readonly result: "unavailable";
    readonly score: null;
  };
}

interface CompositionComparisonBodyV1 {
  readonly comparable: boolean;
  readonly mismatchCode: CompositionComparisonMismatchCode | null;
  readonly comparisonBindingSha256: string | null;
  readonly runs: readonly CompositionComparisonRunMetricsV1[];
  readonly ranking: {
    readonly winnerCompositionId: null;
    readonly reason: "quality-efficacy-unavailable";
  };
  readonly limitations: readonly [
    "provider-offline-record-comparison",
    "quality-efficacy-unavailable",
    "no-technical-approval",
    "strict-publication-records-only",
    "run-provenance-not-independently-attested",
  ];
}

export interface CompositionComparisonReportV1 extends CompositionComparisonBodyV1 {
  readonly schemaVersion: 1;
  readonly kind: typeof COMPOSITION_COMPARISON_KIND;
  readonly reportSha256: string;
}

interface FixtureProjection {
  readonly workflow: unknown;
  readonly repository: unknown;
  readonly task: unknown;
  readonly qualityPack: unknown;
  readonly skills: unknown;
  readonly context: unknown;
  readonly budget: unknown;
}

interface AdmittedComparisonRecord {
  readonly record: RunRecord;
  readonly compositionId: string;
  readonly evidenceSha256: string;
  readonly aggregateSha256: string;
  readonly fixture: FixtureProjection;
  readonly fixtureBindingSha256: string;
}

export interface CompositionComparisonDecodeOptionsV1 {
  resolveWorkflowOutcomeDecodeOptions?: (
    record: Readonly<RunRecord>,
    recordPath: string,
  ) => Promise<WorkflowOutcomeDecodeOptionsV1 | undefined>;
}

/** Load and compare immutable terminal composition records without provider I/O. */
export async function compareCompositionRunRecordFiles(
  paths: readonly string[],
  options: CompositionComparisonDecodeOptionsV1 = {},
): Promise<CompositionComparisonReportV1> {
  assertRecordCount(paths.length);
  const { authority } = await loadInstalledModelCompositionAuthority();
  const records = await Promise.all(
    paths.map((path) => loadCompositionComparisonRunRecord(path, authority, options)),
  );
  return createCompositionComparisonReport(records);
}

/** Strictly admit one bounded, non-symlinked terminal run-record leaf. */
async function loadCompositionComparisonRunRecord(
  path: string,
  authority: InstalledModelCompositionAuthority,
  options: CompositionComparisonDecodeOptionsV1,
): Promise<AdmittedComparisonRecord> {
  if (!isAbsolute(path) || path !== resolve(path) || path.length > 4_096 || path.includes("\0")) {
    throw new CompositionComparisonError("invalid-record-path");
  }
  if (typeof constants.O_NOFOLLOW !== "number") {
    throw new CompositionComparisonError("unsafe-record-file");
  }

  const ancestorBefore = await inspectAncestors(path);
  const before = await safeLeafStat(path);
  assertRegularBoundedFile(before);
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    assertSameFile(before, opened);
    assertRegularBoundedFile(opened);
    const bytes = await handle.readFile();
    if (bytes.byteLength > MAX_COMPOSITION_COMPARISON_RECORD_BYTES) {
      throw new CompositionComparisonError("record-too-large");
    }
    const openedAfter = await handle.stat();
    const after = await safeLeafStat(path);
    assertSameFile(opened, openedAfter);
    assertSameFile(opened, after);
    await assertAncestorsUnchanged(ancestorBefore);
    return await admitRunRecordBytes(bytes, authority, path, options);
  } catch (error) {
    if (error instanceof CompositionComparisonError) throw error;
    throw new CompositionComparisonError("unsafe-record-file");
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch {
        throw new CompositionComparisonError("unsafe-record-file");
      }
    }
  }
}

/** Create a sealed, credential-free report from strictly decoded records. */
function createCompositionComparisonReport(
  records: readonly AdmittedComparisonRecord[],
): CompositionComparisonReportV1 {
  assertRecordCount(records.length);
  const mismatchCode = firstMismatch(records);
  const comparable = mismatchCode === null;
  const body: CompositionComparisonBodyV1 = {
    comparable,
    mismatchCode,
    comparisonBindingSha256: comparable ? records[0]!.fixtureBindingSha256 : null,
    runs: records.map(projectMetrics),
    ranking: {
      winnerCompositionId: null,
      reason: "quality-efficacy-unavailable",
    },
    limitations: [
      "provider-offline-record-comparison",
      "quality-efficacy-unavailable",
      "no-technical-approval",
      "strict-publication-records-only",
      "run-provenance-not-independently-attested",
    ],
  };
  const envelope = {
    schemaVersion: 1 as const,
    kind: COMPOSITION_COMPARISON_KIND,
    ...body,
  };
  const report = { ...envelope, reportSha256: canonicalDigest(envelope) };
  return parseCompositionComparisonReport(report);
}

/** Strictly verify a persisted comparison report and its content digest. */
export function parseCompositionComparisonReport(value: unknown): CompositionComparisonReportV1 {
  if (detectCredentialRuleIdsInValue(value).length > 0) {
    throw new CompositionComparisonError("credential-material");
  }
  const root = comparisonObject(value);
  comparisonExact(root, [
    "schemaVersion",
    "kind",
    "comparable",
    "mismatchCode",
    "comparisonBindingSha256",
    "runs",
    "ranking",
    "limitations",
    "reportSha256",
  ]);
  if (root.schemaVersion !== 1 || root.kind !== COMPOSITION_COMPARISON_KIND) {
    // hygiene: envelope -- comparison refusal codes are returned to the CLI caller.
    throw new CompositionComparisonError("invalid-run-record");
  }
  const comparable = root.comparable;
  const mismatchCode = root.mismatchCode;
  const comparisonBindingSha256 = root.comparisonBindingSha256;
  const mismatches: readonly CompositionComparisonMismatchCode[] = [
    "duplicate-composition",
    "workflow-mismatch",
    "repository-mismatch",
    "task-mismatch",
    "quality-pack-mismatch",
    "skill-set-mismatch",
    "context-input-mismatch",
    "experiment-budget-mismatch",
  ];
  if (
    typeof comparable !== "boolean" ||
    (comparable && (mismatchCode !== null || !comparisonDigest(comparisonBindingSha256))) ||
    (!comparable &&
      (!mismatches.includes(mismatchCode as CompositionComparisonMismatchCode) ||
        comparisonBindingSha256 !== null))
  ) {
    // hygiene: envelope -- comparison refusal codes are returned to the CLI caller.
    throw new CompositionComparisonError("invalid-run-record");
  }
  if (!Array.isArray(root.runs)) throw new CompositionComparisonError("invalid-run-record");
  assertRecordCount(root.runs.length);
  const runs = root.runs.map(parseRunMetrics);
  if (comparable && new Set(runs.map((run) => run.compositionId)).size !== runs.length) {
    throw new CompositionComparisonError("invalid-run-record");
  }
  const ranking = comparisonObject(root.ranking);
  comparisonExact(ranking, ["winnerCompositionId", "reason"]);
  if (ranking.winnerCompositionId !== null || ranking.reason !== "quality-efficacy-unavailable") {
    throw new CompositionComparisonError("invalid-run-record");
  }
  const expectedLimitations = [
    "provider-offline-record-comparison",
    "quality-efficacy-unavailable",
    "no-technical-approval",
    "strict-publication-records-only",
    "run-provenance-not-independently-attested",
  ] as const;
  if (
    !Array.isArray(root.limitations) ||
    canonicalDigest(root.limitations) !== canonicalDigest(expectedLimitations)
  ) {
    throw new CompositionComparisonError("invalid-run-record");
  }
  if (!comparisonDigest(root.reportSha256)) {
    throw new CompositionComparisonError("invalid-run-record");
  }
  const { reportSha256: _digest, ...body } = root;
  if (root.reportSha256 !== canonicalDigest(body)) {
    throw new CompositionComparisonError("invalid-run-record");
  }
  return deepFreeze(structuredClone(root) as unknown as CompositionComparisonReportV1);
}

async function admitRunRecordBytes(
  bytes: Uint8Array,
  authority: InstalledModelCompositionAuthority,
  path: string,
  options: CompositionComparisonDecodeOptionsV1,
): Promise<AdmittedComparisonRecord> {
  let value: unknown;
  try {
    value = parseJsonEvidence(bytes);
  } catch {
    throw new CompositionComparisonError("invalid-run-record");
  }
  return admitRunRecordValue(value, authority, path, options);
}

async function admitRunRecordValue(
  value: unknown,
  authority: InstalledModelCompositionAuthority,
  path: string,
  options: CompositionComparisonDecodeOptionsV1,
): Promise<AdmittedComparisonRecord> {
  if (detectCredentialRuleIdsInValue(value).length > 0) {
    throw new CompositionComparisonError("credential-material");
  }
  let record: RunRecord;
  try {
    const decodeOptions = await options.resolveWorkflowOutcomeDecodeOptions?.(
      value as RunRecord,
      path,
    );
    record = decodeSuccessfulPublicationRunRecord(value, decodeOptions);
  } catch {
    throw new CompositionComparisonError("invalid-run-record");
  }
  // Composition comparison is a fresh-run qualification surface. A child
  // continuation has physically executed only its suffix and cannot be
  // compared as if its inherited prefix were a new qualification run.
  if (record.answerRecordContinuation !== undefined) {
    throw new CompositionComparisonError("invalid-run-record");
  }
  const execution = record.compositionExecution
    ? parseCompositionExecutionEvidence(record.compositionExecution)
    : undefined;
  const aggregate = record.compositionExecutionAggregate
    ? parseCompositionExecutionAggregate(record.compositionExecutionAggregate)
    : undefined;
  if (!execution || !aggregate || record.status !== "succeeded") {
    // hygiene: envelope -- comparison refusal codes are returned to the CLI caller.
    throw new CompositionComparisonError("invalid-run-record");
  }
  assertInstalledCompositionAuthority(execution, authority);
  const fixture = fixtureProjection(record);
  return {
    record,
    compositionId: execution.compositionId,
    evidenceSha256: execution.evidenceSha256,
    aggregateSha256: aggregate.aggregateSha256,
    fixture,
    fixtureBindingSha256: canonicalDigest(fixture),
  };
}

function assertInstalledCompositionAuthority(
  execution: NonNullable<RunRecord["compositionExecution"]>,
  authority: InstalledModelCompositionAuthority,
): void {
  let bound: BoundExecutableComposition;
  try {
    bound = resolveInstalledExecutableComposition({
      authority,
      compositionId: execution.compositionId,
      workflowId: execution.workflow.id,
    });
  } catch {
    throw new CompositionComparisonError("invalid-run-record");
  }
  const expected = {
    compositionId: bound.composition.compositionId,
    model: bound.composition.model,
    deployment: {
      provider: bound.composition.deployment.provider,
      routeId: bound.composition.deployment.routeId,
      transport: bound.composition.deployment.transport,
      bindingKind: bound.composition.deployment.bindingKind,
      identitySha256: bound.composition.deployment.identitySha256,
      region: bound.composition.deployment.region,
    },
    authentication: {
      route: bound.composition.authentication.route,
      credentialFamily: bound.composition.authentication.credentialFamily,
      mechanism: bound.composition.authentication.mechanism,
    },
    harness: bound.composition.harness,
    adapters: bound.composition.adapters,
    digests: {
      installedManifestSha256: bound.installedManifestSha256,
      compositionSha256: bound.composition.compositionSha256,
      candidateSha256: bound.candidate.candidateSha256,
      workflowSha256: bound.workflow.sourceSha256,
      packageLimitsSha256: bound.compositionCeilingSha256,
      requestPolicySha256: bound.composition.requestPolicy?.policySha256 ?? null,
    },
    workflow: {
      id: bound.workflow.workflowId,
      sourceSha256: bound.workflow.sourceSha256,
    },
    limits: {
      candidate: bound.candidate.proposedLimits,
      composition: bound.composition.compositionLimits,
      package: bound.compositionCeiling,
    },
    limitations: [...bound.composition.limitations].sort(),
    technicalApproval: bound.technicalApproval,
    releaseEligible: bound.releaseEligible,
  };
  const observed = {
    compositionId: execution.compositionId,
    model: execution.model,
    deployment: execution.deployment,
    authentication: execution.authentication,
    harness: execution.harness,
    adapters: execution.adapters,
    digests: execution.digests,
    workflow: execution.workflow,
    limits: {
      candidate: execution.limits.candidate,
      composition: execution.limits.composition,
      package: execution.limits.package,
    },
    limitations: execution.limitations,
    technicalApproval: execution.technicalApproval,
    releaseEligible: execution.releaseEligible,
  };
  if (canonicalDigest(observed) !== canonicalDigest(expected)) {
    throw new CompositionComparisonError("invalid-run-record");
  }
}

function fixtureProjection(record: RunRecord): FixtureProjection {
  const execution = record.compositionExecution!;
  return {
    workflow: {
      id: execution.workflow.id,
      sourceSha256: execution.workflow.sourceSha256,
    },
    repository: {
      identitySha256: execution.repository.identitySha256,
      revision: execution.repository.revision,
    },
    task: {
      task: record.task ?? null,
      instruction: record.instruction ?? null,
    },
    qualityPack: record.qualityPack ?? null,
    skills: record.steps.map((step, ordinal) => ({
      ordinal,
      stepId: step.id,
      skillId: step.skill,
      contentSha256: step.skillEvidence?.contentSha256 ?? null,
      bundleSha256: step.skillEvidence?.bundleSha256 ?? null,
    })),
    context: record.steps.map((step, ordinal) => ({
      ordinal,
      stepId: step.id,
      status: step.contextPreflight?.status ?? null,
      reason: step.contextPreflight?.status === "unnecessary" ? step.contextPreflight.reason : null,
      packetDigest:
        step.contextPreflight && "packetDigest" in step.contextPreflight
          ? (step.contextPreflight.packetDigest ?? null)
          : null,
      consultedNodeIds:
        step.contextPreflight && "consultedNodeIds" in step.contextPreflight
          ? (step.contextPreflight.consultedNodeIds ?? [])
          : [],
      ontologyVersion:
        step.contextPreflight && "ontologyVersion" in step.contextPreflight
          ? (step.contextPreflight.ontologyVersion ?? null)
          : null,
      effectiveDecisionIds:
        step.contextPreflight && "effectiveDecisionIds" in step.contextPreflight
          ? (step.contextPreflight.effectiveDecisionIds ?? [])
          : [],
    })),
    budget: {
      effectiveLimits: execution.limits.effective,
      steps: record.steps.map((step, ordinal) => ({
        ordinal,
        stepId: step.id,
        model:
          step.model?.profile === undefined
            ? null
            : {
                effectiveContextWindow: step.model.profile.effectiveContextWindow,
                effectiveMaxInputTokens: step.model.profile.effectiveMaxInputTokens ?? null,
                effectiveMaxOutputTokens: step.model.profile.effectiveMaxOutputTokens,
                requestPolicy: step.model.profile.requestPolicy,
              },
        inference:
          step.inference === undefined
            ? null
            : {
                configuredMaxRetries: step.inference.configuredMaxRetries,
                effectiveMaxRetries: step.inference.effectiveMaxRetries,
                baseDelayMs: step.inference.baseDelayMs,
                maxDelayMs: step.inference.maxDelayMs,
                retryableCategories: step.inference.retryableCategories,
                replay: step.inference.replay,
                // Absent on runs that shared one retry count, so their
                // comparisons are unchanged.
                ...(step.inference.transportRetry
                  ? { transportRetry: structuredClone(step.inference.transportRetry) }
                  : {}),
                // Absent on runs written before condition budgets were recorded.
                ...(step.inference.conditionRetry
                  ? { conditionRetry: structuredClone(step.inference.conditionRetry) }
                  : {}),
                turnPolicies: distinctTurnPolicies(step),
                leasePolicySha256:
                  step.inference.attempts.at(-1)?.executionLease?.policySha256 ?? null,
              },
      })),
    },
  };
}

function distinctTurnPolicies(step: RunRecord["steps"][number]): readonly unknown[] {
  const policies = new Map<string, object>();
  for (const attempt of step.inference?.attempts ?? []) {
    for (const turn of attempt.turns ?? []) {
      const policy = {
        maxProviderTurns: turn.maxProviderTurns,
        maxToolCalls: turn.maxToolCalls,
        maxCompactions: turn.maxCompactions,
        reservedTokens: turn.reservedTokens,
        requiredMinimumOutputTokens: turn.requiredMinimumOutputTokens,
      };
      policies.set(canonicalDigest(policy), policy);
    }
  }
  return [...policies.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, policy]) => policy);
}

function firstMismatch(
  records: readonly AdmittedComparisonRecord[],
): CompositionComparisonMismatchCode | null {
  const compositionIds = records.map((record) => record.compositionId);
  if (new Set(compositionIds).size !== compositionIds.length) return "duplicate-composition";
  const dimensions: ReadonlyArray<
    readonly [keyof FixtureProjection, CompositionComparisonMismatchCode]
  > = [
    ["workflow", "workflow-mismatch"],
    ["repository", "repository-mismatch"],
    ["task", "task-mismatch"],
    ["qualityPack", "quality-pack-mismatch"],
    ["skills", "skill-set-mismatch"],
    ["context", "context-input-mismatch"],
    ["budget", "experiment-budget-mismatch"],
  ];
  for (const [dimension, mismatch] of dimensions) {
    const expected = canonicalDigest(records[0]!.fixture[dimension]);
    if (
      records.slice(1).some((record) => canonicalDigest(record.fixture[dimension]) !== expected)
    ) {
      return mismatch;
    }
  }
  return null;
}

function projectMetrics(record: AdmittedComparisonRecord): CompositionComparisonRunMetricsV1 {
  const run = record.record;
  return {
    compositionId: record.compositionId,
    compositionEvidenceSha256: record.evidenceSha256,
    aggregateSha256: record.aggregateSha256,
    runIdSha256: canonicalDigest(run.id),
    fixtureBindingSha256: record.fixtureBindingSha256,
    providerPayloadLedgerSha256: providerPayloadLedgerSha256(run),
    durationMs: run.durationMs!,
    usage: {
      input: run.usage.input,
      output: run.usage.output,
      cacheRead: run.usage.cacheRead,
      cacheWrite: run.usage.cacheWrite,
      total: run.usage.total,
      turns: run.usage.turns,
    },
    tools: {
      totalCalls: run.tools.totalCalls,
      failedCalls: run.tools.failedCalls,
    },
    attempts: run.steps.reduce((sum, step) => sum + (step.inference?.attempts.length ?? 0), 0),
    productDisposition: run.workflowOutcome?.disposition ?? "unavailable",
    quality: { result: "unavailable", score: null },
  };
}

function parseRunMetrics(value: unknown): CompositionComparisonRunMetricsV1 {
  const root = comparisonObject(value);
  comparisonExact(root, [
    "compositionId",
    "compositionEvidenceSha256",
    "aggregateSha256",
    "runIdSha256",
    "fixtureBindingSha256",
    "providerPayloadLedgerSha256",
    "durationMs",
    "usage",
    "tools",
    "attempts",
    "productDisposition",
    "quality",
  ]);
  if (
    typeof root.compositionId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(root.compositionId) ||
    !comparisonDigest(root.compositionEvidenceSha256) ||
    !comparisonDigest(root.aggregateSha256) ||
    !comparisonDigest(root.runIdSha256) ||
    !comparisonDigest(root.fixtureBindingSha256) ||
    !comparisonDigest(root.providerPayloadLedgerSha256) ||
    !comparisonInteger(root.durationMs) ||
    !comparisonInteger(root.attempts)
  ) {
    throw new CompositionComparisonError("invalid-run-record");
  }
  const usage = comparisonObject(root.usage);
  comparisonExact(usage, ["input", "output", "cacheRead", "cacheWrite", "total", "turns"]);
  if (
    ![usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.total, usage.turns].every(
      comparisonInteger,
    )
  ) {
    throw new CompositionComparisonError("invalid-run-record");
  }
  const tools = comparisonObject(root.tools);
  comparisonExact(tools, ["totalCalls", "failedCalls"]);
  if (
    !comparisonInteger(tools.totalCalls) ||
    !comparisonInteger(tools.failedCalls) ||
    tools.failedCalls > tools.totalCalls
  ) {
    throw new CompositionComparisonError("invalid-run-record");
  }
  const dispositions = [
    "ready",
    "not-ready",
    "needs-input",
    "inconclusive",
    "blocked",
    "unavailable",
  ];
  if (!dispositions.includes(root.productDisposition as string)) {
    throw new CompositionComparisonError("invalid-run-record");
  }
  const quality = comparisonObject(root.quality);
  comparisonExact(quality, ["result", "score"]);
  if (quality.result !== "unavailable" || quality.score !== null) {
    throw new CompositionComparisonError("invalid-run-record");
  }
  return structuredClone(root) as unknown as CompositionComparisonRunMetricsV1;
}

function providerPayloadLedgerSha256(record: RunRecord): string {
  const ledger = record.steps.flatMap((step, stepOrdinal) =>
    (step.inference?.attempts ?? []).flatMap((attempt) =>
      (attempt.turns ?? [])
        .filter((turn) => turn.providerPayloadSchemaVersion === 1)
        .map((turn) => ({
          stepOrdinal,
          stepId: step.id,
          attempt: attempt.attempt,
          turn: turn.turn,
          requestPolicySha256: turn.requestPolicySha256 ?? null,
          finalPayloadSha256: turn.finalPayloadSha256,
        })),
    ),
  );
  return canonicalDigest(ledger);
}

function comparisonObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CompositionComparisonError("invalid-run-record");
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new CompositionComparisonError("invalid-run-record");
  }
  return value as Record<string, unknown>;
}

function comparisonExact(value: Record<string, unknown>, keys: readonly string[]): void {
  const observed = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    observed.length !== expected.length ||
    observed.some((key, index) => key !== expected[index])
  ) {
    throw new CompositionComparisonError("invalid-run-record");
  }
}

function comparisonDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function comparisonInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function assertRecordCount(count: number): void {
  if (!Number.isSafeInteger(count) || count < 2 || count > MAX_COMPOSITION_COMPARISON_RECORDS) {
    throw new CompositionComparisonError("invalid-record-count");
  }
}

interface AncestorIdentity {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
}

async function inspectAncestors(path: string): Promise<readonly AncestorIdentity[]> {
  const root = parse(path).root;
  const relative = dirname(path).slice(root.length);
  const segments = relative ? relative.split(sep).filter(Boolean) : [];
  const paths = [root];
  for (const segment of segments) paths.push(resolve(paths.at(-1)!, segment));
  const result: AncestorIdentity[] = [];
  for (const ancestor of paths) {
    const stat = await safeLeafStat(ancestor);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new CompositionComparisonError("unsafe-record-file");
    }
    result.push({ path: ancestor, dev: stat.dev, ino: stat.ino, mode: stat.mode });
  }
  return result;
}

async function assertAncestorsUnchanged(before: readonly AncestorIdentity[]): Promise<void> {
  for (const expected of before) {
    const after = await safeLeafStat(expected.path);
    if (
      after.isSymbolicLink() ||
      !after.isDirectory() ||
      after.dev !== expected.dev ||
      after.ino !== expected.ino ||
      after.mode !== expected.mode
    ) {
      throw new CompositionComparisonError("unsafe-record-file");
    }
  }
}

async function safeLeafStat(path: string): Promise<Stats> {
  try {
    return await lstat(path);
  } catch {
    throw new CompositionComparisonError("unsafe-record-file");
  }
}

function assertRegularBoundedFile(stat: Stats): void {
  const owner = typeof process.getuid === "function" ? process.getuid() : -1;
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size < 1 ||
    stat.nlink !== 1 ||
    (stat.uid !== 0 && stat.uid !== owner) ||
    (stat.mode & 0o077) !== 0
  ) {
    throw new CompositionComparisonError("unsafe-record-file");
  }
  if (stat.size > MAX_COMPOSITION_COMPARISON_RECORD_BYTES) {
    throw new CompositionComparisonError("record-too-large");
  }
}

function assertSameFile(left: Stats, right: Stats): void {
  if (
    left.dev !== right.dev ||
    left.ino !== right.ino ||
    left.mode !== right.mode ||
    left.size !== right.size ||
    left.mtimeMs !== right.mtimeMs ||
    left.ctimeMs !== right.ctimeMs
  ) {
    throw new CompositionComparisonError("unsafe-record-file");
  }
}
