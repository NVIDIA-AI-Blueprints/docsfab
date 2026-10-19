// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SourceDiscoveryResultV1 } from "../../inputs/source-discovery.js";
import type { SourcePurgeCustodyRecordV1, SourcePurgeSessionPreviewV1 } from "../source-custody.js";
import type { LiveAgentChangeReviewSelectionV1 } from "../change-review.js";

/** Catalog name of the window over which a recorded verdict is still current. */
export const SOURCE_REVALIDATION_FRESHNESS_WINDOW_LIMIT =
  "sources.revalidationFreshnessWindowMinutes" as const;

/** Bytes one version read may cover. */
export const SOURCE_VERSION_MAX_BYTES = 16 * 1024 * 1024;

/** Descriptor ceiling one `/sources search` asks the searcher for. */
export const SOURCE_COMMAND_SEARCH_CEILING = 20;

export const SOURCE_COMMAND_VERBS = [
  "list",
  "add",
  "show",
  "refresh",
  "revalidate",
  "remove",
  "search",
  "purge",
  "review",
] as const;

export type SourceCommandVerbV1 = (typeof SOURCE_COMMAND_VERBS)[number];

export const SOURCE_COMMAND_REFUSAL_CODES = [
  "unknown-verb",
  "malformed-command",
  "missing-argument",
  "unexpected-argument",
  "invalid-reference",
  "invalid-review-reference",
  "duplicate-source",
  "one-change-request",
  "unknown-source",
  "required-source",
  "search-unavailable",
  "inspection-unavailable",
  "identity-unverifiable",
  "too-many-sources",
  "source-unreadable",
  "disclosure-screen",
  "instruction-conflict",
  // A bounded run refuses rather than binding stale or revoked bytes.
  // `bind-expired` is a `fresh` verdict aged past the window: the clock moved,
  // not the bytes.
  "bind-stale",
  "bind-missing",
  "bind-unreadable",
  "bind-identity-changed",
  "bind-expired",
  // Each stops a purge before a byte is deleted, except `purge-incomplete`,
  // raised after the custody record admitting a partial removal is appended.
  "custody-unavailable",
  "entry-point-unrecorded",
  "invalid-session-reference",
  "unknown-session-reference",
  "ambiguous-session-reference",
  "session-principal-mismatch",
  "session-active-writer",
  "too-many-sessions",
  "purge-not-confirmed",
  "purge-incomplete",
] as const;

export type SourceCommandRefusalCodeV1 = (typeof SOURCE_COMMAND_REFUSAL_CODES)[number];

/**
 * Operator-facing refusal text: the failing condition, then the action that
 * clears it.
 *
 * Content-free: no sentence interpolates the typed line, a path, a locator, a
 * version, or source bytes, because refusals reach a captured terminal and a
 * kept session file. Any name a refusal needs comes from host state and is
 * appended as detail, never interpolated.
 */
