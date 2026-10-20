# Source evidence

DocsFab binds a documentation claim to the actual bytes it came from. The source
evidence contracts record which original was admitted, which source view a
step read, which spans supported an output claim, and what the extraction could
not cover. The v1 records are harness-neutral and live under `src/inputs/`.

These records carry identity and digests only. No body, no filesystem custody
path, no credential, and no raw private locator enters a source-evidence record.

## Records

All five records share `schemaVersion: 1`, a named `kind`, and a digest computed
over every other field.

| Record | Kind | Digest field | Binds |
| --- | --- | --- | --- |
| `SourceObservationV1` | `docsfab-source-observation` | `observationSha256` | One admitted original, its producer and acquisition receipt, and its source representations |
| `SourceBindingV1` | `docsfab-source-binding` | `bindingSha256` | The run, repository, request, host policy, producer scopes, selected observations, and required subset |
| `SourceSpanAccessV1` | `docsfab-source-span-access` | `spanAccessSha256` | The spans one step actually read, joined to the external-input access ledger |
| `SourceSpanCitationV1` | `docsfab-source-span-citation` | `spanCitationSha256` | The spans that support one output claim |
| `SourceEvidenceFinalV1` | `docsfab-source-evidence-final` | `evidenceSha256` | The manifest, ledgers, limitations, and required-source coverage for the run |

## Original and derivative identity

The original raw bytes and the derivative bytes are hashed separately. A
derivative is always `text/plain; charset=utf-8`, and a derived line is never
reported as a line in the original binary. A public GitHub PR Markdown/MDX
source may also carry a complete `exact-original-utf8` representation. Its
SHA-256 and byte length equal the acquired Git blob, and its spans partition
every original byte in order on UTF-8 code-point boundaries. It preserves a
leading BOM, CRLF, blank lines, Unicode, and a trailing newline. The host
refuses invalid UTF-8 instead of replacing bytes. This is an exact text view,
not general binary support.

The observation cases are closed. Existing derivative-only records omit all
new fields and retain their historical seal. A dual-view PR observation keeps
the derivative as primary and adds a distinct `originalInputId` and
`originalRegistrationSha256` pair, so each access names the registration for
the bytes actually returned. An original-only observation has one raw
representation and `primaryContentForm: "exact-original-utf8"`; its primary
input registration names the original digest. A half pair, duplicate raw view,
raw view with no valid registration, or original-only marker beside a
derivative refuses. A zero-byte original has one special 0..0 raw witness;
other spans still require positive extent. A blank but nonempty source has
ordinary nonzero spans. An absent deleted side has no invented empty source.

Identity is layered so that no hash depends on itself:

- `representationId` is `rep-` plus a digest of the original digest and the
  extractor identity. It is established before the descriptor is hashed.
- `representationSha256` covers the whole descriptor, including the span map.
- `spanId` is `span-` plus a digest of the original digest, the extractor
  identity and options, the derivative digest, the derivative byte range, and
  the locator. The host computes it; the model only receives it.
- Knowledge lineage roots each observation at `original-<originalSha256>` and
  hangs every derivative descriptor off that root.

Because `spanId` is recomputed during decoding, a span moved to a different
original, extractor, derivative, range, or locator fails with `span-mismatch`
instead of decoding as valid evidence.

Spans use zero-based, half-open UTF-8 byte offsets into the exact retained
representation. Duplicate identifiers, empty or reversed ranges, and
overlapping ranges are rejected except for the raw zero-byte witness.

## Locators

The locator discriminant set is closed. An unfamiliar kind is rejected visibly.

| Locator | Fields |
| --- | --- |
| `text` | `startByte`, `endByte` in the original |
| `json-pointer` | `pointer` (RFC 6901) |
| `notebook-cell` | `cellId`, `cellOrdinal`, `part`, `outputOrdinal`, `startByte`, `endByte` |
| `html-node` | `nodeOrdinal`, `textStartByte`, `textEndByte` |
| `pdf-page` | `pageNumber`, `itemStart`, `itemEnd` |
| `docx-block` | `part`, `blockPath`, `paragraphOrdinal`, `tableCell` |
| `diff` | `part`, `fileOrdinal`, `oldPath`, `newPath`, `change`, `labels`, `hunkOrdinal`, `hunkCount`, `oldStart`, `oldLines`, `newStart`, `newLines`, `startByte`, `endByte` |

A `diff` locator's `part` is `manifest`, `preamble`, `trailer`, `header`,
`hunk`, `note`, or `file`. The decoder enforces these rules per part and refuses
any other combination with `invalid-value`:

- `manifest`: the host-written manifest. Every other field is `null`, including
  `startByte` and `endByte`, and `labels` is empty.
- `preamble` and `trailer`: message text before a patch's first file, and text
  after a file that opens no file, such as a mail signature. They name
  `startByte` and `endByte` in the original and no file.
- `header` and `file`: one file's header lines, or the whole file, header and
  every hunk. They name the 1-based `fileOrdinal`, the paths, the `change`
  (`added`, `copied`, `deleted`, `modified`, or `renamed`), the sorted `labels`,
  `hunkCount`, and the original byte range.
- `hunk`: also names the 1-based `hunkOrdinal` within the file and the old and
  new start line and line count from its `@@` header, and leaves `hunkCount`
  `null`.
- `note`: text after a hunk's line counts that opens nothing, such as a
  `diff -r` `Only in` line. It names its file and original bytes, and leaves
  every hunk field and `hunkCount` `null`.

Ordinals are positions in the diff, so a path that appears in two patches of a
series is two files. A path is `null` on the `/dev/null` side, when the header
states none, or when the locator cannot carry it. A carried path is
repository-relative NFC text with no empty, `.`, or `..` segment, no backslash,
and no drive letter, at most `sources.authorityMemberPathMaxChars` (512) code
units, the bound sealed evidence already uses for repository paths. It holds
none of the code points the original source authority refuses in a member
path (`UNSAFE_PATH_CODE_POINT`: controls such as a line feed, format characters
such as a bidirectional override, and line or paragraph separators), so a
quoted path cannot write a line of its own into the host's manifest. Any other
path, such as an absolute one, is `null`, and the file is labeled
`unrepresentable-path`. No
locator carries the free text after a hunk's second `@@`. Every number is at
most 67,108,864. A `@@` line past that opens no hunk: before a file's first
hunk it is the file's body text, and after a hunk it is part of a `note`.

`normalizeSourceLocator` has one branch per kind and refuses any other, so a
kind added to the discriminant set without a branch cannot decode as another
kind. Adding the `diff` kind re-keys no existing digest and needs no request
projection version.

## Non-circular request identity

`requestSha256` comes from a closed version-1 projection of the admitted run
request, identified as `docsfab-source-request-context`. Use
`projectSourceRequestContext` for an actual request, or
`computeSourceRequestSha256` for an already normalized context.

The projection includes the run identifier, the selected workflow, the validated
repository binding, the host-derived workspace identity digest, and the actual
values of `task`, `contextTarget`, `instruction`, `reviewScope`, `allowWrite`,
`releaseDefaultBranch`, `taskLineage`, `compositionExecution`, and
`knowledgeResumeReceipt`. Absent optional values are explicit `null`.

Exactly three request fields are excluded:

- `sourceBinding`, so the reference digest cannot enter the request hash it is
  derived from.
- `signal` and other process-local services and callbacks.
- the raw workspace path, replaced by its authenticated identity digest.

A request field that the version-1 projection does not recognize fails with
`projection-unversioned`, and the refusal names the field. A source-aware
caller never silently drops an admission-affecting field from evidence; the
projection version is the only place reconciliation happens.

