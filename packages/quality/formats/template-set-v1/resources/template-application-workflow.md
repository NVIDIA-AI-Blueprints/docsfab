# Skill-Assisted Template Application Workflow

Use this workflow when an agent helps an author choose, apply, validate, and
report on template-set usage. It is the skill-assisted branch of "Getting
Started With The Templates."

## Workflow Summary

1. Intake: capture author intent, reader persona, critical user journey, target
   repo/path, source evidence, and review surface.
2. Pick: recommend one template and one format, with a short rationale and a
   runner-up only when it meaningfully changes the page shape.
3. Apply: use `tpl-new-page` for a new file or `tpl-apply-template` for an
   existing file without silently overwriting authored content.
4. Fill: replace placeholders only from supplied or verified evidence; mark
   unknowns as evidence gaps.
5. Validate: run scaffold checks, template lint, repo docs checks, and any local
   frontmatter/link checks available in the target repo.
6. Handoff: produce a review summary with template, evidence, validation, gaps,
   and template-set feedback. If the review needs before/after HTML or an
   existing-page update-value report, generate it with `tpl-quality-report`.

## Intake Fields

Capture these fields before applying a template. Ask only for missing fields
that change the template, format, output path, or overwrite risk.

| Field | Why It Matters |
| --- | --- |
| Author goal | Distinguishes new page, rewrite, migration, cleanup, or batch work. |
| Reader persona | Prevents generic pages; shapes assumptions and depth. |
| Critical user journey | Routes tutorial/how-to/reference/explanation decisions. |
| Target repo and path | Determines format, validation commands, and overwrite risk. |
| Source evidence | Keeps generated content grounded in code, docs, SME notes, or tickets. |
| Review surface | Shapes the handoff: MR, issue comment, Google Doc, or local patch. |

## Safe Apply Modes

| Mode | Use When | Guardrail |
| --- | --- | --- |
| New file | Target path does not exist. | Create from template and report remaining placeholders. |
| Existing-page patch | Target path exists and should keep authored content. | Show a diff-shaped plan before rewriting sections. |
| Migration | Existing page is in the wrong template or format. | Preserve facts, source links, and review history; avoid URL-breaking moves unless requested. |
| Conformance cleanup | Page mostly fits but drifts from the template. | Make the smallest structural changes and report remaining content gaps. |
| Batch apply | Multiple pages need templates. | Use a per-page status table; do not hide individual failures in aggregate status. |

If an edit would overwrite existing authored content, switch to
`tpl-apply-template`, stop for explicit confirmation, or propose a non-conflicting
output path.

## Evidence Rules

- Use only supplied source material, target repo files, verified commands, and
  explicitly cited references.
- Do not invent versions, flags, defaults, supported platforms, limits, or API
  names.
- Replace a placeholder only when the evidence supports it.
- Keep unresolved facts as `TODO:` or in an `Assumptions / Evidence Gaps`
  section.
- Record evidence at section granularity when the page contains technical facts.

## Validation Stack

Run the narrowest available checks in this order:

1. Scaffold/script output: confirm template, format, replaced placeholders, and
   remaining placeholders.
2. Template lint: run `tpl-lint` with the matching schema when available.
3. Repo checks: run docs build, link checker, frontmatter checker, or local
   validation commands discovered in the target repo.
4. Manual review: inspect remaining TODOs, evidence gaps, links, commands, and
   examples.

Unexpected validation failures are errors. Do not mark the handoff ready while a
required check is red or unrun without explanation.

## Review Handoff

Use this shape for MR descriptions, review comments, or final handoffs:

```markdown
## Template Application Summary

- Template: `<template>` (`<format>`)
- Target: `<path>`
- Mode: `<new-file | existing-page-patch | migration | conformance-cleanup | batch>`
- Reader persona / CUJ: `<persona>` / `<journey>`

## Evidence Checked

- `<source or command>`: `<what it supports>`

## Validation

- `<command>`: `<result>`

## Optional HTML Report

- `<tpl-quality-report output path>`: template compliance and information
  quality report, if generated.

## Remaining Gaps

- `<gap>`: `<owner or next action>`

## Template Set Feedback

- `<missing template | confusing guidance | repeated local patch | none>`
```

For batch work, include this status table:

| Target | Template | Mode | Validation | Evidence Gaps | Next Action |
| --- | --- | --- | --- | --- | --- |
| `<path>` | `<template>` | `<mode>` | `<pass/fail/not run>` | `<gap or none>` | `<action>` |
