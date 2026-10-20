// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Confined source-evidence tools: list, read, search, and cite.
 *
 * The reading tools exist only when the host handed this step a live
 * `SourceStepReaderV1`; search and cite also need a host-built searcher or
 * citer. Nothing else grants them. The schemas cannot name a path, URL, run,
 * step, project, or policy; apart from a cite claim and a descriptor ceiling
 * they take only ids that must belong to the sealed binding, and the host
 * fills every identity, timestamp, and digest in the evidence.
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import {
  SourceDiscoveryError,
  SOURCE_DISCOVERY_REFUSALS,
  failSourceDiscovery,
  sourceDiscoveryEgressRefusal,
  type SourceDiscoveryResultV1,
} from "../inputs/source-discovery.js";
import {
  SOURCE_CITE_MAX_CLAIM_CHARACTERS,
  SOURCE_CITE_MAX_SPANS_PER_CALL,
} from "../config/source-citation-limits.js";
import {
  SOURCE_CITATION_REFUSALS,
  SourceCitationError,
  failSourceCitation,
} from "../inputs/source-evidence-artifacts.js";
import type { PreservationSourceReaderV1 } from "../workflow-execution/source-obligation.js";
import {
  readPreservationSourceObservation,
  type PreservationSourceObservationCacheV1,
} from "../workflow-execution/preservation-source-observation-cache.js";
import { readPreservationSourceRange } from "../workflow-execution/source-obligation-observer.js";
import {
  SourceEvidenceServiceError,
  failSourceEvidenceService,
  readSourceWindow,
  type SourceSpanInventoryEntryV1,
  type SourceStepCiterV1,
  type SourceStepReaderV1,
  type SourceWindowPreviewV1,
} from "../inputs/source-resolver.js";
import type { SourceDiffLocatorV1 } from "../inputs/source-evidence.js";
import { SOURCE_EXACT_ORIGINAL_FORM } from "../inputs/source-evidence.js";
import { formatLimitObservation, limit, refuseLimit } from "../config/limits.js";
import {
  SOURCE_LIST_MAX_ENTRIES_LIMIT,
  sourceReadResponseCeiling,
} from "../config/source-read-limits.js";
import { SOURCE_READ_RESPONSE_CEILING_BYTES } from "../inputs/source-step-policy.js";
import {
  SOURCE_SEARCH_MAX_DESCRIPTORS,
  type SourceStepSearcherV1,
} from "../inputs/source-step-search.js";
import type {
  ToolArgumentFillerKind,
  ToolFailureCategory,
  ToolRefusalArgumentKey,
  ToolRefusalCode,
  ToolRefusalDetailKind,
  ToolRefusalIdArgument,
  ToolRefusalIdMatch,
} from "../records/contracts.js";
import {
  CredentialBoundaryError,
  assertConfinedToolResultCredentialFree,
} from "../security/credential-isolation.js";
import { egressValue, type HostRootSet } from "../security/egress.js";
import { processHostRootSet } from "../security/host-roots.js";
import { resolveToolOutputCapBytes } from "./tool-output-cap.js";
import {
  IssuedIds,
  classifyIssuedId,
  idMatchEntries,
  isPlainRecord,
  toolArgumentKeys,
  type ToolArgumentFillerRecorder,
  type ToolRefusalRecorder,
} from "./tool-refusals.js";

/**
 * Byte ceiling on one rendered search payload. Source tools skip
 * `withToolOutputCap` and a search spends no read budget, so row caps alone
 * would not bound bytes.
 */
export const SOURCE_SEARCH_PAYLOAD_CEILING_BYTES = SOURCE_READ_RESPONSE_CEILING_BYTES;

/** Tools admitted by a live step reader. */
export const SOURCE_READ_TOOL_NAMES = ["docsfab_list_sources", "docsfab_read_source"] as const;
/** Step-scoped exact reads from the restructuring run's sealed original authority. */
export const PRESERVATION_SOURCE_READ_TOOL_NAMES = ["docsfab_read_preservation_source"] as const;
/** Tools admitted only by a live step searcher, on top of the reader grant. */
export const SOURCE_SEARCH_TOOL_NAMES = ["docsfab_search_sources"] as const;
/** Tools admitted only by a live step citer, on top of the reader grant. */
export const SOURCE_CITE_TOOL_NAMES = ["docsfab_cite_source"] as const;
/** The full source-tool vocabulary; the grant is composed, never this whole list. */
export const SOURCE_TOOL_NAMES = [
  ...SOURCE_READ_TOOL_NAMES,
  ...PRESERVATION_SOURCE_READ_TOOL_NAMES,
  ...SOURCE_SEARCH_TOOL_NAMES,
  ...SOURCE_CITE_TOOL_NAMES,
] as const;
export type SourceToolName = (typeof SOURCE_TOOL_NAMES)[number];

export {
  SOURCE_CITE_MAX_CLAIM_CHARACTERS,
  SOURCE_CITE_MAX_SPANS_PER_CALL,
} from "../config/source-citation-limits.js";

/** Maximum span ids one read call may name; a narrower host budget still wins. */
export const SOURCE_READ_MAX_SPANS_PER_CALL = 32;

/** The inventory enters the prompt; its sealed catalog value is also its default page size. */
export const SOURCE_LIST_MAX_ENTRIES = limit(SOURCE_LIST_MAX_ENTRIES_LIMIT).value;

type AnyToolDefinition = ToolDefinition<any, any, any>;

export interface SourceToolOptions {
  reader: SourceStepReaderV1;
  /** Actual confined per-run model-visible cap, never an ambient replacement. */
  toolOutputCapBytes?: number;
  /** Optional host-issued reader for exact ranges of sealed restructuring originals. */
  preservationSourceReader?: PreservationSourceReaderV1;
  preservationSourceObservationCache?: PreservationSourceObservationCacheV1;
  /** Live per-step searcher; without it `docsfab_search_sources` is not registered. */
  searcher?: SourceStepSearcherV1;
  /** Live per-step citer; without it `docsfab_cite_source` is not registered. */
  citer?: SourceStepCiterV1;
  recordFailure: (category: ToolFailureCategory) => void;
  /** Receives one content-free row per refused call; see `harness/tool-refusals.ts`. */
  recordRefusal?: ToolRefusalRecorder;
  /** Receives each argument a call sent as filler, content-free; see `setAsideFiller`. */
  recordFiller?: ToolArgumentFillerRecorder;
  /**
   * This host's roots, replaced in a search payload before the model sees it.
   * Defaults to `processHostRoots(workspaceRoots)`.
   */
  hostRoots?: HostRootSet;
  /** The run's checkout roots; a path under one reaches the model repository-relative. */
  workspaceRoots?: readonly string[];
}

export function createSourceToolDefinitions(options: SourceToolOptions): AnyToolDefinition[] {
  const definitions = [listSourcesTool(options), readSourceTool(options)];
  if (options.preservationSourceReader) {
    definitions.push(
      createPreservationSourceToolDefinition(
        options.preservationSourceReader,
        options.preservationSourceObservationCache,
      ),
    );
  }
  if (options.searcher) {
    // Built here so an invalid public-roots declaration refuses before any search.
    const hostRoots = options.hostRoots ?? processHostRoots(options.workspaceRoots);
    definitions.push(searchSourcesTool(options, options.searcher, hostRoots));
  }
  if (options.citer) {
    definitions.push(citeSourceTool(options.citer, options.reader, options.recordFiller));
  }
  return definitions.map((definition) => wrapSourceExecute(definition, options));
}

