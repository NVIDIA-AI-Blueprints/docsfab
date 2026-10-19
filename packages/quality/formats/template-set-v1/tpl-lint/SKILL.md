---
name: tpl-lint
description: Validate a documentation page's structure against a template schema and report what to fix. Pick this when the user says "lint this page", "validate against the template", "check doc structure", "does this match the X template", "is this page complete", or otherwise wants a structural check on an existing file. Reports errors, warnings, and info-level findings with concrete fix recommendations. Do NOT use this to create a new page (use `tpl-new-page`) or to choose a template (use `tpl-pick`). Validation alone — does not edit the file.
license: Apache-2.0 AND CC-BY-4.0
compatibility: Requires Python 3.10+, PyYAML.
tags:
  - validation
  - lint
  - templates
  - quality
triggers:
  - "::tpl-lint"
  - "::tpl lint"
  - "::tpl validate"
  - "::tpl check"
  - "/tpl-lint"
  - "validate against template"
  - "check doc structure"
  - "does my page match the template"
  - "is this page complete"
  - "lint this doc"
inputs:
  - file_path: Path to the markdown/RST file to validate
  - schema_name: Schema name to validate against (optional; auto-detected if omitted)
outputs:
  - validation_report: Structured report with errors, warnings, info, and a summary
  - recommendations: Actionable fix per finding
related-skills:
  - tpl-new-page
  - tpl-apply-template
  - tpl-pick
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
allowed-tools: Read Bash(python:*)
---

# tpl-lint — Validate a Page Against a Schema

Structural check: does this page have the headings, order, and elements its template requires? Deterministic script does the checks; you translate findings into clear fix recommendations.

**Key principle**: This skill reads, scores, and reports. It does not edit. Editing is the user's call.

---

## Step 1: Identify target file and schema

| Input | How to resolve |
|---|---|
| File | If the user named one, use it. If not, use the file currently open or last referenced in the conversation. If neither, ask. |
| Schema | If the user named one, use it. Otherwise auto-detect (Step 2). |

Shortcut forms:

```text
::tpl-lint docs/getting-started/installation-guide.mdx
::tpl-lint --schema=installation docs/getting-started/installation-guide.mdx
```

When `--schema` is omitted, run auto-detect first. If confidence is low, report
the best match and ask before treating the validation as authoritative.

---

## Step 2: Auto-detect the schema (if not specified)

```bash
python scripts/validate.py --file <path> --auto-detect
```

The detector scores the file's headings against every schema and returns the best match. If the best score is weak (the script flags this), **don't force a validation against a poor match** — surface that to the user and suggest running `tpl-pick` to figure out the right template, or scaffolding a fresh page if this one is starting from nothing.

---

## Step 3: Run the validator

```bash
python scripts/validate.py --file <path> --schema <schema_name>
```

The script emits JSON:

```json
{
  "valid": false,
  "schema": "quickstart",
  "file": "docs/get-started/quickstart.md",
  "errors": [
    {"rule": "missing_required_section", "section": "Prerequisites", "severity": "error"}
  ],
  "warnings": [
    {"rule": "wrong_section_order", "expected": "Steps before Next Steps", "severity": "warning"}
  ],
  "info": [
    {"rule": "missing_optional_section", "section": "Troubleshooting", "severity": "info"}
  ],
  "summary": {"errors": 1, "warnings": 1, "info": 1, "total": 3}
}
```

---

## Step 4: Translate findings into fixes

Each rule maps to an actionable recommendation:

| Rule | Recommendation pattern |
|---|---|
| `missing_required_section` | Add a `## <Section>` heading at the expected position. |
| `wrong_section_order` | Move `## <Section A>` before `## <Section B>`. |
| `missing_element` | Add the missing structural element (e.g., a `tab-set` under Steps). |
| `missing_optional_section` | Consider adding `## <Section>` — improves the page but not required. |
| `orphan_heading` | Add a one-sentence orienting paragraph under the heading, OR (if intentional) suppress with `<!-- lint-disable: orphan-heading -->`. |
| `long_file` | Split into `overview.md` + per-H2 child pages. Run `::tpl-migrate-site` against the parent directory for a concrete split plan. |

Recommend specifics, not patterns. "Add a `## Prerequisites` section after the intro paragraph" is better than "Add a missing section."

---

## Step 5: Report

```markdown
## Validation Report: <file>

**Schema**: <schema_name> | **Status**: <PASS / FAIL> | **Findings**: <N>

### Errors (<N>)
1. **Missing required section**: `Prerequisites` — Add a `## Prerequisites` section after the intro.

### Warnings (<N>)
1. **Wrong section order**: Steps should come before Next Steps — Reorder.

### Info (<N>)
1. **Missing optional section**: `Troubleshooting` — Consider adding for common issues.

