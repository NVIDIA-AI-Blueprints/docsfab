// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";

import type { InferenceRetryPolicy } from "../execution/contracts.js";
import { parseAnswerSubmissionOption, type AnswerSubmissionOption } from "./answer-submission.js";
import type { CompositionModelLimits } from "../model-composition/types.js";
import {
  loadModelConfigurations,
  loadModelEndpointForInspection as loadModelEndpointForInspectionFromEnvironment,
  type ModelEndpointConfig,
  type ModelProfile,
} from "../model/configuration.js";
import { parseDotenvAssignments } from "./dotenv.js";
import {
  describeDocsFabConfigurationSource,
  resolveDocsFabConfigurationRoot,
  resolveDocsFabProjectRoot,
  resolveDocsFabStateDirectory,
  type ModelSettingsLoadOptions,
} from "./host-paths.js";
import { assertModelSettingsCredentialFree } from "./model-settings.js";
import { loadPrivateDocsFabEnvironment } from "./private-environment.js";
import { decodeHostConfig, projectHostConfigToEnvironment } from "./profile-projection.js";
import { activateContractDecodeLimits, limit, limitDefinition } from "./limits.js";
import { parseRetryPolicy } from "./retry-policy.js";
import {
  repositoryEvidenceGitLimits,
  type RepositoryEvidenceGitLimitsV1,
} from "./repository-evidence-limits.js";
import { resolveToolOutputCapBytes } from "../harness/tool-output-cap.js";

/**
 * Host-owned composition settings, independent of verified model capabilities.
 * Defaults are the catalog's admitted maxima. Explicit host settings may lower
 * them; sealed candidate, composition, and package limits still apply. Default
 * and maximum come from one definition so the loader and its tests cannot drift.
 */
function shippedPair(name: string): { readonly default: number; readonly max: number } {
  const definition = limitDefinition(name);
  return { default: definition.value, max: definition.max };
}

export const COMPOSITION_EXECUTION_LIMITS = {
  maxProviderTurns: shippedPair("compositionExecution.maxProviderTurns"),
  // This is the host term of the effective attempt timer. Raising it does not
  // raise the selected composition's sealed timeout or the whole-job deadline.
  timeoutMs: shippedPair("compositionExecution.timeoutMs"),
  maxResponseBytes: shippedPair("compositionExecution.maxResponseBytes"),
} as const;

/**
 * Host policy for one composition step attempt, across its provider requests.
 * These cumulative token allowances are not a per-job total or a per-request
 * context window, and are not part of the sealed CompositionModelLimits vector.
 * Operators can lower them; that changes spending policy, not model capability,
 * write authority, or composition qualification.
 *
 * Provider-turn and tool-call allowances are independent of cumulative tokens.
 * The lease shape still has to fit the selected lane's sealed turn ceiling;
 * changing these defaults does not widen that contract.
 */
export const COMPOSITION_EXECUTION_ENVELOPE = {
  callsPerLease: shippedPair("compositionExecution.callsPerLease"),
  maxLeases: shippedPair("compositionExecution.maxLeases"),
  maxToolCallsPerStep: shippedPair("compositionExecution.maxToolCallsPerStep"),
  maxCumulativeInputTokens: shippedPair("compositionExecution.maxCumulativeInputTokens"),
  maxCumulativeOutputTokens: shippedPair("compositionExecution.maxCumulativeOutputTokens"),
} as const;

export interface CompositionExecutionEnvelope {
  readonly callsPerLease: number;
  readonly maxLeases: number;
  readonly maxToolCallsPerStep: number;
  readonly maxCumulativeInputTokens: number;
  readonly maxCumulativeOutputTokens: number;
}

/** Host-owned execution envelope, overridable per lane and independent of turns. */
export function loadCompositionExecutionEnvelope(
  environment: NodeJS.ProcessEnv = process.env,
): CompositionExecutionEnvelope {
  const options = { environment };
  return Object.freeze({
    callsPerLease: limit("compositionExecution.callsPerLease", options).value,
    maxLeases: limit("compositionExecution.maxLeases", options).value,
    maxToolCallsPerStep: limit("compositionExecution.maxToolCallsPerStep", options).value,
    maxCumulativeInputTokens: limit("compositionExecution.maxCumulativeInputTokens", options).value,
    maxCumulativeOutputTokens: limit("compositionExecution.maxCumulativeOutputTokens", options)
      .value,
  });
}

/**
 * Preserve the host's complete pre-clamp composition limit vector. The first
 * three fields come from the configured profile; the remaining fields are
 * bounded host policy. Composition/candidate/package clamps happen later.
 */
export function loadConfiguredCompositionModelLimits(
  profile: ModelProfile,
  environment: NodeJS.ProcessEnv = process.env,
): CompositionModelLimits {
  const options = { environment };
  return Object.freeze({
    ...profile.configuredLimits,
    maxProviderTurns: limit("compositionExecution.maxProviderTurns", options).value,
    timeoutMs: limit("compositionExecution.timeoutMs", options).value,
    maxResponseBytes: limit("compositionExecution.maxResponseBytes", options).value,
  });
}

