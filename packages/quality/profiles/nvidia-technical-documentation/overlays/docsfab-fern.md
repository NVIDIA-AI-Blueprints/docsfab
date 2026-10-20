# DocsFab Fern Overlay

Apply these rules in addition to the NVIDIA technical-documentation baseline
when you generate or edit DocsFab pages rendered by Fern.

## Page Titles

- Set the page title in the YAML frontmatter `title` field.
- Do not repeat the title as a Markdown H1 (`# Title`). Fern renders the
  frontmatter title as the page H1, and a Markdown H1 creates a duplicate.
- Begin the page body with introductory prose or the first H2 section.
- Treat the generic NVIDIA template-set linter's missing-Markdown-H1
  finding as a renderer-specific exception. Apply its remaining family and
  body-structure checks.

## Template Set Layouts

Keep the template set's information architecture, article type, and
required section headings. Fern components replace MyST and GFM layout
syntax. They do not replace the page type or rename required headings such
as Prerequisites, Steps, Quickstart Steps, or What's Next.

Map template-set layout syntax to Fern MDX as follows.

| Template-set intent | MyST / GFM source | Fern component |
| --- | --- | --- |
| In-page navigation cards | `grid` / `grid-item-card`, or bold-link lists | `CardGroup` and `Card` |
| Notes, warnings, and tips | `:::{note}` or `> **Note:**` | `Note`, `Warning`, `Tip`, or `Info` |
| OS or language variants | `tab-set` / `tab-item` | `Tabs` / `Tab` |
| Optional or FAQ detail | `dropdown` or `<details>` | `Accordion` / `AccordionGroup` |
| Sequential procedures | numbered lists under Steps | `Steps` / `Step` inside the existing Steps heading |
| Comparison and catalogs | Markdown tables | Keep Markdown tables |

Do not restyle a page into a different article type. A reference catalog
stays tabular. A conceptual overview keeps its explanation headings. A
how-to keeps Prerequisites, Steps, and Related.

## Component Use

Use Fern components when they make the existing section easier to scan.
Do not add decorative components that duplicate nearby prose.

### Cards

Use `CardGroup` on overview, chooser, and What's Next sections that route
readers to other pages. Keep a Markdown link in the card body so link
scanners and Git viewers still resolve the destination. Set `href` to the
published Fern path from `fern/docs.yml`, starting with `/`.

```mdx
<CardGroup cols={2}>
  <Card
    title="Use Cases"
    icon="regular map"
    href="/about/use-cases"
  >
    Decide whether DocsFab fits your documentation problem. Refer to
    [Use Cases](use-cases.md).
  </Card>
</CardGroup>
```

Do not convert feature matrices, CLI catalogs, or symptom tables into
cards. Those remain tables.

### Callouts

Use callouts for implementation boundaries, security warnings, and short
tips that readers must not miss. Prefer the named shortcuts (`Note`,
`Warning`, `Tip`, `Info`). Do not nest callouts. Do not put
prerequisites or the primary procedure inside a callout.

```mdx
<Warning title="In-development scope">
Local CLI jobs and `docsfab live-agent` have repository-tested
implementations. Automatic GitLab CI proposals remain intended.
</Warning>
```

Keep RFC 2119 keyword quotations as Markdown blockquotes. Those are
normative text, not admonitions.

### Tabs

Use tabs for mutually exclusive alternatives: create compared to update
compared to review, or command variants that the reader chooses one of.
Do not put sequential steps, prerequisites, or security warnings only
inside a tab.

### Steps

Use `Steps` for a procedure the reader must follow in order. Keep the
Template-set `## Steps` or `## Quickstart Steps` heading around the
component. Do not enable `toc` unless the step titles are the page's
actual H2 or H3 headings.

### Accordions

Use accordions for optional examples, recovery variants, or FAQ detail
that would interrupt the primary path. Do not collapse prerequisites,
warnings, or the primary procedure. When an existing heading is an
inbound anchor, set the accordion `id` to that heading slug.

## Links

Keep repository-relative Markdown links such as `[Use Cases](use-cases.md)`
in body text. Fern `Card` `href` values and other component links use the
published site path. Do not replace a working Markdown link with a
component-only destination.

## Components to Defer

Do not introduce `Button`, `Launch`, `Prompt`, `Aside`, `ScrollWalkthrough`,
endpoint snippets, or `RunnableEndpoint` on current DocsFab pages. Those
components either change the article type or assume an API reference that
this site does not publish.
