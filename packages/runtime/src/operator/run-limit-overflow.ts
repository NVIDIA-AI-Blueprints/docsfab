// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { formatLimitObservation, limit, type ResolveLimitsOptions } from "../config/limits.js";
import { LIMIT_DEFINITION_BY_NAME } from "../config/limits.generated.js";
import {
  isContextPreflightCauseReason,
  type ContextPreflightCause,
  type ContextPreflightCauseReason,
  type ContextPreflightLimitEvidence,
} from "../context/contracts.js";
import {
  repositoryInventoryLineCode,
  REPOSITORY_NAVIGATION_MAX_SOURCE_BYTES_LIMIT,
  REPOSITORY_NAVIGATION_MAX_SOURCES_LIMIT,
  REPOSITORY_NAVIGATION_MAX_TARGET_BYTES_LIMIT,
  REPOSITORY_NAVIGATION_MAX_TARGETS_LIMIT,
  REPOSITORY_NAVIGATION_MAX_TOTAL_SOURCE_BYTES_LIMIT,
  REPOSITORY_NAVIGATION_MAX_TOTAL_TARGET_BYTES_LIMIT,
} from "../config/repository-discovery-limits.js";
import {
  CONTENT_INDEX_ASSET_WARNING_CODE,
  CONTENT_INDEX_INCOMPLETE_WARNING_CODE,
  CONTENT_INDEX_NAME_WARNING_CODE,
} from "../content-ir/contracts.js";
import { WRITTEN_PAGE_ANCHOR_WARNING_CODE } from "../impact/contracts.js";
import { readFirstPassEvidenceGapLines } from "../cli/first-pass-evidence-gaps.js";
import { SOURCE_READ_PARTIAL_CODE } from "../inputs/source-evidence-artifacts.js";
import { READING_SOURCE_NOTICE_CODE } from "../cli/first-pass-reading-sources.js";
import { formatSourceRepresentationLimitations } from "../inputs/source-extraction.js";
import type { SourceRepresentationV1, SourceLimitOverflowV1 } from "../inputs/source-evidence.js";
import { parseJsonEvidence } from "../json-evidence.js";
import type { RunRecord, ToolResultArchiveSnapshotV1 } from "../records/contracts.js";
import { SAFE_RECORD_ID } from "../records/file-store.js";
import {
  assertRunNotTombstoned,
  RunMaintenanceGateError,
  withActiveRunGate,
  withRunMaintenanceGate,
} from "../records/run-maintenance-gate.js";
import {
  decodeRepositoryDiscoveryInventory,
  formatRepositoryInventoryLimitations,
  type RepositoryDiscoveryInventoryV1,
} from "../repository/inventory.js";
import {
  formatRepositoryNavigationLimitations,
  type RepositoryNavigationObservationV1,
} from "../repository/navigation-observation.js";
import { isRecord, hasErrnoCode } from "../shared/primitives.js";
import { SEARCH_BRIEF_OMISSION_CODE } from "../search/model-search-brief.js";

/** Sealed overflow evidence the operator footer and JSON envelope may project. */
export interface RunLimitOverflowEvidenceV1 {
  readonly inventory?: RepositoryDiscoveryInventoryV1;
  readonly navigation?: RepositoryNavigationObservationV1;
  readonly sourceRepresentations?: readonly Pick<
    SourceRepresentationV1,
    "limitations" | "overflows"
  >[];
  readonly toolResultArchives?: readonly ToolResultArchiveSnapshotV1[];
  /** Context packets a step got trimmed, withheld, or without some requested pages. */
  readonly contextPackets?: readonly ContextPacketLimitationV1[];
  /** Search-brief omissions the runner recorded when each step ran. */
  readonly searchBriefOmissions?: readonly string[];
  /**
   * Evidence gaps a first pass continued with, how it ended, and the bounds
   * it reached (#2113), as the queued record kept them.
   */
  readonly firstPassEvidenceGaps?: readonly string[];
  /** Required sources a write step started writing with only part of them read. */
  readonly sourceReadPartials?: readonly string[];
  /** Anchor problems the run wrote into a page, as impact postflight recorded them. */
  readonly writtenAnchorWarnings?: readonly string[];
  /** Linked assets a workflow search's workspace content index left out past a limit. */
  readonly leftOutAssetWarnings?: readonly string[];
  /**
   * Inventory lines that governed search recorded for any workflow, even when
   * the run keeps no inventory: clips at `repository.inventoryMaxEntries`,
   * files a text index limit left out, and files left out because they are
   * not UTF-8 text (#1927, #1932).
   */
  readonly inventoryLimitations?: readonly string[];
  /** Files a step's context preflight left out of the content index under their on-disk names. */
  readonly leftOutNameWarnings?: readonly string[];
  /**
   * A workspace content index the repository inventory could not build,
   * naming the page and the reason, as governed search recorded it (#1932).
   */
  readonly contentIndexIncompleteWarnings?: readonly string[];
  /** Sources the admitted request reading named that first pass did not bind. */
  readonly readingSourceNotices?: readonly string[];
  readonly limits?: ResolveLimitsOptions;
}

