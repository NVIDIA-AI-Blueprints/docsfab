// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { chmod, lstat, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createArtifact } from "../src/artifacts/index.js";
import { canonicalDigest } from "../src/content-ir/canonical.js";
import {
  contextCacheKey,
  createContextCacheIdentity,
  FileContextCache,
} from "../src/context/cache.js";
import {
  canonicalContextPacketDigest,
  canonicalContextPacketJson,
  compileContext,
} from "../src/context/compiler.js";
import type {
  ContextCompileInput,
  ContextProvenance,
  ContextResult,
} from "../src/context/contracts.js";
import { ContextService } from "../src/context/service.js";
import { temporaryRoots } from "./helpers/temp.js";

const roots = temporaryRoots();
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);

describe("revision-bound context cache", () => {
  it("binds the key to revision, content, index, ontology, plan, query, policy, and budget", () => {
    const baseline = compileInput();
    const baselineKey = keyFor(baseline);
    const variants: ContextCompileInput[] = [
      compileInput({ revision: "b".repeat(40) }),
      compileInput({ contentDigest: SHA_B }),
      compileInput({ indexDigest: SHA_B }),
      compileInput({ ontologyDigest: SHA_B }),
      compileInput({ activePlanDigest: SHA_B }),
      compileInput({ queryTarget: "document:other.md" }),
      compileInput({ policyDigest: SHA_B }),
      compileInput({ maxNodes: 31 }),
    ];

    expect(variants.map(keyFor)).toHaveLength(8);
    expect(variants.every((variant) => keyFor(variant) !== baselineKey)).toBe(true);
    expect(new Set(variants.map(keyFor)).size).toBe(variants.length);
  });

  it("writes atomically with private modes and reuses only exact entries", async () => {
    const parent = await temporaryDirectory();
    const root = join(parent, "cache");
    const cache = new FileContextCache(root);
    const input = compileInput();
    const result = readyResult(input);

    await cache.write(createContextCacheIdentity(input), result);

    const key = keyFor(input);
    expect((await lstat(root)).mode & 0o777).toBe(0o700);
    expect((await lstat(join(root, `${key}.json`))).mode & 0o777).toBe(0o600);
    await expect(cache.read(createContextCacheIdentity(input))).resolves.toEqual({
      status: "hit",
      result,
    });
  });

  it("never reuses an entry from another repository revision", async () => {
    const parent = await temporaryDirectory();
    const cache = new FileContextCache(join(parent, "cache"));
    const firstInput = compileInput();
    await cache.write(createContextCacheIdentity(firstInput), readyResult(firstInput));

    const nextInput = compileInput({ revision: "b".repeat(40) });
    const compile = vi.fn(() => readyResult(nextInput));
    const response = await new ContextService({ cache, compile }).resolve({
      input: nextInput,
      access: "read-only",
    });

    expect(compile).toHaveBeenCalledOnce();
    expect(response.evidence.cache).toBe("miss");
    expect(response.evidence.rebuildAttempted).toBe(true);
    expect(response.result.provenance.repository.revision).toBe("b".repeat(40));
  });

  it("rejects corrupt entries and performs only one bounded rebuild", async () => {
    const parent = await temporaryDirectory();
    const root = join(parent, "cache");
    const cache = new FileContextCache(root);
    const input = compileInput();
    const identity = createContextCacheIdentity(input);
    await cache.write(identity, readyResult(input));
    await writeFile(join(root, `${contextCacheKey(identity)}.json`), "{broken", {
      encoding: "utf8",
      mode: 0o600,
    });

    const compile = vi.fn(() => readyResult(input));
    const response = await new ContextService({ cache, compile }).resolve({
      input,
      access: "read-only",
    });

    expect(compile).toHaveBeenCalledOnce();
    expect(response.evidence).toMatchObject({
      cache: "rejected",
      cacheReason: "invalid-json",
      rebuildAttempted: true,
    });
    expect(
      JSON.parse(await readFile(join(root, `${contextCacheKey(identity)}.json`), "utf8")),
    ).toMatchObject({ schemaVersion: 1, key: contextCacheKey(identity) });
  });

  it("rebuilds a digest-valid cache envelope whose result violates the closed contract", async () => {
    const parent = await temporaryDirectory();
    const cache = new FileContextCache(join(parent, "cache"));
    const input = compileInput();
    await cache.write(createContextCacheIdentity(input), {
      status: "ready",
      reasons: [],
      provenance: provenance(input),
    });
    const compile = vi.fn(() => readyResult(input));

    const response = await new ContextService({ cache, compile }).resolve({
      input,
      access: "read-only",
    });

    expect(compile).toHaveBeenCalledOnce();
    expect(response.evidence).toMatchObject({
      cache: "rejected",
      cacheReason: "identity-mismatch",
      rebuildAttempted: true,
    });
    expect(response.result.packet?.digest).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("rejects symlinked roots without following or replacing them", async () => {
    const parent = await temporaryDirectory();
    const target = await temporaryDirectory();
    const root = join(parent, "cache");
    await symlink(target, root, "dir");
    const input = compileInput();

    const response = await new ContextService({
      cache: new FileContextCache(root),
      compile: () => readyResult(input),
    }).resolve({ input, access: "read-only" });

    expect(response.result.status).toBe("ready");
    expect(response.evidence).toMatchObject({
      cache: "rejected",
      cacheReason: "unsafe-root",
      rebuildAttempted: true,
    });
    expect((await lstat(root)).isSymbolicLink()).toBe(true);
  });

  it("rejects entries whose permissions are not private", async () => {
    const parent = await temporaryDirectory();
    const root = join(parent, "cache");
    const cache = new FileContextCache(root);
    const input = compileInput();
    const identity = createContextCacheIdentity(input);
    await cache.write(identity, readyResult(input));
    await chmod(join(root, `${contextCacheKey(identity)}.json`), 0o644);

    await expect(cache.read(identity)).resolves.toEqual({
      status: "rejected",
      reason: "invalid-permissions",
    });
  });

  it("rejects an injected compiler result that diverges from deterministic output", async () => {
    const input = compileInput();
    const ready = readyResult(input);
    const degraded: ContextResult = {
      ...ready,
      status: "degraded",
      reasons: [{ code: "page-role-unresolved", detail: "document:index.md" }],
    };
    const service = new ContextService({ compile: () => degraded });

    const read = await service.resolve({ input, access: "read-only" });
    const write = await service.resolve({ input, access: "write-capable" });

    expect(read.result.status).toBe("failed");
    expect(write.result.status).toBe("failed");
    expect(read.result.packet).toBeUndefined();
    expect(write.result.packet).toBeUndefined();
  });

  it("rejects invalid freshly compiled output at the service boundary", async () => {
    const input = compileInput();
    const compile = vi.fn(
      (): ContextResult => ({
        status: "degraded",
        reasons: [{ code: "page-role-unresolved" }],
        provenance: provenance(input),
      }),
    );

    const response = await new ContextService({ compile }).resolve({
      input,
      access: "read-only",
    });

    expect(compile).toHaveBeenCalledOnce();
    expect(response.result).toEqual({
      status: "failed",
      reasons: [{ code: "invalid-input", detail: "context-rebuild-failed" }],
      provenance: provenance(input),
    });
    expect(response.evidence.rebuildAttempted).toBe(true);
  });

  it("rejects unrelated valid-node output from an injected compiler before delivery or cache", async () => {
    const input = compileInput();
    const poisoned = structuredClone(readyResult(input));
    const unrelatedInput: ContextCompileInput = {
      ...input,
      query: { kind: "get-neighborhood", targetNodeId: "document:unrelated.md" },
    };
    const unrelated = readyResult(unrelatedInput);
    poisoned.packet!.nodes = structuredClone(unrelated.packet!.nodes);
    poisoned.packet!.edges = structuredClone(unrelated.packet!.edges);
    poisoned.packet!.paths = structuredClone(unrelated.packet!.paths);
    poisoned.packet!.semantics = [];
    poisoned.provenance.consultedNodeIds = ["document:unrelated.md"];
    poisoned.provenance.activeDecisionIds = [];
    poisoned.provenance.semanticPackets = [];
    poisoned.packet!.provenance.consultedNodeIds = ["document:unrelated.md"];
    poisoned.packet!.provenance.activeDecisionIds = [];
    poisoned.packet!.provenance.semanticPackets = [];
    resignResult(poisoned);
    const cache = {
      read: vi.fn(async () => ({ status: "miss" as const })),
      write: vi.fn(async () => undefined),
    };

    const response = await new ContextService({
      cache,
      compile: () => poisoned,
    }).resolve({ input, access: "read-only" });

    expect(response.result.status).toBe("failed");
    expect(response.result.packet).toBeUndefined();
    expect(response.result.reasons).toEqual([
      { code: "invalid-input", detail: "context-rebuild-failed" },
    ]);
    expect(cache.write).not.toHaveBeenCalled();
    expect(JSON.stringify(response)).not.toContain("document:unrelated.md");
  });

  it("converts a rebuild exception into content-free failed evidence", async () => {
    const input = compileInput();
    const compile = vi.fn(() => {
      throw new Error("SECRET_BODY_SENTINEL");
    });
    const service = new ContextService({ compile, clock: sequenceClock(10, 17, 20, 29) });

    const read = await service.resolve({ input, access: "read-only" });
    const write = await service.resolve({ input, access: "write-capable" });

    expect(read.result).toMatchObject({
      status: "failed",
      reasons: [{ code: "invalid-input", detail: "context-rebuild-failed" }],
    });
    expect(write.result.status).toBe("failed");
    expect(JSON.stringify([read, write])).not.toContain("SECRET_BODY_SENTINEL");
    expect(read.evidence.durationMs).toBe(7);
    expect(write.evidence.durationMs).toBe(9);
    expect(compile).toHaveBeenCalledTimes(2);
  });

  it("records over-duration context resolution without revoking valid packets", async () => {
    const input = compileInput();
    const read = await new ContextService({
      compile: () => readyResult(input),
      clock: sequenceClock(0, 251),
    }).resolve({ input, access: "read-only" });
    const write = await new ContextService({
      compile: () => readyResult(input),
      clock: sequenceClock(0, 251),
    }).resolve({ input, access: "write-capable" });

    expect(read.result).toMatchObject({ status: "ready", reasons: [] });
    expect(read.result.packet).toBeDefined();
    expect(write.result.status).toBe("ready");
    expect(write.result.packet).toBeDefined();
    expect(read.evidence.durationMs).toBe(251);
    expect(write.evidence.durationMs).toBe(251);
  });
});

function compileInput(
  options: {
    revision?: string;
    contentDigest?: string;
    indexDigest?: string;
    ontologyDigest?: string;
    activePlanDigest?: string;
    queryTarget?: string;
    policyDigest?: string;
    maxNodes?: number;
  } = {},
): ContextCompileInput {
  const revision = options.revision ?? "a".repeat(40);
  const contentDigest = options.contentDigest ?? SHA_A;
  const targetNodeId = options.queryTarget ?? "document:index.md";
  const targetPath = targetNodeId.replace(/^document:/u, "");
  const nodes: ContextCompileInput["index"]["nodes"] = [targetNodeId, "document:unrelated.md"]
    .filter((nodeId, index, values) => values.indexOf(nodeId) === index)
    .map((nodeId) => ({
      id: nodeId,
      kind: "document" as const,
      sourcePath: nodeId === targetNodeId ? targetPath : "unrelated.md",
      format: "gfm" as const,
      byteLength: 8,
      anchors: [],
      frontmatter: [],
      directives: [],
      codeBlocks: [],
      regions: {
        body: options.indexDigest ?? "1".repeat(64),
        headings: "2".repeat(64),
        metadata: "3".repeat(64),
        navigation: "4".repeat(64),
        graph: "5".repeat(64),
      },
    }));
  const unboundIndex: ContextCompileInput["index"] = {
    schemaVersion: 1,
    repository: { revision, contentDigest },
    indexDigest: options.indexDigest ?? SHA_A,
    nodes,
    edges: [],
    evidence: {
      repositoryRevision: revision,
      contentDigest,
      indexDigest: options.indexDigest ?? SHA_A,
      documentCount: nodes.length,
      sectionCount: 0,
      edgeCount: 0,
    },
  };
  const indexDigest = canonicalDigest({
    schemaVersion: unboundIndex.schemaVersion,
    repository: unboundIndex.repository,
    nodes: unboundIndex.nodes,
    edges: unboundIndex.edges,
  });
  const index: ContextCompileInput["index"] = {
    ...unboundIndex,
    indexDigest,
    evidence: { ...unboundIndex.evidence, indexDigest },
  };
  const ontology = createArtifact(
    "ontology",
    {
      entities: [],
      relationships: [],
    },
    { index },
  );
  if (options.ontologyDigest) ontology.digest = options.ontologyDigest;
  return {
    index,
    ontology,
    semantics: [],
    query: {
      kind: "get-neighborhood",
      targetNodeId,
    },
    policy: {
      id: "context-preflight",
      version: "1",
      digest: options.policyDigest ?? SHA_A,
      allowDegradedRead: true,
    },
    budget: {
      class: "local",
      maxNodes: options.maxNodes ?? 32,
      maxEdges: 96,
      maxPaths: 24,
      maxDepth: 2,
      maxBytes: 32 * 1024,
      maxEstimatedTokens: 2_048,
      maxDurationMs: 250,
    },
    activePlan: {
      kind: "ia-plan",
      schemaVersion: 1,
      digest: options.activePlanDigest ?? SHA_C,
      repositoryRevision: revision,
      repositoryContentDigest: contentDigest,
    },
  };
}

function keyFor(input: ContextCompileInput): string {
  return contextCacheKey(createContextCacheIdentity(input));
}

function provenance(input: ContextCompileInput): ContextProvenance {
  return {
    repository: input.index.repository,
    indexDigest: input.index.indexDigest,
    ontology: {
      kind: "ontology",
      schemaVersion: 1,
      digest: input.ontology.digest,
      repositoryRevision: input.ontology.repository.revision,
      repositoryContentDigest: input.ontology.repository.contentDigest,
    },
    semanticPackets: [],
    ...(input.activePlan ? { activePlan: input.activePlan } : {}),
    consultedNodeIds: [],
    activeDecisionIds: [],
    policy: input.policy,
    budget: input.budget,
  };
}

function readyResult(input: ContextCompileInput): ContextResult {
  return compileContext(input);
}

function resignResult(result: ContextResult): void {
  const packet = result.packet!;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    packet.digest = canonicalContextPacketDigest(packet);
    const byteLength = Buffer.byteLength(canonicalContextPacketJson(packet));
    const estimatedTokens = Math.ceil(byteLength / 4);
    if (
      packet.estimates.byteLength === byteLength &&
      packet.estimates.estimatedTokens === estimatedTokens
    )
      break;
    packet.estimates = { byteLength, estimatedTokens };
  }
  packet.digest = canonicalContextPacketDigest(packet);
}

function temporaryDirectory(): Promise<string> {
  return roots.create("docsfab-context-cache-");
}

function sequenceClock(...values: number[]): () => number {
  let index = 0;
  return () => values[index++] ?? values.at(-1) ?? 0;
}
