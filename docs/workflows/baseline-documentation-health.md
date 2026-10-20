---
title: Baseline Documentation Health in DocsFab
description: Run the multi-lens review-documentation job as a documentation-set baseline.
status: draft
content.type: how_to
---

As a documentation leader, you can use DocsFab to baseline health for an
existing documentation set. The catalog job is `review-documentation`. It
collects audit, lint, technical, editorial, audience, and quality evidence as
separate lenses. There is no separate baseline job, and the result is not a
single readiness score. For more information, refer to
[About DocsFab Workflows](index.md).

Audience `insufficient-evidence` still blocks a success claim. Treat that
limitation as a gap in the baseline, not as a pass.

Source updates have a separate outcome. Confirm an update from its own run and
the resulting repository revision; this review's audience or quality
limitations do not establish whether a separate update changed the source.

<a id="before-you-start"></a>

## Prerequisites

Complete the steps in [Install DocsFab](../get-started/installation.md). Use a Git repository
that contains the documentation set you want to assess. Choose the commit that
defines the baseline, and keep the run state directory available for inspection.

Run the offline readiness check and inspect the catalog:

```bash
cd /absolute/path/to/input-repository

docsfab doctor
docsfab list
docsfab plan review-documentation

export DOCSFAB_STATE_DIR='/absolute/operator/state'
```

Expected result: Doctor reports readiness for the current environment.
`docsfab list` includes `review-documentation`. It may also list
`readiness`, which checks agent readiness and is a separate workflow.
`docsfab plan` prints the fixed `review-documentation` step graph. It does not
read the target repository, run a model, or grant write authority. The
`DOCSFAB_STATE_DIR` setting keeps the run record and report in one known place.

This job is read-only. It does not edit files or open a merge request.

## Steps

Run the workflow against one selected commit, then inspect the evidence saved
for that run. The result keeps execution status, findings, and evidence limits
separate so you can choose a follow-up without treating a partial lens as a pass.

