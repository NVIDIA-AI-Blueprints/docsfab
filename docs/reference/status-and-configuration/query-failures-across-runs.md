---
title: DocsFab Run Index Reference
description: Look up DocsFab run index commands, row populations, supported fields, import behavior, and index limits.
status: draft
---

Use this reference to look up DocsFab run query options, field meanings, and index behavior. To follow a complete investigation from a question to a supported conclusion, start with [Investigate Saved Runs in DocsFab](../../workflows/investigate-saved-runs.md). For more information, refer to [DocsFab Status and Configuration Reference](index.md).

## Query Failures Across Runs

The run index supports local, read-only queries across saved run records. Querying does not call a model or modify a run record. `docsfab runs import` adds index rows only; it does not copy the records into the index or rerun them.

DocsFab appends a snapshot of content-free rows when a run reaches a terminal status. It writes one `run` row for each record, one `attempt` row per recorded inference attempt, and a `step` row for a started step that recorded no attempt or whose failure belongs to the step. A quality validator refusal can produce a failed `step` row even when every inference attempt succeeded. A step that never started has no row.

Rows hold identifiers, closed codes, digests, counts, and status data. They do not hold model output, error messages, instructions, or credentials. The saved run record remains the source of truth.

### Choose a Query Population

The default query population is `attempt` rows. Use `--where rowKind=run` for per-run counts or `--where rowKind=step` for step-level failures. Without an explicit row kind, `RUN ENDS` still reports how each run in the matching cohort ended.

The following table maps common questions to their population and grouping.

| Question | Population and grouping |
| --- | --- |
| How many runs ended in each status? | `--where rowKind=run --group-by runStatus` |
| What failure ended each selected run? | `--where rowKind=run --group-by runId,model,terminalStepId,failureClass,failureCode` |
| Which rejection repeats at a step? | Default attempt rows; filter `stepId`, group by `outcome,rejectionCode,rejectionLocation` |
| How did a quality validator refuse an artifact? | `--where rowKind=step --where rejectionSource=quality-validation --group-by stepId,rejectionCode,rejectionLocation` |
| Which attempts recovered on retry? | Default attempt rows; group by `runId,stepId,attempt,finalAttempt,outcome,retryDecisionRule`, then inspect `runStatus` |

The command supports repeated `--where` clauses and repeated or comma-separated `--group-by` fields. Repeated values for one field are alternatives. Different fields must all match.

```text
docsfab runs query [--where <field>=<value>]... [--since <date>] [--until <date>]
  [--group-by <field>[,<field>]...] [--state-dir <path> | --index-dir <path>] [--json]
docsfab runs import <path>... [--docsfab-revision <sha>]
  [--state-dir <path> | --index-dir <path>] [--json]
```

`docsfab runs query --help` and `docsfab runs import --help` print the installed command syntax and field list. Query accepts no positional argument. `--state-dir` selects a run state directory and its sibling index; `--index-dir` selects an index directly. Do not combine them on one command.

`--since` is inclusive and `--until` is exclusive. Both filter on run creation time. A `YYYY-MM-DD` value means midnight UTC; timestamps require an ISO 8601 time zone. The value `unavailable` matches a field the record did not carry.

### Read Population and Group Counts

The filtered rows form the population and denominator. Each group reports its row count, share of population rows, and distinct runs. With the default population, percentages are per attempt, not per run. One run with several attempts can contribute several rows to one or more groups.

The text output names the index path under `RUN INDEX QUERY`, then shows `Filters`, `Population`, the groups, and `RUN ENDS`. JSON output is the `docsfab-run-index-query` envelope. It contains these summaries and index health details, not the original run records or their outputs.

The query discards incomplete snapshots and keeps only each run's newest complete snapshot. Re-importing or resaving a run therefore does not double count it. Output reports superseded rows, incomplete snapshots, unreadable lines, stale classifier rows, omitted fields, or index overflow when present. An incomplete snapshot does not replace that run's previous complete snapshot.

### How Each Run Ended

