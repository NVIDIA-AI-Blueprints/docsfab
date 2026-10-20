---
name: tpl-pick
description: Recommend which NVIDIA documentation template fits a user's goal. Pick this when the user is starting a doc page and asks "which template should I use", "what template fits X", "help me choose a template", "what's the right format for Y", or otherwise sounds unsure about template choice. Returns a single template recommendation, a format (MyST/GFM/RST/MDX), and a concrete next command for `tpl-new-page` or `tpl-apply-template`. Do NOT use this when the user has already named a template (go straight to `tpl-new-page` for new pages or `tpl-apply-template` for existing pages) or only wants to validate an existing page (use `tpl-lint`).
license: Apache-2.0 AND CC-BY-4.0
tags:
  - discovery
  - templates
  - documentation
  - diataxis
triggers:
  - "::tpl-pick"
  - "::tpl"
  - "::tpl pick"
  - "::template"
  - "::tpl --version"
  - "/template"
  - "which template should I use"
  - "what template fits"
  - "help me pick a template"
  - "template for API docs"
  - "I don't know what template"
inputs:
  - content_goal: What the user wants to document (e.g., "install guide for a Python package")
  - target_audience: Who the doc is for (optional)
  - doc_platform: Documentation platform — sphinx, github, gitlab, fern (optional)
outputs:
  - recommendation: Template name + rationale
  - format_recommendation: Format variant (myst/gfm/rst/mdx) + reason
  - next_step: Ready-to-run `tpl-new-page` or `tpl-apply-template` command
related-skills:
  - tpl-new-page
  - tpl-apply-template
  - tpl-lint
suggests-before: []
suggests-after:
  - tpl-new-page
  - tpl-apply-template
metadata:
  author: nvidia-docs
  version: "1.0.0"
  time-estimate: "1-2 minutes"
  diataxis-type: reference
  requires-llm: true
  deterministic: false
execution-hints:
  readonly: true
  complexity: low
  suggested-model: fast
  parallelizable: true
  requires-codebase: false
allowed-tools: Read
---

# tpl-pick — Recommend a Template

Match a user's documentation goal to a single template and format. Output is
one concrete recommendation plus the exact command to scaffold a new page or
apply the template to an existing page.

**Key principle**: One recommendation, not a menu. If two templates compete, name the runner-up in one sentence — don't make the user choose.

---

## Step 1: Understand the goal (gather only what's missing)

You usually need three things:

1. **What** is being documented (a feature, install process, concept, etc.)
2. **Who** the audience is — only ask if the goal alone doesn't disambiguate
3. **Where** it'll be published — only ask if format matters and platform is unclear

Don't interrogate. If the user says "quickstart for NeMo Curator on GitLab Pages", you have everything. Skip to Step 2.

For the skill-assisted application workflow, also capture the target repo/path,
critical user journey, and source evidence if the user wants you to apply the
template rather than only recommend one. Use
[`../resources/template-application-workflow.md`](../resources/template-application-workflow.md)
for the full intake and handoff shape.

Shortcut form:

```text
::tpl-pick "installation guide for a Python package on GitHub"
```

Treat the remaining text as the content goal. Infer audience, platform, and
new-page vs existing-page mode when the prompt or path makes it clear; ask only
for missing inputs that change the recommendation.

---

## Step 2: Classify by Diataxis, then map to a template

The reader's intent decides the quadrant:

| Reader wants to... | Diataxis type | Template direction |
|---|---|---|
| Follow guided steps to learn | Tutorial | `quickstart`, `beginner-tutorial` |
| Accomplish a specific task | How-To | `installation`, `procedural-task` |
| Understand how/why something works | Explanation | `architecture`, `ecosystem`, `about-feature`, `conceptual` |
| Look up information | Reference | `glossary`, `features`, `prerequisites`, `release-notes` |

Then apply the goal-to-template rules:

| Goal phrase | Template |
|---|---|
| "install / setup / deploy" | `installation` |
| "quick start / first run / 5-minute intro" | `quickstart` |
| "step-by-step learning / tutorial / workshop" | `beginner-tutorial` |
| "how a feature works / what it does" | `about-feature` |
| "system architecture / component diagram" | `architecture` |
| "where this fits / integrations / alternatives" | `ecosystem` |
| "define a concept / mental model" | `conceptual` |
| "concepts collection / Core Concepts landing page" | `conceptual/overview` |
| "list all features / capabilities" | `features` |
| "prerequisites / requirements" | `prerequisites` |
| "define terms / jargon" | `glossary` |
| "what's new / changelog / release notes" | `release-notes` |
| "task-oriented workflow explanation" | `about-procedural-task` |
| "section landing page (About)" | `about/overview` |
| "section landing page (Get Started)" | `get-started/get-started-overview` |

Template catalog paths describe reusable content shapes, not required output
locations. For example, an About > Core Concepts collection uses
`conceptual/overview` for `about/core-concepts/overview.*` and
`conceptual/conceptual` for its child concept pages.

Full catalog: [`references/template-catalog.md`](references/template-catalog.md).

---

## Step 3: Pick a format

