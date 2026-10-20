# Multi-unit documentation-improvement campaign (dry-run)

DocsFab can drive a **capped multi-unit** stewardship ledger without modifying
the selected source checkout. This procedure is distinct from the single-gap
[bounded documentation improvement](bounded-doc-improvement.md) campaign
(`bounded-doc-improvement-campaign` v1). Do not upgrade a single-gap declaration
into this kind.

Normative freeze: [multi-unit campaign plan](../plan/multi-unit-doc-improvement-campaign.md)
and [contract stub](../reference/contracts/multi-unit-doc-improvement.md)
(Investigation #257). Machine-contract binding: #255. Catalog evaluate
semantics: #256. Candidate keep/discard remains #226 only (not this ledger).

## Outcome

Run `docsfab multi-unit-campaign` in **dry-run default** mode against a private
campaign directory with ≥2 `workUnitFingerprint` slots under the frozen caps.
The command persists durable `progress.json` (terminal `stopReason`) and
per-unit dry-run receipts, and asserts the source checkout stays unchanged.

## Caps and stop reasons

| Cap | Value |
| --- | --- |
| `maxUnits` | `5` |
| `maxAttemptsPerUnit` | `3` |
| `maxCampaignAttempts` | `15` |

Terminal `progress.stopReason` values: `complete` | `cap-exhausted` |
`plateau` | `authorization-revoked` | `review-failed` | `operator-stop`.

## Private campaign directory

Keep the campaign directory **outside** the repository with mode `0700`; every
JSON leaf is owner-only `0600`. Required layout:

```text
declaration.json
unit-queue.json
progress.json
units/<workUnitFingerprint>/
```

`unit-queue.json` is an ordered list of
`{ workUnitFingerprint, machineContractSha256 }` entries. Resume rebinds by
that pair. Dry-run writes `units/<fingerprint>/dry-run-receipt.json` and
updates `progress.json` in place.

## Dry-run CLI

Dry-run is the default. `--allow-write` is recognized and **fail-closed** for
this surface (no source mutation, no auto-merge, no auto-publish). Optional
`--dry-run` is accepted as an explicit no-op flag.

```bash
docsfab multi-unit-campaign \
  --campaign-dir /absolute/private/campaign \
  --repo /absolute/source/checkout \
  --revision <full-commit> \
  --json
```

Example human output:

```text
Multi-unit campaign: campaign-multi-unit-cli-1
Mode: dry-run
Units processed: 2
Queue index: 2
Campaign attempts: 2
Stop reason: complete
Progress digest: <sha256>
Source checkout unchanged: yes
Source revision: <full-commit>
```

## Acceptance smoke

Named Vitest:

```bash
npx vitest run test/multi-unit-campaign-cli.test.ts
```

The smoke asserts ≥2 units under cap, durable terminal `stopReason`, and an
unchanged source checkout (`git status --porcelain` empty; tracked content and
`HEAD` unchanged).

## Non-goals

- Re-implementing the ledger decoder (#266)
- Candidate keep/discard / plateau ledger (#226)
- Auto-merge, auto-publish, or tracker write authority
- Silent migration from single-gap `bounded-doc-improvement-campaign` v1
