/**
 * Hosted quality HTML report (#400).
 *
 * The evaluator authors report narrative; the host writes the v0.2 quality
 * summary from validated artifacts. Runtime projects typed fields and writes
 * a fixed HTML page. The evaluator does not author HTML or choose the URL.
 *
 * **Status:** Accepted with Task #400 (parent epic #208)
 * **Operator page:** `docs/get-started/runner-quickstart.md`
 */

## Authorship

`review-documentation` ends on `evaluate-document-quality`. The evaluator
authors the report narrative from
`packages/skills/evaluate-document-quality/assets/quality-report-template.md`.
The model-facing prompt omits the report-summary schema and JSON scaffold while
retaining the narrative sections and explicit limitation instructions. The
host validates the evaluation and optional score, checks report binding and
limitation structure, then writes the single `## Validated result summary`
block with `report_contract: "docsfab-quality-report-v0.2"` from those checked
sources.
The run record keeps this finalized Markdown as the succeeded evaluator
`summary`.

The summary's target, profile, decision, confidence, hard-gate failures,
rubric result, validation states, artifact locators, limitations, and retained
gap evidence are host-derived. The evaluator does not supply or validate a
second copy of those fields.

The evaluator's required-key instructions are projected from the verified
evaluation schema and output derivation contract. Host-written metadata and
outcomes, plus derived confidence and rule-backed decisions or totals, are left
out of the model's answer. Dimension judgments, applicability, and hard-gate
inputs remain model-authored. A layer decision is requested only when an open
layer has a residual that changes its rule-derived decision.

For admitted text and tool-call artifacts, the host fills independently owned
identity, profile, and outcome metadata before attempting semantic derivation.
It fills target metadata when the target is an object or absent, and host-owned
fields on constraint and finding records the evaluator actually supplied; it
does not invent missing constraint, dimension, or finding records. Malformed
authored values remain unchanged for the locked validator to diagnose.
Rule-derived decisions and derivation counts are added only after complete
derivation. The legacy untagged candidate path keeps its existing staging
behavior. Mismatches in its profile, model version, target scope, or repository
revision stop without a correction retry, because those fields are host-owned
and the retry must not ask the evaluator to author them.

Malformed authored constraint containers and layer entries are passed through
to the locked evaluation validator for schema-specific diagnostics. A failure
of the locked derivation remains a terminal infrastructure stop with the
closed `quality-derivation-failed` code and reason; it does not create a
validation binding or trigger a model correction retry.

`evaluation.json` is always in the evaluator contract. `quality-score.json`
exists only when exactly one content-type rubric under
`packages/quality/rubrics/` is selected. Otherwise the report marks the
score unavailable, the evaluation decision is `insufficient-evidence`, and
the score locator is `null`.

## Projection

`projectQualityReportFromRun` applies only to `review-documentation`. It
reads the last succeeded `evaluate-document-quality` summary, binds the
repository revision and optional patch digest, and returns
`QualityReportProjectionV1` (`kind: docsfab-quality-report-projection`):
decision, confidence, hard-gate failures, limitations, available rubric
score and band or an unavailable reason, report digest, and revision.

Other workflows return null. A review run with no succeeded evaluator step
also returns null. An empty evaluator summary is `missing-report`.

## Page

`renderQualityReportHtml` interpolates the projection into a fixed layout
and HTML-escapes the full evaluator Markdown into a `<pre>`. It does not
render Markdown to rich HTML and does not accept model-authored HTML. When
the Markdown exceeds 256 KiB, the header still renders and the `<pre>` body
is omitted.

On a succeeded `review-documentation` run (exit 0),
`persistHostedQualityReport` writes `reports/<run-id>/index.html` under the
operator state directory and resolves an allowlisted URL
(`/reports/<run-id>/`). Default origin is `http://127.0.0.1:8787`.
`DOCSFAB_REPORT_BASE_URL` is origin-only.

## Serving

`docsfab reports serve` is a GET-only file server over that directory.
`RunResultV1.htmlReport` and the QUALITY `Report:` line carry the URL.
`comment-existing-mr` can include optional `hostedReportUrl` on a v2 review
result; the host comment prints `report: <url>` when that field is present.
Runtime composes the URL.
