---
title: "Select Source Evidence in DocsFab"
description: "Preview the source files and merge-request evidence an invocation binds before running a documentation job."
status: draft
content.type: how-to
---

Preview the source files and merge-request evidence an invocation binds before running a documentation job.

## Prerequisites

Commit the files you want to bind and select the repository revision. Configure a model before running a create or update job; source preview alone does not call one.

## Bind the Selection to a Job

The `sources` commands preview one invocation's selection. They do not save a selection for a later process. Pass the chosen files to the job itself:

```bash
docsfab run create-documentation --repo /absolute/path/to/repository \
  --instruction "Create docs/whats-new.md from the release notes." \
  --source docs/release-notes.html --patch-only
```

For existing documentation, select `update-documentation` and name the page to change. Repeat `--source` for each required tracked file. The job reads the selected revision, so commit source changes before binding them.

Inspect the saved run's source coverage and LIMITATIONS. A partially read source remains partial. Refer to [Tracked Source Evidence Reference](../reference/status-and-configuration/source-evidence.md) for supported formats, extraction limits, and citation tools.

## Check a Source Selection

Use `docsfab sources` to see what a selection binds before you spend a run on
it. The command assembles the selection from the same `--source` and `--pr`
options `docsfab run`, `docsfab do`, and `docsfab live-agent` accept, applies
one verb to it, and prints the result:

```bash
docsfab sources list --repo /absolute/path/to/repository \
  --source docs/release-notes.md --pr 843
```

The `change request` label identifies the selected source category. A listing
makes no claim about its current merge state. The workflow you run enforces
its source requirements.

The verbs are `list`, `add`, `show`, `refresh`, `revalidate`, `remove`,
`search`, and `purge`. Run
`docsfab sources --help` for the exact forms. A label is exactly what the
listing printed, matched byte for byte, and an argument is read literally:
DocsFab performs no shell expansion, no command substitution, and no globbing
on it.

The following three properties make this surface safe to rely on:

- Every verb but `purge` is held for that one invocation. The selection is
  written nowhere, so a
  second `docsfab sources` command, a saved run, and a live conversation each
  start from their own options. Pass the selection you checked to the command
  that does the work. `purge` is the exception, and the command says so: what
  it deletes and the custody record it appends outlive the invocation.
- `docsfab sources` and the live terminal's `/sources` commands are the same
  command family over the same selection state. For the same selection and the
  same verb, they produce the same listing, the same versions, the same coded
  refusals, and the same evidence on the next bounded run.
- Every stop names the failing condition and the change that clears it, and
  binds nothing. An unknown verb, an unknown `--` option, a path outside the
  selected repository, a reference that reads as a host location or as
  credential material, and a second change request are each refused rather than
  ignored. `docsfab run` also refuses an unknown `--` option with code
  `unknown-option` and lists the accepted run options rather than proceeding as
  if the token were never typed. Its `Next action`, and `nextAction` in the
  `--json` error envelope, is to run `docsfab run --help`, then correct or
  remove the option.

Because an option is refused rather than read as a name, three source names
cannot be typed at this command: `-h`, `--help`, and any name beginning with
two dashes. Each attempt stops with a coded message and selects nothing. Select
such a file from the live terminal instead, where no token is an option.

`show` and `refresh` read the file at the revision the checkout has committed,
not your working tree. `search` needs a host-wired discovery port that this
release does not provide, so it refuses and says so at both surfaces.

`revalidate` checks where `refresh` adopts. It re-reads each selected file and
re-resolves each selected change request against the forge, compares what it
finds against what was admitted, and reports one coded state per source —
`fresh`, `stale`, `missing`, `unreadable`, or `identity-changed` — beside the
*basis* it reached that state on. `missing` means the repository no longer
tracks it at that revision; `unreadable` means it is still there and its bytes
did not arrive, which is a per-source state so one oversized file does not stop
the other sources being re-checked. `identity-changed` is reserved for a forge
answer that names a different project; a forge that cannot answer stops the
command instead of being reported as an answer. It moves no version and detaches
nothing, so a source it reports as stale stays stale in the listing until you
refresh or remove it. A live bounded run then refuses that last verdict rather
than binding the recorded bytes; a `fresh` verdict older than the revalidation
window is the same stop under a distinct expired refusal, so ageing is not
reported as drift. A `docsfab sources` invocation starts no run, so those bind
refusals are live-only. It also never reports on a subset: more selected sources
than one command re-checks, an unwired reader, and a forge that cannot answer
each refuse the whole command and record nothing, naming the bound and the
observed count where one applies. Because a `docsfab sources` selection is held
for one invocation and one verb, a command-line revalidation has no earlier
version of its own to contradict and reports a first observation; `stale` is
reached in a live conversation, which can refresh and then revalidate the same
selection.

For human output and `docsfab run --json` result shapes, refer to [Human Output and JSON in DocsFab](../reference/status-and-configuration/human-output-and-json.md).
