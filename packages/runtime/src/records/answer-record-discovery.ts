// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { canonicalDigest } from "../contract-kit/index.js";
import { limit } from "../config/limits.js";
import type { BoundModelExecutionProfile } from "../model/configuration.js";
import type {
  BoundExecutableComposition,
  CompositionModelLimits,
  ModelCompositionTransport,
} from "../model-composition/types.js";

export const ANSWER_RECORD_DISCOVERY_EXECUTION_KIND =
  "docsfab-answer-record-discovery-execution/v1" as const;

export type DiscoveryProviderExecutionPolicyV1 = {
  readonly policyVersion?: 1;
  readonly maxProviderTurns: number;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
};

export type DiscoveryProviderExecutionPolicyV2 = {
  readonly policyVersion: 2;
  readonly scope: "answer-record-evaluator-step";
  readonly aggregatePolicy: { readonly kind: "absent" };
  readonly maxResponseBytes: number;
};

export type DiscoveryProviderExecutionPolicy =
  | DiscoveryProviderExecutionPolicyV1
  | DiscoveryProviderExecutionPolicyV2;

export interface AnswerRecordDiscoveryExecutionV1 {
  readonly schemaVersion: 1;
  readonly kind: typeof ANSWER_RECORD_DISCOVERY_EXECUTION_KIND;
  readonly qualification: "unqualified";
  readonly statusLabel: "Experimental discovery — not qualified";
  /** Older records omitted this; current discovery leaves per-key refusals correctable. */
  readonly answerRecordRefusalPolicy?: "non-exhausting-per-key";
  readonly runBinding: {
    readonly runId: string;
    readonly workflow: string;
    readonly repositoryRevision: string;
    readonly repositoryIdentitySha256: string;
  };
  readonly composition: {
    readonly id: string;
    readonly installedManifestSha256: string;
    readonly compositionSha256: string;
    readonly candidateSha256: string;
    readonly workflow: { readonly id: string; readonly sourceSha256: string };
    readonly model: { readonly requestedId: string; readonly resolvedId: string };
    readonly deployment: {
      readonly routeId: string;
      readonly transport: Exclude<ModelCompositionTransport, "opaque-cli-managed">;
      readonly identitySha256: string;
    };
    readonly requestPolicySha256: string | null;
  };
  readonly bounds: {
    readonly installedComposition: CompositionModelLimits;
    readonly candidateProposed: CompositionModelLimits;
    readonly packageCeiling: CompositionModelLimits;
    readonly configuredHost: CompositionModelLimits;
    readonly effective: {
      readonly providerExecution: DiscoveryProviderExecutionPolicy;
      readonly model: {
        readonly contextWindow: number;
        readonly maxInputTokens: number;
        readonly maxOutputTokens: number;
      };
    };
    readonly qualityValidatorTimeoutMs: number;
    readonly answerNow: {
      readonly elapsedShareBasisPoints: number;
      readonly decodeTokensPerSecond: number;
      readonly turnLatencyMs: number;
    };
    readonly requestIntentTimeoutMs: number;
    readonly workflowDeadlineMs: null;
  };
  readonly evidenceSha256: string;
}

export type AnswerRecordDiscoveryExecutionDraftV1 = Omit<
  AnswerRecordDiscoveryExecutionV1,
  "runBinding"
> & { readonly runBinding: null };

export interface CreateAnswerRecordDiscoveryExecutionInput {
  readonly bound: BoundExecutableComposition;
  readonly executionProfile: BoundModelExecutionProfile;
  readonly configuredHostLimits: CompositionModelLimits;
  readonly requestIntentTimeoutMs: number;
  readonly qualityValidatorTimeoutMs: number;
  readonly answerNow: AnswerRecordDiscoveryExecutionV1["bounds"]["answerNow"];
}

