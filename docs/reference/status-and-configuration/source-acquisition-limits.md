---
title: "Source Acquisition Limits in DocsFab"
description: "Look up source-read, extraction, repository inventory, workspace export, and first-pass evidence budgets."
status: draft
content.type: reference
---

Look up source-read, extraction, repository inventory, workspace export, and first-pass evidence budgets.

Source-read, repository inventory, and navigation budgets live in the same
catalog: `sources.readResponseCeilingBytes`,
`sources.extractionMaxOriginalBytes`, `sources.extractionMaxDerivativeBytes`,
`sources.extractionMaxSpans`, `sources.extractionMaxMs`, `sources.pdfMaxPages`,
`repository.inventoryMaxEntries`, and `repository.navigationMax*`. A host
override may only lower them, except four. The per-step source-read budget,
`sources.readResponseCeilingBytes`, is 262,144 bytes by default, and
`DOCSFAB_SOURCES_READ_RESPONSE_CEILING_BYTES` can raise it to 67,108,864 bytes
or lower it. A run whose model has an attested input window also caps the
budget at `sources.readInputWindowShare` of that window after its reserve, at
4 bytes per token: 0.15 by default, raisable to 1 with
`DOCSFAB_SOURCES_READ_INPUT_WINDOW_SHARE`. An installed composition's window
counts whatever its profile metadata says. A profile that matches no installed
composition and whose metadata is unknown or stale, such as the placeholder
`docsfab setup` writes for an endpoint that matches no installed composition,
has no attested window. The extraction ceilings
`sources.extractionMaxOriginalBytes`, 4,194,304 bytes by default, and
`sources.extractionMaxDerivativeBytes`, 1,048,576 bytes, can be raised to
67,108,864 bytes, the byte length the source-evidence contract admits, with
`DOCSFAB_SOURCES_EXTRACTION_MAX_ORIGINAL_BYTES` and
`DOCSFAB_SOURCES_EXTRACTION_MAX_DERIVATIVE_BYTES`, in the environment or the
configuration root's `.env`. An original past its ceiling is refused before
extraction, and the refusal names `sources-extraction-max-original-bytes-bound`,
the bytes observed, the bound in force, and the override. The repository
inventory entry limit, `repository.inventoryMaxEntries`, is 20,000 entries by
default, and `DOCSFAB_REPOSITORY_INVENTORY_MAX_ENTRIES` can raise it as far as
the workspace export's tree-entry ceiling,
`repository.workspaceExportMaxTreeEntries`, can be raised: both share the
override parser's maximum, so a raised export ceiling never leaves the
inventory capped below it. The filesystem-only search walk uses the same
limit. Inventory and navigation overflow record a named failure on the sealed
observation. A governed workflow search past
`repository.inventoryMaxEntries` continues with an incomplete-index limitation
instead of stopping, and the run's LIMITATIONS name the limit, the observed
entry count, and the remediation. PDF page overflow and extraction derivative
or span overflow record `over-page-limit`, `byte-budget-truncated`, or
`span-budget-truncated`, so the operator summary cannot silently clip. A
required source that a write step can read only in part within its source-read
budget is reported the same way: `source-read-partial` lines in the run
record's evidence warnings and in LIMITATIONS name the source, the bytes read
out of its total, the budget, and the remediation.
`createSourceStepPolicy` refuses a requested per-step read budget above the
catalog ceiling rather than clamping it. A retry restores that per-step grant;
it does not inherit bytes a prior failed attempt already spent.
`sources.extractionMaxSpanBytes`, 16,384 bytes, has no host override. An
extracted line, structured value, or notebook cell longer than it becomes
consecutive spans, so a step reads it by window rather than meeting one span
larger than its budget. A single source read that the step's whole budget
cannot hold refuses with `budget-exhausted`, the bytes it needed, and the
limit that set the budget with its remediation.
A unified diff bound with `--source` adds no limit of its own. It keeps one span
per hunk while its spans fit `sources.extractionMaxSpans`, and past that it
reads the files with the most hunks as one span each. A diff that still needs
more spans, or that passes either extraction byte ceiling, is refused at bind
with `input-over-limit` and the line that names the bound, rather than bound in
part. Its locator paths share `sources.authorityMemberPathMaxChars`, the bound
sealed evidence uses for repository paths; a longer path is carried as `null`
and the file is labeled `unrepresentable-path`.

The workspace export that a live `do` or `run` performs before any model call
uses five limits from the same catalog. A host override may raise or lower each
one within its catalog range, and `docsfab doctor --limits` shows the effective
value. The following list describes the five limits:

- `repository.workspaceExportStallMs` (120,000 ms) is a no-progress window,
  not a wall clock. Each finished Git read, chunk of the tree listing, created
  directory, written chunk of file bytes, and verified file restarts it, so an
  export that keeps making progress is never stopped, however large the tree.
  An export that makes no progress for the whole window stops with
  `per-blob-timeout` while a file's bytes are streaming from Git, and with
  `aggregate-timeout` anywhere else. Override it with
  `DOCSFAB_REPOSITORY_WORKSPACE_EXPORT_STALL_MS`.
