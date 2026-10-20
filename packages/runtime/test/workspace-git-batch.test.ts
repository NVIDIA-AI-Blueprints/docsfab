// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Framing tests for the single `git cat-file --batch` reader
 * (`GitBatchStdout` + `streamBatchBlob` in
 * `src/repository/workspace/materialize.ts`).
 *
 * `git cat-file --batch` emits `<oid> SP blob SP <size> LF <contents> LF` per
 * request on one stdout stream. Blob content is arbitrary bytes, including LF
 * and bytes that spell a plausible header line, so a reader that re-syncs on
 * newlines instead of consuming exactly `<size>` bytes produces silently wrong
 * files rather than an error. The fixture blobs in `workspace.test.ts` are
 * small, so nothing there crosses a stdout chunk boundary.
 *
 * Two kinds of test live here:
 *
 *   - `real git cat-file --batch framing` — integration. A real fixture
 *     repository is exported through the real `/usr/bin/git` child. Chunk
 *     boundaries are whatever the pipe produces; blobs are sized so bodies
 *     must span several reads.
 *   - `scripted git cat-file --batch framing` — the same production code path
 *     (`prepareRepositoryWorkspace` -> `streamGitBatch` -> `GitBatchStdout`
 *     -> `writeAll`), with only the `cat-file` child replaced by a stream
 *     whose chunk boundaries the test chooses byte by byte. `git ls-tree`,
 *     `git rev-parse`, the parser, the writer and the verifier are all real.
 *     Object ids and sizes come from the real fixture repository, so the
 *     synthesized stream is a faithful `--batch` transcript.
 */
import { execFile, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `chunks === null` lets every spawn through to the real binary, so the
 * integration suite below runs against real `git cat-file --batch`.
 */
const scriptedBatch = vi.hoisted(() => ({
  chunks: null as null | Buffer[],
  requests: [] as string[],
}));

const workspaceTestTemp = vi.hoisted(() => ({ directory: null as string | null }));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    tmpdir: () => workspaceTestTemp.directory ?? actual.tmpdir(),
  };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (...args: unknown[]) => {
      const invocation = args[1];
      const isBatchRead = Array.isArray(invocation) && invocation.includes("cat-file");
      if (scriptedBatch.chunks === null || !isBatchRead) {
        return Reflect.apply(actual.spawn, actual, args);
      }
      return scriptedCatFileChild(scriptedBatch.chunks, scriptedBatch.requests);
    },
  };
});

import { prepareRepositoryWorkspace } from "../src/repository/workspace/materialize.js";
import { RepositoryWorkspaceMaterializationError } from "../src/repository/workspace/contracts.js";
import { listTrackedRepositoryEntries } from "../src/repository/workspace/tracked-read.js";
import { commitFixture, git, initFixtureRepo } from "./helpers/git.js";

const execFileAsync = promisify(execFile);

/**
 * A `git cat-file --batch` child whose stdout hands back exactly one scripted
 * chunk per read. `highWaterMark: 1` keeps at most one pushed chunk buffered,
 * so `stdout.read()` — which the parser calls with no size argument — returns
 * that chunk alone instead of a coalesced buffer, so chunk boundaries are the
 * test's choice. Real `git` never splits a response header, because the
 * exporter keeps only one request in flight at a time.
 */