export function createAnswerRecordDiscoveryExecutionV1(
  input: CreateAnswerRecordDiscoveryExecutionInput,
): AnswerRecordDiscoveryExecutionDraftV1 {
  const policy = input.executionProfile.compositionPolicy;
  if (!policy)
    throw new TypeError(
      "Discovery execution requires an effective provider envelope from the selected composition.",
    );
  const body = {
    schemaVersion: 1 as const,
    kind: ANSWER_RECORD_DISCOVERY_EXECUTION_KIND,
    qualification: "unqualified" as const,
    statusLabel: "Experimental discovery — not qualified" as const,
    answerRecordRefusalPolicy: "non-exhausting-per-key" as const,
    runBinding: null,
    composition: {
      id: input.bound.composition.compositionId,
      installedManifestSha256: input.bound.installedManifestSha256,
      compositionSha256: input.bound.composition.compositionSha256,
      candidateSha256: input.bound.candidate.candidateSha256,
      workflow: {
        id: input.bound.workflow.workflowId,
        sourceSha256: input.bound.workflow.sourceSha256,
      },
      model: {
        requestedId: input.bound.composition.model.requestedId,
        resolvedId: input.bound.composition.model.resolvedId,
      },
      deployment: {
        routeId: input.bound.composition.deployment.routeId,
        transport: input.bound.composition.deployment.transport,
        identitySha256: input.bound.composition.deployment.identitySha256,
      },
      requestPolicySha256: input.bound.composition.requestPolicy?.policySha256 ?? null,
    },
    bounds: {
      installedComposition: structuredClone(input.bound.composition.compositionLimits),
      candidateProposed: structuredClone(input.bound.candidate.proposedLimits),
      packageCeiling: structuredClone(input.bound.compositionCeiling),
      configuredHost: structuredClone(input.configuredHostLimits),
      effective: {
        providerExecution: {
          policyVersion: 2 as const,
          scope: "answer-record-evaluator-step" as const,
          aggregatePolicy: { kind: "absent" as const },
          maxResponseBytes: policy.maxResponseBytes,
        },
        model: {
          contextWindow: input.executionProfile.profile.contextWindow,
          maxInputTokens: input.executionProfile.profile.maxInputTokens,
          maxOutputTokens: input.executionProfile.profile.maxOutputTokens,
        },
      },
      qualityValidatorTimeoutMs: input.qualityValidatorTimeoutMs,
      answerNow: { ...input.answerNow },
      requestIntentTimeoutMs: input.requestIntentTimeoutMs,
      workflowDeadlineMs: null,
    },
  };
  return { ...body, evidenceSha256: canonicalDigest(body) };
}

export function bindAnswerRecordDiscoveryExecutionV1(
  draft: AnswerRecordDiscoveryExecutionDraftV1,
  binding: AnswerRecordDiscoveryExecutionV1["runBinding"],
): AnswerRecordDiscoveryExecutionV1 {
  const { evidenceSha256: _draftDigest, ...body } = draft;
  const bound = { ...body, runBinding: binding };
  return { ...bound, evidenceSha256: canonicalDigest(bound) };
}

