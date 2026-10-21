// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Private pinned-source capability and selected-attempt read/proposal ledger. */
import { createHash, randomUUID } from "node:crypto";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { DurableArtifactStore } from "../../artifacts/store.js";
import { limit, refuseLimit } from "../../config/limits.js";
import { SOURCE_LIST_MAX_ENTRIES_LIMIT } from "../../config/source-read-limits.js";
import { decodeChangeSourceV1, type ChangeSourceV1 } from "../../inputs/change-source.js";
import type { ReviewDeliverySnapshotReferenceV1 } from "../../records/review-delivery-snapshot-reference.js";
import { readSourceSnapshotParts } from "../../review-delivery/source-snapshot-store.js";
import { CredentialBoundaryError } from "../../security/credential-isolation.js";
import { findConfiguredCredential } from "../../security/configured-credentials.js";
import { isRecord } from "../../shared/primitives.js";
import { SOURCE_LIST_MAX_ENTRIES } from "../source-tools.js";
import type { ReviewReadObservationSnapshot } from "./source-coordinates.js";

type AnyToolDefinition = ToolDefinition<any, any, any>;
export const REVIEW_CHANGE_READ_TOOL_NAME = "docsfab_read_review_change_side";
export const REVIEW_CHANGE_SELECT_TOOL_NAME = "docsfab_select_review_anchor";
export const REVIEW_CHANGE_PROPOSAL_ACK = "Review anchor proposal recorded for this attempt.";
export type ReviewChangeSide = "before" | "after";

interface PinnedSide {
  readonly fileOrdinal: number;
  readonly side: ReviewChangeSide;
  readonly oldPath: string | null;
  readonly newPath: string | null;
  readonly blob: string;
  readonly rawSha256: string;
  readonly lines: readonly string[];
  /** Exact source bytes per physical line, including its LF where present. */
  readonly lineBytes: readonly Uint8Array[];
}

export interface ReviewChangeFileAvailability {
  readonly fileOrdinal: number;
  readonly oldPath: string | null;
  readonly newPath: string | null;
  readonly beforeAvailable: boolean;
  readonly afterAvailable: boolean;
}

/** Live host object; a serialized lookalike never reaches this field. */
export interface ReviewChangeSource {
  readonly reference: ReviewDeliverySnapshotReferenceV1;
  /** File order and availability come from the verified retained snapshot. */
  listFiles(): readonly ReviewChangeFileAvailability[];
  readSide(fileOrdinal: number, side: ReviewChangeSide): PinnedSide | undefined;
}

const sha256 = (value: Uint8Array | string): string =>
  createHash("sha256").update(value).digest("hex");

function physicalLines(raw: Uint8Array): { lines: string[]; lineBytes: Uint8Array[] } | undefined {
  if (raw.byteLength === 0 || Buffer.from(raw).includes(0)) return undefined;
  try {
    const lines = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
      .decode(raw)
      .split("\n");
    if (lines.at(-1) === "") lines.pop();
    const lineBytes: Uint8Array[] = [];
    let start = 0;
    for (let index = 0; index < raw.byteLength; index += 1) {
      if (raw[index] !== 0x0a) continue;
      lineBytes.push(raw.slice(start, index + 1));
      start = index + 1;
    }
    if (start < raw.byteLength) lineBytes.push(raw.slice(start));
    if (lines.length !== lineBytes.length) return undefined;
    return { lines, lineBytes };
  } catch {
    return undefined;
  }
}

