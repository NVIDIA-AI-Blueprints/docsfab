# Step Records

Part of the [run records](run-records.md) family split (record family: step records).
Per-step execution evidence, required-skill availability, and bounded authoring
candidate accounting. See [run-records.md](run-records.md) for the schema overview.

## Execution Evidence

Renewable execution-lease boundaries have a separate content-free, digest-bound
record contract. It preserves cumulative limits and decisions without copying
the raw prompts, model text, tool arguments, results, or host paths described
below. See [`execution-leases.md`](execution-leases.md).

CREATE and REVIEW records preserve source-obligation derivation, provisional
technical comparison, and final technical correction as distinct steps. The
canonical ledger summary is immutable producer evidence. The host binds it to
the original scope, repository revision, producer observation, and exact
source-file digests. Later candidate edits do not replace that producer
identity. Consumers recheck the original source bytes and separately validate
the current candidate workspace.

During CREATE derivation, a reply may declare `sourceProposals` containing
repository-relative paths and short reasons. These declarations are untrusted
until the host checks the tracked regular-file metadata at the run revision,
rejects write targets, enforces the configured unique-addition limit, and
reseals authority from host-observed mode, length, and digest. The derive
step's `sourceProposalAdmissions` array preserves every attempt's model path
and reason beside the host disposition and refusal code. Replay requires each
authority member outside the original plan set to have an admitted receipt;
refused or model-claimed admissions do not add authority. The field is never
copied into the canonical ledger or later model prompts.
`docsfab why` also projects validated proposal outcomes by attempt, path,
admitted or refused status, and refusal code. It does not expose proposal
reasons; the saved run record and `docsfab runs show` retain the full receipts.
An unavailable or omitted index projection is reported as such rather than
treated as an empty receipt list.

The provisional technical result remains inspectable historical evidence. It
does not enter current finding projection, final evaluation input, report
output, or ordinary replay selection. The canonical final step stores the
existing three-field technical result (`review`, `coverage`, and
`factInventory`) in its summary. Its separate
`steps[].technicalCorrectionEvidence` uses kind
`docsfab-technical-correction-evidence`. Current fixed-phase workflows use a
version 2 source-obligation ledger and emit correction evidence schema version
3. The derivation step retains one complete, host-only
`originalSourceAuthority` member array, bounded by the existing 100,000-entry
and 2 GiB workspace materialization limits. Its compact descriptor is embedded
in the version 2 ledger; the complete member array is not copied to later steps
or model prompts.

A version 2 ledger that an older host sealed can carry
`repositoryPathTokenSha256`: the sorted, distinct SHA-256 digests of absolute
host-root path tokens that the ledger quoted from a cited repository source.
That host used the list to admit those tokens past its `host-path-disclosure`
screen. No current binding writes the field, and no current step screens a
ledger, judgment, verification result, correction evidence, or revision
accounting for host paths. Record readers still accept the field and refuse a
list that is not sorted, distinct SHA-256 digests. The ledger digest covers
the field, so a ledger that carries it keeps its bytes and digest.

Version 3 correction evidence contains exactly `kind`, `schemaVersion`,
`sourceObligationLedgerSha256`, `verificationResultSha256`, `proposal`,
`proposalSha256`, `originalSourceAuthoritySha256`, `sourceChecks`, and `digest`.
The nested proposal is the complete admitted, untrusted model response. It has
the explicit `docsfab-technical-correction-proposal` kind, schema version 3,
and exactly `kind`, `schemaVersion`, `verdict`, `coverage`, `factInventory`,
`issueJudgments`, and `obligationAccounting`.

Each issue judgment contains only `id`, `severity`, `category`, `location`, and
`factIds`. It references from one to 32 distinct non-documented facts, and the
proposal contains at most 256 judgments. Each normalized judgment location must
name an authoritative review target path. Fact and judgment links must agree in
both directions. A documented fact remains unlinked inventory context.

The host derives the unchanged final `VerificationResult` from this proposal.
It orders judgments and facts deterministically, copies each linked fact's exact
statement and uncertainty into fixed finding and minimum-action sections, and
uses the host-bound revision plus the sorted locator union as evidence. The
fixed actions distinguish omitted facts, conflicts, unavailable policy
authority, and source-observed product defects. The host does not infer a
quantity, condition, consequence, named owner, approver, authority, or product
fix.

For a provisional judgment or V3 correction reply, the host records the
`human-review` verdict itself when the sealed ledger marks a dimension
`unverified`, the host demotes a dimension, or the reply marks a coverage entry
`unverified`. That evidence decides the verdict, and the model cannot fill an
unverified ledger dimension. The host only ever selects the more conservative
verdict. Any other verdict must still agree with the derived issues: `pass`
requires none, and `needs-revision` requires at least one admitted issue
judgment.

