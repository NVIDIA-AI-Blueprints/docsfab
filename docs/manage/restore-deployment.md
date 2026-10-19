---
title: "Restore a DocsFab Deployment"
description: "Restore a verified deployment bundle into a clean destination and establish fresh execution authority before accepting work."
status: draft
content.type: how-to
---

Restore a verified deployment bundle into a clean destination and establish fresh execution authority before accepting work.

## Prerequisites

Use the protected recovery backend, separate source and destination database identities, and an authorized new deployment epoch. Refer to [Recovery State Reference](../reference/status-and-configuration/recovery-and-migration.md). The pilot recovery drill remains incomplete.

## Steps

Use the command and checks below.

## Restore Without Reviving Old Authority

Use the following lifecycle for either recovery or migration:

1. Capture sanitized project history through the bounded read-only recovery
   export role. Create a PostgreSQL base backup through the separate
   replication-only login with streamed write-ahead log records.
2. Verify the PostgreSQL backup, encrypt it in private staging, seal the
   logical objects, and create the digest-bound manifest.
3. Store each artifact through the protected backend adapter and verify the
   external copy by reading it back.
4. Retrieve the bundle into private staging on the destination and verify the
   expected manifest digest, every object digest, and the PostgreSQL backup
   before mutation.
5. On the first attempt, restore only into empty physical and logical
   destinations. Do not start the restored source cluster as an active DocsFab
   database.
6. Import each logical project through the bounded recovery import role into a
   separately provisioned clean destination cluster. Select a new, previously
   unused deployment epoch.
7. Re-register projects and swarms, reinstall destination credentials and
   policy, and reconcile the exact authoritative Git revision.
8. Resume interrupted work only through the generated recovery plans. Issue
   new packets, context capsules, attempts, leases, and fences.

Verification-only mode checks the bundle and physical backup without opening a
destination database; its receipt therefore records destination emptiness as
not checked. Only restore or migrate may attest an empty destination.

An exact replay of the same manifest into the same destination epoch is
idempotent. A partial or conflicting import must fail instead of guessing.
Keep the durable recovery-history and import-receipt ledger with the restored
deployment so later retries can distinguish those cases.

A staged restore receipt is intentionally content-free. It identifies the
manifest, destination deployment, new epoch, mode, verification result, and
fresh resume plans. It also records that runtime bindings are not installed,
swarms are not registered, and semantic reconciliation is incomplete.

After the database import and physical and logical projections complete,
DocsFab commits a second content-free completion receipt. Its status remains
`complete-needs-registration-and-reconciliation`, and the protected storage
adapter publishes and reads back that receipt. Do not accept work until the
post-restore registration and reconciliation steps succeed.

## Preserve Project Isolation

Back up and restore project history as separate logical objects. Bind every
object to one project identifier and source epoch, then verify that binding
against the manifest. A destination project cannot read or import another
project's state. Reconstruct any provider-specific physical namespace only
inside the destination coordination adapter after the portable artifact has
passed verification.