/**
 * One step whose context packet fell short: over its budget and trimmed to
 * fit, replaced by the hosted capsule projection, withheld so a read-only step
 * ran without one, or stopping a write step; or, with no budget cause, not
 * binding every requested page (`unbound`). `unboundTargets` names the
 * requested pages the packet does not bind. A step left without a packet of
 * its own by a coded cause, such as a content index refusal, carries that
 * `reason` and `cause` instead of a `limit`.
 */
export interface ContextPacketLimitationV1 {
  readonly stepId: string;
  readonly limit?: ContextPreflightLimitEvidence;
  readonly disposition: "trimmed" | "capsule" | "withheld" | "stopped" | "unbound";
  readonly unboundTargets?: readonly string[];
  /** Requested pages without context whose paths the record cannot hold. */
  readonly unboundTargetsOmitted?: number;
  readonly reason?: ContextPreflightCauseReason;
  readonly cause?: ContextPreflightCause;
}

/** The ontology version the hosted capsule projection records in place of a compiled packet. */
const HOSTED_CAPSULE_ONTOLOGY_VERSION = "hosted-v1";

const SIDECAR_KIND = "docsfab-run-limit-overflow";
const NAVIGATION_OVERFLOW_CODE_BY_LIMIT: Readonly<Record<string, string>> = Object.freeze({
  [REPOSITORY_NAVIGATION_MAX_SOURCES_LIMIT]: "source-budget-exceeded",
  [REPOSITORY_NAVIGATION_MAX_SOURCE_BYTES_LIMIT]: "source-too-large",
  [REPOSITORY_NAVIGATION_MAX_TOTAL_SOURCE_BYTES_LIMIT]: "source-budget-exceeded",
  [REPOSITORY_NAVIGATION_MAX_TARGETS_LIMIT]: "target-budget-exceeded",
  [REPOSITORY_NAVIGATION_MAX_TARGET_BYTES_LIMIT]: "target-too-large",
  [REPOSITORY_NAVIGATION_MAX_TOTAL_TARGET_BYTES_LIMIT]: "target-budget-exceeded",
});

/** Sidecar next to `{runId}.json` so `runs show` can replay source overflow. */
export function runLimitOverflowSidecarPath(recordPath: string): string {
  return recordPath.replace(/\.json$/u, ".limit-overflow.json");
}

/**
 * Read inventory, reconstructed navigation, and any sealed overflow already
 * stored on the saved run. Source-representation overflow is not a run-record
 * field; callers merge the execution or sidecar evidence for that axis.
 */
