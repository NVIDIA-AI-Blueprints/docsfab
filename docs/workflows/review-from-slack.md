---
title: "Review Documentation From Slack in DocsFab"
description: "Start a focused documentation or merge-request review from the project's connected Slack channel."
status: draft
content.type: how-to
---

Start a focused documentation or merge-request review from the project's connected Slack channel.

## Prerequisites

Use an activated project channel and its registered canon. A documented command does not establish that the hosted route is active.

## Steps

From Slack, name targets with `target=`. The multi-page form is accepted for
`review-documentation` only; the Slack parser, the durable job spine, and the
runtime request parser each refuse it on any other workflow.

```text
/docsfab run review-documentation canonSha256=<registered-canon-sha256> target=docs/a.md,docs/b.md
```

This command uses the project's configured default source revision. To review
a different immutable commit available in that project's source repository,
include `reviewRevision=` with the full commit ID:

```text
/docsfab run review-documentation canonSha256=<registered-canon-sha256> reviewRevision=<full-commit-id> target=docs/a.md,docs/b.md
```

The revision requires both the registered canon and named targets. Branch names
are not accepted. The review and its saved continuation retain that exact commit
when a branch moves. The configured default remains unchanged. Merge-request
reviews still require their bound head to remain current, and write workflows
do not accept this read-only revision selection.

The `canonSha256=` value is optional. A `run` command that names no digest
uses the project's current installed canon, and a typed value overrides it.

To review one merge request of the channel's project, name it by number or by
its full URL:

```text
/docsfab run review-documentation !1234
/docsfab run review-documentation mergeRequestUrl=https://<gitlab-host>/<group>/<project>/-/merge_requests/1234
```

DocsFab reads the open merge request, pins its current head, and runs the same
review that a merge-request update starts, with the same merge-request scope.
The result appears in the Slack thread. A project that posts merge-request
review notes also posts it on the merge request. The link must name the project's registered GitLab host and project, unless
`DOCSFAB_SLACK_GITLAB_ORIGIN` sets another origin. A link to another project,
or a merge request that is not open, gets a reply that names the project and
starts no job.

When a Slack-started job fails, the thread reply names the failing step, its
position in the workflow, the failure code, and what the code's failure class
means. DocsFab reads these values from the retained run record when it posts
the reply. A run that an older DocsFab release stopped with
`host-path-disclosure` also names the form the reply used, such as a `file:`
reference or a backslash. No current step raises that code.
