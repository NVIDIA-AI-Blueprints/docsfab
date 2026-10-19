// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The host-parsed `/sources` command family in the live terminal.
 *
 * - Loading a command is not authority. A `/sources` line is read off the
 *   terminal's own input stream before any message reaches the session; model
 *   output never passes through {@link LiveAgentSourceSelection.dispatch}, so
 *   a model that emits `/sources add ...` mutates nothing.
 * - Parsing is literal. The argument is the rest of the line, trimmed, with no
 *   shell expansion, quote stripping, or glob. A path argument goes only to
 *   `contextPath`, the validator `docsfab run --source` uses.
 * - Identity is resolved, never assumed. A merge-request reference is parsed,
 *   then resolved to a proved project path and numeric id. The proved scope
 *   stays in a private field, never in an entry, rendered line, or request, so
 *   it cannot round-trip through the durable session file.
 *
 * An attached entry is a selection, the same request fields `--source` and
 * `--pr` produce, and {@link LiveAgentSourceSelection.requestFields} is the one
 * projection the run path reads, so the listing and the next run cannot
 * disagree. Attaching reads no source bytes; a version appears on `/sources refresh`.
 * No model-facing tool is registered: a live conversation has no step read
 * grant, so `/sources search` is the operator channel for the searcher.
 */

import { createHash } from "node:crypto";

import { contextPath } from "../cli/options.js";
import { limit, type ResolvedLimit } from "../config/limits.js";
import { canonicalDigest } from "../content-ir/canonical.js";
import {
  failChangeRequestSelector,
  isValidatedChangeRequestSelector,
  parseChangeRequestSelector,
  type ChangeRequestSelectorV1,
} from "../inputs/change-request-selector.js";
import {
  liveAgentChangeReviewSelection,
  parseLiveAgentChangeReviewReference,
  type LiveAgentChangeReviewSelectorV1,
} from "./change-review.js";
import { canonicalGitlabMrReviewLocator } from "../inputs/gitlab-mr-locator.js";
import {
  resolveGitLabAcquisitionScope,
  type GitLabAcquisitionScopeV1,
  type GitLabProjectIdentityPortV1,
} from "../inputs/gitlab-source-provider.js";
import {
  trackedSourceCanonicalLocator,
  TrackedSourceOversizeError,
  type TrackedSourceReaderV1,
} from "../inputs/source-acquisition.js";
import { SourceDiscoveryError, type SourceDiscoveryResultV1 } from "../inputs/source-discovery.js";
import { classifySourceMediaType } from "../inputs/source-extractor-registry.js";
import {
  SOURCE_SEARCH_MAX_DESCRIPTORS,
  type SourceStepSearcherV1,
} from "../inputs/source-step-search.js";
import {
  isSessionReference,
  PURGE_MAX_SESSIONS,
  PURGE_PREVIEW_MAX_ROWS,
  shortIdentifier,
  sourcePurgeConfirmation,
  sourcePurgeCustodyRecordId,
  SOURCE_PURGE_RETENTION_NOTE,
  SOURCE_STATE_OPERATION_MESSAGES,
  SESSION_SOURCE_COPY_KIND_MESSAGES,
  SessionSourceRemovalError,
  type SessionSourceCopyV1,
  type SessionSourceCustodyPortV1,
  type SessionSourceInventoryV1,
  type SourcePurgeCustodyRecordV1,
  type SourcePurgeEntryPointV1,
  type SourcePurgeSessionPreviewV1,
} from "./source-custody.js";
import { SOURCE_REVALIDATION_STATE_MESSAGES } from "./source-commands/messages.js";
import { SOURCE_VERSION_MAX_BYTES } from "./source-commands/contracts.js";
export { SOURCE_REVALIDATION_STATE_MESSAGES } from "./source-commands/messages.js";
export { SOURCE_VERSION_MAX_BYTES } from "./source-commands/contracts.js";
import { assertConfinedToolResultCredentialFree } from "../security/credential-isolation.js";
import { egressValue, type HostRootSet } from "../security/egress.js";
import { processHostRootSet } from "../security/host-roots.js";
import { getWorkflow } from "../workflow-registry/catalog.js";
import type { RunnableWorkflowName } from "../workflow-registry/catalog.js";
import {
  SOURCE_BIND_REFUSAL_BY_STATE,
  SOURCE_REVALIDATION_BASES,
  SOURCE_REVALIDATION_FRESHNESS_WINDOW_LIMIT,
  SOURCE_REVALIDATION_STATES,
  SOURCE_COMMAND_SEARCH_CEILING,
  NO_RECORDED_PROJECT_REFERENCE_DETAIL,
  SourceCommandError,
  failSourceCommand,
  type LiveAttachedSourceV1,
  type LiveSourceKindV1,
  type LiveSourceRevalidationV1,
  type LiveSourceStatusV1,
  type SourceCommandOutcomeV1,
  type SourceCommandRefusalCodeV1,
  type SourceRevalidationBasisV1,
  type SourceRevalidationOutcomeV1,
  type SourceRevalidationStateV1,
  type SourceRefreshOutcomeV1,
} from "./source-commands/contracts.js";
import {
  isSourceCommandLine as isSourceCommandLineLeaf,
  parseSourceCommand as parseSourceCommandLeaf,
  type SourceCommandInvocationV1,
} from "./source-commands/parser.js";
import {
  renderPresentation,
  resolveProcessPresentationCapabilities,
  type PresentationCapabilities,
} from "../operator/index.js";
import { projectSourceCommandOutcome } from "./source-presentation.js";
import {
  decodeSourceSnapshot,
  decodeSourceSnapshotRecord,
  decodeSourceSnapshotVerdict,
  failSourceSnapshot,
} from "./source-commands/snapshot.js";

export {
  NO_RECORDED_PROJECT_REFERENCE_DETAIL,
  SOURCE_BIND_REFUSAL_BY_STATE,
  SOURCE_COMMAND_REFUSAL_CODES,
  SOURCE_COMMAND_REFUSALS,
  SOURCE_COMMAND_SEARCH_CEILING,
  SOURCE_COMMAND_VERBS,
  SOURCE_REVALIDATION_BASES,
  SOURCE_REVALIDATION_FRESHNESS_WINDOW_LIMIT,
  SOURCE_REVALIDATION_STATES,
  SourceCommandError,
  failSourceCommand,
  type LiveAttachedSourceV1,
  type LiveSourceKindV1,
  type LiveSourceRevalidationV1,
  type LiveSourceStatusV1,
  type SourceCommandOutcomeV1,
  type SourceCommandRefusalCodeV1,
  type SourceCommandVerbV1,
  type SourceRevalidationBasisV1,
  type SourceRevalidationOutcomeV1,
  type SourceRevalidationStateV1,
  type SourceRefreshDispositionV1,
  type SourceRefreshOutcomeV1,
} from "./source-commands/contracts.js";
export type { SourceCommandInvocationV1 } from "./source-commands/parser.js";

export function parseSourceCommand(line: unknown): SourceCommandInvocationV1 | undefined {
  return parseSourceCommandLeaf(line, SOURCE_COMMAND_PREFIX, SOURCE_COMMAND_LINE_LIMIT);
}

export function isSourceCommandLine(line: unknown): boolean {
  return isSourceCommandLineLeaf(line, SOURCE_COMMAND_PREFIX);
}

export const SOURCE_REVALIDATION_MAX_ENTRIES_LIMIT = "sources.revalidationMaxEntries" as const;

export const SOURCE_COMMAND_PREFIX = "/sources" as const;

/** Longest `/sources` line parsed at all, so a huge paste is refused without being walked. */
export const SOURCE_COMMAND_LINE_LIMIT = 1024;

/** Bytes of one `/sources show` preview read from the selected revision. */
export const SOURCE_PREVIEW_MAX_BYTES = 2048;

/** Characters of a decoded preview that reach the terminal. */
export const SOURCE_PREVIEW_MAX_CHARACTERS = 1024;

/**
 * Both revalidation bounds, resolved once at module load so a host override
 * fails at start-up and one session never sees two values.
 */
const REVALIDATION_MAX_ENTRIES: ResolvedLimit = limit(SOURCE_REVALIDATION_MAX_ENTRIES_LIMIT);
const REVALIDATION_WINDOW: ResolvedLimit = limit(SOURCE_REVALIDATION_FRESHNESS_WINDOW_LIMIT);