Every query includes a `RUN ENDS` section. It groups the selected runs by workflow, model, run status, terminal step, failure class, and failure code. With the default attempt population, it includes every run that has any row matching the other filters, even a run with no attempt row. With an explicit `rowKind`, it includes the runs represented by the counted rows.

This illustrative output shows the formatter sections, not a measured result:

```text
RUN INDEX QUERY  /absolute/path/to/run-index/runs.jsonl
Filters: rowKind=run
Population: 1 rows across 1 runs
  1 rows (100.0%), 1 runs  runStatus=failed
RUN ENDS: 1 runs, from each run row
  1 runs  workflow=review-documentation model=fixture/model-a runStatus=failed terminalStepId=evaluate-document-quality failureClass=model-content failureCode=candidate-target-outside-scope
```

A `run` row's `terminalStepId` is the first step that ended failed or waiting for input. It is `unavailable` if the run succeeded or failed after all steps, such as during final delivery. The run's `failureCode` records the run-level cause and can differ from the terminal step's code. Older projections that lack run-end fields are called out; re-import their records to project those fields.

If no run matches, output says `RUN ENDS: none`. The query's fixed end fields are `workflow`, `model`, `runStatus`, `terminalStepId`, `failureClass`, and `failureCode`.

### Common Filter Patterns

These commands answer common lookup questions. Replace the step and model values with those in your records.

```bash
# Rejection codes for one step and model in a creation-time window.
docsfab runs query \
  --where stepId=verify-technical-accuracy \
  --where model=azure/openai/gpt-6-sol \
  --since 2026-09-23 \
  --group-by rejectionCode

# Count runs by model and DocsFab revision.
docsfab runs query \
  --where rowKind=run \
  --group-by model,docsfabRevision,runStatus

# Count step-level quality-validation refusals.
docsfab runs query \
  --where rowKind=step \
  --where rejectionSource=quality-validation \
  --group-by stepId,rejectionCode
```

Use run rows for job-level rates, attempt rows for inference behavior, and step rows for failures assigned to the step. `RUN ENDS` provides the run-level context alongside any population.

## Run Index Fields

The query can filter and group by 79 fields. This catalog groups them by the question they answer. Each group names applicable row kinds and distinguishes absent evidence from a recorded value. Run `docsfab runs query --help` for the authoritative current list.

### Run Identity and Scope

The following table lists the run identity and scope fields.

| Fields | Applies to | Meaning |
| --- | --- | --- |
| `rowKind` | All | Row type: `run`, `step`, or `attempt`. |
| `runId` | All | Saved run ID represented by the row. |
| `origin` | All | `run-store` for rows appended when DocsFab saved the run, or `import` for rows added by `docsfab runs import`. |
| `batchId`, `caseKey` | Imported harness rows | Harness batch and case identifiers from a `report.json` batch. |
| `docsfabRevision` | All | DocsFab build revision that wrote the record, or the revision declared during import. `-dirty` marks a changed checkout. Run records do not carry this value; imported records can therefore read `unavailable`. |
| `workflow`, `runStatus` | All | Workflow name and the record's run status. |
| `repositoryRevision` | All | Revision of the documentation repository targeted by the run. |
| `qualityPackManifestSha256` | All | Digest of the quality-pack manifest bound to the run. |
| `readinessDisposition`, `readinessReasonCodes` | Readiness run | Product disposition and a JSON array of closed criterion/reason-code pairs for unassessed criteria. The array contains no model prose. `docsfab why` reports these same admitted values. |

A run that used multiple models lists distinct provider, model, API format, or profile digest values in sorted order, joined by `+`, only when every model recorded that field. Query attempt rows by `model` to count runs that used a model at any step.

### Step, Attempt, and Failure

The following table lists the step, attempt, and failure fields.

