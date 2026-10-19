---
title: Git History Tools in DocsFab
description: Read what a planner or writer step can learn from local git history, how each read is bounded and cited, and the codes a refused read records.
status: draft
content.type: reference
---

The DocsFab git history tools let the planner and the writer read the local git
history behind a run's pinned revision. A step uses them to answer what changed,
when it changed, which commit last changed a documented line, which commit added
or removed a symbol, and what the old behavior was, for example by reading a
file as it was before the change it documents. Every read is bounded, screened,
and cited in the run record. For more information, refer to [DocsFab Knowledge
and Delivery Reference](index.md).

## Who Gets the Tools

The host registers `docsfab_history_blame`, `docsfab_history_diff`,
`docsfab_history_log`, `docsfab_history_search`, and `docsfab_history_show`
only when both of the following conditions hold:

- The step runs the `plan-documentation` or `write-documentation` skill. In
  `create-documentation`, `update-documentation`, and
  `restructure-documentation`, that is the planner and the writer, including
  the CREATE revision writer.
- The run materialized a repository workspace from a local checkout, as
  `docsfab run` does. The tools read that checkout's object store; the
  model's own workspace is a tracked-file export with no `.git`.

The same rule decides the step's granted tool list and the tools the session
presents, so `tools.presented` in the step's attempt record names them exactly
when the step could call them. The five tools are granted together: a sealed
tool ceiling that omits any of the five names, including a ceiling that names
only the four tools that came before search, builds no history reader and
presents none of them. The hosted runtime runs under such a
ceiling, its composition's declared tools, so it gets no history reader for
its depth-1 private copy. The live agent does not register them.

## Tools and Arguments

Each tool takes a JSON object. Every argument other than `cursor` is optional
on a resumed call, and any argument sent with a cursor must match the page
that issued it. The following table lists each tool, its arguments, and what it
returns.

An argument sent as `null`, an empty string, or an empty list counts as
omitted, at the top level and inside `range`. A model that fills every
declared argument can send an unused `cursor` or `range.from` as `""`, and the
tool then reads the call without it rather than refusing an empty cursor or
revision. The run record counts each such argument under
`tools.toolArgumentFiller`, without its value.

The following table lists each tool, its arguments, and what it returns.

