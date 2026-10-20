// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Process-local source-evidence service: the only thing that can open a source.
 * It is issued through the host-authority factory, so a lookalike object or a
 * serialized binding produces nothing.
 *
 * Authority narrows: host authority -> service -> run capability (bindRun) ->
 * step reader (forStep). A step reader accepts only a selection inside the
 * sealed binding and has no field for a path, URL, run id, step id, or policy.
 */

import { createHostAuthorityFactory } from "../contract-kit/index.js";
import {
  createSourceSpanAccess,
  decodeSourceBinding,
  decodeSourceObservation,
  digestSourceProducerScopes,
  SOURCE_EXACT_ORIGINAL_FORM,
  type SourceBindingV1,
  type SourceObservationV1,
  type SourceRepositoryBindingV1,
  type SourceRepresentationV1,
  type SourceSpanAccessV1,
  type SourceSpanCitationV1,
  type SourceSpanV1,
} from "./source-evidence.js";
import {
  decodeSourceArtifactReference,
  screenSourceSpanCitation,
  sourceReadBudgetObservation,
  type SourceArtifactReferenceV2,
  type SourceSpanCitationRequestV1,
} from "./source-evidence-artifacts.js";
import { sourceSpanTextReader } from "./source-extraction.js";
import type { SourceReadBudgetBasisV1 } from "./source-step-policy.js";
import { sha256 } from "../content-ir/canonical.js";
import type { ToolRefusalDetailKind } from "../records/contracts.js";
import {
  CredentialBoundaryError,
  assertConfinedToolResultCredentialFree,
} from "../security/credential-isolation.js";
import { containsConfiguredCredentialInBytes } from "../security/configured-credentials.js";

/**
 * Opens the host marker a read by span id puts between two pieces of one line
 * when the pieces between them were not selected.
 */
export const SOURCE_READ_GAP_MARKER_PREFIX = "[docsfab-source-gap:" as const;

export const SOURCE_EVIDENCE_SERVICE_ERROR_CODES = [
  "source-capability-unavailable",
  "authority-required",
  "digest-mismatch",
  "repository-mismatch",
  "run-mismatch",
  "request-mismatch",
  "policy-mismatch",
  "producer-scope-mismatch",
  "observation-unavailable",
  "read-grant-missing",
  "stale-capability",
  "step-mismatch",
  "span-unavailable",
  "budget-exhausted",
  "credential-withheld",
  "cancelled",
] as const;
export type SourceEvidenceServiceErrorCode = (typeof SOURCE_EVIDENCE_SERVICE_ERROR_CODES)[number];

const LIST_AGAIN = "Call docsfab_list_sources again and pass a source handle it returns.";
const REPORT_RUN = "Nothing in the call can fix this; stop reading sources and report the run id.";

/**
 * What every code tells a model when its site has nothing more specific, and
 * the kind of that remediation. A code can never refuse with nothing to act on.
 */
export const SOURCE_EVIDENCE_SERVICE_REMEDIATIONS: Readonly<
  Record<SourceEvidenceServiceErrorCode, { kind: ToolRefusalDetailKind; text: string }>
> = Object.freeze({
  "source-capability-unavailable": {
    kind: "grant",
    text: `This step holds no source capability. ${REPORT_RUN}`,
  },
  "authority-required": {
    kind: "grant",
    text: `This step's source grant is not a host-issued one. ${REPORT_RUN}`,
  },
  "digest-mismatch": {
    kind: "binding",
    text: `The sealed source binding no longer matches its digest. ${REPORT_RUN}`,
  },
  "repository-mismatch": {
    kind: "binding",
    text: `The sealed source binding names another repository or revision. ${REPORT_RUN}`,
  },
  "run-mismatch": {
    kind: "binding",
    text: `The sealed source binding belongs to another run. ${REPORT_RUN}`,
  },
  "request-mismatch": {
    kind: "binding",
    text: `The sealed source binding belongs to another request. ${REPORT_RUN}`,
  },
  "policy-mismatch": {
    kind: "binding",
    text: `The host source policy changed after the binding was sealed. ${REPORT_RUN}`,
  },
  "producer-scope-mismatch": {
    kind: "binding",
    text: `A source producer's scope changed after the binding was sealed. ${REPORT_RUN}`,
  },
  "observation-unavailable": {
    kind: "unknown-source",
    text: `That source is not one this step may read. ${LIST_AGAIN}`,
  },
  "read-grant-missing": {
    kind: "grant",
    text: "This step's grant does not admit source reads. Work from the evidence already in the prompt.",
  },
  "stale-capability": {
    kind: "grant",
    text: `A later step superseded this step's source grant. ${REPORT_RUN}`,
  },
  "step-mismatch": {
    kind: "grant",
    text: `The source grant belongs to another step. ${REPORT_RUN}`,
  },
  "span-unavailable": {
    kind: "argument-shape",
    text: `${LIST_AGAIN} Read it from fromByte 0, or by span ids it lists for that source.`,
  },
  "budget-exhausted": {
    kind: "read-budget",
    text: "This step's source-read budget cannot hold the read. Read a smaller window with maxBytes, or continue in a later step.",
  },
  "credential-withheld": {
    kind: "credential",
    text: "The credential screen withheld this text. Read another span or window.",
  },
  cancelled: {
    kind: "grant",
    text: "The step was cancelled. Stop reading sources.",
  },
});

export class SourceEvidenceServiceError extends Error {
  /**
   * The bound, observed bytes, and remediation behind the code, in host
   * vocabulary only: numbers, step ids, handles, and limit names, never a path,
   * a model-sent value, or a source byte.
   */
  public readonly detail?: string;
  /** What `detail` asks the model to change; recorded where `detail` is not. */
  public readonly detailKind: ToolRefusalDetailKind;

  public constructor(
    public readonly code: SourceEvidenceServiceErrorCode,
    detail?: string,
    detailKind?: ToolRefusalDetailKind,
  ) {
    super(`Source evidence service refused: ${code}.`);
    this.name = "SourceEvidenceServiceError";
    if (detail !== undefined) this.detail = detail;
    this.detailKind = detailKind ?? SOURCE_EVIDENCE_SERVICE_REMEDIATIONS[code].kind;
  }