- `repository.workspaceExportMaxTreeEntries` (100,000 files),
  `repository.workspaceExportMaxAggregateBytes` (2 GiB),
  `repository.workspaceExportMaxScratchBytes` (3 GiB), and
  `repository.workspaceExportMaxTreeMetadataBytes` (32 MiB) bound the tracked
  tree. Crossing one stops with `file-count-limit`, `aggregate-byte-limit`,
  `scratch-space-limit`, or `tree-metadata-limit`. Override them with
  `DOCSFAB_REPOSITORY_WORKSPACE_EXPORT_MAX_TREE_ENTRIES`,
  `DOCSFAB_REPOSITORY_WORKSPACE_EXPORT_MAX_AGGREGATE_BYTES`,
  `DOCSFAB_REPOSITORY_WORKSPACE_EXPORT_MAX_SCRATCH_BYTES`, and
  `DOCSFAB_REPOSITORY_WORKSPACE_EXPORT_MAX_TREE_METADATA_BYTES`. The
  checked-tree walk for required checks and the original source authority
  read the same entry and byte limits, so a raise reaches them too.

Each export stop names its code, the phase, the observed value, the limit's
refusal code and name, and the override that changes it.

`sources.claimMinWords` is the word floor for source citations. A sentence that
a citing write step adds to documentation is checked for a citation when it has
at least this many words, 4 by default. A host can raise or lower it from 1
through 64 with `DOCSFAB_SOURCES_CLAIM_MIN_WORDS`, and a value outside that
range refuses at startup. An uncited sentence is recorded as the
`source-citation-gaps` limitation and never stops the run. Refer to
[Bind Tracked Source Evidence](source-evidence.md#source-binding).

First-pass support, which checks repository evidence before an ordinary
create or update runs, has its own limits in the same catalog, and
`docsfab doctor --limits` lists them as `firstPass.*`. A host can raise or
lower each one, up to its catalog maximum, with the setting in the following
table.

<Markdown src="operational-limits-tables/first-pass-settings.md" />

The defaults fit repositories of 1,000 to 10,000 tracked files. First pass
lists every tracked file of the selected revision, reads the sources a request
names first, and ranks the rest. Each assessment round reads an even share of
`firstPass.maxSourceFiles`, and by default that share is 64 files a round, so
raise `DOCSFAB_FIRST_PASS_MAX_SOURCE_FILES` together with
`DOCSFAB_FIRST_PASS_EVIDENCE_EXPANSION_MODEL_TURNS`. A host raises a setting to
its catalog maximum, for example `DOCSFAB_FIRST_PASS_MAX_SOURCE_FILES=512`, and
`docsfab doctor --limits` then shows the raised value.

The bound model's input window sets the size of one assessment prompt, the way
`sources.readInputWindowShare` sizes the source reads of a workflow step. The
prompt counts the request, its obligations, and every evidence span with its
frame. It is at most the smallest of the following values:

- `firstPass.assessmentInputWindowShare` of the input window DocsFab admits
  for the bound model, after its context reserve, at three bytes per token.
  With the 4,096-token context reserve of the shipped profiles, the default
  share of 0.75 gives a 1,050,000-token window a prompt of 2,353,284 bytes and
  a 128,000-token window a prompt of 278,784 bytes. The 1,024-token reserve
  that `docsfab setup` writes for a custom endpoint adds 6,912 bytes.
- One turn's input share, `firstPass.modelInputTokensPerTurn`, at three bytes
  per token. Its default is the largest input window of an installed
  composition, so it binds only when a host lowers it to cap input cost.
- The ceiling, `firstPass.maxPresentedBytes`. Its default is above the input
  window of every installed composition, so it binds only when a host lowers
  it.

Windows under about 353,600 tokens get a smaller prompt than the former fixed
bound of 786,432 bytes. At 128,000 tokens the prompt is 278,784 bytes, against
384,000 before, and a share of 1 gives 371,712 bytes, because the context
reserve now counts. A model without an attested input window, such as an
endpoint that matches no installed composition, gets one turn's input share
as its window, so set `DOCSFAB_FIRST_PASS_MODEL_INPUT_TOKENS_PER_TURN` to that
endpoint's input window.

Five installed compositions combine an input window of 262,144 tokens or more
with a 5-minute attempt timer: `nvidia-nemotron-3-super-120b-a12b-pi`,
`nvidia-inference-nemotron-3-super-v3-pi`, `nvidia-inference-nemotron-3-ultra-pi`,
`nvidia-inference-deepseek-v4-pro-pi`, and `nvidia-inference-qwen3-5-397b-a17b-pi`.
When a run selects one of them with `--composition`, that timer bounds every
first-pass model call. First pass now sends larger prompts over up to seven
rounds, so it can stop at that deadline. Name the sources the request needs,
or lower `DOCSFAB_FIRST_PASS_ASSESSMENT_INPUT_WINDOW_SHARE` for those runs.

When the prompt bound stops a run, the message names the setting that set the
bound, and the next action names its host override. When the window share is
already 1, the next action names a larger input window instead. When a stop
names the round allowance, the next action also names
`DOCSFAB_FIRST_PASS_MAX_SOURCE_FILES`, because each round reads an even share
of it. When the prompt is full, first pass stops reading ranked files, still
reads the sources the request names, and records how many candidate source
files it left unread.

First pass reads more only while a round reduces the number of open
obligations, or while an open obligation names a file it has not read, so most
first passes end well inside these bounds. When a first-pass bound refuses a
read while a mandatory obligation is unresolved, the run still continues with
the evidence first pass gathered. A `first-pass-evidence-gaps` line in the
PREFLIGHT status, the run summary's LIMITATIONS, and `docsfab runs show` names
each bound, the demand it refused, its limit, the setting behind it, and how
far the host override can raise it. Further lines count the files the bound
left unread and name each one the request named by path. `--json` lists
`first-pass-evidence-gaps` in `product.limitations`. When every obligation is
still supported, the run prints each bound as a limitation, with how to raise
it.

First pass also holds sealed bounds. They are part of the first-pass support
record, so no host setting changes them, and `docsfab doctor --limits` lists
them with the others. The following table lists the sealed bounds.

<Markdown src="operational-limits-tables/first-pass-sealed-settings.md" />

A constraint that a request intent quotes becomes one obligation, recorded
whole. When the constraint as written is longer than
`firstPass.maxObligationConditionChars`, first pass stops before any model
call with `first-pass-max-obligation-condition-chars-bound` and failure class
`bound`. The message names the constraint, its length, and the bound. State
that constraint in a shorter sentence, then run again.

Native composition preflight records the actual process duration, stdout
byte count, and stderr byte count, including values over the catalog
bound. It never replaces those measurements with a clipped figure. When
recorded duration or byte counts exceed
`nativePreflight.recordedDurationMs`,
`nativePreflight.recordedStdoutBytes`, or
`nativePreflight.recordedStderrBytes`, the observation keeps the measured
number, stores a limit notice that names the catalog key, observed value,
and source process, and uses terminal code `evidence-limit` unless a more
specific process status such as `output-limit` or `timeout` already
applies. Capture overflow keeps the overflow flags on the persisted
process evidence. A host may shrink those bounds with
`DOCSFAB_NATIVE_PREFLIGHT_TIMEOUT_MS`,
`DOCSFAB_NATIVE_PREFLIGHT_VERSION_STDOUT_BYTES`,
`DOCSFAB_NATIVE_PREFLIGHT_AUTHENTICATION_STDOUT_BYTES`,
`DOCSFAB_NATIVE_PREFLIGHT_CATALOG_STDOUT_BYTES`,
`DOCSFAB_NATIVE_PREFLIGHT_MAX_STDERR_BYTES`,
`DOCSFAB_NATIVE_PREFLIGHT_RECORDED_DURATION_MS`,
`DOCSFAB_NATIVE_PREFLIGHT_RECORDED_STDOUT_BYTES`, and
`DOCSFAB_NATIVE_PREFLIGHT_RECORDED_STDERR_BYTES`. Each override is parsed
at startup and must stay within the catalog `[min, max]` range. A
malformed or raised value refuses to start.

Each git command that records a run's workspace evidence (the baseline
`git add` and commit when the run starts, and the `git add` and diffs that
capture its changes) runs under two limits from the same catalog:
`repository.evidenceGitTimeoutMs` (600,000 ms, 10 minutes) and
`repository.evidenceGitOutputMaxBytes` (50 MiB on each output stream). A
host may raise or lower them with
`DOCSFAB_REPOSITORY_EVIDENCE_GIT_TIMEOUT_MS` and
`DOCSFAB_REPOSITORY_EVIDENCE_GIT_OUTPUT_MAX_BYTES`. Hosted attempts run in a
sandbox that does not receive host overrides, so they keep the catalog
defaults. A command that runs one millisecond longer, or writes one byte
more, is killed and stops with the limit's refusal code,
`repository-evidence-git-timeout-ms-bound` or
`repository-evidence-git-output-max-bytes-bound`. The message names the
observed value, the limit, the override, and the git operation. A stop in
the baseline, when the run starts, reaches the CLI in failure class
`bound`. A stop while capturing a run's changes leaves the same text in the
run record's evidence warning. A run with a write step then fails as
`patch-persistence-failed`, which is the code `docsfab why` reports. In a
hosted attempt, the run's failure code is not the limit's refusal code.
