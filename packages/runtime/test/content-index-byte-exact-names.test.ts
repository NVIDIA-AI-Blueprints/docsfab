// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The content index reads each file by the bytes its directory lists (#1941).
 *
 * macOS APFS finds a file by either Unicode normalization of its name, so a
 * decomposed (NFD) name reads back even when the index asks for the composed
 * (NFC) spelling. Linux ext4, as on the pilot host, matches names byte for
 * byte, so asking by the wrong spelling is ENOENT. This file simulates the
 * byte-exact file system on any host: under `byteExact.root`, `readFile`
 * resolves a path only when every segment equals, code unit for code unit, a
 * name its directory lists, and `readdir` can list extra entries that APFS
 * cannot hold beside the real ones, such as a composed twin of a decomposed
 * name, or a name that is not UTF-8.
 */
import { createHash } from "node:crypto";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildContentIndex,
  contentIndexLimitations,
  contentIndexNameWarnings,
  type ContentIndexV1,
  type DocumentNode,
} from "../src/content-ir/index.js";
import type { ContextPacketV1, ContextPreflightInput } from "../src/context/contracts.js";
import { LocalContextPreflightService } from "../src/context/index.js";
import { createHostedContextPreflightService } from "../src/host-invoker/context-preflight.js";
import {
  collectRunLimitOverflowEvidence,
  projectRunLimitOverflowLines,
} from "../src/operator/run-limit-overflow.js";
import type { RunRecord, RunStore } from "../src/records/contracts.js";
import { preflightContext } from "../src/workflow-execution/runner-evidence.js";
import { WorkflowRunner } from "../src/workflow-execution/runner.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import { temporaryRoots } from "./helpers/temp.js";

interface ListedExtra {
  /** The entry name's bytes, as a byte-exact directory lists them. */
  readonly name: Buffer;
  /** The real file the simulated entry reads from. */
  readonly backing: string;
}

