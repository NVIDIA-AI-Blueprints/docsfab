// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The step 8 evaluation target, derived once by the host from the selected
 * review scope. The evaluator never chooses or copies `evaluation.target.paths`:
 * the host states this target in the response contract and writes it into the
 * evaluation before validation.
 *
 * A focused review binds its exact page list. A documentation-set review
 * binds the coarsest exact cover: each page is replaced by its shallowest
 * proper ancestor directory that holds only in-scope documents, so a large
 * documentation set binds a few directory entries instead of every page. A directory
 * entry means "every in-scope documentation page under it", the same
 * directory-prefix meaning the locked evaluation validator applies.
 */

// The generated table and the light fill only: this module is on the CLI's
// startup path, and the full catalog reader resolves limits when it loads.
import { OUTPUT_RECORD_CONTRACTS } from "../contracts/model-output.generated.js";
import { fillHostMinted } from "../harness/answer-record-fill.js";
import type { RepositoryInventoryFailureV1 } from "../repository/inventory-contracts.js";

export interface EvaluationTargetEntryV1 {
  /** Repository-relative page path, or directory path without a trailing slash. */
  readonly path: string;
  readonly directory: boolean;
  /** In-scope pages this entry stands for; 1 for a page entry. */
  readonly pageCount: number;
}

export interface EvaluationTargetInput {
  /** The selected scope pages. */
  readonly scopePaths: readonly string[];
  readonly focused: boolean;
  /** Every recognized documentation file in the inventory, in or out of scope. */
  readonly documentPaths: readonly string[];
  readonly failures: readonly Pick<RepositoryInventoryFailureV1, "affects" | "path">[];
}

/** Proper ancestor directories of `path`, shallowest first. Never the root. */
function ancestors(path: string): string[] {
  const parts = path.split("/");
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/"));
}

function covers(entry: string, path: string): boolean {
  return path === entry || path.startsWith(`${entry}/`);
}

/**
 * Derive the target. A directory collapses only when no out-of-scope document
 * lies under it and no structure failure could hide one there: a failure with
 * no path (an entry limit or redaction) blocks every directory, and a failure
 * with a path blocks that path's directories. Text and navigation gaps do not
 * block, because they never remove a file from the document list.
 */
export function deriveEvaluationTarget(input: EvaluationTargetInput): EvaluationTargetEntryV1[] {
  const scope = [...new Set(input.scopePaths)].sort();
  const page = (path: string): EvaluationTargetEntryV1 => ({
    path,
    directory: false,
    pageCount: 1,
  });
  if (input.focused) return scope.map(page);
  const structureFailures = input.failures.filter((failure) =>
    failure.affects.includes("structure"),
  );
  if (structureFailures.some((failure) => failure.path === undefined)) return scope.map(page);
  const inScope = new Set(scope);
  const blocked = new Set<string>();
  for (const path of input.documentPaths) {
    if (!inScope.has(path)) for (const directory of ancestors(path)) blocked.add(directory);
  }
  for (const failure of structureFailures) {
    blocked.add(failure.path!);
    for (const directory of ancestors(failure.path!)) blocked.add(directory);
  }
  const chosen = new Map<string, EvaluationTargetEntryV1>();
  for (const path of scope) {
    const directory = ancestors(path).find((candidate) => !blocked.has(candidate));
    const key = directory ?? path;
    const previous = chosen.get(key);
    chosen.set(
      key,
      directory
        ? { path: directory, directory: true, pageCount: (previous?.pageCount ?? 0) + 1 }
        : page(path),
    );
  }
  return [...chosen.values()].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
}

/**
 * Whether `entries` is an exact cover of the scope: every entry is a distinct
 * non-root path that covers at least one scope page, every scope page is
 * covered, and no entry covers an out-of-scope document.
 */
export function isExactEvaluationTarget(
  entries: readonly string[],
  input: Pick<EvaluationTargetInput, "scopePaths" | "documentPaths">,
): boolean {
  const inScope = new Set(input.scopePaths);
  return (
    entries.length > 0 &&
    new Set(entries).size === entries.length &&
    entries.every(
      (entry) =>
        entry.length > 0 &&
        entry !== "." &&
        !entry.startsWith("/") &&
        !entry.endsWith("/") &&
        input.scopePaths.some((path) => covers(entry, path)),
    ) &&
    input.scopePaths.every((path) => entries.some((entry) => covers(entry, path))) &&
    !input.documentPaths.some(
      (path) => !inScope.has(path) && entries.some((entry) => covers(entry, path)),
    )
  );
}

/** Whether a candidate's `target.paths` names exactly the bound target set, as written. */
export function matchesEvaluationTarget(
  candidatePaths: readonly string[],
  bound: readonly string[],
): boolean {
  return (
    candidatePaths.length === bound.length &&
    new Set(candidatePaths).size === candidatePaths.length &&
    candidatePaths.every((path) => bound.includes(path))
  );
}

/** The bound target as one contract sentence, with page counts for directory entries. */
export function describeEvaluationTarget(entries: readonly EvaluationTargetEntryV1[]): string {
  const directories = entries.filter((entry) => entry.directory);
  const pages = entries.reduce((total, entry) => total + entry.pageCount, 0);
  const counts =
    directories.length === 0
      ? ""
      : ` Each directory entry stands for every in-scope documentation page under it: ${directories
          .map(
            (entry) =>
              `${JSON.stringify(entry.path)} = ${entry.pageCount} page${entry.pageCount === 1 ? "" : "s"}`,
          )
          .join(", ")}.`;
  return `Host-bound evaluation.target.paths for this run (${pages} in-scope page${pages === 1 ? "" : "s"}): ${JSON.stringify(entries.map((entry) => entry.path))}.${counts}`;
}

