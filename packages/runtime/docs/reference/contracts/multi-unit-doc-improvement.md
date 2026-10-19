# Multi-unit documentation-improvement campaign contracts

This reference stubs the closed envelope for a capped multi-unit campaign.
Decision freeze: Investigation **#257** (option 3). Operator procedure for the
single-gap kind remains [Bounded documentation improvement](../../prove-a-doc-change/bounded-doc-improvement.md);
multi-unit is a **distinct** kind, not an extension of single-gap v1.

Normative plan: [Multi-unit documentation-improvement campaign ledger](../../plan/multi-unit-doc-improvement-campaign.md).

## Campaign declaration

| Field | Closed value / rule |
| --- | --- |
| `kind` | `"multi-unit-doc-improvement-campaign"` |
| `schemaVersion` | `1` |

Single-gap `bounded-doc-improvement-campaign` schemaVersion 1 remains valid in
parallel. Do not treat a single-gap declaration as a multi-unit campaign.

## Caps

| Field | Value |
| --- | --- |
| `maxUnits` | `5` |
| `maxAttemptsPerUnit` | `3` |
| `maxCampaignAttempts` | `15` |

## Stop reasons

`progress.stopReason` is one of:

`complete` | `cap-exhausted` | `plateau` | `authorization-revoked` |
`review-failed` | `operator-stop`

## Private directory leaf layout

Directory mode `0700`; leaves `0600`. Required layout:

```text
declaration.json
unit-queue.json
units/<workUnitFingerprint>/
progress.json
<authorization leaf>
<independent-review leaf>
```

`unit-queue.json` is an ordered list of objects with at least:

- `workUnitFingerprint` — stable unit identity
- `machineContractSha256` — digest binding the unit’s machine Acceptance
  envelope (#255)

`units/<fingerprint>/` holds per-unit receipt and digests (run-record,
evaluate evidence). `progress.json` tracks queue index, attempts, and the
terminal stop reason.

## Authorization and independent review

Same spirit as [bounded-doc-improvement contracts](bounded-doc-improvement.md):
Ed25519 maintainer authorization, distinct independent reviewer, host-trusted
reviewer policy, explicit write gate. Authorization does not mint auto-merge
or tracker write authority.

## Non-overlap with #226 and single-gap v1

This multi-unit campaign envelope does **not** own the #226 candidate
keep/discard / plateau ledger. Plateau as a **campaign** `stopReason` is a
terminal bound for the multi-unit run, not a reuse of #226’s experiment
ledger. Single-gap `bounded-doc-improvement-campaign` v1 stays the preferred
one-unit dogfood path and is not silently upgraded.
