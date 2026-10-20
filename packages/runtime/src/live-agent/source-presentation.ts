// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  presentCollection,
  presentInspection,
  presentResult,
  renderPresentation,
  resolveProcessPresentationCapabilities,
  type PresentationCapabilities,
  type PresentationDocument,
  type PresentationEvidence,
  type PresentationField,
  type PresentationSection,
  type ResultPresentationFacts,
} from "../operator/index.js";
import { limit } from "../config/limits.js";
import {
  SOURCE_STATE_OPERATIONS,
  SOURCE_STATE_OPERATION_MESSAGES,
  SESSION_SOURCE_COPY_KIND_MESSAGES,
  SOURCE_PURGE_PREVIEW_MAX_ROWS_LIMIT,
} from "./source-custody.js";
import { SOURCE_REVALIDATION_FRESHNESS_WINDOW_LIMIT } from "./source-commands/contracts.js";
import { SOURCE_REVALIDATION_STATE_MESSAGES } from "./source-commands/messages.js";
import type { LiveAgentChangeReviewSelectionV1 } from "./change-review.js";
import type {
  LiveAttachedSourceV1,
  SourceCommandOutcomeV1,
  SourceRevalidationStateV1,
} from "./source-commands.js";

const known = (value: string): PresentationEvidence<string> => ({ state: "known", value });
const purgePreviewMaxRows = limit(SOURCE_PURGE_PREVIEW_MAX_ROWS_LIMIT);
const revalidationWindow = limit(SOURCE_REVALIDATION_FRESHNESS_WINDOW_LIMIT);

function revalidationNextStep(
  state: "fresh" | "stale" | "missing" | "unreadable" | "identity-changed",
): string {
  switch (state) {
    case "fresh":
      return "No recovery action is needed within the recorded freshness window.";
    case "stale":
      return "Refresh this source to adopt the current version, or detach it before a bounded run.";
    case "missing":
      return "Restore this tracked file at the selected revision, or detach it.";
    case "unreadable":
      return "Shrink or split the file so the host can read it, or detach it.";
    case "identity-changed":
      return "Detach this source and attach the intended project identity again.";
  }
}
const field = (
  label: string,
  value: string,
  importance?: "ordinary" | "material",
): PresentationField => ({
  label,
  evidence: known(value),
  ...(importance ? { importance } : {}),
});

function sourceSection(entry: LiveAttachedSourceV1): PresentationSection {
  return {
    title: "Source details",
    fields: [
      field("Source", entry.label, "material"),
      field("Format", entry.format),
      field("Status", entry.status, entry.status === "attached" ? "ordinary" : "material"),
      field("Version", entry.version ?? "not read yet"),
      field(
        "Limitations",
        entry.limitations.length ? entry.limitations.join(", ") : "none recorded",
        entry.limitations.length ? "material" : "ordinary",
      ),
      field(
        "Revalidation",
        entry.revalidation === null
          ? "not revalidated in this conversation"
          : `${entry.revalidation.state} (${entry.revalidation.basis})${entry.revalidation.withinWindow ? "" : `, checked more than ${revalidationWindow.value} ${revalidationWindow.unit} ago and beyond the revalidation window`}`,
        entry.revalidation !== null &&
          (!entry.revalidation.withinWindow || entry.revalidation.state !== "fresh")
          ? "material"
          : "ordinary",
      ),
      field(
        "Historical use",
        entry.historicalUse.length ? entry.historicalUse.join("; ") : "none recorded",
      ),
      field("Required by", entry.requiredBy.length ? entry.requiredBy.join(", ") : "none recorded"),
      ...(entry.repositoryPath === null ? [] : [field("Repository path", entry.repositoryPath)]),
      ...(entry.projectPath === null
        ? []
        : [
            field(
              "Project",
              entry.projectId === null
                ? entry.projectPath
                : `${entry.projectPath} (id ${entry.projectId})`,
            ),
          ]),
    ],
  };
}

function reviewSection(
  selection: LiveAgentChangeReviewSelectionV1,
  status: "selected" | "detached" = selection.status,
): PresentationSection {
  return {
    title: "Review basis",
    fields: [
      field("Basis", selection.label, "material"),
      field("Reference", selection.reference, "material"),
      field("Provider", selection.provider),
      field("Status", status),
      field("Source read", selection.sourceRead),
    ],
  };
}

function outcomeFacts(
  title: string,
  outcome: string,
  sections: readonly PresentationSection[] = [],
  options: {
    effects?: readonly PresentationField[];
    limitations?: readonly PresentationField[];
    actions?: ResultPresentationFacts["nextActions"];
    attention?: ResultPresentationFacts["attention"];
  } = {},
): PresentationDocument {
  return presentResult({
    title,
    outcome: field("Outcome", outcome),
    effects: options.effects,
    limitations: options.limitations,
    sections,
    nextActions: options.actions,
    attention: options.attention ?? null,
  });
}

