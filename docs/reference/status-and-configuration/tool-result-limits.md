---
title: "Tool Result Limits and Recall in DocsFab"
description: "Look up the size, retention, and recall contract for tool results returned to a model."
status: draft
content.type: reference
---

Look up the size, retention, and recall contract for tool results returned to a model.

`DOCSFAB_TOOL_OUTPUT_CAP_BYTES` (default `32768`, range `1024` to `262144`) caps
what a single `read`, `grep`, `find`, or `ls` call can return to the model. It is
a host runtime setting, not a composition input: it takes part in no sealed
digest, and the hosted request's `toolPolicySha256` covers declared tool names
rather than tool limits. The runtime reads it from its own process environment,
so it applies to a local `docsfab run`. It does not reach a hosted worker: the
dispatcher starts each worker with a fixed minimal environment, so nothing in a
service unit or an environment file is forwarded to it. Delivering this setting
to a hosted worker requires a change in the host package that spawns the worker,
not a deployment edit. The default applies on the pilot host today. When a call is cut, the model receives an explicit
`[docsfab-output-cap ...]` notice that names the byte range returned, the cap
that produced it, and how to ask for the rest, which for `read` is the
1-indexed `offset` to continue from. That notice is the only thing a capped call
returns beyond the cap, and it is a single short line. An out-of-range setting
fails the run instead of reverting to the default.

Two details follow from the cap rather than from the tools themselves. `read`
output can end with a continuation notice that the underlying harness added;
DocsFab keeps that notice only while the whole result still fits the cap, and
otherwise cuts the content and substitutes its own marker, so no result is ever
returned over the cap. `grep` matches are ordered by path and then line number
before the cap applies, so repeating an identical `grep` call returns an
identical window whenever the search returns the same match set. A search that
reaches the harness's own match limit can still collect a different subset each
time, and ordering cannot recover what was never collected; narrow the path or
the pattern in that case.

A local `docsfab run` also keeps the full text of every capped result for the
rest of that step attempt. The capped call then returns the head of the
result, a short tail after the notice, and the notice itself. The notice names
both returned byte ranges, a SHA-256 digest, and a handle such as
`docsfab-tr-0123456789abcdef`. To read the omitted bytes, the model calls
`docsfab_recall_tool_result` with that handle, a zero-indexed `byteOffset`, and
an optional `byteLength`. The recall tool returns exactly those saved bytes. It
does not run the original tool again or read the workspace, and it is recorded
under its own name rather than as another `read`. Credential-shaped text still
fails the call and is never saved. The saved results end with the step attempt.

Three catalog limits in `config/limits.yaml` bound this behavior. You can lower
each of the following limits with its host override.

| Catalog Setting | Default | Override | Applies To |
| --- | --- | --- | --- |
| `toolOutput.archiveCeilingBytes` | 33,554,432 bytes (32 MiB) | `DOCSFAB_TOOL_OUTPUT_ARCHIVE_CEILING_BYTES` | Saved original results for one step attempt. Identical results share one entry. |
| `toolOutput.recallPageBytes` | 32,768 bytes (32 KiB) | `DOCSFAB_TOOL_OUTPUT_RECALL_PAGE_BYTES` | Bytes that one `docsfab_recall_tool_result` call returns. |
| `toolOutput.excerptTailBytes` | 4,096 bytes (4 KiB) | `DOCSFAB_TOOL_OUTPUT_EXCERPT_TAIL_BYTES` | Tail shown after the notice. The tail never takes more than half of the call's budget. |

When saving a result would pass the archive ceiling, DocsFab does not evict an
earlier result. The capped call returns the head without a handle, and its
notice ends with the `tool-output-archive-ceiling-bytes-bound` refusal. That
refusal names the observed size and the remediation. A `byteLength` above the
recall page size fails with `tool-output-recall-page-bytes-bound` instead of
returning fewer bytes.

The recall tool never returns more than the configured page size. Ranges never
split a UTF-8 code point. If the whole code point at the aligned offset cannot
fit in the requested `byteLength` or the page size, the call is refused
instead of returning more bytes than that maximum. The page-size override
cannot go below four bytes, the longest UTF-8 code point.

Handle, digest, and ceiling-refusal state are recorded on the step's tool
evidence. Ceiling refusals also appear in the operator run summary. Raw
archived bytes stay in memory for the step attempt and are not persisted.

Hosted workers do not present the recall tool yet. A hosted composition seals
its declared tool names, and the recall tool is not among them. Hosted runs
keep the capped head and `offset` continuation described earlier.

The default is sized against a sample of the documentation trees a review reads
most often. The sample is a read-size distribution, not the scope of a review: a
documentation-set run is not limited to these three trees. Measure the sample
over tracked files with the following command, substituting the revision you
care about:

```bash
git ls-tree -r -l 683f9168 -- planning docs .docsfab/reference-model \
  | awk '$5 ~ /\.md$/ {print $4}'
```

At revision `683f9168` that is 316 Markdown files totalling 2,857,571 bytes,
with a median of 5,982 bytes. A cap of 32,768 bytes therefore returns 305 of
those 316 files (96.5 percent) complete in one call, and a 15-read review is
bounded at 491,520 payload bytes. This improves the chance that a read completes
without another round trip; it does not guarantee that a workflow completes
within its cumulative input-token budget or job deadline. Raise the cap when a
workflow legitimately needs longer single reads, and expect the cumulative
input-token budget to bind sooner.