/** Open the retained graph before model work and verify every present native blob. */
export async function createReviewChangeSource(input: {
  readonly artifacts: DurableArtifactStore;
  readonly reference: ReviewDeliverySnapshotReferenceV1;
  readonly source: ChangeSourceV1;
}): Promise<ReviewChangeSource> {
  const { reference, source } = input;
  const parts = await readSourceSnapshotParts(input.artifacts, reference.rootObjectSha256);
  const root = parts.root;
  const manifest = decodeChangeSourceV1(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(parts.manifestBytes)),
  );
  if (
    root.runId !== reference.runId ||
    root.sourceSha256 !== reference.changeSourceSha256 ||
    root.repositoryIdentitySha256 !== reference.repositoryIdentitySha256 ||
    root.reviewedHeadSha !== reference.reviewedHeadSha ||
    root.snapshotSha256 !== reference.snapshotSha256 ||
    source.changeSourceSha256 !== root.sourceSha256 ||
    manifest.changeSourceSha256 !== root.sourceSha256 ||
    source.revision.repository.identitySha256 !== root.repositoryIdentitySha256 ||
    source.revision.head !== root.reviewedHeadSha ||
    source.files.length !== root.states.length ||
    manifest.files.length !== source.files.length
  )
    throw new Error("Pinned review source binding differs from retained source.");
  const sides = new Map<string, PinnedSide>();
  for (const [fileOrdinal, file] of source.files.entries()) {
    if (JSON.stringify(file) !== JSON.stringify(manifest.files[fileOrdinal])) {
      throw new Error("Pinned review source path pair differs from retained manifest.");
    }
    for (const side of ["before", "after"] as const) {
      const sideIndex = fileOrdinal * 2 + (side === "after" ? 1 : 0);
      const index = root.sideBlobIndices[sideIndex];
      if (index === null || index === undefined) continue;
      const declared = root.blobs[index];
      const raw = parts.blobBytes[index];
      const blob = side === "before" ? file.oldBlob : file.newBlob;
      const path = side === "before" ? file.oldPath : file.newPath;
      if (!declared || !raw || !blob || !path || declared.objectId !== blob) {
        throw new Error("Pinned review side path or blob differs from retained source.");
      }
      const nativeBlob = createHash(source.objectFormat)
        .update(`blob ${raw.byteLength}\0`)
        .update(raw)
        .digest("hex");
      if (nativeBlob !== blob || sha256(raw) !== declared.rawSha256) {
        throw new Error("Pinned review side native blob digest differs from retained source.");
      }
      const physical = physicalLines(raw);
      if (physical && root.states[fileOrdinal] === "complete" && !file.diffOmitted) {
        sides.set(`${fileOrdinal}:${side}`, {
          fileOrdinal,
          side,
          oldPath: file.oldPath,
          newPath: file.newPath,
          blob,
          rawSha256: declared.rawSha256,
          ...physical,
        });
      }
    }
  }
  const files = source.files.map((file, fileOrdinal) => ({
    fileOrdinal,
    oldPath: file.oldPath,
    newPath: file.newPath,
    beforeAvailable: sides.has(`${fileOrdinal}:before`),
    afterAvailable: sides.has(`${fileOrdinal}:after`),
  }));
  return {
    reference,
    listFiles: () => files,
    readSide: (ordinal, side) => sides.get(`${ordinal}:${side}`),
  };
}

interface RangeRequest {
  readonly fileOrdinal: number;
  readonly side: ReviewChangeSide;
  readonly startLine: number;
  readonly endLine: number;
}
function rangeRequest(value: unknown): RangeRequest {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(",") !== "endLine,fileOrdinal,side,startLine" ||
    !Number.isSafeInteger(value.fileOrdinal) ||
    (value.fileOrdinal as number) < 0 ||
    (value.side !== "before" && value.side !== "after") ||
    !Number.isSafeInteger(value.startLine) ||
    (value.startLine as number) < 1 ||
    !Number.isSafeInteger(value.endLine) ||
    (value.endLine as number) < (value.startLine as number)
  ) {
    throw new Error("Pinned review side range arguments must be complete and valid.");
  }
  return value as unknown as RangeRequest;
}

interface InventoryRequest {
  readonly fromFileOrdinal: number;
  readonly maxFiles: number;
}
function inventoryRequest(value: unknown, fileCount: number): InventoryRequest {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => key !== "fromFileOrdinal" && key !== "maxFiles") ||
    (value.fromFileOrdinal !== undefined &&
      (!Number.isSafeInteger(value.fromFileOrdinal) ||
        (value.fromFileOrdinal as number) < 0 ||
        (value.fromFileOrdinal as number) > fileCount)) ||
    (value.maxFiles !== undefined &&
      (!Number.isSafeInteger(value.maxFiles) || (value.maxFiles as number) < 1))
  ) {
    throw new Error(
      "Pinned review side inventory cursor or page size is outside the declared range.",
    );
  }
  if (value.maxFiles !== undefined && (value.maxFiles as number) > SOURCE_LIST_MAX_ENTRIES)
    refuseLimit(limit(SOURCE_LIST_MAX_ENTRIES_LIMIT), value.maxFiles as number);
  return {
    fromFileOrdinal: (value.fromFileOrdinal as number | undefined) ?? 0,
    // Share the sealed source inventory's existing page default and ceiling.
    maxFiles: (value.maxFiles as number | undefined) ?? SOURCE_LIST_MAX_ENTRIES,
  };
}

