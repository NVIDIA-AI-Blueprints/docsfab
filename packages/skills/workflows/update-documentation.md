# Update documentation workflow

Runtime workflow ID: `update-documentation` (`schemaVersion` 2). This
remaining schemaVersion 2 pin without `derive-source-obligations` and
without the create workflow dual or provisional verify pair is
**intentional asymmetry**. Do not copy the create-documentation graph
onto this workflow.

This narrative describes the pinned stages. Skills do not call other
skills; the runtime catalog is the compose layer.

## Inputs

- Existing document and requested change
- Schema-valid documentation request and brief
- Approved team profile and sources
- Selected quality rubric for the evaluation artifacts

## Stages

Prefix (always):

1. Run `plan-documentation` (read-only). Plan the smallest documentation
   change that matches the requested product or API change. Collect
   related content or source code first. Bind each proposed mutating
   page to approved change evidence and return `planBinding`. For
   merged-request updates, retain selected MR identities and per-MR
   coverage gaps within the requested scope. Surface material missing
   sources, decisions, or scope as needs-input before writing.

Selection after `plan-documentation` (`editorial-candidate-v1`):

- **author** (write the update):
  1. Run `write-documentation` in update mode. Change only the affected
     documentation and preserve correct unrelated content.
  2. Run `lint-documentation`.
  3. Run `verify-technical-accuracy` against the declared target, the
     approved sources, and the requested change.
  4. Run `review-documentation` on the exact governed target.
  5. Run `test-audience-understanding`.
  6. Run `evaluate-document-quality`.
- **assess-no-change** (read-only; skip writing and linting). Independent
  evidence must support the no-change outcome:
  1. Run `verify-technical-accuracy` against the proposed no-change
     assessment.
  2. Run `review-documentation` on the no-change assessment.
  3. Run `test-audience-understanding`.
  4. Run `evaluate-document-quality`.

`evaluate-document-quality` must return `evaluation.json`,
`quality-score.json`, and `quality-report.md` with their locators.
Validate the layered result and score, then validate that the report
matches them. Return the complete artifact package and a focused diff
on the authoring branch. For merged-request updates, distinguish MRs
requiring edits, MRs with no demonstrated reader impact, and MRs whose
impact remains unverified. Report workflow execution, substantive
findings, and evidence gaps separately.

## Limits

- Do not broaden the requested scope without approval.
- Do not replace the entire document when a focused patch is sufficient.
- No automatic publication.
- Do not treat update as create: this pin has no derive ledger step and
  no provisional-then-final verify pair.
