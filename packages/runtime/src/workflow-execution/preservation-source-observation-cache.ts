// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import type { PreservationSourceReadV1, PreservationSourceReaderV1 } from "./source-obligation.js";
import {
  listPreservationSources,
  preservationSourceReaderIdentity,
  readPreservationSourceRange,
} from "./source-obligation-observer.js";

/** Exact results from a live step may be reused after the new step proves access again. */
export interface PreservationSourceObservationCacheV1 {
  readonly kind: "docsfab-preservation-source-observation-cache";
}

export interface PreservationSourceObservationCacheStatsV1 {
  readonly hits: number;
  readonly misses: number;
  readonly seededRanges: number;
  readonly invalidations: Readonly<
    Record<"authority-change" | "source-change" | "snapshot-change", number>
  >;
  readonly missReasons: Readonly<Record<"range-mismatch", number>>;
  readonly refusals: number;
}

/** Content-free counters attributable to one bounded phase of a run. */
export function preservationSourceObservationCacheDelta(
  before: PreservationSourceObservationCacheStatsV1,
  after: PreservationSourceObservationCacheStatsV1,
) {
  return {
    hits: after.hits - before.hits,
    misses: after.misses - before.misses,
    seededRanges: after.seededRanges - before.seededRanges,
    refusals: after.refusals - before.refusals,
    invalidations: {
      authorityChange:
        after.invalidations["authority-change"] - before.invalidations["authority-change"],
      sourceChange: after.invalidations["source-change"] - before.invalidations["source-change"],
      snapshotChange:
        after.invalidations["snapshot-change"] - before.invalidations["snapshot-change"],
    },
    rangeMismatches: after.missReasons["range-mismatch"] - before.missReasons["range-mismatch"],
  };
}

export interface SeededPreservationSourceObservationV1 extends PreservationSourceReadV1 {
  readonly observedInStepId: string;
  /** A range is primary evidence, but prior reads never establish complete discovery. */
  readonly discoveryComplete: false;
  readonly sourceByteLength: number;
}

interface CacheState {
  readonly observations: Map<
    string,
    {
      readonly result: PreservationSourceReadV1;
      readonly runId: string;
      readonly stepId: string;
      readonly repositoryRevision: string;
      readonly workspaceSnapshotSha256: string;
      readonly authorityDigest: string;
      readonly maxBytes: number;
    }
  >;
  readonly descriptors: Map<
    string,
    {
      readonly authorityDigest: string;
      readonly sourceSha256: string;
      readonly range: string;
      readonly repositoryRevision: string;
      readonly workspaceSnapshotSha256: string;
    }
  >;
  hits: number;
  misses: number;
  seededRanges: number;
  refusals: number;
  readonly invalidations: Record<"authority-change" | "source-change" | "snapshot-change", number>;
  readonly missReasons: Record<"range-mismatch", number>;
}

const cacheStates = new WeakMap<PreservationSourceObservationCacheV1, CacheState>();
const CACHE_TOOL_VERSION = "docsfab_read_preservation_source@1";

export function createPreservationSourceObservationCache(): PreservationSourceObservationCacheV1 {
  const cache = Object.freeze({ kind: "docsfab-preservation-source-observation-cache" as const });
  cacheStates.set(cache, {
    observations: new Map(),
    descriptors: new Map(),
    hits: 0,
    misses: 0,
    seededRanges: 0,
    refusals: 0,
    invalidations: {
      "authority-change": 0,
      "source-change": 0,
      "snapshot-change": 0,
    },
    missReasons: { "range-mismatch": 0 },
  });
  return cache;
}

/**
 * Reuse only a byte-for-byte identical original range. The live reader identity
 * and source inventory are checked on every call, including cache hits, so a
 * previous step's authority never grants the current step access.
 */
