// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { decodeCompositionRegistry } from "../model-composition/contracts.js";
import { assertCompositionNotRetired } from "../model-composition/retirement.js";
import { ModelCompositionError } from "../model-composition/types.js";
import type { InstalledExecutionComposition } from "../model-composition/types.js";
import {
  assertRawModelIdNotRetired,
  assertSelectionNotRetired,
  isRetiredSelection,
} from "../setup/retired-selections.js";
import { EXECUTABLE_ROUTE_BASE_URLS, EXECUTABLE_ROUTE_ORIGINS } from "./executable-route-urls.js";
import {
  DEFAULT_PURPOSE_SLOT_QUALIFICATION,
  modelProfileFromAssignments,
  projectModelProfileToEnvironment,
  type ExecutionPurpose,
  type HostPurposeSlotV1,
  type ModelProfileSlot,
} from "./profile-projection.js";

export { EXECUTABLE_ROUTE_BASE_URLS, EXECUTABLE_ROUTE_ORIGINS };

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export type ExecutableRouteId = keyof typeof EXECUTABLE_ROUTE_BASE_URLS;

const UNKNOWN_SETUP_PROFILE =
  "DocsFab setup --profile requires an executable installed composition id.";

let compositionCache: readonly InstalledExecutionComposition[] | undefined;

function readInstalledCompositions(): readonly InstalledExecutionComposition[] {
  if (compositionCache) return compositionCache;
  const registryPath = resolve(packageRoot, "model-compositions", "composition-registry.json");
  if (!existsSync(registryPath)) {
    throw new Error(
      "DocsFab could not read the installed composition registry for host profile selection.",
    );
  }
  try {
    compositionCache = decodeCompositionRegistry(
      JSON.parse(readFileSync(registryPath, "utf8")),
    ).compositions;
  } catch (error) {
    if (error instanceof ModelCompositionError) {
      // hygiene: envelope
      throw error;
    }
    throw new Error(
      "DocsFab could not decode the installed composition registry for host profile selection.",
    );
  }
  return compositionCache;
}

export function resolveSetupExecutionProfile(profile: string | undefined): string | undefined {
  if (profile === undefined) return undefined;
  const id = profile.trim();
  if (!id) {
    throw new Error(
      "The setup command requires a non-empty identifier value after the --profile option.",
    );
  }
  assertSelectionNotRetired(id);
  const composition = readInstalledCompositions().find((entry) => entry.compositionId === id);
  if (composition) {
    assertCompositionNotRetired(composition);
    if (composition.status !== "active" || composition.executionClass !== "pi-provider") {
      throw new Error(
        `Composition "${id}" is not an executable composition and cannot be selected for host setup.`,
      );
    }
    return id;
  }
  throw new Error(UNKNOWN_SETUP_PROFILE);
}

/**
 * The named `composition-retired` refusal for a host's current model selection,
 * or undefined when that selection is live. A selection is retired when it is
 * a retired installed composition id or legacy shortcut, a raw profile naming
 * a retired model id, or a raw profile that uniquely names a retired installed
 * composition's route and model. Startup and bare `docsfab setup` both report
 * the refusal, which names the successor to select explicitly.
 */
export function retiredModelSelectionRefusal(selection: {
  readonly executionProfileId?: string;
  readonly provider?: string;
  readonly modelId?: string;
}): Error | undefined {
  const attempt = (check: () => void): Error | undefined => {
    try {
      check();
      return undefined;
    } catch (error) {
      if (error instanceof ModelCompositionError && error.code === "composition-retired") {
        return error;
      }
      throw error;
    }
  };
  const executionProfileId = selection.executionProfileId?.trim();
  if (executionProfileId) {
    return attempt(() => {
      assertSelectionNotRetired(executionProfileId);
      const composition = readInstalledCompositions().find(
        (entry) => entry.compositionId === executionProfileId,
      );
      if (composition) assertCompositionNotRetired(composition);
    });
  }
  const modelId = selection.modelId?.trim();
  if (!modelId) return undefined;
  return attempt(() => {
    assertRawModelIdNotRetired(modelId);
    const matched = readInstalledCompositions().filter(
      (entry) =>
        entry.executionClass === "pi-provider" &&
        entry.deployment.routeId === selection.provider?.trim() &&
        entry.model.resolvedId === modelId,
    );
    if (matched.length === 1) assertCompositionNotRetired(matched[0]!);
  });
}

