# Plan: Catalog `evaluate` WorkflowStepKind (vs candidate keep/discard)

- **Status:** Accepted (process / contract freeze)
- **Date:** 2026-08-12
- **Investigation:** #256 (Epic #254, Saga #211)
- **Complements:** [issue lifecycle](issue-lifecycle.md), foundation-to-patch (#225),
  candidate keep/discard (#226)

## Decision

Add a closed `WorkflowStepKind` value **`"evaluate"`** (option 1 from #256).

Do **not** rely on convention-only skill naming (option 2) or collapse evaluate
into host-operation-only deterministic checks (option 3).

## Runner / catalog rules Tasks may assume

1. `evaluate` steps are **read-only** (mode / tool policy equivalent to
   read-only inference): no write tools, no path-scope expansion, no
   authorization minting.
2. An `evaluate` step uses a **distinct** skill/prompt identity from the
   generate / apply step it judges.
3. An `evaluate` step **must not** be the sole authority that flips a work-unit
   Acceptance (or equivalent) to passed; Acceptance remains host/decoder /
   machine-check owned.
4. Run-record / step evidence records evaluator identity and policy digests
   (content-free; no credentials or raw prose as authority).
5. First consumer: polish `audit-before-polish` → `apply-polish` migration to a
   typed evaluate → apply pair; later campaign units under #254.

## Non-overlap with #226

| Concern | Owner |
| --- | --- |
| Candidate attempt ledger, keep/discard, plateau, budgets inside foundation-to-patch | **#226** |
| Reusable catalog `evaluate` step kind + runner gates | **#254 / #256** (this freeze) |

Catalog evaluate must not re-implement the candidate experiment ledger.
Candidate keep/discard must not add a `WorkflowStepKind` evaluate value.

## Non-goals

- Pi multi-agent / subagent spawning as the evaluate mechanism
- Replacing #226
- Auto-merge or tracker write authority

## Child Tasks (filed from #256)

- #260 — land this document
- #261 — evaluate kind + runner reject rules
- #262 — polish evaluate migration
