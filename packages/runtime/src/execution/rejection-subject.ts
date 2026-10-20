// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * What a refused reply's rule refused, recorded beside the attempt's coded
 * `rejection` and never inside it: that pair stays a closed code and location.
 *
 * Content-free by construction. A subject holds only paths the host already
 * knows, never model text: a cited source path the host found among the plan's
 * write paths or the revision's tracked regular files, or a revision's
 * declared and observed changed paths, both subsets of the plan's write paths.
 * Anything else is recorded as withheld. A subject is never rendered into a
 * retry prompt.
 */

import { limit, limitDefinition } from "../config/limits.js";

export const REJECTION_SUBJECT_PATH_LIMIT = "inference.rejectionSubjectPathMaxChars" as const;
export const REJECTION_SUBJECT_PATHS_LIMIT = "inference.rejectionSubjectMaxPaths" as const;

/** Why a subject names no path. */
export type RejectionSubjectWithheld = "not-host-known" | "over-bound";

export type InferenceRejectionSubjectV1 =
  /** The path a refused source citation named, when the host knows it. */
  | { readonly kind: "source-path"; readonly path: string }
  | { readonly kind: "source-path"; readonly withheld: RejectionSubjectWithheld }
  /** The pages a revision writer declared changed, and the pages it changed. */
  | {
      readonly kind: "changed-paths";
      readonly declared: readonly string[];
      readonly observed: readonly string[];
    }
  | {
      readonly kind: "changed-paths";
      readonly withheld: "over-bound";
      readonly declaredCount: number;
      readonly observedCount: number;
    };

/**
 * The subject of a refused source citation. `hostKnown` is the host's own
 * answer for `path`; an unknown path, or one over the bound, is withheld.
 */
export function sourcePathRejectionSubject(
  path: string | null | undefined,
  hostKnown: (path: string) => boolean,
): InferenceRejectionSubjectV1 {
  if (!path || !isSubjectPath(path) || !hostKnown(path)) {
    return Object.freeze({ kind: "source-path", withheld: "not-host-known" });
  }
  if (path.length > limit(REJECTION_SUBJECT_PATH_LIMIT).value) {
    return Object.freeze({ kind: "source-path", withheld: "over-bound" });
  }
  return Object.freeze({ kind: "source-path", path });
}

/**
 * The subject of a revision accounting refusal: what the writer declared it
 * changed and what the host observed it change. Callers pass plan write paths
 * only; longer lists keep their counts and withhold the paths.
 */
export function changedPathsRejectionSubject(
  declared: readonly string[],
  observed: readonly string[],
): InferenceRejectionSubjectV1 {
  const declaredPaths = [...new Set(declared)].sort();
  const observedPaths = [...new Set(observed)].sort();
  const maxPaths = limit(REJECTION_SUBJECT_PATHS_LIMIT).value;
  const maxChars = limit(REJECTION_SUBJECT_PATH_LIMIT).value;
  const all = [...declaredPaths, ...observedPaths];
  if (
    declaredPaths.length > maxPaths ||
    observedPaths.length > maxPaths ||
    all.some((path) => !isSubjectPath(path) || path.length > maxChars)
  ) {
    return Object.freeze({
      kind: "changed-paths",
      withheld: "over-bound",
      declaredCount: declaredPaths.length,
      observedCount: observedPaths.length,
    });
  }
  return Object.freeze({
    kind: "changed-paths",
    declared: Object.freeze(declaredPaths),
    observed: Object.freeze(observedPaths),
  });
}

/**
 * Whether a recorded value is a subject this host could have written. Record
 * readers check against each bound's maximum, so a record written under a
 * higher configured value stays readable.
 */
export function isInferenceRejectionSubject(value: unknown): value is InferenceRejectionSubjectV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const keys = Object.keys(item).sort().join(",");
  const maxChars = limitDefinition(REJECTION_SUBJECT_PATH_LIMIT).max;
  const maxPaths = limitDefinition(REJECTION_SUBJECT_PATHS_LIMIT).max;
  const recordedPath = (path: unknown) =>
    typeof path === "string" && isSubjectPath(path) && path.length <= maxChars;
  const pathList = (paths: unknown) =>
    Array.isArray(paths) &&
    paths.length <= maxPaths &&
    paths.every(recordedPath) &&
    paths.every((path, index) => index === 0 || (paths[index - 1] as string) < path);
  const count = (value: unknown) =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  if (item.kind === "source-path") {
    if (keys === "kind,path") return recordedPath(item.path);
    return (
      keys === "kind,withheld" &&
      (item.withheld === "not-host-known" || item.withheld === "over-bound")
    );
  }
  if (item.kind === "changed-paths") {
    if (keys === "declared,kind,observed")
      return pathList(item.declared) && pathList(item.observed);
    return (
      keys === "declaredCount,kind,observedCount,withheld" &&
      item.withheld === "over-bound" &&
      count(item.declaredCount) &&
      count(item.observedCount)
    );
  }
  return false;
}

/**
 * A repository-relative path shape: no control characters, no absolute or
 * drive root, no backslash, no `.` or `..` segment. Shape only; whether the
 * host knows the path is the caller's check.
 */
function isSubjectPath(path: string): boolean {
  return (
    path.length > 0 &&
    !/[\u0000-\u001f\u007f\\]/u.test(path) &&
    !path.startsWith("/") &&
    !/^[A-Za-z]:/u.test(path) &&
    path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}
