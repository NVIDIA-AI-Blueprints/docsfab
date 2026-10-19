// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Effective per-step source-read policy.
 *
 * The source reader is a host kernel decision. Registry presence, artifact
 * presence, a model request, or a workflow name do not grant it: only the
 * installed locked skill set listed here admits the source tools, and only
 * within the budgets recorded in the policy digest.
 */
import { limitDefinition, refuseLimit, type ResolveLimitsOptions } from "../config/limits.js";
import {
  SOURCE_READ_RESPONSE_CEILING_LIMIT,
  sourceReadInputWindowShare,
  sourceReadResponseCeiling,
} from "../config/source-read-limits.js";
import { canonicalDigest } from "../content-ir/canonical.js";

/**
 * Model-facing source tools this policy can admit. The confinement allowlist
 * spreads `SOURCE_TOOL_NAMES` in `harness/source-tools.ts`, not these.
 *
 * `sourceReadSkills` admits the two reading tools together; search and
 * citation are separate opt-ins.
 */
export const SOURCE_LIST_TOOL_NAME = "docsfab_list_sources" as const;
export const SOURCE_READ_TOOL_NAME = "docsfab_read_source" as const;
export const SOURCE_SEARCH_TOOL_NAME = "docsfab_search_sources" as const;
export const SOURCE_CITE_TOOL_NAME = "docsfab_cite_source" as const;

/**
 * Narrower existing ceilings win over the catalog
 * `sources.readResponseCeilingBytes`; the external-input excerpt limit is not
 * raised here.
 */
export const SOURCE_READ_RESPONSE_CEILING_BYTES = sourceReadResponseCeiling().value;

export interface SourceStepPolicyV1 {
  readonly schemaVersion: 1;
  readonly kind: "docsfab-source-step-policy";
  readonly sourceReadSkills: readonly string[];
  /** Skills additionally admitted to `docsfab_search_sources`; empty by default. */
  readonly sourceSearchSkills: readonly string[];
  /**
   * Skills additionally admitted to `docsfab_cite_source`. Absent, not empty,
   * when nobody opted in: materializing `[]` would change `policySha256` for
   * every policy without the opt-in. `stepAdmitsSourceCite` treats absence as
   * a refusal.
   */
  readonly sourceCiteSkills?: readonly string[];
  /**
   * Sorted model-facing tool names this policy admits. Part of the digest body,
   * so a binding minted under a smaller tool set fails `policy-mismatch` in
   * `source-resolver.ts` against a host that admits more.
   */
  readonly admittedTools: readonly string[];
  /**
   * Restored at the start of each inference attempt, so a retry does not
   * inherit bytes a prior failed attempt spent.
   */
  readonly perStepBudgetBytes: number;
  readonly policySha256: string;
}

function requireSkillIdentities(skills: readonly string[], field: string): readonly string[] {
  const normalized = [...new Set(skills)].sort();
  if (normalized.some((skill) => typeof skill !== "string" || skill.length === 0)) {
    throw new Error(
      `A source-step policy lists installed skill identities only in ${field}, never tool or path names.`,
    );
  }
  return normalized;
}

export function createSourceStepPolicy(input: {
  sourceReadSkills: readonly string[];
  sourceSearchSkills?: readonly string[];
  sourceCiteSkills?: readonly string[];
  perStepBudgetBytes?: number;
  limits?: ResolveLimitsOptions;
}): SourceStepPolicyV1 {
  const sourceReadSkills = requireSkillIdentities(input.sourceReadSkills, "sourceReadSkills");
  const sourceSearchSkills = requireSkillIdentities(
    input.sourceSearchSkills ?? [],
    "sourceSearchSkills",
  );
  const sourceCiteSkills = requireSkillIdentities(input.sourceCiteSkills ?? [], "sourceCiteSkills");
  const uncitable = sourceCiteSkills.filter((skill) => !sourceReadSkills.includes(skill));
  if (uncitable.length > 0) {
    // Span ids come only from the reading tools, so citation without a read
    // grant is unusable and would advertise a tool the confined set never
    // registers.
    throw new Error(
      `A source-step policy admits source citation only to a skill it already admits to source reads. Add ${uncitable.join(", ")} to sourceReadSkills, or drop it from sourceCiteSkills.`,
    );
  }
  const unreadable = sourceSearchSkills.filter((skill) => !sourceReadSkills.includes(skill));
  if (unreadable.length > 0) {
    // The searcher is built on the step reader and returns handles a read
    // resolves, so search without a read grant is unusable and would advertise
    // a tool the confined set never registers.
    throw new Error(
      `A source-step policy admits source search only to a skill it already admits to source reads. Add ${unreadable.join(", ")} to sourceReadSkills, or drop it from sourceSearchSkills.`,
    );
  }
  const ceiling = sourceReadResponseCeiling(input.limits);
  const requested = input.perStepBudgetBytes ?? ceiling.value;
  if (!Number.isSafeInteger(requested) || requested <= 0) {
    throw new Error("A source-step policy requires a positive per-step budget.");
  }
  if (requested > ceiling.value) {
    refuseLimit(ceiling, requested);
  }
  const perStepBudgetBytes = requested;
  const admittedTools = [
    SOURCE_LIST_TOOL_NAME,
    SOURCE_READ_TOOL_NAME,
    ...(sourceSearchSkills.length > 0 ? [SOURCE_SEARCH_TOOL_NAME] : []),
    ...(sourceCiteSkills.length > 0 ? [SOURCE_CITE_TOOL_NAME] : []),
  ].sort();
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-source-step-policy" as const,
    sourceReadSkills,
    sourceSearchSkills,
    // Omitted without an opt-in; see `sourceCiteSkills` on the interface.
    ...(sourceCiteSkills.length > 0 ? { sourceCiteSkills } : {}),
    admittedTools,
    perStepBudgetBytes,
  };
  return Object.freeze({ ...body, policySha256: canonicalDigest(body) });
}