/**
 * The freshness window in milliseconds. Converted through `setUTCMinutes` so
 * no second conversion factor sits beside the declared minute limit.
 */
export function sourceRevalidationWindowMs(minutes: number = REVALIDATION_WINDOW.value): number {
  const fromEpoch = new Date(0);
  fromEpoch.setUTCMinutes(minutes);
  return fromEpoch.getTime();
}

const REVALIDATION_WINDOW_MS = sourceRevalidationWindowMs();

/** Value and unit from the catalog, so the sentence matches `docsfab doctor --limits`. */
/**
 * Host seams this dispatcher reaches through. Each absence is a coded stop,
 * not a silent degradation. The host wires the ports; no `/sources` argument
 * selects or widens one.
 */
export interface LiveAgentSourcePortsV1 {
  readonly identityPort?: GitLabProjectIdentityPortV1;
  /**
   * Open a tracked reader over the selected revision for one command. A factory
   * so each `/sources` verb opens one export instead of pinning one for the
   * whole conversation.
   */
  readonly withTrackedSourceReader?: <T>(
    use: (reader: TrackedSourceReaderV1) => Promise<T>,
  ) => Promise<T>;
  /** Absent unless the deployment opted in; `/sources search` refuses without it. */
  readonly searcher?: SourceStepSearcherV1;
  /**
   * The project a bare `!123` means, resolved lazily from the checkout's own
   * remote. The port raises `checkout-project-unavailable` after it looks.
   */
  readonly checkoutProject?: () => Promise<{
    readonly host: string;
    readonly projectPath: string;
  }>;
  /**
   * Wall-clock milliseconds for the revalidation freshness window and the purge
   * custody record's time. Revalidation projects only the derived
   * {@link LiveSourceRevalidationV1.withinWindow}.
   */
  readonly now?: () => number;
  /**
   * The store holding this deployment's owned local session copies. Absent in
   * shipped hosts, so `purge` refuses with `custody-unavailable` and DocsFab
   * claims no deletion.
   */
  readonly custody?: SessionSourceCustodyPortV1;
  /**
   * Which surface is running this command, for the custody record only. Required
   * whenever {@link custody} is wired (else `entry-point-unrecorded`); never rendered.
   */
  readonly entryPoint?: SourcePurgeEntryPointV1;
  /**
   * The session this conversation is conducting, read only to decide whether a
   * purge naming it must also invalidate this selection's process-local
   * derivatives. Never projected.
   */
  readonly sessionId?: string;
  /**
   * This host's roots, replaced in every outcome before it is rendered or kept.
   * Defaults to HOME and the tmpdir, less `DOCSFAB_PUBLIC_ROOTS`.
   */
  readonly hostRoots?: HostRootSet;
}

export interface LiveAgentSourceSelectionInputV1 {
  readonly sourcePaths?: readonly string[];
  readonly changeRequestSelector?: ChangeRequestSelectorV1;
  readonly changeSource?: LiveAgentChangeReviewSelectorV1;
  readonly ports?: LiveAgentSourcePortsV1;
}

/** Durable operator selection and its immutable admission/revalidation baseline. */
export interface LiveAgentSourceSelectionSnapshotV1 {
  readonly schema_version: 1;
  readonly entries: readonly {
    readonly kind: LiveSourceKindV1;
    readonly repositoryPath: string | null;
    readonly selector: ChangeRequestSelectorV1 | null;
    readonly admission: SourceAdmissionRecordV1;
    readonly version: string | null;
    readonly status: LiveSourceStatusV1;
    readonly limitations: readonly string[];
    readonly refreshCount: number;
    readonly revalidationCount: number;
    readonly revalidation: MutableEntry["revalidation"];
  }[];
  /** Operator-named review basis; parsed again on restore and never resolved here. */
  readonly changeReviewReference?: string;
}

/** The two request fields the shared execution assembly reads. Nothing else. */
export interface LiveAgentSourceRequestFieldsV1 {
  readonly sourcePaths?: readonly string[];
  readonly changeRequestSelector?: ChangeRequestSelectorV1;
  readonly changeSource?: LiveAgentChangeReviewSelectorV1;
}

/**
 * What was admitted, frozen at attachment: the baseline a revalidation compares
 * against. Never rewritten; `refresh` moves the entry's version, not this.
 *
 * Only `host`, `projectPath`, and `projectId` are compared, on the merged-change
 * path. A file's identity fields derive from an immutable path, and
 * `changeNumber` would need a second forge read; the rest are recorded for
 * custody and inspection.
 */
interface SourceAdmissionRecordV1 {
  readonly kind: LiveSourceKindV1;
  readonly label: string;
  readonly locator: string;
  readonly repositoryPath: string | null;
  readonly host: string | null;
  readonly projectPath: string | null;
  /**
   * The project id proved at admission, or null when the selector carried only
   * a path. Null is a recorded fact, never filled in later.
   */
  readonly projectId: number | null;
  readonly changeNumber: number | null;
  readonly format: string;
}

interface MutableEntry {
  entryId: string;
  kind: LiveSourceKindV1;
  label: string;
  locator: string;
  repositoryPath: string | null;
  projectId: number | null;
  projectPath: string | null;
  changeNumber: number | null;
  selector: ChangeRequestSelectorV1 | null;
  format: string;
  status: LiveSourceStatusV1;
  version: string | null;
  limitations: string[];
  refreshCount: number;
  revalidationCount: number;
  boundRunCount: number;
  /** Step id to the number of in-flight runs that have bound this entry. */
  requiredBy: Map<string, number>;
  readonly admission: SourceAdmissionRecordV1;
  revalidation: {
    state: SourceRevalidationStateV1;
    basis: SourceRevalidationBasisV1;
    /** Private. Only the derived `withinWindow` boolean is ever projected. */
    atMs: number;
  } | null;
}

/**
 * Change-request shapes. A terminal line has no `--source`/`--pr` flag, so a
 * reference that looks like a change request goes to the selector parser and
 * everything else is a repository path; the shapes are disjoint.
 *
 * The scheme needs two or more characters before the colon, so a Windows drive
 * letter such as `C:/docs/notes.md` is routed as a path.
 */
const CHANGE_REQUEST_SHAPE = /^(?:[A-Za-z][A-Za-z0-9+.-]+:|!?\d+$|[^/\s]+\/\S*!\d+$)/u;

function looksLikeChangeRequest(value: string): boolean {
  return CHANGE_REQUEST_SHAPE.test(value);
}

/** Short, stable, content-free version label for a tracked file's exact bytes. */
function versionOfBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 12);
}

/**
 * Look at one attached file at the selected revision, for a revalidation.
 *
 * Not `#readTracked`, which flattens every failure into `source-unreadable`:
 * a revalidation must tell an absent file from a present one it could not
 * read. The reader's own error is never relayed, since it can carry a host path.
 */
async function observeTracked(
  reader: TrackedSourceReaderV1,
  entry: MutableEntry,
): Promise<FileObservationV1> {
  const repositoryPath = entry.repositoryPath as string;
  try {
    if (!(await reader.isTrackedRegularFile(repositoryPath))) return { kind: "absent" };
  } catch {
    // The host could not answer whether the file is there; that is not absence.
    return { kind: "unreadable" };
  }
  try {
    return {
      kind: "read",
      version: versionOfBytes(
        await reader.readTrackedBytes(repositoryPath, SOURCE_VERSION_MAX_BYTES),
      ),
    };
  } catch {
    // Every read failure means the file is there and its bytes did not arrive.
    return { kind: "unreadable" };
  }
}

/**
 * What one revalidation read of a repository file established. `absent` and
 * `unreadable` stay distinct because the operator acts on them differently.
 */
type FileObservationV1 =
  | { readonly kind: "read"; readonly version: string }
  | { readonly kind: "absent" }
  | { readonly kind: "unreadable" };

/**
 * Classify one repository file's revalidation from what the read established.
 *
 * Never `identity-changed`: a file entry's identity is its immutable
 * repository-relative path, so only reachability, readability, and digest can
 * change.
 */
