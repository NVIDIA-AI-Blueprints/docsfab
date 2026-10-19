// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { DocsFabConfig } from "../../config/runtime-loader.js";
import { loadConfig, loadConfiguredCompositionModelLimits } from "../../config/runtime-loader.js";
import { loadPrivateDocsFabEnvironment } from "../../config/private-environment.js";
import type { ModelSlotSettingsV1 } from "../../config/model-settings.js";
import {
  loadInstalledModelCompositionAuthority,
  resolveInstalledExecutableComposition,
  type BoundExecutableComposition,
  type CompositionModelLimits,
} from "../../model-composition/index.js";
import {
  CompositionCredentialSourceError,
  compositionCredentialFamily,
  resolveOperatorExecutionBinding,
  type OperatorExecutionBinding,
} from "../../model/operator-execution-binding.js";
import {
  type BoundModelExecutionProfile,
  type ProviderCredential,
} from "../../model/configuration.js";
import {
  createProviderConnectionFactory,
  servedModelWarning,
  type ProviderConnectionFactory,
} from "../../model/provider.js";
import { createRunNotes, type RunNotes } from "../../records/run-notes.js";
import { enforceLimit, limit } from "../../config/limits.js";
import { resolveAnswerNowPolicy } from "../../harness/answer-now.js";
import {
  createAnswerRecordDiscoveryExecutionV1,
  type AnswerRecordDiscoveryExecutionDraftV1,
} from "../../records/answer-record-discovery.js";
import type { RunRequestWithPublishProjection } from "./request.js";

export interface CompositionRunRuntime {
  readonly config: DocsFabConfig;
  readonly bound: BoundExecutableComposition;
  readonly executionProfile: BoundModelExecutionProfile;
  /** Complete host settings before candidate/composition/package clamps. */
  readonly configuredLimits: CompositionModelLimits;
  readonly experimentalAnswerRecords: boolean;
  readonly answerRecordDiscovery?: AnswerRecordDiscoveryExecutionDraftV1;
  readonly credential: ProviderCredential;
  readonly credentialSourceName: string;
  readonly providerConnectionFactory: ProviderConnectionFactory;
  /** Each effective setting and its source; absent for an injected configuration. */
  readonly modelSettings?: ModelSlotSettingsV1;
  /** Values that differ from the preset, recorded and shown, never refused. */
  readonly notes: readonly string[];
  /** Warnings the run's provider connections report, such as a renamed served model. */
  readonly runNotes: RunNotes;
}

/**
 * Load only the exact route selected by an explicit installed composition.
 * Credential resolution happens after composition binding and reads only that
 * adapter's declared source family. Inference Hub Metadata is never consulted.
 *
 * Profile, transport, credential family, and request policy come from the
 * shared model-profile binder plus this explicit composition id.
 */
