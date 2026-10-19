// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import { Worker } from "node:worker_threads";

export type GithubPackEntryType = "commit" | "tree" | "blob" | "tag" | "ofs-delta" | "ref-delta";
export type GithubPackPreflightLimits = Readonly<{
  packInflatedMaxBytes: number;
  objectMaterializedMaxBytes: number;
  objectsMax: number;
}>;
export type GithubPackPreflightEntry = Readonly<{
  type: GithubPackEntryType;
  offset: number;
  compressedLength: number;
  inflatedLength: number;
  materializedLength: number;
}>;
export type GithubPackPreflightResult = Readonly<{
  version: 2 | 3;
  objectCount: number;
  inflatedBytes: number;
  materializedBytes: number;
  entries: readonly GithubPackPreflightEntry[];
}>;
/** deadlineAt is an absolute Unix epoch timestamp in milliseconds (Date.now() time base). */
export type GithubPackPreflightOptions = Readonly<{ signal?: AbortSignal; deadlineAt?: number }>;

export class GithubPackPreflightError extends Error {
  readonly code: string;
  readonly observed?: number;
  constructor(code: string, observed?: number) {
    super(`Git pack preflight refused: ${code}`);
    this.name = "GithubPackPreflightError";
    this.code = code;
    this.observed = observed;
  }
}

const TYPES: Readonly<Record<number, GithubPackEntryType>> = {
  1: "commit",
  2: "tree",
  3: "blob",
  4: "tag",
  6: "ofs-delta",
  7: "ref-delta",
};

function fail(code: string, observed?: number): never {
  throw new GithubPackPreflightError(code, observed);
}
function safeBudget(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) fail("invalid-limit");
}
function checkActive(signal?: AbortSignal, deadlineAt?: number): void {
  if (signal?.aborted) fail("cancelled");
  if (deadlineAt !== undefined && (!Number.isFinite(deadlineAt) || Date.now() >= deadlineAt))
    fail("deadline");
}
function readPackVarint(bytes: Buffer, cursor: { value: number }): number {
  let result = 0;
  let shift = 0;
  for (;;) {
    if (cursor.value >= bytes.length) fail("truncated-delta-varint");
    const b = bytes[cursor.value++]!;
    const part = b & 0x7f;
    if (shift >= 53 || part > Math.floor(Number.MAX_SAFE_INTEGER / 2 ** shift))
      fail("overflow-delta-varint");
    result += part * 2 ** shift;
    if (!Number.isSafeInteger(result)) fail("overflow-delta-varint");
    if ((b & 0x80) === 0) return result;
    shift += 7;
  }
}

