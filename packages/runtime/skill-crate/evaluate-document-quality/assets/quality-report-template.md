# Documentation quality evaluation report

## Validated result summary

Replace the object below with values copied from the validated artifacts. Keep
the field names and types unchanged so the report binding validator can compare
the report with its sources.

```json
{
  "report_contract": "docsfab-quality-report-v0.2",
  "target": {
    "paths": ["<target-path>"],
    "repository_revision": "<repository-revision>",
    "documentation_revision": "<documentation-revision>"
  },
  "profile": {
    "id": "<profile-id>",
    "version": "<profile-version>"
  },
  "evaluation": {
    "decision": "<pass|conditional-pass|fail|human-review|insufficient-evidence>",
    "confidence": 0,
    "hard_gate_failures": []
  },
  "rubric": {
    "status": "available",
    "id": "<rubric-id>",
    "dimension_scores": {},
    "total": 0,
    "threshold": 0,
    "interpretation_band": "<Green|Yellow|Red>",
    "decision": "<pass|conditional-pass|fail|human-review>",
    "confidence": 0,
    "hard_gates": {}
  },
  "validation": {
    "evaluation": "passed",
    "quality_score": "passed",
    "report_binding": "passed"
  },
  "artifact_locators": {
    "evaluation": "<evaluation.json-locator>",
    "quality_score": "<quality-score.json-locator>",
    "quality_report": "<quality-report.md-locator>"
  },
  "limitations": [],
  "retained_gap_evidence": []
}
```

When no rubric can be selected safely, replace `rubric` with
`{"status": "unavailable", "reason": "<evidence-backed reason>"}`, set the
quality-score validation status and locator to `unavailable` and `null`, and
apply the layered decision validated by
`../../quality/schemas/quality-report.schema.json`.

The host replaces `limitations` with the exact explicit Limitation rows and
produces `retained_gap_evidence` only from its verified, locked profile. Do not
infer a retained reason from wording, a dimension assessment, a profile name,
or rubric availability. Keep every technical, audience-fit, task, outcome, and
free-text limitation as its own Limitation row; the host leaves unsupported
rows unclassified.

## Findings

- `<severity>` — `<finding>` (`<evidence locator>`)

## Evidence gaps and limitations

- Evidence gap: `<required evidence that was unavailable>`
- Limitation: `<scope, method, environment, or confidence limitation>`

## Editorial goal and voice diagnostics

Use `unavailable` unless the method, inputs, result, and evidence locator are
all present. These diagnostics do not form a second overall score.

| Diagnostic | Result | Method, inputs, and evidence locator |
| --- | --- | --- |
| Correctness | `<result or unavailable>` | `<method, inputs, locator, or reason>` |
| Clarity | `<result or unavailable>` | `<method, inputs, locator, or reason>` |
| Consistency | `<result or unavailable>` | `<method, inputs, locator, or reason>` |
| Terminology | `<result or unavailable>` | `<method, inputs, locator, or reason>` |
| Tone of Voice | `<result or unavailable>` | `<method, inputs, locator, or reason>` |
| Inclusive Language | `<result or unavailable>` | `<method, inputs, locator, or reason>` |
| Scannability | `<result or unavailable>` | `<method, inputs, locator, or reason>` |
| Flesch Reading Ease | `<result or unavailable>` | `<method, inputs, locator, or reason>` |
| Informality Index | `<stiff-to-friendly result or unavailable>` | `<method, inputs, locator, or reason>` |
| Liveliness Index | `<dull-to-lively result or unavailable>` | `<method, inputs, locator, or reason>` |

## Separate evidence views

- Layered vector and cross-layer constraints: `<summary or locator>`
- Human outcomes: `<summary, locator, or unavailable>`
- Agent outcomes: `<summary, locator, or unavailable>`
- Assurance-system measures: `<summary, locator, not applicable, or unavailable>`