export function createPreservationSourceToolDefinition(
  reader: PreservationSourceReaderV1,
  cache?: PreservationSourceObservationCacheV1,
): AnyToolDefinition {
  return {
    name: "docsfab_read_preservation_source",
    label: "Read exact preservation source range",
    description:
      "Read a byte range from one host-listed immutable original source reference. " +
      "Use only its sourceId and continue from nextFromByte until null when the required " +
      "evidence continues. The host rechecks the sealed revision and digest on every call.",
    promptSnippet: "Read an exact range from a host-listed immutable original source",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["sourceId", "fromByte"],
      properties: {
        sourceId: {
          type: "string",
          description: "Host-issued sourceId from the exact original-source reference inventory.",
        },
        fromByte: {
          type: "integer",
          minimum: 0,
          description: "UTF-8 byte offset, starting at 0 or continuing from nextFromByte.",
        },
        maxBytes: {
          type: "integer",
          minimum: 1,
          description:
            "Optional maximum bytes in this response; continue with nextFromByte when more source remains.",
        },
      },
    },
    async execute(_id: unknown, rawParams: unknown) {
      if (!isPlainRecord(rawParams))
        throw new Error("Preservation source read arguments are invalid for this step.");
      const sourceId = rawParams.sourceId;
      const fromByte = rawParams.fromByte;
      const responseCeiling = sourceReadResponseCeiling();
      const requestedMaxBytes = rawParams.maxBytes ?? responseCeiling.value;
      const maxBytes = Number(requestedMaxBytes);
      if (
        typeof sourceId !== "string" ||
        !Number.isSafeInteger(fromByte) ||
        !Number.isSafeInteger(requestedMaxBytes) ||
        Number(fromByte) < 0 ||
        Number(maxBytes) <= 0
      ) {
        throw new Error("Preservation source read arguments are invalid for this step.");
      }
      if (maxBytes > responseCeiling.value) refuseLimit(responseCeiling, maxBytes);
      const read = { reader, sourceId, fromByte: Number(fromByte), maxBytes: Number(maxBytes) };
      const result = cache
        ? await readPreservationSourceObservation({ cache, ...read })
        : await readPreservationSourceRange(read);
      const payload = {
        kind: "docsfab-preservation-source-range",
        sourceId: result.sourceId,
        path: result.path,
        sha256: result.sha256,
        fromByte: result.fromByte,
        endByte: result.endByte,
        nextFromByte: result.nextFromByte,
        text: result.text,
      };
      const content = [{ type: "text" as const, text: JSON.stringify(payload) }];
      assertConfinedToolResultCredentialFree({ content });
      return {
        content,
        details: {
          sourceId: result.sourceId,
          fromByte: result.fromByte,
          endByte: result.endByte,
          nextFromByte: result.nextFromByte,
        },
      };
    },
  };
}

/**
 * The only channel through which a model learns a span id; `docsfab_read_source`
 * refuses ids the host did not issue. It returns identity, position, and each
 * span's locator, never span text. A locator can carry strings taken from the
 * source, such as `json-pointer` object keys, a notebook `cellId`, or a DOCX
 * `part` name. It takes no parameters.
 */
function listSourcesTool(options: SourceToolOptions): AnyToolDefinition {
  return {
    name: "docsfab_list_sources",
    label: "List readable source spans",
    description:
      "List the sources and source spans this step may read, with no source text. Each source " +
      "has a short handle (s1, s2, ...), its repository path, media type, size, span count, " +
      "and full observation and representation ids; each span names its source by handle, " +
      "with its span id, byte range, and locator. Pass a handle as source to " +
      "docsfab_read_source and docsfab_cite_source instead of copying the long ids. This tool " +
      "accepts fromEntry and maxEntries to page a long inventory, and discloses nothing outside " +
      "the run's sealed source binding. An exact-original-utf8 row names the authenticated Git side.",
    promptSnippet: "List the sources this step may read, each with a short handle",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: [],
      properties: {
        fromEntry: { type: "integer", minimum: 0 },
        maxEntries: { type: "integer", minimum: 1, maximum: SOURCE_LIST_MAX_ENTRIES },
      },
    },
    async execute(_id: unknown, rawParams: unknown) {
      const params = isPlainRecord(rawParams) ? rawParams : {};
      const fromEntry = params.fromEntry === undefined ? 0 : params.fromEntry;
      const maxEntries =
        params.maxEntries === undefined ? SOURCE_LIST_MAX_ENTRIES : params.maxEntries;
      if (
        !Number.isSafeInteger(fromEntry) ||
        (fromEntry as number) < 0 ||
        !Number.isSafeInteger(maxEntries) ||
        (maxEntries as number) < 1
      )
        failSourceEvidenceService(
          "span-unavailable",
          "Inventory page arguments are outside the declared range.",
          "argument-shape",
        );
      if ((maxEntries as number) > SOURCE_LIST_MAX_ENTRIES)
        failSourceEvidenceService(
          "span-unavailable",
          formatLimitObservation(limit(SOURCE_LIST_MAX_ENTRIES_LIMIT), maxEntries as number),
          "window-range",
        );
      const entries = options.reader.listSources();
      if ((fromEntry as number) > entries.length)
        failSourceEvidenceService(
          "span-unavailable",
          "Inventory page starts past the last entry.",
          "window-range",
        );
      const sources = listedSources(entries);
      const handleOf = new Map(
        sources.map((source) => [
          `${source.observationId}|${source.representationId}`,
          source.handle,
        ]),
      );
      // A span names its source by handle: the source row carries the long
      // ids, path, and media type once, not once per span.
      const pageEntries = entries.slice(
        fromEntry as number,
        (fromEntry as number) + (maxEntries as number),
      );
      const retained = pageEntries.map((entry) => ({
        source: handleOf.get(`${entry.observationId}|${entry.representationId}`)!,
        spanId: entry.spanId,
        startByte: entry.startByte,
        endByte: entry.endByte,
        locator: entry.locator,
      }));
      const pageHandles = new Set(retained.map((entry) => entry.source));
      const rawInventory = sources.some((source) => source.form === SOURCE_EXACT_ORIGINAL_FORM);
      const content = [
        {
          type: "text" as const,
          text: JSON.stringify({
            kind: "docsfab-source-span-inventory",
            sourceCount: sources.length,
            sources: rawInventory
              ? sources.filter((source) => pageHandles.has(source.handle))
              : sources.slice(0, SOURCE_LIST_MAX_ENTRIES),
            truncated: rawInventory
              ? (fromEntry as number) + retained.length < entries.length
              : entries.length > retained.length,
            spanCount: entries.length,
            ...(rawInventory
              ? {
                  fromEntry,
                  nextFromEntry:
                    (fromEntry as number) + retained.length < entries.length
                      ? (fromEntry as number) + retained.length
                      : null,
                }
              : {}),
            spans: retained,
          }),
        },
      ];
      if (rawInventory) assertRawOutputCap(content, options.toolOutputCapBytes);
      return {
        content,
        // Content-free: a count, never a digest of anything disclosed.
        details: { spanCount: entries.length },
      };
    },
  };
}

/** One readable source: a representation of an observation, and its handle. */
interface ListedSourceV1 {
  /** `s1`, `s2`, ... in inventory order, so the same binding lists the same handles. */
  handle: string;
  observationId: string;
  representationId: string;
  repositoryPath: string | null;
  mediaType: string;
  spanCount: number;
  bytes: number;
  form?: typeof SOURCE_EXACT_ORIGINAL_FORM;
  originalIdentity?: SourceSpanInventoryEntryV1["originalIdentity"];
  /** A diff representation's file count: the numbers `diffFile` accepts. */
  diffFiles?: number;
}

/**
 * Identity, size, and extent of each representation the inventory lists: what a
 * window read needs to page through it from byte 0. Positions only, no text.
 * The handle is host bookkeeping, so a model names a source without copying a
 * 64-hex id; the host resolves it back to the sealed ids.
 */