  /** The detail, or the code's own remediation when the site gave none. */
  public get remediation(): string {
    return this.detail ?? SOURCE_EVIDENCE_SERVICE_REMEDIATIONS[this.code].text;
  }
}

function fail(
  code: SourceEvidenceServiceErrorCode,
  detail?: string,
  detailKind?: ToolRefusalDetailKind,
): never {
  throw new SourceEvidenceServiceError(code, detail, detailKind);
}

/**
 * `detail` is host vocabulary only: numbers, offsets, handles, and limit
 * names, never a path, a model-sent value, or a source byte.
 */
export function failSourceEvidenceService(
  code: SourceEvidenceServiceErrorCode,
  detail?: string,
  detailKind?: ToolRefusalDetailKind,
): never {
  fail(code, detail, detailKind);
}

/** Opaque and non-serializable; private object identity is the grant. */
export interface SourceEvidenceHostAuthority {
  readonly kind: "docsfab-source-evidence-host-authority";
}

export interface SourceEvidenceHostVerifier {
  /** Present so the kit can distinguish a real verifier from a lookalike. */
  verifyCurrent(): void;
  hostPolicySha256: string;
  producerScopes: ReadonlyArray<{ producerId: string; scopeSha256: string }>;
  resolveBinding(digest: string): unknown;
  resolveObservation(observationId: string): unknown;
  resolveDerivative(input: {
    observationId: string;
    representationId: string;
  }): Uint8Array | undefined;
  /** Only a live host custody implementation may resolve this sealed raw view. */
  resolveOriginal?(input: {
    observationId: string;
    representationId: string;
  }): Uint8Array | undefined;
  describeOriginal?(input: { observationId: string; representationId: string }): {
    side: "before" | "after";
    repositoryId: string;
    blobId: string;
    originalSha256: string;
  };
  /** Returns the external-input access-observation digest for this read. */
  recordAccess(input: {
    observationId: string;
    representationId: string;
    stepId: string;
    spanIds: readonly string[];
  }): string;
  /**
   * Joins a verified citation into the host's external-input citation ledger
   * and returns its digest. When absent, no per-step citer is issued. It must
   * fail closed: a throw here refuses the citation.
   */
  recordCitation?(input: {
    observationId: string;
    representationId: string;
    stepId: string;
    spanIds: readonly string[];
    accessObservationSha256s: readonly string[];
    supportedClaimSha256: string;
  }): string;
  now(): Date;
}

const authorityFactory = createHostAuthorityFactory<
  "docsfab-source-evidence-host-authority",
  SourceEvidenceHostVerifier
>({
  kind: "docsfab-source-evidence-host-authority",
  invalidMessage: "A source-evidence host authority requires a host verifier.",
});

export function createSourceEvidenceHostAuthority(
  verifier: SourceEvidenceHostVerifier,
): SourceEvidenceHostAuthority {
  return authorityFactory.create(verifier) as SourceEvidenceHostAuthority;
}

export interface SourceRunAdmissionContextV1 {
  runId: string;
  requestSha256: string;
  repository: SourceRepositoryBindingV1;
  workspaceIdentitySha256: string;
  repositoryContentDigest: string;
}

export interface SourceStepGrantV1 {
  stepId: string;
  workflow: string;
  /** Only a locked skill/workflow grant admits a reader. */
  readSource: boolean;
  /** Only a locked skill/workflow grant admits the citation channel. */
  citeSource?: boolean;
  remainingBudgetBytes: number;
  /** How `remainingBudgetBytes` was set, so a budget refusal names its limit. */
  budgetBasis?: SourceReadBudgetBasisV1;
  signal?: AbortSignal;
}

export interface SourceSpanSelectionV1 {
  observationId: string;
  representationId: string;
  spanIds: readonly string[];
}

export interface SourceSpanReadResultV1 {
  text: string;
  spanAccess: SourceSpanAccessV1;
  /** Raw fragments remain separate and carry their exact original offsets. */
  spans?: readonly { spanId: string; startByte: number; endByte: number; text: string }[];
}

/**
 * A caller's screen over exactly what a read is about to return, run before
 * the read is charged or recorded. A credential refusal it throws becomes
 * `credential-withheld`; nothing was charged, recorded, or disclosed.
 */
export interface SourceSpanReadOptionsV1 {
  readonly screen?: (preview: {
    readonly text: string;
    readonly spanIds: readonly string[];
    readonly spans?: readonly {
      spanId: string;
      startByte: number;
      endByte: number;
      text: string;
    }[];
    readonly remainingBudgetBytes?: number;
  }) => number | undefined;
}

/**
 * A window of one representation, by byte offset: the whole spans that start at
 * or after `fromByte`, in order, while they fit `maxBytes` and the step's
 * remaining read budget. It names no span id, so a step can read a source past
 * any span listing, and page through one larger than a single read allows.
 */
export interface SourceWindowSelectionV1 {
  observationId: string;
  representationId: string;
  /** Derivative byte offset; the window starts at the span holding it, or the first after it. */
  fromByte: number;
  /** Most bytes the window returns; the remaining read budget still wins. */
  maxBytes?: number;
  /**
   * Derivative byte offset the window ends at: a span that ends past it is not
   * returned, and `nextFromByte` is `null` once the window reaches it. A diff
   * file or hunk read uses it to stay inside that unit.
   */
  endByte?: number;
}

