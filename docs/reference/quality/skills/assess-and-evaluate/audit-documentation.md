---
title: Audit Documentation Skill in DocsFab
description: Audit a focused Markdown target or a documentation set against repository evidence without editing files.
status: in-development
---

The DocsFab `audit-documentation` skill has two explicit scopes.
`focused-document` records scope, coverage, and documentation-set problems
for in-scope Markdown. `documentation-set` freezes a declared set and
produces a multi-lens inventory, coverage matrix, provenance, findings, and
evidence gaps. Source-vs-claim, example validity, and unsupported technical
claims stay with `verify-technical-accuracy`. Native checks stay with
`lint-documentation` and the host executor. For more information, refer to
[Assessment and Evaluation Skills in DocsFab](index.md).

## Scope Contracts

| Scope | Use it to | Current runtime binding |
| --- | --- | --- |
| `focused-document` | Audit declared Markdown for scope defects, coverage gaps, and documentation-set problems. | Available in the skill contract; not selected by a current catalog workflow manifest. |
| `documentation-set` | Freeze and inventory a declared set, its dependencies, coverage, provider contexts, and material risks. | Audit step in `review-documentation` and inventory step in `restructure-documentation`. |

The comprehensive review manifest selects documentation-set scope even when
the declared set contains one changed document. Documentation-set audit still
produces that coverage baseline without invoking verify, review, audience, or
evaluate.

## Evidence and Boundaries

The set scope records provider context and independence, preserves
disagreements, keeps human and agent outcomes separate, and leaves uncovered
dimensions `not-assessed`. Focused-document triangulation compares the page,
the declared set, and requested outcomes; it is not a second technical
verifier. The skill remains source-only and does not schedule
sibling skills, execute documented product procedures, mutate the target,
publish, or issue a release-readiness verdict.

## Authoritative Sources

- [Skill contract](../../../../../packages/skills/audit-documentation/SKILL.md)
- [Triangulation protocol](../../../../../packages/skills/audit-documentation/references/triangulation-protocol.md)
- [Aggregation and confidence](../../../../../packages/skills/audit-documentation/references/aggregation-confidence.md)
- [Lens roster](../../../../../packages/skills/audit-documentation/references/lens-roster.md)
- [Output contract](../../../../../packages/skills/audit-documentation/references/output-contract.md)
- [Comprehensive review binding](../../../../../packages/runtime/workflows/review-documentation.json)
- [Restructure workflow binding](../../../../../packages/runtime/workflows/restructure-documentation.json)