function listedSources(entries: readonly SourceSpanInventoryEntryV1[]): ListedSourceV1[] {
  const summaries = new Map<string, ListedSourceV1>();
  for (const entry of entries) {
    const key = `${entry.observationId}|${entry.representationId}`;
    const summary = summaries.get(key) ?? {
      handle: `s${summaries.size + 1}`,
      observationId: entry.observationId,
      representationId: entry.representationId,
      repositoryPath: entry.repositoryPath,
      mediaType: entry.mediaType,
      spanCount: 0,
      bytes: 0,
      ...(entry.form ? { form: entry.form, originalIdentity: entry.originalIdentity } : {}),
      ...(entry.locator.kind === "diff" ? { diffFiles: 0 } : {}),
    };
    summary.spanCount += 1;
    summary.bytes += entry.endByte - entry.startByte;
    if (entry.locator.kind === "diff" && summary.diffFiles !== undefined) {
      summary.diffFiles = Math.max(summary.diffFiles, entry.locator.fileOrdinal ?? 0);
    }
    summaries.set(key, summary);
  }
  return [...summaries.values()];
}

/**
 * The spans of one diff file, or one hunk of it, in byte order. A file read
 * whole because per-hunk spans would not fit the span ceiling answers a hunk
 * request with the whole file.
 */
function diffUnitSpans(
  entries: readonly SourceSpanInventoryEntryV1[],
  observationId: string,
  representationId: string,
  diffFile: number,
  diffHunk: number | undefined,
): { spans: SourceSpanInventoryEntryV1[]; unit: "file" | "hunk" } {
  const sourceSpans = entries.filter(
    (entry) => entry.observationId === observationId && entry.representationId === representationId,
  );
  if (sourceSpans.length === 0) {
    failSourceEvidenceService(
      "observation-unavailable",
      "That source is not one this step may read. Pass a source handle docsfab_list_sources returned.",
      "unknown-source",
    );
  }
  const diffSpans = sourceSpans.filter((entry) => entry.locator.kind === "diff");
  if (diffSpans.length === 0) {
    failSourceEvidenceService(
      "span-unavailable",
      "This representation is not a unified diff, so diffFile and diffHunk do not apply. Read it by span ids or by fromByte.",
      "diff-unit",
    );
  }
  const locators = new Map(
    diffSpans.map((entry) => [entry, entry.locator as SourceDiffLocatorV1] as const),
  );
  const fileCount = Math.max(0, ...[...locators.values()].map((entry) => entry.fileOrdinal ?? 0));
  const fileSpans = diffSpans
    .filter((entry) => locators.get(entry)!.fileOrdinal === diffFile)
    .sort((left, right) => left.startByte - right.startByte);
  if (fileSpans.length === 0) {
    failSourceEvidenceService(
      "span-unavailable",
      diffFile <= fileCount
        ? `Diff file ${diffFile} has no extracted text. Its row in the manifest, read from fromByte 0, says why.`
        : `This diff has ${fileCount} files, and file ${diffFile} is not one of them. Read its manifest from fromByte 0 for the file numbers.`,
      "diff-unit",
    );
  }
  if (diffHunk === undefined) return { spans: fileSpans, unit: "file" };
  const fileLocators = fileSpans.map((entry) => locators.get(entry)!);
  const hunkCount = Math.max(
    0,
    ...fileLocators.map((entry) => entry.hunkCount ?? entry.hunkOrdinal ?? 0),
  );
  if (diffHunk > hunkCount) {
    failSourceEvidenceService(
      "span-unavailable",
      `Diff file ${diffFile} has ${hunkCount} hunks, and hunk ${diffHunk} is not one of them.`,
      "diff-unit",
    );
  }
  if (fileLocators.some((entry) => entry.part === "file")) {
    return { spans: fileSpans, unit: "file" };
  }
  const hunkSpans = fileSpans.filter((entry) => {
    const locator = locators.get(entry)!;
    return locator.part === "hunk" && locator.hunkOrdinal === diffHunk;
  });
  if (hunkSpans.length === 0) {
    failSourceEvidenceService(
      "span-unavailable",
      `Diff file ${diffFile} hunk ${diffHunk} has no extracted text. The file's row in the manifest, read from fromByte 0, says why.`,
      "diff-unit",
    );
  }
  return { spans: hunkSpans, unit: "hunk" };
}

