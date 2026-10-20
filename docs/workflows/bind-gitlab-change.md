---
title: "Bind a GitLab Change in DocsFab"
description: "Ground a create or update job on one GitLab merge request and its immutable diff."
status: draft
content.type: how-to
---

Ground a create or update job on one GitLab merge request and its immutable diff.

## Prerequisites

Select the target GitLab project and authenticate for its read access. Keep the merge-request identity and target repository available.

## Bind a GitLab Merge Request's Diff

Use `--change <merge request>` on `docsfab run create-documentation` or
`docsfab run update-documentation` to ground the run on a GitLab merge
request's diff:

```bash
docsfab run update-documentation --repo /absolute/path/to/repository \
  --instruction "Update the export guide for this change." \
  --change https://gitlab.example.com/group/project/-/merge_requests/123 \
  --patch-only
```

`--change` accepts the merge request's URL, a `host/group/project!number`
reference, or `!number` for the project this checkout's GitLab remote points
at. A bare number stays a commit name. `docsfab run --mr <reference>`, or
`--pr`, accepts the same forms, takes a bare number as this checkout's merge
request, and binds the same evidence. The two options do not combine.

Before any model call, DocsFab reads the merge request once through your
existing `glab` login to pin its commits, then reads the diff from the
checkout's own objects, with the checks a local range gets. When the
checkout lacks an object that diff reads, it reads the diff from GitLab
instead, as described below. It never fetches. The diff it binds follows GitLab's merge request diff, as the following table
shows.

| Merge request | What the run binds |
| --- | --- |
| Open, draft included | The diff from the merge request's base commit to its head commit, the commits between them, and the label `merge-request-unmerged`. The merge request's text is not bound, because an open merge request's text can still change; the run's status output says so. |
| Merged with a merge commit | The merge commit diffed against its first parent, and its text. |
| Merged as a squash commit | The squash commit diffed against its first parent, and its text. |
| Merged by fast-forward | The diff from its base commit to its head commit, the commits between them, and its text. |

The run records the GitLab project, by host and numeric project identifier,
as the repository the change belongs to. A merge request from another
project, including a fork, binds the same way.

When the checkout lacks a commit the diff reads, or, in a partial clone, a
tree or file version, DocsFab reads the diff from GitLab through the same
`glab` login instead: the merge request's own diff and commits for an open or
fast-forward merged merge request, or the merge or squash commit and its diff
otherwise, then the merge request again to check it did not move. The run's
status output says the diff was read from GitLab and names what the checkout
lacks. The binding is recorded as `forge-reported`: GitLab's hunks under
headers DocsFab writes in git's shape, without blob ids. A file GitLab sent
an empty diff for in an open or fast-forward merged merge request, a pure
rename included, and a file whose diff text holds the replacement character
U+FFFD stay listed in the change manifest without their diff, and the status
output names each one. Other damage to the checkout's objects, such as a
tampered object or a full clone missing a file version, is never read
around: it stops the run with its own code, as for a local range. A commit
the diff reads whose parent cannot be resolved counts as missing, whether
the parent is absent or corrupt, so that diff is read from GitLab too, and
the status output names the local refusal.

The following conditions stop the run before any model call, each with its own code:

- The checkout lacks an object the diff reads and the GitLab read failed as
  well: `change-source-mr-objects-unavailable`, naming what the checkout
  lacks and the GitLab failure. Fix your `glab` login for the host, or fetch
  the merge request into the checkout with
  `git fetch origin refs/merge-requests/<number>/head` and its target branch.
  A partial clone fetches trees and files only when a checkout needs them, so
  there also run `git checkout` on each side the diff compares, in order:
  the base commit and then the head for an open or fast-forward merged merge
  request, or the merge or squash commit's first parent and then that commit.
  A refusal for a missing tree or file names those commits. Switch back to
  your branch, then run again.
- GitLab's answer does not add up: a file total that differs from the
  merge request's changed-file count, line totals that differ from the
  commit's, a newest commit that is not the pinned head, or a field DocsFab
  cannot read: `change-source-mr-forge-incomplete`. GitLab reports the
  changed-file count only as a lower bound, such as `1000+`:
  `change-source-mr-forge-overflow`. GitLab sent a path or commit subject
  holding U+FFFD: `change-source-mr-forge-text-replaced`. One GitLab answer
  is larger than a `glab` read may return: `change-source-mr-forge-page-bound`.
  For each, fetch the merge request into the checkout as above so its diff is
  read from local objects.
- A merge request closed without merging: `change-source-mr-closed-unmerged`.
- A merge request locked while GitLab merges it: `change-source-mr-locked`.
- GitLab reports no diff commits for it: `change-source-mr-diff-refs-missing`.
- GitLab reports two different heads for it, its head or base moved while
  its diff was read from GitLab, or its text names other merge commits than
  the pinned diff: `change-source-mr-moved`.

The range bounds, labels, and the other refusals in
[Bind a Local Commit Range](bind-commit-range.md#bind-a-local-commit-range) apply unchanged, so
`docsfab run --mr` or `--pr` combines with `--comparison-base` or
`--comparison-workspace` as `--change` does. `docsfab do --mr` or `--pr`, `docsfab live-agent`, and `docsfab sources` keep
binding a merged merge request's text only; `docsfab do --change` with a merge
request binds what this section describes.

## Update Documentation From Merged Merge Requests

You can ask `update-documentation` to discover merge requests by calendar
day instead of listing MR numbers, commit SHAs, or `--reader-source`
bindings. Name the merge requests, the target branch they merged into,
one calendar day or inclusive date range, and one IANA time zone. DocsFab
treats that day as a half-open civil interval: midnight at the start of
the first named day through midnight at the start of the day after the
last named day, in the named zone. The reported September 14, 2026
`America/Los_Angeles` day is
`[2026-09-14T07:00:00Z, 2026-09-15T07:00:00Z)`.

```bash
docsfab run update-documentation \
  --patch-only \
  --instruction "Review the MRs merged into main on September 14, 2026, using America/Los_Angeles time. Collect the related code changes and existing documentation. Identify changes affecting end users, including commands, configuration, defaults, installation, workflows, and observable behavior. Update only the affected user documentation, preserving unrelated content. Skip internal changes with no user impact. Report which MRs require documentation changes, what you updated, and any evidence gaps. If merge records or diffs are unavailable, report that limitation rather than claiming complete coverage."
```

The host pages the selected project's merged merge requests, keeps squash
and merge identities per MR, and supplies those diffs plus the current
documentation as reader evidence before planning. Planner, writer, and
verifier receive the same diffs as bound source reads, so they do not
depend on pasted SHAs or `--reader-source` bindings. Multiple merge
requests in the window stay separate. DocsFab does not invent a
first-to-last SHA comparison. `--patch-only` retains a local patch and
does not apply it to your checkout or open a merge request.

Do not combine this instruction shape with `--source`,
`--reader-source`, `--comparison-base`, or `--comparison-workspace`. If GitLab
authentication, access, pagination, or diffs fail, the run reports that
gap. It does not claim complete coverage or a verified no-change result.
A fully walked window with no matching merge requests is distinct from a
retrieval failure.
