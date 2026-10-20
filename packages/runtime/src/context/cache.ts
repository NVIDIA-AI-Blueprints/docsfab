// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { canonicalDigest, canonicalJson } from "../content-ir/canonical.js";
import type { ContextCompileInput, ContextResult } from "./contracts.js";
import { canonicalContextQueryDigest } from "./queries.js";

const CACHE_DIRECTORY_MODE = 0o700;
const CACHE_FILE_MODE = 0o600;
const SHA256 = /^[a-f0-9]{64}$/u;

export interface ContextCacheIdentity {
  schemaVersion: 1;
  repositoryRevision: string;
  repositoryContentDigest: string;
  indexDigest: string;
  ontologyDigest: string;
  semanticStateDigest: string;
  activePlanDigest: string | null;
  queryDigest: string;
  policyDigest: string;
  budgetDigest: string;
}

export type ContextCacheRejectReason =
  | "unsafe-root"
  | "unsafe-entry"
  | "invalid-permissions"
  | "invalid-json"
  | "schema-mismatch"
  | "stale-cache"
  | "identity-mismatch"
  | "result-digest-mismatch";

export type ContextCacheRead =
  | { status: "hit"; result: ContextResult }
  | { status: "miss" }
  | { status: "rejected"; reason: ContextCacheRejectReason };

interface ContextCacheEnvelope {
  schemaVersion: 1;
  key: string;
  identity: ContextCacheIdentity;
  resultDigest: string;
  result: ContextResult;
}

export class ContextCacheError extends Error {
  public constructor(
    public readonly code: ContextCacheRejectReason,
    message: string,
  ) {
    super(message);
    this.name = "ContextCacheError";
  }
}

/**
 * Binds cached context to all semantic inputs that can change the compiled
 * packet. Only digests and immutable identifiers are retained in the key.
 */
export function createContextCacheIdentity(input: ContextCompileInput): ContextCacheIdentity {
  return {
    schemaVersion: 1,
    repositoryRevision: input.index.repository.revision,
    repositoryContentDigest: input.index.repository.contentDigest,
    indexDigest: input.index.indexDigest,
    ontologyDigest: input.ontology.digest,
    semanticStateDigest: canonicalDigest(
      input.semantics
        .map((artifact) => ({ kind: artifact.kind, digest: artifact.digest }))
        .sort((left, right) => {
          const leftKey = `${left.kind}:${left.digest}`;
          const rightKey = `${right.kind}:${right.digest}`;
          return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
        }),
    ),
    activePlanDigest: input.activePlan?.digest ?? null,
    queryDigest: canonicalContextQueryDigest(input.query),
    policyDigest: canonicalDigest(input.policy),
    budgetDigest: canonicalDigest(input.budget),
  };
}

export function contextCacheKey(identity: ContextCacheIdentity): string {
  return canonicalDigest(identity);
}

/**
 * A local, revision-bound cache. Cache entries are never trusted merely
 * because their filename matches: the full identity and payload digest are
 * verified on every read.
 */
export class FileContextCache {
  private readonly root: string;

  public constructor(root: string) {
    this.root = resolve(root);
  }

  public async read(identity: ContextCacheIdentity): Promise<ContextCacheRead> {
    const rootState = await this.inspectRoot(false);
    if (rootState === "missing") return { status: "miss" };
    if (rootState) return { status: "rejected", reason: rootState };

    const key = contextCacheKey(identity);
    const path = this.entryPath(key);
    let metadata;
    try {
      metadata = await lstat(path);
    } catch (error) {
      if (isNotFound(error)) return { status: "miss" };
      return { status: "rejected", reason: "unsafe-entry" };
    }
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      return { status: "rejected", reason: "unsafe-entry" };
    }
    if ((metadata.mode & 0o077) !== 0) {
      return { status: "rejected", reason: "invalid-permissions" };
    }