export function requiredSecretNamesForExecutionProfile(profileId: string): readonly string[] {
  const composition = requireInstalledComposition(profileId);
  return Object.freeze([...composition.authentication.sourceNames]);
}

export function projectExecutionProfileIntoEnvironment(
  profileId: string,
  target: NodeJS.ProcessEnv,
  slot: ModelProfileSlot = "policy",
): void {
  let policyAssignments = assignmentsForExecutionProfile(profileId);
  if (!policyAssignments.some(([key]) => key === "MODEL_BASE_URL")) {
    const baseUrl = target[slot === "policy" ? "MODEL_BASE_URL" : "JUDGE_BASE_URL"]?.trim();
    if (!baseUrl) {
      throw new Error(
        "The selected profile has no default endpoint in this installation. Run docsfab setup to configure a supported provider endpoint.",
      );
    }
    policyAssignments = [...policyAssignments, ["MODEL_BASE_URL", baseUrl]];
  }
  const assignments =
    slot === "policy" ? policyAssignments : mapPolicyAssignmentsToJudge(policyAssignments);
  const profile = modelProfileFromAssignments(slot, assignments);
  projectModelProfileToEnvironment(profile, target);
  if (slot === "policy") {
    target.DOCSFAB_ACTIVE_EXECUTION_PROFILE = profileId;
    return;
  }
  target.DOCSFAB_ACTIVE_JUDGE_EXECUTION_PROFILE = profileId;
  target.JUDGE_ENABLED = "true";
}

/**
 * Every variable a preset projects for one slot, including its transport: the
 * preset's defaults, which operator settings override key by key.
 */
export function presetSlotAssignments(
  profileId: string,
  slot: ModelProfileSlot = "policy",
): ReadonlyMap<string, string> {
  const composition = requireInstalledComposition(profileId);
  const policy: ReadonlyArray<readonly [string, string]> = [
    ...assignmentsForExecutionProfile(profileId),
    ["MODEL_TRANSPORT", composition.deployment.transport],
  ];
  return new Map(slot === "policy" ? policy : mapPolicyAssignmentsToJudge(policy));
}

/** Whether `profileId` names an active, executable installed composition. */
export function isExecutablePreset(profileId: string): boolean {
  return compositionSelectability(profileId) === "executable";
}

export function applyCompositionCredentialAlias(
  profileId: string,
  target: NodeJS.ProcessEnv,
  slot: ModelProfileSlot = "policy",
): void {
  if (slot === "judge") {
    applyJudgeCompositionCredentialAlias(profileId, target);
    return;
  }
  if (target.MODEL_API_KEY?.trim()) return;
  const available = requiredSecretNamesForExecutionProfile(profileId)
    .map((name) => [name, target[name]?.trim()] as const)
    .filter((entry): entry is readonly [string, string] => Boolean(entry[1]));
  if (available.length === 1) target.MODEL_API_KEY = available[0]![1];
}

/**
 * Resolve the composition used for a purpose slot at host select/load time.
 * A declared fallback replaces a retired primary only here, never mid-run.
 * Qualification is recorded and never consulted.
 */
