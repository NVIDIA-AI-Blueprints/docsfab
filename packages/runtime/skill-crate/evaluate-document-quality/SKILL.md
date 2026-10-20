---
name: evaluate-document-quality
description: Orchestrate evidence-backed documentation quality evaluation across trustworthy information, transferable understanding, effective experience, and applicable cross-layer constraints. Use after authoring and independent review, or for a documentation-set audit, to preserve a dimension vector and decide pass, conditional pass, fail, human review, or insufficient evidence without editing the content.
license: Apache-2.0 AND CC-BY-4.0
---

# Evaluate Document Quality

Evaluate an artifact or documentation set against the layered quality model.
Preserve evidence, confidence, human and agent outcomes, and hard failures by
dimension. Do not edit the documentation.

## Required Inputs

- Versioned documentation target and delivery surface.
- Product reference model and approved evidence.
- Declared product version, environment, audiences, intended outcomes and
  outcome classes, risk boundary and risk classes, and evidence for the
  documentation-family classification.
- Applicable documentation-quality profile and, for a rubric-eligible target,
  one unambiguous versioned content-type rubric under
  `../../quality/rubrics/`.
- Independent review, deterministic validation, and available outcome or
  longitudinal evidence.
- When present, the host-validated `ReaderContextV1`, its admitted evidence
  references, and the exact locked reader-impact baseline. Historical briefs
  remain valid without inferred or backfilled context.

## Outputs

For a rubric-eligible target, return all three artifacts and their locators:

- `evaluation.json`, containing the layered quality vector;
- `quality-score.json`, containing the selected rubric score; and
- `quality-report.md`, containing the human-readable evaluation report.

If no rubric can be selected safely, still return `evaluation.json` and
`quality-report.md`, and mark the score and `quality-score.json` locator
unavailable. Apply the decision from
[references/layered-evaluation.md](references/layered-evaluation.md) and
validate the summary against
[`quality-report.schema.json`](../../quality/schemas/quality-report.schema.json)
rather than inferring it from rubric status. Never guess a rubric or substitute
task-guide weights.

For a CLI reference, require a rubric that covers its command, option, argument,
and exit-status contract. An API-reference rubric that requires endpoints,
authentication, and HTTP responses does not cover that contract. When no
matching rubric is staged, return the layered evaluation and report with a
null score. Name the unavailable CLI-reference rubric as a limitation, and
do not claim that the missing score passed.

When the host supplies a response contract in the step prompt, that contract
decides the outer response shape and overrides the artifact list above. For
example, the update workflow's independent editorial assessment requires
`{summary, editorialAssessmentProposal}`. The review workflow's quality
evaluator contract states its own answer shape. When the host supplies a
response contract, return only the shape it states. For the quality
evaluator, the host runs the schema, profile, score, and report validators
after inference. Steps 8-10 then state the checks the artifacts must pass, not
commands to run, and the host writes the report's validated result summary.

## Workflow

1. Freeze the target, revisions, model, profile, audiences, environment, and
   evaluation version.
2. Read [references/layered-evaluation.md](references/layered-evaluation.md).
3. Collect deterministic structural signals with
   `../../quality/checks/collect_doc_quality_signals.py` when Markdown source
   is available. Treat the report as risk evidence, not a quality verdict.
4. Assemble the three layers from independently identifiable evidence:
   - trustworthy information from `verify-technical-accuracy` and deterministic
     signals;
   - transferable understanding from `review-documentation` and direct
     `test-audience-understanding` evidence; and
   - effective experience from audience journeys, source delivery checks, and
     the experience-methods reference.
5. Evaluate accessibility and inclusion, global readiness when applicable,
   safety/security/privacy, legal/policy/support compliance, and human-agent
   representation parity as cross-layer constraints.
6. Reconcile findings from dimensions to layers to the overall result without
   averaging away a hard failure. Account for every
   critical or major originating finding from technical and editorial review:
   retain it as an evaluation finding, consolidate it while naming every
   originating ID and evidence locator, or give an explicit evidence-backed
   `verified` or `dismissed-with-rationale` disposition using the existing
   schema fields. A changed evaluator ID does not erase the originating IDs.
   For the admitted technical inventory, preserve each material originating
   fact ID, its linked technical issue IDs, and source locators. Do not collapse
   dimension-specific facts into a generic API-coverage finding. Ensure a
   cited source range includes the implementation lines that establish the
   retained behavior, rather than stopping at its declaration or signature.
   A hard-gate failure in any layer requires
   that layer to fail; any failing layer requires the overall result to fail.
   Preserve dimensions not assessed and explain why evidence is missing, even
   when a known failure determines the decision. Give each dimension an
   evidence-based confidence judgment; the host derives layer and overall
   confidence and decisions from those judgments, including
   `not-assessed` required dimensions. Do not calculate those derived values.
   For an open layer with a residual that changes its rule-derived decision,
   use exactly `fail` or `human-review`. Follow the
   profile-application and outcome-record rules in the layered-evaluation
   reference: never mark a required dimension `not-applicable`, and never
   record a placeholder outcome attempt.
   Treat `update-candidate` and `no-change-candidate` as editorial candidates,
   never as a quality pass. An unknown comparison, invalid context, or missing
   material source yields `insufficient-evidence` for the affected assessment
   when no established failure already determines its decision.
