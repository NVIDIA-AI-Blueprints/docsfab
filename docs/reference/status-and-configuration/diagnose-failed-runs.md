---
title: "DocsFab Diagnosis Reference"
description: "Look up diagnosis lines, owner classes, causes, recurrence accounting, and JSON fields. To investigate a failure, follow Diagnose a Failed Run."
status: draft
content.type: reference
---

Look up diagnosis lines, owner classes, causes, recurrence accounting, and JSON fields. To investigate a failure, follow [Diagnose a Failed Run](../../manage/diagnose-run.md).

## Read the Answer

A run diagnosis contains the following lines.

| Line | Meaning |
| --- | --- |
| Summary | The run, the failing step, the owner class, and the cause code. A run that succeeded although every technical dimension of its source-obligation ledger is unverified says that its source evidence is degraded. |
| `Model` | The provider, model, workflow, and creation time. |
| `Readiness` | For the `readiness` workflow, the admitted product disposition and closed criterion reason codes. An unavailable value stays unavailable, and a succeeded execution does not imply a ready disposition. |
| `Source evidence` | How many technical dimensions of the source-obligation ledger are unverified, when any are. `docsfab runs show` names each dimension's reason. |
| `What` | The failing step, the attempt number out of the attempts the step recorded, the attempt outcome, and the rejection code and location. On a final quality evaluator attempt, it also names the answer path and its reason, and on the tool-call path the submission and report states, such as `(answer path tool-call, recorded-route; submission in-flight, report not-asked)`. When the physical attempt committed an answer-record checkpoint, it also reports admitted and released rows, required keys remaining, refusal events, ledger completion, checkpoint sequence, and logical/source lineage. An `operator-override` reason is named as operator configuration. |
| `Why` | The cause, stated from closed index fields such as the finish reason, token counts, the provider error class, and the HTTP status. |
| `Owner` | The owner class and what it means. |
| `Also owner` and `Also next` | A second owner that the same evidence supports or cannot rule out, with its own next action. Act on both. |
| `Next` | The next action. A `Command` line names a read-only DocsFab command that helps with it, when one exists. |
| `Evidence` | The index fields the finding was read from, including checkpoint-bound answer-record progress when present, followed by a `Query` line that prints those rows. The physical attempt owns the checkpoint; its progress counters describe the named logical/source lineage. |
| `Recurrence` | How many recent runs of the same provider and model had the same signature at the same step, and the first run that had it. Its `Query` and `Of` lines reproduce the numerator and the denominator. |
| `Also` | Earlier failed attempts in the run, with their owner class and cause, and whether the step later succeeded or a later attempt succeeded before the step ended on its own cause. |
| `Full answer` | The `docsfab why` command for this run. |

When `docsfab why` selects more than one run, it prints one block per run,
newest first, and then a `BY MODEL` section. That section lists each provider
and model with the causes that ended runs and the causes of earlier failed
attempts.

Answer-record progress is read only from a committed checkpoint whose digest,
sequence, and physical attempt match the step pointer and ledger index. Refusal
events are logical-step events, while released rows count current ledger state.
Remaining keys come from the required-key ledger, not the record's open
capacity. The `complete` value is the ledger's recorded state; it does not
claim that the report passed validation or that the workflow succeeded.
Missing or inconsistent checkpoint evidence remains unavailable rather than
appearing as zero.

## Owner Classes

Every finding has one owner class. The owner class says whose problem the
failure is. The following table lists the owner classes.

| Owner class | Meaning |
| --- | --- |
| `provider-capacity` | The provider could not serve the request for now: overload, rate limit, outage, or a stream failure. Waiting and rerunning can clear it. |
| `output-limit` | The reply reached the output allowance the request was sent with. |
| `contract-shape` | The reply did not match the step's contract shape: it was not JSON, or its JSON had the wrong structure. |
| `model-content` | The reply was well formed, but its content broke a host rule the step enforces. |
| `operator-configuration` | The configured endpoint, credential, model, or request settings kept the request from being served, including a model the provider has retired. Rerunning unchanged cannot clear it. |
| `docsfab-defect` | DocsFab failed on its own side, or recorded a code its failure catalog does not classify. |
| `model-progress` | The model kept calling tools without finishing the step: it re-read results it already had, or used the step's whole tool-call or turn ceiling before it answered. A rerun can loop the same way. |
| `repository-check` | A repository-required check failed on the candidate. The available evidence does not establish whether the baseline, candidate, or environment caused it. |
| `unattributed-search` | The saved search evidence does not identify whether the checkout, a host dependency, or DocsFab caused the stop. |

