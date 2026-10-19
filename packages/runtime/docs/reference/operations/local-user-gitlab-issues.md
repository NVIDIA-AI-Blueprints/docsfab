# Local-user GitLab issue operations

DocsFab keeps roadmap reasoning separate from tracker mutation. A roadmap workflow produces a
version 2 mutation plan containing digests and byte counts, while the unrestricted title,
description, comment, and label material stays in a private host-side material bundle. Neither
credentials nor raw GitLab API responses are placed in the plan, receipt, or model context.
Every JSON input must be a regular, single-link file owned by the current user with mode `0600`
(or stricter). DocsFab opens inputs without following symlinks, rejects FIFOs and files over 2 MiB,
and verifies the opened inode did not change while it was read. Every lexical parent is canonical,
non-writable by other users, and owned by either the current user or the system administrator;
symlinked parent components are rejected. DocsFab pins the parent device, inode, and directory
change time around input reads and receipt publication, including the final rename and directory
sync, and fails closed if the chain is substituted.
Receipt publication keeps the private temporary file open across the atomic rename, then reopens
the final path without following links and requires the same inode, owner, mode, link count, size,
timestamps, canonical bytes, and content digest before and after syncing the parent directory. If
the parent authority is lost, DocsFab never attempts cleanup through the untrusted lexical path;
an owner-only UUID-named temporary may remain in the original trusted directory for manual cleanup.

## Preflight

Run the read-only command before asking an operator to approve the plan:

```console
docsfab roadmap-issues preflight \
  --ledger /private/roadmap-ledger.json \
  --plan /private/mutation-plan-v2.json \
  --material /private/mutation-material.json \
  --json
```

The fixed-command adapter uses the current operator's existing `glab` login. It checks the exact
host, numeric project ID, project path, username, access level, labels, milestones, and tracker
identities. The output contains only normalized identities and material digests.
The local-user authorization must set `authority.id` to `local-user:<identityDigest>` from this
preflight, binding application and every resumed operation to the same operator identity.

## Application

Application requires a separate, unexpired version 2 authorization and explicit confirmation of
both digests:

```console
docsfab roadmap-issues apply \
  --ledger /private/roadmap-ledger.json \
  --plan /private/mutation-plan-v2.json \
  --material /private/mutation-material.json \
  --authorization /private/mutation-authorization-v2.json \
  --confirm-plan-sha256 PLAN_DIGEST \
  --confirm-authorization-sha256 AUTHORIZATION_DIGEST \
  --receipt /private/receipts/roadmap-application.json \
  --json
```

Each mutation is limited to the exact operation key and material digest authorized by the grant.
The host re-reads the affected issue immediately before writing and stops on material drift. It
reconciles the operation marker before creating an issue, milestone, note, or task-list entry, and
records a sanitized receipt after every attempt. Re-running with the same receipt resumes at the
next safe operation without duplicating a confirmed effect. An ambiguous response must be
reconciled before retrying.

Mutation values use `glab api --raw-field`, so bodies beginning with `@`, boolean-looking strings,
numbers, and placeholders remain literal text rather than files or typed values. Immediately before
each POST or PUT, DocsFab repeats the exact operator, project access, material, and expiry checks.
A private process-safe project/plan lock covers receipt loading, reconciliation, mutation, and
durable receipt publication. Dead-owner and incomplete claims are quarantined before recovery;
active claims fail closed. Before any POST or PUT, an ambiguous write-ahead v2 receipt is fsynced.
This lets a later invocation reconcile safely if the process exits after GitLab applies a mutation
but before the final receipt is stored.

Supported operations are issue and saga creation, milestone creation, title or description update,
label add/remove, milestone assignment, related/blocking links, parent task-list entries, comments,
close, and reopen. Deletion, bulk mutation, confidential-state changes, membership changes, project
settings, arbitrary API calls, and arbitrary `glab` commands are intentionally unsupported.

The live integration harness is disabled unless `DOCSFAB_RUN_GITLAB_ISSUE_LIVE=1` and dedicated
disposable-project inputs are supplied. Normal tests never contact GitLab or perform mutations.
