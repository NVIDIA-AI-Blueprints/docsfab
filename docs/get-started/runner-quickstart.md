---
title: DocsFab Workflow Quickstart
description: Run a documentation workflow, inspect its result, and find the saved local patch.
status: draft
content.type: tutorial
---

Use DocsFab to run a named documentation workflow from your terminal with
`docsfab run`. This quickstart creates a page and saves a local patch without
applying it to your checkout or opening a merge request. For more information,
refer to [Overview of DocsFab](../about/index.md).

## Prerequisites

Prepare the following items:

- [Install DocsFab](installation.md).
- [Configure the Model](../configure/model.md) with your chosen provider and credentials.
- Select a local Git repository with the product evidence needed for your page.

Local patch delivery needs no GitLab remote, `glab` login, or push permission.
It also needs no tracked `.docsfab.json`. Without that file, DocsFab uses the
`docs/` and `fern/` documentation roots; an existing tracked configuration
must be valid.

Required checks can have additional prerequisites. For native non-Docker
isolated checks, refer to [Installation Prerequisites](installation.md#prerequisites).
For container or continuous integration (CI) checkout permissions, refer to
[Repository Access](../troubleshooting.md#repository-access).

## Quickstart Steps

Choose your repository, request one page, and inspect the result before using it.

### Before You Start

Run these commands from the repository you want to document:

```bash
cd /absolute/path/to/input-repository
docsfab doctor
```

Follow any readiness instructions before continuing. The offline check does
not prove that a model request will succeed. To target a different repository,
add `--repo /absolute/path/to/repository` to your workflow command.

If you want to explore first, `docsfab list` lists workflows and
`docsfab plan create-documentation` shows the steps without executing them.
Refer to [Discover DocsFab Workflows](discover-workflows.md).

### Run Create Documentation

Describe the page, its audience, and its scope. Adapt this example to a new
page your repository needs:

```bash
docsfab run create-documentation \
  --instruction "Create docs/install-troubleshooting.md, an installation troubleshooting guide for developers. Keep the result local; do not publish." \
  --patch-only
```

DocsFab reads the selected repository revision and runs the workflow in a
disposable workspace. With `--patch-only`, any generated patch is saved for
inspection, not applied to your source checkout. Missing evidence or required
checks can prevent delivery.

<Warning title="Select Local Delivery Explicitly">
Keep `--patch-only` when you do not want to publish. Ordinary create, update,
and restructure runs default to draft merge request delivery. Writing
"do not publish" in the instruction does not select local delivery; without
`--patch-only`, that conflict stops the run.
</Warning>

For a one-shot request that lets DocsFab choose the workflow, use
`docsfab do "<your documentation request>" --patch-only` instead. Use
`docsfab run` when you already know the workflow name.

## Check the Result

When a run record is available, inspect the following output sections:

- **VERDICT:** distinguishes execution status from product disposition and delivery outcome.
- **PATCH:** identifies the proposed changes when present.
- **RECORD:** gives the saved run-record path and a `Patch:` artifact path when a patch is retained.

Read the findings and limitations, then inspect the saved patch. Successful
execution alone does not mean the documentation passed every check, is ready
to publish, or even produced a patch. Your checkout remains unchanged by
`--patch-only`.

To inspect a saved run again, substitute its run ID in this command:

```bash
docsfab runs show <run-id>
```

For output fields and machine-readable results, refer to
[Human Output and JSON in DocsFab](../reference/status-and-configuration/human-output-and-json.md).

### If the Run Stops

If the run stops before execution, follow the error's next action. Use
`docsfab doctor` for readiness and `docsfab profile inspect` for model settings.

If a started job reports `needs-input`, read **PRODUCT** and **NEXT** and
supply the requested file or answer. Doctor is not a continuation command.
Refer to [A Run Stops With needs-input](../troubleshooting.md#a-run-stops-with-needs-input)
for supported continuation and fresh-run recovery paths. For an attributed
knowledge-snapshot stop, follow [Answer and Resume](../workflows/answer-and-resume.md).

## Keep the Result Local

A patch is a saved proposal, not an applied change. Inspect it before applying
or publishing it. For delivery prerequisites and recovery, refer to
[Deliver or Recover a Draft Merge Request](../workflows/deliver-draft-mr.md).

<a id="choose-draft-merge-request-delivery"></a>

To choose draft merge request delivery on a new run, remove `--patch-only`
and any publication prohibition only after you have authenticated GitLab access,
a selected remote, and permission to push a branch and open an MR. This does
not grant permission to merge.

## What's Next

Continue with a documentation task, select evidence for it, or connect the
result to your workflow.

### Choose Your Next Task

Choose from the following guides:

- [Create Documentation](../reference/workflow-contracts/create-documentation.md): understand the workflow's evidence and checks.
- [Update Documentation Beside a Change](../workflows/update-documentation-beside-a-change.md): revise existing pages for a product change.
- [Review Merge Request Impact](../workflows/review-merge-request-impact.md): review documentation without editing it.
- [Baseline Documentation Health](../workflows/baseline-documentation-health.md): assess an existing documentation set.
- [Live Agent Quickstart](live-agent-quickstart.md): work through a persistent conversation instead of a one-shot job.

<a id="optional-details"></a>

### Select Evidence for a Job

Use the following guides when a job needs specific source material:

- <a id="bind-tracked-source-files-to-an-update"></a>[Select Source Evidence](../workflows/select-sources.md): bind tracked files with `--source`. The [Tracked Source Evidence Reference](../reference/status-and-configuration/source-evidence.md#source-binding) covers formats, read limits, and incomplete evidence.
- <a id="ground-an-update-on-a-merge-request"></a><a id="update-documentation-from-merged-merge-requests"></a>[Bind a GitLab Change](../workflows/bind-gitlab-change.md): select one merge request or merged changes over a date window, with authentication requirements and refusal guidance.

DocsFab accepts these tracked source extensions: `.diff`, `.docx`, `.htm`,
`.html`, `.ipynb`, `.js`, `.json`, `.markdown`, `.md`, `.mdx`, `.patch`,
`.pdf`, `.toml`, `.ts`, `.txt`, `.xhtml`, `.yaml`, and `.yml`.

For GitLab create and update jobs, `--mr` is an exact alias for `--pr`.
A forge host you name is used exactly as typed; nothing is rehosted.

Keep `--reader-source` on `docsfab run update-documentation`; `docsfab do`
does not accept it.

### Explore Automation and Other Options

Refer to the following guides for integrations and advanced usage:

- <a id="consume-the-result-from-an-outer-agent"></a>[Human Output and JSON in DocsFab](../reference/status-and-configuration/human-output-and-json.md): consume `--json` results, findings, and projection availability.
- [Propose Documentation After CI](../workflows/automatic-ci-proposals.md): understand the CI integration and its current status.
- <a id="run-a-delegated-task"></a>[Delegate a Local Task](../workflows/delegate-a-task.md#delegated-do-pilot): explore the separate opt-in pilot and its restrictions.
- [Runtime CLI and Configuration](../reference/status-and-configuration/runtime-cli-and-configuration.md): look up the full command reference.
