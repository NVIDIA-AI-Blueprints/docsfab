# Plan: Work-unit machine contract (MEA admission envelope)

- **Status:** Accepted
- **Date:** 2026-08-12
- **Investigation:** #255 (Epic #254, Saga #211)
- **Complements:** [documentation maturity contracts](../reference/contracts/documentation-maturity-contracts.md);
  evaluate WorkflowStepKind decision (#256 / Task #260 — lands
  `docs/plan/evaluate-workflow-step-kind.md`; do not re-decide here)

## Decision

Add a separate sealed envelope **`WorkUnitMachineContractV1`** (option 3 from
#255). Do **not** add optional machine-check fields to maturity work-unit v1
(option 1) or bump the work-unit schema to v2 with a required verification plan
(option 2).

Maturity `DocumentationMaturityWorkUnitV1` stays identity-only. Machine-gradable
Acceptance lives in this envelope, bound by fingerprint to an existing work
unit. Campaign / MEA admission binds the contract; cascade selection does not
rewrite maturity v1.

## Shape Tasks may assume

1. `kind` is exactly `"docsfab-work-unit-machine-contract"`; `schemaVersion` is
   exactly `1`.
2. The envelope binds `workUnitFingerprint` and `repositoryIdentitySha256` to
   an existing maturity work unit. It does not rewrite that work unit.
3. `machineChecks` is a required non-empty array. Each check uses closed
   `checkKind`:
   `"npm-script"` | `"vitest-file"` | `"cli-smoke"` | `"fixture-key"` |
   `"inventory-probe"`.
4. Check identities are content-free (`commandId` / `fixtureKey` /
   `inventoryProbeId` / Vitest path id). No host paths, credentials, or
   free-form shell as authority. Each check carries
   `expectedOutcomeClass: "pass" | "fail-closed"`.
5. `acceptanceAuthority` is
   `"host-deterministic"` | `"evaluate-step-plus-host"`. Catalog `evaluate`
   alone cannot flip Acceptance (cite #256 / Task #260 evaluate
   WorkflowStepKind decision record).
6. `trackerMutation` is exactly `"not-authorized"`.
7. Fail-closed decode: unknown fields, empty `machineChecks`, missing
   fingerprint binding, or noncanonical order → reject.

## Compatibility

| Consumer | Envelope required? |
| --- | --- |
| Maturity cascade selection / `test/fixtures/runtime-evaluation/maturity/*` fixtures | **No** — existing `execution.ready` and gate fixtures stay valid without it |
| MEA / multi-unit campaign admission | **Yes** — missing or invalid envelope → fail closed (not half-ready) |

Producers that emit MEA-eligible units (release-documentation-readiness;
cascade when selecting for campaign) emit the envelope after the decoder Task
lands. Prefer a new module under `src/maturity/` rather than a megafile rewrite
of all of `contracts.ts`.

## Non-overlap with #226

| Concern | Owner |
| --- | --- |
| Candidate attempt ledger, keep/discard, plateau, budgets inside foundation-to-patch | **#226** |
| Machine-gradable work-unit Acceptance envelope + MEA admission binding | **#254 / #255** (this freeze) |

This freeze does not redefine candidate evaluation. Candidate keep/discard does
not mint work-unit machine-contract authority.

## Non-goals

- Pi multi-agent / subagent spawning as the Acceptance mechanism
- Tracker mutation authority
- Rewriting #226 candidate ledger
- Changing maturity work-unit v1 field meanings

## Durable paths

- Plan (this document): `docs/plan/work-unit-machine-contract.md`
- Closed field list:
  [work-unit machine contract](../reference/contracts/work-unit-machine-contract.md)

## Child Tasks (filed from #255)

- #263 — land this document + reference stub (docs only)
- #264 — fail-closed decoder + Vitest admission predicate
- Producer emit (release-documentation-readiness / campaign selection) — may
  stay blocked on decoder
