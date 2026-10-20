# Publish a patch

<!-- Diataxis: how-to hub. -->

## Goal

Deliver a validated, authorised DocsFab patch to GitLab as one attributable
draft merge request, while preserving the patch-only fallback.

## When to use this

Use this only after a workflow has produced a reviewable patch and the
requester has explicitly authorised delivery. Publishing is not implied by
generating a patch.

## Tasks

1. Read [local GitLab publishing](../reference/operations/local-user-gitlab-publishing.md) for the
   local-user authority and exact delivery sequence.
2. Confirm the patch and validation evidence against
   [delivery acceptance](delivery-acceptance.md).
3. Use [SCM delivery records](../reference/contracts/scm-delivery-records.md) to inspect the
   durable attribution and idempotency evidence.

## Related topics

- [External input manifest](../reference/contracts/external-input-manifest.md)
- [Task decision lineage](../reference/contracts/task-decision-lineage.md)
- [Workflow outcomes](../reference/contracts/workflow-outcomes.md)