### Action items
- [ ] Add missing `Prerequisites` section
- [ ] Reorder Steps before Next Steps
```

A **PASS** with all errors and warnings clear is a clean validation, even if `info` findings remain. Don't gate the user on info.

When lint is part of the skill-assisted application workflow, include the lint
result in the review handoff described in
[`../resources/template-application-workflow.md`](../resources/template-application-workflow.md).
If lint passes but placeholders, evidence gaps, or target-repo checks remain,
say that clearly; structural lint is not the same as merge readiness.

---

## Examples

### Example 1 — clean pass
**Input**: `validate docs/get-started/quickstart.md`
**Output**:
```
## Validation Report: docs/get-started/quickstart.md
Schema: quickstart | Status: PASS | Findings: 1 (info)
```
Page passes. One info-level suggestion: add a Troubleshooting section.

### Example 2 — schema mismatch
**Input**: `validate docs/about/architecture.md` (file is actually a feature explainer)
**Output**: Auto-detect picks `about-feature` over `architecture` with a high score. Skill explains the mismatch and validates against `about-feature`. If user insists on `architecture`, run it but warn about the score gap.

### Example 3 — orphan heading
**Input**: `## Bug Fixes\n\n- Fix #123\n- Fix #456`
**Finding**: `orphan_heading` warning on `Bug Fixes` — heading is followed directly by a list.
**Recommendation**: Either add a one-sentence intro under the heading, OR (since this is a release-notes-style listing where the heading IS the orientation) suppress with `<!-- lint-disable: orphan-heading -->`.

---

## Known gotchas

- **Auto-detect can be confidently wrong on partial pages.** A half-written page may score highest against the wrong schema. If the auto-detect confidence is low or the user disagrees, ask before forcing a validation.
- **A clean lint ≠ good docs.** Lint checks *structure*, not *content quality*. A page with all the right sections can still be useless. Don't oversell a PASS.
- **`info` findings are not failures.** Treat them as suggestions. Bombarding the user with a fix list that's 80% info is noisy and trains them to ignore the report.
- **RST files don't get the orphan-heading check.** The validator's heading parser is markdown-only. Don't promise orphan-heading enforcement on `.rst`.
- **Schema names don't always match template names.** `about-feature` template → `about-feature` schema, but `feature` is not a schema. Check the schema list with `validate.py --list`.
- **Inline `<!-- lint-disable: orphan-heading -->` is the right escape, not stripping the lint rule from the schema.** If the disable becomes common in a schema, that's a signal to update the schema's `mode: skip`, not a signal to silence per-file forever.
- **Don't edit the file as part of lint.** Even if a fix is "obvious", report it. New-file edits belong in `tpl-new-page`; existing-page fixes belong in `tpl-apply-template`. Mixing lint and edit makes diffs surprising.

---

## Available schemas

| Schema | Validates | Key required sections |
|---|---|---|
| `about-feature` | Feature pages | How It Works, Use Cases, Getting Started |
| `about-procedural-task` | Conceptual task overviews | Workflow Overview, Key Concepts |
| `architecture` | Architecture pages | Components, Data Flow; required Mermaid diagram |
| `ecosystem` | Ecosystem positioning | Product Family Overview |
| `environment-variables` | Env var reference | General Environment Variables |
| `features` | Key features catalog | Differentiators |
| `glossary` | Glossaries | Term entries (definition list format) |
| `helm-parameters` | Helm chart values reference | General Helm Chart Values |
| `installation` | Installation guides | Prerequisites, Installation Methods, Verification |
| `prerequisites` | Prerequisites pages | Hardware Requirements, Software Requirements |
| `procedural` | How-to / procedural pages | Task title (active verb) |
| `quickstart` | Quickstart pages | Prerequisites, Steps, Next Steps |
| `release-notes` | Release notes | Versioned release entry |
| `troubleshooting` | Troubleshooting pages | Issue entries (min 1) |
| `tutorial` | Beginner tutorials | Objectives, Steps, Verification |

Schema format reference: [`references/schema-spec.md`](references/schema-spec.md).

---

## Severity levels

| Severity | Meaning | Typical for |
|---|---|---|
| **error** | Page is structurally incomplete — fix required | Missing required section, duplicate H1 |
| **warning** | Page deviates from template — should fix | Wrong order, missing element, orphan heading |
| **info** | Quality suggestion — not required | Missing optional section |

Severity is set per-schema in the YAML. Override only when the schema author clearly mis-leveled a rule.

---

## Orphan-heading rule

Headings should be followed by at least one sentence of orienting prose before lists, code, sub-headings, tables, or directives. The validator flags headings whose next non-blank token is a heading, list, code fence, table, MyST/RST directive, or MDX component.

**Per-schema config** (in the YAML schema file):

```yaml
lint:
  orphan_heading:
    mode: warning           # error | warning | info | skip (default: warning)
    skip_patterns:          # optional regex allowlist on heading text
      - "^[A-Z]$"           # e.g., glossary letter sections
```

**Inline escape** for one-off cases:

```markdown
## Bug Fixes
<!-- lint-disable: orphan-heading -->

- Fix #123
- Fix #456
```

Glossary schemas ship with `mode: skip` because their entries are dictionary-style by design. RST files are exempt (parser limitation, not a policy choice).

---

## Long-file rule

Pages over ~600 lines, or with four or more substantive H2 subtrees, usually contain multiple topics fused into one file. The validator flags these so you can decompose them into an `overview.md` plus per-topic children before the page becomes unmaintainable.

**Per-schema config** (in the YAML schema file):

```yaml
lint:
  long_file:
    mode: info              # error | warning | info | skip (default: info)
    max_lines: 600          # total-line threshold
    max_h2_subtrees: 4      # number of substantive H2 subtrees
    min_subtree_lines: 80   # lines required for an H2 subtree to count
```

Either signal (total length **or** substantive subtree count) fires the rule. Reference catalogs (env vars, Helm chart values, glossary, release notes) ship with `mode: skip` — they're intentionally long.

When the rule fires, the next step is usually `::tpl-migrate-site` against the file's directory: it converts the H2 subtrees into a concrete split plan (paths, slugs, parent overview).