    let candidate: unknown;
    try {
      candidate = JSON.parse(await readFile(path, "utf8"));
    } catch {
      return { status: "rejected", reason: "invalid-json" };
    }
    if (!isCacheEnvelope(candidate)) {
      return { status: "rejected", reason: "schema-mismatch" };
    }
    if (candidate.key !== key) {
      return { status: "rejected", reason: "identity-mismatch" };
    }
    if (!sameIdentity(candidate.identity, identity)) {
      const stale =
        candidate.identity.repositoryRevision !== identity.repositoryRevision ||
        candidate.identity.repositoryContentDigest !== identity.repositoryContentDigest ||
        candidate.identity.indexDigest !== identity.indexDigest;
      return {
        status: "rejected",
        reason: stale ? "stale-cache" : "identity-mismatch",
      };
    }
    if (canonicalDigest(candidate.result) !== candidate.resultDigest) {
      return { status: "rejected", reason: "result-digest-mismatch" };
    }
    return { status: "hit", result: candidate.result };
  }

  public async write(identity: ContextCacheIdentity, result: ContextResult): Promise<void> {
    const rootState = await this.inspectRoot(true);
    if (rootState) {
      const reason = rootState === "missing" ? "unsafe-root" : rootState;
      throw new ContextCacheError(reason, `Context cache root rejected: ${reason}.`);
    }

    const key = contextCacheKey(identity);
    const destination = this.entryPath(key);
    try {
      const existing = await lstat(destination);
      if (!existing.isFile() || existing.isSymbolicLink()) {
        throw new ContextCacheError("unsafe-entry", "Context cache entry is not a regular file.");
      }
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }

    const envelope: ContextCacheEnvelope = {
      schemaVersion: 1,
      key,
      identity,
      resultDigest: canonicalDigest(result),
      result,
    };
    const temporary = join(this.root, `.${key}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, `${canonicalJson(envelope)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: CACHE_FILE_MODE,
      });
      await chmod(temporary, CACHE_FILE_MODE);
      await rename(temporary, destination);
      await chmod(destination, CACHE_FILE_MODE);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  private entryPath(key: string): string {
    if (!SHA256.test(key)) {
      throw new ContextCacheError("identity-mismatch", "Invalid context cache key.");
    }
    return join(this.root, `${key}.json`);
  }

  private async inspectRoot(
    create: boolean,
  ): Promise<ContextCacheRejectReason | "missing" | undefined> {
    try {
      const metadata = await lstat(this.root);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) return "unsafe-root";
      if ((metadata.mode & 0o077) !== 0) {
        if (!create) return "invalid-permissions";
        await chmod(this.root, CACHE_DIRECTORY_MODE);
      }
      return undefined;
    } catch (error) {
      if (!isNotFound(error)) return "unsafe-root";
      if (!create) return "missing";
      try {
        await mkdir(this.root, { recursive: true, mode: CACHE_DIRECTORY_MODE });
        await chmod(this.root, CACHE_DIRECTORY_MODE);
        const metadata = await lstat(this.root);
        return metadata.isDirectory() && !metadata.isSymbolicLink() ? undefined : "unsafe-root";
      } catch {
        return "unsafe-root";
      }
    }
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function sameIdentity(left: ContextCacheIdentity, right: ContextCacheIdentity): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function isCacheEnvelope(value: unknown): value is ContextCacheEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.schemaVersion !== 1 ||
    typeof candidate.key !== "string" ||
    !SHA256.test(candidate.key) ||
    typeof candidate.resultDigest !== "string" ||
    !SHA256.test(candidate.resultDigest) ||
    !candidate.result ||
    typeof candidate.result !== "object" ||
    !isCacheIdentity(candidate.identity)
  ) {
    return false;
  }
  return true;
}

function isCacheIdentity(value: unknown): value is ContextCacheIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.schemaVersion === 1 &&
    typeof candidate.repositoryRevision === "string" &&
    typeof candidate.repositoryContentDigest === "string" &&
    typeof candidate.indexDigest === "string" &&
    typeof candidate.ontologyDigest === "string" &&
    typeof candidate.semanticStateDigest === "string" &&
    (typeof candidate.activePlanDigest === "string" || candidate.activePlanDigest === null) &&
    typeof candidate.queryDigest === "string" &&
    typeof candidate.policyDigest === "string" &&
    typeof candidate.budgetDigest === "string"
  );
}