| Fields | Applies to | Meaning |
| --- | --- | --- |
| `stepId`, `stepKind`, `stepStatus` | Step and attempt | Workflow step identity, kind, and recorded status. |
| `skillId`, `skillSha256` | Step and attempt | Skill identity and the bound skill digest. |
| `attempt`, `finalAttempt` | Attempt | Attempt number and whether it is the step's last recorded attempt. |
| `outcome` | All | Attempt outcome, step status when no attempt exists, or run status. An attempt's failure category remains here, for example `malformed-response`. |
| `failureClass`, `failureLayer`, `failureCode` | All | Failure classification and code. Run and step rows copy recorded failure data. Attempt rows derive classification from the attempt outcome, rejection, and finish reason. |
| `terminalStepId` | Run | First failed or waiting step for a run that did not succeed; otherwise unavailable. |
| `conditionRetryability`, `retryDecision`, `retryDecisionRule` | Attempt | Recorded retry condition and decision. `conditionRetryability` is `eligible`, `not-eligible`, or `not-applicable`; `retryDecision` is `retried`, `declined`, `exhausted`, or `not-applicable`. The rule identifies why a retry was accepted, exhausted, or declined. |

A successful final inference attempt does not imply that the step or run succeeded. A validator can refuse the artifact after the attempt succeeds, producing a step and run failure. `failureClass` and `failureLayer` accept closed values; the query refuses unknown values and names `outcome` as the filter for an attempt failure category.

An attempt outcome of `host-runtime-failure` identifies a host execution-lease
coordinator rejection, not a provider failure. Its typed origin is retained in
the run record; the attempt index reports `infrastructure` at the `inference`
layer with code `invalid-execution-lease-coordinator`.

`retryDecisionRule` readings include `retried`, `exhausted`, `declined-write-step`, `declined-reset-write-step`, `declined-terminal-policy`, `declined-no-allowance`, `declined-host-refusal`, `declined-unexplained`, and `not-applicable`, as well as rule IDs from the recorded retry catalog. The query refuses values outside that set. A declined retry can be unexplained by retained evidence; do not infer the nearest likely cause.

### Rejections and Withheld Subjects

The following table lists the rejection and withheld-subject fields.

| Fields | Applies to | Meaning |
| --- | --- | --- |
| `rejectionSource` | Step and attempt | `inference-attempt` for an attempt's rejection; `quality-validation` for a step's artifact validation refusal. |
| `rejectionCode`, `rejectionLocation` | Step and attempt | Rejection code and JSON or artifact location. |
| `rejectedReplyParseCode` | Attempt | `parsed` or a strict JSON parser refusal, such as `json-unexpected-end`. |
| `rejectedReplyExcerpt` | Attempt | `retained`, `withheld`, or `empty`: whether a rejected-reply excerpt was retained, withheld by credential screening, or empty. The field never contains reply text. |
| `rejectedSourcePath` | Attempt | Refused source-citation path only when the host could identify a plan write path or tracked file at the run revision. |
| `declaredChangedPaths`, `observedChangedPaths` | Attempt | Plan write paths declared by a refused revision writer and paths the host observed it change. Each value is a JSON array. |
| `rejectionSubjectWithheld` | Attempt | Why a rejection names no path, such as `not-host-known` or `over-bound`. |
| `hostPathRoot`, `hostPathInAdmittedSource` | Older attempt records | Limited readings of an older `host-path-disclosure` refusal. They never contain the refused path; current attempts leave them unavailable. |

`rejectedReplyParseCode` distinguishes a parse failure from a parsed reply rejected by another contract. `rejectedReplyExcerpt` describes retention only. Use `docsfab runs show` to inspect available, screened evidence. `rejectionSource` also distinguishes a quality validator refusal on a `step` row from successful inference attempts that produced the artifact.

The legacy host-path fields remain for historical rows. Current attempts do not generate `host-path-disclosure`, so these fields are unavailable on current attempts. `hostPathRoot` records only the matched path root or form, such as `private` or `file-uri`. `hostPathInAdmittedSource` records whether an admitted source included a matching path, or `unavailable` when no source was checked. No path is copied into these fields.

### Provider and Answer Usage

The following table lists the provider and answer usage fields.

