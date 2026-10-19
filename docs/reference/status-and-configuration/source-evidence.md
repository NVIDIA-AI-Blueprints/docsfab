---
title: "Tracked Source Evidence Reference in DocsFab"
description: "Look up tracked source binding, immutable extraction, citation tools, supported formats, and read-budget behavior. For the procedure, follow Select Source Evidence."
status: draft
content.type: reference
---

Look up tracked source binding, immutable extraction, citation tools, supported formats, and read-budget behavior. For the procedure, follow [Select Source Evidence](../../workflows/select-sources.md).

## Source Binding

`--source` binds tracked repository files as required evidence for a create or update run. For commands, follow [Select Source Evidence](../../workflows/select-sources.md).

Each value is a repository-relative path. A path under a hidden directory, such
as `.bench/change.json`, is an ordinary tracked source. The tracked export never
materializes credential files such as `.env`, `.npmrc`, `.pypirc`,
`credentials.json`, `*.pem`, `*.key`, and SSH keys, or files under `.aws`,
`.ssh`, `.config/gcloud`, `node_modules`, `dist`, `build`, `coverage`, `.next`,
`.cache`, `target`, and `__pycache__`, so selecting one refuses with
`path-not-tracked` and a message that names the export exclusion. The host
reads the exact bytes at the selected revision through the tracked export, never
the working tree, so an uncommitted edit cannot reach the model. It then extracts a digest-bound text
derivative and seals a source binding that records the caller request, the
repository and revision, the granted read scope, the selected paths, the
original and derivative digests, the extractor identity and version, and the
span locators.

The planner and the writer receive a host-issued reader for those spans and no
path, URL, or policy they can name. Every file you select is required evidence,
and the run counts a source as read only when its steps between them read every
span of it. Before the write step writes, the host reads into the step's prompt
the spans of each selected source that no earlier step read with
`docsfab_read_source`, and records the read against that step. Those bytes
count against the write step's source-read budget,
`sources.readResponseCeilingBytes`, which is 262,144 bytes by default. A host
can raise or lower it with `DOCSFAB_SOURCES_READ_RESPONSE_CEILING_BYTES`, up to
67,108,864 bytes. When the run's model has an input window DocsFab admits
against, the budget is also at most `sources.readInputWindowShare` of that
window after its context reserve, counted at 4 bytes per token, so source text
cannot crowd a small window out. The share is 0.15 by default. With the
1,024-token context reserve `docsfab setup` writes, a 65,536-token window gets
38,707 bytes and a 128,000-token window 76,185, while windows of 437,931 tokens
and more keep the full 262,144. A host can raise the share with
`DOCSFAB_SOURCES_READ_INPUT_WINDOW_SHARE`, up to 1. An installed composition's
window counts whatever its profile metadata says. A profile that matches no
installed composition and whose metadata is unknown or stale, such as the one
`docsfab setup` writes for an endpoint that matches no installed composition,
has no window DocsFab admits against, so its budget stays at the ceiling.

A step can read a source larger than its budget by window: `docsfab_read_source`
takes a byte offset and returns whole spans from the span that holds it, with
the offset to continue from in a later step or attempt. An extracted line,
structured value, or notebook cell longer than
`sources.extractionMaxSpanBytes`, 16,384 bytes, becomes consecutive spans of at
most that size, cut between characters, so a minified file or a long JSON
string is read in windows like any other source. A read that the step's whole
budget cannot hold refuses with `budget-exhausted` and names the bytes it
needed and the limit that set the budget, with that limit's remediation; a read
that only the step's remaining budget cannot hold names what is left and
continues in a later step or attempt.

The credential screen sees every span before it counts as read. A span that
holds one of DocsFab's own configured credentials is withheld: no model sees
it, it is not charged to the budget, and it stays unread. The pieces of a line,
value, or cell split by `sources.extractionMaxSpanBytes` are screened as one
text, so a credential that crosses a cut withholds every piece of that line. A
withheld span leaves the source reported as read only in part, with the
withheld bytes named. Text that only
looks like a credential is read like any other text.

