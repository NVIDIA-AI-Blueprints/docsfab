---
title: "Read-Loop Supervision in DocsFab"
description: "Look up how repeated reads and answer reserves end a model attempt or ask it to conclude."
status: draft
content.type: reference
---

Look up how repeated reads and answer reserves end a model attempt or ask it to conclude.

## Read-Loop Supervision

Some models re-read the same unchanged files for most of a step attempt, until
the attempt timer or the tool-call ceiling ends it. The runtime judges a read
by what it returns, not by its new tool-call ID. This applies to every model
and step, on both execution paths.

The read-class tools are `read`, `grep`, `find`, `ls`,
`docsfab_recall_tool_result`, `docsfab_list_sources`, `docsfab_read_source`,
`docsfab_search_sources`, `get_section`, and the
[git history tools](../knowledge-and-delivery/git-history-tools.md)
`docsfab_history_blame`, `docsfab_history_diff`, `docsfab_history_log`,
`docsfab_history_search`, and `docsfab_history_show`. A result from one of these tools
is an unchanged re-read when the same call, with the same arguments, already
returned the same bytes in the attempt. The runtime counts unchanged re-reads
per result and across all results, and handles them in the following way:

- The first `execution.readLoopRepeatStreak` re-reads of one result (8 by
  default) still deliver the full result, followed by a notice. The notice
  names the tool, the path, and the turn that first delivered the content.
- The first `execution.readLoopUnchangedReReads` unchanged re-reads of all
  results together (16 by default) also deliver the full result with the
  notice. This catches a model that cycles through several files without
  re-reading any one of them often.
- After either allowance, each further unchanged re-read delivers only the
  notice, because the same bytes are already in the context.
- When notice-only re-reads exceed `execution.readLoopWithheldReads` (8 by
  default), the runtime ends the attempt after that tool turn. It fails the
  step with category `no-progress` and the code of the allowance that withheld
  more: `execution-read-loop-withheld-reads-bound` for one result, for example
  `execution-read-loop-withheld-reads-bound: 9 exceeds execution.readLoopWithheldReads = 8 count. ...`,
  or `execution-read-loop-unchanged-re-reads-bound` across results, for example
  `execution-read-loop-unchanged-re-reads-bound: 25 exceeds execution.readLoopUnchangedReReads = 16 count. ...`.
  A model that re-reads only one result keeps the first code.
  The step retries that attempt once by default (`retry.maxNoProgressRetries`).
  The retry's prompt says the previous attempt kept re-reading content it
  already had. At the retry's first notice-only re-read, the runtime withdraws
  the tools and asks for the final answer from what the model already read,
  instead of letting the loop run to the stop again. The answer is still
  validated against the step's contract. The attempt records the turn at which
  the runtime asked, as `concludeNow`. Every tool call after the ask is denied
  and counts toward the same `execution.readLoopWithheldReads` allowance, so a
  model that ignores the ask ends the retry with a read-loop code, and the step
  fails. An attempt that reaches the hard tool-call ceiling gets the same
  retry, whose prompt says the previous attempt used every tool call the step
  allows without answering.

A read-only step that is still calling tools once only its answer reserve
remains is asked to conclude before its attempt timer ends. The reserve is
the time the step's own planned answer needs: its
`compositionExecution.answerPlan.<step>Tokens` entry (or
`compositionExecution.answerPlan.defaultTokens`, which
`docsfab doctor --limits` names) at
`compositionExecution.answerNowDecodeTokensPerSecond`, plus
`compositionExecution.answerNowTurnLatencyMs` for the answer turn and each
length-stop continuation. With the defaults, on a 300,000 ms attempt the
editorial review is asked at 181,250 ms and `evaluate-document-quality`, whose
planned answer is the largest, at 102,500 ms. The two review judgment steps
are asked at the earlier of that point and their reading share,
`compositionExecution.answerNowElapsedShareBasisPoints`. The runtime withdraws
the tools and asks for the final answer from what the model already read.
Every later tool call is denied, except that on the tool-call answer path the
first `submit_quality_evaluation` call of a turn still runs. The answer is
still validated against the step's contract. A write step is never asked,
because withdrawing its tools would leave its change half made.

When the attempt timer fires, the attempt records where the timer found it as
`deadlineTurn`: `awaiting-first-byte`, `streaming-answer`,
`streaming-tool-call`, `streaming`, or `between-requests`. The following rules set the
resulting code:

The recorded position determines the failure in the following ways:

- A provider request with no first byte fails with
  `attempt-deadline-awaiting-provider`, a provider stall, whatever the model
  did before it.
- Tools running, or tool calls streaming, after a turn that called tools fails
  with the bound code `attempt-deadline-in-tool-loop`. So does other output
  streaming before any ask for the answer.
- An answer streaming, or anything streaming after an ask for the answer,
  stays a `timeout`.

Every such ask is recorded on its attempt as `concludeNow`, with the trigger
`attempt-deadline`, `reading-budget` (a judgment step's reading share), or
`read-loop` (a conclude-now retry), and the turn after which the runtime
asked. The run summary and `docsfab runs show` count these attempts under
LIMITATIONS, one line per attempt, because their answers came from partial
reading. The run index carries the trigger as `concludeNow`, and
`docsfab why` adds the `answer-asked-early` limitation to a failure finding
for such an attempt. The `--json` run result lists them as
`answersAskedEarly`, each with `stepId`, `attempt`, `trigger`, `turn`, and
`outcome`.

A turn without tool calls is an answer, and the runtime always evaluates it,
even after the bound is crossed. A verification pass that re-reads up to
`execution.readLoopUnchangedReReads` files once each is delivered in full;
past that, the runtime sends notices and then stops the attempt as above.

The runtime never withholds new content. A changed file, a different range of
the same file, and a file or listing not read before are always delivered in
full. A compaction may remove earlier results from the context, so the first
re-read after it is delivered in full again and is not counted. The count
across results is kept through a compaction, so a model that re-reads one file
in every epoch between compactions, which a per-result count reset by each
compaction never stops, still stops on the cross-result code. A new successful `edit`, `write`,
`canon_propose_claim`, `canon_conflict_gap`, `canon_submit_artifact`, or
`validate_quality_candidate` call resets every count. Repeating an identical
call of one of these tools does not. A failed call and other tools leave the
counts unchanged.

An attempt that re-read unchanged content records `tools.readEvidence`, which
holds counts only. `docsfab runs query` reads them as `unchangedReReads`,
`readLoopWithheld`, `maxRepeatsOfOneResult`, and
`maxUnchangedReReadsAcrossResults`, and `docsfab why` names a read-loop stop
`read-loop-stopped`, owned by `model-progress`. The execution lease applies the
same rule when it renews: an unchanged re-read is not progress, whatever its
call ID.
