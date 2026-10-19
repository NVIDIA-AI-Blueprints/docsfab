---
title: Evaluate Document Quality Skill in DocsFab
description: Apply layered evidence, selected rubrics, and hard gates without editing the document.
status: in-development
---

The DocsFab `evaluate-document-quality` skill reconciles
trustworthy-information, transferable- understanding, effective-experience, and
cross-layer constraint evidence. It produces inspectable quality artifacts
separately from workflow execution status. Refer to [Documentation Quality in
DocsFab](../../../../about/core-concepts/documentation-quality.md) for the
broader evaluation strategy. For more information, refer to [Assessment and
Evaluation Skills in DocsFab](index.md).

## Contract at a Glance

| Field | Contract |
| --- | --- |
| Mode | Read-only, terminal evidence reconciliation |
| Runtime binding | Final step in `review-documentation`, `create-documentation`, `update-documentation`, and `restructure-documentation` |
| Primary output | Layered quality evidence, disposition, limitations, and evidence locators |
| Hard-gate rule | A hard failure or missing required evidence cannot be averaged into a pass |

## Evaluation Evidence

The evaluator freezes the target, product evidence, audiences, outcomes, risks,
profile, and evidence package. It preserves dimension results, confidence,
findings, limitations, human and agent outcomes, and missing evidence.

Hard failures take precedence. Required missing evidence returns
`insufficient-evidence` or `human-review`; it cannot be averaged away. A
release-gating evaluator must be a non-author. Legacy content-type scores can
remain evidence but cannot replace the quality vector.

When quality output validates, inspect the retained artifacts by their
runtime locators. The logical names below do not promise files written into
the documented repository.

| Artifact | What to inspect |
| --- | --- |
| `evaluation.json` | The layer and dimension vector, evidence and confidence, findings, hard-gate failures, outcomes, limitations, and overall decision. |
| `quality-score.json` (optional) | The rubric for the exact content type, its dimension scores, gates, rationale, and decision. It is neither a universal score nor a second layered verdict. If the rubric cannot be selected safely, this artifact and its locator are unavailable. |
| `quality-report.md` | The human-readable report and validated summary, including target and profile, evaluation disposition, validation state, limitations, and artifact locators. |

The runtime validates schemas, provenance, and consistency across these
artifacts. Those checks establish that the records agree and are bound to the
run; they do not establish that the evidence is technically true.

Some runs have no validated quality projection. If the evaluator's structured
result remains invalid after correction attempts, the workflow can complete
while retaining its narrative and other findings without a validated
evaluation, score, or report projection. This is not a pass; narrative does
not replace a validated evaluation.

For an UPDATE V2 assessment with an admitted editorial proposal, invalid inner
quality JSON retries within the configured correction budget. If the final
attempt still fails with `quality-envelope-json`, the host retains that
attempt's editorial proposal and reports a visible limitation. It records no
quality evaluation, report narrative, or score. Malformed outer proposals and
security, host, identity, or cancellation failures retain their refusal.
A host check that stops this final text attempt preserves the reply's usage
and attempt evidence.

For CREATE V3, a final text answer rejected with `quality-envelope-json` or
`quality-envelope-shape` retries within the configured correction budget.
After the final refusal, the workflow can complete with its patch and other
findings retained. The host records no quality evaluation, report narrative,
or score. This continuation requires the original reply and unchanged run,
target, profile, evaluator, and technical-verification bindings. It does not
apply to tool submissions, cut answers, or safety and host failures.

When the host continues without validated quality, the CLI QUALITY section
names the rejection code. The final RETRIES line distinguishes the rejected
model reply from the host continuation. A successful host callback in the
saved attempt record does not mean that the quality reply validated.

Create and update workflows evaluate the final authored candidate. The host
binds its profile, evaluation, report, and validator receipts to the exact
target and retained patch. Initial JSON, saved-run JSON, and live-agent workflow
results project the same validated quality evidence. Normal and quiet CLI
summaries display that evidence in the QUALITY section.

When an assessment has no validated quality projection, JSON results keep
`quality: null` and add one of these codes to `product.limitations`. Live-agent
workflow results expose the same code in `qualityLimitations`, and the CLI
QUALITY section names it:

| Code | Meaning |
| --- | --- |
| `quality-validation-unavailable` | The evaluator completed, but its assessment has no supported host-validated quality report binding. |
| `quality-evaluator-not-run` | No quality evaluator completed successfully. |
| `quality-envelope-json` | The final quality text could not be decoded after the configured correction attempts. For UPDATE V2, the host also retains the independently admitted editorial assessment. No quality score is recorded. |

These limitations do not change execution status or establish a quality pass.
A verified no-change assessment does not add an unavailable-quality limitation.
Inspect the initial result or the saved run with
`docsfab runs show <run-id> --json`.
An unavailable projection does not identify a missing content-type rubric;
rubric availability requires separate evidence.
An advisory evaluator message claiming that the host declined a report does not
establish a validation result.

A CLI reference needs a matching rubric for commands, options, arguments, and
exit statuses. When no matching rubric is staged, the evaluator still returns
the layered evaluation and report. The validated report names the unavailable
rubric, and its score is unavailable. Endpoint and HTTP-response requirements
from an API-reference rubric do not provide CLI-reference coverage.

The current `docsfab-documentation-quality` profile is experimental v0.1 and
has `release_gate_eligible: false`. Its outcome baselines and thresholds remain
pending calibration, so it cannot produce a release-gating pass even when
rubric scores are high. Any evidenced hard failure requires `fail`. Missing
required evidence without an established failure requires
`insufficient-evidence` or `human-review`; it does not create a failure by
itself. Conditional-pass is present in some schemas, but the current profile
disallows it. A release-gating evaluation also requires a clean non-author
evaluator; an author self-score is not independent evidence.

## Boundaries

Assurance-system measures describe process health and remain separate from a
document's quality result. The evaluator does not edit, publish, or perform SCM
changes.

## Authoritative Sources

- [Skill contract](../../../../../packages/skills/evaluate-document-quality/SKILL.md)
- [Layered evaluation](../../../../../packages/skills/evaluate-document-quality/references/layered-evaluation.md)
- [Scoring policy](../../../../../packages/skills/evaluate-document-quality/references/scoring-policy.md)
- [Assurance-system measures](../../../../../packages/skills/evaluate-document-quality/references/assurance-system-measures.md)
- [Comprehensive review binding](../../../../../packages/runtime/workflows/review-documentation.json)
- [Create workflow binding](../../../../../packages/runtime/workflows/create-documentation.json)
- [Update workflow binding](../../../../../packages/runtime/workflows/update-documentation.json)
- [Restructure workflow binding](../../../../../packages/runtime/workflows/restructure-documentation.json)
