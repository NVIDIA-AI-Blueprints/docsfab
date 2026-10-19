// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type LiveAttachedSourceV1, type SourceCommandOutcomeV1 } from "./contracts.js";
import type { LiveAgentChangeReviewSelectionV1 } from "../change-review.js";
import {
  PURGE_PREVIEW_MAX_ROWS,
  SESSION_SOURCE_COPY_KIND_MESSAGES,
  SOURCE_STATE_OPERATION_MESSAGES,
  type SourcePurgeSessionPreviewV1,
} from "../source-custody.js";

function renderEntry(
  entry: LiveAttachedSourceV1,
  revalidationWindowLabel: string,
): readonly string[] {
  return [
    `  ${entry.label}`,
    `    Format          ${entry.format}`,
    `    Status          ${entry.status}`,
    `    Version         ${entry.version ?? "not read yet"}`,
    `    Limitations     ${entry.limitations.length > 0 ? entry.limitations.join(", ") : "none recorded"}`,
    // Always with its basis, and flagged when beyond the window, so an old
    // verdict does not read as current.
    `    Revalidated     ${
      entry.revalidation === null
        ? "not revalidated in this conversation"
        : `${entry.revalidation.state} (${entry.revalidation.basis})${
            entry.revalidation.withinWindow
              ? ""
              : `, checked more than ${revalidationWindowLabel} ago and beyond the revalidation window`
          }`
    }`,
    `    Historical use  ${entry.historicalUse.join("; ")}`,
    ...(entry.projectId === null
      ? []
      : [`    Project         ${entry.projectPath} (id ${entry.projectId})`]),
  ];
}

function renderChangeReviewState(selection: LiveAgentChangeReviewSelectionV1): readonly string[] {
  return [
    `Provider        ${selection.provider}`,
    `Status          ${selection.status}`,
    `Source read     ${selection.sourceRead}`,
    `Reference       ${selection.reference}`,
    `Remove with     /sources remove ${selection.label}`,
  ];
}

function renderChangeReview(selection: LiveAgentChangeReviewSelectionV1): readonly string[] {
  return [
    `Change-review basis: ${selection.label}`,
    ...renderChangeReviewState(selection).map((line) => `  ${line}`),
  ];
}

/**
 * One session's block of a purge preview or receipt. `sources.purgePreviewMaxRows`
 * caps the printing here, never the set the confirmation covers.
 */
function renderPurgeSession(session: SourcePurgeSessionPreviewV1): readonly string[] {
  return [
    `  ${session.sessionId}  ${session.copies.length} owned local cop${session.copies.length === 1 ? "y" : "ies"}, ${session.bytes} bytes`,
    ...session.copies
      .slice(0, PURGE_PREVIEW_MAX_ROWS.value)
      .map(
        (copy) =>
          `    ${copy.copyId}  ${copy.kind}${copy.orphaned ? " (proved orphan)" : ""}  ${copy.bytes} bytes  ${SESSION_SOURCE_COPY_KIND_MESSAGES[copy.kind]}`,
      ),
    `    Affected runs   ${session.affectedRunIds.length === 0 ? "none recorded" : session.affectedRunIds.join(", ")}`,
    `    Still retained  ${session.retainedScopes.length === 0 ? "none recorded" : session.retainedScopes.join(", ")}`,
  ];
}

/**
 * A full line naming the cap whenever it withheld rows, so the clipping
 * reaches the operator; empty when nothing was withheld.
 */
function renderWithheldRows(rowsNotPrinted: number): readonly string[] {
  return rowsNotPrinted === 0
    ? []
    : [
        `  ${rowsNotPrinted} further copy row${rowsNotPrinted === 1 ? " is" : "s are"} not printed here: the preview prints at most ${PURGE_PREVIEW_MAX_ROWS.value} rows per session (${PURGE_PREVIEW_MAX_ROWS.name}). They are counted above and they are covered by the confirmation; none of them was dropped from the deletion.`,
      ];
}

/**
 * The removal, cache-invalidation, and purge distinction, walked from the
 * enumeration so a new operation always appears here.
 */
function renderOperationDistinction(): readonly string[] {
  return [
    "Three different things, kept apart:",
    ...Object.entries(SOURCE_STATE_OPERATION_MESSAGES).map(
      ([operation, message]) => `  ${operation}  ${message}`,
    ),
  ];
}

/**
 * Render one outcome for the terminal. Pure over an already-screened outcome:
 * it arranges data and adds none.
 */
