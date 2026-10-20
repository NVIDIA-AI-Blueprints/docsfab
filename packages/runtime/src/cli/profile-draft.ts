// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { canonicalDigest, deepFreeze } from "../contract-kit/index.js";
import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../json-evidence.js";
import {
  listInstalledModelCompositions,
  loadInstalledModelCompositionAuthority,
  resolveInstalledComposition,
} from "../model-composition/index.js";
import {
  isInstalledPolicyRoute,
  type InstalledExecutionComposition,
  type InstalledPolicyRouteId,
  type InstalledRequestPolicy,
} from "../model-composition/types.js";
import { DOCSFAB_SYSTEM_PROMPT_SHA256 } from "../model/request-policy.js";
import type { ProfileDraftArguments, ProfileProbeVerdict } from "./profile-arguments.js";
import { assertExactModelId, isProbeableRouteId } from "./profile-probe.js";

export const PROFILE_DRAFT_KIND = "docsfab-profile-draft";
export const RESEAL_COMPOSITION_DIGESTS_SCRIPT = "scripts/reseal-composition-digests.mts";
export const RESEAL_COMPOSITION_DIGESTS_COMMAND =
  "node --import tsx scripts/reseal-composition-digests.mts";

export interface ProfileDraftRecord {
  readonly schemaVersion: 1;
  readonly kind: typeof PROFILE_DRAFT_KIND;
  readonly locator: string;
  readonly verdict: ProfileProbeVerdict;
  readonly composition: InstalledExecutionComposition;
  readonly resealCommand: typeof RESEAL_COMPOSITION_DIGESTS_COMMAND;
  readonly resealScript: typeof RESEAL_COMPOSITION_DIGESTS_SCRIPT;
  readonly registryUnchanged: true;
}

export interface ProfileDraftDependencies {
  readonly loadTemplate?: (routeId: string) => Promise<InstalledExecutionComposition>;
}

const OPTIONAL_POLICY_ROUTES = new Set<string>(["nvidia-inference-api"]);

export function routeMarksRequestPolicyOptional(routeId: string): boolean {
  return OPTIONAL_POLICY_ROUTES.has(routeId);
}

function modelSlug(modelId: string): string {
  return (modelId.split("/").pop() ?? modelId).toLowerCase();
}

function inferVendor(modelId: string): string {
  const parts = modelId.split("/");
  if (parts.length === 3 && parts[1]) return parts[1];
  if (parts.length === 2 && parts[0]) return parts[0];
  if (/^gpt-/u.test(modelId) || modelId.startsWith("chatgpt-")) return "openai";
  throw new Error("profile draft could not infer a vendor from the exact model id.");
}

function draftCompositionId(routeId: string, modelId: string): string {
  const slug = modelSlug(modelId);
  if (routeId === "nvidia-inference-api") return `nvidia-inference-${slug}-pi`;
  if (routeId === "nvidia-api-catalog") return `nvidia-${slug}-pi`;
  if (routeId === "openai-api") return `openai-${slug}-pi`;
  return `${routeId}-${slug}-pi`;
}

function measuredRequestPolicy(input: {
  readonly modelId: string;
  readonly routeId: InstalledPolicyRouteId;
  readonly deploymentIdentitySha256: string;
}): InstalledRequestPolicy {
  const body = {
    schemaVersion: 1 as const,
    modelId: input.modelId,
    routeId: input.routeId,
    deploymentIdentitySha256: input.deploymentIdentitySha256,
    transport: "openai-chat-completions" as const,
    reasoningMode: "disabled" as const,
    reasoningControl: { kind: "chat-template-kwarg" as const, thinking: false as const },
    installedSystemInstructionSha256: DOCSFAB_SYSTEM_PROMPT_SHA256,
    temperature: 0 as const,
    topP: 1 as const,
  };
  return deepFreeze({ ...body, policySha256: canonicalDigest(body) });
}

export function shouldIncludeMeasuredRequestPolicy(
  routeId: string,
  verdict: ProfileProbeVerdict,
): boolean {
  return verdict === "reasoning-split-controllable" && isInstalledPolicyRoute(routeId);
}