function isOrdinal(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

/** Sets one argument of the current call aside as filler, by name and kind only. */
type SetAside = (argument: ToolRefusalArgumentKey, kind: ToolArgumentFillerKind) => void;

/**
 * Arguments whose `0` selects nothing: a read of 0 bytes, and the file and
 * hunk numbers, which count from 1.
 */
const ZERO_SELECTS_NOTHING: ReadonlySet<string> = new Set(["maxBytes", "diffFile", "diffHunk"]);

/**
 * The value a provider fills an unused argument with, when it is one that
 * cannot select anything: `null`, an empty string or list, or a `0` the
 * argument cannot mean.
 */
export function fillerKind(
  value: unknown,
  zeroSelectsNothing: boolean,
): ToolArgumentFillerKind | undefined {
  if (value === null) return "null";
  if (value === "" || (Array.isArray(value) && value.length === 0)) return "empty";
  if (zeroSelectsNothing && value === 0) return "zero";
  return undefined;
}

/**
 * The call's arguments with filler removed. Structured tool calling leads
 * many models to send every declared argument, so an argument the call does
 * not use arrives as `null`, `""`, `[]`, or `0` rather than absent; read as
 * present, it would be a second selection. `fromByte` 0 is the default start,
 * so beside span ids or a diff file it selects nothing either.
 */
function setAsideFiller(
  params: Record<string, unknown>,
  names: readonly ToolRefusalArgumentKey[],
  setAside: SetAside,
): Record<string, unknown> {
  const kept = { ...params };
  for (const name of names) {
    const kind = fillerKind(kept[name], ZERO_SELECTS_NOTHING.has(name));
    if (kind === undefined) continue;
    delete kept[name];
    setAside(name, kind);
  }
  if (kept.fromByte === 0 && (kept.spanIds !== undefined || kept.diffFile !== undefined)) {
    delete kept.fromByte;
    setAside("fromByte", "zero");
  }
  return kept;
}

const READ_ARGUMENTS = [
  "source",
  "observationId",
  "representationId",
  "spanIds",
  "fromByte",
  "maxBytes",
  "diffFile",
  "diffHunk",
] as const satisfies readonly ToolRefusalArgumentKey[];

const CITE_SOURCE_ARGUMENTS = [
  "source",
  "observationId",
  "representationId",
] as const satisfies readonly ToolRefusalArgumentKey[];

/**
 * The one selection a `docsfab_read_source` call makes. Every argument shape
 * maps to exactly one form or to a refusal that names what to change: a call
 * the tool cannot answer must tell the model how to ask again.
 */
type SourceReadSelection =
  | {
      form: "spans";
      spanIds: readonly string[];
      maxBytes?: number;
      /** A diff file and hunk sent beside the spans; they must name the spans' unit. */
      diffUnit?: { diffFile?: number; diffHunk?: number };
    }
  | { form: "window"; fromByte: number; maxBytes?: number }
  | { form: "diff"; diffFile: number; diffHunk?: number; fromByte?: number; maxBytes?: number };

const READ_FORMS =
  "Pass span ids, or a window (fromByte, with an optional maxBytes), or a diff file (diffFile, with an optional diffHunk), each in its own call; send an argument you do not use as null, or omit it.";

function readSelection(params: Record<string, unknown>): SourceReadSelection {
  const { spanIds, fromByte, maxBytes, diffFile, diffHunk } = params;
  if (fromByte !== undefined && !(Number.isSafeInteger(fromByte) && (fromByte as number) >= 0)) {
    failSourceEvidenceService(
      "span-unavailable",
      "fromByte must be a whole number of 0 or more.",
      "argument-shape",
    );
  }
  if (maxBytes !== undefined && !(Number.isSafeInteger(maxBytes) && (maxBytes as number) >= 1)) {
    failSourceEvidenceService(
      "span-unavailable",
      "maxBytes must be a whole number of 1 or more.",
      "argument-shape",
    );
  }
  if (diffFile !== undefined && !isOrdinal(diffFile)) {
    failSourceEvidenceService(
      "span-unavailable",
      "diffFile must be a file number of 1 or more.",
      "argument-shape",
    );
  }
  if (diffHunk !== undefined && !isOrdinal(diffHunk)) {
    failSourceEvidenceService(
      "span-unavailable",
      "diffHunk must be a hunk number of 1 or more.",
      "argument-shape",
    );
  }
  const bounded = maxBytes === undefined ? {} : { maxBytes: maxBytes as number };
  if (spanIds !== undefined) {
    if (
      !Array.isArray(spanIds) ||
      spanIds.length === 0 ||
      spanIds.length > SOURCE_READ_MAX_SPANS_PER_CALL ||
      spanIds.some((value) => typeof value !== "string")
    ) {
      failSourceEvidenceService(
        "span-unavailable",
        `spanIds must list 1 to ${SOURCE_READ_MAX_SPANS_PER_CALL} span ids from docsfab_list_sources.`,
        "argument-shape",
      );
    }
    if (fromByte !== undefined) {
      failSourceEvidenceService(
        "span-unavailable",
        `spanIds cannot be combined with a fromByte after 0: a read by span ids returns those spans whole. Send fromByte as null, or omit it, beside spanIds. ${READ_FORMS}`,
        "argument-shape",
      );
    }
    const diffUnit = {
      ...(diffFile === undefined ? {} : { diffFile: diffFile as number }),
      ...(diffHunk === undefined ? {} : { diffHunk: diffHunk as number }),
    };
    return {
      form: "spans",
      spanIds: spanIds as string[],
      ...bounded,
      ...(Object.keys(diffUnit).length === 0 ? {} : { diffUnit }),
    };
  }
  if (diffHunk !== undefined && diffFile === undefined) {
    failSourceEvidenceService(
      "span-unavailable",
      "diffHunk needs diffFile, the number of the file the hunk belongs to.",
      "argument-shape",
    );
  }
  if (diffFile !== undefined) {
    return {
      form: "diff",
      diffFile: diffFile as number,
      ...(diffHunk === undefined ? {} : { diffHunk: diffHunk as number }),
      ...(fromByte === undefined ? {} : { fromByte: fromByte as number }),
      ...bounded,
    };
  }
  // With no selection, the read starts where a source starts: its first byte.
  return { form: "window", fromByte: (fromByte as number | undefined) ?? 0, ...bounded };
}

/**
 * `maxBytes` bounds a read by span ids as it bounds a window: named spans that
 * together hold more refuse with their size, so no span is dropped unread.
 */
function assertSpansWithin(
  reader: SourceStepReaderV1,
  observationId: string,
  representationId: string,
  spanIds: readonly string[],
  maxBytes: number,
): void {
  const wanted = new Set(spanIds);
  const bytes = reader
    .listSources()
    .filter(
      (entry) =>
        entry.observationId === observationId &&
        entry.representationId === representationId &&
        wanted.has(entry.spanId),
    )
    .reduce((total, entry) => total + (entry.endByte - entry.startByte), 0);
  if (bytes > maxBytes) {
    failSourceEvidenceService(
      "span-unavailable",
      `These ${spanIds.length} spans hold ${bytes} bytes, more than maxBytes ${maxBytes}. Name fewer span ids, raise maxBytes, or read a window from the first span's startByte.`,
      "span-size",
    );
  }
}

/**
 * A diff file and hunk sent beside span ids select nothing more: they are set
 * aside when they name the unit every listed span lies in (a file's header
 * lies in each of its hunks), or when the source is not a diff, where they
 * mean nothing. A unit the spans are not in is a second selection, and
 * refuses with what to send.
 */
function setAsideSpanUnit(
  entries: readonly SourceSpanInventoryEntryV1[],
  target: SourceTarget,
  spanIds: readonly string[],
  unit: { diffFile?: number; diffHunk?: number },
  setAside: SetAside,
): void {
  const sourceSpans = entries.filter(
    (entry) =>
      entry.observationId === target.observationId &&
      entry.representationId === target.representationId,
  );
  const sent = (["diffFile", "diffHunk"] as const).filter((name) => unit[name] !== undefined);
  if (!sourceSpans.some((entry) => entry.locator.kind === "diff")) {
    for (const name of sent) setAside(name, "inapplicable");
    return;
  }
  if (unit.diffFile === undefined) {
    failSourceEvidenceService(
      "span-unavailable",
      "diffHunk needs diffFile, the number of the file the hunk belongs to. Beside spanIds, send diffHunk as null, or omit it.",
      "argument-shape",
    );
  }
  let unitSpans: readonly SourceSpanInventoryEntryV1[] = [];
  try {
    const { observationId, representationId } = target;
    // The file's spans, its header included, once the hunk is known to exist.
    diffUnitSpans(entries, observationId, representationId, unit.diffFile, unit.diffHunk);
    unitSpans = diffUnitSpans(
      entries,
      observationId,
      representationId,
      unit.diffFile,
      undefined,
    ).spans;
  } catch (error) {
    if (!(error instanceof SourceEvidenceServiceError)) throw error;
  }
  const inUnit = new Set(
    unitSpans
      .filter((entry) => {
        const { hunkOrdinal } = entry.locator as SourceDiffLocatorV1;
        return unit.diffHunk === undefined || hunkOrdinal === null || hunkOrdinal === unit.diffHunk;
      })
      .map((entry) => entry.spanId),
  );
  const listed = new Set(sourceSpans.map((entry) => entry.spanId));
  // An id the listing never issued is refused by the read itself, by name.
  if (spanIds.some((spanId) => listed.has(spanId) && !inUnit.has(spanId))) {
    const named =
      unit.diffHunk === undefined
        ? `diff file ${unit.diffFile}`
        : `diff file ${unit.diffFile} hunk ${unit.diffHunk}`;
    failSourceEvidenceService(
      "span-unavailable",
      `Those span ids are not all in ${named}, so the call names two selections. Beside spanIds, send diffFile and diffHunk as null, or omit them; or read ${named} by diffFile and diffHunk without spanIds.`,
      "argument-shape",
    );
  }
  for (const name of sent) setAside(name, "redundant");
}

/** The resolved source of a call: the sealed ids the host reads and cites, and its handle. */
interface SourceTarget {
  readonly handle: string;
  readonly observationId: string;
  readonly representationId: string;
  readonly form?: typeof SOURCE_EXACT_ORIGINAL_FORM;
  readonly originalIdentity?: SourceSpanInventoryEntryV1["originalIdentity"];
}

/** Count the exact JSON content array Pi forwards, including escaped text. */
function assertRawOutputCap(content: unknown, cap: number | undefined): number {
  const measured = Buffer.byteLength(JSON.stringify(content), "utf8");
  const allowed = cap ?? resolveToolOutputCapBytes();
  if (measured > allowed)
    failSourceEvidenceService(
      "budget-exhausted",
      `The exact-original source result needs ${measured} serialized bytes and this run's DOCSFAB_TOOL_OUTPUT_CAP_BYTES permits ${allowed}. Read fewer spans or a smaller page, or raise the host cap and start a new run.`,
      "read-budget",
    );
  return measured;
}

/** The valid handles, contiguous from `s1`, so the text stays short at any count. */
function handleRange(sources: readonly ListedSourceV1[]): string {
  if (sources.length === 0) return "none: this step has no readable source";
  if (sources.length === 1) return "s1";
  return `s1 to s${sources.length}`;
}

/**
 * Resolves the source a call names, from the forms a model sends: a handle
 * (`source: "s1"`, or a handle in observationId), or the full observation id,
 * with the representation id optional when the observation has exactly one.
 * A path never names a source, so no tool argument can reach outside the
 * binding by name. Each refusal names the valid handles and never repeats the
 * value the model sent.
 */
function resolveSourceTarget(
  entries: readonly SourceSpanInventoryEntryV1[],
  params: Record<string, unknown>,
  setAside: SetAside = () => undefined,
): SourceTarget {
  const sources = listedSources(entries);
  const valid = handleRange(sources);
  const byHandle = new Map(sources.map((source) => [source.handle, source]));
  const { source, observationId, representationId } = params;
  const agrees = (value: unknown, target: ListedSourceV1, field: keyof ListedSourceV1) =>
    value === undefined || value === target.handle || value === target[field];
  // Beside a handle, an id names another source only when it is one the host
  // issued for it; any other value is filler and the handle decides.
  const namesOther = (
    value: unknown,
    target: ListedSourceV1,
    field: "observationId" | "representationId",
  ) =>
    !agrees(value, target, field) &&
    sources.some((entry) => entry.handle === value || entry[field] === value);
  const conflict = (): never =>
    failSourceEvidenceService(
      "span-unavailable",
      `source and observationId or representationId name different sources. Pass only source, a handle docsfab_list_sources returned: ${valid}.`,
      "argument-shape",
    );
  if (source !== undefined) {
    if (typeof source !== "string" || source.length === 0) {
      failSourceEvidenceService(
        "span-unavailable",
        `source must be a source handle docsfab_list_sources returned: ${valid}.`,
        "argument-shape",
      );
    }
    const byObservation = sources.filter((entry) => entry.observationId === source);
    const target =
      byHandle.get(source) ?? (byObservation.length === 1 ? byObservation[0] : undefined);
    if (!target) {
      failSourceEvidenceService(
        "observation-unavailable",
        `No source this step may read has that handle. Pass one docsfab_list_sources returned: ${valid}. Call docsfab_list_sources again to see them.`,
        "unknown-source",
      );
    }
    if (
      namesOther(observationId, target, "observationId") ||
      namesOther(representationId, target, "representationId")
    ) {
      conflict();
    }
    if (!agrees(observationId, target, "observationId")) {
      setAside("observationId", "unissued-id");
    }
    if (!agrees(representationId, target, "representationId")) {
      setAside("representationId", "unissued-id");
    }
    return target;
  }
  if (typeof observationId !== "string" || observationId.length === 0) {
    failSourceEvidenceService(
      "span-unavailable",
      `Name the source to read: pass source, a handle docsfab_list_sources returned: ${valid}.`,
      "argument-shape",
    );
  }
  const handled = byHandle.get(observationId);
  if (handled) {
    if (!agrees(representationId, handled, "representationId")) conflict();
    return handled;
  }
  const candidates = sources.filter((entry) => entry.observationId === observationId);
  if (candidates.length === 0) {
    failSourceEvidenceService(
      "observation-unavailable",
      `That observationId is not a source this step may read. Pass source, a handle docsfab_list_sources returned (${valid}), instead of observationId and representationId; call docsfab_list_sources again to see them.`,
      "unknown-source",
    );
  }
  const handles = candidates.map((entry) => entry.handle).join(", ");
  if (representationId === undefined) {
    if (candidates.length === 1) return candidates[0]!;
    failSourceEvidenceService(
      "span-unavailable",
      `This observation has ${candidates.length} representations. Pass source with the handle of the one to read: ${handles}.`,
      "argument-shape",
    );
  }
  const target = candidates.find(
    (entry) => entry.representationId === representationId || entry.handle === representationId,
  );
  if (!target) {
    failSourceEvidenceService(
      "span-unavailable",
      `That representationId is not a representation of this observation. Pass source with its handle instead: ${handles}.`,
      "unknown-representation",
    );
  }
  return target;
}

/**
 * Reads one file, or one hunk, of a diff representation as a window bounded
 * to that unit, so a model names a manifest number rather than a byte offset.
 */
function readDiffUnit(
  reader: SourceStepReaderV1,
  target: SourceTarget,
  selection: Extract<SourceReadSelection, { form: "diff" }>,
) {
  const { observationId, representationId } = target;
  const { diffFile, diffHunk, fromByte, maxBytes } = selection;
  const { spans, unit } = diffUnitSpans(
    reader.listSources(),
    observationId,
    representationId,
    diffFile,
    diffHunk,
  );
  const unitStart = spans[0]!.startByte;
  const unitEnd = spans.at(-1)!.endByte;
  const from = fromByte ?? unitStart;
  if (from < unitStart || from >= unitEnd) {
    failSourceEvidenceService(
      "span-unavailable",
      `fromByte ${from} is outside the requested diff ${unit}, which runs from byte ${unitStart} to ${unitEnd}. Omit fromByte to start at its beginning, or pass the nextFromByte an earlier read returned.`,
      "window-range",
    );
  }
  const render = (window: SourceWindowPreviewV1) =>
    diffUnitContent({
      target,
      diffFile,
      diffHunk: diffHunk ?? null,
      unit,
      unitBytes: spans.reduce((total, span) => total + (span.endByte - span.startByte), 0),
      fromByte: from,
      window,
    });
  const result = readSourceWindow(
    reader,
    {
      observationId,
      representationId,
      fromByte: from,
      maxBytes: maxBytes ?? resolveToolOutputCapBytes(),
      endByte: unitEnd,
    },
    {
      screen: (preview) => {
        assertConfinedToolResultCredentialFree({ content: render(preview) });
        return undefined;
      },
    },
  );
  return {
    content: render(result),
    // Content-free evidence join: the access digest, never the bytes.
    details: { spanAccessSha256: result.spanAccess.spanAccessSha256 },
  };
}

/** The content of a diff file or hunk read: the screen and the result render it alike. */
function diffUnitContent(input: {
  target: SourceTarget;
  diffFile: number;
  diffHunk: number | null;
  unit: "file" | "hunk";
  unitBytes: number;
  fromByte: number;
  window: SourceWindowPreviewV1;
}) {
  return [
    {
      type: "text" as const,
      text: JSON.stringify({
        kind: "docsfab-source-diff-read",
        source: input.target.handle,
        observationId: input.target.observationId,
        representationId: input.target.representationId,
        diffFile: input.diffFile,
        diffHunk: input.diffHunk,
        unit: input.unit,
        unitBytes: input.unitBytes,
        fromByte: input.fromByte,
        nextFromByte: input.window.nextFromByte,
        readBytes: input.window.readBytes,
        remainingBudgetBytes: input.window.remainingBudgetBytes,
        withheldSpanIds: input.window.withheldSpanIds,
        spans: input.window.spans,
      }),
    },
  ];
}

/** How every optional argument says it is unused; the host reads these as absent. */
const UNUSED = "Send null, or omit it, when unused";

const SOURCE_PARAMETER = {
  type: ["string", "null"],
  description: `The source to read: its handle from docsfab_list_sources (s1, s2, ...). Use it instead of observationId and representationId. ${UNUSED}`,
} as const;

function readSourceTool(options: SourceToolOptions): AnyToolDefinition {
  return {
    name: "docsfab_read_source",
    label: "Read bound source spans",
    description:
      "Return the exact retained derivative bytes for spans that belong to this run's sealed " +
      "source binding. Name the source by source, the short handle docsfab_list_sources " +
      "returned (s1, s2, ...); the full observationId, with representationId when the " +
      "observation has more than one, still works. Then select span ids taken from earlier " +
      "evidence, or a window: fromByte, a byte offset, with an optional " +
      "maxBytes. A window returns whole spans, each id beside its text, from the span holding " +
      "fromByte, or the first after it, while they fit maxBytes and this step's remaining read budget, with " +
      "nextFromByte to continue from in a later call, step, or attempt, so a source larger than " +
      "one read is read in windows. With no span ids, fromByte, or diffFile, the read is a window " +
      "from byte 0. maxBytes defaults to the per-call tool output cap, and also bounds a read " +
      "by span ids. Each call uses one selection form; a refusal says what to change. A span " +
      "the credential screen withholds is skipped and listed in withheldSpanIds, and stays " +
      "unread. A unified diff source (media type text/x-diff) opens with a manifest of its " +
      "files, so read it from fromByte 0 first; then pass diffFile, a file number from the " +
      "manifest, and optionally diffHunk to read one file or hunk, with fromByte set to the " +
      "nextFromByte it returned to continue. Send an argument you do not use as null, or " +
      "omit it: the host reads null, an empty string or list, a maxBytes, diffFile, or " +
      "diffHunk of 0, and a fromByte of 0 beside span ids or diffFile as unused. Beside a " +
      "source handle, an observationId or representationId that is no listed id is unused; " +
      "one of another source refuses. Beside span ids, a diffFile and diffHunk naming the " +
      "unit those spans are in are unused; another unit refuses. Paths, URLs, and policies " +
      "cannot be named here, and a span outside the binding fails closed.",
    promptSnippet: "Read a bound source by its handle (s1, s2, ...), by span ids or a window",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: [],
      properties: {
        source: SOURCE_PARAMETER,
        observationId: {
          type: ["string", "null"],
          description: `Instead of source: the full observation id from docsfab_list_sources, exactly. ${UNUSED}`,
        },
        representationId: {
          type: ["string", "null"],
          description: `With observationId, when that observation has more than one representation: the full representation id, exactly. ${UNUSED}`,
        },
        spanIds: {
          type: ["array", "null"],
          description: `Host-issued span ids belonging to that source. ${UNUSED}, to read a window or a diff file`,
          items: { type: "string" },
          maxItems: SOURCE_READ_MAX_SPANS_PER_CALL,
        },
        fromByte: {
          type: ["integer", "null"],
          description: `Read a window instead of span ids, from this byte offset: 0 for the start, or the nextFromByte an earlier window or diff read returned. Unused with no span ids or diffFile, the window starts at 0. ${UNUSED}`,
          minimum: 0,
        },
        maxBytes: {
          type: ["integer", "null"],
          description: `Most bytes the read returns, 1 or more, by default the per-call tool output cap; the step's remaining read budget still wins, and a window always returns at least one whole span the budget holds. Span ids that together hold more are refused with their size. ${UNUSED}`,
          minimum: 0,
        },
        diffFile: {
          type: ["integer", "null"],
          description: `For a diff source: read this file, by its number in the diff's manifest (from 1), instead of span ids. ${UNUSED}`,
          minimum: 0,
        },
        diffHunk: {
          type: ["integer", "null"],
          description: `With diffFile: read only this hunk, by its number within the file (from 1). ${UNUSED}`,
          minimum: 0,
        },
      },
    },
    async execute(_id: unknown, rawParams: unknown) {
      const setAside: SetAside = (argument, kind) =>
        options.recordFiller?.({ tool: "docsfab_read_source", argument, kind });
      const params = setAsideFiller(
        (isPlainRecord(rawParams) ? rawParams : {}) as Record<string, unknown>,
        READ_ARGUMENTS,
        setAside,
      );
      const entries = options.reader.listSources();
      const target = resolveSourceTarget(entries, params, setAside);
      const { observationId, representationId } = target;
      const selection = readSelection(params);
      if (selection.form === "spans" && selection.diffUnit) {
        setAsideSpanUnit(entries, target, selection.spanIds, selection.diffUnit, setAside);
      }
      if (selection.form === "diff") {
        return readDiffUnit(options.reader, target, selection);
      }
      if (selection.form === "window") {
        const { fromByte } = selection;
        // The same per-call cap every other model-facing read has, so one
        // window cannot fill a small context window; a model pages on with
        // nextFromByte.
        const maxBytes =
          selection.maxBytes ??
          (target.form === SOURCE_EXACT_ORIGINAL_FORM
            ? (options.toolOutputCapBytes ?? resolveToolOutputCapBytes())
            : resolveToolOutputCapBytes());
        // The reader screens this exact payload before it charges or records
        // the window, so a result the credential screen would withhold is
        // never counted as read.
        const result = readSourceWindow(
          options.reader,
          { observationId, representationId, fromByte, maxBytes },
          {
            screen: (preview) => {
              const content = windowContent(target, fromByte, preview);
              assertConfinedToolResultCredentialFree({ content });
              if (target.form === SOURCE_EXACT_ORIGINAL_FORM)
                return assertRawOutputCap(content, options.toolOutputCapBytes);
            },
          },
        );
        return {
          content: windowContent(target, fromByte, result),
          // Content-free evidence join: the access digest, never the bytes.
          details: { spanAccessSha256: result.spanAccess.spanAccessSha256 },
        };
      }
      const { spanIds } = selection;
      if (selection.maxBytes !== undefined) {
        assertSpansWithin(
          options.reader,
          observationId,
          representationId,
          spanIds,
          selection.maxBytes,
        );
      }
      let screened: { text: string; spanIds: readonly string[] } | undefined;
      const result = options.reader.read(
        { observationId, representationId, spanIds },
        {
          screen: (preview) => {
            const content = spanReadContent(target, preview);
            assertConfinedToolResultCredentialFree({ content });
            screened = preview;
            if (target.form === SOURCE_EXACT_ORIGINAL_FORM)
              return assertRawOutputCap(content, options.toolOutputCapBytes);
          },
        },
      );
      return {
        content: spanReadContent(
          target,
          screened ?? { text: result.text, spanIds: result.spanAccess.spanIds },
        ),
        // Content-free evidence join: the access digest, never the bytes.
        details: { spanAccessSha256: result.spanAccess.spanAccessSha256 },
      };
    },
  };
}

