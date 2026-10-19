// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Repository locator grammars, in one leaf module so every reader parses a
 * locator the same way: evidence validators through
 * {@link normalizeRepositoryLocator}, and plan admission (`plan-binding.ts`)
 * and source-obligation derivation (`source-obligation.ts`) through
 * {@link admitPlanSourceLocator}, so admission and derivation read a plan
 * source locator the same way.
 *
 * This module imports nothing, so the plan binding can read it without the
 * cycle an import of `review-response.ts` would close.
 */

export interface NormalizedRepositoryLocator {
  path: string | null;
  line?: number;
  fidelity: "exact" | "partial" | "unavailable";
  specific: boolean;
  malformed: boolean;
}

const SAFE_RELATIVE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._][A-Za-z0-9._/-]{0,511}$/u;

/**
 * Extract a conservative repository-relative path and first line while keeping
 * a fidelity signal whenever a range, fragment, or section label is reduced.
 */
export function normalizeRepositoryLocator(
  value: unknown,
  allowTrailingEvidence = false,
): NormalizedRepositoryLocator {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096) {
    return { path: null, fidelity: "unavailable", specific: false, malformed: false };
  }
  const fileSectionMatch = /^([A-Za-z0-9._][A-Za-z0-9._/-]{0,511}):[ \t]+([^\r\n]{1,256})$/u.exec(
    value,
  );
  const fileSectionPath = fileSectionMatch?.[1];
  const fileSectionLabel = fileSectionMatch?.[2];
  if (
    fileSectionPath &&
    fileSectionLabel &&
    fileSectionLabel === fileSectionLabel.trim() &&
    !/^\d/u.test(fileSectionLabel) &&
    isSafeRepositoryPath(fileSectionPath)
  ) {
    return {
      path: fileSectionPath,
      fidelity: "partial",
      specific: true,
      malformed: false,
    };
  }
  let match =
    /^([A-Za-z0-9._][A-Za-z0-9._/-]{0,511})(?:(?::(\d+)(?:-(\d+))?)|#([A-Za-z0-9][A-Za-z0-9._:/-]{0,255}))?(?:[ \t]*(?:\(([^()\r\n]{1,256})\)|,[ \t]*([^,\r\n]{1,256})))?$/u.exec(
      value,
    );
  let hasTrailingEvidence = false;
  if (!match && allowTrailingEvidence) {
    match =
      /^([A-Za-z0-9._][A-Za-z0-9._/-]{0,511})(?:(?::(\d+)(?:-(\d+))?)|#([A-Za-z0-9][A-Za-z0-9._:/-]{0,255}))?(?=[;,])/u.exec(
        value,
      );
    hasTrailingEvidence = match !== null;
  }
  const path = match?.[1];
  if (!path || !isSafeRepositoryPath(path)) {
    const malformed = /^[A-Za-z0-9._][A-Za-z0-9._/-]{0,511}:[ \t]*\d/u.test(value);
    return { path: null, fidelity: "unavailable", specific: false, malformed };
  }
  const start = match?.[2] === undefined ? undefined : Number(match[2]);
  const end = match?.[3] === undefined ? undefined : Number(match[3]);
  if (
    (start !== undefined && (!Number.isSafeInteger(start) || start < 1)) ||
    (end !== undefined && (!Number.isSafeInteger(end) || end < (start ?? 1)))
  ) {
    return { path: null, fidelity: "unavailable", specific: false, malformed: true };
  }
  const fragment = match?.[4];
  const section = match?.[5] ?? match?.[6];
  const specific = start !== undefined || fragment !== undefined || section !== undefined;
  return {
    path,
    ...(start !== undefined ? { line: start } : {}),
    fidelity:
      end !== undefined || fragment !== undefined || section !== undefined || hasTrailingEvidence
        ? "partial"
        : "exact",
    specific,
    malformed: false,
  };
}

function isSafeRepositoryPath(value: string): boolean {
  if (!SAFE_RELATIVE_PATH.test(value) || value.includes("\\")) return false;
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return false;
  const basename = segments.at(-1)!;
  return (
    value.includes("/") ||
    basename.includes(".") ||
    /^(?:README|CHANGELOG|LICENSE|Dockerfile|Makefile)(?:[-_][A-Za-z0-9._-]+)?$/u.test(basename)
  );
}

export interface PlanSourceLocator {
  /** The repository-relative file the host reads and verifies as a whole. */
  readonly path: string;
  /** The path with any line or section coordinate, without a revision. */
  readonly locator: string;
  readonly revision?: string;
  /**
   * The spelling the host records: the value itself, except that a revision
   * written before its coordinate moves after it (`<locator>@<revision>`).
   */
  readonly canonical: string;
}

/** The spellings are the recorded derivation codes (`SourceObligationSourceReferenceError`). */
export type PlanSourceLocatorRefusal = "invalid-reference" | "revision-mismatch";

const GIT_REFERENCE = /^git:([a-f0-9]{40}|[a-f0-9]{64}):(.+)$/su;
const REVISION_THEN_COORDINATE = /^([a-f0-9]{40}|[a-f0-9]{64})([:#].*)?$/su;

/**
 * The documentation-plan source locator grammar. A source is a repository
 * locator, optionally naming the exact repository revision it was read at:
 *
 * - `<path>[<coordinate>]`, `<path>[<coordinate>]@<revision>` (canonical);
 * - `<path>@<revision><coordinate>`, the same claim with the revision written
 *   before a `:line`, `:start-end`, or `#section` coordinate. A coordinate is
 *   claim evidence, not a read restriction, so either order names the same
 *   whole-file read; the host records the canonical spelling;
 * - `git:<revision>:<path>[<coordinate>]`.
 *
 * `<coordinate>` and `<path>` are whatever {@link normalizeRepositoryLocator}
 * admits as a well-formed repository locator; `<revision>` is a full 40- or
 * 64-hex object name. `@` appears at most once and only before the revision.
 *
 * When `expectedRevision` is given, a named revision must equal it.
 */
export function admitPlanSourceLocator(
  value: unknown,
  expectedRevision?: string,
): PlanSourceLocator | { readonly refusal: PlanSourceLocatorRefusal } {
  if (typeof value !== "string") return { refusal: "invalid-reference" };
  let locator = value;
  let revision: string | undefined;
  let canonical = value;
  const git = GIT_REFERENCE.exec(value);
  if (git) {
    revision = git[1]!;
    locator = git[2]!;
  } else {
    const at = value.indexOf("@");
    if (at !== -1) {
      const named = REVISION_THEN_COORDINATE.exec(value.slice(at + 1));
      if (!named) return { refusal: "invalid-reference" };
      revision = named[1]!;
      locator = value.slice(0, at) + (named[2] ?? "");
      canonical = `${locator}@${revision}`;
    }
  }
  // A revision that is not the run's is refused as that, even beside a
  // malformed locator: it is the more specific fault.
  if (revision !== undefined && expectedRevision !== undefined && revision !== expectedRevision) {
    return { refusal: "revision-mismatch" };
  }
  if (locator.includes("@")) return { refusal: "invalid-reference" };
  const normalized = normalizeRepositoryLocator(locator);
  if (!normalized.path || normalized.malformed) return { refusal: "invalid-reference" };
  return Object.freeze({
    path: normalized.path,
    locator,
    ...(revision === undefined ? {} : { revision }),
    canonical,
  });
}

export function isPlanSourceLocatorRefusal(
  result: ReturnType<typeof admitPlanSourceLocator>,
): result is { readonly refusal: PlanSourceLocatorRefusal } {
  return "refusal" in result;
}
