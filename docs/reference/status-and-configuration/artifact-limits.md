---
title: "Artifact and Run-Record Size Limits in DocsFab"
description: "Look up artifact, retention-graph, and saved-record byte bounds."
status: draft
content.type: reference
---

Look up artifact, retention-graph, and saved-record byte bounds.

## Artifact and Run-Record Sizes

The durable artifact store, hosted editorial evidence retention, and every
reader of a saved run record use these settings. Each one accepts a higher
value up to its catalog maximum, set through its environment variable or by
name in the host limits file. The following table lists these settings.

<Markdown src="operational-limits-tables/artifact-and-run-record-settings.md" />

The artifact store refuses an object larger than `artifacts.maxObjectBytes`
with the code `artifacts-max-object-bytes-bound`. The message names the
observed size, the limit, and the setting to raise. The store never truncates
an object, and every object keeps its digest checks.

Repository size alone does not reach this limit. When a whole content index is
larger than the limit, DocsFab stores the index as content-addressed parts
listed by a manifest. Replay checks every part against its digest and
recomputes the index digest from the reassembled index. A repository of about
10,000 tracked files produces an index of about 17 MB, which the default stores
in one object.

Hosted editorial evidence retention copies every object in the attempt's
artifact store into project CAS. It applies `artifacts.maxObjectBytes` to each
object and the three `artifacts.hostedRetention*` settings to the whole graph,
and it checks the object count and sizes before it copies anything. A crossed
setting refuses with that setting's own code, such as
`artifacts-hosted-retention-max-total-bytes-bound`. An object larger than one
dispatcher CAS object, 16 MiB, is stored as ordered segments, so the CAS object
size does not limit retention.

The hosted runtime runs in a sandbox that does not read the host limits file.
Inside a hosted attempt, `artifacts.maxObjectBytes` and `runs.recordMaxBytes`
keep their catalog defaults, and a host override does not reach a refusal
raised there. Dispatcher retention, outside the sandbox, applies the host value
of `artifacts.maxObjectBytes`, so a host value below the default can refuse an
object that a hosted attempt wrote.

`runs.recordMaxBytes` is the one bound for every reader of a saved run record:
`docsfab runs list`, `docsfab runs import`, `docsfab why`, local publication
preflight, delivery acceptance, the live agent's saved-run tool, the
open-InputAsk lookup that `docsfab do` and the live agent run, and the hosted
dispatcher's review continuation plan. `docsfab runs show` does not apply it. A
record over the bound is reported as too large, never as malformed, as the following list shows:

- `docsfab runs list` shows the run as unavailable with reason
  `record-too-large`, the observed size, the limit, and the setting to raise.
- `docsfab runs import` refuses that record with `runs-record-max-bytes-bound`
  and imports the rest.
- Local publication preflight stops with `runs-record-max-bytes-bound`. The
  record and its patch are unchanged.
- The open-InputAsk lookup prints a `WARNING runs-record-max-bytes-bound` line
  for that record and checks the remaining records.

`runs.recordMaxBytes` replaces `runs.indexRecordMaxBytes`, and DocsFab no
longer reads the old name. When a host limits file still sets it, DocsFab
ignores the value and prints a `WARNING retired-limit-name` line to standard
error that names the file and the replacement. The line appears once per
process wherever DocsFab reads its limits, including `docsfab doctor --limits`.
Set `runs.recordMaxBytes` or `DOCSFAB_RUNS_RECORD_MAX_BYTES` instead.
