# Create documentation workflow

Runtime workflow ID: `create-documentation` (`schemaVersion` 3). This
narrative describes the pinned stages. Skills do not call other skills;
the runtime catalog is the compose layer.

## Inputs

- Schema-valid documentation request and brief
- Approved team profile and sources
- Selected quality rubric for the evaluation artifacts

## Stages

Prefix (always, in order):

1. Run `plan-documentation` (read-only). Collect related content or
   source code first, then plan the requested new page or documentation
   set. Return `planBinding`, or needs-input when material sources,
   decisions, or scope are unresolved.
2. Run `derive-source-obligations` (read-only). Derive a bounded atomic
   source-obligation ledger from the validated plan sources.
3. Run `write-documentation` in create mode. Create only the requested
   documentation from the sealed plan and bound sources. This step
   consumes `derive-source-obligations`.
4. Run `lint-documentation`. Report repository-native documentation
   checks as passed, failed, or unavailable.
5. Run `provisional-technical-verification`
   (`verify-technical-accuracy`, read-only). Independently compare the
   candidate with the frozen source and source-obligation ledger. This
   result is provisional evidence.
6. Run `review-documentation` (read-only). Perform a clean non-author
   editorial review of the exact governed target.
7. Run `verify-technical-accuracy` (read-only). Start from a fresh
   context, correct the provisional comparison against the immutable
   ledger, and independently source-check factual objections from the
   provisional technical and editorial reviews. This step consumes
   `derive-source-obligations`, `provisional-technical-verification`,
   and `review-documentation`.

Selection after `verify-technical-accuracy` (`authoring-revision-v1`):

- **retain**: run `test-audience-understanding`, then
  `evaluate-document-quality`.
- **revise**: run one correction cycle, then audience and quality:
  1. `revise-documentation` (`write-documentation` in create mode; one
     correction of the existing candidate)
  2. `lint-revised-documentation`
  3. `provisional-revised-technical-verification`
  4. `verify-revised-technical-accuracy`
  5. `review-revised-documentation`
  6. `test-audience-understanding`
  7. `evaluate-document-quality`

`evaluate-document-quality` must return `evaluation.json`,
`quality-score.json`, and `quality-report.md` with their locators.
Validate the layered result and score, then validate that the report
matches them. Return a review-ready artifact package on pass; otherwise
route to human review.

## Limits

- One automatic revision by default (the `revise` branch).
- No automatic publication.
- Stop when required context is unresolved or an approved source is
  unavailable.
