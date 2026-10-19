// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { performance } from "node:perf_hooks";

import type { ArtifactEnvelope, ArtifactReference } from "../artifacts/contracts.js";
import {
  ContextCacheError,
  type ContextCacheIdentity,
  type ContextCacheRead,
  type ContextCacheRejectReason,
  contextCacheKey,
  createContextCacheIdentity,
  FileContextCache,
} from "./cache.js";
import { compileContext, validateCompilerResult, validateContextResult } from "./compiler.js";
import type { ContextCompileInput, ContextProvenance, ContextResult } from "./contracts.js";

export type ContextAccessMode = "read-only" | "write-capable";

export interface ContextServiceRequest {
  input: ContextCompileInput;
  access: ContextAccessMode;
}

export interface ContextServiceEvidence {
  cache: "disabled" | "hit" | "miss" | "rejected";
  cacheKeyDigest: string;
  cacheReason?: ContextCacheRejectReason;
  rebuildAttempted: boolean;
  durationMs: number;
  packetDigest?: string;
  nodeCount: number;
  edgeCount: number;
  pathCount: number;
  byteLength: number;
  estimatedTokens: number;
}

export interface ContextServiceResponse {
  result: ContextResult;
  evidence: ContextServiceEvidence;
}

export interface ContextCacheStore {
  read(identity: ContextCacheIdentity): Promise<ContextCacheRead>;
  write(identity: ContextCacheIdentity, result: ContextResult): Promise<void>;
}

export interface ContextServiceOptions {
  cache?: ContextCacheStore;
  compile?: (input: ContextCompileInput) => ContextResult | Promise<ContextResult>;
  clock?: () => number;
}

/**
 * Coordinates strict cache reuse and at most one bounded compilation.
 * Degraded packets preserve bounded structural evidence; write authorization
 * remains the runner's responsibility.
 */
export class ContextService {
  private readonly cache?: ContextCacheStore;
  private readonly compile: (input: ContextCompileInput) => ContextResult | Promise<ContextResult>;
  private readonly validateCompiledResult: (
    value: unknown,
    input: ContextCompileInput,
  ) => ContextResult;
  private readonly clock: () => number;

  public constructor(options: ContextServiceOptions = {}) {
    this.cache = options.cache;
    this.compile = options.compile ?? compileContext;
    // Only the exact built-in function is trusted as the deterministic
    // producer. Injected compilers are external inputs and must reconstruct.
    this.validateCompiledResult = options.compile ? validateContextResult : validateCompilerResult;
    this.clock = options.clock ?? (() => performance.now());
  }

  public static withFileCache(
    cacheRoot: string,
    options: Omit<ContextServiceOptions, "cache"> = {},
  ): ContextService {
    return new ContextService({ ...options, cache: new FileContextCache(cacheRoot) });
  }

  public async resolve(request: ContextServiceRequest): Promise<ContextServiceResponse> {
    const startedAt = this.clock();
    const identity = createContextCacheIdentity(request.input);
    const key = contextCacheKey(identity);
    let cacheState: ContextServiceEvidence["cache"] = this.cache ? "miss" : "disabled";
    let cacheReason: ContextCacheRejectReason | undefined;

    if (this.cache) {
      let cached: ContextCacheRead;
      try {
        cached = await this.cache.read(identity);
      } catch {
        cached = { status: "rejected", reason: "unsafe-entry" };
      }
      cacheState = cached.status;
      if (cached.status === "rejected") cacheReason = cached.reason;
      if (cached.status === "hit") {
        if (isReusable(cached.result, request.input)) {
          const durationMs = elapsed(this.clock(), startedAt);
          const result = enforceAccess(cached.result, request);
          return {
            result,
            evidence: evidenceFor(result, "hit", key, false, durationMs),
          };
        }
        cacheState = "rejected";
        cacheReason = "identity-mismatch";
      }
    }

    let compiled: ContextResult;
    try {
      compiled = this.validateCompiledResult(await this.compile(request.input), request.input);
    } catch {
      compiled = resultForFailure(request.input);
    }
    const compiledForAccess = enforceAccess(compiled, request);

    if (
      this.cache &&
      (compiledForAccess.status === "ready" || compiledForAccess.status === "unnecessary")
    ) {
      try {
        await this.cache.write(identity, compiledForAccess);
      } catch (error) {
        cacheState = "rejected";
        cacheReason = error instanceof ContextCacheError ? error.code : "unsafe-entry";
      }
    }

    const durationMs = elapsed(this.clock(), startedAt);
    const result = compiledForAccess;
    const evidence = evidenceFor(result, cacheState, key, true, durationMs, cacheReason);
    return { result, evidence };
  }
}

function enforceAccess(result: ContextResult, _request: ContextServiceRequest): ContextResult {
  if (result.status !== "degraded") return result;
  if (result.packet) return result;
  return {
    status: "failed",
    reasons:
      result.reasons.length > 0
        ? result.reasons
        : [{ code: "invalid-input", detail: "degraded-context-disallowed" }],
    provenance: result.provenance,
  };
}

function resultForFailure(input: ContextCompileInput): ContextResult {
  return {
    status: "failed",
    reasons: [{ code: "invalid-input", detail: "context-rebuild-failed" }],
    provenance: provenanceFor(input),
  };
}

function provenanceFor(input: ContextCompileInput): ContextProvenance {
  return {
    repository: input.index.repository,
    indexDigest: input.index.indexDigest,
    ontology: referenceFor(input.ontology),
    semanticPackets: input.semantics.map(referenceFor),
    ...(input.activePlan ? { activePlan: input.activePlan } : {}),
    consultedNodeIds: [],
    activeDecisionIds: [],
    policy: input.policy,
    budget: input.budget,
  };
}

function referenceFor<K extends "ontology" | "context-packet">(
  artifact: ArtifactEnvelope<K>,
): ArtifactReference<K> {
  return {
    kind: artifact.kind,
    schemaVersion: artifact.schemaVersion,
    digest: artifact.digest,
    repositoryRevision: artifact.repository.revision,
    repositoryContentDigest: artifact.repository.contentDigest,
  };
}

function isReusable(result: ContextResult, input: ContextCompileInput): boolean {
  try {
    validateContextResult(result, input);
    return result.status === "ready" || result.status === "unnecessary";
  } catch {
    return false;
  }
}

function evidenceFor(
  result: ContextResult,
  cache: ContextServiceEvidence["cache"],
  cacheKeyDigest: string,
  rebuildAttempted: boolean,
  durationMs: number,
  cacheReason?: ContextCacheRejectReason,
): ContextServiceEvidence {
  const packet = result.packet;
  return {
    cache,
    cacheKeyDigest,
    ...(cacheReason ? { cacheReason } : {}),
    rebuildAttempted,
    durationMs,
    ...(packet ? { packetDigest: packet.digest } : {}),
    nodeCount: packet?.nodes.length ?? 0,
    edgeCount: packet?.edges.length ?? 0,
    pathCount: packet?.paths.length ?? 0,
    byteLength: packet?.estimates.byteLength ?? 0,
    estimatedTokens: packet?.estimates.estimatedTokens ?? 0,
  };
}

function elapsed(finishedAt: number, startedAt: number): number {
  if (!Number.isFinite(finishedAt) || !Number.isFinite(startedAt)) return 0;
  return Math.max(0, Math.round(finishedAt - startedAt));
}
