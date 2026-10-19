---
title: DocsFab Runner Quickstart
description: Run your first create workflow, retain a local patch, and inspect the result.
status: draft
---

Use the DocsFab runner, `docsfab run`, to create a new documentation page and
inspect the result as a local patch, without publishing or changing your
source checkout. This quickstart uses `--patch-only`. A successful run does not
guarantee that the page passes its quality checks or produces a patch.
For more information, refer to [Overview of DocsFab](../about/index.md).

## Prerequisites

Prepare the following items before you run the workflow:

- Install the CLI by following [Install DocsFab](installation.md).
- Configure a model profile, model ID, and the selected provider's API key by following [Configure the Model](../configure/model.md).
- Select a local Git repository containing the product and documentation that DocsFab should use as evidence.
- If a native non-Docker check needs isolated command execution, use Linux with an available Bubblewrap sandbox, as described in [Installation Prerequisites](installation.md#prerequisites).

A local patch needs no GitLab remote, `glab` authentication, push permission, or tracked `.docsfab.json`.
Without a tracked `.docsfab.json`, DocsFab uses the default `docs/` and `fern/` documentation roots and proposes no project configuration.
A tracked `.docsfab.json` stays authoritative and must be valid.
Refer to [Requirements by Operation](../manage/check-readiness.md#requirements-by-operation) for the requirements of other delivery modes.
The DocsFab runtime checkout and the selected input repository have separate roles, but they can be the same checkout when the authorized task documents DocsFab itself.
The same delivery prerequisites and protections apply.

When DocsFab runs in a container or continuous integration (CI) job, prepare
the checkout as the same operating-system user that runs `docsfab`. If the
source is mounted read-only, give that user read access to the repository,
including `.git`, and search access to its parent directories. Keep writable
runtime state and exported run results in separate directories that the runtime
user can write. Do not make the source writable just to provide space for
runtime state or exported results.

Git ownership checks and file permissions are separate. A readable checkout
can still fail Git's ownership check when another user owns it. Fix the CI
checkout or its private job copy so the runtime user owns it, or clone it as
that user. Do not disable Git's ownership protection or recursively change
ownership across a customer repository. Refer to
[Repository Access](../troubleshooting.md#repository-access)
if DocsFab reports a repository access error.

### Before You Start

Enter your input repository, run the offline readiness check, and inspect the
available workflows and the create workflow's steps:

```bash
cd /absolute/path/to/input-repository

docsfab doctor
docsfab list
docsfab plan create-documentation
```

`docsfab list` shows the available workflow names and titles. `docsfab plan`
shows a workflow's intended outcome, ordered steps, access modes, and skills
without executing it. For help choosing a workflow and reading its plan, refer
to [Discover DocsFab Workflows](discover-workflows.md).

Offline readiness does not establish successful model execution.
The commands in this guide use your current directory.
To target another local repository, add `--repo /absolute/path/to/repository`.

## Quickstart Steps

Use this path to create a page, retain a local patch, and review its reported result.

### Run Create Documentation

Follow these steps to request and inspect a local result.

<Steps>
  <Step title="Create a Local Patch">
Describe the outcome in ordinary language with a specific audience and scope.
Replace this example with your actual request; do not pass placeholder text such as `<feature>`:

```bash
docsfab run create-documentation \
  --instruction "Create docs/install-troubleshooting.md, an installation troubleshooting guide for developers. Keep the result local; do not publish." \
  --patch-only
```

Expected output: inspect these sections when a run record and patch are available.

- `VERDICT` distinguishes execution status from product disposition and, when applicable, publication outcome.
- `PATCH` lists changed files, with insertion and deletion counts when available.
- `RECORD` provides the run-record path and, when a patch is retained, a `Patch:` line with its artifact path.

DocsFab runs the workflow in a disposable workspace.
`--patch-only` retains a patch without applying generated files to the source checkout or opening a merge request.
Missing required evidence or checks can prevent delivery; a completed step sequence does not establish product readiness or audience validation.

For a one-shot request that lets DocsFab select a catalog workflow, use `docsfab do` instead:

```bash
docsfab do \
  "Create docs/install-troubleshooting.md, an installation troubleshooting guide for developers. Keep the result local; do not publish." \
  --patch-only
```
  </Step>
  <Step title="Inspect the Result">
Open the run record at the path printed under `RECORD` and inspect the retained patch when its `Patch:` path is present.
Read the verdict and limitations before treating the result as ready.
Refer to [Check the Result](#check-the-result) for readiness failures and the supported `needs-input` continuation loop.
Refer to [Keep the Result Local](#keep-the-result-local) for patch contents and delivery constraints, and [Human Output and JSON in DocsFab](../reference/status-and-configuration/human-output-and-json.md) for output contracts.
  </Step>
</Steps>

<Warning title="Select Local Delivery Explicitly">
A request that says not to publish still needs `--patch-only`.
Ordinary write runs default to draft merge request delivery; DocsFab does not derive delivery flags from request text.
</Warning>

## Optional Details

The delegated pilot is not the first-run create path and does not support remote publication.
Its `--allow-write` option currently stops with a typed nonzero result.
Merge request evidence requires your existing `glab` login and read access to the selected host and project.
These evidence reads are separate from permission to publish a draft merge request.

<Accordion title="Run a Delegated Task" id="run-a-delegated-task">

`docsfab do --delegate` is a named opt-in pilot. Bare `do` still classifies
one sentence onto a catalog workflow. `--delegate` is not a new default.

```bash
docsfab do --delegate \
  "Which flag enables JSON output?" \
  --repo /absolute/path/to/input-repository \
  --no-input --json
```

The result for this ordinary-question form prints to stdout as JSON; it does
not open a merge request or write to the repository.

The pilot starts a fresh finite task on the committed HEAD. Record
answers for that exact task with `--resume <task-id> --answers
<json-file>`. That records answers and continues the delegated driver
for the same task id. The task stays `needs-input` until that driver
finishes. There is no most-recent lookup, TTY prompt, silent
catalog fallback, or inherited grant. `--allow-write` requests local
documentation changes.
Until issues #758 and #779 land, that flag fail-closes with a typed
nonzero result instead of silently completing a read-only run. Remote
publication is unsupported. `--route-only` and `--dry-run` stay on
catalog `do` and cannot combine with `--delegate`.

The pilot runs a check only when you name it. Each `--check <npm-script>`
runs `npm run <npm-script>` in the repository after the driver finishes,
and the script must be declared under `scripts` in the repository's root
`package.json`. Repeat the flag for each script. A request that says
"run npm test" runs nothing by itself. A named check keeps the task from
`complete` until it passes. A paused task keeps its checks, so pass the
same `--check` flags again with `--resume`:

```bash
docsfab do --delegate "Review docs/api.md." \
  --repo /absolute/path/to/input-repository \
  --check docs:check --no-input --json
```

Refer to [Delegated Do Pilot](../workflows/delegate-a-task.md#delegated-do-pilot) for supported flags, continuation, and terminal statuses.
</Accordion>

## Keep the Result Local

Use `--patch-only` to run the workflow without opening a merge request:

```bash
docsfab do \
  "Create docs/install-troubleshooting.md, an installation troubleshooting guide for developers. Keep the result local; do not publish." \
  --patch-only
```

DocsFab runs the workflow in a disposable workspace and retains its patch. The
patch contains reviewable repository changes, including a proposed
`.docsfab.json` when bootstrap is needed, while excluding the private first-pass
reference-model bookkeeping used to bind the run. `--patch-only` does not apply
generated files to the source checkout. Use the paths printed under `PATCH` and
`RECORD` to inspect the retained result.

DocsFab preserves an explicit publication prohibition in the workflow
instruction. You must still pass `--patch-only` to select local delivery. If a
write request says not to publish while its flags select the default or an
explicit merge request delivery, or `--dry-run`, `docsfab do` and
`docsfab run` stop with `publication-prohibition-conflict` before workflow
execution. DocsFab does not derive delivery flags from ordinary language. For
the phrasings it recognizes, refer to
[A Request That Says Not to Publish Is Refused](../troubleshooting.md#a-request-that-says-not-to-publish-is-refused).

<Accordion title="Choose Draft Merge Request Delivery">

Draft merge request delivery requires all of these conditions:

- The target repository has an `origin` remote (or `--remote <name>`).
- `glab` is authenticated for the GitLab host used by the selected remote.
- You have permission to push a branch and create a merge request.

Tracked local changes stay in place; delivery writes from GitLab's target-branch revision, so a dirty checkout does not block `--draft-mr`.
The workflow plans, writes, checks, verifies, reviews, and evaluates the new documentation.
Default delivery creates a branch and opens one draft merge request after its prerequisites pass; it cannot merge the result.
If the repository has no tracked `.docsfab.json`, DocsFab proposes a host-derived configuration in the same documentation change.

Use `--dry-run` to preview the named workflow without running it:

```bash
docsfab run create-documentation \
  --instruction "Create docs/install-troubleshooting.md, an installation troubleshooting guide for developers." \
  --dry-run
```

`--dry-run` stops before workflow steps, repository inspection, model calls,
writes, or publication. It does not validate the target or authorize a later
write, and it is not an end-to-end workflow test. `--dry-run` and `--patch-only`
are separate modes and cannot be combined.

After you inspect the preview, generate the local patch with this command:

```bash
docsfab run create-documentation \
  --instruction "Create docs/install-troubleshooting.md, an installation troubleshooting guide for developers. Keep the result local; do not publish." \
  --patch-only
```

To open the default draft merge request instead, first satisfy the delivery
prerequisites, remove any publication prohibition from the instruction, and run:

```bash
docsfab run create-documentation \
  --instruction "Create docs/install-troubleshooting.md, an installation troubleshooting guide for developers."
```

DocsFab can use its runtime checkout as the selected input repository and open
a draft merge request through the same authorized delivery path as other
GitLab repositories. Use `--patch-only` when you want to retain the result
without publishing.

</Accordion>

<Accordion title="Historical Example: Update Documentation From Merged Merge Requests" id="update-documentation-from-merged-merge-requests">

The September 14, 2026 request below is a historical example, not a first-run requirement.
Replace its date, branch, and time zone with the scope of your actual update.

When you already have the changed files and current pages, bind them with
`--reader-source` on `docsfab run update-documentation`. Refer to
[Update Documentation Beside a Change in DocsFab](../workflows/update-documentation-beside-a-change.md).
Do not add `--reader-source` to `docsfab do`.

Use `update-documentation` without those bindings when merged merge requests
should drive the update and you do not want to enumerate MR numbers, SHAs, or
`--reader-source` paths. Name the merge requests, the branch they merged into,
the calendar day, and the IANA time zone. Keep the result local with
`--patch-only`:

```bash
docsfab run update-documentation \
  --patch-only \
  --instruction "Review the MRs merged into main on September 14, 2026, using America/Los_Angeles time. Collect the related code changes and existing documentation. Identify changes affecting end users, including commands, configuration, defaults, installation, workflows, and observable behavior. Update only the affected user documentation, preserving unrelated content. Skip internal changes with no user impact. Report which MRs require documentation changes, what you updated, and any evidence gaps. If merge records or diffs are unavailable, report that limitation rather than claiming complete coverage."
```

DocsFab discovers merge requests whose `merged_at` timestamp falls in that
civil day in the named zone, reads each MR's diffs, and produces a grounded
documentation patch or an evidence-backed no-change result. Planner, writer,
and verifier receive those diffs as bound source reads. A 23-hour or
25-hour daylight saving day still counts as that calendar date.
`--patch-only` does not apply the patch to your checkout or open a merge
request. If GitLab evidence is unavailable, the run reports the limitation
instead of claiming complete coverage.

</Accordion>

<Accordion title="Bind Tracked Source Files to an Update" id="bind-tracked-source-files-to-an-update">

When the update must follow a tracked release note, specification, or exported
document, bind that file with the repeatable `--source` flag.
`create-documentation` and `update-documentation` accept it.
DocsFab accepts these tracked source extensions: `.diff`, `.docx`, `.htm`, `.html`, `.ipynb`, `.js`, `.json`, `.markdown`, `.md`, `.mdx`, `.patch`, `.pdf`, `.toml`, `.ts`, `.txt`, `.xhtml`, `.yaml`, and `.yml`.

```bash
docsfab run update-documentation \
  --patch-only \
  --instruction "Update docs/retention.md for the new export limits." \
  --source docs/release-notes.html
```

Repeat the flag to bind more than one file. Each value is a repository-relative
path, and the host reads the exact bytes at the selected revision through the
tracked export, never your working tree. The host stops the run before any
workflow model call when a selected path is not tracked at that revision, when
no installed extractor claims its media type, or when it exceeds the admitted
ceiling. Each stop names the failing condition and the change that clears it,
and it binds nothing. Refer to
[Bind Tracked Source Evidence](../reference/status-and-configuration/source-evidence.md#source-binding)
for the complete binding contract.

The planning, writing, verification, and review steps of an update receive the
same host-issued reader for the bound spans, and every file you select is
required evidence. Before it writes, the write step reads the part of each
selected source that no earlier step read. A source that does not fit its
source-read budget, 262,144 bytes by default and less for a model with a small
input window, is read in part, and the run's LIMITATIONS section names it with
the bytes read out of its total.

One run carries one source binding, so `--source` does not combine with
`--resume-from`, and on `update-documentation` it does not combine with the
date-scoped instruction shown above, which mints its binding from the merge
requests it discovers. Add `--dry-run` to parse the selection and stop before
the host opens any source body:

```bash
docsfab run update-documentation \
  --instruction "Update docs/retention.md for the new export limits." \
  --source docs/release-notes.html \
  --dry-run
```

</Accordion>

<Accordion title="Ground an Update on a Merge Request" id="ground-an-update-on-a-merge-request">

Name the GitLab merge request you are documenting with `--pr`, and the run is
grounded on it. `--mr` is an exact alias, so GitLab users can write the word
GitLab uses; pass either spelling, once. `create-documentation` and
`update-documentation` accept it.

```bash
docsfab run update-documentation \
  --patch-only \
  --instruction "Update docs/export.md for the new output path." \
  --pr https://gitlab.example.com/team/project/-/merge_requests/813
```

Choose one of these merge request reference forms:

| Form | Example | Use it when |
| --- | --- | --- |
| Merge request URL | `https://gitlab.example.com/team/project/-/merge_requests/813` | You copied the link from the browser. |
| Host, group, project, and number | `gitlab.example.com/team/project!813` | You are writing the reference by hand. |
| Number only | `!813` or `813` | The merge request is in this checkout's project. |

Before any model call, the host reads the merge request through your existing `glab` login to pin its commits.
It reads the diff from this checkout's objects or, when required objects are missing, from GitLab's diff evidence.
DocsFab never fetches Git objects.
What else binds depends on the merge request's state:

| State | What the run binds |
| --- | --- |
| Merged | The diff and the merge request's text. |
| Open, draft included | The diff alone, labelled `merge-request-unmerged`. The text is not bound, because an open merge request's text can still change; the run's status output says so. |
| Closed without merging | Nothing. The run stops with `change-source-mr-closed-unmerged`. |

The host resolves the project path to its numeric project identifier, records
both identities, and keys the evidence on the numeric one, so two projects that
share a path cannot be confused for each other.

When local diff objects are missing, the run needs readable GitLab diff evidence or required objects that you fetch into the checkout.
If both evidence paths are unavailable, it stops before any model call with `change-source-mr-objects-unavailable`.
GitLab fallback is recorded as `forge-reported` and names missing local objects and gaps in the retained diff.
It does not bypass other object damage or incomplete GitLab responses.
Refer to [GitLab Diff Fallback and Refusals](../workflows/bind-gitlab-change.md#bind-a-gitlab-merge-requests-diff) for recovery commands and partial-clone requirements.

A host you name is used exactly as typed, including one that is not this checkout's remote.
The read uses your own `glab` login for that host. Confirm the destination and your read access before selecting it.
The read goes to that host; nothing is rehosted.
The binding records the host, canonical project path, numeric project identifier, and merge request number.
The evidence identifies the forge it came from.

`--change` accepts the same merge request forms, except the bare number, and
binds exactly what `--pr` binds. The two do not combine. Refer to
[Bind a GitLab Merge Request's Diff](../workflows/bind-gitlab-change.md#bind-a-gitlab-merge-requests-diff)
for the diff each merge mode binds and every refusal.

`--pr` names one change, and `--source` names tracked files, so a run can carry
both and the host binds both as required evidence:

```bash
docsfab run update-documentation \
  --instruction "Update docs/export.md for the new output path." \
  --patch-only \
  --pr !813 \
  --source docs/release-notes.html
```

The bound evidence records what it could not retain. When the merge request
body is longer than the retained limit, the run records a truncation gap; when
the body is absent, it records a missing-text gap. Neither stops the run, and
both appear in the evidence the writer and verifier read, so a later claim
cannot rest on text the run never held.

`--pr` does not combine with `--resume-from`, and on `update-documentation` it
does not combine with the date-scoped instruction shown above: that instruction
already selects its own merge requests, so naming one explicitly as well would
leave two bases for one binding. Add `--dry-run` to parse the reference and stop
before the host reads GitLab at all:

```bash
docsfab run update-documentation \
  --instruction "Update docs/export.md for the new output path." \
  --pr !813 \
  --dry-run
```

</Accordion>

<Accordion title="Consume the Result From an Outer Agent" id="consume-the-result-from-an-outer-agent">

Add `--json` when an outer agent or continuous integration wrapper runs a
workflow. Consume the single JSON object on stdout. Do not scrape the human
footer or skill Markdown.

```bash
docsfab run create-documentation \
  --instruction "Create docs/install-troubleshooting.md, an installation troubleshooting guide for developers." \
  --patch-only \
  --json
```

When a run record exists, the result keeps `schemaVersion: 1` and
`kind: "docsfab-run-result"`, including when an individual projected string is
truncated to 512 characters. Inspect the quality limitations for
`truncated-projection-field`.

Use `product.findings` as workflow outcome codes. For review workflows, and for
authoring workflows with admitted issues, the root `reviewFindings` array holds
path-bearing `ReviewFindingV1` objects. Each
object contains `id`, `severity`, `code`, `summary`, and a safe relative `path`
or `null`. It can also contain `line`, `origin`, `evidence`, and
`recommendation`. Findings projected from admitted review evidence use
`origin: "agent"` and include evidence and a recommendation.

After a create, update, or restructure run, the human **REVIEW FINDINGS**
section shows the same strictly admitted step findings, their projection
availability, provenance, and limitations. These findings remain separate from
the **PRODUCT** disposition. An inconclusive product outcome does not become a
quality decision because review steps identified actionable issues. Authoring
evaluation Markdown is not parsed into findings when validated quality
artifacts are unavailable.

For standalone review workflows, read `reviewFindingsProjection.availability`
before interpreting the array.
`complete` makes an empty array a supported zero-findings result. `partial`
means one or more review sources remain unavailable. `unavailable` means the
required retained artifact is absent, and `invalid` means its integrity,
schema, or run bindings failed. The projection also names its projector,
retained artifact locator when available, and limitation codes. Inspect the
retained report for limitations instead of scraping skill Markdown or rerunning
inference.

</Accordion>

## Check the Result

A completed run prints a `VERDICT` section and the path to its private run
record under `RECORD`. A default write run also reports its delivery result.

If the run stops before execution, check repository and model readiness:

```bash
docsfab doctor
docsfab profile inspect
```

Doctor is a readiness probe. It is not the editorial continuation after a
catalog job has started.

If `docsfab do` prints `Outcome route: needs-input` and lists named `run`
jobs, no workflow started. Restate the sentence. Refer to
[A Run Stops With needs-input](../troubleshooting.md#a-run-stops-with-needs-input).

If a catalog job already started and then stopped with `needs-input`, read
the PRODUCT shopping list and the printed NEXT command. The accepted
operator loop is that shopping list, exit 2, and NEXT. Supply the named
work products. Do not add `--reader-source` to `do`. Keep those evidence
flags on `docsfab run`. Continue that stopped run with
`docsfab do --continue <run-id> --attach <path>` (or, when exactly one
editorial needs-input run is open, a bare reply sentence and/or `--attach`);
`docsfab do --help` documents both flags. Refer to
[A Run Stops With needs-input](../troubleshooting.md#a-run-stops-with-needs-input).

For every runner option and the other workflow names, refer to
[Runtime CLI and Configuration in DocsFab](../reference/status-and-configuration/runtime-cli-and-configuration.md).

## What's Next

Choose the next journey for your documentation outcome:

<Tabs>
  <Tab title="Create Documentation">
Use `create-documentation` for a new page or documentation set.
For the workflow's checks and evidence limitations, refer to [Create Documentation Workflow in DocsFab](../reference/workflow-contracts/create-documentation.md).
  </Tab>
  <Tab title="Update Documentation">
Use this path when an approved change should update existing pages.
Start with [Update Documentation Beside a Change in DocsFab](../workflows/update-documentation-beside-a-change.md), using `--reader-source` on `docsfab run`.
  </Tab>
  <Tab title="Review Documentation">
For a read-only review of one revision, such as an open merge request or comparison range, start with [Review Merge Request Impact in DocsFab](../workflows/review-merge-request-impact.md).
For an existing documentation set without a selected revision, start with [Baseline Documentation Health in DocsFab](../workflows/baseline-documentation-health.md).
A static review can call the model but does not write to the repository or publish:

```bash
docsfab run review-documentation
```
  </Tab>
</Tabs>

<Warning title="Do Not Add --reader-source to docsfab do">
Keep `--reader-source` on `docsfab run update-documentation`.
`docsfab do` does not accept that flag.
</Warning>

Automatic GitLab CI proposals are the third v0.0.1 entry point; integration is pending.
Refer to [Propose Documentation After CI in DocsFab](../workflows/automatic-ci-proposals.md) for the intended story and the local update and review equivalent.

Continue with the journey that matches your outcome.

<CardGroup cols={2}>
  <Card
    title="Update Documentation Beside a Change in DocsFab"
    href="/workflows/update-documentation-beside-a-change"
  >
    [Update Documentation Beside a Change in DocsFab](../workflows/update-documentation-beside-a-change.md)
  </Card>
  <Card
    title="Review Merge Request Impact in DocsFab"
    href="/workflows/review-merge-request-impact"
  >
    [Review Merge Request Impact in DocsFab](../workflows/review-merge-request-impact.md)
  </Card>
  <Card
    title="Baseline Documentation Health in DocsFab"
    href="/workflows/baseline-documentation-health"
  >
    [Baseline Documentation Health in DocsFab](../workflows/baseline-documentation-health.md)
  </Card>
  <Card
    title="Answer and Resume a Stopped Job in DocsFab"
    href="/workflows/answer-and-resume"
  >
    [Answer and Resume a Stopped Job in DocsFab](../workflows/answer-and-resume.md)
  </Card>
  <Card
    title="Propose Documentation After CI in DocsFab"
    href="/workflows/automatic-ci-proposals"
  >
    [Propose Documentation After CI in DocsFab](../workflows/automatic-ci-proposals.md)
  </Card>
  <Card title="About DocsFab Workflows" href="/workflows">
    [About DocsFab Workflows](../workflows/index.md)
  </Card>
</CardGroup>

Use the [Live Agent Quickstart](live-agent-quickstart.md) when you need a
persistent conversation instead of a named one-shot job.