/** The content of a read by span id: the screen and the result render it alike. */
function spanReadContent(
  target: SourceTarget,
  read: {
    readonly text: string;
    readonly spanIds: readonly string[];
    readonly spans?: readonly {
      spanId: string;
      startByte: number;
      endByte: number;
      text: string;
    }[];
    readonly remainingBudgetBytes?: number;
  },
) {
  if (target.form === SOURCE_EXACT_ORIGINAL_FORM) {
    if (!target.originalIdentity || !read.spans)
      failSourceEvidenceService("observation-unavailable");
    return [
      {
        type: "text" as const,
        text: JSON.stringify({
          kind: "docsfab-source-original-span-read",
          form: SOURCE_EXACT_ORIGINAL_FORM,
          source: target.handle,
          observationId: target.observationId,
          representationId: target.representationId,
          ...target.originalIdentity,
          spanIds: read.spanIds,
          spans: read.spans,
          remainingBudgetBytes: read.remainingBudgetBytes,
        }),
      },
    ];
  }
  return [
    {
      type: "text" as const,
      text: JSON.stringify({
        kind: "docsfab-source-span-read",
        source: target.handle,
        observationId: target.observationId,
        representationId: target.representationId,
        spanIds: read.spanIds,
        text: read.text,
      }),
    },
  ];
}

