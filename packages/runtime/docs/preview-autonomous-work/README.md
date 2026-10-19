# Preview autonomous work

<!-- Diataxis: how-to hub. -->

## Goal

Preview the next governed autonomous documentation action without changing a
repository, GitLab issue, branch, or merge request.

## When to use this

Use a preview to check the evidence, selected work unit, and proposed tracker
operations before a separately authorised execution cycle.

## Tasks

1. Run `docsfab auto --dry-run --repo /absolute/path/to/repository --json`.
2. Review the exact repository revision, work-unit rationale, and `nextAction`.
3. Use [roadmap planning](roadmap-planning.md) to understand the read-only
   roadmap ledger and mutation plan.
4. Do not treat a dry run as authority to publish: execution remains an
   explicit operator decision.

## Related topics

- [Autonomous-cycle contracts](../reference/contracts/autonomous-cycle-contracts.md)
- [Read-only autonomous dry run](auto-dry-run.md)
- [Managed issue convention](../reference/contracts/managed-issue-convention.md)