## Causes

Each cause belongs to exactly one owner class. DocsFab reads the finish reason
and provider evidence before the rejection code, because a reply cut at its
allowance also fails JSON parsing. When a reply is refused as not JSON or as
misshapen and its index row does not give the attempt's output total, the
finding keeps its shape cause, names the output limit as the second owner, and
carries the `attempt-output-total-not-recorded` limitation.

During `update-documentation`, the final `evaluate-document-quality` step
returns a JSON envelope containing the report and an independent editorial
assessment. If the provider cuts that envelope at its output allowance,
DocsFab retains the prefix and requests a continuation within
`inference.maxLengthStopContinuations`. It validates the complete envelope
after joining the continuation. If the continuation is also cut after that
budget is spent, the step fails with the output-limit diagnostic. DocsFab
does not replace the missing assessment with a partial report.

For a generic malformed-assessment message, inspect `docsfab why <run-id>`
before rerunning. A recorded `length` finish reason establishes an output
cut even when JSON validation also fails. Follow the diagnosis's next action;
repeating the entire documentation workflow with unchanged settings can
produce the same cut.

A finding for an attempt whose index row carries `concludeNow` also carries
the `answer-asked-early` limitation, whatever its cause: the host withdrew the
tools and asked for the answer before the model finished reading, so the
answer came from partial reading.

For a failed governed search step, `workflow-search-contract-failed` means a
bounded-search or search-progress contract refused host search evidence.
`docsfab why` assigns that code to `host-built-value-refused` and gives the
saved run and diagnosis JSON as the next evidence to report. A generic
`workflow-search-coordinator-failed` code, including one in an older record,
has an unresolved cause. Inspect the saved step error and checkout before
assigning responsibility. Search stops before inference in the failed step;
an earlier step in the run can have made model calls.

The following table lists each cause, its owner class, and where DocsFab
reads it from.

