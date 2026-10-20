---
title: "Understand Recovery Bounds in DocsFab"
description: "Distinguish deployment recovery bounds from supported local CLI limit inspection and state backup."
status: draft
content.type: how-to
---

For the local CLI, recovery means preserving private configuration and saved-run
stores. A deployment recovery bundle has a separate size and verification
contract. Installing the public CLI does not install deployment backup,
restore, or storage-adapter commands.

## Prerequisites

Identify the configuration and state roots used by your local runs. Stop
processes that can write those roots before you copy or replace files. Keep
backups in persistent, owner-private storage outside a repository.

## Steps

Inspect the effective local configuration and limits with these commands:

```sh
docsfab config inspect --json
docsfab doctor --limits
docsfab doctor --limits --json
```

Use the configuration report to locate the run-records directory. Back up the
complete configuration root and the parent of that directory, including related
artifact and receipt stores. Include any separately configured delivery or
receipt root. Follow [Back Up and Restore Local DocsFab State](recover-local-state.md)
for the copy, comparison, and restored-state readback procedure.

## Configure the Logical-Object Bound

Deployment logical-object verification and backup-gate selection belong to the
separately operated deployment. The public CLI does not select a deployment
recovery mirror, seal a deployment bundle, or verify a PostgreSQL backup.
Changing a CLI limit does not establish a deployment backup bound or prove that
a bundle can be restored.

For a supported local runtime limit, use the setting documented in
[Operational Limit Definitions](../reference/status-and-configuration/operational-limits.md)
and the procedure in [Configure Host Limits](configure-host-limits.md).
`DOCSFAB_SERVICE_ENV_FILE` selects the CLI's host limits file. An environment
override takes precedence over that file. Inspect the effective value and
source before retrying work that exceeded a limit; do not invent an override
for a separately operated recovery tool.

A deployment operator must use that deployment's own verified backup and
restore procedure. Keep its physical backup inactive until its authorized
restore procedure validates the destination and the backup. A successful local
configuration report does not supply that evidence.

## Watch Headroom Before the Bound Refuses

`docsfab doctor --limits` reports configured values and observations from the
selected local saved-run store. The JSON record includes `observedMaxSeen`,
`headroomPercent`, and `status` for each row. Missing measurements remain
`null` in JSON and `n/a` in the human table. They are not a measured zero.

An `over` report exits with `1`, a `warn` report exits with `3`, and the other
report states exit with `0`. A qualified composition fit that exceeds its
effective bounds can also make the report `over`. Unknown measurements remain
visible. A report with no observed overflow does not prove deployment backup
headroom, restore memory capacity, or a successful live recovery drill.

Use [Inspect Operational Limits](inspect-operational-limits.md) to interpret
observations and refusals. Preserve the complete backup before changing owned
state or repairing an unsafe store, and compare restored paths, file types,
bytes, and permissions before starting another workflow.
