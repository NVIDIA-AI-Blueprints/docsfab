# Change sources

A change source is a code change bound to a run as evidence: a pinned
revision pair in one repository, the commits between them, the paths they
change, and the unified diff. `docsfab run create-documentation` and
`docsfab run update-documentation` accept one with `--change <range>`, or a
GitLab merge request with `--change <merge request>` or `--mr`. The
host resolves and checks the whole range before any model call, then mints
its observations into the run's one source binding through the governed
[source evidence](source-evidence.md) path, beside any `--source` files.

Modules:

- `src/inputs/change-source.ts`: the `ChangeSourceV1` contract, its codec
  factory and sealed decoder, the source decoder and selector tables, the
  `--change` selector grammar, and every refusal code.
- `src/inputs/change-source/revision.ts`: `PinnedRepositoryRevisionV1`, the
  shared `{repository, base?, head}` shape, its decoder, and the forge
  identity builders.
- `src/inputs/change-source/objects.ts`: raw object reads, re-hashing, and
  commit parsing shared by every kind that reads a local object database.
- `src/inputs/change-source/local.ts`: the local-range resolver and the
  `changeSources.*` bounds.
- `src/inputs/change-source/acquisition.ts`: the producer that mints the diff
  and manifest observations, and the producer id per kind.
- `src/inputs/change-source/github-url.ts`, `src/inputs/change-source/github-member.ts`,
  `src/inputs/change-source/github-transport.ts` and `change-source/github.ts`: the
  github.com URL grammar, the two GitHub `source` members, the anonymous
  GitHub REST reader, and the GitHub resolver.
- `src/inputs/change-source/release-member.ts` and `src/inputs/change-source/release.ts`:
  the `release:` grammar and `release-range` member, and the release resolver,
  its units index and its producer.
- `src/cli/run/source-acquisition.ts`: `resolveCliChangeSource`, which
  dispatches a selector to its kind's resolver.

## One contract, one extension rule

