---
title: Investigate Saved Runs in DocsFab
description: Query saved DocsFab runs to identify recurring failure signatures, inspect supporting evidence, and choose a bounded next action.
status: draft
---

Use this DocsFab workflow when saved runs failed or differ and you need to identify a recurring signature, inspect the supporting record, and choose what to investigate next. Listing, querying, and inspecting are local and read-only. Importing records writes index metadata only; it does not replay a workflow or call a model. For command and field details, refer to the [DocsFab Run Index Reference](../reference/status-and-configuration/query-failures-across-runs.md). For more information, refer to [About DocsFab Workflows](index.md).

## Prerequisites

Before you start, you must have the following prerequisites:

1. Install the DocsFab CLI and know the absolute path to either the state directory containing saved records or an index built from them.
2. If records are in more than one state directory, decide which original state directory you will inspect and which index will combine their rows.
3. Write down the question you need to answer, such as how many runs failed, which rejection repeats, or whether an attempt recovered.

An index stores queryable rows, not the saved run records. You need the original state directory for `docsfab runs show`. `docsfab why` can read a state directory or an index directory.

## Steps

Use the commands below to go from a run-level count to specific evidence. Replace each example path with a real absolute path before running it.

### 1. Locate the Records and Count Runs

Set the state directory and list its saved runs:

```bash
RUN_STATE=/absolute/path/to/run-state
docsfab runs list --state-dir "$RUN_STATE"
```

The list provides run IDs and bounded metadata such as workflow, status, revision, timestamps, and whether reports or artifacts are available. Copy a full run ID for a record you may inspect.

If the cohort spans multiple state directories, import their rows into one chosen index. Importing does not copy the run records:

```bash
STATE_A=/absolute/path/to/first-state-dir
STATE_B=/absolute/path/to/second-state-dir
INDEX_DIR=/absolute/path/to/run-index
docsfab runs import "$STATE_A" "$STATE_B" --index-dir "$INDEX_DIR"
```

For the examples below, replace `--state-dir "$RUN_STATE"` with `--index-dir "$INDEX_DIR"` when querying the combined index. Use each run's original state directory with `runs show`.

Start with one row per run when the question is about jobs that ended in each status:

```bash
docsfab runs query --state-dir "$RUN_STATE" \
  --where rowKind=run --group-by runStatus
```

Illustrative excerpt from the formatter output:

```text
RUN INDEX QUERY /absolute/path/to/run-index/runs.jsonl
Filters: rowKind=run
Population: 3 rows across 3 runs
  2 rows (66.7%), 2 runs  runStatus=succeeded
  1 rows (33.3%), 1 runs  runStatus=failed
RUN ENDS: 3 runs, from each run row
  2 runs  workflow=review-documentation model=fixture/model-a runStatus=succeeded terminalStepId=unavailable failureClass=unavailable failureCode=unavailable
  1 runs  workflow=review-documentation model=fixture/model-a runStatus=failed terminalStepId=evaluate-document-quality failureClass=model-content failureCode=candidate-target-outside-scope
```

The example shows the formatter shape, not a measured result. Its three run rows represent three jobs, so the denominator is runs, not inference attempts. `RUN ENDS` identifies the failed run's terminal step and run-level cause. A successful inference attempt can still be followed by a failed validator step or run.

### 2. Narrow the Question to a Failure Signature

To find which run and step recorded a quality-validation rejection, count step rows and group by run ID as well as the rejection details:

```bash
docsfab runs query --state-dir "$RUN_STATE" \
  --where rowKind=step \
  --where rejectionSource=quality-validation \
  --group-by runId,stepId,rejectionCode,rejectionLocation
```

The command's `Population` line tells you how many matching step rows form the denominator. Grouping by `runId` gives you IDs to inspect; the rejection code and location identify the repeated signature. To investigate inference-attempt failures instead, omit `rowKind=step`, filter on an attempt field such as `stepId`, and group by `runId,stepId,attempt,outcome,rejectionCode`.

For retry recovery, keep the run, step, and attempt together in the grouping. A successful later attempt is recovery for that step's attempt sequence, not proof that its artifact or overall run succeeded:

```bash
docsfab runs query --state-dir "$RUN_STATE" \
  --group-by runId,stepId,attempt,finalAttempt,outcome,retryDecisionRule
```

Use `--since` and `--until` to narrow the cohort by run creation time. `--since` is inclusive, `--until` is exclusive, and a date-only value means midnight UTC. Read the displayed population before comparing groups: the default is attempt rows, and one run can contribute multiple rows.

### 3. Inspect a Supporting Record

Use an ID from the grouped results to inspect the retained record and its diagnosis:

```bash
RUN_ID=copy-a-full-run-id-from-the-query
docsfab runs show "$RUN_ID" --state-dir "$RUN_STATE"
docsfab why "$RUN_ID" --state-dir "$RUN_STATE"
```

`runs show` needs the original state directory and displays the retained run summary and available evidence. `docsfab why` gives a read-only diagnosis with supporting fields and a next action. If you have only an imported index, define its path and use it for diagnosis:

```bash
INDEX_DIR=/absolute/path/to/run-index
docsfab why "$RUN_ID" --index-dir "$INDEX_DIR"
```

The index can support diagnosis and aggregate counts, but it cannot provide the original record to `runs show`.

The query result is an index summary, not a transcript or raw model output. Use the saved record to check retained rejection evidence and available report or artifact references. Missing fields mean the record did not retain that evidence; do not treat them as zero or infer the cause from the nearest available code.

