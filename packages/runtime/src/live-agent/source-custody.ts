// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Session source custody: the contracts a `/sources purge` answers to.
 *
 * - Removal, cache invalidation, and purge are distinct operations
 *   ({@link SOURCE_STATE_OPERATIONS}). Only purge deletes, is confirmed, and
 *   writes a custody record; a detach writes none.
 * - A custody record is an admission, not a claim of erasure. It says what was
 *   removed, when, why, by which entry point, and under which principal;
 *   {@link SOURCE_PURGE_RETENTION_NOTE} states what stays, identically in the
 *   preview and the record.
 * - The custody store is a host seam. DocsFab keeps no durable source cache,
 *   though the Pi transcript in the owner-private session directory can hold
 *   source text. A host that wires no store gets `custody-unavailable` and
 *   DocsFab claims no deletion.
 */
import { canonicalDigest } from "../content-ir/canonical.js";
import { limit, type ResolvedLimit } from "../config/limits.js";
import { SAFE_RECORD_ID } from "../records/file-store.js";

/**
 * Characters of a canonical digest one short DocsFab identifier carries. An
 * identifier format, not an operational bound; shared so the identifiers built
 * this way cannot disagree.
 */
const SHORT_IDENTIFIER_CHARACTERS = 16;

/** One short, stable, content-free identifier from a canonical digest. */
export function shortIdentifier(prefix: string, digest: string): string {
  return `${prefix}-${digest.slice(0, SHORT_IDENTIFIER_CHARACTERS)}`;
}

export const SOURCE_PURGE_MAX_SESSIONS_LIMIT = "sources.purgeMaxSessionsPerInvocation" as const;

export const SOURCE_PURGE_PREVIEW_MAX_ROWS_LIMIT = "sources.purgePreviewMaxRows" as const;

/**
 * Both purge bounds, resolved once at module load so a host override fails at
 * start-up and one session never sees two values.
 */
export const PURGE_MAX_SESSIONS: ResolvedLimit = limit(SOURCE_PURGE_MAX_SESSIONS_LIMIT);
export const PURGE_PREVIEW_MAX_ROWS: ResolvedLimit = limit(SOURCE_PURGE_PREVIEW_MAX_ROWS_LIMIT);

/**
 * The three source-state operations kept apart in code and copy. The purge
 * preview prints all three sentences side by side.
 */
export const SOURCE_STATE_OPERATIONS = ["removal", "cache-invalidation", "purge"] as const;

export type SourceStateOperationV1 = (typeof SOURCE_STATE_OPERATIONS)[number];

/**
 * What each operation does and does not do. Content-free, because a preview
 * reaches a captured terminal and a kept record.
 */
export const SOURCE_STATE_OPERATION_MESSAGES: Readonly<Record<SourceStateOperationV1, string>> =
  Object.freeze({
    removal:
      "Removal detaches an attachment from this conversation. It deletes no bytes anywhere, it writes no custody record, and the source stays exactly where it is; only this conversation stops binding it.",
    "cache-invalidation":
      "Cache invalidation drops the derivatives this process holds — the version a refresh recorded, the revalidation verdict, and the proved acquisition scope. It deletes no bytes and writes no custody record; the next command rebuilds what it needs from current access.",
    purge:
      "Purge deletes the owned local copies DocsFab holds for a session and appends a custody record saying so. It is the only one of the three that deletes anything, the only one that is confirmed, and the only one that is recorded.",
  });

/**
 * Kinds of owned local copy a purge may delete. A kind not on this list is not
 * deletable by purge.
 */
export const SESSION_SOURCE_COPY_KINDS = [
  "session-source-inventory",
  "session-source-projection",
  "parser-temporary",
  "session-transcript",
] as const;

export type SessionSourceCopyKindV1 = (typeof SESSION_SOURCE_COPY_KINDS)[number];

/** Operator-facing name for each copy kind. Content-free. */
export const SESSION_SOURCE_COPY_KIND_MESSAGES: Readonly<Record<SessionSourceCopyKindV1, string>> =
  Object.freeze({
    "session-source-inventory":
      "the inert record of which sources this session admitted, carrying identities and digests rather than bodies",
    "session-source-projection":
      "a derived projection of that inventory, rebuildable from current access",
    "parser-temporary": "a disposable parser input or output file this session owned",
    "session-transcript": "the copy of this session's transcript DocsFab owns",
  });

