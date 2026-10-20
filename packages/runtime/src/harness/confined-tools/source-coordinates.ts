// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFile, realpath, stat } from "node:fs/promises";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  addObservedLines,
  snapshotObservedLines,
  type ObservedSourceLinesV1,
} from "../../repository/source-citation.js";
import { isRecord } from "../../shared/primitives.js";
import {
  confinedPathForm,
  fileIdentity,
  nearestExistingAncestor,
  type FileConfinement,
} from "./file-confinement.js";

type AnyToolDefinition = ToolDefinition<any, any, any>;

/** Prefix physical LF-delimited source lines without decoding or changing source bytes. */
export function renderSourceCoordinates(source: Buffer): Buffer {
  if (source.length === 0) return source;
  const chunks: Buffer[] = [];
  let start = 0;
  let line = 1;
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== 0x0a) continue;
    chunks.push(Buffer.from(`[source-line ${line}] `), source.subarray(start, index + 1));
    start = index + 1;
    line += 1;
  }
  if (start < source.length) {
    chunks.push(Buffer.from(`[source-line ${line}] `), source.subarray(start));
  }
  return Buffer.concat(chunks);
}

/** The display-only coordinate a rendered read line starts with. */
export const SOURCE_LINE_MARKER = /^\[source-line ([1-9][0-9]*)\] /u;

export interface ReviewReadObservation {
  readonly path: string;
  readonly rawSha256: string;
  readonly rawBase64: string;
  /** Only complete coordinate rows delivered by the outermost read wrapper. */
  readonly lines: readonly { readonly line: number; readonly textSha256: string }[];
}

export interface ReviewReadObservationSnapshot {
  readonly unavailable: boolean;
  readonly invalidPaths: readonly string[];
  readonly files: readonly ReviewReadObservation[];
}

interface ReviewReadSlot {
  raw?: Buffer;
  path?: string;
  conflict?: boolean;
}

/** Per-call raw bytes are observed at Pi's registered readFile operation. */
export class ReviewReadCapture {
  private readonly calls = new AsyncLocalStorage<ReviewReadSlot>();
  private readonly files = new Map<
    string,
    { raw: Buffer; digest: string; lines: Map<number, string> }
  >();
  private readonly invalidPaths = new Set<string>();
  private unavailable = false;

  public constructor(
    private readonly confinement: FileConfinement,
    private readonly maxObjectBytes: number,
  ) {}

  public captureRaw(target: string, raw: Buffer): void {
    const slot = this.calls.getStore();
    if (!slot) return;
    const key = relative(this.confinement.workspaceRoot, target).split(sep).join("/");
    if (!key || key.startsWith("../") || isAbsolute(key)) return;
    if (slot.raw && (!slot.raw.equals(raw) || slot.path !== key)) slot.conflict = true;
    else {
      slot.raw = raw;
      slot.path = key;
    }
  }

  public observe<T extends AnyToolDefinition>(definition: T): T {
    const execute = definition.execute.bind(definition) as (...arguments_: any[]) => Promise<any>;
    return {
      ...definition,
      execute: (...arguments_: any[]) =>
        this.calls.run({}, async () => {
          const result = await execute(...arguments_);
          this.record(this.calls.getStore()!, arguments_[1], result);
          return result;
        }),
    };
  }

  private record(slot: ReviewReadSlot, parameters: unknown, result: unknown): void {
    if (this.unavailable || !slot.raw || !slot.path || !isRecord(parameters)) return;
    if (typeof parameters.path !== "string" || confinedPathForm(parameters.path) !== slot.path)
      return;
    if (slot.conflict) {
      this.files.delete(slot.path);
      this.invalidPaths.add(slot.path);
      return;
    }
    if (this.invalidPaths.has(slot.path)) return;
    const digest = createHash("sha256").update(slot.raw).digest("hex");
    const prior = this.files.get(slot.path);
    if (prior && prior.digest !== digest) {
      this.files.delete(slot.path);
      this.invalidPaths.add(slot.path);
      return;
    }
    let rawText: string;
    try {
      rawText = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(slot.raw);
    } catch {
      this.invalidPaths.add(slot.path);
      this.files.delete(slot.path);
      return;
    }
    const expected =
      renderSourceCoordinates(slot.raw)
        .toString("utf8")
        .match(/[^\n]*(?:\n|$)/gu) ?? [];
    const normalized = rawText.split("\n");
    if (normalized.at(-1) === "") normalized.pop();
    const content = isRecord(result) && Array.isArray(result.content) ? result.content : [];
    const lines = new Map(prior?.lines);
    for (const block of content) {
      if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") continue;
      for (const row of block.text.match(/[^\n]*(?:\n|$)/gu) ?? []) {
        const marker = SOURCE_LINE_MARKER.exec(row);
        if (!marker) continue;
        const line = Number(marker[1]);
        if (!Number.isSafeInteger(line) || line < 1 || row !== expected[line - 1]) continue;
        const part = normalized[line - 1];
        if (part === undefined) continue;
        const text = part.endsWith("\r") ? part.slice(0, -1) : part;
        lines.set(line, createHash("sha256").update(text).digest("hex"));
      }
    }
    if (lines.size === 0) return;
    const next = { raw: prior?.raw ?? slot.raw, digest, lines };
    const projected = [...this.files.entries()]
      .filter(([path]) => path !== slot.path)
      .map(([path, file]) => this.serialize(path, file));
    projected.push(this.serialize(slot.path, next));
    // Charge the base64 bytes and all per-line metadata at capture time, before
    // this call's raw buffer enters attempt state. The final sealed envelope
    // carries additional identity, and is checked again before putRecord.
    if (Buffer.byteLength(JSON.stringify({ files: projected })) > this.maxObjectBytes) {
      this.files.clear();
      this.unavailable = true;
      return;
    }
    this.files.set(slot.path, next);
  }