| Tool | Arguments | Returns |
| --- | --- | --- |
| `docsfab_history_show` | `path`, `revision`, `cursor` | The text of one regular file at one revision, its full commit id, the byte range served, and the total bytes. |
| `docsfab_history_diff` | `base`, `head`, `paths`, `cursor` | The unified diff between two revisions, file by file, with `a/` and `b/` prefixes, full object ids, three lines of context, and no rename detection. Each file's patch holds only the sections that name that file, so a path that is a file on one side and a directory on the other never carries the directory's contents. A change of type, such as a file that becomes a symlink or a submodule, is two sections: the deletion, then the addition. |
| `docsfab_history_log` | `path`, `range` (`from`, `to`), `cursor` | Commits newest first: full commit id, parent ids, committer date, and subject. `range.to` defaults to the pinned revision; `range.from` is excluded. |
| `docsfab_history_search` | `needle`, `range` (`from`, `to`), `paths`, `cursor` | The commits whose change alters how many times the literal `needle` occurs in a file (git's pickaxe, `-S`), newest first: full commit id, parent ids, committer date, subject, and the files whose count changed. `range` works as for the log; `paths` limits the search to files or directories. Each page names the window of the walk it scanned in `scanRange`. |
| `docsfab_history_blame` | `path`, `revision`, `startLine`, `endLine`, `cursor` | For each line from `startLine` through `endLine` of one regular file at one revision: the line number, the full id of the commit that last changed it, the line's number in that commit's version (`sourceLine`), and the line's text. A line from a commit where the file had another name also carries `sourcePath`, or `sourcePathWithheld` when that name is not served. No author name or email is returned. |

Blame lines count from 1 and the range includes both ends. A file has one
line per line break, plus one for a last line without a break, so an empty
file has none and every range of it is refused. Blame follows a whole-file
rename, as git does by default, but does not look for moved or copied lines
(`-M`, `-C`) or ignore whitespace (`-w`). A repository's configured
`blame.ignoreRevsFile` is not applied, so attribution is always the commit
that last changed the line.

Search is for when a symbol, option, or message first appeared or last
vanished. The `needle` is matched as plain, case-sensitive text: never a
regular expression, glob, option, pathspec, or revision, and never echoed on a
page, in a citation, in a refusal, or in a log line; the host keeps it only in
the attempt's cursor state. It reaches git as one command-line argument, so
other processes on the same host can see it while git runs. It must not be
empty or hold a NUL or a lone UTF-16 surrogate, and it is measured in UTF-8
bytes against `gitHistory.searchNeedleMaxBytes`. The following rules
apply to the search:

- Merges never match: git does not diff a merge for the search.
- A match inside a binary file is found and listed by name only.
- In a shallow clone, the commit at the cut is diffed against nothing, so it
  is charged with every older addition of the string. Its match carries
  `atShallowCut: true`.
- A rename reads as a deletion and an addition, so a renamed file holding the
  string lists both names.
- A matched file that is credential-bearing, generated, or named with bytes
  that are not UTF-8 is never listed, and a commit with no other matched file
  is dropped as if it never matched. A match only in such a file leaves no
  trace: the page, its labels, and its citation are those of a string found
  nowhere, apart from the cursor handle, which is random on every page. Labels
  come from a list of the window's changed files read without the string. One
  exception remains: the search reads each matched commit's subject, so a
  string found only in such files of many commits with very long subjects can
  make the read pass `hostInvoker.gitOutputMaxBytes` and refuse with
  `history-output-too-large`.
- A served file name that holds a configured credential is listed as `null`.

The walk is scanned in windows of `gitHistory.pickaxeMaxCommitsScanned`
commits. A page continues with `nextCursor` to the next window even when its
window matched nothing, so nothing is skipped.

A revision is `head`, the run's pinned revision, or a lowercase hex commit id
of at least `gitHistory.revisionMinHexChars` (7) characters and at most the
repository's full id length (40 for SHA-1, 64 for SHA-256). An abbreviation resolves from the object store, never
from a branch or tag name. Only the pinned revision and its ancestors can be
read, so another branch, a stash, or a dangling commit is refused. A path is
repository-relative and literal: globs and pathspec magic are names, not
patterns.

The tools never fetch, never run a hook, filter, textconv driver, external
diff, pager, or signature verifier, and never write to the repository. They
ignore replace refs and a grafts file, and they pin every output format, so
repository configuration cannot change what they return.

## Labels

A label reports a limitation on a page that was still served. It is recorded
with the page's citation. The following table lists the labels.

The following table lists each label and its meaning.

| Label | Meaning |
| --- | --- |
| `history-shallow` | A log page lists a commit at the cut of a shallow clone, or is the last page of a walk that reaches the cut, including a walk limited to a path that the cut commit does not touch. A search page's scanned window holds a commit at the cut, matched or not, or the page is the last of a walk that reaches the cut. A blame page serves a line attributed to a commit at the cut, which git charges with every older change. Older history exists but this checkout does not hold it. A parentless root commit in a full clone is not labelled. |
| `history-partial-clone` | The checkout is a partial clone, so some objects may be unavailable. Search never carries it, because it refuses a partial clone. |
| `history-paths-excluded` | The diff left out changed paths that are credential-bearing or generated, such as `.env`, key files, and `node_modules`. The page and its citation carry the count, never the paths. On a blame page, a served line came from a commit where the file had such a name, or a name that is not UTF-8, or that commit renamed the file from one; the name is never served. On a search page, a commit in the scanned window changed such a file, or a file whose name is not UTF-8, under the searched paths. It is decided without the search string, so it says nothing about where the string occurs. |

## Refusal Codes

A refused read returns `DocsFab refused this history read: <code>.` with a
remediation, records nothing as a citation, and records its failure category
in the step's tool activity. No new failure category is introduced.
`malformed-arguments` and `recoverable-miss` can be recorded as limitations of
a `not-ready` outcome, and so can `denied-path` and `tool-defect` on a
read-only step. On a write step, `denied-path` and `tool-defect` stay material,
and a `ready` outcome refuses every one of these categories. The following
table lists the refusal codes.

The following table lists each code, its category, and when it applies.

| Code | Category | When |
| --- | --- | --- |
| `history-arguments-invalid` | `malformed-arguments` | An argument has the wrong type, a required one is missing, or an unknown one is present. A search `needle` that is empty or holds a NUL or a lone surrogate is refused this way before git runs. |
| `history-revision-invalid` | `malformed-arguments` | The revision is not `head` or a lowercase hex id of `gitHistory.revisionMinHexChars` to 64 characters, or it names a tree, blob, or annotated tag. An id longer than the repository's full commit ids, such as 64 characters in a SHA-1 repository, is refused the same way. A too-short or too-long id's message names its length and the bound. |
| `history-revision-ambiguous` | `malformed-arguments` | The abbreviation matches more than one commit. |
| `history-revision-out-of-scope` | `recoverable-miss` | The commit is not the pinned revision or one of its ancestors. |
| `history-object-missing` | `recoverable-miss` | The object is not in the checkout. In a shallow clone, the message says to deepen the operator checkout. |
| `history-object-unavailable` | `recoverable-miss` | A partial clone does not hold the object locally. The tools check the local object store first and never ask the promisor remote, on any supported git version. A treeless clone refuses a read whose revision's trees it lacks. Before blame runs, the host checks every version of the file along its history, and at each rename every added or deleted file that rename detection compares; blame in a partial clone therefore needs the file's whole history held locally. A git failure after that check passes is also this code in a partial clone. Search does not yet read partial clones: it refuses any partial clone with this code before it walks history, and its message says so. |
| `history-object-too-large` | `recoverable-miss` | The file is larger than `hostInvoker.gitOutputMaxBytes`, checked before it is read. |
| `history-object-binary` | `recoverable-miss` | The file holds a NUL byte or is not valid UTF-8. |
| `history-output-too-large` | `recoverable-miss` | Git output for one read passed `hostInvoker.gitOutputMaxBytes`. |
| `history-path-refused` | `denied-path` | The path is absolute, starts with `~`, holds an empty, `.`, or `..` segment or a NUL, or is credential-bearing or generated. |
| `history-path-missing` | `recoverable-miss` | The path does not exist at that revision. |
| `history-path-not-file` | `recoverable-miss` | The path is a directory, symbolic link, or submodule at that revision. |
| `history-cursor-invalid` | `recoverable-miss` | The cursor was not issued by this tool in this attempt, or other arguments differ from its page's. |
| `history-line-range-invalid` | `malformed-arguments` | A blame line number is below 1, `startLine` is after `endLine`, or `endLine` is past the file's line count at that revision; the message names the count. |
| `history-timeout` | `recoverable-miss` | Git did not finish within `hostInvoker.gitTimeoutMs`. |
| `history-git-failed` | `tool-defect` | Git failed and every object the read needed is present, such as a corrupt object. A search whose git output is malformed, out of the window's order, or names a commit outside the window is also refused this way. |

A catalogued bound that a call exceeds refuses with that limit's own refusal
code, records `recoverable-miss`, and names the observed value and the
remediation. A file that holds one of DocsFab's configured credentials is
refused whole with the credential-isolation boundary message. In a diff, only
the file whose patch holds one is listed as `withheld` without its patch, and
in a log, only that commit's subject is withheld; the rest of the page is
served.

## Bounds and Paging

The bounds live in `config/limits/gitHistory.yaml`. `docsfab doctor --limits`
shows their effective values. The following table lists the bounds.

The following table lists each limit, its default, and what it bounds.

| Limit | Default | Bounds |
| --- | --- | --- |
| `gitHistory.logMaxEntries` | 50 | Commits on one log page. |
| `gitHistory.responseMaxBytes` | 32,768 bytes | The rendered JSON of one page, envelope, labels, and cursor included. |
| `gitHistory.pathsMaxPerCall` | 64 | Paths one diff call names, and changed files one diff page covers. |
| `gitHistory.cursorsMaxPerToolSet` | 256 | Distinct continuation cursors one step attempt holds. |
| `gitHistory.revisionMinHexChars` | 7 | The shortest abbreviated commit id a tool resolves. A shorter one is refused as `history-revision-invalid`. |
| `gitHistory.blameMaxLines` | 2,000 | Lines one blame call may ask about, checked before git runs. A longer range is refused with `git-history-blame-max-lines-bound` and the asked count; blame the rest in another call. |
| `gitHistory.pickaxeMaxCommitsScanned` | 1,000 | Commits one search page scans. It bounds git's work and is never a refusal: a longer walk continues window by window with a cursor. |
| `gitHistory.searchNeedleMaxBytes` | 256 bytes | The UTF-8 length of one search `needle`, checked before git runs. A longer one is refused with `git-history-search-needle-max-bytes-bound` and its byte count. |

`gitHistory.responseMaxBytes` must not exceed the per-call tool output cap
(`DOCSFAB_TOOL_OUTPUT_CAP_BYTES`, 32,768 bytes by default). When it does, the
step refuses before any provider turn with
`git-history-response-max-bytes-bound`. Every git call also runs under the
sealed `hostInvoker.gitTimeoutMs` and `hostInvoker.gitOutputMaxBytes`.

A file, diff, walk, or blamed range larger than one page is never cut
silently. The page returns `nextCursor`, an opaque handle that the host keeps
for the rest of the attempt, bound to the tool, the resolved revisions, the
admitted paths, and the offset; for blame, to the revision, the path, the
asked line range, and the next line to serve. The same page asked again
returns the same cursor, and the five tools share one cursor bound. A page
ends at a line break when it holds one. A blame page serves whole lines, so
one line longer than a page is refused with
`git-history-response-max-bytes-bound`.

A search cursor is bound to the needle, the resolved range ends, the admitted
paths, the window's offset in the walk, and the next match and file to serve.
A window's matches page by bytes, and one commit whose files do not fit on a
page continues them on the next page, so a commit can appear on more than one
page. Only one file of one match too long for an empty page is refused with
`git-history-response-max-bytes-bound`. Each new window walks again past the
commits that earlier windows scanned, so a search limited to paths costs more
the deeper it goes.

## Citation Fields

The host records each served page in the attempt's tool activity as an entry
of `tools.historyReads`, and copies the attempt entries, in attempt order, to
the step. The model supplies none of these fields. The following table lists the fields.

The following table describes each field.

| Field | Content |
| --- | --- |
| `tool` | The history tool that served the page. |
| `revisions` | Full commit ids: the revision for `show` and `blame`, the base and head for `diff`, and the range ends for `log` and `search`. |
| `paths` | The file for `show` and `blame`, the files served on the diff page, the log path filter, or the search's requested paths. |
| `ranges` | Per file, the byte range of the served text or patch after host-root masking; for `log`, the entry range of the walk; for `search`, one entry range with a null `path`: the scanned window. Byte and entry ranges include `start` and exclude `end`. For `blame`, one range in `lines`: the first and last served line, counted from 1, both included. |
| `labels` | The page's labels, sorted. |
| `sha256` | The SHA-256 digest of the exact text the model received. |
| `excludedPathCount` | For a diff, the count behind `history-paths-excluded`. Never on a search. |
| `matchedCommits` | For a search, always: the full ids of the commits the page served, each once. |
| `cursor`, `nextCursor` | The handle the call resumed from and the handle it issued. |

The number of entries is bounded by the step's tool-call ceiling,
`compositionExecution.maxToolCallsPerStep`, because each successful call
serves at most one page. The record readers refuse an entry that is not a full
object id and more entries than a tool's successful calls, a `lines` range
from any tool but blame or starting below line 1, and a blame entry with more
than one revision, path, or range. They refuse a search entry without
`matchedCommits`, with a repeated or abbreviated commit, with more commits than
its window scanned or than `gitHistory.pickaxeMaxCommitsScanned` allows at its
maximum, or with any range but one window of entries; and `matchedCommits` on
any other tool. The publication record reader also refuses step entries that
differ from the attempts' entries. The host and the runtime ship together, so
no reader of an earlier release reads a record that cites blame or search.

## Related

For more information, refer to the following topics:

- [Update Documentation Workflow in DocsFab](../workflow-contracts/update-documentation.md)
- [Create Documentation Workflow in DocsFab](../workflow-contracts/create-documentation.md)
- [Update Documentation Beside a Change in DocsFab](../../workflows/update-documentation-beside-a-change.md)
- [Operational Limits in DocsFab](../status-and-configuration/operational-limits.md)