export function renderSourceCommandOutcome(
  outcome: SourceCommandOutcomeV1,
  revalidationWindowLabel: string,
  revalidationStateMessages: Readonly<Record<string, string>>,
): string {
  switch (outcome.kind) {
    case "listing": {
      if (outcome.entries.length === 0 && outcome.changeReview === undefined) {
        return "No sources are attached to this conversation.\n";
      }
      return [
        ...(outcome.entries.length === 0 ? ["No sources are attached to this conversation."] : []),
        ...(outcome.entries.length > 0
          ? [
              `Attached sources (${outcome.entries.length}):`,
              ...outcome.entries.flatMap((entry) => renderEntry(entry, revalidationWindowLabel)),
            ]
          : []),
        ...(outcome.changeReview ? renderChangeReview(outcome.changeReview) : []),
        "",
      ].join("\n");
    }
    case "review-selected":
      return [
        `Selected ${outcome.selection.label} for the next bounded documentation review.`,
        ...renderChangeReviewState(outcome.selection).map((line) => `  ${line}`),
        "No pull or merge request source was read or reviewed by this selection command.",
        "",
      ].join("\n");
    case "review-detail":
      return [...renderChangeReview(outcome.selection), ""].join("\n");
    case "review-detached":
      return [
        `Detached change-review basis ${outcome.selection.label}.`,
        `  Provider        ${outcome.selection.provider}`,
        "  Status          detached",
        `  Reference       ${outcome.selection.reference}`,
        `Attached sources remaining: ${outcome.entries.length}.`,
        "",
      ].join("\n");
    case "attached":
      return [
        `Attached ${outcome.entry.label}. This conversation now binds ${outcome.entries.length} source${outcome.entries.length === 1 ? "" : "s"} on its next bounded workflow run.`,
        ...renderEntry(outcome.entry, revalidationWindowLabel),
        "",
      ].join("\n");
    case "detached":
      return [
        `Detached ${outcome.entry.label}. This conversation now binds ${outcome.entries.length} source${outcome.entries.length === 1 ? "" : "s"} on its next bounded workflow run.`,
        "",
      ].join("\n");
    case "detail":
      return [
        ...renderEntry(outcome.entry, revalidationWindowLabel),
        outcome.preview === null
          ? "    Preview         not previewed here; a merged change is read as sealed evidence inside a bound run"
          : `    Preview${outcome.previewTruncated ? " (bounded)" : ""}`,
        ...(outcome.preview === null ? [] : [outcome.preview, ""]),
        "",
      ].join("\n");
    case "refreshed":
      return [
        `Refreshed ${outcome.results.length} attached source${outcome.results.length === 1 ? "" : "s"}:`,
        ...outcome.results.map(
          (result) =>
            `  ${result.label}  ${result.disposition}` +
            (result.disposition === "drifted"
              ? ` (was ${result.previousVersion ?? "unread"}, now ${result.version ?? "unread"})`
              : ""),
        ),
        "",
      ].join("\n");
    case "revalidated":
      // An empty selection is answered like every other verb answers it.
      if (outcome.results.length === 0) return "No sources are attached to this conversation.\n";
      return [
        `Revalidated ${outcome.results.length} attached source${outcome.results.length === 1 ? "" : "s"} against the selected revision. ${outcome.entries.length} source${outcome.entries.length === 1 ? " remains" : "s remain"} attached; revalidation detaches nothing.`,
        ...outcome.results.flatMap((result) => [
          `  ${result.label}  ${result.state} (${result.basis})` +
            (result.state === "stale"
              ? ` (recorded ${result.recordedVersion ?? "unread"}, observed ${result.observedVersion ?? "unread"})`
              : ""),
          `    ${revalidationStateMessages[result.state]}`,
        ]),
        "",
      ].join("\n");
    case "purge-preview":
      return [
        ...(outcome.confirmation === null
          ? [
              // Each session says whether it was already purged or never held anything.
              `Nothing to purge in ${outcome.sessions.length} named session${outcome.sessions.length === 1 ? "" : "s"}. No copy was deleted and no custody record was written.`,
              ...outcome.sessions.map(
                (session) =>
                  `  ${session.sessionId}  ${
                    session.previouslyPurgedAt === null
                      ? "holds no owned local copy"
                      : `already purged at ${session.previouslyPurgedAt}`
                  }`,
              ),
            ]
          : [
              `Purge preview for ${outcome.sessions.length} session${outcome.sessions.length === 1 ? "" : "s"}. Nothing has been deleted.`,
              ...outcome.sessions.flatMap((session) => renderPurgeSession(session)),
              ...renderWithheldRows(outcome.rowsNotPrinted),
              "",
              ...renderOperationDistinction(),
              "",
              outcome.retentionNote,
              "",
              `To delete exactly the copies listed above, run the same purge command again with this confirmation: ${outcome.confirmation}`,
              "It authorizes that exact set of copies. If the session changes before you use it, the purge stops rather than deleting something you did not read.",
            ]),
        "",
      ].join("\n");
    case "purged":
      return [
        `Purged ${outcome.sessions.length} session${outcome.sessions.length === 1 ? "" : "s"}: ${outcome.removedCopies} owned local cop${outcome.removedCopies === 1 ? "y" : "ies"} deleted, ${outcome.removedBytes} bytes. ${outcome.entries.length} source${outcome.entries.length === 1 ? " remains" : "s remain"} attached; purge detaches nothing.`,
        ...outcome.sessions.flatMap((session) => renderPurgeSession(session)),
        ...renderWithheldRows(outcome.rowsNotPrinted),
        ...outcome.custody.map(
          (record) =>
            `  custody record ${record.recordId}  ${record.removed.length} removed${record.incomplete ? `, ${record.notRemoved.length} not removed` : ""}  at ${record.at}`,
        ),
        "",
        outcome.retentionNote,
        "",
      ].join("\n");
    case "search":
      return [
        `Discoverable merged changes: ${outcome.descriptorCount}${outcome.windowCovered ? "" : " (the requested window was not fully read)"}`,
        ...outcome.result.descriptors.map(
          (descriptor) =>
            `  !${descriptor.mergeRequestIid}  merged ${descriptor.mergedAt}  onto ${descriptor.targetBranch}  ${descriptor.applicability}`,
        ),
        "",
      ].join("\n");
  }
}
