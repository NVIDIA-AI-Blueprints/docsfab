---
title: "Bind a GitHub Change in DocsFab"
description: "Ground a create or update job on one GitHub pull request, commit, or compare selection."
status: draft
content.type: how-to
---

Ground a create or update job on one GitHub pull request, commit, or compare selection.

## Prerequisites

Use a supported public github.com pull request, commit, or compare URL. Configure a model and select a create or update workflow.

## Bind a GitHub Pull Request, Commit, or Compare

`--change` also accepts the URL of a pull request, a commit, or a compare in a
public github.com repository. DocsFab reads the change from the GitHub REST API, so
the checkout needs none of its objects. A shallow, remote-less checkout of the
documentation works:

```bash
docsfab run update-documentation --repo /absolute/path/to/repository \
  --instruction "Update the export guide for this change." \
  --change https://github.com/<owner>/<repo>/pull/<number> --patch-only
```

The following table lists the URL forms that `--change` accepts.

| URL | What the run binds |
| --- | --- |
| `https://github.com/<owner>/<repo>/pull/<number>`, or its `/files`, `/commits`, or `/changes` view | An open pull request: the diff from the merge base of the target branch's current tip and the head, and the head's commits since that merge base. A merged pull request, by merge commit, squash, or rebase: the same, from the base and head the pull request recorded, which stop moving when it merges. |
| `https://github.com/<owner>/<repo>/commit/<sha>` | That one commit, diffed against its first parent. An abbreviated id is pinned to the full id GitHub resolves. |
| `https://github.com/<owner>/<repo>/compare/<base>...<head>` | The diff from the merge base of the two refs to `<head>`, and the commits on `<head>` since that merge base, as GitHub's compare page shows them. |
| `https://github.com/<owner>/<repo>/compare/<base>..<head>` | The diff from `<base>` itself to `<head>`. DocsFab reads it from GitHub only when `<base>` is an ancestor of `<head>`, where it equals the `...` form. |

`www.github.com` and a `.diff` or `.patch` suffix name the same change, and a
`#` fragment is ignored because it only scrolls the page. A compare side is a
branch, tag, or commit name, and may hold `/`, as in
`compare/main...feature/export-path`; a percent-encoded side such as
`feature%2Fx` is decoded once. DocsFab pins both sides to commit ids before it
reads the compare, so a branch that moves during the read cannot change it.
A compare page's `?expand=1` is accepted; any other query refuses. The record names
the repository by GitHub's numeric repository id, never by its name, so a
renamed repository keeps its identity and a new repository under an old name
does not inherit it. The manifest carries the pull request number, its state,
the repository the head branch lives in, and
`provenance: "forge-reported"`, because DocsFab records what GitHub reported
and does not hold the objects to verify them. GitHub reports no rename score,
so a rename records `similarity: null`. A file GitHub sent no patch for, such
as a binary or very large file, stays listed with its diff left out, and the
run's status output names it.

DocsFab reads anonymously: no request carries a token or an Authorization
header, and nothing is read from `GITHUB_TOKEN` or `GH_TOKEN`. DocsFab does not
use the `gh` CLI. GitHub allows 60 anonymous API requests an hour from one
address. A merged pull request with up to 100 commits, or a commit with up to
100 changed files, takes five requests, and an open pull request or a compare
with up to 100 commits six, so about ten runs an hour fit; each further 100
commits or files adds one. Past the limit, the run refuses with
`change-source-github-rate-limited` and the reset time. Node's `fetch` ignores
`HTTPS_PROXY` unless `NODE_USE_ENV_PROXY=1` is also set, so on a host behind a
proxy set both.

The following conditions stop the run before any model call, each with its own code:

- A user name or password in the URL refuses with
  `change-source-github-url-credentials`, and `http:` with
  `change-source-github-url-insecure`. Neither is read.
- A port, a query string such as `?w=1`, a `.` or `..` path segment, a
  malformed compare side, or a path that is not a pull request, commit, or
  compare refuses with `change-source-github-url-grammar`.
