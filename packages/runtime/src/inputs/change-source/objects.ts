// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Raw Git object reads for change sources: batch reads, re-hashing, and commit
 * header parsing, shared by every kind that pins objects in a local object
 * database. Nothing here spawns git: each read goes through the caller's
 * runner, which already applies the trusted runner and its hardening.
 */
import { createHash } from "node:crypto";

import { failChangeSource, type ChangeSourceObjectFormat } from "../change-source.js";
import { isGitFullObjectId } from "./revision.js";

/** One git read; `input` feeds stdin. Production runs the trusted runner. */
export type ChangeSourceGitRunner = (
  args: readonly string[],
  options?: { readonly input?: Buffer },
) => Promise<Buffer>;

/** What a raw-object read needs from its caller's repository context. */
export interface RawObjectReader {
  readonly run: ChangeSourceGitRunner;
  readonly objectFormat: ChangeSourceObjectFormat;
  readonly shallow: boolean;
}

export interface RawObject {
  readonly id: string;
  readonly type: string;
  readonly body: Buffer;
}

export interface ParsedCommit {
  readonly tree: string;
  readonly parents: readonly string[];
  readonly subject: string;
}

/**
 * Wrap the one residual failure class: the trusted runner's own uncoded
 * errors (non-zero exit, timeout, output bound, spawn). Coded refusals raised
 * above it pass through unchanged.
 */
export async function gitOrFail(run: () => Promise<Buffer>): Promise<Buffer> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    return failChangeSource("change-source-git-failed");
  }
}

export function lines(output: Buffer): string[] {
  return output
    .toString("utf8")
    .split("\n")
    .filter((line) => line.length > 0);
}

export function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    // Only the decoder runs here, so the one failure it can raise is invalid UTF-8.
    return failChangeSource("change-source-encoding-unsupported");
  }
}

/** Parse `cat-file --batch` output; a `missing` line yields no entry. */
export function parseBatch(output: Buffer): Map<string, RawObject> {
  const objects = new Map<string, RawObject>();
  let offset = 0;
  while (offset < output.length) {
    const end = output.indexOf(0x0a, offset);
    if (end < 0) break;
    const header = output.subarray(offset, end).toString("utf8").split(" ");
    offset = end + 1;
    if (header[1] === "missing" || header.length !== 3) continue;
    const size = Number(header[2]);
    if (!Number.isSafeInteger(size) || size < 0 || offset + size > output.length) {
      failChangeSource("change-source-git-failed");
    }
    objects.set(header[0]!, {
      id: header[0]!,
      type: header[1]!,
      body: output.subarray(offset, offset + size),
    });
    // Each object is followed by one newline.
    offset += size + 1;
  }
  return objects;
}

/** Parse `cat-file --batch-check` output; a `missing` line yields no entry. */
export function parseBatchCheck(output: Buffer): Map<string, { type: string; size: number }> {
  const objects = new Map<string, { type: string; size: number }>();
  for (const line of lines(output)) {
    const [id, type, size] = line.split(" ");
    if (id === undefined || type === undefined || type === "missing") continue;
    objects.set(id, { type, size: Number(size) });
  }
  return objects;
}

/** The id git names an object by: a hash of its type, byte length, a NUL, then its bytes. */
export function objectId(format: ChangeSourceObjectFormat, type: string, body: Buffer): string {
  return createHash(format === "sha256" ? "sha256" : "sha1")
    .update(`${type} ${body.length}\0`, "latin1")
    .update(body)
    .digest("hex");
}

/** Tree, parents, and subject from raw commit bytes; never the commit-graph or `^{tree}`. */
export function parseCommit(body: Buffer): ParsedCommit {
  const separator = body.indexOf("\n\n");
  const headerEnd = separator < 0 ? body.length : separator;
  const headers = body.subarray(0, headerEnd).toString("latin1").split("\n");
  let tree: string | undefined;
  const parents: string[] = [];
  for (const header of headers) {
    if (header.startsWith("tree ")) tree ??= header.slice("tree ".length);
    else if (header.startsWith("parent ")) parents.push(header.slice("parent ".length));
  }
  if (tree === undefined || !isGitFullObjectId(tree) || !parents.every(isGitFullObjectId)) {
    failChangeSource("change-source-revision-unresolved");
  }
  const message = separator < 0 ? Buffer.alloc(0) : body.subarray(separator + "\n\n".length);
  const firstLine = message.indexOf(0x0a);
  const subject = decodeUtf8(firstLine < 0 ? message : message.subarray(0, firstLine));
  return { tree, parents, subject };
}

/** The refusal for an object this checkout does not hold. */
export function missingObject(shallow: boolean): never {
  return failChangeSource(
    shallow ? "change-source-history-unavailable" : "change-source-revision-unresolved",
  );
}

export async function readObjects(
  reader: RawObjectReader,
  ids: readonly string[],
): Promise<Map<string, RawObject>> {
  if (ids.length === 0) return new Map();
  return parseBatch(
    await gitOrFail(() =>
      reader.run(["cat-file", "--batch"], { input: Buffer.from(`${ids.join("\n")}\n`, "latin1") }),
    ),
  );
}

/** Ids from `ids` that this checkout holds. */
export async function presentIn(
  reader: RawObjectReader,
  ids: readonly string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  return new Set(
    parseBatchCheck(
      await gitOrFail(() =>
        reader.run(["cat-file", "--batch-check"], {
          input: Buffer.from(`${ids.join("\n")}\n`, "latin1"),
        }),
      ),
    ).keys(),
  );
}

/** Re-hash one object from its raw bytes and refuse a mismatch, naming its role. */
export function verified(
  reader: RawObjectReader,
  objects: ReadonlyMap<string, RawObject>,
  id: string,
  type: "commit" | "tree" | "tag",
  role: string,
): RawObject {
  const object = objects.get(id);
  // A shallow clone can lack commits past its boundary, never the trees of
  // the commits it holds, so only a missing commit can be missing history. A
  // tag reaches here only because a resolved ref named it, so its absence is
  // a damaged object database, as for a tree.
  if (object === undefined) {
    return type === "commit"
      ? missingObject(reader.shallow)
      : failChangeSource("change-source-git-failed");
  }
  if (object.type !== type) return failChangeSource("change-source-revision-unresolved");
  if (objectId(reader.objectFormat, object.type, object.body) !== id) {
    return failChangeSource("change-source-integrity-mismatch", role);
  }
  return object;
}

/**
 * The raw parents of each commit in `ids`, re-hashed and in first-seen order
 * without repeats: the parents git records, not the ones a shallow boundary
 * lets it walk.
 */
export async function rawParents(
  reader: RawObjectReader,
  ids: readonly string[],
  role: string,
): Promise<string[]> {
  const objects = await readObjects(reader, ids);
  return [
    ...new Set(
      ids.flatMap((id) => parseCommit(verified(reader, objects, id, "commit", role).body).parents),
    ),
  ];
}