export const SOURCE_COMMAND_REFUSALS: Readonly<Record<SourceCommandRefusalCodeV1, string>> =
  Object.freeze({
    "unknown-verb":
      "That is not a source command this terminal knows. Use the source command by itself to list attached sources, or with add, show, refresh, review, remove or search.",
    "malformed-command":
      "The source command line could not be read as a command. It is parsed literally, with no shell expansion and no quoting, so control characters, unnormalized text and a line longer than this terminal accepts are refused. Retype the command as one line of plain text.",
    "missing-argument":
      "That source command needs one argument and received none. Name a repository-relative file, a merge request by URL or host and project reference, or a whole GitHub pull-request URL for review.",
    "unexpected-argument":
      "That source command takes no argument and received one. Retype it on its own, or use the source command that accepts what you named.",
    "invalid-reference":
      "That is not a repository-relative file in the selected repository, nor a usable merge-request reference. A source is a tracked file inside this repository or an already-merged change; an absolute path, a parent-directory path, a home-relative path, a host location, a bare URL, and any reference that holds one of DocsFab's own configured credentials are not sources. Nothing was attached. Name a path relative to the repository root, or the merge request's URL.",
    "invalid-review-reference":
      "That is not a supported pull or merge request reference. Nothing was selected. Pass a whole GitHub pull-request URL or configured GitLab merge-request URL or host/group/project!number reference.",
    "duplicate-source":
      "That source is already attached to this conversation. Use the source listing to see what is attached, or refresh the attached entry to pick up a newer revision.",
    "one-change-request":
      "This conversation already has a selected change-review basis or an attached merged change, and a run binds one change request as its basis. Remove the selected review or attached merged change first, then select the one you mean; supporting files can attach alongside it without replacing it.",
    "unknown-source":
      "No attached source matches that reference exactly. References are matched byte for byte against the labels the source listing prints; copy the label from that listing and retype the command.",
    "required-source":
      "That source is required evidence for a bounded workflow this conversation is running, and detaching it would let a write step run without the evidence it was bound to read. Wait for the run to settle, then detach it.",
    "search-unavailable":
      "This DocsFab release does not wire a source searcher into the live terminal, so there is nothing for this conversation to search. Nothing you can pass at the terminal enables it; attach the merged change you already know by reference, and let a bounded workflow discover further evidence.",
    "inspection-unavailable":
      "The host that started this conversation did not wire a reader for the selected revision, so there is no preview and no version to compare. This is a property of how the session was started and not of your checkout; start the conversation through the docsfab live-agent command, which wires one.",
    // The recorded identity could not be re-resolved at all. Not a state:
    // `identity-changed` would claim the project moved, `fresh` a check that
    // never happened.
    "identity-unverifiable":
      "The project identity recorded for an attached merged change could not be re-resolved, so this revalidation neither confirmed nor contradicted it and nothing was recorded. Either no project identity resolver was wired into this conversation or the forge did not answer; nothing was detached. Start the conversation through the docsfab live-agent command and check that the forge is reachable. If the project is permanently gone, revalidate the sources you can by naming each label the source listing prints, or detach the merged change.",
    // Raised before anything is read; the bound and observed count are
    // appended as host-held detail.
    "too-many-sources":
      "This conversation has more attached sources than one revalidation command re-checks, and DocsFab refuses the whole command rather than re-checking some of them and reporting on the rest by silence. Nothing was read and nothing was recorded. Revalidate one source at a time by naming the label the source listing prints, or detach the sources this conversation no longer grounds on.",
    "source-unreadable":
      "The attached file could not be read at the selected revision, so no preview and no version were produced. Check that the file is still a tracked regular file at that revision and is within the preview ceiling, then retry.",
    "disclosure-screen":
      "DocsFab withheld this source command's output because it holds one of DocsFab's own configured credentials, or named this host's paths in a form that could not be replaced safely. Nothing was disclosed and nothing was changed; this is not an authentication failure. Remove the credential from the named source, then retry.",
    // The instruction already names the merge requests a run would bind. The
    // shared cross-entrypoint sentence is appended verbatim as detail; the
    // action here fits a terminal operator, who typed no CLI options.
    "instruction-conflict":
      "This turn's instruction already selects the merge requests a run would bind, and the evidence attached to this conversation answers that same question a second time. A run binds exactly one source binding, so DocsFab will not silently prefer one of the two. Use the source command on its own to see what is attached and remove the attachment you do not want bound, or ask again without the merged-MR date window.",
    "bind-stale":
      "A bounded run will not bind a source whose last revalidation reported it as stale. Nothing was started. Refresh that source to take the current version, or detach it, then ask again.",
    "bind-missing":
      "A bounded run will not bind a source whose last revalidation reported it as missing. Nothing was started. Restore it at the selected revision, or detach it, then ask again.",
    "bind-unreadable":
      "A bounded run will not bind a source whose last revalidation reported it as unreadable. Nothing was started. Shrink or split the file, or detach it, then ask again.",
    "bind-identity-changed":
      "A bounded run will not bind a source whose last revalidation reported that its identity changed. Nothing was started. Detach it and attach the source you mean, then ask again.",
    // A `fresh` verdict aged past the window. Distinct from `bind-stale`: the
    // clock moved, not the bytes.
    "bind-expired":
      "A bounded run will not bind a source whose last revalidation is older than the freshness window, even when that verdict was fresh. The window is a gate, not only a listing mark. Nothing was started. Revalidate the attached sources, then ask again.",
    // No store is wired. Worded as a property of the release, not a failure
    // of the operator's command.
    "custody-unavailable":
      "This DocsFab release wires no session source custody store into this surface, so there is nothing it owns to preview and nothing it can delete. No deletion happened and none is claimed. Detaching a source, which changes only what this conversation binds, is available; deleting owned local copies is not.",
    "entry-point-unrecorded":
      "A custody record has to name the entry point that performed the deletion, and this host wired a custody store without one, so a purge here could only write a record that cannot say who made it. Nothing was previewed and nothing was deleted. Start the conversation through the docsfab live-agent command, or run the source command from the command line, so the entry point is recorded.",
    "invalid-session-reference":
      "That is not a session reference this command will look up. A session is named by its own identifier: letters, digits, dot, underscore and hyphen, beginning with a letter or a digit, and several are separated by commas with no spaces. Nothing was read and nothing was deleted. Copy the identifier exactly as the session was reported to you.",
    "unknown-session-reference":
      "No session held by this custody store matches that reference. Nothing was read and nothing was deleted; in particular this is not a statement that the session was already purged, which is reported differently. Check the reference and retype it.",
    "ambiguous-session-reference":
      "That reference names more than one session, and DocsFab will not choose one of them to delete. Nothing was read and nothing was deleted. Name the session exactly rather than by a prefix or a fragment.",
    // Principal and repository mismatches share a code and action; the
    // host-held detail names which one.
    "session-principal-mismatch":
      "That session was conducted by a different principal or against a different repository than this command is running as, so this command is not the one that may delete its copies. Nothing was deleted. Run the purge as the principal that owns the session, in the repository the session was bound to.",
    "session-active-writer":
      "A writer still holds that session, and deleting the copies underneath it would race a process that is using them. Nothing was deleted. Wait for the session to settle and run the command again; a saved handle and a directory that looks inactive prove neither that the writer has gone nor that you may delete what it holds.",
    "too-many-sessions":
      "This purge names more sessions than one invocation deletes, and DocsFab refuses the whole command rather than purging a prefix of them. A purge is authorized by one confirmation over one preview, and a preview nobody can read in full is not a confirmation. Nothing was read and nothing was deleted. Name fewer sessions and run the command again.",
    "purge-not-confirmed":
      "The confirmation passed with this purge does not match the copies this session holds now, so it authorizes a deletion other than the one that would happen. Nothing was deleted. Run the purge without a confirmation to read the current preview, then pass the confirmation that preview prints.",
    // The only refusal raised after bytes are gone; the custody record is
    // appended before it is thrown.
    "purge-incomplete":
      "The purge stopped part way: some owned copies were deleted and the rest were not. What was deleted has already been written to the custody record, which also names what remains, so nothing was removed without an admission that it was. The sessions named after this one were not touched. Read the custody record, then run the purge again to finish it.",
  });

