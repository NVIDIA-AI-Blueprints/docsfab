---
title: Skill Behavior Contracts in DocsFab
description: Look up the eight documentation skills and their current runtime bindings.
status: draft
---

The canonical DocsFab
[`packages/skills/`](../../../../packages/skills/README.md) catalog contains
eight skill contracts. The runtime stages exact hashed copies and schedules them
through fixed CLI workflows. Skills are playbooks; runtime is the job runner.
Both pins must agree before a `docsfab` job exists. Refer to [skills ↔
runtime](../../../../packages/skills/README.md#relationship-to-the-runtime). For
more information, refer to [DocsFab Quality Reference](../index.md).

## Read a Skill Contract

Each leaf reference identifies the skill's mode, runtime binding, primary
evidence or mutation, stop conditions, forbidden actions, and authoritative
source. A skill contract defines reusable behavior. The runtime manifest owns
step order, activation, tool access, credentials, recovery, and write
authorization.

## Choose a Skill Stage

<CardGroup cols={3}>
  <Card
    title="Planning and Authoring"
    href="/reference/quality/skills/plan-and-author"
  >
    Plan an approved documentation change or produce a bounded patch.
    Refer to [Planning and Authoring](plan-and-author/index.md).
  </Card>
  <Card
    title="Checking and Review"
    href="/reference/quality/skills/check-and-review"
  >
    Inventory source facts, run deterministic checks, verify technical
    claims, or perform independent review. Refer to
    [Checking and Review](check-and-review/index.md).
  </Card>
  <Card
    title="Assessment and Evaluation"
    href="/reference/quality/skills/assess-and-evaluate"
  >
    Audit a documentation set, test audience understanding, or evaluate
    quality evidence. Refer to
    [Assessment and Evaluation](assess-and-evaluate/index.md).
  </Card>
</CardGroup>

## Skill Catalog

| Outcome | Canonical skill | Runtime exposure |
| --- | --- | --- |
| Audit focused Markdown or a documentation set | [`audit-documentation`](assess-and-evaluate/audit-documentation.md) | Review and restructuring inventory steps |
| Build an approved plan | [`plan-documentation`](plan-and-author/plan-documentation.md) | Creation, update, and restructuring planning steps |
| Create or edit documentation, including focused polish | [`write-documentation`](plan-and-author/write-documentation.md) | Focused live-agent edits; mutation step in creation, update, and restructuring |
| Run deterministic checks | [`lint-documentation`](check-and-review/lint-documentation.md) | Review, creation, update, and restructuring validation steps |
| Inventory source facts, then verify technical claims | [`verify-technical-accuracy`](check-and-review/verify-technical-accuracy.md) | Inventory-only Pin A step on create and review; verification step in all four workflows |
| Perform independent peer review | [`review-documentation`](check-and-review/review-documentation.md) | Review, creation, update, and restructuring review steps |
| Test audience understanding | [`test-audience-understanding`](assess-and-evaluate/test-audience-understanding.md) | Review, creation, update, and restructuring audience steps |
| Evaluate quality evidence | [`evaluate-document-quality`](assess-and-evaluate/evaluate-document-quality.md) | Comprehensive review, creation, update, and restructuring evaluation steps |

The [`create-documentation`](../../workflow-contracts/create-documentation.md) and
[`restructure-documentation`](../../workflow-contracts/restructure-documentation.md) jobs
compose these skills as separate catalog steps. Their mutation steps use
`write-documentation` in different modes. Creation and comprehensive review
schedule `verify-technical-accuracy` in inventory-only mode as Pin A step
`derive-source-obligations` after planning or audit. That step is not a ninth
catalog skill.
Update can select a read-only
[no-change assessment](../../workflow-contracts/update-documentation.md) after
planning; that branch skips writing and linting while retaining independent
verification, review, audience, and quality evidence. Runtime owns execution state,
scheduling, activation, tools, credentials, recovery, and SCM authority.

`guided-demo` is a benchmark fixture name. Detailed quality methods remain
available through references owned by the skills.

## Task-Specific Methods

Skills load detailed methods when the task needs them. Planning selects research
questions for the page purpose. Writing and review apply practical reader-path
and presentation checks. Technical verification checks complete examples and
changed interfaces, distinguishing static inspection from executed behavior.
Correction reviews preserve originating findings and check adjacent content.

A long or mixed-purpose page does not turn a bounded update into restructuring.
The planner reports a separate structural recommendation or a material scope
gap. Release-note work distinguishes reader impact from approved disclosure;
neither drafting nor review grants publication authority.

Audit findings use approved source authority to reconcile implementation,
schema, and test conflicts. Agreement counts do not establish a probability of
truth. Checks unavailable to the host remain explicit evidence gaps.

## Shared Boundaries

- Use approved, version-identifiable sources and a clear request or brief.
  Workflow writing requires its supplied plan binding.
- Require explicit runtime write authorization before a write step.
- Keep Writer, source-obligation analyst, Technical Verifier, Peer Reviewer,
  audience participant, and Quality Evaluator evidence distinct.
- Use clean non-author providers when independence is required.
- Permit at most one automatic Writer revision by default.
- Do not publish, commit, push, open a merge request, or merge.

Disk presence does not activate a DocsFab workflow. Runtime use requires a
locked, contained catalog pack. `docsfab run` selects a fixed workflow;
`docsfab live-agent` can select available skills for a natural-language request.
Both entry points preserve tool and write-authorization boundaries.
