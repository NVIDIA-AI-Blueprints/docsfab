---
title: "Deliver a Live-Agent Patch in DocsFab"
description: "Inspect a saved workflow patch and choose checkout application or draft merge-request delivery."
status: draft
content.type: how-to
---

Inspect a saved workflow patch and choose checkout application or draft merge-request delivery.

## Workflow Patches and Checkout

A bounded workflow operates on a snapshot of committed `HEAD`, not
on uncommitted checkout edits. After a write workflow succeeds, the
host verifies its saved patch and applies it to the selected
checkout. Changes remain uncommitted. If applying the patch would
conflict with local edits, DocsFab reports a failure and retains both
your files and the saved patch. It does not force an application,
reset files, or stash your work.

Do not describe documentation as updated in the checkout unless patch
application was verified. A failed workflow does not apply its
partial patch.

## Create a Draft Merge Request

After documentation edits exist in the checkout, ask the agent to
commit the intended files, push a topic branch, and open a draft
merge request. No workflow run ID is required. The agent inspects
staged, unstaged, and untracked changes, then proposes Git and `glab`
commands for approval. GitHub repositories can use `gh` for a draft
pull request. That path is an approved host command, so the activity
label is `Running approved host command`, not
`Creating draft merge request`.

Write-enabled mode and permission to create a merge request do not
authorize merging it.

## Publish an Exact Saved Workflow Patch

You can instead ask to publish one successful workflow run. That
optional path uses GitLab delivery and a separate worktree. It
publishes the exact saved patch. It does not include later manual
edits. The source checkout stays unchanged. This path does not use
GitHub `gh`.

The activity label is `Creating draft merge request`. If
authentication or another publication prerequisite fails, the
terminal prints the safe reason and local changes remain available.

You can also publish the saved run from the CLI, without rerunning
authoring:

```bash
docsfab ship <run-id> --repo /absolute/path/to/repository
```

`docsfab publish` remains the CLI surface for a succeeded write run.
Both commands are documented in
[Runtime CLI and Configuration in DocsFab](../reference/status-and-configuration/runtime-cli-and-configuration.md).