async function loadInstalledRouteTemplate(routeId: string): Promise<InstalledExecutionComposition> {
  const { authority, snapshot } = await loadInstalledModelCompositionAuthority();
  const match = listInstalledModelCompositions(authority).find(
    (entry) =>
      entry.routeId === routeId &&
      entry.executionClass === "pi-provider" &&
      entry.status === "active",
  );
  const workflowId = snapshot.workflowIds[0];
  if (!match || !workflowId) {
    throw new Error(`profile draft has no installed executable template for route "${routeId}".`);
  }
  return resolveInstalledComposition({
    authority,
    compositionId: match.compositionId,
    workflowId,
  }).composition;
}

export async function runProfileDraft(
  args: ProfileDraftArguments,
  dependencies: ProfileDraftDependencies = {},
): Promise<ProfileDraftRecord> {
  assertExactModelId(args.modelId);
  if (!isProbeableRouteId(args.routeId)) {
    throw new Error("profile draft received an unknown serving route and cannot draft.");
  }
  if (args.verdict === "unreachable") {
    throw new Error(
      "profile draft refuses unreachable probe verdicts and does not emit a composition.",
    );
  }
  if (args.verdict === "reasoning-split-uncontrolled") {
    throw new Error(
      "profile draft refuses reasoning-split-uncontrolled probe verdicts and does not emit a composition.",
    );
  }
  if (
    isInstalledPolicyRoute(args.routeId) &&
    !routeMarksRequestPolicyOptional(args.routeId) &&
    args.verdict !== "reasoning-split-controllable"
  ) {
    throw new Error(
      "profile draft requires a reasoning-split-controllable verdict on routes that require an installed request policy.",
    );
  }

  const template = await (dependencies.loadTemplate ?? loadInstalledRouteTemplate)(args.routeId);
  if (template.deployment.routeId !== args.routeId) {
    throw new Error("profile draft template does not match the requested serving route.");
  }

  const includePolicy = shouldIncludeMeasuredRequestPolicy(args.routeId, args.verdict);
  const requestPolicy =
    includePolicy && isInstalledPolicyRoute(args.routeId)
      ? measuredRequestPolicy({
          modelId: args.modelId,
          routeId: args.routeId,
          deploymentIdentitySha256: template.deployment.identitySha256,
        })
      : undefined;

  const body = {
    schemaVersion: 1 as const,
    compositionId: draftCompositionId(args.routeId, args.modelId),
    status: "active" as const,
    executionClass: template.executionClass,
    model: {
      vendor: inferVendor(args.modelId),
      requestedId: args.modelId,
      resolvedId: args.modelId,
    },
    deployment: { ...template.deployment },
    authentication: { ...template.authentication },
    ...(requestPolicy ? { requestPolicy } : {}),
    harness: { ...template.harness },
    adapters: { ...template.adapters },
    compositionLimits: { ...template.compositionLimits },
    limitations: [...template.limitations],
  };
  const composition = deepFreeze({
    ...body,
    compositionSha256: canonicalDigest(body),
  }) as InstalledExecutionComposition;

  return deepFreeze({
    schemaVersion: 1,
    kind: PROFILE_DRAFT_KIND,
    locator: `${args.routeId}:${args.modelId}`,
    verdict: args.verdict,
    composition,
    resealCommand: RESEAL_COMPOSITION_DIGESTS_COMMAND,
    resealScript: RESEAL_COMPOSITION_DIGESTS_SCRIPT,
    registryUnchanged: true,
  });
}

export function formatProfileDraft(draft: ProfileDraftRecord): string {
  return [
    `Draft composition: ${draft.composition.compositionId}`,
    `Locator: ${draft.locator}`,
    `Verdict: ${draft.verdict}`,
    `Request policy: ${draft.composition.requestPolicy ? "measured chat-template-kwarg" : "omitted"}`,
    "Registry unchanged. After an authorized paste into composition-registry.json, reseal with:",
    `  ${draft.resealCommand}`,
    `from packages/runtime (${draft.resealScript}). Then run npm run check:composition-digests.`,
    "Do not merge the registry from this command.",
  ].join("\n");
}

export function serializeProfileDraft(draft: ProfileDraftRecord): string {
  return canonicalizeJsonEvidence(draft as unknown as JsonEvidenceValue);
}
