---
title: Review Documentation Skill in DocsFab
description: Perform a clean non-author editorial, structural, and usability review.
status: draft
---

The DocsFab `review-documentation` skill reviews the frozen artifact for
audience fit, conceptual fidelity, clarity, coherence, terminology, information
architecture, examples, accessibility, style, and usability. For more
information, refer to [Checking and Review Skills in DocsFab](index.md).

## Contract at a Glance

| Field | Contract |
| --- | --- |
| Mode | Read-only |
| Runtime binding | Independent-review step in `review-documentation`, `create-documentation`, `update-documentation`, and `restructure-documentation` |
| Primary output | Located, evidenced, actionable editorial and usability findings |
| Independence | A clean non-author reviewer when policy requires the gate |

## Reviewer Evidence

Record reviewer identity, authorship independence, prior exposure, target
revision, scope, and supplied context. A persona is a lens, not proof of
independence. Same-context review is self-review or proxy evidence.

Findings require a precise location, category, severity, evidence, reader
impact, minimum correction, and confidence. Preferences are not findings
unless the plan, profile, rubric, or reader outcome makes them actionable.

## Boundaries

The reviewer does not execute product procedures, silently rewrite the
artifact, publish, or perform SCM changes.

## Authoritative Sources

- [Skill contract](../../../../../packages/skills/review-documentation/SKILL.md)
- [Review methods](../../../../../packages/skills/review-documentation/references/review-methods.md)
- [Comprehensive review binding](../../../../../packages/runtime/workflows/review-documentation.json)
- [Create workflow binding](../../../../../packages/runtime/workflows/create-documentation.json)
- [Update workflow binding](../../../../../packages/runtime/workflows/update-documentation.json)
- [Restructure workflow binding](../../../../../packages/runtime/workflows/restructure-documentation.json)