<Steps>
  <Step title="Pin the baseline revision">
    From the input repository, capture the full commit ID that defines the
    baseline. Replace `HEAD` with the intended commit or ref if you want to
    assess another revision.

    ```bash
    cd /absolute/path/to/input-repository
    export BASELINE_REVISION="$(git rev-parse --verify 'HEAD^{commit}')"
    ```

    Expected result: `BASELINE_REVISION` identifies the commit that the run
    will inspect. DocsFab exports tracked files from that commit, so uncommitted
    changes are not part of the baseline. The run record stores the resolved
    commit for later comparison.
  </Step>
  <Step title="Run the comprehensive review">
    Run the comprehensive review with no named page targets so the scope
    stays the full documentation set. Pass the recorded commit explicitly.

    ```bash
    docsfab run review-documentation \
      --repo /absolute/path/to/input-repository \
      --revision "$BASELINE_REVISION"
    ```

    Expected result: The workflow runs its read-only review lenses against the
    selected revision. Its result includes findings, gaps, and limitations
    without a write grant. Observed source evidence remains useful when
    editorial, quality, or audience evidence is unavailable; it does not turn
    those limitations into a successful review.
  </Step>
  <Step title="Inspect the layered evidence">
    Replace `<run-id>` with the ID printed by the review. Inspect the layered
    evidence instead of collapsing it into one score.

    ```bash
    docsfab runs show <run-id> --state-dir "$DOCSFAB_STATE_DIR"
    docsfab runs show <run-id> --json --state-dir "$DOCSFAB_STATE_DIR"
    ```

    Expected result: Execution status, product disposition, review findings,
    quality limitations, and audience evidence remain separate fields. Inspect
    `evaluation.json` for the quality vector and findings, and
    `quality-report.md` for the human report, validated summary, and artifact
    locators. `quality-score.json` is optional and applies only to a safely
    selected content-type rubric. A missing score does not invalidate a
    separately validated layered evaluation.

    These are runtime-retained artifacts addressed by logical locators, not
    necessarily files written into the repository under review. Schema and
    cross-artifact checks establish consistency and provenance, not technical
    truth. Refer to [Evaluate Document Quality Skill in DocsFab](../reference/quality/skills/assess-and-evaluate/evaluate-document-quality.md)
    and [Reading a Result](../about/core-concepts/documentation-quality.md#reading-a-result).
  </Step>
  <Step title="Serve the retained HTML report">
    If the run summary says an HTML report is available, serve it from the same
    state directory when you need to read the evaluator Markdown as a page.

    ```bash
    docsfab reports serve --state-dir "$DOCSFAB_STATE_DIR" --port 8787
    ```

    Expected result: An available report loads at `/reports/<run-id>/`.
    Serving the report does not publish documentation or grant merge authority.
  </Step>
  <Step title="Decide the next bounded job">
    Decide the next bounded job from the lenses, not from a composite score.
    Use [Update Documentation Beside a Change in DocsFab](update-documentation-beside-a-change.md)
    for a documented defect. Use
    [Gather Product Knowledge](index.md#gather-product-knowledge) when
    load-bearing product evidence is missing.

    Expected result: The follow-up request names one outcome and keeps write
    authority explicit. Use `docsfab list` to confirm the current workflow
    catalog before selecting a separate restructuring workflow.
  </Step>
</Steps>

## Audience Evidence

Audience understanding is one lens inside `review-documentation`. It is not
a sixth catalog job.

The audience step tests the frozen candidate only when the run supplies an
immutable target identity, an authoritative reference model, a versioned
scenario corpus and oracle, a representative participant, independence, a
retention boundary, and run authority. If a prerequisite is missing, no
participant attempt runs; the step returns `insufficient-evidence`. The
participant does not receive author or reviewer context, expected answers,
the scoring oracle, or prior evaluation results.

Without those inputs, the step returns `insufficient-evidence` and names the
missing prerequisites. That result remains visible on the baseline. It does
not become editorial approval, release readiness, or a passing audience
check. Human or agent audience outcomes emitted by the model remain
`model-claimed-only` even when their envelope passed host validation. Create
and update outcomes also remain `insufficient-evidence` until a separately
host-validated governed campaign supplies the required semantic validation
receipt. A structurally complete audience record does not clear this gap.

An authoring workflow can record an editorial update while audience evidence
remains insufficient. Read those outcomes separately. Inspect the authoring
run's change evidence to confirm what it produced. With `--patch-only`, DocsFab
retains a patch without applying it to the source checkout. A retained patch
does not prove that files changed in the checkout.

Missing audience evidence on this baseline is the same kind of gap. Record
it. Do not treat the rest of the review as a complete health claim.

## Troubleshooting

If doctor reports blocked readiness, follow the printed next command. Refer
to
[Doctor Reports Blocked Readiness](../troubleshooting.md#doctor-reports-blocked-readiness).

If the HTML report is unreachable, keep `docsfab reports serve` running from
the same state directory used for the run. Confirm that `DOCSFAB_STATE_DIR`
or the `--state-dir` value points to that directory. Refer to
[The Review Report Page Does Not Load](../troubleshooting.md#the-review-report-page-does-not-load).

If you are looking for a `baseline` catalog job, no workflow has that name.
Use `review-documentation` for a documentation-set baseline. `readiness` is a
separate catalog workflow for checking agent readiness. Run `docsfab list` to
confirm the current catalog.

If audience evidence is missing, do not rerun the unchanged review as a
repair. Supply the required corpus, oracle, independence, and authority, or
keep the `insufficient-evidence` limitation.

## Related

Use these references to interpret the review lenses, choose a follow-up, and
troubleshoot the run.

<CardGroup cols={2}>
  <Card
    title="Review Documentation Contract"
    href="/reference/workflow-contracts/review-documentation"
  >
    [Review Documentation Contract](../reference/workflow-contracts/review-documentation.md)
  </Card>
  <Card
    title="Review Merge Request Impact in DocsFab"
    href="/workflows/review-merge-request-impact"
  >
    [Review Merge Request Impact in DocsFab](review-merge-request-impact.md)
  </Card>
  <Card
    title="Test Audience Understanding Skill in DocsFab"
    href="/reference/quality/skills/assess-and-evaluate/test-audience-understanding"
  >
    [Test Audience Understanding Skill in DocsFab](../reference/quality/skills/assess-and-evaluate/test-audience-understanding.md)
  </Card>
  <Card
    title="Evidence Before Drafting"
    href="/about/core-concepts/documentation-quality"
  >
    [Evidence Before Drafting](../about/core-concepts/documentation-quality.md#evidence-before-drafting)
  </Card>
  <Card
    title="Use Cases"
    href="/about/use-cases"
  >
    [Use Cases](../about/use-cases.md)
  </Card>
  <Card
    title="Run a Documentation Workflow in DocsFab"
    href="/workflows/run-a-documentation-workflow"
  >
    [Run a Documentation Workflow in DocsFab](run-a-documentation-workflow.md)
  </Card>
  <Card
    title="Troubleshooting DocsFab"
    href="/troubleshooting"
  >
    [Troubleshooting DocsFab](../troubleshooting.md)
  </Card>
</CardGroup>