export function decodeAnswerRecordDiscoveryExecutionV1(
  value: unknown,
): AnswerRecordDiscoveryExecutionV1 {
  if (
    !isRecord(value) ||
    (!exactKeys(value, [
      "schemaVersion",
      "kind",
      "qualification",
      "statusLabel",
      "runBinding",
      "composition",
      "bounds",
      "evidenceSha256",
    ]) &&
      !exactKeys(value, [
        "schemaVersion",
        "kind",
        "qualification",
        "statusLabel",
        "answerRecordRefusalPolicy",
        "runBinding",
        "composition",
        "bounds",
        "evidenceSha256",
      ]))
  ) {
    throw new TypeError(
      "Answer-record discovery evidence has an unsupported shape for this saved run record.",
    );
  }
  if (
    value.schemaVersion !== 1 ||
    value.kind !== ANSWER_RECORD_DISCOVERY_EXECUTION_KIND ||
    value.qualification !== "unqualified" ||
    value.statusLabel !== "Experimental discovery — not qualified" ||
    (value.answerRecordRefusalPolicy !== undefined &&
      value.answerRecordRefusalPolicy !== "non-exhausting-per-key") ||
    !isRecord(value.composition) ||
    !isRecord(value.bounds) ||
    !isSha256(value.evidenceSha256)
  ) {
    throw new TypeError("Answer-record discovery evidence has invalid identity or qualification.");
  }
  if (
    !isRecord(value.runBinding) ||
    !exactKeys(value.runBinding, [
      "runId",
      "workflow",
      "repositoryRevision",
      "repositoryIdentitySha256",
    ]) ||
    !isNonEmpty(value.runBinding.runId) ||
    !isNonEmpty(value.runBinding.workflow) ||
    !isNonEmpty(value.runBinding.repositoryRevision) ||
    !isSha256(value.runBinding.repositoryIdentitySha256)
  ) {
    throw new TypeError(
      "Answer-record discovery run binding is invalid for the selected workflow and repository.",
    );
  }
  const { evidenceSha256, ...body } = value;
  if (canonicalDigest(body) !== evidenceSha256) {
    throw new TypeError("Answer-record discovery evidence digest does not match its contents.");
  }
  const composition = value.composition;
  if (
    !exactKeys(composition, [
      "id",
      "installedManifestSha256",
      "compositionSha256",
      "candidateSha256",
      "workflow",
      "model",
      "deployment",
      "requestPolicySha256",
    ]) ||
    !isNonEmpty(composition.id) ||
    !isSha256(composition.installedManifestSha256) ||
    !isSha256(composition.compositionSha256) ||
    !isSha256(composition.candidateSha256) ||
    !isRecord(composition.workflow) ||
    !exactKeys(composition.workflow, ["id", "sourceSha256"]) ||
    !isNonEmpty(composition.workflow.id) ||
    !isSha256(composition.workflow.sourceSha256) ||
    !isRecord(composition.model) ||
    !exactKeys(composition.model, ["requestedId", "resolvedId"]) ||
    !isNonEmpty(composition.model.requestedId) ||
    !isNonEmpty(composition.model.resolvedId) ||
    !isRecord(composition.deployment) ||
    !exactKeys(composition.deployment, ["routeId", "transport", "identitySha256"]) ||
    !isNonEmpty(composition.deployment.routeId) ||
    typeof composition.deployment.transport !== "string" ||
    !["openai-chat-completions", "openai-responses", "anthropic-messages"].includes(
      composition.deployment.transport,
    ) ||
    !isSha256(composition.deployment.identitySha256) ||
    !(composition.requestPolicySha256 === null || isSha256(composition.requestPolicySha256))
  ) {
    throw new TypeError(
      "Answer-record discovery composition identity is invalid for the installed composition manifest.",
    );
  }
  const bounds = value.bounds;
  if (
    !exactKeys(bounds, [
      "installedComposition",
      "candidateProposed",
      "packageCeiling",
      "configuredHost",
      "effective",
      "qualityValidatorTimeoutMs",
      "answerNow",
      "requestIntentTimeoutMs",
      "workflowDeadlineMs",
    ]) ||
    !decodeLimits(bounds.installedComposition) ||
    !decodeLimits(bounds.candidateProposed) ||
    !decodeLimits(bounds.packageCeiling) ||
    !decodeLimits(bounds.configuredHost) ||
    !isRecord(bounds.effective) ||
    !exactKeys(bounds.effective, ["providerExecution", "model"]) ||
    !isRecord(bounds.effective.providerExecution) ||
    !decodeProviderExecutionPolicy(bounds.effective.providerExecution) ||
    !isPositiveInteger(bounds.effective.providerExecution.maxResponseBytes) ||
    !isRecord(bounds.effective.model) ||
    !exactKeys(bounds.effective.model, ["contextWindow", "maxInputTokens", "maxOutputTokens"]) ||
    !isPositiveInteger(bounds.effective.model.contextWindow) ||
    !isPositiveInteger(bounds.effective.model.maxInputTokens) ||
    !isPositiveInteger(bounds.effective.model.maxOutputTokens) ||
    !isPositiveInteger(bounds.qualityValidatorTimeoutMs) ||
    !isRecord(bounds.answerNow) ||
    !exactKeys(bounds.answerNow, [
      "elapsedShareBasisPoints",
      "decodeTokensPerSecond",
      "turnLatencyMs",
    ]) ||
    !isPositiveInteger(bounds.answerNow.elapsedShareBasisPoints) ||
    !isPositiveInteger(bounds.answerNow.decodeTokensPerSecond) ||
    !isPositiveInteger(bounds.answerNow.turnLatencyMs) ||
    !isPositiveInteger(bounds.requestIntentTimeoutMs) ||
    bounds.workflowDeadlineMs !== null
  ) {
    throw new TypeError(
      "Answer-record discovery execution bounds are invalid for the selected qualification profile.",
    );
  }
  const installed = bounds.installedComposition;
  const candidate = bounds.candidateProposed;
  const packageCeiling = bounds.packageCeiling;
  const configuredHost = bounds.configuredHost;
  const effectiveProvider = bounds.effective.providerExecution;
  const effectiveModel = bounds.effective.model;
  if (
    (effectiveProvider.policyVersion === 2
      ? effectiveProvider.aggregatePolicy.kind !== "absent"
      : effectiveProvider.maxProviderTurns !==
          Math.min(configuredHost.maxProviderTurns, packageCeiling.maxProviderTurns) ||
        effectiveProvider.timeoutMs !==
          Math.min(configuredHost.timeoutMs, packageCeiling.timeoutMs)) ||
    effectiveProvider.maxResponseBytes !==
      Math.min(configuredHost.maxResponseBytes, packageCeiling.maxResponseBytes) ||
    effectiveModel.contextWindow !==
      Math.min(
        installed.contextWindow,
        candidate.contextWindow,
        configuredHost.contextWindow,
        packageCeiling.contextWindow,
      ) ||
    effectiveModel.maxInputTokens !==
      Math.min(
        installed.maxInputTokens,
        candidate.maxInputTokens,
        configuredHost.maxInputTokens,
        packageCeiling.maxInputTokens,
        effectiveModel.contextWindow,
      ) ||
    !(
      effectiveModel.maxOutputTokens ===
        Math.min(
          installed.maxOutputTokens,
          candidate.maxOutputTokens,
          configuredHost.maxOutputTokens,
          packageCeiling.maxOutputTokens,
          effectiveModel.contextWindow,
        ) ||
      (isNemotron3SuperCatalogDiscovery(composition) &&
        configuredHost.maxOutputTokens <=
          limit("modelProfile.nvidiaNemotron3SuperHostedMaxOutputTokens").value &&
        effectiveModel.maxOutputTokens ===
          Math.min(
            configuredHost.maxOutputTokens,
            limit("modelProfile.nvidiaNemotron3SuperHostedMaxOutputTokens").value,
            packageCeiling.maxOutputTokens,
            effectiveModel.contextWindow,
          ))
    )
  ) {
    throw new TypeError("Answer-record discovery effective bounds do not match their sources.");
  }
  return value as unknown as AnswerRecordDiscoveryExecutionV1;
}