export function selectPurposeCompositionId(
  slot: HostPurposeSlotV1 | undefined,
  purpose: ExecutionPurpose,
): string | undefined {
  const primary = slot?.compositionId?.trim();
  if (!primary) return undefined;
  const status = compositionSelectability(primary);
  if (status === "executable") return primary;
  if (status === "retired") {
    const fallback = slot?.fallbackCompositionId?.trim();
    if (fallback) {
      if (compositionSelectability(fallback) === "executable") return fallback;
      if (purpose === "judge") return undefined;
      throw new Error(
        `The declared writing fallback composition "${fallback}" is not an executable installed profile.`,
      );
    }
    if (purpose === "judge") return undefined;
    // A retired writing selection refuses by name, with its successor.
    assertSelectionNotRetired(primary);
    const composition = readInstalledCompositions().find(
      (entry) => entry.compositionId === primary,
    );
    if (composition) assertCompositionNotRetired(composition);
    throw new Error(
      `Composition "${primary}" is retired and cannot be selected as the active writing execution profile.`,
    );
  }
  throw new Error(
    `The host.yaml active.${purpose} compositionId must name an executable installed profile.`,
  );
}

export function executionProfileIdentity(
  profileId: string,
  configuredBaseUrl?: string,
): {
  providerId: string;
  baseUrl: string;
  modelId: string;
} {
  const env = Object.fromEntries(assignmentsForExecutionProfile(profileId));
  const providerId = env.MODEL_PROVIDER?.trim();
  const baseUrl = (env.MODEL_BASE_URL ?? configuredBaseUrl)?.trim().replace(/\/$/u, "");
  const modelId = env.MODEL_ID?.trim();
  if (!providerId || !baseUrl || !modelId) {
    throw new Error(
      "The selected execution profile does not declare provider, endpoint, and model identity fields.",
    );
  }
  return { providerId, baseUrl, modelId };
}

export function frozenHostCompositionIdForEndpoint(
  config: { providerId?: string; baseUrl?: string; modelId?: string },
  environment: NodeJS.ProcessEnv,
): string | undefined {
  const writing = environment.DOCSFAB_ACTIVE_EXECUTION_PROFILE?.trim();
  const judge = environment.DOCSFAB_ACTIVE_JUDGE_EXECUTION_PROFILE?.trim();
  const matches = (id: string | undefined): boolean => {
    if (!id || !config.providerId || !config.baseUrl || !config.modelId) return false;
    try {
      const identity = executionProfileIdentity(id, config.baseUrl);
      return (
        identity.providerId === config.providerId &&
        identity.baseUrl === config.baseUrl.replace(/\/$/u, "") &&
        identity.modelId === config.modelId
      );
    } catch {
      return false;
    }
  };
  const writingMatch = matches(writing);
  const judgeMatch = matches(judge);
  if (writingMatch && judgeMatch && writing !== judge) {
    throw new Error(
      "The configured endpoint matches both the writing and judge execution profiles; name distinct model, route, or endpoint fields for those slots.",
    );
  }
  const selected = judgeMatch ? judge : writingMatch ? writing : undefined;
  if (!selected) return undefined;
  if (compositionSelectability(selected) !== "executable") return undefined;
  return selected;
}

export function projectPurposeQualification(
  purpose: ExecutionPurpose,
  qualification: HostPurposeSlotV1["qualification"],
  target: NodeJS.ProcessEnv,
): void {
  const value = qualification ?? DEFAULT_PURPOSE_SLOT_QUALIFICATION;
  if (purpose === "writing") target.DOCSFAB_WRITING_QUALIFICATION = value;
  else target.DOCSFAB_JUDGE_QUALIFICATION = value;
}

function requireInstalledComposition(profileId: string): InstalledExecutionComposition {
  const composition = readInstalledCompositions().find(
    (entry) => entry.compositionId === profileId,
  );
  if (!composition) {
    assertSelectionNotRetired(profileId);
    throw new Error(UNKNOWN_SETUP_PROFILE);
  }
  assertCompositionNotRetired(composition);
  if (composition.status !== "active" || composition.executionClass !== "pi-provider") {
    throw new Error(
      `Composition "${profileId}" is not an executable composition and cannot be selected for host setup.`,
    );
  }
  return composition;
}