export function collectRunLimitOverflowEvidence(record: RunRecord): RunLimitOverflowEvidenceV1 {
  let inventory: RepositoryDiscoveryInventoryV1 | undefined;
  for (const step of record.steps) {
    const decoded = decodeInventory(step.repositoryBatchAuthority?.inventory);
    if (decoded) inventory = decoded;
  }
  const navigation = inventory ? navigationFromInventory(inventory) : undefined;
  const toolResultArchives = collectToolResultArchives(record);
  const contextPackets = collectContextPacketLimitations(record);
  const searchBriefOmissions = (record.evidenceWarnings ?? []).filter((warning) =>
    warning.startsWith(`${SEARCH_BRIEF_OMISSION_CODE}:`),
  );
  const firstPassEvidenceGaps = readFirstPassEvidenceGapLines(record);
  const sourceReadPartials = (record.evidenceWarnings ?? []).filter((warning) =>
    warning.startsWith(`${SOURCE_READ_PARTIAL_CODE}:`),
  );
  const writtenAnchorWarnings = (record.evidenceWarnings ?? []).filter((warning) =>
    warning.startsWith(`${WRITTEN_PAGE_ANCHOR_WARNING_CODE}:`),
  );
  const leftOutAssetWarnings = (record.evidenceWarnings ?? []).filter((warning) =>
    warning.startsWith(`${CONTENT_INDEX_ASSET_WARNING_CODE}:`),
  );
  const inventoryLimitations = (record.evidenceWarnings ?? []).filter(
    (warning) => repositoryInventoryLineCode(warning) !== undefined,
  );
  const contentIndexIncompleteWarnings = (record.evidenceWarnings ?? []).filter((warning) =>
    warning.startsWith(`${CONTENT_INDEX_INCOMPLETE_WARNING_CODE}:`),
  );
  const leftOutNameWarnings = (record.evidenceWarnings ?? []).filter((warning) =>
    warning.startsWith(`${CONTENT_INDEX_NAME_WARNING_CODE}:`),
  );
  const readingSourceNotices = (record.evidenceWarnings ?? []).filter((warning) =>
    warning.startsWith(`${READING_SOURCE_NOTICE_CODE}:`),
  );
  return {
    ...(inventory ? { inventory } : {}),
    ...(navigation ? { navigation } : {}),
    ...(toolResultArchives.length > 0 ? { toolResultArchives } : {}),
    ...(contextPackets.length > 0 ? { contextPackets } : {}),
    ...(searchBriefOmissions.length > 0 ? { searchBriefOmissions } : {}),
    ...(firstPassEvidenceGaps.length > 0 ? { firstPassEvidenceGaps } : {}),
    ...(sourceReadPartials.length > 0 ? { sourceReadPartials } : {}),
    ...(writtenAnchorWarnings.length > 0 ? { writtenAnchorWarnings } : {}),
    ...(leftOutAssetWarnings.length > 0 ? { leftOutAssetWarnings } : {}),
    ...(inventoryLimitations.length > 0 ? { inventoryLimitations } : {}),
    ...(leftOutNameWarnings.length > 0 ? { leftOutNameWarnings } : {}),
    ...(contentIndexIncompleteWarnings.length > 0 ? { contentIndexIncompleteWarnings } : {}),
    ...(readingSourceNotices.length > 0 ? { readingSourceNotices } : {}),
  };
}

/**
 * Steps whose recorded context fell short: a packet over its token budget, a
 * coded cause that left the step no packet of its own, or one that does not
 * bind every requested page.
 */
function collectContextPacketLimitations(record: RunRecord): ContextPacketLimitationV1[] {
  return (Array.isArray(record.steps) ? record.steps : []).flatMap(
    (step): ContextPacketLimitationV1[] => {
      const context = step.contextPreflight;
      const unboundTargets = context?.unboundTargets?.length ? context.unboundTargets : undefined;
      const unboundTargetsOmitted = context?.unboundTargetsOmitted
        ? context.unboundTargetsOmitted
        : undefined;
      const unbound = {
        ...(unboundTargets ? { unboundTargets } : {}),
        ...(unboundTargetsOmitted ? { unboundTargetsOmitted } : {}),
      };
      if (isContextPreflightCauseReason(context?.reason) && context.cause) {
        return [
          {
            stepId: step.id,
            disposition:
              context.packetDigest !== undefined
                ? ("capsule" as const)
                : step.mode === "write"
                  ? ("stopped" as const)
                  : ("withheld" as const),
            reason: context.reason,
            cause: context.cause,
          },
        ];
      }
      if (context?.reason === "preflight-budget-exceeded" && context.limit?.unit === "tokens") {
        return [
          {
            stepId: step.id,
            limit: context.limit,
            disposition:
              context.packetDigest === undefined
                ? step.status === "failed"
                  ? ("stopped" as const)
                  : ("withheld" as const)
                : context.ontologyVersion === HOSTED_CAPSULE_ONTOLOGY_VERSION
                  ? ("capsule" as const)
                  : ("trimmed" as const),
            ...unbound,
          },
        ];
      }
      return unboundTargets || unboundTargetsOmitted
        ? [{ stepId: step.id, disposition: "unbound", ...unbound }]
        : [];
    },
  );
}

/**
 * One operator line per step: the share, the budget it gave this run's
 * window, what was measured, what the step did, and the requested pages that
 * got no context. A trimmed packet reports its size before the trim; a step
 * that got no packet reports its smallest packet, the first target alone,
 * which is the size a budget must reach.
 */
