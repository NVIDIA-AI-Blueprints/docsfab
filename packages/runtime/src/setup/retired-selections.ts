// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Retired model selections that are not installed composition records.
 *
 * Installed compositions retire through the registry (`status: retired` plus a
 * `retirement` block). The selections here never were registry records: the
 * legacy `setup --profile` shortcut, the closed `--preset` field blocks, and
 * raw YAML or `.env` profiles naming the retired Inference Hub id. They retire
 * under the same operator decision and refuse with the same
 * `composition-retired` code, so an operator sees one class of stop whichever
 * way the retired model was selected.
 */
import { ModelCompositionError } from "../model-composition/types.js";
import { INTERNAL_SETUP_EXECUTION_PROFILE } from "./dogfood-profile.js";

/**
 * When every GPT-5.x selection retired. Operator text names the reason and this
 * instant only; who decided it, and why, stays in the installed registry record.
 */
const GPT_5_RETIRED_AT = "2026-09-28T00:00:00.000Z";

/** The retired Inference Hub GPT-5.6 Sol id every earlier bare setup wrote. */
export const RETIRED_SWITCHYARD_GPT_56_SOL = "switchyard/openai/gpt-5.6-sol";

interface RetiredSelection {
  /** Model family named in the refusal, such as `GPT-5.6`. */
  readonly family: string;
  /** Refuse a raw YAML, `.env`, or ambient profile naming this model id. */
  readonly refuseRawProfile: boolean;
}

/**
 * Setup `--profile` and `--preset` ids, and profile-seed presets, that no
 * longer select a model. Independently of this table, every GPT-5.6 family id
 * is refused as a raw profile on any route (`isGpt56FamilyModelId`), so the
 * `gpt-5.6-sol` entry is refused raw too. The GPT-5.4 preset is retired as a
 * selection only; a raw GPT-5.4 profile still loads (#1512 scope decision).
 */
const RETIRED_SELECTIONS: ReadonlyMap<string, RetiredSelection> = new Map([
  [RETIRED_SWITCHYARD_GPT_56_SOL, { family: "GPT-5.6", refuseRawProfile: true }],
  ["gpt-5.6-sol", { family: "GPT-5.6", refuseRawProfile: false }],
  ["azure/openai/gpt-5.4", { family: "GPT-5.4", refuseRawProfile: false }],
]);

export function isRetiredSelection(id: string | undefined): boolean {
  return id !== undefined && RETIRED_SELECTIONS.has(id.trim());
}

/** The operator remediation for any retired GPT-5.x selection. */
export function retiredSelectionNextAction(family = "GPT-5.6"): string {
  return `${family} is retired; run \`docsfab setup --profile ${INTERNAL_SETUP_EXECUTION_PROFILE}\` to move to GPT-6 Sol with \`MODEL_API_KEY\`, or choose another model with \`docsfab setup\` in a terminal.`;
}

/** Named `composition-retired` refusal for a retired selection id. */
export function retiredSelectionRefusal(id: string): ModelCompositionError {
  const selection = RETIRED_SELECTIONS.get(id.trim());
  const family = selection?.family ?? (isGpt56FamilyModelId(id) ? "GPT-5.6" : "GPT-5.x");
  // hygiene: envelope
  return new ModelCompositionError(
    "composition-retired",
    `Model selection "${id.trim()}" is retired (superseded-by-operator-decision, effective ${GPT_5_RETIRED_AT}) and cannot be selected for a new execution.`,
    retiredSelectionNextAction(family),
  );
}

/** Refuse a setup, seed, or host selection that names a retired id. */
export function assertSelectionNotRetired(id: string | undefined): void {
  if (id !== undefined && isRetiredSelection(id)) throw retiredSelectionRefusal(id);
}

/** The model id's final path segment, lower-cased: `azure/openai/GPT-5.6-Sol` -> `gpt-5.6-sol`. */
function modelIdLeaf(modelId: string): string {
  return (modelId.trim().split("/").pop() ?? "").toLowerCase();
}

/**
 * GPT-5.6 family ids under any vendor or route prefix: `gpt-5.6`,
 * `gpt-5.6-sol`, `gpt-5.6-terra`, `azure/openai/gpt-5.6-luna`,
 * `switchyard/openai/gpt-5.6-sol`. The whole family is retired by the
 * operator decision; the scope is recorded on #1512.
 */
export function isGpt56FamilyModelId(modelId: string | undefined): boolean {
  return modelId !== undefined && /^gpt-5\.6(?:$|[-.:_])/u.test(modelIdLeaf(modelId));
}

/**
 * Other GPT-5.x ids (for example `gpt-5.4`, `azure/openai/gpt-5.5`) are not
 * refused when an operator brings them through a provider option; setup shows
 * a warning instead. Scope decision recorded on #1512.
 */
export function isOtherGpt5ModelId(modelId: string | undefined): boolean {
  return (
    modelId !== undefined &&
    !isGpt56FamilyModelId(modelId) &&
    /^gpt-5(?:$|[-.:_])/u.test(modelIdLeaf(modelId))
  );
}

/** The visible warning for a bring-your-own GPT-5.x selection outside the GPT-5.6 family. */
export function gpt5BringYourOwnWarning(modelId: string): string {
  return `Model "${modelId.trim()}" is a GPT-5.x model. DocsFab retired its GPT-5.x selections in favor of GPT-6 Sol; this bring-your-own selection still runs but is not a supported model. Run \`docsfab setup --profile ${INTERNAL_SETUP_EXECUTION_PROFILE}\` to use GPT-6 Sol.`;
}

/**
 * True when an existing raw profile names a retired model id: the retired
 * Switchyard shortcut or any GPT-5.6 family id on any route.
 */
export function isRetiredRawModelId(modelId: string | undefined): boolean {
  if (modelId === undefined) return false;
  return (
    RETIRED_SELECTIONS.get(modelId.trim())?.refuseRawProfile === true ||
    isGpt56FamilyModelId(modelId)
  );
}

/**
 * Refuse a raw MODEL_* or JUDGE_* profile that names a retired model id, at
 * load time. Startup, doctor, and live-agent all load through this check.
 */
export function assertRawModelIdNotRetired(modelId: string | undefined): void {
  if (modelId !== undefined && isRetiredRawModelId(modelId)) {
    throw retiredSelectionRefusal(modelId);
  }
}