/**
 * Why a purge happened, coded rather than free text, so no operator text
 * reaches the durable record or the terminal.
 */
export const SOURCE_PURGE_REASONS = ["operator-requested"] as const;

export type SourcePurgeReasonV1 = (typeof SOURCE_PURGE_REASONS)[number];

/**
 * Which surface performed a purge. Recorded, never rendered, so the live
 * terminal and `docsfab sources` print identical bytes for one command.
 */
export const SOURCE_PURGE_ENTRY_POINTS = ["live-terminal", "cli"] as const;

export type SourcePurgeEntryPointV1 = (typeof SOURCE_PURGE_ENTRY_POINTS)[number];

export interface SessionSourcePrincipalV1 {
  readonly principalId: string;
  readonly repositoryId: string;
}

export interface SessionSourceCopyV1 {
  readonly copyId: string;
  readonly kind: SessionSourceCopyKindV1;
  readonly bytes: number;
  /** Run ids that referenced this copy, so the preview shows affected runs. */
  readonly runIds: readonly string[];
  /**
   * True for a parser temporary the store proved orphaned (no writer, no live
   * process). The store's assertion, never inferred here from inactivity.
   */
  readonly orphaned: boolean;
}

/** What one session holds, read without deleting any of it. */
export interface SessionSourceInventoryV1 {
  readonly sessionId: string;
  readonly principal: SessionSourcePrincipalV1;
  /** True while a writer holds this session; a purge refuses rather than racing it. */
  readonly activeWriter: boolean;
  readonly copies: readonly SessionSourceCopyV1[];
  /** Coded scopes that stay behind, stated in the preview. */
  readonly retainedScopes: readonly string[];
  /**
   * ISO instant an earlier purge removed this session's copies, or null. Lets a
   * second purge report a stated no-op instead of an apparently empty session.
   */
  readonly previouslyPurgedAt: string | null;
}

/**
 * What a store answers about one session reference. Unknown and ambiguous
 * references are separate shapes because they need different operator actions.
 */
export type SessionSourceInventoryResultV1 =
  | { readonly kind: "resolved"; readonly inventory: SessionSourceInventoryV1 }
  | { readonly kind: "unknown" }
  | { readonly kind: "ambiguous"; readonly matches: number };

export interface SessionSourceRemovalRequestV1 {
  readonly sessionId: string;
  readonly copyIds: readonly string[];
}

/**
 * A removal that did not complete, carrying exactly what it did remove.
 *
 * Thrown so a store cannot report a partial deletion as whole, and carrying
 * `removed` so a cancelled or failed purge still records what it deleted.
 */
export class SessionSourceRemovalError extends Error {
  public constructor(
    public readonly removed: readonly SessionSourceCopyV1[],
    public readonly remaining: readonly SessionSourceCopyV1[],
    /** True when the removal stopped because it was cancelled rather than because it failed. */
    public readonly cancelled: boolean = false,
  ) {
    super("Session source removal did not complete.");
    this.name = "SessionSourceRemovalError";
  }
}

/**
 * The durable admission record one purge appends.
 *
 * Content-free: store-minted identities, coded kinds and scopes, byte counts,
 * and an instant. The only operator-typed value is a session reference already
 * validated against {@link SAFE_RECORD_ID}.
 */
export interface SourcePurgeCustodyRecordV1 {
  readonly schemaVersion: 1;
  readonly kind: "docsfab-session-source-purge-custody-record";
  /** Derived from what the record admits. */
  readonly recordId: string;
  readonly sessionId: string;
  /** ISO instant the deletion was performed. */
  readonly at: string;
  readonly operation: SourceStateOperationV1;
  readonly reason: SourcePurgeReasonV1;
  readonly entryPoint: SourcePurgeEntryPointV1;
  readonly principal: SessionSourcePrincipalV1;
  readonly removed: readonly {
    readonly copyId: string;
    readonly kind: SessionSourceCopyKindV1;
    readonly bytes: number;
  }[];
  /**
   * Copies a partial removal left behind. Empty on a complete purge and never
   * omitted, so a partial deletion cannot read as complete.
   */
  readonly notRemoved: readonly {
    readonly copyId: string;
    readonly kind: SessionSourceCopyKindV1;
  }[];
  readonly affectedRunIds: readonly string[];
  readonly retainedScopes: readonly string[];
  readonly incomplete: boolean;
  /** The confirmation this purge was authorized by. */
  readonly confirmation: string;
  /** The retention statement the operator confirmed, carried verbatim. */
  readonly retentionNote: string;
}