function formatContextPacketLines(limitations: readonly ContextPacketLimitationV1[]): string[] {
  return limitations.map(
    ({
      stepId,
      limit: bound,
      disposition,
      unboundTargets,
      unboundTargetsOmitted,
      reason,
      cause,
    }) => {
      if (reason && cause) {
        const outcome =
          disposition === "capsule"
            ? "ran with the host capsule in place of a context packet"
            : disposition === "stopped"
              ? "stopped before it called the model, because a write step needs a context packet"
              : "ran without a context packet";
        return `${reason}: step "${stepId}" ${outcome} (${cause.code}): ${cause.message}`;
      }
      const unbound = unboundPagesSentence(unboundTargets ?? [], unboundTargetsOmitted ?? 0);
      if (!bound) {
        return `scope-target-partially-unresolved: step "${stepId}" context packet does not bind every requested page.${unbound}`;
      }
      const definition = LIMIT_DEFINITION_BY_NAME[bound.name];
      const budget = `the ${bound.configured}-token budget that ${bound.name} gives this run's input window`;
      const measured =
        disposition === "trimmed"
          ? `context packet measured ${bound.observed} estimated tokens before the trim, over ${budget}; it ran with the packet trimmed to fit.`
          : `smallest context packet, its first target alone, measured ${bound.observed} estimated tokens, over ${budget}; ${
              disposition === "capsule"
                ? "it ran with the host capsule in place of the packet"
                : disposition === "withheld"
                  ? "it ran without a packet"
                  : "the write step stopped, because it needs a packet"
            }.`;
      return `${definition?.refusal ?? "preflight-budget-exceeded"}: step "${stepId}" ${measured}${unbound}${definition ? ` ${definition.remediation}` : ""}`;
    },
  );
}

/**
 * The requested pages a step got no context for: each by name, and a count of
 * the ones whose paths the record cannot hold. Empty when there are none.
 */
function unboundPagesSentence(names: readonly string[], omitted: number): string {
  if (names.length === 0 && omitted === 0) return "";
  const unnamed = `${omitted} ${names.length > 0 ? "more " : ""}whose ${omitted === 1 ? "path" : "paths"} the record cannot hold`;
  const listed =
    names.length === 0
      ? unnamed
      : omitted === 0
        ? names.join(", ")
        : `${names.join(", ")}, and ${unnamed}`;
  return ` Requested pages without context: ${listed}.`;
}