For a review with a retained inspection intent, find the `review-delivery-intent` output reference in `docsfab runs show "$RUN_ID" --state-dir "$RUN_STATE" --json`. Use its `digest` to open the complete original review:

```bash
INTENT_SHA256=copy-the-retained-inspection-intent-object-digest
docsfab runs show "$RUN_ID" --state-dir "$RUN_STATE" \
  --review-delivery-inventory "$INTENT_SHA256" --json
```

This read-only command returns a `saved-review-inventory` object with the original review result and reconstructed delivery plan. The result includes findings, checks, unanswered questions, review scope, and template coverage. The plan includes every selected action and its limitations. It reads the retained run, source, result, intent, and receipt from the local private stores, including after a complete custody import. It does not rerun a model or contact the review provider. Use the original saved run ID and the imported state directory after transfer.

An `inspection-unavailable` result names the failed evidence check and a next action. It means DocsFab could not verify the complete inventory. Keep the retained objects and receipt for investigation; a digest by itself cannot open missing content. This option requires `--json` and cannot be combined with other `runs show` projections.

While a step is running, `docsfab runs show <run-id> --json` includes an optional `inferenceProgress` projection with the latest observed Pi provider-turn or tool-execution boundary, its time and attempt, and boundary counts. The observation can include current-attempt cumulative Pi session token counters, including cache counters when reported. These provisional snapshots are separate from terminal usage. A pending provider turn is a harness-side observation, not proof of network reachability; an absent field means no boundary was observed. This evidence does not indicate that the step or run has finished.

For output-limit questions, inspect `firstFinishReason`, `continuations`, `answerOutputTokens`, `finishReason`, and `outputAllowance` together. `finishReason` describes the last provider turn. A continued answer can have an earlier cut and a final turn that stopped normally. A `stop` finish below the allowance alone cannot rule out an earlier cut followed by continuation.

### 4. State the Finding and Its Limit

Record the cohort, count unit, query filters, affected run IDs, observed signature, supporting evidence, and next action. For example: “One of three selected runs ended with a quality-validation rejection at `evaluate-document-quality`. The query identifies the run and rejection location; the saved record is needed to inspect retained evidence. Next, compare the refused artifact with the cited source. This count does not establish a general model ranking.”

If you cannot inspect an original record, say which evidence is unavailable. Query counts can identify patterns for follow-up, but they do not prove document quality or a general model result.

## Delete a Saved Run

After you have retained the evidence you need, preview one run's local deletion:

```bash
docsfab runs delete "$RUN_ID" --state-dir "$RUN_STATE"
```

The preview changes no files. It reports the local files, directories, and index rows selected for removal, shared entries that remain, unresolved entries, and a confirmation token. Review those counts and the named state directory before you run the printed command with `--confirm <token>`. Use `--json` if you need the preview or completion fields in a script.

Deletion includes the run's saved quality-validation objects and limit-overflow sidecar when they exist. It preserves objects referenced by other runs. A later `runs import` cannot recreate the deleted run's index rows, and supported run writers refuse its ID. Create a new run to produce new evidence.

Publication and deletion share a local gate for each run. After a writer crashes, DocsFab recovers a complete private gate only when it verifies that the recorded owner process has exited. An incomplete or unsafe gate remains locked. Stop concurrent writers and inspect the named lock before manual recovery.

When a run has delivery attempts, whether its publication completed or failed, the preview also reports the Git cleanup. DocsFab retains a worktree for each attempt, including the detached worktree that each retry adds, and it keeps the run's DocsFab-named delivery branch. Confirmation removes those worktrees and then deletes the branch. It deletes the branch only while the branch points at the run's base revision or at the delivery commit that the run recorded, and no worktree is using it. The preview names each branch that it keeps and the reason. Examples are a branch that you named with `--source-branch`, a branch with other commits, and a branch that another worktree has checked out, is rebasing, or is bisecting.

Deletion changes only local state. A branch that DocsFab pushed stays on the remote repository, and a merge request stays open. DocsFab deletes the local branch reference and leaves the `branch.<name>` upstream settings in your Git configuration.

A preserved worktree whose HEAD, index, or files changed after the failure is an unresolved entry. The preview prints only how many entries need ownership review, and the confirmation output names each entry. Confirmation deletes nothing until you resolve them. To resolve an entry, save any work that you want to keep, for example on a branch that you name. Then run `git worktree list` in the original repository, find the worktree under the attempt directory that the confirmation output names, and remove it with `git worktree remove --force <path>`. Preview the run again and confirm with the new token.

If an older publication used custom roots, pass each `--delivery-root <path>` and `--receipt-root <path>` at preview and confirmation. DocsFab removes only entries it can bind to the run. It keeps shared artifacts and reports an incomplete result with a next action when ownership, a registered Git worktree, or an index rebuild needs attention. After you resolve the named condition, retry with the same confirmation token when a private deletion journal exists; otherwise preview again.

An interrupted deletion can resume after its run record is removed when the private journal and deletion tombstone still identify every unchanged review receipt that the original preview proved unrelated. If a receipt changes, a new receipt appears, or an older journal lacks that evidence, DocsFab keeps the receipt and reports an incomplete deletion. Preserve the journal and receipt, inspect their custody and ownership, and use the reported next action before retrying. Do not remove a receipt to force deletion to complete.

## Next Steps

For failure-class meanings and recovery guidance, refer to [Diagnose Failed Runs in DocsFab](../reference/status-and-configuration/diagnose-failed-runs.md). For supported filters, grouped fields, import behavior, and index limits, refer to the [DocsFab Run Index Reference](../reference/status-and-configuration/query-failures-across-runs.md).