| Fields | Applies to | Meaning |
| --- | --- | --- |
| `provider`, `model`, `apiFormat`, `modelProfileSha256` | Run, step, and attempt | Provider, model, API format, and model-profile digest. Step rows carry that step's model fields; run rows combine distinct values as described above. |
| `finishReason` | Attempt | How the last provider turn finished, such as `stop`, `length`, `tool-use`, `content-filter`, `error`, or `aborted`. |
| `providerErrorClass`, `httpStatus` | Attempt | Provider error class and HTTP status when an error response was received. |
| `outputTokens`, `outputAllowance`, `providerLatencyMs` | Attempt | Output tokens and allowance for the last landed turn, and provider latency summed from turn start through assistant response across turns. |
| `attemptOutputTokens` | Attempt | Output tokens across all turns in the attempt, including tool-call turns. |
| `continuations`, `firstFinishReason`, `answerOutputTokens` | Attempt | Whether the final answer was cut and continued, how its first turn ended, and the output tokens across its final-answer turns. |

`finishReason` and `outputTokens` describe only the last turn. A continued answer can finish with `stop` after an earlier turn ended with `length`. `continuations` counts a turn cut at the output limit followed by a turn that issued no tool call. A cut tool call replayed by the model does not count as an answer continuation. `answerOutputTokens` can exceed `attemptOutputTokens` because the former includes recorded output from discarded in-turn replays.

Turn-ledger fields can be unavailable when the record has no turn ledger or cannot establish how an earlier turn stopped. A compaction between a cut turn and its continuation can also leave that relationship unavailable. To identify an answer cut then continued, query `firstFinishReason=length` and inspect `continuations`, `answerOutputTokens`, `finishReason`, and `outputAllowance` together.

### Plan, Source, and Verifier Evidence

The following table lists the plan, source, and verifier evidence fields.

| Fields | Applies to | Meaning |
| --- | --- | --- |
| `planConversion` | Run | Why an existing CREATE target became UPDATE: `create-target-exists` or `planner-proposed-update`. The page path remains in the saved record. |
| `sourceEvidence`, `unverifiedDimensions` | Run | Source-obligation coverage: `cited` when none is unverified, `partial` when some are, `none` when all are. The second field counts unverified dimensions. |
| `verifierDisagreementCount` | Run | Sum of disagreement rows across steps whose provisional and canonical verification were compared. `0` means every retained comparison agreed. It is unavailable when no complete count is known, including when a present comparison was not completed. |
| `executionCeilingSource` | Failed run, step, or attempt | Origin of a recorded execution ceiling: sealed composition budget, host limit, operator override, limits not recorded, or a mismatch between code and recorded evidence. |

`sourceEvidence` is unavailable without a succeeded source-obligation step, when the ledger cannot be validated, or when an older projection did not carry it. Use `docsfab runs show` to read each unverified dimension and its reason. `verifierDisagreementCount` never reports a partial sum as a complete count.

For an execution-ceiling failure, `executionCeilingSource` reads the stopped attempt evidence, or the terminal step's final attempt on a run row. It can be `sealed-budget`, `host-limit`, `operator-override`, `limits-not-recorded`, or `codes-mismatch`. It reads `codes-mismatch` when attempt evidence is absent or inconsistent, and `limits-not-recorded` when classifying the established ceiling requires provider-turn budgets that the record did not retain. The field is unavailable when the failure code does not identify an execution ceiling or an older index projection predates the field.

### Read Loops and Early Answer Requests

The following table lists the read-loop and early-answer-request fields.

| Fields | Applies to | Meaning |
| --- | --- | --- |
| `unchangedReReads`, `readLoopWithheld` | Attempt | Unchanged read results received again, and how many were answered with a notice because their contents remained in context. |
| `maxRepeatsOfOneResult`, `maxUnchangedReReadsAcrossResults` | Attempt | Highest repeated reads of one unchanged result and highest cross-result repeats without a progress call. |
| `concludeNow` | Attempt | Why the host withdrew tools and requested an answer before the model finished reading: `read-loop`, `reading-budget`, or `attempt-deadline`. |