function assignmentsForExecutionProfile(
  profileId: string,
): ReadonlyArray<readonly [string, string]> {
  const composition = requireInstalledComposition(profileId);
  const routeId = composition.deployment.routeId;
  if (!isExecutableRouteId(routeId)) {
    throw new Error(
      `Installed composition "${profileId}" uses a serving route without a default endpoint in this installation. Run docsfab setup to configure a supported provider endpoint.`,
    );
  }
  const baseUrl = EXECUTABLE_ROUTE_BASE_URLS[routeId];
  const apiFormat =
    composition.deployment.transport === "anthropic-messages" ? "messages" : "chat_completions";
  const limits = composition.compositionLimits;
  return [
    ["MODEL_PROVIDER", routeId],
    ...(baseUrl === undefined ? [] : [["MODEL_BASE_URL", baseUrl] as const]),
    ["MODEL_ID", composition.model.resolvedId],
    ["MODEL_API_FORMAT", apiFormat],
    ["MODEL_CONTEXT_WINDOW", String(limits.contextWindow)],
    ["MODEL_MAX_INPUT_TOKENS", String(limits.maxInputTokens)],
    ["MODEL_MAX_OUTPUT_TOKENS", String(limits.maxOutputTokens)],
    ["MODEL_API_MIN_OUTPUT_TOKENS", "16"],
    ["MODEL_CONTEXT_RESERVE_TOKENS", "1024"],
    ["MODEL_REASONING", "false"],
    ["MODEL_INPUT_TYPES", "text"],
    ["MODEL_SUPPORTS_DEVELOPER_ROLE", "false"],
    ["MODEL_SUPPORTS_REASONING_EFFORT", "false"],
    ["MODEL_COMPATIBLE_API_FORMATS", apiFormat],
    ["MODEL_INPUT_COST_PER_MILLION", "unknown"],
    ["MODEL_OUTPUT_COST_PER_MILLION", "unknown"],
    ["MODEL_CACHE_READ_COST_PER_MILLION", "unknown"],
    ["MODEL_CACHE_WRITE_COST_PER_MILLION", "unknown"],
    ["MODEL_PROFILE_APPROVED_SOURCE", "unknown"],
    ["MODEL_PROFILE_EFFECTIVE_DATE", "unknown"],
    ["MODEL_PROFILE_REVIEW_AFTER", "unknown"],
  ];
}

function isExecutableRouteId(value: string): value is ExecutableRouteId {
  return value === "nvidia-inference-api" || Object.hasOwn(EXECUTABLE_ROUTE_BASE_URLS, value);
}

function mapPolicyAssignmentsToJudge(
  assignments: ReadonlyArray<readonly [string, string]>,
): ReadonlyArray<readonly [string, string]> {
  return assignments.map(([key, value]) => {
    if (key === "MODEL_ID") return ["JUDGE_MODEL_ID", value] as const;
    return [key.replace(/^MODEL_/u, "JUDGE_"), value] as const;
  });
}

function applyJudgeCompositionCredentialAlias(profileId: string, target: NodeJS.ProcessEnv): void {
  if (target.JUDGE_API_KEY?.trim()) return;
  const names = requiredSecretNamesForExecutionProfile(profileId);
  const providerSpecific = names
    .filter((name) => name !== "MODEL_API_KEY")
    .map((name) => target[name]?.trim())
    .filter((value): value is string => Boolean(value));
  if (providerSpecific.length === 1) {
    target.JUDGE_API_KEY = providerSpecific[0];
    return;
  }
  const writingId = target.DOCSFAB_ACTIVE_EXECUTION_PROFILE?.trim();
  if (writingId === profileId && target.MODEL_API_KEY?.trim()) {
    target.JUDGE_API_KEY = target.MODEL_API_KEY;
  }
}

function compositionSelectability(profileId: string): "executable" | "retired" | "not-executable" {
  // The legacy GPT-5.6 shortcut was never a registry record; it retires too.
  if (isRetiredSelection(profileId)) return "retired";
  const composition = readInstalledCompositions().find(
    (entry) => entry.compositionId === profileId,
  );
  if (!composition) return "not-executable";
  if (composition.status === "retired") return "retired";
  if (composition.status === "active" && composition.executionClass === "pi-provider") {
    return "executable";
  }
  return "not-executable";
}