function scriptedCatFileChild(chunks: readonly Buffer[], requests: string[]): ChildProcess {
  let index = 0;
  const stdout = new Readable({
    highWaterMark: 1,
    read(): void {
      if (index < chunks.length) {
        this.push(Buffer.from(chunks[index]!));
        index += 1;
        return;
      }
      this.push(null);
    },
  });
  const stderr = new Readable({
    read(): void {
      this.push(null);
    },
  });

  const child = new EventEmitter() as EventEmitter & {
    exitCode: number | null;
    signalCode: string | null;
  };
  child.exitCode = null;
  child.signalCode = null;
  let closed = false;
  const finish = (code: number | null, signal: string | null): void => {
    if (closed) return;
    closed = true;
    child.exitCode = code;
    child.signalCode = signal;
    setImmediate(() => {
      child.emit("close", code, signal);
    });
  };
  const stdin = new Writable({
    write(chunk: Buffer | string, _encoding: unknown, callback: (error?: Error | null) => void) {
      requests.push(String(chunk));
      callback();
    },
    final(callback: (error?: Error | null) => void) {
      callback();
      finish(0, null);
    },
  });

  return Object.assign(child, {
    stdout,
    stderr,
    stdin,
    stdio: [stdin, stdout, stderr],
    kill: (signal?: string): boolean => {
      finish(null, signal ?? "SIGTERM");
      return true;
    },
  }) as unknown as ChildProcess;
}

beforeEach(async () => {
  workspaceTestTemp.directory = await mkdtemp(join(tmpdir(), "docsfab-batch-test-"));
});

afterEach(async () => {
  scriptedBatch.chunks = null;
  scriptedBatch.requests = [];
  const directory = workspaceTestTemp.directory;
  workspaceTestTemp.directory = null;
  if (directory !== null) await rm(directory, { recursive: true, force: true });
});

async function gitBytes(repositoryPath: string, args: string[]): Promise<Buffer> {
  const result = await execFileAsync("git", ["-C", repositoryPath, ...args], {
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
  });
  return Buffer.from(result.stdout);
}

interface FixtureFile {
  readonly path: string;
  readonly content: Buffer;
  readonly mode?: number;
}

interface BatchEntry {
  readonly path: string;
  readonly objectId: string;
  readonly size: number;
  readonly content: Buffer;
}

/**
 * Builds a real repository and returns its tracked blobs in the exact order
 * `readTrackedTree` will request them (`git ls-tree -lr --full-tree`, minus
 * the kinds the exporter never asks `cat-file` for).
 */
async function batchFixture(files: readonly FixtureFile[]): Promise<{
  repository: string;
  entries: BatchEntry[];
}> {
  const repository = await mkdtemp(join(tmpdir(), "docsfab-batch-source-"));
  await initFixtureRepo(repository);
  await git(repository, ["config", "core.autocrlf", "false"]);
  for (const file of files) {
    await writeFile(join(repository, file.path), file.content);
    if (file.mode !== undefined) await chmod(join(repository, file.path), file.mode);
  }
  await commitFixture(repository, "batch fixture");

  const listing = await git(repository, ["ls-tree", "-lr", "--full-tree", "HEAD"]);
  const entries: BatchEntry[] = [];
  for (const line of listing.split("\n").filter(Boolean)) {
    const match = /^([0-7]{6}) (blob|commit) ([0-9a-f]{40,64})\s+(\d+|-)\t(.+)$/u.exec(line);
    if (match === null) throw new Error(`Unparsed ls-tree record: ${line}`);
    if (match[1] !== "100644" && match[1] !== "100755") continue;
    const path = match[5]!;
    const source = files.find((file) => file.path === path);
    if (source === undefined) throw new Error(`Unexpected tracked path: ${path}`);
    entries.push({
      path,
      objectId: match[3]!,
      size: Number(match[4]),
      content: source.content,
    });
  }
  if (entries.length !== files.length) {
    throw new Error("Fixture tracked-entry count does not match the requested files.");
  }
  return { repository, entries };
}

interface BatchRecord {
  readonly header: string;
  readonly body: Buffer;
  readonly trailer?: Buffer;
}

function defaultRecords(entries: readonly BatchEntry[]): BatchRecord[] {
  return entries.map((entry) => ({
    header: `${entry.objectId} blob ${entry.size}`,
    body: entry.content,
  }));
}

function batchStream(records: readonly BatchRecord[]): Buffer {
  const parts: Buffer[] = [];
  for (const record of records) {
    parts.push(Buffer.from(`${record.header}\n`, "utf8"));
    parts.push(record.body);
    parts.push(record.trailer ?? Buffer.from([0x0a]));
  }
  return Buffer.concat(parts);
}

