---
title: "Bind a Local Commit Range in DocsFab"
description: "Ground a create or update job on an explicit local Git commit range."
status: draft
content.type: how-to
---

Ground a create or update job on an explicit local Git commit range.

## Prerequisites

Keep both range endpoints in the selected checkout's local Git history. Configure a model and choose a create or update workflow.

## Bind a Local Commit Range

Use `--change <range>` on `docsfab run create-documentation` or
`docsfab run update-documentation` to ground the run on a code change in the
checkout's own history, such as your last commit:

```bash
docsfab run update-documentation --repo /absolute/path/to/repository \
  --instruction "Update the export guide for this change." \
  --change HEAD~1..HEAD --patch-only
```

The option accepts the following three forms.

| Form | What the run binds |
| --- | --- |
| `<base>..<head>` | The diff from `base` to `head`, and the commits on `head` that `base` lacks. |
| `<base>...<head>` | The diff from the merge base of the two to `head`, and the commits on `head` since that merge base. |
| `<commit>` | That one commit, diffed against its first parent. A root commit is diffed against the empty tree. |

An endpoint is a branch, tag, or commit name, optionally followed by `~N` or
`^N`. DocsFab records every endpoint as its full object id. It refuses open
ranges such as `main..`, `^!` and `^@` suffixes, reflog forms such as
`HEAD@{1}`, and `:/text` or `<rev>:<path>` names with
`change-source-selector-grammar`. A GitLab merge request reference binds that
merge request's diff instead; refer to
[Bind a GitLab Merge Request's Diff](bind-gitlab-change.md#bind-a-gitlab-merge-requests-diff). A
github.com pull request, commit, or compare URL is read from GitHub instead;
refer to
[Bind a GitHub Pull Request, Commit, or Compare](bind-github-change.md#bind-a-github-pull-request-commit-or-compare).
A GitLab compare URL, a URL on any other host, or a scheme-less forge path
refuses with `change-source-kind-unsupported`.

Before any model call, DocsFab resolves the range in the checkout's object
database, re-hashes every commit in it and both root trees of the diff, and
checks the range against its bounds. It reads history with git plumbing only,
never fetches, and writes nothing to the checkout while it reads the range. It
ignores the repository-local diff settings porcelain `git diff` reads,
working-tree attributes, replace refs, and the commit-graph. It then
binds two required observations: the unified diff and a manifest of the
commits and changed paths. A step that has not read them cannot write. The
diff reads like a committed `.diff` file: its first spans list every changed
file, and `docsfab_read_source` reads one file or hunk by number. The
run record names the bound change in its `changeSources` field: the pinned
revision, the sealed change record's digest, its labels and counts, and the
ids of both observations, but no commit subject, path, or diff text.

The following conditions stop the run before any model call, each with its own code:

- A tampered object refuses with `change-source-integrity-mismatch` and names
  the object's role.
- In a shallow clone, the diff of a `<base>..<head>` range or of a single
  commit stays exact or the range refuses with
  `change-source-history-unavailable`. Such a diff reads only its two
  endpoint commits, so it refuses with this code only when one of them lies
  past the clone's boundary. A `<base>...<head>` range also needs the merge
  base, so it refuses with the same code when git finds none or more than
  one, or when the clone's boundary could hide a newer one. These checks are
  not a proof that every hidden merge base is caught: unshallow the clone, or
  use `<base>..<head>`, when a three-dot diff must be exact. A commit off the
  boundary that names a missing parent is a damaged object database and
  refuses with `change-source-revision-unresolved`.
- A name that does not resolve refuses with `change-source-revision-unresolved`.
- A grafts file refuses with `change-source-grafts-present`.
- A path or diff that is not valid UTF-8 refuses with
  `change-source-encoding-unsupported`.
- One of DocsFab's own configured credentials in the change, including a
  commit subject or a path, refuses with `change-source-credential-present`.
- `base` equal to `head` refuses with `change-source-empty-range`. A range
  whose trees are identical, such as a revert pair, is accepted as a verified
  no-change.

The range is bounded by `changeSources.commitsMax` (256 commits),
`changeSources.changedFilesMax` (512 paths), and `changeSources.diffMaxBytes`
(262,144 bytes). Each has a host override, `DOCSFAB_CHANGE_SOURCES_COMMITS_MAX`,
`DOCSFAB_CHANGE_SOURCES_CHANGED_FILES_MAX`, and
`DOCSFAB_CHANGE_SOURCES_DIFF_MAX_BYTES`. A range over a bound refuses and names
the bound and the observed value. In a shallow clone, the walk over boundary
commits behind the diff base crosses at most
`changeSources.shallowBoundaryCommitsMax` (64 boundary commits,
`DOCSFAB_CHANGE_SOURCES_SHALLOW_BOUNDARY_COMMITS_MAX`); one more refuses with
`change-source-shallow-boundary-bound`. One file whose diff exceeds
`changeSources.fileDiffMaxBytes` (131,072 bytes,
`DOCSFAB_CHANGE_SOURCES_FILE_DIFF_MAX_BYTES`), such as a lockfile, does not stop
the run: its diff is left out, it stays listed in the manifest with its size,
and the run's status output names it. Long paths or commit subjects can make
the manifest too large to extract whole; that refuses before any model call
with the source extraction limit it crosses, such as
`sources.extractionMaxDerivativeBytes`, and the manifest's size.

A `<base>..<head>` range whose `base` is not an ancestor of `head`, such as a
reversed range, also undoes the changes only `base` has. It is accepted with
the manifest label `base-not-ancestor-of-head`.

In a shallow clone, git treats each commit at the clone's boundary as having
no parents, so its commit list for a range can be short or can include the
base's own history. DocsFab follows the parents recorded in each boundary
commit behind the diff base and leaves out the base history it finds there.
Where it cannot prove the list exact, it accepts the range with a manifest
label instead of refusing, because the diff is still exact. The following table lists the labels.

| Label | Meaning |
| --- | --- |
| `commit-list-incomplete-shallow` | The list may miss commits of the range behind a boundary commit. `base-not-ancestor-of-head` is not decided and is left off. |
| `commit-list-may-include-base-history` | Some listed commits are not proven to descend from the base and may be its own history. Each commit in the manifest then carries `descendsFromDiffBase`, and `false` marks those. |

`git fetch --unshallow` removes both labels; deepening the clone removes them
when it brings the missing history. A linear range inside a depth-only CI
clone carries neither. A merge range such as `HEAD~1..HEAD`, whose merged
branch forked below the clone's depth, is accepted with a label;
`HEAD~1...HEAD` of the same shape refuses, and `--change HEAD` binds the merge
against its first parent with no label.

`--change` combines with `--source`, and the run then binds both. It combines
with `--revision`, which still selects the tree the run documents. On
`update-documentation` it also combines with `--comparison-base` or
`--comparison-workspace`: the run binds the change and keeps the comparison as
reader evidence, and records both. The change and the comparison are
independent: DocsFab does not check whether the comparison base, the change,
and `--revision` share history. A change read from this checkout whose head is
outside `--revision`'s history carries the `head-not-ancestor-of-workspace`
label instead of refusing. `--change` does not
combine with `--pr` or `--mr`, with `--resume-from`, or with an
`update-documentation` instruction that names merge requests by a merged-on
date window. Other workflows refuse it, and so do `docsfab live-agent` and
`docsfab sources`. `--dry-run` parses the range without reading git.

```bash
docsfab run update-documentation --instruction "Update the export guide." \
  --change HEAD~1..HEAD \
  --revision <head-object-id> --comparison-base <base-object-id>
```

`docsfab do` accepts `--change` too, with every value `docsfab run --change`
accepts: a local commit range, a GitLab merge request, or a GitHub URL for a
pull request, commit, or compare, or a release range, as the next three
sections describe. The quoted sentence still chooses the workflow:

```bash
docsfab do "Update the export guide for my last commit." \
  --change HEAD~1..HEAD --patch-only
```

The change never changes the route, the admission offer, or the request text.
When the sentence routes to `create-documentation` or `update-documentation`,
`do` hands the value to the run path `docsfab run` uses, so the same value
binds the same evidence and stops with the same codes. Any other route stops
with `change-source-workflow-unsupported` and names the routed workflow; with
`--source` beside the change, `source-route-unsupported` stops first.
`--route-only` and `--dry-run` parse the value without reading git, GitLab, or
GitHub. `do` has no comparison options: use `docsfab run update-documentation`
to bind a change beside a comparison. A continued run binds only the stopped
run's own change, so `do` refuses `--change` with `--continue` or `--attach`,
and when an open editorial needs-input run for the repository would take the
sentence as its reply, with
`change-source-resume-unsupported`. Delegated `do` refuses `--change`. When
the configured model classifies a sentence the table cannot, that one
tool-free admission call reads only the sentence and comes before the range is
resolved; a bad value then stops after that call, before request
interpretation or any workflow step.

## Workflow Evidence

A create run can ground a new page on the bound unified diff and commit manifest. For updates, `--change` can combine with `--source`, `--comparison-base`, or `--comparison-workspace`. The change and comparison remain distinct reader evidence; a comparison alone does not supply a diff.