/**
 * The fixed statement a preview prints and a record carries, in one place so
 * neither can claim more than the other, including any external-provider erasure.
 */
export const SOURCE_PURGE_RETENTION_NOTE =
  "This deletes only the local copies DocsFab owns for the named session. Your own files are untouched, and run evidence retained independently under its own scope stays where it is. DocsFab claims no erasure by any external model provider. Where a deleted body was a run's evidence, that run's evidence becomes explicitly unavailable: the reference is kept and is never silently rewritten to point at something else.";

export interface SourcePurgeSessionPreviewV1 {
  readonly sessionId: string;
  /** Every copy that would be deleted, not the capped printed subset. */
  readonly copies: readonly SessionSourceCopyV1[];
  /** Copy rows beyond the preview row cap. Zero on an uncapped preview. */
  readonly rowsNotPrinted: number;
  readonly affectedRunIds: readonly string[];
  readonly retainedScopes: readonly string[];
  readonly previouslyPurgedAt: string | null;
  readonly bytes: number;
}

/**
 * The confirmation token a preview mints and a destructive purge must carry.
 *
 * A token works on both the live terminal and the non-interactive
 * `docsfab sources`, and it binds authorization to the exact copies previewed,
 * so a later, different inventory is never confirmed unseen. It covers the
 * whole deletion set, not only the rows a capped preview printed.
 */
export function sourcePurgeConfirmation(previews: readonly SourcePurgeSessionPreviewV1[]): string {
  return shortIdentifier(
    "purge",
    canonicalDigest({
      schemaVersion: 1 as const,
      kind: "docsfab-session-source-purge-confirmation" as const,
      sessions: previews.map((preview) => ({
        sessionId: preview.sessionId,
        copies: preview.copies.map((copy) => ({
          copyId: copy.copyId,
          kind: copy.kind,
          bytes: copy.bytes,
          orphaned: copy.orphaned,
          runIds: [...copy.runIds],
        })),
        affectedRunIds: [...preview.affectedRunIds],
        retainedScopes: [...preview.retainedScopes],
      })),
    }),
  );
}

export function sourcePurgeCustodyRecordId(input: {
  readonly sessionId: string;
  readonly at: string;
  readonly confirmation: string;
}): string {
  return shortIdentifier(
    "custody",
    canonicalDigest({
      schemaVersion: 1 as const,
      kind: "docsfab-session-source-purge-custody-record-id" as const,
      sessionId: input.sessionId,
      at: input.at,
      confirmation: input.confirmation,
    }),
  );
}

/**
 * The seam a host wires to provide a session source custody store.
 */
export interface SessionSourceCustodyPortV1 {
  /** Who this process is acting as, for the mismatch check. */
  readonly principal: SessionSourcePrincipalV1;
  /** Read one session's owned copies. Deletes nothing. */
  inventory(reference: string): Promise<SessionSourceInventoryResultV1>;
  /**
   * Delete exactly the named copies, returning what was removed. Raises
   * {@link SessionSourceRemovalError} with the removed copies when it cannot finish.
   */
  remove(request: SessionSourceRemovalRequestV1): Promise<readonly SessionSourceCopyV1[]>;
  /** Append one custody record. Never rewrites an earlier one. */
  record(record: SourcePurgeCustodyRecordV1): Promise<void>;
}

/**
 * Whether this text is a session reference this command will look up.
 *
 * Reuses the record store's id rule so the two cannot disagree. The rule
 * excludes commas, which makes splitting a multi-session argument unambiguous.
 */
export function isSessionReference(value: string): boolean {
  return SAFE_RECORD_ID.test(value);
}
