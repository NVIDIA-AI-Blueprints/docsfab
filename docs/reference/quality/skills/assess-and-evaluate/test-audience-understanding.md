---
title: Test Audience Understanding Skill in DocsFab
description: Collect controlled human or clean-agent evidence of comprehension and mental-model transfer.
status: in-development
---

The DocsFab `test-audience-understanding` skill tests what versioned
documentation communicates to a representative human or clean agent. It does
not gather product intent or teach the participant during measurement. For
more information, refer to [Assessment and Evaluation Skills in
DocsFab](index.md).

## Contract at a Glance

| Field | Contract |
| --- | --- |
| Mode | Read-only controlled assessment |
| Runtime binding | Audience-evaluation step in `review-documentation`, `create-documentation`, `update-documentation`, and `restructure-documentation` |
| Primary output | Validated, population-specific comprehension and task evidence |
| Stops when | The frozen target, scenarios, oracles, representative audience, independence, retention boundary, or run authority is unavailable |

## Test Evidence

The workflow must supply an immutable candidate identity, authoritative
reference model, versioned scenario corpus and oracle, representative
participant, independence, retention boundary, and run authority. When a
prerequisite is missing or invalid, the step reports
`insufficient-evidence`; it does not run an actual participant attempt.

When prerequisites are complete, freeze the document, reference model,
audience, scenarios, oracles, evaluator, and retention boundary before
exposure. Use teach-back, relationship,
boundary, prediction, counterfactual, unfamiliar-case, and find-and-use tasks.
Do not reveal expected answers or authoring context.

Keep human and agent populations separate. Contaminated attempts remain
inspectable but cannot support a pass. A model-claimed outcome is not a
host-verified participant outcome merely because its envelope validates.
Current create and update projection retains `insufficient-evidence` even
when the audience record is structurally complete; governed semantic
validation remains a gap documented in
[Baseline Documentation Health in DocsFab](../../../../workflows/baseline-documentation-health.md).

## Boundaries

The skill does not edit, publish, or perform SCM changes.

## Authoritative Sources

- [Skill contract](../../../../../packages/skills/test-audience-understanding/SKILL.md)
- [Protocol](../../../../../packages/skills/test-audience-understanding/references/protocol.md)
- [Evidence contract](../../../../../packages/skills/test-audience-understanding/references/evidence-contract.md)
- [Experience methods](../../../../../packages/skills/test-audience-understanding/references/experience-methods.md)
- [Comprehensive review binding](../../../../../packages/runtime/workflows/review-documentation.json)
- [Restructure workflow binding](../../../../../packages/runtime/workflows/restructure-documentation.json)

## Related Topics

- [Reading a Result](../../../../about/core-concepts/documentation-quality.md#reading-a-result)
