---
title: "Back Up and Restore Local DocsFab State"
description: "Preserve the complete private configuration and saved-run stores before upgrading, repairing, or restoring a local installation."
status: draft
content.type: how-to
---

Preserve the complete private configuration and saved-run stores before upgrading, repairing, or restoring a local installation.

## Prerequisites

Identify the configuration, state, delivery, and receipt roots. Use persistent owner-private backup storage outside any repository.

## Steps

Use the command and checks below.

## Recover a Local CLI Installation

For the local CLI, stop all DocsFab processes that can write configuration or
run state before you copy or replace files. Run `docsfab config inspect --json`
to identify the effective configuration root and run-records directory. Check
`DOCSFAB_STATE_DIR`, `DOCSFAB_DELIVERY_ROOT`, and `DOCSFAB_RECEIPT_ROOT` in the
same shell. Include the complete configuration root and the parent of the
run-records directory in an owner-private backup. That parent can also contain
populated `patches`, `artifacts`, `run-index`, `knowledge`, `context-cache`,
`quality-validation`, `knowledge-continuations`, `delivery`, and `receipts` stores. Copy the actual
stores, including content-addressed objects bound to saved runs. If a delivery
or receipt override resolves outside that parent, include its complete root
separately. Preserve file names, bytes, and permissions, including
`secrets.env`; do not copy a
backup into a repository or a temporary directory subject to cleanup.

For example, `DOCSFAB_STATE_DIR=<parent>/s` can create `s`, `patches`,
`artifacts`, `run-index`, and `knowledge/first-pass/<revision>` inside
`<parent>`. Optional workflow stores can add other siblings listed above.
DocsFab creates its private state directories with `0700` permissions and files
with `0600` permissions, regardless of your shell umask. A pre-existing
`<parent>` keeps its permissions. If an existing knowledge or patch path has
unsafe permissions, ownership, or links, DocsFab refuses that path while
retaining its bytes. Stop writers and back up the complete parent before you
repair or move state you own, or select a fresh private root. Compare file
bytes and permissions with the backup before you retry.

Before an upgrade, record the exact package tarball identity, the installed
executable path, `docsfab profile inspect --json`, and the IDs of saved runs.
Install the next exact package build, then read the same profile and runs with
`docsfab runs show <run-id> --state-dir <runs-directory> --json`. Compare the
critical files with your backup before you run another setup or workflow. To
roll back, reinstall the previous exact tarball and repeat the readback. The
[update and uninstall guide](update-or-uninstall.md)
shows the package commands.

To restore, stop writers again, restore the complete roots into cleared,
isolated destinations, and compare every path, file type, byte digest, and
permission with the backup. Reject unexpected extra files. Keep backup bytes
unchanged. After the comparison, use `config inspect`, `profile inspect`, and
`runs show` to check that the installed CLI reads the restored state. These
readers can create separate diagnostic state, so compare their effects after
the restore comparison.

After a process stops abruptly, inspect the saved run before deciding what to
do next. In the installed 0.0.1 candidate exercise,
an interrupted `review-documentation` run retained `running` status and a
`running` step. `runs show` read it, but `why` returned `why-run-not-found`.
That run did not resume or settle. A new, separate read-only review completed
with a different run ID while the interrupted record remained unchanged. Do
not describe the new run as a resume. This exercise established no safety for
replaying write-capable workflows or remote publication. Review source and
destination state before attempting either operation after a crash.
