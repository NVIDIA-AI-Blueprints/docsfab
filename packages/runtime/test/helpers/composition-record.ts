// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Composition-mode run records for strict-reader tests: the sealed evidence the
 * runner binds before the first provider turn, model evidence that matches it,
 * and the terminal aggregate the runner seals on success.
 */
import { createHash } from "node:crypto";

import type { BoundModelExecutionProfile } from "../../src/model/configuration.js";
import { modelProfileEvidenceSha256 } from "../../src/model/profile-evidence.js";
import {
  loadInstalledModelCompositionAuthority,
  resolveInstalledExecutableComposition,
  type BoundExecutableComposition,
  type CompositionModelLimits,
} from "../../src/model-composition/index.js";
import type {
  ModelEvidence,
  ModelProfileEvidence,
  RunRecord,
} from "../../src/records/contracts.js";
import {
  createCompositionExecutionAggregate,
  createCompositionExecutionEvidence,
  type CompositionExecutionEvidenceV1,
} from "../../src/records/composition-execution.js";
import type { WorkflowName } from "../../src/workflow-contracts/contracts.js";
import { getWorkflow } from "../../src/workflow-registry/catalog.js";

export const COMPOSITION_ID = "anthropic-claude-opus-4.7-pi";

const CONFIGURED_LIMITS: CompositionModelLimits = {
  contextWindow: 100_000,
  maxInputTokens: 90_000,
  maxOutputTokens: 10_000,
  maxProviderTurns: 6,
  timeoutMs: 420_000,
  maxResponseBytes: 100_000,
};

/** Sealed composition evidence bound to one run, workflow, and repository. */
export async function compositionEvidenceFor(input: {
  readonly runId: string;
  readonly workflow: WorkflowName;
  readonly sourcePath: string;
  readonly revision: string;
}): Promise<CompositionExecutionEvidenceV1> {
  const { authority } = await loadInstalledModelCompositionAuthority();
  const bound = resolveInstalledExecutableComposition({
    authority,
    compositionId: COMPOSITION_ID,
    workflowId: input.workflow,
  });
  return createCompositionExecutionEvidence({
    runId: input.runId,
    bound,
    executionProfile: executionProfile(bound),
    configuredLimits: CONFIGURED_LIMITS,
    workflow: { id: bound.workflow.workflowId, sourceSha256: bound.workflow.sourceSha256 },
    repository: {
      identitySha256: createHash("sha256").update(input.sourcePath).digest("hex"),
      revision: input.revision,
    },
  });
}

/** Model evidence a step served by this composition records. */
export function compositionModelEvidence(
  evidence: CompositionExecutionEvidenceV1,
): ModelEvidence & { profile: ModelProfileEvidence } {
  const provider = evidence.deployment.routeId;
  const model = evidence.model.resolvedId;
  const profile: Omit<ModelProfileEvidence, "sha256"> = {
    schemaVersion: 2,
    status: "unknown",
    configuredContextWindow: evidence.limits.configured.contextWindow,
    effectiveContextWindow: evidence.limits.effective.contextWindow,
    configuredMaxInputTokens: evidence.limits.configured.maxInputTokens,
    effectiveMaxInputTokens: evidence.limits.effective.maxInputTokens,
    configuredMaxOutputTokens: evidence.limits.configured.maxOutputTokens,
    effectiveMaxOutputTokens: evidence.limits.effective.maxOutputTokens,
    effectiveLimitReason: "composition-candidate",
    apiFormat: "chat_completions",
    reasoning: false,
    input: ["text"],
    compatibility: {
      supportsDeveloperRole: true,
      supportsReasoningEffort: false,
      apiFormats: ["chat_completions"],
    },
    requestPolicy: { minimumOutputTokens: 16, reservedContextTokens: 128 },
    costPerMillionTokens: { input: null, output: null, cacheRead: null, cacheWrite: null },
    pricing: "unknown",
  };
  return {
    provider,
    model,
    profile: { ...profile, sha256: modelProfileEvidenceSha256({ provider, model, profile }) },
  };
}

/**
 * Turn an omitted-mode fixture record into the record the same run writes in
 * composition mode: bound evidence, every inference step served by the
 * composition's model, and (for a succeeded run) the sealed aggregate.
 */
export async function asCompositionRecord<T extends RunRecord>(record: T): Promise<T> {
  const evidence = await compositionEvidenceFor({
    runId: record.id,
    workflow: record.workflow as WorkflowName,
    sourcePath: record.repository.sourcePath,
    revision: record.repository.revision,
  });
  // Keep each recorded profile (the turn ledger is bound to it) and move the
  // identity to the composition's route and model.
  const served = (model: ModelEvidence): ModelEvidence => {
    const provider = evidence.deployment.routeId;
    const id = evidence.model.resolvedId;
    if (!model.profile) return { provider, model: id };
    const { sha256: _sha256, ...profile } = model.profile;
    return {
      ...model,
      provider,
      model: id,
      profile: {
        ...profile,
        sha256: modelProfileEvidenceSha256({ provider, model: id, profile }),
      },
    };
  };
  const composed = structuredClone(record);
  for (const step of composed.steps) {
    if (step.model) step.model = served(step.model);
    for (const attempt of step.inference?.attempts ?? []) {
      if (attempt.model) attempt.model = served(attempt.model);
    }
  }
  composed.models = composed.models.map(served);
  composed.compositionExecution = evidence;
  if (composed.status === "succeeded") {
    composed.compositionExecutionAggregate = createCompositionExecutionAggregate({
      compositionExecution: evidence,
      run: composed,
      workflow: getWorkflow(composed.workflow as WorkflowName),
    });
  }
  return composed;
}

function executionProfile(bound: BoundExecutableComposition): BoundModelExecutionProfile {
  const transport = bound.composition.deployment.transport;
  const apiFormat = transport === "anthropic-messages" ? "messages" : "chat_completions";
  return {
    routeId: bound.composition.deployment.routeId,
    providerId: bound.composition.deployment.routeId,
    baseUrl: "https://api.anthropic.com/v1",
    modelId: bound.composition.model.resolvedId,
    transport,
    apiFormat,
    profile: {
      configuredLimits: {
        contextWindow: CONFIGURED_LIMITS.contextWindow,
        maxInputTokens: CONFIGURED_LIMITS.maxInputTokens,
        maxOutputTokens: CONFIGURED_LIMITS.maxOutputTokens,
      },
      contextWindow: 65_536,
      maxInputTokens: 65_536,
      maxOutputTokens: 8_192,
      effectiveLimitReason: "composition-candidate",
      reasoning: false,
      input: ["text"],
      compatibility: {
        supportsDeveloperRole: true,
        supportsReasoningEffort: false,
        apiFormats: [apiFormat],
      },
      costPerMillionTokens: { input: null, output: null, cacheRead: null, cacheWrite: null },
      metadata: {
        approvedSource: null,
        effectiveDate: null,
        reviewAfter: null,
        status: "unknown",
      },
    },
    requestPolicy: { minimumOutputTokens: 16, reservedContextTokens: 128 },
    compositionPolicy: {
      maxProviderTurns: Math.min(
        CONFIGURED_LIMITS.maxProviderTurns,
        bound.candidate.proposedLimits.maxProviderTurns,
        bound.composition.compositionLimits.maxProviderTurns,
        bound.compositionCeiling.maxProviderTurns,
      ),
      timeoutMs: 300_000,
      maxResponseBytes: Math.min(
        CONFIGURED_LIMITS.maxResponseBytes,
        bound.composition.compositionLimits.maxResponseBytes,
      ),
    },
  };
}
