---
title: "Inspect Operational Limits in DocsFab"
description: "Inspect the effective limits and observed headroom for the current configuration and project before changing a setting."
status: draft
content.type: how-to
---

Inspect the effective limits and observed headroom for the current configuration and project before changing a setting.

## Prerequisites

Use the same configuration root and state directory as the runs you want to inspect. Missing measurements remain unknown.

## Steps

Run `docsfab doctor --limits` for the human table, or `docsfab doctor --limits --json` for the machine record.

The human output contains one row for each declared limit:

```text
name | value | unit | source | observed-max-seen | headroom% | status
```

When an installed composition carries sealed answer-record measurements,
`docsfab doctor --limits` also prints its predicted records timer (`T*`),
effective timeout and provider-turn ceilings, the output-derived message budget,
largest indivisible record, and the record-call ceiling from the canonical
answer plan. The row names the evidence digests and plan parameters used for
those projections. A qualified projection that exceeds an effective turn,
timer, record-boundary, or review threshold makes the command exit `1`; missing
retained run measurements, or an effective message budget below the smallest
qualified rung, remains explicitly unqualified. Startup recomputes the same fit
from sealed metadata and the effective composition clamps before resolving the
provider credential. It does not read probe or corpus files during a run, and
doctor does not resolve credentials or contact a provider. Selecting
`DOCSFAB_ANSWER_SUBMISSION=text-final` leaves the records path inactive.

Use `docsfab doctor --limits --json` when a script needs the canonical
`docsfab-doctor-limits` record. Each row carries `name`, `value`, `unit`,
`source`, `observedMaxSeen`, `headroomPercent`, and `status`. The status is
`ok`, `warn`, `over`, or `unknown`. Missing measurements remain `n/a` in the
table and `null` in JSON, so the command does not turn absent evidence into a
zero. A measured zero remains zero, including a zero retry count.

After the rows, the human output lists the planned answer size of every
read-only step a model runs, from its own
`compositionExecution.answerPlan.<step>Tokens` entry or, with source `default`,
from `compositionExecution.answerPlan.defaultTokens`. A last line names the
steps on the default. The JSON record keeps its documented fields; each
answer plan entry appears among its `rows`. The answer-now reserve of a
judgment step is its planned answer at
`compositionExecution.answerNowDecodeTokensPerSecond`, plus
`compositionExecution.answerNowTurnLatencyMs` for the answer turn and each
length-stop continuation. With the defaults, both review judgment steps ask
for the answer at 120,000 ms of a 300,000 ms attempt, their reading share.

The runtime derives observations from immutable run records in the effective
private state directory, the directory `docsfab run` writes records to. An
exported `DOCSFAB_STATE_DIR` selects that directory. Otherwise DocsFab uses
`paths.stateDir` from `host.yaml`, then `DOCSFAB_STATE_DIR` in the
configuration's env file, then the configuration root's `.docsfab/runs`
directory. The explicit `DOCSFAB_LIMITS_OBSERVED_FILE` fixture path remains
available for controlled diagnostics. The reader compares independent retry
attempts and keeps the largest measured value for each limit. The cumulative
token rows come from each attempt's execution lease. The lease also charges a
provider turn that an in-turn replay discarded, so these rows can exceed the
attempt's `usage` totals. A lease below those totals breaks the record
contract and is reported as `invalid-record`. Counters such as calls per lease,
response bytes, and recovery remain `unknown` when the saved evidence does not
measure them.

Recognized private state directories, including review reports in `reports/`,
do not prevent observation. The reader validates those directories and leaves
their contents untouched. Unexpected entries, symlinks, and directories with
unsafe ownership or permissions still produce `unsafe-store`.

When a saved record or observation file breaks its contract, the command exits
with `1` and reports `invalid-record` with that file's path, for example
`Run limit observations failed (invalid-record) at $DOCSFAB_STATE_DIR/<run-id>.json.`
Inspect and correct the file, then rerun the command. The code
`internal-error` means DocsFab failed while reading a file that it did not
judge invalid. The message names the file and the cause, and the file is
unchanged. Report the message to the DocsFab maintainers.

The command exits with `0` when the report is `ok` or `unknown`, `3` when it
is `warn`, and `1` when it is `over`. A qualified composition fit that exceeds
its effective bounds can make the report `over`, even without an over-limit
row. Unknown rows remain visible and do not silently become successful
measurements. A limit refusal names the coded
reason, limit, observed value, configured value, unit, and remediation.
Overflow summaries project the persisted closed axis and the actual
pre-truncation observation. They do not invent bound-plus-one measurements.
When that observation was not persisted, the summary reports that the named
limit was exceeded without a synthetic count. `docsfab run` and
`docsfab runs show` project those sealed overflows in a LIMITATIONS
section, and in `--json` as `limitOverflow`, from the executed or saved
run. Inventory overflow is read from `repositoryBatchAuthority`.
Navigation overflow is copied onto that inventory. Source-representation
overflow is retained from acquisition and replayed for `runs show`.
Production commands load that evidence themselves.

This report describes the selected local run records and effective CLI
configuration. It does not collect a separately operated service's private
attempt history or verify that service's health projection. Missing hosted-run
measurements remain `unknown`; they do not become local observations because
the CLI is installed on the same machine.

Use durable local records or an explicitly supplied compatible observation
file for local diagnostics. Deployment service reports and their freshness
checks belong to that deployment's operator procedure.

## Related

Use these topics for the supporting contracts and next actions.

- [Operational Limit Definitions](../reference/status-and-configuration/operational-limits.md)
- [Configure Host Limits](configure-host-limits.md)