function decodeProviderExecutionPolicy(value: unknown): value is DiscoveryProviderExecutionPolicy {
  if (!isRecord(value)) return false;
  if (value.policyVersion === 2) {
    return (
      exactKeys(value, ["policyVersion", "scope", "aggregatePolicy", "maxResponseBytes"]) &&
      value.scope === "answer-record-evaluator-step" &&
      isRecord(value.aggregatePolicy) &&
      exactKeys(value.aggregatePolicy, ["kind"]) &&
      value.aggregatePolicy.kind === "absent" &&
      isPositiveInteger(value.maxResponseBytes)
    );
  }
  return (
    exactKeys(value, ["maxProviderTurns", "timeoutMs", "maxResponseBytes"]) &&
    isPositiveInteger(value.maxProviderTurns) &&
    isPositiveInteger(value.timeoutMs) &&
    isPositiveInteger(value.maxResponseBytes)
  );
}

function isNemotron3SuperCatalogDiscovery(composition: Record<string, unknown>): boolean {
  if (
    composition.id !== "nvidia-nemotron-3-super-120b-a12b-pi" ||
    !isRecord(composition.model) ||
    composition.model.resolvedId !== "nvidia/nemotron-3-super-120b-a12b" ||
    !isRecord(composition.deployment)
  ) {
    return false;
  }
  return (
    composition.deployment.routeId === "nvidia-api-catalog" &&
    composition.deployment.transport === "openai-chat-completions"
  );
}

export function assertAnswerRecordDiscoveryRunBindingV1(
  value: unknown,
  expected: {
    readonly runId: string;
    readonly workflow: string;
    readonly repositoryRevision: string;
    readonly repositorySourcePath: string;
  },
): AnswerRecordDiscoveryExecutionV1 {
  const evidence = decodeAnswerRecordDiscoveryExecutionV1(value);
  if (
    evidence.runBinding.runId !== expected.runId ||
    evidence.runBinding.workflow !== expected.workflow ||
    evidence.runBinding.repositoryRevision !== expected.repositoryRevision ||
    evidence.runBinding.repositoryIdentitySha256 !==
      createHash("sha256").update(expected.repositorySourcePath).digest("hex") ||
    evidence.composition.workflow.id !== expected.workflow
  ) {
    throw new TypeError("Answer-record discovery evidence does not match this run.");
  }
  return evidence;
}

function decodeLimits(value: unknown): value is CompositionModelLimits {
  return (
    isRecord(value) &&
    exactKeys(value, [
      "contextWindow",
      "maxInputTokens",
      "maxOutputTokens",
      "maxProviderTurns",
      "timeoutMs",
      "maxResponseBytes",
    ]) &&
    isPositiveInteger(value.contextWindow) &&
    isPositiveInteger(value.maxInputTokens) &&
    isPositiveInteger(value.maxOutputTokens) &&
    isPositiveInteger(value.maxProviderTurns) &&
    isPositiveInteger(value.timeoutMs) &&
    isPositiveInteger(value.maxResponseBytes)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !/[\0\r\n]/u.test(value);
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}