/** Last explicit part wins for inventory/navigation/limits; representations union. */
export function mergeRunLimitOverflowEvidence(
  ...parts: ReadonlyArray<RunLimitOverflowEvidenceV1 | undefined>
): RunLimitOverflowEvidenceV1 | undefined {
  let inventory: RepositoryDiscoveryInventoryV1 | undefined;
  let navigation: RepositoryNavigationObservationV1 | undefined;
  let limits: ResolveLimitsOptions | undefined;
  type RepresentationPick = Pick<SourceRepresentationV1, "limitations" | "overflows">;
  const representations = new Map<string, RepresentationPick>();
  const archives = new Map<string, ToolResultArchiveSnapshotV1>();
  const packetLimitations = new Map<string, ContextPacketLimitationV1>();
  const omissions = new Set<string>();
  const firstPassGaps = new Set<string>();
  const partialReads = new Set<string>();
  const anchorWarnings = new Set<string>();
  const assetWarnings = new Set<string>();
  const inventoryClips = new Set<string>();
  const nameWarnings = new Set<string>();
  const contentIndexWarnings = new Set<string>();
  const readingNotices = new Set<string>();
  for (const part of parts) {
    if (!part) continue;
    if (part.inventory) inventory = part.inventory;
    if (part.navigation) navigation = part.navigation;
    if (part.limits) limits = part.limits;
    for (const representation of part.sourceRepresentations ?? []) {
      representations.set(JSON.stringify(representation), representation);
    }
    for (const archive of part.toolResultArchives ?? []) {
      archives.set(JSON.stringify(archive), archive);
    }
    for (const limitation of part.contextPackets ?? []) {
      packetLimitations.set(JSON.stringify(limitation), limitation);
    }
    for (const omission of part.searchBriefOmissions ?? []) omissions.add(omission);
    for (const gap of part.firstPassEvidenceGaps ?? []) firstPassGaps.add(gap);
    for (const partialRead of part.sourceReadPartials ?? []) partialReads.add(partialRead);
    for (const warning of part.writtenAnchorWarnings ?? []) anchorWarnings.add(warning);
    for (const warning of part.leftOutAssetWarnings ?? []) assetWarnings.add(warning);
    for (const clip of part.inventoryLimitations ?? []) inventoryClips.add(clip);
    for (const warning of part.leftOutNameWarnings ?? []) nameWarnings.add(warning);
    for (const warning of part.contentIndexIncompleteWarnings ?? []) {
      contentIndexWarnings.add(warning);
    }
    for (const notice of part.readingSourceNotices ?? []) readingNotices.add(notice);
  }
  const sourceRepresentations = [...representations.values()];
  const toolResultArchives = [...archives.values()];
  const contextPackets = [...packetLimitations.values()];
  const searchBriefOmissions = [...omissions];
  const firstPassEvidenceGaps = [...firstPassGaps];
  const sourceReadPartials = [...partialReads];
  const writtenAnchorWarnings = [...anchorWarnings];
  const leftOutAssetWarnings = [...assetWarnings];
  const inventoryLimitations = [...inventoryClips];
  const leftOutNameWarnings = [...nameWarnings];
  const contentIndexIncompleteWarnings = [...contentIndexWarnings];
  const readingSourceNotices = [...readingNotices];
  if (
    !inventory &&
    !navigation &&
    sourceRepresentations.length === 0 &&
    contextPackets.length === 0 &&
    toolResultArchives.length === 0 &&
    searchBriefOmissions.length === 0 &&
    firstPassEvidenceGaps.length === 0 &&
    sourceReadPartials.length === 0 &&
    writtenAnchorWarnings.length === 0 &&
    leftOutAssetWarnings.length === 0 &&
    inventoryLimitations.length === 0 &&
    leftOutNameWarnings.length === 0 &&
    contentIndexIncompleteWarnings.length === 0 &&
    readingSourceNotices.length === 0
  ) {
    return undefined;
  }
  return {
    ...(inventory ? { inventory } : {}),
    ...(navigation ? { navigation } : {}),
    ...(sourceRepresentations.length > 0 ? { sourceRepresentations } : {}),
    ...(contextPackets.length > 0 ? { contextPackets } : {}),
    ...(toolResultArchives.length > 0 ? { toolResultArchives } : {}),
    ...(searchBriefOmissions.length > 0 ? { searchBriefOmissions } : {}),
    ...(firstPassEvidenceGaps.length > 0 ? { firstPassEvidenceGaps } : {}),
    ...(sourceReadPartials.length > 0 ? { sourceReadPartials } : {}),
    ...(writtenAnchorWarnings.length > 0 ? { writtenAnchorWarnings } : {}),
    ...(leftOutAssetWarnings.length > 0 ? { leftOutAssetWarnings } : {}),
    ...(inventoryLimitations.length > 0 ? { inventoryLimitations } : {}),
    ...(leftOutNameWarnings.length > 0 ? { leftOutNameWarnings } : {}),
    ...(contentIndexIncompleteWarnings.length > 0 ? { contentIndexIncompleteWarnings } : {}),
    ...(readingSourceNotices.length > 0 ? { readingSourceNotices } : {}),
    ...(limits ? { limits } : {}),
  };
}

/**
 * Project sealed overflow into operator lines. When navigation evidence is
 * present, inventory's copied `navigation-observation-incomplete` lines are
 * omitted so the footer does not print the same overflow twice.
 */
export function projectRunLimitOverflowLines(
  evidence: RunLimitOverflowEvidenceV1 | undefined,
): readonly string[] {
  if (!evidence) return [];
  // Decided before the first step, so they lead.
  const lines: string[] = [...(evidence.readingSourceNotices ?? [])];
  const recordedClips = evidence.inventoryLimitations ?? [];
  const recordedCodes = new Set(recordedClips.map(repositoryInventoryLineCode));
  const recordedContentIndex = evidence.contentIndexIncompleteWarnings ?? [];
  // First pass runs before every step, so its evidence gaps lead (#2113).
  lines.push(...(evidence.firstPassEvidenceGaps ?? []));
  if (evidence.inventory) {
    const inventoryLines = formatRepositoryInventoryLimitations(
      evidence.inventory,
      evidence.limits,
    ).filter((line) => {
      // A line the run recorded when it searched names the bound it ran
      // under; it replaces the line recomputed from the kept inventory with
      // the same code, and the recorded content index line names its reason.
      const code = repositoryInventoryLineCode(line);
      if (code !== undefined && recordedCodes.has(code)) return false;
      return (
        recordedContentIndex.length === 0 ||
        !line.startsWith("repository-inventory-content-index-incomplete")
      );
    });
    lines.push(
      ...(evidence.navigation
        ? inventoryLines.filter((line) => !line.startsWith("navigation-observation-incomplete"))
        : inventoryLines),
    );
  }
  lines.push(...recordedClips);
  lines.push(...recordedContentIndex);
  if (evidence.navigation) {
    lines.push(...formatRepositoryNavigationLimitations(evidence.navigation, evidence.limits));
  }
  for (const representation of evidence.sourceRepresentations ?? []) {
    lines.push(...formatSourceRepresentationLimitations(representation, evidence.limits));
  }
  lines.push(...formatContextPacketLines(evidence.contextPackets ?? []));
  lines.push(
    ...formatToolResultArchiveRefusalLines(evidence.toolResultArchives ?? [], evidence.limits),
  );
  lines.push(...(evidence.searchBriefOmissions ?? []));
  lines.push(...(evidence.sourceReadPartials ?? []));
  lines.push(...(evidence.writtenAnchorWarnings ?? []));
  lines.push(...(evidence.leftOutAssetWarnings ?? []));
  lines.push(...(evidence.leftOutNameWarnings ?? []));
  return Object.freeze([...new Set(lines)]);
}

