---
title: "Audit Pages Against Templates in DocsFab"
description: "Run the deterministic template-conformance audit without a model call."
status: draft
content.type: how-to
---

Run the deterministic template-conformance audit without a model call.

## Audit Pages Against Templates

Use `audit-documentation` to check whether existing pages follow their
governed templates. The job maps each page to a template from its frontmatter
or path, then runs the structural template checks on it. It is read-only and
does not call a model, although the run still requires a configured model
profile:

```bash
docsfab run audit-documentation --repo /absolute/path/to/repository --revision <commit>
```

Add `--context-path <repository-relative-path>` to audit one page. A request
such as `docsfab do "check if my docs follow our templates"` selects the same
job.

`docsfab runs show <run-id>` reports how many pages were enumerated, checked,
passed, failed, unmapped, and refused, and lists each finding with its page and
template. A page with no confident template is reported as unmapped with a
reason; declare its template with a `template:` frontmatter key to audit it.
Most pages in a typical tree carry no template signal, so many are unmapped
until model-assisted mapping is available.
Model-judged template rules, such as the purpose of each step, are not part of
this job. For the mapping rules and the result contract, refer to
[Audit Documentation Workflow in DocsFab](../reference/workflow-contracts/audit-documentation.md).

A page with MyST directives, roles, or explicit labels maps to the MyST variant of its declared template.
