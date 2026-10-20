---
title: "DocsFab Review JSON Result Reference"
description: "Look up the machine-readable review result, report artifacts, and retained evidence boundaries."
status: draft
content.type: reference
---

Look up the machine-readable review result, report artifacts, and retained evidence boundaries.

## Consume the JSON Result

Outer agents and continuous integration wrappers must run the workflow with
`--json` and consume the single JSON object on stdout. Do not scrape the human
footer or skill Markdown.

```bash
docsfab run review-documentation \
  --repo /absolute/path/to/repository \
  --revision <revision> \
  --json
```

When a run record exists, the outer envelope remains
`schemaVersion: 1` and `kind: "docsfab-run-result"`. This remains true when a
projected string exceeds 512 characters and is truncated. Inspect the quality
limitations to detect that truncation.

Use `product.findings` for workflow outcome codes such as `review-required`.
Use the root `reviewFindings` array for actionable
`ReviewFindingV1` objects. Each object contains `id`, `severity`, `code`,
`summary`, and a relative `path` or `null`. It can also contain `line`,
`origin`, `evidence`, and `recommendation`. Findings lifted from admitted
sealed review skills use `origin: "agent"` and include evidence and a
recommendation. Current `review-documentation` results always include
`reviewFindings` and `reviewFindingsProjection`. When no findings can be safely
projected, `reviewFindings` is `[]`. Check projection availability and limitations
before interpreting that empty array as a zero-findings result. Older envelopes
can omit these additive fields.

The final validated quality evaluation keeps its source finding IDs.
Rich source locators remain in `evidence`; the projection adds a safe first
path and line only when the locator supports them. Artifact admission proves
schema and run bindings. It does not independently prove that an agent-authored
finding is factually correct.
Findings from a completed technical-verification step can remain in
`reviewFindings` when a later evaluator fails. They are retained evidence and
do not certify the overall run: execution status, quality validation, and
product disposition still report their failure or unavailability.

```json
{
  "product": {
    "findings": ["review-required"]
  },
  "reviewFindings": [
    {
      "id": "finding:review-documentation:EDIT-001:1",
      "severity": "warning",
      "code": "EDIT-001",
      "summary": "The explanation is unclear.",
      "path": "docs/guide.md",
      "line": 18,
      "origin": "agent",
      "evidence": "source-1: docs/guide.md:18",
      "recommendation": "Clarify the explanation."
    }
  ],
  "reviewFindingsProjection": {
    "projector": "docsfab-review-findings-v2",
    "availability": "partial",
    "artifactLocator": "record:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "limitations": ["review-findings-unparsed:review-documentation"]
  }
}
```

The excerpt shows the two finding surfaces. Read the complete
`docsfab-run-result` envelope for execution, quality, report, next-step, and
result-digest fields. If quality report projection fails, the envelope still
exists with `quality: null`, a `quality-projection-unavailable` product
limitation, and an actionable `nextSteps` entry.

`reviewFindingsProjection.availability` is separate from finding count and takes one of
the following values:

- `complete` means no projection limitations remain. An empty `reviewFindings`
  array is a complete zero-findings projection.
- `partial` means admitted evidence remains with projection or coverage
  limitations. The findings array can be empty. Inspect the retained report for
  the named source.
- `unavailable` means required evidence, a binding, an evaluator, an artifact,
  or a schema is unavailable.
- `invalid` means finding admission or integrity validation failed. Invalid
  findings are excluded. When independent valid findings survive another
  source's failure, availability is `partial`.

`docsfab runs show <run-id> --json` reloads the same content-addressed artifact
and produces the same findings projection and recovery action as initial
delivery. Recovery depends on the recorded state, as the
following list describes:

- When a bound artifact locator exists but the object is absent, restore the
  matching known-good record and artifact set, then replay locally.
- When the installed evaluation schema is unavailable, restore that runtime
  schema, preserve the retained bytes, and replay locally.
- When integrity or binding validation fails, recover a matching known-good set
  or fix the producer. Never edit sealed evidence to make it pass.
- When no admitted evaluation artifact was recorded, there is no artifact to
  restore or replay. The evaluation producer owner must supply validated
  evidence before findings can be projected.

A valid finding is a review result, not a transient provider failure. Inspect
the cited evidence and repair it only under a separate write grant; do not
rerun the unchanged review as the recovery step.

The human `QUALITY` section and JSON `product.limitations` also report what the
retained evidence establishes. `review-method-static-read-only` means the
recorded review steps used only the admitted read tools.
`package-command-checks-not-executed` means that record contains no package
command execution; passing artifact validators does not establish package
checks. When a native host-operation summary does not carry typed command
execution evidence, both the review method and package-check disposition remain
`not-established`; DocsFab preserves the summary but does not scrape its JSON or
prose into evidence authority. A typed native-check projection remains future
work. Human or agent audience outcomes emitted by the model remain
`model-claimed-only` even when their envelope passed host validation. An empty
audience outcome is `unavailable`, not a successful audience check.
`review-findings-human-review:<skill>` preserves an admitted source verdict
that requires human review. A
`review-findings-coverage-unverified:<skill>:<path>` limitation identifies each
safe target path whose technical coverage was explicitly unverified. Either
limitation keeps an empty findings array partial rather than turning missing
evidence into a zero-findings result.
When the evaluator explicitly closes a complete findings set without any
admitted findings, DocsFab records `evaluation.findings` as `[]` and does not
create placeholder findings.
Current retained technical inventories must remain canonical, schema-valid, and
covered by the frozen review scope or the succeeded authoring plan. An invalid
or missing current authoring plan binding cannot widen admission. Historical records with no current
inventory remain recoverable, but carry an explicit inventory-unavailable
limitation and therefore cannot establish complete findings availability.