These counters are unavailable when the attempt recorded no unchanged rereads. The cross-result maximum is also unavailable for records created before that counter was recorded. `concludeNow` is unavailable when the host did not request an early answer or the record predates the field.

### Quality-Evaluator Answer Path

The following table lists the quality-evaluator answer path fields.

| Fields | Applies to | Meaning |
| --- | --- | --- |
| `answerPath`, `answerPathReason` | Final quality-evaluator attempt | Whether the answer used `text-final`, `tool-call`, or `answer-records`, and why the selected path was used. |
| `answerSubmission` | Final quality-evaluator attempt | Submission state: `absent`, `in-flight`, `admitted`, `refused`, `not-decoded-at-ceiling`, or `not-applicable` for records mode. |
| `answerReportTurn` | Final quality-evaluator attempt | Report-turn state: `not-asked`, `in-flight`, `admitted`, `refused`, `clamped`, or `authority-stopped`. In records mode, `admitted` means the report passed host validation, not that the ledger is complete. |
| `answerMemberEncoding` | Admitted tool-path submission | How `evaluation` and `qualityScore` arrived: `object`, `null`, or `string`, represented as `<evaluation>/<qualityScore>`. |

`answerPathReason` can be `recorded-route`, `not-recorded`, `tool-not-granted`, `operator-override`, or `record-ledger`. The `answer-records` path uses `not-applicable` for its singular submission state because it submits ledger rows, then requests a separate Markdown report. The report remains `not-asked` until ledger readiness triggers that request. A complete ledger does not admit the report; the report state becomes `admitted` only after host validation succeeds. These fields apply only to the final quality evaluator in `review-documentation`; they are unavailable on other steps and on rows written by older projections. An attempt that ends with report state `in-flight` at its deadline was writing its answer, not reading.

### Answer-Record Ledger Progress

| Fields | Applies to | Meaning |
| --- | --- | --- |
| `answerRecordAdmittedRowCount`, `answerRecordReleasedRowCount` | Attempt that committed a checkpoint | Counts admitted and released ledger rows at that checkpoint. Released rows remain evidence but no longer satisfy the ledger. |
| `answerRecordRemainingKeyCount` | Attempt that committed a checkpoint | Required keys still in the authoritative ledger. This is not open capacity or estimated future work. |
| `answerRecordRefusalEventCount` | Attempt that committed a checkpoint | Refusal events charged to the logical step; distinct from the released-row count. |
| `answerRecordComplete` | Attempt that committed a checkpoint | The checkpoint's direct ledger completion state. It does not establish report validation or workflow success. |
| `answerRecordCheckpointSequence` | Attempt that committed a checkpoint | Sequence of the matched committed checkpoint. |
| `answerRecordLogicalRunId`, `answerRecordSourceRunId`, `answerRecordSourceAttemptHighWater` | Attempt that committed a checkpoint | Logical lineage and source mapping summarized by the counters. The row's physical run ID and attempt identify the attempt that committed the checkpoint. |

These values are copied only when the step and ledger checkpoint pointers agree
on digest, sequence, and physical attempt. Missing, malformed, inconsistent,
or older evidence is `unavailable`; it is not a zero count. For example,
`docsfab runs query --where rowKind=attempt --where answerRecordComplete=false --group-by answerRecordComplete,answerRecordRemainingKeyCount`
groups attempts whose committed ledger was incomplete. Group shares use the
filtered attempt rows as their denominator, not unique logical work. A zero
remaining-key count alone is not a validated report: the ledger's direct
completion flag and the saved report remain separate evidence.

### Request Interpretation

The following table lists the request interpretation fields.

