---
title: Key Features
description: Compare DocsFab capabilities by outcome, evidence state, and the guide for using them.
status: draft
content.type: reference
---

Use this catalog to compare DocsFab capabilities, their evidence states, and
where to use them. For a conceptual introduction, refer to
[Overview of DocsFab](index.md).

Evidence states describe a specific tested or implemented boundary. They do
not establish public release readiness. Refer to
[DocsFab Implementation Status](../reference/status-and-configuration/implementation-status.md)
for definitions and supporting evidence, or [Use Cases](use-cases.md) to choose
a reader journey.

## What Makes DocsFab Different

The following design principles make the result of a job inspectable.

| Design Principle | Reader Benefit |
| --- | --- |
| Grounded claims | Important claims retain their source and version bindings. A missing required product decision returns `needs-input`. |
| Catalogued work | A named `Task → Workflow → Step` sequence binds the outcome, inputs, and allowed operations. |
| Separate quality evidence | Lint, technical verification, independent review, audience evidence, and evaluation retain their own conclusions. A later check cannot erase an earlier failure. |

## Reach DocsFab

Use these surfaces to start or inspect a DocsFab job. The current product
surfaces are the direct CLI and local live agent. Automatic GitLab CI
proposals are intended. The following table distinguishes these paths.

| Feature | What It Does | Evidence State | Learn More |
| --- | --- | --- | --- |
| `docsfab run` and `docsfab do` | `run` executes a named catalog workflow. `do` classifies a natural-language sentence onto a catalog workflow, then can run it. | Repository-tested | [Workflow Quickstart](../get-started/runner-quickstart.md) |
| Local `docsfab live-agent` | Starts or resumes a persistent local conversation. Documentation writes are enabled by default. `--read-only` disables edits, workflow writes, and host commands. | Repository-tested | [Live Agent Quickstart](../get-started/live-agent-quickstart.md) |
| Automatic GitLab CI proposals | Intended path: a repository CI event starts a revision-bound job and proposes documentation beside the change. | Intent; integration pending | [Propose Documentation After CI in DocsFab](../workflows/automatic-ci-proposals.md) |
| GitLab notes on an existing merge request | Projects a succeeded hosted review into one bot-owned note with source-linked findings. It does not merge. | Pilot-verified | [Review Merge Request Impact in DocsFab](../workflows/review-merge-request-impact.md) |
| `docsfab doctor`, `setup`, and `init` | `setup` writes the supported model profile. `init` previews or applies project configuration. `doctor` checks host and selected-repository readiness. | Repository-tested | [Install DocsFab](../get-started/installation.md) |

## Documentation Jobs

These catalog workflows implement create, update, review, and restructure.
Create, update, and review have repository-tested implementations.
Restructure remains catalogued without the same journey qualification. The
following table lists those jobs.

| Feature | What It Does | Evidence State | Learn More |
| --- | --- | --- | --- |
| Create documentation | Runs `create-documentation` to produce a bounded new page or short set from pinned evidence and an instruction. | Repository-tested | [Workflow Quickstart](../get-started/runner-quickstart.md) |
| Update documentation, including no-change | Runs `update-documentation` for a scoped patch. After planning, the job can instead return a read-only no-change assessment when independent evidence supports leaving pages unchanged. | Repository-tested | [Update Documentation Beside a Change in DocsFab](../workflows/update-documentation-beside-a-change.md) |
| Review documentation | Runs read-only `review-documentation` with audit, inventory-only verification, lint, canonical verification, independent review, audience, and evaluation steps. | Repository-tested | [Review Merge Request Impact in DocsFab](../workflows/review-merge-request-impact.md) |
| Restructure documentation | Catalog job `restructure-documentation` for information-architecture change without treating the product as new. | Catalogued; not a v0.0.1 proof | [Run a Documentation Workflow in DocsFab](../workflows/run-a-documentation-workflow.md) |

## Product Knowledge

Knowledge jobs establish attributed inputs. They do not replace a
version-bound behavior check or a documentation-quality review. The
following table lists those knowledge capabilities.

