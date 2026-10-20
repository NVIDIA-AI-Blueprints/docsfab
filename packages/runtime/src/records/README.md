# Run records

This directory defines and persists DocsFab workflow run records. A `RunRecord`
is the scheduler's evolving account of one run: request and repository identity,
status, per-step results, model and skill evidence, usage, tool activity,
artifacts, changes, outcomes, warnings, and bounded failures.

Start with the [runtime source map](../README.md) for surrounding code. The
[run-record reference](../../docs/reference/contracts/run-records.md) describes
the operator-facing contract; the
[workflow-execution guide](../workflow-execution/README.md) explains how the
scheduler advances a record.

## Which state is which

| State | Owner and lifetime | Meaning |
| --- | --- | --- |
| Run record | `WorkflowRunner` and `FileRunStore`, for one workflow run | Mutable execution snapshot that becomes terminal evidence |
| Typed artifact | `DurableArtifactStore`, shared by digest | Immutable content-addressed semantic output referenced by runs |
| SCM delivery receipt | Delivery receipt store, for one publication attempt | Resumable progress through validation and Git/GitLab effects |
| Local live-agent transcript | Pi `SessionManager`, external to the run store | Persistent local conversation for a repository path |
| Hosted live-agent state | Host-retained `LiveAgentSessionStateV1` | Bounded, verified exchange window passed to each hosted turn |

The conversation forms are described in the
[`live-agent` guide](../live-agent/README.md), and delivery receipts in the
[`delivery` guide](../delivery/README.md). None of these stores substitutes for
another: a transcript is not workflow evidence, a run is not an artifact body,
and a receipt is not proof of current remote state.

## FileRunStore behavior

[`contracts.ts`](contracts.ts) contains the `RunRecord`, step, evidence, usage,
progress, and `RunStore` TypeScript contracts. [`file-store.ts`](file-store.ts)
implements the local JSON store under an owner-private directory.

The scheduler saves the same logical run repeatedly as it moves from queued to
running and through individual steps. A `FileRunStore` instance can atomically
advance a record leaf that the same instance first created. A fresh store
instance cannot overwrite that existing record. Run records are therefore not
universally immutable; mutation is restricted by per-instance ownership and
private-file checks.

Writes use a private temporary file and atomic filesystem operations while
rejecting unsafe IDs, links, owners, permissions, roots, and substituted
entries. Reads select one exact run ID rather than discovering a record by
directory order. `getWithDigest` returns parsed `unknown` data and the SHA-256
of the exact validated bytes.

That digest binds bytes; it does not make the parsed value a valid `RunRecord`.
Every consumer must still apply the decoder appropriate to its purpose. For
example, publication uses the successful-write decoder in
[`../delivery/run-record.ts`](../delivery/run-record.ts), while the saved-run CLI
uses [`../cli/commands/runs.ts`](../cli/commands/runs.ts).

A successful read-only review may cite a retained locator observation from its
selected `verify-technical-accuracy` step. The runner records only confined
file reads that actually delivered complete source lines to that step. It saves
the screened bytes and line hashes as an opaque content-addressed record, then
places its verified reference in the run. The strict review decoder checks the
reference; [`../review/locator-provenance.ts`](../review/locator-provenance.ts)
performs the later cold read and binds it to the run, reviewed change source,
result, and source blob. A missing or invalid observation leaves locators in the
review summary rather than proving an inline position. Run deletion retains a
shared observation until its last referring run is removed, and refuses a late
save that would revive a deleted reference.

## Artifacts and other record types

[`../artifacts/contracts.ts`](../artifacts/contracts.ts) defines the closed
typed artifact envelopes and references that can appear in a run.
[`../artifacts/store.ts`](../artifacts/store.ts) stores canonical objects by
SHA-256 digest. Existing content at a digest must match exactly, and reads
revalidate canonical form and the requested artifact contract. Opaque sealed
domain records can share the object pool through `putRecord` and `getRecord`,
but their callers still own decoding.

`host-progress.ts` defines the bounded progress projection used across the host
boundary. `knowledge-continuation.ts` and its store maintain their own resume
contracts. `composition-execution.ts`, `study-event.ts`, and `study-store.ts`
serve narrower evidence surfaces; they do not change `FileRunStore` ownership.

Host-side compare-and-set storage for dispatch or hosted session ownership is a
separate service boundary. Do not describe it as the local `FileRunStore`, and
do not infer its concurrency guarantees from this implementation.

## Reading saved runs

`docsfab runs list` summarizes available records without treating malformed or
unsupported entries as valid runs. `docsfab runs show <run-id>` loads one exact
record, decodes it, resolves referenced report or artifact evidence where
available, and renders either a human summary or structured output. Both are
read-only; replay does not rerun inference or establish that the checkout still
matches the saved revision.

The local live agent's `docsfab_read_run` is another bounded read-only decoder
for records belonging to the selected repository. It exposes historical status
and findings to the conversation, not raw trust in persisted JSON.

Live-agent checkout application is recorded separately from workflow execution
on the canonical run as the closed `checkoutPersistence` outcome. An absent
field on a legacy record means unknown, never applied. A failed outcome makes
the overall status in saved-run show/list and `docsfab_read_run` failed while
the workflow status and step evidence remain intact. `FileRunStore` retains it
with an exact-digest, maintenance-gated update; a stale or failed update cannot
claim the outcome was saved. Publication still decodes the original workflow
and validates this extra field before reading the retained patch.

## Run index

