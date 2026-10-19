# Plan: Multi-unit documentation-improvement campaign ledger

- **Status:** Accepted (process / contract freeze)
- **Date:** 2026-08-12
- **Investigation:** #257 (Epic #254, Saga #211)
- **Complements:** [bounded documentation improvement](../prove-a-doc-change/bounded-doc-improvement.md),
  [bounded-doc-improvement contracts](../reference/contracts/bounded-doc-improvement.md),
  [multi-unit contract stub](../reference/contracts/multi-unit-doc-improvement.md),
  [issue lifecycle](issue-lifecycle.md)

## Decision

Add a new campaign kind **`multi-unit-doc-improvement-campaign`** with
`schemaVersion: 1` (option 3 from #257).

Do **not** overload single-gap `bounded-doc-improvement-campaign` v1 with an
ordered unit queue (option 1), and do **not** require a campaign-of-campaigns
outer ledger of N single-gap dirs (option 2).

Single-gap `bounded-doc-improvement-campaign` schemaVersion 1 remains valid and
preferred for one-unit dogfood. There is no silent upgrade path from single-gap
declarations into the multi-unit kind.

## Caps (hard stops)

Conservative planner defaults from #257:

| Cap | Value |
| --- | --- |
| `maxUnits` | `5` |
| `maxAttemptsPerUnit` | `3` |
| `maxCampaignAttempts` | `15` |

Attempt caps are the first hard stop. Token / wall-clock budgets are follow-on
and are not part of this freeze.

## Terminal stop reasons

Success-of-bound only (not fabricated quality success). Closed set:

- `complete`
- `cap-exhausted`
- `plateau`
- `authorization-revoked`
- `review-failed`
- `operator-stop`

## Private campaign directory

Keep the campaign directory outside the repository with mode `0700`; every
input leaf is an owner-only `0600` regular file. Fail closed on symlinks, hard
links, permissive modes, unknown JSON keys, and duplicate keys (same spirit as
single-gap campaigns).

| Leaf / path | Role |
| --- | --- |
| `declaration.json` | Campaign identity, revision, caps, immutable digests. |
| `unit-queue.json` | Ordered entries `{ workUnitFingerprint, machineContractSha256 }`. |
| `units/<fingerprint>/` | Per-unit receipt, run-record digests, evaluate evidence digests. |
| `progress.json` | Queue index, attempt counters, terminal `stopReason`. |
| authorization + independent-review leaves | Same Ed25519 / distinct-reviewer policy spirit as single-gap. |

Queue entries bind **`workUnitFingerprint`** and **`machineContractSha256`**
per Investigation #255. Resume rebinds by that pair. One unit per fresh
context / lease. Unit selection is an ordered list from maturity / release
queues; state lives in the ledger and run records, never chat.

## Authorization and review

Reuse Ed25519 maintainer authorization and a **distinct** independent reviewer
policy from bounded-doc-improvement. `--allow-write` gates stay explicit.
No auto-merge, no auto-publish, no unbounded “run forever” loop.

## Non-overlap with #226

Multi-unit campaign progress records verified env facts and digests only. It
does **not** implement the #226 candidate keep/discard / plateau ledger.
Catalog `evaluate` (#256) may grade a unit’s machine checks / rubric; that is
separate from this campaign envelope and from #226.

## Non-goals

- Auto-merge or tracker write authority
- Pi multi-agent / subagent spawning as the campaign mechanism
- Silent migration of single-gap v1 declarations
- Replacing or hosting the #226 candidate experiment ledger

## CLI (argv frozen by #268)

```bash
docsfab multi-unit-campaign --campaign-dir <private-directory> --repo <path>
  [--revision <ref>] [--dry-run] [--json]
```

Dry-run is the default. `--allow-write` is recognized and fail-closed (no
auto-merge / auto-publish / source mutation on this surface). Operator
procedure: [multi-unit dry-run](../prove-a-doc-change/multi-unit-doc-improvement.md).

## Child Tasks

- #265 — land this document + reference stub (this Task)
- Later: ledger decoder, CLI + fixtures (no `src/` in #265)
