# Page-Set Freeze

After information-architecture placement is resolved, freeze the exact pages
this run may create, update, or restructure. The runtime-selected workflow
mode (`create`, `update`, or `restructure`) chooses the freeze rules.
Planning still does not write files.

Present this table in the plan. Every in-scope page has one row. Out-of-scope
pages that a reader might expect also get a row with disposition
`out-of-scope` and a reason. `Topic` is one task or one concept. `Content
type` is exactly one of `concept`, `how-to`, `tutorial`, `reference`.

| Family | Path | Disposition | Topic | Content type | Purpose | Sources | Nav or redirect | Unresolved |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

Allowed dispositions:

- `create` — add a new page or a new section at the planned path
- `update` — change only the content required by the approved request
- `retain` — keep the page at its current path without content change
- `move` — relocate with a compatibility action
- `merge` — combine sources into one target
- `split` — divide one source into several targets
- `revise-with-evidence` — rewrite only with approved sources
- `deprecate-with-rationale` — keep a documented retirement path
- `out-of-scope` — named exclusion; do not infer deletion from a missing row

The map is complete only when every in-scope source block, route, inbound
reference, asset, include, and navigation entry has a target or an approved
exclusion. Do not infer deletion from a missing target.

Explicit user and workflow requirements are preservation obligations even when
they do not appear in a model-proposed inventory. Record each obligation once
with a stable ID, immutable base revision or tree digest, exact base locator,
required reader entry points, approved destination or compatibility action,
and its planned check. A repository path identifies a checked-in file. A
published route identifies a reader-facing address derived from navigation.
Keep both when they apply; one does not prove the other.

## Create

Freeze the new page, coherent page set, or new section:

- destination path for each page, including any new family folder
- an exact host-bound new page under an admitted documentation root, even when
  the root or a family folder does not exist yet; that absence alone is not
  scope ambiguity
- one topic and one Diataxis content type per page
- purpose of each page and why it belongs in that TOC node
- source map
- navigation or index updates required so the new pages are reachable
- pages that must not be created because they are not applicable

Do not force-create a page because it appears in the table of contents. The
TOC is structure guidance. Mark inapplicable nodes `out-of-scope`. Do not
scaffold empty optional families. A new section is allowed only when the
request needs that family and the overlay shows it is missing.

A new documentation set always includes a Release Notes page as the last page
of the About family. Refer to the "New documentation set" rule in
[canonical-ia.md](canonical-ia.md).

If the planned content for one destination would mix topics or Diataxis
types, or would exceed 500 lines, freeze several `create` rows instead of
one mixed or long page. Place those rows in TOC family order.

## Update

Freeze the smallest existing page set that matches the requested change:

- in-scope paths and the required change on each
- out-of-scope paths that must stay untouched
- do not relocate, split, or merge during a bounded update

A mixed-purpose page or a page exceeding 500 lines can warrant a separate
structural recommendation. It does not authorize a split or change the mode.
Complete the requested update when it fits the approved scope. If a new page,
move, or split is necessary to satisfy the request, return `needs-input` with
the required scope change before writing. The host must select and bind the
appropriate operation before planning those mutations.

## Restructure

Freeze a complete source-to-target map before any write step:

- every source path and anchor
- target path and anchor
- disposition from the list above (`create` is allowed for true new pages)
- redirect or compatibility action
- validation still required
- navigation or index entries for every created, moved, merged, or split page

Keeping a navigation file keeps the file and every existing entry; the new
or receiving pages still get entries. The host admits the docs-root index
(`index.md`, `README.md`, or `index.mdx`) beside those pages as a navigation
companion when the write grant covers it, so do not list that index as
`retain` to keep it. A navigation configuration file such as `mkdocs.yml`,
`fern/docs.yml`, `_toc.yml`, a sidebars file, or `conf.py` is never a
companion; name the entries it needs in the planner summary instead.

For every mutating page, add its immutable base source locators to that page's
existing `sourceBindings[].sources` list. Return the complete preservation map
in the planner summary, with each row naming its affected page. The workflow
host retains the summary and supplies its sealed step identity to consumers;
no separate map artifact or pre-existing map locator is required. The map
remains outside the content-free `DocumentationPlanBindingV1`.
The map is incomplete if an explicit requirement
is absent, if a shared source is used to discharge different page-specific
requirements without entry-point evidence, or if a route is represented only
by a repository path.

If completing any obligation requires another page or published route, do not
add it to the page set. Return the existing planner stop before writing:

```json
{"summary":"Preservation obligation <id> requires <path-or-route> outside the approved scope.","outcome":"needs-input","reason":"ambiguous-scope"}
```

Independent preservation review consumes this map from the retained planner
summary. It checks each obligation against immutable base evidence and the
exact candidate. It does not treat writer-reported results as proof.

Propose the target tree from the canonical table of contents and the
overlay. Inspect every in-scope source page for mixed topics, mixed Diataxis
types, and line count. Split any page that mixes types or topics, or that
exceeds 500 lines, and reposition the modules in the TOC. Do not drop content
because it is duplicated or old.

## Modular page splits

When any row splits a mixed or long page, or replaces one planned mixed page
with modules, present:

- the freeze table, with rows in TOC family order (About, Get Started, Use
  Case, Reference, Troubleshooting, Resources), not in the source file's
  heading order; each row names one topic and one content type
- a TOC tree for the modularized set so reviewers can see reorder and
  reposition across the whole table of contents
- for each module: source path and heading range (or source-map slice),
  topic, content type, target path in its TOC family, and whether the
  original path remains a `concept` hub (`update` or `retain`) or is replaced
  (`move` or `deprecate-with-rationale`)

Do not force-create inapplicable families to absorb leftover sections.