export async function readPreservationSourceObservation(input: {
  readonly cache: PreservationSourceObservationCacheV1;
  readonly reader: PreservationSourceReaderV1;
  readonly sourceId: string;
  readonly fromByte: number;
  readonly maxBytes: number;
}): Promise<PreservationSourceReadV1> {
  const state = cacheStates.get(input.cache);
  if (!state)
    throw new Error("The preservation source observation cache is invalid for this workflow.");

  try {
    const identity = preservationSourceReaderIdentity(input.reader);
    const references = listPreservationSources(input.reader);
    const reference = references.find(({ sourceId }) => sourceId === input.sourceId);
    if (!reference) throw new Error("Preservation source reference is unavailable to this step.");

    const range = JSON.stringify([input.fromByte, input.maxBytes]);
    const baseIdentity = JSON.stringify([identity.runId, reference.path]);
    const previous = state.descriptors.get(baseIdentity);
    if (previous) {
      if (previous.authorityDigest !== identity.authorityDigest) {
        state.invalidations["authority-change"] += 1;
      } else if (previous.sourceSha256 !== reference.sha256) {
        state.invalidations["source-change"] += 1;
      } else if (
        previous.repositoryRevision !== identity.repositoryRevision ||
        previous.workspaceSnapshotSha256 !== identity.workspaceSnapshotSha256
      ) {
        state.invalidations["snapshot-change"] += 1;
      } else if (previous.range !== range) {
        state.missReasons["range-mismatch"] += 1;
      }
    }

    const key = createObservationKey({
      runId: identity.runId,
      repositoryRevision: identity.repositoryRevision,
      workspaceSnapshotSha256: identity.workspaceSnapshotSha256,
      authorityDigest: identity.authorityDigest,
      reference,
      fromByte: input.fromByte,
      maxBytes: input.maxBytes,
    });
    state.descriptors.set(baseIdentity, {
      authorityDigest: identity.authorityDigest,
      sourceSha256: reference.sha256,
      range,
      repositoryRevision: identity.repositoryRevision,
      workspaceSnapshotSha256: identity.workspaceSnapshotSha256,
    });
    const cached = state.observations.get(key);
    if (cached) {
      // Metadata checks alone are not sufficient: re-run the exact reader so
      // the live immutable export, UTF-8 boundaries, and credential screen are
      // checked before any cached result is reused.
      const current = await readPreservationSourceRange({
        reader: input.reader,
        sourceId: input.sourceId,
        fromByte: input.fromByte,
        maxBytes: input.maxBytes,
      });
      if (sameRead(cached.result, current)) {
        state.hits += 1;
        return cached.result;
      }
      state.misses += 1;
      state.invalidations["source-change"] += 1;
      state.observations.delete(key);
      state.observations.set(key, {
        result: current,
        runId: identity.runId,
        stepId: identity.stepId,
        repositoryRevision: identity.repositoryRevision,
        workspaceSnapshotSha256: identity.workspaceSnapshotSha256,
        authorityDigest: identity.authorityDigest,
        maxBytes: input.maxBytes,
      });
      return current;
    }

    state.misses += 1;
    const result = await readPreservationSourceRange({
      reader: input.reader,
      sourceId: input.sourceId,
      fromByte: input.fromByte,
      maxBytes: input.maxBytes,
    });
    state.observations.set(key, {
      result,
      runId: identity.runId,
      stepId: identity.stepId,
      repositoryRevision: identity.repositoryRevision,
      workspaceSnapshotSha256: identity.workspaceSnapshotSha256,
      authorityDigest: identity.authorityDigest,
      maxBytes: input.maxBytes,
    });
    return result;
  } catch (error) {
    state.refusals += 1;
    throw error;
  }
}

/**
 * Select only exact ranges authorized by the fresh step's live reader. The
 * output carries no prior inventory or assessment and always marks discovery
 * incomplete, leaving the current step's normal discovery tools authoritative.
 */