| Cause | Owner class | Read from |
| --- | --- | --- |
| `provider-rate-limited` | `provider-capacity` | HTTP status 429, the `rate-limit` provider error class, or a `throttled` outcome. |
| `provider-server-error` | `provider-capacity` | An HTTP status of 500 or higher. |
| `provider-stream-error` | `provider-capacity` | A provider error class with no HTTP error status, which is an error inside a successful response stream. |
| `provider-stream-incomplete` | `provider-capacity` | The `stream-incomplete` provider error class: the stream closed cleanly mid-answer with no finish reason or end marker. DocsFab retries it within the step retry budget. |
| `provider-timeout` | `provider-capacity` | HTTP status 408 or 504, the `timeout` provider error class, or a `timeout` outcome with no more specific code. |
| `attempt-deadline-awaiting-provider` | `provider-capacity` | The failure code `attempt-deadline-awaiting-provider`: DocsFab's own attempt timer fired while a provider request had sent no first byte (`deadlineTurn` `awaiting-first-byte`). The provider stalled, whatever the model did in earlier turns. |
| `provider-unavailable` | `provider-capacity` | The `network` provider error class, or a recorded transient failure class. |
| `output-allowance-reached` | `output-limit` | Finish reason `length`, or a rejection code in the output-bound class. |
| `reply-cut-over-allowance` | `output-limit` | A reply that ended before its JSON closed while its last turn used at least the output allowance. |
| `reply-continued-over-allowance` | `output-limit` | A reply refused as not JSON or as misshapen after at least one continuation, whose attempt total, from its index row, exceeds the per-request allowance. The shape cause is named as the second owner. |
| `reply-not-json` | `contract-shape` | A rejected reply that the strict parser could not read as JSON. |
| `reply-shape-rejected` | `contract-shape` | A rejection code in the contract-shape class. When the attempt answered through the `submit_quality_evaluation` tool call, the next action names `DOCSFAB_ANSWER_SUBMISSION=text-final` for a route whose tool-call parser alters the submitted arguments. |
| `reply-content-rejected` | `model-content` | A rejection code in the model-content class. |
| `reply-blank` | `model-content` | A `blank-response` outcome. |
| `provider-content-filter` | `model-content` | The `content-filter` provider error class. |
| `provider-model-retired` | `operator-configuration` | HTTP status 410: the provider no longer serves the configured model. Switch the model or composition. |
| `provider-auth-refused` | `operator-configuration` | HTTP status 401 or 403, or the `auth` provider error class. |
| `provider-request-refused` | `operator-configuration` | Another HTTP 4xx status, or the `invalid-request` provider error class. |
| `provider-endpoint-unreachable` | `operator-configuration` | The `unreachable` provider error class: the connection to the configured endpoint was refused, its host name did not resolve, or no route reached it. The next command is `docsfab doctor --live`. |
| `request-not-sent` | `operator-configuration` | A provider outcome with no model, finish reason, or output allowance recorded. |
| `context-window-exhausted` | `operator-configuration` | A `context-exhausted` outcome. |
| `operator-input-refused` | `operator-configuration` | A recorded `operator-input` or `planning-refusal` failure class. |
| `operational-limit-reached` | `operator-configuration` | A recorded `bound` failure class outside inference. |
| `host-dependency-unavailable` | `operator-configuration` | A recorded `infrastructure` failure class outside inference. |
| `search-cause-unresolved` | `unattributed-search` | A generic `workflow-search-coordinator-failed` code, including one in an older record. Inspect the saved step error and checkout; the code alone does not assign the cause. |
| `host-runtime-failure` | `docsfab-defect` | A host execution-lease coordinator failed while checkpointing an inference attempt. Report the saved run and diagnosis JSON; changing provider settings does not repair the coordinator. |
| `run-cancelled` | `operator-configuration` | A recorded `cancelled` failure class. |
| `installed-policy-unverified` | `operator-configuration` | The failure code `request-policy-policy-subject`: the installed request policy did not verify against its digest, route, or sealed values, so DocsFab refused to send any request. Reinstall DocsFab, then rerun. |
| `request-policy-refused` | `docsfab-defect` | Any other `request-policy-` failure code: DocsFab refused its own outbound request before sending it. The table below names each code. A rerun builds the same request, so report it. |
| `boundary-refusal` | `docsfab-defect` | A provider outcome with finish reason `error` but no provider error class or HTTP status: the provider's response reached DocsFab, for example as an error event inside a successful stream, and DocsFab refused it without classifying it. A rerun can pass, but the refusal is DocsFab's to fix. |
| `host-built-value-refused` | `docsfab-defect` | A quality rejection code that refuses a value DocsFab built or supplied, such as `candidate-selection-mismatch`, as the quality-rejection retryability table marks it. Its failure class can read as contract shape, but no model or endpoint change repairs it. |
| `uncatalogued-failure` | `docsfab-defect` | A code the failure catalog does not classify, with no provider evidence that names a cause. |
| `read-loop-stopped` | `model-progress` | A read-loop code, `execution-read-loop-withheld-reads-bound` (one result re-read past its allowance) or `execution-read-loop-unchanged-re-reads-bound` (unchanged re-reads across results past theirs), as the rejection or failure code. DocsFab already retried the stop once with an ask for the answer. The finding names the read-loop counters when the row carries them. |
| `execution-ceiling-reached` | `model-progress` | A tool-call or provider-turn ceiling code as the failure code, on an attempt, step, or run row, whose `executionCeilingSource` is `sealed-budget`: the composition's sealed turn budget set the ceiling, directly or as the tool-call ceiling fitted to it, and only re-qualifying the composition raises it. Read before the context-window and operational-limit causes. When the source is unknown, the finding keeps this cause, names `execution-ceiling-configured` as the second owner, and carries a limitation that says why: `execution-ceiling-source-not-indexed` (an earlier DocsFab indexed the run), `execution-ceiling-limits-not-recorded` (the run record does not carry the run host's configured provider-turn limit and the composition's sealed budgets), or `execution-ceiling-codes-mismatch` (the recorded code names a ceiling the attempt's evidence does not explain). |
| `attempt-deadline-in-tool-loop` | `model-progress` | The failure code `attempt-deadline-in-tool-loop`: DocsFab's own attempt timer fired while the model was still producing tool calls. Its last landed turn finished with `tool-use`, and the timer found its tools running or its next tool calls streaming (`deadlineTurn` `between-requests` or `streaming-tool-call`, or `streaming` before any ask for the answer). The model was working, not waiting on the provider. DocsFab already asks a read-only step to conclude once only its answer reserve remains. |
| `execution-ceiling-configured` | `operator-configuration` | The same ceiling codes when the source is `host-limit` (the run host's execution limit at its catalog value, as the record shows) or `operator-override` (an override such as `DOCSFAB_COMPOSITION_EXECUTION_MAX_TOOL_CALLS_PER_STEP` or `DOCSFAB_COMPOSITION_EXECUTION_MAX_PROVIDER_TURNS` lowered the ceiling below its catalog value). On a row indexed before DocsFab projected the source, a `composition-execution-max-provider-turns-bound` code also reads this cause; the finding then says only that the host provider-turn limit set the ceiling, not whether an override lowered it. `execution-ceiling-reached` is named as the second owner, because the model still used the whole ceiling. |
| `required-check-failed` | `repository-check` | A repository-required check failed on the candidate. The run index has the code but not the full command or result. Use the run-bound `docsfab runs show` command in the finding to inspect recorded check details; unsupported or credential-bearing command text is withheld. Compare with a separately validated baseline check before assigning cause. Changing models alone is not a recovery action. |

### Final Editorial Evidence

**In plain language:** When every step succeeds but DocsFab refuses final
editorial evidence, check the closed failure code before changing a model
setting. For example, `editorial-finalization-decision-identity-mismatch`
means a DocsFab check of bound evidence failed. `docsfab why` and the
`DIAGNOSIS` section classify it as `host-built-value-refused` under
`docsfab-defect`. Report the saved run and diagnosis JSON. Do not retry
unchanged inference.

The 19 closed finalization codes for branch coverage, host evidence, and
decision validation with saved failure class `contract-shape` receive that
reading only on a failed run at the workflow layer. A failed step with the
same code keeps its step diagnosis. The run index retains the code and class,
but it does not retain the refusal location. `docsfab runs show` uses the
saved record to show the actual location in **NEXT** and **FAILURE**.

Two finalization codes remain model-content refusals:
`editorial-finalization-host-conflicting-assessment` and
`editorial-finalization-decision-independent-rejection`. Their diagnosis is
`reply-content-rejected`. Inspect the recorded assessments in the saved run;
do not retry unchanged inference. `editorial-finalization-uncoded-error`
remains `uncatalogued-failure`: report the saved run and diagnosis JSON.

### Request Policy Refusals

DocsFab checks every outbound payload before it is sent. An installed
composition's request policy applies most of these checks; the output limit,
payload shape, tool history, and send checks apply on every route. A refusal
ends the attempt with outcome `provider-terminal` and the failure code below,
at layer `inference`. `docsfab runs query --where failureCode=<code>` selects
the attempts, and `docsfab why` reads the cause from the code before any
finish reason or provider error. The following table lists the failure codes.

The following table lists each failure code, its failure class, and its meaning.

| Failure code | Failure class | Meaning |
| --- | --- | --- |
| `request-policy-payload-shape` | `contract-shape` | The request carried a top-level field, model, stream setting, or reasoning control the policy does not admit. |
| `request-policy-system-instruction` | `contract-shape` | The request's system message was missing, out of order, not DocsFab's installed instruction, or carried a reasoning control token. |
| `request-policy-output-limit` | `contract-shape` | The request asked for more output tokens than the governed turn was granted. |
| `request-policy-tool-shape` | `contract-shape` | A tool declaration or the tool choice did not match the shape the policy admits. |
| `request-policy-tool-history-without-tools` | `contract-shape` | The conversation held tool calls or tool results, but the request offered no tools, which some routes refuse. |
| `request-policy-message-shape` | `contract-shape` | A conversation message carried a field the policy does not admit for its role, or empty content where content is required. |
| `request-policy-message-role` | `contract-shape` | A conversation message had a role the policy does not admit. |
| `request-policy-message-tool-call` | `contract-shape` | A replayed assistant tool call did not match the shape the policy admits. |
| `request-policy-policy-subject` | `operator-input` | The installed request policy does not verify against its digest, route, or the sealed values this DocsFab admits. |
| `request-policy-payload-authority` | `contract-shape` | The payload being finalized did not match the evidence the turn ledger already recorded for this turn. |
| `request-policy-payload-send` | `contract-shape` | The payload about to be sent was not the one the policy finalized and recorded for this turn. |
| `request-policy-payload-resend` | `contract-shape` | The transport tried to send a finalized payload a second time; each finalized payload is sent at most once. |

The refusal message names the message index, its role, and the refused key
only when the key is one of the standard chat message fields; it never quotes
message content.

A policy that turns reasoning off does not refuse reasoning a model streamed
anyway. Pi replays that reasoning on the next request as a
`reasoning_content`, `reasoning`, `reasoning_text`, or `reasoning_details`
field of the assistant message. The policy omits those fields from assistant
messages before sending, and the turn records how many messages it changed in
`replayedReasoningOmitted`, beside the digest of the payload it sent.

## Recurrence

Recurrence compares the newest runs of the same provider and model, up to and
including the diagnosed run. The window holds at most
`diagnosis.recurrenceLookbackRuns` runs. When the index holds older runs for
that provider and model, the recurrence line says so, and its query carries a
`--since` bound that matches the window. The first-seen run is read from the
whole index. It names the DocsFab revision when the index carries one;
otherwise it reads `unavailable`. An attempt that recorded neither a provider
nor a model gets no recurrence line, because it would pool unrelated runs; the
finding carries the `recurrence-model-unavailable` limitation instead.

## Failed Run Output

When `docsfab run`, `docsfab do`, or `docsfab runs show` prints a failed run,
the `NEXT` section adds a `Why:` line with the `docsfab why` command for that
run, and the output ends with a `DIAGNOSIS` section. The section is computed
from the run's own record, projected the way the run index stores it, and
reads recurrence from the index beside the state directory. If that index
cannot be read, the section reports recurrence as unread instead of omitting
it.

## JSON Output

`docsfab why --json` prints a schema version 1 `docsfab-why` envelope with
the following top-level fields.

| Field | Content |
| --- | --- |
| `index` | The index path, whether it exists, and counts of stored, superseded, unreadable, incomplete, and refused rows or snapshots. |
| `selection` | The mode (`run`, `last`, `all`, or `batch`) and the run, batch, and model filters. |
| `runs` | Matching runs, diagnosed runs, whether the list was clipped, and the `diagnosis.maxRuns` limit. |
| `diagnoses` | One entry per diagnosed run, with `findings` in terminal-then-contributing order, and the run row's `sourceEvidence` and `unverifiedDimensions` (`null` when the run has no source-obligation ledger). |
| `byModel` | Runs, failed runs, and causes per provider and model. |
| `limitations` | Answer-level gaps, such as `runs-not-indexed:<count>`, `runs-reprojected:<count>`, or `runs-index-earlier:<count>`. |

Each finding carries `role`, `stepId`, `attempts`, `ownerClass`, `cause`,
`what`, `why`, `nextAction`, `nextCommand`, `evidence`, `signature`,
`reproduce`, `recurrence`, `alsoCause`, and `limitations`. The
`evidence.attemptTotals` object holds the whole-attempt output figures from
the attempt's index row, or `null` when the row carries none of them. New fields are added as optional
or nullable, and new owner classes or causes are added as new values; existing
names do not change within schema version 1.

## Limits and Refusals

The following operational limits bound the command.

| Limit | Effect |
| --- | --- |
| `diagnosis.maxRuns` | The number of runs one invocation diagnoses when it selects several. The newest runs are diagnosed first, and a `Clipped` line and `runs.clipped` state how many matched. |
| `diagnosis.recurrenceLookbackRuns` | The number of recent runs recurrence compares for one provider and model. |

The command also applies the run index limits `runs.indexMaxBytes`,
`runs.recordMaxBytes`, `runs.indexImportMaxRecords`, and
`runs.indexFieldMaxChars`. Refer to
[Operational Limits](operational-limits.md) for how to inspect and override
limits.

`docsfab why` refuses with one of the following coded operator errors instead
of guessing.

| Code | Cause |
| --- | --- |
| `why-invalid-arguments` | The options conflict or name an unsupported value. |
| `why-run-not-found` | No indexed run or saved record has that ID or prefix. |
| `why-run-ambiguous` | The ID prefix matches more than one indexed run. |
| `why-no-runs` | No saved run matches the selection. |
| `why-state-dir-missing` | The named state directory does not exist. |
| `why-state-dir-unreadable` | The named state directory is not a directory that can be listed. |

## Moved Topic Links

Earlier section bookmarks lead to the canonical topic below.

<a id="diagnose-input-and-human-decision-stops"></a>

Refer to [Diagnose a Failed DocsFab Run](../../manage/diagnose-run.md#diagnose-input-and-human-decision-stops).

<a id="run-the-command"></a>

Refer to [Diagnose a Failed DocsFab Run](../../manage/diagnose-run.md#run-the-command).