/** What a window returns, before it is charged and recorded. */
export interface SourceWindowPreviewV1 {
  /** Each span's id beside its text, so a citation can name what was read. */
  readonly spans: ReadonlyArray<{
    readonly spanId: string;
    readonly text: string;
    readonly startByte?: number;
    readonly endByte?: number;
  }>;
  /**
   * Spans inside the window the credential screen would withhold. They are
   * skipped, never charged or recorded, so they still count as unread.
   */
  readonly withheldSpanIds: readonly string[];
  /** Bytes this window returns and charges. */
  readonly readBytes: number;
  /** Where the next window starts, or `null` when this one reached the last span. */
  readonly nextFromByte: number | null;
  /** Bytes of every span of the representation: what a whole read charges. */
  readonly totalBytes: number;
  /** Read budget left in this attempt after the window. */
  readonly remainingBudgetBytes: number;
}

export interface SourceWindowReadResultV1 extends SourceWindowPreviewV1 {
  readonly spanAccess: SourceSpanAccessV1;
}

/** A caller's screen over a window's preview; see `SourceSpanReadOptionsV1`. */
export interface SourceWindowReadOptionsV1 {
  readonly screen?: (preview: SourceWindowPreviewV1) => number | undefined;
}

/**
 * One span a step may read: identity and position only, no derivative text and
 * no absolute path. `repositoryPath` is the repository-relative sealed path.
 */
export interface SourceSpanInventoryEntryV1 {
  readonly observationId: string;
  readonly representationId: string;
  readonly repositoryPath: string | null;
  readonly mediaType: string;
  readonly spanId: string;
  readonly startByte: number;
  readonly endByte: number;
  readonly locator: import("./source-evidence.js").SourceSpanLocatorV1;
  readonly form?: typeof SOURCE_EXACT_ORIGINAL_FORM;
  readonly originalIdentity?: {
    readonly side: "before" | "after";
    readonly repositoryId: string;
    readonly blobId: string;
    readonly originalSha256: string;
  };
}

export interface SourceStepReaderV1 {
  /**
   * The spans this step may read; the only way a step learns span ids. Listing
   * consumes no budget and records no access because it discloses no content.
   */
  listSources(): readonly SourceSpanInventoryEntryV1[];
  /**
   * Reads the selected spans. Text the credential screen would withhold
   * refuses the read with `credential-withheld` before it is charged or
   * recorded, so withheld bytes never count as read.
   */
  read(selection: SourceSpanSelectionV1, options?: SourceSpanReadOptionsV1): SourceSpanReadResultV1;
}

interface ReaderBudget {
  remainingBytes: number;
  initialBytes: number;
}

const readerBudgets = new WeakMap<SourceStepReaderV1, ReaderBudget>();

/** Host-only preview: no access observation or budget mutation is performed. */
export interface SourcePreparedSpanV1 {
  readonly text: string;
  readonly spanIds: readonly string[];
  readonly form?: typeof SOURCE_EXACT_ORIGINAL_FORM;
  readonly spans?: readonly { spanId: string; startByte: number; endByte: number; text: string }[];
  readonly remainingBudgetBytes: number;
}

const readerPreviews = new WeakMap<
  SourceStepReaderV1,
  (selection: SourceSpanSelectionV1) => SourcePreparedSpanV1
>();

/** Prepare under the live reader grant, for a host prompt preflight only. */
export function previewSourceSpansForStep(
  reader: SourceStepReaderV1,
  selection: SourceSpanSelectionV1,
): SourcePreparedSpanV1 {
  const preview = readerPreviews.get(reader);
  if (!preview) fail("authority-required");
  return preview(selection);
}

/** Window reads of a reader `forStep` issued; a lookalike reader has none. */
const readerWindows = new WeakMap<
  SourceStepReaderV1,
  (
    selection: SourceWindowSelectionV1,
    options?: SourceWindowReadOptionsV1,
  ) => SourceWindowReadResultV1
>();

/**
 * Reads one window of a representation through the step reader's own grant,
 * budget, and access ledger. A window always returns at least one whole span
 * when the remaining budget holds it, even one longer than `maxBytes`, so
 * paging always advances. A span the credential screen would withhold is
 * skipped and named in `withheldSpanIds`, never charged or recorded. The window
 * fails `budget-exhausted` when the budget cannot hold its first readable span,
 * `credential-withheld` when every span from `fromByte` on is withheld, and
 * `span-unavailable` when no span ends after `fromByte`, or none ends by
 * `endByte`.
 */
export function readSourceWindow(
  reader: SourceStepReaderV1,
  selection: SourceWindowSelectionV1,
  options?: SourceWindowReadOptionsV1,
): SourceWindowReadResultV1 {
  const readWindow = readerWindows.get(reader);
  if (!readWindow) fail("authority-required");
  return readWindow(selection, options);
}

/**
 * True when the credential screen would withhold `value` from a model: the
 * same check the confined tool result screen applies, run before a read is
 * charged or recorded. It matches DocsFab's own configured credentials
 * exactly; text that only looks like a credential is read (#1807).
 */
function holdsConfiguredCredential(value: unknown): boolean {
  try {
    assertConfinedToolResultCredentialFree(value);
    return false;
  } catch (error) {
    if (error instanceof CredentialBoundaryError) return true;
    throw error;
  }
}

type SpanRun = { startByte: number; endByte: number };

/**
 * Each span's run of contiguous spans: the pieces extraction cut from one long
 * line, value, or cell. Separate segments are never contiguous, because a
 * separator byte that belongs to no span lies between them.
 */
function spanRuns(spans: readonly SourceSpanV1[]): ReadonlyMap<string, SpanRun> {
  const runOf = new Map<string, SpanRun>();
  let run: SpanRun | undefined;
  for (const span of [...spans].sort((left, right) => left.startByte - right.startByte)) {
    if (run === undefined || span.startByte !== run.endByte) {
      run = { startByte: span.startByte, endByte: span.endByte };
    } else {
      run.endByte = span.endByte;
    }
    runOf.set(span.spanId, run);
  }
  return runOf;
}

/**
 * Whether the credential screen withholds a span. A configured credential can
 * straddle a cut, so the screen judges each run whole and withholds every
 * piece of a run that holds one.
 */
