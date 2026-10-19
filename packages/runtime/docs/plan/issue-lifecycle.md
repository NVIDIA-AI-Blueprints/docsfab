# Plan: GitLab issue lifecycle (swarm-ready specs)

- **Status:** Accepted (process freeze)
- **Date:** 2026-08-10
- **Complements:** [managed-issue convention](../reference/contracts/managed-issue-convention.md),
  [autonomous roadmap integration](../preview-autonomous-work/autonomous-roadmap-integration.md),
  internal governed-intelligence burndown plan
- **Templates:** `.gitlab/issue_templates/`
- **Agent stigmergy:** [`docs/field-guide/`](../field-guide/)

## Current DocsFab contributor policy — 2026-09-13

For direct human-authorized contributor work, follow the root
Direct backlog work and multi-human drive guidance.
This internal runtime document retains the DocsFab managed-cycle
contract for that product mechanism. Its `ready` and claim details are
compatibility guidance for managed-cycle or explicitly requested legacy board
runs; they do not impose a ready lease on contributors. Its product
authorization boundaries remain unchanged.

## Why this matters

Large tasks are trees. A planner that also implements fills its context with
leaf detail and drifts. A worker that also designs re-decides questions already
settled elsewhere. GitLab issues are the durable intent store for DocsFab; they
must be **specs that lower into owned Tasks**, not human tickets that agents
reinterpret.

Without a lifecycle freeze:

1. Epics stay prose essays; workers invent schema mid-flight.
2. Two Tasks touch the same megafile and thrash.
3. Exit criteria are checkboxes no CI can grade.
4. Design decisions reappear in every subtree (split-brain).
5. `lifecycle::ready` / `lifecycle::blocked` become decoration instead of the
   lease gate that `src/autonomy/managed-cycle.ts`
   already requires.

**Fix:** Treat the issue graph as the task tree for the managed-cycle
mechanism. Planners own sagas, epics, and investigations. Managed-cycle
workers claim `[DocsFab][Task]` issues at `lifecycle::ready`; native
contributors may proceed from an authorized bounded brief under the root
direct-backlog policy. Shared ADRs and the field guide carry decisions and
surprises between trajectories.

This document governs *how we track and burn down work*. Product truth stays in
contracts, ADRs, and code. Tracker writes still require explicit DocsFab
authorization; the swarm harness never mints write authority.

## Principles

1. **Specs as prompts** — Issue bodies are the unit of work, not chat history.
2. **Planner never implements; worker never plans** — Design questions stay on
   saga / epic / investigation issues. Tasks execute frozen acceptance.
3. **One decision owner per subtree** — If two Tasks would decide the same
   question, collapse it into an investigation (or ADR) first.
4. **Owned paths** — Every Task names Path scope (repository-relative allowlist).
   Hotspots need explicit carve-outs or a prior split Task.
5. **Machine exit criteria** — Prefer named Vitest files, CI job names, or
   documented CLI smokes over prose-only checkboxes. Solo runtime work
   runs `npm run check`. Two or more parallel native workers or worktrees
   sharing the host use Acceptance plus the bounded static slice,
   `test:changed -- --paths <named Task tests>`, and
   `test:ci:smoke` (one shot); CI is the full-suite gate.
6. **`lifecycle::ready` is the lease** — Workers start only on ready Tasks.
   Waiting on humans or deps uses `lifecycle::blocked` and does not hold an
   agent lease. `status::planned` alone is **not** a worker lease.
7. **Stigmergy over ceremony** — Capture surprise in `docs/field-guide/` and
   lasting decisions in docs/ADRs; do not invent workshop process on the hot path.
8. **Complement, don't replace, managed convention** — Titles, labels, markers,
   and draft sections follow the managed-issue convention. This process adds
   planner/worker operating rules on top.

## Issue tree

```text
saga (north-star thread)
 └── epic (outcome + exit criteria + child map)
      ├── investigation (freeze one decision / schema / contract)
      └── task (owned paths + machine acceptance)
```

| Kind | Title prefix | Role | Opens when | Closes when |
| --- | --- | --- | --- | --- |
| **Saga** | `[DocsFab][Saga]` | Product / strategy thread | A multi-epic north star appears | The thread is obsolete or absorbed |
| **Epic** | `[DocsFab][Epic]` | Outcome-sized subtree | Outcome and exit criteria are known | Exit criteria graded true |
| **Investigation** | `[DocsFab][Investigation]` | Planner-owned decision | Ambiguity would otherwise fork Tasks | Decision recorded; ADR linked if lasting |
| **Task** | `[DocsFab][Task]` | Worker-owned unit | Paths + acceptance are frozen | Machine acceptance passes + MR merged |

Bugs and chores that an agent might implement still use Task shape (Path scope
+ machine Acceptance). Investigation-only issues are never claimable as worker
leases.

## Required fields (managed draft sections)

Every managed kind uses the same draft sections from
`renderManagedIssueDraft`. Planner/worker emphasis:

### Saga