/**
 * Collect sealed source overflow from an acquired binding. Missing or partial
 * acquired shapes return no representations instead of throwing after the
 * workflow has already succeeded.
 */
export function overflowSourceRepresentationsFromAcquired(
  acquired: unknown,
): RunLimitOverflowEvidenceV1["sourceRepresentations"] {
  if (!isRecord(acquired) || !Array.isArray(acquired.acquired)) return undefined;
  const representations = acquired.acquired.flatMap((entry) => {
    if (!isRecord(entry) || !isRecord(entry.representation)) return [];
    const representation = entry.representation;
    const limitations = Array.isArray(representation.limitations)
      ? representation.limitations.filter((item): item is string => typeof item === "string")
      : [];
    const overflows = Array.isArray(representation.overflows)
      ? representation.overflows.filter((row): row is SourceLimitOverflowV1 => {
          return (
            isRecord(row) &&
            typeof row.limitation === "string" &&
            typeof row.limitName === "string" &&
            typeof row.observed === "number"
          );
        })
      : [];
    if (limitations.length === 0 && overflows.length === 0) return [];
    return [
      {
        limitations: limitations as SourceRepresentationV1["limitations"],
        ...(overflows.length > 0 ? { overflows } : {}),
      },
    ];
  });
  return representations.length > 0 ? representations : undefined;
}

export function inventoryHasLimitOverflow(inventory: RepositoryDiscoveryInventoryV1): boolean {
  return inventory.failures.some(
    (failure) => failure.category === "entry-limit-exceeded" || failure.overflow !== undefined,
  );
}

