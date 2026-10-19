// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The repository and authority inputs admission reads beside the proposal,
 * and the one query the caller answers before admission: which `write`-role
 * target paths exist, and how.
 *
 * Every host list is validated whole before any rule reads it. A malformed
 * entry is a host fault (`host-input-invalid`), never skipped; a list over its
 * named bound refuses through `refuseLimit()`.
 */
import { refuseLimit, type ResolvedLimit } from "../config/limits.js";
import {
  REQUEST_INTENT_EXISTENCE_KINDS,
  REQUEST_INTENT_OPERATIONS,
  REQUEST_INTENT_PATH_SCOPE_KINDS,
  type RequestIntentDecoded,
  type RequestIntentExistenceAnswer,
  type RequestIntentExistenceKind,
  type RequestIntentOperation,
  type RequestIntentPathScope,
  type RequestIntentProposal,
} from "./contract.js";
import { isRepositoryRelativePath } from "./decode.js";
import { RequestIntentContractError } from "./kit.js";
import type { RequestIntentLimits } from "./limits.js";

/**
 * The paths the caller must answer for `existence`: every `write`-role target,
 * exact case, in proposal order. Decode already rejects two targets that fold
 * together, so the list never holds one file twice. Companions are judged by
 * the navigation set and are not asked.
 */
export function requestIntentExistencePaths(decoded: RequestIntentDecoded): string[] {
  return writeTargetPaths(decoded.proposal);
}

export function writeTargetPaths(proposal: RequestIntentProposal): string[] {
  return proposal.targets.filter((target) => target.role === "write").map((target) => target.path);
}

function hostFault(detail: string): never {
  throw new RequestIntentContractError("host-input-invalid", detail);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Exactly these keys, each an own property. */
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/** Refuse a host list longer than its bound, before any entry is read. */
function requireBoundedList(value: unknown, bound: ResolvedLimit, name: string): unknown[] {
  if (!Array.isArray(value)) hostFault(`the caller must pass ${name} as an array.`);
  if (value.length > bound.value) refuseLimit(bound, value.length);
  return value;
}

export function requireDeclaredOperation(value: unknown): RequestIntentOperation {
  if (!(REQUEST_INTENT_OPERATIONS as readonly unknown[]).includes(value)) {
    hostFault("the caller must pass the run's declared operation.");
  }
  return value as RequestIntentOperation;
}

/**
 * A root or write scope: typed `{kind, path}` entries whose path is a
 * repository-relative path, so an empty path, `/`, `.`, `..` and a trailing
 * slash are all refused rather than read as "everything".
 */
export function requirePathScopes(
  value: unknown,
  bound: ResolvedLimit,
  name: string,
): readonly RequestIntentPathScope[] {
  return requireBoundedList(value, bound, name).map((entry) => {
    if (
      !isRecord(entry) ||
      !hasExactKeys(entry, ["kind", "path"]) ||
      !(REQUEST_INTENT_PATH_SCOPE_KINDS as readonly unknown[]).includes(entry.kind) ||
      typeof entry.path !== "string" ||
      !isRepositoryRelativePath(entry.path)
    ) {
      hostFault(
        `every ${name} entry must be {kind: "root" | "file", path} with a repository-relative path.`,
      );
    }
    return { kind: entry.kind as RequestIntentPathScope["kind"], path: entry.path };
  });
}

export function requireNavigationSet(value: unknown, bound: ResolvedLimit): ReadonlySet<string> {
  const entries = requireBoundedList(value, bound, "the navigation set");
  if (entries.some((entry) => typeof entry !== "string" || !isRepositoryRelativePath(entry))) {
    hostFault("every navigation-set entry must be a repository-relative path.");
  }
  return new Set(entries as string[]);
}

/**
 * The existence answers, keyed by path. The answered set must equal the asked
 * set exactly: a missing answer is never read as `absent`, and an extra or
 * repeated one means the caller asked about another proposal. The length is
 * compared first, so an oversized list is refused before it is read; the asked
 * set is already bounded by `requestIntent.maxTargets`.
 */
export function requireExistence(
  value: unknown,
  asked: readonly string[],
): ReadonlyMap<string, RequestIntentExistenceKind> {
  if (!Array.isArray(value)) hostFault("the caller must pass the existence answers as an array.");
  if (value.length !== asked.length) {
    hostFault("the caller must answer existence for exactly the write-role target paths.");
  }
  const answers = new Map<string, RequestIntentExistenceKind>();
  for (const entry of value as unknown[]) {
    if (
      !isRecord(entry) ||
      !hasExactKeys(entry, ["path", "existing"]) ||
      typeof entry.path !== "string" ||
      !(REQUEST_INTENT_EXISTENCE_KINDS as readonly unknown[]).includes(entry.existing)
    ) {
      hostFault("every existence answer must be {path, existing} with a known existence kind.");
    }
    const answer = entry as unknown as RequestIntentExistenceAnswer;
    answers.set(answer.path, answer.existing);
  }
  // As many answers as distinct asked paths, each asked path answered: so no
  // answer is repeated and none is for another path.
  if (asked.some((path) => !answers.has(path))) {
    hostFault("the caller must answer existence for exactly the write-role target paths.");
  }
  return answers;
}

/** Every host input admission reads besides the instruction, limits and inventory. */
export interface RequestIntentHostInputs {
  readonly declaredOperation: RequestIntentOperation;
  readonly docsRoot: readonly RequestIntentPathScope[];
  readonly grantedWriteScope: readonly RequestIntentPathScope[];
  readonly navigationSet: ReadonlySet<string>;
}

/** Validate the inputs that do not depend on the proposal, before decoding it. */
export function requireHostInputs(
  input: Record<string, unknown>,
  limits: RequestIntentLimits,
): RequestIntentHostInputs {
  return {
    declaredOperation: requireDeclaredOperation(input.declaredOperation),
    docsRoot: requirePathScopes(input.docsRoot, limits.maxDocsRootEntries, "documentation root"),
    grantedWriteScope: requirePathScopes(
      input.grantedWriteScope,
      limits.maxWriteScopeEntries,
      "write scope",
    ),
    navigationSet: requireNavigationSet(input.navigationSet, limits.maxNavigationEntries),
  };
}

/**
 * Whether `scopes` cover `path`. Granting, so exact letter case: on a
 * case-folding checkout `Docs/x.md` may be the same file as `docs/x.md`, but
 * the grant names `docs`, and widening it by a fold would grant more than the
 * host wrote. A root covers only what lies under it, as the `docs/` write
 * root the host grants does: the root's own path is the directory, never a
 * page, and the segment bound keeps `docs` from covering `docs-archive`.
 */
export function withinScope(path: string, scopes: readonly RequestIntentPathScope[]): boolean {
  return scopes.some((scope) =>
    scope.kind === "file" ? path === scope.path : path.startsWith(`${scope.path}/`),
  );
}