- North-star sentence (Rationale)
- Provenance / evidence references
- Workstream / epic list (Dependencies links, not a fake code checklist)
- Architectural boundaries and **Not now** (Required human input / Rationale)
- Success signal (Acceptance + Verification — observable, not aspirational)

### Epic

- Parent saga IID in Dependencies
- Outcome (one paragraph in Rationale)
- Scope / non-goals
- Decisions already made (ADR links or “none — see child investigations”)
- Child map (investigation + Task issues, or “to be filed after investigation”)
- Exit criteria (gradable Acceptance / Verification)

### Investigation

- Parent epic IID in Dependencies
- Question being frozen (Rationale)
- Options considered (short)
- Decision + consequences
- What Tasks may assume after close
- Link or create an ADR when the decision outlives the epic
- Path scope may be docs/ADR-only

### Task

- Parent epic (or investigation) IID in Dependencies
- Outcome (one sentence in Rationale)
- **Path scope** — allowlist of files/dirs the worker may change
- Out-of-scope paths called out in Rationale when useful
- Decisions frozen (cite investigation / ADR — do not re-decide)
- **Acceptance** — at least one machine check, for example:
  - `npx vitest run test/<name>.test.ts`
  - `npm run check` (solo / quiet machine before push for product code)
  - two or more parallel native workers or worktrees sharing the host:
    Acceptance plus the bounded static slice, `npm run test:changed -- --paths
    <named Task tests>`, and `npm run test:ci:smoke`; CI is the full-suite gate
  - documented CLI smoke with expected keys
  - fixture / golden digest update
- Labels: `docsfab-roadmap::managed`, exactly one gate / workflow / priority, and
  exactly one of `lifecycle::ready` or `lifecycle::blocked` while open for
  managed-cycle worker scheduling (see label lifecycle); native contributors
  follow the root direct-backlog policy instead of this lease.

## Label lifecycle (machine lease)

| State | Lifecycle label | Meaning |
| --- | --- | --- |
| Planning | `lifecycle::filed` (or investigation without ready) | Planner work; workers do not claim |
| Blocked | `lifecycle::blocked` | Dependency or human gate; no worker lease |
| Ready | `lifecycle::ready` | Task may be claimed by a worker / managed-cycle |
| Selected / in flight | `lifecycle::selected` → `in-progress` → `in-review` | One owner; do not double-claim |
| Done | `lifecycle::verified` / `closed`; **remove ready** | Acceptance true; MR merged or epic exit graded |

Rules:

1. Never put both `lifecycle::ready` and `lifecycle::blocked` on the same issue.
2. Promoting a Task to `lifecycle::ready` means its investigation deps are closed
   or explicitly waived on the issue body.
3. Prefer blocking the specific Task over blocking an entire epic when children
   can still proceed.
4. Priority (`priority::p0`–`p2`) is scheduling, not readiness.
5. Closing a Task **must** drop `lifecycle::ready` (and `blocked`). Stale ready
   on closed issues poisons orchestrator board counts and managed-cycle
   selection.

Autonomous delivery may advance `ready → selected → in-progress → in-review →
verified → closed` only through authorized mutation plans. The swarm harness
does not bypass that boundary.

## Live label migration (`status::*` / `type::*` → managed lease)

The tracker may still show human-facing labels such as `status::planned`,
`status::in-progress`, `type::saga`, `type::epic`, and `area::*`. Those are
**board decoration during migration**, not the machine lease.

| Live label (legacy / human) | Managed lease (authoritative) |
| --- | --- |
| `type::saga` / `type::epic` | Title prefix `[DocsFab][Saga]` / `[Epic]` (+ `docsfab-roadmap::managed`) |
| (no task type) / chore issues | Title prefix `[DocsFab][Task]` |
| design / ambiguity threads | Title prefix `[DocsFab][Investigation]` |
| `status::planned` | **Not claimable.** File or promote to `lifecycle::ready` only when Path scope + Acceptance are frozen |
| `status::blocked` | Prefer `lifecycle::blocked` (keep `status::blocked` only as a mirror until removed) |
| `status::in-progress` / `in-review` | Prefer `lifecycle::in-progress` / `lifecycle::in-review` |
| `area::*` | Optional human routing; does not replace `workflow::*` / `gate::*` |

**Claimable now** means: open issue, `[DocsFab][Task]` (or equivalent Task
shape), `docsfab-roadmap::managed`, `lifecycle::ready`, and Path scope + Acceptance
present. `status::planned` alone must not appear on the orchestrator ready list.

Adoption checklist for an open board:

1. Rewrite worker units to Task prefix + managed draft sections.
2. Apply controlled labels (`gate::*`, `workflow::*`, `priority::*`, lifecycle).
3. Flip truly startable work to `lifecycle::ready`; leave the rest blocked/filed
   with a one-line reason.
4. Stop treating `status::planned` as the claim lease once ready is populated.

## Ownership and megafiles

Tasks that would edit any of the following need either a narrow Path-scope
carve-out or a prior split/refactor Task:

- `src/workflow-execution/runner.ts`
- `src/roadmap/*-authority-internal.ts` and other sealed host authorities
- Soft-dependency boundaries across assessment / autonomy / publication
  (see [soft-dependencies](../reference/operations/soft-dependencies.md))
- `scripts/ci-heavy/*.txt` and CI verify graph entrypoints
- `scripts/contract-dialect-allowlist.json` / soft-deps exception lists
- Package-wide skill lock / roadmap-pack registries that every skill touches

Prefer “touch only `src/<package>/` + matching `test/` + one ops doc” shaped
Tasks for managed-cycle runs. Native parallel work can use separate worktrees
or clones when paths overlap; treat that overlap as an integration risk, and
require disjoint ownership only for same-checkout writes.

## Managed-cycle planner vs worker operating loop (historical compatibility)

```text
1. Planner opens / updates epic (outcome + exit).
2. Planner files investigations for contested decisions.
3. Investigation closes → ADR or in-body decision freeze.
4. Planner files Tasks with Path scope + machine Acceptance.
5. Planner flips Tasks to lifecycle::ready when deps close.
6. Worker claims one ready Task; implements only Path scope.
7. Worker runs Acceptance before push. Solo runtime product-code also
   runs `npm run check`. Two or more parallel native workers or worktrees
   sharing the host use Acceptance plus the bounded static slice,
   `test:changed -- --paths <named Task tests>`, and
   `test:ci:smoke` (one shot); they do not each run full
   `npm test`.
8. Worker opens MR citing issue IID + acceptance commands (does not merge).
9. Orchestrator integrates: CI green → merge (when authorized) → close issue
   → drop lifecycle::ready; refresh board.
10. On surprise, update docs/field-guide/ (budgeted) or open an investigation —
    do not silently expand Task scope.
```

Frontier models belong on steps 1–5 and intentional breakage that needs a new
decision. Inexpensive models belong on step 6 when the Task is explicit. An
investigation/ADR freeze that clears many deps is higher leverage than one more
underspecified Task.

## Intentional breakage

If a Task must change a core contract outside its Path scope:

1. Stop and open or resume an **investigation** (or ADR).
2. Or, if urgency is justified, land a focused patch with an issue comment that
   states *why*, then file follow-up Tasks for dependents — no silent scope creep.

## Review lenses (stacked)

| Lens | Cheap signal |
| --- | --- |
| `npm run check` | Solo / CI: dialect islands, soft-deps, tsc, full Vitest |
| Bounded static slice + named tests | Mill on a shared host: static checks + named Vitest tests |
| Named acceptance test | Task-local grade |
| CI smoke / shard / isolation job | Full bar still green |
| Human / planner | New ADR, threat model, or pricing only |

No single lens is enough; prefer stacking cheap ones over one expensive reread
of the full transcript.

## Field guide

[`docs/field-guide/`](../field-guide/) is agent-curated shared context while
building DocsFab. `docs/field-guide/index.md` is the inject point. Constraints:

- Line budget enforced in the index header
- Capture **surprises** and durable gotchas, not restatements of contracts
- Prefer links to contracts / ops docs over pasting large specs
- Humans may prune; agents may edit within budget

## Templates and scripts

| Asset | Purpose |
| --- | --- |
| `AGENTS.md` | Simple invokes: `board`, `burndown`, `claim #N`, … |
| `.gitlab/issue_templates/*.md` | Intake forms matching managed sections |
| `.gitlab/merge_request_templates/Default.md` | Cite Task, evidence, acceptance (paths are derived by `process:mr-hygiene`) |
| Roadmap planning / issue-lifecycle apply | Product write path (explicit authorization) |
| `docs/field-guide/` | Budgeted surprises |

## Adoption checklist

- [ ] New work uses saga / epic / investigation / Task templates
- [ ] Open Tasks an agent could start have `lifecycle::ready` or `blocked`
- [ ] Each ready Task lists Path scope and a machine Acceptance command
- [ ] Epics link parent saga and child issues
- [ ] Investigations that outlive an epic land an ADR
- [ ] MRs fill the template and name the acceptance command run
- [ ] Workers run the mill vs solo local bar before push (see AGENTS.md)
- [ ] Closed Tasks no longer carry `lifecycle::ready`
- [ ] Surprises go to `docs/field-guide/` within budget
- [ ] Live `status::*` / `type::*` mirrored or retired per migration table

## Non-goals

- Replacing GitLab with another tracker
- Building an in-house swarm VCS or merge reconciler
- Auto-minting tracker write authority or merging inside `swarm`
- Turning this harness process into a product constellation / MCP surface
- Mandatory story points, sprint ceremonies, or SLA theater

## Success signal

A frontier planner can decompose an epic into `lifecycle::ready` Tasks; a
cheaper worker can complete a Task using only the issue body + cited ADRs +
Path scope; CI grades Acceptance without re-reading chat; managed-cycle and
the orchestrator board agree on what is claimable.