`ChangeSourceV1` (`kind: docsfab-change-source`, `schemaVersion: 1`) is the
only change-source contract. Its `source.kind` is a closed union that holds
`local-range`, `gitlab-merge-request`, `github-pull-request`,
`github-commit`, `github-compare` and `release-range`. A new way to name a change, such as a GitHub compare or a release range, adds one
entry to each table in [Extension seams](#extension-seams). It never adds a
parallel contract. On `docsfab run`, `--pr` and `--mr` bind a merge request's
diff through this contract, beside its text when it is merged; see
[GitLab merge requests](#gitlab-merge-requests).

The record carries:

| Field | Meaning |
| --- | --- |
| `source` | The kind's member: exactly `{kind: "local-range"}` for a local range; the pinned merge request for `gitlab-merge-request`, see [GitLab merge requests](#gitlab-merge-requests); for a GitHub kind, see [GitHub pull requests, commits and compares](#github-pull-requests-commits-and-compares); exactly `{kind: "release-range"}` for one unit of a [release range](#release-ranges). |
| `revision` | `PinnedRepositoryRevisionV1`: the repository identity (`local-checkout`, a SHA-256 of the checkout's top-level path; `gitlab-project` or `github-repository` for a forge, see [Extension seams](#extension-seams)), the pinned `base` when there is one, and `head`, each a full object id. |
| `objectFormat` | `sha1` or `sha256`, read from the repository. Every object id in the record has that format's width (40 or 64 hex digits, the width of the format's empty tree id); a mixed record refuses. |
| `rangeSemantics` | `two-dot`, `three-dot`, or `first-parent-commit`. |
| `mergeBase` | The merge base git finds for `base` and `head` in the history the checkout holds, or null when it finds none. In a complete clone null means the two histories share no commit. In a shallow clone it means none is visible: `...` refuses, and `..` records null. |
| `diffFrom` | The commit the diff's old side is read from; null means the empty tree. |
| `baseTree`, `headTree` | The root trees of the diff's two sides, read from the raw commit bytes. Null only in a forge-reported record. |
| `commits` | Oldest first: each commit's id, parents, and subject line. When the record carries `commit-list-may-include-base-history`, every commit also carries `descendsFromDiffBase`; otherwise none does. In a shallow clone the list can be short or long, and the two `commit-list-*` labels say which; see [History and shallow clones](#history-and-shallow-clones). |
| `files` | In git's diff order: status (`A`, `M`, `D`, `R`, `C`, `T`), rename score, paths, modes, blob ids, `binary`, line counts, and `diffOmitted` when the file's diff was left out. Modes and blob ids may be null only in a forge-reported record. Rename score is null for every status but `R` and `C`, and line counts are null for a binary file; a forge-reported record may also leave either null where the forge reported none. |
| `labels` | `info-attributes-present`, `head-not-ancestor-of-workspace`, `base-not-ancestor-of-head`, `commit-list-incomplete-shallow`, `commit-list-may-include-base-history`, `merge-request-unmerged`; see [Labels](#labels) and [GitLab merge requests](#gitlab-merge-requests). |
| `protocol` | The diff protocol constants below; in a forge-reported record, `{provider: "gitlab" \| "github"}` instead. |
| `changeSourceSha256` | Digest over every other field. |

Host code computes every field. Commit subjects and paths are repository
text: they are kept byte for byte (no NFC rewriting), they appear only in the
manifest observation, and they never become prompt or instruction text.

## Selector grammar

`--change` accepts exactly these forms. `...` is matched before `..`.

| Form | Semantics | Diff | Commits |
| --- | --- | --- | --- |
| `<base>..<head>` | `two-dot` | `base` to `head` | `rev-list head ^base` |
| `<base>...<head>` | `three-dot` | merge base to `head` | `rev-list head ^mergeBase` (not rev-list's symmetric difference) |
| `<commit>` | `first-parent-commit` | first parent to the commit; a root commit diffs against the empty tree | the commit |

An endpoint is a branch, tag, or commit name, with optional `~N` and `^N`
ancestry, such as `HEAD~1..HEAD`. Each endpoint resolves through
`rev-parse --verify --end-of-options <name>^{commit}` and is recorded only as
its full id, so a ref that moves later changes nothing recorded.

Open ranges (`A..`, `..B`), `^!` and `^@` suffixes, reflog `@{...}` forms,
`:/text` searches, and `<rev>:<path>` names refuse with
`change-source-selector-grammar`. A GitLab merge request URL,
`host/group/project!N` or `!N` selects the GitLab kind instead (see
[GitLab merge requests](#gitlab-merge-requests)), and a github.com pull request, commit or compare URL selects a GitHub kind (see [GitHub pull requests, commits and compares](#github-pull-requests-commits-and-compares)); a value that starts with `release:` selects a [release range](#release-ranges). Any other URL, such as a GitLab compare page, an `scp`-style remote, or a
scheme-less pull or compare path refuses with
`change-source-kind-unsupported`. Refusals never echo the operator's value.

The change `head` and the run's workspace revision (`--revision`, default
`HEAD`) are independent, and both are recorded: the workspace revision is the
tree the run documents, and `head` is the change it documents. When `head` is
not an ancestor of the workspace revision, the manifest carries the label
`head-not-ancestor-of-workspace`; the run is not refused.

A `<base>..<head>` range whose `base` is not an ancestor of `head`, such as
a reversed range (`HEAD..HEAD~2`) or two diverged branches, diffs `base` to
`head` exactly as git does, so the diff also undoes changes that exist only
on `base`. The manifest carries the label `base-not-ancestor-of-head`; the
run is not refused. In a shallow clone the label is set only when the clone
can decide it; see [History and shallow clones](#history-and-shallow-clones).

## Labels

A label states a fact about the change that the reader should weigh. No
label refuses the run; each is listed in the manifest and in the operator
status.

| Label | Set when | The reader may conclude | The reader may not conclude | Removed by |
| --- | --- | --- | --- | --- |
| `info-attributes-present` | A non-empty `info/attributes` file applies to the diff. | The diff is git's output under those attributes. | That the diff matches a checkout without that file. | Emptying the file. |
| `head-not-ancestor-of-workspace` | `head` is not in the workspace revision's history (`rev-list head ^<workspace revision>` is not empty). | The documented tree may not contain the change. | In a shallow clone, that `head` is truly outside the workspace's history: git decides this from the history the clone holds. | Documenting a revision that contains `head`. |
| `base-not-ancestor-of-head` | `..` only: `base` is not in `head`'s history. | The diff also undoes changes that exist only on `base`. | Anything about a range without the label in a shallow clone: there the label is left off when the clone cannot decide it (see below). | Naming a `base` in `head`'s history. |
| `commit-list-incomplete-shallow` | Shallow clone only: a listed commit is a boundary commit whose recorded parent is missing from the checkout, or is present but outside the diff base's history. Git stopped listing there. | Every listed commit is in `head`'s history and outside the diff base's visible history. The diff is exact: it reads only the two endpoint trees. | That the list holds every commit of the range: commits behind that boundary commit may be missing. With this label, `base-not-ancestor-of-head` is not decided and is left off. | `git fetch --unshallow`. Deepening (`git fetch --deepen=<n>`) removes it when it brings the missing parents. |
| `commit-list-may-include-base-history` | Shallow clone, `..` only: the exclusion walk below the diff base met a missing parent, and a listed commit does not provably descend from the diff base. Every commit then carries `descendsFromDiffBase`. | Commits marked `true` descend from the diff base, so they belong to the range. The diff is exact. | That commits marked `false` belong to the range. Some may be the diff base's own history; others, such as a merged branch's commits, may be in the range. | `git fetch --unshallow`. Deepening removes it when it brings the diff base's missing history. |
| `merge-request-unmerged` | A `gitlab-merge-request` record whose merge request is open (draft included). | The diff is the merge request's current base-to-head change. | That the change is in the target branch, or that it will merge as recorded. | The merge request merging; a new run then pins its merge or squash commit. |

## Diff protocol

| Constant | Value |
| --- | --- |
| Rename similarity (`-M<n>%`) | 50 |
| Context lines (`-U<n>`) | 3 |
| Diff algorithm | `myers` |
| Rename limit (`-l<n>`) | `changeSources.changedFilesMax` |
| Empty tree, SHA-1 | `4b825dc642cb6eb9a060e54bf8d69288fbee4904` |
| Empty tree, SHA-256 | `6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321` |

The manifest comes from `diff-tree -r -z --raw --numstat --full-index` and the
diff from `diff-tree -r -p -U3 --src-prefix=a/ --dst-prefix=b/
--diff-algorithm=myers --full-index --no-color`, both with the same `-M50%`
and `-l<n>` and with `--no-ext-diff --no-textconv`, so a rename is `R` in both.
Paths in the diff are C-quoted (`core.quotePath=true`).

## Reading the repository

Every read goes through the trusted git runner (`runTrustedGit`): a fixed git
binary, a closed environment with no protocol access and no replace objects,
no hooks, no fsmonitor, no credential helper, and its sealed timeout and
output cap (`hostInvoker.gitTimeoutMs`, `hostInvoker.gitOutputMaxBytes`). Each
call also names the repository explicitly (`--git-dir`) with an empty
temporary work tree, and sets `core.attributesFile=/dev/null`, an empty-tree
`attr.tree`, `diff.external=`, `core.quotePath=true`, `core.commitGraph=false`,
`core.useReplaceRefs=false`, and `diff.suppressBlankEmpty=false`. So
checked-out or untracked `.gitattributes`, the repository-local diff settings
porcelain `git diff` reads, replace refs, and the commit-graph cannot change
the bytes. A repository-local `core.bigFileThreshold` still applies: a text
file above it reads as binary. Only plumbing
reads run: `rev-parse`, `rev-list`, `merge-base`, `cat-file`, and `diff-tree`.
Nothing is fetched, and no index or lock file is written.

Two inputs the runner cannot switch off are handled explicitly:

- A non-empty `info/grafts` file in the repository's common directory refuses
  with `change-source-grafts-present`, because grafts rewrite parents and so
  the commit list. The path is built from `rev-parse --git-common-dir`, not
  `--git-path`, which an environment setting can point elsewhere.
- A non-empty `info/attributes` file still applies, so the manifest and the
  operator status carry the label `info-attributes-present`.

## Integrity

Every commit in the range, both endpoints, the merge base, and the diff's
old-side commit are re-hashed from their raw bytes (`cat-file --batch`, with
the object header, SHA-1 or SHA-256 by repository format). Tree ids and
parents are read from those raw bytes, never from `rev-parse <rev>^{tree}` or
the commit-graph. The two diff-side root trees are re-hashed the same way. A
mismatch refuses with `change-source-integrity-mismatch` and names the role:
`base`, `head`, `merge base`, `diff base`, `commit <n>`, `boundary` (a
shallow boundary commit the exclusion walk crosses, or one above a three-dot
merge base that the host reads), `base tree`, or `head tree`. Subtrees and blobs are not re-hashed.

Git checks the endpoints it resolves itself, so a tampered or malformed
endpoint refuses as `change-source-revision-unresolved`, never as an integrity
mismatch.

The shared helpers in `change-source/objects.ts` also re-hash an annotated tag
object, refusing a mismatch the same way. A tag that a resolved ref names but
`cat-file --batch` does not return is a damaged object database and refuses
with `change-source-git-failed`, never as missing shallow history. The local
resolver peels each endpoint to its commit (`<name>^{commit}`) and does not
record or verify annotated tag objects.

## History and shallow clones

Classification uses probes (`rev-parse --is-shallow-repository`, object
presence, and the boundary list in the common directory's `shallow` file),
never git's error text. Git walks each boundary commit as if it had no
parents, even when a parent object arrived later through another fetch. That
cut can drop commits from the head side of a range, and it can stop git from
excluding the diff base's own history on the other side. In a shallow clone
a `..` or single-commit diff stays exact or the range refuses, a `...` range
refuses on the conditions below, and the commit list is labelled rather than
refused.

The diff:

- `..` and a single commit read only their two endpoint trees, re-hashed from
  raw bytes, so the diff is exact whenever both commits are present. An
  endpoint past the clone's depth, or a single commit whose first parent is
  missing, refuses with `change-source-history-unavailable`.
- `...` also needs the merge base, which git computes from the history the
  clone holds, so a newer merge base can be hidden behind the boundary. A
  three-dot range refuses with `change-source-history-unavailable` when git
  finds no merge base; when `merge-base --all` finds more than one; when
  `base`'s history crosses a boundary commit above the merge base whose
  recorded parent is missing or lies outside the merge base's history; when
  a listed commit is such a boundary commit (the
  `commit-list-incomplete-shallow` condition), unless `base` is itself the
  merge base; and when the list fails the ancestry check below, the condition
  that labels a `..` range.
- More than one merge base: a boundary can hide the edge that makes one of
  them the other's ancestor, and git then picks one by commit date, so only
  full history decides the diff base. The refusal names the merge bases and
  suggests `git fetch --unshallow` or a `<base>..<head>` range, whose diff is
  exact. It also refuses shallow ranges whose visible pick happens to be
  right; a clone that is not shallow keeps git's own pick.
- These conditions are the cases the host checks, not a proof that every
  hidden merge base is caught. When a three-dot diff must be exact beyond
  doubt, unshallow the clone or use `<base>..<head>`.

The commit list:

- Exclusion walk. Starting at the diff base (`base` for `..`, the merge base
  for `...`), the host follows each boundary commit it reaches through the
  parents recorded in that commit's raw bytes, re-hashing the commit, and
  adds every parent present in the object database as another excluded tip.
  Git walks the history between boundary commits. The commit list is then
  `rev-list head ^<diff base> ^<each tip>`. When every boundary commit the
  walk reaches has all its parents present, nothing of the diff base's own
  history is listed.
- Ancestry check. When a boundary commit the walk reaches names a parent the
  checkout lacks, a listed commit could still be a hidden ancestor of the
  diff base. A listed commit that descends from the diff base through visible
  edges (`rev-list --ancestry-path head ^<diff base>`) cannot be: a shallow
  cut only removes edges. When any listed commit is not on that path, a `..`
  range carries `commit-list-may-include-base-history`, and every commit
  carries `descendsFromDiffBase`.
- Short list. When a listed boundary commit names a parent that is not
  listed and is missing, or present but outside the excluded history
  (`rev-list --count <those parents> ^<diff base> ^<each tip>` is not zero),
  the range carries `commit-list-incomplete-shallow`.
- `base-not-ancestor-of-head` in a shallow clone is set only when the clone
  can decide it: never with `commit-list-incomplete-shallow`, and never when
  `base` is the recorded parent of a listed boundary commit, which makes it
  `head`'s ancestor even though git's merge base does not show it.
- A single commit's list is that commit. A boundary merge whose other parents
  are missing is admitted without a label.
- The walk crosses at most `changeSources.shallowBoundaryCommitsMax` boundary
  commits. One more refuses with `change-source-shallow-boundary-bound` and
  the count the walk reached. A clone that is not shallow takes none of these
  steps.

Outside the boundary, every parent a listed commit names must be present. A
missing one means a damaged object database, not shallow history, so it
refuses with `change-source-revision-unresolved` in any clone.

Deepen or unshallow the clone yourself; DocsFab never fetches. In a
depth-only clone, such as a CI checkout, a range whose commits all descend
from its base inside the clone's depth is exact and unlabelled. A merge range
such as `HEAD~1..HEAD`, whose merged branch forked below `HEAD~1`, is
admitted with an exact diff, labelled `commit-list-may-include-base-history`
with the branch's commits marked `false`, and also
`commit-list-incomplete-shallow` when the branch is cut by the clone's depth.
`HEAD~1...HEAD` of the same shape refuses, and `--change HEAD` diffs the
merge against the same first parent with no label.

- A name that does not resolve refuses with
  `change-source-revision-unresolved`, which never suggests deepening.
- `<base>...<head>` over two unrelated, complete histories refuses with
  `change-source-no-merge-base`; `<base>..<head>` records a null merge base.
- `base == head` refuses with `change-source-empty-range`. A non-empty range
  whose trees are identical, such as empty commits or a revert pair, is
  admitted as verified no-change evidence with an empty file list.

## Bounds

| Limit | Default | On breach |
| --- | --- | --- |
| `changeSources.commitsMax` | 256 | Refuses with `change-source-commits-bound` and the count from `rev-list --count`. |
| `changeSources.changedFilesMax` | 512 | Refuses with `change-source-changed-files-bound` and the counted paths. |
| `changeSources.diffMaxBytes` | 1,048,576 | Refuses with `change-source-diff-bound` and the kept diff's size. |
| `changeSources.fileDiffMaxBytes` | 131,072 | Omits that file's diff, keeps the file in the manifest with `diffOmitted` (`change-source-file-diff-omitted`, observed size, limit), and reports it in the operator status. The range is still admitted. |
| `changeSources.shallowBoundaryCommitsMax` | 64 | Shallow clones only: refuses with `change-source-shallow-boundary-bound` and the number of boundary commits the exclusion walk had crossed when it passed the limit. |

Each limit has a host override; the catalog in `config/limits/changeSources.yaml`
holds the rationale. Before any git read the host refuses, with
`change-source-limits-inconsistent`, a set where `fileDiffMaxBytes` exceeds
`diffMaxBytes`, or `diffMaxBytes` exceeds `sources.extractionMaxOriginalBytes`
or `sources.extractionMaxDerivativeBytes`, or is not below
`hostInvoker.gitOutputMaxBytes`. These checks compare raw diff bytes. The
extracted diff a step reads also carries a manifest, a summary row and one row
per file, so it is larger than the raw diff: measured, by about a quarter for
512 one-line file diffs and by under one percent for one large file. The
default `diffMaxBytes` matches the extraction ceiling. Acquisition capacity is
independent of the smaller per-step source read budget: steps read the admitted
evidence in spans, and the raw diff plus its extraction metadata must still fit
the extraction ceiling.

The manifest's size follows path and subject lengths, which no count bounds.
So before any model call the host extracts both originals, the manifest and
the diff, under the run's source extraction limits. One that would not
extract whole refuses at the limit it would cross, such as
`sources.extractionMaxDerivativeBytes` or `sources.extractionMaxSpans`, with
the bound the extraction ran under and the observed size, rather than bind
part of the change. This check, not the raw-byte relation, is what keeps an
admitted diff whole.

File diffs are read in groups whose computed upper bound fits
`hostInvoker.gitOutputMaxBytes`. The bound is conservative: twice the two blob
sizes, 256 bytes per changed line for hunk headers, 32 bytes per path byte for
quoted header paths, and 1,024 bytes of fixed header. A file whose bound alone
exceeds the git output cap is omitted unread, with its bound as the observed
size and `basis: "upper-bound"`. A kept file's size is always measured.

Any other failure of a git read, including the runner's timeout and output
cap, refuses with one code, `change-source-git-failed`, which names both
sealed limits.

## Encoding and credentials

Paths from `-z` output and the kept diff text are decoded as strict UTF-8
first. A path or diff line that is not valid UTF-8 refuses with
`change-source-encoding-unsupported`; nothing is decoded lossily, because a
replacement character would silently rewrite a path. Then the manifest's
fields, commit subjects and paths included, and the diff are screened for
DocsFab's own configured credentials before the record is sealed: an exact
match refuses with `change-source-credential-present`. Text that only looks
like a credential is repository content and is admitted; it becomes a
run-record finding, not a refusal.

## Observations

The kind's producer, version 1, mints two observations, both
listed in the binding's `requiredObservationIds`, so a run that never read
the change cannot write:

| Observation | Media type | Repository path | Adapter |
| --- | --- | --- | --- |
| Unified diff | `text/x-diff` | `change-source/<head>/range.diff` | `docsfab-unified-diff` v1, the shared `text/x-diff` extractor |
| Manifest | `application/vnd.docsfab.change-source+json` | `change-source/<head>/manifest.json` | `docsfab-change-source-manifest` v1 |

The producer is `change-source-local` for a local range,
`change-source-gitlab-local` for a GitLab merge request read from the
checkout, `change-source-gitlab-forge` for one read from GitLab,
`change-source-github-pull-request` for a GitHub pull request,
`change-source-github-commit` for a GitHub commit, `change-source-github-compare` for a GitHub compare, and `change-source-release` for every observation of a release range, which binds a third original, its units index, and requires only that index (see [Release ranges](#release-ranges)). Each GitHub kind keeps the `repository-revision` original version the other GitHub kinds use.

The manifest original is the sealed `ChangeSourceV1` as canonical JSON, pretty
printed. A range with no surviving file diff still binds a one-line diff
comment, so a verified no-change remains readable. The diff extracts through
the same unified diff adapter a committed `.diff` or `.patch` file uses: a
manifest of every file first, then each file's header and hunk spans with
`diff` locators that name the file and hunk ordinals, as
[Unified diff extraction](./source-evidence.md#unified-diff-extraction)
describes, and `docsfab_read_source` reads one file or hunk by `diffFile` and
`diffHunk`. The manifest original splits into spans of whole lines. The
observation version is
`{kind: "repository-revision", revision: <head>}`; a GitLab merge request
read from GitLab instead records `{kind: "content-digest",
contentDigestSha256: <the original's sha256>}`, because its bytes are what
GitLab rendered, not bytes verified at the revision. The locator digest
covers the selector-free range identity: repository, semantics, diff base,
head, and role. The producer scope digests the read scope and that identity,
so a different range is a different scope.

The selector itself never enters the projected run request: it is parsed
into the run arguments, resolved by the host, and committed through the
producer scope, so the source request projection is unchanged and
`--revision` combines with `--change`. `--comparison-base` and
`--comparison-workspace` combine with `--change` too: the comparison enters the
projected request as `readerEvidenceRequest`, which projection version 4
represents, so the binding commits to it beside the change. The comparison is
reader evidence, and the change's relation to it is not checked. The
change's relation to the workspace revision is recorded the same way, as the
`head-not-ancestor-of-workspace` label in [Labels](#labels).

## Extension seams

A new kind joins by adding one entry to each table below, all keyed by its
kind name. Each table is frozen and exported; a dispatch function takes an
optional table argument that defaults to the shipped table, so a test can
register a test-only kind without changing shipped state.

| Seam | File and symbol | What the kind adds |
| --- | --- | --- |
| Kind member | `change-source.ts`: `CHANGE_SOURCE_KINDS`, `ChangeSourceSourceV1` | Its name and its `source` member type. |
| Source decoder | `change-source.ts`: `CHANGE_SOURCE_SOURCE_DECODERS` | A `ChangeSourceSourceDecoder` for its member, with closed keys. |
| Selector arm | `change-source.ts`: `CHANGE_SOURCE_SELECTOR_ARMS`, `ChangeSourceSelectorV1` | A `ChangeSourceSelectorArm` that claims its `--change` values, and its selector member. |
| Kind arm | `cli/run/source-acquisition.ts`: `CHANGE_SOURCE_KIND_ARMS` | A `ChangeSourceKindArm` that resolves its member into a sealed record plus both originals. |
| Forge readers | `cli/run/local-workflow.ts`: the `resolveCliChangeSource` call | For a forge kind only: pass `forge: {commands, environment}` from the run options. |
| Repository identity | `change-source/revision.ts`: `PINNED_REPOSITORY_IDENTITY_KINDS`, `gitlabProjectIdentity`, `githubRepositoryIdentity` | Its identity member, built by its builder. |
| Producer id | `change-source/acquisition.ts`: `CHANGE_SOURCE_PRODUCER_IDS` | Its own producer id. |
| Protocol member | `change-source.ts`: `CHANGE_SOURCE_FORGE_PROVIDERS` | Its forge provider, for a forge-reported kind. |

Rules each seam enforces:

- **Source decoding.** `createChangeSourceCodec(sourceDecoders)` returns
  `{create, decode}` over one decoder table. `createChangeSource` and
  `decodeChangeSourceV1` are that codec over the shipped table and take no
  table argument, so no caller can widen the closed contract. An unknown or
  inherited `source.kind` refuses with `change-source-contract-invalid-value`;
  a key outside a member refuses with `change-source-contract-invalid-shape`.
  `local-range` stays exactly `{kind}`, so its records, digests and
  observation ids are the ones the local kind always produced.
- **Provenance.** `changeSourceProvenance(source)` is the one rule: a
  member's `provenance` field when present, else `local-verified`. A kind
  whose provenance can vary carries `provenance` in its own member; it is
  never a manifest label.
- **Forge-reported records.** Only under `forge-reported` may `baseTree`,
  `headTree`, file modes and blob ids be null; `revision.head` and every
  `commits[].id` stay required. Rename score and line counts follow the local
  rules (null for every status but `R` and `C`, and null for a binary file),
  and a forge-reported record may also leave them null where the forge
  reported none. The protocol is
  `{provider}`, never the local constants. A file diff the forge left out
  carries `diffOmitted: {code, basis: "forge-omitted", forgeReason}` with
  `forgeReason` one of `too-large`, `collapsed`, `no-patch` or
  `text-replaced` (the forge's diff text holds U+FFFD), and no size or
  limit fields, because a forge gives no size for it. A `measured` or
  `upper-bound` omission always carries `observedBytes`, `limitName` and
  `limitBytes`. Under `local-verified` every field keeps the local strictness.
  The operator status line for a forge omission names the forge reason and no
  limit. The kind arm, not the decoder, checks that `protocol.provider` is its
  own forge.
- **Selector parsing.** `parseChangeSourceSelector(value, arms?)` refuses an
  empty value first, then tries each registered arm in order, then refuses a
  foreign form no arm claimed (`change-source-kind-unsupported`), then reads
  the local range grammar. A registered arm never changes how a range parses.
- **Kind dispatch.** `resolveCliChangeSource(input, arms?)` calls the arm for
  `selector.source`. A selector whose kind has no arm refuses with
  `change-source-kind-unsupported` before any resolver runs; it never falls
  back to the local resolver. The arm receives `{workspace, selector, signal,
  onStatus, limits, forge, besideObservations, readBudget}` and returns
  `ResolvedChangeSourceV1`, or, for a release range, `ResolvedReleaseRangeV1`
  (its bound units plus the sealed units index); `resolveCliChangeSourceEvidence`
  takes either, and `acquireChangeSourceObservations` takes one record.
  `readBudget` resolves the step source-read budget of the model the run
  binds, by the rule execution applies (`runSourceReadBudget`); only the
  release arm reads it, and without it a release keeps the declared ceiling.
- **Repository identities.** `gitlabProjectIdentity({host, projectId})` and
  `githubRepositoryIdentity({host, repositoryId})` digest the canonical JSON
  of exactly those fields, so the key names are part of the digest: use
  `projectId` and `repositoryId`, never a merge-request-side name such as
  `targetProjectId`. The builders refuse rather than normalize
  (`pinned-revision-invalid-value`): a host that is not lowercase DNS labels,
  or that carries a scheme, userinfo, port, path, whitespace or trailing dot,
  and an id that is not a safe positive integer, including a numeric string.
- **Resolver parameters.** `resolveLocalChangeSource` takes an optional
  `source` member, `repository` identity, and `labels` the kind knows and git
  cannot; absent, it seals `{kind: "local-range"}`, the checkout path's
  digest, and only the labels it derives. A kind whose
  objects are local may pass its own `local-verified` member; a
  `forge-reported` member refuses with `change-source-contract-invalid-value`
  before any git call, because this resolver verifies every object it records.
- **Producer ids.** `CHANGE_SOURCE_PRODUCER_IDS` maps `local-range` to
  `change-source-local`. A record's id is looked up by `<kind>:<provenance>`
  first, then by kind, so a kind with an arm per provenance keeps one id per
  arm (`gitlab-merge-request:forge-reported` maps to
  `change-source-gitlab-forge`). A release range's units index takes its id
  by the same lookup over the `{kind: "release-range"}` member its unit
  records carry, so the index and its units share one producer. The scope
  digest, input registrations,
  observations and the producer-scope row all use the record's own id; an
  unmapped kind refuses with `change-source-kind-unsupported` rather than
  borrow another kind's id. `originalVersion`, the one place it is set,
  attributes a GitLab merge request read from GitLab to its original's own
  digest and every other record, the GitHub kinds included, to the pinned
  revision.
- **Raw objects.** A kind that reads a local object database reuses
  `readObjects`, `verified`, `parseCommit`, `rawParents` and `presentIn` from
  `change-source/objects.ts` through its own `RawObjectReader`, whose runner
  is the trusted git runner with the change-source hardening. The module
  never spawns git itself.

A multi-unit kind binds several records with an index through the same
seams: the release range kind is below. Each forge kind owns its own
resolver, producer id and network reads; the GitHub and GitLab kinds are
below.

## GitHub pull requests, commits and compares

`github-pull-request`, `github-commit` and `github-compare` read a public
github.com repository through the GitHub REST API. Each is `forge-reported`:
the host records what GitHub reported and does not hold the objects to
re-hash them.

### URL grammar

The selector arm claims only an `http:` or `https:` URL whose host is
`github.com` or `www.github.com`; every other host, a scheme-less path, and
GitHub Enterprise hosts fall through to `change-source-kind-unsupported`, so
a GitLab or Gitea link of the same shape is never read as GitHub.

| Form | Kind | Decision |
| --- | --- | --- |
| `/<owner>/<repo>/pull/<n>`, with an optional `/files`, `/commits` or `/changes` view, trailing slash, or `.diff`/`.patch` suffix | `github-pull-request` | All bind one selector. |
| `/<owner>/<repo>/commit/<sha>`, 4 to 40 hex digits, optional `.diff`/`.patch` | `github-commit` | The id is lowercased; an abbreviation is pinned to the full id GitHub returns, which must extend it, or `change-source-github-response-invalid`. |
| `#...` fragment | either | Ignored: it only scrolls the page. |
| `/pull/<n>/commits/<sha>`, `/pull/<n>/files/<sha>`, `/pull/<n>/files/<a>..<b>` | refused | `change-source-github-url-partial`: part of a pull request never binds the whole. |
| `/<owner>/<repo>/compare/<base>...<head>` | `github-compare`, `three-dot` | See [Compare URLs](#compare-urls). |
| `/<owner>/<repo>/compare/<base>..<head>` | `github-compare`, `two-dot` | Read only when `base` is the merge base; see [Compare URLs](#compare-urls). |
| `/compare/<ref>` (one ref, or none), a side in another fork (`owner:branch`, `owner:repo:branch`), a reflog date (`@{...}`) | refused | `change-source-github-compare-unsupported`. |
| userinfo | refused | `change-source-github-url-credentials`, checked first. |
| `http:` | refused | `change-source-github-url-insecure`. |
| a port, a query string (a compare page's `?expand=1` is the one exception), a `.` or `..` path segment as typed (also `%2e` and `\`), any other path, a malformed owner, repository, number, id or compare side | refused | `change-source-github-url-grammar`, with the part named. |

### Compare URLs

A compare URL names two refs of one repository. The range text after
`compare/` is percent-decoded once (`feature%2Fx` is `feature/x`, `%23` is
`#`), then split at the first `...`, else at the first `..`; a ref never holds
`..`, so the split is unambiguous.

| Part | Decision |
| --- | --- |
| A side | A git branch, tag or commit name, with `/` allowed. An empty side, a side starting with `-` or `/`, ending with `/`, `.` or `.lock` in a component, holding `//`, `..`, a control character, a space, `~`, `^`, `?`, `*`, `[` or `\`, refuses with `change-source-github-url-grammar` (`compare range`). |
| `.diff`, `.patch` | A download form of the same compare: stripped from the head side. Name a branch that ends in `.diff` or `.patch` by its commit id. |
| `?expand=1` | Admitted: GitHub adds it to open the pull request form, and it does not change the diff. Every other query, such as `?w=1`, refuses. |
| `#...` fragment, trailing slash | Ignored. |
| a full 40-digit id | Must come back from the pin as itself, or `change-source-github-response-invalid`. A shorter name may be a branch, tag or abbreviated id; GitHub's answer is the pin. |
| a dot segment (`a/../b`, `%2e%2e`, `.\`), including a final one followed by spaces or control characters | Refused before the URL parser removes it, so `compare/a/../b...c` never reads as `compare/b...c`, and `compare/a...b/x/..` with a trailing space never reads as `compare/a...b`. |

The resolver reads, in order:

1. `GET /repos/<owner>/<repo>`: the numeric repository id; every later read
   names `/repositories/<id>`.
2. One pin per side: `GET /repositories/<id>/commits?sha=<ref>&per_page=1`,
   the commit listing that starts at the ref's own commit. A listing carries
   no file list or patches, so a large merge commit cannot reach
   `changeSourcesGithub.responseMaxBytes` on a pin.
3. `GET /repositories/<id>/compare/<base id>...<head id>`, every page. Every
   read after the pins names full commit ids, and the compare is always asked
   as `...`, never `..`.
4. The two root trees, as for every GitHub kind.

| Form | Example | `revision.base` | `mergeBase` | `diffFrom` | Commits |
| --- | --- | --- | --- | --- | --- |
| `A...B` | `main` and a feature branch that diverged from it at M | A | M | M | after M, up to B |
| `A..B`, A an ancestor of B | a release tag and a later branch tip | A | A | A | after A, up to B |
| `A..B`, diverged | `main` and a feature branch that diverged at M | refused | | | `change-source-github-two-dot-not-ancestor` |
| `A..B`, B behind A | `main` and its own older commit | refused | | | `change-source-github-two-dot-not-ancestor` |
| `A...B`, B behind A or equal | `main` and its own older commit | refused | | | `change-source-empty-range` |

With one merge base, `B ^A` and `B ^M` hold the same commits, so both forms
list the same commits; only `diffFrom` differs. GitHub's compare answers
three-dot, and the path-set check below cannot tell three-dot hunks from
two-dot hunks over the same paths, so DocsFab reads a two-dot compare only
when the two are the same diff: when A is the merge base. Any other two-dot
refuses with `change-source-github-two-dot-not-ancestor`. Its remedy is
`A...B`, or a checkout holding both commits and `--change A..B`, which the
local resolver diffs from A itself.

A cross-fork compare is refused at the URL, so both sides live in the one
repository and the `github-compare` member names no head repository.

Assumed, unverified against live GitHub (the tests read fixture forges built
from real local repositories, not recorded GitHub responses): that the commit
listing with `sha=<ref>` starts at the ref's own commit for a branch, a tag
and an abbreviated id; that `?expand=1` leaves the compare's diff unchanged;
and that `.diff` and `.patch` name the same compare. A full commit id is
checked against its pin; a branch or tag name is not, and the record names
the commit ids it read.

### Members and identity

```text
github-pull-request: {kind, provenance: "forge-reported", host: "github.com",
  repositoryId, fullName, number, state: "open" | "merged", headRepositoryId}
github-commit:       {kind, provenance: "forge-reported", host: "github.com",
  repositoryId, fullName}
github-compare:      {kind, provenance: "forge-reported", host: "github.com",
  repositoryId, fullName}
```

A compare's pinned base and head live in `revision`, not in the member.

`revision.repository` is `github-repository`, the SHA-256 of canonical
`{host, repositoryId}`. GitHub's numeric repository id, not the name, is the
identity: after the first read every request names the repository as
`/repositories/<id>`, so a rename, or a new repository under the old name,
cannot change what is read. `fullName` is display only. `headRepositoryId` is
the repository the head branch lives in (a fork's id, or null when GitHub no
longer reports it). The digest covers every member field, so another pull
request number, repository id or head repository is another record and
another producer scope. The binding's own repository stays the workspace,
which may be a different repository, such as a documentation checkout; the
two are recorded side by side and never required to match.

### Range by pull request state

| State | `revision.base` | `mergeBase`, `diffFrom` | Checked against |
| --- | --- | --- | --- |
| open | the target branch's tip now (`git/ref/heads/<base.ref>`) | GitHub's compare merge base | the pull request's `changed_files` |
| merged (merge commit, squash, or rebase) | the pull request's recorded `base.sha`, which stops moving at merge | the compare merge base of `base.sha...head.sha` | the pull request's `commits` and `changed_files` |
| closed, not merged | refused | | `change-source-github-pull-closed-unmerged` |

Both pull request states are `three-dot`, with `head` the pull request's
`head.sha`. A merged pull request never reads the target branch's tip: after
a merge commit, the head is already inside it, and that range would be
empty (`change-source-empty-range`). A commit URL is `first-parent-commit`
with `mergeBase: null`; a root commit diffs against the empty tree.

Every request after the first names commits and trees by full id, so only
the pull request object can move. It is read again last: a head that moved
since the first read refuses with `change-source-github-head-moved`; a target
branch that moved does not.

### The forge-reported record

- `files` come from GitHub's compare (pull request and compare) or commit
  file list, in GitHub's order. Status `added`, `removed`, `modified`, `renamed` and
  `copied` map to `A`, `D`, `M`, `R` and `C`; `modified` or `changed` with a
  different object type in the two modes is `T`. Any other status refuses
  with `change-source-github-response-invalid`.
- Modes and blob ids come from the two root trees, read recursively by id
  (`git/trees/<id>?recursive=1`). A tree GitHub marks `truncated` refuses
  with `change-source-github-tree-truncated`; a listed path missing from its
  tree refuses as an invalid response.
- `similarity` is always null: GitHub reports no rename score.
- `binary` is false: GitHub does not report it. A file whose content
  changed and that GitHub sent no `patch` (or an empty one) for carries
  `diffOmitted: {basis: "forge-omitted", forgeReason: "no-patch"}`, stays in
  the manifest, and has no section in the diff. This includes a file filled
  from, or emptied to, the empty file. A pure rename, a mode change, and an
  added or deleted empty file change no content, so they carry no omission
  and keep a header-only section.
- `added` and `removed` are GitHub's `additions` and `deletions`.
- `labels` is empty: the workspace and shallow-history labels are git facts
  about a local checkout.
- `protocol` is `{provider: "github"}`.
- The diff original is synthesized in git's own header shape (`diff --git`,
  mode lines, `rename from`/`to`, `index <old>..<new>[ <mode>]` with full ids,
  C-quoted paths, and `---`/`+++` only when there are hunks) around GitHub's
  hunk text, without a `similarity index` line. Every other line matches
  `git diff-tree -p -M --full-index` of the same range.
- `fileDiffMaxBytes` omits a synthesized section by its measured size, as for
  a local range, and `diffMaxBytes`, `commitsMax` and `changedFilesMax` refuse
  as for a local range. Commit subjects, paths and hunks are screened the same
  way: text with no UTF-8 form (a lone surrogate in GitHub's JSON) refuses
  with `change-source-encoding-unsupported`, and a configured credential with
  `change-source-credential-present`.

### Completeness

Completeness comes from the totals GitHub declares and from the two trees,
never from GitHub's own page caps. Listings follow only `Link: rel="next"`,
so an exactly full last page with no next link ends the list. A compare must
list exactly `total_commits` commits; a pull request's first compare page's
files must number its `changed_files`; a commit's files must sum to its
declared `stats.additions` and `stats.deletions`. A shortfall refuses with
`change-source-github-incomplete` and the counts.

Then every GitHub kind's file list must match its two root trees. The paths
whose entry differs between the trees (files, symlinks and submodules; a
directory is no entry), compared by path, mode and id, must be exactly the
listed paths plus each rename's old path; a copy's source is unchanged and is
not added. Sets are compared, not counts, so a list of the right length that
names another file, or names one twice, still refuses. A mismatch refuses
with `change-source-github-incomplete`, naming how many listed paths the trees
do not change and how many changed paths are not listed.
`changeSources.changedFilesMax` applies to the trees' count first, with each
listed rename counted once, so a change over the bound refuses with its size
rather than as an incomplete list. A compare declares no file total, so this
check is what makes its file list complete.

The check admits a rename with or without an edit, a copy, a mode-only
change, a file replaced by a symlink, a file and a directory swapping one
path, a submodule bump, and an empty file added or deleted.

It also applies to the pull request and commit kinds, which changes what
they admit: a merge commit's file list must equal the diff from its first
parent, so an empty or combined-diff list refuses where the line totals
alone admitted it, and a pull request's list must equal the diff from the
compare's merge base. Two things stay unchecked: a pull request over the
files a compare lists is refused rather than read in full from
`pulls/<n>/files`, and the hunks are GitHub's; the check covers paths, modes
and ids, not hunk text.

### Transport

Reads use Node's built-in `fetch` against `https://api.github.com` with
`Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`,
and `per_page=100`. No request carries an Authorization header, and nothing
reads a token from the environment. Redirects are handled by hand
(`redirect: "manual"`): one within `https://api.github.com`, such as a renamed
repository's move to `/repositories/<id>`, is followed up to
`changeSourcesGithub.redirectsMax`; any other target refuses with
`change-source-github-redirect-cross-host`. Bodies are counted while they
stream and refused one byte past `changeSourcesGithub.responseMaxBytes`, and
each request is aborted at `changeSourcesGithub.requestTimeoutMs`. Nothing is
retried.

| Answer | Code |
| --- | --- |
| 429, or 403 with `x-ratelimit-remaining: 0` or `retry-after` | `change-source-github-rate-limited`, with the reset time |
| any other 403 | `change-source-github-forbidden` |
| 404 | `change-source-github-not-found` |
| any other non-200 | `change-source-github-request-failed`, with the status |
| a body that is not JSON, or a missing or mistyped field | `change-source-github-response-invalid`, with the field |
| a network failure | `change-source-github-unreachable`; its remediation names `NODE_USE_ENV_PROXY=1`, since Node's `fetch` ignores `HTTPS_PROXY` without it |
| the caller's own abort | rethrown unchanged |

The `gh` CLI is not a transport in this release. `gh` reads `GH_TOKEN`,
`GITHUB_TOKEN`, `GH_HOST` and `GH_ENTERPRISE_TOKEN` from the environment and
its own keyring (`gh help environment`), so a `gh` transport would rest the
no-credential and cross-host guarantees on `gh` rather than on DocsFab, and
it would need the host command runner, which runs `git` and `glab` only, to
admit a new command. Reads stay anonymous; with `GH_TOKEN` or `GITHUB_TOKEN`
set, no request carries an Authorization header and no command runs. For a
private repository, or past the anonymous allowance, check the change out
and pass a local `--change` range.

### Bounds

| Limit | Default | On breach |
| --- | --- | --- |
| `changeSourcesGithub.pagesMax` | 8 | Refuses with `change-source-github-pages-bound` before reading one page more. |
| `changeSourcesGithub.responseMaxBytes` | 8,388,608 | Refuses with `change-source-github-response-bound` and the bytes counted. |
| `changeSourcesGithub.redirectsMax` | 3 | Refuses with `change-source-github-redirects-bound` at one redirect more. |
| `changeSourcesGithub.requestTimeoutMs` | 30,000 | Refuses with `change-source-github-timeout-bound` and the elapsed time. |

The rationale for each is in `config/limits/changeSourcesGithub.yaml`. A
merged pull request with up to 100 commits takes five requests (the pull
request, the compare, two trees, the head re-read), an open one six (plus
the target branch ref), a commit with up to 100 files five (the
repository, the commit, its parent, two trees), and a compare with up to 100
commits six (the repository, two pins, the compare, two trees); each further
page adds one, so a compare at `changeSources.commitsMax` (256) takes eight.
GitHub publishes an allowance of 60 anonymous requests an hour from one
address. That is GitHub's figure, not a DocsFab bound, and it allows roughly
7 to 10 compare resolutions an hour.

### `--pr` and `--mr` with a GitHub pull request

On `docsfab run` only, `--pr` or `--mr` with an `https://github.com` or
`https://www.github.com` pull request URL binds that pull request as the
run's change source, exactly as `--change` would; the two options are two
spellings of one option. The value passes every gate a GitLab value does:
one value across `--pr` and `--mr`, the `create-documentation` and
`update-documentation` workflows only, no resume flag, no `--change` beside it
(`change-source-selector-conflict`), and no date-window instruction
(`change-source-date-window-conflict`). It combines with `--comparison-base` or
`--comparison-workspace` as `--change` does. A GitHub commit or compare URL under
`--pr` or `--mr` refuses with `change-source-github-pr-not-pull-request`,
which points to `--change`; another github.com path refuses with the URL
grammar's code. Any value not on `https` github.com, including a scheme-less
`github.com/...` path and other forges, keeps the merge-request selector's own
refusal. `docsfab do`, `live-agent` and `sources` still read GitLab merge
requests only and refuse a GitHub URL with `unsupported-provider`.

## GitLab merge requests

The `gitlab-merge-request` kind binds a GitLab merge request's diff.
DocsFab reads one answer from GitLab to pin the commits. When the checkout
holds every object the diff reads, every id and byte of the diff comes from
the local resolver, re-hashed as for a local range (`local-verified`). When
it does not, the diff is read from GitLab's own diff instead
(`forge-reported`, below). It never fetches.

Modules: `src/inputs/change-source/gitlab.ts` (the merge request read, the
mapping, the presence probe and routing), `src/inputs/change-source/gitlab-forge.ts`
(the forge arm), `src/inputs/change-source/diff-text.ts` (git's header
spelling, shared with the GitHub arm), and the kind's entries in each
extension table: selector arm `gitlabMergeRequestSelector`, source decoder
`gitlabMergeRequestSource`, kind arm `gitlab-merge-request`, producer ids
`change-source-gitlab-local` and `change-source-gitlab-forge`, and the
`gitlab-project` repository identity.

**Selectors.** `--change` claims a merge request URL, `host/group/project!N`,
and `!N` for the checkout's own GitLab project, through the `--mr` grammar,
so both options accept and refuse the same forms with the same codes. A bare
number stays a local revision name. A github.com URL is left to the GitHub
arm, which claims disjoint values. `docsfab run --mr <reference>` (or
`--pr`) carries the same selector, so it binds the same change.

**The read.** One `glab api --hostname <host> --method GET
projects/<path>/merge_requests/<number>` through the operator's own `glab`
login. DocsFab keeps only ids, numbers and the canonical project path from
the answer, never its text or stderr. An answer about another merge request or
project (its `iid`, `project_id`, or `references.full` path differs from the
one asked about) fails as an invalid GitLab response. `!N` first reads the
checkout's GitLab remote to name the project.

**The `source` member.** Closed keys: `kind`, `provenance` (`local-verified`
or `forge-reported`, which arm read the diff),
`host`, `projectPath` (GitLab's own spelling), `projectId` (the target
project), `iid`, `state` (`opened` or `merged`), `mergeMode`
(`merge-commit`, `squash`, `fast-forward`, or null while open),
`diffRefs: {base, start, head}`, `mergeCommit`, `squashCommit`, and `fork`
(the source project differs from the target). An open member records neither
merge nor squash commit; each merge mode records exactly the commit its diff
is read from. The repository identity is `gitlab-project`, the digest of the
canonical `{host, projectId}` of the target project, never `local-checkout`.

**Which diff.** The mapping follows GitLab's own merge request diff:

| State | Range | `commits` |
| --- | --- | --- |
| `opened` | `two-dot`, `diffRefs.base..diffRefs.head` (needs no start commit) | The branch's commits on head since base. |
| `merged` with a merge commit | `first-parent-commit` on the merge commit | The merge commit alone. |
| `merged` with a squash commit only | `first-parent-commit` on the squash commit | The squash commit alone. |
| `merged` with neither (fast-forward) | `two-dot`, `diffRefs.base..diffRefs.head` | The branch's commits. |

`commits` is always the commits of the diffed range; the merge request's own
commit list is not recorded. An open merge request carries the label
`merge-request-unmerged`.

**States and answers that refuse, before any git read.** `closed` refuses
with `change-source-mr-closed-unmerged`, `locked` with
`change-source-mr-locked`, and `diff_refs: null` with
`change-source-mr-diff-refs-missing`. A `sha` that differs from
`diffRefs.head` refuses with `change-source-mr-moved`. Another state is an
invalid GitLab response.

**Routing.** The local arm runs when the checkout holds every object the
range reads. Outside a partial clone that is each named commit, checked with
`cat-file --batch-check`; a missing tree or blob there is damage and refuses
`change-source-git-failed`. In a partial clone (a promisor remote, or
`extensions.partialclone` alone) it is also every tree of each side the diff
compares and each blob on either side of the raw diff. Those are probed with
`rev-list --objects --missing=print`, which never lazy-fetches on any git
version, before any read that could fetch: git before 2.44 ignores the trusted
runner's `GIT_NO_LAZY_FETCH`. Whole trees over-approximate the subtrees a
recursive diff descends, so the probe never under-reads. A missing commit, a
missing tree or blob in a partial clone, and the
local resolver's `change-source-revision-unresolved` or
`change-source-history-unavailable` refuse with
`change-source-mr-objects-unavailable`, naming the missing role; a missing
tree or blob also names the sides' commits, old side first, in the order the
remediation checks them out. Every other
refusal keeps its own code: integrity, grafts, encoding, credential, limit
and bound refusals are never treated as missing objects. A project that
differs from the checkout's remote is not a refusal: the identity records
which project the change belongs to.

**Reading the diff from GitLab.** Only a `change-source-mr-objects-unavailable`
refusal of the local arm sends the diff to GitLab. Damage (a tampered
object, a full clone missing a blob), grafts, encoding, credential, limit
and bound refusals keep their own codes and read nothing more from GitLab.
`change-source-revision-unresolved` covers a corrupt interior parent as well
as an absent one, so a damaged parent behind a present commit reaches GitLab
too; the run's status names the local refusal that caused the fallback. Every
read is a `glab api --hostname <host> --method GET` through the same login,
addressed by the pinned numeric project id, 100 items a page:

| Range | Reads | Completeness |
| --- | --- | --- |
| `opened`, or `merged` fast-forward (`two-dot`) | `merge_requests/<number>/diffs`, then `repository/commits?ref_name=<base>..<head>&order=topo` | The item total equals the merge request's `changes_count`; the newest listed commit is the pinned head. |
| `merged` with a merge or squash commit (`first-parent-commit`) | `repository/commits/<sha>`, then `repository/commits/<sha>/diff` | The added and removed lines of every file's hunks equal the commit's `stats`. |

GitLab sends no next-page header: a page shorter than 100 items is the last,
so an exact multiple ends with one empty page, and a listing that would pass
`ceil(<bound> / 100) + 1` pages refuses with the bound before that page is
read. `changes_count` must be an exact number: a capped one such as `1000+`
refuses `change-source-mr-forge-overflow` (or the changed-file bound first,
when the cap is at or over it), a missing one or a total that disagrees
refuses `change-source-mr-forge-incomplete`. The merge request's commit
listing has no count to check, so only its newest commit is checked; GitLab
lists in topological order, newest first, and the record reverses it, which
matches the local arm's `rev-list --topo-order --reverse`. The merge request
is read again after the last page: a `sha`, head or base that moved since the
pin refuses `change-source-mr-moved`.

Each file's `diff` is GitLab's hunks alone, the one line `Binary files <old>
and <new> differ` for the file's own paths, or empty; any other shape
refuses `change-source-mr-forge-incomplete` naming the field. DocsFab writes
each section's header in git's shape with C-quoted paths and no `index` line,
since GitLab sends no blob ids, and re-writes a binary marker from its own
quoted paths. Files are listed in byte order of the new path (the old path
for a deletion), which is git's own diff order. Statuses follow GitLab's
flags, with a mode type change as `T`; an absent side's mode `"0"` becomes
`000000`. An empty diff is read per endpoint: on a commit diff the `stats`
check proves it holds no line, so the file binds with its header; on a merge
request's `/diffs`, where no line total exists, it cannot be told from a
diff GitLab collapsed, so every empty one, a pure rename included, is listed
with `diffOmitted: {basis: "forge-omitted", forgeReason: "no-patch"}`. A file
whose diff text holds U+FFFD (or a lone surrogate) is listed with
`forgeReason: "text-replaced"`, and the rest binds; U+FFFD in a path or a
commit subject refuses `change-source-mr-forge-text-replaced`. GitLab
could also transcode non-UTF-8 text without a U+FFFD, which no check here
can see. Diff text is screened for configured credentials as a local range
is.

The forge record carries no `baseTree`, `headTree` or blob ids and no rename
score, `protocol: {provider: "gitlab"}`, the target project's identity, the
`objectFormat` of the pinned ids' width, `mergeBase` and `diffFrom` equal to
`diffRefs.base` for `two-dot`, and the label `merge-request-unmerged` for an
open merge request but none of the checkout labels. Commit subjects are the
first line of each commit's `message`, never GitLab's clipped `title`. Its
producer is `change-source-gitlab-forge`, and its observations are versions
of their own bytes. A `glab` call that fails keeps
`change-source-mr-objects-unavailable`, with the local cause and the GitLab
failure class in its detail; an answer larger than a `glab` read may return
refuses `change-source-mr-forge-page-bound`.

**Text beside the diff.** A merged merge request also binds its text through
the `gitlab-merged-mr` producer into the same source binding, one
producer-scope row per producer. The text's merge and squash commits must
equal the pinned ones, or the run refuses with `change-source-mr-moved`. An
open merge request binds its diff and manifest only, and the run's status
names why: an open merge request's text can still change.

**Bounds.** The kind reuses `changeSources.commitsMax`,
`changeSources.changedFilesMax`, `changeSources.diffMaxBytes` and
`changeSources.fileDiffMaxBytes`, enforced by the local resolver or the
forge arm, and adds none.

## Release ranges

`release-range` names a release as the first-parent commits on its head since
its base, and binds each one as its own record, so a release whose whole
diff is far over `changeSources.changedFilesMax` and
`changeSources.diffMaxBytes` still binds unit by unit. The units index lists
every unit, so a later triage step can check that it covered each one. It is
an index over this contract, not a second change contract.

### Grammar

The kind owns the whole `release:` namespace. Git ref names cannot contain
`:`, so no branch, tag or commit name is ever read as a release form, and a
calendar-versioned tag such as `2026.09` or `2026-09-01` stays a ref: a date
is never read from an endpoint.

| Form | Decision |
| --- | --- |
| `release:<base>..<head>` | Admitted. Each endpoint follows the local endpoint grammar (a branch, tag or commit name with optional `~N` and `^N`). |
| `release:since-last`, `release:since-last..<head>` | Reserved: refuses with `change-source-release-form-unsupported`, naming `release:since-last`. |
| `release:dates:<start>..<end>:<zone>[@<branch>]` | Reserved: refuses with `change-source-release-form-unsupported`, naming `release:dates:`. |
| any other `release:` value | Refuses with `change-source-release-form-unsupported`; `release:<base>...<head>` and an empty endpoint refuse with `change-source-selector-grammar`. |
| `release://...`, or a value ending in `!<number>` | Not claimed: a URL or a merge request reference belongs to another kind, and refuses as one. |

A plain `<base>..<head>` between two release tags stays a `local-range`
two-dot range: one diff and one commit list for the whole release. On a real
release that refuses at the range bounds (this repository's
`v0.0.1-rc.1..v0.0.1-rc.2` changes 1,840 files over 252 commits), so name the
release with `release:` instead.

### Units

The host resolves both endpoints, then lists the units with
`rev-list --first-parent <head> ^<base>`, oldest first, after counting them
with `rev-list --first-parent --count`. Before git peels an endpoint, every
annotated tag object it names is re-hashed from its raw bytes, so a tampered
tag refuses with `change-source-integrity-mismatch` naming `base tag` or
`head tag`; every unit commit and the base commit are re-hashed too. A grafts
file refuses before the walk.

Each unit is read by the local resolver as a single commit against its first
parent, with `source: {kind: "release-range"}`. A merge or octopus merge
diffs against its first parent, and a root commit against the empty tree.
Every local rule applies per unit: re-hashing, the shallow-history refusals,
encoding, credentials, and the `changeSources.*` bounds. `commitsMax` bounds a
unit's own commit list (always one) and the list of commits a merge brought
in.

| Unit field | Meaning |
| --- | --- |
| `position`, `id`, `parents`, `subject` | 1-based position along head's first-parent line, the commit, its raw parents, and its subject line. |
| `kind` | `empty` when the unit's tree equals its first parent's (or, for a root, the empty tree); otherwise `root`, `plain`, `merge` (two parents) or `octopus` (more). |
| `evidence` | `{state: "bound", changeSourceSha256}` for a bound record; `{state: "omitted", code, limitName, observed, limit}` for a unit over a per-unit bound; `{state: "next-page"}` for a unit after this run's page. |
| `introduced` | For a merge, the commits `<unit>^1..<unit>` brought in, oldest first, as `{id, subject}`; empty for any other unit. Over `changeSources.commitsMax` it is `{state: "omitted", ...}` with the count, and after the page `{state: "next-page"}`. |
| `link`, `linkReason` | Always `null` and `forge-identity-unavailable`: a local checkout carries no forge identity, so no unit links to its merge or pull request. |

Only a unit's own diff over `changeSources.diffMaxBytes`, its changed files
over `changeSources.changedFilesMax`, or its diff or manifest over
`sources.extractionMaxSpans` or `sources.extractionMaxDerivativeBytes` when
extracted whole becomes a listed omission; the release continues, and the
operator status names the unit, the limit and the measured value. Every other
refusal inside a unit refuses the whole release: an integrity mismatch, a
configured credential, an encoding failure, a grafts file, a failed git read,
missing history, an original over `sources.extractionMaxOriginalBytes` (a
unit's diff stays under it, since `changeSources.diffMaxBytes` may not exceed
the extraction byte bounds), an extraction past `sources.extractionMaxMs`, or
an abort.

The index (`kind: docsfab-change-source-release-units`, `schemaVersion: 1`,
digest `releaseUnitsSha256`) also carries the pinned `revision` (base and
head commits, `local-checkout` identity), the `objectFormat`, the annotated
`tags` each endpoint named (null for a commit or branch), its `labels`, and
the `page`.

| Index label | Set when |
| --- | --- |
| `base-off-first-parent-line` | The oldest unit's first parent is not base: base is off head's first-parent line, such as a tag on a release branch, so the walk can list units whose changes the base release already carried through a merge. |
| `introduced-lists-unproven-shallow` | A shallow checkout bound a merge unit: the boundary may have cut its introduced list. |

A range whose head is base or one of base's ancestors refuses: `base` equal to
`head` with `change-source-empty-range`, otherwise with
`change-source-release-no-units`.

### Paging and observations

One run binds at most `changeSourcesRelease.unitsPerRunMax` units, oldest
first. The page is also no longer than the units index allows: the index is
the release's one required observation, and a write step reads it whole, so
before any model call the host grows the page one unit at a time while the
index still fits one step's source-read budget for the model the run binds
(`sources.readResponseCeilingBytes`, or `sources.readInputWindowShare` of a
smaller window). A longer range binds that page and defers the rest: the
index lists every later unit with `evidence: {state: "next-page"}`, its `page`
records `unitsPerRun`, `readBudgetBytes` (the budget the index was sized to),
`bound`, `remaining` and `continuation`, and the operator status names every
later unit and the continuation selector
`release:<last unit of this page>..<head>`, which binds the next page. When
the budget cut the page short, the status also says so with the budget.

The index lists every unit of the range, so a long range on a small budget
can leave no room even for a one-unit page. The host then refuses with
`change-source-release-index-over-read-budget`, naming the index's bytes, the
budget and the limit that set it, before any model call. Name a shorter range,
bind a model with a larger window, or raise the ceiling when it set the
budget.

The producer `change-source-release`, version 1, mints the units index
(`application/vnd.docsfab.change-source-release-units+json`, adapter
`docsfab-change-source-release-units` v1, path
`change-source/release-<base>-<head>/units.json`) and each bound unit's
manifest and diff at their usual paths, all under one producer scope that
digests the read scope, the release's repository, base and head, and the
index digest. A source binding holds at most 256 observations, so before
any model call the host refuses with
`change-source-release-observations-exceeded`, naming the count, when the
index, two observations per bound unit, and the run's `--source` files would
exceed it.

Only the index is a required observation; each unit's manifest and diff are
bound and readable but optional. This departs on purpose from the rule that
every observation the operator named is required: requiring every unit record
or diff would share one write step's read budget across hundreds of sources
and leave fragments of each, while the index already lists every unit with
its subject, the commits it brought in and its record's digest. Measured on
this repository's `v0.0.1-rc.1..v0.0.1-rc.2` (126 merge units, about 15
changed files each), the index is 103,621 bytes and a write step reads it
whole at the 262,144-byte default; requiring the index and every unit record
instead needed 1,002,483 bytes and read the index at 3,370 bytes. On a
128,000-token window (a 76,185-byte budget) the same release binds 35 units a
page. `v0.0.1-rc.0..v0.0.1-rc.1` (389 units) binds a full 126-unit page with
a 238,175-byte index at the default, and refuses with
`change-source-release-index-over-read-budget` at 76,185 bytes. The
`--source` files a run binds beside the release are required too and share
the same budget, smallest first.

### Run-record citation

A release run cites what it bound in two run-record fields, both from the
queued save (see [run records](run-records.md)):

- `changeSources` holds one entry for each unit record the page bound, in
  index order, unique by `changeSourceSha256`, with `sourceKind:
  "release-range"`. A unit omitted by a per-unit bound has no record, so it
  has no entry; the index lists it. A page whose every unit was omitted
  leaves the field absent.
- `changeSourceRelease` cites the units index, which is no change record and
  so is not a `changeSources` entry: `{ "schemaVersion": 1, "kind":
  "docsfab-run-change-source-release", "repository", "objectFormat", "base",
  "head", "releaseUnitsSha256", "observationId", "units", "pageUnits",
  "omittedUnits", "remainingUnits", "continuation" }`.

The host builds both from the acquired index and records, and refuses
`change-source-record-unbound` before the workflow starts when they disagree:
a unit the index lists as bound without its acquired record, or a record the
index does not list as bound. Readers decode the two fields together: a
`release-range` entry needs the index citation, and the citation needs
exactly `pageUnits - omittedUnits` entries, all `release-range`, from its
repository.

### Bounds

| Limit | Default | On breach |
| --- | --- | --- |
| `changeSourcesRelease.unitsMax` | 512 | Refuses with `change-source-release-units-bound` and the count from `rev-list --first-parent --count`, before any unit is listed. |
| `changeSourcesRelease.unitsPerRunMax` | 126 (ceiling 127) | Pages: the units after the page are listed with the continuation selector. |

Per-unit bytes and counts reuse the `changeSources.*` bounds; no release
bound limits bytes. The index's bytes are bounded by the step source-read
budget, as above. The rationale for each is in
`config/limits/changeSourcesRelease.yaml`.

## Refusal codes

Every refusal is a `ChangeSourceError` with one of the codes in
`CHANGE_SOURCE_REFUSAL_CODES`, each mapped to a failure class in the operator
catalog: `change-source-option-value-missing`,
`change-source-option-form-unrecognized`, `change-source-selector-repeated`,
`change-source-selector-grammar`, `change-source-kind-unsupported`,
`change-source-selector-conflict`, `change-source-workflow-unsupported`,
`change-source-resume-unsupported`, `change-source-date-window-conflict`,
`change-source-revision-unresolved`,
`change-source-history-unavailable`, `change-source-no-merge-base`,
`change-source-empty-range`, `change-source-integrity-mismatch`,
`change-source-grafts-present`, `change-source-encoding-unsupported`,
`change-source-credential-present`, `change-source-limits-inconsistent`,
`change-source-git-failed`, `change-source-resolution-missing`, the GitLab
codes `change-source-mr-objects-unavailable`,
`change-source-mr-closed-unmerged`, `change-source-mr-locked`,
`change-source-mr-diff-refs-missing`, `change-source-mr-moved`,
`change-source-mr-forge-incomplete`, `change-source-mr-forge-overflow`,
`change-source-mr-forge-text-replaced` and
`change-source-mr-forge-page-bound`, and the
GitHub codes `change-source-github-url-credentials`,
`change-source-github-url-insecure`, `change-source-github-url-grammar`,
`change-source-github-url-partial`, `change-source-github-compare-unsupported`,
`change-source-github-pull-closed-unmerged`,
`change-source-github-head-moved`, `change-source-github-incomplete`,
`change-source-github-tree-truncated`,
`change-source-github-redirect-cross-host`,
`change-source-github-rate-limited`, `change-source-github-forbidden`,
`change-source-github-not-found`, `change-source-github-request-failed`,
`change-source-github-unreachable`,
`change-source-github-response-invalid`,
`change-source-github-two-dot-not-ancestor`, and
`change-source-github-pr-not-pull-request`; the release codes
`change-source-release-form-unsupported`, `change-source-release-no-units`,
`change-source-release-observations-exceeded`, and
`change-source-release-index-over-read-budget`; and the host-defect code
`change-source-record-unbound`: the host resolved the change but reached the
workflow without the record it acquired, so the run record could not cite it.
The bound refusals are the catalog's own `OperationalLimitError` codes above.