/** Core runs in an isolated worker so synchronous inflate cannot starve cancellation/deadline timers. */
export function preflightGithubPackSync(
  packBytes: Uint8Array,
  limits: GithubPackPreflightLimits,
): GithubPackPreflightResult {
  const pack = Buffer.from(packBytes.buffer, packBytes.byteOffset, packBytes.byteLength);
  safeBudget(limits.packInflatedMaxBytes);
  safeBudget(limits.objectMaterializedMaxBytes);
  safeBudget(limits.objectsMax);
  if (pack.length < 32 || pack.toString("ascii", 0, 4) !== "PACK") fail("truncated-pack");
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) fail("unsupported-version");
  const count = pack.readUInt32BE(8);
  if (count > limits.objectsMax) fail("object-count-limit", count);
  const bodyEnd = pack.length - 20;
  const checksum = createHash("sha1").update(pack.subarray(0, bodyEnd)).digest();
  if (!checksum.equals(pack.subarray(bodyEnd))) fail("checksum-mismatch");
  let pos = 12;
  let inflatedBytes = 0;
  let materializedBytes = 0;
  const entries: GithubPackPreflightEntry[] = [];
  for (let i = 0; i < count; i++) {
    const offset = pos;
    if (pos >= bodyEnd) fail("truncated-entry-header");
    let first = pack[pos++]!;
    const type = TYPES[(first >>> 4) & 7];
    if (!type) fail("invalid-entry-type");
    let declared = first & 0x0f;
    let shift = 4;
    while ((first & 0x80) !== 0) {
      if (pos >= bodyEnd || shift >= 53) fail("invalid-entry-size");
      first = pack[pos++]!;
      const part = first & 0x7f;
      if (part > Math.floor(Number.MAX_SAFE_INTEGER / 2 ** shift)) fail("invalid-entry-size");
      declared += part * 2 ** shift;
      if (!Number.isSafeInteger(declared)) fail("invalid-entry-size");
      shift += 7;
    }
    if (type === "ofs-delta") {
      if (pos >= bodyEnd) fail("truncated-ofs-base");
      let byte = pack[pos++]!;
      let distance = byte & 0x7f;
      while ((byte & 0x80) !== 0) {
        if (pos >= bodyEnd || distance > Math.floor(Number.MAX_SAFE_INTEGER / 128) - 1)
          fail("invalid-ofs-base");
        byte = pack[pos++]!;
        distance = (distance + 1) * 128 + (byte & 0x7f);
      }
      if (!Number.isSafeInteger(distance) || distance <= 0 || distance > offset - 12)
        fail("invalid-ofs-base");
    } else if (type === "ref-delta") {
      if (pos + 20 > bodyEnd) fail("truncated-ref-base");
      pos += 20;
    }
    if (declared > limits.packInflatedMaxBytes - inflatedBytes)
      fail("inflated-byte-limit", inflatedBytes + declared);
    if (
      declared > limits.objectMaterializedMaxBytes - materializedBytes &&
      type !== "ofs-delta" &&
      type !== "ref-delta"
    )
      fail("materialized-byte-limit", materializedBytes + declared);
    const compressedStart = pos;
    let output: Buffer;
    try {
      const result = inflateSync(pack.subarray(compressedStart, bodyEnd), {
        maxOutputLength: Math.max(
          1,
          Math.min(declared + 1, limits.packInflatedMaxBytes - inflatedBytes + 1),
        ),
        info: true,
      }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
      output = result.buffer;
      pos += result.engine.bytesWritten;
    } catch {
      fail("invalid-or-oversized-zlib");
    }
    if (output.byteLength !== declared) fail("entry-size-mismatch");
    inflatedBytes += output.byteLength;
    let materializedLength = declared;
    if (type === "ofs-delta" || type === "ref-delta") {
      const cursor = { value: 0 };
      readPackVarint(output, cursor); // Delta base size.
      materializedLength = readPackVarint(output, cursor); // Reconstructed target size.
    }
    if (materializedLength > limits.objectMaterializedMaxBytes - materializedBytes)
      fail("materialized-byte-limit", materializedBytes + materializedLength);
    materializedBytes += materializedLength;
    entries.push(
      Object.freeze({
        type,
        offset,
        compressedLength: pos - compressedStart,
        inflatedLength: declared,
        materializedLength,
      }),
    );
  }
  if (pos !== bodyEnd) fail(pos < bodyEnd ? "trailing-pack-data" : "pack-boundary-overrun");
  return Object.freeze({
    version,
    objectCount: count,
    inflatedBytes,
    materializedBytes,
    entries: Object.freeze(entries),
  });
}

export async function preflightGithubPack(
  pack: Uint8Array,
  limits: GithubPackPreflightLimits,
  options: GithubPackPreflightOptions = {},
): Promise<GithubPackPreflightResult> {
  checkActive(options.signal, options.deadlineAt);
  safeBudget(limits.packInflatedMaxBytes);
  safeBudget(limits.objectMaterializedMaxBytes);
  safeBudget(limits.objectsMax);
  const copy = Uint8Array.from(pack);
  const workerPath = import.meta.url.endsWith(".ts")
    ? "./github-pr-pack-worker.ts"
    : "./github-pr-pack-worker.js";
  const worker = new Worker(new URL(workerPath, import.meta.url), {
    workerData: { pack: copy, limits },
    transferList: [copy.buffer],
    execArgv: process.execArgv.filter((arg) => !arg.startsWith("--input-type")),
  });
  return await new Promise((resolve, reject) => {
    let settled = false;
    const finish = async (error?: Error, result?: GithubPackPreflightResult) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", onAbort);
      clearTimeout(timer);
      await worker.terminate();
      if (error) reject(error);
      else resolve(result!);
    };
    const onAbort = () => {
      void finish(new GithubPackPreflightError("cancelled"));
    };
    const remaining =
      options.deadlineAt === undefined ? undefined : options.deadlineAt - Date.now();
    const timer =
      remaining === undefined
        ? undefined
        : setTimeout(
            () => {
              void finish(new GithubPackPreflightError("deadline"));
            },
            Math.max(0, remaining),
          );
    options.signal?.addEventListener("abort", onAbort, { once: true });
    worker.once(
      "message",
      (message: {
        ok: boolean;
        result?: GithubPackPreflightResult;
        code?: string;
        observed?: number;
      }) => {
        if (message.ok && message.result) void finish(undefined, message.result);
        else
          void finish(
            new GithubPackPreflightError(message.code ?? "worker-failed", message.observed),
          );
      },
    );
    worker.once("error", () => {
      void finish(new GithubPackPreflightError("worker-failed"));
    });
    worker.once("exit", (code) => {
      if (!settled && code !== 0) void finish(new GithubPackPreflightError("worker-failed"));
    });
  });
}
