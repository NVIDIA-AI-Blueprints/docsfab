---
title: "Assess Documentation Readiness in DocsFab"
description: "Run a source-readiness or release-documentation assessment and inspect its scope-bound disposition."
status: draft
content.type: how-to
---

Run a source-readiness or release-documentation assessment and inspect its scope-bound disposition.

## Assess Documentation Readiness

Use `readiness` to assess whether agents can use the selected repository as
input to documentation work. Use `release-documentation-readiness` to assess
public documentation against the governed release rubric. Both jobs are
read-only:

```bash
docsfab run readiness --repo /absolute/path/to/repository --revision <commit>
docsfab run release-documentation-readiness --repo /absolute/path/to/repository --revision <commit>
```

Source readiness combines deterministic artifact/inventory observations with
explicit model judgments of source completeness and usability. The host checks
each judgment's run, revision, search, and context bindings. A judgment cites
the tracked file lines the model read, and the host copies their exact text
into the record, so no quote depends on the model reproducing it. A file with
credential-shaped content cannot be read for a citation.
Missing or unsupported evidence remains specific and visible; an observed
required artifact meets the presence criterion. A `ready` result is an
assessment of the declared scope, not permission to publish or release.
Rubric judgments belong to the model, so the host does not report them as
blocked local probes. If every criterion is unassessed while source material
is available, or the model made no source reads, DocsFab asks for another
bounded attempt with the source brief and evidence guidance.
The CLI and Slack result show the readiness disposition separately from
execution status, including unresolved criteria. Slack identifies the retained
assessment record; unavailable evidence never implies readiness.

Release readiness requires a valid `.docsfab.json` committed at the selected
revision. Its declared default branch binds the assessment. The run record
preserves findings, incomplete evidence, unknown human decisions, and a
non-mutating work plan. A successful assessment can still report work required
or insufficient evidence. It does not approve a release or authorize
publication.

Hosted installations use the same immutable tracked repository evidence and
structured outcomes. Operators must configure the workflow and its model
composition for the project before its authorized Slack callers can run it.
