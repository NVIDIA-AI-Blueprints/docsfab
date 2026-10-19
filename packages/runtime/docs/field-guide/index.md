# Field guide (agent stigmergy)

<!-- line-budget: 40 body lines max (excluding this header and the title) -->

Budgeted surprises while building DocsFab. Prefer links over paste. Humans prune;
agents may add one line for a true surprise after a Task.

## Inject first

- [Issue lifecycle](../plan/issue-lifecycle.md) — saga → epic → investigation → Task; `lifecycle::ready` lease
- Repository `AGENTS.md` — `swarm` / `board` / `burndown` / `claim`
- Design decisions record — why Pi, fixed workflows, two-phase auth, process≠product
- Stop-class handling record — every operator-visible stop names a class and one next action
- Maintain-the-catalog guide — pin a skill or
  quality bar, remap a skill, or add a workflow
- [Managed-issue convention](../reference/contracts/managed-issue-convention.md)
- [Soft dependencies](../reference/operations/soft-dependencies.md)
- [Autonomous roadmap integration](../preview-autonomous-work/autonomous-roadmap-integration.md)

## Surprises

- Claimable work is `lifecycle::ready` on a Task — not `status::planned`.
- Tracker writes need explicit `RoadmapMutationAuthorizationV2`; swarm never invents authority.
- Shared paths are advisory across isolated worktrees; same-checkout writes need ownership/isolation. See the DocsFab multi-human drive record for contributor routing and integration guidance.
- `npm run check` is the solo / CI pre-push bar; mill workers sharing the host use the bounded static slice, named `test:changed -- --paths <Task tests>`, and `test:ci:smoke` (do not retry full Vitest).
- Biome scopes `src/`, `test/`, and `scripts/` only — checksum-locked trees
  (`governed-assets/`, `skill-crate/`, `quality/`, and `security/`) stay
  untouched.
- Managed markers are content-free identity; do not put credentials, host paths, or raw evidence in issue bodies or run records.
- Product auto dry-run observes the tracker; apply is a separate authorized step.
- A new product stop that falls through to doctor after a successful plan, or that asks for input on a capability wall, is a defect. Classify it first against the stop-class handling record.

## Do not put here

- Restatements of ADRs or full contract schemas
- Credentials, tokens, or private URLs with secrets
- Long transcripts or per-leaf implementation notes