export async function persistRunLimitOverflowSidecar(input: {
  readonly recordPath: string;
  readonly runId: string;
  readonly evidence: RunLimitOverflowEvidenceV1 | undefined;
}): Promise<void> {
  const body = serializeSidecar(input.runId, input.evidence);
  if (!body) return;
  if (!SAFE_RECORD_ID.test(input.runId) || basename(input.recordPath) !== `${input.runId}.json`) {
    throw new RunMaintenanceGateError("unsafe"); // hygiene: ok -- typed gate code; its constructor supplies the operator-safe message.
  }
  const root = await realpath(dirname(input.recordPath));
  const sidecar = runLimitOverflowSidecarPath(join(root, `${input.runId}.json`));
  await withRunMaintenanceGate(root, () =>
    withActiveRunGate(root, input.runId, async () => {
      await assertRunNotTombstoned(root, input.runId);
      const previous = await lstat(sidecar).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      });
      if (
        previous &&
        (!previous.isFile() ||
          previous.isSymbolicLink() ||
          previous.nlink !== 1 ||
          previous.uid !== process.getuid?.() ||
          (previous.mode & 0o077) !== 0)
      ) {
        throw new RunMaintenanceGateError("unsafe"); // hygiene: ok -- typed gate code; its constructor supplies the operator-safe message.
      }
      const pending = join(root, `.${input.runId}.limit-overflow.${randomUUID()}.tmp`);
      const handle = await open(
        pending,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await handle.writeFile(`${JSON.stringify(body, null, 2)}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await rename(pending, sidecar);
      } finally {
        await unlink(pending).catch(() => undefined);
      }
    }),
  );
}

export async function loadRunLimitOverflowSidecar(
  recordPath: string,
  expectedRunId: string,
): Promise<RunLimitOverflowEvidenceV1 | undefined> {
  let raw: string;
  try {
    raw = await readFile(runLimitOverflowSidecarPath(recordPath), "utf8");
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) return undefined;
    return undefined;
  }
  try {
    return decodeSidecar(parseJsonEvidence(raw), expectedRunId);
  } catch {
    return undefined;
  }
}

function serializeSidecar(
  runId: string,
  evidence: RunLimitOverflowEvidenceV1 | undefined,
): Record<string, unknown> | undefined {
  if (!evidence) return undefined;
  const inventory = evidence.inventory ? asPlainJson(evidence.inventory) : undefined;
  const navigation = evidence.navigation ? asPlainJson(evidence.navigation) : undefined;
  const sourceRepresentations = (evidence.sourceRepresentations ?? []).map((row) => ({
    limitations: [...row.limitations],
    ...(row.overflows ? { overflows: row.overflows.map((entry) => ({ ...entry })) } : {}),
  }));
  if (!inventory && !navigation && sourceRepresentations.length === 0) return undefined;
  return {
    schemaVersion: 1,
    kind: SIDECAR_KIND,
    runId,
    ...(inventory ? { inventory } : {}),
    ...(navigation ? { navigation } : {}),
    ...(sourceRepresentations.length > 0 ? { sourceRepresentations } : {}),
  };
}

function decodeSidecar(
  value: unknown,
  expectedRunId: string,
): RunLimitOverflowEvidenceV1 | undefined {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.kind !== SIDECAR_KIND) {
    return undefined;
  }
  if (value.runId !== expectedRunId) return undefined;
  const inventory = decodeInventory(value.inventory);
  const navigation = decodeNavigation(value.navigation);
  const sourceRepresentations = decodeSourceRepresentationPicks(value.sourceRepresentations);
  return mergeRunLimitOverflowEvidence({
    ...(inventory ? { inventory } : {}),
    ...(navigation ? { navigation } : {}),
    ...(sourceRepresentations ? { sourceRepresentations } : {}),
  });
}

function decodeInventory(value: unknown): RepositoryDiscoveryInventoryV1 | undefined {
  if (value === undefined) return undefined;
  const plain = asPlainJson(value);
  if (plain === undefined) return undefined;
  try {
    return decodeRepositoryDiscoveryInventory(plain);
  } catch {
    return undefined;
  }
}

function decodeNavigation(value: unknown): RepositoryNavigationObservationV1 | undefined {
  if (!isRecord(value) || !Array.isArray(value.failures)) return undefined;
  const failures = value.failures.flatMap((row) => {
    if (!isRecord(row) || typeof row.code !== "string" || typeof row.path !== "string") {
      return [];
    }
    if (typeof row.adapter !== "string" || typeof row.evidenceSha256 !== "string") return [];
    const overflow = isRecord(row.overflow)
      ? {
          limitName: String(row.overflow.limitName),
          ...(typeof row.overflow.observed === "number" ? { observed: row.overflow.observed } : {}),
        }
      : undefined;
    return [
      {
        adapter: row.adapter as RepositoryNavigationObservationV1["failures"][number]["adapter"],
        code: row.code,
        path: row.path,
        evidenceSha256: row.evidenceSha256,
        ...(overflow ? { overflow } : {}),
      },
    ];
  });
  if (failures.length === 0) return undefined;
  return {
    schemaVersion: 1,
    kind: "docsfab-repository-navigation-observation",
    repositoryRevision:
      typeof value.repositoryRevision === "string" ? value.repositoryRevision : "",
    status: value.status === "complete" ? "complete" : "incomplete",
    graphEdgeCount: typeof value.graphEdgeCount === "number" ? value.graphEdgeCount : 0,
    navigationEdgeCount:
      typeof value.navigationEdgeCount === "number" ? value.navigationEdgeCount : 0,
    paths: Array.isArray(value.paths)
      ? value.paths.filter((path): path is string => typeof path === "string")
      : [],
    sources: [],
    routes: [],
    failures,
    contentIndexSha256:
      typeof value.contentIndexSha256 === "string" ? value.contentIndexSha256 : null,
    evidenceSha256:
      typeof value.evidenceSha256 === "string" ? value.evidenceSha256 : "0".repeat(64),
  };
}

function decodeSourceRepresentationPicks(
  value: unknown,
): RunLimitOverflowEvidenceV1["sourceRepresentations"] {
  if (!Array.isArray(value)) return undefined;
  const representations = value.flatMap((row) => {
    if (!isRecord(row) || !Array.isArray(row.limitations)) return [];
    const limitations = row.limitations.filter((item): item is string => typeof item === "string");
    const overflows = Array.isArray(row.overflows)
      ? row.overflows.flatMap((entry) => {
          if (
            !isRecord(entry) ||
            typeof entry.limitation !== "string" ||
            typeof entry.limitName !== "string" ||
            typeof entry.observed !== "number"
          ) {
            return [];
          }
          return [
            {
              limitation: entry.limitation as SourceLimitOverflowV1["limitation"],
              limitName: entry.limitName,
              observed: entry.observed,
            } satisfies SourceLimitOverflowV1,
          ];
        })
      : undefined;
    return [
      {
        limitations: limitations as SourceRepresentationV1["limitations"],
        ...(overflows && overflows.length > 0 ? { overflows } : {}),
      },
    ];
  });
  return representations.length > 0 ? representations : undefined;
}

function formatToolResultArchiveRefusalLines(
  snapshots: readonly ToolResultArchiveSnapshotV1[],
  options?: ResolveLimitsOptions,
): readonly string[] {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const snapshot of snapshots) {
    for (const refusal of snapshot.refusals) {
      const line = formatLimitObservation(
        { ...limit(refusal.limitName, options), value: snapshot.ceilingBytes },
        refusal.observedBytes,
      );
      if (seen.has(line)) continue;
      seen.add(line);
      lines.push(line);
    }
  }
  return lines;
}

function collectToolResultArchives(record: RunRecord): ToolResultArchiveSnapshotV1[] {
  const archives: ToolResultArchiveSnapshotV1[] = [];
  const seen = new Set<string>();
  const consider = (snapshot: ToolResultArchiveSnapshotV1 | undefined) => {
    if (!snapshot || !Array.isArray(snapshot.refusals) || snapshot.refusals.length === 0) {
      return;
    }
    const key = JSON.stringify(snapshot);
    if (seen.has(key)) return;
    seen.add(key);
    archives.push(snapshot);
  };
  for (const step of record.steps ?? []) {
    consider(toolResultArchiveFromCarrier(step));
    const attempts = isRecord(step) ? step.inference : undefined;
    const attemptList = isRecord(attempts) ? attempts.attempts : undefined;
    if (!Array.isArray(attemptList)) continue;
    for (const attempt of attemptList) {
      consider(toolResultArchiveFromCarrier(attempt));
    }
  }
  return archives;
}

function toolResultArchiveFromCarrier(value: unknown): ToolResultArchiveSnapshotV1 | undefined {
  if (!isRecord(value) || !isRecord(value.tools)) return undefined;
  const snapshot = value.tools.toolResultArchive;
  return isRecord(snapshot) ? (snapshot as unknown as ToolResultArchiveSnapshotV1) : undefined;
}

export function navigationFromInventory(
  inventory: RepositoryDiscoveryInventoryV1,
): RepositoryNavigationObservationV1 | undefined {
  const sources = inventory.navigation.sources ?? [];
  const failures = inventory.failures.flatMap((failure) => {
    if (
      failure.category !== "navigation-observation-incomplete" ||
      !failure.overflow ||
      !failure.path
    ) {
      return [];
    }
    const code = NAVIGATION_OVERFLOW_CODE_BY_LIMIT[failure.overflow.limitName];
    if (!code) return [];
    const adapter =
      sources.find((source) => source.path === failure.path)?.adapter ??
      sources[0]?.adapter ??
      "mkdocs-yaml-v1";
    return [
      {
        adapter,
        code,
        path: failure.path,
        evidenceSha256: failure.evidenceSha256,
        overflow: failure.overflow,
      },
    ];
  });
  if (failures.length === 0) return undefined;
  return {
    schemaVersion: 1,
    kind: "docsfab-repository-navigation-observation",
    repositoryRevision: inventory.repositoryRevision,
    status: "incomplete",
    graphEdgeCount: inventory.navigation.graphEdgeCount,
    navigationEdgeCount: inventory.navigation.navigationEdgeCount,
    paths: inventory.navigation.paths,
    sources,
    routes: inventory.navigation.routes ?? [],
    failures,
    contentIndexSha256: inventory.contentIndex.indexSha256,
    evidenceSha256: inventory.navigation.evidenceSha256,
  };
}

function asPlainJson(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return undefined;
  }
}
