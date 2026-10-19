---
title: About DocsFab Workflows
description: Find the DocsFab workflow guide for the documentation or product-knowledge task you need to complete.
status: draft
---

DocsFab workflows are task guides that you use after setup to run one
specific documentation or product-knowledge job. Each workflow keeps product
evidence, runtime execution, quality checks, and write authority explicit.
For more information, refer to [Overview of DocsFab](../about/index.md).

## Before You Choose

Complete [Install DocsFab](../get-started/installation.md) before you run a
workflow. Define one bounded product, repository revision, audience, and
documentation target. A workflow can produce evidence, a model artifact, or a
reviewable patch. It does not grant publication, deployment, or merge
authority.

To create the first page or a short set for a new product or feature, start
with the [Runner Quickstart](../get-started/runner-quickstart.md).

## Choose a Workflow

Choose the task guide for the result you need:

| Goal | Guides |
| --- | --- |
| Create, update, or restructure pages. | [Create a Documentation Set](create-documentation-set.md), [Update Beside a Change](update-documentation-beside-a-change.md), [Update a Page Set](update-documentation-set.md), [Restructure a Set](restructure-documentation-set.md) |
| Inspect existing documentation. | [Baseline Documentation Health](baseline-documentation-health.md), [Review Merge Request Impact](review-merge-request-impact.md), [Audit Templates](audit-templates.md), [Assess Readiness](assess-readiness.md) |
| Bind evidence to a job. | [Select Sources](select-sources.md), [Bind a Commit Range](bind-commit-range.md), [Bind a GitLab Change](bind-gitlab-change.md), [Bind a GitHub Change](bind-github-change.md), [Bind a Release Range](bind-release-range.md) |
| Handle a specialized update. | [Update One RST Page](update-rst-page.md), [Verify No Change](verify-no-change.md) |
| Work in a persistent conversation. | [Attach Live Evidence](attach-live-sources.md), [Edit Documentation](edit-in-live-agent.md), [Deliver a Live-Agent Patch](deliver-live-patch.md) |
| Continue stopped work. | [Supply Requested Work Products](supply-work-products.md), [Answer and Resume](answer-and-resume.md) |
| Use an activated Slack project. | [Review From Slack](review-from-slack.md), [Ask a Documentation Question](ask-from-slack.md), [Continue a Hosted Review](continue-hosted-review.md) |
| Automate or deliver a result. | [Run in CI](run-docsfab-in-ci.md), [Automatic CI Proposals](automatic-ci-proposals.md), [Delegate a Local Task](delegate-a-task.md), [Deliver a Draft MR](deliver-draft-mr.md) |
| Inspect execution evidence. | [Investigate Saved Runs](investigate-saved-runs.md), [Diagnose a Failed Run](../manage/diagnose-run.md) |

For the common execution steps, follow [Run a Documentation Workflow](run-a-documentation-workflow.md). For first-pass source selection and stops, refer to [First-Pass Knowledge](first-pass-knowledge.md). Exact stage order, fields, and authority rules remain in [Workflow Contracts](../reference/workflow-contracts/index.md).

## Gather Product Knowledge

When a documentation job stops because load-bearing product evidence is
missing, contradictory, or stale, gather and reconcile that evidence before
you resume the documentation work. Product-knowledge work does not replace a
version-bound behavior check, an accountable intent decision, or a
documentation-quality review.

Complete these stages in order when you start without a validated product
model:

1. [Run the knowledge-gathering workflow](run-knowledge-gathering-workflow.md).
2. [Conduct a product-model interview](conduct-product-model-interview.md)
   when attributable intent or participant knowledge is missing. You can skip
   the interview when registered evidence already covers the target.
3. [Reconcile source threads](reconcile-source-threads.md) and issue the next
   model version. You cannot skip reconciliation when selected source threads
   contain unresolved differences that affect the target.

Stop and preserve the open dependency when any of the following conditions apply:

- The authoritative source or exact version is unavailable.
- Retention, citation, access, or participant consent does not cover the
  proposed artifact.
- A conflict requires behavior evidence or an accountable decision that is not
  available.
- Provenance is lost, or an immutable source or model version would need to be
  overwritten.

Do not fill the gap with conversational memory or plausible prose. Keep the
affected documentation target blocked until its load-bearing evidence is
available.

## Understand the Boundaries

The two workflow groups have the following responsibilities:

- Product-knowledge workflows establish traceable inputs and readiness. They
  do not silently promote a participant statement or agent inference into
  product truth.
- Documentation workflows bind pinned inputs to a fixed runtime job and
  quality policy. They do not broaden write or delivery authority from the
  wording of a request.

For the underlying authority model, refer to
[A Result Grants No Authority](../about/core-concepts/documentation-jobs.md#a-result-grants-no-authority).
For the intended product goals these journeys serve, refer to
[Use Cases](../about/use-cases.md).
