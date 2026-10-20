---
title: Configure GitLab Event Intake in DocsFab
description: Choose an explicit polling or webhook source mode for an activated hosted project.
status: draft
content.type: how-to
---

Choose how a hosted DocsFab project receives GitLab change events. A configured source does not independently establish project activation or publication authority.

## Prerequisites

Use an authorized host configuration change, an activated project, and its deployment and epoch identities. Refer to [Merge-Request Change-Event Intake](../reference/knowledge-and-delivery/delivery/gitlab-host-notification.md#merge-request-change-event-intake) for the required fields and credential custody.

## Steps

Complete the following steps for the selected task.

1. Select exactly one `forge.sourceMode`: `poll` or `webhook`. Bind the protected `forgeSourcePolicy` to the same project, provider, deployment, and epoch. Mixed or missing modes refuse; neither falls back to the other.
2. For polling, use the protected read-only credential handle and a mapped observer allowed to run `review-documentation`. Do not add webhook secret or verification fields.
3. For webhook intake, select exactly one protected verification mode: `gitlab-17-token` for NVIDIA GitLab 17.x, or `standard-webhooks-hmac` for the GitLab 19+ envelope. Do not add polling fields.
4. For inbound mention-submit, configure the GitLab project's Notes hook with the Comments trigger and signing token. This hook is separate from a GitLab CI component.
5. Inspect per-project health for the selected mode, last completed run, next attempt, and failure class. Keep credential values and production identity maps outside the repository.

## Related

For an existing core schema, follow [Upgrade the Forge Source Schema](../manage/upgrade-forge-source.md). For the separate mention-submit identity map and authorization checks, refer to [Inbound Mention Submit](../reference/knowledge-and-delivery/delivery/gitlab-host-notification.md#phase-b-inbound-mention-submit).