/**
 * How a step's source-read budget was set: by the declared ceiling,
 * `sources.readResponseCeilingBytes`, or, when it is smaller, by
 * `sources.readInputWindowShare` of the bound model's input window.
 */
export type SourceReadBudgetBasisV1 =
  | { readonly kind: "ceiling" }
  | {
      readonly kind: "input-window-share";
      readonly share: number;
      /** The bound model's input tokens after its context reserve. */
      readonly inputWindowTokens: number;
    };

/** A step's source-read budget and the limit that set it. */
export interface SourceReadBudgetV1 {
  readonly budgetBytes: number;
  readonly basis: SourceReadBudgetBasisV1;
}

/**
 * The per-step source-read budget for a bound model: the declared ceiling, or
 * the share of the model's input window when that is smaller, so a full budget
 * of source text cannot crowd a small window out. With no attested host window
 * (provider-side context admission, or no bound model) the ceiling applies.
 */
export function resolveSourceReadBudget(input: {
  /** Input tokens after the context reserve, or `null` when no host window is attested. */
  readonly inputWindowTokens: number | null;
  /** The host token estimator's bytes per token. */
  readonly bytesPerToken: number;
  readonly limits?: ResolveLimitsOptions;
}): SourceReadBudgetV1 {
  const ceiling = sourceReadResponseCeiling(input.limits);
  if (input.inputWindowTokens === null) {
    return Object.freeze({ budgetBytes: ceiling.value, basis: Object.freeze({ kind: "ceiling" }) });
  }
  const share = sourceReadInputWindowShare(input.limits).value;
  const windowBytes = Math.floor(share * input.inputWindowTokens * input.bytesPerToken);
  if (windowBytes >= ceiling.value) {
    return Object.freeze({ budgetBytes: ceiling.value, basis: Object.freeze({ kind: "ceiling" }) });
  }
  return Object.freeze({
    budgetBytes: Math.max(windowBytes, limitDefinition(SOURCE_READ_RESPONSE_CEILING_LIMIT).min),
    basis: Object.freeze({
      kind: "input-window-share",
      share,
      inputWindowTokens: input.inputWindowTokens,
    }),
  });
}

/** A step receives a reader only when the installed locked skill admits it. */
export function stepAdmitsSourceRead(
  policy: SourceStepPolicyV1 | undefined,
  step: { skill: string },
): boolean {
  return policy !== undefined && policy.sourceReadSkills.includes(step.skill);
}

/**
 * A step receives a searcher only when its skill is admitted to search and to
 * read. The read check still matters: a policy can arrive from a boundary that
 * did not mint it through `createSourceStepPolicy`.
 */
export function stepAdmitsSourceSearch(
  policy: SourceStepPolicyV1 | undefined,
  step: { skill: string },
): boolean {
  return (
    policy !== undefined &&
    Array.isArray(policy.sourceSearchSkills) &&
    policy.sourceSearchSkills.includes(step.skill) &&
    stepAdmitsSourceRead(policy, step)
  );
}

/**
 * A step may attach claim-to-span citations only when its skill is admitted to
 * citation and to reading. Absent `sourceCiteSkills` is a refusal.
 */
export function stepAdmitsSourceCite(
  policy: SourceStepPolicyV1 | undefined,
  step: { skill: string },
): boolean {
  return (
    policy !== undefined &&
    Array.isArray(policy.sourceCiteSkills) &&
    policy.sourceCiteSkills.includes(step.skill) &&
    stepAdmitsSourceRead(policy, step)
  );
}
