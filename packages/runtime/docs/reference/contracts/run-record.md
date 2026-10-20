# Run record

Part of the [run records](run-records.md) family split (record family: run record).
Storage, indexing, provenance, recovery, and gap/readiness projections for the
raw `RunRecord`. See [run-records.md](run-records.md) for the schema overview and
[rejection accounting](run-records.md#review-response-admission).

## Private storage and sharing boundary

Raw run records are private operator state. They intentionally retain model
output, operator instructions, repository revision metadata, and selected host
paths, so they are not publishing artifacts even when they contain no detected
credential. DocsFab enforces one storage policy for ordinary CLI runs and the
MVP acceptance harness:

- the raw-record directory has owner-only `0700` permissions;
- every temporary and destination record file has owner-only `0600`
  permissions, including throughout atomic replacement;
- an existing permissive directory is tightened to `0700` only when DocsFab
  can verify that the invoking user owns it, and is rechecked before a record is
  written;
- symlinked roots, non-directory roots, unowned roots, unsafe record names, and
  permissions that remain broader than the policy are rejected before writing;
- platforms where owner-only effective permissions cannot be verified fail
  closed rather than claiming that mode bits provide protection.

Keep raw records and content-bearing patch artifacts in operator-controlled
storage. Share only an explicitly sanitized evaluation or acceptance manifest;
those manifests are the supported sharing boundary and contain digests and
minimized evidence rather than raw prompts, model text, repository content, or
host paths. A rejected attempt's redacted reply excerpt
([`rejectedReplyExcerpt`](run-records.md#review-response-admission)) is model
text too, so it stays in the raw record and never crosses that boundary.

## Run index

The run index (#1184) is a derived, append-only projection of run records for
counting failures across runs. Every CLI path that saves a run record builds its
store with `createIndexedFileRunStore`, whose `afterSave` hook indexes each save
with a terminal status (`succeeded`, `failed`, `needs-input`, or
`needs-human-decision`). That includes records that stop before any step, such
as a site-bootstrap preflight failure or a knowledge-continuation stop. A test
refuses any other saving `FileRunStore` under `src/cli/` and `src/application/`.
`docsfab runs import` adds terminal records from other state directories,
single record files, or local-workflows harness batches, and lists unfinished
records instead of indexing them.

- Location: `<dirname(state directory)>/run-index/runs.jsonl`, beside
  `artifacts/`, `patches/`, and the temporary `validation-candidates/` that
  publication preflight removes after each use, never inside the state
  directory. The directory is owner-only `0700` and the file `0600`, like the
  records.
- Row: `RunIndexRowV1` in
  [`src/records/run-index.ts`](../../../src/records/run-index.ts), with a closed
  `rowKind`: one `run` row per record (its `outcome` is the run status), one
  `attempt` row per recorded inference attempt, and one `step` row per started
  step that recorded no attempt. A step also gets one `step` row when its
  failure belongs to the step rather than to an attempt: the locked quality
  validator refused its artifact, or (since revision 8, #1738) the step ended
  `failed`, `needs-input`, or `needs-human-decision` after its final attempt
  succeeded. A `pending` step never ran and gets no row. `docsfab runs query` counts `attempt` rows
  unless the operator names another kind, so its default denominator is
  recorded attempts. A row copies identifiers, closed codes, digests, counts,
  and timings only: the run, step, and attempt identity; the attempt outcome;
  the failure class and layer; the rejection code and location; retry
  disposition; provider, model, API format, and profile digest; the attempt's
  model telemetry; the target repository revision; quality pack and skill
  digests; and the harness batch ID and case key when imported. It never
  copies model output, error messages, instructions, or credentials.
- Failure class (#1236): `failureClass` and `failureLayer` hold the
  [failure classification](failure-classification.md#failure-classification). A `run` or `step` row
  copies the record's own `failure`, read with its strict reader; a record or
  step without one reads `null`, and no class is derived for it. A `failure`
  outside the closed vocabulary is refused and both fields are listed in
  `omittedFields`. Attempts store no class, so an `attempt` row carries
  `classifyInferenceAttempt`'s reading of the attempt's closed fields, the
  same reading `RunResultV1.failures` reports; a succeeded attempt reads
  `null`. The failure category stays in `outcome`. A `docsfab runs query
  --where` value for `failureClass` or `failureLayer` outside its closed list
  is refused with `runs-query-invalid-arguments`, and the message points a
  category such as `malformed-response` to `outcome`. Since revision 8
  (#1738) every row also carries `failureCode` from the same source as its
  class, and refusing a recorded `failure` lists it in `omittedFields` too.
- Run end (#1738): a `run` row carries `terminalStepId`, the first step whose
  status is `failed`, `needs-input`, or `needs-human-decision`, on a run whose
  terminal status is not `succeeded`. It is `null` on a succeeded run and on a
  run that failed after all its steps. With `failureClass` and `failureCode`
  it says how the run ended; the code is the run's recorded cause, which can
  differ from the terminal step's own code. Every `docsfab runs query` groups
  these run rows in a `RUN ENDS` section (JSON `runEnds`) for the runs behind
  its population; with the defaulted row kind, that is every run with a row of
  any kind matching the other clauses, so a run without attempts is included.
- Plan conversion (#1739, revision 9): a `run` row carries `planConversion`,
  `create-target-exists` when the admitted CREATE plan binding of
  `plan-documentation` carries `createConvertedToUpdate`, otherwise `null`.
  Every other row kind reads `null`, and a stored non-run row that claims it
  decodes as `null`. `docsfab why` reports the same value as
  `RunDiagnosisV1.planConversion`. From revision 13 the value can also be
  `planner-proposed-update`, when the CREATE planner proposed the plan as an
  UPDATE of the page and plan admission admitted it as the same conversion.
- Answers asked early (#2026, revision 16): an `attempt` row carries
  `concludeNow`, the trigger of the attempt's `concludeNow` record
  (`read-loop`, `reading-budget`, or `attempt-deadline`), or `null` when the
  host did not ask. Every other row kind reads `null`.
- Readiness outcome (#2024, revision 17): a `readiness` run row carries the
  product `readinessDisposition` and `readinessReasonCodes`, a JSON array of
  criterion IDs paired with closed reason codes for unassessed criteria. The
  fields contain no model prose; other workflow rows read `null`.
- Read-loop counters (#1776, revision 11): an `attempt` row copies
  `tools.readEvidence` as `unchangedReReads`, `readLoopWithheld` (its
  `withheld`), `maxRepeatsOfOneResult`, and `maxUnchangedReReadsAcrossResults`.
  All four are `null` when the attempt recorded no snapshot, and on every other
  row kind. `maxUnchangedReReadsAcrossResults` is `null` on a record written
  before the cross-result bound; it is never derived from the other counters.
  Also in revision 11, `executionCeilingSource` on an `attempt`, `step`, or
  `run` row says what set the execution ceiling its `failureCode` names:
  `sealed-budget`, `host-limit`, or `operator-override`, or why it cannot
  say: `limits-not-recorded` or `codes-mismatch`. It is read from the stopped
  attempt's last governed turn and lease (a run row reads its terminal step's
  final attempt), the record's `compositionExecution.limits` (the run host's
  `configured.maxProviderTurns` and the smallest of the `candidate`,
  `composition`, and `package` budgets), and the limits catalog, never from the
  projecting process's limits, so the run store, `docsfab runs import`, and
  `docsfab why` read the same value. It is `null` for any other code.
- Answer path (#1707, revision 12): an `attempt` row copies the attempt's
  `answerSubmission` as `answerPath`, `answerPathReason`, `answerSubmission`,
  and `answerReportTurn`, the closed values the
  [step record](step-records.md) defines. All four are `null` on any other
  step, on a record indexed before revision 12, and on every other row kind; a
  malformed record is refused and named in `omittedFields`. The answer path is
  `text-final`, `tool-call`, or `answer-records`. The records path uses reason
  `record-ledger` and submission state `not-applicable`, because no singular
  submission call carries the answer. Its report is asked after the settled
  host ledger is complete. The `in-flight` byte counts stay in the record
  (`docsfab runs show`).
- Rejection subject (revision 13): an `attempt` row carries the attempt's
  `rejectionSubject` as `rejectedSourcePath`, or as `declaredChangedPaths` and
  `observedChangedPaths` (each a JSON array of plan write paths), or as
  `rejectionSubjectWithheld` (`not-host-known`, `over-bound`). Every field is
  `null` on other row kinds and when the attempt carries no subject; a subject
  the shared validator refuses lists all four in `omittedFields`. `docsfab why`
  reports them as `evidence.rejectionSubject` and in the finding's `what`.
- Member encoding (#1707, revision 14): an `attempt` row whose submission was
  admitted copies its `memberEncoding` as `answerMemberEncoding`,
  `<evaluation>/<qualityScore>` (for example `string/string`). It is `null`
  without an admitted submission, on a record indexed before revision 14, and
  on every other row kind.
- Request interpretation (#1825, revision 15): a `run` row reads the record's
  `requestIntent` through `decodeRunRecordRequestIntent`, which verifies the
  sealed intent against the record's `instruction`. `intentAdmission` is the
  admission outcome, with `unavailable` stored as `model-unavailable` so it
  never matches the query's null token, or `unverified` when the decoder
  raises `RequestIntentContractError`; any other error propagates.
  `intentOperation` and `intentTargetSource` (the one `chosenFrom` of the
  write-role targets, `mixed`, or `none`) are set only for an `admitted`
  outcome, never for an `advisory` reading. All three are `null` for a record
  without the field, on a record indexed before revision 15, and on every
  other row kind.
- Answer-record progress (#1971, revision 17): an `attempt` row copies the
  content-free progress summary only when the step and ledger checkpoint
  pointers agree on digest, sequence, and physical attempt, and the checkpoint
  sequence agrees with the summary. The row must be the physical attempt named
  by those pointers. The fields are admitted and released row counts, required
  ledger keys remaining, refusal events, direct ledger completion, checkpoint
  sequence, logical run ID, source run ID, and source attempt high-water.
  Refusal events count the logical step's ledger events and are distinct from
  currently released rows. Remaining keys come from the authoritative ledger;
  available record capacity does not imply future required work. The physical
  run ID and attempt identify which attempt committed the checkpoint; the
  logical/source IDs and high-water identify the lineage summarized by its
  counters. `complete` is the checkpoint's ledger state, not validation of the
  evaluator report. Missing or inconsistent evidence reads `unavailable` and
  appears in `omittedFields`; older projections remain unavailable. No row
  copies record contents or key names. The model-facing admission receipt's
  `complete` is stricter: the host sets it only after required rows are present,
  derivation is closed, and whole-artifact completion validation passes. It
  rechecks an unchanged record when it follows a completed ledger; open or
  refused whole-artifact results remain incomplete.
- Attempt output (#1738): an `attempt` row carries whole-attempt figures that
  the last-turn telemetry cannot show. `attemptOutputTokens` is `usage.output`.
  From the turn ledger, skipping turns the governor stopped before sending: a
  turn is cut when its `rawStopReason` normalizes to `length`
  (`normalizeModelFinishReason`), and a cut turn is continued when the next
  turn has the same `toolCalls` and `compactions` counts. `toolCalls` counts
  the tool calls in Pi's full transcript, which compaction does not shrink, so
  it rises after a cut tool call that Pi re-issues and stays level after the
  host's answer continuation. A rise reads as not continued whether or not a
  compaction fell between; a level count across a compaction reads as unknown.
  `continuations` counts continued cuts; the final answer is the last turn
  plus the continued cuts directly before it; `firstFinishReason` is `length`
  when that answer starts with a cut, otherwise `finishReason`; and
  `answerOutputTokens` sums its turns' `outputTokens` (which include
  discarded in-turn replay output). All three are `null` when an earlier turn
  has no `rawStopReason`, a counter is unreadable, or a level tool-call count
  crosses a compaction;
  `answerOutputTokens` is also `null` unless the answer's turns and the turn
  before it all carry `rawStopReason`, which excludes ledgers from before
  turns recorded production rather than the grant. A ledger that is not a
  list of objects is refused and the three fields are listed in
  `omittedFields`.
- Retry decision rule (#1738): an `attempt` row carries `retryDecisionRule`,
  `inferenceRetryDecisionToken` from `operator/retry-disposition.ts`, the same
  reading `docsfab runs show` prints, such as `declined-host-refusal`. Its
  `unavailable` reading is stored as `null`. A query value outside the closed
  list is refused.
- Attempt classifier (#1236): because an attempt class is a reading, not a
  record, each `attempt` row stores `attemptClassifierSha256`, the identity
  of the classifier that read it (`src/records/run-index-classifier.ts`).
  The identity hashes the classifier's own source: the running
  `operator/failure-classification` and `operator/retry-disposition` modules
  and every local module they reach through static value imports, read from the files the process loaded
  (`.ts` in a source checkout, `.js` in the installed package). It also folds
  in the classifier's class, layer, and code over a probe matrix of sample
  attempts.
  The source hash makes it complete by construction: any code change,
  including a class-table edit, a precedence swap, or reading a different
  turn, changes it without anyone editing the index. A reader whose identity
  differs reads that row's `failureClass`, `failureLayer`, `failureCode`, and
  `retryDecisionRule` as `null` rather than another classifier's reading, every
  query counts such rows on a `Stale classifier` line, and `docsfab runs import` re-indexes a
  record whose newest snapshot has such a row. `run` and `step` rows carry
  `null` here, because their classes are recorded. The trade-off is
  over-invalidation: a pure refactor, a comment, an unrelated table in those
  modules (including the generated limits mirror), or running the same
  revision from a source checkout and from the package gives a different
  identity, and the next import re-indexes every record with attempt rows.
  Re-importing is cheap (about 460 KB and 24 runs for one three-round
  matrix), so a stale class is never kept to save it. If the source files
  cannot be read, projecting a record with attempt rows fails rather than
  stamping an identity that could not change.
- Model telemetry (#1236): an `attempt` row copies its #1185
  `modelTelemetry`, described below, as `finishReason` (the normalized
  finish reason, never the raw provider token), `providerErrorClass`,
  `httpStatus`, `outputTokens`, `outputAllowance`, and `providerLatencyMs`.
  Telemetry that the shared validator `isInferenceAttemptModelTelemetry`
  refuses is not copied: all six fields are `null` and listed in
  `omittedFields`. `run` and `step` rows carry none of them.
- Rejections: `rejectionSource` names where `rejectionCode` and
  `rejectionLocation` came from. On an `attempt` row it is
  `inference-attempt`, the attempt's `rejection` pair. On a `step` row it is
  `quality-validation`, the step's `qualityValidationRejection` code and
  contract location, from any quality-path check (#1237); the issue count and
  validator text are not copied. An `attempt` row also carries `rejectedReplyParseCode`, how the strict
  parser read the reply its decoder rejected (`rejectedReplyShape.parse`):
  `parsed`, or the parser's refusal as `json-<detail>` when it named a syntax
  detail (for example `json-unexpected-end`) and `json-<code>` otherwise (for
  example `json-duplicate-key`). A parse code or syntax detail outside the parser's closed
  vocabulary is refused and listed in `omittedFields`. Since revision 4
  (#1343) an `attempt` row also copies the attempt's `hostPathDisclosure` as
  `hostPathRoot` and `hostPathInAdmittedSource`; a value outside the closed
  vocabularies is refused and both fields are listed in `omittedFields`. Only
  attempts that an older host refused with `host-path-disclosure` carry that
  value. No current step writes it, so both fields are `null` on every newer
  attempt row. Since revision 7 (#1690) an `attempt` row also carries
  `rejectedReplyExcerpt`, a closed flag and never the text: `retained` when
  the record keeps reply text for that attempt, `withheld` when the credential
  screen withheld every segment, and `empty` when the bound was `0` or the
  reply was empty. It is `null` when the attempt kept no excerpt. An excerpt
  the shared validator refuses is not described and is listed in
  `omittedFields`. Read the text with `docsfab runs show <run-id>`.
- Absence: a field the record does not carry is `null` and queries show it as
  `unavailable`. A present value longer than `runs.indexFieldMaxChars`, or one
  with control characters, is also `null`, and its field name is listed in
  `omittedFields`.
- Projection revision: each row records the `projectionRevision` that wrote
  it. A row written before a field existed reads as revision 1 with that field
  `null`, so rows indexed before #1230 have no `rejectedReplyParseCode` and no
  `quality-validation` step rows. Revision 3 (#1236) added the failure layer
  and the telemetry fields and changed what two columns hold: before it,
  `failureClass` held the attempt outcome and `finishReason` the raw provider
  token. A row an earlier revision wrote therefore reads both as `null`,
  rather than mixing two vocabularies in one group. `docsfab runs import`
  re-indexes a record whose newest snapshot an earlier revision wrote, even
  when its bytes are unchanged, so importing the same state directory or batch
  again fills them in. It leaves a snapshot that the same or a later revision
  wrote from the same bytes and labels unchanged, unless at the same revision
  its attempt classifier differs: a later revision comes from a newer DocsFab
  sharing the index, and re-indexing would drop its newer fields. A DocsFab
  from before revision 3 that reads an index a newer DocsFab also writes
  cannot tell the vocabularies apart: it groups the old and new meanings of
  `failureClass` and `finishReason` together. Upgrade every DocsFab that reads
  a shared index.
- Snapshots: every append writes all rows of one record snapshot, with one
  `snapshotId`, the snapshot's row count `snapshotRows`, and the record's
  `recordSha256`. Several processes can append to one index, for example two
  CLI runs that share a state directory, and there is no lock. So an append
  never truncates or rewrites the file, and it cannot remove rows another
  writer committed. Instead, a snapshot always starts on a new line, and a
  query drops any snapshot with rows missing and reports it as incomplete. A
  snapshot is counted whole or not at all. It is never counted partially. A
  query counts only each run's newest complete snapshot, so a re-saved or
  re-imported run is counted once. `docsfab runs import` also compares against
  complete snapshots, so importing the state directory again re-indexes a run
  whose snapshot was cut short or written by an earlier projection revision.
- Bounds: `runs.indexMaxBytes` bounds the file. An append that would cross it is
  refused whole, never truncated. The run store records the refusal, or any
  index write failure, in `run-index/overflow.json`, and every query reports
  it as incomplete. A record that saved but could not even record its overflow
  prints a `WARNING runs-index-io-failed` line directly to stderr. That line is
  not a Node process warning, so `NODE_NO_WARNINGS` cannot hide it. The index
  never fails the record it describes: `FileRunStore` also contains anything
  an `afterSave` hook throws and prints `WARNING run-store-after-save-failed`.

The records remain the source of truth. Every index-loss message and query
line names the same rebuild: move the `run-index/` directory aside, then run
`docsfab runs import <state directory> --index-dir <run-index directory>`.

## Provenance

- `repository.sourcePath` identifies the original repository.
- `repository.requestedRevision` records what the requester selected.
- `repository.revision` records the immutable commit that was exported.
- `workspace` records the isolation strategy without preserving its temporary
  filesystem path.
- `models` lists each provider and model used by successful steps.
- `skills` lists inspected governed skills before model execution. Each entry
  includes the canonical repository, revision, source path, version, license,
  explicit inputs and outputs, declared/granted/withheld tool policy, exact
  `SKILL.md` SHA-256, and deterministic bundle SHA-256. This provenance remains
  available when the later model request fails.
- Skills that are not yet imported into the governed lock retain the smaller
  identifier and `SKILL.md` hash shape until they are imported.
- `artifacts` contains only deduplicated input/output references: kind, schema
  version, artifact digest, repository revision, repository content digest,
  and the catalog step ID. Artifact payloads and local artifact paths remain
  outside run records. The runner rebuilds and validates this allowlisted shape,
  replaces any supplied step ID, and requires the reference revision to match
  the run's immutable repository revision. Full content-digest and artifact
  existence validation happens upstream against the structural index because a
  run request does not carry that index.
- `securityScan` records the advisory rule set, status, aggregate file counts,
  and findings. Each finding contains only a repository-relative path and stable
  rule ID—never the matched value or surrounding content. The whole-repository
  scan is advisory only (epic #91, task #110): repository secret enforcement is
  CI's responsibility and the scan never gates eligibility, writes, or
  publication.
- `securityScanEffectiveDisposition` records the advisory disposition. New runs
  are always `advisory` and carry no authority. The legacy statuses (`passed`,
  `blocked`, `failed`, `authorized`, `denied`) are retained only so historical
  schema-v2 records stay readable; the field remains optional for the same
  reason.
- `securityScanAuthorization` is legacy-only and is never written by new runs.
  When present on a historical record it records the exact immutable revision,
  credential rule, explicit review reason, expiry, covered-finding count,
  decision, and a stable rejection rule when denied. It grants no current
  authority.
- `steps[].contextPreflight` proves the per-step context gate outcome. Ready
  evidence includes only the packet digest, consulted node IDs, ontology
  version, effective decision IDs, byte/token/node/edge/path counts, latency,
  and revision-bound cache disposition. Context packet contents remain
  ephemeral and are never written to the run record. Blocked scans and skipped
  later steps receive an explicit unnecessary reason; degraded context is
  allowed only for a catalog-authorized read-only step. A packet over its
  input-window share records reason `preflight-budget-exceeded` with a `limit`
  in `tokens`: the catalog share, the token budget it gave the run's window,
  and the packet's estimated tokens before the trim. A trimmed packet keeps its
  digest; a packet that could not fit at all leaves a `degraded` step with no
  digest or node IDs, which only a read-only step may run with, and its
  `observed` value is the smallest packet, the first target alone. A
  `degraded` step whose packet does not bind every requested page names those
  pages in `unboundTargets`: distinct NFC repository-relative paths, with
  `#anchor` for a requested section, in code-unit order. Pages whose paths a
  record cannot hold, such as a path with a control character, are counted in
  `unboundTargetsOmitted` instead; neither field fails the step. A step the
  preflight left with no packet of its own for a coded cause records that
  reason with a `cause`: `content-index-refused` (the content index refused
  something in the checkout), `content-index-unreadable` (a file-system error
  while reading it), `context-compile-failed` (DocsFab's compiler refused its
  own input or threw), or `navigation-alias-refused` (a selected page is a
  symlink). `cause.code` is the content index code, compiler reason,
  file-system code, error name, or `selected-alias`; `cause.message` is one
  secret-free sentence of up to 512 characters that names the file when there
  is one, with every control, format, and separator code point written as
  `\u{...}`. The step is `degraded`: a read-only step runs without a packet,
  including a read-only step after a write step whose pages made the index
  refuse the checkout; a write step stops before its model call, a later one
  too; and hosted execution records the host capsule in place of the packet. A `cause` appears only beside one of these
  reasons on a `degraded` step, and such a step always carries one. A record
  written before causes existed can carry `navigation-alias-refused` as
  `failed`. A file the content index left out under its on-disk name, one an
  index path cannot hold or one that is the same as another once
  Unicode-normalized, is named in a `content-index-name-left-out` entry of the
  run's `evidenceWarnings`.
- Search-enabled steps persist four mutually bound projections. `searchEvidence`
  is the complete validated workflow-search envelope. `searchFindings` retains
  only requirement, target-policy, probe-coverage, disposition, confidence,
  limitation, and evidence identities. `negativeEvidence` is exactly the
  bounded-not-found subset; blocked or inconclusive searches never enter it.
  `gapLedger` groups observations by stable gap identity while retaining the
  exact repository revision, workspace snapshot digest, and coverage digest for
  every observation. Later search steps merge through prior ledgers instead of
  flattening every step's findings as one snapshot. The run
  record repeats the current observations of the merged ledger. Closed
  validators reject missing, substituted, contradictory, or orphaned links.
  These projections contain no questions, searched text, citations, tool
  arguments, credentials, or host paths.

## Recovery projection

For failed-run recovery and review inspection, the human `NEXT` section and
`RunResultV1.nextSteps` use the same selected action. The JSON array retains the
exact actionable command and its matching reason once each. A retained report
command preserves its state directory and port. A `runs show` fallback includes
the state directory derived from the actual record path, so replay does not
inspect unrelated default state.

An interrupted answer-record continuation can resume only when its saved
receipt and exact-checkpoint claim identify the same continuation child, the
claim belongs to this host, and the recorded owner process is confirmed exited.
The new child records that recovery basis; the original run remains unchanged,
including its running status and any unknown terminal usage. Missing or
ambiguous ownership evidence remains ineligible for continuation.
Within the child, retries continue from the latest checkpoint whose child-run
pointer was durably saved; until that save succeeds, the imported checkpoint
continues to be bound to its original source run.

## Answer-record correction feedback

When a generated answer record contains an undeclared property, its refusal
keeps the schema rejection code and location and asks for a complete replacement
with undeclared properties removed. Where the effective model-input schema
resolves that location, feedback lists the properties declared there, including
optional properties. Nested object and array-item locations use the same rule.
The list comes from the effective generated input shape, so host-owned and
host-derived fields are not offered as model inputs. Feedback never repeats the
rejected property name or value. Admission remains strict: DocsFab does not
silently remove fields, and previously accepted answer rows remain available
while the refused record is corrected.

## Documentation gap lifecycle

A ledger entry is `open` only when its current observation is validated
`not-found-after-bounded-search`. Sufficient positive evidence without an
earlier gap is `satisfied`; sufficient positive evidence after a negative
observation is `resolved` and adds a `found` reconciliation without deleting
the earlier observation. A positive match with incomplete required coverage or
a blocking limitation remains `inconclusive` or `blocked`, respectively.
Explicit, digest-bound attestations can advance that chain to `fixed` and then
`verified`. Replaying the same observation deduplicates by its canonical
identity, while changed coverage, workspace snapshots, or repository revisions
produce distinct history entries. Same gap, same Git revision, and same
snapshot with different evidence remains contradictory.

An open ledger entry can be projected into a content-free roadmap proposal.
Proposal creation must also receive the original authenticated workflow-search
envelope and match the selected current observation against it; a self-sealed
ledger alone is not roadmap authority. The proposal is always marked
`trackerMutation: not-authorized`: it is a unit for review and planning, not
permission to create or change an issue. The standalone proposal decoder checks
only the closed schema and self-checksum; it is deliberately non-authoritative.
Every persisted or downstream proposal must pass the source-aware validator,
which resolves the exact catalog workflow and step, decodes the search envelope
against that step's immutable search plan plus the independently expected
repository revision and repository-identity digest, and reconstructs the
proposal from that authenticated evidence and the exact ledger before requiring
canonical equality. Caller-supplied workflow labels and a self-consistent search
envelope are never proposal authority. CLI and scorecard rendering use only
closed states and shortened or validated
identities, so they cannot surface private repository paths or search content.

## Public release-documentation readiness

The separate `release-documentation-readiness` workflow adds a
`releaseDocumentationReadiness` product artifact only after the read-only run
and all execution governance succeeds. The artifact binds the independently
expected source path, immutable revision, default branch and repository
identity, workflow-search envelope, and documentation gap ledger. It classifies
each fixed release-documentation target as covered, missing,
needs-human-decision, inconclusive, or blocked.

The step persists a sibling `repositoryBatchAuthority` rather than placing #82
authority inside the #72 envelope. It contains the content-minimized inventory
v2, exact target-ordered request arrays, request-set digests, and exact result
and evidence mappings. Consumers independently reconstruct the catalog targets
and requests, replay structured profile and decision questions, and require
canonical equality. Replay validation additionally requires a non-persisted
host inventory capability privately bound to the exact immutable workspace;
the persisted inventory is compared in full against that independently
admitted value before replay. Profiles, decision facts, evidence IDs, and paths
therefore cannot be supplied solely by a rehashed record. Literal repository
text is not replay authority.

The artifact contains executable proposed work units with priority, rationale,
dependencies, acceptance criteria, verification, and declared human input. It
is explicitly marked `trackerMutation: not-authorized` and names #43/#46 only
as downstream consumers. Its checksum is an integrity aid, not authority:
consumers reconstruct the complete artifact from the exact authenticated run
before accepting it. The workflow-outcome projection independently reports
`execution=succeeded` with product `not-ready`, `ready`, `inconclusive`, or
`blocked`; execution, provider, scanner, tool, contract, or inventory failures
cannot be translated into `not-ready`.