export async function loadCompositionRunRuntime(
  request: RunRequestWithPublishProjection,
  providedConfig?: DocsFabConfig,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<CompositionRunRuntime> {
  if (!request.compositionId) {
    throw new Error(
      "Composition runtime requires one explicit installed executable composition selection.",
    );
  }
  // `--composition` selects this run's preset by id; operator settings
  // override its values key by key, in a private environment that child
  // processes never inherit.
  const loadOptions = { writingPreset: request.compositionId };
  const effectiveEnvironment = loadPrivateDocsFabEnvironment(environment, loadOptions);
  const { authority } = await loadInstalledModelCompositionAuthority();
  const bound = resolveInstalledExecutableComposition({
    authority,
    compositionId: request.compositionId,
    workflowId: request.workflow,
  });
  const selected = providedConfig
    ? {
        sourceName:
          bound.composition.authentication.sourceNames.length === 1
            ? bound.composition.authentication.sourceNames[0]!
            : "MODEL_API_KEY",
        value: providedConfig.model.apiKey,
      }
    : resolveSelectedCredential(
        bound.composition.compositionId,
        bound.composition.authentication.sourceNames,
        effectiveEnvironment,
      );
  if (!bound.composition.authentication.sourceNames.includes(selected.sourceName)) {
    throw new Error(
      "Injected composition configuration does not match the selected credential source.",
    );
  }
  const config =
    providedConfig ??
    loadConfig(
      {
        ...effectiveEnvironment,
        MODEL_API_KEY: selected.value,
        // Composition execution has one selected composition; the independent
        // semantic-judge slot must not trigger unrelated credential resolution.
        JUDGE_ENABLED: "false",
      },
      loadOptions,
    );
  const configuredLimits = loadConfiguredCompositionModelLimits(
    config.model.profile,
    effectiveEnvironment,
  );
  const binding = await bindExecutableComposition({
    model: config.model,
    bound,
    workflowId: request.workflow,
    configuredLimits,
    credential: {
      family: compositionCredentialFamily(bound.composition.authentication.credentialFamily),
      apiKey: selected.value,
    },
  });
  const experimentalAnswerRecords = request.experimentalAnswerRecords === true;
  const discoveryOutputLimit =
    experimentalAnswerRecords && isNemotron3SuperCatalogComposition(bound)
      ? limit("modelProfile.nvidiaNemotron3SuperHostedMaxOutputTokens")
      : undefined;
  if (discoveryOutputLimit) enforceLimit(discoveryOutputLimit, configuredLimits.maxOutputTokens);
  const executionProfile = experimentalAnswerRecords
    ? {
        ...binding.profile,
        ...(discoveryOutputLimit
          ? {
              profile: {
                ...binding.profile.profile,
                maxOutputTokens: Math.min(
                  configuredLimits.maxOutputTokens,
                  discoveryOutputLimit.value,
                  bound.compositionCeiling.maxOutputTokens,
                  binding.profile.profile.contextWindow,
                ),
              },
            }
          : {}),
        compositionPolicy: {
          maxProviderTurns: Math.min(
            configuredLimits.maxProviderTurns,
            bound.compositionCeiling.maxProviderTurns,
          ),
          timeoutMs: Math.min(configuredLimits.timeoutMs, bound.compositionCeiling.timeoutMs),
          maxResponseBytes: Math.min(
            configuredLimits.maxResponseBytes,
            bound.compositionCeiling.maxResponseBytes,
          ),
        },
      }
    : binding.profile;
  const answerRecordDiscovery = experimentalAnswerRecords
    ? createAnswerRecordDiscoveryExecutionV1({
        bound,
        executionProfile,
        configuredHostLimits: configuredLimits,
        requestIntentTimeoutMs: Math.min(
          limit("requestIntent.interpretationTimeoutMs").value,
          executionProfile.compositionPolicy!.timeoutMs,
        ),
        qualityValidatorTimeoutMs: limit("qualityValidator.timeoutMs").value,
        answerNow: resolveAnswerNowPolicy(),
      })
    : undefined;
  const runNotes = createRunNotes();
  const providerConnectionFactory = createProviderConnectionFactory({
    routeId: executionProfile.routeId,
    transport: executionProfile.transport,
    onServedModel: (observation) => runNotes.add(servedModelWarning(observation)),
  });
  // Composition runs keep the resolved read-only step retry policy: the limits
  // catalog default unless an explicit or persisted numeric host value
  // overrides it. Sealed per-step ceilings apply; write steps stay
  // single-attempt.
  return {
    config,
    bound,
    executionProfile,
    configuredLimits,
    experimentalAnswerRecords,
    ...(answerRecordDiscovery ? { answerRecordDiscovery } : {}),
    credential: binding.credential,
    credentialSourceName: selected.sourceName,
    providerConnectionFactory,
    ...(binding.modelSettings ? { modelSettings: binding.modelSettings } : {}),
    notes: binding.notes,
    runNotes,
  };
}

function isNemotron3SuperCatalogComposition(bound: BoundExecutableComposition): boolean {
  return (
    bound.composition.compositionId === "nvidia-nemotron-3-super-120b-a12b-pi" &&
    bound.composition.deployment.routeId === "nvidia-api-catalog" &&
    bound.composition.deployment.transport === "openai-chat-completions" &&
    bound.composition.model.resolvedId === "nvidia/nemotron-3-super-120b-a12b"
  );
}

async function bindExecutableComposition(input: {
  readonly model: CompositionRunRuntime["config"]["model"];
  readonly bound: BoundExecutableComposition;
  readonly workflowId: string;
  readonly configuredLimits: CompositionModelLimits;
  readonly credential: ProviderCredential;
}): Promise<OperatorExecutionBinding> {
  return resolveOperatorExecutionBinding({
    model: input.model,
    compositionId: input.bound.composition.compositionId,
    workflowId: input.workflowId,
    bound: input.bound,
    configuredLimits: input.configuredLimits,
    attachCompositionPolicy: true,
    credential: input.credential,
  });
}

function resolveSelectedCredential(
  compositionId: string,
  allowedNames: readonly string[],
  environment: NodeJS.ProcessEnv,
): { sourceName: string; value: string } {
  // A named credential variable is the operator's choice, among the preset's own names.
  const named = environment.MODEL_CREDENTIAL_ENV?.trim();
  if (named && !allowedNames.includes(named)) {
    throw new CompositionCredentialSourceError({ named, compositionId, reads: allowedNames });
  }
  const available = (named ? [named] : allowedNames).flatMap((sourceName) => {
    const value = environment[sourceName]?.trim();
    return value ? [{ sourceName, value }] : [];
  });
  if (available.length !== 1) {
    throw new Error(
      available.length === 0
        ? "The selected executable composition credential is unavailable."
        : "The selected executable composition has ambiguous credential sources.",
    );
  }
  return available[0]!;
}