| Feature | What It Does | Evidence State | Learn More |
| --- | --- | --- | --- |
| First-pass gather and `needs-input` | Gathers candidate evidence before planning on create and many updates. A blocking gap, conflict, or missing support stops the original job with `needs-input` instead of inventing intent. | Repository-tested | [Answer and Resume](../workflows/answer-and-resume.md) |
| Product-model interview | Records a consent-aware, participant-only snapshot when attributable intent, rationale, terminology, or audience knowledge is missing. | Implemented, integration pending | [Conduct a Product-Model Interview in DocsFab](../workflows/conduct-product-model-interview.md) |
| Source-thread reconciliation | Reconciles disagreeing registered sources into a new immutable candidate model version and updated readiness. | Implemented, integration pending | [Reconcile Source Threads in DocsFab](../workflows/reconcile-source-threads.md) |

## Quality Evidence

Quality features are separate lenses inside a catalog job. A later lens
cannot compensate for a missing earlier result. The following table lists
those quality capabilities.

| Feature | What It Does | Evidence State | Learn More |
| --- | --- | --- | --- |
| Plan documentation | Collects sources, resolves reader task and page purpose, and binds the approved page set before writes. | Repository-tested | [Plan Documentation Skill in DocsFab](../reference/quality/skills/plan-and-author/plan-documentation.md) |
| Write and polish | Creates or edits documentation, including focused polish, inside the approved scope. Write owns polish. There is no separate public polish job. | Repository-tested | [Write Documentation Skill in DocsFab](../reference/quality/skills/plan-and-author/write-documentation.md) |
| Lint documentation | Reports repository-native deterministic checks and unavailable coverage without claiming a quality pass. | Repository-tested | [Lint Documentation Skill in DocsFab](../reference/quality/skills/check-and-review/lint-documentation.md) |
| Verify technical accuracy | Inventories source facts, then compares source-derived facts, public contracts, examples, and candidate passages. Inventory is a Pin A step of this skill, not a ninth catalog identity. | Repository-tested | [Verify Technical Accuracy Skill in DocsFab](../reference/quality/skills/check-and-review/verify-technical-accuracy.md) |
| Independent review | Assesses clarity, audience fit, structure, and reader consequences on a read-only path, independent of the writer. | Implemented, integration pending | [Review Documentation](../reference/quality/skills/check-and-review/review-documentation.md) |
| Audience insufficient-evidence | Audience testing returns `insufficient-evidence` when required participants, oracle, or audience inputs are missing. That result is not observed understanding and not a quality pass. | Repository-tested | [Test Audience Understanding Skill in DocsFab](../reference/quality/skills/assess-and-evaluate/test-audience-understanding.md) |
| Layered evaluation | Reconciles evidence across trustworthy information, transferable understanding, and effective experience. Hard-gate failures cannot be averaged away. | Repository-tested | [Evaluate Document Quality Skill in DocsFab](../reference/quality/skills/assess-and-evaluate/evaluate-document-quality.md) |

## Delivery

Delivery is a separately authorized phase after a succeeded write or review.
A run does not grant merge or publication authority. The following table
lists those delivery capabilities.

| Feature | What It Does | Evidence State | Learn More |
| --- | --- | --- | --- |
| `--patch-only` | Retains an inspectable local patch. It does not apply the patch to the source checkout or open a merge request. | Repository-tested | [Workflow Quickstart](../get-started/runner-quickstart.md) |
| Draft merge request | Default write delivery creates a branch and opens one draft merge request when delivery prerequisites pass. A human still accepts the draft. | Repository-tested | [Workflow Quickstart](../get-started/runner-quickstart.md) |
| `docsfab reports serve` | Serves saved review HTML from the selected state directory. It does not change the saved result. | Repository-tested | [Review Merge Request Impact in DocsFab](../workflows/review-merge-request-impact.md) |

For hands-on paths, continue with the following pages.

<CardGroup cols={2}>
  <Card title="Install DocsFab" href="/get-started/installation">
    [Install DocsFab](../get-started/installation.md)
  </Card>
  <Card title="Workflow Quickstart" href="/get-started/runner-quickstart">
    [Workflow Quickstart](../get-started/runner-quickstart.md)
  </Card>
</CardGroup>
