---
title: "Deliver or Recover a Draft Merge Request in DocsFab"
description: "Inspect or recover the exact draft merge-request delivery for a saved documentation result."
status: draft
content.type: how-to
---

Inspect or recover the exact draft merge-request delivery for a saved documentation result.

## Deliver or Recover a Draft Merge Request

A write-capable workflow produces a patch; the fixed workflow itself
performs no source-control mutation. Create, update, and restructure open
one draft merge request after a successful write. Pass `--patch-only` to
skip publication and retain the reviewable disposable-workspace patch.
`--allow-write` and `--draft-mr` remain accepted. Neither flag grants
merge authority.

If a recoverable publication attempt failed, inspect the retained run and
use `ship` as the preferred interactive recovery path. This path does not
make another model call:

```bash
docsfab runs show <run-id>
docsfab ship <run-id> --repo /absolute/path/to/target-repo
```

Use `docsfab ship <run-id> --repo <path> --dry-run` to inspect a
human-readable, read-only plan before delivery. `docsfab publish` remains
supported for scripted compatibility and two-phase recovery. Neither
recovery path expands the original authority. For the authority model,
refer to
[Delivering Results](../about/core-concepts/documentation-jobs.md#delivering-results)
and [Runner Quickstart](../get-started/runner-quickstart.md).

## Draft-MR Private Roots and Recovery

For a draft-MR write, the effective run-record directory comes from the
explicit `--state-dir`, `DOCSFAB_STATE_DIR`, or `paths.stateDir` in the
host-owned `host.yaml`; otherwise it is the configuration root's
`.docsfab/runs` directory. Omitted delivery and receipt roots are sibling
directories named `delivery` and `receipts` beside that effective state
directory. Hosts may set `DOCSFAB_DELIVERY_ROOT` and
`DOCSFAB_RECEIPT_ROOT`, while `docsfab publish --execute` also accepts
explicit absolute `--delivery-root` and `--receipt-root` values.

One-shot `--draft-mr` preflight verifies the effective state, delivery, and
receipt roots as owner-private writable directories before model execution.
If delivery stops, use the complete recovery command printed in the result;
it includes the exact `--state-dir`, `--delivery-root`, and `--receipt-root`
values. Do not replace those values with the parent configuration directory.
Retrying with the same sealed branch and merge-request provenance adopts the
existing draft; a mismatched branch or merge request remains a collision.

Use `docsfab runs list` to discover a safe run ID before calling `runs show`:

```bash
docsfab runs list
docsfab runs list --json --state-dir /absolute/path/to/run-state
```

The list is newest first and includes only bounded metadata: the run ID,
workflow, status, repository path and revision, start and update timestamps,
and whether artifacts or a hosted report are available. Missing state is an
empty successful list. A malformed, unsupported, or unreadable record appears
as an unavailable row without exposing its contents; valid rows remain usable.
A record larger than `runs.recordMaxBytes` appears with reason
`record-too-large`, its size, the limit, and the setting that raises it. Refer
to [Artifact and Run-Record Sizes](../reference/status-and-configuration/artifact-limits.md#artifact-and-run-record-sizes).
A run-state directory read failure returns a safe command error instead of an
empty list. If the directory contains more than 10,000 candidate records, the
command fails explicitly rather than silently truncating the results.

To learn why a run failed and what to do next, refer to [Diagnose Failed Runs in DocsFab](../reference/status-and-configuration/diagnose-failed-runs.md). To investigate saved runs across a cohort, refer to [Investigate Saved Runs in DocsFab](investigate-saved-runs.md). For supported query fields and index behavior, refer to the [DocsFab Run Index Reference](../reference/status-and-configuration/query-failures-across-runs.md). To resume a durable knowledge stop and project it into an exact continuation command, refer to [Resume a Durable Knowledge Stop in DocsFab](answer-and-resume.md).
