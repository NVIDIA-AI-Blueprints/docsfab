---
title: Workflow Contracts in DocsFab
description: Look up the fixed DocsFab workflow compositions for review, template audit, creation, update, and restructuring.
status: draft
---

DocsFab workflow contracts define the ordered skill sequence and authority
boundary for a catalogued runtime job. Use the task-oriented guides in
[About DocsFab Workflows](../../workflows/index.md) when you need an
operator procedure. For more information, refer to [Overview of
DocsFab](../../about/index.md).

## Choose a Workflow Contract

The following table maps each outcome to its workflow contract.

| Outcome | Contract | Distinguishing step |
| --- | --- | --- |
| Review a frozen documentation set without editing it. | [Review Documentation Workflow in DocsFab](review-documentation.md) | Audits the declared set, collects deterministic, technical, editorial, and audience evidence, then evaluates the complete package. |
| Create a new page or documentation set from approved scope and evidence. | [Create Documentation Workflow in DocsFab](create-documentation.md) | Collects related content or source code before planning and authoring, then checks, verifies, independently reviews, and evaluates the patch. |
| Update the smallest documentation set affected by a product or API change. | [Update Documentation Workflow in DocsFab](update-documentation.md) | Inventories admitted change sources, then uses change-scoped context for mutation, checks, verification, review, and evaluation. |
| Reorganize an existing documentation set without losing supported content or reader access. | [Restructure Documentation Workflow in DocsFab](restructure-documentation.md) | Audits and maps the existing set, inventories source facts, then mutates and adds audience-understanding evidence. |
| Check every page against its governed template without a model call. | [Audit Documentation Workflow in DocsFab](audit-documentation.md) | Maps each page to a template, runs the structural template checks, and counts coverage in the host. |

The template audit has one host-operation stage and calls no model. The
stage behavior that follows applies to the model-backed workflows.

Each stage uses the declared target and available source locators. It expands
its reads only to resolve a specific dependency, claim, or material evidence
gap. A one-page target does not request a repository-wide audit. Stages return
concise evidence for their own task while preserving required findings and
complete quality artifacts. Independent reviewers establish their conclusions
from the target and primary evidence.

For a named single-page review, the runtime also bounds compiled context to
that page and its structural context. Read-only stages with the same context
policy reuse the compiled packet when the indexed content is unchanged. A
content change, different target, or different policy requires a new packet.
This shares repository evidence while keeping model sessions independent.

The audience stage checks supplied prerequisites before starting a participant.
Missing required inputs produce `insufficient-evidence` without an invented test
or participant. That substantive result is separate from step execution status.

For `review-documentation`, the runtime supplies the final evaluator's locked
contract files before the model starts, including schemas and the selected
profile. The evaluator
preserves known hard failures even when other evidence is missing. A valid
quality decision of `fail` can complete evaluation successfully.
Contradictory decisions or overstated confidence fail artifact validation and
leave the workflow incomplete; smaller reports do not waive these checks.

The fixed workflow jobs do not publish, commit, push, or merge. Write
jobs return local, review-ready patches. The review job is read-only.

After a successful write, the CLI opens one draft merge request unless
you pass `--patch-only`. That host projection is not a workflow step and
grants neither merge authority nor broader publication rights.

The checked-in [runtime workflow catalog](../../../packages/runtime/model-compositions/workflow-catalog.json)
and individual manifests are authoritative for exact step order and mode.
