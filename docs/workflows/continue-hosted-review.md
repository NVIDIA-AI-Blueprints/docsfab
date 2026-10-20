---
title: "Continue a Hosted Documentation Review in DocsFab"
description: "Continue the retained remainder of a partial hosted review at the same immutable revision."
status: draft
content.type: how-to
---

Continue the retained remainder of a partial hosted review at the same immutable revision.

Continuation is an operator action. When any deferred or unlisted page remains,
the dispatcher stores the complete ordered plan in the existing project-bound
CAS and records its locator and digest on the receipt. Slack renders:

```text
/docsfab run review-documentation continuation=cas:<project-binding>:<plan-digest>
```

This command is below the configured 256-character minimum even when no page
path fits a direct command. Admission reloads the plan, checks the same project,
principal, deployment epoch, registered canon and workflow, and rechecks canon
ownership. Dispatch additionally checks the sealed policy and materializes the
stored immutable review revision; it does not resolve a moving branch. The next
batch contains only the retained remainder, with reference-model anchors first,
and writes a new plan for anything still pending. Completed and remaining sets
are both retained, so batches cannot overlap and their union remains the full
original target set. Restart reuses the CAS artifact and the frozen job packet's
locator. The model prints a direct `target=` command only when it receives a
validated canon and revision and the whole command fits; otherwise it labels
the deferred list as non-runnable and points to the host result.

The dispatcher receipt and hosted Slack result carry the durable plan locator
with the radius/listed/unlisted/unreviewable accounting. Slack also retains the
bounded, anchor-first deferred names beside the compact command. A real
registered canon that matches the plan makes that command runnable; missing,
ambiguous, or mismatched registration yields an explicitly non-runnable
selection.

The standalone `comment-existing-mr` CLI has no access to the dispatcher's
project-bound CAS or receipt. Its GitLab note still renders honest counts and a
bounded, revision- and canon-bound direct command for deferred paths it has.
If its input record reports unlisted overflow, the note says the durable
continuation is unavailable and that those paths are not carried by the local
projection. It does not print a hash-only token or claim that the run record can
reconstruct paths it does not contain. The hosted GitLab terminal projector
uses the dispatcher plan locator after it verifies the run, receipt, project,
principal, epoch, revision, and registered canon. The optional ingress policy
references a separate protected note credential and bot identity. Absence keeps
hosted GitLab publication disabled.

Escalation is terminal. An escalated run is never retried at a narrower scope.