function chunkEvery(buffer: Buffer, size: number): Buffer[] {
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < buffer.byteLength; offset += size) {
    chunks.push(Buffer.from(buffer.subarray(offset, Math.min(offset + size, buffer.byteLength))));
  }
  return chunks.length === 0 ? [Buffer.from([0x0a])] : chunks;
}

function chunkAt(buffer: Buffer, cuts: readonly number[]): Buffer[] {
  const bounds = [...new Set([0, ...cuts, buffer.byteLength])]
    .filter((cut) => cut >= 0 && cut <= buffer.byteLength)
    .sort((left, right) => left - right);
  const chunks: Buffer[] = [];
  for (let index = 1; index < bounds.length; index += 1) {
    const slice = buffer.subarray(bounds[index - 1]!, bounds[index]!);
    if (slice.byteLength > 0) chunks.push(Buffer.from(slice));
  }
  return chunks;
}

function pseudoRandomBytes(seed: number, length: number): Buffer {
  const bytes = Buffer.allocUnsafe(length);
  let state = seed >>> 0;
  for (let index = 0; index < length; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    bytes[index] = (state >>> 23) & 0xff;
  }
  return bytes;
}

/**
 * Content whose bytes spell whole `cat-file --batch` header and `missing`
 * lines. A reader that re-syncs on LF instead of consuming `<size>` bytes
 * mistakes these for framing.
 */
function headerLookalikeContent(repeats: number): Buffer {
  const lines: string[] = [];
  for (let index = 0; index < repeats; index += 1) {
    lines.push(`${"0123456789abcdef".repeat(2)}${String(index).padStart(8, "0")} blob ${index}`);
    lines.push(`${"f".repeat(40)} missing`);
    lines.push("");
    lines.push(` padding ${index}`);
  }
  return Buffer.from(`${lines.join("\n")}\n`, "utf8");
}

