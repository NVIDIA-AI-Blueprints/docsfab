---
title: "Diagnose a Failed DocsFab Run"
description: "Use `docsfab why` to identify a saved run's cause, responsible owner, supporting evidence, and next action."
status: draft
content.type: how-to
---

Use `docsfab why` to identify a saved run's cause, responsible owner, supporting evidence, and next action.

## Prerequisites

Keep the saved run or its imported index available. Diagnosis is read-only and does not call a model.

## Steps

Use the command and checks below.

## Run the Command

The following commands show the supported selections:

```bash
docsfab why                                   # the newest run in the default state directory
docsfab why <run-id>                          # one run, by full ID or unique prefix
docsfab why --last --state-dir <state-dir>    # the newest run in that state directory
docsfab why <state-dir>                       # every run in that state directory, with a per-model summary
docsfab why --all --model <model-id>          # every run that used one model
docsfab why --batch <batch-id>                # every run of one harness batch
docsfab why <run-id> --json                   # the docsfab-why JSON envelope
```

`--state-dir` reads the named state directory and the run index beside it,
and refuses a state directory that does not exist. `--index-dir` reads one run
index directory only. Without either option, the command uses the default
DocsFab state directory. `docsfab why` is read-only: it writes no index row,
record, or other file, and it makes no model call.

`--last` diagnoses one run. To see causes per provider and model across a
state directory, run `docsfab why <state-dir>`.

When the state directory holds a terminal saved record that the run index does
not hold yet, `docsfab why` projects that record in memory the same way
`docsfab runs import` would and diagnoses it. The answer states how many runs
it read this way. Run `docsfab runs import <state-dir> --state-dir <state-dir>`
to add them to the index beside that state directory. Without `--state-dir`,
the import writes to the default index, which `docsfab why <state-dir>` does
not read.

An attempt's whole-attempt output figures come from its run index row: the
total output tokens across its turns (`attemptOutputTokens`), how many turns
continued an answer cut at the output limit (`continuations`), and the
per-request allowance (`outputAllowance`). Rows that an earlier DocsFab
indexed do not carry the first two. When a state directory is known,
`docsfab why` reads each diagnosed run that an earlier DocsFab indexed again
from its saved record, with the same projection `docsfab runs import` uses,
and says so on a `Re-read` line. The re-read keeps the batch, the case, and
the DocsFab revision the earlier rows carried, as `docsfab runs import`
does. An `Earlier index` line names the runs it could not read again: their
saved record was missing, unreadable, or not that run's terminal record, or
you named only `--index-dir`, so no state directory was known. Both lines
name the `docsfab runs import` command that indexes those runs again.

## Diagnose Input and Human-Decision Stops

`docsfab why` also explains a saved run whose recorded status is
`needs-input` or `needs-human-decision`. Its `Stop` line names the status and
a step only when the index supports one terminal step. A verified request
interpretation question identifies a no-step `needs-input` admission stop.
If the step or admission evidence is missing or inconsistent, the answer
marks that detail as unknown.

The run index does not retain the exact requested input or human decision.
The `Why` and `Limitation` lines state that gap. When you select a state
directory, the `Next` line offers a read-only `docsfab runs show` command
for that location. With `--index-dir` alone, the index does not establish
the saved run's state directory. The answer marks that location unavailable
and offers no default-store command. Neither path promises that the saved
run contains the exact question or that the run can resume.

In `--json` output, each diagnosis has a nullable `stop` field separate
from failure `findings`. A stop has a closed status, optional step identity,
verified admission context or `unknown`, a host-written explanation and next
action, an inspection command when its location is known, and closed
limitations. An earlier failed
attempt can remain a contributing finding without turning the stop into a
terminal failure or increasing a model's failed-run count. Existing failed
and succeeded runs have `stop: null`.

## Related

Use these topics for the supporting contracts and next actions.

- [Diagnosis Reference](../reference/status-and-configuration/diagnose-failed-runs.md)
- [Investigate Saved Runs](../workflows/investigate-saved-runs.md)