When those spans do not fit the budget together, the write step shares the
budget among the sources, smallest first, reads as much of each as fits, and
writes. The run record and the run's LIMITATIONS section then name each source
the run read only in part, with the bytes read out of its total and any bytes
withheld, and, when the budget cut the read short, the limit that set it and
the remediation. The byte counts are the source's extracted text, not the
size of the original file. The write step stops with `required-source-unread`
before it writes only when a selected source is unavailable, has no readable
span, or was never read and not one of its spans fits what is left of the
budget. Refer to
[Error Messages](../../troubleshooting.md#error-messages).

The write step cites the sentences it writes with `docsfab_cite_source`. Each
citation names the spans that support one sentence, and the host checks those
spans against the reads recorded in this run. After the step, the host checks
each sentence of the documentation the step added. A sentence counts when it
has at least `sources.claimMinWords` words, 4 by default. The host does not
check the writer's reply, such as its changed paths, open questions, or the
checks it did not run. Headings, front matter, and fenced code are not
checked, and a sentence wrapped across lines counts once.

An added sentence without a citation of the step's own does not stop the run.
DocsFab keeps the patch and records the `source-citation-gaps` limitation on
the product outcome, including when the run stops for input. The run record names each uncited sentence by page and
line, never by its text, and `PRODUCT` lists those locations. For example:

```text
Uncited sentences: write-documentation added 1 sentence with no verified source citation, at docs/whats-new.md:4.
```

Check each listed sentence against the bound sources before you publish. A
host can raise or lower the word floor from 1 through 64 with
`DOCSFAB_SOURCES_CLAIM_MIN_WORDS`.

The host refuses the run before any workflow model call when a selected path is
not tracked at the selected revision, falls outside the granted read scope, has
a media type no installed extractor claims, exceeds the admitted byte ceiling,
or extracts into a derivative that does not faithfully represent the original.
Acquisition runs after the knowledge first-pass, which is a separate preflight
step that can call the model before the workflow starts, so a refusal here does
not guarantee that no model call happened at all.

Because the knowledge first-pass runs first, it receives the same selections.
That evidence gate admits each `--source` path by its validated
repository-relative path, not by its extension, so a page you selected is
offered to the gate whatever it is called. No source binding exists yet at that
point: the host mints it later, during acquisition. The gate reads the bytes as
inert evidence and applies no extractor, so a first-pass span cites repository
lines rather than an HTML node or a PDF page. When you pass no `--source`, the
gate falls back to its own scan, which admits `.html`, `.htm`, and `.xhtml`
alongside the Markdown, configuration, and code extensions it already scanned.
Selecting one file does not admit its neighbors, and an unselected file whose
extension the scan does not list stays out.

A selection that the revision does not track, or that does not exist, stops
the run before any model call. The gate also refuses, before first pass calls
the model, a selection that sits under host state, `.git/` or `.docsfab/`.
Its scan, which ranks the files that no one named, also skips
third-party bytes, build output, and dot-prefixed directories such as
`.github/`. A selection, or a path the request names, is read wherever else it
sits, because you asked for it.

The scan skips the following two kinds of directory.

| Skipped by the scan | Where | Why |
| --- | --- | --- |
| `.git`, `.docsfab`, `node_modules`, `.venv`, `vendor`, `dist`, `build`, `coverage` | at any depth | host state, third-party bytes, and build output, which in a monorepo lives at `packages/<name>/dist` rather than at the root |
| `out`, `site`, `_site`, `public` | only at the repository root | generated-site output, such as the `site/` directory MkDocs writes by default |

The second group is anchored at the root because these are ordinary words. A
page at `docs/public/release-notes.html` or `docs/site/overview.md` is authored
documentation, and the scan reaches it. Only a build directory at the top of
the repository is skipped. Names are compared without regard to case, so
`SITE/` is skipped exactly as `site/` is. The workspace that DocsFab exports
from the revision also leaves out credential-bearing and generated paths, such
as `build/`, `dist/`, and `node_modules/`, so a selection there is not tracked
in the export and is refused.

If the selected evidence does not substantively support a mandatory
obligation, the run goes on with the evidence that first pass gathered. It
records a `first-pass-evidence-gaps` limitation that names each unresolved
obligation, how first pass ended, and each limit that it reached, in both the
human output and the `--json` object. An evidence gap alone does not stop the
run. It stops before the workflow starts when the request or a selection names
a file that first pass cannot read and an obligation stays unresolved, or when
sources disagree. Those stops use `insufficient-evidence`, `budget-exhausted`,
or `contradicted`. Refer to
[Operational Limits in DocsFab](operational-limits.md).

Extraction also runs under a wall-clock budget of 30 seconds per file. If it
fires, the run refuses with its own message naming that budget and the file, and
nothing is bound. That is deliberately not reported as an extractor limitation:
the same document can bind perfectly given more time, so the message tells you
the host ran out of budget rather than claiming DocsFab could not read your
file. There is no flag for the budget.

A fixed extension allowlist selects the extractor. DocsFab accepts these tracked
source extensions: `.diff`, `.docx`, `.htm`, `.html`, `.ipynb`, `.js`, `.json`, `.markdown`, `.md`, `.mdx`,
`.patch`, `.pdf`, `.toml`, `.ts`, `.txt`, `.xhtml`, `.yaml`, and `.yml`. Each
one maps to one registered extractor, as the following table shows.

| Extension | Media type | What a span cites |
| --- | --- | --- |
| `.diff`, `.patch` | `text/x-diff` | the diff's manifest, one file's header, one hunk, or one whole file (`diff`) |
| `.html`, `.htm`, `.xhtml` | `text/html`, `application/xhtml+xml` | one HTML node (`html-node`) |
| `.docx` | Word (`…wordprocessingml.document`) | one body paragraph or table cell (`docx-block`) |
| `.pdf` | `application/pdf` | one page's text (`pdf-page`) |
| `.ipynb` | `application/x-ipynb+json` | one notebook cell (`notebook-cell`) |
| `.json`, `.yaml`, `.yml` | `application/json`, `application/yaml` | one structured node (`json-pointer`) |
| `.js`, `.markdown`, `.md`, `.mdx`, `.toml`, `.ts`, `.txt` | `text/javascript`, `text/markdown`, `text/markdown`, `text/mdx` (DocsFab-specific MDX identifier), `application/toml`, `text/x-typescript`, `text/plain` | one text block (`text`) |

Any other extension is refused rather than guessed at; there is no content
sniffing. The extension only decides which extractor is offered the bytes, so a
file whose extension disagrees with its contents is refused by that extractor
rather than handed to another one.

Extraction is text only, and it is honest about what it could not read. Script,
hidden, and non-text content, a Word macro or content control, and a PDF form
or image-only page are excluded and named, and the run refuses rather than
binding a source whose derivative would understate the original.

To discover what it may read, a step calls `docsfab_list_sources`. That tool
returns the observation, representation, and span identifiers admitted to the
current step, together with each span's repository path, media type, byte range,
and locator, and one row per representation with its span count and bytes. It
never returns source text. The step then passes those exact identifiers to
`docsfab_read_source`, which returns the bytes. A step can also read a window
of a representation by byte offset: `fromByte`, with an optional `maxBytes`,
returns whole spans from that offset, each identifier beside its text, while
they fit `maxBytes` and the step's remaining read budget, and `nextFromByte` to
continue from in a later call, step, or attempt. `maxBytes` defaults to the
per-call tool output cap, 32,768 bytes unless the host sets
`DOCSFAB_TOOL_OUTPUT_CAP_BYTES`. A source larger than one read is therefore read
in windows. A window skips a span the credential screen withholds and lists it
in `withheldSpanIds`. Neither tool accepts a path, a URL, or a policy, so a
model cannot name a source the run did not bind.

The planner and the writer can also read the local checkout's git history
behind the pinned revision with `docsfab_history_diff`, `docsfab_history_show`,
`docsfab_history_log`, `docsfab_history_search`, and `docsfab_history_blame`, when `docsfab run` materializes the workspace from
that checkout. Each served page is cited in the step's tool activity. Refer to
[Git History Tools in DocsFab](../knowledge-and-delivery/git-history-tools.md).

A unified diff (`.diff` or `.patch`, such as `git diff` output or a
`git format-patch` patch or series) opens with a manifest, so a window from
byte 0 reads it first. The manifest has one row per file with its number,
change kind (`added`, `deleted`, `modified`, `renamed`, or `copied`), paths,
added and removed line counts, hunk count, and labels: `binary`, `non-utf8`,
`combined`, `lockfile`, `vendored`, `generated`, or `unrepresentable-path`.
Each path in a row is double-quoted, so path text cannot read as counts or
labels:

```text
diff manifest: 2 files, 3 hunks, +3 -2 lines; 1 message
file 1: modified "src/export.ts"; +2 -2; 2 hunks
file 2: modified "dist/export.min.js"; +1 -0; 1 hunk; labels: generated
```

Each patch's message and each file's header lines and hunks are then spans of
their own, in the diff's order. Every span but the manifest is the exact slice
of the diff file that its locator's `startByte` and `endByte` name, line endings
included. Each `diff` locator names the file number, its old and new paths,
and, for a hunk, the hunk number with the old and new start line and line count
from its `@@` header. `docsfab_list_sources` reports the file count as
`diffFiles`.
`docsfab_read_source` takes `diffFile`, a file number from the manifest, and
optionally `diffHunk`, a hunk number within that file, to read one file or one
hunk. The read stops at the end of that file or hunk. When the file or hunk is
larger than `maxBytes`, pass the returned `nextFromByte` as `fromByte` with the
same `diffFile` and `diffHunk` to read on. When per-hunk spans would pass
`sources.extractionMaxSpans`, the files with the most hunks are read as one
span each, and a hunk request for such a file returns the whole file. DocsFab
does not extract the encoded payload of a Git binary patch or other text that
is not UTF-8, such as a hunk body, a combined diff body, or a patch message. It
labels the file, counts what it left out in the manifest, and records
`non-text-content-excluded`, so the diff still binds and its coverage is
reported as `partial`. A file header line, such as `diff --git` or `+++`, that
is not UTF-8 refuses the diff with `extractor-limitation`. A path that holds a
control or bidirectional-format character, a backslash, a drive letter, or
bytes that are not UTF-8 is not carried: the file is labeled
`unrepresentable-path` and the manifest shows `(path not carried)`.

`--source` is accepted by `create-documentation` and `update-documentation`,
and it cannot be combined with `--resume-from`. Refer to
[Bind Tracked Source Files to an Update](../../workflows/select-sources.md#bind-the-selection-to-a-job)
for the update-side conditions. Add `--json` when a script or an agent
consumes the result. `docsfab run` refuses `--json` and `--verbose` together, so
use one or the other, as
[Human Output and `--json`](human-output-and-json.md#human-output-and---json)
describes.

## Update Evidence Bindings

`--source` and `--reader-source` are different surfaces. `--reader-source`
nominates tracked text the reader-context observer reads and hashes, while
`--source` mints the run's source binding and issues the host reader the
granted steps use. The binding contract, the acquisition refusals, and the
reader tools are the ones
[Bind Tracked Source Evidence](source-evidence.md#source-binding)
describes; an update run uses the same host producer and the same refusals.
One run carries one source binding. `--source` therefore does not combine with
`--resume-from`, and it does not combine with a date-scoped instruction, which
mints the binding from the merge requests it discovers. Both refusals name the
condition and the change that clears it. `--dry-run` parses the selection and
stops before the host opens any source body.

`--source` and `--change` combine with `--revision`, `--comparison-base`,
`--comparison-workspace`, and `--reader-source`. The source binding commits to
the comparison and reader-source nominations the run admitted, so a binding
minted for one comparison cannot be replayed against another.

A comparison does not give the planner a diff to read. To bind the change
itself, name it with `--change`, as
[Bind a Local Commit Range to an Update](../../workflows/bind-commit-range.md#workflow-evidence)
describes, or commit it as a unified diff, such as `git diff <base> <head>` or
`git format-patch` output in a `.diff` or `.patch` file, and pass that file
with `--source`. Its first spans are a manifest of every file, and
`docsfab_read_source` reads one file or hunk by its manifest number, as
[Bind Tracked Source Evidence](source-evidence.md#source-binding)
describes. A committed diff file is a tracked source, so it binds whole or
refuses: past `sources.extractionMaxOriginalBytes`,
`sources.extractionMaxDerivativeBytes`, or `sources.extractionMaxSpans`, it
stops at bind with `input-over-limit` and the line that names the bound,
rather than binding in part as a merged merge request's diff does.
