// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * What a bound profile's reasoning setting puts on the wire, per transport, so
 * the run record and the request agree.
 *
 * With reasoning on, each Pi-session turn carries a thinking level: the
 * operator's `reasoningEffort`, or Pi's own default level, `medium`, when none
 * is set, as Pi sessions sent before. A one-shot call (request
 * interpretation, the first-pass checks, the judges) keeps its own policy,
 * thinking off, unless an operator set reasoning for that model's slot.
 * - Chat completions carry an effort as `reasoning_effort`. With no effort,
 *   a route that declares no effort support gets no reasoning field.
 * - The Responses API carries it as `reasoning.effort`.
 * - Anthropic Messages turns on adaptive thinking with `output_config.effort`
 *   for a model Pi's catalog marks adaptive (Claude 4.6 and later); it has no
 *   `minimal` effort, so `minimal` is sent as `low`. Any other model binds
 *   reasoning off and the binding says so: Pi would add a thinking budget on
 *   top of the turn's output limit, which the output limit refuses.
 * With reasoning off, no level is passed, and each transport keeps its
 * existing off behavior; on Anthropic Messages, a model that thinks by
 * default also gets `thinking: {type: "disabled"}`, or a warning when it
 * cannot turn thinking off.
 */
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";

import type { ProviderTransport } from "../config/model-providers.js";
import type { ReasoningEffortLevel } from "../config/model-settings.js";

/** Pi's own default thinking level (pi-coding-agent `DEFAULT_THINKING_LEVEL`). */
export const PI_DEFAULT_THINKING_LEVEL: ReasoningEffortLevel = "medium";

/**
 * The part of a bound execution profile that decides reasoning on the wire.
 * Structural, so the binder in `configuration.ts` can use this module.
 */
interface ReasoningWireProfile {
  readonly modelId: string;
  readonly transport: ProviderTransport;
  readonly profile?: {
    readonly reasoning: boolean;
    readonly compatibility: { readonly supportsReasoningEffort: boolean };
  };
  readonly reasoningEffort?: string;
  readonly compositionRequestPolicy?: unknown;
}

/**
 * Whether Pi's own Anthropic catalog gives a model adaptive thinking. A
 * gateway's id matches by its last segment, such as
 * `aws/anthropic/bedrock-claude-sonnet-5` for `claude-sonnet-5`, and the
 * longest catalog id wins. A model the catalog does not know, or lists
 * without adaptive thinking, cannot carry reasoning (see `carriesReasoning`).
 */
export function anthropicThinking(modelId: string): {
  readonly catalogId?: string;
  readonly adaptive: boolean;
} {
  let best: { readonly id: string; readonly adaptive: boolean } | undefined;
  for (const model of getBuiltinModels("anthropic")) {
    const id = model.id as string;
    const matches = modelId === id || modelId.endsWith(`/${id}`) || modelId.endsWith(`-${id}`);
    if (matches && (!best || id.length > best.id.length)) {
      best = { id, adaptive: model.compat?.forceAdaptiveThinking === true };
    }
  }
  return best ? { catalogId: best.id, adaptive: best.adaptive } : { adaptive: false };
}

/**
 * Anthropic models that think when a Messages request omits `thinking`, per
 * the Claude API reference: `disable` accepts `{type: "disabled"}`, which
 * DocsFab sends with reasoning off; `always` refuses it, so the model may
 * think whatever DocsFab sends. Pi's catalog has no flag for this. Other
 * models think only when asked.
 */
const DEFAULT_THINKING: Readonly<Record<string, "disable" | "always">> = {
  "claude-sonnet-5": "disable",
  "claude-opus-5": "disable",
  "claude-haiku-5-5": "disable",
  "claude-opus-5-5": "always",
  "claude-sonnet-5-5": "always",
  "claude-fable-5": "always",
  "claude-fable-5-1": "always",
  "claude-mythos-5": "always",
  "claude-mythos-5-1": "always",
};

/** How a model treats a Messages request without `thinking`, matched like the catalog. */
export function anthropicDefaultThinking(modelId: string): "disable" | "always" | undefined {
  const [id] = Object.keys(DEFAULT_THINKING)
    .filter(
      (each) => modelId === each || modelId.endsWith(`/${each}`) || modelId.endsWith(`-${each}`),
    )
    .sort((left, right) => right.length - left.length);
  return id === undefined ? undefined : DEFAULT_THINKING[id];
}

/** Whether a model on a transport can carry reasoning DocsFab sends. */
export function carriesReasoning(transport: string, modelId: string): boolean {
  return transport !== "anthropic-messages" || anthropicThinking(modelId).adaptive;
}

/** The thinking level DocsFab passes to Pi, or undefined when reasoning is off. */
export function thinkingLevelFor(profile: ReasoningWireProfile): ReasoningEffortLevel | undefined {
  // A profile not loaded yet has no reasoning setting to send.
  if (profile.compositionRequestPolicy || profile.profile?.reasoning !== true) return undefined;
  return (profile.reasoningEffort as ReasoningEffortLevel | undefined) ?? PI_DEFAULT_THINKING_LEVEL;
}

/** The effort an Anthropic Messages request carries for an effort level. */
export function anthropicEffort(level: ReasoningEffortLevel): string {
  return level === "minimal" ? "low" : level;
}

/**
 * Warnings for a reasoning setting a request cannot send as recorded: an
 * Anthropic `minimal` effort sent as `low`, and reasoning asked of a model
 * that cannot carry it. Empty when the request carries what the record says,
 * including Pi's default level when no effort is set, which Pi sessions sent
 * before too.
 *
 * `requested` is what the configuration asked for before binding: an
 * operator's reasoning and effort, and the profile's own reasoning.
 */
export function reasoningWireNotes(
  profile: ReasoningWireProfile,
  requested: {
    readonly reasoning?: boolean;
    readonly effort?: string;
    readonly profileReasoning?: boolean;
  } = {},
): string[] {
  // Reasoning is off, but this model thinks unless told not to and refuses that.
  const defaultThinking =
    profile.transport === "anthropic-messages" &&
    profile.profile?.reasoning !== true &&
    anthropicDefaultThinking(profile.modelId) === "always"
      ? [
          `Model ${profile.modelId} thinks by default on Anthropic Messages and cannot turn thinking off, so it may think although reasoning is recorded as off.`,
        ]
      : [];
  if (!carriesReasoning(profile.transport, profile.modelId)) {
    if ((requested.reasoning ?? requested.profileReasoning) !== true) return defaultThinking;
    return [
      ...defaultThinking,
      `Reasoning${requested.effort ? ` at reasoningEffort ${requested.effort}` : ""} is not sent: model ${profile.modelId} has no adaptive thinking in Pi's catalog, and DocsFab sends Anthropic Messages thinking only as adaptive thinking, so requests keep thinking off.`,
    ];
  }
  const level = thinkingLevelFor(profile);
  if (
    level === undefined ||
    profile.reasoningEffort === undefined ||
    profile.transport !== "anthropic-messages" ||
    anthropicEffort(level) === level
  ) {
    return defaultThinking;
  }
  return [
    `reasoningEffort ${level} is sent as ${anthropicEffort(level)}: Anthropic Messages efforts are low, medium, high, xhigh, and max.`,
  ];
}