export interface ReviewChangeDeliveredRange {
  readonly fileOrdinal: number;
  readonly side: ReviewChangeSide;
  readonly oldPath: string | null;
  readonly newPath: string | null;
  readonly blob: string;
  readonly rawSha256: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly rangeSha256: string;
}
export interface ReviewChangeProposal extends ReviewChangeDeliveredRange {
  readonly originalIssueId: string;
}
export interface ReviewChangeObservation {
  readonly runId: string;
  readonly stepId: string;
  readonly attemptId: string;
  readonly sourceReference: ReviewDeliverySnapshotReferenceV1;
  readonly delivered: readonly ReviewChangeDeliveredRange[];
  readonly proposals: readonly ReviewChangeProposal[];
  readonly conflictingIssueIds: readonly string[];
  readonly unavailable: boolean;
}
interface PendingRead {
  readonly side: PinnedSide;
  readonly range: RangeRequest;
  readonly rendered: string;
}

function rangeDigest(side: PinnedSide, range: RangeRequest): string {
  return sha256(Buffer.concat(side.lineBytes.slice(range.startLine - 1, range.endLine)));
}

/** Captures only an exact whole tool result after screen, cap and read-evidence. */
export class ReviewChangeCapture {
  private readonly pending = new Map<string, PendingRead>();
  private readonly seenCallIds = new Set<string>();
  private readonly delivered = new Map<string, ReviewChangeDeliveredRange>();
  private readonly proposals = new Map<string, ReviewChangeProposal>();
  private readonly conflicts = new Set<string>();
  private readonly attemptId = randomUUID();
  private unavailable = false;

  public constructor(
    private readonly source: ReviewChangeSource,
    private readonly runId: string,
    private readonly stepId: string,
    private readonly maxObjectBytes: number,
    private readonly workspaceReads?: () => ReviewReadObservationSnapshot | undefined,
  ) {
    if (source.reference.runId !== runId)
      throw new Error("Pinned review source belongs to a different run identity.");
  }

  private projectedBytes(
    delivered: ReadonlyMap<string, ReviewChangeDeliveredRange>,
    proposals: ReadonlyMap<string, ReviewChangeProposal>,
  ): number {
    return Buffer.byteLength(
      JSON.stringify({
        runId: this.runId,
        stepId: this.stepId,
        attemptId: this.attemptId,
        sourceReference: this.source.reference,
        delivered: [...delivered.values()],
        proposals: [...proposals.values()],
        conflictingIssueIds: [...this.conflicts],
        unavailable: this.unavailable,
      }),
    );
  }