| Fields | Applies to | Meaning |
| --- | --- | --- |
| `intentAdmission` | Run | How request interpretation ended: `admitted`, `advisory`, `question`, `rejected`, `refused`, `offline`, `not-applicable`, `continuation`, `model-unavailable`, or `unverified`. |
| `intentOperation` | Admitted-intent run | Admitted operation: `create`, `update`, `restructure`, or `review`. |
| `intentTargetSource` | Admitted-intent run | Source of write targets: `named`, `inventory`, `proposed-new`, `mixed`, or `none`. Navigation and index targets do not count. |

The query verifies the sealed request interpretation against the run's own instruction. A field that fails verification reads `unverified`. A record without request interpretation reads `unavailable`; a failed or timed-out interpretation call reads `model-unavailable`. `intentOperation` and `intentTargetSource` are unavailable for every outcome other than `admitted`, including `advisory`, because the run used its declared workflow instead. Use `docsfab runs show` to inspect an advisory reading or question.

## Import and Index Maintenance

`docsfab runs import <path>...` accepts a saved record file, run state directory, or local-workflows harness batch directory containing `report.json`. Import writes index rows only. For a harness batch, rows include the batch ID and case key; the result also names cases that produced no run record. The command can import records that remain valid while reporting a refused record by name; if any record is refused, it exits with status 1. Queued or running records are reported as nonterminal and are not indexed.

Use `--index-dir` to choose a destination index or `--state-dir` to choose the state directory whose sibling index receives rows. Add `--docsfab-revision` only when you know the DocsFab revision that produced imported records. A source repository revision is not a substitute. Existing identical rows keep their recorded revision when re-imported without a new label.

The index beside the resolved state directory is at `<dirname(state-directory)>/run-index/runs.jsonl`. The default state directory follows this order:

1. `DOCSFAB_STATE_DIR` in the process environment.
2. `paths.stateDir` in `host.yaml`.
3. `DOCSFAB_STATE_DIR` in the configuration environment file.
4. `.docsfab/runs` beneath the configuration root.

`docsfab runs list` and `docsfab runs show` read the state directory. A query with `--state-dir` reads the index beside it; `--index-dir` reads an index only. An index contains no full run record, so it cannot supply a record to `runs show`.

### Snapshots, Projection Changes, and Stale Classifiers

Each append stores a complete snapshot for a run. Queries count the newest complete snapshot, not older copies. If an append is cut short, the query drops that incomplete snapshot and uses the previous complete one if available. It names unreadable lines separately.

Projection revisions add fields over time. An older row can therefore report a field as `unavailable`. Re-importing records projects the current fields while retaining labels such as an earlier DocsFab revision when identical bytes are already indexed. If an identical record with the same labels already has a newer projection revision, an older importer leaves that snapshot unchanged rather than dropping fields it does not know. An earlier projection can be re-imported to add fields. Records written with a different attempt classifier are counted as stale across the current index, regardless of query filters. Their `failureClass`, `failureLayer`, `failureCode`, and `retryDecisionRule` are unavailable until their records are imported again. The query prints the re-import command.

### Index Limits and Recovery

The run index uses the registered limits in `config/limits.yaml`. The following catalog values are the current defaults.

| Limit | Default | Behavior when exceeded |
| --- | --- | --- |
| `runs.indexMaxBytes` | 64 MiB | Refuses the whole append. A run-store refusal is recorded in `overflow.json`, and each query reports incomplete index state. |
| `runs.recordMaxBytes` | 64 MiB | Refuses the oversized record by name. Other records can still be imported. Readers use the same saved-record bound. |
| `runs.indexImportMaxRecords` | 10,000 records | Refuses the import before writing rows. |
| `runs.indexFieldMaxChars` | 512 characters | Stores an overlong or unsafe field as unavailable and names it in `omittedFields`; the query still counts the row. |

An index write failure does not fail the run record. DocsFab prints `WARNING runs-index-io-failed` to standard error, even when `NODE_NO_WARNINGS` is set. Every `INCOMPLETE` or incomplete-snapshot line gives the rebuild command. To rebuild a full or damaged index, move its `run-index` directory aside and import the state directory again:

```bash
docsfab runs import /absolute/path/to/run-state \
  --index-dir /absolute/path/to/run-index
```
