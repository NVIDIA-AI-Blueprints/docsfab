# DocChangeDelta (OpenSpec vocabulary, DocsFab authority)

**Status:** Accepted  
**Date:** 2026-08-11  
**Investigation:** #249 (parent epic #248, saga #211)  
**Adjacent (do not re-decide):** STAR publication narrative #243 / epic #118

This contract freezes how DocsFab projects OpenSpec-style
ADDED / MODIFIED / REMOVED requirement deltas from sealed run evidence.
It is the durable home for decisions that outlive epic #248.

## Decision

Adopt a **sealed projection artifact** (`DocChangeDeltaV1`). Deterministic
ADDED / MODIFIED / REMOVED lines are derived only from admitted run evidence.
The projection is display / review only. It never grants write authority,
tracker mutation, roadmap apply, or a substitute for `ia approve` /
`--allow-write`.

Rejected alternatives:

1. **Install / embed OpenSpec** (`@fission-ai/openspec`, `/opsx:*`, customer
   `openspec/` folders as product truth) — harness coupling and markdown-as-
   authority conflict with DocsFab gates.
2. **Prose-only MR essay at publish** — model-invented deltas (same class of
   risk rejected for STAR free-form narratives in #243).

## Kind and envelope

- **Kind (stable):** `docsfab-doc-change-delta` (TypeScript type name may be
  `DocChangeDeltaV1`; kind string is the durable identity).
- **Closed schema** with a canonical digest over the sealed body.
- **Sections:** exactly `added` | `modified` | `removed` (machine enums;
  human labels ADDED / MODIFIED / REMOVED).
- **Each entry binds:**
  - stable requirement / gap identity (or readiness work-unit id);
  - content-free codes / labels;
  - evidence digests (gap observation / finding / artifact ref as applicable);
  - repository revision + repository content digest matching the run.
- **Authority:** explicit `trackerMutation: "not-authorized"` (or equivalent
  closed enum). Projection is not write authorization, not roadmap apply
  authority, and not a substitute for governed approve / `--allow-write`.
- **Provenance:** must reconstruct from an authenticated run record plus
  admitted ledger / artifact refs. Self-sealed bytes alone are insufficient
  (same pattern as gap → roadmap proposal validators in
  `src/search/gap-ledger.ts`).

### Forbidden in payload

Free-form model narration, tool transcripts, credentials, host paths, raw
matched doc text, and absolute paths. Unknown fields fail closed.

### Lifecycle display (optional)

Display states may mirror gap lifecycle (`open` → `fixed` / `verified`).
Archive or close of a delta **does not** merge into customer-repo markdown
as spec truth.

## Source map (first wave)

| OpenSpec idea | DocsFab source (wave 1) |
| --- | --- |
| ADDED requirements | Open gap ledger entries / readiness `missing` work units projected as added obligations |
| MODIFIED requirements | Gaps or plan `outputScope` entries with prior observation + changed coverage / revision / workspace snapshot |
| REMOVED requirements | Explicitly closed / obsolete dispositions only when evidence supports removal; never invent |

`ia-plan` `outputScope` / `plannedPages` may feed a later wave after the
polish / bootstrap path lands. Wave-1 Tasks must not wait on that path.

## Change packaging metaphor

Operator-private bundling under DocsFab state (run-scoped display bundle:
intent summary + delta + display-only step checklist derived from catalog) is
allowed. Must not:

- create a second authority store that agents edit as truth;
- write `openspec/` into the selected customer repository as product behavior;
- auto-merge deltas into repo specs on archive / close.

## Lite vs Full

Map to existing workflow risk — do not invent a parallel markdown ceremony
ladder:

- **Lite:** read-only audit / readiness review (delta as review aid).
- **Full:** write polish / bootstrap / site-bootstrap (delta + patch + gates).

## Explicit anti-patterns

Tasks implementing this contract must not:

- Depend on `@fission-ai/openspec` or `/opsx:*`.
- Treat agent-owned checklists as `Task → Workflow → Step` authority.
- Auto-merge deltas into repo specs on archive / close.
- Re-decide STAR section headers (#243) or lineage disclosure rules.
- Block wave-1 work on multi-repo Stores (#253 remains **Not now** until
  dogfood pain re-opens that Investigation).

## Coordination with STAR (#243)

A DocChangeDelta may appear as an additional sealed section or sidecar beside
a patch. STAR remains the publication narrative contract
(Situation / Task / Action / Result). Do not fold delta vocabulary into STAR
headers or re-open #243.

## What implementers may assume

After Investigation #249 close:

- Option 3 + the rules above are frozen.
- Path scopes may implement schema / decoder, projector, CLI / JSON emission,
  and tests only.
- Peer authority pattern: gap roadmap proposals with
  `trackerMutation: "not-authorized"` in `src/search/gap-ledger.ts`.
- Schema / decoder home (Task #250): `src/search/doc-change-delta.ts`
  (`DocChangeDeltaV1`, kind `docsfab-doc-change-delta`).

## Child Tasks (epic #248)

| Task | Role | Ready when |
| --- | --- | --- |
| #250 | Schema + decoder + fail-closed authority | #249 closed |
| #251 | Projector from gap ledger / readiness | #249 closed **and** #250 merged / decoder available |
| #252 | CLI / JSON emission beside patch | #249 closed **and** #250 + #251 available |

## Related contracts

- [Roadmap ledger and mutation contracts](./roadmap-contracts.md) — authorized
  tracker mutation is a separate, explicit path; DocChangeDelta is not it.
- [Artifact contracts](./artifact-contracts.md) — digest / revision binding
  patterns.
- [Run record](./run-record.md) — authenticated run identity for provenance.
- [Publication provenance projectors](./publication-provenance-projectors.md) —
  STAR / publication narrative inputs (coordinate; do not subsume).