/** The content of a window read: the screen and the result render it alike. */
function windowContent(target: SourceTarget, fromByte: number, window: SourceWindowPreviewV1) {
  if (target.form === SOURCE_EXACT_ORIGINAL_FORM) {
    if (!target.originalIdentity) failSourceEvidenceService("observation-unavailable");
    return [
      {
        type: "text" as const,
        text: JSON.stringify({
          kind: "docsfab-source-original-window-read",
          form: SOURCE_EXACT_ORIGINAL_FORM,
          source: target.handle,
          observationId: target.observationId,
          representationId: target.representationId,
          ...target.originalIdentity,
          fromByte,
          nextFromByte: window.nextFromByte,
          readBytes: window.readBytes,
          totalBytes: window.totalBytes,
          remainingBudgetBytes: window.remainingBudgetBytes,
          spans: window.spans,
        }),
      },
    ];
  }
  return [
    {
      type: "text" as const,
      text: JSON.stringify({
        kind: "docsfab-source-window-read",
        source: target.handle,
        observationId: target.observationId,
        representationId: target.representationId,
        fromByte,
        nextFromByte: window.nextFromByte,
        readBytes: window.readBytes,
        totalBytes: window.totalBytes,
        remainingBudgetBytes: window.remainingBudgetBytes,
        withheldSpanIds: window.withheldSpanIds,
        spans: window.spans,
      }),
    },
  ];
}

/**
 * Discover merged merge requests inside the run's enabled project scope.
 *
 * Returns bounded handles, never titles, descriptions, or diffs. Scope, window,
 * and branch are held by the host on the searcher, and an observation id outside
 * the binding fails closed before any page is read.
 */
