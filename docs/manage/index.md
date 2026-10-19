---
title: About Managing DocsFab
description: Find guides for checking readiness, managing local configuration, changing versions, and using development builds.
status: draft
content.type: explanation
---

Manage a DocsFab installation, its private state, and the evidence retained by its jobs. Start with [Check Readiness](check-readiness.md) when deciding whether a local review, patch, or draft merge request can run.

## Installation and Local State

Choose a guide for the installation or state you need to manage:

| Task | Guide |
| --- | --- |
| Change versions, repair an installed package, or remove the CLI. | [Update or Uninstall](update-or-uninstall.md) |
| Try a package from the development channel. | [Install a Development Build](development-installation.md) |
| Preserve and restore the complete private configuration and run stores. | [Back Up and Restore Local State](recover-local-state.md) |
| Resume, list, or delete live-agent transcripts. | [Manage Live Sessions](live-sessions.md) |

## Configuration and Readiness

Use these guides before model execution or delivery:

| Task | Guide |
| --- | --- |
| Check local or live prerequisites for the selected operation. | [Check Readiness](check-readiness.md) |
| Locate host files, replace a key, or check directory permissions. | [Manage Local Configuration](local-configuration.md) |
| Inspect effective limits, observations, and headroom. | [Inspect Operational Limits](inspect-operational-limits.md) |
| Set supported host limit overrides. | [Configure Host Limits](configure-host-limits.md) |
| Inspect an explicitly configured Codex or Claude Code CLI. | [Check Native CLI Readiness](check-native-harness.md) |

## Runs, Reports, and Model Evidence

Follow the saved evidence for the question you need to answer:

- [Diagnose a Failed Run](diagnose-run.md), or [investigate patterns across saved runs](../workflows/investigate-saved-runs.md).
- [Compare Completed Composition Runs](compare-runs.md).
- [Host a Review Report](host-review-report.md).
- [Check Answer Submission Capability](qualify-answer-submission.md), or [check answer-record capability](qualify-answer-records.md) with the explicit live probe.

## Deployment and Documentation Site

Deployment recovery uses a clean destination and fresh authority. Follow [Restore a Deployment](restore-deployment.md) and [Configure the Recovery Object Bound](configure-recovery-bound.md). The pilot's live recovery drill remains incomplete.

For this repository's Fern site, follow [Preview the Documentation Site](preview-documentation-site.md). A preview does not establish publication or release approval.