const byteExact = vi.hoisted(() => ({
  root: null as string | null,
  extra: new Map<string, ListedExtra[]>(),
  /** Directories whose listing fails as a directory without read permission does. */
  unreadable: new Set<string>(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const path = await import("node:path");
  const missing = (target: string): Error =>
    Object.assign(new Error(`ENOENT: no such file or directory, open '${target}'`), {
      code: "ENOENT",
      errno: -2,
      syscall: "open",
      path: target,
    });
  /** The real file a byte-exact lookup of `target` reads, or ENOENT. */
  const exactFile = async (target: string): Promise<string> => {
    const root = byteExact.root;
    const absolute = path.resolve(target);
    if (root === null || !absolute.startsWith(`${root}${path.sep}`)) return target;
    let directory = root;
    const segments = absolute.slice(root.length + 1).split(path.sep);
    for (const [position, segment] of segments.entries()) {
      const listed = await actual.readdir(directory, { encoding: "buffer" });
      const extra = (byteExact.extra.get(directory) ?? []).find(
        (item) => item.name.toString("utf8") === segment,
      );
      if (extra && position === segments.length - 1) return extra.backing;
      if (!listed.some((name) => name.toString("utf8") === segment)) throw missing(target);
      directory = path.join(directory, segment);
    }
    return absolute;
  };
  const listing = (async (...args: Parameters<typeof actual.readdir>) => {
    const listed = path.resolve(String(args[0]));
    if (byteExact.unreadable.has(listed)) {
      throw Object.assign(new Error(`EACCES: permission denied, scandir '${listed}'`), {
        code: "EACCES",
        errno: -13,
        syscall: "scandir",
        path: listed,
      });
    }
    const entries = (await actual.readdir(...args)) as unknown[];
    const options = args[1];
    const extra = byteExact.extra.get(path.resolve(String(args[0])));
    if (!extra || typeof options !== "object" || !options?.withFileTypes) return entries;
    const buffers = options.encoding === "buffer";
    return [
      ...entries,
      ...extra.map((item) => ({
        name: buffers ? item.name : item.name.toString("utf8"),
        isDirectory: () => false,
        isFile: () => true,
        isSymbolicLink: () => false,
      })),
    ];
  }) as typeof actual.readdir;
  return {
    ...actual,
    readdir: listing,
    readFile: (async (target: Parameters<typeof actual.readFile>[0], ...rest: unknown[]) =>
      actual.readFile(
        typeof target === "string" ? await exactFile(target) : target,
        ...(rest as [undefined]),
      )) as typeof actual.readFile,
  };
});

const REVISION = "a".repeat(40);
/**
 * Code points built at run time, so this file holds no raw combining or
 * replacement character: the two spellings must read apart in review.
 */
const COMBINING_ACUTE = String.fromCodePoint(0x301);
const E_ACUTE = String.fromCodePoint(0xe9);
const ZERO_WIDTH_SPACE = String.fromCodePoint(0x200b);
const REPLACEMENT_CHARACTER = String.fromCodePoint(0xfffd);
const COMPOSED = `caf${E_ACUTE}.md`;
const DECOMPOSED = `cafe${COMBINING_ACUTE}.md`;
const roots = temporaryRoots();

afterEach(() => {
  byteExact.root = null;
  byteExact.extra.clear();
  byteExact.unreadable.clear();
});

class MemoryStore implements RunStore {
  public async save(_record: RunRecord): Promise<void> {}
}

/**
 * A repository with a README and a decomposed-name page, read byte-exactly.
 * `repository` is its real path: the index reads through `realpath`, so the
 * simulation must cover that spelling of the root (`/private/var` on macOS).
 */
async function decomposedRepository(): Promise<{ repository: string; root: string }> {
  const root = await realpath(await roots.create("docsfab-byte-exact-names-"));
  const repository = resolve(root, "repository");
  await mkdir(resolve(repository, "docs"), { recursive: true });
  await writeFile(resolve(repository, "README.md"), `# Home\n\nSee [cafe](docs/${COMPOSED}).\n`);
  await writeFile(resolve(repository, "docs", DECOMPOSED), "# Cafe\n\nDecomposed bytes.\n");
  byteExact.root = repository;
  return { repository, root };
}

function documents(index: ContentIndexV1): DocumentNode[] {
  return index.nodes.filter((node): node is DocumentNode => node.kind === "document");
}

function readinessInput(repository: string): ContextPreflightInput {
  const workflow = getWorkflow("readiness");
  return {
    runId: "byte-exact-names",
    repository: { sourcePath: repository, requestedRevision: "HEAD", revision: REVISION },
    workspacePath: repository,
    workflow,
    step: workflow.steps[0]!,
    policy: workflow.contextPolicy.steps[0]!,
  };
}

describe("content index names on a byte-exact file system (#1941)", () => {
  it("simulates a byte-exact file system: only the listed spelling of a name reads", async () => {
    // Positive control for every test below: without it, a decomposed name
    // would read on this host whichever spelling the index used. The paths
    // are the ones the index builds: its root through `realpath`.
    const { repository } = await decomposedRepository();
    const indexedRoot = await realpath(repository);
    expect(indexedRoot).toBe(repository);
    const { readFile } = await import("node:fs/promises");
    await expect(readFile(join(indexedRoot, "docs", DECOMPOSED), "utf8")).resolves.toContain(
      "Decomposed bytes.",
    );
    await expect(readFile(join(indexedRoot, "docs", COMPOSED), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("reads a decomposed name by its own bytes and names it in NFC", async () => {
    const { repository } = await decomposedRepository();
    const index = await buildContentIndex({
      repositoryPath: repository,
      repositoryRevision: REVISION,
    });
    const cafe = documents(index).find((node) => node.sourcePath === `docs/${COMPOSED}`);
    expect(cafe).toBeDefined();
    expect(cafe!.byteLength).toBe(Buffer.byteLength("# Cafe\n\nDecomposed bytes.\n"));
    expect(
      documents(index)
        .map((node) => node.sourcePath)
        .sort(),
    ).toEqual(["README.md", `docs/${COMPOSED}`]);
    expect(contentIndexLimitations(index)).toEqual([]);
    // The README's composed link reaches the page.
    expect(index.edges.some((edge) => edge.kind === "outbound-link" && edge.to === cafe!.id)).toBe(
      true,
    );
  });

  it("binds a decomposed page through preflight by either spelling", async () => {
    const { repository, root } = await decomposedRepository();
    const workflow = getWorkflow("review-documentation");
    const service = new LocalContextPreflightService({ cacheRoot: resolve(root, "cache") });
    for (const requested of [`docs/${COMPOSED}`, `docs/${DECOMPOSED}`]) {
      const { evidence, packet } = await preflightContext({
        ...readinessInput(repository),
        workflow,
        step: workflow.steps[0]!,
        policy: workflow.contextPolicy.steps[0]!,
        scope: { targetPaths: [requested, "README.md"], scopeSha256: "e".repeat(64) },
        contextPreflight: service,
      });
      expect(evidence.status, requested).toBe("ready");
      expect(evidence.unboundTargets, requested).toBeUndefined();
      expect(
        (packet as ContextPacketV1).nodes.some((node) => node.sourcePath === `docs/${COMPOSED}`),
        requested,
      ).toBe(true);
    }
  });

  it("compiles a real packet for a decomposed page in the hosted preflight too", async () => {
    const { repository, root } = await decomposedRepository();
    const capsuleDigest = "f".repeat(64);
    const hosted = await createHostedContextPreflightService({
      capsule: {
        sha256: capsuleDigest,
        receiptSha256: "d".repeat(64),
        expiresAt: "2099-01-01T00:00:00.000Z",
        selectedEvidence: [{ evidenceId: "product-model", content: "Approved product context." }],
      },
      stateDirectory: resolve(root, "hosted-state"),
    }).preflight(readinessInput(repository));
    expect(hosted.status).toBe("ready");
    expect(hosted.packetDigest).not.toBe(capsuleDigest);
    expect(
      (hosted.packet as ContextPacketV1).nodes.some(
        (node) => node.sourcePath === `docs/${COMPOSED}`,
      ),
    ).toBe(true);
  });

  it("codes a directory the index cannot read, and the read-only step runs on without a packet", async () => {
    const { repository, root } = await decomposedRepository();
    await mkdir(resolve(repository, "docs", "private"));
    byteExact.unreadable.add(resolve(repository, "docs", "private"));
    const cause = {
      code: "EACCES",
      message: "EACCES: permission denied, scandir 'docs/private'",
    };
    const service = new LocalContextPreflightService({ cacheRoot: resolve(root, "cache") });
    const result = await service.preflight(readinessInput(repository));
    expect(result).toMatchObject({ status: "degraded", reason: "content-index-unreadable", cause });
    expect(result.cause?.message).not.toContain(root);
    const record = await new WorkflowRunner({
      harness: { runStep: async () => ({ summary: "readiness result" }) },
      store: new MemoryStore(),
      repositoryScanner: {
        scan: async () => ({
          ruleSet: "byte-exact-names-test-v1",
          status: "passed",
          scannedFiles: 2,
          binaryFiles: 0,
          findings: [],
        }),
      },
      contextPreflight: service,
      id: () => "byte-exact-unreadable-run",
      now: () => new Date("2026-10-06T12:00:00.000Z"),
    }).run({
      workflow: "readiness",
      workspacePath: repository,
      repository: { sourcePath: repository, requestedRevision: "HEAD", revision: REVISION },
      allowWrite: false,
    });
    expect(record.status, record.error).toBe("succeeded");
    expect(record.steps[0]!.contextPreflight).toEqual({
      status: "degraded",
      reason: "content-index-unreadable",
      cause,
    });
    expect(projectRunLimitOverflowLines(collectRunLimitOverflowEvidence(record))).toEqual([
      `content-index-unreadable: step "assess-readiness" ran without a context packet (EACCES): ${cause.message}`,
    ]);
  });

  it("runs a readiness step on a decomposed page with ready context", async () => {
    const { repository, root } = await decomposedRepository();
    const packets: unknown[] = [];
    const record = await new WorkflowRunner({
      harness: {
        runStep: async (input) => {
          packets.push(input.contextPacket);
          return { summary: "readiness result" };
        },
      },
      store: new MemoryStore(),
      repositoryScanner: {
        scan: async () => ({
          ruleSet: "byte-exact-names-test-v1",
          status: "passed",
          scannedFiles: 2,
          binaryFiles: 0,
          findings: [],
        }),
      },
      contextPreflight: new LocalContextPreflightService({ cacheRoot: resolve(root, "cache") }),
      id: () => "byte-exact-names-run",
      now: () => new Date("2026-10-06T12:00:00.000Z"),
    }).run({
      workflow: "readiness",
      workspacePath: repository,
      repository: { sourcePath: repository, requestedRevision: "HEAD", revision: REVISION },
      allowWrite: false,
    });
    expect(record.status, JSON.stringify(record.steps[0]?.contextPreflight)).toBe("succeeded");
    expect(record.steps[0]!.contextPreflight).toMatchObject({ status: "ready" });
    expect(record.steps[0]!.contextPreflight!.reason).toBeUndefined();
    expect(packets).toHaveLength(1);
    expect(
      (packets[0] as ContextPacketV1).nodes.some((node) => node.sourcePath === `docs/${COMPOSED}`),
    ).toBe(true);
    expect(record.evidenceWarnings ?? []).toEqual([]);
  });

  it("keeps the composed spelling of two names that normalize alike and names the other", async () => {
    const { repository, root } = await decomposedRepository();
    // A byte-exact file system holds both spellings at once; this host cannot,
    // so the composed twin is listed beside the real decomposed file.
    const twin = resolve(root, "composed-twin.md");
    await writeFile(twin, "# Composed twin\n\nComposed bytes.\n");
    byteExact.extra.set(resolve(repository, "docs"), [
      { name: Buffer.from(COMPOSED, "utf8"), backing: twin },
    ]);
    const index = await buildContentIndex({
      repositoryPath: repository,
      repositoryRevision: REVISION,
    });
    const kept = documents(index).filter((node) => node.sourcePath === `docs/${COMPOSED}`);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.byteLength).toBe(Buffer.byteLength("# Composed twin\n\nComposed bytes.\n"));
    expect(contentIndexLimitations(index)).toEqual([
      {
        path: `docs/${DECOMPOSED}`,
        reason: "normalized-name-collision",
        resolvedPath: `docs/${COMPOSED}`,
        detail: "its name is the same as the kept file's once both are Unicode-normalized (NFC)",
      },
    ]);
    expect(contentIndexNameWarnings(index)).toEqual([
      `content-index-name-left-out: "docs/cafe\\u{301}.md" is left out of the content index: its name is the same as the kept file's once both are Unicode-normalized (NFC), "docs/${COMPOSED}", which the index keeps. Rename one of them to index both.`,
    ]);
  });

  it("names both files of a long collision by SHA-256 and keeps the remedy for both", async () => {
    const { repository, root } = await decomposedRepository();
    // Each zero-width space escapes to eight characters, so the sentence that
    // names both spellings passes the run record's 1,024 characters.
    const tail = `${ZERO_WIDTH_SPACE.repeat(70)}.md`;
    const decomposedName = `cafe${COMBINING_ACUTE}${tail}`;
    const composedName = `caf${E_ACUTE}${tail}`;
    await writeFile(resolve(repository, "docs", decomposedName), "# Decomposed\n");
    const twin = resolve(root, "long-composed-twin.md");
    await writeFile(twin, "# Composed\n");
    byteExact.extra.set(resolve(repository, "docs"), [
      { name: Buffer.from(composedName, "utf8"), backing: twin },
    ]);
    const index = await buildContentIndex({
      repositoryPath: repository,
      repositoryRevision: REVISION,
    });
    const collision = contentIndexLimitations(index).find(
      (limitation) => limitation.reason === "normalized-name-collision",
    );
    expect(collision).toMatchObject({
      path: `docs/${decomposedName}`,
      resolvedPath: `docs/${composedName}`,
    });
    const sha = (path: string): string => createHash("sha256").update(path).digest("hex");
    expect(contentIndexNameWarnings(index)).toEqual([
      `content-index-name-left-out: a file whose path is too long to show here, with path SHA-256 ${sha(`docs/${decomposedName}`)}, is left out of the content index: its name is the same as the kept file's once both are Unicode-normalized (NFC); the kept file has path SHA-256 ${sha(`docs/${composedName}`)}. Rename one of them to index both.`,
    ]);
  });

  it("leaves out a name that is not UTF-8 text, naming its bytes, and indexes the rest", async () => {
    const { repository, root } = await decomposedRepository();
    const backing = resolve(root, "latin1.md");
    await writeFile(backing, "# Latin-1 name\n");
    // `r\xe9sum\xe9.md` as a Latin-1 tool writes it: not UTF-8.
    const latin1 = Buffer.from([0x72, 0xe9, 0x73, 0x75, 0x6d, 0xe9, 0x2e, 0x6d, 0x64]);
    byteExact.extra.set(resolve(repository, "docs"), [{ name: latin1, backing }]);
    const service = new LocalContextPreflightService({ cacheRoot: resolve(root, "cache") });
    const result = await service.preflight(readinessInput(repository));
    expect(result.status).toBe("ready");
    expect(result.limitations).toEqual([
      `content-index-name-left-out: "docs/r${REPLACEMENT_CHARACTER}sum${REPLACEMENT_CHARACTER}.md" is left out of the content index: its name is not UTF-8 text (bytes 72e973756de92e6d64). Rename it to index it.`,
    ]);
    const index = await buildContentIndex({
      repositoryPath: repository,
      repositoryRevision: REVISION,
    });
    expect(
      documents(index)
        .map((node) => node.sourcePath)
        .sort(),
    ).toEqual(["README.md", `docs/${COMPOSED}`]);
    // The warning reaches LIMITATIONS like any other run warning.
    const record = { steps: [], evidenceWarnings: result.limitations } as unknown as RunRecord;
    expect(projectRunLimitOverflowLines(collectRunLimitOverflowEvidence(record))).toEqual(
      result.limitations,
    );
  });
});