The host demotes an applicable ledger dimension (#1254) only when the judgment
rejects every one of its obligations and each rejection is substantive in form.
A substantive rejection carries `rejectionCode` `not-established-by-source` or
`contradicted-by-source`. It also carries `evidenceLocators`: a non-empty list
of distinct, specific repository-relative locators without a revision suffix.
Each locator's path is one of the sealed ledger's admitted source paths
(`identity.sources`). A rejection missing either field, or with a malformed or
unadmitted locator, cannot empty an applicable dimension, and the judgment is
refused as `inventory-dimension-facts`.

A well-formed all-reject is demoted only if it also passes three host checks.
Each failure is refused as `invalid-fact-inventory` and retried with its rule:

- `demotion-every-applicable-dimension` at `$.obligationJudgments`: the
  judgment would demote every applicable dimension. At least one must keep a
  retained or refined obligation.
- `demotion-evidence-unresolved` at `$.obligationJudgments[].evidenceLocators[]`:
  a cited locator is not a line (`path:N`) or line range (`path:N-M`) inside
  the admitted source. The host counts each sealed source's lines from its
  current bytes, bound to the sealed digest, and passes those counts only to
  the judgment steps (`admittedSourceLineCounts`). Without them, or when they
  do not describe exactly the sealed sources, a demotion is refused as
  `source-authority`, which is not retried.
- `demotion-evidence-single-line` at `$.obligationJudgments[].evidenceLocators`:
  the dimension's rejections together cite fewer than two distinct source
  lines. `path:1` and `path:1-1` are one line, and a range of two or more
  lines counts as two.

The derived fact inventory records the demotion as that dimension with
`status` `unverified`, `facts` `[]`, and `sourceLocators` set to the sorted
union of the cited evidence locators. Its `reason` is this host sentence, where
only the dimension and the sorted closed rejection codes vary:

```text
Host demotion all-obligations-rejected-with-evidence: every obligation of the applicable ledger dimension <dimension> was rejected with admitted source evidence (rejection codes: <codes>), so no source-verified fact remains for it and human review is required.
```

The same reason is added to `factInventory.limitations`. Each rejected
obligation of a demoted dimension gets one host limitation with its own code
and resolved evidence:

```text
Host demotion evidence for rejected source obligation <OBL-ID> (<dimension>): <rejectionCode> at <locator>; <locator>.
```

It replaces the generic `Rejected source obligation <OBL-ID>: <reason> Source
locators: <locators>` entry that every other rejected obligation gets, so each
rejected obligation has exactly one limitation. Neither the demotion reason nor
the evidence limitation carries model prose. The V3 correction evidence retains
the same inventory in its proposal, and its accounting rows keep each
rejection's reason and ledger locators. Its source checks cover the evidence
locators' paths. Review findings report the dimension as
`review-findings-fact-inventory-unverified:<dimension>:<reason>`, and each
per-obligation limitation as a `review-findings-fact-inventory-limitation`.
These checks establish form, existence, and spread, not meaning. Every demotion
still requires `human-review`.

Three bounds apply, each refused by name with the observed value and the
remediation:

- `technicalCorrection.maxDemotionEvidenceLocators` bounds the evidence
  locators on one rejection and across one dimension. It is refused as
  `bounds-exceeded` and retried, because a rejection can cite fewer lines.
- `technicalCorrection.fieldMaxChars` bounds one evidence limitation. It is
  refused as `bounds-exceeded` and retried, for the same reason.
- `factInventory.maxLimitations` bounds all the limitations of one fact
  inventory: the ledger's own, each demotion reason, and one per rejected
  obligation. The host counts the final total before admission. An overflow is
  refused as `bounds-exceeded` with the reason
  `fact-inventory-limitations-exceeded` at `$.obligationJudgments`, and it is
  not retried. Only rejecting fewer obligations could fit, and that means
  retaining obligations the source does not establish. The remediation is to
  raise the limit, up to 256, or to narrow the run. The same limit bounds the
  ledger's own limitations and a model-authored verification result.

The proposal, complete correction evidence, and derived result have separate
sealed canonical JSON UTF-8 ceilings: `technicalCorrection.proposalMaxBytes`
(262,144 bytes), `technicalCorrection.evidenceMaxBytes` (524,288 bytes), and
`technicalCorrection.derivedResultMaxBytes` (786,432 bytes). Overflow stops
admission without truncating or dropping facts, and the message names the
bound, the observed bytes, and the target page and source obligation counts.
When the host built the value, or the host-filled coverage for the scope alone
is over the bound, the attempt records the bound's own refusal code, such as
`technical-correction-proposal-max-bytes-bound`, and is not retried. Otherwise
it records `bounds-exceeded` and is retried when the model's own reply pushes
the value over the bound. A shorter reply can fit only when the complete record
fits. The first case can
refuse a scope that a reply terser than the host's own fallback would fit; the
scope must narrow instead.
A `review-documentation` run whose host-filled coverage alone exceeds
`technicalCorrection.proposalMaxBytes` is refused before its first step with
the same code as its run failure. After the source-obligation step seals a V2
ledger, the runner also checks the smallest serialized all-host proposal core
across the cut, refused-reply, and continued-refusal reasons. If even that core
exceeds the proposal bound, the runner stops before step 3, records the named
bound with observed bytes and page and obligation counts, and retains the
canonical ledger in the failed step summary. Future event notes are absent from
this core. Passing its early check does not admit the later complete proposal;
the exact proposal byte check remains in place. Response admission failures keep the existing
public `malformed-response` category; this protocol adds no public result
schema. The evidence binds
the ledger, proposal, derived result, retained source authority,
and exact sorted `sourceChecks` set through separate digests. The checks cover
all typed final fact-inventory locators, including not-applicable dimension
evidence and unaccounted facts, plus refined or rejected accounting locators.
The host admits each path against the original membership before re-reading its
current bytes. CREATE membership is exactly the validated plan source set;
REVIEW membership is every regular, non-excluded file in the authenticated
tracked workspace snapshot. Symlinks, submodules, excluded entries, and
untracked files are never members.

Historical correction evidence schema versions 1 and 2 retain their exact
interpretation and remain readable through discriminator-selected cold paths.
They are not accepted from a current live canonical step. Unknown or mixed
versions fail closed, and readers do not choose a decoder by probing. Cold
version 3 validation recomputes the derived result and rejected-obligation
limitations from the retained proposal. It then requires exact canonical
equality with the retained summary and rechecks the proposal, result, evidence,
ledger, and source-authority bindings. Historical records are never rewritten.

A historical schema version 1 ledger retains its citation-subset
interpretation. Versions cannot be mixed.
A failed or pending derivation may retain the authority capture completed before
the provider call without claiming a ledger or correction; after a version 2
ledger exists, readers require the matching derivation authority evidence.

Missing or stale source evidence, scope or source drift, unsafe locators,
unknown or duplicate obligation IDs, incomplete accounting, malformed
responses, and unavailable schemas stop the affected run. The runtime does not
fall back to the provisional result or start an unrecorded correction attempt.

A refined accounting row must keep every replacement fact in the original
obligation dimension and source authority. A dimension mismatch is a terminal,
nonretryable malformed response. Its safe diagnostic names only the validated
obligation ID, final fact ID, expected dimension, and received dimension. The
candidate and provisional result remain inspectable history, but the run admits
no final technical correction. The record does not retain the rejected raw
response or start an unrecorded retry.

Run and step records include ISO timestamps and elapsed milliseconds. Token
usage is recorded per step and aggregated for the run. Tool activity contains
only tool names, success/failure counts, and closed failure-category counts.
The categories distinguish expected missing-file probes, denied paths,
unsupported patterns, recoverable misses (a call whose edit text, read offset,
or path kind did not match its target, refused before any change), local
governance stops, unknown tools, and internal tool defects. Only exact
host-granted tool names enter durable activity evidence;
every other provider-supplied name becomes the fixed `unknown-tool` bucket. A
`governance-stop` is attributed before residual failures are classified, so a
hard local tool cap is not mislabeled or double-counted. Arguments, results,
matched content, exception text, raw unknown names, and backing host paths are
omitted because they can contain repository content or secrets.

The change collector uses a temporary Git index outside the model workspace. It
detects additions, modifications, deletions, renames, and copies without adding
`.git` to the export. Changed-file evidence records only repository-relative
paths; rename and copy records include `previousPath`.
For CREATE write-scope checks, a copy changes only its destination; renames and
all other records continue to count `previousPath` as a changed path. A copied
destination is accepted only when the original source remains unchanged.

Every write-capable run persists a standard Git binary patch under the DocsFab
state directory before workspace cleanup. `changes.patch` records its format,
absolute artifact path, SHA-256 digest, byte size, and line count. This includes
an empty, digestible patch when a write-capable run makes no changes. Git binary
patches preserve binary additions and edits for review and application without
embedding their contents in the JSON record.

Patch artifacts are content-bearing and are created with owner-only file
permissions. The private-storage policy above applies to the state directory;
content-aware secret detection remains a separate prerequisite for arbitrary
repositories.

Patch persistence is part of write-run success, not optional telemetry. DocsFab
marks the run failed if it cannot save the patch or if a collector returns no
patch. Read-only evidence collection remains best-effort. In either case,
records use generic warnings rather than potentially sensitive collector errors.

The runner has one write-finalization boundary. Once a write step starts, every
exit attempts patch capture exactly once before the CLI can dispose of the
evidence collector or workspace. Modeled step failures return a failed record.
Infrastructure failures, including progress callback and run-store exceptions,
continue to reject the run, but only after patch capture and a best-effort save
of a sanitized failed record. The rejection states whether the patch survived;
it never repeats the underlying exception. A run-level success event is emitted
only after patch capture and the terminal record save complete.

Provider token usage is best-effort. `usage.cost` is absent when profile
metadata is unknown or stale, or when any input, output, cache-read, or
cache-write rate is unknown. A recorded zero therefore means a current profile
explicitly supplied every rate (which may all be zero); it never stands in for
unknown pricing. Pi's internal numeric fallback is not persisted.

Context-budget failures are local, terminal `context-exhausted` failures and
are distinct from retryable timeout, throttling, or provider-transient classes.
The classification is forcibly non-retryable even if a harness reports it
incorrectly. Their messages contain only closed reasons and numeric budget/count
fields, never prompt or tool-result content.

`steps[].inference` records DocsFab's bounded retry decision without provider
payloads. It includes configured and effective retry counts, capped backoff,
the closed retryable-category allowlist, and the replay mode: `read-only`,
`disabled-write-step` for a write-capable step, or `reset-write-step` for the
CREATE revision writer, whose host restores candidate 0 before it replays a
retryable malformed reply or a transport failure covered by its separate
transport budget (refer to [Bounded Authoring
Candidates](#bounded-authoring-candidates)).
Composition execution uses that same configured policy. A `disabled-write-step`
keeps `effectiveMaxRetries` at 0 for contract corrections; the separate
transport budget can still apply when the host proves no write tool executed.
Each attempt records a
closed outcome (`blank-response`, `malformed-response`, `timeout`,
`throttled`, `provider-transient`, or a terminal class), duration, whether
another attempt was scheduled, and the applied delay. Model identity, usage,
and tool totals are included when the harness can obtain them; usage and tools
from every attempt are aggregated into the step and run totals. Pi's own retry
layers remain disabled so these counts are authoritative. Refer to the
[host-owned retry rules](model-output-rules.md#retry-rules) for the decision
table, and to [execution compositions](../../../../../docs/reference/status-and-configuration/execution-compositions.md#installed-compositions)
for the configured transport retry budgets and defaults.

A record can also carry `transportRetry`, the step's separate transport budget:
`maxRetries`, `maxDelayMs`, `maxElapsedMs`, and the non-empty list of
`categories` it judged, drawn from `throttled` and `provider-transient`. An
attempt whose outcome is in that list never delivered an answer the contract
could judge, so it is counted against `transportRetry.maxRetries` and leaves
`effectiveMaxRetries` unspent. Readers number each attempt within its own
budget: its retry decision, its exponential wait, and the transport wall clock
(every earlier transport attempt's `durationMs` and `backoffMs`, plus its own)
are derived from that position. A transport attempt that the wall clock
refused is `exhausted` even when its count still had room. A record without
`transportRetry` was written before the budget existed, and every attempt in it
shares `effectiveMaxRetries`, as before.

Write-capable attempts can also record `writeSettlement`: `no-write` means the
host reconciled every tool batch and found no executed filesystem mutator;
`write-executed` means an `edit` or `write` call settled; `unavailable` means
the evidence was incomplete, inconsistent, or included an unrecognized tool.
A non-reset writer retries a transport failure only with `no-write`. Missing
settlement evidence is never proof. A `reset-write-step` instead restores its
workspace before retrying the transport failure.

Any attempt may record a timed ask (#2026). `concludeNow: {trigger:
"reading-budget", turn}` records that a review judgment step spent its
answer-now reading share, and `{trigger: "attempt-deadline", turn}` that a
read-only step was still calling tools once only its answer reserve remained
before the attempt timer. In both, the host withdrew the tools after that
governed turn and asked for the answer. Every later tool call is denied,
except that on the tool-call answer path the first `submit_quality_evaluation`
call of a turn still runs. The run summary and `docsfab runs show` count every
attempt that carries `concludeNow` under LIMITATIONS, and the `--json` run
result lists them as `answersAskedEarly`.

An attempt whose condition is `attempt-deadline` records `deadlineTurn`, where
the host's attempt timer found it: `awaiting-first-byte` (a provider request
had sent no first byte), `streaming-answer`, `streaming-tool-call`, `streaming`
(output with no answer text or tool call yet), or `between-requests` (no
request in flight, for example while tools ran). The failure classification
reads it: `awaiting-first-byte` is `attempt-deadline-awaiting-provider`, and
tools running or tool calls streaming after a `tool-use` turn is
`attempt-deadline-in-tool-loop`.

The class `no-progress` means the host ended the attempt because the
model kept re-reading content it already had (read-loop supervision). A record
whose `conditionRetry` carries `maxNoProgressRetries` treats it as retryable
under that budget (`retried-no-progress`); a record without it treats it as
terminal (`not-eligible`), as the release that introduced the stop wrote it.
The retry's attempt records `concludeNow: {trigger: "read-loop", turn}` when
the host withdrew the tools at its first notice-only re-read and asked for the
answer. Only an attempt whose correction came from a conclude-now rule may carry
the `read-loop` trigger, whether its forced answer was admitted or refused; a
transport retry in between re-sends that correction, so the attempt after it may carry it too.
After the ask every tool call is denied, and each denied call counts toward
`execution.readLoopWithheldReads`, so a retry whose model ignores the ask ends
`no-progress` with a read-loop code. Its attempt carries `rejection` with code
`execution-read-loop-withheld-reads-bound` (the notice-only re-reads of one
result) or `execution-read-loop-unchanged-re-reads-bound` (the notice-only
re-reads past the cross-result allowance, when those are more) and location
`$.tools`, and its last turn record is the tool turn after which the stop took
effect. No later turn counts that turn's calls. A `no-progress` attempt that
the host ended at the hard tool-call ceiling has the same last-turn shape and
records condition `tool-call-ceiling` instead of a rejection: its last turn is
not a governor stop, and its lease ended `hard-tool-call-ceiling` with
`budget-stopped` at the ceiling the last turn records. Readers refuse the
condition on any other shape. Its retry is `retried-tool-call-ceiling`, from
the same no-progress budget, with the same conclude-now ask. An attempt whose model
re-read unchanged content, or had calls denied after a conclude-now ask, also
carries `tools.readEvidence`, these counters and nothing else:

- `unchangedReReads` counts the read-class results that matched a result the
  same call already delivered in the attempt, each of which got a host notice.
- `withheld` counts those sent as the notice alone.
- `maxRepeatsOfOneResult` is the most re-reads of one unchanged result with no
  new progress call between.
- `maxUnchangedReReadsAcrossResults` is the most unchanged re-reads of all
  results together with no new progress call between, at least
  `maxRepeatsOfOneResult` and at most `unchangedReReads`. Records written
  before the cross-result bound lack it.
- `deniedAfterAsk`, present only when positive, counts the tool calls the host
  denied after it withdrew the tools on a conclude-now retry. Each spent the
  `execution.readLoopWithheldReads` allowance, so a stop's notice-only answers
  are this count plus the larger of the worst result's notice-only re-reads and
  the re-reads past `execution.readLoopUnchangedReReads`. These calls are
  also counted in `tools.failureCategories` as `governance-stop`, which bounds
  it.

The field is absent when nothing was re-read unchanged and no call was denied after an ask. It is per attempt only:
step and run tool totals do not sum it.

An attempt whose source or git history tool calls were refused carries
`tools.toolRefusals`: `rows`, at most `sources.toolRefusalRecordMaxRows` of
them in first-refusal order, and `overflowCount`, the refused calls that would
have opened a row past that bound. Calls that agree on every field collapse
into one row with a `count`. A row is content-free:

- `tool`: a source tool (`docsfab_list_sources`, `docsfab_read_source`,
  `docsfab_search_sources`, `docsfab_cite_source`) or a history tool.
- `code`: the host's refusal code, from a closed list: the source-evidence
  service, citation, discovery, and git history codes, `operational-limit`,
  and `tool-defect`.
- `detailKind`: what the refusal asked the model to change, from a closed
  list such as `argument-shape`, `unknown-source`, `unknown-representation`,
  `unknown-span`, `window-range`, `diff-unit`, `read-budget`, or `grant`.
- `argumentKeys`: the tool's declared argument names the call sent, sorted,
  nested ones dotted (`range.from`); `undeclaredArgumentCount` counts the
  others without naming them.
- `idMatches`: for each id argument sent, how its value relates to the ids the
  host issued, with a count per class: `exact`, `handle`, `path`,
  `unique-prefix`, `near-miss-same-length` (a mis-copied id),
  `near-miss-other-length` (a truncated or extended one), `other-kind` (an id
  of another kind, such as a representation id sent as the observation id),
  `unknown`, or `malformed`. For history tools the issued id is the run's
  pinned revision and its `head` alias. It is empty when the host could not
  list the sources at all; the code then says why.

No id, path, revision, or source byte the model sent or was shown is
recorded. A step's field merges its attempts' rows in attempt order under the
same bound, and the strict readers check it against the attempts and against
each tool's recorded failures.

`tools.toolArgumentFiller`: the arguments of source and git history tool calls
the host set aside as filler instead of reading them as a selection, such as an
unused `diffFile` sent as `null`. Each row holds `tool`, `argument` (a declared
argument name, nested ones dotted), `kind`, and `count`. `kind` is one of:

- `null`: the value was `null`.
- `empty`: an empty string or an empty list.
- `zero`: a `maxBytes`, `diffFile`, or `diffHunk` of 0, or a `fromByte` of 0
  beside `spanIds` or `diffFile`.
- `unissued-id`: beside a source handle, an `observationId` or
  `representationId` that is no id or handle the host issued.
- `redundant`: beside `spanIds`, a `diffFile` and `diffHunk` naming the unit
  those spans lie in.
- `inapplicable`: beside `spanIds`, a `diffFile` or `diffHunk` of a source
  that is not a diff.

Rows are sorted by tool, argument, and kind, and unique on them, so the closed
vocabularies bound them. No value is recorded. A step's field sums its
attempts' rows, and the strict readers check that no tool sets one argument
aside more often than it was called. The field is absent when no call sent
filler.

Every attempt of the final quality evaluator in `review-documentation` also
carries `answerSubmission` (#1707): how the answer reached the host, and on the
tool-call path how far it got. Other steps and older records lack it.

- `path` is `text-final` (the answer is one JSON object followed by the report
  Markdown), `tool-call` (the model calls `submit_quality_evaluation` with
  `evaluation` and `qualityScore`, then writes the report in a tool-free turn
  the host asks for), or `answer-records` (the model submits records to the
  host-admitted ledger, then writes the report after the ledger is complete).
- `reason` is `recorded-route` for `tool-call`. For `text-final` it is
  `not-recorded` (the bound route recorded no answer submission),
  `tool-not-granted` (a host tool ceiling withholds the submission tool), or
  `operator-override` (`DOCSFAB_ANSWER_SUBMISSION=text-final`). For
  `answer-records` it is `record-ledger`.
- `submission` is `absent`, `in-flight`, `admitted`, `refused`, or
  `not-decoded-at-ceiling`, or `not-applicable` for `answer-records`. The host
  decodes a submission from the raw
  argument text the serving stack forwarded, when its turn settles. A
  submission on the turn that reached the hard tool-call ceiling is never
  decoded, and the attempt records `tool-call-ceiling`. `in-flight` means the
  attempt ended while the submission's arguments were still arriving, and
  `submissionInFlightBytes` counts the bytes the host captured.
- `reportTurn` is `not-asked`, `in-flight`, `admitted`, `refused`, `clamped`
  (admitted, after cumulative output authority narrowed a report turn), or
  `authority-stopped`. `in-flight` means the attempt ended before the report
  turn settled, and `reportInFlightBytes` counts the report text captured.

- `memberEncoding` appears only with `submission: admitted`. It records how
  each member arrived: `evaluation` is `object` or `string`, and
  `qualityScore` is `object`, `null`, or `string`. A member that arrives as
  one JSON string holding its value is decoded exactly once, by the same
  strict parser, and must decode to what the member admits as a value.
  `submissionInnerBytes`, present exactly when a member is `string`, counts the
  decoded strings' UTF-8 bytes, for diagnosis; every byte bound applies to the
  raw argument bytes, which are never fewer.

A `text-final` attempt always records `submission: absent` and
`reportTurn: not-asked`. On the `tool-call` path, the host asks for a report
after an admitted submission. On the `answer-records` path, it asks after the
settled host ledger is complete. Each byte count appears exactly with its
`in-flight` state, and readers refuse other combinations. A refusal on the
tool-call path carries a `quality-submission-*` rejection code (refer to the
[quality-submission rules](model-output-rules.md)). On the tool-call path,
`answerBytes` counts the submission's argument bytes plus the report reply.

For the explicitly enabled experimental answer-record discovery policy, a
premature final-text turn with required records remaining starts recovery on
the OpenAI Chat Completions transport by sending `tool_choice: "required"` on
subsequent recovery requests. The host-provided remaining-key labels and record
schema continue to determine what the model may submit; the transport setting
does not admit records or change tool authority. Required choice remains active
through whole-artifact corrections, including D3 validation, until the host
reports validated report readiness for the settled ledger. Only then does the
existing report request use `tool_choice: "none"`. Other transports and
ordinary or version-1 execution do not receive this experimental override.

Before an answer-record ledger can report completion, the host assembles its
admitted technical inventory limitations and unverified-dimension reasons as
host-owned evaluation limitations, then checks the assembled findings against
the same admitted technical verification in records mode. If a not-documented
fact has no host-rendered finding record, the close call is refused with the
existing technical-trace code and the missing admitted fact IDs. Earlier
admitted rows remain available for correction; adding the required finding
records and closing again is still subject to the ordinary strict final
validation and technical-trace checks. The checkpoint remains the authority
for which rows were accepted before and after that refusal.

The records-mode final evaluator links retained facts through finding records'
`record.originating_ids`. Its prompt leaves admitted inventory limitations and
unverified-dimension reasons to the host, which preserves their exact text in
the final evaluation and report. Text-mode synthesis still copies those
limitations into `evaluation.limitations` and carries fact IDs in its structured
findings for technical-trace validation.

When a record passes its generated schema but violates a host-owned narrowing
rule, the refusal keeps the existing `answer-record-shape` code and identifies
the affected field, such as `$.record.confidence` or
`$.record.originating_ids`. Feedback gives a complete replacement instruction
and the host-approved values for that field. It does not copy rejected record
content into feedback. Target-path refusals keep their existing
`answer-record-target-path` code and location behavior.

For the v0.2 report and version-2 projection, limitation text has no per-item
character ceiling. Existing input, artifact, and storage capacity checks still
apply. Single-line limitations use ordinary Markdown rows. A limitation with a
line or control separator uses a closed JSON-string row beginning with
`- Limitation (JSON):`; the locked validator and runtime projection decode it
to the same exact text before comparing it with the structured summary.
Version-1 projection decoding retains its prior bounded-string behavior.

When the evaluator uses the host-admitted answer-record ledger, the step may
also carry `answerRecordLedger` and `answerRecordCheckpoint`. The ledger index
contains only record identities, digests, state, and attempt; sealed payloads
remain in the durable artifact store. The checkpoint pointer binds the latest
fully published checkpoint by digest and sequence and names the physical
attempt that committed it. Its progress summary is copied to the run index
only on that owning attempt row after pointer and sequence agreement. Counts
describe the ledger at that committed checkpoint: admitted rows, released
rows, required keys remaining, and refusal events. Refusal events count the
logical step's events, not released current rows. Required remaining keys come
from the authoritative ledger; open capacity is not inferred future work.
The summary also names its logical run, source run, source attempt high-water,
and direct ledger completion state. That state does not validate the evaluator
report or imply that the whole workflow succeeded. Missing, malformed, stale,
or mismatched checkpoint evidence remains unavailable; it is never presented
as zero progress.

A checkpoint's `complete` flag records that its planned slots were filled;
it does not validate the artifact as a whole or trigger the Markdown report
request. A failed evaluator can resume from a count-complete checkpoint, but
must still pass whole-artifact validation and submit its Markdown report. The
final report is admitted separately from record receipts.

A continuation can also resume a completed read-only evaluator when its run
retains a typed, model-correctable quality refusal and has no admitted quality
report. The host revalidates the restored complete ledger before requesting a
report. If a retained row needs repair, the host releases that row, retains the
refusal guidance, and publishes a new checkpoint after the continuation claim.
If host derivation still names an open planned layer, the checkpoint remains
repairable and the host gives the layer ID for a further layer-note record;
the report request stays closed.
An invalid checkpoint or non-correctable refusal does not authorize this path.
The final index retains the sealed checkpoint and progress even when report
validation declines the Markdown report.

Refusal counts account for refused attempts and enforce the configured
per-address refusal policy. Their keys are not answer-record addresses. An
unkeyed or unissued-key refusal for a declared open record type uses the legacy
`<type>\0\0new` counter key. Under matching bindings, that marker is accepted
only in refusal counters for a declared open type; it is never a valid row or
tombstone key. Checkpoint restore still verifies that ordinary open keys were
issued by the host, and unknown counter types do not create new refusal
buckets. Stale-binding checkpoints retain the prior opaque non-empty counter
address handling while their rows are discarded.

A record can also carry `conditionRetry`: the applied `maxTimeoutRetries`,
`maxCutAnswerRetries` and, on newer records, `maxNoProgressRetries`, each at
most `effectiveMaxRetries`. When it is present,
every attempt also records:

- `retryRule`: the catalog rule that made the attempt's retry decision, from
  `config/model-output/retry-policy.yaml` (see the
  [retry rules](model-output-rules.md#retry-rules)). `retryDecision` is the
  rule's own decision, and every record reader re-derives the rule from the
  attempts before it, so a swapped or missing rule is refused.
- `condition`, when the failure had one: `unframed-reply` (a prose, array, or
  empty reply to a JSON contract), `cut-answer` (an answer cut at the output
  limit with no continuation left, or completed by a continuation and then
  refused), `attempt-deadline` (the host's own attempt timer fired),
  `provider-timeout` (any other timeout), or `tool-call-ceiling` (a
  `no-progress` stop at the hard tool-call ceiling). Every `timeout` attempt
  names `attempt-deadline` or `provider-timeout`.
- `answerBytes`, on a succeeded attempt whose harness decoded a structured
  reply: the UTF-8 byte length of the reply span the step's decoder admitted,
  stitched across continuations.

A timeout retry and a cut-answer retry each spend their own small budget,
counted as retries of that condition already scheduled in the step and held
under `effectiveMaxRetries`. A record without `conditionRetry` was written
before rules were recorded; its attempts carry none of these fields, and the
operator derives their decision token from the other fields, as before.

An attempt separates whether its condition can be retried at all from what the
run's policy did about it. Those are different facts: "this condition cannot be
retried" belongs to the error, and "this run did not retry it" belongs to the
run.

Both fields were accepted by every decoder in this runtime one release before
anything wrote them, so a release reading records a newer host wrote already
tolerates the keys.

- `conditionRetryability` is the condition's own verdict, read from the closed
  retry taxonomy and nothing else. `eligible` means the category is one a retry
  policy is permitted to list; `not-eligible` means no policy may retry it,
  which covers context exhaustion, an invalid request, and every terminal
  provider class; `not-applicable` belongs to a succeeded attempt, which
  carries no failure condition. A deterministic response-size overflow is never
  `eligible`, whatever a harness reports for it.
- `retryDecision` is what the policy actually did. `retried` matches
  `retryScheduled`. `declined` means an eligible condition was not retried
  because the run's effective policy does not list the category, because the
  step was write-capable, or because the host refused that occurrence; retries
  may well have remained; a run whose effective budget is zero never opened a
  retry window, so it declines rather than exhausts. `exhausted` means an
  eligible and listed condition on an attempt strictly past the last retry a
  real budget allowed. `not-applicable` means there was no retryable condition
  to decide about.

On the one attempt where both could apply — a host refusal on the last attempt
the budget allowed — the budget wins and the record says `exhausted`, because no
further retry was possible whatever the host decided. `retryable` still carries
the host's own flag on that attempt, so a refusal remains distinguishable from a
condition the harness was willing to retry.

The existing `retryable` field keeps its meaning unchanged: it is the flag the
reporting harness raised with the error, and it can already carry a host
refusal. Read `conditionRetryability` for the condition and `retryDecision` for
the act; do not reconstruct either from `retryable` and `retryScheduled`.

Both fields are optional and are written together or not at all. Every record
written before this distinction existed carries neither, decodes unchanged, and
keeps its digests. Absence is an explicitly **unavailable** reading, never a
value: `readInferenceRetryDisposition` in
`src/records/inference-retry-disposition.ts` answers `unavailable` for both
fields rather than guessing one from the older pair, and a record carrying only
one of the two is rejected as malformed rather than half-read. Nothing here
changes retry policy, attempt counts, or the closed category set.

Four decoders hold a closed view of an attempt and all four accept the pair —
the scorecard record decoder, the workflow-outcome product validator, the
live-corpus decoder, and the fixed-governor compatibility migration. Where a
policy is available the pair is checked against it rather than taken on trust,
so a decision copied into the retryability field, or either value guessed, is
rejected instead of read as evidence.

A bounded in-turn replay may also be vetoed below the step policy without that
veto changing the condition. A stream that has already published content is
never replayed, because a second message behind half of a first one is
corruption rather than a retry; a request DocsFab itself refused never reached
the provider, so replaying it would be refused identically. Both stops leave
the classifier's category and `conditionRetryability` intact.

The governed turn that was refused names the boundary that refused it, in
`turns[].providerReplayVeto`. The closed vocabulary is `partial-stream`,
`local-denial`, `condition-not-retryable`, `attempts-exhausted`,
`step-physical-attempts-exhausted`, `blank-attempts-exhausted`,
`backoff-budget-exhausted`, `attempt-deadline` and `cancelled`, in the order the
replay applies them; the first stop that applies is the one recorded. The two
that lead are the two that are facts about this process rather than opinions
about a provider answer: a committed stream, and a request DocsFab itself
refused. A local denial is recorded as `local-denial` even when the classifier
would call the refusal text terminal, because the provider never answered and
there is no condition to classify. The field
is optional and is written only when a replay was actually refused, so a turn
that succeeded first time and a turn whose replay landed both stay identical to
the records written before it existed. It never appears on a turn that sealed no
final payload, because a turn that issued no request had no replay to refuse. A
value outside the vocabulary is rejected by the decoders rather than read as
though it were understood, and absence means "no replay was refused" — never a
value.

Two optional turn fields record what an installed request policy did to the
turn's outbound payload. Both are absent on a route without one.

- `turns[].replayedReasoningOmitted` counts the assistant messages whose
  replayed reasoning the policy left out of the payload `finalPayloadSha256`
  digests. Pi replays a reasoning delta a provider streamed as a top-level
  `reasoning_content`, `reasoning`, `reasoning_text`, or `reasoning_details`
  key on the assistant turn. A policy whose sealed `reasoningMode` is
  `disabled` omits exactly those keys from assistant messages; any other
  unlisted key is still refused. The count is a positive integer and is written
  only with both `requestPolicySha256` and `finalPayloadSha256`.
- `turns[].requestPolicyRefusal` names the policy's closed reason for refusing
  the turn's payload, from `src/model/request-policy-refusals.ts`. Only the
  attempt's last turn can carry it, because the refusal ends the attempt.
  Without `finalPayloadSha256` the policy refused before sealing, no request
  was sent, and the reason is never a send-gate one. With it, the reason is
  `payload-authority` (the turn ledger refused a replay before promoting it
  into `providerRetries`), `payload-send` (the send gate refused a promoted
  request before sending it), or `payload-resend` (the send gate refused a
  second transport call after the promoted request was sent). The attempt's failure classification reads this field before
  anything else and records the code `request-policy-<reason>`.

### Logical Turns and Physical Requests

Three things in a record are called an attempt and they are different numbers.
`steps[].inference.attempts[].attempt` is a STEP attempt, bounded by the
read-only retry policy. Each `turns[]` row is a LOGICAL governed turn, bounded
by `maxProviderTurns`. A PHYSICAL request is one call to the provider
transport, and one logical turn spends at least one — more whenever the bounded
in-turn replay fires.

The physical count is a projection, not a separate stored number: for a turn row
that sealed a `finalPayloadSha256`, it is `providerRetries + 1`.
`accountProviderAttempts` in `src/model/provider-attempt.ts` is the one place
that projection is written, and it is deliberately conservative. A row the
governor stopped is a known zero, because no request left the process. A row
that sealed no payload digest and names a `requestPolicyRefusal` is also a
known zero (`requestPolicyRefusedTurns`): the installed policy refused it
before sealing. On a sealed row that names `payload-send`, the refused request
is the last one `providerRetries` counts and was never sent, so the row
contributes `providerRetries` requests rather than `providerRetries + 1`. A
`payload-resend` row keeps `providerRetries + 1`: the promoted request was sent,
and only a second call for it was refused. Any other row
that sealed no payload digest, such as a record written before payload digests
existed, is counted as unaccounted rather than assumed to be zero, and the reading then reports
`coverage: "partial"` so the physical total is read as a floor. An attempt with
no readable turn ledger at all reads `unavailable`, the same discipline the
condition/decision pair uses.

`providerRetries` counts requests that reached the transport. A replay is
promoted into it by that replay's OWN payload finalization, which is the last
local gate before the request is sent; a replay the wrapper announced and a
local refusal then stopped inside finalization never reached the transport and
is not counted, on the transport-fault path and on the blank and nudged paths
alike. The send gate is the one local check after promotion; a row whose
`requestPolicyRefusal` is `payload-send` tells the projection to subtract the
promoted request it refused. The projection therefore cannot over-report.

The physical count across a whole step attempt is bounded on its own, by the
`providerAttempt.maxPhysicalRequestsPerStep` entry of `config/limits.yaml`:
12,288, the sealed 512-turn ceiling times the 24 requests a throttled turn may
spend, so no sealed composition reaches it. The per-turn bound governs one turn; without a step bound their product would be the
real ceiling and nothing would declare it. The bound is applied at both the
places a request can start. Inside a governed turn, a replay refused by it
records `step-physical-attempts-exhausted` on that turn's row. Before a governed
turn, the whole turn is refused ahead of the turn governor, so no request is
issued and no `turns[]` row is written at all — a row for a turn that issued
nothing would read as unaccounted, and a replay veto belongs only to a turn that
had a replay to refuse. That refusal reaches the record as the step's own local
stop, with `reason=step-physical-attempts-exhausted` and the spent count and
bound in its message.

`steps[].inference.attempts[].identity` binds every attempt to the repository
revision and, when selected, the context-packet digest and sorted consulted node
IDs. `turns[]` records every provider-boundary candidate, including local stops,
with numeric budget fields, provider/tool/compaction counts and limits, closed
`proceed`, `compact`, or `stop` decisions, and request/evidence digests. A
compaction entry additionally records before/after digests and token estimates,
removed/retained message counts, and the count/digest of preserved citations.
Raw prompts, tool arguments/results, repository content, credentials, cache
telemetry, timestamps, and host paths are not copied into this evidence.

Configured discovery workflows may also record `steps[].searchEvidence`.
This optional v1 envelope contains the plan ID/version and paired validated
bounded-search and progress evidence for every declared target. The evidence is
bound to the immutable repository revision and stable repository identity
digest. It contains target/probe identities, closed categories, counts,
digests, and repository-relative citations; it does not contain workflow
questions, matched content, tool arguments, credentials, or host paths.

The field is an additive migration. Historical schema-v2 records without it
remain valid. Current scorecard and publication decoders accept it only on a
catalog step that declares the exact plan and revalidate every nested #71/#72
contract. The field never changes `steps[].status` or the run-level execution
status; product disposition remains a separate
[`workflowOutcome`](workflow-outcomes.md) concern. New successful records seal
that versioned product envelope, while historical records without it decode as
`legacy-no-product-disposition` and gain no readiness authority.

The whole-repository credential scan is advisory only (epic #91, task #110). A
blocked or failed scan never ends the run: repository secret enforcement is CI's
responsibility, so scanner output has no eligibility, write, or publication
authority. Every new run records `securityScanEffectiveDisposition` as
`advisory` with no override authorization, and a non-passing scan only appends a
content-free advisory `evidenceWarnings` entry. Raw `securityScan.status`
remains immutable. Internal scanner exceptions are collapsed to the generic
`scanner.internal-failure` rule so exception text cannot leak content into the
record. Historical records that carry legacy effective dispositions or
`securityScanAuthorization` remain readable but grant no authority.

## Required Skill Availability

The runner uses structured harness state to decide whether a step's required
skill is available. It never searches the step summary for an availability
claim. When a configured resolver returns no evidence, the runner fails the
step before context preflight with a human-readable message, such as
`Required skill "<skill-id>" was not resolved (required-skill-unavailable).`
The persisted `steps[].error` string carries that closed code token for machine
consumers; the record does not serialize a separate error-code field. This
prevents a step from reaching the model or host while reporting that its work
succeeded.

Adapters can also expose the optional `inspectSkill` hook. If that hook returns
no skill evidence, the runner fails only a result that attempts to report
`succeeded`; `needs-input` and `needs-human-decision` remain valid unfinished
outcomes. A structured `result.skill` also counts as evidence when no resolver
provided it. Adapters without `inspectSkill` retain their legacy behavior.

Do not infer failure from prose such as “the skill is unavailable.” A review
summary can quote or correct that statement while successfully completing its
work. Only resolver or harness evidence controls this availability boundary.

The production CLI always injects the harness-neutral locked skill resolver.
The runner additionally refuses to start any of the four roadmap adapter IDs
when that resolver is absent or returns evidence without `roadmapPack`. It saves
governed identity before context preflight for both inference and
host-operation steps. Existing inference workflows retain their context-first
inspection order. A controlled context, model, or host
failure therefore retains `steps[].skillEvidence` and the deduplicated
run-level skill identity. Roadmap adapters add `roadmapPack`, containing only
the composite contract digest, upstream bundle identities, and adaptation
digests. Absolute local directories and imported contents are never persisted.
The decoder's explicit historical path continues to accept non-roadmap skill
evidence containing only `id` and `contentSha256`. It never promotes that
historical shape into roadmap authority: exactly the four roadmap adapter IDs
require `roadmapPack`, and every other ID forbids it. Integrity failure records
a closed sanitized failure instead of claiming a verified bundle identity.

## Bounded Authoring Candidates

A CREATE V3 run records `authoringExecution` with the exact workflow manifest,
original repository revision, original plan and write paths, selection evidence,
and admitted candidate identities. Candidate 0 is the initial draft. Candidate 1
exists only after the single revision passes source, scope, and patch retention
checks. The selected candidate points to the ordinary final patch against the
original repository revision.

Each authoring phase records its role and input, output, or assessed candidate
in `steps[].authoringPhase`. Readback validates the selected 9-step or 14-step
path and reconstructs the revision decision from the retained plan, search,
source ledger, and canonical technical and editorial reviews. Matching hashes
alone do not establish a valid decision.

Technical and editorial summaries remain exact canonical JSON with matching
digests. A path in a decoded review value is ordinary text and does not fail
admission.

Repository-native documentation checks are bound to the workspace and to one
exact phase identity. The initial candidate uses `lint-documentation`; a private
revision workspace issues a separate executor for `lint-revised-documentation`.
Neither executor accepts the other phase or another repository path.

A successful `revise-documentation` step also retains
`authoringRevisionAccounting`. It records an applied or rejected disposition,
reason, and admitted source locations for each selected issue, plus the changed
paths and unresolved facts. Failed or pending revisions cannot carry this
success evidence. The host also retains `authoringExecution.revisionAdmission`
when it admits candidate 1. This binding identifies both candidates and workspace
snapshots, the paths the host observed changing, and the complete accounting
digest. Readback checks the accounting against that retained host observation,
the original revision input, and the selected patch. An unchanged patch cannot
claim an applied correction.
The selected revised technical result and its correction evidence are validated
against the same original source ledger.

Each revision attempt is checked before candidate 1 is sealed (#1266). The host
decodes the attempt's accounting and compares its changed paths with the
planned pages that actually differ from candidate 0. A refusal fails the
attempt as `malformed-response` with its `rejection` code and contract
location, for example `revision-accounting-changed-path-mismatch` at
`$.changedPaths`. The model-output rule catalog
(`config/model-output/rules/revision-accounting.yaml`, #1130) declares every
revision-accounting code once, with its location, kind, retry disposition,
failure class, and the one statement the model sees. The
[model output rules reference](model-output-rules.md#revision-accounting) lists
them. `revision-accounting-unsafe-disclosure` (kind `disclosure`) and
`revision-accounting-source-locator-membership` (kind `authority`) are
terminal, and the generator refuses to declare either kind correctable. Every
other code is model-correctable. Before each retry, the host restores every planned page
in the revision workspace to candidate 0. It then walks the whole revision
workspace without following links, and refuses any entry that candidate 0 does
not have: a file, a symbolic link, a directory, or a `.git` entry. The revision
workspace is a tracked-file export, so nothing in it is exempt. Finally it
refuses unless the tracked snapshot equals candidate 0's again. The in-attempt
observation runs the same walk. The retry prompt states the code's catalog
statement, the same sentence the revision contract states, followed by the
`reset-write-step` statement from `config/model-output/retry-policy.yaml`.
Retries stay within `retry.maxRetries`, and the step records
`inference.replay: "reset-write-step"` with its configured budget. Only
`revise-documentation` may record that mode. It replays a retryable
`malformed-response` and transport failures covered by a separate transport
budget; every other write step keeps `disabled-write-step`.
Sealing candidate 1 repeats the mutation check against the sealed patches, so
no check is relaxed.

A failed revision step records `authoringRevisionRejection` with the same code
and location, whether its attempts ended on the refusal or the sealed check
refused it. A failed restore or observation stops the step as the host fault
`authoring-revision-reset-failed` or `authoring-revision-observation-failed`,
never as the model's reply. None of these fields retains the rejected reply.

A failed revision preserves candidate 0 and can retain a distinct
`candidate-1.partial.patch` artifact. That artifact is non-deliverable and cannot
become the selected candidate. A later review failure can preserve an already
admitted candidate 1 while reporting incomplete assessment. Current findings
refer to the selected candidate's producers; retained first-draft findings do
not substitute for missing revised-draft findings.

The records keep execution status, selected patch identity, and product
readiness separate. These fields grant no write, publish, tracker, or merge
authority. Historical workflows retain their original record contracts.
