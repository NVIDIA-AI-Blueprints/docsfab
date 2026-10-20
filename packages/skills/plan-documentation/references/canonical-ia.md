# Canonical Documentation Structure

Portable information-architecture guidance for planning. Provenance: the
NVIDIA documentation template set's recommended structure ("You should aim to
structure your documentation as follows"), inspected at upstream commit
`4c74e267a44d`.

Use this table of contents as **structure guidance**: the default shape for
where a kind of page belongs **when that page is needed**. It is not a
required page list, not a second tree to force onto an existing site, and
not a license to scaffold files.

Do **not** force-create a page, section, or family because it appears in this
table of contents. If the request, product, or maturity does not need that
node, omit it or mark it `out-of-scope`. Empty optional families are not a
planning success. Do not invent an inapplicable family.

**New documentation set:** when create mode plans a new documentation set,
with no existing documentation root or navigation, always include a Release
Notes page as the last page of the About family. Use `about/release-notes`
unless the overlay already has a release notes location, such as a top-level
`release-notes/` folder. Fill the page from release evidence: the version and
a short summary of the release. When the evidence does not establish the
version or the summary, plan the page and record each missing value as an
unresolved question. Do not ship an empty placeholder.

Do not run template-set scaffolder scripts, skill-router shortcuts, or
`::tpl-*` commands from this skill.

## Overlay the target repository

The target repository's documentation tree and navigation win.

1. Inspect the docs root, navigation (`docs.yml`, toctree, MkDocs config,
   `docs/README.md`, or equivalent), and existing folders.
2. Map those folders onto the canonical families below. Equivalent names
   count. For example, `workflows/` can be a Use Case family; a top-level
   `release-notes/` can stand beside About.
3. If a matching page or family exists, use that location.
4. If the family or page is missing, propose the canonical folder and a
   topic-slug filename.
5. Record `TBD` and stop that placement when it would invent a parallel
   information architecture, delete content, or contradict repository
   instructions.

Catalog organization is not destination IA. Templates grouped under
`conceptual/` can land under `about/core-concepts/` when that is the
reader-facing placement. Do not copy a template catalog path into the
proposed output path.

## Table of Contents

Write TOC node titles and proposed page titles in title case. The DocsFab
Writing Style Guide and the NVIDIA technical-documentation profile require
title case for headings.

Include the product name in every proposed page title, such as "Install
DocsFab". A TOC node title can omit it, such as "Install".

### About

- Overview (What, Why, How)
  - Opening paragraph that states what the product is. Do not add a heading
    such as Introduction or Overview for that paragraph.
  - Benefits (link to the product page; do not duplicate it)
  - Core Concepts (optional short summary that links to the full concepts)
  - Use Cases
  - Next Steps (link to Quickstart or the beginner tutorial)
- Core Concepts (Optional)
- Architecture Overview
- Ecosystem Overview
- Release Notes
  - Highlights
  - Support Matrix / Compatibility Updates (Optional)
  - Fixed Issues
  - Known Issues
  - Previous Releases
  - Related Topics

### Get Started

- About Get Started (Optional)
- Prerequisites
- Installation
- Configuration / Setup
- Quickstart
- Hello World or Beginner Tutorial

### Use Case (repeat for each major use case or feature area)

- About the Feature
- Conceptual Topic
- Procedural Topic (Single or Multiple)
- Basic and Advanced Tutorials
  - Workflows
  - Solutions
- Code Examples
  - Notebooks / Blueprints
  - Playbooks / Recipes

### Reference

- Architecture (how the product works under the hood; Optional)
- Support Matrix (Optional)
- API
- Environment Variables (Optional)
- Performance
- Logging / Observability (Optional)
- Utilities (Optional)
- Migration Guides (Optional)

### Troubleshooting

- Common Issues, Error Messages, and Recoveries

### Resources

- Support and FAQs
- Training (Optional)
- Glossary (Optional)
- Blogs (Optional)
- Related Products (Optional)
- Community (Optional)
- Legal (Optional; OSS notices, license agreement)

## Default folders

When the target has no existing match, propose these folders under the
repository's documentation root (often `docs/`):