/**
 * Host-held detail for an `identity-unverifiable` the forge never saw: a merged
 * change attached as a bare number recorded no host or project path to
 * re-resolve, so the action is to re-attach it by full reference.
 */
export const NO_RECORDED_PROJECT_REFERENCE_DETAIL =
  "This merged change was attached as a bare number, so no host and no project path were recorded for it and there is no reference to re-resolve; nothing was asked of the forge. Re-attach it by its full reference to make it revalidatable.";

/** A refusal raised by this dispatcher, carrying a stable code and no echoed value. */
export class SourceCommandError extends Error {
  public constructor(
    public readonly code: SourceCommandRefusalCodeV1,
    detail?: string,
  ) {
    super(
      detail === undefined
        ? SOURCE_COMMAND_REFUSALS[code]
        : `${SOURCE_COMMAND_REFUSALS[code]} ${detail}`,
    );
    this.name = "SourceCommandError";
  }
}

/**
 * Raise one refusal. Call sites name a code, never a sentence, so
 * {@link SOURCE_COMMAND_REFUSALS} stays the one place `/sources` messages live.
 */
export function failSourceCommand(code: SourceCommandRefusalCodeV1, detail?: string): never {
  throw new SourceCommandError(code, detail);
}

export type LiveSourceKindV1 = "repository-file" | "merged-change";

