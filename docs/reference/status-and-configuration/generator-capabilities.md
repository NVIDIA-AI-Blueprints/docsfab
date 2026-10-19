---
title: "Documentation Generator Capabilities in DocsFab"
description: "Look up the supported structural observations and validation limitations for each documentation generator."
status: draft
content.type: reference
---

Look up the supported structural observations and validation limitations for each documentation generator.

## Generator Capability Matrix

Doctor identifies generator configuration paths tracked at the repository's
exact `HEAD` and prints the corresponding installed registry states. When no
generator configuration is tracked but Markdown or MDX is tracked, it reports
`plain-markdown`. An inventoried generator without an adapter, such as
VitePress, is named with `Adapter: unavailable`. This section is informational:
the workflow derives source applicability from its exact candidate tree and
changed paths before validation. A detected filename does not grant an adapter
or authorize a write.

The following table lists the installed registry states. `partial` requires
you to keep the named limitation; `unsupported` does not qualify that
operation.

| Generator | Detect | Navigation | Routes | Versions | Includes | Components | Frontmatter | Validate |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Plain Markdown | supported | not-applicable | not-applicable | not-applicable | not-applicable | partial | not-applicable | supported |
| MkDocs | supported | partial | unsupported | unsupported | unsupported | not-applicable | unsupported | supported |
| Docusaurus | supported | partial | partial | unsupported | unsupported | partial | partial | supported |
| Sphinx | supported | partial | unsupported | unsupported | partial | unsupported | unsupported | supported |
| Fern | supported | supported | supported | supported | partial | partial | partial | supported |
| Jupyter Book | supported | partial | unsupported | unsupported | unsupported | unsupported | unsupported | partial |

Docusaurus navigation observation reads `sidebars.json`, but it does not
execute JavaScript or TypeScript sidebars or interpret `Tabs` and `TabItem`.
Sphinx structural source support does not validate rendered HTML routes.
Jupyter Book validation falls back to plain Markdown checks and reports
`navigation-not-checked` for its table of contents. For the write scope,
configure the committed [`documentationRoots`](project-configuration.md#project-configuration)
list; detection alone does not widen those roots.

## Navigation Evidence

The repository observation keeps document discovery, readable text, structured
navigation, and link validation as separate evidence classes. A tracked file
can appear in the document inventory without establishing that the site
publishes it at a route.

The runtime reads the following bounded navigation sources from the selected tracked
revision:

- MkDocs `mkdocs.yml` and `mkdocs.yaml` files
- Jupyter Book `_toc.yml` and `_toc.yaml` files
- Docusaurus `sidebars.json` files
- A versioned Fern index rooted at `fern/docs.yml`

Each adapter validates its referenced tracked targets before it contributes
navigation evidence. A valid adapter can supply navigation evidence while an
unrelated Markdown link defect leaves the global content index incomplete. The
result retains that global failure as separate evidence. Missing targets,
unsafe paths, malformed source data, unsupported syntax, and exhausted budgets
produce explicit limitations.

Executable Docusaurus sidebars such as `sidebars.js` and `sidebars.ts` remain
unsupported because the runtime does not execute repository code during
observation; the content index continues without that navigation, and
`docsfab run` and `docsfab do` name each one in a content index notice. Discovering Markdown, MDX, reStructuredText, HTML, PDF, or a site
configuration does not by itself provide structured navigation or route
validation. The workflow does not claim support for arbitrary source roots or
remote documentation platforms.

The source adapter registry reports Docusaurus navigation, routes, components,
and frontmatter as partial. It does not interpret `Tabs` or `TabItem` behavior.
Sphinx HTML routes remain unsupported. Jupyter Book validation checks plain
Markdown links and folders but does not check its table of contents. Run
`docsfab doctor --repo <path>` to inspect the installed capability states for
the repository's tracked generator configuration.
