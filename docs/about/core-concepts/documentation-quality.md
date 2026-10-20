---
title: Documentation Quality in DocsFab
description: Learn how DocsFab judges documentation quality in layers, what each check can show, and how to read fail, insufficient-evidence, and needs-input results.
status: in-development
---

Documentation quality combines evidence about factual trust, reader
understanding, and task success in [DocsFab](../index.md). No single check
establishes all three.

Use these separate results to decide what still needs verification or review.
A workflow can finish while its evaluation reports failure or insufficient
evidence. Execution completion, document quality, and publication approval
remain separate decisions. For related concepts, refer to
[Core Concepts](../index.md#core-concepts).

## Three Quality Questions

DocsFab judges quality in three cumulative layers. Each layer asks one
question:

1. **Trustworthy information**: Can this information be relied on for its
   declared scope?
2. **Transferable understanding**: Does the documentation help the reader form
   a coherent model and reason beyond memorized wording?
3. **Effective experience**: Can the intended user find and apply the right
   information with acceptable effort, risk, and friction in the actual
   workflow?

A higher layer cannot make up for a failure in a lower layer. A polished
experience cannot make an incorrect command acceptable. Critical factual
errors, unsafe instructions, wrong-version behavior, unsupported consequential
claims, and material omissions are failures that no other strength can
offset.

Quality is a set of results, not one score. A high average must never hide a
critical accuracy, security, accessibility, or task-safety failure.

## What Each Check Can Show

Each check answers a different question and has its own limit. The following
table describes them.

| Check | Question | Limit |
| --- | --- | --- |
| Deterministic and native checks | Does the target satisfy selected syntax, style, metadata, link, schema, or executable-example rules? | A passing check covers only its selected rules. It does not prove factual truth or reader understanding. |
| Independent technical verification | Do consequential claims and examples match authoritative, version-bound product evidence? | It covers only the claims and sources it inspected. |
| Independent editorial review | Is the explanation clear, coherent, and suitable for its intended reader? | Judgment is not an observed reader outcome. |
| Conditional audience testing | Can a representative human or clean agent understand or apply the frozen documentation? | It runs only when its prerequisites are present. Without them, the result is `insufficient-evidence`, and no participant is simulated. |
| Terminal quality evaluation | What do the available layer, constraint, and rubric evidence support? | Validation checks artifact shape and decision consistency, not factual truth. |

Review must be independent of authorship. Documentation that DocsFab writes is
reviewed by a clean reviewer that did not take part in writing it, and
same-session self-review cannot satisfy that requirement. A finding closes
only when it is fixed and verified, or when an authorized owner dismisses it
with an explicit rationale. For the roles and the independence rule, refer to
[Review Independence](../../reference/quality/quality-roles-and-capabilities.md#review-independence).

For the evaluation artifacts that a run produces, refer to
[Evaluate Document Quality Skill in DocsFab](../../reference/quality/skills/assess-and-evaluate/evaluate-document-quality.md).

## Reading a Result

The current `docsfab-documentation-quality` profile, version `v0.1`, is
experimental and has `release_gate_eligible: false`. It cannot produce an
overall release-gating pass. A rubric score, when available, is a separate
view and does not override the layered result.

The following three results are easy to confuse, and each means something
different:

- **`fail`**: DocsFab established a failure, such as a required command that
  does not work.
- **`insufficient-evidence`**: Evidence about quality is missing, such as
  audience testing that could not run.
- **`needs-input`**: Evidence about the product is missing, so DocsFab cannot
  write the page without inventing facts.

The following fictional example shows how to read a report.

| Report evidence | Interpretation |
| --- | --- |
| A required guide command, `docsfab do "Update the installation guide" --reader-source docs/install.md`, fails against the frozen implementation. | Record the verified `broken-required-example` hard-gate finding. The affected layer and overall evaluation remain `fail`, even if audience evidence is also missing. A known failure is not erased by a gap. |
| No failure is established, but required audience evidence is missing. | The applicable assessment remains `insufficient-evidence` or requires human review. Missing evidence does not count as a pass. |

## Evidence Before Drafting

DocsFab does not ask whether its product knowledge is universally complete. It
asks whether the available evidence is good enough to create one high-quality
page for a named audience and release. Different page types need different
evidence, as the following table shows.

| Page type | Typical evidence |
| --- | --- |
| About | Product purpose, audiences, use cases, positioning, and accountable product intent |
| Conceptual | Product intent, terminology, relationships, architecture, code, tests, and behavioral observations |
| Get Started | Verified prerequisites, installation path, first-success task, expected output, and recovery steps |
| Procedural | A tested task path, permissions, inputs, expected results, and failure recovery |
| Reference | Version-bound commands, APIs, schemas, configuration, defaults, and support boundaries |
| Troubleshooting | Reproduced symptoms, causes, recovery actions, and verification steps |
| Resources | Stable terminology, diagrams, compatibility information, or supporting context |
| Release Notes | A canonical release record, exact delivered versions, changes, limitations, and known issues |

If a load-bearing requirement is absent, DocsFab records `needs-input` instead
of converting uncertainty into confident prose. The NVIDIA documentation
families are the default structure, and your organization can supply another
structure without changing this rule.

## Next Steps

To continue, refer to the following pages:

- [Baseline Documentation Health in DocsFab](../../workflows/baseline-documentation-health.md)
- [Run a Documentation Workflow in DocsFab](../../workflows/run-a-documentation-workflow.md)
- [Evaluate Document Quality Skill in DocsFab](../../reference/quality/skills/assess-and-evaluate/evaluate-document-quality.md)
- [Test Audience Understanding Skill in DocsFab](../../reference/quality/skills/assess-and-evaluate/test-audience-understanding.md)
- [Quality Roles and Capability Coverage in DocsFab](../../reference/quality/quality-roles-and-capabilities.md)
