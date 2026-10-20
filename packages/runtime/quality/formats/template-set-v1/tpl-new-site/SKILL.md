---
name: tpl-new-site
description: Bootstrap a complete documentation site directory tree from NVIDIA's canonical information architecture. Pick this when the user says "bootstrap a doc site", "scaffold a whole documentation site", "set up docs for a new product", "create site structure", "generate full site from scratch", "init a new docs project", or otherwise wants more than one page produced. Generates About/Get Started/Reference/Troubleshooting/Resources sections with placeholder-filled pages, optionally adds per-feature sections. Do NOT use this for a single page (use `tpl-new-page`) or to migrate an existing site (use `tpl-migrate-site`).
license: Apache-2.0 AND CC-BY-4.0
compatibility: Requires Python 3.10+, PyYAML.
tags:
  - creation
  - scaffold
  - site
  - ia
  - documentation
triggers:
  - "::tpl-new-site"
  - "::tpl site"
  - "::tpl new-site"
  - "::site"
  - "bootstrap a doc site"
  - "create site structure"
  - "scaffold full documentation"
  - "set up docs for a new product"
  - "init a new docs project"
  - "generate complete site"
inputs:
  - name: product_name
    type: string
    required: true
    description: Product name for placeholder replacement
  - name: format
    type: enum
    required: true
    options: [myst, gfm, rst, mdx]
    description: Output format variant
  - name: output_path
    type: path
    required: true
    description: Root directory for the generated site
  - name: include_optional
    type: boolean
    required: false
    default: false
    description: Include optional sections (architecture, ecosystem, training, etc.)
  - name: use_cases
    type: list[string]
    required: false
    description: Feature areas that get their own repeatable sections
outputs:
  - name: site_directory
    type: directory
    description: Complete doc site directory tree with scaffolded pages
  - name: summary
    type: json
    description: JSON report of pages created, errors, and placeholder counts
related-skills:
  - tpl-new-page
  - tpl-pick
  - tpl-lint
suggests-before:
  - tpl-pick
suggests-after:
  - tpl-lint
metadata:
  author: nvidia-docs
  version: "1.0.0"
  time-estimate: "5-10 minutes"
  diataxis-type: how-to
  requires-llm: true
  deterministic: false
execution-hints:
  readonly: false
  complexity: medium
  suggested-model: fast
  parallelizable: true
  requires-codebase: false
allowed-tools: Read Write Bash(python:*)
---

# tpl-new-site — Bootstrap a Full Documentation Site

Generate the complete canonical IA as scaffolded pages: About, Get Started, Reference, Troubleshooting, Resources, plus per-feature sections if the user names them. Output is a directory tree of pages ready for content.

**Key principle**: Cluster the IA *before* writing files. Restructuring after the fact breaks URLs, links, and bookmarks — fixing IA at file-creation time is free.

Shortcut form:

```text
::tpl-new-site --product="NVIDIA NeMo Guardrails library" --format=mdx docs/
```

When the command includes product, format, and output path, build the proposed
site map and confirm it before generating files. If `--format` is omitted,
infer it from repo or platform context when possible; otherwise ask before
generating files.

---

## Step 1: Gather inputs

Confirm with the user:

1. **product_name** (required) — used for placeholder replacement
2. **format** (required) — `myst`, `gfm`, `rst`, or `mdx`
3. **output_path** (required) — where to create the site
4. **Optional sections** — ask whether to include architecture, ecosystem, training, etc. Defaults to no.
5. **Use cases** — ask whether there are specific feature areas to scaffold per-feature sections for

If the user is vague ("just make me a docs site"), confirm format and at least one use case before generating — running with defaults produces a generic tree that they'll have to restructure later.

---

## Catalog paths are not IA paths

The template catalog groups reusable page shapes by content type. The generated
site tree places those pages where readers expect them. Do not infer an output
path from the template's location in this repository.

For an About > Core Concepts section:

| IA destination | Template selector | Catalog source |
|---|---|---|
| `about/core-concepts/overview.*` | `concepts-overview` | `conceptual/overview` |
| `about/core-concepts/<topic>.*` | `conceptual` | `conceptual/conceptual` |

The `templates/about/core-concepts/` collection does not exist. Core Concepts is
an information-architecture placement assembled from the top-level Conceptual
template collection.

---

## Step 2: Cluster before scaffolding