function contiguousSpanScreen(
  runOf: ReadonlyMap<string, SpanRun>,
  textOf: (span: Pick<SourceSpanV1, "startByte" | "endByte">) => string,
): (span: SourceSpanV1) => boolean {
  const verdicts = new Map<object, boolean>();
  return (span) => {
    const owner = runOf.get(span.spanId) ?? span;
    let verdict = verdicts.get(owner);
    if (verdict === undefined) {
      verdict = holdsConfiguredCredential(textOf(owner));
      verdicts.set(owner, verdict);
    }
    return verdict;
  };
}

/**
 * The text of spans read together, in byte order. Contiguous pieces of one
 * segment rejoin with nothing between them, as in the derivative, and separate
 * segments join with a newline. Pieces of one segment with unread pieces
 * between them join with a host marker naming the skipped bytes, so the read
 * shows neither a line break nor a join the source does not have.
 */
function joinSpanTexts(
  ordered: readonly SourceSpanV1[],
  runOf: ReadonlyMap<string, SpanRun>,
  textOf: (span: Pick<SourceSpanV1, "startByte" | "endByte">) => string,
): string {
  return ordered
    .map((span, index) => {
      const previous = ordered[index - 1];
      if (previous === undefined || previous.endByte === span.startByte) return textOf(span);
      if (runOf.get(previous.spanId) === runOf.get(span.spanId)) {
        return `${SOURCE_READ_GAP_MARKER_PREFIX} ${span.startByte - previous.endByte} bytes of this line not read]${textOf(span)}`;
      }
      return `\n${textOf(span)}`;
    })
    .join("");
}

/** Runs a caller's screen; a credential refusal from it becomes `credential-withheld`. */
function runScreen<T>(
  screen: ((preview: T) => number | undefined) | undefined,
  preview: T,
): number | undefined {
  if (!screen) return;
  try {
    return screen(preview);
  } catch (error) {
    if (error instanceof CredentialBoundaryError) fail("credential-withheld");
    throw error;
  }
}

/**
 * Restores the reader's byte budget to its `forStep` grant for a retry of the
 * same step. Retries call this instead of `forStep`, which would supersede the
 * reader, so a failed attempt cannot starve the next one.
 */
export function beginSourceReadAttempt(reader: SourceStepReaderV1 | undefined): void {
  if (reader === undefined) return;
  const budget = readerBudgets.get(reader);
  if (!budget) fail("authority-required");
  budget.remainingBytes = budget.initialBytes;
}

/**
 * Reads spans for the host before the step's first attempt and keeps their bytes
 * charged to every attempt, because the step's prompt carries them: a later
 * `beginSourceReadAttempt` restores only what is left of the grant.
 */
export function readSourceSpansForEveryAttempt(
  reader: SourceStepReaderV1,
  selections: readonly SourceSpanSelectionV1[],
  options?: readonly (SourceSpanReadOptionsV1 | undefined)[],
): SourceSpanReadResultV1[] {
  const budget = readerBudgets.get(reader);
  if (!budget) fail("authority-required");
  if (options && options.length !== selections.length) fail("source-capability-unavailable");
  const results = selections.map((selection, index) => reader.read(selection, options?.[index]));
  budget.initialBytes = budget.remainingBytes;
  return results;
}

/** Content-free receipt the step gets after a verified citation. */
export interface SourceSpanCitationReceiptV1 {
  readonly supportedClaimSha256: string;
  readonly spanCitationSha256s: readonly string[];
  /** The steps whose recorded reads carry this citation, from anywhere in the run. */
  readonly readingStepIds: readonly string[];
}

export interface SourceStepCiterV1 {
  cite(request: SourceSpanCitationRequestV1): SourceSpanCitationReceiptV1;
}

export interface SourceRunCapabilityV1 {
  readonly binding: SourceBindingV1;
  readonly observations: readonly SourceObservationV1[];
  forStep(grant: SourceStepGrantV1): SourceStepReaderV1 | undefined;
  /**
   * Narrows the citation channel to one step. Call it after `forStep` for the
   * same step: it reuses that generation instead of minting one, so a
   * superseded citer refuses just as a superseded reader does.
   */
  citerForStep(grant: SourceStepGrantV1): SourceStepCiterV1 | undefined;
  spanAccesses(): readonly SourceSpanAccessV1[];
  spanCitations(): readonly SourceSpanCitationV1[];
  /**
   * The citations one step attached itself. The coverage check judges a write
   * step on this, not the run total: reads count run-wide, citations do not.
   */
  spanCitationsFor(citingStepId: string): readonly SourceSpanCitationV1[];
}

export interface SourceEvidenceServiceV1 {
  bindRun(reference: unknown, context: SourceRunAdmissionContextV1): SourceRunCapabilityV1;
}

interface RunState {
  verifier: SourceEvidenceHostVerifier;
  binding: SourceBindingV1;
  observations: Map<string, SourceObservationV1>;
  accesses: SourceSpanAccessV1[];
  /**
   * Keyed by citing step, not pooled, so one write step cannot inherit another's
   * coverage. In mint order, deduplicated by seal.
   */
  citationsByCitingStep: Map<string, SourceSpanCitationV1[]>;
  /** Monotonic generation; `forStep` supersedes every earlier step reader. */
  generation: number;
}

const runStates = new WeakMap<object, RunState>();

/** Route-only and dry-run callers do not call `bindRun`, so no source is opened. */
export function createSourceEvidenceService(
  authority: SourceEvidenceHostAuthority,
): SourceEvidenceServiceV1 {
  const verifier = authorityFactory.lookup(authority);
  if (!verifier) fail("authority-required");
  return Object.freeze({
    bindRun(reference: unknown, context: SourceRunAdmissionContextV1): SourceRunCapabilityV1 {
      return bindRun(verifier, reference, context);
    },
  });
}

