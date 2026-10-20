---
title: Run the Knowledge-Gathering Workflow in DocsFab
description: Gather evidence, resolve model gaps, synthesize source threads, and assess documentation readiness.
status: draft
---

Use this DocsFab workflow to produce or update a candidate product reference
model for one bounded product region and assess whether it can support a
documentation target. For more information, refer to
[About DocsFab Workflows](index.md).

## What You Will Produce

The workflow produces the following traceable set of artifacts rather than one summary:

- A commit-bound repository assessment for each selected documentation target.
- Stable source threads with immutable evidence items and derived
  representations.
- An inconsistency report, including an explicit no-conflict result when
  applicable.
- A new immutable candidate model version and merge receipt after the selected
  conflict queue reaches zero.
- A target-specific readiness result and a bounded documentation brief when
  the evidence is sufficient.

## In This Guide

Use the following links to follow the workflow or return to a specific stage:

- [Prerequisites](#prerequisites)
- [Run the Workflow](#run-the-workflow)
- [Verify the Result](#verify-the-result)
- [Next Steps](#next-steps)

<a id="before-you-begin"></a>

## Prerequisites

Identify the following inputs before you acquire or retain evidence:

- Product and version or revision.
- Model region, such as purpose, architecture, or one workflow.
- Intended documentation family, page, audience, and release.
- Repository-authorized location for source threads and model packages.
- Evidence-access, retention, citation, and redistribution boundaries.
- Accountable owners for behavior, representation, intent, and release
  decisions.

Do not retain interview transcripts or restricted artifact bytes without the
required permission.

## Run the Workflow

Complete the following steps for one bounded model region and documentation
target.

<Steps>
  <Step title="Assess the repository">
    Assess the exact repository revision with the
    `assess-product-repository` skill, and record observed behavior, existing
    artifacts, source candidates, gaps, and target readiness.
  </Step>
  <Step title="Register source threads">
    Register each evidence origin with the `register-source-thread` skill.
    Keep multiple items from the same person, repository, or runtime in that
    origin's stable thread.
  </Step>
  <Step title="Preserve original artifacts">
    Preserve original artifacts when retention is authorized, and add
    extracted text, renders, transcripts, or summaries as separately derived
    representations.
  </Step>
  <Step title="Acquire missing intent">
    Acquire missing intent with existing product artifacts, provenance-safe
    transcript mining, or a bounded product-model interview. Do not use an
    interview to replace behavior verification that code, tests, or runtime
    evidence can establish.
  </Step>
  <Step title="Reflect the emerging model">
    Reflect the emerging model to participants as a concise paraphrase, table,
    or focused Mermaid diagram. Register corrections as later events instead
    of editing earlier evidence.
  </Step>
  <Step title="Synthesize selected thread heads">
    Synthesize selected thread heads with the `synthesize-source-threads`
    skill. Declare the model region, product version, audience, documentation
    targets, and exact source-item versions.
  </Step>
  <Step title="Adjudicate blocking inconsistencies">
    Adjudicate each blocking inconsistency with the appropriate authority.
    Preserve rejected, superseded, rescoped, and deferred variants in the
    inconsistency report and merge receipt.
  </Step>
  <Step title="Create a candidate model version">
    Create a new immutable candidate model version. When its selected conflict
    queue reaches zero, update affected documentation and rescan every family
    in the configured information architecture. Generate newly ready missing
    targets, and record `needs-input` when a load-bearing gap remains.
  </Step>
  <Step title="Produce a documentation brief">
    Produce a documentation brief only when each selected target has enough
    grounded information. Pin the model, repository revision, style profile,
    template, quality policy, and authority boundary used by the next workflow.
  </Step>
</Steps>

The current `synthesize-source-threads` skill guides the agent-executed
comparison, adjudication, model issue, documentation update, and family rescan.
No autonomous reconciler or runtime command currently performs this sequence.

## Verify the Result

Confirm the following conditions:

- Every retained source has an independently inspectable lineage.
- Original and derived representations remain distinguishable.
- Every model claim identifies exact evidence or a labeled agent inference.
- An inconsistency report exists, including when no conflict was found.
- The merge receipt names every source version, decision, and model delta.
- Open conflicts block only the documentation targets that depend on them.
- The readiness decision names its audience, release, evidence, gaps, and
  reopen conditions.
- Every configured family has a readiness result, including an explicit
  blocked result for a missing target that still lacks evidence.

## Next Steps

Choose the next action from the readiness result:

<CardGroup cols={2}>
  <Card
    title="Run a Documentation Workflow in DocsFab"
    href="/workflows/run-a-documentation-workflow"
  >
    If a target is ready, use its documentation brief to
    [run a documentation workflow](run-a-documentation-workflow.md), then
    apply the
    [Evidence Before Drafting](../about/core-concepts/documentation-quality.md#evidence-before-drafting)
    gates.
  </Card>
  <Card
    title="Conduct a Product-Model Interview in DocsFab"
    href="/workflows/conduct-product-model-interview"
  >
    If the target lacks attributable intent or participant knowledge,
    [conduct a product-model interview](conduct-product-model-interview.md).
  </Card>
  <Card
    title="Reconcile Source Threads in DocsFab"
    href="/workflows/reconcile-source-threads"
  >
    If selected evidence conflicts or changes an existing model,
    [reconcile source threads](reconcile-source-threads.md).
  </Card>
</CardGroup>

If the target remains blocked, preserve the exact missing evidence and reopen
conditions. Do not draft from an unsupported model.