[`run-index.ts`](run-index.ts) projects one record snapshot into flat,
content-free rows: one `run` row, one `attempt` row per recorded inference
attempt, and one `step` row per started step without attempts, with a
quality validation rejection, or that ended failed or waiting for input after
its final attempt succeeded. The `run` row also names how the run ended
(`terminalStepId`, `failureCode`) and whether the host converted a CREATE plan
into an UPDATE of an existing page (`planConversion`).
[`run-index-store.ts`](run-index-store.ts) appends them to
`<dirname(state directory)>/run-index/runs.jsonl`, and
[`run-index-query.ts`](run-index-query.ts) filters and groups them. The CLI run
path builds every saving store with `createIndexedFileRunStore`, which wires
`createRunStoreIndexer` into `FileRunStore`'s `afterSave` hook, so a terminal
save writes the rows. Use that factory for any new CLI save path. Those rows
carry `docsfabRevision` from [`../build-identity.js`](../build-identity.js),
which `scripts/build-package.mjs` stamps in `dist/`; a source run reads null.
`docsfab runs import` and `docsfab runs query` live in
[`../cli/commands/runs-index.ts`](../cli/commands/runs-index.ts).
Index `runStatus`, `outcome`, terminal step, and failure classification describe
workflow execution. They do not project subsequent live checkout application;
inspect the saved run with `docsfab runs show <runId> --state-dir <path>` for that
outcome.

When evidence you add to a record should be countable across runs, add a
nullable field to `RunIndexRowV1` (or a new `rejectionSource` member) and to
`RUN_INDEX_QUERY_FIELDS`, default it in `decodeRunIndexRow`, and bump
`RUN_INDEX_PROJECTION_REVISION` so `docsfab runs import` re-projects records
an earlier projection indexed. Old rows read as `null` for it. The
[run-record reference](../../docs/reference/contracts/run-record.md#run-index)
describes bounds, snapshots, and overflow reporting.

## Adding a record field: readers before writers

Six closed key lists across the runtime reject unknown run-record keys, and the
tool-failure category is a closed enumeration in **six** more places:

| Closed list | Rejects |
| --- | --- |
| [`../delivery/run-record.ts`](../delivery/run-record.ts) `TOP_KEYS` | unknown run keys, at the publication gate |
| [`../scorecard-record.ts`](../scorecard-record.ts) (two lists) | unknown run keys, for the readiness workflows |
| [`../doc-improvement.ts`](../doc-improvement.ts) `runKeys` | unknown run keys, for review and update records |
| [`../quality-evaluation/corpus-live.ts`](../quality-evaluation/corpus-live.ts) | unknown run keys, for live corpus records |
| [`../native-compositions/pilot-runner.ts`](../native-compositions/pilot-runner.ts) | unknown run keys, for pilot records |
| [`contracts.ts`](contracts.ts) `EXECUTED_TOOL_FAILURE_CATEGORIES` / `TOOL_FAILURE_DISPOSITIONS` | the one source of the category set; the `ToolFailureCategory` type derives from it |
| [`../execution/inference-evidence.ts`](../execution/inference-evidence.ts) `decodeToolFailureCategories` | unknown values in a recorded summary (reads the source) |
| [`../workflow-contracts/outcome.ts`](../workflow-contracts/outcome.ts) `EXECUTED_TOOL_FAILURE_CATEGORIES` | unknown values in an outcome (re-exports the source) |
| [`../quality-evaluation/structural.ts`](../quality-evaluation/structural.ts) `toolFailureDispositions` | unknown values in structural quality evidence (reads the source) |
| [`../harness/confined-tools.ts`](../harness/confined-tools.ts) `safeFailureMessage` | **exhaustive switch** — a missing case fails typecheck |
| [`../harness/canon-tools.ts`](../harness/canon-tools.ts) `safeFailureMessage` | the second exhaustive switch; easy to miss, and an unhandled case there returns `undefined` at run time |

A record carrying a key or category those lists have never seen is refused
outright, so a host that upgraded its **writer** before its **readers** would
write records its own tooling cannot read back. Widen the readers first, in
their own change, and land the writer after: new readers accept old records,
and they accept new ones. Deployments with frozen per-core tooling must upgrade
the reader at or before the writer; the backward direction is always safe.

`sourceCitations` and the `citation-refused` failure category are the current
example. Both are accepted here and produced by nothing in this package yet;
[`source-citations.ts`](source-citations.ts) defines the shape and validates it
where the publication gate decodes, and states plainly that it checks shape
only — whether the coverage the evidence *describes* was achieved is decided
where it is produced, against a sealed source binding and the run's own access
ledger. A record cannot prove itself.

## Common changes

| Task | Source | Focused evidence |
| --- | --- | --- |
| Change run or step fields | [`contracts.ts`](contracts.ts) and producing scheduler code | [`runner.test.ts`](../../test/runner.test.ts), [`run-result.test.ts`](../../test/run-result.test.ts) |
| Add a run field or failure category | every closed list above, in a reader-first change | [`record-source-citations-readers.test.ts`](../../test/record-source-citations-readers.test.ts) |
| Change local record persistence | [`file-store.ts`](file-store.ts) | [`file-store.test.ts`](../../test/file-store.test.ts) |
| Change artifact types or storage | [`../artifacts/`](../artifacts/) | [`artifacts.test.ts`](../../test/artifacts.test.ts), [`artifact-store.test.ts`](../../test/artifact-store.test.ts) |
| Change saved-run CLI decoding | [`../cli/commands/runs.ts`](../cli/commands/runs.ts) | [`cli-runs-show.test.ts`](../../test/cli-runs-show.test.ts), [`cli-runs-list.test.ts`](../../test/cli-runs-list.test.ts) |
| Change live-agent saved-run projection | [`../live-agent/saved-run-tool.ts`](../live-agent/saved-run-tool.ts) | [`live-agent-saved-run.test.ts`](../../test/live-agent-saved-run.test.ts) |

When adding evidence, identify whether it belongs inline in the evolving run,
in an immutable artifact, or in a separate domain receipt before changing a
store or schema.