7. Write the layered result to `evaluation.json` in conformance with
   `../../quality/schemas/documentation-quality-evaluation.schema.json`.
8. Validate `evaluation.json` against that schema and run
   `../../quality/checks/validate_documentation_quality_evaluation.py` with
   the selected profile. Do not report a result from an artifact that fails
   shape or semantic validation.
9. For a rubric-eligible target, read
   [references/scoring-policy.md](references/scoring-policy.md), select the
   exact content-type YAML rubric, score every declared dimension from
   evidence, and write `quality-score.json`. Run
   `../../quality/checks/validate_quality_score.py` before using the score. If
   rubric selection is missing or ambiguous, follow the unavailable-score path
   in Outputs instead.
10. Render `quality-report.md` from
    [assets/quality-report-template.md](assets/quality-report-template.md).
    Copy result fields from the validated JSON rather than recalculating them.
    Preserve each explicit Limitation row; the host accounts for the full
    collection and adds structured retained-gap evidence only from its locked
    profile artifact. Never assign retained reason codes from report prose,
    dimension status, rubric availability, or profile names. When the host
    runs the validators after inference, omit the template's Validated result
    summary section, including its JSON block; the host writes that section
    after validation. Otherwise, write that section in the v0.2 summary shape,
    validate it against
    [`quality-report.schema.json`](../../quality/schemas/quality-report.schema.json),
    and run `scripts/validate_quality_report.py` with the selected profile,
    `evaluation.json`, `quality-report.md`, and `quality-score.json` when
    available. Do not claim a result until this cross-artifact check passes.
11. When the host offers `validate_quality_candidate`, pass it your exact
    current draft response, in the shape the host's response contract states,
    before returning it. Use only the tool's safe technical-trace feedback to
    correct that draft within the current evaluation session and its existing
    limits. A valid result applies only to the submitted candidate digest. It
    establishes content preflight and technical trace, not schema or profile
    validity, semantic truth, overall document quality, or permission. Return
    the complete final response even after a valid tool result: the host
    independently decodes and validates the actual final response and can
    still reject it. When the host does not offer this tool, continue the
    existing evaluation method; do not request the tool or infer that it ran.
    The tool is not available in CREATE or UPDATE workflows.
12. When process records are in scope, read
    [references/assurance-system-measures.md](references/assurance-system-measures.md)
    and report those observations separately from document quality.
13. Before retaining a style allegation about repeated `1.` list markers,
    require an applicable rule ID and configuration locator or observed
    rendered ordering failure. Automatic numbering alone is not a defect. If
    neither evidence form exists, keep the allegation as an unverified question
    and exclude it from the defect set.

## Decision Authority

Use the precedence and evidence rules in
[references/layered-evaluation.md](references/layered-evaluation.md). The
machine-checkable summary contract, including the interaction between hard
gates and rubric availability, is
[`quality-report.schema.json`](../../quality/schemas/quality-report.schema.json).
The rubric score remains a separate evidence view and does not replace the
layered decision.

## Evaluation Boundaries

- Use Green, Yellow, and Red only as interpretation bands for a valid 0-100
  rubric total. A color band never overrides the selected rubric threshold,
  missing evidence, a hard gate, or the layered decision.
- Report Correctness, Clarity, Consistency, Terminology, Tone of Voice,
  Inclusive Language, Scannability, Flesch Reading Ease, Informality Index,
  and Liveliness Index only when each result has a documented method, inputs,
  and evidence locator. Otherwise mark that diagnostic unavailable.
- Require a non-author evaluator for a release-gating result. If the author is
  an agent, use a clean subagent; if the author is human, use another human or
  clean agent.
- Keep the `docsfab-documentation-quality` profile experimental and honor its
  `release_gate_eligible: false` policy. Reader-impact evidence does not change
  its threshold, release eligibility, or decision authority.
- Do not modify, patch, publish, commit, push, or merge the document.
- Do not infer source-behavior coverage from exported-symbol counts, document
  length, total score, or the absence of contradictory claims.
- A complete six-dimension inventory is bounded evidence, not proof that every
  material source fact was discovered. Preserve its completeness limitation
  and independently compare the frozen source when stronger confidence is
  required.