| Family | Default folder | Typical pages |
| --- | --- | --- |
| About | `about/` | `overview`, `core-concepts/`, `architecture`, `ecosystem`, `release-notes` |
| Get Started | `get-started/` | `prerequisites`, `installation`, `configuration`, `quickstart`, `tutorial` |
| Use Case | `<use-case-slug>/` or `use-cases/<slug>/` | feature overview, concept, procedure, tutorial, examples |
| Reference | `reference/` | `api`, `environment-variables`, `performance`, `observability`, `migration` |
| Troubleshooting | `troubleshooting/` | symptom-led recoveries |
| Resources | `resources/` | `glossary`, `support`, `training`, `community`, `legal` |

Keep a Use Case as a repeatable section, not a single dump folder, when the
product has more than one feature area. Do not create empty optional
families.

## File names

Filenames become URLs.

- Use topic slugs: `fuzzy-deduplication.md`, not `feature.md`.
- Use hyphens, not underscores.
- Do not put product names in filenames.
- Name the file so the topic can change without renaming the URL.

## Clustering before a new section

Apply these checks before proposing a **new** folder or section. They are
smells, not hard gates. Decide explicitly whether to restructure the
proposal or accept the tree within the runtime-selected mode. An update does
not acquire restructure authority from this table.

| Check | Action |
| --- | --- |
| Three or more peer pages share the same TOC role under one parent | Propose a parent overview and move the peers under it |
| Five or more children at one node | Propose a categorization layer |
| A directory would contain exactly one child | Flatten unless siblings are expected soon |
| Sibling pages share a role and you cannot name a distinguishing axis (scope, audience, or workflow stage) | Merge or put one page above the other |
| A page mixes several topics or more than one Diataxis type | Split so each page has one topic and one content type; reposition in the TOC |
| A page exceeds 500 lines, or a planned page would | Split; a page that long almost always mixes topics or types |

Do not invent a category named Other or Misc. Prefer a flat list of two to
four peers when no real grouping exists.

## One topic and one content type

Keep each planned page to **one topic** and **one content type**.

- Topic: one task or one concept, not a bundle of features and not the whole
  product.
- Content type: exactly one of the four Diataxis categories: `concept`,
  `how-to`, `tutorial`, `reference`. Use `concept` for the explanation
  quadrant.

Apply the splitting rules below to create and restructure plans. For an
update, preserve the existing destination and bound operation; report a
structural recommendation separately. If the requested correction cannot fit
that scope, return `needs-input` before writing. Page length and mixed types
do not authorize converting an update into a restructure.

In create or restructure mode, a page that mixes topics or types is not a
valid planned destination. Split it. Then
place each module in the whole table of contents, not only next to the
original file. Count lines in the page source, including code samples and
tables. A page that already exceeds 500 lines, or a planned page that would,
must also split; length is a backstop, not a license to mix types under 500
lines.

| Content type | What the page does | Typical TOC placement |
| --- | --- | --- |
| `concept` | Explains what something is and why it matters | About; Use Case conceptual topic |
| `how-to` | Gets a reader through a specific task | Get Started procedures; Use Case procedural topic; Troubleshooting |
| `tutorial` | Teaches by walking through a learning path | Get Started quickstart or beginner tutorial; Use Case tutorials |
| `reference` | Lists facts the reader looks up | Reference; lookup pages such as a support matrix or glossary |

1. Inventory headings and topics on the source page, or in the planned source
   map. Name the topic and the content type of each block.
2. Map each module onto a table-of-contents family and node that matches its
   type. Prefer an existing match. Propose the canonical folder and a
   topic-slug filename only when that node is needed and missing.
3. Reposition modules that sit in the wrong family. Do not leave a how-to,
   tutorial, or reference on an About overview because that is where the mixed
   file started.
4. Reorder the proposed pages to follow the TOC family order: About, Get
   Started, Use Case, Reference, Troubleshooting, Resources. Within a family,
   follow the node order in this reference.
5. Keep a short `concept` hub at the original path when inbound links or
   navigation require it. The hub stays at or under 500 lines, names one
   topic, and points to the modules. It does not keep leftover how-to steps.
6. Do not force-create a TOC node only to park leftover content. Mark
   leftover inapplicable topics `out-of-scope`. If a topic has no honest TOC
   node, record `TBD` rather than inventing a Miscellaneous page.

The table of contents remains structure guidance. Splitting a mixed or long
page is not a reason to scaffold empty optional families.