function fileRevalidationOutcome(
  entry: MutableEntry,
  observation: FileObservationV1,
): SourceRevalidationOutcomeV1 {
  const recordedVersion = entry.version;
  if (observation.kind !== "read") {
    // Nothing was compared, so no comparison is claimed; the recorded version
    // is still reported.
    return {
      entryId: entry.entryId,
      label: entry.label,
      state: observation.kind === "absent" ? "missing" : "unreadable",
      basis: "not-compared",
      recordedVersion,
      observedVersion: null,
    };
  }
  return {
    entryId: entry.entryId,
    label: entry.label,
    state: recordedVersion !== null && recordedVersion !== observation.version ? "stale" : "fresh",
    // `first-observation` means the file reads cleanly now and says nothing
    // about whether it moved since it was attached.
    basis: recordedVersion === null ? "first-observation" : "recorded-digest",
    recordedVersion,
    observedVersion: observation.version,
  };
}

/**
 * Project one session's inventory into the preview an operator confirms.
 *
 * `copies` is the whole deletion set and `rowsNotPrinted` counts what the
 * renderer withholds, so the row cap shortens only the printing, never what a
 * confirmation authorizes.
 */
function purgePreview(inventory: SessionSourceInventoryV1): SourcePurgeSessionPreviewV1 {
  const copies = Object.freeze([...inventory.copies]);
  return Object.freeze({
    sessionId: inventory.sessionId,
    copies,
    rowsNotPrinted: Math.max(0, copies.length - PURGE_PREVIEW_MAX_ROWS.value),
    // A run referencing two copies is still one affected run.
    affectedRunIds: Object.freeze([...new Set(copies.flatMap((copy) => [...copy.runIds]))].sort()),
    retainedScopes: Object.freeze([...inventory.retainedScopes]),
    previouslyPurgedAt: inventory.previouslyPurgedAt,
    bytes: copies.reduce((total, copy) => total + copy.bytes, 0),
  });
}

/** Build the durable admission for one session's deletion. Pure. */
function custodyRecord(input: {
  readonly preview: SourcePurgeSessionPreviewV1;
  readonly removed: readonly SessionSourceCopyV1[];
  readonly notRemoved: readonly SessionSourceCopyV1[];
  readonly at: string;
  readonly entryPoint: SourcePurgeEntryPointV1;
  readonly principal: SessionSourceCustodyPortV1["principal"];
  readonly confirmation: string;
  readonly incomplete: boolean;
}): SourcePurgeCustodyRecordV1 {
  return Object.freeze({
    schemaVersion: 1 as const,
    kind: "docsfab-session-source-purge-custody-record" as const,
    recordId: sourcePurgeCustodyRecordId({
      sessionId: input.preview.sessionId,
      at: input.at,
      confirmation: input.confirmation,
    }),
    sessionId: input.preview.sessionId,
    at: input.at,
    operation: "purge" as const,
    reason: "operator-requested" as const,
    entryPoint: input.entryPoint,
    principal: input.principal,
    removed: Object.freeze(
      input.removed.map((copy) =>
        Object.freeze({ copyId: copy.copyId, kind: copy.kind, bytes: copy.bytes }),
      ),
    ),
    notRemoved: Object.freeze(
      input.notRemoved.map((copy) => Object.freeze({ copyId: copy.copyId, kind: copy.kind })),
    ),
    affectedRunIds: input.preview.affectedRunIds,
    retainedScopes: input.preview.retainedScopes,
    incomplete: input.incomplete,
    confirmation: input.confirmation,
    // Carried verbatim so the record keeps the wording the operator confirmed.
    retentionNote: SOURCE_PURGE_RETENTION_NOTE,
  });
}

function entryIdOfLocator(locator: string): string {
  return shortIdentifier(
    "src",
    canonicalDigest({
      schemaVersion: 1 as const,
      kind: "docsfab-live-attached-source" as const,
      locator,
    }),
  );
}

/**
 * A verdict this command is about to commit, substituted into the projection.
 * Both fields travel together so the listing is not current in one and stale
 * in the other.
 */
interface PendingRevalidationV1 {
  readonly revalidation: NonNullable<MutableEntry["revalidation"]>;
  /** The count after this command commits, not the one recorded so far. */
  readonly revalidationCount: number;
}

function projectEntry(
  entry: MutableEntry,
  nowMs: number,
  revalidation: MutableEntry["revalidation"],
  revalidationCount: number,
): LiveAttachedSourceV1 {
  const historicalUse: string[] = ["attached in this conversation"];
  if (entry.refreshCount > 0) {
    historicalUse.push(
      entry.refreshCount === 1 ? "refreshed once" : `refreshed ${entry.refreshCount} times`,
    );
  }
  if (revalidationCount > 0) {
    historicalUse.push(
      revalidationCount === 1 ? "revalidated once" : `revalidated ${revalidationCount} times`,
    );
  }
  if (entry.boundRunCount > 0) {
    historicalUse.push(
      entry.boundRunCount === 1
        ? "bound by 1 workflow run"
        : `bound by ${entry.boundRunCount} workflow runs`,
    );
  }
  if (entry.requiredBy.size > 0) historicalUse.push("required by a run in flight");
  return Object.freeze({
    entryId: entry.entryId,
    kind: entry.kind,
    label: entry.label,
    locator: entry.locator,
    repositoryPath: entry.repositoryPath,
    projectId: entry.projectId,
    projectPath: entry.projectPath,
    changeNumber: entry.changeNumber,
    format: entry.format,
    status: entry.status,
    version: entry.version,
    limitations: Object.freeze([...entry.limitations]),
    historicalUse: Object.freeze(historicalUse),
    requiredBy: Object.freeze([...entry.requiredBy.keys()].sort()),
    revalidation:
      revalidation === null
        ? null
        : Object.freeze({
            state: revalidation.state,
            basis: revalidation.basis,
            // At the window exactly, the verdict is still current; one
            // millisecond past it, it is not.
            withinWindow: nowMs - revalidation.atMs <= REVALIDATION_WINDOW_MS,
          }),
  });
}

/**
 * Refuse, at admission, a home-relative reference and one that holds a
 * configured credential.
 *
 * `contextPath` admits `~/notes.md`, which names the operator's home rather
 * than a tracked file. Refusing here, before the entry is attached, keeps a
 * poisoned entry unrepresentable. A composed merged-change label (for example
 * a project path from the checkout remote that holds a configured credential)
 * is screened at the outcome, against a candidate the selection does not hold
 * yet.
 */
function assertAdmissibleReference(reference: string): void {
  if (reference === "~" || reference.startsWith("~/")) failSourceCommand("invalid-reference");
  try {
    assertConfinedToolResultCredentialFree(reference);
  } catch {
    failSourceCommand("invalid-reference");
  }
}

/**
 * Screen everything a `/sources` outcome would disclose for credentials,
 * fail-closed, then replace this host's roots.
 *
 * Applied to the structured outcome, not the rendered text. A credential, or
 * two keys that merge once their roots are replaced, withholds the whole
 * outcome rather than clipping it.
 */
function screenDisclosure<T>(outcome: T, hostRoots: HostRootSet): T {
  try {
    assertConfinedToolResultCredentialFree(outcome);
  } catch {
    failSourceCommand("disclosure-screen");
  }
  const projected = egressValue(outcome, hostRoots);
  if (!projected.ok) failSourceCommand("disclosure-screen");
  return projected.replaced.length === 0 ? outcome : projected.value;
}

/**
 * The live conversation's attached source selection.
 *
 * The listing and {@link requestFields} are two projections of this one state,
 * so they cannot drift apart. {@link assertBindable} gates the request: a last
 * verdict that is not a current `fresh` refuses the run without removing the
 * source from either projection. Hosts construct it through
 * `createLiveAgentSourceSelection`; the model has no channel to it.
 */
export class LiveAgentSourceSelection {
  readonly #entries: MutableEntry[] = [];
  readonly #ports: LiveAgentSourcePortsV1;
  #changeSource: LiveAgentChangeReviewSelectorV1 | undefined;
  /**
   * Proved acquisition scopes, keyed by entry id and never written anywhere
   * durable. Held off the entry because a proof does not survive serialization.
   */
  readonly #scopes = new Map<string, GitLabAcquisitionScopeV1>();

  /** The only clock this module reads. See {@link LiveAgentSourcePortsV1.now}. */
  readonly #now: () => number;

  readonly #hostRoots: HostRootSet;