function searchSourcesTool(
  options: SourceToolOptions,
  searcher: SourceStepSearcherV1,
  hostRoots: HostRootSet,
): AnyToolDefinition {
  return {
    name: "docsfab_search_sources",
    label: "Search discoverable sources",
    description:
      "Discover merged merge requests inside this run's enabled project scope. Returns bounded " +
      "descriptors — locator, merge-request number, merge timing, commit provenance, evidence " +
      "gaps and applicability — with a resume cursor and an explicit coverage report saying " +
      "whether the requested window was fully read. It returns no merge-request title, " +
      "description or diff text: pass a descriptor's identifiers to a source acquisition step, " +
      "and read sealed evidence with docsfab_read_source. Projects, paths, URLs, branches and " +
      "date windows cannot be named here.",
    promptSnippet: "Search discoverable merged merge requests in the enabled project scope",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: [],
      properties: {
        observationId: {
          type: "string",
          description:
            "Optional observation id from this run's sealed source binding; narrows the search to that merge request",
        },
        maxDescriptors: {
          type: "integer",
          description: "Optional descriptor ceiling for this call; the host ceiling still wins",
          minimum: 1,
          maximum: SOURCE_SEARCH_MAX_DESCRIPTORS,
        },
      },
    },
    async execute(_id: unknown, rawParams: unknown) {
      const params = (rawParams ?? {}) as Record<string, unknown>;
      if (params.maxDescriptors !== undefined && typeof params.maxDescriptors !== "number") {
        failSourceEvidenceService(
          "span-unavailable",
          `maxDescriptors must be a whole number from 1 to ${SOURCE_SEARCH_MAX_DESCRIPTORS}, or omitted.`,
          "argument-shape",
        );
      }
      const result = await searcher.search({
        ...(params.observationId === undefined
          ? {}
          : { observationId: params.observationId as string }),
        ...(params.maxDescriptors === undefined
          ? {}
          : { maxDescriptors: params.maxDescriptors as number }),
      });
      return projectSearchResult(result, hostRoots);
    },
  };
}

/**
 * Attach one claim-to-span citation. This is the only source of citations: the
 * host does not mint them from its receipts, so every sentence a step writes
 * without citing is labeled by the runner's coverage check. Run, binding,
 * revision, and receipt come from the host's access ledger, and a span this run
 * never read is refused.
 */
function citeSourceTool(
  citer: SourceStepCiterV1,
  reader: SourceStepReaderV1,
  recordFiller: ToolArgumentFillerRecorder | undefined,
): AnyToolDefinition {
  return {
    name: "docsfab_cite_source",
    label: "Cite a bound source span for a claim",
    description:
      "Attach a sentence you write into the documentation to the exact source spans that " +
      "support it. Pass the sentence verbatim as it appears on the page, the source handle " +
      "(s1, s2, ...) or the full observation and representation ids, and span ids taken from " +
      "docsfab_list_sources or docsfab_read_source. The " +
      "host verifies the spans against this run's own read receipts and refuses a span nothing in " +
      "this run read, a span outside the sealed binding, and evidence from another binding or " +
      "revision. The host checks every sentence you add to the documentation for one of these and " +
      "reports each uncited one by page and line; your status reply is not checked.",
    promptSnippet: "Cite the bound source spans that support a sentence you write",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["claim", "spanIds"],
      properties: {
        claim: {
          type: "string",
          description:
            "The exact sentence, verbatim, that these spans support, as it appears in the documentation you write",
          minLength: 1,
          maxLength: SOURCE_CITE_MAX_CLAIM_CHARACTERS,
        },
        source: {
          type: ["string", "null"],
          description: `The source the spans belong to: its handle from docsfab_list_sources (s1, s2, ...). Use it instead of observationId and representationId. ${UNUSED}`,
        },
        observationId: {
          type: ["string", "null"],
          description: `Instead of source: the full observation id, exactly. ${UNUSED}`,
        },
        representationId: {
          type: ["string", "null"],
          description: `With observationId, when that observation has more than one representation: the full representation id, exactly. ${UNUSED}`,
        },
        spanIds: {
          type: "array",
          description: "Host-issued span ids that a source-granted step read in this run",
          items: { type: "string" },
          minItems: 1,
          maxItems: SOURCE_CITE_MAX_SPANS_PER_CALL,
        },
      },
    },
    async execute(_id: unknown, rawParams: unknown) {
      const setAside: SetAside = (argument, kind) =>
        recordFiller?.({ tool: "docsfab_cite_source", argument, kind });
      const params = setAsideFiller(
        (isPlainRecord(rawParams) ? rawParams : {}) as Record<string, unknown>,
        CITE_SOURCE_ARGUMENTS,
        setAside,
      );
      const spanIds = Array.isArray(params.spanIds)
        ? params.spanIds.filter((value): value is string => typeof value === "string")
        : [];
      // Argument refusals are citation refusals; `failSourceEvidenceService`
      // would report `denied-path`.
      if (typeof params.claim !== "string" || params.claim.length === 0) {
        failSourceCitation("unsupported-claim", "The claim argument was empty.");
      }
      if (params.claim.length > SOURCE_CITE_MAX_CLAIM_CHARACTERS) {
        failSourceCitation(
          "unsupported-claim",
          `This call carried ${params.claim.length} characters of claim text; the limit SOURCE_CITE_MAX_CLAIM_CHARACTERS is ${SOURCE_CITE_MAX_CLAIM_CHARACTERS}. Cite fewer sentences per call.`,
        );
      }
      if (spanIds.length === 0) {
        failSourceCitation("unknown-span", "Name at least one span id.");
      }
      if (spanIds.length > SOURCE_CITE_MAX_SPANS_PER_CALL) {
        failSourceCitation(
          "unknown-span",
          `This call named ${spanIds.length} span ids; the limit SOURCE_CITE_MAX_SPANS_PER_CALL is ${SOURCE_CITE_MAX_SPANS_PER_CALL}. Cite fewer spans per call.`,
        );
      }
      const target = citationTarget(reader, params, setAside);
      const receipt = citer.cite({
        claim: params.claim,
        observationId: target.observationId,
        representationId: target.representationId,
        spanIds,
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              kind: "docsfab-source-span-citation-receipt",
              supportedClaimSha256: receipt.supportedClaimSha256,
              spanCitationSha256s: receipt.spanCitationSha256s,
              readingStepIds: receipt.readingStepIds,
            }),
          },
        ],
        // Content-free: counts and the claim digest, never a byte of source.
        details: {
          supportedClaimSha256: receipt.supportedClaimSha256,
          citationCount: receipt.spanCitationSha256s.length,
        },
      };
    },
  };
}

/**
 * The observation and representation a citation names. Full ids pass to the
 * citer, which judges them against the run's own ledger; a handle resolves
 * through the step's listing first, with a read's remediation under the
 * citation's own code.
 */
function citationTarget(
  reader: SourceStepReaderV1,
  params: Record<string, unknown>,
  setAside: SetAside,
): { observationId: string; representationId: string } {
  const { source, observationId, representationId } = params;
  if (
    source === undefined &&
    typeof observationId === "string" &&
    typeof representationId === "string"
  ) {
    return { observationId, representationId };
  }
  try {
    return resolveSourceTarget(reader.listSources(), params, setAside);
  } catch (error) {
    if (
      error instanceof SourceEvidenceServiceError &&
      (error.code === "observation-unavailable" || error.code === "span-unavailable")
    ) {
      failSourceCitation("unknown-span", error.remediation);
    }
    throw error;
  }
}

/**
 * Render the payload at one row ceiling shared by every list, because the bound
 * applies to the single prompt-visible blob they serialize into.
 */