/**
 * The one host limitation recorded when the evaluator wrote a different
 * target set. It reports counts only, never the evaluator's paths.
 */
export function evaluationTargetReplacedLimitation(
  covered: number,
  scopePages: number,
  outside: number,
): string {
  return `The host bound evaluation.target.paths to this run's review scope; the evaluator's path set covered ${covered} of ${scopePages} in-scope pages and named ${outside} path(s) outside it.`;
}

function plainObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * How the bound target projects onto each declared host-minted member whose
 * source is `quality-evaluation-target`. The text path binds only the target
 * paths today; the step 8 declaration's other host-minted members (identity,
 * revisions, evaluator, and `delivery_surface_locator`) are written on both
 * paths when derivation reaches the text path (design O9, MR 5).
 */
const EVALUATION_TARGET_PROJECTIONS: Readonly<
  Record<string, (entries: readonly EvaluationTargetEntryV1[]) => unknown>
> = Object.freeze({
  "$.evaluation.target.paths": (entries) => entries.map((entry) => entry.path),
});

/** The step 8 declaration's host-minted members the text path binds, generated from `hostMinted`. */
export const TEXT_PATH_HOST_MINTED: readonly {
  readonly field: string;
  readonly source: string;
}[] = Object.freeze(
  OUTPUT_RECORD_CONTRACTS["quality-evaluation"].hostMinted.filter(
    (entry) =>
      entry.source === "quality-evaluation-target" &&
      Object.hasOwn(EVALUATION_TARGET_PROJECTIONS, entry.field),
  ),
);

/**
 * The evaluation fields the host writes before validation, relative to
 * `evaluation`, generated from the step 8 declaration's `hostMinted`.
 * The answer-path adapter writes each one from trusted runner, selection,
 * profile, or ledger context. The prompt contract and required-key lines read
 * this list so the evaluator is never asked to mint host-owned fields.
 */
export const HOST_WRITTEN_EVALUATION_FIELDS: readonly string[] = Object.freeze(
  OUTPUT_RECORD_CONTRACTS["quality-evaluation"].hostMinted
    // Full-artifact evaluators need these IDs as correlation keys so the host
    // can preserve which judgment belongs to which profile dimension.
    .filter((entry) => entry.field !== "$.evaluation.layers.*.dimensions[].dimension_id")
    .map((entry) => entry.field.slice("$.evaluation.".length)),
);

/** The host-written fields as the evaluator's answer names them, such as `evaluation.target.paths`. */
export function hostWrittenEvaluationFieldNames(): string {
  return HOST_WRITTEN_EVALUATION_FIELDS.map((field) => `evaluation.${field}`).join(", ");
}

/** The contract sentence that leaves every host-written field to the host. */
export function hostWrittenEvaluationFieldsSentence(): string {
  const one = HOST_WRITTEN_EVALUATION_FIELDS.length === 1;
  return `Leave ${hostWrittenEvaluationFieldNames()} out of your answer. The host writes ${one ? "that field" : "those fields"} before validation and replaces any value you write, so copying ${one ? "it" : "them"} only spends output.`;
}

/**
 * Write the bound target into the candidate's `evaluation.target.paths`.
 * Call only after the candidate passed the inertness and credential preflight.
 * When the evaluator wrote a different non-empty set (compared after stripping
 * one trailing `/`), return the counts-only limitation. The contract asks the
 * evaluator to leave the field out, so an omitted field or an empty list is
 * simply filled. A non-object evaluation or target is left for the staging shape
 * check. Never mutates `candidate`.
 */
export function fillEvaluationTarget<
  Candidate extends { readonly evaluation: Record<string, unknown> },
>(
  candidate: Candidate,
  entries: readonly EvaluationTargetEntryV1[],
  scopePaths: readonly string[],
): { candidate: Candidate; limitation?: string } {
  const evaluation = plainObject(candidate.evaluation);
  const target = plainObject(evaluation?.target);
  if (!evaluation || !target) return { candidate };
  const bound = entries.map((entry) => entry.path);
  // One fill, generated from the declaration's host-minted members (§1.4).
  const filled = fillHostMinted(
    { hostMinted: TEXT_PATH_HOST_MINTED },
    { ...candidate, evaluation },
    {
      "quality-evaluation-target": (field: string) =>
        EVALUATION_TARGET_PROJECTIONS[field]?.(entries),
    },
  ).artifact as Candidate;
  const written = target.paths;
  if (written === undefined || (Array.isArray(written) && written.length === 0)) {
    return { candidate: filled };
  }
  const named = Array.isArray(written)
    ? written.map((path) => (typeof path === "string" ? path.replace(/\/$/u, "") : ""))
    : [];
  const unchanged =
    named.length === bound.length &&
    new Set(named).size === named.length &&
    named.every((path) => bound.includes(path));
  if (unchanged) return { candidate: filled };
  const covered = scopePaths.filter((page) =>
    named.some((path) => path && covers(path, page)),
  ).length;
  const outside = named.filter(
    (path) => !path || !scopePaths.some((page) => covers(path, page)),
  ).length;
  return {
    candidate: filled,
    limitation: evaluationTargetReplacedLimitation(covered, scopePaths.length, outside),
  };
}
