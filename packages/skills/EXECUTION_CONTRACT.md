# Documentation automation contract

Use the shared DocsFab skills and quality package to create or update technical
documentation from approved sources and return a review-ready artifact package.

## Required inputs

- A request conforming to `../quality/schemas/documentation-request.schema.json`.
- A documentation brief conforming to `../quality/schemas/documentation-brief.schema.json`.
- An approved team profile under `../quality/profiles/`.
- Approved, version-identifiable source material.
- An approved source set. When the selected workflow requires an SRD, the brief
  records whether the developer supplied it. The `plan-documentation` step
  checks or drafts the SRD and obtains approval before Writer work.
- For a context-dependent reader-impact assessment, a host-validated
  `ReaderContextInputV1` projection from
  `../quality/schemas/reader-context.schema.json` and the exact
  `reader-impact-baseline.md` bytes selected by the quality-pack lock. The
  model-facing projection omits `impact_basis`; the host validates the
  completed `ReaderContextV1` and its evidence references before hashing or
  persistence.
- For a workflow that requests governed HTML artifacts, a selected document
  type and format under `../quality/formats/html/` and a local stylesheet from
  the approved profile or displayed run configuration.

Do not invent missing product decisions. Record unresolved high-impact questions in the Writer result and stop when the brief is insufficient for safe generation.

## Workflow

1. Run the `plan-documentation` step to resolve scope and conditional source intake. If the approved workflow requires an SRD and the developer did not supply one, draft it from approved evidence and a minimal interview. Do not treat it as approved until the developer accepts it.
2. When the approved plan requires an SRD, put the approved supplied or
   generated SRD first in the brief's source-priority order.
3. When the selected workflow requests governed HTML artifacts, run the
   `write-documentation` step in create or update mode to produce an HTML draft
   and Writer metadata. Markdown workflows keep the target-repository Markdown
   ABI.
4. Run `lint-documentation`, `verify-technical-accuracy`, and
   `review-documentation` as separate runtime steps that return distinct
   evidence-backed findings without silently rewriting the draft. When the
   selected workflow schedules a Pin A inventory step before write or
   comparison, that step uses `verify-technical-accuracy` in inventory-only
   mode. It is not a ninth catalog skill. The host-sealed ledger remains
   untrusted evidence.
5. If the review contains actionable issues, run `write-documentation` once
   more in revision mode.
6. Run the checks required by the selected profile.
7. Run `evaluate-document-quality` to produce the layered evaluation, apply
   the selected rubric and hard gates, and bind both results into a validated
   human-readable report.
8. Return a review-ready result package. Escalate failed gates or unresolved critical questions to a human.

## Role boundaries

- **Writer:** create and revise the document; report sources, assumptions, and unresolved questions.
- **Technical Verifier:** verify claims and examples against exact evidence or
  observed behavior; do not rewrite.
- **Peer Reviewer:** identify editorial, structural, and usability defects with
  evidence and required corrections; do not rewrite.
- **Quality Evaluator:** score the final artifact and apply gates; do not edit.

## Repository-native writing and audit

`audit-documentation` reviews target-repository documentation without editing.
`write-documentation` creates and edits documentation, including focused polish,
in the repository's existing format. A direct, explicitly authorized correction
uses the requested target and change as its brief; it does not require the
workflow planning or HTML artifact inputs above. Workflow invocations retain
their supplied plan bindings and evidence requirements.

Governed HTML artifacts are required only when the selected workflow requests
them. Do not convert a Markdown edit into an HTML/SRD authoring job.

## Focused reader-impact assessment

A focused read-only Markdown assessment uses the validated reader-context input,
the locked reader-impact baseline, and admitted evidence. It does not require an
SRD, selected HTML format, `document.html`, `base.css`, or writer metadata. It
returns only `update-candidate`, `no-change-candidate`, or
`insufficient-evidence`. A candidate does not write the target repository,
publish content, establish a quality pass, or grant a later writer authority.

Existing briefs and direct writing or audit requests do not gain mandatory reader
context. Do not infer or backfill context for a historical record. Existing
mutation grants remain scoped to their selected workflow.

## Required artifacts for governed HTML workflows

- `document.html`
- `base.css`, copied beside the HTML output
- `writer-metadata.json`
- `review.json`
- `validation.json`
- `evaluation.json`
- `quality-score.json`
- `quality-report.md`
- `run-manifest.json`
- `change.diff` when the task modifies an existing repository
- `srd.md` when the approved plan required an SRD and the developer did not
  supply one

Validate structured artifacts against the schemas in `../quality/schemas/`.
Run the layered semantic validator and
`../quality/checks/validate_quality_score.py`, then run the evaluator's report
binding validator before presenting results. Do not weaken gates or silently
discard validation failures. If the target has no safely selectable rubric,
omit `quality-score.json`, mark its locator and score unavailable in
`quality-report.md`, and return `insufficient-evidence`.