export type LiveSourceStatusV1 = "attached" | "drifted" | "unavailable";

/**
 * What one revalidation concluded about one attached source.
 *
 * Every targeted source gets exactly one state. A source that could not be
 * re-checked at all stops the whole command with a coded refusal, because a
 * source missing from a report reads as one that passed.
 *
 * - `fresh`: re-checked now, and nothing recorded about it is contradicted;
 *   {@link SourceRevalidationBasisV1} names what was compared.
 * - `stale`: same identity, still reachable, and its digest differs from the
 *   recorded one.
 * - `missing`: same identity, and the host says it is not a tracked regular
 *   file at the selected revision.
 * - `unreadable`: present, but its bytes could not be read (over the version
 *   ceiling or an I/O failure). Not `missing`, since restoring a present file
 *   is not actionable, and per source so one file cannot stop the others.
 * - `identity-changed`: the reference now resolves to a different identity. No
 *   digest is taken, since comparing across identities would report drift.
 */
export const SOURCE_REVALIDATION_STATES = [
  "fresh",
  "stale",
  "missing",
  "unreadable",
  "identity-changed",
] as const;

export type SourceRevalidationStateV1 = (typeof SOURCE_REVALIDATION_STATES)[number];

/**
 * Which recorded fact a state was reached by comparing, rendered beside the
 * state so `fresh` over a recorded digest and `fresh` on a first observation do
 * not print the same.
 *
 * The project-identity bases re-resolve only the project (host and path to
 * numeric id), not the change number, merge commit, or merge-request state.
 * `not-compared` is the basis for `missing` and `unreadable`, where nothing
 * could be read to compare.
 */
export const SOURCE_REVALIDATION_BASES = [
  "recorded-digest",
  "first-observation",
  "recorded-project-identity",
  "unresolved-project-identity",
  "not-compared",
] as const;

export type SourceRevalidationBasisV1 = (typeof SOURCE_REVALIDATION_BASES)[number];

/**
 * Bind-time refusal for every revalidation state except `fresh`. A total
 * `Record`, so a new state fails to compile until it names a refusal. A `fresh`
 * outside {@link LiveSourceRevalidationV1.withinWindow} is `bind-expired`.
 */
export const SOURCE_BIND_REFUSAL_BY_STATE: Readonly<
  Record<Exclude<SourceRevalidationStateV1, "fresh">, SourceCommandRefusalCodeV1>
> = Object.freeze({
  stale: "bind-stale",
  missing: "bind-missing",
  unreadable: "bind-unreadable",
  "identity-changed": "bind-identity-changed",
});

/**
 * What one revalidation concluded, as the listing carries it afterwards.
 *
 * No timestamp is projected: the check time is held privately so two surfaces
 * that ran the same command render identical bytes.
 */
export interface LiveSourceRevalidationV1 {
  readonly state: SourceRevalidationStateV1;
  readonly basis: SourceRevalidationBasisV1;
  /**
   * False once the verdict is older than
   * `sources.revalidationFreshnessWindowMinutes`. The state and basis stay as
   * recorded; only their currency lapses.
   */
  readonly withinWindow: boolean;
}

/**
 * One attached source, as the terminal shows it. Carries no source bytes and
 * no host filesystem path; `repositoryPath` is repository-relative because it
 * passed `contextPath` admission.
 */
