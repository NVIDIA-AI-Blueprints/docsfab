---
title: "DocsFab Recovery State Reference"
description: "Look up local CLI backup contents, restored-state readback, and the boundary between saved state and deployment recovery authority."
status: draft
content.type: reference
---

For the public CLI, preserve the complete private configuration and saved-run
stores before upgrading or restoring an installation. Follow
[Back Up and Restore Local DocsFab State](../../manage/recover-local-state.md)
for the procedure. Deployment database backups and logical recovery bundles
belong to a separately operated host; they are not created or restored by the
public CLI commands described here.

## Understand the Recovery Boundary

Identify the actual roots with `docsfab config inspect --json`. An exported
`DOCSFAB_STATE_DIR` can select a different run-records directory. Delivery and
receipt overrides can also select roots outside its parent.

The following table describes what a local backup must preserve.

| State Class | Recovery Treatment |
| --- | --- |
| Private configuration and credentials | Preserve the complete configuration root, exact bytes, and permissions in owner-private backup storage. Keep it outside a repository and away from public output. |
| Saved runs and related objects | Preserve the complete parent of the run-records directory, including content-addressed artifacts and other workflow stores. Include separately configured delivery and receipt roots. A run-record JSON file alone is not a complete backup. |
| Product Reference Model, source threads, and PRD, SRD, and POR projections | Keep the project's authoritative Git history. A saved-run backup does not replace the project's semantic authority. |
| Interrupted work | Preserve the recorded status and evidence. Reading a saved run does not resume it, settle an interrupted attempt, or turn a new run into a continuation. |
| Write and publication authority | Revalidate the current source, destination, and required authorization before new work. Copying saved files does not create a write or publication grant. |

Stop writers before copying or replacing files. Restore into cleared, isolated
destinations, then compare every path, file type, byte digest, and permission
with the unchanged backup. Reject unexpected files. Do not repair a private
store by silently discarding saved evidence or weakening its permissions.

## Keep the Logical Object Bounded

A saved run can refer to related artifacts rather than embedding all of their
bytes. Preserve the actual object stores with the records that bind them.
Inspect a restored run with the original run ID and selected state directory:

```sh
docsfab runs show <run-id> --state-dir <runs-directory> --json
```

The reader validates the saved record and can read related persisted reports
or artifacts. This is an inspection command, not a backup or restore command.
Use `docsfab doctor --limits` to inspect the supported local limits and available
run observations. Unknown observations remain unknown; they do not establish
that a large recovery object fits in memory.

The public CLI does not provide a deployment logical-bundle verifier or a
physical database restore command. Keep physical backup images inactive and
use the separately operated deployment's authorized verification procedure.
A filename marking an inactive image is not a CLI environment setting or
permission to start that image.

<a id="use-the-official-pilot-backend"></a>

## Separate Deployment Backends

Local CLI backup storage and a deployment recovery backend serve different
purposes. Choose persistent, owner-private storage for local state, and preserve
the exact package identity needed to read it. The public CLI does not provision
a hosted recovery project, upload a deployment backup, or select a database
storage adapter.

A deployment operator must establish its own authenticated backup storage,
verify stored bytes against the expected digests, and keep credentials and
keys outside the backup contents. Local CLI readback does not prove that an
external deployment copy exists or can be restored.

## Separate Database Authority

A local configuration or saved-run backup is not a database dump. Installing
the CLI does not provision database backup, export, or import identities.
A deployment's restore authority and destination isolation require that
deployment's own procedure.

For local state, keep each project's authoritative source and restored stores
paired. A readable record does not grant authority over another project or
revive a prior write approval. Review the current source and destination before
repeating a write-capable workflow after interruption.

## Interpret Current Status

Before upgrading, record the exact package identity, configuration selection,
and saved-run IDs. After installing the chosen exact package, use these
supported readers:

```sh
docsfab config inspect --json
docsfab runs list --state-dir <runs-directory> --json
docsfab runs show <run-id> --state-dir <runs-directory> --json
docsfab doctor --limits --json
```

Compare restored files with the backup before another setup or workflow.
Diagnostic readers can create separate diagnostic state, so compare their
effects after the restore comparison. Preserve an interrupted record as
observed; do not claim that inspection resumed its work.

Configuration and limit reports describe their own checks. They do not prove
model connectivity, successful publication, deployment database recovery, or
a live restore drill. Keep final artifact and operational qualification tied
to the actual package, source, and deployment that were verified.

## Related Topics

The following pages provide related information:

- [Back Up and Restore Local DocsFab State](../../manage/recover-local-state.md)
- [Inspect Operational Limits](../../manage/inspect-operational-limits.md)
- [Runtime CLI and Configuration in DocsFab](runtime-cli-and-configuration.md)

## Moved Topic Links

Earlier section bookmarks lead to the corresponding public guidance below.

<a id="configure-the-logical-object-bound"></a>

Refer to [Understand Recovery Bounds in DocsFab](../../manage/configure-recovery-bound.md#configure-the-logical-object-bound).

<a id="preserve-project-isolation"></a>

Refer to [Understand the Recovery Boundary](#understand-the-recovery-boundary)
and [Separate Database Authority](#separate-database-authority).

<a id="recover-a-local-cli-installation"></a>

Refer to [Back Up and Restore Local DocsFab State](../../manage/recover-local-state.md#recover-a-local-cli-installation).

<a id="restore-without-reviving-old-authority"></a>

Refer to [Understand the Recovery Boundary](#understand-the-recovery-boundary).

<a id="watch-headroom-before-the-bound-refuses"></a>

Refer to [Understand Recovery Bounds in DocsFab](../../manage/configure-recovery-bound.md#watch-headroom-before-the-bound-refuses).