function bindRun(
  verifier: SourceEvidenceHostVerifier,
  rawReference: unknown,
  context: SourceRunAdmissionContextV1,
): SourceRunCapabilityV1 {
  const reference: SourceArtifactReferenceV2<"source-binding"> = decodeSourceArtifactReference(
    rawReference,
    "source-binding",
  );
  if (
    reference.repositoryRevision !== context.repository.revision ||
    reference.repositoryContentDigest !== context.repositoryContentDigest
  ) {
    fail("repository-mismatch");
  }

  const binding = decodeSourceBinding(verifier.resolveBinding(reference.digest));
  if (binding.bindingSha256 !== reference.digest) fail("digest-mismatch");
  if (
    binding.repository.identitySha256 !== context.repository.identitySha256 ||
    binding.repository.revision !== context.repository.revision
  ) {
    fail("repository-mismatch");
  }
  if (binding.runIdSha256 !== sha256(context.runId)) fail("run-mismatch");
  if (binding.requestSha256 !== context.requestSha256) fail("request-mismatch");
  if (binding.hostPolicySha256 !== verifier.hostPolicySha256) fail("policy-mismatch");

  // Membership in the actual current producer capabilities, not just equality
  // to the aggregate hash.
  const currentScopes = new Map(
    verifier.producerScopes.map((row) => [row.producerId, row.scopeSha256]),
  );
  if (binding.producerScopeSha256 !== digestSourceProducerScopes(verifier.producerScopes)) {
    fail("producer-scope-mismatch");
  }

  const observations = new Map<string, SourceObservationV1>();
  for (const row of binding.observations) {
    let observation: SourceObservationV1;
    try {
      observation = decodeSourceObservation(verifier.resolveObservation(row.observationId));
    } catch {
      fail("observation-unavailable");
    }
    if (observation.observationSha256 !== row.observationSha256) fail("digest-mismatch");
    if (observation.runIdSha256 !== binding.runIdSha256) fail("run-mismatch");
    if (observation.requestSha256 !== binding.requestSha256) fail("request-mismatch");
    if (
      observation.repository.identitySha256 !== binding.repository.identitySha256 ||
      observation.repository.revision !== binding.repository.revision
    ) {
      fail("repository-mismatch");
    }
    if (currentScopes.get(observation.producerId) !== observation.producerScopeSha256) {
      fail("producer-scope-mismatch");
    }
    observations.set(observation.observationId, observation);
  }
  for (const required of binding.requiredObservationIds) {
    if (!observations.has(required)) fail("observation-unavailable");
  }

  const capabilityRoot = Object.freeze({ kind: "docsfab-source-run-capability" as const });
  const state: RunState = {
    verifier,
    binding,
    observations,
    accesses: [],
    citationsByCitingStep: new Map(),
    generation: 0,
  };
  runStates.set(capabilityRoot, state);

  const capability: SourceRunCapabilityV1 = Object.freeze({
    binding,
    observations: Object.freeze([...observations.values()]),
    forStep(grant: SourceStepGrantV1): SourceStepReaderV1 | undefined {
      const current = runStates.get(capabilityRoot);
      if (!current) fail("authority-required");
      current.generation += 1;
      if (!grant.readSource) return undefined;
      return createStepReader(capabilityRoot, current, grant, current.generation);
    },
    citerForStep(grant: SourceStepGrantV1): SourceStepCiterV1 | undefined {
      const current = runStates.get(capabilityRoot);
      if (!current) fail("authority-required");
      // Requires both the locked grant and the host's citation join.
      if (!grant.citeSource) return undefined;
      if (typeof current.verifier.recordCitation !== "function") return undefined;
      return createStepCiter(capabilityRoot, grant, current.generation);
    },
    spanAccesses(): readonly SourceSpanAccessV1[] {
      return Object.freeze([...state.accesses]);
    },
    spanCitations(): readonly SourceSpanCitationV1[] {
      return Object.freeze([...state.citationsByCitingStep.values()].flat());
    },
    spanCitationsFor(citingStepId: string): readonly SourceSpanCitationV1[] {
      return Object.freeze([...(state.citationsByCitingStep.get(citingStepId) ?? [])]);
    },
  });
  return capability;
}

/**
 * Holds no evidence of its own: each call screens against the current run
 * state, so a citation is only as true as the run's own ledger.
 */
function createStepCiter(
  capabilityRoot: object,
  grant: SourceStepGrantV1,
  generation: number,
): SourceStepCiterV1 {
  return Object.freeze({
    cite(request: SourceSpanCitationRequestV1): SourceSpanCitationReceiptV1 {
      // The same gate `read` uses.
      const current = runStates.get(capabilityRoot);
      if (!current) fail("authority-required");
      if (current.generation !== generation) fail("stale-capability");
      if (!grant.citeSource) fail("read-grant-missing");
      if (grant.signal?.aborted) fail("cancelled");
      const recordCitation = current.verifier.recordCitation;
      if (typeof recordCitation !== "function") fail("source-capability-unavailable");
      const citations = screenSourceSpanCitation({
        binding: current.binding,
        observations: [...current.observations.values()],
        spanAccesses: current.accesses,
        request,
        mintExternalInputCitationSha256: (join) => recordCitation.call(current.verifier, join),
      });
      const recorded = current.citationsByCitingStep.get(grant.stepId) ?? [];
      for (const citation of citations) {
        // Idempotent by seal, so a retrying step cannot record a duplicate.
        if (!recorded.some((entry) => entry.spanCitationSha256 === citation.spanCitationSha256)) {
          recorded.push(citation);
        }
      }
      current.citationsByCitingStep.set(grant.stepId, recorded);
      return Object.freeze({
        supportedClaimSha256: citations[0]!.supportedClaimSha256,
        spanCitationSha256s: Object.freeze(
          citations.map((citation) => citation.spanCitationSha256),
        ),
        readingStepIds: Object.freeze(citations.map((citation) => citation.stepId)),
      });
    },
  });
}