  /**
   * Build the selection from what the operator typed at session start.
   *
   * Establishes the dispatcher's invariants itself rather than trusting the
   * caller: refuses duplicate labels (which would share an `entryId`), screens
   * each reference as `/sources add` does, and re-validates the selector. A
   * session whose argv cannot produce a sound selection fails to start.
   */
  public constructor(input: LiveAgentSourceSelectionInputV1 = {}) {
    this.#ports = input.ports ?? {};
    if (input.changeSource && input.changeRequestSelector) failSourceCommand("one-change-request");
    this.#now = this.#ports.now ?? (() => Date.now());
    this.#hostRoots = this.#ports.hostRoots ?? processHostRootSet();
    if (input.changeSource) {
      this.#screen({
        kind: "review-selected" as const,
        selection: liveAgentChangeReviewSelection(input.changeSource),
      });
      this.#changeSource = input.changeSource;
    }
    for (const repositoryPath of input.sourcePaths ?? []) {
      assertAdmissibleReference(repositoryPath);
      const entry = this.#buildFile(repositoryPath);
      this.#assertUnusedLabel(entry);
      this.#entries.push(entry);
    }
    if (input.changeRequestSelector) {
      // Validated here too because `host` and `projectPath` become a rendered
      // label before any request exists.
      if (!isValidatedChangeRequestSelector(input.changeRequestSelector)) {
        failSourceCommand("invalid-reference");
      }
      const entry = this.#buildChange(input.changeRequestSelector, null);
      assertAdmissibleReference(entry.label);
      this.#assertUnusedLabel(entry);
      this.#entries.push(entry);
    }
  }

  #screen<T>(outcome: T): T {
    return screenDisclosure(outcome, this.#hostRoots);
  }

  /** Every attached source, in operator order. */
  public entries(): readonly LiveAttachedSourceV1[] {
    return this.#project(this.#entries);
  }

  /** Capture admitted sources and verdict history without acquisition authority or bytes. */
  public snapshotState(): LiveAgentSourceSelectionSnapshotV1 {
    const changeReviewReference = this.#changeSource
      ? liveAgentChangeReviewSelection(this.#changeSource).reference
      : undefined;
    const snapshot = Object.freeze({
      schema_version: 1 as const,
      entries: Object.freeze(
        this.#entries.map((entry) =>
          Object.freeze({
            kind: entry.kind,
            repositoryPath: entry.repositoryPath,
            selector: entry.selector,
            admission: entry.admission,
            version: entry.version,
            status: entry.status,
            limitations: Object.freeze([...entry.limitations]),
            refreshCount: entry.refreshCount,
            revalidationCount: entry.revalidationCount,
            revalidation: entry.revalidation,
          }),
        ),
      ),
      ...(changeReviewReference ? { changeReviewReference } : {}),
    });
    assertConfinedToolResultCredentialFree(snapshot);
    return snapshot;
  }

  /** Restore a validated snapshot atomically; merged-change scopes are re-proved. */
  public async restoreState(value: unknown): Promise<void> {
    const { records, changeReviewReference } = decodeSourceSnapshot(value);
    let restoredChangeSource: LiveAgentChangeReviewSelectorV1 | undefined;
    if (changeReviewReference !== undefined) {
      try {
        restoredChangeSource = parseLiveAgentChangeReviewReference(changeReviewReference);
      } catch {
        failSourceSnapshot("invalid-value");
      }
    }
    const restored: MutableEntry[] = [];
    const restoredScopes = new Map<string, GitLabAcquisitionScopeV1>();
    for (const raw of records) {
      const item = decodeSourceSnapshotRecord(raw);
      const admissionRaw = item.admission as Record<string, unknown>;
      let entry: MutableEntry | undefined;
      if (
        item.kind === "repository-file" &&
        typeof item.repositoryPath === "string" &&
        item.selector === null
      ) {
        assertAdmissibleReference(item.repositoryPath);
        entry = this.#buildFile(item.repositoryPath);
      } else if (
        item.kind === "merged-change" &&
        item.repositoryPath === null &&
        isValidatedChangeRequestSelector(item.selector)
      ) {
        let scope: GitLabAcquisitionScopeV1 | null = null;
        const admission = admissionRaw as unknown as SourceAdmissionRecordV1;
        if (
          admission.projectId !== null ||
          admission.host !== null ||
          admission.projectPath !== null
        ) {
          if (admission.host === null || admission.projectPath === null)
            failSourceSnapshot("invalid-value");
          try {
            scope = await resolveGitLabAcquisitionScope({
              reference: { host: admission.host, projectPath: admission.projectPath },
              identityPort: this.#ports.identityPort,
            });
          } catch {
            failSourceCommand("identity-unverifiable");
          }
          if (
            scope.host !== admission.host ||
            scope.projectPath !== admission.projectPath ||
            (admission.projectId !== null && scope.projectId !== admission.projectId)
          ) {
            failSourceCommand("bind-identity-changed");
          }
          // A null id is part of the admission baseline; proving it now does
          // not retroactively turn the original selector into a scoped one.
          if (admission.projectId === null) scope = null;
          else
            restoredScopes.set(
              entryIdOfLocator(
                canonicalGitlabMrReviewLocator({
                  host: scope.host,
                  projectId: scope.projectId,
                  mergeRequestIid: (item.selector as ChangeRequestSelectorV1).number,
                }),
              ),
              scope,
            );
        }
        entry = this.#buildChange(item.selector, scope);
      } else failSourceSnapshot("invalid-value");
      if (!entry)
        throw new Error(
          "Source snapshot rejected: invalid-value. Start a new session and reselect sources from the current checkout.",
        );
      const rawRevalidation =
        item.revalidation === null ? null : decodeSourceSnapshotVerdict(item.revalidation);
      const revalidation = rawRevalidation as MutableEntry["revalidation"];
      if (
        canonicalDigest(entry.admission) !== canonicalDigest(admissionRaw) ||
        (revalidation !== null &&
          (!SOURCE_REVALIDATION_STATES.includes(revalidation.state as SourceRevalidationStateV1) ||
            !SOURCE_REVALIDATION_BASES.includes(revalidation.basis as SourceRevalidationBasisV1) ||
            !Number.isFinite(revalidation.atMs)))
      )
        failSourceSnapshot("invalid-value");
      if (item.revalidation !== null) {
        const verdict = item.revalidation as NonNullable<MutableEntry["revalidation"]>;
        const validPair =
          entry.kind === "repository-file"
            ? (verdict.state === "fresh" &&
                (verdict.basis === "recorded-digest" || verdict.basis === "first-observation")) ||
              (verdict.state === "stale" && verdict.basis === "recorded-digest") ||
              ((verdict.state === "missing" || verdict.state === "unreadable") &&
                verdict.basis === "not-compared")
            : (verdict.state === "fresh" || verdict.state === "identity-changed") &&
              ((verdict.basis === "recorded-project-identity" &&
                entry.admission.projectId !== null) ||
                (verdict.basis === "unresolved-project-identity" &&
                  entry.admission.projectId === null));
        if (!validPair) failSourceSnapshot("invalid-value");
      }
      if (revalidation !== null && item.revalidationCount === 0)
        failSourceSnapshot("invalid-value");
      entry.version = item.version as string | null;
      entry.status = item.status as LiveSourceStatusV1;
      entry.limitations = item.limitations as string[];
      entry.refreshCount = item.refreshCount as number;
      entry.revalidationCount = item.revalidationCount as number;
      entry.revalidation = revalidation;
      if (restored.some((existing) => existing.entryId === entry.entryId))
        failSourceSnapshot("invalid-value");
      restored.push(entry);
    }
    const restoredMergedChanges = restored.filter((entry) => entry.kind === "merged-change");
    if (
      restoredMergedChanges.length > 1 ||
      (restoredChangeSource && restoredMergedChanges.length > 0)
    )
      failSourceSnapshot("invalid-value");
    if (this.#entries.length > 0 || this.#changeSource !== undefined) {
      const savedFields = {
        ...(restored.filter((entry) => entry.kind === "repository-file").length > 0
          ? {
              sourcePaths: restored
                .filter((entry) => entry.kind === "repository-file")
                .map((entry) => entry.repositoryPath as string),
            }
          : {}),
        ...(restored.find((entry) => entry.kind === "merged-change")?.selector
          ? {
              changeRequestSelector: restored.find((entry) => entry.kind === "merged-change")
                ?.selector as ChangeRequestSelectorV1,
            }
          : {}),
        ...(restoredChangeSource ? { changeSource: restoredChangeSource } : {}),
      };
      if (canonicalDigest(this.requestFields()) !== canonicalDigest(savedFields))
        failSourceSnapshot("invalid-value");
    }
    this.#screen({ snapshot: value });
    this.#entries.splice(0, this.#entries.length, ...restored);
    this.#changeSource = restoredChangeSource;
    this.#scopes.clear();
    for (const [entryId, scope] of restoredScopes) this.#scopes.set(entryId, scope);
  }

  /**
   * Project entries against one clock reading, so entries revalidated together
   * cannot land on opposite sides of the freshness window.
   */
  #project(
    entries: readonly MutableEntry[],
    pending?: ReadonlyMap<string, PendingRevalidationV1>,
  ): readonly LiveAttachedSourceV1[] {
    const nowMs = this.#now();
    return Object.freeze(
      entries.map((entry) => {
        const substituted = pending?.get(entry.entryId);
        return projectEntry(
          entry,
          nowMs,
          substituted?.revalidation ?? entry.revalidation,
          substituted?.revalidationCount ?? entry.revalidationCount,
        );
      }),
    );
  }

  #projectOne(entry: MutableEntry): LiveAttachedSourceV1 {
    return projectEntry(entry, this.#now(), entry.revalidation, entry.revalidationCount);
  }

  /** The two fields `liveAgentWorkflowRunRequest` reads, from the array {@link entries} reads. */
  public requestFields(): LiveAgentSourceRequestFieldsV1 {
    const sourcePaths = this.#entries
      .filter((entry) => entry.kind === "repository-file")
      .map((entry) => entry.repositoryPath as string);
    const change = this.#entries.find((entry) => entry.kind === "merged-change");
    return {
      ...(sourcePaths.length > 0 ? { sourcePaths: Object.freeze(sourcePaths) } : {}),
      ...(change?.selector ? { changeRequestSelector: change.selector } : {}),
      ...(this.#changeSource ? { changeSource: this.#changeSource } : {}),
    };
  }

  /**
   * The selection in the shape `assertSourceSelectionMatchesInstruction` reads,
   * which requires `sourcePaths` even when {@link requestFields} omits it.
   */
  public instructionCompatibilityFields(): {
    readonly sourcePaths: readonly string[];
    readonly changeRequestSelector?: ChangeRequestSelectorV1;
    readonly changeSource?: LiveAgentChangeReviewSelectorV1;
  } {
    const fields = this.requestFields();
    return {
      sourcePaths: fields.sourcePaths ?? [],
      ...(fields.changeRequestSelector
        ? { changeRequestSelector: fields.changeRequestSelector }
        : {}),
      ...(fields.changeSource ? { changeSource: fields.changeSource } : {}),
    };
  }

  /**
   * Refuse a bounded run whose last recorded verdict is not a current `fresh`.
   *
   * The run stops; the source stays attached rather than being silently
   * detached. Called before {@link holdForRun}. A never-revalidated source is
   * still bindable, since attachment is this process's own admission. A lapsed
   * `fresh` is `bind-expired`, not `bind-stale`.
   */
  public assertBindable(): void {
    for (const entry of this.entries()) {
      const verdict = entry.revalidation;
      if (verdict === null) continue;
      if (verdict.state !== "fresh") {
        failSourceCommand(SOURCE_BIND_REFUSAL_BY_STATE[verdict.state]);
      }
      if (!verdict.withinWindow) {
        failSourceCommand(
          "bind-expired",
          `The last check is older than ${REVALIDATION_WINDOW.value} ${REVALIDATION_WINDOW.unit} (${REVALIDATION_WINDOW.name}).`,
        );
      }
    }
  }

  /**
   * Mark every attached source as required evidence for one run's write steps,
   * and release them when it settles, so a detach is refused while a run holds
   * the evidence. Step ids come from the workflow catalog the runner executes.
   */
  public holdForRun(workflow: RunnableWorkflowName): () => void {
    const stepIds = getWorkflow(workflow)
      .steps.filter((step) => step.mode === "write")
      .map((step) => step.id);
    const held = [...this.#entries];
    for (const entry of held) {
      for (const stepId of stepIds) {
        entry.requiredBy.set(stepId, (entry.requiredBy.get(stepId) ?? 0) + 1);
      }
      entry.boundRunCount += 1;
    }
    // Counted so overlapping holds stay held, and idempotent so a repeated
    // release cannot decrement a hold it does not own.
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const entry of held) {
        for (const stepId of stepIds) {
          const remaining = (entry.requiredBy.get(stepId) ?? 0) - 1;
          if (remaining > 0) entry.requiredBy.set(stepId, remaining);
          else entry.requiredBy.delete(stepId);
        }
      }
    };
  }

  /** Run one operator-typed line from a host input surface, never from a model turn. */
  public async dispatch(line: string): Promise<SourceCommandOutcomeV1 | undefined> {
    const invocation = parseSourceCommand(line);
    if (!invocation) return undefined;
    switch (invocation.verb) {
      case "list": {
        const changeReview = this.#reviewSelection();
        return this.#screen({
          kind: "listing" as const,
          entries: this.entries(),
          ...(changeReview ? { changeReview } : {}),
        });
      }
      case "add":
        return await this.#add(invocation.argument as string);
      case "show":
        return await this.#show(invocation.argument as string);
      case "refresh":
        return await this.#refresh(invocation.argument);
      case "revalidate":
        return await this.#revalidate(invocation.argument);
      case "remove":
        return this.#remove(invocation.argument as string);
      case "search":
        return await this.#search(invocation.argument);
      case "purge":
        return await this.#purge(invocation.argument as string);
      case "review":
        return this.#selectChangeReview(invocation.argument as string);
    }
  }

  /** Select the immutable change basis for the next bounded documentation review. */
  #selectChangeReview(reference: string): SourceCommandOutcomeV1 {
    if (this.#changeSource || this.#entries.some((entry) => entry.kind === "merged-change")) {
      failSourceCommand("one-change-request");
    }
    let selector: LiveAgentChangeReviewSelectorV1;
    try {
      selector = parseLiveAgentChangeReviewReference(reference);
    } catch {
      failSourceCommand("invalid-review-reference");
    }
    const selection = liveAgentChangeReviewSelection(selector);
    if (this.#entries.some((entry) => entry.label === selection.label)) {
      failSourceCommand("duplicate-source");
    }
    const outcome = this.#screen({
      kind: "review-selected" as const,
      selection,
    });
    this.#changeSource = selector;
    return outcome;
  }

  #reviewSelection() {
    return this.#changeSource ? liveAgentChangeReviewSelection(this.#changeSource) : undefined;
  }

  /**
   * Attach one source. Every check and screen runs against a candidate not yet
   * in `#entries`, and the append is last, so a refused add changes nothing.
   */
  async #add(argument: string): Promise<SourceCommandOutcomeV1> {
    const candidate = looksLikeChangeRequest(argument)
      ? await this.#resolveChangeCandidate(argument)
      : this.#fileCandidate(argument);
    const outcome = this.#screen({
      kind: "attached" as const,
      entry: this.#projectOne(candidate.entry),
      entries: this.#project([...this.#entries, candidate.entry]),
    });
    this.#entries.push(candidate.entry);
    if (candidate.scope) this.#scopes.set(candidate.entry.entryId, candidate.scope);
    return outcome;
  }

  #fileCandidate(argument: string): { entry: MutableEntry; scope: null } {
    let repositoryPath: string;
    try {
      // The same admission `docsfab run --source` performs; it preserves every
      // byte it does not refuse.
      repositoryPath = contextPath(argument, SOURCE_COMMAND_PREFIX);
    } catch {
      failSourceCommand("invalid-reference");
    }
    assertAdmissibleReference(repositoryPath);
    const entry = this.#buildFile(repositoryPath);
    this.#assertUnusedLabel(entry);
    return { entry, scope: null };
  }

  async #resolveChangeCandidate(
    argument: string,
  ): Promise<{ entry: MutableEntry; scope: GitLabAcquisitionScopeV1 }> {
    // Pure: a parse error costs zero reads.
    const parsed = parseChangeRequestSelector(argument);
    if (this.#changeSource || this.#entries.some((entry) => entry.kind === "merged-change")) {
      failSourceCommand("one-change-request");
    }
    const reference =
      parsed.host !== null && parsed.projectPath !== null
        ? { host: parsed.host, projectPath: parsed.projectPath }
        : // The port raises `checkout-project-unavailable` after it looks.
          await (
            this.#ports.checkoutProject ??
            (() => failChangeRequestSelector("checkout-project-unavailable"))
          )();
    // Path to proved numeric id, once, before anything is attached.
    const scope = await resolveGitLabAcquisitionScope({
      reference,
      ...(this.#ports.identityPort ? { identityPort: this.#ports.identityPort } : {}),
    });
    const selector: ChangeRequestSelectorV1 = Object.freeze({
      schemaVersion: 1 as const,
      kind: "docsfab-change-request-selector" as const,
      provider: parsed.provider,
      host: scope.host,
      projectPath: scope.projectPath,
      number: parsed.number,
    });
    // Re-validated so the session never holds a selector the run request
    // would refuse.
    if (!isValidatedChangeRequestSelector(selector)) failSourceCommand("invalid-reference");
    const entry = this.#buildChange(selector, scope);
    this.#assertUnusedLabel(entry);
    // The composed label is host-derived, so the outcome screen in `#add`
    // covers it before anything is committed.
    return { entry, scope };
  }

  async #show(argument: string): Promise<SourceCommandOutcomeV1> {
    const changeReview = this.#reviewSelection();
    if (changeReview?.label === argument) {
      return this.#screen({ kind: "review-detail" as const, selection: changeReview });
    }
    const entry = this.#require(argument);
    if (entry.kind === "merged-change") {
      // As bound source evidence, a merge request body is read through
      // `docsfab_read_source` inside a bound run; it is not previewed here.
      return this.#screen({
        kind: "detail" as const,
        entry: this.#projectOne(entry),
        preview: null,
        previewTruncated: false,
      });
    }
    const open = this.#ports.withTrackedSourceReader;
    if (!open) failSourceCommand("inspection-unavailable");
    // A preview reads only the opening page, so it never sets `entry.version`.
    const bytes = await open((reader) =>
      this.#readTracked(reader, entry, SOURCE_PREVIEW_MAX_BYTES),
    );
    const decoded = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    const previewTruncated =
      bytes.length >= SOURCE_PREVIEW_MAX_BYTES || decoded.length > SOURCE_PREVIEW_MAX_CHARACTERS;
    return this.#screen({
      kind: "detail" as const,
      entry: this.#projectOne(entry),
      preview: decoded.slice(0, SOURCE_PREVIEW_MAX_CHARACTERS),
      previewTruncated,
    });
  }

  /**
   * Re-read the attached files and report what moved.
   *
   * Two-phase like `#add`: phase one reads and decides without touching an
   * entry, and phase two commits every decision after the outcome passes the
   * screens, so a refusal never leaves a partial refresh counted.
   */
  async #refresh(argument: string | null): Promise<SourceCommandOutcomeV1> {
    const targets = argument === null ? [...this.#entries] : [this.#require(argument)];
    const decided: Array<{ entry: MutableEntry; result: SourceRefreshOutcomeV1 }> = [];
    const files = targets.filter((entry) => entry.kind === "repository-file");
    const readVersions = new Map<string, string | null>();
    if (files.length > 0) {
      const open = this.#ports.withTrackedSourceReader;
      if (!open) failSourceCommand("inspection-unavailable");
      // One export for the whole command, not one per file.
      await open(async (reader) => {
        for (const entry of files) {
          try {
            readVersions.set(
              entry.entryId,
              versionOfBytes(await this.#readTracked(reader, entry, SOURCE_VERSION_MAX_BYTES)),
            );
          } catch (error) {
            if (!(error instanceof SourceCommandError)) throw error;
            readVersions.set(entry.entryId, null);
          }
        }
      });
    }
    for (const entry of targets) {
      const previousVersion = entry.version;
      if (entry.kind === "merged-change") {
        // An already-merged change is immutable, so no read is needed.
        decided.push({
          entry,
          result: {
            entryId: entry.entryId,
            label: entry.label,
            disposition: "immutable",
            previousVersion,
            version: entry.version,
          },
        });
        continue;
      }
      const version = readVersions.get(entry.entryId) ?? null;
      // Drift updates version and status in place; appending an entry would
      // make the next run bind the same file twice.
      const drifted = version !== null && previousVersion !== null && previousVersion !== version;
      decided.push({
        entry,
        result: {
          entryId: entry.entryId,
          label: entry.label,
          disposition: version === null ? "unavailable" : drifted ? "drifted" : "unchanged",
          previousVersion,
          version,
        },
      });
    }
    const outcome = this.#screen({
      kind: "refreshed" as const,
      results: Object.freeze(decided.map(({ result }) => result)),
    });
    for (const { entry, result } of decided) {
      entry.refreshCount += 1;
      if (result.disposition === "immutable") continue;
      if (result.disposition === "unavailable") {
        entry.status = "unavailable";
        if (!entry.limitations.includes("unreadable-at-selected-revision")) {
          entry.limitations.push("unreadable-at-selected-revision");
        }
        continue;
      }
      entry.version = result.version;
      entry.status = result.disposition === "drifted" ? "drifted" : "attached";
      entry.limitations = entry.limitations.filter(
        (limitation) =>
          limitation !== "version-unread" && limitation !== "unreadable-at-selected-revision",
      );
      if (result.disposition === "drifted") {
        entry.limitations.push("version-drifted-since-attachment");
      }
    }
    return outcome;
  }

  /**
   * Re-check every targeted source and report one coded state for each.
   *
   * Unlike `refresh`, which adopts the current version, a revalidation only
   * checks: a `stale` source stays stale until the operator refreshes or
   * detaches it, and {@link LiveAgentSourceSelection.assertBindable} refuses a
   * run against that verdict.
   *
   * - Nothing is dropped: no state detaches an entry or removes it from
   *   {@link LiveAgentSourceSelection.requestFields}, and the outcome carries the
   *   whole listing afterwards.
   * - Nothing is partial: too many targets, no wired reader, or an unanswerable
   *   identity refuses the whole command before anything is recorded.
   *
   * Two-phase like `#add` and `#refresh`.
   */
  async #revalidate(argument: string | null): Promise<SourceCommandOutcomeV1> {
    const targets = argument === null ? [...this.#entries] : [this.#require(argument)];
    if (targets.length > REVALIDATION_MAX_ENTRIES.value) {
      // Checked before any read or identity call, so nothing was read.
      failSourceCommand(
        "too-many-sources",
        `This conversation has ${targets.length} attached sources and one revalidation re-checks at most ${REVALIDATION_MAX_ENTRIES.value} (${REVALIDATION_MAX_ENTRIES.name}).`,
      );
    }
    const files = targets.filter((target) => target.kind === "repository-file");
    const open = this.#ports.withTrackedSourceReader;
    // Refused before the forge walk, so a command that will refuse makes no
    // credentialed network call. A missing reader is the host's omission, not
    // a reason to report files as `missing`.
    if (files.length > 0 && !open) failSourceCommand("inspection-unavailable");
    const decided: Array<{ entry: MutableEntry; result: SourceRevalidationOutcomeV1 }> = [];
    for (const entry of targets.filter((target) => target.kind === "merged-change")) {
      decided.push({ entry, result: await this.#revalidateChange(entry) });
    }
    if (files.length > 0 && open) {
      // One export for the whole command, not one per file.
      await open(async (reader) => {
        for (const entry of files) {
          decided.push({
            entry,
            result: fileRevalidationOutcome(entry, await observeTracked(reader, entry)),
          });
        }
      });
    }
    // Reported in listing order, not walk order.
    const ordered = targets.map(
      (entry) => decided.find((decision) => decision.entry === entry) as (typeof decided)[number],
    );
    const atMs = this.#now();
    // This command's verdicts and counts, substituted into the projection
    // without committing, so the report is current while a screen refusal
    // still leaves no trace.
    const pending = new Map<string, PendingRevalidationV1>(
      ordered.map(({ entry, result }) => [
        entry.entryId,
        {
          revalidation: { state: result.state, basis: result.basis, atMs },
          revalidationCount: entry.revalidationCount + 1,
        },
      ]),
    );
    const outcome = this.#screen({
      kind: "revalidated" as const,
      results: Object.freeze(ordered.map(({ result }) => result)),
      entries: this.#project(this.#entries, pending),
    });
    for (const { entry, result } of ordered) {
      entry.revalidationCount += 1;
      // Only the verdict and count move. `version`, `status`, and `limitations`
      // belong to `refresh`; writing them here would create two fields that can
      // disagree and a `missing` status that outlives a restored file.
      entry.revalidation = { state: result.state, basis: result.basis, atMs };
    }
    return outcome;
  }

  /**
   * Re-resolve one attached merged change's admitted identity.
   *
   * A merged change has no mutable bytes, so the only question is whether its
   * reference still names the same project, answered by the same
   * `resolveGitLabAcquisitionScope` the attachment used. `out-of-scope-locator`
   * is a change; any other failure is an unanswered question and stops the
   * whole command with `identity-unverifiable`.
   */
  async #revalidateChange(entry: MutableEntry): Promise<SourceRevalidationOutcomeV1> {
    const basis: SourceRevalidationBasisV1 =
      entry.admission.projectId === null
        ? "unresolved-project-identity"
        : "recorded-project-identity";
    const changed = (): SourceRevalidationOutcomeV1 => ({
      entryId: entry.entryId,
      label: entry.label,
      state: "identity-changed",
      basis,
      recordedVersion: entry.version,
      observedVersion: null,
    });
    // No identity port needs no guard: the resolver fails closed before any
    // I/O and the catch below maps it to `identity-unverifiable`. A change
    // attached as a bare number has no reference to re-resolve at all, which
    // gets its own detail.
    const host = entry.admission.host;
    const projectPath = entry.admission.projectPath;
    if (host === null || projectPath === null) {
      failSourceCommand("identity-unverifiable", NO_RECORDED_PROJECT_REFERENCE_DETAIL);
    }
    let scope: GitLabAcquisitionScopeV1;
    try {
      scope = await resolveGitLabAcquisitionScope({
        reference: { host, projectPath },
        identityPort: this.#ports.identityPort,
      });
    } catch (error) {
      // Only `out-of-scope-locator` is an identity change; any other failure is
      // an unanswered question and records no verdict.
      if (error instanceof SourceDiscoveryError && error.code === "out-of-scope-locator") {
        return changed();
      }
      failSourceCommand("identity-unverifiable");
    }
    // A different numeric id than the one proved at admission is also a change:
    // later locators are minted from the id.
    if (entry.admission.projectId !== null && scope.projectId !== entry.admission.projectId) {
      return changed();
    }
    return {
      entryId: entry.entryId,
      label: entry.label,
      state: "fresh",
      basis,
      recordedVersion: entry.version,
      observedVersion: null,
    };
  }

  #remove(argument: string): SourceCommandOutcomeV1 {
    const changeReview = this.#reviewSelection();
    if (changeReview?.label === argument) {
      const outcome = this.#screen({
        kind: "review-detached" as const,
        selection: changeReview,
        entries: Object.freeze(this.#project(this.#entries)),
      });
      this.#changeSource = undefined;
      return outcome;
    }
    const entry = this.#require(argument);
    if (entry.requiredBy.size > 0) {
      failSourceCommand(
        "required-source",
        `Requiring steps: ${[...entry.requiredBy.keys()].sort().join(", ")}.`,
      );
    }
    const index = this.#entries.indexOf(entry);
    // Screened against the list this detach would produce; the splice is last,
    // so a refused detach leaves the evidence attached.
    const outcome = this.#screen({
      kind: "detached" as const,
      entry: this.#projectOne(entry),
      entries: Object.freeze(
        this.#project(this.#entries.filter((_, position) => position !== index)),
      ),
    });
    // By position; duplicate-label refusal keeps the position unambiguous.
    this.#entries.splice(index, 1);
    this.#scopes.delete(entry.entryId);
    return outcome;
  }

  async #search(argument: string | null): Promise<SourceCommandOutcomeV1> {
    let ceiling = SOURCE_COMMAND_SEARCH_CEILING;
    if (argument !== null) {
      // The argument is only a descriptor count. Project, path, branch, and
      // date window are host-held, so a search cannot widen what the host allowed.
      if (!/^\d+$/u.test(argument)) failSourceCommand("malformed-command");
      ceiling = Number(argument);
      if (
        !Number.isSafeInteger(ceiling) ||
        ceiling <= 0 ||
        ceiling > SOURCE_SEARCH_MAX_DESCRIPTORS
      ) {
        failSourceCommand("malformed-command");
      }
    }
    const searcher = this.#ports.searcher;
    if (!searcher) failSourceCommand("search-unavailable");
    const result = await searcher.search({ maxDescriptors: ceiling });
    return this.#screen({
      kind: "search" as const,
      descriptorCount: result.descriptors.length,
      windowCovered: result.coverage.windowCovered,
      result,
    });
  }

  /**
   * Delete the owned local copies DocsFab holds for one or more sessions.
   *
   * Phase one reads the custody inventory, deletes nothing, and prints the
   * preview with a confirmation minted over the exact deletion set. Phase two
   * runs only when that confirmation is passed back and still matches a token
   * re-minted from the current inventory, so a changed inventory is never
   * deleted unseen.
   *
   * - Every deletion is recorded: a partial removal is recorded with
   *   `incomplete: true` before the command refuses.
   * - The preview row cap withholds printed rows only, never deletion-set
   *   members, and the withheld count is reported.
   * - Unknown, ambiguous, foreign, writer-held, or too many sessions stop the
   *   whole command before a byte is deleted.
   * - Nothing is detached. When the purged session is this conversation's own,
   *   entries lose their process-local derivatives and gain an
   *   `owned-local-copy-purged` limitation.
   */
  async #purge(argument: string): Promise<SourceCommandOutcomeV1> {
    const custody = this.#ports.custody;
    if (!custody) failSourceCommand("custody-unavailable");
    const entryPoint = this.#ports.entryPoint;
    if (entryPoint === undefined) failSourceCommand("entry-point-unrecorded");
    // Verb-local grammar: `<ref>[,<ref>...] [confirmation]`. The split is
    // unambiguous because a session reference contains no comma or space.
    const boundary = argument.indexOf(" ");
    const named = boundary === -1 ? argument : argument.slice(0, boundary);
    const confirmation = boundary === -1 ? null : argument.slice(boundary + 1).trim();
    if (confirmation !== null && confirmation.length === 0) failSourceCommand("malformed-command");
    const references = named.split(",");
    if (references.length > PURGE_MAX_SESSIONS.value) {
      // Checked before the first store read, so nothing was read.
      failSourceCommand(
        "too-many-sessions",
        `This purge names ${references.length} sessions and one invocation deletes at most ${PURGE_MAX_SESSIONS.value} (${PURGE_MAX_SESSIONS.name}).`,
      );
    }
    if (!references.every((reference) => isSessionReference(reference))) {
      failSourceCommand("invalid-session-reference");
    }
    const inventories: SessionSourceInventoryV1[] = [];
    for (const reference of references) {
      const resolved = await custody.inventory(reference);
      if (resolved.kind === "unknown") failSourceCommand("unknown-session-reference");
      if (resolved.kind === "ambiguous") {
        failSourceCommand(
          "ambiguous-session-reference",
          `That reference matches ${resolved.matches} sessions.`,
        );
      }
      const inventory = resolved.inventory;
      if (
        inventory.principal.principalId !== custody.principal.principalId ||
        inventory.principal.repositoryId !== custody.principal.repositoryId
      ) {
        failSourceCommand(
          "session-principal-mismatch",
          inventory.principal.principalId !== custody.principal.principalId
            ? "The recorded principal is not the one this command is running as."
            : "The recorded repository is not the one this command is running against.",
        );
      }
      // Checked for every named session before any deletion.
      if (inventory.activeWriter) failSourceCommand("session-active-writer");
      inventories.push(inventory);
    }
    const previews = inventories.map((inventory) => purgePreview(inventory));
    const rowsNotPrinted = previews.reduce((total, preview) => total + preview.rowsNotPrinted, 0);
    const deletable = previews.some((preview) => preview.copies.length > 0);
    const minted = deletable ? sourcePurgeConfirmation(previews) : null;
    if (confirmation === null || !deletable) {
      // Phase one, or the no-op: a confirmation for an empty session is not
      // refused, so a second purge is idempotent.
      return this.#screen({
        kind: "purge-preview" as const,
        sessions: Object.freeze(previews),
        confirmation: minted,
        rowsNotPrinted,
        retentionNote: SOURCE_PURGE_RETENTION_NOTE,
      });
    }
    if (confirmation !== minted) failSourceCommand("purge-not-confirmed");
    // Screened before anything is deleted. The purged outcome adds no value
    // the preview lacks, so it cannot fail a screen after the bytes are gone.
    this.#screen({
      kind: "purge-preview" as const,
      sessions: Object.freeze(previews),
      confirmation: minted,
      rowsNotPrinted,
      retentionNote: SOURCE_PURGE_RETENTION_NOTE,
    });
    const at = new Date(this.#now()).toISOString();
    const records: SourcePurgeCustodyRecordV1[] = [];
    const purged: SourcePurgeSessionPreviewV1[] = [];
    for (const preview of previews) {
      let removed: readonly SessionSourceCopyV1[];
      let failure: SessionSourceRemovalError | undefined;
      try {
        removed = await custody.remove({
          sessionId: preview.sessionId,
          copyIds: preview.copies.map((copy) => copy.copyId),
        });
      } catch (error) {
        // A partial removal still deleted something: record it, then refuse.
        if (!(error instanceof SessionSourceRemovalError)) throw error;
        failure = error;
        removed = error.removed;
      }
      const record = custodyRecord({
        preview,
        removed,
        notRemoved: failure?.remaining ?? [],
        at,
        entryPoint,
        principal: custody.principal,
        confirmation: minted,
        incomplete: failure !== undefined,
      });
      await custody.record(record);
      records.push(record);
      purged.push({ ...preview, copies: Object.freeze([...removed]) });
      this.#invalidatePurgedSession(preview.sessionId);
      if (failure) {
        failSourceCommand(
          "purge-incomplete",
          `${record.removed.length} of ${preview.copies.length} owned copies were deleted${failure.cancelled ? " before the purge was cancelled" : ""}; custody record ${record.recordId} names both halves.`,
        );
      }
    }
    return this.#screen({
      kind: "purged" as const,
      sessions: Object.freeze(purged),
      custody: Object.freeze(records),
      removedCopies: records.reduce((total, record) => total + record.removed.length, 0),
      removedBytes: purged.reduce(
        (total, preview) => total + preview.copies.reduce((sum, copy) => sum + copy.bytes, 0),
        0,
      ),
      rowsNotPrinted,
      retentionNote: SOURCE_PURGE_RETENTION_NOTE,
      // A purge deletes bodies and detaches nothing.
      entries: this.#project(this.#entries),
    });
  }

  /**
   * Invalidate this conversation's process-local derivatives for a purged session.
   *
   * Runs only when the purged session is this conversation's own. Drops the
   * refreshed version, the revalidation verdict, and the proved scope; keeps
   * the attachment and admission record, and adds a limitation so a later read
   * reports the owned copy as gone.
   */
  #invalidatePurgedSession(sessionId: string): void {
    if (this.#ports.sessionId !== sessionId) return;
    for (const entry of this.#entries) {
      entry.version = null;
      entry.revalidation = null;
      this.#scopes.delete(entry.entryId);
      if (!entry.limitations.includes("owned-local-copy-purged")) {
        entry.limitations.push("owned-local-copy-purged");
      }
    }
  }

  async #readTracked(
    reader: TrackedSourceReaderV1,
    entry: MutableEntry,
    maxBytes: number,
  ): Promise<Uint8Array> {
    const repositoryPath = entry.repositoryPath as string;
    try {
      if (!(await reader.isTrackedRegularFile(repositoryPath))) {
        failSourceCommand("source-unreadable");
      }
      return await reader.readTrackedBytes(repositoryPath, maxBytes);
    } catch (error) {
      // The reader's own message is never relayed; it can carry a host path.
      if (error instanceof SourceCommandError) throw error;
      if (error instanceof TrackedSourceOversizeError) failSourceCommand("source-unreadable");
      failSourceCommand("source-unreadable");
    }
  }

  /** Match one attached entry by its printed label, byte for byte. */
  #require(reference: string): MutableEntry {
    const matched = this.#entries.filter((entry) => entry.label === reference);
    if (matched.length !== 1) failSourceCommand("unknown-source");
    return matched[0] as MutableEntry;
  }

  /**
   * Refuse a candidate whose printed label or repository path is already
   * attached. The label is what `show`, `remove`, and `refresh` match on, and a
   * merged change has no repository path to compare.
   */
  #assertUnusedLabel(candidate: MutableEntry): void {
    const reviewLabel = this.#reviewSelection()?.label;
    const taken =
      this.#entries.some(
        (entry) =>
          entry.label === candidate.label ||
          (candidate.repositoryPath !== null && entry.repositoryPath === candidate.repositoryPath),
      ) || reviewLabel === candidate.label;
    if (taken) failSourceCommand("duplicate-source");
  }

  /** Build one file entry. Pure: the caller commits it after the screen. */
  #buildFile(repositoryPath: string): MutableEntry {
    const format = classifySourceMediaType(repositoryPath);
    const locator = trackedSourceCanonicalLocator(repositoryPath);
    const entry: MutableEntry = {
      entryId: entryIdOfLocator(locator),
      kind: "repository-file",
      label: repositoryPath,
      locator,
      repositoryPath,
      projectId: null,
      projectPath: null,
      changeNumber: null,
      selector: null,
      format: format ?? "unclassified",
      status: "attached",
      version: null,
      limitations: [
        "version-unread",
        ...(format === undefined ? ["format-not-recognized-by-an-installed-extractor"] : []),
      ],
      refreshCount: 0,
      revalidationCount: 0,
      boundRunCount: 0,
      requiredBy: new Map<string, number>(),
      admission: Object.freeze({
        kind: "repository-file" as const,
        label: repositoryPath,
        locator,
        repositoryPath,
        host: null,
        projectPath: null,
        projectId: null,
        changeNumber: null,
        format: format ?? "unclassified",
      }),
      revalidation: null,
    };
    return entry;
  }

  /** Build one merged-change entry. Pure: the caller commits it after the screen. */
  #buildChange(
    selector: ChangeRequestSelectorV1,
    scope: GitLabAcquisitionScopeV1 | null,
  ): MutableEntry {
    const label =
      selector.host && selector.projectPath
        ? `${selector.host}/${selector.projectPath}!${selector.number}`
        : `!${selector.number}`;
    const locator = scope
      ? canonicalGitlabMrReviewLocator({
          host: scope.host,
          projectId: scope.projectId,
          mergeRequestIid: selector.number,
        })
      : `change-request:${label}`;
    const entry: MutableEntry = {
      entryId: entryIdOfLocator(locator),
      kind: "merged-change",
      label,
      locator,
      repositoryPath: null,
      projectId: scope?.projectId ?? null,
      projectPath: scope?.projectPath ?? selector.projectPath,
      changeNumber: selector.number,
      selector,
      format: "merge-request",
      status: "attached",
      version: null,
      limitations: scope
        ? []
        : ["project-identity-unresolved-until-the-run-resolves-it-at-acquisition"],
      refreshCount: 0,
      revalidationCount: 0,
      boundRunCount: 0,
      requiredBy: new Map<string, number>(),
      // `projectId` is null when admitted without a proved scope (a session-start
      // `--pr`); the baseline records what was admitted, not a later resolution.
      admission: Object.freeze({
        kind: "merged-change" as const,
        label,
        locator,
        repositoryPath: null,
        host: scope?.host ?? selector.host,
        projectPath: scope?.projectPath ?? selector.projectPath,
        projectId: scope?.projectId ?? null,
        changeNumber: selector.number,
        format: "merge-request",
      }),
      revalidation: null,
    };
    return entry;
  }
}

/** Build the live conversation's attached source selection. */
export function createLiveAgentSourceSelection(
  input: LiveAgentSourceSelectionInputV1 = {},
): LiveAgentSourceSelection {
  return new LiveAgentSourceSelection(input);
}

/** Render a screened `/sources` outcome for the terminal. */
export function renderSourceCommandOutcome(
  outcome: SourceCommandOutcomeV1,
  capabilities: PresentationCapabilities = resolveProcessPresentationCapabilities(),
): string {
  const rendered = renderPresentation(
    projectSourceCommandOutcome(outcome, SOURCE_REVALIDATION_STATE_MESSAGES),
    capabilities,
  );
  return rendered.stdout + rendered.stderr;
}