`SOURCE_REQUEST_FIELD_CLASSES` classifies every `RunRequest` field once: the
projection version that first hashes it, `resolved` for the fields the host
resolves outside the body (`runId`, `workflow`, `repository`, and the three
exclusions above), or `continuation-pending`. Its type is a mapped type over
`RunRequest`, so a new request field does not compile until it is classified,
and every projected-field list, the resolved list, and version selection derive
from it. A key outside `RunRequest` still fails with `projection-unversioned` at
run time.

Four durable knowledge-continuation fields are a recognized special case:
`knowledgeContinuationReceipt`, `knowledgeContinuationRecoveryAuthorization`,
`knowledgeContinuationSnapshotSha256`, and
`knowledgeContinuationAcceptanceSha256`. They are siblings of the projected
`knowledgeResumeReceipt` and equally admission-affecting, but decision #795 did
not settle whether they belong in the version-1 projection. A source-aware run
carrying one refuses with `continuation-projection-pending`, a code of their
own, so the open decision stays legible instead of looking like an unrecognized
field. Source-aware durable continuation runs require that decision first.
That code wins at every projection version; the decision is still open.

## Request projection version 2

Version 1 cannot represent an `update-documentation` request. Five reader and
editorial fields are set on an update run and version 1 does not recognize any
of them, so a source-aware update refused with `projection-unversioned` before
it could bind anything:

| Field | Supplied by |
| --- | --- |
| `readerContextInput` | the CLI reader-task assembly on every update run |
| `readerTaskContext` | the same site, as the verified host projection |
| `readerContext` | a host or live embedding that already admitted the context |
| `readerContextProvenance` | the same embedding; neither field grants write authority |
| `editorialEvidenceRefs` | the editorial evidence assembly |

Version 2 projects all five with their actual values, and absent optional values
stay explicit `null`, exactly as in version 1. Its hashed body also carries
`projectionVersion: 2`, so a version-2 digest can never collide with the
version-1 digest of the same request. Use `computeSourceRequestSha256V2` for an
already normalized `SourceRequestContextV2`.

Version 2 changes nothing else. The same three fields are excluded —
`sourceBinding`, `signal`, and the raw workspace path — and an unrecognized
field still fails with `projection-unversioned`.

## Request projection version 3

First-pass binding takes a run's write targets from the recorded request
interpretation, `requestIntent`, so the source request projection carries it
too. Version 3 is version 2 plus `requestIntent`, projected as recorded: the
admission outcome and, for an admitted run, the sealed intent. A local run
carries the field whenever the interpretation step recorded an outcome,
`offline` and `not-applicable` included, and a source-aware run that carries it
projects at version 3. Its hashed body carries `projectionVersion: 3`. Use
`computeSourceRequestSha256V3` for an already normalized
`SourceRequestContextV3`.

The CLI producer projects the admitted request with the field, and the runner
projects the request it receives, which carries the same field; neither side
strips it. A changed quote or target in the intent changes the digest.

### Reconciliation

The projection version is the only place reconciliation happens, and it is a
property of the request rather than a caller preference:

- `selectSourceRequestProjectionVersion` returns the lowest version that
  represents every key present on the admitted request. The producer that mints
  a binding and the runner that revalidates it read the same request object, so
  they reach the same version without a version being plumbed between them.
- A request carrying none of the five fields projects at version 1 and keeps its
  historical `requestSha256` byte for byte. No binding minted before version 2
  existed has to be migrated or re-hashed.
- A request carrying any of them, and no later field, projects at version 2.
  A request carrying `requestIntent`, and neither version-4 field, projects at
  version 3. A request carrying `readerEvidenceRequest` or `instructionContext`
  projects at version 4.
- `projectSourceRequestContext` accepts an optional `projectionVersion` that
  pins a version instead of selecting one. Pinning version 1 on a request that
  needs version 2 keeps the historical refusal; it does not relax it.
- An unrecognized version fails with `projection-unversioned` rather than being
  reduced to a version the contract does know. A caller cannot mint a future
  version this contract has not defined.

Adding a field to a projection is therefore always a new version, never an edit
to an existing one. `test/source-input-authority.test.ts` pins the version-1
digest of a canonical no-source create request, the version-2 digests of a
bare request and a whole update request, and the version-3 and version-4
digests of the bare request, so no body can move silently.

## Request projection version 4

Version 3 cannot represent two more request fields, so a source-aware run that
carried either refused with `projection-unversioned`:

| Field | Supplied by |
| --- | --- |
| `readerEvidenceRequest` | `docsfab run update-documentation` when the operator gave `--comparison-base`, `--comparison-workspace`, or `--reader-source` |
| `instructionContext` | a live agent's non-authoritative context beside the verbatim instruction |

Version 4 appends both to the version-3 body, which keeps `requestIntent`,
with their actual values, absent values as explicit `null`, and carries
`projectionVersion: 4`. A request with either selects version 4; every other
request keeps its version-1, version-2, or version-3 digest. Pinning an earlier
version refuses with `projection-unversioned` and names the field. Use
`computeSourceRequestSha256V4` for an already normalized
`SourceRequestContextV4`.

## Authority

Authority narrows in one direction and never widens:

```text
host authority -> service -> run capability (bindRun) -> step reader (forStep)
```

- `createSourceEvidenceHostAuthority` issues the opaque host authority through
  the contract kit. A lookalike object resolves to nothing.
- `createSourceEvidenceService` turns that authority into the process-local
  service. Route-only and dry-run callers never call `bindRun`, so no source is
  opened.
- `bindRun` validates the reference, the resolved domain record and its digest,
  the repository identity, revision, and content digest, the run and request
  identity, the effective host policy, membership in the current producer
  scopes, and every required observation.
- `forStep` binds one step. It returns a reader only when the installed locked
  skill admits a source read. Each call supersedes the previous reader, so a
  stale capability fails with `stale-capability`.
- The reader exposes `listSources` and `read`. `listSources` enumerates exactly
  the spans this step may read, as identity and position only. `read` accepts an
  observation, representation, and span selection that belongs to the sealed
  binding. Neither input has a field for a path, a URL, a run identifier, a step
  identifier, or a replacement policy, so a model cannot name one.

A source-aware request without a live service fails with
`source-capability-unavailable` before any source body or model call. A service
supplied for a request with no reference stays inert, so no-source runs behave
exactly as before.

`SourceSpanAccessV1` is recorded only for bytes actually returned, and its
`accessObservationSha256` joins the existing external-input access ledger.

## Plan binding variants

`DocumentationPlanBindingV1` keeps its exact bytes, digest, and authority for
runs with no source. `DocumentationPlanBindingV2` adds `sourceBindingSha256`
carrying the complete admitted `bindingSha256`, and its digest input includes
`schemaVersion: 2`, so a V2 plan can never collide with the V1 digest of the
same pages and sources. Use `validateAdmittedDocumentationPlanBinding` to
dispatch on the explicit variant and
`admittedDocumentationPlanBindingSha256` to obtain the identity an editorial
decision must bind. An unrecognized version fails with `unknown-plan-variant`
rather than being reduced to a V1 projection that loses source identity.