- A single commit or commit range inside a pull request, such as
  `/pull/<number>/commits/<sha>` or `/pull/<number>/files/<a>..<b>`, refuses
  with `change-source-github-url-partial`, because binding the whole pull
  request would widen the change.
- A compare URL with one ref and no range, a side in another fork
  (`owner:branch`), or a reflog date (`@{...}`) refuses with
  `change-source-github-compare-unsupported`.
- A `<base>..<head>` compare whose base is not an ancestor of its head (the two
  diverged, or the head is behind the base) refuses with
  `change-source-github-two-dot-not-ancestor`. Write `<base>...<head>`, or check
  out both commits and pass `--change <base>..<head>`. A `<base>...<head>`
  compare whose head is already in the base's history refuses with
  `change-source-empty-range`.
- A pull request closed without merging refuses with
  `change-source-github-pull-closed-unmerged`.
- A pull request whose head moves while DocsFab reads it refuses with
  `change-source-github-head-moved`. A target branch that moves does not.
- A list shorter than the totals GitHub declares (commits, files, or changed
  lines), or a file list that differs from the paths changed between the two
  repository trees GitHub reports, refuses with
  `change-source-github-incomplete`, and a repository tree GitHub truncated
  refuses with `change-source-github-tree-truncated`. The tree check also
  applies to pull requests and commits: a merge commit whose file list is not
  its diff from its first parent refuses.
- A redirect away from `https://api.github.com` refuses with
  `change-source-github-redirect-cross-host`. A renamed or moved repository
  redirects within the API and is followed.
- An HTTP 403 for any reason other than the rate limit refuses with
  `change-source-github-forbidden`, a 404 (missing or private) with
  `change-source-github-not-found`, and any other failing status with
  `change-source-github-request-failed`.

The local range bounds, `changeSources.commitsMax`,
`changeSources.changedFilesMax`, `changeSources.diffMaxBytes`, and
`changeSources.fileDiffMaxBytes`, apply unchanged. The following four more limits bound the reads.

| Limit | Default | Host override |
| --- | --- | --- |
| `changeSourcesGithub.pagesMax` | 8 pages | `DOCSFAB_CHANGE_SOURCES_GITHUB_PAGES_MAX` |
| `changeSourcesGithub.responseMaxBytes` | 8,388,608 bytes | `DOCSFAB_CHANGE_SOURCES_GITHUB_RESPONSE_MAX_BYTES` |
| `changeSourcesGithub.redirectsMax` | 3 redirects | `DOCSFAB_CHANGE_SOURCES_GITHUB_REDIRECTS_MAX` |
| `changeSourcesGithub.requestTimeoutMs` | 30,000 ms | `DOCSFAB_CHANGE_SOURCES_GITHUB_REQUEST_TIMEOUT_MS` |

A read past one of them refuses and names the bound and the observed value.
`--change` with a GitHub URL keeps every combination rule of a local range.

On `docsfab run`, `--pr` and `--mr` also accept a github.com pull request URL
and bind it exactly as `--change` would:

```bash
docsfab run update-documentation --repo /absolute/path/to/repository \
  --instruction "Update the export guide for this change." \
  --pr https://github.com/<owner>/<repo>/pull/<number> --patch-only
```

The URL must use `https://github.com` or `https://www.github.com`. It keeps the
rules of `--pr`: pass one value across `--pr` and `--mr`, on
`create-documentation` or `update-documentation`, without a resume flag. It
combines with `--comparison-base` or `--comparison-workspace` as `--change`
does. It does not combine with `--change` (`change-source-selector-conflict`)
or a date-window instruction (`change-source-date-window-conflict`). A GitHub commit or compare
URL under `--pr` or `--mr` refuses with
`change-source-github-pr-not-pull-request`; pass it with `--change`. Any other
value, including a scheme-less `github.com/...` path, is read as a GitLab merge
request reference as before. `docsfab do`, `docsfab live-agent`, and
`docsfab sources` accept GitLab merge requests only.
