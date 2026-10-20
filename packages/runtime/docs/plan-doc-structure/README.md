# Plan documentation structure

<!-- Diataxis: how-to hub. -->

## Goal

Create and review an evidence-backed information-architecture plan before a
site scaffold is authorised.

## When to use this

Use it when the current documentation structure no longer makes reader tasks
easy to find, or before creating a new documentation site.

## Tasks

1. Read [two-phase IA](two-phase-ia.md) for the exact immutable-revision
   analysis, planning, and human approval sequence.
2. Run `docsfab ia cycle --repo /absolute/path/to/repository` to produce the
   read-only analysis and plan; resolve `needs-human-decision` rather than
   bypassing it.
3. Inspect [template operations](../reference/operations/template-operations.md) before listing,
   previewing, validating, or scaffolding a template-backed page.
4. Continue to `site-bootstrap --allow-write` only after the current approved
   plan authorises the requested scaffold.

## Related topics

- [Content IR](../reference/content-ir.md)
- [Impact and healing](impact-healing.md)