/** Project already-screened source facts into common semantic rows. */
export function projectSourceCommandOutcome(
  outcome: SourceCommandOutcomeV1,
  revalidationStateMessages: Readonly<
    Record<SourceRevalidationStateV1, string>
  > = SOURCE_REVALIDATION_STATE_MESSAGES,
): PresentationDocument {
  switch (outcome.kind) {
    case "listing":
      return presentCollection({
        title: "Attached Sources",
        entries: outcome.entries.map((entry) =>
          field(
            entry.label,
            `${entry.kind === "merged-change" ? "change request" : entry.kind}; ${entry.status}`,
            entry.status === "attached" ? "ordinary" : "material",
          ),
        ),
        sections: [
          ...(outcome.entries.length > 0
            ? outcome.entries.map(sourceSection)
            : [{ title: "Selection", text: ["No sources are attached to this conversation."] }]),
          ...(outcome.changeReview ? [reviewSection(outcome.changeReview)] : []),
        ],
        attention: outcome.entries.some(
          (entry) =>
            entry.status !== "attached" ||
            entry.limitations.length > 0 ||
            (entry.revalidation !== null &&
              (!entry.revalidation.withinWindow || entry.revalidation.state !== "fresh")),
        )
          ? {
              message:
                "One or more attached sources have limitations or revalidation evidence that needs attention.",
            }
          : null,
      });
    case "review-selected":
      return outcomeFacts(
        `Selected ${outcome.selection.label}`,
        "This basis is selected for the next bounded documentation review. No pull or merge request source was read or reviewed by this selection command.",
        [reviewSection(outcome.selection)],
      );
    case "review-detail": {
      const section = reviewSection(outcome.selection);
      return presentInspection({
        title: "Review Basis",
        subject: known(outcome.selection.label),
        findings: section.fields ?? [],
        sections: [],
        attention: null,
      });
    }
    case "review-detached":
      return outcomeFacts(
        `Detached ${outcome.selection.label}`,
        `The review basis is detached; ${outcome.entries.length} attached source${outcome.entries.length === 1 ? " remains" : "s remain"}.`,
        [reviewSection(outcome.selection, "detached")],
      );
    case "attached":
      return outcomeFacts(
        `Attached ${outcome.entry.label}`,
        `The conversation now binds ${outcome.entries.length} source${outcome.entries.length === 1 ? "" : "s"} on its next bounded workflow run.`,
        [sourceSection(outcome.entry)],
        {
          effects: [
            field(
              "Selection",
              "This conversation's in-memory source selection changed.",
              "material",
            ),
          ],
        },
      );
    case "detached":
      return outcomeFacts(
        `Detached ${outcome.entry.label}`,
        `The conversation now binds ${outcome.entries.length} source${outcome.entries.length === 1 ? "" : "s"} on its next bounded workflow run.`,
        [],
        {
          effects: [
            field(
              "Selection",
              "This conversation's in-memory source selection changed; no file or custody record was deleted.",
              "material",
            ),
          ],
        },
      );
    case "detail":
      return presentInspection({
        title: "Source Details",
        subject: known(outcome.entry.label),
        findings: [
          field("Format", outcome.entry.format),
          field(
            "Status",
            outcome.entry.status,
            outcome.entry.status === "attached" ? "ordinary" : "material",
          ),
          field("Version", outcome.entry.version ?? "not read yet"),
          field(
            "Preview",
            outcome.preview === null
              ? "not previewed here; a merged change is read as sealed evidence inside a bound run"
              : `${outcome.previewTruncated ? "bounded preview" : "preview"}: ${outcome.preview}`,
          ),
        ],
        sections: [sourceSection(outcome.entry)],
        attention: outcome.entry.limitations.length
          ? {
              message: "This source carries limitations.",
              details: [field("Limitations", outcome.entry.limitations.join(", "), "material")],
            }
          : null,
      });
    case "refreshed": {
      const recorded = outcome.results.filter(
        (result) => result.disposition === "unchanged" || result.disposition === "drifted",
      ).length;
      const unavailable = outcome.results.filter(
        (result) => result.disposition === "unavailable",
      ).length;
      const immutable = outcome.results.filter(
        (result) => result.disposition === "immutable",
      ).length;
      const summary = [
        recorded
          ? `Recorded current versions for ${recorded} readable file source${recorded === 1 ? "" : "s"}.`
          : null,
        unavailable
          ? `${unavailable} source${unavailable === 1 ? "" : "s"} could not be read and kept any previously recorded version.`
          : null,
        immutable
          ? `${immutable} immutable change source${immutable === 1 ? "" : "s"} required no read.`
          : null,
      ]
        .filter((part): part is string => part !== null)
        .join(" ");
      return outcomeFacts(
        `Refreshed ${outcome.results.length} attached source${outcome.results.length === 1 ? "" : "s"}`,
        summary || "No attached sources were selected for refresh.",
        [
          {
            title: "Refresh Results",
            fields: outcome.results.map((result) =>
              field(
                result.label,
                `${result.disposition}${result.disposition === "drifted" ? ` (was ${result.previousVersion ?? "unread"}, now ${result.version ?? "unread"})` : ""}`,
                result.disposition === "drifted" || result.disposition === "unavailable"
                  ? "material"
                  : "ordinary",
              ),
            ),
          },
        ],
        {
          attention: outcome.results.some(
            (result) => result.disposition === "drifted" || result.disposition === "unavailable",
          )
            ? { message: "One or more source versions changed or could not be read." }
            : null,
        },
      );
    }
    case "revalidated":
      if (outcome.results.length === 0)
        return outcomeFacts("No Attached Sources", "No sources are attached to this conversation.");
      return outcomeFacts(
        `Revalidated ${outcome.results.length} attached source${outcome.results.length === 1 ? "" : "s"}`,
        `${outcome.entries.length} source${outcome.entries.length === 1 ? " remains" : "s remain"} attached; revalidation detaches nothing.`,
        [
          {
            title: "Revalidation Results",
            fields: outcome.results.flatMap((result) => [
              field("Source", result.label, "material"),
              field(
                "Revalidation",
                `${result.state} (${result.basis}): ${revalidationStateMessages[result.state]}${result.state === "stale" ? ` (recorded ${result.recordedVersion ?? "unread"}, observed ${result.observedVersion ?? "unread"})` : ""} Next: ${revalidationNextStep(result.state)}`,
                "material",
              ),
            ]),
          },
        ],
        {
          effects: [field("Selection", "No source was detached or adopted by revalidation.")],
          attention: outcome.results.some((result) => result.state !== "fresh")
            ? { message: "One or more sources are not fresh for the selected revision." }
            : null,
        },
      );
    case "search":
      return presentCollection({
        title: "Discoverable Merged Changes",
        entries: outcome.result.descriptors.map((descriptor) =>
          field(
            `!${descriptor.mergeRequestIid}`,
            `merged ${descriptor.mergedAt}; target ${descriptor.targetBranch}; ${descriptor.applicability}`,
            descriptor.applicability === "applicable" ? "ordinary" : "material",
          ),
        ),
        sections: [
          {
            title: "Search Coverage",
            fields: [
              field("Descriptors", String(outcome.descriptorCount)),
              field(
                "Window fully read",
                outcome.windowCovered ? "yes" : "no",
                outcome.windowCovered ? "ordinary" : "material",
              ),
              field("Target branch", outcome.result.targetBranch),
            ],
          },
        ],
        attention: outcome.windowCovered
          ? null
          : {
              message:
                "The requested discovery window was not fully read; results may be incomplete.",
            },
      });
    case "purge-preview": {
      const readyToDelete = outcome.confirmation !== null;
      const sections = outcome.sessions.map((session) => ({
        title: session.sessionId,
        fields: [
          field("Owned local copies", String(session.copies.length)),
          field("Bytes", String(session.bytes)),
          field(
            "Affected runs",
            session.affectedRunIds.length ? session.affectedRunIds.join(", ") : "none recorded",
          ),
          field(
            "Retained scopes",
            session.retainedScopes.length ? session.retainedScopes.join(", ") : "none recorded",
          ),
          field("Previously purged", session.previouslyPurgedAt ?? "no"),
        ],
        text: [
          ...session.copies
            .slice(0, purgePreviewMaxRows.value)
            .map(
              (copy) =>
                `${copy.copyId}: ${copy.kind}; ${copy.bytes} bytes${copy.orphaned ? "; proved orphan" : ""}; ${SESSION_SOURCE_COPY_KIND_MESSAGES[copy.kind]}`,
            ),
        ],
      }));
      if (outcome.rowsNotPrinted > 0) {
        sections.push({
          title: "Preview Coverage",
          fields: [field("Copy rows not printed", String(outcome.rowsNotPrinted), "material")],
          text: [
            `At most ${purgePreviewMaxRows.value} copy rows per session are printed (${purgePreviewMaxRows.name}). Every unprinted row remains counted above and included in the exact confirmation.`,
          ],
        });
      }
      return outcomeFacts(
        "Source Purge Authorization",
        readyToDelete
          ? `Purge preview for ${outcome.sessions.length} session${outcome.sessions.length === 1 ? "" : "s"}. This is a preview only. No copies have been deleted.`
          : `Nothing to purge in ${outcome.sessions.length} named session${outcome.sessions.length === 1 ? "" : "s"}. No copy was deleted and no custody record was written.`,
        [
          ...sections,
          ...(readyToDelete
            ? [
                {
                  title: "Operation Distinctions",
                  fields: SOURCE_STATE_OPERATIONS.map((operation) =>
                    field(operation, SOURCE_STATE_OPERATION_MESSAGES[operation]),
                  ),
                },
              ]
            : []),
        ],
        {
          limitations: [
            field("Retention", outcome.retentionNote),
            ...(readyToDelete
              ? [
                  field(
                    "Confirmation scope",
                    "This confirmation authorizes this exact set only; changed inventory stops the purge.",
                    "material",
                  ),
                ]
              : []),
          ],
          actions: readyToDelete
            ? [
                {
                  kind: "instruction",
                  text: `To delete exactly these copies, run the same purge command again with confirmation ${outcome.confirmation}`,
                },
              ]
            : [],
          attention: readyToDelete
            ? {
                message:
                  "No copies have been deleted. Deletion requires the exact confirmation shown.",
                details: [field("Confirmation", outcome.confirmation ?? "none", "material")],
              }
            : null,
        },
      );
    }
    case "purged":
      return outcomeFacts(
        `Purged ${outcome.sessions.length} session${outcome.sessions.length === 1 ? "" : "s"}`,
        `${outcome.removedCopies} owned local cop${outcome.removedCopies === 1 ? "y" : "ies"} deleted; ${outcome.removedBytes} bytes. ${outcome.entries.length} source${outcome.entries.length === 1 ? " remains" : "s remain"} attached; purge detaches nothing.`,
        [
          ...outcome.sessions.map((session) => ({
            title: session.sessionId,
            fields: [
              field("Deleted copies", String(session.copies.length)),
              field("Bytes", String(session.bytes)),
              field("Affected runs", session.affectedRunIds.join(", ") || "none recorded"),
              field("Retained scopes", session.retainedScopes.join(", ") || "none recorded"),
            ],
            text: session.copies
              .slice(0, purgePreviewMaxRows.value)
              .map(
                (copy) =>
                  `${copy.copyId}: ${copy.kind}; ${copy.bytes} bytes${copy.orphaned ? "; proved orphan" : ""}; ${SESSION_SOURCE_COPY_KIND_MESSAGES[copy.kind]}`,
              ),
          })),
          ...(outcome.rowsNotPrinted > 0
            ? [
                {
                  title: "Receipt Coverage",
                  fields: [
                    field("Copy rows not printed", String(outcome.rowsNotPrinted), "material"),
                  ],
                  text: [
                    `At most ${purgePreviewMaxRows.value} copy rows per session are printed (${purgePreviewMaxRows.name}); all removed copies remain included in the custody accounting.`,
                  ],
                },
              ]
            : []),
          {
            title: "Custody Records",
            fields: outcome.custody.map((record) =>
              field(
                `custody record ${record.recordId}`,
                `${record.removed.length} removed${record.incomplete ? `; ${record.notRemoved.length} not removed` : ""}; at ${record.at}`,
                record.incomplete ? "material" : "ordinary",
              ),
            ),
          },
        ],
        {
          effects: [
            field(
              "Deletion",
              `${outcome.removedCopies} owned local copies; ${outcome.removedBytes} bytes`,
              "material",
            ),
          ],
          limitations: [field("Retention", outcome.retentionNote)],
          attention: outcome.custody.some((record) => record.incomplete)
            ? { message: "Purge was incomplete; inspect custody records for copies not removed." }
            : null,
        },
      );
  }
}

/** Project coded command refusals to stderr without echoing supplied operands. */
export function projectSourceCommandRefusal(text: string): PresentationDocument {
  return {
    title: "",
    attention: { message: text, stream: "stderr" },
    rows: [
      {
        kind: "field",
        label: "Selection",
        evidence: known("Unchanged."),
        stream: "stderr",
      },
      { kind: "attention", message: text, stream: "stderr" },
    ],
    actions: [],
  };
}

export function renderSourceCommandRefusal(
  text: string,
  capabilities: PresentationCapabilities = resolveProcessPresentationCapabilities(),
): string {
  const rendered = renderPresentation(projectSourceCommandRefusal(text), capabilities);
  return `${rendered.stdout === "\n" ? "" : rendered.stdout}${rendered.stderr}`;
}