export async function seedPreservationSourceObservations(input: {
  readonly cache: PreservationSourceObservationCacheV1;
  readonly reader: PreservationSourceReaderV1;
}): Promise<readonly SeededPreservationSourceObservationV1[]> {
  const state = cacheStates.get(input.cache);
  if (!state)
    throw new Error("The preservation source observation cache is invalid for this workflow.");

  try {
    const identity = preservationSourceReaderIdentity(input.reader);
    const references = listPreservationSources(input.reader);
    const currentRefs = new Map(references.map((reference) => [reference.sourceId, reference]));
    const seeds: SeededPreservationSourceObservationV1[] = [];
    const seededSpans = new Set<string>();
    for (const cached of state.observations.values()) {
      if (
        cached.stepId === identity.stepId ||
        cached.runId !== identity.runId ||
        cached.repositoryRevision !== identity.repositoryRevision ||
        cached.workspaceSnapshotSha256 !== identity.workspaceSnapshotSha256 ||
        cached.authorityDigest !== identity.authorityDigest
      ) {
        continue;
      }
      const cachedResult = cached.result;
      const reference = currentRefs.get(cachedResult.sourceId);
      if (
        !reference ||
        reference.sha256 !== cachedResult.sha256 ||
        reference.path !== cachedResult.path ||
        reference.byteLength < cachedResult.endByte
      ) {
        continue;
      }
      const current = await readPreservationSourceRange({
        reader: input.reader,
        sourceId: reference.sourceId,
        fromByte: cachedResult.fromByte,
        maxBytes: cached.maxBytes,
      });
      if (!sameRead(cachedResult, current)) {
        state.invalidations["source-change"] += 1;
        state.observations.delete(
          createObservationKey({
            runId: cached.runId,
            repositoryRevision: cached.repositoryRevision,
            workspaceSnapshotSha256: cached.workspaceSnapshotSha256,
            authorityDigest: cached.authorityDigest,
            reference,
            fromByte: cachedResult.fromByte,
            maxBytes: cached.maxBytes,
          }),
        );
        continue;
      }
      const spanKey = JSON.stringify([
        current.sourceId,
        current.sha256,
        current.fromByte,
        current.endByte,
      ]);
      if (seededSpans.has(spanKey)) continue;
      seededSpans.add(spanKey);
      state.seededRanges += 1;
      seeds.push(
        Object.freeze({
          ...current,
          observedInStepId: cached.stepId,
          discoveryComplete: false as const,
          sourceByteLength: reference.byteLength,
        }),
      );
    }
    return Object.freeze(
      seeds.sort((left, right) =>
        `${left.sourceId}:${left.fromByte}:${left.endByte}`.localeCompare(
          `${right.sourceId}:${right.fromByte}:${right.endByte}`,
        ),
      ),
    );
  } catch (error) {
    state.refusals += 1;
    throw error;
  }
}

export function formatSeededPreservationSourceObservations(
  observations: readonly SeededPreservationSourceObservationV1[],
): string {
  if (observations.length === 0) return "";
  return [
    "Exact original-source ranges already read by an earlier step (untrusted, incomplete evidence):",
    "Use these primary passages for your independent assessment; do not inherit an earlier assessment or assume this set is exhaustive. Continue your own discovery through the currently listed source references and available search/read tools, especially for facts or obligations outside these byte ranges.",
    ...observations.map((observation) =>
      JSON.stringify({
        kind: "docsfab-preservation-source-observation",
        sourceId: observation.sourceId,
        path: observation.path,
        sha256: observation.sha256,
        fromByte: observation.fromByte,
        endByte: observation.endByte,
        sourceByteLength: observation.sourceByteLength,
        nextFromByte: observation.nextFromByte,
        discoveryComplete: observation.discoveryComplete,
        observedInStepId: observation.observedInStepId,
        text: observation.text,
      }),
    ),
  ].join("\n");
}

function createObservationKey(input: {
  readonly runId: string;
  readonly repositoryRevision: string;
  readonly workspaceSnapshotSha256: string;
  readonly authorityDigest: string;
  readonly reference: {
    readonly sourceId: string;
    readonly sha256: string;
    readonly byteLength: number;
  };
  readonly fromByte: number;
  readonly maxBytes: number;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        CACHE_TOOL_VERSION,
        input.runId,
        input.repositoryRevision,
        input.workspaceSnapshotSha256,
        input.authorityDigest,
        input.reference.sourceId,
        input.reference.sha256,
        input.reference.byteLength,
        input.fromByte,
        input.maxBytes,
      ]),
    )
    .digest("hex");
}

function sameRead(left: PreservationSourceReadV1, right: PreservationSourceReadV1): boolean {
  return (
    left.sourceId === right.sourceId &&
    left.path === right.path &&
    left.sha256 === right.sha256 &&
    left.fromByte === right.fromByte &&
    left.endByte === right.endByte &&
    left.nextFromByte === right.nextFromByte &&
    left.text === right.text
  );
}

export function preservationSourceObservationCacheStats(
  cache: PreservationSourceObservationCacheV1,
): PreservationSourceObservationCacheStatsV1 {
  const state = cacheStates.get(cache);
  if (!state)
    throw new Error("The preservation source observation cache is invalid for this workflow.");
  return Object.freeze({
    hits: state.hits,
    misses: state.misses,
    seededRanges: state.seededRanges,
    invalidations: Object.freeze({ ...state.invalidations }),
    missReasons: Object.freeze({ ...state.missReasons }),
    refusals: state.refusals,
  });
}
