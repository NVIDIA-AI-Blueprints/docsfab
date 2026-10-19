// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The run record's `retainedEvidenceBindings` contract: the `--source` files
 * and the `--pr` merge request a run bound, with what the host observed for
 * each. An InputAsk continuation reads it to bind exactly the original run's
 * evidence and to tell whether that evidence moved since. A `--change` range
 * needs no copy here: its pins are the run's `changeSources` entry. The writer
 * and every strict reader share this module.
 *
 * Every value comes from what the host acquired, never from argv or request
 * text. It records no file bytes and no merge request text, only digests.
 */
import { createContractKit, type ContractFail } from "../contract-kit/index.js";
import {
  isValidatedChangeRequestSelector,
  type ChangeRequestSelectorV1,
} from "../inputs/change-request-selector.js";
import { normalizeSourcePath } from "../inputs/source-acquisition.js";
import { SOURCE_AWARE_WORKFLOWS } from "../inputs/source-aware-workflows.js";

export const RETAINED_EVIDENCE_BINDINGS_KIND = "docsfab-retained-evidence-bindings" as const;

/** One `--source` file and the digest of the bytes the host read for it. */
export interface RetainedSourcePinV1 {
  readonly path: string;
  readonly sha256: string;
}

/**
 * The `--pr` merge request the host read. Its text records the merge and
 * squash commits GitLab reported, so `textSha256` pins the head as well.
 */
export interface RetainedChangeRequestPinV1 {
  /** Host and project resolved to the canonical forms the forge returned. */
  readonly selector: ChangeRequestSelectorV1 & {
    readonly host: string;
    readonly projectPath: string;
  };
  readonly projectId: number;
  readonly textSha256: string;
}

export interface RetainedEvidenceBindingsV1 {
  readonly schemaVersion: 1;
  readonly kind: typeof RETAINED_EVIDENCE_BINDINGS_KIND;
  /** Sorted by path and unique; present only with at least one file. */
  readonly sources?: readonly [RetainedSourcePinV1, ...RetainedSourcePinV1[]];
  readonly changeRequest?: RetainedChangeRequestPinV1;
}

export class RetainedEvidenceBindingsError extends Error {
  constructor() {
    super("Run record retainedEvidenceBindings does not match the retained evidence contract.");
    this.name = "RetainedEvidenceBindingsError";
  }
}

const fail: ContractFail<"invalid"> = () => {
  throw new RetainedEvidenceBindingsError();
};

const kit = createContractKit<"invalid">({
  fail,
  inertMode: "strict",
  codes: {
    invalidShape: "invalid",
    invalidValue: "invalid",
    digestMismatch: "invalid",
    credentialMaterial: "invalid",
    schemaMismatch: "invalid",
  },
});

/**
 * The value the writer keeps, or `undefined` when the run bound neither a
 * `--source` file nor a `--pr` merge request: such a record carries no field.
 */
export function retainedEvidenceBindings(input: {
  readonly sources: readonly RetainedSourcePinV1[];
  readonly changeRequest?: RetainedChangeRequestPinV1;
}): RetainedEvidenceBindingsV1 | undefined {
  if (input.sources.length === 0 && input.changeRequest === undefined) return undefined;
  const sources = [...input.sources]
    .map(({ path, sha256 }) => ({ path, sha256 }))
    .sort((left, right) => compare(left.path, right.path));
  return {
    schemaVersion: 1,
    kind: RETAINED_EVIDENCE_BINDINGS_KIND,
    ...(sources.length > 0
      ? { sources: sources as unknown as readonly [RetainedSourcePinV1, ...RetainedSourcePinV1[]] }
      : {}),
    ...(input.changeRequest ? { changeRequest: structuredClone(input.changeRequest) } : {}),
  };
}

/** The `--source` paths a continuation binds again, in the order the record keeps them. */
export function retainedSourcePaths(value: RetainedEvidenceBindingsV1 | undefined): string[] {
  return (value?.sources ?? []).map((source) => source.path);
}

/**
 * The paths whose pinned digest differs between the original run and its
 * continuation, or that only one of them bound. Empty when every file matches.
 */
export function movedSourcePaths(
  original: readonly RetainedSourcePinV1[],
  continued: readonly RetainedSourcePinV1[],
): string[] {
  const before = new Map(original.map((source) => [source.path, source.sha256]));
  const after = new Map(continued.map((source) => [source.path, source.sha256]));
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((path) => before.get(path) !== after.get(path))
    .sort(compare);
}

/**
 * Admit only what the writer produces, on the workflows that bind sources:
 * at least one of `sources` and `changeRequest`, each closed.
 */
export function decodeRetainedEvidenceBindings(
  value: unknown,
  workflow: unknown,
): RetainedEvidenceBindingsV1 {
  if (!(SOURCE_AWARE_WORKFLOWS as readonly unknown[]).includes(workflow)) fail("invalid");
  kit.assertInert(value);
  const root = kit.object(value);
  kit.exact(
    root,
    ["schemaVersion", "kind", "sources", "changeRequest"],
    ["sources", "changeRequest"],
  );
  if (root.schemaVersion !== 1 || root.kind !== RETAINED_EVIDENCE_BINDINGS_KIND) fail("invalid");
  if (root.sources === undefined && root.changeRequest === undefined) fail("invalid");
  const sources = root.sources === undefined ? undefined : decodeSources(root.sources);
  const changeRequest =
    root.changeRequest === undefined ? undefined : decodeChangeRequest(root.changeRequest);
  return {
    schemaVersion: 1,
    kind: RETAINED_EVIDENCE_BINDINGS_KIND,
    ...(sources ? { sources } : {}),
    ...(changeRequest ? { changeRequest } : {}),
  };
}

function decodeSources(value: unknown): readonly [RetainedSourcePinV1, ...RetainedSourcePinV1[]] {
  const sources = kit.array(value).map((item) => {
    const root = kit.object(item);
    kit.exact(root, ["path", "sha256"]);
    return { path: canonicalPath(root.path), sha256: kit.hash(root.sha256) };
  });
  if (sources.length === 0) fail("invalid");
  // Strictly ascending, as the writer keeps them, so also unique.
  if (sources.some((source, index) => index > 0 && !(sources[index - 1]!.path < source.path))) {
    fail("invalid");
  }
  return sources as unknown as readonly [RetainedSourcePinV1, ...RetainedSourcePinV1[]];
}

function canonicalPath(value: unknown): string {
  try {
    if (normalizeSourcePath(value) === value) return value as string;
  } catch {
    // The path grammar's own refusal names acquisition codes; this field has one.
  }
  return fail("invalid");
}

function decodeChangeRequest(value: unknown): RetainedChangeRequestPinV1 {
  const root = kit.object(value);
  kit.exact(root, ["selector", "projectId", "textSha256"]);
  const selector = root.selector;
  if (
    !isValidatedChangeRequestSelector(selector) ||
    selector.host === null ||
    selector.projectPath === null
  ) {
    fail("invalid");
  }
  const projectId = root.projectId;
  if (typeof projectId !== "number" || !Number.isSafeInteger(projectId) || projectId <= 0) {
    fail("invalid");
  }
  return {
    selector: {
      schemaVersion: 1,
      kind: selector.kind,
      provider: selector.provider,
      host: selector.host,
      projectPath: selector.projectPath,
      number: selector.number,
    },
    projectId,
    textSha256: kit.hash(root.textSha256),
  };
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
