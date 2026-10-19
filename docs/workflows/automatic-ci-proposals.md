---
title: Propose Documentation After CI in DocsFab
description: Distinguish the intended CI documentation proposal from the local pair you can run today.
status: draft
content.type: how_to
---

<Note title="Evidence">
Live pilot-host auto-draft after customer continuous integration (CI) is not
established. A read-only pipeline observer can freeze a complete `C..H`
range after a successful default-branch push pipeline. That observer does
not invoke a model, enqueue documentation work, publish, or grant
source-control authority. Refer to
[DocsFab Implementation Status](../reference/status-and-configuration/implementation-status.md).
</Note>

DocsFab's intended automatic path is a successful default-branch push
pipeline, then a frozen `C..H` range from coverage base through that
pipeline head. The next jobs are a bounded `update-documentation` run and
an independent `review-documentation` run. Delivery is at most one
immutable draft merge request through a separately authorized publisher.
For more information, refer to
[About DocsFab Workflows](index.md).

Today you run that update and review pair locally. Mailbox notes on an
existing merge request are a different path. Refer to
[GitLab Host Mailbox in DocsFab](../reference/knowledge-and-delivery/delivery/gitlab-host-notification.md).

## Before You Start

Complete the steps in [Install DocsFab](../get-started/installation.md). Prepare the
repository revision that the successful pipeline built.

Confirm the following conditions:

- You can run `docsfab doctor` and `docsfab list` against that checkout.
- You can describe the user-facing change in an `update-documentation`
  instruction.
- You accept a local patch first. Independent review of an unapplied patch
  tree is part of the intended automatic path. It is not a local CLI command
  on this page.

Read [Update Documentation Beside a Change in DocsFab](update-documentation-beside-a-change.md)
and [Review Merge Request Impact in DocsFab](review-merge-request-impact.md) before you
run the pair.

## Steps

<Steps>
  <Step title="Freeze the inputs">
    Freeze the inputs for this documentation job. Use the revision the
    successful pipeline built. When you bind reader files, pass
    `--reader-source` on `docsfab run update-documentation`.

    Expected result: You can name the repository path, the revision, and the
    documentation pages the change can affect. You do not wait for a pipeline
    observer to enqueue a job.
  </Step>
  <Step title="Run a bounded update">
    Run a bounded update and keep the result local.

    ```bash
    cd /absolute/path/to/input-repository

    docsfab run update-documentation \
      --patch-only \
      --instruction "Update only the user-facing pages affected by this approved change. Preserve unrelated content. Report evidence gaps instead of claiming complete coverage."
    ```

    Add `--reader-source <role>=<repository-relative-path>` when you must bind
    current documentation, changed source, or public-contract files. Refer to
    [Update Documentation Beside a Change in DocsFab](update-documentation-beside-a-change.md)
    for the supported roles.

    Expected result: The run retains a reviewable patch or reports an
    evidence-backed limitation. `--patch-only` does not apply the patch or
    open a merge request.
  </Step>
  <Step title="Run an independent review">
    Run an independent read-only review against the same repository revision.
    Do not treat the update run as that review.

    ```bash
    docsfab run review-documentation --repo /absolute/path/to/input-repository
    ```

    Pass `--revision <ref>` when the checkout HEAD is not the revision you
    intend to review.

    Expected result: The review writes findings and quality evidence without
    a write grant. Audience `insufficient-evidence` remains visible and does
    not become a success claim. Refer to
    [Baseline Documentation Health in DocsFab](baseline-documentation-health.md).
  </Step>
  <Step title="Inspect both run records">
    Inspect both run records before you consider delivery.

    ```bash
    docsfab runs show <update-run-id>
    docsfab runs show <review-run-id>
    ```

    Expected result: The update record and the review record stay separate.
    A successful update does not imply that independent review passed.
  </Step>
  <Step title="Optional: deliver a draft merge request">
    After you inspect both results, deliver one draft merge request through
    the separately authorized publisher path for the succeeded write.

    ```bash
    docsfab ship <update-run-id> --repo /absolute/path/to/input-repository
    ```

    Expected result: Delivery reuses the retained patch without another model
    call. It cannot merge the result. This local delivery is not live pilot-host
    auto-draft after customer CI.
  </Step>
</Steps>

## Troubleshooting

If the update stops with `needs-input`, read PRODUCT and the printed NEXT
command. Refer to
[A Job Stops With Needs Input After It Starts](../troubleshooting.md#a-run-stops-with-needs-input)
or [Answer and Resume a Stopped Job in DocsFab](answer-and-resume.md) for a knowledge
snapshot stop.

If you expected an automatic draft merge request after a default-branch
pipeline, that path is not established. Run the local pair on this page.
Mailbox notes on an existing merge request remain a different path. Refer to
[GitLab Host Mailbox in DocsFab](../reference/knowledge-and-delivery/delivery/gitlab-host-notification.md).

If doctor reports blocked readiness, follow the printed next command. Refer
to
[Doctor Reports Blocked Readiness](../troubleshooting.md#doctor-reports-blocked-readiness).

## Related

<CardGroup cols={2}>
  <Card
    title="DocsFab Implementation Status"
    href="/reference/status-and-configuration/implementation-status"
  >
    [DocsFab Implementation Status](../reference/status-and-configuration/implementation-status.md)
  </Card>
  <Card
    title="Update Documentation Beside a Change in DocsFab"
    href="/workflows/update-documentation-beside-a-change"
  >
    [Update Documentation Beside a Change in DocsFab](update-documentation-beside-a-change.md)
  </Card>
  <Card
    title="Review Merge Request Impact in DocsFab"
    href="/workflows/review-merge-request-impact"
  >
    [Review Merge Request Impact in DocsFab](review-merge-request-impact.md)
  </Card>
  <Card
    title="Update Documentation Contract"
    href="/reference/workflow-contracts/update-documentation"
  >
    [Update Documentation Contract](../reference/workflow-contracts/update-documentation.md)
  </Card>
  <Card
    title="Review Documentation Contract"
    href="/reference/workflow-contracts/review-documentation"
  >
    [Review Documentation Contract](../reference/workflow-contracts/review-documentation.md)
  </Card>
  <Card
    title="GitLab Host Mailbox in DocsFab"
    href="/reference/knowledge-and-delivery/delivery/gitlab-host-notification"
  >
    [GitLab Host Mailbox in DocsFab](../reference/knowledge-and-delivery/delivery/gitlab-host-notification.md)
  </Card>
  <Card
    title="Delivering Results"
    href="/about/core-concepts/documentation-jobs"
  >
    [Delivering Results](../about/core-concepts/documentation-jobs.md#delivering-results)
  </Card>
</CardGroup>
