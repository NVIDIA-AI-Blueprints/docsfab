# Restructure Content Map

Record one row for every source content unit and explicit preservation
obligation before restructuring. Add explicit user and workflow requirements
independently from the writer's or planner's proposed inventory.

| Obligation ID | Source repository path and anchor | Published route and fragment | Immutable base locator | Required reader entry points | Purpose | Target path, route, and anchor | Disposition | Redirect or compatibility action | Validation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |

Allowed dispositions are `retain`, `move`, `merge`, `split`,
`revise-with-evidence`, `deprecate-with-rationale`, and `out-of-scope`.

The map is complete only when every source block, route, inbound reference,
asset, include, ownership requirement, and navigation entry has a target or an approved exclusion.
Do not infer deletion from a missing target.

Repository paths and published routes use different address spaces. Derive a
route from the checked-in navigation and verify its destination and fragment.
The presence of a source file does not prove that a published route resolves.

Bind the map to the immutable base revision or tree digest before mutation.
Every mutating page's sealed `sourceBindings[].sources` list must contain its
immutable base source locators. Read the complete map from the retained
planner summary supplied by the workflow, whose sealed step identity is
provided separately. Do not rebuild the base from changed files,
expand the host-provided write allowlist, or accept an omitted obligation as an
implicit exclusion.

After authoring, append candidate evidence and one review result per
obligation. Check each required reader entry point independently. Shared source
evidence can support several pages, but content retained on one page does not
satisfy a requirement at another entry point. For an existing fragment,
verify both that the fragment resolves and that its section contains the
promised content or an actionable relocation.

Runtime structural validation covers files, navigation, routes, and link
targets. The bound preservation check and independent review verify destination
fragments, meaning, and reader-journey continuity. Independent review consumes
the planner map and the exact candidate; it does not consume writer
conclusions. Keep those results separate. Neither a completed write step nor a
generated map proves preservation by itself.

If any obligation requires an unbound page or route, stop before mutation with
`needs-input` and reason `ambiguous-scope`. Name the obligation and required
target in the returned summary.