function digestOf(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function expectBytes(actual: Buffer, expected: Buffer, label: string): void {
  if (actual.equals(expected)) return;
  let index = 0;
  while (
    index < actual.byteLength &&
    index < expected.byteLength &&
    actual[index] === expected[index]
  ) {
    index += 1;
  }
  throw new Error(
    `${label}: exported bytes differ. expected ${expected.byteLength} bytes ` +
      `(sha256 ${digestOf(expected)}), got ${actual.byteLength} bytes ` +
      `(sha256 ${digestOf(actual)}); first difference at byte ${index}.`,
  );
}

async function scratchRoots(): Promise<Set<string>> {
  return new Set(
    (await readdir(tmpdir()))
      .filter((name) => name.startsWith("docsfab-workspace-"))
      .map((name) => join(tmpdir(), name)),
  );
}

async function captureMaterializationFailure(
  operation: Promise<unknown>,
): Promise<RepositoryWorkspaceMaterializationError> {
  try {
    await operation;
  } catch (error) {
    if (error instanceof RepositoryWorkspaceMaterializationError) return error;
    throw error;
  }
  throw new Error("Expected repository workspace materialization to fail.");
}

describe("real git cat-file --batch framing", () => {
  it("exports a multi-megabyte blob byte-for-byte across many stdout reads", async () => {
    const content = pseudoRandomBytes(0x5eed_1234, 3 * 1024 * 1024 + 7919);
    const { repository, entries } = await batchFixture([
      { path: "large.bin", content },
      { path: "zz-after.txt", content: Buffer.from("follows the large blob\n") },
    ]);
    const workspace = await prepareRepositoryWorkspace(repository, "HEAD");
    try {
      expectBytes(await readFile(join(workspace.path, "large.bin")), content, "large.bin");
      // The exporter keeps reading from the same stream, so a body that
      // overruns or under-runs its size desynchronizes every later blob.
      expectBytes(
        await readFile(join(workspace.path, "zz-after.txt")),
        Buffer.from("follows the large blob\n"),
        "zz-after.txt",
      );
      expect(entries.map((entry) => entry.path)).toEqual(["large.bin", "zz-after.txt"]);
    } finally {
      await workspace.dispose();
    }
  }, 60_000);

  it("does not re-sync on newlines or header-shaped lines inside blob content", async () => {
    const lookalike = headerLookalikeContent(2_500);
    expect(lookalike.byteLength).toBeGreaterThan(128 * 1024);
    const { repository } = await batchFixture([
      { path: "a-lookalike.txt", content: lookalike },
      { path: "b-newlines.txt", content: Buffer.from("\n".repeat(200_000), "utf8") },
      { path: "c-tail.txt", content: Buffer.from("tail marker\n") },
    ]);
    const workspace = await prepareRepositoryWorkspace(repository, "HEAD");
    try {
      expectBytes(
        await readFile(join(workspace.path, "a-lookalike.txt")),
        lookalike,
        "a-lookalike.txt",
      );
      expectBytes(
        await readFile(join(workspace.path, "b-newlines.txt")),
        Buffer.from("\n".repeat(200_000), "utf8"),
        "b-newlines.txt",
      );
      expectBytes(
        await readFile(join(workspace.path, "c-tail.txt")),
        Buffer.from("tail marker\n"),
        "c-tail.txt",
      );
    } finally {
      await workspace.dispose();
    }
  }, 60_000);

  it("round-trips a binary blob with NUL and non-UTF-8 bytes exactly", async () => {
    const alphabet = Buffer.from(Array.from({ length: 256 }, (_value, index) => index));
    const invalidUtf8 = Buffer.from([
      0xff, 0xfe, 0x80, 0x81, 0xc0, 0x80, 0xed, 0xa0, 0x80, 0xf5, 0x90, 0x80, 0x80, 0x00, 0x0a,
      0x00,
    ]);
    const content = Buffer.concat([
      ...Array.from({ length: 400 }, () => alphabet),
      invalidUtf8,
      pseudoRandomBytes(0xbeef, 150_000),
    ]);
    // A lossy decode would round-trip only if the bytes were valid UTF-8.
    expect(Buffer.from(content.toString("utf8"), "utf8").equals(content)).toBe(false);

    const { repository, entries } = await batchFixture([{ path: "payload.bin", content }]);
    const fromGit = await gitBytes(repository, ["cat-file", "blob", entries[0]!.objectId]);
    expectBytes(fromGit, content, "fixture blob (git cat-file ground truth)");

    const workspace = await prepareRepositoryWorkspace(repository, "HEAD");
    try {
      const exported = await readFile(join(workspace.path, "payload.bin"));
      expectBytes(exported, fromGit, "payload.bin");
      expect(exported.byteLength).toBe(entries[0]!.size);
    } finally {
      await workspace.dispose();
    }
  }, 60_000);

  it("materializes an empty blob without consuming the next response", async () => {
    const follower = pseudoRandomBytes(0x0000_2222, 90_000);
    const { repository } = await batchFixture([
      { path: "a-empty.txt", content: Buffer.alloc(0) },
      { path: "b-follower.bin", content: follower },
      { path: "c-empty-again.txt", content: Buffer.alloc(0) },
      { path: "d-final.txt", content: Buffer.from("final\n") },
    ]);
    const workspace = await prepareRepositoryWorkspace(repository, "HEAD");
    try {
      expect((await stat(join(workspace.path, "a-empty.txt"))).size).toBe(0);
      expect((await stat(join(workspace.path, "c-empty-again.txt"))).size).toBe(0);
      expectBytes(await readFile(join(workspace.path, "b-follower.bin")), follower, "b-follower");
      expectBytes(
        await readFile(join(workspace.path, "d-final.txt")),
        Buffer.from("final\n"),
        "d-final.txt",
      );
    } finally {
      await workspace.dispose();
    }
  }, 60_000);

  it("keeps the executable bit on a multi-chunk blob and never materializes a symlink", async () => {
    const script = Buffer.concat([
      Buffer.from("#!/bin/sh\n"),
      Buffer.from(`# ${"payload ".repeat(20_000)}\n`),
      Buffer.from("exit 0\n"),
    ]);
    const { repository } = await batchFixture([
      { path: "a-script.sh", content: script, mode: 0o755 },
      { path: "b-plain.txt", content: Buffer.from("plain\n") },
    ]);
    // A symlink blob's content is its target path. Writing it as a regular
    // file and creating a symlink are very different outcomes.
    await symlink("a-script.sh", join(repository, "c-link"));
    await commitFixture(repository, "add symlink");

    const workspace = await prepareRepositoryWorkspace(repository, "HEAD");
    try {
      const exported = await readFile(join(workspace.path, "a-script.sh"));
      expectBytes(exported, script, "a-script.sh");
      expect((await stat(join(workspace.path, "a-script.sh"))).mode & 0o777).toBe(0o755);
      expect((await stat(join(workspace.path, "b-plain.txt"))).mode & 0o777).toBe(0o644);

      await expect(stat(join(workspace.path, "c-link"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      const tracked = await listTrackedRepositoryEntries(workspace);
      expect(tracked).toContainEqual({ path: "c-link", kind: "symlink" });
      expect(tracked).toContainEqual({
        path: "a-script.sh",
        kind: "regular",
        byteLength: script.byteLength,
      });
    } finally {
      await workspace.dispose();
    }
  }, 60_000);

  it("stays aligned across blobs whose sizes sweep the stdout read boundary", async () => {
    // Body lengths chosen so header + body + trailer lands on, just before,
    // and just after successive 64 KiB pipe reads: the header of the next
    // response, or the trailing LF of this one, then falls in a later chunk.
    const files: FixtureFile[] = [];
    const expected = new Map<string, Buffer>();
    const deltas = [-64, -3, -1, 0, 1, 2, 51, 4_096];
    let seed = 1;
    for (const multiple of [1, 2, 3]) {
      for (const delta of deltas) {
        const length = multiple * 65_536 + delta;
        const path = `blob-${String(files.length).padStart(3, "0")}.bin`;
        seed = (seed * 7919 + 13) >>> 0;
        const content = pseudoRandomBytes(seed, length);
        files.push({ path, content });
        expected.set(path, content);
      }
    }
    const { repository, entries } = await batchFixture(files);
    expect(entries).toHaveLength(files.length);

    const workspace = await prepareRepositoryWorkspace(repository, "HEAD");
    try {
      for (const [path, content] of expected) {
        expectBytes(await readFile(join(workspace.path, path)), content, path);
      }
    } finally {
      await workspace.dispose();
    }
  }, 120_000);
});

describe("scripted git cat-file --batch framing", () => {
  const smallFiles: FixtureFile[] = [
    { path: "a.txt", content: Buffer.from("alpha\nbravo\n") },
    { path: "b.bin", content: Buffer.from([0x00, 0x0a, 0xff, 0x0a, 0x41, 0x00]) },
    { path: "c-empty.txt", content: Buffer.alloc(0) },
    {
      path: "d-lookalike.txt",
      content: Buffer.from(`${"a".repeat(40)} blob 4\nnext\n${"b".repeat(40)} missing\n`),
    },
    { path: "e.txt", content: Buffer.from("omega\n") },
  ];

  it("reassembles every response when stdout yields one byte per read", async () => {
    const { repository, entries } = await batchFixture(smallFiles);
    scriptedBatch.chunks = chunkEvery(batchStream(defaultRecords(entries)), 1);
    const workspace = await prepareRepositoryWorkspace(repository, "HEAD");
    try {
      for (const entry of entries) {
        expectBytes(await readFile(join(workspace.path, entry.path)), entry.content, entry.path);
      }
      expect(scriptedBatch.requests).toEqual(entries.map((entry) => `${entry.objectId}\n`));
    } finally {
      await workspace.dispose();
    }
  }, 60_000);

  it("keeps framing when each response body ends exactly on a chunk boundary", async () => {
    const { repository, entries } = await batchFixture(smallFiles);
    const records = defaultRecords(entries);
    const stream = batchStream(records);
    // Cut immediately after each body (trailing LF starts the next chunk),
    // immediately after each trailer (next header starts a fresh chunk), and
    // one byte into each header (header split across reads).
    const cuts: number[] = [];
    let offset = 0;
    for (const record of records) {
      const headerLength = Buffer.byteLength(record.header, "utf8") + 1;
      cuts.push(offset + 1, offset + headerLength - 1, offset + headerLength);
      offset += headerLength + record.body.byteLength;
      cuts.push(offset, offset + 1);
      offset += 1;
    }
    scriptedBatch.chunks = chunkAt(stream, cuts);
    expect(scriptedBatch.chunks.length).toBeGreaterThan(records.length * 3);

    const workspace = await prepareRepositoryWorkspace(repository, "HEAD");
    try {
      for (const entry of entries) {
        expectBytes(await readFile(join(workspace.path, entry.path)), entry.content, entry.path);
      }
    } finally {
      await workspace.dispose();
    }
  }, 60_000);

  it("consumes exactly <size> bytes when a body carries LF and header-shaped lines", async () => {
    const lookalike = headerLookalikeContent(64);
    const { repository, entries } = await batchFixture([
      { path: "a-lookalike.txt", content: lookalike },
      { path: "b-tail.txt", content: Buffer.from("tail\n") },
    ]);
    // Seven-byte reads put a boundary inside almost every header-shaped line
    // in the body, which is where a newline-resyncing reader loses framing.
    scriptedBatch.chunks = chunkEvery(batchStream(defaultRecords(entries)), 7);
    const workspace = await prepareRepositoryWorkspace(repository, "HEAD");
    try {
      expectBytes(
        await readFile(join(workspace.path, "a-lookalike.txt")),
        lookalike,
        "a-lookalike.txt",
      );
      expectBytes(
        await readFile(join(workspace.path, "b-tail.txt")),
        Buffer.from("tail\n"),
        "b-tail.txt",
      );
    } finally {
      await workspace.dispose();
    }
  }, 60_000);

  it("writes a body at the right offsets when one read exceeds the 1 MiB copy cap", async () => {
    // 2.5 MiB in a single stdout read forces `readInto` to slice the body
    // into 1 MiB pieces, so `writeAll`'s positional offsets must advance.
    const content = pseudoRandomBytes(0xc0ffee, 2 * 1024 * 1024 + 524_288 + 13);
    const { repository, entries } = await batchFixture([
      { path: "a-huge.bin", content },
      { path: "b-tail.txt", content: Buffer.from("tail\n") },
    ]);
    const stream = batchStream(defaultRecords(entries));
    scriptedBatch.chunks = [stream];
    const workspace = await prepareRepositoryWorkspace(repository, "HEAD");
    try {
      expectBytes(await readFile(join(workspace.path, "a-huge.bin")), content, "a-huge.bin");
      expectBytes(
        await readFile(join(workspace.path, "b-tail.txt")),
        Buffer.from("tail\n"),
        "b-tail.txt",
      );
    } finally {
      await workspace.dispose();
    }
  }, 120_000);

  it("fails closed on a `<oid> missing` response instead of exporting a file", async () => {
    const { repository, entries } = await batchFixture(smallFiles);
    const records = defaultRecords(entries);
    const stream = batchStream([
      {
        header: `${entries[0]!.objectId} missing`,
        body: Buffer.alloc(0),
        trailer: Buffer.alloc(0),
      },
      ...records.slice(1),
    ]);
    scriptedBatch.chunks = chunkEvery(stream, 13);
    const before = await scratchRoots();
    const failure = await captureMaterializationFailure(
      prepareRepositoryWorkspace(repository, "HEAD"),
    );
    expect(failure.evidence).toMatchObject({
      code: "git-blob-failed",
      phase: "materialization",
    });
    expect(failure.evidence.children.reaped).toBe(failure.evidence.children.started);
    expect(await scratchRoots()).toEqual(before);
  }, 60_000);

  it("rejects a well-formed header that names a different object id", async () => {
    const { repository, entries } = await batchFixture(smallFiles);
    const records = defaultRecords(entries);
    const wrongOid = `${"0".repeat(39)}1`;
    expect(wrongOid).not.toBe(entries[0]!.objectId);
    const stream = batchStream([
      { header: `${wrongOid} blob ${entries[0]!.size}`, body: entries[0]!.content },
      ...records.slice(1),
    ]);
    scriptedBatch.chunks = chunkEvery(stream, 11);
    const before = await scratchRoots();
    const failure = await captureMaterializationFailure(
      prepareRepositoryWorkspace(repository, "HEAD"),
    );
    expect(failure.evidence).toMatchObject({
      code: "git-blob-failed",
      phase: "materialization",
    });
    expect(await scratchRoots()).toEqual(before);
  }, 60_000);

  it("rejects a header whose declared size disagrees with the tracked tree", async () => {
    const { repository, entries } = await batchFixture(smallFiles);
    const records = defaultRecords(entries);
    const target = entries[0]!;
    expect(target.size).toBeGreaterThan(0);
    // The declared size is the only corruption here: body and trailer are
    // exactly what the tracked tree expects, so nothing downstream notices.
    // Without the header size check the export would succeed silently.
    const stream = batchStream([
      { header: `${target.objectId} blob ${target.size - 1}`, body: target.content },
      ...records.slice(1),
    ]);
    scriptedBatch.chunks = chunkEvery(stream, 9);
    const before = await scratchRoots();
    const failure = await captureMaterializationFailure(
      prepareRepositoryWorkspace(repository, "HEAD"),
    );
    expect(failure.evidence).toMatchObject({
      code: "git-blob-failed",
      phase: "materialization",
    });
    expect(await scratchRoots()).toEqual(before);
  }, 60_000);

  it("rejects a response whose record separator is not the protocol newline", async () => {
    const { repository, entries } = await batchFixture(smallFiles);
    const records = defaultRecords(entries);
    const stream = batchStream([
      { ...records[0]!, trailer: Buffer.from([0x58]) },
      ...records.slice(1),
    ]);
    scriptedBatch.chunks = chunkEvery(stream, 5);
    const before = await scratchRoots();
    const failure = await captureMaterializationFailure(
      prepareRepositoryWorkspace(repository, "HEAD"),
    );
    expect(failure.evidence).toMatchObject({
      code: "git-blob-failed",
      phase: "materialization",
    });
    expect(await scratchRoots()).toEqual(before);
  }, 60_000);

  it("fails closed when stdout ends part-way through a body", async () => {
    const { repository, entries } = await batchFixture([
      { path: "a-body.bin", content: pseudoRandomBytes(0x1357, 40_000) },
      { path: "b-tail.txt", content: Buffer.from("tail\n") },
    ]);
    const stream = batchStream(defaultRecords(entries));
    scriptedBatch.chunks = [Buffer.from(stream.subarray(0, 20_000))];
    const before = await scratchRoots();
    const failure = await captureMaterializationFailure(
      prepareRepositoryWorkspace(repository, "HEAD"),
    );
    expect(failure.evidence).toMatchObject({
      code: "materialization-failed",
      phase: "materialization",
    });
    expect(failure.evidence.children.reaped).toBe(failure.evidence.children.started);
    expect(await scratchRoots()).toEqual(before);
  }, 60_000);
});
