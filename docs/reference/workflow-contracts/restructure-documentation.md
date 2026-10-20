---
title: "Restructure Documentation Workflow in DocsFab"
description: Run the fixed DocsFab workflow that inventories, plans, restructures, validates, reviews, and evaluates a documentation set.
status: draft
content.type: reference
---

`restructure-documentation` is a DocsFab runtime workflow, not a skill. It
supports bounded modularization, consolidation, splitting, merging, and
information-architecture changes while preserving supported content and
reader access. For more information, refer to [Workflow Contracts in
DocsFab](index.md).

## Contract at a Glance

The following table summarizes the contract.

| Field | Contract |
| --- | --- |
| Use it when | An existing documentation set needs a bounded structural or information-architecture change. |
| Mutation | One bounded `write-documentation` step in restructure mode. |
| Required authority | Explicit runtime write authorization for the selected repository, revision, and mapped documentation set. |
| Compatibility input | A complete preservation map for content, routes, anchors, references, includes, assets, owners, reader entry points, and checks, bound to immutable base evidence. |
| Result | A local structure patch, base-and-candidate map with one result per obligation, unresolved-reference report, and separate quality evidence. |
| Excluded workflow actions | Silent deletion, compatibility-route removal, publish, commit, push, open a merge request, or merge. |

## Workflow Sequence

The fixed skill sequence is:

1. `audit-documentation` in documentation-set scope
2. `plan-documentation`
3. `derive-source-obligations` (`verify-technical-accuracy` in
   inventory-only mode)
4. `write-documentation` in restructure mode
5. `lint-documentation`
6. `verify-technical-accuracy`
7. `review-documentation`
8. `test-audience-understanding`
9. `evaluate-document-quality`

Planning reuses the frozen inventory and immutable evidence when supplied.
Additional discovery resolves specific preservation obligations. Concise step
summaries still retain the complete preservation map and acceptance evidence.

Before the write step, inventory-only technical verification derives a
bounded source-obligation ledger from the plan's immutable documentation
sources, using the retained preservation map as untrusted inventory. The plan
must still account for every in-scope content block,
route, anchor, inbound reference, include, asset, owner, and validation
command. Explicit requirements remain obligations even when the model inventory
omits them. Each mutating page binds its immutable base sources through
`sourceBindings`. The planner returns the complete map in its summary; it does
not require a separate map artifact or a locator supplied by you. The writer
consumes that retained summary as untrusted input and receives the planner's
content-free sealed step identity. The runtime passes the validated plan
binding unchanged, preserving its exact write paths and immutable base source
locators. These handoff bindings do not establish semantic preservation. The runtime write authorization permits only
the bounded restructuring mutation.

The independent preservation reviewer consumes the same retained planner
summary as untrusted inventory, plus the planner's content-free sealed
identity. That reviewer does not receive writer conclusions or the sealed
write allowlist. The reviewer compares each obligation against immutable
base evidence and the exact candidate, then returns one result per
obligation. Structural lint remains a separate route and link check.

The map records repository paths and published routes separately. A source path
proves that a checked-in file exists. A published route comes from navigation
and must resolve to the intended destination and fragment. Evidence retained on
one page does not satisfy a requirement at another reader entry point.

Preserving an anchor or link means that the anchor still exists and still
identifies the same section, and every link to it still resolves to that
section. It does not fix the section's position. Reordering sections within a
page, without renaming their headings, preserves the anchors of headings whose
text is unique on the page. Where heading text repeats, generated anchors are
numbered in page order (`example`, `example-1`), so a reorder can move
`#example` to a different section while the link still resolves. The plan
updates the links to a shifted anchor within the scope of your instruction.
If it cannot do that within that scope, the planner returns `needs-input`.

A placement that your instruction states explicitly wins, such as the order
you give, "to the top," "to the end," or "after" another section. Sections
that your instruction does not name keep their relative order, and a section
that was last and is not named stays last. The planner returns `needs-input`
only for a genuine conflict or gap. Examples are an instruction that contradicts
itself, asks to delete or rewrite content that it also says to preserve,
requires a page, route, or source that the run cannot bind, or depends on a
decision or dependency that is not available.

## Restructure a Multi-Page Set

Refer to [Restructure a Documentation Set](../../workflows/restructure-documentation-set.md).

## Preservation Evidence

Deterministic structural checks verify readable paths, navigation, routes, and
link targets. The bound preservation check verifies destination fragments.
Independent preservation review compares each obligation against the immutable
base and exact candidate for meaningful content or relocation at every required
entry point. It consumes the planner map, not writer-reported results. A
generated map or completed model step is an artifact to review, not
preservation proof by itself.

The checked-in regression uses synthetic base, known-bad, and corrected trees
to cover route, overview-entry, and meaningful deep-link failures. It verifies
the repository contract without claiming that a live documentation restructure
has succeeded.

## Output and Authority Boundary

The workflow reports the before-and-after map and unresolved references. It
does not silently delete content, remove compatibility routes, publish, or
perform SCM changes.

If the CLI run succeeds, host delivery opens one draft merge request
unless you pass `--patch-only`. That projection is not part of the
fixed workflow and cannot merge or publish the documentation.
`--allow-write` and `--draft-mr` remain accepted.

## Authoritative Sources

The following sources define the behavior this page describes:

- [Workflow manifest](../../../packages/runtime/workflows/restructure-documentation.json)
- [Authoring skill](../../../packages/skills/write-documentation/SKILL.md)
- [Content-map contract](../../../packages/skills/write-documentation/references/content-map.md)

## Related Topics

The following pages provide related information:

- [Restructure Documentation procedure](../../workflows/run-a-documentation-workflow.md)
- [Skill Behavior Contracts in DocsFab](../quality/skills/index.md)
- [Create Documentation Workflow in DocsFab](create-documentation.md)