function createStepReader(
  capabilityRoot: object,
  state: RunState,
  grant: SourceStepGrantV1,
  generation: number,
): SourceStepReaderV1 {
  const budget: ReaderBudget = {
    remainingBytes: grant.remainingBudgetBytes,
    initialBytes: grant.remainingBudgetBytes,
  };
  /**
   * Refuses a read of `neededBytes` the budget cannot hold. Past the step's
   * whole budget it names the limit that set it; otherwise the step already
   * spent the rest, and a later step or attempt can read on.
   */
  const refuseBudget = (neededBytes: number): never => {
    const stepBudget = grant.remainingBudgetBytes;
    fail(
      "budget-exhausted",
      neededBytes > stepBudget
        ? `Step ${grant.stepId} cannot read ${neededBytes} bytes in one read. ${sourceReadBudgetObservation(
            {
              neededBytes,
              budgetBytes: stepBudget,
              ...(grant.budgetBasis ? { budgetBasis: grant.budgetBasis } : {}),
            },
          )}`
        : `Step ${grant.stepId} has ${budget.remainingBytes} of its ${stepBudget}-byte source-read budget left and this read needs ${neededBytes} bytes. Read fewer spans, or continue from the same offset in a later step or attempt, which starts with its own budget.`,
    );
  };
  /** The gate every call passes, so a stale reader can neither read nor enumerate. */
  const live = (): RunState => {
    const current = runStates.get(capabilityRoot);
    if (!current) fail("authority-required");
    if (current.generation !== generation) fail("stale-capability");
    if (!grant.readSource) fail("read-grant-missing");
    if (grant.signal?.aborted) fail("cancelled");
    return current;
  };
  const representationOf = (
    current: RunState,
    observationId: string,
    representationId: string,
  ): { observation: SourceObservationV1; representation: SourceRepresentationV1 } => {
    const observation = current.observations.get(observationId);
    if (!observation) {
      fail(
        "observation-unavailable",
        "That observationId is not a source this step may read. Pass a source handle docsfab_list_sources returned, or its observationId exactly; call docsfab_list_sources again to see them.",
        "unknown-source",
      );
    }
    const representation = observation.representations.find(
      (entry) => entry.representationId === representationId,
    );
    if (!representation) {
      fail(
        "span-unavailable",
        "That representationId is not a representation of this observation. Pass the source handle docsfab_list_sources returned instead, or the representationId it listed beside this observationId.",
        "unknown-representation",
      );
    }
    return { observation, representation };
  };
  const derivativeOf = (
    current: RunState,
    observation: SourceObservationV1,
    representation: SourceRepresentationV1,
  ): Uint8Array => {
    const derivative = current.verifier.resolveDerivative({
      observationId: observation.observationId,
      representationId: representation.representationId,
    });
    if (!derivative) {
      fail(
        "observation-unavailable",
        "The host holds no retained text for this source, so no read of it can succeed. Read another listed source, and report the run id.",
        "retained-text-missing",
      );
    }
    return derivative;
  };
  const originalOf = (
    current: RunState,
    observation: SourceObservationV1,
    representation: SourceRepresentationV1,
  ): Uint8Array => {
    const original = current.verifier.resolveOriginal?.({
      observationId: observation.observationId,
      representationId: representation.representationId,
    });
    if (
      !original ||
      original.length !== observation.original.byteLength ||
      sha256(original) !== observation.original.sha256 ||
      sha256(original) !== representation.sha256
    )
      fail("observation-unavailable");
    // A configured credential can straddle two sealed spans. Screen the
    // complete original before selecting or returning either fragment.
    if (containsConfiguredCredentialInBytes(original)) fail("credential-withheld");
    return original;
  };
  const contentOf = (
    current: RunState,
    observation: SourceObservationV1,
    representation: SourceRepresentationV1,
  ): Uint8Array =>
    representation.form === SOURCE_EXACT_ORIGINAL_FORM
      ? originalOf(current, observation, representation)
      : derivativeOf(current, observation, representation);
  const rawText = (bytes: Uint8Array, span: Pick<SourceSpanV1, "startByte" | "endByte">): string =>
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes.subarray(span.startByte, span.endByte),
    );
  const requireRawCharge = (value: number | undefined): number => {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
      fail("source-capability-unavailable");
    if (value > budget.remainingBytes) refuseBudget(value);
    return value;
  };
  /**
   * Charges and records spans of one representation, in byte order, after their
   * text was read and screened. The access is recorded only for bytes actually
   * returned under this grant.
   */
  const charge = (
    current: RunState,
    observation: SourceObservationV1,
    representation: SourceRepresentationV1,
    ordered: readonly SourceSpanV1[],
    serializedChargeBytes?: number,
  ): SourceSpanAccessV1 => {
    const returnedBytes = ordered.reduce(
      (total, entry) => total + (entry.endByte - entry.startByte),
      0,
    );
    const amount =
      representation.form === SOURCE_EXACT_ORIGINAL_FORM
        ? requireRawCharge(serializedChargeBytes)
        : returnedBytes;
    if (amount > budget.remainingBytes) refuseBudget(amount);
    const accessObservationSha256 = current.verifier.recordAccess({
      observationId: observation.observationId,
      representationId: representation.representationId,
      stepId: grant.stepId,
      spanIds: ordered.map((entry) => entry.spanId),
    });
    const spanAccess = createSourceSpanAccess({
      bindingSha256: current.binding.bindingSha256,
      observationId: observation.observationId,
      representationId: representation.representationId,
      representationSha256: representation.representationSha256,
      stepId: grant.stepId,
      accessObservationSha256,
      spanIds: ordered.map((entry) => entry.spanId),
      observedAt: current.verifier.now().toISOString(),
      ...(representation.form === SOURCE_EXACT_ORIGINAL_FORM
        ? { serializedChargeBytes: amount }
        : {}),
    });
    budget.remainingBytes -= amount;
    current.accesses.push(spanAccess);
    return spanAccess;
  };
  const reader: SourceStepReaderV1 = Object.freeze({
    listSources(): readonly SourceSpanInventoryEntryV1[] {
      const current = live();
      const entries: SourceSpanInventoryEntryV1[] = [];
      for (const observation of current.observations.values()) {
        for (const representation of observation.representations) {
          for (const span of representation.spans) {
            const originalIdentity =
              representation.form === SOURCE_EXACT_ORIGINAL_FORM
                ? current.verifier.describeOriginal?.({
                    observationId: observation.observationId,
                    representationId: representation.representationId,
                  })
                : undefined;
            if (representation.form === SOURCE_EXACT_ORIGINAL_FORM && !originalIdentity)
              fail("observation-unavailable");
            entries.push(
              Object.freeze({
                observationId: observation.observationId,
                representationId: representation.representationId,
                repositoryPath: observation.original.repositoryPath,
                mediaType: observation.original.mediaType,
                spanId: span.spanId,
                startByte: span.startByte,
                endByte: span.endByte,
                locator: span.locator,
                ...(representation.form ? { form: representation.form, originalIdentity } : {}),
              }),
            );
          }
        }
      }
      return Object.freeze(entries);
    },
    read(
      selection: SourceSpanSelectionV1,
      options?: SourceSpanReadOptionsV1,
    ): SourceSpanReadResultV1 {
      const current = live();
      if (
        !selection ||
        typeof selection !== "object" ||
        typeof selection.observationId !== "string" ||
        typeof selection.representationId !== "string" ||
        !Array.isArray(selection.spanIds) ||
        selection.spanIds.length === 0
      ) {
        fail(
          "span-unavailable",
          "A read by span ids takes an observationId, a representationId, and at least one span id.",
          "argument-shape",
        );
      }
      const { observation, representation } = representationOf(
        current,
        selection.observationId,
        selection.representationId,
      );
      const known = new Set(representation.spans.map((entry) => entry.spanId));
      const unknown = selection.spanIds.filter((spanId) => !known.has(spanId)).length;
      if (unknown > 0) {
        fail(
          "span-unavailable",
          `${unknown} of the ${selection.spanIds.length} span ids are not spans of this representation. Take span ids from docsfab_list_sources for the same source, or read a window from fromByte 0.`,
          "unknown-span",
        );
      }

      const ordered = representation.spans
        .filter((entry) => selection.spanIds.includes(entry.spanId))
        .sort((left, right) => left.startByte - right.startByte);
      const raw = representation.form === SOURCE_EXACT_ORIGINAL_FORM;
      const bytes = contentOf(current, observation, representation);
      const requested = ordered.reduce(
        (total, entry) => total + (entry.endByte - entry.startByte),
        0,
      );
      if (requested > budget.remainingBytes) refuseBudget(requested);
      const textOf = raw
        ? (span: Pick<SourceSpanV1, "startByte" | "endByte">) => rawText(bytes, span)
        : sourceSpanTextReader(representation, bytes);
      const runOf = spanRuns(representation.spans);
      const fragments = raw
        ? ordered.map((span) => ({
            spanId: span.spanId,
            startByte: span.startByte,
            endByte: span.endByte,
            text: textOf(span),
          }))
        : undefined;
      const text = raw
        ? fragments!.map((entry) => entry.text).join("")
        : joinSpanTexts(ordered, runOf, textOf);
      // Screened before the read is charged or recorded, so text the
      // credential screen withholds never counts as read.
      if (!raw) {
        const withheld = contiguousSpanScreen(runOf, textOf);
        if (ordered.some(withheld) || holdsConfiguredCredential(text)) fail("credential-withheld");
      }
      const spanIds = ordered.map((entry) => entry.spanId);
      let rawCharge: number | undefined;
      if (raw) {
        // The model-facing renderer computes charge from its exact JSON output;
        // no raw read may use the old extent-based budget path.
        let remaining = budget.remainingBytes;
        const seen = new Set<number>();
        for (;;) {
          const proposed = requireRawCharge(
            runScreen(options?.screen, {
              text,
              spanIds,
              spans: fragments,
              remainingBudgetBytes: remaining,
            }),
          );
          const next = budget.remainingBytes - proposed;
          if (next === remaining) {
            rawCharge = proposed;
            break;
          }
          if (seen.has(next)) fail("budget-exhausted");
          seen.add(next);
          remaining = next;
        }
      } else runScreen(options?.screen, { text, spanIds });
      return {
        text,
        ...(fragments ? { spans: fragments } : {}),
        spanAccess: charge(current, observation, representation, ordered, rawCharge),
      };
    },
  });
  readerPreviews.set(reader, (selection) => {
    const current = live();
    if (!selection || !Array.isArray(selection.spanIds) || selection.spanIds.length === 0)
      fail("span-unavailable");
    const { observation, representation } = representationOf(
      current,
      selection.observationId,
      selection.representationId,
    );
    const ids = new Set(selection.spanIds);
    const ordered = representation.spans
      .filter((span) => ids.has(span.spanId))
      .sort((left, right) => left.startByte - right.startByte);
    if (ordered.length !== ids.size) fail("span-unavailable");
    const bytes = contentOf(current, observation, representation);
    const textOf =
      representation.form === SOURCE_EXACT_ORIGINAL_FORM
        ? (span: Pick<SourceSpanV1, "startByte" | "endByte">) => rawText(bytes, span)
        : sourceSpanTextReader(representation, bytes);
    const runOf = spanRuns(representation.spans);
    if (representation.form === SOURCE_EXACT_ORIGINAL_FORM) {
      const spans = ordered.map((span) =>
        Object.freeze({
          spanId: span.spanId,
          startByte: span.startByte,
          endByte: span.endByte,
          text: textOf(span),
        }),
      );
      return Object.freeze({
        form: SOURCE_EXACT_ORIGINAL_FORM,
        text: spans.map((span) => span.text).join(""),
        spanIds: Object.freeze(ordered.map((span) => span.spanId)),
        spans: Object.freeze(spans),
        remainingBudgetBytes: budget.remainingBytes,
      });
    }
    const withheld = contiguousSpanScreen(runOf, textOf);
    if (ordered.some(withheld)) fail("credential-withheld");
    const text = joinSpanTexts(ordered, runOf, textOf);
    if (holdsConfiguredCredential(text)) fail("credential-withheld");
    return Object.freeze({
      text,
      spanIds: Object.freeze(ordered.map((span) => span.spanId)),
      remainingBudgetBytes: budget.remainingBytes,
    });
  });
  const readWindow = (
    selection: SourceWindowSelectionV1,
    options?: SourceWindowReadOptionsV1,
  ): SourceWindowReadResultV1 => {
    const current = live();
    if (
      !selection ||
      typeof selection !== "object" ||
      typeof selection.observationId !== "string" ||
      typeof selection.representationId !== "string" ||
      !Number.isSafeInteger(selection.fromByte) ||
      selection.fromByte < 0 ||
      (selection.maxBytes !== undefined &&
        (!Number.isSafeInteger(selection.maxBytes) || selection.maxBytes <= 0)) ||
      (selection.endByte !== undefined &&
        (!Number.isSafeInteger(selection.endByte) || selection.endByte <= selection.fromByte))
    ) {
      fail(
        "span-unavailable",
        "A window read takes an observationId, a representationId, fromByte as a whole number of 0 or more, and maxBytes, when given, as a whole number of 1 or more.",
        "argument-shape",
      );
    }
    const endByte = selection.endByte ?? Number.POSITIVE_INFINITY;
    const { observation, representation } = representationOf(
      current,
      selection.observationId,
      selection.representationId,
    );
    const raw = representation.form === SOURCE_EXACT_ORIGINAL_FORM;
    const spans = [...representation.spans].sort((left, right) => left.startByte - right.startByte);
    // An offset inside a span starts the window at that span, so no byte after
    // `fromByte` is skipped.
    const start = spans.findIndex(
      (span) =>
        span.endByte > selection.fromByte ||
        (raw &&
          representation.byteLength === 0 &&
          selection.fromByte === 0 &&
          span.startByte === 0),
    );
    if (start < 0) {
      fail(
        "span-unavailable",
        `fromByte ${selection.fromByte} is at or past byte ${spans.at(-1)?.endByte ?? 0}, where the last span of this representation ends. Read from 0, or from the nextFromByte an earlier window returned.`,
        "window-range",
      );
    }
    const bytes = contentOf(current, observation, representation);
    const textOf = raw
      ? (span: Pick<SourceSpanV1, "startByte" | "endByte">) => rawText(bytes, span)
      : sourceSpanTextReader(representation, bytes);
    const withheld = raw ? () => false : contiguousSpanScreen(spanRuns(spans), textOf);
    const ceiling = Math.min(selection.maxBytes ?? budget.remainingBytes, budget.remainingBytes);
    const window: Array<{ span: SourceSpanV1; text: string }> = [];
    const withheldSpanIds: string[] = [];
    let readBytes = 0;
    let index = start;
    for (; index < spans.length; index += 1) {
      const span = spans[index]!;
      if (span.endByte > endByte && !(raw && representation.byteLength === 0)) break;
      const text = textOf(span);
      // Withheld text is skipped, never charged or recorded, so it stays unread.
      if (withheld(span)) {
        withheldSpanIds.push(span.spanId);
        continue;
      }
      const size = span.endByte - span.startByte;
      // The first span may pass `maxBytes`, so paging always advances.
      const fits =
        window.length === 0
          ? raw || size <= budget.remainingBytes
          : !raw && readBytes + size <= ceiling;
      if (!fits) break;
      window.push({ span, text });
      readBytes += size;
    }
    const next =
      index < spans.length && spans[index]!.endByte <= endByte ? spans[index] : undefined;
    if (window.length === 0) {
      if (next !== undefined) refuseBudget(next.endByte - next.startByte);
      if (withheldSpanIds.length > 0) fail("credential-withheld");
      fail(
        "span-unavailable",
        `No whole span lies between fromByte ${selection.fromByte} and endByte ${endByte}. Read from 0, or from the nextFromByte an earlier window returned.`,
        "window-range",
      );
    }
    let preview: SourceWindowPreviewV1 = Object.freeze({
      spans: Object.freeze(
        window.map(({ span, text }) =>
          Object.freeze({
            spanId: span.spanId,
            text,
            ...(raw ? { startByte: span.startByte, endByte: span.endByte } : {}),
          }),
        ),
      ),
      withheldSpanIds: Object.freeze(withheldSpanIds),
      readBytes,
      nextFromByte: next === undefined ? null : next.startByte,
      totalBytes: representation.spans.reduce(
        (total, span) => total + (span.endByte - span.startByte),
        0,
      ),
      remainingBudgetBytes: budget.remainingBytes - (raw ? 0 : readBytes),
    });
    let rawCharge: number | undefined;
    if (raw) {
      let remaining = budget.remainingBytes;
      const seen = new Set<number>();
      for (;;) {
        const candidate = Object.freeze({ ...preview, remainingBudgetBytes: remaining });
        const proposed = requireRawCharge(runScreen(options?.screen, candidate));
        const next = budget.remainingBytes - proposed;
        if (next === remaining) {
          preview = candidate;
          rawCharge = proposed;
          break;
        }
        if (seen.has(next)) fail("budget-exhausted");
        seen.add(next);
        remaining = next;
      }
    } else runScreen(options?.screen, preview);
    const spanAccess = charge(
      current,
      observation,
      representation,
      window.map(({ span }) => span),
      rawCharge,
    );
    return Object.freeze({ ...preview, spanAccess });
  };
  readerBudgets.set(reader, budget);
  readerWindows.set(reader, readWindow);
  return reader;
}

/**
 * Admits a run's optional source reference. A source-aware request without a
 * service fails `source-capability-unavailable`; a service supplied for a
 * no-source request is inert.
 */
export function admitRunSourceBinding(input: {
  reference?: unknown;
  service?: SourceEvidenceServiceV1;
  context: SourceRunAdmissionContextV1;
}): SourceRunCapabilityV1 | undefined {
  if (input.reference === undefined) return undefined;
  if (!input.service || typeof input.service.bindRun !== "function") {
    fail("source-capability-unavailable");
  }
  return input.service.bindRun(input.reference, input.context);
}
