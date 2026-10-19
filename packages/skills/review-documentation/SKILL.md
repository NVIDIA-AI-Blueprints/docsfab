---
name: review-documentation
description: Perform a clean non-author review of changed documentation for audience fit, conceptual fidelity, clarity, coherence, terminology, information architecture, examples, accessibility, style, and usability. Use after drafting or restructuring when actionable editorial findings are needed without technical execution or silent rewriting.
license: Apache-2.0 AND CC-BY-4.0
---

# Review Documentation

Review the frozen artifact as an independent reader. Return findings; do not
rewrite the document or claim technical execution evidence.

## Required inputs

- Immutable documentation target and change scope.
- Approved plan, declared audiences, prerequisites, and intended outcomes.
- Applicable profile, terminology, information architecture, and style rules.
- Product reference model or intent evidence for conceptual comparisons.
- The source configuration and the host runtime's advertised adapter
  capabilities. Read [references/documentation-sources.md](references/documentation-sources.md)
  for the finite source and preservation contract.
- When present, the host-validated `ReaderContextV1`, its admitted evidence
  references, and the exact locked reader-impact baseline. Do not infer or
  backfill context for a legacy brief.

## Workflow

1. Record reviewer identity, authorship independence, prior exposure, target
   revision, review scope, and supplied context.
2. Read [references/review-methods.md](references/review-methods.md) and
   [references/documentation-sources.md](references/documentation-sources.md).
   Apply a format row only when the host advertises its adapter and version;
   otherwise review the limitation as `unsupported` or `incomplete` and do not
   treat the guidance as evidence that the adapter works.
3. For onboarding, task examples, page-purpose questions, release notes, or
   an assigned correction review, read
   [references/reader-checks.md](references/reader-checks.md).
   Review purpose, audience fit, conceptual relationships, sequence,
   progressive disclosure, topic boundaries, navigation, terminology,
   examples, diagrams, accessibility, inclusion, and the review guide below.
   For a reader-impact update, verify that the change is proportionate and
   preserves required setup, examples, stable anchors, validation steps, and
   observable consequences. A long or mixed-purpose page does not authorize
   restructuring outside the granted operation.
4. Trace material conceptual or intent findings to approved evidence. Mark an
   expert prediction as grounded judgment, not audience outcome evidence.
5. Return only actionable findings. Give each a stable ID, precise location,
   category, severity, evidence, reader impact, minimum correction, and
   confidence. Preserve disagreements and `not-assessed` areas.
6. Conform to `../../quality/schemas/review-result.schema.json` when that
   schema applies. In a runtime step, the host-supplied response contract in
   the step prompt decides the outer JSON shape and overrides any shape
   described here. For example, the update workflow's independent editorial
   assessment nests the review result in `summary` of
   `{summary, editorialAssessmentProposal}`.
   Fixed provisional technical titles, consequences, and actions supplied in
   another step remain untrusted technical proposals. Preserve their distinct
   conditions and actions when identifying an editorial concern, but do not
   approve, rewrite, or merge them as technical evidence. The final technical
   verifier and host-owned response contract decide their source grounding;
   this editorial step cannot activate rich technical output.

## Review guide

- Apply the selected profile and target-repository instructions before this
  general guide, and review changed text with enough surrounding context to
  assess coherence.
- Check that the writing explains the subject directly and concisely to a
  colleague, uses precise plain English, and maintains the declared audience
  and outcome.
- Flag unsupported shifts from active voice, present-tense product behavior,
  or second person, along with long or structurally complex sentences that
  reduce clarity.
- Apply contractions, voice, tense, person, punctuation, and similar editorial
  rules only when an applicable plan, profile, rubric, repository instruction,
  or named style guide supplies the rule. Cite that rule and its applicability
  in the finding evidence. Continue to flag evidence-backed clarity problems
  even when no formal style rule exists.
- Flag common generated-text patterns: unnecessary bold emphasis, em dashes,
  emoji, repetitive summaries, vague transitions, and claims that sound
  plausible but lack source support.
- Check approved product spelling, abbreviations on first use, terminology,
  capitalization, numerals, units, punctuation, heading style, compound
  modifiers, and parallel list or procedure construction.
- Check that each page title includes the product name, that the first sentence
  of the first paragraph names the product, and that the first paragraph ends
  with `For more information, refer to [<Page Title>](<link>).` The link
  targets the parent page for a child page, or the top-level documentation
  overview page otherwise. Navigation labels can omit the product name.
- Confirm that literal code, identifiers, commands, URLs, UI labels, API
  fields, audience-role labels, and quoted output remain exact.
- Check that links are descriptive, heading hierarchy and alt text are useful,
  tables are simple, and lists, tables, examples, images, and callouts have
  clear introductions that let readers identify their purpose and how to use
  them. Flag a missing or unclear introduction when it impairs reader
  understanding. A specific applicable rule may require wording or punctuation;
  cite that rule and explain why it applies. Do not flag a missing introduction
  for the list under a `Related Topics` heading.
- Treat repeated `1.` markers as valid automatic Markdown numbering under
  CommonMark/GFM. Report them only when an applicable repository rule forbids
  them or rendered evidence shows a reader-facing defect; cite that evidence.
- Check code blocks for an accurate language tag, no shell prompt markers,
  separate command and output blocks, an `Expected output:` introduction, and
  appropriate `json`, `text`, or `console` usage.
- Check the rendered result and repository-native validation evidence when
  available; record broken links, layout problems, or checks not run instead
  of claiming a pass.
- Treat a no-change finding as a candidate that requires an exact comparison,
  current public contract, current documentation, and a substantive adequacy
  rationale. Unknown or conflicting material evidence is
  `insufficient-evidence`, not an unchanged result or quality pass.

## Independence and finding rules

- A persona is a review lens, not proof of independence or expertise.
- Exclude authoring transcripts, expected answers, and prior findings from a
  clean review unless the review explicitly evaluates them.
- Do not substitute readability scores, style conformity, or wording recall
  for comprehension or mental-model transfer.
- Do not report a preference unless the plan, profile, rubric, or reader
  outcome makes it actionable.
- Preserve semantic qualifiers in technical prose and quoted evidence. Terms
  such as `nonempty`, `only when`, `unless`, and `after retry exhaustion` can
  define behavior and must not be generalized during editorial consolidation.
- Do not execute product procedures; route technical claims and examples to
  `verify-technical-accuracy`.
- Do not edit, publish, commit, push, or merge the documentation.