/** Complete runtime configuration assembled from host paths and model profiles. */
export interface DocsFabConfig {
  projectRoot: string;
  skillCrateDirectory: string;
  qualityDirectory: string;
  qualityPackDirectory: string;
  stateDirectory: string;
  retryPolicy: InferenceRetryPolicy;
  /**
   * `DOCSFAB_ANSWER_SUBMISSION`, validated at load. Absent on a configuration
   * built elsewhere, which reads as the default, `recorded`.
   */
  answerSubmission?: AnswerSubmissionOption;
  model: ModelEndpointConfig;
  judge?: ModelEndpointConfig;
}

/** Host settings for the registered structural audit, without a model slot. */
export type NonInferenceRuntimeConfig = Omit<DocsFabConfig, "model" | "judge"> & {
  readonly execution: "without-inference";
  /** Effective host cap retained without publishing the private environment globally. */
  readonly toolOutputCapBytes: number;
  /** Nonsecret effective git bounds used by the audit's patch collector. */
  readonly repositoryEvidenceGitLimits: RepositoryEvidenceGitLimitsV1;
};

export type RunRuntimeConfig = DocsFabConfig | NonInferenceRuntimeConfig;

/** A model-backed workflow cannot run with the audit's host-only configuration. */
export class ModelRuntimeRequiredOperatorError extends Error {
  readonly code = "model-runtime-required";
  readonly nextAction =
    "Configure a model profile for this workflow, or run audit-documentation for structural checks.";

  constructor() {
    super("The selected workflow requires a configured model runtime before execution can begin.");
    this.name = "ModelRuntimeRequiredOperatorError";
  }
}

export function isNonInferenceRuntimeConfig(
  config: RunRuntimeConfig,
): config is NonInferenceRuntimeConfig {
  return "execution" in config && config.execution === "without-inference";
}

/** Installed locked-asset paths without loading provider profiles or credentials. */
export function resolveDocsFabRuntimeAssetPaths(
  environment: NodeJS.ProcessEnv = process.env,
): Pick<
  DocsFabConfig,
  "projectRoot" | "skillCrateDirectory" | "qualityDirectory" | "qualityPackDirectory"
> {
  const projectRoot = resolveDocsFabProjectRoot();
  return {
    projectRoot,
    skillCrateDirectory: resolve(
      environment.DOCSFAB_SKILL_CRATE_DIR ?? resolve(projectRoot, "skill-crate"),
    ),
    qualityDirectory: resolve(environment.DOCSFAB_QUALITY_DIR ?? resolve(projectRoot, "quality")),
    qualityPackDirectory: resolve(
      environment.DOCSFAB_QUALITY_PACK_DIR ?? resolve(projectRoot, "quality-pack"),
    ),
  };
}

const RUNTIME_ASSET_VARIABLES = [
  "DOCSFAB_SKILL_CRATE_DIR",
  "DOCSFAB_QUALITY_DIR",
  "DOCSFAB_QUALITY_PACK_DIR",
] as const;

/**
 * The locked-asset paths `loadConfig` selects, without loading any credential:
 * host.yaml `paths.*` over the environment, then the secrets or legacy `.env`
 * file for a variable still unset, then the packaged default. Only these three
 * variables are read from that file.
 */