  private serialize(
    path: string,
    file: { raw: Buffer; digest: string; lines: Map<number, string> },
  ): ReviewReadObservation {
    return {
      path,
      rawSha256: file.digest,
      rawBase64: file.raw.toString("base64"),
      lines: [...file.lines.entries()]
        .sort(([left], [right]) => left - right)
        .map(([line, textSha256]) => ({ line, textSha256 })),
    };
  }

  public snapshot(): ReviewReadObservationSnapshot {
    return {
      unavailable: this.unavailable,
      invalidPaths: [...this.invalidPaths].sort(),
      files: [...this.files.entries()]
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([path, file]) => this.serialize(path, file)),
    };
  }

  public dispose(): void {
    this.files.clear();
    this.invalidPaths.clear();
  }
}

/**
 * The lines each `read` call showed the model, per repository-relative path,
 * numbered as the citation leaf numbers them (`physicalLines`).
 *
 * Reads only: a coordinate is trusted only where it is the host prefix of a
 * whole line. The model-visible text is split on LF alone, a marker counts only
 * at the start of a segment, and line N counts only when the rest of that
 * segment is exactly line N of the file. A line the output cap cut, a marker
 * inside file text (after a CR or U+2028), and a notice therefore never count.
 * A file is marked mutated before an edit or write changes its bytes, and a
 * read recorded after that never counts: the host mints quotes from the
 * original revision. Marks and reads both key the file's identity, its
 * canonical path within the workspace and its device and inode, so another
 * spelling of the same file (a case variant on a case-insensitive filesystem,
 * a hard link) cannot escape the mark. Any fault while observing records
 * nothing.
 */
export class SourceLineLedger {
  private readonly lines = new Map<string, [number, number][]>();
  private readonly mutatedPaths = new Set<string>();
  private readonly mutatedFiles = new Set<string>();

  public constructor(private readonly confinement: FileConfinement) {}

  public snapshot(): ObservedSourceLinesV1 {
    return snapshotObservedLines(this.lines);
  }

  /**
   * Mark the file a confined write target names, before its bytes change: its
   * canonical path (the realpath of its nearest existing ancestor, plus the
   * segments still to be created) and, when it exists, its device and inode.
   * A fault here fails the write before it runs and marks nothing.
   */
  public async markMutated(target: string): Promise<void> {
    const ancestor = await nearestExistingAncestor(target);
    const key = this.repositoryKey(join(await realpath(ancestor), relative(ancestor, target)));
    const identity = ancestor === target ? fileIdentity(await stat(target)) : undefined;
    if (key) this.mutatedPaths.add(key);
    if (identity) this.mutatedFiles.add(identity);
  }

  public observe<T extends AnyToolDefinition>(definition: T): T {
    const execute = definition.execute.bind(definition) as (...arguments_: any[]) => Promise<any>;
    return {
      ...definition,
      execute: async (...arguments_: any[]) => {
        const result = await execute(...arguments_);
        await this.record(arguments_[1], result);
        return result;
      },
    };
  }

  private isMutated(key: string, identity: string): boolean {
    return this.mutatedPaths.has(key) || this.mutatedFiles.has(identity);
  }

  private repositoryKey(target: string): string | undefined {
    const key = relative(this.confinement.workspaceRoot, target);
    if (!key || key.startsWith("..") || isAbsolute(key)) return undefined;
    return key.split(sep).join("/");
  }

  private async record(parameters: unknown, result: unknown): Promise<void> {
    try {
      if (!isRecord(parameters) || typeof parameters.path !== "string") return;
      // The model's spelling, judged as the read judged it: the file Pi opened.
      const lexical = this.repositoryKey(
        resolve(this.confinement.workspaceRoot, confinedPathForm(parameters.path)),
      );
      const target = await this.confinement.resolveInput(parameters.path, "read");
      const key = this.repositoryKey(target);
      // A path read through an alias is not the path a citation names.
      if (!key || key !== lexical) return;
      // One check suffices: a read can show changed bytes only after a write,
      // and every write awaits its mark first. A write landing after this check
      // changed nothing the read showed; the line comparison below keeps only
      // lines whose text still equals what was shown.
      const identity = fileIdentity(await stat(target));
      if (this.isMutated(key, identity)) return;
      const text = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(await readFile(target));
      const fileLines = text === "" ? [] : text.split("\n");
      const content = isRecord(result) && Array.isArray(result.content) ? result.content : [];
      const shown: number[] = [];
      for (const block of content) {
        if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") continue;
        for (const segment of block.text.split("\n")) {
          const marker = SOURCE_LINE_MARKER.exec(segment);
          if (!marker) continue;
          const line = Number(marker[1]);
          if (line <= fileLines.length && segment.slice(marker[0].length) === fileLines[line - 1])
            shown.push(line);
        }
      }
      // The empty line after a final LF has no prefix to show; a read that
      // showed the last line before it showed the whole end of the file.
      if (text.endsWith("\n") && shown.includes(fileLines.length - 1)) shown.push(fileLines.length);
      for (const line of shown) addObservedLines(this.lines, key, line, line);
    } catch {
      // Condition: the file cannot be re-read or decoded as the exact text the
      // read rendered. Nothing is recorded, so a citation of it is refused as
      // unobserved; the read result itself is already delivered unchanged.
      return;
    }
  }
}
