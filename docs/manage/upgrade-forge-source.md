---
title: Upgrade the DocsFab Forge Source Schema
description: Preview and apply the supported schema upgrade for an existing core installation.
status: draft
content.type: how-to
---

Upgrade an existing core installation to the forge-source schema using a reviewed release.

## Prerequisites

Use root authority, stop the host, and select the root-sealed reviewed release that matches the deployment revision. The command accepts no arbitrary SQL path.

## Steps

Source schema installation requires root authority. Fresh bootstrap installs
it after service persistence and the forge event ledger. Existing core
installations use `install-service.sh upgrade-forge-source --source-release
ROOT_SEALED_REVIEWED_RELEASE --authority-id ID`, followed by the same command
with `--execute` after reviewing its plan. The host must be stopped, and the
release must match the selected deployment revision. The operation preserves
the prior core receipt and records a separate immutable schema-upgrade receipt.
It accepts no arbitrary SQL path. Runtime still verifies the canonical catalog
fingerprint before accessing a poll credential.


## Related

Refer to [Merge-Request Change-Event Intake](../reference/knowledge-and-delivery/delivery/gitlab-host-notification.md#merge-request-change-event-intake) for the source-mode, identity, and credential contracts.