export function resolveConfiguredRuntimeAssetPaths(
  environment: NodeJS.ProcessEnv = process.env,
): ReturnType<typeof resolveDocsFabRuntimeAssetPaths> {
  const effective = environment === process.env ? process.env : { ...process.env, ...environment };
  const selected: NodeJS.ProcessEnv = {};
  for (const name of RUNTIME_ASSET_VARIABLES) {
    if (effective[name] !== undefined) selected[name] = effective[name];
  }
  const source = describeDocsFabConfigurationSource(effective);
  if (source.layout === "split") {
    const hostPath = resolve(source.configurationRoot, "host.yaml");
    const host = decodeHostConfig(parseYaml(readFileSync(hostPath, "utf8")));
    projectHostConfigToEnvironment(host, selected, source.configurationRoot);
  }
  if (source.secretsFile !== null && existsSync(source.secretsFile)) {
    const assignments = parseDotenvAssignments(readFileSync(source.secretsFile, "utf8"));
    for (const name of RUNTIME_ASSET_VARIABLES) {
      const value = assignments.get(name);
      if (selected[name] === undefined && value !== undefined) selected[name] = value;
    }
  }
  return resolveDocsFabRuntimeAssetPaths(selected);
}

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
  options: ModelSettingsLoadOptions = {},
): DocsFabConfig {
  // A private copy: the configuration and its credentials never reach the
  // process environment that child processes inherit.
  const effectiveEnvironment = loadPrivateDocsFabEnvironment(environment, options);
  // A setting that holds a configured credential stops here, before any record.
  assertModelSettingsCredentialFree(effectiveEnvironment);
  const configurationRoot = resolveDocsFabConfigurationRoot(effectiveEnvironment);
  const profileOrigin = classifyConfigurationProvenance(configurationRoot, effectiveEnvironment);
  const assets = resolveDocsFabRuntimeAssetPaths(effectiveEnvironment);
  activateContractDecodeLimits({ environment: effectiveEnvironment });
  const configured = loadModelConfigurations(effectiveEnvironment, { origin: profileOrigin });
  return {
    ...assets,
    stateDirectory: resolveDocsFabStateDirectory(effectiveEnvironment),
    retryPolicy: parseRetryPolicy(effectiveEnvironment),
    answerSubmission: parseAnswerSubmissionOption(effectiveEnvironment),
    ...configured,
    model: {
      ...configured.model,
      ...(effectiveEnvironment.DOCSFAB_ACTIVE_EXECUTION_PROFILE?.trim()
        ? { compositionId: effectiveEnvironment.DOCSFAB_ACTIVE_EXECUTION_PROFILE.trim() }
        : {}),
    },
    ...(configured.judge
      ? {
          judge: {
            ...configured.judge,
            ...(effectiveEnvironment.DOCSFAB_ACTIVE_JUDGE_EXECUTION_PROFILE?.trim()
              ? {
                  compositionId: effectiveEnvironment.DOCSFAB_ACTIVE_JUDGE_EXECUTION_PROFILE.trim(),
                }
              : {}),
          },
        }
      : {}),
  };
}

/** Load host assets, limits, state, and retry policy for the no-model audit. */
export function loadNonInferenceRuntimeConfig(
  environment: NodeJS.ProcessEnv = process.env,
): NonInferenceRuntimeConfig {
  const effectiveEnvironment = loadPrivateDocsFabEnvironment(environment);
  resolveDocsFabConfigurationRoot(effectiveEnvironment);
  activateContractDecodeLimits({ environment: effectiveEnvironment });
  return {
    execution: "without-inference",
    ...resolveDocsFabRuntimeAssetPaths(effectiveEnvironment),
    stateDirectory: resolveDocsFabStateDirectory(effectiveEnvironment),
    retryPolicy: parseRetryPolicy(effectiveEnvironment),
    answerSubmission: parseAnswerSubmissionOption(effectiveEnvironment),
    toolOutputCapBytes: resolveToolOutputCapBytes(effectiveEnvironment),
    repositoryEvidenceGitLimits: repositoryEvidenceGitLimits({
      environment: effectiveEnvironment,
    }),
  };
}

/** Load and validate only the explicitly selected profile-inspection slot. */
export function loadModelEndpointForInspection(purpose: "policy" | "judge"): ModelEndpointConfig {
  const environment = loadPrivateDocsFabEnvironment();
  assertModelSettingsCredentialFree(environment);
  const configurationRoot = resolveDocsFabConfigurationRoot(environment);
  const profileOrigin = classifyConfigurationProvenance(configurationRoot, environment);
  const endpoint = loadModelEndpointForInspectionFromEnvironment(purpose, environment, {
    origin: profileOrigin,
  });
  const compositionId =
    purpose === "judge"
      ? environment.DOCSFAB_ACTIVE_JUDGE_EXECUTION_PROFILE?.trim()
      : environment.DOCSFAB_ACTIVE_EXECUTION_PROFILE?.trim();
  return compositionId ? { ...endpoint, compositionId } : endpoint;
}

/**
 * Guess whether configuration inputs come from an unmigrated legacy
 * checkout/.env or a fresh install with no configuration file and no
 * MODEL_/JUDGE_ variable. It selects remediation wording only (migration or
 * initial setup); it is not a readiness check.
 *
 * "legacy" means at least one signal was seen, not that a usable profile
 * exists. `loadModelConfigurations` decides whether a profile is complete.
 */
function classifyConfigurationProvenance(
  configurationRoot: string,
  environment: NodeJS.ProcessEnv,
): "fresh" | "legacy" {
  const hasConfigurationFile =
    existsSync(resolve(configurationRoot, "host.yaml")) ||
    existsSync(resolve(configurationRoot, ".env"));
  const hasLegacyCheckoutEnv =
    environment.DOCSFAB_CONFIG_ROOT === undefined &&
    existsSync(resolve(resolveDocsFabProjectRoot(), ".env"));
  const hasProfileEnvironment = Object.entries(environment).some(
    ([name, value]) => /^(?:MODEL|JUDGE)_/u.test(name) && Boolean(value?.trim()),
  );
  return !hasConfigurationFile && !hasLegacyCheckoutEnv && !hasProfileEnvironment
    ? "fresh"
    : "legacy";
}