Either variant can carry `createConvertedToUpdate = {reason, path,
baseSha256}` (#1739). Only CREATE plan admission writes it, when exactly one
planned page already exists as a tracked regular file at that exact path.
`reason` is a closed set: `create-target-exists` when the planner planned a
CREATE of the page, and `planner-proposed-update` when the planner proposed the
plan with `mode: "update"`. Reply admission reads such a proposal as the CREATE
of the same pages only when the host's existence oracle finds every page it
would write; otherwise the reply is refused `invalid-value` at
`$.planBinding.mode`, the refusal of any other UPDATE plan from a CREATE
planner. The oracle counts an existing entry that no UPDATE can start from (a
directory, a path under a file, a case variant, a symbolic link, a submodule,
or an excluded entry) as existing, so plan admission refuses an UPDATE
proposal of it with `create-target-exists`, which stops the run, exactly as it
refuses a CREATE of the same path. Both reasons then pass the same admission,
the same hosted write grant check, and the same ambiguity rule. The converted page
is a write target, never one of the plan's bound sources. A fresh CREATE plan
that lists a page it writes among its sources is refused
`documentation-plan-source-write-target` at
`$.planBinding.sourceBindings[].sources[]`, a correctable planner rule; a
sealed binding is still read as written, and source-obligation derivation keeps
refusing it (`source-write-intersection`). A CREATE plan source must be a
tracked file at the run's revision: bound evidence such as a `--change` diff or
manifest (`change-source/<head>/...`) has no bytes in the revision to seal as
original source authority, so it is read and cited through the source tools,
never named as a page source. A plan that names one stops before any write
with `source-untracked`. A source-obligation reply that cites
the page is refused in the attempt with the correctable catalog rule
`write-target-source`; a citation of any other path outside the bound sources
keeps the pinned authority refusal `unauthorized-source`. That
page's disposition becomes `update`, `baseSha256` is the SHA-256 of its bytes at
the run's revision (not a Git object ID), and the field enters the digest
input only when present, so every unconverted digest is unchanged. The one
validator admits an `update` page in a CREATE plan only as that converted
page, and a fresh planner proposal that carries the field is refused
`invalid-shape`. Candidate reconstruction replaces the converted page only
while the revision export still holds that base.

## Extractor adapter contract

`SourceExtractorAdapterV1` in `src/inputs/source-extraction.ts` is the seam that
format adapters plug into. `#835` ships the tracked HTML adapter in
`src/inputs/adapters/html.ts`. Structured sources, PDF, and DOCX adapters
implement the same interface.

An adapter declares:

- `id` and `version`, which become part of the extractor identity.
- `locatorKind`, the single locator discriminant it is allowed to emit.
- `mediaTypes`, lowercase and parameter-free original media types it claims.
- `defaultOptions`, the pinned transformation settings.

An adapter implements one method, and may implement one more:

```ts
extract(request: { bytes, options, limits, signal }):
  | { segments, limitations, overflows? }
  | Promise<{ segments, limitations, overflows? }>
abort?(request): void
```

Each segment is `{ text, locator }`: the exact readable text of one passage and
the locator that points it back at the original. The result may also carry
`overflows`: the closed catalog axis and the actual pre-truncation observation
the adapter measured. `limitations` uses the fixed reason codes
`active-content-excluded`, `byte-budget-truncated`, `hidden-content-excluded`,
`non-text-content-excluded`, `span-budget-truncated`, `unsupported-encoding`,
and `unsupported-structure`.

The text adapter materializes only the prefix of whole lines admitted by the
effective span and derivative-byte budgets. It continues scanning omitted lines
to report the full observed size and the first binding truncation limit. Split
UTF-8 pieces count toward the span budget; a later smaller line cannot replace
an excluded line. The complete original still undergoes UTF-8 validation and
hashing. This bounds retained line objects without changing evidence identities,
supported limits, or the whole-segment credential-screening rule.

Those seven are the whole list. `heuristic-encoding` is a **planned eighth code,
not a member of it**: a decided policy exists for PDF composite fonts that lack
a `ToUnicode` map, but no adapter emits the code and
`SOURCE_REPRESENTATION_LIMITATIONS` does not contain it, so the closed decoder
rejects it today. An independent 2026-09-21 probe of `pdfjs-dist@6.3.289`
confirmed there is still no public text-API signal that could produce the code
inside #795's frozen option set; mozilla/pdf.js#21968, which asked for that
signal, was closed as `not_planned`. It is recorded as a known gap rather than
reserved in the enum, because a value in the closed list that nothing can
produce would be indistinguishable from one a decoder simply never saw. Refer to
[Heuristic Font Decoding](pdf-evidence.md#heuristic-font-decoding).

An adapter must be an in-process, inert transformation: no network, no
filesystem, no subprocess, no script evaluation, and no DOM. It must not mint
identifiers, digests, or descriptors. The host owns all of that:

- `extractSourceRepresentation` joins segments with a single newline separator
  into the retained derivative buffer. Separator bytes belong to no span, so
  spans never overlap and every boundary lands on a code-point boundary.
- A segment longer than `sources.extractionMaxSpanBytes`, 16,384 bytes, becomes
  consecutive spans of at most that size, cut on code-point boundaries with no
  separator between them, so every byte of a long line or value stays in
  exactly one span. A `text` or `notebook-cell` locator narrows to each piece's
  bytes; any other locator keeps naming the unit the piece came from. The
  value is in the extraction limits the options digest covers. The span
  ceiling counts pieces, and both it and the derivative budget keep or drop a
  segment whole, so a kept prefix can never end inside a configured
  credential the screen would then judge only in part.
- The host computes the original digest, the derivative digest, the options
  digest, each `spanId`, the `representationId`, and the sealed descriptor.
- The host applies the finite budgets and adds the truncation limitations.
  Adapter-measured overflow, including PDF page overflow named as
  `sources.pdfMaxPages`, is merged into the sealed representation. Host
  truncation also persists the closed axis and the actual pre-truncation
  size so operator copy names the real observation instead of inventing
  bound plus one. The `docsfab run` footer projects those sealed overflows.

Register adapters with `createSourceExtractorRegistry`. Two adapters claiming
the same media type fail with `duplicate-adapter`. An adapter that emits a
locator kind it did not declare, or returns no readable segment, fails with
`adapter-invalid` or `empty-extraction`.

## Execution Model

Extraction is async-capable and in-process only.

`extract` can return the result directly or a promise of it. Both shapes run
through one path: the host awaits the adapter inside the same budget,
confinement, and identity wrapper. A synchronous adapter and a promise-returning
adapter that produce the same segments produce the same derivative bytes, the
same options digest, the same span identifiers, and the same representation
identifier. Returning a promise buys an adapter no additional capability. The
async shape exists because some packaged parsers, such as the PDF.js text API,
expose only a promise-based interface.

`extractSourceRepresentation` and `launchSourceParser` are therefore `async` and
must be awaited.

### Deadline

`limits.maxExtractionMs` is a wall-clock ceiling on one `extract` call. The
shipped default is 30,000 milliseconds. The host enforces it by racing the
adapter against a timer.

**Read this before relying on it.** The timer runs on this process's event loop,
so it can only fire when the loop is free. The deadline therefore bites at the
adapter's `await` points and nowhere else.

- An adapter that awaits, or that never resolves, loses the race. Extraction
  fails closed with `extraction-deadline-exceeded`, whatever the adapter had
  produced is discarded, and a result that arrives after the deadline is
  discarded too. The host never seals a partial parse as a complete
  representation, because a partial parse is not a source.
- An adapter that burns CPU synchronously **cannot be preempted**. It can
  overrun `maxExtractionMs` by an unbounded margin, and when it finally returns,
  its result is sealed normally. In-process extraction is not preemptible, and
  calling the deadline a race does not make it one.

What actually bounds a synchronous adapter is `maxOriginalBytes`, plus whatever
cooperative `await` points and `request.signal` checks the adapter chooses to
have. Real preemption needs the reserved `confined-subprocess` mode, which is
not implemented. A test in `test/source-evidence-intake.test.ts` measures a
CPU-bound overrun and asserts the result is sealed anyway, so this limitation is
pinned rather than described.

There is no upper clamp on `maxExtractionMs`. A caller that owns a run budget
should pass the smaller of the two.

`launchSourceParser` reports a lost race through its own error type as
`deadline-exceeded`. Its `deadlineMs` argument only tightens
`limits.maxExtractionMs`; it never widens it. Its post-call elapsed check is the
only thing that notices a synchronous overrun, and it notices it after the fact.

A `maxExtractionMs` (or any other limit) that is not a finite positive number
fails closed with `invalid-limits`, which is a caller mistake and is kept
distinct from a document that genuinely ran long.

### Cancellation

The host builds one `AbortSignal` per extraction and passes it on the request.
It aborts when the caller cancels or when the deadline fires. The caller's own
signal is also raced, so a caller that gives up stops waiting immediately
instead of waiting out the deadline, and the refusal is
`extraction-cancelled` rather than `extraction-deadline-exceeded`.

An adapter that holds a releasable resource, such as a PDF.js document, should
release it from an abort listener. An adapter can also implement the optional
`abort(request)` hook, which the host calls at most once, with the same request
object, after the signal has already aborted, and only when the host stopped
waiting while the adapter was still running. An adapter that failed on its own
time is already finished and is not told to stop. The hook must be synchronous
and must not throw; a throwing hook cannot replace the refusal the host already
decided on.

Ignoring both mechanisms is legal from the seam's point of view, because the
host discards a late result either way. It is not free for the host: for a
synchronous adapter, observing `request.signal` is the only way the deadline can
be honored at all.

### Failure

An adapter that throws or rejects fails closed with `adapter-failed`. The
adapter's own error never reaches the caller in any form: it was built from
untrusted bytes and can quote them, so only the fixed code and the host's own
message text cross the boundary.

That holds even when the adapter throws a `SourceExtractionError` subclass with
a chosen code and a rewritten message, and it holds when the adapter throws a
`Proxy` built to impersonate a host refusal.

The host identifies its own deadline and cancellation refusals by **object
identity**: each one is created inside `source-extraction.ts` and recorded in a
module-private `WeakSet`, and the check is membership in that set. Nothing about
the thrown value's class, or any property on it, is consulted, and no property is
read until membership is established. A `Proxy` can answer any property, but it
cannot become a member of a `WeakSet` it was never added to, and wrapping a
genuine refusal produces a different object that is also not a member.

Two further rules keep that airtight. `WeakSet.prototype.has` is captured at
module evaluation, so patching `WeakSet.prototype` later cannot change the answer. And
every refusal code is validated against the fixed list before the error message
is built, so an unrecognized code becomes `adapter-failed` rather than being
interpolated into text a reader would see.

The net effect: an adapter can neither pick the host's refusal reason nor
smuggle document bytes out inside an error message.

An oversized original fails closed with `original-budget-exceeded` rather than
being truncated, because truncating it would break the original digest binding.
The refusal's message adds the catalog line for the bound: the refusal code
`sources-extraction-max-original-bytes-bound`, the bytes observed, the bound in
force, and the remediation (`SourceExtractionError.limitRefusal`). That text is
the host's own counts and catalog wording, never document bytes. A limit that is
not a finite positive number fails closed with `invalid-limits`.

## Default registry

`src/inputs/source-extractor-registry.ts` holds the registry a shipped host
uses. `createDefaultSourceExtractorRegistry` builds it from
`DEFAULT_SOURCE_EXTRACTOR_ADAPTERS`. Every shipped adapter is registered there,
each claiming its own media types and emitting its own locator kind. These are
the adapters with their own contract section:

| Adapter | Extensions | Media type | Locator kind | Contract |
| --- | --- | --- | --- | --- |
| `docsfab-html-text` | `.html`, `.htm`, `.xhtml` | `text/html`, `application/xhtml+xml` | `html-node` | this page |
| `docsfab-text-bytes` | `.js`, `.markdown`, `.md`, `.mdx`, `.toml`, `.ts`, `.txt` | `text/javascript`, `text/markdown`, `text/mdx` (DocsFab-specific MDX identifier), `application/toml`, `text/x-typescript`, `text/plain` | `text` | this page |
| `docsfab-docx-block` | `.docx` | `application/vnd.openxmlformats-officedocument.wordprocessingml.document` | `docx-block` | [DOCX evidence](./docx-evidence.md) |
| `docsfab-pdf-text` | `.pdf` | `application/pdf` | `pdf-page` | [PDF evidence](./pdf-evidence.md) |
| `docsfab-unified-diff` | `.diff`, `.patch` | `text/x-diff` (also claims `text/x-patch`) | `diff` | [Unified diff extraction](#unified-diff-extraction) |

No two registered adapters claim the same media type or the same locator kind,
so a span can never be contested and `createSourceExtractorRegistry` never has
to break a tie.

The text adapter returns Markdown and MDX as inert UTF-8 line text. It does not
render Markdown, compile MDX, resolve imports, or evaluate JSX. `text/mdx` is a
DocsFab source-admission identifier; this contract makes no standards or IANA
registration claim for it.

Each adapter reports what it could not cover through the closed
`SourceRepresentationLimitation` set, and any limitation at all makes the
representation `partial`, which the write gate treats as unread evidence:

| Adapter | Limitations it reports | For |
| --- | --- | --- |
| HTML | `active-content-excluded` | `script`, `style`, and other executable or presentational subtrees |
| | `hidden-content-excluded` | `hidden` and equivalently suppressed nodes |
| | `non-text-content-excluded` | media and other non-text nodes |
| | `unsupported-encoding` | bytes that are not decodable text |
| | `unsupported-structure` | a tag mismatch or an unclosed element |
| DOCX | `hidden-content-excluded` | `w:vanish` runs and `w:del`/moved-from revision text |
| | `non-text-content-excluded` | inline media (`w:drawing`, `w:pict`) |
| | `unsupported-encoding` | a main document part that is not UTF-8 |
| | `unsupported-structure` | `w:altChunk`, foreign namespaces, nested tables, content-control-wrapped blocks, and omitted stories (headers, footers, footnotes) |
| PDF | `active-content-excluded` | an XFA form, or an AcroForm layer whose field values are not in the page text |
| | `non-text-content-excluded` | a page with no text layer, including image-only pages |
| | `unsupported-encoding` | a glyph PDF.js could not map, so the page is refused rather than quoted |
| | `unsupported-structure` | an encrypted, malformed, oversized, or cancelled document |
| | `span-budget-truncated` | a document past the page ceiling |
| Unified diff | `non-text-content-excluded` | the encoded payload of a Git binary patch, and a hunk body, file body, note, or message that is not UTF-8 |
| | `unsupported-encoding` | a file header line that is not UTF-8 |

`byte-budget-truncated` and `span-budget-truncated` also come from the host
itself, in `extractSourceRepresentation`, when a derivative or a span count
exceeds the configured budget. The PDF adapter may attach the same
`span-budget-truncated` flag with `sources.pdfMaxPages` overflow when a
document is longer than the bound page ceiling. The host keeps that axis
on the sealed representation rather than renaming it to
`sources.extractionMaxSpans`. The hashed extractor options include the
effective `maxPages` ceiling, so a permitted shrink changes extractor
identity. A malformed `maxPages` refuses with `invalid-limits` before
extraction starts.

Package-level DOCX faults are hard refusals rather than limitations: a
macro-enabled package, a missing or malformed `_rels/.rels` or
`[Content_Types].xml`, an external or absent main-document relationship, an
encrypted or ZIP64 archive, and an XML declaration of a DTD or an external
entity all produce `empty-extraction` from the seam, with
`diagnoseDocxPackage` naming the reason. Nothing partial is sealed.

Registering a fourth adapter is three edits and a dependency: one entry in
`DEFAULT_SOURCE_EXTRACTOR_ADAPTERS`, its extensions in
`SOURCE_MEDIA_TYPE_BY_EXTENSION`, the registry assertions in
`test/source-acquisition.test.ts`, and the pinned parser it is built on in
`package.json` and both lockfiles. An entry without its extensions is
registered but unreachable.

`classifySourceMediaType` maps a repository-relative path to a media type from
that fixed extension allowlist. There is no content sniffing: a path whose
extension is unlisted is refused rather than guessed at, so an adapter is never
handed bytes it did not claim.

The extension decides which adapter is offered the bytes; it never asserts what
the bytes are. A `.pdf` holding a DOCX package reaches the PDF adapter, which
refuses it on the bytes, and the acquisition fails closed with
`extractor-limitation` rather than falling through to whichever adapter could
have read it.

### Unified diff extraction

`src/inputs/adapters/diff.ts` exports `diffSourceExtractorAdapter`,
`DIFF_SOURCE_EXTRACTOR_ID` (`docsfab-unified-diff`), `DIFF_SOURCE_MEDIA_TYPE`
(`text/x-diff`), and `PATCH_SOURCE_MEDIA_TYPE`. It is the one `text/x-diff`
extractor: a producer that holds diff bytes, such as a change-source or a
merged-merge-request producer, passes it to `extractSourceRepresentation`
rather than defining its own. It needs no parser dependency.

It reads these shapes:

| Shape | How it is read |
| --- | --- |
| `git diff`, `git show`, `git log -p` | Text before the first `diff` line is a `preamble`, and each `commit <sha>` line opens another; each `diff --git` section is a file. |
| `git format-patch` patch or `--stdout` series | Each `From <sha>` mbox line opens a new `preamble` (the mail headers, message, and diffstat), and each `-- ` signature opens a `trailer`, so one patch's text never joins another's hunk. |
| `--no-prefix` diffs | `a/` and `b/` are removed only when both sides carry them. |
| `diff -u` and `diff -ruN` | A `diff -` line, or a `---` line followed by `+++`, opens a file; a trailing timestamp is dropped. |
| Git binary patch | The header span ends at `GIT binary patch`. The payload, `literal` and `delta` blocks each closed by a blank line, is in no span. |
| Combined `diff --cc` | One `file` span labeled `combined`; its `@@@` hunks are not addressed one by one. |

The derivative is laid out in this order:

1. A manifest: one summary row with the file, hunk, and added and removed line
   totals and the count of messages and trailers, then one row per file with
   its number, change kind, paths, line counts, hunk count, labels, and any text
   not extracted. Rows are packed whole into spans of at most
   `sources.extractionMaxSpanBytes`, so a window from byte 0 reads the manifest
   before any file. Each path in a row is one double-quoted token, escaped with
   the same `escapePathText` the original source authority uses for operator
   text, so a path cannot read as counts, labels, or a rename arrow. For a
   commit that edits two hunks of `src/export.ts`, renames `docs/old.md`, and
   adds a one-line `package-lock.json`, the manifest reads as follows;
   `test/source-evidence-diff.test.ts` checks this block against the adapter:

   ```text
   diff manifest: 3 files, 3 hunks, +3 -2 lines; 1 message
   file 1: modified "src/export.ts"; +2 -2; 2 hunks
   file 2: renamed "docs/old.md" -> "docs/new.md"; +0 -0; 0 hunks
   file 3: added "package-lock.json"; +1 -0; 1 hunk; labels: lockfile
   ```

   An unquoted `(path not carried)` or `(path not stated)` stands where no path
   is carried.
2. The original's own order: each `preamble`, each file's `header` and `hunk`
   spans, and each `trailer`. A file with no hunk, such as a rename, a mode
   change, or a binary file, is one `file` span.

Every span but the manifest is the exact slice of the original that its
locator's `startByte` and `endByte` name, line terminators and carriage returns
included, so a change to line endings stays visible. Only the span's final
newline is left to the host separator that follows it. These bytes are in no
span:

- the encoded payload of a Git binary patch;
- text that is not UTF-8: a hunk body, whose hunk keeps only its `@@` line, a
  file's body after its header, such as a combined diff's `@@@` text, a `note`
  after a hunk, such as a `diff -r` `Only in` line, and a message. A hunk ends
  at its `@@` line counts, so a note after it never costs the hunk its body;
- a run of empty lines outside any file, which holds no byte to cite and is not
  counted as a message. Whitespace-only text is a span.

The first two record `non-text-content-excluded`, the file is labeled `binary`
or `non-utf8`, and the manifest counts what was left out, so the source binds as
`partial` rather than refusing. A file's header is the leading run of lines Git,
GNU diff, and Subversion write there: `diff`, `index`, mode, similarity,
`rename` and `copy`, `---` and `+++`, `Binary files`, and `GIT binary patch`. A
header line that is not UTF-8 is framing the adapter cannot walk: it records
`unsupported-encoding`, which `--source` acquisition refuses with
`extractor-limitation`. A byte order mark at the start of the original is a
`preamble` of its own, so the line after it still opens a file.

The adapter reads a hunk body by the line counts in its `@@` header, so a
removed line whose text is `- ` (written `-- `) stays in its hunk rather than
reading as a signature. Lines after a hunk's counts that open nothing are the
file's `note` text. Paths come from `rename` and `copy` lines first, then the
`---` and `+++` markers, then `Binary files` lines, then the `diff --git` line,
with Git's quoted paths decoded. A quoted path whose bytes are not UTF-8, such
as Git's `"caf\351.md"` for a Latin-1 name, has no faithful text, so it is
carried as `null` and labeled `unrepresentable-path` rather than decoded with
replacement characters that could make two names one. Labels match a whole basename or directory
segment, never a substring: `lockfile` for a known lockfile name, `vendored` for
a `vendor`, `third_party`, `node_modules`, or similar directory, and `generated`
for a generated file name or directory, or for a generator marker such as
`Code generated ... DO NOT EDIT` or `@generated` in the file's first lines. These
lists are the adapter's own and do not share the task-scope or first-pass path
lists, which serve other purposes.

A span longer than `sources.extractionMaxSpanBytes` is split into pieces like
any other segment. Each piece keeps its file and hunk fields, and its
`startByte` and `endByte` narrow to the piece's own original bytes. Manifest
pieces stay without a range. Before it returns, the adapter counts the spans
its segments become. When the total would pass `sources.extractionMaxSpans`, it
reads the files that save the most spans as one `file` span each, until the
total fits. That changes how finely a file is addressed, not which bytes are
kept, and a file with text left out is never read whole. When even one span per
file does not fit, the host records `span-budget-truncated`, and `--source`
acquisition refuses with `input-over-limit` and the span ceiling's line.

Registering `.diff` and `.patch` also changes two callers that classify by the
shared extension allowlist. `scripts/run-mr-documentation-assessment.ts`, the
manual post-merge CI assessment job, now binds every changed `.diff` or `.patch`
file of the change set as an `update-documentation --source`. Every tracked
`.diff` and `.patch` in this repository binds `complete`, which
`test/source-evidence-diff.test.ts` checks. The live agent's `sources attach`
reports such a file's format as `text/x-diff`.

## Acquisition producer

`src/inputs/source-acquisition.ts` turns an explicit selection of tracked
repository files into a sealed `SourceBindingV1`. It is the only shipped
producer, and it records itself as `workspace-tracked-files`.

`acquireTrackedSourceBinding` takes the selection, the host-granted read scope,
the run and request identity, the host policy digest, and a
`TrackedSourceReaderV1`. That reader is the module's only input and output
seam: the producer never touches the filesystem and cannot reach a working
tree. Everything that decides identity is a pure function over bytes the reader
already returned.

For each selected path the producer checks the read scope, then tracking, then
the media type, then reads the exact revision bytes, then runs the adapter
through `extractSourceRepresentation`. Scope comes first, so a path outside the
grant is refused without asking the repository whether it exists.

The producer mints, per acquired file, a revision-independent origin identity, a
host-computed observation identity, a content-free acquisition receipt, a real
`repository-document` external-input registration, and the sealed
`SourceObservationV1` carrying the original digest, byte length, media type,
repository path, revision, and the derivative descriptor with its spans. It then
seals one `SourceBindingV1` over every acquired observation. Every selected
source is required, so before a write step writes it reads the spans of each
that no earlier step read, in windows when they do not all fit its read budget,
and the run reports a source it read only in part.

Refusals are specific and fail closed. There is no partial binding: one
unsound path refuses the whole acquisition, because a binding that silently
dropped a requested source would understate what the run was asked to consider.

| Reason code | Cause |
| --- | --- |
| `empty-selection` | No path was selected |
| `empty-read-scope` | No read scope was granted |
| `invalid-source-path` | The path is absolute, escapes the repository, or is otherwise unsafe |
| `duplicate-source-path` | The same path was selected twice |
| `path-outside-read-scope` | The path is outside the host-granted read scope |
| `path-not-tracked` | The path is not a tracked regular file at the selected revision |
| `unsupported-media-type` | The extension is unlisted, or no registered adapter claims its media type |
| `input-over-limit` | The original exceeded the byte ceiling, or the derivative was truncated |
| `extraction-timed-out` | The seam's wall-clock extraction budget fired before the adapter answered |
| `extraction-cancelled` | The caller cancelled while an extraction was still running |
| `extractor-limitation` | The extractor could not decode or walk the original, so the derivative is unsound |

The last three are all seam refusals, and they are deliberately not one code.
`extractor-limitation` is a statement about the operator's document: this
extractor could not read these bytes. A fired budget and a cancelled run are
statements about the host, and the same bytes under a larger budget may bind
perfectly, so reporting them as an extractor limitation told the operator
something untrue. Each refusal also carries the seam code it was translated
from on `SourceAcquisitionError.extractionCode`
(`extraction-deadline-exceeded`, `extraction-cancelled`,
`original-budget-exceeded`, `unsupported-media-type`), so the distinction
survives to the host without being re-derived from a stack trace. Both values
come from fixed enumerations, so neither can carry a document byte.

Fail-closed behaviour is identical for all of them: nothing is sealed, and one
refused path refuses the whole binding.

An `input-over-limit` refusal names the catalogued bound it hit
(`SourceAcquisitionError.limitRefusal`) in place of the generic remediation: the
limit's refusal code, the size observed (the file's bytes, or the size the
adapter produced before truncation), the bound in force, and the remediation,
which names the override for a ceiling a host can raise.

### CLI budget

`src/cli/run/source-acquisition.ts` acquires under
`cliSourceExtractionLimits()`, the catalog's extraction limits with their host
overrides, resolved when the run acquires rather than when the module loads, so
an override the configuration root's `.env` sets applies: a 30,000 ms
`maxExtractionMs` by default. There is no `docsfab run` flag for it. A host
embedding the runtime can tighten it through
`ResolveCliSourceEvidenceInput.limits`; that field is an embedding seam, not an
operator argument.

On `extraction-timed-out` and `extraction-cancelled` the CLI raises
`CliSourceAcquisitionError` in place of the producer's fixed-code message. It
names the budget that was actually enforced and the selected path, says nothing
was bound, and keeps the structured producer refusal on `.refusal` and as the
error `cause`. Every other refusal passes through with the producer's own
message, so the refusal vocabulary lives in one place.

`producerScopeSha256` digests the granted read scope, not the selection.
Widening the grant changes the binding; selecting fewer files does not.

## Parser launch and confinement

`launchSourceParser` runs an adapter under finite budgets and reports the
confinement it actually has.

- `in-process-inert` is the mode the HTML adapter uses. It is an ordinary call
  with no external capability, so it needs no sandbox. It is the only mode that
  runs, and it is the mode an async adapter runs in.
- `confined-subprocess` is **reserved and not implemented**. This module spawns
  no subprocess and enters no sandbox today. The mode always refuses: with
  `confinement-unavailable` when no successful probe is supplied, and with
  `subprocess-unimplemented` even when one is. Do not build an adapter that
  depends on it; a format needing an out-of-process parser needs a real confined
  launcher to land first. Making extraction async does not change this: an
  awaited adapter still runs in the host process, under the host's own event
  loop, with the host's own capabilities.

`probeSourceParserConfinement` does run the platform mechanism for real
(`bwrap` on Linux, `sandbox-exec` on macOS) and reports what happened, so the
host can record its actual capability. A successful probe proves the mechanism
exists; it does not make this module use it.

## Final coverage

`assembleSourceEvidenceFinal` derives coverage from what actually happened
rather than from a caller declaration. For each required observation:

| Status | Meaning |
| --- | --- |
| `considered` | Every span of one complete representation read, by any steps of the run |
| `partial` | Read in part, or read whole only in a partial representation |
| `unread` | Selected and required, but no step read it |
| `unavailable` | The producer could not acquire it |

A source some step read only part of is `partial`, never `considered`.
`sourceRequiredReadCoverage` returns the same status with the bytes of
extracted text the run read and the bytes a whole read charges, measured in the
representation read most completely, so a report and the gate agree.

For raw-bearing observations the final record also seals
`exactOriginalCoverage`: the raw view's `unread`, `partial`, `complete`, or
`unavailable` status, distinct original bytes read, original byte length,
actual serialized bytes charged, and remaining raw span IDs. Reading a
normalized derivative does not count as reading the original, even if its
offsets happen to match. Reading the complete raw view can satisfy aggregate
coverage while a partial derivative's limitation remains visible. A repeated
raw span adds another actual serialized charge but does not add original bytes
twice. The empty witness moves from unread to complete with zero original
bytes and a positive charge only after its access receipt exists.

`sourceEvidenceRequiredGapCodes` returns the `unread` and `unavailable` gaps
that block the affected write. `verifySourceSpanCitations` reports a citation
whose spans nobody read (`unread-span`), a citation attributed to another step
(`wrong-step`), a citation outside the sealed binding (`foreign-binding` or
`unknown-span`), and a material claim with no citation (`unsupported-claim`).

## Model-facing tools

`docsfab_list_sources` and `docsfab_read_source` are the only model-facing
surfaces. Both are registered in the confined tool set exactly when the host
handed that step a live `SourceStepReaderV1`, which happens only when the
installed locked skill appears in the effective `SourceStepPolicyV1`. Registry
presence, artifact presence, a workflow name, or a model request grant nothing.
They are named together in `SOURCE_TOOL_NAMES`, which is the single list the
confinement allowlist spreads, so neither can be granted without the other.

A step uses them in order. `docsfab_list_sources` takes optional `fromEntry`
and `maxEntries` for bounded inventory pages and returns
one row per source, a representation of an observation, with its handle, full
observation and representation ids, repository path, media type, span count,
and bytes, and then one row per span with its source's handle, span
identifier, byte range, and locator. A span row names its source by handle
only, so the long ids, path, and media type appear once per source rather
than once per span; on a 6-file change this keeps the listing near half the
size it would be with them repeated. It returns no source text, consumes no
read budget, and records no access observation, because nothing was
disclosed. It is the channel through which a model learns handles and span
identifiers: the reference carried on the step input is content-free, and the
reader refuses any identifier the host did not issue. Without it a model
could read no source on its own.

An original-view source row is explicitly labeled `exact-original-utf8` and
includes the host-authenticated `side`, repository ID, blob ID and original
SHA-256. The live custody verifies these labels against its private
side/repository/path/blob map before the listing is built. A hash, path, or
serialized side label is never a read grant. When any raw view is present,
the listing returns only the page's source rows and span rows and checks the
complete serialized content against the effective per-run tool output cap;
it refuses instead of silently clipping a page.

A handle is `s1`, `s2`, and so on, in the listing's order, which follows the
sealed binding, so every step of a run lists the same handles. It is host
bookkeeping: a model names a source with a few characters instead of copying
a 68-character id, and the host resolves the handle back to the sealed ids.
Every read result carries the handle beside the full ids, and citations,
access observations, and the run record keep the full sealed ids. Handles
never name a path, and a path never names a source.

`docsfab_read_source` then returns the bytes of one source. It names the
source by `source`, a handle, or by the full `observationId`, with
`representationId` required only when that observation has more than one
representation; a handle in `observationId` resolves too. Its parameter
schema accepts only those three, and either `spanIds`, a window, `fromByte`
with an optional `maxBytes`, or a diff file or hunk, described below, with
`additionalProperties: false`. `docsfab_cite_source` accepts the same
`source` handle in place of the two ids. A window, read through `readSourceWindow`,
returns whole spans from the span that holds `fromByte`, or the first after
it, each identifier beside its text, while they fit `maxBytes` and the step's
remaining budget; the tool defaults `maxBytes` to the per-call tool output cap.
It always returns at least one span the budget holds, and it reports
`nextFromByte`, the bytes read, the representation's total, and the budget
left, so a model can page through a source larger than one read across calls,
steps, and attempts, including spans past the listing's span rows.

An `exact-original-utf8` read returns separate `{spanId,startByte,endByte,text}`
fragments and the authenticated original identity. Parse the JSON result,
encode each `text` as UTF-8, and concatenate in offset order to recover the
Git blob exactly; JSON escape sequences are only transport syntax. A raw
window returns one whole sealed span and its next byte offset, or the 0..0
witness at `fromByte: 0`. It does not split or truncate a span when the current
cap is smaller than its escaped JSON content. The host screens the complete
original for configured credentials, then the final rendered result, before
recording any access. It charges the actual serialized content array,
including IDs, offsets, labels, escaping, budget display and framing, against
the shared step budget. A lower live tool cap can refuse an original admitted
under a larger cap, without resealing or recording a receipt. Automatic
write-step prefetch of an original-only required source preflights the entire
rendered prompt before any source read receipt. If its selected spans fit by
content bytes but their serialization crosses the step budget, the host replans
a smaller whole-span window against the measured framing cost. It records a
partial-read warning when that window leaves bytes unread, or refuses before
any receipt if even one span of an unread source cannot fit. Admitted reads
charge the measured raw-attributable serialization. Existing normalized results
and their extent-based accounting keep their historical bytes.

Every argument shape maps to exactly one selection or to a refusal whose
detail says what to change, because a model told only a code cannot ask again
any better. With no `spanIds`, `fromByte`, or `diffFile`, the read is a window
from byte 0. `maxBytes` also bounds a read by span ids: named spans that
together hold more refuse with their byte count, and none is dropped.
`spanIds` beside a `fromByte` after 0 refuses and names the three forms;
`spanIds` beside a `diffFile` and `diffHunk` that name a unit some of those
spans are not in refuses and says to send them as `null`; `diffHunk` without
`diffFile` refuses and asks for the file number. A handle or observation id
the listing did not issue refuses with `observation-unavailable` and the valid
handles (`s1 to s<n>`); a
representation id that is not one of the observation's refuses with the
handles of its representations; a span id the listing did not issue for that
source refuses with how many ids were unknown and where to take them from.
`source` beside ids of another source refuses and says to pass only `source`.

Structured tool calling leads many models to send every declared argument,
filling the ones a call does not use. The host sets such filler aside before
it resolves the call, so it never reads as a second selection. Each optional
argument is declared nullable, and its description says to send `null`, or
omit it, when unused. The unused values are, for every optional argument of
`docsfab_read_source` and the `source`, `observationId`, and
`representationId` of `docsfab_cite_source`:

- `null`, an empty string, or an empty list;
- `0` for `maxBytes`, which cannot read 0 bytes, and for `diffFile` and
  `diffHunk`, which count from 1;
- `0` for `fromByte` beside `spanIds` or `diffFile`, where 0 is the default
  start: a diff file or hunk read starts at its own first byte.

Beside a `source` handle, an `observationId` or `representationId` that is no
id or handle the listing issued is filler too, and the handle decides; one
that names another listed source still refuses. Beside `spanIds`, a `diffFile`
and `diffHunk` are set aside when every listed span named lies in the unit
they name, or when the source is not a diff, where they mean nothing. The
git history tools set aside `null`, an empty string, or an empty list the
same way, at the top level and inside `range`, so an unused `cursor` or
`range.from` sent as `""` is not resolved as a cursor or revision.

Every other service code has a fixed remediation in
`SOURCE_EVIDENCE_SERVICE_REMEDIATIONS`, used whenever a site gives none, so no
code reaches the model bare. The detail is host vocabulary only, never a
model-supplied value, a path, or a source byte. Neither tool
has a field for a path, a URL, a run identifier, a step identifier, or a
policy, so a model cannot name one. A refusal from either is reported as a safe
label carrying the service's own code, and records a `denied-path` failure
category rather than leaking a locator. A `budget-exhausted` refusal adds the
bytes the read needed and, when they pass the step's whole budget, the limit
that set it with its refusal code and remediation; otherwise it names the bytes
left and says to continue in a later step or attempt. A window past the last
span refuses with `span-unavailable` and names where the representation ends.

Each refused source or git history tool call also lands in the attempt's
`tools.toolRefusals`, content-free: the tool, the refusal code, a closed
`detailKind`, the declared argument names the call sent, a count of
undeclared ones, and for each id argument how it relates to the ids the host
issued (`exact`, `handle`, `path`, `unique-prefix`, `near-miss-same-length`,
`near-miss-other-length`, `other-kind`, `unknown`, or `malformed`). No id,
path, revision, or byte is recorded. Identical refusals collapse into one row
with a count, under `sources.toolRefusalRecordMaxRows`; a call that would
open a row past it is counted in `overflowCount`. Each argument a source or
history tool call sent as filler lands in `tools.toolArgumentFiller`, as a
count per tool, argument name, and kind (`null`, `empty`, `zero`,
`unissued-id`, `redundant`, or `inapplicable`), never the value. The
[run record contract](run-records.md) describes the fields.

For a representation with `diff` locators, the listing's row for it adds
`diffFiles`, the file count, and `docsfab_read_source` also accepts
`diffFile`, a file number from the manifest, with an optional `diffHunk`, in
place of `spanIds`. The tool finds that file's spans, or that hunk's, from the
locators in the listing and reads them as a window that ends where the file or
hunk ends: `readSourceWindow` takes an `endByte`, returns no span that ends
past it, and reports `nextFromByte` as `null` once it reaches it. A `fromByte`
with `diffFile` continues inside that file or hunk. The result,
`docsfab-source-diff-read`, carries `unit`, which is `hunk`, or `file` when the
file is one span or no hunk was named, and `unitBytes`. A file number, hunk
number, or offset outside the diff refuses with `span-unavailable`, and the
detail gives the file or hunk count or the unit's byte range, never a path. So
does a file or hunk whose text was not extracted; the detail points at its
manifest row.

The reader applies the confined tool result's credential screen to the text a
read returns before it charges the budget or records an access, so text the
screen would withhold never counts as read. The screen judges each run of
contiguous spans, the pieces of one split segment, as one text and withholds
every span of a run that holds a configured credential, so a credential that
crosses a cut is withheld as it was before the split. A read by span identifier
rejoins contiguous pieces with nothing between them and separate segments with
a newline, as in the derivative. Two pieces of one segment with unselected
pieces between them join with a host marker,
`[docsfab-source-gap: <n> bytes of this line not read]`, rather than a line
break the source does not have. A read by span identifier whose
text is withheld refuses with `credential-withheld`, which the tool raises as
the same credential-isolation boundary refusal the result screen gives. A
window skips each withheld span, lists it in `withheldSpanIds`, and charges
and records only the spans it returns; it refuses with `credential-withheld`
only when every span from `fromByte` on is withheld. The tool also passes the
reader a screen over the exact payload it will return, run before the read is
charged, so a payload the result screen would refuse never counts either. A
withheld span stays unread, so the write step plans it, its own read of it is
withheld too, and the source is reported as partial with the withheld bytes.

Both apply the same gate on every call: a superseded step capability, a missing
read grant, and a cancelled step all refuse, so a stale reader can neither read
nor enumerate a later step's sources.

Before a `write` step's first attempt, `planRequiredSourceReads` plans, from
the same read state that produces the coverage in the final evidence record, a
read of the spans of every required observation that no step of the run has
read: all of an `unread` one, and the rest of a `partial` one, in one
representation. When those spans fit the step's read budget, every required
source ends the read whole by content-byte accounting. For an exact-original
view, rendered prompt framing also counts: the host replans a smaller whole-span
window when that serialization would cross the same budget. When the selected
spans do not fit, the budget is shared out smallest need first, and each source
reads the window of its unread spans, in byte order, that fits its share, so a
large source is read in part rather than left unreachable. The step reader performs those reads, one span per read, so the
accesses are recorded against the write step, and the runner adds the text to
the step's prompt, each span beside its identifier, so the step can cite it. A
span the reader withholds is skipped. For each required source the run still
has only part of, the runner records a `source-read-partial` evidence warning
on the run record that names the source, the bytes read out of its total, and
any bytes withheld. When the budget cut the read short it records one more for
the step, naming the budget, the limit that set it, and the remediation. The
operator LIMITATIONS footer projects them. A path longer than
`sources.authorityMemberPathMaxChars` is shown by its tail with the
observation identifier, so each line stays within the 1,024 characters the
run-record readers admit per warning. The step stops with
`RequiredSourceUnreadError`, code `required-source-unread`, before anything is
read, only when an observation is `unavailable`, has no span, or is `unread`
and not one of its spans fits what is left of the budget.

## Citation coverage

A write step whose policy admits citation, and whose host wires the citation
join, also receives `docsfab_cite_source`. One call names one or a few
sentences and the spans that support them. `screenSourceSpanCitation` admits a
span only when some source-granted step of the run read it, and it mints one
sealed citation per supported claim digest. Citations belong to the citing
step: another step's citations never cover this step's claims.

After the step succeeds, the runner judges documentation only. It reads every
planned write path before the step and again after it, without following a
symbolic link, and `sourceDocumentationClaims` returns each sentence the step
added. A claim is a sentence with at least `sources.claimMinWords` words, 4 by
default, that no planned page held before the step. The cite tool and the
check segment text through the same function:

- Wrapped lines of one paragraph or list item join into one block, and a
  sentence keeps the line it starts on.
- A table row is one block.
- Front matter, fenced code, headings, tag-only lines such as `<Note>`, and
  admonition markers yield no sentence.
- Fences follow CommonMark: an opening fence is indented at most three columns
  inside its list item or the page, and a backtick fence's info string holds no
  backtick. A three-backtick line in indented code, or one that opens with an
  inline code span, is text, so it never hides the prose after it.
- A word is a token that holds a letter or a digit.

The writer's reply is never read for claims. `sourceDocumentationCitationCoverage`
splits the added claims by the step's own citations. The runner records the
step under `sourceCitations.steps[]` with every added claim digest, every
citation the step made, and, when any claim has no citation, `uncitedClaims`:
each uncited sentence's repository-relative `path`, 1-based `line`, and
`claimSha256`, never its text. The write is kept. `createWorkflowOutcome`
gives every product outcome the host-reserved `source-citation-gaps`
limitation, an `evidence-limitation` finding on the citing steps, exactly when
the record holds an uncited claim, on every path that builds an outcome,
including a CREATE that stops `needs-input` on source support. It replaces any
copy a model-authored outcome carries and drops one the record does not
support, without refusing the outcome. A `ready` candidate becomes
`inconclusive`.

The check still re-verifies every recorded citation with
`verifySourceSpanCitations`. It reads the same ledger as the screen that minted
the citations, so a diagnostic there is a DocsFab defect. The step then fails
with `SourceCitationLedgerError`, code `source-citation-ledger-contradiction`,
class `contract-shape`. A planned page it cannot read for a reason other than
its absence, such as a permission error, fails the step with
`SourceCitationPageReadError`, code `source-citation-page-unreadable`, class
`infrastructure`, naming the page and the error code. These are the check's
only stops.

## Reader and budget ceilings

Narrower existing ceilings win. The external-input projection still limits
prompt-visible excerpts to 240 characters, and run-record and log surfaces still
carry safe labels only. Catalog `sources.readResponseCeilingBytes` caps the
per-step read budget, 262,144 bytes by default; a host override,
`DOCSFAB_SOURCES_READ_RESPONSE_CEILING_BYTES`, can raise it to 67,108,864 bytes
or lower it. The CLI resolves the budget for the run's bound model with
`sourceReadBudgetForModel`: the ceiling, or `sources.readInputWindowShare` of
the model's input window after its context reserve, at the host estimator's 4
bytes per token, when that is smaller. Only a window DocsFab admits against
counts, by the rule `admittedInputWindowTokens` states for every budget sized
from a model's window, context packets included. An installed composition's
window counts whatever its profile metadata says. A model whose context
admission is the provider's, a profile that matches no installed composition and
whose metadata is unknown or stale, such as the placeholder `docsfab setup`
writes for an endpoint that matches no installed composition, and a run with no
bound model have no attested window and keep the ceiling. The
runner binding carries the resulting `readBudgetBasis`, so a partial read or a
stop names the limit that set the budget.
`createSourceStepPolicy` refuses a requested budget above that ceiling rather
than clamping it. A window read charges the same budget as
a read by span identifier. A retry restores the grant for that step,
less the bytes the host read into a write step's prompt: every attempt carries
that prompt, so `readSourceSpansForEveryAttempt` keeps those bytes charged.
Source text reaches a model only through a step reader, as a
`docsfab_read_source` result or as that host read.

## Knowledge consumption

`packages/knowledge/src/evidence-source.mjs` consumes these records as portable
data. Knowledge does not import runtime implementation, so it recomputes every
sealed record digest independently before trusting a field: the observation
digest, each representation descriptor digest, the binding digest, and the
derivative bytes against the sealed representation. A divergent identifier,
digest, or byte range fails there rather than becoming a plausible citation
later.

Knowledge does **not** recompute span identity. `spanId` binds the extractor
identity and options grammar, which lives in the runtime, and duplicating that
grammar in knowledge would create exactly the second implementation this
contract avoids. A span whose identity was forged is therefore caught by the
runtime decoder, not by knowledge; knowledge catches a forged span range through
the representation descriptor digest instead.
