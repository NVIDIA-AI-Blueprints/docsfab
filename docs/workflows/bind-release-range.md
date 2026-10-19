---
title: "Bind a Release Range in DocsFab"
description: "Ground a documentation job on the named tags, commits, and changelog evidence of a release range."
status: draft
content.type: how-to
---

Ground a documentation job on the named tags, commits, and changelog evidence of a release range.

## Prerequisites

Keep the selected release tags or commits available in the repository. Identify the release range and the documentation change it supports.

## Bind a Release Range

Use `--change release:<base>..<head>` to ground a run on a whole release. The
run binds each first-parent commit on `head` since `base` as its own change
(a merge, a squash-merged commit, or a direct commit), plus one units index
that lists every unit:

```bash
docsfab run update-documentation --repo /absolute/path/to/repository \
  --instruction "Update the guides for the changes in TARGET_TAG." \
  --change release:BASE_TAG..TARGET_TAG --patch-only
```

Replace `BASE_TAG` and `TARGET_TAG` with release tags from the target repository.
These tags identify that repository's releases, not the DocsFab version.

A plain `--change BASE_TAG..TARGET_TAG` binds the release as one diff instead, which
refuses on most real releases at `changeSources.changedFilesMax` or
`changeSources.diffMaxBytes`. The `release:` prefix never names a ref, so a
calendar-versioned tag such as `2026.09` is read as a tag. The following rules apply to each release unit:

The following rules apply to the release walk:

- Each unit diffs against its first parent: a merge shows what it brought
  onto the release line, and the index lists the commits it brought in.
- A unit over `changeSources.diffMaxBytes` or
  `changeSources.changedFilesMax`, or whose diff or manifest does not extract
  whole within `sources.extractionMaxSpans` or
  `sources.extractionMaxDerivativeBytes`, stays listed in the index without
  its diff, and the run's status output names it, the limit, and its size. The
  rest of the release still binds.
- A base that is not on the head's first-parent line, such as a tag on a
  release branch, is labelled `base-off-first-parent-line`: the walk can list
  changes the base release already carried.
- Units carry no merge or pull request link: a local checkout records no
  forge identity.

A release longer than `changeSourcesRelease.unitsPerRunMax` units binds its
first page. The status output lists every later unit and prints the selector
for the next page, `release:<last bound unit>..<head>`.

The units index is the one part of the release a writing step must read, and
it must fit whole in one step's source-read budget for the model the run
binds. On a smaller model window the page is shorter than
`changeSourcesRelease.unitsPerRunMax`, and the status output says so with the
budget. Each unit's record and diff are bound and readable, but not required.

The run record cites the release in two fields. `changeSources` holds one
entry for each unit record the page bound, in index order; an omitted unit
has no record and no entry. `changeSourceRelease` cites the units index:
base, head, the index digest and observation id, and the page it fixed,
with the units on the page, how many were omitted, how many remain, and the
continuation selector.

The following conditions stop the run before any model call, each with its own code:

- `release:since-last` and `release:dates:...` refuse with
  `change-source-release-form-unsupported`, as does any other `release:`
  form.
- A tampered annotated tag, unit commit, or tree refuses with
  `change-source-integrity-mismatch`.
- A head that is base or base's ancestor refuses with
  `change-source-release-no-units`, or `change-source-empty-range` when the two
  are the same commit.
- More units than `changeSourcesRelease.unitsMax` refuses with
  `change-source-release-units-bound` and the count.
- One source binding holds at most 256 observations: the units index, two
  observations for each bound unit, and the `--source` files. Exceeding that
  limit refuses with `change-source-release-observations-exceeded`. Lower
  `DOCSFAB_CHANGE_SOURCES_RELEASE_UNITS_PER_RUN_MAX` or pass fewer files.
- A units index that does not fit one step's source-read budget even with a
  one-unit page refuses with `change-source-release-index-over-read-budget`.
  Name a shorter range, use a model with a larger input window, or raise
  `DOCSFAB_SOURCES_READ_RESPONSE_CEILING_BYTES` when the ceiling set the
  budget.
- Every other refusal a local range makes inside one unit refuses the whole
  release: a configured credential, a tampered object, an encoding failure,
  a grafts file, a failed git read, missing shallow history, an original over
  `sources.extractionMaxOriginalBytes`, or an extraction that runs past
  `sources.extractionMaxMs`.

The following table lists the release unit limits.

| Limit | Default | Host override |
| --- | --- | --- |
| `changeSourcesRelease.unitsMax` | 512 units | `DOCSFAB_CHANGE_SOURCES_RELEASE_UNITS_MAX` |
| `changeSourcesRelease.unitsPerRunMax` | 126 units, at most 127 | `DOCSFAB_CHANGE_SOURCES_RELEASE_UNITS_PER_RUN_MAX` |

`--change release:` keeps every combination rule of a local range.
`docsfab do --change release:<base>..<head>` binds, cites, and refuses the
release exactly as `docsfab run` does after the sentence routes to
`create-documentation` or `update-documentation`.