export interface LiveAttachedSourceV1 {
  readonly entryId: string;
  readonly kind: LiveSourceKindV1;
  /** What the listing prints and what `show`/`remove` match byte for byte. */
  readonly label: string;
  readonly locator: string;
  readonly repositoryPath: string | null;
  /** Canonical numeric project id for a merged change. Null for a file. */
  readonly projectId: number | null;
  /** The project path recorded beside the id, never substituted for it. */
  readonly projectPath: string | null;
  readonly changeNumber: number | null;
  readonly format: string;
  readonly status: LiveSourceStatusV1;
  readonly version: string | null;
  readonly limitations: readonly string[];
  readonly historicalUse: readonly string[];
  readonly requiredBy: readonly string[];
  /** Null when never revalidated, which is never conflated with `fresh`. */
  readonly revalidation: LiveSourceRevalidationV1 | null;
}

export type SourceRefreshDispositionV1 = "unchanged" | "drifted" | "unavailable" | "immutable";

export interface SourceRefreshOutcomeV1 {
  readonly entryId: string;
  readonly label: string;
  readonly disposition: SourceRefreshDispositionV1;
  readonly previousVersion: string | null;
  readonly version: string | null;
}

/** One source's revalidation verdict, as the report carries it. */
export interface SourceRevalidationOutcomeV1 {
  readonly entryId: string;
  readonly label: string;
  readonly state: SourceRevalidationStateV1;
  readonly basis: SourceRevalidationBasisV1;
  /** The version this conversation held before the check. Never rewritten. */
  readonly recordedVersion: string | null;
  /** The version the repository holds now, when one could be taken. */
  readonly observedVersion: string | null;
}

export type SourceCommandOutcomeV1 =
  | {
      readonly kind: "listing";
      readonly entries: readonly LiveAttachedSourceV1[];
      readonly changeReview?: LiveAgentChangeReviewSelectionV1;
    }
  | { readonly kind: "review-selected"; readonly selection: LiveAgentChangeReviewSelectionV1 }
  | { readonly kind: "review-detail"; readonly selection: LiveAgentChangeReviewSelectionV1 }
  | {
      readonly kind: "review-detached";
      readonly selection: LiveAgentChangeReviewSelectionV1;
      readonly entries: readonly LiveAttachedSourceV1[];
    }
  | {
      readonly kind: "attached";
      readonly entry: LiveAttachedSourceV1;
      readonly entries: readonly LiveAttachedSourceV1[];
    }
  | {
      readonly kind: "detached";
      readonly entry: LiveAttachedSourceV1;
      readonly entries: readonly LiveAttachedSourceV1[];
    }
  | {
      readonly kind: "detail";
      readonly entry: LiveAttachedSourceV1;
      readonly preview: string | null;
      readonly previewTruncated: boolean;
    }
  | { readonly kind: "refreshed"; readonly results: readonly SourceRefreshOutcomeV1[] }
  | {
      readonly kind: "revalidated";
      readonly results: readonly SourceRevalidationOutcomeV1[];
      /** Every attached source after the check, to prove none was dropped. */
      readonly entries: readonly LiveAttachedSourceV1[];
    }
  | {
      readonly kind: "search";
      readonly descriptorCount: number;
      readonly windowCovered: boolean;
      readonly result: SourceDiscoveryResultV1;
    }
  /**
   * Phase one of a purge: what would be deleted, having deleted nothing.
   * `confirmation` is null exactly when there is nothing to delete.
   */
  | {
      readonly kind: "purge-preview";
      readonly sessions: readonly SourcePurgeSessionPreviewV1[];
      readonly confirmation: string | null;
      /** Copy rows the preview row cap withheld, across every named session. */
      readonly rowsNotPrinted: number;
      readonly retentionNote: string;
    }
  /**
   * Phase two: what was deleted, and the custody records admitting it.
   * `entries` shows that a purge detaches nothing.
   */
  | {
      readonly kind: "purged";
      readonly sessions: readonly SourcePurgeSessionPreviewV1[];
      readonly custody: readonly SourcePurgeCustodyRecordV1[];
      readonly removedCopies: number;
      readonly removedBytes: number;
      readonly rowsNotPrinted: number;
      readonly retentionNote: string;
      readonly entries: readonly LiveAttachedSourceV1[];
    };
