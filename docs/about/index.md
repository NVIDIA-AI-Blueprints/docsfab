---
title: NVIDIA DocsFab Documentation
sidebar-title: Overview
description: Create, update, and review documentation from product evidence, then inspect the claims, changes, and quality results behind each outcome.
status: draft
---

<span id="overview-of-docsfab"></span>
<span id="benefits"></span>
<span id="the-challenge"></span>
<span id="our-approach"></span>

DocsFab helps product teams create, update, and review documentation from
repository evidence and attributed product knowledge. You can use a local
conversation or a named workflow to produce documentation changes and inspect
their supporting evidence. For capabilities and evidence states, refer to
[Key Features](key-features.md).

<Note title="Current Product Scope">
DocsFab is in project stage alpha. The local command-line interface (CLI)
and live agent are the current product surfaces. Automatic GitLab CI proposals
remain intended, with integration pending. For capability evidence and public
release limitations, refer to
[DocsFab Implementation Status](../reference/status-and-configuration/implementation-status.md).
</Note>

<span id="navigating-this-documentation"></span>
<span id="next-steps"></span>
<span id="learn-more"></span>
<span id="usage-modes"></span>

## Skip Ahead

Choose a starting point for supported environments, your first task, workflow
examples, or recovery.

<CardGroup cols={2}>
  <Card title="Support Matrix" href="/reference/support-matrix">
    Check platform coverage, tested model routes, and environment prerequisites in the
    [DocsFab Support Matrix](../reference/support-matrix.md).
  </Card>
  <Card title="Get Started" href="/get-started/installation">
    [Install DocsFab](../get-started/installation.md), then follow the
    [Live Agent Quickstart](../get-started/live-agent-quickstart.md) or
    [Workflow Quickstart](../get-started/runner-quickstart.md).
  </Card>
  <Card title="Examples" href="/workflows/run-a-documentation-workflow">
    Choose a named job and inspect command examples in
    [Run a Documentation Workflow](../workflows/run-a-documentation-workflow.md).
  </Card>
  <Card title="Troubleshooting" href="/troubleshooting">
    Match an error or failed task to a recovery action in
    [Troubleshooting DocsFab](../troubleshooting.md).
  </Card>
</CardGroup>

<span id="user-journeys"></span>

## Use Cases

Choose the documentation outcome you need. [Use Cases](use-cases.md) explains
the participating roles and catalog jobs for these goals.

<CardGroup cols={2}>
  <Card title="Stand Up Documentation" href="/get-started/runner-quickstart">
    <span id="stand-up-documentation"></span>

    Turn product evidence into a new page or short documentation set. Gather
    missing product knowledge before drafting, then inspect the result with
    the [Workflow Quickstart](../get-started/runner-quickstart.md).
  </Card>
  <Card title="Keep Documentation Current" href="/workflows/update-documentation-beside-a-change">
    <span id="keep-documentation-current"></span>

    Assess documentation impact and propose a scoped update beside a product
    change. Start with
    [Update Documentation Beside a Change](../workflows/update-documentation-beside-a-change.md)
    or [Review Merge Request Impact](../workflows/review-merge-request-impact.md).
  </Card>
  <Card title="Trust and Improve the Set" href="/workflows/baseline-documentation-health">
    <span id="trust-and-improve-the-set"></span>

    Review an existing set, establish a health baseline, and identify gaps in
    accuracy or reader evidence. Start with
    [Baseline Documentation Health](../workflows/baseline-documentation-health.md).
  </Card>
</CardGroup>

## Core Concepts

These concepts explain how DocsFab turns a request into evidence you can
inspect. Start with jobs and stops to understand execution, then read product
knowledge and quality to interpret the evidence.

<CardGroup cols={2}>
  <Card title="Documentation Jobs" href="/about/core-concepts/documentation-jobs">
    A job binds one named outcome to a repository revision, workflow, and
    allowed operations. It retains a run record, findings, and any authorized
    patch. Refer to
    [Documentation Jobs](core-concepts/documentation-jobs.md).
  </Card>
  <Card title="Job Stops" href="/about/core-concepts/job-stops">
    A stop records why a job cannot finish and what can unblock it. Missing
    input, a failed check, and a capability boundary require different next
    actions. Refer to [When a Job Stops](core-concepts/job-stops.md).
  </Card>
  <Card title="Product Reference Model" href="/about/core-concepts/product-knowledge">
    The product reference model is a canonical, versioned representation of
    shared product understanding. Claims remain traceable to sources, scope,
    decisions, and unresolved questions. Refer to
    [Product Knowledge](core-concepts/product-knowledge.md).
  </Card>
  <Card title="Documentation Quality" href="/about/core-concepts/documentation-quality">
    Quality combines evidence about factual trust, reader understanding, and
    task success. Separate checks retain their own conclusions; a completed
    workflow does not grant publication approval. Refer to
    [Documentation Quality](core-concepts/documentation-quality.md).
  </Card>
</CardGroup>

## Core Components

DocsFab combines knowledge and quality inputs with a runtime that executes
jobs. A separate host channel delivers results to GitLab.

<CardGroup cols={2}>
  <Card title="Knowledge" href="/about/core-concepts/product-knowledge">
    Registers attributed sources, reconciles conflicts, and versions the
    product reference model. Refer to
    [Product Knowledge](core-concepts/product-knowledge.md).
  </Card>
  <Card title="Runtime" href="/about/architecture">
    Binds jobs to pinned inputs and allowed tools, executes workflow steps,
    and retains the result. Refer to
    [Architecture Overview](architecture.md).
  </Card>
  <Card title="Quality" href="/about/core-concepts/documentation-quality">
    Supplies locked writing, review, evaluation, and deterministic-check
    inputs to a job. Refer to
    [Documentation Quality](core-concepts/documentation-quality.md).
  </Card>
  <Card title="Host Delivery" href="/reference/architecture#gitlab">
    Posts review notes or opens draft merge requests through separately
    authorized GitLab delivery. Refer to
    [GitLab Delivery](../reference/architecture.md#gitlab).
  </Card>
</CardGroup>

For component relationships, refer to [Architecture Overview](architecture.md).
For credential, command, and evidence boundaries, refer to
[Security and Trust](security.md).