  public readTool(): AnyToolDefinition {
    return {
      name: REVIEW_CHANGE_READ_TOOL_NAME,
      label: "Read pinned review change side",
      description:
        "Call with {} to list the first page using the sealed source inventory's page default, " +
        "or use fromFileOrdinal and maxFiles " +
        "to page authenticated zero-based file ordinals, old/new paths, and before/after availability. " +
        "Follow nextFileOrdinal until null; if a page hits the output cap, retry its same " +
        "fromFileOrdinal with fewer maxFiles. An unavailable side cannot be read or selected. " +
        "The same file order is in the sealed change-source manifest available through " +
        "docsfab_list_sources and docsfab_read_source. To read source lines, pass exactly " +
        "fileOrdinal, side, startLine, and endLine; listing alone supplies no line evidence.",
      promptSnippet: "List pinned review files, then read available before/after lines",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          fromFileOrdinal: { type: "integer", minimum: 0 },
          maxFiles: { type: "integer", minimum: 1, maximum: SOURCE_LIST_MAX_ENTRIES },
          fileOrdinal: { type: "integer", minimum: 0 },
          side: { type: "string", enum: ["before", "after"] },
          startLine: { type: "integer", minimum: 1 },
          endLine: { type: "integer", minimum: 1 },
        },
      },
      execute: async (id: unknown, raw: unknown) => {
        if (this.unavailable || typeof id !== "string" || this.seenCallIds.has(id)) {
          throw new Error("Pinned review side read is unavailable for this selected attempt.");
        }
        this.seenCallIds.add(id);
        if (
          isRecord(raw) &&
          !Object.hasOwn(raw, "fileOrdinal") &&
          !Object.hasOwn(raw, "side") &&
          !Object.hasOwn(raw, "startLine") &&
          !Object.hasOwn(raw, "endLine")
        ) {
          const files = this.source.listFiles();
          const page = inventoryRequest(raw, files.length);
          const end = Math.min(files.length, page.fromFileOrdinal + page.maxFiles);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  kind: "docsfab-review-change-side-inventory",
                  fileCount: files.length,
                  fromFileOrdinal: page.fromFileOrdinal,
                  nextFileOrdinal: end < files.length ? end : null,
                  files: files.slice(page.fromFileOrdinal, end),
                }),
              },
            ],
            details: undefined,
          };
        }
        const range = rangeRequest(raw);
        const side = this.source.readSide(range.fileOrdinal, range.side);
        if (!side || range.endLine > side.lines.length) {
          throw new Error("Pinned review side or complete requested range is unavailable.");
        }
        // Screen the exact whole blob before either a range or source-line labels
        // can split a configured multiline credential across result fragments.
        const match = findConfiguredCredential(Buffer.concat(side.lineBytes).toString("utf8"));
        if (match) throw new CredentialBoundaryError("confined-tool-result", match); // hygiene: ok -- constructor renders the stable content-free boundary message
        const header = JSON.stringify({
          fileOrdinal: range.fileOrdinal,
          side: range.side,
          oldPath: side.oldPath,
          newPath: side.newPath,
          blob: side.blob,
          rawSha256: side.rawSha256,
        });
        const rows = side.lineBytes
          .slice(range.startLine - 1, range.endLine)
          .map(
            (line, index) =>
              `[source-line ${range.startLine + index}] ${Buffer.from(line).toString("utf8")}`,
          );
        const rendered = `${header}\n${rows.join("")}`;
        this.pending.set(id, { side, range, rendered });
        return { content: [{ type: "text", text: rendered }], details: undefined };
      },
    };
  }

  public observeDelivered<T extends AnyToolDefinition>(definition: T): T {
    const execute = definition.execute.bind(definition) as (...args: any[]) => Promise<any>;
    return {
      ...definition,
      execute: async (...args: any[]) => {
        const id = args[0];
        try {
          const result = await execute(...args);
          if (typeof id === "string") this.recordDelivered(id, result);
          return result;
        } finally {
          if (typeof id === "string") this.pending.delete(id);
        }
      },
    };
  }

  private recordDelivered(id: string, result: unknown): void {
    const pending = this.pending.get(id);
    if (!pending || this.unavailable || !isRecord(result) || !Array.isArray(result.content)) return;
    const blocks = result.content;
    if (
      blocks.length !== 1 ||
      !isRecord(blocks[0]) ||
      blocks[0].type !== "text" ||
      blocks[0].text !== pending.rendered
    )
      return;
    const { side, range } = pending;
    const accepted: ReviewChangeDeliveredRange = {
      fileOrdinal: range.fileOrdinal,
      side: range.side,
      oldPath: side.oldPath,
      newPath: side.newPath,
      blob: side.blob,
      rawSha256: side.rawSha256,
      startLine: range.startLine,
      endLine: range.endLine,
      rangeSha256: rangeDigest(side, range),
    };
    const next = new Map(this.delivered);
    next.set(`${range.fileOrdinal}:${range.side}:${range.startLine}:${range.endLine}`, accepted);
    const attemptedBytes = this.projectedBytes(next, this.proposals);
    if (attemptedBytes > this.maxObjectBytes) {
      this.unavailable = true;
      throw new Error(
        `artifacts.maxObjectBytes: observed ${attemptedBytes} bytes for review side evidence in this attempt, exceeding the configured ${this.maxObjectBytes} bytes; narrow the requested range or raise the artifact limit.`,
      );
    }
    this.delivered.set(
      `${range.fileOrdinal}:${range.side}:${range.startLine}:${range.endLine}`,
      accepted,
    );
  }

  private workspaceDelivered(side: PinnedSide, range: RangeRequest): boolean {
    if (range.side !== "after" || !side.newPath) return false;
    const snapshot = this.workspaceReads?.();
    if (!snapshot || snapshot.unavailable || snapshot.invalidPaths.includes(side.newPath))
      return false;
    const file = snapshot.files.find(
      (entry) => entry.path === side.newPath && entry.rawSha256 === side.rawSha256,
    );
    if (!file) return false;
    const raw = Buffer.from(file.rawBase64, "base64");
    if (raw.toString("base64") !== file.rawBase64 || sha256(raw) !== side.rawSha256) return false;
    const observed = new Set(file.lines.map((line) => line.line));
    for (let line = range.startLine; line <= range.endLine; line += 1) {
      if (!observed.has(line)) return false;
    }
    return true;
  }

  public selectTool(): AnyToolDefinition {
    return {
      name: REVIEW_CHANGE_SELECT_TOOL_NAME,
      label: "Propose pinned review anchor",
      description:
        "Propose a before/after range already delivered in this attempt, keyed by the original producer issue ID.",
      promptSnippet: "Propose delivered review anchor",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["originalIssueId", "fileOrdinal", "side", "startLine", "endLine"],
        properties: {
          originalIssueId: { type: "string" },
          fileOrdinal: { type: "integer", minimum: 0 },
          side: { type: "string", enum: ["before", "after"] },
          startLine: { type: "integer", minimum: 1 },
          endLine: { type: "integer", minimum: 1 },
        },
      },
      execute: async (_id: unknown, raw: unknown) => {
        if (
          this.unavailable ||
          !isRecord(raw) ||
          typeof raw.originalIssueId !== "string" ||
          !raw.originalIssueId ||
          Object.keys(raw).length !== 5
        ) {
          throw new Error("Review anchor proposal requires a valid original issue and range.");
        }
        const originalIssueId = raw.originalIssueId;
        const range = rangeRequest({
          fileOrdinal: raw.fileOrdinal,
          side: raw.side,
          startLine: raw.startLine,
          endLine: raw.endLine,
        });
        if (this.conflicts.has(originalIssueId))
          throw new Error("Review issue has conflicting proposals in this selected attempt.");
        const side = this.source.readSide(range.fileOrdinal, range.side);
        if (!side || range.endLine > side.lines.length)
          throw new Error("Pinned review anchor side or range is unavailable from source.");
        // A full selection can combine adjacent pinned-side reads or one
        // authenticated pinned-head workspace observation, never unseen lines.
        const matchingReads = [...this.delivered.values()].filter(
          (entry) => entry.fileOrdinal === range.fileOrdinal && entry.side === range.side,
        );
        let directlyDelivered = true;
        for (let line = range.startLine; line <= range.endLine; line += 1) {
          if (!matchingReads.some((entry) => entry.startLine <= line && entry.endLine >= line)) {
            directlyDelivered = false;
            break;
          }
        }
        const fromWorkspace = !directlyDelivered && this.workspaceDelivered(side, range);
        if (!directlyDelivered && !fromWorkspace)
          throw new Error("Review anchor range was not fully delivered in this attempt.");
        const proposal: ReviewChangeProposal = {
          originalIssueId,
          fileOrdinal: range.fileOrdinal,
          side: range.side,
          oldPath: side.oldPath,
          newPath: side.newPath,
          blob: side.blob,
          rawSha256: side.rawSha256,
          startLine: range.startLine,
          endLine: range.endLine,
          rangeSha256: rangeDigest(side, range),
        };
        const prior = this.proposals.get(originalIssueId);
        if (prior && JSON.stringify(prior) !== JSON.stringify(proposal)) {
          this.proposals.delete(originalIssueId);
          this.conflicts.add(originalIssueId);
          if (this.projectedBytes(this.delivered, this.proposals) > this.maxObjectBytes) {
            this.unavailable = true;
          }
          throw new Error("Review issue has conflicting proposals in this selected attempt.");
        }
        const next = new Map(this.proposals);
        next.set(originalIssueId, proposal);
        const delivered = new Map(this.delivered);
        if (fromWorkspace)
          delivered.set(`${range.fileOrdinal}:${range.side}:${range.startLine}:${range.endLine}`, {
            fileOrdinal: range.fileOrdinal,
            side: range.side,
            oldPath: side.oldPath,
            newPath: side.newPath,
            blob: side.blob,
            rawSha256: side.rawSha256,
            startLine: range.startLine,
            endLine: range.endLine,
            rangeSha256: proposal.rangeSha256,
          });
        const attemptedBytes = this.projectedBytes(delivered, next);
        if (attemptedBytes > this.maxObjectBytes) {
          this.unavailable = true;
          throw new Error(
            `artifacts.maxObjectBytes: observed ${attemptedBytes} bytes for review anchor evidence in this attempt, exceeding the configured ${this.maxObjectBytes} bytes; narrow selections or raise the artifact limit.`,
          );
        }
        if (fromWorkspace)
          this.delivered.set(
            `${range.fileOrdinal}:${range.side}:${range.startLine}:${range.endLine}`,
            delivered.get(
              `${range.fileOrdinal}:${range.side}:${range.startLine}:${range.endLine}`,
            )!,
          );
        this.proposals.set(originalIssueId, proposal);
        return {
          content: [{ type: "text", text: REVIEW_CHANGE_PROPOSAL_ACK }],
          details: undefined,
        };
      },
    };
  }

  public snapshot(): ReviewChangeObservation {
    return {
      runId: this.runId,
      stepId: this.stepId,
      attemptId: this.attemptId,
      sourceReference: this.source.reference,
      delivered: [...this.delivered.values()],
      proposals: [...this.proposals.values()],
      conflictingIssueIds: [...this.conflicts].sort(),
      unavailable: this.unavailable,
    };
  }
  public dispose(): void {
    this.pending.clear();
    this.seenCallIds.clear();
    this.delivered.clear();
    this.proposals.clear();
    this.conflicts.clear();
  }
}