| Platform | Format | Reason |
|---|---|---|
| Sphinx + MyST | `myst` (`.md`) | Rich directives, NVIDIA Sphinx theme |
| Sphinx + RST | `rst` (`.rst`) | Existing RST sites only |
| GitHub Pages/Wiki | `gfm` (`-gfm.md`) | Renders natively |
| GitLab Pages/Wiki | `gfm` (`-gfm.md`) | Renders natively |
| Fern | `mdx` (`.mdx`) | Component-based layouts |
| Unknown | `gfm` | Most portable — survives a future platform pivot |

Detailed comparison: [`../resources/format-comparison.md`](../resources/format-comparison.md).

---

## Step 4: Present the recommendation

Use this exact shape — `tpl-new-page` and `tpl-apply-template` read this format as
a handoff:

```markdown
## Template Recommendation

**Template**: <template_name> (<diataxis_type>)
**Format**: <format> — <one-sentence reason>
**File source**: `templates/<section>/<template><suffix>`

### Why this template
<One or two sentences: the match between the goal and the template's purpose.>

### Key sections you'll fill in
- <Section 1>: <what goes here>
- <Section 2>: <what goes here>
- <Section 3>: <what goes here>

### Next step for a new page
::tpl-new-page --template=<template_type> --format=<format> --product="<Product Name>" <target_path>

### Next step for an existing page
::tpl-apply-template --template=<template_type> --format=<format> <target_path>
```

If two templates are close, name the alternative in one sentence at the bottom (`Alternative: 'X' if you want Y instead`). Don't list three options — that's not a recommendation, it's a punt.

When the user wants skill-assisted application, add:

```markdown
### Application notes
- Mode: <new-file | existing-page-patch | migration | conformance-cleanup | batch>
- Target: <repo/path or "not yet known">
- Evidence needed: <source files, commands, SME notes, or "none supplied">
- Validation to run: <tpl-lint schema plus target repo checks>
```

---

## Examples

### Example 1 — clear case
**Input**: "I need an install guide for our Python package on GitHub."
**Output**:
- Template: `installation` (How-To)
- Format: `gfm` — GitHub renders this natively
- Next: `::tpl-new-page --template=installation --format=gfm --product="<Name>" docs/getting-started/installation-guide.md`

### Example 2 — ambiguous goal, ask one clarifier
**Input**: "I want to document our new feature."
**Response**: "Is the reader trying to *learn how it works* (→ `about-feature`) or *use it for a task* (→ `procedural-task`)?" Then recommend.

### Example 3 — no fit
**Input**: "I need a runbook for on-call engineers."
**Output**: "No template fits cleanly. Closest is `procedural-task`, but you'll want to replace the section structure with incident-response phases. Want me to scaffold it as-is or sketch a custom outline?"

---

## Known gotchas

- **"Quick" ≠ `quickstart`.** A `quickstart` is for *first-run* experiences. "Quick reference for env vars" is the `environment-variables` reference, not a quickstart.
- **`architecture` vs `about-feature`.** Architecture is system-level (components, data flow). About-feature is single-feature-level. If the doc spans multiple features, architecture wins.
- **`features` (catalog) vs `about-feature` (single).** Plural is reference (a list). Singular is explanation (one feature in depth). Easy to mix up.
- **"Sphinx" alone doesn't pick a format.** Sphinx supports both MyST and RST. Ask which the site uses — wrong format means a re-scaffold.
- **Don't hallucinate template names.** If the user names a template that isn't in the catalog, say so and suggest the closest match. Linking to the catalog is better than guessing.
- **Don't pre-ask everything.** If the user gave you the goal and platform in one sentence, skip the audience question. Each unnecessary question erodes one-shot.

---

## Version mode (`::tpl --version`)

When the user runs `::tpl --version`, or asks whether they are on the latest
template library release, report pack metadata and compare when possible.

Read local version from (in order):

1. `VERSION` in the collection root (single-line semver)
2. `MANIFEST.json` → `version` (machine-readable inventory)
3. `skills/REGISTRY.json` → `version` (installed skills registry)
4. Fall back to `unknown`

To answer "am I on the latest?", compare the local version to the newest git tag
or `VERSION` on the source repository's default branch (e.g. `git ls-remote --tags`).

Individual templates carry `template-source-version` in front matter; schemas
carry `library_version`. Scaffolded pages inherit the template stamp so downstream
repos can grep for drift.

Output:

```
Template set v<version>
Skills: tpl-pick v<v>, tpl-new-page v<v>, tpl-apply-template v<v>, tpl-lint v<v>, tpl-new-site v<v>, tpl-migrate-site v<v>
Templates: 27  Schemas: 16  Formats: MyST, GFM, RST, MDX
Latest on main: v<remote> (you are up to date | behind by N releases)
```

---

## Quick reference (template → goal)

| Goal | Template | Type |
|---|---|---|
| First-run experience | `quickstart` | Tutorial |
| Install guide | `installation` | How-To |
| Guided lesson | `beginner-tutorial` | Tutorial |
| Feature explanation | `about-feature` | Explanation |
| Architecture overview | `architecture` | Explanation |
| Ecosystem positioning | `ecosystem` | Explanation |
| Conceptual topic | `conceptual` | Explanation |
| Feature catalog | `features` | Reference |
| System requirements | `prerequisites` | Reference |
| Term definitions | `glossary` | Reference |
| Changelog | `release-notes` | Reference |