Walk the proposed tree (canonical site map + user's use cases + optional sections) and apply these IA heuristics before any file is written.

| Heuristic | Why it matters |
|---|---|
| **≥3 peers sharing a `content_type`** → promote to a sub-overview | Three explanation pages as siblings of unrelated content read as a list, not navigation. A parent `overview.md` lets leaves shrink to specifics. |
| **≥5 children at any node** → introduce a categorization layer | Past five, readers stop scanning and start searching. Splitting forces you to name the categories, which usually surfaces a missing concept. |
| **Single-child directory** → flatten | A folder containing one file adds path length for no information gain. Keep it only if siblings are reasonably expected soon. |
| **Same-quadrant peers without a distinguishing axis** → merge or hierarchy | Two siblings tagged `explanation` under one parent should differ by scope, audience, or workflow stage. If you can't name the axis, they want to merge. |
| **Filenames must be topic slugs** | `fuzzy-deduplication.md`, not `feature.md`. The scaffold script enforces this. |

Show the user the proposed tree and any restructurings you applied. **Confirm before generating** — IA changes after the fact are expensive (URLs, links, reader bookmarks).

Pattern catalog (hub-and-spoke, parent-index-with-leaves, workflow-staged, faceted reference, when to flatten): [`references/ia-clustering.md`](references/ia-clustering.md).

---

## Step 3: Preview the site map

```bash
python skills/tpl-new-site/scripts/site-scaffold.py --list
```

This prints the canonical IA without generating files. Use it to confirm the structure with the user before committing.

---

## Step 4: Generate

```bash
python skills/tpl-new-site/scripts/site-scaffold.py \
  --product "<Product Name>" \
  --format <myst|gfm|rst|mdx> \
  --output <path> \
  [--include-optional] \
  [--use-cases "Case1,Case2"]
```

---

## Step 5: Report

Present the JSON summary:

- Pages created vs. errored
- Templates unavailable for the chosen format (some are MyST-only, etc.)
- Placeholder counts that need content authoring (typically high — that's normal for a fresh site)

---

## Step 6: Suggest next steps

In rough priority order:

1. Fill the Overview page first — it sets the tone and is usually the most-trafficked page.
2. Complete Get Started pages (Prerequisites → Installation → Quickstart). Highest user traffic, fastest validation of the whole site.
3. Run `tpl-lint` per page as content is added — catch structural drift early.
4. Use `tpl-pick` + `tpl-new-page` to add pages outside the canonical IA.

---

## Examples

### Example 1 — straightforward bootstrap
**Input**: "Bootstrap docs for NeMo Curator at `docs/` in GFM. Use cases: 'Data Deduplication' and 'Quality Filtering'."
**Action**: Preview site map → confirm two use-case sections under `/use-cases/` → run scaffold → report 28 pages created, 0 errors, ~80 placeholders across all pages.

### Example 2 — clustering catches a problem
**Input**: "Bootstrap docs at `docs/`, use cases: 'Connectors', 'Pipelines', 'Models', 'Monitoring'."
**Cluster check**: Four use cases sit cleanly under `/use-cases/`. But if "Connectors" itself has 6 sub-features named, that triggers the ≥5 rule — propose a sub-overview at `/use-cases/connectors/overview.md` grouping them by connector type before scaffolding.
**Action**: Show the restructured tree, get confirmation, then scaffold.

### Example 3 — vague request
**Input**: "Make me docs for my new project."
**Response**: "Before I generate the tree — what's the product name, which format (gfm/myst/rst), and are there any specific feature areas I should scaffold sections for? If you skip use cases I'll generate just the canonical sections, but you'll likely want to add some afterward."

---

## Known gotchas

- **Don't skip clustering.** Cleaning up an IA after files exist breaks URLs and reader bookmarks. The two minutes spent on Step 2 is the cheapest review of the whole project.
- **Some templates are format-specific.** Not every template ships in MDX or RST. The site scaffold script will skip those silently in the summary — read the "templates unavailable" list and decide if it matters before declaring success.
- **`--include-optional` adds noise on small sites.** On a five-page book, "ecosystem" and "training" sections produce mostly empty pages. Default to off; opt in only when the project actually has those concerns.
- **`use_cases` get full per-feature sub-trees.** Each use case spawns a feature page, concept page, procedure, and tutorial. Don't pass ten use cases unless the team really plans to write 40 pages.
- **Output path collisions are silent.** Running the script over an existing directory will overwrite scaffolded pages. Confirm the path is empty (or the user is fine clobbering) before running.
- **Product-name placeholder is the same script as `tpl-new-page`.** If the user wants different products in different sections (rare), don't try to do it in one run — scaffold the site for the primary product, then `tpl-new-page` the per-product pages individually.
- **The canonical IA is opinionated.** It assumes a product-doc shape. Internal team handbooks, runbooks, and incident docs don't fit — push back and suggest a custom structure instead of forcing the canonical tree.

---

## Canonical site structure

| Section | Required | Purpose |
|---|---|---|
| **About** | Yes | Product overview, optional Core Concepts, architecture, ecosystem, release notes |
| **Get Started** | Yes | Prerequisites, installation, quickstart, tutorial |
| **[Use Case]** | No | Repeatable per feature area: feature topic, concepts, procedures, tutorials |
| **Reference** | Yes | API, environment variables, Helm Chart Values, observability, performance |
| **Troubleshooting** | Yes | Common issues and solutions |
| **Resources** | Yes | Glossary, support, training, community, legal |

Full site map: [`assets/site-map.yaml`](assets/site-map.yaml).

---

## Format selection

| Format | Platform | When |
|---|---|---|
| `myst` | Sphinx + MyST | Rich layout, cross-references, NVIDIA Sphinx theme |
| `gfm` | GitLab / GitHub | Maximum portability, no extensions needed |
| `rst` | Sphinx RST | Existing RST sites, full directive ecosystem |
| `mdx` | Fern | Component-based layouts |