function renderSearchPayload(result: SourceDiscoveryResultV1, rowLimit: number) {
  let trimmed = false;
  const cap = <T>(rows: readonly T[]): T[] => {
    const bounded = rows.slice(0, rowLimit);
    if (bounded.length < rows.length) trimmed = true;
    return bounded;
  };
  const descriptors = cap(result.descriptors);
  const inapplicable = cap(result.inapplicable);
  const coverage = {
    ...result.coverage,
    duplicateRows: cap(result.coverage.duplicateRows),
    truncatedPages: cap(result.coverage.truncatedPages),
    notRequested: cap(result.coverage.notRequested),
    excluded: cap(result.coverage.excluded),
  };
  const truncated = result.coverage.descriptorLimitReached || trimmed;
  return {
    descriptorCount: descriptors.length,
    truncated,
    text: JSON.stringify({
      kind: "docsfab-source-search",
      truncated,
      windowCovered: result.coverage.windowCovered,
      scope: {
        providerId: result.scope.providerId,
        host: result.scope.host,
        projectId: result.scope.projectId,
        projectPath: result.scope.projectPath,
      },
      descriptorCount: descriptors.length,
      descriptors,
      inapplicable,
      cursor: result.cursor,
      coverage,
    }),
  };
}

/**
 * Project a discovery result into the confined tool payload, in order:
 *
 * 1. Replace this host's roots across the untrimmed result, since
 *    `coverage.excluded[]` relays row text verbatim. Credential material, a
 *    structure the screen cannot walk, or two keys that merge once their
 *    roots are replaced, refuses the whole search.
 * 2. Cap rows, including the coverage report.
 * 3. Cap bytes, because rows are not bytes.
 *
 * `truncated` reports any trim from 2 or 3.
 */
function projectSearchResult(discovered: SourceDiscoveryResultV1, hostRoots: HostRootSet) {
  const projected = egressValue(discovered, hostRoots);
  if (!projected.ok) failSourceDiscovery(sourceDiscoveryEgressRefusal(projected.code));
  const result = projected.value;
  let rowLimit = SOURCE_SEARCH_MAX_DESCRIPTORS;
  let rendered = renderSearchPayload(result, rowLimit);
  // Shrink linearly rather than halving so the answer stays as large as the
  // ceiling allows. `rowLimit` reaching zero always terminates the loop.
  while (
    Buffer.byteLength(rendered.text, "utf8") > SOURCE_SEARCH_PAYLOAD_CEILING_BYTES &&
    rowLimit > 0
  ) {
    rowLimit -= 1;
    rendered = renderSearchPayload(result, rowLimit);
  }
  return {
    content: [{ type: "text" as const, text: rendered.text }],
    // Content-free: counts and one boolean verdict, never a descriptor.
    details: {
      descriptorCount: rendered.descriptorCount,
      windowCovered: result.coverage.windowCovered,
    },
  };
}

/** This process's roots for a model-facing tool result with these checkouts. */
export function processHostRoots(workspaceRoots: readonly string[] = []): HostRootSet {
  return processHostRootSet({ workspaceRoots });
}

/**
 * The declared argument names of a tool's schema: `true` for a scalar or
 * array, the nested names for an object, so a refusal records the call's
 * argument shape without any value.
 */
export function declaredToolArguments(
  definition: Pick<AnyToolDefinition, "parameters">,
): Record<string, readonly string[] | true> {
  const properties = (definition.parameters as { properties?: Record<string, unknown> }).properties;
  const declared: Record<string, readonly string[] | true> = {};
  for (const [name, schema] of Object.entries(properties ?? {})) {
    const nested = isPlainRecord(schema) ? schema.properties : undefined;
    declared[name] = isPlainRecord(nested) ? Object.keys(nested) : true;
  }
  return declared;
}

/**
 * How each id argument of a refused source call relates to the ids this step
 * was issued. Empty when the host could not list the sources at all; the
 * refusal code then says why.
 */
function classifySourceIds(
  reader: SourceStepReaderV1,
  params: unknown,
): Array<readonly [ToolRefusalIdArgument, ToolRefusalIdMatch]> {
  if (!isPlainRecord(params)) return [];
  let entries: readonly SourceSpanInventoryEntryV1[];
  try {
    entries = reader.listSources();
  } catch {
    return [];
  }
  const sources = listedSources(entries);
  const observations = new IssuedIds(sources.map((source) => source.observationId));
  const representations = new IssuedIds(sources.map((source) => source.representationId));
  const spans = new IssuedIds(entries.map((entry) => entry.spanId));
  const handles = new Set(sources.map((source) => source.handle));
  const paths = new Set(
    sources.flatMap((source) => (source.repositoryPath === null ? [] : [source.repositoryPath])),
  );
  const classes: Array<readonly [ToolRefusalIdArgument, ToolRefusalIdMatch]> = [];
  if (params.source !== undefined) {
    classes.push([
      "source",
      classifyIssuedId(params.source, observations, {
        handles,
        paths,
        otherKinds: [representations, spans],
      }),
    ]);
  }
  if (params.observationId !== undefined) {
    classes.push([
      "observationId",
      classifyIssuedId(params.observationId, observations, {
        handles,
        otherKinds: [representations, spans],
      }),
    ]);
  }
  if (params.representationId !== undefined) {
    classes.push([
      "representationId",
      classifyIssuedId(params.representationId, representations, {
        handles,
        otherKinds: [observations, spans],
      }),
    ]);
  }
  if (params.spanIds !== undefined) {
    const values: readonly unknown[] = Array.isArray(params.spanIds)
      ? params.spanIds
      : [params.spanIds];
    for (const value of values) {
      classes.push([
        "spanIds",
        classifyIssuedId(value, spans, {
          otherKinds: [observations, representations],
        }),
      ]);
    }
  }
  return classes;
}

/**
 * Keep refusals content-free and attributed. The service's code and detail are
 * safe: they name no path, locator, or source byte. Every refusal tells the
 * model what to change, and is recorded as a content-free row.
 */
function wrapSourceExecute(
  definition: AnyToolDefinition,
  options: SourceToolOptions,
): AnyToolDefinition {
  const execute = definition.execute.bind(definition) as (...args: any[]) => Promise<any>;
  const declared = declaredToolArguments(definition);
  const tool = definition.name as SourceToolName;
  const { recordFailure, recordRefusal, reader } = options;
  const record = (params: unknown, code: ToolRefusalCode, detailKind: ToolRefusalDetailKind) => {
    if (!recordRefusal) return;
    recordRefusal({
      tool,
      code,
      detailKind,
      ...toolArgumentKeys(params, declared),
      idMatches: idMatchEntries(classifySourceIds(reader, params)),
    });
  };
  return {
    ...definition,
    async execute(...args: any[]) {
      try {
        return await execute(...args);
      } catch (error) {
        const params: unknown = args[1];
        if (error instanceof SourceEvidenceServiceError) {
          record(params, error.code, error.detailKind);
          // The credential screen's own refusal, as the confined result screen
          // would have raised it, so the model sees the same boundary message.
          if (error.code === "credential-withheld") {
            // hygiene: ok -- the argument names the boundary; the error carries its own fixed message.
            throw new CredentialBoundaryError("confined-tool-result");
          }
          recordFailure("denied-path");
          throw new Error(
            `DocsFab refused this source read because the host reported ${error.code}. ${error.remediation} No source text was returned.`,
          );
        }
        if (error instanceof SourceCitationError) {
          record(params, error.code, "citation");
          // Not `denied-path`, which would tell the operator a path was refused.
          // No refused span id, claim, or locator enters the message.
          recordFailure("citation-refused");
          throw new Error(
            `DocsFab refused this source citation because the host reported ${error.code}. ${error.detail ?? SOURCE_CITATION_REFUSALS[error.code]} No citation was recorded.`,
          );
        }
        if (error instanceof SourceDiscoveryError) {
          record(params, error.code, "discovery");
          // The remediation table is content-free.
          recordFailure("denied-path");
          throw new Error(
            `DocsFab refused this source search because the host reported ${error.code}. ${SOURCE_DISCOVERY_REFUSALS[error.code]} No descriptor was returned to this step.`,
          );
        }
        record(params, "tool-defect", "tool-defect");
        recordFailure("tool-defect");
        throw new Error("DocsFab could not complete this source read and recorded a tool defect.");
      }
    },
  };
}
